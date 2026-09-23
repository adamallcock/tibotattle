import type { TelemetryV11Record } from "@app-usagemonitor/telemetry-contract";
import { analyticsAuthorityIsCurrent, applyAnalyticsChange, readIngestionChanges,
  type StorageChange } from "./analytics-delivery";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { createV11DailyProjectionValues, foldV11DailyProjectionValues, mergeV11DailyProjectionValues, validateV11DailyProjectionValues } from "./v11-daily-projection-values";
import { lookupV11StorageSource, type V11StorageDiscard, type V11StorageGeneration } from "./v11-storage-journal";
import { readTypedV11ManifestPage } from "./typed-v11-record-reader";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";

export type V11ProjectionSourceLayout = { kind: "json-v11" } | { kind: "typed-v11"; sourceNamespace: string };

const PAGE_SIZE = 200;
const MAX_PHYSICAL_PAGE_GROUP = 5;
const MAX_PAGE_VALUE_BYTES = 262_144;
const FINAL_PROOF_HEADROOM_MS = 2_500;
const textEncoder = new TextEncoder();
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
type SourceLookup = V11StorageGeneration | V11StorageDiscard;
type Generation = V11StorageGeneration;

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
  let work = await readWork(target, change);
  if (work && work.phase !== "retiring") {
    validateWork(work, source, layout);
    return work;
  }
  if (work?.phase === "retiring") {
    await applyAnalyticsChange(target, change, async () => { throw new Error("V11_PROJECTION_STATE_MISSING"); });
    return null;
  }
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
  work = await readWork(target, change);
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

export class V11ProjectionDeadlineExceededError extends Error {
  constructor() { super("V11_PROJECTION_DEADLINE_EXCEEDED"); }
}

function validateAdmission(sourceId: string, change: StorageChange, input: SourceLookup): void {
  const fail = () => { throw new Error("V11_PROJECTION_SOURCE_CONFLICT"); };
  const digest = /^[0-9a-f]{64}$/;
  const id = (value: unknown, maximum = 256) => typeof value === "string" && value.length > 0 && value.length <= maximum;
  const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
  const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0,10) === value;
  const changeKeys = ["authorityEpoch","contentDigest","eventDigest","kind","objectDigest","ownerDigest",
    "publicAuthorityEpoch","recordedMs","revision","sequence","sourceId"];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(sourceId)
      || Object.keys(change).sort().join() !== changeKeys.sort().join() || change.sourceId !== sourceId
      || !integer(change.sequence, 1) || !integer(change.revision, 1) || !integer(change.recordedMs)
      || !integer(change.authorityEpoch, 1) || !integer(change.publicAuthorityEpoch, 1)
      || ![change.eventDigest,change.ownerDigest,change.objectDigest,change.contentDigest].every(value => digest.test(value))
      || !["source-updated","owner-active","owner-withdrawn","owner-erased"].includes(change.kind)
      || input.sourceId !== sourceId || input.ownerDigest !== change.ownerDigest) fail();
  if (input.disposition === "generation") {
    const keys = ["authorityEpoch","deviceId","disposition","eventDigest","fromDay","generationId","headRevision",
      "inputRevision","manifestDigest","ownerDigest","participantId","publicAuthorityEpoch","sourceId","throughDay"];
    if (Object.keys(input).sort().join() !== keys.sort().join() || !["source-updated","owner-active"].includes(change.kind)
        || input.eventDigest !== change.eventDigest || input.eventDigest !== change.objectDigest
        || input.manifestDigest !== change.contentDigest || input.authorityEpoch !== change.authorityEpoch
        || input.publicAuthorityEpoch !== change.publicAuthorityEpoch || !id(input.generationId) || !id(input.participantId)
        || !id(input.deviceId) || !digest.test(input.manifestDigest) || !integer(input.headRevision, 1)
        || !integer(input.inputRevision) || !day(input.fromDay) || !day(input.throughDay)
        || input.fromDay > input.throughDay) fail();
    return;
  }
  const keys = ["authorityEpoch","disposition","ownerDigest","publicAuthorityEpoch","reason","sourceId",
    "terminalRevision","terminalSequence"];
  if (Object.keys(input).sort().join() !== keys.sort().join() || !integer(input.terminalSequence, 1)
      || !integer(input.terminalRevision, 1) || !integer(input.authorityEpoch, 1)
      || !integer(input.publicAuthorityEpoch, 1) || !["owner-withdrawn","owner-erased"].includes(input.reason)) fail();
  if (change.kind === "owner-withdrawn" || change.kind === "owner-erased") {
    if (input.reason !== change.kind || input.terminalSequence !== change.sequence || input.terminalRevision !== change.revision
        || input.authorityEpoch !== change.authorityEpoch || input.publicAuthorityEpoch !== change.publicAuthorityEpoch) fail();
  } else if (input.terminalSequence <= change.sequence || input.terminalRevision <= change.revision
      || input.authorityEpoch <= change.authorityEpoch || input.publicAuthorityEpoch <= change.publicAuthorityEpoch) fail();
}

