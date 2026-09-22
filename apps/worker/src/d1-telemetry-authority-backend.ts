import { ApiError } from "./errors";
import { timingSafeEqual } from "./crypto";
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
  TransportPrincipal,
} from "./telemetry-authority-backend";

type D1Row = Record<string, unknown>;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw unavailable();
  return value;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw unavailable();
}

function text(value: unknown): string {
  if (typeof value !== "string") throw unavailable();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw unavailable();
  return value as number;
}

function changes(result: D1Result<unknown>): number {
  const count = result.meta.changes;
  if (!Number.isSafeInteger(count)) throw unavailable();
  return count;
}

function rowSession(row: D1Row): AuthoritySessionRecord {
  return {
    id: text(row.session_id),
    participantId: text(row.participant_id),
    secretHash: asBytes(row.secret_hash),
    csrfHash: asBytes(row.csrf_hash),
    scope: row.session_scope === "personal" || row.session_scope === "deletion_only"
      ? row.session_scope : (() => { throw unavailable(); })(),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    state: row.session_state === "active" || row.session_state === "revoked"
      ? row.session_state : (() => { throw unavailable(); })(),
    participantCreatedAt: text(row.participant_created_at),
    participantState: row.participant_state === "active" || row.participant_state === "deleting"
      ? row.participant_state : (() => { throw unavailable(); })(),
    consentVersion: text(row.consent_version),
    lastUsedAt: text(row.last_used_at),
  };
}

function rowSessionUpload(row: D1Row): AuthoritySessionUploadRecord {
  return {
    id: text(row.id),
    participantId: text(row.participant_id),
    issuedBySessionId: text(row.issued_by_session_id),
    secretHash: asBytes(row.secret_hash),
    envelopeDigest: text(row.envelope_digest),
    bodyBytes: integer(row.body_bytes),
    contentType: row.content_type === "application/json"
      ? row.content_type : (() => { throw unavailable(); })(),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    state: ["unused", "consuming", "consumed", "revoked"].includes(String(row.state))
      ? row.state as AuthoritySessionUploadRecord["state"] : (() => { throw unavailable(); })(),
    consumeLeaseExpiresAt: nullableText(row.consume_lease_expires_at),
    consumedAt: nullableText(row.consumed_at),
    consumedContributionId: nullableText(row.consumed_contribution_id),
    participantState: row.participant_state === "active" || row.participant_state === "deleting"
      ? row.participant_state : (() => { throw unavailable(); })(),
    issuingSessionState: row.issuing_session_state === "active" || row.issuing_session_state === "revoked"
      ? row.issuing_session_state : (() => { throw unavailable(); })(),
    issuingSessionExpiresAt: text(row.issuing_session_expires_at),
  };
}

function rowDevice(row: D1Row): AuthorityDeviceRecord {
  const state = row.device_state;
  const participantState = row.participant_state;
  const ownerKind = row.owner_kind;
  const authorityKind = row.authority_kind;
  if ((state !== "active" && state !== "revoked")
      || (participantState !== "active" && participantState !== "deleting")
      || (ownerKind !== "social" && ownerKind !== "accountless")
      || (authorityKind !== "social" && authorityKind !== "accountless")) throw unavailable();
  return {
    id: text(row.device_id),
    participantId: text(row.participant_id),
    pairingId: text(row.paired_via_pairing_id),
    secretHash: asBytes(row.secret_hash),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    lastUsedAt: text(row.last_used_at),
    socialVerifiedAt: nullableText(row.social_verified_at),
    credentialGeneration: integer(row.credential_generation),
    state,
    revokedAt: nullableText(row.revoked_at),
    participantState,
    participantConsentVersion: nullableText(row.participant_consent_version),
    ownerKind,
    authorityKind,
    accountlessEnrollmentDeviceId: nullableText(row.accountless_enrollment_device_id),
    accountlessLedgerState: row.accountless_ledger_state === "active" || row.accountless_ledger_state === "revoked"
      ? row.accountless_ledger_state : null,
    accountlessLedgerExpiresAt: nullableText(row.accountless_ledger_expires_at),
    accountlessOwnerState: row.accountless_owner_state === "active" || row.accountless_owner_state === "revoked"
      ? row.accountless_owner_state : null,
    accountlessOwnerExpiresAt: nullableText(row.accountless_owner_expires_at),
    accountlessAuthorizationState: row.accountless_authorization_state === "active"
      || row.accountless_authorization_state === "revoked"
      ? row.accountless_authorization_state : null,
    accountlessAuthorizationExpiresAt: nullableText(row.accountless_authorization_expires_at),
  };
}

