import { MAX_TELEMETRY_V12_DOMAIN_DAYS } from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";

export const V12_DOMAIN_RECOVERY_METHOD = "v12-owner-domain-recovery-1";
export const V12_DOMAIN_RECOVERY_MAX_DEVICES = 25;
export const V12_DOMAIN_RECOVERY_MAX_DAYS_PER_DEVICE = MAX_TELEMETRY_V12_DOMAIN_DAYS;

export const V12_DOMAIN_RECOVERY_OUTCOMES = Object.freeze([
  "activated",
  "eligible",
  "already_active",
  "authority_unavailable",
  "refused",
] as const);

export type V12DomainRecoveryOutcome = typeof V12_DOMAIN_RECOVERY_OUTCOMES[number];

export interface V12DomainRecoveryRequest {
  readonly dryRun: boolean;
  readonly maxDevices: number;
  /** Opaque, authenticated page cursor. It is never a participant identifier. */
  readonly afterParticipantId: string | null;
}

export interface V12DomainRecoveryResult {
  readonly task: "v12_domain_recovery";
  readonly method: typeof V12_DOMAIN_RECOVERY_METHOD;
  readonly dryRun: boolean;
  readonly examined: number;
  readonly outcomes: Readonly<Record<V12DomainRecoveryOutcome, number>>;
  readonly refusals: Readonly<Partial<Record<V12DomainRecoveryRefusalCode, number>>>;
  readonly daysCovered: number;
  readonly nextAfterParticipantId: string | null;
}

/** Only per-device, content-free activation refusal codes may be counted. */
export const V12_DOMAIN_RECOVERY_REFUSAL_CODES = Object.freeze([
  "CHUNK_ADMISSION_LIMIT_REACHED",
  "CHUNK_DIGEST_MISMATCH",
  "CHUNK_INVALID",
  "LIFECYCLE_BOUNDS_EXCEEDED",
  "SYNC_RANGE_TOO_LARGE",
  "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE",
  "TELEMETRY_CONSENT_INVALID",
  "TELEMETRY_MANIFEST_CONFLICT",
  "TELEMETRY_MANIFEST_INCOMPLETE",
  "TELEMETRY_MANIFEST_INVALID",
  "TELEMETRY_OCCURRENCE_CONFLICT",
  "TELEMETRY_REQUIRED",
  "TELEMETRY_STORAGE_CONSTRAINT",
  "TELEMETRY_TRANSPORT_BLOCKED",
  "UPLOAD_IN_PROGRESS",
  "UPLOAD_REGISTRATION_DISABLED",
] as const);

export type V12DomainRecoveryRefusalCode = typeof V12_DOMAIN_RECOVERY_REFUSAL_CODES[number];

// The cursor is an encrypted, versioned owner-pagination envelope. The IV is
// 12 bytes (16 unpadded base64url characters); the shortest AES-GCM payload is
// its 16-byte authentication tag (22 unpadded base64url characters).
const V12_RECOVERY_CURSOR = /^v12r1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,233}$/u;
const REFUSAL_CODE_SET = new Set<string>(V12_DOMAIN_RECOVERY_REFUSAL_CODES);
const REQUEST_KEYS = "action\0v12DomainRecovery";
const RESULT_KEYS = [
  "daysCovered",
  "dryRun",
  "examined",
  "method",
  "nextAfterParticipantId",
  "outcomes",
  "refusals",
  "task",
].join("\0");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join("\0") === expected;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sumSafeCounts(values: Iterable<unknown>): number | null {
  let total = 0;
  for (const value of values) {
    if (!safeCount(value)) return null;
    const next = total + value;
    if (!Number.isSafeInteger(next)) return null;
    total = next;
  }
  return total;
}

function invalidRequest(): never {
  throw new ApiError(400, "BODY_INVALID");
}

