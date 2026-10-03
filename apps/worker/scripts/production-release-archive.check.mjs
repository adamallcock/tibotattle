import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openOperation, readOperation } from "../../../scripts/lib/release-operation.mjs";
import {
  parseProductionDeploymentArgs,
  releasedSiteOfOperation,
  resolveProductionCandidateSite,
} from "./production-deploy.mjs";
import {
  archiveProductionRelease,
  parseProductionReleaseArchiveArgs,
  PRODUCTION_RELEASE_ARCHIVE_SCHEMA,
} from "./production-release-archive.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "production-release-archive.mjs");
const SITE_SOURCE = "e".repeat(40);
const DEPLOY_SOURCE = SITE_SOURCE;
const LIVE_COMMIT = "a".repeat(40);
const OWNER = "b".repeat(40);
const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function privateTemporaryDirectory(prefix) {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

// A synthetic checkout: a generated site whose manifest lists its files, and
// a receipt naming that manifest. No real release content.
async function checkout({ siteSource = SITE_SOURCE } = {}) {
  const root = await privateTemporaryDirectory("release-archive-checkout-");
  const site = join(root, ".release-build", "public-release-site");
  await mkdir(join(site, "assets"), { recursive: true });
  const files = {
    "index.html": "<!doctype html><title>synthetic</title>\n",
    "assets/app.js": "export const synthetic = true;\n",
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(site, path), contents);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "synthetic-manifest",
    files: Object.entries(files).map(([path, contents]) => ({ path, sha256: sha256(contents) })),
  })}\n`);
  await writeFile(join(site, "release-site-manifest.json"), manifestBytes);
  const manifestSha256 = sha256(manifestBytes);
  const receiptPath = join(root, ".release-build", "web-release-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: "synthetic-receipt",
    kind: "web-only",
    baseCommit: LIVE_COMMIT,
    sourceCommit: siteSource,
    site: { manifestPath: ".release-build/public-release-site/release-site-manifest.json", manifestSha256 },
  })}\n`);
  return { root, site, receiptPath, manifestSha256 };
}

// The lane's verifier, reduced to reading the receipt it was given.
function receiptVerifier(expectedRoot, overrides = {}) {
  return async ({ repositoryRoot, receiptPath }) => {
    assert.equal(repositoryRoot, expectedRoot);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    return { receipt: { ...receipt, ...overrides, site: { ...receipt.site, ...overrides.site } } };
  };
}

// The staging gate, reduced to: every file but the manifest is listed in the
// manifest with its sha256, and nothing else is present.
async function siteVerifier(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "release-site-manifest.json"), "utf8"));
  const expected = new Map(manifest.files.map((row) => [row.path, row.sha256]));
  const rows = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error("unsafe entry");
      const name = relative(directory, path).split(sep).join("/");
      const bytes = await readFile(path);
      if (name !== "release-site-manifest.json" && expected.get(name) !== sha256(bytes)) {
        throw new Error("Generated public asset changed after release build");
      }
      rows.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit(directory);
  if (rows.length !== expected.size + 1) throw new Error("Generated public output does not match its release manifest.");
  return rows;
}

async function releaseJournal({ manifestSha256, siteSource = SITE_SOURCE, outcome = "verified", state = {} }) {
  const directory = await privateTemporaryDirectory("release-archive-journal-");
  const typed = {
    schema: "production-typed-operation-v1",
    liveConfigurationFingerprint: "f".repeat(64),
    predecessorSourceCommit: LIVE_COMMIT,
    retainedPublicSourceCommit: "9".repeat(40),
    expectedLiveManifestSha256: "8".repeat(64),
    candidatePublicManifestSha256: manifestSha256,
    expectedSchemaIdentity: { schema: "production-typed-schema-v1" },
  };
  const binding = { sourceCommit: siteSource, previousSourceCommit: LIVE_COMMIT, confirmedMigrations: null, typed };
  const operation = await openOperation({ directory, kind: "production", binding });
  try {
    await operation.save({
      owner: OWNER,
      ...binding,
      stage: outcome === "verified" ? "verified" : "failed",
      outcome,
      code: outcome === "verified" ? "PRODUCTION_DEPLOYED" : "PRODUCTION_POST_DEPLOY_SOURCE_MISMATCH",
      lock: outcome === "verified" ? "released" : "held",
      ...state,
    });
  } finally {
    operation.close();
  }
  return directory;
}

