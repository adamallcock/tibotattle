import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxAppImageIdentity } from "../scripts/build-linux-updater-rehearsal.mjs";
import { parseLinuxUpdaterQualificationArguments, prepareLinuxUpdaterQualification, readLinuxQualificationFile, validateLinuxPrivateQualificationRecord } from "../scripts/prepare-linux-updater-qualification.mjs";
import { LINUX_QUALIFICATION_AUTHORITY_FILES, validateLinuxQualificationFeed, validateLinuxQualificationPackagedAuthority } from "../scripts/lib/linux-qualification-feed.mjs";
import { linuxUpdateVerification, signSyntheticLinuxFeed } from "./helpers/linux-update-publication-fixture.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const revision = "a".repeat(40);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "linux-pair-admission-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairRoot = join(root, ".release-build/electron-linux-updater-rehearsal"); await mkdir(pairRoot, { recursive: true, mode: 0o700 });
  const asar = Buffer.from("synthetic actual extracted ASAR bytes");
  const images = {};
  for (const [role, version] of [["current", "0.1.19"], ["next", "0.1.20"]]) {
    await mkdir(join(pairRoot, role), { mode: 0o700 });
    const bytes = Buffer.alloc(4096, role === "current" ? 1 : 2); bytes.set([127, 69, 76, 70, 2]); bytes.writeUInt16LE(62, 18); bytes.set([65, 73, 2], 8);
    const file = `${role}/TiboTattle-${version}-linux-x86_64.AppImage`;
    await writeFile(join(pairRoot, file), bytes, { mode: 0o600 });
    images[role] = { version, file, asarSha256: sha(asar), ...await linuxAppImageIdentity(join(pairRoot, file)) };
  }
  const pair = { schemaVersion: "tibotattle-linux-real-updater-pair-v1", sourceRevision: revision, scope: "private_test_version_override",
    feed: "https://updates.tibotattle.com/electron/stable/linux-x64", images, publication: "not_performed" };
  const pairBytes = Buffer.from(JSON.stringify(pair)); await writeFile(join(pairRoot, "pair.json"), pairBytes, { mode: 0o600 });
  const next = images.next, file = next.file.split("/").at(-1);
  const unsigned = Buffer.from(JSON.stringify({ version: next.version, files: [{ url: file, size: next.bytes, sha512: next.sha512 }], path: file, sha512: next.sha512 }));
  const feedBytes = await signSyntheticLinuxFeed(join(pairRoot, next.file), unsigned);
  const signedFeed = join(root, "owner-signed.yml"); await writeFile(signedFeed, feedBytes, { mode: 0o600 });
  const sources = Object.fromEntries(LINUX_QUALIFICATION_AUTHORITY_FILES.map(file => [file, Buffer.from(`synthetic policy ${file}`)]));
  const calls = [];
  const seams = {
    validateFeed: input => validateLinuxQualificationFeed(input, linuxUpdateVerification),
    extractImage: async (image, destination, options) => {
      calls.push({ image, options });
      await mkdir(join(destination, "squashfs-root/resources"), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, "squashfs-root/resources/app.asar"), asar, { mode: 0o600 });
    },
    readAsarFile: (_archive, file) => sources[file], readSourceFile: file => sources[file],
    validateAuthority: input => validateLinuxQualificationPackagedAuthority(input, { keys: linuxUpdateVerification.keys, readReviewedFile: file => sources[file] }),
  };
  return { root, pairRoot, pair, pairBytes, feedBytes, signedFeed, seams, calls };
}
test("post-build preparation preserves exact signed metadata, original pair and images and binds actual ASAR source authority", async t => {
  const f = await fixture(t), record = await prepareLinuxUpdaterQualification({ root: f.root, signedFeed: f.signedFeed }, f.seams);
  assert.deepEqual(await readFile(join(f.pairRoot, "pair.json")), f.pairBytes);
  assert.deepEqual(await readFile(join(f.pairRoot, "qualification/latest-linux.yml")), f.feedBytes);
  assert.deepEqual(JSON.parse(await readFile(join(f.pairRoot, "qualification/qualification.json"))), record);
  assert.equal(record.pair.sha256, sha(f.pairBytes)); assert.equal(record.feed.sha256, sha(f.feedBytes));
  assert.deepEqual(record.packagedAuthority.files.map(row => row.file), LINUX_QUALIFICATION_AUTHORITY_FILES);
  assert.equal(f.calls.length, 2);
  for (const [index, role] of ["current", "next"].entries()) {
    assert.equal(f.calls[index].options.runnerRevision, revision);
    assert.equal(f.calls[index].options.expected.asarSha256, f.pair.images[role].asarSha256);
    assert.equal((await linuxAppImageIdentity(join(f.pairRoot, f.pair.images[role].file))).sha256, f.pair.images[role].sha256);
  }
  await assert.rejects(prepareLinuxUpdaterQualification({ root: f.root, signedFeed: f.signedFeed }, f.seams));
  assert.deepEqual(await readFile(join(f.pairRoot, "qualification/latest-linux.yml")), f.feedBytes);
});
test("preparation rejects untrusted feed, changed artifacts/ASAR/source and pair replacement without writing admission", async t => {
  for (const mutate of [
    async f => writeFile(f.signedFeed, "unsigned metadata"),
    async f => writeFile(join(f.pairRoot, f.pair.images.next.file), Buffer.alloc(4096)),
    async f => { f.seams.extractImage = async (_image, directory) => { await mkdir(join(directory, "squashfs-root/resources"), { recursive: true }); await writeFile(join(directory, "squashfs-root/resources/app.asar"), "changed"); }; },
    async f => { f.seams.readAsarFile = () => Buffer.from("wrong policy"); },
    async f => { const extract = f.seams.extractImage; f.seams.extractImage = async (...args) => { await extract(...args); await writeFile(join(f.pairRoot, "pair.json"), `${f.pairBytes}\n`); }; },
    async f => { const extract = f.seams.extractImage; f.seams.extractImage = async (...args) => { await extract(...args); await writeFile(join(f.pairRoot, f.pair.images.next.file), Buffer.alloc(4096)); }; },
  ]) {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(prepareLinuxUpdaterQualification({ root: f.root, signedFeed: f.signedFeed }, f.seams));
    await assert.rejects(readFile(join(f.pairRoot, "qualification/qualification.json")), { code: "ENOENT" });
  }
});
test("preparation refuses unsafe or replaced owner output directories before installing its admission", async t => {
  const unsafe = await fixture(t); await chmod(unsafe.pairRoot, 0o755);
  await assert.rejects(prepareLinuxUpdaterQualification({ root: unsafe.root, signedFeed: unsafe.signedFeed }, unsafe.seams), { code: "LINUX_UPDATER_QUALIFICATION_OUTPUT_UNSAFE" });
  const swapped = await fixture(t), extract = swapped.seams.extractImage;
  swapped.seams.extractImage = async (...args) => {
    await extract(...args);
    const directory = join(swapped.pairRoot, "qualification");
    await rename(directory, join(swapped.pairRoot, "preserved-inspection")); await mkdir(directory, { mode: 0o700 });
  };
  await assert.rejects(prepareLinuxUpdaterQualification({ root: swapped.root, signedFeed: swapped.signedFeed }, swapped.seams));
  await assert.rejects(readFile(join(swapped.pairRoot, "qualification/qualification.json")), { code: "ENOENT" });
});
test("explicit CLI and bounded input reader reject unknown flags, links, unsafe permissions and excess bytes", async t => {
  assert.deepEqual(parseLinuxUpdaterQualificationArguments(["--signed-feed", "/synthetic/signed.yml"]), { signedFeed: "/synthetic/signed.yml" });
  for (const args of [[], ["--signed-feed", "relative"], ["--signed-feed", "/a", "--key", "root"], ["--sign", "/a"]]) assert.throws(() => parseLinuxUpdaterQualificationArguments(args));
  const f = await fixture(t);
  await assert.rejects(readLinuxQualificationFile(f.signedFeed, 1));
  await chmod(f.signedFeed, 0o666); await assert.rejects(readLinuxQualificationFile(f.signedFeed, 65536)); await chmod(f.signedFeed, 0o600);
  const alias = join(f.root, "alias"); await link(f.signedFeed, alias); await assert.rejects(readLinuxQualificationFile(f.signedFeed, 65536)); await rm(alias);
  await symlink(f.signedFeed, alias); await assert.rejects(readLinuxQualificationFile(alias, 65536));
});
test("closed private admission rejects old, incomplete or relabeled pair/feed/policy proof", async t => {
  const f = await fixture(t), original = await prepareLinuxUpdaterQualification({ root: f.root, signedFeed: f.signedFeed }, f.seams);
  for (const alter of [r => { r.extra = true; }, r => { r.schemaVersion = "old"; }, r => { r.feed.file = "other.yml"; }, r => { r.pair.sha256 = "b".repeat(64); },
    r => { r.packagedAuthority.files.pop(); }, r => { r.packagedAuthority.files[0].file = "other"; }, r => { r.feed.sha256 = [r.feed.sha256]; },
    r => { r.packagedAuthority.files[0].sha256 = [r.packagedAuthority.files[0].sha256]; }, r => { r.feed.sha256 = 123; }, r => { r.sourceRevision = [revision]; }]) {
    const record = structuredClone(original); alter(record);
    assert.throws(() => validateLinuxPrivateQualificationRecord(record, { pairBytes: f.pairBytes, sourceRevision: revision }));
  }
  await writeFile(join(f.pairRoot, "pair.json"), JSON.stringify({ ...f.pair, sourceRevision: [revision] }));
  await assert.rejects(prepareLinuxUpdaterQualification({ root: f.root, signedFeed: f.signedFeed }, f.seams));
});
