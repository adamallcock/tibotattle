import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openOperation, readOperation } from "../../../scripts/lib/release-operation.mjs";
import { PUBLIC_RELEASE_MANIFEST_SCHEMA } from "../../../scripts/public-release-provenance.js";
import { ADMIN_UI_SHARED_SOURCES } from "./generate-admin-ui-assets.mjs";
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
import { verifyGeneratedCommunityAssetTree } from "./stage-production-assets.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "production-release-archive.mjs");
const RELEASE_OPERATION = new URL("../../../scripts/lib/release-operation.mjs", import.meta.url).href;
// A release ships a site built from its own deploy commit; a rollback ships
// one built from an older commit it names; a deploy that keeps the site
// leaves the retained one live.
const SITE_SOURCE = "e".repeat(40);
const DEPLOY_COMMIT = "6".repeat(40);
const ROLLBACK_SOURCE = "5".repeat(40);
const RETAINED_SOURCE = "9".repeat(40);
const REPLACED_SOURCE = "7".repeat(40);
const REPLACED_MANIFEST = "8".repeat(64);
const LIVE_COMMIT = "a".repeat(40);
const OWNER = "b".repeat(40);
const BUSY = { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_BUSY" };
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

async function absent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" }, path);
}

// The smallest site the staging gate (verifyGeneratedCommunityAssetTree)
// accepts: an index loading the community entry, the SEO files and every
// shared admin dependency, each listed in a release manifest. No real
// release content.
function siteFiles() {
  const files = {
    "index.html": '<!doctype html><title>synthetic</title><script type="module" src="./community.js"></script>\n',
    "community.js": "export const synthetic = true;\n",
    "robots.txt": "User-agent: *\nAllow: /\n",
    "sitemap.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
  };
  for (const name of ADMIN_UI_SHARED_SOURCES) files[name] = `/* synthetic ${name} */\n`;
  return files;
}

// A synthetic checkout: that generated site and a receipt naming its manifest.
async function checkout({ siteSource = SITE_SOURCE } = {}) {
  const root = await privateTemporaryDirectory("release-archive-checkout-");
  const site = join(root, ".release-build", "public-release-site");
  await mkdir(site, { recursive: true });
  const files = siteFiles();
  for (const [path, contents] of Object.entries(files)) await writeFile(join(site, path), contents);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: PUBLIC_RELEASE_MANIFEST_SCHEMA,
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    })),
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

// The lane's verifier, reduced to reading the receipt it was given. The site
// gate is the real one throughout.
function receiptVerifier(expectedRoot, overrides = {}) {
  return async ({ repositoryRoot, receiptPath }) => {
    assert.equal(repositoryRoot, expectedRoot);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    return { receipt: { ...receipt, ...overrides, site: { ...receipt.site, ...overrides.site } } };
  };
}

// A real operation journal, saved as production-deploy saves a finished
// typed deploy, for each site shape a verified deploy can leave live.
async function releaseJournal({
  manifestSha256,
  shape = "candidate",
  siteSource = SITE_SOURCE,
  deploySource = siteSource,
  outcome = "verified",
  state = {},
}) {
  const directory = await privateTemporaryDirectory("release-archive-journal-");
  const site = shape === "retained"
    ? { retainedPublicSourceCommit: siteSource, expectedLiveManifestSha256: manifestSha256 }
    : {
      retainedPublicSourceCommit: REPLACED_SOURCE,
      expectedLiveManifestSha256: REPLACED_MANIFEST,
      candidatePublicManifestSha256: manifestSha256,
      ...(shape === "rollback" ? { candidatePublicSourceCommit: siteSource } : {}),
    };
  const typed = {
    schema: "production-typed-operation-v1",
    liveConfigurationFingerprint: "f".repeat(64),
    predecessorSourceCommit: LIVE_COMMIT,
    ...site,
    expectedSchemaIdentity: { schema: "production-typed-schema-v1" },
  };
  const binding = { sourceCommit: deploySource, previousSourceCommit: LIVE_COMMIT, confirmedMigrations: null, typed };
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
  return { directory, binding };
}