async function validateSourceLayout(source: D1Database, layout: V11ProjectionSourceLayout): Promise<void> {
  if (layout.kind === "typed-v11") {
    let typedNamespace: string | null = null;
    try {
      typedNamespace = await source.prepare("SELECT source_namespace FROM typed_v11_admission_state WHERE id=1 AND runtime_contract_version=1")
        .first<string>("source_namespace");
    } catch { throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT"); }
    if (typedNamespace !== layout.sourceNamespace) throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
    return;
  }
  const typedTable = await source.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='typed_v11_admission_state'",
  ).first();
  if (typedTable) throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
}

interface PhysicalPagePlan {
  revision: number; stepDigest: string; pageIndex: number; pageDigest: string;
  pageJson: string; afterStream: string; afterOccurrence: string;
  recordCount: number; valuesJson: string;
}

/** A group contains only full physical pages from one immutable day. The final
 * partial/empty page and every day transition retain the existing one-page
 * path. D1 executes the per-page statements sequentially in one transaction. */
async function advancePhysicalPageGroup(options: {
  source: D1Database; target: D1Database; sourceId: string; change: StorageChange;
  input: Generation; layout: Extract<V11ProjectionSourceLayout, { kind: "typed-v11" }>;
  work: Work; day: Day; identity: ReuseIdentity; priorValues: Values;
  maxPages: number; deadlineMs: number; signal?: AbortSignal;
}): Promise<V11DailyProjectionStep | null> {
  const { source, target, sourceId, change, input, layout, work, day } = options;
  if (work.day_records % PAGE_SIZE !== 0) throw new Error("V11_PROJECTION_STATE_INVALID");
  if (day.expected_records - work.day_records < PAGE_SIZE) return null;
  if (Date.now() >= options.deadlineMs - FINAL_PROOF_HEADROOM_MS) {
    throw new V11ProjectionDeadlineExceededError();
  }
  let virtual = { ...work }, values = options.priorValues, bytes = 0;
  const plans: PhysicalPagePlan[] = [];
  for (let index = 0; index < options.maxPages; index += 1) {
    if (index > 0 && Date.now() >= options.deadlineMs - FINAL_PROOF_HEADROOM_MS) break;
    if (day.expected_records - virtual.day_records < PAGE_SIZE) break;
    options.signal?.throwIfAborted();
    const rows = await sourcePage(source, input, virtual, layout, day);
    if (rows.length !== PAGE_SIZE) throw new Error("V11_PROJECTION_SOURCE_INCOMPLETE");
    const pageValues = foldV11DailyProjectionValues(createV11DailyProjectionValues(virtual.next_day),
      rows.map(row => JSON.parse(row.record_json) as TelemetryV11Record));
    const pageJson = canonicalJson(pageValues);
    const pageBytes = textEncoder.encode(pageJson).byteLength;
    if (pageBytes > MAX_PAGE_VALUE_BYTES || bytes + pageBytes > MAX_PHYSICAL_PAGE_GROUP * MAX_PAGE_VALUE_BYTES) {
      throw new Error("V11_PROJECTION_PAGE_LIMIT");
    }
    bytes += pageBytes;
    const pageDigest = await sha256Hex(pageJson);
    values = mergeV11DailyProjectionValues(values, pageValues);
    const recordCount = virtual.day_records + rows.length;
    if (recordCount > day.expected_records) throw new Error("V11_PROJECTION_SOURCE_INCOMPLETE");
    const last = rows.at(-1)!;
    const revision = virtual.revision + 1;
    const stepDigest = await sha256Hex(canonicalJson({ eventDigest: change.eventDigest, revision,
      day: virtual.next_day, afterStream: last.stream, afterOccurrence: last.occurrence_id,
      recordCount, completeDay: false, valueKey: options.identity.value_key, pageDigest, values }));
    const valuesJson = canonicalJson(values);
    plans.push({ revision, stepDigest, pageIndex: virtual.day_records / PAGE_SIZE, pageDigest,
      pageJson, afterStream: last.stream, afterOccurrence: last.occurrence_id, recordCount, valuesJson });
    virtual = { ...virtual, revision, after_stream: last.stream, after_occurrence: last.occurrence_id,
      day_records: recordCount, values_json: valuesJson };
  }
  if (plans.length === 0) return null;
  options.signal?.throwIfAborted();
  const current = await lookupV11StorageSource(source, change);
  if (current.disposition === "discard") {
    await discard(target, change, current);
    return { state: "discarded", sequence: change.sequence, recordsRead: plans.length * PAGE_SIZE };
  }
  validateAdmission(sourceId, change, current);
  if (canonicalJson(current) !== canonicalJson(input)) throw new Error("V11_PROJECTION_SOURCE_CONFLICT");
  validateWork(work, current, layout);
  if (Date.now() >= options.deadlineMs) throw new V11ProjectionDeadlineExceededError();
  const statements: D1PreparedStatement[] = [];
  for (const plan of plans) {
    statements.push(
      target.prepare(`INSERT INTO analytics_v11_projection_steps(source_id,event_digest,revision,step_digest)
        VALUES(?,?,?,?)`).bind(sourceId, change.eventDigest, plan.revision, plan.stepDigest),
      target.prepare(`INSERT INTO analytics_v11_value_pages
        (value_key,page_index,source_id,owner_digest,producer_event,day,record_count,page_digest,values_json)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(value_key,page_index) DO UPDATE SET
          record_count=excluded.record_count,page_digest=excluded.page_digest,values_json=excluded.values_json`)
        .bind(options.identity.value_key, plan.pageIndex, sourceId, change.ownerDigest, change.eventDigest,
          work.next_day, PAGE_SIZE, plan.pageDigest, plan.pageJson),
      target.prepare(`UPDATE analytics_v11_projection_work SET
        after_stream=?,after_occurrence=?,day_records=?,values_json=?,revision=revision+1
        WHERE source_id=? AND event_digest=? AND revision=? AND phase='building' AND next_day=?`)
        .bind(plan.afterStream, plan.afterOccurrence, plan.recordCount, plan.valuesJson,
          sourceId, change.eventDigest, plan.revision - 1, work.next_day),
    );
  }
  try {
    const results = await target.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length
        || results.some(result => result?.success !== true)
        || plans.some((_plan, index) => results[index * 3 + 2]?.meta?.changes !== 1)) {
      throw new Error("V11_PROJECTION_STEP_UNACKNOWLEDGED");
    }
  } catch {
    const receipts = await target.prepare(`SELECT revision,step_digest FROM analytics_v11_projection_steps
      WHERE source_id=? AND event_digest=? AND revision BETWEEN ? AND ? ORDER BY revision LIMIT ?`)
      .bind(sourceId, change.eventDigest, plans[0]!.revision, plans.at(-1)!.revision, plans.length + 1)
      .all<{ revision: number; step_digest: string }>();
    const exact = receipts.success === true && Array.isArray(receipts.results) && receipts.results.length === plans.length
      && receipts.results.every((receipt, index) => receipt.revision === plans[index]!.revision
        && receipt.step_digest === plans[index]!.stepDigest);
    if (!exact) {
      await applyAnalyticsChange(target, change, async () => { throw new Error("V11_PROJECTION_STEP_UNACKNOWLEDGED"); });
      return { state: "applied", sequence: change.sequence, recordsRead: plans.length * PAGE_SIZE };
    }
  }
  return { state: "building", sequence: change.sequence - 1, recordsRead: plans.length * PAGE_SIZE };
}

