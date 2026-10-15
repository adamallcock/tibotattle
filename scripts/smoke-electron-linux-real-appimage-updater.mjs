#!/usr/bin/env node
/** Real normal-app update; fixed production URL resolves only inside network-none. */
import distribution from "../config/electron-production-distribution.cjs";
import { spawn, spawnSync } from "node:child_process";
import { fetchRendererJson } from "./lib/authorized-renderer-fetch.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:https";
import { lookup } from "node:dns/promises";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContainerContract, connectCdp, freeTcpPort, terminateLinuxSmokeChild } from "./smoke-electron-linux.mjs";
import { createLinuxNormalPackagedSmokeFixture, normalPackagedSmokeEnvironment } from "./smoke-electron-linux-packaged.mjs";
import { linuxAppImageIdentity } from "./build-linux-updater-rehearsal.mjs";
import { createDesktopSharingBackend, createDesktopSharingCoordinator } from "../apps/electron/desktop-sharing.js";
import { captureLinuxStartupBaseline, waitForLinuxSuccessorStartup, assertLinuxCdpEndpointOwned, assertLinuxCdpPortUnused, sameLinuxProcessIdentity, linuxProcessCommandLineFacts } from "./lib/linux-successor-evidence.mjs";
import { readLocalCollectorCheckpoint } from "../src/local-collector-state.js";
import { isDeepStrictEqual } from "node:util";
import { validateLinuxQualificationFeed, validateLinuxQualificationPackagedAuthority } from "./lib/linux-qualification-feed.mjs";
import { readLinuxQualificationFile, readLinuxQualificationAsarFile, validateLinuxPrivateQualificationRecord } from "./prepare-linux-updater-qualification.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXEC = "/opt/tibotattle-updater-exec";
const HOST = "updates.tibotattle.com";
const FEED = `https://${HOST}/electron/stable/linux-x64`;
const fail = (code) => { throw Object.assign(new Error(code), { code: `LINUX_REAL_APPIMAGE_${code}` }); };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function waitFor(read, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (value) return value; await delay(200); }
  fail("TIMEOUT");
}
export function validateLinuxRealUpdaterPair(pair, revision) {
  const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
  if (!exact(pair, ["schemaVersion", "sourceRevision", "scope", "feed", "images", "publication"])
      || !exact(pair.images, ["current", "next"]) || typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision)
      || pair?.schemaVersion !== "tibotattle-linux-real-updater-pair-v1" || pair.sourceRevision !== revision
      || pair.scope !== "private_test_version_override" || pair.feed !== FEED || pair.publication !== "not_performed") fail("PAIR_INVALID");
  for (const role of ["current", "next"]) {
    const image = pair.images?.[role];
    if (!exact(image, ["bytes", "sha256", "asarSha256", "sha512", "version", "file"]) || typeof image.file !== "string" || !new RegExp(`^${role}/[A-Za-z0-9_.-]+\\.AppImage$`, "u").test(image.file)
        || !/^[0-9a-f]{64}$/u.test(image.sha256 ?? "") || !/^[0-9a-f]{64}$/u.test(image.asarSha256 ?? "")
        || !/^[A-Za-z0-9+/]{86}==$/u.test(image.sha512 ?? "") || !Number.isSafeInteger(image.bytes) || image.bytes < 4096 || image.bytes > 1024 ** 3
        || !/^\d+\.\d+\.\d+$/u.test(image.version ?? "")) fail("PAIR_INVALID");
  }
  const a = pair.images.current.version.split(".").map(Number); const b = pair.images.next.version.split(".").map(Number);
  if ([...a, ...b].some((value) => !Number.isSafeInteger(value)) || a[0] !== b[0] || a[1] !== b[1] || b[2] !== a[2] + 1) fail("PAIR_INVALID");
  return pair;
}
export function isLinuxUpdaterSettingsURL(value, dashboardOrigin) {
  try {
    const url = new URL(value); const dashboard = new URL(dashboardOrigin);
    return dashboard.protocol === "http:" && dashboard.hostname === "127.0.0.1"
      && url.origin === dashboard.origin && url.pathname === "/electron-settings.html"
      && url.search === "" && url.username === "" && url.password === "";
  } catch { return false; }
}
export function linuxPrivateFeedRequestPath(requestUrl, artifactRequestPath) {
  if (typeof requestUrl !== "string" || requestUrl.length > 1024) return null;
  let url; try { url = new URL(requestUrl, FEED); } catch { return null; }
  if (url.origin !== `https://${HOST}` || url.username || url.password || url.hash) return null;
  if (url.pathname === "/electron/stable/linux-x64/latest-linux.yml" && (url.search === "" || /^\?noCache=[0-9a-v]{1,20}$/u.test(url.search))) return "feed";
  if (/^\/electron\/stable\/linux-x64\/TiboTattle-(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})-linux-x86_64\.AppImage$/u.test(artifactRequestPath ?? "")
      && url.pathname === artifactRequestPath && url.search === "") return "image";
  return null;
}

