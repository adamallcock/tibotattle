import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TELEMETRY_SCHEMA_VERSION } from '@app-usagemonitor/telemetry-contract';
import { priceCodexUsageEvent } from '@app-usagemonitor/accounting';
import { HISTORICAL_SOL_FIXTURE, assertHistoricalSolAccounting, assertHistoricalSolRendered,
  assertHistoricalSolTargets, historicalSolQualificationReceipt, observeHistoricalSolPass, prepareHistoricalSolFixture,
  readHistoricalSolState, waitForHistoricalSolRefresh } from '../scripts/lib/macos-historical-sol-qualification.mjs';
import { signedStagingFixture } from '../scripts/run-signed-electron-staging.mjs';
import { ingestLocalUnifiedIndexIncrement } from '../src/local-unified-index-ingest.js';
import { openLocalUnifiedIndex } from '../src/local-unified-index.js';
import { localCompanionStatePaths } from '../src/local-installation-diagnostics.js';
import { createLocalCollectorRefreshRunner, LocalCompanionRefreshController } from '../src/local-companion-refresh.js';
import { buildLocalCompanionSnapshot, LocalCompanionDataStore } from '../src/local-companion-data.js';
import { readAuthoritativeDashboardSnapshot } from '../src/local-authoritative-dashboard-snapshot.js';
import { refreshReplaySafeAccountingCache } from '../src/replay-safe-accounting-cache.js';

const OLD_ID = '71000000-0000-4000-8000-000000000018';
const NEW_ID = '71000000-0000-4000-8000-000000000019';
const refused = stage => error => error.message === 'MAC_HISTORICAL_SOL_QUALIFICATION_REFUSED'
  && error.credentialStage === `historical_sol_${stage}`;

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'historical-sol-synthetic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = await realpath(directory);
  const profile = join(home, 'Library', 'Application Support', 'TiboTattle');
  const codexHome = join(home, '.codex');
  await mkdir(join(profile, 'companion-state'), { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, 'sessions'), { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, 'sessions', 'rollout-credential-synthetic.jsonl'),
    signedStagingFixture(Date.parse('2026-10-03T12:00:00.000Z')), { mode: 0o600, flag: 'wx' });
  return { home, profile, codexHome, ...localCompanionStatePaths(join(profile, 'companion-state')) };
}

const prepare = value => prepareHistoricalSolFixture({ ...value, predecessorRefreshId: OLD_ID },
  { admitHost: () => value.home });
const ingest = value => ingestLocalUnifiedIndexIncrement({ codexHome: value.codexHome,
  indexFile: value.unifiedIndexFile, secretFile: value.unifiedIndexSecretFile,
  contractVersion: TELEMETRY_SCHEMA_VERSION });

test('fixed historical fixture is Standard short context at the reviewed effective interval and has visible nonzero cost', () => {
  const components = { input_uncached_tokens: 10_000, input_cache_read_tokens: 90_000,
    input_cache_write_tokens: 0, output_text_tokens: 10_000, output_reasoning_tokens: 0 };
  const event = { timestamp: HISTORICAL_SOL_FIXTURE.observedAt, model: HISTORICAL_SOL_FIXTURE.model,
    totalInputContextTokens: HISTORICAL_SOL_FIXTURE.totalInputContext, components,
    componentAvailability: Object.fromEntries(Object.keys(components).map(key => [key, true])) };
  const priced = priceCodexUsageEvent(event, { apiServiceTier: 'standard' });
  assert.equal(priced.totalUsd, '0.129');
  assert.equal(priced.coverageStatus, 'fully_priced');
  assert.equal(HISTORICAL_SOL_FIXTURE.window.period, 'all');
  assert.ok(Date.parse(HISTORICAL_SOL_FIXTURE.window.startAt) < Date.parse(event.timestamp));
  assert.ok(Date.parse(HISTORICAL_SOL_FIXTURE.window.endAt) > Date.parse(event.timestamp));
  assert.notEqual(priceCodexUsageEvent({ ...event, timestamp: '2026-09-28T23:59:59.999Z' }).coverageStatus, 'fully_priced');
  assert.notEqual(priceCodexUsageEvent({ ...event, totalInputContextTokens: 272_001 }).totalUsd, '0.129');
});

