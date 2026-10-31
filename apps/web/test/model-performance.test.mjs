import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelPerformance, performanceSegments, performanceDomain, performanceYScale, performanceDateTicks, performanceHoverBin, mountModelPerformance } from '../public/model-performance.js';
import { LocalCompanionClient } from '../public/data-client.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';
import { normalizeCommunityPerformanceDisplay } from '../public/model-performance.js';
import { normalizeCommunityModelPerformance } from '../public/community-data.js';
import { CATALOGS } from '../../../packages/i18n/index.js';
const DAY = 86400000;
const point = (at = 2 * DAY, n = 5) => ({ at, n,
  p10: n < 5 ? null : 30, p25: n < 5 ? null : 40, median: 50,
  p75: n < 5 ? null : 60, p90: n < 5 ? null : 70 });
function payload() {
  return { schemaVersion: 5, method: 5, speedMode: 'standard', excludedUnknownTurns: 0, status: 'ready', collecting: false, stale: false, updatedAt: '2026-09-09T12:00:00.000Z', period: 'all', interval: 'day', start: DAY, end: 9 * DAY, historyProgress: null,
    models: [{ id: 'gpt-5.6-sol', label: 'Sol', turns: 20, speedTurns: 10, ttftTurns: 15, timedResponses: 45, toolFreeTurns: 0, toolFree: [],
      speed: [{ method: 'speed', points: [point(), point(3 * DAY)] }], ttft: [point(), point(3 * DAY), point(4 * DAY)] }] };
}
test('GPT-6 Sol and Luna DTOs retain generation labels and refuse unreviewed suffixes', () => {
  const data = payload();
  data.models.push(...[['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-luna', 'Luna']]
    .map(([id, label]) => ({ ...structuredClone(data.models[0]), id, label })));
  assert.equal(normalizeModelPerformance(data), data);
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    const suffix = structuredClone(data);
    suffix.models.find(row => row.id === model).id += '-unreviewed';
    assert.equal(normalizeModelPerformance(suffix), null);
    const mislabeled = structuredClone(data);
    mislabeled.models.find(row => row.id === model).label = model.endsWith('sol') ? 'Sol' : 'Luna';
    assert.equal(normalizeModelPerformance(mislabeled), null);
  }
});
function legacyToolFreePayload() {
  const data = payload(); data.schemaVersion = 3; data.method = 4;
  Object.assign(data.models[0], { toolFreeTurns: 2, toolFree: [point(DAY, 2)] });
  return data;
}
function combinedPayload() {
  const data = payload();
  Object.assign(data.models[0], { toolFreeTurns: 2, toolFree: [point(DAY, 2)] });
  data.models[0].speedTurns = 12;
  data.models[0].speed[0].points.unshift(point(DAY, 2));
  return data;
}
test('combined DTO accepts fallback subsets and refuses impossible or cross-version populations', () => {
  const data = combinedPayload();
  assert.equal(normalizeModelPerformance(data), data);
  for (const mutate of [
    x => { x.method = 4; }, x => { x.schemaVersion = 3; }, x => { x.schemaVersion = 4; },
    x => { x.models[0].toolFreeTurns = 13; },
    x => { x.models[0].toolFree[0].at = 5 * DAY; },
    x => { x.models[0].toolFree[0].n = 3; },
  ]) { const invalid = combinedPayload(); mutate(invalid); assert.equal(normalizeModelPerformance(invalid), null); }
  for (const period of ['1', '7', '30']) {
    const pinned = combinedPayload(); pinned.period = period;
    assert.equal(normalizeModelPerformance(pinned), pinned);
  }
});
test('mode-scoped tool-free DTO uses a closed contract and a subset of combined speed evidence', () => {
  const data = combinedPayload();
  assert.equal(normalizeModelPerformance(data), data);
  for (const mutate of [
    x => { x.schemaVersion = 2; }, x => { x.method = 3; },
    x => { delete x.models[0].toolFree; }, x => { delete x.models[0].toolFreeTurns; },
    x => { x.models[0].toolFreeTurns = 21; }, x => { x.models[0].toolFreeTurns = -1; },
    x => { x.models[0].toolFreeTurns = 1; },
    x => { x.models[0].toolFree[0].p90 = 1; },
    x => { x.models[0].toolFree[0].privatePath = '/synthetic/private'; },
    x => { x.models[0].toolFree.push(point(DAY, 1)); },
  ]) { const invalid = combinedPayload(); mutate(invalid); assert.equal(normalizeModelPerformance(invalid), null); }
  for (const [schemaVersion, method] of [[2, 3], [3, 4], [4, 5]]) {
    const legacy = legacyToolFreePayload(); Object.assign(legacy, { schemaVersion, method });
    delete legacy.speedMode; delete legacy.excludedUnknownTurns;
    if (schemaVersion === 2) { delete legacy.models[0].toolFree; delete legacy.models[0].toolFreeTurns; }
    assert.equal(normalizeModelPerformance(legacy), null, 'mixed-mode legacy contracts must never appear as Standard');
  }
  Object.assign(data.models[0], { speedTurns: 2, speed: [{ method: 'speed', points: [point(DAY, 2)] }], ttftTurns: 0, ttft: [] });
  assert.equal(normalizeModelPerformance(data), data, 'historical throughput needs no reconstructed response timing');
  assert.deepEqual(performanceDomain(data, data.models[0]), { start: DAY, end: data.end });
});
test('bounded contract preserves independent populations and one combined speed series', () => {
  const data = payload();
  assert.equal(normalizeModelPerformance(data), data);
  assert.equal(data.models[0].speedTurns, 10);
  assert.equal(data.models[0].ttftTurns, 15);
  data.models[0].speed = [];
  data.models[0].speedTurns = 0;
  assert.equal(normalizeModelPerformance(data), data, 'TTFT-only models remain usable');
});
test('malformed, private, unknown, duplicate and excessive evidence fails closed', () => {
  for (const mutate of [
    x => { x.privatePath = '/synthetic/private'; },
    x => { x.schemaVersion = 7; }, x => { x.method = 1; },
    x => { x.speedMode = 'unknown'; }, x => { x.speedMode = 'mixed'; },
    x => { delete x.speedMode; }, x => { x.excludedUnknownTurns = -1; },
    x => { x.excludedUnknownTurns = 1.5; }, x => { delete x.excludedUnknownTurns; },
    x => { x.historyProgress = { checked: 2, total: 1 }; },
    x => { x.historyProgress = { checked: -1, total: 1 }; },
    x => { x.historyProgress = { checked: 0, total: 1, privatePath: '/synthetic/private' }; },
    x => { x.period = '365'; }, x => { x.models[0].label = '<img>'; },
    x => { x.models[0].id = 'private-thread'; },
    x => { x.models.push(x.models[0]); },
    x => { x.models[0].speed.push(x.models[0].speed[0]); },
    x => { x.models[0].speedTurns = 2; },
    x => { x.models[0].ttftTurns = 30; },
    x => { x.models[0].speed[0].points[0].median = NaN; },
    x => { x.models[0].speed[0].points[0].p10 = 45; },
    x => { x.models[0].speed[0].points[0].p75 = 30; },
    x => { x.models[0].speed[0].points[0].p90 = 55; },
    x => { x.models[0].speed[0].points[0].n = 1; },
    x => { x.models[0].ttft[1].at = x.models[0].ttft[0].at; },
    x => { x.models[0].ttft[0].at = x.end + DAY; },
    x => { x.models[0].ttft = Array.from({length: 2049}, () => point()); },
  ]) { const data = payload(); mutate(data); assert.equal(normalizeModelPerformance(data), null); }
});
test('zero latency is real while missing speed remains absent; sparse bins have no band', () => {
  const data = payload(); data.models[0].ttft = [point(DAY, 1)]; data.models[0].ttft[0].median = 0;
  assert.equal(normalizeModelPerformance(data), data);
  data.models[0].ttft[0].p25 = 0;
  assert.equal(normalizeModelPerformance(data), null);
});
test('all observed medians stay connected while every missing interval is marked dashed', () => {
  const points = [point(DAY, 1), point(2 * DAY, 2), point(5 * DAY), point(20 * DAY)];
  assert.deepEqual(performanceSegments(points, 'day').map(x => x.dashed), [false, true, true]);
  assert.deepEqual(performanceSegments([point(DAY), point(8 * DAY), point(22 * DAY), point(43 * DAY)], 'week').map(x => x.dashed), [false, true, true]);
});
test('client requests only an enum period, is abortable, and reports endpoint failures', async () => {
  const calls = [], signal = new AbortController().signal;
  const client = new LocalCompanionClient({ fetchImpl: async (...args) => { calls.push(args); return {ok: true, status: 200, json: async () => payload()}; } });
  await client.modelPerformance('all', { signal });
  assert.equal(calls[0][0], '/api/local/model-performance?period=all&speedMode=standard');
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[0][1].headers['X-Usage-Monitor-Local'], '1');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.throws(() => client.modelPerformance('bad&secret=x'), RangeError);
  const failed = new LocalCompanionClient({ fetchImpl: async () => ({ok: false, status: 404, json: async () => ({})}) });
  await assert.rejects(() => failed.modelPerformance('7'));
});
test('every supported locale preserves coverage and measurement meaning', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ['title', 'speedEmpty', 'ttftEmpty', 'methodology', 'variance', 'speedSummary', 'latencySummary', 'combinedSpeedSummary', 'combinedSpeedMethodology', 'combinedSpeedEmpty', 'combinedMethodology', 'outerBand', 'innerBand', 'medianP50', 'percentileValues', 'percentilesUnavailable', 'buildingHistory', 'unavailable', 'stale', 'mode', 'standard', 'fast', 'ultrafast', 'standardNote', 'fastNote', 'ultrafastNote', 'unknownMode', 'modeEmpty']) {
      const value = translate(`performance.${key}`, {}, locale);
      assert.notEqual(value, `performance.${key}`);
    }
    const coverage = translate('performance.coverageSpeed', { measured: 12, total: 99 }, locale);
    assert.match(coverage, /12/u); assert.match(coverage, /99/u);
    assert.doesNotMatch(coverage, /\{/u);
  }
});

test('all-time axes share the selected model earliest measured bin without borrowing another model history', () => {
  const data = payload(), selected = data.models[0];
  selected.speed[0].points = [point(6 * DAY), point(7 * DAY)];
  selected.ttft = [point(3 * DAY), point(8 * DAY)];
  assert.deepEqual(performanceDomain(data, selected), { start: 3 * DAY, end: data.end });
  selected.ttft = [];
  assert.deepEqual(performanceDomain(data, selected), { start: 6 * DAY, end: data.end });
  selected.speed = [];
  selected.ttft = [point(4 * DAY)];
  assert.deepEqual(performanceDomain(data, selected), { start: 4 * DAY, end: data.end });
});
test('bounded periods preserve the complete requested domain and empty all-time has no fabricated era', () => {
  const data = payload(), selected = data.models[0];
  for (const period of ['7', '30']) {
    data.period = period;
    assert.deepEqual(performanceDomain(data, selected), { start: DAY, end: data.end });
  }
  data.period = 'all'; selected.speed = []; selected.ttft = [];
  assert.deepEqual(performanceDomain(data, selected), { start: DAY, end: data.end });
  data.start = null;
  assert.deepEqual(performanceDomain(data, selected), { start: data.end, end: data.end });
});