/** Normal automatic startup may finish before Settings opens. Do not wait for
 * a Check button that correctly stays disabled after a completed download. */
export async function prepareLinuxUpdaterDownload({ readUpdate, click, automaticDownload, wait = waitFor }) {
  let update = await readUpdate();
  let check = "automatic"; let download = "automatic";
  if (update.canCheck && !update.canDownload && !update.canInstall) {
    await click("check"); check = "settings_button";
  }
  update = await wait(async () => {
    const value = await readUpdate();
    return value.canDownload || value.canInstall || value.status === "downloading" ? value : null;
  });
  if (update.canDownload && !automaticDownload) {
    await click("download"); download = "settings_button";
  }
  await wait(async () => (await readUpdate()).canInstall === true, 120000);
  return { check, download };
}

export function linuxUpdaterFixedStatus(value) {
  const statuses = new Set(["unavailable", "ready", "checking", "available", "downloading", "downloaded", "current", "installing", "error"]);
  const errors = new Set(["none", "configuration_failed", "check_failed", "download_failed", "install_failed", "preferences_unavailable", "shutdown_failed", "unavailable"]);
  return { status: statuses.has(value?.status) ? value.status : "unavailable",
    error: errors.has(value?.error) ? value.error : "unavailable" };
}
export function linuxUpdaterRuntimeErrorCategories(text) {
  // Synthetic app output stays in memory; only these fixed classifiers leave.
  return ["EACCES", "ENOENT", "EXDEV", "EROFS", "ENOSPC"].filter((code) => new RegExp(`\\b${code}\\b`, "u").test(text));
}
function command(name, args, options = {}) {
  const result = spawnSync(name, args, { stdio: "ignore", timeout: 15000, shell: false, ...options });
  if (result.error || result.status !== 0 || result.signal) fail("LOCAL_TRUST_SETUP_FAILED");
}
async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(2000) });
  if (!response.ok || response.redirected || !response.body) fail("CDP_RESPONSE_INVALID");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 64 * 1024) fail("CDP_RESPONSE_INVALID"); chunks.push(Buffer.from(value));
    }
    const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(rows) || rows.length > 32) fail("CDP_RESPONSE_INVALID"); return rows;
  } catch { fail("CDP_RESPONSE_INVALID"); }
  finally { void reader.cancel().catch(() => {}); }
}
export async function connectPage(port, predicate, { assertCdpAuthority, readTargets = targets, connect = connectCdp, wait = waitFor } = {}) {
  const check = async () => { if (typeof assertCdpAuthority !== "function" || await assertCdpAuthority({ port }) !== true) fail("CDP_AUTHORITY_UNAVAILABLE"); };
  return wait(async () => {
    await check(); const rows = await readTargets(port); await check();
    if (!Array.isArray(rows) || rows.length > 32) fail("CDP_RESPONSE_INVALID");
    const pages = rows.filter((row) => row?.type === "page" && predicate(row.url));
    if (pages.length > 1) fail("CDP_PAGE_AMBIGUOUS");
    const page = pages[0]; if (!page) return null;
    let url; try { url = new URL(page.webSocketDebuggerUrl); } catch { fail("CDP_RESPONSE_INVALID"); }
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port !== String(port) || url.username || url.password || url.search || url.hash
        || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/u.test(url.pathname)) fail("CDP_RESPONSE_INVALID");
    await check(); const connection = await connect(page);
    try { await check(); return connection; } catch (error) { connection.close(); throw error; }
  });
}
export function isOwnedLinuxUpdaterExecutable(value) {
  return typeof value === "string" && resolve(value) === value
    && value.startsWith(`${EXEC}/tmp/`) && basename(value) === "tibotattle";
}
function processStartTime(stat) {
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!/^\d+$/u.test(start ?? "")) fail("PROCESS_IDENTITY_INVALID");
  return start;
}
export async function readLinuxUpdaterProcessIdentity(pid, expected, { argumentsForLaunch, config, read = readFile, link = readlink, stat = lstat, hash = digest } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Array.isArray(argumentsForLaunch) || argumentsForLaunch.length > 4
      || argumentsForLaunch.some(arg => typeof arg !== "string" || /[\s\u0000-\u001f]/u.test(arg))) fail("PROCESS_IDENTITY_INVALID");
  const executable = await link(`/proc/${pid}/exe`);
  if (!isOwnedLinuxUpdaterExecutable(executable)) return null;
  try {
    const before = await read(`/proc/${pid}/stat`, "utf8");
    const commandLine = await read(`/proc/${pid}/cmdline`, "utf8");
    const facts = linuxProcessCommandLineFacts({ commandLine, executable });
    if (facts === null) fail("PROCESS_IDENTITY_INVALID");
    if (facts.role !== null) return null;
    if (!new RegExp(`^Uid:\\s+${process.getuid()}\\s+${process.getuid()}\\s+${process.getuid()}\\s+${process.getuid()}$`, "mu").test(await read(`/proc/${pid}/status`, "utf8"))) fail("PROCESS_IDENTITY_INVALID");
    const entries = (await read(`/proc/${pid}/environ`, "utf8")).split("\0");
    if (entries.includes("ELECTRON_RUN_AS_NODE=1")) return null;
    if (entries.some(value => value.startsWith("ELECTRON_RUN_AS_NODE=")) || !entries.includes(`XDG_CONFIG_HOME=${config}`)) fail("PROCESS_IDENTITY_INVALID");
    const argv = [executable, ...argumentsForLaunch];
    const asar = join(dirname(executable), "resources/app.asar");
    for (const path of [executable, asar]) {
      const value = await stat(path);
      if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid() || value.nlink !== 1 || (value.mode & 0o022) !== 0) fail("PROCESS_IDENTITY_INVALID");
    }
    if (await hash(asar) !== expected.asarSha256 || await hash(join(EXEC, "TiboTattle.AppImage")) !== expected.sha256) return null;
    if (commandLine !== `${argv.join("\0")}\0` && commandLine !== `${argv.join(" ")}\0`) fail("PROCESS_LAUNCH_ARGUMENTS_INVALID");
    const executableSha256 = await hash(executable);
    if (processStartTime(await read(`/proc/${pid}/stat`, "utf8")) !== processStartTime(before)
        || await read(`/proc/${pid}/cmdline`, "utf8") !== commandLine || await link(`/proc/${pid}/exe`) !== executable) fail("PROCESS_IDENTITY_CHANGED");
    return { pid, startTime: processStartTime(before), executable, executableSha256 };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || error.code?.startsWith("LINUX_REAL_APPIMAGE_")) throw error;
    // An admitted private executable with unreadable proof is ambiguous, not an
    // unrelated process that enumeration may silently omit.
    fail("PROCESS_IDENTITY_INVALID");
  }
}
export async function currentUpdaterProcess(expected, options, { list = readdir, readIdentity = readLinuxUpdaterProcessIdentity } = {}) {
  const selected = [];
  for (const entry of await list("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try { const value = await readIdentity(Number(entry), expected, options); if (value) selected.push(value); }
    catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
  if (selected.length > 1) fail("MULTIPLE_APPS");
  return selected[0] ?? null;
}
function exactUpdaterReader(identity, expected, options) {
  return async () => {
    const current = await readLinuxUpdaterProcessIdentity(identity.pid, expected, options);
    if (!sameLinuxProcessIdentity(identity, current) || identity.executableSha256 !== current.executableSha256) fail("PROCESS_IDENTITY_CHANGED");
    return current;
  };
}
async function capturedProcessAlive(identity) {
  try { return processStartTime(await readFile(`/proc/${identity.pid}/stat`, "utf8")) === identity.startTime; }
  catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
}
async function captureUpdaterTree(browser) {
  const found = [browser];
  for (let pass = 0; pass < 8; pass++) {
    const before = found.length;
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name) || found.some(row => row.pid === Number(name))) continue;
      try {
        const status = await readFile(`/proc/${name}/status`, "utf8");
        const parent = found.find(row => row.pid === Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]));
        if (!parent || !await capturedProcessAlive(parent)) continue;
        if (!new RegExp(`^Uid:\\s+${process.getuid()}\\s+${process.getuid()}\\s+${process.getuid()}\\s+${process.getuid()}$`, "mu").test(status)) fail("PROCESS_TREE_UNTRUSTED");
        found.push({ pid: Number(name), startTime: processStartTime(await readFile(`/proc/${name}/stat`, "utf8")) });
        if (found.length > 1024) fail("PROCESS_TREE_UNBOUNDED");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    if (found.length === before) return found;
  }
  fail("PROCESS_TREE_UNBOUNDED");
}
async function waitUpdaterTreeGone(tree) {
  await waitFor(async () => (await Promise.all(tree.map(capturedProcessAlive))).every(value => value === false), 15000);
}
async function stopUpdaterProcess(identity) {
  const tree = await captureUpdaterTree(identity);
  if (await capturedProcessAlive(identity)) process.kill(identity.pid, "SIGUSR2");
  await waitUpdaterTreeGone(tree);
}
function updaterCdpAuthority({ port, expected, options, onIdentity }) {
  let identityPromise; let refused = false; const binding = {};
  return async () => {
    if (refused) fail("CDP_AUTHORITY_UNAVAILABLE");
    try {
      identityPromise ??= waitFor(() => currentUpdaterProcess(expected, options));
      const selected = await identityPromise; onIdentity(selected);
      await waitFor(async () => {
        try { return await assertLinuxCdpEndpointOwned({ identity: selected, readIdentity: exactUpdaterReader(selected, expected, options), port, binding }); }
        catch (error) { if (error.code === "LINUX_SUCCESSOR_CDP_NOT_READY") return false; throw error; }
      });
      return true;
    } catch (error) { refused = true; throw error; }
  };
}
export async function processHealth(pid, { dashboard = null, assertCdpAuthority } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof dashboard?.evaluate !== "function" || typeof assertCdpAuthority !== "function") {
    fail("RESTART_AUTHORIZATION_UNAVAILABLE");
  }
  if (await assertCdpAuthority() !== true) fail("CDP_AUTHORITY_UNAVAILABLE");
  const origin = await dashboard.evaluate("location.origin");
  const health = await fetchRendererJson(dashboard, new URL("/api/local/health", origin), { timeoutMs: 1000, maximumBytes: 64 * 1024 });
  if (await assertCdpAuthority() !== true) fail("CDP_AUTHORITY_UNAVAILABLE");
  return health?.status === "ready";
}

