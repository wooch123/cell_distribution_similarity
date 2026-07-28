import {
  canonicalShapeFingerprintInput,
  decodeSharedCandidateCursor,
  encodeSharedCandidateCursor,
  MAX_SHARED_CANDIDATE_PAGE_SIZE,
  MAX_SHARED_CANDIDATES,
  MAX_SHARED_CANDIDATES_PER_DAY,
  renderStandardizedCurveSvg,
  validateSharedTrainingPayload,
} from "../lib/vth-shared-training-core.mjs";

type SharedTrainingCandidate = {
  id: string;
  label: string;
  image: string;
  sourceImage?: string;
  profile: number[];
  stateCount: number;
  family: "learned";
  peakLocations: number[];
  peakWidths: number[];
  valleyHeights: number[];
  valleyLocations: number[];
  valleyDepths: number[];
  valleyPositionRatios: number[];
  peakValleyDistances: number[];
  tailSlopes: number[];
  area: number;
  learned: true;
  learnedAt: string;
  storage: "shared";
};

type SharedCandidateRow = {
  id: string;
  label: string;
  image_key: string;
  source_image_key: string | null;
  source_image_mime: string | null;
  profile_json: string;
  descriptor_json: string;
  state_count: number;
  created_at: string;
  status: string;
};

type SharedCandidateStorageRow = {
  image_key: string;
  source_image_key: string | null;
};

async function getBindings() {
  const { env } = await import("cloudflare:workers");
  const bindings = env as typeof env & {
    DB?: D1Database;
    VTH_SHARED_IMAGES?: R2Bucket;
  };
  if (!bindings.DB || !bindings.VTH_SHARED_IMAGES) {
    throw new Error("공용 학습 저장소가 준비되지 않았습니다.");
  }
  return {
    db: bindings.DB,
    images: bindings.VTH_SHARED_IMAGES,
  };
}

async function sha256(value: string | Uint8Array) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function toCandidate(row: SharedCandidateRow, origin: string) {
  const descriptor = JSON.parse(row.descriptor_json) as Record<string, unknown>;
  return {
    id: row.id,
    label: row.label,
    image: new URL(
      `/api/v1/shared-training-samples/${encodeURIComponent(row.id)}/image`,
      origin,
    ).href,
    sourceImage: row.source_image_key
      ? new URL(
          `/api/v1/shared-training-samples/${encodeURIComponent(row.id)}/source-image`,
          origin,
        ).href
      : undefined,
    profile: JSON.parse(row.profile_json),
    stateCount: row.state_count,
    family: "learned",
    peakLocations: descriptor.peakLocations,
    peakWidths: descriptor.peakWidths,
    valleyHeights: descriptor.valleyHeights,
    valleyLocations: descriptor.valleyLocations,
    valleyDepths: descriptor.valleyDepths,
    valleyPositionRatios: descriptor.valleyPositionRatios,
    peakValleyDistances: descriptor.peakValleyDistances,
    tailSlopes: descriptor.tailSlopes,
    area: descriptor.area,
    learned: true,
    learnedAt: row.created_at,
    storage: "shared",
  } as SharedTrainingCandidate;
}

export async function sharedTrainingStats() {
  const { db } = await getBindings();
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS active FROM shared_training_samples WHERE status = ?",
    )
    .bind("active")
    .first<{ active: number }>();
  return { active: Number(row?.active ?? 0) };
}

