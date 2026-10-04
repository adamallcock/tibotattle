// Disposable signed-app qualification only. No CLI and no production imports.
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TELEMETRY_SCHEMA_VERSION } from '@app-usagemonitor/telemetry-contract';
import { ingestLocalUnifiedIndexIncrement } from '../../src/local-unified-index-ingest.js';
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor } from '../../src/local-unified-index.js';
import { localCompanionStatePaths } from '../../src/local-installation-diagnostics.js';
import { validateSparkleTransitionHost } from '../smoke-electron-macos-sparkle-transition.mjs';

const SESSION = '71000000-0000-4000-8000-000000000061';
const SOURCE = `rollout-2026-09-29T12-00-00-${SESSION}.jsonl`;
const KNOWN_SOURCE = 'rollout-credential-synthetic.jsonl';
const OLD_PARSER = 'unified-rollout-typed-v18';
const CURRENT_PARSER = 'unified-rollout-typed-v19';
const REFRESH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const contexts = new WeakMap();
const fail = stage => { throw Object.assign(new Error('MAC_HISTORICAL_SOL_QUALIFICATION_REFUSED'),
  { credentialStage: `historical_sol_${stage}` }); };

// September 29 is inside the reviewed Standard card's effective interval.
// Context 100,000 <= 272,000; 10,000*2 + 90,000*.1 + 10,000*10 per million
// yields exactly .129 USD, which the ordinary table visibly rounds to .13 USD.
export const HISTORICAL_SOL_FIXTURE = Object.freeze({
  schemaVersion: 'tibotattle-historical-sol-installed-v1', model: 'gpt-6.1-sol',
  label: 'GPT-6.1 Sol', observedAt: '2026-09-29T12:00:01.000Z',
  window: Object.freeze({ period: 'all', startAt: '2026-09-29T12:00:00.000Z', endAt: '2026-09-29T12:00:02.000Z' }),
  events: 1, totalTokens: 110_000, totalInputContext: 100_000,
  apiPriceEquivalentUsd: .129, apiPriceEquivalentUsdExact: '0.129', renderedUsd: '0.13',
});

export function historicalSolSource() {
  const tokens = { input_tokens: 100_000, cached_input_tokens: 90_000,
    cache_write_input_tokens: 0, output_tokens: 10_000,
    reasoning_output_tokens: 0, total_tokens: HISTORICAL_SOL_FIXTURE.totalTokens };
  return [
    { timestamp: HISTORICAL_SOL_FIXTURE.window.startAt, type: 'session_meta', payload: { id: SESSION } },
    { timestamp: HISTORICAL_SOL_FIXTURE.window.startAt, type: 'turn_context',
      payload: { model: HISTORICAL_SOL_FIXTURE.model, effort: 'low', service_tier: 'default' } },
    { timestamp: HISTORICAL_SOL_FIXTURE.observedAt, type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: tokens, last_token_usage: tokens } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

async function ownedPath(path, { directory = false, uid, allowMissing = false } = {}) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022)
      || (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077))
      || await realpath(path) !== path) fail('unsafe_target');
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      if ((await lstat(parent)).isSymbolicLink()) fail('unsafe_target');
      if (parent === dirname(parent)) break;
    }
    return metadata;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error?.credentialStage) throw error;
    fail('unsafe_target');
  }
}

export async function assertHistoricalSolTargets({ home, profile, codexHome, uid = process.getuid() }, { seeded = false } = {}) {
  if (typeof home !== 'string' || resolve(home) !== home
    || profile !== join(home, 'Library', 'Application Support', 'TiboTattle')
    || codexHome !== join(home, '.codex') || !Number.isSafeInteger(uid)) fail('unsafe_target');
  for (const path of [home, profile, codexHome, join(codexHome, 'sessions'), join(profile, 'companion-state')]) {
    await ownedPath(path, { directory: true, uid });
  }
  const sessions = join(codexHome, 'sessions');
  const names = (await readdir(sessions)).sort();
  const expected = (seeded ? [KNOWN_SOURCE, SOURCE] : [KNOWN_SOURCE]).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('unsafe_source_set');
  for (const name of names) await ownedPath(join(sessions, name), { uid });
  const archive = join(codexHome, 'archived_sessions');
  if (await ownedPath(archive, { directory: true, uid, allowMissing: true })
      && (await readdir(archive)).length) fail('unsafe_source_set');
  const paths = localCompanionStatePaths(join(profile, 'companion-state'));
  for (const path of [paths.unifiedIndexFile, paths.unifiedIndexSecretFile]) {
    await ownedPath(path, { uid, allowMissing: true });
  }
  return { ...paths, source: join(sessions, SOURCE) };
}

