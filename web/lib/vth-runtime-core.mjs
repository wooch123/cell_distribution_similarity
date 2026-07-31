export function isStandaloneRuntimePayload(payload) {
  return (
    payload?.service === "vth-standalone-runtime" &&
    payload?.mode === "standalone-offline" &&
    payload?.externalNetworkAllowed === false
  );
}

/**
 * Detect the bundled server by its same-origin runtime contract.
 *
 * Hostname-only detection fails when another PC opens the Ubuntu service by
 * LAN IP or private DNS name. The same-origin runtime contract works for
 * arbitrary bind addresses, ports and reverse-proxy hostnames.
 */
export async function detectStandaloneRuntime({
  fetchImpl = globalThis.fetch,
  endpoint = "/api/v1/runtime",
  attempts = 3,
  retryDelayMs = 100,
  delayImpl = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const maximumAttempts = Math.max(1, Math.trunc(attempts) || 1);

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response?.status === 404) return false;
      if (!response?.ok) throw new Error(`runtime probe ${response?.status}`);
      return isStandaloneRuntimePayload(await response.json());
    } catch {
      if (attempt + 1 >= maximumAttempts) return null;
      await delayImpl(retryDelayMs);
    }
  }
  return null;
}
