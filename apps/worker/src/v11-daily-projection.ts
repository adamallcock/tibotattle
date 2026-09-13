import type { TelemetryV11Record } from "@app-usagemonitor/telemetry-contract";
import { analyticsAuthorityIsCurrent, applyAnalyticsChange, readIngestionChanges,
  type StorageChange } from "./analytics-delivery";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { createV11DailyProjectionValues, foldV11DailyProjectionValues, mergeV11DailyProjectionValues } from "./v11-daily-projection-values";
import { lookupV11StorageSource } from "./v11-storage-journal";
import { readTypedV11ManifestPage } from "./typed-v11-record-reader";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";

export type V11ProjectionSourceLayout = { kind: "json-v11" } | { kind: "typed-v11"; sourceNamespace: string };

const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;
interface Work {
  source_id: string; event_digest: string; owner_digest: string; generation_id: string;
  manifest_digest: string; from_day: string; through_day: string; next_day: string;
  after_stream: string; after_occurrence: string; day_records: number;
  values_json: string; revision: number; phase: "building" | "ready" | "retiring";
  source_layout: V11ProjectionSourceLayout["kind"]; source_namespace: string | null;
}
interface Day {
  manifest_id: string; manifest_digest: string; state: string; expected_chunk_count: number;
  actual_chunks: number; expected_records: number;
}
interface RecordRow { stream: string; occurrence_id: string; record_json: string; }
type Values = ReturnType<typeof createV11DailyProjectionValues>;
type SourceLookup = Awaited<ReturnType<typeof lookupV11StorageSource>>;
type Generation = Extract<SourceLookup, { disposition: "generation" }>;

function int(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("V11_PROJECTION_INTEGER_INVALID");
}
function nextDay(day: string): string { return new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10); }
function readWork(target: D1Database, change: StorageChange): Promise<Work | null> {
  return target.prepare("SELECT * FROM analytics_v11_projection_work WHERE source_id=? AND event_digest=?")
    .bind(change.sourceId, change.eventDigest).first<Work>();
}
function validateWork(work: Work, source: Generation, layout: V11ProjectionSourceLayout): void {
  if (work.source_id !== source.sourceId || work.owner_digest !== source.ownerDigest
      || work.event_digest !== source.eventDigest || work.generation_id !== source.generationId
      || work.manifest_digest !== source.manifestDigest || work.from_day !== source.fromDay
      || work.through_day !== source.throughDay) throw new Error("V11_PROJECTION_SOURCE_CONFLICT");
  if (work.source_layout !== layout.kind || work.source_namespace !== (layout.kind === "typed-v11" ? layout.sourceNamespace : null)) {
    throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
  }
  int(work.day_records); int(work.revision);
  if (work.phase !== "building" && work.phase !== "ready") throw new Error("V11_PROJECTION_STATE_INVALID");
  if (work.phase === "building" && (work.next_day < work.from_day || work.next_day > work.through_day)) {
    throw new Error("V11_PROJECTION_STATE_INVALID");
  }
}

async function initializeWork(target: D1Database, change: StorageChange, source: Generation, layout: V11ProjectionSourceLayout): Promise<Work | null> {
  await target.prepare(`INSERT INTO analytics_v11_projection_work
    (source_id,event_digest,owner_digest,generation_id,manifest_digest,from_day,through_day,next_day,values_json,source_layout,source_namespace)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM analytics_applied_events WHERE source_id=? AND event_digest=?)
      AND ?=COALESCE((SELECT sequence+1 FROM analytics_source_cursors WHERE source_id=?),1)
      AND NOT EXISTS(SELECT 1 FROM analytics_v11_retirement_receipts WHERE source_id=? AND event_digest=?)
    ON CONFLICT(source_id,event_digest) DO NOTHING`)
    .bind(change.sourceId, change.eventDigest, change.ownerDigest, source.generationId,
      source.manifestDigest, source.fromDay, source.throughDay, source.fromDay,
      canonicalJson(createV11DailyProjectionValues(source.fromDay)), layout.kind, layout.kind === "typed-v11" ? layout.sourceNamespace : null,
      change.sourceId, change.eventDigest,
      change.sequence, change.sourceId, change.sourceId, change.eventDigest).run();
  const work = await readWork(target, change);
  if (!work || work.phase === "retiring") {
    // Another consumer may have finalized or discarded this exact event while
    // source metadata was being read. Verify its receipt rather than recreating
    // already retired work or trusting just a sequence number.
    await applyAnalyticsChange(target, change, async () => { throw new Error("V11_PROJECTION_STATE_MISSING"); });
    return null;
  }
  validateWork(work, source, layout);
  return work;
}

