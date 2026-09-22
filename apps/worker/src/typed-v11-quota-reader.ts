import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { V11_DOMAIN_METHOD_VERSION, type V11SourcePin } from "./telemetry-v11-domain";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";

/** The physical page bounds both the normalized joins and the decoder work
 * that a single resumable acquisition step can perform, and one page is the
 * unit of D1 round trip a 100-day owner window is charged in. The densest
 * observed owner holds 2,212,776 rows in that window, which the acquisition
 * reads once per sub-phase, so the page size is the dominant throughput term.
 *
 * The bound is the 128 MiB isolate. One row of this page costs 2,415 bytes of
 * retained heap at the peak of `readPage`, where the raw D1 result row and the
 * decoded row are both live across `rows.map` (measured over the exact shapes
 * `decodeRow` produces; the decoded row alone is 983 bytes once the raw rows
 * are released). `V11_QUOTA_PAGE_SIZE_BUDGET` below states that arithmetic so it
 * can be proven rather than asserted:
 *
 *   16,384 rows x 2,415 B  =  37.7 MiB transient page peak
 *   worst-case in-memory acquisition checkpoint (60,000 interned endpoints,
 *     the `maxQuotaRows` cap)                 =  22.3 MiB
 *   worker module/runtime baseline (allowed)  =  15.0 MiB
 *   page read peak                            =  75.0 MiB   (53 MiB spare)
 *
 * The checkpoint save peak is unaffected by this constant and already exceeds
 * the page read peak: the page is released before `storageHistoryCheckpointParts`
 * frames the successor, and that frame is 43.5 MiB for the same 60,000-endpoint
 * checkpoint, so 22.3 + 43.5 + 15.0 = 80.8 MiB. Raising the page to 16,384
 * therefore does not become the binding memory constraint. The next power of
 * two would: 32,768 rows is a 75.3 MiB page peak, 112.6 MiB in total, which
 * leaves 12% of the isolate and no room for an unusual row.
 *
 * This constant is deliberately absent from every acquisition identity,
 * checkpoint key and dependency digest. A page cursor is a position in a
 * totally ordered owner stream and end-of-input is a short page, so a
 * checkpoint staged under any page size resumes correctly under any other. */
export const TYPED_V11_QUOTA_PAGE_SIZE = 16_384;

/** The measured terms behind the page size above, exported so the budget is a
 * checked arithmetic statement instead of a comment. Bytes are retained heap.
 * `pageRowBytes` was measured over a realistic page built through the exact
 * shapes `decodeRow` returns, with the raw D1 rows still live. */
export const V11_QUOTA_PAGE_SIZE_BUDGET = Object.freeze({
  isolateBytes: 128 * 1024 * 1024,
  pageRowBytes: 2_415,
  checkpointBytes: 22.3 * 1024 * 1024,
  checkpointFrameBytes: 43.5 * 1024 * 1024,
  runtimeBaselineBytes: 15 * 1024 * 1024,
});
const MIN_TIME = -8_640_000_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;

export interface V11QuotaPageCursor {
  observedAtMs: number;
  sourceRowId: number;
}

/**
 * The immutable identity of one admitted v1.1 domain. The input revision and
 * fingerprint are the values captured with the source pin; they deliberately
 * are not compared with the current revision when this identity is resumed.
 * The generation/domain rows and retained source journal are the authority for
 * the physical records, while the fingerprint binds this closed identity to
 * the original source-pin method.
 */
export interface V11GenerationSnapshot {
  readonly source: "v1.1";
  readonly sourceNamespace: string;
  readonly participantId: string;
  readonly generationId: string;
  readonly deviceId: string;
  readonly manifestDigest: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly inputRevision: number;
  readonly fingerprint: string;
}

export interface V11QuotaSourceRow {
  id: number;
  observedAtMs: number;
  observedAt: string;
  observedDay: string;
  deviceId: string;
  provider: string | null;
  limitId: string | null;
  planType: string | null;
  planVariant: string | null;
  accountBasis: "unavailable" | "same_source" | "provisional_marker" | null;
  accountTrackId: string | null;
  planBasis: "unavailable" | "same_source_occurrence" | "provisional_marker" | "conflicted" | null;
  planEraId: string | null;
  occurrenceId: string;
  slot: string | null;
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAtMs: number | null;
  resetsAt: string | null;
}

