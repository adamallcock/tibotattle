#!/usr/bin/env node

/** Local, recoverable integrity rebinding; never signs or qualifies a release. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyStagedElectronRuntime } from "./build-electron-runtime.mjs";
import { buildWindowsFilesystemBindingManifest } from "./build-windows-filesystem-manifest.mjs";
import { preflightElectronWindowsSigning } from "./finalize-electron-windows-signing.mjs";
import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const SCHEMA = "tibotattle-windows-native-rebinding-v1";
const FS = "native/windows-filesystem/build/Release/windows_filesystem.node";
const SIDECAR = `${FS}.manifest.json`;
const KEYTAR = "node_modules/@github/keytar/build/Release/keytar.node";
const MANIFEST = "electron-runtime-manifest.json";
const NATIVES = Object.freeze([FS, KEYTAR]);
const MAX_FILE = 128 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function fail(code) {
  const error = new Error(`WINDOWS_NATIVE_REBIND_${code}`);
  error.code = error.message;
  throw error;
}
function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
async function safePath(root, path) {
  const leaf = relative(root, path);
  if (!leaf || leaf === ".." || leaf.startsWith(`..${sep}`)) fail("PATH_INVALID");
  let current = root;
  for (const part of [null, ...leaf.split(sep)]) {
    if (part !== null) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory())) fail("PATH_UNSAFE");
  }
}
async function capture(root, path, maximum = MAX_FILE) {
  await safePath(root, path);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum) {
    fail("FILE_UNSAFE");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || after.nlink !== 1 || bytes.length !== after.size) {
    fail("FILE_CHANGED");
  }
  return bytes;
}
async function exclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function parse(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail("JSON_INVALID"); }
}
function digestRows(rows) {
  const digest = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    digest.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: digest.digest("hex") };
}
function assertOriginalBinding(manifest, sidecarBytes) {
  const sidecar = parse(sidecarBytes);
  const bindingRow = manifest.files.find((row) => row.path === FS);
  const sidecarRow = manifest.files.find((row) => row.path === SIDECAR);
  if (!bindingRow || !sidecarRow || sidecarRow.sha256 !== hash(sidecarBytes)
      || sidecarRow.bytes !== sidecarBytes.length || sidecar.bytes !== bindingRow.bytes
      || sidecar.sha256 !== bindingRow.sha256
      || manifest.windowsBinding?.binding?.bytes !== bindingRow.bytes
      || manifest.windowsBinding?.binding?.sha256 !== bindingRow.sha256
      || manifest.windowsBinding?.binding?.path !== FS
      || manifest.windowsBinding?.manifest?.path !== SIDECAR) fail("ORIGINAL_BINDING_INVALID");
}

/** Compare PE content while excluding only fields changed by Authenticode. */
export function windowsNativeUnsignedContentDigest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 256 || bytes.length > MAX_FILE
      || bytes.readUInt16LE(0) !== 0x5a4d) fail("PE_INVALID");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550
      || bytes.readUInt16LE(pe + 4) !== 0x8664) fail("PE_INVALID");
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const directory = optional + 112;
  if (optionalSize < 152 || optional + optionalSize > bytes.length
      || bytes.readUInt16LE(optional) !== 0x20b
      || bytes.readUInt32LE(optional + 108) < 5) fail("PE_INVALID");
  const security = directory + 32;
  const certificateOffset = bytes.readUInt32LE(security);
  const certificateSize = bytes.readUInt32LE(security + 4);
  let end = bytes.length;
  if (certificateOffset !== 0 || certificateSize !== 0) {
    if (certificateOffset < optional + optionalSize || certificateOffset % 8 !== 0
        || certificateSize < 8 || certificateSize % 8 !== 0
        || certificateOffset + certificateSize !== bytes.length) fail("PE_INVALID");
    end = certificateOffset;
  }
  const unsigned = Buffer.from(bytes.subarray(0, end));
  unsigned.fill(0, optional + 64, optional + 68);
  unsigned.fill(0, security, security + 8);
  return hash(unsigned);
}

