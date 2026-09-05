#!/usr/bin/env node

/**
 * Launch an already-packaged Windows Electron development candidate with a
 * durable, isolated profile.
 *
 * This entrypoint is intentionally narrower than the package builder. It
 * does not install an app, create credentials, enable smoke IPC, or provide
 * an upload endpoint. The packaged main process receives the exact Windows
 * qualification marker and performs the authoritative runtime-manifest,
 * native-binding, and Keytar digest checks before it starts the shell.
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

// Keep this sidecar runnable after a distribution is downloaded without the
// repository source tree. These values mirror the packaged main process's
// reviewed qualification contract; the main process still performs the
// authoritative manifest, digest, and binding checks before startup.
export const WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY =
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION";
export const WINDOWS_ELECTRON_QUALIFICATION_MARKER = "windows-electron-v1";
export const WINDOWS_ELECTRON_TEST_LANE = "windows-electron-smoke";
export const WINDOWS_ELECTRON_BINDING_RELATIVE_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
export const WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH =
  "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const DEFAULT_PROFILE_PATH = join(
  REPOSITORY_ROOT,
  ".release-build",
  "electron-user-test",
  "win32-x64",
  "profile",
);
const WINDOWS_TARGET = "win32-x64";
const WINDOWS_APP_NAME = "TiboTattle Dev.exe";
const USER_DATA_DIRECTORY = "user-data";
const PROFILE_DIRECTORY_NAMES = Object.freeze([
  "home",
  "appdata",
  "localappdata",
  "codex",
  "claude",
  "state",
  "config",
  "data",
  "cache",
  "runtime",
  "tmp",
]);
const FORWARDED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "ProgramData",
  "ProgramFiles",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramW6432",
  "LANG",
  "LC_ALL",
  "TZ",
]);
const FIXED_STATUS = Object.freeze({
  argumentInvalid: "ELECTRON_WINDOWS_DEVELOPMENT_ARGUMENT_INVALID",
  appInvalid: "ELECTRON_WINDOWS_DEVELOPMENT_APP_INVALID",
  hostUnsupported: "ELECTRON_WINDOWS_DEVELOPMENT_WINDOWS_HOST_REQUIRED",
  packageInvalid: "ELECTRON_WINDOWS_DEVELOPMENT_PACKAGE_INVALID",
  profileInvalid: "ELECTRON_WINDOWS_DEVELOPMENT_PROFILE_INVALID",
  profileUnsafe: "ELECTRON_WINDOWS_DEVELOPMENT_PROFILE_UNSAFE",
  launchUnavailable: "ELECTRON_WINDOWS_DEVELOPMENT_LAUNCH_UNAVAILABLE",
});

function fixedError(status) {
  const error = new Error(status);
  error.code = status;
  return error;
}

function fail(status) {
  throw fixedError(status);
}

function validPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && isAbsolute(value);
}

function normalizedPath(value, status = FIXED_STATUS.argumentInvalid) {
  if (!validPath(value)) fail(status);
  return resolve(value);
}

function pathKey(value, platform = process.platform) {
  const normalized = resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathContains(parent, child, platform = process.platform) {
  const selectedParent = pathKey(parent, platform);
  const selectedChild = pathKey(child, platform);
  if (selectedParent === selectedChild) return true;
  const childRelative = relative(selectedParent, selectedChild);
  return childRelative !== ""
    && !childRelative.startsWith("..")
    && !isAbsolute(childRelative);
}

function assertDistinctAppAndProfile(appPath, profilePath) {
  if (pathContains(appPath, profilePath) || pathContains(profilePath, appPath)) {
    fail(FIXED_STATUS.profileInvalid);
  }
  if (dirname(profilePath) === profilePath) fail(FIXED_STATUS.profileInvalid);
}

async function lstatRegular(path, status) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(status);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(status);
  return metadata;
}

async function lstatDirectory(path, status) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(status);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(status);
  return metadata;
}

/**
 * Reject symlinked existing components before recursive mkdir can follow one.
 * New components are created below a checked parent and are checked again
 * after creation.
 */
async function assertExistingPathComponents(path) {
  const selected = resolve(path);
  const root = parse(selected).root;
  const parts = relative(root, selected).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) fail(FIXED_STATUS.profileUnsafe);
      if (!metadata.isDirectory()) fail(FIXED_STATUS.profileUnsafe);
    } catch (error) {
      if (error?.code === FIXED_STATUS.profileUnsafe) throw error;
      if (error?.code === "ENOENT") break;
      fail(FIXED_STATUS.profileUnsafe);
    }
  }
}

async function ensurePrivateDirectory(path) {
  await assertExistingPathComponents(path);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  } catch {
    fail(FIXED_STATUS.profileUnsafe);
  }
  const metadata = await lstatDirectory(path, FIXED_STATUS.profileUnsafe);
  if (process.platform !== "win32"
      && typeof process.getuid === "function"
      && metadata.uid !== process.getuid()) {
    fail(FIXED_STATUS.profileUnsafe);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail(FIXED_STATUS.profileUnsafe);
  }
}

