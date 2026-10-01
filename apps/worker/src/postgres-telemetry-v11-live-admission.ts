/**
 * Live v1.1 telemetry admission on PostgreSQL (GCP fast path, IN-2).
 *
 * The oracle is the d43c8f92 Worker in typed storage mode, which is how
 * production runs v1.1:
 *   - consent:        telemetry-transport-policy.ts grantTelemetryV11Consent
 *   - day manifests:  telemetry-v11-repository.ts registerTelemetryV11DayManifest,
 *                     readTelemetryV11DayCandidates, readTelemetryV11DayChunkVector
 *   - chunks:         typed-v11-admission.ts persistTypedV11StagedChunk and
 *                     telemetry-storage-mode.ts readTelemetryV11StorageReplay
 *   - receipts:       device-auth.ts recordDeviceUploadReceipt
 *   - domain:         telemetry-v11-domain.ts createTelemetryV11DomainPredecessor,
 *                     activateTelemetryV11Domain, with the D1 trigger chain they
 *                     rely on (D1 0058 v1.1 admission, typed-v11-admission
 *                     0001/0006, and the two BEFORE INSERT closures production
 *                     runs last: ingestion-isolation 0007's
 *                     typed_v1_v11_transition_unqualified, which fires first,
 *                     and telemetry_v11_domain_complete_before_insert, with
 *                     its active-correction exact-total tolerance).
 *
 * D1 enforces most of that chain in triggers that SQLite runs inside one
 * batch. Here each operation is one bounded PostgreSQL transaction that
 * re-reads authority under FOR SHARE (TA-1 assertPostgresTelemetryTransport-
 * WriteAllowed with lock: true) and applies the same checks in the same
 * order, so the status codes and error bodies are the Worker's. Primary
 * migration 0060 (staged) holds the row guards that must hold for every
 * writer.
 *
 * Typed rows use the retained typed v1/v1.1 family (0030/0033) and the 0052
 * identities (TL-1): ids are allocated by PostgreSQL, while source_row_id
 * ranges come from typed_v11_admission_state exactly as D1's allocator. The
 * service refuses to allocate unless verifyPostgresTypedIdentityHeadroom
 * holds.
 *
 * Deliberate, documented differences from the oracle:
 *   - a typed-storage misconfiguration (namespace pin or runtime contract) is
 *     503 BACKEND_STORAGE_UNAVAILABLE; D1 throws a TypedTelemetryError, which
 *     its top-level handler turns into 500 INTERNAL_ERROR;
 *   - D1's community_snapshot_mutation_control and
 *     community_daily_aggregate_rebuilds head side effects are not written;
 *     the analytics_v2 job reads storage_ingestion_changes instead. The
 *     storage_v11 owner bridge (ingestion-bridge 0001, with ingestion-
 *     isolation 0002's append classification) is staged migration 0060's
 *     head trigger, not this module;
 *   - D1 keeps the usage-correction runtime state in
 *     telemetry_usage_correction_runtime.state; PostgreSQL keeps the
 *     transferred D1 state in source_state (0034), so every "correction
 *     runtime active" test here reads source_state = 'active'.
 *
 * Every failure is an ApiError; provider messages, SQL and bind values never
 * leave this module.
 */
import {
  canonicalTelemetryV11Json,
  isTelemetryV11ConsentCurrent,
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
  parseTelemetryV11Chunk,
  parseTelemetryV11ChunkId,
  parseTelemetryV11DayManifest,
  parseTelemetryV11DomainManifest,
  telemetryV11DayManifestDigestInput,
  telemetryV11DomainManifestDigestInput,
  telemetryV11RequiredConsent,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV11Chunk,
  type TelemetryV11Consent,
  type TelemetryV11DayManifest,
  type TelemetryV11Record,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256, sha256Hex } from "./crypto";
import { TELEMETRY_CONSENT_VERSION } from "./constants";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import { verifyPostgresTypedIdentityHeadroom } from "./postgres-typed-live-allocators";
import { assertPostgresTelemetryTransportWriteAllowed } from "./postgres-transport-write-authority";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import {
  MAX_V1_SOURCE_CHUNKS,
  selectV1WinningDevices,
  type V1SourceChunk,
} from "./telemetry-v1-source-selection";
import {
  decodeTypedTelemetryId,
  encodeTypedTelemetryId,
  encodeTypedTelemetryRecord,
  typedTelemetryCanonicalRecords,
  typedTelemetryDayNumber,
  type TypedTelemetryFields,
} from "./typed-telemetry-codec";

export interface PostgresTelemetryV11Principal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface PostgresTelemetryV11Options {
  readonly schema?: PostgresSchemaConfig;
  /**
   * The immutable typed source namespace pinned in typed_v11_admission_state
   * (D1 TELEMETRY_STORAGE_NAMESPACE). Required by chunk admission and replay.
   */
  readonly sourceNamespace?: string;
}

export interface PostgresTelemetryV11ChunkMetadata {
  readonly chunkRowId: string;
  readonly r2Key: string;
  readonly envelopeDigest: string;
  readonly deviceUploadAuthorizationId: string;
}

export interface PostgresTelemetryV11DayCandidate {
  readonly manifestId: string;
  readonly day: string;
  readonly manifestDigest: string;
  readonly state: "staged" | "ready";
  readonly expectedChunks: number;
}

export interface PostgresTelemetryV11StagedChunkResult {
  readonly contributionId: string;
  readonly manifestId: string;
  readonly chunkId: string;
  readonly replay: boolean;
}

export interface PostgresTelemetryV11StagedChunkRow {
  readonly id: string;
  readonly manifestId: string;
  readonly chunkDigest: string;
  readonly recordCount: number;
}

export const V11_DOMAIN_METHOD_VERSION = "v11-complete-domain-1";

const DAY_MS = 86_400_000;
const PREDECESSOR_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_MANIFESTS_PER_DEVICE_DAY = 8_192;
const MAX_DOMAIN_CHUNKS = 30_000;
const MAX_CHUNK_RECORDS = 200;
const DIGEST = /^[0-9a-f]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PARTICIPANT = /^[A-Za-z0-9._:-]{1,256}$/u;
const STREAMS = ["usage", "quota", "session"] as const;
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;
const TIMESTAMP_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// ---------------------------------------------------------------- helpers --

function schemaOf(options: PostgresTelemetryV11Options): { quoted: string; config: PostgresSchemaConfig } {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  return { quoted: quotePostgresIdentifier(config.primarySchema), config };
}