/** A page advances over raw owner rows. Rows belonging to a retired generation
 * are retained as empty entries so a page cannot mistake an old prefix for
 * end-of-input. The active join is a normalized equivalent of the maintained
 * typed_v11_active_records view, with the page CTE forced to be outermost. */
export interface V11QuotaPageRow {
  physicalId: number;
  sourceRowId: number;
  observedAtMs: number;
  active: V11QuotaSourceRow | null;
}

export const TYPED_V11_QUOTA_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT r.id AS physical_id,r.source_row_id,r.observed_at_ms,r.device_id,r.provider_id
  FROM typed_telemetry_records r INDEXED BY typed_telemetry_owner_time
  WHERE r.namespace_id=?1 AND r.owner_id=?2 AND r.format=11 AND r.stream=2
    AND r.observed_at_ms>=?3 AND r.observed_at_ms<?4
    AND (r.observed_at_ms,r.source_row_id)>(?5,?6)
  ORDER BY r.observed_at_ms,r.source_row_id LIMIT ?7
), active AS MATERIALIZED (
  SELECT page.physical_id,page.source_row_id,page.observed_at_ms,
    p.occurrence_id AS active_occurrence_id,p.observed_at_ms AS proof_observed_at_ms,
    d.observed_day,g.device_id,provider.value AS provider,
    plan.value AS plan_type,variant.value AS plan_variant,
    lim.value AS limit_id,slot.value AS slot,q.used_percent,
    q.window_duration_minutes,q.resets_at_ms,
    a.account_basis,a.account_track,a.plan_basis,ap.value AS attribution_plan_type,
    a.plan_era
  FROM page
  CROSS JOIN typed_v11_record_proofs p
    ON p.typed_record_id=page.physical_id AND p.stream_code=2
  JOIN typed_v11_manifest_memberships mm ON mm.typed_manifest_id=p.manifest_key
  JOIN telemetry_v11_domain_days d ON d.manifest_id=mm.manifest_id
  JOIN telemetry_v11_domains g ON g.id=d.generation_id
    AND g.id=?8 AND g.participant_id=?9
  JOIN telemetry_v11_domain_heads h ON h.generation_id=g.id
    AND h.participant_id=g.participant_id
  JOIN typed_telemetry_devices current_device ON current_device.id=page.device_id
    AND current_device.namespace_id=?10 AND current_device.owner_id=?2
    AND current_device.original_id=?12
  JOIN typed_v11_admission_state s ON s.id=1 AND s.runtime_contract_version=1
    AND s.namespace_id=?10 AND s.source_namespace=?11
  JOIN typed_telemetry_quota q ON q.record_id=page.physical_id
  JOIN typed_telemetry_quota_dimensions qd ON qd.id=q.dimensions_id
  JOIN typed_telemetry_dictionary provider ON provider.id=page.provider_id
  JOIN typed_telemetry_dictionary plan ON plan.id=qd.plan_type_id
  JOIN typed_telemetry_dictionary variant ON variant.id=qd.plan_variant_id
  JOIN typed_telemetry_dictionary lim ON lim.id=q.limit_id
  JOIN typed_telemetry_dictionary slot ON slot.id=q.slot_id
  JOIN typed_telemetry_attributions a ON a.id=qd.attribution_id
  JOIN typed_telemetry_dictionary ap ON ap.id=a.plan_type_id
)
SELECT page.physical_id,page.source_row_id,page.observed_at_ms,
  active.active_occurrence_id,active.proof_observed_at_ms,active.observed_day,
  active.device_id,active.provider,active.plan_type,active.plan_variant,
  active.limit_id,active.slot,active.used_percent,active.window_duration_minutes,
  active.resets_at_ms,active.account_basis,active.account_track,
  active.plan_basis,active.attribution_plan_type,active.plan_era