function rowDeviceUpload(row: D1Row): AuthorityDeviceUploadRecord {
  const state = row.state;
  if (!["unused", "consuming", "consumed", "revoked"].includes(String(state))) throw unavailable();
  const deviceState = row.device_state;
  if (deviceState !== "active" && deviceState !== "revoked") throw unavailable();
  const participantState = row.participant_state;
  if (participantState !== "active" && participantState !== "deleting") throw unavailable();
  return {
    id: text(row.id),
    participantId: text(row.participant_id),
    issuedByDeviceId: text(row.issued_by_device_id),
    secretHash: asBytes(row.secret_hash),
    envelopeDigest: text(row.envelope_digest),
    bodyBytes: integer(row.body_bytes),
    contentType: row.content_type === "application/json"
      ? row.content_type : (() => { throw unavailable(); })(),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    state: state as AuthorityDeviceUploadRecord["state"],
    consumeLeaseExpiresAt: nullableText(row.consume_lease_expires_at),
    consumedAt: nullableText(row.consumed_at),
    consumedContributionId: nullableText(row.consumed_contribution_id),
    deviceState,
    deviceExpiresAt: text(row.device_expires_at),
    participantState,
  };
}

function rowEnrollment(row: D1Row): AccountlessEnrollmentRecord {
  const state = row.state;
  if (state !== "active" && state !== "revoked") throw unavailable();
  return {
    deviceId: text(row.device_id),
    deviceSecretHash: asBytes(row.device_secret_hash),
    installationPrincipalId: text(row.installation_principal_id),
    schemaVersion: text(row.schema_version),
    policyVersion: text(row.policy_version),
    authorizationBasis: text(row.authorization_basis),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    state,
    revokedAt: nullableText(row.revoked_at),
    revocationReason: nullableText(row.revocation_reason),
  };
}

function mapTransportError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return unavailable();
}

