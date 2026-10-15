#!/usr/bin/env node

// Digest-bound bootstrap preparation only. The current Node interpreter and
// host are the runner substrate; neither downloaded runtime nor pnpm is run.
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SCRIPT = fileURLToPath(import.meta.url);
export const WINDOWS_BUILD_BOOTSTRAP_POLICY = fileURLToPath(new URL("../config/windows-build-bootstrap.json", import.meta.url));
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAX_NODE_ARCHIVE = 64 * 1024 * 1024;
const MAX_PNPM_ARCHIVE = 16 * 1024 * 1024;
const MAX_UNPACKED = 32 * 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 60_000;
const BLOCK = 512;
const FORBIDDEN_AUTHORITY = Object.freeze([
  "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET", "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_ACCESS_TOKEN",
  "AZURE_CONFIG_DIR", "AZURE_AUTH_LOCATION", "ARM_CLIENT_ID", "ARM_CLIENT_SECRET",
  "ARM_TENANT_ID", "ARM_OIDC_TOKEN", "ARM_OIDC_TOKEN_FILE_PATH",
  "CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD",
]);
function fail(code) {
  const error = new Error(`WINDOWS_BUILD_BOOTSTRAP_${code}`);
  error.code = error.message;
  throw error;
}
function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function boundedInteger(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function canonicalBase64(value, maximum) {
  if (typeof value !== "string" || value.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) fail("POLICY_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maximum || bytes.toString("base64") !== value) fail("POLICY_INVALID");
  return bytes;
}
export function assertNoWindowsSigningAuthority(environment = process.env) {
  if (FORBIDDEN_AUTHORITY.some(name => environment[name] !== undefined && environment[name] !== "")) fail("SIGNING_AUTHORITY_PRESENT");
  if (environment.TIBOTATTLE_ELECTRON_SIGNING_MODE === "azure-trusted-signing") fail("SIGNING_AUTHORITY_PRESENT");
}
export function validateWindowsBuildBootstrapPolicy(policy) {
  if (!closed(policy, ["schemaVersion", "node", "pnpm"]) || policy.schemaVersion !== "tibotattle-windows-build-bootstrap-v1") fail("POLICY_INVALID");
  const node = policy.node;
  if (!closed(node, ["version", "archiveUrl", "archiveSha256", "archiveBytes", "archiveRoot"])
      || !VERSION.test(node.version) || !/^[a-f0-9]{64}$/u.test(node.archiveSha256)
      || !boundedInteger(node.archiveBytes, MAX_NODE_ARCHIVE)
      || node.archiveRoot !== `node-v${node.version}-win-x64`
      || node.archiveUrl !== `https://nodejs.org/dist/v${node.version}/${node.archiveRoot}.zip`) fail("POLICY_INVALID");
  const pnpm = policy.pnpm;
  if (!closed(pnpm, ["name", "version", "archiveUrl", "archiveBytes", "integrity", "fileCount", "unpackedBytes", "entrypoint", "signature"])
      || pnpm.name !== "pnpm" || !VERSION.test(pnpm.version)
      || pnpm.archiveUrl !== `https://registry.npmjs.org/pnpm/-/pnpm-${pnpm.version}.tgz`
      || !boundedInteger(pnpm.archiveBytes, MAX_PNPM_ARCHIVE) || !boundedInteger(pnpm.fileCount, 2048)
      || !boundedInteger(pnpm.unpackedBytes, MAX_UNPACKED) || pnpm.entrypoint !== "package/bin/pnpm.mjs"
      || typeof pnpm.integrity !== "string" || !pnpm.integrity.startsWith("sha512-")) fail("POLICY_INVALID");
  if (canonicalBase64(pnpm.integrity.slice(7), 64).length !== 64
      || !closed(pnpm.signature, ["keyId", "publicKey", "signature"])
      || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(pnpm.signature.keyId)) fail("POLICY_INVALID");
  try {
    const key = createPublicKey({ key: canonicalBase64(pnpm.signature.publicKey, 256), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
        || !verify("sha256", Buffer.from(`${pnpm.name}@${pnpm.version}:${pnpm.integrity}`), key,
          canonicalBase64(pnpm.signature.signature, 128))) fail("REGISTRY_SIGNATURE_INVALID");
  } catch { fail("REGISTRY_SIGNATURE_INVALID"); }
  return policy;
}
export async function readWindowsBuildBootstrapPolicy() {
  let policy;
  try { policy = JSON.parse(await readFile(WINDOWS_BUILD_BOOTSTRAP_POLICY, "utf8")); } catch { fail("POLICY_INVALID"); }
  return validateWindowsBuildBootstrapPolicy(policy);
}
function headerString(bytes) {
  const end = bytes.indexOf(0);
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  if ((end !== -1 && bytes.subarray(end).some(byte => byte !== 0))
      || content.some(byte => byte < 32 || byte > 126)) fail("TAR_HEADER_INVALID");
  return content.toString("ascii");
}
function octal(bytes) {
  const value = bytes.toString("ascii").replace(/[\0 ]+$/u, "").trim();
  if (!/^[0-7]{1,12}$/u.test(value)) fail("TAR_NUMBER_INVALID");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("TAR_NUMBER_INVALID");
  return number;
}
function archivePath(value) {
  if (typeof value !== "string" || value.length > 240 || !value.startsWith("package/")) fail("TAR_PATH_INVALID");
  const components = value.split("/");
  if (components.some(part => !/^[A-Za-z0-9@._+-]+$/u.test(part) || part === "." || part === ".."
      || part.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail("TAR_PATH_INVALID");
  return components;
}
/** Admit every header and payload before creating any output path. */
export function inspectWindowsPnpmArchive(archive, policy) {
  const pnpm = validateWindowsBuildBootstrapPolicy(policy).pnpm;
  if (!Buffer.isBuffer(archive) || archive.length !== pnpm.archiveBytes
      || `sha512-${createHash("sha512").update(archive).digest("base64")}` !== pnpm.integrity) fail("PNPM_ARCHIVE_DIGEST_MISMATCH");
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: pnpm.unpackedBytes + pnpm.fileCount * 1024 + BLOCK * 2 }); }
  catch { fail("TAR_INVALID_OR_TOO_LARGE"); }
  if (tar.length % BLOCK !== 0) fail("TAR_INVALID");
  let offset = 0;
  let unpackedBytes = 0;
  let terminated = false;
  const files = [];
  const paths = new Set();
  const directories = new Set();
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      if (offset + BLOCK * 2 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) fail("TAR_TRAILING_DATA");
      terminated = true;
      break;
    }
    const checksum = octal(header.subarray(148, 156));
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actualChecksum || header.subarray(257, 265).toString("binary") !== "ustar\0" + "00"
        || ![0, 48].includes(header[156]) || headerString(header.subarray(157, 257)) !== "") fail("TAR_HEADER_INVALID");
    if ((octal(header.subarray(100, 108)) & 0o7000) !== 0) fail("TAR_MODE_INVALID");
    const prefix = headerString(header.subarray(345, 500));
    const leaf = headerString(header.subarray(0, 100));
    const path = prefix ? `${prefix}/${leaf}` : leaf;
    const components = archivePath(path);
    const normalized = path.toLowerCase();
    if (paths.has(normalized) || directories.has(normalized)) fail("TAR_PATH_COLLISION");
    for (let count = 1; count < components.length; count += 1) {
      const parent = components.slice(0, count).join("/").toLowerCase();
      if (paths.has(parent)) fail("TAR_PATH_COLLISION");
      directories.add(parent);
    }
    paths.add(normalized);
    const size = octal(header.subarray(124, 136));
    unpackedBytes += size;
    if (unpackedBytes > pnpm.unpackedBytes || files.length >= pnpm.fileCount) fail("TAR_SIZE_INVALID");
    const bodyStart = offset + BLOCK;
    const next = bodyStart + Math.ceil(size / BLOCK) * BLOCK;
    if (next > tar.length || tar.subarray(bodyStart + size, next).some(byte => byte !== 0)) fail("TAR_SIZE_INVALID");
    files.push({ path, bytes: tar.subarray(bodyStart, bodyStart + size) });
    offset = next;
  }
  if (!terminated || files.length !== pnpm.fileCount || unpackedBytes !== pnpm.unpackedBytes
      || !files.some(file => file.path === pnpm.entrypoint)) fail("TAR_SET_INVALID");
  let metadata;
  try { metadata = JSON.parse(files.find(file => file.path === "package/package.json").bytes.toString("utf8")); }
  catch { fail("PACKAGE_METADATA_INVALID"); }
  if (metadata.name !== pnpm.name || metadata.version !== pnpm.version || metadata.bin?.pnpm !== "bin/pnpm.mjs"
      || Object.hasOwn(metadata, "dependencies") || Object.hasOwn(metadata, "optionalDependencies")) fail("PACKAGE_METADATA_INVALID");
  return files;
}
async function downloadBytes(url, expectedBytes, fetcher, deadlineMs) {
  const controller = new AbortController();
  const expiresAt = Date.now() + deadlineMs;
  let reader;
  async function withinDeadline(operation) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) fail("DOWNLOAD_TIMEOUT");
    let timer;
    // A fresh timer for each wait avoids retaining a handler per streamed
    // chunk on one long-lived pending timeout promise.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_TIMEOUT"), { code: "WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_TIMEOUT" })); }, remaining);
    });
    try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
    finally { clearTimeout(timer); }
  }
  try {
    const response = await withinDeadline(() => fetcher(url, { redirect: "error", signal: controller.signal }));
    if (!response?.ok || response.redirected || !response.body || (response.url && response.url !== url)) fail("DOWNLOAD_FAILED");
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && declared !== String(expectedBytes)) fail("DOWNLOAD_SIZE_INVALID");
    reader = response.body.getReader();
    // Bound memory by bytes, independently of peer-selected chunk count.
    const bytes = Buffer.alloc(expectedBytes);
    let total = 0;
    let consecutiveEmptyChunks = 0;
    while (true) {
      if (Date.now() >= expiresAt) fail("DOWNLOAD_TIMEOUT");
      const result = await withinDeadline(() => reader.read());
      if (Date.now() >= expiresAt) fail("DOWNLOAD_TIMEOUT");
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail("DOWNLOAD_FAILED");
      consecutiveEmptyChunks = result.value.length === 0 ? consecutiveEmptyChunks + 1 : 0;
      if (consecutiveEmptyChunks > 16) fail("DOWNLOAD_EMPTY_CHUNK_FLOOD");
      if (total + result.value.length > expectedBytes) fail("DOWNLOAD_SIZE_INVALID");
      bytes.set(result.value, total);
      total += result.value.length;
    }
    if (total !== expectedBytes) fail("DOWNLOAD_SIZE_INVALID");
    return bytes;
  } catch (error) {
    if (/^WINDOWS_BUILD_BOOTSTRAP_/u.test(error?.code ?? "")) throw error;
    fail("DOWNLOAD_FAILED");
  } finally {
    controller.abort();
    if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
  }
}
async function assertPlainParents(path, create = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if (error?.code !== "ENOENT") fail("OUTPUT_PATH_UNSAFE");
      if (!create) return;
      try { await mkdir(current, { mode: 0o700 }); } catch { fail("OUTPUT_PATH_UNSAFE"); }
      metadata = await lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("OUTPUT_PATH_UNSAFE");
  }
}
/** No downloaded code is executed; only completely admitted bytes reach disk. */
export async function prepareWindowsBuildBootstrap({ outputRoot } = {}, adapters = {}) {
  assertNoWindowsSigningAuthority(adapters.environment ?? process.env);
  const policy = validateWindowsBuildBootstrapPolicy(adapters.policy ?? await readWindowsBuildBootstrapPolicy());
  if (typeof outputRoot !== "string" || !outputRoot || /[\0\r\n]/u.test(outputRoot)) fail("OUTPUT_PATH_INVALID");
  const root = resolve(outputRoot);
  if (root === parse(root).root) fail("OUTPUT_PATH_INVALID");
  await assertPlainParents(dirname(root));
  try { await lstat(root); fail("OUTPUT_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const fetcher = adapters.fetcher ?? fetch;
  const deadlineMs = adapters.downloadDeadlineMs ?? DOWNLOAD_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DOWNLOAD_DEADLINE_MS) fail("DEADLINE_INVALID");
  const node = await downloadBytes(policy.node.archiveUrl, policy.node.archiveBytes, fetcher, deadlineMs);
  if (createHash("sha256").update(node).digest("hex") !== policy.node.archiveSha256) fail("NODE_ARCHIVE_DIGEST_MISMATCH");
  const pnpm = await downloadBytes(policy.pnpm.archiveUrl, policy.pnpm.archiveBytes, fetcher, deadlineMs);
  const files = inspectWindowsPnpmArchive(pnpm, policy);
  let ownedRoot;
  try {
    await assertPlainParents(dirname(root), true);
    await mkdir(root, { mode: 0o700 });
    ownedRoot = await lstat(root);
    await writeFile(join(root, "node.zip"), node, { flag: "wx", mode: 0o600 });
    for (const file of files) {
      const target = join(root, "pnpm", ...file.path.split("/"));
      await assertPlainParents(dirname(target), true);
      await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
    }
    const receipt = { schemaVersion: "tibotattle-windows-build-bootstrap-receipt-v1", status: "verified_not_executed",
      node: { version: policy.node.version, archiveSha256: policy.node.archiveSha256, archiveBytes: policy.node.archiveBytes },
      pnpm: { version: policy.pnpm.version, integrity: policy.pnpm.integrity, fileCount: files.length,
        unpackedBytes: policy.pnpm.unpackedBytes, registrySignature: "verified" },
      nodeArchive: "node.zip", pnpmEntrypoint: `pnpm/${policy.pnpm.entrypoint}` };
    await writeFile(join(root, "bootstrap-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error) {
    if (ownedRoot) {
      const current = await lstat(root).catch(() => null);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.ino === ownedRoot.ino && current.dev === ownedRoot.dev) await rm(root, { recursive: true, force: true });
    }
    if (/^WINDOWS_BUILD_BOOTSTRAP_/u.test(error?.code ?? "")) throw error;
    fail("EXTRACTION_FAILED");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 2 || args[0] !== "--output-root") fail("ARGUMENT_INVALID");
    return prepareWindowsBuildBootstrap({ outputRoot: args[1] });
  }).then(receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch(error => {
    process.stderr.write(`${/^WINDOWS_BUILD_BOOTSTRAP_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "WINDOWS_BUILD_BOOTSTRAP_FAILED"}\n`);
    process.exitCode = 1;
  });
}
