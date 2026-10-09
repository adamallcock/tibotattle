import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import {
  WINDOWS_FINAL_UPGRADE_PREDECESSOR as predecessor,
  validateWindowsFinalUpgradePredecessor, parseWindowsFinalUpgradeMode, resolveWindowsFinalUpgradeSuccessor,
  validateWindowsFinalUpgradePredecessorManifest, snapshotWindowsFinalUpgradeProfile,
  runWindowsFinalUpgradeContinuity, runWindowsFinalUpgrade,
} from '../scripts/smoke-electron-windows-final-upgrade.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const oldRevision = predecessor.sourceRevision, newRevision = 'a'.repeat(40);
const oldIdentity = { sourceRevision: oldRevision, target: 'win32-x64',
  artifactSha256: 'b'.repeat(64), executableSha256: 'c'.repeat(64),
  native: { windowsFilesystemSha256: 'd'.repeat(64), keytarSha256: 'e'.repeat(64) } };
const newIdentity = { ...oldIdentity, sourceRevision: newRevision, artifactSha256: 'f'.repeat(64) };
const expectedJourney = { dashboardRendered: true, localRefreshObserved: true,
  localRefreshTerminal: 'succeeded', syntheticIngestionVerified: true,
  projectsAndThreadsVerified: true, sharingOptOutRetained: true, settingsPersisted: true, cleanQuit: true };
function fixture(overrides = {}) {
  const calls = [], profile = { root: String.raw`C:\owned\profile` }, seed = {};
  let replaced = false, snapshots = 0;
  const candidateState = { quiescent: true, tracked: null };
  const previous = { sourceRevision: oldRevision, expectedAsarSha256: oldIdentity.artifactSha256,
    expectedExecutableSha256: oldIdentity.executableSha256 };
  const candidate = { sourceRevision: newRevision, expectedAsarSha256: newIdentity.artifactSha256,
    expectedExecutableSha256: newIdentity.executableSha256 };
  const deps = {
    verifyPackage: async options => {
      calls.push(`verify:${options.sourceRevision === oldRevision ? 'old' : 'new'}`);
      assert.equal(options.sourceRevision, replaced ? newRevision : oldRevision);
      return replaced ? newIdentity : oldIdentity;
    },
    launchJourney: async options => {
      assert.equal(options.profile, profile);
      calls.push(`launch:${options.changeSettings ? 'seed' : 'retained'}`);
      candidateState.quiescent = true;
      candidateState.tracked = [{ pid: replaced ? 201 : 101, creation: 'old-main' },
        { pid: replaced ? 202 : 102, creation: 'old-companion' }];
      return { ...expectedJourney };
    },
    verifyOptOut: async selected => { assert.equal(selected, seed); calls.push('optout'); return true; },
    processAbsence: async options => {
      assert.equal(options.tracked, candidateState.tracked);
      assert.equal(options.tracked.length, 2); calls.push('absence');
    },
    snapshotProfile: async selected => {
      assert.equal(selected, profile.root); snapshots += 1; calls.push('snapshot');
      return { sha256: '1'.repeat(64), entries: 9, bytes: 4000 };
    },
    ...overrides,
  };
  return { calls, candidateState, deps, snapshots: () => snapshots,
    input: { previous, candidate, appPath: String.raw`C:\owned\app\TiboTattle.exe`, profile, seed,
      environment: {}, candidateState, replaceInstaller: async () => {
        assert.equal(candidateState.quiescent, true); calls.push('replace'); replaced = true;
      } } };
}

test('only the two explicitly allocated signed successor identities select final upgrade receipts', () => {
  const historical = { version: '0.1.27', buildNumber: '2026100301' };
  const replacement = { version: '0.1.28', buildNumber: '2026100901' };
  assert.deepEqual(resolveWindowsFinalUpgradeSuccessor(historical), { ...historical, receiptSchema: 'tibotattle-windows-final-upgrade-v1' });
  assert.deepEqual(resolveWindowsFinalUpgradeSuccessor(replacement), { ...replacement, receiptSchema: 'tibotattle-windows-final-upgrade-v2' });
  for (const value of [{}, { version: '0.1.28' }, { version: '0.1.27', buildNumber: replacement.buildNumber },
    { version: '0.1.28', buildNumber: historical.buildNumber }, { version: '0.1.28', buildNumber: '2026100902' },
    { version: '0.1.26', buildNumber: '2026092701' }, { version: '0.1.29', buildNumber: replacement.buildNumber },
    { version: 'toString', buildNumber: replacement.buildNumber }, { ...replacement, buildNumber: 2026100901 }]) {
    assert.throws(() => resolveWindowsFinalUpgradeSuccessor(value), /SUCCESSOR_INTAKE_INVALID/u);
  }
});