// A small DOM harness models the important browser behavior here: replacing a
// focused descendant drops focus, so rendering must focus its new equivalent.
function focusHarness() {
  let inactive = true, visibilityObserver = null, documentVisibilityObserver = null, nextTimer = 0;
  const timers = new Map();
  const timerDelays = new Map();
  const documentRef = { activeElement: null, hidden: false,
    addEventListener: (type, listener) => { if (type === 'visibilitychange') documentVisibilityObserver = listener; },
    removeEventListener: (type, listener) => { if (type === 'visibilitychange' && documentVisibilityObserver === listener) documentVisibilityObserver = null; } };
  class Node {
    constructor(tagName) {
      this.tagName = tagName; this.ownerDocument = documentRef; this.children = [];
      this.dataset = {}; this.style = { setProperty() {} }; this.attributes = {};
      this.classList = { contains: () => inactive }; this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
    replaceChildren() {
      if (this.all().includes(documentRef.activeElement)) documentRef.activeElement = null;
      this.children = [];
    }
    querySelectorAll(selector) {
      assert.equal(selector, '[data-performance-focus]');
      return this.all().filter(node => node.dataset.performanceFocus);
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === "class") this.className = value; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 256 }; }
    contains(node) { return node === this || this.all().includes(node); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus(options) { documentRef.activeElement = this; this.focusOptions = options; this.listeners.focus?.(); }
  }
  documentRef.createElement = tag => new Node(tag);
  documentRef.createElementNS = (namespace, tag) => new Node(tag);
  const root = new Node('section');
  const windowRef = { localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); return id; },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
    MutationObserver: class { constructor(callback) { visibilityObserver = callback; } observe() {} disconnect() {} },
  };
  return { root, documentRef, windowRef, show: () => { inactive = false; },
    navigate: (shown) => { inactive = !shown; visibilityObserver?.(); },
    find: key => root.all().find(node => node.dataset.performanceFocus === key),
    timerIds: () => [...timers.keys()], timerDelay: id => timerDelays.get(id),
    runTimer: id => timers.get(id)?.(),
    setDocumentHidden: hidden => { documentRef.hidden = hidden; documentVisibilityObserver?.(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const periodPayload = (period, overrides = {}) => ({ ...payload(), ...overrides, period });
const performanceClient = handler => {
  const calls = [];
  return {
    calls,
    client: { modelPerformance: async (period, options) => { calls.push({ period, options }); return handler(period, options); } },
  };
};

test('background history scan reports honest bounded progress while keeping charts visible', async () => {
  const dom = focusHarness();
  const data = { ...combinedPayload(), collecting: true, historyProgress: { checked: 629, total: 9026 } };
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const updated = translate('performance.updated', { date: new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(data.updatedAt)) }, 'en-US');
  assert.equal(dom.root.all().find(node => node.className === 'performance-status').textContent,
    `${updated} · Building earlier history · 629 of 9,026 sessions checked`);
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  assert.equal(dom.root.all().filter(node => node.className === 'performance-card chart-card').length, 2);
  assert.ok(dom.root.all().some(node => node.className === 'performance-unit' && node.textContent.includes('2 full-turn estimates')));
  controller.destroy();
});
test('recovered estimates stay in one output-speed chart with explicit population coverage', async () => {
  const dom = focusHarness(); let response = combinedPayload();
  response.models[0].ttftTurns = response.models[0].turns;
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => response },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.deepEqual(dom.root.all().filter(node => node.tagName === 'h4').map(node => node.textContent),
    ['Output speed', 'First-token latency']);
  assert.equal(dom.root.all().find(node => node.className === 'performance-method-note').textContent,
    'When response timing is unavailable, eligible single-response turns without tools provide full-turn estimates. These include initial waiting and can be lower than response-timed speed.');
  assert.equal(dom.root.all().filter(node => node.className === 'performance-unit')[0].textContent,
    'tokens/s · 12 of 20 turns measured · 10 response-timed · 2 full-turn estimates');
  assert.deepEqual(dom.root.all().filter(node => node.className === 'performance-unit').map(node => node.dataset.state),
    ['partial', 'complete'], 'speed and latency retain their own coverage state');
  const cards = dom.root.all().filter(node => node.className === 'performance-card chart-card');
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => card.children[0].className === 'performance-card-heading chart-card-header'
    && card.children[1].className === 'performance-legend chart-card-legend'), 'all cards retain the compact shared chart layout');
  const plots = dom.root.all().filter(node => node.tagName === 'svg' && node.listeners.pointermove);
  assert.equal(plots.length, 2);
  assert.equal(plots[0].attributes['aria-label'], 'Output speed');
  assert.equal(plots[0].all().filter(node => node.className === 'performance-point').length, 3,
    'pooled points render once; diagnostic fallback percentiles are not drawn again');
  response = combinedPayload(); response.models[0].toolFree = []; response.models[0].toolFreeTurns = 0;
  await controller.refresh();
  assert.equal(dom.root.all().filter(node => node.tagName === 'h4').length, 2);
  assert.equal(dom.root.all().some(node => node.className === 'performance-method-note'), false);
  controller.destroy();
});
test('legacy independent distributions reject mixed-mode evidence without rendering charts', async () => {
  const dom = focusHarness(), data = legacyToolFreePayload();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(dom.root.all().filter(node => node.tagName === 'h4').length, 0);
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false);
  assert.ok(dom.find('retry'));
  controller.destroy();
});

test('retained measurements show their original update date alongside refresh while loading and failure stay distinct', async () => {
  const dom = focusHarness();
  let response = { ...combinedPayload(), status: 'loading', updatedAt: null, models: [] };
  let failure = false;
  const controller = mountModelPerformance({ ...dom, client: {
    modelPerformance: async () => { if (failure) throw new Error('synthetic failure'); return response; },
  }, t: (key, values) => translate(key, values, 'en-US') });
  const status = () => dom.root.all().find(node => node.className === 'performance-status').textContent;
  dom.show(); await controller.refresh();
  assert.equal(status(), translate('performance.updating', {}, 'en-US'));
  response = { ...combinedPayload(), collecting: true };
  await controller.refresh();
  const updated = translate('performance.updated', { date: new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(response.updatedAt)) }, 'en-US');
  assert.equal(status(), `${updated} · ${translate('performance.updating', {}, 'en-US')}`);
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  assert.equal(dom.root.all().filter(node => node.className === 'performance-card chart-card').length, 2);
  response = combinedPayload(); await controller.refresh();
  assert.equal(status(), updated, 'a fresh report shows its date without an updating claim');
  failure = true; await controller.refresh();
  assert.equal(status(), translate('performance.failed', {}, 'en-US'));
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  assert.equal(dom.root.all().filter(node => node.className === 'performance-card chart-card').length, 2);
  assert.ok(dom.root.all().some(node => node.className === 'performance-unit' && node.textContent.includes('2 full-turn estimates')));
  failure = false; response = { ...combinedPayload(), status: 'unavailable', updatedAt: null, models: [] };
  await controller.refresh();
  assert.equal(status(), translate('performance.unavailable', {}, 'en-US'));
  controller.destroy();
});

test('cached update time uses the local date while measurements are updating', async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const dom = focusHarness();
    const response = { ...combinedPayload(), collecting: true, updatedAt: '2026-09-22T02:12:00.000Z' };
    const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => response },
      t: (key, values) => translate(key, values, 'en-US') });
    dom.show(); await controller.refresh();
    assert.equal(dom.root.all().find(node => node.className === 'performance-status').textContent,
      'Updated Sep 21, 2026, 10:12 PM · Updating measurements…');
    controller.destroy();
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test('loading and background renders retain heading and About keyboard focus without a duplicate table', async () => {
  const dom = focusHarness();
  let response = { ...payload(), status: 'loading', models: [] };
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => response },
    t: (key, values) => translate(key, values, 'en-US') });
  const initialHeading = dom.find('heading');
  initialHeading.focus();
  dom.show();
  await controller.refresh();
  assert.notEqual(dom.documentRef.activeElement, initialHeading);
  assert.equal(dom.documentRef.activeElement, dom.find('heading'), 'empty loading branch restores navigation focus');
  assert.equal(dom.documentRef.activeElement.tabIndex, -1, 'replacement heading is programmatically focusable');
  response = payload();
  response.models[0] = { ...response.models[0], speed: [], ttft: [], speedTurns: 0, ttftTurns: 0, timedResponses: 0 };
  await controller.refresh();
  assert.equal(dom.documentRef.activeElement, dom.find('heading'), 'loaded branch retains heading focus');
  dom.find('about').focus();
  const previousAbout = dom.documentRef.activeElement;
  controller.render();
  assert.notEqual(dom.documentRef.activeElement, previousAbout);
  assert.equal(dom.documentRef.activeElement, dom.find('about'), 'locale render retains About focus');
  response = structuredClone(response); response.models[0].turns++;
  await controller.refresh();
  assert.equal(dom.documentRef.activeElement, dom.find('about'), 'new background data retains About disclosure focus');
  assert.deepEqual(dom.documentRef.activeElement.focusOptions, { preventScroll: true });
  assert.equal(dom.root.all().some(node => node.tagName === 'table'), false, 'chart aggregates are not duplicated in a table');
  assert.equal(dom.find('table'), undefined);
  controller.destroy();
});


