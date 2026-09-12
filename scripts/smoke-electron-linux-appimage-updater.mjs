#!/usr/bin/env node

/**
 * Exercise the pinned electron-updater AppImage adapter with a loopback-only
 * feed and a disposable profile.
 *
 * This is deliberately an adapter qualification.  The production package
 * keeps its hosted feed in the signed package metadata, and AppImageUpdater
 * launches the replacement image after installation.  A real packaged
 * product update therefore needs a separately reviewed feed and process
 * isolation lane.  The self-test below proves the real 6.8.9 adapter,
 * product updater wrapper, checksum validation, replacement, and launch
 * hand-off without changing a production package or launching the product.
 */

import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { AppImageUpdater } from "electron-updater";

import {
  createProductionDesktopUpdater,
  createProductionDistributionMetadata,
} from "../apps/electron/desktop-updater.js";

const require = createRequire(import.meta.url);
const requireFromElectronUpdater = createRequire(require.resolve("electron-updater"));
const {
  HttpExecutor,
  configureRequestOptions,
  configureRequestUrl,
} = requireFromElectronUpdater("builder-util-runtime");
const RECEIPT_SCHEMA = "tibotattle-electron-linux-appimage-updater-smoke-v1";
const TARGET = "linux-x64";
const EXPECTED_UPDATER_VERSION = "6.8.9";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const BUILD_NUMBER = "1";
const CURRENT_VERSION = "0.1.18";
const NEXT_VERSION = "0.1.19";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_APPIMAGE_BYTES = 1024 * 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PROTOCOL = "http:";
const SELF_TEST_FLAG = "--self-test";
const EXECUTE_FLAG = "--execute";

class LinuxAppImageUpdaterSmokeError extends Error {
  constructor(code) {
    super(`ELECTRON_LINUX_APPIMAGE_UPDATER_SMOKE_${code}`);
    this.name = "LinuxAppImageUpdaterSmokeError";
    this.code = this.message;
  }
}

function fail(code) {
  throw new LinuxAppImageUpdaterSmokeError(code);
}

function validAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && isAbsolute(value);
}

function validVersion(value) {
  return typeof value === "string"
    && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = {
    mode: null,
    receiptPath: null,
    currentAppImage: null,
    nextAppImage: null,
    currentVersion: null,
    nextVersion: null,
    sourceRevision: null,
    buildNumber: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || seen.has(argument)) fail("ARGUMENT_INVALID");
    seen.add(argument);
    if (argument === SELF_TEST_FLAG || argument === EXECUTE_FLAG) {
      if (result.mode !== null) fail("ARGUMENT_INVALID");
      result.mode = argument === SELF_TEST_FLAG ? "self-test" : "execute";
      continue;
    }
    const property = {
      "--receipt": "receiptPath",
      "--current-appimage": "currentAppImage",
      "--next-appimage": "nextAppImage",
      "--current-version": "currentVersion",
      "--next-version": "nextVersion",
      "--source-revision": "sourceRevision",
      "--build-number": "buildNumber",
    }[argument];
    if (property === undefined || index + 1 >= argv.length) fail("ARGUMENT_INVALID");
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--") || value.includes("\0")) {
      fail("ARGUMENT_INVALID");
    }
    if (result[property] !== null) fail("ARGUMENT_INVALID");
    result[property] = value;
  }
  if (result.mode === null) fail("ARGUMENT_INVALID");
  if (result.receiptPath !== null && !validAbsolutePath(result.receiptPath)) {
    fail("ARGUMENT_INVALID");
  }
  if (result.mode === "self-test") {
    if (Object.entries(result).some(([key, value]) => key !== "mode" && key !== "receiptPath" && value !== null)) {
      fail("ARGUMENT_INVALID");
    }
    return Object.freeze(result);
  }
  if (result.receiptPath === null
      || !validAbsolutePath(result.currentAppImage)
      || !validAbsolutePath(result.nextAppImage)
      || result.currentAppImage === result.nextAppImage
      || !validVersion(result.currentVersion)
      || !validVersion(result.nextVersion)
      || compareVersions(result.currentVersion, result.nextVersion) >= 0
      || typeof result.sourceRevision !== "string"
      || !/^[0-9a-f]{40}$/u.test(result.sourceRevision)
      || typeof result.buildNumber !== "string"
      || !/^[1-9][0-9]{0,9}$/u.test(result.buildNumber)) {
    fail("ARGUMENT_INVALID");
  }
  // The execute mode is intentionally planning-only until a separately
  // reviewed process-isolation lane exists.  Refusing here prevents a real
  // production AppImage from being launched by the adapter smoke.
  fail("REAL_PRODUCT_EXECUTION_REQUIRES_ISOLATED_LANE");
}

