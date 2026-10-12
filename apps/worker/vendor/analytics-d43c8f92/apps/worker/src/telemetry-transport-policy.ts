import {
  isTelemetryV11ConsentCurrent,
  telemetryV11RequiredConsent,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV11Consent,
} from "@app-usagemonitor/telemetry-contract";
import {
  isTelemetryV12ConsentCurrent,
  telemetryV12RequiredConsent,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  type TelemetryV12Consent,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { sha256Hex } from "./crypto";
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
import { parseStrictJson } from "./strict-json";

export interface TelemetryTransportPrincipal {
  participantId: string;
  deviceId: string;
}

export type TelemetryTransportSchemaVersion =
  | "telemetry-contribution-v0.1" | "telemetry-contribution-v0.2"
  | "telemetry-contribution-v1.0" | "telemetry-contribution-v1.1"
  | "telemetry-contribution-v1.2";

const SCHEMAS: readonly string[] = [
  "telemetry-contribution-v0.1", "telemetry-contribution-v0.2",
  "telemetry-contribution-v1.0", "telemetry-contribution-v1.1",
];
// Keep the legacy capability dictionary closed at exactly four entries.  The
// v1.2 successor is negotiated through its own capability response and is
// accepted by the transport parser without becoming a fifth legacy format.
const SUCCESSOR_SCHEMAS: readonly string[] = [TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION];

// Accountless successor authorization is a separate closed policy tuple. The
// server derives dictionary/privacy versions from the active runtime instead
// of trusting duplicate client claims for those values.
export const ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION = "accountless-upload-owner-v1.2";
export const ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION = "accountless-telemetry-v1.2-policy-v1";
export const ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS = "accountless-policy-v1.2";

export function telemetryTransportSchemaVersion(value: unknown): TelemetryTransportSchemaVersion {
  if (typeof value !== "string" || (!SCHEMAS.includes(value) && !SUCCESSOR_SCHEMAS.includes(value))) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  return value as TelemetryTransportSchemaVersion;
}

export function telemetryTransportSchemaForEnvelope(value: unknown): TelemetryTransportSchemaVersion {
  if (typeof value !== "string" || !/^telemetry-envelope-v(?:0\.[12]|1\.[012])$/u.test(value)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (value === TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION) {
    return TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
  }
  return telemetryTransportSchemaVersion(value.replace("envelope", "contribution"));
}

function v12Unavailable(): never {
  throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
}

async function telemetryTransportDeviceFloorsPresent(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_transport_device_floors'",
  ).first<{ present: number }>();
  return row?.present === 1;
}

/**
 * V1.2 is a separately negotiated successor.  It intentionally has no row in
 * the frozen four-format table and never changes the participant write floor.
 * The runtime and device capability rows are both checked at the write edge so
 * a stale capability response cannot authorize a later upload.
 */
export async function assertTelemetryV12WriteAllowed(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
): Promise<void> {
  const row = await db.prepare(
    `SELECT r.state AS runtime_state, r.schema_version, r.field_dictionary_version,
            r.privacy_contract_version, c.state AS capability_state,
            a.state AS accountless_capability_state,
            a.schema_version AS accountless_schema_identity,
            a.policy_version AS accountless_policy_version,
            a.authorization_basis AS accountless_authorization_basis,
            a.telemetry_schema_version AS accountless_schema_version,
            a.field_dictionary_version AS accountless_dictionary_version,
            a.privacy_contract_version AS accountless_privacy_version,
            a.expires_at AS accountless_capability_expires_at,
            p.owner_kind, p.state AS participant_state,
            d.authority_kind, d.state AS device_state
       FROM telemetry_v12_runtime r
       JOIN participants p ON p.id = ?
       JOIN device_credentials d ON d.id = ? AND d.participant_id = p.id
       LEFT JOIN telemetry_v12_device_capabilities c
         ON c.participant_id = p.id AND c.device_id = d.id
       LEFT JOIN accountless_upload_owners owner
         ON owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active'
        AND owner.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       LEFT JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = owner.enrollment_device_id AND ledger.state = 'active'
        AND ledger.expires_at = owner.expires_at
        AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       LEFT JOIN accountless_v12_device_authorizations a
         ON a.participant_id = p.id AND a.device_credential_id = d.id
         AND a.enrollment_device_id = owner.enrollment_device_id
        AND ledger.device_id IS NOT NULL
        -- Same lease equality as telemetry_v12_active_authorizations, so a
        -- grant a renewal left behind is refused here, not by a later trigger.
        AND a.expires_at = ledger.expires_at AND d.expires_at = ledger.expires_at
      WHERE r.id = 1`)
    .bind(principal.participantId, principal.deviceId)
    .first<{
      runtime_state: string; schema_version: string; field_dictionary_version: string;
      privacy_contract_version: string; capability_state: string | null;
      accountless_capability_state: string | null; accountless_schema_identity: string | null;
      accountless_policy_version: string | null;
      accountless_authorization_basis: string | null; accountless_schema_version: string | null;
      accountless_dictionary_version: string | null; accountless_privacy_version: string | null;
      accountless_capability_expires_at: string | null;
      owner_kind: string; participant_state: string; authority_kind: string; device_state: string;
    }>();
  const accountless = row?.owner_kind === "accountless";
  const accountlessGrant = accountless
    && row.accountless_capability_state === "active"
    && row.accountless_schema_identity === ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION
    && row.accountless_capability_expires_at !== null
    && row.accountless_capability_expires_at > new Date().toISOString()
    && row.accountless_policy_version === "accountless-telemetry-v1.2-policy-v1"
    && row.accountless_authorization_basis === "accountless-policy-v1.2"
    && row.accountless_schema_version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && row.accountless_dictionary_version === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && row.accountless_privacy_version === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
  if (!row || row.runtime_state !== "active"
      || row.schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || row.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
      || row.participant_state !== "active" || row.device_state !== "active"
      || (accountless
        ? (row.authority_kind !== "accountless" || !accountlessGrant)
        : (row.owner_kind !== "social" || row.authority_kind !== "social"
          || row.capability_state !== "accepted"))) {
    v12Unavailable();
  }
}

/** Shared by registration, decrypted ingest, staging and final activation. */
export async function assertTelemetryTransportWriteAllowed(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  schemaVersion: TelemetryTransportSchemaVersion,
): Promise<void> {
  const schema = telemetryTransportSchemaVersion(schemaVersion);
  if (schema === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION) {
    await assertTelemetryV12WriteAllowed(db, principal);
    return;
  }
  const deviceFloorsPresent = await telemetryTransportDeviceFloorsPresent(db);
  const deviceFloorSelect = deviceFloorsPresent
    ? "COALESCE(device_floors.minimum_rank, floors.minimum_rank)"
    : "floors.minimum_rank";
  const deviceFloorJoin = deviceFloorsPresent
    ? "LEFT JOIN telemetry_transport_device_floors device_floors ON device_floors.participant_id = p.id AND device_floors.device_id = d.id"
    : "";
  const row = await db.prepare(
    `SELECT formats.lifecycle, formats.format_rank, ${deviceFloorSelect} AS minimum_rank,
            CASE WHEN grant_v11.device_id IS NULL THEN 0 ELSE 1 END AS consent_v11,
            p.owner_kind, d.authority_kind,
            CASE WHEN accountless_grant.enrollment_device_id IS NULL THEN 0 ELSE 1 END
              AS accountless_v11,
            EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_history
       FROM participants p
       JOIN device_credentials d ON d.participant_id = p.id
       JOIN telemetry_transport_participant_floors floors ON floors.participant_id = p.id
       ${deviceFloorJoin}
       JOIN telemetry_transport_formats formats ON formats.schema_version = ?
       LEFT JOIN telemetry_v11_device_consents grant_v11
         ON grant_v11.participant_id = p.id AND grant_v11.device_id = d.id
       LEFT JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = d.accountless_enrollment_device_id
        AND ledger.state = 'active' AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND ledger.expires_at = d.expires_at
       LEFT JOIN accountless_upload_owners owner
         ON owner.enrollment_device_id = ledger.device_id
        AND owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
       LEFT JOIN accountless_v11_device_authorizations accountless_grant
         ON accountless_grant.enrollment_device_id = ledger.device_id
        AND owner.enrollment_device_id = ledger.device_id
        AND accountless_grant.participant_id = p.id
        AND accountless_grant.device_credential_id = d.id
        AND accountless_grant.state = 'active'
        AND accountless_grant.expires_at = ledger.expires_at
      WHERE p.id = ? AND d.id = ? AND p.state = 'active' AND d.state = 'active'
        AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(schema, principal.participantId, principal.deviceId).first<{
    lifecycle: string; format_rank: number; minimum_rank: number; consent_v11: number;
    owner_kind: "social" | "accountless";
    authority_kind: "social" | "accountless";
    accountless_v11: number;
    incompatible_history: number;
  }>();
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const accountless = row.owner_kind === "accountless";
  if ((accountless && row.authority_kind !== "accountless")
      || (!accountless && row.owner_kind !== "social")
      || (!accountless && row.authority_kind !== "social")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (row.lifecycle !== "accepted" || row.format_rank < row.minimum_rank
      || (schema === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION && row.incompatible_history === 1)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (accountless && schema !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (schema === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
      && (accountless ? row.accountless_v11 !== 1 : row.consent_v11 !== 1)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
}

/** Owner/session grant for the separately negotiated v1.2 successor. */
export async function grantTelemetryV12Consent(
  db: D1Database,
  principal: TelemetryTransportPrincipal & { sessionId: string },
  consent: unknown,
  nowEpoch = Date.now(),
): Promise<Readonly<{ consent: TelemetryV12Consent; schemaVersion: typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION }>> {
  if (!isTelemetryV12ConsentCurrent(consent)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  const now = new Date(nowEpoch).toISOString();
  const row = await db.prepare(
    `SELECT d.id FROM telemetry_v12_runtime r
       JOIN participants p ON p.id = ?
       JOIN device_credentials d ON d.id = ? AND d.participant_id = p.id
       JOIN web_sessions s ON s.id = ? AND s.participant_id = p.id
      WHERE r.id = 1 AND r.state = 'active'
        AND p.state = 'active' AND p.owner_kind = 'social'
        AND d.state = 'active' AND d.authority_kind = 'social'
        AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > ?
        AND ? = r.schema_version AND ? = r.field_dictionary_version
        AND ? = r.privacy_contract_version`)
    .bind(principal.participantId, principal.deviceId, principal.sessionId, now,
      consent.telemetrySchemaVersion, consent.fieldDictionaryVersion,
      consent.privacyContractVersion)
    .first<{ id: string }>();
  if (!row) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  try {
    const result = await db.prepare(
      `INSERT INTO telemetry_v12_device_capabilities (
        participant_id, device_id, telemetry_schema_version,
        field_dictionary_version, privacy_contract_version, state, consented_at
      ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)
      ON CONFLICT(participant_id, device_id) DO UPDATE SET
        state='accepted', revoked_at=NULL
      WHERE telemetry_v12_device_capabilities.telemetry_schema_version = excluded.telemetry_schema_version
        AND telemetry_v12_device_capabilities.field_dictionary_version = excluded.field_dictionary_version
        AND telemetry_v12_device_capabilities.privacy_contract_version = excluded.privacy_contract_version`)
      .bind(principal.participantId, principal.deviceId,
        consent.telemetrySchemaVersion, consent.fieldDictionaryVersion,
        consent.privacyContractVersion, now)
      .run();
    if (result.meta.changes !== 1) throw new Error("v12 capability not admitted");
  } catch {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  await assertTelemetryV12WriteAllowed(db, principal);
  return Object.freeze({ consent: telemetryV12RequiredConsent(), schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION });
}

export interface TelemetryV12AccountlessAuthorizationRequest {
  schemaVersion: typeof ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION;
  policyVersion: typeof ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION;
  authorizationBasis: typeof ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS;
  telemetrySchemaVersion: typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
}

const ACCOUNTLESS_V12_AUTHORIZATION_KEYS = Object.freeze([
  "authorizationBasis", "policyVersion", "schemaVersion", "telemetrySchemaVersion",
].sort());

export function parseTelemetryV12AccountlessAuthorizationRequest(
  value: unknown,
): TelemetryV12AccountlessAuthorizationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== ACCOUNTLESS_V12_AUTHORIZATION_KEYS.length
      || keys.some((key, index) => key !== ACCOUNTLESS_V12_AUTHORIZATION_KEYS[index])
      || object.schemaVersion !== ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION
      || object.policyVersion !== ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION
      || object.authorizationBasis !== ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS
      || object.telemetrySchemaVersion !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  });
}

export function parseTelemetryV12AccountlessAuthorizationJson(
  raw: string,
): TelemetryV12AccountlessAuthorizationRequest {
  try {
    return parseTelemetryV12AccountlessAuthorizationRequest(parseStrictJson(raw));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "BODY_INVALID");
  }
}

/**
 * Owner-flow hook for accountless enrollment.  Accountless has no browser
 * session, so this is separate from social consent and from the v1.1 grant.
 * The caller must already be inside the accountless owner transaction; the
 * row is still re-proved against the active lease and successor runtime.
 */
export async function grantTelemetryV12AccountlessAuthorization(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  request: TelemetryV12AccountlessAuthorizationRequest,
  nowEpoch = Date.now(),
): Promise<void> {
  if (request.schemaVersion !== ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION
      || request.policyVersion !== ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION
      || request.authorizationBasis !== ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS
      || request.telemetrySchemaVersion !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
  ) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  const now = new Date(nowEpoch).toISOString();
  const owner = await db.prepare(
    `SELECT owner.enrollment_device_id, owner.expires_at
       FROM accountless_upload_owners owner
       JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
       JOIN participants p ON p.id = owner.participant_id
       JOIN device_credentials d ON d.id = owner.device_credential_id
       JOIN telemetry_v12_runtime r ON r.id = 1
      WHERE owner.participant_id = ? AND owner.device_credential_id = ?
        AND owner.state = 'active' AND owner.expires_at > ?
        AND ledger.state = 'active' AND ledger.expires_at = owner.expires_at
        AND p.state = 'active' AND p.owner_kind = 'accountless'
        AND d.state = 'active' AND d.authority_kind = 'accountless'
        AND d.accountless_enrollment_device_id = owner.enrollment_device_id
        AND d.expires_at = owner.expires_at AND r.state = 'active'
        AND r.schema_version = ? AND r.field_dictionary_version = ?
        AND r.privacy_contract_version = ?`,
  ).bind(principal.participantId, principal.deviceId, now,
    request.telemetrySchemaVersion, TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
    TELEMETRY_V12_PRIVACY_CONTRACT_VERSION).first<{ enrollment_device_id: string; expires_at: string }>();
  if (!owner) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  try {
    await db.prepare(
      `INSERT INTO accountless_v12_device_authorizations (
        enrollment_device_id, participant_id, device_credential_id,
        schema_version, policy_version, authorization_basis, telemetry_schema_version,
        field_dictionary_version, privacy_contract_version, authorized_at,
        expires_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(enrollment_device_id) DO UPDATE SET expires_at = excluded.expires_at
       WHERE accountless_v12_device_authorizations.state = 'active'
         AND accountless_v12_device_authorizations.participant_id = excluded.participant_id
         AND accountless_v12_device_authorizations.device_credential_id = excluded.device_credential_id
         AND accountless_v12_device_authorizations.expires_at < excluded.expires_at`,
    ).bind(owner.enrollment_device_id, principal.participantId, principal.deviceId,
      request.schemaVersion, request.policyVersion, request.authorizationBasis,
      request.telemetrySchemaVersion, TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
      TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now, owner.expires_at).run();
  } catch (error) {
    if (!String(error).includes("UNIQUE constraint failed")) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
}

export async function grantTelemetryV11Consent(
  db: D1Database,
  principal: TelemetryTransportPrincipal & { sessionId: string },
  consent: unknown,
  nowEpoch = Date.now(),
): Promise<Readonly<{ consent: TelemetryV11Consent; minimumWriteRank: 11 }>> {
  if (!isTelemetryV11ConsentCurrent(consent)) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  const now = new Date(nowEpoch).toISOString();
  const row = await db.prepare(
    `SELECT d.id FROM participants p
       JOIN device_credentials d ON d.participant_id = p.id
       JOIN web_sessions s ON s.participant_id = p.id
       JOIN telemetry_transport_formats f ON f.schema_version = ?
      WHERE p.id = ? AND p.state = 'active' AND p.owner_kind = 'social'
        AND d.id = ? AND d.state = 'active' AND d.authority_kind = 'social'
        AND s.id = ? AND s.scope = 'personal' AND s.state = 'active' AND s.expires_at > ?
        AND f.lifecycle = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
          WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
            AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')`,
  ).bind(TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION, principal.participantId,
    principal.deviceId, principal.sessionId, now).first<{id: string}>();
  if (!row) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  const deviceFloorsPresent = await telemetryTransportDeviceFloorsPresent(db);
  try {
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO telemetry_v11_device_consents (
          participant_id, device_id, telemetry_schema_version, field_dictionary_version,
          privacy_contract_version, consented_at
        ) SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM web_sessions s WHERE s.id = ? AND s.participant_id = ?
              AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > ?)
            AND EXISTS (SELECT 1 FROM participants p
              JOIN device_credentials d ON d.participant_id = p.id
             WHERE p.id = ? AND p.owner_kind = 'social' AND p.state = 'active'
               AND d.id = ? AND d.authority_kind = 'social' AND d.state = 'active')
          ON CONFLICT(participant_id, device_id) DO NOTHING`,
      ).bind(principal.participantId, principal.deviceId, consent.telemetrySchemaVersion,
        consent.fieldDictionaryVersion, consent.privacyContractVersion, now,
        principal.sessionId, principal.participantId, now,
        principal.participantId, principal.deviceId),
      // An explicit re-grant after an audited rollback raises the same floor;
      // an idempotent retry while already upgraded does not invent a revision.
      db.prepare(
        `UPDATE telemetry_transport_participant_floors
            SET minimum_rank = 11, revision = revision + 1, changed_at = ?
          WHERE participant_id = ? AND minimum_rank < 11
            AND EXISTS (SELECT 1 FROM telemetry_v11_device_consents c
              WHERE c.participant_id = ? AND c.device_id = ?)
            AND EXISTS (SELECT 1 FROM web_sessions s WHERE s.id = ? AND s.participant_id = ?
              AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > ?)
            AND EXISTS (SELECT 1 FROM telemetry_transport_formats
              WHERE schema_version = ? AND lifecycle = 'accepted')
            AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = telemetry_transport_participant_floors.participant_id
                AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')`,
      ).bind(now, principal.participantId, principal.participantId, principal.deviceId,
        principal.sessionId, principal.participantId, now, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION),
      // A preflight session is not a transaction receipt. Re-grants after an
      // owner rollback must not acknowledge a floor rise if the session was
      // revoked or incompatible legacy history appeared before this batch.
      db.prepare(
        `SELECT floors.minimum_rank FROM participants p
           JOIN device_credentials d ON d.participant_id = p.id
           JOIN web_sessions s ON s.participant_id = p.id
           JOIN telemetry_transport_participant_floors floors ON floors.participant_id = p.id
           JOIN telemetry_v11_device_consents c ON c.participant_id = p.id AND c.device_id = d.id
           JOIN telemetry_transport_formats f ON f.schema_version = c.telemetry_schema_version
          WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'
            AND s.id = ? AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > ?
            AND floors.minimum_rank = 11 AND f.lifecycle = 'accepted'
            AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')`,
      ).bind(principal.participantId, principal.deviceId, principal.sessionId, now),
    ];
    if (deviceFloorsPresent) {
      statements.push(
        db.prepare(
          `UPDATE telemetry_transport_device_floors
              SET minimum_rank = 11, revision = revision + 1, changed_at = ?
            WHERE participant_id = ? AND device_id = ? AND minimum_rank < 11`,
        ).bind(now, principal.participantId, principal.deviceId),
        db.prepare(
          `SELECT minimum_rank FROM telemetry_transport_device_floors
            WHERE participant_id = ? AND device_id = ?`,
        ).bind(principal.participantId, principal.deviceId),
      );
    }
    const result = await db.batch<{ minimum_rank: number }>(statements);
    if (result[2]?.results[0]?.minimum_rank !== 11) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
    if (deviceFloorsPresent && result[4]?.results[0]?.minimum_rank !== 11) {
      throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
    }
  } catch {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  return Object.freeze({ consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 });
}

