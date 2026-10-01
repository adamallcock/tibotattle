// Read-only admission of a current release candidate, not installed-app proof.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import distribution from '../../config/electron-production-distribution.cjs';
import { resolveSignedMacOSBundleVersion } from '../macos-bundle-version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = /^[a-f0-9]{40}$/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const fail = reason => { throw Object.assign(new Error('MACOS_QUALIFICATION_IDENTITY_REFUSED'), { reason }); };

/** Use the existing source-preparation receipt; never allocate a build here. */
export function deriveMacOSQualificationIdentity({ sourceCandidate, sourceRevision, target,
  packageVersion, sourceVersion, resolveBundleVersion = resolveSignedMacOSBundleVersion } = {}) {
  if (!plain(sourceCandidate) || !['darwin-arm64', 'darwin-x64'].includes(target)
    || typeof sourceRevision !== 'string' || !SOURCE.test(sourceRevision)
    || sourceCandidate.schemaVersion !== 'tibotattle-electron-production-source-candidate-v1'
    || sourceCandidate.status !== 'production_source_staged'
    || Object.hasOwn(sourceCandidate, 'packagingProfile') || Object.hasOwn(sourceCandidate, 'rehearsal')) fail('source_candidate');
  if (typeof packageVersion !== 'string' || sourceVersion !== packageVersion
    || sourceCandidate.version !== packageVersion) fail('version');
  const bundleVersion = resolveBundleVersion(packageVersion, 'stable');
  if (bundleVersion === null) fail('bundle_allocation');
  const { buildNumber } = sourceCandidate;
  if (typeof buildNumber !== 'string' || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)) fail('build_number');
  if (sourceCandidate.sourceRevision !== sourceRevision || sourceCandidate.target !== target
    || sourceCandidate.updateFeed !== distribution.productionElectronFeedForTarget(target)) fail('source_candidate');
  const environment = sourceCandidate.builderEnvironment;
  if (!plain(environment) || Object.keys(environment).length !== 4
    || environment.TIBOTATTLE_ELECTRON_SOURCE_REVISION !== sourceRevision
    || environment.TIBOTATTLE_ELECTRON_BUILD_NUMBER !== buildNumber
    || environment.TIBOTATTLE_ELECTRON_TARGET !== target
    || environment.TIBOTATTLE_ELECTRON_VERSION !== packageVersion) fail('builder_identity');
  return Object.freeze({ version: packageVersion, bundleVersion, buildNumber, sourceRevision, target });
}

export function assertMacOSQualificationIdentity(identity, context) {
  if (!plain(identity)) fail('intake');
  const expected = deriveMacOSQualificationIdentity(context);
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key] !== value) fail(key);
  }
  return expected;
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000,
      maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { fail('source_checkout'); }
}

/** Keep the qualification runner distinct from the frozen application source. */
export function preflightMacOSQualification({ identity, sourceCandidate, runnerRevision,
  sourceRevision, target, repositoryRoot = ROOT } = {}) {
  if (typeof runnerRevision !== 'string' || !SOURCE.test(runnerRevision)
    || typeof sourceRevision !== 'string' || !SOURCE.test(sourceRevision)
    || git(repositoryRoot, ['rev-parse', 'HEAD']) !== runnerRevision) fail('runner_revision');
  git(repositoryRoot, ['merge-base', '--is-ancestor', sourceRevision, runnerRevision]);
  let current, source;
  try {
    current = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    source = JSON.parse(git(repositoryRoot, ['show', `${sourceRevision}:package.json`]));
  } catch { fail('package_manifest'); }
  if (![current, source].every(value => value?.name === 'app-usagemonitor' && value.type === 'module')) fail('package_manifest');
  // Detect a changed working-tree manifest without rejecting unrelated private
  // output directories. The workflow checkout itself is pinned to runnerRevision.
  if (git(repositoryRoot, ['show', `${runnerRevision}:package.json`]) !==
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8').trim()) fail('package_manifest');
  return assertMacOSQualificationIdentity(identity, { sourceCandidate, sourceRevision, target,
    packageVersion: current.version, sourceVersion: source.version });
}

/** Existing workflow JSON envelopes carry the source receipt without expanding
 * the harness intake, or creating another release/build-number ledger. */
export function parseMacOSQualificationEnvelope(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 64 * 1024) fail('intake_size');
  let envelope;
  try { envelope = JSON.parse(serialized); } catch { fail('intake'); }
  if (!plain(envelope) || !plain(envelope.sourceCandidate)) fail('source_candidate');
  const { sourceCandidate, ...identity } = envelope;
  return { identity, sourceCandidate };
}

export function preflightMacOSQualificationEnvironment(lane, environment = process.env) {
  const keys = {
    'empty-profile': ['runnerRevision', 'target', 'sourceRevision', 'version', 'bundleVersion', 'buildNumber', 'dmgSha256', 'asarSha256'],
    sparkle: ['version', 'bundleVersion', 'buildNumber'],
    'production-update': ['schemaVersion', 'target', 'sourceRevision', 'buildNumber', 'version', 'bundleVersion',
      'dmgSha256', 'asarSha256', 'zipSha256', 'feedSha256', 'predecessorAsarSha256'],
  }[lane];
  if (!keys) fail('lane');
  const { identity, sourceCandidate } = parseMacOSQualificationEnvelope(
    lane === 'empty-profile' ? environment.EMPTY_PROFILE_INTAKE : environment.SELECTED_IDENTITY);
  if (Object.keys(identity).length !== keys.length || !keys.every(key => typeof identity[key] === 'string')
    || Object.entries(identity).some(([key, value]) => key.endsWith('Sha256') && !/^[a-f0-9]{64}$/u.test(value))) fail('intake');
  if (lane === 'production-update' && identity.schemaVersion !== 'tibotattle-production-electron-update-intake-v1') fail('intake');
  const runnerRevision = lane === 'empty-profile' ? identity.runnerRevision : environment.SELECTED_RUNNER;
  const sourceRevision = lane === 'sparkle' ? environment.SELECTED_SOURCE : identity.sourceRevision;
  if (runnerRevision !== environment.GITHUB_SHA) fail('runner_revision');
  preflightMacOSQualification({
    identity: lane === 'sparkle' ? { ...identity, sourceRevision, target: environment.SELECTED_TARGET } : identity,
    sourceCandidate, sourceRevision, runnerRevision, target: environment.SELECTED_TARGET,
  });
  return identity;
}