FROM page LEFT JOIN active ON active.physical_id=page.physical_id
ORDER BY page.observed_at_ms,page.source_row_id`;

/** Retained pages keep the proven owner-time physical driver and apply exact
 * generation membership as a residual. Starting from all generation manifests
 * makes SQLite sort/revisit the retained corpus for every cursor page. */
export const TYPED_V11_QUOTA_SNAPSHOT_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT raw.id AS physical_id,raw.source_row_id,raw.observed_at_ms,raw.device_id,raw.provider_id
  FROM typed_telemetry_records raw INDEXED BY typed_telemetry_owner_time
  WHERE raw.namespace_id=?1 AND raw.owner_id=?2 AND raw.format=11 AND raw.stream=2
    AND raw.observed_at_ms>=?3 AND raw.observed_at_ms<?4
    AND (raw.observed_at_ms,raw.source_row_id)>(?5,?6)
  ORDER BY raw.observed_at_ms,raw.source_row_id LIMIT ?7
), active AS MATERIALIZED (
  SELECT page.physical_id,page.source_row_id,page.observed_at_ms,
    proof.occurrence_id AS active_occurrence_id,proof.observed_at_ms AS proof_observed_at_ms,
    domain_day.observed_day,g.device_id,provider.value AS provider,
    plan.value AS plan_type,variant.value AS plan_variant,
    lim.value AS limit_id,slot.value AS slot,q.used_percent,
    q.window_duration_minutes,q.resets_at_ms,
    attribution.account_basis,attribution.account_track,attribution.plan_basis,
    attribution_plan.value AS attribution_plan_type,attribution.plan_era
  FROM page
  CROSS JOIN typed_v11_record_proofs proof
    ON proof.typed_record_id=page.physical_id AND proof.stream_code=2
  JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id=proof.manifest_key
  JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=membership.manifest_id
    AND domain_day.generation_id=?8
  JOIN telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id
    AND manifest.participant_id=?9 AND manifest.chunk_day=domain_day.observed_day AND manifest.state='ready'
  JOIN telemetry_v11_domains g ON g.id=domain_day.generation_id AND g.participant_id=?9
    AND g.manifest_digest=?13 AND g.from_day=?14 AND g.through_day=?15
  JOIN typed_telemetry_devices current_device ON current_device.id=page.device_id
    AND current_device.namespace_id=?10 AND current_device.owner_id=?2
    AND current_device.original_id=?12
  JOIN typed_v11_admission_state admission ON admission.id=1 AND admission.runtime_contract_version=1
    AND admission.namespace_id=?10 AND admission.source_namespace=?11
  JOIN typed_telemetry_quota q ON q.record_id=page.physical_id
  JOIN typed_telemetry_quota_dimensions dimensions ON dimensions.id=q.dimensions_id
  JOIN typed_telemetry_dictionary provider ON provider.id=page.provider_id
  JOIN typed_telemetry_dictionary plan ON plan.id=dimensions.plan_type_id
  JOIN typed_telemetry_dictionary variant ON variant.id=dimensions.plan_variant_id
  JOIN typed_telemetry_dictionary lim ON lim.id=q.limit_id
  JOIN typed_telemetry_dictionary slot ON slot.id=q.slot_id
  JOIN typed_telemetry_attributions attribution ON attribution.id=dimensions.attribution_id
  JOIN typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id
)
SELECT page.physical_id,page.source_row_id,page.observed_at_ms,
  active.active_occurrence_id,active.proof_observed_at_ms,active.observed_day,
  active.device_id,active.provider,active.plan_type,active.plan_variant,
  active.limit_id,active.slot,active.used_percent,active.window_duration_minutes,
  active.resets_at_ms,active.account_basis,active.account_track,
  active.plan_basis,active.attribution_plan_type,active.plan_era
FROM page LEFT JOIN active ON active.physical_id=page.physical_id
ORDER BY page.observed_at_ms,page.source_row_id`;

interface ReaderScope {
  sourceNamespace: string;
  namespaceId: number;
  ownerId: number;
  participantId: string;
  generationId: string;
  deviceId: string;
  deviceIdBlob: ArrayBuffer;
  snapshot: V11GenerationSnapshot;
}

interface ScopeMetadataRow {
  namespace_id: number;
  source_namespace: string;
  typed_owner_id: number;
  generation_id: string;
  device_id: string;
  manifest_digest: string;
  from_day: string;
  through_day: string;
}

interface RawRow extends Record<string, unknown> {
  physical_id: number;
  source_row_id: number;
  observed_at_ms: number;
  device_id: string | null;
  active_occurrence_id: string | null;
  proof_observed_at_ms: number | null;
  observed_day: string | null;
  provider: string | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at_ms: number | null;
  account_basis: number | null;
  account_track: ArrayBuffer | Uint8Array | number[] | null;
  plan_basis: number | null;
  attribution_plan_type: string | null;
  plan_era: ArrayBuffer | Uint8Array | number[] | null;
}

