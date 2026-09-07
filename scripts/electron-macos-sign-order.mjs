/**
 * Preserve electron-builder's pinned macOS signer while correcting its
 * discovered-child ordering for bundles that contain an extra executable next
 * to CFBundleExecutable.
 *
 * `@electron/osx-sign` 1.3.3 signs children deepest-first. At equal depth it
 * preserves the walker order, which can place a bundle's main executable
 * before a sibling helper. Signing that executable seals its enclosing app,
 * so every sibling code object must already be signed. This hook changes only
 * that equal-depth order, then calls electron-builder's normal retrying signer
 * with its unmodified sign options.
 */

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const EXPECTED_OSX_SIGN_VERSION = "1.3.3";
const MAXIMUM_EXECUTABLE_NAME_LENGTH = 255;

let signingOrderLock = Promise.resolve();

export class ElectronMacOSSignOrderError extends Error {
  constructor(code) {
    super(`ELECTRON_MACOS_SIGN_ORDER_${code}`);
    this.name = "ElectronMacOSSignOrderError";
    this.code = this.message;
  }
}

function fail(code) {
  throw new ElectronMacOSSignOrderError(code);
}

function isDescendant(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function normalizedAppPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("INPUT_INVALID");
  }
  const appPath = resolve(value);
  if (extname(appPath) !== ".app") fail("INPUT_INVALID");
  return appPath;
}

function normalizedChildPath(value, appPath) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("DISCOVERY_INVALID");
  }
  const childPath = resolve(value);
  if (!isDescendant(appPath, childPath)) fail("DISCOVERY_INVALID");
  return childPath;
}

function validBundleExecutable(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAXIMUM_EXECUTABLE_NAME_LENGTH
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !/[\\/\0\r\n]/u.test(value)
    && basename(value) === value;
}

function removeOneTrailingLineTerminator(value) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/**
 * Read one bundle's executable name without loading arbitrary plist content
 * into the build process. `plutil` accepts both XML and binary macOS plists.
 */
export async function readCFBundleExecutable(bundlePath) {
  const appPath = normalizedAppPath(bundlePath);
  const contentsPath = join(appPath, "Contents");
  const infoPlistPath = join(contentsPath, "Info.plist");
  try {
    const metadata = await lstat(infoPlistPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("BUNDLE_EXECUTABLE_INVALID");
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlistPath],
      { encoding: "utf8", maxBuffer: 1024, windowsHide: true },
    );
    const executable = removeOneTrailingLineTerminator(stdout);
    if (!validBundleExecutable(executable)) fail("BUNDLE_EXECUTABLE_INVALID");
    return executable;
  } catch (error) {
    if (error instanceof ElectronMacOSSignOrderError) throw error;
    fail("BUNDLE_EXECUTABLE_INVALID");
  }
}

function pathDepth(path) {
  return path.split(sep).length;
}

/**
 * Return the order that osx-sign 1.3.3 must see from its walker. The signer
 * subsequently applies its own stable deepest-first sort, so this function
 * applies that same depth rule and only adds a helper-before-main tie-break.
 */
export async function orderMacOSSigningChildren(children, {
  appPath: suppliedAppPath,
  readBundleExecutable = readCFBundleExecutable,
} = {}) {
  const appPath = normalizedAppPath(suppliedAppPath);
  if (!Array.isArray(children) || typeof readBundleExecutable !== "function") {
    fail("INPUT_INVALID");
  }

  const normalizedChildren = children.map((child) => normalizedChildPath(child, appPath));
  const seenChildren = new Set();
  for (const childPath of normalizedChildren) {
    if (seenChildren.has(childPath)) fail("DISCOVERY_INVALID");
    seenChildren.add(childPath);
  }

  const bundlePaths = [appPath];
  for (const childPath of normalizedChildren) {
    if (extname(childPath) === ".app") bundlePaths.push(childPath);
  }
  const mainExecutables = new Set();
  for (const bundlePath of bundlePaths) {
    let executable;
    try {
      executable = await readBundleExecutable(bundlePath);
    } catch (error) {
      if (error instanceof ElectronMacOSSignOrderError) throw error;
      fail("BUNDLE_EXECUTABLE_INVALID");
    }
    if (!validBundleExecutable(executable)) fail("BUNDLE_EXECUTABLE_INVALID");
    mainExecutables.add(join(bundlePath, "Contents", "MacOS", executable));
  }

  return normalizedChildren
    .map((filePath, index) => ({
      filePath,
      index,
      depth: pathDepth(filePath),
      isBundleMainExecutable: mainExecutables.has(filePath),
    }))
    .sort((left, right) => right.depth - left.depth
      || Number(left.isBundleMainExecutable) - Number(right.isBundleMainExecutable)
      || left.index - right.index)
    .map(({ filePath }) => filePath);
}

