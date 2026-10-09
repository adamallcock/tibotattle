// Explicit artifact regression, separate from the network-free unit suite.
// --intake <absolute v3 intake> --app <absolute signed 0.1.26 app>
// --directory <absolute new synthetic output directory>
// Verifies but never launches or installs the app; retains only synthetic state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateProductionUpdateIntake, verifyProductionUpdatePredecessor,
  withProductionUpdatePredecessorIndex, readProductionUpdateSuccessorState,
  seedProductionUpdateRetainedNativeState } from '../../scripts/smoke-electron-macos-production-update.mjs';
import { readSignedReplacementState,
  assertSignedReplacementContinuity } from '../../scripts/smoke-electron-macos-replacement.mjs';
import { openLocalUnifiedIndex, readLocalUnifiedIndexCompatibility, LOCAL_UNIFIED_INDEX_PARSER_VERSION } from '../../src/local-unified-index.js';
import { inspectLocalOnboarding } from '../../src/local-installation-diagnostics.js';
import { createLocalCollectorRefreshRunner } from '../../src/local-companion-refresh.js';
import { ingestLocalUnifiedIndexOffMain } from '../../src/local-unified-index-off-main.js';

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
  const codexHome = join(directory, 'synthetic-codex'), native = join(directory, 'synthetic-native');
  await mkdir(codexHome, { mode: 0o700 }); await mkdir(join(codexHome, 'sessions'), { mode: 0o700 });
  const { predecessor, seeded } = await withProductionUpdatePredecessorIndex({ ...input, directory }, app, async (index, ingest) => {
    const seeded = await seedProductionUpdateRetainedNativeState(native, codexHome, index, ingest);
    // Model another ordinary predecessor refresh before the app baseline.
    const repeated = await ingest({ codexHome, indexFile: join(native, 'local-unified-index-v1.sqlite'),
      secretFile: join(native, 'local-unified-index-device-salt-v1'), contractVersion: 'telemetry-contribution-v0.1' });
    assert.equal(repeated.status, 'ingested');
    assert.equal(repeated.unchanged, true);
    assert.equal(repeated.insertedUsageEvents, 0);
    assert.equal(repeated.generation.status, 'complete');
    assert.deepEqual(await readSignedReplacementState(native, index), seeded);
    return { predecessor: index, seeded };
  });
  assert.equal((await readdir(directory)).some(name => name.startsWith('predecessor-index-')), false);
  const result = await (async () => {
    const database = join(native, 'local-unified-index-v1.sqlite');
    const onboarding = await inspectLocalOnboarding({ codexHome, stateRoot: native });
    assert.equal(onboarding.status, 'ready');
    assert.equal(onboarding.source.rolloutFilesPresent, true);
    assert.equal(onboarding.source.rolloutFilesObserved, 1);
    const sourceNames = await readdir(join(codexHome, 'sessions'));
    assert.deepEqual(sourceNames, ['rollout-2026-08-01T00-00-00-22222222-2222-4222-8222-222222222222.jsonl']);
    const source = join(codexHome, 'sessions', sourceNames[0]), sourceBefore = digest(await readFile(source));
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
    const successor = join(directory, 'synthetic-successor'), successorDatabase = join(successor, 'local-unified-index-v1.sqlite');
    await cp(native, successor, { recursive: true, errorOnExist: true, force: false });
    // The actual companion composition owns migration. The injected collector
    // has no provider/credential effects; real detailed ingestion runs off-main.
    const createRefresh = () => createLocalCollectorRefreshRunner({ codexHome, environment: {},
      accountingSourceMode: 'unified', unifiedIndexFile: successorDatabase,
      unifiedIndexSecretFile: join(successor, 'local-unified-index-device-salt-v1'),
      selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
      runCollector: async () => ({ rolloutRecordsWritten: 0, filesDiscovered: 1 }),
      refreshUnifiedIndex: options => ingestLocalUnifiedIndexOffMain({ ...options, contractVersion: 'telemetry-contribution-v0.1' }),
    });
    let refresh = createRefresh();
    const refreshes = [];
    for (let pass = 0; pass < 3; pass += 1) {
      if (pass === 2) refresh = createRefresh(); // New companion refresh lifetime.
      const { unifiedIndex } = await refresh({ mode: 'detailed' });
      assert.equal(unifiedIndex.status, 'ingested');
      assert.equal(unifiedIndex.unchanged, pass > 0);
      assert.equal(unifiedIndex.insertedUsageEvents, 0);
      assert.equal(unifiedIndex.totalUsageEvents, 2);
      assert.equal(unifiedIndex.generation.status, 'partial');
      assert.equal(unifiedIndex.generation.blockReason, 'tool_provenance_incomplete');
      assert.equal(unifiedIndex.generation.discoveredSourceCount, 1);
      assert.equal(unifiedIndex.generation.indexedSourceCount, 2);
      assert.equal(unifiedIndex.generation.quotaOccurrences, 2);
      assert.equal(unifiedIndex.generation.toolProvenanceComplete, false);
      for (const key of ['discoveryComplete', 'diagnosticsComplete', 'usageProvenanceComplete',
        'sourceOrderComplete', 'quotaProvenanceComplete']) assert.equal(unifiedIndex.generation[key], true);
      const after = await readSignedReplacementState(successor);
      assertSignedReplacementContinuity(baseline, after,
        { language: 'es', appearance: 'dark', refreshIntervalSeconds: 900, startAtLogin: false },
        { enabled: false, transportStatus: 'off', noticeDue: false, basis: 'legacy_preserved' });
      refreshes.push({ unchanged: unifiedIndex.unchanged, insertedUsageEvents: unifiedIndex.insertedUsageEvents,
        generationStatus: unifiedIndex.generation.status, blockReason: unifiedIndex.generation.blockReason });
    }
    assert.equal(digest(await readFile(database)), seededDigest);
    assert.equal(digest(await readFile(source)), sourceBefore);
    const afterSchema = inspectSchema(successorDatabase), after = await readSignedReplacementState(successor);
    assert.deepEqual(await readProductionUpdateSuccessorState(successor, predecessor), after);
    assert.equal(afterSchema.compatibility.userVersion, 12);
    assert.equal(afterSchema.compatibility.formatUserVersion, 12);
    assert.equal(afterSchema.compatibility.minimumReaderUserVersion, 12);
    assert.equal(afterSchema.compatibility.minimumWriterUserVersion, 12);
    assert.deepEqual(afterSchema.parsers, [...beforeSchema.parsers, LOCAL_UNIFIED_INDEX_PARSER_VERSION].sort());
    const migratedDigest = digest(await readFile(successorDatabase));
    for (const readOnly of [true, false]) {
      assert.throws(() => predecessor.openLocalUnifiedIndex(successorDatabase, { readOnly }),
        error => error.code === 'local_unified_index_schema_newer');
      assert.equal(digest(await readFile(successorDatabase)), migratedDigest);
    }
    return { beforeSchema, afterSchema, seededDigest, migratedDigest, retained: after,
      predecessorRepeatedRefreshUnchanged: true, onboardingWithSourceReady: true, refreshes,
      syntheticPredecessorCopyUnchanged: true, syntheticSourceUnchanged: true,
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