function fail(): never { throw new Error("TYPED_V11_QUOTA_READER_UNAVAILABLE"); }

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function nullableTime(value: unknown): number | null {
  return value === null ? null : integer(value, MIN_TIME, MAX_TIME);
}

function nullableWindow(value: unknown): number | null {
  return value === null ? null : integer(value, 1, 527_040);
}

function percentage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) fail();
  return value;
}

function bytes(value: ArrayBuffer | Uint8Array | number[] | null): Uint8Array | null {
  if (value === null) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value);
  }
  fail();
}

function decoded(value: ArrayBuffer | Uint8Array | number[] | null): string | null {
  const raw = bytes(value);
  return raw === null || raw.length === 0 ? null : decodeTypedTelemetryId(raw);
}

function iso(value: number): string {
  integer(value, MIN_TIME, MAX_TIME);
  try { return new Date(value).toISOString(); } catch { return fail(); }
}

function accountBasis(value: unknown): V11QuotaSourceRow["accountBasis"] {
  if (value === null) return null;
  if (value === 0) return "unavailable";
  if (value === 1) return "same_source";
  if (value === 2) return "provisional_marker";
  return fail();
}

function planBasis(value: unknown): V11QuotaSourceRow["planBasis"] {
  if (value === null) return null;
  if (value === 0) return "unavailable";
  if (value === 1) return "same_source_occurrence";
  if (value === 2) return "provisional_marker";
  if (value === 3) return "conflicted";
  return fail();
}

function limitPage(value: unknown): number {
  return integer(value, 1, TYPED_V11_QUOTA_PAGE_SIZE);
}

function cursor(value: V11QuotaPageCursor): void {
  if (!value || Object.keys(value).sort().join(",") !== "observedAtMs,sourceRowId") fail();
  integer(value.observedAtMs, MIN_TIME, MAX_TIME);
  integer(value.sourceRowId, 0, Number.MAX_SAFE_INTEGER);
}

function utcDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function isV11GenerationSnapshot(value: unknown): value is V11GenerationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).sort().join(",") !==
      "deviceId,fingerprint,fromDay,generationId,inputRevision,manifestDigest,participantId,source,sourceNamespace,throughDay") {
    return false;
  }
  if (snapshot.source !== "v1.1"
      || [snapshot.sourceNamespace, snapshot.participantId, snapshot.generationId, snapshot.deviceId,
        snapshot.manifestDigest, snapshot.fingerprint].some(value => typeof value !== "string" || value.length === 0)
      || !/^[a-f0-9]{64}$/u.test(snapshot.manifestDigest as string)
      || !/^[a-f0-9]{64}$/u.test(snapshot.fingerprint as string)
      || !utcDay(snapshot.fromDay) || !utcDay(snapshot.throughDay)
      || (snapshot.fromDay as string) > (snapshot.throughDay as string)
      || typeof snapshot.inputRevision !== "number"
      || !Number.isSafeInteger(snapshot.inputRevision) || snapshot.inputRevision < 0) return false;
  try {
    encodeTypedTelemetryId(snapshot.sourceNamespace as string);
    encodeTypedTelemetryId(snapshot.participantId as string);
    encodeTypedTelemetryId(snapshot.generationId as string);
    encodeTypedTelemetryId(snapshot.deviceId as string);
  } catch { return false; }
  return true;
}

async function normalizeSnapshot(value: unknown, sourceNamespace: string): Promise<V11GenerationSnapshot> {
  if (!isV11GenerationSnapshot(value) || value.sourceNamespace !== sourceNamespace) fail();
  const expectedFingerprint = await sha256Hex(canonicalJson({
    method: V11_DOMAIN_METHOD_VERSION,
    participantId: value.participantId,
    generationId: value.generationId,
    manifestDigest: value.manifestDigest,
    fromDay: value.fromDay,
    throughDay: value.throughDay,
    inputRevision: value.inputRevision,
  }));
  if (expectedFingerprint !== value.fingerprint) fail();
  return Object.freeze({ ...value });
}

