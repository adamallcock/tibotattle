import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicationAdapters, hashPublicationFile, parsePublicationArguments, preparePublication, PUBLICATION_CONFIRMATION, reconcilePublication, validatePublicationPlan } from "../scripts/reconcile-release-publication.mjs";
import { identityDigest, readOperation } from "../scripts/lib/release-operation.mjs";
import { buildSha256Sums, stableStringify } from "../scripts/release-evidence.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const source = { repository: "https://github.com/adamallcock/tibotattle", commit: "a".repeat(40), tag: "v1.2.3", tagObject: "b".repeat(40) };
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "publication-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = async (name, bytes) => {
    const path = join(root, name); await writeFile(path, bytes);
    return { path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  };
  const assets = [], targets = [];
  for (const architecture of ["arm64", "x64"]) {
    const dmgName = `TiboTattle-1.2.3-macOS-${architecture}.dmg`;
    const appcastName = `appcast-${architecture}.xml`;
    for (const [name, bytes] of [
      [dmgName, `synthetic installer ${architecture}`],
      [appcastName, `<synthetic architecture="${architecture}"/>`],
    ]) assets.push({ name, ...await file(name, bytes) });
    targets.push({ architecture, dmgName, appcastName, sparklePublicEdKey: Buffer.alloc(32, 1).toString("base64"), previousManifest: await file(`previous-${architecture}.json`, "{}"),
      feedManifest: await file(`feed-manifest-${architecture}.json`, JSON.stringify({ source, application: { ...(architecture === "x64" ? { architecture } : {}), shortVersion: "1.2.3", bundleVersion: "1027" } })) });
  }
  const artifactSource = { repository: source.repository, commit: source.commit, tag: source.tag, version: "1.2.3" };
  const canonical = { schemaVersion: "usage-monitor-release-evidence-v1", product: { name: "TiboTattle" }, ...artifactSource,
    artifacts: targets.map((target) => {
      const dmg = assets.find((asset) => asset.name === target.dmgName), appcast = assets.find((asset) => asset.name === target.appcastName);
      return { platform: "macos", architecture: target.architecture, channel: "direct", distribution: "github-release", format: "dmg", version: "1.2.3", source: artifactSource,
        fileName: dmg.name, sha256: dmg.sha256, bytes: dmg.bytes, downloadUrl: `https://github.com/adamallcock/tibotattle/releases/download/v1.2.3/${dmg.name}`,
        assurances: { cleanInstallSmokePassed: true, developerIdSigned: true, gatekeeperAssessmentPassed: true, hardenedRuntime: true, notarizationAccepted: true, ticketStapled: true },
        build: { sourceManifestSha256: sha("synthetic source"), unsignedPayloadSha256: sha("synthetic payload") },
        nativeTrust: { signerIdentity: "Developer ID Application: Synthetic (ABCDEFGHIJ)", teamId: "ABCDEFGHIJ" }, sbom: null, provenance: null, store: null,
        updater: { enabled: true, mechanism: "sparkle", metadata: { fileName: appcast.name, sha256: appcast.sha256, bytes: appcast.bytes, subjectSha256: dmg.sha256 } } };
    }) };
  for (const [name, bytes] of [["release-manifest.json", `${stableStringify(canonical)}\n`], ["SHA256SUMS", buildSha256Sums(canonical)], ["verify-release.md", "Synthetic release verification"]]) assets.push({ name, ...await file(name, bytes) });
  const notes = await file("notes.md", "Synthetic release notes");
  const cask = `cask "tibotattle" do\n  version "1.2.3"\n  arch arm: "arm64", intel: "x64"\n  depends_on macos: :sonoma\n  sha256 arm:   "${assets[0].sha256}",\n         intel: "${assets[2].sha256}"\n  url "https://github.com/adamallcock/tibotattle/releases/download/v#{version}/TiboTattle-#{version}-macOS-#{arch}.dmg"\nend\n`;
  const index = await file("index.html", "<html>Synthetic public release</html>");
  const installer = (architecture) => {
    const target = targets.find((entry) => entry.architecture === architecture), asset = assets.find((entry) => entry.name === target.dmgName);
    return { version: "1.2.3", bytes: asset.bytes, sha256: asset.sha256, architectures: [architecture], minimumMacos: "14.0", url: `https://github.com/adamallcock/tibotattle/releases/download/v1.2.3/${asset.name}` };
  };
  const manifest = await file("release-site-manifest.json", JSON.stringify({ site: { canonicalUrl: "https://tibotattle.com/" }, files: [{ ...index, path: "index.html" }], installer: installer("arm64"), intelInstaller: installer("x64") }));
  const receipt = await file("web-release-receipt.json", JSON.stringify({ sourceCommit: "c".repeat(40), site: { manifestSha256: manifest.sha256 } }));
  const plan = { schemaVersion: 1, source, channel: "stable", version: "1.2.3", build: "1027", assets, targets, notes,
    tap: { ...await file("tibotattle.rb", cask), workflowSha256: sha("reviewed workflow") }, website: { repositoryRoot: root, receipt, manifest } };
  const prepareOptions = {
    verifySource: () => source,
    verifySite: async () => ({}),
    publishFeed: async (options) => {
      assert.equal(options.publish, false);
      const target = targets.find((entry) => entry.architecture === options.architecture);
      const dmg = assets.find((entry) => entry.name === target.dmgName), manifest = target.feedManifest;
      return { source, artifact: { sha256: dmg.sha256, bytes: dmg.bytes }, manifest: { sha256: manifest.sha256, bytes: manifest.bytes } };
    },
  };
  return { root, plan, file, prepareOptions, operationDirectory: join(root, "operation") };
}
function remote(plan, { complete = false } = {}) {
  const state = { release: complete ? { id: 1, draft: false } : null, assets: complete ? plan.assets.map(({ name }) => ({ name })) : [], arm64: complete, x64: complete, tap: complete, website: complete, owner: null };
  const writes = [];
  const lock = {
    status: () => state.owner,
    createOwner: () => "d".repeat(40),
    acquire: (owner) => { assert.equal(state.owner, null); state.owner = owner; },
    assertOwned: (owner) => { if (state.owner !== owner) throw Object.assign(new Error(), { code: "PRODUCTION_COORDINATION_NOT_OWNER" }); },
    release: (owner) => { lock.assertOwned(owner); state.owner = null; },
  };
  const adapters = {
    github: async () => ({ status: !state.release ? "missing" : state.release.draft ? "draft" : "matches", release: structuredClone(state.release), assets: structuredClone(state.assets) }),
    createDraft: async () => { writes.push("draft"); state.release = { id: 1, draft: true }; },
    uploadAsset: async (_prepared, name) => { writes.push(`asset:${name}`); state.assets.push({ name }); },
    publishDraft: async () => { assert.equal(state.assets.length, plan.assets.length); writes.push("publish"); state.release.draft = false; },
    feed: async (_prepared, architecture) => ({ status: state[architecture] ? "matches" : "pending" }),
    publishFeed: async (_prepared, architecture) => { writes.push(`feed-${architecture}`); state[architecture] = true; },
    tap: async () => ({ status: state.tap ? "matches" : "pending" }),
    publishTap: async () => { writes.push("tap"); state.tap = true; },
    website: async () => ({ status: state.website ? "matches" : "pending" }),
    publishWebsite: async () => { assert.equal(state.owner, null); writes.push("website"); state.website = true; },
    coordination: () => lock,
  };
  return { state, writes, adapters };
}
function options(fixture, server) {
  return { plan: fixture.plan, operationDirectory: fixture.operationDirectory, adapters: server.adapters,
    prepare: async (plan) => ({ plan: validatePublicationPlan(plan) }), apply: true,
    confirmation: PUBLICATION_CONFIRMATION, expectedPlanDigest: identityDigest(fixture.plan) };
}

