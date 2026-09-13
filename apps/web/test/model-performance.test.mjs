import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelPerformance, performanceSegments, performanceDomain, performanceYScale, performanceDateTicks, performanceHoverBin, mountModelPerformance } from '../public/model-performance.js';
import { LocalCompanionClient } from '../public/data-client.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';
const DAY = 86400000;
const point = (at = 2 * DAY, n = 5) => ({ at, n,
  p10: n < 5 ? null : 30, p25: n < 5 ? null : 40, median: 50,
  p75: n < 5 ? null : 60, p90: n < 5 ? null : 70 });
function payload() {
  return { schemaVersion: 2, method: 3, status: 'ready', collecting: false, stale: false, updatedAt: '2026-09-09T12:00:00.000Z', period: 'all', interval: 'day', start: DAY, end: 9 * DAY, historyProgress: null,
    models: [{ id: 'gpt-5.6-sol', label: 'Sol', turns: 20, speedTurns: 10, ttftTurns: 15, timedResponses: 45,
      speed: [{ method: 'speed', points: [point(), point(3 * DAY)] }], ttft: [point(), point(3 * DAY), point(4 * DAY)] }] };
}
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
  assert.equal(calls[0][0], '/api/local/model-performance?period=all');
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[0][1].headers['X-Usage-Monitor-Local'], '1');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.throws(() => client.modelPerformance('bad&secret=x'), RangeError);
  const failed = new LocalCompanionClient({ fetchImpl: async () => ({ok: false, status: 404, json: async () => ({})}) });
  await assert.rejects(() => failed.modelPerformance('7'));
});
test('every supported locale preserves coverage and measurement meaning', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ['title', 'speedEmpty', 'ttftEmpty', 'methodology', 'variance', 'speedSummary', 'latencySummary', 'outerBand', 'innerBand', 'medianP50', 'percentileValues', 'percentilesUnavailable', 'buildingHistory', 'unavailable', 'stale']) {
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
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => { timers.delete(id); },
    MutationObserver: class { constructor(callback) { visibilityObserver = callback; } observe() {} disconnect() {} },
  };
  return { root, documentRef, windowRef, show: () => { inactive = false; },
    navigate: (shown) => { inactive = !shown; visibilityObserver?.(); },
    find: key => root.all().find(node => node.dataset.performanceFocus === key),
    timerIds: () => [...timers.keys()], runTimer: id => timers.get(id)?.(),
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
  const data = { ...payload(), collecting: true, historyProgress: { checked: 629, total: 9026 } };
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(dom.root.all().find(node => node.className === 'performance-status').textContent,
    'Building earlier history · 629 of 9,026 sessions checked');
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  controller.destroy();
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
    'tokens/s · Higher is faster · 10 of 20 turns measured',
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
    'tokens/s · Higher is faster · 10 of 20 turns measured',
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
