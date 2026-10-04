// Exact signed predecessor -> exact signed successor NSIS replacement. Uses one
// owned profile and the normal UI journey; it does not exercise electron-updater.
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readdir, rm, rmdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  assertWindowsSignedInstalledPath as safePath,
  readWindowsSignedInstalledEvidence as boundedEvidence,
  digestWindowsSignedInstalledFile as digest,
  verifyWindowsSignedInstalledSignature as signature,
  inspectWindowsSignedInstalledRegistry as registry,
  cleanWindowsSignedInstalledUninstallerResidue as cleanUninstallerResidue,
  parseWindowsSignedInstalledArguments, signedInstalledCleanupEligible,
} from './smoke-electron-windows-signed-installed.mjs';
import {
  assertCandidateProcessAbsence, installOutboundFirewallBlock, removeOutboundFirewallBlock,
  launchAndRenderCandidate, prepareWindowsNormalCandidateProfile,
  seedWindowsNormalCandidateCodexFixture, verifyWindowsNormalCandidateOptOut,
  verifyWindowsNormalCandidateSmokePackage,
} from './smoke-electron-windows-normal-candidate.mjs';
import {
  prepareWindowsDevelopmentProfile, WINDOWS_ELECTRON_BINDING_RELATIVE_PATH,
  WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH,
} from './launch-electron-windows-development.mjs';
import {
  assertPinnedNsisSilentInstallDoesNotAutoRun, buildWindowsNsisInstallArguments,
  buildWindowsNsisUninstallArguments, runWindowsNsisLifecycleProgram,
} from './smoke-electron-windows-nsis-lifecycle.mjs';

