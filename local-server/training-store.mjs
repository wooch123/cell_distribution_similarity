import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_STATE_COUNTS = new Set([2, 4, 8, 16]);
const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
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
  const area = Number(descriptor?.area);
  const fields = [
    "peakLocations",
    "peakWidths",
    "valleyHeights",
    "valleyLocations",
    "valleyDepths",
    "valleyPositionRatios",
    "peakValleyDistances",
    "tailSlopes",
  ];
  const arrays = Object.fromEntries(
    fields.map((field) => [field, numberArray(descriptor?.[field])]),
  );
  if (
    !VALID_STATE_COUNTS.has(stateCount) ||
    !Number.isFinite(area) ||
    Object.values(arrays).some((value) => value === null)
  ) {
    throw new Error("State와 Curve descriptor가 올바르지 않습니다.");
  }
  return {
    stateCount,
    observedStateCount: Number(
      descriptor.observedStateCount ?? stateCount,
    ),
    regularized: Boolean(descriptor.regularized),
    ...arrays,
    area,
  };
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
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.imagesDirectory = path.join(this.dataDirectory, "images");
    this.indexPath = path.join(this.dataDirectory, "training-index.json");
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
    const profile = numberArray(payload?.profile, 256);
    if (!profile) {
      throw new Error("정확히 256개 숫자로 된 profile이 필요합니다.");
    }
    const descriptor = validateDescriptor(payload?.descriptor);
    const image = decodeImageDataUrl(payload?.imageDataUrl);
    const sourceImage = payload?.sourceImageDataUrl
      ? decodeImageDataUrl(payload.sourceImageDataUrl)
      : null;
    const id = safeId(payload?.id);
    return this.#mutate(async () => {
      const imageFile = await this.#writeImage(id, image);
      const sourceImageFile = sourceImage
        ? await this.#writeImage(id, sourceImage, "source")
        : null;
      const learnedAt =
        payload?.metadata?.learnedAt ?? new Date().toISOString();
      const record = {
        id,
        label: String(payload?.label || id).slice(0, 120),
        image: `/api/v1/training-samples/${encodeURIComponent(id)}/image`,
        sourceImage: sourceImageFile
          ? `/api/v1/training-samples/${encodeURIComponent(id)}/source-image`
          : undefined,
        imageFile,
        mimeType: image.mimeType,
        sourceImageFile,
        sourceImageMimeType: sourceImage?.mimeType,
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
        metadata: payload?.metadata ?? {},
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
    if (!MIME_EXTENSIONS.has(mimeType)) {
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