/** Metadata is read before raw rows so a fully scoped immutable value can be
 * reused without rescanning this manifest. Membership still belongs to the
 * exact event's generation, never to a mutable newest-head lookup. */
async function sourceDay(source: D1Database, generation: Generation, work: Work): Promise<Day> {
  const day = await source.prepare(`SELECT d.manifest_id,m.manifest_digest,m.state,m.expected_chunk_count,
    (SELECT COUNT(*) FROM telemetry_v11_chunks c WHERE c.manifest_id=m.id) AS actual_chunks,
    COALESCE((SELECT SUM(record_count) FROM telemetry_v11_chunks c WHERE c.manifest_id=m.id),0) AS expected_records
    FROM telemetry_v11_domain_days d
    JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
    WHERE d.generation_id=? AND d.observed_day=? AND m.participant_id=? AND m.device_id=? AND m.chunk_day=?`)
    .bind(generation.generationId, work.next_day, generation.participantId, generation.deviceId, work.next_day)
    .first<Day>();
  if (!day || day.state !== "ready" || day.actual_chunks !== day.expected_chunk_count) throw new Error("V11_PROJECTION_SOURCE_INCOMPLETE");
  int(day.expected_records); int(day.expected_chunk_count);
  return day;
}

/** One keyset page, only on a cache miss. The work's admitted physical layout
 * cannot change during resumption and typed readers never fall back to JSON. */
async function sourcePage(source: D1Database, generation: Generation, work: Work, layout: V11ProjectionSourceLayout,
  day: Day): Promise<RecordRow[]> {
  if (layout.kind === "typed-v11") {
    return readTypedV11ManifestPage(source, { sourceNamespace: layout.sourceNamespace,
      participantId: generation.participantId, deviceId: generation.deviceId, manifestId: day.manifest_id,
      afterStream: work.after_stream, afterOccurrence: work.after_occurrence, limit: PAGE_SIZE });
  }
  return (await source.prepare(`SELECT stream,occurrence_id,record_json FROM telemetry_v11_records
    WHERE manifest_id=? AND (stream,occurrence_id)>(?,?)
    ORDER BY stream,occurrence_id LIMIT ?`)
    .bind(day.manifest_id, work.after_stream, work.after_occurrence, PAGE_SIZE).all<RecordRow>()).results;
}

