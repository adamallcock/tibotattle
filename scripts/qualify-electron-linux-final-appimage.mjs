#!/usr/bin/env node
/** Bind the existing isolated normal-app smoke to extracted final AppImage bytes.
 * This does not rebuild, sign, publish, or exercise a predecessor update. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { productionElectronCandidatePlan } from './package-electron-production.mjs';
import { linuxAppImageIdentity } from './build-linux-updater-rehearsal.mjs';
import { verifyLinuxNormalPackagedSmokePackage } from './smoke-electron-linux-packaged.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const SMALL = 128 * 1024;
const fail = (code) => { throw Object.assign(new Error(`LINUX_FINAL_APPIMAGE_${code}`), { code: `LINUX_FINAL_APPIMAGE_${code}` }); };
const sameFile = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1n
  && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

async function fingerprint(path, maximum, keep = false) {
  if (await realpath(path) !== path) fail('PATH_INVALID');
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum)) fail('FILE_INVALID');
  const handle = await open(path, 'r');
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) fail('FILE_CHANGED');
    const digest = createHash('sha256'), chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximum) fail('FILE_CHANGED');
      digest.update(chunk); if (keep) chunks.push(chunk);
    }
    if (bytes !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true }))
        || !sameFile(before, await lstat(path, { bigint: true }))) fail('FILE_CHANGED');
    return { bytes, sha256: digest.digest('hex'), ...(keep ? { contents: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}
function json(bytes) { try { return JSON.parse(bytes); } catch { fail('JSON_INVALID'); } }
async function writeNew(path, value) {
  if (await realpath(dirname(path)) !== dirname(path)) fail('PATH_INVALID');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
function locations(root) {
  const candidate = join(root, '.release-build/electron-production/linux-x64');
  const runtime = join(candidate, 'final-runtime');
  return { candidate, runtime, source: join(candidate, 'production-source-candidate.json'),
    packageReceipt: join(candidate, 'linux-production-package-receipt.json'),
    stage: join(candidate, 'app'), extraction: join(runtime, 'extracted'),
    app: join(runtime, 'extracted/squashfs-root/tibotattle'),
    preparation: join(runtime, 'final-image-preparation.json'),
    smoke: join(runtime, 'normal-packaged-smoke.json'),
    final: join(runtime, 'final-image-runtime.json') };
}
async function boundCandidate({ repositoryRoot = ROOT, sourceRevision } = {}) {
  if (!REVISION.test(sourceRevision ?? '') || resolve(repositoryRoot) !== repositoryRoot
      || await realpath(repositoryRoot) !== repositoryRoot) fail('SOURCE_INVALID');
  const paths = locations(repositoryRoot);
  const source = await fingerprint(paths.source, SMALL, true);
  const candidate = json(source.contents);
  const plan = productionElectronCandidatePlan({ target: 'linux-x64', sourceRevision,
    buildNumber: candidate.buildNumber, hostPlatform: 'linux', hostArchitecture: 'x64' });
  if (!isDeepStrictEqual(candidate, { ...plan, status: 'production_source_staged',
    stagedManifest: 'app/package.json', runtimeManifest: 'app/electron-runtime-manifest.json' })) fail('SOURCE_INVALID');
  const packageFile = await fingerprint(paths.packageReceipt, SMALL, true);
  const receipt = json(packageFile.contents);
  const file = `TiboTattle-${candidate.version}-linux-x86_64.AppImage`;
  if (receipt.schemaVersion !== 'tibotattle-linux-production-package-v1'
      || receipt.sourceRevision !== sourceRevision || !REVISION.test(receipt.workflowRunnerRevision ?? '')
      || receipt.target !== 'linux-x64' || receipt.version !== candidate.version
      || receipt.buildNumber !== candidate.buildNumber || receipt.sourceCandidateSha256 !== source.sha256
      || receipt.signingRequired !== false || receipt.published !== false
      || receipt.nativeRuntimeQualification !== 'separate_evidence_required'
      || receipt.artifact?.file !== file || !HASH.test(receipt.artifact?.sha256 ?? '')) fail('PACKAGE_RECEIPT_INVALID');
  const imagePath = join(paths.candidate, 'artifacts', file);
  const imageFile = await fingerprint(imagePath, 1024 ** 3);
  const image = await linuxAppImageIdentity(imagePath);
  if (imageFile.sha256 !== image.sha256 || imageFile.bytes !== image.bytes
      || !isDeepStrictEqual(receipt.artifact, { file, ...image })) fail('FINAL_BYTES_MISMATCH');
  return { paths, sourceRevision, candidate, imagePath, artifact: receipt.artifact,
    sourceCandidateSha256: source.sha256, packageReceiptSha256: packageFile.sha256,
    workflowRunnerRevision: receipt.workflowRunnerRevision };
}
function verifyOptions(context) {
  return { appPath: context.paths.app, stagedAppPath: context.paths.stage,
    sourceCandidatePath: context.paths.source, sourceRevision: context.sourceRevision };
}
function validateIdentity(identity, sourceRevision) {
  if (identity?.sourceRevision !== sourceRevision || identity.target !== 'linux-x64'
      || !HASH.test(identity.artifactSha256 ?? '') || !HASH.test(identity.executableSha256 ?? '')
      || !HASH.test(identity.native?.keytarSha256 ?? '') || !HASH.test(identity.native?.mutexSha256 ?? '')) fail('EXTRACTED_IDENTITY_INVALID');
  return identity;
}
function extract(imagePath, extraction) {
  const result = spawnSync(imagePath, ['--appimage-extract'], {
    cwd: extraction, shell: false, stdio: 'ignore', timeout: 120_000,
  });
  if (result.error || result.status !== 0 || result.signal) fail('EXTRACTION_FAILED');
}
function prepared(context, identity) {
  return { schemaVersion: 'tibotattle-linux-final-appimage-preparation-v1',
    sourceRevision: context.sourceRevision, workflowRunnerRevision: context.workflowRunnerRevision,
    version: context.candidate.version, buildNumber: context.candidate.buildNumber,
    sourceCandidateSha256: context.sourceCandidateSha256, packageReceiptSha256: context.packageReceiptSha256,
    artifact: context.artifact, extractedIdentity: identity,
    extraction: 'final_appimage_bytes', rebuilt: false, published: false };
}
export async function prepareLinuxFinalAppImage(options, {
  runExtractor = extract, verifyPackage = verifyLinuxNormalPackagedSmokePackage,
} = {}) {
  const context = await boundCandidate(options);
  await mkdir(context.paths.runtime, { mode: 0o700 });
  await mkdir(context.paths.extraction, { mode: 0o700 });
  await runExtractor(context.imagePath, context.paths.extraction);
  const identity = validateIdentity(await verifyPackage(verifyOptions(context)), context.sourceRevision);
  const rechecked = await boundCandidate(options);
  const proof = prepared(context, identity);
  if (!isDeepStrictEqual(proof, prepared(rechecked, identity))) fail('FINAL_BYTES_CHANGED');
  await writeNew(context.paths.preparation, proof);
  return proof;
}
export async function verifyLinuxFinalAppImageRuntime(options, {
  verifyPackage = verifyLinuxNormalPackagedSmokePackage,
} = {}) {
  const context = await boundCandidate(options);
  const preparation = await fingerprint(context.paths.preparation, SMALL, true);
  const identity = validateIdentity(await verifyPackage(verifyOptions(context)), context.sourceRevision);
  if (!isDeepStrictEqual(json(preparation.contents), prepared(context, identity))) fail('PREPARATION_CHANGED');
  const smokeFile = await fingerprint(context.paths.smoke, SMALL, true);
  const smoke = json(smokeFile.contents);
  if (smoke.schemaVersion !== 'tibotattle-electron-linux-normal-packaged-smoke-v1'
      || smoke.status !== 'passed' || smoke.scope !== 'candidate_only'
      || smoke.target !== 'linux-x64' || smoke.sourceRevision !== context.sourceRevision
      || smoke.artifactSha256 !== identity.artifactSha256 || smoke.executableSha256 !== identity.executableSha256
      || smoke.errorCode !== null || ['packageArtifactVerified', 'packagedElectronExecutionVerified',
        'accountObservationLifecycleVerified', 'unavailableServiceResponseVerified', 'coldRestartSettingsVerified',
        'sharingOptOutPersisted', 'sessionCleanupConfirmed'].some((key) => smoke[key] !== true)) fail('RUNTIME_UNPROVEN');
  const proof = { schemaVersion: 'tibotattle-linux-final-appimage-runtime-v1', status: 'passed',
    sourceRevision: context.sourceRevision, workflowRunnerRevision: context.workflowRunnerRevision,
    version: context.candidate.version, buildNumber: context.candidate.buildNumber,
    sourceCandidateSha256: context.sourceCandidateSha256, packageReceiptSha256: context.packageReceiptSha256,
    artifact: context.artifact, extractedIdentity: identity,
    preparationSha256: preparation.sha256, normalSmokeSha256: smokeFile.sha256,
    execution: 'exact_final_appimage_extracted_application', runtimeNetwork: 'none',
    appImageMountAndLauncher: 'not_exercised', publicPredecessorUpdate: 'not_exercised',
    physicalDesktop: 'not_qualified', rebuilt: false, published: false };
  await writeNew(context.paths.final, proof);
  return proof;
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [mode, flag, sourceRevision, ...rest] = process.argv.slice(2);
    if (!['--prepare', '--verify-runtime'].includes(mode) || flag !== '--source-revision' || rest.length
        || process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v26.2.0') fail('ARGUMENT_INVALID');
    const result = await (mode === '--prepare' ? prepareLinuxFinalAppImage : verifyLinuxFinalAppImageRuntime)({ sourceRevision });
    process.stdout.write(`${JSON.stringify({ status: mode === '--prepare' ? 'prepared' : result.status,
      sourceRevision, artifactSha256: result.artifact.sha256, published: false })}\n`);
  } catch (error) {
    process.stderr.write(`${/^LINUX_FINAL_APPIMAGE_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'LINUX_FINAL_APPIMAGE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
