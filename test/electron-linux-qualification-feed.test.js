import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import distribution from "../config/electron-production-distribution.cjs";
import { createLinuxUpdateVerifier } from "../apps/electron/linux-update-authenticity.js";
import { signLinuxUpdateFeed } from "../scripts/sign-electron-linux-update.mjs";
import { createLinuxQualificationCorruptStream, LINUX_QUALIFICATION_AUTHORITY_FILES,
  validateLinuxQualificationFeed, validateLinuxQualificationPackagedAuthority } from "../scripts/lib/linux-qualification-feed.mjs";

const { parseUpdateInfo, resolveFiles } = createRequire(import.meta.url)("electron-updater/out/providers/Provider.js");
// Test-process-only authority. Never embedded in a product or qualification input.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = [{ id: "synthetic-qualification", publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  minimumSequence: 1, maximumSequence: 10 }];
const timestamp = 1_900_000_000_000;
const verification = { keys, now: () => timestamp };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const feedDescriptor = bytes => ({ file: "latest-linux.yml", bytes: bytes.length, sha256: sha256(bytes) });
const feedFailure = { code: "LINUX_QUALIFICATION_FEED_INVALID" };
const authorityFailure = { code: "LINUX_QUALIFICATION_AUTHORITY_INVALID" };
const streamFailure = { code: "LINUX_QUALIFICATION_STREAM_INVALID" };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linux-signed-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.alloc(4096, 37), version = "0.1.20";
  const image = { version, bytes: payload.length, sha256: sha256(payload), sha512: createHash("sha512").update(payload).digest("base64") };
  const file = `TiboTattle-${version}-linux-x86_64.AppImage`, path = join(root, file);
  await writeFile(path, payload, { mode: 0o600 });
  const unsigned = { version, files: [{ url: file, size: image.bytes, sha512: image.sha512 }], path: file, sha512: image.sha512 };
  const feedBytes = await signLinuxUpdateFeed({ artifactPath: path, feedBytes: Buffer.from(JSON.stringify(unsigned)),
    sequence: 2, expiresAt: timestamp + 60_000, keyId: keys[0].id,
    signer: bytes => sign(null, bytes, privateKey), ...verification });
  return { payload, image, path, unsigned, feedBytes, descriptor: feedDescriptor(feedBytes) };
}
const input = row => ({ feedBytes: row.feedBytes, descriptor: row.descriptor, image: row.image });
async function corrupt(chunks, bytes) {
  const output = [];
  await pipeline(Readable.from(chunks), createLinuxQualificationCorruptStream({ expectedBytes: bytes.length, expectedSha256: sha256(bytes) }),
    new Writable({ write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } }));
  return Buffer.concat(output);
}

test("prepared exact publisher feed is consumable for update and same-version no-update through pinned parser and runtime", async t => {
  const row = await fixture(t);
  const admission = await validateLinuxQualificationFeed({ ...input(row), currentVersion: "0.1.19" }, verification);
  assert.equal(admission.updateAvailable, true);
  assert.deepEqual(admission.feedBytes, row.feedBytes);
  assert.deepEqual(admission.descriptor, row.descriptor);
  assert.equal(admission.artifactFileName, "TiboTattle-0.1.20-linux-x86_64.AppImage");
  assert.equal(admission.artifactRequestPath, "/electron/stable/linux-x64/TiboTattle-0.1.20-linux-x86_64.AppImage");
  const parsed = parseUpdateInfo(admission.feedBytes.toString("utf8"), "latest-linux.yml", "https://updates.tibotattle.com/electron/stable/linux-x64/latest-linux.yml");
  assert.equal(resolveFiles(parsed, new URL("https://updates.tibotattle.com/electron/stable/linux-x64/"))[0].url.pathname, admission.artifactRequestPath);
  let state = null;
  const backend = { load: async () => state, save: async value => { state = value; } };
  const previous = createLinuxUpdateVerifier({ ...verification, currentVersion: "0.1.19", backend });
  assert.deepEqual(await previous.authorize(parsed), { updateAvailable: true });
  const final = createLinuxUpdateVerifier({ ...verification, currentVersion: "0.1.20", backend });
  assert.deepEqual(await final.authorize(parsed), { updateAvailable: false });
  assert.equal(state.sequence, 2, "actual runtime persists the same authenticated high-water across restart");
  assert.equal((await validateLinuxQualificationFeed(input(row), verification)).updateAvailable, false);
});

test("qualification retains the original exact bytes across input and output mutation", async t => {
  const row = await fixture(t), original = Buffer.from(row.feedBytes), descriptor = { ...row.descriptor };
  const pending = validateLinuxQualificationFeed(input(row), verification);
  row.feedBytes.fill(0); row.descriptor.sha256 = "0".repeat(64); row.image.sha256 = "0".repeat(64);
  const admission = await pending;
  assert.deepEqual(admission.feedBytes, original);
  assert.deepEqual(admission.descriptor, descriptor);
  admission.feedBytes.fill(0);
  assert.deepEqual(admission.feedBytes, original);
  assert.ok(Object.isFrozen(admission) && Object.isFrozen(admission.manifest) && Object.isFrozen(admission.descriptor));
});

