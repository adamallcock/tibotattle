import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxUpdaterRehearsalVersions, linuxAppImageIdentity } from "../scripts/build-linux-updater-rehearsal.mjs";
import { validateLinuxRealUpdaterPair, isLinuxUpdaterSettingsURL, prepareLinuxUpdaterDownload, isOwnedLinuxUpdaterExecutable, linuxUpdaterFixedStatus, linuxUpdaterRuntimeErrorCategories, readLinuxUpdaterProcessIdentity, currentUpdaterProcess, connectPage, linuxUpdaterUnavailableState, linuxPrivateFeedRequestPath } from "../scripts/smoke-electron-linux-real-appimage-updater.mjs";
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

test("unsigned development workflow retains immutable pair inputs without claiming native signed qualification", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("      - name: Record the unsigned private-pair qualification boundary");
  assert.ok(start > 0);
  assert.doesNotMatch(workflow, /node scripts\/smoke-electron-linux-real-appimage-updater\.mjs|real-appimage-updater-smoke\.json/u);
  const notice = workflow.slice(start, workflow.indexOf("      - name:", start + 1));
  assert.match(notice, /Signed native updater qualification was not performed/u);
  assert.doesNotMatch(notice, /status.*passed|sign-electron|curl|wget/u);
  const ignore = await readFile(new URL("../containers/electron-linux-packaged/Dockerfile.dockerignore", import.meta.url), "utf8");
  assert.deepEqual(ignore.split("\n").filter(line => line.startsWith("!.release-build/electron-linux-updater-rehearsal")), [
    "!.release-build/electron-linux-updater-rehearsal/",
    "!.release-build/electron-linux-updater-rehearsal/pair.json",
    "!.release-build/electron-linux-updater-rehearsal/current/",
    "!.release-build/electron-linux-updater-rehearsal/current/*.AppImage",
    "!.release-build/electron-linux-updater-rehearsal/next/",
    "!.release-build/electron-linux-updater-rehearsal/next/*.AppImage",
    "!.release-build/electron-linux-updater-rehearsal/qualification/",
    "!.release-build/electron-linux-updater-rehearsal/qualification/qualification.json",
    "!.release-build/electron-linux-updater-rehearsal/qualification/latest-linux.yml",
  ]);
  const retain = workflow.indexOf("      - name: Retain the immutable private Linux updater pair before authorization");
  assert.ok(retain > 0 && retain < start);
  const retainStep = workflow.slice(retain, workflow.indexOf("      - name:", retain + 1));
  assert.match(retainStep, /pair\.json/u); assert.match(retainStep, /current\/\*\.AppImage/u); assert.match(retainStep, /next\/\*\.AppImage/u);
  assert.doesNotMatch(retainStep, /sign-electron|signing|credential|\.key/u);

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
test("private signed feed routing admits only the canonical artifact and bounded updater cache-busting query", () => {
  const artifact = "/electron/stable/linux-x64/TiboTattle-0.1.20-linux-x86_64.AppImage", feed = "/electron/stable/linux-x64/latest-linux.yml";
  assert.equal(linuxPrivateFeedRequestPath(feed, artifact), "feed");
  assert.equal(linuxPrivateFeedRequestPath(`${feed}?noCache=12abc`, artifact), "feed");
  assert.equal(linuxPrivateFeedRequestPath(artifact, artifact), "image");
  for (const path of [`${feed}?unknown=1`, `${artifact}?noCache=1`, `/electron/stable/linux-x64/next.AppImage`, `https://foreign.invalid${feed}`,
    `https://name@updates.tibotattle.com${feed}`, `${feed}#fragment`, "https://[invalid", "x".repeat(1025)]) assert.equal(linuxPrivateFeedRequestPath(path, artifact), null);
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

function processFixture() {
  const executable = "/opt/tibotattle-updater-exec/tmp/synthetic/tibotattle", config = "/synthetic/config";
  const expected = { sha256: "a".repeat(64), asarSha256: "b".repeat(64) };
  const fields = Array(20).fill("0"); fields[19] = "456";
  const files = { stat: `123 (tibotattle) ${fields.join(" ")}`, cmdline: `${executable}\0`, environ: `XDG_CONFIG_HOME=${config}\0`,
    status: `Uid:\t${Array(4).fill(process.getuid()).join("\t")}\n` };
  const options = { argumentsForLaunch: [], config, read: async path => files[path.split("/").at(-1)], link: async () => executable,
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o755, nlink: 1 }),
    hash: async path => path.endsWith("app.asar") ? expected.asarSha256 : path.endsWith(".AppImage") ? expected.sha256 : "c".repeat(64) };
  return { executable, expected, files, options };
}
test("real automatic successor admits exact empty argv, profile, image/ASAR and stable kernel process identity", async () => {
  const f = processFixture();
  const actual = await readLinuxUpdaterProcessIdentity(123, f.expected, f.options);
  assert.deepEqual(actual, { pid: 123, startTime: "456", executable: f.executable, executableSha256: "c".repeat(64) });
  for (const change of [
    value => { value.files.environ += "ELECTRON_RUN_AS_NODE=1\0"; },
    value => { value.options.hash = async () => "d".repeat(64); },
  ]) { const altered = processFixture(); change(altered); assert.equal(await readLinuxUpdaterProcessIdentity(123, altered.expected, altered.options), null); }
  const wrongArguments = processFixture(); wrongArguments.files.cmdline = `${wrongArguments.executable}\0--remote-debugging-port=43210\0`;
  await assert.rejects(readLinuxUpdaterProcessIdentity(123, wrongArguments.expected, wrongArguments.options), { code: "LINUX_REAL_APPIMAGE_PROCESS_LAUNCH_ARGUMENTS_INVALID" });
  const wrongProfile = processFixture(); wrongProfile.files.environ = "XDG_CONFIG_HOME=/other\0";
  await assert.rejects(readLinuxUpdaterProcessIdentity(123, wrongProfile.expected, wrongProfile.options), { code: "LINUX_REAL_APPIMAGE_PROCESS_IDENTITY_INVALID" });
  let reads = 0;
  await assert.rejects(readLinuxUpdaterProcessIdentity(123, f.expected, { ...f.options,
    read: async path => path.endsWith("/stat") && ++reads === 2 ? f.files.stat.replace(/456$/u, "999") : f.options.read(path) }), { code: "LINUX_REAL_APPIMAGE_PROCESS_IDENTITY_CHANGED" });
  await assert.rejects(readLinuxUpdaterProcessIdentity(123, f.expected, { ...f.options, link: async () => { throw Object.assign(new Error("unavailable"), { code: "EACCES" }); } }), { code: "EACCES" });
});
test("the unavailable credential lane preserves explicit null marker and stable collection start without claiming account scope", () => {
  const checkpoint = { schemaVersion: "0.3", collectionStartedAt: "2026-10-13T00:00:00.000Z", files: {}, recentEventKeys: [], lastQuotaObservedAt: null,
    accountScopeMarker: null, resetEventContinuity: null, diagnostics: { accountCredentialUnavailable: 1 } };
  const before = linuxUpdaterUnavailableState(checkpoint);
  const after = linuxUpdaterUnavailableState({ ...checkpoint, diagnostics: { accountCredentialUnavailable: 3 } });
  assert.deepEqual(before, { collectionStartedAt: checkpoint.collectionStartedAt, accountScopeMarker: null });
  assert.deepEqual(after, before);
  for (const invalid of [null, {}, { ...checkpoint, collectionStartedAt: "bad" }, { ...checkpoint, accountScopeMarker: { accountScope: { status: "available" } } }]) {
    assert.throws(() => linuxUpdaterUnavailableState(invalid), { code: "LINUX_REAL_APPIMAGE_LOCAL_STATE_UNAVAILABLE" });
  }
});
test("automatic process selection refuses multiple exact candidates and never substitutes a predecessor", async () => {
  const f = processFixture(), identity = await readLinuxUpdaterProcessIdentity(123, f.expected, f.options);
  assert.equal(await currentUpdaterProcess(f.expected, f.options, { list: async () => ["123", "other"], readIdentity: async () => identity }), identity);
  assert.equal(await currentUpdaterProcess(f.expected, f.options, { list: async () => ["123"], readIdentity: async () => null }), null);
  await assert.rejects(currentUpdaterProcess(f.expected, f.options, { list: async () => ["123", "124"], readIdentity: async pid => ({ ...identity, pid }) }), { code: "LINUX_REAL_APPIMAGE_MULTIPLE_APPS" });
  await assert.rejects(currentUpdaterProcess(f.expected, { ...f.options,
    read: async path => { if (path.startsWith("/proc/124/")) throw Object.assign(new Error("private detail"), { code: "EACCES" }); return f.options.read(path); },
  }, { list: async () => ["123", "124"] }), { code: "LINUX_REAL_APPIMAGE_PROCESS_IDENTITY_INVALID" });
});
test("real successor enumeration excludes the shared closed Chromium child grammar in argv and process titles", async () => {
  for (const separator of ["\0", " "]) {
    for (const role of ["renderer", "zygote", "gpu-process", "utility", "broker", "renderer-broker", "zygote-broker", "gpu-process-broker", "utility-broker"]) {
      const f = processFixture(); f.files.cmdline = `${f.executable}${separator}--type=${role}\0`;
      assert.equal(await readLinuxUpdaterProcessIdentity(123, f.expected, f.options), null);
    }
  }
  const malformed = processFixture(); malformed.files.cmdline = `${malformed.executable} --type=renderer --type=utility\0`;
  await assert.rejects(readLinuxUpdaterProcessIdentity(123, malformed.expected, malformed.options), { code: "LINUX_REAL_APPIMAGE_PROCESS_IDENTITY_INVALID" });
});
test("debugger discovery and connection are enclosed by authority checks and require a unique same-port page", async () => {
  const page = { type: "page", url: "http://127.0.0.1:43211/", webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/page/abc" };
  const events = []; const connection = { close: () => events.push("closed") };
  const options = { assertCdpAuthority: async () => { events.push("owned"); return true; }, readTargets: async () => { events.push("discovery"); return [page]; },
    connect: async () => { events.push("connect"); return connection; }, wait: read => read() };
  assert.equal(await connectPage(43210, () => true, options), connection);
  assert.deepEqual(events, ["owned", "discovery", "owned", "owned", "connect", "owned"]);
  let checks = 0;
  await assert.rejects(connectPage(43210, () => true, { ...options, assertCdpAuthority: async () => ++checks < 4 }), { code: "LINUX_REAL_APPIMAGE_CDP_AUTHORITY_UNAVAILABLE" });
  assert.equal(events.at(-1), "closed");
  await assert.rejects(connectPage(43210, () => true, { ...options, assertCdpAuthority: undefined }), { code: "LINUX_REAL_APPIMAGE_CDP_AUTHORITY_UNAVAILABLE" });
  await assert.rejects(connectPage(43210, () => true, { ...options, readTargets: async () => [page, page] }), { code: "LINUX_REAL_APPIMAGE_CDP_PAGE_AMBIGUOUS" });
  for (const url of ["ws://127.0.0.1:43212/devtools/page/abc", "ws://name@127.0.0.1:43210/devtools/page/abc", "ws://127.0.0.1:43210/devtools/page/abc?x", "wss://127.0.0.1:43210/devtools/page/abc"]) {
    await assert.rejects(connectPage(43210, () => true, { ...options, readTargets: async () => [{ ...page, webSocketDebuggerUrl: url }] }), { code: "LINUX_REAL_APPIMAGE_CDP_RESPONSE_INVALID" });
  }
});
