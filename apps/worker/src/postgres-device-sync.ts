import {
  telemetryV12RequiredConsent,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import { sha256Hex } from "./crypto";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION } from "./telemetry-v1";

const MAX_SYNC_STATE_CHUNKS = 100_000;
const LAUNCH_WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const LAUNCH_WEEK_CHUNKS_PER_DAY = 20_000;
const STEADY_STATE_CHUNKS_PER_DAY = 2_000;

interface RuntimeOptions {
  readonly schema?: PostgresSchemaConfig;
}

interface DeviceSyncStateOptions extends RuntimeOptions {
  readonly nowEpoch?: number;
}

interface DeviceSyncCapabilitiesOptions extends RuntimeOptions {
  readonly sourceNamespace: string;
  readonly nowEpoch?: number;
}

interface CurrentChunkDigestRow {
  chunk_day: string;
  stream: "usage" | "quota" | "session";
  chunk_seq: number;
  chunk_digest: string;
}

interface AdmissionRow {
  accepted_count: number | string | null;
  device_issued_at: string | Date;
}

interface CapabilitiesRow {
  namespace: string;
  owner_kind: "social" | "accountless";
  authority_kind: "social" | "accountless";
  legacy_runtime_state: "staged" | "active" | "blocked" | null;
  runtime_state: "staged" | "active" | null;
  schema_version: string | null;
  envelope_schema_version: string | null;
  field_dictionary_version: string | null;
  privacy_contract_version: string | null;
  social_state: "accepted" | "revoked" | null;
  social_consented_at: string | Date | null;
  accountless_state: "active" | "revoked" | null;
  accountless_schema_identity: string | null;
  accountless_authorized_at: string | Date | null;
  accountless_expires_at: string | Date | null;
  accountless_policy_version: string | null;
  accountless_authorization_basis: string | null;
  accountless_schema_version: string | null;
  accountless_dictionary_version: string | null;
  accountless_privacy_version: string | null;
}