function facts(database) {
  return database.prepare(`SELECT hex(u.event_key) AS eventKey, hex(u.source_local) AS sourceLocal,
    u.source_offset AS sourceOffset, u.source_ordinal AS sourceOrdinal,
    hex(u.session_local) AS sessionLocal, u.observed_at_ms AS observedAtMs,
    m.model_id AS model, m.recognition AS recognition, p.parser_version AS parser,
    cp.parser_version AS cursorParser, u.tokens_in_uncached AS input,
    u.tokens_in_cache_read AS cacheRead, u.tokens_in_cache_write AS cacheWrite,
    u.tokens_out_text AS output, u.tokens_out_reasoning AS reasoning,
    u.tokens_out_combined AS combined, u.total_input_context AS context
    FROM usage_event u JOIN model m ON m.id=u.model_id
    JOIN parser_version p ON p.id=u.parser_version_id
    LEFT JOIN source_cursor c ON c.source_local=u.source_local
    LEFT JOIN ingest_run cr ON cr.id=c.ingest_run_id
    LEFT JOIN parser_version cp ON cp.id=cr.parser_version_id ORDER BY u.event_key`).all()
    .map(row => ({ ...row }));
}
const stableFact = ({ parser, cursorParser, model, recognition, ...row }) => row;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertKnownFacts(rows) {
  if (rows.length !== 2 || rows.some(row => row.model !== 'gpt-5.6-sol'
    || row.input !== 80 || row.cacheRead !== 20 || row.cacheWrite !== 0
    || row.output !== 16 || row.reasoning !== 8 || row.context !== 100)) fail('known_fixture_changed');
}