/** Internal format-dispatch seam. Its change and source proof must have been
 * read from the current source immediately before this call. They are checked
 * again after the record page and before any target write. */
export async function advanceAdmittedV11DailyProjection(options: {
  source: D1Database; target: D1Database; sourceId: string; change: StorageChange; input: SourceLookup;
  signal?: AbortSignal; sourceLayout?: V11ProjectionSourceLayout; maxPhysicalPages?: number; deadlineMs?: number;
}): Promise<V11DailyProjectionStep> {
  const { source, target, sourceId } = options;
  const change = Object.freeze(structuredClone(options.change)), input = Object.freeze(structuredClone(options.input));
  validateAdmission(sourceId, change, input);
  const maxPhysicalPages = options.maxPhysicalPages ?? 1;
  const deadlineMs = options.deadlineMs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxPhysicalPages) || maxPhysicalPages < 1 || maxPhysicalPages > MAX_PHYSICAL_PAGE_GROUP
      || !Number.isFinite(deadlineMs)) throw new Error("V11_PROJECTION_PAGE_LIMIT");
  const requested = options.sourceLayout;
  if (requested && requested.kind !== "typed-v11" && requested.kind !== "json-v11") {
    throw new Error("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
  }
  const layout: V11ProjectionSourceLayout = requested?.kind === "typed-v11"
    ? { kind: "typed-v11", sourceNamespace: requested.sourceNamespace } : { kind: "json-v11" };
  if (layout.kind === "typed-v11") encodeTypedTelemetryId(layout.sourceNamespace);
  options.signal?.throwIfAborted();
  if (input.disposition === "discard") {
    await discard(target, change, input);
    return { state: "discarded", sequence: change.sequence, recordsRead: 0 };
  }
  await validateSourceLayout(source, layout);
  const work = await initializeWork(target, change, input, layout);
  if (!work) return { state: "applied", sequence: change.sequence, recordsRead: 0 };
  if (work.phase === "ready") {
    const current = await lookupV11StorageSource(source, change);
    if (current.disposition === "discard") {
      await discard(target, change, current);
      return { state: "discarded", sequence: change.sequence, recordsRead: 0 };
    }
    validateWork(work, current, layout);
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
  const priorValues = foldV11DailyProjectionValues(JSON.parse(work.values_json) as Values, []);
  const cached = await reusableValue(target, identity, day.expected_records);
  if (!cached && layout.kind === "typed-v11" && maxPhysicalPages > 1) {
    const grouped = await advancePhysicalPageGroup({ source, target, sourceId, change, input, layout, work, day, identity,
      priorValues, maxPages: maxPhysicalPages, deadlineMs, signal: options.signal });
    if (grouped) return grouped;
  }
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
      await applyAnalyticsChange(target, change, async () => { throw new Error("V11_PROJECTION_STEP_UNACKNOWLEDGED"); });
      return { state: "applied", sequence: change.sequence, recordsRead: rows.length };
    }
  }
  return { state: "building", sequence: change.sequence - 1, recordsRead: rows.length,
    ...(completeDay ? { completedDay: work.next_day } : {}) };
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
  options.signal?.throwIfAborted();
  const cursor = await target.prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
    .bind(sourceId).first<{ sequence: number }>();
  const sequence = cursor?.sequence ?? 0;
  int(sequence);
  const change = (await readIngestionChanges(source, sourceId, sequence, 1))[0];
  if (!change) return { state: "idle", sequence, recordsRead: 0 };
  if (change.sequence !== sequence + 1) throw new Error("ANALYTICS_SOURCE_GAP");
  const input = await lookupV11StorageSource(source, change);
  return advanceAdmittedV11DailyProjection({...options,change,input});
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
}): Promise<{ state: "available" | "authority-unavailable" | "pricing-stale"; values: Values[] }> {
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
  const values: Values[] = []; let stale = false;
  for (const row of rows) {
    if (row.values_json === null) continue;
    const value = JSON.parse(row.values_json) as Values;
    const current = createV11DailyProjectionValues(fromDay);
    if (value.registrySha256 !== current.registrySha256 && /^[a-f0-9]{64}$/.test(value.registrySha256)) {
      // Validate the old closed arithmetic shape, then discard its pricing.
      // This temporary validation copy is never returned or persisted.
      validateV11DailyProjectionValues({...value,registrySha256:current.registrySha256});
      stale = true;
    } else values.push(foldV11DailyProjectionValues(value, []));
  }
  return stale ? {state:"pricing-stale",values:[]} : {state:"available",values};
}

