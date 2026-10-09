// Explicit artifact regression, separate from the network-free unit suite.
// --intake <absolute v3 intake> --app <absolute signed 0.1.26 app>
// --directory <absolute new synthetic output directory>
// Verifies but never launches or installs the app; retains only synthetic state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateProductionUpdateIntake, verifyProductionUpdatePredecessor,
  withProductionUpdatePredecessorIndex, readProductionUpdateSuccessorState } from '../../scripts/smoke-electron-macos-production-update.mjs';
import { seedSignedReplacementNativeState, readSignedReplacementState,
  assertSignedReplacementContinuity } from '../../scripts/smoke-electron-macos-replacement.mjs';
import { openLocalUnifiedIndex, readLocalUnifiedIndexCompatibility } from '../../src/local-unified-index.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inspectSchema(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return { compatibility: readLocalUnifiedIndexCompatibility(database),
      parsers: database.prepare('SELECT parser_version FROM parser_version ORDER BY parser_version').all()
        .map(row => row.parser_version) };
  } finally { database.close(); }
}
try {
  const args = process.argv.slice(2);
  assert.equal(process.version, 'v26.2.0');
  assert.equal(process.platform, 'darwin');
  assert.equal(args.length, 6);
  assert.deepEqual([args[0], args[2], args[4]], ['--intake', '--app', '--directory']);
  const [intakePath, app, directory] = [args[1], args[3], args[5]];
  assert.ok([intakePath, app, directory].every(path => isAbsolute(path) && !/[\0\r\n]/u.test(path)));
  const input = validateProductionUpdateIntake(JSON.parse(await readFile(intakePath, 'utf8')));
  assert.equal(input.schemaVersion, 'tibotattle-production-electron-update-intake-v3');
  await verifyProductionUpdatePredecessor(input, app);
  await mkdir(directory, { mode: 0o700 }); // Refuse an existing profile/output.
  const archive = join(app, 'Contents', 'Resources', 'app.asar');
  const archiveBefore = digest(await readFile(archive));
  const predecessor = await withProductionUpdatePredecessorIndex({ ...input, directory }, app, async index => index);
  assert.equal((await readdir(directory)).some(name => name.startsWith('predecessor-index-')), false);
  const result = await (async () => {
    const native = join(directory, 'synthetic-native'), database = join(native, 'local-unified-index-v1.sqlite');
    const seeded = await seedSignedReplacementNativeState(native, join(directory, 'synthetic-codex'), predecessor);
    const seededDigest = digest(await readFile(database)), beforeSchema = inspectSchema(database);
    assert.equal(beforeSchema.compatibility.userVersion, 11);
    assert.equal(beforeSchema.compatibility.formatUserVersion, 11);
    assert.equal(beforeSchema.compatibility.minimumReaderUserVersion, 11);
    assert.equal(beforeSchema.compatibility.minimumWriterUserVersion, 11);
    assert.deepEqual(beforeSchema.parsers, ['unified-rollout-typed-v18']);
    assert.equal(seeded.usageRows, 2);
    assert.equal(seeded.quotaRows, 2);
    assert.equal(seeded.tokensInUncached, 203);
    const baseline = await readSignedReplacementState(native, predecessor);
    assert.deepEqual(baseline, seeded);
    assert.deepEqual(inspectSchema(database), beforeSchema);
    assert.equal(digest(await readFile(database)), seededDigest);
    // Match the production lifetime: the authentic namespace probes pending
    // v11 after its owned extraction directory has already been removed.
    assert.equal(await readProductionUpdateSuccessorState(native, predecessor), null);
    assert.equal(digest(await readFile(database)), seededDigest);
    assert.throws(() => openLocalUnifiedIndex(database, { readOnly: true }),
      error => error.code === 'local_unified_index_schema_invalid');
    assert.equal(digest(await readFile(database)), seededDigest);
    const migrated = openLocalUnifiedIndex(database, { readOnly: false }); migrated.close();
    const afterSchema = inspectSchema(database), after = await readSignedReplacementState(native);
    assert.deepEqual(await readProductionUpdateSuccessorState(native, predecessor), after);
    assert.equal(afterSchema.compatibility.userVersion, 12);
    assert.equal(afterSchema.compatibility.formatUserVersion, 12);
    assert.equal(afterSchema.compatibility.minimumReaderUserVersion, 12);
    assert.equal(afterSchema.compatibility.minimumWriterUserVersion, 12);
    assert.deepEqual(afterSchema.parsers, beforeSchema.parsers);
    assertSignedReplacementContinuity(baseline, after,
      { language: 'es', appearance: 'dark', refreshIntervalSeconds: 900, startAtLogin: false },
      { enabled: false, transportStatus: 'off', noticeDue: false, basis: 'legacy_preserved' });
    const migratedDigest = digest(await readFile(database));
    for (const readOnly of [true, false]) {
      assert.throws(() => predecessor.openLocalUnifiedIndex(database, { readOnly }),
        error => error.code === 'local_unified_index_schema_newer');
      assert.equal(digest(await readFile(database)), migratedDigest);
    }
    return { beforeSchema, afterSchema, seededDigest, migratedDigest, retained: after,
      baselineReadUnchanged: true, currentReaderRefusedUnmigratedSchema: true,
      predecessorReaderAndWriterRefusedNewerSchemaWithoutMutation: true };
  })();
  assert.equal(digest(await readFile(archive)), archiveBefore);
  assert.equal((await readdir(directory)).some(name => name.startsWith('predecessor-index-')), false);
  const report = { status: 'passed', target: input.target, predecessorAsarSha256: archiveBefore,
    signedPredecessorVerified: true, signedArchiveUnchanged: true, scratchCleaned: true,
    appLaunched: false, appInstalled: false, ...result };
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
} catch {
  process.stderr.write('PRODUCTION_UPDATE_PREDECESSOR_INDEX_REGRESSION_FAILED\n');
  process.exitCode = 1;
}