async function snapshotFromPin(sourceNamespace: string, pin: V11SourcePin, row: ScopeMetadataRow): Promise<V11GenerationSnapshot> {
  if (row.source_namespace !== sourceNamespace || row.generation_id !== pin.generationId
      || row.device_id.length === 0 || row.manifest_digest.length !== 64
      || row.from_day !== pin.fromDay || row.through_day !== pin.throughDay) fail();
  return normalizeSnapshot({
    source: "v1.1", sourceNamespace, participantId: pin.participantId,
    generationId: pin.generationId, deviceId: row.device_id,
    manifestDigest: row.manifest_digest, fromDay: row.from_day, throughDay: row.through_day,
    inputRevision: pin.inputRevision, fingerprint: pin.fingerprint,
  }, sourceNamespace);
}

async function scopeFor(db: D1Database, sourceNamespace: string, pin: V11SourcePin): Promise<ReaderScope> {
  encodeTypedTelemetryId(sourceNamespace);
  const row = await db.prepare(`SELECT s.namespace_id,s.source_namespace,
      o.typed_owner_id,h.generation_id,g.device_id,g.manifest_digest,g.from_day,g.through_day
    FROM typed_v11_admission_state s
    JOIN typed_v11_owner_memberships o ON o.participant_id=?1
    JOIN typed_telemetry_owners owner ON owner.id=o.typed_owner_id AND owner.namespace_id=s.namespace_id
    JOIN telemetry_v11_domain_heads h ON h.participant_id=?1 AND h.generation_id=?2
    JOIN telemetry_v11_domains g ON g.id=h.generation_id AND g.participant_id=h.participant_id
    JOIN participants participant ON participant.id=g.participant_id AND participant.state='active'
    JOIN device_credentials generation_device ON generation_device.id=g.device_id
      AND generation_device.participant_id=g.participant_id AND generation_device.state='active'
    WHERE s.id=1 AND s.runtime_contract_version=1 AND s.source_namespace=?3`)
    .bind(pin.participantId, pin.generationId, sourceNamespace)
    .first<ScopeMetadataRow>();
  if (!row || row.source_namespace !== sourceNamespace || row.generation_id !== pin.generationId
      || typeof row.device_id !== "string" || row.device_id.length === 0) fail();
  const snapshot = await snapshotFromPin(sourceNamespace, pin, row);
  const deviceIdBlob = Uint8Array.from(encodeTypedTelemetryId(row.device_id)).buffer;
  return { sourceNamespace, namespaceId: integer(row.namespace_id, 1, Number.MAX_SAFE_INTEGER),
    ownerId: integer(row.typed_owner_id, 1, Number.MAX_SAFE_INTEGER),
    participantId: pin.participantId, generationId: pin.generationId,
    deviceId: row.device_id, deviceIdBlob, snapshot };
}

async function scopeForSnapshot(db: D1Database, sourceNamespace: string, value: unknown): Promise<ReaderScope> {
  const snapshot = await normalizeSnapshot(value, sourceNamespace);
  const row = await db.prepare(`SELECT s.namespace_id,s.source_namespace,
      o.typed_owner_id,g.id AS generation_id,g.device_id,g.manifest_digest,g.from_day,g.through_day
    FROM typed_v11_admission_state s
    JOIN typed_v11_owner_memberships o ON o.participant_id=?2
    JOIN typed_telemetry_owners owner ON owner.id=o.typed_owner_id
      AND owner.namespace_id=s.namespace_id
    JOIN telemetry_v11_domains g ON g.id=?3 AND g.participant_id=?2
      AND g.device_id=?4 AND g.manifest_digest=?5 AND g.from_day=?6 AND g.through_day=?7
    JOIN participants participant ON participant.id=g.participant_id AND participant.state='active'
    JOIN device_credentials generation_device ON generation_device.id=g.device_id
      AND generation_device.participant_id=g.participant_id AND generation_device.state='active'
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=g.participant_id
      AND owner_link.state='active'
    JOIN storage_owner_revisions owner_revision ON owner_revision.owner_digest=owner_link.owner_digest
      AND owner_revision.state='active'
    WHERE s.id=1 AND s.runtime_contract_version=1 AND s.source_namespace=?1
      AND EXISTS (SELECT 1 FROM storage_v11_event_sources retained_source
        WHERE retained_source.owner_digest=owner_link.owner_digest
          AND retained_source.participant_id=g.participant_id
          AND retained_source.generation_id=g.id)`)
    .bind(sourceNamespace, snapshot.participantId, snapshot.generationId, snapshot.deviceId,
      snapshot.manifestDigest, snapshot.fromDay, snapshot.throughDay)
    .first<ScopeMetadataRow>();
  if (!row || row.source_namespace !== sourceNamespace || row.generation_id !== snapshot.generationId
      || row.device_id !== snapshot.deviceId || row.manifest_digest !== snapshot.manifestDigest
      || row.from_day !== snapshot.fromDay || row.through_day !== snapshot.throughDay) fail();
  return { sourceNamespace, namespaceId: integer(row.namespace_id, 1, Number.MAX_SAFE_INTEGER),
    ownerId: integer(row.typed_owner_id, 1, Number.MAX_SAFE_INTEGER),
    participantId: snapshot.participantId, generationId: snapshot.generationId,
    deviceId: snapshot.deviceId, deviceIdBlob: Uint8Array.from(encodeTypedTelemetryId(snapshot.deviceId)).buffer,
    snapshot };
}

