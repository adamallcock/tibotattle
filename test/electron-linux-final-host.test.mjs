import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { linuxFinalHostContainerArguments, linuxFinalHostCleanupArguments,
  validateLinuxFinalLifecycleReceipt, runLinuxFinalHostSequence } from '../scripts/run-electron-linux-final-lifecycle.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const profile = `tibotattle-mount-candidate-12345-${'a'.repeat(32)}`;
const owner = { run: '12345', runner: 'b'.repeat(40), nonce: 'a'.repeat(32), profile,
  profileSha256: 'c'.repeat(64), profileNameSha256: hash(profile) };
const pair = { intake: { schemaVersion: 'tibotattle-linux-final-lifecycle-intake-v1', sourceRevision: 'd'.repeat(40), runnerRevision: owner.runner,
  sourceCandidateSha256: 'e'.repeat(64), packageReceiptSha256: 'f'.repeat(64), packageRunId: '12340', version: '0.1.27', buildNumber: '2026100301' },
  images: { current: { sha256: '1'.repeat(64) }, next: { sha256: '2'.repeat(64) } } };
const flags = ['cleanInstallSmokePassed', 'localRefreshAndCredentialAccess', 'chromiumRendererSandboxVerified',
  'cleanUninstallPreservedLocalState', 'mismatchedFeedChecksumRefusedWithoutReplacement',
  'replacementAndAutomaticRestartVerified', 'coldRestartSettingsAndOptOutVerified',
  'credentialAndSourceStatePreserved', 'noUpdateVerified', 'ownedUninstallAndAppCleanupVerified', 'artifactIntegrityVerified'];
function receipt() {
  return { schemaVersion: 'tibotattle-linux-final-installed-lifecycle-v1', sourceRevision: pair.intake.sourceRevision,
    workflowRunnerRevision: owner.runner, sourceCandidateSha256: pair.intake.sourceCandidateSha256,
    packageReceiptSha256: pair.intake.packageReceiptSha256, packageRunId: pair.intake.packageRunId,
    version: pair.intake.version, buildNumber: pair.intake.buildNumber, target: 'linux-x64',
    images: { current: pair.images.current.sha256, next: pair.images.next.sha256 },
    runtime: 'native_x64_Xvfb_FUSE_ordinary_AppImage_launcher', physicalDesktop: 'not_qualified',
    network: 'loopback_only_network_none', feed: 'fixed_production_URL_simulated_locally',
    credentialScope: 'disposable_Secret_Service', rebuilt: false, published: false,
    ...Object.fromEntries(flags.map(key => [key, true])), publicPredecessorUpdate: 'exact_published_0.1.26_to_final_0.1.27',
    updateInitiation: { check: 'automatic', download: 'automatic' }, status: 'passed', feedRequests: 3, imageRequests: 2 };
}

test('host container scope adds only the exact owned profile and fixed lifecycle nonce', () => {
  const args = linuxFinalHostContainerArguments(owner), value = option => args[args.indexOf(option) + 1];
  assert.equal(value('--security-opt'), `apparmor=${profile}`);
  assert.equal(value('--network'), 'none'); assert.equal(value('--device'), '/dev/fuse');
  assert.ok(args.includes('--cap-add=SYS_ADMIN')); assert.ok(args.includes('--init'));
  assert.ok(args.includes('TIBOTATTLE_LINUX_FINAL_NONCE=' + owner.nonce));
  assert.ok(args.includes('TIBOTATTLE_LINUX_FINAL_PROFILE=' + profile));
  assert.equal(args.at(-1), 'tibotattle-electron-linux-installed:test');
  assert.doesNotMatch(args.join(' '), /--privileged|--no-new-privileges|--user\b|--entrypoint|--volume|--mount\b|--no-sandbox|unconfined/u);
  for (const change of [{ profile: 'unconfined' }, { nonce: '../outside' }, { runner: 'main' },
    { run: '12345;bad' }, { profileNameSha256: '0'.repeat(64) }, { profileSha256: null }, { unexpected: true }]) {
    assert.throws(() => linuxFinalHostContainerArguments({ ...owner, ...change }));
  }
});