test('actual public APIs repair once, replay safely and preserve priced history through fresh quick restarts', async t => {
  const value = await profile(t), context = await prepare(value);
  await assert.rejects(readHistoricalSolState(context), refused('repair_missing'));
  assert.throws(() => historicalSolQualificationReceipt(context), refused('proof_incomplete'));
  const now = () => Date.parse('2026-10-04T00:00:00.000Z');
  const passes = [];
  const runner = createLocalCollectorRefreshRunner({ codexHome: value.codexHome,
    stateFile: value.collectorStateFile, unifiedIndexFile: value.unifiedIndexFile,
    unifiedIndexSecretFile: value.unifiedIndexSecretFile, accountingSourceMode: 'unified', clock: now,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    // Quota/Keychain are outside this domain proof. All indexing, pricing,
    // persistence and HTTP-shaped projections below use the owning APIs.
    runCollector: async () => ({ rolloutRecordsWritten: 0, filesDiscovered: 0,
      refresh: { attempted: false, recordWritten: false, errorCode: null } }),
    refreshUnifiedIndex: async options => {
      const result = await ingestLocalUnifiedIndexIncrement({ ...options, contractVersion: TELEMETRY_SCHEMA_VERSION });
      passes.push(result); return result;
    },
    refreshAccounting: options => refreshReplaySafeAccountingCache({ ...options, rebuildIsolation: 'in_process' }),
  });
  const createDataStore = () => new LocalCompanionDataStore({ snapshotFile: value.authoritativeDashboardSnapshotFile,
    snapshotNow: now, builder: options => buildLocalCompanionSnapshot({ ...options,
    root: value.home, codexHome: value.codexHome, collectorStateFile: value.collectorStateFile,
    unifiedIndexFile: value.unifiedIndexFile, accountingSourceMode: 'unified',
    unifiedProjectionMode: ['startup', 'quick'].includes(options?.purpose) ? 'deferred' : 'full',
    allowDevelopmentArtifactFallback: false, now }) });
  const dataStore = createDataStore();
  const controller = new LocalCompanionRefreshController({ runner, dataStore, clock: now, createRefreshId: () => NEW_ID });
  assert.equal(controller.start({ mode: 'detailed' }), true);
  const refresh = await waitForHistoricalSolRefresh(() => controller.getStatus(), OLD_ID, { timeoutMs: 30_000 });
  const state = await readHistoricalSolState(context), overview = dataStore.getOverview();
  assert.equal(passes[0].sourcesReparsedForParserVersion, 1);
  assert.equal(state.totalTokens, 110_248);
  assert.equal(assertHistoricalSolAccounting({ refresh, overview, state }), true);
  // Only the DOM adapter is synthetic here; refresh/overview/state assertions
  // still consume the owning APIs. Real rendering belongs to the installed gate.
  const dashboardFor = (current, store = dataStore) => ({ async evaluate(script) {
    if (script.includes("fetch('/api/local/refresh'")) return current.getStatus();
    if (script.includes("fetch('/api/local/overview'")) return store.getOverview();
    if (script.includes('[data-nav="method"]')) return true;
    const row = store.getOverview().accounting.periods.find(period => period.periodId === 'history')
      .modelUsage.find(model => model.model === HISTORICAL_SOL_FIXTURE.model);
    return { period: 'all', pageVisible: true, modelRows: 1, model: row.model,
      label: HISTORICAL_SOL_FIXTURE.label, events: String(row.events), totalTokens: String(row.totalTokens),
      cost: `$${row.apiPriceEquivalentUsd.toFixed(2)}`, costUnavailable: false };
  } });
  await observeHistoricalSolPass({ dashboard: dashboardFor(controller), context, phase: 'repair' });
  assert.throws(() => historicalSolQualificationReceipt(context), refused('proof_incomplete'));
  // Decisive negative projections are mutated from real API evidence, rather
  // than independently invented objects that merely match helper assumptions.
  const broken = structuredClone(overview);
  const model = broken.accounting.periods.find(period => period.periodId === 'history')
    .modelUsage.find(row => row.model === HISTORICAL_SOL_FIXTURE.model);
  model.apiPriceEquivalentUsd = 0;
  assert.throws(() => assertHistoricalSolAccounting({ refresh, overview: broken, state }), refused('accounting_invalid'));
  const duplicated = structuredClone(overview);
  duplicated.accounting.periods.find(period => period.periodId === 'history').events += 1;
  assert.throws(() => assertHistoricalSolAccounting({ refresh, overview: duplicated, state }), refused('accounting_invalid'));

  const nextId = '71000000-0000-4000-8000-000000000020';
  const next = new LocalCompanionRefreshController({ runner, dataStore, clock: now, createRefreshId: () => nextId });
  assert.equal(next.start({ mode: 'detailed' }), true);
  const repeated = await waitForHistoricalSolRefresh(() => next.getStatus(), NEW_ID, { timeoutMs: 30_000 });
  const retained = await readHistoricalSolState(context);
  assert.equal(passes[1].sourcesReparsedForParserVersion, 0);
  assert.equal(passes[1].insertedUsageEvents, 0);
  assert.equal(retained.generation, state.generation);
  assert.equal(assertHistoricalSolAccounting({ refresh: repeated, overview: dataStore.getOverview(), state: retained,
    repeat: true, previousGeneration: state.generation }), true);
  await observeHistoricalSolPass({ dashboard: dashboardFor(next), context, phase: 'repeat', previousGeneration: state.generation });
  const replayed = structuredClone(repeated); replayed.result.unifiedIndex.insertedUsageEvents = 1;
  assert.throws(() => assertHistoricalSolAccounting({ refresh: replayed, overview: dataStore.getOverview(), state: retained,
    repeat: true, previousGeneration: state.generation }), refused('replay_changed'));
  for (const suffix of ['021', '022']) {
    const saved = await readAuthoritativeDashboardSnapshot({ snapshotFile: value.authoritativeDashboardSnapshotFile });
    assert.equal(saved.snapshot.overview.accounting.generationMatched, true);
    // Match the composition root's deferred startup. It retains Usage figures
    // but deliberately does not reuse the saved snapshot's CURRENT truth.
    const restartedStore = createDataStore();
    await restartedStore.initialize({ purpose: 'startup' });
    assert.equal(restartedStore.getOverview().accounting.generationMatched, false);
    assert.equal(restartedStore.getOverview().accounting.accountingCacheStatus, 'unavailable');
    assert.equal(restartedStore.getOverview().accounting.projection.status, 'retained');
    const restarted = new LocalCompanionRefreshController({ runner, dataStore: restartedStore, clock: now,
      createRefreshId: () => `71000000-0000-4000-8000-000000000${suffix}` });
    const beforeQuickIngests = passes.length;
    assert.equal(restarted.start({ mode: 'quick' }), true);
    await waitForHistoricalSolRefresh(() => restarted.getStatus(), null, { allowQuick: true, timeoutMs: 30_000 });
    const quick = restarted.getStatus();
    assert.equal(quick.mode, 'quick');
    assert.equal(Object.hasOwn(quick.result, 'unifiedIndex'), false);
    assert.equal(Object.hasOwn(quick.result, 'accounting'), false);
    assert.equal(passes.length, beforeQuickIngests, 'quick startup does not ingest or reparse');
    assert.throws(() => assertHistoricalSolAccounting({ refresh: quick, overview: restartedStore.getOverview(), state }),
      refused('accounting_invalid'), 'quick completion cannot prove initial repair');
    let current = restarted, detailedActions = 0, retainedRenderingSeen = false;
    const dashboard = dashboardFor({ getStatus: () => current.getStatus() }, restartedStore);
    const evaluate = dashboard.evaluate;
    dashboard.evaluate = async script => {
      const result = await evaluate(script);
      if (script.includes('const rows =') && current === restarted) {
        retainedRenderingSeen = true;
        assert.equal(result.cost, '$0.13');
        assert.equal(restartedStore.getOverview().accounting.generationMatched, false);
      }
      return result;
    };
    await observeHistoricalSolPass({ dashboard, context, phase: 'restart', previousGeneration: state.generation,
      refreshDetailed: async () => {
        assert.equal(retainedRenderingSeen, true, 'retained Usage was proved before the user detailed action');
        detailedActions += 1;
        current = new LocalCompanionRefreshController({ runner, dataStore: restartedStore, clock: now,
          createRefreshId: () => `71000000-0000-4000-8000-000000000${String(Number(suffix) + 10).padStart(3, '0')}` });
        assert.equal(current.start({ mode: 'detailed' }), true);
        await waitForHistoricalSolRefresh(() => current.getStatus(), quick.refreshId, { timeoutMs: 30_000 });
      } });
    assert.equal(detailedActions, 1);
    assert.equal(passes.length, beforeQuickIngests + 1);
    assert.equal(passes.at(-1).sourcesReparsedForParserVersion, 0);
    assert.equal(passes.at(-1).insertedUsageEvents, 0);
    assert.equal(restartedStore.getOverview().accounting.generationMatched, true);
  }
  assert.deepEqual(historicalSolQualificationReceipt(context), {
    schemaVersion: 'tibotattle-historical-sol-installed-v1', observedAt: '2026-09-29T12:00:01.000Z', reportingPeriod: 'all',
    preUpgradeUnknownSeeded: true, parser18To19Repair: true, sourceOccurrenceIdentityPreserved: true,
    tokenTotalsPreserved: true, existingKnownFixturePreserved: true, currentAccountingGenerationMatched: true,
    exactApiPriceEquivalentUsd: '0.129', renderedModel: 'gpt-6.1-sol', renderedUsd: '0.13',
    repeatedRefreshWithoutDuplicatesOrReparse: true, retainedAcrossTwoRestarts: true,
  });
});

