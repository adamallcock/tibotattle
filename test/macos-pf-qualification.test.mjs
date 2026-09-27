import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { macOSPfQualificationPlan, macOSPfReleaseReferenceArguments,
  validateMacOSPfPreflight, validateMacOSPfProbeEvidence,
  createMacOSPfQualificationReview } from '../scripts/lib/macos-pf-qualification.mjs';

const operationId = '4a5361b7-dc54-49cc-92c5-a3e7d42b9a6f';
const topologySha256 = 'a'.repeat(64);
const preflight = () => ({ disposableHostedArmMac: true, passwordlessSudo: true,
  prefetchComplete: true, anchorAbsent: true, wildcardReachable: true, noEarlierQuickPass: true,
  noSkippedInterfaces: true, noPreexistingOwnedProcesses: true, rootSupervisorReady: true,
  launchRegistrationClosed: true, rootJournalDurable: true, hostedRecoveryCanaryPassed: true,
  pfEnabled: false, stateCount: 0, referenceCount: 0, topologySha256 });
const contain = () => ({ enabled: true, stateCountBeforeEnable: 0, exactOwnedRules: true,
  enableTokenJournaled: true, topologySha256, rootSupervisorReady: true });
const packet = () => ({ matchedOwnedRule: true, packetsBefore: 0, packetsAfter: 1,
  externalConnectionSucceeded: false });
const proof = () => ({ enabled: true, exactOwnedRules: true, topologyUnchanged: true,
  noExternalStates: true, loopback4: true, loopback6: true,
  tcp4: packet(), tcp6: packet(), udp4: packet(), udp6: packet(), descendant: packet() });
const stopped = () => ({ launchGateClosed: true, coordinatorStopped: true,
  ownedProcessesRemaining: 0, ownershipInventoryComplete: true, fixtureScopeRestored: true });
const restored = () => ({ ownedAnchorEmpty: true, ownReferenceReleased: true,
  topologySha256, pfDisabled: true });
function qualified() {
  const review = createMacOSPfQualificationReview(operationId);
  review.transition('admit', preflight()); review.transition('contain', contain());
  review.transition('prove', proof()); return review;
}

test('PF policy blocks outbound TCP/UDP in both families and other IP without runner exceptions', () => {
  const plan = macOSPfQualificationPlan(operationId);
  assert.equal(plan.executable, false);
  assert.equal(plan.anchor, `com.apple/tibotattle-credential-${operationId}`);
  assert.equal(plan.rules.trim().split('\n').length, 6);
  for (const [kind, family, protocol, destination] of [
    ['tcp4', 'inet', 'tcp', '192.0.2.1'], ['tcp6', 'inet6', 'tcp', '2001:db8::1'],
    ['udp4', 'inet', 'udp', '192.0.2.1'], ['udp6', 'inet6', 'udp', '2001:db8::1'],
  ]) assert.ok(plan.rules.includes(`block drop out quick ${family} proto ${protocol} from any to ${destination} port 9 label "${plan.labels[kind]}"`));
  assert.ok(!/\bpass\b|443|github|no-sandbox|disable-gpu/u.test(plan.rules));
  assert.deepEqual(plan.commands.emptyOwnedAnchor, ['/sbin/pfctl', '-a', plan.anchor, '-f', '-']);
  for (const command of Object.values(plan.commands)) assert.ok(!command.includes('-F') && !command.includes('-d'));
  assert.deepEqual(plan.commands.acquireEnableReference, ['/sbin/pfctl', '-E']);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.commands.loadOwnedAnchor));
  assert.throws(() => { plan.labels.tcp4 = 'replacement'; });
});

test('untrusted operation identifiers and enable tokens cannot alter command scope', () => {
  for (const value of ['../other', operationId.toUpperCase(), operationId + '\npass all', {}, null]) {
    assert.throws(() => macOSPfQualificationPlan(value));
  }
  assert.deepEqual(macOSPfReleaseReferenceArguments('18446744073709551615'), ['/sbin/pfctl', '-X', '18446744073709551615']);
  for (const value of [0, '0', '-1', '01', '1\n-F all', '18446744073709551616', null, {}]) {
    assert.throws(() => macOSPfReleaseReferenceArguments(value));
  }
});

test('preflight refuses active PF, preexisting states/references, unreachable anchors, sudo and ownership gaps', () => {
  assert.ok(Object.isFrozen(validateMacOSPfPreflight(preflight())));
  for (const [key, value] of Object.entries(preflight())) {
    assert.throws(() => validateMacOSPfPreflight({ ...preflight(), [key]: typeof value === 'boolean' ? !value : key === 'topologySha256' ? 'unknown' : 1 }), key);
    const missing = preflight(); delete missing[key];
    assert.throws(() => validateMacOSPfPreflight(missing), key);
  }
  assert.throws(() => validateMacOSPfPreflight({ ...preflight(), rawOutput: 'PRIVATE_SENTINEL' }));
});

test('the pre-enable observation must still be empty and bound to the admitted topology', () => {
  for (const change of [{ stateCountBeforeEnable: 1 }, { enabled: false },
    { enableTokenJournaled: false }, { rootSupervisorReady: false }, { exactOwnedRules: false },
    { topologySha256: 'b'.repeat(64) }]) {
    const review = createMacOSPfQualificationReview(operationId);
    review.transition('admit', preflight());
    assert.throws(() => review.transition('contain', { ...contain(), ...change }));
    assert.equal(review.snapshot().phase, 'admitted');
  }
});