test('upgrade mode is explicit and preserves empty historical clean/diagnostic intakes', () => {
  assert.equal(parseWindowsFinalUpgradeMode({}), null);
  assert.equal(parseWindowsFinalUpgradeMode({ qualifyInstalled: 'true', qualifyUpgrade: 'false', predecessorIntake: '' }), null);
  assert.equal(parseWindowsFinalUpgradeMode({ qualifyInstalled: 'true', qualifyUpgrade: 'true', predecessorIntake: JSON.stringify(predecessor) }), predecessor);
  for (const value of [
    { qualifyInstalled: 'false', qualifyUpgrade: 'true', predecessorIntake: JSON.stringify(predecessor) },
    { qualifyInstalled: 'true', qualifyUpgrade: 'false', predecessorIntake: JSON.stringify(predecessor) },
    { qualifyInstalled: 'true', qualifyUpgrade: 'true', predecessorIntake: '{}' },
    { qualifyInstalled: 'true', qualifyUpgrade: 'true', predecessorIntake: 'x'.repeat(4097) },
    { qualifyInstalled: 'true', qualifyUpgrade: 'yes' },
  ]) assert.throws(() => parseWindowsFinalUpgradeMode(value), /ELECTRON_WINDOWS_FINAL_UPGRADE_/u);
});

test('predecessor intake admits only exact reviewed published identity and no caller URLs', () => {
  assert.equal(validateWindowsFinalUpgradePredecessor({ ...predecessor }), predecessor);
  for (const key of Object.keys(predecessor)) {
    const value = { ...predecessor }; delete value[key];
    assert.throws(() => validateWindowsFinalUpgradePredecessor(value), /PREDECESSOR_INTAKE_INVALID/u);
    assert.throws(() => validateWindowsFinalUpgradePredecessor({ ...predecessor, [key]: 'changed' }), /PREDECESSOR_INTAKE_INVALID/u);
  }
  assert.throws(() => validateWindowsFinalUpgradePredecessor({ ...predecessor, url: 'https://example.invalid' }), /PREDECESSOR_INTAKE_INVALID/u);
  assert.throws(() => validateWindowsFinalUpgradePredecessorManifest(Buffer.from('{}'), predecessor), /PREDECESSOR_MANIFEST_INVALID/u);
});

test('one profile spans old rendered state, exact replacement and two new runtime launches', async () => {
  const f = fixture(); const receipt = await runWindowsFinalUpgradeContinuity(f.input, f.deps);
  assert.deepEqual(f.calls, ['verify:old', 'launch:seed', 'absence', 'optout', 'verify:old', 'snapshot',
    'replace', 'snapshot', 'verify:new', 'launch:retained', 'absence', 'optout', 'verify:new',
    'launch:retained', 'absence', 'optout', 'verify:new']);
  assert.equal(f.snapshots(), 2, 'byte equality stops before normal runtime migrations');
  assert.equal(receipt.profileUnchangedAcrossInstaller, true);
  assert.equal(receipt.syntheticHistoryRetainedAcrossUpgrade, true);
  assert.equal(receipt.settingsRetainedAcrossUpgrade, true);
  assert.equal(receipt.durableOptOutRetainedAcrossUpgrade, true);
  assert.equal(receipt.successorColdRestart, true);
  assert.equal(receipt.predecessorIdentity, oldIdentity);
  assert.equal(receipt.successorIdentity, newIdentity);
  assert.doesNotMatch(JSON.stringify(receipt), /C:|"pid"|"creation"|old-main|old-companion/u);
});

test('live predecessor descendants refuse replacement before the installer runs', async () => {
  const f = fixture({ processAbsence: async () => { throw new Error('still alive'); } });
  await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /still alive/u);
  assert.ok(!f.calls.includes('replace'));
});