test("publication plan is closed, stable-only, dual architecture and exact asset filenames", async (t) => {
  const { plan } = await fixture(t);
  assert.deepEqual(validatePublicationPlan(plan), plan);
  for (const mutate of [
    (value) => { value.extra = true; }, (value) => { value.channel = "internal-dogfood"; },
    (value) => { value.targets[1].architecture = "arm64"; }, (value) => { value.source.tag = "v9.9.9"; },
    (value) => { value.assets[1].name = value.assets[0].name; }, (value) => { value.assets[0].path += ".changed"; },
    (value) => { value.website.receipt.credentials = "secret"; }, (value) => { value.assets.pop(); },
  ]) { const invalid = structuredClone(plan); mutate(invalid); assert.throws(() => validatePublicationPlan(invalid), /RELEASE_PUBLICATION_/); }
});

test("publication command defaults to read-only and refuses ambiguous flags", () => {
  assert.deepEqual(parsePublicationArguments(["--plan", "plan.json"]), { planPath: "plan.json", apply: false, resume: false, executorStopped: false });
  for (const args of [["--plan", "a", "--plan", "b"], ["--plan", "a", "--resume"], ["--plan", "a", "--confirm", "yes"], ["--unknown"]]) assert.throws(() => parsePublicationArguments(args), /ARGUMENT_INVALID/);
});

