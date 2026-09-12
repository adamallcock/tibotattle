import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords,
  type TypedTelemetryFormat } from "./typed-telemetry-codec";
import { prepareTypedTelemetryInsert, readTypedTelemetryPage,
  type TypedTelemetrySourceRecord } from "./typed-telemetry-repository";

/** Internal, bounded raw-evidence copy. This is deliberately not a cutover API.
 * Its caller must hold the source write fence for the entire copy/verification
 * and copy authority/receipts separately. A snapshot digest labels that externally
 * verified source; supplying one does not make a mutable database a snapshot.
 */
export const MAX_RAW_COPY_PAGE = 32;
export interface RawCopyRun {
  runId: string; sourceNamespace: string; sourceSnapshotDigest: string;
  format: TypedTelemetryFormat;
}
type Row = Record<string, unknown>;
function fail(): never { throw new Error("RAW_COPY_EVIDENCE_MISMATCH"); }
function id(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) fail();
}
function validate(run: RawCopyRun) {
  id(run.runId); id(run.sourceNamespace);
  if (!/^[a-f0-9]{64}$/.test(run.sourceSnapshotDigest) || !["v1", "v11"].includes(run.format)) fail();
}
function text(row: Row, key: string): string { if (typeof row[key] !== "string") fail(); return row[key]; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(); return value; }
function same(row: Row, key: string, value: unknown) { if (row[key] !== value) fail(); }

export async function beginRawTelemetryCopy(target: D1Database, run: RawCopyRun): Promise<void> {
  validate(run);
  await target.prepare(`INSERT INTO storage_raw_copy_runs(run_id,source_namespace,source_snapshot_digest,format)
    VALUES(?,?,?,?) ON CONFLICT(run_id) DO NOTHING`)
    .bind(run.runId, run.sourceNamespace, run.sourceSnapshotDigest, run.format).run();
  await state(target, run);
}
async function state(target: D1Database, run: RawCopyRun) {
  validate(run);
  const row = await target.prepare("SELECT * FROM storage_raw_copy_runs WHERE run_id=?").bind(run.runId).first<Row>();
  if (!row || row.source_namespace !== run.sourceNamespace || row.source_snapshot_digest !== run.sourceSnapshotDigest
    || row.format !== run.format) fail();
  return { after: integer(row.last_source_row_id), count: integer(row.copied_rows) };
}

/** LEFT JOIN is intentional: orphan evidence refuses the copy rather than
 * disappearing through a join. All three streams and staged v1.1 domains count.
 * There is no active/eligible-owner filter on preservation reads.
 */
export async function readLegacyTelemetryCopyPage(source: D1Database, options: {
  sourceNamespace: string; format: TypedTelemetryFormat; afterSourceRowId: number; limit?: number;
}): Promise<TypedTelemetrySourceRecord[]> {
  id(options.sourceNamespace); integer(options.afterSourceRowId);
  const limit = options.limit ?? MAX_RAW_COPY_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RAW_COPY_PAGE) fail();
  if (!["v1", "v11"].includes(options.format)) fail();
  const table = options.format === "v1" ? "telemetry_v1_records" : "telemetry_v11_records";
  const key = options.format === "v1" ? "id" : "rowid";
  // Ordinary writers allocate positive IDs, but SQLite also admits explicit
  // zero/negative/64-bit IDs. Refuse them instead of silently omitting evidence
  // from the positive, JavaScript-safe keyset shared with the typed repository.
  // Separate ordered scalar lookups use the row index, not a whole-table scan.
  const extremes = await source.prepare(`SELECT
    (SELECT ${key} FROM ${table} ORDER BY ${key} ASC LIMIT 1) AS first_id,
    (SELECT ${key} FROM ${table} ORDER BY ${key} DESC LIMIT 1) AS last_id`).first<Row>();
  if (!extremes) fail();
  if (extremes.first_id !== null || extremes.last_id !== null) {
    if (integer(extremes.first_id) < 1 || integer(extremes.last_id) < 1) fail();
  }
  const sql = options.format === "v1"
    ? `SELECT r.*, r.id AS original_row_id, c.chunk_day AS original_chunk_day,
        c.participant_id AS chunk_owner, c.device_id AS chunk_device, c.stream AS chunk_stream
        FROM telemetry_v1_records r LEFT JOIN telemetry_v1_chunks c ON c.id=r.chunk_row_id
        WHERE r.id>? ORDER BY r.id LIMIT ?`
    : `SELECT r.*, r.rowid AS original_row_id, c.chunk_day AS original_chunk_day,
        c.participant_id AS chunk_owner, c.device_id AS chunk_device, c.stream AS chunk_stream,
        c.manifest_id AS chunk_manifest, m.participant_id AS manifest_owner,
        m.device_id AS manifest_device, m.chunk_day AS manifest_day
        FROM telemetry_v11_records r LEFT JOIN telemetry_v11_chunks c ON c.id=r.chunk_id
        LEFT JOIN telemetry_v11_day_manifests m ON m.id=r.manifest_id
        WHERE r.rowid>? ORDER BY r.rowid LIMIT ?`;
  const rows = (await source.prepare(sql).bind(options.afterSourceRowId, limit).all<Row>()).results;
  return rows.map(row => {
    const canonical = text(row, "record_json");
    if (new TextEncoder().encode(canonical).byteLength > 100_000) fail();
    let record: unknown;
    try { record = JSON.parse(canonical); } catch { fail(); }
    const fields = encodeTypedTelemetryRecord(options.format, record);
    const decoded = typedTelemetryCanonicalRecords(fields);
    if (decoded.canonicalRecord !== canonical) fail();
    const observed = new Date(fields.observedAtMs).toISOString();
    const chunkOwner = text(row, "chunk_owner"), chunkDevice = text(row, "chunk_device"), day = text(row, "original_chunk_day");
    same(row, "stream", fields.stream); same(row, "chunk_stream", fields.stream);
    same(row, "observed_at", observed);
    const occurrence = fields.stream === "usage" ? Reflect.get(decoded.record, "eventId")
      : fields.stream === "quota" ? Reflect.get(decoded.record, "observationId") : Reflect.get(decoded.record, "sessionUuid");
    same(row, "occurrence_id", occurrence);
    if (options.format === "v1") {
      same(row, "participant_id", chunkOwner); same(row, "device_id", chunkDevice);
      // The original explicit observed_day is preserved, not silently repaired.
      same(row, "provider", fields.provider);
      const u = fields.usage, q = fields.quota;
      same(row, "model_id", u?.modelId ?? null);
      same(row, "session_uuid", fields.stream === "session" ? occurrence : u ? Reflect.get(decoded.record, "sessionUuid") : null);
      for (const [column, value] of Object.entries({ plan_type: q?.planType ?? null, plan_variant: q?.planVariant ?? null,
        limit_id: q?.limitId ?? null, slot: q?.slot ?? null, used_percent: q?.usedPercent ?? null,
        window_duration_minutes: q?.windowDurationMinutes ?? null,
        resets_at: q?.resetsAtMs == null ? null : new Date(q.resetsAtMs).toISOString(),
        input_uncached_tokens: u?.components.inputUncachedTokens ?? null,
        input_cache_read_tokens: u?.components.inputCacheReadTokens ?? null,
        input_cache_write_tokens: u?.components.inputCacheWriteTokens ?? null,
        output_text_tokens: u?.components.outputTextTokens ?? null,
        output_reasoning_tokens: u?.components.outputReasoningTokens ?? null,
        output_combined_tokens: u?.components.outputCombinedTokens ?? null })) same(row, column, value);
    } else {
      same(row, "chunk_manifest", text(row, "manifest_id"));
      same(row, "manifest_owner", chunkOwner); same(row, "manifest_device", chunkDevice); same(row, "manifest_day", day);
      same(row, "legacy_occurrence_id", decoded.legacy?.occurrenceId ?? null);
      same(row, "legacy_record_json", decoded.legacy?.canonicalRecord ?? null);
    }
    return { sourceNamespace: options.sourceNamespace, format: options.format,
      sourceRowId: integer(row.original_row_id), participantId: chunkOwner, deviceId: chunkDevice,
      chunkRowId: text(row, options.format === "v1" ? "chunk_row_id" : "chunk_id"),
      manifestId: options.format === "v1" ? null : text(row, "manifest_id"), chunkDay: day,
      observedDay: options.format === "v1" ? text(row, "observed_day") : observed.slice(0, 10), record: decoded.record };
  });
}