test('lost settings, opt-out, history, projects, process proof or clean quit refuse replacement', async () => {
  for (const key of Object.keys(expectedJourney).filter(key => key !== 'localRefreshTerminal')) {
    const f = fixture(); const launch = f.deps.launchJourney;
    f.deps.launchJourney = async options => ({ ...await launch(options), [key]: false });
    await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /NORMAL_JOURNEY_UNPROVEN/u);
    assert.ok(!f.calls.includes('replace'), key);
  }
  const f = fixture(); const launch = f.deps.launchJourney;
  f.deps.launchJourney = async options => { const result = await launch(options); f.candidateState.tracked = null; return result; };
  await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /NORMAL_JOURNEY_UNPROVEN/u);
  assert.ok(!f.calls.includes('replace'));
});

test('installer mutation of retained profile refuses new application launch', async () => {
  const f = fixture(); let snapshots = 0;
  f.deps.snapshotProfile = async () => ({ sha256: (++snapshots).toString().repeat(64), entries: 9, bytes: 4000 });
  await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /PROFILE_CHANGED_BY_INSTALLER/u);
  assert.ok(f.calls.includes('replace'));
  assert.ok(!f.calls.includes('launch:retained'));
});

test('installer failure never advances to successor runtime', async () => {
  const f = fixture(); f.input.replaceInstaller = async () => { throw new Error('installer unsettled'); };
  await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /installer unsettled/u);
  assert.ok(!f.calls.includes('launch:retained'));
});

test('successor identity, semantic loss and changed runtime bytes fail closed', async () => {
  for (const mode of ['same-asar', 'wrong-source', 'lost-optout', 'lost-history', 'changed-native']) {
    const f = fixture(); const verify = f.deps.verifyPackage, launch = f.deps.launchJourney;
    let newChecks = 0;
    f.deps.verifyPackage = async options => {
      const value = await verify(options);
      if (options.sourceRevision !== newRevision) return value;
      newChecks += 1;
      if (mode === 'same-asar') return { ...value, artifactSha256: oldIdentity.artifactSha256 };
      if (mode === 'wrong-source') return { ...value, sourceRevision: oldRevision };
      if (mode === 'changed-native' && newChecks > 1) return { ...value, native: { ...value.native, keytarSha256: '2'.repeat(64) } };
      return value;
    };
    f.deps.launchJourney = async options => {
      const value = await launch(options);
      return options.changeSettings ? value : { ...value,
        ...(mode === 'lost-optout' ? { sharingOptOutRetained: false } : {}),
        ...(mode === 'lost-history' ? { syntheticIngestionVerified: false } : {}) };
    };
    await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /ELECTRON_WINDOWS_FINAL_UPGRADE_/u, mode);
  }
});

test('profile snapshot binds files/directories and rejects links without retaining names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'windows-upgrade-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'settings')); await writeFile(join(root, 'settings', 'synthetic.json'), '{}');
  const virtual = String.raw`C:\owned\profile`;
  const mapped = target => join(root, ...win32.relative(virtual, target).split('\\').filter(Boolean));
  const deps = { inspect: (path, options) => lstat(mapped(path), options),
    entries: (path, options) => import('node:fs/promises').then(fs => fs.readdir(mapped(path), options)),
    digestFile: async path => sha(await readFile(mapped(path))) };
  const first = await snapshotWindowsFinalUpgradeProfile(virtual, deps);
  assert.equal(first.entries, 2); assert.equal(first.bytes, 2);
  assert.doesNotMatch(JSON.stringify(first), /settings|synthetic/u);
  assert.deepEqual(await snapshotWindowsFinalUpgradeProfile(virtual, deps), first);
  await writeFile(join(root, 'settings', 'synthetic.json'), '{"changed":true}');
  assert.notEqual((await snapshotWindowsFinalUpgradeProfile(virtual, deps)).sha256, first.sha256);
  await symlink(join(root, 'settings'), join(root, 'alias'));
  await assert.rejects(snapshotWindowsFinalUpgradeProfile(virtual, deps), /PROFILE_UNSAFE/u);
});

test('native upgrade refuses non-disposable hosts before touching paths or launching', async () => {
  for (const host of [{ platform: 'darwin', architecture: 'arm64', environment: {} },
    { platform: 'win32', architecture: 'x64', environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } }]) {
    await assert.rejects(runWindowsFinalUpgrade({}, { ...host,
      runProgram: () => assert.fail('must not launch') }), /DISPOSABLE_WINDOWS_REQUIRED/u);
  }
});

