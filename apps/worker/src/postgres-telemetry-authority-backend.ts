import { ApiError } from "./errors";
import { timingSafeEqual } from "./crypto";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V11_PRIVACY_CONTRACT_VERSION,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import type {
  AccountlessAuthorityStore,
  AccountlessEnrollmentMaterial,
  AccountlessEnrollmentRecord,
  AuthorityDeviceCredentialMaterial,
  AuthorityDevicePairingMaterial,
  AuthorityDeviceRecord,
  AuthorityDeviceUploadMaterial,
  AuthorityDeviceUploadRecord,
  AuthoritySessionMaterial,
  AuthoritySessionRecord,
  AuthoritySessionUploadMaterial,
  AuthoritySessionUploadRecord,
  DeviceAuthorityStore,
  IdentityAuthorityStore,
  IdentityParticipantMaterial,
  SessionAuthorityStore,
  SessionUploadAuthorityStore,
  TelemetryAuthorityBackend,
  TelemetryTransportSchemaVersion,
  TransportAuthorizationState,
  TransportCapabilities,
  TransportAuthorityStore,
} from "./telemetry-authority-backend";

/** Compatibility aliases; the shared client owns pool and transaction behavior. */
export type PostgresTelemetryAuthorityPool = PostgresPool;
export type PostgresTelemetryAuthorityClient = PostgresClient;
export type PostgresTelemetryAuthorityResult = PostgresQueryResult<Record<string, unknown>>;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function changes(result: PostgresTelemetryAuthorityResult): number {
  const count = result.rowCount;
  if (count === null || !Number.isSafeInteger(count) || count < 0) throw unavailable();
  return count;
}

function rowOne<T>(result: PostgresTelemetryAuthorityResult): T {
  if (result.rowCount !== 1 || result.rows.length !== 1 || !result.rows[0]) throw unavailable();
  return result.rows[0] as T;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw unavailable();
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  throw unavailable();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value
    : typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value)
    : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value) ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(number)) throw unavailable();
  if (typeof value === "string" && String(number) !== value) throw unavailable();
  return number;
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") return code;
    const state = Reflect.get(error, "sqlState");
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  switch (sqlState(error)) {
    case "P1001": return new ApiError(409, "PARTICIPANT_DELETING");
    case "P1002": return new ApiError(401, "UPLOAD_AUTH_INVALID");
    case "P1003": return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED");
    case "P1004": return new ApiError(409, "RECORD_OWNED_BY_OTHER_CHUNK");
    case "P1005": return new ApiError(409, "CHUNK_REVISION_CONFLICT");
    case "P1006": return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
    case "P1007": return new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
    default: return unavailable();
  }
}

function readTransaction<T>(
  pool: PostgresTelemetryAuthorityPool,
  operation: (client: PostgresTelemetryAuthorityClient) => Promise<T>,
  operationName = "authority.read",
): Promise<T> {
  return withPostgresRead(pool, operation, {
    operation: operationName,
    preserveSafeError: mapError,
  });
}

function mutate<T>(
  pool: PostgresTelemetryAuthorityPool,
  operation: (client: PostgresTelemetryAuthorityClient) => Promise<T>,
  operationName = "authority.mutation",
): Promise<T> {
  return withPostgresMutation(pool, operation, {
    operation: operationName,
    preserveSafeError: mapError,
  });
}

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function sessionRow(row: Record<string, unknown>): AuthoritySessionRecord {
  const scope = row.session_scope;
  const state = row.session_state;
  const participantState = row.participant_state;
  if ((scope !== "personal" && scope !== "deletion_only")
      || (state !== "active" && state !== "revoked")
      || (participantState !== "active" && participantState !== "deleting")) throw unavailable();
  return {
    id: stringValue(row.session_id), participantId: stringValue(row.participant_id),
    secretHash: bytes(row.secret_hash), csrfHash: bytes(row.csrf_hash), scope,
    issuedAt: stringValue(row.issued_at), expiresAt: stringValue(row.expires_at), state,
    participantCreatedAt: stringValue(row.participant_created_at), participantState,
    consentVersion: stringValue(row.consent_version), lastUsedAt: stringValue(row.last_used_at),
  };
}

function sessionUploadRow(row: Record<string, unknown>): AuthoritySessionUploadRecord {
  const state = row.state;
  const participantState = row.participant_state;
  const sessionState = row.issuing_session_state;
  if (!["unused", "consuming", "consumed", "revoked"].includes(String(state))
      || (participantState !== "active" && participantState !== "deleting")
      || (sessionState !== "active" && sessionState !== "revoked")) throw unavailable();
  if (row.content_type !== "application/json") throw unavailable();
  return {
    id: stringValue(row.id), participantId: stringValue(row.participant_id),
    issuedBySessionId: stringValue(row.issued_by_session_id), secretHash: bytes(row.secret_hash),
    envelopeDigest: stringValue(row.envelope_digest), bodyBytes: numberValue(row.body_bytes),
    contentType: "application/json", issuedAt: stringValue(row.issued_at), expiresAt: stringValue(row.expires_at),
    state: state as AuthoritySessionUploadRecord["state"],
    consumeLeaseExpiresAt: nullableString(row.consume_lease_expires_at),
    consumedAt: nullableString(row.consumed_at), consumedContributionId: nullableString(row.consumed_contribution_id),
    participantState, issuingSessionState: sessionState,
    issuingSessionExpiresAt: stringValue(row.issuing_session_expires_at),
  };
}

function deviceRow(row: Record<string, unknown>): AuthorityDeviceRecord {
  const state = row.device_state;
  const participantState = row.participant_state;
  const ownerKind = row.owner_kind;
  const authorityKind = row.authority_kind;
  if ((state !== "active" && state !== "revoked")
      || (participantState !== "active" && participantState !== "deleting")
      || (ownerKind !== "social" && ownerKind !== "accountless")
      || (authorityKind !== "social" && authorityKind !== "accountless")) throw unavailable();
  const accountlessState = (value: unknown): "active" | "revoked" | null =>
    value === "active" || value === "revoked" ? value : null;
  return {
    id: stringValue(row.device_id), participantId: stringValue(row.participant_id),
    pairingId: stringValue(row.paired_via_pairing_id), secretHash: bytes(row.secret_hash),
    issuedAt: stringValue(row.issued_at), expiresAt: stringValue(row.expires_at),
    lastUsedAt: stringValue(row.last_used_at), socialVerifiedAt: nullableString(row.social_verified_at),
    credentialGeneration: numberValue(row.credential_generation), state, revokedAt: nullableString(row.revoked_at),
    participantState, participantConsentVersion: nullableString(row.participant_consent_version),
    ownerKind, authorityKind, accountlessEnrollmentDeviceId: nullableString(row.accountless_enrollment_device_id),
    accountlessLedgerState: accountlessState(row.accountless_ledger_state),
    accountlessLedgerExpiresAt: nullableString(row.accountless_ledger_expires_at),
    accountlessOwnerState: accountlessState(row.accountless_owner_state),
    accountlessOwnerExpiresAt: nullableString(row.accountless_owner_expires_at),
    accountlessAuthorizationState: accountlessState(row.accountless_authorization_state),
    accountlessAuthorizationExpiresAt: nullableString(row.accountless_authorization_expires_at),
  };
}

