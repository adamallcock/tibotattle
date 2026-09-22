import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Chunk,
  parseTelemetryV11ChunkId,
  parseTelemetryV11DayManifest,
  telemetryV11DayManifestDigestInput,
  telemetryV11RecordAnchor,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V11_PRIVACY_CONTRACT_VERSION,
  type TelemetryV11Chunk,
  type TelemetryV11DayManifest,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import {
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  resolvePostgresTelemetryV11Tables,
  type PostgresTelemetryV11Tables,
} from "./postgres-telemetry-v11-schema";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import {
  validateTelemetryV11StagedChunk,
} from "./telemetry-v11-repository";
import type {
  TelemetryV11ChunkWriteMetadata,
  TelemetryV11DayCandidate,
  TelemetryV11DayCandidateQuery,
  TelemetryV11ReadyDayReference,
  TelemetryV11StagedChunkRow,
  TelemetryV11TransportBackend,
} from "./telemetry-v11-backend";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_VECTOR = 4_096;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function snapshotError(): ApiError {
  return new ApiError(400, "CHUNK_INVALID");
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") return code;
    const state = Reflect.get(error, "sqlState");
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

function mapSqlError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  switch (sqlState(error)) {
    case "P1001": return new ApiError(409, "PARTICIPANT_DELETING");
    case "P1002": return new ApiError(401, "UPLOAD_AUTH_INVALID");
    case "P1003": return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", {
      responseHeaders: { "retry-after": "60" },
    });
    case "P1005": return new ApiError(409, "CHUNK_REVISION_CONFLICT");
    case "P1006": return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
    case "P1007": return new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
    case "23505": return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    default: return unavailable();
  }
}

function preserveSafeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : mapSqlError(error);
}

function text(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw unavailable();
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw unavailable();
  if (typeof value === "string" && String(parsed) !== value) throw unavailable();
  return parsed;
}

function instant(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  throw unavailable();
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  return value;
}

function nowIso(nowEpoch: number | undefined): string {
  const epoch = nowEpoch === undefined ? Date.now() : nowEpoch;
  if (!Number.isFinite(epoch)) throw snapshotError();
  const value = new Date(epoch);
  if (!Number.isFinite(value.getTime())) throw snapshotError();
  return value.toISOString();
}

function snapshotPrincipal(principal: TelemetryTransportPrincipal): TelemetryTransportPrincipal {
  return Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
}

function canonicalLease(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  return value;
}

function rowOne<T extends Record<string, unknown>>(
  result: { readonly rows: readonly T[]; readonly rowCount: number | null },
): T {
  if (result.rowCount !== 1 || result.rows.length !== 1 || !result.rows[0]) throw unavailable();
  return result.rows[0]!;
}

function rowCount(result: { readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number | null }): number {
  if (result.rowCount === null || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0) throw unavailable();
  return result.rowCount;
}

function candidate(row: Record<string, unknown>): TelemetryV11DayCandidate {
  const state = row.state;
  if (state !== "staged" && state !== "ready") throw unavailable();
  return {
    manifestId: text(row.id),
    day: validDay(row.chunk_day),
    manifestDigest: text(row.manifest_digest),
    state,
    expectedChunks: integer(row.expected_chunk_count, 0, 4_096),
  };
}

function chunkRow(row: Record<string, unknown>): TelemetryV11StagedChunkRow {
  return {
    id: text(row.id),
    manifestId: text(row.manifest_id),
    participantId: text(row.participant_id),
    deviceId: text(row.device_id),
    chunkId: text(row.chunk_id),
    chunkDigest: text(row.chunk_digest),
    recordCount: integer(row.record_count, 1, 200),
    objectKey: text(row.r2_key),
    createdAt: instant(row.created_at),
  };
}

function snapshotManifest(value: unknown): { manifest: TelemetryV11DayManifest; canonical: string } {
  try {
    const manifest = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DayManifest(value))) as TelemetryV11DayManifest;
    return { manifest, canonical: canonicalTelemetryV11Json(manifest) };
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
}

interface ChunkSnapshot {
  readonly chunk: TelemetryV11Chunk;
  readonly metadata: TelemetryV11ChunkWriteMetadata;
  readonly now: string;
}