/** Recheck only live authority/retention state for a retained generation. */
export async function assertTypedV11GenerationSnapshotLive(
  db: D1Database, snapshot: V11GenerationSnapshot,
): Promise<void> {
  const normalized = await normalizeSnapshot(snapshot, snapshot.sourceNamespace);
  const row = await db.prepare(`SELECT 1 AS live
    FROM typed_v11_admission_state s
    JOIN telemetry_v11_domains g ON g.id=?2 AND g.participant_id=?3
      AND g.device_id=?4 AND g.manifest_digest=?5 AND g.from_day=?6 AND g.through_day=?7
    JOIN participants participant ON participant.id=g.participant_id AND participant.state='active'
    JOIN device_credentials generation_device ON generation_device.id=g.device_id
      AND generation_device.participant_id=g.participant_id AND generation_device.state='active'
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=g.participant_id
      AND owner_link.state='active'
    JOIN storage_owner_revisions owner_revision ON owner_revision.owner_digest=owner_link.owner_digest
      AND owner_revision.state='active'
    WHERE s.id=1 AND s.runtime_contract_version=1 AND s.source_namespace=?1
      AND EXISTS (SELECT 1 FROM storage_v11_event_sources retained_source
        WHERE retained_source.owner_digest=owner_link.owner_digest
          AND retained_source.participant_id=g.participant_id
          AND retained_source.generation_id=g.id)`)
    .bind(normalized.sourceNamespace, normalized.generationId, normalized.participantId, normalized.deviceId,
      normalized.manifestDigest, normalized.fromDay, normalized.throughDay)
    .first<{live: number}>();
  if (!row || row.live !== 1) fail();
}

/** Capture a current source pin as a closed identity that can be resumed after
 * a successor head is activated. The capture remains current-head strict. */
export async function loadTypedV11GenerationSnapshot(
  db: D1Database, options: {sourceNamespace: string; pin: V11SourcePin},
): Promise<V11GenerationSnapshot> {
  const scope = await scopeFor(db, options.sourceNamespace, options.pin);
  await scopeForSnapshot(db, options.sourceNamespace, scope.snapshot);
  return scope.snapshot;
}

function decodeRow(row: RawRow, scope: ReaderScope): V11QuotaPageRow {
  const physicalId = integer(row.physical_id, 1, Number.MAX_SAFE_INTEGER);
  const sourceRowId = integer(row.source_row_id, 1, Number.MAX_SAFE_INTEGER);
  const observedAtMs = integer(row.observed_at_ms, MIN_TIME, MAX_TIME);
  if (row.active_occurrence_id === null) return { physicalId, sourceRowId, observedAtMs, active: null };
  if (row.proof_observed_at_ms !== observedAtMs || row.observed_day === null || row.device_id === null
      || row.device_id !== scope.deviceId
      || row.provider === null || row.active_occurrence_id.length < 8
      || row.active_occurrence_id !== text(row.active_occurrence_id)) fail();
  const observedAt = iso(observedAtMs);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.observed_day)
      || row.observed_day !== observedAt.slice(0, 10)) fail();
  const resetsAtMs = nullableTime(row.resets_at_ms);
  const resetsAt = resetsAtMs === null ? null : iso(resetsAtMs);
  const track = decoded(row.account_track);
  const era = decoded(row.plan_era);
  const basis = accountBasis(row.account_basis);
  if (basis === "unavailable" && track !== null) fail();
  if (basis !== null && basis !== "unavailable" && track === null) fail();
  return { physicalId, sourceRowId, observedAtMs, active: {
    id: sourceRowId, observedAtMs, observedAt, observedDay: text(row.observed_day),
    deviceId: text(row.device_id), provider: nullableText(row.provider), limitId: nullableText(row.limit_id),
    planType: nullableText(row.plan_type), planVariant: nullableText(row.plan_variant), accountBasis: basis,
    accountTrackId: track, planBasis: planBasis(row.plan_basis), planEraId: era,
    occurrenceId: text(row.active_occurrence_id), slot: nullableText(row.slot),
    usedPercent: row.used_percent === null ? null : percentage(row.used_percent),
    windowDurationMinutes: nullableWindow(row.window_duration_minutes),
    resetsAtMs, resetsAt,
  }};
}

