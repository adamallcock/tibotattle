import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, realpath, mkdtemp, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identityDigest, openOperation, operationError } from '../../../scripts/lib/release-operation.mjs';
import { storageSchemaDigest, storageSha256 } from './d1-storage-plan.mjs';
import { TYPED_SCHEMA_INPUT_DIRECTORIES } from './production-typed-schema.mjs';
import { TYPED_PRODUCTION_PREFLIGHT_SQL } from './production-typed-preflight.mjs';
import { writePrivateJsonNoClobber } from './typed-forward-migration.mjs';

// This profile is intentionally local and cannot authorize a hosted operation.
export const MAINTAINED_FORWARD_LOCAL_SCHEMA = 'maintained-analytics-forward-plan-local-v1';
export const MAINTAINED_FORWARD_LOCAL_CONFIRMATION = 'EXECUTE_SYNTHETIC_MAINTAINED_ANALYTICS_LOCAL';
export const MAINTAINED_FORWARD_LOCAL_SQL_CAP = 512 * 1024;
export const MAINTAINED_FORWARD_STEPS = Object.freeze([
  ...['0014_effective_dependency_mutations.sql', '0015_effective_selective_dependencies.sql',
    '0016_terminal_replay_coverage.sql'].map(name => Object.freeze({role:'primary', directory:'ingestion-isolation-migrations', name})),
  ...['0034_shared_preparation_work.sql', '0035_effective_dependency_summaries.sql',
    '0036_canonical_analytics_facts.sql', '0037_canonical_feature_contributions.sql',
    '0038_analytics_partition_work.sql', '0039_canonical_rolling_inputs.sql',
    '0040_canonical_cache_pairs.sql', '0041_canonical_publication_closure.sql',
    '0042_terminal_replay_coverage.sql', '0043_analytics_work_capacity.sql',
    '0044_canonical_quota_identity.sql', '0045_maintained_output_work.sql',
    '0046_source_empty_outcomes.sql', '0047_analytics_cleanup_cadence.sql','0048_canonical_cache_prepared_receipts.sql']
    .map(name => Object.freeze({role:'analytics', directory:'analytics-migrations', name})),
]);
const ROLES = ['primary','analytics'];
const WORKERS = ['public','analytics','publication','cache'];
const ENABLE_ORDER = ['analytics','cache','publication','public'];
const FLAGS = ['STORAGE_ANALYTICS_CANONICAL_PIPELINE','STORAGE_ANALYTICS_SHARED_FEATURES','STORAGE_ANALYTICS_MODEL_BLOCKS'];
const LEDGER_DDL = 'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
const SHA = /^[a-f0-9]{64}$/u;
const SQL_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/u;
const fail = suffix => {throw operationError(`MAINTAINED_FORWARD_LOCAL_${suffix}`);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const same = (left,right) => identityDigest(left) === identityDigest(right);
const metadata = ({role,directory,name,sha256,bytes,statementBytes,atomicRequestBytes}) =>
  ({role,directory,name,sha256,bytes,statementBytes,atomicRequestBytes});
const head = sql => sql.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/u,'');