test('cleanup requires recorded ID, exact profile, labels and built image revision', () => {
  const id = '3'.repeat(64), inspected = { id, name: '/tibotattle-final-linux-qualification-12345', profile,
    labels: { 'io.tibotattle.final-lifecycle.run': owner.run, 'io.tibotattle.final-lifecycle.runner': owner.runner,
      'org.opencontainers.image.revision': owner.runner } };
  assert.deepEqual(linuxFinalHostCleanupArguments({ id, inspected }, owner), ['rm', '--force', id]);
  for (const mutate of [v => { v.id = '4'.repeat(64); }, v => { v.name += '-other'; },
    v => { v.profile = 'docker-default'; }, v => { v.labels['io.tibotattle.final-lifecycle.run'] = '54321'; },
    v => { v.labels['io.tibotattle.final-lifecycle.runner'] = 'c'.repeat(40); },
    v => { v.labels['org.opencontainers.image.revision'] = 'c'.repeat(40); }, v => { v.labels = {}; }]) {
    const changed = structuredClone(inspected); mutate(changed);
    assert.throws(() => linuxFinalHostCleanupArguments({ id, inspected: changed }, owner));
  }
});

test('only the original fully bound lifecycle v1 assertions can establish runtime success', () => {
  const good = receipt(); assert.equal(validateLinuxFinalLifecycleReceipt(good, pair), good);
  for (const mutate of [v => { v.workflowRunnerRevision = pair.intake.sourceRevision; },
    v => { v.images.next = '0'.repeat(64); }, v => { v.packageReceiptSha256 = '0'.repeat(64); },
    v => { v.published = true; }, v => { v.physicalDesktop = 'qualified'; },
    v => { v.raw = 'private-marker'; }, v => { v.imageRequests = 1; },
    v => { v.updateInitiation.check = 'inferred'; }, v => { v.stage = 'fresh_final_install'; },
    ...flags.map(key => value => { delete value[key]; }),
    ...flags.map(key => value => { value[key] = false; }),
  ]) {
    const altered = structuredClone(good); mutate(altered);
    assert.equal(validateLinuxFinalLifecycleReceipt(altered, pair), null);
  }
  const failed = receipt(); failed.status = 'failed'; failed.stage = 'checksum_refusal';
  failed.errorCode = 'LINUX_FINAL_LIFECYCLE_CHECKSUM_REFUSAL_UNPROVEN'; delete failed.ownedUninstallAndAppCleanupVerified;
  assert.equal(validateLinuxFinalLifecycleReceipt(failed, pair), failed);
  assert.equal(failed.status, 'failed');
  assert.equal(validateLinuxFinalLifecycleReceipt({ ...failed, errorCode: 'private error message' }, pair), null);
});

test('028 lifecycle v2 requires its exact route and cannot consume or relabel a 027 v1 receipt', () => {
  const selected = structuredClone(pair);
  Object.assign(selected.intake, { schemaVersion: 'tibotattle-linux-final-lifecycle-intake-v2',
    version: '0.1.28', buildNumber: '2026100901' });
  const original = receipt();
  assert.equal(validateLinuxFinalLifecycleReceipt(original, selected), null);
  const replacement = { ...original, schemaVersion: 'tibotattle-linux-final-installed-lifecycle-v2',
    version: '0.1.28', buildNumber: '2026100901', publicPredecessorUpdate: 'exact_published_0.1.26_to_final_0.1.28' };
  assert.equal(validateLinuxFinalLifecycleReceipt(replacement, selected), replacement);
  assert.equal(validateLinuxFinalLifecycleReceipt(replacement, pair), null);
  for (const patch of [{ schemaVersion: original.schemaVersion }, { version: original.version },
    { buildNumber: original.buildNumber }, { publicPredecessorUpdate: original.publicPredecessorUpdate },
    { replacementAndAutomaticRestartVerified: false }, { physicalDesktop: 'qualified' }]) {
    assert.equal(validateLinuxFinalLifecycleReceipt({ ...replacement, ...patch }, selected), null);
  }
  for (const patch of [{ schemaVersion: pair.intake.schemaVersion }, { version: '0.1.29' }, { buildNumber: '2026100902' }]) {
    assert.equal(validateLinuxFinalLifecycleReceipt(replacement, { ...selected, intake: { ...selected.intake, ...patch } }), null);
  }
  assert.equal(validateLinuxFinalLifecycleReceipt(original, pair), original);
});

