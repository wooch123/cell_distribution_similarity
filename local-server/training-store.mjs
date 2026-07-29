import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MIN_PHYSICAL_STATE_COUNT = 1;
const MAX_PHYSICAL_STATE_COUNT = 20;
const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
]);
const UPLOAD_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function safeId(value) {
  const normalized = String(value || `user-${randomUUID()}`)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!normalized) throw new Error("유효한 학습 sample ID가 필요합니다.");
  return normalized;
}

function numberArray(value, expectedLength = null) {
  if (!Array.isArray(value)) return null;
  const result = value.map(Number);
  if (
    result.some((item) => !Number.isFinite(item)) ||
    (expectedLength !== null && result.length !== expectedLength)
  ) {
    return null;
  }
  return result;
}

function isValidPhysicalStateCount(value) {
  const stateCount = Number(value);
  return (
    Number.isInteger(stateCount) &&
    stateCount >= MIN_PHYSICAL_STATE_COUNT &&
    stateCount <= MAX_PHYSICAL_STATE_COUNT
  );
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=\s]+)$/.exec(
    String(value || ""),
  );
  if (!match || !MIME_EXTENSIONS.has(match[1])) {
    throw new Error("PNG, JPEG 또는 WEBP data URL이 필요합니다.");
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("학습 이미지는 12MB 이하여야 합니다.");
  }
  return { mimeType: match[1], bytes };
}

function validateDescriptor(descriptor) {
  const stateCount = Number(descriptor?.stateCount);
  const observedStateCount = Number(
    descriptor?.observedStateCount ?? stateCount,
  );
  const area = Number(descriptor?.area);
  const valleyCount = stateCount - 1;
  const arrays = {
    peakLocations: numberArray(
      descriptor?.peakLocations,
      stateCount,
    ),
    peakWidths: numberArray(descriptor?.peakWidths, stateCount),
    valleyHeights: numberArray(
      descriptor?.valleyHeights,
      valleyCount,
    ),
    valleyLocations: numberArray(
      descriptor?.valleyLocations,
      valleyCount,
    ),
    valleyDepths: numberArray(
      descriptor?.valleyDepths,
      valleyCount,
    ),
    valleyPositionRatios: numberArray(
      descriptor?.valleyPositionRatios,
      valleyCount,
    ),
    peakValleyDistances: numberArray(
      descriptor?.peakValleyDistances,
      valleyCount * 2,
    ),
    tailSlopes: numberArray(descriptor?.tailSlopes, 2),
  };
  const normalizedValues = [
    arrays.peakLocations,
    arrays.peakWidths,
    arrays.valleyHeights,
    arrays.valleyLocations,
    arrays.valleyDepths,
    arrays.valleyPositionRatios,
    arrays.peakValleyDistances,
    arrays.tailSlopes,
  ];
  if (
    !isValidPhysicalStateCount(stateCount) ||
    !isValidPhysicalStateCount(observedStateCount) ||
    !Number.isFinite(area) ||
    area < 0 ||
    area > 1.5 ||
    normalizedValues.some(
      (values) =>
        values === null ||
        values.some((value) => value < 0 || value > 1.5),
    ) ||
    arrays.peakLocations.some(
      (location, index, locations) =>
        location > 1 ||
        (index > 0 && location <= locations[index - 1]),
    ) ||
    arrays.peakWidths.some((width) => width <= 0 || width > 1) ||
    arrays.valleyLocations.some(
      (location, index) =>
        location <= arrays.peakLocations[index] ||
        location >= arrays.peakLocations[index + 1],
    ) ||
    arrays.valleyPositionRatios.some(
      (ratio) => ratio <= 0 || ratio >= 1,
    ) ||
    arrays.peakValleyDistances.some(
      (distance) => distance <= 0 || distance > 1,
    ) ||
    arrays.tailSlopes.some((slope) => slope > 1)
  ) {
    throw new Error("State와 Curve descriptor가 올바르지 않습니다.");
  }
  return {
    stateCount,
    observedStateCount,
    regularized: Boolean(descriptor.regularized),
    ...arrays,
    area,
  };
}