async function selected(options, dependencies) {
  const root = resolve(dependencies.repositoryRoot ?? ROOT);
  const candidatePath = join(root, ".release-build/electron-production/win32-x64/production-source-candidate.json");
  if (typeof options.candidateReceiptPath !== "string"
      || resolve(options.candidateReceiptPath) !== candidatePath) fail("CANDIDATE_PATH_INVALID");
  const preflight = await preflightElectronWindowsSigning(options, { repositoryRoot: root, environment: {} });
  const candidate = preflight.candidate;
  const stage = join(dirname(candidatePath), "app");
  const journalRoot = join(dirname(candidatePath), "windows-native-rebinding");
  return { root, candidate, candidatePath, stage, journalRoot, journalPath: join(journalRoot, "journal.json") };
}
function assertHost(dependencies) {
  if ((dependencies.platform ?? process.platform) !== "win32"
      || (dependencies.architecture ?? process.arch) !== "x64"
      || (dependencies.version ?? process.version) !== "v26.2.0") fail("NATIVE_WINDOWS_REQUIRED");
}
async function snapshot(context) {
  const { root, stage, candidate } = context;
  const { manifest } = await verifyStagedElectronRuntime({ output: stage, target: "win32-x64", version: candidate.version });
  const packageMetadata = parse(await capture(root, join(stage, "package.json"), 128 * 1024));
  if (packageMetadata.name !== "app-usagemonitor" || packageMetadata.version !== candidate.version
      || !isDeepStrictEqual(packageMetadata.tibotattleDistribution, createProductionDistributionMetadata({
        target: "win32-x64", buildNumber: candidate.buildNumber, sourceRevision: candidate.sourceRevision,
      })) || Object.hasOwn(packageMetadata, "tibotattleAccountlessHostedRehearsal")
      || Object.hasOwn(packageMetadata, "tibotattleAccountlessSignedStagingRehearsal")) fail("PACKAGE_IDENTITY_INVALID");
  if (manifest.windowsBinding?.included !== true || manifest.windowsBinding?.verified !== false
      || manifest.windowsBinding?.status !== "included_unverified") fail("POLICY_INVALID");
  const nativeContent = {};
  for (const path of NATIVES) nativeContent[path] = windowsNativeUnsignedContentDigest(await capture(root, join(stage, path)));
  const manifestBytes = await capture(root, join(stage, MANIFEST), 8 * 1024 * 1024);
  const sidecarBytes = await capture(root, join(stage, SIDECAR), 128 * 1024);
  assertOriginalBinding(manifest, sidecarBytes);
  return { schemaVersion: SCHEMA, candidate, manifestBase64: manifestBytes.toString("base64"),
    sidecarBase64: sidecarBytes.toString("base64"), nativeContent };
}

export async function inspectWindowsNativeRebinding(options = {}, dependencies = {}) {
  const context = await selected(options, dependencies);
  await snapshot(context);
  return { schemaVersion: SCHEMA, candidate: context.candidate, status: "original_stage_verified", signing: "not_performed", windowsRuntimeQualification: "required" };
}
export async function prepareWindowsNativeRebinding(options = {}, dependencies = {}) {
  const context = await selected(options, dependencies);
  const journal = await snapshot(context);
  // mkdir without recursive is the no-clobber boundary, including symlinks.
  await mkdir(context.journalRoot, { mode: 0o700 });
  await safePath(context.root, context.journalRoot);
  await exclusive(context.journalPath, jsonBytes(journal));
  return { schemaVersion: SCHEMA, candidate: context.candidate, status: "pre_sign_journal_prepared", signing: "not_performed", windowsRuntimeQualification: "required" };
}