async function safeDirectory(path) {
  const absolute = resolve(path), info = await lstat(absolute);
  if (!info.isDirectory() || await realpath(absolute) !== absolute) fail('DIRECTORY_UNSAFE');
  return absolute;
}
function validatePins(pins) {
  if (!exact(pins,WORKERS) || WORKERS.some(role => !SHA.test(pins[role]))) fail('CODE_PINS_INVALID');
}
function validateTargets(targets) {
  if (!exact(targets,ROLES) || ROLES.some(role => !/^synthetic-[a-z0-9-]{1,48}$/u.test(targets[role]))
    || targets.primary === targets.analytics) fail('TARGETS_INVALID');
}
function atomicSql(input) {
  return `${input.sql.trim()}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${input.name}','${input.sha256}');\n`;
}
async function loadInputs(workerDirectory) {
  const root = await safeDirectory(workerDirectory);
  const split = createRequire(join(root,'package.json'))('wrangler').unstable_splitSqlQuery;
  if (typeof split !== 'function') fail('SPLITTER_UNAVAILABLE');
  const inputs = [];
  for (const role of ROLES) for (const directory of TYPED_SCHEMA_INPUT_DIRECTORIES[role]) {
    const folder = await safeDirectory(join(root,directory));
    const names = (await readdir(folder)).filter(name => name.endsWith('.sql')).sort();
    if (!names.length || names.length > 128 || names.some(name => !SQL_NAME.test(name))) fail('INVENTORY_INVALID');
    for (const name of names) {
      const path = join(folder,name), info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAINTAINED_FORWARD_LOCAL_SQL_CAP
        || await realpath(path) !== path) fail('SQL_FILE_UNSAFE');
      const bytes = await readFile(path), sql = bytes.toString('utf8');
      if (bytes.length !== info.size || bytes.includes(0) || !Buffer.from(sql).equals(bytes)) fail('SQL_BYTES_INVALID');
      const statements = split(sql);
      if (!Array.isArray(statements) || !statements.length || statements.length > 900
        || statements.some(statement => /^(?:ATTACH|DETACH|VACUUM)\b/iu.test(head(statement))
          || /\bload_extension\s*\(/iu.test(statement))) fail('SQL_UNSAFE');
      const input = {role,directory,name,sql,sha256:storageSha256(bytes),bytes:bytes.length,
        statements,statementBytes:statements.map(statement => Buffer.byteLength(statement)),atomicRequestBytes:0};
      input.pending = MAINTAINED_FORWARD_STEPS.some(step => same(step,{role,directory,name}));
      if (input.pending && (statements.some(statement => /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/iu.test(head(statement)))
        || /\bd1_storage_migrations\b/iu.test(sql))) fail('PENDING_SQL_UNSAFE');
      input.atomicRequestBytes = Buffer.byteLength(atomicSql(input));
      if (input.pending && input.atomicRequestBytes > MAINTAINED_FORWARD_LOCAL_SQL_CAP) fail('ATOMIC_SQL_TOO_LARGE');
      inputs.push(input);
    }
  }
  const pending = MAINTAINED_FORWARD_STEPS.map(step => inputs.find(input => same(step,
    {role:input.role,directory:input.directory,name:input.name})));
  if (pending.some(input => !input)
    || inputs.some(input => (input.directory === 'analytics-migrations' && input.name >= '0034_' && !input.pending)
      || (input.directory === 'ingestion-isolation-migrations' && input.name >= '0014_' && !input.pending))) fail('SUFFIX_NOT_CLOSED');
  return {root,inputs,pending,inputSha256:identityDigest(inputs.map(metadata))};
}
function inspectDatabase(db) {
  const schema = db.prepare(TYPED_PRODUCTION_PREFLIGHT_SQL.schema).all();
  // Include the exact operator ledger DDL and its index in the schema binding.
  const ledgerSchema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='d1_storage_migrations' ORDER BY type,name").all();
  const ledger = db.prepare('SELECT name,sha256 FROM d1_storage_migrations ORDER BY rowid').all();
  if (schema.length > 4096 || ledger.length > 512 || db.prepare('PRAGMA foreign_key_check').all().length) fail('DATABASE_INVALID');
  return {schemaSha256:storageSchemaDigest([...schema,...ledgerSchema]),ledgerSha256:identityDigest(ledger)};
}
function createPredecessors(loaded) {
  const databases = Object.fromEntries(ROLES.map(role => [role,new DatabaseSync(':memory:')]));
  try {
    for (const role of ROLES) {
      const db = databases[role];
      db.exec('PRAGMA foreign_keys=ON');
      db.exec(LEDGER_DDL);
      for (const input of loaded.inputs.filter(value => value.role === role && !value.pending)) {
        for (const statement of input.statements) db.exec(statement);
        db.prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').run(input.name,input.sha256);
      }
      db.exec('PRAGMA foreign_keys=ON');
    }
    return databases;
  } catch(error) {for (const db of Object.values(databases)) db.close(); throw error;}
}
function executeAtomic(db,input,{lateFailure=false}={}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Match the reviewed D1 batch's split DDL, within the same transaction.
    for (const statement of input.statements) db.exec(statement);
    db.prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)')
      .run(input.name,input.sha256);
    if (lateFailure) db.exec('INSERT INTO synthetic_missing_late_failure VALUES(1)');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_VIOLATION');
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK'); throw error;}
}
function projectFrontiers(loaded) {
  const databases = createPredecessors(loaded);
  const snapshot = () => Object.fromEntries(ROLES.map(role => [role,inspectDatabase(databases[role])]));
  try {
    const frontiers = [snapshot()];
    for (const input of loaded.pending) {executeAtomic(databases[input.role],input); frontiers.push(snapshot());}
    return frontiers;
  } finally {for (const db of Object.values(databases)) db.close();}
}
export async function prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,localTargets,
  createdAt=new Date().toISOString()}={}) {
  validatePins(codePins); validateTargets(localTargets);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail('DATE_INVALID');
  const loaded = await loadInputs(workerDirectory);
  return {schema:MAINTAINED_FORWARD_LOCAL_SCHEMA,status:'unreviewed-local',createdAt,
    sqlCapBytes:MAINTAINED_FORWARD_LOCAL_SQL_CAP,hostedAcceptance:'unqualified',localTargets,
    codePins,inputSha256:loaded.inputSha256,steps:loaded.pending.map(metadata),frontiers:projectFrontiers(loaded)};
}
export async function loadMaintainedAnalyticsForwardLocalSteps({plan,workerDirectory}={}) {
  return (await validatePlan(plan,workerDirectory)).pending;
}
async function validatePlan(plan,workerDirectory) {
  if (!exact(plan,['schema','status','createdAt','sqlCapBytes','hostedAcceptance','localTargets','codePins','inputSha256','steps','frontiers'])
    || plan.schema !== MAINTAINED_FORWARD_LOCAL_SCHEMA || plan.status !== 'unreviewed-local'
    || plan.hostedAcceptance !== 'unqualified') fail('PLAN_INVALID');
  const expected = await prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins:plan.codePins,
    localTargets:plan.localTargets,createdAt:plan.createdAt});
  if (!same(expected,plan)) fail('PLAN_OR_INPUT_CHANGED');
  return loadInputs(workerDirectory);
}
function validateWorkers(observed,plan) {
  if (!exact(observed,WORKERS)) fail('WORKERS_INVALID');
  for (const role of WORKERS) if (!exact(observed[role],['codeSha256','flags'])
    || observed[role].codeSha256 !== plan.codePins[role] || !exact(observed[role].flags,FLAGS)
    || FLAGS.some(flag => !['enabled','disabled'].includes(observed[role].flags[flag]))) fail('CODE_OR_CONTROLS_DRIFT');
}
function allFlags(workers,value) {return WORKERS.every(role => FLAGS.every(flag => workers[role].flags[flag] === value));}
function controlledWorkers(workers,role,value) {
  const output = structuredClone(workers);
  output[role].flags = Object.fromEntries(FLAGS.map(flag => [flag,value]));
  return output;
}
function validateState(state,limit) {
  if (!exact(state,['status','next','initialWorkers','acceptedOutputSha256'])
    || !['running','uncertain','complete'].includes(state.status)
    || !Number.isSafeInteger(state.next) || state.next < 0 || state.next > limit
    || (state.status === 'uncertain' && state.next === limit)
    || (state.status === 'complete' && state.next !== limit) || !SHA.test(state.acceptedOutputSha256)) fail('JOURNAL_INVALID');
}