/** Reprice one source-proven page of an already admitted generation. This
 * does not replay delivery, replace immutable projection values, or move the
 * admitted head. The daily owner cache persists the returned arithmetic and
 * cursor together using its existing compare-and-swap. */
export async function repriceV11ProjectedOwnerDayPage(options: {
  source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;
  ownerDigest:string;day:string;values:Values;cursor:string|null;
}):Promise<{values:Values;cursor:string;complete:boolean}|null> {
  const {source,target,sourceId,ownerDigest,day}=options;
  const empty=createV11DailyProjectionValues(day);
  if(!/^[a-f0-9]{64}$/.test(ownerDigest))throw new Error("STORAGE_DIGEST_INVALID");
  const pin=async()=>{
    const work=await target.prepare(`SELECT w.*,h.sequence AS selected_sequence,c.authority_epoch AS current_epoch
      FROM analytics_v11_owner_heads h
      JOIN analytics_v11_projection_work w ON w.source_id=h.source_id AND w.event_digest=h.event_digest
      JOIN analytics_owner_state o ON o.source_id=h.source_id AND o.owner_digest=h.owner_digest AND o.state='active'
      JOIN analytics_applied_events e ON e.source_id=h.source_id AND e.sequence=h.sequence AND e.revision=o.revision
      JOIN analytics_source_cursors c ON c.source_id=h.source_id
      WHERE h.source_id=? AND h.owner_digest=? AND w.phase='ready'`)
      .bind(sourceId,ownerDigest).first<Work&{selected_sequence:number;current_epoch:number}>();
    if(!work||day<work.from_day||day>work.through_day
      ||!await analyticsAuthorityIsCurrent(source,target,sourceId,work.current_epoch))return null;
    const change=(await readIngestionChanges(source,sourceId,work.selected_sequence-1,1))[0];
    if(!change||change.eventDigest!==work.event_digest||change.ownerDigest!==ownerDigest)return null;
    const generation=await lookupV11StorageSource(source,change);
    if(generation.disposition!=='generation')return null;
    const layout:V11ProjectionSourceLayout=work.source_layout==='typed-v11'
      ?{kind:'typed-v11',sourceNamespace:options.sourceNamespace}:{kind:'json-v11'};
    validateWork(work,generation,layout);
    const selected={...work,next_day:day};
    const metadata=await sourceDay(source,generation,selected);
    const identity=await sha256Hex(canonicalJson({generation,layout,metadata,day,
      registry:empty.registrySha256,method:empty.pricingMethodVersion}));
    return {work:selected,generation,layout,metadata,identity};
  };
  const initial=await pin();if(!initial)return null;
  let values=empty,afterStream='',afterOccurrence='',records=0;
  if(options.cursor!==null){
    const cursor=JSON.parse(options.cursor) as Record<string,unknown>;
    if(!cursor||Object.keys(cursor).sort().join(',')!=='afterOccurrence,afterStream,identity,method,records'
      ||cursor.method!=='v11-daily-reprice-v1'||typeof cursor.identity!=='string'||!/^[a-f0-9]{64}$/.test(cursor.identity)
      ||typeof cursor.afterStream!=='string'||!['quota','session','usage'].includes(cursor.afterStream)
      ||typeof cursor.afterOccurrence!=='string'||cursor.afterOccurrence.length<1||cursor.afterOccurrence.length>256
      ||!Number.isSafeInteger(cursor.records)||(cursor.records as number)<1)throw new Error('V11_REPRICE_CURSOR_INVALID');
    if(cursor.identity===initial.identity){
      validateV11DailyProjectionValues(options.values);
      if(options.values.day!==day||Object.values(options.values.counts).reduce((a,b)=>a+b,0)!==cursor.records)
        throw new Error('V11_REPRICE_CURSOR_INVALID');
      values=options.values;afterStream=cursor.afterStream;afterOccurrence=cursor.afterOccurrence;records=cursor.records as number;
    }
  }
  const rows=await sourcePage(source,initial.generation,{...initial.work,after_stream:afterStream,after_occurrence:afterOccurrence},initial.layout,initial.metadata);
  values=foldV11DailyProjectionValues(values,rows.map(row=>JSON.parse(row.record_json)));
  records+=rows.length;
  if(records>initial.metadata.expected_records||(rows.length<PAGE_SIZE&&records!==initial.metadata.expected_records))
    throw new Error('V11_PROJECTION_SOURCE_INCOMPLETE');
  const final=await pin();if(!final||canonicalJson(initial)!==canonicalJson(final))return null;
  const last=rows.at(-1);
  return {values,complete:records===initial.metadata.expected_records,
    cursor:canonicalJson({method:'v11-daily-reprice-v1',identity:initial.identity,
      afterStream:last?.stream??afterStream,afterOccurrence:last?.occurrence_id??afterOccurrence,records})};
}
