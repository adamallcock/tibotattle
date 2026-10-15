#!/usr/bin/env node

/** Build and resume immutable Windows signing subjects without signing authority. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsSigningSubjectManifest, applyWindowsSignedSubjects, validateSignedSubjectReceipt } from "./lib/windows-signing-subjects.mjs";
import { prepareWindowsNativeRebinding, rebindWindowsNativeModules } from "./rebind-electron-windows-native-modules.mjs";
import transfer from "./lib/windows-signing-transfer.cjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const CANDIDATE_ROOT = join(ROOT, ".release-build/electron-production/win32-x64");
const STAGES = ["native", "application", "uninstaller", "installer", "complete"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fail(code) { const error = new Error(`WINDOWS_SIGNING_STAGE_${code}`); error.code = error.message; throw error; }
const require = createRequire(import.meta.url);

export function parseWindowsSigningStageArguments(argv) {
  const allowed = new Set(["stage", "candidate-receipt", "candidate-sha256", "source-revision", "signed-root", "signed-receipt-sha256", "manifest-sha256", "continuation-sha256"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, ""); const value = argv[index + 1];
    if (!allowed.has(key) || Object.hasOwn(values, key) || !value || /[\0\r\n]/u.test(value)) fail("ARGUMENT_INVALID");
    values[key] = value;
  }
  if (!STAGES.includes(values.stage) || !/^[0-9a-f]{64}$/u.test(values["candidate-sha256"] ?? "")
      || !/^[0-9a-f]{40}$/u.test(values["source-revision"] ?? "") || !values["candidate-receipt"]) fail("ARGUMENT_INVALID");
  if (values.stage !== "native" && (!values["signed-root"]
      || !/^[0-9a-f]{64}$/u.test(values["signed-receipt-sha256"] ?? "")
      || !/^[0-9a-f]{64}$/u.test(values["manifest-sha256"] ?? ""))) fail("ARGUMENT_INVALID");
  if (values.stage === "native" && ["signed-root", "signed-receipt-sha256", "manifest-sha256"].some((key) => key in values)) fail("ARGUMENT_INVALID");
  if (values.stage === "installer" && !/^[0-9a-f]{64}$/u.test(values["continuation-sha256"] ?? "")) fail("ARGUMENT_INVALID");
  if (values.stage !== "installer" && "continuation-sha256" in values) fail("ARGUMENT_INVALID");
  return values;
}

async function boundedJson(root, file, expectedSha256) {
  const bytes = await transfer.regular(root, file, 4 * 1024 * 1024);
  if (expectedSha256 && hash(bytes) !== expectedSha256) fail("DIGEST_MISMATCH");
  return JSON.parse(bytes.toString("utf8"));
}
async function emitManifest(context, stage, paths) {
  const manifest = await createWindowsSigningSubjectManifest({ root: context.root, ...context.binding, stage, paths });
  const manifestPath = join(context.stateRoot, `${stage}-subjects.json`);
  const manifestSha256 = await transfer.writeExclusive(manifestPath, manifest);
  return { status: "subjects_ready", stage, manifestPath: transfer.portable(ROOT, manifestPath),
    manifestSha256, candidateSha256: context.binding.candidateSha256 };
}
async function applyPrevious(context, values, previous) {
  const manifest = await boundedJson(context.root, join(context.stateRoot, `${previous}-subjects.json`), values["manifest-sha256"]);
  if (manifest.stage !== previous || Object.keys(context.binding).some((key) => manifest[key] !== context.binding[key])) fail("SUBJECT_BINDING_MISMATCH");
  const signedRoot = resolve(values["signed-root"]);
  const receipt = await boundedJson(signedRoot, join(signedRoot, "signed-subjects.json"), values["signed-receipt-sha256"]);
  await applyWindowsSignedSubjects({ root: context.root, signedRoot, manifest, receipt,
    expectedManifestSha256: values["manifest-sha256"] });
  await transfer.writeExclusive(join(context.stateRoot, `${previous}-signed-receipt.json`), receipt);
}
function builderEnvironment(context, stage) {
  transfer.assertUnprivileged();
  return { ...process.env, CI: "true", ELECTRON_BUILDER_CACHE: join(context.root, "tool-cache"),
    APP_BUILDER_TMP_DIR: join(context.root, "builder-tmp"),
    TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT: context.root,
    TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE: stage,
    TIBOTATTLE_ELECTRON_SIGNING_MODE: "staged-transfer", TIBOTATTLE_ELECTRON_TARGET: "win32-x64",
    TIBOTATTLE_ELECTRON_VERSION: context.binding.version, TIBOTATTLE_ELECTRON_BUILD_NUMBER: context.binding.buildNumber,
    TIBOTATTLE_ELECTRON_SOURCE_REVISION: context.binding.sourceRevision,
    TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_RECEIPT: join(context.root, "production-source-candidate.json"),
    TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_SHA256: context.binding.candidateSha256,
    TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: "Adam Allcock" };
}
async function runBuilder(context, stage) {
  const builder = require.resolve("electron-builder/cli.js");
  for (const leaf of ["builder-tmp", "tool-cache"]) await mkdir(join(context.root, leaf), { recursive: true });
  const args = [builder, "--config", "apps/electron/electron-builder.release.config.cjs", "--win",
    stage === "application" ? "dir" : "nsis", "--x64", "--publish", "never"];
  if (stage === "uninstaller") args.push("--prepackaged", join(context.root, "artifacts/win-unpacked"));
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env: builderEnvironment(context, stage),
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    timeout: 30 * 60 * 1000, windowsHide: true });
  if (result.error || result.signal) fail("BUILDER_FAILED");
  if (stage === "application" && result.status !== 0) fail("BUILDER_FAILED");
  if (stage === "uninstaller" && (result.status !== 1
      || !`${result.stdout}\n${result.stderr}`.includes("WINDOWS_SIGNING_TRANSFER_CHECKPOINT_READY"))) fail("CHECKPOINT_FAILED");
  const requests = [];
  const requestRoot = join(context.stateRoot, `${stage}-requests`);
  for (const file of (await readdir(requestRoot)).sort()) requests.push(await boundedJson(context.root, join(requestRoot, file)));
  for (const request of requests) {
    const bytes = await transfer.regular(context.root, join(context.root, request.path));
    if (hash(bytes) !== request.sha256 || bytes.length !== request.sizeBytes) fail("SUBJECT_CHANGED");
  }
  const emitted = await emitManifest(context, stage, requests.map((request) => request.path));
  if (stage === "uninstaller") emitted.continuationSha256 = hash(await transfer.regular(context.root, join(context.stateRoot, "nsis-continuation.json")));
  return emitted;
}

export async function verifyWindowsNsisContinuation({ root, repositoryRoot, binding, checkpoint }) {
  transfer.assertUnprivileged();
  const expectedKeys = ["sourceRevision", "candidateSha256", "version", "buildNumber", "schemaVersion", "command", "args", "cwd", "environment", "script", "inputs", "uninstaller"];
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
      || Object.keys(checkpoint).sort().join("\0") !== expectedKeys.sort().join("\0")
      || checkpoint.schemaVersion !== "tibotattle-windows-nsis-continuation-v1"
      || ["sourceRevision", "candidateSha256", "version", "buildNumber"].some((key) => checkpoint[key] !== binding[key])
      || typeof checkpoint.command !== "string" || !/^tool-cache\/[^\0\r\n]*\/makensis\.exe$/iu.test(checkpoint.command)
      || !checkpoint.cwd?.startsWith("node_modules/") || checkpoint.cwd.split("/").some((part) => !part || part === ".." || part === ".")
      || checkpoint.script !== "signing-transfer/installer.nsi"
      || checkpoint.uninstaller !== `artifacts/TiboTattle-${binding.version}-Windows-x64.__uninstaller.exe`
      || !Array.isArray(checkpoint.args) || checkpoint.args.length > 512
      || checkpoint.args.some((arg) => typeof arg !== "string" || arg.length > 32768 || arg.includes("\0"))
      || checkpoint.args.at(-1) !== "-" || !Array.isArray(checkpoint.inputs)
      || checkpoint.inputs.length < 3 || checkpoint.inputs.length > 20000
      || !checkpoint.environment || typeof checkpoint.environment !== "object" || Array.isArray(checkpoint.environment)
      || Object.keys(checkpoint.environment).some((key) => key !== "NSISDIR")
      || Object.values(checkpoint.environment).some((value) => typeof value !== "string" || value.length > 32768 || /[\0\r\n]/u.test(value))) fail("CONTINUATION_INVALID");
  const seen = new Set();
  for (const input of checkpoint.inputs) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join("\0") !== ["path", "sha256", "sizeBytes"].sort().join("\0")
        || typeof input.path !== "string" || !/^[0-9a-f]{64}$/u.test(input.sha256)
        || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) fail("CONTINUATION_INVALID");
    if (seen.has(input.path)) fail("CONTINUATION_INVALID"); seen.add(input.path);
    const file = resolve(root, input.path);
    if (transfer.portable(root, file) !== input.path) fail("CONTINUATION_INVALID");
    const bytes = await transfer.regular(root, file);
    if (hash(bytes) !== input.sha256 || bytes.length !== input.sizeBytes) fail("CONTINUATION_CHANGED");
  }
  if (!seen.has(checkpoint.command) || !seen.has(checkpoint.script)
      || !checkpoint.inputs.some((input) => /\.nsis\.(?:7z|zip)$/u.test(input.path))) fail("CONTINUATION_INVALID");
  return checkpoint;
}
export async function withWritableWindowsNativeInputs({ root, journal }, run) {
  const nativePaths = ["native/windows-filesystem/build/Release/windows_filesystem.node", "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node"];
  const metadataPaths = ["native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json", "electron-runtime-manifest.json"];
  const modes = new Map();
  for (const [paths, values] of [[nativePaths, journal.nativeModes], [metadataPaths, journal.rebindMetadataModes]]) {
    if (!values || Object.keys(values).sort().join("\0") !== [...paths].sort().join("\0")) fail("NATIVE_ACCESS_INVALID");
    for (const entry of paths) {
      if (!Number.isInteger(values[entry]) || values[entry] < 0 || values[entry] > 0o777) fail("NATIVE_ACCESS_INVALID");
      const file = join(root, "app", entry);
      await transfer.regular(root, file);
      modes.set(file, values[entry]);
    }
  }
  try {
    for (const [file, mode] of modes) await chmod(file, mode | 0o200);
    return await run();
  } finally {
    for (const [file, mode] of modes) { await transfer.regular(root, file); await chmod(file, mode); }
  }
}
function expandContinuationValue(value, repositoryRoot) {
  return value.split("@TIBOTATTLE_REPOSITORY_ROOT@").join(repositoryRoot)
    .split("@TIBOTATTLE_REPOSITORY_ROOT_FORWARD@").join(repositoryRoot.replaceAll("\\", "/"));
}

/** Preserve electron-builder's post-compilation checks before admitting a signing subject. */
export async function validateWindowsNsisCompilerResult({ context, checkpoint, result, repositoryRoot = ROOT }) {
  transfer.assertUnprivileged();
  if (!result || result.error || result.signal || result.status !== 0
      || typeof result.stdout !== "string" || typeof result.stderr !== "string") fail("COMPILER_FAILED");
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  if (builderRequire("electron-builder/package.json").version !== "26.15.7"
      || builderRequire("app-builder-lib/package.json").version !== "26.15.7") fail("PINNED_BUILDER_UNAVAILABLE");
  const { checkMakensisOutput, verifyInstallerSize } = builderRequire("app-builder-lib/out/targets/nsis/nsisValidation.js");
  if (typeof checkMakensisOutput !== "function" || typeof verifyInstallerSize !== "function") fail("PINNED_BUILDER_UNAVAILABLE");
  try {
    // NSIS can report an Error line while returning success, including on
    // disk exhaustion. Never relay its raw diagnostic text into evidence.
    checkMakensisOutput(result.stdout, result.stderr);
  } catch { fail("COMPILER_OUTPUT_INVALID"); }
  const archiveArguments = checkpoint.args.filter((argument) => argument.startsWith("-DAPP_64="));
  const archives = checkpoint.inputs.filter((input) => /\.nsis\.(?:7z|zip)$/u.test(input.path));
  if (archiveArguments.length !== 1 || archives.length !== 1
      || checkpoint.args.some((argument) => /^-DAPP_(?:32|ARM64)=/u.test(argument))) fail("ARCHIVE_BINDING_INVALID");
  const archive = archives[0];
  const archivePath = resolve(context.root, archive.path);
  if (expandContinuationValue(archiveArguments[0].slice("-DAPP_64=".length), repositoryRoot) !== archivePath)
    fail("ARCHIVE_BINDING_INVALID");
  // The upstream size check tolerates an absent archive. Our continuation
  // requires the exact persisted archive to remain present and unchanged.
  const archiveBytes = await transfer.regular(context.root, archivePath);
  if (archiveBytes.length !== archive.sizeBytes || hash(archiveBytes) !== archive.sha256) fail("CONTINUATION_CHANGED");
  const installerPath = join(context.root, "artifacts", `TiboTattle-${context.binding.version}-Windows-x64.exe`);
  try {
    await verifyInstallerSize(installerPath, { APP_64: archivePath });
  } catch { fail("INSTALLER_INCOMPLETE"); }
  // Also enforce the transfer boundary's regular, unlinked-file requirement.
  await transfer.regular(context.root, installerPath);
}
async function continueInstaller(context, continuationSha256) {
  const checkpoint = await boundedJson(context.root, join(context.stateRoot, "nsis-continuation.json"), continuationSha256);
  await verifyWindowsNsisContinuation({ ...context, repositoryRoot: ROOT, checkpoint });
  const expand = (value) => expandContinuationValue(value, ROOT);
  // Expand only verified saved NSIS include text after checking its immutable
  // digest, in the unprivileged continuation. The persisted checkpoint stays
  // portable and contains no maintainer-local paths.
  for (const input of checkpoint.inputs) {
    if (!input.path.startsWith("signing-transfer/nsis-inputs/") || !/\.(?:nsh|nsi)$/u.test(input.path)) continue;
    const file = join(context.root, input.path);
    await writeFile(file, expand((await transfer.regular(context.root, file)).toString("utf8")), { mode: 0o600 });
  }
  const script = expand((await transfer.regular(context.root, join(context.root, checkpoint.script), 4 * 1024 * 1024)).toString("utf8"));
  const result = spawnSync(join(context.root, checkpoint.command), checkpoint.args.map(expand), {
    cwd: join(ROOT, checkpoint.cwd), env: { ...process.env, ...Object.fromEntries(Object.entries(checkpoint.environment).map(([key, value]) => [key, expand(value)])) },
    input: script, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    timeout: 30 * 60 * 1000, windowsHide: true,
  });
  await validateWindowsNsisCompilerResult({ context, checkpoint, result });
  return emitManifest(context, "installer", [`artifacts/TiboTattle-${context.binding.version}-Windows-x64.exe`]);
}

