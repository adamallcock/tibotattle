import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  deviceHash,
  parseDeviceAuthorization,
  type DeviceLifecyclePolicy,
} from "./device-auth";
import {
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  DEVICE_PAIRING_TTL_MILLISECONDS,
  INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
  INCREMENTAL_TELEMETRY_SCHEMA_VERSION,
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
  ONGOING_TELEMETRY_CONSENT_VERSION,
  ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { sha256, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
  type PostgresClient,
} from "./postgres-client";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PAIRING_AUTHORIZATION = /^um_pair_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const ZERO_HASH = new Uint8Array(32);

interface PairingRow {
  readonly id: string;
  readonly participant_id: string;
  readonly secret_hash: Uint8Array | ArrayBuffer;
  readonly state: "unused" | "consumed" | "revoked";
  readonly expires_at: Date | string;
  readonly claimed_device_id: string | null;
  readonly transport_consent_version: string;
  readonly issued_by_session_id: string;
  readonly participant_state: "active" | "deleting";
  readonly participant_owner_kind: "social" | "accountless";
  readonly participant_consent_version: string | null;
}

interface OwnerRow {
  readonly state: "active" | "deleting";
  readonly owner_kind: "social" | "accountless";
  readonly consent_version: string | null;
}

interface PairingDetailsRow {
  readonly id: string;
  readonly participant_id: string;
  readonly secret_hash: Uint8Array | ArrayBuffer;
  readonly state: "unused" | "consumed" | "revoked";
  readonly expires_at: Date | string;
  readonly claimed_device_id: string | null;
  readonly transport_consent_version: string;
  readonly issued_by_session_id: string;
}

interface DeviceRow {
  readonly id: string;
  readonly participant_id: string;
  readonly paired_via_pairing_id: string | null;
  readonly secret_hash: Uint8Array | ArrayBuffer;
  readonly state: "active" | "revoked";
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly credential_generation: number;
}

interface RotationRow {
  readonly prior_secret_hash: Uint8Array | ArrayBuffer;
  readonly recovery_proof_hash: Uint8Array | ArrayBuffer | null;
  readonly replacement_secret_hash: Uint8Array | ArrayBuffer;
}

interface PairingClaimResult {
  readonly deviceId: string;
  readonly state: "active";
  readonly scope: "upload_registration";
  readonly expiresAt: string;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function safeInstant(value: Date | string): string | null {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function byteView(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ApiError(400, "BODY_INVALID");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parsePairingAuthorization(header: string | null): { id: string; secret: string } {
  if (header === null || !header.startsWith("Pairing ")) {
    throw new ApiError(401, "PAIRING_AUTH_INVALID");
  }
  const match = PAIRING_AUTHORIZATION.exec(header.slice("Pairing ".length));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "PAIRING_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function ongoingConsentForParticipant(consentVersion: string | null): string | null {
  if (consentVersion === TELEMETRY_CONSENT_VERSION) return ONGOING_TELEMETRY_CONSENT_VERSION;
  if (consentVersion === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION) {
    return ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  }
  return null;
}

function transportConsentAllowed(participantConsentVersion: string | null, transportConsentVersion: string): boolean {
  if (transportConsentVersion === ongoingConsentForParticipant(participantConsentVersion)) return true;
  return transportConsentVersion === ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
    && participantConsentVersion === TELEMETRY_CONSENT_VERSION;
}

function pairingUnauthorized(): ApiError {
  return new ApiError(401, "PAIRING_AUTH_INVALID");
}

function verifyPairing(
  row: PairingRow | null,
  pairingId: string,
  presentedHash: Uint8Array,
  nowEpoch: number,
): asserts row is PairingRow {
  const storedHash = row === null ? ZERO_HASH : byteView(row.secret_hash);
  const secretMatches = timingSafeEqual(presentedHash, storedHash);
  const expiry = row === null ? null : safeInstant(row.expires_at);
  if (!secretMatches
      || row === null
      || row.id !== pairingId
      || row.participant_state !== "active"
      || row.participant_owner_kind !== "social"
      || !transportConsentAllowed(row.participant_consent_version, row.transport_consent_version)
      || expiry === null
      || Date.parse(expiry) <= nowEpoch) {
    throw pairingUnauthorized();
  }
}

function lifecyclePolicy(overrides: Partial<DeviceLifecyclePolicy> = {}): DeviceLifecyclePolicy {
  const policy = { ...DEFAULT_DEVICE_LIFECYCLE_POLICY, ...overrides };
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return policy;
}

function pairingProjection(primary: string): string {
  return `SELECT pairing.id, pairing.participant_id, pairing.secret_hash,
                 pairing.state, pairing.expires_at, pairing.claimed_device_id,
                 pairing.transport_consent_version, pairing.issued_by_session_id,
                 participant.state AS participant_state,
                 participant.owner_kind AS participant_owner_kind,
                 participant.consent_version AS participant_consent_version
            FROM ${primary}."device_pairings" pairing
            JOIN ${primary}."participants" participant
              ON participant.id = pairing.participant_id
           WHERE pairing.id = $1`;
}

async function readPairing(pool: PostgresPool, primary: string, pairingId: string): Promise<PairingRow | null> {
  return withPostgresRead(pool, async (client) => {
    const result = await client.query<PairingRow>(pairingProjection(primary), [pairingId]);
    return result.rows[0] ?? null;
  }, {
    operation: "device_pairing.claim_read",
    statementTimeoutMilliseconds: 3_000,
    lockTimeoutMilliseconds: 1_000,
    preserveSafeError: (error) => error instanceof ApiError ? error : null,
  });
}

async function lockPairingOwnerAndRow(
  client: PostgresClient,
  primary: string,
  participantId: string,
  pairingId: string,
): Promise<PairingRow> {
  const ownerResult = await client.query<OwnerRow>(
    `SELECT state, owner_kind, consent_version
       FROM ${primary}."participants"
      WHERE id = $1
      FOR UPDATE`,
    [participantId],
  );
  const owner = ownerResult.rows[0];
  if (!owner || owner.state !== "active" || owner.owner_kind !== "social") throw pairingUnauthorized();
  const pairingResult = await client.query<PairingDetailsRow>(
    `SELECT id, participant_id, secret_hash, state, expires_at, claimed_device_id,
            transport_consent_version, issued_by_session_id
       FROM ${primary}."device_pairings"
      WHERE id = $1 AND participant_id = $2
      FOR UPDATE`,
    [pairingId, participantId],
  );
  const pairing = pairingResult.rows[0];
  if (!pairing) throw pairingUnauthorized();
  return {
    ...pairing,
    participant_state: owner.state,
    participant_owner_kind: owner.owner_kind,
    participant_consent_version: owner.consent_version,
  };
}

function pairingResult(deviceId: string, expiresAt: Date | string): PairingClaimResult {
  const canonicalExpiry = safeInstant(expiresAt);
  if (canonicalExpiry === null) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return Object.freeze({
    deviceId,
    state: "active",
    scope: "upload_registration",
    expiresAt: canonicalExpiry,
  });
}

async function replayedPairingClaim(
  client: PostgresClient,
  primary: string,
  pairingId: string,
  deviceId: string,
  requestedSecretHash: Uint8Array,
  now: string,
  nowEpoch: number,
): Promise<PairingClaimResult | null> {
  const result = await client.query<{ secret_hash: Uint8Array | ArrayBuffer; expires_at: Date | string }>(
    `SELECT device.secret_hash, device.expires_at
       FROM ${primary}."device_pairings" pairing
       JOIN ${primary}."device_credentials" device
         ON device.id = pairing.claimed_device_id
        AND device.participant_id = pairing.participant_id
        AND device.paired_via_pairing_id = pairing.id
       JOIN ${primary}."participants" participant
         ON participant.id = device.participant_id
      WHERE pairing.id = $1 AND pairing.state = 'consumed'
        AND pairing.claimed_device_id = $2 AND device.id = $2
        AND device.state = 'active' AND device.expires_at > $3::timestamptz
        AND participant.state = 'active'
      LIMIT 1`,
    [pairingId, deviceId, now],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expiresAt = safeInstant(row.expires_at);
  if (expiresAt === null || Date.parse(expiresAt) <= nowEpoch
      || !timingSafeEqual(requestedSecretHash, byteView(row.secret_hash))) return null;
  return pairingResult(deviceId, row.expires_at);
}

async function readDeviceForContinuity(
  client: PostgresClient,
  primary: string,
  pairing: PairingRow,
  deviceId: string,
  now: string,
  freshSince: string,
  lock: boolean,
): Promise<DeviceRow | null> {
  const result = await client.query<DeviceRow>(
    `SELECT device.id, device.participant_id, device.paired_via_pairing_id,
            device.secret_hash, device.state, device.issued_at, device.expires_at,
            device.credential_generation
       FROM ${primary}."device_credentials" device
       JOIN ${primary}."participants" participant
         ON participant.id = device.participant_id
       JOIN ${primary}."web_sessions" session
         ON session.id = $3 AND session.participant_id = device.participant_id
      WHERE device.id = $1 AND device.participant_id = $2
        AND device.state = 'active' AND participant.state = 'active'
        AND participant.owner_kind = 'social'
        AND session.scope = 'personal' AND session.state = 'active'
        AND session.expires_at > $4::timestamptz
        AND session.issued_at >= $5::timestamptz
        AND session.issued_at <= $4::timestamptz
      ${lock ? "FOR UPDATE OF device" : ""}`,
    [deviceId, pairing.participant_id, pairing.issued_by_session_id, now, freshSince],
  );
  return result.rows[0] ?? null;
}

async function continuityIsRequired(
  client: PostgresClient,
  primary: string,
  pairing: PairingRow,
  deviceId: string,
  localSecretHash: Uint8Array,
  now: string,
  freshSince: string,
): Promise<boolean> {
  const device = await readDeviceForContinuity(
    client, primary, pairing, deviceId, now, freshSince, true,
  );
  if (!device) return false;
  if (pairing.state === "unused") return true;
  if (pairing.state !== "consumed" || pairing.claimed_device_id !== deviceId
      || device.paired_via_pairing_id !== pairing.id) return false;
  const rotation = await client.query<RotationRow>(
    `SELECT prior_secret_hash, recovery_proof_hash, replacement_secret_hash
       FROM ${primary}."device_credential_rotations"
      WHERE device_id = $1 AND participant_id = $2 AND attempt_id = $3
        AND generation = $4 AND retire_at > $5::timestamptz
      LIMIT 1`,
    [deviceId, pairing.participant_id, pairing.id, device.credential_generation, now],
  );
  const receipt = rotation.rows[0];
  if (!receipt
      || !timingSafeEqual(byteView(receipt.replacement_secret_hash), byteView(device.secret_hash))) return false;
  return timingSafeEqual(localSecretHash, byteView(receipt.prior_secret_hash))
    || (receipt.recovery_proof_hash !== null
      && timingSafeEqual(localSecretHash, byteView(receipt.recovery_proof_hash)));
}

async function claimWindowCount(
  client: PostgresClient,
  primary: string,
  participantId: string,
  cutoff: string,
): Promise<number> {
  const result = await client.query<{ count: string | number }>(
    `SELECT count(*)::text AS count
       FROM ${primary}."device_pairings"
      WHERE participant_id = $1 AND state = 'consumed'
        AND consumed_at > $2::timestamptz`,
    [participantId, cutoff],
  );
  const value = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return value;
}

async function deviceCapCount(
  client: PostgresClient,
  primary: string,
  participantId: string,
  now: string,
  idleCutoff: string,
): Promise<number> {
  const result = await client.query<{ count: string | number }>(
    `SELECT count(*)::text AS count
       FROM ${primary}."device_credentials"
      WHERE participant_id = $1 AND state = 'active'
        AND expires_at > $2::timestamptz AND last_used_at > $3::timestamptz`,
    [participantId, now, idleCutoff],
  );
  const value = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return value;
}

async function insertIncrementalConsent(
  client: PostgresClient,
  primary: string,
  pairingId: string,
  participantId: string,
  deviceId: string,
  issuedAt: string,
  transportConsentVersion: string,
): Promise<void> {
  if (transportConsentVersion !== ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION) return;
  const granted = await client.query(
    `INSERT INTO ${primary}."telemetry_v1_device_consents" (
       participant_id, device_id, telemetry_schema_version,
       field_dictionary_version, privacy_contract_version, consented_at
     )
     SELECT $1, $2, $3, $4, $5, $6::timestamptz
      WHERE EXISTS (
        SELECT 1 FROM ${primary}."device_pairings" pairing
         WHERE pairing.id = $7 AND pairing.participant_id = $1
           AND pairing.state = 'consumed' AND pairing.claimed_device_id = $2
           AND pairing.transport_consent_version = $5
      ) AND EXISTS (
        SELECT 1 FROM ${primary}."device_credentials" device
         WHERE device.id = $2 AND device.participant_id = $1
           AND device.paired_via_pairing_id = $7
      )
     ON CONFLICT (participant_id, device_id) DO NOTHING
     RETURNING device_id`,
    [participantId, deviceId, INCREMENTAL_TELEMETRY_SCHEMA_VERSION,
      INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
      ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION, issuedAt, pairingId],
  );
  if (granted.rowCount !== 1 && granted.rowCount !== 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function claimWithContinuity(
  client: PostgresClient,
  primary: string,
  pairing: PairingRow,
  deviceId: string,
  replacementSecretHash: Uint8Array,
  previousDeviceAuthorization: string,
  nowEpoch: number,
  policy: DeviceLifecyclePolicy,
): Promise<PairingClaimResult> {
  const prior = parseDeviceAuthorization(previousDeviceAuthorization);
  if (prior.id !== deviceId) throw pairingUnauthorized();
  const presentedPriorHash = await deviceHash(prior.id, prior.secret);
  try {
    if (replacementSecretHash.every((value) => value === 0)
        || timingSafeEqual(presentedPriorHash, replacementSecretHash)) {
      throw new ApiError(400, "BODY_INVALID");
    }
    const now = new Date(nowEpoch).toISOString();
    const freshSince = new Date(nowEpoch - DEVICE_PAIRING_TTL_MILLISECONDS).toISOString();
    const device = await readDeviceForContinuity(
      client, primary, pairing, deviceId, now, freshSince, true,
    );
    if (!device) throw pairingUnauthorized();
    const currentSecretHash = byteView(device.secret_hash);
    const replacementHexHash = replacementSecretHash;

    if (pairing.state === "consumed" && pairing.claimed_device_id === deviceId) {
      const rotationResult = await client.query<RotationRow>(
        `SELECT prior_secret_hash, recovery_proof_hash, replacement_secret_hash
           FROM ${primary}."device_credential_rotations"
          WHERE device_id = $1 AND participant_id = $2 AND attempt_id = $3
            AND generation = $4 AND retire_at > $5::timestamptz
          LIMIT 1`,
        [deviceId, pairing.participant_id, pairing.id, device.credential_generation, now],
      );
      const rotation = rotationResult.rows[0];
      if (rotation && device.paired_via_pairing_id === pairing.id
          && (timingSafeEqual(presentedPriorHash, byteView(rotation.prior_secret_hash))
            || (rotation.recovery_proof_hash !== null
              && timingSafeEqual(presentedPriorHash, byteView(rotation.recovery_proof_hash))))
          && timingSafeEqual(replacementHexHash, byteView(rotation.replacement_secret_hash))) {
        const replay = await replayedPairingClaim(
          client, primary, pairing.id, deviceId, replacementSecretHash, now, nowEpoch,
        );
        if (replay) return replay;
      }
      throw pairingUnauthorized();
    }
    if (pairing.state !== "unused") throw pairingUnauthorized();

    let recoveryProofHash: Uint8Array | null = null;
    if (!timingSafeEqual(presentedPriorHash, currentSecretHash)) {
      const immediate = await client.query<{ prior_secret_hash: Uint8Array | ArrayBuffer }>(
        `SELECT prior_secret_hash
           FROM ${primary}."device_credential_rotations"
          WHERE device_id = $1 AND participant_id = $2 AND generation = $3
            AND replacement_secret_hash = $4 AND retire_at > $5::timestamptz
          LIMIT 1`,
        [deviceId, pairing.participant_id, device.credential_generation, currentSecretHash, now],
      );
      const priorRotation = immediate.rows[0];
      if (!priorRotation
          || !timingSafeEqual(presentedPriorHash, byteView(priorRotation.prior_secret_hash))) {
        throw pairingUnauthorized();
      }
      recoveryProofHash = presentedPriorHash;
    }
    if (timingSafeEqual(replacementSecretHash, currentSecretHash)) {
      throw new ApiError(400, "BODY_INVALID");
    }

    const claimWindow = new Date(nowEpoch - policy.pairingClaimWindowMilliseconds).toISOString();
    if (await claimWindowCount(client, primary, pairing.participant_id, claimWindow)
        >= policy.pairingClaimLimit) {
      throw pairingUnauthorized();
    }
    const expiresAt = new Date(nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS).toISOString();
    const retireAt = new Date(Math.max(
      nowEpoch + policy.rotationHistoryMilliseconds,
      Date.parse(expiresAt),
    )).toISOString();
    const generation = device.credential_generation + 1;
    const changed = await client.query(
      `UPDATE ${primary}."device_credentials"
          SET paired_via_pairing_id = $1, secret_hash = $2,
              expires_at = $3::timestamptz, last_used_at = $4::timestamptz,
              social_verified_at = $4::timestamptz, credential_generation = $5
        WHERE id = $6 AND participant_id = $7 AND state = 'active'
          AND secret_hash = $8 AND credential_generation = $9
          AND EXISTS (
            SELECT 1 FROM ${primary}."device_pairings" pairing
              JOIN ${primary}."participants" participant
                ON participant.id = pairing.participant_id
              JOIN ${primary}."web_sessions" session
                ON session.id = pairing.issued_by_session_id
               AND session.participant_id = pairing.participant_id
             WHERE pairing.id = $10 AND pairing.participant_id = $7
               AND pairing.state = 'unused' AND pairing.expires_at > $4::timestamptz
               AND participant.state = 'active'
               AND participant.consent_version IS NOT DISTINCT FROM $11
               AND session.scope = 'personal' AND session.state = 'active'
               AND session.expires_at > $4::timestamptz
               AND session.issued_at >= $12::timestamptz
               AND session.issued_at <= $4::timestamptz
          )
        RETURNING id`,
      [pairing.id, replacementSecretHash, expiresAt, now, generation, deviceId,
        pairing.participant_id, currentSecretHash, device.credential_generation,
        pairing.id, pairing.participant_consent_version, new Date(nowEpoch - DEVICE_PAIRING_TTL_MILLISECONDS).toISOString()],
    );
    if (changed.rowCount !== 1 || changed.rows[0]?.id !== deviceId) throw pairingUnauthorized();

    const rotationId = crypto.randomUUID();
    const rotation = await client.query(
      `INSERT INTO ${primary}."device_credential_rotations" (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at, recovery_proof_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10)
       RETURNING id`,
      [rotationId, deviceId, pairing.participant_id, currentSecretHash,
        replacementSecretHash, pairing.id, generation, now, retireAt, recoveryProofHash],
    );
    if (rotation.rowCount !== 1) throw pairingUnauthorized();
    const consumed = await client.query(
      `UPDATE ${primary}."device_pairings"
          SET state = 'consumed', consumed_at = $1::timestamptz,
              claimed_device_id = $2
        WHERE id = $3 AND participant_id = $4 AND state = 'unused'
          AND expires_at > $1::timestamptz
          AND EXISTS (
            SELECT 1 FROM ${primary}."device_credentials" device
             WHERE device.id = $2 AND device.participant_id = $4
               AND device.paired_via_pairing_id = $3
               AND device.secret_hash = $5 AND device.credential_generation = $6
          )
        RETURNING id`,
      [now, deviceId, pairing.id, pairing.participant_id, replacementSecretHash, generation],
    );
    if (consumed.rowCount !== 1 || consumed.rows[0]?.id !== pairing.id) throw pairingUnauthorized();
    await client.query(
      `UPDATE ${primary}."device_upload_authorizations"
          SET state = 'revoked', revoked_at = $1::timestamptz,
              consume_lease_expires_at = NULL
        WHERE issued_by_device_id = $2 AND participant_id = $3
          AND state IN ('unused', 'consuming')`,
      [now, deviceId, pairing.participant_id],
    );
    return Object.freeze({ deviceId, state: "active", scope: "upload_registration", expiresAt });
  } finally {
    presentedPriorHash.fill(0);
  }
}

export interface PostgresDevicePairingClaimOptions {
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
  readonly policy?: Partial<DeviceLifecyclePolicy>;
}

/**
 * Claim a one-use social pairing under the Worker-compatible credential
 * contract. A deleted participant's pairing rows are gone with it, so the
 * claim of a former owner is refused by ordinary authentication; there is no
 * deletion-ledger tombstone read (decisions D2, D4 and D6).
 */
export async function claimPostgresDevicePairing(
  primaryPool: PostgresPool,
  authorizationHeader: string | null,
  deviceId: string,
  deviceSecretHashHex: string,
  previousDeviceAuthorization: string | null = null,
  options: PostgresDevicePairingClaimOptions = {},
): Promise<PairingClaimResult> {
  // The retired second (deletion-ledger pool) argument shifted every later
  // one; a caller still passing a pool there is refused, not parsed.
  if (authorizationHeader !== null && typeof authorizationHeader !== "string") {
    throw new TypeError("POSTGRES_DEVICE_PAIRING_CLAIM_ARGUMENTS_INVALID");
  }
  if (!UUID_V4.test(deviceId)) throw new ApiError(400, "BODY_INVALID");
  const { id: pairingId, secret: pairingSecret } = parsePairingAuthorization(authorizationHeader);
  const replacementSecretHash = bytesFromHex(deviceSecretHashHex);
  const nowEpoch = options.nowEpoch ?? Date.now();
  if (!Number.isSafeInteger(nowEpoch) || !Number.isFinite(new Date(nowEpoch).getTime())) {
    replacementSecretHash.fill(0);
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const now = new Date(nowEpoch).toISOString();
  const policy = lifecyclePolicy(options.policy);
  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  const presentedPairingHash = await sha256(`app-usagemonitor/device-pairing/v1\0${pairingId}\0${pairingSecret}`);
  try {
    const preflight = await readPairing(primaryPool, primary, pairingId);
    verifyPairing(preflight, pairingId, presentedPairingHash, nowEpoch);

    try {
      return await withPostgresMutation(primaryPool, async (client) => {
      const pairing = await lockPairingOwnerAndRow(
        client, primary, preflight.participant_id, pairingId,
      );
      verifyPairing(pairing, pairingId, presentedPairingHash, nowEpoch);
      const claimWindow = new Date(nowEpoch - policy.pairingClaimWindowMilliseconds).toISOString();
      const freshSince = new Date(nowEpoch - DEVICE_PAIRING_TTL_MILLISECONDS).toISOString();

      if (previousDeviceAuthorization !== null) {
        return claimWithContinuity(
          client, primary, pairing, deviceId, replacementSecretHash,
          previousDeviceAuthorization, nowEpoch, policy,
        );
      }
      if (pairing.state === "consumed" && pairing.claimed_device_id === deviceId) {
        const replay = await replayedPairingClaim(
          client, primary, pairing.id, deviceId, replacementSecretHash, now, nowEpoch,
        );
        if (replay) return replay;
        if (await continuityIsRequired(
          client, primary, pairing, deviceId, replacementSecretHash, now, freshSince,
        )) throw new ApiError(409, "DEVICE_CONTINUITY_REQUIRED");
      }
      if (pairing.state !== "unused") throw pairingUnauthorized();
      if (await continuityIsRequired(
        client, primary, pairing, deviceId, replacementSecretHash, now, freshSince,
      )) throw new ApiError(409, "DEVICE_CONTINUITY_REQUIRED");

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ${primary}."device_credentials" WHERE id = $1 LIMIT 1`,
        [deviceId],
      );
      if (existing.rowCount !== 0) throw pairingUnauthorized();
      if (await claimWindowCount(client, primary, pairing.participant_id, claimWindow)
          >= policy.pairingClaimLimit) {
        throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      const idleCutoff = new Date(nowEpoch - policy.idleMilliseconds).toISOString();
      if (await deviceCapCount(client, primary, pairing.participant_id, now, idleCutoff)
          >= policy.activeDeviceLimit) throw pairingUnauthorized();

      const expiresAt = new Date(nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS).toISOString();
      const inserted = await client.query(
        `INSERT INTO ${primary}."device_credentials" (
           id, participant_id, authority_kind, paired_via_pairing_id,
           secret_hash, state, issued_at, expires_at, last_used_at,
           social_verified_at
         ) VALUES ($1,$2,'social',$3,$4,'active',$5::timestamptz,
                   $6::timestamptz,$5::timestamptz,$5::timestamptz)
         RETURNING id`,
        [deviceId, pairing.participant_id, pairing.id, replacementSecretHash, now, expiresAt],
      );
      if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== deviceId) throw pairingUnauthorized();
      const consumed = await client.query(
        `UPDATE ${primary}."device_pairings"
            SET state = 'consumed', consumed_at = $1::timestamptz,
                claimed_device_id = $2
          WHERE id = $3 AND participant_id = $4 AND state = 'unused'
            AND expires_at > $1::timestamptz
            AND EXISTS (
              SELECT 1 FROM ${primary}."participants" participant
               WHERE participant.id = $4 AND participant.state = 'active'
                 AND participant.owner_kind = 'social'
                 AND participant.consent_version IS NOT DISTINCT FROM $5
            )
            AND (SELECT count(*) FROM ${primary}."device_pairings" recent
                  WHERE recent.participant_id = $4 AND recent.state = 'consumed'
                    AND recent.consumed_at > $6::timestamptz) < $7
          RETURNING id`,
        [now, deviceId, pairing.id, pairing.participant_id,
          pairing.participant_consent_version, claimWindow, policy.pairingClaimLimit],
      );
      if (consumed.rowCount !== 1 || consumed.rows[0]?.id !== pairing.id) throw pairingUnauthorized();
      await insertIncrementalConsent(
        client, primary, pairing.id, pairing.participant_id, deviceId,
        now, pairing.transport_consent_version,
      );
      return Object.freeze({ deviceId, state: "active", scope: "upload_registration", expiresAt });
    }, {
      operation: "device_pairing.claim",
      statementTimeoutMilliseconds: 5_000,
      lockTimeoutMilliseconds: 2_000,
      preserveSafeError: (error) => {
        if (error instanceof ApiError) return error;
        if (typeof error === "object" && error !== null
            && "code" in error && error.code === "23505") return pairingUnauthorized();
        return null;
      },
      });
    } catch (error) {
      if (error instanceof ApiError || previousDeviceAuthorization !== null) throw error;
      // A lost commit acknowledgement is safe to recover only by proving the
      // exact same one-use pairing, device ID, and replacement-secret hash.
      try {
        const replay = await withPostgresRead(primaryPool, async (client) => {
          const current = await client.query<PairingRow>(pairingProjection(primary), [pairingId]);
          const row = current.rows[0] ?? null;
          try {
            verifyPairing(row, pairingId, presentedPairingHash, nowEpoch);
            return await replayedPairingClaim(
              client, primary, pairingId, deviceId, replacementSecretHash, now, nowEpoch,
            );
          } catch {
            return null;
          }
        }, {
          operation: "device_pairing.claim_replay",
          statementTimeoutMilliseconds: 3_000,
          lockTimeoutMilliseconds: 1_000,
        });
        if (replay !== null) return replay;
      } catch {
        // Preserve the original sanitized transaction failure.
      }
      throw error;
    }
  } finally {
    presentedPairingHash.fill(0);
    replacementSecretHash.fill(0);
  }
}