function deviceUploadRow(row: Record<string, unknown>): AuthorityDeviceUploadRecord {
  const state = row.state;
  const deviceState = row.device_state;
  const participantState = row.participant_state;
  if (!["unused", "consuming", "consumed", "revoked"].includes(String(state))
      || (deviceState !== "active" && deviceState !== "revoked")
      || (participantState !== "active" && participantState !== "deleting")
      || row.content_type !== "application/json") throw unavailable();
  return {
    id: stringValue(row.id), participantId: stringValue(row.participant_id),
    issuedByDeviceId: stringValue(row.issued_by_device_id), secretHash: bytes(row.secret_hash),
    envelopeDigest: stringValue(row.envelope_digest), bodyBytes: numberValue(row.body_bytes),
    contentType: "application/json", issuedAt: stringValue(row.issued_at), expiresAt: stringValue(row.expires_at),
    state: state as AuthorityDeviceUploadRecord["state"],
    consumeLeaseExpiresAt: nullableString(row.consume_lease_expires_at),
    consumedAt: nullableString(row.consumed_at), consumedContributionId: nullableString(row.consumed_contribution_id),
    deviceState, deviceExpiresAt: stringValue(row.device_expires_at), participantState,
  };
}

function enrollmentRow(row: Record<string, unknown>): AccountlessEnrollmentRecord {
  const state = row.state;
  if (state !== "active" && state !== "revoked") throw unavailable();
  return {
    deviceId: stringValue(row.device_id), deviceSecretHash: bytes(row.device_secret_hash),
    installationPrincipalId: stringValue(row.installation_principal_id), schemaVersion: stringValue(row.schema_version),
    policyVersion: stringValue(row.policy_version), authorizationBasis: stringValue(row.authorization_basis),
    issuedAt: stringValue(row.issued_at), expiresAt: stringValue(row.expires_at), state,
    revokedAt: nullableString(row.revoked_at), revocationReason: nullableString(row.revocation_reason),
  };
}

