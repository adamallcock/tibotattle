// Dependency-free admission before package installation or artifact download.
import { credentialFixtureRoot } from '../prepare-electron-macos-credential-fixture.mjs';
import { compareAppleMacOSBundleVersions, resolveSignedMacOSBundleVersion } from '../macos-bundle-version.js';
import { parseMacOSQualificationEnvelope, preflightMacOSQualification } from './electron-macos-qualification-identity.mjs';
export const MAC_CREDENTIAL_CONFIRMATION = 'RUN_DISPOSABLE_SIGNED_MAC_CREDENTIALS';
export const MAC_CREDENTIAL_SCHEMA = 'signed-macos-credential-qualification-v1';
const SCHEMA = MAC_CREDENTIAL_SCHEMA, HASH = /^[a-f0-9]{64}$/u;
const fail = stage => { throw Object.assign(new Error('MAC_CREDENTIAL_QUALIFICATION_REFUSED'), { credentialStage: stage }); };

export function validateMacCredentialIntake(value) {
  const candidateKeys = ['runnerRevision', 'target', 'sourceRevision', 'version', 'bundleVersion', 'buildNumber', 'dmgSha256', 'asarSha256'];
  const keys = [...candidateKeys, 'schemaVersion', 'operationId', 'fixtureArchiveSha256', 'fixtureExecutableSha256', 'predecessorAsarSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.sort().join() || !keys.every(k => typeof value[k] === 'string') || value.schemaVersion !== SCHEMA
    || value.target !== 'darwin-arm64' || !['fixtureArchiveSha256', 'fixtureExecutableSha256', 'predecessorAsarSha256'].every(k => typeof value[k] === 'string' && HASH.test(value[k]))) fail('intake');
  if (!['runnerRevision', 'sourceRevision'].every(k => /^[a-f0-9]{40}$/u.test(value[k]))
    || !['dmgSha256', 'asarSha256'].every(k => HASH.test(value[k]))
    || value.bundleVersion !== resolveSignedMacOSBundleVersion(value.version, 'stable')
    || compareAppleMacOSBundleVersions('1026', value.bundleVersion) !== -1
    || !/^[1-9][0-9]{0,9}$/u.test(value.buildNumber)) fail('intake');
  const filename = `TiboTattle-${value.version}-mac-arm64.dmg`;
  const candidate = Object.freeze({ ...Object.fromEntries(candidateKeys.map(k => [k, value[k]])), architecture: 'arm64', filename,
    url: `https://updates.tibotattle.com/electron/test/native-sparkle/${value.sourceRevision}/${value.bundleVersion}/${value.dmgSha256}/${filename}` });
  const fixtureRoot = credentialFixtureRoot(value.operationId);
  return Object.freeze({ ...value, candidate, fixtureRoot,
    fixtureUrl: `https://updates.tibotattle.com/electron/test/mac-credentials/${value.runnerRevision}/${value.operationId}/${value.fixtureArchiveSha256}/fixture.zip`,
    predecessorUrl: 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.20/TiboTattle-0.1.20-mac-arm64.dmg' });
}
export function parseMacCredentialArguments(args) {
  if (args.length === 1 && args[0] === '--plan') return { execute: false };
  if (args.length !== 3 || args[0] !== '--execute' || args[1] !== '--confirm' || args[2] !== MAC_CREDENTIAL_CONFIRMATION) fail('confirmation');
  return { execute: true };
}

export function preflightMacCredentialEnvironment(environment = process.env, { repositoryRoot } = {}) {
  const { identity, sourceCandidate } = parseMacOSQualificationEnvelope(environment.MAC_CREDENTIAL_INTAKE);
  validateMacCredentialIntake(identity);
  if (identity.runnerRevision !== environment.GITHUB_SHA) fail('runner_revision');
  if (!['plan', 'execute'].includes(environment.SELECTED_MODE)
    || environment.SELECTED_CONFIRMATION !== (environment.SELECTED_MODE === 'execute' ? MAC_CREDENTIAL_CONFIRMATION : '')) fail('confirmation');
  preflightMacOSQualification({ identity, sourceCandidate, runnerRevision: identity.runnerRevision,
    sourceRevision: identity.sourceRevision, target: identity.target, ...(repositoryRoot ? { repositoryRoot } : {}) });
  return identity;
}