test("qualification rejects unsigned, misnamed, wrong subject, expired, untrusted and rehashed tampered feeds", async t => {
  const row = await fixture(t);
  const altered = change => {
    const parsed = JSON.parse(row.feedBytes); change(parsed);
    const feedBytes = Buffer.from(JSON.stringify(parsed));
    return { ...input(row), feedBytes, descriptor: feedDescriptor(feedBytes) };
  };
  for (const change of [
    value => { delete value.tibotattleLinuxUpdate; },
    value => { value.path = value.files[0].url = "next.AppImage"; },
    value => { value.releaseDate = "2026-10-13T00:00:00.000Z"; },
    value => { value.tibotattleLinuxUpdate.manifest.sha256 = "a".repeat(64); },
    value => { value.tibotattleLinuxUpdate.manifest.target = "linux-arm64"; },
    value => { value.tibotattleLinuxUpdate.manifest.appId = "different.product"; },
    value => { value.tibotattleLinuxUpdate.manifest.channel = "beta"; },
    value => { value.tibotattleLinuxUpdate.signature = Buffer.alloc(64).toString("base64"); },
    value => { value.files[0].sha512 = value.sha512 = Buffer.alloc(64).toString("base64"); },
  ]) await assert.rejects(validateLinuxQualificationFeed(altered(change), verification), feedFailure);
  for (const override of [
    { keys: [] }, { keys: [{ ...keys[0], id: "unknown" }] }, { keys: [{ ...keys[0], minimumSequence: 3 }] },
    { keys: [{ ...keys[0], maximumSequence: 1 }] }, { now: () => timestamp + 60_000 },
  ]) await assert.rejects(validateLinuxQualificationFeed(input(row), { ...verification, ...override }), feedFailure);
  await assert.rejects(validateLinuxQualificationFeed({ ...input(row), currentVersion: "0.1.21" }, verification), feedFailure);
});

test("qualification binds closed feed descriptor and independently measured image identity", async t => {
  const row = await fixture(t);
  for (const change of [
    { file: "../latest-linux.yml" }, { bytes: row.feedBytes.length + 1 }, { bytes: 0 }, { sha256: "A".repeat(64) },
    { sha256: "a".repeat(64) }, { extra: true },
  ]) await assert.rejects(validateLinuxQualificationFeed({ ...input(row), descriptor: { ...row.descriptor, ...change } }, verification), feedFailure);
  for (const change of [
    { version: "0.1.21" }, { version: "0.1.20-beta" }, { bytes: row.image.bytes + 1 }, { bytes: 0 },
    { sha256: "a".repeat(64) }, { sha512: Buffer.alloc(64).toString("base64") },
  ]) await assert.rejects(validateLinuxQualificationFeed({ ...input(row), image: { ...row.image, ...change } }, verification), feedFailure);
  for (const feedBytes of [null, row.feedBytes.toString(), Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1), Buffer.from([0xff])]) {
    await assert.rejects(validateLinuxQualificationFeed({ ...input(row), feedBytes,
      descriptor: Buffer.isBuffer(feedBytes) ? feedDescriptor(feedBytes) : row.descriptor }, verification), feedFailure);
  }
});

test("negative stream changes exactly one byte and keeps feed, stored artifact and input chunks unchanged", async t => {
  const row = await fixture(t), beforeFeed = Buffer.from(row.feedBytes), beforePayload = Buffer.from(row.payload);
  const chunks = [Buffer.alloc(0), row.payload.subarray(0, 1), Buffer.alloc(0), row.payload.subarray(1, 19), row.payload.subarray(19)];
  const output = await corrupt(chunks, row.payload);
  assert.equal(output.length, row.payload.length);
  assert.equal(output[0], row.payload[0] ^ 1);
  assert.deepEqual(output.subarray(1), row.payload.subarray(1));
  assert.deepEqual(row.payload, beforePayload);
  assert.deepEqual(await readFile(row.path), beforePayload);
  assert.deepEqual(row.feedBytes, beforeFeed);
  assert.notEqual(createHash("sha512").update(output).digest("base64"), row.image.sha512);
  assert.deepEqual(await corrupt([Buffer.from([8])], Buffer.from([8])), Buffer.from([9]));
});

