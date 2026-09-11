import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxUpdaterRehearsalVersions, linuxAppImageIdentity } from "../scripts/build-linux-updater-rehearsal.mjs";
import { validateLinuxRealUpdaterPair, realUpdaterFeed, isLinuxUpdaterSettingsURL, prepareLinuxUpdaterDownload, isOwnedLinuxUpdaterExecutable, linuxUpdaterFixedStatus, linuxUpdaterRuntimeErrorCategories } from "../scripts/smoke-electron-linux-real-appimage-updater.mjs";
import { readProductionDistribution } from "../apps/electron/main.js";
import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
const revision = "a".repeat(40);
function pair() {
  const image = { bytes: 4096, sha256: "b".repeat(64), asarSha256: "d".repeat(64), sha512: Buffer.alloc(64, 1).toString("base64") };
  return { schemaVersion: "tibotattle-linux-real-updater-pair-v1", sourceRevision: revision,
    scope: "private_test_version_override", feed: "https://updates.tibotattle.com/electron/stable/linux-x64", publication: "not_performed",
    images: { current: { ...image, version: "0.1.19", file: "current/TiboTattle.AppImage" }, next: { ...image, version: "0.1.20", file: "next/TiboTattle.AppImage" } } };
}
test("private Linux pair accepts only adjacent stable versions and fixed source/feed", () => {
  assert.deepEqual(linuxUpdaterRehearsalVersions("0.1.19"), { current: "0.1.19", next: "0.1.20" });
  for (const version of ["0.1.19-beta", "0.1.999999", "1", "01.1.0"]) assert.throws(() => linuxUpdaterRehearsalVersions(version));
  assert.equal(validateLinuxRealUpdaterPair(pair(), revision).images.next.version, "0.1.20");
  for (const alter of [
    p => { p.feed = "https://untrusted.example"; },
    p => { p.images.next.file = "next/../../elsewhere.AppImage"; },
    p => { p.images.next.version = "0.1.19"; },
    p => { p.sourceRevision = "c".repeat(40); },
    p => { p.publication = "published"; },
    p => { p.images.next.sha512 = "missing"; },
    p => { p.images.next.bytes = 1024 ** 3 + 1; },
    p => { p.images.next.asarSha256 = "missing"; },
  ]) { const value = pair(); alter(value); assert.throws(() => validateLinuxRealUpdaterPair(value, revision)); }
});
test("loopback feed binds the final next-image checksum and length", () => {
  const value = pair(); const feed = realUpdaterFeed(value);
  assert.match(feed, /^version: 0\.1\.20\n/u);
  assert.ok(feed.includes(`sha512: ${value.images.next.sha512}`));
  assert.ok(feed.includes("size: 4096"));
  assert.ok(!feed.includes("http:"));
});
test("AppImage qualification rejects a renamed shell script or ordinary ELF", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-real-appimage-header-"));
  try {
    const path = join(root, "fake.AppImage");
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await assert.rejects(linuxAppImageIdentity(path));
    const bytes = Buffer.alloc(4096); bytes.set([127, 69, 76, 70, 2]); bytes.writeUInt16LE(62, 18);
    await writeFile(path, bytes); await assert.rejects(linuxAppImageIdentity(path));
    bytes.set([65, 73, 2], 8); await writeFile(path, bytes);
    const identity = await linuxAppImageIdentity(path);
    assert.equal(identity.bytes, 4096);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("genuine updater lane admits only immutable pair inputs and container-local trust", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("      - name: Exercise a genuine AppImage update and automatic restart in isolation");
  assert.ok(start > 0);
  const step = workflow.slice(start, workflow.indexOf("      - name:", start + 1));
  for (const required of ["timeout 420s docker run", "--network none", "--add-host updates.tibotattle.com:127.0.0.1",
    "--tmpfs /opt/tibotattle-updater-exec:rw,exec,nosuid", "scripts/smoke-electron-linux-real-appimage-updater.mjs"]) assert.ok(step.includes(required));
  assert.doesNotMatch(step, /--(?:volume|mount|no-sandbox)|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors/u);
  const ignore = await readFile(new URL("../containers/electron-linux-packaged/Dockerfile.dockerignore", import.meta.url), "utf8");
  assert.deepEqual(ignore.split("\n").filter(line => line.startsWith("!.release-build/electron-linux-updater-rehearsal")), [
    "!.release-build/electron-linux-updater-rehearsal/",
    "!.release-build/electron-linux-updater-rehearsal/pair.json",
    "!.release-build/electron-linux-updater-rehearsal/current/",
    "!.release-build/electron-linux-updater-rehearsal/current/*.AppImage",
    "!.release-build/electron-linux-updater-rehearsal/next/",
    "!.release-build/electron-linux-updater-rehearsal/next/*.AppImage",
  ]);
});

test("both private versions retain the ordinary stable package authority", async () => {
  const metadata = createProductionDistributionMetadata({ target: "linux-x64", sourceRevision: revision, buildNumber: "123" });
  const app = { isPackaged: true, getName: () => "TiboTattle", getAppPath: () => "/isolated/resources/app.asar" };
  for (const version of Object.values(linuxUpdaterRehearsalVersions("0.1.19"))) {
    const actual = await readProductionDistribution({ app, platform: "linux", architecture: "x64",
      readManifest: async () => Buffer.from(JSON.stringify({ version, tibotattleDistribution: metadata })) });
    assert.deepEqual(actual, metadata);
    assert.equal(actual.channel, "stable");
    assert.equal(actual.updateFeed, pair().feed);
  }
});

test("real Settings selection accepts ordinary section hashes only on the owned dashboard", () => {
  assert.equal(isLinuxUpdaterSettingsURL("http://127.0.0.1:1234/electron-settings.html#general", "http://127.0.0.1:1234"), true);
  for (const url of ["http://127.0.0.1:1235/electron-settings.html#general", "https://example.com/electron-settings.html", "http://127.0.0.1:1234/electron-settings.html?other", "http://127.0.0.1:1234/"]) {
    assert.equal(isLinuxUpdaterSettingsURL(url, "http://127.0.0.1:1234"), false);
  }
});
test("Settings opening after automatic download still proceeds to install", async () => {
  const calls = [];
  const downloaded = { canCheck: false, canDownload: false, canInstall: true, status: "downloaded" };
  const result = await prepareLinuxUpdaterDownload({ readUpdate: async () => downloaded,
    click: async (action) => calls.push(action), automaticDownload: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { check: "automatic", download: "automatic" });
});
test("manual update path clicks each action once while automatic in-flight download needs none", async () => {
  const downloaded = { canInstall: true, status: "downloaded" };
  let update = { canCheck: true, status: "ready" }; const calls = [];
  await prepareLinuxUpdaterDownload({ readUpdate: async () => update, automaticDownload: false,
    click: async (action) => { calls.push(action); update = action === "check" ? { canDownload: true, status: "available" } : downloaded; } });
  assert.deepEqual(calls, ["check", "download"]);
  let reads = 0;
  const result = await prepareLinuxUpdaterDownload({ readUpdate: async () => ++reads < 3 ? { status: "downloading" } : downloaded,
    automaticDownload: true, click: async () => assert.fail("automatic download already in progress") });
  assert.deepEqual(result, { check: "automatic", download: "automatic" });
});

test("AppImage process identity is confined to the private extraction mount", () => {
  assert.equal(isOwnedLinuxUpdaterExecutable("/opt/tibotattle-updater-exec/tmp/appimage_extracted_abc/tibotattle"), true);
  for (const path of ["/usr/bin/tibotattle", "/tmp/tibotattle", "/opt/tibotattle-updater-exec/tmp/../tibotattle", "/opt/tibotattle-updater-exec/tmp/appimage/chrome_crashpad_handler", "/opt/tibotattle-updater-exec/tmp/appimage/tibotattle --type=renderer"]) {
    assert.equal(isOwnedLinuxUpdaterExecutable(path), false);
  }
});

test("install diagnostics retain only fixed updater and operating-system classifications", () => {
  assert.deepEqual(linuxUpdaterFixedStatus({ status: "error", error: "shutdown_failed", detail: "private path" }), { status: "error", error: "shutdown_failed" });
  assert.deepEqual(linuxUpdaterFixedStatus({ status: "secret", error: "private" }), { status: "unavailable", error: "unavailable" });
  assert.deepEqual(linuxUpdaterRuntimeErrorCategories("Error: EACCES /private/file; EXDEV other"), ["EACCES", "EXDEV"]);
  assert.deepEqual(linuxUpdaterRuntimeErrorCategories("ENOENTish"), []);
});