async function digest(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
export function linuxUpdaterUnavailableState(checkpoint) {
  const started = checkpoint?.collectionStartedAt;
  if (checkpoint?.accountScopeMarker !== null || typeof started !== "string" || !Number.isFinite(Date.parse(started))
      || new Date(Date.parse(started)).toISOString() !== started) fail("LOCAL_STATE_UNAVAILABLE");
  // This lane intentionally has no Secret Service. Preserve its explicit null
  // marker and collection start without inventing keyed credential evidence.
  return { collectionStartedAt: started, accountScopeMarker: null };
}
export async function runRealLinuxAppImageUpdater() {
  if (distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS.length === 0) fail("UPDATE_TRUST_UNPROVISIONED");
  const contract = assertContainerContract();
  if (process.arch !== "x64" || process.getuid() !== 1000 || (await lookup(HOST)).address !== "127.0.0.1") fail("ISOLATION_REQUIRED");
  const execStat = await lstat(EXEC);
  if (!execStat.isDirectory() || execStat.isSymbolicLink() || execStat.uid !== 1000 || (execStat.mode & 0o777) !== 0o700) fail("ISOLATION_REQUIRED");
  const pairRoot = join(ROOT, ".release-build/electron-linux-updater-rehearsal");
  const pairBytes = await readLinuxQualificationFile(join(pairRoot, "pair.json"), 131072);
  const pair = validateLinuxRealUpdaterPair(JSON.parse(pairBytes), contract.sourceRevision);
  for (const role of ["current", "next"]) {
    const identity = await linuxAppImageIdentity(join(pairRoot, pair.images[role].file));
    if (identity.sha256 !== pair.images[role].sha256 || identity.sha512 !== pair.images[role].sha512 || identity.bytes !== pair.images[role].bytes) fail("INPUT_CHANGED");
  }
  let admission;
  try { admission = validateLinuxPrivateQualificationRecord(JSON.parse(await readLinuxQualificationFile(join(pairRoot, "qualification/qualification.json"), 16384)), { pairBytes, sourceRevision: pair.sourceRevision }); }
  catch { fail("SIGNED_QUALIFICATION_INPUT_REQUIRED"); }
  const feed = await validateLinuxQualificationFeed({ feedBytes: await readLinuxQualificationFile(join(pairRoot, "qualification/latest-linux.yml"), 65536),
    descriptor: admission.feed, image: pair.images.next, currentVersion: pair.images.current.version });
  const verifyPackagedAuthority = async identity => {
    const actual = await validateLinuxQualificationPackagedAuthority({
      readAsarFile: file => readLinuxQualificationAsarFile(join(dirname(identity.executable), "resources/app.asar"), file),
      readSourceFile: file => readLinuxQualificationFile(join(ROOT, ".release-build/electron-production/linux-x64/app", file), 1024 ** 2),
    });
    if (!isDeepStrictEqual(actual, admission.packagedAuthority)) fail("PACKAGED_AUTHORITY_CHANGED");
    if (await digest(join(dirname(identity.executable), "resources/app.asar")) !== (identity === currentIdentity ? pair.images.current.asarSha256 : pair.images.next.asarSha256)) fail("PACKAGED_AUTHORITY_CHANGED");
  };
  const original = await createLinuxNormalPackagedSmokeFixture();
  const config = join(original.home, ".config"); await mkdir(config, { mode: 0o700 });
  const profile = join(config, "TiboTattle"); await rename(original.userData, profile);
  const fixture = { ...original, userData: profile, stateFile: join(profile, "companion-state/local-collector-state-v1.sqlite") };
  const sharing = createDesktopSharingCoordinator({ backend: createDesktopSharingBackend({ rootPath: join(profile, "desktop-settings") }), installationState: "fresh", destinationOrigin: "https://tibotattle.com" });
  await sharing.initialize(); await sharing.setEnabled(false);
  const image = join(EXEC, "TiboTattle.AppImage"); await copyFile(join(pairRoot, pair.images.current.file), image); await chmod(image, 0o700);
  const temp = join(EXEC, "tmp"); await mkdir(temp, { mode: 0o700 });
  const key = join(fixture.root, "loopback.key"); const cert = join(fixture.root, "loopback.crt");
  command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", key, "-out", cert]);
  const nss = join(fixture.home, ".pki/nssdb"); await mkdir(nss, { recursive: true, mode: 0o700 });
  command("certutil", ["-N", "--empty-password", "-d", `sql:${nss}`]);
  command("certutil", ["-A", "-d", `sql:${nss}`, "-n", "TiboTattle isolated loopback CA", "-t", "C,,", "-i", cert]);
  let servedFeed = 0; let servedImage = 0; let unexpectedRequests = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const path = linuxPrivateFeedRequestPath(request.url, feed.artifactRequestPath);
    if (request.headers.host !== HOST || request.method !== "GET") { unexpectedRequests++; response.writeHead(404).end(); return; }
    if (path === "feed") { servedFeed++; response.writeHead(200, { "content-type": "application/yaml" }).end(feed.feedBytes); return; }
    if (path === "image") {
      response.once("finish", () => { servedImage++; });
      response.writeHead(200, { "content-length": pair.images.next.bytes, "content-type": "application/octet-stream" });
      const stream = createReadStream(join(pairRoot, pair.images.next.file));
      stream.once("error", () => response.destroy()); response.once("close", () => stream.destroy()); stream.pipe(response); return;
    }
    unexpectedRequests++; response.writeHead(404).end();
  });
  let child; let dashboard; let settings; let currentIdentity; let automaticIdentity; let controlledIdentity; let runtimeErrors = "";
  const receipt = { schemaVersion: "tibotattle-linux-real-appimage-updater-v2", sourceRevision: contract.sourceRevision, signedFeed: admission.feed, packagedAuthority: admission.packagedAuthority,
    versions: { current: pair.images.current.version, next: pair.images.next.version }, images: { current: pair.images.current.sha256, next: pair.images.next.sha256 },
    scope: "normal_product_AppImages_with_private_next_version", feed: "fixed_production_URL_simulated_inside_network_none", ca: "disposable_profile_only", publication: "not_performed" };
  let stage = "loopback_tls";
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(443, "127.0.0.1", done); });
    const port = await freeTcpPort();
    const environment = { ...normalPackagedSmokeEnvironment({ fixture, service: "unavailable" }),
      XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(fixture.home, ".cache"), XDG_DATA_HOME: join(fixture.home, ".local/share"),
      APPIMAGE_EXTRACT_AND_RUN: "1", TMPDIR: temp, NODE_EXTRA_CA_CERTS: cert };
    stage = "current_launch";
    const launchArguments = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--disable-gpu"];
    const currentOptions = { argumentsForLaunch: launchArguments, config };
    await assertLinuxCdpPortUnused({ port });
    child = spawn(image, launchArguments, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { runtimeErrors = (runtimeErrors + chunk.toString("utf8")).slice(-16384); });
    child.on("error", () => {});
    const currentAuthority = updaterCdpAuthority({ port, expected: pair.images.current, options: currentOptions, onIdentity: value => { currentIdentity = value; } });
    await currentAuthority(); await verifyPackagedAuthority(currentIdentity);
    dashboard = await connectPage(port, (url) => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url), { assertCdpAuthority: currentAuthority });
    stage = "dashboard_ready";
    await waitFor(() => dashboard.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"));
    await waitFor(() => processHealth(currentIdentity.pid, { dashboard, assertCdpAuthority: currentAuthority }));
    await dashboard.evaluate("globalThis.tibotattleDesktop.openSettings()");
    stage = "settings_ready";
    const dashboardOrigin = await dashboard.evaluate("location.origin");
    settings = await connectPage(port, (url) => isLinuxUpdaterSettingsURL(url, dashboardOrigin), { assertCdpAuthority: currentAuthority });
    await waitFor(() => settings.evaluate("typeof globalThis.tibotattleDesktop?.getSettings === 'function' && document.querySelector('#settings-tab-about') !== null"));
    stage = "current_preferences";
    const before = await settings.evaluate("globalThis.tibotattleDesktop.getSettings()");
    if (before.about.version !== pair.images.current.version) fail("CURRENT_VERSION_MISMATCH");
    await settings.evaluate("globalThis.tibotattleDesktop.setRefreshInterval(900)");
    if ((await settings.evaluate("globalThis.tibotattleDesktop.getSharingPreference()")).enabled !== false) fail("OPT_OUT_MISSING");
    stage = "update_download";
    await settings.evaluate("document.querySelector('#settings-tab-about').click()");
    receipt.updateInitiation = await prepareLinuxUpdaterDownload({
      readUpdate: async () => (await settings.evaluate("globalThis.tibotattleDesktop.getSettings()")).about.update,
      automaticDownload: before.about.automaticUpdates.enabled === true,
      click: async (action) => settings.evaluate(action === "check"
        ? "document.querySelector('#settings-check-for-updates').click()"
        : "document.querySelector('#settings-download-update').click()"),
    });
    stage = "current_process_identity";
    await exactUpdaterReader(currentIdentity, pair.images.current, currentOptions)();
    const predecessorTree = await captureUpdaterTree(currentIdentity);
    const baseline = await captureLinuxStartupBaseline({ userData: profile });
    const beforeState = linuxUpdaterUnavailableState(await readLocalCollectorCheckpoint({ stateFile: fixture.stateFile }));
    const rawFixture = join(fixture.codexHome, "sessions/synthetic-linux-smoke.jsonl");
    const rawBefore = await digest(rawFixture);
    stage = "install_button_ready";
    await waitFor(() => settings.evaluate("(() => { const button = document.querySelector('#settings-install-update'); return button !== null && button.disabled === false && button.hidden === false; })()"));
    receipt.installButtonReady = true;
    stage = "update_install";
    const installStartedAt = Date.now();
    await settings.evaluate("setTimeout(() => document.querySelector('#settings-install-update').click(), 25)");
    let checkedImageStamp;
    let nextStatusRead = 0;
    await waitFor(async () => {
      if (Date.now() >= nextStatusRead) {
        nextStatusRead = Date.now() + 1000;
        try { receipt.lastInstallStatus = linuxUpdaterFixedStatus((await settings.evaluate("globalThis.tibotattleDesktop.getSettings()")).about.update); }
        catch { /* Expected once the current app exits. */ }
        if (receipt.lastInstallStatus?.status === "error") fail("INSTALLER_REPORTED_ERROR");
      }
      const stat = await lstat(image).catch(() => null);
      receipt.originalImage = stat ? "present" : "missing";
      if (!stat || stat.size !== pair.images.next.bytes) return false;
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (stamp === checkedImageStamp) return false;
      checkedImageStamp = stamp;
      const hash = await digest(image).catch(() => null);
      receipt.originalImage = hash === pair.images.next.sha256 ? "exact_next_image"
        : hash === pair.images.current.sha256 ? "exact_current_image" : "other_bytes";
      return hash === pair.images.next.sha256;
    }, 60000);
    stage = "automatic_restart";
    const automaticOptions = { argumentsForLaunch: [], config };
    automaticIdentity = await waitFor(() => currentUpdaterProcess(pair.images.next, automaticOptions), 90000);
    if (predecessorTree.some(value => value.pid === automaticIdentity.pid && value.startTime === automaticIdentity.startTime)) fail("AUTOMATIC_RESTART_UNPROVEN");
    await waitUpdaterTreeGone(predecessorTree);
    await waitForLinuxSuccessorStartup({ identity: automaticIdentity, readIdentity: exactUpdaterReader(automaticIdentity, pair.images.next, automaticOptions),
      userData: profile, baseline, version: pair.images.next.version, notBefore: installStartedAt });
    await verifyPackagedAuthority(automaticIdentity);
    receipt.automaticSuccessorStartup = "verified_profile_generation";
    receipt.automaticSuccessorApiHealth = "not_observed";
    await stopUpdaterProcess(automaticIdentity);
    dashboard.close(); settings.close(); dashboard = null; settings = null;
    await terminateLinuxSmokeChild(child); child = null;

    stage = "controlled_cold_restart";
    const coldPort = await freeTcpPort();
    const coldArguments = [`--remote-debugging-port=${coldPort}`, "--remote-debugging-address=127.0.0.1", "--disable-gpu"];
    const coldOptions = { argumentsForLaunch: coldArguments, config };
    await assertLinuxCdpPortUnused({ port: coldPort });
    child = spawn(image, coldArguments, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", chunk => { runtimeErrors = (runtimeErrors + chunk.toString("utf8")).slice(-16384); }); child.on("error", () => {});
    const coldAuthority = updaterCdpAuthority({ port: coldPort, expected: pair.images.next, options: coldOptions, onIdentity: value => { controlledIdentity = value; } });
    await coldAuthority(); await verifyPackagedAuthority(controlledIdentity);
    dashboard = await connectPage(coldPort, url => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url), { assertCdpAuthority: coldAuthority });
    await waitFor(() => dashboard.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"));
    await waitFor(() => processHealth(controlledIdentity.pid, { dashboard, assertCdpAuthority: coldAuthority }));
    await dashboard.evaluate("globalThis.tibotattleDesktop.openSettings()");
    const coldOrigin = await dashboard.evaluate("location.origin");
    settings = await connectPage(coldPort, url => isLinuxUpdaterSettingsURL(url, coldOrigin), { assertCdpAuthority: coldAuthority });
    await waitFor(() => settings.evaluate("typeof globalThis.tibotattleDesktop?.getSettings === 'function'"));
    const coldSettings = await settings.evaluate("globalThis.tibotattleDesktop.getSettings()");
    if (coldSettings.about.version !== pair.images.next.version || coldSettings.settings?.refreshIntervalSeconds !== 900
        || (await settings.evaluate("globalThis.tibotattleDesktop.getSharingPreference()")).enabled !== false) fail("PREFERENCES_NOT_PRESERVED");
    const afterState = linuxUpdaterUnavailableState(await readLocalCollectorCheckpoint({ stateFile: fixture.stateFile }));
    if (!isDeepStrictEqual(beforeState, afterState) || await digest(rawFixture) !== rawBefore) fail("LOCAL_STATE_NOT_PRESERVED");
    await coldAuthority();
    receipt.controlledColdRestartAuthorizedHealth = true;
    stage = "persisted_preferences";
    const persisted = JSON.parse(await readFile(join(profile, "desktop-settings/desktop-settings-v1.json"), "utf8"));
    if ((persisted.settings ?? persisted).refreshIntervalSeconds !== 900 || (await sharing.inspect()).enabled !== false) fail("PREFERENCES_NOT_PRESERVED");
    if (servedFeed < 1 || servedImage < 1) fail("UPDATE_TRANSFER_MISSING");
    await stopUpdaterProcess(controlledIdentity);
    receipt.status = "passed"; receipt.replacement = "exact_next_image"; receipt.restart = "automatic_next_ASAR_and_new_profile_generation";
    receipt.preferences = "refresh_interval_and_opt_out_preserved"; receipt.extraction = "AppImage_extract_and_run";
    receipt.localState = "unavailable_credentials_collection_start_and_source_preserved";
    receipt.desktopNotificationBanner = "requires_user_test"; receipt.feedRequests = servedFeed; receipt.imageRequests = servedImage; receipt.unexpectedRequests = unexpectedRequests;
    return receipt;
  } catch (error) {
    const code = error.code?.startsWith("LINUX_REAL_APPIMAGE_") ? error.code : "LINUX_REAL_APPIMAGE_FAILED";
    error.receipt = { ...receipt, runtimeErrorCategories: linuxUpdaterRuntimeErrorCategories(runtimeErrors), status: "failed", stage, code, feedRequests: servedFeed, imageRequests: servedImage, unexpectedRequests };
    throw error;
  } finally {
    dashboard?.close(); settings?.close();
    for (const identity of [controlledIdentity, automaticIdentity, currentIdentity].filter(Boolean)) {
      try { if (await capturedProcessAlive(identity)) await stopUpdaterProcess(identity); } catch { /* The isolated container remains the outer cleanup boundary. */ }
    }
    if (child) await terminateLinuxSmokeChild(child).catch(() => {});
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    // The whole container is disposable. Leave profile/CA intact until Docker
    // destroys it so a late child cannot escape cleanup by recreating paths.
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("ARGUMENT_INVALID");
  runRealLinuxAppImageUpdater().then((value) => console.log(JSON.stringify(value))).catch((error) => {
    if (error.receipt) console.log(JSON.stringify(error.receipt));
    console.error(error.code?.startsWith("LINUX_REAL_APPIMAGE_") ? error.code : "LINUX_REAL_APPIMAGE_FAILED"); process.exitCode = 1;
  });
}
