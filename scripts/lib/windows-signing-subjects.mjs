import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WINDOWS_SUBJECT_SCHEMA = 'tibotattle-windows-signing-subjects-v1';
export const WINDOWS_SIGNED_SUBJECT_SCHEMA = 'tibotattle-windows-signed-subjects-v1';
const HEX = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const APP_FILES = Object.freeze(['TiboTattle.exe', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll']);
const NATIVE_FILES = Object.freeze(['app/native/windows-filesystem/build/Release/windows_filesystem.node', 'app/node_modules/@github/keytar/prebuilds/win32-x64/keytar.node']);
const MAX_FILE = 1024 * 1024 * 1024;
function fail(code) { throw new Error(`WINDOWS_SIGNING_${code}`); }
function closed(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function signingSubjectPaths(stage, version) {
  if (!VERSION.test(version)) fail('SUBJECT_VERSION_INVALID');
  if (stage === 'native') return [...NATIVE_FILES];
  if (stage === 'application') return APP_FILES.map(name => `artifacts/win-unpacked/${name}`);
  if (stage === 'uninstaller') return [`artifacts/TiboTattle-${version}-Windows-x64.__uninstaller.exe`];
  if (stage === 'installer') return [`artifacts/TiboTattle-${version}-Windows-x64.exe`];
  fail('SUBJECT_STAGE_INVALID');
}
export function validateSigningSubjectManifest(manifest) {
  if (!closed(manifest, ['schemaVersion', 'sourceRevision', 'candidateSha256', 'version', 'buildNumber', 'stage', 'files'])
    || manifest.schemaVersion !== WINDOWS_SUBJECT_SCHEMA || !REVISION.test(manifest.sourceRevision)
    || !HEX.test(manifest.candidateSha256) || !VERSION.test(manifest.version)
    || typeof manifest.buildNumber !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(manifest.buildNumber)
    || !Array.isArray(manifest.files)) fail('SUBJECT_MANIFEST_INVALID');
  const expected = signingSubjectPaths(manifest.stage, manifest.version).sort();
  if (manifest.files.length !== expected.length) fail('SUBJECT_SET_INVALID');
  const actual = [];
  for (const item of manifest.files) {
    if (!closed(item, ['path', 'sha256', 'sizeBytes']) || !expected.includes(item.path)
      || !HEX.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes)
      || item.sizeBytes <= 0 || item.sizeBytes > MAX_FILE) fail('SUBJECT_ENTRY_INVALID');
    actual.push(item.path);
  }
  if (actual.sort().join('\0') !== expected.join('\0')) fail('SUBJECT_SET_INVALID');
  return manifest;
}

// Reject links in every path component, including the supplied root. Never
// follow a build artifact link into a different host location.
export async function assertPlainPath(root, portable, { directory = false } = {}) {
  if (typeof portable !== 'string' || portable.includes('\\') || portable.includes(':')
    || isAbsolute(portable) || portable.split('/').some(x => !x || x === '.' || x === '..')) fail('PATH_INVALID');
  const base = resolve(root);
  const target = resolve(base, portable);
  if (relative(base, target).startsWith(`..${sep}`)) fail('PATH_INVALID');
  let current = base;
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('ROOT_UNSAFE');
  const parts = portable.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('PATH_UNSAFE');
    if (index < parts.length - 1 || directory) {
      if (!info.isDirectory()) fail('PATH_UNSAFE');
    } else if (!info.isFile() || info.nlink !== 1) fail('FILE_UNSAFE');
  }
  return target;
}
export async function hashPlainFile(root, portable, maximum = MAX_FILE) {
  const path = await assertPlainPath(root, portable);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximum) fail('FILE_UNSAFE');
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      sizeBytes += bytes.length;
      if (sizeBytes > maximum) fail('FILE_TOO_LARGE');
      hash.update(bytes);
    }
    const after = await handle.stat();
    const pathState = await lstat(path);
    if (sizeBytes !== before.size || after.nlink !== 1 || pathState.nlink !== 1 || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || pathState.size !== before.size
      || pathState.mtimeMs !== before.mtimeMs || pathState.ctimeMs !== before.ctimeMs
      || pathState.ino !== before.ino || pathState.dev !== before.dev || pathState.isSymbolicLink()) fail('FILE_CHANGED');
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally { await handle.close(); }
}
export async function readWindowsSigningSubjectManifest(path, expectedSha256) {
  if (!HEX.test(expectedSha256)) fail('MANIFEST_DIGEST_REQUIRED');
  const bytes = await readPlainBytes(dirname(path), path.split(/[\\/]/u).at(-1), 64 * 1024);
  if (sha256(bytes) !== expectedSha256) fail('MANIFEST_DIGEST_MISMATCH');
  let value;
  try { value = JSON.parse(bytes); } catch { fail('SUBJECT_MANIFEST_INVALID'); }
  return validateSigningSubjectManifest(value);
}
export async function readPlainBytes(root, portable, maximum) {
  const path = await assertPlainPath(root, portable);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximum) fail('FILE_UNSAFE');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    const linked = await lstat(path);
    const keys = ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
    if (size !== before.size || !linked.isFile() || linked.isSymbolicLink()
      || keys.some(key => before[key] !== after[key] || before[key] !== linked[key])) fail('FILE_CHANGED');
    await assertPlainPath(root, portable);
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
export async function createWindowsSigningSubjectManifest({ root, sourceRevision, candidateSha256, version, buildNumber, stage, paths }) {
  const files = [];
  for (const path of paths ?? signingSubjectPaths(stage, version)) files.push({ path, ...await hashPlainFile(root, path) });
  return validateSigningSubjectManifest({ schemaVersion: WINDOWS_SUBJECT_SCHEMA, sourceRevision, candidateSha256, version, buildNumber, stage, files });
}
export async function verifyWindowsSigningSubjectManifest({ root, manifest, expectedSourceRevision, expectedCandidateSha256, expectedStage }) {
  validateSigningSubjectManifest(manifest);
  if (manifest.sourceRevision !== expectedSourceRevision || manifest.candidateSha256 !== expectedCandidateSha256
    || manifest.stage !== expectedStage) fail('SUBJECT_BINDING_MISMATCH');
  for (const file of manifest.files) {
    const evidence = await hashPlainFile(root, file.path);
    if (evidence.sha256 !== file.sha256 || evidence.sizeBytes !== file.sizeBytes) fail('SUBJECT_DIGEST_MISMATCH');
  }
  return manifest;
}
export function validateSignedSubjectReceipt(receipt, manifest, expectedManifestSha256) {
  if (!closed(receipt, ['schemaVersion', 'manifestSha256', 'sourceRevision', 'candidateSha256', 'stage', 'files'])
    || receipt.schemaVersion !== WINDOWS_SIGNED_SUBJECT_SCHEMA || !HEX.test(expectedManifestSha256)
    || receipt.manifestSha256 !== expectedManifestSha256 || receipt.sourceRevision !== manifest.sourceRevision
    || receipt.candidateSha256 !== manifest.candidateSha256 || receipt.stage !== manifest.stage
    || !Array.isArray(receipt.files) || receipt.files.length !== manifest.files.length) fail('SIGNED_RECEIPT_INVALID');
  const seen = new Set();
  for (const file of receipt.files) {
    const subject = manifest.files.find(x => x.path === file.path);
    if (!closed(file, ['path', 'beforeSha256', 'afterSha256', 'sizeBytes']) || !subject || seen.has(file.path)
      || file.beforeSha256 !== subject.sha256 || !HEX.test(file.afterSha256)
      || file.afterSha256 === file.beforeSha256 || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes <= 0 || file.sizeBytes > MAX_FILE) fail('SIGNED_RECEIPT_INVALID');
    seen.add(file.path);
  }
  return receipt;
}
export async function applyWindowsSignedSubjects({ root, signedRoot, manifest, receipt, expectedManifestSha256 }) {
  validateSigningSubjectManifest(manifest);
  validateSignedSubjectReceipt(receipt, manifest, expectedManifestSha256);
  await verifyWindowsSigningSubjectManifest({ root, manifest, expectedSourceRevision: manifest.sourceRevision,
    expectedCandidateSha256: manifest.candidateSha256, expectedStage: manifest.stage });
  // Admit the entire batch before replacing any input. A later interruption
  // never manufactures an all-files-complete receipt; reruns reject mixed bytes.
  for (const file of receipt.files) {
    const evidence = await hashPlainFile(signedRoot, file.path);
    if (evidence.sha256 !== file.afterSha256 || evidence.sizeBytes !== file.sizeBytes) fail('SIGNED_SUBJECT_MISMATCH');
  }
  for (const file of receipt.files) {
    const target = await assertPlainPath(root, file.path);
    const before = await hashPlainFile(root, file.path);
    if (before.sha256 !== file.beforeSha256) fail('SUBJECT_DIGEST_MISMATCH');
    const temporary = `${target}.signed-transfer`;
    let ownsTemporary = false;
    try {
      await copyFile(await assertPlainPath(signedRoot, file.path), temporary, constants.COPYFILE_EXCL);
      ownsTemporary = true;
      const evidence = await hashPlainFile(dirname(temporary), temporary.split(/[\\/]/u).at(-1));
      if (evidence.sha256 !== file.afterSha256 || evidence.sizeBytes !== file.sizeBytes) fail('SIGNED_SUBJECT_MISMATCH');
      await rename(temporary, target);
    } catch (error) { if (ownsTemporary) await unlink(temporary).catch(() => {}); throw error; }
  }
  return receipt;
}