interface ReuseIdentity {
  value_key: string; source_id: string; source_layout: V11ProjectionSourceLayout["kind"]; source_namespace: string;
  owner_digest: string; device_id: string; manifest_id: string; manifest_digest: string; day: string;
  schema_version: string; pricing_method: string; registry_sha256: string;
}
interface ReusableValue extends ReuseIdentity { record_count: number; values_digest: string; values_json: string }
async function reuseIdentity(generation: Generation, layout: V11ProjectionSourceLayout, day: Day, date: string): Promise<ReuseIdentity> {
  const method = createV11DailyProjectionValues(date);
  const identity = { source_id: generation.sourceId, source_layout: layout.kind,
    source_namespace: layout.kind === "typed-v11" ? layout.sourceNamespace : "", owner_digest: generation.ownerDigest,
    device_id: generation.deviceId, manifest_id: day.manifest_id, manifest_digest: day.manifest_digest, day: date,
    schema_version: method.schemaVersion, pricing_method: method.pricingMethodVersion, registry_sha256: method.registrySha256 };
  return { value_key: await sha256Hex(canonicalJson(identity)), ...identity };
}
async function reusableValue(target: D1Database, identity: ReuseIdentity, expectedRecords: number): Promise<Values | null> {
  const row = await target.prepare("SELECT * FROM analytics_v11_reusable_values WHERE value_key=?")
    .bind(identity.value_key).first<ReusableValue>();
  if (!row) return null;
  for (const key of Object.keys(identity) as (keyof ReuseIdentity)[]) {
    if (row[key] !== identity[key]) throw new Error("V11_PROJECTION_REUSABLE_VALUE_CONFLICT");
  }
  const values = foldV11DailyProjectionValues(JSON.parse(row.values_json) as Values, []);
  if (row.record_count !== expectedRecords || values.counts.usage + values.counts.quota + values.counts.session !== expectedRecords
      || row.values_json !== canonicalJson(values) || row.values_digest !== await sha256Hex(row.values_json)) {
    throw new Error("V11_PROJECTION_REUSABLE_VALUE_CONFLICT");
  }
  const pages = await target.prepare(`SELECT COUNT(*) n,COALESCE(SUM(record_count),0) records
    FROM analytics_v11_value_pages WHERE value_key=?`).bind(identity.value_key).first<{n:number;records:number}>();
  if(!pages||pages.n!==Math.ceil(expectedRecords/PAGE_SIZE)||pages.records!==expectedRecords)
    throw new Error("V11_PROJECTION_REUSABLE_VALUE_CONFLICT");
  return values;
}
function reusableValueInsert(target: D1Database, identity: ReuseIdentity, recordCount: number, valuesJson: string,
  valuesDigest: string): D1PreparedStatement {
  return target.prepare(`INSERT INTO analytics_v11_reusable_values
    (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,
      schema_version,pricing_method,registry_sha256,record_count,values_digest,values_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(value_key) DO UPDATE SET
      record_count=excluded.record_count,values_digest=excluded.values_digest,values_json=excluded.values_json`)
    .bind(identity.value_key, identity.source_id, identity.source_layout, identity.source_namespace, identity.owner_digest,
      identity.device_id, identity.manifest_id, identity.manifest_digest, identity.day, identity.schema_version,
      identity.pricing_method, identity.registry_sha256, recordCount, valuesDigest, valuesJson);
}

async function discard(target: D1Database, change: StorageChange,
  proof: Extract<SourceLookup, { disposition: "discard" }>): Promise<void> {
  await applyAnalyticsChange(target, change, async db => [
    db.prepare(`INSERT INTO analytics_v11_discard_receipts
      (source_id,event_digest,owner_digest,reason,terminal_revision,terminal_sequence,authority_epoch,public_authority_epoch)
      VALUES(?,?,?,?,?,?,?,?)`).bind(change.sourceId, change.eventDigest, change.ownerDigest,
      proof.reason, proof.terminalRevision, proof.terminalSequence, proof.authorityEpoch, proof.publicAuthorityEpoch),
    db.prepare("DELETE FROM analytics_v11_owner_heads WHERE source_id=? AND owner_digest=?").bind(change.sourceId, change.ownerDigest),
    db.prepare("UPDATE analytics_v11_projection_work SET phase='retiring' WHERE source_id=? AND owner_digest=? AND phase!='retiring'")
      .bind(change.sourceId, change.ownerDigest),
  ]);
}

export interface V11DailyProjectionStep {
  state: "idle" | "building" | "applied" | "discarded";
  sequence: number;
  recordsRead: number;
  completedDay?: string;
}

/** One bounded scheduled step, not a complete backfill per invocation. Source
 * activation never calls or waits for this function. A receipt advances only
 * after every day is complete or a newer authoritative withdrawal proves that
 * the old event must be discarded. Retries do not accumulate a page twice.
 */
