import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelPerformance, performanceSegments, performanceDomain, performanceYScale, performanceDateTicks, performanceHoverBin, mountModelPerformance } from '../public/model-performance.js';
import { LocalCompanionClient } from '../public/data-client.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';
const DAY = 86400000;
const point = (at = 2 * DAY, n = 5) => ({ at, n, median: 50, p25: n < 5 ? null : 40, p75: n < 5 ? null : 60 });
function payload() {
  return { schemaVersion: 1, method: 2, status: 'ready', collecting: false, stale: false, updatedAt: '2026-09-09T12:00:00.000Z', period: 'all', interval: 'day', start: DAY, end: 9 * DAY,
    models: [{ id: 'gpt-5.6-sol', label: 'Sol', turns: 20, speedTurns: 10, ttftTurns: 15, timedResponses: 45,
      speed: [{ method: 'receipt', points: [point()] }, { method: 'legacy', points: [point(3 * DAY)] }], ttft: [point(), point(3 * DAY), point(4 * DAY)] }] };
}
test('bounded contract preserves independent populations and separate reconstruction methods', () => {
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
    x => { x.period = '365'; }, x => { x.models[0].label = '<img>'; },
    x => { x.models[0].id = 'private-thread'; },
    x => { x.models.push(x.models[0]); },
    x => { x.models[0].speed.push(x.models[0].speed[0]); },
    x => { x.models[0].speedTurns = 2; },
    x => { x.models[0].ttftTurns = 30; },
    x => { x.models[0].speed[0].points[0].median = NaN; },
    x => { x.models[0].speed[0].points[0].p75 = 30; },
    x => { x.models[0].speed[0].points[0].n = 1; },
    x => { x.models[0].ttft[1].at = x.models[0].ttft[0].at; },
    x => { x.models[0].ttft[0].at = x.end + DAY; },
    x => { x.models[0].ttft = Array.from({length: 2049}, () => point()); },
  ]) { const data = payload(); mutate(data); assert.equal(normalizeModelPerformance(data), null); }
});
test('zero latency is real while missing speed remains absent; sparse bins have no band', () => {
  const data = payload(); data.models[0].ttft = [{ at: DAY, n: 1, median: 0, p25: null, p75: null }];
  assert.equal(normalizeModelPerformance(data), data);
  data.models[0].ttft[0].p25 = 0;
  assert.equal(normalizeModelPerformance(data), null);
});
test('only bounded gaps are joined; sparse observation points are retained', () => {
  const points = [point(DAY, 1), point(2 * DAY, 2), point(5 * DAY), point(20 * DAY)];
  assert.deepEqual(performanceSegments(points, 'day').map(x => x.dashed), [false, true]);
  assert.deepEqual(performanceSegments([point(DAY), point(8 * DAY), point(22 * DAY), point(43 * DAY)], 'week').map(x => x.dashed), [false, true]);
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
    for (const key of ['title', 'speedEmpty', 'ttftEmpty', 'methodology', 'variance', 'unavailable', 'stale']) {
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
  selected.speed[0].points = [point(6 * DAY)];
  selected.speed[1].points = [point(7 * DAY)];
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
  let inactive = true;
  const documentRef = { activeElement: null, hidden: false,
    addEventListener() {}, removeEventListener() {} };
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
    setTimeout: () => 1, clearTimeout() {},
    MutationObserver: class { observe() {} disconnect() {} },
  };
  return { root, documentRef, windowRef, show: () => { inactive = false; },
    find: key => root.all().find(node => node.dataset.performanceFocus === key) };
}

test('loading and background renders retain heading and disclosure keyboard focus', async () => {
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
  dom.find('table').focus();
  const previousTable = dom.documentRef.activeElement;
  response = structuredClone(response); response.models[0].turns++;
  await controller.refresh();
  assert.notEqual(dom.documentRef.activeElement, previousTable);
  assert.equal(dom.documentRef.activeElement, dom.find('table'), 'new background data retains table disclosure focus');
  assert.deepEqual(dom.documentRef.activeElement.focusOptions, { preventScroll: true });
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
  const readouts = () => dom.root.all().filter(node => node.className === 'sr-only performance-readout');
  // Jan3 = first measured day. Pointer near the top, far from its actual point.
  svgs[0].listeners.pointermove({ clientX: 52, clientY: 30 });
  assert.ok(readouts().every(node => node.textContent.includes('Median 50')));
  svgs[0].listeners.pointermove({ clientX: 52, clientY: 200 });
  assert.ok(readouts().every(node => node.textContent.includes('Median 50')), 'vertical position never changes selected date');
  svgs[0].listeners.pointermove({ clientX: 52 + 730 * 4/7, clientY: 100 });
  assert.ok(readouts().every(node => node.textContent.includes('No measurements')), 'missing day never borrows a nearby observation');
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