export async function listSharedTrainingCandidates(
  origin: string,
  limit = 500,
  rawCursor = "",
) {
  const { db } = await getBindings();
  const safeLimit = Math.max(
    1,
    Math.min(MAX_SHARED_CANDIDATE_PAGE_SIZE, Math.trunc(limit)),
  );
  const cursor = decodeSharedCandidateCursor(rawCursor);
  const queryLimit = safeLimit + 1;
  const result = cursor
    ? await db
        .prepare(
          `SELECT id, label, image_key, source_image_key, source_image_mime,
                  profile_json, descriptor_json,
                  state_count, created_at, status
             FROM shared_training_samples
            WHERE status = ?
              AND (
                created_at < ?
                OR (created_at = ? AND id < ?)
              )
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .bind(
          "active",
          cursor.createdAt,
          cursor.createdAt,
          cursor.candidateId,
          queryLimit,
        )
        .all<SharedCandidateRow>()
    : await db
        .prepare(
          `SELECT id, label, image_key, source_image_key, source_image_mime,
                  profile_json, descriptor_json,
                  state_count, created_at, status
             FROM shared_training_samples
            WHERE status = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .bind("active", queryLimit)
        .all<SharedCandidateRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const lastRow = pageRows.at(-1);
  return {
    candidates: pageRows.map((row: SharedCandidateRow) =>
      toCandidate(row, origin),
    ),
    nextCursor:
      hasMore && lastRow
        ? encodeSharedCandidateCursor(lastRow.created_at, lastRow.id)
        : null,
  };
}

export async function getSharedCandidateImage(candidateId: string) {
  const { db, images } = await getBindings();
  const row = await db
    .prepare(
      `SELECT image_key
         FROM shared_training_samples
        WHERE id = ? AND status = ?`,
    )
    .bind(candidateId, "active")
    .first<{ image_key: string }>();
  if (!row) return null;
  return images.get(row.image_key);
}

export async function getSharedCandidateSourceImage(candidateId: string) {
  const { db, images } = await getBindings();
  const row = await db
    .prepare(
      `SELECT source_image_key
         FROM shared_training_samples
        WHERE id = ? AND status = ?`,
    )
    .bind(candidateId, "active")
    .first<{ source_image_key: string | null }>();
  if (!row?.source_image_key) return null;
  return images.get(row.source_image_key);
}

export async function createSharedTrainingCandidate(
  payload: unknown,
  origin: string,
  rateLimitKey = "",
  sourceImage?: { bytes: Uint8Array; mimeType: "image/jpeg" },
) {
  const normalized = validateSharedTrainingPayload(payload);
  const { db, images } = await getBindings();
  const [fingerprint, contributorHash, deletionHash] = await Promise.all([
    sha256(
      canonicalShapeFingerprintInput(
        normalized.profile,
        normalized.descriptor.stateCount,
      ),
    ),
    sha256(rateLimitKey || normalized.contributorToken),
    sha256(normalized.deletionToken),
  ]);

  const existing = await db
    .prepare(
      `SELECT id, label, image_key, source_image_key, source_image_mime,
              profile_json, descriptor_json,
              state_count, created_at, status
         FROM shared_training_samples
        WHERE fingerprint = ?
        LIMIT 1`,
    )
    .bind(fingerprint)
    .first<SharedCandidateRow>();
  if (existing?.status === "active") {
    return {
      candidate: toCandidate(existing, origin),
      deduplicated: true,
    };
  }
  if (existing?.status.startsWith("resetting-")) {
    throw new Error(
      "공용 학습 저장소를 초기화하는 중입니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  const [globalCount, dailyCount] = await db.batch([
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM shared_training_samples WHERE status = ?",
      )
      .bind("active"),
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM shared_training_samples
          WHERE contributor_hash = ?
            AND created_at >= datetime('now', '-1 day')`,
      )
      .bind(contributorHash),
  ]);
  if (Number(globalCount.results?.[0]?.count ?? 0) >= MAX_SHARED_CANDIDATES) {
    throw new Error("공용 학습 후보 저장 한도에 도달했습니다.");
  }
  if (
    Number(dailyCount.results?.[0]?.count ?? 0) >=
    MAX_SHARED_CANDIDATES_PER_DAY
  ) {
    throw new Error("하루에 공유할 수 있는 학습 후보 수를 초과했습니다.");
  }

  const id = existing?.id ?? `shared-${crypto.randomUUID()}`;
  const imageKey = `standardized/${id}.svg`;
  const sourceImageKey = sourceImage ? `source/${id}.jpg` : null;
  try {
    await images.put(
      imageKey,
      new TextEncoder().encode(renderStandardizedCurveSvg(normalized.profile)),
      {
        httpMetadata: {
          contentType: "image/svg+xml",
          cacheControl: "public, max-age=86400",
        },
        customMetadata: {
          source: "server-standardized-vth",
          consentVersion: normalized.consentVersion,
        },
      },
    );
    if (sourceImageKey && sourceImage) {
      await images.put(sourceImageKey, sourceImage.bytes, {
        httpMetadata: {
          contentType: sourceImage.mimeType,
          cacheControl: "public, max-age=86400",
        },
        customMetadata: {
          source: "browser-sanitized-vth-preview",
          consentVersion: normalized.consentVersion,
        },
      });
    }
    const profileJson = JSON.stringify(normalized.profile);
    const descriptorJson = JSON.stringify(normalized.descriptor);
    if (existing) {
      await db
        .prepare(
          `UPDATE shared_training_samples
              SET label = ?, image_key = ?, image_mime = ?,
                  source_image_key = ?, source_image_mime = ?,
                  profile_json = ?, descriptor_json = ?, state_count = ?,
                  contributor_hash = ?, deletion_hash = ?, status = ?,
                  consent_version = ?, created_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND fingerprint = ?`,
        )
        .bind(
          normalized.label,
          imageKey,
          "image/svg+xml",
          sourceImageKey,
          sourceImage?.mimeType ?? null,
          profileJson,
          descriptorJson,
          normalized.descriptor.stateCount,
          contributorHash,
          deletionHash,
          "active",
          normalized.consentVersion,
          id,
          fingerprint,
        )
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO shared_training_samples (
            id, fingerprint, label, image_key, image_mime,
            source_image_key, source_image_mime, profile_json,
            descriptor_json, state_count, contributor_hash, deletion_hash,
            status, consent_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          fingerprint,
          normalized.label,
          imageKey,
          "image/svg+xml",
          sourceImageKey,
          sourceImage?.mimeType ?? null,
          profileJson,
          descriptorJson,
          normalized.descriptor.stateCount,
          contributorHash,
          deletionHash,
          "active",
          normalized.consentVersion,
        )
        .run();
    }
  } catch (error) {
    await Promise.all([
      images.delete(imageKey),
      sourceImageKey ? images.delete(sourceImageKey) : Promise.resolve(),
    ]);
    throw error;
  }

  const created = await db
    .prepare(
      `SELECT id, label, image_key, source_image_key, source_image_mime,
              profile_json, descriptor_json,
              state_count, created_at, status
         FROM shared_training_samples
        WHERE id = ?`,
    )
    .bind(id)
    .first<SharedCandidateRow>();
  if (!created) throw new Error("공용 학습 후보 저장 결과를 찾지 못했습니다.");
  return {
    candidate: toCandidate(created, origin),
    deduplicated: false,
  };
}

export async function deleteSharedTrainingCandidate(
  candidateId: string,
  deletionToken: string,
) {
  const { db, images } = await getBindings();
  const deletionHash = await sha256(deletionToken);
  const row = await db
    .prepare(
      `SELECT image_key, source_image_key
         FROM shared_training_samples
        WHERE id = ? AND deletion_hash = ? AND status = ?`,
    )
    .bind(candidateId, deletionHash, "active")
    .first<{ image_key: string; source_image_key: string | null }>();
  if (!row) return false;
  const result = await db
    .prepare(
      `UPDATE shared_training_samples
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND deletion_hash = ? AND status = ?`,
    )
    .bind("deleted", candidateId, deletionHash, "active")
    .run();
  if (!result.success) return false;
  await Promise.all([
    images.delete(row.image_key),
    row.source_image_key
      ? images.delete(row.source_image_key)
      : Promise.resolve(),
  ]);
  return true;
}

export async function resetSharedTrainingCandidates() {
  const { db, images } = await getBindings();
  const resetStatus = `resetting-${crypto.randomUUID()}`;
  const marked = await db
    .prepare(
      `UPDATE shared_training_samples
          SET status = ?, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(resetStatus)
    .run();
  if (!marked.success) {
    throw new Error("공용 학습 데이터 초기화를 시작하지 못했습니다.");
  }

  const result = await db
    .prepare(
      `SELECT image_key, source_image_key
         FROM shared_training_samples
        WHERE status = ?`,
    )
    .bind(resetStatus)
    .all<SharedCandidateStorageRow>();
  const rows = result.results ?? [];
  const standardizedKeys = rows.map((row) => row.image_key);
  const sourceKeys = rows.flatMap((row) =>
    row.source_image_key ? [row.source_image_key] : [],
  );
  const objectKeys = Array.from(
    new Set([...standardizedKeys, ...sourceKeys]),
  );
  for (let offset = 0; offset < objectKeys.length; offset += 1_000) {
    await images.delete(objectKeys.slice(offset, offset + 1_000));
  }

  const deleted = await db
    .prepare("DELETE FROM shared_training_samples WHERE status = ?")
    .bind(resetStatus)
    .run();
  if (!deleted.success) {
    throw new Error("공용 학습 후보 메타데이터를 삭제하지 못했습니다.");
  }
  return {
    candidateRowsDeleted: rows.length,
    standardizedImagesDeleted: standardizedKeys.length,
    sourceImagesDeleted: sourceKeys.length,
    imageObjectsDeleted: objectKeys.length,
  };
}
