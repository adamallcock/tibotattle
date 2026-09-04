import { timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import { parseStrictJson } from "./strict-json";

export const ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION =
  "accountless-enrollment-v0.1";
export const ACCOUNTLESS_ENROLLMENT_POLICY_VERSION = "accountless-opt-out-v1";
export const ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS =
  "accountless-policy-v1";
export const ACCOUNTLESS_ENROLLMENT_SCOPE = "enrollment_only";
export const ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES = 512;

// The lease describes this ledger's enrollment-only state. It is not a device
// credential expiry and does not authorize uploads. A later additive auth
// design must define its own credential lifecycle before this value is reused.
export const ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS =
  30 * 24 * 60 * 60 * 1000;
export const ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET = 1_000;
export const ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING = 10_000;

export type AccountlessEnrollmentMode = "disabled" | "enabled";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWERCASE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REVOCATION_REASON_PATTERN =
  /^(?:user_opt_out|security_reset|operator_containment)$/u;

export interface AccountlessEnrollmentRequest {
  readonly schemaVersion: typeof ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly deviceSecretHash: Uint8Array;
  readonly policyVersion: typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION;
  readonly authorizationBasis: typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS;
}

export interface AccountlessEnrollmentResponse {
  readonly schemaVersion: typeof ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION;
  readonly state: "enrolled" | "existing";
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly policyVersion: typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION;
  readonly authorizationBasis: typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS;
  readonly scope: typeof ACCOUNTLESS_ENROLLMENT_SCOPE;
}

export interface AccountlessEnrollmentResult {
  readonly status: 200 | 201;
  readonly response: AccountlessEnrollmentResponse;
}

export function configuredAccountlessEnrollmentMode(
  env: Env,
): AccountlessEnrollmentMode {
  const configured = Reflect.get(env, "ACCOUNTLESS_ENROLLMENT_MODE");
  if (configured === undefined || configured === "disabled") return "disabled";
  if (configured === "enabled") return "enabled";
  throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
}

interface AccountlessEnrollmentRow {
  device_id: string;
  device_secret_hash: ArrayBuffer;
  installation_principal_id: string;
  schema_version: string;
  policy_version: string;
  authorization_basis: string;
  state: "active" | "revoked";
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

function failBody(): never {
  throw new ApiError(400, "BODY_INVALID");
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failBody();
  }
  return value as Record<string, unknown>;
}

function parseHash(value: unknown): Uint8Array {
  if (typeof value !== "string" || !LOWERCASE_HASH_PATTERN.test(value)) {
    return failBody();
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Parse the closed accountless enrollment body after bounded body reading. */
export function parseAccountlessEnrollmentRequest(
  value: unknown,
): AccountlessEnrollmentRequest {
  const object = asObject(value);
  const expectedKeys = [
    "authorizationBasis",
    "deviceId",
    "deviceSecretHash",
    "policyVersion",
    "schemaVersion",
  ];
  const keys = Object.keys(object).sort();
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    return failBody();
  }
  if (object.schemaVersion !== ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION
      || object.policyVersion !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || object.authorizationBasis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || typeof object.deviceId !== "string"
      || !UUID_V4_PATTERN.test(object.deviceId)) {
    return failBody();
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    deviceId: object.deviceId,
    deviceSecretHash: parseHash(object.deviceSecretHash),
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  });
}

/** Parse bounded, duplicate-key-free JSON for direct helper consumers/tests. */
export function parseAccountlessEnrollmentJson(
  raw: string,
): AccountlessEnrollmentRequest {
  return parseAccountlessEnrollmentRequest(parseStrictJson(raw));
}

function rowHash(row: AccountlessEnrollmentRow): Uint8Array {
  return row.device_secret_hash instanceof Uint8Array
    ? row.device_secret_hash
    : new Uint8Array(row.device_secret_hash);
}

function sameContract(
  row: AccountlessEnrollmentRow,
  request: AccountlessEnrollmentRequest,
): boolean {
  return row.schema_version === request.schemaVersion
    && row.policy_version === request.policyVersion
    && row.authorization_basis === request.authorizationBasis
    && timingSafeEqual(rowHash(row), request.deviceSecretHash);
}

function responseFor(
  row: AccountlessEnrollmentRow,
  state: AccountlessEnrollmentResponse["state"],
): AccountlessEnrollmentResponse {
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    state,
    deviceId: row.device_id,
    expiresAt: row.expires_at,
    policyVersion: row.policy_version as typeof ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis:
      row.authorization_basis as typeof ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    scope: ACCOUNTLESS_ENROLLMENT_SCOPE,
  });
}