export function createPostgresTelemetryAuthorityBackend(
  pool: PostgresTelemetryAuthorityPool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryAuthorityBackend {
  const schema = createPostgresSchemaConfig(schemaOptions);
  const primary = quotePostgresIdentifier(schema.primarySchema);
  const table = (name: string): string => `${primary}.${quotePostgresIdentifier(name)}`;
  const tables = Object.freeze({
    participants: table("participants"),
    webSessions: table("web_sessions"),
    uploadAuthorizations: table("upload_authorizations"),
    devicePairings: table("device_pairings"),
    deviceCredentials: table("device_credentials"),
    deviceUploadAuthorizations: table("device_upload_authorizations"),
    accountlessEnrollmentLedger: table("accountless_enrollment_ledger"),
    accountlessUploadOwners: table("accountless_upload_owners"),
    accountlessV11DeviceAuthorizations: table("accountless_v11_device_authorizations"),
    accountlessV12DeviceAuthorizations: table("accountless_v12_device_authorizations"),
    telemetryV11DeviceConsents: table("telemetry_v11_device_consents"),
    telemetryV12DeviceCapabilities: table("telemetry_v12_device_capabilities"),
    telemetryTransportDeviceFloors: table("telemetry_transport_device_floors"),
    telemetryTransportParticipantFloors: table("telemetry_transport_participant_floors"),
    telemetryTransportFormats: table("telemetry_transport_formats"),
    telemetryV12Runtime: table("telemetry_v12_runtime"),
    telemetryContributions: table("telemetry_contributions"),
    attributionEnrollments: table("attribution_enrollments"),
  });

  // Lock authority rows before evaluating lifecycle predicates.  PostgreSQL
  // can wait for an UPDATE target while joined rows remain visible from the
  // statement snapshot; locking the participant/session/device first makes a
  // revoke or expiry that wins the wait visible to the guarded mutation.
  const lockParticipant = async (
    client: PostgresTelemetryAuthorityClient,
    participantId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT id FROM ${tables.participants} WHERE id = $1 FOR UPDATE`, [participantId],
  )).rowCount === 1;
  const lockSessionAuthority = async (
    client: PostgresTelemetryAuthorityClient,
    participantId: string,
    sessionId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT p.id, s.id AS session_id FROM ${tables.participants} p
      JOIN ${tables.webSessions} s ON s.participant_id = p.id
      WHERE p.id = $1 AND s.id = $2 FOR UPDATE OF p, s`, [participantId, sessionId],
  )).rowCount === 1;
  const lockSessionUpload = async (
    client: PostgresTelemetryAuthorityClient,
    authorizationId: string,
    participantId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT p.id, s.id AS session_id, u.id AS authorization_id
       FROM ${tables.uploadAuthorizations} u
       JOIN ${tables.participants} p ON p.id = u.participant_id
       JOIN ${tables.webSessions} s ON s.id = u.issued_by_session_id
      WHERE u.id = $1 AND u.participant_id = $2 FOR UPDATE OF p, s, u`,
    [authorizationId, participantId],
  )).rowCount === 1;
  const lockDevice = async (
    client: PostgresTelemetryAuthorityClient,
    participantId: string,
    deviceId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT p.id, d.id AS device_id FROM ${tables.participants} p
       JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
      WHERE p.id = $1 AND d.id = $2 FOR UPDATE OF p, d`, [participantId, deviceId],
  )).rowCount === 1;
  const lockPairing = async (
    client: PostgresTelemetryAuthorityClient,
    participantId: string,
    pairingId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT p.id, pairing.id AS pairing_id FROM ${tables.participants} p
       JOIN ${tables.devicePairings} pairing ON pairing.participant_id = p.id
      WHERE p.id = $1 AND pairing.id = $2 FOR UPDATE OF p, pairing`,
    [participantId, pairingId],
  )).rowCount === 1;
  const lockDeviceUpload = async (
    client: PostgresTelemetryAuthorityClient,
    authorizationId: string,
    participantId: string,
    deviceId: string,
  ): Promise<boolean> => (await client.query(
    `SELECT p.id, d.id AS device_id, u.id AS authorization_id
       FROM ${tables.deviceUploadAuthorizations} u
       JOIN ${tables.participants} p ON p.id = u.participant_id
       JOIN ${tables.deviceCredentials} d ON d.id = u.issued_by_device_id
      WHERE u.id = $1 AND u.participant_id = $2 AND u.issued_by_device_id = $3
      FOR UPDATE OF p, d, u`, [authorizationId, participantId, deviceId],
  )).rowCount === 1;
  const sessions: SessionAuthorityStore = {
    async insert(material): Promise<void> {
      const snapshot = {
        id: material.id, participantId: material.participantId, secretHash: copyBytes(material.secretHash),
        csrfHash: copyBytes(material.csrfHash), scope: material.scope, issuedAt: material.issuedAt, expiresAt: material.expiresAt,
      };
      await mutate(pool, async (client) => {
        if (!await lockParticipant(client, snapshot.participantId)) throw unavailable();
        const result = await client.query(`INSERT INTO ${tables.webSessions} (
          id, participant_id, secret_hash, csrf_hash, scope, state,
          issued_at, expires_at, last_used_at
        ) SELECT $1, $2, $3, $4, $5, 'active', $6, $7, $6
          WHERE EXISTS (SELECT 1 FROM ${tables.participants} p
            WHERE p.id = $2 AND ((p.state = 'active' AND $5 = 'personal')
              OR (p.state = 'deleting' AND $5 = 'deletion_only' AND p.deletion_session_id = $1)))`, [
          snapshot.id, snapshot.participantId, snapshot.secretHash, snapshot.csrfHash,
          snapshot.scope, snapshot.issuedAt, snapshot.expiresAt,
        ]);
        if (changes(result) !== 1) throw unavailable();
        return undefined;
      });
    },
    async read(sessionId): Promise<AuthoritySessionRecord | null> {
      const snapshot = String(sessionId);
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT
          s.id AS session_id, s.participant_id, s.secret_hash, s.csrf_hash,
          s.scope AS session_scope, s.state AS session_state, s.issued_at,
          s.expires_at, s.last_used_at, p.created_at AS participant_created_at,
          p.state AS participant_state, p.consent_version
        FROM ${tables.webSessions} s JOIN ${tables.participants} p ON p.id = s.participant_id WHERE s.id = $1`, [snapshot]);
        if (result.rowCount === 0) return null;
        return sessionRow(rowOne(result));
      }, "authority.sessions.read");
    },
    async touch(sessionId, now): Promise<boolean> {
      return mutate(pool, async (client) => {
        const locked = await client.query(`SELECT p.id, s.id AS session_id
          FROM ${tables.webSessions} s JOIN ${tables.participants} p ON p.id = s.participant_id
          WHERE s.id = $1 FOR UPDATE OF p, s`, [sessionId]);
        if (locked.rowCount !== 1) return false;
        return changes(await client.query(`UPDATE ${tables.webSessions}
          SET last_used_at = $1 WHERE id = $2 AND state = 'active'`, [now, sessionId])) === 1;
      });
    },
    async revoke(sessionId, now): Promise<boolean> {
      return mutate(pool, async (client) => {
        const locked = await client.query(`SELECT p.id, s.id AS session_id
          FROM ${tables.webSessions} s JOIN ${tables.participants} p ON p.id = s.participant_id
          WHERE s.id = $1 FOR UPDATE OF p, s`, [sessionId]);
        if (locked.rowCount !== 1) return false;
        return changes(await client.query(`UPDATE ${tables.webSessions}
          SET state = 'revoked', revoked_at = $1 WHERE id = $2 AND state = 'active'`, [now, sessionId])) === 1;
      });
    },
  };

  const sessionUploads: SessionUploadAuthorityStore = {
    async insert(material): Promise<void> {
      const snapshot = { ...material, secretHash: copyBytes(material.secretHash) };
      await mutate(pool, async (client) => {
        if (!await lockSessionAuthority(client, snapshot.participantId, snapshot.issuedBySessionId)) {
          throw unavailable();
        }
        const result = await client.query(`INSERT INTO ${tables.uploadAuthorizations} (
          id, participant_id, issued_by_session_id, secret_hash, envelope_digest,
          body_bytes, content_type, state, issued_at, expires_at
        ) SELECT $1, $2, $3, $4, $5, $6, $7, 'unused', $8, $9
          WHERE EXISTS (SELECT 1 FROM ${tables.participants} p
            JOIN ${tables.webSessions} s ON s.participant_id = p.id
            WHERE p.id = $2 AND p.state = 'active' AND s.id = $3
              AND s.scope = 'personal' AND s.state = 'active'
              AND s.expires_at > clock_timestamp())`, [
          snapshot.id, snapshot.participantId, snapshot.issuedBySessionId, snapshot.secretHash,
          snapshot.envelopeDigest, snapshot.bodyBytes, snapshot.contentType, snapshot.issuedAt, snapshot.expiresAt,
        ]);
        if (changes(result) !== 1) throw unavailable();
        return undefined;
      });
    },
    async read(authorizationId): Promise<AuthoritySessionUploadRecord | null> {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT u.*, p.state AS participant_state,
          s.state AS issuing_session_state, s.expires_at AS issuing_session_expires_at
          FROM ${tables.uploadAuthorizations} u JOIN ${tables.participants} p ON p.id = u.participant_id
          JOIN ${tables.webSessions} s ON s.id = u.issued_by_session_id WHERE u.id = $1`, [authorizationId]);
        return result.rowCount === 0 ? null : sessionUploadRow(rowOne(result));
      }, "authority.session-uploads.read");
    },
    async claim(input): Promise<string | null> {
      const snapshot = { ...input };
      return mutate(pool, async (client) => {
        if (!await lockSessionUpload(client, snapshot.authorizationId, snapshot.participantId)) return null;
        const result = await client.query(`UPDATE ${tables.uploadAuthorizations} AS u
        SET state = 'consuming', consume_lease_expires_at = $1
        FROM ${tables.participants} p, ${tables.webSessions} s
        WHERE u.id = $2 AND u.participant_id = $3
          AND p.id = u.participant_id AND p.state = 'active'
          AND s.id = u.issued_by_session_id
          AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > clock_timestamp()
          AND u.state IN ('unused', 'consuming')
          AND (u.state = 'unused' OR u.consume_lease_expires_at <= clock_timestamp())
          AND u.envelope_digest = $4 AND u.body_bytes = $5
          AND u.content_type = $6 AND u.expires_at > clock_timestamp()
          AND $1::timestamptz > clock_timestamp()
          RETURNING consume_lease_expires_at`, [
        snapshot.leaseExpiresAt, snapshot.authorizationId, snapshot.participantId,
          snapshot.envelopeDigest, snapshot.bodyBytes, snapshot.contentType,
        ]);
        const lease = result.rows[0]?.consume_lease_expires_at;
        return lease === null || lease === undefined ? null : stringValue(lease);
      });
    },
    async recordReceipt(input): Promise<boolean> {
      const snapshot = { ...input };
      return mutate(pool, async (client) => {
        if (!await lockSessionUpload(client, snapshot.authorizationId, snapshot.participantId)) return false;
        const result = await client.query(`UPDATE ${tables.uploadAuthorizations} AS u
          SET state = 'consumed', consumed_at = clock_timestamp(), consumed_contribution_id = $1,
              consume_lease_expires_at = NULL
          FROM ${tables.participants} p, ${tables.webSessions} s
          WHERE u.id = $2 AND u.participant_id = $3
            AND p.id = u.participant_id AND p.state = 'active'
            AND s.id = u.issued_by_session_id
            AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > clock_timestamp()
            AND u.state = 'consuming'
            AND u.consume_lease_expires_at = $4
            AND u.consume_lease_expires_at > clock_timestamp()
            AND u.expires_at > clock_timestamp()`, [
          snapshot.contributionId, snapshot.authorizationId, snapshot.participantId, snapshot.leaseExpiresAt,
        ]);
        if (changes(result) === 1) return true;
        const current = await client.query(`SELECT state, consumed_contribution_id FROM ${tables.uploadAuthorizations}
          WHERE id = $1 AND participant_id = $2`, [snapshot.authorizationId, snapshot.participantId]);
        if (current.rowCount !== 1) return false;
        return current.rows[0]?.state === "consumed"
          && current.rows[0]?.consumed_contribution_id === snapshot.contributionId;
      });
    },
    async abandon(input): Promise<boolean> {
      const snapshot = { ...input };
      const owner = snapshot.participantId ? " AND participant_id = $4" : "";
      const values = snapshot.participantId
        ? [snapshot.now, snapshot.authorizationId, snapshot.leaseExpiresAt, snapshot.participantId]
        : [snapshot.now, snapshot.authorizationId, snapshot.leaseExpiresAt];
      return mutate(pool, async (client) => changes(await client.query(`UPDATE ${tables.uploadAuthorizations}
        SET state = 'revoked', revoked_at = $1, consume_lease_expires_at = NULL
        WHERE id = $2 AND state = 'consuming' AND consume_lease_expires_at = $3${owner}`, values)) === 1);
    },
  };

  const devices: DeviceAuthorityStore = {
    async insertPairing(material): Promise<void> {
      const snapshot = { ...material, secretHash: copyBytes(material.secretHash) };
      await mutate(pool, async (client) => {
        if (!await lockSessionAuthority(client, snapshot.participantId, snapshot.issuedBySessionId)) {
          throw unavailable();
        }
        const result = await client.query(`INSERT INTO ${tables.devicePairings} (
          id, participant_id, issued_by_session_id, secret_hash, consent_version,
          transport_consent_version, state, issued_at, expires_at
        ) SELECT $1, $2, $3, $4, $5, $6, 'unused', $7, $8
          WHERE EXISTS (SELECT 1 FROM ${tables.participants} p
            JOIN ${tables.webSessions} s ON s.participant_id = p.id
            WHERE p.id = $2 AND p.state = 'active' AND s.id = $3
              AND s.scope = 'personal' AND s.state = 'active'
              AND s.expires_at > clock_timestamp())`, [
          snapshot.id, snapshot.participantId, snapshot.issuedBySessionId, snapshot.secretHash,
          snapshot.consentVersion, snapshot.transportConsentVersion, snapshot.issuedAt, snapshot.expiresAt,
        ]);
        if (changes(result) !== 1) throw unavailable();
        return undefined;
      });
    },
    async readPairing(pairingId) {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT pairing.id, pairing.participant_id, pairing.secret_hash,
          pairing.consent_version, pairing.transport_consent_version, pairing.state, pairing.issued_at,
          pairing.expires_at, pairing.claimed_device_id, participant.state AS participant_state
          FROM ${tables.devicePairings} pairing JOIN ${tables.participants} participant ON participant.id = pairing.participant_id
          WHERE pairing.id = $1`, [pairingId]);
        if (result.rowCount === 0) return null;
        const row = rowOne<Record<string, unknown>>(result);
        if (!["unused", "consumed", "revoked"].includes(String(row.state))
            || (row.participant_state !== "active" && row.participant_state !== "deleting")) throw unavailable();
        return {
          id: stringValue(row.id), participantId: stringValue(row.participant_id), secretHash: bytes(row.secret_hash),
          consentVersion: stringValue(row.consent_version), transportConsentVersion: stringValue(row.transport_consent_version),
          state: row.state as "unused" | "consumed" | "revoked", issuedAt: stringValue(row.issued_at),
          expiresAt: stringValue(row.expires_at), claimedDeviceId: nullableString(row.claimed_device_id),
          participantState: row.participant_state as "active" | "deleting",
        };
      }, "authority.device-pairings.read");
    },
    async claimPairing(input): Promise<boolean> {
      const snapshot = { ...input, device: { ...input.device, secretHash: copyBytes(input.device.secretHash) } };
      return mutate(pool, async (client) => {
        if (!await lockPairing(client, snapshot.participantId, snapshot.device.pairingId)) return false;
        const result = await client.query(`WITH consumed AS (
          UPDATE ${tables.devicePairings} pairing
             SET state = 'consumed', consumed_at = clock_timestamp(), claimed_device_id = $1
            FROM ${tables.participants} participant
           WHERE pairing.id = $2 AND pairing.participant_id = $3 AND pairing.state = 'unused'
             AND pairing.expires_at > clock_timestamp() AND participant.id = pairing.participant_id
             AND participant.state = 'active'
           RETURNING pairing.id, pairing.participant_id
        ) INSERT INTO ${tables.deviceCredentials} (
          id, participant_id, paired_via_pairing_id, secret_hash, state,
          issued_at, expires_at, last_used_at, social_verified_at, credential_generation
        ) SELECT $1, $3, $2, $4, 'active', $5, $6, $7, $8, $9
          FROM consumed RETURNING id`, [
          snapshot.device.id, snapshot.device.pairingId, snapshot.participantId, snapshot.device.secretHash,
          snapshot.device.issuedAt, snapshot.device.expiresAt, snapshot.device.lastUsedAt,
          snapshot.device.socialVerifiedAt, snapshot.device.credentialGeneration,
        ]);
        return changes(result) === 1;
      });
    },
    async readDevice(deviceId): Promise<AuthorityDeviceRecord | null> {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT d.id AS device_id, d.participant_id,
          d.paired_via_pairing_id, d.secret_hash, d.state AS device_state, d.issued_at,
          d.expires_at, d.last_used_at, d.social_verified_at, d.credential_generation, d.revoked_at,
          p.state AS participant_state, p.consent_version AS participant_consent_version,
          p.owner_kind, d.authority_kind, d.accountless_enrollment_device_id,
          ledger.state AS accountless_ledger_state, ledger.expires_at AS accountless_ledger_expires_at,
          owner.state AS accountless_owner_state, owner.expires_at AS accountless_owner_expires_at,
          grant_row.state AS accountless_authorization_state, grant_row.expires_at AS accountless_authorization_expires_at
        FROM ${tables.deviceCredentials} d JOIN ${tables.participants} p ON p.id = d.participant_id
        LEFT JOIN ${tables.accountlessEnrollmentLedger} ledger ON ledger.device_id = d.accountless_enrollment_device_id
        LEFT JOIN ${tables.accountlessUploadOwners} owner ON owner.enrollment_device_id = ledger.device_id
          AND owner.participant_id = p.id AND owner.device_credential_id = d.id
        LEFT JOIN ${tables.accountlessV11DeviceAuthorizations} grant_row ON grant_row.enrollment_device_id = ledger.device_id
          AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
        WHERE d.id = $1`, [deviceId]);
        return result.rowCount === 0 ? null : deviceRow(rowOne(result));
      }, "authority.devices.read");
    },
    async touchDevice(input): Promise<boolean> {
      return mutate(pool, async (client) => {
        const owner = await client.query(`SELECT p.id, d.id AS device_id
          FROM ${tables.deviceCredentials} d JOIN ${tables.participants} p ON p.id = d.participant_id
          WHERE d.id = $1 FOR UPDATE OF p, d`, [input.deviceId]);
        if (owner.rowCount !== 1) return false;
        return changes(await client.query(`UPDATE ${tables.deviceCredentials} AS d
          SET last_used_at = $1, expires_at = $2
          WHERE d.id = $3 AND d.state = 'active' AND d.expires_at > $1
            AND EXISTS (SELECT 1 FROM ${tables.participants} p WHERE p.id = d.participant_id AND p.state = 'active')`,
        [input.now, input.expiresAt, input.deviceId])) === 1;
      });
    },
    async revokeDevice(input): Promise<boolean> {
      return mutate(pool, async (client) => {
        if (!await lockDevice(client, input.participantId, input.deviceId)) return false;
        return changes(await client.query(`UPDATE ${tables.deviceCredentials} AS d
          SET state = 'revoked', revoked_at = $1
          WHERE d.id = $2 AND d.participant_id = $3 AND d.state = 'active'`,
        [input.now, input.deviceId, input.participantId])) === 1;
      });
    },
    async insertUpload(material): Promise<void> {
      const snapshot = { ...material, secretHash: copyBytes(material.secretHash) };
      await mutate(pool, async (client) => {
        if (!await lockDevice(client, snapshot.participantId, snapshot.issuedByDeviceId)) {
          throw unavailable();
        }
        const result = await client.query(`INSERT INTO ${tables.deviceUploadAuthorizations} (
          id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
          body_bytes, content_type, state, issued_at, expires_at
        ) SELECT $1, $2, $3, $4, $5, $6, $7, 'unused', $8, $9
          WHERE EXISTS (SELECT 1 FROM ${tables.participants} p
            JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
            WHERE p.id = $2 AND p.state = 'active' AND d.id = $3
              AND d.state = 'active' AND d.expires_at > clock_timestamp())`, [
          snapshot.id, snapshot.participantId, snapshot.issuedByDeviceId, snapshot.secretHash,
          snapshot.envelopeDigest, snapshot.bodyBytes, snapshot.contentType, snapshot.issuedAt, snapshot.expiresAt,
        ]);
        if (changes(result) !== 1) throw unavailable();
        return undefined;
      });
    },
    async readUpload(authorizationId): Promise<AuthorityDeviceUploadRecord | null> {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT u.*, d.state AS device_state,
          d.expires_at AS device_expires_at, p.state AS participant_state
          FROM ${tables.deviceUploadAuthorizations} u JOIN ${tables.deviceCredentials} d ON d.id = u.issued_by_device_id
          JOIN ${tables.participants} p ON p.id = u.participant_id WHERE u.id = $1`, [authorizationId]);
        return result.rowCount === 0 ? null : deviceUploadRow(rowOne(result));
      }, "authority.device-uploads.read");
    },
    async claimUpload(input): Promise<string | null> {
      const snapshot = { ...input };
      return mutate(pool, async (client) => {
        if (!await lockDeviceUpload(client, snapshot.authorizationId, snapshot.participantId, snapshot.deviceId)) return null;
        const result = await client.query(`UPDATE ${tables.deviceUploadAuthorizations} AS u
        SET state = 'consuming', consume_lease_expires_at = $1
        FROM ${tables.deviceCredentials} d, ${tables.participants} p
        WHERE u.id = $2 AND u.participant_id = $3
          AND u.issued_by_device_id = $4
          AND d.id = u.issued_by_device_id AND d.state = 'active'
          AND p.id = d.participant_id
          AND d.expires_at > clock_timestamp() AND p.id = u.participant_id
          AND p.state = 'active' AND u.state IN ('unused', 'consuming')
          AND (u.state = 'unused' OR u.consume_lease_expires_at <= clock_timestamp())
          AND u.envelope_digest = $5
          AND u.body_bytes = $6
          AND u.content_type = $7
          AND u.expires_at > clock_timestamp()
          AND $1::timestamptz > clock_timestamp()
          RETURNING consume_lease_expires_at`, [
        snapshot.leaseExpiresAt, snapshot.authorizationId, snapshot.participantId, snapshot.deviceId,
          snapshot.envelopeDigest, snapshot.bodyBytes, snapshot.contentType,
        ]);
        const lease = result.rows[0]?.consume_lease_expires_at;
        return lease === null || lease === undefined ? null : stringValue(lease);
      });
    },
    async recordUploadReceipt(input): Promise<boolean> {
      const snapshot = { ...input };
      return mutate(pool, async (client) => {
        if (!await lockDeviceUpload(client, snapshot.authorizationId, snapshot.participantId, snapshot.deviceId)) return false;
        const result = await client.query(`UPDATE ${tables.deviceUploadAuthorizations} AS u
          SET state = 'consumed', consumed_at = clock_timestamp(), consumed_contribution_id = $1,
            consume_lease_expires_at = NULL
          FROM ${tables.deviceCredentials} d, ${tables.participants} p
          WHERE u.id = $2
            AND u.participant_id = $3
            AND u.issued_by_device_id = $4
            AND d.id = u.issued_by_device_id AND d.state = 'active'
            AND p.id = d.participant_id
            AND d.expires_at > clock_timestamp() AND p.id = u.participant_id
            AND p.state = 'active' AND u.state = 'consuming'
            AND u.consume_lease_expires_at = $5
            AND u.consume_lease_expires_at > clock_timestamp()
            AND u.expires_at > clock_timestamp()`, [
          snapshot.contributionId, snapshot.authorizationId, snapshot.participantId,
          snapshot.deviceId, snapshot.leaseExpiresAt,
        ]);
        if (changes(result) === 1) return true;
        const current = await client.query(`SELECT state, consumed_contribution_id
          FROM ${tables.deviceUploadAuthorizations} WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3`, [
          snapshot.authorizationId, snapshot.participantId, snapshot.deviceId,
        ]);
        return current.rowCount === 1 && current.rows[0]?.state === "consumed"
          && current.rows[0]?.consumed_contribution_id === snapshot.contributionId;
      });
    },
    async abandonUpload(input): Promise<boolean> {
      const snapshot = { ...input };
      const owner = snapshot.participantId ? " AND participant_id = $4" : "";
      const values = snapshot.participantId
        ? [snapshot.now, snapshot.authorizationId, snapshot.leaseExpiresAt, snapshot.participantId]
        : [snapshot.now, snapshot.authorizationId, snapshot.leaseExpiresAt];
      return mutate(pool, async (client) => changes(await client.query(`UPDATE ${tables.deviceUploadAuthorizations}
        SET state = 'revoked', revoked_at = $1, consume_lease_expires_at = NULL
        WHERE id = $2 AND state = 'consuming' AND consume_lease_expires_at = $3${owner}`, values)) === 1);
    },
  };

  const accountless: AccountlessAuthorityStore = {
    async read(deviceId): Promise<AccountlessEnrollmentRecord | null> {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT device_id, device_secret_hash, installation_principal_id,
          schema_version, policy_version, authorization_basis, state, issued_at, expires_at, revoked_at, revocation_reason
          FROM ${tables.accountlessEnrollmentLedger} WHERE device_id = $1`, [deviceId]);
        return result.rowCount === 0 ? null : enrollmentRow(rowOne(result));
      }, "authority.accountless.read");
    },
    async enroll(material): Promise<{created: boolean; record: AccountlessEnrollmentRecord}> {
      const snapshot = { ...material, deviceSecretHash: copyBytes(material.deviceSecretHash) };
      return mutate(pool, async (client) => {
        const inserted = await client.query(`INSERT INTO ${tables.accountlessEnrollmentLedger} (
          device_id, device_secret_hash, installation_principal_id, schema_version, policy_version,
          authorization_basis, state, issued_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
        ON CONFLICT (device_id) DO NOTHING
        RETURNING device_id, device_secret_hash, installation_principal_id, schema_version, policy_version,
          authorization_basis, state, issued_at, expires_at, revoked_at, revocation_reason`, [
          snapshot.deviceId, snapshot.deviceSecretHash, snapshot.installationPrincipalId, snapshot.schemaVersion,
          snapshot.policyVersion, snapshot.authorizationBasis, snapshot.issuedAt, snapshot.expiresAt,
        ]);
        if (inserted.rowCount === 1) return { created: true, record: enrollmentRow(rowOne(inserted)) };
        const existing = await client.query(`SELECT device_id, device_secret_hash, installation_principal_id,
          schema_version, policy_version, authorization_basis, state, issued_at, expires_at, revoked_at, revocation_reason
          FROM ${tables.accountlessEnrollmentLedger} WHERE device_id = $1 FOR UPDATE`, [snapshot.deviceId]);
        if (existing.rowCount !== 1) throw unavailable();
        const record = enrollmentRow(rowOne(existing));
        if (!timingSafeEqual(record.deviceSecretHash, snapshot.deviceSecretHash)
            || record.installationPrincipalId !== snapshot.installationPrincipalId
            || record.schemaVersion !== snapshot.schemaVersion || record.policyVersion !== snapshot.policyVersion
            || record.authorizationBasis !== snapshot.authorizationBasis) throw new ApiError(409, "ACCOUNTLESS_ENROLLMENT_CONFLICT");
        return { created: false, record };
      });
    },
    async revoke(input): Promise<boolean> {
      return mutate(pool, async (client) => changes(await client.query(`UPDATE ${tables.accountlessEnrollmentLedger}
        SET state = 'revoked', revoked_at = $1, revocation_reason = $2
        WHERE device_id = $3 AND state = 'active'`, [input.now, input.reason, input.deviceId])) === 1);
    },
  };

  const transport: TransportAuthorityStore = {
    async readAuthorization(input): Promise<TransportAuthorizationState | null> {
      return readTransaction(pool, async (client) => {
        const v12 = input.schemaVersion === "telemetry-contribution-v1.2";
        const result = await client.query(v12 ? `SELECT p.id AS participant_id, d.id AS device_id,
          p.owner_kind, d.authority_kind, p.state AS participant_state, d.state AS device_state,
          d.expires_at AS device_expires_at, COALESCE(f.minimum_rank, 1) AS minimum_rank,
          COALESCE(f.revision, 0) AS policy_revision, r.state AS format_lifecycle,
          CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
          CASE WHEN a.device_credential_id IS NULL THEN 0 ELSE 1 END AS accountless_authorization_current
          FROM ${tables.participants} p JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
          JOIN ${tables.telemetryV12Runtime} r ON r.id = 1
          LEFT JOIN ${tables.telemetryTransportDeviceFloors} f ON f.participant_id = p.id AND f.device_id = d.id
          LEFT JOIN ${tables.telemetryV12DeviceCapabilities} c ON c.participant_id = p.id AND c.device_id = d.id AND c.state = 'accepted'
          LEFT JOIN ${tables.accountlessV12DeviceAuthorizations} a ON a.participant_id = p.id
            AND a.device_credential_id = d.id AND a.state = 'active' AND a.expires_at > $1
          WHERE p.id = $2 AND d.id = $3` : `SELECT p.id AS participant_id, d.id AS device_id,
          p.owner_kind, d.authority_kind, p.state AS participant_state, d.state AS device_state,
          d.expires_at AS device_expires_at, f.minimum_rank, f.revision AS policy_revision,
          fmt.format_rank, fmt.lifecycle AS format_lifecycle,
          CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
          CASE WHEN a.enrollment_device_id IS NULL THEN 0 ELSE 1 END AS accountless_authorization_current,
          EXISTS (SELECT 1 FROM ${tables.telemetryContributions} legacy WHERE legacy.participant_id = p.id
            AND legacy.status = 'accepted' AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_legacy_history
          FROM ${tables.participants} p JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
          JOIN ${tables.telemetryTransportParticipantFloors} f ON f.participant_id = p.id
          JOIN ${tables.telemetryTransportFormats} fmt ON fmt.schema_version = $1
          LEFT JOIN ${tables.telemetryV11DeviceConsents} c ON c.participant_id = p.id AND c.device_id = d.id
          LEFT JOIN ${tables.accountlessV11DeviceAuthorizations} a ON a.participant_id = p.id
            AND a.device_credential_id = d.id AND a.state = 'active' AND a.expires_at > $2
          WHERE p.id = $3 AND d.id = $4`, v12
          ? [input.now, input.principal.participantId, input.principal.deviceId]
          : [input.schemaVersion, input.now, input.principal.participantId, input.principal.deviceId]);
        if (result.rowCount === 0) return null;
        const row = rowOne<Record<string, unknown>>(result);
        const ownerKind = row.owner_kind; const authorityKind = row.authority_kind;
        const participantState = row.participant_state; const deviceState = row.device_state;
        if ((ownerKind !== "social" && ownerKind !== "accountless")
            || (authorityKind !== "social" && authorityKind !== "accountless")
            || (participantState !== "active" && participantState !== "deleting")
            || (deviceState !== "active" && deviceState !== "revoked")) throw unavailable();
        return {
          participantId: stringValue(row.participant_id), deviceId: stringValue(row.device_id), ownerKind,
          authorityKind, participantState, deviceState, deviceExpiresAt: stringValue(row.device_expires_at),
          minimumWriteRank: numberValue(row.minimum_rank), policyRevision: numberValue(row.policy_revision),
          formatRank: v12 ? 12 : numberValue(row.format_rank),
          formatLifecycle: v12 ? (row.format_lifecycle === "active" ? "accepted" : "staged")
            : row.format_lifecycle as "accepted" | "staged" | "blocked",
          consentCurrent: row.consent_current === true || row.consent_current === 1,
          accountlessAuthorizationCurrent: row.accountless_authorization_current === true || row.accountless_authorization_current === 1,
          incompatibleLegacyHistory: !v12 && (row.incompatible_legacy_history === true || row.incompatible_legacy_history === 1),
        };
      }, "authority.transport.read");
    },
    async upsertConsent(input): Promise<void> {
      const v12 = input.schemaVersion === "telemetry-contribution-v1.2";
      if (!v12 && input.schemaVersion !== "telemetry-contribution-v1.1") {
        throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
      }
      await mutate(pool, async (client) => {
        const query = v12 ? `INSERT INTO ${tables.telemetryV12DeviceCapabilities} (
          participant_id, device_id, telemetry_schema_version, field_dictionary_version,
          privacy_contract_version, state, consented_at
        ) SELECT $1, $2, $3, $4, $5, 'accepted', $6 WHERE EXISTS (
          SELECT 1 FROM ${tables.participants} p JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
          JOIN ${tables.webSessions} s ON s.participant_id = p.id JOIN ${tables.telemetryV12Runtime} r ON r.id = 1
          WHERE p.id = $1 AND p.state = 'active' AND p.owner_kind = 'social' AND d.id = $2
            AND d.state = 'active' AND d.authority_kind = 'social' AND s.id = $7
            AND s.scope = 'personal' AND s.state = 'active' AND s.expires_at > $6 AND r.state = 'active')
        ON CONFLICT (participant_id, device_id) DO UPDATE SET
          telemetry_schema_version = excluded.telemetry_schema_version,
          field_dictionary_version = excluded.field_dictionary_version,
          privacy_contract_version = excluded.privacy_contract_version, state = 'accepted',
          consented_at = excluded.consented_at, revoked_at = NULL` : `INSERT INTO ${tables.telemetryV11DeviceConsents} (
          participant_id, device_id, telemetry_schema_version, field_dictionary_version,
          privacy_contract_version, consented_at
        ) SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (
          SELECT 1 FROM ${tables.participants} p JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
          JOIN ${tables.webSessions} s ON s.participant_id = p.id JOIN ${tables.telemetryTransportFormats} f ON f.schema_version = $3
          WHERE p.id = $1 AND p.state = 'active' AND p.owner_kind = 'social' AND d.id = $2
            AND d.state = 'active' AND d.authority_kind = 'social' AND s.id = $7
            AND s.scope = 'personal' AND s.state = 'active' AND s.expires_at > $6 AND f.lifecycle = 'accepted')
        ON CONFLICT (participant_id, device_id) DO NOTHING`;
        const result = await client.query(query, [input.principal.participantId, input.principal.deviceId,
          input.schemaVersion, input.fieldDictionaryVersion, input.privacyContractVersion, input.now, input.sessionId]);
        if (changes(result) !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
        return undefined;
      });
    },
    async capabilities(input): Promise<TransportCapabilities> {
      return readTransaction(pool, async (client) => {
        const v12 = input.schemaVersion === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
        const state = await client.query(`SELECT e.namespace, f.minimum_rank, f.revision, p.owner_kind,
          d.authority_kind, CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
          CASE WHEN a.enrollment_device_id IS NULL THEN 0 ELSE 1 END AS accountless_authorization_current
        FROM ${tables.participants} p JOIN ${tables.attributionEnrollments} e ON e.participant_id = p.id
        JOIN ${tables.telemetryTransportParticipantFloors} f ON f.participant_id = p.id
        JOIN ${tables.deviceCredentials} d ON d.participant_id = p.id
        LEFT JOIN ${v12 ? tables.telemetryV12DeviceCapabilities : tables.telemetryV11DeviceConsents} c
          ON c.participant_id = p.id AND c.device_id = d.id
          AND c.telemetry_schema_version = '${v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
          AND c.field_dictionary_version = '${v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
          AND c.privacy_contract_version = '${v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
          ${v12 ? "AND c.state = 'accepted'" : ""}
        LEFT JOIN ${v12 ? tables.accountlessV12DeviceAuthorizations : tables.accountlessV11DeviceAuthorizations} a ON a.participant_id = p.id
          AND a.device_credential_id = d.id
          AND a.telemetry_schema_version = '${v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
          AND a.field_dictionary_version = '${v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
          AND a.privacy_contract_version = '${v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
          AND a.state = 'active' AND a.expires_at > $1
        WHERE p.id = $2 AND p.state = 'active' AND d.id = $3 AND d.state = 'active' AND d.expires_at > $1`,
        [input.now, input.principal.participantId, input.principal.deviceId]);
        if (state.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
        const row = rowOne<Record<string, unknown>>(state);
        const formats = await client.query(`SELECT schema_version, format_rank, lifecycle
          FROM ${tables.telemetryTransportFormats}
         WHERE format_rank IN (1, 2, 10, 11${v12 ? ", 12" : ""})
         ORDER BY format_rank`);
        if (formats.rowCount === null || formats.rowCount < (v12 ? 5 : 4)) throw unavailable();
        const ownerKind = row.owner_kind; const authorityKind = row.authority_kind;
        if ((ownerKind !== "social" && ownerKind !== "accountless")
            || (authorityKind !== "social" && authorityKind !== "accountless")) throw unavailable();
        return {
          schemaVersion: v12 ? "device-sync-capabilities-v1.2" : "device-sync-capabilities-v1.1", destinationOrigin: input.destinationOrigin,
          enrollmentNamespace: stringValue(row.namespace), identityVersion: "account-track-v2",
          minimumWriteRank: numberValue(row.minimum_rank), policyRevision: numberValue(row.revision),
          formats: formats.rows.map((format) => ({ schemaVersion: stringValue(format.schema_version) as TelemetryTransportSchemaVersion,
            rank: numberValue(format.format_rank), lifecycle: format.lifecycle as "accepted" | "staged" | "blocked" })),
          consentCurrent: row.consent_current === true || row.consent_current === 1,
          requiredConsent: {
            telemetrySchemaVersion: v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
            fieldDictionaryVersion: v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
            privacyContractVersion: v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION,
          },
          ...(ownerKind === "accountless" ? { authorityKind, authorizationCurrent: row.accountless_authorization_current === true || row.accountless_authorization_current === 1 } : {}),
        };
      }, "authority.transport.capabilities");
    },
  };

  const identity: IdentityAuthorityStore = {
    async insertParticipant(material: IdentityParticipantMaterial) {
      const snapshot = {
        ...material,
        accessTokenHash: copyBytes(material.accessTokenHash),
        recoveryTokenHash: copyBytes(material.recoveryTokenHash),
      };
      return mutate(pool, async (client) => {
        const result = await client.query(`INSERT INTO ${tables.participants} (
          id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash,
          state, consent_version, consented_at, created_at, identity_link_key, identity_cooldown_digest
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, $8, $9)
        RETURNING id, created_at, state, consent_version`, [
          snapshot.id, snapshot.accessTokenId, snapshot.accessTokenHash, snapshot.recoveryTokenId,
          snapshot.recoveryTokenHash, snapshot.consentVersion, snapshot.createdAt,
          snapshot.identityLinkKey, snapshot.identityCooldownDigest,
        ]);
        const row = rowOne<Record<string, unknown>>(result);
        if (row.state !== "active") throw unavailable();
        return {
          id: stringValue(row.id), createdAt: stringValue(row.created_at), state: "active" as const,
          consentVersion: stringValue(row.consent_version),
        };
      });
    },
    async readByLinkKey(identityLinkKey) {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT id, state FROM ${tables.participants} WHERE identity_link_key = $1`, [identityLinkKey]);
        if (result.rowCount === 0) return null;
        const row = rowOne<Record<string, unknown>>(result);
        if (row.state !== "active" && row.state !== "deleting") throw unavailable();
        return { id: stringValue(row.id), state: row.state as "active" | "deleting" };
      }, "authority.identity.read-by-link");
    },
    async readDeletingLinkKey(participantId, sessionId) {
      return readTransaction(pool, async (client) => {
        const result = await client.query(`SELECT p.identity_link_key FROM ${tables.participants} p
          JOIN ${tables.webSessions} s ON s.participant_id = p.id
          WHERE p.id = $1 AND p.state = 'deleting' AND p.deletion_session_id = $2
            AND s.id = $3 AND s.scope = 'deletion_only' AND s.state = 'active'`, [participantId, sessionId, sessionId]);
        if (result.rowCount === 0) return null;
        return nullableString(rowOne<Record<string, unknown>>(result).identity_link_key);
      }, "authority.identity.read-deleting-link");
    },
    async updateRecovery(input) {
      const snapshot = { ...input, recoveryTokenHash: copyBytes(input.recoveryTokenHash) };
      return mutate(pool, async (client) => changes(await client.query(`UPDATE ${tables.participants}
        SET recovery_token_id = $1, recovery_token_hash = $2
        WHERE id = $3 AND state = 'active'`, [snapshot.recoveryTokenId, snapshot.recoveryTokenHash, snapshot.participantId])) === 1);
    },
  };

  return { sessions, sessionUploads, devices, accountless, transport, identity };
}