/** A local adapter contract; the module provides no network/credential adapter. */
export async function runMaintainedAnalyticsForwardLocal({plan,workerDirectory,operationDirectory,adapter,
  phase='migrate',execute=false,resume=false,reconcileOnly=false,confirmation,approvedPlanSha256,
  approvedReconciliationSha256=null,retryNotApplied=false}={}) {
  if (!['migrate','activate','fallback'].includes(phase)) fail('PHASE_INVALID');
  const loaded = await validatePlan(plan,workerDirectory), planSha256 = identityDigest(plan);
  if (!execute && !reconcileOnly) return {status:'planned',phase,planSha256,remoteWrites:false};
  if (!adapter || adapter.localOnly !== true || !same(adapter.localTargets,plan.localTargets)) fail('LOCAL_ADAPTER_REQUIRED');
  if (reconcileOnly && !resume) fail('RECONCILE_REQUIRES_RESUME');
  if (!reconcileOnly && (confirmation !== MAINTAINED_FORWARD_LOCAL_CONFIRMATION || approvedPlanSha256 !== planSha256)) fail('NOT_APPROVED');
  const order = phase === 'activate' ? ENABLE_ORDER : [...ENABLE_ORDER].reverse();
  const limit = phase === 'migrate' ? loaded.pending.length : order.length;
  const operation = await openOperation({directory:operationDirectory,kind:'qualification',binding:{plan,phase},resume});
  try {
    const planPath = join(operation.directory,'plan.json');
    if (!resume) await writePrivateJsonNoClobber(planPath,plan);
    else {
      const info = await lstat(planPath);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1024*1024
        || (process.getuid && info.uid !== process.getuid())) fail('SAVED_PLAN_UNSAFE');
      const handle = await open(planPath,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await handle.stat();
        if (actual.ino !== info.ino || actual.dev !== info.dev || actual.nlink !== 1
          || !same(JSON.parse(await handle.readFile('utf8')),plan)) fail('SAVED_PLAN_CHANGED');
      } finally {await handle.close();}
    }
    const currentWorkers = await adapter.workers(); validateWorkers(currentWorkers,plan);
    let state = operation.record.state;
    if (!resume) {
      if (phase === 'migrate' && !allFlags(currentWorkers,'disabled')) fail('CONTROLS_NOT_DISABLED');
      if (phase === 'activate' && !allFlags(currentWorkers,'disabled')) fail('ACTIVATION_PREDECESSOR_INVALID');
      state = {status:'running',next:0,initialWorkers:currentWorkers,acceptedOutputSha256:await adapter.acceptedOutputSha256()};
      await operation.save(state);
    }
    validateState(state,limit); validateWorkers(state.initialWorkers,plan);
    if ((phase === 'migrate' || phase === 'activate') && !allFlags(state.initialWorkers,'disabled')) fail('JOURNAL_CONTROLS_INVALID');
    const expectedWorkers = count => {
      let workers = structuredClone(state.initialWorkers);
      if (phase !== 'migrate') for (const role of order.slice(0,count)) workers = controlledWorkers(workers,role,phase === 'activate' ? 'enabled' : 'disabled');
      return workers;
    };
    const observe = async () => {
      if ((await loadInputs(workerDirectory)).inputSha256 !== plan.inputSha256) fail('INPUT_CHANGED');
      const workers = await adapter.workers(); validateWorkers(workers,plan);
      const databases = {};
      for (const role of ROLES) databases[role] = await adapter.inspect(role);
      if (await adapter.acceptedOutputSha256() !== state.acceptedOutputSha256) fail('ACCEPTED_OUTPUT_CHANGED');
      return {databases,workers};
    };
    const matches = (observed,count) => same(observed.databases,plan.frontiers[phase === 'migrate' ? count : loaded.pending.length])
      && same(observed.workers,expectedWorkers(count));
    if (state.status === 'uncertain') {
      const observed = await observe();
      const classification = matches(observed,state.next+1) ? 'applied' : matches(observed,state.next) ? 'not-applied' : 'ambiguous';
      const reconciliation = {schema:'maintained-analytics-forward-reconciliation-local-v1',planSha256,
        phase,next:state.next,classification,observedSha256:identityDigest(observed)};
      const reconciliationSha256 = identityDigest(reconciliation);
      if (reconcileOnly || approvedReconciliationSha256 === null) return {status:`reconciled-${classification}`,
        reconciliation,reconciliationSha256,remoteWrites:false};
      if (classification === 'ambiguous' || approvedReconciliationSha256 !== reconciliationSha256) fail('RECONCILIATION_NOT_APPROVED');
      if (classification === 'not-applied' && !retryNotApplied) fail('RETRY_NOT_APPROVED');
      state = {...state,status:'running',next:state.next+(classification === 'applied' ? 1 : 0)};
      await operation.save(state);
    } else if (reconcileOnly) fail('NOT_UNCERTAIN');
    if (state.status === 'complete') {
      if (!matches(await observe(),limit)) fail('COMPLETE_DRIFT');
      return {status:'complete',phase,planSha256,remoteWrites:false};
    }
    for (let index=state.next;index<limit;index++) {
      if (!matches(await observe(),index)) fail('FRONTIER_OR_CONTROLS_DRIFT');
      state = {...state,status:'uncertain',next:index}; await operation.save(state);
      // Recheck after fsync and at submission; drift leaves a reconcilable intent.
      if (!matches(await observe(),index)) fail('SUBMISSION_DRIFT');
      // The intent is durable before submission. Never replay an uncertain write.
      if (phase === 'migrate') await adapter.migrateAtomic(loaded.pending[index],atomicSql(loaded.pending[index]));
      else await adapter.setControls(order[index],phase === 'activate' ? 'enabled' : 'disabled');
      if (!matches(await observe(),index+1)) fail('RESULT_UNCERTAIN');
      state = {...state,status:'running',next:index+1}; await operation.save(state);
    }
    if (!matches(await observe(),limit)) fail('FINAL_DRIFT');
    state = {...state,status:'complete'}; await operation.save(state);
    return {status:'complete',phase,planSha256,localSteps:limit,remoteWrites:false};
  } finally {operation.close();}
}

