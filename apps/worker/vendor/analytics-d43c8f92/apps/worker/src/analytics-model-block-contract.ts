/**
 * Bounded, model-only local job contract. Checkpoints contain immutable day
 * dependencies and reduced quota/usage state, never source record JSON.
 */
import { COMPOSITION_CACHE_KEY_SUFFIX, validCompleteCachedComposition } from './community-allowance';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import { validEffectiveQuotaDay, validEffectiveQuotaDayPending, foldEffectiveQuotaDays,
  type EffectiveQuotaDay, type EffectiveQuotaDayPending } from './effective-quota-day';
import { effectiveUsageWindowRepresentable, validEffectiveUsageDay,
  validEffectiveUsageDayPending, type EffectiveUsageDay,
  type EffectiveUsageDayPending } from './effective-usage-day';
import { modelHistoryWindow } from './model-history-window';
import { type V1ModelCompositionResult } from './quota-analysis-v1';
import { createV11QuotaAcquisitionIdentity, finishV11UsageReduction,
  foldV11UsageModelReduction, v11FoldedUsageWindowRefusal,
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';
import { type V11CompletedQuotaAcquisition } from './quota-analysis-v11-reader';
import { type V11SourcePin } from './telemetry-v11-domain';
import { type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';

const DAY_MS = 86_400_000;
const HEX = /^[0-9a-f]{64}$/u;
const CURSOR_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const MAX_OUTPUT_DAYS = 32;
export const MODEL_BLOCK_HISTORICAL_DAYS = 32;
export const MODEL_BLOCK_PREVIEW_DAYS = ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS;
const MAX_OUTPUT_BYTES = 256 * 1024;
export const MODEL_BLOCK_MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;
export const MODEL_BLOCK_METHOD =
  `effective-model-block-v1:${COMPOSITION_CACHE_KEY_SUFFIX}:${V11_PLAN_ATTRIBUTION_ADAPTER_VERSION}`;

export interface ModelBlockIdentity {
  readonly version: 1;
  readonly method: string;
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly inputRevision: number;
  readonly authorityDigest: string;
  readonly outputFromDay: string;
  readonly outputThroughDay: string;
}

export interface ModelBlockDependency {
  readonly day: string;
  readonly digest: string;
  readonly hasQuota: boolean;
  readonly hasUsage: boolean;
}

export interface ModelBlockPending {
  readonly day: string;
  readonly stream: 'quota' | 'usage' | 'store';
  readonly after: EffectiveUsageReaderCursor | null;
  readonly quota: EffectiveQuotaDayPending;
  readonly usage: EffectiveUsageDayPending;
}

export interface ModelBlockOutput {
  readonly day: string;
  readonly fingerprint: string;
  readonly value: V1ModelCompositionResult;
}

export interface ModelBlockCheckpoint {
  readonly version: 1;
  readonly phase: 'select' | 'acquire' | 'emit' | 'fallback' | 'complete';
  readonly dependencies: readonly ModelBlockDependency[];
  /** Number of completed input days; pending, if present, is this index. */
  readonly inputIndex: number;
  readonly pending: ModelBlockPending | null;
  readonly outputs: readonly ModelBlockOutput[];
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function dayStart(day: unknown): number | null {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isSafeInteger(start) && new Date(start).toISOString().slice(0, 10) === day ? start : null;
}

function calendarDays(first: string, last: string): string[] {
  const start = dayStart(first), end = dayStart(last);
  if (start === null || end === null || end < start) throw new TypeError('MODEL_BLOCK_INVALID_RANGE');
  return Array.from({ length: Math.floor((end - start) / DAY_MS) + 1 }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

export interface ModelBlockRange { readonly outputFromDay: string; readonly outputThroughDay: string }

/** Intersections of UTC-epoch-aligned blocks with the completed preview dates.
 * The 70-day preview includes today; its 69 historical dates meet 3 or 4 blocks. */
export function planHistoricalModelBlockRanges(todayDay: string): readonly ModelBlockRange[] {
  const today = dayStart(todayDay);
  if (today === null) throw new TypeError('MODEL_BLOCK_INVALID_DAY');
  const first = Math.floor(today / DAY_MS) - (MODEL_BLOCK_PREVIEW_DAYS - 1);
  const last = Math.floor(today / DAY_MS) - 1;
  const ranges: ModelBlockRange[] = [];
  for (let start = Math.floor(first / MODEL_BLOCK_HISTORICAL_DAYS) * MODEL_BLOCK_HISTORICAL_DAYS;
    start <= last; start += MODEL_BLOCK_HISTORICAL_DAYS) {
    ranges.push({ outputFromDay: new Date(Math.max(start, first) * DAY_MS).toISOString().slice(0, 10),
      outputThroughDay: new Date(Math.min(start + MODEL_BLOCK_HISTORICAL_DAYS - 1, last) * DAY_MS).toISOString().slice(0, 10) });
  }
  return ranges;
}

export function historicalModelBlockRangeEligible(range: ModelBlockRange, todayDay: string): boolean {
  return planHistoricalModelBlockRanges(todayDay).some(value =>
    value.outputFromDay === range.outputFromDay && value.outputThroughDay === range.outputThroughDay);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function validModelBlockIdentity(value: unknown): value is ModelBlockIdentity {
  if (!closed(value, ['version', 'method', 'sourceId', 'sourceNamespace', 'ownerDigest',
    'ownerRevision', 'authorityEpoch', 'inputRevision', 'authorityDigest',
    'outputFromDay', 'outputThroughDay']) || value.version !== 1 || value.method !== MODEL_BLOCK_METHOD
    || typeof value.sourceId !== 'string' || value.sourceId.length < 1 || value.sourceId.length > 256
    || typeof value.sourceNamespace !== 'string' || value.sourceNamespace.length < 1
    || value.sourceNamespace.length > 256 || typeof value.ownerDigest !== 'string'
    || !HEX.test(value.ownerDigest) || typeof value.authorityDigest !== 'string'
    || !HEX.test(value.authorityDigest)
    || ![value.ownerRevision, value.authorityEpoch, value.inputRevision].every(number =>
      Number.isSafeInteger(number) && (number as number) >= 0)
    || (value.authorityEpoch as number) < 1) return false;
  const first = dayStart(value.outputFromDay), last = dayStart(value.outputThroughDay);
  if (first === null || last === null || last < first || last - first > (MAX_OUTPUT_DAYS - 1) * DAY_MS) return false;
  try { modelHistoryWindow(value.outputFromDay as string); } catch { return false; }
  return true;
}

export function modelBlockOutputDays(identity: ModelBlockIdentity): readonly string[] {
  if (!validModelBlockIdentity(identity)) throw new TypeError('MODEL_BLOCK_INVALID_IDENTITY');
  return calendarDays(identity.outputFromDay, identity.outputThroughDay);
}

export function modelBlockInputDays(identity: ModelBlockIdentity): readonly string[] {
  if (!validModelBlockIdentity(identity)) throw new TypeError('MODEL_BLOCK_INVALID_IDENTITY');
  return calendarDays(modelHistoryWindow(identity.outputFromDay).fromDay, identity.outputThroughDay);
}

function validDependencies(value: unknown, days: readonly string[], prefix = false): value is ModelBlockDependency[] {
  return Array.isArray(value) && (prefix ? value.length <= days.length : value.length === days.length)
    && value.every((entry, index) =>
    closed(entry, ['day', 'digest', 'hasQuota', 'hasUsage']) && entry.day === days[index]
      && typeof entry.digest === 'string' && HEX.test(entry.digest)
      && typeof entry.hasQuota === 'boolean' && typeof entry.hasUsage === 'boolean');
}

function validCursor(value: unknown, day: string): value is EffectiveUsageReaderCursor {
  if (!closed(value, ['observedAtMs', 'occurrenceId']) || !Number.isSafeInteger(value.observedAtMs)
    || typeof value.occurrenceId !== 'string' || !CURSOR_ID.test(value.occurrenceId)) return false;
  const start = dayStart(day)!;
  return (value.observedAtMs as number) >= start && (value.observedAtMs as number) < start + DAY_MS;
}

function validPending(value: unknown, expectedDay: string): value is ModelBlockPending {
  if (!closed(value, ['day', 'stream', 'after', 'quota', 'usage']) || value.day !== expectedDay
    || !['quota', 'usage', 'store'].includes(value.stream as string)
    || !validEffectiveQuotaDayPending(value.quota)
    || !validEffectiveUsageDayPending(value.usage)
    || value.quota.day !== expectedDay || value.usage.projection.day !== expectedDay) return false;
  if (value.stream === 'store' && value.after !== null) return false;
  if (value.after === null) return true;
  if (!validCursor(value.after, expectedDay)) return false;
  if (value.stream === 'quota') return value.quota.quotaRowsRead > 0
    && value.after.observedAtMs === value.quota.rows.at(-1)?.observedAtMs;
  return value.usage.projection.usage.rowsRead > 0
    && value.after.observedAtMs === value.usage.lastObservedAtMs;
}

function validOutputs(value: unknown, days: readonly string[]): value is ModelBlockOutput[] {
  if (!Array.isArray(value) || value.length > days.length) return false;
  return value.every((entry, index) => {
    if (!closed(entry, ['day', 'fingerprint', 'value']) || entry.day !== days[index]
      || typeof entry.fingerprint !== 'string' || !HEX.test(entry.fingerprint)
      || !validCompleteCachedComposition(entry.value, entry.fingerprint,
        V11_PLAN_ATTRIBUTION_ADAPTER_VERSION)) return false;
    try { return encodedBytes(entry) <= MAX_OUTPUT_BYTES; } catch { return false; }
  });
}

/** Fully closed, exact ordered input vector and output prefix. */
export function validModelBlockCheckpoint(value: unknown, identity: ModelBlockIdentity): value is ModelBlockCheckpoint {
  if (!validModelBlockIdentity(identity) || !closed(value,
    ['version', 'phase', 'dependencies', 'inputIndex', 'pending', 'outputs']) || value.version !== 1
    || !['select', 'acquire', 'emit', 'fallback', 'complete'].includes(value.phase as string)) return false;
  const inputs = modelBlockInputDays(identity), outputs = modelBlockOutputDays(identity);
  if (!validDependencies(value.dependencies, inputs, value.phase === 'select')
    || !Number.isSafeInteger(value.inputIndex) || (value.inputIndex as number) < 0
    || (value.inputIndex as number) > inputs.length || !validOutputs(value.outputs, outputs)) return false;
  const index = value.inputIndex as number, emitted = (value.outputs as ModelBlockOutput[]).length;
  if (value.phase === 'select') {
    if (index !== 0 || value.pending !== null || emitted !== 0) return false;
  } else if (value.phase === 'acquire') {
    if (emitted !== 0 || value.pending !== null &&
      (index === inputs.length || !validPending(value.pending, inputs[index]!))) return false;
  } else if (value.phase === 'fallback') {
    if (value.pending !== null) return false;
  } else if (index !== inputs.length || value.pending !== null
    || value.phase === 'complete' && emitted !== outputs.length) return false;
  try { return encodedBytes(value) <= MODEL_BLOCK_MAX_CHECKPOINT_BYTES; } catch { return false; }
}

export function createModelBlockSelection(identity: ModelBlockIdentity): ModelBlockCheckpoint {
  const checkpoint: ModelBlockCheckpoint = { version: 1, phase: 'select',
    dependencies: [], inputIndex: 0, pending: null, outputs: [] };
  if (!validModelBlockCheckpoint(checkpoint, identity)) throw new TypeError('MODEL_BLOCK_INVALID_IDENTITY');
  return checkpoint;
}

export function createModelBlockCheckpoint(identity: ModelBlockIdentity,
  dependencies: readonly ModelBlockDependency[]): ModelBlockCheckpoint {
  const checkpoint: ModelBlockCheckpoint = { version: 1, phase: 'acquire',
    dependencies: dependencies.map(value => ({ ...value })), inputIndex: 0, pending: null, outputs: [] };
  if (!validModelBlockCheckpoint(checkpoint, identity)) throw new TypeError('MODEL_BLOCK_INVALID_DEPENDENCIES');
  return checkpoint;
}

const unexpectedDatabaseRead = (): never => { throw new Error('MODEL_BLOCK_UNEXPECTED_DATABASE_READ'); };
const noDb: D1Database = { prepare: unexpectedDatabaseRead, batch: unexpectedDatabaseRead,
  exec: unexpectedDatabaseRead, withSession: unexpectedDatabaseRead, dump: unexpectedDatabaseRead };

/** Evaluate one complete 101-day prepared window with the existing model fold. */
export async function evaluatePreparedModelDate(input: { pin: V11SourcePin; day: string;
  quotaDays: readonly EffectiveQuotaDay[]; usageDays: readonly EffectiveUsageDay[] }): Promise<
  { status: 'complete'; value: V1ModelCompositionResult } | { status: 'fallback' }
> {
  const window = modelHistoryWindow(input.day);
  if (input.pin.source !== 'v1.1' || input.pin.fromDay !== window.fromDay
    || input.pin.throughDay !== input.day || !HEX.test(input.pin.fingerprint)) {
    throw new TypeError('MODEL_BLOCK_INVALID_WINDOW');
  }
  const days = calendarDays(window.fromDay, input.day);
  if (days.length !== 101 || input.quotaDays.length !== days.length
    || input.usageDays.length !== days.length) throw new TypeError('MODEL_BLOCK_INCOMPLETE_WINDOW');
  for (const [index, day] of days.entries()) {
    const quota = input.quotaDays[index], usage = input.usageDays[index];
    if (!validEffectiveQuotaDay(quota) || quota.projection.day !== day
      || !validEffectiveUsageDay(usage) || usage.projection.day !== day) {
      throw new TypeError('MODEL_BLOCK_INVALID_PREPARED_DAY');
    }
  }
  const identity = createV11QuotaAcquisitionIdentity(input.pin, Date.parse(window.fixedNow));
  const populatedQuota = input.quotaDays.filter(value => value.quotaRowsRead > 0);
  const folded = foldEffectiveQuotaDays(identity, populatedQuota,
    populatedQuota.map(value => value.projection.day));
  if (folded === undefined || folded.status === 'deferred') return { status: 'fallback' };
  if (folded.status === 'not_testable') return { status: 'complete',
    value: { status: 'not_testable', reason: folded.reason } };
  if (!effectiveUsageWindowRepresentable(input.usageDays)) return { status: 'fallback' };
  const populatedUsage = input.usageDays.filter(value => value.projection.usage.rowsRead > 0)
    .map(value => ({ day: value.projection.day, usage: value.projection.usage }));
  if (v11FoldedUsageWindowRefusal(populatedUsage) !== null) return { status: 'fallback' };
  const acquisition: V11CompletedQuotaAcquisition = { identity: folded.identity,
    planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
  const options = { nowMs: Date.parse(window.fixedNow), quotaAcquisition: acquisition,
    scalarRequested: false };
  const state = await foldV11UsageModelReduction(noDb, input.pin, options, populatedUsage,
    populatedUsage.map(value => value.day));
  if (!state.complete) return { status: 'fallback' };
  const result = await finishV11UsageReduction(noDb, input.pin, options, state, 'model');
  return validCompleteCachedComposition(result, input.pin.fingerprint,
    V11_PLAN_ATTRIBUTION_ADAPTER_VERSION)
    ? { status: 'complete', value: result } : { status: 'fallback' };
}
