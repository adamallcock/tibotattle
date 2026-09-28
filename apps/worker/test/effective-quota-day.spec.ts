import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import {
  appendEffectiveQuotaDay, EFFECTIVE_QUOTA_DAY_MAX_BYTES, EFFECTIVE_QUOTA_DAY_MAX_ROWS,
  finishEffectiveQuotaDay, foldEffectiveQuotaDays, mapEffectiveQuotaPageRow,
  validEffectiveQuotaDay, validEffectiveQuotaDayPending,
  type EffectiveQuotaDay, type EffectiveQuotaDayPending,
} from '../src/effective-quota-day';
import {
  advanceV11QuotaAcquisition, foldV11QuotaAcquisition, V11_QUOTA_ACQUISITION_PAGE_SIZE,
  type V11QuotaAcquisitionIdentity, type V11QuotaAcquisitionStep, type V11QuotaPageReader,
} from '../src/quota-analysis-v11-reader';
import { QUOTA_RESET_CLUSTER_LIMIT } from '../src/quota-endpoint-collapse';
import type { EffectiveTelemetryOccurrence } from '../src/telemetry-usage-effective-reader';
import type { V11QuotaPageRow, V11QuotaSourceRow } from '../src/typed-v11-quota-reader';

const DAY = 86_400_000, MINUTE = 60_000;
const BASE = Date.parse('2026-05-01T00:00:00.000Z');
const WINDOW = 10_080;
const ACCOUNT = `account-track:v2:${'a'.repeat(64)}`;
const IDENTITY: V11QuotaAcquisitionIdentity = {
  participantId: 'synthetic-effective-quota-day', inputFingerprint: 'b'.repeat(64),
  sourceMethodVersion: 'synthetic-effective-quota-day',
  observedAtCutoff: new Date(BASE).toISOString(), resetsAtCutoff: new Date(BASE).toISOString(),
  windowMinutes: WINDOW, maxQuotaRows: 60_000,
};
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
const occurrence = (id: number) => `quota-occurrence:v1:${id.toString(16).padStart(64, '0')}`;

function row(id: number, at: number, patch: Partial<V11QuotaSourceRow> | null = {}): V11QuotaPageRow {
  const active: V11QuotaSourceRow | null = patch === null ? null : {
    id, observedAtMs: at, observedAt: new Date(at).toISOString(), observedDay: dayOf(at),
    deviceId: 'effective-owner', provider: 'openai_codex', limitId: 'codex',
    planType: 'pro', planVariant: 'unknown', accountBasis: 'same_source', accountTrackId: ACCOUNT,
    planBasis: 'same_source_occurrence', planEraId: null, occurrenceId: occurrence(id),
    slot: 'seven_day', usedPercent: 10, windowDurationMinutes: WINDOW,
    resetsAt: new Date(BASE + 14 * DAY).toISOString(), resetsAtMs: BASE + 14 * DAY, ...patch,
  };
  return { physicalId: id, sourceRowId: id, observedAtMs: at, active };
}

function prepare(rows: readonly V11QuotaPageRow[], pageSize = 200): EffectiveQuotaDay[] {
  const grouped = new Map<string, V11QuotaPageRow[]>();
  for (const value of rows) {
    const day = dayOf(value.observedAtMs), entries = grouped.get(day) ?? [];
    entries.push(value); grouped.set(day, entries);
  }
  return [...grouped].map(([day, entries]) => {
    let pending: EffectiveQuotaDayPending | null = null;
    for (let offset = 0; offset < entries.length; offset += pageSize) {
      pending = appendEffectiveQuotaDay(pending, day, entries.slice(offset, offset + pageSize), WINDOW);
      expect(pending).not.toBeNull();
    }
    const result = finishEffectiveQuotaDay(pending!);
    expect(result).toBeDefined();
    expect(validEffectiveQuotaDay(result)).toBe(true);
    return result!;
  });
}

async function paged(rows: readonly V11QuotaPageRow[], identity = IDENTITY): Promise<V11QuotaAcquisitionStep> {
  // Effective acquisition assigns a fresh global ordinal to this exact window.
  const ordered = rows.map((value, index) => ({ ...value, physicalId: index + 1, sourceRowId: index + 1,
    active: value.active === null ? null : { ...value.active, id: index + 1 } }));
  const reader: V11QuotaPageReader = { pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
    async readPage(cursor, limit) {
      const index = ordered.findIndex((value) => value.observedAtMs > cursor.observedAtMs
        || value.observedAtMs === cursor.observedAtMs && value.sourceRowId > cursor.sourceRowId);
      return index < 0 ? [] : ordered.slice(index, index + limit);
    } };
  return advanceV11QuotaAcquisition(reader, identity,
    { remainingQueries: 100_000, deadlineMs: 1, now: () => 0 });
}

