/**
 * The v1.2 future-day admission bound (owner decision 2026-10-12,
 * docs/decisions/2026-10-12-v12-future-day-bound.md).
 *
 * A v1.2 day manifest or chunk whose UTC day is later than the server's
 * current UTC day plus TELEMETRY_V12_FUTURE_DAY_TOLERANCE_DAYS is refused.
 * Past days stay unbounded: history backfill is legitimate. The bound reads
 * only the request's day and the server clock, so a refusal names no
 * participant, device, record or content.
 *
 * The refusal is 429 TELEMETRY_DAY_NOT_YET_ADMISSIBLE with retry-after: the
 * seconds until the refused day becomes admissible, at most seven days. The
 * released desktop client (origin/main, identical to v0.1.28,
 * src/contribution/telemetry-sync-protocol.js classifyResponse) maps a 429
 * without an admission-limit code to the retryable `service_unavailable`
 * failure and honours retry-after up to seven days; both released schedulers
 * then wait without pausing sharing, and the resumable day journal is kept.
 * Every non-retryable class (other 4xx, the consent and device codes) pauses
 * sharing until the user acts, and the listed 409 codes erase the journal and
 * retry on the backoff ladder without retry-after. Whatever the status, the
 * released client cannot activate past a refused day, because it activates one
 * contiguous day vector; the decision record states that residual cost.
 *
 * Dependency-free: the origin's plain-JavaScript handler imports it directly,
 * and each caller raises its own closed error from the verdict.
 */

/** Days after the server's current UTC day that a v1.2 chunk day may name. */
export const TELEMETRY_V12_FUTURE_DAY_TOLERANCE_DAYS = 1;
/** The retry-after ceiling: the released client and both schedulers cap at seven days. */
export const TELEMETRY_V12_FUTURE_DAY_MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60;
/** The closed refusal; its retry-after header carries the verdict. */
export const TELEMETRY_V12_FUTURE_DAY_REFUSAL = Object.freeze({
  status: 429,
  code: "TELEMETRY_DAY_NOT_YET_ADMISSIBLE",
} as const);

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function dayStartMs(day: string): number {
  if (typeof day !== "string" || !DAY.test(day)) throw new TypeError("telemetry v1.2 day is invalid");
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) {
    throw new TypeError("telemetry v1.2 day is invalid");
  }
  return at;
}

function serverNowMs(nowEpoch: number): number {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || nowEpoch > 8_640_000_000_000_000) {
    throw new TypeError("server time is invalid");
  }
  return nowEpoch;
}

/** The latest UTC day a v1.2 manifest or chunk may name at `nowEpoch`. */
export function telemetryV12LatestAdmissibleDay(nowEpoch: number): string {
  const now = serverNowMs(nowEpoch);
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return new Date(today + TELEMETRY_V12_FUTURE_DAY_TOLERANCE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Null when `day` is admissible at `nowEpoch` (any past day, today or
 * tomorrow); otherwise the retry-after, in whole seconds, until it is: the
 * instant the server's UTC day reaches `day` minus the tolerance, at least 1
 * and at most seven days.
 */
export function telemetryV12FutureDayRetryAfterSeconds(day: string, nowEpoch: number): number | null {
  const dayMs = dayStartMs(day);
  const now = serverNowMs(nowEpoch);
  if (day <= telemetryV12LatestAdmissibleDay(now)) return null;
  const admissibleAt = dayMs - TELEMETRY_V12_FUTURE_DAY_TOLERANCE_DAYS * DAY_MS;
  return Math.min(TELEMETRY_V12_FUTURE_DAY_MAX_RETRY_AFTER_SECONDS,
    Math.max(1, Math.ceil((admissibleAt - now) / 1_000)));
}