test('persisted occurrence identity, token totals and parser repair are mandatory', async t => {
  const value = await profile(t), context = await prepare(value);
  await ingest(value);
  const database = openLocalUnifiedIndex(value.unifiedIndexFile);
  try {
    const selected = database.prepare(`SELECT u.event_key,u.tokens_in_uncached,u.source_offset FROM usage_event u
      JOIN model m ON m.id=u.model_id WHERE m.model_id='gpt-6.1-sol'`).get();
    database.prepare('UPDATE usage_event SET tokens_in_uncached=tokens_in_uncached+1 WHERE event_key=?').run(selected.event_key);
    await assert.rejects(readHistoricalSolState(context), refused('identity_or_totals_changed'));
    database.prepare('UPDATE usage_event SET tokens_in_uncached=?,source_offset=source_offset+1 WHERE event_key=?')
      .run(selected.tokens_in_uncached, selected.event_key);
    await assert.rejects(readHistoricalSolState(context), refused('identity_or_totals_changed'));
    database.prepare('UPDATE usage_event SET source_offset=? WHERE event_key=?').run(selected.source_offset, selected.event_key);
    database.prepare(`UPDATE usage_event SET model_id=(SELECT id FROM model WHERE model_id='unknown') WHERE event_key=?`)
      .run(selected.event_key);
    await assert.rejects(readHistoricalSolState(context), refused('repair_missing'));
  } finally { database.close(); }
});