function t(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function manifestConflict(): ApiError {
  return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
}

function utcDay(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function nowDate(nowEpoch: number): Date {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || nowEpoch > 8_640_000_000_000_000) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  return new Date(nowEpoch);
}

function count(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw unavailable();
  return parsed;
}

function validPrincipal(principal: PostgresTelemetryV11Principal): void {
  if (principal === null || typeof principal !== "object"
      || typeof principal.participantId !== "string" || !PARTICIPANT.test(principal.participantId)
      || typeof principal.deviceId !== "string" || !PARTICIPANT.test(principal.deviceId)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
}

/** A detached copy; the pg driver binds any ArrayBuffer view as bytea. */
function bytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function driverField(error: unknown, field: string): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const value: unknown = Reflect.get(error, field);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * D1's mapStagingError / typed-v11 mapError, keyed by this schema's constant
 * RAISE messages and constraint names instead of SQLite message text.
 */
function admissionError(error: unknown): Error | null {
  if (error instanceof ApiError) return error;
  const code = driverField(error, "code");
  if (code === null) return null;
  const message = driverField(error, "message") ?? "";
  const constraint = driverField(error, "constraint") ?? "";
  const table = driverField(error, "table") ?? "";
  if (message === "typed_v11_allocator_race") {
    return new ApiError(409, "UPLOAD_IN_PROGRESS", { responseHeaders: { "retry-after": "1" } });
  }
  if (message === "telemetry_transport_blocked") return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  if (message === "telemetry_manifest_incomplete") return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (code === "23505" && (constraint === "typed_telemetry_v11_occurrence"
      || constraint === "typed_telemetry_records_chunk_id_occurrence_id_key")) {
    return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
  }
  if (message === "typed_legacy_admission_parent_missing" || message === "typed_telemetry_membership_conflict"
      || message === "typed_telemetry_source_immutable"
      || (code === "23505" && table.startsWith("telemetry_v11_"))) {
    return manifestConflict();
  }
  // A serialization failure or deadlock (40001, 40P01) is transient lock
  // contention, not a manifest conflict: it stays a retryable 503, as every
  // other Worker storage failure is, so a client keeps its progress journal.
  return null;
}

function storageFailure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw admissionError(error) ?? unavailable();
}

/** TA-1 inside the caller's transaction, holding its FOR SHARE locks. */
async function assertV11WriteAllowed(
  client: PostgresClient,
  principal: PostgresTelemetryV11Principal,
  config: PostgresSchemaConfig,
  nowEpoch: number,
): Promise<void> {
  await assertPostgresTelemetryTransportWriteAllowed(
    client, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
    { schema: config, nowEpoch, lock: true },
  );
}

// ---------------------------------------------------------------- consent --

/**
 * grantTelemetryV11Consent: a session-authorized social device consent. The
 * insert fires 0051's admission and floor triggers; the explicit raises below
 * are D1's re-grant-after-rollback statements. Any failure in the grant
 * itself is 403 TELEMETRY_TRANSPORT_BLOCKED, as D1 maps its whole batch.
 */
export async function grantPostgresTelemetryV11Consent(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal & { readonly sessionId: string },
  consent: unknown,
  nowEpoch = Date.now(),
  options: PostgresTelemetryV11Options = {},
): Promise<Readonly<{ consent: TelemetryV11Consent; minimumWriteRank: 11 }>> {
  if (!isTelemetryV11ConsentCurrent(consent)) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  // The device id is caller-supplied body text on this session route. D1
  // simply finds no preflight row for an id no device can have, so any
  // malformed principal is its 403, never the device protocol's 401.
  try {
    validPrincipal(principal);
  } catch {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (typeof principal.sessionId !== "string" || principal.sessionId.length < 1) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  const { quoted: s, config } = schemaOf(options);
  const now = nowDate(nowEpoch).toISOString();
  const granted = consent as TelemetryV11Consent;
  const legacyV02 = `NOT EXISTS (SELECT 1 FROM ${t(s, "telemetry_contributions")} legacy
      WHERE legacy.participant_id = $1 AND legacy.status = 'accepted'
        AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')`;
  const sessionLive = `EXISTS (SELECT 1 FROM ${t(s, "web_sessions")} session
      WHERE session.id = $3 AND session.participant_id = $1 AND session.state = 'active'
        AND session.scope = 'personal' AND session.expires_at > $4::timestamptz)`;
  try {
    await withPostgresMutation(pool, async (client) => {
      const preflight = await client.query(
        `SELECT device.id FROM ${t(s, "participants")} participant
           JOIN ${t(s, "device_credentials")} device ON device.participant_id = participant.id
           JOIN ${t(s, "telemetry_transport_formats")} format_row
             ON format_row.schema_version = $5
          WHERE participant.id = $1 AND participant.state = 'active' AND participant.owner_kind = 'social'
            AND device.id = $2 AND device.state = 'active' AND device.authority_kind = 'social'
            AND ${sessionLive} AND format_row.lifecycle = 'accepted' AND ${legacyV02}
          FOR SHARE OF participant, device`,
        [principal.participantId, principal.deviceId, principal.sessionId, now,
          TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION],
      );
      if (preflight.rows.length !== 1) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
      await client.query(
        `INSERT INTO ${t(s, "telemetry_v11_device_consents")} (
           participant_id, device_id, telemetry_schema_version, field_dictionary_version,
           privacy_contract_version, consented_at
         ) SELECT $1, $2, $3, $4, $5, $6::timestamptz
            WHERE EXISTS (SELECT 1 FROM ${t(s, "web_sessions")} session
                WHERE session.id = $7 AND session.participant_id = $1 AND session.state = 'active'
                  AND session.scope = 'personal' AND session.expires_at > $6::timestamptz)
         ON CONFLICT (participant_id, device_id) DO NOTHING`,
        [principal.participantId, principal.deviceId, granted.telemetrySchemaVersion,
          granted.fieldDictionaryVersion, granted.privacyContractVersion, now, principal.sessionId],
      );
      await client.query(
        `UPDATE ${t(s, "telemetry_transport_participant_floors")}
            SET minimum_rank = 11, revision = revision + 1, changed_at = $4::timestamptz
          WHERE participant_id = $1 AND minimum_rank < 11
            AND EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_device_consents")} consent_row
              WHERE consent_row.participant_id = $1 AND consent_row.device_id = $2)
            AND ${sessionLive}
            AND EXISTS (SELECT 1 FROM ${t(s, "telemetry_transport_formats")}
              WHERE schema_version = $5 AND lifecycle = 'accepted')
            AND ${legacyV02}`,
        [principal.participantId, principal.deviceId, principal.sessionId, now,
          TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION],
      );
      const participantFloor = await client.query<{ minimum_rank: number }>(
        `SELECT floors.minimum_rank FROM ${t(s, "participants")} participant
           JOIN ${t(s, "device_credentials")} device ON device.participant_id = participant.id
           JOIN ${t(s, "telemetry_transport_participant_floors")} floors ON floors.participant_id = participant.id
           JOIN ${t(s, "telemetry_v11_device_consents")} consent_row
             ON consent_row.participant_id = participant.id AND consent_row.device_id = device.id
           JOIN ${t(s, "telemetry_transport_formats")} format_row
             ON format_row.schema_version = consent_row.telemetry_schema_version
          WHERE participant.id = $1 AND participant.state = 'active'
            AND device.id = $2 AND device.state = 'active'
            AND ${sessionLive} AND floors.minimum_rank = 11 AND format_row.lifecycle = 'accepted'
            AND ${legacyV02}`,
        [principal.participantId, principal.deviceId, principal.sessionId, now],
      );
      if (participantFloor.rows[0]?.minimum_rank !== 11) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
      await client.query(
        `UPDATE ${t(s, "telemetry_transport_device_floors")}
            SET minimum_rank = 11, revision = revision + 1, changed_at = $3::timestamptz
          WHERE participant_id = $1 AND device_id = $2 AND minimum_rank < 11`,
        [principal.participantId, principal.deviceId, now],
      );
      const deviceFloor = await client.query<{ minimum_rank: number }>(
        `SELECT minimum_rank FROM ${t(s, "telemetry_transport_device_floors")}
          WHERE participant_id = $1 AND device_id = $2`,
        [principal.participantId, principal.deviceId],
      );
      if (deviceFloor.rows[0]?.minimum_rank !== 11) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
    }, { operation: "telemetry.v11.consent" });
  } catch {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  await assertPostgresTelemetryTransportWriteAllowed(
    pool, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION, { schema: config, nowEpoch },
  );
  return Object.freeze({ consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 as const });
}

// --------------------------------------------------------------- manifests --

interface ManifestRow {
  id: string;
  chunk_day: string;
  manifest_digest: string;
  expected_chunk_count: number;
  parser_version: string;
  state: "staged" | "ready";
  manifest_json: string;
}

const MANIFEST_COLUMNS = `id, to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day, manifest_digest,
  expected_chunk_count, parser_version, state, manifest_json`;

function candidate(row: ManifestRow): PostgresTelemetryV11DayCandidate {
  if (!utcDay(row.chunk_day) || !DIGEST.test(row.manifest_digest)
      || (row.state !== "staged" && row.state !== "ready")) throw unavailable();
  return Object.freeze({
    manifestId: row.id,
    day: row.chunk_day,
    manifestDigest: row.manifest_digest,
    state: row.state,
    expectedChunks: count(row.expected_chunk_count),
  });
}

async function manifestByDigest(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryV11Principal,
  day: string,
  digest: string,
  lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
): Promise<ManifestRow | null> {
  const result = await client.query<ManifestRow>(
    `SELECT ${MANIFEST_COLUMNS} FROM ${t(s, "telemetry_v11_day_manifests")}
      WHERE participant_id = $1 AND device_id = $2 AND chunk_day = $3::date AND manifest_digest = $4
      ${lock}`,
    [principal.participantId, principal.deviceId, day, digest],
  );
  return result.rows[0] ?? null;
}

/** registerTelemetryV11DayManifest plus D1 0058 telemetry_v11_manifest_admission. */
export async function registerPostgresTelemetryV11DayManifest(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  value: unknown,
  nowEpoch = Date.now(),
  options: PostgresTelemetryV11Options = {},
): Promise<PostgresTelemetryV11DayCandidate> {
  let manifest: TelemetryV11DayManifest;
  try {
    manifest = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DayManifest(value))) as TelemetryV11DayManifest;
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  const canonical = canonicalTelemetryV11Json(manifest);
  if (await sha256Hex(telemetryV11DayManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  validPrincipal(principal);
  const { quoted: s, config } = schemaOf(options);
  const now = nowDate(nowEpoch);
  try {
    return await withPostgresMutation(pool, async (client) => {
      await assertV11WriteAllowed(client, principal, config, nowEpoch);
      const existing = await manifestByDigest(client, s, principal, manifest.day, manifest.manifestDigest, "FOR SHARE");
      if (existing) {
        if (existing.manifest_json !== canonical) throw manifestConflict();
        return candidate(existing);
      }
      // D1 0058: at most 8192 manifests per device and UTC creation day. D1
      // counts inside its single-writer batch; here concurrent registrations
      // for one device serialize on a transaction-scoped advisory lock taken
      // after the TA-1 row locks, so each count sees every committed insert.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 11011))",
        [JSON.stringify(["telemetry-v11-manifest-admission", principal.participantId, principal.deviceId])]);
      const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
      const admitted = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM (
           SELECT 1 FROM ${t(s, "telemetry_v11_day_manifests")}
            WHERE participant_id = $1 AND device_id = $2 AND created_at >= $3::timestamptz
            LIMIT $4) bounded`,
        [principal.participantId, principal.deviceId, dayStart, MAX_MANIFESTS_PER_DEVICE_DAY],
      );
      if (count(admitted.rows[0]?.total) >= MAX_MANIFESTS_PER_DEVICE_DAY) {
        throw new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
      }
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO ${t(s, "telemetry_v11_day_manifests")} (
           id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
           manifest_json, expected_chunk_count, state, created_at
         ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, 'staged', $9)
         ON CONFLICT (participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`,
        [id, principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest,
          manifest.parserVersion, canonical, manifest.chunks.length, now],
      );
      await client.query(
        `UPDATE ${t(s, "telemetry_v11_day_manifests")} SET state = 'ready', ready_at = $2
          WHERE id = $1 AND state = 'staged' AND expected_chunk_count = 0`,
        [id, now],
      );
      const stored = await manifestByDigest(client, s, principal, manifest.day, manifest.manifestDigest, "FOR SHARE");
      if (!stored || stored.manifest_json !== canonical) throw manifestConflict();
      return candidate(stored);
    }, { operation: "telemetry.v11.manifest", preserveSafeError: admissionError });
  } catch (error) {
    storageFailure(error);
  }
}

/** readTelemetryV11DayCandidates: an authenticated, bounded 31-day read. */
export async function readPostgresTelemetryV11DayCandidates(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  query: { readonly fromDay: string; readonly toDay: string; readonly limit?: number },
  options: PostgresTelemetryV11Options = {},
): Promise<{ candidates: PostgresTelemetryV11DayCandidate[]; bounded: boolean }> {
  const limit = query.limit ?? 200;
  const start = Date.parse(`${query.fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${query.toDay}T00:00:00.000Z`);
  if (!utcDay(query.fromDay) || !utcDay(query.toDay) || end < start
      || end - start > 30 * DAY_MS || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  validPrincipal(principal);
  const { quoted: s } = schemaOf(options);
  try {
    // ORDER BY created_at, id COLLATE "C": SQLite's BINARY tie-break on ids.
    const rows = await withPostgresRead(pool, async (client) => (await client.query<ManifestRow>(
      `SELECT ${MANIFEST_COLUMNS} FROM ${t(s, "telemetry_v11_day_manifests")}
        WHERE participant_id = $1 AND device_id = $2 AND chunk_day >= $3::date AND chunk_day <= $4::date
        ORDER BY chunk_day, created_at, id COLLATE "C" LIMIT $5`,
      [principal.participantId, principal.deviceId, query.fromDay, query.toDay, limit + 1],
    )).rows, { operation: "telemetry.v11.candidates" });
    return { candidates: rows.slice(0, limit).map(candidate), bounded: rows.length > limit };
  } catch (error) {
    storageFailure(error);
  }
}

/** readTelemetryV11DayChunkVector: exact staged chunks of one owned manifest. */
export async function readPostgresTelemetryV11DayChunkVector(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  manifestId: string,
  options: PostgresTelemetryV11Options = {},
): Promise<{ chunkId: string; chunkDigest: string; recordCount: number }[]> {
  validPrincipal(principal);
  const { quoted: s } = schemaOf(options);
  try {
    const rows = await withPostgresRead(pool, async (client) => (await client.query<{
      chunk_id: string; chunk_digest: string; record_count: number;
    }>(
      `SELECT chunk.chunk_id, chunk.chunk_digest, chunk.record_count
         FROM ${t(s, "telemetry_v11_chunks")} chunk
         JOIN ${t(s, "telemetry_v11_day_manifests")} manifest ON manifest.id = chunk.manifest_id
        WHERE manifest.id = $1 AND manifest.participant_id = $2 AND manifest.device_id = $3
        ORDER BY chunk.stream COLLATE "C", chunk.chunk_seq LIMIT 4097`,
      [manifestId, principal.participantId, principal.deviceId],
    )).rows, { operation: "telemetry.v11.chunk_vector" });
    if (rows.length > 4096) throw unavailable();
    return rows.map((row) => ({
      chunkId: row.chunk_id, chunkDigest: row.chunk_digest, recordCount: count(row.record_count),
    }));
  } catch (error) {
    storageFailure(error);
  }
}

// ------------------------------------------------------------------ chunks --

/** validateTelemetryV11StagedChunk: closed schema, canonical snapshot, digest. */
export async function validatePostgresTelemetryV11StagedChunk(value: unknown): Promise<TelemetryV11Chunk> {
  let chunk: TelemetryV11Chunk;
  try {
    chunk = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11Chunk(value))) as TelemetryV11Chunk;
  } catch {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalTelemetryV11Json(chunk.records)) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  return chunk;
}

interface AdmissionStateRow {
  source_namespace: string;
  namespace_id: string;
  next_source_row_id: string;
  runtime_contract_version: number;
}

async function admissionState(
  client: PostgresClient,
  s: string,
  sourceNamespace: string,
  lock: boolean,
): Promise<{ namespaceId: string; nextSourceRowId: number }> {
  const result = await client.query<AdmissionStateRow>(
    `SELECT state.source_namespace, state.namespace_id::text AS namespace_id,
            state.next_source_row_id::text AS next_source_row_id, state.runtime_contract_version
       FROM ${t(s, "typed_v11_admission_state")} state
       JOIN ${t(s, "typed_telemetry_namespaces")} namespace ON namespace.id = state.namespace_id
      WHERE state.id = 1 AND namespace.original_id = $1 ${lock ? "FOR UPDATE OF state" : ""}`,
    [bytes(encodeTypedTelemetryId(sourceNamespace))],
  );
  const row = result.rows[0];
  if (!row || row.source_namespace !== sourceNamespace || row.runtime_contract_version !== 1) throw unavailable();
  const nextSourceRowId = count(row.next_source_row_id);
  if (nextSourceRowId < 1) throw unavailable();
  return { namespaceId: row.namespace_id, nextSourceRowId };
}

function requireNamespace(options: PostgresTelemetryV11Options): string {
  const value = options.sourceNamespace;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw unavailable();
  try { encodeTypedTelemetryId(value); } catch { throw unavailable(); }
  return value;
}

/**
 * initializeTypedV11Admission: pin the typed source namespace on a fresh
 * target and qualify runtime contract 1 (D1 typed-v11 0001 initialize-empty
 * and 0004 qualify). Repeating the same pin is harmless; a different pin, or
 * retained v1.1 history without a pin, is refused.
 */
export async function initializePostgresTypedV11Admission(
  pool: PostgresPool,
  options: PostgresTelemetryV11Options = {},
): Promise<void> {
  const sourceNamespace = requireNamespace(options);
  const { quoted: s } = schemaOf(options);
  const original = bytes(encodeTypedTelemetryId(sourceNamespace));
  try {
    await withPostgresMutation(pool, async (client) => {
      const v1Pin = await client.query<{ source_namespace: string }>(
        `SELECT source_namespace FROM ${t(s, "typed_v1_admission_state")} WHERE id = 1`,
      );
      if (v1Pin.rows[0] && v1Pin.rows[0].source_namespace !== sourceNamespace) throw unavailable();
      const existing = await client.query<{ source_namespace: string; runtime_contract_version: number }>(
        `SELECT source_namespace, runtime_contract_version FROM ${t(s, "typed_v11_admission_state")}
          WHERE id = 1 FOR UPDATE`,
      );
      if (existing.rows[0]) {
        if (existing.rows[0].source_namespace !== sourceNamespace) throw unavailable();
      } else {
        const history = await client.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_records")})
              OR EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_chunks")})
              OR EXISTS (SELECT 1 FROM ${t(s, "typed_telemetry_records")} WHERE format = 11) AS present`,
        );
        if (history.rows[0]?.present !== false) throw unavailable();
        await client.query(
          `INSERT INTO ${t(s, "typed_telemetry_namespaces")} (original_id) VALUES ($1)
           ON CONFLICT (original_id) DO NOTHING`,
          [original],
        );
        await client.query(
          `INSERT INTO ${t(s, "typed_v11_admission_state")} (
             id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id
           ) SELECT 1, $1, namespace.id, 0, 1 FROM ${t(s, "typed_telemetry_namespaces")} namespace
              WHERE namespace.original_id = $2`,
          [sourceNamespace, original],
        );
      }
      if (await client.query(`SELECT 1 FROM ${t(s, "telemetry_v11_records")} LIMIT 1`)
        .then((result) => result.rows.length !== 0)) throw unavailable();
      await client.query(
        `UPDATE ${t(s, "typed_v11_admission_state")} SET runtime_contract_version = 1
          WHERE id = 1 AND source_namespace = $1 AND runtime_contract_version = 0`,
        [sourceNamespace],
      );
      await admissionState(client, s, sourceNamespace, false);
    }, { operation: "telemetry.v11.initialize" });
  } catch {
    throw unavailable();
  }
}

interface ExistingChunkRow {
  id: string;
  manifest_id: string;
  chunk_digest: string;
  record_count: number;
}

async function existingChunk(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryV11Principal,
  chunk: TelemetryV11Chunk,
): Promise<ExistingChunkRow | null> {
  const { day } = parseTelemetryV11ChunkId(chunk.chunkId);
  const result = await client.query<ExistingChunkRow>(
    `SELECT chunk.id, chunk.manifest_id, chunk.chunk_digest, chunk.record_count
       FROM ${t(s, "telemetry_v11_chunks")} chunk
       JOIN ${t(s, "telemetry_v11_day_manifests")} manifest ON manifest.id = chunk.manifest_id
      WHERE manifest.participant_id = $1 AND manifest.device_id = $2 AND manifest.chunk_day = $3::date
        AND manifest.manifest_digest = $4 AND chunk.chunk_id = $5`,
    [principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId],
  );
  return result.rows[0] ?? null;
}

interface StoredTypedRow {
  typed_record_id: string;
  stream: number;
  occurrence_id: Uint8Array;
  observed_at_ms: string;
  provider: string;
  attribution_id: string | null;
  account_basis: number | null;
  account_track: Uint8Array | null;
  plan_basis: number | null;
  plan_type: string | null;
  plan_era: Uint8Array | null;
  session_value: Uint8Array | null;
  model: string | null; speed_mode: string | null; api_service_tier: string | null;
  surface: string | null; billing_surface: string | null; reasoning_effort: string | null;
  agent_scope: string | null; outcome: string | null;
  total_input_context_tokens: string | null; input_uncached_tokens: string | null;
  input_cache_read_tokens: string | null; input_cache_write_tokens: string | null;
  output_text_tokens: string | null; output_reasoning_tokens: string | null;
  output_combined_tokens: string | null;
  quota_plan_type: string | null; quota_plan_variant: string | null; limit_value: string | null;
  slot_value: string | null; used_percent: number | null; window_duration_minutes: number | null;
  resets_at_ms: string | null;
  tools: Record<string, string | number> | null;
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw unavailable();
  return parsed;
}

/** Rebuild one typed v1.1 record exactly as D1's codec decodes it. */
function decodeStoredRow(row: StoredTypedRow): TelemetryV11Record {
  const stream = STREAMS[row.stream - 1];
  if (!stream) throw unavailable();
  const attribution = row.attribution_id === null ? null : {
    accountBasis: ACCOUNT_BASES[row.account_basis ?? -1],
    accountTrackId: row.account_track === null || row.account_track.byteLength === 0
      ? null : decodeTypedTelemetryId(Uint8Array.from(row.account_track)),
    planBasis: PLAN_BASES[row.plan_basis ?? -1],
    planType: row.plan_type,
    planEraId: row.plan_era === null || row.plan_era.byteLength === 0
      ? null : decodeTypedTelemetryId(Uint8Array.from(row.plan_era)),
  };
  const fields: TypedTelemetryFields = {
    format: "v11",
    stream,
    occurrenceId: Uint8Array.from(row.occurrence_id),
    observedAtMs: count(row.observed_at_ms),
    provider: row.provider,
    attribution: attribution as TypedTelemetryFields["attribution"],
    usage: stream === "usage" ? {
      sessionId: Uint8Array.from(row.session_value ?? new Uint8Array()),
      modelId: row.model ?? "", speedMode: row.speed_mode ?? "", apiServiceTier: row.api_service_tier ?? "",
      surface: row.surface ?? "", billingSurface: row.billing_surface ?? "",
      reasoningEffort: row.reasoning_effort ?? "", agentScope: row.agent_scope ?? "", outcome: row.outcome ?? "",
      totalInputContextTokens: nullableNumber(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableNumber(row.input_uncached_tokens),
        inputCacheReadTokens: nullableNumber(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableNumber(row.input_cache_write_tokens),
        outputTextTokens: nullableNumber(row.output_text_tokens),
        outputReasoningTokens: nullableNumber(row.output_reasoning_tokens),
        outputCombinedTokens: nullableNumber(row.output_combined_tokens),
      } as NonNullable<TypedTelemetryFields["usage"]>["components"],
    } : null,
    quota: stream === "quota" ? {
      planType: row.quota_plan_type ?? "", planVariant: row.quota_plan_variant ?? "",
      limitId: row.limit_value ?? "", slot: row.slot_value ?? "",
      usedPercent: row.used_percent, windowDurationMinutes: row.window_duration_minutes,
      resetsAtMs: nullableNumber(row.resets_at_ms),
    } : null,
    tools: stream === "session"
      ? Object.fromEntries(Object.entries(row.tools ?? {}).map(([key, value]) => [key, count(value)]))
      : null,
  };
  return typedTelemetryCanonicalRecords(fields).record as TelemetryV11Record;
}

/**
 * readTelemetryV11StorageReplay (typed mode): a replay receipt proves the
 * complete retained records, not merely a header.
 */
async function provenReplay(
  client: PostgresClient,
  s: string,
  namespaceId: string,
  prior: ExistingChunkRow,
  chunk: TelemetryV11Chunk,
): Promise<void> {
  const rows = (await client.query<StoredTypedRow>(
    `SELECT record.id::text AS typed_record_id, record.stream, record.occurrence_id,
            record.observed_at_ms::text AS observed_at_ms, provider.value AS provider,
            attribution.id::text AS attribution_id, attribution.account_basis, attribution.account_track,
            attribution.plan_basis, plan_type.value AS plan_type, attribution.plan_era,
            session_identifier.value AS session_value,
            model.value AS model, speed.value AS speed_mode, tier.value AS api_service_tier,
            surface.value AS surface, billing.value AS billing_surface, effort.value AS reasoning_effort,
            scope.value AS agent_scope, outcome.value AS outcome,
            usage.total_input_context_tokens::text AS total_input_context_tokens,
            usage.input_uncached_tokens::text AS input_uncached_tokens,
            usage.input_cache_read_tokens::text AS input_cache_read_tokens,
            usage.input_cache_write_tokens::text AS input_cache_write_tokens,
            usage.output_text_tokens::text AS output_text_tokens,
            usage.output_reasoning_tokens::text AS output_reasoning_tokens,
            usage.output_combined_tokens::text AS output_combined_tokens,
            quota_plan.value AS quota_plan_type, quota_variant.value AS quota_plan_variant,
            quota_limit.value AS limit_value, quota_slot.value AS slot_value,
            quota.used_percent, quota.window_duration_minutes, quota.resets_at_ms::text AS resets_at_ms,
            (SELECT jsonb_object_agg(tool.value, tools.count)
               FROM ${t(s, "typed_telemetry_session_tools")} tools
               JOIN ${t(s, "typed_telemetry_dictionary")} tool ON tool.id = tools.tool_class_id
              WHERE tools.record_id = record.id) AS tools
       FROM ${t(s, "typed_v11_record_admissions")} admission
       JOIN ${t(s, "typed_telemetry_records")} record ON record.id = admission.typed_record_id
       JOIN ${t(s, "typed_telemetry_devices")} device ON device.id = record.device_id
       JOIN ${t(s, "typed_telemetry_dictionary")} provider ON provider.id = record.provider_id
       LEFT JOIN ${t(s, "typed_telemetry_usage")} usage ON usage.record_id = record.id
       LEFT JOIN ${t(s, "typed_telemetry_quota")} quota ON quota.record_id = record.id
       LEFT JOIN ${t(s, "typed_telemetry_quota_dimensions")} dimensions ON dimensions.id = quota.dimensions_id
       LEFT JOIN ${t(s, "typed_telemetry_attributions")} attribution
         ON attribution.id = COALESCE(usage.attribution_id, dimensions.attribution_id)
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} plan_type ON plan_type.id = attribution.plan_type_id
       LEFT JOIN ${t(s, "typed_telemetry_identifiers")} session_identifier ON session_identifier.id = usage.session_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} model ON model.id = usage.model_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} speed ON speed.id = usage.speed_mode_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} tier ON tier.id = usage.api_service_tier_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} surface ON surface.id = usage.surface_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} billing ON billing.id = usage.billing_surface_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} effort ON effort.id = usage.reasoning_effort_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} scope ON scope.id = usage.agent_scope_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} outcome ON outcome.id = usage.outcome_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_plan ON quota_plan.id = dimensions.plan_type_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_variant ON quota_variant.id = dimensions.plan_variant_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_limit ON quota_limit.id = quota.limit_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_slot ON quota_slot.id = quota.slot_id
      WHERE admission.chunk_id = $1 AND admission.manifest_id = $2
        AND record.namespace_id = $3 AND record.format = 11
      ORDER BY record.source_row_id LIMIT 201`,
    [prior.id, prior.manifest_id, namespaceId],
  )).rows;
  if (rows.length !== count(prior.record_count) || rows.length > MAX_CHUNK_RECORDS) throw unavailable();
  const records = rows.map(decodeStoredRow);
  if (await sha256Hex(canonicalTelemetryV11Json(records)) !== chunk.chunkDigest) throw unavailable();
}

/**
 * The replay a contribution handler checks before writing an object:
 * null when absent; 409 on a different chunk under the same identity; 503
 * unless the retained typed records reproduce the chunk digest exactly.
 */
export async function readPostgresTelemetryV11StorageReplay(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  chunk: TelemetryV11Chunk,
  options: PostgresTelemetryV11Options = {},
): Promise<PostgresTelemetryV11StagedChunkRow | null> {
  validPrincipal(principal);
  const sourceNamespace = requireNamespace(options);
  const { quoted: s } = schemaOf(options);
  try {
    return await withPostgresRead(pool, async (client) => {
      const prior = await existingChunk(client, s, principal, chunk);
      if (!prior) return null;
      if (prior.chunk_digest !== chunk.chunkDigest || count(prior.record_count) !== chunk.records.length) {
        throw manifestConflict();
      }
      try {
        const state = await admissionState(client, s, sourceNamespace, false);
        await provenReplay(client, s, state.namespaceId, prior, chunk);
      } catch {
        throw unavailable();
      }
      return Object.freeze({
        id: prior.id, manifestId: prior.manifest_id,
        chunkDigest: prior.chunk_digest, recordCount: count(prior.record_count),
      });
    }, { operation: "telemetry.v11.replay", preserveSafeError: (error) => (error instanceof ApiError ? error : null) });
  } catch (error) {
    storageFailure(error);
  }
}

interface TypedRow {
  readonly fields: TypedTelemetryFields;
  readonly sourceRowId: number;
  readonly canonicalDigest: Uint8Array;
  readonly baseDigest: Uint8Array;
  readonly legacyOccurrence: Uint8Array | null;
  readonly legacyDigest: Uint8Array | null;
}

function placeholders(rows: number, columns: number, first = 1): string {
  let index = first;
  return Array.from({ length: rows }, () =>
    `(${Array.from({ length: columns }, () => `$${index++}`).join(", ")})`).join(", ");
}

function attributionKey(value: NonNullable<TypedTelemetryFields["attribution"]>): string {
  return JSON.stringify([value.accountBasis, value.accountTrackId, value.planBasis, value.planType, value.planEraId]);
}

function attributionBind(value: NonNullable<TypedTelemetryFields["attribution"]>): unknown[] {
  return [
    ACCOUNT_BASES.indexOf(value.accountBasis),
    value.accountTrackId === null ? new Uint8Array(0) : bytes(encodeTypedTelemetryId(value.accountTrackId)),
    PLAN_BASES.indexOf(value.planBasis),
    value.planType,
    value.planEraId === null ? new Uint8Array(0) : bytes(encodeTypedTelemetryId(value.planEraId)),
  ];
}

/** Ensure one row per natural key and return its id. */
async function ensureId(
  client: PostgresClient,
  insertSql: string,
  selectSql: string,
  values: unknown[],
): Promise<string> {
  await client.query(insertSql, values);
  const selected = await client.query<{ id: string }>(selectSql, values);
  if (selected.rows.length !== 1 || typeof selected.rows[0]?.id !== "string") throw unavailable();
  return selected.rows[0].id;
}

/**
 * persistTypedV11StagedChunk: header, authorization consumption, numeric
 * source range, typed records, proofs and readiness commit in ONE bounded
 * transaction (D1's single typed batch). The object store write happened
 * before this call; nothing here touches the network.
 */
export async function persistPostgresTypedV11StagedChunk(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  value: unknown,
  metadata: PostgresTelemetryV11ChunkMetadata,
  nowEpoch = Date.now(),
  options: PostgresTelemetryV11Options = {},
): Promise<PostgresTelemetryV11StagedChunkResult> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
      || Object.keys(metadata).sort().join(",") !== "chunkRowId,deviceUploadAuthorizationId,envelopeDigest,r2Key"
      || typeof metadata.r2Key !== "string" || metadata.r2Key.length < 1 || metadata.r2Key.length > 1024
      || metadata.r2Key.includes("\0") || typeof metadata.envelopeDigest !== "string"
      || !DIGEST.test(metadata.envelopeDigest)
      || typeof metadata.deviceUploadAuthorizationId !== "string"
      || metadata.deviceUploadAuthorizationId.length < 1 || metadata.deviceUploadAuthorizationId.length > 256
      || typeof metadata.chunkRowId !== "string") {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  try { encodeTypedTelemetryId(metadata.chunkRowId); } catch { throw new ApiError(400, "CHUNK_INVALID"); }
  validPrincipal(principal);
  const now = nowDate(nowEpoch);
  const chunk = await validatePostgresTelemetryV11StagedChunk(value);
  const { stream, day, seq } = parseTelemetryV11ChunkId(chunk.chunkId);
  const sourceNamespace = requireNamespace(options);
  const { quoted: s, config } = schemaOf(options);
  const fields = chunk.records.map((record) => encodeTypedTelemetryRecord("v11", record));
  if (fields.some((field) => field.stream !== stream)) throw new ApiError(400, "CHUNK_INVALID");
  const proofs = await Promise.all(chunk.records.map(async (record, index) => {
    const field = fields[index]!;
    const canonical = typedTelemetryCanonicalRecords(field).canonicalRecord;
    const base = { ...record } as Record<string, unknown>;
    delete base.accountPlanAttribution;
    const legacy = telemetryV11LegacyProjection(stream, record);
    return {
      canonicalDigest: bytes(await sha256(canonical)),
      baseDigest: bytes(await sha256(canonicalTelemetryV11Json(base))),
      legacyOccurrence: legacy ? bytes(encodeTypedTelemetryId(legacy.occurrenceId)) : null,
      legacyDigest: legacy ? bytes(await sha256(legacy.canonicalRecord)) : null,
    };
  }));
  try {
    return await withPostgresMutation(pool, async (client) => {
      await assertV11WriteAllowed(client, principal, config, nowEpoch);
      const manifest = await manifestByDigest(client, s, principal, day, chunk.manifestDigest, "FOR UPDATE");
      if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
      const prior = await existingChunk(client, s, principal, chunk);
      const state = await admissionState(client, s, sourceNamespace, prior === null);
      if (prior) {
        if (prior.chunk_digest !== chunk.chunkDigest || count(prior.record_count) !== chunk.records.length) {
          throw manifestConflict();
        }
        const complete = await client.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM ${t(s, "typed_v11_record_admissions")} admission
             JOIN ${t(s, "typed_telemetry_records")} record ON record.id = admission.typed_record_id
            WHERE admission.chunk_id = $1 AND admission.manifest_id = $2
              AND record.namespace_id = $3 AND record.format = 11`,
          [prior.id, prior.manifest_id, state.namespaceId],
        );
        if (count(complete.rows[0]?.total) !== count(prior.record_count)) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        }
        return Object.freeze({
          contributionId: prior.id, manifestId: prior.manifest_id, chunkId: chunk.chunkId, replay: true,
        });
      }
      // D1 0058 telemetry_v11_chunk_admission: staged day, same parser, and
      // the chunk exactly as the manifest declared it.
      let declared: TelemetryV11DayManifest;
      try { declared = parseTelemetryV11DayManifest(JSON.parse(manifest.manifest_json)); }
      catch { throw unavailable(); }
      const expected = declared.chunks.find((entry) => entry.chunkId === chunk.chunkId);
      if (manifest.state !== "staged" || manifest.parser_version !== chunk.parserVersion
          || !expected || expected.chunkDigest !== chunk.chunkDigest
          || expected.recordCount !== chunk.records.length) {
        throw manifestConflict();
      }
      const grant = await client.query<{ id: string }>(
        `SELECT id FROM ${t(s, "device_upload_authorizations")}
          WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3
            AND state = 'consuming' AND envelope_digest = $4
            AND consume_lease_expires_at > $5 AND expires_at > $5
          FOR UPDATE`,
        [metadata.deviceUploadAuthorizationId, principal.participantId, principal.deviceId,
          metadata.envelopeDigest, now],
      );
      if (grant.rows.length !== 1) throw manifestConflict();
      // D1 0058 telemetry_v11_chunks_enforce_admission: 20000 chunks per
      // device and UTC day in its first week, 2000 afterwards.
      const windowDay = now.toISOString().slice(0, 10);
      const windowRow = await client.query<{ accepted: string; fresh: boolean }>(
        `SELECT COALESCE((SELECT accepted_count FROM ${t(s, "telemetry_v1_chunk_admission_windows")}
                  WHERE participant_id = $1 AND device_id = $2 AND window_day = $3::date
                  FOR UPDATE), 0)::text AS accepted,
                (SELECT issued_at > $4::timestamptz - interval '7 days'
                   FROM ${t(s, "device_credentials")} WHERE id = $2) AS fresh`,
        [principal.participantId, principal.deviceId, windowDay, now],
      );
      const limit = windowRow.rows[0]?.fresh === true ? 20_000 : 2_000;
      if (count(windowRow.rows[0]?.accepted) >= limit) {
        throw new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
      }
      if (!Number.isSafeInteger(state.nextSourceRowId + chunk.records.length)) throw unavailable();
      await verifyPostgresTypedIdentityHeadroom(client, { primarySchema: config.primarySchema });

      await client.query(
        `INSERT INTO ${t(s, "telemetry_v11_chunks")} (
           id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
           chunk_digest, envelope_digest, parser_version, record_count, r2_key,
           device_upload_authorization_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [metadata.chunkRowId, manifest.id, principal.participantId, principal.deviceId, stream, day, seq,
          chunk.chunkId, chunk.chunkDigest, metadata.envelopeDigest, chunk.parserVersion,
          chunk.records.length, metadata.r2Key, metadata.deviceUploadAuthorizationId, now],
      );
      await client.query(
        `INSERT INTO ${t(s, "telemetry_v1_chunk_admission_windows")} (
           participant_id, device_id, window_day, accepted_count, last_accepted_at
         ) VALUES ($1, $2, $3::date, 1, $4)
         ON CONFLICT (participant_id, device_id, window_day) DO UPDATE SET
           accepted_count = ${t(s, "telemetry_v1_chunk_admission_windows")}.accepted_count + 1,
           last_accepted_at = EXCLUDED.last_accepted_at`,
        [principal.participantId, principal.deviceId, windowDay, now],
      );

      // Shared typed dictionaries and the owner's typed identity (D1
      // prepareTypedTelemetryInsert, parent before child).
      const tokens = new Set<string>();
      for (const field of fields) {
        tokens.add(field.provider);
        if (field.attribution) tokens.add(field.attribution.planType);
        if (field.usage) {
          const usage = field.usage;
          for (const token of [usage.modelId, usage.speedMode, usage.apiServiceTier, usage.surface,
            usage.billingSurface, usage.reasoningEffort, usage.agentScope, usage.outcome]) tokens.add(token);
        }
        if (field.quota) {
          for (const token of [field.quota.planType, field.quota.planVariant, field.quota.limitId,
            field.quota.slot]) tokens.add(token);
        }
        for (const tool of Object.keys(field.tools ?? {})) tokens.add(tool);
      }
      const tokenList = [...tokens];
      await client.query(
        `INSERT INTO ${t(s, "typed_telemetry_dictionary")} (value)
         SELECT unnest($1::text[]) ON CONFLICT (value) DO NOTHING`,
        [tokenList],
      );
      const dictionary = new Map((await client.query<{ id: string; value: string }>(
        `SELECT id::text AS id, value FROM ${t(s, "typed_telemetry_dictionary")} WHERE value = ANY($1::text[])`,
        [tokenList],
      )).rows.map((row) => [row.value, row.id]));
      if (dictionary.size !== tokenList.length) throw unavailable();
      const word = (value: string): string => dictionary.get(value) ?? (() => { throw unavailable(); })();

      const ns = state.namespaceId;
      const ownerId = await ensureId(client,
        `INSERT INTO ${t(s, "typed_telemetry_owners")} (namespace_id, original_id) VALUES ($1, $2)
         ON CONFLICT (namespace_id, original_id) DO NOTHING`,
        `SELECT id::text AS id FROM ${t(s, "typed_telemetry_owners")} WHERE namespace_id = $1 AND original_id = $2`,
        [ns, bytes(encodeTypedTelemetryId(principal.participantId))]);
      await client.query(
        `INSERT INTO ${t(s, "typed_telemetry_owner_memberships")} (
           namespace_id, source_format, owner_id, participant_id, source_namespace
         ) VALUES ($1, 11, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [ns, ownerId, principal.participantId, sourceNamespace],
      );
      const membership = await client.query(
        `SELECT 1 FROM ${t(s, "typed_telemetry_owner_memberships")}
          WHERE namespace_id = $1 AND source_format = 11 AND owner_id = $2
            AND participant_id = $3 AND source_namespace = $4`,
        [ns, ownerId, principal.participantId, sourceNamespace],
      );
      if (membership.rows.length !== 1) throw unavailable();
      const device = await client.query<{ id: string; owner_id: string }>(
        `WITH inserted AS (
           INSERT INTO ${t(s, "typed_telemetry_devices")} (namespace_id, owner_id, original_id)
           VALUES ($1, $2, $3) ON CONFLICT (namespace_id, original_id) DO NOTHING RETURNING id, owner_id)
         SELECT id::text AS id, owner_id::text AS owner_id FROM inserted
         UNION ALL
         SELECT id::text, owner_id::text FROM ${t(s, "typed_telemetry_devices")}
          WHERE namespace_id = $1 AND original_id = $3 AND NOT EXISTS (SELECT 1 FROM inserted)`,
        [ns, ownerId, bytes(encodeTypedTelemetryId(principal.deviceId))],
      );
      if (device.rows.length !== 1 || device.rows[0]!.owner_id !== ownerId) throw manifestConflict();
      const deviceId = device.rows[0]!.id;
      const dayNumber = typedTelemetryDayNumber(day);
      const typedManifest = await client.query<{ id: string; owner_id: string; device_id: string; chunk_day: number }>(
        `WITH inserted AS (
           INSERT INTO ${t(s, "typed_telemetry_manifests")} (namespace_id, owner_id, device_id, original_id, chunk_day)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (namespace_id, original_id) DO NOTHING
           RETURNING id, owner_id, device_id, chunk_day)
         SELECT id::text AS id, owner_id::text AS owner_id, device_id::text AS device_id, chunk_day FROM inserted
         UNION ALL
         SELECT id::text, owner_id::text, device_id::text, chunk_day FROM ${t(s, "typed_telemetry_manifests")}
          WHERE namespace_id = $1 AND original_id = $4 AND NOT EXISTS (SELECT 1 FROM inserted)`,
        [ns, ownerId, deviceId, bytes(encodeTypedTelemetryId(manifest.id)), dayNumber],
      );
      const typedManifestRow = typedManifest.rows[0];
      if (typedManifest.rows.length !== 1 || typedManifestRow!.owner_id !== ownerId
          || typedManifestRow!.device_id !== deviceId || typedManifestRow!.chunk_day !== dayNumber) {
        throw manifestConflict();
      }
      const typedManifestId = typedManifestRow!.id;
      const typedChunk = await client.query<{ id: string }>(
        `INSERT INTO ${t(s, "typed_telemetry_chunks")} (
           namespace_id, format, owner_id, device_id, manifest_id, original_id, stream, chunk_day
         ) VALUES ($1, 11, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
        [ns, ownerId, deviceId, typedManifestId, bytes(encodeTypedTelemetryId(metadata.chunkRowId)),
          STREAMS.indexOf(stream) + 1, dayNumber],
      );
      const typedChunkId = typedChunk.rows[0]?.id;
      if (typeof typedChunkId !== "string") throw unavailable();

      const sessionValues = [...new Map(fields.filter((field) => field.usage)
        .map((field) => [hex(field.usage!.sessionId), bytes(field.usage!.sessionId)])).values()];
      const sessions = new Map<string, string>();
      if (sessionValues.length) {
        await client.query(
          `INSERT INTO ${t(s, "typed_telemetry_identifiers")} (namespace_id, owner_id, value)
           SELECT $1, $2, unnest($3::bytea[]) ON CONFLICT (namespace_id, owner_id, value) DO NOTHING`,
          [ns, ownerId, sessionValues],
        );
        for (const row of (await client.query<{ id: string; value: Uint8Array }>(
          `SELECT id::text AS id, value FROM ${t(s, "typed_telemetry_identifiers")}
            WHERE namespace_id = $1 AND owner_id = $2 AND value = ANY($3::bytea[])`,
          [ns, ownerId, sessionValues],
        )).rows) sessions.set(hex(Uint8Array.from(row.value)), row.id);
        if (sessions.size !== sessionValues.length) throw unavailable();
      }

      const attributionValues = [...new Map(fields.filter((field) => field.attribution)
        .map((field) => [attributionKey(field.attribution!), field.attribution!])).values()];
      const attributions = new Map<string, string>();
      for (const attribution of attributionValues) {
        const bind = attributionBind(attribution);
        const id = await ensureId(client,
          `INSERT INTO ${t(s, "typed_telemetry_attributions")} (
             namespace_id, owner_id, account_basis, account_track, plan_basis, plan_type_id, plan_era
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (namespace_id, owner_id, account_basis, account_track, plan_basis, plan_type_id, plan_era)
           DO NOTHING`,
          `SELECT id::text AS id FROM ${t(s, "typed_telemetry_attributions")}
            WHERE namespace_id = $1 AND owner_id = $2 AND account_basis = $3 AND account_track = $4
              AND plan_basis = $5 AND plan_type_id = $6 AND plan_era = $7`,
          [ns, ownerId, bind[0], bind[1], bind[2], word(String(bind[3])), bind[4]]);
        attributions.set(attributionKey(attribution), id);
      }
      const dimensions = new Map<string, string>();
      for (const field of fields) {
        if (!field.quota) continue;
        const attributionId = field.attribution ? attributions.get(attributionKey(field.attribution)) ?? null : null;
        const key = JSON.stringify([field.quota.planType, field.quota.planVariant, attributionId]);
        if (dimensions.has(key)) continue;
        const id = await ensureId(client,
          `INSERT INTO ${t(s, "typed_telemetry_quota_dimensions")} (
             namespace_id, owner_id, plan_type_id, plan_variant_id, attribution_id
           ) VALUES ($1, $2, $3, $4, $5::bigint)
           ON CONFLICT (namespace_id, owner_id, plan_type_id, plan_variant_id, (coalesce(attribution_id, 0)))
           DO NOTHING`,
          `SELECT id::text AS id FROM ${t(s, "typed_telemetry_quota_dimensions")}
            WHERE namespace_id = $1 AND owner_id = $2 AND plan_type_id = $3 AND plan_variant_id = $4
              AND attribution_id IS NOT DISTINCT FROM $5::bigint`,
          [ns, ownerId, word(field.quota.planType), word(field.quota.planVariant), attributionId]);
        dimensions.set(key, id);
      }

      // Numeric source range: D1 typed_v11_allocation_guard/advance.
      const firstSourceRowId = state.nextSourceRowId;
      await client.query(
        `INSERT INTO ${t(s, "typed_v11_chunk_allocations")} (
           chunk_id, namespace_id, chunk_original, first_source_row_id, record_count
         ) VALUES ($1, $2, $3, $4, $5)`,
        [metadata.chunkRowId, ns, bytes(encodeTypedTelemetryId(metadata.chunkRowId)),
          firstSourceRowId, chunk.records.length],
      );
      const advanced = await client.query(
        `UPDATE ${t(s, "typed_v11_admission_state")} SET next_source_row_id = $2
          WHERE id = 1 AND namespace_id = $1 AND next_source_row_id = $3`,
        [ns, firstSourceRowId + chunk.records.length, firstSourceRowId],
      );
      if (advanced.rowCount !== 1) {
        throw new ApiError(409, "UPLOAD_IN_PROGRESS", { responseHeaders: { "retry-after": "1" } });
      }

      const typed: TypedRow[] = fields.map((field, index) => ({
        fields: field,
        sourceRowId: firstSourceRowId + index,
        canonicalDigest: proofs[index]!.canonicalDigest,
        baseDigest: proofs[index]!.baseDigest,
        legacyOccurrence: proofs[index]!.legacyOccurrence,
        legacyDigest: proofs[index]!.legacyDigest,
      }));
      const recordBind: unknown[] = [ns, ownerId, deviceId, typedChunkId, typedManifestId,
        STREAMS.indexOf(stream) + 1, dayNumber];
      const recordTuples = typed.map((row) => {
        const first = recordBind.length + 1;
        recordBind.push(row.sourceRowId, bytes(row.fields.occurrenceId), row.fields.observedAtMs,
          word(row.fields.provider), row.canonicalDigest);
        return `($${first}::bigint, $${first + 1}::bytea, $${first + 2}::bigint, $${first + 3}::bigint, $${first + 4}::bytea)`;
      });
      const inserted = await client.query<{ id: string; source_row_id: string }>(
        `INSERT INTO ${t(s, "typed_telemetry_records")} (
           namespace_id, format, source_row_id, owner_id, device_id, chunk_id, manifest_id, stream,
           occurrence_id, observed_at_ms, observed_day, provider_id, canonical_digest
         ) SELECT $1, 11, input.source_row_id, $2, $3, $4, $5, $6, input.occurrence_id,
                  input.observed_at_ms, $7, input.provider_id, input.canonical_digest
             FROM (VALUES ${recordTuples.join(", ")})
               AS input(source_row_id, occurrence_id, observed_at_ms, provider_id, canonical_digest)
         RETURNING id::text AS id, source_row_id::text AS source_row_id`,
        recordBind,
      );
      const recordIds = new Map(inserted.rows.map((row) => [count(row.source_row_id), row.id]));
      if (recordIds.size !== typed.length) throw unavailable();
      const recordId = (row: TypedRow): string => recordIds.get(row.sourceRowId) ?? (() => { throw unavailable(); })();

      if (stream === "usage") {
        const bind: unknown[] = [];
        const tuples = typed.map((row) => {
          const usage = row.fields.usage!;
          const first = bind.length + 1;
          bind.push(recordId(row), sessions.get(hex(usage.sessionId)),
            word(usage.modelId), word(usage.speedMode), word(usage.apiServiceTier), word(usage.surface),
            word(usage.billingSurface), word(usage.reasoningEffort), word(usage.agentScope), word(usage.outcome),
            row.fields.attribution ? attributions.get(attributionKey(row.fields.attribution)) : null,
            usage.totalInputContextTokens, usage.components.inputUncachedTokens,
            usage.components.inputCacheReadTokens, usage.components.inputCacheWriteTokens,
            usage.components.outputTextTokens, usage.components.outputReasoningTokens,
            usage.components.outputCombinedTokens);
          return `(${Array.from({ length: 18 }, (_, offset) => `$${first + offset}::bigint`).join(", ")})`;
        });
        await client.query(
          `INSERT INTO ${t(s, "typed_telemetry_usage")} (
             record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id,
             billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
             total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
             input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens
           ) VALUES ${tuples.join(", ")}`,
          bind,
        );
      } else if (stream === "quota") {
        const bind: unknown[] = [];
        const tuples = typed.map((row) => {
          const quota = row.fields.quota!;
          const attributionId = row.fields.attribution
            ? attributions.get(attributionKey(row.fields.attribution)) ?? null : null;
          const first = bind.length + 1;
          bind.push(recordId(row), dimensions.get(JSON.stringify([quota.planType, quota.planVariant, attributionId])),
            word(quota.limitId), word(quota.slot), quota.usedPercent, quota.windowDurationMinutes, quota.resetsAtMs);
          return `($${first}::bigint, $${first + 1}::bigint, $${first + 2}::bigint, $${first + 3}::bigint,
            $${first + 4}::double precision, $${first + 5}::integer, $${first + 6}::bigint)`;
        });
        await client.query(
          `INSERT INTO ${t(s, "typed_telemetry_quota")} (
             record_id, dimensions_id, limit_id, slot_id, used_percent, window_duration_minutes, resets_at_ms
           ) VALUES ${tuples.join(", ")}`,
          bind,
        );
      } else {
        const bind: unknown[] = [];
        const tuples: string[] = [];
        for (const row of typed) {
          for (const [tool, total] of Object.entries(row.fields.tools ?? {})) {
            const first = bind.length + 1;
            bind.push(recordId(row), word(tool), total);
            tuples.push(`($${first}::bigint, $${first + 1}::bigint, $${first + 2}::bigint)`);
          }
        }
        if (tuples.length) {
          await client.query(
            `INSERT INTO ${t(s, "typed_telemetry_session_tools")} (record_id, tool_class_id, count)
             VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
            bind,
          );
        }
      }

      await client.query(
        `INSERT INTO ${t(s, "typed_v11_manifest_memberships")} (manifest_id, typed_manifest_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [manifest.id, typedManifestId],
      );
      const proofBind: unknown[] = [typedChunkId, typedManifestId, STREAMS.indexOf(stream) + 1];
      const proofTuples = typed.map((row) => {
        const first = proofBind.length + 1;
        proofBind.push(recordId(row), bytes(row.fields.occurrenceId), row.baseDigest,
          row.legacyOccurrence, row.legacyDigest, row.fields.observedAtMs);
        return `($${first}::bigint, $${first + 1}::bytea, $${first + 2}::bytea, $${first + 3}::bytea,
          $${first + 4}::bytea, $${first + 5}::bigint)`;
      });
      await client.query(
        `INSERT INTO ${t(s, "typed_v11_record_proofs")} (
           typed_record_id, chunk_key, manifest_key, stream_code, occurrence_blob, base_digest,
           legacy_occurrence_blob, legacy_digest, observed_at_ms
         ) SELECT input.typed_record_id, $1, $2, $3, input.occurrence_blob, input.base_digest,
                  input.legacy_occurrence_blob, input.legacy_digest, input.observed_at_ms
             FROM (VALUES ${proofTuples.join(", ")}) AS input(
               typed_record_id, occurrence_blob, base_digest, legacy_occurrence_blob, legacy_digest, observed_at_ms)`,
        proofBind,
      );

      // D1 0058 telemetry_v11_chunks_record_admission: the chunk row consumes
      // its one-use grant in the same transaction.
      const consumed = await client.query(
        `UPDATE ${t(s, "device_upload_authorizations")}
            SET state = 'consumed', consumed_at = $2, consume_lease_expires_at = NULL,
                consumed_contribution_id = $3
          WHERE id = $1 AND state = 'consuming'`,
        [metadata.deviceUploadAuthorizationId, now, metadata.chunkRowId],
      );
      if (consumed.rowCount !== 1) throw manifestConflict();
      await client.query(
        `UPDATE ${t(s, "telemetry_v11_day_manifests")} manifest SET state = 'ready', ready_at = $2
          WHERE manifest.id = $1 AND manifest.state = 'staged'
            AND manifest.expected_chunk_count = (
              SELECT count(*) FROM ${t(s, "telemetry_v11_chunks")} chunk WHERE chunk.manifest_id = $1)
            AND NOT EXISTS (
              SELECT 1 FROM ${t(s, "telemetry_v11_chunks")} chunk
               WHERE chunk.manifest_id = $1 AND chunk.record_count <> (
                 SELECT count(*) FROM ${t(s, "typed_v11_record_admissions")} admission
                  WHERE admission.chunk_id = chunk.id))`,
        [manifest.id, now],
      );
      return Object.freeze({
        contributionId: metadata.chunkRowId, manifestId: manifest.id, chunkId: chunk.chunkId, replay: false,
      });
    }, {
      operation: "telemetry.v11.stage",
      isolationLevel: "read_committed",
      statementTimeoutMilliseconds: 60_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: admissionError,
    });
  } catch (error) {
    storageFailure(error);
  }
}

/**
 * The upload outcome of one attempt after an uncertain persist: 'committed'
 * when this attempt's own chunk row and every proof are durable, 'replay'
 * when an identical chunk from another attempt is, 'conflict' for a
 * different chunk under the same identity, 'absent' when neither exists.
 */
export async function readPostgresTelemetryV11UploadOutcome(
  pool: PostgresPool,
  principal: PostgresTelemetryV11Principal,
  chunk: TelemetryV11Chunk,
  attempt: { readonly chunkRowId: string; readonly r2Key: string; readonly authorizationId: string },
  options: PostgresTelemetryV11Options = {},
): Promise<{ outcome: "committed" | "replay" | "conflict" | "absent"; row: PostgresTelemetryV11StagedChunkRow | null }> {
  validPrincipal(principal);
  const { quoted: s } = schemaOf(options);
  try {
    return await withPostgresRead(pool, async (client) => {
      const own = await client.query<ExistingChunkRow>(
        `SELECT id, manifest_id, chunk_digest, record_count FROM ${t(s, "telemetry_v11_chunks")}
          WHERE id = $1 OR r2_key = $2 OR device_upload_authorization_id = $3`,
        [attempt.chunkRowId, attempt.r2Key, attempt.authorizationId],
      );
      const prior = await existingChunk(client, s, principal, chunk);
      const proven = async (row: ExistingChunkRow): Promise<boolean> => count((await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM ${t(s, "typed_v11_record_admissions")} WHERE chunk_id = $1`,
        [row.id],
      )).rows[0]?.total) === count(row.record_count);
      const shape = (row: ExistingChunkRow) => Object.freeze({
        id: row.id, manifestId: row.manifest_id, chunkDigest: row.chunk_digest, recordCount: count(row.record_count),
      });
      if (own.rows.length > 1) throw unavailable();
      const ownRow = own.rows[0];
      if (ownRow) {
        if (ownRow.id !== attempt.chunkRowId || prior?.id !== ownRow.id
            || ownRow.chunk_digest !== chunk.chunkDigest || !await proven(ownRow)) throw unavailable();
        return { outcome: "committed" as const, row: shape(ownRow) };
      }
      if (!prior) return { outcome: "absent" as const, row: null };
      if (prior.chunk_digest !== chunk.chunkDigest || count(prior.record_count) !== chunk.records.length) {
        return { outcome: "conflict" as const, row: shape(prior) };
      }
      if (!await proven(prior)) throw unavailable();
      return { outcome: "replay" as const, row: shape(prior) };
    }, { operation: "telemetry.v11.outcome" });
  } catch {
    throw unavailable();
  }
}

