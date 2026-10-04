import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { validateMacCredentialIntake, parseMacCredentialArguments, runMacCredentialQualification,
  MAC_CREDENTIAL_CONFIRMATION, credentialFixtureArchiveInspectionScript, validateCredentialSnapshot,
  expectedCredentialReason, macCredentialDialogScript, macCredentialPredecessorUiScript,
  exerciseCredentialRefresh, macCredentialFailureDiagnostics, classifyPredecessorProcessEvidence,
  validateCredentialFixtureReply, validateCredentialScope, MAC_CREDENTIAL_FIXTURE_FAILURE_CODES } from '../scripts/smoke-electron-macos-credentials.mjs';
import { CREDENTIAL_FIXTURE_CASES, credentialFixtureRoot, credentialFixtureConfiguration,
  parseCredentialFixtureArguments, compileCredentialFixture } from '../scripts/prepare-electron-macos-credential-fixture.mjs';
import { MACOS_LOOPBACK_POLICY, MACOS_LOOPBACK_MODE, macOSLoopbackLaunch,
  macOSLoopbackProbeSource, inspectMacOSLoopbackEnforcement } from '../scripts/lib/macos-loopback-qualification.mjs';
import { MACOS_PF_CREDENTIAL_MODE, macOSCredentialPfRule, macOSPfRuleInstalled,
  parseMacOSPfEnableToken } from '../scripts/lib/macos-pf-credential-qualification.mjs';
import { fixedEntryFailureObserver, launchVerifiedMacSharingApp } from '../scripts/run-signed-electron-staging.mjs';
import { MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA, MAC_CREDENTIAL_SUCCESSOR_026_SCHEMA,
  preflightMacCredentialEnvironment } from '../scripts/lib/macos-credential-qualification-intake.mjs';
import { validateEmptyProfileIntake } from '../scripts/smoke-electron-macos-empty-profile.mjs';
import { desktopFirstRunDialogCopy } from '../apps/electron/desktop-first-run.js';

const operationId = '4a5361b7-dc54-49cc-92c5-a3e7d42b9a6f';
const intake = { schemaVersion: 'signed-macos-credential-qualification-v1', runnerRevision: 'e'.repeat(40),
  sourceRevision: 'a'.repeat(40), target: 'darwin-arm64', version: '0.1.23', bundleVersion: '1030',
  buildNumber: '2026091401', dmgSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64), operationId,
  fixtureArchiveSha256: 'd'.repeat(64), fixtureExecutableSha256: 'f'.repeat(64), predecessorAsarSha256: '1'.repeat(64) };

