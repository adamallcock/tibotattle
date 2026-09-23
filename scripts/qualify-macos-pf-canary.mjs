#!/usr/bin/env node
// Manual, disposable GitHub ARM runner only. No product/fixture launch path.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { macOSPfQualificationPlan } from './lib/macos-pf-qualification.mjs';

export const PF_CANARY_CONFIRMATION = 'RUN_DISPOSABLE_MAC_PF_CANARY';
export const PF_CANARY_FAILURE_CODES = Object.freeze(["anchor_not_empty", "anchors", "arguments", "cleanup_internal", "command", "config_binding", "containment_changed", "coordinator_not_exited", "deadline", "denial_counter_absent", "descendant", "disposable_host", "enable_reference_uncertain", "enable_token", "group_birth", "group_identity_changed", "gui_bootstrap", "intake", "internal", "ipv4_route_unavailable", "ipv6_route_unavailable", "journal_token", "loopback_failed", "not_enabled", "operation", "other_anchor_rules", "owned_group", "owned_processes_alive", "owned_rules", "parent_rules", "pf_labels", "pf_status", "pre_enable_changed", "preexisting_anchor", "preexisting_pf", "preexisting_references", "probe_exit", "probe_identity", "probe_kind", "probe_output", "probe_ready", "process_inventory", "receipt_operation", "restore_failed", "restore_topology", "root_anchor", "root_anchors", "root_binding", "root_file", "root_identity", "skipped_interface", "source_ancestor", "source_file", "source_link", "source_location", "supervisor_interrupted", "supervisor_restarted", "timeout_not_exercised", "topology_changed", "translation_rules"]);
const fail = () => { throw new Error('MACOS_PF_CANARY_REFUSED'); };
export function parsePfCanaryArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || !['--plan', '--start', '--collect'].includes(argv[0])
    || !['network', 'probe-timeout'].includes(argv[2])) fail();
  const plan = macOSPfQualificationPlan(argv[1]);
  return { mode: argv[0].slice(2), operationId: plan.operationId, scenario: argv[2] };
}
export function validatePfCanaryReceipt(value, input) {
  const bools = ['networkQualified', 'recoveryQualified', 'guiBootstrap', 'coordinatorExited',
    'ownedProcessesStopped', 'pfRestored', 'credentialContinuityQualified'];
  const keys = ['schemaVersion', 'operationId', 'scenario', 'runnerRevision', 'copiedSupervisorSha256', 'status', 'failure', ...bools].sort().join();
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== keys
    || Reflect.ownKeys(value).length !== Object.keys(value).length
    || value.schemaVersion !== 'macos-pf-canary-v1' || value.operationId !== input.operationId
    || value.scenario !== input.scenario || value.runnerRevision !== input.runnerRevision
    || value.copiedSupervisorSha256 !== input.copiedSupervisorSha256
    || !/^[a-f0-9]{40}$/u.test(value.runnerRevision) || !/^[a-f0-9]{64}$/u.test(value.copiedSupervisorSha256)
    || !['passed', 'failed'].includes(value.status)
    || bools.some(key => typeof value[key] !== 'boolean') || value.credentialContinuityQualified !== false
    || !(value.failure === null || PF_CANARY_FAILURE_CODES.includes(value.failure))) fail();
  if (value.status === 'passed' && (value.failure !== null || !value.coordinatorExited
    || !value.ownedProcessesStopped || !value.pfRestored || !value.recoveryQualified
    || (input.scenario === 'network' && (!value.networkQualified || !value.guiBootstrap)))) fail();
  return Object.freeze({ ...value });
}
export function validatePfCanaryHost({ platform, arch, version, environment, account }) {
  if (platform !== 'darwin' || arch !== 'arm64' || version !== 'v26.2.0'
    || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted'
    || environment.RUNNER_OS !== 'macOS' || environment.RUNNER_ARCH !== 'ARM64'
    || account.uid !== 501 || account.username !== 'runner' || account.homedir !== '/Users/runner') fail();
}
export async function runPfCanary(input, { environment = process.env, command = execFileSync } = {}) {
  const plan = macOSPfQualificationPlan(input.operationId);
  if (input.mode === 'plan') return { ...plan, scenario: input.scenario, hostedQualified: false };
  if (environment.PF_CANARY_CONFIRMATION !== PF_CANARY_CONFIRMATION || !['start', 'collect'].includes(input.mode)
    || !['network', 'probe-timeout'].includes(input.scenario) || !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? '')) fail();
  validatePfCanaryHost({ platform: process.platform, arch: process.arch, version: process.version,
    environment, account: userInfo() });
  const script = fileURLToPath(new URL('./lib/macos-pf-canary/supervisor.py', import.meta.url));
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] };
  const copiedSupervisorSha256 = createHash('sha256').update(readFileSync(script)).digest('hex');
  const binding = { ...input, runnerRevision: environment.GITHUB_SHA, copiedSupervisorSha256 };
  const critical = ['scripts/qualify-macos-pf-canary.mjs', 'scripts/lib/macos-pf-canary/supervisor.py',
    'scripts/lib/macos-pf-qualification.mjs', '.github/workflows/electron-macos-credentials.yml'];
  if (command('/usr/bin/git', ['rev-parse', 'HEAD'], options).trim() !== environment.GITHUB_SHA
    || command('/usr/bin/git', ['status', '--porcelain', '--untracked-files=all', '--', ...critical], options).trim()) fail();
  command('/usr/bin/git', ['ls-files', '--error-unmatch', ...critical], options);
  if (input.mode === 'start') {
    command('/usr/bin/sudo', ['-n', '/usr/bin/true'], options);
    command('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-B', script,
      '--install', input.operationId, input.scenario, environment.GITHUB_SHA], options);
    return { schemaVersion: 'macos-pf-canary-start-v1', operationId: input.operationId,
      runnerRevision: binding.runnerRevision, copiedSupervisorSha256, status: 'started', credentialContinuityQualified: false };
  }
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    try {
      const output = command('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-B', script, '--collect', input.operationId], options);
      return validatePfCanaryReceipt(JSON.parse(output), binding);
    } catch { await delay(1000); }
  }
  fail(); // No coordinator fallback that disables PF or unloads a live watchdog.
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPfCanary(parsePfCanaryArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'failed') process.exitCode = 1;
  } catch { process.stderr.write('MACOS_PF_CANARY_REFUSED\n'); process.exitCode = 1; }
}