test("local admission binds source, both feed validators, site receipt and prepared bytes", async (t) => {
  const f = await fixture(t);
  const prepared = await preparePublication(f.plan, f.prepareOptions);
  assert.deepEqual(Object.keys(prepared.feeds), ["arm64", "x64"]);
  assert.equal(prepared.siteFiles[0].url, "https://tibotattle.com/");
  await writeFile(f.plan.assets[0].path, "changed installer");
  await assert.rejects(preparePublication(f.plan, f.prepareOptions), /LOCAL_BYTES_MISMATCH/);
});

test("local admission rejects tag drift, stale Intel website metadata and symlink inputs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(preparePublication(f.plan, { ...f.prepareOptions, verifySource: () => ({ ...source, tagObject: "e".repeat(40) }) }), /TAG_CHANGED/);
  const site = JSON.parse(await readFile(f.plan.website.manifest.path, "utf8")); site.intelInstaller.version = "1.2.2";
  f.plan.website.manifest = await f.file("release-site-manifest.json", JSON.stringify(site));
  f.plan.website.receipt = await f.file("web-release-receipt.json", JSON.stringify({ sourceCommit: "c".repeat(40), site: { manifestSha256: f.plan.website.manifest.sha256 } }));
  await assert.rejects(preparePublication(f.plan, f.prepareOptions), /SITE_INSTALLER_MISMATCH/);
  await symlink(f.plan.assets[0].path, join(f.root, "linked.dmg"));
  await assert.rejects(hashPublicationFile(join(f.root, "linked.dmg")), /FILE_UNSAFE/);
});

test("canonical evidence owns the seven-asset baseline and refuses extra assets or altered checksum files", async (t) => {
  const f = await fixture(t);
  assert.equal(f.plan.assets.length, 7);
  f.plan.assets.push({ name: "unreviewed.txt", ...await f.file("unreviewed.txt", "extra") });
  await assert.rejects(preparePublication(f.plan, f.prepareOptions), /CANONICAL_ASSET_SET_MISMATCH/);
  f.plan.assets.pop();
  const index = f.plan.assets.findIndex((asset) => asset.name === "SHA256SUMS");
  f.plan.assets[index] = { name: "SHA256SUMS", ...await f.file("SHA256SUMS", "incorrect checksums") };
  await assert.rejects(preparePublication(f.plan, f.prepareOptions), /CHECKSUM_SET_MISMATCH/);
});

test("read-only inspection creates no journal and makes no mutation calls", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  const result = await reconcilePublication({ ...options(f, server), apply: false });
  assert.equal(result.complete, false); assert.equal(result.mode, "inspect");
  assert.deepEqual(server.writes, []);
  await assert.rejects(lstat(f.operationDirectory), { code: "ENOENT" });
});

test("mutation requires separate exact confirmation and reviewed plan digest", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  for (const override of [{ confirmation: "yes" }, { expectedPlanDigest: "f".repeat(64) }, { operationDirectory: null }]) {
    await assert.rejects(reconcilePublication({ ...options(f, server), ...override }), /EXPLICIT_AUTHORIZATION_REQUIRED/);
  }
  assert.deepEqual(server.writes, []);
});

test("complete publication is idempotent and rerun writes nothing including no lock or journal", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  const first = await reconcilePublication(options(f, server));
  assert.equal(first.complete, true); assert.equal(server.state.owner, null);
  assert.equal(server.writes.length, 13);
  const count = server.writes.length;
  const again = await reconcilePublication(options(f, server));
  assert.equal(again.complete, true); assert.equal(again.writesAttempted, false); assert.equal(server.writes.length, count);
  assert.equal((await readOperation(f.operationDirectory)).kind, "publication");
});