export async function finalizeWindowsSigningStageMetadata({ root, binding }) {
  transfer.assertUnprivileged();
  if (!/^\d+\.\d+\.\d+$/u.test(binding.version)) fail("METADATA_VERSION_INVALID");
  const leaf = `TiboTattle-${binding.version}-Windows-x64.exe`;
  const installerPath = join(root, "artifacts", leaf);
  const original = await transfer.regular(root, installerPath);
  const originalHash = hash(original);
  const sha512 = createHash("sha512").update(original).digest("base64");
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  if (builderRequire("electron-builder/package.json").version !== "26.15.7"
      || builderRequire("app-builder-lib/package.json").version !== "26.15.7") fail("PINNED_BUILDER_UNAVAILABLE");
  const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
  if (typeof buildBlockMap !== "function") fail("PINNED_BUILDER_UNAVAILABLE");
  const temporaryRoot = join(root, "signing-transfer/blockmap-finalization");
  await mkdir(temporaryRoot);
  const temporaryMap = join(temporaryRoot, "installer.blockmap");
  // An explicit sidecar output prevents appending bytes to the signed file.
  const generated = await buildBlockMap(installerPath, "gzip", temporaryMap);
  const current = await transfer.regular(root, installerPath);
  if (current.length !== original.length || hash(current) !== originalHash
      || generated.size !== original.length || generated.sha512 !== sha512) fail("SIGNED_INSTALLER_CHANGED");
  const mapBytes = await transfer.regular(root, temporaryMap, 16 * 1024 * 1024);
  const mapPath = join(root, "artifacts", `${leaf}.blockmap`);
  await copyFile(temporaryMap, mapPath, constants.COPYFILE_EXCL);
  if (hash(await transfer.regular(root, mapPath, 16 * 1024 * 1024)) !== hash(mapBytes)) fail("BLOCKMAP_CHANGED");
  await unlink(temporaryMap);
  await writeFile(join(root, "artifacts/latest.yml"),
    `version: ${binding.version}\nfiles:\n  - url: ${leaf}\n    sha512: ${sha512}\n    size: ${original.length}\npath: ${leaf}\nsha512: ${sha512}\n`, { flag: "wx", mode: 0o600 });
  return { installerSha256: originalHash, installerSha512: sha512, installerSizeBytes: original.length,
    blockmapSha256: hash(mapBytes), blockmapSizeBytes: mapBytes.length };
}

