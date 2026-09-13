import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportingPeriod, reportingSelection } from '../public/reporting-period.js';
const endAt = '2026-09-10T12:34:56.000Z';
const startAt = '2026-09-03T12:34:56.000Z';

test('one allowlisted period persists while missing evidence never changes it', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const changes = [];
  const state = createReportingPeriod({ storage, onChange: period => changes.push(period) });
  assert.equal(state.period, '7d');
  assert.equal(state.select('private value'), false);
  assert.equal(state.select('30d'), true);
  assert.equal(state.select('30d'), false);
  assert.deepEqual(changes, ['30d']);
  assert.equal(createReportingPeriod({ storage }).period, '30d');
  const selection = reportingSelection({ generatedAt: endAt, accounting: { periods: [{ periodId: '7d' }] } }, state.period);
  assert.equal(selection.period, '30d');
  assert.equal(selection.accountingPeriod, null);
  assert.equal(selection.window.endAt, endAt);
  assert.equal(selection.window.startAt, '2026-08-11T12:34:56.000Z');
});

test('accounting snapshot bounds anchor every view even when newest observation is older', () => {
  const data = { generatedAt: '2026-09-11T00:00:00.000Z', freshness: { latestObservedAt: startAt }, accounting: {
    periods: [{ periodId: '7d', reportingWindow: { startAt, endAt } }],
  } };
  assert.deepEqual(reportingSelection(data, '7d'), { period: '7d', accountingPeriod: '7d', window: { period: '7d', startAt, endAt } });
  assert.equal(reportingSelection(data, '24h').accountingPeriod, null);
});

test('all available history selects its authoritative snapshot without implying complete coverage', () => {
  const data = { accounting: { periods: [
    { periodId: 'all', reportingWindow: { startAt: null, endAt: startAt } },
    { periodId: 'history', reportingWindow: { startAt: null, endAt } },
  ] } };
  assert.deepEqual(reportingSelection(data, 'all'), { period: 'all', accountingPeriod: 'history', window: { period: 'all', startAt: null, endAt } });
  assert.equal(reportingSelection(null, 'all').window, null);
});

test('blocked preference storage leaves the reporting control usable', () => {
  const state = createReportingPeriod({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.equal(state.select('24h'), true);
  assert.equal(state.period, '24h');
});

test('normalization preserves explicit reporting bounds and rejects mismatched durations', async () => {
  const { normalizeDashboardPayload } = await import('../public/data-client.js');
  const normalize = reportingWindow => normalizeDashboardPayload({ generatedAt: endAt, accounting: {
    periods: [{ periodId: '7d', reportingWindow }],
  } }).accounting.periods[0].reportingWindow;
  assert.deepEqual(normalize({ startAt, endAt }), { startAt, endAt });
  assert.equal(normalize({ startAt: endAt, endAt }), null);
  assert.equal(normalize({ startAt: null, endAt }), null);
  assert.equal(normalize({ startAt, endAt: 'not a date' }), null);
});

test('unavailable selected accounting clears previous model totals and coverage', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderAccountingModels(');
  const end = source.indexOf('\nfunction ', start + 10);
  const table = { children: [{ textContent: 'previous total' }], append(row) { this.children.push(row); } };
  const coverage = { textContent: 'previous coverage', hidden: false };
  const makeNode = () => ({ children: [], append(child) { this.children.push(child); } });
  const render = Function('$', 'clear', 'setRawText', 'modelUsageRows', 'pricingCoverageNote',
    'paginateCacheImpactRows', 'accountingModelsTablePagination', 'cacheImpactTableSignature',
    'renderCacheImpactPagination', 'node', 'localizedNode',
    `${source.slice(start, end)}; return renderAccountingModels;`)(
    selector => selector === '#accounting-models' ? table : coverage,
    node => { node.children = []; }, (node, text) => { node.textContent = text; },
    () => { throw Error('must not borrow previous models'); },
    () => { throw Error('must not borrow previous coverage'); },
    () => ({ rows: [] }), {}, () => '', () => {}, makeNode,
    (_tag, _class, key) => ({ key }),
  );
  render({ totalTokens: 999 }, { unavailable: true });
  assert.equal(coverage.hidden, true);
  assert.equal(coverage.textContent, '');
  assert.equal(table.children.length, 1);
  assert.equal(table.children[0].children[0].key, 'accounting.model.unavailable');
});
