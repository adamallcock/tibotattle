import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWranglerQueryInvocation } from './wrangler-query-launcher.mjs';
import validation from './wrangler-query-preload.cjs';
import { storageError, storageSha256, storageSchemaDigest, validateStoragePlan, resolveStorageApproval, assertStorageMutationApproval } from './d1-storage-plan.mjs';
import { runStorageOperation } from './d1-storage-operator.mjs';

const FORBIDDEN_ENV_OVERRIDES = ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV'];
export function storageWranglerEnvironment(environment, accountId, logPath) {
  if (FORBIDDEN_ENV_OVERRIDES.some((key) => Object.hasOwn(environment, key))) throw storageError('TRANSPORT_ENVIRONMENT_OVERRIDE');
  return { ...environment, CI: 'true', CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_LOG_PATH: logPath };
}

const LEDGER_SCHEMA_SQL = 'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
const LEDGER = `${LEDGER_SCHEMA_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};`;
const LEDGER_OBJECTS = [
  { type: 'index', name: 'sqlite_autoindex_d1_storage_migrations_1', tbl_name: 'd1_storage_migrations', sql: null },
  { type: 'table', name: 'd1_storage_migrations', tbl_name: 'd1_storage_migrations', sql: LEDGER_SCHEMA_SQL },
];
export const STORAGE_SCHEMA_QUERY = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'd1_storage_migrations' ORDER BY type,name LIMIT 4097`;

/** Private, one-account configs prevent environment fallback or binding-name
 * discovery. This adapter deliberately exposes no arbitrary query API. */
export async function createStorageWranglerAdapter({ plan, qualifications, directory, cliPath, spawn = spawnSync,
  allowExpiredPlan = false, approvalExtensions = [] }) {
  validateStoragePlan(plan, { allowExpired: allowExpiredPlan });
  const approval = resolveStorageApproval({ plan, extensions: approvalExtensions });
  storageWranglerEnvironment(process.env, plan.accountId, '');
  const cli = validation.verifyCli(cliPath);
  const transportRoot = join(resolve(directory), 'wrangler');
  await mkdir(transportRoot, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(transportRoot);
  if (!stat.isDirectory() || await realpath(transportRoot) !== transportRoot || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw storageError('TRANSPORT_DIRECTORY_UNSAFE');
  let sequence = 0;
  const attempt = randomUUID();
  const privateBytes = async (path, bytes) => {
    try { await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || await realpath(path) !== path
          || (process.getuid && info.uid !== process.getuid()) || !(await readFile(path)).equals(Buffer.from(bytes))) throw storageError('TRANSPORT_FILE_CHANGED');
    }
  };
  const config = async (target = null) => {
    const body = `${JSON.stringify({ name: 'tibotattle-storage-operator', account_id: plan.accountId,
      compatibility_date: '2026-09-11', d1_databases: target ? [{ binding: target.binding,
        database_name: target.name, database_id: target.databaseId }] : [] })}\n`;
    const path = join(transportRoot, target ? `${target.binding}.json` : 'account.json');
    await privateBytes(path, body);
    return { path, sha256: storageSha256(body) };
  };
  const invoke = async (args, pin) => {
    if (validation.verifyCli(cliPath).digest !== cli.digest || storageSha256(await readFile(pin.path)) !== pin.sha256) throw storageError('TRANSPORT_PIN_CHANGED');
    const logPath = join(transportRoot, `wrangler-${attempt}-${sequence++}.log`);
    await writeFile(logPath, '', { flag: 'wx', mode: 0o600 });
    const result = spawn(process.execPath, args, { cwd: transportRoot, encoding: 'utf8', timeout: 45_000,
      maxBuffer: 512 * 1024, env: storageWranglerEnvironment(process.env, plan.accountId, logPath),
      stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw storageError('WRANGLER_RESULT_UNCERTAIN');
    return String(result.stdout ?? '');
  };
  const command = async (args, target = null) => {
    const pin = await config(target);
    return invoke([cli.canonical, 'd1', ...args, '--config', pin.path], pin);
  };
  const json = (bytes) => { try { return JSON.parse(bytes); } catch { throw storageError('WRANGLER_JSON_INVALID'); } };
  const query = async (target, sql) => {
    if (!plan.targets.some((entry) => entry.binding === target.binding && entry.databaseId === target.databaseId && entry.name === target.name)) throw storageError('TRANSPORT_TARGET_INVALID');
    const pin = await config(target);
    const sqlPath = join(transportRoot, `query-${attempt}-${sequence++}.sql`);
    await writeFile(sqlPath, sql, { mode: 0o600, flag: 'wx' });
    const invocation = createWranglerQueryInvocation({ cliPath, configPath: pin.path, binding: target.binding,
      databaseId: target.databaseId, mode: 'remote', sqlPath, expectedSqlSha256: storageSha256(sql) });
    const response = json(await invoke(invocation.args, pin));
    if (!Array.isArray(response) || !response.length || response.some((entry) => entry?.success !== true || !Array.isArray(entry.results))) throw storageError('WRANGLER_QUERY_UNCERTAIN');
    return response;
  };
  const assertTarget = (target) => {
    if (!plan.targets.some((entry) => JSON.stringify(entry) === JSON.stringify(target))) throw storageError('TRANSPORT_TARGET_INVALID');
  };
  const inspectLedger = async (target) => {
    const schema = await query(target, `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='d1_storage_migrations' OR name='d1_storage_migrations' ORDER BY type,name LIMIT 4`);
    if (schema.length !== 1) throw storageError('LEDGER_SCHEMA_MISMATCH');
    const rows = schema[0].results;
    if (rows.length === 0) return false;
    // The application schema digest excludes this owned table, so its complete
    // DDL and attached objects have a separate fixed pin. A trigger or extra
    // index is never accepted merely because ledger row values still match.
    if (rows.length !== LEDGER_OBJECTS.length || rows.some((row, index) => {
      const expected = LEDGER_OBJECTS[index];
      return Object.keys(row).sort().join() !== 'name,sql,tbl_name,type'
        || row.type !== expected.type || row.name !== expected.name
        || row.tbl_name !== expected.tbl_name || row.sql !== expected.sql;
    })) throw storageError('LEDGER_SCHEMA_MISMATCH');
    return true;
  };
  return {
    proof: { wranglerVersion: '4.114.0', cliSha256: cli.digest },
    async inventory(target) {
      assertTarget(target);
      const list = json(await command(['list', '--json']));
      if (!Array.isArray(list) || list.length > 4096) throw storageError('INVENTORY_LIMIT');
      const matches = list.filter((entry) => entry.name === target.name);
      if (matches.length !== 1) return matches.length === 0 ? [] : [null, null];
      if (target.databaseId !== null && matches[0].uuid !== target.databaseId) throw storageError('RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH');
      // Info is addressed by the exact server-returned UUID; the account is
      // pinned in the private config. Never infer an ID from a name fragment.
      const info = json(await command(['info', matches[0].uuid, '--json']));
      if (info.uuid !== matches[0].uuid || info.name !== target.name) throw storageError('RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH');
      return [{ id: info.uuid, name: info.name, bytes: info.database_size ?? info.file_size }];
    },
    async create(target) {
      assertTarget(target);
      assertStorageMutationApproval(plan, approval.extensions);
      if (plan.phase !== 'create' || target.databaseId !== null) throw storageError('CREATE_NOT_PLANNED');
      // Pinned Wrangler has no create --json. Discard its human output; only
      // independently re-read server inventory can establish resource identity.
      await command(['create', target.name, '--no-update-config']);
    },
    async inspect(target) {
      assertTarget(target);
      const schema = await query(target, STORAGE_SCHEMA_QUERY);
      if (schema.length !== 1) throw storageError('SCHEMA_RESULT_INVALID');
      let migrations = [];
      if (await inspectLedger(target)) {
        const ledger = await query(target, 'SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 129');
        if (ledger.length !== 1) throw storageError('SCHEMA_RESULT_INVALID');
        migrations = ledger[0].results;
      }
      return { schemaSha256: storageSchemaDigest(schema[0].results), migrations };
    },
    async migrate(target, migration) {
      assertTarget(target);
      assertStorageMutationApproval(plan, approval.extensions);
      if (plan.phase !== 'migrate' || !/^\d{4}_[a-z0-9_-]+\.sql$/.test(migration.name)
          || storageSha256(migration.sql) !== migration.sha256
          || !qualifications?.[target.binding]?.migrations.some((step) => step.name === migration.name
            && step.sha256 === migration.sha256 && step.sql === migration.sql)) throw storageError('MIGRATION_NOT_PLANNED');
      // Like Wrangler migrations, apply the file and its receipt in one SQL
      // submission. Reconciliation still requires BOTH the resulting schema
      // and exact prefix; a partial/unknown response never permits replay.
      await inspectLedger(target);
      assertStorageMutationApproval(plan, approval.extensions);
      await query(target, `${LEDGER}\n${migration.sql}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${migration.name}','${migration.sha256}');`);
    },
  };
}

