import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlainPath, hashPlainFile, sha256 } from './windows-signing-subjects.mjs';

export const WINDOWS_TOOLCHAIN_POLICY = fileURLToPath(new URL('../../config/windows-signing-toolchain.json', import.meta.url));
const SHA = /^[a-f0-9]{64}$/u;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
function fail(code) { throw new Error(`WINDOWS_SIGNING_TOOLCHAIN_${code}`); }
function closed(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === keys.sort().join('\0'); }
function safePath(value) {
  return typeof value === 'string' && value.length < 240 && /^[A-Za-z0-9_./-]+$/u.test(value)
    && value.split('/').every(x => x && x !== '.' && x !== '..' && !x.endsWith('.')
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(x));
}
export function validateWindowsSigningToolchain(policy) {
  if (!closed(policy, ['schemaVersion', 'status', 'tools', 'files']) || policy.schemaVersion !== 'tibotattle-windows-signing-toolchain-v1') fail('POLICY_INVALID');
  if (policy.status === 'provisioning_required' && policy.tools === null && Array.isArray(policy.files) && policy.files.length === 0) fail('PROVISIONING_REQUIRED');
  if (policy.status !== 'reviewed' || !closed(policy.tools, ['signtool', 'dlib']) || !Array.isArray(policy.files)
    || policy.files.length < 2 || policy.files.length > 2048) fail('POLICY_INVALID');
  const seen = new Set(); let total = 0;
  for (const file of policy.files) {
    if (!closed(file, ['path', 'sha256', 'sizeBytes', 'sourceUrl', 'publisherCertificateSha256'])
      || !safePath(file.path) || seen.has(file.path.toLowerCase()) || !SHA.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_FILE
      || !/^https:\/\//u.test(file.sourceUrl) || file.sourceUrl.length > 2048) fail('FILE_INVALID');
    const source = new URL(file.sourceUrl);
    if (source.username || source.password || source.hash || source.port) fail('SOURCE_INVALID');
    // PE tools and managed assemblies require independent publisher evidence;
    // other runtime metadata remains digest-bound without claiming a signature.
    if (/\.(?:exe|dll)$/iu.test(file.path) ? !SHA.test(file.publisherCertificateSha256)
      : file.publisherCertificateSha256 !== null) fail('PUBLISHER_REQUIRED');
    total += file.sizeBytes; seen.add(file.path.toLowerCase());
  }
  if (typeof policy.tools.signtool !== 'string' || typeof policy.tools.dlib !== 'string'
    || total > MAX_TOTAL || !seen.has(policy.tools.signtool.toLowerCase()) || !seen.has(policy.tools.dlib.toLowerCase())
    || !/\/signtool\.exe$/iu.test(`/${policy.tools.signtool}`) || !/\/Azure\.CodeSigning\.Dlib\.dll$/iu.test(`/${policy.tools.dlib}`)) fail('TOOLS_INVALID');
  return policy;
}
export async function readWindowsSigningToolchain() {
  return validateWindowsSigningToolchain(JSON.parse(await readFile(WINDOWS_TOOLCHAIN_POLICY, 'utf8')));
}
export async function verifyWindowsSigningToolchain({ root, policy, verifyPublisher }) {
  validateWindowsSigningToolchain(policy);
  if (typeof verifyPublisher !== 'function') fail('PUBLISHER_VERIFIER_REQUIRED');
  const files = new Set(policy.files.map(x => x.path));
  const dirs = new Set();
  for (const file of files) { const parts = file.split('/'); parts.pop(); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); } }
  async function visit(directory = '') {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (entry.isDirectory() ? !dirs.has(path) : !entry.isFile() || !files.has(path))) fail('UNEXPECTED_INPUT');
      if (entry.isDirectory()) { await assertPlainPath(root, path, { directory: true }); await visit(path); }
    }
  }
  await visit();
  for (const file of policy.files) {
    const evidence = await hashPlainFile(root, file.path, MAX_FILE);
    if (evidence.sha256 !== file.sha256 || evidence.sizeBytes !== file.sizeBytes) fail('DIGEST_MISMATCH');
    if (file.publisherCertificateSha256 !== null && !await verifyPublisher(await assertPlainPath(root, file.path), file.publisherCertificateSha256)) fail('PUBLISHER_MISMATCH');
    const after = await hashPlainFile(root, file.path, MAX_FILE);
    if (after.sha256 !== evidence.sha256) fail('CHANGED');
  }
  return Object.freeze({ policySha256: sha256(Buffer.from(JSON.stringify(policy))), root: resolve(root), tools: policy.tools });
}
// This fetcher is used only by a job without OIDC. The privileged signer never
// invokes it or follows redirects. Each downloaded file is independently pinned.
export async function downloadWindowsSigningToolchain({ root, policy, fetcher = fetch, downloadDeadlineMs = 60_000 }) {
  validateWindowsSigningToolchain(policy);
  if (!Number.isSafeInteger(downloadDeadlineMs) || downloadDeadlineMs < 1 || downloadDeadlineMs > 60_000) fail('DOWNLOAD_DEADLINE_INVALID');
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const file of policy.files) {
    const controller = new AbortController();
    const expiresAt = Date.now() + downloadDeadlineMs;
    let iterator;
    // A fresh cleared timer per await avoids accumulating Promise.race handlers
    // on one shared deadline promise when a peer sends many tiny chunks.
    async function bounded(operation) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) fail('DOWNLOAD_TIMEOUT');
      let timer;
      try {
        return await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('WINDOWS_SIGNING_TOOLCHAIN_DOWNLOAD_TIMEOUT')); }, remaining);
        })]);
      } finally { clearTimeout(timer); }
    }
    try {
      const response = await bounded(() => fetcher(file.sourceUrl, { redirect: 'error', signal: controller.signal }));
      if (!response.ok || !response.body || response.redirected || (response.url && response.url !== file.sourceUrl)) fail('DOWNLOAD_FAILED');
      iterator = response.body[Symbol.asyncIterator]();
      const bytes = Buffer.alloc(file.sizeBytes);
      let size = 0; let emptyChunks = 0;
      while (true) {
        const result = await bounded(() => iterator.next());
        if (Date.now() >= expiresAt) fail('DOWNLOAD_TIMEOUT');
        if (result.done) break;
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) fail('DOWNLOAD_FAILED');
        emptyChunks = chunk.length === 0 ? emptyChunks + 1 : 0;
        if (emptyChunks > 16) fail('DOWNLOAD_EMPTY_CHUNK_FLOOD');
        if (size + chunk.length > file.sizeBytes) fail('DOWNLOAD_SIZE_INVALID');
        bytes.set(chunk, size); size += chunk.length;
      }
      if (size !== file.sizeBytes || sha256(bytes) !== file.sha256) fail('DOWNLOAD_DIGEST_MISMATCH');
      const path = join(root, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    } finally {
      controller.abort();
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
    }
  }
  return root;
}
