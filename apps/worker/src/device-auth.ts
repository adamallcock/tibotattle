import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  DEVICE_PAIRING_TTL_MILLISECONDS,
  INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
  INCREMENTAL_TELEMETRY_SCHEMA_VERSION,
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
  ONGOING_TELEMETRY_CONSENT_VERSION,
  ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  TELEMETRY_CONSENT_VERSION,
  UPLOAD_AUTHORIZATION_TTL_MILLISECONDS,
  UPLOAD_CONSUME_LEASE_MILLISECONDS,
} from "./constants";
import {
  encodeBase64Url,
  randomSecret,
  sha256,
  timingSafeEqual,
} from "./crypto";
import { ApiError } from "./errors";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

interface PairingRow {
  id: string;
  participant_id: string;
  secret_hash: ArrayBuffer;
  state: "unused" | "consumed" | "revoked";
  expires_at: string;
  claimed_device_id: string | null;
  participant_state: "active" | "deleting";
  participant_consent_version: string;
  transport_consent_version: string;
}

interface DeviceRow {
  id: string;
  participant_id: string;
  paired_via_pairing_id: string;
  secret_hash: ArrayBuffer;
  state: "active" | "revoked";
  issued_at: string;
  expires_at: string;
  last_used_at: string;
  social_verified_at: string | null;
  credential_generation: number;
  revoked_at: string | null;
  participant_state: "active" | "deleting";
  participant_consent_version: string;
}

interface DeviceRotationRow {
  id: string;
  device_id: string;
  participant_id: string;
  prior_secret_hash: ArrayBuffer;
  replacement_secret_hash: ArrayBuffer;
  attempt_id: string;
  generation: number;
  rotated_at: string;
  retire_at: string;
}

interface DeviceUploadRow {
  id: string;
  participant_id: string;
  secret_hash: ArrayBuffer;
  envelope_digest: string;
  body_bytes: number;
  content_type: "application/json";
  state: "unused" | "consuming" | "consumed" | "revoked";
  expires_at: string;
  device_state: "active" | "revoked";
  device_expires_at: string;
  participant_state: "active" | "deleting";
}

export interface DevicePrincipal {
  deviceId: string;
  participantId: string;
  participantConsentVersion: string;
  expiresAt: string;
  credentialGeneration: number;
  socialVerifiedAt: string;
}

export interface DeviceUploadClaim {
  authorizationId: string;
  participantId: string;
  authorizationKind: "device";
}

export type DeviceTransportConsentVersion =
  | typeof ONGOING_TELEMETRY_CONSENT_VERSION
  | typeof ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
  | typeof ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION;