function loadPinnedElectronBuilderSigningRuntime() {
  try {
    const electronBuilderPackagePath = require.resolve("electron-builder/package.json");
    const electronBuilderRequire = createRequire(electronBuilderPackagePath);
    const appBuilderPackagePath = electronBuilderRequire.resolve("app-builder-lib/package.json");
    const appBuilderRequire = createRequire(appBuilderPackagePath);
    const osxSignPackagePath = appBuilderRequire.resolve("@electron/osx-sign/package.json");
    const osxSignRequire = createRequire(osxSignPackagePath);
    const osxSignManifest = osxSignRequire("./package.json");
    const macCodeSign = appBuilderRequire("./out/codeSign/macCodeSign");
    const osxSignUtil = osxSignRequire("./dist/cjs/util");
    if (osxSignManifest?.version !== EXPECTED_OSX_SIGN_VERSION
        || typeof macCodeSign?.sign !== "function"
        || typeof osxSignUtil?.walkAsync !== "function") {
      fail("RUNTIME_INVALID");
    }
    return Object.freeze({
      readBundleExecutable: readCFBundleExecutable,
      sign: macCodeSign.sign,
      util: osxSignUtil,
    });
  } catch (error) {
    if (error instanceof ElectronMacOSSignOrderError) throw error;
    fail("RUNTIME_INVALID");
  }
}

function serializeWalkPatch(run) {
  const previous = signingOrderLock;
  let release;
  signingOrderLock = new Promise((resolveLock) => {
    release = resolveLock;
  });
  return previous.then(run, run).finally(release);
}

/**
 * Invoke electron-builder's normal `macCodeSign.sign` path while its pinned
 * osx-sign walker is temporarily ordered using CFBundleExecutable metadata.
 * The sign options, including identity, entitlements, timestamping, strict
 * verification, and retry policy, remain entirely owned by electron-builder.
 */
export async function signWithCFBundleExecutableOrder(signOptions, runtime = loadPinnedElectronBuilderSigningRuntime()) {
  const appPath = normalizedAppPath(signOptions?.app);
  if (typeof runtime?.sign !== "function"
      || typeof runtime?.util?.walkAsync !== "function"
      || typeof runtime?.readBundleExecutable !== "function") {
    fail("RUNTIME_INVALID");
  }

  return serializeWalkPatch(async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(runtime.util, "walkAsync");
    if (!originalDescriptor?.writable || typeof originalDescriptor.value !== "function") {
      fail("RUNTIME_INVALID");
    }
    const originalWalk = originalDescriptor.value;
    runtime.util.walkAsync = async (contentsPath) => {
      if (resolve(contentsPath) !== join(appPath, "Contents")) fail("DISCOVERY_INVALID");
      const children = await originalWalk(contentsPath);
      return orderMacOSSigningChildren(children, {
        appPath,
        readBundleExecutable: runtime.readBundleExecutable,
      });
    };
    try {
      return await runtime.sign(signOptions);
    } finally {
      Object.defineProperty(runtime.util, "walkAsync", originalDescriptor);
    }
  });
}

/** electron-builder resolves this named export from `mac.sign`. */
export async function sign(signOptions) {
  return signWithCFBundleExecutableOrder(signOptions);
}
