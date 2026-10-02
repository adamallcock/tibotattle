import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { INGESTION_ROLE_INPUT_DIRECTORIES, readIngestionRoleInputs } from './d1-storage-role.mjs';
import { SELECTIVE_DEPENDENCY_MIGRATION_INPUT as pin } from './migration-input-policy.mjs';

const actualWorker = join(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'migration-role-input-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await symlink(await realpath(join(actualWorker, 'node_modules')), join(root, 'node_modules'));
  for (const directory of INGESTION_ROLE_INPUT_DIRECTORIES) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, '0001_synthetic.sql'), 'CREATE TABLE synthetic(id INTEGER PRIMARY KEY);');
  }
  const path = join(root, pin.directory, pin.name);
  await copyFile(join(actualWorker, pin.directory, pin.name), path);
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' } });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'synthetic role inputs']);
  return { root, path };
}

test('ingestion input inventory admits exact pinned bytes and retains source digest shape', async t => {
  const { root } = await fixture(t);
  const inputs = await readIngestionRoleInputs(root);
  assert.equal(inputs.frozen, true); assert.equal(inputs.migrations.length, 7);
  assert.deepEqual(inputs.migrations.find(input => input.name === pin.name),
    { directory: pin.directory, name: pin.name, sha256: pin.sha256, bytes: pin.bytes });
  assert.equal(inputs.inputSha256, identityDigest(inputs.migrations));
  const latest = await readIngestionRoleInputs(actualWorker, { allowUnfrozen: true });
  assert.equal(latest.migrations.length, 95);
  assert.equal(latest.migrations.find(input => input.name === pin.name).sha256, pin.sha256);
});

test('ingestion inputs refuse changed pinned bytes and unrelated oversized files', async t => {
  for (const kind of ['changed', 'oversized']) {
    const { root, path } = await fixture(t);
    if (kind === 'changed') { const bytes = await readFile(path); bytes[0] ^= 1; await writeFile(path, bytes); }
    else await writeFile(join(root, pin.directory, '0017_unreviewed.sql'), Buffer.alloc(240 * 1024 + 1, 32));
    await assert.rejects(readIngestionRoleInputs(root, { allowUnfrozen: true }), { code: 'D1_STORAGE_ROLE_INPUT_UNSAFE' });
  }
});

test('the reviewed source exception preserves symlink and hard-link refusals', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const { root, path } = await fixture(t);
    const other = join(root, 'synthetic-selective-source.sql');
    await copyFile(path, other); await rm(path);
    if (kind === 'symlink') await symlink(other, path); else await link(other, path);
    await assert.rejects(readIngestionRoleInputs(root, { allowUnfrozen: true }), { code: 'D1_STORAGE_ROLE_INPUT_UNSAFE' });
  }
});
