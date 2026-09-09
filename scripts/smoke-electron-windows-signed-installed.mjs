#!/usr/bin/env node
// Genuine signed stable NSIS lifecycle on a disposable GitHub-hosted Windows
// account. Reuses the normal candidate journey; no qualification IPC or product
// bypass is enabled. No feed publication, hosted enrollment, or notification
// delivery claim is made here.
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import distribution from '../config/electron-production-distribution.cjs';
import {
  assertPinnedNsisSilentInstallDoesNotAutoRun, buildWindowsNsisInstallArguments,
  buildWindowsNsisUninstallArguments, buildWindowsNsisRegistryInspectionArguments,
  parseWindowsNsisRegistryInspectionResult, runWindowsNsisLifecycleProgram,
  WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY,
  WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY,
  WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY,
} from './smoke-electron-windows-nsis-lifecycle.mjs';
import {
  runWindowsNormalCandidateSmoke, verifyWindowsNormalCandidateSmokePackage,
} from './smoke-electron-windows-normal-candidate.mjs';
import {
  WINDOWS_ELECTRON_BINDING_RELATIVE_PATH, WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH,
} from './launch-electron-windows-development.mjs';

const PREFIX = 'ELECTRON_WINDOWS_SIGNED_INSTALLED_';
const APP = 'TiboTattle.exe';
const UNINSTALLER = 'Uninstall TiboTattle.exe';
const GUID = distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID;
const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const fail = (code) => { throw Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` }); };
const fixedCode = (error) => /^ELECTRON_WINDOWS_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : `${PREFIX}FAILED`;
function path(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/u.test(value) || /[\0\r\n]/u.test(value)
      || value.split('\\').some((part) => part === '..' || part === '.') || win32.resolve(value) !== value) fail('PATH_INVALID');
  return value;
}
export function parseWindowsSignedInstalledArguments(argv) {
  const fields = new Map([['--installer', 'installerPath'], ['--installer-sha256', 'installerSha256'],
    ['--staged-app', 'stagedAppPath'], ['--source-candidate', 'sourceCandidatePath'],
    ['--source-revision', 'sourceRevision'], ['--receipt', 'receiptPath']]);
  const result = {};
  if (!Array.isArray(argv) || argv[0] !== '--execute') fail('EXECUTE_REQUIRED');
  for (let index = 1; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    if (!field || Object.hasOwn(result, field) || typeof argv[index + 1] !== 'string') fail('ARGUMENT_INVALID');
    result[field] = argv[index + 1];
  }
  if (Object.keys(result).length !== fields.size || !REVISION.test(result.sourceRevision)
      || !SHA256.test(result.installerSha256)) fail('ARGUMENT_INVALID');
  for (const key of ['installerPath', 'stagedAppPath', 'sourceCandidatePath', 'receiptPath']) path(result[key]);
  if (win32.join(win32.dirname(result.sourceCandidatePath), 'app') !== result.stagedAppPath) fail('ARGUMENT_INVALID');
  return Object.freeze(result);
}
async function safePath(value, directory = false) {
  path(value);
  let current = win32.parse(value).root;
  const parts = value.slice(current.length).split('\\').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = win32.join(current, parts[index]);
    const info = await lstat(current);
    const isDirectory = index < parts.length - 1 || directory;
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail('PATH_INVALID');
  }
}
async function digest(value) {
  await safePath(value);
  const before = await lstat(value);
  if (before.size > 1024 * 1024 * 1024) fail('FILE_TOO_LARGE');
  const handle = await open(value, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail('FILE_CHANGED');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export function signedInstalledCleanupEligible({ installAttempted, installSettled, safeToUninstall }) {
  return installAttempted === true && installSettled === true && safeToUninstall === true;
}
function successful(result) { return result?.settled === true && result.timedOut === false && result.exitCode === 0; }
export function buildSignedInstalledRegistryArguments(root) {
  const args = [...buildWindowsNsisRegistryInspectionArguments(root)];
  args[args.length - 1] = args.at(-1)
    .replace(`'${WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY}'`, `'Software\\${GUID}'`)
    .replace(`'${WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY}'`, `'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}'`);
  return args;
}
export function buildSignedInstalledSignatureArguments() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;$s=Get-AuthenticodeSignature -LiteralPath $env:${WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY};if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne 'Adam Allcock'){exit 1};[Console]::Out.Write('valid-v1')`];
}
async function probe(args, target, environment, runProgram) {
  const command = win32.join(path(environment.SystemRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return runProgram(command, args, { environment, fixedProbePath: target,
    timeoutMs: 20_000, captureOutput: true, fixedPowerShellUtilityModules: true });
}
async function verifySignature(target, environment, runProgram) {
  await safePath(target);
  const result = await probe(buildSignedInstalledSignatureArguments(), target, environment, runProgram);
  if (!successful(result) || result.stdout !== 'valid-v1') fail('SIGNATURE_INVALID');
}
async function registry(root, environment, runProgram) {
  const result = await probe(buildSignedInstalledRegistryArguments(root), root, environment, runProgram);
  if (!successful(result)) fail('REGISTRY_UNAVAILABLE');
  return parseWindowsNsisRegistryInspectionResult(result.stdout);
}
async function missing(target) {
  try { await lstat(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function cleanUninstallerResidue(root, expectedDigest) {
  if (await missing(root)) return;
  await safePath(root, true);
  const entries = await readdir(root, { withFileTypes: true });
  const target = win32.join(root, UNINSTALLER);
  if (entries.length !== 1 || entries[0].name !== UNINSTALLER || !entries[0].isFile()
      || entries[0].isSymbolicLink() || await digest(target) !== expectedDigest) fail('UNINSTALL_RESIDUE_UNSAFE');
  await unlink(target);
  await rmdir(root);
}
export function validateSignedInstalledNormalReceipt(receipt, sourceRevision) {
  if (receipt?.status !== 'passed' || receipt.sourceRevision !== sourceRevision
      || receipt.target !== 'win32-x64' || !SHA256.test(receipt.artifactSha256 ?? '')
      || !SHA256.test(receipt.executableSha256 ?? '') || [
        'packageArtifactVerified', 'packagedElectronExecutionVerified', 'syntheticFixtureIngestionVerified',
        'syntheticFixtureTotalsRetainedAcrossRestart', 'settingsPersistedAcrossRestart',
        'durableContributionOptOutRetained', 'loopbackJourneyVerified', 'outboundFirewallRuleRemoved',
        'ownedProfileRemoved',
      ].some((key) => receipt[key] !== true)) fail('NORMAL_JOURNEY_UNPROVEN');
  return receipt;
}

export async function runWindowsSignedInstalled(options, {
  platform = process.platform, architecture = process.arch, environment = process.env,
  runProgram = runWindowsNsisLifecycleProgram, runNormal = runWindowsNormalCandidateSmoke,
} = {}) {
  if (platform !== 'win32' || architecture !== 'x64' || environment.GITHUB_ACTIONS !== 'true'
      || environment.RUNNER_ENVIRONMENT !== 'github-hosted') fail('DISPOSABLE_WINDOWS_REQUIRED');
  // Revalidate even programmatic callers before any mutation.
  parseWindowsSignedInstalledArguments(['--execute', '--installer', options?.installerPath,
    '--installer-sha256', options?.installerSha256, '--staged-app', options?.stagedAppPath,
    '--source-candidate', options?.sourceCandidatePath, '--source-revision', options?.sourceRevision,
    '--receipt', options?.receiptPath]);
  await safePath(environment.RUNNER_TEMP, true);
  await safePath(win32.dirname(options.receiptPath), true);
  const receiptHandle = await open(options.receiptPath, 'wx', 0o600);
  const receipt = { schemaVersion: 'tibotattle-windows-signed-installed-v1', status: 'failed',
    sourceRevision: options.sourceRevision, installerSha256: options.installerSha256,
    signedInstallerVerified: false, signedInstalledClosureVerified: false,
    installation: false, normalJourney: false, uninstall: false, cleanup: false,
    credentialPersistence: 'not_requalified_by_this_normal_journey',
    hostedEnrollment: 'not_exercised', notificationDelivery: 'requires_user_test', productionReady: false };
  let ownedRoot = null, installRoot = null, installAttempted = false, installSettled = false;
  let safeToUninstall = true, errorCode = null;
  try {
    if (await digest(options.installerPath) !== options.installerSha256) fail('INSTALLER_HASH_MISMATCH');
    await verifySignature(options.installerPath, environment, runProgram);
    receipt.signedInstallerVerified = true;
    if (await assertPinnedNsisSilentInstallDoesNotAutoRun() !== true) fail('NSIS_TEMPLATE_UNVERIFIED');
    ownedRoot = await mkdtemp(win32.join(environment.RUNNER_TEMP, 'tibotattle-signed-installed-'));
    await safePath(ownedRoot, true);
    installRoot = win32.join(ownedRoot, 'app');
    if (await registry(installRoot, environment, runProgram) !== 'absent-v1') fail('REGISTRY_DIRTY');
    if (await digest(options.installerPath) !== options.installerSha256) fail('INSTALLER_CHANGED');
    installAttempted = true;
    const result = await runProgram(options.installerPath, buildWindowsNsisInstallArguments(installRoot), { environment, timeoutMs: 180_000 });
    installSettled = result?.settled === true && result.timedOut === false;
    if (!successful(result)) fail('INSTALL_FAILED');
    if (await registry(installRoot, environment, runProgram) !== 'expected-v1') fail('INSTALL_REGISTRY_INVALID');
    receipt.installation = true;
    const appPath = win32.join(installRoot, APP);
    const normalOptions = { appPath, stagedAppPath: options.stagedAppPath,
      sourceCandidatePath: options.sourceCandidatePath, sourceRevision: options.sourceRevision,
      receiptPath: `${options.receiptPath}.normal.json` };
    const before = await verifyWindowsNormalCandidateSmokePackage(normalOptions);
    const nativeRoot = win32.join(installRoot, 'resources', 'app.asar.unpacked');
    for (const target of [appPath, win32.join(installRoot, UNINSTALLER),
      win32.join(nativeRoot, WINDOWS_ELECTRON_BINDING_RELATIVE_PATH),
      win32.join(nativeRoot, WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH)]) {
      await verifySignature(target, environment, runProgram);
    }
    receipt.signedInstalledClosureVerified = true;
    safeToUninstall = false; // Only the normal runner can establish process quiescence.
    await runNormal(normalOptions);
    const normal = validateSignedInstalledNormalReceipt(JSON.parse(await readFile(normalOptions.receiptPath, 'utf8')), options.sourceRevision);
    safeToUninstall = true;
    const after = await verifyWindowsNormalCandidateSmokePackage(normalOptions);
    if (JSON.stringify(before) !== JSON.stringify(after) || normal.artifactSha256 !== before.artifactSha256
        || normal.executableSha256 !== before.executableSha256) fail('INSTALLED_BYTES_CHANGED');
    receipt.normalJourney = true;
    receipt.artifactSha256 = normal.artifactSha256;
    receipt.executableSha256 = normal.executableSha256;
  } catch (error) { errorCode = fixedCode(error); }
  finally {
    if (signedInstalledCleanupEligible({ installAttempted, installSettled, safeToUninstall })) {
      try {
        const uninstaller = win32.join(installRoot, UNINSTALLER);
        // Only the exact owned registry target can authorize running its uninstaller.
        if (await registry(installRoot, environment, runProgram) !== 'expected-v1') fail('UNINSTALL_OWNERSHIP_UNPROVEN');
        const uninstallerDigest = await digest(uninstaller);
        await verifySignature(uninstaller, environment, runProgram);
        const result = await runProgram(uninstaller, buildWindowsNsisUninstallArguments(installRoot), { environment, timeoutMs: 120_000 });
        if (!successful(result)) fail('UNINSTALL_FAILED');
        if (await registry(installRoot, environment, runProgram) !== 'absent-v1') fail('UNINSTALL_REGISTRY_REMAINS');
        await cleanUninstallerResidue(installRoot, uninstallerDigest);
        receipt.uninstall = true;
      } catch (error) { errorCode ??= fixedCode(error); }
    }
    if (ownedRoot !== null && (!installAttempted || receipt.uninstall)) {
      try { await rmdir(ownedRoot); receipt.cleanup = true; } catch { errorCode ??= `${PREFIX}CLEANUP_UNCONFIRMED`; }
    }
    if (errorCode === null && receipt.normalJourney && receipt.uninstall && receipt.cleanup) receipt.status = 'passed';
    else errorCode ??= `${PREFIX}INCOMPLETE`;
    receipt.errorCode = errorCode;
    try { await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
  }
  if (errorCode !== null) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze(receipt);
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runWindowsSignedInstalled(parseWindowsSignedInstalledArguments(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${fixedCode(error)}\n`); process.exitCode = 1; }
}