export function parseStorageArguments(argv) {
  const allowed = new Set(['plan', 'worker-root', 'repository-root', 'directory', 'cli', 'approved-plan-sha256', 'confirmation', 'extension', 'approved-extension-sha256']);
  const options = { execute: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute' || arg === '--resume') {
      const key = arg.slice(2); if (options[key]) throw storageError('ARGUMENTS'); options[key] = true;
    } else {
      const key = arg.startsWith('--') ? arg.slice(2) : '';
      if (!allowed.has(key) || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw storageError('ARGUMENTS');
      options[key] = argv[++i];
    }
  }
  if (!options.plan || !options['worker-root'] || (options.execute && (!options.directory || !options.cli || !options['repository-root']))) throw storageError('ARGUMENTS');
  if ((options.extension || options['approved-extension-sha256']) && (!options.execute || !options.resume || !options.extension || !options['approved-extension-sha256'])) throw storageError('ARGUMENTS');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseStorageArguments(process.argv.slice(2));
    const info = await lstat(args.plan);
    if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024 || await realpath(args.plan) !== resolve(args.plan)) throw storageError('PLAN_FILE_UNSAFE');
    const plan = JSON.parse(await readFile(args.plan, 'utf8'));
    let extension = null;
    if (args.extension) {
      const extensionInfo = await lstat(args.extension);
      if (!extensionInfo.isFile() || extensionInfo.nlink !== 1 || extensionInfo.size < 1 || extensionInfo.size > 4096
          || await realpath(args.extension) !== resolve(args.extension)) throw storageError('EXTENSION_FILE_UNSAFE');
      extension = JSON.parse(await readFile(args.extension, 'utf8'));
    }
    const result = await runStorageOperation({ plan, workerRoot: args['worker-root'], repositoryRoot: args['repository-root'],
      directory: args.directory, execute: args.execute, resume: args.resume, confirmation: args.confirmation,
      extension, approvedExtensionSha256: args['approved-extension-sha256'] ?? null,
      approvedPlanSha256: args['approved-plan-sha256'], adapterFactory: (input) => createStorageWranglerAdapter({ ...input, cliPath: args.cli }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${/^D1_STORAGE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'D1_STORAGE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
