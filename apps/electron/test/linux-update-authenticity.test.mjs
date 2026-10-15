import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link as hardlink, mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createLinuxUpdateVerifier, LINUX_UPDATE_MANIFEST_SCHEMA } from "../linux-update-authenticity.js";
import { createProductionDesktopUpdater, createProductionDistributionMetadata } from "../desktop-updater.js";

const clock = 1_900_000_000_000;
const posixOnly = { skip: process.platform === "win32" ? "Linux updater file ownership and nonblocking descriptors require POSIX" : false };
const payload = Buffer.from("synthetic AppImage payload: never executable");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const key = { id: "test-publisher", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  minimumSequence: 1, maximumSequence: 100 };
function backend() {
  let saved = null;
  return { async load() { return saved; }, async save(value) { saved = structuredClone(value); } };
}
function envelope(overrides = {}, signingKey = privateKey) {
  const manifest = { schemaVersion: LINUX_UPDATE_MANIFEST_SCHEMA, appId: "com.usagemonitor.local",
    channel: "stable", target: "linux-x64", version: "0.1.20", sequence: 10,
    size: payload.length, sha256: createHash("sha256").update(payload).digest("hex"),
    keyId: key.id, expiresAt: clock + 60_000, ...overrides };
  const sha512 = createHash("sha512").update(payload).digest("base64"), path = `TiboTattle-${manifest.version}-linux-x86_64.AppImage`;
  return { version: manifest.version, files: [{ url: path, size: manifest.size,
    sha512 }], path, sha512, tibotattleLinuxUpdate: { manifest,
    signature: sign(null, Buffer.from(`${JSON.stringify(manifest)}\n`), signingKey).toString("base64") } };
}
function verifier(options = {}) {
  return createLinuxUpdateVerifier({ keys: [key], currentVersion: "0.1.18", backend: backend(), now: () => clock, ...options });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linux-update-auth-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "TiboTattle-0.1.20-linux-x86_64.AppImage");
  await writeFile(path, payload, { mode: 0o700 });
  return { root, path };
}
class Adapter extends EventEmitter {
  constructor(info, path) { super(); this.info = info; this.installerPath = path; this.downloads = 0; this.installs = 0; this.checks = 0; }
  async checkForUpdates() {
    this.checks += 1; this.emit("checking-for-update"); this.emit("update-available", this.info);
    assert.equal(this.autoDownload, false, "library auto path cannot race signature validation");
    return { updateInfo: this.info, isUpdateAvailable: true };
  }
  async downloadUpdate() { this.downloads += 1; this.emit("update-downloaded", this.info); return [this.installerPath]; }
  quitAndInstall() { this.installs += 1; }
}
function wrapper(adapter, options = {}) {
  return createProductionDesktopUpdater({ app: { isPackaged: true, getVersion: () => "0.1.18" },
    platform: "linux", architecture: "x64", autoUpdater: adapter,
    distributionMetadata: createProductionDistributionMetadata({ target: "linux-x64", sourceRevision: "a".repeat(40), buildNumber: "10" }),
    preferences: { get: async () => ({ automaticDownload: false, available: true }), setAutomaticDownload: async value => ({ automaticDownload: value, available: true }) },
    setIntervalImpl: () => null, clearIntervalImpl: () => {}, ...options });
}

test("unprovisioned production Linux updater refuses every action and never contacts its feed", async () => {
  const adapter = new Adapter(envelope(), "/unused.AppImage"), updater = wrapper(adapter);
  assert.equal((await updater.start()).state, "unavailable");
  for (const action of [() => updater.checkForUpdates(), () => updater.downloadUpdate(),
    () => updater.installAndRestart(), () => updater.setAutomaticDownload(true)]) await assert.rejects(action);
  assert.deepEqual([adapter.checks, adapter.downloads, adapter.installs], [0, 0, 0]);
  assert.equal(adapter.autoInstallOnAppQuit, false);
  assert.equal(adapter.autoDownload, false);
  updater.dispose();
});

