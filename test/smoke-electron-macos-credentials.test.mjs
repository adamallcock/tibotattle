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
  expectedCredentialReason, macCredentialDialogScript, exerciseCredentialRefresh,
  validateCredentialFixtureReply, validateCredentialScope, MAC_CREDENTIAL_FIXTURE_FAILURE_CODES } from '../scripts/smoke-electron-macos-credentials.mjs';
import { CREDENTIAL_FIXTURE_CASES, credentialFixtureRoot, credentialFixtureConfiguration,
  parseCredentialFixtureArguments, compileCredentialFixture } from '../scripts/prepare-electron-macos-credential-fixture.mjs';
import { MACOS_LOOPBACK_POLICY, MACOS_LOOPBACK_MODE, macOSLoopbackLaunch,
  macOSLoopbackProbeSource, inspectMacOSLoopbackEnforcement } from '../scripts/lib/macos-loopback-qualification.mjs';
import { launchVerifiedMacSharingApp } from '../scripts/run-signed-electron-staging.mjs';
import { preflightMacCredentialEnvironment } from '../scripts/lib/macos-credential-qualification-intake.mjs';
import { validateEmptyProfileIntake } from '../scripts/smoke-electron-macos-empty-profile.mjs';

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

test('execute refuses a non-hosted account before downloads, profiles, installation or Keychain operations', async () => {
  const script = `import {runMacCredentialQualification} from './scripts/smoke-electron-macos-credentials.mjs';
globalThis.fetch=()=>{throw new Error('unexpected network')};
process.stdout.write(JSON.stringify(await runMacCredentialQualification({execute:true,intake:${JSON.stringify(intake)}})));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), env: { PATH: '/usr/bin:/bin', GITHUB_ACTIONS: 'false' }, encoding: 'utf8' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureStage, 'disposable_host');
  assert.equal(result.credentialContinuityQualified, false);
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
  for (const operation of [null, 'seed', 'snapshot', 'select', 'scope', 'lock', 'unlock', 'restore', 'cleanup']) {
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
