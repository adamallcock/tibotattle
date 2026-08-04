import { ApiError } from "./errors";

export const SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS = 60 * 1_000;
export const SIGN_IN_START_ADMISSION_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAXIMUM_PURGE_ROWS = 1_000;

interface SignInStartAdmissionPolicy {
  maximumStartsPerMinute: number;
}

function configuredPositiveInteger(
  env: Env,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Reflect.get(env, name);
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return parsed;
}

function configuredPolicy(env: Env): SignInStartAdmissionPolicy {
  return {
    // This is deliberately a deployment setting rather than an opaque code
    // constant: staging load evidence can tune it without weakening the
    // one-per-provider-account rule or the edge rate-limit layer.
    maximumStartsPerMinute: configuredPositiveInteger(
      env,
      "SIGN_IN_START_MAX_PER_MINUTE",
      1,
      1_200,
    ),
  };
}

function canonicalWindowStart(nowEpoch: number): {
  startedAt: string;
  endsAt: number;
} {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new TypeError("Invalid sign-in admission clock");
  }
  const startedAtEpoch = Math.floor(
    nowEpoch / SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS,
  ) * SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS;
  return {
    startedAt: new Date(startedAtEpoch).toISOString(),
    endsAt: startedAtEpoch + SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS,
  };
}

function retryAfterSeconds(endsAt: number, nowEpoch: number): string {
  return String(Math.max(1, Math.ceil((endsAt - nowEpoch) / 1_000)));
}

/**
 * Validates the coordinated sign-in budget without consuming a slot. Readiness
 * calls this so a missing/malformed production setting fails closed before an
 * operator enables hosted enrollment.
 */
export function assertSignInStartAdmissionConfiguration(env: Env): void {
  configuredPolicy(env);
}

/**
 * Consume one globally coordinated sign-in-start slot. Unlike a Worker Rate
 * Limit binding, this D1 compare-and-increment is authoritative across edge
 * locations. It stores only the minute bucket and aggregate count—never an
 * IP address, provider account, state, proof, or credential.
 */
export async function assertSignInStartAdmission(
  db: D1Database,
  env: Env,
  nowEpoch = Date.now(),
): Promise<void> {
  const policy = configuredPolicy(env);
  const window = canonicalWindowStart(nowEpoch);
  const now = new Date(nowEpoch).toISOString();
  const admitted = await db.prepare(
    `INSERT INTO sign_in_start_admission_windows (
       window_started_at, accepted_count, last_accepted_at
     ) VALUES (?, 1, ?)
     ON CONFLICT(window_started_at) DO UPDATE SET
       accepted_count = sign_in_start_admission_windows.accepted_count + 1,
       last_accepted_at = excluded.last_accepted_at
     WHERE sign_in_start_admission_windows.accepted_count < ?
     RETURNING accepted_count`,
  ).bind(
    window.startedAt,
    now,
    policy.maximumStartsPerMinute,
  ).first<{ accepted_count: number }>();
  if (!Number.isSafeInteger(admitted?.accepted_count)
      || (admitted?.accepted_count ?? 0) < 1
      || (admitted?.accepted_count ?? 0) > policy.maximumStartsPerMinute) {
    throw new ApiError(429, "SIGN_IN_START_LIMIT_REACHED", {
      responseHeaders: {
        "retry-after": retryAfterSeconds(window.endsAt, nowEpoch),
      },
    });
  }
}

export interface SignInStartAdmissionPurge {
  purged: number;
  complete: boolean;
}

/**
 * Keep the D1 admission accounting bounded. Rows are aggregate minute
 * counters, but retaining them indefinitely would still be needless data.
 */
export async function purgeExpiredSignInStartAdmissions(
  db: D1Database,
  nowEpoch = Date.now(),
  maximumRows = MAXIMUM_PURGE_ROWS,
): Promise<SignInStartAdmissionPurge> {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !Number.isSafeInteger(maximumRows)
      || maximumRows < 1 || maximumRows > MAXIMUM_PURGE_ROWS) {
    throw new TypeError("Invalid sign-in admission purge arguments");
  }
  const cutoff = new Date(
    nowEpoch - SIGN_IN_START_ADMISSION_RETENTION_MILLISECONDS,
  ).toISOString();
  const deleted = await db.prepare(
    `DELETE FROM sign_in_start_admission_windows
      WHERE window_started_at IN (
        SELECT window_started_at
          FROM sign_in_start_admission_windows
         WHERE window_started_at < ?
         ORDER BY window_started_at
         LIMIT ?
      )`,
  ).bind(cutoff, maximumRows).run();
  const purged = deleted.meta.changes;
  if (!Number.isSafeInteger(purged) || purged < 0 || purged > maximumRows) {
    throw new Error("Invalid sign-in admission purge result");
  }
  const remaining = purged === maximumRows
    ? await db.prepare(
      `SELECT 1 AS pending
         FROM sign_in_start_admission_windows
        WHERE window_started_at < ?
        LIMIT 1`,
    ).bind(cutoff).first<{ pending: number }>()
    : null;
  return { purged, complete: remaining === null };
}