function snapshotMetadata(metadata: TelemetryV11ChunkWriteMetadata): TelemetryV11ChunkWriteMetadata {
  try {
    const snapshot = {
      chunkRowId: metadata.chunkRowId,
      objectKey: metadata.objectKey,
      envelopeDigest: metadata.envelopeDigest,
      deviceUploadAuthorizationId: metadata.deviceUploadAuthorizationId,
      uploadAuthorizationLeaseExpiresAt: canonicalLease(metadata.uploadAuthorizationLeaseExpiresAt),
    };
    if (typeof snapshot.chunkRowId !== "string" || snapshot.chunkRowId.length < 1
        || typeof snapshot.objectKey !== "string" || snapshot.objectKey.length < 1
        || !DIGEST.test(snapshot.envelopeDigest)
        || typeof snapshot.deviceUploadAuthorizationId !== "string"
        || snapshot.deviceUploadAuthorizationId.length < 1) throw snapshotError();
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw snapshotError();
  }
}

async function snapshotChunk(value: unknown, metadata: TelemetryV11ChunkWriteMetadata, nowEpoch?: number): Promise<ChunkSnapshot> {
  const metadataSnapshot = snapshotMetadata(metadata);
  const now = nowIso(nowEpoch);
  const chunk = await validateTelemetryV11StagedChunk(value);
  // validateTelemetryV11StagedChunk returns a canonical parsed copy before its
  // digest await, so caller mutation cannot change the transaction input.
  return Object.freeze({ chunk, metadata: metadataSnapshot, now });
}

async function databaseClock(client: PostgresClient): Promise<string> {
  return instant(rowOne(await client.query("SELECT clock_timestamp() AS now")).now);
}

/**
 * Lock authority in a fixed participant -> device -> policy order.  The clock
 * read occurs only after the locks return; a revoke/expiry that waited behind
 * this operation is therefore reflected in the final decision.
 */
