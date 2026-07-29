import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return chunk;
}

export function nonDistributionPng() {
  const width = 320;
  const height = 180;
  const stride = 1 + width * 3;
  const scanlines = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * stride] = 0;
  }

  const setBlack = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = y * stride + 1 + x * 3;
    scanlines[offset] = 15;
    scanlines[offset + 1] = 15;
    scanlines[offset + 2] = 15;
  };
  for (let x = 12; x <= 308; x += 20) {
    for (let y = 10; y <= 170; y += 1) {
      setBlack(x, y);
      setBlack(x + 1, y);
    }
  }
  for (let y = 10; y <= 170; y += 20) {
    for (let x = 12; x <= 308; x += 1) {
      setBlack(x, y);
      setBlack(x, y + 1);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
