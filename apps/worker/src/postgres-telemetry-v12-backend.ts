import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
  parseTelemetryV12ChunkId,
  parseTelemetryV12DayManifest,
  parseTelemetryV12DomainManifest,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RecordAnchor,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { resolvePostgresTelemetryV12Tables, type PostgresTelemetryV12Tables } from "./postgres-telemetry-v12-schema";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import type {
  TelemetryV12DayCandidate,
  TelemetryV12DomainActivation,
  TelemetryV12DomainPredecessor,
  TelemetryV12ReadyDayReference,
  TelemetryV12StagedChunkRow,
  TelemetryV12TransportBackend,
} from "./telemetry-v12-backend";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_VECTOR = 4_096;
const MAX_CHUNKS_PER_DAY = 4_096;
const MAX_DAY_BYTES = 64_000_000;
const MAX_MANIFESTS_PER_DAY = 8_192;
const DOMAIN_TTL_MS = 24 * 60 * 60 * 1_000;

function unavailable(): ApiError { return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
function rowCount(result: { rowCount: number | null }): number {
  if (result.rowCount === null || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0) throw unavailable();
  return result.rowCount;
}
function one<T extends Record<string, unknown>>(result: { rows: readonly T[]; rowCount: number | null }): T {
  if (result.rowCount !== 1 || result.rows.length !== 1 || !result.rows[0]) throw unavailable();
  return result.rows[0]!;
}
function text(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw unavailable();
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw unavailable();
  return date.toISOString();
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === "number" ? value
    : typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value)
      : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw unavailable();
  if (typeof value === "string" && String(result) !== value) throw unavailable();
  return result;
}
function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  return value;
}
function nowIso(epoch = Date.now()): string {
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) throw new ApiError(400, "CHUNK_INVALID");
  return date.toISOString();
}
function snapshotPrincipal(value: TelemetryTransportPrincipal): TelemetryTransportPrincipal {
  return Object.freeze({ participantId: value.participantId, deviceId: value.deviceId });
}
function snapshotManifest(value: unknown): { manifest: TelemetryV12DayManifest; canonical: string } {
  try {
    const manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DayManifest(value))) as TelemetryV12DayManifest;
    return { manifest, canonical: canonicalTelemetryV12Json(manifest) };
  } catch { throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID"); }
}
function snapshotMetadata(value: {
  chunkRowId: string; objectKey: string; envelopeDigest: string;
  deviceUploadAuthorizationId: string; uploadAuthorizationLeaseExpiresAt: string;
}) {
  const metadata = Object.freeze({ ...value });
  if (!metadata.chunkRowId || !metadata.objectKey || !DIGEST.test(metadata.envelopeDigest)
      || !metadata.deviceUploadAuthorizationId || !Number.isFinite(Date.parse(metadata.uploadAuthorizationLeaseExpiresAt))
      || new Date(metadata.uploadAuthorizationLeaseExpiresAt).toISOString() !== metadata.uploadAuthorizationLeaseExpiresAt) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  return metadata;
}
function mapSqlError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = error && typeof error === "object" && typeof Reflect.get(error, "code") === "string"
    ? Reflect.get(error, "code") : null;
  if (code === "23505") return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (code === "P1001") return new ApiError(409, "PARTICIPANT_DELETING");
  if (code === "P1002") return new ApiError(401, "UPLOAD_AUTH_INVALID");
  if (code === "P1003") return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
  if (code === "P1005") return new ApiError(409, "CHUNK_REVISION_CONFLICT");
  if (code === "P1006") return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  if (code === "P1007") return new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
  return unavailable();
}
function preserveSafeError(error: unknown): Error | null { return error instanceof ApiError ? error : mapSqlError(error); }
function canonicalChunk(value: unknown): Promise<TelemetryV12Chunk> {
  let chunk: TelemetryV12Chunk;
  try { chunk = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12Chunk(value))) as TelemetryV12Chunk; }
  catch { return Promise.reject(new ApiError(400, "CHUNK_INVALID")); }
  return sha256Hex(canonicalTelemetryV12Json(chunk.records)).then((digest) => {
    if (digest !== chunk.chunkDigest) throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
    return chunk;
  });
}

interface AuthorityState { readonly issuedAt: string; }

async function databaseClock(client: PostgresClient): Promise<string> {
  return instant(one(await client.query("SELECT clock_timestamp() AS now")).now);
}