export async function prepareWindowsSigningStage(values) {
  transfer.assertUnprivileged();
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v26.2.0") fail("HOST_UNSUPPORTED");
  const candidatePath = resolve(values["candidate-receipt"]);
  if (candidatePath !== join(CANDIDATE_ROOT, "production-source-candidate.json")) fail("CANDIDATE_INVALID");
  const candidate = await boundedJson(CANDIDATE_ROOT, candidatePath, values["candidate-sha256"]);
  if (candidate.sourceRevision !== values["source-revision"] || candidate.target !== "win32-x64"
      || candidate.status !== "production_source_staged" || candidate.signingPerformed !== false) fail("CANDIDATE_INVALID");
  const binding = { sourceRevision: candidate.sourceRevision, candidateSha256: values["candidate-sha256"],
    version: candidate.version, buildNumber: candidate.buildNumber };
  const context = { root: CANDIDATE_ROOT, stateRoot: join(CANDIDATE_ROOT, "signing-transfer"), binding };
  if (values.stage === "native") {
    await mkdir(context.stateRoot);
    await transfer.writeExclusive(join(context.stateRoot, "context.json"), { schemaVersion: "tibotattle-windows-signing-transfer-v1", ...binding });
    await prepareWindowsNativeRebinding({ candidateReceiptPath: candidatePath });
    return emitManifest(context, "native", ["app/native/windows-filesystem/build/Release/windows_filesystem.node",
      "app/node_modules/@github/keytar/prebuilds/win32-x64/keytar.node"]);
  }
  const saved = await boundedJson(context.root, join(context.stateRoot, "context.json"));
  if (Object.keys(binding).some((key) => saved[key] !== binding[key])) fail("CONTEXT_INVALID");
  if (values.stage === "application") {
    const journal = await boundedJson(context.root, join(context.root, "windows-native-rebinding/journal.json"));
    if (journal.candidate?.sha256 !== binding.candidateSha256) fail("NATIVE_ACCESS_INVALID");
    await withWritableWindowsNativeInputs({ root: context.root, journal }, async () => {
      await applyPrevious(context, values, "native");
      await rebindWindowsNativeModules({ candidateReceiptPath: candidatePath });
    });
    return runBuilder(context, "application");
  }
  await applyPrevious(context, values, STAGES[STAGES.indexOf(values.stage) - 1]);
  if (values.stage === "uninstaller") return runBuilder(context, "uninstaller");
  if (values.stage === "installer") return continueInstaller(context, values["continuation-sha256"]);
  const metadata = await finalizeWindowsSigningStageMetadata(context);
  const counts = { exe: 0, dll: 0, node: 0, unexpected: 0 };
  for (const stage of ["application", "uninstaller", "installer"]) {
    const manifestFile = join(context.stateRoot, `${stage}-subjects.json`);
    const manifestBytes = await transfer.regular(context.root, manifestFile);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const receipt = await boundedJson(context.root, join(context.stateRoot, `${stage}-signed-receipt.json`));
    validateSignedSubjectReceipt(receipt, manifest, hash(manifestBytes));
    for (const entry of receipt.files) counts[entry.path.endsWith(".exe") ? "exe" : "dll"] += 1;
  }
  await mkdir(join(context.root, "evidence"), { recursive: true });
  await transfer.writeExclusive(join(context.root, "evidence/windows-signing-operation-ledger.json"), {
    schemaVersion: "tibotattle-windows-signing-operation-ledger-v1", status: "WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED",
    builder: "app-builder-lib", builderVersion: "26.15.7", ledgerCount: 1,
    operationCount: counts.exe + counts.dll, classes: counts,
  });
  return { status: "signed_subjects_applied", stage: "complete", candidateSha256: binding.candidateSha256,
    metadata, qualification: "required", publishingPerformed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  prepareWindowsSigningStage(parseWindowsSigningStageArguments(process.argv.slice(2))).then(async (result) => {
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `candidate_sha256=${result.candidateSha256}\n`
        + (result.manifestSha256 ? `manifest_sha256=${result.manifestSha256}\nmanifest_path=${result.manifestPath}\n` : "")
        + (result.continuationSha256 ? `continuation_sha256=${result.continuationSha256}\n` : ""));
    }
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(/^WINDOWS_(?:SIGNING_STAGE|SIGNING_TRANSFER|SIGNING_SUBJECT|NATIVE_REBIND)_/u.test(error?.code ?? "")
      ? error.code : "WINDOWS_SIGNING_STAGE_FAILED"); process.exitCode = 1;
  });
}