async function readEnrollment(
  db: D1Database,
  deviceId: string,
): Promise<AccountlessEnrollmentRow | null> {
  try {
    return await db.prepare(`
      SELECT device_id,
             device_secret_hash,
             installation_principal_id,
             schema_version,
             policy_version,
             authorization_basis,
             state,
             issued_at,
             expires_at,
             revoked_at,
             revocation_reason
        FROM accountless_enrollment_ledger
       WHERE device_id = ?
    `).bind(deviceId).first<AccountlessEnrollmentRow>();
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

function assertSameRequest(
  row: AccountlessEnrollmentRow,
  request: AccountlessEnrollmentRequest,
): void {
  if (!sameContract(row, request)) {
    throw new ApiError(409, "ACCOUNTLESS_ENROLLMENT_CONFLICT");
  }
}

function assertReplayable(
  row: AccountlessEnrollmentRow,
  request: AccountlessEnrollmentRequest,
  nowEpoch: number,
): AccountlessEnrollmentResult {
  assertSameRequest(row, request);
  if (row.state === "revoked") {
    throw new ApiError(401, "ACCOUNTLESS_ENROLLMENT_REVOKED");
  }
  const issuedEpoch = Date.parse(row.issued_at);
  const expiryEpoch = Date.parse(row.expires_at);
  if (!Number.isFinite(issuedEpoch)
      || new Date(issuedEpoch).toISOString() !== row.issued_at
      || !Number.isFinite(expiryEpoch)
      || new Date(expiryEpoch).toISOString() !== row.expires_at
      || expiryEpoch !== issuedEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (expiryEpoch <= nowEpoch) {
    throw new ApiError(410, "ACCOUNTLESS_ENROLLMENT_EXPIRED");
  }
  return {
    status: 200,
    response: responseFor(row, "existing"),
  };
}

function utcDay(nowEpoch: number): string {
  return new Date(nowEpoch).toISOString().slice(0, 10);
}

function validNow(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
}

/**
 * Atomically issue one enrollment-only ledger row. The preflight replay read
 * is intentionally outside the issuance counter: retries and revocation
 * checks do not consume the candidate budget. A raced duplicate insert rolls
 * back the counter in D1, then is resolved by one bounded replay read.
 */
export async function enrollAccountlessDevice(
  db: D1Database,
  request: AccountlessEnrollmentRequest,
  nowEpoch = Date.now(),
): Promise<AccountlessEnrollmentResult> {
  validNow(nowEpoch);
  if (!db || typeof db.prepare !== "function") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const existing = await readEnrollment(db, request.deviceId);
  if (existing !== null) return assertReplayable(existing, request, nowEpoch);

  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(
    nowEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ).toISOString();
  const installationPrincipalId = `accountless:${crypto.randomUUID()}`;
  const day = utcDay(nowEpoch);
  const updateBudget = db.prepare(`
    UPDATE accountless_enrollment_issuance
       SET budget_day = ?,
           daily_issued = CASE WHEN budget_day = ? THEN daily_issued + 1 ELSE 1 END,
           lifetime_issued = lifetime_issued + 1,
           last_issue_token = ?,
           updated_at = ?
     WHERE singleton = 1
       AND lifetime_issued < ?
       AND budget_day <= ?
       AND (budget_day <> ? OR daily_issued < ?)
  `).bind(
    day,
    day,
    installationPrincipalId,
    issuedAt,
    ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
    day,
    day,
    ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
  );
  const insertLedger = db.prepare(`
    INSERT INTO accountless_enrollment_ledger (
      device_id,
      device_secret_hash,
      installation_principal_id,
      schema_version,
      policy_version,
      authorization_basis,
      state,
      issued_at,
      expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?
     WHERE (SELECT last_issue_token
              FROM accountless_enrollment_issuance
             WHERE singleton = 1) = ?
  `).bind(
    request.deviceId,
    request.deviceSecretHash,
    installationPrincipalId,
    request.schemaVersion,
    request.policyVersion,
    request.authorizationBasis,
    issuedAt,
    expiresAt,
    installationPrincipalId,
  );

  try {
    const [budgetResult, insertResult] = await db.batch([
      updateBudget,
      insertLedger,
    ]);
    if (!budgetResult || !insertResult
        || budgetResult.meta.changes !== 1
        || insertResult.meta.changes !== 1) {
      // A concurrent identical request can observe the final budget slot as
      // unavailable after the winner commits. Resolve that one replay before
      // returning the limit response so idempotency does not depend on which
      // caller won the slot.
      const raced = await readEnrollment(db, request.deviceId);
      if (raced !== null) return assertReplayable(raced, request, nowEpoch);
      throw new ApiError(429, "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED", {
        responseHeaders: { "retry-after": "86400" },
      });
    }
    const inserted = await readEnrollment(db, request.deviceId);
    if (inserted === null) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    // Recheck the state after the insert before exposing a success response.
    // A lifecycle revocation may have won between the atomic write and this
    // read; it must never be hidden by the original `enrolled` result.
    const active = assertReplayable(inserted, request, nowEpoch);
    return {
      status: 201,
      response: Object.freeze({ ...active.response, state: "enrolled" }),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A concurrent request may have won the device-id uniqueness race. One
    // read resolves that race; no mint/retry loop is permitted here.
    const raced = await readEnrollment(db, request.deviceId);
    if (raced !== null) return assertReplayable(raced, request, nowEpoch);
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

export type AccountlessRevocationReason =
  | "user_opt_out"
  | "security_reset"
  | "operator_containment";

/** Preserve a revocation tombstone for future lifecycle wiring. */
export async function revokeAccountlessEnrollment(
  db: D1Database,
  deviceId: string,
  reason: AccountlessRevocationReason,
  nowEpoch = Date.now(),
): Promise<boolean> {
  validNow(nowEpoch);
  if (!UUID_V4_PATTERN.test(deviceId) || !REVOCATION_REASON_PATTERN.test(reason)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  try {
    const result = await db.prepare(`
      UPDATE accountless_enrollment_ledger
         SET state = 'revoked',
             revoked_at = ?,
             revocation_reason = ?
       WHERE device_id = ? AND state = 'active'
    `).bind(new Date(nowEpoch).toISOString(), reason, deviceId).run();
    return result.meta.changes === 1;
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}