/**
 * recordDeviceUploadReceipt: bind a claimed grant to the contribution it
 * acknowledged. A fresh chunk already consumed its grant in the persist
 * transaction (this then only verifies it); a replay consumes the new grant
 * against the retained chunk, as the Worker does.
 */
export async function recordPostgresTelemetryV11UploadReceipt(
  pool: PostgresPool,
  authorizationId: string,
  contributionId: string,
  nowEpoch = Date.now(),
  options: PostgresTelemetryV11Options = {},
): Promise<void> {
  const { quoted: s } = schemaOf(options);
  const now = nowDate(nowEpoch);
  let recorded: boolean;
  try {
    recorded = await withPostgresMutation(pool, async (client) => {
      const result = await client.query(
        `UPDATE ${t(s, "device_upload_authorizations")} grant_row
            SET state = 'consumed', consumed_at = $3, consumed_contribution_id = $2,
                consume_lease_expires_at = NULL
          WHERE grant_row.id = $1 AND grant_row.state = 'consuming'
            AND grant_row.consume_lease_expires_at > $3 AND grant_row.expires_at > $3
            AND (
              NOT EXISTS (
                SELECT 1 FROM ${t(s, "device_credentials")} device
                 WHERE device.id = grant_row.issued_by_device_id AND device.authority_kind = 'accountless')
              OR EXISTS (
                SELECT 1 FROM ${t(s, "device_credentials")} device
                  JOIN ${t(s, "participants")} participant ON participant.id = device.participant_id
                  JOIN ${t(s, "accountless_enrollment_ledger")} ledger
                    ON ledger.device_id = device.accountless_enrollment_device_id
                  JOIN ${t(s, "accountless_upload_owners")} owner ON owner.enrollment_device_id = ledger.device_id
                  JOIN ${t(s, "accountless_v11_device_authorizations")} v11_grant
                    ON v11_grant.enrollment_device_id = ledger.device_id
                 WHERE device.id = grant_row.issued_by_device_id
                   AND device.participant_id = grant_row.participant_id
                   AND device.authority_kind = 'accountless' AND device.state = 'active'
                   AND participant.owner_kind = 'accountless' AND participant.state = 'active'
                   AND ledger.state = 'active' AND ledger.expires_at = device.expires_at
                   AND ledger.expires_at > $3
                   AND owner.participant_id = participant.id AND owner.device_credential_id = device.id
                   AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
                   AND v11_grant.participant_id = participant.id AND v11_grant.device_credential_id = device.id
                   AND v11_grant.state = 'active' AND v11_grant.expires_at = ledger.expires_at))`,
        [authorizationId, contributionId, now],
      );
      if (result.rowCount === 1) return true;
      const existing = await client.query<{ state: string; consumed_contribution_id: string | null }>(
        `SELECT state, consumed_contribution_id FROM ${t(s, "device_upload_authorizations")} WHERE id = $1`,
        [authorizationId],
      );
      return existing.rows[0]?.state === "consumed" && existing.rows[0].consumed_contribution_id === contributionId;
    }, { operation: "telemetry.v11.receipt" });
  } catch {
    throw unavailable();
  }
  if (!recorded) throw new ApiError(500, "INTERNAL_ERROR");
}