export interface DevicePairingMaterial {
  id: string;
  participantId: string;
  issuedBySessionId: string;
  secretHash: Uint8Array;
  transportConsentVersion: DeviceTransportConsentVersion;
  pairingCode: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Device lifecycle controls are intentionally supplied as inputs rather than
 * hidden in an upload cadence.  Callers may bind these to environment config;
 * the defaults are conservative launch values and are not identity proof.
 */
export interface DeviceLifecyclePolicy {
  idleMilliseconds: number;
  socialRecheckMaxAgeMilliseconds: number;
  activeDeviceLimit: number;
  pairingIssueWindowMilliseconds: number;
  pairingIssueLimit: number;
  pairingClaimWindowMilliseconds: number;
  pairingClaimLimit: number;
  rotationHistoryMilliseconds: number;
  maintenanceBatchSize: number;
}

export const DEFAULT_DEVICE_LIFECYCLE_POLICY: Readonly<DeviceLifecyclePolicy> = {
  idleMilliseconds: 30 * 24 * 60 * 60 * 1000,
  socialRecheckMaxAgeMilliseconds: 180 * 24 * 60 * 60 * 1000,
  activeDeviceLimit: 3,
  pairingIssueWindowMilliseconds: 60 * 60 * 1000,
  pairingIssueLimit: 3,
  pairingClaimWindowMilliseconds: 60 * 60 * 1000,
  pairingClaimLimit: 6,
  rotationHistoryMilliseconds: 30 * 24 * 60 * 60 * 1000,
  maintenanceBatchSize: 250,
};

export interface DeviceLifecycleOptions {
  nowEpoch?: number;
  policy?: Partial<DeviceLifecyclePolicy>;
}

export interface DeviceCredentialRotationResult {
  deviceId: string;
  state: "active";
  scope: "upload_registration";
  expiresAt: string;
  credentialGeneration: number;
  /** The client may replace its local secret only after this is true. */
  commit: true;
}

export interface DeviceLifecycleMaintenanceResult {
  pairingsRevoked: number;
  devicesRevoked: number;
  uploadsRevoked: number;
  rotationsPurged: number;
  pairingEventsPurged: number;
}

function ongoingConsentForParticipant(
  consentVersion: string,
):
  | typeof ONGOING_TELEMETRY_CONSENT_VERSION
  | typeof ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
  | null {
  if (consentVersion === TELEMETRY_CONSENT_VERSION) {
    return ONGOING_TELEMETRY_CONSENT_VERSION;
  }
  if (consentVersion === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION) {
    return ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  }
  return null;
}

/**
 * The v1.0 incremental-contribution transport consent is only grantable by a
 * fully consented telemetry participant; every other pairing keeps carrying
 * exactly the ongoing consent its participant enrollment maps to.
 */
function transportConsentAllowedForParticipant(
  participantConsentVersion: string,
  transportConsentVersion: string,
): boolean {
  if (transportConsentVersion
      === ongoingConsentForParticipant(participantConsentVersion)) {
    return true;
  }
  return transportConsentVersion
      === ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
    && participantConsentVersion === TELEMETRY_CONSENT_VERSION;
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function lifecyclePolicy(
  overrides: Partial<DeviceLifecyclePolicy> = {},
): DeviceLifecyclePolicy {
  const policy = {
    ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
    ...overrides,
  };
  const boundedPositiveInteger = (value: number): boolean => (
    Number.isSafeInteger(value) && value > 0
  );
  if (!boundedPositiveInteger(policy.idleMilliseconds)
      || !boundedPositiveInteger(policy.socialRecheckMaxAgeMilliseconds)
      || !boundedPositiveInteger(policy.activeDeviceLimit)
      || !boundedPositiveInteger(policy.pairingIssueWindowMilliseconds)
      || !boundedPositiveInteger(policy.pairingIssueLimit)
      || !boundedPositiveInteger(policy.pairingClaimWindowMilliseconds)
      || !boundedPositiveInteger(policy.pairingClaimLimit)
      || !boundedPositiveInteger(policy.rotationHistoryMilliseconds)
      || !boundedPositiveInteger(policy.maintenanceBatchSize)) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return policy;
}

function futureInstant(value: string, nowEpoch = Date.now()): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

function recentInstant(
  value: string | null,
  nowEpoch: number,
  maxAgeMilliseconds: number,
): boolean {
  if (!value) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch <= nowEpoch
    && epoch > nowEpoch - maxAgeMilliseconds;
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ApiError(400, "BODY_INVALID");
  return Uint8Array.from(
    value.match(/.{2}/gu) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function lifecycleAttemptId(value: string): string {
  if (!new RegExp(`^${UUID_V4}$`, "u").test(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return value;
}

function epochIso(epoch: number): string {
  const value = new Date(epoch).toISOString();
  if (!Number.isFinite(Date.parse(value))) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return value;
}

function pairingHash(id: string, secret: string): Promise<Uint8Array> {
  return sha256(`app-usagemonitor/device-pairing/v1\0${id}\0${secret}`);
}

async function deviceHash(id: string, secret: string): Promise<Uint8Array> {
  let decoded: Uint8Array | null = null;
  let input: Uint8Array | null = null;
  try {
    const standard = secret.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32 || encodeBase64Url(decoded) !== secret) {
      throw new ApiError(401, "DEVICE_AUTH_INVALID");
    }
    const prefix = new TextEncoder().encode(
      `app-usagemonitor/device/v1\0${id}\0`,
    );
    input = new Uint8Array(prefix.byteLength + decoded.byteLength);
    input.set(prefix);
    input.set(decoded, prefix.byteLength);
    return await sha256(input);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  } finally {
    decoded?.fill(0);
    input?.fill(0);
  }
}

function deviceUploadHash(id: string, secret: string): Promise<Uint8Array> {
  return sha256(`app-usagemonitor/device-upload/v1\0${id}\0${secret}`);
}

export async function createDevicePairingMaterial(
  participantId: string,
  sessionId: string,
  participantConsentVersion: string,
  nowEpoch = Date.now(),
  requestedTransportConsentVersion?: DeviceTransportConsentVersion,
): Promise<DevicePairingMaterial> {
  const mappedConsentVersion = ongoingConsentForParticipant(
    participantConsentVersion,
  );
  if (!mappedConsentVersion) throw new ApiError(400, "TELEMETRY_REQUIRED");
  const ongoingConsentVersion =
    requestedTransportConsentVersion ?? mappedConsentVersion;
  if (!transportConsentAllowedForParticipant(
    participantConsentVersion,
    ongoingConsentVersion,
  )) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(
    nowEpoch + DEVICE_PAIRING_TTL_MILLISECONDS,
  ).toISOString();
  return {
    id,
    participantId,
    issuedBySessionId: sessionId,
    secretHash: await pairingHash(id, secret),
    transportConsentVersion: ongoingConsentVersion,
    pairingCode: `um_pair_${id}.${secret}`,
    issuedAt,
    expiresAt,
  };
}

export function devicePairingInsert(
  db: D1Database,
  material: DevicePairingMaterial,
  participantConsentVersion: string,
  policyOverrides: Partial<DeviceLifecyclePolicy> = {},
): D1PreparedStatement {
  const policy = lifecyclePolicy(policyOverrides);
  return db.prepare(
    `INSERT INTO device_pairings (
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at
    )
    SELECT ?, participant.id, session.id, ?,
           ?, ?, 'unused', ?, ?
      FROM participants participant
      JOIN web_sessions session ON session.participant_id = participant.id
     WHERE participant.id = ?
       AND participant.state = 'active'
       AND participant.consent_version = ?
       AND session.id = ?
       AND session.state = 'active'
       AND session.scope = 'personal'
       AND session.expires_at > ?
       AND (
         SELECT COUNT(*) FROM device_credentials device
          WHERE device.participant_id = participant.id
            AND device.state = 'active'
            AND device.expires_at > ?
            AND device.last_used_at > ?
       ) < ?
       AND (
         SELECT COUNT(*) FROM device_pairings recent_pairing
          WHERE recent_pairing.participant_id = participant.id
            AND recent_pairing.issued_at > ?
       ) < ?`,
  ).bind(
    material.id,
    material.secretHash,
    // The pinned consent column carries the v1.0 identifier for a v1.0
    // pairing (design doc section 8, item 8); v0.x pairings keep recording
    // the original ongoing consent identifier.
    material.transportConsentVersion
        === ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
      ? ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
      : ONGOING_TELEMETRY_CONSENT_VERSION,
    material.transportConsentVersion,
    material.issuedAt,
    material.expiresAt,
    material.participantId,
    participantConsentVersion,
    material.issuedBySessionId,
    material.issuedAt,
    material.issuedAt,
    new Date(Date.parse(material.issuedAt) - policy.idleMilliseconds).toISOString(),
    policy.activeDeviceLimit,
    new Date(Date.parse(material.issuedAt) - policy.pairingIssueWindowMilliseconds)
      .toISOString(),
    policy.pairingIssueLimit,
  );
}

function parsePairingAuthorization(header: string | null): {
  id: string;
  secret: string;
} {
  if (!header?.startsWith("Pairing ")) {
    throw new ApiError(401, "PAIRING_AUTH_INVALID");
  }
  const match = new RegExp(
    `^um_pair_(${UUID_V4})\\.([A-Za-z0-9_-]{43})$`,
    "u",
  ).exec(header.slice(8));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "PAIRING_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function parseDeviceAuthorization(header: string | null): {
  id: string;
  secret: string;
} {
  if (!header?.startsWith("Device ")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const match = new RegExp(
    `^um_device_(${UUID_V4})\\.([A-Za-z0-9_-]{43})$`,
    "u",
  ).exec(header.slice(7));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function parseDeviceUploadAuthorization(header: string | null): {
  id: string;
  secret: string;
} {
  if (!header?.startsWith("Upload ")) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const match = new RegExp(
    `^um_device_upload_(${UUID_V4})\\.([A-Za-z0-9_-]{43})$`,
    "u",
  ).exec(header.slice(7));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

/**
 * Classify why a pairing mint could not be admitted. The device count and the
 * issuance count are read with exactly the cutoffs `devicePairingInsert` gates
 * on, so a `true` here means the same subquery the insert failed on is still
 * failing. An inactive/absent participant leaves both `false` (the caller then
 * returns the neutral auth failure), matching the pre-existing behaviour.
 */
async function pairingBoundsExceeded(
  db: D1Database,
  participantId: string,
  nowEpoch: number,
  policy: DeviceLifecyclePolicy,
): Promise<{ deviceCapExceeded: boolean; issueRateExceeded: boolean }> {
  const limit = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM device_credentials
         WHERE participant_id = ? AND state = 'active' AND expires_at > ?
           AND last_used_at > ?) AS devices,
       (SELECT COUNT(*) FROM device_pairings
         WHERE participant_id = ? AND issued_at > ?) AS issued,
       (SELECT state FROM participants WHERE id = ?) AS participant_state`,
  ).bind(
    participantId,
    epochIso(nowEpoch),
    new Date(nowEpoch - policy.idleMilliseconds).toISOString(),
    participantId,
    new Date(nowEpoch - policy.pairingIssueWindowMilliseconds).toISOString(),
    participantId,
  ).first<{ devices: number; issued: number; participant_state: string | null }>();
  const participantActive = limit?.participant_state === "active";
  return {
    deviceCapExceeded: participantActive
      && (limit!.devices ?? 0) >= policy.activeDeviceLimit,
    issueRateExceeded: participantActive
      && (limit!.issued ?? 0) >= policy.pairingIssueLimit,
  };
}

/**
 * W1 self-healing re-pair: free exactly one active-device slot for a
 * session-authenticated mint that is only blocked by the active-device cap.
 *
 * The selection is deliberately conservative. It joins the presented session
 * so a mint with no live, personal, unexpired `web_session` for this
 * participant can never trigger a revoke (the auth-context check: a token or
 * other non-session mint finds no target). The chosen credential must still be
 * counted toward the cap (active, unexpired, non-idle — the same predicates
 * `devicePairingInsert` counts on) and must not have been used since before
 * this login (`last_used_at` — or `issued_at` when null — strictly precedes the
 * session's `issued_at`). That is the "superseded by re-pair" signal: a
 * credential a fresh browser login has effectively replaced. The oldest such
 * credential is revoked with the same state transition every other revoke path
 * in this file records (state -> 'revoked', `revoked_at` stamped, its pending
 * upload authorizations revoked). The revoking UPDATE re-checks the
 * session-issued_at bound so a device used concurrently between selection and
 * revocation is never revoked, and the caller retries the mint at most once.
 *
 * @returns whether a credential was revoked (a slot was freed).
 */
async function revokeSupersededDeviceCredential(
  db: D1Database,
  participantId: string,
  sessionId: string,
  nowEpoch: number,
  policy: DeviceLifecyclePolicy,
): Promise<boolean> {
  const now = epochIso(nowEpoch);
  const idleCutoff = new Date(nowEpoch - policy.idleMilliseconds).toISOString();
  const target = await db.prepare(
    `SELECT device.id AS device_id
       FROM device_credentials device
       JOIN web_sessions session
         ON session.id = ?
        AND session.participant_id = device.participant_id
        AND session.scope = 'personal'
        AND session.state = 'active'
        AND session.expires_at > ?
      WHERE device.participant_id = ?
        AND device.state = 'active'
        AND device.expires_at > ?
        AND device.last_used_at > ?
        AND COALESCE(device.last_used_at, device.issued_at) < session.issued_at
      ORDER BY COALESCE(device.last_used_at, device.issued_at) ASC, device.id ASC
      LIMIT 1`,
  ).bind(
    sessionId,
    now,
    participantId,
    now,
    idleCutoff,
  ).first<{ device_id: string }>();
  if (!target) return false;
  const results = await db.batch([
    db.prepare(
      `UPDATE device_credentials
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
          AND participant_id = ?
          AND state = 'active'
          AND COALESCE(last_used_at, issued_at) < (
            SELECT issued_at FROM web_sessions
             WHERE id = ?
               AND participant_id = ?
               AND scope = 'personal'
               AND state = 'active'
          )`,
    ).bind(now, target.device_id, participantId, sessionId, participantId),
    db.prepare(
      `UPDATE device_upload_authorizations
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?),
              consume_lease_expires_at = NULL
        WHERE issued_by_device_id = ?
          AND participant_id = ?
          AND state IN ('unused', 'consuming')
          AND EXISTS (
            SELECT 1 FROM device_credentials
             WHERE id = ? AND participant_id = ? AND state = 'revoked'
          )`,
    ).bind(now, target.device_id, participantId, target.device_id, participantId),
  ]);
  return results[0]?.meta.changes === 1;
}

export async function createDevicePairing(
  db: D1Database,
  participantId: string,
  sessionId: string,
  participantConsentVersion: string,
  nowEpoch = Date.now(),
  policyOverrides: Partial<DeviceLifecyclePolicy> = {},
  requestedTransportConsentVersion?: DeviceTransportConsentVersion,
): Promise<{ pairingCode: string; expiresAt: string }> {
  const policy = lifecyclePolicy(policyOverrides);
  const material = await createDevicePairingMaterial(
    participantId,
    sessionId,
    participantConsentVersion,
    nowEpoch,
    requestedTransportConsentVersion,
  );
  const mint = (): Promise<D1Result<unknown>> => devicePairingInsert(
    db,
    material,
    participantConsentVersion,
    policy,
  ).run();
  const result = await mint();
  if (result.meta.changes !== 1) {
    const bounds = await pairingBoundsExceeded(
      db,
      participantId,
      nowEpoch,
      policy,
    );
    // Only self-heal when the active-device cap is the sole binding
    // constraint: if issuance velocity is also exhausted, revoking a slot
    // cannot admit this mint, so a credential must never be destroyed for it.
    // A single revoke of a superseded credential, then one retry — no loop.
    if (bounds.deviceCapExceeded
        && !bounds.issueRateExceeded
        && await revokeSupersededDeviceCredential(
          db,
          participantId,
          sessionId,
          nowEpoch,
          policy,
        )) {
      const retry = await mint();
      if (retry.meta.changes === 1) {
        return {
          pairingCode: material.pairingCode,
          expiresAt: material.expiresAt,
        };
      }
    }
    if (bounds.deviceCapExceeded || bounds.issueRateExceeded) {
      throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
    }
    throw new ApiError(401, "AUTH_INVALID");
  }
  return {
    pairingCode: material.pairingCode,
    expiresAt: material.expiresAt,
  };
}

async function pairedDeviceForRetry(
  db: D1Database,
  pairingId: string,
  deviceId: string,
  deviceSecretHash: Uint8Array,
): Promise<{
  deviceId: string;
  state: "active";
  scope: "upload_registration";
  expiresAt: string;
} | null> {
  const row = await db.prepare(
    `SELECT device.id, device.secret_hash, device.expires_at
       FROM device_credentials device
       JOIN device_pairings pairing
         ON pairing.id = device.paired_via_pairing_id
      WHERE device.id = ? AND device.paired_via_pairing_id = ?
        AND pairing.state = 'consumed'`,
  ).bind(deviceId, pairingId).first<{
    id: string;
    secret_hash: ArrayBuffer;
    expires_at: string;
  }>();
  if (!row
      || !timingSafeEqual(deviceSecretHash, bytes(row.secret_hash))
      || !futureInstant(row.expires_at)) {
    return null;
  }
  return {
    deviceId: row.id,
    state: "active",
    scope: "upload_registration",
    expiresAt: row.expires_at,
  };
}

export async function claimDevicePairing(
  db: D1Database,
  authorizationHeader: string | null,
  deviceId: string,
  deviceSecretHashHex: string,
  nowEpoch = Date.now(),
  policyOverrides: Partial<DeviceLifecyclePolicy> = {},
): Promise<{
  deviceId: string;
  state: "active";
  scope: "upload_registration";
  expiresAt: string;
}> {
  const policy = lifecyclePolicy(policyOverrides);
  if (!new RegExp(`^${UUID_V4}$`, "u").test(deviceId)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const parsed = parsePairingAuthorization(authorizationHeader);
  const deviceSecretHash = bytesFromHex(deviceSecretHashHex);
  const row = await db.prepare(
    `SELECT pairing.id, pairing.participant_id, pairing.secret_hash,
            pairing.state, pairing.expires_at, pairing.claimed_device_id,
            pairing.transport_consent_version,
            participant.state AS participant_state,
            participant.consent_version AS participant_consent_version
       FROM device_pairings pairing
       JOIN participants participant ON participant.id = pairing.participant_id
      WHERE pairing.id = ?`,
  ).bind(parsed.id).first<PairingRow>();
  const presentedHash = await pairingHash(parsed.id, parsed.secret);
  if (!timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  )
      || !row
      || row.participant_state !== "active"
      || !transportConsentAllowedForParticipant(
        row.participant_consent_version,
        row.transport_consent_version,
      )
      || !futureInstant(row.expires_at, nowEpoch)) {
    throw new ApiError(401, "PAIRING_AUTH_INVALID");
  }
  if (row.state === "consumed" && row.claimed_device_id === deviceId) {
    const replay = await pairedDeviceForRetry(
      db,
      parsed.id,
      deviceId,
      deviceSecretHash,
    );
    if (replay) return replay;
  }
  if (row.state !== "unused") throw new ApiError(401, "PAIRING_AUTH_INVALID");

  const claimWindowStart = new Date(
    nowEpoch - policy.pairingClaimWindowMilliseconds,
  ).toISOString();
  const claimCount = await db.prepare(
    `SELECT COUNT(*) AS total
       FROM device_pairings
      WHERE participant_id = ? AND state = 'consumed' AND consumed_at > ?`,
  ).bind(row.participant_id, claimWindowStart).first<{ total: number }>();
  if ((claimCount?.total ?? 0) >= policy.pairingClaimLimit) {
    throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
  }

  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS).toISOString();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO device_credentials (
          id, participant_id, paired_via_pairing_id, secret_hash, state,
          issued_at, expires_at, last_used_at, social_verified_at
        )
        SELECT ?, pairing.participant_id, pairing.id, ?, 'active', ?, ?, ?
             , ?
          FROM device_pairings pairing
          JOIN participants participant ON participant.id = pairing.participant_id
         WHERE pairing.id = ?
           AND pairing.state = 'unused'
           AND pairing.expires_at > ?
           AND participant.state = 'active'
           AND participant.consent_version = ?
           AND (
             SELECT COUNT(*) FROM device_credentials current_device
              WHERE current_device.participant_id = pairing.participant_id
                AND current_device.state = 'active'
                AND current_device.expires_at > ?
                AND current_device.last_used_at > ?
           ) < ?`,
      ).bind(
        deviceId,
        deviceSecretHash,
        issuedAt,
        expiresAt,
        issuedAt,
        issuedAt,
        parsed.id,
        issuedAt,
        row.participant_consent_version,
        issuedAt,
        new Date(nowEpoch - policy.idleMilliseconds).toISOString(),
        policy.activeDeviceLimit,
      ),
      db.prepare(
        `UPDATE device_pairings
            SET state = 'consumed', consumed_at = ?, claimed_device_id = ?
          WHERE id = ? AND state = 'unused' AND expires_at > ?
            AND EXISTS (
            SELECT 1 FROM device_credentials
               WHERE id = ? AND paired_via_pairing_id = device_pairings.id
            )
           AND (
             SELECT COUNT(*) FROM device_pairings recent_claim
              WHERE recent_claim.participant_id = device_pairings.participant_id
                AND recent_claim.state = 'consumed'
                AND recent_claim.consumed_at > ?
           ) < ?`,
      ).bind(
        issuedAt,
        deviceId,
        parsed.id,
        issuedAt,
        deviceId,
        claimWindowStart,
        policy.pairingClaimLimit,
      ),
      // A v1.0-consented pairing claim is the server-recorded consent-once
      // grant for this device: the participant approved the field
      // dictionary in their authenticated session when the pairing was
      // issued, and the claim binds that approval to the device identity.
      // Uploads later compare against this record; they never create it.
      db.prepare(
        `INSERT INTO telemetry_v1_device_consents (
          participant_id, device_id, telemetry_schema_version,
          field_dictionary_version, privacy_contract_version, consented_at
        )
        SELECT pairing.participant_id, ?, ?, ?, ?, ?
          FROM device_pairings pairing
         WHERE pairing.id = ?
           AND pairing.transport_consent_version = ?
           AND EXISTS (
             SELECT 1 FROM device_credentials device
              WHERE device.id = ?
                AND device.paired_via_pairing_id = pairing.id
           )
        ON CONFLICT (participant_id, device_id) DO NOTHING`,
      ).bind(
        deviceId,
        INCREMENTAL_TELEMETRY_SCHEMA_VERSION,
        INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
        ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
        issuedAt,
        parsed.id,
        ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
        deviceId,
      ),
    ]);
  } catch (error) {
    const replay = await pairedDeviceForRetry(
      db,
      parsed.id,
      deviceId,
      deviceSecretHash,
    );
    if (replay) return replay;
    throw error;
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const replay = await pairedDeviceForRetry(
      db,
      parsed.id,
      deviceId,
      deviceSecretHash,
    );
    if (replay) return replay;
    throw new ApiError(401, "PAIRING_AUTH_INVALID");
  }
  return {
    deviceId,
    state: "active",
    scope: "upload_registration",
    expiresAt,
  };
}

async function revokeDeviceRows(
  db: D1Database,
  deviceId: string,
  now: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE device_credentials
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND state = 'active'`,
    ).bind(now, deviceId),
    db.prepare(
      `UPDATE device_upload_authorizations
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?),
              consume_lease_expires_at = NULL
        WHERE issued_by_device_id = ? AND state IN ('unused', 'consuming')`,
    ).bind(now, deviceId),
  ]);
}

async function credentialReuseDetected(
  db: D1Database,
  deviceId: string,
  presentedHash: Uint8Array,
): Promise<boolean> {
  const rows = await db.prepare(
    `SELECT prior_secret_hash
       FROM device_credential_rotations
      WHERE device_id = ? AND retire_at > ?`,
  ).bind(deviceId, new Date().toISOString()).all<{
    prior_secret_hash: ArrayBuffer;
  }>();
  const matched = rows.results.some((entry) => timingSafeEqual(
    presentedHash,
    bytes(entry.prior_secret_hash),
  ));
  if (matched) await revokeDeviceRows(db, deviceId, new Date().toISOString());
  return matched;
}

export async function authenticateDevice(
  db: D1Database,
  authorizationHeader: string | null,
  options: DeviceLifecycleOptions = {},
): Promise<DevicePrincipal> {
  const policy = lifecyclePolicy(options.policy);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const row = await db.prepare(
    `SELECT device.*, participant.state AS participant_state,
            participant.consent_version AS participant_consent_version
       FROM device_credentials device
       JOIN participants participant ON participant.id = device.participant_id
      WHERE device.id = ?`,
  ).bind(parsed.id).first<DeviceRow>();
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  const currentSecretMatches = timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  );
  if (!currentSecretMatches && row) {
    // A previous secret is a signal that a rotated credential was reused.
    // Revoke the current device lineage before returning the same neutral
    // auth failure used for every other invalid bearer.
    await credentialReuseDetected(db, row.id, presentedHash);
  }
  const socialVerifiedAt = row?.social_verified_at ?? row?.issued_at ?? null;
  if (!currentSecretMatches
      || !row
      || row.state !== "active"
      || row.participant_state !== "active"
      || ongoingConsentForParticipant(row.participant_consent_version) === null
      || !futureInstant(row.expires_at, nowEpoch)
      || !recentInstant(row.last_used_at, nowEpoch, policy.idleMilliseconds)
      || !socialVerifiedAt
      || !recentInstant(
        socialVerifiedAt,
        nowEpoch,
        policy.socialRecheckMaxAgeMilliseconds,
      )) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  // Successful, active use keeps the scoped device bearer alive without
  // repeatedly interrupting the person for a browser sign-in. It is still
  // bounded twice: a device unused for the idle window cannot renew itself,
  // and no renewal may extend beyond the social-account recheck deadline.
  // This is the device analogue of a sliding session, not a refresh token:
  // the only bearer remains the 32-byte Keychain secret already presented.
  const socialRecheckDeadline = Date.parse(socialVerifiedAt)
    + policy.socialRecheckMaxAgeMilliseconds;
  const renewedExpiry = epochIso(Math.min(
    nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS,
    socialRecheckDeadline,
  ));
  if (!futureInstant(renewedExpiry, nowEpoch)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const used = await db.prepare(
    `UPDATE device_credentials
        SET last_used_at = ?, expires_at = ?
      WHERE id = ? AND state = 'active' AND expires_at > ?
        AND secret_hash = ?
        AND EXISTS (
          SELECT 1 FROM participants
           WHERE id = ? AND state = 'active'
             AND consent_version = ?
        )`,
  ).bind(
    now,
    renewedExpiry,
    row.id,
    now,
    presentedHash,
    row.participant_id,
    row.participant_consent_version,
  ).run();
  if (used.meta.changes !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  return {
    deviceId: row.id,
    participantId: row.participant_id,
    participantConsentVersion: row.participant_consent_version,
    expiresAt: renewedExpiry,
    credentialGeneration: row.credential_generation,
    socialVerifiedAt: socialVerifiedAt!,
  };
}

/**
 * Atomically rotate the upload-only bearer secret in place.
 *
 * The client generates a fresh 32-byte secret, computes the same
 * domain-separated device hash used during pairing, and sends only that hash
 * plus a fresh opaque attempt UUID.  It must keep the old secret until this
 * function returns `{ commit: true }`, then replace the local Keychain value.
 * The attempt UUID makes a lost response retryable without presenting the old
 * secret as an unrelated reuse.  A different attempt presenting the old
 * secret is treated as credential reuse and revokes the device lineage.
 */
export async function rotateDeviceCredential(
  db: D1Database,
  authorizationHeader: string | null,
  nextDeviceSecretHashHex: string,
  rotationAttemptId: string,
  options: DeviceLifecycleOptions = {},
): Promise<DeviceCredentialRotationResult> {
  const policy = lifecyclePolicy(options.policy);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  const attemptId = lifecycleAttemptId(rotationAttemptId);
  const replacementHash = bytesFromHex(nextDeviceSecretHashHex);
  if (replacementHash.every((value) => value === 0)) {
    throw new ApiError(400, "BODY_INVALID");
  }

  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  if (timingSafeEqual(replacementHash, presentedHash)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const existingAttempt = await db.prepare(
    `SELECT * FROM device_credential_rotations
      WHERE device_id = ? AND attempt_id = ?`,
  ).bind(parsed.id, attemptId).first<DeviceRotationRow>();
  if (existingAttempt) {
    const matchingAttempt = timingSafeEqual(
      replacementHash,
      bytes(existingAttempt.replacement_secret_hash),
    ) && timingSafeEqual(
      presentedHash,
      bytes(existingAttempt.prior_secret_hash),
    );
    const current = await db.prepare(
      `SELECT device.*, participant.state AS participant_state,
              participant.consent_version AS participant_consent_version
         FROM device_credentials device
         JOIN participants participant ON participant.id = device.participant_id
        WHERE device.id = ?`,
    ).bind(parsed.id).first<DeviceRow>();
    if (matchingAttempt
        && current
        && current.state === "active"
        && timingSafeEqual(
          replacementHash,
          bytes(current.secret_hash),
        )) {
      return {
        deviceId: current.id,
        state: "active",
        scope: "upload_registration",
        expiresAt: current.expires_at,
        credentialGeneration: current.credential_generation,
        commit: true,
      };
    }
    if (!matchingAttempt) throw new ApiError(401, "DEVICE_AUTH_INVALID");
    // The same old secret was presented after a later rotation. Treat it as
    // reuse rather than allowing a client to roll a credential backwards.
    await credentialReuseDetected(db, parsed.id, presentedHash);
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  const principal = await authenticateDevice(db, authorizationHeader, {
    nowEpoch,
    policy,
  });
  const row = await db.prepare(
    `SELECT device.*, participant.state AS participant_state,
            participant.consent_version AS participant_consent_version
       FROM device_credentials device
       JOIN participants participant ON participant.id = device.participant_id
      WHERE device.id = ?`,
  ).bind(parsed.id).first<DeviceRow>();
  if (!row
      || row.state !== "active"
      || !timingSafeEqual(presentedHash, bytes(row.secret_hash))
      || principal.credentialGeneration !== row.credential_generation) {
    await credentialReuseDetected(db, parsed.id, presentedHash);
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  const generation = row.credential_generation + 1;
  // Rotation changes only the bearer secret, not its social-authentication
  // horizon. A rotation route must not become a way to extend a device past
  // the hard recheck deadline that authenticateDevice just enforced.
  const expiresAt = epochIso(Math.min(
    nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS,
    Date.parse(principal.socialVerifiedAt)
      + policy.socialRecheckMaxAgeMilliseconds,
  ));
  if (!futureInstant(expiresAt, nowEpoch)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const retireAt = new Date(Math.max(
    nowEpoch + policy.rotationHistoryMilliseconds,
    Date.parse(expiresAt),
  )).toISOString();
  const rotationId = crypto.randomUUID();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO device_credential_rotations (
           id, device_id, participant_id, prior_secret_hash,
           replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
         )
         SELECT ?, id, participant_id, ?, ?, ?, ?, ?, ?
           FROM device_credentials
          WHERE id = ? AND state = 'active'
            AND secret_hash = ? AND credential_generation = ?`,
      ).bind(
        rotationId,
        presentedHash,
        replacementHash,
        attemptId,
        generation,
        now,
        retireAt,
        row.id,
        presentedHash,
        row.credential_generation,
      ),
      db.prepare(
        `UPDATE device_credentials
            SET secret_hash = ?, expires_at = ?, last_used_at = ?,
                credential_generation = ?
          WHERE id = ? AND state = 'active'
            AND secret_hash = ? AND credential_generation = ?`,
      ).bind(
        replacementHash,
        expiresAt,
        now,
        generation,
        row.id,
        presentedHash,
        row.credential_generation,
      ),
    ]);
  } catch (error) {
    const retry = await db.prepare(
      `SELECT rotation.*, device.secret_hash, device.state
         FROM device_credential_rotations rotation
         JOIN device_credentials device ON device.id = rotation.device_id
        WHERE rotation.device_id = ? AND rotation.attempt_id = ?`,
    ).bind(row.id, attemptId).first<{
      replacement_secret_hash: ArrayBuffer;
      prior_secret_hash: ArrayBuffer;
      secret_hash: ArrayBuffer;
      state: "active" | "revoked";
      generation: number;
      retire_at: string;
    }>();
    if (retry
        && retry.state === "active"
        && timingSafeEqual(replacementHash, bytes(retry.replacement_secret_hash))
        && timingSafeEqual(replacementHash, bytes(retry.secret_hash))) {
      return {
        deviceId: row.id,
        state: "active",
        scope: "upload_registration",
        expiresAt,
        credentialGeneration: retry.generation,
        commit: true,
      };
    }
    throw error;
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const retry = await db.prepare(
      `SELECT rotation.*, device.secret_hash, device.state
         FROM device_credential_rotations rotation
         JOIN device_credentials device ON device.id = rotation.device_id
        WHERE rotation.device_id = ? AND rotation.attempt_id = ?`,
    ).bind(row.id, attemptId).first<{
      replacement_secret_hash: ArrayBuffer;
      secret_hash: ArrayBuffer;
      state: "active" | "revoked";
      generation: number;
    }>();
    if (retry
        && retry.state === "active"
        && timingSafeEqual(replacementHash, bytes(retry.replacement_secret_hash))
        && timingSafeEqual(replacementHash, bytes(retry.secret_hash))) {
      return {
        deviceId: row.id,
        state: "active",
        scope: "upload_registration",
        expiresAt,
        credentialGeneration: retry.generation,
        commit: true,
      };
    }
    await credentialReuseDetected(db, parsed.id, presentedHash);
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  return {
    deviceId: row.id,
    state: "active",
    scope: "upload_registration",
    expiresAt,
    credentialGeneration: generation,
    commit: true,
  };
}

