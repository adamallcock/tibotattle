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
// This is the shipped Windows N-API prebuild. The source candidate is staged
// after an install with lifecycle scripts disabled, so `build/Release` is not
// present; the production builder unpacks this same fixed prebuild path.
const KEYTAR = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const MANIFEST = "electron-runtime-manifest.json";
const NATIVES = Object.freeze([FS, KEYTAR]);
const REBIND_METADATA = Object.freeze([SIDECAR, MANIFEST]);
const MAX_FILE = 128 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const AUTHENTICODE_DIAGNOSTIC = /^status=(valid|not_signed|hash_mismatch|not_trusted|not_supported|incompatible|not_allowed|other);signer=(present|absent);timestamp=(present|absent);publisher=(match|mismatch|not_checked)$/u;
function fail(code) {
  const error = new Error(`WINDOWS_NATIVE_REBIND_${code}`);
  error.code = error.message;
  throw error;
}
function parseAuthenticodeDiagnostic(value) {
  const matched = typeof value === "string" ? AUTHENTICODE_DIAGNOSTIC.exec(value.trim()) : null;
  if (!matched) return null;
  return Object.freeze({ status: matched[1], signer: matched[2], timestamp: matched[3], publisher: matched[4] });
}
function authenticodeFailureCode(value) {
  if (!value) return "SIGNATURE_PROBE_INVALID";
  if (value.status !== "valid") return `SIGNATURE_STATUS_${value.status.toUpperCase()}`;
  if (value.signer !== "present") return "SIGNATURE_SIGNER_ABSENT";
  if (value.timestamp !== "present") return "SIGNATURE_TIMESTAMP_ABSENT";
  if (value.publisher !== "match") return "SIGNATURE_PUBLISHER_MISMATCH";
  return null;
}
function assertAuthenticodeDiagnostic(value) {
  const code = authenticodeFailureCode(value);
  if (code) fail(code);
}
function closedAuthenticodeDiagnostic(value) {
  return `status=${value.status};signer=${value.signer};timestamp=${value.timestamp};publisher=${value.publisher}`;
}
function authenticodeProbeFailureCode(result) {
  if (result?.error?.code === "ENOENT") return "SIGNATURE_PROBE_TOOL_UNAVAILABLE";
  if (result?.error) return "SIGNATURE_PROBE_SPAWN_FAILED";
  if (result?.signal) return "SIGNATURE_PROBE_INTERRUPTED";
  const standardError = typeof result?.stderr === "string" ? result.stderr : "";
  if (/ParserError|Unexpected token|Missing .*[\]}]/iu.test(standardError)) return "SIGNATURE_PROBE_PARSE_FAILED";
  if (/Get-AuthenticodeSignature.*(?:not recognized|not found)|CommandNotFoundException/iu.test(standardError)) {
    return "SIGNATURE_PROBE_COMMAND_UNAVAILABLE";
  }
  if (/Access is denied|UnauthorizedAccessException|PermissionDenied/iu.test(standardError)) {
    return "SIGNATURE_PROBE_ACCESS_DENIED";
  }
  return "SIGNATURE_PROBE_EXECUTION_FAILED";
}
function createAuthenticodeProbeScript() {
  return "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:TIBOTATTLE_NATIVE_VERIFY_PATH; "
    + "$status='other'; "
    + "if([string]$s.Status -ceq 'Valid'){$status='valid'}elseif([string]$s.Status -ceq 'NotSigned'){$status='not_signed'}elseif([string]$s.Status -ceq 'HashMismatch'){$status='hash_mismatch'}elseif([string]$s.Status -ceq 'NotTrusted'){$status='not_trusted'}elseif([string]$s.Status -ceq 'NotSupported'){$status='not_supported'}elseif([string]$s.Status -ceq 'Incompatible'){$status='incompatible'}elseif([string]$s.Status -ceq 'NotAllowed'){$status='not_allowed'}; "
    + "$signer=if($null -eq $s.SignerCertificate){'absent'}else{'present'}; "
    + "$timestamp=if($null -eq $s.TimeStamperCertificate){'absent'}else{'present'}; "
    + "$publisher=if($signer -eq 'absent'){'not_checked'}elseif($s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq 'Adam Allcock'){'match'}else{'mismatch'}; "
    + "[Console]::Out.Write(\"status=$status;signer=$signer;timestamp=$timestamp;publisher=$publisher\"); exit 0";
}
function createAuthenticodePowerShellArguments(script) {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
/** Synthetic-only test seam; the probe never prints certificate fields. */
export function createWindowsAuthenticodeProbeForTest() {
  return createAuthenticodeProbeScript();
}
/** Synthetic-only test seam for the fixed Windows command-line encoding. */
export function createWindowsAuthenticodePowerShellArgumentsForTest() {
  return createAuthenticodePowerShellArguments(createAuthenticodeProbeScript());
}
function runAuthenticodePowerShell(script, environment) {
  return spawnSync("powershell.exe", createAuthenticodePowerShellArguments(script), {
    env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    windowsHide: true,
  });
}
function assertAuthenticodeProbeSucceeded(result) {
  if (result?.error || result?.signal || result?.status !== 0) fail(authenticodeProbeFailureCode(result));
}
/** Synthetic-only test seam; the live signer emits no certificate text. */
export function classifyWindowsAuthenticodeForTest(value) {
  const diagnostic = parseAuthenticodeDiagnostic(value);
  assertAuthenticodeDiagnostic(diagnostic);
  return diagnostic;
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
async function nativeAccess(root, path) {
  await safePath(root, path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1) fail("FILE_UNSAFE");
  const mode = metadata.mode & 0o777;
  return { mode, readOnly: (mode & 0o222) === 0 };
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
  const nativeModes = {};
  const nativeReadOnly = {};
  for (const path of NATIVES) {
    nativeContent[path] = windowsNativeUnsignedContentDigest(await capture(root, join(stage, path)));
    const access = await nativeAccess(root, join(stage, path));
    nativeModes[path] = access.mode;
    nativeReadOnly[path] = access.readOnly;
  }
  const manifestBytes = await capture(root, join(stage, MANIFEST), 8 * 1024 * 1024);
  const sidecarBytes = await capture(root, join(stage, SIDECAR), 128 * 1024);
  const rebindMetadataModes = {};
  const rebindMetadataReadOnly = {};
  for (const path of REBIND_METADATA) {
    const access = await nativeAccess(root, join(stage, path));
    rebindMetadataModes[path] = access.mode;
    rebindMetadataReadOnly[path] = access.readOnly;
  }
  assertOriginalBinding(manifest, sidecarBytes);
  return { schemaVersion: SCHEMA, candidate, manifestBase64: manifestBytes.toString("base64"),
    sidecarBase64: sidecarBytes.toString("base64"), nativeContent, nativeModes, nativeReadOnly,
    rebindMetadataModes, rebindMetadataReadOnly };
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
function probeAuthenticode(path, run = runAuthenticodePowerShell) {
  const result = run(createAuthenticodeProbeScript(), {
    ...process.env, TIBOTATTLE_NATIVE_VERIFY_PATH: path,
  });
  assertAuthenticodeProbeSucceeded(result);
  const diagnostic = parseAuthenticodeDiagnostic(result.stdout);
  if (!diagnostic) fail("SIGNATURE_PROBE_INVALID");
  return diagnostic;
}
async function probeAuthenticodeBeforeSigning(options, dependencies = {}) {
  assertHost(dependencies);
  const context = await selected(options, dependencies);
  for (const path of NATIVES) {
    // The workflow journals these same fixed files immediately before this
    // probe. Capture keeps the probe on ordinary files inside that stage.
    await capture(context.root, join(context.stage, path));
    probeAuthenticode(join(context.stage, path), dependencies.runAuthenticodeProbe);
  }
  return { schemaVersion: SCHEMA, candidate: context.candidate, status: "pre_sign_authenticode_probe_verified", signing: "not_performed", windowsRuntimeQualification: "required" };
}
/** Synthetic dependency seam; product code never imports this operations tool. */
export async function probeWindowsAuthenticodePreSignForTest(options, dependencies) {
  return probeAuthenticodeBeforeSigning(options, dependencies);
}

function verifyAuthenticode(path) {
  // Fixed script and environment-carried path avoid shell/path interpolation.
  // This checks Windows trust, publisher and timestamp presence only. The
  // final signer must separately qualify SHA-256 file/timestamp algorithms.
  // The probe emits a fixed, content-free diagnostic rather than certificate
  // fields so a trust failure is actionable without disclosing signer data.
  const diagnostic = probeAuthenticode(path);
  const code = authenticodeFailureCode(diagnostic);
  if (code) {
    if (diagnostic) console.error(`WINDOWS_NATIVE_REBIND_AUTHENTICODE ${closedAuthenticodeDiagnostic(diagnostic)}`);
    fail(code);
  }
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
  if (!exactKeys(journal, ["schemaVersion", "candidate", "manifestBase64", "sidecarBase64", "nativeContent", "nativeModes", "nativeReadOnly", "rebindMetadataModes", "rebindMetadataReadOnly"])
      || journal.schemaVersion !== SCHEMA || !isDeepStrictEqual(journal.candidate, context.candidate)
      || !exactKeys(journal.nativeContent, NATIVES)
      || !exactKeys(journal.nativeModes, NATIVES) || !exactKeys(journal.nativeReadOnly, NATIVES)
      || !exactKeys(journal.rebindMetadataModes, REBIND_METADATA)
      || !exactKeys(journal.rebindMetadataReadOnly, REBIND_METADATA)
      || typeof journal.manifestBase64 !== "string" || typeof journal.sidecarBase64 !== "string") fail("JOURNAL_INVALID");
  for (const [paths, modes, readOnly] of [
    [NATIVES, journal.nativeModes, journal.nativeReadOnly],
    [REBIND_METADATA, journal.rebindMetadataModes, journal.rebindMetadataReadOnly],
  ]) {
    for (const path of paths) {
      if (!Number.isInteger(modes[path]) || modes[path] < 0 || modes[path] > 0o777
          || typeof readOnly[path] !== "boolean"
          || readOnly[path] !== ((modes[path] & 0o222) === 0)) fail("JOURNAL_INVALID");
    }
  }
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
  const mode = argv[0] === "--prepare" ? "prepare"
    : argv[0] === "--rebind" ? "rebind"
      : argv[0] === "--probe-authenticode-pre-sign" ? "probe"
        : "inspect";
  const args = mode === "inspect" ? argv : argv.slice(1);
  if (args.length !== 2 || args[0] !== "--candidate-receipt" || !args[1] || args[1].includes("\0")) fail("ARGUMENT_INVALID");
  return { mode, candidateReceiptPath: args[1] };
}
if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const main = async () => {
    const { mode, ...options } = parseWindowsNativeRebindingArguments(process.argv.slice(2));
    const run = { inspect: inspectWindowsNativeRebinding, prepare: prepareWindowsNativeRebinding,
      probe: probeAuthenticodeBeforeSigning, rebind: rebindWindowsNativeModules }[mode];
    console.log(JSON.stringify(await run(options)));
  };
  main().catch((error) => { console.error(error.code?.startsWith("WINDOWS_NATIVE_REBIND_") ? error.code : "WINDOWS_NATIVE_REBIND_FAILED"); process.exitCode = 1; });
}