async function assertV12Authority(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  principal: TelemetryTransportPrincipal,
): Promise<AuthorityState> {
  const participant = await client.query(
    `SELECT owner_kind, state FROM ${tables.participants} WHERE id=$1 FOR UPDATE`, [principal.participantId],
  );
  if (participant.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const p = one(participant);
  if (p.state !== "active") throw new ApiError(409, "PARTICIPANT_DELETING");
  const device = await client.query(
    `SELECT authority_kind, state, issued_at, expires_at, accountless_enrollment_device_id
       FROM ${tables.devices} WHERE id=$1 AND participant_id=$2 FOR UPDATE`,
    [principal.deviceId, principal.participantId],
  );
  if (device.rowCount !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const d = one(device);
  if (d.state !== "active" || d.authority_kind !== p.owner_kind) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const floor = await client.query(`SELECT minimum_rank FROM ${tables.participantFloors} WHERE participant_id=$1 FOR SHARE`, [principal.participantId]);
  const deviceFloor = await client.query(`SELECT minimum_rank FROM ${tables.deviceFloors}
    WHERE participant_id=$1 AND device_id=$2 FOR SHARE`, [principal.participantId, principal.deviceId]);
  const minimum = Math.max(integer(one(floor).minimum_rank), deviceFloor.rowCount === 0 ? 0 : integer(one(deviceFloor).minimum_rank));
  const format = await client.query(`SELECT format_rank, lifecycle FROM ${tables.formats}
    WHERE schema_version=$1 FOR SHARE`, [TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION]);
  if (format.rowCount !== 1 || one(format).lifecycle !== "accepted"
      || integer(one(format).format_rank) < minimum) throw new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
  const runtime = await client.query(`SELECT state FROM ${tables.runtime} WHERE id=1 FOR SHARE`);
  if (runtime.rowCount !== 1 || one(runtime).state !== "active") throw new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
  if (p.owner_kind === "social") {
    const consent = await client.query(`SELECT 1 FROM ${tables.capabilities}
      WHERE participant_id=$1 AND device_id=$2
        AND telemetry_schema_version=$3 AND field_dictionary_version=$4
        AND privacy_contract_version=$5 AND state='accepted' FOR SHARE`,
    [principal.participantId, principal.deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION]);
    if (consent.rowCount !== 1) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  } else {
    const accountless = await client.query(`SELECT 1
      FROM ${tables.accountlessLedger} ledger
      JOIN ${tables.accountlessOwners} owner ON owner.enrollment_device_id=ledger.device_id
       AND owner.participant_id=$2 AND owner.device_credential_id=$3 AND owner.state='active'
       AND owner.expires_at=ledger.expires_at
      JOIN ${tables.accountlessAuthorizations} grant_row ON grant_row.enrollment_device_id=ledger.device_id
       AND grant_row.participant_id=$2 AND grant_row.device_credential_id=$3 AND grant_row.state='active'
       AND grant_row.telemetry_schema_version=$4 AND grant_row.field_dictionary_version=$5
       AND grant_row.privacy_contract_version=$6 AND grant_row.expires_at=ledger.expires_at
      WHERE ledger.device_id=$1 AND ledger.state='active' AND ledger.expires_at=$7::timestamptz
        AND ledger.expires_at > clock_timestamp()
        FOR SHARE OF ledger, owner, grant_row`,
    [d.accountless_enrollment_device_id, principal.participantId, principal.deviceId,
      TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
      TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, instant(d.expires_at)]);
    if (accountless.rowCount !== 1 || d.accountless_enrollment_device_id === null) {
      throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
    }
  }
  const legacy = await client.query(`SELECT 1 FROM ${tables.retainedContributions}
    WHERE participant_id=$1 AND status='accepted' AND transport_schema_version='telemetry-contribution-v0.2' LIMIT 1`, [principal.participantId]);
  if (legacy.rowCount !== 0) throw new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
  const dbNow = await databaseClock(client);
  if (new Date(instant(d.expires_at)).getTime() <= new Date(dbNow).getTime()) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  return Object.freeze({ issuedAt: instant(d.issued_at) });
}

function admissionLimit(): ApiError {
  return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", {
    responseHeaders: { "retry-after": "60" },
  });
}

async function assertManifestAdmission(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  principal: TelemetryTransportPrincipal,
  createdAt: string,
): Promise<void> {
  const start = `${createdAt.slice(0, 10)}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const result = await client.query(`SELECT count(*)::text AS count
    FROM ${tables.manifests} WHERE participant_id=$1 AND device_id=$2
      AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
  [principal.participantId, principal.deviceId, start, end]);
  if (result.rowCount !== 1) throw unavailable();
  if (integer(one(result).count) >= MAX_MANIFESTS_PER_DAY) throw admissionLimit();
}

interface ChunkAdmissionWindow { readonly windowDay: string; readonly maximum: number }

async function assertChunkAdmission(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  principal: TelemetryTransportPrincipal,
  createdAt: string,
  deviceIssuedAt: string,
): Promise<ChunkAdmissionWindow> {
  const windowDay = createdAt.slice(0, 10);
  const result = await client.query(`SELECT accepted_count FROM ${tables.admissionWindows}
    WHERE participant_id=$1 AND device_id=$2 AND window_day=$3::date FOR UPDATE`,
  [principal.participantId, principal.deviceId, windowDay]);
  const accepted = result.rowCount === 0 ? 0 : integer(one(result).accepted_count, 0, 20_000);
  const createdEpoch = Date.parse(createdAt); const issuedEpoch = Date.parse(deviceIssuedAt);
  if (!Number.isFinite(createdEpoch) || !Number.isFinite(issuedEpoch)) throw unavailable();
  const maximum = issuedEpoch > createdEpoch - 7 * 86_400_000 ? 20_000 : 2_000;
  if (accepted >= maximum) throw admissionLimit();
  return Object.freeze({ windowDay, maximum });
}