test("lost GitHub publish response is reconciled without a second publication", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  const publish = server.adapters.publishDraft;
  server.adapters.publishDraft = async (...args) => { await publish(...args); throw new Error("lost response with private diagnostics"); };
  const result = await reconcilePublication(options(f, server));
  assert.equal(result.complete, true); assert.equal(server.writes.filter((step) => step === "publish").length, 1);
  assert.ok(!JSON.stringify(result).includes("private diagnostics"));
});

test("one feed failure preserves earlier successes and never blindly retries uncertainty", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  const publish = server.adapters.publishFeed;
  server.adapters.publishFeed = async (prepared, architecture) => { if (architecture === "x64") { server.writes.push("feed-x64-uncertain"); throw new Error(); } await publish(prepared, architecture); };
  const first = await reconcilePublication(options(f, server));
  assert.equal(first.complete, false); assert.equal(first.surfaces["feed-arm64"].status, "matches");
  assert.equal(first.code, "RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED");
  await assert.rejects(reconcilePublication({ ...options(f, server), resume: true }), /EXECUTOR_STOP_CONFIRMATION_REQUIRED/);
  const second = await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true });
  assert.equal(second.complete, false); assert.equal(server.writes.filter((step) => step === "feed-x64-uncertain").length, 1);
  server.state.x64 = true; // Independently reconciled remote completion.
  const third = await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true });
  assert.equal(third.complete, true); assert.equal(server.writes.filter((step) => step === "feed-arm64").length, 1);
});

test("asynchronous tap dispatch is recorded once and read back on resume", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  server.adapters.publishTap = async () => { server.writes.push("tap-dispatch"); };
  const first = await reconcilePublication(options(f, server));
  assert.equal(first.code, "RELEASE_PUBLICATION_REMOTE_PENDING");
  const waiting = await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true });
  assert.equal(waiting.code, "RELEASE_PUBLICATION_REMOTE_PENDING");
  assert.equal(server.writes.filter((step) => step === "tap-dispatch").length, 1);
  server.state.tap = true;
  assert.equal((await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true })).complete, true);
});

test("website failure leaves feeds verified and does not repeat an uncertain deployment", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  server.adapters.publishWebsite = async () => { server.writes.push("website-uncertain"); throw new Error(); };
  const first = await reconcilePublication(options(f, server));
  assert.equal(first.surfaces["feed-x64"].status, "matches"); assert.equal(first.coordination, "released");
  const second = await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true });
  assert.equal(second.complete, false); assert.equal(server.writes.filter((step) => step === "website-uncertain").length, 1);
  server.state.website = true;
  assert.equal((await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true })).complete, true);
});

test("resume recovers a lost lock-release acknowledgement without replaying publications", async (t) => {
  const f = await fixture(t), server = remote(f.plan), lock = server.adapters.coordination(), release = lock.release;
  let first = true;
  lock.release = (owner) => { release(owner); if (first) { first = false; throw new Error("lost lock response"); } };
  const interrupted = await reconcilePublication(options(f, server));
  assert.equal(interrupted.complete, false); assert.equal(interrupted.coordination, "held"); assert.equal(server.state.owner, null);
  const resumed = await reconcilePublication({ ...options(f, server), resume: true, executorStopped: true });
  assert.equal(resumed.complete, true); assert.equal(server.writes.filter((step) => step === "publish").length, 1);
});

test("conflicting ownership and immutable surface conflicts prevent publication", async (t) => {
  const f = await fixture(t), server = remote(f.plan);
  server.state.owner = "e".repeat(40);
  assert.equal((await reconcilePublication(options(f, server))).complete, false);
  assert.deepEqual(server.writes, []);
  server.adapters.github = async () => { throw Object.assign(new Error(), { code: "RELEASE_PUBLICATION_IMMUTABLE_BYTES_CONFLICT" }); };
  const result = await reconcilePublication({ ...options(f, server), operationDirectory: join(f.root, "second") });
  assert.equal(result.surfaces.github.code, "RELEASE_PUBLICATION_IMMUTABLE_BYTES_CONFLICT");
  assert.deepEqual(server.writes, []);
});