// ------------------------------------------------------------------ domain --

export interface TelemetryV11DomainPredecessor {
  readonly schemaVersion: "telemetry-domain-predecessor-v1.1";
  readonly token: string;
  readonly previousGenerationId: string | null;
  readonly legacyFingerprint: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly expiresAt: string;
}

export interface TelemetryV11DomainActivation {
  readonly schemaVersion: "telemetry-domain-activation-v1.1";
  readonly generationId: string;
  readonly manifestDigest: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly replay: boolean;
  readonly unchanged?: true;
  readonly requestedManifestDigest?: string;
}

interface DomainStateRow {
  input_revision: string;
  generation_id: string | null;
  manifest_digest: string | null;
  from_day: string | null;
  through_day: string | null;
}

interface ActiveDomainRow {
  id: string;
  manifest_digest: string;
  from_day: string;
  through_day: string;
}

function activationResult(row: ActiveDomainRow, replay: boolean): TelemetryV11DomainActivation {
  return Object.freeze({
    schemaVersion: "telemetry-domain-activation-v1.1" as const,
    generationId: row.id,
    manifestDigest: row.manifest_digest,
    fromDay: row.from_day,
    throughDay: row.through_day,
    replay,
  });
}

/** activateTelemetryV11Domain's domainError, over this module's raises. */
class DomainRefusal extends Error {
  constructor(readonly reason:
    | "range_too_large" | "incomplete" | "occurrence_conflict" | "compatibility_unproven" | "predecessor_changed") {
    super(reason);
  }
}

