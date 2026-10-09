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

// Historical v1 remains the 0.1.20 route, including the signed credential lane.
// v2 retains the exact 0.1.26 -> 0.1.27 production-feed route.
// v3 separately admits the replacement 0.1.28 and its allocated provenance build.
// 0.1.26 DMGs/source are pinned by the immutable published manifest:
// https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json
// SHA-256 be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc.
// Bundle/build metadata is also checked inside the signed, digest-verified DMG.
const PRODUCTION_UPDATE_PREDECESSORS = Object.freeze({
  'tibotattle-production-electron-update-intake-v1': Object.freeze({
    version: '0.1.20', sourceRevision: 'f518126a05a6d165b9617f6417a87219d7047273',
    buildNumber: '2026091104', bundleVersion: '2026091104',
    dmgSha256: Object.freeze({
      'darwin-arm64': '50a1b89aff696ef3323ab48284aa820af7aad504397fbe88831c29ace2479f30',
      'darwin-x64': 'a63ec06036ddbc5a0e70dc59c6520a8ad5baa8c7a3a0fc4d3713a7f1f1523ecd',
    }),
  }),
  'tibotattle-production-electron-update-intake-v2': Object.freeze({
    version: '0.1.26', sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
    buildNumber: '2026092701', bundleVersion: '1034', successorVersion: '0.1.27',
    dmgSha256: Object.freeze({
      'darwin-arm64': '7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec',
      'darwin-x64': '3806a1ce2650350b69faff759287c08a5f146acfb9c26e3b3b04abb5cf8896c3',
    }),
  }),
  'tibotattle-production-electron-update-intake-v3': Object.freeze({
    version: '0.1.26', sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
    buildNumber: '2026092701', bundleVersion: '1034', successorVersion: '0.1.28',
    successorBuildNumber: '2026100901',
    dmgSha256: Object.freeze({
      'darwin-arm64': '7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec',
      'darwin-x64': '3806a1ce2650350b69faff759287c08a5f146acfb9c26e3b3b04abb5cf8896c3',
    }),
  }),
});

export function resolveMacOSProductionUpdatePredecessor({ schemaVersion, version, buildNumber } = {}) {
  if (typeof schemaVersion !== 'string' || !Object.hasOwn(PRODUCTION_UPDATE_PREDECESSORS, schemaVersion)) fail('update_profile');
  const predecessor = PRODUCTION_UPDATE_PREDECESSORS[schemaVersion];
  if (predecessor.successorVersion && version !== predecessor.successorVersion) fail('update_profile');
  if (predecessor.successorBuildNumber && buildNumber !== predecessor.successorBuildNumber) fail('update_profile');
  return predecessor;
}

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
  if (lane === 'production-update') resolveMacOSProductionUpdatePredecessor(identity);
  const runnerRevision = lane === 'empty-profile' ? identity.runnerRevision : environment.SELECTED_RUNNER;
  const sourceRevision = lane === 'sparkle' ? environment.SELECTED_SOURCE : identity.sourceRevision;
  if (runnerRevision !== environment.GITHUB_SHA) fail('runner_revision');
  preflightMacOSQualification({
    identity: lane === 'sparkle' ? { ...identity, sourceRevision, target: environment.SELECTED_TARGET } : identity,
    sourceCandidate, sourceRevision, runnerRevision, target: environment.SELECTED_TARGET,
  });
  return identity;
}