/** Resolve the active typed owner once, then spend exactly one bounded query
 * per page. The caller supplies the source pin and fences it before and after
 * acquisition; current pages use one bounded query, while retained pages
 * recheck the live fence before their exact-generation query. This reader
 * never elects a domain or falls back to JSON. */
export async function createTypedV11QuotaPageReader(db: D1Database, options: {
  sourceNamespace: string;
  pin?: V11SourcePin;
  snapshot?: V11GenerationSnapshot;
  /** Graph groups fence the immutable snapshot once before and after the whole
   * bounded group; direct callers retain the per-page fence by default. */
  fenceSnapshotPages?: boolean;
  fromObservedAtMs: number;
  beforeObservedAtMs: number;
}): Promise<{
  readonly pageSize: typeof TYPED_V11_QUOTA_PAGE_SIZE;
  readonly scope: Readonly<ReaderScope>;
  readonly snapshot: V11GenerationSnapshot;
  readPage(cursor: V11QuotaPageCursor, limit?: number): Promise<V11QuotaPageRow[]>;
}> {
  const from = integer(options.fromObservedAtMs, MIN_TIME, MAX_TIME);
  const before = integer(options.beforeObservedAtMs, MIN_TIME, MAX_TIME + 1);
  if (before <= from) fail();
  if (options.pin !== undefined && options.snapshot !== undefined) fail();
  const retained = options.snapshot !== undefined;
  if (!retained && options.pin === undefined) fail();
  const scope = retained
    ? await scopeForSnapshot(db, options.sourceNamespace, options.snapshot)
    : await scopeFor(db, options.sourceNamespace, options.pin!);
  return {
    pageSize: TYPED_V11_QUOTA_PAGE_SIZE,
    scope,
    snapshot: scope.snapshot,
    async readPage(after: V11QuotaPageCursor, limit = TYPED_V11_QUOTA_PAGE_SIZE) {
      cursor(after);
      const pageLimit = limitPage(limit);
      if (retained && options.fenceSnapshotPages !== false) await assertTypedV11GenerationSnapshotLive(db, scope.snapshot);
      const statement = db.prepare(retained ? TYPED_V11_QUOTA_SNAPSHOT_PAGE_SQL : TYPED_V11_QUOTA_PAGE_SQL);
      const rows = (await (retained
        ? statement.bind(
          scope.namespaceId, scope.ownerId, from, before, after.observedAtMs, after.sourceRowId, pageLimit,
          scope.generationId, scope.participantId, scope.namespaceId, scope.sourceNamespace, scope.deviceIdBlob,
          scope.snapshot.manifestDigest, scope.snapshot.fromDay, scope.snapshot.throughDay,
        )
        : statement.bind(
          scope.namespaceId, scope.ownerId, from, before, after.observedAtMs, after.sourceRowId, pageLimit,
          scope.generationId, scope.participantId, scope.namespaceId, scope.sourceNamespace, scope.deviceIdBlob,
        )).all<RawRow>()).results;
      if (rows.length > pageLimit) fail();
      let previous: V11QuotaPageCursor = after;
      return rows.map((row) => {
        const value = decodeRow(row, scope);
        if (value.observedAtMs < previous.observedAtMs
            || value.observedAtMs === previous.observedAtMs && value.sourceRowId <= previous.sourceRowId) fail();
        previous = { observedAtMs: value.observedAtMs, sourceRowId: value.sourceRowId };
        return value;
      });
    },
  };
}
