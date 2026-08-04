/**
 * Maximum size accepted when decoding a persisted JSON record. Stored records
 * are already bounded at ingest; keeping the same defensive bound on reads
 * prevents a corrupt or unexpectedly large row from consuming unbounded work.
 */
export const MAX_STORED_RECORD_JSON_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

export type StoredRecord = Record<string, unknown>;

export function parseStoredJson<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > MAX_STORED_RECORD_JSON_BYTES) return null;
  if (encoder.encode(raw).byteLength > MAX_STORED_RECORD_JSON_BYTES) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseStoredRecordJson(raw: unknown): StoredRecord | null {
  const value = parseStoredJson<unknown>(raw);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as StoredRecord
    : null;
}