function profilePaths(profilePath) {
  const root = normalizedPath(profilePath, FIXED_STATUS.profileInvalid);
  return Object.freeze({
    root,
    userData: join(root, USER_DATA_DIRECTORY),
    home: join(root, "home"),
    appdata: join(root, "appdata"),
    localappdata: join(root, "localappdata"),
    codex: join(root, "codex"),
    claude: join(root, "claude"),
    state: join(root, "state"),
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
    tmp: join(root, "tmp"),
  });
}

/**
 * Parse only explicit app/profile inputs. The default profile is under the
 * repository's ignored release-build area so it remains durable across
 * launches without being part of a source or release artifact.
 */
export function parseWindowsDevelopmentLaunchArguments(
  argv = process.argv.slice(2),
) {
  if (!Array.isArray(argv)) fail(FIXED_STATUS.argumentInvalid);
  if (argv.includes("--help")) return Object.freeze({ help: true });
  const known = new Set(["--app", "--profile", "--dry-run"]);
  const seen = new Set();
  let appPath = null;
  let profilePath = DEFAULT_PROFILE_PATH;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!known.has(argument) || seen.has(argument)) fail(FIXED_STATUS.argumentInvalid);
    seen.add(argument);
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(FIXED_STATUS.argumentInvalid);
    }
    if (argument === "--app") appPath = normalizedPath(value);
    else profilePath = normalizedPath(value);
  }
  if (appPath === null || basename(appPath).toLowerCase() !== WINDOWS_APP_NAME.toLowerCase()) {
    fail(FIXED_STATUS.argumentInvalid);
  }
  const profile = normalizedPath(profilePath, FIXED_STATUS.profileInvalid);
  assertDistinctAppAndProfile(appPath, profile);
  return Object.freeze({
    help: false,
    appPath,
    profilePath: profile,
    dryRun,
  });
}

/**
 * Check the physical shape needed for the packaged main process to perform
 * its authenticated qualification. Digest and manifest authority remain in
 * apps/electron/windows-qualification.js; this check only gives the tester a
 * fixed early error when the unpacked candidate is obviously incomplete.
 */
export async function assertWindowsDevelopmentPackageLayout({
  appPath,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const selectedAppPath = normalizedPath(appPath, FIXED_STATUS.appInvalid);
  if (platform !== "win32" || architecture !== "x64"
      || basename(selectedAppPath).toLowerCase() !== WINDOWS_APP_NAME.toLowerCase()) {
    fail(FIXED_STATUS.packageInvalid);
  }
  await lstatRegular(selectedAppPath, FIXED_STATUS.appInvalid);
  const resources = join(dirname(selectedAppPath), "resources");
  await lstatDirectory(resources, FIXED_STATUS.packageInvalid);
  const asar = join(resources, "app.asar");
  await lstatRegular(asar, FIXED_STATUS.packageInvalid);
  const unpacked = `${asar}.unpacked`;
  await lstatDirectory(unpacked, FIXED_STATUS.packageInvalid);
  await lstatRegular(
    join(unpacked, ...WINDOWS_ELECTRON_BINDING_RELATIVE_PATH.split("/")),
    FIXED_STATUS.packageInvalid,
  );
  await lstatRegular(
    join(unpacked, ...WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH.split("/")),
    FIXED_STATUS.packageInvalid,
  );
  return Object.freeze({ target: WINDOWS_TARGET, packageReady: true });
}

/** Create the private persistent directories used by this launch only. */
export async function prepareWindowsDevelopmentProfile({
  appPath,
  profilePath,
} = {}) {
  const selectedAppPath = normalizedPath(appPath, FIXED_STATUS.appInvalid);
  const paths = profilePaths(profilePath);
  assertDistinctAppAndProfile(selectedAppPath, paths.root);
  await ensurePrivateDirectory(paths.root);
  await Promise.all([
    ensurePrivateDirectory(paths.userData),
    ...PROFILE_DIRECTORY_NAMES.map((name) => ensurePrivateDirectory(join(paths.root, name))),
  ]);
  return paths;
}

function copySafeEnvironment(environment) {
  const selected = {};
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    const value = environment?.[key];
    if (typeof value === "string" && !value.includes("\0")) selected[key] = value;
  }
  return selected;
}

function assertProfileObject(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    fail(FIXED_STATUS.profileInvalid);
  }
  for (const key of [
    "root",
    "userData",
    "home",
    "appdata",
    "localappdata",
    "codex",
    "claude",
    "state",
    "config",
    "data",
    "cache",
    "runtime",
    "tmp",
  ]) {
    if (!validPath(profile[key])) fail(FIXED_STATUS.profileInvalid);
    if (!pathContains(profile.root, profile[key])) fail(FIXED_STATUS.profileInvalid);
  }
  return profile;
}