function domainError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DomainRefusal) {
    switch (error.reason) {
      case "range_too_large": return new ApiError(400, "SYNC_RANGE_TOO_LARGE");
      case "incomplete": return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
      case "occurrence_conflict": return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
      case "compatibility_unproven": return new ApiError(409, "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE");
      default: return manifestConflict();
    }
  }
  if (driverField(error, "code") === "23505" && (driverField(error, "table") ?? "") === "telemetry_v11_domains") {
    return manifestConflict();
  }
  return unavailable();
}

async function domainState(
  client: PostgresClient,
  s: string,
  participantId: string,
): Promise<DomainStateRow | null> {
  const result = await client.query<DomainStateRow>(
    `SELECT version.revision::text AS input_revision, head.generation_id, domain.manifest_digest,
            to_char(domain.from_day, 'YYYY-MM-DD') AS from_day,
            to_char(domain.through_day, 'YYYY-MM-DD') AS through_day
       FROM ${t(s, "participants")} participant
       JOIN ${t(s, "community_analytical_input_versions")} version ON version.participant_id = participant.id
       LEFT JOIN ${t(s, "telemetry_v11_domain_heads")} head ON head.participant_id = participant.id
       LEFT JOIN ${t(s, "telemetry_v11_domains")} domain ON domain.id = head.generation_id
      WHERE participant.id = $1 AND participant.state = 'active'
      FOR UPDATE OF version`,
    [participantId],
  );
  return result.rows[0] ?? null;
}