test('credential intake binds a separate reviewed runner, exact app, signed fixture, nonce and fixed transports', () => {
  const input = validateMacCredentialIntake(intake);
  assert.equal(input.candidate.sourceRevision, intake.sourceRevision);
  assert.notEqual(input.runnerRevision, input.sourceRevision);
  assert.deepEqual(input.candidate, validateEmptyProfileIntake(Object.fromEntries(
    ['runnerRevision', 'target', 'sourceRevision', 'version', 'bundleVersion', 'buildNumber', 'dmgSha256', 'asarSha256'].map(k => [k, intake[k]]))));
  assert.equal(input.fixtureRoot, credentialFixtureRoot(operationId));
  assert.equal(input.fixtureUrl, `https://updates.tibotattle.com/electron/test/mac-credentials/${intake.runnerRevision}/${operationId}/${intake.fixtureArchiveSha256}/fixture.zip`);
  assert.equal(input.predecessorUrl, 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/TiboTattle-0.1.20-mac-arm64.dmg');
  for (const key of Object.keys(intake)) {
    const missing = { ...intake }; delete missing[key];
    assert.throws(() => validateMacCredentialIntake(missing));
  }
  for (const change of [{ target: 'darwin-x64' }, { fixtureUrl: 'https://elsewhere.example/' }, { root: '/Users/runner' },
    { operationId: '../escape' }, { operationId: operationId.toUpperCase() }, { schemaVersion: 'v2' }, { version: '0.1.22' }]) {
    assert.throws(() => validateMacCredentialIntake({ ...intake, ...change }));
  }
  for (const field of ['fixtureArchiveSha256', 'fixtureExecutableSha256', 'predecessorAsarSha256']) {
    for (const value of [[], ['a'.repeat(64)], null, 'a'.repeat(63), 'A'.repeat(64), {}]) {
      assert.throws(() => validateMacCredentialIntake({ ...intake, [field]: value }));
    }
  }
});

test('current-stable credential journey pins both public 0.1.24 and unchanged signed 0.1.25 bytes', () => {
  const selected = { ...intake, schemaVersion: MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA,
    sourceRevision: 'fec5b6039ea9efbc7948f0785bb40240cd0748ea',
    version: '0.1.25', bundleVersion: '1033', buildNumber: '2026092601',
    dmgSha256: '6b09cbc3e97864d67ed6f7b24c99b5847c1cb91c525e5a22de73164263ec72b2',
    asarSha256: '654a351a5ba08eb749b5b53fc98bdafc4123b2fe2485385400dccfe2c561bdc5',
    predecessorAsarSha256: 'c061f3af2b54ffacedc9a4c0a3561d82cd25873fac0c11eecb6cd46f6f704833' };
  const result = validateMacCredentialIntake(selected);
  assert.equal(result.predecessorUrl,
    'https://github.com/adamallcock/tibotattle/releases/download/v0.1.24/TiboTattle-0.1.24-mac-arm64.dmg');
  assert.deepEqual(result.predecessor, {
    version: '0.1.24', sourceRevision: 'b6fe68e4912bebbe6dcf7dc9fd43e877451dd133',
    buildNumber: '2026092202', bundleVersion: '1032',
    dmgSha256: 'f77f4e466c3be68209205a01866bbaf66650012cb40d2233d4fde53b9e767969',
    asarSha256: selected.predecessorAsarSha256 });
  for (const change of [{ predecessorAsarSha256: 'a'.repeat(64) }, { dmgSha256: 'b'.repeat(64) },
    { sourceRevision: 'a'.repeat(40) }, { version: '0.1.26' }, { buildNumber: '2026092602' }])
    assert.throws(() => validateMacCredentialIntake({ ...selected, ...change }));
});

test('0.1.26 current-stable journey pins the published predecessor and exact signed successor bytes', () => {
  const selected = { ...intake, schemaVersion: MAC_CREDENTIAL_SUCCESSOR_026_SCHEMA,
    sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
    version: '0.1.26', bundleVersion: '1034', buildNumber: '2026092701',
    dmgSha256: '7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec',
    asarSha256: '6d02d1acffbc4feaf8e91162a2fe67663815bdbd92ae431abef20fdbf2ffc81e',
    predecessorAsarSha256: 'c061f3af2b54ffacedc9a4c0a3561d82cd25873fac0c11eecb6cd46f6f704833' };
  const result = validateMacCredentialIntake(selected);
  assert.equal(result.predecessor.version, '0.1.24');
  assert.equal(result.candidate.url,
    `https://updates.tibotattle.com/electron/test/native-sparkle/${selected.sourceRevision}/1034/${selected.dmgSha256}/TiboTattle-0.1.26-mac-arm64.dmg`);
  for (const change of [{ predecessorAsarSha256: 'a'.repeat(64) }, { dmgSha256: 'b'.repeat(64) },
    { asarSha256: 'c'.repeat(64) }, { sourceRevision: 'a'.repeat(40) },
    { version: '0.1.25' }, { bundleVersion: '1033' }, { buildNumber: '2026092702' }])
    assert.throws(() => validateMacCredentialIntake({ ...selected, ...change }));
  assert.throws(() => validateMacCredentialIntake({ ...selected, schemaVersion: MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA }));
});

test('early admission checks source receipt, source ancestry, exact package and mode in a clean synthetic repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'credential-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }).trim();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', version: '0.1.23', type: 'module' }));
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic candidate']);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'runner.txt'), 'Synthetic runner'); git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic qualification']);
  const runnerRevision = git(['rev-parse', 'HEAD']), identity = { ...intake, sourceRevision, runnerRevision };
  const sourceCandidate = { schemaVersion: 'tibotattle-electron-production-source-candidate-v1', status: 'production_source_staged',
    version: identity.version, buildNumber: identity.buildNumber, sourceRevision, target: identity.target,
    updateFeed: 'https://updates.tibotattle.com/electron/stable/darwin-arm64',
    builderEnvironment: { TIBOTATTLE_ELECTRON_BUILD_NUMBER: identity.buildNumber,
      TIBOTATTLE_ELECTRON_SOURCE_REVISION: sourceRevision, TIBOTATTLE_ELECTRON_TARGET: identity.target,
      TIBOTATTLE_ELECTRON_VERSION: identity.version } };
  const env = value => ({ MAC_CREDENTIAL_INTAKE: JSON.stringify(value), GITHUB_SHA: runnerRevision, SELECTED_MODE: 'plan', SELECTED_CONFIRMATION: '' });
  const admit = environment => preflightMacCredentialEnvironment(environment, { repositoryRoot: root });
  assert.deepEqual(admit(env({ ...identity, sourceCandidate })), identity);
  for (const change of [{ sourceCandidate: null }, { sourceCandidate: { ...sourceCandidate, sourceRevision: 'f'.repeat(40) } },
    { sourceCandidate: { ...sourceCandidate, status: 'planned' } }, { runnerRevision: sourceRevision }, { target: 'darwin-x64' },
    { buildNumber: '2026091402' }]) assert.throws(() => admit(env({ ...identity, sourceCandidate, ...change })));
  assert.throws(() => admit({ ...env({ ...identity, sourceCandidate }), SELECTED_MODE: 'execute' }));
  assert.throws(() => admit({ ...env({ ...identity, sourceCandidate }), SELECTED_CONFIRMATION: MAC_CREDENTIAL_CONFIRMATION }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-usagemonitor', version: '0.1.22', type: 'module' }));
  assert.throws(() => admit(env({ ...identity, sourceCandidate })));
});