export async function advanceV11DailyProjection(options: {
  source: D1Database; target: D1Database; sourceId: string; signal?: AbortSignal; sourceLayout?: V11ProjectionSourceLayout;
}): Promise<V11DailyProjectionStep> {
  const { source, target, sourceId } = options;
  const requested = options.sourceLayout;
  if (requested && requested.kind !== "typed-v11" && requested.kind !== "json-v11") {
    throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
  }
  // Detach the internal caller's object before asynchronous source checks.
  const layout: V11ProjectionSourceLayout = requested?.kind === "typed-v11"
    ? { kind: "typed-v11", sourceNamespace: requested.sourceNamespace } : { kind: "json-v11" };
  if (layout.kind === "typed-v11") encodeTypedTelemetryId(layout.sourceNamespace);
  options.signal?.throwIfAborted();
  const cursor = await target.prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
    .bind(sourceId).first<{ sequence: number }>();
  const sequence = cursor?.sequence ?? 0;
  int(sequence);
  const change = (await readIngestionChanges(source, sourceId, sequence, 1))[0];
  if (!change) return { state: "idle", sequence, recordsRead: 0 };
  if (change.sequence !== sequence + 1) throw new Error("ANALYTICS_SOURCE_GAP");
  const input = await lookupV11StorageSource(source, change);
  if (input.disposition === "discard") {
    await discard(target, change, input);
    return { state: "discarded", sequence: change.sequence, recordsRead: 0 };
  }
  const typedTable = await source.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='typed_v11_admission_state'",
  ).first();
  const typedNamespace = typedTable ? await source.prepare(
    "SELECT source_namespace FROM typed_v11_admission_state WHERE id=1",
  ).first<string>("source_namespace") : null;
  if (layout.kind === "typed-v11" ? typedNamespace !== layout.sourceNamespace : typedNamespace !== null) {
    // Reject wrong layout/namespace before pinning any target work. In
    // particular, a typed empty day must not appear to pass via an empty JSON
    // table just because the deployment forgot to select its storage adapter.
    throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
  }
  const work = await initializeWork(target, change, input, layout);
  if (!work) return { state: "applied", sequence: change.sequence, recordsRead: 0 };
  if (work.phase === "ready") {
    // The exact source/terminal check above precedes the final receipt. A revoke
    // racing after it still changes source authority, blocking public serving.
    await applyAnalyticsChange(target, change, async db => [
      db.prepare(`UPDATE analytics_v11_projection_work SET phase='retiring'
        WHERE source_id=? AND event_digest=(SELECT event_digest FROM analytics_v11_owner_heads WHERE source_id=? AND owner_digest=?)
          AND event_digest!=?`).bind(sourceId, sourceId, change.ownerDigest, change.eventDigest),
      db.prepare(`INSERT INTO analytics_v11_owner_heads(source_id,owner_digest,event_digest,sequence)
        VALUES(?,?,?,?) ON CONFLICT(source_id,owner_digest) DO UPDATE SET
          event_digest=excluded.event_digest,sequence=excluded.sequence`)
        .bind(sourceId, change.ownerDigest, change.eventDigest, change.sequence),
    ]);
    return { state: "applied", sequence: change.sequence, recordsRead: 0 };
  }
  const day = await sourceDay(source, input, work);
  const identity = await reuseIdentity(input, layout, day, work.next_day);
  // Validate the saved method/counters even when a concurrent generation has
  // since completed this same immutable day. Reuse cannot hide corrupt work.
  const priorValues = foldV11DailyProjectionValues(JSON.parse(work.values_json) as Values, []);
  const cached = await reusableValue(target, identity, day.expected_records);
  const rows = cached ? [] : await sourcePage(source, input, work, layout, day);
  options.signal?.throwIfAborted();
  const pageValues = cached ? null : foldV11DailyProjectionValues(createV11DailyProjectionValues(work.next_day),
    rows.map(row => JSON.parse(row.record_json) as TelemetryV11Record));
  const pageJson = pageValues ? canonicalJson(pageValues) : null;
  const pageDigest = pageJson === null ? null : await sha256Hex(pageJson);
  const values = cached ?? mergeV11DailyProjectionValues(priorValues, pageValues!);
  const recordCount = cached ? day.expected_records : work.day_records + rows.length;
  int(recordCount);
  const completeDay = cached !== null || rows.length < PAGE_SIZE;
  if (recordCount > day.expected_records || (completeDay && recordCount !== day.expected_records)) {
    throw new Error("V11_PROJECTION_SOURCE_INCOMPLETE");
  }
  // Do not save more calculated content after a withdrawal was observed during
  // the source read. The lookup proves an explicit discard; it never swaps in
  // another mutable generation's records.
  const current = await lookupV11StorageSource(source, change);
  if (current.disposition === "discard") {
    await discard(target, change, current);
    return { state: "discarded", sequence: change.sequence, recordsRead: rows.length };
  }
  validateWork(work, current, layout);
  const ready = completeDay && work.next_day === work.through_day;
  const last = rows.at(-1);
  const afterStream = completeDay ? "" : last!.stream;
  const afterOccurrence = completeDay ? "" : last!.occurrence_id;
  const next = completeDay ? nextDay(work.next_day) : work.next_day;
  const nextValues = completeDay ? createV11DailyProjectionValues(next) : values;
  const stepDigest = await sha256Hex(canonicalJson({ eventDigest: change.eventDigest, revision: work.revision + 1,
    day: work.next_day, afterStream, afterOccurrence, recordCount, completeDay, valueKey: identity.value_key, pageDigest, values }));
  const statements = [target.prepare(`INSERT INTO analytics_v11_projection_steps(source_id,event_digest,revision,step_digest)
    VALUES(?,?,?,?)`).bind(sourceId, change.eventDigest, work.revision + 1, stepDigest)];
  if (!cached && rows.length > 0) {
    statements.push(target.prepare(`INSERT INTO analytics_v11_value_pages
      (value_key,page_index,source_id,owner_digest,producer_event,day,record_count,page_digest,values_json)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(value_key,page_index) DO UPDATE SET
        record_count=excluded.record_count,page_digest=excluded.page_digest,values_json=excluded.values_json`)
      .bind(identity.value_key,work.day_records/PAGE_SIZE,sourceId,change.ownerDigest,change.eventDigest,
        work.next_day,rows.length,pageDigest,pageJson));
  }
  if (completeDay) {
    if (!cached) {
      const valuesJson = canonicalJson(values);
      statements.push(reusableValueInsert(target, identity, recordCount, valuesJson, await sha256Hex(valuesJson)));
    }
    statements.push(target.prepare(`INSERT INTO analytics_v11_day_references(source_id,event_digest,day,value_key)
      VALUES(?,?,?,?)`).bind(sourceId, change.eventDigest, work.next_day, identity.value_key));
  }
  statements.push(target.prepare(`UPDATE analytics_v11_projection_work SET
    next_day=?,after_stream=?,after_occurrence=?,day_records=?,values_json=?,revision=revision+1,phase=?
    WHERE source_id=? AND event_digest=? AND revision=?`)
    .bind(next, afterStream, afterOccurrence, completeDay ? 0 : recordCount, canonicalJson(nextValues),
      ready ? "ready" : "building", sourceId, change.eventDigest, work.revision));
  try { await target.batch(statements); }
  catch {
    const receipt = await target.prepare(`SELECT step_digest FROM analytics_v11_projection_steps
      WHERE source_id=? AND event_digest=? AND revision=?`).bind(sourceId, change.eventDigest, work.revision + 1)
      .first<{ step_digest: string }>();
    if (receipt?.step_digest !== stepDigest) {
      // A competing consumer can finalize, withdraw and physically retire this
      // generation. Its exact final receipt is still durable; the old page must
      // not be written after that cleanup.
      await applyAnalyticsChange(target, change, async () => { throw new Error("V11_PROJECTION_STEP_UNACKNOWLEDGED"); });
      return { state: "applied", sequence: change.sequence, recordsRead: rows.length };
    }
  }
  return { state: "building", sequence, recordsRead: rows.length,
    ...(completeDay ? { completedDay: work.next_day } : {}) };
}

