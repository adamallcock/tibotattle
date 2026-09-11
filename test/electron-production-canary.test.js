import test from 'node:test';
import { RELEASE_VERSION } from '../config/release-manifest.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { parseProductionCanaryArguments, validateCanaryHost, validateCanaryManifest, sealCanaryCleanup, acceptedDefaultOnSharing, validateCanaryReleaseIdentity, refreshCanaryLocalUsage, waitForCanaryRestartAcceptance } from '../scripts/run-signed-electron-production-canary.mjs';
import { createProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { createDesktopSharingCoordinator } from '../apps/electron/desktop-sharing.js';
import { createAccountlessContributionScheduler } from '../src/application/index.js';
import distributionPolicy from '../config/electron-production-distribution.cjs';
const identity = ['--build-number','2026091111','--archive-sha256','d'.repeat(64),'--app', '/tmp/TiboTattle.app', '--source-revision', 'a'.repeat(40), '--asar-sha256', 'b'.repeat(64),
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
  const unfilledPython = workflow.match(/python3 - <<'PY'\n([\s\S]*?)\n          PY/u)?.[1].replace(/^          /gmu, '');
  assert.ok(unfilledPython);
  const finalPins = { source: '16a0d4dffad4b1213b28adaae139fc9ee6705837', build: '2026091108', archive: 'd1b35690c2b4afc7a225e64f25ad201fd18bda936e96220f7ee080c1791f7651', asar: 'e176d0d763b11f9aa90073b90d0bdd7fbdbb17cc61740331fb47e33899007579' };
  for (const [name, value] of Object.entries(finalPins)) assert.ok(unfilledPython.includes(`approved_${name}='${value}'`));
  const python=unfilledPython.replace("approved_source='16a0d4dffad4b1213b28adaae139fc9ee6705837'", `approved_source='${'a'.repeat(40)}'`)
    .replace("approved_build='2026091108'", "approved_build='2026091111'")
    .replace("approved_archive='d1b35690c2b4afc7a225e64f25ad201fd18bda936e96220f7ee080c1791f7651'", `approved_archive='${'b'.repeat(64)}'`)
    .replace("approved_asar='e176d0d763b11f9aa90073b90d0bdd7fbdbb17cc61740331fb47e33899007579'", `approved_asar='${'c'.repeat(64)}'`);
  execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "intake", "exec")'], { input: python });
  assert.equal(workflow.includes('secrets.'), false);
  assert.ok(workflow.includes("canary:\n    if: github.event_name == 'workflow_dispatch'"));
  assert.ok(workflow.includes("registration:\n    if: github.event_name == 'push'"));
  assert.ok(workflow.includes('default: plan'));
  assert.ok(workflow.includes("'--disable','--fail'"));
  assert.equal(workflow.includes('--location'), false);
  const directory = await mkdtemp(join(tmpdir(), 'canary-intake-refusal-'));
  const environment = { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_SHA: 'a'.repeat(40),
    SELECTED_RUNNER: 'a'.repeat(40), SELECTED_SOURCE: 'a'.repeat(40), SELECTED_BUILD:'2026091111', SELECTED_ARCHIVE: 'b'.repeat(64),
    SELECTED_ASAR: 'c'.repeat(64), CLEANUP_KEY_SHA256: 'e'.repeat(64), SELECTED_MODE: 'execute',
    EXECUTION_CONFIRMATION: 'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY', CLEANUP_PUBLIC_KEY: 'aW52YWxpZA==',
    SELECTED_URL: `https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/production-canary/${'a'.repeat(40)}/${'b'.repeat(64)}.zip` };
  try {
    assert.throws(() => execFileSync('python3',['-c',unfilledPython],{env:environment,stdio:'ignore',timeout:3000}));
    assert.deepEqual(await readdir(directory),[]);
    for (const changed of [ { SELECTED_BUILD:'2026091112' }, { SELECTED_RUNNER: 'f'.repeat(40) }, { SELECTED_SOURCE: 'f'.repeat(40) }, { SELECTED_ARCHIVE: 'f'.repeat(64) }, { SELECTED_ASAR: 'f'.repeat(64) }, { SELECTED_URL: 'https://other.test/app.zip' },
      { EXECUTION_CONFIRMATION: '' }, { CLEANUP_PUBLIC_KEY: Buffer.from('-----BEGIN PRIVATE KEY-----\n').toString('base64') } ]) {
      assert.throws(() => execFileSync('python3', ['-c', python], { env: { ...environment, ...changed }, stdio: 'ignore', timeout: 3000 }));
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true }); }
});


