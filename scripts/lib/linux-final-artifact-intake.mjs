// Closed admission for one public predecessor and one immutable final package.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { productionElectronCandidatePlan } from '../package-electron-production.mjs';

export const LINUX_FINAL_CONFIRMATION = 'RUN_DISPOSABLE_FINAL_LINUX_LIFECYCLE';
export const LINUX_FINAL_SCHEMA = 'tibotattle-linux-final-lifecycle-intake-v1';
export const LINUX_FINAL_INPUT = '.release-build/linux-final-qualification';
export const LINUX_FINAL_PREDECESSOR = Object.freeze({
  version: '0.1.26', sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
  file: 'TiboTattle-0.1.26-linux-x86_64.AppImage', bytes: 130763167,
  sha256: '9d2ac0430e556e4aca1e03e1e4bef65a872e998335cc30b83b31a08e8fd897fd',
  manifestSha256: 'be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc',
});
export const LINUX_FINAL_FEED = 'https://updates.tibotattle.com/electron/stable/linux-x64';
export const linuxFinalFailure = code => { throw Object.assign(new Error(`LINUX_FINAL_LIFECYCLE_${code}`), { code: `LINUX_FINAL_LIFECYCLE_${code}` }); };
const fail = linuxFinalFailure;
const SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
export const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function validateLinuxFinalIntake(value) {
  const keys = ['schemaVersion', 'runnerRevision', 'sourceRevision', 'version', 'buildNumber',
    'packageRunId', 'packageRunnerRevision', 'sourceCandidateSha256', 'packageReceiptSha256',
    'artifactSha256', 'artifactBytes', 'asarSha256', 'executableSha256', 'sourceCandidate'];
  if (!exactKeys(value, keys) || value.schemaVersion !== LINUX_FINAL_SCHEMA
    || value.version !== '0.1.27' || value.buildNumber !== '2026100301'
    || !['runnerRevision', 'sourceRevision', 'packageRunnerRevision'].every(k => SHA.test(value[k] ?? ''))
    || !['sourceCandidateSha256', 'packageReceiptSha256', 'artifactSha256', 'asarSha256', 'executableSha256'].every(k => HASH.test(value[k] ?? ''))
    || typeof value.packageRunId !== 'string' || !/^[1-9][0-9]{0,14}$/u.test(value.packageRunId)
    || !Number.isSafeInteger(value.artifactBytes) || value.artifactBytes < 4096 || value.artifactBytes > 1024 ** 3) fail('INTAKE_INVALID');
  const plan = productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision: value.sourceRevision,
    buildNumber: value.buildNumber, hostPlatform: 'linux', hostArchitecture: 'x64' });
  if (!isDeepStrictEqual(value.sourceCandidate, { ...plan, status: 'production_source_staged',
    stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' })) fail('SOURCE_CANDIDATE_INVALID');
  return value;
}
export function parseLinuxFinalIntake(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 64 * 1024) fail('INTAKE_INVALID');
  let value; try { value = JSON.parse(serialized); } catch { fail('INTAKE_INVALID'); }
  return validateLinuxFinalIntake(value);
}
export function preflightLinuxFinalIntake(environment = process.env, { repositoryRoot = process.cwd() } = {}) {
  const intake = parseLinuxFinalIntake(environment.LINUX_FINAL_INTAKE);
  if (intake.runnerRevision !== environment.GITHUB_SHA
    || !['plan', 'execute'].includes(environment.SELECTED_MODE)
    || environment.SELECTED_CONFIRMATION !== (environment.SELECTED_MODE === 'execute' ? LINUX_FINAL_CONFIRMATION : '')) fail('CONFIRMATION_INVALID');
  const git = args => {
    try { return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 131072, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { fail('RUNNER_INVALID'); }
  };
  if (git(['rev-parse', 'HEAD']) !== intake.runnerRevision) fail('RUNNER_INVALID');
  git(['merge-base', '--is-ancestor', intake.sourceRevision, intake.runnerRevision]);
  const manifest = readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8').trim();
  if (git(['show', `${intake.runnerRevision}:package.json`]) !== manifest
    || JSON.parse(manifest).version !== intake.version
    || JSON.parse(git(['show', `${intake.sourceRevision}:package.json`])).version !== intake.version) fail('VERSION_INVALID');
  return intake;
}
export function linuxFinalArtifactName(intake) {
  return `electron-linux-production-package-${intake.sourceRevision}-runner-${intake.packageRunnerRevision}`;
}
export function validateLinuxFinalPackageRun(value, intake) {
  if (String(value?.id) !== intake.packageRunId || value.event !== 'workflow_dispatch'
    || value.path !== '.github/workflows/electron-linux-production-package.yml'
    || value.head_sha !== intake.packageRunnerRevision || value.status !== 'completed'
    || value.conclusion !== 'success' || value.repository?.full_name !== 'adamallcock/tibotattle') fail('PACKAGE_RUN_INVALID');
}
export function validateLinuxFinalPackageReceipt(value, intake, sourceBytes) {
  if (sha256(sourceBytes) !== intake.sourceCandidateSha256
    || !isDeepStrictEqual(JSON.parse(sourceBytes), intake.sourceCandidate)
    || !exactKeys(value, ['schemaVersion', 'workflowRunnerRevision', 'sourceRevision', 'version', 'buildNumber', 'target',
      'sourceCandidateSha256', 'appUpdate', 'artifact', 'manifest', 'signingRequired', 'published', 'nativeRuntimeQualification'])
    || value.schemaVersion !== 'tibotattle-linux-production-package-v1'
    || value.workflowRunnerRevision !== intake.packageRunnerRevision
    || value.sourceRevision !== intake.sourceRevision || value.version !== intake.version
    || value.buildNumber !== intake.buildNumber || value.target !== 'linux-x64'
    || value.sourceCandidateSha256 !== intake.sourceCandidateSha256 || value.signingRequired !== false
    || value.published !== false || value.nativeRuntimeQualification !== 'separate_evidence_required'
    || !exactKeys(value.artifact, ['file', 'bytes', 'sha256', 'sha512'])
    || value.artifact.file !== `TiboTattle-${intake.version}-linux-x86_64.AppImage`
    || value.artifact.bytes !== intake.artifactBytes || value.artifact.sha256 !== intake.artifactSha256
    || !/^[A-Za-z0-9+/]{86}==$/u.test(value.artifact.sha512 ?? '')) fail('PACKAGE_RECEIPT_INVALID');
  return value;
}
export function validateLinuxFinalPair(value, runnerRevision) {
  if (!exactKeys(value, ['schemaVersion', 'intake', 'predecessorManifestSha256', 'images'])
    || value.schemaVersion !== 'tibotattle-linux-final-artifact-pair-v1'
    || value.predecessorManifestSha256 !== LINUX_FINAL_PREDECESSOR.manifestSha256
    || !exactKeys(value.images, ['current', 'next'])) fail('PAIR_INVALID');
  const intake = validateLinuxFinalIntake(value.intake);
  if (intake.runnerRevision !== runnerRevision) fail('RUNNER_INVALID');
  for (const role of ['current', 'next']) {
    const row = value.images[role];
    if (!exactKeys(row, ['file', 'version', 'sourceRevision', 'bytes', 'sha256', 'sha512', 'asarSha256', 'executableSha256'])
      || row.file !== `${role}.AppImage` || !HASH.test(row.asarSha256 ?? '') || !HASH.test(row.executableSha256 ?? '')
      || !/^[A-Za-z0-9+/]{86}==$/u.test(row.sha512 ?? '')) fail('PAIR_INVALID');
  }
  const previous = value.images.current, next = value.images.next;
  for (const key of ['version', 'sourceRevision', 'bytes', 'sha256']) if (previous[key] !== LINUX_FINAL_PREDECESSOR[key]) fail('PREDECESSOR_INVALID');
  if (next.version !== intake.version || next.sourceRevision !== intake.sourceRevision || next.bytes !== intake.artifactBytes
    || next.sha256 !== intake.artifactSha256 || next.asarSha256 !== intake.asarSha256
    || next.executableSha256 !== intake.executableSha256) fail('FINAL_BYTES_INVALID');
  return value;
}
