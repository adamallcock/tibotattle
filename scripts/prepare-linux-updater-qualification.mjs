#!/usr/bin/env node
/** Prepare an existing immutable private pair using separately authorized metadata. */
import { spawnSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxAppImageIdentity } from "./build-linux-updater-rehearsal.mjs";
import { extractLinuxFinalImage } from "./lib/linux-final-extraction.mjs";
import { LINUX_QUALIFICATION_AUTHORITY_FILES, validateLinuxQualificationFeed, validateLinuxQualificationPackagedAuthority } from "./lib/linux-qualification-feed.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(new Error(`LINUX_UPDATER_QUALIFICATION_${code}`), { code: `LINUX_UPDATER_QUALIFICATION_${code}` }); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode
  && a.uid === b.uid && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export async function readLinuxQualificationFile(path, maximum, { allowRootOwner = true } = {}) {
  let handle;
  try {
    if (await realpath(path) !== path) fail("INPUT_UNSAFE");
    const before = await lstat(path, { bigint: true });
    if (typeof process.getuid !== "function" || (before.uid !== BigInt(process.getuid()) && !(allowRootOwner && before.uid === 0n))) fail("INPUT_UNSAFE");
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n
        || before.size < 1n || before.size > BigInt(maximum)) fail("INPUT_UNSAFE");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, await handle.stat({ bigint: true }))) fail("INPUT_CHANGED");
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count); if (!bytesRead) break; count += bytesRead; }
    if (BigInt(count) !== before.size || !same(before, await handle.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true }))) fail("INPUT_CHANGED");
    return bytes.subarray(0, count);
  } catch (error) { if (error.code?.startsWith("LINUX_UPDATER_QUALIFICATION_")) throw error; fail("INPUT_UNAVAILABLE"); }
  finally { await handle?.close().catch(() => {}); }
}
async function privateDirectoryIdentity(path) {
  if (typeof process.getuid !== "function" || await realpath(path) !== path) fail("OUTPUT_UNSAFE");
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== BigInt(process.getuid()) || (value.mode & 0o7777n) !== 0o700n) fail("OUTPUT_UNSAFE");
  return `${value.dev}:${value.ino}:${value.uid}:${value.mode}`;
}
export function readLinuxQualificationAsarFile(archive, file) {
  if (!LINUX_QUALIFICATION_AUTHORITY_FILES.includes(file)) fail("POLICY_INVALID");
  const imported = createRequire(require.resolve("electron-builder"))("@electron/asar"), asar = imported.default ?? imported;
  for (let index = 1; index <= file.split("/").length; index++) {
    const entry = asar.statFile(archive, file.split("/").slice(0, index).join("/"), false);
    if (entry.link !== undefined || entry.unpacked) fail("POLICY_INVALID");
    if (index === file.split("/").length && (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 1024 ** 2)) fail("POLICY_INVALID");
  }
  return asar.extractFile(archive, file, false);
}
function gitSource(root, revision, file) {
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision) || !LINUX_QUALIFICATION_AUTHORITY_FILES.includes(file)) fail("POLICY_INVALID");
  const result = spawnSync("git", ["show", `${revision}:${file}`], { cwd: root, shell: false, stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 1024 ** 2 });
  if (result.error || result.status !== 0 || result.signal) fail("SOURCE_UNAVAILABLE");
  return result.stdout;
}
const exact = (value, fields) => value && !Array.isArray(value) && Object.keys(value).sort().join() === [...fields].sort().join();
export function validateLinuxPrivateQualificationRecord(record, { pairBytes, sourceRevision }) {
  if (!exact(record, ["schemaVersion", "sourceRevision", "pair", "feed", "packagedAuthority", "publication"])
      || record.schemaVersion !== "tibotattle-linux-real-updater-qualification-v1" || typeof sourceRevision !== "string" || !/^[a-f0-9]{40}$/u.test(sourceRevision) || record.sourceRevision !== sourceRevision
      || record.publication !== "not_performed" || !exact(record.pair, ["bytes", "sha256"])
      || record.pair.bytes !== pairBytes.length || record.pair.sha256 !== hash(pairBytes)
      || !exact(record.feed, ["file", "bytes", "sha256"]) || record.feed.file !== "latest-linux.yml"
      || !Number.isSafeInteger(record.feed.bytes) || record.feed.bytes < 1 || record.feed.bytes > 65536 || typeof record.feed.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.feed.sha256)) fail("ADMISSION_INVALID");
  const authority = record.packagedAuthority;
  if (!exact(authority, ["schemaVersion", "status", "files"]) || authority.schemaVersion !== "tibotattle-linux-qualification-authority-v1"
      || authority.status !== "packaged_source_matches_reviewed_authority" || !Array.isArray(authority.files)
      || authority.files.length !== LINUX_QUALIFICATION_AUTHORITY_FILES.length || authority.files.some((file, index) => !exact(file, ["file", "bytes", "sha256"])
        || file.file !== LINUX_QUALIFICATION_AUTHORITY_FILES[index] || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 1024 ** 2
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256))) fail("ADMISSION_INVALID");
  return record;
}
async function digest(path) { const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest("hex"); }
export async function prepareLinuxUpdaterQualification({ signedFeed, root = ROOT }, {
  inspectImage = linuxAppImageIdentity, extractImage = extractLinuxFinalImage,
  validateFeed = validateLinuxQualificationFeed, validateAuthority = validateLinuxQualificationPackagedAuthority,
  readAsarFile = readLinuxQualificationAsarFile, readSourceFile,
} = {}) {
  // Delayed source reader below uses only the frozen pair's validated revision.
  let pairRevision;
  const pairRoot = join(root, ".release-build/electron-linux-updater-rehearsal");
  const pairDirectory = await privateDirectoryIdentity(pairRoot);
  const pairBytes = await readLinuxQualificationFile(join(pairRoot, "pair.json"), 131072, { allowRootOwner: false });
  let pair; try { pair = JSON.parse(pairBytes); } catch { fail("PAIR_INVALID"); }
  const { validateLinuxRealUpdaterPair } = await import("./smoke-electron-linux-real-appimage-updater.mjs");
  pairRevision = pair.sourceRevision;
  validateLinuxRealUpdaterPair(pair, pairRevision);
  if (typeof pairRevision !== "string" || !/^[a-f0-9]{40}$/u.test(pairRevision)) fail("PAIR_INVALID");
  const readCandidateSource = readSourceFile ?? (file => gitSource(root, pairRevision, file));
  const feedBytes = await readLinuxQualificationFile(resolve(signedFeed), 65536, { allowRootOwner: false });
  const descriptor = { file: "latest-linux.yml", bytes: feedBytes.length, sha256: hash(feedBytes) };
  await validateFeed({ feedBytes, descriptor, image: pair.images.next, currentVersion: pair.images.current.version });
  for (const role of ["current", "next"]) {
    const measured = await inspectImage(join(pairRoot, pair.images[role].file));
    if (["bytes", "sha256", "sha512"].some(key => measured[key] !== pair.images[role][key])) fail("PAIR_CHANGED");
  }
  const directory = join(pairRoot, "qualification");
  if (await privateDirectoryIdentity(pairRoot) !== pairDirectory) fail("OUTPUT_CHANGED");
  await mkdir(directory, { mode: 0o700 }); // No clobber or automatic rebuild of signed inputs.
  const outputDirectory = await privateDirectoryIdentity(directory);
  const assertDirectories = async () => {
    if (await privateDirectoryIdentity(pairRoot) !== pairDirectory || await privateDirectoryIdentity(directory) !== outputDirectory) fail("OUTPUT_CHANGED");
  };
  let packagedAuthority;
  for (const role of ["current", "next"]) {
    await assertDirectories();
    const inspection = join(directory, `${role}-inspection`); await mkdir(inspection, { mode: 0o700 });
    await extractImage(join(pairRoot, pair.images[role].file), inspection, { runnerRevision: pairRevision, expected: { asarSha256: pair.images[role].asarSha256 } });
    const archive = join(inspection, "squashfs-root/resources/app.asar");
    if (await digest(archive) !== pair.images[role].asarSha256) fail("PAIR_CHANGED");
    const authority = await validateAuthority({ readAsarFile: file => readAsarFile(archive, file), readSourceFile: readCandidateSource });
    if (packagedAuthority && JSON.stringify(authority) !== JSON.stringify(packagedAuthority)) fail("POLICY_INVALID");
    packagedAuthority = authority;
  }
  for (const role of ["current", "next"]) {
    const measured = await inspectImage(join(pairRoot, pair.images[role].file));
    if (["bytes", "sha256", "sha512"].some(key => measured[key] !== pair.images[role][key])) fail("PAIR_CHANGED");
  }
  if (!(await readLinuxQualificationFile(join(pairRoot, "pair.json"), 131072, { allowRootOwner: false })).equals(pairBytes)) fail("PAIR_CHANGED");
  const record = validateLinuxPrivateQualificationRecord({ schemaVersion: "tibotattle-linux-real-updater-qualification-v1", sourceRevision: pairRevision,
    pair: { bytes: pairBytes.length, sha256: hash(pairBytes) }, feed: descriptor, packagedAuthority, publication: "not_performed" }, { pairBytes, sourceRevision: pairRevision });
  for (const [file, bytes] of [["latest-linux.yml", feedBytes], ["qualification.json", Buffer.from(`${JSON.stringify(record, null, 2)}\n`)]]) {
    await assertDirectories();
    const handle = await open(join(directory, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertDirectories();
  }
  return record;
}
export function parseLinuxUpdaterQualificationArguments(args) {
  if (args.length !== 2 || args[0] !== "--signed-feed" || typeof args[1] !== "string" || !args[1].startsWith("/") || /[\0\r\n]/u.test(args[1])) fail("ARGUMENT_INVALID");
  return { signedFeed: args[1] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => prepareLinuxUpdaterQualification(parseLinuxUpdaterQualificationArguments(process.argv.slice(2))))
    .then(record => console.log(JSON.stringify({ status: "signed_private_pair_prepared", sourceRevision: record.sourceRevision, pair: record.pair, feed: record.feed, nativeQualification: "not_performed" })))
    .catch(() => { console.error("LINUX_UPDATER_QUALIFICATION_UNAVAILABLE"); process.exitCode = 1; });
}