/** Separate bounded physical cleanup. Withdrawing the head is atomic and fast;
 * thousands of days/step receipts must not cascade inside the acknowledgement
 * transaction. A retirement receipt is emitted only after every child is gone.
 * The future erasure coordinator must require these receipts independently of
 * the serving-authority watermark before claiming physical erasure complete.
 */
export async function retireV11DailyProjectionPage(target: D1Database, sourceId: string): Promise<{
  state: "idle" | "retiring" | "retired";
}> {
  const work = await target.prepare(`SELECT event_digest,owner_digest FROM analytics_v11_projection_work
    WHERE source_id=? AND phase='retiring' ORDER BY event_digest LIMIT 1`).bind(sourceId)
    .first<{ event_digest: string; owner_digest: string }>();
  if (!work) return { state: "idle" };
  await target.batch([
    target.prepare(`DELETE FROM analytics_v11_day_references WHERE source_id=? AND event_digest=? AND day IN (
      SELECT r.day FROM analytics_v11_day_references r
      WHERE r.source_id=? AND r.event_digest=? ORDER BY r.day LIMIT 4)`)
      .bind(sourceId, work.event_digest, sourceId, work.event_digest),
    target.prepare(`DELETE FROM analytics_v11_legacy_day_values WHERE source_id=? AND event_digest=? AND day IN (
      SELECT v.day FROM analytics_v11_legacy_day_values v JOIN analytics_v11_projection_work w
      ON w.source_id=v.source_id AND w.event_digest=v.event_digest AND w.phase='retiring'
      WHERE v.source_id=? AND v.event_digest=? ORDER BY v.day LIMIT 4)`)
      .bind(sourceId, work.event_digest, sourceId, work.event_digest),
    target.prepare(`DELETE FROM analytics_v11_projection_steps WHERE source_id=? AND event_digest=? AND revision IN (
      SELECT s.revision FROM analytics_v11_projection_steps s JOIN analytics_v11_projection_work w
      ON w.source_id=s.source_id AND w.event_digest=s.event_digest AND w.phase='retiring'
      WHERE s.source_id=? AND s.event_digest=? ORDER BY s.revision LIMIT 200)`)
      .bind(sourceId, work.event_digest, sourceId, work.event_digest),
    target.prepare(`DELETE FROM analytics_v11_value_pages WHERE (value_key,page_index) IN (
      SELECT p.value_key,p.page_index FROM analytics_v11_value_pages p
      WHERE p.source_id=? AND p.owner_digest=?
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references r WHERE r.value_key=p.value_key)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work w WHERE w.source_id=p.source_id
          AND w.event_digest=p.producer_event AND w.phase!='retiring')
      ORDER BY p.value_key,p.page_index LIMIT 4)`).bind(sourceId,work.owner_digest),
    target.prepare(`DELETE FROM analytics_v11_reusable_values WHERE value_key IN (
      SELECT v.value_key FROM analytics_v11_reusable_values v
      WHERE v.source_id=? AND v.owner_digest=?
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_value_pages p WHERE p.value_key=v.value_key)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references r WHERE r.value_key=v.value_key)
      ORDER BY v.value_key LIMIT 4)`).bind(sourceId, work.owner_digest),
    target.prepare(`INSERT INTO analytics_v11_retirement_receipts(source_id,event_digest,owner_digest)
      SELECT source_id,event_digest,owner_digest FROM analytics_v11_projection_work w
      WHERE source_id=? AND event_digest=? AND phase='retiring'
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references v WHERE v.source_id=w.source_id AND v.event_digest=w.event_digest)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_legacy_day_values v WHERE v.source_id=w.source_id AND v.event_digest=w.event_digest)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_steps s WHERE s.source_id=w.source_id AND s.event_digest=w.event_digest)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_owner_heads h WHERE h.source_id=w.source_id AND h.event_digest=w.event_digest)
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_value_pages p WHERE p.source_id=w.source_id AND p.owner_digest=w.owner_digest
          AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references r WHERE r.value_key=p.value_key)
          AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work live WHERE live.source_id=p.source_id
            AND live.event_digest=p.producer_event AND live.phase!='retiring'))
        AND NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values v WHERE v.source_id=w.source_id AND v.owner_digest=w.owner_digest
          AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references r WHERE r.value_key=v.value_key))
      ON CONFLICT(source_id,event_digest) DO NOTHING`).bind(sourceId, work.event_digest),
    target.prepare(`DELETE FROM analytics_v11_projection_work WHERE source_id=? AND event_digest=? AND phase='retiring'
      AND EXISTS(SELECT 1 FROM analytics_v11_retirement_receipts r WHERE r.source_id=analytics_v11_projection_work.source_id
        AND r.event_digest=analytics_v11_projection_work.event_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_v11_day_references v WHERE v.source_id=analytics_v11_projection_work.source_id
        AND v.event_digest=analytics_v11_projection_work.event_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_v11_legacy_day_values v WHERE v.source_id=analytics_v11_projection_work.source_id
        AND v.event_digest=analytics_v11_projection_work.event_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_steps s WHERE s.source_id=analytics_v11_projection_work.source_id
        AND s.event_digest=analytics_v11_projection_work.event_digest)`)
      .bind(sourceId, work.event_digest),
  ]);
  const receipt = await target.prepare("SELECT 1 AS present FROM analytics_v11_retirement_receipts WHERE source_id=? AND event_digest=?")
    .bind(sourceId, work.event_digest).first();
  return { state: receipt ? "retired" : "retiring" };
}

