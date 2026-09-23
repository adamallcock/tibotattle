import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parsePfCanaryArguments, runPfCanary, validatePfCanaryHost, validatePfCanaryReceipt,
  PF_CANARY_CONFIRMATION } from '../scripts/qualify-macos-pf-canary.mjs';
import { macOSPfQualificationPlan } from '../scripts/lib/macos-pf-qualification.mjs';

const operationId = '4a5361b7-dc54-49cc-92c5-a3e7d42b9a6f';
const input = { operationId, scenario: 'network', runnerRevision: 'a'.repeat(40), copiedSupervisorSha256: 'b'.repeat(64) };
const receipt = () => ({ schemaVersion: 'macos-pf-canary-v1', ...input, status: 'passed', failure: null,
  networkQualified: true, recoveryQualified: true, guiBootstrap: true, coordinatorExited: true,
  ownedProcessesStopped: true, pfRestored: true, credentialContinuityQualified: false });
const host = () => ({ platform: 'darwin', arch: 'arm64', version: 'v26.2.0',
  environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' },
  account: { uid: 501, username: 'runner', homedir: '/Users/runner' } });

test('canary argument scope cannot select product paths, arbitrary destinations or commands', () => {
  assert.deepEqual(parsePfCanaryArguments(['--start', operationId, 'network']), { mode: 'start', operationId, scenario: 'network' });
  for (const argv of [['--execute', operationId, 'network'], ['--start', operationId, 'app'],
    ['--start', operationId, 'network', '--no-sandbox'], ['--start', '../other', 'network']]) {
    assert.throws(() => parsePfCanaryArguments(argv));
  }
});

test('plan performs no host command and never reports installed or hosted qualification', async () => {
  let calls = 0;
  const plan = await runPfCanary({ mode: 'plan', operationId, scenario: 'network' }, { command() { calls++; throw new Error('unexpected'); } });
  assert.equal(calls, 0); assert.equal(plan.hostedQualified, false); assert.equal(plan.executable, false);
  await assert.rejects(runPfCanary({ mode: 'start', operationId, scenario: 'network' }, { environment: {}, command() { calls++; } }));
  assert.equal(calls, 0); assert.equal(PF_CANARY_CONFIRMATION, 'RUN_DISPOSABLE_MAC_PF_CANARY');
});

test('live canary refuses user Macs, nonhosted runners and unpinned runtimes', () => {
  validatePfCanaryHost(host());
  for (const change of [{ platform: 'linux' }, { arch: 'x64' }, { version: 'v26.2.1' },
    { account: { uid: 501, username: 'owner', homedir: '/Users/owner' } }]) {
    assert.throws(() => validatePfCanaryHost({ ...host(), ...change }));
  }
  for (const key of Object.keys(host().environment)) {
    const value = host(); delete value.environment[key]; assert.throws(() => validatePfCanaryHost(value));
  }
});

test('closed canary receipt binds copied supervisor and exact runner and never claims credentials', () => {
  assert.ok(Object.isFrozen(validatePfCanaryReceipt(receipt(), input)));
  for (const change of [{ runnerRevision: 'c'.repeat(40) }, { copiedSupervisorSha256: 'd'.repeat(64) },
    { operationId: 'other' }, { credentialContinuityQualified: true }, { pfRestored: false },
    { ownedProcessesStopped: false }, { coordinatorExited: false }, { networkQualified: false },
    { guiBootstrap: false }, { recoveryQualified: false }, { rawStderr: 'PRIVATE_SENTINEL' }]) {
    assert.throws(() => validatePfCanaryReceipt({ ...receipt(), ...change }, input));
  }
  for (const key of Object.keys(receipt())) {
    const value = receipt(); delete value[key]; assert.throws(() => validatePfCanaryReceipt(value, input));
  }
  assert.equal(validatePfCanaryReceipt({ ...receipt(), status: 'failed', failure: 'ipv6_route_unavailable', networkQualified: false }, input).status, 'failed');
});

test('hung probe recovery has a distinct scope from network proof', () => {
  const timeout = { ...input, scenario: 'probe-timeout' };
  assert.equal(validatePfCanaryReceipt({ ...receipt(), scenario: 'probe-timeout', guiBootstrap: false, networkQualified: false }, timeout).status, 'passed');
});

test('Python root supervisor emits exactly the reviewed JS firewall policy without running it', () => {
  const source = `import importlib.util,sys\ns=importlib.util.spec_from_file_location('canary',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);sys.stdout.write(m.rules(sys.argv[2]))`;
  const observed = execFileSync('/usr/bin/python3', ['-B', '-c', source,
    new URL('../scripts/lib/macos-pf-canary/supervisor.py', import.meta.url).pathname, operationId], { encoding: 'utf8' });
  assert.equal(observed, macOSPfQualificationPlan(operationId).rules);
});

test('manual workflow prefetches before start and retains source pins, read-only permissions and no credential lane', async () => {
  const workflow = await readFile(new URL('../.github/workflows/electron-macos-credentials.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('workflow_dispatch:') && workflow.includes('default: plan'));
  assert.ok(workflow.includes('contents: read') && workflow.includes('cancel-in-progress: false'));
  const canary = workflow.slice(workflow.indexOf('  canary:'));
  assert.ok(!canary.includes('secrets.') && !canary.includes('fixture') && !workflow.includes('pull_request'));
  assert.ok(workflow.includes("if: inputs.mode == 'plan' || inputs.mode == 'execute'"));
  assert.ok(canary.includes("if: inputs.mode == 'pf-canary-plan' || inputs.mode == 'pf-canary-execute'"));
  assert.ok(canary.indexOf('Set up pinned ARM Node') < canary.indexOf('exit coordinator'));
  assert.ok(canary.indexOf('--collect') < canary.indexOf('actions/upload-artifact@'));
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) assert.match(line, /@[a-f0-9]{40}\b/u);
  const coordinator = await readFile(new URL('../scripts/qualify-macos-pf-canary.mjs', import.meta.url), 'utf8');
  assert.ok(coordinator.includes("['rev-parse', 'HEAD']") && coordinator.includes("'--error-unmatch'"));
  assert.ok(!coordinator.includes('smoke-electron') && !coordinator.includes('/sbin/pfctl'));
});
