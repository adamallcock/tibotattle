import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { loadQuotaHarness } from '../scripts/gcp-model-residue-quota-check.mjs';
import { mapAnalyticsV2QuotaPageRow } from '../src/analytics-v2/native-path';
import { mapEffectiveQuotaPageRow } from '../vendor/analytics-d43c8f92/apps/worker/src/effective-quota-day';
import type { EffectiveTelemetryOccurrence } from '../vendor/analytics-d43c8f92/entry';
const day = '2026-09-28';
function row(index = 0): EffectiveTelemetryOccurrence {
  const record = { schemaVersion: 'quota-observation-v1.1', observationId: `quota:synthetic:${index}`,
    observedTime: `${day}T12:00:00.000Z`, provider: 'openai_codex', planType: 'pro', planVariant: 'unknown',
    limitId: 'codex', slot: 'seven_day', usedPercent: index % 100, windowDurationMinutes: 10080,
    resetsAt: null, accountPlanAttribution: { accountBasis: 'same_source', accountTrackId: `account-track:v2:${index.toString(16).padStart(64, '0')}`,
      planBasis: 'same_source_occurrence', planType: 'pro', planEraId: null } };
  return { methodVersion: 'effective-telemetry-owner-day-v1', stream: 'quota', participantId: 'synthetic',
    ownerDigest: 'a'.repeat(64), occurrenceId: record.observationId, eventTime: record.observedTime,
    eventTimeConflict: false, status: 'compatible', sourceCount: 1, sourceFormats: ['v11'],
    sourceRowIds: [], sourceRecordKeys: [], recordJson: JSON.stringify(record) };
}
function differential(value: EffectiveTelemetryOccurrence, date = day, ordinal = 1) {
  let expected: ReturnType<typeof mapEffectiveQuotaPageRow> | undefined, error: unknown;
  try { expected = mapEffectiveQuotaPageRow(value, date, ordinal); } catch (caught) { error = caught; }
  if (error) {
    try { mapAnalyticsV2QuotaPageRow(value, date, ordinal); throw new Error('EXPECTED_REFUSAL'); }
    catch (caught) { expect((caught as Error).constructor).toBe((error as Error).constructor); expect((caught as Error).message).toBe((error as Error).message); }
  } else {
    const first = mapAnalyticsV2QuotaPageRow(value, date, ordinal), second = mapAnalyticsV2QuotaPageRow(value, date, ordinal);
    expect(JSON.stringify(first)).toBe(JSON.stringify(expected)); expect(JSON.stringify(second)).toBe(JSON.stringify(expected));
    expect(second).not.toBe(first); expect(second.active).not.toBe(first.active);
    expect(Object.isFrozen(first)).toBe(Object.isFrozen(expected)); expect(Object.isFrozen(first.active)).toBe(Object.isFrozen(expected!.active));
    for (const field of Object.values(first.active)) expect(field === null || ['string', 'number', 'boolean'].includes(typeof field)).toBe(true);
    first.active.provider = 'synthetic-mutated';
    expect(JSON.stringify(mapAnalyticsV2QuotaPageRow(value, date, ordinal))).toBe(JSON.stringify(expected));
  }
}
describe('quota row primitive evidence memo', () => {
  it('matches vendored key order, values and fresh objects over interleaved ordinals and bounded interns', () => {
    const rows = Array.from({ length: 4200 }, (_, index) => row(index));
    for (const ordinal of [1, 45, 200, Number.MAX_SAFE_INTEGER]) for (const value of rows) differential(value, day, ordinal);
  });
  it('re-evaluates defensive mismatches, invalid days and ordinals, and retries thrown rows', () => {
    const value = row(); differential(value);
    for (const ordinal of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) differential(value, day, ordinal);
    for (const date of ['2026-09-27', 'not-day', '2026-02-30']) differential(value, date);
    for (const changes of [{ recordJson: '{' }, { eventTime: '2026-09-27T12:00:00.000Z' },
      { stream: 'usage' }, { status: 'conflicted' }, { recordJson: JSON.stringify({ schemaVersion: 'wrong' }) },
      { recordJson: value.recordJson!.replace('quota-observation-v1.1', 'quota-observation-v1.2') },
      { recordJson: value.recordJson!.slice(0, -1) + ',"prompt":"privacy-canary"}' }]) {
      Object.assign(value, row(), changes); differential(value); differential(value);
      Object.assign(value, row()); differential(value);
    }
  });
  it('maps each object at most twice given one preparation mapping across four phases and 71 windows', async () => {
    const harness = await loadQuotaHarness();
    try {
      const rows = Array.from({length:128}, (_,index)=>row(index));
      // One original-map call stands in for preparation; this exercises the
      // helper directly. Native acquisition instrumentation is a corpus gate.
      for (const value of rows) harness.module.mapEffectiveQuotaPageRow(value, day, 1);
      for (let window=0;window<71;window++) for (let phase=0;phase<4;phase++) for (const [index,value] of rows.entries())
        harness.module.mapAnalyticsV2QuotaPageRow(value, day, index+1+window);
      for (const value of rows) expect(harness.module.quotaHarnessCalls(value)).toBe(2);
    } finally { await harness.close(); }
  });
  it('does not retain dropped quota rows', async () => {
    setFlagsFromString('--expose-gc'); const collect = runInNewContext('gc') as () => void;
    const refs: WeakRef<EffectiveTelemetryOccurrence>[] = [];
    await (async () => { for (let index = 0; index < 64; index++) { const value = row(index); mapAnalyticsV2QuotaPageRow(value, day, 1); refs.push(new WeakRef(value)); } })();
    for (let pass = 0; pass < 10 && refs.some(ref => ref.deref() !== undefined); pass++) { await new Promise(resolve => setTimeout(resolve, 0)); collect(); }
    expect(refs.filter(ref => ref.deref() !== undefined)).toHaveLength(0);
  });
});