async function listing(root) {
  const rows = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        rows.push([name, "directory", (info.mode & 0o777).toString(8)]);
        await visit(path);
      } else {
        rows.push([name, sha256(await readFile(path)), (info.mode & 0o777).toString(8)]);
      }
    }
  }
  await visit(root);
  return rows;
}

async function fixture(options = {}) {
  const repository = await checkout(options);
  const operationDirectory = await releaseJournal({ manifestSha256: repository.manifestSha256, ...options.journal });
  const archiveRoot = join(await privateTemporaryDirectory("release-archive-root-"), "archive");
  const run = (overrides = {}) => archiveProductionRelease({
    operationDirectory,
    receiptPath: repository.receiptPath,
    archiveRoot,
    repositoryRoot: repository.root,
    verifyReceipt: receiptVerifier(repository.root),
    verifySite: siteVerifier,
    ...overrides,
  });
  return { ...repository, operationDirectory, archiveRoot, run };
}

test("a verified typed deploy is archived privately with its receipt, site and a content-free index", async () => {
  const f = await fixture();
  const journalBefore = await listing(f.operationDirectory);
  const siteBefore = await listing(f.site);
  const record = await readOperation(f.operationDirectory);
  const result = await f.run();
  assert.deepEqual(result, {
    ok: true,
    code: "PRODUCTION_RELEASE_ARCHIVED",
    archive: "created",
    journalIdentityDigest: record.binding,
    deployCommit: DEPLOY_SOURCE,
    sourceCommit: SITE_SOURCE,
    manifestSha256: f.manifestSha256,
    receiptSha256: sha256(await readFile(f.receiptPath)),
  });
  // The inputs are unchanged.
  assert.deepEqual(await listing(f.operationDirectory), journalBefore);
  assert.deepEqual(await listing(f.site), siteBefore);

  // One entry, named by the journal's identity digest, private throughout.
  assert.deepEqual(await readdir(f.archiveRoot), [record.binding]);
  assert.equal((await lstat(f.archiveRoot)).mode & 0o777, 0o700);
  const entry = join(f.archiveRoot, record.binding);
  const archived = await listing(entry);
  assert.deepEqual(archived.map(([name]) => name), [
    "index.json",
    "journal",
    "journal/mutex.sqlite",
    "journal/operation.json",
    "public-release-site",
    "public-release-site/assets",
    "public-release-site/assets/app.js",
    "public-release-site/index.html",
    "public-release-site/release-site-manifest.json",
    "web-release-receipt.json",
  ]);
  for (const [name, kind, mode] of archived) assert.equal(mode, kind === "directory" ? "700" : "600", name);
  // Byte-identical copies.
  assert.deepEqual(
    archived.filter(([name]) => name.startsWith("journal/")).map(([name, digest]) => [name.slice(8), digest]),
    journalBefore.map(([name, digest]) => [name, digest]),
  );
  assert.deepEqual(
    archived.filter(([name]) => name.startsWith("public-release-site/")).map(([name, kind]) => [name.slice(20), kind]),
    siteBefore.map(([name, kind]) => [name, kind]),
  );
  assert.deepEqual(await readFile(join(entry, "web-release-receipt.json")), await readFile(f.receiptPath));

  // The index holds exactly the content-free identity, no path or journal state.
  const indexText = await readFile(join(entry, "index.json"), "utf8");
  assert.deepEqual(JSON.parse(indexText), {
    schema: PRODUCTION_RELEASE_ARCHIVE_SCHEMA,
    journalIdentityDigest: record.binding,
    deployCommit: DEPLOY_SOURCE,
    sourceCommit: SITE_SOURCE,
    manifestSha256: f.manifestSha256,
    receiptSha256: sha256(await readFile(f.receiptPath)),
  });
  assert.equal(indexText.includes("/"), false);
  assert.equal(JSON.stringify(result).includes("/"), false);

  // The archived journal is still the same verified release.
  const archivedRecord = await readOperation(join(entry, "journal"));
  assert.deepEqual(archivedRecord, record);
  assert.deepEqual(releasedSiteOfOperation(archivedRecord), releasedSiteOfOperation(record));
});

