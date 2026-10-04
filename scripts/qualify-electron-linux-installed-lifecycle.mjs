#!/usr/bin/env node
// Prepare exact prebuilt bytes. Execution is a separate network-none container step.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxAppImageIdentity } from './build-linux-updater-rehearsal.mjs';
import { readLinuxPackagedAsarManifest } from './smoke-electron-linux-packaged.mjs';
import { LINUX_FINAL_INPUT, LINUX_FINAL_PREDECESSOR, LINUX_FINAL_FEED, linuxFinalFailure as fail,
  preflightLinuxFinalIntake, linuxFinalArtifactName, validateLinuxFinalPackageRun,
  validateLinuxFinalPackageReceipt, validateLinuxFinalPair, sha256 } from './lib/linux-final-artifact-intake.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'adamallcock/tibotattle';
const LIMIT = 1024 ** 3;
export async function fingerprintLinuxFinalFile(path, maximum = LIMIT, keep = false) {
  if (await realpath(path) !== path) fail('FILE_UNSAFE');
  const before = await lstat(path, { bigint: true });
  const same = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => before[k] === stat[k]);
  if (!same(before) || before.size < 1n || before.size > BigInt(maximum)) fail('FILE_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(await handle.stat({ bigint: true }))) fail('FILE_CHANGED');
    const hash = createHash('sha256'), chunks = []; let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length; if (count > maximum) fail('FILE_CHANGED');
      hash.update(chunk); if (keep) chunks.push(chunk);
    }
    if (count !== Number(before.size) || !same(await handle.stat({ bigint: true }))
      || !same(await lstat(path, { bigint: true }))) fail('FILE_CHANGED');
    return { bytes: count, sha256: hash.digest('hex'), ...(keep ? { contents: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}
async function writeNew(path, value) {
  if (await realpath(dirname(path)) !== dirname(path)) fail('PATH_UNSAFE');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
async function api(path, token) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) fail('GITHUB_READ_FAILED');
  const text = await response.text(); if (Buffer.byteLength(text) > 1024 * 1024) fail('GITHUB_READ_FAILED');
  return JSON.parse(text);
}
async function download(url, path, { token, maximum = LIMIT } = {}) {
  // Forward the token only to the fixed GitHub API origin. Redirect downloads
  // receive no authorization header and are bounded before any bytes execute.
  const first = new URL(url);
  if (first.protocol !== 'https:' || !['github.com', 'api.github.com'].includes(first.hostname)) fail('DOWNLOAD_URL_INVALID');
  let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: token ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } : {} });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const redirected = new URL(response.headers.get('location'));
    if (redirected.protocol !== 'https:' || redirected.username || redirected.password
      || !(/\.blob\.core\.windows\.net$/u.test(redirected.hostname)
        || /\.githubusercontent\.com$/u.test(redirected.hostname))) fail('DOWNLOAD_REDIRECT_INVALID');
    response = await fetch(redirected, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  }
  if (!response.ok || Number(response.headers.get('content-length')) > maximum) fail('DOWNLOAD_FAILED');
  const handle = await open(path, 'wx', 0o600); let count = 0;
  try {
    for await (const chunk of response.body) { count += chunk.length; if (count > maximum) fail('DOWNLOAD_TOO_LARGE'); await handle.writeFile(chunk); }
    if (!count) fail('DOWNLOAD_FAILED'); await handle.sync();
  } finally { await handle.close(); }
}
// Python's standard ZIP reader inspects the complete central directory first;
// extraction selects fixed names, creates new files only, and never follows ZIP paths.
export const LINUX_FINAL_ZIP_EXTRACTOR = String.raw`
import json, os, stat, sys, zipfile
archive, destination, expected_json = sys.argv[1:]
expected = json.loads(expected_json)
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    names = [x.filename for x in entries]
    if sorted(names) != sorted(expected) or len(set(names)) != len(names): raise ValueError('entry set')
    for x in entries:
        mode = x.external_attr >> 16
        if x.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or x.flag_bits & 1: raise ValueError('entry type')
        limit = 1073741824 if x.filename.endswith('.AppImage') else 131072
        if x.file_size < 1 or x.file_size > limit: raise ValueError('entry size')
    for name in expected:
        target = os.path.join(destination, name)
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        with z.open(name) as source, open(target, 'xb') as output:
            os.chmod(target, 0o600)
            count = 0
            while True:
                block = source.read(1024 * 1024)
                if not block: break
                count += len(block)
                if count > z.getinfo(name).file_size: raise ValueError('entry growth')
                output.write(block)
            if count != z.getinfo(name).file_size: raise ValueError('entry truncated')
            output.flush(); os.fsync(output.fileno())
`;
export async function acquireLinuxFinalArtifacts(intake, { root = ROOT, token = process.env.GITHUB_TOKEN } = {}) {
  if (typeof token !== 'string' || !token.length) fail('GITHUB_AUTH_REQUIRED');
  const directory = join(root, LINUX_FINAL_INPUT);
  await mkdir(directory, { mode: 0o700 });
  const run = await api(`actions/runs/${intake.packageRunId}`, token);
  validateLinuxFinalPackageRun(run, intake);
  const collection = await api(`actions/runs/${intake.packageRunId}/artifacts?per_page=100`, token);
  if (!Number.isInteger(collection.total_count) || collection.total_count > 100 || !Array.isArray(collection.artifacts)) fail('ARTIFACT_SET_INVALID');
  const matches = collection.artifacts.filter(row => row.name === linuxFinalArtifactName(intake));
  if (matches.length !== 1 || matches[0].expired || !Number.isSafeInteger(matches[0].id)
    || matches[0].size_in_bytes < 4096 || matches[0].size_in_bytes > LIMIT) fail('ARTIFACT_SET_INVALID');
  const archive = join(directory, 'package.zip');
  await download(`https://api.github.com/repos/${REPO}/actions/artifacts/${matches[0].id}/zip`, archive, { token });
  const files = [`artifacts/TiboTattle-${intake.version}-linux-x86_64.AppImage`, 'artifacts/latest-linux.yml',
    'production-source-candidate.json', 'app-update.yml', 'linux-production-package-receipt.json',
    'final-runtime/final-image-preparation.json', 'final-runtime/normal-packaged-smoke.json', 'final-runtime/final-image-runtime.json'];
  const extracted = join(directory, 'package'); await mkdir(extracted, { mode: 0o700 });
  const result = spawnSync('python3', ['-c', LINUX_FINAL_ZIP_EXTRACTOR, archive, extracted, JSON.stringify(files)],
    { shell: false, stdio: 'ignore', timeout: 120000 });
  if (result.error || result.status !== 0 || result.signal) fail('ARCHIVE_INVALID');
  const source = await fingerprintLinuxFinalFile(join(extracted, 'production-source-candidate.json'), 131072, true);
  const packaged = await fingerprintLinuxFinalFile(join(extracted, 'linux-production-package-receipt.json'), 131072, true);
  if (packaged.sha256 !== intake.packageReceiptSha256) fail('PACKAGE_RECEIPT_CHANGED');
  const receipt = validateLinuxFinalPackageReceipt(JSON.parse(packaged.contents), intake, source.contents);
  const candidate = join(extracted, files[0]);
  if ((await fingerprintLinuxFinalFile(candidate)).sha256 !== intake.artifactSha256) fail('FINAL_BYTES_INVALID');
  await copyFile(candidate, join(directory, 'next.AppImage'), constants.COPYFILE_EXCL);
  await download(`https://github.com/${REPO}/releases/download/v0.1.26/release-manifest.json`, join(directory, 'predecessor-manifest.json'), { maximum: 131072 });
  const manifest = await fingerprintLinuxFinalFile(join(directory, 'predecessor-manifest.json'), 131072, true);
  if (manifest.sha256 !== LINUX_FINAL_PREDECESSOR.manifestSha256) fail('PREDECESSOR_INVALID');
  const entry = JSON.parse(manifest.contents).artifacts.find(row => row.fileName === LINUX_FINAL_PREDECESSOR.file);
  if (entry?.sha256 !== LINUX_FINAL_PREDECESSOR.sha256 || entry.bytes !== LINUX_FINAL_PREDECESSOR.bytes
    || entry.source?.commit !== LINUX_FINAL_PREDECESSOR.sourceRevision) fail('PREDECESSOR_INVALID');
  await download(`https://github.com/${REPO}/releases/download/v0.1.26/${LINUX_FINAL_PREDECESSOR.file}`, join(directory, 'current.AppImage'));
  if ((await fingerprintLinuxFinalFile(join(directory, 'current.AppImage'))).sha256 !== LINUX_FINAL_PREDECESSOR.sha256) fail('PREDECESSOR_INVALID');
  await writeNew(join(directory, 'intake.json'), intake);
  await writeNew(join(directory, 'package-receipt.json'), receipt);
  return { status: 'acquired', published: false, rebuilt: false };
}
export async function prepareLinuxFinalArtifacts(intake, { root = ROOT } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v26.2.0') fail('NATIVE_HOST_REQUIRED');
  const directory = join(root, LINUX_FINAL_INPUT), images = {};
  const source = await fingerprintLinuxFinalFile(join(directory, 'package/production-source-candidate.json'), 131072, true);
  const receiptFile = await fingerprintLinuxFinalFile(join(directory, 'package/linux-production-package-receipt.json'), 131072, true);
  if (receiptFile.sha256 !== intake.packageReceiptSha256) fail('PACKAGE_RECEIPT_CHANGED');
  const receipt = validateLinuxFinalPackageReceipt(JSON.parse(receiptFile.contents), intake, source.contents);
  if ((await fingerprintLinuxFinalFile(join(directory, 'predecessor-manifest.json'), 131072)).sha256 !== LINUX_FINAL_PREDECESSOR.manifestSha256) fail('PREDECESSOR_INVALID');
  for (const role of ['current', 'next']) {
    const path = join(directory, `${role}.AppImage`);
    const expected = role === 'current' ? LINUX_FINAL_PREDECESSOR : { ...receipt.artifact, version: intake.version, sourceRevision: intake.sourceRevision };
    const initial = await fingerprintLinuxFinalFile(path), image = await linuxAppImageIdentity(path);
    if (image.sha256 !== expected.sha256 || image.bytes !== expected.bytes || initial.sha256 !== image.sha256) fail('FINAL_BYTES_INVALID');
    await chmod(path, 0o700);
    const extraction = join(directory, `${role}-inspection`); await mkdir(extraction, { mode: 0o700 });
    const result = spawnSync(path, ['--appimage-extract'], { cwd: extraction, shell: false, stdio: 'ignore', timeout: 120000 });
    if (result.error || result.status !== 0 || result.signal) fail('EXTRACTION_FAILED');
    const app = join(extraction, 'squashfs-root');
    const asar = await fingerprintLinuxFinalFile(join(app, 'resources/app.asar'));
    const executable = await fingerprintLinuxFinalFile(join(app, 'tibotattle'));
    const manifest = await readLinuxPackagedAsarManifest(join(app, 'resources/app.asar'));
    if (manifest.version !== expected.version || manifest.tibotattleDistribution?.sourceRevision !== expected.sourceRevision
      || manifest.tibotattleDistribution?.target !== 'linux-x64' || manifest.tibotattleDistribution?.updateFeed !== LINUX_FINAL_FEED
      || (role === 'next' && (asar.sha256 !== intake.asarSha256 || executable.sha256 !== intake.executableSha256))) fail('ASAR_IDENTITY_INVALID');
    if ((await fingerprintLinuxFinalFile(path)).sha256 !== initial.sha256) fail('FILE_CHANGED');
    images[role] = { file: `${role}.AppImage`, version: expected.version, sourceRevision: expected.sourceRevision,
      ...image, asarSha256: asar.sha256, executableSha256: executable.sha256 };
  }
  const pair = validateLinuxFinalPair({ schemaVersion: 'tibotattle-linux-final-artifact-pair-v1', intake,
    predecessorManifestSha256: LINUX_FINAL_PREDECESSOR.manifestSha256, images }, intake.runnerRevision);
  await writeNew(join(directory, 'pair.json'), pair);
  return { status: 'prepared', artifactSha256: images.next.sha256, published: false, rebuilt: false };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (rest.length || !['--preflight', '--acquire', '--prepare'].includes(mode)) fail('ARGUMENT_INVALID');
    const intake = preflightLinuxFinalIntake(process.env, { repositoryRoot: ROOT });
    if (mode !== '--preflight' && process.env.SELECTED_MODE !== 'execute') fail('CONFIRMATION_INVALID');
    const result = mode === '--preflight' ? { status: 'admitted', sourceRevision: intake.sourceRevision, runnerRevision: intake.runnerRevision, published: false }
      : await (mode === '--acquire' ? acquireLinuxFinalArtifacts : prepareLinuxFinalArtifacts)(intake);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${/^LINUX_FINAL_LIFECYCLE_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'LINUX_FINAL_LIFECYCLE_PREPARATION_FAILED'}\n`); process.exitCode = 1;
  }
}
