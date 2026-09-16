const encoder = new TextEncoder();

export async function sha256(value: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  // WebCrypto accepts ordinary ArrayBuffers, not concurrently mutable shared memory.
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError("INVALID_DIGEST_BUFFER");
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const digest = await sha256(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