test('fresh acceptance excludes cached timestamps, partial uploads and explicit opt-in', () => {
  const value={enabled:true,basis:'default_on',transportStatus:'up_to_date',lastAcceptedAt:'2026-09-11T12:00:01.000Z'};
  assert.equal(acceptedDefaultOnSharing(value),true);
  assert.equal(acceptedDefaultOnSharing(value,'2026-09-11T12:00:00.000Z'),true);
  for(const changed of [{lastAcceptedAt:null},{lastAcceptedAt:'invalid'},{enabled:false},{basis:'explicit_on'},{transportStatus:'pending'}])assert.equal(acceptedDefaultOnSharing({...value,...changed}),false);
  assert.equal(acceptedDefaultOnSharing(value,value.lastAcceptedAt),false);
});

test('canary release identity binds provenance build, Mac allocation, incoming key and OS floor', () => {
  const sourceRevision='a'.repeat(40),buildNumber='2026091111';
  const metadata=createProductionDistributionMetadata({target:'darwin-arm64',sourceRevision,buildNumber});
  const manifest={name:'app-usagemonitor',version:'0.1.22',tibotattleDistribution:metadata};
  const plist={CFBundleIdentifier:distributionPolicy.PRODUCTION_ELECTRON_APP_ID,CFBundleExecutable:'TiboTattle',CFBundleShortVersionString:'0.1.22',CFBundleVersion:'1029',LSMinimumSystemVersion:'14.0',SUPublicEDKey:distributionPolicy.PRODUCTION_ELECTRON_NATIVE_SPARKLE_PUBLIC_ED_KEY};
  assert.equal(validateCanaryReleaseIdentity(manifest,plist,{sourceRevision,buildNumber}).target,'darwin-arm64');
  for(const changed of [{CFBundleVersion:'1028'},{CFBundleShortVersionString:'0.1.21'},{LSMinimumSystemVersion:'12.0'},{SUPublicEDKey:'wrong'}])assert.throws(()=>validateCanaryReleaseIdentity(manifest,{...plist,...changed},{sourceRevision,buildNumber}));
  assert.throws(()=>validateCanaryReleaseIdentity(manifest,plist,{sourceRevision,buildNumber:'2026091112'}));
});

test('ordinary restart refresh waits for a new completed refresh, not an old success', async () => {
  let clicked=false,reads=0;
  const dashboard={evaluate:async code=>{
    if(code.includes('.disabled'))return true;
    if(code.includes('.click()')){clicked=true;return;}
    assert.ok(code.includes("fetch('/api/local/refresh'"));
    assert.equal(code.includes('POST'),false);
    reads++;
    return {status:'succeeded',refreshId:clicked?'new':'old'};
  }};
  assert.equal(await refreshCanaryLocalUsage({sessions:[dashboard]}),true);
  assert.equal(clicked,true);assert.equal(reads,2);
});

