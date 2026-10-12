import { TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  assertPostgresTypedV12WriteAllowed,
  type PostgresTypedV12Principal,
} from "./postgres-typed-v12-admission";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";

export type PostgresTelemetryTransportSchemaVersion =
  | "telemetry-contribution-v0.1"
  | "telemetry-contribution-v0.2"
  | "telemetry-contribution-v1.0"
  | "telemetry-contribution-v1.1"
  | typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;

export interface PostgresTelemetryFormatAuthorityOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

interface LegacyTransportAuthorityRow {
  participant_state: string;
  owner_kind: string;
  authority_kind: string;
  device_state: string;
  device_expires_at: string | Date;
  lifecycle: string;
  format_rank: number;
  minimum_rank: number;
  participant_minimum_rank: number;
  device_minimum_rank: number | null;
  consent_v11: boolean;
  accountless_v11: boolean;
  incompatible_history: boolean;
}

const LEGACY_FORMATS = new Set<string>([
  "telemetry-contribution-v0.1",
  "telemetry-contribution-v0.2",
  "telemetry-contribution-v1.0",
  "telemetry-contribution-v1.1",
]);
const V11_SCHEMA = "telemetry-contribution-v1.1";
const V02_SCHEMA = "telemetry-contribution-v0.2";
const V10_SCHEMA = "telemetry-contribution-v1.0";
const CONSENT_V11_DICTIONARY = "telemetry-v1.1-registry-2026-08-31.1";
const CONSENT_V11_PRIVACY = "ongoing-privacy-safe-telemetry-v1.1";

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function backendError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function transportVersion(value: unknown): PostgresTelemetryTransportSchemaVersion {
  if (typeof value === "string"
      && (LEGACY_FORMATS.has(value) || value === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION)) {
    return value as PostgresTelemetryTransportSchemaVersion;
  }
  throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
}

function authoritySchema(options: PostgresTelemetryFormatAuthorityOptions): string {
  return quotePostgresIdentifier(
    createPostgresSchemaConfig(options.schema ?? {}).primarySchema,
  );
}

function requestTime(nowEpoch: number): Date {
  const value = new Date(nowEpoch);
  if (!Number.isSafeInteger(nowEpoch) || !Number.isFinite(value.getTime())) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return value;
}

function validPrincipal(principal: TelemetryTransportPrincipal): boolean {
  return principal !== null && typeof principal === "object"
    && typeof principal.participantId === "string" && principal.participantId.length > 0
    && typeof principal.deviceId === "string" && principal.deviceId.length > 0;
}