test('y axes use readable round steps, include the spread, and retain subsecond resolution', () => {
  assert.deepEqual(performanceYScale([53.9, 54.5, 30]), { maximum: 60, ticks: [0,20,40,60], digits: 0 });
  assert.deepEqual(performanceYScale([36.3]), { maximum: 40, ticks: [0,10,20,30,40], digits: 0 });
  assert.deepEqual(performanceYScale([.008]), { maximum: .008, ticks: [0,.002,.004,.006,.008], digits: 3 });
  assert.equal(performanceYScale([0, null, NaN]).maximum, 1);
  for (const peak of [.1, .9, 1, 12, 72, 100, 1e9]) {
    const scale = performanceYScale([peak]);
    assert.ok(scale.maximum >= peak); assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 6);
  }
});
test('calendar ticks use first/fifteenth, Monday weeks and bounded year intervals', () => {
  const stamp = value => Date.parse(`${value}T00:00:00Z`);
  const dates = (start,end) => performanceDateTicks({ start: stamp(start), end: stamp(end) }).map(at => new Date(at).toISOString().slice(0,10));
  assert.deepEqual(dates('2026-07-09','2026-09-09'), ['2026-07-15','2026-08-01','2026-08-15','2026-09-01']);
  assert.deepEqual(dates('2026-08-11','2026-09-09'), ['2026-08-17','2026-08-24','2026-08-31','2026-09-07']);
  assert.deepEqual(dates('2026-09-03','2026-09-09'), ['2026-09-03','2026-09-04','2026-09-05','2026-09-06','2026-09-07','2026-09-08','2026-09-09']);
  assert.ok(dates('2001-06-01','2049-09-09').length <= 7);
  assert.deepEqual(performanceDateTicks({ start: 2, end: 1 }), []);
});
test('horizontal hover bins are calendar-aligned including unobserved days and edges', () => {
  const domain = { start: 2*DAY, end: 9.5*DAY };
  assert.equal(performanceHoverBin(0, domain, 'day'), 2*DAY);
  assert.equal(performanceHoverBin(1, domain, 'day'), 9*DAY);
  assert.equal(performanceHoverBin(.5, domain, 'day'), 6*DAY);
  assert.equal((performanceHoverBin(.5, domain, 'week') - 4*DAY) % (7*DAY), 0);
});
test('performance cards render separate GPT-6 generations with their shared family icons', async () => {
  const dom = focusHarness();
  const data = payload();
  data.models.push(...[['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-luna', 'Luna']]
    .map(([id, label]) => ({ ...structuredClone(data.models[0]), id, label })));
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  try {
    dom.show(); await controller.refresh();
    for (const name of ['GPT-5.6 Sol', 'GPT-5.6 Luna', 'GPT-6 Sol', 'GPT-6 Luna']) {
      assert.ok(dom.root.all().some(node => node.textContent === name), name);
    }
    for (const family of ['sol', 'luna']) {
      const buttons = dom.root.all().filter(node => node.tagName === 'button');
      assert.equal(buttons.filter(button => button.all().some(node => node.className ===
        `allowance-model-icon performance-model-icon allowance-model-${family}`)).length, 2);
    }
  } finally { controller.destroy(); }
});
test('plot-area sweep works away from points, clears on exit, and keyboard order follows dates', async () => {
  const dom = focusHarness();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => payload() },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const svgs = dom.root.all().filter(node => node.tagName === 'svg' && node.listeners.pointermove);
  assert.equal(svgs.length, 2);
  assert.ok(svgs[1].all().some(node => node.className === 'performance-percentile-band performance-percentile-band-outer'));
  assert.ok(svgs[1].all().some(node => node.className === 'performance-percentile-band performance-percentile-band-inner'));
  assert.ok(svgs[1].all().some(node => node.className === 'performance-percentile-line performance-percentile-line-p10'));
  assert.ok(svgs[1].all().some(node => node.className === 'performance-median-line'));
  assert.equal(svgs.some(svg => svg.all().some(node => node.tagName === 'polygon')), false);
  assert.equal(svgs[1].all().filter(node => node.className?.startsWith('performance-endpoint-label')).length, 5);
  assert.ok(dom.root.all().some(node => node.textContent === 'GPT-5.6 Sol'));
  assert.ok(dom.root.all().some(node => node.className === 'allowance-model-icon performance-model-icon allowance-model-sol'));
  assert.deepEqual(dom.root.all().filter(node => node.className === 'performance-unit').map(node => node.textContent), [
    'tokens/s · 10 of 20 turns measured · 10 response-timed · 0 full-turn estimates',
    'seconds · Lower is faster · 15 of 20 turns measured · 45 timed responses',
  ]);
  assert.equal(dom.root.all().some(node => node.className === 'performance-coverage'), false);
  const readouts = () => dom.root.all().filter(node => node.className === 'sr-only performance-readout');
  // Jan3 = first measured day. Pointer near the top, far from its actual point.
  svgs[0].listeners.pointermove({ clientX: 52, clientY: 30 });
  assert.ok(readouts().every(node => node.textContent.includes('Median 50')));
  assert.ok(readouts().every(node => node.textContent.includes('P10 30 · P25 40 · P75 60 · P90 70')));
  const tooltipPercentiles = dom.root.all().filter(node => node.className === 'performance-tooltip-percentiles');
  assert.equal(tooltipPercentiles.length, 2);
  assert.deepEqual(tooltipPercentiles[0].children.filter(node => node.tagName === 'span').map(node => node.textContent), ['P90', 'P75', 'P25', 'P10']);
  assert.deepEqual(dom.root.all().filter(node => node.className === 'performance-tooltip-method').map(node => node.textContent), ['Median (P50)', 'First-token latency']);
  assert.ok(dom.root.all().filter(node => node.className?.startsWith('performance-tooltip ')).every(node => node.className.includes('performance-tooltip-after')));
  svgs[0].listeners.pointermove({ clientX: 52, clientY: 200 });
  assert.ok(readouts().every(node => node.textContent.includes('Median 50')), 'vertical position never changes selected date');
  svgs[0].listeners.pointermove({ clientX: 52 + 656 * 4/7, clientY: 100 });
  assert.ok(readouts().every(node => node.textContent.includes('No measurements')), 'missing day never borrows a nearby observation');
  svgs[0].listeners.pointermove({ clientX: 700, clientY: 100 });
  assert.ok(dom.root.all().filter(node => node.className?.startsWith('performance-tooltip ')).every(node => node.className.includes('performance-tooltip-before')));
  svgs[0].listeners.pointerleave();
  assert.ok(readouts().every(node => node.textContent === ''));
  const targets = svgs[0].all().filter(node => node.className === 'performance-point');
  assert.equal(targets.filter(node => node.attributes.tabindex === '0').length, 1);
  targets[0].focus(); targets[0].listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(dom.documentRef.activeElement, targets[1]);
  assert.ok(readouts().every(node => node.textContent.includes('Jan 4')));
  targets[1].listeners.keydown({ key: 'Escape' });
  assert.ok(readouts().every(node => node.textContent === ''));
  controller.destroy();
});

test('output-speed labels round to whole tokens per second while latency retains tenths', async () => {
  const dom = focusHarness(), data = payload();
  Object.assign(data.models[0].speed[0].points[0], { p10: 30.4, p25: 40.4, median: 50.4, p75: 60.4, p90: 70.4 });
  Object.assign(data.models[0].ttft[0], { p10: 3.04, p25: 4.04, median: 5.04, p75: 6.04, p90: 7.04 });
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const plots = dom.root.all().filter(node => node.tagName === 'svg' && node.listeners.pointermove);
  plots[0].listeners.pointermove({ clientX: 52, clientY: 30 });
  const readouts = dom.root.all().filter(node => node.className === 'sr-only performance-readout');
  assert.match(readouts[0].textContent, /Median 50 · P10 30 · P25 40 · P75 60 · P90 70/u);
  assert.match(readouts[1].textContent, /Median 5 · P10 3 · P25 4 · P75 6 · P90 7/u);
  controller.destroy();
});

test('combined speed evidence draws one readable set of endpoint percentile labels', async () => {
  const dom = focusHarness(), data = payload();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const speed = dom.root.all().find(node => node.tagName === 'svg' && node.listeners.pointermove);
  assert.equal(speed.all().filter(node => node.className?.startsWith('performance-endpoint-label')).length, 5);
  controller.destroy();
});


test('revisits and background loading retain the ready period while replacements and invalidation stay authoritative', async () => {
  const dom = focusHarness();
  let response = payload();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => response },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const panel = () => dom.root.all().find(node => node.id === 'performance-model-panel');
  assert.ok(panel());
  const pending = Promise.withResolvers(); response = pending.promise;
  dom.navigate(false); dom.navigate(true);
  assert.ok(panel(), 'navigation does not blank the last valid chart');
  pending.resolve({ ...payload(), status: 'loading', models: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel(), 'background loading is not a replacement measurement');
  response = { ...payload(), status: 'ready', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'an authoritative empty measurement replaces old values');
  response = payload(); await controller.refresh();
  response = { ...payload(), status: 'unavailable', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined);
  response = { ...payload(), status: 'loading', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'unavailable invalidates cached measurements');
  controller.destroy();
});

test('first visible load prioritizes the selected period and warms the other two exactly once', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  assert.deepEqual(calls.map(call => call.period), [], 'hidden mounts do not prewarm');
  dom.show(); await controller.refresh(); await settle(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  controller.destroy();
});

test('shared reporting waits for its bound, maps 24h to the rolling backend period, and hides local period controls', async () => {
  const dom = focusHarness();
  const end = 9 * DAY;
  const window = {
    period: '24h',
    startAt: new Date(end - DAY).toISOString(),
    endAt: new Date(end).toISOString(),
  };
  const exact = structuredClone(payload());
  exact.period = '1'; exact.start = end - DAY; exact.end = end;
  exact.models[0].speed[0].points = [point(end - DAY), point(end)];
  exact.models[0].ttft = [point(end - DAY), point(end)];
  const calls = [];
  const controller = mountModelPerformance({
    ...dom,
    sharedReporting: true,
    reportingWindow: null,
    client: { modelPerformance: async (period, options) => {
      calls.push({ period, options });
      return exact;
    } },
    t: (key, values) => translate(key, values, 'en-US'),
  });
  assert.equal(calls.length, 0);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.match(dom.root.all().find(node => node.className === 'performance-status').textContent, /unavailable until local evidence loads/u);
  dom.show();
  assert.equal(controller.setReportingWindow(window), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].period, '1');
  assert.equal(calls[0].options.endAt, window.endAt);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false, 'the shared header owns the reporting range');
  assert.equal(dom.root.all().filter(node => node.className === 'performance-unit').length, 2, 'coverage remains beside each chart');
  controller.destroy();
});

test('advancing a shared end bound retains dated charts under their original bounds and fences cancelled replacements', async () => {
  const dom = focusHarness();
  const end = 9 * DAY;
  const windowAt = value => ({ period: '24h', startAt: new Date(value - DAY).toISOString(), endAt: new Date(value).toISOString() });
  const exactAt = value => ({ ...combinedPayload(), period: '1', start: value - DAY, end: value,
    models: combinedPayload().models.map(model => ({ ...model, speedTurns: 5, ttftTurns: 5,
      speed: [{method: 'speed', points: [point(value - DAY)]}], ttft: [point(value - DAY)], toolFree: [point(value - DAY, 2)] })) });
  const calls = [];
  let response = exactAt(end);
  const controller = mountModelPerformance({ ...dom, reportingWindow: windowAt(end),
    client: { modelPerformance: async (period, options) => { calls.push({period, options}); return response; } },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const panel = () => dom.root.all().find(node => node.id === 'performance-model-panel');
  const toolFreeVisible = () => dom.root.all().some(node => node.className === 'performance-unit' && node.textContent.includes('2 full-turn estimates'));
  const status = () => dom.root.all().find(node => node.className === 'performance-status').textContent;
  const pending = Promise.withResolvers(); response = pending.promise;
  controller.setReportingWindow(windowAt(end + DAY));
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.match(status(), /^Updated .+ · Updating measurements…$/u);
  const priorBounds = dom.root.all().find(node => node.dataset.evidence === 'period');
  assert.ok(priorBounds, 'retained charts identify their old bounds even with a shared header');
  assert.equal(calls.at(-1).options.endAt, windowAt(end + DAY).endAt);
  pending.resolve(exactAt(end + DAY));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.doesNotMatch(status(), /Updating/);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false);

  const cancelled = Promise.withResolvers(); response = cancelled.promise;
  controller.setReportingWindow(windowAt(end + 2 * DAY));
  controller.cancel();
  assert.match(status(), /cancelled/i);
  cancelled.resolve({ ...exactAt(end + 2 * DAY), models: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel(), 'late cancelled result cannot remove the retained chart');
  assert.ok(toolFreeVisible(), 'tool-free evidence survives cancellation too');
  assert.match(status(), /cancelled/i);

  response = exactAt(end);
  await controller.refresh();
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.match(status(), /Could not update/, 'an old-window response cannot be accepted as the new window');
  assert.ok(dom.root.all().some(node => node.dataset.evidence === 'period'));
  response = { ...exactAt(end + 2 * DAY), status: 'unavailable', models: [] };
  await controller.refresh();
  assert.ok(panel(), 'an unavailable replacement keeps the old explicitly dated window');
  assert.ok(toolFreeVisible(), 'unavailable does not drop recovered estimates from the retained speed chart');
  assert.match(status(), /Timing measurements are unavailable/);
  assert.ok(dom.find('retry'));
  assert.ok(dom.root.all().some(node => node.dataset.evidence === 'period'));
  response = { ...exactAt(end + 2 * DAY), models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'an authoritative empty replacement still clears the old chart');
  assert.equal(toolFreeVisible(), false);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false);
  controller.destroy();
});


test('failed refresh retains chart coverage and timestamp beside the retry action', async () => {
  const dom = focusHarness();
  let fail = false;
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => {
    if (fail) throw new Error('Synthetic request failure');
    return payload();
  } }, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'freshness'), false, 'ready status already carries its timestamp');
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), true, 'standalone mode still identifies its own period');
  fail = true; await controller.refresh();
  const actions = dom.root.all().find(node => node.className === 'dashboard-actions performance-actions');
  assert.ok(actions.children.some(node => node.dataset.state === 'error'));
  assert.ok(actions.children.some(node => node.dataset.performanceFocus === 'retry'));
  assert.equal(dom.root.all().filter(node => node.dataset.evidence === 'freshness').length, 1);
  assert.deepEqual(dom.root.all().filter(node => node.className === 'performance-unit').map(node => node.textContent), [
    'tokens/s · 10 of 20 turns measured · 10 response-timed · 0 full-turn estimates',
    'seconds · Lower is faster · 15 of 20 turns measured · 45 timed responses',
  ]);
  fail = false; await dom.find('retry').listeners.click();
  assert.equal(dom.find('retry'), undefined);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'freshness'), false);
  controller.destroy();
});