test('failed package continuity cannot acquire positive signed-closure receipt claims', async () => {
  const source = await readFile(new URL('../scripts/smoke-electron-windows-final-upgrade.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('export async function runWindowsFinalUpgrade(options'));
  const continuity = run.indexOf('receipt.continuity = await runWindowsFinalUpgradeContinuity(');
  assert.ok(continuity > 0);
  for (const field of ['predecessorSignedClosureVerified', 'successorSignedClosureVerified']) {
    assert.match(run.slice(0, continuity), new RegExp(`${field}: false`, 'u'));
    assert.doesNotMatch(run.slice(0, continuity), new RegExp(`receipt\\.${field} = true`, 'u'));
    assert.ok(run.indexOf(`receipt.${field} = true`) > run.indexOf('    // Positive closure claims', continuity));
  }
});

test('frozen workflow preserves clean intake and adds explicit pinned immutable upgrade preparation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-windows-installer-diagnostic.yml', import.meta.url), 'utf8');
  const wrapper = await readFile(new URL('../scripts/qualify-electron-windows-frozen-installer.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /qualify_upgrade:\n[\s\S]*?required: false\n[\s\S]*?default: false/u);
  assert.match(workflow, /predecessor_intake:\n[\s\S]*?required: false\n[\s\S]*?default: ''/u);
  assert.match(workflow, /QUALIFY_INSTALLED: \$\{\{ inputs\.qualify_installed \}\}/u);
  assert.match(workflow, /QUALIFY_UPGRADE: \$\{\{ inputs\.qualify_upgrade \}\}/u);
  assert.match(workflow, /PREDECESSOR_INTAKE: \$\{\{ inputs\.predecessor_intake \}\}/u);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/u);
  assert.match(workflow, /run\.head_sha -cne \$env:SOURCE_REVISION/u);
  assert.match(workflow, /artifact\.workflow_run\.id -ne \[long\]\$env:SIGNING_RUN_ID/u);
  assert.doesNotMatch(workflow, /secrets\.|id-token: write|contents: write/u);
  assert.match(wrapper, /if \(predecessorIntake === null\) \{[\s\S]*?await runWindowsSignedInstalled\(/u);
  assert.match(wrapper, /program\('gh', \['release', 'verify', 'v0\.1\.26', '--repo', 'adamallcock\/tibotattle'\]/u);
  const admission = wrapper.indexOf('validateWindowsFinalUpgradePredecessorManifest(await');
  const installerDownload = wrapper.indexOf("'--pattern', WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE");
  const signature = wrapper.indexOf('await verifyWindowsSignedInstalledSignature(installer');
  const extraction = wrapper.indexOf("program(sevenZip, ['x'");
  assert.ok(admission >= 0 && admission < installerDownload);
  assert.ok(signature >= 0 && signature < extraction);
  assert.match(wrapper, /expectedVersion: predecessorIntake\.version/u);
  assert.match(wrapper, /referenceOrigin: 'extracted_from_exact_signed_installer'/u);
  assert.match(wrapper, /independentPreSigningStage: false/u);
  assert.match(workflow, /path: \|\n            \.release-build\/electron-production\/win32-x64\/evidence\//u);
  for (const role of ['candidate', 'predecessor']) {
    const retained = wrapper.indexOf(`const ${role}Comparison = await retainWindowsFrozenComparison({ sourceCandidatePath: ${role}.sourceCandidatePath,`);
    assert.ok(retained >= 0 && retained < wrapper.indexOf('const receipt = await runWindowsFinalUpgrade('));
    assert.match(wrapper, new RegExp(`assert\\.equal\\(receipt\\.${role === 'candidate' ? 'sourceCandidateSha256' : 'predecessorSourceCandidateSha256'}, ${role}Comparison\\.sha256\\)`, 'u'));
  }
  assert.doesNotMatch(wrapper, /--clobber|--publish|--sign\b|release.*create/u);
});


test('installed predecessor and successor ASAR/executable must match the exact extracted signed payload', async () => {
  for (const source of [oldRevision, newRevision]) {
    for (const key of ['artifactSha256', 'executableSha256']) {
      const f = fixture(); const verify = f.deps.verifyPackage;
      f.deps.verifyPackage = async options => ({ ...await verify(options),
        ...(options.sourceRevision === source ? { [key]: '9'.repeat(64) } : {}) });
      await assert.rejects(runWindowsFinalUpgradeContinuity(f.input, f.deps), /PACKAGE_IDENTITY_INVALID/u);
      assert.ok(!f.calls.includes(source === oldRevision ? 'launch:seed' : 'launch:retained'));
    }
  }
});
