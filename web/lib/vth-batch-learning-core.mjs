const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|webp)$/i;

export function isSupportedBatchImage(file) {
  return (
    IMAGE_MIME_TYPES.has(String(file?.type || "").toLowerCase()) ||
    IMAGE_FILE_PATTERN.test(String(file?.name || ""))
  );
}

export function prepareBatchTrainingFiles(
  files,
  {
    maximumFiles = Number.POSITIVE_INFINITY,
    maximumBytes = 12 * 1024 * 1024,
  } = {},
) {
  const accepted = [];
  let unsupported = 0;
  let oversized = 0;
  let overLimit = 0;
  for (const file of Array.from(files ?? [])) {
    if (!isSupportedBatchImage(file)) {
      unsupported += 1;
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maximumBytes) {
      oversized += 1;
      continue;
    }
    if (accepted.length >= maximumFiles) {
      overLimit += 1;
      continue;
    }
    accepted.push(file);
  }
  return {
    accepted,
    total: Array.from(files ?? []).length,
    skipped: unsupported + oversized + overLimit,
    unsupported,
    oversized,
    overLimit,
  };
}

export function buildBatchTrainingLabel(
  baseLabel,
  index,
  total,
  standalone,
) {
  const fallback = standalone ? "내 VTH 일괄 분포" : "공용 VTH 일괄 분포";
  const base = String(baseLabel || "").trim() || fallback;
  const digits = Math.max(2, String(Math.max(1, total)).length);
  return `${base} ${String(index + 1).padStart(digits, "0")}`;
}

export async function runSequentialBatchTraining(
  files,
  processFile,
  onProgress = () => {},
) {
  const successes = [];
  const failures = [];
  const selection = Array.from(files ?? []);
  for (let index = 0; index < selection.length; index += 1) {
    onProgress({
      completed: index,
      total: selection.length,
      current: index + 1,
    });
    try {
      successes.push(await processFile(selection[index], index, selection.length));
    } catch (error) {
      failures.push({
        index,
        message:
          error instanceof Error
            ? error.message
            : "이미지를 분석하거나 저장하지 못했습니다.",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  onProgress({
    completed: selection.length,
    total: selection.length,
    current: selection.length,
  });
  return { successes, failures };
}
