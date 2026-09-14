import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDashboardPayload } from '../public/data-client.js';
import { mergeHorizonResetEvents, resetEventPresentation } from '../public/trends-horizon.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';

const event = {
  schemaVersion: 'quota-reset-event-v0.1', kind: 'banked_reset_used',
  occurredAt: '2026-09-10T01:00:00.000Z', observedAt: '2026-09-10T01:00:00.000Z',
  intervalStartedAt: '2026-09-10T00:00:00.000Z', precision: 'observation_interval',
  reason: 'credit_count_decreased_before_expiry', provider: 'openai_codex',
  planType: 'pro', limitId: 'codex', windowDurationMins: 10080,
};
const normalize = rows => normalizeDashboardPayload({ timeline: { resetEvents: rows } }).timeline.resetEvents;
const marker = (overrides = {}) => ({ ...event, timestampMs: 100, intervalStartedAtMs: 50, observedAtMs: 100, ...overrides });

test('reset DTO admits only complete closed evidence and rejects private or contradictory fields', () => {
  assert.deepEqual(normalize([event]), [event]);
  for (const row of [null, [], { ...event, privateCreditId: 'synthetic-private' },
    { ...event, kind: '__proto__' }, { ...event, kind: 'constructor' },
    { ...event, planType: 'private-plan' }, { ...event, precision: 'provider_schedule' },
    { ...event, intervalStartedAt: event.observedAt }, { ...event, windowDurationMins: -1 },
    { ...event, occurredAt: '2026-09-10T02:00:00.000Z' }]) assert.deepEqual(normalize([row]), []);
  const credit = { ...event, kind: 'reset_credit_granted', reason: 'reset_credit_id_added',
    precision: 'provider_timestamp', planType: null, limitId: null, windowDurationMins: null };
  assert.deepEqual(normalize([credit]), [credit]);
  assert.deepEqual(normalize([{ ...credit, planType: 'pro' }]), []);
});

test('typed reset evidence replaces matching fallback observations while preserving unrelated boundaries and credits', () => {
  const banked = marker();
  const grant = marker({ kind: 'reset_credit_granted', timestampMs: 200, intervalStartedAtMs: 150,
    observedAtMs: 200, planType: null, limitId: null, windowDurationMins: null });
  const fallback = timestampMs => ({ kind: 'window_change', timestampMs });
  const result = mergeHorizonResetEvents([fallback(250), banked, banked, fallback(80), fallback(100),
    fallback(25), fallback(50), grant, fallback(180), { kind: 'observed_reset', timestampMs: 250 }]);
  assert.deepEqual(result.map(r => [r.timestampMs, r.kind]), [
    [25, 'window_change'], [50, 'window_change'], [100, 'banked_reset_used'], [180, 'window_change'],
    [200, 'reset_credit_granted'], [250, 'observed_reset'],
  ]);
  assert.deepEqual(mergeHorizonResetEvents([{ kind: '__proto__', timestampMs: 1 }, marker({ observedAtMs: null })]), []);
});

test('reset inspection keeps interval, schedule and provider precision in every locale', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const options = { t: (key, values) => translate(key, values, locale), formatInstant: String };
    const interval = resetEventPresentation(marker(), options);
    assert.match(interval.caption, /50/); assert.match(interval.caption, /100/);
    assert.doesNotMatch(interval.caption, /trends\./);
    const scheduled = resetEventPresentation(marker({ kind: 'scheduled_reset', precision: 'provider_schedule', timestampMs: 75 }), options);
    assert.match(scheduled.caption, /75/); assert.match(scheduled.caption, /100/);
    assert.notEqual(scheduled.icon, interval.icon);
    const credit = resetEventPresentation(marker({ kind: 'reset_credit_expired', precision: 'provider_timestamp' }), options);
    assert.ok(credit.caption.includes(translate('trends.resetAccountScope', {}, locale)));
    assert.doesNotMatch(credit.caption, /trends\./);
  }
});
