import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOperation } from "../../../scripts/lib/release-operation.mjs";
import { releasedSiteOfOperation } from "./production-deploy.mjs";
import { verifyGeneratedCommunityAssetTree } from "./stage-production-assets.mjs";

// Archive one verified typed production deploy as a rollback point: its
// operation journal, the web-release receipt of the site it left live, and
// that generated site, in an owner-private directory outside every repository.
// A website rollback names the archived journal with
// --rollback-release-operation and restores the archived receipt and site.
// The script never deploys, never touches the network and never changes its
// inputs: it writes nothing, not even the archive directory, until the
// journal, receipt and site have verified. It refuses an unverified or held
// journal, a receipt or site that is not the one the journal left live, and an
// existing different archive entry; an identical existing entry is reported as
// already archived.

export const PRODUCTION_RELEASE_ARCHIVE_SCHEMA = "tibotattle-production-release-archive-v1";
export const PRODUCTION_RELEASE_ARCHIVE_LAYOUT = Object.freeze({
  index: "index.json",
  journal: "journal",
  receipt: "web-release-receipt.json",
  site: "public-release-site",
});

const SITE_DIRECTORY = join(".release-build", "public-release-site");
const MUTEX_FILE = "mutex.sqlite";
const SQLITE_BUSY = 5;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const ARGUMENTS = new Map([
  ["--operation", "operationDirectory"],
  ["--web-release-receipt", "receiptPath"],
  ["--archive", "archiveRoot"],
]);

function failure(code) {
  return { ok: false, code };
}

class ArchiveRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new ArchiveRefusal(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(parent, child) {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function ownedByCaller(info) {
  return !process.getuid || info.uid === process.getuid();
}

export function parseProductionReleaseArchiveArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = ARGUMENTS.get(argv[index]);
    const value = argv[++index];
    if (!name || name in result || typeof value !== "string" || value === ""
        || value.startsWith("--") || value.includes("\0") || !isAbsolute(value)) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID");
    }
    result[name] = value;
  }
  if (Object.keys(result).length !== ARGUMENTS.size) refuse("PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID");
  return result;
}

/**
 * The archive root must be an absolute, owner-private (0700, caller-owned,
 * not a symlink, by its real path) directory outside every Git checkout:
 * neither it nor any ancestor holds a `.git` entry, and it is not inside the
 * repository the script runs from. Checked before anything is read or
 * written: a root that does not exist yet must have a parent named by its
 * real path, so nothing is ever created through a link.
 */
