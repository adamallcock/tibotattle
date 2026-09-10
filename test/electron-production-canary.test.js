import test from 'node:test';
import { RELEASE_VERSION } from '../config/release-manifest.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { parseProductionCanaryArguments, validateCanaryHost, validateCanaryManifest, sealCanaryCleanup } from '../scripts/run-signed-electron-production-canary.mjs';
import { createProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
const identity = ['--app', '/tmp/TiboTattle.app', '--source-revision', 'a'.repeat(40), '--asar-sha256', 'b'.repeat(64),
  '--cleanup-public-key', '/tmp/canary.pem', '--cleanup-public-key-sha256', 'c'.repeat(64)];

test('production canary defaults to preparation and requires a closed explicit execution confirmation', () => {
  assert.equal(parseProductionCanaryArguments(['--plan', ...identity]).execute, false);
  assert.throws(() => parseProductionCanaryArguments(['--execute-production-canary', ...identity]));
  assert.equal(parseProductionCanaryArguments(['--execute-production-canary', ...identity, '--confirm', 'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY']).execute, true);
  for (const args of [ ['--plan', ...identity, '--confirm', 'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY'],
    ['--plan', ...identity, '--origin', 'https://other.test'], ['--plan', ...identity, '--home', '/Users/adam'],
    ['--plan', ...identity, '--app', '/tmp/TiboTattle.app'], ['--plan', ...identity, '--skip-signature'] ]) {
    assert.throws(() => parseProductionCanaryArguments(args));
  }
});

test('a normal local account or forged HOME cannot authorize production canary launch', () => {
  const inputs = { platform: 'darwin', architecture: 'arm64', nodeVersion: 'v26.2.0',
    environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', RUNNER_TEMP: '/Users/runner/work/_temp' },
    account: { uid: 501, username: 'runner', homedir: '/Users/runner' } };
  assert.equal(validateCanaryHost(inputs), '/Users/runner');
  for (const changed of [ { platform: 'linux' }, { architecture: 'x64' }, { nodeVersion: 'v26.3.0' },
    { account: { ...inputs.account, username: 'adam', homedir: '/Users/adam' } },
    { environment: { ...inputs.environment, HOME: '/Users/runner', RUNNER_ENVIRONMENT: 'self-hosted' } } ]) {
    assert.throws(() => validateCanaryHost({ ...inputs, ...changed }), { canaryStage: 'disposable_account' });
  }
});

test('ordinary signed manifest validation refuses staging or source confusion', () => {
  const metadata = createProductionDistributionMetadata({ target: 'darwin-arm64', sourceRevision: 'a'.repeat(40), buildNumber: '2026090920' });
  const manifest = { name: 'app-usagemonitor', version: RELEASE_VERSION, tibotattleDistribution: metadata };
  assert.equal(validateCanaryManifest(manifest, 'a'.repeat(40)).target, 'darwin-arm64');
  assert.throws(() => validateCanaryManifest(manifest, 'd'.repeat(40)));
  assert.throws(() => validateCanaryManifest({ ...manifest, tibotattleAccountlessSignedStagingRehearsal: {} }, 'a'.repeat(40)));
  assert.throws(() => validateCanaryManifest({ ...manifest, tibotattleDistribution: { ...metadata, updateFeed: 'https://other.test' } }, 'a'.repeat(40)));
});

test('signed handover fixtures cannot stand in for a production enrollment canary', () => {
  // The installed .18 handover app has this valid distribution family, but
  // main.js intentionally selects no accountless production scheduler for it.
  const futureCore = RELEASE_VERSION.replace(/\d+$/u, patch => String(Number(patch) + 1));
  const metadata = createProductionDistributionMetadata({ target: 'darwin-arm64',
    sourceRevision: 'a'.repeat(40), buildNumber: '2026090920', rehearsal: 'next',
    rehearsalCurrentVersion: `${futureCore}-native-to-electron-handover.17`,
    rehearsalNextVersion: `${futureCore}-native-to-electron-handover.18` });
  assert.throws(() => validateCanaryManifest({ name: 'app-usagemonitor',
    version: metadata.semanticVersion, tibotattleDistribution: metadata }, 'a'.repeat(40)),
  { canaryStage: 'artifact_uploads_disabled' });
});

test('cleanup handoff encrypts only the exact synthetic target and authenticates ciphertext', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const payload = { deviceId: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222',
    origin: 'https://tibotattle.com', sourceRevision: 'a'.repeat(40), asarSha256: 'b'.repeat(64), extraCredential: 'must not enter handoff' };
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const envelope = sealCanaryCleanup(pem, payload);
  assert.equal(JSON.stringify(envelope).includes(payload.deviceId), false);
  assert.equal(JSON.stringify(envelope).includes(payload.extraCredential), false);
  const aes = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', aes, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const opened = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
  assert.equal(opened.deviceId, payload.deviceId);
  assert.equal(opened.operationId, payload.operationId);
  assert.equal(opened.extraCredential, undefined);
  const tampered = Buffer.from(envelope.ciphertext, 'base64'); tampered[0] ^= 1;
  const bad = createDecipheriv('aes-256-gcm', aes, Buffer.from(envelope.iv, 'base64'));
  bad.setAuthTag(Buffer.from(envelope.tag, 'base64')); bad.update(tampered);
  assert.throws(() => bad.final());
  assert.throws(() => sealCanaryCleanup(pem, { ...payload, origin: 'https://other.test' }));
  assert.throws(() => sealCanaryCleanup(pem, { ...payload, deviceId: 'not-a-device' }));
  aes.fill(0);
});

