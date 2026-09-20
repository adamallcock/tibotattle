import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDashboardPayload } from '../public/data-client.js';
import { mergeHorizonResetEvents, resetEventPresentation, resetEventSummary, mountTrendsHorizon } from '../public/trends-horizon.js';
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

test('classified resets do not acquire extra markers from schedule changes or rolling recovery', () => {
  const first = marker({ kind: 'unknown_reset', timestampMs: 100, intervalStartedAtMs: 50, observedAtMs: 100 });
  const second = marker({ kind: 'unknown_reset', timestampMs: 300, intervalStartedAtMs: 250, observedAtMs: 300 });
  // Schedule updates after confirmation are outside both evidence intervals.
  // They previously inflated this two-reset group to nine entries.
  const noise = [110, 130, 140, 160, 180, 200].map(timestampMs => ({ kind: 'window_change', timestampMs }));
  noise.push({ kind: 'observed_reset', timestampMs: 101 });
  assert.deepEqual(mergeHorizonResetEvents([second, ...noise, first, first]), [first, second]);
  assert.deepEqual(mergeHorizonResetEvents(noise), [], 'unclassified input cannot manufacture resets when the DTO is empty');
  assert.deepEqual(mergeHorizonResetEvents([{ kind: '__proto__', timestampMs: 1 }, marker({ observedAtMs: null })]), []);
});

test('nearby classified resets and account credits retain their identities and separate counts', () => {
  const banked = marker();
  const otherPlan = marker({ planType: 'plus' });
  const otherWindow = marker({ windowDurationMins: 300 });
  const grant = marker({ kind: 'reset_credit_granted', timestampMs: 100,
    planType: null, limitId: null, windowDurationMins: null });
  const expiry = { ...grant, kind: 'reset_credit_expired' };
  const result = mergeHorizonResetEvents([banked, banked, otherPlan, otherWindow, grant, expiry]);
  assert.equal(result.length, 5, 'same time is not evidence of a duplicate across types or allowance tracks');
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key, values) => translate(key, values, locale);
    assert.equal(resetEventSummary(result, t), `${t('trends.resetCount', {count: 3})} · ${t('trends.resetCreditCount', {count: 2})}`);
    assert.equal(resetEventSummary([grant, expiry], t), t('trends.resetCreditCount', {count: 2}));
    assert.equal(resetEventSummary([banked], t), t('trends.resetCount', {count: 1}));
    assert.equal(resetEventSummary([], t), t('trends.resetUnavailable'));
  }
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


test('rendered mixed badges never imply credits are allowance resets and clear on refresh', () => {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.attributes = {}; this.children = []; this.style = {}; this.dataset = {}; this.listeners = {}; this.isConnected = true; this.hidden = false; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child) { child.parent = this; this.children.unshift(child); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    removeEventListener() {}
    querySelector(selector) { return this.children.find(child => child.attributes.class === selector.slice(1)) ?? elements.get(selector) ?? null; }
  }
  const elements = new Map(['#trends-time', '#trends-replay', '#trends-latest', '.trends-sky', '.trends-sun', '.trends-moon', '.trends-stars', '#trends-reset-count', '#trends-event-detail'].map(key => [key, new Element()]));
  const win = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), cancelAnimationFrame() {}, MutationObserver: class { observe() {} disconnect() {} } };
  const document = { defaultView: win, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), addEventListener() {}, removeEventListener() {} };
  const root = new Element(); root.ownerDocument = document;
  const t = (key, values) => translate(key, values, 'en');
  const controller = mountTrendsHorizon(root, { t, locale: 'en-US', timeZone: 'UTC', formatMoney: String, formatPercent: String, formatDuration: String });
  const svg = new Element('svg'), shell = new Element(); shell.id = 'allowance-timeline-chart';
  controller.register(shell, { svg, points: [], series: [{ key: 'allowanceRemaining', label: 'Allowance', format: String }], x: row => row.timestampMs, y: value => value,
    domain: { startMs: 0, endMs: 1000 }, margin: { top: 12, bottom: 30, left: 72, right: 24 }, width: 1100, height: 270 });
  const credit = marker({ kind: 'reset_credit_granted', precision: 'provider_timestamp', planType: null, limitId: null, windowDurationMins: null });
  controller.setEvents([marker(), credit, { kind: 'window_change', timestampMs: 101 }]);
  assert.equal(elements.get('#trends-reset-count').textContent, 'Resets: 1 · Credit events: 1');
  const badge = svg.querySelector('.trends-reset-layer').children[0];
  assert.equal(badge.children.find(child => child.tag === 'text').textContent, '⋯');
  assert.match(badge.attributes['aria-label'], /Resets: 1 · Credit events: 1/);
  let prevented = false;
  badge.listeners.keydown({ key: 'Enter', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(elements.get('#trends-event-detail').hidden, false);
  assert.match(elements.get('#trends-event-detail').textContent, /not a reset of this allowance/);
  controller.setEvents([]);
  assert.equal(elements.get('#trends-event-detail').hidden, true);
  assert.equal(elements.get('#trends-reset-count').textContent, t('trends.resetUnavailable'));
  assert.equal(svg.querySelector('.trends-reset-layer').children.length, 0);
  controller.dispose();
});