export async function telemetryTransportCapabilities(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  destinationOrigin: string,
) {
  let origin: URL;
  try { origin = new URL(destinationOrigin); } catch { throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID"); }
  if (origin.origin !== destinationOrigin || (origin.protocol !== "https:"
      && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const deviceFloorsPresent = await telemetryTransportDeviceFloorsPresent(db);
  const deviceFloorSelect = deviceFloorsPresent
    ? "COALESCE(device_floors.minimum_rank, f.minimum_rank)"
    : "f.minimum_rank";
  const deviceFloorJoin = deviceFloorsPresent
    ? "LEFT JOIN telemetry_transport_device_floors device_floors ON device_floors.participant_id = p.id AND device_floors.device_id = d.id"
    : "";
  const row = await db.prepare(
    `SELECT e.namespace, ${deviceFloorSelect} AS minimum_rank, f.revision,
            CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_v11,
            p.owner_kind, d.authority_kind,
            CASE WHEN accountless_grant.enrollment_device_id IS NULL THEN 0 ELSE 1 END
              AS accountless_v11,
            EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_history
       FROM participants p JOIN attribution_enrollments e ON e.participant_id = p.id
       JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
       JOIN device_credentials d ON d.participant_id = p.id
       ${deviceFloorJoin}
       LEFT JOIN telemetry_v11_device_consents c ON c.participant_id = p.id AND c.device_id = d.id
       LEFT JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = d.accountless_enrollment_device_id
        AND ledger.state = 'active' AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND ledger.expires_at = d.expires_at
       LEFT JOIN accountless_upload_owners owner
         ON owner.enrollment_device_id = ledger.device_id
        AND owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
       LEFT JOIN accountless_v11_device_authorizations accountless_grant
         ON accountless_grant.enrollment_device_id = ledger.device_id
        AND owner.enrollment_device_id = ledger.device_id
        AND accountless_grant.participant_id = p.id
        AND accountless_grant.device_credential_id = d.id
        AND accountless_grant.state = 'active'
        AND accountless_grant.expires_at = ledger.expires_at
      WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'
        AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(principal.participantId, principal.deviceId).first<{
    namespace: string; minimum_rank: number; revision: number; consent_v11: number;
    owner_kind: "social" | "accountless";
    authority_kind: "social" | "accountless";
    accountless_v11: number;
    incompatible_history: number;
  }>();
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const accountless = row.owner_kind === "accountless";
  if ((accountless && (row.authority_kind !== "accountless" || row.accountless_v11 !== 1))
      || (!accountless && (row.owner_kind !== "social" || row.authority_kind !== "social"))) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const formats = await db.prepare(
    "SELECT schema_version, format_rank, lifecycle FROM telemetry_transport_formats ORDER BY format_rank LIMIT 5",
  ).all<{ schema_version: string; format_rank: number; lifecycle: "accepted" | "staged" | "blocked" }>();
  if (formats.results.length !== 4) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const base = {
    schemaVersion: "device-sync-capabilities-v1.1" as const,
    destinationOrigin,
    enrollmentNamespace: row.namespace,
    identityVersion: "account-track-v2" as const,
    minimumWriteRank: row.minimum_rank,
    policyRevision: row.revision,
    requiredConsent: telemetryV11RequiredConsent(),
    formats: formats.results.map((format) => ({
      schemaVersion: format.schema_version,
      rank: format.format_rank,
      lifecycle: (row.incompatible_history === 1 && format.schema_version === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION)
        || (accountless && format.schema_version !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION)
        ? "blocked" as const : format.lifecycle,
    })),
  };
  // Social clients keep their historical closed response shape. Accountless
  // replies retain the exact v1.1 dictionary but identify policy authority
  // separately from consent, so no policy event is relabelled as consent.
  return accountless
    ? { ...base, consentCurrent: false, authorityKind: "accountless" as const,
      authorizationCurrent: true }
    : { ...base, consentCurrent: row.consent_v11 === 1 };
}

/**
 * Successor capability advertisement.  This is intentionally a separate
 * response contract: callers that only understand the frozen v1.1 response
 * must never observe a fifth legacy format or infer v1.2 authority from a
 * v1.1 grant.
 */
export async function telemetryTransportV12Capabilities(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  destinationOrigin: string,
) {
  let origin: URL;
  try { origin = new URL(destinationOrigin); } catch { throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID"); }
  if (origin.origin !== destinationOrigin || (origin.protocol !== "https:"
      && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const now = new Date().toISOString();
  const row = await db.prepare(
    `SELECT e.namespace,
            p.owner_kind, d.authority_kind,
            r.state AS runtime_state, r.schema_version, r.envelope_schema_version,
            r.field_dictionary_version, r.privacy_contract_version,
            c.state AS social_state, c.consented_at AS social_consented_at,
            a.state AS accountless_state, a.schema_version AS accountless_schema_identity,
            a.authorized_at AS accountless_authorized_at,
            a.expires_at AS accountless_expires_at,
            a.policy_version AS accountless_policy_version,
            a.authorization_basis AS accountless_authorization_basis,
            a.telemetry_schema_version AS accountless_schema_version,
            a.field_dictionary_version AS accountless_dictionary_version,
            a.privacy_contract_version AS accountless_privacy_version
       FROM participants p
       JOIN attribution_enrollments e ON e.participant_id = p.id
       JOIN device_credentials d ON d.participant_id = p.id
       LEFT JOIN telemetry_v12_runtime r ON r.id = 1
       LEFT JOIN telemetry_v12_device_capabilities c
         ON c.participant_id = p.id AND c.device_id = d.id
       LEFT JOIN accountless_upload_owners owner
         ON owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active'
        AND owner.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       LEFT JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = owner.enrollment_device_id AND ledger.state = 'active'
        AND ledger.expires_at = owner.expires_at
        AND ledger.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       LEFT JOIN accountless_v12_device_authorizations a
         ON a.participant_id = p.id AND a.device_credential_id = d.id
        AND a.enrollment_device_id = owner.enrollment_device_id
        AND ledger.device_id IS NOT NULL
        -- A grant left behind by a lease renewal is refused by the active
        -- authorization view, so it must not be reported as current either;
        -- the client then re-requests it and the grant below catches up.
        AND a.expires_at = ledger.expires_at
      WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'
        AND d.expires_at > ?`,
  ).bind(principal.participantId, principal.deviceId, now).first<{
    namespace: string; owner_kind: "social" | "accountless"; authority_kind: "social" | "accountless";
    runtime_state: "staged" | "active" | null; schema_version: string | null;
    envelope_schema_version: string | null; field_dictionary_version: string | null;
    privacy_contract_version: string | null; social_state: "accepted" | "revoked" | null;
    social_consented_at: string | null;
    accountless_state: "active" | "revoked" | null; accountless_schema_identity: string | null;
    accountless_authorized_at: string | null;
    accountless_expires_at: string | null;
    accountless_policy_version: string | null; accountless_authorization_basis: string | null;
    accountless_schema_version: string | null; accountless_dictionary_version: string | null;
    accountless_privacy_version: string | null;
  }>();
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const accountless = row.owner_kind === "accountless";
  if ((accountless && row.authority_kind !== "accountless")
      || (!accountless && (row.owner_kind !== "social" || row.authority_kind !== "social"))) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const runtimeExact = row.schema_version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && row.envelope_schema_version === TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
    && row.field_dictionary_version === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && row.privacy_contract_version === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
  const lifecycle = !runtimeExact || row.runtime_state === null
    ? "blocked" as const
    : row.runtime_state === "active" ? "accepted" as const : "staged" as const;
  const socialConsent = !accountless && row.social_state === "accepted";
  const accountlessGrant = accountless && row.accountless_state === "active"
    && row.accountless_expires_at !== null && row.accountless_expires_at > now
    && row.accountless_schema_identity === ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION
    && row.accountless_policy_version === ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION
    && row.accountless_authorization_basis === ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS
    && row.accountless_schema_version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && row.accountless_dictionary_version === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && row.accountless_privacy_version === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
  return {
    schemaVersion: "device-sync-capabilities-v1.2" as const,
    destinationOrigin,
    enrollmentNamespace: row.namespace,
    identityVersion: "account-track-v2" as const,
    authorityKind: accountless ? "accountless" as const : "social" as const,
    successor: {
      schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      envelopeSchemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
      lifecycle,
      requiredConsent: telemetryV12RequiredConsent(),
      consentCurrent: socialConsent,
      authorizationCurrent: lifecycle === "accepted" && (socialConsent || accountlessGrant),
      activationTime: socialConsent ? row.social_consented_at : accountlessGrant ? row.accountless_authorized_at : null,
    },
  };
}

/**
 * Owner integration supplies an already-started, Access+CSRF-authorized audit
 * operation. These statements can join the owner's whole-domain rollback in
 * ONE transaction; they are deliberately not a participant/device endpoint.
 */
interface RollbackTarget {
  participantId: string; expectedRevision: number; fromRank: number; toRank: number;
}

export async function telemetryTransportRollbackAuditDetails(input: RollbackTarget) {
  if (!/^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.participantId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || ![1, 2, 10, 11].includes(input.fromRank) || ![1, 2, 10, 11].includes(input.toRank)
      || input.toRank >= input.fromRank) throw new ApiError(400, "BODY_INVALID");
  return { operation: "telemetry_transport_rollback" as const,
    participantDigest: await sha256Hex(`app-usagemonitor/transport-rollback/v1\0${input.participantId}`),
    expectedRevision: input.expectedRevision, fromRank: input.fromRank, toRank: input.toRank };
}

export async function telemetryTransportRollbackStatements(db: D1Database, input: RollbackTarget & {
  operationId: string; now: string;
}): Promise<D1PreparedStatement[]> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.operationId)
      || !Number.isFinite(Date.parse(input.now)) || new Date(input.now).toISOString() !== input.now) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const details = await telemetryTransportRollbackAuditDetails(input);
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO telemetry_transport_floor_rollbacks (
        operation_id, participant_id, participant_digest, expected_revision, from_rank, to_rank, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.operationId, input.participantId, details.participantDigest,
      input.expectedRevision, input.fromRank, input.toRank, input.now),
    db.prepare(
      `UPDATE telemetry_transport_participant_floors
          SET minimum_rank = ?, revision = revision + 1, changed_at = ?
        WHERE participant_id = ? AND revision = ? AND minimum_rank = ?
        RETURNING minimum_rank, revision`,
    ).bind(input.toRank, input.now, input.participantId, input.expectedRevision, input.fromRank),
  ];
  if (await telemetryTransportDeviceFloorsPresent(db)) {
    statements.push(db.prepare(
      `UPDATE telemetry_transport_device_floors
          SET minimum_rank = ?, revision = revision + 1, changed_at = ?
        WHERE participant_id = ? AND minimum_rank = ?`,
    ).bind(input.toRank, input.now, input.participantId, input.fromRank));
  }
  return statements;
}

export function parseTelemetryTransportRollbackRequest(value: unknown): RollbackTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "action\0transportRollback"
      || Reflect.get(value, "action") !== "run_maintenance") throw new ApiError(400, "BODY_INVALID");
  const target: unknown = Reflect.get(value, "transportRollback");
  if (typeof target !== "object" || target === null || Array.isArray(target)
      || Object.keys(target).sort().join("\0") !== "confirmation\0expectedRevision\0fromRank\0participantId\0toRank"
      || Reflect.get(target, "confirmation") !== "lower_transport_admission_preserving_analytical_source"
      || typeof Reflect.get(target, "participantId") !== "string"
      || !Number.isSafeInteger(Reflect.get(target, "expectedRevision"))
      || !Number.isSafeInteger(Reflect.get(target, "fromRank"))
      || !Number.isSafeInteger(Reflect.get(target, "toRank"))) throw new ApiError(400, "BODY_INVALID");
  return { participantId: Reflect.get(target, "participantId") as string,
    expectedRevision: Reflect.get(target, "expectedRevision") as number,
    fromRank: Reflect.get(target, "fromRank") as number, toRank: Reflect.get(target, "toRank") as number };
}

/** Called only after the existing Access-owner/session-owner and CSRF gate. */
export async function rollbackTelemetryTransportAsOwner(
  db: D1Database, actorIdentityKey: string, input: RollbackTarget, nowEpoch = Date.now(),
) {
  const details = await telemetryTransportRollbackAuditDetails(input);
  const operationId = await beginAdminOperation(db, actorIdentityKey, "run_maintenance", details);
  try {
    const statements = await telemetryTransportRollbackStatements(db, {
      ...input, operationId, now: new Date(nowEpoch).toISOString(),
    });
    const results = await db.batch(statements);
    const row = results[1]?.results[0];
    if (!row || Reflect.get(row, "minimum_rank") !== input.toRank
        || Reflect.get(row, "revision") !== input.expectedRevision + 1) {
      throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    }
    const result = { task: "telemetry_transport_rollback" as const, operationId,
      minimumWriteRank: input.toRank, policyRevision: input.expectedRevision + 1,
      activeAnalyticalSourcePreserved: true };
    await finishAdminOperation(db, operationId, "success", { ...details, ...result });
    return result;
  } catch (error) {
    const safeError = error instanceof ApiError ? error : new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    try { await finishAdminOperation(db, operationId, "failure", { ...details, code: safeError.code }); }
    catch { /* a missing terminal audit is never reported as success */ }
    throw safeError;
  }
}