function renderStandardizedCurveSvg(profile) {
  const points = profile
    .map((value, index) => {
      const x = 12 + (index / 255) * 488;
      const y = 12 + (1 - Number(value)) * 232;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256">',
      '<rect width="512" height="256" fill="#fff"/>',
      `<polyline points="${points}" fill="none" stroke="#101715" `,
      'stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );
}

function publicRecord(record) {
  const {
    imageFile: _imageFile,
    sourceImageFile: _sourceImageFile,
    ...safe
  } = record;
  return safe;
}

export class TrainingStore {
  constructor(dataDirectory, options = {}) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.imagesDirectory = path.join(this.dataDirectory, "images");
    this.indexPath = path.join(this.dataDirectory, "training-index.json");
    this.validateReadyImage = options.validateReadyImage;
    this.index = {
      schemaVersion: 1,
      updatedAt: new Date(0).toISOString(),
      samples: [],
    };
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.imagesDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (
        parsed?.schemaVersion === 1 &&
        Array.isArray(parsed.samples)
      ) {
        this.index = parsed;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#persist();
    }
    return this;
  }

  stats() {
    const ready = this.index.samples.filter(
      (sample) => sample.status === "ready",
    ).length;
    return {
      total: this.index.samples.length,
      ready,
      pending: this.index.samples.length - ready,
      updatedAt: this.index.updatedAt,
    };
  }

  list({ includePending = false } = {}) {
    return this.index.samples
      .filter((sample) => includePending || sample.status === "ready")
      .map(publicRecord)
      .sort((left, right) =>
        String(right.learnedAt).localeCompare(String(left.learnedAt)),
      );
  }

  get(id) {
    const normalized = safeId(id);
    const record = this.index.samples.find(
      (sample) => sample.id === normalized,
    );
    return record ? publicRecord(record) : null;
  }

  imagePath(id, kind = "standard") {
    const normalized = safeId(id);
    const record = this.index.samples.find(
      (sample) => sample.id === normalized,
    );
    const imageFile =
      kind === "source" ? record?.sourceImageFile : record?.imageFile;
    const mimeType =
      kind === "source" ? record?.sourceImageMimeType : record?.mimeType;
    if (!imageFile) return null;
    return {
      path: path.join(this.imagesDirectory, imageFile),
      mimeType,
    };
  }

  async upsertReady(payload) {
    const submittedProfile = numberArray(payload?.profile, 256);
    if (!submittedProfile) {
      throw new Error("정확히 256개 숫자로 된 profile이 필요합니다.");
    }
    const submittedDescriptor = validateDescriptor(payload?.descriptor);
    // Retain request-shape compatibility, but never persist this
    // caller-controlled standardized preview.
    decodeImageDataUrl(payload?.imageDataUrl);
    if (!payload?.sourceImageDataUrl) {
      throw new Error(
        "즉시 검색 가능한 학습 sample에는 sourceImageDataUrl이 필요합니다.",
      );
    }
    const sourceImage = decodeImageDataUrl(payload.sourceImageDataUrl);
    if (typeof this.validateReadyImage !== "function") {
      throw Object.assign(
        new Error("학습 원본 파형 검증기가 준비되지 않았습니다."),
        {
          status: 503,
          code: "waveform_validator_unavailable",
        },
      );
    }
    const verification = await this.validateReadyImage({
      bytes: sourceImage.bytes,
      mimeType: sourceImage.mimeType,
      profile: submittedProfile,
      stateCount: submittedDescriptor.stateCount,
    });
    const profile = numberArray(
      verification?.authoritativeProfile,
      256,
    );
    if (!profile || !verification?.authoritativeDescriptor) {
      throw Object.assign(
        new Error("학습 원본의 authoritative Curve를 만들지 못했습니다."),
        {
          status: 503,
          code: "waveform_validator_unavailable",
        },
      );
    }
    const descriptor = validateDescriptor(
      verification.authoritativeDescriptor,
    );
    const image = {
      mimeType: "image/svg+xml",
      bytes: renderStandardizedCurveSvg(profile),
    };
    const id = safeId(payload?.id);
    return this.#mutate(async () => {
      const imageFile = await this.#writeImage(id, image);
      const sourceImageFile = await this.#writeImage(
        id,
        sourceImage,
        "source",
      );
      const learnedAt =
        payload?.metadata?.learnedAt ?? new Date().toISOString();
      const record = {
        id,
        label: String(payload?.label || id).slice(0, 120),
        image: `/api/v1/training-samples/${encodeURIComponent(id)}/image`,
        sourceImage: `/api/v1/training-samples/${encodeURIComponent(id)}/source-image`,
        imageFile,
        mimeType: image.mimeType,
        sourceImageFile,
        sourceImageMimeType: sourceImage.mimeType,
        profile,
        stateCount: descriptor.stateCount,
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
        learnedAt,
        storage: "api",
        status: "ready",
        metadata: {
          ...(payload?.metadata ?? {}),
          authoritativeSourceProfile: true,
          profileSimilarity: verification.profileSimilarity,
        },
      };
      await this.#replaceRecord(record);
      return publicRecord(record);
    });
  }

  async ingestPending({
    bytes,
    mimeType,
    id,
    label,
    metadata = {},
  }) {
    if (!UPLOAD_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error("PNG, JPEG 또는 WEBP 이미지가 필요합니다.");
    }
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("학습 이미지는 12MB 이하여야 합니다.");
    }
    const normalized = safeId(id);
    return this.#mutate(async () => {
      const imageFile = await this.#writeImage(normalized, {
        bytes,
        mimeType,
      });
      const record = {
        id: normalized,
        label: String(label || normalized).slice(0, 120),
        image: `/api/v1/training-samples/${encodeURIComponent(normalized)}/image`,
        imageFile,
        mimeType,
        learned: true,
        learnedAt: new Date().toISOString(),
        storage: "api",
        status: "pending",
        metadata,
      };
      await this.#replaceRecord(record);
      return publicRecord(record);
    });
  }

  async delete(id) {
    const normalized = safeId(id);
    return this.#mutate(async () => {
      const index = this.index.samples.findIndex(
        (sample) => sample.id === normalized,
      );
      if (index < 0) return false;
      const [record] = this.index.samples.splice(index, 1);
      if (record.imageFile) {
        await rm(path.join(this.imagesDirectory, record.imageFile), {
          force: true,
        });
      }
      if (record.sourceImageFile) {
        await rm(path.join(this.imagesDirectory, record.sourceImageFile), {
          force: true,
        });
      }
      await this.#persist();
      return true;
    });
  }

  async #writeImage(id, image, kind = "standard") {
    const extension = MIME_EXTENSIONS.get(image.mimeType);
    const imageFile =
      kind === "source" ? `${id}.source${extension}` : `${id}${extension}`;
    await writeFile(
      path.join(this.imagesDirectory, imageFile),
      image.bytes,
    );
    return imageFile;
  }

  async #replaceRecord(record) {
    const existingIndex = this.index.samples.findIndex(
      (sample) => sample.id === record.id,
    );
    if (existingIndex >= 0) {
      const previous = this.index.samples[existingIndex];
      this.index.samples[existingIndex] = record;
      if (previous.imageFile && previous.imageFile !== record.imageFile) {
        await rm(path.join(this.imagesDirectory, previous.imageFile), {
          force: true,
        });
      }
      if (
        previous.sourceImageFile &&
        previous.sourceImageFile !== record.sourceImageFile
      ) {
        await rm(path.join(this.imagesDirectory, previous.sourceImageFile), {
          force: true,
        });
      }
    } else {
      this.index.samples.push(record);
    }
    await this.#persist();
  }

  async #persist() {
    this.index.updatedAt = new Date().toISOString();
    const temporaryPath = `${this.indexPath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(this.index, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.indexPath);
  }

  #mutate(operation) {
    const pending = this.mutationQueue.then(operation, operation);
    this.mutationQueue = pending.catch(() => {});
    return pending;
  }
}

export {
  MAX_IMAGE_BYTES,
  decodeImageDataUrl,
  safeId,
  validateDescriptor,
};
