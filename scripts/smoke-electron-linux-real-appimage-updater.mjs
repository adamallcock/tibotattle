#!/usr/bin/env node
/** Real normal-app update; fixed production URL resolves only inside network-none. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:https";
import { lookup } from "node:dns/promises";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContainerContract, connectCdp, freeTcpPort, terminateLinuxSmokeChild } from "./smoke-electron-linux.mjs";
import { createLinuxNormalPackagedSmokeFixture, normalPackagedSmokeEnvironment } from "./smoke-electron-linux-packaged.mjs";
import { linuxAppImageIdentity } from "./build-linux-updater-rehearsal.mjs";
import { createDesktopSharingBackend, createDesktopSharingCoordinator } from "../apps/electron/desktop-sharing.js";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXEC = "/opt/tibotattle-updater-exec";
const HOST = "updates.tibotattle.com";
const FEED = `https://${HOST}/electron/stable/linux-x64`;
const fail = (code) => { throw Object.assign(new Error(code), { code: `LINUX_REAL_APPIMAGE_${code}` }); };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(read, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (value) return value; await delay(200); }
  fail("TIMEOUT");
}
export function validateLinuxRealUpdaterPair(pair, revision) {
  if (pair?.schemaVersion !== "tibotattle-linux-real-updater-pair-v1" || pair.sourceRevision !== revision
      || pair.scope !== "private_test_version_override" || pair.feed !== FEED || pair.publication !== "not_performed") fail("PAIR_INVALID");
  for (const role of ["current", "next"]) {
    const image = pair.images?.[role];
    if (!image || typeof image.file !== "string" || !new RegExp(`^${role}/[A-Za-z0-9_.-]+\\.AppImage$`, "u").test(image.file)
        || !/^[0-9a-f]{64}$/u.test(image.sha256 ?? "") || !/^[0-9a-f]{64}$/u.test(image.asarSha256 ?? "")
        || !/^[A-Za-z0-9+/]{86}==$/u.test(image.sha512 ?? "") || !Number.isSafeInteger(image.bytes) || image.bytes < 4096 || image.bytes > 1024 ** 3
        || !/^\d+\.\d+\.\d+$/u.test(image.version ?? "")) fail("PAIR_INVALID");
  }
  const a = pair.images.current.version.split(".").map(Number); const b = pair.images.next.version.split(".").map(Number);
  if ([...a, ...b].some((value) => !Number.isSafeInteger(value)) || a[0] !== b[0] || a[1] !== b[1] || b[2] !== a[2] + 1) fail("PAIR_INVALID");
  return pair;
}
export function realUpdaterFeed(pair) {
  const next = pair.images.next;
  return `version: ${next.version}\nfiles:\n  - url: next.AppImage\n    sha512: ${next.sha512}\n    size: ${next.bytes}\npath: next.AppImage\nsha512: ${next.sha512}\nreleaseDate: '2026-09-09T00:00:00.000Z'\n`;
}
function command(name, args, options = {}) {
  const result = spawnSync(name, args, { stdio: "ignore", timeout: 15000, shell: false, ...options });
  if (result.error || result.status !== 0 || result.signal) fail("LOCAL_TRUST_SETUP_FAILED");
}
async function targets(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }); return await r.json(); }
  catch { return []; }
}
async function connectPage(port, predicate) {
  return waitFor(async () => {
    const rows = await targets(port);
    const page = rows.find((row) => row.type === "page" && predicate(row.url)
      && typeof row.webSocketDebuggerUrl === "string" && row.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
    return page ? connectCdp(page) : null;
  });
}
async function appPids(image) {
  const selected = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const env = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
      const args = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      if (env.includes(`APPIMAGE=${image}`) && !args.some((arg) => arg.startsWith("--type="))) selected.push(Number(entry));
    } catch { /* Exited or unrelated process. */ }
  }
  return selected;
}
async function processHealth(pid) {
  // Read only socket identities for this process and its children; never
  // probe unrelated ports or export command lines/environment material.
  const pids = new Set([pid]);
  for (let pass = 0; pass < 3; pass++) {
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try { const status = await readFile(`/proc/${entry}/status`, "utf8");
        if (pids.has(Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]))) pids.add(Number(entry));
      } catch {}
    }
  }
  const sockets = new Set();
  for (const child of pids) {
    try { for (const fd of await readdir(`/proc/${child}/fd`)) {
      try { const target = await readlink(`/proc/${child}/fd/${fd}`); const match = /^socket:\[(\d+)\]$/u.exec(target); if (match) sockets.add(match[1]); } catch {}
    } } catch {}
  }
  const lines = (await readFile("/proc/net/tcp", "utf8")).trim().split("\n").slice(1);
  for (const line of lines) {
    const cols = line.trim().split(/\s+/u); const [address, port] = cols[1].split(":");
    if (cols[3] !== "0A" || address !== "0100007F" || !sockets.has(cols[9])) continue;
    try { const response = await fetch(`http://127.0.0.1:${Number.parseInt(port, 16)}/api/local/health`, { signal: AbortSignal.timeout(1000) });
      if ((await response.json())?.status === "ready") return true;
    } catch {}
  }
  return false;
}
async function digest(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
export async function runRealLinuxAppImageUpdater() {
  const contract = assertContainerContract();
  if (process.arch !== "x64" || process.getuid() !== 1000 || (await lookup(HOST)).address !== "127.0.0.1") fail("ISOLATION_REQUIRED");
  const execStat = await lstat(EXEC);
  if (!execStat.isDirectory() || execStat.isSymbolicLink() || execStat.uid !== 1000 || (execStat.mode & 0o777) !== 0o700) fail("ISOLATION_REQUIRED");
  const pairRoot = join(ROOT, ".release-build/electron-linux-updater-rehearsal");
  const pair = validateLinuxRealUpdaterPair(JSON.parse(await readFile(join(pairRoot, "pair.json"), "utf8")), contract.sourceRevision);
  for (const role of ["current", "next"]) {
    const identity = await linuxAppImageIdentity(join(pairRoot, pair.images[role].file));
    if (identity.sha256 !== pair.images[role].sha256 || identity.sha512 !== pair.images[role].sha512 || identity.bytes !== pair.images[role].bytes) fail("INPUT_CHANGED");
  }
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
    const path = new URL(request.url, FEED).pathname;
    if (request.headers.host !== HOST || request.method !== "GET") { unexpectedRequests++; response.writeHead(404).end(); return; }
    if (path === "/electron/stable/linux-x64/latest-linux.yml") { servedFeed++; response.writeHead(200, { "content-type": "application/yaml" }).end(realUpdaterFeed(pair)); return; }
    if (path === "/electron/stable/linux-x64/next.AppImage") { servedImage++; response.writeHead(200, { "content-length": pair.images.next.bytes, "content-type": "application/octet-stream" }); createReadStream(join(pairRoot, pair.images.next.file)).pipe(response); return; }
    unexpectedRequests++; response.writeHead(404).end();
  });
  let child; let dashboard; let settings; let updatedPid;
  const receipt = { schemaVersion: "tibotattle-linux-real-appimage-updater-v1", sourceRevision: contract.sourceRevision,
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
    child = spawn(image, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--disable-gpu"], { env: environment, stdio: "ignore" });
    child.on("error", () => {});
    dashboard = await connectPage(port, (url) => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url));
    await waitFor(() => dashboard.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"));
    await dashboard.evaluate("globalThis.tibotattleDesktop.openSettings()");
    settings = await connectPage(port, (url) => url.endsWith("/electron-settings.html"));
    await waitFor(() => settings.evaluate("document.querySelector('#settings-check-for-updates')?.disabled === false"));
    stage = "current_preferences";
    const before = await settings.evaluate("globalThis.tibotattleDesktop.getSettings()");
    if (before.about.version !== pair.images.current.version) fail("CURRENT_VERSION_MISMATCH");
    await settings.evaluate("globalThis.tibotattleDesktop.setRefreshInterval(900)");
    if ((await settings.evaluate("globalThis.tibotattleDesktop.getSharingPreference()")).enabled !== false) fail("OPT_OUT_MISSING");
    stage = "update_check";
    await settings.evaluate("document.querySelector('#settings-tab-about').click(); document.querySelector('#settings-check-for-updates').click()");
    await waitFor(async () => (await settings.evaluate("globalThis.tibotattleDesktop.getSettings()")).about.update.canDownload === true);
    stage = "update_download";
    await settings.evaluate("document.querySelector('#settings-download-update').click()");
    await waitFor(async () => (await settings.evaluate("globalThis.tibotattleDesktop.getSettings()")).about.update.canInstall === true, 120000);
    const oldPids = new Set(await appPids(image));
    if (!oldPids.size) fail("CURRENT_PROCESS_MISSING");
    stage = "update_install";
    await settings.evaluate("setTimeout(() => document.querySelector('#settings-install-update').click(), 25)");
    let checkedImageStamp;
    await waitFor(async () => {
      const stat = await lstat(image).catch(() => null);
      if (!stat || stat.size !== pair.images.next.bytes) return false;
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (stamp === checkedImageStamp) return false;
      checkedImageStamp = stamp;
      return (await digest(image).catch(() => null)) === pair.images.next.sha256;
    }, 60000);
    stage = "automatic_restart";
    updatedPid = await waitFor(async () => {
      const rows = await appPids(image);
      for (const pid of rows) {
        if (oldPids.has(pid)) continue;
        try { const executable = await readlink(`/proc/${pid}/exe`);
          if (await digest(join(dirname(executable), "resources/app.asar")) !== pair.images.next.asarSha256) continue;
          if (await processHealth(pid)) return pid;
        } catch {}
      }
      return null;
    }, 90000);
    await waitFor(async () => {
      for (const pid of oldPids) {
        try { await lstat(`/proc/${pid}`); return false; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return true;
    }, 10000);
    stage = "persisted_preferences";
    const persisted = JSON.parse(await readFile(join(profile, "desktop-settings/desktop-settings-v1.json"), "utf8"));
    if ((persisted.settings ?? persisted).refreshIntervalSeconds !== 900 || (await sharing.inspect()).enabled !== false) fail("PREFERENCES_NOT_PRESERVED");
    if (servedFeed < 1 || servedImage < 1) fail("UPDATE_TRANSFER_MISSING");
    receipt.status = "passed"; receipt.replacement = "exact_next_image"; receipt.restart = "automatic_next_ASAR_and_companion_ready";
    receipt.preferences = "refresh_interval_and_opt_out_preserved"; receipt.extraction = "AppImage_extract_and_run";
    receipt.desktopNotificationBanner = "requires_user_test"; receipt.feedRequests = servedFeed; receipt.imageRequests = servedImage; receipt.unexpectedRequests = unexpectedRequests;
    return receipt;
  } catch (error) {
    const code = error.code?.startsWith("LINUX_REAL_APPIMAGE_") ? error.code : "LINUX_REAL_APPIMAGE_FAILED";
    error.receipt = { ...receipt, status: "failed", stage, code, feedRequests: servedFeed, imageRequests: servedImage, unexpectedRequests };
    throw error;
  } finally {
    dashboard?.close(); settings?.close();
    for (const pid of await appPids(image).catch(() => [])) { try { process.kill(pid, "SIGUSR2"); } catch {} }
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
