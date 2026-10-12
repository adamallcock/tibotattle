import { ApiError } from "./errors";

/**
 * PostgreSQL mirror of the D1 v1.2 storage refusal
 * (telemetry-v12-repository.ts telemetryV12StorageConstraintRefusal).
 *
 * The reviewed contract has already admitted the input, so a constraint
 * failure that no reviewed rule maps to a conflict is a server-side schema
 * gap: the same request fails the same way until the schema changes. It is
 * neither a storage outage nor the client's fault, so it is answered as a
 * paced 503 instead of an unpaced unavailable answer the client retries on its
 * own backoff while the refusal repeats.
 */

/** A deterministic storage refusal is retried no sooner than this. It stays
 * below the desktop scheduler's four-hour pass interval, and a retryable answer
 * never pauses the install. Must equal D1's STORAGE_CONSTRAINT_RETRY_AFTER_SECONDS. */
export const TELEMETRY_V12_STORAGE_CONSTRAINT_RETRY_AFTER_SECONDS = "3600";

// SQLSTATE 23514 raised by a reviewed trigger, never by a table CHECK: the
// ready-integrity guard (primary 0028) and the typed admission and
// immutability triggers (primary 0025). A table CHECK violation carries the
// provider's own message, which never equals one of these.
const REVIEWED_TRIGGER_REFUSALS: ReadonlySet<string> = new Set([
  "telemetry_manifest_ready_incomplete",
  "telemetry_manifest_ready_mixed_storage",
  "telemetry_v12_typed_record_staging_denied",
  "telemetry_v12_typed_child_stream_conflict",
  "telemetry_v12_typed_row_immutable",
]);

const SQLSTATE = /^[0-9A-Z]{5}$/u;

function driverField(error: object, name: "code" | "table" | "message"): string | null {
  try {
    const value: unknown = Reflect.get(error, name);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function manifestConflict(): ApiError {
  return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
}

/**
 * Classify a failure raised inside a v1.2 staging, predecessor or activation
 * transaction. It reads only the raw driver error's SQLSTATE, table and
 * message, and copies none of them into the answer. Null means the failure is
 * not one this boundary recognises; the caller keeps its sanitized storage
 * error for it.
 */
export function classifyPostgresTelemetryV12StorageError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error === null || typeof error !== "object") return null;
  const code = driverField(error, "code");
  if (code === null || !SQLSTATE.test(code)) return null;
  if (code === "23514" && REVIEWED_TRIGGER_REFUSALS.has(driverField(error, "message") ?? "")) {
    return manifestConflict();
  }
  // D1 parity: 'UNIQUE constraint failed: telemetry_v12' is a manifest conflict.
  if (code === "23505" && (driverField(error, "table") ?? "").startsWith("telemetry_v12_")) {
    return manifestConflict();
  }
  // A concurrent writer, as D1's revision conflict.
  if (code === "40001" || code === "40P01") return manifestConflict();
  if (code.startsWith("23")) {
    return new ApiError(503, "TELEMETRY_STORAGE_CONSTRAINT", {
      responseHeaders: { "retry-after": TELEMETRY_V12_STORAGE_CONSTRAINT_RETRY_AFTER_SECONDS },
    });
  }
  if (code === "57014" || code === "55P03") return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return null;
}

/**
 * The final answer for a v1.2 storage failure: the classified answer, or an
 * unpaced 503 BACKEND_STORAGE_UNAVAILABLE for anything else (commit-uncertain,
 * begin, release, or an already-sanitized storage error). Never a non-ApiError.
 */
export function postgresTelemetryV12StorageFailure(error: unknown): ApiError {
  return classifyPostgresTelemetryV12StorageError(error)
    ?? new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}