/** Only disposable in-memory SQLite databases are accepted by this adapter.
 * Fault hooks are synthetic interruptions, never alternate migration SQL. */
export async function createMaintainedAnalyticsSQLiteAdapter({workerDirectory,plan,seed=null,fault=null}={}) {
  const loaded = await validatePlan(plan,workerDirectory), databases = createPredecessors(loaded);
  let workers = Object.fromEntries(WORKERS.map(role => [role,{codeSha256:plan.codePins[role],
    flags:Object.fromEntries(FLAGS.map(flag => [flag,'disabled']))}]));
  try {if (seed) seed(databases);}
  catch(error) {for (const db of Object.values(databases)) db.close(); throw error;}
  // Original columns only: appended tables/columns cannot alter this retained-data proof.
  const retained = Object.fromEntries(ROLES.map(role => [role,databases[role].prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>'d1_storage_migrations' ORDER BY name")
    .all().map(({name}) => ({name,columns:databases[role].prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name)}))]));
  const accepted = () => identityDigest(Object.fromEntries(ROLES.map(role => [role,retained[role].map(({name,columns}) => {
    const rows = databases[role].prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}"`).all();
    const hashes = rows.map(row => identityDigest(Object.fromEntries(Object.entries(row).map(([key,value]) =>
      [key,value instanceof Uint8Array ? [...value] : value])))).sort();
    return {name,count:rows.length,sha256:identityDigest(hashes)};
  })])));
  return {localOnly:true,localTargets:structuredClone(plan.localTargets),databases,
    workers:async()=>structuredClone(workers),inspect:async role=>inspectDatabase(databases[role]),
    acceptedOutputSha256:async()=>accepted(),
    async migrateAtomic(input,sql) {
      const pinned = plan.steps.find(step => step.name === input?.name);
      if (!pinned || !same(metadata(input),pinned) || sql !== atomicSql(input)) fail('MIGRATION_NOT_PINNED');
      await fault?.('before',input.name);
      executeAtomic(databases[input.role],input,{lateFailure:await fault?.('late',input.name) === true});
      await fault?.('after',input.name);
    },
    async setControls(role,value) {await fault?.('before',`${role}:${value}`);
      workers = controlledWorkers(workers,role,value); await fault?.('after',`${role}:${value}`);},
    setWorkerEvidence(value) {workers=structuredClone(value);},
    close() {for (const db of Object.values(databases)) db.close();},
  };
}

