function secureRandomUnavailableError() {
  const error = new Error(
    "이 브라우저는 안전한 난수 생성을 지원하지 않습니다. 최신 브라우저를 사용해 주세요.",
  );
  error.code = "secure_random_unavailable";
  return error;
}

/**
 * Create an RFC 4122 UUID v4 without requiring a secure browser context.
 *
 * `Crypto.randomUUID()` is unavailable on plain-HTTP LAN origins in several
 * browsers. `Crypto.getRandomValues()` remains available there, so the
 * fallback keeps cryptographic randomness instead of weakening IDs with
 * Math.random().
 */
export function createRandomUuid(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID.call(cryptoApi);
    } catch {
      // Some embedded WebViews expose the method on an HTTP origin but throw
      // when it is called. Continue to the secure getRandomValues path.
    }
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw secureRandomUnavailableError();
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues.call(cryptoApi, bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
