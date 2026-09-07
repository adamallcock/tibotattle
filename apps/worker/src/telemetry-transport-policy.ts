import {
  isTelemetryV11ConsentCurrent,
  telemetryV11RequiredConsent,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV11Consent,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { sha256Hex } from "./crypto";
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";

export interface TelemetryTransportPrincipal {
  participantId: string;
  deviceId: string;
}

export type TelemetryTransportSchemaVersion =
  | "telemetry-contribution-v0.1" | "telemetry-contribution-v0.2"
  | "telemetry-contribution-v1.0" | "telemetry-contribution-v1.1";

const SCHEMAS: readonly string[] = [
  "telemetry-contribution-v0.1", "telemetry-contribution-v0.2",
  "telemetry-contribution-v1.0", "telemetry-contribution-v1.1",
];

export function telemetryTransportSchemaVersion(value: unknown): TelemetryTransportSchemaVersion {
  if (typeof value !== "string" || !SCHEMAS.includes(value)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  return value as TelemetryTransportSchemaVersion;
}

export function telemetryTransportSchemaForEnvelope(value: unknown): TelemetryTransportSchemaVersion {
  if (typeof value !== "string" || !/^telemetry-envelope-v(?:0\.[12]|1\.[01])$/u.test(value)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  return telemetryTransportSchemaVersion(value.replace("envelope", "contribution"));
}

/** Shared by registration, decrypted ingest, staging and final activation. */
export async function assertTelemetryTransportWriteAllowed(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  schemaVersion: TelemetryTransportSchemaVersion,
): Promise<void> {
  const schema = telemetryTransportSchemaVersion(schemaVersion);
  const row = await db.prepare(
    `SELECT formats.lifecycle, formats.format_rank, floors.minimum_rank,
            CASE WHEN grant_v11.device_id IS NULL THEN 0 ELSE 1 END AS consent_v11,
            EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_history
       FROM participants p
       JOIN device_credentials d ON d.participant_id = p.id
       JOIN telemetry_transport_participant_floors floors ON floors.participant_id = p.id
       JOIN telemetry_transport_formats formats ON formats.schema_version = ?
       LEFT JOIN telemetry_v11_device_consents grant_v11
         ON grant_v11.participant_id = p.id AND grant_v11.device_id = d.id
      WHERE p.id = ? AND d.id = ? AND p.state = 'active' AND d.state = 'active'`,
  ).bind(schema, principal.participantId, principal.deviceId).first<{
    lifecycle: string; format_rank: number; minimum_rank: number; consent_v11: number; incompatible_history: number;
  }>();
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  if (row.lifecycle !== "accepted" || row.format_rank < row.minimum_rank
      || (schema === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION && row.incompatible_history === 1)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (schema === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION && row.consent_v11 !== 1) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
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
      WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'
        AND s.id = ? AND s.scope = 'personal' AND s.state = 'active' AND s.expires_at > ?
        AND f.lifecycle = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
          WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
            AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')`,
  ).bind(TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION, principal.participantId,
    principal.deviceId, principal.sessionId, now).first<{id: string}>();
  if (!row) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  try {
    const result = await db.batch<{ minimum_rank: number }>([
      db.prepare(
        `INSERT INTO telemetry_v11_device_consents (
          participant_id, device_id, telemetry_schema_version, field_dictionary_version,
          privacy_contract_version, consented_at
        ) SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM web_sessions s WHERE s.id = ? AND s.participant_id = ?
              AND s.state = 'active' AND s.scope = 'personal' AND s.expires_at > ?)
          ON CONFLICT(participant_id, device_id) DO NOTHING`,
      ).bind(principal.participantId, principal.deviceId, consent.telemetrySchemaVersion,
        consent.fieldDictionaryVersion, consent.privacyContractVersion, now,
        principal.sessionId, principal.participantId, now),
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
    ]);
    if (result[2]?.results[0]?.minimum_rank !== 11) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
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
  const row = await db.prepare(
    `SELECT e.namespace, f.minimum_rank, f.revision,
            CASE WHEN c.device_id IS NULL THEN 0 ELSE 1 END AS consent_v11,
            EXISTS (SELECT 1 FROM telemetry_contributions legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_history
       FROM participants p JOIN attribution_enrollments e ON e.participant_id = p.id
       JOIN telemetry_transport_participant_floors f ON f.participant_id = p.id
       JOIN device_credentials d ON d.participant_id = p.id
       LEFT JOIN telemetry_v11_device_consents c ON c.participant_id = p.id AND c.device_id = d.id
      WHERE p.id = ? AND p.state = 'active' AND d.id = ? AND d.state = 'active'`,
  ).bind(principal.participantId, principal.deviceId).first<{
    namespace: string; minimum_rank: number; revision: number; consent_v11: number; incompatible_history: number;
  }>();
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const formats = await db.prepare(
    "SELECT schema_version, format_rank, lifecycle FROM telemetry_transport_formats ORDER BY format_rank LIMIT 5",
  ).all<{ schema_version: string; format_rank: number; lifecycle: "accepted" | "staged" | "blocked" }>();
  if (formats.results.length !== 4) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return {
    schemaVersion: "device-sync-capabilities-v1.1" as const,
    destinationOrigin,
    enrollmentNamespace: row.namespace,
    identityVersion: "account-track-v2" as const,
    minimumWriteRank: row.minimum_rank,
    policyRevision: row.revision,
    requiredConsent: telemetryV11RequiredConsent(),
    consentCurrent: row.consent_v11 === 1,
    formats: formats.results.map((format) => ({
      schemaVersion: format.schema_version,
      rank: format.format_rank,
      lifecycle: row.incompatible_history === 1 && format.schema_version === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
        ? "blocked" as const : format.lifecycle,
    })),
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
  return [
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
