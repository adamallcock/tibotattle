import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "./typed-telemetry-codec";
import type { V11SourcePin } from "./telemetry-v11-domain";

/** The physical page is deliberately smaller than the compatibility reader's
 * public page. It bounds both the normalized joins and the decoder work that a
 * single resumable acquisition step can perform. */
export const TYPED_V11_QUOTA_PAGE_SIZE = 1024;
const MIN_TIME = -8_640_000_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;

export interface V11QuotaPageCursor {
  observedAtMs: number;
  sourceRowId: number;
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

interface ReaderScope {
  sourceNamespace: string;
  namespaceId: number;
  ownerId: number;
  participantId: string;
  generationId: string;
  deviceId: string;
  deviceIdBlob: ArrayBuffer;
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

async function scopeFor(db: D1Database, sourceNamespace: string, pin: V11SourcePin): Promise<ReaderScope> {
  encodeTypedTelemetryId(sourceNamespace);
  const row = await db.prepare(`SELECT s.namespace_id,s.source_namespace,
      o.typed_owner_id,h.generation_id,g.device_id
    FROM typed_v11_admission_state s
    JOIN typed_v11_owner_memberships o ON o.participant_id=?1
    JOIN typed_telemetry_owners owner ON owner.id=o.typed_owner_id AND owner.namespace_id=s.namespace_id
    JOIN telemetry_v11_domain_heads h ON h.participant_id=?1 AND h.generation_id=?2
    JOIN telemetry_v11_domains g ON g.id=h.generation_id AND g.participant_id=h.participant_id
    WHERE s.id=1 AND s.runtime_contract_version=1 AND s.source_namespace=?3`)
    .bind(pin.participantId, pin.generationId, sourceNamespace)
    .first<{namespace_id: number; source_namespace: string; typed_owner_id: number; generation_id: string; device_id: string}>();
  if (!row || row.source_namespace !== sourceNamespace || row.generation_id !== pin.generationId
      || typeof row.device_id !== "string" || row.device_id.length === 0) fail();
  const deviceIdBlob = Uint8Array.from(encodeTypedTelemetryId(row.device_id)).buffer;
  return { sourceNamespace, namespaceId: integer(row.namespace_id, 1, Number.MAX_SAFE_INTEGER),
    ownerId: integer(row.typed_owner_id, 1, Number.MAX_SAFE_INTEGER),
    participantId: pin.participantId, generationId: pin.generationId,
    deviceId: row.device_id, deviceIdBlob };
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
 * acquisition; this reader never elects a domain or falls back to JSON. */
export async function createTypedV11QuotaPageReader(db: D1Database, options: {
  sourceNamespace: string;
  pin: V11SourcePin;
  fromObservedAtMs: number;
  beforeObservedAtMs: number;
}): Promise<{
  readonly pageSize: typeof TYPED_V11_QUOTA_PAGE_SIZE;
  readonly scope: Readonly<ReaderScope>;
  readPage(cursor: V11QuotaPageCursor, limit?: number): Promise<V11QuotaPageRow[]>;
}> {
  const from = integer(options.fromObservedAtMs, MIN_TIME, MAX_TIME);
  const before = integer(options.beforeObservedAtMs, MIN_TIME, MAX_TIME + 1);
  if (before <= from) fail();
  const scope = await scopeFor(db, options.sourceNamespace, options.pin);
  return {
    pageSize: TYPED_V11_QUOTA_PAGE_SIZE,
    scope,
    async readPage(after: V11QuotaPageCursor, limit = TYPED_V11_QUOTA_PAGE_SIZE) {
      cursor(after);
      const pageLimit = limitPage(limit);
      const rows = (await db.prepare(TYPED_V11_QUOTA_PAGE_SQL).bind(
        scope.namespaceId, scope.ownerId, from, before, after.observedAtMs, after.sourceRowId, pageLimit,
        scope.generationId, scope.participantId, scope.namespaceId, scope.sourceNamespace, scope.deviceIdBlob,
      ).all<RawRow>()).results;
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