async function recordChunkAdmission(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  principal: TelemetryTransportPrincipal,
  window: ChunkAdmissionWindow,
  createdAt: string,
): Promise<void> {
  const result = await client.query(`INSERT INTO ${tables.admissionWindows} AS admission
    (participant_id, device_id, window_day, accepted_count, last_accepted_at)
    VALUES ($1,$2,$3::date,1,$4)
    ON CONFLICT (participant_id, device_id, window_day)
    DO UPDATE SET accepted_count=admission.accepted_count + 1,
      last_accepted_at=EXCLUDED.last_accepted_at RETURNING accepted_count`,
  [principal.participantId, principal.deviceId, window.windowDay, createdAt]);
  if (result.rowCount !== 1 || integer(one(result).accepted_count, 1, 20_000) > window.maximum) {
    throw admissionLimit();
  }
}

interface SourceCoverageRow {
  readonly source: string;
  readonly id: string;
  readonly deviceId: string | null;
  readonly digest: string;
  readonly state: string;
}

/**
 * Snapshot every accepted source family that can affect a participant-wide
 * domain. The v1.2 day vector remains identity-aware and device-scoped, while
 * this fence prevents a concurrent legacy or alternate-device source from
 * being silently omitted at activation.
 */
async function sourceCoverage(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  participantId: string,
): Promise<readonly SourceCoverageRow[]> {
  const result = await client.query(`
    SELECT source,id,device_id,digest,state FROM (
      SELECT 'v1'::text AS source, id, device_id, chunk_digest AS digest,
             coalesce(superseded_at::text,'') AS state
        FROM ${tables.v1Chunks} WHERE participant_id=$1
      UNION ALL
      SELECT 'v11-manifest'::text, id, device_id, manifest_digest, state
        FROM ${tables.v11Manifests} WHERE participant_id=$1
      UNION ALL
      SELECT 'v11-chunk'::text, id, device_id, chunk_digest, coalesce(quarantine_deleted_at::text,'')
        FROM ${tables.v11Chunks} WHERE participant_id=$1
      UNION ALL
      SELECT 'v12-manifest'::text, id, device_id, manifest_digest, state
        FROM ${tables.manifests} WHERE participant_id=$1
      UNION ALL
      SELECT 'v12-chunk'::text, id, device_id, chunk_digest, coalesce(quarantine_deleted_at::text,'')
        FROM ${tables.chunks} WHERE participant_id=$1
      UNION ALL
      SELECT 'retained'::text, id, NULL::text, plaintext_digest, status
        FROM ${tables.retainedContributions} WHERE participant_id=$1
    ) source_rows ORDER BY source,id`, [participantId]);
  return result.rows.map((row) => Object.freeze({
    source: text(row.source), id: text(row.id), deviceId: row.device_id === null ? null : text(row.device_id),
    digest: text(row.digest), state: typeof row.state === "string" ? row.state : String(row.state ?? ""),
  }));
}

async function sourceFingerprint(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  participantId: string,
  inputRevision: number,
  previousGenerationId: string | null,
  previousManifestDigest: string | null,
  manifests: readonly Record<string, unknown>[],
): Promise<string> {
  const coverage = await sourceCoverage(client, tables, participantId);
  return sha256Hex(JSON.stringify({ method: "v12-complete-domain-1", participantId,
    inputRevision, previousGenerationId, previousManifestDigest, manifests, coverage }));
}