export function parseMaintainedForwardLocalArguments(argv) {
  if (argv.length !== 1 || !['inspect','rehearse'].includes(argv[0])) fail('ARGUMENTS');
  return {mode:argv[0]};
}
async function main() {
  const {mode} = parseMaintainedForwardLocalArguments(process.argv.slice(2));
  const workerDirectory = resolve(fileURLToPath(new URL('..',import.meta.url)));
  const codePins = Object.fromEntries(WORKERS.map(role => [role,storageSha256(`synthetic-local-code:${role}`)]));
  const plan = await prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,
    localTargets:{primary:'synthetic-source',analytics:'synthetic-analytics'}});
  if (mode === 'inspect') {console.log(JSON.stringify({schema:plan.schema,status:plan.status,inputSha256:plan.inputSha256,
    steps:plan.steps,hostedAcceptance:plan.hostedAcceptance,remoteWrites:false})); return;}
  const root = await mkdtemp('/private/tmp/maintained-forward-local-');
  const adapter = await createMaintainedAnalyticsSQLiteAdapter({workerDirectory,plan});
  try {
    const results=[];
    for (const phase of ['migrate','activate','fallback']) results.push(await runMaintainedAnalyticsForwardLocal({plan,workerDirectory,
      operationDirectory:join(root,phase),adapter,phase,execute:true,confirmation:MAINTAINED_FORWARD_LOCAL_CONFIRMATION,
      approvedPlanSha256:identityDigest(plan)}));
    console.log(JSON.stringify({schema:MAINTAINED_FORWARD_LOCAL_SCHEMA,status:'local-rehearsed',results,
      inputSha256:plan.inputSha256,hostedAcceptance:'unqualified',remoteWrites:false}));
  } finally {adapter.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => {console.error(error?.code?.startsWith('MAINTAINED_FORWARD_LOCAL_') ? error.code : 'MAINTAINED_FORWARD_LOCAL_FAILED'); process.exitCode=1;});