/** Called only after the predecessor's owned processes have stopped. */
export async function prepareHistoricalSolFixture({ home, profile, codexHome, predecessorRefreshId = null }, {
  admitHost = () => validateSparkleTransitionHost({ target: 'darwin-arm64', platform: process.platform,
    architecture: process.arch, nodeVersion: process.version, environment: process.env, account: userInfo() }),
} = {}) {
  if (home !== admitHost() || LOCAL_UNIFIED_INDEX_PARSER_VERSION !== CURRENT_PARSER) fail('host_or_parser');
  if (predecessorRefreshId !== null && !REFRESH_ID.test(predecessorRefreshId)) fail('refresh_identity');
  const uid = process.getuid();
  const paths = await assertHistoricalSolTargets({ home, profile, codexHome, uid });
  const options = { codexHome, indexFile: paths.unifiedIndexFile,
    secretFile: paths.unifiedIndexSecretFile, contractVersion: TELEMETRY_SCHEMA_VERSION };
  // Normalize only this run's already-owned known fixture before adding the new
  // source. Its exact stable facts must survive preparation and every app pass.
  await ingestLocalUnifiedIndexIncrement(options);
  let database = openLocalUnifiedIndex(paths.unifiedIndexFile, { readOnly: true });
  let known;
  try { known = facts(database); assertKnownFacts(known); } finally { database.close(); }
  await writeFile(paths.source, historicalSolSource(), { mode: 0o600, flag: 'wx' });
  await assertHistoricalSolTargets({ home, profile, codexHome, uid }, { seeded: true });
  await ingestLocalUnifiedIndexIncrement(options);
  database = openLocalUnifiedIndex(paths.unifiedIndexFile);
  let sol, generation;
  try {
    const rows = facts(database);
    sol = rows.filter(row => row.model === HISTORICAL_SOL_FIXTURE.model);
    if (sol.length !== 1 || rows.length !== known.length + 1
      || !same(rows.filter(row => row.model !== HISTORICAL_SOL_FIXTURE.model), known)) fail('seed_invalid');
    const selected = sol[0];
    if (selected.observedAtMs !== Date.parse(HISTORICAL_SOL_FIXTURE.observedAt)
      || selected.input !== 10_000 || selected.cacheRead !== 90_000 || selected.cacheWrite !== 0
      || selected.output !== 10_000 || selected.reasoning !== 0 || selected.context !== 100_000
      || !/^[A-F0-9]{64}$/u.test(selected.eventKey) || !/^[A-F0-9]{64}$/u.test(selected.sourceLocal)) fail('seed_invalid');
    generation = readUnifiedIndexGenerationDescriptor(database).id;
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT OR IGNORE INTO model(model_id,recognition) VALUES (?,?)').run('unknown', 'unrecognized');
    database.prepare('INSERT OR IGNORE INTO parser_version(parser_version,contract_version) VALUES (?,?)')
      .run(OLD_PARSER, TELEMETRY_SCHEMA_VERSION);
    const parser = database.prepare('SELECT id FROM parser_version WHERE parser_version=? AND contract_version=?')
      .get(OLD_PARSER, TELEMETRY_SCHEMA_VERSION).id;
    const run = database.prepare('INSERT INTO ingest_run(received_at_ms,parser_version_id) VALUES (?,?)')
      .run(Date.parse(HISTORICAL_SOL_FIXTURE.observedAt), parser).lastInsertRowid;
    // A separate old run scopes the compatibility fixture to its own source;
    // never retag shared ingest runs or the existing known fixture's rows.
    const changed = database.prepare(`UPDATE usage_event SET model_id=(SELECT id FROM model WHERE model_id='unknown'),
      parser_version_id=?,ingest_run_id=? WHERE event_key=?`).run(parser, run, Buffer.from(selected.eventKey, 'hex'));
    if (Number(changed.changes) !== 1) fail('seed_invalid');
    database.prepare('UPDATE source_cursor SET ingest_run_id=?,carry_model=? WHERE source_local=?')
      .run(run, 'unknown', Buffer.from(selected.sourceLocal, 'hex'));
    database.prepare('UPDATE usage_event_boundary SET parser_version_id=?,ingest_run_id=? WHERE current_event_key=?')
      .run(parser, run, Buffer.from(selected.eventKey, 'hex'));
    database.exec('COMMIT');
    const old = facts(database).find(row => row.eventKey === selected.eventKey);
    if (!old || old.model !== 'unknown' || old.recognition !== 'unrecognized'
      || old.parser !== OLD_PARSER || old.cursorParser !== OLD_PARSER || !same(stableFact(old), stableFact(selected))) fail('seed_invalid');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
  const handle = await open(paths.unifiedIndexFile, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  const context = Object.freeze({ fixture: HISTORICAL_SOL_FIXTURE });
  contexts.set(context, { home, profile, codexHome, uid, paths, known, sol: sol[0], generation,
    repairObserved: false, repeatObserved: false, restartsObserved: 0, lastRefreshId: predecessorRefreshId });
  return context;
}

export async function readHistoricalSolState(context) {
  const retained = contexts.get(context);
  if (!retained) fail('context_invalid');
  await assertHistoricalSolTargets(retained, { seeded: true });
  const database = openLocalUnifiedIndex(retained.paths.unifiedIndexFile, { readOnly: true });
  try {
    const rows = facts(database), sol = rows.filter(row => row.eventKey === retained.sol.eventKey);
    if (rows.length !== retained.known.length + 1 || sol.length !== 1
      || !same(rows.filter(row => row.eventKey !== retained.sol.eventKey), retained.known)
      || !same(stableFact(sol[0]), stableFact(retained.sol))) fail('identity_or_totals_changed');
    if (sol[0].model !== HISTORICAL_SOL_FIXTURE.model || sol[0].recognition !== 'recognized'
      || sol[0].parser !== CURRENT_PARSER || sol[0].cursorParser !== CURRENT_PARSER) fail('repair_missing');
    const generation = readUnifiedIndexGenerationDescriptor(database);
    if (generation.status !== 'complete' || generation.id === retained.generation) fail('repair_missing');
    return { generation: generation.id, fingerprint: generation.fingerprint, events: rows.length,
      totalTokens: 110_248 };
  } finally { database.close(); }
}

export function assertHistoricalSolAccounting({ refresh, overview, state, repeat = false, previousGeneration = null }) {
  const index = refresh?.result?.unifiedIndex, accounting = overview?.accounting;
  const history = accounting?.periods?.find(period => period.periodId === 'history');
  const rows = history?.modelUsage ?? history?.byModel;
  const model = Array.isArray(rows) ? rows.filter(row => row.model === HISTORICAL_SOL_FIXTURE.model) : [];
  if (refresh?.status !== 'succeeded' || index?.status !== 'ingested'
    || index.totalUsageEvents !== 3 || overview?.mode !== 'real_local_evidence'
    || accounting?.sourceMode !== 'unified' || accounting.generationMatched !== true
    || accounting.accountingCacheStatus !== 'available' || accounting.fallbackCount !== 0
    || String(accounting.generation) !== String(state.generation) || accounting.generationFingerprint !== state.fingerprint
    || accounting.sourceCoverageStatus !== 'complete' || accounting.historyCoverage?.status !== 'complete'
    || refresh.result.accounting?.status !== 'replay_safe' || refresh.result.accounting?.generationMatched !== true
    || refresh.result.accounting?.sourceMode !== 'unified' || refresh.result.accounting?.coverageStatus !== 'complete'
    || refresh.result.accounting?.fallbackCount !== 0 || refresh.result.accounting?.diagnosticsAvailable !== true
    || history?.events !== 3 || history.totalTokens !== state.totalTokens || model.length !== 1
    || model[0].events !== 1 || model[0].totalTokens !== HISTORICAL_SOL_FIXTURE.totalTokens
    || model[0].apiPriceEquivalentUsd !== HISTORICAL_SOL_FIXTURE.apiPriceEquivalentUsd
    || model[0].pricingStatus === 'unrecognized' || model[0].pricingStatus === 'known_unpriced'
    || rows.some(row => row.model === 'unknown' && row.events > 0)) fail('accounting_invalid');
  if (repeat && (index.unchanged !== true || index.insertedUsageEvents !== 0
    || index.sourcesRescanned !== 0 || index.sourcesTouched !== 0 || state.generation !== previousGeneration)) fail('replay_changed');
  if (!repeat && (index.unchanged !== false || index.sourcesRescanned !== 1
    || index.insertedUsageEvents !== 1)) fail('repair_missing');
  return true;
}

export function assertHistoricalSolRendered(value) {
  if (value?.period !== 'all' || value.pageVisible !== true || value.modelRows !== 1
    || value.model !== HISTORICAL_SOL_FIXTURE.model || value.label !== HISTORICAL_SOL_FIXTURE.label
    || value.events !== '1' || value.totalTokens?.replace(/[,\.\s\u00a0\u202f]/gu, '') !== '110000'
    || value.costUnavailable !== false || !/\$|USD/u.test(value.cost ?? '')
    || value.cost?.replace(/[^0-9.,]/gu, '').replace(',', '.') !== HISTORICAL_SOL_FIXTURE.renderedUsd) fail('rendered_usage_invalid');
  return true;
}

const UI_PROBE = `(async () => {
  const page = document.querySelector('#accounting[data-dashboard-page="method"]');
  const visible = page && !page.hidden && getComputedStyle(page).display !== 'none'
    && getComputedStyle(page).visibility !== 'hidden' && page.getBoundingClientRect().width > 0;
  const rows = [...document.querySelectorAll('#accounting-models > tr')]
    .filter(row => row.querySelector(':scope > .model-identity span[title="gpt-6.1-sol"]'));
  const row = rows[0], cells = row?.querySelectorAll(':scope > .numeric-cell');
  const identity = row?.querySelector(':scope > .model-identity span[title="gpt-6.1-sol"]');
  const cost = row?.querySelector(':scope > .model-api-equivalent');
  return { period: document.querySelector('#reporting-period-controls [aria-pressed="true"]')?.dataset.period,
    pageVisible: Boolean(visible), modelRows: rows.length, model: identity?.title, label: identity?.textContent,
    events: cells?.[0]?.textContent, totalTokens: cells?.[1]?.textContent,
    cost: cost?.textContent, costUnavailable: cost?.classList.contains('data-value-unavailable') };
})()`;

export async function readHistoricalSolRefreshId(dashboard) {
  const id = await dashboard.evaluate(`(async()=>{const r=await fetch('/api/local/refresh',{cache:'no-store'});
    return r.ok?(await r.json()).refresh?.refreshId:null})()`);
  if (id !== null && !REFRESH_ID.test(id)) fail('refresh_identity');
  return id;
}

// A retained successful projection is not this pass. Ignore its ID even when
// it appears before the new startup operation; only a new detailed completion
// can establish repair/replay evidence.
export async function waitForHistoricalSolRefresh(read, previousRefreshId = null, {
  now = Date.now, wait = delay, timeoutMs = 60_000,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const refresh = await read();
    if (refresh?.refreshId !== previousRefreshId && refresh?.mode === 'detailed') {
      if (['failed', 'cancelled', 'degraded'].includes(refresh.status)) fail('refresh_failed');
      if (refresh.status === 'succeeded') {
        if (!REFRESH_ID.test(refresh.refreshId)) fail('refresh_identity');
        return refresh;
      }
    }
    await wait(200);
  }
  fail('refresh_timeout');
}

export async function observeHistoricalSolPass({ dashboard, context, phase, previousGeneration = null }, {
  now = Date.now, wait = delay, timeoutMs = 60_000,
} = {}) {
  const retained = contexts.get(context);
  if (!retained || !['repair', 'repeat', 'restart'].includes(phase)
    || (phase === 'repair' && retained.repairObserved)
    || (phase === 'repeat' && (!retained.repairObserved || retained.repeatObserved))
    || (phase === 'restart' && (!retained.repeatObserved || retained.restartsObserved >= 2))) fail('pass_order');
  const repeat = phase !== 'repair';
  const deadline = now() + timeoutMs;
  const refresh = await waitForHistoricalSolRefresh(() => dashboard.evaluate(`(async()=>{
    const r=await fetch('/api/local/refresh',{cache:'no-store'});
    return r.ok?(await r.json()).refresh:null})()`), retained.lastRefreshId, { now, wait, timeoutMs });
  const state = await readHistoricalSolState(context);
  const overview = await dashboard.evaluate(`(async()=>{const r=await fetch('/api/local/overview',{cache:'no-store'});
    return r.ok?await r.json():null})()`);
  assertHistoricalSolAccounting({ refresh, overview, state, repeat, previousGeneration });
  if (await dashboard.evaluate(`(()=>{
    const nav=document.querySelector('[data-nav="method"]');
    const period=document.querySelector('#reporting-period-controls [data-period="all"]');
    if(!nav||!period)return false;nav.click();period.click();return true})()`) !== true) fail('rendered_usage_invalid');
  let rendered = false;
  while (now() <= deadline) {
    const value = await dashboard.evaluate(UI_PROBE);
    try { assertHistoricalSolRendered(value); rendered = true; break; }
    catch (error) { if (error?.credentialStage !== 'historical_sol_rendered_usage_invalid') throw error; }
    await wait(200);
  }
  if (!rendered) fail('rendered_usage_invalid');
  retained.lastRefreshId = refresh.refreshId;
  if (phase === 'repair') retained.repairObserved = true;
  if (phase === 'repeat') retained.repeatObserved = true;
  if (phase === 'restart') retained.restartsObserved += 1;
  return { generation: state.generation, refreshId: refresh.refreshId };
}

export function historicalSolQualificationReceipt(context) {
  const retained = contexts.get(context);
  if (!retained?.repairObserved || !retained.repeatObserved || retained.restartsObserved !== 2) fail('proof_incomplete');
  return { schemaVersion: HISTORICAL_SOL_FIXTURE.schemaVersion,
    observedAt: HISTORICAL_SOL_FIXTURE.observedAt, reportingPeriod: 'all',
    preUpgradeUnknownSeeded: true, parser18To19Repair: true,
    sourceOccurrenceIdentityPreserved: true, tokenTotalsPreserved: true,
    existingKnownFixturePreserved: true, currentAccountingGenerationMatched: true,
    exactApiPriceEquivalentUsd: HISTORICAL_SOL_FIXTURE.apiPriceEquivalentUsdExact,
    renderedModel: HISTORICAL_SOL_FIXTURE.model, renderedUsd: HISTORICAL_SOL_FIXTURE.renderedUsd,
    repeatedRefreshWithoutDuplicatesOrReparse: true, retainedAcrossTwoRestarts: true };
}
