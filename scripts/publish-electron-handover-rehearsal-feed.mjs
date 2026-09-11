#!/usr/bin/env node
/**
 * Publishes only the closed native-to-Electron handover rehearsal feed.
 * It defaults to local validation. Wrangler has no conditional R2 put, so a
 * real publish requires an operator's explicit exclusive-control assertion and
 * validates the mutable YAML immediately before and after its unconditional put.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const WRANGLER_PATH = join(REPOSITORY_ROOT, "apps", "worker", "node_modules", ".bin", "wrangler");
export const HANDOVER_SOURCE_REVISION = "c938a654137357f3403898e8758e317cf4058193";
export const HANDOVER_PREFIX = "electron/rehearsal/native-to-electron-handover-v1";
export const HANDOVER_CHANNEL = "native-to-electron-handover-rehearsal-v1";
export const TARGETS = Object.freeze(["darwin-arm64", "darwin-x64"]);
export const CURRENT_VERSION = "0.1.19-native-to-electron-handover.11";
export const NEXT_VERSION = "0.1.19-native-to-electron-handover.12";
export const CORRECTED_HANDOVER_SOURCE_REVISION = "9be7da8d2b84f41693b65d982b61ffa71507201c";
export const CORRECTED_CURRENT_VERSION = "0.1.19-native-to-electron-handover.13";
export const CORRECTED_NEXT_VERSION = "0.1.19-native-to-electron-handover.14";
export const FOLLOW_UP_HANDOVER_SOURCE_REVISION = "dcf2d6caddbcded88dcadfe6c52282a6cd21afb5";
export const FOLLOW_UP_CURRENT_VERSION = "0.1.19-native-to-electron-handover.15";
export const FOLLOW_UP_NEXT_VERSION = "0.1.19-native-to-electron-handover.16";
export const QUALIFIED_HANDOVER_SOURCE_REVISION = "7293828ade187f6fd9e50c67d7018704150ca156";
export const QUALIFIED_CURRENT_VERSION = "0.1.19-native-to-electron-handover.17";
export const QUALIFIED_NEXT_VERSION = "0.1.19-native-to-electron-handover.18";
const PROPOSAL_SCHEMA = "tibotattle-private-updater-publication-proposal-v1";
// A successor family retains this same proposal shape. Its source revision and
// statically selected predecessor family remain the closed authority.
const PREDECESSOR_PROPOSAL_SCHEMA = "tibotattle-private-updater-publication-proposal-v2";
const LEGACY_FAMILY = Object.freeze({
  id: "c938a654-11-12",
  sourceRevision: HANDOVER_SOURCE_REVISION,
  schema: PROPOSAL_SCHEMA,
  currentVersion: CURRENT_VERSION,
  nextVersion: NEXT_VERSION,
  predecessorFamily: null,
  predecessorStates: Object.freeze([]),
});
const CORRECTED_FAMILY = Object.freeze({
  id: "9be7da8d-13-14",
  sourceRevision: CORRECTED_HANDOVER_SOURCE_REVISION,
  schema: PREDECESSOR_PROPOSAL_SCHEMA,
  currentVersion: CORRECTED_CURRENT_VERSION,
  nextVersion: CORRECTED_NEXT_VERSION,
  predecessorFamily: LEGACY_FAMILY,
  predecessorStates: Object.freeze(["rollback", "advance"]),
});
const FOLLOW_UP_FAMILY = Object.freeze({
  id: "dcf2d6ca-15-16",
  sourceRevision: FOLLOW_UP_HANDOVER_SOURCE_REVISION,
  schema: PREDECESSOR_PROPOSAL_SCHEMA,
  currentVersion: FOLLOW_UP_CURRENT_VERSION,
  nextVersion: FOLLOW_UP_NEXT_VERSION,
  // The corrected .14 advance is the only allowed remote predecessor. A
  // completed corrected rollback leaves .13 in the feed and cannot start this
  // family.
  predecessorFamily: CORRECTED_FAMILY,
  predecessorStates: Object.freeze(["advance"]),
});
const QUALIFIED_FAMILY = Object.freeze({
  id: "7293828a-17-18",
  sourceRevision: QUALIFIED_HANDOVER_SOURCE_REVISION,
  schema: PREDECESSOR_PROPOSAL_SCHEMA,
  currentVersion: QUALIFIED_CURRENT_VERSION,
  nextVersion: QUALIFIED_NEXT_VERSION,
  // A completed .16 advance preserves the entire validated predecessor chain.
  predecessorFamily: FOLLOW_UP_FAMILY,
  predecessorStates: Object.freeze(["advance"]),
});
const FAMILIES = Object.freeze([LEGACY_FAMILY, CORRECTED_FAMILY, FOLLOW_UP_FAMILY, QUALIFIED_FAMILY]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const FEED_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const MISSING_PATTERN = /the specified key does not exist|no such key|nosuchkey|object not found/iu;

function fail(message, code = "ELECTRON_HANDOVER_FEED_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha512(bytes) { return createHash("sha512").update(bytes).digest("base64"); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, keys) { return plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function safeHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function safeRelativePath(value) { return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.split("/").includes("..") && !value.startsWith("/") && !value.includes("\0"); }
function safeObjectKey(value) { return safeRelativePath(value) && value.startsWith(`${HANDOVER_PREFIX}/`) && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,300}$/u.test(value); }
function sameBytes(left, right) { return left !== null && right !== null && left.length === right.length && left.equals(right); }

async function regularFile(path, maximumBytes, label) {
  let entry;
  try { entry = await lstat(path); } catch { fail(`${label} is unavailable`, "ELECTRON_HANDOVER_FEED_LOCAL_FILE_INVALID"); }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > maximumBytes) {
    fail(`${label} is not a safe regular file`, "ELECTRON_HANDOVER_FEED_LOCAL_FILE_INVALID");
  }
  return entry;
}
async function under(root, localPath, maximumBytes, label) {
  if (!safeRelativePath(localPath)) fail(`${label} local path is invalid`);
  const rootReal = await realpath(root).catch(() => fail("artifact root is unavailable"));
  const candidate = resolve(rootReal, localPath);
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${sep}`)) fail(`${label} escapes artifact root`);
  await regularFile(candidate, maximumBytes, label);
  const real = await realpath(candidate).catch(() => fail(`${label} cannot be resolved`));
  if (real !== candidate) fail(`${label} resolves outside its named path`);
  return real;
}
async function bytesAt(root, localPath, maximumBytes, label) {
  const path = await under(root, localPath, maximumBytes, label);
  const bytes = await readFile(path);
  return Object.freeze({ path, bytes, bytesLength: bytes.length, sha256: sha256(bytes) });
}
function parseManifest(bytes, version, expectedObjects) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || bytes.includes(0)) fail("updater manifest is not canonical UTF-8 text");
  const actualVersion = text.match(/^version: ([^\r\n]+)$/mu)?.[1];
  const path = text.match(/^path: ([^\r\n]+)$/mu)?.[1];
  const topHash = text.match(/^sha512: ([A-Za-z0-9+/]+={0,2})$/mu)?.[1];
  const fileMatches = [...text.matchAll(/^  - url: ([^\r\n]+)\n    sha512: ([A-Za-z0-9+/]+={0,2})\n    size: ([0-9]+)$/gmu)];
  if (actualVersion !== version || !path || !topHash || fileMatches.length !== expectedObjects.length) fail("updater manifest does not match the closed candidate");
  const entries = fileMatches.map((match) => ({ name: match[1], sha512: match[2], bytes: Number(match[3]) }));
  if (!Number.isSafeInteger(entries[0]?.bytes) || path !== entries[0]?.name || topHash !== entries[0]?.sha512) fail("updater manifest primary entry is invalid");
  const expected = new Map(expectedObjects.map((object) => [basename(object.objectKey), object]));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) fail("updater manifest repeats a file");
  for (const entry of entries) {
    const object = expected.get(entry.name);
    if (!object || object.bytes !== entry.bytes || object.sha512 !== entry.sha512) fail("updater manifest artifact binding is invalid");
  }
}
function expectedName(version, target, extension) {
  return `TiboTattle-${version}-mac-${target.slice("darwin-".length)}.${extension}`;
}
function parseReceipt(receipt, { family, kind, objects, target, version }) {
  if (!plain(receipt) || receipt.sourceRevision !== family.sourceRevision || receipt.version !== version
      || receipt.target !== target || receipt.candidate !== kind
      || !plain(receipt.checks) || Object.values(receipt.checks).length === 0 || !Object.values(receipt.checks).every((value) => value === true)
      || !exactKeys(receipt.artifacts, ["dmg", "zip"])) {
    fail("finalization receipt is not an accepted closed candidate", "ELECTRON_HANDOVER_FEED_RECEIPT_INVALID");
  }
  for (const [extension, primaryForUpdater] of [["zip", true], ["dmg", false]]) {
    const artifact = receipt.artifacts[extension];
    const object = objects.find((item) => item.primaryForUpdater === primaryForUpdater);
    if (!exactKeys(artifact, ["file", "bytes", "sha256"])
        || artifact.file !== expectedName(version, target, extension)
        || artifact.file !== basename(object?.objectKey ?? "")
        || artifact.bytes !== object?.bytes || artifact.sha256 !== object?.sha256) {
      fail("finalization receipt artifact binding is invalid", "ELECTRON_HANDOVER_FEED_RECEIPT_INVALID");
    }
  }
}
async function candidate(root, input, target, kind, family) {
  if (!exactKeys(input, ["version", "finalizationReceipt", "finalizationChecksAllTrue", "manifest", "objects"]) || input.version !== (kind === "current" ? family.currentVersion : family.nextVersion)
      || input.finalizationChecksAllTrue !== true || !Array.isArray(input.objects) || input.objects.length !== 2) fail(`${target} ${kind} proposal shape is invalid`);
  const receiptBytes = await bytesAt(root, input.finalizationReceipt, MAX_MANIFEST_BYTES, `${target} receipt`);
  let receipt; try { receipt = JSON.parse(receiptBytes.bytes.toString("utf8")); } catch { fail(`${target} receipt is invalid`); }
  if (!exactKeys(input.manifest, ["localPath", "objectKey", "sha256", "bytes"]) || input.manifest.objectKey !== `${HANDOVER_PREFIX}/${target}/native-to-electron-handover-mac.yml` || !safeHash(input.manifest.sha256) || !Number.isSafeInteger(input.manifest.bytes)) fail(`${target} manifest binding is invalid`);
  const manifest = await bytesAt(root, input.manifest.localPath, MAX_MANIFEST_BYTES, `${target} manifest`);
  if (manifest.sha256 !== input.manifest.sha256 || manifest.bytesLength !== input.manifest.bytes) fail(`${target} manifest changed after proposal`);
  const objects = [];
  for (const inputObject of input.objects) {
    if (!exactKeys(inputObject, ["localPath", "objectKey", "sha256", "bytes", "primaryForUpdater"])
        || !safeObjectKey(inputObject.objectKey) || !safeHash(inputObject.sha256) || !Number.isSafeInteger(inputObject.bytes)
        || typeof inputObject.primaryForUpdater !== "boolean") fail(`${target} artifact binding is invalid`);
    const extension = inputObject.primaryForUpdater ? "zip" : "dmg";
    if (inputObject.objectKey !== `${HANDOVER_PREFIX}/${target}/${expectedName(input.version, target, extension)}`) fail(`${target} artifact filename is not the closed candidate filename`);
    const read = await bytesAt(root, inputObject.localPath, MAX_ARTIFACT_BYTES, `${target} artifact`);
    if (read.sha256 !== inputObject.sha256 || read.bytesLength !== inputObject.bytes) fail(`${target} artifact changed after proposal`);
    objects.push(Object.freeze({ ...inputObject, path: read.path, sha512: sha512(read.bytes) }));
  }
  if (new Set(objects.map((object) => object.objectKey)).size !== objects.length || objects.filter((object) => object.primaryForUpdater).length !== 1) fail(`${target} artifact set is invalid`);
  parseReceipt(receipt, { family, kind, objects, target, version: input.version });
  parseManifest(manifest.bytes, input.version, objects);
  return Object.freeze({ version: input.version, receipt: receiptBytes, manifest: Object.freeze({ ...input.manifest, ...manifest }), objects: Object.freeze(objects) });
}

function proposalFamily(proposal) {
  const family = FAMILIES.find((item) => (
    proposal?.schema === item.schema && proposal?.sourceRevision === item.sourceRevision
  ));
  if (family !== undefined) return family;
  fail("proposal is not an accepted closed candidate family");
}

async function predecessorForFamily(root, predecessor, family) {
  const predecessorFamily = family.predecessorFamily;
  if (!exactKeys(predecessor, ["state", "proposal", "publicationReceipt"])
      || predecessorFamily === null || !family.predecessorStates.includes(predecessor.state)
      || !exactKeys(predecessor.proposal, ["localPath", "sha256"])
      || !exactKeys(predecessor.publicationReceipt, ["localPath", "sha256"])
      || !safeHash(predecessor.proposal.sha256) || !safeHash(predecessor.publicationReceipt.sha256)) {
    fail("bound predecessor proof is invalid", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  }
  const proposalBytes = await bytesAt(root, predecessor.proposal.localPath, MAX_MANIFEST_BYTES, "predecessor proposal");
  if (proposalBytes.sha256 !== predecessor.proposal.sha256) fail("predecessor proposal changed after binding", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  let predecessorProposal;
  try { predecessorProposal = JSON.parse(proposalBytes.bytes.toString("utf8")); } catch { fail("predecessor proposal is invalid", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID"); }
  let validatedPredecessor;
  try {
    validatedPredecessor = await validateProposal(root, predecessorProposal, predecessorFamily);
  } catch {
    fail("predecessor proposal is outside the closed history", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  }
  const receiptBytes = await bytesAt(root, predecessor.publicationReceipt.localPath, MAX_MANIFEST_BYTES, "predecessor publication receipt");
  if (receiptBytes.sha256 !== predecessor.publicationReceipt.sha256) fail("predecessor publication receipt changed after binding", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  let receipt;
  try { receipt = JSON.parse(receiptBytes.bytes.toString("utf8")); } catch { fail("predecessor publication receipt is invalid", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID"); }
  const expected = predecessor.state === "rollback"
    ? Object.fromEntries(TARGETS.map((target) => [target, validatedPredecessor.targets[target].current.manifest]))
    : Object.fromEntries(TARGETS.map((target) => [target, validatedPredecessor.targets[target].next.manifest]));
  const expectedImmutableKeys = Object.fromEntries(TARGETS.map((target) => [target,
    (predecessor.state === "rollback" ? validatedPredecessor.targets[target].current.objects : validatedPredecessor.targets[target].next.objects)
      .map((object) => object.objectKey),
  ]));
  if (!exactKeys(receipt, ["schema", "sourceRevision", "stage", "bucket", "status", "mutation", "targets"])
      || receipt.schema !== "tibotattle-electron-handover-feed-publication-receipt-v1"
      || receipt.sourceRevision !== predecessorFamily.sourceRevision || receipt.stage !== predecessor.state
      || receipt.status !== "completed" || receipt.bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket
      || receipt.mutation !== "wrangler-unconditional-put-with-exclusive-control-pre-post-readback"
      || !plain(receipt.targets) || Reflect.ownKeys(receipt.targets).length !== TARGETS.length) {
    fail("predecessor publication receipt is outside the closed history", "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  }
  for (const target of TARGETS) {
    const item = receipt.targets[target];
    if (!exactKeys(item, ["feedKey", "feedSha256", "immutableKeys", "phase"])
        || !Array.isArray(item.immutableKeys) || item.immutableKeys.length !== expectedImmutableKeys[target].length
        || item.immutableKeys.some((key, index) => key !== expectedImmutableKeys[target][index])
        || item.feedKey !== expected[target].objectKey || item.feedSha256 !== expected[target].sha256
        || item.phase !== "feed_readback_passed") fail(`${target} predecessor receipt does not bind the selected state`, "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID");
  }
  return Object.freeze({ state: predecessor.state, targets: Object.freeze(expected) });
}

async function validateProposal(root, proposal, family = proposalFamily(proposal)) {
  const expectedKeys = family.predecessorFamily !== null
    ? ["schema", "disposition", "sourceRevision", "r2Bucket", "publicOrigin", "feedPrefix", "channel", "privacy", "predecessor", "initialPublication", "feedAdvance", "rollback", "stableMustRemainUntouched"]
    : ["schema", "disposition", "sourceRevision", "r2Bucket", "publicOrigin", "feedPrefix", "channel", "privacy", "initialPublication", "feedAdvance", "rollback", "stableMustRemainUntouched"];
  if (!exactKeys(proposal, expectedKeys) || proposal.schema !== family.schema || proposal.disposition !== "proposal-only-no-network-write"
      || proposal.sourceRevision !== family.sourceRevision || proposal.r2Bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket
      || proposal.publicOrigin !== "https://updates.tibotattle.com" || proposal.feedPrefix !== HANDOVER_PREFIX || proposal.channel !== HANDOVER_CHANNEL
      || !Array.isArray(proposal.stableMustRemainUntouched) || proposal.stableMustRemainUntouched.join("|") !== "electron/stable/**|appcast.xml|intel/appcast.xml|preview/**") fail("proposal is outside the closed rehearsal policy");
  const predecessor = family.predecessorFamily !== null
    ? await predecessorForFamily(root, proposal.predecessor, family)
    : null;
  const resolved = {};
  for (const target of TARGETS) {
    const current = await candidate(root, proposal.initialPublication?.[target], target, "current", family);
    const advance = proposal.feedAdvance?.[target];
    const rollback = proposal.rollback?.[target];
    if (!exactKeys(advance, ["prepositionImmutableObjects", "replaceOnlyManifest", "expectedPreviousManifestSha256"])
        || !Array.isArray(advance.prepositionImmutableObjects) || advance.expectedPreviousManifestSha256 !== current.manifest.sha256) fail(`${target} advance policy is invalid`);
    const next = await candidate(root, { ...proposal.initialPublication[target], version: family.nextVersion, finalizationReceipt: `${dirname(advance.replaceOnlyManifest.localPath)}/production-finalization-receipt.json`, finalizationChecksAllTrue: true, manifest: advance.replaceOnlyManifest, objects: advance.prepositionImmutableObjects }, target, "next", family);
    if (!exactKeys(rollback, ["restoreOnlyManifest", "expectedCurrentManifestSha256", "retainImmutableObjects"]) || rollback.expectedCurrentManifestSha256 !== next.manifest.sha256 || rollback.retainImmutableObjects !== true) fail(`${target} rollback policy is invalid`);
    const rollbackBytes = await bytesAt(root, rollback.restoreOnlyManifest.localPath, MAX_MANIFEST_BYTES, `${target} rollback manifest`);
    if (rollback.restoreOnlyManifest.objectKey !== current.manifest.objectKey || rollbackBytes.sha256 !== current.manifest.sha256 || rollbackBytes.bytesLength !== current.manifest.bytesLength) fail(`${target} rollback bytes do not match current manifest`);
    resolved[target] = Object.freeze({ current, next, rollback: Object.freeze({ ...rollback.restoreOnlyManifest, ...rollbackBytes }), predecessor: predecessor?.targets[target] ?? null });
  }
  if (Reflect.ownKeys(proposal.initialPublication).length !== TARGETS.length || Reflect.ownKeys(proposal.feedAdvance).length !== TARGETS.length || Reflect.ownKeys(proposal.rollback).length !== TARGETS.length) fail("proposal target set is not closed");
  return Object.freeze({ family, bucket: proposal.r2Bucket, targets: Object.freeze(resolved) });
}

export async function validateHandoverFeedProposal({ artifactRoot, proposalPath } = {}) {
  if (typeof artifactRoot !== "string" || typeof proposalPath !== "string") fail("--artifact-root and --proposal are required");
  const root = await realpath(resolve(artifactRoot)).catch(() => fail("artifact root is unavailable"));
  const proposalFile = resolve(proposalPath);
  await regularFile(proposalFile, MAX_MANIFEST_BYTES, "proposal");
  const proposalReal = await realpath(proposalFile).catch(() => fail("proposal cannot be resolved"));
  let proposal; try { proposal = JSON.parse(await readFile(proposalReal, "utf8")); } catch { fail("proposal JSON is invalid"); }
  const validated = await validateProposal(root, proposal);
  return Object.freeze({ artifactRoot: root, proposalPath: proposalReal, ...validated });
}

function defaultRunWrangler(arguments_) {
  const result = spawnSync(WRANGLER_PATH, arguments_, { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 });
  return Object.freeze({ status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") });
}
function missing(result) { return result.status !== 0 && MISSING_PATTERN.test(`${result.stdout}\n${result.stderr}`); }
async function remoteObject({ bucket, key, maximumBytes, runWrangler, temporaryRoot }) {
  const output = join(temporaryRoot, sha256(Buffer.from(key)));
  const result = await runWrangler(["r2", "object", "get", `${bucket}/${key}`, "--file", output, "--remote"]);
  if (result.status !== 0) { if (missing(result)) return null; fail(`R2 read failed for ${key}`, "ELECTRON_HANDOVER_FEED_R2_READ_FAILED"); }
  await regularFile(output, maximumBytes, `R2 object ${key}`);
  const bytes = await readFile(output);
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}
async function putRemoteObject({ bucket, cacheControl, contentType, key, localPath, runWrangler }) {
  const result = await runWrangler(["r2", "object", "put", `${bucket}/${key}`, "--file", localPath, "--content-type", contentType, "--cache-control", cacheControl, "--remote"]);
  if (result.status !== 0) fail(`R2 write failed for ${key}`, "ELECTRON_HANDOVER_FEED_R2_WRITE_FAILED");
}
function artifactType(key) { return key.endsWith(".zip") ? "application/zip" : "application/x-apple-diskimage"; }
async function ensureImmutable({ bucket, object, runWrangler, temporaryRoot }) {
  const before = await remoteObject({ bucket, key: object.objectKey, maximumBytes: MAX_ARTIFACT_BYTES, runWrangler, temporaryRoot });
  if (before !== null && before.sha256 !== object.sha256) fail(`immutable object already differs: ${object.objectKey}`, "ELECTRON_HANDOVER_FEED_IMMUTABLE_CONFLICT");
  if (before === null) await putRemoteObject({ bucket, key: object.objectKey, localPath: object.path, contentType: artifactType(object.objectKey), cacheControl: IMMUTABLE_CACHE_CONTROL, runWrangler });
  const after = await remoteObject({ bucket, key: object.objectKey, maximumBytes: MAX_ARTIFACT_BYTES, runWrangler, temporaryRoot });
  if (after === null || after.sha256 !== object.sha256) fail(`immutable object readback differs: ${object.objectKey}`, "ELECTRON_HANDOVER_FEED_READBACK_FAILED");
}
async function writeFeed({ bucket, expected, next, runWrangler, temporaryRoot }) {
  const before = await remoteObject({ bucket, key: next.objectKey, maximumBytes: MAX_MANIFEST_BYTES, runWrangler, temporaryRoot });
  if (!(expected === null ? before === null : sameBytes(before?.bytes ?? null, expected))) fail(`feed changed before replacement: ${next.objectKey}`, "ELECTRON_HANDOVER_FEED_FEED_CONFLICT");
  await putRemoteObject({ bucket, key: next.objectKey, localPath: next.path, contentType: "text/yaml; charset=utf-8", cacheControl: FEED_CACHE_CONTROL, runWrangler });
  const after = await remoteObject({ bucket, key: next.objectKey, maximumBytes: MAX_MANIFEST_BYTES, runWrangler, temporaryRoot });
  if (!sameBytes(after?.bytes ?? null, next.bytes)) fail(`feed readback differs: ${next.objectKey}`, "ELECTRON_HANDOVER_FEED_READBACK_FAILED");
}
let journalSequence = 0;
async function synchronize(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    fail("receipt journal could not be synchronized", "ELECTRON_HANDOVER_FEED_RECEIPT_WRITE_FAILED");
  } finally { await handle?.close().catch(() => {}); }
}
async function prepareReceiptJournal(path, value) {
  if (typeof path !== "string") fail("--receipt is required with --publish");
  const requested = resolve(path);
  const parent = await realpath(dirname(requested)).catch(() => fail("receipt parent is unavailable"));
  const destination = join(parent, basename(requested));
  if (await lstat(destination).then(() => true).catch(() => false)) fail("receipt path must be a new direct child of an existing directory");
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await synchronize(destination);
  await synchronize(parent);
  return destination;
}
async function persistReceiptJournal(path, value) {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${journalSequence += 1}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await synchronize(temporary);
    await rename(temporary, path);
    await synchronize(dirname(path));
    const written = await bytesAt(dirname(path), basename(path), MAX_MANIFEST_BYTES, "receipt journal");
    if (!written.bytes.equals(content)) fail("receipt journal changed during replacement", "ELECTRON_HANDOVER_FEED_RECEIPT_WRITE_FAILED");
  } finally { await rm(temporary, { force: true }); }
}

export async function publishElectronHandoverRehearsalFeed({ artifactRoot, proposalPath, stage, publish = false, confirmExclusiveRehearsalControl = false, receiptPath = null, runWrangler = defaultRunWrangler } = {}) {
  if (!["initial", "advance", "rollback"].includes(stage)) fail("--stage must be initial, advance, or rollback");
  if (publish !== true && publish !== false) fail("publish must be boolean");
  if (publish && (!confirmExclusiveRehearsalControl || receiptPath === null)) fail("--publish requires --confirm-exclusive-rehearsal-control and --receipt");
  if (!publish && (confirmExclusiveRehearsalControl || receiptPath !== null)) fail("publication controls require --publish");
  const validated = await validateHandoverFeedProposal({ artifactRoot, proposalPath });
  const plan = { bucket: validated.bucket, stage, targets: Object.fromEntries(TARGETS.map((target) => {
    const item = validated.targets[target];
    const selected = stage === "initial" ? item.current.manifest : stage === "advance" ? item.next.manifest : item.rollback;
    const objects = stage === "initial" ? item.current.objects : stage === "advance" ? item.next.objects : [];
    return [target, { feedKey: selected.objectKey, feedSha256: selected.sha256, immutableKeys: objects.map((object) => object.objectKey) }];
  })) };
  if (!publish) return Object.freeze({ published: false, ...plan });
  // This journal is deliberately created before temporary state or any remote
  // read/write. It records only object keys, hashes, and closed phases.
  const journal = {
    schema: "tibotattle-electron-handover-feed-publication-receipt-v1",
    sourceRevision: validated.family.sourceRevision,
    stage,
    bucket: validated.bucket,
    status: "prepared",
    mutation: "wrangler-unconditional-put-with-exclusive-control-pre-post-readback",
    targets: Object.fromEntries(TARGETS.map((target) => [target, { ...plan.targets[target], phase: "pending" }])),
  };
  const journalPath = await prepareReceiptJournal(receiptPath, journal);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tibotattle-electron-handover-feed-"));
  try {
    for (const target of TARGETS) {
      const item = validated.targets[target];
      const currentFeed = await remoteObject({ bucket: validated.bucket, key: item.current.manifest.objectKey, maximumBytes: MAX_MANIFEST_BYTES, runWrangler, temporaryRoot });
      if (stage === "initial") {
        let initialAlreadyCurrent = false;
        const requiresPredecessor = validated.family.predecessorFamily !== null;
        const initialExpected = requiresPredecessor
          ? item.predecessor
          : currentFeed === null ? null : item.current.manifest;
        if (requiresPredecessor) {
          const predecessorMatches = sameBytes(currentFeed?.bytes ?? null, initialExpected.bytes);
          const currentMatches = sameBytes(currentFeed?.bytes ?? null, item.current.manifest.bytes);
          if (!predecessorMatches && !currentMatches) fail(`existing feed is not the bound predecessor or family current candidate: ${target}`, "ELECTRON_HANDOVER_FEED_FEED_CONFLICT");
          initialAlreadyCurrent = currentMatches;
        } else if (currentFeed !== null && !sameBytes(currentFeed.bytes, initialExpected.bytes)) {
          fail(`existing feed is not the known current candidate: ${target}`, "ELECTRON_HANDOVER_FEED_FEED_CONFLICT");
        }
        journal.targets[target].phase = "feed_preflight_passed";
        await persistReceiptJournal(journalPath, journal);
        for (const object of item.current.objects) await ensureImmutable({ bucket: validated.bucket, object, runWrangler, temporaryRoot });
        journal.targets[target].phase = "assets_readback_passed";
        await persistReceiptJournal(journalPath, journal);
        if ((requiresPredecessor && !initialAlreadyCurrent) || currentFeed === null) await writeFeed({ bucket: validated.bucket, expected: initialExpected?.bytes ?? null, next: item.current.manifest, runWrangler, temporaryRoot });
        const verified = await remoteObject({ bucket: validated.bucket, key: item.current.manifest.objectKey, maximumBytes: MAX_MANIFEST_BYTES, runWrangler, temporaryRoot });
        if (!sameBytes(verified?.bytes ?? null, item.current.manifest.bytes)) fail(`existing initial feed differs after asset work: ${target}`, "ELECTRON_HANDOVER_FEED_READBACK_FAILED");
      } else if (stage === "advance") {
        if (!sameBytes(currentFeed?.bytes ?? null, item.current.manifest.bytes)) fail(`feed is not the recorded current candidate: ${target}`, "ELECTRON_HANDOVER_FEED_FEED_CONFLICT");
        journal.targets[target].phase = "feed_preflight_passed";
        await persistReceiptJournal(journalPath, journal);
        for (const object of item.next.objects) await ensureImmutable({ bucket: validated.bucket, object, runWrangler, temporaryRoot });
        journal.targets[target].phase = "assets_readback_passed";
        await persistReceiptJournal(journalPath, journal);
        await writeFeed({ bucket: validated.bucket, expected: item.current.manifest.bytes, next: item.next.manifest, runWrangler, temporaryRoot });
      } else {
        // A prior advance can stop between targets. The known family current state is a
        // safe no-op during recovery; any other state remains a hard refusal.
        if (sameBytes(currentFeed?.bytes ?? null, item.current.manifest.bytes)) {
          journal.targets[target].phase = "already_rolled_back";
          await persistReceiptJournal(journalPath, journal);
          continue;
        }
        if (!sameBytes(currentFeed?.bytes ?? null, item.next.manifest.bytes)) fail(`feed is not the recorded next candidate: ${target}`, "ELECTRON_HANDOVER_FEED_FEED_CONFLICT");
        journal.targets[target].phase = "feed_preflight_passed";
        await persistReceiptJournal(journalPath, journal);
        await writeFeed({ bucket: validated.bucket, expected: item.next.manifest.bytes, next: item.rollback, runWrangler, temporaryRoot });
      }
      journal.targets[target].phase = "feed_readback_passed";
      await persistReceiptJournal(journalPath, journal);
    }
    journal.status = "completed";
    await persistReceiptJournal(journalPath, journal);
    return Object.freeze({ published: true, receipt: Object.freeze({ ...journal }), ...plan });
  } catch (error) {
    journal.status = "failed";
    journal.failureCode = typeof error?.code === "string" ? error.code : "ELECTRON_HANDOVER_FEED_OPERATION_FAILED";
    await persistReceiptJournal(journalPath, journal).catch(() => {});
    throw error;
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
}

export function parseElectronHandoverFeedPublisherArguments(argv) {
  const options = { artifactRoot: null, proposalPath: null, stage: null, publish: false, confirmExclusiveRehearsalControl: false, receiptPath: null };
  const valued = new Map([["--artifact-root", "artifactRoot"], ["--proposal", "proposalPath"], ["--stage", "stage"], ["--receipt", "receiptPath"]]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valued.has(arg)) { const key = valued.get(arg); if (options[key] !== null || i + 1 >= argv.length) fail(`${arg} must occur once with a value`); options[key] = argv[++i]; }
    else if (arg === "--publish" && !options.publish) options.publish = true;
    else if (arg === "--confirm-exclusive-rehearsal-control" && !options.confirmExclusiveRehearsalControl) options.confirmExclusiveRehearsalControl = true;
    else fail(`unknown or repeated argument: ${arg}`);
  }
  if (!options.artifactRoot || !options.proposalPath || !options.stage) fail("--artifact-root, --proposal and --stage are required");
  if (!options.publish && (options.receiptPath !== null || options.confirmExclusiveRehearsalControl)) fail("--receipt and --confirm-exclusive-rehearsal-control require --publish");
  if (options.publish && (!options.receiptPath || !options.confirmExclusiveRehearsalControl)) fail("--publish requires --receipt and --confirm-exclusive-rehearsal-control");
  return Object.freeze(options);
}
export async function main(argv) {
  const result = await publishElectronHandoverRehearsalFeed(parseElectronHandoverFeedPublisherArguments(argv));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) main(process.argv.slice(2)).catch((error) => { console.error(`publish-electron-handover-rehearsal-feed: ${error.message}`); process.exitCode = 1; });
