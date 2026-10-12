import {
  canonicalTelemetryV12Json,
  isTelemetryV12ConsentCurrent,
  MAX_TELEMETRY_V12_CHUNK_RECORDS,
  MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES,
  MAX_TELEMETRY_V12_DAY_CHUNKS,
  parseTelemetryV12Chunk,
  parseTelemetryV12ChunkId,
  parseTelemetryV12DayManifest,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  validateTelemetryV12DayUsageOrder,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { sha256, sha256Hex } from "./crypto";
import { TELEMETRY_CONSENT_VERSION } from "./constants";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  classifyPostgresTelemetryV12StorageError,
  postgresTelemetryV12StorageFailure,
} from "./postgres-telemetry-v12-storage-refusal";
import {
  decodeTelemetryV12Record,
  encodeTelemetryV12Record,
  type TelemetryV12TypedAttribution,
  type TelemetryV12TypedRecordFields,
} from "./telemetry-v12-typed-codec";

export interface PostgresTypedV12Principal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface PostgresTypedV12ChunkMetadata {
  readonly chunkRowId: string;
  readonly r2Key: string;
  readonly envelopeDigest: string;
  readonly deviceUploadAuthorizationId: string;
}

export interface PostgresTypedV12DayCandidate {
  readonly manifestId: string;
  readonly day: string;
  readonly manifestDigest: string;
  readonly state: "staged" | "ready";
  readonly expectedChunks: number;
}

export interface PostgresTypedV12StagedChunkResult {
  readonly contributionId: string;
  readonly manifestId: string;
  readonly chunkId: string;
  readonly replay: boolean;
}

export interface PostgresTypedV12AdmissionOptions {
  readonly schema?: PostgresSchemaConfig;
}

interface RuntimeRow {
  schema_version: string;
  envelope_schema_version: string;
  field_dictionary_version: string;
  privacy_contract_version: string;
  state: string;
  policy_revision: number;
  max_day_chunks: number;
  max_chunk_records: number;
  max_day_bytes: number;
  legacy_state: string;
}

interface ManifestRow {
  id: string;
  chunk_day: string | Date;
  manifest_digest: string;
  expected_chunk_count: number;
  parser_version: string;
  state: "staged" | "ready";
  manifest_json: string;
  ready_at: string | Date | null;
}

interface ExistingChunkRow {
  id: string;
  manifest_id: string;
  chunk_id: string;
  chunk_digest: string;
  record_count: number;
}