test('restart acceptance survives either ordering of ordinary refresh and the startup upload', async (t) => {
  for (const acceptedDuringRefresh of [true, false]) await t.test(
    acceptedDuringRefresh ? 'accepted before the extra restart' : 'startup completed before indexing', async () => {
      let savedPreference = null, now = Date.parse('2026-09-11T12:00:00.000Z');
      let current, uploads = 0, extraRestarts = 0;
      const origin = 'https://tibotattle.com';
      const launch = async (chunksUploaded) => {
        const sharing = createDesktopSharingCoordinator({
          backend: { load: async () => savedPreference, save: async value => { savedPreference = value; } },
          installationState: 'fresh', destinationOrigin: origin, now: () => new Date(now),
        });
        await sharing.initialize();
        const pending = new Map();
        let timer = 0;
        const scheduler = createAccountlessContributionScheduler({ origin, now: () => now,
          readPreference: sharing.readAuthorization, onStatus: sharing.updateTransport,
          runner: async () => { uploads += chunksUploaded; return { status: 'complete', chunksUploaded }; },
          setTimer: (callback, delay) => { pending.set(++timer, { callback, delay }); return timer; },
          clearTimer: id => pending.delete(id),
        });
        scheduler.start();
        await scheduler.runNow();
        return { sharing, scheduler };
      };
      const wait = async (predicate, timeout) => {
        assert.ok(timeout > 0 && timeout <= 6 * 60000);
        const value = await predicate();
        assert.ok(value, 'the deterministic scheduler has already settled');
        return value;
      };
      current = await launch(2);
      const initial = await current.sharing.inspect();
      assert.equal(acceptedDefaultOnSharing(initial), true);
      await current.scheduler.stop();
      now += 1000;
      current = await launch(acceptedDuringRefresh ? 2 : 0);
      // Ordinary indexing has now completed. It does not invoke runNow; a
      // no-change startup pass schedules its next ordinary attempt in four hours.
      const result = await waitForCanaryRestartAcceptance({
        readSharing: () => current.sharing.inspect(), previousAcceptedAt: initial.lastAcceptedAt,
        restart: async () => {
          extraRestarts++;
          await current.scheduler.stop();
          now += 1000;
          current = await launch(2);
        },
      }, { wait, now: () => now });
      assert.equal(acceptedDefaultOnSharing(result, initial.lastAcceptedAt), true);
      assert.equal(extraRestarts, acceptedDuringRefresh ? 0 : 1);
      assert.equal(uploads, 4, 'both distinct synthetic sources upload exactly once');
      await current.scheduler.stop();
      current = await launch(0);
      const afterAnotherRestart = await current.sharing.inspect();
      assert.equal(afterAnotherRestart.transportStatus, 'up_to_date');
      assert.equal(afterAnotherRestart.lastAcceptedAt, null,
        'a further no-change restart loses only process-local acceptance evidence');
      assert.equal(acceptedDefaultOnSharing(afterAnotherRestart, initial.lastAcceptedAt), false);
      await current.scheduler.stop();
    });
});

test('restart observer lets in-flight and partial uploads settle before deciding to restart', async () => {
  const previousAcceptedAt = '2026-09-11T12:00:00.000Z';
  const accepted = { enabled: true, basis: 'default_on', transportStatus: 'up_to_date',
    lastAcceptedAt: '2026-09-11T12:00:01.000Z' };
  const observations = [
    { ...accepted, transportStatus: 'uploading', lastAcceptedAt: null },
    { ...accepted, transportStatus: 'pending' },
    { ...accepted, transportStatus: 'uploading' },
    accepted,
  ];
  let reads = 0;
  const result = await waitForCanaryRestartAcceptance({
    readSharing: async () => observations[reads++], previousAcceptedAt,
    restart: async () => assert.fail('must not stop a pass that can still accept the new source'),
  }, { now: () => 0, wait: async (predicate, timeout) => {
    assert.equal(timeout, 6 * 60000);
    for (let index = 0; index < observations.length; index++) {
      const value = await predicate();
      if (value) return value;
    }
    assert.fail('fresh acceptance was not observed');
  } });
  assert.equal(result, accepted);
  assert.equal(reads, 4);
});

test('extra startup still requires a fresh accepted default-on upload and shares one timeout budget', async () => {
  const previousAcceptedAt = '2026-09-11T12:00:00.000Z';
  const stale = { enabled: true, basis: 'default_on', transportStatus: 'up_to_date', lastAcceptedAt: previousAcceptedAt };
  for (const final of [stale, { ...stale, lastAcceptedAt: null },
    { ...stale, basis: 'explicit_on', lastAcceptedAt: '2026-09-11T12:00:01.000Z' },
    { ...stale, transportStatus: 'pending', lastAcceptedAt: '2026-09-11T12:00:01.000Z' }]) {
    let restarted = false, now = 0;
    const budgets = [];
    await assert.rejects(waitForCanaryRestartAcceptance({
      readSharing: async () => restarted ? final : stale, previousAcceptedAt,
      restart: async () => { restarted = true; now += 2000; },
    }, { now: () => now, wait: async (predicate, timeout) => {
      budgets.push(timeout);
      const value = await predicate();
      if (!value) throw new Error('synthetic acceptance timeout');
      return value;
    } }), /synthetic acceptance timeout/u);
    assert.equal(restarted, true);
    assert.deepEqual(budgets, [360000, 358000]);
  }
});
