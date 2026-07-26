import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  DEVICE_PAIRING_TTL_MILLISECONDS,
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
  revoked_at: string | null;
  participant_state: "active" | "deleting";
  participant_consent_version: string;
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
}

export interface DeviceUploadClaim {
  authorizationId: string;
  participantId: string;
  authorizationKind: "device";
}

function ongoingConsentForParticipant(consentVersion: string): string | null {
  if (consentVersion === TELEMETRY_CONSENT_VERSION) {
    return ONGOING_TELEMETRY_CONSENT_VERSION;
  }
  if (consentVersion === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION) {
    return ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  }
  return null;
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function futureInstant(value: string, nowEpoch = Date.now()): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ApiError(400, "BODY_INVALID");
  return Uint8Array.from(
    value.match(/.{2}/gu) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
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

export async function createDevicePairing(
  db: D1Database,
  participantId: string,
  sessionId: string,
  participantConsentVersion: string,
  nowEpoch = Date.now(),
): Promise<{ pairingCode: string; expiresAt: string }> {
  const ongoingConsentVersion = ongoingConsentForParticipant(
    participantConsentVersion,
  );
  if (!ongoingConsentVersion) throw new ApiError(400, "TELEMETRY_REQUIRED");
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + DEVICE_PAIRING_TTL_MILLISECONDS).toISOString();
  const secretHash = await pairingHash(id, secret);
  const result = await db.prepare(
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
       AND session.expires_at > ?`,
  ).bind(
    id,
    secretHash,
    ONGOING_TELEMETRY_CONSENT_VERSION,
    ongoingConsentVersion,
    issuedAt,
    expiresAt,
    participantId,
    participantConsentVersion,
    sessionId,
    issuedAt,
  ).run();
  if (result.meta.changes !== 1) throw new ApiError(401, "AUTH_INVALID");
  return { pairingCode: `um_pair_${id}.${secret}`, expiresAt };
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
    `SELECT id, secret_hash, expires_at
       FROM device_credentials
      WHERE id = ? AND paired_via_pairing_id = ?`,
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
): Promise<{
  deviceId: string;
  state: "active";
  scope: "upload_registration";
  expiresAt: string;
}> {
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
      || ongoingConsentForParticipant(row.participant_consent_version)
        !== row.transport_consent_version
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

  const issuedAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS).toISOString();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO device_credentials (
          id, participant_id, paired_via_pairing_id, secret_hash, state,
          issued_at, expires_at, last_used_at
        )
        SELECT ?, pairing.participant_id, pairing.id, ?, 'active', ?, ?, ?
          FROM device_pairings pairing
          JOIN participants participant ON participant.id = pairing.participant_id
         WHERE pairing.id = ?
           AND pairing.state = 'unused'
           AND pairing.expires_at > ?
           AND participant.state = 'active'
           AND participant.consent_version = ?`,
      ).bind(
        deviceId,
        deviceSecretHash,
        issuedAt,
        expiresAt,
        issuedAt,
        parsed.id,
        issuedAt,
        row.participant_consent_version,
      ),
      db.prepare(
        `UPDATE device_pairings
            SET state = 'consumed', consumed_at = ?, claimed_device_id = ?
          WHERE id = ? AND state = 'unused' AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM device_credentials
               WHERE id = ? AND paired_via_pairing_id = device_pairings.id
            )`,
      ).bind(issuedAt, deviceId, parsed.id, issuedAt, deviceId),
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

export async function authenticateDevice(
  db: D1Database,
  authorizationHeader: string | null,
): Promise<DevicePrincipal> {
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const row = await db.prepare(
    `SELECT device.*, participant.state AS participant_state,
            participant.consent_version AS participant_consent_version
       FROM device_credentials device
       JOIN participants participant ON participant.id = device.participant_id
      WHERE device.id = ?`,
  ).bind(parsed.id).first<DeviceRow>();
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  if (!timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  )
      || !row
      || row.state !== "active"
      || row.participant_state !== "active"
      || ongoingConsentForParticipant(row.participant_consent_version) === null
      || !futureInstant(row.expires_at)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const now = new Date().toISOString();
  const used = await db.prepare(
    `UPDATE device_credentials
        SET last_used_at = ?
      WHERE id = ? AND state = 'active' AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM participants
           WHERE id = ? AND state = 'active'
             AND consent_version = ?
        )`,
  ).bind(
    now,
    row.id,
    now,
    row.participant_id,
    row.participant_consent_version,
  ).run();
  if (used.meta.changes !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  return {
    deviceId: row.id,
    participantId: row.participant_id,
    participantConsentVersion: row.participant_consent_version,
    expiresAt: row.expires_at,
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
          SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND issued_by_device_id = ?
          AND state = 'unused'`,
    ).bind(now, participantId, deviceId),
  ]);
  const row = await db.prepare(
    "SELECT 1 AS present FROM device_credentials WHERE id = ? AND participant_id = ?",
  ).bind(deviceId, participantId).first<{ present: number }>();
  return row?.present === 1;
}
