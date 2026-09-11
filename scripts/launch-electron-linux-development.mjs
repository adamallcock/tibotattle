#!/usr/bin/env node

/**
 * Launch an already-packaged Linux x64 Electron development candidate with a
 * durable, isolated profile.
 *
 * This launcher accepts either the executable in a tar distribution or an
 * AppImage. It prepares only local profile directories and starts the
 * candidate with a fixed argument vector. It never installs, signs, enables
 * credential qualification, or supplies a hosted contribution endpoint.
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

export const LINUX_DEVELOPMENT_TARGET = "linux-x64";
export const LINUX_DEVELOPMENT_APP_NAME = "tibotattle-dev";
export const LINUX_DEVELOPMENT_APPIMAGE_PATTERN =
  /^TiboTattle-Dev-[A-Za-z0-9._-]+-linux-x86_64\.AppImage$/u;

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const DEFAULT_PROFILE_PATH = join(
  REPOSITORY_ROOT,
  ".release-build",
  "electron-user-test",
  LINUX_DEVELOPMENT_TARGET,
  "profile",
);
const USER_DATA_DIRECTORY = "user-data";
const PROFILE_DIRECTORY_NAMES = Object.freeze([
  "home",
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
  "LANG",
  "LC_ALL",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
]);
const FIXED_STATUS = Object.freeze({
  argumentInvalid: "ELECTRON_LINUX_DEVELOPMENT_ARGUMENT_INVALID",
  appInvalid: "ELECTRON_LINUX_DEVELOPMENT_APP_INVALID",
  appUnsafe: "ELECTRON_LINUX_DEVELOPMENT_APP_UNSAFE",
  hostUnsupported: "ELECTRON_LINUX_DEVELOPMENT_LINUX_X64_REQUIRED",
  packageInvalid: "ELECTRON_LINUX_DEVELOPMENT_PACKAGE_INVALID",
  profileInvalid: "ELECTRON_LINUX_DEVELOPMENT_PROFILE_INVALID",
  profileUnsafe: "ELECTRON_LINUX_DEVELOPMENT_PROFILE_UNSAFE",
  displayUnavailable: "ELECTRON_LINUX_DEVELOPMENT_DISPLAY_UNAVAILABLE",
  launchUnavailable: "ELECTRON_LINUX_DEVELOPMENT_LAUNCH_UNAVAILABLE",
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
  const selected = resolve(value);
  if (selected === parse(selected).root) fail(status);
  return selected;
}

function pathKey(value) {
  return resolve(value);
}

function pathContains(parent, child) {
  const selectedParent = pathKey(parent);
  const selectedChild = pathKey(child);
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

function isAppImagePath(path) {
  return LINUX_DEVELOPMENT_APPIMAGE_PATTERN.test(basename(path));
}

function isLinuxApplicationPath(path) {
  return basename(path) === LINUX_DEVELOPMENT_APP_NAME || isAppImagePath(path);
}

async function lstatExecutable(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(FIXED_STATUS.appInvalid);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(FIXED_STATUS.appUnsafe);
  }
  if ((metadata.mode & 0o111) === 0) fail(FIXED_STATUS.appUnsafe);
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

/** Reject symlinked existing components before recursive mkdir can follow one. */
async function assertExistingPathComponents(path) {
  const selected = resolve(path);
  const root = parse(selected).root;
  const parts = relative(root, selected).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(FIXED_STATUS.profileUnsafe);
      }
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
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    fail(FIXED_STATUS.profileUnsafe);
  }
  if ((metadata.mode & 0o077) !== 0) fail(FIXED_STATUS.profileUnsafe);
}