test("a website rollback names the archived journal", async () => {
  const f = await fixture();
  const { journalIdentityDigest } = await f.run();
  const archivedJournal = join(f.archiveRoot, journalIdentityDigest, "journal");
  const receipt = JSON.parse(await readFile(join(f.archiveRoot, journalIdentityDigest, "web-release-receipt.json"), "utf8"));
  const options = parseProductionDeploymentArgs([
    "--confirm", "DEPLOY_PRODUCTION",
    "--expected-previous-source", "c".repeat(40),
    "--inventory", "/private/inventory.json",
    "--inventory-sha256", "1".repeat(64),
    "--candidate-public-manifest-sha256", f.manifestSha256,
    "--rollback-web-release-receipt", "/synthetic/checkout/.release-build/web-release-receipt.json",
    "--rollback-release-operation", archivedJournal,
    "--replaced-public-source", "d".repeat(40),
    "--replaced-live-manifest-sha256", "7".repeat(64),
    "--edge-mode", "worker",
  ]);
  const resolved = await resolveProductionCandidateSite({
    options,
    workerDirectory: "/synthetic/checkout/apps/worker",
    headCommit: () => "c".repeat(40),
    isAncestor: async () => true,
    verifyReceipt: async () => ({ receipt }),
  });
  assert.equal(resolved.ok, true, resolved.code);
  assert.equal(resolved.options.candidatePublicSourceCommit, SITE_SOURCE);
  assert.equal(resolved.options.candidatePublicManifestSha256, f.manifestSha256);
});