const PREFIX = 'ELECTRON_WINDOWS_FINAL_UPGRADE_';
const SHA256 = /^[0-9a-f]{64}$/u;
const APP = 'TiboTattle.exe';
const UNINSTALLER = 'Uninstall TiboTattle.exe';
const fail = code => { throw Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` }); };
const fixedCode = error => /^ELECTRON_WINDOWS_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : `${PREFIX}FAILED`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const successful = result => result?.settled === true && result.timedOut === false && result.exitCode === 0;
export const WINDOWS_FINAL_UPGRADE_PREDECESSOR = Object.freeze({
  schemaVersion: 'tibotattle-windows-final-upgrade-predecessor-v1',
  version: '0.1.26',
  target: 'win32-x64',
  sourceRevision: 'acfc385c95b49b8e1040cedfa857659b49a61d8d',
  manifestSha256: 'be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc',
  installerSha256: 'c8d4bb4f533cd3688a738d6b2851bb9292642e8889ac944eb37dcea3b7026957',
  installerBytes: 101301024,
});
export const WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE = 'TiboTattle-0.1.26-Windows-x64.exe';
const PREDECESSOR_RELEASE = 'https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/';

/** Caller-supplied URLs, alternative releases, extra fields and inferred versions
 * are not intake. A new predecessor needs its own reviewed public evidence. */
export function validateWindowsFinalUpgradePredecessor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== Object.keys(WINDOWS_FINAL_UPGRADE_PREDECESSOR).length
      || Object.entries(WINDOWS_FINAL_UPGRADE_PREDECESSOR).some(([key, expected]) => value[key] !== expected)) {
    fail('PREDECESSOR_INTAKE_INVALID');
  }
  return WINDOWS_FINAL_UPGRADE_PREDECESSOR;
}
export function parseWindowsFinalUpgradeMode({ qualifyInstalled, qualifyUpgrade, predecessorIntake } = {}) {
  if (!['true', 'false', ''].includes(qualifyUpgrade ?? '')
      || !['true', 'false', ''].includes(qualifyInstalled ?? '')) fail('MODE_INVALID');
  if (qualifyUpgrade !== 'true') {
    if (predecessorIntake !== undefined && predecessorIntake !== '') fail('MODE_INVALID');
    return null;
  }
  if (qualifyInstalled !== 'true' || typeof predecessorIntake !== 'string'
      || Buffer.byteLength(predecessorIntake) > 4096) fail('MODE_INVALID');
  let value;
  try { value = JSON.parse(predecessorIntake); } catch { fail('PREDECESSOR_INTAKE_INVALID'); }
  return validateWindowsFinalUpgradePredecessor(value);
}
export function validateWindowsFinalUpgradePredecessorManifest(bytes, intake) {
  validateWindowsFinalUpgradePredecessor(intake);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 5866 || hash(bytes) !== intake.manifestSha256) {
    fail('PREDECESSOR_MANIFEST_INVALID');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('PREDECESSOR_MANIFEST_INVALID'); }
  const rows = manifest.artifacts?.filter(row => row.platform === 'windows' && row.architecture === 'x64');
  const row = rows?.[0];
  if (manifest.schemaVersion !== 'usage-monitor-release-evidence-v1' || manifest.version !== intake.version
      || manifest.tag !== 'v0.1.26' || manifest.commit !== intake.sourceRevision
      || manifest.repository !== 'https://github.com/adamallcock/tibotattle'
      || rows?.length !== 1 || row.version !== intake.version || row.sha256 !== intake.installerSha256
      || row.bytes !== intake.installerBytes || row.fileName !== WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE
      || row.downloadUrl !== `${PREDECESSOR_RELEASE}${WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE}`
      || row.format !== 'exe' || row.distribution !== 'github-release' || row.channel !== 'direct'
      || row.source?.commit !== intake.sourceRevision || row.source?.tag !== 'v0.1.26'
      || row.source?.version !== intake.version || row.nativeTrust?.publisher !== 'Adam Allcock'
      || row.assurances?.authenticodeSigned !== true || row.assurances?.timestamped !== true) {
    fail('PREDECESSOR_MANIFEST_INVALID');
  }
  return intake;
}

function normalOptions(options, appPath) {
  return { appPath, stagedAppPath: options.stagedAppPath,
    sourceCandidatePath: options.sourceCandidatePath, sourceRevision: options.sourceRevision };
}
function validateIdentity(identity, selected) {
  if (identity?.sourceRevision !== selected.sourceRevision || identity.target !== 'win32-x64'
      || !SHA256.test(identity.artifactSha256 ?? '') || !SHA256.test(identity.executableSha256 ?? '')
      || identity.artifactSha256 !== selected.expectedAsarSha256
      || identity.executableSha256 !== selected.expectedExecutableSha256
      || !SHA256.test(identity.native?.windowsFilesystemSha256 ?? '')
      || !SHA256.test(identity.native?.keytarSha256 ?? '')) fail('PACKAGE_IDENTITY_INVALID');
  return identity;
}
function validateJourney(journey, candidateState) {
  if (candidateState.quiescent !== true || !Array.isArray(candidateState.tracked)
      || candidateState.tracked.length < 2
      || ['dashboardRendered', 'localRefreshObserved', 'syntheticIngestionVerified',
        'projectsAndThreadsVerified', 'sharingOptOutRetained', 'settingsPersisted', 'cleanQuit']
        .some(key => journey?.[key] !== true)
      || !['succeeded', 'degraded'].includes(journey.localRefreshTerminal)) fail('NORMAL_JOURNEY_UNPROVEN');
}

/** Names and hashes remain private in memory. Only equality/counts enter the
 * receipt. With no app processes alive, NSIS must not change this owned profile. */
export async function snapshotWindowsFinalUpgradeProfile(root, {
  inspect = lstat, entries = readdir, digestFile = digest,
} = {}) {
  const rows = []; let total = 0;
  async function visit(directory, relative = '') {
    const info = await inspect(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROFILE_UNSAFE');
    const children = await entries(directory, { withFileTypes: true });
    for (const item of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.name || /[\\/\0]/u.test(item.name) || ['.', '..'].includes(item.name)) fail('PROFILE_UNSAFE');
      const name = relative ? `${relative}/${item.name}` : item.name;
      const target = win32.join(directory, item.name);
      const metadata = await inspect(target, { bigint: true });
      if (metadata.isSymbolicLink()) fail('PROFILE_UNSAFE');
      if (metadata.isDirectory()) {
        rows.push([name, 'directory']);
        if (rows.length > 8192) fail('PROFILE_LIMIT');
        await visit(target, name);
      } else {
        if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 64n * 1024n * 1024n) fail('PROFILE_UNSAFE');
        total += Number(metadata.size);
        if (total > 256 * 1024 * 1024 || rows.length >= 8192) fail('PROFILE_LIMIT');
        rows.push([name, Number(metadata.size), await digestFile(target)]);
      }
    }
    const after = await inspect(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || ['dev', 'ino', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== info[key])) fail('PROFILE_CHANGED');
  }
  await visit(root);
  if (!rows.length) fail('PROFILE_EMPTY');
  return Object.freeze({ sha256: hash(JSON.stringify(rows)), entries: rows.length, bytes: total });
}

/** The synthetic injection boundary tests ordering/refusal; native callers use
 * these defaults. Replacing files precedes successor runtime, with no reseeding. */
export async function runWindowsFinalUpgradeContinuity({ previous, candidate, appPath,
  profile, seed, environment, candidateState, replaceInstaller }, {
  verifyPackage = verifyWindowsNormalCandidateSmokePackage,
  launchJourney = launchAndRenderCandidate, verifyOptOut = verifyWindowsNormalCandidateOptOut,
  processAbsence = assertCandidateProcessAbsence, snapshotProfile = snapshotWindowsFinalUpgradeProfile,
} = {}) {
  const oldOptions = normalOptions(previous, appPath), newOptions = normalOptions(candidate, appPath);
  const oldIdentity = validateIdentity(await verifyPackage(oldOptions), previous);
  const first = await launchJourney({ appPath, profile, environment, changeSettings: true, candidateState });
  validateJourney(first, candidateState);
  // The launch helper retains PID + creation identity for the main process and
  // every observed companion/renderer descendant, including reparented ones.
  await processAbsence({ appPath, environment, tracked: candidateState.tracked });
  if (await verifyOptOut(seed) !== true) fail('OPT_OUT_UNPROVEN');
  if (JSON.stringify(await verifyPackage(oldOptions)) !== JSON.stringify(oldIdentity)) fail('PREDECESSOR_BYTES_CHANGED');
  const profileBefore = await snapshotProfile(profile.root);
  await replaceInstaller();
  const profileAfter = await snapshotProfile(profile.root);
  if (JSON.stringify(profileBefore) !== JSON.stringify(profileAfter)) fail('PROFILE_CHANGED_BY_INSTALLER');
  const newIdentity = validateIdentity(await verifyPackage(newOptions), candidate);
  if (oldIdentity.artifactSha256 === newIdentity.artifactSha256) fail('SUCCESSOR_BYTES_UNCHANGED');
  // Runtime may migrate schemas/caches. Its observed totals/settings/opt-out,
  // rather than byte equality after launch, establish semantic continuity.
  for (let index = 0; index < 2; index += 1) {
    const journey = await launchJourney({ appPath, profile, environment, changeSettings: false, candidateState });
    validateJourney(journey, candidateState);
    await processAbsence({ appPath, environment, tracked: candidateState.tracked });
    if (await verifyOptOut(seed) !== true) fail('OPT_OUT_UNPROVEN');
    if (JSON.stringify(await verifyPackage(newOptions)) !== JSON.stringify(newIdentity)) fail('SUCCESSOR_BYTES_CHANGED');
  }
  return Object.freeze({ predecessorIdentity: oldIdentity, successorIdentity: newIdentity,
    predecessorNormalJourney: true, predecessorOwnedProcessesExited: true,
    profileUnchangedAcrossInstaller: true, preservedProfileEntries: profileBefore.entries,
    syntheticHistoryRetainedAcrossUpgrade: true, projectsAndThreadsRetainedAcrossUpgrade: true,
    settingsRetainedAcrossUpgrade: true, durableOptOutRetainedAcrossUpgrade: true,
    successorNormalJourney: true, successorColdRestart: true, successorOwnedProcessesExited: true });
}

function validateOptions(options) {
  for (const selected of [options?.candidate, options?.predecessor]) {
    parseWindowsSignedInstalledArguments(['--execute', '--installer', selected?.installerPath,
      '--installer-sha256', selected?.installerSha256, '--staged-app', selected?.stagedAppPath,
      '--source-candidate', selected?.sourceCandidatePath, '--source-revision', selected?.sourceRevision,
      '--receipt', options?.receiptPath]);
    if (!SHA256.test(selected.expectedAsarSha256 ?? '')
        || !SHA256.test(selected.expectedExecutableSha256 ?? '')) fail('PACKAGE_IDENTITY_INVALID');
  }
  const intake = validateWindowsFinalUpgradePredecessor(options?.predecessorIntake);
  if (options.predecessor.sourceRevision !== intake.sourceRevision
      || options.predecessor.installerSha256 !== intake.installerSha256
      || options.candidate.sourceRevision === intake.sourceRevision
      || options.candidate.installerSha256 === intake.installerSha256
      || options.predecessor.installerPath === options.candidate.installerPath
      || options.predecessor.stagedAppPath === options.candidate.stagedAppPath) fail('PAIR_INVALID');
  return intake;
}
async function safeOwnedRoot(root, identity) {
  await safePath(root, true);
  const current = await lstat(root, { bigint: true });
  if (current.dev !== identity.dev || current.ino !== identity.ino) fail('OWNERSHIP_CHANGED');
}

export async function runWindowsFinalUpgrade(options, {
  platform = process.platform, architecture = process.arch, environment = process.env,
  runProgram = runWindowsNsisLifecycleProgram,
} = {}) {
  if (platform !== 'win32' || architecture !== 'x64' || process.version !== 'v26.2.0'
      || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    fail('DISPOSABLE_WINDOWS_REQUIRED');
  }
  const intake = validateOptions(options);
  await safePath(environment.RUNNER_TEMP, true);
  await safePath(win32.dirname(options.receiptPath), true);
  validateWindowsFinalUpgradePredecessorManifest(await boundedEvidence(options.predecessorManifestPath, 64 * 1024), intake);
  const receiptHandle = await open(options.receiptPath, 'wx', 0o600);
  const receipt = { schemaVersion: 'tibotattle-windows-final-upgrade-v1', status: 'failed',
    sourceRevision: options.candidate.sourceRevision, installerSha256: options.candidate.installerSha256,
    predecessor: intake, referenceOrigin: 'extracted_from_exact_signed_installers',
    independentPreSigningStage: false, rebuilt: false, resigned: false, published: false,
    signedPredecessorVerified: false, signedSuccessorVerified: false,
    predecessorSignedClosureVerified: false, successorSignedClosureVerified: false,
    predecessorInstallation: false, installerReplacement: false, continuity: null,
    uninstall: false, outboundFirewallRuleRemoved: false, ownedProfileRemoved: false, cleanup: false,
    automaticUpdaterReplacement: 'not_exercised',
    credentialPersistence: 'not_requalified_by_this_normal_journey',
    hostedEnrollment: 'not_exercised', notificationDelivery: 'requires_user_test', productionReady: false };
  let root = null, rootIdentity = null, installRoot = null, appPath = null, profile = null;
  let profileIdentity = null;
  let firewallName = null, installAttempted = false, installSettled = false, errorCode = null;
  const candidateState = { quiescent: true, tracked: null };
  const sourceBytes = new Map();
  async function install(selected) {
    await safeOwnedRoot(root, rootIdentity);
    await assertCandidateProcessAbsence({ appPath, environment, tracked: candidateState.tracked, runProgram });
    if (await digest(selected.installerPath) !== selected.installerSha256) fail('INSTALLER_CHANGED');
    await signature(selected.installerPath, environment, runProgram);
    installAttempted = true; installSettled = false;
    const result = await runProgram(selected.installerPath, buildWindowsNsisInstallArguments(installRoot),
      { environment, timeoutMs: 300_000 });
    installSettled = result?.settled === true && result.timedOut === false;
    if (!successful(result)) fail('INSTALL_FAILED');
    if (await registry(installRoot, environment, runProgram) !== 'expected-v1') fail('INSTALL_REGISTRY_INVALID');
    for (const target of [appPath, win32.join(installRoot, UNINSTALLER),
      win32.join(installRoot, 'resources', 'app.asar.unpacked', WINDOWS_ELECTRON_BINDING_RELATIVE_PATH),
      win32.join(installRoot, 'resources', 'app.asar.unpacked', WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH)]) {
      await signature(target, environment, runProgram);
    }
  }
  try {
    for (const [key, selected] of [['predecessor', options.predecessor], ['candidate', options.candidate]]) {
      sourceBytes.set(key, await boundedEvidence(selected.sourceCandidatePath, 128 * 1024));
      const staged = JSON.parse((await boundedEvidence(win32.join(selected.stagedAppPath, 'package.json'), 128 * 1024)).toString('utf8'));
      if (staged.version !== (key === 'predecessor' ? '0.1.26' : '0.1.27')
          || staged.tibotattleDistribution?.sourceRevision !== selected.sourceRevision
          || staged.tibotattleDistribution?.target !== 'win32-x64') fail('PAIR_INVALID');
      if (await digest(selected.installerPath) !== selected.installerSha256) fail('INSTALLER_HASH_MISMATCH');
      if (key === 'predecessor' && (await lstat(selected.installerPath)).size !== intake.installerBytes) fail('PREDECESSOR_SIZE_INVALID');
      await signature(selected.installerPath, environment, runProgram);
      receipt[key === 'predecessor' ? 'signedPredecessorVerified' : 'signedSuccessorVerified'] = true;
    }
    receipt.predecessorSourceCandidateSha256 = hash(sourceBytes.get('predecessor'));
    receipt.sourceCandidateSha256 = hash(sourceBytes.get('candidate'));
    if (await assertPinnedNsisSilentInstallDoesNotAutoRun() !== true) fail('NSIS_TEMPLATE_UNVERIFIED');
    root = await mkdtemp(win32.join(environment.RUNNER_TEMP, 'tibotattle-final-upgrade-'));
    await safePath(root, true); rootIdentity = await lstat(root, { bigint: true });
    installRoot = win32.join(root, 'app'); appPath = win32.join(installRoot, APP);
    if (await registry(installRoot, environment, runProgram) !== 'absent-v1') fail('REGISTRY_DIRTY');
    await install(options.predecessor);
    receipt.predecessorInstallation = true;
    profile = await prepareWindowsDevelopmentProfile({ appPath, profilePath: win32.join(root, 'profile') });
    profileIdentity = await lstat(profile.root, { bigint: true });
    await seedWindowsNormalCandidateCodexFixture({ profile });
    const seed = await prepareWindowsNormalCandidateProfile({ profile, stagedAppPath: options.predecessor.stagedAppPath });
    firewallName = await installOutboundFirewallBlock({ appPath, environment });
    receipt.continuity = await runWindowsFinalUpgradeContinuity({ previous: options.predecessor,
      candidate: options.candidate, appPath, profile, seed, environment, candidateState,
      replaceInstaller: async () => {
        if (candidateState.quiescent !== true) fail('PREDECESSOR_PROCESS_REMAINS');
        if (await registry(installRoot, environment, runProgram) !== 'expected-v1') fail('UPGRADE_OWNERSHIP_UNPROVEN');
        await install(options.candidate);
        receipt.installerReplacement = true;
      } }, { snapshotProfile: async selected => {
        if (selected !== profile.root) fail('OWNERSHIP_CHANGED');
        await safeOwnedRoot(profile.root, profileIdentity);
        return snapshotWindowsFinalUpgradeProfile(profile.root);
      } });
    // Positive closure claims require the package verifier, not signatures alone.
    receipt.predecessorSignedClosureVerified = true;
    receipt.successorSignedClosureVerified = true;
    for (const [key, selected] of [['predecessor', options.predecessor], ['candidate', options.candidate]]) {
      if (!(await boundedEvidence(selected.sourceCandidatePath, 128 * 1024)).equals(sourceBytes.get(key))) fail('SOURCE_CANDIDATE_CHANGED');
    }
  } catch (error) { errorCode = fixedCode(error); }
  finally {
    if (signedInstalledCleanupEligible({ installAttempted, installSettled, safeToUninstall: candidateState.quiescent })) {
      try {
        await safeOwnedRoot(root, rootIdentity);
        await assertCandidateProcessAbsence({ appPath, environment, tracked: candidateState.tracked, runProgram });
        if (await registry(installRoot, environment, runProgram) !== 'expected-v1') fail('UNINSTALL_OWNERSHIP_UNPROVEN');
        const uninstaller = win32.join(installRoot, UNINSTALLER), uninstallerDigest = await digest(uninstaller);
        await signature(uninstaller, environment, runProgram);
        if (!successful(await runProgram(uninstaller, buildWindowsNsisUninstallArguments(installRoot),
          { environment, timeoutMs: 120_000 }))) fail('UNINSTALL_FAILED');
        if (await registry(installRoot, environment, runProgram) !== 'absent-v1') fail('UNINSTALL_REGISTRY_REMAINS');
        await cleanUninstallerResidue(installRoot, uninstallerDigest);
        receipt.uninstall = true;
      } catch (error) { errorCode ??= fixedCode(error); }
    }
    if (firewallName !== null && candidateState.quiescent === true && installSettled) {
      receipt.outboundFirewallRuleRemoved = await removeOutboundFirewallBlock({ appPath, environment, name: firewallName });
      if (!receipt.outboundFirewallRuleRemoved) errorCode ??= `${PREFIX}FIREWALL_CLEANUP_UNCONFIRMED`;
    }
    if (root !== null && (!installAttempted || receipt.uninstall)
        && (firewallName === null || receipt.outboundFirewallRuleRemoved)) {
      try {
        await safeOwnedRoot(root, rootIdentity);
        if (profile !== null) {
          await safeOwnedRoot(profile.root, profileIdentity);
          await snapshotWindowsFinalUpgradeProfile(profile.root);
          await rm(profile.root, { recursive: true, force: false });
          receipt.ownedProfileRemoved = true;
        }
        await rmdir(root); receipt.cleanup = true;
      } catch (error) { errorCode ??= fixedCode(error); }
    }
    if (errorCode === null && receipt.continuity && receipt.uninstall && receipt.cleanup
        && receipt.outboundFirewallRuleRemoved && receipt.ownedProfileRemoved) receipt.status = 'passed';
    else errorCode ??= `${PREFIX}INCOMPLETE`;
    receipt.errorCode = errorCode;
    try { await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
  }
  if (errorCode !== null) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze(receipt);
}
