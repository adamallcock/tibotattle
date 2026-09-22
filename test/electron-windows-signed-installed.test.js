import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  parseWindowsSignedInstalledArguments, buildSignedInstalledRegistryArguments,
  buildSignedInstalledSignatureArguments, validateSignedInstalledNormalReceipt,
  signedInstalledCleanupEligible, runWindowsSignedInstalled, windowsSignedInstalledNormalReceiptPath,
  retainWindowsInstalledUpdateConfiguration,
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

async function updaterFixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'windows-installed-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const virtualRoot = String.raw`C:\fixture`;
  const mapped = (target) => {
    assert.ok(target === virtualRoot || target.startsWith(`${virtualRoot}\\`));
    return join(root, ...win32.relative(virtualRoot, target).split('\\'));
  };
  await mkdir(join(root, 'installed', 'resources'), { recursive: true });
  await mkdir(join(root, 'candidate'));
  const bytes = Buffer.from('provider: generic\nurl: https://updates.tibotattle.com/electron/stable/win32-x64\npublisherName: Adam Allcock\n');
  const input = join(root, 'installed', 'resources', 'app-update.yml');
  const output = join(root, 'candidate', 'app-update.yml');
  await writeFile(input, bytes);
  const options = { installedAppPath: String.raw`C:\fixture\installed\TiboTattle.exe`,
    sourceCandidatePath: String.raw`C:\fixture\candidate\production-source-candidate.json`,
    expectedSha256: createHash('sha256').update(bytes).digest('hex') };
  const fileSystem = { inspect: (target, options) => lstat(mapped(target), options),
    openFile: (target, flags, mode) => open(mapped(target), flags, mode) };
  return { bytes, input, output, options, fileSystem };
}

test('installed updater retention copies exact verified bytes with bounded digest provenance', async (t) => {
  const fixture = await updaterFixture(t);
  const proof = await retainWindowsInstalledUpdateConfiguration(fixture.options, fixture.fileSystem);
  assert.deepEqual(proof, { file: 'app-update.yml', bytes: fixture.bytes.length,
    sha256: fixture.options.expectedSha256, origin: 'verified_installed_resources' });
  assert.deepEqual(await readFile(fixture.output), fixture.bytes);
  assert.deepEqual(await readFile(fixture.input), fixture.bytes);
  await assert.rejects(retainWindowsInstalledUpdateConfiguration(fixture.options, fixture.fileSystem), { code: 'EEXIST' });
  assert.deepEqual(await readFile(fixture.output), fixture.bytes);
});

test('installed updater retention rejects mismatched evidence before creating an output', async (t) => {
  const fixture = await updaterFixture(t);
  await assert.rejects(retainWindowsInstalledUpdateConfiguration({ ...fixture.options,
    expectedSha256: 'f'.repeat(64) }, fixture.fileSystem), /UPDATER_EVIDENCE_CHANGED/u);
  await assert.rejects(lstat(fixture.output), { code: 'ENOENT' });
});

test('installed updater retention refuses absent, oversized and hardlinked source files', async (t) => {
  for (const kind of ['absent', 'oversized', 'hardlink']) await t.test(kind, async (t) => {
    const fixture = await updaterFixture(t);
    if (kind === 'absent') await rm(fixture.input);
    if (kind === 'oversized') await writeFile(fixture.input, Buffer.alloc(64 * 1024 + 1));
    if (kind === 'hardlink') await link(fixture.input, `${fixture.input}.link`);
    await assert.rejects(retainWindowsInstalledUpdateConfiguration(fixture.options, fixture.fileSystem));
    await assert.rejects(lstat(fixture.output), { code: 'ENOENT' });
  });
});

test('installed updater retention refuses symlink input or output parents', async (t) => {
  for (const kind of ['input', 'output-parent']) await t.test(kind, async (t) => {
    const fixture = await updaterFixture(t);
    if (kind === 'input') {
      await writeFile(`${fixture.input}.original`, fixture.bytes);
      await rm(fixture.input);
      // Use a filesystem-only double for the Windows symlink attribute. Creating
      // file symlinks requires a privilege that native CI must not assume.
      const inspect = fixture.fileSystem.inspect;
      fixture.fileSystem.inspect = async (target, options) => {
        const info = await inspect(target === String.raw`C:\fixture\installed\resources\app-update.yml`
          ? `${target}.original` : target, options);
        return target.endsWith('app-update.yml') ? { ...info, isSymbolicLink: () => true,
          isFile: () => true, isDirectory: () => false } : info;
      };
    } else {
      const inspect = fixture.fileSystem.inspect;
      fixture.fileSystem.inspect = async (target, options) => {
        const info = await inspect(target, options);
        return target === String.raw`C:\fixture\candidate` ? { ...info, isSymbolicLink: () => true,
          isFile: () => false, isDirectory: () => true } : info;
      };
    }
    await assert.rejects(retainWindowsInstalledUpdateConfiguration(fixture.options, fixture.fileSystem), /PATH_INVALID/u);
    await assert.rejects(lstat(fixture.output), { code: 'ENOENT' });
  });
});

test('installed updater retention rejects file identity drift without rounding Windows file IDs', async (t) => {
  const fixture = await updaterFixture(t);
  const inspect = fixture.fileSystem.inspect;
  let inspected = 0;
  fixture.fileSystem.inspect = async (target, options) => {
    const info = await inspect(target, options);
    if (target.endsWith('app-update.yml') && options?.bigint) {
      inspected++;
      assert.equal(typeof info.ino, 'bigint');
      if (inspected === 2) info.ino += 1n;
    }
    return info;
  };
  await assert.rejects(retainWindowsInstalledUpdateConfiguration(fixture.options, fixture.fileSystem), /EVIDENCE_FILE_CHANGED/u);
  await assert.rejects(lstat(fixture.output), { code: 'ENOENT' });
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
  'projectsAndThreadsRetainedAcrossRestart',
  'settingsPersistedAcrossRestart', 'durableContributionOptOutRetained', 'loopbackJourneyVerified',
  'outboundFirewallRuleRemoved', 'ownedProfileRemoved'];
const valid = () => ({ status: 'passed', sourceRevision: revision, target: 'win32-x64',
  artifactSha256: digest, executableSha256: 'c'.repeat(64),
  ...Object.fromEntries(proofKeys.map((key) => [key, true])) });

test('installed proof refuses incomplete native journey and unbound source receipts', () => {
  assert.equal(validateSignedInstalledNormalReceipt(valid(), revision).status, 'passed');
  for (const key of proofKeys) {
    for (const missing of [false, undefined]) {
      assert.throws(() => validateSignedInstalledNormalReceipt({ ...valid(), [key]: missing }, revision), /NORMAL_JOURNEY_UNPROVEN/u);
    }
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
