import sharp from "sharp";

import { analyzeForegroundMasks } from "./vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "./vth-image-core.mjs";

async function foregroundMask(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`이미지 크기를 읽을 수 없습니다: ${imagePath}`);
  }
  const scale = Math.min(1, 1100 / metadata.width, 720 / metadata.height);
  const width = Math.max(80, Math.round(metadata.width * scale));
  const height = Math.max(60, Math.round(metadata.height * scale));
  const { data, info } = await sharp(imagePath)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`RGB 변환에 실패했습니다: ${imagePath}`);
  }

  return {
    ...buildForegroundMasks(data, width, height, 3),
    width,
    height,
  };
}

/**
 * Run the same plot/Curve extraction used by the hosted browser application.
 *
 * @param {string} imagePath
 */
export async function analyzeGraphImageFile(imagePath) {
  const source = await foregroundMask(imagePath);
  return analyzeForegroundMasks(
    source.broadMask,
    source.salientMask,
    source.width,
    source.height,
    source.curveSalientMask,
    source.curveColorMasks,
  );
}