// Hold a journal from another process, the way a running deploy holds it.
async function holdInAnotherProcess(directory, binding) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import { openOperation } from ${JSON.stringify(RELEASE_OPERATION)};`,
      "await openOperation({ directory: process.argv[1], kind: \"production\", binding: JSON.parse(process.argv[2]), resume: true });",
      "process.stdout.write(\"held\\n\");",
      "setInterval(() => {}, 60_000);",
    ].join("\n"),
    directory,
    JSON.stringify(binding),
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("held\n")) resolve();
    });
    exited.then(() => reject(new Error("the holder exited before it held the journal")));
  });
  return {
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
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

async function fixture({ siteSource = SITE_SOURCE, journal = {} } = {}) {
  const repository = await checkout({ siteSource });
  const { directory: operationDirectory, binding } = await releaseJournal({
    manifestSha256: repository.manifestSha256,
    siteSource,
    ...journal,
  });
  const archiveRoot = join(await privateTemporaryDirectory("release-archive-root-"), "archive");
  const run = (overrides = {}) => archiveProductionRelease({
    operationDirectory,
    receiptPath: repository.receiptPath,
    archiveRoot,
    repositoryRoot: repository.root,
    verifyReceipt: receiptVerifier(repository.root),
    ...overrides,
  });
  return { ...repository, operationDirectory, binding, archiveRoot, run };
}

test("a verified typed deploy is archived privately with its receipt, site and a content-free index", async () => {
  const f = await fixture();
  const journalBefore = await listing(f.operationDirectory);
  const siteBefore = await listing(f.site);
  // The fixture's site passes the real staging gate, which the archive runs.
  const siteRows = await verifyGeneratedCommunityAssetTree(f.site);
  const record = await readOperation(f.operationDirectory);
  const result = await f.run();
  assert.deepEqual(result, {
    ok: true,
    code: "PRODUCTION_RELEASE_ARCHIVED",
    archive: "created",
    journalIdentityDigest: record.binding,
    deployCommit: SITE_SOURCE,
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
    ...siteBefore.map(([name]) => `public-release-site/${name}`),
    "web-release-receipt.json",
  ]);
  for (const [name, kind, mode] of archived) assert.equal(mode, kind === "directory" ? "700" : "600", name);
  // Byte-identical copies; the copied site passes the same gate.
  assert.deepEqual(
    archived.filter(([name]) => name.startsWith("journal/")).map(([name, digest]) => [name.slice(8), digest]),
    journalBefore.map(([name, digest]) => [name, digest]),
  );
  assert.deepEqual(
    archived.filter(([name]) => name.startsWith("public-release-site/")).map(([name, digest]) => [name.slice(20), digest]),
    siteBefore.map(([name, digest]) => [name, digest]),
  );
  assert.deepEqual(await verifyGeneratedCommunityAssetTree(join(entry, "public-release-site")), siteRows);
  assert.deepEqual(await readFile(join(entry, "web-release-receipt.json")), await readFile(f.receiptPath));

  // The index holds exactly the content-free identity, no path or journal state.
  const indexText = await readFile(join(entry, "index.json"), "utf8");
  assert.deepEqual(JSON.parse(indexText), {
    schema: PRODUCTION_RELEASE_ARCHIVE_SCHEMA,
    journalIdentityDigest: record.binding,
    deployCommit: SITE_SOURCE,
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

test("each site a verified deploy leaves live is archived and becomes a rollback target", async () => {
  const shapes = [
    // A release: the candidate built from the deploy commit.
    { shape: "candidate", siteSource: SITE_SOURCE, deploySource: SITE_SOURCE },
    // A rollback: the candidate built from the older commit it names.
    { shape: "rollback", siteSource: ROLLBACK_SOURCE, deploySource: DEPLOY_COMMIT },
    // A deploy that kept the site (P1, PROD-5): the retained pair.
    { shape: "retained", siteSource: RETAINED_SOURCE, deploySource: DEPLOY_COMMIT },
  ];
  for (const { shape, siteSource, deploySource } of shapes) {
    const f = await fixture({ siteSource, journal: { shape, deploySource } });
    const record = await readOperation(f.operationDirectory);
    assert.deepEqual(releasedSiteOfOperation(record),
      { manifestSha256: f.manifestSha256, sourceCommit: siteSource, deploySourceCommit: deploySource }, shape);
    const created = await f.run();
    assert.deepEqual(created, {
      ok: true,
      code: "PRODUCTION_RELEASE_ARCHIVED",
      archive: "created",
      journalIdentityDigest: record.binding,
      deployCommit: deploySource,
      sourceCommit: siteSource,
      manifestSha256: f.manifestSha256,
      receiptSha256: sha256(await readFile(f.receiptPath)),
    }, shape);
    assert.deepEqual(await f.run(),
      { ...created, code: "PRODUCTION_RELEASE_ALREADY_ARCHIVED", archive: "already_archived" }, shape);

    // A later website rollback names the archived journal, used in place,
    // with the archived receipt restored.
    const entry = join(f.archiveRoot, record.binding);
    const receipt = JSON.parse(await readFile(join(entry, "web-release-receipt.json"), "utf8"));
    const options = parseProductionDeploymentArgs([
      "--confirm", "DEPLOY_PRODUCTION",
      "--expected-previous-source", "c".repeat(40),
      "--inventory", "/private/inventory.json",
      "--inventory-sha256", "1".repeat(64),
      "--candidate-public-manifest-sha256", f.manifestSha256,
      "--rollback-web-release-receipt", "/synthetic/checkout/.release-build/web-release-receipt.json",
      "--rollback-release-operation", join(entry, "journal"),
      "--replaced-public-source", "d".repeat(40),
      "--replaced-live-manifest-sha256", "3".repeat(64),
      "--edge-mode", "worker",
    ]);
    const resolved = await resolveProductionCandidateSite({
      options,
      workerDirectory: "/synthetic/checkout/apps/worker",
      headCommit: () => "c".repeat(40),
      isAncestor: async () => true,
      verifyReceipt: async () => ({ receipt }),
    });
    assert.equal(resolved.ok, true, `${shape}: ${resolved.code}`);
    assert.equal(resolved.options.candidatePublicSourceCommit, siteSource, shape);
    assert.equal(resolved.options.candidatePublicManifestSha256, f.manifestSha256, shape);
  }
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

test("only a verified, intact typed production journal is archived, and a refusal writes nothing", async () => {
  const refusals = [
    [{ outcome: "deployed_unverified" }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    [{ outcome: "outcome_unknown" }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    // A hand-edited state no longer matches the binding digest.
    [{ state: { sourceCommit: "4".repeat(40) } }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
    [{ state: { typed: undefined } }, "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED"],
  ];
  for (const [journal, code] of refusals) {
    const f = await fixture({ journal });
    const before = await listing(f.operationDirectory);
    assert.deepEqual(await f.run(), { ok: false, code }, JSON.stringify(journal));
    assert.deepEqual(await listing(f.operationDirectory), before);
    await absent(f.archiveRoot);
  }
  const f = await fixture();
  assert.deepEqual(await f.run({ operationDirectory: join(f.operationDirectory, "absent") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_INVALID" });
  assert.deepEqual(await f.run({ readReleaseOperation: async () => ({ ...(await readOperation(f.operationDirectory)), kind: "maintenance" }) }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_NOT_VERIFIED" });
  // A journal that is not private, that holds a link, or whose mutex is
  // missing or not a database.
  await symlink("/dev/null", join(f.operationDirectory, "link"));
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE" });
  await rm(join(f.operationDirectory, "link"));
  await chmod(f.operationDirectory, 0o755);
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_INVALID" });
  await chmod(f.operationDirectory, 0o700);
  await rename(join(f.operationDirectory, "mutex.sqlite"), join(f.operationDirectory, "mutex.parked"));
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE" });
  await writeFile(join(f.operationDirectory, "mutex.sqlite"), "not a database", { mode: 0o600 });
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_OPERATION_UNSAFE" });
  await rm(join(f.operationDirectory, "mutex.sqlite"));
  await rename(join(f.operationDirectory, "mutex.parked"), join(f.operationDirectory, "mutex.sqlite"));
  await absent(f.archiveRoot);
  assert.equal((await f.run()).code, "PRODUCTION_RELEASE_ARCHIVED");
});

test("a journal a live operation holds is busy; a killed holder's leftover is archived as found", async () => {
  const f = await fixture();
  // The deploy's own lock, held in this process.
  const held = await openOperation({ directory: f.operationDirectory, kind: "production", binding: f.binding, resume: true });
  try {
    assert.deepEqual(await f.run(), BUSY);
  } finally {
    held.close();
  }
  await absent(f.archiveRoot);

  // Held by another process, which is then killed while it holds it.
  const holder = await holdInAnotherProcess(f.operationDirectory, f.binding);
  try {
    assert.deepEqual(await f.run(), BUSY);
    await absent(f.archiveRoot);
  } finally {
    await holder.kill();
  }
  // The killed holder leaves a stale mutex.sqlite-journal and no lock: not busy.
  const leftover = await listing(f.operationDirectory);
  assert.deepEqual(leftover.map(([name]) => name), ["mutex.sqlite", "mutex.sqlite-journal", "operation.json"]);
  const result = await f.run();
  assert.equal(result.code, "PRODUCTION_RELEASE_ARCHIVED");
  // The probe never rolls back or removes the leftover; the journal is
  // archived byte for byte, as found.
  assert.deepEqual(await listing(f.operationDirectory), leftover);
  assert.deepEqual(
    (await listing(join(f.archiveRoot, result.journalIdentityDigest, "journal"))).map(([name, digest]) => [name, digest]),
    leftover.map(([name, digest]) => [name, digest]),
  );
  assert.equal((await f.run()).code, "PRODUCTION_RELEASE_ALREADY_ARCHIVED");
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
  // A site changed after the deploy fails the staging gate.
  await writeFile(join(f.site, "community.js"), "export const synthetic = false;\n");
  assert.deepEqual(await f.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  await absent(f.archiveRoot);

  // So does a local-only file beside it, and a missing site.
  const g = await fixture();
  await writeFile(join(g.site, "app.js"), "export const local = true;\n");
  assert.deepEqual(await g.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  await rm(g.site, { recursive: true });
  assert.deepEqual(await g.run(), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SITE_INVALID" });
  await absent(g.archiveRoot);

  // The bytes archived must parse to exactly the receipt the lane verified: a
  // receipt replaced after verification, with the same site and source but
  // another base, is refused.
  const h = await fixture();
  const verify = receiptVerifier(h.root);
  assert.deepEqual(await h.run({
    verifyReceipt: async (input) => {
      const verified = await verify(input);
      await writeFile(h.receiptPath, `${JSON.stringify({ ...verified.receipt, baseCommit: "2".repeat(40) })}\n`);
      return verified;
    },
  }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_SOURCE_CHANGED" });
  await absent(h.archiveRoot);
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

  // The copied site does not pass the gate as the source did.
  const g = await fixture();
  let calls = 0;
  assert.deepEqual(await g.run({
    verifySite: async (directory) => {
      const rows = await verifyGeneratedCommunityAssetTree(directory);
      calls += 1;
      return calls === 1 ? rows : rows.slice(1);
    },
  }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_COPY_UNVERIFIED" });
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(g.archiveRoot), []);

  // The copied receipt is no longer the verified receipt.
  const h = await fixture();
  let siteChecks = 0;
  assert.deepEqual(await h.run({
    verifySite: async (directory) => {
      siteChecks += 1;
      if (siteChecks === 2) await writeFile(join(dirname(directory), "web-release-receipt.json"), "{}\n");
      return verifyGeneratedCommunityAssetTree(directory);
    },
  }), { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_COPY_UNVERIFIED" });
  assert.equal(siteChecks, 2);
  assert.deepEqual(await readdir(h.archiveRoot), []);
});

test("the archive directory is owner-private, outside every repository and apart from the journal", async () => {
  const f = await fixture();
  // Inside the checkout, or under any Git working tree.
  assert.deepEqual(await f.run({ archiveRoot: join(f.root, "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY" });
  await absent(join(f.root, "archive"));
  const other = await privateTemporaryDirectory("release-archive-other-repo-");
  await writeFile(join(other, ".git"), "gitdir: elsewhere\n");
  await mkdir(join(other, "nested"));
  assert.deepEqual(await f.run({ archiveRoot: join(other, "nested", "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_INSIDE_REPOSITORY" });
  // Not private, a symlink, through a linked parent, or with no parent.
  const parent = await privateTemporaryDirectory("release-archive-unsafe-");
  await mkdir(join(parent, "open"), { mode: 0o755 });
  await chmod(join(parent, "open"), 0o755);
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "open") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  await mkdir(join(parent, "real"), { mode: 0o700 });
  await symlink(join(parent, "real"), join(parent, "linked"));
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "linked") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "linked", "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  assert.deepEqual(await readdir(join(parent, "real")), []);
  assert.deepEqual(await f.run({ archiveRoot: join(parent, "missing", "archive") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_DIRECTORY_UNSAFE" });
  await absent(join(parent, "missing"));

  // Never inside the journal: a journal outside the checkout, verified or
  // not, is left exactly as found.
  for (const journal of [{}, { outcome: "deployed_unverified" }]) {
    const g = await fixture({ journal });
    const before = await listing(g.operationDirectory);
    for (const archiveRoot of [join(g.operationDirectory, "archive"), join(g.operationDirectory, "a", "archive")]) {
      assert.deepEqual(await g.run({ archiveRoot }),
        { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" }, JSON.stringify(journal));
    }
    assert.deepEqual(await listing(g.operationDirectory), before);
  }
  // Nor is the journal inside the archive.
  await mkdir(f.archiveRoot, { mode: 0o700 });
  assert.deepEqual(await f.run({ operationDirectory: join(f.archiveRoot, "x", "journal") }),
    { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" });
  for (const field of ["operationDirectory", "receiptPath", "archiveRoot", "repositoryRoot"]) {
    assert.deepEqual(await f.run({ [field]: "relative/path" }),
      { ok: false, code: "PRODUCTION_RELEASE_ARCHIVE_ARGUMENTS_INVALID" }, field);
  }
  assert.deepEqual(await readdir(f.archiveRoot), []);
  assert.equal((await f.run()).code, "PRODUCTION_RELEASE_ARCHIVED");
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