const expected = (days: readonly EffectiveQuotaDay[]) => days.map((day) => day.projection.day);

function effective(value: V11QuotaPageRow): EffectiveTelemetryOccurrence {
  const active = value.active!;
  return { methodVersion: 'effective-telemetry-owner-day-v1', stream: 'quota',
    participantId: IDENTITY.participantId, ownerDigest: 'c'.repeat(64),
    occurrenceId: active.occurrenceId, eventTime: active.observedAt, eventTimeConflict: false,
    status: 'compatible', sourceCount: 1, sourceFormats: ['v12'], sourceRowIds: [],
    sourceRecordKeys: ['synthetic-record'], recordJson: JSON.stringify({
      schemaVersion: 'quota-observation-v1.1', observationId: active.occurrenceId,
      observedTime: active.observedAt, provider: active.provider, limitId: active.limitId,
      planType: active.planType, planVariant: active.planVariant, slot: active.slot,
      usedPercent: active.usedPercent, windowDurationMinutes: active.windowDurationMinutes,
      resetsAt: active.resetsAt, accountPlanAttribution: {
        accountBasis: active.accountBasis, accountTrackId: active.accountTrackId,
        planBasis: active.planBasis, planType: active.planType, planEraId: active.planEraId,
      },
    }) };
}

describe('effective quota prepared-day adapter', () => {
  it('maps reconciled quota rows into exactly the paged acquisition shape', () => {
    const original = row(33, BASE + MINUTE, { usedPercent: 42 });
    expect(mapEffectiveQuotaPageRow(effective(original), dayOf(BASE), 33)).toEqual(original);
    expect(() => mapEffectiveQuotaPageRow({ ...effective(original), status: 'conflict', recordJson: null },
      dayOf(BASE), 33)).toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
    expect(() => mapEffectiveQuotaPageRow({ ...effective(original), stream: 'usage' },
      dayOf(BASE), 33)).toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
    expect(() => mapEffectiveQuotaPageRow(effective(original), dayOf(BASE + DAY), 33))
      .toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
    expect(() => mapEffectiveQuotaPageRow(effective(original), dayOf(BASE), Number.MAX_SAFE_INTEGER + 1))
      .toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  });

  it('counts excluded rows and rebases global source ordinals before reduction', () => {
    const pending = appendEffectiveQuotaDay(null, dayOf(BASE), [
      row(101, BASE, null), row(102, BASE + MINUTE),
      row(103, BASE + 2 * MINUTE, { windowDurationMinutes: 300 }),
      row(104, BASE + 3 * MINUTE, { usedPercent: 50 }),
    ], WINDOW)!;
    expect(pending.quotaRowsRead).toBe(4);
    expect(pending.rows.map((entry) => entry.sourceRowId)).toEqual([1, 2, 3, 4]);
    expect(pending.rows.map((entry) => entry.row !== null)).toEqual([false, true, false, true]);
    const prepared = finishEffectiveQuotaDay(pending)!;
    expect(prepared.quotaRowsRead).toBe(4);
    expect(prepared.projection.runEndpoints.endpoints.map((entry) => entry.sourceRowId)).toEqual([2, 4]);
    expect(validEffectiveQuotaDay({ ...prepared, quotaRowsRead: 3 })).toBe(false);
  });

  it('accepts authoritative empty days while rejecting open or inconsistent pending shapes', () => {
    const pending = appendEffectiveQuotaDay(null, dayOf(BASE), [], WINDOW)!;
    expect(pending).toEqual({ day: dayOf(BASE), quotaRowsRead: 0, rows: [] });
    expect(validEffectiveQuotaDayPending(pending)).toBe(true);
    expect(validEffectiveQuotaDay(finishEffectiveQuotaDay(pending))).toBe(true);
    expect(validEffectiveQuotaDayPending({ ...pending, rawRecords: [] })).toBe(false);
    expect(validEffectiveQuotaDayPending({ ...pending, quotaRowsRead: 1 })).toBe(false);
    expect(validEffectiveQuotaDayPending({ ...pending, day: '2026-02-30' })).toBe(false);

    const populated = appendEffectiveQuotaDay(null, dayOf(BASE), [row(1, BASE)], WINDOW)!;
    const first = populated.rows[0]!;
    expect(validEffectiveQuotaDayPending({ ...populated,
      rows: [{ ...first, rawRecord: 'not-allowed' }] })).toBe(false);
    expect(validEffectiveQuotaDayPending({ ...populated,
      rows: [{ ...first, row: { ...first.row!, rawRecord: 'not-allowed' } }] })).toBe(false);
    expect(validEffectiveQuotaDayPending({ ...populated,
      rows: [{ ...first, sourceRowId: 2 }] })).toBe(false);
    expect(() => appendEffectiveQuotaDay(populated, dayOf(BASE + DAY), [], WINDOW))
      .toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
    expect(() => finishEffectiveQuotaDay({ ...populated, quotaRowsRead: 2 }))
      .toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
  });

  it('rebases colliding local IDs so an equal-value run keeps its final midnight endpoint', async () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => row(index + 1, BASE + index * 60 * MINUTE,
        { usedPercent: (index + 1) * 10 })),
      ...Array.from({ length: 9 }, (_, index) => row(index + 10, BASE + DAY + index * 60 * MINUTE,
        { usedPercent: 90 })),
    ];
    const days = prepare(rows);
    expect(days[0]!.projection.runEndpoints.endpoints.at(-1)!.sourceRowId).toBe(9);
    expect(days[1]!.projection.runEndpoints.endpoints.at(-1)!.sourceRowId).toBe(9);
    const reference = await paged(rows);
    const folded = foldEffectiveQuotaDays(IDENTITY, days, expected(days));
    expect(canonicalJson(folded)).toBe(canonicalJson(reference));
    expect(reference.status).toBe('complete');
    if (reference.status !== 'complete') throw new Error('reference must complete');
    expect(reference.quotaRows.at(-1)!.occurrence_id).toBe(occurrence(18));
    // Prove this fixture exercises the collision, not only normal day joining.
    const unrebased = foldV11QuotaAcquisition(IDENTITY, days.map((day) => day.projection), expected(days));
    expect(canonicalJson(unrebased)).not.toBe(canonicalJson(reference));
  });

  it('retains a complete equal-time plan conflict split across occurrence pages', async () => {
    const rows = Array.from({ length: 420 }, (_, index) => row(index + 1,
      BASE + Math.floor(index / 2) * 2 * MINUTE, { usedPercent: 10 + index % 80,
        ...(index === 199 ? { planType: 'plus' } : {}) }));
    // Rows 199 and 200 share one instant and lie on different pages.
    rows[200] = row(201, rows[199]!.observedAtMs, { usedPercent: 50 });
    const prepared = prepare(rows, 200);
    const singlePage = prepare(rows, 1000);
    expect(canonicalJson(prepared)).toBe(canonicalJson(singlePage));
    const reference = await paged(rows);
    expect(canonicalJson(foldEffectiveQuotaDays(IDENTITY, prepared, expected(prepared))))
      .toBe(canonicalJson(reference));
  });

  it('reuses the same days across overlapping windows with exact paged results', async () => {
    const rows = Array.from({ length: 4 }, (_, day) => Array.from({ length: 160 }, (_, index) => {
      const id = day * 160 + index + 1, at = BASE + day * DAY + Math.floor(index / 2) * 5 * MINUTE;
      const reset = BASE + 14 * DAY + index % 3 * MINUTE;
      return row(id, at, index === 40 ? null : { usedPercent: 10 + index % 80,
        resetsAt: new Date(reset).toISOString(), resetsAtMs: reset,
        ...(index === 75 ? { windowDurationMinutes: 300 } : {}) });
    })).flat();
    const cached = prepare(rows, 73), before = canonicalJson(cached);
    for (const [from, through] of [[0, 4], [1, 4], [1, 3]]) {
      const identity = { ...IDENTITY, observedAtCutoff: new Date(BASE + from! * DAY).toISOString() };
      const selected = cached.slice(from, through);
      const raw = rows.filter((value) => value.observedAtMs >= BASE + from! * DAY
        && value.observedAtMs < BASE + through! * DAY);
      const reference = await paged(raw, identity);
      expect(reference.status).toBe('complete');
      expect(canonicalJson(foldEffectiveQuotaDays(identity, selected, expected(selected))))
        .toBe(canonicalJson(reference));
    }
    expect(canonicalJson(cached)).toBe(before);
  });

  it('applies the moving reset horizon before joining cross-day reset jitter', async () => {
    const horizon = BASE + 10 * DAY;
    const rows = Array.from({ length: 80 }, (_, index) => {
      const reset = horizon + (index % 3 - 1) * MINUTE;
      return row(index + 1, BASE + Math.floor(index / 40) * DAY + index % 40 * 5 * MINUTE,
        { usedPercent: 10 + index % 80, resetsAt: new Date(reset).toISOString(), resetsAtMs: reset });
    });
    const prepared = prepare(rows, 17);
    const identity = { ...IDENTITY, resetsAtCutoff: new Date(horizon).toISOString() };
    const reference = await paged(rows, identity);
    expect(reference.status).toBe('complete');
    if (reference.status !== 'complete') throw new Error('reference must complete');
    expect(reference.quotaRows.length).toBeGreaterThan(0);
    expect(reference.quotaRows.every((value) => Date.parse(value.resets_at) >= horizon)).toBe(true);
    expect(canonicalJson(foldEffectiveQuotaDays(identity, prepared, expected(prepared))))
      .toBe(canonicalJson(reference));
  });

  it('declines missing days, reversed coverage and impossible row counts', () => {
    const rows = [row(1, BASE), row(2, BASE + DAY), row(3, BASE + 2 * DAY)];
    const days = prepare(rows), coverage = expected(days);
    expect(foldEffectiveQuotaDays(IDENTITY, [days[0]!, days[2]!], coverage)).toBeUndefined();
    expect(foldEffectiveQuotaDays(IDENTITY, [...days].reverse(), [...coverage].reverse())).toBeUndefined();
    expect(foldEffectiveQuotaDays(IDENTITY, [{ ...days[0]!, quotaRowsRead: 0 }, ...days.slice(1)], coverage))
      .toBeUndefined();
    expect(foldEffectiveQuotaDays(IDENTITY,
      [{ ...days[0]!, quotaRowsRead: Number.MAX_SAFE_INTEGER }, ...days.slice(1)], coverage)).toBeUndefined();
    expect(foldEffectiveQuotaDays({ ...IDENTITY, observedAtCutoff: new Date(BASE + DAY).toISOString() },
      days, coverage)).toBeUndefined();
  });

  it('bounds pending rows and serialized bytes without changing the paged refusal', () => {
    const unselected = Array.from({ length: EFFECTIVE_QUOTA_DAY_MAX_ROWS }, (_, index) =>
      row(index + 1, BASE + index, null));
    const atLimit = appendEffectiveQuotaDay(null, dayOf(BASE), unselected, WINDOW)!;
    expect(atLimit.quotaRowsRead).toBe(EFFECTIVE_QUOTA_DAY_MAX_ROWS);
    expect(appendEffectiveQuotaDay(atLimit, dayOf(BASE),
      [row(EFFECTIVE_QUOTA_DAY_MAX_ROWS + 1, BASE + EFFECTIVE_QUOTA_DAY_MAX_ROWS, null)], WINDOW)).toBeNull();
    const dense = Array.from({ length: 7_000 }, (_, index) => row(index + 1, BASE + index,
      { usedPercent: index % 100 }));
    expect(dense.length).toBeLessThan(EFFECTIVE_QUOTA_DAY_MAX_ROWS);
    const overflow = appendEffectiveQuotaDay(null, dayOf(BASE), dense, WINDOW);
    expect(overflow).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength)
      .toBeLessThanOrEqual(EFFECTIVE_QUOTA_DAY_MAX_BYTES);
  });

  it('falls back before the known transient reset-cluster refusal can differ', () => {
    const rows = Array.from({ length: QUOTA_RESET_CLUSTER_LIMIT + 1 }, (_, index) => {
      const day = index < 2_048 ? 0 : 1, withinDay = index < 2_048 ? index : index - 2_048;
      const reset = BASE + 14 * DAY + index * 10 * 60 * MINUTE;
      return row(index + 1, BASE + day * DAY + withinDay * 1000,
        { usedPercent: index % 100, resetsAt: new Date(reset).toISOString(), resetsAtMs: reset });
    });
    const days = prepare(rows, 200);
    expect(days.reduce((count, day) => count + day.projection.fitFragments.fragments.length, 0))
      .toBe(QUOTA_RESET_CLUSTER_LIMIT + 1);
    expect(foldEffectiveQuotaDays(IDENTITY, days, expected(days))).toBeUndefined();
  });
});