async function checkArchiveRoot(archiveRoot, repositoryRoot) {
  const root = resolve(archiveRoot);
  if (within(resolve(repositoryRoot), root)) refuse("PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY");
  for (let directory = root; ; directory = dirname(directory)) {
    try {
      await lstat(join(directory, ".git"));
      refuse("PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY");
    } catch (error) {
      if (error instanceof ArchiveRefusal) throw error;
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
    }
    if (dirname(directory) === directory) break;
  }
  let existing = null;
  try {
    existing = await lstat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
  const named = existing === null ? dirname(root) : root;
  let real;
  try {
    real = await realpath(named);
  } catch {
    refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
  if (real !== named
      || (existing !== null
        && (!existing.isDirectory() || (existing.mode & 0o077) !== 0 || !ownedByCaller(existing)))) {
    refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
  return root;
}

// Create a missing archive root privately, once every input has verified,
// and check it again as created.
async function createArchiveRoot(root) {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
  let info;
  let real;
  try {
    info = await lstat(root);
    real = await realpath(root);
  } catch {
    refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
  if (!info.isDirectory() || real !== root || (info.mode & 0o077) !== 0 || !ownedByCaller(info)) {
    refuse("PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE");
  }
}

/**
 * Whether a running operation holds the journal. openOperation holds it with
 * an exclusive SQLite transaction on `mutex.sqlite`, so this probes that lock
 * itself: read-only and without waiting, a live holder refuses even a shared
 * read (SQLITE_BUSY). A holder that was killed leaves no lock, only a stale
 * `mutex.sqlite-journal`; a read-only connection never rolls back or removes
 * that file, so such a journal is archived as found. Anything else (no mutex,
 * not a database) is an unsafe journal.
 */
function journalHeld(journalDirectory) {
  let database = null;
  try {
    database = new DatabaseSync(join(journalDirectory, MUTEX_FILE), { readOnly: true });
    database.exec("PRAGMA busy_timeout = 0");
    database.prepare("SELECT count(*) AS tables FROM sqlite_master").get();
    return false;
  } catch (error) {
    if (((error?.errcode ?? 0) & 0xff) === SQLITE_BUSY) return true;
    return refuse("PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE");
  } finally {
    database?.close();
  }
}

/**
 * A bounded, sorted listing of a tree of directories and regular files, with
 * each file's sha256. Anything else (a symlink, a device, a hard-linked file
 * where `singleLink` applies) is refused with `code`.
 */
async function treeListing(root, { code, singleLink = false, privateModes = false }) {
  const rows = [];
  let total = 0;
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    refuse(code);
  }
  if (!rootInfo.isDirectory() || !ownedByCaller(rootInfo)
      || (privateModes && (rootInfo.mode & 0o077) !== 0)) refuse(code);
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      refuse(code);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (rows.length >= MAX_ENTRIES) refuse(code);
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      if (!ownedByCaller(info) || (privateModes && (info.mode & 0o077) !== 0)) refuse(code);
      if (info.isDirectory()) {
        rows.push({ path: name, type: "directory" });
        await visit(path);
        continue;
      }
      if (!info.isFile() || (singleLink && info.nlink !== 1) || info.size > MAX_FILE_BYTES) refuse(code);
      total += info.size;
      if (total > MAX_TOTAL_BYTES) refuse(code);
      const bytes = await readFile(path);
      rows.push({ path: name, type: "file", bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit(root);
  return rows;
}

async function writePrivateFile(path, bytes) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Copy a listed tree into a fresh private destination: directories 0700,
// files 0600, every file written exclusively and fsynced.
async function copyListedTree(source, destination, rows) {
  await mkdir(destination, { mode: 0o700 });
  const directories = [destination];
  for (const row of rows) {
    const target = resolve(destination, row.path);
    if (!target.startsWith(`${destination}${sep}`)) refuse("PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID");
    if (row.type === "directory") {
      await mkdir(target, { mode: 0o700 });
      directories.push(target);
      continue;
    }
    const bytes = await readFile(join(source, row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) refuse("PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED");
    await writePrivateFile(target, bytes);
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

function sameListing(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexBytes(index) {
  return Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Archive a verified typed production deploy as a rollback point.
 *
 * - operationDirectory: the deploy's operation journal. It must be a verified
 *   typed production deploy whose state still matches its binding digest
 *   (the rollback's own rule), and not held by a running operation.
 * - receiptPath: the web-release receipt of the site the deploy left live,
 *   under this checkout's `.release-build`. The web-only lane re-verifies it
 *   against this checkout and its generated site, and its manifest and source
 *   commit must be the journal's live site.
 * - The generated site is this checkout's `.release-build/public-release-site`,
 *   verified file by file against its manifest.
 * - archiveRoot: owner-private, outside every repository, and neither inside
 *   nor containing the journal. A missing root is created only after the
 *   journal, receipt and site have verified; a refusal before then writes
 *   nothing.
 *
 * The entry `<archiveRoot>/<journal identityDigest>/` holds `journal/`,
 * `web-release-receipt.json` (the exact bytes whose parse is the verified
 * receipt), `public-release-site/` and a content-free `index.json`. It is
 * assembled in a private staging directory, verified, then renamed into place.
 * An existing identical entry is `already_archived`; any other existing entry
 * is refused, never overwritten.
 */
export async function archiveProductionRelease({
  operationDirectory,
  receiptPath,
  archiveRoot,
  repositoryRoot,
  verifyReceipt = null,
  verifySite = verifyGeneratedCommunityAssetTree,
  readReleaseOperation = readOperation,
} = {}) {
  for (const value of [operationDirectory, receiptPath, archiveRoot, repositoryRoot]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      return failure("PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID");
    }
  }
  let staging = null;
  try {
    // The archive never overlaps the journal: an archive inside the journal
    // would add an entry to the journal it copies. Nothing is written until
    // the journal, receipt and site verify, so the root is only checked here.
    const journalDirectory = resolve(operationDirectory);
    if (within(resolve(archiveRoot), journalDirectory) || within(journalDirectory, resolve(archiveRoot))) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID");
    }
    const root = await checkArchiveRoot(archiveRoot, repositoryRoot);

    // 1. The journal: a verified typed production deploy, intact, at rest.
    let record;
    try {
      record = await readReleaseOperation(journalDirectory);
    } catch {
      refuse("PRODUCTION_RELEASE_ARCHIVE_OPERATION_INVALID");
    }
    const released = releasedSiteOfOperation(record);
    if (released === null || !SHA256_PATTERN.test(record.binding ?? "")) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED");
    }
    const journalRows = await treeListing(journalDirectory, {
      code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE",
      singleLink: true,
      privateModes: true,
    });
    if (journalRows.some((row) => row.type !== "file")) refuse("PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE");
    if (journalHeld(journalDirectory)) refuse("PRODUCTION_RELEASE_ARCHIVE_OPERATION_BUSY");

    // 2. The receipt: the lane's own verification, then the journal's site.
    const repository = resolve(repositoryRoot);
    let receipt;
    try {
      const verify = verifyReceipt ?? (await import("../../../scripts/web-release-lane.js")).verifyWebReleaseReceipt;
      receipt = (await verify({ repositoryRoot: repository, receiptPath }))?.receipt;
    } catch {
      refuse("PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID");
    }
    if (!COMMIT_PATTERN.test(receipt?.sourceCommit ?? "")
        || !SHA256_PATTERN.test(receipt?.site?.manifestSha256 ?? "")) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID");
    }
    if (receipt.site.manifestSha256 !== released.manifestSha256
        || receipt.sourceCommit !== released.sourceCommit) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_RECEIPT_MISMATCH");
    }
    // The lane read the receipt itself; the bytes archived are read again, so
    // they must parse to exactly the receipt it verified, field for field.
    const verifiedReceipt = JSON.stringify(receipt);
    let receiptBytes;
    try {
      const info = await lstat(receiptPath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error();
      receiptBytes = await readFile(receiptPath);
      if (JSON.stringify(JSON.parse(receiptBytes.toString("utf8"))) !== verifiedReceipt) throw new Error();
    } catch {
      refuse("PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED");
    }

    // 3. The generated site: exactly its manifest, and that manifest is the
    // journal's live site.
    const siteDirectory = join(repository, SITE_DIRECTORY);
    let siteRows;
    try {
      const info = await lstat(siteDirectory);
      if (!info.isDirectory()) throw new Error();
      siteRows = await verifySite(siteDirectory);
    } catch {
      refuse("PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID");
    }
    const siteListing = await treeListing(siteDirectory, { code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
    const manifestRow = siteListing.find((row) => row.path === "release-site-manifest.json");
    if (manifestRow?.sha256 !== released.manifestSha256) refuse("PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID");

    // 4. Every input verified: create the archive root if it is missing,
    // assemble privately, then prove the copy.
    await createArchiveRoot(root);
    const index = {
      schema: PRODUCTION_RELEASE_ARCHIVE_SCHEMA,
      journalIdentityDigest: record.binding,
      deployCommit: released.deploySourceCommit,
      sourceCommit: released.sourceCommit,
      manifestSha256: released.manifestSha256,
      receiptSha256: sha256(receiptBytes),
    };
    staging = await mkdtemp(join(root, ".staging-"));
    await copyListedTree(journalDirectory, join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.journal), journalRows);
    await writePrivateFile(join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.receipt), receiptBytes);
    await copyListedTree(siteDirectory, join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.site), siteListing);
    await writePrivateFile(join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.index), indexBytes(index));
    await syncDirectory(staging);

    // The journal did not move while it was copied, and the copy is still the
    // same verified release; the copied receipt is still the verified receipt
    // and the copied site passes the same site check.
    const journalAfter = await treeListing(journalDirectory, {
      code: "PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED",
      singleLink: true,
      privateModes: true,
    });
    if (!sameListing(journalAfter, journalRows)) refuse("PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED");
    let archivedRelease = null;
    let archivedSiteRows;
    let archivedReceipt = null;
    try {
      const archivedRecord = await readOperation(join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.journal));
      if (archivedRecord.binding === record.binding) archivedRelease = releasedSiteOfOperation(archivedRecord);
      archivedSiteRows = await verifySite(join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.site));
      archivedReceipt = await readFile(join(staging, PRODUCTION_RELEASE_ARCHIVE_LAYOUT.receipt));
    } catch {
      archivedRelease = null;
    }
    if (archivedRelease === null
        || JSON.stringify(archivedRelease) !== JSON.stringify(released)
        || JSON.stringify(archivedSiteRows) !== JSON.stringify(siteRows)
        || sha256(archivedReceipt) !== index.receiptSha256
        || JSON.stringify(JSON.parse(archivedReceipt.toString("utf8"))) !== verifiedReceipt) {
      refuse("PRODUCTION_RELEASE_ARCHIVE_COPY_UNVERIFIED");
    }

    // 5. Place it. Never overwrite: an identical entry is already archived.
    const entry = join(root, record.binding);
    let existing = null;
    try {
      existing = await lstat(entry);
    } catch (error) {
      if (error?.code !== "ENOENT") refuse("PRODUCTION_RELEASE_ARCHIVE_CONFLICT");
    }
    const result = { ok: true, ...index };
    delete result.schema;
    if (existing) {
      const listing = { code: "PRODUCTION_RELEASE_ARCHIVE_CONFLICT", singleLink: true, privateModes: true };
      if (!existing.isDirectory()
          || !sameListing(await treeListing(entry, listing), await treeListing(staging, listing))) {
        refuse("PRODUCTION_RELEASE_ARCHIVE_CONFLICT");
      }
      return { ...result, code: "PRODUCTION_RELEASE_ALREADY_ARCHIVED", archive: "already_archived" };
    }
    try {
      await rename(staging, entry);
    } catch {
      refuse("PRODUCTION_RELEASE_ARCHIVE_CONFLICT");
    }
    staging = null;
    await syncDirectory(root);
    return { ...result, code: "PRODUCTION_RELEASE_ARCHIVED", archive: "created" };
  } catch (error) {
    if (error instanceof ArchiveRefusal) return failure(error.code);
    return failure("PRODUCTION_RELEASE_ARCHIVE_FAILED");
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  let options;
  try {
    options = parseProductionReleaseArchiveArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error?.code ?? "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID"}\n`
        + "Usage: production-release-archive.mjs --operation ABSOLUTE_JOURNAL_DIRECTORY "
        + "--web-release-receipt ABSOLUTE_RECEIPT --archive ABSOLUTE_OWNER_PRIVATE_DIRECTORY\n",
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await archiveProductionRelease({
    ...options,
    repositoryRoot: resolve(workerDirectory, "../.."),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