function updaterVersion() {
  try {
    const manifest = require("electron-updater/package.json");
    if (manifest?.version !== EXPECTED_UPDATER_VERSION) fail("UPDATER_VERSION_MISMATCH");
    return manifest.version;
  } catch (error) {
    if (error instanceof LinuxAppImageUpdaterSmokeError) throw error;
    fail("UPDATER_VERSION_UNREADABLE");
  }
}

async function assertOwnedRegularFile(path, { executable = false } = {}) {
  if (!validAbsolutePath(path)) fail("PATH_INVALID");
  let details;
  try {
    details = await lstat(path);
  } catch {
    fail("INPUT_UNREADABLE");
  }
  if (!details.isFile() || details.nlink !== 1) fail("INPUT_TYPE_INVALID");
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    fail("INPUT_OWNER_INVALID");
  }
  if (executable && (details.mode & 0o111) === 0) fail("INPUT_NOT_EXECUTABLE");
  if (details.size <= 0 || details.size > MAX_APPIMAGE_BYTES) fail("INPUT_SIZE_INVALID");
  return details;
}

async function hashFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm);
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function hashFileBase64(path, algorithm = "sha512") {
  const hash = createHash(algorithm);
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("base64");
}

async function assertPrivateDirectory(path) {
  if (!validAbsolutePath(path)) fail("DIRECTORY_PATH_INVALID");
  let details;
  try {
    details = await lstat(path);
  } catch {
    fail("DIRECTORY_UNREADABLE");
  }
  if (!details.isDirectory() || (details.mode & 0o777) !== 0o700) {
    fail("DIRECTORY_NOT_PRIVATE");
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    fail("DIRECTORY_OWNER_INVALID");
  }
}

class LoopbackHttpExecutor extends HttpExecutor {
  constructor(port) {
    super();
    this.port = port;
  }

  validateUrl(url) {
    if (!(url instanceof URL)
        || url.protocol !== LOOPBACK_PROTOCOL
        || url.hostname !== LOOPBACK_HOST
        || Number(url.port) !== this.port) {
      fail("NON_LOOPBACK_REQUEST");
    }
  }

  createRequest(options, callback) {
    if (options === null || typeof options !== "object"
        || options.protocol !== LOOPBACK_PROTOCOL
        || options.hostname !== LOOPBACK_HOST
        || Number(options.port) !== this.port
        || typeof options.path !== "string" || !options.path.startsWith("/")
        || (options.method !== undefined && options.method !== "GET")) {
      fail("NON_LOOPBACK_REQUEST");
    }
    const request = httpRequest({
      ...options,
      hostname: LOOPBACK_HOST,
      port: this.port,
      method: options.method ?? "GET",
    }, callback);
    request.setTimeout(10_000, () => request.destroy(new Error("loopback request timeout")));
    return request;
  }