async function assertLegacyFormatAllowed(
  pool: PostgresPool,
  schema: string,
  principal: TelemetryTransportPrincipal,
  version: Exclude<PostgresTelemetryTransportSchemaVersion, typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION>,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const result = await withPostgresRead(
    pool,
    (client) => client.query<LegacyTransportAuthorityRow>(
      `SELECT p.state AS participant_state, p.owner_kind,
            d.authority_kind, d.state AS device_state, d.expires_at AS device_expires_at,
            formats.lifecycle, formats.format_rank,
            COALESCE(device_floors.minimum_rank, floors.minimum_rank) AS minimum_rank,
            floors.minimum_rank AS participant_minimum_rank,
            device_floors.minimum_rank AS device_minimum_rank,
            EXISTS (
              SELECT 1 FROM ${table(schema, "telemetry_v11_device_consents")} consent
               WHERE consent.participant_id = p.id AND consent.device_id = d.id
                 AND consent.telemetry_schema_version = '${V11_SCHEMA}'
                 AND consent.field_dictionary_version = '${CONSENT_V11_DICTIONARY}'
                 AND consent.privacy_contract_version = '${CONSENT_V11_PRIVACY}'
            ) AS consent_v11,
            EXISTS (
              SELECT 1
                FROM ${table(schema, "accountless_enrollment_ledger")} ledger
                JOIN ${table(schema, "accountless_upload_owners")} owner
                  ON owner.enrollment_device_id = ledger.device_id
                 AND owner.participant_id = p.id AND owner.device_credential_id = d.id
                 AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
                JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
                  ON grant_row.enrollment_device_id = ledger.device_id
                 AND grant_row.participant_id = p.id AND grant_row.device_credential_id = d.id
                 AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at
               WHERE ledger.device_id = d.accountless_enrollment_device_id
                 AND ledger.state = 'active' AND ledger.expires_at = d.expires_at
                 AND ledger.expires_at > $4
            ) AS accountless_v11,
            EXISTS (
              SELECT 1 FROM ${table(schema, "telemetry_contributions")} legacy
               WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                 AND legacy.transport_schema_version = '${V02_SCHEMA}'
            ) AS incompatible_history
       FROM ${table(schema, "participants")} p
       JOIN ${table(schema, "device_credentials")} d ON d.participant_id = p.id
       JOIN ${table(schema, "telemetry_transport_participant_floors")} floors
         ON floors.participant_id = p.id
       JOIN ${table(schema, "telemetry_transport_formats")} formats
         ON formats.schema_version = $3
       LEFT JOIN ${table(schema, "telemetry_transport_device_floors")} device_floors
         ON device_floors.participant_id = p.id AND device_floors.device_id = d.id
        WHERE p.id = $1 AND d.id = $2 AND p.state = 'active' AND d.state = 'active'
          AND d.expires_at > $4`,
      [principal.participantId, principal.deviceId, version, nowIso],
    ),
    { operation: "telemetry_transport.authority", preserveSafeError: safeError },
  );

  const row = result.rows[0];
  if (!row || !Number.isSafeInteger(row.format_rank)
      || !Number.isSafeInteger(row.minimum_rank)
      || !Number.isSafeInteger(row.participant_minimum_rank)
      || (row.device_minimum_rank !== null && !Number.isSafeInteger(row.device_minimum_rank))) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const deviceExpiry = row.device_expires_at instanceof Date
    ? row.device_expires_at.getTime() : Date.parse(row.device_expires_at);
  if (row.participant_state !== "active" || row.device_state !== "active"
      || !Number.isFinite(deviceExpiry) || deviceExpiry <= now.getTime()
      || row.owner_kind !== row.authority_kind
      || (row.owner_kind !== "social" && row.owner_kind !== "accountless")
      || (row.authority_kind !== "social" && row.authority_kind !== "accountless")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  const accountless = row.owner_kind === "accountless";
  if ((accountless && row.authority_kind !== "accountless")
      || (!accountless && row.authority_kind !== "social")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (version === V10_SCHEMA && row.lifecycle === "accepted"
      && row.format_rank >= row.minimum_rank) {
    // D1's assertion uses COALESCE(device, participant), while the existing
    // PostgreSQL v1.0 writer trigger uses GREATEST(participant, device). If
    // the D1 floor admits this format but the writer trigger would reject it,
    // do not issue authorization that cannot be honored by the PG write path.
    const writerMinimumRank = Math.max(
      row.participant_minimum_rank,
      row.device_minimum_rank ?? 1,
    );
    if (row.format_rank < writerMinimumRank) {
      throw new ApiError(503, "POSTGRES_REQUEST_PATH_UNSUPPORTED");
    }
  }
  if (row.lifecycle !== "accepted" || row.format_rank < row.minimum_rank
      || (version === V11_SCHEMA && row.incompatible_history)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (accountless && version !== V11_SCHEMA) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (version === V11_SCHEMA
      && (accountless ? !row.accountless_v11 : !row.consent_v11)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
}

/**
 * Check the current format admission policy for a device in PostgreSQL.
 * Legacy formats use their live lifecycle/floor rows; v1.2 delegates to the
 * normalized successor authority adapter because it has a separate runtime
 * and capability contract rather than a legacy participant floor. Callers
 * must authenticate the device first; that bearer check also enforces the
 * shared accountless v1.1 grant before a v1.2 upload is authorized.
 * This is policy parity, not proof that an HTTP writer is qualified: v0.1 and
 * v1.1 PostgreSQL application writers have not been ported, and v0.2 is
 * blocked. A policy pass for those versions must not be treated as routable.
 */
export async function assertPostgresTelemetryTransportWriteAllowed(
  pool: PostgresPool,
  principal: TelemetryTransportPrincipal,
  schemaVersion: unknown,
  options: PostgresTelemetryFormatAuthorityOptions = {},
): Promise<void> {
  const version = transportVersion(schemaVersion);
  if (!validPrincipal(principal)) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = requestTime(nowEpoch);
  const schema = authoritySchema(options);

  try {
    if (version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION) {
      await withPostgresMutation(
        pool,
        (client) => assertPostgresTypedV12WriteAllowed(
          client,
          principal as PostgresTypedV12Principal,
          nowEpoch,
          { schema: options.schema },
        ),
        { operation: "telemetry_transport.v12_authority", preserveSafeError: safeError },
      );
      return;
    }
    await assertLegacyFormatAllowed(pool, schema, principal, version, now);
  } catch (error) {
    backendError(error);
  }
}