/** Parse the one supported owner action body. Unknown fields fail closed. */
export function parseV12DomainRecoveryRequest(value: unknown): V12DomainRecoveryRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)
      || Reflect.get(value, "action") !== "run_maintenance") {
    return invalidRequest();
  }
  const target: unknown = Reflect.get(value, "v12DomainRecovery");
  if (!isRecord(target)
      || Object.keys(target).some((key) => !["dryRun", "maxDevices", "afterParticipantId"].includes(key))) {
    return invalidRequest();
  }
  const dryRun = Reflect.get(target, "dryRun");
  const suppliedMaxDevices = Reflect.get(target, "maxDevices");
  const maxDevices = suppliedMaxDevices === undefined ? 10 : suppliedMaxDevices;
  const after = Reflect.get(target, "afterParticipantId") ?? null;
  if (typeof dryRun !== "boolean"
      || !Number.isSafeInteger(maxDevices)
      || (maxDevices as number) < 1
      || (maxDevices as number) > V12_DOMAIN_RECOVERY_MAX_DEVICES
      || (after !== null && (typeof after !== "string" || after.length > 256 || !V12_RECOVERY_CURSOR.test(after)))) {
    return invalidRequest();
  }
  return Object.freeze({
    dryRun,
    maxDevices: maxDevices as number,
    afterParticipantId: after as string | null,
  });
}

/**
 * Validate the closed, identifier-free task result before it reaches the
 * owner response. Pagination values are authenticated opaque cursors, never
 * raw participant IDs or domain tokens.
 */
export function parseV12DomainRecoveryResult(
  value: unknown,
  request?: Pick<V12DomainRecoveryRequest, "dryRun" | "maxDevices">,
): V12DomainRecoveryResult {
  if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)
      || value.task !== "v12_domain_recovery"
      || value.method !== V12_DOMAIN_RECOVERY_METHOD
      || typeof value.dryRun !== "boolean"
      || !safeCount(value.examined)
      || value.examined > (request?.maxDevices ?? V12_DOMAIN_RECOVERY_MAX_DEVICES)
      || !safeCount(value.daysCovered)
      || (value.nextAfterParticipantId !== null
        && (typeof value.nextAfterParticipantId !== "string"
          || value.nextAfterParticipantId.length > 256
          || !V12_RECOVERY_CURSOR.test(value.nextAfterParticipantId)))) {
    throw new TypeError("invalid v12 domain recovery result");
  }
  if ((request !== undefined && value.dryRun !== request.dryRun)
      || value.daysCovered > value.examined * V12_DOMAIN_RECOVERY_MAX_DAYS_PER_DEVICE) {
    throw new TypeError("invalid v12 domain recovery result");
  }

  if (!isRecord(value.outcomes) || Object.keys(value.outcomes).sort().join("\0")
      !== [...V12_DOMAIN_RECOVERY_OUTCOMES].sort().join("\0")) {
    throw new TypeError("invalid v12 domain recovery result");
  }
  const outcomes = Object.fromEntries(V12_DOMAIN_RECOVERY_OUTCOMES.map((outcome) => {
    const count = Reflect.get(value.outcomes as object, outcome);
    if (!safeCount(count)) throw new TypeError("invalid v12 domain recovery result");
    return [outcome, count];
  })) as Record<V12DomainRecoveryOutcome, number>;
  const outcomeTotal = sumSafeCounts(Object.values(outcomes));
  if (outcomeTotal === null || outcomeTotal !== value.examined
      || (value.dryRun && outcomes.activated !== 0)
      || (!value.dryRun && outcomes.eligible !== 0)) {
    throw new TypeError("invalid v12 domain recovery result");
  }

  if (!isRecord(value.refusals)
      || Object.entries(value.refusals).some(([code, count]) => !REFUSAL_CODE_SET.has(code) || !safeCount(count))) {
    throw new TypeError("invalid v12 domain recovery result");
  }
  const refusalTotal = sumSafeCounts(Object.values(value.refusals));
  if (refusalTotal === null || refusalTotal !== outcomes.refused) {
    throw new TypeError("invalid v12 domain recovery result");
  }

  return Object.freeze({
    task: "v12_domain_recovery",
    method: V12_DOMAIN_RECOVERY_METHOD,
    dryRun: value.dryRun,
    examined: value.examined,
    outcomes: Object.freeze(outcomes),
    refusals: Object.freeze({ ...value.refusals }) as Readonly<Partial<Record<V12DomainRecoveryRefusalCode, number>>>,
    daysCovered: value.daysCovered,
    nextAfterParticipantId: value.nextAfterParticipantId,
  });
}
