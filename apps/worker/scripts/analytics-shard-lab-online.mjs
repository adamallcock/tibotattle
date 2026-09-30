import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { labDigest, validateLabPlan, initializeLabDatabase, inspectLabDatabase } from './analytics-shard-lab-core.mjs';
import { syntheticLabPlan, seedLabDatabases, measureLabDatabases } from './analytics-shard-lab-runner.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const durableLabRoot = resolve(scriptDir, '../.wrangler/shard-lab');
const safeDirectoryPath = path => typeof path === 'string' && (
  /^\/private\/tmp\/tibotattle-shard-online-[a-z0-9-]+$/.test(path)
  || dirname(path) === durableLabRoot && /^tibotattle-shard-online-[a-z0-9-]+$/.test(basename(path)));
const SHA = /^[a-f0-9]{64}$/, ACCOUNT = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOURCE_FILES = ['analytics-shard-lab-core.mjs', 'analytics-shard-lab-runner.mjs',
  'analytics-shard-lab-online.mjs', '../src/d1-provider-schema.json'];
const fail = code => { throw Object.assign(Error(`SHARD_LAB_${code}`), { code: `SHARD_LAB_${code}` }); };
const shaBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === [...keys].sort().join();
async function sourceProof() {
  return Promise.all(SOURCE_FILES.map(async path => ({ path, sha256: shaBytes(await readFile(resolve(scriptDir, path))) })));
}
export function validateOnlineLabPlan(plan) {
  if (!exact(plan, ['method', 'environment', 'accountId', 'runId', 'createdAt', 'expiresAt', 'placement', 'sources', 'targets'])
    || plan.method !== 'analytics-shard-online-plan-v1' || plan.environment !== 'private-synthetic-shadow'
    || !ACCOUNT.test(plan.accountId) || !UUID.test(plan.runId)
    || !Number.isFinite(Date.parse(plan.createdAt)) || !Number.isFinite(Date.parse(plan.expiresAt))
    || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== 24 * 60 * 60 * 1_000
    || !Array.isArray(plan.sources) || plan.sources.length !== SOURCE_FILES.length
    || plan.sources.some((s, i) => !exact(s, ['path', 'sha256']) || s.path !== SOURCE_FILES[i] || !SHA.test(s.sha256))
    || !Array.isArray(plan.targets) || plan.targets.length !== 5) fail('ONLINE_PLAN_INVALID');
  validateLabPlan(plan.placement);
  const suffix = plan.runId.replaceAll('-', '').slice(0, 12);
  for (let i = 0; i < 5; i++) if (!exact(plan.targets[i], ['name', 'target', 'location'])
    || plan.targets[i].name !== `tibotattle-shard-lab-${suffix}-${i === 0 ? 'baseline' : `s${i - 1}`}`
    || plan.targets[i].target !== i - 1 || plan.targets[i].location !== 'enam') fail('ONLINE_PLAN_INVALID');
  return plan;
}
export function parseOnlineLabArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--mode', '--dir', '--rows', '--account-plan', '--account-plan-sha', '--approve-plan'].includes(argv[i])
      || argv[i + 1] === undefined || out[argv[i]] !== undefined) fail('USAGE');
    out[argv[i]] = argv[i + 1];
  }
  if (!['prepare', 'provision', 'seed', 'measure', 'status'].includes(out['--mode'])
    || !safeDirectoryPath(out['--dir'])) fail('USAGE');
  const expected = out['--mode'] === 'prepare'
    ? ['--mode', '--dir', '--rows', '--account-plan', '--account-plan-sha']
    : ['--mode', '--dir', '--approve-plan'];
  if (!exact(out, expected)) fail('USAGE');
  if (out['--mode'] === 'prepare') {
    if (!/^[1-9][0-9]*$/.test(out['--rows']) || !SHA.test(out['--account-plan-sha'])
      || !(out['--account-plan'].startsWith('/private/tmp/')
        || dirname(out['--account-plan']) === durableLabRoot)) fail('USAGE');
    syntheticLabPlan(Number(out['--rows']));
  } else if (!SHA.test(out['--approve-plan'])) fail('USAGE');
  return out;
}
async function privateDirectory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) fail('DIRECTORY_UNSAFE');
}
async function privateRead(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || s.size > 1024 * 1024 || (s.mode & 0o077)) fail('FILE_UNSAFE');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function saveState(dir, state) {
  await privateDirectory(dir);
  const temp = resolve(dir, `state-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, resolve(dir, 'state.json'));
  const directory = await open(dir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
}
export function makeLabApi({ accountId, token, fetchImpl = fetch }) {
  if (!ACCOUNT.test(accountId) || typeof token !== 'string' || !token) fail('CREDENTIAL_UNAVAILABLE');
  return async (suffix = '', method = 'GET', body) => {
    if (!['GET', 'POST'].includes(method) || !/^($|\?[a-z0-9_=&-]+|\/[a-f0-9-]{36}(\/query)?)$/.test(suffix)) fail('API_ROUTE_INVALID');
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database${suffix}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000), redirect: 'error',
    });
    // Provider messages and bodies are never printed or retained. No retries.
    const bytes = await response.text();
    if (Buffer.byteLength(bytes) > 1024 * 1024) fail('API_RESPONSE_LIMIT');
    let result; try { result = JSON.parse(bytes); } catch { fail('API_RESPONSE_INVALID'); }
    if (!response.ok || result.success !== true || result.errors?.length) fail('API_REFUSED');
    return result.result;
  };
}
export function makeRemoteLabDatabase(api, id, guard) {
  if (!UUID.test(id) || typeof guard !== 'function') fail('DATABASE_ID_INVALID');
  const request = async statements => {
    if (!Array.isArray(statements) || statements.length < 1 || statements.length > 6
      || statements.some(s => typeof s.sql !== 'string' || !Array.isArray(s.params)
        || !/shard_lab_|sqlite_schema/.test(s.sql) || s.params.length > 20
        || s.params.some(p => !(p === null || typeof p === 'string' || Number.isSafeInteger(p))))) fail('STATEMENT_INVALID');
    await guard(statements.some(s => /\b(CREATE|INSERT|UPDATE|DELETE)\b/.test(s.sql)));
    const results = await api(`/${id}/query`, 'POST', { batch: statements });
    if (!Array.isArray(results) || results.length !== statements.length || results.some(r => r.success !== true || !Array.isArray(r.results))) fail('API_QUERY_INVALID');
    return results;
  };
  const prepare = (sql, params = []) => ({
    bind(...values) { return prepare(sql, values); },
    async all() { return (await request([{ sql, params }]))[0]; },
    async run() { return (await request([{ sql, params }]))[0]; },
    async first() { return (await request([{ sql, params }]))[0].results[0] ?? null; },
    _labStatement: { sql, params, id },
  });
  return { prepare, batch(statements) { return request(statements.map(s => {
    if (s?._labStatement?.id !== id) fail('STATEMENT_INVALID');
    const { sql, params } = s._labStatement; return { sql, params };
  })); } };
}
function identity(value, target, expectedId) {
  if (!value || !UUID.test(value.uuid) || value.name !== target.name || expectedId && value.uuid !== expectedId
    || !Number.isSafeInteger(value.file_size) || value.file_size < 0 || value.file_size > 2_000_000_000
    || value.read_replication?.mode && value.read_replication.mode !== 'disabled') fail('RESOURCE_MISMATCH');
  return { id: value.uuid, name: value.name, bytes: value.file_size };
}
async function inventory(api, name) {
  const rows = await api(`?name=${name}&per_page=100`);
  if (!Array.isArray(rows) || rows.length > 100) fail('INVENTORY_INVALID');
  return rows.filter(v => v.name === name);
}
export async function provisionLabTargets({ plan, state, api, save, guard }) {
  validateOnlineLabPlan(plan);
  if (!exact(state, ['planSha256', 'targets']) || state.planSha256 !== labDigest(plan)
    || !Array.isArray(state.targets) || state.targets.length !== 5) fail('STATE_DRIFT');
  for (let i = 0; i < plan.targets.length; i++) {
    const target = plan.targets[i], rows = await inventory(api, target.name), p = state.targets[i];
    if (p === null) {
      if (rows.length !== 0) fail('RESOURCE_NAME_EXISTS');
      await guard(true); state.targets[i] = { status: 'creating' }; await save(state);
      let created;
      try { created = await api('', 'POST', { name: target.name, primary_location_hint: target.location }); }
      catch {
        const after = await inventory(api, target.name);
        if (after.length !== 1) fail('CREATE_UNCERTAIN');
        created = after[0];
      }
      state.targets[i] = { status: 'created', ...identity(created, target) }; await save(state);
    } else if (p.status === 'creating') {
      // An interrupted create is reconciliation only; absence never retries.
      if (rows.length !== 1) fail('CREATE_UNCERTAIN');
      state.targets[i] = { status: 'created', ...identity(rows[0], target) }; await save(state);
    } else if (p.status === 'created') {
      if (rows.length !== 1) fail('RESOURCE_MISMATCH'); identity(rows[0], target, p.id);
    } else fail('STATE_DRIFT');
  }
  if (new Set(state.targets.map(t => t.id)).size !== 5) fail('STATE_DRIFT');
  return state;
}
async function main() {
  const args = parseOnlineLabArgs(process.argv.slice(2)), dir = args['--dir'], mode = args['--mode'];
  if (mode === 'prepare') {
    const bytes = await privateRead(args['--account-plan']);
    if (shaBytes(bytes) !== args['--account-plan-sha']) fail('ACCOUNT_REFERENCE_DRIFT');
    const accountId = JSON.parse(bytes).accountId;
    const createdAt = new Date().toISOString(), runId = randomUUID();
    const plan = validateOnlineLabPlan({ method: 'analytics-shard-online-plan-v1', environment: 'private-synthetic-shadow',
      accountId, runId, createdAt, expiresAt: new Date(Date.parse(createdAt) + 24 * 3600_000).toISOString(),
      placement: syntheticLabPlan(Number(args['--rows'])), sources: await sourceProof(),
      targets: Array.from({ length: 5 }, (_, i) => ({ target: i - 1, location: 'enam',
        name: `tibotattle-shard-lab-${runId.replaceAll('-', '').slice(0, 12)}-${i ? `s${i - 1}` : 'baseline'}` })) });
    if (dirname(dir) === durableLabRoot) await mkdir(durableLabRoot, { mode: 0o700, recursive: true });
    await mkdir(dir, { mode: 0o700 });
    await writeFile(resolve(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await saveState(dir, { planSha256: labDigest(plan), targets: Array(5).fill(null) });
    console.log(JSON.stringify({ mode, planSha256: labDigest(plan), targets: 5, rows: plan.placement.totalRows,
      dataKind: 'synthetic', externalWrites: false })); return;
  }
  await privateDirectory(dir);
  const lockPath = resolve(dir, 'operator.lock'), lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(`${process.pid}\n`); await lock.sync();
    const plan = validateOnlineLabPlan(JSON.parse(await privateRead(resolve(dir, 'plan.json'))));
    const approved = args['--approve-plan'];
    const guard = async write => {
      const current = JSON.parse(await privateRead(resolve(dir, 'plan.json')));
      if (approved !== labDigest(plan) || labDigest(current) !== approved
        || JSON.stringify(await sourceProof()) !== JSON.stringify(plan.sources)) fail('SOURCE_OR_PLAN_DRIFT');
      if (write && Date.now() > Date.parse(plan.expiresAt)) fail('APPROVAL_EXPIRED');
    };
    await guard(false);
    const api = makeLabApi({ accountId: plan.accountId, token: process.env.CLOUDFLARE_API_TOKEN });
    const state = JSON.parse(await privateRead(resolve(dir, 'state.json')));
    if (mode === 'provision') {
      await provisionLabTargets({ plan, state, api, save: s => saveState(dir, s), guard });
      console.log(JSON.stringify({ mode, targets: 5, dataKind: 'synthetic' })); return;
    }
    if (!exact(state, ['planSha256', 'targets']) || state.planSha256 !== approved
      || !Array.isArray(state.targets) || state.targets.length !== 5 || state.targets.some(t => t?.status !== 'created')
      || new Set(state.targets.map(t => t.id)).size !== 5) fail('STATE_DRIFT');
    for (let i = 0; i < 5; i++) identity(await api(`/${state.targets[i].id}`), plan.targets[i], state.targets[i].id);
    const databases = state.targets.map(t => makeRemoteLabDatabase(api, t.id, guard));
    if (mode === 'status') {
      const progress = []; for (let i = 0; i < 5; i++) {
        const p = await inspectLabDatabase(databases[i], plan.placement, i - 1);
        progress.push({ target: i - 1, state: p.state, records: p.records ?? 0 });
      }
      console.log(JSON.stringify({ mode, progress })); return;
    }
    if (mode === 'seed') {
      // Verify this API's actual batch rollback before loading any experiment
      // records. A refused transaction must leave the guard table empty.
      for (let i = 0; i < 5; i++) {
        const db = databases[i]; await initializeLabDatabase(db, plan.placement, i - 1);
        let refused = false;
        try { await db.batch([db.prepare('INSERT INTO shard_lab_guard VALUES(1)'), db.prepare('INSERT INTO shard_lab_guard VALUES(0)')]); }
        catch { refused = true; }
        if (!refused || (await db.prepare('SELECT count(*) AS n FROM shard_lab_guard').first()).n !== 0) fail('BATCH_ATOMICITY_UNPROVED');
      }
      const seed = await seedLabDatabases(databases, plan.placement, p => console.log(JSON.stringify({ phase: 'seed', ...p })));
      await writeFile(resolve(dir, `seed-${randomUUID()}.json`), `${JSON.stringify({ planSha256: approved, completedAt: new Date().toISOString(), ...seed }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ mode, records: seed.baseline.records, shardRecords: seed.shards.reduce((n, s) => n + s.records, 0) }));
    } else {
      const measurements = await measureLabDatabases(databases, plan.placement);
      const receipt = { method: plan.method, environment: plan.environment, dataKind: 'synthetic',
        planSha256: approved, completedAt: new Date().toISOString(), rows: plan.placement.totalRows,
        loads: plan.placement.loads, ...measurements };
      await writeFile(resolve(dir, `measurement-${randomUUID()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ mode, rows: receipt.rows, summary: receipt.summary }));
    }
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ status: 'stopped', code: /^SHARD_LAB_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'SHARD_LAB_OPERATION_FAILED' }));
  process.exitCode = 1;
});
