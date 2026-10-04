/** Disposable installed qualification of already signed bytes; never rebuilds,
 * signs or publishes. Comparison trees are extracted from those signed bytes,
 * not represented as independent pre-signing source-stage receipts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { productionElectronCandidatePlan } from './package-electron-production.mjs';
import { runWindowsSignedInstalled, assertWindowsSignedInstalledPath,
  readWindowsSignedInstalledEvidence, digestWindowsSignedInstalledFile,
  verifyWindowsSignedInstalledSignature } from './smoke-electron-windows-signed-installed.mjs';
import { runWindowsNsisLifecycleProgram } from './smoke-electron-windows-nsis-lifecycle.mjs';
import { WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE, parseWindowsFinalUpgradeMode,
  validateWindowsFinalUpgradePredecessorManifest, runWindowsFinalUpgrade } from './smoke-electron-windows-final-upgrade.mjs';

const env = process.env;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function program(command, args, timeout) {
  const result = spawnSync(command, args, { shell: false, stdio: 'ignore', timeout });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
}
async function reference(installer, { expectedSource, expectedVersion, scratch, root, candidate = false }) {
  await assertWindowsSignedInstalledPath(installer);
  await verifyWindowsSignedInstalledSignature(installer, env, runWindowsNsisLifecycleProgram);
  const sevenZip = join(env.ProgramFiles, '7-Zip', '7z.exe');
  program(sevenZip, ['x', '-y', `-o${join(scratch, 'nsis')}`, installer], 180000);
  program(sevenZip, ['x', '-y', `-o${join(scratch, 'package')}`,
    join(scratch, 'nsis', '$PLUGINSDIR', 'app-64.7z')], 180000);
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder/package.json'));
  const lib = createRequire(builder.resolve('app-builder-lib/package.json')), asar = lib('@electron/asar');
  const archive = join(scratch, 'package', 'resources', 'app.asar');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(manifest.tibotattleDistribution.sourceRevision, expectedSource);
  assert.equal(manifest.tibotattleDistribution.target, 'win32-x64');
  if (expectedVersion !== undefined) assert.equal(manifest.version, expectedVersion);
  await mkdir(root, { recursive: true });
  const stage = join(root, 'app'); await mkdir(stage); asar.extractAll(archive, stage);
  const plan = productionElectronCandidatePlan({ target: 'win32-x64', sourceRevision: expectedSource,
    buildNumber: manifest.tibotattleDistribution.buildNumber, hostPlatform: 'win32', hostArchitecture: 'x64' });
  if (candidate) assert.equal(plan.version, manifest.version);
  // Reconstructed solely for the existing comparison verifier. Historical
  // version/build come from the signed archive, never the current package.json.
  const comparison = { ...plan, version: manifest.version,
    builderEnvironment: { ...plan.builderEnvironment, TIBOTATTLE_ELECTRON_VERSION: manifest.version },
    status: 'production_source_staged', stagedManifest: 'app/package.json',
    runtimeManifest: 'app/electron-runtime-manifest.json',
    ...(!candidate ? { referenceOrigin: 'extracted_from_exact_signed_installer', independentPreSigningStage: false } : {}) };
  const sourceCandidatePath = join(root, 'production-source-candidate.json');
  await writeFile(sourceCandidatePath, `${JSON.stringify(comparison)}\n`, { flag: 'wx', mode: 0o600 });
  return { installerPath: installer, stagedAppPath: stage, sourceCandidatePath,
    sourceRevision: expectedSource, version: manifest.version, buildNumber: manifest.tibotattleDistribution.buildNumber,
    expectedAsarSha256: await digestWindowsSignedInstalledFile(archive),
    expectedExecutableSha256: await digestWindowsSignedInstalledFile(join(scratch, 'package', 'TiboTattle.exe')) };
}
async function main() {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v26.2.0');
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.match(env.SOURCE_REVISION ?? '', /^[0-9a-f]{40}$/u); assert.match(env.INSTALLER_SHA256 ?? '', /^[0-9a-f]{64}$/u);
  const predecessorIntake = parseWindowsFinalUpgradeMode({ qualifyInstalled: env.QUALIFY_INSTALLED,
    qualifyUpgrade: env.QUALIFY_UPGRADE, predecessorIntake: env.PREDECESSOR_INTAKE });
  await assertWindowsSignedInstalledPath(env.RUNNER_TEMP, true);
  const input = join(env.RUNNER_TEMP, 'signed-input', 'electron-production', 'win32-x64');
  const previous = JSON.parse((await readWindowsSignedInstalledEvidence(join(input, 'evidence', 'windows-signed-installed.json'), 128 * 1024)).toString('utf8'));
  assert.equal(previous.sourceRevision, env.SOURCE_REVISION); assert.equal(previous.installerSha256, env.INSTALLER_SHA256);
  assert.equal(previous.signedInstallerVerified, true);
  const names = (await readdir(join(input, 'artifacts'))).filter(name => /^TiboTattle-\d+\.\d+\.\d+-Windows-x64\.exe$/u.test(name));
  assert.equal(names.length, 1);
  const installer = join(input, 'artifacts', names[0]);
  assert.equal(await digestWindowsSignedInstalledFile(installer), env.INSTALLER_SHA256);
  const scratch = await mkdtemp(join(env.RUNNER_TEMP, 'tibotattle-frozen-extract-'));
  const root = resolve('.release-build/electron-production/win32-x64');
  const candidate = await reference(installer, { expectedSource: env.SOURCE_REVISION,
    scratch: join(scratch, 'candidate'), root, candidate: true });
  assert.equal(names[0], `TiboTattle-${candidate.version}-Windows-x64.exe`);
  await mkdir(join(root, 'artifacts'));
  await cp(installer, join(root, 'artifacts', names[0]), { errorOnExist: true, force: false });
  await cp(join(input, 'artifacts', 'latest.yml'), join(root, 'artifacts', 'latest.yml'), { errorOnExist: true, force: false });
  await mkdir(join(root, 'evidence'));
  const frozen = { schemaVersion: 'tibotattle-windows-frozen-reference-v1', sourceRevision: env.SOURCE_REVISION,
    qualificationRunnerRevision: env.GITHUB_SHA, installerSha256: env.INSTALLER_SHA256, version: candidate.version,
    buildNumber: candidate.buildNumber, referenceOrigin: 'extracted_from_exact_signed_installer',
    independentPreSigningStage: false, rebuilt: false, resigned: false, published: false, installTimeoutMs: 300000 };
  await writeFile(join(root, 'evidence', 'frozen-reference.json'), `${JSON.stringify(frozen)}\n`, { flag: 'wx', mode: 0o600 });
  const candidateOptions = { ...candidate, installerPath: join(root, 'artifacts', names[0]), installerSha256: env.INSTALLER_SHA256 };
  if (predecessorIntake === null) {
    await runWindowsSignedInstalled({ ...candidateOptions, receiptPath: join(root, 'evidence', 'windows-signed-installed.json') });
    console.log('WINDOWS_FROZEN_INSTALLED_QUALIFIED'); return;
  }
  assert.equal(candidate.version, '0.1.27');
  const predecessorRoot = join(scratch, 'predecessor'); await mkdir(predecessorRoot);
  // Read-only immutable GitHub release verification is separate from native
  // Authenticode. No stable feed, caller URL, rebuild or signature replacement.
  program('gh', ['release', 'verify', 'v0.1.26', '--repo', 'adamallcock/tibotattle'], 60000);
  program('gh', ['release', 'download', 'v0.1.26', '--repo', 'adamallcock/tibotattle',
    '--pattern', 'release-manifest.json', '--dir', predecessorRoot], 60000);
  const predecessorManifestPath = join(predecessorRoot, 'release-manifest.json');
  validateWindowsFinalUpgradePredecessorManifest(await readWindowsSignedInstalledEvidence(predecessorManifestPath, 64 * 1024), predecessorIntake);
  program('gh', ['release', 'download', 'v0.1.26', '--repo', 'adamallcock/tibotattle',
    '--pattern', WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE, '--dir', predecessorRoot], 180000);
  const oldInstaller = join(predecessorRoot, WINDOWS_FINAL_UPGRADE_PREDECESSOR_FILE);
  assert.equal(await digestWindowsSignedInstalledFile(oldInstaller), predecessorIntake.installerSha256);
  const predecessor = await reference(oldInstaller, { expectedSource: predecessorIntake.sourceRevision,
    expectedVersion: predecessorIntake.version, scratch: join(predecessorRoot, 'extracted'), root: join(predecessorRoot, 'reference') });
  await writeFile(join(root, 'evidence', 'frozen-predecessor-reference.json'), `${JSON.stringify({
    schemaVersion: 'tibotattle-windows-frozen-predecessor-reference-v1', predecessor: predecessorIntake,
    qualificationRunnerRevision: env.GITHUB_SHA, buildNumber: predecessor.buildNumber,
    sourceCandidateSha256: hash(await readFile(predecessor.sourceCandidatePath)),
    immutableReleaseVerified: true, referenceOrigin: 'extracted_from_exact_signed_installer',
    independentPreSigningStage: false, rebuilt: false, resigned: false, published: false,
  })}\n`, { flag: 'wx', mode: 0o600 });
  await runWindowsFinalUpgrade({ candidate: candidateOptions,
    predecessor: { ...predecessor, installerSha256: predecessorIntake.installerSha256 }, predecessorIntake,
    predecessorManifestPath, receiptPath: join(root, 'evidence', 'windows-final-upgrade.json') });
  console.log('WINDOWS_FROZEN_FINAL_UPGRADE_QUALIFIED');
}
try { await main(); }
catch (error) {
  console.error(/^ELECTRON_WINDOWS_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'WINDOWS_FROZEN_INSTALLED_FAILED');
  process.exitCode = 1;
}