test("closed signatures reject unsigned feed checksum authority, wrong identity, key, expiry and extra fields", async () => {
  const wrongKey = generateKeyPairSync("ed25519").privateKey;
  const cases = [ { version: "0.1.20", sha512: "attacker chosen checksum" }, envelope({}, wrongKey),
    ...[{ appId: "other" }, { channel: "preview" }, { target: "linux-arm64" }, { version: "0.1.17" },
      { size: 0 }, { sha256: "a".repeat(63) }, { sequence: 101 }, { keyId: "other" },
      { expiresAt: clock }, { extra: true }].map(value => envelope(value)) ];
  for (const info of cases) await assert.rejects(verifier().authorize(info), { code: "linux_update_authenticity_failed" });
  const mismatched = envelope(); mismatched.version = "0.1.21";
  await assert.rejects(verifier().authorize(mismatched));
  const altered = envelope(); altered.tibotattleLinuxUpdate.manifest.sha256 = "f".repeat(64);
  await assert.rejects(verifier().authorize(altered));
  for (const value of ["OtherProduct.AppImage", "../../payload.AppImage", "https://other.invalid/payload.AppImage", "file:///payload.AppImage"]) {
    const unsafe = envelope(); unsafe.files[0].url = value; await assert.rejects(verifier().authorize(unsafe));
  }
  const oversized = envelope(); oversized.files[0].size += 1; await assert.rejects(verifier().authorize(oversized));
  await assert.rejects(verifier().authorize({ ...envelope(), minimumSystemVersion: "999999.0.0" }));
  await assert.rejects(verifier().authorize({ ...envelope(), stagingPercentage: 0 }));
});

test("high water survives restart, rejects rollback/equivocation, accepts exact retry and bounded rotation", async () => {
  const persistence = backend();
  await verifier({ backend: persistence }).authorize(envelope());
  await verifier({ backend: persistence }).authorize(envelope());
  for (const change of [{ sequence: 9 }, { sequence: 11, version: "0.1.19" }, { sha256: "f".repeat(64) }]) {
    await assert.rejects(verifier({ backend: persistence }).authorize(envelope(change)));
  }
  await verifier({ backend: persistence, keys: [{ ...key, minimumSequence: 11, maximumSequence: 20 }] }).authorize(envelope({ sequence: 11, version: "0.1.21" }));
  await assert.rejects(verifier({ backend: { load: async () => ({ corrupt: true }), save: async () => {} } }).authorize(envelope()));
  await assert.rejects(verifier({ backend: { load: async () => null, save: async () => { throw Error("disk"); } } }).authorize(envelope()));
  const renewal = backend(); await verifier({ backend: renewal }).authorize(envelope());
  await verifier({ backend: renewal }).authorize(envelope({ sequence: 11, expiresAt: clock + 120_000 }));
  await assert.rejects(verifier({ backend: renewal }).authorize(envelope({ sequence: 12, sha256: "f".repeat(64) })));
});

test("downloaded and install bytes must match independent digest, size, file identity and freshness", posixOnly, async t => {
  const { path, root } = await fixture(t), v = verifier();
  await v.authorize(envelope());
  v.verifyDownloaded([path], path); v.verifyBeforeInstall(path);
  await writeFile(path, Buffer.alloc(payload.length, 7));
  assert.throws(() => v.verifyBeforeInstall(path));
  assert.throws(() => v.verifyDownloaded([path], path));
  await writeFile(path, payload);
  assert.throws(() => v.verifyDownloaded([path], `${path}.other`));
  const alternate = join(root, "alternate"); await mkdir(alternate, { mode: 0o700 });
  const link = join(alternate, "TiboTattle-0.1.20-linux-x86_64.AppImage"); await symlink(path, link);
  assert.throws(() => v.verifyDownloaded([link], link));
  await rm(link); await hardlink(path, link);
  assert.throws(() => v.verifyDownloaded([path], path)); await rm(link);
  await chmod(path, 0o722); assert.throws(() => v.verifyDownloaded([path], path)); await chmod(path, 0o700);
  await v.authorize(envelope({ size: payload.length + 1, sequence: 11, version: "0.1.21" }));
  const nextPath = join(root, "TiboTattle-0.1.21-linux-x86_64.AppImage"); await writeFile(nextPath, payload, { mode: 0o700 });
  assert.throws(() => v.verifyDownloaded([nextPath], nextPath));
});