test("archiving is idempotent and never overwrites a different entry", async () => {
  const f = await fixture();
  const first = await f.run();
  const entry = join(f.archiveRoot, first.journalIdentityDigest);
  const archived = await listing(entry);
  const second = await f.run();
  assert.deepEqual(second, { ...first, code: "PRODUCTION_RELEASE_ALREADY_ARCHIVED", archive: "already_archived" });
  assert.deepEqual(await listing(entry), archived);
  assert.deepEqual(await readdir(f.archiveRoot), [first.journalIdentityDigest]);

  // A changed entry is a conflict and stays exactly as found.
  await chmod(join(entry, "index.json"), 0o600);
  await writeFile(join(entry, "index.json"), "{}\n");
  const changed = await listing(entry);
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_CONFLICT" });
  assert.deepEqual(await listing(entry), changed);
  assert.deepEqual(await readdir(f.archiveRoot), [first.journalIdentityDigest]);

  // So is an extra file, a loosened mode, or a non-directory in its place.
  const g = await fixture();
  const placed = await g.run();
  const gEntry = join(g.archiveRoot, placed.journalIdentityDigest);
  await writeFile(join(gEntry, "extra"), "x", { mode: 0o600 });
  assert.deepEqual(await g.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_CONFLICT" });
  await rm(join(gEntry, "extra"));
  assert.equal((await g.run()).code, "PRODUCTION_RELEASE_ALREADY_ARCHIVED");
  await chmod(join(gEntry, "web-release-receipt.json"), 0o644);
  assert.deepEqual(await g.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_CONFLICT" });
  const h = await fixture();
  const digest = (await readOperation(h.operationDirectory)).binding;
  await mkdir(h.archiveRoot, { mode: 0o700 });
  await writeFile(join(h.archiveRoot, digest), "not an archive", { mode: 0o600 });
  assert.deepEqual(await h.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_CONFLICT" });
  assert.deepEqual(await readdir(h.archiveRoot), [digest]);
});

test("only a verified, intact, idle typed production journal is archived", async () => {
  const refusals = [
    [{ outcome: "deployed_unverified" }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    [{ outcome: "outcome_unknown" }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    // A hand-edited state no longer matches the binding digest.
    [{ state: { sourceCommit: "4".repeat(40) } }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    [{ state: { typed: undefined } }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
  ];
  for (const [journal, code] of refusals) {
    const f = await fixture({ journal });
    assert.deepEqual(await f.run(), { ok: false, code }, JSON.stringify(journal));
    assert.deepEqual(await readdir(f.archiveRoot), []);
  }
  const f = await fixture();
  assert.deepEqual(await f.run({ operationDirectory: join(f.operationDirectory, "absent") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_INVALID" });
  assert.deepEqual(await f.run({ readReleaseOperation: async () => ({ ...(await readOperation(f.operationDirectory)), kind: "maintenance" }) }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED" });
  // A journal held by a running operation.
  await writeFile(join(f.operationDirectory, "mutex.sqlite-journal"), "", { mode: 0o600 });
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_BUSY" });
  await rm(join(f.operationDirectory, "mutex.sqlite-journal"));
  // A journal that is not private, or that holds a link.
  await symlink("/dev/null", join(f.operationDirectory, "link"));
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE" });
  await rm(join(f.operationDirectory, "link"));
  await chmod(f.operationDirectory, 0o755);
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_INVALID" });
  await chmod(f.operationDirectory, 0o700);
  assert.equal((await f.run()).code, "PRODUCTION_RELEASE_ARCHIVED");
});

test("the receipt and site must be the ones the journal left live", async () => {
  const f = await fixture();
  assert.deepEqual(await f.run({ verifyReceipt: async () => { throw new Error("no longer matches the candidate diff"); } }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID" });
  assert.deepEqual(await f.run({ verifyReceipt: async () => ({ receipt: { sourceCommit: "short" } }) }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID" });
  assert.deepEqual(await f.run({ verifyReceipt: receiptVerifier(f.root, { sourceCommit: "4".repeat(40) }) }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_RECEIPT_MISMATCH" });
  assert.deepEqual(await f.run({ verifyReceipt: receiptVerifier(f.root, { site: { manifestSha256: "3".repeat(64) } }) }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_RECEIPT_MISMATCH" });
  // The default verifier is the web-only lane's: this synthetic receipt fails it.
  assert.deepEqual(await f.run({ verifyReceipt: null }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID" });
  // A site changed after the deploy.
  await writeFile(join(f.site, "assets", "app.js"), "export const synthetic = false;\n");
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  // The default site verifier is the staging gate's: this synthetic site fails it.
  const g = await fixture();
  assert.deepEqual(await g.run({ verifySite: undefined }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  await rm(g.site, { recursive: true });
  assert.deepEqual(await g.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  for (const fixtureRoot of [f.archiveRoot, g.archiveRoot]) assert.deepEqual(await readdir(fixtureRoot), []);
});

test("a journal that moves during the copy, or a copy that does not verify, leaves no entry", async () => {
  const f = await fixture();
  const verify = receiptVerifier(f.root);
  assert.deepEqual(await f.run({
    verifyReceipt: async (input) => {
      await writeFile(join(f.operationDirectory, "mutex.sqlite"), "moved");
      return verify(input);
    },
  }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED" });
  assert.deepEqual(await readdir(f.archiveRoot), []);
  const g = await fixture();
  let calls = 0;
  assert.deepEqual(await g.run({
    verifySite: async (directory) => {
      const rows = await siteVerifier(directory);
      calls += 1;
      return calls === 1 ? rows : rows.slice(1);
    },
  }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_COPY_UNVERIFIED" });
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(g.archiveRoot), []);
});

test("the archive directory is owner-private and outside every repository", async () => {
  const f = await fixture();
  // Inside the checkout, or under any Git working tree.
  assert.deepEqual(await f.run({ archiveRoot: join(f.root, "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY" });
  const other = await privateTemporaryDirectory("release-archive-other-repo-");
  await writeFile(join(other, ".git"), "gitdir: elsewhere\n");
  await mkdir(join(other, "nested"));
  assert.deepEqual(await f.run({ archiveRoot: join(other, "nested", "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY" });
  // Not private, a symlink, or with no parent.
  const parent = await privateTemporaryDirectory("release-archive-unsafe-");
  await mkdir(join(parent, "open"), { mode: 0o755 });
  await chmod(join(parent, "open"), 0o755);
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "open") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  await mkdir(join(parent, "real"), { mode: 0o700 });
  await symlink(join(parent, "real"), join(parent, "linked"));
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "linked") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "missing", "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  // The journal cannot come from inside the archive.
  await mkdir(f.archiveRoot, { mode: 0o700 });
  assert.deepEqual(await f.run({ operationDirectory: join(f.archiveRoot, "x", "journal") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" });
  for (const field of ["operationDirectory", "receiptPath", "archiveRoot", "repositoryRoot"]) {
    assert.deepEqual(await f.run({ [field]: "relative/path" }),
      { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" }, field);
  }
});

test("the CLI takes exactly three absolute arguments", () => {
  const argv = ["--operation", "/o", "--web-release-receipt", "/r.json", "--archive", "/a"];
  assert.deepEqual(parseProductionReleaseArchiveArgs(argv),
    { operationDirectory: "/o", receiptPath: "/r.json", archiveRoot: "/a" });
  for (const bad of [
    argv.slice(0, 4),
    [...argv, "--archive", "/b"],
    ["--operation", "relative", ...argv.slice(2)],
    ["--operation", "--archive", ...argv.slice(2)],
    [...argv.slice(0, 4), "--force", "/a"],
  ]) {
    assert.throws(() => parseProductionReleaseArchiveArgs(bad), { code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" });
  }
  const run = spawnSync(process.execPath, [SCRIPT, "--operation", "relative"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID\n/u);
  assert.equal(run.stdout, "");
});