/**
 * Construct the child environment without inheriting credentials, endpoints,
 * smoke controls, or arbitrary Node options from the invoking shell.
 */
export function buildWindowsDevelopmentEnvironment({
  environment = process.env,
  profile,
} = {}) {
  const paths = assertProfileObject(profile);
  const selected = copySafeEnvironment(environment);
  selected.USERPROFILE = paths.home;
  selected.HOME = paths.home;
  selected.APPDATA = paths.appdata;
  selected.LOCALAPPDATA = paths.localappdata;
  selected.TEMP = paths.tmp;
  selected.TMP = paths.tmp;
  selected.TMPDIR = paths.tmp;
  selected.CODEX_HOME = paths.codex;
  selected.CLAUDE_CONFIG_DIR = paths.claude;
  selected.XDG_CONFIG_HOME = paths.config;
  selected.XDG_DATA_HOME = paths.data;
  selected.XDG_CACHE_HOME = paths.cache;
  selected.XDG_RUNTIME_DIR = paths.runtime;
  selected.USAGE_MONITOR_STATE_ROOT = paths.state;
  selected.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE = "unified";
  selected[WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY] =
    WINDOWS_ELECTRON_QUALIFICATION_MARKER;
  selected.USAGE_MONITOR_TEST_LANE = WINDOWS_ELECTRON_TEST_LANE;
  return Object.freeze(selected);
}

export function buildWindowsDevelopmentLaunchSpec({
  appPath,
  profile,
  environment = process.env,
} = {}) {
  const selectedAppPath = normalizedPath(appPath, FIXED_STATUS.appInvalid);
  if (basename(selectedAppPath).toLowerCase() !== WINDOWS_APP_NAME.toLowerCase()) {
    fail(FIXED_STATUS.appInvalid);
  }
  const paths = assertProfileObject(profile);
  assertDistinctAppAndProfile(selectedAppPath, paths.root);
  return Object.freeze({
    command: selectedAppPath,
    args: Object.freeze([`--user-data-dir=${paths.userData}`]),
    options: Object.freeze({
      cwd: dirname(selectedAppPath),
      env: buildWindowsDevelopmentEnvironment({ environment, profile: paths }),
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    }),
  });
}

export function launchWindowsDevelopmentApplication({
  appPath,
  profile,
  environment = process.env,
  spawnProcess = nodeSpawn,
} = {}) {
  const spec = buildWindowsDevelopmentLaunchSpec({ appPath, profile, environment });
  let child;
  try {
    child = spawnProcess(spec.command, spec.args, spec.options);
  } catch {
    return Promise.reject(fixedError(FIXED_STATUS.launchUnavailable));
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", () => rejectExit(fixedError(FIXED_STATUS.launchUnavailable)));
    child.once("exit", (code, signal) => {
      if (signal !== null) return resolveExit(1);
      resolveExit(Number.isInteger(code) ? code : 1);
    });
  });
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/launch-electron-windows-development.mjs --app <absolute TiboTattle Dev.exe>",
    "  [--profile <absolute persistent profile>] [--dry-run]",
    "",
    "The Windows host must be win32/x64. The profile is durable and isolated; this launcher never installs, signs, uploads, or enables credential smoke controls.",
    "",
  ].join("\n"));
}

export async function runWindowsDevelopmentLaunch({
  options,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  spawnProcess = nodeSpawn,
} = {}) {
  if (options?.help === true) return Object.freeze({ help: true });
  if (options?.dryRun === true) {
    return Object.freeze({
      status: "dry_run",
      target: WINDOWS_TARGET,
      windowsQualificationRequested: true,
      windowsProductionReady: false,
      profileIsolated: true,
      hostedContribution: false,
      credentialSmoke: false,
    });
  }
  if (platform !== "win32" || architecture !== "x64") fail(FIXED_STATUS.hostUnsupported);
  await assertWindowsDevelopmentPackageLayout({
    appPath: options?.appPath,
    platform,
    architecture,
  });
  const profile = await prepareWindowsDevelopmentProfile({
    appPath: options.appPath,
    profilePath: options.profilePath,
  });
  const exitCode = await launchWindowsDevelopmentApplication({
    appPath: options.appPath,
    profile,
    environment,
    spawnProcess,
  });
  return Object.freeze({ status: "exited", exitCode, target: WINDOWS_TARGET });
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  try {
    const options = parseWindowsDevelopmentLaunchArguments();
    if (options.help) {
      printHelp();
    } else {
      const result = await runWindowsDevelopmentLaunch({ options });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === "exited") process.exitCode = result.exitCode;
    }
  } catch (error) {
    const status = Object.values(FIXED_STATUS).includes(error?.code)
      ? error.code
      : FIXED_STATUS.launchUnavailable;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}