/** D1 0058 telemetry_v11_current_predecessors for one token, in SQL. */
function currentPredecessorSql(s: string): string {
  return `SELECT x.token_hash, x.participant_id, x.device_id, x.previous_generation_id, x.legacy_fingerprint,
                 x.input_revision::text AS input_revision,
                 to_char(x.from_day, 'YYYY-MM-DD') AS from_day,
                 to_char(x.through_day, 'YYYY-MM-DD') AS through_day, x.winners_json
            FROM ${t(s, "telemetry_v11_domain_predecessors")} x
            JOIN ${t(s, "participants")} participant ON participant.id = x.participant_id AND participant.state = 'active'
            JOIN ${t(s, "device_credentials")} device ON device.id = x.device_id
             AND device.participant_id = x.participant_id AND device.state = 'active' AND device.expires_at > $2
            JOIN ${t(s, "telemetry_transport_participant_floors")} floor_row
              ON floor_row.participant_id = x.participant_id AND floor_row.minimum_rank <= 11
            JOIN ${t(s, "telemetry_transport_formats")} format_row
              ON format_row.schema_version = 'telemetry-contribution-v1.1' AND format_row.lifecycle = 'accepted'
            LEFT JOIN ${t(s, "telemetry_v11_device_consents")} social_grant
              ON social_grant.participant_id = x.participant_id AND social_grant.device_id = x.device_id
            LEFT JOIN ${t(s, "accountless_enrollment_ledger")} ledger ON ledger.device_id = device.accountless_enrollment_device_id
            LEFT JOIN ${t(s, "accountless_upload_owners")} owner ON owner.enrollment_device_id = ledger.device_id
            LEFT JOIN ${t(s, "accountless_v11_device_authorizations")} accountless_grant
              ON accountless_grant.enrollment_device_id = ledger.device_id
            JOIN ${t(s, "community_analytical_input_versions")} version
              ON version.participant_id = x.participant_id AND version.revision = x.input_revision
            LEFT JOIN ${t(s, "telemetry_v11_domain_heads")} head ON head.participant_id = x.participant_id
           WHERE x.token_hash = $1 AND x.consumed_at IS NULL AND x.expires_at > $2
             AND x.previous_generation_id IS NOT DISTINCT FROM head.generation_id
             AND (
               (participant.owner_kind = 'social' AND device.authority_kind = 'social'
                 AND social_grant.device_id IS NOT NULL)
               OR
               (participant.owner_kind = 'accountless' AND device.authority_kind = 'accountless'
                 AND ledger.state = 'active' AND ledger.expires_at = device.expires_at AND ledger.expires_at > $2
                 AND owner.participant_id = participant.id AND owner.device_credential_id = device.id
                 AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
                 AND accountless_grant.participant_id = participant.id
                 AND accountless_grant.device_credential_id = device.id
                 AND accountless_grant.state = 'active' AND accountless_grant.expires_at = ledger.expires_at))`;
}

interface PredecessorRow {
  token_hash: string;
  participant_id: string;
  device_id: string;
  previous_generation_id: string | null;
  legacy_fingerprint: string;
  input_revision: string;
  from_day: string;
  through_day: string;
  winners_json: string;
}

async function activeDomainByDigest(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryV11Principal,
  digest: string,
): Promise<ActiveDomainRow | null> {
  const result = await client.query<ActiveDomainRow>(
    `SELECT domain.id, domain.manifest_digest,
            to_char(domain.from_day, 'YYYY-MM-DD') AS from_day,
            to_char(domain.through_day, 'YYYY-MM-DD') AS through_day
       FROM ${t(s, "telemetry_v11_domain_heads")} head
       JOIN ${t(s, "telemetry_v11_domains")} domain ON domain.id = head.generation_id
       JOIN ${t(s, "participants")} participant ON participant.id = domain.participant_id AND participant.state = 'active'
      WHERE domain.participant_id = $1 AND domain.device_id = $2 AND domain.manifest_digest = $3`,
    [principal.participantId, principal.deviceId, digest],
  );
  return result.rows[0] ?? null;
}

function allAdmittedSourceTuples(chunks: readonly V1SourceChunk[]): V1SourceChunk[] {
  const tuples = new Map<string, V1SourceChunk>();
  for (const chunk of chunks) {
    const key = JSON.stringify([chunk.participant_id, chunk.chunk_day, chunk.device_id]);
    const previous = tuples.get(key);
    if (!previous || (previous.stream === "session" && chunk.stream !== "session")
        || chunk.created_at > previous.created_at) {
      tuples.set(key, chunk);
    }
  }
  const text = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...tuples.values()].sort((left, right) => text(left.participant_id, right.participant_id)
    || text(left.chunk_day, right.chunk_day) || text(left.device_id, right.device_id));
}