test("an inactive or unsigned no-update response cannot claim a current signed build", async () => {
  for (const result of [null, { isUpdateAvailable: false, updateInfo: { version: "0.1.18" } }]) {
    const adapter = new Adapter(envelope(), "/unused.AppImage");
    adapter.checkForUpdates = async () => result;
    const updater = wrapper(adapter, { linuxUpdateVerifier: verifier() });
    assert.equal((await updater.checkForUpdates()).error, "check_failed"); updater.dispose();
  }
  const adapter = new Adapter(envelope(), "/unused.AppImage");
  adapter.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: envelope({ version: "0.1.18" }) });
  const updater = wrapper(adapter, { linuxUpdateVerifier: verifier() });
  assert.equal((await updater.checkForUpdates()).state, "current"); updater.dispose();
  const newer = new Adapter(envelope(), "/unused.AppImage");
  newer.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: envelope() });
  const inconsistent = wrapper(newer, { linuxUpdateVerifier: verifier() });
  assert.equal((await inconsistent.checkForUpdates()).error, "check_failed"); inconsistent.dispose();
});

test("non-regular installer intake rejects a FIFO without waiting for a writer", posixOnly, async t => {
  const { root, path: fifo } = await fixture(t); await rm(fifo);
  const created = spawnSync("mkfifo", [fifo], { timeout: 1000 });
  assert.equal(created.status, 0);
  // A synchronous open regression must time out this child, not hang the
  // enclosing runner before its asynchronous test timeout can fire.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createLinuxUpdateVerifier } from ${JSON.stringify(new URL("../linux-update-authenticity.js", import.meta.url).href)};
    const v = createLinuxUpdateVerifier({keys: ${JSON.stringify([key])}, currentVersion: "0.1.18",
      now: () => ${clock}, backend: { load: async () => null, save: async () => {} }});
    await v.authorize(${JSON.stringify(envelope())});
    try { v.verifyDownloaded([${JSON.stringify(fifo)}], ${JSON.stringify(fifo)}); process.exitCode = 1; }
    catch (error) { if (error.code !== "linux_update_authenticity_failed") process.exitCode = 1; }
  `], { timeout: 3000, encoding: "utf8" });
  assert.equal(child.error, undefined); assert.equal(child.status, 0); assert.equal(child.stdout, "");
});

test("automatic download waits for durable authorization and ignores early downloaded events", posixOnly, async t => {
  const { path } = await fixture(t), adapter = new Adapter(envelope(), path);
  let permitSave; const pending = new Promise(resolve => { permitSave = resolve; });
  const updater = wrapper(adapter, { linuxUpdateVerifier: verifier({ backend: { load: async () => null, save: () => pending } }),
    preferences: { get: async () => ({ automaticDownload: true, available: true }), setAutomaticDownload: async () => {} } });
  const check = updater.checkForUpdates(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.downloads, 0); adapter.emit("update-downloaded", envelope());
  assert.equal(updater.getStatus().canInstall, false);
  permitSave(); assert.equal((await check).state, "downloaded");
  assert.equal(adapter.downloads, 1); assert.equal(adapter.autoDownload, false);
  await updater.installAndRestart(); assert.equal(adapter.installs, 1); updater.dispose();
});

test("invalid signature cannot download and tampering during companion shutdown cannot install", posixOnly, async t => {
  const { path } = await fixture(t);
  const bad = new Adapter({ version: "0.1.20" }, path), rejected = wrapper(bad, { linuxUpdateVerifier: verifier() });
  assert.equal((await rejected.checkForUpdates()).error, "check_failed"); assert.equal(bad.downloads, 0); rejected.dispose();
  let restored = 0;
  const adapter = new Adapter(envelope(), path), updater = wrapper(adapter, { linuxUpdateVerifier: verifier(),
    prepareForUpdate: () => writeFile(path, Buffer.alloc(payload.length, 2)), cancelPreparedUpdate: async () => { restored += 1; } });
  await updater.checkForUpdates(); assert.equal((await updater.downloadUpdate()).state, "downloaded");
  assert.equal((await updater.installAndRestart()).error, "install_failed");
  assert.equal(adapter.installs, 0); assert.equal(restored, 1); updater.dispose();
});

test("real pinned AppImageUpdater full, differential and restored-cache downloads pass the same byte verifier", posixOnly, async t => {
  const { root, path } = await fixture(t);
  const { AppImageUpdater } = createRequire(import.meta.url)("electron-updater");
  const oldAppImage = process.env.APPIMAGE; process.env.APPIMAGE = path;
  t.after(() => { if (oldAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = oldAppImage; });
  const info = { ...envelope(), files: [{ url: "TiboTattle-0.1.20-linux-x86_64.AppImage", size: payload.length,
    sha512: createHash("sha512").update(payload).digest("base64") }] };
  const adapter = new AppImageUpdater(null, { version: "0.1.18", name: "SyntheticUpdater",
    isPackaged: true, userDataPath: root, baseCachePath: root, whenReady: async () => {}, onQuit() { assert.fail("quit hook must stay disabled"); } });
  adapter.logger = null; adapter.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: "cache" }) };
  adapter.clientPromise = Promise.resolve({ setRequestHeaders() {}, getLatestVersion: async () => info,
    resolveFiles: () => [{ url: new URL(`https://updates.invalid/${info.files[0].url}`), info: info.files[0] }], getRequestHeaders: () => null });
  let transfers = 0;
  adapter.httpExecutor = { download: async (_url, destination) => { transfers += 1; await writeFile(destination, payload); } };
  adapter.disableDifferentialDownload = true;
  info.minimumSystemVersion = "999999.0.0";
  const blocked = wrapper(adapter, { linuxUpdateVerifier: verifier() });
  assert.equal((await blocked.checkForUpdates()).error, "check_failed",
    "the real adapter's unsigned minimum-system-version suppression cannot claim current");
  assert.equal(transfers, 0); blocked.dispose(); delete info.minimumSystemVersion;
  const updater = wrapper(adapter, { linuxUpdateVerifier: verifier() });
  await updater.checkForUpdates(); assert.equal((await updater.downloadUpdate()).state, "downloaded");
  assert.equal(transfers, 1);
  await updater.checkForUpdates().catch(() => {}); // Downloaded UI intentionally forbids another check.
  updater.dispose();
  const cached = wrapper(adapter, { linuxUpdateVerifier: verifier() });
  await cached.checkForUpdates(); assert.equal((await cached.downloadUpdate()).state, "downloaded");
  assert.equal(transfers, 1, "real download helper reused cached bytes"); cached.dispose();
  await rm(join(root, "cache"), { recursive: true, force: true });
  adapter.downloadedUpdateHelper = null; adapter.disableDifferentialDownload = false;
  let differential = 0;
  adapter.downloadDifferential = async (_file, _old, destination) => { differential += 1; await writeFile(destination, payload); return false; };
  const delta = wrapper(adapter, { linuxUpdateVerifier: verifier() });
  await delta.checkForUpdates(); assert.equal((await delta.downloadUpdate()).state, "downloaded");
  assert.equal(differential, 1); assert.equal(transfers, 1); delta.dispose();
});