async function assertLease(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  principal: TelemetryTransportPrincipal,
  metadata: ReturnType<typeof snapshotMetadata>,
): Promise<void> {
  const result = await client.query(`SELECT state, envelope_digest, consume_lease_expires_at, expires_at
    FROM ${tables.uploadAuthorizations} WHERE id=$1 AND participant_id=$2 AND issued_by_device_id=$3 FOR UPDATE`,
  [metadata.deviceUploadAuthorizationId, principal.participantId, principal.deviceId]);
  if (result.rowCount !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const row = one(result); const dbNow = await databaseClock(client);
  const lease = row.consume_lease_expires_at === null ? null : instant(row.consume_lease_expires_at);
  if (row.state !== "consuming" || row.envelope_digest !== metadata.envelopeDigest
      || lease !== metadata.uploadAuthorizationLeaseExpiresAt
      || new Date(lease ?? 0).getTime() <= new Date(dbNow).getTime()
      || new Date(instant(row.expires_at)).getTime() <= new Date(dbNow).getTime()) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
}

async function lockPending(
  client: PostgresClient,
  tables: PostgresTelemetryV12Tables,
  metadata: ReturnType<typeof snapshotMetadata>,
): Promise<boolean> {
  const inserted = await client.query(`INSERT INTO ${tables.pendingObjects}(contribution_id, object_key, object_kind)
    VALUES ($1,$2,'telemetry_v12') ON CONFLICT(contribution_id) DO NOTHING
    RETURNING contribution_id, object_key, object_kind, reconciliation_state`,
  [metadata.chunkRowId, metadata.objectKey]);
  const row = inserted.rowCount === 1 ? one(inserted) : one(await client.query(
    `SELECT contribution_id, object_key, object_kind, reconciliation_state
      FROM ${tables.pendingObjects} WHERE contribution_id=$1 FOR UPDATE`, [metadata.chunkRowId],
  ));
  if (row.object_key !== metadata.objectKey || row.object_kind !== "telemetry_v12" || row.reconciliation_state !== "registered") {
    throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
  }
  return inserted.rowCount === 1;
}

function candidate(row: Record<string, unknown>): TelemetryV12DayCandidate {
  return { manifestId: text(row.id), day: validDay(row.chunk_day), manifestDigest: text(row.manifest_digest),
    state: row.state as "staged" | "ready", expectedChunks: integer(row.expected_chunk_count, 0, MAX_CHUNKS_PER_DAY) };
}
function chunkRow(row: Record<string, unknown>): TelemetryV12StagedChunkRow {
  return { id: text(row.id), manifestId: text(row.manifest_id), participantId: text(row.participant_id),
    deviceId: text(row.device_id), chunkId: text(row.chunk_id), chunkDigest: text(row.chunk_digest),
    recordCount: integer(row.record_count, 1, 200), objectKey: text(row.r2_key), createdAt: instant(row.created_at) };
}
function exactChunk(row: TelemetryV12StagedChunkRow, chunk: TelemetryV12Chunk): boolean {
  return row.chunkId === chunk.chunkId && row.chunkDigest === chunk.chunkDigest && row.recordCount === chunk.records.length;
}
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

export function createPostgresTelemetryV12Backend(
  pool: PostgresPool, schemaOptions: PostgresSchemaOptions = {},
): TelemetryV12TransportBackend {
  const tables = resolvePostgresTelemetryV12Tables(schemaOptions);
  async function existing(principal: TelemetryTransportPrincipal, chunk: TelemetryV12Chunk): Promise<TelemetryV12StagedChunkRow | null> {
    const { day } = parseTelemetryV12ChunkId(chunk.chunkId);
    const result = await withPostgresRead(pool, (client) => client.query(
      `SELECT c.id,c.manifest_id,c.participant_id,c.device_id,c.chunk_id,c.chunk_digest,c.record_count,c.r2_key,c.created_at
       FROM ${tables.chunks} c JOIN ${tables.manifests} m ON m.id=c.manifest_id
       WHERE m.participant_id=$1 AND m.device_id=$2 AND m.chunk_day=$3::date
         AND m.manifest_digest=$4 AND c.chunk_id=$5 LIMIT 2`,
      [principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId],
    ), { operation: "telemetry.v12.chunk.read", preserveSafeError });
    if (result.rows.length > 1) throw unavailable();
    return result.rows.length === 0 ? null : chunkRow(result.rows[0]!);
  }

  return {
    validateChunk: canonicalChunk,
    async registerDayManifest(principal, value, nowEpoch) {
      const captured = snapshotPrincipal(principal); const { manifest, canonical } = snapshotManifest(value);
      if (await sha256Hex(telemetryV12DayManifestDigestInput(manifest)) !== manifest.manifestDigest) throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
      const now = nowIso(nowEpoch);
      return withPostgresMutation(pool, async (client) => {
        await assertV12Authority(client, tables, captured);
        const existingResult = await client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,
            manifest_digest,expected_chunk_count,state,manifest_json FROM ${tables.manifests}
          WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date AND manifest_digest=$4 FOR UPDATE`,
        [captured.participantId, captured.deviceId, manifest.day, manifest.manifestDigest]);
        if (existingResult.rows.length > 1) throw unavailable();
        if (existingResult.rows.length === 1) {
          const row = one(existingResult); if (row.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
          return candidate(row);
        }
        // The manifest day is source data; admission is measured against the
        // UTC server creation day, matching v1/v1.1 and avoiding session
        // timezone dependent date casts.
        await assertManifestAdmission(client, tables, captured, now);
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO ${tables.manifests} (
          id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,state,created_at,ready_at
        ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,'staged',$9,$10)
        ON CONFLICT(participant_id,device_id,chunk_day,manifest_digest) DO NOTHING`,
        [id, captured.participantId, captured.deviceId, manifest.day, manifest.manifestDigest, manifest.parserVersion,
          canonical, manifest.chunks.length, now, manifest.chunks.length === 0 ? now : null]);
        const stored = await client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,
          manifest_digest,expected_chunk_count,state,manifest_json FROM ${tables.manifests}
          WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date AND manifest_digest=$4 FOR UPDATE`,
        [captured.participantId, captured.deviceId, manifest.day, manifest.manifestDigest]);
        if (stored.rows.length !== 1) throw unavailable();
        const row = one(stored); if (row.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        return candidate(row);
      }, { operation: "telemetry.v12.manifest.register", preserveSafeError });
    },
    async existingChunk(principal, value) {
      const captured = snapshotPrincipal(principal); return existing(captured, await canonicalChunk(value));
    },
    async persistChunk(principal, value, metadata, nowEpoch) {
      const captured = snapshotPrincipal(principal); const meta = snapshotMetadata(metadata);
      const chunk = await canonicalChunk(value); const { stream, day, seq } = parseTelemetryV12ChunkId(chunk.chunkId);
      const now = nowIso(nowEpoch);
      try {
        return await withPostgresMutation(pool, async (client) => {
          const createdPending = await lockPending(client, tables, meta);
          await assertV12Authority(client, tables, captured);
          const manifestResult = await client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,
              manifest_digest,expected_chunk_count,state,manifest_json FROM ${tables.manifests}
            WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date AND manifest_digest=$4 FOR UPDATE`,
          [captured.participantId, captured.deviceId, day, chunk.manifestDigest]);
          if (manifestResult.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          const manifest = one(manifestResult); const manifestId = text(manifest.id);
          const expected = await client.query(`SELECT 1 FROM jsonb_array_elements(($1::text)::jsonb->'chunks') item
            WHERE item->>'chunkId'=$2 AND item->>'chunkDigest'=$3 AND (item->>'recordCount')::integer=$4`,
          [manifest.manifest_json, chunk.chunkId, chunk.chunkDigest, chunk.records.length]);
          if (expected.rowCount !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          const existingResult = await client.query(`SELECT id,manifest_id,participant_id,device_id,chunk_id,chunk_digest,record_count,r2_key,created_at
            FROM ${tables.chunks} WHERE manifest_id=$1 AND chunk_id=$2 FOR UPDATE`, [manifestId, chunk.chunkId]);
          if (existingResult.rows.length > 1) throw unavailable();
          if (existingResult.rows.length === 1) {
            const row = chunkRow(existingResult.rows[0]!); if (!exactChunk(row, chunk)) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
            if (createdPending) {
              const removed = await client.query(`DELETE FROM ${tables.pendingObjects}
                WHERE contribution_id=$1 AND object_key=$2 AND reconciliation_state='registered'`, [meta.chunkRowId, meta.objectKey]);
              if (rowCount(removed) !== 1) throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
            }
            return { contributionId: row.id, manifestId, chunkId: chunk.chunkId, replay: true };
          }
          if (manifest.state !== "staged") throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          // The manifest lock may wait behind another writer. Reacquire the
          // authority rows and clock after that wait so device expiry cannot
          // be accepted from an earlier snapshot.
          const authority = await assertV12Authority(client, tables, captured);
          await assertLease(client, tables, captured, meta);
          const admission = await assertChunkAdmission(
            client, tables, captured, now, authority.issuedAt,
          );
          let dayCount = 0; let dayBytes = 0;
          const dayUsage = await client.query(`SELECT count(*)::text AS chunks,
              coalesce(sum(c.record_count),0)::text AS records,
              coalesce((SELECT sum(octet_length(r.record_json)) FROM ${tables.records} r
                JOIN ${tables.chunks} prior ON prior.id=r.chunk_id
                WHERE prior.participant_id=$1 AND prior.device_id=$2 AND prior.chunk_day=$3::date),0)::text AS bytes
            FROM ${tables.chunks} c
            WHERE c.participant_id=$1 AND c.device_id=$2 AND c.chunk_day=$3::date`,
          [captured.participantId, captured.deviceId, day]);
          dayCount = integer(one(dayUsage).chunks); const existingRecords = integer(one(dayUsage).records);
          const existingBytes = integer(one(dayUsage).bytes);
          for (const record of chunk.records) dayBytes += bytes(canonicalTelemetryV12Json(record));
          if (dayCount >= MAX_CHUNKS_PER_DAY || existingRecords + chunk.records.length > MAX_CHUNKS_PER_DAY * 200
              || existingBytes + dayBytes > MAX_DAY_BYTES) throw new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED");
          const inserted = await client.query(`INSERT INTO ${tables.chunks} (
            id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,envelope_digest,
            parser_version,record_count,r2_key,device_upload_authorization_id,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [meta.chunkRowId, manifestId, captured.participantId, captured.deviceId, stream, day, seq, chunk.chunkId,
            chunk.chunkDigest, meta.envelopeDigest, chunk.parserVersion, chunk.records.length, meta.objectKey,
            meta.deviceUploadAuthorizationId, now]);
          if (rowCount(inserted) !== 1) throw unavailable();
          for (const record of chunk.records) {
            const anchor = telemetryV12RecordAnchor(stream, record);
            const insertedRecord = await client.query(`INSERT INTO ${tables.records}
              (chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json) VALUES ($1,$2,$3,$4,$5,$6)`,
            [meta.chunkRowId, manifestId, stream, anchor.occurrenceId, anchor.observedAt, canonicalTelemetryV12Json(record)]);
            if (rowCount(insertedRecord) !== 1) throw unavailable();
          }
          await recordChunkAdmission(client, tables, captured, admission, now);
          await client.query(`UPDATE ${tables.manifests} m SET state='ready',ready_at=$1
            WHERE m.id=$2 AND m.state='staged'
              AND m.expected_chunk_count=(SELECT count(*) FROM ${tables.chunks} c WHERE c.manifest_id=m.id)
              AND NOT EXISTS (SELECT 1 FROM ${tables.chunks} c WHERE c.manifest_id=m.id
                AND c.record_count <> (SELECT count(*) FROM ${tables.records} r WHERE r.chunk_id=c.id))`, [now, manifestId]);
          const finalNow = await databaseClock(client);
          const consumed = await client.query(`UPDATE ${tables.uploadAuthorizations}
            SET state='consumed',consumed_at=$2,consumed_contribution_id=$1,consume_lease_expires_at=NULL
            WHERE id=$3 AND participant_id=$4 AND issued_by_device_id=$5 AND state='consuming'
              AND envelope_digest=$6 AND consume_lease_expires_at=$7::timestamptz
              AND consumed_contribution_id IS NULL AND consume_lease_expires_at > $2::timestamptz AND expires_at > $2::timestamptz`,
          [meta.chunkRowId, finalNow, meta.deviceUploadAuthorizationId, captured.participantId, captured.deviceId,
            meta.envelopeDigest, meta.uploadAuthorizationLeaseExpiresAt]);
          if (rowCount(consumed) !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
          return { contributionId: meta.chunkRowId, manifestId, chunkId: chunk.chunkId, replay: false };
        }, { operation: "telemetry.v12.chunk.persist", preserveSafeError });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const replay = await existing(captured, chunk).catch(() => null);
        if (replay && exactChunk(replay, chunk)) return { contributionId: replay.id, manifestId: replay.manifestId, chunkId: chunk.chunkId, replay: true };
        throw mapSqlError(error);
      }
    },
    async readDayCandidates(principal, options) {
      const captured = snapshotPrincipal(principal); const fromDay = validDay(options.fromDay); const toDay = validDay(options.toDay);
      const limit = options.limit ?? 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || fromDay > toDay) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
      const result = await withPostgresRead(pool, (client) => client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,
          manifest_digest,expected_chunk_count,state FROM ${tables.manifests}
        WHERE participant_id=$1 AND device_id=$2 AND chunk_day BETWEEN $3::date AND $4::date
        ORDER BY chunk_day,created_at,id LIMIT $5`, [captured.participantId, captured.deviceId, fromDay, toDay, limit + 1]),
      { operation: "telemetry.v12.manifest.read", preserveSafeError });
      return { candidates: result.rows.slice(0, limit).map((row) => candidate(row)), bounded: result.rows.length > limit };
    },
    async readDayChunkVector(principal, manifestId) {
      const captured = snapshotPrincipal(principal); if (!UUID.test(manifestId)) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      const result = await withPostgresRead(pool, (client) => client.query(`SELECT c.chunk_id,c.chunk_digest,c.record_count
        FROM ${tables.chunks} c JOIN ${tables.manifests} m ON m.id=c.manifest_id
        WHERE m.id=$1 AND m.participant_id=$2 AND m.device_id=$3 ORDER BY c.stream,c.chunk_seq LIMIT $4`,
      [manifestId, captured.participantId, captured.deviceId, MAX_VECTOR + 1]), { operation: "telemetry.v12.vector", preserveSafeError });
      if (result.rows.length > MAX_VECTOR) throw unavailable();
      return result.rows.map((row) => ({ chunkId: text(row.chunk_id), chunkDigest: text(row.chunk_digest), recordCount: integer(row.record_count, 1, 200) }));
    },
    async loadReadyDayVector(principal, vector) {
      const captured = snapshotPrincipal(principal);
      if (!Array.isArray(vector) || vector.length > MAX_VECTOR) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      const snapshot = vector.map((item) => ({ day: validDay(item.day), manifestId: item.manifestId, manifestDigest: item.manifestDigest }));
      if (snapshot.some((item) => !UUID.test(item.manifestId) || !DIGEST.test(item.manifestDigest))
          || new Set(snapshot.map((item) => item.day)).size !== snapshot.length) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      const rows: TelemetryV12DayCandidate[] = [];
      for (const item of snapshot) {
        const result = await withPostgresRead(pool, (client) => client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,
            manifest_digest,expected_chunk_count,state FROM ${tables.manifests}
          WHERE id=$1 AND participant_id=$2 AND device_id=$3 AND chunk_day=$4::date
            AND manifest_digest=$5 AND state='ready'`, [item.manifestId, captured.participantId, captured.deviceId, item.day, item.manifestDigest]),
        { operation: "telemetry.v12.ready.vector", preserveSafeError });
        if (result.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        const row = candidate(result.rows[0]!);
        const count = await withPostgresRead(pool, (client) => client.query(`SELECT count(*)::text AS count FROM ${tables.chunks} WHERE manifest_id=$1`, [row.manifestId]), { operation: "telemetry.v12.ready.count", preserveSafeError });
        if (integer(one(count).count) !== row.expectedChunks) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        rows.push(row);
      }
      return rows;
    },
    async createDomainPredecessor(principal, nowEpoch) {
      const captured = snapshotPrincipal(principal); const now = nowIso(nowEpoch); const expires = nowIso((nowEpoch ?? Date.now()) + DOMAIN_TTL_MS);
      return withPostgresMutation(pool, async (client) => {
        await assertV12Authority(client, tables, captured);
        const stateResult = await client.query(`SELECT v.revision,h.generation_id,d.manifest_digest
          FROM ${tables.inputVersions} v LEFT JOIN ${tables.domainHeads} h ON h.participant_id=v.participant_id
          LEFT JOIN ${tables.domains} d ON d.id=h.generation_id WHERE v.participant_id=$1 FOR UPDATE OF v`, [captured.participantId]);
        if (stateResult.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        const state = one(stateResult);
        const manifests = await client.query(`SELECT id,to_char(chunk_day,'YYYY-MM-DD') AS chunk_day,manifest_digest
          FROM ${tables.manifests} WHERE participant_id=$1 AND device_id=$2 AND state='ready'
          ORDER BY chunk_day,created_at,id LIMIT $3`, [captured.participantId, captured.deviceId, MAX_VECTOR + 1]);
        if (manifests.rows.length === 0) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        if (manifests.rows.length > MAX_VECTOR) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
        const days = new Map<string, Record<string, unknown>>();
        for (const row of manifests.rows) if (!days.has(text(row.chunk_day))) days.set(text(row.chunk_day), row);
        const selected = [...days.values()].sort((a, b) => text(a.chunk_day).localeCompare(text(b.chunk_day)));
        const fromDay = text(selected[0]!.chunk_day); const throughDay = text(selected.at(-1)!.chunk_day);
        const previousGenerationId = nullableText(state.generation_id);
        const previousManifestDigest = nullableText(state.manifest_digest);
        const fingerprint = await sourceFingerprint(client, tables, captured.participantId,
          integer(state.revision), previousGenerationId, previousManifestDigest, selected);
        const token = crypto.randomUUID(); const tokenHash = await sha256Hex(token);
        const daysJson = canonicalTelemetryV12Json(selected.map((row) => ({ day: text(row.chunk_day), manifestId: text(row.id), manifestDigest: text(row.manifest_digest) })));
        await client.query(`DELETE FROM ${tables.predecessors} WHERE participant_id=$1 AND device_id=$2
          AND consumed_at IS NULL AND expires_at <= $3::timestamptz`, [captured.participantId, captured.deviceId, now]);
        await client.query(`INSERT INTO ${tables.predecessors} (token_hash,participant_id,device_id,previous_generation_id,
          legacy_fingerprint,input_revision,from_day,through_day,winners_json,created_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`, [tokenHash, captured.participantId, captured.deviceId,
          previousGenerationId, fingerprint, integer(state.revision), fromDay, throughDay, daysJson, now, expires]);
        return { schemaVersion: "telemetry-domain-predecessor-v1.2", token,
          previousGenerationId,
          legacyFingerprint: fingerprint, fromDay, throughDay, expiresAt: expires };
      }, { operation: "telemetry.v12.domain.predecessor", preserveSafeError });
    },
    async activateDomain(principal, value, nowEpoch) {
      const captured = snapshotPrincipal(principal); let manifest: any;
      try { manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DomainManifest(value))); }
      catch { throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID"); }
      if (await sha256Hex(telemetryV12DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
      const tokenHash = await sha256Hex(manifest.predecessor.token);
      return withPostgresMutation(pool, async (client) => {
        await assertV12Authority(client, tables, captured);
        // Lock the predecessor by identity first. Expiry and consumed state
        // are evaluated only after this wait, using the database clock, so a
        // lock held across the capability window cannot publish late.
        const predecessorResult = await client.query(`SELECT input_revision,to_char(from_day,'YYYY-MM-DD') AS from_day,
            to_char(through_day,'YYYY-MM-DD') AS through_day,
            previous_generation_id,legacy_fingerprint,winners_json,expires_at,consumed_at
          FROM ${tables.predecessors}
          WHERE token_hash=$1 AND participant_id=$2 AND device_id=$3 FOR UPDATE`,
        [tokenHash, captured.participantId, captured.deviceId]);
        if (predecessorResult.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        const predecessor = one(predecessorResult);
        const predecessorNow = await databaseClock(client);
        if (predecessor.consumed_at !== null
            || new Date(instant(predecessor.expires_at)).getTime() <= new Date(predecessorNow).getTime()
            || (predecessor.previous_generation_id ?? null) !== (manifest.predecessor.previousGenerationId ?? null)
            || predecessor.legacy_fingerprint !== manifest.predecessor.legacyFingerprint) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        // The predecessor lock may have waited while the device or its
        // consent grant expired. Recheck the complete authority fence after
        // that wait rather than trusting the pre-lock snapshot.
        await assertV12Authority(client, tables, captured);
        const state = await client.query(`SELECT v.revision,h.generation_id,d.manifest_digest FROM ${tables.inputVersions} v
          LEFT JOIN ${tables.domainHeads} h ON h.participant_id=v.participant_id
          LEFT JOIN ${tables.domains} d ON d.id=h.generation_id
          WHERE v.participant_id=$1 FOR UPDATE OF v`, [captured.participantId]);
        const stateRow = state.rows.length === 1 ? one(state) : null;
        if (stateRow === null || integer(stateRow.revision) !== integer(predecessor.input_revision)
            || nullableText(stateRow.generation_id) !== nullableText(predecessor.previous_generation_id)) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        let expectedDays: unknown;
        try { expectedDays = JSON.parse(text(predecessor.winners_json)); } catch { throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT"); }
        if (!Array.isArray(expectedDays)
            || canonicalTelemetryV12Json(expectedDays) !== canonicalTelemetryV12Json(manifest.days)
            || manifest.fromDay !== text(predecessor.from_day)
            || manifest.throughDay !== text(predecessor.through_day)) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        const manifestRows = manifest.days.map((day: { day: string; manifestId: string; manifestDigest: string }) => ({
          id: day.manifestId, chunk_day: day.day, manifest_digest: day.manifestDigest,
        }));
        const currentFingerprint = await sourceFingerprint(client, tables, captured.participantId,
          integer(stateRow.revision), nullableText(stateRow.generation_id), nullableText(stateRow.manifest_digest), manifestRows);
        if (currentFingerprint !== predecessor.legacy_fingerprint) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        for (const day of manifest.days) {
          const ready = await client.query(`SELECT 1 FROM ${tables.manifests}
            WHERE id=$1 AND participant_id=$2 AND device_id=$3 AND chunk_day=$4::date AND manifest_digest=$5 AND state='ready'
            FOR SHARE`,
          [day.manifestId, captured.participantId, captured.deviceId, day.day, day.manifestDigest]);
          if (ready.rowCount !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        }
        await assertV12Authority(client, tables, captured);
        const finalNow = await databaseClock(client);
        if (new Date(instant(predecessor.expires_at)).getTime() <= new Date(finalNow).getTime()) {
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        const generationId = crypto.randomUUID();
        await client.query(`INSERT INTO ${tables.domains} (id,participant_id,device_id,predecessor_token_hash,previous_generation_id,
          manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12)`, [generationId, captured.participantId, captured.deviceId,
          tokenHash, manifest.predecessor.previousGenerationId, manifest.manifestDigest, manifest.predecessor.legacyFingerprint,
          integer(predecessor.input_revision), manifest.fromDay, manifest.throughDay, canonicalTelemetryV12Json(manifest.days), finalNow]);
        for (const day of manifest.days) await client.query(`INSERT INTO ${tables.domainDays}
          (generation_id,observed_day,manifest_id,manifest_digest) VALUES ($1,$2::date,$3,$4)`, [generationId, day.day, day.manifestId, day.manifestDigest]);
        const head = await client.query(`INSERT INTO ${tables.domainHeads} (participant_id,generation_id,revision,updated_at)
          VALUES ($1,$2,1,$3) ON CONFLICT(participant_id) DO UPDATE SET generation_id=excluded.generation_id,
            revision=${tables.domainHeads}.revision+1,updated_at=excluded.updated_at RETURNING generation_id`, [captured.participantId, generationId, finalNow]);
        if (head.rowCount !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        const consumed = await client.query(`UPDATE ${tables.predecessors} SET consumed_at=$1
          WHERE token_hash=$2 AND participant_id=$3 AND device_id=$4 AND consumed_at IS NULL
            AND expires_at > $1::timestamptz`, [finalNow, tokenHash, captured.participantId, captured.deviceId]);
        if (rowCount(consumed) !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        return { schemaVersion: "telemetry-domain-activation-v1.2" as const, generationId,
          manifestDigest: manifest.manifestDigest, fromDay: manifest.fromDay, throughDay: manifest.throughDay, replay: false };
      }, { operation: "telemetry.v12.domain.activate", preserveSafeError }).catch(async (error) => {
        const replay = await withPostgresRead(pool, (client) => client.query(`SELECT d.id,d.manifest_digest,to_char(d.from_day,'YYYY-MM-DD') AS from_day,to_char(d.through_day,'YYYY-MM-DD') AS through_day
          FROM ${tables.domainHeads} h JOIN ${tables.domains} d ON d.id=h.generation_id
          WHERE h.participant_id=$1 AND d.device_id=$2 AND d.manifest_digest=$3`, [captured.participantId, captured.deviceId, manifest.manifestDigest]), { operation: "telemetry.v12.domain.replay", preserveSafeError }).catch(() => null);
        if (replay?.rows.length === 1) { const row = one(replay); return { schemaVersion: "telemetry-domain-activation-v1.2", generationId: text(row.id), manifestDigest: text(row.manifest_digest), fromDay: text(row.from_day), throughDay: text(row.through_day), replay: true }; }
        if (error instanceof ApiError) throw error;
        throw mapSqlError(error);
      });
    },
  };
}
