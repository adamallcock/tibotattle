import {
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";

export const TELEMETRY_PERFORMANCE_SCOPE = "model-performance-daily" as const;
export const TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION =
  "telemetry-performance-capabilities-v1" as const;
export const TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION =
  "telemetry-performance-authorization-v1" as const;
export const TELEMETRY_PERFORMANCE_METHOD_VERSION =
  "performance-daily-histogram-v1" as const;
/**
 * Transport methods this Worker can accept.  This is deliberately narrower
 * than the record vocabulary: legacy/unavailable are valid historical record
 * states, but a client must not submit them as a newly negotiated capability.
 */
export const TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS = [
  "receipt", "tool_free",
] as const;
export const ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION =
  "accountless-performance-owner-v1" as const;
export const ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION =
  "accountless-telemetry-performance-policy-v1" as const;
export const ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS =
  "accountless-performance-policy-v1" as const;

const MAX_REVISION = 2_147_483_647;

export interface TelemetryPerformancePrincipal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface TelemetryPerformanceAuthorization {
  readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION;
  readonly capabilityRevision: number;
  readonly authorityEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope: typeof TELEMETRY_PERFORMANCE_SCOPE;
}

export interface TelemetryPerformanceRequiredConsent {
  readonly schemaVersion: typeof PERFORMANCE_RECORD_SCHEMA_VERSION;
  readonly fieldDictionaryVersion: typeof PERFORMANCE_FIELD_DICTIONARY_VERSION;
  readonly privacyContractVersion: typeof PERFORMANCE_PRIVACY_CONTRACT_VERSION;
  readonly scope: typeof TELEMETRY_PERFORMANCE_SCOPE;
}

export interface TelemetryPerformanceCapability {
  readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION;
  readonly lifecycle: "accepted" | "staged" | "blocked";
  readonly consentCurrent: boolean;
  readonly authorizationCurrent: boolean;
  readonly supportedSpeedMethods: typeof TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS;
  readonly requiredConsent: TelemetryPerformanceRequiredConsent;
  readonly authorization: TelemetryPerformanceAuthorization;
}

export interface TelemetryPerformanceAccountlessAuthorizationRequest {
  readonly schemaVersion: typeof ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION;
  readonly policyVersion: typeof ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION;
  readonly authorizationBasis: typeof ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS;
}

export interface TelemetryPerformanceConsent {
  readonly schemaVersion: typeof PERFORMANCE_RECORD_SCHEMA_VERSION;
  readonly fieldDictionaryVersion: typeof PERFORMANCE_FIELD_DICTIONARY_VERSION;
  readonly privacyContractVersion: typeof PERFORMANCE_PRIVACY_CONTRACT_VERSION;
  readonly scope: typeof TELEMETRY_PERFORMANCE_SCOPE;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function instant(value: unknown): value is string {
  return typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function invalid(code: "TELEMETRY_TRANSPORT_BLOCKED" | "TELEMETRY_CONSENT_INVALID" = "TELEMETRY_TRANSPORT_BLOCKED"): never {
  throw new ApiError(403, code);
}

export function parseTelemetryPerformanceAuthorization(
  value: unknown,
  nowEpoch = Date.now(),
): TelemetryPerformanceAuthorization {
  if (!exact(value, ["authorityEpoch", "capabilityRevision", "expiresAt", "issuedAt", "schemaVersion", "scope"])
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION
      || value.scope !== TELEMETRY_PERFORMANCE_SCOPE
      || !integer(value.capabilityRevision, 1, MAX_REVISION)
      || !integer(value.authorityEpoch, 1, MAX_REVISION)
      || !instant(value.issuedAt) || !instant(value.expiresAt)
      || Date.parse(value.expiresAt) <= nowEpoch) {
    invalid();
  }
  return Object.freeze(value as unknown as TelemetryPerformanceAuthorization);
}

export function parseTelemetryPerformanceRequiredConsent(
  value: unknown,
): TelemetryPerformanceRequiredConsent {
  if (!exact(value, ["fieldDictionaryVersion", "privacyContractVersion", "schemaVersion", "scope"])
      || value.schemaVersion !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || value.fieldDictionaryVersion !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || value.privacyContractVersion !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || value.scope !== TELEMETRY_PERFORMANCE_SCOPE) {
    invalid("TELEMETRY_CONSENT_INVALID");
  }
  return Object.freeze(value as unknown as TelemetryPerformanceRequiredConsent);
}

export function parseTelemetryPerformanceConsent(value: unknown): TelemetryPerformanceConsent {
  try {
    return parseTelemetryPerformanceRequiredConsent(value);
  } catch {
    invalid("TELEMETRY_CONSENT_INVALID");
  }
}

export function parseTelemetryPerformanceCapability(
  value: unknown,
  nowEpoch = Date.now(),
): TelemetryPerformanceCapability {
  if (!exact(value, ["authorization", "authorizationCurrent", "consentCurrent", "lifecycle", "requiredConsent", "schemaVersion", "supportedSpeedMethods"])
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION
      || !["accepted", "staged", "blocked"].includes(value.lifecycle as string)
      || typeof value.consentCurrent !== "boolean"
      || typeof value.authorizationCurrent !== "boolean"
      || !Array.isArray(value.supportedSpeedMethods)
      || value.supportedSpeedMethods.length !== TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS.length
      || value.supportedSpeedMethods.some((method, index) => method !== TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS[index])) {
    invalid();
  }
  const consent = parseTelemetryPerformanceRequiredConsent(value.requiredConsent);
  const authorization = parseTelemetryPerformanceAuthorization(value.authorization, nowEpoch);
  if (value.lifecycle !== "accepted" || value.consentCurrent !== true
      || value.authorizationCurrent !== true) invalid();
  return Object.freeze({
    schemaVersion: TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION,
    lifecycle: value.lifecycle as TelemetryPerformanceCapability["lifecycle"],
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS,
    requiredConsent: consent,
    authorization,
  });
}

interface PerformanceCapabilityRow {
  participant_id: string;
  device_id: string;
  capability_revision: number;
  authority_epoch: number;
  schema_version: string;
  field_dictionary_version: string;
  privacy_contract_version: string;
  scope: string;
  state: "accepted" | "revoked";
  issued_at: string;
  expires_at: string;
  owner_kind: "social" | "accountless";
  authority_kind: "social" | "accountless";
}

async function readPerformanceCapabilityRow(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  nowEpoch: number,
): Promise<PerformanceCapabilityRow | null> {
  const now = new Date(nowEpoch).toISOString();
  return db.prepare(
    `SELECT c.participant_id, c.device_id, c.capability_revision, c.authority_epoch,
            c.schema_version, c.field_dictionary_version, c.privacy_contract_version,
            c.scope, c.state, c.issued_at, c.expires_at,
            p.owner_kind, d.authority_kind
       FROM telemetry_performance_runtime r
       JOIN participants p ON p.id = ?
       JOIN device_credentials d ON d.id = ? AND d.participant_id = p.id
       JOIN telemetry_performance_device_capabilities c
         ON c.participant_id = p.id AND c.device_id = d.id
       LEFT JOIN accountless_telemetry_performance_authorizations a
         ON a.participant_id = p.id AND a.device_credential_id = d.id
        AND a.state = 'active'
       LEFT JOIN accountless_upload_owners owner
         ON owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active'
       LEFT JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = owner.enrollment_device_id AND ledger.state = 'active'
      WHERE r.id = 1 AND r.state = 'active'
        AND p.state = 'active' AND d.state = 'active'
        AND c.state = 'accepted' AND c.scope = 'model-performance-daily'
        AND c.expires_at > ?
        AND c.schema_version = r.schema_version
        AND c.field_dictionary_version = r.field_dictionary_version
        AND c.privacy_contract_version = r.privacy_contract_version
        AND (
          (p.owner_kind = 'social' AND d.authority_kind = 'social')
          OR (
            p.owner_kind = 'accountless' AND d.authority_kind = 'accountless'
            AND a.schema_version = 'accountless-performance-owner-v1'
            AND a.policy_version = 'accountless-telemetry-performance-policy-v1'
            AND a.authorization_basis = 'accountless-performance-policy-v1'
            AND a.performance_schema_version = r.schema_version
            AND a.field_dictionary_version = r.field_dictionary_version
            AND a.privacy_contract_version = r.privacy_contract_version
            AND a.scope = c.scope
            AND a.capability_revision = c.capability_revision
            AND a.authority_epoch = c.authority_epoch
            AND a.expires_at = c.expires_at AND a.expires_at > ?
            AND owner.enrollment_device_id = a.enrollment_device_id
            AND ledger.device_id = owner.enrollment_device_id
            AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at
          )
        )`,
  ).bind(principal.participantId, principal.deviceId, now, now).first<PerformanceCapabilityRow>();
}

/**
 * Check the independent performance grant at the write edge.  The query does
 * not join a v1/v1.1/v1.2 consent or usage table; only the performance
 * singleton, performance capability row, and (for accountless devices) the
 * distinct performance policy row can authorize this dialect.  No usage
 * successor authorization table is joined here.
 */
export async function assertTelemetryPerformanceWriteAllowed(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  authorization: unknown,
  nowEpoch = Date.now(),
): Promise<TelemetryPerformanceAuthorization> {
  const auth = parseTelemetryPerformanceAuthorization(authorization, nowEpoch);
  const row = await readPerformanceCapabilityRow(db, principal, nowEpoch);
  if (!row
      || row.participant_id !== principal.participantId
      || row.device_id !== principal.deviceId
      || row.capability_revision !== auth.capabilityRevision
      || row.authority_epoch !== auth.authorityEpoch
      || row.schema_version !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || row.field_dictionary_version !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || row.scope !== TELEMETRY_PERFORMANCE_SCOPE
      || !instant(row.issued_at) || !instant(row.expires_at)
      || row.expires_at !== auth.expiresAt) {
    invalid();
  }
  return auth;
}

/**
 * Read the current independent grant for a device.  This is the capability
 * endpoint's sole source of truth; accountless devices must have the separate
 * performance owner-policy row, even when their usage authorization exists.
 */
export async function readTelemetryPerformanceCapability(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  nowEpoch = Date.now(),
): Promise<TelemetryPerformanceCapability> {
  const row = await readPerformanceCapabilityRow(db, principal, nowEpoch);
  if (!row) invalid();
  return telemetryPerformanceCapabilityResponse(row);
}

/**
 * Establish the accountless performance grant inside the owner flow.  The
 * usage v1.2 authorization is intentionally not consulted; this inserts the
 * performance policy row and its capability tuple only after the active
 * accountless lease and staged performance runtime are re-proved.
 */
export async function grantTelemetryPerformanceAccountlessAuthorization(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  request: TelemetryPerformanceAccountlessAuthorizationRequest,
  nowEpoch = Date.now(),
): Promise<void> {
  if (!exact(request, ["authorizationBasis", "policyVersion", "schemaVersion"])
      || request.schemaVersion !== ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION
      || request.policyVersion !== ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION
      || request.authorizationBasis !== ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS) {
    invalid("TELEMETRY_CONSENT_INVALID");
  }
  const now = new Date(nowEpoch).toISOString();
  const owner = await db.prepare(
    `SELECT owner.enrollment_device_id, owner.expires_at
       FROM accountless_upload_owners owner
       JOIN accountless_enrollment_ledger ledger
         ON ledger.device_id = owner.enrollment_device_id
       JOIN participants p ON p.id = owner.participant_id
       JOIN device_credentials d ON d.id = owner.device_credential_id
       JOIN telemetry_performance_runtime r ON r.id = 1
      WHERE owner.participant_id = ? AND owner.device_credential_id = ?
        AND owner.state = 'active' AND owner.expires_at > ?
        AND ledger.state = 'active' AND ledger.expires_at = owner.expires_at
        AND p.state = 'active' AND p.owner_kind = 'accountless'
        AND d.state = 'active' AND d.authority_kind = 'accountless'
        AND d.accountless_enrollment_device_id = owner.enrollment_device_id
        AND d.expires_at = owner.expires_at
        AND r.state = 'active'
        AND r.schema_version = ? AND r.field_dictionary_version = ?
        AND r.privacy_contract_version = ?`,
  ).bind(principal.participantId, principal.deviceId, now,
    PERFORMANCE_RECORD_SCHEMA_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION,
    PERFORMANCE_PRIVACY_CONTRACT_VERSION)
    .first<{ enrollment_device_id: string; expires_at: string }>();
  if (!owner) invalid();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO accountless_telemetry_performance_authorizations (
          enrollment_device_id, participant_id, device_credential_id,
          schema_version, policy_version, authorization_basis,
          performance_schema_version, field_dictionary_version, privacy_contract_version,
          scope, capability_revision, authority_epoch, authorized_at, expires_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'active')
         ON CONFLICT(enrollment_device_id) DO NOTHING`,
      ).bind(owner.enrollment_device_id, principal.participantId, principal.deviceId,
        ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION,
        ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION,
        ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
        PERFORMANCE_RECORD_SCHEMA_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION,
        PERFORMANCE_PRIVACY_CONTRACT_VERSION, TELEMETRY_PERFORMANCE_SCOPE,
        now, owner.expires_at),
      db.prepare(
        `INSERT INTO telemetry_performance_device_capabilities (
          participant_id, device_id, schema_version, field_dictionary_version,
          privacy_contract_version, scope, capability_revision, authority_epoch,
          issued_at, expires_at, state, consented_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'accepted', ?)
         ON CONFLICT(participant_id, device_id) DO NOTHING`,
      ).bind(principal.participantId, principal.deviceId,
        PERFORMANCE_RECORD_SCHEMA_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION,
        PERFORMANCE_PRIVACY_CONTRACT_VERSION, TELEMETRY_PERFORMANCE_SCOPE,
        now, owner.expires_at, now),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes("accountless telemetry performance authorization unavailable")
        || message.includes("telemetry_performance_capability_unavailable")) {
      invalid("TELEMETRY_CONSENT_INVALID");
    }
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

/**
 * Establish the social-device performance grant from its own explicit
 * consent.  This never reads or upgrades a usage consent row: the
 * performance capability is inserted only after the staged performance
 * runtime and the social participant/device relationship are re-proved.
 */
export async function grantTelemetryPerformanceSocialAuthorization(
  db: D1Database,
  principal: TelemetryPerformancePrincipal,
  consent: unknown,
  nowEpoch = Date.now(),
): Promise<TelemetryPerformanceCapability> {
  const parsed = parseTelemetryPerformanceConsent(consent);
  const now = new Date(nowEpoch).toISOString();
  const row = await db.prepare(
    `SELECT d.expires_at
       FROM telemetry_performance_runtime r
       JOIN participants p ON p.id = ?
       JOIN device_credentials d ON d.id = ? AND d.participant_id = p.id
      WHERE r.id = 1 AND r.state = 'active'
        AND p.state = 'active' AND p.owner_kind = 'social'
        AND d.state = 'active' AND d.authority_kind = 'social'
        AND r.schema_version = ?
        AND r.field_dictionary_version = ?
        AND r.privacy_contract_version = ?
        AND d.expires_at > ?`,
  ).bind(principal.participantId, principal.deviceId,
    PERFORMANCE_RECORD_SCHEMA_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION,
    PERFORMANCE_PRIVACY_CONTRACT_VERSION, now).first<{ expires_at: string }>();
  if (!row || !instant(row.expires_at) || Date.parse(row.expires_at) <= nowEpoch) invalid("TELEMETRY_CONSENT_INVALID");
  try {
    await db.prepare(
      `INSERT INTO telemetry_performance_device_capabilities (
        participant_id, device_id, schema_version, field_dictionary_version,
        privacy_contract_version, scope, capability_revision, authority_epoch,
        issued_at, expires_at, state, consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'accepted', ?)
       ON CONFLICT(participant_id, device_id) DO NOTHING`,
    ).bind(principal.participantId, principal.deviceId,
      parsed.schemaVersion, parsed.fieldDictionaryVersion,
      parsed.privacyContractVersion, parsed.scope, now, row.expires_at, now).run();
  } catch (error) {
    const message = String(error);
    if (message.includes("telemetry_performance_capability_unavailable")) {
      invalid("TELEMETRY_CONSENT_INVALID");
    }
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return readTelemetryPerformanceCapability(db, principal, nowEpoch);
}

export function telemetryPerformanceCapabilityResponse(
  row: PerformanceCapabilityRow,
): TelemetryPerformanceCapability {
  if (row.state !== "accepted") invalid();
  return Object.freeze({
    schemaVersion: TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION,
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS,
    requiredConsent: {
      schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
      fieldDictionaryVersion: PERFORMANCE_FIELD_DICTIONARY_VERSION,
      privacyContractVersion: PERFORMANCE_PRIVACY_CONTRACT_VERSION,
      scope: TELEMETRY_PERFORMANCE_SCOPE,
    },
    authorization: {
      schemaVersion: TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION,
      capabilityRevision: row.capability_revision,
      authorityEpoch: row.authority_epoch,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      scope: TELEMETRY_PERFORMANCE_SCOPE,
    },
  });
}