function verifyAuthenticode(path) {
  // Fixed script and environment-carried path avoid shell/path interpolation.
  // This checks Windows trust, publisher and timestamp presence only. The
  // final signer must separately qualify SHA-256 file/timestamp algorithms.
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:TIBOTATTLE_NATIVE_VERIFY_PATH; if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne 'Adam Allcock') { exit 3 }; exit 0";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, TIBOTATTLE_NATIVE_VERIFY_PATH: path }, stdio: "ignore", timeout: 30000,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) fail("SIGNATURE_UNVERIFIED");
}
async function assertInventory(context, manifest, replacements) {
  const expectedFiles = new Set([MANIFEST, ...manifest.files.map((row) => row.path)]);
  const expectedDirectories = new Set();
  for (const path of expectedFiles) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) expectedDirectories.add(parts.slice(0, count).join("/"));
  }
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!expectedDirectories.delete(path)) fail("INVENTORY_CHANGED");
        await walk(join(directory, entry.name), path);
      } else if (!entry.isFile() || !expectedFiles.delete(path)) fail("INVENTORY_CHANGED");
    }
  }
  await walk(context.stage);
  if (expectedFiles.size || expectedDirectories.size) fail("INVENTORY_CHANGED");
  for (const row of manifest.files) {
    const bytes = await capture(context.root, join(context.stage, row.path));
    if (replacements.has(row.path)) {
      if (!replacements.get(row.path).some((allowed) => bytes.equals(allowed))) fail("INVENTORY_CHANGED");
    } else if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail("INVENTORY_CHANGED");
  }
}
async function atomicReplace(context, path, previous, next, temporaryLeaf) {
  const current = await capture(context.root, path);
  if (current.equals(next)) return;
  if (!current.equals(previous)) fail("METADATA_CHANGED");
  const temporary = join(context.journalRoot, temporaryLeaf);
  try { await exclusive(temporary, next); } catch (error) {
    if (error.code !== "EEXIST" || !(await capture(context.root, temporary)).equals(next)) throw error;
  }
  if (!(await capture(context.root, path)).equals(previous)) fail("METADATA_CHANGED");
  await rename(temporary, path);
  // The content was fsynced before rename. Node's Windows directory-handle
  // contract cannot establish power-loss durability here; the journal proves
  // process-interruption recovery only, and receipts retain that limitation.
}
async function rebind(options, dependencies) {
  assertHost(dependencies);
  const context = await selected(options, dependencies);
  const journal = parse(await capture(context.root, context.journalPath, 16 * 1024 * 1024));
  if (!exactKeys(journal, ["schemaVersion", "candidate", "manifestBase64", "sidecarBase64", "nativeContent"])
      || journal.schemaVersion !== SCHEMA || !isDeepStrictEqual(journal.candidate, context.candidate)
      || !exactKeys(journal.nativeContent, NATIVES)
      || typeof journal.manifestBase64 !== "string" || typeof journal.sidecarBase64 !== "string") fail("JOURNAL_INVALID");
  const originalManifestBytes = Buffer.from(journal.manifestBase64, "base64");
  const originalSidecarBytes = Buffer.from(journal.sidecarBase64, "base64");
  const manifest = parse(originalManifestBytes);
  const originalSidecar = parse(originalSidecarBytes);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 50000) fail("JOURNAL_INVALID");
  let previousPath = "";
  for (const row of manifest.files) {
    if (!exactKeys(row, ["path", "bytes", "kind", "sha256"])
        || typeof row.path !== "string" || row.path.length > 512
        || !/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/u.test(row.path)
        || row.path.split("/").some((part) => part === "." || part === "..")
        || row.path <= previousPath || row.path === MANIFEST
        || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_FILE
        || typeof row.kind !== "string" || !/^[0-9a-f]{64}$/u.test(row.sha256)) fail("JOURNAL_INVALID");
    previousPath = row.path;
  }
  if (manifest.target !== "win32" || manifest.architecture !== "x64"
      || manifest.releaseVersion !== context.candidate.version
      || manifest.windowsBinding?.verified !== false
      || manifest.windowsBinding?.status !== "included_unverified"
      || !isDeepStrictEqual(manifest.payload, digestRows(manifest.files))) fail("JOURNAL_INVALID");
  assertOriginalBinding(manifest, originalSidecarBytes);
  const replacements = new Map();
  for (const path of NATIVES) {
    const bytes = await capture(context.root, join(context.stage, path));
    if (windowsNativeUnsignedContentDigest(bytes) !== journal.nativeContent[path]) fail("NATIVE_CONTENT_CHANGED");
    await (dependencies.verifySignature ?? verifyAuthenticode)(join(context.stage, path));
    if (!(await capture(context.root, join(context.stage, path))).equals(bytes)) fail("FILE_CHANGED");
    replacements.set(path, [bytes]);
  }
  let generatedSidecar;
  await buildWindowsFilesystemBindingManifest({
    bindingPath: join(context.stage, FS),
    readBinding: async () => replacements.get(FS)[0],
    ...(dependencies.loadBinding ? { loadBinding: dependencies.loadBinding } : {}),
    writeManifest: async (_path, bytes) => { generatedSidecar = Buffer.from(bytes); },
  });
  const sidecar = parse(generatedSidecar);
  const expectedSidecar = { ...originalSidecar, bytes: sidecar.bytes, sha256: sidecar.sha256 };
  if (!isDeepStrictEqual(sidecar, expectedSidecar)) fail("POLICY_CHANGED");
  replacements.set(SIDECAR, [originalSidecarBytes, generatedSidecar]);
  await assertInventory(context, manifest, replacements);
  const rebound = structuredClone(manifest);
  for (const path of [FS, KEYTAR, SIDECAR]) {
    const row = rebound.files.find((file) => file.path === path);
    if (!row) fail("JOURNAL_INVALID");
    const bytes = replacements.get(path).at(-1);
    row.bytes = bytes.length;
    row.sha256 = hash(bytes);
  }
  rebound.windowsBinding.binding = { ...rebound.windowsBinding.binding, bytes: sidecar.bytes, sha256: sidecar.sha256 };
  rebound.payload = digestRows(rebound.files);
  const nextManifestBytes = jsonBytes(rebound);
  const currentManifest = await capture(context.root, join(context.stage, MANIFEST));
  if (!currentManifest.equals(originalManifestBytes) && !currentManifest.equals(nextManifestBytes)) fail("METADATA_CHANGED");
  await atomicReplace(context, join(context.stage, SIDECAR), originalSidecarBytes, generatedSidecar, "sidecar.pending");
  await dependencies.afterSidecar?.();
  await atomicReplace(context, join(context.stage, MANIFEST), originalManifestBytes, nextManifestBytes, "manifest.pending");
  await verifyStagedElectronRuntime({ output: context.stage, target: "win32-x64", version: context.candidate.version });
  if (hash(await capture(context.root, context.candidatePath, 128 * 1024)) !== context.candidate.sha256) fail("CANDIDATE_CHANGED");
  const receipt = { schemaVersion: SCHEMA, candidate: context.candidate, status: "native_integrity_rebound",
    originalRuntimeManifestSha256: hash(originalManifestBytes), runtimeManifestSha256: hash(nextManifestBytes),
    nativeSignatures: "valid_authenticode_publisher_and_timestamp_present",
    signingAlgorithmPolicy: "not_verified", directoryDurability: "not_qualified",
    nativeContent: "unchanged_except_authenticode",
    windowsRuntimeQualification: "required", packagedArtifactVerification: "not_performed", signing: "not_performed" };
  const receiptPath = join(context.journalRoot, "rebound.json");
  try { await exclusive(receiptPath, jsonBytes(receipt)); } catch (error) {
    if (error.code !== "EEXIST" || !(await capture(context.root, receiptPath)).equals(jsonBytes(receipt))) throw error;
  }
  return receipt;
}
export async function rebindWindowsNativeModules(options = {}) { return rebind(options, {}); }
/** Synthetic dependency seam; product code never imports this operations tool. */
export async function rebindWindowsNativeModulesForTest(options, dependencies) { return rebind(options, dependencies); }
export function parseWindowsNativeRebindingArguments(argv) {
  const mode = argv[0] === "--prepare" ? "prepare" : argv[0] === "--rebind" ? "rebind" : "inspect";
  const args = mode === "inspect" ? argv : argv.slice(1);
  if (args.length !== 2 || args[0] !== "--candidate-receipt" || !args[1] || args[1].includes("\0")) fail("ARGUMENT_INVALID");
  return { mode, candidateReceiptPath: args[1] };
}
if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const main = async () => {
    const { mode, ...options } = parseWindowsNativeRebindingArguments(process.argv.slice(2));
    const run = { inspect: inspectWindowsNativeRebinding, prepare: prepareWindowsNativeRebinding, rebind: rebindWindowsNativeModules }[mode];
    console.log(JSON.stringify(await run(options)));
  };
  main().catch((error) => { console.error(error.code?.startsWith("WINDOWS_NATIVE_REBIND_") ? error.code : "WINDOWS_NATIVE_REBIND_FAILED"); process.exitCode = 1; });
}
