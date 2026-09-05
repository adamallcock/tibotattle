#!/usr/bin/env node

/** One unsigned development packaging entrypoint for the four desktop targets. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildElectronApp, ELECTRON_APP_OUTPUTS } from "./build-electron-app.mjs";
import { ELECTRON_TARGETS } from "./build-electron-runtime.mjs";
import { verifyElectronDevelopmentArtifact } from "./verify-electron-development-artifact.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const SCHEMA = "tibotattle-electron-development-package-v1";
const TARGET_NAMES = Object.freeze(Object.keys(ELECTRON_TARGETS));
const SHA = /^[0-9a-f]{40}$/u;
const FORMATS = new Set(["dir", "distribution"]);

function fail(code) {
  const error = new Error(`ELECTRON_DEVELOPMENT_${code}`);
  error.code = error.message;
  throw error;
}

export function parseDevelopmentPackageArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = { target: `${process.platform}-${process.arch}`, format: "distribution", dryRun: false, replaceStaging: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail("DUPLICATE_ARGUMENT");
    seen.add(flag);
    if (flag === "--dry-run") result.dryRun = true;
    else if (flag === "--replace-staging") result.replaceStaging = true;
    else if (["--target", "--format", "--windows-binding", "--windows-manifest"].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--") || value.includes("\0")) fail("ARGUMENT_INVALID");
      result[({ "--target": "target", "--format": "format", "--windows-binding": "windowsBindingPath", "--windows-manifest": "windowsManifestPath" })[flag]] = value;
    } else fail("ARGUMENT_INVALID");
  }
  if (!TARGET_NAMES.includes(result.target) || !FORMATS.has(result.format)) fail("TARGET_OR_FORMAT_INVALID");
  if (Boolean(result.windowsBindingPath) !== Boolean(result.windowsManifestPath)
      || (result.target !== "win32-x64" && result.windowsBindingPath)) fail("WINDOWS_INPUT_INVALID");
  return Object.freeze(result);
}

export function developmentPackagePlan({ target, format = "distribution", sourceRevision, hostPlatform = process.platform, hostArchitecture = process.arch }) {
  if (!TARGET_NAMES.includes(target) || !FORMATS.has(format) || !SHA.test(sourceRevision ?? "")) fail("PLAN_INVALID");
  const spec = ELECTRON_TARGETS[target];
  const platformFlag = { darwin: "--mac", win32: "--win", linux: "--linux" }[spec.platform];
  const distributionTargets = { darwin: ["dmg", "zip"], win32: ["nsis", "zip"], linux: ["AppImage", "tar.gz"] }[spec.platform];
  return Object.freeze({
    schemaVersion: SCHEMA, sourceRevision, version: RELEASE_VERSION, target, format,
    host: Object.freeze({ platform: hostPlatform, architecture: hostArchitecture }),
    nativeHost: hostPlatform === spec.platform && hostArchitecture === spec.architecture,
    // The pinned builder ships checksum-verified Darwin tools for Linux
    // AppImage and archive generation. Native execution remains separate.
    buildHostAvailable: spec.platform === "win32" || hostPlatform === spec.platform
      || (spec.platform === "linux" && hostPlatform === "darwin"),
    stagingDirectory: `.release-build/electron-dev/${target}/app`,
    outputDirectory: `.release-build/electron-candidates/${sourceRevision}/${target}/${format}`,
    builderArguments: Object.freeze([platformFlag, ...(format === "dir" ? ["dir"] : distributionTargets), `--${spec.architecture}`, "--publish", "never"]),
    signed: false, published: false, updaterEnabled: false, installedLifecycleQualified: false,
  });
}

export function developmentBuildEnvironment(environment, target) {
  if (!TARGET_NAMES.includes(target)) fail("TARGET_OR_FORMAT_INVALID");
  // A local development build cannot inherit signing or publisher authority.
  const selected = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "CI", "ELECTRON_CACHE", "ELECTRON_BUILDER_CACHE"]) {
    if (typeof environment[key] === "string") selected[key] = environment[key];
  }
  selected.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  selected.TIBOTATTLE_ELECTRON_TARGET = target;
  selected.TIBOTATTLE_ELECTRON_VERSION = RELEASE_VERSION;
  return selected;
}

async function run(command, args, { cwd = ROOT, env = process.env, logPath = null } = {}) {
  const log = logPath ? await open(logPath, "wx", 0o600) : null;
  try {
    return await new Promise((resolveRun, reject) => {
      let output = "";
      const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: log ? ["ignore", log.fd, log.fd] : ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("ELECTRON_DEVELOPMENT_COMMAND_TIMEOUT")); }, log ? 30 * 60_000 : 30_000);
      const capture = (chunk) => { output += chunk; if (output.length > 64 * 1024) { child.kill(); reject(new Error("ELECTRON_DEVELOPMENT_COMMAND_OUTPUT_LIMIT")); } };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.once("error", () => { clearTimeout(timeout); reject(new Error("ELECTRON_DEVELOPMENT_COMMAND_UNAVAILABLE")); });
      child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolveRun(output.trim()) : reject(new Error("ELECTRON_DEVELOPMENT_COMMAND_FAILED")); });
    });
  } finally { await log?.close(); }
}

async function cleanSource() {
  const sourceRevision = await run("git", ["rev-parse", "HEAD"]);
  if (!SHA.test(sourceRevision)) fail("SOURCE_INVALID");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"])) !== "") fail("SOURCE_DIRTY");
  return sourceRevision;
}

async function ensureOwnedDirectory(path) {
  const root = await realpath(ROOT);
  const child = relative(root, resolve(path));
  if (!child || child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep)) fail("OUTPUT_BOUNDARY");
  let current = root;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) fail("OUTPUT_UNSAFE");
  }
}

async function digestFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("ARTIFACT_FILE_UNSAFE");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== info.size) fail("ARTIFACT_FILE_CHANGED");
  return { bytes, sha256: hash.digest("hex") };
}

export function executableArchitecture(header) {
  if (header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) fail("EXECUTABLE_ARCHITECTURE");
    return "linux-x64";
  }
  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    if (cpu === 0x01000007) return "darwin-x64";
    if (cpu === 0x0100000c) return "darwin-arm64";
  }
  if (header.length >= 64 && header.toString("ascii", 0, 2) === "MZ") {
    const offset = header.readUInt32LE(60);
    if (offset <= header.length - 6 && header.toString("ascii", offset, offset + 4) === "PE\0\0" && header.readUInt16LE(offset + 4) === 0x8664) return "win32-x64";
  }
  fail("EXECUTABLE_ARCHITECTURE");
}

function artifactPaths(output, target) {
  if (target.startsWith("darwin-")) {
    const bundle = join(output, target === "darwin-arm64" ? "mac-arm64" : "mac", "TiboTattle Dev.app");
    return { executable: join(bundle, "Contents/MacOS/TiboTattle Dev"), resources: join(bundle, "Contents/Resources") };
  }
  const unpacked = join(output, target === "win32-x64" ? "win-unpacked" : "linux-unpacked");
  return { executable: join(unpacked, target === "win32-x64" ? "TiboTattle Dev.exe" : "tibotattle-dev"), resources: join(unpacked, "resources") };
}

export async function packageElectronDevelopment(options) {
  const sourceRevision = options.dryRun ? await run("git", ["rev-parse", "HEAD"]) : await cleanSource();
  const plan = developmentPackagePlan({ ...options, sourceRevision });
  if (options.dryRun) return plan;
  if (process.version !== "v26.2.0") fail("NODE_VERSION_REQUIRED");
  if (!plan.buildHostAvailable) fail("TARGET_BUILD_HOST_REQUIRED");
  const stagingParent = dirname(ELECTRON_APP_OUTPUTS[options.target]);
  await ensureOwnedDirectory(stagingParent);
  const lockPath = join(stagingParent, ".package.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") fail("BUILD_ALREADY_LOCKED"); throw error; }
  try {
  const output = resolve(ROOT, plan.outputDirectory);
  await ensureOwnedDirectory(dirname(output));
  try { await lstat(output); fail("OUTPUT_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const partial = await mkdtemp(join(dirname(output), `.${options.format}-`));
  const env = developmentBuildEnvironment(process.env, options.target);
  if (options.target === "linux-x64") {
    await run(process.execPath, ["--test", "test/electron-appimage-launcher.test.js"], {
      env, logPath: join(partial, "launcher-check.log"),
    });
  }
  const stage = await buildElectronApp({ target: options.target, replace: options.replaceStaging, windowsBindingPath: options.windowsBindingPath, windowsManifestPath: options.windowsManifestPath });
  void stage;
  const builder = require.resolve("electron-builder/cli.js");
  await run(process.execPath, [builder, "--config", "apps/electron/electron-builder.config.cjs", `--config.directories.output=${partial}`, ...plan.builderArguments], { env, logPath: join(partial, "builder.log") });
  const paths = artifactPaths(partial, options.target);
  const asarPath = join(paths.resources, "app.asar");
  const verification = await verifyElectronDevelopmentArtifact({ target: options.target, appPath: ELECTRON_APP_OUTPUTS[options.target], asarPath, unpackedPath: `${asarPath}.unpacked` });
  const executable = await open(paths.executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await executable.read(header, 0, header.length, 0);
    if (executableArchitecture(header.subarray(0, bytesRead)) !== options.target) fail("EXECUTABLE_TARGET_MISMATCH");
  } finally { await executable.close(); }
  const distributions = [];
  for (const entry of await readdir(partial, { withFileTypes: true })) {
    if (/\.(?:dmg|zip|exe|AppImage|tar\.gz)$/u.test(entry.name)) {
      distributions.push({ file: entry.name, ...await digestFile(join(partial, entry.name)) });
    }
  }
  const required = options.target.startsWith("darwin-") ? [".dmg", ".zip"] : options.target === "win32-x64" ? [".exe", ".zip"] : [".AppImage", ".tar.gz"];
  if (options.format === "distribution" && required.some((extension) => !distributions.some(({ file }) => file.endsWith(extension)))) fail("DISTRIBUTION_MISSING");
  if (await cleanSource() !== sourceRevision) fail("SOURCE_CHANGED");
  const receipt = { ...plan, status: "development_package_verified", runtimeExecuted: false, appImageLauncherContractChecked: options.target === "linux-x64", verification, executable: await digestFile(paths.executable), asar: await digestFile(asarPath), distributions };
  await writeFile(join(partial, "development-package.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(partial, "SHA256SUMS.txt"), distributions.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""), { flag: "wx", mode: 0o600 });
  await rename(partial, output);
  return receipt;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await packageElectronDevelopment(parseDevelopmentPackageArguments(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${/^ELECTRON_[A-Z_]+$/u.test(error?.code ?? error?.message ?? "") ? error.code ?? error.message : "ELECTRON_DEVELOPMENT_FAILED"}\n`); process.exitCode = 1; }
}