test('page preload warms all periods before first visit and remains idempotent', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const first = controller.preload();
  assert.equal(controller.preload(), first, 'a concurrent preload joins the existing operation');
  await first; await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'selected data is ready before navigation');
  await controller.preload();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30'], 'fresh periods are not fetched again');
  controller.destroy();
});

test('page preload retries a cold loading response with a bounded retry', async () => {
  const dom = focusHarness();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ === 0
    ? periodPayload('all', { status: 'loading', models: [] }) : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const operation = controller.preload();
  await settle();
  assert.deepEqual(calls.map(call => call.period), ['all']);
  const retry = dom.timerIds()[0];
  assert.ok(retry, 'loading response schedules a retry');
  dom.runTimer(retry);
  await operation; await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', 'all', '7', '30']);
  controller.destroy();
});

test('background timing preload continues past the first ten seconds of a cold history pass', async () => {
  const dom = focusHarness();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ < 4
    ? periodPayload('all', { status: 'loading', models: [] }) : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client,
    t: (key, values) => translate(key, values, 'en-US') });
  try {
    const operation = controller.preload();
    for (const delay of [5_000, 10_000, 20_000, 30_000]) {
      await settle();
      const timer = dom.timerIds().find(id => dom.timerDelay(id) === delay);
      assert.ok(timer, `cold history schedules a ${delay}ms retry`);
      dom.runTimer(timer);
    }
    await operation;
    assert.equal(calls.filter(call => call.period === 'all').length, 5);
  } finally { controller.destroy(); }
});

