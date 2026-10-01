import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TYPED_SCHEMA_INPUT_DIRECTORIES,
  buildTypedProductionExpectedSchemas,
} from './production-typed-schema.mjs';
import { storageSchemaDigest } from './d1-storage-plan.mjs';

const actualWorker = join(dirname(fileURLToPath(import.meta.url)), '..');

const syntheticTypedEvidenceRows = rows => rows.map(row => row.type === 'table'
  ? { ...row, sql: row.sql.replace(/^(CREATE TABLE )([A-Za-z_][A-Za-z0-9_]*)/u, '$1"$2"') }
  : row);

async function canonicalPrimaryRows(f) {
  const require = createRequire(join(f.root, 'package.json'));
  const split = require('wrangler').unstable_splitSqlQuery;
  const db = new DatabaseSync(':memory:');
  try {
    for (const directory of TYPED_SCHEMA_INPUT_DIRECTORIES.primary) {
      const sql = await readFile(f.files.get(`primary:${directory}`), 'utf8');
      for (const statement of split(sql)) db.exec(statement);
    }
    return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND tbl_name <> 'd1_storage_migrations' ORDER BY type,name").all();
  } finally {
    db.close();
  }
}

async function fixture(t, { correction = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-schema-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{}\n');
  await symlink(await realpath(join(actualWorker, 'node_modules')), join(root, 'node_modules'), 'dir');
  const files = new Map();
  for (const [role, directories] of Object.entries(TYPED_SCHEMA_INPUT_DIRECTORIES)) {
    for (const directory of directories) {
      const path = join(root, directory);
      await mkdir(path, { recursive: true });
      const name = '0001_synthetic.sql';
      const table = `synthetic_${role}_${directory.replaceAll('-', '_')}`;
      const file = join(path, name);
      const correctionTable = correction && role === 'primary' && directory === 'migrations'
        ? 'CREATE TABLE telemetry_usage_correction_facts(id INTEGER PRIMARY KEY);\n'
        : '';
      await writeFile(file, `CREATE TABLE ${table}(id INTEGER PRIMARY KEY);\n${correctionTable}`);
      files.set(`${role}:${directory}`, file);
    }
  }
  for (const relativePath of [
    'src/authority-restore-schema.ts',
    'src/authority-restore-bootstrap.ts',
    'scripts/d1-storage-migration-worker.mjs',
  ]) {
    const destination = join(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(actualWorker, relativePath), destination);
  }
  await writeFile(join(root, 'src/authority-restore-role.ts'), 'export const authorityRoleFinalSchema = rows => rows;\n');
  await writeFile(join(root, 'src/authority-restore.ts'),
    'export const typedEvidenceRestoreFinalSchema = rows => rows.map(row => row.type === \'table\'\n'
      + '  ? { ...row, sql: row.sql.replace(/^(CREATE TABLE )([A-Za-z_][A-Za-z0-9_]*)/u, \'$1"$2"\') }\n'
      + '  : row);\n');
  return { root, files };
}

test('derives all three expected schemas from fresh local canonical inputs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'live-only.json'), 'synthetic live metadata must be ignored');
  const generated = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  assert.deepEqual(Object.keys(generated.expectedSchemas).sort(), ['analytics', 'ledger', 'primary']);
  assert.deepEqual(generated.migrationCounts, { primary: 6, analytics: 1, ledger: 1 });
  assert.ok(Object.values(generated.expectedSchemas).every(value => /^[a-f0-9]{64}$/.test(value.schemaSha256)));
  assert.equal(generated.expectedSchemas.primary.optionalObjects.length, 17);
  assert.deepEqual(generated.expectedSchemas.analytics.optionalObjects, []);
  assert.match(generated.operatorSchemaSourceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(generated).includes('live metadata'), false);
  assert.ok((await lstat(f.files.get('primary:migrations'))).nlink === 1);
});

test('canonical source changes alter the expected digest and input pin', async t => {
  const f = await fixture(t);
  const first = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  const path = f.files.get('primary:migrations');
  await writeFile(path, 'CREATE TABLE synthetic_changed(id INTEGER PRIMARY KEY);\n');
  const second = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  assert.notEqual(second.expectedSchemas.primary.schemaSha256, first.expectedSchemas.primary.schemaSha256);
  assert.notEqual(second.inputSha256.primary, first.inputSha256.primary);
});

