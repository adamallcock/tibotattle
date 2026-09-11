import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReleaseChannel } from '../config/release-channels.js';
import { ELECTRON_SPARKLE_TRANSITION_SCHEMA, validateElectronSparkleTransitionManifest,
  validateElectronSparkleJourney, readElectronSparkleJourney, assertElectronSparkleContinuity,
  validateElectronSparkleDMG } from '../scripts/electron-sparkle-transition.js';
import { createProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const key = 'a'.repeat(64);
function fixture(architecture = 'arm64') {
  const channel = resolveReleaseChannel('stable', { architecture });
  const manifest = { schemaVersion: ELECTRON_SPARKLE_TRANSITION_SCHEMA,
    application: { architecture, bundleIdentifier: 'com.usagemonitor.local', bundleVersion: '1028', shortVersion: '0.1.21' },
    artifact: { fileName: `TiboTattle-0.1.21-${architecture === 'x64' ? 'macOS-x64' : 'mac-arm64'}.dmg`, bytes: 3, sha256: hash('dmg') },
    source: { repository: 'https://github.com/adamallcock/tibotattle', commit: 'b'.repeat(40), tag: 'v0.1.21' },
    channel: { ...channel, sparkle: { ...channel.sparkle, publicEdKeySha256: key } },
    sparkle: { appcastURL: channel.sparkle.appcastURL, publicEdKeySha256: key },
    electron: { buildNumber: '2026091105', asarSha256: 'c'.repeat(64), updaterConfigurationSha256: 'd'.repeat(64) },
    evidence: { scope: 'local_qualification', nativeSparkleJourney: { localPath: 'journey.json', bytes: 1, sha256: 'e'.repeat(64) } } };
  const proof = { schemaVersion: 'tibotattle-signed-macos-sparkle-transition-v1', status: 'passed',
    target: 'darwin-arm64', version: '0.1.21', buildNumber: '2026091105', bundleVersion: '1028',
    feedScope: 'isolated_test_feed', feedSha256: '1'.repeat(64), feedOverrideApplied: true, productionFeedVerified: false,
    candidateCopiedByRunner: false, signedArtifactVerified: true, disposableAccountVerified: true,
    checkForUpdatesClicked: true, installUpdateClicked: true, updaterRelaunchedCandidate: true,
    sourceRevision: manifest.source.commit, dmgSha256: manifest.artifact.sha256, asarSha256: manifest.electron.asarSha256,
    nativeVersion: '0.1.18', nativeDmgSha256: 'f'.repeat(64), nativeSparkleUpdateCompleted: true,
    migrationCompleted: true, retainedRowsPreserved: true, saltPreserved: true, preferencesPreserved: true,
    optOutPreserved: true, restartNoDuplicates: true, sourceUntouched: true, ownedProcessesStopped: true };
  const validate = value => validateElectronSparkleTransitionManifest(value,
    { path: value.artifact.fileName, size: value.artifact.bytes }, { sha256: key }, channel);
  return { manifest, proof, validate };
}

test('transition receipt separates timestamp provenance, Apple bundle version and incoming updater', () => {
  for (const architecture of ['arm64', 'x64']) {
    const { manifest, validate } = fixture(architecture);
    assert.equal(validate(manifest).bundleVersion, '1028');
    assert.equal(manifest.electron.buildNumber, '2026091105');
    assert.equal(Object.hasOwn(manifest, 'updater'), false);
    assert.equal(Object.hasOwn(manifest, 'assurances'), false);
  }
});

test('receipt rejects key/channel/source/architecture confusion, native assertions and invalid versions', () => {
  const changes = [m => { m.sparkle.publicEdKeySha256 = 'f'.repeat(64); },
    m => { m.sparkle.appcastURL = 'https://updates.tibotattle.com/electron/test/appcast.xml'; },
    m => { m.source.tag = 'v0.1.20'; }, m => { m.application.architecture = 'x64'; },
    m => { m.application.bundleVersion = '2026091105'; }, m => { m.application.bundleVersion = '0.1.21'; },
    m => { m.updater = { frameworkVersion: '2.9.3' }; },
    m => { m.evidence.nativeSparkleJourney.localPath = '../journey.json'; }];
  for (const change of changes) { const { manifest, validate } = fixture(); change(manifest); assert.throws(() => validate(manifest)); }
  const { manifest, validate } = fixture('x64'); manifest.artifact.fileName = 'TiboTattle-0.1.21-mac-x64.dmg';
  assert.throws(() => validate(manifest));
});

test('manual replacement evidence cannot qualify the native Sparkle transition', () => {
  const { manifest, proof } = fixture();
  assert.equal(validateElectronSparkleJourney(proof, manifest), proof);
  for (const field of ['nativeSparkleUpdateCompleted', 'migrationCompleted', 'retainedRowsPreserved', 'saltPreserved',
    'preferencesPreserved', 'optOutPreserved', 'restartNoDuplicates', 'sourceUntouched', 'ownedProcessesStopped',
    'signedArtifactVerified', 'disposableAccountVerified', 'checkForUpdatesClicked', 'installUpdateClicked', 'updaterRelaunchedCandidate', 'feedOverrideApplied']) {
    assert.throws(() => validateElectronSparkleJourney({ ...proof, [field]: false }, manifest));
  }
  for (const change of [{ schemaVersion: 'tibotattle-signed-replacement-v1' }, { status: 'failed' },
    { sourceRevision: 'a'.repeat(40) }, { dmgSha256: 'a'.repeat(64) }, { asarSha256: 'a'.repeat(64) }, { nativeVersion: '0.1.17' }, { target: 'darwin-x64' }, { version: '0.1.20' }, { buildNumber: '2026091104' },
    { bundleVersion: '1026' }, { feedScope: 'production_feed' }, { productionFeedVerified: true }, { candidateCopiedByRunner: true }, { feedSha256: null }]) {
    assert.throws(() => validateElectronSparkleJourney({ ...proof, ...change }, manifest));
  }
});

test('journey evidence is bound to exact bytes; missing proof prevents any native command', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sparkle-transition-proof-'));
  try {
    const { manifest, proof } = fixture();
    const path = join(root, 'receipt.json'), bytes = Buffer.from(JSON.stringify(proof));
    manifest.evidence.nativeSparkleJourney = { localPath: 'journey.json', bytes: bytes.length, sha256: hash(bytes) };
    await writeFile(join(root, 'journey.json'), bytes);
    assert.deepEqual(await readElectronSparkleJourney(manifest, path), proof);
    await writeFile(join(root, 'journey.json'), Buffer.from(JSON.stringify({ ...proof, optOutPreserved: false })));
    await assert.rejects(readElectronSparkleJourney(manifest, path));
    let calls = 0;
    await assert.rejects(validateElectronSparkleDMG(join(root, 'missing.dmg'), { manifest, manifestPath: path,
      commandRunner: () => { calls++; throw Error('unexpected'); } }));
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subsequent transition continuity rejects bootstrap, downgrade, key and architecture drift', () => {
  const { manifest } = fixture();
  const previous = structuredClone(manifest); previous.application.bundleVersion = '2026091001'; previous.application.shortVersion = '0.1.20'; previous.source.tag = 'v0.1.20'; previous.artifact.fileName = 'TiboTattle-0.1.20-mac-arm64.dmg';
  assert.throws(() => assertElectronSparkleContinuity({ manifest, previousManifest: previous }));
  for (const options of [{ previousManifest: null }, { previousManifest: previous, stableBootstrap: true },
    { previousManifest: manifest }, { previousManifest: { ...previous, sparkle: { ...previous.sparkle, publicEdKeySha256: 'f'.repeat(64) } } },
    { previousManifest: fixture('x64').manifest }]) assert.throws(() => assertElectronSparkleContinuity({ manifest, ...options }));
});


test('mounted Electron inspector binds signed identity, architecture, ASAR, updater and detaches on rejection', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sparkle-transition-inspection-'));
  try {
    const { manifest, proof } = fixture();
    const mount = join(root, 'volume'), app = join(mount, 'TiboTattle.app');
    await mkdir(join(app, 'Contents/Resources/native'), { recursive: true });
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    await symlink('/Applications', join(mount, 'Applications'));
    const asar = Buffer.from('signed-asar'), updater = Buffer.from('provider: generic\nurl: https://updates.tibotattle.com/electron/stable/darwin-arm64\n');
    await writeFile(join(app, 'Contents/Resources/app.asar'), asar);
    await writeFile(join(app, 'Contents/Resources/app-update.yml'), updater);
    await writeFile(join(app, 'Contents/MacOS/TiboTattleNativeHandover'), 'helper');
    await writeFile(join(app, 'Contents/Resources/native/macos-keychain.node'), 'adapter');
    const dmgPath = join(root, manifest.artifact.fileName);
    await writeFile(dmgPath, 'dmg');
    manifest.electron.asarSha256 = hash(asar); manifest.electron.updaterConfigurationSha256 = hash(updater);
    proof.asarSha256 = hash(asar);
    const proofBytes = Buffer.from(JSON.stringify(proof));
    manifest.evidence.nativeSparkleJourney = { localPath: 'journey.json', bytes: proofBytes.length, sha256: hash(proofBytes) };
    await writeFile(join(root, 'journey.json'), proofBytes);
    const pkg = { name: 'app-usagemonitor', version: '0.1.21', tibotattleDistribution:
      createProductionDistributionMetadata({ target: 'darwin-arm64', sourceRevision: manifest.source.commit, buildNumber: manifest.electron.buildNumber }) };
    let wrongArch = false; const calls = [];
    const commandRunner = (command, args) => {
      calls.push([command, ...args]);
      if (command.endsWith('plutil')) return { stdout: JSON.stringify(args.at(-1) === '-'
        ? { 'system-entities': [{ 'mount-point': mount, 'dev-entry': '/dev/synthetic-test' }] }
        : { CFBundleIdentifier: 'com.usagemonitor.local', CFBundleVersion: '1028', CFBundleShortVersionString: '0.1.21',
          CFBundleExecutable: 'TiboTattle', LSMinimumSystemVersion: '14.0' }), stderr: '' };
      if (command.endsWith('lipo')) return { stdout: wrongArch ? 'x86_64' : 'arm64', stderr: '' };
      return { stdout: '', stderr: args.includes('-dv') ? 'CodeDirectory flags=0x10000(runtime)' : '' };
    };
    const options = { manifest, manifestPath: join(root, 'receipt.json'), commandRunner, readAsarPackage: () => pkg };
    assert.deepEqual(await validateElectronSparkleDMG(dmgPath, options), { source: { commit: manifest.source.commit, tag: 'v0.1.21' } });
    assert(calls.some(call => call[0].endsWith('codesign') && call.some(arg => arg.startsWith('-R=identifier'))));
    assert.equal(calls.filter(call => call.includes('detach')).length, 1);
    wrongArch = true;
    await assert.rejects(validateElectronSparkleDMG(dmgPath, options), { code: 'SPARKLE_ELECTRON_TRANSITION_ARCHITECTURE_MISMATCH' });
    assert.equal(calls.filter(call => call.includes('detach')).length, 2);
    wrongArch = false; pkg.tibotattleDistribution = { ...pkg.tibotattleDistribution, sourceRevision: 'd'.repeat(40) };
    await assert.rejects(validateElectronSparkleDMG(dmgPath, options), { code: 'SPARKLE_ELECTRON_TRANSITION_DISTRIBUTION_MISMATCH' });
    assert.equal(calls.filter(call => call.includes('detach')).length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('native predecessor must be exact 0.1.18 archive exercised by the journey', () => {
  const { manifest, proof } = fixture();
  for (const previousManifest of [
    { application: { shortVersion: '0.1.17' }, artifact: { sha256: proof.nativeDmgSha256 } },
    { application: { shortVersion: '0.1.18' }, artifact: { sha256: '1'.repeat(64) } },
  ]) assert.throws(() => assertElectronSparkleContinuity({ manifest, previousManifest, journey: proof }),
    { code: 'SPARKLE_ELECTRON_TRANSITION_NATIVE_PREDECESSOR_MISMATCH' });
});