test("negative stream refuses missing, truncated, oversized and changed source bytes", async () => {
  const expected = Buffer.from([2, 3, 4]);
  for (const chunks of [[], [expected.subarray(0, 2)], [Buffer.concat([expected, Buffer.from([5])])], [Buffer.from([2, 3, 5])]]) {
    await assert.rejects(corrupt(chunks, expected), streamFailure);
  }
  for (const options of [{ expectedBytes: 0, expectedSha256: sha256(expected) },
    { expectedBytes: 2 ** 31 + 1, expectedSha256: sha256(expected) }, { expectedBytes: 3, expectedSha256: "invalid" }]) {
    assert.throws(() => createLinuxQualificationCorruptStream(options), streamFailure);
  }
});

test("real runtime refuses corrupted qualified download and preserves the exact original", {
  skip: process.platform === "win32" ? "Runtime artifact inspection requires POSIX owner and no-follow semantics; portable signature and stream checks run above." : false,
}, async t => {
  const row = await fixture(t), admitted = await validateLinuxQualificationFeed({ ...input(row), currentVersion: "0.1.19" }, verification);
  const authority = createLinuxUpdateVerifier({ ...verification, currentVersion: "0.1.19", backend: { load: async () => null, save: async () => {} } });
  await authority.authorize(parseUpdateInfo(admitted.feedBytes.toString(), "latest-linux.yml", "https://updates.tibotattle.com/electron/stable/linux-x64/latest-linux.yml"));
  authority.verifyDownloaded([row.path], row.path);
  const corrupted = await corrupt([row.payload], row.payload);
  const corruptRoot = await mkdtemp(join(tmpdir(), "linux-corrupt-qualified-"));
  t.after(() => rm(corruptRoot, { recursive: true, force: true }));
  const corruptPath = join(corruptRoot, admitted.artifactFileName);
  await writeFile(corruptPath, corrupted, { mode: 0o600 });
  assert.throws(() => authority.verifyDownloaded([corruptPath], corruptPath), { code: "linux_update_authenticity_failed" });
  assert.deepEqual(await readFile(row.path), row.payload);
});

test("packaged updater authority must match both admitted source and reviewed runner without executing package code", async () => {
  const files = Object.fromEntries(LINUX_QUALIFICATION_AUTHORITY_FILES.map(file => [file, Buffer.from(`never evaluated: ${file}\n`)]));
  const reads = { source: [], reviewed: [], asar: [] };
  const read = kind => async file => { reads[kind].push(file); return files[file]; };
  const proof = await validateLinuxQualificationPackagedAuthority({ readAsarFile: read("asar"), readSourceFile: read("source") },
    { readReviewedFile: read("reviewed"), keys });
  assert.deepEqual(reads.source, LINUX_QUALIFICATION_AUTHORITY_FILES);
  assert.deepEqual(reads.reviewed, LINUX_QUALIFICATION_AUTHORITY_FILES);
  assert.deepEqual(reads.asar, LINUX_QUALIFICATION_AUTHORITY_FILES);
  assert.equal(proof.schemaVersion, "tibotattle-linux-qualification-authority-v1");
  assert.equal(proof.status, "packaged_source_matches_reviewed_authority");
  assert.deepEqual(proof.files, LINUX_QUALIFICATION_AUTHORITY_FILES.map(file => ({ file, bytes: files[file].length, sha256: sha256(files[file]) })));
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.files) && proof.files.every(Object.isFrozen));
  for (const kind of ["source", "reviewed", "asar"]) {
    const selected = name => async file => name === kind ? Buffer.from("changed or historical unrooted source") : files[file];
    await assert.rejects(validateLinuxQualificationPackagedAuthority({ readAsarFile: selected("asar"), readSourceFile: selected("source") },
      { readReviewedFile: selected("reviewed"), keys }), authorityFailure);
  }
  await assert.rejects(validateLinuxQualificationPackagedAuthority({ readAsarFile: async () => { throw Error("private-path-canary"); },
    readSourceFile: read("source") }, { readReviewedFile: read("reviewed"), keys }), error => {
    assert.equal(error.code, authorityFailure.code); assert.doesNotMatch(error.message, /canary/u); return true;
  });
  await assert.rejects(validateLinuxQualificationPackagedAuthority({ readAsarFile: read("asar") }, { readReviewedFile: read("reviewed"), keys }), authorityFailure);
  await assert.rejects(validateLinuxQualificationPackagedAuthority({ readAsarFile: read("asar"), readSourceFile: read("source") },
    { readReviewedFile: async () => Buffer.alloc(1024 ** 2 + 1), keys }), authorityFailure);
});

test("production default authority remains unprovisioned; qualification cannot replace it with a feed root", async t => {
  const row = await fixture(t);
  assert.deepEqual(distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS, []);
  await assert.rejects(validateLinuxQualificationFeed(input(row)), feedFailure);
  let reads = 0;
  await assert.rejects(validateLinuxQualificationPackagedAuthority({ readAsarFile: async () => { reads++; return Buffer.from("unread"); },
    readSourceFile: async () => { reads++; return Buffer.from("unread"); } }), authorityFailure);
  assert.equal(reads, 0, "unprovisioned authority refused before inspecting candidate files");
});