test('generates the typed-evidence restore digest for a correction-bearing source', async t => {
  const f = await fixture(t, { correction: true });
  const generated = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  const rows = await canonicalPrimaryRows(f);
  const typedEvidenceDigest = storageSchemaDigest(syntheticTypedEvidenceRows(rows));
  const variants = generated.expectedSchemas.primary.restoredSchemaSha256;
  assert.equal(variants.length, 2);
  assert.equal(variants.includes(typedEvidenceDigest), true);
  assert.notEqual(typedEvidenceDigest, generated.expectedSchemas.primary.schemaSha256);
});

test('refuses symlinked and hard-linked canonical migration files', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture(t);
    const path = f.files.get('primary:migrations');
    const target = join(f.root, `${kind}-target.sql`);
    await writeFile(target, 'CREATE TABLE synthetic_target(id INTEGER PRIMARY KEY);\n');
    await rm(path);
    if (kind === 'symlink') await symlink(target, path);
    else await link(target, path);
    await assert.rejects(buildTypedProductionExpectedSchemas({ workerDirectory: f.root }), {
      code: 'PRODUCTION_TYPED_SCHEMA_INPUT_FILE_UNSAFE',
    });
  }
});

test('refuses malformed canonical SQL before returning a schema expectation', async t => {
  const f = await fixture(t);
  await writeFile(f.files.get('analytics:analytics-migrations'), 'CREATE TABLE malformed (\n');
  await assert.rejects(buildTypedProductionExpectedSchemas({ workerDirectory: f.root }), {
    code: 'PRODUCTION_TYPED_SCHEMA_CANONICAL_SQL_INVALID',
  });
});

test('refuses canonical SQL that can escape the in-memory qualification database', async t => {
  const f = await fixture(t);
  await writeFile(f.files.get('primary:migrations'), 'ATTACH DATABASE \'/tmp/typed-schema-escape.sqlite\' AS escape;\n');
  await assert.rejects(buildTypedProductionExpectedSchemas({ workerDirectory: f.root }), {
    code: 'PRODUCTION_TYPED_SCHEMA_CANONICAL_SQL_UNSAFE',
  });
});

test('fails closed when reviewed operator DDL is not an exact exported literal', async t => {
  const f = await fixture(t);
  const schemaPath = join(f.root, 'src/authority-restore-schema.ts');
  const schemaSource = await readFile(schemaPath, 'utf8');
  await writeFile(schemaPath, schemaSource.replace(
    'export const AUTHORITY_RESTORE_SCHEMA = [',
    'export const AUTHORITY_RESTORE_SCHEMA = [operatorDdl(',
  ));
  await assert.rejects(buildTypedProductionExpectedSchemas({ workerDirectory: f.root }), {
    code: 'PRODUCTION_TYPED_SCHEMA_OPERATOR_SOURCE_ARRAY_INVALID',
  });

  await writeFile(schemaPath, schemaSource);
  const bootstrapPath = join(f.root, 'src/authority-restore-bootstrap.ts');
  const bootstrapSource = await readFile(bootstrapPath, 'utf8');
  await writeFile(bootstrapPath, bootstrapSource.replace(
    'export const AUTHORITY_RESTORE_BOOTSTRAP_STATE_SCHEMA=`',
    'export const AUTHORITY_RESTORE_BOOTSTRAP_STATE_SCHEMA=wrap(`',
  ));
  await assert.rejects(buildTypedProductionExpectedSchemas({ workerDirectory: f.root }), {
    code: 'PRODUCTION_TYPED_SCHEMA_OPERATOR_SOURCE_EXPORT_INVALID',
  });
});

test('restore transformation changes are bound into the operation source identity', async t => {
  const f = await fixture(t);
  const first = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  await writeFile(join(f.root, 'src/authority-restore-role.ts'), 'export const authorityRoleFinalSchema = rows => rows.map(row => ({ ...row, sql: row.sql + " " }));\n');
  const second = await buildTypedProductionExpectedSchemas({ workerDirectory: f.root });
  assert.notEqual(second.operatorSchemaSourceSha256, first.operatorSchemaSourceSha256);
  assert.notDeepEqual(second.expectedSchemas.primary.restoredSchemaSha256, first.expectedSchemas.primary.restoredSchemaSha256);
  assert.equal(second.expectedSchemas.primary.schemaSha256, first.expectedSchemas.primary.schemaSha256);
});
