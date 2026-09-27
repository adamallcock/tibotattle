// Dependency-free admission before package installation or artifact download.
import { credentialFixtureRoot } from '../prepare-electron-macos-credential-fixture.mjs';
import { compareAppleMacOSBundleVersions, resolveSignedMacOSBundleVersion } from '../macos-bundle-version.js';
import { parseMacOSQualificationEnvelope, preflightMacOSQualification } from './electron-macos-qualification-identity.mjs';
export const MAC_CREDENTIAL_CONFIRMATION = 'RUN_DISPOSABLE_SIGNED_MAC_CREDENTIALS';
export const MAC_CREDENTIAL_SCHEMA = 'signed-macos-credential-qualification-v1';
export const MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA = 'signed-macos-credential-qualification-v2-current-stable';
export const MAC_CREDENTIAL_SUCCESSOR_026_SCHEMA = 'signed-macos-credential-qualification-v3-current-stable-026';
const SCHEMA = MAC_CREDENTIAL_SCHEMA, HASH = /^[a-f0-9]{64}$/u;
const CURRENT_STABLE = Object.freeze({
  version: '0.1.24', sourceRevision: 'b6fe68e4912bebbe6dcf7dc9fd43e877451dd133',
  buildNumber: '2026092202', bundleVersion: '1032',
  dmgSha256: 'f77f4e466c3be68209205a01866bbaf66650012cb40d2233d4fde53b9e767969',
  asarSha256: 'c061f3af2b54ffacedc9a4c0a3561d82cd25873fac0c11eecb6cd46f6f704833',
});
const SUCCESSOR_025 = Object.freeze({
  version: '0.1.25', sourceRevision: 'fec5b6039ea9efbc7948f0785bb40240cd0748ea',
  buildNumber: '2026092601', bundleVersion: '1033',
  dmgSha256: '6b09cbc3e97864d67ed6f7b24c99b5847c1cb91c525e5a22de73164263ec72b2',
  asarSha256: '654a351a5ba08eb749b5b53fc98bdafc4123b2fe2485385400dccfe2c561bdc5',
});
const SUCCESSOR_026 = Object.freeze({
  version: '0.1.26', sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
  buildNumber: '2026092701', bundleVersion: '1034',
  dmgSha256: '7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec',
  asarSha256: '6d02d1acffbc4feaf8e91162a2fe67663815bdbd92ae431abef20fdbf2ffc81e',
});
const fail = stage => { throw Object.assign(new Error('MAC_CREDENTIAL_QUALIFICATION_REFUSED'), { credentialStage: stage }); };

export function validateMacCredentialIntake(value) {
  const successor = value?.schemaVersion === MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA ? SUCCESSOR_025
    : value?.schemaVersion === MAC_CREDENTIAL_SUCCESSOR_026_SCHEMA ? SUCCESSOR_026 : null;
  const candidateKeys = ['runnerRevision', 'target', 'sourceRevision', 'version', 'bundleVersion', 'buildNumber', 'dmgSha256', 'asarSha256'];
  const keys = [...candidateKeys, 'schemaVersion', 'operationId', 'fixtureArchiveSha256', 'fixtureExecutableSha256', 'predecessorAsarSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.sort().join() || !keys.every(k => typeof value[k] === 'string')
    || ![SCHEMA, MAC_CREDENTIAL_CURRENT_STABLE_SCHEMA, MAC_CREDENTIAL_SUCCESSOR_026_SCHEMA].includes(value.schemaVersion)
    || value.target !== 'darwin-arm64' || !['fixtureArchiveSha256', 'fixtureExecutableSha256', 'predecessorAsarSha256'].every(k => typeof value[k] === 'string' && HASH.test(value[k]))) fail('intake');
  if (!['runnerRevision', 'sourceRevision'].every(k => /^[a-f0-9]{40}$/u.test(value[k]))
    || !['dmgSha256', 'asarSha256'].every(k => HASH.test(value[k]))
    || value.bundleVersion !== resolveSignedMacOSBundleVersion(value.version, 'stable')
    || compareAppleMacOSBundleVersions('1026', value.bundleVersion) !== -1
    || !/^[1-9][0-9]{0,9}$/u.test(value.buildNumber)
    || (successor !== null
      && (value.predecessorAsarSha256 !== CURRENT_STABLE.asarSha256
        || Object.entries(successor).some(([key, expected]) => value[key] !== expected)))) fail('intake');
  const filename = `TiboTattle-${value.version}-mac-arm64.dmg`;
  const candidate = Object.freeze({ ...Object.fromEntries(candidateKeys.map(k => [k, value[k]])), architecture: 'arm64', filename,
    url: `https://updates.tibotattle.com/electron/test/native-sparkle/${value.sourceRevision}/${value.bundleVersion}/${value.dmgSha256}/${filename}` });
  const fixtureRoot = credentialFixtureRoot(value.operationId);
  const predecessor = successor !== null
    ? CURRENT_STABLE
    : Object.freeze({ version: '0.1.20', dmgSha256: '50a1b89aff696ef3323ab48284aa820af7aad504397fbe88831c29ace2479f30',
      asarSha256: value.predecessorAsarSha256 });
  return Object.freeze({ ...value, candidate, fixtureRoot, predecessor,
    fixtureUrl: `https://updates.tibotattle.com/electron/test/mac-credentials/${value.runnerRevision}/${value.operationId}/${value.fixtureArchiveSha256}/fixture.zip`,
    predecessorUrl: `https://github.com/adamallcock/tibotattle/releases/download/v${predecessor.version}/TiboTattle-${predecessor.version}-mac-arm64.dmg` });
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
