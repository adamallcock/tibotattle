import { parseTelemetryV11Record, type TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import {
  GraphDayProjectionRefusedError, reduceGraphDayProjection, type GraphDayQuotaInput,
} from './graph-day-projection';
import {
  validGraphDayLabel, validGraphDayProjection, type GraphDayProjection,
} from './graph-day-projection-values';
import {
  closed, safeTime, validPlanAnchor, validQuotaRow,
} from './quota-analysis-v11-contract';
import {
  foldV11QuotaAcquisition, v11PreparedDayRow,
  type V11QuotaAcquisitionIdentity, type V11QuotaAcquisitionStep,
} from './quota-analysis-v11-reader';
import { QUOTA_RESET_CLUSTER_LIMIT } from './quota-endpoint-collapse';
import type { EffectiveTelemetryOccurrence } from './telemetry-usage-effective-reader';
import type { V11QuotaPageRow } from './typed-v11-quota-reader';

/** Preparation is optional. A day above either bound stays on the paged path;
 * a preparation limit must never become an analytical refusal. */
export const EFFECTIVE_QUOTA_DAY_MAX_ROWS = 12_800;
export const EFFECTIVE_QUOTA_DAY_MAX_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;
const PROBE_ERA_KEY = JSON.stringify(['openai_codex|codex', null, 'pro', 'unknown', 0]);
const fail = () => new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');

export interface EffectiveQuotaDay {
  projection: GraphDayProjection;
  /** Every effective occurrence, including rows the quota mapper excludes. */
  quotaRowsRead: number;
}

/** A whole day's ordered inputs. A page boundary cannot close a plan tie or a
 * quota run, so pages are accumulated here before the shared day reducer runs. */
export interface EffectiveQuotaDayPending {
  day: string;
  quotaRowsRead: number;
  rows: GraphDayQuotaInput[];
}

function inDay(at: unknown, day: string): at is number {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return safeTime(at) && at >= start && at < start + DAY_MS;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validPreparedRow(value: unknown, day: string, ordinal: number): value is GraphDayQuotaInput {
  if (!closed(value, ['sourceRowId', 'observedAtMs', 'anchor', 'row'])
    || value.sourceRowId !== ordinal || !inDay(value.observedAtMs, day)) return false;
  if (value.anchor !== null && (!validPlanAnchor(value.anchor)
    || value.anchor.observedAtMs !== value.observedAtMs)) return false;
  if (value.row === null) return true;
  if (value.anchor === null || !closed(value.row, ['occurrence_id', 'observed_at', 'provider', 'account_scope_id', 'limit_id',
    'plan_type', 'plan_variant', 'continuity_id', 'plan_basis', 'slot', 'used_percent',
    'window_duration_minutes', 'resets_at'])
    || !validQuotaRow({ ...value.row, plan_era_key: PROBE_ERA_KEY })
    || Date.parse(value.row.observed_at as string) !== value.observedAtMs) return false;
  // The mapper derives the anchor and quota row from the same occurrence.
  if (value.anchor !== null) {
    const anchor = value.anchor;
    const row = value.row;
    if (anchor.contextKey !== `${row.provider as string}|${row.limit_id as string}`
      || anchor.accountScopeId !== row.account_scope_id || anchor.planType !== row.plan_type
      || anchor.planVariant !== row.plan_variant || anchor.continuityId !== row.continuity_id
      || anchor.planBasis !== row.plan_basis || anchor.conflicted !== (row.plan_basis === 'conflicted')) return false;
  }
  return true;
}

/** Closed validation is shared with the checkpoint codec: no raw source
 * records or additional fields may hitchhike in the durable pending day. */
export function validEffectiveQuotaDayPending(value: unknown): value is EffectiveQuotaDayPending {
  if (!closed(value, ['day', 'quotaRowsRead', 'rows']) || !validGraphDayLabel(value.day)
    || !Number.isSafeInteger(value.quotaRowsRead) || (value.quotaRowsRead as number) < 0
    || (value.quotaRowsRead as number) > EFFECTIVE_QUOTA_DAY_MAX_ROWS
    || !Array.isArray(value.rows) || value.rows.length !== value.quotaRowsRead) return false;
  let previous = -Infinity;
  for (const [index, row] of value.rows.entries()) {
    if (!validPreparedRow(row, value.day, index + 1) || row.observedAtMs < previous) return false;
    previous = row.observedAtMs;
  }
  return serializedBytes(value) <= EFFECTIVE_QUOTA_DAY_MAX_BYTES;
}

/** Validate a quota-only day and the raw count needed to reconstruct the
 * window-global ordinal. The shared projection validator does not constrain
 * quota times to its day because the v1.1 source reader supplies that fence. */
export function validEffectiveQuotaDay(value: unknown): value is EffectiveQuotaDay {
  if (!closed(value, ['projection', 'quotaRowsRead']) || !validGraphDayProjection(value.projection)
    || !Number.isSafeInteger(value.quotaRowsRead) || (value.quotaRowsRead as number) < 0
    || (value.quotaRowsRead as number) > EFFECTIVE_QUOTA_DAY_MAX_ROWS) return false;
  const { projection, quotaRowsRead } = value as unknown as EffectiveQuotaDay;
  return projection.usage.rowsRead === 0 && projection.usage.cells.length === 0
    && projection.usage.openers.length === 0 && projection.usage.sessions.length === 0
    && projection.planAnchors.anchors.length <= quotaRowsRead
    && projection.planAnchors.anchors.every((anchor) => inDay(anchor.observedAtMs, projection.day))
    && projection.runEndpoints.endpoints.every((row) => row.sourceRowId <= quotaRowsRead
      && inDay(row.observedAtMs, projection.day))
    && serializedBytes(value) <= EFFECTIVE_QUOTA_DAY_MAX_BYTES;
}

/** The effective reader already reconciled versions and attribution. Keep
 * exactly the mapping the paged effective acquisition consumes. */
export function mapEffectiveQuotaPageRow(row: EffectiveTelemetryOccurrence,
  day: string, ordinal: number): V11QuotaPageRow {
  if (row.stream !== 'quota' || row.status !== 'compatible' || row.recordJson === null
    || row.eventTime === null || !validGraphDayLabel(day)
    || !Number.isSafeInteger(ordinal) || ordinal <= 0) throw fail();
  return mapEffectiveQuotaRecord(row, day, ordinal,
    parseTelemetryV11Record('quota', JSON.parse(row.recordJson)));
}

/** Use the shared page's validated record with the native effective mapping. */
export function mapEffectiveQuotaRecord(row: EffectiveTelemetryOccurrence,
  day: string, ordinal: number, value: TelemetryV11Record): V11QuotaPageRow {
  if (row.stream !== 'quota' || row.status !== 'compatible' || row.recordJson === null
    || row.eventTime === null || !validGraphDayLabel(day)
    || !Number.isSafeInteger(ordinal) || ordinal <= 0) throw fail();
  if (value.schemaVersion !== 'quota-observation-v1.1') throw fail();
  const at = Date.parse(row.eventTime), attribution = value.accountPlanAttribution;
  if (!inDay(at, day)) throw fail();
  return { physicalId: ordinal, sourceRowId: ordinal, observedAtMs: at,
    active: { id: ordinal, observedAtMs: at, observedAt: row.eventTime,
      observedDay: day, deviceId: 'effective-owner', provider: value.provider,
      limitId: value.limitId, planType: value.planType, planVariant: value.planVariant,
      accountBasis: attribution.accountBasis, accountTrackId: attribution.accountTrackId,
      planBasis: attribution.planBasis, planEraId: attribution.planEraId,
      occurrenceId: value.observationId, slot: value.slot, usedPercent: value.usedPercent,
      windowDurationMinutes: value.windowDurationMinutes, resetsAt: value.resetsAt,
      resetsAtMs: value.resetsAt === null ? null : Date.parse(value.resetsAt) } };
}

/** Append one complete occurrence page. IDs are day-local even when the
 * caller mapped this page for its simultaneous window-wide paged acquisition.
 * Null means optional preparation reached a bound, not that the day is empty. */
export function appendEffectiveQuotaDay(pending: EffectiveQuotaDayPending | null,
  day: string, pageRows: readonly V11QuotaPageRow[], windowMinutes: number): EffectiveQuotaDayPending | null {
  if (!validGraphDayLabel(day) || !Number.isSafeInteger(windowMinutes)
    || windowMinutes < 1 || windowMinutes > 527_040
    || pending !== null && (!validEffectiveQuotaDayPending(pending) || pending.day !== day)) throw fail();
  const count = (pending?.quotaRowsRead ?? 0) + pageRows.length;
  if (!Number.isSafeInteger(count) || count > EFFECTIVE_QUOTA_DAY_MAX_ROWS) return null;
  const rows = pending ? [...pending.rows] : [];
  let previous = rows.at(-1)?.observedAtMs ?? -Infinity;
  for (const pageRow of pageRows) {
    if (!inDay(pageRow.observedAtMs, day) || pageRow.observedAtMs < previous
      || !Number.isSafeInteger(pageRow.sourceRowId) || pageRow.sourceRowId <= 0
      || !Number.isSafeInteger(pageRow.physicalId) || pageRow.physicalId <= 0
      || pageRow.active !== null && (pageRow.active.id !== pageRow.sourceRowId
        || pageRow.active.observedAtMs !== pageRow.observedAtMs)) throw fail();
    const id = rows.length + 1;
    const local = { ...pageRow, physicalId: id, sourceRowId: id,
      active: pageRow.active === null ? null : { ...pageRow.active, id } };
    rows.push(v11PreparedDayRow(local, windowMinutes));
    previous = pageRow.observedAtMs;
  }
  const result = { day, quotaRowsRead: count, rows };
  if (serializedBytes(result) > EFFECTIVE_QUOTA_DAY_MAX_BYTES) return null;
  if (!validEffectiveQuotaDayPending(result)) throw fail();
  return result;
}

/** Only call at authoritative end-of-day. Unexpected reducer errors stay
 * visible; only its explicit bounded refusals select the paged fallback. */
export function finishEffectiveQuotaDay(pending: EffectiveQuotaDayPending): EffectiveQuotaDay | undefined {
  if (!validEffectiveQuotaDayPending(pending)) throw fail();
  try {
    const result = { projection: reduceGraphDayProjection(pending.day, pending.rows),
      quotaRowsRead: pending.quotaRowsRead };
    if (serializedBytes(result) > EFFECTIVE_QUOTA_DAY_MAX_BYTES) return undefined;
    if (!validEffectiveQuotaDay(result)) throw fail();
    return result;
  } catch (error) {
    if (error instanceof GraphDayProjectionRefusedError
      && ['plan_anchor_limit_exceeded', 'run_endpoint_limit_exceeded'].includes(error.reason)) return undefined;
    throw error;
  }
}

/** Fold a complete window, preserving the effective reader's original ordinal
 * identity. Reusing local IDs unchanged can make run collapse drop a midnight
 * endpoint because it compares IDs across days, not only within a day.
 *
 * At most one raw fit fragment exists per admitted reset/run pair. Their total
 * bounds every transient reset-cluster count, so the conservative gate avoids
 * the known folded/paged discrepancy at the 4,096-cluster refusal boundary. */
export function foldEffectiveQuotaDays(identity: V11QuotaAcquisitionIdentity,
  days: readonly EffectiveQuotaDay[], expectedDays: readonly string[]): V11QuotaAcquisitionStep | undefined {
  if (days.length !== expectedDays.length || expectedDays.length > 101) return undefined;
  let priorDay = '', offset = 0, fragments = 0;
  const projections: GraphDayProjection[] = [];
  for (const [index, day] of days.entries()) {
    if (!validEffectiveQuotaDay(day) || day.projection.day !== expectedDays[index]
      || day.projection.day <= priorDay || day.projection.day < identity.observedAtCutoff.slice(0, 10)) return undefined;
    priorDay = day.projection.day;
    fragments += day.projection.fitFragments.fragments.length;
    if (fragments > QUOTA_RESET_CLUSTER_LIMIT
      || !Number.isSafeInteger(offset + day.quotaRowsRead)) return undefined;
    projections.push({ ...day.projection, runEndpoints: { endpoints: day.projection.runEndpoints.endpoints
      .map((endpoint) => ({ ...endpoint, sourceRowId: endpoint.sourceRowId + offset })) } });
    offset += day.quotaRowsRead;
  }
  return foldV11QuotaAcquisition(identity, projections, expectedDays);
}