export async function createDeviceUploadAuthorization(
  db: D1Database,
  device: DevicePrincipal,
  envelopeDigest: string,
  bodyBytes: number,
  nowEpoch = Date.now(),
): Promise<{ uploadAuthorization: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + UPLOAD_AUTHORIZATION_TTL_MILLISECONDS).toISOString();
  const secretHash = await deviceUploadHash(id, secret);
  const result = await db.prepare(
    `INSERT INTO device_upload_authorizations (
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at
    )
    SELECT ?, device.participant_id, device.id, ?, ?, ?,
           'application/json', 'unused', ?, ?
      FROM device_credentials device
      JOIN participants participant ON participant.id = device.participant_id
     WHERE device.id = ?
       AND device.participant_id = ?
       AND device.state = 'active'
       AND device.expires_at > ?
       AND participant.state = 'active'
       AND participant.consent_version = ?`,
  ).bind(
    id,
    secretHash,
    envelopeDigest,
    bodyBytes,
    issuedAt,
    expiresAt,
    device.deviceId,
    device.participantId,
    issuedAt,
    device.participantConsentVersion,
  ).run();
  if (result.meta.changes !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  return {
    uploadAuthorization: `um_device_upload_${id}.${secret}`,
    expiresAt,
  };
}

export async function claimDeviceUploadAuthorization(
  db: D1Database,
  authorizationHeader: string | null,
  {
    envelopeDigest,
    bodyBytes,
    contentType,
  }: {
    envelopeDigest: string;
    bodyBytes: number;
    contentType: string;
  },
): Promise<DeviceUploadClaim> {
  const parsed = parseDeviceUploadAuthorization(authorizationHeader);
  const row = await db.prepare(
    `SELECT upload.*, participant.state AS participant_state,
            device.state AS device_state, device.expires_at AS device_expires_at
       FROM device_upload_authorizations upload
       JOIN participants participant ON participant.id = upload.participant_id
       JOIN device_credentials device ON device.id = upload.issued_by_device_id
      WHERE upload.id = ?`,
  ).bind(parsed.id).first<DeviceUploadRow>();
  const presentedHash = await deviceUploadHash(parsed.id, parsed.secret);
  if (!timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  )
      || !row
      || row.state !== "unused"
      || row.participant_state !== "active"
      || row.device_state !== "active"
      || !futureInstant(row.device_expires_at)
      || !futureInstant(row.expires_at)
      || row.envelope_digest !== envelopeDigest
      || row.body_bytes !== bodyBytes
      || row.content_type !== contentType) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + UPLOAD_CONSUME_LEASE_MILLISECONDS,
  ).toISOString();
  const result = await db.prepare(
    `UPDATE device_upload_authorizations
        SET state = 'consuming', consume_lease_expires_at = ?
      WHERE id = ? AND state = 'unused' AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM device_credentials device
          JOIN participants participant ON participant.id = device.participant_id
           WHERE device.id = device_upload_authorizations.issued_by_device_id
             AND device.participant_id = device_upload_authorizations.participant_id
             AND device.state = 'active'
             AND device.expires_at > ?
             AND participant.state = 'active'
        )`,
  ).bind(leaseExpiresAt, parsed.id, now, now).run();
  if (result.meta.changes !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  return {
    authorizationId: parsed.id,
    participantId: row.participant_id,
    authorizationKind: "device",
  };
}

