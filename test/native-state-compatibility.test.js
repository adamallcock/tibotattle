import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openLocalUnifiedIndex, validateRetainedNativeState } from '../src/local-unified-index.js';

async function fixture(run) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'native-compatibility-test-'));
  await chmod(stateRoot, 0o700);
  try { await run(stateRoot, join(stateRoot, 'local-unified-index-v1.sqlite')); }
  finally { await rm(stateRoot, { recursive: true, force: true }); }
}
async function snapshot(root) {
  return Promise.all((await readdir(root)).sort().map(async name => [name, (await readFile(join(root, name))).toString('hex')]));
}

test('retained native compatibility permits a profile without an index without creating state', async () => {
  await fixture(async stateRoot => {
    assert.equal(await validateRetainedNativeState({ stateRoot }), true);
    assert.deepEqual(await readdir(stateRoot), []);
  });
});

test('current index with live WAL validates without modifying database, WAL or shared memory', async () => {
  await fixture(async (stateRoot, indexFile) => {
    const database = openLocalUnifiedIndex(indexFile, { create: true });
    try {
      database.exec("PRAGMA journal_mode=WAL");
      database.exec("INSERT INTO meta(key,value) VALUES('native_test','retained')");
      const before = await snapshot(stateRoot);
      assert(before.some(([name]) => name.endsWith('-wal')));
      assert.equal(await validateRetainedNativeState({ stateRoot }), true);
      assert.deepEqual(await snapshot(stateRoot), before);
      assert.equal(database.prepare("SELECT value FROM meta WHERE key='native_test'").get().value, 'retained');
    } finally { database.close(); }
  });
});

test('recognized historical schema uses authoritative migration admission without changing source version', async () => {
  await fixture(async (stateRoot, indexFile) => {
    const database = openLocalUnifiedIndex(indexFile, { create: true });
    database.exec("PRAGMA user_version=9; DELETE FROM meta WHERE key LIKE 'compatibility_%'");
    database.close();
    const before = await snapshot(stateRoot);
    assert.equal(await validateRetainedNativeState({ stateRoot }), true);
    assert.deepEqual(await snapshot(stateRoot), before);
  });
});

test('newer, foreign and corrupt databases are refused without changing retained bytes', async () => {
  for (const mode of ['newer', 'foreign', 'corrupt']) {
    await fixture(async (stateRoot, indexFile) => {
      const database = openLocalUnifiedIndex(indexFile, { create: true });
      if (mode === 'newer') database.exec('PRAGMA user_version=999');
      if (mode === 'foreign') database.exec('PRAGMA application_id=77');
      database.close();
      if (mode === 'corrupt') await writeFile(indexFile, 'not a database', { mode: 0o600 });
      const before = await snapshot(stateRoot);
      await assert.rejects(validateRetainedNativeState({ stateRoot }));
      assert.deepEqual(await snapshot(stateRoot), before);
    });
  }
});

test('symlinked index is rejected and its target is preserved', async () => {
  await fixture(async (stateRoot, indexFile) => {
    const target = join(stateRoot, 'target');
    await writeFile(target, 'preserve', { mode: 0o600 });
    await symlink(target, indexFile);
    await assert.rejects(validateRetainedNativeState({ stateRoot }));
    assert.equal(await readFile(target, 'utf8'), 'preserve');
  });
});

test('actual native 0.1.16 physical schema migrates forward with retained records', async () => {
  await fixture(async (stateRoot, indexFile) => {
    const database = new DatabaseSync(indexFile);
    database.exec(await readFile(new URL('./fixtures/native-index-v8.sql', import.meta.url), 'utf8'));
    database.exec("INSERT INTO meta(key,value) VALUES('native_retained_marker','preserved')");
    database.close();
    await chmod(indexFile, 0o600);
    const before = await snapshot(stateRoot);
    assert.equal(await validateRetainedNativeState({ stateRoot }), true);
    assert.deepEqual(await snapshot(stateRoot), before);
    const upgraded = openLocalUnifiedIndex(indexFile);
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 11);
      assert.equal(upgraded.prepare("SELECT value FROM meta WHERE key='native_retained_marker'").get().value, 'preserved');
    } finally { upgraded.close(); }
  });
});