test("live adapter rejects same-build feed drift and stale fetched site assets", async (t) => {
  const f = await fixture(t);
  const adapter = createPublicationAdapters({ fetchImpl: async (url) => {
    assert.ok(new URL(url).searchParams.has("release_reconcile"));
    return new Response(String(url).includes("appcast") ? "<sparkle:version>1027</sparkle:version>" : "old cached website bytes");
  } });
  const prepared = { plan: f.plan, feeds: { arm64: { target: f.plan.targets[0], prepared: { appcast: { url: "https://updates.tibotattle.com/appcast.xml" } } } }, siteFiles: [] };
  await assert.rejects(adapter.feed(prepared, "arm64"), /SAME_BUILD_CONFLICT/);
  assert.equal((await adapter.website(prepared)).status, "pending");
});

test("live GitHub adapter re-downloads exact draft bytes and refuses same-name conflicts", async (t) => {
  const f = await fixture(t);
  const asset = f.plan.assets[0];
  const spawn = (_command, args, options) => {
    if (args[0] === "api" && args.includes("Accept: application/octet-stream")) { writeSync(options.stdio[1], Buffer.from("wrong immutable installer")); return { status: 0, stdout: "" }; }
    const route = args[3];
    const json = route.includes("/assets?") ? [{ name: asset.name, id: 10, size: asset.bytes, state: "uploaded", browser_download_url: `https://github.com/adamallcock/tibotattle/releases/download/v1.2.3/${asset.name}` }] : { id: 1, tag_name: f.plan.source.tag, prerelease: false, draft: true, name: "TiboTattle 1.2.3", body: "Synthetic release notes" };
    return { status: 0, stdout: JSON.stringify(json) };
  };
  await assert.rejects(createPublicationAdapters({ spawn }).github({ plan: f.plan }), /IMMUTABLE_BYTES_CONFLICT/);
});

test("GitHub adapter verifies every public asset and fresh readback bypasses invocation-only cache", async (t) => {
  const f = await fixture(t), contents = await Promise.all(f.plan.assets.map((asset) => readFile(asset.path)));
  let downloads = 0, attestations = 0;
  const spawn = (_command, args, options) => {
    if (args[0] === "release") { assert.ok(["verify", "verify-asset"].includes(args[1])); attestations += 1; return { status: 0 }; }
    if (args.includes("Accept: application/octet-stream")) {
      downloads += 1; writeSync(options.stdio[1], contents[Number(args[1].split("/").at(-1)) - 1]); return { status: 0 };
    }
    const route = args[3];
    const json = route.includes("/assets?") ? f.plan.assets.map((asset, index) => ({ id: index + 1, name: asset.name, size: asset.bytes, state: "uploaded",
      browser_download_url: `https://github.com/adamallcock/tibotattle/releases/download/v1.2.3/${asset.name}` }))
      : { id: 1, tag_name: source.tag, draft: false, prerelease: false, immutable: true, name: "TiboTattle 1.2.3", body: "Synthetic release notes" };
    return { status: 0, stdout: JSON.stringify(json) };
  };
  const adapter = createPublicationAdapters({ spawn });
  assert.equal((await adapter.github({ plan: f.plan })).status, "matches");
  assert.equal(downloads, 7); assert.equal(attestations, 8);
  await adapter.github({ plan: f.plan }); assert.equal(downloads, 7); assert.equal(attestations, 8);
  await adapter.github({ plan: f.plan }, { fresh: true }); assert.equal(downloads, 14); assert.equal(attestations, 16);
});

test("GitHub draft admission refuses disabled immutability without any remote write", async (t) => {
  const f = await fixture(t), calls = [];
  const adapter = createPublicationAdapters({ spawn: (_command, args) => {
    calls.push(args); assert.equal(args[2], "GET");
    if (args[3].endsWith("/immutable-releases")) return { status: 1, stderr: "HTTP 404" };
    return { status: 0, stdout: JSON.stringify(args[3].includes("/assets?") ? [] : { id: 1, tag_name: source.tag, draft: true, prerelease: false, name: "TiboTattle 1.2.3", body: "Synthetic release notes" }) };
  } });
  await assert.rejects(adapter.github({ plan: f.plan }), /GITHUB_IMMUTABILITY_REQUIRED/);
  assert.ok(calls.some((args) => args[3].endsWith("/immutable-releases")));
});

test("draft admission refuses promoting an older version to latest", async (t) => {
  const f = await fixture(t);
  const adapter = createPublicationAdapters({ spawn: (_command, args) => {
    assert.equal(args[2], "GET");
    if (args[3].includes("/releases/tags/")) return { status: 1, stderr: "HTTP 404" };
    return { status: 0, stdout: JSON.stringify(args[3].endsWith("/immutable-releases") ? { enabled: true } : { tag_name: "v1.2.4" }) };
  } });
  await assert.rejects(adapter.github({ plan: f.plan }), /DOWNGRADE_REFUSED/);
});