/** Internal bounded owner/day read for future aggregate builders, not a public
 * endpoint. Read values, the active owner revision and the global consumer stamp
 * in one snapshot; final source authority decides whether this read may be used.
 */
export async function readV11ProjectedOwnerDays(options: {
  source: D1Database; target: D1Database; sourceId: string; ownerDigest: string; fromDay: string; throughDay: string;
}): Promise<{ state: "available" | "authority-unavailable"; values: Values[] }> {
  const { source, target, sourceId, ownerDigest, fromDay, throughDay } = options;
  const days = (Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1;
  for (const day of [fromDay, throughDay]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))
        || new Date(Date.parse(day)).toISOString().slice(0, 10) !== day) throw new Error("V11_PROJECTION_RANGE_INVALID");
  }
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("V11_PROJECTION_RANGE_INVALID");
  if (!/^[0-9a-f]{64}$/.test(ownerDigest)) throw new Error("STORAGE_DIGEST_INVALID");
  // Bound both branches before expanding JSON. Joining the unqualified UNION
  // compatibility view here would materialize every owner's historical values.
  const rows = (await target.prepare(`WITH authority AS MATERIALIZED (
    SELECT c.authority_epoch,c.source_id,e.event_digest
    FROM analytics_source_cursors c
    LEFT JOIN analytics_v11_owner_heads h ON h.source_id=c.source_id AND h.owner_digest=?2
    LEFT JOIN analytics_owner_state o ON o.source_id=h.source_id AND o.owner_digest=h.owner_digest AND o.state='active'
    LEFT JOIN analytics_applied_events e ON e.source_id=h.source_id AND e.sequence=h.sequence AND e.revision=o.revision
    WHERE c.source_id=?1
  ), selected_days AS MATERIALIZED (
    SELECT r.day,v.values_json FROM analytics_v11_day_references r
    JOIN analytics_v11_reusable_values v ON v.value_key=r.value_key
    WHERE r.source_id=?1 AND r.event_digest=(SELECT event_digest FROM authority) AND r.day BETWEEN ?3 AND ?4
    UNION ALL
    SELECT l.day,l.values_json FROM analytics_v11_legacy_day_values l
    WHERE l.source_id=?1 AND l.event_digest=(SELECT event_digest FROM authority) AND l.day BETWEEN ?3 AND ?4
  ) SELECT a.authority_epoch,d.values_json FROM authority a LEFT JOIN selected_days d ON 1=1 ORDER BY d.day LIMIT 32`)
    .bind(sourceId, ownerDigest, fromDay, throughDay)
    .all<{ authority_epoch: number; values_json: string | null }>()).results;
  const epoch = rows[0]?.authority_epoch;
  if (epoch === undefined || rows.length > 31 || rows.some(row => row.authority_epoch !== epoch)
      || !await analyticsAuthorityIsCurrent(source, target, sourceId, epoch)) {
    return { state: "authority-unavailable", values: [] };
  }
  return { state: "available", values: rows.flatMap(row => row.values_json === null ? []
    : [foldV11DailyProjectionValues(JSON.parse(row.values_json) as Values, [])]) };
}