export function createD1TelemetryAuthorityBackend(db: D1Database): TelemetryAuthorityBackend {
  const sessions: SessionAuthorityStore = {
    async insert(material: AuthoritySessionMaterial): Promise<void> {
      try {
        const result = await db.prepare(`INSERT INTO web_sessions (
          id, participant_id, secret_hash, csrf_hash, scope, state,
          issued_at, expires_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
          .bind(material.id, material.participantId, material.secretHash, material.csrfHash,
            material.scope, material.issuedAt, material.expiresAt, material.issuedAt).run();
        if (changes(result) !== 1) throw unavailable();
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async read(sessionId: string): Promise<AuthoritySessionRecord | null> {
      try {
        const row = await db.prepare(`SELECT
          s.id AS session_id, s.participant_id, s.secret_hash, s.csrf_hash,
          s.scope AS session_scope, s.state AS session_state, s.issued_at,
          s.expires_at, s.last_used_at, p.created_at AS participant_created_at,
          p.state AS participant_state, p.consent_version
        FROM web_sessions s JOIN participants p ON p.id = s.participant_id
        WHERE s.id = ?`).bind(sessionId).first<D1Row>();
        return row ? rowSession(row) : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async touch(sessionId: string, now: string): Promise<boolean> {
      try {
        return changes(await db.prepare(`UPDATE web_sessions
          SET last_used_at = ? WHERE id = ? AND state = 'active'`).bind(now, sessionId).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async revoke(sessionId: string, now: string): Promise<boolean> {
      try {
        return changes(await db.prepare(`UPDATE web_sessions
          SET state = 'revoked', revoked_at = ?
          WHERE id = ? AND state = 'active'`).bind(now, sessionId).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  const sessionUploads: SessionUploadAuthorityStore = {
    async insert(material: AuthoritySessionUploadMaterial): Promise<void> {
      try {
        const result = await db.prepare(`INSERT INTO upload_authorizations (
          id, participant_id, issued_by_session_id, secret_hash, envelope_digest,
          body_bytes, content_type, state, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?)`)
          .bind(material.id, material.participantId, material.issuedBySessionId,
            material.secretHash, material.envelopeDigest, material.bodyBytes,
            material.contentType, material.issuedAt, material.expiresAt).run();
        if (changes(result) !== 1) throw unavailable();
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async read(authorizationId: string): Promise<AuthoritySessionUploadRecord | null> {
      try {
        const row = await db.prepare(`SELECT u.*, p.state AS participant_state,
          s.state AS issuing_session_state, s.expires_at AS issuing_session_expires_at
          FROM upload_authorizations u JOIN participants p ON p.id = u.participant_id
          JOIN web_sessions s ON s.id = u.issued_by_session_id WHERE u.id = ?`)
          .bind(authorizationId).first<D1Row>();
        return row ? rowSessionUpload(row) : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async claim(input): Promise<string | null> {
      try {
        const row = await db.prepare(`UPDATE upload_authorizations
          SET state = 'consuming', consume_lease_expires_at = ?
          WHERE id = ? AND participant_id = ? AND state IN ('unused', 'consuming')
            AND (state = 'unused' OR consume_lease_expires_at <= ?)
            AND envelope_digest = ? AND body_bytes = ? AND content_type = ?
            AND expires_at > ? RETURNING consume_lease_expires_at`).bind(input.leaseExpiresAt, input.authorizationId,
          input.participantId, input.now, input.envelopeDigest, input.bodyBytes, input.contentType, input.now).first<{consume_lease_expires_at: string | null}>();
        return typeof row?.consume_lease_expires_at === "string" ? row.consume_lease_expires_at : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async recordReceipt(input): Promise<boolean> {
      try {
        const result = await db.prepare(`UPDATE upload_authorizations
          SET state = 'consumed', consumed_at = ?, consumed_contribution_id = ?,
          consume_lease_expires_at = NULL
          WHERE id = ? AND participant_id = ? AND state = 'consuming'
            AND consume_lease_expires_at = ? AND consume_lease_expires_at > ? AND expires_at > ?`).bind(
          input.now, input.contributionId, input.authorizationId, input.participantId,
          input.leaseExpiresAt, input.now, input.now).run();
        if (changes(result) === 1) return true;
        const row = await db.prepare(`SELECT state, consumed_contribution_id
          FROM upload_authorizations WHERE id = ? AND participant_id = ?`)
          .bind(input.authorizationId, input.participantId).first<{state: string; consumed_contribution_id: string | null}>();
        return row?.state === "consumed" && row.consumed_contribution_id === input.contributionId;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async abandon(input): Promise<boolean> {
      try {
          const result = await db.prepare(`UPDATE upload_authorizations
          SET state = 'revoked', revoked_at = ?, consume_lease_expires_at = NULL
          WHERE id = ? AND state = 'consuming'
            AND (consume_lease_expires_at = ?
              OR consume_lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))${input.participantId ? " AND participant_id = ?" : ""}`)
          .bind(...(input.participantId
            ? [input.now, input.authorizationId, input.leaseExpiresAt, input.participantId]
            : [input.now, input.authorizationId, input.leaseExpiresAt])).run();
        return changes(result) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  const devices: DeviceAuthorityStore = {
    async insertPairing(material: AuthorityDevicePairingMaterial): Promise<void> {
      try {
        const result = await db.prepare(`INSERT INTO device_pairings (
          id, participant_id, issued_by_session_id, secret_hash, consent_version,
          transport_consent_version, state, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?)`)
          .bind(material.id, material.participantId, material.issuedBySessionId,
            material.secretHash, material.consentVersion, material.transportConsentVersion,
            material.issuedAt, material.expiresAt).run();
        if (changes(result) !== 1) throw unavailable();
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async readPairing(pairingId: string) {
      try {
        const row = await db.prepare(`SELECT pairing.id, pairing.participant_id,
          pairing.secret_hash, pairing.consent_version, pairing.transport_consent_version,
          pairing.state, pairing.issued_at, pairing.expires_at, pairing.claimed_device_id,
          participant.state AS participant_state
          FROM device_pairings pairing JOIN participants participant
            ON participant.id = pairing.participant_id WHERE pairing.id = ?`)
          .bind(pairingId).first<D1Row>();
        if (!row) return null;
        const state = row.state;
        const participantState = row.participant_state;
        if (!["unused", "consumed", "revoked"].includes(String(state))
            || (participantState !== "active" && participantState !== "deleting")) throw unavailable();
        return {
          id: text(row.id), participantId: text(row.participant_id), secretHash: asBytes(row.secret_hash),
          consentVersion: text(row.consent_version), transportConsentVersion: text(row.transport_consent_version),
          state: state as "unused" | "consumed" | "revoked", issuedAt: text(row.issued_at),
          expiresAt: text(row.expires_at), claimedDeviceId: nullableText(row.claimed_device_id), participantState,
        };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async claimPairing(input): Promise<boolean> {
      try {
        const result = await db.batch([
          db.prepare(`INSERT INTO device_credentials (
            id, participant_id, paired_via_pairing_id, secret_hash, state,
            issued_at, expires_at, last_used_at, social_verified_at, credential_generation
          ) SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM device_pairings pairing
            JOIN participants participant ON participant.id = pairing.participant_id
            WHERE pairing.id = ? AND pairing.participant_id = ? AND pairing.state = 'unused'
              AND pairing.expires_at > ? AND participant.state = 'active')`)
            .bind(input.device.id, input.participantId, input.device.pairingId,
              input.device.secretHash, input.device.issuedAt, input.device.expiresAt,
              input.device.lastUsedAt, input.device.socialVerifiedAt, input.device.credentialGeneration,
              input.device.pairingId, input.participantId, input.now),
          db.prepare(`UPDATE device_pairings SET state = 'consumed', consumed_at = ?,
            claimed_device_id = ? WHERE id = ? AND participant_id = ? AND state = 'unused'
            AND expires_at > ?`).bind(input.now, input.device.id, input.device.pairingId,
            input.participantId, input.now),
        ]);
        return changes(result[0]!) === 1 && changes(result[1]!) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async readDevice(deviceId: string): Promise<AuthorityDeviceRecord | null> {
      try {
        const row = await db.prepare(`SELECT d.id AS device_id, d.participant_id,
          d.paired_via_pairing_id, d.secret_hash, d.state AS device_state, d.issued_at,
          d.expires_at, d.last_used_at, d.social_verified_at, d.credential_generation,
          d.revoked_at, p.state AS participant_state, p.consent_version AS participant_consent_version,
          p.owner_kind, d.authority_kind, d.accountless_enrollment_device_id,
          ledger.state AS accountless_ledger_state, ledger.expires_at AS accountless_ledger_expires_at,
          owner.state AS accountless_owner_state, owner.expires_at AS accountless_owner_expires_at,
          grant_row.state AS accountless_authorization_state,
          grant_row.expires_at AS accountless_authorization_expires_at
          FROM device_credentials d JOIN participants p ON p.id = d.participant_id
          LEFT JOIN accountless_enrollment_ledger ledger
            ON ledger.device_id = d.accountless_enrollment_device_id
          LEFT JOIN accountless_upload_owners owner
            ON owner.enrollment_device_id = ledger.device_id AND owner.participant_id = p.id
            AND owner.device_credential_id = d.id
          LEFT JOIN accountless_v11_device_authorizations grant_row
            ON grant_row.enrollment_device_id = ledger.device_id AND grant_row.participant_id = p.id
            AND grant_row.device_credential_id = d.id
          WHERE d.id = ?`).bind(deviceId).first<D1Row>();
        return row ? rowDevice(row) : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async touchDevice(input): Promise<boolean> {
      try {
        return changes(await db.prepare(`UPDATE device_credentials SET last_used_at = ?, expires_at = ?
          WHERE id = ? AND state = 'active' AND expires_at > ?
            AND EXISTS (SELECT 1 FROM participants p WHERE p.id = device_credentials.participant_id
              AND p.state = 'active')`).bind(input.now, input.expiresAt, input.deviceId, input.now).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async revokeDevice(input): Promise<boolean> {
      try {
        return changes(await db.prepare(`UPDATE device_credentials SET state = 'revoked', revoked_at = ?
          WHERE id = ? AND participant_id = ? AND state = 'active'`).bind(input.now, input.deviceId, input.participantId).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async insertUpload(material: AuthorityDeviceUploadMaterial): Promise<void> {
      try {
        const result = await db.prepare(`INSERT INTO device_upload_authorizations (
          id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
          body_bytes, content_type, state, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?)`)
          .bind(material.id, material.participantId, material.issuedByDeviceId, material.secretHash,
            material.envelopeDigest, material.bodyBytes, material.contentType,
            material.issuedAt, material.expiresAt).run();
        if (changes(result) !== 1) throw unavailable();
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async readUpload(authorizationId: string): Promise<AuthorityDeviceUploadRecord | null> {
      try {
        const row = await db.prepare(`SELECT u.*, d.state AS device_state,
          d.expires_at AS device_expires_at, p.state AS participant_state
          FROM device_upload_authorizations u JOIN device_credentials d
            ON d.id = u.issued_by_device_id JOIN participants p ON p.id = u.participant_id
          WHERE u.id = ?`).bind(authorizationId).first<D1Row>();
        return row ? rowDeviceUpload(row) : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async claimUpload(input): Promise<string | null> {
      try {
        const row = await db.prepare(`UPDATE device_upload_authorizations
          SET state = 'consuming', consume_lease_expires_at = ?
          WHERE id = ? AND participant_id = ? AND issued_by_device_id = ?
            AND state IN ('unused', 'consuming')
            AND (state = 'unused' OR consume_lease_expires_at <= ?)
            AND envelope_digest = ? AND body_bytes = ?
            AND content_type = ? AND expires_at > ?
            AND EXISTS (SELECT 1 FROM device_credentials d
              WHERE d.id = device_upload_authorizations.issued_by_device_id
                AND d.state = 'active' AND d.expires_at > ?)
            AND EXISTS (SELECT 1 FROM participants p WHERE p.id = device_upload_authorizations.participant_id
              AND p.state = 'active') RETURNING consume_lease_expires_at`).bind(input.leaseExpiresAt, input.authorizationId,
          input.participantId, input.deviceId, input.now, input.envelopeDigest, input.bodyBytes,
          input.contentType, input.now, input.now).first<{consume_lease_expires_at: string | null}>();
        return typeof row?.consume_lease_expires_at === "string" ? row.consume_lease_expires_at : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async recordUploadReceipt(input): Promise<boolean> {
      try {
        const result = await db.prepare(`UPDATE device_upload_authorizations
          SET state = 'consumed', consumed_at = ?, consumed_contribution_id = ?,
            consume_lease_expires_at = NULL
          WHERE id = ? AND participant_id = ? AND issued_by_device_id = ?
            AND state = 'consuming' AND consume_lease_expires_at = ?
            AND consume_lease_expires_at > ? AND expires_at > ?`)
          .bind(input.now, input.contributionId, input.authorizationId, input.participantId,
            input.deviceId, input.leaseExpiresAt, input.now, input.now).run();
        if (changes(result) === 1) return true;
        const row = await db.prepare(`SELECT state, consumed_contribution_id
          FROM device_upload_authorizations WHERE id = ? AND participant_id = ?
            AND issued_by_device_id = ?`).bind(input.authorizationId, input.participantId,
          input.deviceId).first<{state: string; consumed_contribution_id: string | null}>();
        return row?.state === "consumed" && row.consumed_contribution_id === input.contributionId;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async abandonUpload(input): Promise<boolean> {
      try {
        const result = await db.prepare(`UPDATE device_upload_authorizations
          SET state = 'revoked', revoked_at = ?, consume_lease_expires_at = NULL
          WHERE id = ? AND state = 'consuming'
            AND (consume_lease_expires_at = ?
              OR consume_lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))${input.participantId ? " AND participant_id = ?" : ""}`)
          .bind(...(input.participantId
            ? [input.now, input.authorizationId, input.leaseExpiresAt, input.participantId]
            : [input.now, input.authorizationId, input.leaseExpiresAt])).run();
        return changes(result) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  const accountless: AccountlessAuthorityStore = {
    async read(deviceId: string): Promise<AccountlessEnrollmentRecord | null> {
      try {
        const row = await db.prepare(`SELECT device_id, device_secret_hash,
          installation_principal_id, schema_version, policy_version, authorization_basis,
          state, issued_at, expires_at, revoked_at, revocation_reason
          FROM accountless_enrollment_ledger WHERE device_id = ?`).bind(deviceId).first<D1Row>();
        return row ? rowEnrollment(row) : null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async enroll(material: AccountlessEnrollmentMaterial) {
      try {
        const existing = await accountless.read(material.deviceId);
        if (existing) {
          if (!timingSafeEqual(existing.deviceSecretHash, material.deviceSecretHash)
              || existing.installationPrincipalId !== material.installationPrincipalId
              || existing.schemaVersion !== material.schemaVersion
              || existing.policyVersion !== material.policyVersion
              || existing.authorizationBasis !== material.authorizationBasis) {
            throw new ApiError(409, "ACCOUNTLESS_ENROLLMENT_CONFLICT");
          }
          return { created: false, record: existing };
        }
        const result = await db.prepare(`INSERT INTO accountless_enrollment_ledger (
          device_id, device_secret_hash, installation_principal_id, schema_version,
          policy_version, authorization_basis, state, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .bind(material.deviceId, material.deviceSecretHash, material.installationPrincipalId,
            material.schemaVersion, material.policyVersion, material.authorizationBasis,
            material.issuedAt, material.expiresAt).run();
        if (changes(result) !== 1) throw unavailable();
        const created = await accountless.read(material.deviceId);
        return { created: true, record: required(created) };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async revoke(input): Promise<boolean> {
      try {
        return changes(await db.prepare(`UPDATE accountless_enrollment_ledger
          SET state = 'revoked', revoked_at = ?, revocation_reason = ?
          WHERE device_id = ? AND state = 'active'`).bind(input.now, input.reason, input.deviceId).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  const transport: TransportAuthorityStore = {
    async readAuthorization(input): Promise<TransportAuthorizationState | null> {
      try {
        if (input.schemaVersion === "telemetry-contribution-v1.2") {
          const row = await db.prepare(`SELECT p.id AS participant_id, d.id AS device_id,
            p.owner_kind, d.authority_kind, p.state AS participant_state, d.state AS device_state,
            d.expires_at AS device_expires_at, COALESCE(f.minimum_rank, 1) AS minimum_rank,
            COALESCE(f.revision, 0) AS policy_revision, r.state AS format_lifecycle,
            CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
            CASE WHEN EXISTS (
              SELECT 1 FROM accountless_enrollment_ledger ledger
              JOIN accountless_upload_owners owner
                ON owner.enrollment_device_id = ledger.device_id
               AND owner.participant_id = p.id AND owner.device_credential_id = d.id
               AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
              JOIN accountless_v12_device_authorizations grant_row
                ON grant_row.enrollment_device_id = ledger.device_id
               AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
               AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
             WHERE ledger.device_id = d.accountless_enrollment_device_id
               AND ledger.state = 'active' AND ledger.expires_at = d.expires_at
               AND ledger.expires_at > ?
            ) THEN 1 ELSE 0 END AS accountless_authorization_current
          FROM participants p JOIN device_credentials d ON d.participant_id = p.id
          JOIN telemetry_v12_runtime r ON r.id = 1
          LEFT JOIN telemetry_transport_device_floors f ON f.participant_id = p.id AND f.device_id = d.id
          LEFT JOIN telemetry_v12_device_capabilities c ON c.participant_id = p.id
            AND c.device_id = d.id
            AND c.telemetry_schema_version = '${TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION}'
            AND c.field_dictionary_version = '${TELEMETRY_V12_FIELD_DICTIONARY_VERSION}'
            AND c.privacy_contract_version = '${TELEMETRY_V12_PRIVACY_CONTRACT_VERSION}'
            AND c.state = 'accepted'
          LEFT JOIN accountless_v12_device_authorizations a ON a.participant_id = p.id
            AND a.device_credential_id = d.id AND a.state = 'active' AND a.expires_at > ?
          WHERE p.id = ? AND d.id = ?`).bind(input.now, input.now, input.principal.participantId,
            input.principal.deviceId).first<D1Row>();
          if (!row) return null;
          const ownerKind = row.owner_kind;
          const authorityKind = row.authority_kind;
          const participantState = row.participant_state;
          const deviceState = row.device_state;
          if (!["social", "accountless"].includes(String(ownerKind))
              || !["social", "accountless"].includes(String(authorityKind))
              || !["active", "deleting"].includes(String(participantState))
              || !["active", "revoked"].includes(String(deviceState))) throw unavailable();
          return {
            participantId: text(row.participant_id), deviceId: text(row.device_id),
            ownerKind: ownerKind as "social" | "accountless",
            authorityKind: authorityKind as "social" | "accountless",
            participantState: participantState as "active" | "deleting",
            deviceState: deviceState as "active" | "revoked",
            deviceExpiresAt: text(row.device_expires_at), minimumWriteRank: integer(row.minimum_rank),
            policyRevision: integer(row.policy_revision), formatRank: 12,
            formatLifecycle: row.format_lifecycle === "active" ? "accepted" : "staged",
            consentCurrent: integer(row.consent_current) === 1,
            accountlessAuthorizationCurrent: integer(row.accountless_authorization_current) === 1,
            incompatibleLegacyHistory: false,
          };
        }
        const row = await db.prepare(`SELECT p.id AS participant_id, d.id AS device_id,
          p.owner_kind, d.authority_kind, p.state AS participant_state, d.state AS device_state,
          d.expires_at AS device_expires_at, f.minimum_rank, f.revision AS policy_revision,
          fmt.format_rank, fmt.lifecycle AS format_lifecycle,
          CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
          CASE WHEN EXISTS (
            SELECT 1 FROM accountless_enrollment_ledger ledger
            JOIN accountless_upload_owners owner
              ON owner.enrollment_device_id = ledger.device_id
             AND owner.participant_id = p.id AND owner.device_credential_id = d.id
             AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
            JOIN accountless_v11_device_authorizations grant_row
              ON grant_row.enrollment_device_id = ledger.device_id
             AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
             AND grant_row.state = 'active'
             AND grant_row.telemetry_schema_version = '${TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
             AND grant_row.field_dictionary_version = '${TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
             AND grant_row.privacy_contract_version = '${TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
             AND grant_row.expires_at = ledger.expires_at
           WHERE ledger.device_id = d.accountless_enrollment_device_id
             AND ledger.state = 'active' AND ledger.expires_at = d.expires_at
             AND ledger.expires_at > ?
          ) THEN 1 ELSE 0 END AS accountless_authorization_current,
          EXISTS (SELECT 1 FROM telemetry_contributions legacy
            WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
              AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_legacy_history
        FROM participants p JOIN device_credentials d ON d.participant_id = p.id
        JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
        JOIN telemetry_transport_formats fmt ON fmt.schema_version = ?
        LEFT JOIN telemetry_v11_device_consents c ON c.participant_id = p.id AND c.device_id = d.id
          AND c.telemetry_schema_version = '${TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
          AND c.field_dictionary_version = '${TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
          AND c.privacy_contract_version = '${TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
        LEFT JOIN accountless_v11_device_authorizations a ON a.participant_id = p.id
          AND a.device_credential_id = d.id AND a.state = 'active' AND a.expires_at > ?
        WHERE p.id = ? AND d.id = ?`).bind(input.schemaVersion, input.now, input.now,
          input.principal.participantId, input.principal.deviceId).first<D1Row>();
        if (!row) return null;
        const ownerKind = row.owner_kind;
        const authorityKind = row.authority_kind;
        const participantState = row.participant_state;
        const deviceState = row.device_state;
        if (!["social", "accountless"].includes(String(ownerKind))
            || !["social", "accountless"].includes(String(authorityKind))
            || !["active", "deleting"].includes(String(participantState))
            || !["active", "revoked"].includes(String(deviceState))) throw unavailable();
        return {
          participantId: text(row.participant_id), deviceId: text(row.device_id),
          ownerKind: ownerKind as "social" | "accountless", authorityKind: authorityKind as "social" | "accountless",
          participantState: participantState as "active" | "deleting", deviceState: deviceState as "active" | "revoked",
          deviceExpiresAt: text(row.device_expires_at), minimumWriteRank: integer(row.minimum_rank),
          policyRevision: integer(row.policy_revision), formatRank: integer(row.format_rank),
          formatLifecycle: row.format_lifecycle === "accepted" || row.format_lifecycle === "staged"
            || row.format_lifecycle === "blocked" ? row.format_lifecycle : (() => { throw unavailable(); })(),
          consentCurrent: integer(row.consent_current) === 1,
          accountlessAuthorizationCurrent: integer(row.accountless_authorization_current) === 1,
          incompatibleLegacyHistory: integer(row.incompatible_legacy_history) === 1,
        };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async upsertConsent(input): Promise<void> {
      try {
        const v12 = input.schemaVersion === "telemetry-contribution-v1.2";
        const expectedFieldDictionary = v12
          ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION;
        const expectedPrivacyContract = v12
          ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION;
        if (input.fieldDictionaryVersion !== expectedFieldDictionary
            || input.privacyContractVersion !== expectedPrivacyContract) {
          throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
        }
        if (input.schemaVersion === "telemetry-contribution-v1.2") {
          const result = await db.prepare(`INSERT INTO telemetry_v12_device_capabilities (
            participant_id, device_id, telemetry_schema_version,
            field_dictionary_version, privacy_contract_version, state, consented_at
          ) SELECT ?, ?, ?, ?, ?, 'accepted', ?
          WHERE EXISTS (SELECT 1 FROM participants p JOIN device_credentials d
            ON d.participant_id = p.id JOIN web_sessions s ON s.participant_id = p.id
            JOIN telemetry_v12_runtime r ON r.id = 1
            WHERE p.id = ? AND p.state = 'active' AND p.owner_kind = 'social'
              AND d.id = ? AND d.state = 'active' AND d.authority_kind = 'social'
              AND s.id = ? AND s.scope = 'personal' AND s.state = 'active'
              AND s.expires_at > ? AND r.state = 'active')
          ON CONFLICT(participant_id, device_id) DO UPDATE SET
            telemetry_schema_version = excluded.telemetry_schema_version,
            field_dictionary_version = excluded.field_dictionary_version,
            privacy_contract_version = excluded.privacy_contract_version,
            state = 'accepted', consented_at = excluded.consented_at, revoked_at = NULL`)
            .bind(input.principal.participantId, input.principal.deviceId, input.schemaVersion,
              input.fieldDictionaryVersion, input.privacyContractVersion, input.now,
              input.principal.participantId, input.principal.deviceId, input.sessionId, input.now).run();
          if (changes(result) !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
          const floor = await db.prepare(
            `INSERT INTO telemetry_transport_participant_floors
              (participant_id, minimum_rank, revision, changed_at)
             VALUES (?, 12, 1, ?)
             ON CONFLICT(participant_id) DO UPDATE SET
               minimum_rank = MAX(telemetry_transport_participant_floors.minimum_rank, 12),
               revision = telemetry_transport_participant_floors.revision
                 + CASE WHEN telemetry_transport_participant_floors.minimum_rank < 12 THEN 1 ELSE 0 END,
               changed_at = CASE WHEN telemetry_transport_participant_floors.minimum_rank < 12
                 THEN excluded.changed_at ELSE telemetry_transport_participant_floors.changed_at END`,
          ).bind(input.principal.participantId, input.now).run();
          if (changes(floor) !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
          return;
        }
        if (input.schemaVersion !== "telemetry-contribution-v1.1") {
          throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
        }
        const result = await db.prepare(`INSERT INTO telemetry_v11_device_consents (
          participant_id, device_id, telemetry_schema_version,
          field_dictionary_version, privacy_contract_version, consented_at
        ) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM participants p JOIN device_credentials d ON d.participant_id = p.id
          JOIN web_sessions s ON s.participant_id = p.id JOIN telemetry_transport_formats f
            ON f.schema_version = ?
          WHERE p.id = ? AND p.state = 'active' AND p.owner_kind = 'social'
            AND d.id = ? AND d.state = 'active' AND d.authority_kind = 'social'
            AND s.id = ? AND s.scope = 'personal' AND s.state = 'active'
            AND s.expires_at > ? AND f.lifecycle = 'accepted'
            AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'))
        ON CONFLICT(participant_id, device_id) DO UPDATE SET
          telemetry_schema_version = excluded.telemetry_schema_version,
          field_dictionary_version = excluded.field_dictionary_version,
          privacy_contract_version = excluded.privacy_contract_version,
          consented_at = excluded.consented_at`).bind(
          input.principal.participantId, input.principal.deviceId, input.schemaVersion,
          input.fieldDictionaryVersion, input.privacyContractVersion, input.now,
          input.schemaVersion, input.principal.participantId, input.principal.deviceId,
          input.sessionId, input.now).run();
        if (changes(result) !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
        const floor = await db.prepare(
          `INSERT INTO telemetry_transport_participant_floors
            (participant_id, minimum_rank, revision, changed_at)
           VALUES (?, 11, 1, ?)
           ON CONFLICT(participant_id) DO UPDATE SET
             minimum_rank = MAX(telemetry_transport_participant_floors.minimum_rank, 11),
             revision = telemetry_transport_participant_floors.revision
               + CASE WHEN telemetry_transport_participant_floors.minimum_rank < 11 THEN 1 ELSE 0 END,
             changed_at = CASE WHEN telemetry_transport_participant_floors.minimum_rank < 11
               THEN excluded.changed_at ELSE telemetry_transport_participant_floors.changed_at END`,
        ).bind(input.principal.participantId, input.now).run();
        if (changes(floor) !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async capabilities(input): Promise<TransportCapabilities> {
      try {
        const v12 = input.schemaVersion === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
        const row = await db.prepare(`SELECT e.namespace, f.minimum_rank, f.revision,
          p.owner_kind, d.authority_kind,
          CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_current,
          CASE WHEN a.enrollment_device_id IS NULL THEN 0 ELSE 1 END AS accountless_authorization_current
          FROM participants p JOIN attribution_enrollments e ON e.participant_id = p.id
          JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
          JOIN device_credentials d ON d.participant_id = p.id
          LEFT JOIN ${v12 ? "telemetry_v12_device_capabilities" : "telemetry_v11_device_consents"} c
            ON c.participant_id = p.id AND c.device_id = d.id
            AND c.telemetry_schema_version = '${v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
            AND c.field_dictionary_version = '${v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
            AND c.privacy_contract_version = '${v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
            ${v12 ? "AND c.state = 'accepted'" : ""}
          LEFT JOIN ${v12 ? "accountless_v12_device_authorizations" : "accountless_v11_device_authorizations"} a
            ON a.participant_id = p.id
            AND a.device_credential_id = d.id
            AND a.telemetry_schema_version = '${v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION}'
            AND a.field_dictionary_version = '${v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION}'
            AND a.privacy_contract_version = '${v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION}'
            AND a.state = 'active' AND a.expires_at > ?
          WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'
            AND d.expires_at > ?`).bind(input.now, input.principal.participantId,
          input.principal.deviceId, input.now).first<D1Row>();
        if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
        const formats = await db.prepare(`SELECT schema_version, format_rank, lifecycle
          FROM telemetry_transport_formats
         WHERE format_rank IN (1, 2, 10, 11${v12 ? ", 12" : ""})
         ORDER BY format_rank`).all<D1Row>();
        if (formats.results.length < (v12 ? 5 : 4)) throw unavailable();
        const ownerKind = row.owner_kind;
        const authorityKind = row.authority_kind;
        if ((ownerKind !== "social" && ownerKind !== "accountless")
            || (authorityKind !== "social" && authorityKind !== "accountless")) throw unavailable();
        return {
          schemaVersion: v12 ? "device-sync-capabilities-v1.2" : "device-sync-capabilities-v1.1",
          destinationOrigin: input.destinationOrigin,
          enrollmentNamespace: text(row.namespace), identityVersion: "account-track-v2",
          minimumWriteRank: integer(row.minimum_rank), policyRevision: integer(row.revision),
          formats: formats.results.map((format) => ({
            schemaVersion: text(format.schema_version) as TelemetryTransportSchemaVersion,
            rank: integer(format.format_rank),
            lifecycle: format.lifecycle === "accepted" || format.lifecycle === "staged"
              || format.lifecycle === "blocked" ? format.lifecycle : (() => { throw unavailable(); })(),
          })),
          consentCurrent: integer(row.consent_current) === 1,
          requiredConsent: {
            telemetrySchemaVersion: v12 ? TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION : TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
            fieldDictionaryVersion: v12 ? TELEMETRY_V12_FIELD_DICTIONARY_VERSION : TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
            privacyContractVersion: v12 ? TELEMETRY_V12_PRIVACY_CONTRACT_VERSION : TELEMETRY_V11_PRIVACY_CONTRACT_VERSION,
          },
          ...(ownerKind === "accountless" ? { authorityKind, authorizationCurrent: integer(row.accountless_authorization_current) === 1 } : {}),
        };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  const identity: IdentityAuthorityStore = {
    async insertParticipant(material: IdentityParticipantMaterial) {
      try {
        const row = await db.prepare(`INSERT INTO participants (
          id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash,
          state, consent_version, consented_at, created_at, identity_link_key, identity_cooldown_digest
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?) RETURNING id, created_at, state, consent_version`)
          .bind(material.id, material.accessTokenId, material.accessTokenHash, material.recoveryTokenId,
            material.recoveryTokenHash, material.consentVersion, material.createdAt, material.createdAt,
            material.identityLinkKey, material.identityCooldownDigest).first<D1Row>();
        if (!row) throw unavailable();
        if (row.state !== "active") throw unavailable();
        return {
          id: text(row.id), createdAt: text(row.created_at), state: "active" as const,
          consentVersion: text(row.consent_version),
        };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async readByLinkKey(identityLinkKey: string) {
      try {
        const row = await db.prepare(`SELECT id, state FROM participants WHERE identity_link_key = ?`)
          .bind(identityLinkKey).first<{id: string; state: string}>();
        if (!row) return null;
        if (row.state !== "active" && row.state !== "deleting") throw unavailable();
        return { id: row.id, state: row.state };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async readDeletingLinkKey(participantId: string, sessionId: string) {
      try {
        const row = await db.prepare(`SELECT p.identity_link_key
          FROM participants p JOIN web_sessions s ON s.participant_id = p.id
          WHERE p.id = ? AND p.state = 'deleting' AND p.deletion_session_id = ?
            AND s.id = ? AND s.scope = 'deletion_only' AND s.state = 'active'`)
          .bind(participantId, sessionId, sessionId).first<{identity_link_key: string | null}>();
        return row?.identity_link_key ?? null;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async updateRecovery(input) {
      try {
        return changes(await db.prepare(`UPDATE participants
          SET recovery_token_id = ?, recovery_token_hash = ?
          WHERE id = ? AND state = 'active' RETURNING id`)
          .bind(input.recoveryTokenId, input.recoveryTokenHash, input.participantId).run()) === 1;
      } catch (error) {
        throw mapTransportError(error);
      }
    },
  };

  return { sessions, sessionUploads, devices, accountless, transport, identity };
}