test('network proof requires exact kernel rule counters for all protocols and descendants', () => {
  const input = proof(), output = validateMacOSPfProbeEvidence(input);
  input.udp6.packetsAfter = 0;
  assert.equal(output.udp6.packetsAfter, 1);
  assert.ok(Object.isFrozen(output.udp6));
  for (const key of ['tcp4', 'tcp6', 'udp4', 'udp6', 'descendant']) {
    for (const change of [{ packetsAfter: 0 }, { packetsBefore: 2 }, { packetsAfter: NaN },
      { packetsAfter: Number.MAX_SAFE_INTEGER + 1 }, { matchedOwnedRule: false },
      { externalConnectionSucceeded: true }, { outcome: 'timeout' }, { rawError: 'PRIVATE_SENTINEL' }]) {
      const input = proof(); Object.assign(input[key], change);
      assert.throws(() => validateMacOSPfProbeEvidence(input), key);
    }
    const input = proof(); input[key] = { outcome: 'EPERM' };
    assert.throws(() => validateMacOSPfProbeEvidence(input));
  }
  for (const key of ['enabled', 'exactOwnedRules', 'topologyUnchanged', 'noExternalStates', 'loopback4', 'loopback6']) {
    assert.throws(() => validateMacOSPfProbeEvidence({ ...proof(), [key]: false }), key);
  }
});

test('closed observations reject getters, inherited fields, symbols and private payloads', () => {
  let getterCalls = 0;
  const value = preflight(); Object.defineProperty(value, 'passwordlessSudo', { get() { getterCalls++; return true; }, enumerable: true });
  assert.throws(() => validateMacOSPfPreflight(value)); assert.equal(getterCalls, 0);
  assert.throws(() => validateMacOSPfPreflight(Object.create(preflight())));
  assert.throws(() => validateMacOSPfPreflight({ ...preflight(), [Symbol('private')]: 'PRIVATE_SENTINEL' }));
  assert.throws(() => validateMacOSPfProbeEvidence({ ...proof(), rawStderr: 'PRIVATE_SENTINEL' }), error => !error.message.includes('PRIVATE_SENTINEL'));
});

test('successful review requires stopping the coordinator and apps before restoring only owned PF state', () => {
  const review = qualified();
  assert.throws(() => review.transition('restore', restored()));
  review.transition('finish', { rootOwnerRequestedCleanup: true });
  assert.throws(() => review.transition('restore', restored()));
  review.transition('stopped', stopped());
  const result = review.transition('restore', restored());
  assert.deepEqual(result, { operationId, phase: 'restored', failure: null, executable: false, credentialContinuityQualified: false });
  assert.throws(() => review.transition('prove', proof()));
});

for (const reason of ['coordinator_crash', 'ci_disconnect', 'timeout', 'containment_changed']) {
  test(`${reason} uses independent local cleanup and never claims qualification`, () => {
    const review = qualified();
    assert.throws(() => review.transition(reason, { rootSupervisorAlive: false }));
    review.transition(reason, { rootSupervisorAlive: true });
    assert.throws(() => review.transition('restore', restored()));
    review.transition('stopped', stopped());
    const result = review.transition('restore', restored());
    assert.equal(result.failure, reason);
    assert.equal(result.credentialContinuityQualified, false);
  });
}

test('an alive app, reopened launch gate, alive coordinator or incomplete ownership inventory prevents unblock', () => {
  for (const change of [{ ownedProcessesRemaining: 1 }, { launchGateClosed: false },
    { coordinatorStopped: false }, { ownershipInventoryComplete: false }]) {
    const review = qualified(); review.transition('timeout', { rootSupervisorAlive: true });
    assert.equal(review.transition('stopped', { ...stopped(), ...change }).phase, 'blocked');
    assert.throws(() => review.transition('restore', restored()));
    // A later complete root observation may permit recovery, never success.
    review.transition('stopped', stopped());
    assert.equal(review.transition('restore', restored()).failure, 'timeout');
  }
});

test('fixture cleanup uncertainty stays failed even after all processes are stopped and PF is restored', () => {
  const review = qualified(); review.transition('finish', { rootOwnerRequestedCleanup: true });
  review.transition('stopped', { ...stopped(), fixtureScopeRestored: false });
  assert.equal(review.transition('restore', restored()).failure, 'fixture_cleanup_unverified');
});

test('cleanup must verify the exact baseline topology, empty owned anchor and released own reference', () => {
  for (const change of [{ ownedAnchorEmpty: false }, { ownReferenceReleased: false },
    { pfDisabled: false }, { topologySha256: 'b'.repeat(64) }]) {
    const review = qualified(); review.transition('finish', { rootOwnerRequestedCleanup: true });
    review.transition('stopped', stopped());
    assert.throws(() => review.transition('restore', { ...restored(), ...change }));
    assert.equal(review.snapshot().phase, 'safe_to_restore');
  }
});

test('PF draft cannot silently replace the current credential workflow or bypass its sandbox launcher', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-credentials.yml', import.meta.url), 'utf8');
  const harness = await readFile(new URL('../scripts/smoke-electron-macos-credentials.mjs', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('../scripts/run-signed-electron-staging.mjs', import.meta.url), 'utf8');
  const core = await readFile(new URL('../scripts/lib/macos-pf-qualification.mjs', import.meta.url), 'utf8');
  assert.ok(!workflow.includes('pfctl') && !workflow.includes('macos-pf-qualification'));
  assert.ok(!harness.includes('macos-pf-qualification'));
  assert.ok(harness.includes('networkMode: MACOS_LOOPBACK_MODE'));
  assert.ok(launcher.includes("networkMode !== null && networkMode !== MACOS_LOOPBACK_MODE"));
  assert.ok(!core.includes('node:child_process') && !core.includes('node:fs'));
});
