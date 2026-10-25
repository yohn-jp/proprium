const NETWORK_TIMEOUT_MS = 120_000;

export async function fetchBoundedResponse(input, init, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("A non-negative response byte limit is required");
  const response = await fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    if (!/^\d+$/u.test(contentLengthHeader) || Number(contentLengthHeader) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
    }
  }
  if (!response.body) return { response, bytes: new Uint8Array() };

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { response, bytes };
}