test('active navigation joins an in-flight page preload without duplicating the request', async () => {
  const dom = focusHarness(), all = Promise.withResolvers();
  const { calls, client } = performanceClient(period => period === 'all' ? all.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const preparation = controller.preload(); await settle();
  dom.navigate(true);
  const navigation = controller.refresh(); await settle();
  assert.equal(calls.filter(call => call.period === 'all').length, 1, 'foreground refresh joins speculative work');
  all.resolve(periodPayload('all'));
  await Promise.all([preparation, navigation]); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  controller.destroy();
});

test('document hiding fences preload and allows a later visible retry', async () => {
  const dom = focusHarness(), first = Promise.withResolvers();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ === 0
    ? first.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const canceled = controller.preload(); await settle();
  assert.equal(calls.length, 1);
  dom.setDocumentHidden(true);
  assert.equal(calls[0].options.signal.aborted, true, 'document hiding aborts speculative work');
  await controller.preload();
  assert.equal(calls.length, 1, 'a hidden document does not start speculative work');
  first.resolve(periodPayload('all')); await canceled; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late hidden data is fenced');
  dom.setDocumentHidden(false);
  await controller.preload(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', 'all', '7', '30']);
  controller.destroy();
});

test('a warmed period switches synchronously while its replacement revalidates in the background', async () => {
  const dom = focusHarness(), replacement = Promise.withResolvers();
  let blockReplacement = false;
  const { calls, client } = performanceClient((period) => period === '7' && blockReplacement
    ? replacement.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  blockReplacement = true;
  dom.find('period-7').listeners.click();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'cached chart stays visible before revalidation');
  assert.equal(calls.filter(call => call.period === '7').length, 2, 'switch reuses the warm result and makes one revalidation request');
  replacement.resolve(periodPayload('7'));
  await settle();
  controller.destroy();
});

test('switching during prefetch coalesces with the in-flight period request', async () => {
  const dom = focusHarness(), seven = Promise.withResolvers(), thirty = Promise.withResolvers();
  const { calls, client } = performanceClient(period => period === '7' ? seven.promise : period === '30' ? thirty.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  dom.find('period-7').listeners.click();
  assert.equal(calls.filter(call => call.period === '7').length, 1, 'the selected refresh joins prefetch');
  seven.resolve(periodPayload('7')); thirty.resolve(periodPayload('30'));
  await settle(); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  controller.destroy();
});

test('out-of-order period responses cannot replace the currently selected period', async () => {
  const dom = focusHarness(), all = Promise.withResolvers(), seven = Promise.withResolvers();
  const { client } = performanceClient(period => period === 'all' ? all.promise : period === '7' ? seven.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show();
  const first = controller.refresh();
  dom.find('period-7').listeners.click();
  seven.resolve(periodPayload('7', { models: [] }));
  await settle(); await settle();
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true');
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'the selected empty period is rendered');
  all.resolve(periodPayload('all'));
  await first; await settle();
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true', 'late all-time data is fenced');
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late all-time data cannot replace the selected empty period');
  controller.destroy();
});

test('a sibling unavailable response fences a selected refresh already in flight', async () => {
  const dom = focusHarness(), sibling = Promise.withResolvers(), selected = Promise.withResolvers();
  let allAttempts = 0;
  const { calls, client } = performanceClient((period) => {
    if (period === 'all') return ++allAttempts === 1 ? periodPayload('all') : selected.promise;
    if (period === '7') return sibling.promise;
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  const selectedRefresh = controller.refresh(); await settle();
  const selectedCall = calls.find((call, index) => call.period === 'all' && index > 0);
  assert.ok(selectedCall, 'a second selected request is in flight');
  sibling.resolve(periodPayload('7', { status: 'unavailable', models: [] }));
  await settle();
  assert.equal(selectedCall.options.signal.aborted, true, 'global unavailability aborts the selected request');
  selected.resolve(periodPayload('all'));
  await selectedRefresh; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'the selected view stays unavailable after the late response');
  controller.destroy();
});

test('repeated polling coalesces while the selected period request is in flight', async () => {
  const dom = focusHarness(), poll = Promise.withResolvers();
  let allAttempts = 0;
  const { calls, client } = performanceClient(period => period === 'all'
    ? ++allAttempts === 1 ? periodPayload('all') : poll.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const first = controller.refresh(), second = controller.refresh(); await settle();
  assert.equal(calls.filter(call => call.period === 'all').length, 2, 'two polls share one network request');
  poll.resolve(periodPayload('all')); await Promise.all([first, second]);
  controller.destroy();
});

test('fresh period entries avoid warm requests until the bounded TTL expires', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  await controller.refresh(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30', 'all'], 'fresh siblings are not re-fetched');
  const originalNow = Date.now, expiredAt = originalNow() + 61_000;
  Date.now = () => expiredAt;
  try {
    await controller.refresh(); await settle(); await settle();
    assert.deepEqual(calls.map(call => call.period), ['all', '7', '30', 'all', 'all', '7', '30'], 'expired siblings are warmed again');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('scope unavailability invalidates every period cache', async () => {
  const dom = focusHarness();
  let unavailable = false, pendingThirty = null;
  const { calls, client } = performanceClient(period => {
    if (period === '7' && unavailable) return periodPayload('7', { status: 'unavailable', models: [] });
    if (period === '30' && pendingThirty) return pendingThirty.promise;
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 61_000;
  Date.now = () => expiredAt;
  try {
    unavailable = true; pendingThirty = Promise.withResolvers();
    await controller.refresh(); await settle(); await settle();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'background scope invalidation withdraws the visible chart');
    dom.find('period-30').listeners.click();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'invalidated periods are not rendered from stale cache');
    pendingThirty.resolve(periodPayload('30'));
    await settle();
  } finally { Date.now = originalNow; }
  assert.ok(calls.some(call => call.period === '7'));
  controller.destroy();
});

test('scope unavailability withdraws the selected chart while the page is inactive', async () => {
  const dom = focusHarness();
  let unavailable = false;
  const { client } = performanceClient(period => period === '7' && unavailable
    ? periodPayload('7', { status: 'unavailable', models: [] })
    : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  dom.navigate(false);
  const originalNow = Date.now, expiredAt = originalNow() + 61_000;
  Date.now = () => expiredAt;
  try {
    unavailable = true;
    await controller.preload();
    await settle();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false,
      'an unavailable sibling cannot leave a stale chart for the first visit');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('a selected unavailable result does not fan out sibling requests', async () => {
  const dom = focusHarness();
  const unavailableClient = performanceClient(() => periodPayload('all', { status: 'unavailable', models: [] }));
  const controller = mountModelPerformance({ ...dom, client: unavailableClient.client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.deepEqual(unavailableClient.calls.map(call => call.period), ['all']);
  controller.destroy();
});

test('an empty ready result replaces the warmed period authoritatively', async () => {
  const dom = focusHarness();
  let empty = false;
  const { client } = performanceClient(period => periodPayload(period, empty && period === '7' ? { models: [] } : {}));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 61_000;
  Date.now = () => expiredAt;
  try {
    empty = true; await controller.refresh(); await settle(); await settle();
    dom.find('period-7').listeners.click();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false);
    assert.ok(dom.root.all().some(node => node.className === 'performance-empty'), 'empty ready remains authoritative after a switch');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('background failures retain the last good period value', async () => {
  const dom = focusHarness();
  let fail = false;
  const { client } = performanceClient(period => {
    if (fail && period === '7') throw new Error('temporary connection failure');
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 61_000;
  Date.now = () => expiredAt;
  try {
    fail = true; await controller.refresh(); await settle(); await settle();
    dom.find('period-7').listeners.click();
    await settle();
    assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'failed revalidation does not blank a good chart');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('a client that ignores the timeout abort cannot publish its late response', async () => {
  const dom = focusHarness(), late = Promise.withResolvers();
  let attempt = 0;
  const { calls, client } = performanceClient(() => ++attempt === 1 ? late.promise : periodPayload('all'));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show();
  const first = controller.refresh();
  const deadline = dom.timerIds()[0];
  dom.runTimer(deadline);
  assert.equal(calls[0].options.signal.aborted, true);
  late.resolve(periodPayload('all'));
  await first; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late timed-out data is not rendered');
  await controller.refresh();
  assert.equal(calls.filter(call => call.period === 'all').length, 2, 'timeout permits a later retry');
  controller.destroy();
});

test('hidden and destroyed views cancel selected and prefetch requests', async () => {
  const dom = focusHarness(), first = Promise.withResolvers();
  // The first selected request is held so the view can be hidden before any
  // prefetch begins.
  const held = performanceClient((period, options) => period === 'all' ? first.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client: held.client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); const refresh = controller.refresh();
  assert.equal(held.calls.length, 1);
  dom.navigate(false);
  assert.equal(held.calls[0].options.signal.aborted, true);
  first.resolve(periodPayload('all'));
  await refresh; await settle();
  assert.equal(held.calls.length, 1, 'hidden cancellation prevents prewarming');
  controller.destroy();

  const secondDom = focusHarness(), prefetch = Promise.withResolvers();
  const warmed = performanceClient(period => period === '7' ? prefetch.promise : periodPayload(period));
  const secondController = mountModelPerformance({ ...secondDom, client: warmed.client, t: (key, values) => translate(key, values, 'en-US') });
  secondDom.show(); await secondController.refresh(); await settle();
  const prefetchCall = warmed.calls.find(call => call.period === '7');
  assert.ok(prefetchCall, 'visible ready data starts the bounded prefetch');
  secondController.destroy();
  assert.equal(prefetchCall.options.signal.aborted, true, 'destroy cancels a running prefetch');
});

const modePayload = (period, speedMode, overrides = {}) => periodPayload(period, { speedMode, ...overrides });
const hasPanel = dom => dom.root.all().some(node => node.id === 'performance-model-panel');

test('Standard is the initial mode and Fast empty results show unknown exclusions without borrowing cached Standard', async () => {
  const dom = focusHarness(), fast = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'fast'
    ? period === 'all' ? fast.promise : modePayload(period, speedMode, { models: [] })
    : modePayload(period, speedMode));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.ok(calls.every(call => call.options.speedMode === 'standard'), 'prewarming also stays in Standard');
  assert.equal(dom.find('mode-standard').attributes['aria-pressed'], 'true');
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'false');
  dom.find('mode-fast').focus(); dom.find('mode-fast').listeners.click();
  assert.equal(hasPanel(dom), false, 'an uncached Fast view clears all Standard charts immediately');
  assert.equal(dom.documentRef.activeElement, dom.find('mode-fast'), 'toggle focus survives render');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  fast.resolve(modePayload('all', 'fast', { models: [], excludedUnknownTurns: 17 }));
  await settle(); await settle();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.root.all().some(node => node.textContent?.includes('No Fast mode measurements')));
  assert.ok(dom.root.all().some(node => node.textContent?.includes('Excluded turns (unknown or mixed speed mode): 17.')));
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('Ultrafast clears other modes while pending and retains its own empty result and exclusions', async () => {
  const dom = focusHarness(), ultrafast = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'ultrafast'
    ? period === 'all' ? ultrafast.promise : modePayload(period, speedMode, { models: [] })
    : modePayload(period, speedMode));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(hasPanel(dom), true);
  assert.equal(dom.find('mode-ultrafast').attributes['aria-pressed'], 'false');
  dom.find('mode-ultrafast').focus(); dom.find('mode-ultrafast').listeners.click();
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.documentRef.activeElement, dom.find('mode-ultrafast'));
  assert.equal(calls.at(-1).options.speedMode, 'ultrafast');
  ultrafast.resolve(modePayload('all', 'ultrafast', { models: [], excludedUnknownTurns: 17 }));
  await settle(); await settle();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.root.all().some(node => node.textContent?.includes('No Ultrafast mode measurements')));
  assert.ok(dom.root.all().some(node => node.textContent?.includes('Only Ultrafast mode measurements')));
  assert.ok(dom.root.all().some(node => node.textContent?.includes('Excluded turns (unknown or mixed speed mode): 17.')));
  dom.find('mode-standard').listeners.click();
  assert.equal(hasPanel(dom), true);
  dom.find('mode-ultrafast').listeners.click();
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.find('mode-ultrafast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('one Fast observation shows its own coverage, hollow points and no percentile bands', async () => {
  const dom = focusHarness();
  const { client } = performanceClient((period, { speedMode }) => {
    const data = modePayload(period, speedMode);
    if (speedMode === 'fast') Object.assign(data.models[0], { turns: 1, speedTurns: 1, ttftTurns: 1, timedResponses: 1,
      speed: [{ method: 'speed', points: [point(2 * DAY, 1)] }], ttft: [point(2 * DAY, 1)] });
    return data;
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); dom.find('mode-fast').listeners.click(); await settle();
  const nodes = dom.root.all();
  assert.equal(nodes.filter(node => node.className === 'performance-point').length, 2);
  assert.equal(nodes.filter(node => node.attributes.fill === 'var(--surface-raised)').length, 2);
  assert.equal(nodes.some(node => node.className?.startsWith('performance-percentile-band ')), false);
  assert.equal(nodes.some(node => node.className === 'performance-median-line'), false);
  assert.ok(nodes.some(node => node.textContent === 'tokens/s · 1 of 1 turns measured · 1 response-timed · 0 full-turn estimates'));
  controller.destroy();
});

test('mode and period caches stay independent while revisits retain only their own measurements', async () => {
  const dom = focusHarness(); let loading = false;
  const { calls, client } = performanceClient((period, { speedMode }) => modePayload(period, speedMode,
    loading ? { status: 'loading', models: [] } : speedMode === 'fast' ? { models: [] } : {}));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  dom.find('mode-fast').listeners.click(); await settle(); await settle();
  assert.deepEqual(calls.filter(call => call.options.speedMode === 'fast').map(call => call.period), ['all', '7', '30']);
  loading = true;
  dom.find('mode-standard').listeners.click();
  assert.ok(hasPanel(dom), 'Standard synchronously recovers its own cached all-time result');
  await settle();
  dom.find('period-7').listeners.click();
  assert.ok(hasPanel(dom), 'Standard recovers only its own warmed seven-day result');
  await settle();
  dom.find('mode-fast').listeners.click();
  assert.equal(hasPanel(dom), false, 'Fast seven-day empty result is not replaced by Standard seven-day charts');
  await settle();
  assert.equal(calls.at(-1).period, '7');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('late responses and failures from the previous mode cannot change the selected mode or its cache', async () => {
  for (const outcome of ['response', 'failure']) {
    const dom = focusHarness(), late = Promise.withResolvers();
    let standardAttempts = 0;
    const { calls, client } = performanceClient((period, { speedMode }) => {
      if (speedMode === 'standard' && period === 'all') {
        if (++standardAttempts === 1) return late.promise;
        return modePayload(period, speedMode, { status: 'loading', models: [] });
      }
      return modePayload(period, speedMode, { models: [] });
    });
    const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
    dom.show(); const first = controller.refresh();
    dom.find('mode-fast').listeners.click(); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    if (outcome === 'response') late.resolve(modePayload('all', 'standard'));
    else late.reject(new Error('late Standard failure'));
    await first; await settle();
    assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
    assert.equal(hasPanel(dom), false);
    assert.equal(dom.find('retry'), undefined, 'an obsolete failure never becomes a Fast error');
    dom.find('mode-standard').listeners.click(); await settle();
    assert.equal(hasPanel(dom), false, 'late Standard responses never warm the Standard cache');
    controller.destroy();
  }
});

test('a mode switch fences an in-flight page preload and starts an independent Fast request', async () => {
  const dom = focusHarness(), late = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'standard'
    ? late.promise : modePayload(period, speedMode, { models: [] }));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const preload = controller.preload(); await settle();
  dom.show(); dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(calls[0].options.signal.aborted, true);
  late.resolve(modePayload('all', 'standard')); await preload; await settle();
  assert.equal(calls.filter(call => call.options.speedMode === 'standard').length, 1, 'cancelled preload does not fan out Standard periods');
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  await controller.preload(); await settle();
  assert.equal(calls.filter(call => call.options.speedMode === 'fast' && call.period === 'all').length, 1, 'new-mode preload reuses only Fast cache');
  controller.destroy();
});

test('shared reporting keeps its exact bound and selected speed mode through mode and period changes', async () => {
  const dom = focusHarness(), end = 9 * DAY;
  const windowAt = period => ({ period, startAt: new Date(end - (period === '24h' ? 1 : 7) * DAY).toISOString(), endAt: new Date(end).toISOString() });
  const { calls, client } = performanceClient((period, { speedMode }) => modePayload(period, speedMode, {
    start: end - Number(period) * DAY, end, models: [],
  }));
  const controller = mountModelPerformance({ ...dom, client, reportingWindow: windowAt('24h'),
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(calls.at(-1).period, '1');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(calls.at(-1).options.endAt, windowAt('24h').endAt);
  controller.setReportingWindow(windowAt('7d')); await settle();
  assert.equal(calls.at(-1).period, '7');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(calls.at(-1).options.endAt, windowAt('7d').endAt);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('shared preload prepares twelve period and speed-mode pairs at one exact end bound', async () => {
  const dom = focusHarness(), end = 60 * DAY;
  const endAt = new Date(end).toISOString();
  const pending = Promise.withResolvers();
  let revalidating = false;
  const { calls, client } = performanceClient((period, { speedMode }) => revalidating
    ? pending.promise
    : modePayload(period, speedMode, {
      start: period === 'all' ? null : end - Number(period) * DAY,
      end, models: [],
    }));
  const windowAt = period => ({ period, endAt, startAt: period === 'all' ? null
    : new Date(end - (period === '24h' ? 1 : period === '7d' ? 7 : 30) * DAY).toISOString() });
  const controller = mountModelPerformance({ ...dom, client, reportingWindow: windowAt('7d'),
    t: (key, values) => translate(key, values, 'en-US') });
  try {
    await controller.preload();
    assert.equal(calls.length, 12);
    assert.deepEqual(new Set(calls.map(call => `${call.period}:${call.options.speedMode}`)), new Set([
      '1:standard', '1:fast', '1:ultrafast', '7:standard', '7:fast', '7:ultrafast',
      '30:standard', '30:fast', '30:ultrafast', 'all:standard', 'all:fast', 'all:ultrafast',
    ]));
    assert.ok(calls.every(call => call.options.endAt === endAt));
    revalidating = true;
    dom.navigate(true);
    dom.find('mode-fast').listeners.click();
    assert.ok(dom.root.all().some(node => node.className === 'performance-empty'),
      'Fast displays its prepared result while revalidation is pending');
    controller.setReportingWindow(windowAt('30d'));
    assert.ok(dom.root.all().some(node => node.className === 'performance-empty'),
      'a different period displays its prepared Fast result immediately');
    dom.find('mode-ultrafast').listeners.click();
    assert.ok(dom.root.all().some(node => node.className === 'performance-empty'),
      'Ultrafast retains its own prepared result while revalidation is pending');
  } finally {
    controller.destroy();
    pending.resolve(null);
  }
});

test('client rejects unsupported modes, preserves endAt, and page rejects a wrong-mode response', async () => {
  const calls = [], endAt = '2026-09-22T12:00:00.000Z';
  const client = new LocalCompanionClient({ fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, status: 200, json: async () => payload() };
  } });
  await client.modelPerformance('7', { speedMode: 'fast', endAt });
  const url = new URL(calls[0][0], 'http://localhost');
  assert.equal(url.searchParams.get('period'), '7');
  assert.equal(url.searchParams.get('speedMode'), 'fast');
  assert.equal(url.searchParams.get('endAt'), endAt);
  for (const speedMode of ['unknown', 'mixed', 'all', 'fast&path=x', null]) assert.throws(() => client.modelPerformance('7', { speedMode }), RangeError);
  const dom = focusHarness();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => modePayload('all', 'fast') },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.find('retry'));
  controller.destroy();
});

// ---------------------------------------------------------------------------
// Community display variant. The fixtures are plain literals (the normalized
// output of community-data.js) so the edge line can copy them verbatim.
function communityPublished() {
  return {
    state: 'published', schemaVersion: 'community-model-performance-v1',
    methodVersion: 'performance-histogram-pool-type7-bounds-v1', population: 'reported_samples',
    approximate: true, revision: 3, generatedAt: '2026-10-11T03:05:00.000Z',
    period: '7', interval: 'day', start: '2026-10-04', end: '2026-10-10', speedMode: 'standard',
    excludedUnknownTurns: 2, contributors: 4, devices: 5, reports: 9,
    models: [{
      provider: 'openai_codex', modelId: 'gpt-5.6-sol',
      turns: 15, speedTurns: 14, ttftTurns: 13, timedResponses: 20, toolFreeTurns: 1,
      contributors: 3, devices: 4,
      speed: { unit: 'tokens_per_second', points: [
        { day: '2026-10-04', n: 11, unresolved: 2,
          p10: { estimate: 40, lower: 35, upper: 45 }, p25: { estimate: 50, lower: 46, upper: 55 },
          median: { estimate: 62, lower: 58, upper: 66 }, p75: { estimate: 70, lower: 66, upper: 80 },
          p90: { estimate: 90, lower: 80, upper: 130 } },
        { day: '2026-10-06', n: 3, unresolved: 0,
          p10: null, p25: null, median: { estimate: 55, lower: 48, upper: 61 }, p75: null, p90: null },
      ] },
      ttft: { unit: 'milliseconds', points: [
        { day: '2026-10-04', n: 10, unresolved: 0,
          p10: { estimate: 800, lower: 700, upper: 900 }, p25: { estimate: 1000, lower: 900, upper: 1100 },
          median: { estimate: 1200, lower: 1100, upper: 1400 }, p75: { estimate: 1600, lower: 1400, upper: 1800 },
          p90: { estimate: 2400, lower: 1800, upper: 3000 } },
        { day: '2026-10-06', n: 3, unresolved: 0,
          p10: null, p25: null, median: { estimate: 1500, lower: 1300, upper: 1900 }, p75: null, p90: null },
      ] },
      label: 'GPT-5.6 Sol',
    }],
    omittedModels: { models: 1, turns: 6 },
  };
}
// One closed UTC day: the window starts and ends on the same completed day.
function communityLatestDay() {
  return {
    state: 'published', schemaVersion: 'community-model-performance-v1',
    methodVersion: 'performance-histogram-pool-type7-bounds-v1', population: 'reported_samples',
    approximate: true, revision: 3, generatedAt: '2026-10-11T03:05:00.000Z',
    period: '1', interval: 'day', start: '2026-10-10', end: '2026-10-10', speedMode: 'standard',
    excludedUnknownTurns: 0, contributors: 1, devices: 1, reports: 1,
    models: [{
      provider: 'openai_codex', modelId: 'gpt-5.6-sol',
      turns: 2, speedTurns: 2, ttftTurns: 0, timedResponses: 0, toolFreeTurns: 0,
      contributors: 1, devices: 1,
      speed: { unit: 'tokens_per_second', points: [
        { day: '2026-10-10', n: 2, unresolved: 0,
          p10: null, p25: null, median: { estimate: 64, lower: 60, upper: 71 }, p75: null, p90: null },
      ] },
      ttft: { unit: 'milliseconds', points: [] },
      label: 'GPT-5.6 Sol',
    }],
    omittedModels: { models: 0, turns: 0 },
  };
}
// The raw wire body that community-data.js normalizes into communityPublished().
function communityWireBody() {
  const { state, omittedModels, ...body } = communityPublished();
  body.models = body.models.map(({ label, ...model }) => model);
  body.models.push({ provider: 'openai_codex', modelId: 'gpt-synthetic-unlisted', turns: 6, speedTurns: 0,
    ttftTurns: 0, timedResponses: 0, toolFreeTurns: 0, contributors: 1, devices: 1,
    speed: { unit: 'tokens_per_second', points: [] }, ttft: { unit: 'milliseconds', points: [] } });
  return body;
}
const communitySlot = (period, speedMode = 'standard') => {
  if (period === '1') return { ...communityLatestDay(), speedMode };
  const start = { '7': '2026-10-04', '30': '2026-09-11', all: '2026-09-01' }[period];
  return { ...communityPublished(), period, start, speedMode };
};
const communityClient = (handler = (period, options) => communitySlot(period, options.speedMode)) => {
  const calls = [];
  return { calls, client: { modelPerformance: async (period, options) => { calls.push({ period, speedMode: options.speedMode, signal: options.signal }); return handler(period, options); } } };
};
const en = (key, values) => translate(key, values, 'en-US');
const textOf = (dom, className) => dom.root.all().filter(node => node.className === className).map(node => node.textContent);
const evidenceOf = dom => Object.fromEntries(dom.root.all().filter(node => node.className === 'performance-evidence-row')
  .map(row => [row.dataset.evidence, row.children[1].textContent]));
const communityStatus = dom => dom.root.all().find(node => node.className === 'performance-status');

test('community display adapter consumes the normalized reader output with bounds, seconds and UTC epochs', () => {
  const normalized = normalizeCommunityModelPerformance(communityWireBody(), { period: '7', speedMode: 'standard' });
  assert.deepEqual(normalized, communityPublished(), 'the fixture is exactly what the public reader produces');
  const display = normalizeCommunityPerformanceDisplay(normalized);
  assert.equal(display.start, Date.UTC(2026, 9, 4));
  assert.equal(display.end, Date.UTC(2026, 9, 11) - 1, 'the window ends at the end of its last UTC day');
  assert.deepEqual(display.models.map(model => [model.id, model.label, model.contributors, model.devices, model.unresolved]),
    [['gpt-5.6-sol', 'GPT-5.6 Sol', 3, 4, 2]]);
  const [model] = display.models;
  assert.deepEqual(model.speed.map(point => point.at), [Date.UTC(2026, 9, 4), Date.UTC(2026, 9, 6)]);
  assert.deepEqual(model.speed[0].median, { estimate: 62, lower: 58, upper: 66 });
  assert.deepEqual(model.speed[1], { at: Date.UTC(2026, 9, 6), n: 3, unresolved: 0, p10: null, p25: null,
    median: { estimate: 55, lower: 48, upper: 61 }, p75: null, p90: null });
  assert.deepEqual(model.ttft[0].median, { estimate: 1.2, lower: 1.1, upper: 1.4 }, 'TTFT is shown in seconds');
  assert.deepEqual(model.ttft[0].p90, { estimate: 2.4, lower: 1.8, upper: 3 });
  assert.deepEqual(display.evidence, { contributors: 4, devices: 5, reports: 9, samples: 21, revision: 3,
    generatedAt: '2026-10-11T03:05:00.000Z', omittedModels: { models: 1, turns: 6 } });
  assert.deepEqual(display.omittedModels, { models: 1, turns: 6 });
  assert.equal(display.excludedUnknownTurns, 2);
});

test('community display adapter maps Monday week bins and refuses every non-published or malformed shape', () => {
  const weekly = communityPublished();
  Object.assign(weekly, { period: 'all', interval: 'week', start: '2026-09-29' });
  weekly.models[0].speed.points[0].day = '2026-09-28';
  weekly.models[0].speed.points[1].day = '2026-10-05';
  weekly.models[0].ttft.points[0].day = '2026-09-28';
  weekly.models[0].ttft.points[1].day = '2026-10-05';
  const display = normalizeCommunityPerformanceDisplay(weekly);
  assert.deepEqual(display.models[0].speed.map(point => point.at), [Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 5)],
    'a week bin is named by its Monday and may begin before the window');
  for (const state of ['none_published', 'unsupported_schema', 'service_unavailable']) {
    assert.equal(normalizeCommunityPerformanceDisplay({ state, period: '7', speedMode: 'standard', models: [], omittedModels: null }), null);
  }
  assert.equal(normalizeCommunityPerformanceDisplay(communityWireBody()), null, 'a raw body never renders');
  assert.equal(normalizeCommunityPerformanceDisplay(payload()), null, 'a local DTO never enters the community path');
  assert.equal(normalizeModelPerformance(communityPublished()), null, 'a community slot never enters the local DTO');
  for (const mutate of [
    x => { x.privatePath = '/synthetic/private'; }, x => { x.approximate = false; }, x => { x.revision = 0; },
    x => { x.schemaVersion = 'community-model-performance-v2'; }, x => { x.period = '14'; },
    x => { x.interval = 'week'; }, x => { x.end = '2026-10-11'; }, x => { x.reports = 1; },
    x => { x.omittedModels = null; }, x => { x.models[0].label = ''; }, x => { delete x.models[0].label; },
    x => { x.models[0].speed.points[0].median.lower = 63; },
    x => { x.models[0].speed.points[1].p10 = { estimate: 50, lower: 40, upper: 52 }; },
    x => { x.models[0].speed.points[0].p25 = null; },
    x => { x.models[0].ttft.points[0].unresolved = 1; },
    x => { x.models[0].speed.points[0].n = 12; },
    x => { x.models[0].speed.points[0].day = '2026-10-03'; },
    x => { x.models[0].speed.points.reverse(); },
    x => { x.models[0].contributors = 5; },
    x => { x.models.push(structuredClone(x.models[0])); },
  ]) { const value = communityPublished(); mutate(value); assert.equal(normalizeCommunityPerformanceDisplay(value), null); }
  const notMonday = structuredClone(weekly); notMonday.models[0].speed.points[0].day = '2026-09-29';
  assert.equal(normalizeCommunityPerformanceDisplay(notMonday), null);
});

test('community variant renders bound estimates, the under-five rule, unresolved notes and evidence rows', async () => {
  const dom = focusHarness();
  const { client } = communityClient(() => communitySlot('7'));
  const controller = mountModelPerformance({ ...dom, source: 'community', period: '7', client, t: en });
  try {
    dom.show(); await controller.refresh();
    assert.equal(dom.root.dataset.performanceSource, 'community');
    assert.equal(communityStatus(dom).dataset.state, 'ready');
    const plots = dom.root.all().filter(node => node.tagName === 'svg' && node.listeners.pointermove);
    assert.equal(plots.length, 2);
    const labels = plots.map(svg => svg.all().filter(node => node.className === 'performance-point').map(node => node.attributes['aria-label']));
    assert.deepEqual(labels[0], [
      'Oct 4, 2026 · Output speed · P50 62 (58-66) tokens/s · P10 40 (35-45) tokens/s · P25 50 (46-55) tokens/s · P75 70 (66-80) tokens/s · P90 90 (80-130) tokens/s · 11 reported samples · 2 above 120 tokens/s without an exact speed',
      'Oct 6, 2026 · Output speed · P50 55 (48-61) tokens/s · 3 reported samples',
    ]);
    assert.deepEqual(labels[1], [
      'Oct 4, 2026 · First-token latency · P50 1.2 (1.1-1.4) s · P10 0.8 (0.7-0.9) s · P25 1 (0.9-1.1) s · P75 1.6 (1.4-1.8) s · P90 2.4 (1.8-3) s · 10 reported samples',
      'Oct 6, 2026 · First-token latency · P50 1.5 (1.3-1.9) s · 3 reported samples',
    ]);
    for (const svg of plots) {
      assert.equal(svg.all().filter(node => node.className === 'performance-bound-whisker').length, 2, 'every point, sparse or banded, shows its median bounds');
      assert.equal(svg.all().filter(node => node.className === 'performance-percentile-range').length, 1, 'only the banded point draws P10-P90');
      assert.equal(svg.all().filter(node => node.className?.startsWith('performance-endpoint-label')).length, 5);
    }
    // Endpoint labels have no room for bounds, so each marks its estimate approximate.
    assert.deepEqual(plots.map(svg => svg.all().filter(node => node.className?.startsWith('performance-endpoint-label')).map(node => node.textContent)), [
      ['P90 ≈90 tokens/s', 'P75 ≈70 tokens/s', 'P50 ≈62 tokens/s', 'P25 ≈50 tokens/s', 'P10 ≈40 tokens/s'],
      ['P90 ≈2.4 s', 'P75 ≈1.6 s', 'P50 ≈1.2 s', 'P25 ≈1 s', 'P10 ≈0.8 s'],
    ]);
    const hollow = plots[0].all().filter(node => node.className === 'performance-point')[1].children[1];
    assert.equal(hollow.attributes.fill, 'var(--surface-raised)', 'a point below five samples is hollow');
    // Tooltip and readout for the sparse day: only its median, with bounds.
    plots[0].listeners.pointermove({ clientX: 52 + 656 * 2 / 7, clientY: 100 });
    const readouts = dom.root.all().filter(node => node.className === 'sr-only performance-readout');
    assert.equal(readouts[0].textContent, 'Oct 6, 2026 · Output speed · P50 55 (48-61) tokens/s · 3 reported samples');
    const tooltip = dom.root.all().find(node => node.className?.startsWith('performance-tooltip performance-tooltip-'));
    assert.ok(tooltip.all().some(node => node.textContent === 'P50 55 (48-61) tokens/s'));
    assert.ok(tooltip.all().some(node => node.textContent === en('performance.community.percentilesUnavailable')));
    plots[0].listeners.pointermove({ clientX: 52, clientY: 100 });
    const banded = dom.root.all().find(node => node.className === 'performance-tooltip-percentiles');
    assert.deepEqual(banded.children.map(node => node.textContent), ['P90', '90 (80-130) tokens/s', 'P75', '70 (66-80) tokens/s', 'P25', '50 (46-55) tokens/s', 'P10', '40 (35-45) tokens/s']);
    assert.ok(dom.root.all().some(node => node.textContent === '2 above 120 tokens/s without an exact speed'));
    plots[0].listeners.pointerleave();
    assert.ok(readouts.every(node => node.textContent === ''));
    assert.deepEqual(textOf(dom, 'performance-method-note performance-unresolved-note'),
      ['2 reported samples were above 120 tokens/s without an exact speed. They are counted, and the bounds widen to cover them.']);
    assert.deepEqual(textOf(dom, 'performance-unit'), [
      'tokens/s · Higher is faster · 14 of 15 reported samples · 1 full-turn estimate',
      'seconds · Lower is faster · 13 of 15 reported samples · 20 timed responses',
    ]);
    assert.deepEqual(textOf(dom, 'performance-unit performance-model-sources'), ['3 contributors · 4 installations']);
    const updated = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-10-11T03:05:00.000Z'));
    assert.deepEqual(evidenceOf(dom), {
      period: '7d · Oct 4, 2026 to Oct 10, 2026', contributors: '4', installations: '5', reports: '9',
      samples: '21', revision: '3', updated, omitted: '1 · 6 reported samples',
    });
    assert.deepEqual(dom.root.all().filter(node => node.className === 'performance-evidence-row').map(row => row.children[0].textContent),
      ['Reporting period', 'Contributors', 'Installations', 'Reports', 'Reported samples', 'Revision', 'Updated', 'Models not shown']);
    assert.ok(dom.root.all().some(node => node.textContent === 'Excluded reported samples (unknown, mixed or other speed mode): 2. Clients 0.1.24–0.1.26 report Ultrafast samples as other, so Ultrafast is undercounted.'));
    assert.ok(dom.root.all().some(node => node.tagName === 'button' && node.attributes['aria-label'] === 'GPT-5.6 Sol' && node.all().some(child => child.textContent === 'GPT-5.6 Sol')));
    assert.ok(dom.root.all().some(node => node.className === 'performance-legend-item' && node.children[1].textContent === 'Median bounds'));
    // The copy scope swaps only the community wording.
    assert.deepEqual(textOf(dom, 'performance-provider'), [en('performance.community.provider')]);
    assert.deepEqual(textOf(dom, 'page-description'), [en('performance.community.subtitle')]);
    const about = dom.root.all().find(node => node.className === 'performance-details');
    assert.deepEqual(about.children.slice(1).map(node => node.textContent), [en('performance.community.methodology'), en('performance.community.variance')]);
    assert.equal(dom.root.all().some(node => node.textContent === en('performance.provider')), false);
  } finally { controller.destroy(); }
});

test('community counts of one read in the singular in every count phrase', async () => {
  const single = communityLatestDay();
  Object.assign(single.models[0], { turns: 1, speedTurns: 1, ttftTurns: 1, timedResponses: 1, toolFreeTurns: 1 });
  single.models[0].speed.points[0] = { ...single.models[0].speed.points[0], n: 1, unresolved: 1 };
  single.models[0].ttft.points = [{ day: '2026-10-10', n: 1, unresolved: 0,
    p10: null, p25: null, median: { estimate: 1500, lower: 1300, upper: 1900 }, p75: null, p90: null }];
  single.omittedModels = { models: 1, turns: 1 };
  for (const [locale, expected] of [
    ['en-US', {
      sources: '1 contributor · 1 installation',
      summaries: ['tokens/s · Higher is faster · 1 of 1 reported sample · 1 full-turn estimate',
        'seconds · Lower is faster · 1 of 1 reported sample · 1 timed response'],
      unresolved: '1 reported sample was above 120 tokens/s without an exact speed. It is counted, and the bounds widen to cover it.',
      point: 'Oct 10, 2026 · Output speed · P50 64 (60-71) tokens/s · 1 reported sample · 1 above 120 tokens/s without an exact speed',
      omitted: '1 · 1 reported sample',
    }],
    ['es', {
      sources: '1 contribuyente · 1 instalación',
      summaries: ['tokens/s · Más alto es más rápido · 1 de 1 muestra comunicada · 1 estimación de turno completo',
        'segundos · Más bajo es más rápido · 1 de 1 muestra comunicada · 1 respuesta con tiempo medido'],
      unresolved: '1 muestra comunicada superó los 120 tokens/s sin una velocidad exacta. Se cuenta y los límites se amplían para cubrirla.',
      omitted: '1 · 1 muestra comunicada',
    }],
  ]) {
    const dom = focusHarness();
    const { client } = communityClient(() => structuredClone(single));
    const controller = mountModelPerformance({ ...dom, source: 'community', period: '1', client,
      t: (key, values) => translate(key, values, locale), locale: () => locale });
    try {
      dom.show(); await controller.refresh();
      assert.equal(communityStatus(dom).dataset.state, 'ready', locale);
      assert.deepEqual(textOf(dom, 'performance-unit performance-model-sources'), [expected.sources], locale);
      assert.deepEqual(textOf(dom, 'performance-unit'), expected.summaries, locale);
      assert.deepEqual(textOf(dom, 'performance-method-note performance-unresolved-note'), [expected.unresolved], locale);
      assert.equal(evidenceOf(dom).omitted, expected.omitted, locale);
      if (expected.point) {
        const speed = dom.root.all().find(node => node.tagName === 'svg' && node.listeners.pointermove);
        assert.deepEqual(speed.all().filter(node => node.className === 'performance-point').map(node => node.attributes['aria-label']), [expected.point]);
      }
    } finally { controller.destroy(); }
  }
});

test('community period controls offer Latest UTC day, 7d, 30d and All time and request only the selected slot', async () => {
  const dom = focusHarness();
  const { calls, client } = communityClient();
  const controller = mountModelPerformance({ ...dom, source: 'community', client, t: en });
  try {
    dom.show(); await controller.refresh(); await settle(); await settle();
    const periods = dom.root.all().filter(node => node.dataset.performanceFocus?.startsWith('period-'));
    assert.deepEqual(periods.map(node => [node.dataset.performanceFocus, node.textContent]),
      [['period-1', 'Latest UTC day'], ['period-7', '7d'], ['period-30', '30d'], ['period-all', 'All time']]);
    assert.deepEqual(calls.map(call => [call.period, call.speedMode]), [['all', 'standard']], 'no other period is warmed');
    await dom.find('period-1').listeners.click(); await settle(); await settle();
    assert.deepEqual(calls.map(call => call.period), ['all', '1']);
    assert.equal(dom.find('period-1').attributes['aria-pressed'], 'true');
    assert.deepEqual(textOf(dom, 'performance-mode-note performance-period-note'),
      ['Latest UTC day is the most recent completed UTC calendar day, not a rolling 24 hours.']);
    assert.equal(evidenceOf(dom).period, 'Latest UTC day · Oct 10, 2026');
    const speed = dom.root.all().find(node => node.tagName === 'svg' && node.listeners.pointermove);
    assert.deepEqual(speed.all().filter(node => node.className === 'performance-point').map(node => node.attributes['aria-label']),
      ['Oct 10, 2026 · Output speed · P50 64 (60-71) tokens/s · 2 reported samples']);
    assert.equal(speed.all().find(node => node.className === 'performance-point').children[1].attributes.cx, '380',
      'the single closed day is centred, not drawn as a rolling edge');
    assert.ok(dom.root.all().some(node => node.textContent === en('performance.ttftEmpty')));
    await dom.find('mode-fast').listeners.click(); await settle(); await settle();
    assert.deepEqual(calls.at(-1), { period: '1', speedMode: 'fast', signal: calls.at(-1).signal });
    assert.equal(calls.length, 3, 'a mode switch requests its own slot only');
  } finally { controller.destroy(); }
});

test('community refresh runs every 300 s for the selected slot, reuses fresh slots and never preloads', async () => {
  const dom = focusHarness();
  const { calls, client } = communityClient();
  const controller = mountModelPerformance({ ...dom, source: 'community', client, t: en });
  try {
    assert.equal(calls.length, 0, 'hidden mounts do not request');
    assert.equal(await controller.preload(), false);
    assert.equal(calls.length, 0, 'preload never warms community periods');
    assert.equal(controller.setReportingWindow({ period: '7d', startAt: null, endAt: '2026-10-10T00:00:00.000Z' }), false);
    dom.show(); await controller.refresh(); await settle();
    assert.deepEqual(dom.timerIds().map(id => dom.timerDelay(id)), [300_000]);
    dom.runTimer(dom.timerIds()[0]); await settle(); await settle();
    assert.deepEqual(calls.map(call => call.period), ['all', 'all'], 'the cadence revalidates only the shown slot');
    assert.deepEqual(dom.timerIds().map(id => dom.timerDelay(id)), [300_000]);
    await dom.find('period-7').listeners.click(); await settle(); await settle();
    await dom.find('period-all').listeners.click(); await settle(); await settle();
    assert.deepEqual(calls.map(call => call.period), ['all', 'all', '7'], 'a fresh cached slot is shown without a request');
    assert.equal(dom.timerIds().length, 1);
    assert.ok(dom.timerDelay(dom.timerIds()[0]) <= 300_000);
    dom.navigate(false);
    assert.deepEqual(dom.timerIds(), [], 'an inactive page stops polling');
    dom.navigate(true); await settle();
    assert.equal(calls.length, 3, 'returning within the interval reuses the fresh slot');
    assert.equal(dom.timerIds().length, 1);
  } finally { controller.destroy(); }
  const custom = focusHarness();
  const second = communityClient();
  const tuned = mountModelPerformance({ ...custom, source: 'community', client: second.client, t: en, refreshIntervalMs: 60_000 });
  try {
    custom.show(); await tuned.refresh(); await settle();
    assert.deepEqual(custom.timerIds().map(id => custom.timerDelay(id)), [60_000]);
  } finally { tuned.destroy(); }
  assert.throws(() => mountModelPerformance({ ...focusHarness(), source: 'community', client: second.client, t: en, refreshIntervalMs: 0 }), RangeError);
  assert.throws(() => mountModelPerformance({ ...focusHarness(), source: 'community', client: second.client, t: en, sharedReporting: true }), TypeError);
});

test('community states stay distinct: unpublished, unreadable, unavailable and mismatched slots', async () => {
  const dom = focusHarness();
  let answer = { state: 'none_published', period: 'all', speedMode: 'standard', models: [], omittedModels: null };
  const { client } = communityClient(() => typeof answer === 'function' ? answer() : answer);
  const controller = mountModelPerformance({ ...dom, source: 'community', client, t: en });
  const panel = () => dom.root.all().find(node => node.id === 'performance-model-panel');
  try {
    dom.show(); await controller.refresh();
    assert.equal(communityStatus(dom).dataset.state, 'none');
    assert.equal(communityStatus(dom).textContent, 'No community measurements are published for this period yet.');
    assert.equal(panel(), undefined); assert.equal(dom.find('retry'), undefined);
    answer = communitySlot('all'); await controller.refresh();
    assert.ok(panel());
    answer = () => { throw new Error('synthetic failure'); }; await controller.refresh();
    assert.equal(communityStatus(dom).dataset.state, 'error');
    assert.ok(panel(), 'a transient failure keeps the published slot visible');
    assert.ok(dom.find('retry'));
    answer = { state: 'service_unavailable', period: 'all', speedMode: 'standard', models: [], omittedModels: null };
    await controller.refresh();
    assert.equal(communityStatus(dom).textContent, en('performance.community.failed'));
    assert.ok(panel());
    answer = { state: 'unsupported_schema', period: 'all', speedMode: 'standard', models: [], omittedModels: null };
    await controller.refresh();
    assert.equal(communityStatus(dom).dataset.state, 'unsupported');
    assert.equal(panel(), undefined, 'an unreadable publication withdraws the chart');
    assert.equal(dom.root.all().some(node => node.className?.startsWith('performance-evidence')), false);
    answer = communitySlot('7'); await controller.refresh();
    assert.equal(communityStatus(dom).dataset.state, 'unsupported', 'another slot is never rendered under the requested one');
    answer = communityWireBody(); await controller.refresh();
    assert.equal(communityStatus(dom).dataset.state, 'unsupported', 'an unnormalized body is refused');
    answer = { ...communitySlot('all'), models: [], omittedModels: { models: 2, turns: 9 } };
    await controller.refresh();
    assert.ok(dom.root.all().some(node => node.dataset.state === 'empty' && node.textContent === 'No Standard mode reported samples in this period. Try a longer period or another mode.'));
    assert.equal(evidenceOf(dom).omitted, '2 · 9 reported samples', 'models the catalog cannot name are counted, not hidden');
  } finally { controller.destroy(); }
});

test('local Model performance keeps its DTO path when the source is explicit and refuses unknown sources', async () => {
  const dom = focusHarness();
  const controller = mountModelPerformance({ ...dom, source: 'local', client: { modelPerformance: async () => payload() }, t: en });
  try {
    dom.show(); await controller.refresh();
    assert.equal(dom.root.dataset.performanceSource, undefined);
    assert.deepEqual(dom.root.all().filter(node => node.dataset.performanceFocus?.startsWith('period-')).map(node => node.dataset.performanceFocus),
      ['period-7', 'period-30', 'period-all']);
    assert.deepEqual(textOf(dom, 'performance-provider'), [en('performance.provider')]);
    assert.equal(dom.root.all().some(node => node.className === 'performance-bound-whisker'), false);
  } finally { controller.destroy(); }
  assert.throws(() => mountModelPerformance({ ...focusHarness(), source: 'hosted', client: {}, t: en }), RangeError);
});

test('every locale carries the community performance copy with its placeholders', () => {
  const prefix = 'performance.community.';
  const keys = Object.keys(CATALOGS['en-US']).filter(key => key.startsWith(prefix));
  assert.ok(keys.length >= 28);
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(CATALOGS[locale]).filter(key => key.startsWith(prefix)), keys, locale);
    const values = { date: 'D', method: 'M', values: 'V', count: '7', label: 'P50', value: 'X', estimate: '62', lower: '58', upper: '66',
      unit: 'U', measured: '3', total: '4', estimates: '1', responses: '2', contributors: '5', devices: '6', models: '1', samples: '9', mode: 'Fast' };
    for (const key of keys) {
      const copy = translate(key, values, locale);
      assert.notEqual(copy, key, `${locale}: ${key}`);
      assert.doesNotMatch(copy, /\{/u, `${locale}: ${key}`);
    }
    assert.equal(translate('performance.community.estimateValue', values, locale), '62 (58-66) U');
  }
});

// Shared keys whose local text describes this device's measured turns or saved
// results. Community mode scopes each one to its reported-sample variant.
const LOCAL_ONLY_PERFORMANCE_KEYS = Object.freeze(['standardNote', 'fastNote', 'ultrafastNote', 'unknownMode', 'modeEmpty', 'combinedSpeedEmpty', 'cancelled']);
const PERFORMANCE_MODES = Object.freeze(['standard', 'fast', 'ultrafast']);
const renderedCopy = dom => dom.root.all().flatMap(node => [node.textContent, node.attributes?.['aria-label']])
  .filter(text => typeof text === 'string' && text.length > 0);
const placeholderNames = message => [...message.matchAll(/\{([A-Za-z]+)\}/gu)].map(match => match[1]).sort();
// Every rendering of a key the view can produce: integer counts format as "2" in each supported locale.
const filledCopy = (t, key, mode = 'standard') => t(key, { count: '2', mode: t(`performance.${mode}`) });

test('community mode never renders the local measured-turn or saved-result copy in any locale', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key, values) => translate(key, values, locale);
    for (const key of LOCAL_ONLY_PERFORMANCE_KEYS) {
      assert.deepEqual(placeholderNames(CATALOGS[locale][`performance.community.${key}`]), placeholderNames(CATALOGS[locale][`performance.${key}`]), `${locale}: ${key}`);
      assert.notEqual(filledCopy(t, `performance.community.${key}`), filledCopy(t, `performance.${key}`), `${locale}: ${key}`);
    }
    const local = LOCAL_ONLY_PERFORMANCE_KEYS.flatMap(key => PERFORMANCE_MODES.map(mode => filledCopy(t, `performance.${key}`, mode)));
    const dom = focusHarness(), ultrafast = Promise.withResolvers();
    const { client } = communityClient((period, { speedMode }) => {
      if (speedMode === 'ultrafast') return ultrafast.promise;
      if (speedMode === 'fast') return { ...communitySlot(period, 'fast'), models: [], omittedModels: { models: 0, turns: 0 } };
      const slot = communitySlot(period);
      Object.assign(slot.models[0], { speedTurns: 0, toolFreeTurns: 0, speed: { unit: 'tokens_per_second', points: [] } });
      return slot;
    });
    const controller = mountModelPerformance({ ...dom, source: 'community', client, t });
    const seen = [];
    try {
      dom.show(); await controller.refresh(); await settle();
      let copy = renderedCopy(dom); seen.push(...copy);
      for (const key of ['standardNote', 'unknownMode', 'combinedSpeedEmpty'])
        assert.ok(copy.includes(filledCopy(t, `performance.community.${key}`)), `${locale}: ${key}`);
      dom.find('mode-fast').listeners.click(); await settle(); await settle();
      copy = renderedCopy(dom); seen.push(...copy);
      assert.ok(copy.includes(filledCopy(t, 'performance.community.fastNote')), locale);
      assert.ok(copy.includes(filledCopy(t, 'performance.community.unknownMode')), locale);
      assert.ok(dom.root.all().some(node => node.dataset.state === 'empty' && node.textContent === filledCopy(t, 'performance.community.modeEmpty', 'fast')), locale);
      dom.find('mode-ultrafast').listeners.click(); await settle();
      dom.find('cancel').listeners.click();
      copy = renderedCopy(dom); seen.push(...copy);
      assert.equal(communityStatus(dom).dataset.state, 'cancelled');
      assert.equal(communityStatus(dom).textContent, filledCopy(t, 'performance.community.cancelled'), locale);
      assert.ok(copy.includes(filledCopy(t, 'performance.community.ultrafastNote')), locale);
      for (const text of seen) for (const phrase of local)
        assert.equal(text.includes(phrase), false, `${locale}: community copy "${text}" reuses local "${phrase}"`);
      if (locale === 'en-US') for (const text of seen)
        assert.doesNotMatch(text, /measured turns|turns measured|Excluded turns|Saved results|single-response turn/u);
    } finally { controller.destroy(); ultrafast.resolve(null); }
  }
});

test('local mode keeps its measured-turn and saved-result copy byte for byte', async () => {
  // Literal pins: scoping community copy must not change the local view's text.
  const pinned = {
    standardNote: 'Only Standard mode measurements.',
    fastNote: 'Only Fast mode measurements. Coverage may be sparse; hollow points have fewer than 5 measured turns.',
    ultrafastNote: 'Only Ultrafast mode measurements. Coverage may be sparse; hollow points have fewer than 5 measured turns.',
    unknownMode: 'Excluded turns (unknown or mixed speed mode): 2.',
    modeEmpty: 'No Fast mode measurements in this period. Try a longer period or another mode.',
    combinedSpeedEmpty: 'No output-speed measurement for this model in this period. Compatible response timing or a complete single-response turn without tools is required.',
    cancelled: 'Measurement update cancelled. Saved results remain visible when available.',
  };
  for (const locale of SUPPORTED_LOCALES) {
    const t = (key, values) => translate(key, values, locale);
    const expected = Object.fromEntries(LOCAL_ONLY_PERFORMANCE_KEYS.map(key => [key, filledCopy(t, `performance.${key}`, key === 'modeEmpty' ? 'fast' : 'standard')]));
    if (locale === 'en-US') assert.deepEqual(expected, pinned);
    const community = LOCAL_ONLY_PERFORMANCE_KEYS.flatMap(key => PERFORMANCE_MODES.map(mode => filledCopy(t, `performance.community.${key}`, mode)));
    const dom = focusHarness(), ultrafast = Promise.withResolvers();
    const { client } = performanceClient((period, { speedMode }) => {
      if (speedMode === 'ultrafast') return ultrafast.promise;
      if (speedMode === 'fast') return modePayload(period, speedMode, { models: [], excludedUnknownTurns: 2 });
      const data = modePayload(period, speedMode, { excludedUnknownTurns: 2 });
      Object.assign(data.models[0], { speedTurns: 0, speed: [] });
      return data;
    });
    const controller = mountModelPerformance({ ...dom, client, t });
    const seen = [];
    try {
      dom.show(); await controller.refresh(); await settle();
      let copy = renderedCopy(dom); seen.push(...copy);
      for (const key of ['standardNote', 'unknownMode', 'combinedSpeedEmpty']) assert.ok(copy.includes(expected[key]), `${locale}: ${key}`);
      dom.find('mode-fast').listeners.click(); await settle(); await settle();
      copy = renderedCopy(dom); seen.push(...copy);
      for (const key of ['fastNote', 'unknownMode', 'modeEmpty']) assert.ok(copy.includes(expected[key]), `${locale}: ${key}`);
      dom.find('mode-ultrafast').listeners.click(); await settle();
      controller.cancel();
      copy = renderedCopy(dom); seen.push(...copy);
      for (const key of ['ultrafastNote', 'cancelled']) assert.ok(copy.includes(expected[key]), `${locale}: ${key}`);
      for (const text of seen) for (const phrase of community)
        assert.equal(text.includes(phrase), false, `${locale}: local copy "${text}" borrows community "${phrase}"`);
    } finally { controller.destroy(); ultrafast.resolve(null); }
  }
});