test('dispatch intake rejects unapproved source, destination, key and execution before download or profile writes', async () => {
  const { readFile, mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workflow = await readFile(new URL('../.github/workflows/electron-production-canary.yml', import.meta.url), 'utf8');
  const python = workflow.match(/python3 - <<'PY'\n([\s\S]*?)\n          PY/u)?.[1].replace(/^          /gmu, '');
  assert.ok(python);
  execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "intake", "exec")'], { input: python });
  assert.equal(workflow.includes('secrets.'), false);
  assert.ok(workflow.includes("canary:\n    if: github.event_name == 'workflow_dispatch'"));
  assert.ok(workflow.includes("registration:\n    if: github.event_name == 'push'"));
  assert.ok(workflow.includes('default: plan'));
  assert.ok(workflow.includes("'--disable','--fail'"));
  assert.equal(workflow.includes('--location'), false);
  const directory = await mkdtemp(join(tmpdir(), 'canary-intake-refusal-'));
  const environment = { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_SHA: 'a'.repeat(40),
    SELECTED_RUNNER: 'a'.repeat(40), SELECTED_SOURCE: '7293828ade187f6fd9e50c67d7018704150ca156', SELECTED_ARCHIVE: '98d32e2a25b4d860d1a60cbdc94fc2a2dbb2dc3e0af58510a0e85e6d1fa24936',
    SELECTED_ASAR: 'e7c725a0902a18a0970265a8b32535fbe8e447829754592af91fc709eb0a987e', CLEANUP_KEY_SHA256: 'e'.repeat(64), SELECTED_MODE: 'execute',
    EXECUTION_CONFIRMATION: 'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY', CLEANUP_PUBLIC_KEY: 'aW52YWxpZA==',
    SELECTED_URL: 'https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64/TiboTattle-0.1.19-native-to-electron-handover.18-mac-arm64.zip' };
  try {
    for (const changed of [ { SELECTED_RUNNER: 'f'.repeat(40) }, { SELECTED_URL: 'https://other.test/app.zip' },
      { EXECUTION_CONFIRMATION: '' }, { CLEANUP_PUBLIC_KEY: Buffer.from('-----BEGIN PRIVATE KEY-----\n').toString('base64') } ]) {
      assert.throws(() => execFileSync('python3', ['-c', python], { env: { ...environment, ...changed }, stdio: 'ignore', timeout: 3000 }));
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true }); }
});