export async function copyLegacyTelemetryPage(source: D1Database, target: D1Database, run: RawCopyRun): Promise<{
  copied: number; afterSourceRowId: number; reachedEnd: boolean;
}> {
  const checkpoint = await state(target, run);
  const rows = await readLegacyTelemetryCopyPage(source, { sourceNamespace: run.sourceNamespace,
    format: run.format, afterSourceRowId: checkpoint.after });
  if (!rows.length) return { copied: 0, afterSourceRowId: checkpoint.after, reachedEnd: true };
  const prepared = await prepareTypedTelemetryInsert(target, rows);
  const through = rows.at(-1)!.sourceRowId;
  const receipt = target.prepare(`INSERT INTO storage_raw_copy_pages
    (run_id,after_source_row_id,through_source_row_id,record_count,batch_digest) VALUES(?,?,?,?,?)`)
    .bind(run.runId, checkpoint.after, through, rows.length, prepared.batchDigest);
  try { await target.batch([...prepared.statements, receipt]); }
  catch {
    const durable = await target.prepare(`SELECT through_source_row_id,record_count,batch_digest FROM storage_raw_copy_pages
      WHERE run_id=? AND after_source_row_id=?`).bind(run.runId, checkpoint.after).first<Row>();
    if (!durable || durable.through_source_row_id !== through || durable.record_count !== rows.length
      || durable.batch_digest !== prepared.batchDigest) throw new Error("RAW_COPY_UNACKNOWLEDGED");
  }
  return { copied: rows.length, afterSourceRowId: through, reachedEnd: false };
}

/** Second-pass equality includes exact bytes, legacy bytes and memberships.
 * Run while the same source fence is held; no source deletion is performed.
 */
export async function verifyLegacyTelemetryCopyPage(source: D1Database, target: D1Database, run: RawCopyRun,
  afterSourceRowId: number): Promise<{ verified: number; afterSourceRowId: number; reachedEnd: boolean }> {
  await state(target, run);
  const original = await readLegacyTelemetryCopyPage(source, { sourceNamespace: run.sourceNamespace,
    format: run.format, afterSourceRowId });
  const copied = await readTypedTelemetryPage(target, { sourceNamespace: run.sourceNamespace,
    format: run.format, afterSourceRowId, limit: MAX_RAW_COPY_PAGE });
  const actual = copied.records.map(({ canonicalRecord: _canonical, legacy: _legacy, ...row }) => row);
  if (canonicalTelemetryV11Json(original) !== canonicalTelemetryV11Json(actual)) fail();
  for (const row of copied.records) {
    const expected = typedTelemetryCanonicalRecords(encodeTypedTelemetryRecord(run.format, row.record));
    if (row.canonicalRecord !== expected.canonicalRecord || canonicalTelemetryV11Json(row.legacy) !== canonicalTelemetryV11Json(expected.legacy)) fail();
  }
  return { verified: original.length, afterSourceRowId: original.at(-1)?.sourceRowId ?? afterSourceRowId, reachedEnd: original.length === 0 };
}