function hostHarness({ outcome = 'compared', lifecycleResult = null, handoff = true } = {}) {
  const calls = [], comparison = { outcome, profilesRemoved: true };
  const candidate = { name: profile, nonce: owner.nonce, profileSha256: owner.profileSha256, profileNameSha256: owner.profileNameSha256 };
  const execution = lifecycleResult ?? { passed: true, containerRemoved: true, original: { bytes: 1024, sha256: '5'.repeat(64) }, errorCode: 'none' };
  return { calls, adapters: {
    compare: async (input, options) => {
      assert.equal(input, pair); calls.push('comparison');
      if (handoff) { const closure = await options.onCandidateVerified(candidate); calls.push(`closure:${closure.containerRemoved}`); }
      calls.push('profile-cleanup'); return comparison;
    },
    lifecycle: async (input, checkpoint) => { assert.equal(input, pair); assert.equal(checkpoint, candidate); calls.push('lifecycle'); return execution; },
  } };
}
test('host success requires both qualification stages and real closure, keeping failures separate', async () => {
  const good = hostHarness();
  const result = await runLinuxFinalHostSequence(pair, good.adapters);
  assert.equal(result.passed, true); assert.deepEqual(good.calls, ['comparison', 'lifecycle', 'closure:true', 'profile-cleanup']);
  for (const setup of [hostHarness({ outcome: 'cleanup_failed' }), hostHarness({ handoff: false }),
    hostHarness({ lifecycleResult: { passed: false, containerRemoved: true, original: { bytes: 200, sha256: '6'.repeat(64) }, errorCode: 'lifecycle_failed' } }),
    hostHarness({ lifecycleResult: { passed: true, containerRemoved: false, original: { bytes: 200, sha256: '6'.repeat(64) }, errorCode: 'cleanup_failed' } }),
    hostHarness({ lifecycleResult: { passed: true, containerRemoved: true, original: null, errorCode: 'none' } }),
  ]) assert.equal((await runLinuxFinalHostSequence(pair, setup.adapters)).passed, false);
  const cancelled = hostHarness(); cancelled.adapters.interrupted = () => true;
  assert.equal((await runLinuxFinalHostSequence(pair, cancelled.adapters)).passed, false);
});
test('host orchestration refuses malformed lifecycle closure and repeated callback entry', async () => {
  const bad = hostHarness({ lifecycleResult: { passed: true, containerRemoved: 'true', original: null, errorCode: 'none' } });
  await assert.rejects(runLinuxFinalHostSequence(pair, bad.adapters), /HOST_HANDOFF_INVALID/u);
  const repeated = hostHarness(), compare = repeated.adapters.compare;
  repeated.adapters.compare = async (input, options) => { await compare(input, options); return compare(input, options); };
  await assert.rejects(runLinuxFinalHostSequence(pair, repeated.adapters), /HOST_HANDOFF_INVALID/u);
});

test('workflow retains the exact four-file evidence set while excluding private operational records', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-linux-final-qualification.yml', import.meta.url), 'utf8');
  const retained = workflow.slice(workflow.indexOf('          path: |'), workflow.indexOf('          if-no-files-found:'));
  const files = retained.split('\n').map(line => line.trim()).filter(line => line.startsWith('.release-build/'));
  assert.deepEqual(files, ['.release-build/linux-final-qualification/pair.json',
    '.release-build/linux-final-qualification/apparmor-comparison.json',
    '.release-build/linux-final-qualification/receipts/installed-lifecycle.json',
    '.release-build/linux-final-qualification/receipts/host-lifecycle.json']);
  assert.doesNotMatch(retained, /\*|\.profile|\.container|owner|trace/u);
  assert.match(workflow, /always\(\) && inputs\.mode == 'execute'/u);
  assert.match(workflow, /--kill-after=90s 1260s node scripts\/run-electron-linux-final-lifecycle\.mjs --execute/u);
  assert.doesNotMatch(workflow, /permissions:\s*write-all|contents: write|--privileged|apparmor=unconfined|seccomp=unconfined/u);
});
