#!/usr/bin/env node
/** Exact, read-only-by-default reconciliation of an already qualified release. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import { resolveReleaseChannel } from "../config/release-channels.js";
import { isAppleMacOSBundleVersion } from "./macos-bundle-version.js";
import { createAppcastAtomicGuardFromEnvironment, publishSparkleUpdate, verifyReleaseManifestSourceProvenance } from "./publish-sparkle-update.js";
import { deployWebRelease } from "./deploy-web-release.js";
import { verifyWebReleaseReceipt } from "./web-release-lane.js";
import { isElectronSparkleTransition } from "./electron-sparkle-transition.js";
import { buildSha256Sums, validateReleaseEvidenceManifest } from "./release-evidence.js";
import { PRODUCTION_DEPLOY_CONFIRMATION, recheckProductionHealth } from "../apps/worker/scripts/production-deploy.mjs";
import { createProductionDeploymentLock } from "../apps/worker/scripts/production-deployment-lock.mjs";
import { identityDigest, openOperation, operationError } from "./lib/release-operation.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY = "adamallcock/tibotattle";
const TAP = "adamallcock/homebrew-tap";
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BYTES = 10 * 1024 ** 3;
const MAX_SMALL = 1024 ** 2;
export const PUBLICATION_CONFIRMATION = "RECONCILE_EXACT_RELEASE_PUBLICATION";
const fail = (code) => { throw operationError(code); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}
function fileSpec(value, extra = []) {
  return exact(value, ["path", "sha256", "bytes", ...extra])
    && typeof value.path === "string" && value.path.length > 0 && value.path.length < 4096
    && !/[\0\r\n]/.test(value.path) && SHA.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_BYTES;
}

export function validatePublicationPlan(plan) {
  if (!exact(plan, ["schemaVersion", "source", "channel", "version", "build", "assets", "notes", "targets", "tap", "website"])
      || plan.schemaVersion !== 1 || plan.channel !== "stable"
      || !/^\d+\.\d+\.\d+$/.test(plan.version) || !isAppleMacOSBundleVersion(plan.build)
      || !exact(plan.source, ["commit", "tag", "tagObject", "repository"])
      || plan.source.repository !== `https://github.com/${REPOSITORY}`
      || !COMMIT.test(plan.source.commit) || !COMMIT.test(plan.source.tagObject)
      || plan.source.tag !== `v${plan.version}` || !fileSpec(plan.notes) || plan.notes.bytes > MAX_SMALL
      || !Array.isArray(plan.assets) || plan.assets.length < 7 || plan.assets.length > 40
      || plan.assets.some((asset) => !fileSpec(asset, ["name"]) || !NAME.test(asset.name) || basename(asset.path) !== asset.name)
      || new Set(plan.assets.map((asset) => asset.name)).size !== plan.assets.length
      || !["release-manifest.json", "SHA256SUMS", "verify-release.md"].every((name) => plan.assets.some((asset) => asset.name === name))
      || !Array.isArray(plan.targets) || plan.targets.length !== 2
      || plan.targets.map((target) => target?.architecture).sort().join() !== "arm64,x64"
      || !fileSpec(plan.tap, ["workflowSha256"]) || !SHA.test(plan.tap.workflowSha256) || plan.tap.bytes > MAX_SMALL
      || !exact(plan.website, ["repositoryRoot", "receipt", "manifest"])
      || typeof plan.website.repositoryRoot !== "string" || !plan.website.repositoryRoot
      || plan.website.repositoryRoot.length > 4096 || /[\0\r\n]/.test(plan.website.repositoryRoot)
      || !fileSpec(plan.website.receipt) || !fileSpec(plan.website.manifest)
      || plan.website.receipt.bytes > MAX_SMALL || plan.website.manifest.bytes > MAX_SMALL) {
    fail("RELEASE_PUBLICATION_PLAN_INVALID");
  }
  for (const target of plan.targets) {
    if (!exact(target, ["architecture", "feedManifest", "dmgName", "appcastName", "sparklePublicEdKey", "previousManifest", ...(target.sparkleDmg === undefined ? [] : ["sparkleDmg"])])
        || !fileSpec(target.feedManifest) || target.feedManifest.bytes > MAX_SMALL || !fileSpec(target.previousManifest) || target.previousManifest.bytes > MAX_SMALL
        || !/^[A-Za-z0-9+/]{43}=$/.test(target.sparklePublicEdKey)
        || ![target.dmgName, target.appcastName].every((name) => plan.assets.some((asset) => asset.name === name))
        || (target.sparkleDmg === undefined
          ? target.dmgName !== `TiboTattle-${plan.version}-macOS-${target.architecture}.dmg`
          : !fileSpec(target.sparkleDmg) || target.dmgName !== `TiboTattle-${plan.version}-mac-${target.architecture}.dmg`)) fail("RELEASE_PUBLICATION_TARGET_INVALID");
  }
  if (new Set(plan.targets.flatMap((target) => [target.dmgName, target.appcastName])).size !== 4) fail("RELEASE_PUBLICATION_TARGET_INVALID");
  return structuredClone(plan);
}

// Descriptor-bound streaming reads keep installer validation bounded in memory.
export async function hashPublicationFile(path, maximum = MAX_BYTES) {
  const selected = resolve(path);
  if (await realpath(dirname(selected)) !== dirname(selected)) fail("RELEASE_PUBLICATION_FILE_UNSAFE");
  const before = await lstat(selected);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail("RELEASE_PUBLICATION_FILE_UNSAFE");
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) fail("RELEASE_PUBLICATION_FILE_CHANGED");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== bytes || bytes !== before.size) fail("RELEASE_PUBLICATION_FILE_CHANGED");
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}
async function verifyFile(spec) {
  const actual = await hashPublicationFile(spec.path);
  if (actual.sha256 !== spec.sha256 || actual.bytes !== spec.bytes) fail("RELEASE_PUBLICATION_LOCAL_BYTES_MISMATCH");
}
async function jsonFile(spec) {
  await verifyFile(spec);
  if (spec.bytes > MAX_SMALL) fail("RELEASE_PUBLICATION_METADATA_TOO_LARGE");
  const bytes = await readFile(spec.path);
  if (digest(bytes) !== spec.sha256) fail("RELEASE_PUBLICATION_FILE_CHANGED");
  try { return JSON.parse(bytes); } catch { fail("RELEASE_PUBLICATION_METADATA_INVALID"); }
}

export async function preparePublication(plan, { repositoryRoot = ROOT, publishFeed = publishSparkleUpdate, verifySite = verifyWebReleaseReceipt, verifySource = verifyReleaseManifestSourceProvenance } = {}) {
  plan = validatePublicationPlan(plan);
  for (const spec of [...plan.assets, plan.notes, plan.tap, ...plan.targets.map((target) => target.previousManifest)]) await verifyFile(spec);
  const source = verifySource({ repository: plan.source.repository, commit: plan.source.commit, tag: plan.source.tag }, { channel: plan.channel, expectedVersion: plan.version, repositoryRoot });
  if (source.tagObject !== plan.source.tagObject) fail("RELEASE_PUBLICATION_TAG_CHANGED");
  const asset = (name) => plan.assets.find((entry) => entry.name === name);
  const canonical = await jsonFile(asset("release-manifest.json"));
  await validateReleaseEvidenceManifest(canonical, { artifactRoot: dirname(asset("release-manifest.json").path), manifestPath: asset("release-manifest.json").path });
  const electron = canonical.artifacts.length === 4
    && canonical.artifacts.every(a => a.updater?.mechanism === "electron-updater")
    && canonical.artifacts.map(a => `${a.platform}-${a.architecture}`).sort().join() === "linux-x64,macos-arm64,macos-x64,windows-x64";
  const macArtifacts = canonical.artifacts.filter(a => a.platform === "macos");
  if (canonical.version !== plan.version || canonical.tag !== plan.source.tag || canonical.commit !== plan.source.commit
      || canonical.repository !== plan.source.repository || (!electron && canonical.artifacts.length !== 2)
      || canonical.artifacts.some((artifact) => (!electron && artifact.platform !== "macos") || artifact.channel !== "direct" || artifact.distribution !== "github-release")
      || macArtifacts.map((artifact) => artifact.architecture).sort().join() !== "arm64,x64") fail("RELEASE_PUBLICATION_CANONICAL_IDENTITY_MISMATCH");
  const sums = buildSha256Sums(canonical);
  const sumsFile = asset("SHA256SUMS");
  if (digest(sums) !== sumsFile.sha256 || Buffer.byteLength(sums) !== sumsFile.bytes) fail("RELEASE_PUBLICATION_CHECKSUM_SET_MISMATCH");
  let expectedAssets = [...sums.trimEnd().split("\n").map((row) => row.slice(66)), "SHA256SUMS", "verify-release.md"].sort();
  if (electron) {
    const extra = plan.targets.flatMap(t => [t.appcastName,
      `TiboTattle-${plan.version}-mac-${t.architecture}.zip`,
      `TiboTattle-${plan.version}-mac-${t.architecture}.zip.blockmap`,
      `TiboTattle-${plan.version}-mac-${t.architecture}.dmg.blockmap`]);
    expectedAssets = [...expectedAssets, ...extra, "SHA256SUMS-ALL-RELEASE-FILES"].sort();
    if (new Set(expectedAssets).size !== expectedAssets.length) fail("RELEASE_PUBLICATION_CANONICAL_ASSET_SET_MISMATCH");
    const allSums = asset("SHA256SUMS-ALL-RELEASE-FILES");
    const summed = expectedAssets.filter(n => !["release-manifest.json", "SHA256SUMS", "SHA256SUMS-ALL-RELEASE-FILES", "verify-release.md"].includes(n));
    if (!allSums || summed.some(n => !asset(n))) fail("RELEASE_PUBLICATION_CANONICAL_ASSET_SET_MISMATCH");
    const expected = summed.map(n => `${asset(n).sha256}  ${n}`).sort().join("\n") + "\n";
    if (allSums.sha256 !== digest(expected) || allSums.bytes !== Buffer.byteLength(expected)) fail("RELEASE_PUBLICATION_CHECKSUM_SET_MISMATCH");
  }
  if (expectedAssets.join() !== plan.assets.map((entry) => entry.name).sort().join()) fail("RELEASE_PUBLICATION_CANONICAL_ASSET_SET_MISMATCH");
  const feeds = {};
  for (const target of plan.targets) {
    const artifact = macArtifacts.find((entry) => entry.architecture === target.architecture);
    if (artifact.fileName !== target.dmgName || artifact.updater.enabled !== true
        || (electron ? target.sparkleDmg === undefined || artifact.updater.metadata.fileName !== `TiboTattle-${plan.version}-darwin-${target.architecture}-update.yml`
          : target.sparkleDmg !== undefined || artifact.updater.metadata.fileName !== target.appcastName)) fail("RELEASE_PUBLICATION_CANONICAL_TARGET_MISMATCH");
    const manifest = await jsonFile(target.feedManifest);
    const incomingDmg = electron ? target.sparkleDmg : asset(target.dmgName);
    if (electron) {
      await verifyFile(incomingDmg);
      if (incomingDmg.sha256 !== artifact.sha256 || incomingDmg.bytes !== artifact.bytes
          || !isElectronSparkleTransition(manifest)) fail("RELEASE_PUBLICATION_CANONICAL_TARGET_MISMATCH");
    } else if (isElectronSparkleTransition(manifest)) fail("RELEASE_PUBLICATION_CANONICAL_TARGET_MISMATCH");
    if (manifest.source?.commit !== plan.source.commit || manifest.source?.tag !== plan.source.tag
        || manifest.application?.shortVersion !== plan.version || manifest.application?.bundleVersion !== plan.build
        || (manifest.application?.architecture ?? "arm64") !== target.architecture) fail("RELEASE_PUBLICATION_MANIFEST_IDENTITY_MISMATCH");
    const channel = resolveReleaseChannel(plan.channel, { architecture: target.architecture });
    const options = { architecture: target.architecture, channel: plan.channel, bucket: channel.sparkle.r2Bucket,
      dmgPath: incomingDmg.path, appcastPath: asset(target.appcastName).path,
      releaseManifestPath: target.feedManifest.path, sparklePublicEdKey: target.sparklePublicEdKey,
      previousStableManifestPath: target.previousManifest.path, sourceRepositoryRoot: repositoryRoot };
    // Existing validator retains native trust, both Sparkle signatures, key continuity,
    // canonical object names, and local/remote annotated source provenance.
    const prepared = await publishFeed({ ...options, publish: false });
    if (prepared.artifact.sha256 !== asset(target.dmgName).sha256 || prepared.manifest.sha256 !== target.feedManifest.sha256
        || prepared.source.tagObject !== plan.source.tagObject) fail("RELEASE_PUBLICATION_FEED_IDENTITY_MISMATCH");
    feeds[target.architecture] = { options, prepared, target };
  }
  const receipt = await jsonFile(plan.website.receipt);
  const site = await jsonFile(plan.website.manifest);
  if (receipt.site?.manifestSha256 !== plan.website.manifest.sha256 || !COMMIT.test(receipt.sourceCommit)
      || site.site?.canonicalUrl !== `${DEPLOYMENT_ENDPOINTS.public.origin}/`
      || !Array.isArray(site.files) || site.files.length < 1 || site.files.length > 500) fail("RELEASE_PUBLICATION_SITE_IDENTITY_MISMATCH");
  await verifySite({ repositoryRoot: plan.website.repositoryRoot, receiptPath: plan.website.receipt.path });
  if (electron) {
    // The reviewed Electron site generator emits four download rows, not the
    // native site's legacy installer/intelInstaller objects.
    const release = site.electronRelease;
    if (!exact(release, ["version", "buildNumber", "publishedInstallersVerified", "verificationScope", "downloads"])
        || release.version !== plan.version || release.publishedInstallersVerified !== true
        || !Array.isArray(release.verificationScope)
        || release.verificationScope.join() !== "reviewed-publication-plan,local-artifact-bytes,published-installer-bytes"
        || !Array.isArray(release.downloads) || release.downloads.length !== 4
        || new Set(release.downloads.map(row => row?.target)).size !== 4) fail("RELEASE_PUBLICATION_SITE_INSTALLER_MISMATCH");
    for (const target of plan.targets) {
      const manifest = await jsonFile(target.feedManifest);
      if (release.buildNumber !== manifest.electron?.buildNumber) fail("RELEASE_PUBLICATION_SITE_INSTALLER_MISMATCH");
    }
    for (const artifact of canonical.artifacts) {
      const platform = { macos: "darwin", windows: "win32", linux: "linux" }[artifact.platform];
      const row = release.downloads.find(value => value?.target === `${platform}-${artifact.architecture}`);
      if (!exact(row, ["target", "url", "bytes", "sha256"])
          || row.sha256 !== artifact.sha256 || row.bytes !== artifact.bytes
          || row.url !== `https://github.com/${REPOSITORY}/releases/download/${plan.source.tag}/${artifact.fileName}`) fail("RELEASE_PUBLICATION_SITE_INSTALLER_MISMATCH");
    }
    // Mac minimum OS and architecture are established by the signed native
    // publisher validation above, not nonexistent download-row fields.
  } else {
    for (const target of plan.targets) {
      const row = target.architecture === "arm64" ? site.installer : site.intelInstaller;
      const dmg = asset(target.dmgName);
      if (row?.version !== plan.version || row.sha256 !== dmg.sha256 || row.bytes !== dmg.bytes
          || row.minimumMacos !== "14.0" || !row.architectures?.includes(target.architecture)
          || row.url !== `https://github.com/${REPOSITORY}/releases/download/${plan.source.tag}/${dmg.name}`) fail("RELEASE_PUBLICATION_SITE_INSTALLER_MISMATCH");
    }
  }
  const siteFiles = [];
  for (const file of site.files) {
    if (!exact(file, ["path", "bytes", "sha256"]) || !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(file.path)
        || file.path.split("/").some((part) => part === ".." || part === ".") || !SHA.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 16 * MAX_SMALL) fail("RELEASE_PUBLICATION_SITE_FILES_INVALID");
    const spec = { ...file, path: join(dirname(plan.website.manifest.path), file.path) };
    await verifyFile(spec);
    siteFiles.push({ ...file, url: `${DEPLOYMENT_ENDPOINTS.public.origin}/${file.path === "index.html" ? "" : file.path}` });
  }
  if (new Set(siteFiles.map((file) => file.url)).size !== siteFiles.length || !site.files.some((file) => file.path === "index.html")) fail("RELEASE_PUBLICATION_SITE_FILES_INVALID");
  const cask = await readFile(plan.tap.path, "utf8");
  const arm = asset(plan.targets.find((target) => target.architecture === "arm64").dmgName);
  const intel = asset(plan.targets.find((target) => target.architecture === "x64").dmgName);
  if (digest(cask) !== plan.tap.sha256 || !cask.includes(`  version "${plan.version}"\n`)
      || !cask.includes('  arch arm: "arm64", intel: "x64"\n')
      || !cask.includes('  depends_on macos: :sonoma\n')
      || !cask.includes(`  sha256 arm:   "${arm.sha256}",\n         intel: "${intel.sha256}"\n`)
      || !cask.includes(`  url "https://github.com/adamallcock/tibotattle/releases/download/v#{version}/TiboTattle-#{version}-${electron ? 'mac' : 'macOS'}-#{arch}.dmg"\n`)) fail("RELEASE_PUBLICATION_CASK_IDENTITY_MISMATCH");
  return { plan, feeds, siteFiles, websiteSourceCommit: receipt.sourceCommit };
}

function command(spawn, commandName, args, options = {}) {
  const result = spawn(commandName, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * MAX_SMALL,
    env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }, ...options });
  if (result.error || result.status !== 0) {
    if (options.allow404 && /HTTP 404/.test(String(result.stderr))) return null;
    fail("RELEASE_PUBLICATION_REMOTE_COMMAND_FAILED");
  }
  return result.stdout ?? "";
}

export function createPublicationAdapters({ repositoryRoot = ROOT, spawn = spawnSync, fetchImpl = fetch, publishFeed = publishSparkleUpdate, deploySite = deployWebRelease } = {}) {
  const downloaded = new Map();
  const attested = new Set();
  let appcastGuard;
  const api = (route, { method = "GET", body, allow404 = false } = {}) => {
    const value = command(spawn, "gh", ["api", "--method", method, route, ...(body ? ["--input", "-"] : [])], { input: body ? JSON.stringify(body) : undefined, allow404 });
    if (value === null) return null;
    try { return value.trim() === "" ? null : JSON.parse(value); } catch { fail("RELEASE_PUBLICATION_REMOTE_JSON_INVALID"); }
  };
  const downloadAsset = async (id) => {
    if (!Number.isSafeInteger(id) || id < 1) fail("RELEASE_PUBLICATION_ASSET_ID_INVALID");
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-publication-readback-"));
    const path = join(temporary, "asset");
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      command(spawn, "gh", ["api", `repos/${REPOSITORY}/releases/assets/${id}`, "-H", "Accept: application/octet-stream"], { stdio: ["ignore", handle.fd, "pipe"], timeout: 600_000 });
      await handle.close();
      return await hashPublicationFile(path);
    } finally { await handle.close().catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
  };
  const publicBytes = async (url, maximum = 16 * MAX_SMALL, collect = false) => {
    const parsed = new URL(url);
    if (![DEPLOYMENT_ENDPOINTS.public.origin, DEPLOYMENT_ENDPOINTS.sparkle.origin].includes(parsed.origin)
        || parsed.username || parsed.password || parsed.hash) fail("RELEASE_PUBLICATION_URL_INVALID");
    parsed.searchParams.set("release_reconcile", `${Date.now()}`);
    const response = await fetchImpl(parsed, { cache: "no-store", headers: { "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) fail("RELEASE_PUBLICATION_PUBLIC_READ_FAILED");
    const hash = createHash("sha256"); let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) fail("RELEASE_PUBLICATION_PUBLIC_TOO_LARGE");
      hash.update(chunk); if (collect) chunks.push(Buffer.from(chunk));
    }
    return { sha256: hash.digest("hex"), bytes, ...(collect ? { text: Buffer.concat(chunks).toString("utf8") } : {}) };
  };
  const admitDraft = (plan) => {
    if (api(`repos/${REPOSITORY}/immutable-releases`, { allow404: true })?.enabled !== true) fail("RELEASE_PUBLICATION_GITHUB_IMMUTABILITY_REQUIRED");
    const latest = api(`repos/${REPOSITORY}/releases/latest`, { allow404: true });
    if (!latest) return;
    if (!/^v\d+\.\d+\.\d+$/.test(latest.tag_name ?? "")) fail("RELEASE_PUBLICATION_LATEST_VERSION_UNKNOWN");
    const actual = latest.tag_name.slice(1).split(".").map(BigInt), expected = plan.version.split(".").map(BigInt);
    for (let index = 0; index < 3; index += 1) {
      if (actual[index] > expected[index]) fail("RELEASE_PUBLICATION_DOWNGRADE_REFUSED");
      if (actual[index] < expected[index]) return;
    }
  };
  const github = async (prepared, { fresh = false } = {}) => {
    const { plan } = prepared;
    const release = api(`repos/${REPOSITORY}/releases/tags/${plan.source.tag}`, { allow404: true });
    if (!release) {
      admitDraft(plan);
      return { status: "missing", release: null, assets: [] };
    }
    if (!Number.isSafeInteger(release.id) || release.tag_name !== plan.source.tag || release.prerelease !== false
        || release.name !== `TiboTattle ${plan.version}` || digest(release.body ?? "") !== plan.notes.sha256) fail("RELEASE_PUBLICATION_GITHUB_IDENTITY_CONFLICT");
    const assets = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = api(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) fail("RELEASE_PUBLICATION_ASSET_LIST_INVALID");
      assets.push(...batch); if (batch.length < 100) break;
      if (page === 20) fail("RELEASE_PUBLICATION_ASSET_LIST_TOO_LARGE");
    }
    if (new Set(assets.map((asset) => asset.name)).size !== assets.length
        || assets.some((asset) => !plan.assets.some((expected) => expected.name === asset.name))) fail("RELEASE_PUBLICATION_ASSET_SET_CONFLICT");
    for (const asset of assets) {
      const expected = plan.assets.find((entry) => entry.name === asset.name);
      if (asset.size !== expected.bytes || asset.state !== "uploaded"
          || asset.browser_download_url !== `https://github.com/${REPOSITORY}/releases/download/${plan.source.tag}/${expected.name}`) fail("RELEASE_PUBLICATION_GITHUB_ASSET_METADATA_CONFLICT");
      // GitHub asset IDs identify immutable byte objects: replacement gets a
      // new ID. Reuse only inside this invocation and draft/publication phase;
      // final reconciliation explicitly forces a new network download.
      const cacheKey = `${release.id}:${release.draft}:${asset.id}:${expected.sha256}`;
      const actual = !fresh && downloaded.has(cacheKey) ? downloaded.get(cacheKey) : await downloadAsset(asset.id);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail("RELEASE_PUBLICATION_IMMUTABLE_BYTES_CONFLICT");
      downloaded.set(cacheKey, actual);
    }
    const complete = assets.length === plan.assets.length;
    if (release.draft) admitDraft(plan);
    if (!release.draft && !complete) fail("RELEASE_PUBLICATION_PUBLISHED_ASSET_SET_CONFLICT");
    if (!release.draft) {
      if (release.immutable !== true) fail("RELEASE_PUBLICATION_GITHUB_IMMUTABILITY_REQUIRED");
      if (fresh || !attested.has(release.id)) {
        command(spawn, "gh", ["release", "verify", plan.source.tag, "--repo", REPOSITORY]);
      // verify-asset binds each *local final byte sequence* to GitHub's release
      // attestation, in addition to the separate freshly downloaded hash above.
        for (const asset of plan.assets) command(spawn, "gh", ["release", "verify-asset", plan.source.tag, resolve(asset.path), "--repo", REPOSITORY]);
        attested.add(release.id);
      }
    }
    return { status: release.draft ? "draft" : "matches", release, assets };
  };
  return {
    github,
    async createDraft(prepared) {
      const { plan } = prepared; await verifyFile(plan.notes);
      const currentSource = verifyReleaseManifestSourceProvenance({ repository: plan.source.repository, commit: plan.source.commit, tag: plan.source.tag }, { channel: plan.channel, expectedVersion: plan.version, repositoryRoot });
      if (currentSource.tagObject !== plan.source.tagObject) fail("RELEASE_PUBLICATION_TAG_CHANGED");
      admitDraft(plan);
      const body = await readFile(plan.notes.path, "utf8");
      if (digest(body) !== plan.notes.sha256) fail("RELEASE_PUBLICATION_FILE_CHANGED");
      api(`repos/${REPOSITORY}/releases`, { method: "POST", body: { tag_name: plan.source.tag, target_commitish: plan.source.commit, name: `TiboTattle ${plan.version}`, body, draft: true, prerelease: false, make_latest: "false" } });
    },
    async uploadAsset(prepared, name) {
      const asset = prepared.plan.assets.find((entry) => entry.name === name); await verifyFile(asset);
      if (basename(asset.path) !== name) fail("RELEASE_PUBLICATION_ASSET_FILENAME_MISMATCH");
      command(spawn, "gh", ["release", "upload", prepared.plan.source.tag, resolve(asset.path), "--repo", REPOSITORY], { timeout: 600_000 });
    },
    async publishDraft(prepared, release) {
      const { plan } = prepared;
      for (const asset of plan.assets) await verifyFile(asset);
      const currentSource = verifyReleaseManifestSourceProvenance({ repository: plan.source.repository, commit: plan.source.commit, tag: plan.source.tag }, { channel: plan.channel, expectedVersion: plan.version, repositoryRoot });
      if (currentSource.tagObject !== plan.source.tagObject) fail("RELEASE_PUBLICATION_TAG_CHANGED");
      admitDraft(plan);
      api(`repos/${REPOSITORY}/releases/${release.id}`, { method: "PATCH", body: { draft: false, make_latest: "true" } });
    },
    async feed(prepared, architecture) {
      const { prepared: publication, target } = prepared.feeds[architecture];
      const expected = prepared.plan.assets.find((asset) => asset.name === target.appcastName);
      const actual = await publicBytes(publication.appcast.url, MAX_SMALL, true);
      if (!actual || actual.sha256 !== expected.sha256) {
        // Never replace different bytes carrying this exact bundle version.
        if (actual?.text.includes(`<sparkle:version>${prepared.plan.build}</sparkle:version>`) || actual?.text.includes(`sparkle:version="${prepared.plan.build}"`)) fail("RELEASE_PUBLICATION_FEED_SAME_BUILD_CONFLICT");
        return { status: "pending" };
      }
      for (const object of [publication.artifact, { ...publication.manifest, url: `${DEPLOYMENT_ENDPOINTS.sparkle.origin}/${publication.manifest.key}` }]) {
        const found = await publicBytes(object.url, MAX_BYTES);
        if (!found || found.sha256 !== object.sha256 || found.bytes !== object.bytes) fail("RELEASE_PUBLICATION_FEED_OBJECT_MISMATCH");
      }
      return { status: "matches" };
    },
    async publishFeed(prepared, architecture) {
      const options = prepared.feeds[architecture].options;
      const target = prepared.feeds[architecture].target;
      for (const name of [target.dmgName, target.appcastName]) await verifyFile(prepared.plan.assets.find((asset) => asset.name === name));
      await verifyFile(target.previousManifest); await verifyFile(target.feedManifest);
      if (target.sparkleDmg) await verifyFile(target.sparkleDmg);
      const channel = resolveReleaseChannel("stable", { architecture });
      // Consume once on the first authorized write. Both architectures use the
      // same owner guard; its credential stays private and absent from children.
      appcastGuard ??= createAppcastAtomicGuardFromEnvironment({
        channel: "stable", architecture, endpoint: channel.sparkle.atomicGuardURL,
        fetchGuard: fetchImpl,
      });
      return publishFeed({ ...options, publish: true, replaceAppcast: true,
        atomicAppcastGuard: appcastGuard });
    },
    async tap(prepared) {
      // GitHub contents API, not potentially stale raw.githubusercontent.com.
      const current = api(`repos/${TAP}/contents/Casks/tibotattle.rb?ref=main`);
      if (!current || current.encoding !== "base64" || typeof current.content !== "string") fail("RELEASE_PUBLICATION_TAP_UNAVAILABLE");
      const bytes = Buffer.from(current.content, "base64");
      return { status: digest(bytes) === prepared.plan.tap.sha256 && bytes.length === prepared.plan.tap.bytes ? "matches" : "pending" };
    },
    async publishTap(prepared) {
      const latest = api(`repos/${REPOSITORY}/releases/latest`);
      if (latest?.tag_name !== prepared.plan.source.tag || latest.draft || latest.prerelease) fail("RELEASE_PUBLICATION_TAP_LATEST_CHANGED");
      const workflow = api(`repos/${TAP}/contents/.github/workflows/update-tibotattle.yml?ref=main`);
      if (workflow?.encoding !== "base64" || digest(Buffer.from(workflow.content, "base64")) !== prepared.plan.tap.workflowSha256) fail("RELEASE_PUBLICATION_TAP_WORKFLOW_CHANGED");
      // Reuse the tap's reviewed dual-architecture updater and its own gates.
      api(`repos/${TAP}/actions/workflows/update-tibotattle.yml/dispatches`, { method: "POST", body: { ref: "main" } });
    },
    async website(prepared) {
      const matches = async (file) => {
        const actual = await publicBytes(file.url);
        return actual && actual.sha256 === file.sha256 && actual.bytes === file.bytes;
      };
      if (!await matches({ ...prepared.plan.website.manifest, url: `${DEPLOYMENT_ENDPOINTS.public.origin}/release-site-manifest.json` })) return { status: "pending" };
      // Keep CDN reads bounded without paying one round trip per small asset.
      for (let start = 0; start < prepared.siteFiles.length; start += 4) {
        if (!(await Promise.all(prepared.siteFiles.slice(start, start + 4).map(matches))).every(Boolean)) return { status: "pending" };
      }
      const health = await recheckProductionHealth({ fetchImpl });
      if (!health.ok || health.sourceCommit !== prepared.websiteSourceCommit) return { status: "pending" };
      return { status: "matches" };
    },
    async publishWebsite(prepared) {
      await verifyFile(prepared.plan.website.receipt); await verifyFile(prepared.plan.website.manifest);
      for (const file of prepared.siteFiles) await verifyFile({ ...file, path: join(dirname(prepared.plan.website.manifest.path), file.path) });
      const result = await deploySite({ repositoryRoot: prepared.plan.website.repositoryRoot,
        receiptPath: prepared.plan.website.receipt.path, confirmation: PRODUCTION_DEPLOY_CONFIRMATION });
      if (result.deployment?.ok !== true) fail("RELEASE_PUBLICATION_WEBSITE_DEPLOYMENT_UNVERIFIED");
    },
    coordination: () => createProductionDeploymentLock({ repositoryRoot, spawn }),
  };
}

async function inspect(prepared, adapters, { fresh = false } = {}) {
  const surfaces = {};
  for (const [name, read] of [
    ["github", () => adapters.github(prepared, { fresh })], ["feed-arm64", () => adapters.feed(prepared, "arm64")],
    ["feed-x64", () => adapters.feed(prepared, "x64")], ["tap", () => adapters.tap(prepared)], ["website", () => adapters.website(prepared)],
  ]) {
    try { surfaces[name] = { status: (await read()).status }; }
    catch (error) { surfaces[name] = { status: "blocked", code: safeCode(error) }; }
  }
  return surfaces;
}
function safeCode(error) { return /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code) ? error.code : "RELEASE_PUBLICATION_CHECK_FAILED"; }
const MUTATION_FAILURE_CODES = new Set([
  "SPARKLE_UPDATE_ATOMIC_GUARD_TOKEN_REQUIRED", "SPARKLE_UPDATE_ATOMIC_GUARD_REMOTE_FAILED",
  "SPARKLE_UPDATE_ATOMIC_GUARD_FAILED", "SPARKLE_UPDATE_APPCAST_ATOMIC_CONFLICT",
  "SPARKLE_UPDATE_APPCAST_STATE_CHANGED", "SPARKLE_UPDATE_WRANGLER_FAILED",
  "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED", "SPARKLE_UPDATE_IMMUTABLE_OBJECT_MISMATCH",
  "SPARKLE_UPDATE_SOURCE_CHANGED", "RELEASE_PUBLICATION_LOCAL_BYTES_MISMATCH",
]);
function mutationFailure(step, error) {
  return { step, code: MUTATION_FAILURE_CODES.has(error?.code) ? error.code : "RELEASE_PUBLICATION_MUTATION_FAILED" };
}

export async function reconcilePublication({ plan, repositoryRoot = ROOT, apply = false, confirmation = null, expectedPlanDigest = null,
  operationDirectory = null, resume = false, executorStopped = false, adapters = createPublicationAdapters({ repositoryRoot }), prepare = preparePublication } = {}) {
  const prepared = await prepare(plan, { repositoryRoot });
  const planDigest = identityDigest(prepared.plan);
  let surfaces = await inspect(prepared, adapters);
  let lastMutationFailure;
  const result = (extra = {}) => ({ schemaVersion: 1, planDigest, sourceCommit: prepared.plan.source.commit,
    tag: prepared.plan.source.tag, channel: prepared.plan.channel, version: prepared.plan.version, build: prepared.plan.build,
    surfaces, complete: Object.values(surfaces).every((surface) => surface.status === "matches"),
    ...(lastMutationFailure ? { mutationFailure: lastMutationFailure } : {}), ...extra });
  if (!apply) return result({ mode: "inspect", writesAttempted: false });
  if (confirmation !== PUBLICATION_CONFIRMATION || expectedPlanDigest !== planDigest || !operationDirectory) fail("RELEASE_PUBLICATION_EXPLICIT_AUTHORIZATION_REQUIRED");
  if (resume && !executorStopped) fail("RELEASE_PUBLICATION_EXECUTOR_STOP_CONFIRMATION_REQUIRED");
  if (Object.values(surfaces).some((surface) => surface.status === "blocked")) return result({ mode: "apply", writesAttempted: false, code: "RELEASE_PUBLICATION_PREFLIGHT_BLOCKED" });
  // An already matching release is a pure read even when --apply was supplied.
  if (!resume && Object.values(surfaces).every((surface) => surface.status === "matches")) return result({ mode: "apply", writesAttempted: false });
  const operation = await openOperation({ directory: operationDirectory, kind: "publication", binding: prepared.plan, resume });
  let state = operation.record.state;
  let writesAttempted = false;
  const coordination = adapters.coordination();
  const save = async () => operation.save(state);
  const requireOwner = () => coordination.assertOwned(state.owner);
  const transition = async (name, observed, mutate) => {
    requireOwner();
    if (await observed()) { state.steps[name] = "verified"; await save(); return; }
    if (state.steps[name]) fail(state.steps[name] === "submitted" ? "RELEASE_PUBLICATION_REMOTE_PENDING" : "RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED");
    state.steps[name] = "intent"; await save(); writesAttempted = true;
    try { await mutate(); state.steps[name] = "submitted"; await save(); }
    catch (error) { lastMutationFailure = mutationFailure(name, error); }
    requireOwner();
    if (!await observed()) fail(state.steps[name] === "submitted" ? "RELEASE_PUBLICATION_REMOTE_PENDING" : "RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED");
    state.steps[name] = "verified"; await save();
  };
  try {
    if (!resume) {
      const owner = coordination.createOwner({ id: operation.record.id, sourceCommit: prepared.plan.source.commit, previousSourceCommit: prepared.plan.source.commit });
      state = { owner, lock: "pending", steps: {}, planDigest };
      await save(); coordination.acquire(owner); state.lock = "held"; await save();
    } else {
      if (!exact(state, ["owner", "lock", "steps", "planDigest"]) || state.planDigest !== planDigest || !COMMIT.test(state.owner)
          || !["pending", "held", "released"].includes(state.lock) || !state.steps || Array.isArray(state.steps)
          || Object.entries(state.steps).some(([key, value]) => !["draft", "publish", "feed-arm64", "feed-x64", "tap", "website", ...prepared.plan.assets.map((asset) => `asset:${asset.name}`)].includes(key) || !["intent", "submitted", "verified"].includes(value))) fail("RELEASE_PUBLICATION_JOURNAL_INVALID");
      // With explicit stopped-executor confirmation, an absent ref can be
      // reacquired even if a crash occurred between releasing it and saving
      // the journal. Outstanding intents still cannot replay uncertain writes.
      const currentOwner = coordination.status();
      if (currentOwner === null) coordination.acquire(state.owner);
      else requireOwner();
      state.lock = "held"; await save();
    }
    await transition("draft", async () => (await adapters.github(prepared)).release !== null, () => adapters.createDraft(prepared));
    for (const asset of prepared.plan.assets) await transition(`asset:${asset.name}`, async () => (await adapters.github(prepared)).assets.some((entry) => entry.name === asset.name), () => adapters.uploadAsset(prepared, asset.name));
    await transition("publish", async () => (await adapters.github(prepared)).status === "matches", async () => {
      const draft = await adapters.github(prepared);
      if (draft.status !== "draft" || draft.assets.length !== prepared.plan.assets.length) fail("RELEASE_PUBLICATION_DRAFT_NOT_VERIFIED");
      await adapters.publishDraft(prepared, draft.release);
    });
    for (const architecture of ["arm64", "x64"]) await transition(`feed-${architecture}`, async () => (await adapters.feed(prepared, architecture)).status === "matches", () => adapters.publishFeed(prepared, architecture));
    // A dispatched workflow may finish after this process exits. Never dispatch
    // twice merely because its first asynchronous response was inconclusive.
    await transition("tap", async () => (await adapters.tap(prepared)).status === "matches", () => adapters.publishTap(prepared));
    requireOwner();
    // The website wrapper must acquire the same shared lock itself and retain
    // its own uncertain deployment journal. Do not recursively acquire it.
    coordination.release(state.owner); state.lock = "released"; await save();
    if ((await adapters.website(prepared)).status !== "matches") {
      if (state.steps.website) fail("RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED");
      state.steps.website = "intent"; await save(); writesAttempted = true;
      try { await adapters.publishWebsite(prepared); }
      catch (error) { lastMutationFailure = mutationFailure("website", error); }
      if ((await adapters.website(prepared)).status !== "matches") fail("RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED");
    }
    state.steps.website = "verified"; await save();
    surfaces = await inspect(prepared, adapters, { fresh: true });
    return result({ mode: "apply", writesAttempted, coordination: state.lock });
  } catch (error) {
    surfaces = await inspect(prepared, adapters);
    return result({ mode: "apply", writesAttempted, complete: false, code: safeCode(error), coordination: state.lock });
  } finally { operation.close(); }
}

export function parsePublicationArguments(argv) {
  const options = { apply: false, resume: false, executorStopped: false };
  const values = new Map([["--plan", "planPath"], ["--operation", "operationDirectory"], ["--confirm", "confirmation"], ["--plan-digest", "expectedPlanDigest"]]);
  const booleans = new Map([["--apply", "apply"], ["--resume", "resume"], ["--executor-stopped", "executorStopped"]]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail("RELEASE_PUBLICATION_ARGUMENT_INVALID"); seen.add(flag);
    if (booleans.has(flag)) options[booleans.get(flag)] = true;
    else if (values.has(flag) && argv[index + 1] && !argv[index + 1].startsWith("--")) options[values.get(flag)] = argv[++index];
    else fail("RELEASE_PUBLICATION_ARGUMENT_INVALID");
  }
  if (!options.planPath || (!options.apply && (options.resume || options.executorStopped || options.confirmation || options.operationDirectory || options.expectedPlanDigest))) fail("RELEASE_PUBLICATION_ARGUMENT_INVALID");
  return options;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { planPath, ...options } = parsePublicationArguments(process.argv.slice(2));
    const metadata = await lstat(planPath);
    if (!metadata.isFile() || metadata.size > MAX_SMALL) fail("RELEASE_PUBLICATION_PLAN_INVALID");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const result = await reconcilePublication({ plan, ...options });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.complete ? 0 : 1;
  } catch (error) { process.stderr.write(`${safeCode(error)}\n`); process.exitCode = 1; }
}