async function assertV11Authority(
  client: PostgresClient,
  tables: PostgresTelemetryV11Tables,
  principal: TelemetryTransportPrincipal,
): Promise<string> {
  const participant = await client.query(
    `SELECT owner_kind, state FROM ${tables.participants} WHERE id=$1 FOR UPDATE`,
    [principal.participantId],
  );
  if (participant.rows.length !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const participantRow = rowOne(participant);
  if (participantRow.state !== "active") throw new ApiError(409, "PARTICIPANT_DELETING");
  if (participantRow.owner_kind !== "social" && participantRow.owner_kind !== "accountless") {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  const device = await client.query(
    `SELECT authority_kind, state, expires_at, accountless_enrollment_device_id
       FROM ${tables.devices}
      WHERE id=$1 AND participant_id=$2 FOR UPDATE`,
    [principal.deviceId, principal.participantId],
  );
  if (device.rows.length !== 1) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const deviceRow = rowOne(device);
  if (deviceRow.state !== "active") throw new ApiError(401, "DEVICE_AUTH_INVALID");
  if (deviceRow.authority_kind !== participantRow.owner_kind) throw new ApiError(401, "DEVICE_AUTH_INVALID");

  const floor = await client.query(
    `SELECT minimum_rank FROM ${tables.participantFloors} WHERE participant_id=$1 FOR SHARE`,
    [principal.participantId],
  );
  const floorRow = rowOne(floor);
  const format = await client.query(
    `SELECT format_rank, lifecycle FROM ${tables.formats}
      WHERE schema_version=$1 FOR SHARE`,
    [TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION],
  );
  const formatRow = rowOne(format);
  if (formatRow.lifecycle !== "accepted"
      || integer(formatRow.format_rank, 0, 100) < integer(floorRow.minimum_rank, 0, 100)) {
    throw new ApiError(409, "TELEMETRY_TRANSPORT_BLOCKED");
  }

  const dbNow = await databaseClock(client);
  if (new Date(instant(deviceRow.expires_at)).getTime() <= new Date(dbNow).getTime()) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }

  if (participantRow.owner_kind === "social") {
    const consent = await client.query(
      `SELECT 1 FROM ${tables.deviceConsents}
        WHERE participant_id=$1 AND device_id=$2
          AND telemetry_schema_version=$3
          AND field_dictionary_version=$4
          AND privacy_contract_version=$5 FOR SHARE`,
      [principal.participantId, principal.deviceId,
        TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
        TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
        TELEMETRY_V11_PRIVACY_CONTRACT_VERSION],
    );
    if (consent.rows.length !== 1) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  } else {
    const accountless = await client.query(
      `SELECT 1
         FROM ${tables.accountlessLedger} ledger
         JOIN ${tables.devices} device_row
           ON device_row.id=$3 AND device_row.participant_id=$2
         JOIN ${tables.accountlessOwners} owner
           ON owner.enrollment_device_id=ledger.device_id
         JOIN ${tables.accountlessAuthorizations} grant_row
           ON grant_row.enrollment_device_id=ledger.device_id
        WHERE ledger.device_id=$1 AND ledger.state='active'
          AND owner.participant_id=$2 AND owner.device_credential_id=$3
          AND owner.state='active' AND grant_row.participant_id=$2
          AND grant_row.device_credential_id=$3 AND grant_row.state='active'
          AND ledger.expires_at=device_row.expires_at
          AND owner.expires_at=ledger.expires_at
          AND grant_row.expires_at=ledger.expires_at
          AND grant_row.telemetry_schema_version=$4
          AND grant_row.field_dictionary_version=$5
          AND grant_row.privacy_contract_version=$6
        FOR SHARE OF ledger, owner, grant_row`,
      [deviceRow.accountless_enrollment_device_id, principal.participantId, principal.deviceId,
        TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
        TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
        TELEMETRY_V11_PRIVACY_CONTRACT_VERSION],
    );
    if (accountless.rows.length !== 1) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  return dbNow;
}

async function assertUploadLease(
  client: PostgresClient,
  tables: PostgresTelemetryV11Tables,
  principal: TelemetryTransportPrincipal,
  metadata: TelemetryV11ChunkWriteMetadata,
  dbNow: string,
): Promise<void> {
  const result = await client.query(
    `SELECT state, participant_id, issued_by_device_id, envelope_digest,
            consume_lease_expires_at, expires_at
       FROM ${tables.uploadAuthorizations}
      WHERE id=$1 AND participant_id=$2 AND issued_by_device_id=$3
      FOR UPDATE`,
    [metadata.deviceUploadAuthorizationId, principal.participantId, principal.deviceId],
  );
  if (result.rows.length !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const row = rowOne(result);
  const lease = canonicalLease(metadata.uploadAuthorizationLeaseExpiresAt);
  const storedLease = row.consume_lease_expires_at === null
    ? null
    : instant(row.consume_lease_expires_at);
  if (row.state !== "consuming"
      || row.envelope_digest !== metadata.envelopeDigest
      || storedLease !== lease
      || new Date(lease).getTime() <= new Date(dbNow).getTime()
      || new Date(instant(row.expires_at)).getTime() <= new Date(dbNow).getTime()) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
}

async function markUploadConsumed(
  client: PostgresClient,
  tables: PostgresTelemetryV11Tables,
  metadata: TelemetryV11ChunkWriteMetadata,
  contributionId: string,
  now: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE ${tables.uploadAuthorizations}
        SET state='consumed', consumed_at=$1, consumed_contribution_id=$2,
            consume_lease_expires_at=NULL
      WHERE id=$3 AND state='consuming'`,
    [now, contributionId, metadata.deviceUploadAuthorizationId],
  );
  // The row was locked and validated before the insert. Any missing update
  // means the transaction did not operate on the claimed authority.
  if (rowCount(result) !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
}

function validateRange(options: TelemetryV11DayCandidateQuery): { fromDay: string; toDay: string; limit: number } {
  const fromDay = validDay(options.fromDay);
  const toDay = validDay(options.toDay);
  const start = Date.parse(`${fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  const limit = options.limit ?? 200;
  if (end < start || end - start > 30 * 86_400_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  return { fromDay, toDay, limit };
}

function manifestReferenceSnapshot(
  vector: readonly TelemetryV11ReadyDayReference[],
): TelemetryV11ReadyDayReference[] {
  if (!Array.isArray(vector) || vector.length > MAX_VECTOR) {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  const snapshot = vector.map((value) => ({
    day: validDay(value.day),
    manifestId: value.manifestId,
    manifestDigest: value.manifestDigest,
  }));
  if (snapshot.some((value) => typeof value.manifestId !== "string" || !UUID.test(value.manifestId)
      || typeof value.manifestDigest !== "string" || !DIGEST.test(value.manifestDigest))
      || new Set(snapshot.map((value) => value.day)).size !== snapshot.length) {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  return snapshot;
}

function isExactChunk(row: TelemetryV11StagedChunkRow, chunk: TelemetryV11Chunk): boolean {
  return row.chunkId === chunk.chunkId
    && row.chunkDigest === chunk.chunkDigest
    && row.recordCount === chunk.records.length;
}

/** PostgreSQL v1.1 transport implementation over the canonical primary schema. */
export function createPostgresTelemetryV11Backend(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryV11TransportBackend {
  const tables = resolvePostgresTelemetryV11Tables(schemaOptions);

  async function readExisting(
    principal: TelemetryTransportPrincipal,
    chunk: TelemetryV11Chunk,
  ): Promise<TelemetryV11StagedChunkRow | null> {
    const { day } = parseTelemetryV11ChunkId(chunk.chunkId);
    try {
      return await withPostgresRead(pool, async (client) => {
        const result = await client.query(
          `SELECT c.id, c.manifest_id, c.participant_id, c.device_id, c.chunk_id,
                  c.chunk_digest, c.record_count, c.r2_key, c.created_at
             FROM ${tables.chunks} c
             JOIN ${tables.manifests} m ON m.id=c.manifest_id
            WHERE m.participant_id=$1 AND m.device_id=$2 AND m.chunk_day=$3::date
              AND m.manifest_digest=$4 AND c.chunk_id=$5
            LIMIT 2`,
          [principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId],
        );
        if (result.rows.length > 1) throw unavailable();
        return result.rows.length === 0 ? null : chunkRow(result.rows[0]!);
      }, {
        operation: "telemetry.v11.read.existing",
        preserveSafeError,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  return {
    validateChunk: validateTelemetryV11StagedChunk,

    async registerDayManifest(principal, value, nowEpoch) {
      principal = snapshotPrincipal(principal);
      const { manifest, canonical } = snapshotManifest(value);
      const digest = await sha256Hex(telemetryV11DayManifestDigestInput(manifest));
      if (digest !== manifest.manifestDigest) throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
      const now = nowIso(nowEpoch);
      try {
        return await withPostgresMutation(pool, async (client) => {
          await assertV11Authority(client, tables, principal);
          const existing = await client.query(
            `SELECT id, to_char(chunk_day,'YYYY-MM-DD') AS chunk_day, manifest_digest,
                    expected_chunk_count, state, manifest_json
               FROM ${tables.manifests}
              WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date
                AND manifest_digest=$4
              FOR UPDATE`,
            [principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest],
          );
          if (existing.rows.length > 1) throw unavailable();
          if (existing.rows.length === 1) {
            const row = rowOne(existing);
            if (row.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
            return candidate(row);
          }
          if (manifest.chunks.length > 4_096) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
          const id = crypto.randomUUID();
          const inserted = await client.query(
            `INSERT INTO ${tables.manifests} (
              id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
              manifest_json, expected_chunk_count, state, created_at, ready_at
            ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`,
            [id, principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest,
              manifest.parserVersion, canonical, manifest.chunks.length,
              manifest.chunks.length === 0 ? "ready" : "staged",
              now, manifest.chunks.length === 0 ? now : null],
          );
          if (rowCount(inserted) > 1) throw unavailable();
          const stored = await client.query(
            `SELECT id, to_char(chunk_day,'YYYY-MM-DD') AS chunk_day, manifest_digest,
                    expected_chunk_count, state, manifest_json
               FROM ${tables.manifests}
              WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date
                AND manifest_digest=$4
              FOR UPDATE`,
            [principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest],
          );
          if (stored.rows.length !== 1) throw unavailable();
          const row = rowOne(stored);
          if (row.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
          return candidate(row);
        }, {
          operation: "telemetry.v11.manifest.register",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw mapSqlError(error);
      }
    },

    async existingChunk(principal, value) {
      principal = snapshotPrincipal(principal);
      const chunk = await validateTelemetryV11StagedChunk(value);
      return readExisting(principal, chunk);
    },

    async persistChunk(principal, value, metadata, nowEpoch) {
      principal = snapshotPrincipal(principal);
      const snapshot = await snapshotChunk(value, metadata, nowEpoch);
      const { chunk } = snapshot;
      const { stream, day, seq } = parseTelemetryV11ChunkId(chunk.chunkId);
      try {
        return await withPostgresMutation(pool, async (client) => {
          await assertV11Authority(client, tables, principal);
          const manifestResult = await client.query(
            `SELECT id, to_char(chunk_day,'YYYY-MM-DD') AS chunk_day, manifest_digest,
                    expected_chunk_count, state, manifest_json
               FROM ${tables.manifests}
              WHERE participant_id=$1 AND device_id=$2 AND chunk_day=$3::date
                AND manifest_digest=$4
              FOR UPDATE`,
            [principal.participantId, principal.deviceId, day, chunk.manifestDigest],
          );
          if (manifestResult.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          const manifest = rowOne(manifestResult);
          const manifestId = text(manifest.id);
          const expected = await client.query(
            `SELECT 1 FROM jsonb_array_elements(($1::text)::jsonb->'chunks') item
              WHERE item->>'chunkId'=$2 AND item->>'chunkDigest'=$3
                AND (item->>'recordCount')::integer=$4`,
            [manifest.manifest_json, chunk.chunkId, chunk.chunkDigest, chunk.records.length],
          );
          if (expected.rows.length !== 1) {
            throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          }

          const existing = await client.query(
            `SELECT c.id, c.manifest_id, c.participant_id, c.device_id, c.chunk_id,
                    c.chunk_digest, c.record_count, c.r2_key, c.created_at
               FROM ${tables.chunks} c
              WHERE c.manifest_id=$1 AND c.chunk_id=$2
              FOR UPDATE`,
            [manifestId, chunk.chunkId],
          );
          if (existing.rows.length > 1) throw unavailable();
          if (existing.rows.length === 1) {
            const row = chunkRow(existing.rows[0]!);
            if (!isExactChunk(row, chunk)) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
            return { contributionId: row.id, manifestId, chunkId: chunk.chunkId, replay: true };
          }
          if (manifest.state !== "staged") {
            throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          }

          const dbNow = await assertV11Authority(client, tables, principal);
          await assertUploadLease(client, tables, principal, snapshot.metadata, dbNow);
          const pending = await client.query(
            `INSERT INTO ${tables.pendingObjects}(contribution_id, object_key)
               VALUES ($1,$2)
            ON CONFLICT (contribution_id) DO UPDATE SET object_key=EXCLUDED.object_key
              WHERE ${tables.pendingObjects}.object_key=EXCLUDED.object_key
            RETURNING contribution_id`,
            [snapshot.metadata.chunkRowId, snapshot.metadata.objectKey],
          );
          if (pending.rows.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");

          const inserted = await client.query(
            `INSERT INTO ${tables.chunks} (
              id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
              chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
              r2_key, device_upload_authorization_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            RETURNING id`,
            [snapshot.metadata.chunkRowId, manifestId, principal.participantId, principal.deviceId,
              stream, day, seq, chunk.chunkId, chunk.chunkDigest, snapshot.metadata.envelopeDigest,
              chunk.parserVersion, chunk.records.length, snapshot.metadata.objectKey,
              snapshot.metadata.deviceUploadAuthorizationId, snapshot.now],
          );
          if (rowCount(inserted) !== 1) throw unavailable();
          for (const record of chunk.records) {
            const anchor = telemetryV11RecordAnchor(stream, record);
            const legacy = telemetryV11LegacyProjection(stream, record);
            const recordResult = await client.query(
              `INSERT INTO ${tables.records} (
                chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json,
                legacy_occurrence_id, legacy_record_json
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [snapshot.metadata.chunkRowId, manifestId, stream, anchor.occurrenceId,
                anchor.observedAt, canonicalTelemetryV11Json(record),
                legacy?.occurrenceId ?? null, legacy?.canonicalRecord ?? null],
            );
            if (rowCount(recordResult) !== 1) throw unavailable();
          }
          await client.query(
            `UPDATE ${tables.manifests} m SET state='ready', ready_at=$1
              WHERE m.id=$2 AND m.state='staged'
                AND m.expected_chunk_count=(SELECT count(*) FROM ${tables.chunks} c WHERE c.manifest_id=m.id)
                AND NOT EXISTS (
                  SELECT 1 FROM ${tables.chunks} c
                   WHERE c.manifest_id=m.id
                     AND c.record_count <> (SELECT count(*) FROM ${tables.records} r WHERE r.chunk_id=c.id)
                )`,
            [snapshot.now, manifestId],
          );
          await markUploadConsumed(client, tables, snapshot.metadata,
            snapshot.metadata.chunkRowId, snapshot.now);
          return {
            contributionId: snapshot.metadata.chunkRowId,
            manifestId,
            chunkId: chunk.chunkId,
            replay: false,
          };
        }, {
          operation: "telemetry.v11.chunk.persist",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // A lost commit acknowledgement is reconciled by the exact chunk
        // identity.  A different or partial row never becomes a replay.
        const replay = await readExisting(principal, chunk).catch(() => null);
        if (replay !== null) {
          if (isExactChunk(replay, chunk)) {
            return { contributionId: replay.id, manifestId: replay.manifestId, chunkId: chunk.chunkId, replay: true };
          }
          throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
        }
        throw mapSqlError(error);
      }
    },

    async readDayCandidates(principal, options) {
      principal = snapshotPrincipal(principal);
      const range = validateRange(options);
      try {
        return await withPostgresRead(pool, async (client) => {
          const result = await client.query(
            `SELECT id, to_char(chunk_day,'YYYY-MM-DD') AS chunk_day, manifest_digest,
                    expected_chunk_count, state
               FROM ${tables.manifests}
              WHERE participant_id=$1 AND device_id=$2
                AND chunk_day >= $3::date AND chunk_day <= $4::date
              ORDER BY chunk_day, created_at, id LIMIT $5`,
            [principal.participantId, principal.deviceId, range.fromDay, range.toDay, range.limit + 1],
          );
          if (result.rows.length > range.limit + 1) throw unavailable();
          return {
            candidates: result.rows.slice(0, range.limit).map((row) => candidate(row)),
            bounded: result.rows.length > range.limit,
          };
        }, {
          operation: "telemetry.v11.manifest.read",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable();
      }
    },

    async readDayChunkVector(principal, manifestId) {
      principal = snapshotPrincipal(principal);
      if (typeof manifestId !== "string" || !UUID.test(manifestId)) throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      try {
        return await withPostgresRead(pool, async (client) => {
          const result = await client.query(
            `SELECT c.chunk_id, c.chunk_digest, c.record_count
               FROM ${tables.chunks} c JOIN ${tables.manifests} m ON m.id=c.manifest_id
              WHERE m.id=$1 AND m.participant_id=$2 AND m.device_id=$3
              ORDER BY c.stream, c.chunk_seq LIMIT 4097`,
            [manifestId, principal.participantId, principal.deviceId],
          );
          if (result.rows.length > MAX_VECTOR) throw unavailable();
          return result.rows.map((row) => ({
            chunkId: text(row.chunk_id),
            chunkDigest: text(row.chunk_digest),
            recordCount: integer(row.record_count, 1, 200),
          }));
        }, {
          operation: "telemetry.v11.chunk.vector",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable();
      }
    },

    async loadReadyDayVector(principal, vector) {
      principal = snapshotPrincipal(principal);
      const snapshot = manifestReferenceSnapshot(vector);
      if (snapshot.length === 0) return [];
      try {
        return await withPostgresRead(pool, async (client) => {
          const requested = JSON.stringify(snapshot);
          const result = await client.query(
            `WITH requested AS (
              SELECT value->>'day' AS day, value->>'manifestId' AS manifest_id,
                     value->>'manifestDigest' AS manifest_digest, ordinality
                FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY
            )
            SELECT m.id, to_char(m.chunk_day,'YYYY-MM-DD') AS chunk_day, m.manifest_digest,
                   m.expected_chunk_count, m.state, requested.ordinality
              FROM requested
              JOIN ${tables.manifests} m
                ON m.id=requested.manifest_id AND m.chunk_day=requested.day::date
               AND m.manifest_digest=requested.manifest_digest
             WHERE m.participant_id=$2 AND m.device_id=$3 AND m.state='ready'
               AND m.expected_chunk_count=(SELECT count(*) FROM ${tables.chunks} c WHERE c.manifest_id=m.id)
               AND NOT EXISTS (
                 SELECT 1 FROM ${tables.chunks} c
                  WHERE c.manifest_id=m.id
                    AND c.record_count <> (SELECT count(*) FROM ${tables.records} r WHERE r.chunk_id=c.id)
               )
             ORDER BY requested.ordinality`,
            [requested, principal.participantId, principal.deviceId],
          );
          if (result.rows.length !== snapshot.length) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          return result.rows.map((row) => candidate(row));
        }, {
          operation: "telemetry.v11.ready.vector",
          preserveSafeError,
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable();
      }
    },
  };
}

/** Compatibility alias for the hosted Worker composition root. */
export const createPostgresTelemetryV11TransportBackend = createPostgresTelemetryV11Backend;