test('qualification refuses unrelated profiles, extra sources, aliases and unsafe index permissions before fixture writes', async t => {
  const value = await profile(t);
  await assert.rejects(assertHistoricalSolTargets({ ...value, profile: value.home }), refused('unsafe_target'));
  const extra = join(value.codexHome, 'sessions', 'unowned.jsonl');
  await writeFile(extra, '', { mode: 0o600 });
  await assert.rejects(prepare(value), refused('unsafe_source_set'));
  await rm(extra);
  const source = join(value.codexHome, 'sessions', 'rollout-credential-synthetic.jsonl');
  const copy = join(value.home, 'synthetic-copy.jsonl');
  await link(source, copy);
  await assert.rejects(prepare(value), refused('unsafe_target'));
  await rm(copy);
  await rm(source);
  await writeFile(copy, signedStagingFixture(), { mode: 0o600 });
  await symlink(copy, source);
  await assert.rejects(prepare(value), refused('unsafe_target'));
  await rm(source);
  await writeFile(source, signedStagingFixture(), { mode: 0o600 });
  await ingest(value);
  await chmod(value.unifiedIndexFile, 0o644);
  await assert.rejects(prepare(value), refused('unsafe_target'));
});

test('distinct detailed completion waits through stale predecessor/restart success and a new running projection', async () => {
  let clock = 0, reads = 0;
  const sequence = [{ refreshId: OLD_ID, mode: 'detailed', status: 'succeeded' },
    { refreshId: NEW_ID, mode: 'quick', status: 'succeeded' },
    { refreshId: NEW_ID, mode: 'detailed', status: 'running' },
    { refreshId: NEW_ID, mode: 'detailed', status: 'succeeded' }];
  const result = await waitForHistoricalSolRefresh(() => sequence[reads++], OLD_ID,
    { now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 1_000 });
  assert.equal(result, sequence[3]); assert.equal(reads, 4);
  const quickSequence = [{ refreshId: OLD_ID, mode: 'detailed', status: 'succeeded' },
    { refreshId: NEW_ID, mode: 'quick', status: 'running' },
    { refreshId: NEW_ID, mode: 'quick', status: 'succeeded' }];
  reads = 0;
  assert.equal(await waitForHistoricalSolRefresh(() => quickSequence[reads++], OLD_ID,
    { now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 1_000, allowQuick: true }), quickSequence[2]);
  await assert.rejects(waitForHistoricalSolRefresh(() => sequence[0], OLD_ID,
    { now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 200 }), refused('refresh_timeout'));
  await assert.rejects(waitForHistoricalSolRefresh(() => ({ refreshId: NEW_ID, mode: 'detailed', status: 'failed' }), OLD_ID),
    refused('refresh_failed'));
});

test('rendered All history requires exact Sol identity, conserved counts and visibly priced USD', () => {
  const rendered = { period: 'all', pageVisible: true, modelRows: 1, model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol',
    events: '1', totalTokens: '110,000', cost: '$0.13', costUnavailable: false };
  assert.equal(assertHistoricalSolRendered(rendered), true);
  for (const change of [{ model: 'unknown' }, { label: 'Unknown' }, { modelRows: 2 }, { totalTokens: '110,001' },
    { cost: '$0.00' }, { costUnavailable: true }, { period: '7d' }, { pageVisible: false }]) {
    assert.throws(() => assertHistoricalSolRendered({ ...rendered, ...change }), refused('rendered_usage_invalid'));
  }
  assert.throws(() => historicalSolQualificationReceipt({}), refused('proof_incomplete'));
});