  async download(url, destination, options) {
    this.validateUrl(url);
    if (!validAbsolutePath(destination)) fail("DOWNLOAD_PATH_INVALID");
    return await options.cancellationToken.createPromise((resolveDownload, rejectDownload, onCancel) => {
      const requestOptions = {
        headers: options.headers || undefined,
        redirect: "manual",
      };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, {
        destination,
        options,
        onCancel,
        callback: (error) => {
          if (error == null) resolveDownload(destination);
          else rejectDownload(error);
        },
        responseHandler: null,
      }, 0);
    });
  }
}

async function startFeedServer({ nextPath, latestYaml }) {
  const requests = { latest: 0, artifact: 0, unexpected: 0 };
  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1/");
    } catch {
      requests.unexpected += 1;
      response.writeHead(400).end();
      return;
    }
    if (request.method !== "GET") {
      requests.unexpected += 1;
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/feed/latest-linux.yml") {
      requests.latest += 1;
      response.writeHead(200, { "content-type": "text/yaml; charset=utf-8" });
      response.end(latestYaml());
      return;
    }
    if (url.pathname === "/feed/next.AppImage") {
      requests.artifact += 1;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      require("node:fs").createReadStream(nextPath).pipe(response);
      return;
    }
    requests.unexpected += 1;
    response.writeHead(404).end();
  });
  server.listen(0, LOOPBACK_HOST);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address !== "object" || !Number.isInteger(address.port)) {
    await new Promise((resolveClose) => server.close(resolveClose));
    fail("FEED_BIND_FAILED");
  }
  return Object.freeze({
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
    port: address.port,
    requests,
  });
}

function makeAppAdapter({ root, version, configPath, profile, cache, marker }) {
  let quitCalled = false;
  const app = {
    version,
    name: "TiboTattle",
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: profile,
    baseCachePath: cache,
    async whenReady() {},
    onQuit() {},
    quit() { quitCalled = true; },
    relaunch() {},
  };
  void root;
  void marker;
  return Object.freeze({ app, wasQuitCalled: () => quitCalled });
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const details = await stat(path);
      if (details.isFile() && details.size > 0) return;
    } catch {
      // The synthetic replacement launch has not written its marker yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  fail("REPLACEMENT_LAUNCH_TIMEOUT");
}

