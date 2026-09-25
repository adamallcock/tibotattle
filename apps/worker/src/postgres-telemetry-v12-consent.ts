import {
  isTelemetryV12ConsentCurrent,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12RequiredConsent,
  type TelemetryV12Consent,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { TELEMETRY_CONSENT_VERSION } from "./constants";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

export interface PostgresTelemetryV12ConsentPrincipal {
  readonly participantId: string;
  readonly sessionId: string;
  readonly deviceId: string;
}

export interface PostgresTelemetryV12ConsentOptions {
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
}

interface ConsentAuthorityRow {
  readonly runtime_state: string;
  readonly typed_runtime_state: string;
  readonly typed_schema_version: string;
  readonly typed_envelope_schema_version: string;
  readonly typed_dictionary_version: string;
  readonly typed_privacy_version: string;
  readonly participant_state: string;
  readonly participant_owner_kind: string;
  readonly participant_consent_version: string | null;
  readonly device_participant_id: string;
  readonly device_authority_kind: string;
  readonly device_state: string;
  readonly device_expires_at: Date | string;
  readonly session_participant_id: string;
  readonly session_state: string;
  readonly session_scope: string;
  readonly session_expires_at: Date | string;
}

interface CollectionControlRow {
  readonly control_state: unknown;
  readonly enrollment_enabled: unknown;
  readonly upload_registration_enabled: unknown;
  readonly processing_enabled: unknown;
  readonly publication_enabled: unknown;
  readonly revision: unknown;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function blocked(): ApiError {
  return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
}

function instantEpoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function assertCollectionControl(row: CollectionControlRow | undefined): void {
  const flags = [row?.enrollment_enabled, row?.upload_registration_enabled,
    row?.processing_enabled, row?.publication_enabled];
  const revision = typeof row?.revision === "number" ? row.revision : Number(row?.revision);
  if (row === undefined
      || !["operational", "degraded", "contained"].includes(String(row.control_state))
      || flags.some((flag) => typeof flag !== "boolean")
      || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const enabledCount = flags.filter((flag) => flag === true).length;
  if ((row.control_state === "operational" && enabledCount !== 4)
      || (row.control_state === "contained" && enabledCount !== 0)
      || (row.control_state === "degraded" && (enabledCount === 0 || enabledCount === 4))) {
    throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  if (row.upload_registration_enabled !== true) {
    throw new ApiError(503, "UPLOAD_REGISTRATION_DISABLED");
  }
}

/** Grant the social device's explicit v1.2 consent under its personal session. */
export async function grantPostgresTelemetryV12Consent(
  pool: PostgresPool,
  principal: PostgresTelemetryV12ConsentPrincipal,
  consent: unknown,
  options: PostgresTelemetryV12ConsentOptions = {},
): Promise<Readonly<{
  consent: TelemetryV12Consent;
  schemaVersion: typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
}>> {
  if (!isTelemetryV12ConsentCurrent(consent)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  if (principal === null || typeof principal !== "object"
      || typeof principal.participantId !== "string" || principal.participantId.length === 0
      || typeof principal.sessionId !== "string" || principal.sessionId.length === 0
      || typeof principal.deviceId !== "string" || principal.deviceId.length === 0) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = new Date(nowEpoch);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(now.getTime())) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const schema = quotePostgresIdentifier(
    createPostgresSchemaConfig(options.schema).primarySchema,
  );

  try {
    await withPostgresMutation(pool, async (client) => {
      // Lock collection controls with the participant, session, device, and
      // both runtime pins so a concurrent pause, revocation, or deactivation
      // cannot slip between policy checks and the grant write.
      const controls = await client.query<CollectionControlRow>(
        `SELECT control_state, enrollment_enabled, upload_registration_enabled,
                processing_enabled, publication_enabled, revision
           FROM ${schema}."collection_controls"
          WHERE singleton = 1
          FOR SHARE`,
      );
      assertCollectionControl(controls.rows[0]);

      const authority = await client.query<ConsentAuthorityRow>(
        `SELECT runtime.state AS runtime_state,
                typed_runtime.state AS typed_runtime_state,
                typed_runtime.schema_version AS typed_schema_version,
                typed_runtime.envelope_schema_version AS typed_envelope_schema_version,
                typed_runtime.field_dictionary_version AS typed_dictionary_version,
                typed_runtime.privacy_contract_version AS typed_privacy_version,
                participant.state AS participant_state,
                participant.owner_kind AS participant_owner_kind,
                participant.consent_version AS participant_consent_version,
                device.participant_id AS device_participant_id,
                device.authority_kind AS device_authority_kind,
                device.state AS device_state,
                device.expires_at AS device_expires_at,
                session.participant_id AS session_participant_id,
                session.state AS session_state,
                session.scope AS session_scope,
                session.expires_at AS session_expires_at
           FROM ${schema}."telemetry_v12_runtime" runtime
           JOIN ${schema}."telemetry_v12_typed_runtime" typed_runtime ON typed_runtime.id = 1
           JOIN ${schema}."participants" participant ON participant.id = $1
           JOIN ${schema}."device_credentials" device
             ON device.id = $2 AND device.participant_id = participant.id
           JOIN ${schema}."web_sessions" session
             ON session.id = $3 AND session.participant_id = participant.id
          WHERE runtime.id = 1
          FOR UPDATE OF runtime, typed_runtime, participant, device, session`,
        [principal.participantId, principal.deviceId, principal.sessionId],
      );
      const row = authority.rows[0];
      if (!row
          || row.runtime_state !== "active"
          || row.typed_runtime_state !== "active"
          || row.typed_schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
          || row.typed_envelope_schema_version !== "telemetry-envelope-v1.2"
          || row.typed_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
          || row.typed_privacy_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
          || row.participant_state !== "active"
          || row.participant_owner_kind !== "social"
          || row.device_participant_id !== principal.participantId
          || row.device_authority_kind !== "social"
          || row.device_state !== "active"
          || instantEpoch(row.device_expires_at) <= nowEpoch
          || row.session_participant_id !== principal.participantId
          || row.session_state !== "active"
          || row.session_scope !== "personal"
          || instantEpoch(row.session_expires_at) <= nowEpoch) {
        throw blocked();
      }
      if (row.participant_consent_version !== TELEMETRY_CONSENT_VERSION) {
        throw new ApiError(400, "TELEMETRY_REQUIRED");
      }

      const granted = await client.query<{
        readonly participant_id: string;
        readonly device_id: string;
        readonly state: string;
        readonly telemetry_schema_version: string;
        readonly field_dictionary_version: string;
        readonly privacy_contract_version: string;
      }>(
        `INSERT INTO ${schema}."telemetry_v12_device_capabilities" (
           participant_id, device_id, telemetry_schema_version,
           field_dictionary_version, privacy_contract_version, state, consented_at
         ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6::timestamptz)
         ON CONFLICT (participant_id, device_id) DO UPDATE SET
           state = 'accepted', revoked_at = NULL
         WHERE telemetry_v12_device_capabilities.telemetry_schema_version = EXCLUDED.telemetry_schema_version
           AND telemetry_v12_device_capabilities.field_dictionary_version = EXCLUDED.field_dictionary_version
           AND telemetry_v12_device_capabilities.privacy_contract_version = EXCLUDED.privacy_contract_version
         RETURNING participant_id, device_id, state, telemetry_schema_version,
                   field_dictionary_version, privacy_contract_version`,
        [principal.participantId, principal.deviceId,
          consent.telemetrySchemaVersion, consent.fieldDictionaryVersion,
          consent.privacyContractVersion, now.toISOString()],
      );
      const capability = granted.rows[0];
      if (granted.rowCount !== 1 || !capability
          || capability.participant_id !== principal.participantId
          || capability.device_id !== principal.deviceId
          || capability.state !== "accepted"
          || capability.telemetry_schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
          || capability.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
          || capability.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION) {
        throw blocked();
      }
    }, {
      operation: "telemetry_v12_consent.grant",
      statementTimeoutMilliseconds: 5_000,
      lockTimeoutMilliseconds: 2_000,
      preserveSafeError: safeError,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Provider errors are deliberately reduced to the established public
    // storage code; SQL, values, and driver messages never leave this adapter.
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }

  return Object.freeze({
    consent: telemetryV12RequiredConsent(),
    schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  });
}