function schemaName(options: RuntimeOptions): string {
  return `"${createPostgresSchemaConfig(options.schema ?? {}).primarySchema}"`;
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function nowIso(nowEpoch: number): string {
  const value = new Date(nowEpoch);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(value.getTime())) {
    throw new ApiError(500, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return value.toISOString();
}

function timestampEpoch(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function nextUtcMidnight(nowEpoch: number): string {
  const next = new Date(nowEpoch);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

async function readCurrentChunkDigests(
  client: PostgresClient,
  schema: string,
  participantId: string,
  deviceId: string,
): Promise<CurrentChunkDigestRow[]> {
  const result = await client.query<CurrentChunkDigestRow>(
    `SELECT chunk_day::text AS chunk_day, stream, chunk_seq, chunk_digest
       FROM ${table(schema, "telemetry_v1_chunks")}
      WHERE participant_id = $1 AND device_id = $2 AND superseded_at IS NULL
      ORDER BY chunk_day ASC, stream COLLATE "C" ASC, chunk_seq ASC
      LIMIT $3`,
    [participantId, deviceId, MAX_SYNC_STATE_CHUNKS + 1],
  );
  if (result.rows.length > MAX_SYNC_STATE_CHUNKS) {
    throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return [...result.rows];
}

async function readAdmission(
  client: PostgresClient,
  schema: string,
  participantId: string,
  deviceId: string,
  nowEpoch: number,
): Promise<Readonly<Record<string, unknown>>> {
  const windowDay = nowIso(nowEpoch).slice(0, 10);
  const result = await client.query<AdmissionRow>(
    `SELECT device.issued_at AS device_issued_at,
            windows.accepted_count AS accepted_count
       FROM ${table(schema, "device_credentials")} device
       LEFT JOIN ${table(schema, "telemetry_v1_chunk_admission_windows")} windows
         ON windows.participant_id = $1
        AND windows.device_id = device.id
        AND windows.window_day = $2::date
      WHERE device.id = $3 AND device.participant_id = $1`,
    [participantId, windowDay, deviceId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const issuedEpoch = timestampEpoch(row.device_issued_at);
  const launchWeek = Number.isFinite(issuedEpoch)
    && nowEpoch - issuedEpoch < LAUNCH_WEEK_MILLISECONDS;
  const maximumChunks = launchWeek
    ? LAUNCH_WEEK_CHUNKS_PER_DAY : STEADY_STATE_CHUNKS_PER_DAY;
  const acceptedChunks = Math.max(0, Math.min(
    LAUNCH_WEEK_CHUNKS_PER_DAY,
    Number(row.accepted_count ?? 0),
  ));
  const remainingChunks = Math.max(0, maximumChunks - acceptedChunks);
  return Object.freeze({
    schemaVersion: "telemetry-chunk-admission-v1.0",
    state: remainingChunks > 0 ? "available" : "exhausted",
    windowDay,
    budget: launchWeek ? "launch_week" : "steady_state",
    acceptedChunks,
    remainingChunks,
    maximumChunks,
    retryAt: nextUtcMidnight(nowEpoch),
  });
}

/** Read the frozen v1.0 device cursor response from one bounded PG snapshot. */
export async function readPostgresDeviceSyncState(
  pool: PostgresPool,
  participantId: string,
  deviceId: string,
  options: DeviceSyncStateOptions = {},
) {
  const schema = schemaName(options);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const result = await withPostgresRead(pool, async (client) => {
    const chunks = await readCurrentChunkDigests(client, schema, participantId, deviceId);
    const admission = await readAdmission(client, schema, participantId, deviceId, nowEpoch);
    return { chunks, admission };
  }, {
    operation: "device_sync.state",
    statementTimeoutMilliseconds: 10_000,
    lockTimeoutMilliseconds: 1_000,
    preserveSafeError: safeError,
  });

  const days = new Map<string, string[]>();
  for (const row of result.chunks) {
    const digests = days.get(row.chunk_day);
    if (digests) digests.push(row.chunk_digest);
    else days.set(row.chunk_day, [row.chunk_digest]);
  }
  const orderedDays = [...days.entries()].sort(([left], [right]) => left.localeCompare(right));
  const dayDigests = await Promise.all(orderedDays.map(async ([, digests]) =>
    sha256Hex(digests.join(""))));
  return Object.freeze({
    schemaVersion: "device-sync-state-v1.0" as const,
    contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    acknowledgedThroughDay: orderedDays.at(-1)?.[0] ?? null,
    historyDigest: dayDigests.length === 0 ? null : await sha256Hex(dayDigests.join("")),
    dayCount: orderedDays.length,
    chunkCount: result.chunks.length,
    admission: result.admission,
  });
}

async function requireTypedStorageSourcePins(
  client: PostgresClient,
  schema: string,
  sourceNamespace: string,
): Promise<void> {
  if (typeof sourceNamespace !== "string" || sourceNamespace.length < 1
      || sourceNamespace.length > 256) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  let encodedNamespace: Uint8Array;
  try {
    encodedNamespace = encodeTypedTelemetryId(sourceNamespace);
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const result = await client.query<{ ready: boolean }>(
    `SELECT (
        EXISTS (
          SELECT 1 FROM ${table(schema, "typed_v1_admission_state")} state
          JOIN ${table(schema, "typed_telemetry_namespaces")} namespace
            ON namespace.id = state.namespace_id AND namespace.original_id = $2
          WHERE state.id = 1 AND state.source_namespace = $1
            AND state.runtime_contract_version = 1
        ) AND EXISTS (
          SELECT 1 FROM ${table(schema, "typed_v11_admission_state")} state
          JOIN ${table(schema, "typed_telemetry_namespaces")} namespace
            ON namespace.id = state.namespace_id AND namespace.original_id = $2
          WHERE state.id = 1 AND state.source_namespace = $1
            AND state.runtime_contract_version = 1
        )
      ) AS ready`,
    [sourceNamespace, encodedNamespace],
  );
  if (result.rows[0]?.ready !== true) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function readCapabilitiesRow(
  client: PostgresClient,
  schema: string,
  participantId: string,
  deviceId: string,
  now: string,
): Promise<CapabilitiesRow | null> {
  const result = await client.query<CapabilitiesRow>(
    `SELECT enrollment.namespace,
            participant.owner_kind, device.authority_kind,
            legacy_runtime.state AS legacy_runtime_state,
            typed_runtime.state AS runtime_state,
            typed_runtime.schema_version, typed_runtime.envelope_schema_version,
            typed_runtime.field_dictionary_version, typed_runtime.privacy_contract_version,
            social.state AS social_state, social.consented_at AS social_consented_at,
            accountless.state AS accountless_state,
            accountless.schema_version AS accountless_schema_identity,
            accountless.authorized_at AS accountless_authorized_at,
            accountless.expires_at AS accountless_expires_at,
            accountless.policy_version AS accountless_policy_version,
            accountless.authorization_basis AS accountless_authorization_basis,
            accountless.telemetry_schema_version AS accountless_schema_version,
            accountless.field_dictionary_version AS accountless_dictionary_version,
            accountless.privacy_contract_version AS accountless_privacy_version
       FROM ${table(schema, "participants")} participant
       JOIN ${table(schema, "attribution_enrollments")} enrollment
         ON enrollment.participant_id = participant.id
       JOIN ${table(schema, "device_credentials")} device
         ON device.participant_id = participant.id
       LEFT JOIN ${table(schema, "telemetry_v12_runtime")} legacy_runtime ON legacy_runtime.id = 1
       LEFT JOIN ${table(schema, "telemetry_v12_typed_runtime")} typed_runtime ON typed_runtime.id = 1
       LEFT JOIN ${table(schema, "telemetry_v12_device_capabilities")} social
         ON social.participant_id = participant.id AND social.device_id = device.id
       LEFT JOIN ${table(schema, "accountless_upload_owners")} owner
         ON owner.participant_id = participant.id AND owner.device_credential_id = device.id
        AND owner.state = 'active' AND owner.expires_at > $3::timestamptz
       LEFT JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
         ON ledger.device_id = owner.enrollment_device_id AND ledger.state = 'active'
        AND ledger.expires_at = owner.expires_at AND ledger.expires_at > $3::timestamptz
       LEFT JOIN ${table(schema, "accountless_v12_device_authorizations")} accountless
         ON accountless.participant_id = participant.id
        AND accountless.device_credential_id = device.id
        AND accountless.enrollment_device_id = owner.enrollment_device_id
        AND ledger.device_id IS NOT NULL
      WHERE participant.id = $1 AND participant.state = 'active'
        AND device.id = $2 AND device.state = 'active' AND device.expires_at > $3::timestamptz`,
    [participantId, deviceId, now],
  );
  return result.rows[0] ?? null;
}

/** Read the separately-negotiated v1.2 capability contract after matching
 * the Worker typed-storage source-pin requirement. */
export async function readPostgresDeviceSyncV12Capabilities(
  pool: PostgresPool,
  participantId: string,
  deviceId: string,
  destinationOrigin: string,
  options: DeviceSyncCapabilitiesOptions,
) {
  let origin: URL;
  try { origin = new URL(destinationOrigin); } catch {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (origin.origin !== destinationOrigin || (origin.protocol !== "https:"
      && !(origin.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const schema = schemaName(options);
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = nowIso(nowEpoch);
  const row = await withPostgresRead(pool, async (client) => {
    await requireTypedStorageSourcePins(client, schema, options.sourceNamespace);
    return readCapabilitiesRow(client, schema, participantId, deviceId, now);
  }, {
    operation: "device_sync.capabilities_v12",
    statementTimeoutMilliseconds: 10_000,
    lockTimeoutMilliseconds: 1_000,
    preserveSafeError: safeError,
  });
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
  const runtimePresent = row.runtime_state !== null && row.legacy_runtime_state !== null;
  const lifecycle = !runtimeExact || !runtimePresent
    ? "blocked" as const
    : row.runtime_state === "active" && row.legacy_runtime_state === "active"
      ? "accepted" as const : "staged" as const;
  const socialConsent = !accountless && row.social_state === "accepted";
  const accountlessExpires = row.accountless_expires_at === null
    ? null : timestampEpoch(row.accountless_expires_at);
  const accountlessGrant = accountless && row.accountless_state === "active"
    && accountlessExpires !== null && accountlessExpires > nowEpoch
    && row.accountless_schema_identity === "accountless-upload-owner-v1.2"
    && row.accountless_policy_version === "accountless-telemetry-v1.2-policy-v1"
    && row.accountless_authorization_basis === "accountless-policy-v1.2"
    && row.accountless_schema_version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && row.accountless_dictionary_version === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && row.accountless_privacy_version === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
  const consentedAt = row.social_consented_at;
  const authorizedAt = row.accountless_authorized_at;
  return Object.freeze({
    schemaVersion: "device-sync-capabilities-v1.2" as const,
    destinationOrigin,
    enrollmentNamespace: row.namespace,
    identityVersion: "account-track-v2" as const,
    authorityKind: accountless ? "accountless" as const : "social" as const,
    successor: Object.freeze({
      schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      envelopeSchemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
      lifecycle,
      requiredConsent: telemetryV12RequiredConsent(),
      consentCurrent: socialConsent,
      authorizationCurrent: lifecycle === "accepted" && (socialConsent || accountlessGrant),
      activationTime: socialConsent
        ? (consentedAt instanceof Date ? consentedAt.toISOString() : consentedAt)
        : accountlessGrant
          ? (authorizedAt instanceof Date ? authorizedAt.toISOString() : authorizedAt)
          : null,
    }),
  });
}