test('plan and compilation plan remain inert and every physical qualification starts false', async () => {
  const plan = await runMacCredentialQualification({ intake });
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.cases, []);
  for (const [key, value] of Object.entries(plan)) if (typeof value === 'boolean') assert.equal(value, false, key);
  assert.equal((await compileCredentialFixture({ execute: false })).keychainAccessPerformed, false);
  assert.deepEqual(parseMacCredentialArguments(['--plan']), { execute: false });
  assert.deepEqual(parseMacCredentialArguments(['--execute', '--confirm', MAC_CREDENTIAL_CONFIRMATION]), { execute: true });
  for (const args of [[], ['--execute'], ['--plan', '--execute'], ['--execute', '--confirm', 'yes']]) {
    assert.throws(() => parseMacCredentialArguments(args));
  }
});

test('0.1.27 credential planning cannot claim historical Sol repair or native execution', async () => {
  const successor = { ...intake, version: '0.1.27', bundleVersion: '1035', buildNumber: '2026100301' };
  const plan = await runMacCredentialQualification({ intake: successor });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.historicalSolUpgrade, null);
  assert.deepEqual(plan.cases, []);
  for (const [key, value] of Object.entries(plan)) if (typeof value === 'boolean') assert.equal(value, false, key);
});

test('historical repair stays between predecessor attestation and modern-case completion', async () => {
  const source = await readFile(new URL('../scripts/smoke-electron-macos-credentials.mjs', import.meta.url), 'utf8');
  const modernStart = source.indexOf("stage = 'modern_fixture'");
  const refusedStart = source.indexOf("for (const scenario of CREDENTIAL_FIXTURE_CASES.filter");
  assert.ok(modernStart >= 0 && refusedStart > modernStart);
  const modern = source.slice(modernStart, refusedStart);
  const seed = modern.indexOf('await prepareHistoricalSolFixture(');
  const predecessorStop = modern.lastIndexOf('await stopOwnedMacSharingApp(active); active = null;', seed);
  const audit = modern.indexOf('proof.predecessorCredentialAudit.afterStop');
  const attest = modern.indexOf("await fixture.request('attest');", audit);
  const replacement = modern.indexOf("stage = 'installed_replacement'");
  assert.ok(predecessorStop >= 0 && audit > predecessorStop && attest > audit
    && seed > attest && replacement > seed, 'synthetic seed follows stopped/audited predecessor, before replacement');
  assert.match(modern.slice(attest, seed), /if \(input\.version === '0\.1\.27'\)/u);
  const startupProof = modern.indexOf('await observeHistoricalSolPass(');
  const manualRefresh = modern.indexOf('await exerciseCredentialRefresh(active.dashboard)');
  const repeatProof = modern.indexOf('await observeHistoricalSolPass(', startupProof + 1);
  const receipt = modern.indexOf('proof.historicalSolUpgrade = historicalSolQualificationReceipt(');
  const credentialCheck = modern.lastIndexOf("fail('credential_changed')");
  assert.ok(startupProof > replacement && manualRefresh > startupProof
    && repeatProof > manualRefresh && credentialCheck > repeatProof && receipt > credentialCheck,
    'capture startup repair before repeat, and publish proof only after credential-preserving restarts');
  assert.match(modern, /for \(let pass = 0; pass < 3; pass\+\+\)/u);
  assert.match(modern, /phase: pass === 0 \? 'repair' : 'restart'/u);
  const refused = source.slice(refusedStart);
  assert.doesNotMatch(refused, /prepareHistoricalSolFixture\(|observeHistoricalSolPass\(/u);
  assert.match(refused, /expectedCredentialReason|observeRefusal/u);
});

test('execute refuses a non-hosted account before downloads, profiles, installation or Keychain operations', async () => {
  for (const selected of [intake, { ...intake, version: '0.1.27', bundleVersion: '1035', buildNumber: '2026100301' }]) {
    const script = `import {runMacCredentialQualification} from './scripts/smoke-electron-macos-credentials.mjs';
globalThis.fetch=()=>{throw new Error('unexpected network')};
process.stdout.write(JSON.stringify(await runMacCredentialQualification({execute:true,intake:${JSON.stringify(selected)}})));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd: new URL('..', import.meta.url), env: { PATH: '/usr/bin:/bin', GITHUB_ACTIONS: 'false' }, encoding: 'utf8' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.failureStage, 'disposable_host');
    assert.equal(result.credentialContinuityQualified, false);
    assert.equal(result.historicalSolUpgrade, null);
  }
});

test('fixture configuration contains only compiled fixed hosted roots and reviewed cases', () => {
  const source = credentialFixtureConfiguration(operationId);
  assert.match(source, /\/Users\/runner\/Library\/Caches\/tibotattle-credential-qualification-/u);
  assert.ok(source.includes('com.usagemonitor.local'));
  assert.deepEqual(CREDENTIAL_FIXTURE_CASES, ['modern', 'invalid', 'locked']);
  assert.match(source, /"modern","invalid","locked"/u);
  assert.deepEqual(parseCredentialFixtureArguments(['--plan']), { execute: false });
  assert.deepEqual(parseCredentialFixtureArguments(['--compile-only', '--operation-id', operationId, '--output', '/private/fixture']),
    { execute: true, operationId, output: '/private/fixture' });
  for (const args of [[], ['--sign'], ['--compile-only', '--operation-id', operationId, '--output', 'relative'],
    ['--compile-only', '--operation-id', '../bad', '--output', '/private/fixture']]) assert.throws(() => parseCredentialFixtureArguments(args));
});

test('fixture archive inspection rejects traversal, symlinks, duplicated and unexpected entries before extraction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'credential-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const create = `import zipfile,sys,stat
names=['CredentialFixture.app/Contents/Info.plist','CredentialFixture.app/Contents/MacOS/CredentialFixture','CredentialFixture.app/Contents/_CodeSignature/CodeResources']
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name in names: z.writestr(name,b'synthetic')
 if sys.argv[2]=='extra': z.writestr('CredentialFixture.app/Contents/private.txt',b'synthetic')
 if sys.argv[2]=='traversal': z.writestr('CredentialFixture.app/../../outside',b'synthetic')
 if sys.argv[2]=='duplicate': z.writestr(names[0],b'synthetic')
 if sys.argv[2]=='link':
  entry=zipfile.ZipInfo('CredentialFixture.app/link');entry.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(entry,b'/etc/passwd')`;
  for (const scenario of ['valid', 'extra', 'traversal', 'duplicate', 'link']) {
    const archive = join(directory, scenario + '.zip');
    execFileSync('/usr/bin/python3', ['-c', create, archive, scenario], { stdio: 'ignore' });
    const inspect = () => execFileSync('/usr/bin/python3', ['-c', credentialFixtureArchiveInspectionScript(), archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (scenario === 'valid') assert.equal(inspect().trim(), 'verified'); else assert.throws(inspect);
  }
});

const snapshot = () => ({ ok: true, items: ['account-observation', 'contribution-device', 'accountless-installation'].map(capability =>
  ({ capability, readable: true, itemDigest: 'a'.repeat(64), aclDigest: 'b'.repeat(64), valueDigest: 'c'.repeat(64) })) });
test('helper failures retain only a known fixed code, closed scenario and actual protocol command', () => {
  for (const operation of [null, 'seed', 'snapshot', 'audit', 'begin', 'attest', 'select', 'scope', 'lock', 'unlock', 'restore', 'cleanup']) {
    for (const code of MAC_CREDENTIAL_FIXTURE_FAILURE_CODES) {
      assert.throws(() => validateCredentialFixtureReply({ ok: false, code }, { scenario: 'modern', operation }), error => {
        assert.equal(error.credentialStage, 'fixture_operation');
        assert.deepEqual(error.fixtureFailure, { scenario: 'modern', command: operation ?? 'startup', code });
        assert.equal(error.message, 'MAC_CREDENTIAL_QUALIFICATION_REFUSED');
        assert.equal(Object.isFrozen(error.fixtureFailure), true);
        return true;
      });
    }
  }
  for (const value of [{ ok: false, code: 'PRIVATE_SENTINEL' }, { ok: false, code: 'FIXTURE_CREATE_FAILED', detail: 'PRIVATE_SENTINEL' },
    { ok: false, code: ['FIXTURE_CREATE_FAILED'] }, { ok: false }, { ok: true, operation: 'select' },
    { ok: true, operation: 'seed', value: 'PRIVATE_SENTINEL' }, null, [], 'PRIVATE_SENTINEL']) {
    assert.throws(() => validateCredentialFixtureReply(value, { scenario: 'modern', operation: 'seed' }), error => {
      assert.equal(error.fixtureFailure, undefined);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_SENTINEL/u);
      return true;
    });
  }
  assert.throws(() => validateCredentialFixtureReply({ ok: false, code: 'FIXTURE_CREATE_FAILED' }, { scenario: 'private', operation: 'seed' }));
  assert.throws(() => validateCredentialFixtureReply({ ok: false, code: 'FIXTURE_CREATE_FAILED' }, { scenario: 'modern', operation: 'arbitrary' }));
  assert.deepEqual(validateCredentialFixtureReply({ ok: true, ready: true }, { scenario: 'modern', operation: null }), { ok: true, ready: true });
  assert.deepEqual(validateCredentialFixtureReply({ ok: true, operation: 'seed' }, { scenario: 'modern', operation: 'seed' }), { ok: true, operation: 'seed' });
  assert.deepEqual(validateCredentialFixtureReply(snapshot(), { scenario: 'modern', operation: 'snapshot' }), snapshot());
  const audit = { ok: true, audit: { pinUnchanged: false, valuesMatch: true, itemsMatch: true, aclsMatch: true } };
  assert.deepEqual(validateCredentialFixtureReply(audit, { scenario: 'modern', operation: 'audit' }), audit);
  for (const bad of [{ ...audit, privatePath: '/private' }, { ok: true, audit: { ...audit.audit, value: 'PRIVATE_SENTINEL' } },
    { ok: true, audit: { ...audit.audit, itemsMatch: 'true' } }, { ok: true, audit: null }]) {
    assert.throws(() => validateCredentialFixtureReply(bad, { scenario: 'modern', operation: 'audit' }));
  }
});
test('scope proof admits only a fixture-only user/default with empty dynamic and verified fixed common scope', () => {
  const proof = commonDomain => ({ schemaVersion: 'mac-credential-isolated-scope-v1',
    userDomainFixtureOnly: true, defaultFixture: true, dynamicDomainEmpty: true,
    aggregateMatchesDomains: true, commonDomain, systemNamespacesAbsent: commonDomain === 'empty' ? 0 : 10 });
  for (const commonDomain of ['empty', 'verified_system']) {
    const scope = proof(commonDomain);
    assert.deepEqual(validateCredentialScope(scope), scope);
    for (const operation of ['select', 'scope']) {
      const value = { ok: true, operation, scope };
      assert.deepEqual(validateCredentialFixtureReply(value, { scenario: 'modern', operation }), value);
      assert.throws(() => validateCredentialFixtureReply({ ok: true, operation }, { scenario: 'modern', operation }));
    }
    for (const field of Object.keys(scope)) {
      const missing = { ...scope }; delete missing[field];
      assert.throws(() => validateCredentialScope(missing));
      if (typeof scope[field] === 'boolean') for (const replacement of [false, 1, 'true', null]) {
        assert.throws(() => validateCredentialScope({ ...scope, [field]: replacement }));
      }
    }
    for (const changed of [{ commonDomain: 'login' }, { commonDomain: ['verified_system'] },
      { systemNamespacesAbsent: commonDomain === 'empty' ? 10 : 0 }, { systemNamespacesAbsent: 9 },
      { systemNamespacesAbsent: '10' }, { schemaVersion: 'unverified' }, { path: 'PRIVATE_SENTINEL' },
      { attributes: { private: 'PRIVATE_SENTINEL' } }]) {
      assert.throws(() => validateCredentialScope({ ...scope, ...changed }), error => {
        assert.equal(error.credentialStage, 'fixture_scope');
        assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_SENTINEL/u);
        return true;
      });
    }
  }
});

test('System exception covers every native capability and requests status only from its fixed reference', async () => {
  const fixture = await readFile(new URL('./fixtures/macos-keychain-migration/ElectronCredentialMain.swift', import.meta.url), 'utf8');
  const native = await readFile(new URL('../native/macos-keychain/macos-keychain.mm', import.meta.url), 'utf8');
  const nativeCapabilities = /constexpr std::array<CapabilitySpec, \d+> kCapabilities = \{\{([\s\S]+?)\}\};/u.exec(native)?.[1];
  assert.ok(nativeCapabilities);
  const services = value => [...value.matchAll(/"(app-usagemonitor\.[a-z-]+(?:\.app)?\.v1)"/gu)].map(match => match[1]);
  const fixtureServices = /static let systemServices = \[([\s\S]+?)\]/u.exec(fixture)?.[1];
  assert.ok(fixtureServices);
  assert.equal(services(fixtureServices).length, 10);
  assert.deepEqual(services(fixtureServices), services(nativeCapabilities));
  assert.match(native, /kAccount\[\] = "installation"/u);
  const support = await readFile(new URL('./fixtures/macos-keychain-migration/FixtureSupport.swift', import.meta.url), 'utf8');
  assert.match(support, /static let account = "installation"/u);
  const commonCheck = fixture.slice(fixture.indexOf('static func assertCommon('), fixture.indexOf('static func assertScope('));
  assert.match(commonCheck, /kSecMatchSearchList as String: \[system\]/u);
  assert.match(commonCheck, /kSecAttrAccount as String: F.account/u);
  assert.match(commonCheck, /SecItemCopyMatching\(query as CFDictionary, nil\) == errSecItemNotFound/u);
  assert.match(commonCheck, /SecKeychainGetStatus\(system, &status\) == errSecSuccess/u);
  assert.match(commonCheck, /status & kSecReadPermStatus/u);
  assert.doesNotMatch(commonCheck, /kSecReturn|SecKeychainUnlock|SecItemAdd|SecItemUpdate|SecItemDelete/u);
  assert.equal([...fixture.matchAll(/SecKeychainSetDomain(?:SearchList|Default)\(\.user,/gu)].length, 4);
  assert.doesNotMatch(fixture, /SecKeychainSet(?:SearchList|Default|PreferenceDomain)\(/u);
  assert.match(fixture, /SecKeychainCopyDomainDefault\(\.user, &userDefault\)/u);
  assert.match(fixture, /preference == \.user/u);
  assert.match(fixture, /CFEqual\(ordinaryDefault, userDefault\)/u);
  assert.match(fixture, /\(dynamic \+ user \+ common\) as CFArray/u);
});

test('the fixed failure-code allowlist stays aligned with current reviewed helper sources', async () => {
  const sources = await Promise.all(['FixtureSupport.swift', 'ElectronCredentialMain.swift'].map(name =>
    readFile(new URL('./fixtures/macos-keychain-migration/' + name, import.meta.url), 'utf8')));
  const environmentNames = new Set(['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'ARM64']);
  const codes = new Set(sources.flatMap(source => [...source.matchAll(/"([A-Z][A-Z0-9_]{3,})"/gu)].map(match => match[1])));
  for (const value of environmentNames) codes.delete(value);
  assert.deepEqual([...MAC_CREDENTIAL_FIXTURE_FAILURE_CODES].sort(), [...codes].sort());
});
test('snapshot is closed, ordered and requires real readable bytes and complete value/item/ACL evidence', () => {
  for (const scenario of CREDENTIAL_FIXTURE_CASES) assert.equal(validateCredentialSnapshot(snapshot(), scenario).length, 3);
  for (const change of [{ readable: false }, { valueDigest: null }, { valueDigest: ['a'.repeat(64)] },
    { capability: 'export-identity' }, { path: '/private' }, { aclDigest: '' }]) {
    const value = snapshot(); Object.assign(value.items[0], change);
    assert.throws(() => validateCredentialSnapshot(value, 'modern'));
  }
  assert.throws(() => validateCredentialSnapshot({ ...snapshot(), extra: true }, 'modern'));
  assert.throws(() => validateCredentialSnapshot({ ok: true, items: snapshot().items.reverse() }, 'modern'));
  assert.throws(() => validateCredentialSnapshot(snapshot(), 'unknown'));
});

test('fixed network launch cannot accept a policy, environment or command override', async () => {
  assert.deepEqual(macOSLoopbackLaunch('/usr/bin/true', ['literal'], MACOS_LOOPBACK_MODE),
    { executable: '/usr/bin/sandbox-exec', args: ['-p', MACOS_LOOPBACK_POLICY, '/usr/bin/true', 'literal'] });
  for (const mode of [null, 'allow-all', '(allow default)', {}]) assert.throws(() => macOSLoopbackLaunch('/usr/bin/true', [], mode));
  assert.throws(() => macOSLoopbackLaunch('relative', [], MACOS_LOOPBACK_MODE));
  for (const port of [0, 65536, '123', 1.5]) assert.throws(() => macOSLoopbackProbeSource(port));
  await assert.rejects(launchVerifiedMacSharingApp({}, {}, { networkMode: 'allow-all' }));
  await assert.rejects(launchVerifiedMacSharingApp({}, {}, { networkMode: MACOS_LOOPBACK_MODE, launchServices: true }));
  await assert.rejects(launchVerifiedMacSharingApp({}, {}, { observeBeforeDashboard: () => null }));
  await assert.rejects(launchVerifiedMacSharingApp({}, {}, { observeFixedEntryFailure: true }));
});

test('temporary PF guard is runner-UID scoped and requires both installed transport rules', () => {
  assert.equal(MACOS_PF_CREDENTIAL_MODE, 'credential-qualification-pf-uid-v1');
  assert.equal(macOSCredentialPfRule(501),
    'block drop out quick on ! lo0 proto { tcp, udp } all user 501\n');
  for (const uid of [0, -1, 65536, '501']) assert.throws(() => macOSCredentialPfRule(uid));
  assert.equal(parseMacOSPfEnableToken('PF enabled\nToken : 12345\n'), '12345');
  for (const value of ['PF enabled', 'Token : 0\n', 'Token : /private/SECRET\n'])
    assert.throws(() => parseMacOSPfEnableToken(value));
  const installed = 'block drop out quick on ! lo0 proto tcp from any to any user = 501\n'
    + 'block drop out quick on ! lo0 proto udp from any to any user = 501\n';
  assert.equal(macOSPfRuleInstalled(installed, 501), true);
  assert.equal(macOSPfRuleInstalled(installed, 502), false);
  assert.equal(macOSPfRuleInstalled(installed.replace('proto udp', 'proto tcp'), 501), false);
  assert.equal(macOSPfRuleInstalled(installed + 'pass out quick all\n', 501), false);
});

const networkProof = { loopback: true, ipv4Denied: true, ipv6Denied: true, udp4Denied: true, udp6Denied: true, descendantDenied: true };
function probeSpawn(proof, { loopback = true, code = 0, malformed = false } = {}) {
  return (file, args) => {
    assert.equal(file, '/usr/bin/sandbox-exec'); assert.equal(args[1], MACOS_LOOPBACK_POLICY);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', 1);
    const finish = () => { child.stdout.write(malformed ? '{' : JSON.stringify(proof)); child.emit('close', code); };
    setImmediate(() => {
      if (!loopback) return finish();
      const match = /tcp\('127\.0\.0\.1',(\d+)\)/u.exec(args.at(-1));
      const socket = connect({ host: '127.0.0.1', port: +match[1] });
      socket.on('end', () => { socket.destroy(); finish(); });
    });
    return child;
  };
}
test('network probe requires observed loopback plus every closed denial result; fake success alone fails', async () => {
  assert.deepEqual(await inspectMacOSLoopbackEnforcement({ spawnImpl: probeSpawn(networkProof) }), networkProof);
  for (const [proof, options] of [[networkProof, { loopback: false }], [networkProof, { code: 1 }],
    [networkProof, { malformed: true }], [{ ...networkProof, descendantDenied: false }, {}], [{ ...networkProof, extra: true }, {}]]) {
    await assert.rejects(inspectMacOSLoopbackEnforcement({ spawnImpl: probeSpawn(proof, options) }), /MACOS_LOOPBACK_PROBE_FAILED/u);
  }
});

test('actual native dialog observer scopes actions to the verified PID and never approves OS security prompts', () => {
  const clicked = [];
  const text = { role: () => 'AXStaticText', value: () => 'Support code: SECURE_STORAGE_CREDENTIAL_INVALID', uiElements: () => [] };
  const button = name => ({ role: () => 'AXButton', name: () => name, enabled: () => true, click: () => clicked.push(name), uiElements: () => [] });
  const root = { role: () => 'AXWindow', uiElements: () => [text, button('Quit'), button('Retry')] };
  let securityPrompt = false;
  const processes = () => securityPrompt ? [{ name: () => 'SecurityAgent', windows: () => [{}] }] : [];
  processes.whose = query => { assert.deepEqual({ ...query }, { unixId: 123 }); return () => [{ windows: () => [root] }]; };
  const context = { Application: name => { assert.equal(name, 'System Events'); return { uiElementsEnabled: () => true, applicationProcesses: processes }; } };
  const run = action => vm.runInNewContext(macCredentialDialogScript(123, action) + ';run()', context);
  assert.equal(run('inspect'), 'SECURE_STORAGE_CREDENTIAL_INVALID');
  assert.equal(run('retry'), 'clicked'); assert.equal(run('quit'), 'clicked');
  assert.deepEqual(clicked, ['Retry', 'Quit']);
  securityPrompt = true; assert.equal(run('retry'), 'unexpected_security_ui'); assert.equal(clicked.length, 2);
  assert.throws(() => macCredentialDialogScript(123, 'Always Allow'));
  assert.throws(() => macCredentialDialogScript('123;injection'));
  assert.equal(expectedCredentialReason('invalid', 'SECURE_STORAGE_DENIED'), false);
  assert.equal(expectedCredentialReason('invalid', 'SECURE_STORAGE_CREDENTIAL_INVALID'), true);
  assert.equal(expectedCredentialReason('locked', 'SECURE_STORAGE_LOCKED'), true);
});

test('predecessor UI diagnosis returns only bounded states from the verified PID', () => {
  const firstRun = desktopFirstRunDialogCopy({ production: true, locale: 'en-US' });
  let elements = [], securityPrompt = false, owned = true, accessible = true;
  const windows = () => [{ entireContents: () => elements }];
  const processes = () => securityPrompt ? [{ name: () => 'SecurityAgent', windows }] : [];
  processes.whose = query => {
    assert.deepEqual({ ...query }, { unixId: 123 });
    return () => owned ? [{ windows }] : [];
  };
  const context = { Application: name => {
    assert.equal(name, 'System Events');
    return { uiElementsEnabled: () => accessible, applicationProcesses: processes };
  } };
  const observe = () => vm.runInNewContext(macCredentialPredecessorUiScript(123) + ';run()', context);
  const text = value => ({ role: () => 'AXStaticText', value: () => value });
  elements = [text(firstRun.message)]; assert.equal(observe(), 'first_run_visible');
  elements = [text('Unable to prepare secure storage')]; assert.equal(observe(), 'secure_storage_warning');
  elements = [text('Unable to finish updating TiboTattle')]; assert.equal(observe(), 'native_handover_warning');
  elements = [text('/Users/PRIVATE_SENTINEL')]; assert.equal(observe(), 'other_owned_window');
  owned = false; assert.equal(observe(), 'owned_process_absent'); owned = true;
  securityPrompt = true; assert.equal(observe(), 'security_agent_window'); securityPrompt = false;
  accessible = false; assert.equal(observe(), 'accessibility_unavailable');
  assert.throws(() => macCredentialPredecessorUiScript('123;injection'));
});

test('predecessor stderr diagnostic recognizes only its fixed token across chunks', () => {
  const observer = fixedEntryFailureObserver();
  observer.consume(Buffer.from('/Users/PRIVATE_SENTINEL\nelectron_shell_entry_'));
  assert.equal(observer.observed(), false);
  observer.consume(Buffer.from('failed\nSECRET'));
  assert.equal(observer.observed(), true);
  const unrelated = fixedEntryFailureObserver();
  unrelated.consume(Buffer.from('/Users/PRIVATE_SENTINEL\nSECRET\n'));
  assert.equal(unrelated.observed(), false);
});

test('predecessor process diagnosis discards raw stack and log text', () => {
  const classified = classifyPredecessorProcessEvidence({
    sampleStatus: 0, sample: 'SecItemCopyMatching NSApplication /Users/PRIVATE_SENTINEL',
    logStatus: 0, log: 'Sandbox: deny file-read /Users/PRIVATE_SENTINEL',
    ps: 'S+\n',
  });
  assert.deepEqual(classified, {
    processState: 'S', sampleStatus: 'available',
    sampleSignals: { keychain: true, appkit: true, network: false, filesystem: false },
    logStatus: 'available',
    logSignals: { sandboxDenial: true, tccDenial: false, codeSignRejection: false },
  });
  assert.doesNotMatch(JSON.stringify(classified), /PRIVATE_SENTINEL/u);
  assert.equal(classifyPredecessorProcessEvidence({ sampleStatus: 'timeout', logStatus: null }).sampleSignals, null);
  assert.equal(macCredentialFailureDiagnostics({}, null, null, null, { raw: '/Users/PRIVATE_SENTINEL' })
    .predecessorProcess, null);
  assert.deepEqual(macCredentialFailureDiagnostics({}, null, null, null, classified).predecessorProcess, classified);
});

test('refresh requires a new successful refresh ID and clicks once; stale success and failure cannot pass', async () => {
  for (const scenario of ['success', 'old-success', 'failed', 'unready']) {
    let time = 0, clicks = 0;
    const button = { disabled: scenario === 'unready', click() { clicks++; } };
    const document = { querySelector: () => button };
    const fetch = async () => ({ ok: true, json: async () => ({ refresh: { refreshId: clicks && scenario !== 'old-success' ? 'new' : 'old',
      status: clicks && scenario === 'failed' ? 'failed' : 'succeeded' } }) });
    const dashboard = { evaluate: expression => vm.runInNewContext(expression, { document, fetch }) };
    const execute = () => exerciseCredentialRefresh(dashboard, { now: () => time, wait: async ms => { time += ms; } });
    if (scenario === 'success') assert.equal(await execute(), true); else await assert.rejects(execute());
    assert.equal(clicks, scenario === 'unready' ? 0 : 1);
    assert.ok(time <= 60000);
  }
});

test('manual hosted workflow has no production upload, secret provisioning or arbitrary shell input expansion', async () => {
  const source = await readFile(new URL('../.github/workflows/electron-macos-credentials.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/u); assert.match(source, /runs-on: macos-26/u);
  assert.match(source, /node-version: 26\.2\.0/u); assert.match(source, /contents: read/u);
  assert.match(source, /persist-credentials: false/u); assert.match(source, /cancel-in-progress: false/u);
  assert.match(source, /fetch-depth: 0/u);
  assert.ok(source.indexOf('preflightMacCredentialEnvironment();') < source.indexOf('pnpm install --frozen-lockfile'));
  assert.match(source, /steps\.qualification\.outputs\.identity/u);
  assert.doesNotMatch(source, /secrets\.|id-token:|contents: write|pull_request_target|r2 |wrangler|security add/u);
  assert.match(source, /path: credential-receipts\/\*\.json/u);
});


test('credential failure diagnostics preserve fixed launch/settings stages and cleanup without raw errors', () => {
  assert.deepEqual(macCredentialFailureDiagnostics({ signedLaunchStage: 'native_intro',
    stage: 'native_intro_unexpected', ownedMacProcessesStopped: true,
    message: '/Users/PRIVATE_SENTINEL', stderr: 'SECRET' }), {
    refusalDialogState: null,
    networkGuardStage: null,
    launchStage: 'native_intro', launchCode: 'native_intro_unexpected', settingsStage: null,
    launchOwnedProcessesStopped: true, predecessorUi: null,
    predecessorEntryFailure: null, predecessorDebuggerListening: null, predecessorProcess: null,
    predecessorExit: null,
  });
  assert.deepEqual(macCredentialFailureDiagnostics({ emptyProfileStage: 'settings_effect',
    ownedMacProcessesStopped: false }), {
    refusalDialogState: null,
    networkGuardStage: null,
    launchStage: null, launchCode: null, settingsStage: 'settings_effect', launchOwnedProcessesStopped: false,
    predecessorUi: null, predecessorEntryFailure: null, predecessorDebuggerListening: null,
    predecessorProcess: null,
    predecessorExit: null,
  });
  for (const error of [null, {}, { signedLaunchStage: 'PRIVATE_SENTINEL', stage: 'PRIVATE_SENTINEL',
    emptyProfileStage: 'PRIVATE_SENTINEL', ownedMacProcessesStopped: 'true' }]) {
    assert.deepEqual(macCredentialFailureDiagnostics(error), {
      refusalDialogState: null,
      networkGuardStage: null,
      launchStage: null, launchCode: null, settingsStage: null, launchOwnedProcessesStopped: null,
      predecessorUi: null, predecessorEntryFailure: null, predecessorDebuggerListening: null,
      predecessorProcess: null,
      predecessorExit: null,
    });
  }
  assert.equal(macCredentialFailureDiagnostics({}, 'secure_storage_warning').predecessorUi, 'secure_storage_warning');
  assert.equal(macCredentialFailureDiagnostics({}, '/Users/PRIVATE_SENTINEL').predecessorUi, null);
  assert.deepEqual(macCredentialFailureDiagnostics({}, null, true, false), {
    refusalDialogState: null,
    networkGuardStage: null,
    launchStage: null, launchCode: null, settingsStage: null, launchOwnedProcessesStopped: null,
    predecessorUi: null, predecessorEntryFailure: true, predecessorDebuggerListening: false,
    predecessorProcess: null,
    predecessorExit: null,
  });
  assert.deepEqual(macCredentialFailureDiagnostics({}, null, null, null, null,
    { code: 1, signal: null }).predecessorExit, { code: 1, signal: null });
  assert.equal(macCredentialFailureDiagnostics({}, null, null, null, null,
    { code: 1, signal: '/Users/PRIVATE_SENTINEL' }).predecessorExit, null);
  assert.equal(macCredentialFailureDiagnostics({ pfStage: 'anchor_load' }).networkGuardStage, 'anchor_load');
  assert.equal(macCredentialFailureDiagnostics({ pfStage: '/Users/PRIVATE_SENTINEL' }).networkGuardStage, null);
  assert.equal(macCredentialFailureDiagnostics({ refusalDialogState: 'unexpected_security_ui' }).refusalDialogState,
    'unexpected_security_ui');
  assert.equal(macCredentialFailureDiagnostics({ refusalDialogState: 'SECURE_STORAGE_DENIED' }).refusalDialogState,
    'SECURE_STORAGE_DENIED');
  assert.equal(macCredentialFailureDiagnostics({ refusalDialogState: '/Users/PRIVATE_SENTINEL' }).refusalDialogState, null);
});