function profilePaths(profilePath) {
  const root = normalizedPath(profilePath, FIXED_STATUS.profileInvalid);
  return Object.freeze({
    root,
    userData: join(root, USER_DATA_DIRECTORY),
    home: join(root, "home"),
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

export function parseLinuxDevelopmentLaunchArguments(
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
    if (argument === "--app") {
      appPath = normalizedPath(value);
    } else {
      profilePath = normalizedPath(value, FIXED_STATUS.profileInvalid);
    }
  }
  if (appPath === null || !isLinuxApplicationPath(appPath)) {
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
 * Check the physical shape needed by a tar-distribution launch. An AppImage
 * is intentionally treated as one executable; its internal AppRun contract
 * is verified by the package lane and is not unpacked or modified here.
 */
export async function assertLinuxDevelopmentPackageLayout({
  appPath,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const selectedAppPath = normalizedPath(appPath, FIXED_STATUS.appInvalid);
  if (platform !== "linux" || architecture !== "x64"
      || !isLinuxApplicationPath(selectedAppPath)) {
    fail(FIXED_STATUS.packageInvalid);
  }
  await lstatExecutable(selectedAppPath);
  if (isAppImagePath(selectedAppPath)) {
    return Object.freeze({ target: LINUX_DEVELOPMENT_TARGET, format: "AppImage" });
  }
  const resources = join(dirname(selectedAppPath), "resources");
  await lstatDirectory(resources, FIXED_STATUS.packageInvalid);
  await lstatRegular(join(resources, "app.asar"), FIXED_STATUS.packageInvalid);
  await lstatDirectory(join(resources, "app.asar.unpacked"), FIXED_STATUS.packageInvalid);
  return Object.freeze({ target: LINUX_DEVELOPMENT_TARGET, format: "unpacked" });
}

/** Create the private persistent directories used by this launch only. */
export async function prepareLinuxDevelopmentProfile({
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
    "codex",
    "claude",
    "state",
    "config",
    "data",
    "cache",
    "runtime",
    "tmp",
  ]) {
    if (!validPath(profile[key]) || !pathContains(profile.root, profile[key])) {
      fail(FIXED_STATUS.profileInvalid);
    }
  }
  return profile;
}

/** Construct the private child environment without forwarding credentials. */
export function buildLinuxDevelopmentEnvironment({
  environment = process.env,
  profile,
} = {}) {
  const paths = assertProfileObject(profile);
  const selected = copySafeEnvironment(environment);
  selected.HOME = paths.home;
  selected.TMPDIR = paths.tmp;
  selected.CODEX_HOME = paths.codex;
  selected.CLAUDE_CONFIG_DIR = paths.claude;
  selected.XDG_CONFIG_HOME = paths.config;
  selected.XDG_DATA_HOME = paths.data;
  selected.XDG_CACHE_HOME = paths.cache;
  selected.USAGE_MONITOR_STATE_ROOT = paths.state;
  selected.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE = "unified";
  return Object.freeze(selected);
}

function hasDisplay(environment) {
  return ["DISPLAY", "WAYLAND_DISPLAY"].some((key) => {
    const value = environment?.[key];
    return typeof value === "string" && value.length > 0;
  });
}

export function buildLinuxDevelopmentLaunchSpec({
  appPath,
  profile,
  environment = process.env,
} = {}) {
  const selectedAppPath = normalizedPath(appPath, FIXED_STATUS.appInvalid);
  if (!isLinuxApplicationPath(selectedAppPath)) fail(FIXED_STATUS.appInvalid);
  const paths = assertProfileObject(profile);
  assertDistinctAppAndProfile(selectedAppPath, paths.root);
  return Object.freeze({
    command: selectedAppPath,
    // No sandbox-disabling switch is ever supplied here. Chromium's normal
    // user-namespace or setuid-helper policy remains authoritative.
    args: Object.freeze([`--user-data-dir=${paths.userData}`]),
    options: Object.freeze({
      cwd: dirname(selectedAppPath),
      env: buildLinuxDevelopmentEnvironment({ environment, profile: paths }),
      shell: false,
      stdio: "ignore",
    }),
  });
}

export function launchLinuxDevelopmentApplication({
  appPath,
  profile,
  environment = process.env,
  spawnProcess = nodeSpawn,
} = {}) {
  const spec = buildLinuxDevelopmentLaunchSpec({ appPath, profile, environment });
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
    "Usage: node scripts/launch-electron-linux-development.mjs --app <absolute tibotattle-dev or TiboTattle-Dev-*.AppImage>",
    "  [--profile <absolute persistent profile>] [--dry-run]",
    "",
    "The Linux host must be x86_64 with a usable display and Chromium sandbox. The profile is durable and isolated; this launcher never installs, signs, uploads, or enables credential qualification.",
    "",
  ].join("\n"));
}

export async function runLinuxDevelopmentLaunch({
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
      target: LINUX_DEVELOPMENT_TARGET,
      linuxProductionReady: false,
      profileIsolated: true,
      hostedContribution: false,
      credentialSmoke: false,
      sandboxDisablingArgs: false,
    });
  }
  if (platform !== "linux" || architecture !== "x64") fail(FIXED_STATUS.hostUnsupported);
  await assertLinuxDevelopmentPackageLayout({
    appPath: options?.appPath,
    platform,
    architecture,
  });
  if (!hasDisplay(environment)) fail(FIXED_STATUS.displayUnavailable);
  const profile = await prepareLinuxDevelopmentProfile({
    appPath: options.appPath,
    profilePath: options.profilePath,
  });
  const exitCode = await launchLinuxDevelopmentApplication({
    appPath: options.appPath,
    profile,
    environment,
    spawnProcess,
  });
  return Object.freeze({
    status: "exited",
    exitCode,
    target: LINUX_DEVELOPMENT_TARGET,
  });
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  try {
    const options = parseLinuxDevelopmentLaunchArguments();
    if (options.help) {
      printHelp();
    } else {
      const result = await runLinuxDevelopmentLaunch({ options });
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