async function writeReceipt(receiptPath, value) {
  if (!validAbsolutePath(receiptPath)) fail("RECEIPT_PATH_INVALID");
  try {
    const existing = await lstat(receiptPath);
    if (existing.isSymbolicLink() || !existing.isFile()) fail("RECEIPT_PATH_INVALID");
    fail("RECEIPT_EXISTS");
  } catch (error) {
    if (error instanceof LinuxAppImageUpdaterSmokeError) throw error;
    if (error?.code !== "ENOENT") fail("RECEIPT_PATH_INVALID");
  }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeFile(receiptPath, bytes, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
}

export async function runLinuxAppImageUpdaterSmoke({
  receiptPath,
  currentAppImage,
  nextAppImage,
  currentVersion = CURRENT_VERSION,
  nextVersion = NEXT_VERSION,
  sourceRevision = SOURCE_REVISION,
  buildNumber = BUILD_NUMBER,
} = {}) {
  if (!validAbsolutePath(receiptPath)
      || !validAbsolutePath(currentAppImage)
      || !validAbsolutePath(nextAppImage)
      || currentAppImage === nextAppImage
      || !validVersion(currentVersion)
      || !validVersion(nextVersion)
      || compareVersions(currentVersion, nextVersion) >= 0
      || !/^[0-9a-f]{40}$/u.test(sourceRevision)
      || !/^[1-9][0-9]{0,9}$/u.test(buildNumber)) {
    fail("ARGUMENT_INVALID");
  }
  if (process.platform !== "linux" || process.arch !== "x64") fail("NATIVE_LINUX_X64_REQUIRED");
  const version = updaterVersion();
  const currentDetails = await assertOwnedRegularFile(currentAppImage, { executable: true });
  const nextDetails = await assertOwnedRegularFile(nextAppImage, { executable: true });
  const currentSourceSha256 = await hashFile(currentAppImage);
  const nextSourceSha256 = await hashFile(nextAppImage);
  const nextSha512 = await hashFileBase64(nextAppImage);
  const root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "tibotattle-linux-updater-"));
  let feed = null;
  let desktopUpdater = null;
  let appAdapter = null;
  const previousEnvironment = {
    APPIMAGE: process.env.APPIMAGE,
    TEST_UPDATER_ARCH: process.env.TEST_UPDATER_ARCH,
    TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER:
      process.env.TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER,
  };
  const currentClone = join(root, "current.AppImage");
  const profile = join(root, "profile");
  const cache = join(root, "cache");
  const marker = join(root, "replacement-launched");
  const configPath = join(root, "app-update.yml");
  try {
    await mkdir(profile, { mode: 0o700 });
    await mkdir(cache, { mode: 0o700 });
    await assertPrivateDirectory(root);
    await assertPrivateDirectory(profile);
    await assertPrivateDirectory(cache);
    await copyFile(currentAppImage, currentClone);
    await chmod(currentClone, currentDetails.mode & 0o777);
    if (nextDetails.size > MAX_METADATA_BYTES) fail("SELF_TEST_ARTIFACT_INVALID");
    const nextBytes = await readFile(nextAppImage);
    const nextScript = nextBytes.toString("utf8");
    if (!nextScript.includes("TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER")) fail("SELF_TEST_ARTIFACT_INVALID");
    feed = await startFeedServer({
      nextPath: nextAppImage,
      latestYaml: () => [
        "version: 0.1.19",
        "files:",
        "  - url: next.AppImage",
        `    sha512: ${nextSha512}`,
        `    size: ${nextDetails.size}`,
        "path: next.AppImage",
        `sha512: ${nextSha512}`,
        "releaseDate: 2026-09-09T00:00:00.000Z",
        "",
      ].join("\n"),
    });
    await writeFile(configPath, [
      "provider: generic",
      `url: http://${LOOPBACK_HOST}:${feed.port}/feed`,
      "updaterCacheDirName: tibotattle-linux-updater-qualification",
      "",
    ].join("\n"), { mode: 0o600 });
    appAdapter = makeAppAdapter({ root, version: currentVersion, configPath, profile, cache, marker });
    const app = appAdapter.app;
    const realUpdater = new AppImageUpdater(null, app);
    realUpdater.logger = { info() {}, warn() {}, error() {} };
    realUpdater.httpExecutor = new LoopbackHttpExecutor(feed.port);
    realUpdater.updateConfigPath = configPath;
    realUpdater.disableDifferentialDownload = true;
    // BaseUpdater.quitAndInstall emits Electron's built-in
    // `autoUpdater.before-quit-for-update` event.  This bounded Node process
    // has no Electron main module, so retain the real AppImageUpdater install
    // path while supplying only the host quit callback that the wrapper needs.
    realUpdater.quitAndInstall = function quitAndInstallInNode(isSilent, isForceRunAfter) {
      const installed = this.install(isSilent, isForceRunAfter);
      if (installed) setImmediate(() => app.quit());
      return installed;
    };
    process.env.APPIMAGE = currentClone;
    process.env.TEST_UPDATER_ARCH = "x64";
    process.env.TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER = marker;
    desktopUpdater = createProductionDesktopUpdater({
      app,
      autoUpdater: realUpdater,
      distributionMetadata: createProductionDistributionMetadata({
        buildNumber,
        sourceRevision,
        target: TARGET,
      }),
      platform: "linux",
      architecture: "x64",
      preferences: {
        async get() { return { automaticDownload: false, available: false }; },
        async setAutomaticDownload() { throw new Error("preferences unavailable in smoke"); },
      },
      prepareForUpdate: async () => {},
      cancelPreparedUpdate: async () => {},
    });
    // Start and cancel the wrapper's queued initial check synchronously so
    // the explicit check below owns the only feed operation.
    const startPromise = desktopUpdater.start();
    const checkPromise = desktopUpdater.checkForUpdates();
    await startPromise;
    const checked = await checkPromise;
    if (checked.state !== "available" || checked.error !== "none") fail("CHECK_NOT_AVAILABLE");
    const downloaded = await desktopUpdater.downloadUpdate();
    if (downloaded.state !== "downloaded" || downloaded.progress !== 100) fail("DOWNLOAD_NOT_COMPLETE");
    const installing = await desktopUpdater.installAndRestart();
    if (installing.state !== "installing") fail("INSTALL_NOT_STARTED");
    await waitForFile(marker);
    const replacedSha256 = await hashFile(currentClone);
    if (replacedSha256 !== nextSourceSha256) fail("REPLACEMENT_HASH_MISMATCH");
    if (!appAdapter.wasQuitCalled()) fail("QUIT_HANDOFF_MISSING");
    const profileEntries = await (await import("node:fs/promises")).readdir(profile);
    if (!profileEntries.includes(".updaterId")) fail("PROFILE_NOT_ISOLATED");
    const currentAfterSha256 = await hashFile(currentAppImage);
    const nextAfterSha256 = await hashFile(nextAppImage);
    if (currentAfterSha256 !== currentSourceSha256 || nextAfterSha256 !== nextSourceSha256) {
      fail("SOURCE_MUTATED");
    }
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      status: "passed",
      target: TARGET,
      updaterVersion: version,
      httpExecutor: "builder-util-runtime-9.7.0-digest-transform",
      nodeQuitShim: true,
      scope: "pinned-electron-updater-appimage-adapter-with-production-wrapper",
      currentVersion,
      nextVersion,
      sourceRevision,
      sourceRevisionKind: "synthetic-fixture",
      buildNumber,
      currentSourceSha256,
      nextSourceSha256,
      replacedCloneSha256: replacedSha256,
      feedRequests: { ...feed.requests },
      replacement: "isolated-clone-only",
      profile: "disposable-private",
      network: "loopback-only",
      productionFeed: "untouched",
      productInstalledIntegration: "not_verified",
      realElectronProductLaunch: "not_verified",
      nativeCredentialQualification: "not_exercised",
      notifications: "not_exercised",
      sourceInputsUnchanged: true,
      appImageFormat: "synthetic-executable-fixture",
      claimLimit: "adapter-and-wrapper-only; no installed product update claim",
    };
    await writeReceipt(receiptPath, receipt);
    return Object.freeze(receipt);
  } finally {
    desktopUpdater?.dispose?.();
    if (feed !== null) await feed.close().catch(() => {});
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

export async function runSelfTest(receiptPath) {
  if (!validAbsolutePath(receiptPath)) fail("RECEIPT_PATH_INVALID");
  const root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "tibotattle-linux-updater-fixture-"));
  const current = join(root, "current.AppImage");
  const next = join(root, "next.AppImage");
  try {
    await writeFile(current, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(next, "#!/bin/sh\nif [ -n \"$TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER\" ]; then printf 'launched\\n' > \"$TIBOTATTLE_LINUX_UPDATER_PROBE_MARKER\"; fi\nexit 0\n", { mode: 0o755 });
    return await runLinuxAppImageUpdaterSmoke({ receiptPath, currentAppImage: current, nextAppImage: next });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === "self-test") {
      if (options.receiptPath === null) fail("RECEIPT_REQUIRED");
      await runSelfTest(options.receiptPath);
    }
    process.stdout.write("LINUX_APPIMAGE_UPDATER_SMOKE_PASSED\n");
  } catch (error) {
    process.stderr.write(`${error?.code ?? "ELECTRON_LINUX_APPIMAGE_UPDATER_SMOKE_FAILED"}\n`);
    process.exitCode = 1;
  }
}

export { parseArguments };