interface TypedRecordIdRow {
  id: string;
  record_index: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const PARTICIPANT = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAX_MANIFEST_BYTES = 1_250_000;
const DAY_RECORD_SCAN_PAGE = 2_048;

function schemaName(options: PostgresTypedV12AdmissionOptions): string {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(config.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function isBytes(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || value instanceof Uint8Array;
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array(value.slice(0));
}

function hex(value: ArrayBuffer | Uint8Array): string {
  return [...bytes(value)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function byteKey(value: ArrayBuffer): string {
  return hex(value);
}

function attributionKey(value: TelemetryV12TypedAttribution): string {
  return [
    value.accountBasis,
    byteKey(value.accountTrack),
    value.planBasis,
    value.planType,
    byteKey(value.planEra),
  ].join("\u0000");
}

function dictionaries(fields: TelemetryV12TypedRecordFields): string[] {
  const values = new Set<string>([fields.provider]);
  if (fields.usage) {
    const usage = fields.usage;
    for (const value of [usage.model, usage.speedMode, usage.apiServiceTier, usage.surface,
      usage.billingSurface, usage.reasoningEffort, usage.agentScope, usage.outcome,
      usage.attribution.planType]) values.add(value);
  }
  if (fields.quota) {
    const quota = fields.quota;
    for (const value of [quota.planType, quota.planVariant, quota.limitId, quota.slot,
      quota.attribution.planType]) values.add(value);
  }
  for (const value of Object.keys(fields.tools ?? {})) values.add(value);
  return [...values];
}

function placeholders(rowCount: number, columnCount: number, firstIndex: number): string {
  let index = firstIndex;
  return Array.from({ length: rowCount }, () => {
    const row = Array.from({ length: columnCount }, () => `$${index++}`);
    return `(${row.join(", ")})`;
  }).join(", ");
}

function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return parsed;
}

function dateString(value: string | Date): string {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)
      || !Number.isFinite(Date.parse(`${result}T00:00:00.000Z`))
      || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return result;
}

function currentTime(epoch: number): Date {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8_640_000_000_000_000) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  return new Date(epoch);
}

// Classify the raw driver failure inside the transaction helper, before it is
// normalized: reviewed trigger refusals, telemetry_v12 unique keys and
// concurrent writers stay 409; any other constraint failure is the paced 503.
function safeStorageError(error: unknown): Error | null {
  return classifyPostgresTelemetryV12StorageError(error);
}

// Every other failure (commit-uncertain, begin, release, rollback, or a
// sanitized storage error) is an unpaced 503; nothing here throws a non-ApiError.
function stagingError(error: unknown): never {
  throw postgresTelemetryV12StorageFailure(error);
}

async function runtimeRow(client: PostgresClient, schema: string): Promise<RuntimeRow> {
  const result = await client.query<RuntimeRow>(
    `SELECT typed.schema_version, typed.envelope_schema_version, typed.field_dictionary_version,
            typed.privacy_contract_version, typed.state, typed.policy_revision,
            typed.max_day_chunks, typed.max_chunk_records, typed.max_day_bytes,
            legacy.state AS legacy_state
       FROM ${table(schema, "telemetry_v12_typed_runtime")} typed
       JOIN ${table(schema, "telemetry_v12_runtime")} legacy ON legacy.id = 1
      WHERE typed.id = 1`,
  );
  const row = result.rows[0];
  if (!row || row.schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || row.envelope_schema_version !== TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
      || row.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
      || row.max_day_chunks !== MAX_TELEMETRY_V12_DAY_CHUNKS
      || row.max_chunk_records !== MAX_TELEMETRY_V12_CHUNK_RECORDS
      || row.max_day_bytes !== MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return row;
}

async function assertWriteAllowed(
  client: PostgresClient,
  schema: string,
  principal: PostgresTypedV12Principal,
  now: Date,
): Promise<void> {
  if (typeof principal.participantId !== "string" || !PARTICIPANT.test(principal.participantId)
      || typeof principal.deviceId !== "string" || !PARTICIPANT.test(principal.deviceId)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const runtime = await runtimeRow(client, schema);
  if (runtime.state !== "active" || runtime.legacy_state !== "active") {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  const authority = await client.query<{
    owner_kind: "social" | "accountless";
    participant_consent_version: string | null;
    participant_state: string;
    authority_kind: "social" | "accountless";
    device_state: string;
    device_expires_at: string | Date;
    enrollment_device_id: string | null;
  }>(
    `SELECT p.owner_kind, p.consent_version AS participant_consent_version,
            p.state AS participant_state, d.authority_kind, d.state AS device_state,
            d.expires_at AS device_expires_at, d.accountless_enrollment_device_id AS enrollment_device_id
       FROM ${table(schema, "participants")} p
       JOIN ${table(schema, "device_credentials")} d ON d.participant_id = p.id
      WHERE p.id = $1 AND d.id = $2
      FOR SHARE OF p, d`,
    [principal.participantId, principal.deviceId],
  );
  const identity = authority.rows[0];
  if (!identity || identity.participant_state !== "active" || identity.device_state !== "active"
      || new Date(identity.device_expires_at).getTime() <= now.getTime()
      || identity.owner_kind !== identity.authority_kind) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (identity.owner_kind === "social") {
    if (identity.participant_consent_version !== TELEMETRY_CONSENT_VERSION) {
      throw new ApiError(400, "TELEMETRY_REQUIRED");
    }
    const consent = await client.query<{
      state: string;
      telemetry_schema_version: string;
      field_dictionary_version: string;
      privacy_contract_version: string;
    }>(
      `SELECT state, telemetry_schema_version, field_dictionary_version, privacy_contract_version
         FROM ${table(schema, "telemetry_v12_device_capabilities")}
        WHERE participant_id = $1 AND device_id = $2
        FOR SHARE`,
      [principal.participantId, principal.deviceId],
    );
    const grant = consent.rows[0];
    if (!grant || grant.state !== "accepted"
        || grant.telemetry_schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
        || grant.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
        || grant.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION) {
      throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
    }
    return;
  }
  if (identity.participant_consent_version !== null) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const accountless = await client.query<{ enrollment_device_id: string }>(
    `SELECT authz.enrollment_device_id
       FROM ${table(schema, "accountless_v12_device_authorizations")} authz
       JOIN ${table(schema, "device_credentials")} d
         ON d.id = authz.device_credential_id AND d.participant_id = authz.participant_id
       JOIN ${table(schema, "accountless_upload_owners")} owner
         ON owner.enrollment_device_id = authz.enrollment_device_id
       JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
         ON ledger.device_id = authz.enrollment_device_id
      WHERE authz.participant_id = $1
        AND authz.device_credential_id = $2
        AND authz.state = 'active'
        AND authz.schema_version = 'accountless-upload-owner-v1.2'
        AND authz.policy_version = 'accountless-telemetry-v1.2-policy-v1'
        AND authz.authorization_basis = 'accountless-policy-v1.2'
        AND authz.telemetry_schema_version = $3
        AND authz.field_dictionary_version = $4
        AND authz.privacy_contract_version = $5
        AND authz.expires_at > $6
        AND owner.participant_id = authz.participant_id
        AND owner.device_credential_id = authz.device_credential_id
        AND owner.state = 'active' AND owner.expires_at = authz.expires_at
        AND ledger.state = 'active' AND ledger.expires_at = authz.expires_at
        AND ledger.expires_at > $6
        AND d.accountless_enrollment_device_id = authz.enrollment_device_id
      FOR SHARE OF authz, owner, ledger`,
    [principal.participantId, principal.deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now],
  );
  if (!identity.enrollment_device_id || accountless.rows.length !== 1
      || accountless.rows[0]?.enrollment_device_id !== identity.enrollment_device_id) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
}

/**
 * Recheck current v1.2 owner/device authority inside a caller-owned
 * PostgreSQL transaction. This helper does not start, commit, or roll back
 * that transaction.
 */
export async function assertPostgresTypedV12WriteAllowed(
  client: PostgresClient,
  principal: PostgresTypedV12Principal,
  nowEpoch = Date.now(),
  options: PostgresTypedV12AdmissionOptions = {},
): Promise<void> {
  await assertWriteAllowed(client, schemaName(options), principal, currentTime(nowEpoch));
}

/** Fail closed unless the forward-only normalized runtime matches the codec. */
export async function initializePostgresTypedV12Admission(
  pool: PostgresPool,
  options: PostgresTypedV12AdmissionOptions = {},
): Promise<void> {
  const schema = schemaName(options);
  try {
    await withPostgresMutation(pool, async (client) => {
      await runtimeRow(client, schema);
    }, { operation: "typed_v12.initialize", preserveSafeError: safeStorageError });
  } catch (error) {
    stagingError(error);
  }
}

/**
 * Register one canonical v1.2 day manifest. Caller validation remains closed
 * and hash-bound; PostgreSQL rechecks current owner/device authority while the
 * manifest insert is in its own short transaction.
 */
export async function registerPostgresTypedV12DayManifest(
  pool: PostgresPool,
  principal: PostgresTypedV12Principal,
  value: unknown,
  nowEpoch = Date.now(),
  options: PostgresTypedV12AdmissionOptions = {},
): Promise<PostgresTypedV12DayCandidate> {
  let manifest: TelemetryV12DayManifest;
  try {
    manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DayManifest(value))) as TelemetryV12DayManifest;
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  // A complete v1.2 domain includes days without admitted records, and the
  // shipped client registers every day in its range. The contract allows
  // `chunks: []`; such a manifest is already complete, so it becomes ready at
  // registration (as v1.1 does) and the ready-integrity trigger accepts it.
  if (!isTelemetryV12ConsentCurrent(manifest.consent)) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  const canonical = canonicalTelemetryV12Json(manifest);
  if (new TextEncoder().encode(canonical).byteLength > MAX_MANIFEST_BYTES
      || await sha256Hex(telemetryV12DayManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  const now = currentTime(nowEpoch);
  const schema = schemaName(options);
  try {
    return await withPostgresMutation(pool, async (client) => {
      await assertWriteAllowed(client, schema, principal, now);
      async function registeredCandidate(row: ManifestRow): Promise<PostgresTypedV12DayCandidate> {
        if (row.manifest_json !== canonical || row.parser_version !== manifest.parserVersion
            || integer(row.expected_chunk_count, 0, MAX_TELEMETRY_V12_DAY_CHUNKS) !== manifest.chunks.length) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        // Imported staged candidates can already hold their complete typed
        // record vector. Use the admission integrity checks and ready trigger;
        // matching chunk counts alone never justify a ready receipt.
        if (row.state === "staged") {
          await readyManifestIfComplete(client, schema, row, now);
          const reconciled = await client.query<ManifestRow & { stored_chunk_count: number | string }>(
            `SELECT id, chunk_day, manifest_digest, expected_chunk_count, parser_version, state, manifest_json, ready_at,
                    (SELECT count(*) FROM ${table(schema, "telemetry_v12_chunks")} WHERE manifest_id = $1) AS stored_chunk_count
               FROM ${table(schema, "telemetry_v12_day_manifests")}
              WHERE id = $1 AND participant_id = $2 AND device_id = $3
              FOR UPDATE`,
            [row.id, principal.participantId, principal.deviceId],
          );
          if (!reconciled.rows[0] || reconciled.rows[0].manifest_json !== canonical) {
            throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
          }
          // A full vector with unproven records must be a retryable refusal,
          // never a successful staged/full receipt the strict client rejects.
          if (reconciled.rows[0].state === "staged"
              && integer(reconciled.rows[0].stored_chunk_count, 0, MAX_TELEMETRY_V12_DAY_CHUNKS)
                >= row.expected_chunk_count) {
            throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          }
          return manifestCandidate(reconciled.rows[0]);
        }
        return manifestCandidate(row);
      }
      const existing = await client.query<ManifestRow>(
        `SELECT id, chunk_day, manifest_digest, expected_chunk_count, parser_version, state, manifest_json, ready_at
           FROM ${table(schema, "telemetry_v12_day_manifests")}
          WHERE participant_id = $1 AND device_id = $2 AND chunk_day = $3 AND manifest_digest = $4
          FOR UPDATE`,
        [principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest],
      );
      if (existing.rows[0]) {
        return registeredCandidate(existing.rows[0]);
      }
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO ${table(schema, "telemetry_v12_day_manifests")} (
           id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
           manifest_json, expected_chunk_count, state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'staged', $9)
         ON CONFLICT (participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`,
        [id, principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest,
          manifest.parserVersion, canonical, manifest.chunks.length, now],
      );
      const stored = await client.query<ManifestRow>(
        `SELECT id, chunk_day, manifest_digest, expected_chunk_count, parser_version, state, manifest_json, ready_at
           FROM ${table(schema, "telemetry_v12_day_manifests")}
          WHERE participant_id = $1 AND device_id = $2 AND chunk_day = $3 AND manifest_digest = $4
          FOR UPDATE`,
        [principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest],
      );
      if (!stored.rows[0] || stored.rows[0].manifest_json !== canonical) {
        throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
      }
      return registeredCandidate(stored.rows[0]);
    }, { operation: "typed_v12.manifest", preserveSafeError: safeStorageError });
  } catch (error) {
    stagingError(error);
  }
}

function manifestCandidate(row: ManifestRow): PostgresTypedV12DayCandidate {
  return Object.freeze({
    manifestId: row.id,
    day: dateString(row.chunk_day),
    manifestDigest: row.manifest_digest,
    state: row.state,
    expectedChunks: integer(row.expected_chunk_count, 0, MAX_TELEMETRY_V12_DAY_CHUNKS),
  });
}

function rowAttributions(fields: TelemetryV12TypedRecordFields): TelemetryV12TypedAttribution[] {
  if (fields.usage) return [fields.usage.attribution];
  if (fields.quota) return [fields.quota.attribution];
  return [];
}

async function insertDictionaries(
  client: PostgresClient,
  schema: string,
  values: readonly string[],
): Promise<void> {
  if (!values.length) return;
  const sqlValues = placeholders(values.length, 1, 1);
  await client.query(
    `INSERT INTO ${table(schema, "typed_telemetry_dictionary")} (value)
     VALUES ${sqlValues} ON CONFLICT (value) DO NOTHING`,
    [...values],
  );
}

async function insertAttributions(
  client: PostgresClient,
  schema: string,
  values: readonly TelemetryV12TypedAttribution[],
): Promise<Map<string, string>> {
  const unique = [...new Map(values.map((value) => [attributionKey(value), value])).values()];
  if (!unique.length) return new Map();
  const bind: unknown[] = [];
  const tuples = unique.map((value, index) => {
    const first = index * 5 + 1;
    bind.push(value.accountBasis, bytes(value.accountTrack), value.planBasis, value.planType, bytes(value.planEra));
    return `($${first}::smallint, $${first + 1}::bytea, $${first + 2}::smallint, $${first + 3}::text, $${first + 4}::bytea)`;
  });
  await client.query(
    `INSERT INTO ${table(schema, "telemetry_v12_typed_attributions")} (
       account_basis, account_track, plan_basis, plan_type_id, plan_era
     ) SELECT value.account_basis, value.account_track, value.plan_basis, dictionary.id, value.plan_era
         FROM (VALUES ${tuples.join(", ")}) AS value(account_basis, account_track, plan_basis, plan_type, plan_era)
         JOIN ${table(schema, "typed_telemetry_dictionary")} dictionary ON dictionary.value = value.plan_type
     ON CONFLICT (account_basis, account_track, plan_basis, plan_type_id, plan_era) DO NOTHING`,
    bind,
  );
  const selected = await client.query<{
    id: string;
    account_basis: number;
    account_track: Uint8Array;
    plan_basis: number;
    plan_type: string;
    plan_era: Uint8Array;
  }>(
    `WITH requested(account_basis, account_track, plan_basis, plan_type, plan_era) AS (VALUES ${tuples.join(", ")})
     SELECT attribution.id::text AS id, attribution.account_basis, attribution.account_track,
            attribution.plan_basis, dictionary.value AS plan_type, attribution.plan_era
       FROM requested value
       JOIN ${table(schema, "typed_telemetry_dictionary")} dictionary ON dictionary.value = value.plan_type
       JOIN ${table(schema, "telemetry_v12_typed_attributions")} attribution
         ON attribution.account_basis = value.account_basis AND attribution.account_track = value.account_track
        AND attribution.plan_basis = value.plan_basis AND attribution.plan_type_id = dictionary.id
        AND attribution.plan_era = value.plan_era`,
    bind,
  );
  const ids = new Map<string, string>();
  for (const row of selected.rows) {
    const attribution: TelemetryV12TypedAttribution = {
      accountBasis: row.account_basis,
      accountTrack: Uint8Array.from(row.account_track).buffer,
      planBasis: row.plan_basis,
      planType: row.plan_type,
      planEra: Uint8Array.from(row.plan_era).buffer,
    };
    ids.set(attributionKey(attribution), row.id);
  }
  if (ids.size !== unique.length) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return ids;
}

async function insertTypedRecords(
  client: PostgresClient,
  schema: string,
  fields: readonly TelemetryV12TypedRecordFields[],
  chunkId: string,
  manifestId: string,
): Promise<Map<number, string>> {
  const bind: unknown[] = [chunkId, manifestId];
  const tuples = fields.map((field, index) => {
    const offset = 3 + index * 7;
    bind.push(index, field.stream, bytes(field.occurrenceId), field.observedAtMs,
      field.observedDay, field.provider, bytes(field.canonicalDigest));
    return `($${offset}::integer, $${offset + 1}::text, $${offset + 2}::bytea,
      $${offset + 3}::bigint, $${offset + 4}::integer, $${offset + 5}::text, $${offset + 6}::bytea)`;
  });
  const result = await client.query<TypedRecordIdRow>(
    `WITH input(record_index, stream, occurrence_id, observed_at_ms, observed_day, provider, canonical_digest) AS (
       VALUES ${tuples.join(", ")}
     )
     INSERT INTO ${table(schema, "telemetry_v12_typed_records")} (
       chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms, observed_day,
       provider_id, canonical_digest
     )
     SELECT $1, $2, input.stream, input.record_index, input.occurrence_id,
            input.observed_at_ms, input.observed_day, dictionary.id, input.canonical_digest
       FROM input JOIN ${table(schema, "typed_telemetry_dictionary")} dictionary
         ON dictionary.value = input.provider
     RETURNING id::text AS id, record_index`,
    bind,
  );
  const ids = new Map<number, string>();
  for (const row of result.rows) ids.set(integer(row.record_index, 0, 199), row.id);
  if (ids.size !== fields.length) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return ids;
}

function attrId(ids: ReadonlyMap<string, string>, value: TelemetryV12TypedAttribution): string {
  const result = ids.get(attributionKey(value));
  if (!result) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return result;
}

async function insertTypedChildren(
  client: PostgresClient,
  schema: string,
  fields: readonly TelemetryV12TypedRecordFields[],
  recordIds: ReadonlyMap<number, string>,
  attributionIds: ReadonlyMap<string, string>,
): Promise<void> {
  const usageRows = fields.flatMap((field, index) => field.usage ? [{ field, index, value: field.usage }] : []);
  const quotaRows = fields.flatMap((field, index) => field.quota ? [{ field, index, value: field.quota }] : []);
  const toolRows = fields.flatMap((field, index) => field.tools
    ? Object.entries(field.tools).map(([toolClass, count]) => ({ index, toolClass, count })) : []);
  if (usageRows.length) {
    const bind: unknown[] = [];
    const tuples = usageRows.map(({ index, value }, rowIndex) => {
      const recordId = recordIds.get(index);
      if (!recordId) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const first = rowIndex * 22 + 1;
      const attribution = value.attribution;
      bind.push(recordId, bytes(value.sessionId), value.model, value.speedMode, value.apiServiceTier,
        value.surface, value.billingSurface, value.reasoningEffort, value.agentScope, value.outcome,
        attrId(attributionIds, attribution), value.totalInputContextTokens, value.inputUncachedTokens,
        value.inputCacheReadTokens, value.inputCacheWriteTokens, value.outputTextTokens,
        value.outputReasoningTokens, value.outputCombinedTokens, value.boundaryFlags, value.tieOrder,
        value.cacheWriteTtlFiveMinuteTokens, value.cacheWriteTtlOneHourTokens);
      return `($${first}::bigint, $${first + 1}::bytea, $${first + 2}::text, $${first + 3}::text,
        $${first + 4}::text, $${first + 5}::text, $${first + 6}::text, $${first + 7}::text,
        $${first + 8}::text, $${first + 9}::text, $${first + 10}::bigint, $${first + 11}::bigint,
        $${first + 12}::bigint, $${first + 13}::bigint, $${first + 14}::bigint, $${first + 15}::bigint,
        $${first + 16}::bigint, $${first + 17}::bigint, $${first + 18}::integer, $${first + 19}::integer,
        $${first + 20}::bigint, $${first + 21}::bigint)`;
    });
    await client.query(
      `WITH input(record_id, session_id, model, speed_mode, api_service_tier, surface, billing_surface,
        reasoning_effort, agent_scope, outcome, attribution_id, total_input_context_tokens,
        input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens,
        output_reasoning_tokens, output_combined_tokens, boundary_flags, tie_order,
        cache_write_ttl_five_minute_tokens, cache_write_ttl_one_hour_tokens) AS (VALUES ${tuples.join(", ")})
       INSERT INTO ${table(schema, "telemetry_v12_typed_usage")} (
         record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id,
         billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
         total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
         input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens,
         boundary_flags, tie_order, cache_write_ttl_five_minute_tokens, cache_write_ttl_one_hour_tokens
       ) SELECT input.record_id, input.session_id, model.id, speed.id, tier.id, surface.id,
                billing.id, effort.id, scope.id, outcome.id, input.attribution_id,
                input.total_input_context_tokens, input.input_uncached_tokens, input.input_cache_read_tokens,
                input.input_cache_write_tokens, input.output_text_tokens, input.output_reasoning_tokens,
                input.output_combined_tokens, input.boundary_flags, input.tie_order,
                input.cache_write_ttl_five_minute_tokens, input.cache_write_ttl_one_hour_tokens
           FROM input
           JOIN ${table(schema, "typed_telemetry_dictionary")} model ON model.value = input.model
           JOIN ${table(schema, "typed_telemetry_dictionary")} speed ON speed.value = input.speed_mode
           JOIN ${table(schema, "typed_telemetry_dictionary")} tier ON tier.value = input.api_service_tier
           JOIN ${table(schema, "typed_telemetry_dictionary")} surface ON surface.value = input.surface
           JOIN ${table(schema, "typed_telemetry_dictionary")} billing ON billing.value = input.billing_surface
           JOIN ${table(schema, "typed_telemetry_dictionary")} effort ON effort.value = input.reasoning_effort
           JOIN ${table(schema, "typed_telemetry_dictionary")} scope ON scope.value = input.agent_scope
           JOIN ${table(schema, "typed_telemetry_dictionary")} outcome ON outcome.value = input.outcome`,
      bind,
    );
  }
  if (quotaRows.length) {
    const bind: unknown[] = [];
    const tuples = quotaRows.map(({ index, value }, rowIndex) => {
      const recordId = recordIds.get(index);
      if (!recordId) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const first = rowIndex * 9 + 1;
      bind.push(recordId, value.planType, value.planVariant, value.limitId, value.slot,
        value.usedPercent, value.windowDurationMinutes, value.resetsAtMs,
        attrId(attributionIds, value.attribution));
      return `($${first}::bigint, $${first + 1}::text, $${first + 2}::text, $${first + 3}::text,
        $${first + 4}::text, $${first + 5}::double precision, $${first + 6}::integer,
        $${first + 7}::bigint, $${first + 8}::bigint)`;
    });
    await client.query(
      `WITH input(record_id, plan_type, plan_variant, limit_id, slot, used_percent,
        window_duration_minutes, resets_at_ms, attribution_id) AS (VALUES ${tuples.join(", ")})
       INSERT INTO ${table(schema, "telemetry_v12_typed_quota")} (
         record_id, plan_type_id, plan_variant_id, limit_id, slot_id, used_percent,
         window_duration_minutes, resets_at_ms, attribution_id
       ) SELECT input.record_id, plan.id, variant.id, limit_row.id, slot_row.id, input.used_percent,
                input.window_duration_minutes, input.resets_at_ms, input.attribution_id
           FROM input
           JOIN ${table(schema, "typed_telemetry_dictionary")} plan ON plan.value = input.plan_type
           JOIN ${table(schema, "typed_telemetry_dictionary")} variant ON variant.value = input.plan_variant
           JOIN ${table(schema, "typed_telemetry_dictionary")} limit_row ON limit_row.value = input.limit_id
           JOIN ${table(schema, "typed_telemetry_dictionary")} slot_row ON slot_row.value = input.slot`,
      bind,
    );
  }
  if (toolRows.length) {
    const bind: unknown[] = [];
    const tuples = toolRows.map(({ index, toolClass, count }, rowIndex) => {
      const recordId = recordIds.get(index);
      if (!recordId) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const first = rowIndex * 3 + 1;
      bind.push(recordId, toolClass, count);
      return `($${first}::bigint, $${first + 1}::text, $${first + 2}::bigint)`;
    });
    await client.query(
      `WITH input(record_id, tool_class, count) AS (VALUES ${tuples.join(", ")})
       INSERT INTO ${table(schema, "telemetry_v12_typed_session_tools")} (record_id, tool_class_id, count)
       SELECT input.record_id, dictionary.id, input.count FROM input
       JOIN ${table(schema, "typed_telemetry_dictionary")} dictionary ON dictionary.value = input.tool_class`,
      bind,
    );
  }
}

interface UsageOrderRow {
  chunk_stream: string;
  chunk_seq: number;
  chunk_id: string;
  record_index: number;
  stream: "quota" | "session" | "usage";
  occurrence_id: Uint8Array;
  observed_at_ms: number | string;
  observed_day: number;
  canonical_digest: Uint8Array;
  provider: string;
  session_id: Uint8Array | null;
  model: string | null;
  speed_mode: string | null;
  api_service_tier: string | null;
  surface: string | null;
  billing_surface: string | null;
  reasoning_effort: string | null;
  agent_scope: string | null;
  outcome: string | null;
  total_input_context_tokens: number | string | null;
  input_uncached_tokens: number | string | null;
  input_cache_read_tokens: number | string | null;
  input_cache_write_tokens: number | string | null;
  output_text_tokens: number | string | null;
  output_reasoning_tokens: number | string | null;
  output_combined_tokens: number | string | null;
  boundary_flags: number | null;
  tie_order: number | null;
  cache_write_ttl_five_minute_tokens: number | string | null;
  cache_write_ttl_one_hour_tokens: number | string | null;
  account_basis: number | null;
  account_track: Uint8Array | null;
  plan_basis: number | null;
  attribution_plan_type: string | null;
  plan_era: Uint8Array | null;
}

function typedRow(row: UsageOrderRow) {
  if (row.stream !== "usage" || !row.session_id || !row.model || !row.speed_mode || !row.api_service_tier
      || !row.surface || !row.billing_surface || !row.reasoning_effort || !row.agent_scope || !row.outcome
      || row.account_basis === null || !row.account_track || row.plan_basis === null
      || !row.attribution_plan_type || !row.plan_era) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return {
    stream: row.stream,
    occurrence_id: row.occurrence_id,
    observed_at_ms: integer(row.observed_at_ms, -8_640_000_000_000_000, 8_640_000_000_000_000),
    observed_day: integer(row.observed_day, -100_000, 100_000),
    canonical_digest: row.canonical_digest,
    provider: row.provider,
    session_id: row.session_id,
    model: row.model,
    speed_mode: row.speed_mode,
    api_service_tier: row.api_service_tier,
    surface: row.surface,
    billing_surface: row.billing_surface,
    reasoning_effort: row.reasoning_effort,
    agent_scope: row.agent_scope,
    outcome: row.outcome,
    total_input_context_tokens: nullableInteger(row.total_input_context_tokens),
    input_uncached_tokens: nullableInteger(row.input_uncached_tokens),
    input_cache_read_tokens: nullableInteger(row.input_cache_read_tokens),
    input_cache_write_tokens: nullableInteger(row.input_cache_write_tokens),
    output_text_tokens: nullableInteger(row.output_text_tokens),
    output_reasoning_tokens: nullableInteger(row.output_reasoning_tokens),
    output_combined_tokens: nullableInteger(row.output_combined_tokens),
    boundary_flags: row.boundary_flags,
    tie_order: row.tie_order,
    cache_write_ttl_five_minute_tokens: nullableInteger(row.cache_write_ttl_five_minute_tokens),
    cache_write_ttl_one_hour_tokens: nullableInteger(row.cache_write_ttl_one_hour_tokens),
    account_basis: row.account_basis,
    account_track: row.account_track,
    plan_basis: row.plan_basis,
    attribution_plan_type: row.attribution_plan_type,
    plan_era: row.plan_era,
  };
}

function nullableInteger(value: number | string | null): number | null {
  return value === null ? null : integer(value, 0, 1_000_000_000_000);
}

async function verifyWholeDayUsageOrder(
  client: PostgresClient,
  schema: string,
  manifest: ManifestRow,
): Promise<void> {
  const usage: TelemetryV12UsageEvent[] = [];
  let cursor: readonly [string, number, string, number] | null = null;
  while (true) {
    const page: { readonly rows: readonly UsageOrderRow[]; readonly rowCount: number | null } =
      await client.query<UsageOrderRow>(
      `SELECT chunk.stream AS chunk_stream, chunk.chunk_seq, chunk.id AS chunk_id, r.record_index,
              r.stream, r.occurrence_id, r.observed_at_ms, r.observed_day, r.canonical_digest,
              provider.value AS provider, u.session_id, model.value AS model, speed.value AS speed_mode,
              tier.value AS api_service_tier, surface.value AS surface, billing.value AS billing_surface,
              effort.value AS reasoning_effort, scope.value AS agent_scope, outcome.value AS outcome,
              u.total_input_context_tokens, u.input_uncached_tokens, u.input_cache_read_tokens,
              u.input_cache_write_tokens, u.output_text_tokens, u.output_reasoning_tokens,
              u.output_combined_tokens, u.boundary_flags, u.tie_order,
              u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens,
              attribution.account_basis, attribution.account_track, attribution.plan_basis,
              plan.value AS attribution_plan_type, attribution.plan_era
         FROM ${table(schema, "telemetry_v12_typed_records")} r
         JOIN ${table(schema, "telemetry_v12_chunks")} chunk ON chunk.id = r.chunk_id
         JOIN ${table(schema, "typed_telemetry_dictionary")} provider ON provider.id = r.provider_id
         LEFT JOIN ${table(schema, "telemetry_v12_typed_usage")} u ON u.record_id = r.id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} model ON model.id = u.model_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} speed ON speed.id = u.speed_mode_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} tier ON tier.id = u.api_service_tier_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} surface ON surface.id = u.surface_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} billing ON billing.id = u.billing_surface_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} effort ON effort.id = u.reasoning_effort_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} scope ON scope.id = u.agent_scope_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} outcome ON outcome.id = u.outcome_id
         LEFT JOIN ${table(schema, "telemetry_v12_typed_attributions")} attribution ON attribution.id = u.attribution_id
         LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} plan ON plan.id = attribution.plan_type_id
        WHERE r.manifest_id = $1
          AND ($2::text IS NULL OR (chunk.stream, chunk.chunk_seq, chunk.id, r.record_index) > ($2, $3, $4, $5))
        ORDER BY chunk.stream, chunk.chunk_seq, chunk.id, r.record_index
        LIMIT $6`,
      [manifest.id, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null,
        cursor?.[3] ?? null, DAY_RECORD_SCAN_PAGE],
    );
    if (!page.rows.length) break;
    for (const row of page.rows) {
      cursor = [row.chunk_stream, row.chunk_seq, row.chunk_id, row.record_index];
      if (row.stream !== "usage") continue;
      let decoded: ReturnType<typeof decodeTelemetryV12Record>;
      try { decoded = decodeTelemetryV12Record(typedRow(row)); }
      catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
      if (hex(decoded.canonicalDigest) !== hex(row.canonical_digest)
          || await sha256Hex(decoded.canonicalRecord) !== hex(row.canonical_digest)) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      usage.push(JSON.parse(decoded.canonicalRecord) as TelemetryV12UsageEvent);
    }
  }
  try {
    validateTelemetryV12DayUsageOrder(dateString(manifest.chunk_day), usage);
  } catch {
    throw new ApiError(409, "TELEMETRY_RECORD_INVALID");
  }
}

async function readyManifestIfComplete(
  client: PostgresClient,
  schema: string,
  manifest: ManifestRow,
  now: Date,
): Promise<void> {
  if (manifest.state === "ready") return;
  const counts = await client.query<{
    expected_chunk_count: number;
    chunks: number | string;
    declared_records: number | string;
    typed_records: number | string;
    incomplete_chunks: number | string;
  }>(
    `SELECT m.expected_chunk_count, count(DISTINCT c.id) AS chunks,
            COALESCE(sum(c.record_count), 0) AS declared_records,
            (SELECT count(*) FROM ${table(schema, "telemetry_v12_typed_records")} r WHERE r.manifest_id = m.id) AS typed_records,
            count(DISTINCT c.id) FILTER (WHERE c.record_count != (
              SELECT count(*) FROM ${table(schema, "telemetry_v12_typed_records")} r WHERE r.chunk_id = c.id
            )) AS incomplete_chunks
       FROM ${table(schema, "telemetry_v12_day_manifests")} m
       LEFT JOIN ${table(schema, "telemetry_v12_chunks")} c ON c.manifest_id = m.id
      WHERE m.id = $1 GROUP BY m.id`,
    [manifest.id],
  );
  const row = counts.rows[0];
  if (!row) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const chunks = integer(row.chunks, 0, MAX_TELEMETRY_V12_DAY_CHUNKS);
  const declared = integer(row.declared_records, 0, MAX_TELEMETRY_V12_DAY_CHUNKS * MAX_TELEMETRY_V12_CHUNK_RECORDS);
  const typed = integer(row.typed_records, 0, MAX_TELEMETRY_V12_DAY_CHUNKS * MAX_TELEMETRY_V12_CHUNK_RECORDS);
  const incomplete = integer(row.incomplete_chunks, 0, MAX_TELEMETRY_V12_DAY_CHUNKS);
  if (chunks !== row.expected_chunk_count || declared !== typed || incomplete !== 0) return;
  await verifyWholeDayUsageOrder(client, schema, manifest);
  await client.query(
    `UPDATE ${table(schema, "telemetry_v12_day_manifests")}
        SET state = 'ready', ready_at = $2
      WHERE id = $1 AND state = 'staged'`,
    [manifest.id, now],
  );
}

/**
 * Persist the validated record stream as normalized rows in one bounded
 * transaction. The source object has already been written by the caller; this
 * transaction consumes the upload grant only if every normalized insert and
 * whole-day order check succeeds.
 */
export async function persistPostgresTypedV12StagedChunk(
  pool: PostgresPool,
  principal: PostgresTypedV12Principal,
  value: unknown,
  metadata: PostgresTypedV12ChunkMetadata,
  nowEpoch = Date.now(),
  options: PostgresTypedV12AdmissionOptions = {},
): Promise<PostgresTypedV12StagedChunkResult> {
  let chunk: ReturnType<typeof parseTelemetryV12Chunk>;
  try {
    chunk = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12Chunk(value))) as ReturnType<typeof parseTelemetryV12Chunk>;
  } catch {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalTelemetryV12Json(chunk.records)) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  if (typeof metadata.chunkRowId !== "string" || !/^chunk:[0-9a-f-]{36}$/u.test(metadata.chunkRowId)
      || typeof metadata.r2Key !== "string" || metadata.r2Key.length < 1 || metadata.r2Key.length > 1024
      || !DIGEST.test(metadata.envelopeDigest)
      || typeof metadata.deviceUploadAuthorizationId !== "string"
      || metadata.deviceUploadAuthorizationId.length < 1 || metadata.deviceUploadAuthorizationId.length > 256) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  const { stream, day, seq } = parseTelemetryV12ChunkId(chunk.chunkId);
  const now = currentTime(nowEpoch);
  const schema = schemaName(options);
  try {
    return await withPostgresMutation(pool, async (client) => {
      await assertWriteAllowed(client, schema, principal, now);
      const manifestResult = await client.query<ManifestRow>(
        `SELECT id, chunk_day, manifest_digest, expected_chunk_count, parser_version, state, manifest_json, ready_at
           FROM ${table(schema, "telemetry_v12_day_manifests")}
          WHERE participant_id = $1 AND device_id = $2 AND chunk_day = $3 AND manifest_digest = $4
          FOR UPDATE`,
        [principal.participantId, principal.deviceId, day, chunk.manifestDigest],
      );
      const manifest = manifestResult.rows[0];
      if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
      let parsedManifest: TelemetryV12DayManifest;
      try { parsedManifest = parseTelemetryV12DayManifest(JSON.parse(manifest.manifest_json)); }
      catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
      if (!isTelemetryV12ConsentCurrent(parsedManifest.consent)
          || canonicalTelemetryV12Json(parsedManifest.consent) !== canonicalTelemetryV12Json(chunk.consent)) {
        throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
      }
      const expected = parsedManifest.chunks.find((entry) => entry.chunkId === chunk.chunkId);
      if (manifest.parser_version !== parsedManifest.parserVersion
          || !expected || expected.chunkDigest !== chunk.chunkDigest || expected.recordCount !== chunk.records.length) {
        throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
      }
      const existingResult = await client.query<ExistingChunkRow>(
        `SELECT id, manifest_id, chunk_id, chunk_digest, record_count
           FROM ${table(schema, "telemetry_v12_chunks")}
          WHERE manifest_id = $1 AND chunk_id = $2
          FOR SHARE`,
        [manifest.id, chunk.chunkId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.chunk_digest !== chunk.chunkDigest || existing.record_count !== chunk.records.length) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        const count = await client.query<{ total: number | string }>(
          `SELECT count(*) AS total FROM ${table(schema, "telemetry_v12_typed_records")} WHERE chunk_id = $1`,
          [existing.id],
        );
        if (integer(count.rows[0]?.total, 0, MAX_TELEMETRY_V12_CHUNK_RECORDS) !== chunk.records.length) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        await readyManifestIfComplete(client, schema, manifest, now);
        return Object.freeze({ contributionId: existing.id, manifestId: manifest.id, chunkId: chunk.chunkId, replay: true });
      }
      if (manifest.state !== "staged") throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
      const authorization = await client.query<{ id: string }>(
        `SELECT id FROM ${table(schema, "device_upload_authorizations")}
          WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3
            AND state = 'consuming' AND envelope_digest = $4
            AND consume_lease_expires_at > $5 AND expires_at > $5
          FOR UPDATE`,
        [metadata.deviceUploadAuthorizationId, principal.participantId, principal.deviceId,
          metadata.envelopeDigest, now],
      );
      if (authorization.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
      const typed = await Promise.all(chunk.records.map((record) => encodeTelemetryV12Record(stream, record, sha256)));
      if (typed.length !== chunk.records.length || typed.some((record) => record.stream !== stream)) {
        throw new ApiError(400, "CHUNK_INVALID");
      }
      await client.query(
        `INSERT INTO ${table(schema, "telemetry_v12_chunks")} (
           id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
           chunk_digest, envelope_digest, parser_version, record_count, r2_key,
           device_upload_authorization_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [metadata.chunkRowId, manifest.id, principal.participantId, principal.deviceId, stream,
          day, seq, chunk.chunkId, chunk.chunkDigest, metadata.envelopeDigest, chunk.parserVersion,
          chunk.records.length, metadata.r2Key, metadata.deviceUploadAuthorizationId, now],
      );
      const dictionaryValues = [...new Set(typed.flatMap((record) => dictionaries(record)))];
      await insertDictionaries(client, schema, dictionaryValues);
      const attributionValues = typed.flatMap((record) => rowAttributions(record));
      const attributionIds = await insertAttributions(client, schema, attributionValues);
      const recordIds = await insertTypedRecords(client, schema, typed, metadata.chunkRowId, manifest.id);
      await insertTypedChildren(client, schema, typed, recordIds, attributionIds);
      const consumed = await client.query(
        `UPDATE ${table(schema, "device_upload_authorizations")}
            SET state = 'consumed', consumed_at = $2, consume_lease_expires_at = NULL,
                consumed_contribution_id = $3
          WHERE id = $1 AND state = 'consuming' AND envelope_digest = $4
            AND consume_lease_expires_at > $2 AND expires_at > $2
          RETURNING id`,
        [metadata.deviceUploadAuthorizationId, now, metadata.chunkRowId, metadata.envelopeDigest],
      );
      if (consumed.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
      await readyManifestIfComplete(client, schema, manifest, now);
      return Object.freeze({
        contributionId: metadata.chunkRowId,
        manifestId: manifest.id,
        chunkId: chunk.chunkId,
        replay: false,
      });
    }, {
      operation: "typed_v12.stage",
      isolationLevel: "read_committed",
      statementTimeoutMilliseconds: 60_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: safeStorageError,
    });
  } catch (error) {
    stagingError(error);
  }
}