test("tap adapter detects stale Intel bytes and dispatches only the pinned existing updater", async (t) => {
  const f = await fixture(t), cask = await readFile(f.plan.tap.path);
  let current = Buffer.from(cask.toString().replace(f.plan.assets[2].sha256, "0".repeat(64))), dispatches = 0;
  let latestTag = source.tag;
  const adapter = createPublicationAdapters({ spawn: (_command, args, options) => {
    const route = args[3];
    if (args[2] === "POST") {
      assert.equal(route, "repos/adamallcock/homebrew-tap/actions/workflows/update-tibotattle.yml/dispatches");
      assert.deepEqual(JSON.parse(options.input), { ref: "main" }); dispatches += 1; return { status: 0, stdout: "" };
    }
    const json = route.endsWith("/releases/latest") ? { tag_name: latestTag, draft: false, prerelease: false }
      : { encoding: "base64", content: (route.includes("update-tibotattle.yml") ? Buffer.from("reviewed workflow") : current).toString("base64") };
    return { status: 0, stdout: JSON.stringify(json) };
  } });
  assert.equal((await adapter.tap({ plan: f.plan })).status, "pending");
  await adapter.publishTap({ plan: f.plan }); assert.equal(dispatches, 1);
  current = cask; assert.equal((await adapter.tap({ plan: f.plan })).status, "matches");
  latestTag = "v1.2.4"; await assert.rejects(adapter.publishTap({ plan: f.plan }), /TAP_LATEST_CHANGED/); assert.equal(dispatches, 1);
});

test("real feed and website adapters delegate current guarded entrypoint contracts", async (t) => {
  const f = await fixture(t), prepared = await preparePublication(f.plan, f.prepareOptions), feedCalls = [], siteCalls = [];
  const adapter = createPublicationAdapters({ publishFeed: async (options) => { feedCalls.push(options); return { verified: true }; },
    deploySite: async (options) => { siteCalls.push(options); return { deployment: { ok: true } }; } });
  await adapter.publishFeed(prepared, "x64");
  assert.equal(feedCalls[0].architecture, "x64"); assert.equal(feedCalls[0].publish, true); assert.equal(feedCalls[0].replaceAppcast, true);
  assert.equal(feedCalls[0].atomicAppcastGuardEndpoint, "https://tibotattle.com/api/v1/internal/release/appcast");
  assert.equal(feedCalls[0].atomicAppcastGuardTokenEnv, "SPARKLE_APPCAST_GUARD_TOKEN");
  assert.equal(feedCalls[0].releaseManifestPath, f.plan.targets[1].feedManifest.path);
  await adapter.publishWebsite(prepared);
  assert.equal(siteCalls[0].repositoryRoot, f.root); assert.equal(siteCalls[0].receiptPath, f.plan.website.receipt.path);
  assert.ok(siteCalls[0].confirmation.includes("PRODUCTION"));
  await writeFile(f.plan.targets[1].feedManifest.path, "changed local feed manifest");
  await assert.rejects(adapter.publishFeed(prepared, "x64"), /LOCAL_BYTES_MISMATCH/); assert.equal(feedCalls.length, 1);
});

test("website readback checks every prepared file and current healthy deployment source", async (t) => {
  const f = await fixture(t), prepared = await preparePublication(f.plan, f.prepareOptions);
  let healthySource = prepared.websiteSourceCommit;
  const reads = [];
  const adapter = createPublicationAdapters({ fetchImpl: async (input) => {
    const url = new URL(input); reads.push(url.pathname);
    if (url.pathname === "/api/health") {
      const response = new Response(JSON.stringify({ status: "ok", deployment: { sourceCommit: healthySource } }), { headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
      Object.defineProperty(response, "url", { value: String(input) }); return response;
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return new Response(await readFile(join(f.root, path)));
  } });
  assert.equal((await adapter.website(prepared)).status, "matches");
  assert.deepEqual(reads, ["/release-site-manifest.json", "/", "/api/health"]);
  healthySource = "e".repeat(40); assert.equal((await adapter.website(prepared)).status, "pending");
});
