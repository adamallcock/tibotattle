import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIGRATION_INPUT_MAX_BYTES,
  SELECTIVE_DEPENDENCY_MIGRATION_INPUT as pin,
  assertMigrationInputPolicy,
  migrationInputMaximumBytes,
} from './migration-input-policy.mjs';

const workerDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinnedBytes = await readFile(join(workerDirectory, pin.directory, pin.name));
const reviewed = (bytes = pinnedBytes, root = workerDirectory) =>
  ({ workerDirectory: root, directory: pin.directory, name: pin.name, bytes });
const invalid = { code: 'MIGRATION_INPUT_POLICY_INVALID' };

test('ordinary source allowance remains exactly 240 KiB', () => {
  assert.equal(DEFAULT_MIGRATION_INPUT_MAX_BYTES, 240 * 1024);
  assert.equal(migrationInputMaximumBytes('migrations', '0001_synthetic.sql'), DEFAULT_MIGRATION_INPUT_MAX_BYTES);
  const ordinary = { workerDirectory, directory: 'migrations', name: '0001_synthetic.sql' };
  assert.doesNotThrow(() => assertMigrationInputPolicy({ ...ordinary, bytes: Buffer.alloc(DEFAULT_MIGRATION_INPUT_MAX_BYTES, 32) }));
  assert.throws(() => assertMigrationInputPolicy({ ...ordinary, bytes: Buffer.alloc(DEFAULT_MIGRATION_INPUT_MAX_BYTES + 1, 32) }), invalid);
});

test('only the exact reviewed source path and digest receive the larger allowance', () => {
  assert.equal(migrationInputMaximumBytes(pin.directory, pin.name), 269024);
  assert.doesNotThrow(() => assertMigrationInputPolicy(reviewed()));
  for (const changed of [{ directory: 'migrations' }, { name: '0017_unreviewed.sql' }, { directory: '../ingestion-isolation-migrations' }])
    assert.throws(() => assertMigrationInputPolicy({ ...reviewed(), ...changed }), invalid);
  const changed = Buffer.from(pinnedBytes); changed[0] ^= 1;
  for (const bytes of [changed, pinnedBytes.subarray(0, pinnedBytes.length - 1), Buffer.concat([pinnedBytes, Buffer.from(' ')])])
    assert.throws(() => assertMigrationInputPolicy(reviewed(bytes)), invalid);
});

test('empty, NUL and invalid UTF-8 inputs remain refused', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([255])])
    assert.throws(() => assertMigrationInputPolicy({ workerDirectory, directory: 'migrations', name: '0001_synthetic.sql', bytes }), invalid);
});

async function splitterFixture(t, statements) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'migration-input-split-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{}');
  await mkdir(join(root, 'node_modules', 'wrangler'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'wrangler', 'index.js'),
    `exports.unstable_splitSqlQuery = () => ${JSON.stringify(statements)};`);
  return root;
}

test('the exact pinned file still refuses changed splitter counts or oversized statements', async t => {
  for (const statements of [Array(128).fill('SELECT 1'), Array(130).fill('SELECT 1'), [...Array(128).fill('SELECT 1'), 'x'.repeat(8193)], [...Array(128).fill('SELECT 1'), ''], [...Array(128).fill('SELECT 1'), null]]) {
    const root = await splitterFixture(t, statements);
    assert.throws(() => assertMigrationInputPolicy(reviewed(pinnedBytes, root)), invalid);
  }
});

test('unavailable or invalid splitter runtimes return only the bounded policy error', () => {
  assert.throws(() => assertMigrationInputPolicy(reviewed(pinnedBytes, '/synthetic-unavailable-runtime')), invalid);
});
