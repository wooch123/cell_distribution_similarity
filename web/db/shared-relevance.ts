import {
  MAX_SHARED_RELEVANCE_REPORTS,
  MAX_SHARED_RELEVANCE_REPORTS_PER_DAY,
  validateSharedRelevancePayload,
} from "../lib/vth-shared-relevance-core.mjs";

type SharedRelevanceRow = {
  id: string;
  query_hash: string;
  annotator_hash: string;
  report_json: string;
  judgment_count: number;
  similar_count: number;
  dissimilar_count: number;
  created_at: string;
  updated_at: string;
  status: string;
};

async function getDb() {
  const { env } = await import("cloudflare:workers");
  const bindings = env as typeof env & { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error("공용 relevance 학습 저장소가 준비되지 않았습니다.");
  }
  return bindings.DB;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function publicSummary(row: SharedRelevanceRow) {
  const report = JSON.parse(row.report_json) as {
    query?: { id?: string };
    annotator?: { id?: string };
  };
  return {
    id: row.id,
    queryId: report.query?.id,
    annotatorId: report.annotator?.id,
    judgmentCount: row.judgment_count,
    similarCount: row.similar_count,
    dissimilarCount: row.dissimilar_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storage: "shared",
  };
}

export async function sharedRelevanceStats() {
  const db = await getDb();
  const [totals, consensus] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS reports,
              COALESCE(SUM(judgment_count), 0) AS judgments,
              COUNT(DISTINCT query_hash) AS queries
         FROM shared_relevance_reports
        WHERE status = ?`,
    ).bind("active"),
    db.prepare(
      `SELECT COUNT(*) AS consensus_ready
         FROM (
           SELECT query_hash
             FROM shared_relevance_reports
            WHERE status = ?
            GROUP BY query_hash
           HAVING COUNT(DISTINCT annotator_hash) >= 2
         )`,
    ).bind("active"),
  ]);
  const totalRow = totals.results?.[0] as Record<string, unknown> | undefined;
  const consensusRow = consensus.results?.[0] as
    | Record<string, unknown>
    | undefined;
  return {
    reports: Number(totalRow?.reports ?? 0),
    judgments: Number(totalRow?.judgments ?? 0),
    queries: Number(totalRow?.queries ?? 0),
    consensusReadyQueries: Number(consensusRow?.consensus_ready ?? 0),
  };
}

export async function createSharedRelevanceReport(
  payload: unknown,
  rateLimitKey = "",
) {
  const normalized = validateSharedRelevancePayload(payload);
  const db = await getDb();
  const [queryHash, annotatorHash, shapeFingerprint, contributorHash, deletionHash] =
    await Promise.all([
      sha256(normalized.queryId),
      sha256(normalized.annotatorId),
      sha256(
        `${normalized.report.query.detected_state_count}:${normalized.report.query.profile
          .map((value: number) => value.toFixed(6))
          .join(",")}`,
      ),
      sha256(rateLimitKey || normalized.contributorToken),
      sha256(normalized.deletionToken),
    ]);
  const existing = await db
    .prepare(
      `SELECT id, query_hash, annotator_hash, report_json, judgment_count,
              similar_count, dissimilar_count, created_at, updated_at, status
         FROM shared_relevance_reports
        WHERE query_hash = ? AND annotator_hash = ?
        LIMIT 1`,
    )
    .bind(queryHash, annotatorHash)
    .first<SharedRelevanceRow>();

  if (!existing || existing.status !== "active") {
    const [globalCount, dailyCount] = await db.batch([
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM shared_relevance_reports WHERE status = ?",
        )
        .bind("active"),
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM shared_relevance_reports
            WHERE contributor_hash = ?
              AND created_at >= datetime('now', '-1 day')`,
        )
        .bind(contributorHash),
    ]);
    if (
      Number(globalCount.results?.[0]?.count ?? 0) >=
      MAX_SHARED_RELEVANCE_REPORTS
    ) {
      throw new Error("공용 relevance report 저장 한도에 도달했습니다.");
    }
    if (
      Number(dailyCount.results?.[0]?.count ?? 0) >=
      MAX_SHARED_RELEVANCE_REPORTS_PER_DAY
    ) {
      throw new Error("하루에 공유할 수 있는 relevance report 수를 초과했습니다.");
    }
  }

  const id = existing?.id ?? `relevance-${crypto.randomUUID()}`;
  const report = structuredClone(normalized.report);
  report.query.id = `Q-${queryHash.slice(0, 16)}`;
  report.annotator.id = `A-${annotatorHash.slice(0, 16)}`;
  report.created_at = new Date().toISOString();
  const similarCount = report.judgments.filter(
    (item: Record<string, unknown>) => item.relevance === "similar",
  ).length;
  const dissimilarCount = report.judgments.length - similarCount;
  const reportJson = JSON.stringify(report);

  if (existing) {
    await db
      .prepare(
        `UPDATE shared_relevance_reports
            SET query_shape_fingerprint = ?, report_json = ?,
                judgment_count = ?, similar_count = ?, dissimilar_count = ?,
                contributor_hash = ?, deletion_hash = ?, status = ?,
                consent_version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND query_hash = ? AND annotator_hash = ?`,
      )
      .bind(
        shapeFingerprint,
        reportJson,
        report.judgments.length,
        similarCount,
        dissimilarCount,
        contributorHash,
        deletionHash,
        "active",
        normalized.consentVersion,
        id,
        queryHash,
        annotatorHash,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO shared_relevance_reports (
          id, query_hash, query_shape_fingerprint, annotator_hash, report_json,
          judgment_count, similar_count, dissimilar_count, contributor_hash,
          deletion_hash, status, consent_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        queryHash,
        shapeFingerprint,
        annotatorHash,
        reportJson,
        report.judgments.length,
        similarCount,
        dissimilarCount,
        contributorHash,
        deletionHash,
        "active",
        normalized.consentVersion,
      )
      .run();
  }

  const stored = await db
    .prepare(
      `SELECT id, query_hash, annotator_hash, report_json, judgment_count,
              similar_count, dissimilar_count, created_at, updated_at, status
         FROM shared_relevance_reports
        WHERE id = ?`,
    )
    .bind(id)
    .first<SharedRelevanceRow>();
  if (!stored) {
    throw new Error("공용 relevance report 저장 결과를 찾지 못했습니다.");
  }
  return {
    report: publicSummary(stored),
    updated: Boolean(existing?.status === "active"),
    reactivated: Boolean(existing && existing.status !== "active"),
    previousJudgmentCount:
      existing?.status === "active" ? existing.judgment_count : 0,
  };
}

export async function exportSharedRelevanceReports(limit = 10_000) {
  const db = await getDb();
  const safeLimit = Math.max(
    1,
    Math.min(MAX_SHARED_RELEVANCE_REPORTS, Math.trunc(limit)),
  );
  const result = await db
    .prepare(
      `SELECT report_json
         FROM shared_relevance_reports
        WHERE status = ?
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
    )
    .bind("active", safeLimit)
    .all<{ report_json: string }>();
  return (result.results ?? []).map((row) => JSON.parse(row.report_json));
}

export async function deleteSharedRelevanceReport(
  reportId: string,
  deletionToken: string,
) {
  const db = await getDb();
  const deletionHash = await sha256(deletionToken);
  const result = await db
    .prepare(
      `UPDATE shared_relevance_reports
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND deletion_hash = ? AND status = ?`,
    )
    .bind("deleted", reportId, deletionHash, "active")
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return Boolean(result.success && Number(changes ?? 0) > 0);
}