export async function recordDeviceUploadReceipt(
  db: D1Database,
  authorizationId: string,
  contributionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE device_upload_authorizations
        SET state = 'consumed', consumed_at = ?,
            consumed_contribution_id = ?, consume_lease_expires_at = NULL
      WHERE id = ? AND state = 'consuming'
        AND consume_lease_expires_at > ?
        AND expires_at > ?`,
  ).bind(now, contributionId, authorizationId, now, now).run();
  if (result.meta.changes === 1) return;
  const existing = await db.prepare(
    `SELECT state, consumed_contribution_id
       FROM device_upload_authorizations WHERE id = ?`,
  ).bind(authorizationId).first<{
    state: string;
    consumed_contribution_id: string | null;
  }>();
  if (existing?.state !== "consumed"
      || existing.consumed_contribution_id !== contributionId) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
}

export async function abandonDeviceUploadAuthorization(
  db: D1Database,
  authorizationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE device_upload_authorizations
        SET state = 'revoked', revoked_at = ?, consume_lease_expires_at = NULL
      WHERE id = ? AND state = 'consuming'`,
  ).bind(now, authorizationId).run();
}

export async function listParticipantDevices(
  db: D1Database,
  participantId: string,
): Promise<Array<{
  deviceId: string;
  state: "active" | "revoked";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}>> {
  const result = await db.prepare(
    `SELECT id, state, issued_at, expires_at, last_used_at, revoked_at
       FROM device_credentials
      WHERE participant_id = ?
      ORDER BY issued_at DESC, id DESC
      LIMIT 101`,
  ).bind(participantId).all<{
    id: string;
    state: "active" | "revoked";
    issued_at: string;
    expires_at: string;
    last_used_at: string;
    revoked_at: string | null;
  }>();
  if (result.results.length > 100) throw new ApiError(500, "INTERNAL_ERROR");
  return result.results.map((row) => ({
    deviceId: row.id,
    state: row.state,
    createdAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export async function revokeParticipantDevice(
  db: D1Database,
  participantId: string,
  deviceId: string,
): Promise<boolean> {
  if (!new RegExp(`^${UUID_V4}$`, "u").test(deviceId)) return false;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE device_credentials
          SET state = 'revoked', revoked_at = ?
        WHERE id = ? AND participant_id = ? AND state = 'active'`,
    ).bind(now, deviceId, participantId),
    db.prepare(
      `UPDATE device_upload_authorizations
          SET state = 'revoked', revoked_at = ?, consume_lease_expires_at = NULL
        WHERE participant_id = ? AND issued_by_device_id = ?
          AND state IN ('unused', 'consuming')`,
    ).bind(now, participantId, deviceId),
  ]);
  const row = await db.prepare(
    "SELECT 1 AS present FROM device_credentials WHERE id = ? AND participant_id = ?",
  ).bind(deviceId, participantId).first<{ present: number }>();
  return row?.present === 1;
}

/**
 * Disconnect is intentionally authenticated by the device bearer itself. It
 * does not require a personal web session or upload-registration control, so
 * a client can stop background contribution even while registration is
 * contained. The response contains only the opaque device id already held by
 * the caller; no credential material is returned or logged.
 */
export async function disconnectAuthenticatedDevice(
  db: D1Database,
  authorizationHeader: string | null,
): Promise<{ deviceId: string; revoked: true }> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  const row = await db.prepare(
    `SELECT id, secret_hash, state
       FROM device_credentials
      WHERE id = ?`,
  ).bind(parsed.id).first<{
    id: string;
    secret_hash: ArrayBuffer;
    state: "active" | "revoked";
  }>();
  if (!row || !timingSafeEqual(presentedHash, bytes(row.secret_hash))) {
    if (row) await credentialReuseDetected(db, row.id, presentedHash);
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  await revokeDeviceRows(db, row.id, new Date().toISOString());
  return { deviceId: row.id, revoked: true };
}

/**
 * Bounded maintenance for expired/idle device state. It only revokes bearer
 * authority and pending upload authorizations; consumed receipts remain for
 * normal replay/audit handling. Callers should schedule this from their
 * existing maintenance path and record the returned counts without including
 * ids, hashes, or request metadata.
 */
export async function purgeStaleDeviceLifecycleRows(
  db: D1Database,
  options: DeviceLifecycleOptions = {},
): Promise<DeviceLifecycleMaintenanceResult> {
  const policy = lifecyclePolicy(options.policy);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = epochIso(nowEpoch);
  const idleCutoff = new Date(
    nowEpoch - policy.idleMilliseconds,
  ).toISOString();
  const eventCutoff = new Date(
    nowEpoch - Math.max(
      policy.pairingIssueWindowMilliseconds,
      policy.pairingClaimWindowMilliseconds,
    ),
  ).toISOString();
  const batchSize = policy.maintenanceBatchSize;
  const pairings = await db.prepare(
    `UPDATE device_pairings
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE id IN (
        SELECT id FROM device_pairings
         WHERE state = 'unused'
           AND (
             expires_at <= ?
             OR EXISTS (
               SELECT 1 FROM participants participant
                WHERE participant.id = device_pairings.participant_id
                  AND participant.state <> 'active'
             )
           )
         LIMIT ?
      )`,
  ).bind(now, now, batchSize).run();
  const devices = await db.prepare(
    `UPDATE device_credentials
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE id IN (
        SELECT id FROM device_credentials
         WHERE state = 'active'
           AND (
             expires_at <= ?
             OR last_used_at <= ?
             OR EXISTS (
               SELECT 1 FROM participants participant
                WHERE participant.id = device_credentials.participant_id
                  AND participant.state <> 'active'
             )
           )
         LIMIT ?
      )`,
  ).bind(now, now, idleCutoff, batchSize).run();
  const uploads = await db.prepare(
    `UPDATE device_upload_authorizations
        SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?),
            consume_lease_expires_at = NULL
      WHERE id IN (
        SELECT upload.id
          FROM device_upload_authorizations upload
          LEFT JOIN device_credentials device
            ON device.id = upload.issued_by_device_id
         WHERE upload.state IN ('unused', 'consuming')
           AND (
             upload.expires_at <= ?
           OR device.id IS NULL
           OR device.state <> 'active'
           OR device.expires_at <= ?
           OR EXISTS (
             SELECT 1 FROM participants participant
              WHERE participant.id = upload.participant_id
                AND participant.state <> 'active'
           )
         )
         LIMIT ?
      )`,
  ).bind(now, now, now, batchSize).run();
  const rotations = await db.prepare(
    `DELETE FROM device_credential_rotations
      WHERE id IN (
        SELECT id FROM device_credential_rotations
         WHERE retire_at <= ?
         LIMIT ?
      )`,
  ).bind(now, batchSize).run();
  const events = await db.prepare(
    `DELETE FROM device_pairing_events
      WHERE id IN (
        SELECT id FROM device_pairing_events
         WHERE occurred_at <= ?
         LIMIT ?
      )`,
  ).bind(eventCutoff, batchSize).run();
  return {
    pairingsRevoked: pairings.meta.changes,
    devicesRevoked: devices.meta.changes,
    uploadsRevoked: uploads.meta.changes,
    rotationsPurged: rotations.meta.changes,
    pairingEventsPurged: events.meta.changes,
  };
}