/** createTelemetryV11DomainPredecessor and activateTelemetryV11Domain. */
export function createPostgresTelemetryV11Domain(
  pool: PostgresPool,
  options: PostgresTelemetryV11Options = {},
): {
  createPredecessor(principal: PostgresTelemetryV11Principal, nowEpoch?: number): Promise<TelemetryV11DomainPredecessor>;
  activate(principal: PostgresTelemetryV11Principal, value: unknown, nowEpoch?: number): Promise<TelemetryV11DomainActivation>;
} {
  const { quoted: s, config } = schemaOf(options);

  return Object.freeze({
    async createPredecessor(principal: PostgresTelemetryV11Principal, nowEpoch = Date.now()) {
      validPrincipal(principal);
      const now = nowDate(nowEpoch).toISOString();
      const expiresAt = nowDate(nowEpoch + PREDECESSOR_TTL_MS).toISOString();
      try {
        return await withPostgresMutation(pool, async (client) => {
          await assertV11WriteAllowed(client, principal, config, nowEpoch);
          const state = await domainState(client, s, principal.participantId);
          const chunkRows = (await client.query<{
            id: string; participant_id: string; device_id: string; chunk_day: string; stream: string;
            revision: number; chunk_digest: string; parser_version: string; accepted_record_count: number;
            created_at: string;
          }>(
            `SELECT chunk.id, chunk.participant_id, chunk.device_id,
                    to_char(chunk.chunk_day, 'YYYY-MM-DD') AS chunk_day, chunk.stream, chunk.revision,
                    chunk.chunk_digest, chunk.parser_version, chunk.accepted_record_count,
                    to_char(chunk.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_TEXT}) AS created_at
               FROM ${t(s, "telemetry_v1_chunks")} chunk
              WHERE chunk.participant_id = $1 AND chunk.superseded_at IS NULL AND chunk.accepted_record_count > 0
              ORDER BY chunk.chunk_day, chunk.device_id COLLATE "C", chunk.stream COLLATE "C", chunk.id COLLATE "C"
              LIMIT $2`,
            [principal.participantId, MAX_V1_SOURCE_CHUNKS + 1],
          )).rows;
          const legacyRange = (await client.query<{ from_day: string | null; through_day: string | null }>(
            `SELECT to_char(min(range_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS from_day,
                    to_char(max(range_end AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS through_day
               FROM ${t(s, "telemetry_contributions")}
              WHERE participant_id = $1 AND status = 'accepted'
                AND transport_schema_version = 'telemetry-contribution-v0.2'`,
            [principal.participantId],
          )).rows[0];
          const runtime = (await client.query<{ source_state: string }>(
            `SELECT source_state FROM ${t(s, "telemetry_usage_correction_runtime")} WHERE id = 1`,
          )).rows[0];
          if (!state || !legacyRange) throw manifestConflict();
          const inputRevision = count(state.input_revision);
          if ([legacyRange.from_day, legacyRange.through_day].some((day) => day !== null && !utcDay(day))) {
            throw manifestConflict();
          }
          if (chunkRows.length > MAX_V1_SOURCE_CHUNKS) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
          const chunks: V1SourceChunk[] = chunkRows.map((row) => ({
            ...row, stream: row.stream as V1SourceChunk["stream"],
            revision: count(row.revision), accepted_record_count: count(row.accepted_record_count),
          }));
          const winners = selectV1WinningDevices(chunks);
          // PostgreSQL keeps D1's correction runtime state in source_state.
          const allSourceTuples = runtime?.source_state === "active" ? allAdmittedSourceTuples(chunks) : null;
          const closureDevices = allSourceTuples ?? winners;
          const today = now.slice(0, 10);
          const knownDays = [today, ...closureDevices.map((winner) =>
            "chunk_day" in winner ? winner.chunk_day : winner.observed_day),
          ...[state.from_day, state.through_day, legacyRange.from_day, legacyRange.through_day]
            .filter((day): day is string => day !== null)].sort();
          const fromDay = knownDays[0]!;
          const throughDay = knownDays.at(-1)!;
          if ((Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1 > MAX_TELEMETRY_V11_DOMAIN_DAYS) {
            throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
          }
          const legacyFingerprint = await sha256Hex(canonicalJson({
            method: V11_DOMAIN_METHOD_VERSION,
            participantId: principal.participantId, inputRevision,
            previousGenerationId: state.generation_id, previousManifestDigest: state.manifest_digest,
            chunks, winners: closureDevices, legacyRange,
          }));
          const token = crypto.randomUUID();
          const tokenHash = await sha256Hex(token);
          const winnersJson = JSON.stringify(closureDevices.map((winner) => [winner.participant_id,
            "chunk_day" in winner ? winner.chunk_day : winner.observed_day, winner.device_id]));
          // D1: drop this device's unconsumed predecessors that are expired or
          // beyond the newest seven, unless a domain references them.
          await client.query(
            `DELETE FROM ${t(s, "telemetry_v11_domain_predecessors")} p
              WHERE p.participant_id = $1 AND p.device_id = $2 AND p.consumed_at IS NULL
                AND (p.expires_at <= $3::timestamptz OR p.token_hash IN (
                  SELECT x.token_hash FROM ${t(s, "telemetry_v11_domain_predecessors")} x
                   WHERE x.participant_id = $1 AND x.device_id = $2 AND x.consumed_at IS NULL
                   ORDER BY x.created_at DESC, x.token_hash COLLATE "C" OFFSET 7))
                AND NOT EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_domains")} d
                  WHERE d.predecessor_token_hash = p.token_hash)`,
            [principal.participantId, principal.deviceId, now],
          );
          const inserted = await client.query(
            `INSERT INTO ${t(s, "telemetry_v11_domain_predecessors")} (
               token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
               input_revision, from_day, through_day, winners_json, created_at, expires_at
             ) SELECT $1, $2, $3, $4::text, $5, $6::integer, $7::date, $8::date, $9, $10::timestamptz, $11::timestamptz
                WHERE EXISTS (SELECT 1 FROM ${t(s, "community_analytical_input_versions")} version
                    JOIN ${t(s, "participants")} participant ON participant.id = version.participant_id
                     AND participant.state = 'active'
                   WHERE version.participant_id = $2 AND version.revision = $6::integer)
                  AND (SELECT generation_id FROM ${t(s, "telemetry_v11_domain_heads")}
                        WHERE participant_id = $2) IS NOT DISTINCT FROM $4::text
                  AND (SELECT count(*) FROM ${t(s, "telemetry_v11_domain_predecessors")} x
                        WHERE x.participant_id = $2 AND x.device_id = $3 AND x.consumed_at IS NULL
                          AND x.expires_at > $10::timestamptz) < 8
             RETURNING token_hash`,
            [tokenHash, principal.participantId, principal.deviceId, state.generation_id, legacyFingerprint,
              inputRevision, fromDay, throughDay, winnersJson, now, expiresAt],
          );
          if (inserted.rows.length !== 1) throw manifestConflict();
          return Object.freeze({
            schemaVersion: "telemetry-domain-predecessor-v1.1" as const,
            token, previousGenerationId: state.generation_id, legacyFingerprint, fromDay, throughDay, expiresAt,
          });
        }, { operation: "telemetry.v11.domain.predecessor", preserveSafeError: admissionError });
      } catch (error) {
        storageFailure(error);
      }
    },

    async activate(principal: PostgresTelemetryV11Principal, value: unknown, nowEpoch = Date.now()) {
      let manifest: ReturnType<typeof parseTelemetryV11DomainManifest>;
      try {
        manifest = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DomainManifest(value)));
      } catch {
        throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      }
      if (await sha256Hex(telemetryV11DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) {
        throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
      }
      validPrincipal(principal);
      const tokenHash = await sha256Hex(manifest.predecessor.token);
      const daysJson = canonicalTelemetryV11Json(manifest.days);
      const now = nowDate(nowEpoch).toISOString();
      // D1 runs assertTelemetryTransportWriteAllowed before its replay read
      // and outside the try whose catch acknowledges a replay, so a refused
      // principal (blocked format, missing consent, revoked device) gets that
      // refusal, never a replayed activation.
      let transportRefusal: unknown = null;
      try {
        return await withPostgresMutation(pool, async (client) => {
          try {
            await assertV11WriteAllowed(client, principal, config, nowEpoch);
          } catch (error) {
            transportRefusal = error;
            throw error;
          }
          const existing = await activeDomainByDigest(client, s, principal, manifest.manifestDigest);
          if (existing) return activationResult(existing, true);
          const state = await domainState(client, s, principal.participantId);
          if (!state) throw manifestConflict();
          const predecessorResult = await client.query<PredecessorRow>(
            `${currentPredecessorSql(s)} FOR UPDATE OF x`, [tokenHash, now],
          );
          const predecessor = predecessorResult.rows[0];
          if (!predecessor || predecessor.participant_id !== principal.participantId
              || predecessor.device_id !== principal.deviceId
              || predecessor.previous_generation_id !== manifest.predecessor.previousGenerationId
              || predecessor.legacy_fingerprint !== manifest.predecessor.legacyFingerprint
              || manifest.fromDay > predecessor.from_day || manifest.throughDay < predecessor.through_day) {
            throw manifestConflict();
          }
          // D1: a new predecessor token does not make an unchanged day vector
          // new data. Acknowledge only the exact revision after the original.
          const unchanged = await client.query<ActiveDomainRow>(
            `SELECT domain.id, domain.manifest_digest,
                    to_char(domain.from_day, 'YYYY-MM-DD') AS from_day,
                    to_char(domain.through_day, 'YYYY-MM-DD') AS through_day
               FROM ${t(s, "telemetry_v11_domain_heads")} head
               JOIN ${t(s, "telemetry_v11_domains")} domain ON domain.id = head.generation_id
              WHERE head.participant_id = $1 AND domain.device_id = $2
                AND head.generation_id = $3 AND $4::bigint = domain.input_revision + 1
                AND domain.from_day = $5::date AND domain.through_day = $6::date
                AND domain.days_json = $7`,
            [principal.participantId, principal.deviceId, predecessor.previous_generation_id,
              count(predecessor.input_revision), manifest.fromDay, manifest.throughDay, daysJson],
          );
          if (unchanged.rows[0]) {
            return Object.freeze({
              ...activationResult(unchanged.rows[0], true), unchanged: true as const,
              requestedManifestDigest: manifest.manifestDigest,
            });
          }
          await assertDomainClosure(client, s, principal, manifest, predecessor);
          const generationId = crypto.randomUUID();
          await client.query(
            `INSERT INTO ${t(s, "telemetry_v11_domains")} (
               id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
               manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12::timestamptz)`,
            [generationId, principal.participantId, principal.deviceId, tokenHash,
              manifest.predecessor.previousGenerationId, manifest.manifestDigest,
              manifest.predecessor.legacyFingerprint, count(predecessor.input_revision),
              manifest.fromDay, manifest.throughDay, daysJson, now],
          );
          await client.query(
            `INSERT INTO ${t(s, "telemetry_v11_domain_days")} (generation_id, observed_day, manifest_id)
             SELECT $1, entry.day::date, entry."manifestId"
               FROM jsonb_to_recordset($2::jsonb) AS entry(day text, "manifestId" text)`,
            [generationId, daysJson],
          );
          // D1 telemetry_v11_head_insert_guard / head_update_guard: revision 1
          // for a first head; otherwise exactly one more, from the generation
          // this domain names as its predecessor.
          const head = await client.query<{ generation_id: string }>(
            `INSERT INTO ${t(s, "telemetry_v11_domain_heads")} (participant_id, generation_id, revision, updated_at)
             SELECT $1, $2, 1, $3::timestamptz WHERE $4::text IS NULL
             ON CONFLICT (participant_id) DO NOTHING
             RETURNING generation_id`,
            [principal.participantId, generationId, now, manifest.predecessor.previousGenerationId],
          );
          if (head.rows.length === 0) {
            const moved = await client.query<{ generation_id: string }>(
              `UPDATE ${t(s, "telemetry_v11_domain_heads")}
                  SET generation_id = $2, revision = revision + 1, updated_at = $3::timestamptz
                WHERE participant_id = $1 AND generation_id = $4
                RETURNING generation_id`,
              [principal.participantId, generationId, now, manifest.predecessor.previousGenerationId],
            );
            if (moved.rows[0]?.generation_id !== generationId) throw manifestConflict();
          } else if (head.rows[0]?.generation_id !== generationId) {
            throw manifestConflict();
          }
          // D1 telemetry_v11_head_*_publish: consume the predecessor and
          // advance the owner's analytical input revision.
          const consumed = await client.query(
            `UPDATE ${t(s, "telemetry_v11_domain_predecessors")} SET consumed_at = $2::timestamptz
              WHERE token_hash = $1 AND consumed_at IS NULL`,
            [tokenHash, now],
          );
          if (consumed.rowCount !== 1) throw manifestConflict();
          await client.query(
            `UPDATE ${t(s, "community_analytical_input_versions")} SET revision = revision + 1
              WHERE participant_id = $1`,
            [principal.participantId],
          );
          return activationResult({
            id: generationId, manifest_digest: manifest.manifestDigest,
            from_day: manifest.fromDay, through_day: manifest.throughDay,
          }, false);
        }, {
          operation: "telemetry.v11.domain.activate",
          statementTimeoutMilliseconds: 60_000,
          preserveSafeError: (error) => (error instanceof ApiError || error instanceof DomainRefusal
            ? domainError(error) : null),
        });
      } catch (error) {
        if (transportRefusal !== null) throw domainError(error);
        // An uncertain response or concurrent identical retry is safe.
        const replay = await withPostgresRead(pool,
          (client) => activeDomainByDigest(client, s, principal, manifest.manifestDigest),
          { operation: "telemetry.v11.domain.replay" }).catch(() => null);
        if (replay) return activationResult(replay, true);
        throw domainError(error);
      }
    },
  });
}

/**
 * ingestion-isolation 0007's usage-correction tolerance, as one SQL
 * predicate over a retained (before) and a successor (after) typed record
 * id: while the correction runtime is active, two usage rows whose every
 * shared typed field (namespace, owner, occurrence, clock, day, provider,
 * session, every dimension and every split) is identical are the same
 * occurrence when each exact total (total input context, output combined)
 * is unchanged or NULL on either side. Attribution is not compared, as in
 * D1. No other stream and no raw JSON proof gets a tolerance.
 */
function correctedUsageEquivalent(s: string, beforeId: string, afterId: string): string {
  const shared = (row: string, usage: string) => `ROW(${row}.namespace_id, ${row}.owner_id, ${row}.occurrence_id,
      ${row}.observed_at_ms, ${row}.observed_day, ${row}.provider_id, ${usage}.session_id, ${usage}.model_id,
      ${usage}.speed_mode_id, ${usage}.api_service_tier_id, ${usage}.surface_id, ${usage}.billing_surface_id,
      ${usage}.reasoning_effort_id, ${usage}.agent_scope_id, ${usage}.outcome_id, ${usage}.input_uncached_tokens,
      ${usage}.input_cache_read_tokens, ${usage}.input_cache_write_tokens, ${usage}.output_text_tokens,
      ${usage}.output_reasoning_tokens)`;
  return `EXISTS (
    SELECT 1 FROM ${t(s, "typed_telemetry_records")} before_row
      JOIN ${t(s, "typed_telemetry_usage")} before_usage ON before_usage.record_id = before_row.id
      JOIN ${t(s, "typed_telemetry_records")} after_row ON after_row.id = ${afterId}
      JOIN ${t(s, "typed_telemetry_usage")} after_usage ON after_usage.record_id = after_row.id
     WHERE before_row.id = ${beforeId}
       AND EXISTS (SELECT 1 FROM ${t(s, "telemetry_usage_correction_runtime")} runtime
                    WHERE runtime.id = 1 AND runtime.source_state = 'active')
       AND before_row.stream = 1 AND after_row.stream = 1
       AND ${shared("after_row", "after_usage")} IS NOT DISTINCT FROM ${shared("before_row", "before_usage")}
       AND (before_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens IS NULL
         OR after_usage.total_input_context_tokens = before_usage.total_input_context_tokens)
       AND (before_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens IS NULL
         OR after_usage.output_combined_tokens = before_usage.output_combined_tokens))`;
}

/**
 * ingestion-isolation 0007 typed_v1_v11_transition_unqualified: once any
 * typed v1 admission state exists, the owner's typed v1 history must carry
 * into the candidate. Both runtimes must be qualified over one namespace;
 * no current winner chunk of the predecessor may be partially admitted (the
 * header count is authoritative and its event source must exist); and every
 * typed v1 winner occurrence must reappear in the candidate day with its
 * legacy occurrence and a legacy digest equal to the typed canonical digest
 * (or, under an active correction runtime, as an exact-total correction).
 * The decoded owner, device, chunk and occurrence ids are D1's
 * typed_telemetry_compatibility_records columns; comparisons keep D1's
 * NULL-propagating != so an undecodable id behaves as it does there.
 */
