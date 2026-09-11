import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  parseWindowsSignedInstalledArguments, buildSignedInstalledRegistryArguments,
  buildSignedInstalledSignatureArguments, validateSignedInstalledNormalReceipt,
  signedInstalledCleanupEligible, runWindowsSignedInstalled, windowsSignedInstalledNormalReceiptPath,
} from '../scripts/smoke-electron-windows-signed-installed.mjs';

const revision = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const args = ['--execute', '--installer', String.raw`C:\candidate\artifacts\TiboTattle.exe`,
  '--installer-sha256', digest, '--staged-app', String.raw`C:\candidate\app`,
  '--source-candidate', String.raw`C:\candidate\production-source-candidate.json`,
  '--source-revision', revision, '--receipt', String.raw`C:\receipts\installed.json`];

test('signed installed arguments require explicit execution, exact digest and closed source root', () => {
  const value = parseWindowsSignedInstalledArguments(args);
  assert.equal(value.installerSha256, digest);
  assert.equal(value.sourceRevision, revision);
  for (const changed of [args.slice(1), [...args, '--installer', 'other'],
    args.map((v) => v === digest ? 'unsigned' : v),
    args.map((v) => v === String.raw`C:\candidate\app` ? String.raw`C:\elsewhere\app` : v),
    args.map((v) => v === String.raw`C:\receipts\installed.json` ? String.raw`C:\receipts\..\installed.json` : v),
    args.map((v) => v === String.raw`C:\candidate\artifacts\TiboTattle.exe` ? 'relative.exe' : v)]) {
    assert.throws(() => parseWindowsSignedInstalledArguments(changed), /ELECTRON_WINDOWS_SIGNED_INSTALLED_/u);
  }
});

test('registry probe binds stable product identity, remains read-only and receives path out of script', () => {
  const command = buildSignedInstalledRegistryArguments(resolve('owned-app')).at(-1);
  assert.match(command, /Software\\FDA705D7-5644-50E8-8CD2-3005D51B98C5/u);
  assert.match(command, /Uninstall\\FDA705D7-5644-50E8-8CD2-3005D51B98C5/u);
  assert.doesNotMatch(command, /962AD905|SetValue|DeleteSubKey|C:\\runner/u);
  assert.match(command, /OpenSubKey\('[^']+',\$false\)/u);
});

test('signature proof requires OS trust, publisher and timestamp without raw certificate output', () => {
  const args = buildSignedInstalledSignatureArguments();
  assert.equal(args[1], '-NoProfile');
  assert.match(args.at(-1), /Import-Module Microsoft.PowerShell.Security/u);
  assert.match(args.at(-1), /Status -ne 'Valid'/u);
  assert.match(args.at(-1), /TimeStamperCertificate/u);
  assert.match(args.at(-1), /-cne 'Adam Allcock'/u);
  assert.match(args.at(-1), /Out.Write\('valid-v1'\)/u);
});

const proofKeys = ['packageArtifactVerified', 'packagedElectronExecutionVerified',
  'syntheticFixtureIngestionVerified', 'syntheticFixtureTotalsRetainedAcrossRestart',
  'settingsPersistedAcrossRestart', 'durableContributionOptOutRetained', 'loopbackJourneyVerified',
  'outboundFirewallRuleRemoved', 'ownedProfileRemoved'];
const valid = () => ({ status: 'passed', sourceRevision: revision, target: 'win32-x64',
  artifactSha256: digest, executableSha256: 'c'.repeat(64),
  ...Object.fromEntries(proofKeys.map((key) => [key, true])) });

test('installed proof refuses incomplete native journey and unbound source receipts', () => {
  assert.equal(validateSignedInstalledNormalReceipt(valid(), revision).status, 'passed');
  for (const key of proofKeys) {
    assert.throws(() => validateSignedInstalledNormalReceipt({ ...valid(), [key]: false }, revision), /NORMAL_JOURNEY_UNPROVEN/u);
  }
  for (const patch of [{ sourceRevision: 'd'.repeat(40) }, { status: 'failed' },
    { target: 'linux-x64' }, { executableSha256: null }]) {
    assert.throws(() => validateSignedInstalledNormalReceipt({ ...valid(), ...patch }, revision), /NORMAL_JOURNEY_UNPROVEN/u);
  }
});

test('interrupted installer or uncertain normal process state never authorizes uninstall', () => {
  for (const installAttempted of [false, true]) for (const installSettled of [false, true]) {
    for (const safeToUninstall of [false, true]) {
      assert.equal(signedInstalledCleanupEligible({ installAttempted, installSettled, safeToUninstall }),
        installAttempted && installSettled && safeToUninstall);
    }
  }
  assert.equal(signedInstalledCleanupEligible({ installAttempted: true, installSettled: true, safeToUninstall: 'yes' }), false);
});

test('host refusal happens before file or installer mutation', async () => {
  for (const environment of [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }]) {
    await assert.rejects(runWindowsSignedInstalled(parseWindowsSignedInstalledArguments(args), {
      platform: 'win32', architecture: 'x64', environment,
      runProgram: () => assert.fail('must not execute'), runNormal: () => assert.fail('must not launch'),
    }), /DISPOSABLE_WINDOWS_REQUIRED/u);
  }
  await assert.rejects(runWindowsSignedInstalled(null, { platform: 'darwin', architecture: 'arm64' }), /DISPOSABLE_WINDOWS_REQUIRED/u);
});

// Execute the existing runner's actual path guard with filesystem-only doubles.
// This catches incompatible caller paths without relaxing that runner or writing
// Windows-looking directories on a non-Windows test host.
test('signed wrapper receipt satisfies the real normal-runner parent contract', async () => {
  const source = await readFile(new URL('../scripts/smoke-electron-windows-normal-candidate.mjs', import.meta.url), 'utf8');
  const exactPath = source.slice(source.indexOf('function exactWindowsPath(value) {'),
    source.indexOf('function sameWindowsPath('));
  const parentGuard = source.slice(source.indexOf('async function ensureWindowsNormalCandidateReceiptParent('),
    source.indexOf('function candidateReceipt('));
  assert.match(exactPath, /^function exactWindowsPath/u);
  assert.match(parentGuard, /^async function ensureWindowsNormalCandidateReceiptParent/u);
  const inspected = [];
  const guard = new Function('win32', 'lstat', 'mkdir', 'fail',
    `${exactPath}\n${parentGuard}\nreturn ensureWindowsNormalCandidateReceiptParent;`)(
    win32, async (target) => { inspected.push(target); return { isDirectory: () => true, isSymbolicLink: () => false }; },
    () => assert.fail('existing private parent needs no mkdir'),
    (code) => { throw new Error(code); });
  const selected = windowsSignedInstalledNormalReceiptPath(String.raw`C:\workspace`);
  assert.equal(selected, String.raw`C:\workspace\.release-build\electron-windows-normal-candidate\normal-candidate-smoke.json`);
  assert.equal(await guard(selected), win32.dirname(selected));
  assert.ok(inspected.length > 0);
  await assert.rejects(guard(String.raw`C:\receipts\signed-installed.json.normal.json`), /RECEIPT_INVALID/u);
  assert.throws(() => windowsSignedInstalledNormalReceiptPath('relative'), /PATH_INVALID/u);
});