async function assertTypedV1Transition(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryV11Principal,
  predecessor: PredecessorRow,
  candidateDays: string,
): Promise<void> {
  const present = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${t(s, "typed_v1_admission_state")}) AS present`,
  );
  if (present.rows[0]?.present !== true) return;
  const qualified = await client.query(
    `SELECT 1 FROM ${t(s, "typed_v1_admission_state")} a
       JOIN ${t(s, "typed_v11_admission_state")} b
         ON b.namespace_id = a.namespace_id AND b.source_namespace = a.source_namespace
      WHERE a.id = 1 AND b.id = 1 AND a.runtime_contract_version = 1 AND b.runtime_contract_version = 1`,
  );
  if (qualified.rows.length !== 1) throw new DomainRefusal("compatibility_unproven");
  const winners = `winners AS MATERIALIZED (
       SELECT winner->>0 AS participant_id, (winner->>1)::date AS chunk_day, winner->>2 AS device_id
         FROM jsonb_array_elements($2::jsonb) winner)`;
  const partial = await client.query(
    `WITH ${winners}
     SELECT 1 FROM ${t(s, "telemetry_v1_chunks")} c
      WHERE c.participant_id = $1 AND c.superseded_at IS NULL
        AND (c.participant_id, c.chunk_day, c.device_id) IN (SELECT participant_id, chunk_day, device_id FROM winners)
        AND (c.record_count <> c.accepted_record_count
          OR c.record_count <> (SELECT count(*) FROM ${t(s, "typed_v1_record_admissions")} p WHERE p.chunk_id = c.id)
          OR NOT EXISTS (SELECT 1 FROM ${t(s, "typed_v1_event_sources")} e
                          WHERE e.chunk_id = c.id AND e.participant_id = c.participant_id
                            AND e.source_namespace = (SELECT source_namespace FROM ${t(s, "typed_v1_admission_state")})))
      LIMIT 1`,
    [principal.participantId, predecessor.winners_json],
  );
  if (partial.rows.length) throw new DomainRefusal("compatibility_unproven");
  const uncovered = await client.query(
    `WITH ${winners},
     candidate_days AS MATERIALIZED (
       SELECT entry.day::date AS day, entry.manifest_id
         FROM jsonb_to_recordset($3::jsonb) AS entry(day text, manifest_id text))
     SELECT 1 FROM ${t(s, "telemetry_v1_chunks")} c
       JOIN ${t(s, "typed_v1_record_admissions")} p ON p.chunk_id = c.id
       JOIN ${t(s, "typed_telemetry_records")} r ON r.id = p.typed_record_id
       JOIN ${t(s, "typed_telemetry_owners")} old_owner ON old_owner.id = r.owner_id
       JOIN ${t(s, "typed_telemetry_devices")} old_device ON old_device.id = r.device_id
       JOIN ${t(s, "typed_telemetry_chunks")} old_chunk ON old_chunk.id = r.chunk_id
       LEFT JOIN candidate_days candidate ON candidate.day = c.chunk_day
      WHERE c.participant_id = $1 AND c.superseded_at IS NULL
        AND (c.participant_id, c.chunk_day, c.device_id) IN (SELECT participant_id, chunk_day, device_id FROM winners)
        AND (candidate.manifest_id IS NULL OR r.format <> 10
          OR r.namespace_id <> (SELECT namespace_id FROM ${t(s, "typed_v1_admission_state")})
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_owner.original_id) <> c.participant_id
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_device.original_id) <> c.device_id
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_chunk.original_id) <> c.id
          OR r.observed_day <> (c.chunk_day - DATE '1970-01-01')
          OR NOT EXISTS (
            SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} successor
             WHERE successor.manifest_id = candidate.manifest_id AND successor.stream = c.stream
               AND successor.legacy_occurrence_id = ${t(s, "typed_legacy_admission_decode_id")}(r.occurrence_id)
               AND (successor.legacy_digest = r.canonical_digest
                 OR ${correctedUsageEquivalent(s, "r.id", "successor.typed_record_id")})))
      LIMIT 1`,
    [principal.participantId, predecessor.winners_json, candidateDays],
  );
  if (uncovered.rows.length) throw new DomainRefusal("compatibility_unproven");
}

/**
 * The closure D1 runs before a generation row exists, as production's final
 * triggers order it: SQLite fires the most recently created BEFORE trigger
 * first, so ingestion-isolation 0007's typed_v1_v11_transition_unqualified
 * runs before its telemetry_v11_domain_complete_before_insert, whose checks
 * follow in their own order.
 */
async function assertDomainClosure(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryV11Principal,
  manifest: ReturnType<typeof parseTelemetryV11DomainManifest>,
  predecessor: PredecessorRow,
): Promise<void> {
  const days = manifest.days;
  const candidateDays = JSON.stringify(days.map((entry) => ({ day: entry.day, manifest_id: entry.manifestId })));
  await assertTypedV1Transition(client, s, principal, predecessor, candidateDays);
  const compatibility = await client.query<{ typed: boolean; raw: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${t(s, "typed_v11_admission_state")} WHERE id = 1) AS typed,
            EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_records")}) AS raw`,
  );
  if (compatibility.rows[0]?.typed !== true || compatibility.rows[0]?.raw !== false) {
    throw new DomainRefusal("compatibility_unproven");
  }
  if (predecessor.from_day < manifest.fromDay || predecessor.through_day > manifest.throughDay) {
    throw new DomainRefusal("predecessor_changed");
  }
  const ids = days.map((day) => day.manifestId);
  const budget = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(expected_chunk_count), 0)::text AS total
       FROM ${t(s, "telemetry_v11_day_manifests")} WHERE id = ANY($1::text[])`,
    [ids],
  );
  if (count(budget.rows[0]?.total) > MAX_DOMAIN_CHUNKS) throw new DomainRefusal("range_too_large");
  const span = (Date.parse(manifest.throughDay) - Date.parse(manifest.fromDay)) / DAY_MS + 1;
  if (days.length < 1 || days.length > 4_096 || days.length !== span
      || days.some((entry, index) => entry.day !== new Date(Date.parse(manifest.fromDay) + index * DAY_MS)
        .toISOString().slice(0, 10))) {
    throw new DomainRefusal("incomplete");
  }
  const ready = await client.query<{ id: string; chunk_day: string; manifest_digest: string }>(
    `SELECT manifest.id, to_char(manifest.chunk_day, 'YYYY-MM-DD') AS chunk_day, manifest.manifest_digest
       FROM ${t(s, "telemetry_v11_day_manifests")} manifest
      WHERE manifest.id = ANY($1::text[]) AND manifest.participant_id = $2 AND manifest.device_id = $3
        AND manifest.state = 'ready'
        AND manifest.expected_chunk_count = (
          SELECT count(*) FROM ${t(s, "telemetry_v11_chunks")} chunk WHERE chunk.manifest_id = manifest.id)
        AND NOT EXISTS (
          SELECT 1 FROM ${t(s, "telemetry_v11_chunks")} chunk
           WHERE chunk.manifest_id = manifest.id AND chunk.record_count <> (
             SELECT count(*) FROM ${t(s, "typed_v11_record_admissions")} admission
              WHERE admission.chunk_id = chunk.id))
      FOR SHARE OF manifest`,
    [ids, principal.participantId, principal.deviceId],
  );
  const byId = new Map(ready.rows.map((row) => [row.id, row]));
  if (byId.size !== days.length || days.some((entry) => {
    const row = byId.get(entry.manifestId);
    return !row || row.chunk_day !== entry.day || row.manifest_digest !== entry.manifestDigest;
  })) {
    throw new DomainRefusal("incomplete");
  }
  const duplicate = await client.query(
    `SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} admission
      WHERE admission.manifest_id = ANY($1::text[])
      GROUP BY admission.stream, admission.occurrence_id HAVING count(*) > 1 LIMIT 1`,
    [ids],
  );
  if (duplicate.rows.length) throw new DomainRefusal("occurrence_conflict");
  // Every legacy winning occurrence must survive with identical base semantics.
  const legacyGap = await client.query(
    `WITH candidate_days AS MATERIALIZED (
       SELECT entry.day::date AS day, entry.manifest_id
         FROM jsonb_to_recordset($3::jsonb) AS entry(day text, manifest_id text)),
     winners AS MATERIALIZED (
       SELECT winner->>0 AS participant_id, (winner->>1)::date AS observed_day, winner->>2 AS device_id
         FROM jsonb_array_elements($2::jsonb) winner)
     SELECT 1 FROM ${t(s, "telemetry_v1_records")} old_row
       LEFT JOIN ${t(s, "typed_v1_preservation_proofs")} old_proof ON old_proof.source_row_id = old_row.id
       LEFT JOIN candidate_days candidate ON candidate.day = old_row.observed_day
      WHERE old_row.participant_id = $1
        AND (old_row.participant_id, old_row.observed_day, old_row.device_id) IN (
          SELECT participant_id, observed_day, device_id FROM winners)
        AND (old_proof.source_row_id IS NULL OR candidate.manifest_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} new_row
           WHERE new_row.manifest_id = candidate.manifest_id AND new_row.stream = old_row.stream
             AND new_row.legacy_occurrence_id = old_row.occurrence_id
             AND new_row.legacy_digest = old_proof.canonical_digest))
      LIMIT 1`,
    [principal.participantId, predecessor.winners_json, candidateDays],
  );
  if (legacyGap.rows.length) throw new DomainRefusal("compatibility_unproven");
  // Every admitted row of the previous generation must survive: the same
  // base digest, or (active correction runtime) an exact-total correction.
  if (manifest.predecessor.previousGenerationId !== null) {
    const previousGap = await client.query(
      `WITH candidate_days AS MATERIALIZED (
         SELECT entry.day::date AS day, entry.manifest_id
           FROM jsonb_to_recordset($2::jsonb) AS entry(day text, manifest_id text))
       SELECT 1 FROM ${t(s, "telemetry_v11_domain_days")} previous_day
         JOIN ${t(s, "typed_v11_record_admissions")} old_row ON old_row.manifest_id = previous_day.manifest_id
         LEFT JOIN candidate_days candidate ON candidate.day = previous_day.observed_day
        WHERE previous_day.generation_id = $1 AND (candidate.manifest_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} new_row
           WHERE new_row.manifest_id = candidate.manifest_id AND new_row.stream = old_row.stream
             AND new_row.occurrence_id = old_row.occurrence_id
             AND (new_row.base_digest = old_row.base_digest
               OR ${correctedUsageEquivalent(s, "old_row.typed_record_id", "new_row.typed_record_id")})))
        LIMIT 1`,
      [manifest.predecessor.previousGenerationId, candidateDays],
    );
    if (previousGap.rows.length) throw new DomainRefusal("compatibility_unproven");
  }
  const legacyV02 = await client.query(
    `SELECT 1 FROM ${t(s, "telemetry_contributions")} legacy
      WHERE legacy.participant_id = $1 AND legacy.status = 'accepted'
        AND legacy.transport_schema_version = 'telemetry-contribution-v0.2' LIMIT 1`,
    [principal.participantId],
  );
  if (legacyV02.rows.length) throw new DomainRefusal("compatibility_unproven");
}

/** The social participant consent a v1.1 contribution requires (Worker TELEMETRY_CONSENT_VERSION). */
export const POSTGRES_TELEMETRY_V11_SOCIAL_CONSENT_VERSION = TELEMETRY_CONSENT_VERSION;

// ---------------------------------------------------------- object journal --

/**
 * Register the envelope object in pending_objects before it is written, as
 * D1's putTrackedQuarantineObject does, so retention can always resolve an
 * object whose chunk never committed. The chunk insert's 0008 guard refuses a
 * chunk without this exact registered row. A lost COMMIT acknowledgement is
 * resolved by re-reading the exact registration.
 */
export async function registerPostgresTelemetryV11PendingObject(
  pool: PostgresPool,
  contributionId: string,
  objectKey: string,
  nowEpoch = Date.now(),
  options: PostgresTelemetryV11Options = {},
): Promise<void> {
  const { quoted: s } = schemaOf(options);
  const now = nowDate(nowEpoch);
  const exact = async (client: PostgresClient, lock: boolean): Promise<boolean> => {
    const row = (await client.query<{ object_key: string; object_kind: string; reconciliation_state: string }>(
      `SELECT object_key, object_kind, reconciliation_state FROM ${t(s, "pending_objects")}
        WHERE contribution_id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [contributionId],
    )).rows[0];
    return row?.object_key === objectKey && row.object_kind === "telemetry_v11"
      && row.reconciliation_state === "registered";
  };
  try {
    await withPostgresMutation(pool, async (client) => {
      await client.query(
        `INSERT INTO ${t(s, "pending_objects")} (
           contribution_id, object_key, object_kind, registered_at, reconciliation_state
         ) VALUES ($1, $2, 'telemetry_v11', $3, 'registered') ON CONFLICT (contribution_id) DO NOTHING`,
        [contributionId, objectKey, now],
      );
      if (!await exact(client, true)) throw unavailable();
    }, { operation: "telemetry.v11.pending.register" });
    return;
  } catch {
    try {
      if (await withPostgresRead(pool, (client) => exact(client, false), {
        operation: "telemetry.v11.pending.readback",
      })) return;
    } catch { /* The write stays unknown; never write the object without proof. */ }
    throw unavailable();
  }
}

/**
 * Retire this attempt's own object when no chunk references it: claim the
 * registration ('deleting' plus a lease), delete the object, then drop the
 * claim. An uncertain provider delete keeps the deleting row for the
 * reconciler. Returns false when a chunk references the object (keep it).
 */
export async function retirePostgresTelemetryV11PendingObject(
  pool: PostgresPool,
  objectStore: { delete(key: string): Promise<unknown> },
  attempt: { readonly chunkRowId: string; readonly objectKey: string; readonly authorizationId: string },
  options: PostgresTelemetryV11Options = {},
): Promise<boolean> {
  const { quoted: s } = schemaOf(options);
  const leaseId = crypto.randomUUID();
  const referenced = `EXISTS (SELECT 1 FROM ${t(s, "telemetry_v11_chunks")}
      WHERE id = $1 OR r2_key = $2 OR device_upload_authorization_id = $3)`;
  let claimed: boolean;
  try {
    claimed = await withPostgresMutation(pool, async (client) => {
      const reference = await client.query<{ referenced: boolean }>(
        `SELECT ${referenced} AS referenced`,
        [attempt.chunkRowId, attempt.objectKey, attempt.authorizationId],
      );
      if (reference.rows[0]?.referenced !== false) return false;
      const updated = await client.query(
        `UPDATE ${t(s, "pending_objects")} SET reconciliation_state = 'deleting', reconciliation_lease_id = $3
          WHERE contribution_id = $1 AND object_key = $2 AND object_kind = 'telemetry_v11'
            AND reconciliation_state = 'registered'`,
        [attempt.chunkRowId, attempt.objectKey, leaseId],
      );
      return updated.rowCount === 1;
    }, { operation: "telemetry.v11.pending.claim" });
  } catch {
    throw unavailable();
  }
  if (!claimed) return false;
  try { await objectStore.delete(attempt.objectKey); } catch { throw unavailable(); }
  try {
    return await withPostgresMutation(pool, async (client) => {
      const reference = await client.query<{ referenced: boolean }>(
        `SELECT ${referenced} AS referenced`,
        [attempt.chunkRowId, attempt.objectKey, attempt.authorizationId],
      );
      if (reference.rows[0]?.referenced !== false) return false;
      const removed = await client.query(
        `DELETE FROM ${t(s, "pending_objects")}
          WHERE contribution_id = $1 AND object_key = $2 AND object_kind = 'telemetry_v11'
            AND reconciliation_state = 'deleting' AND reconciliation_lease_id = $3`,
        [attempt.chunkRowId, attempt.objectKey, leaseId],
      );
      return removed.rowCount === 1;
    }, { operation: "telemetry.v11.pending.retire" });
  } catch {
    throw unavailable();
  }
}
