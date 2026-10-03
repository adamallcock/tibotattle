import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_REVISION_FLOOR_FILE,
  CUTOVER_REVISION_FLOOR_SCHEMA,
  REVISION_FLOOR_MAX_DAYS,
  REVISION_FLOOR_TABLES,
  RevisionFloorError,
  assertRevisionFloorBinding,
  assertRevisionFloorCoversFrozen,
  captureRevisionFloor,
  checkRevisionFloor,
  parseRevisionFloorFile,
  parseRevisionFloorArguments,
  readRevisionFloorFile,
  renderRevisionFloorFile,
  revisionFloorSealFacts,
  writeSyntheticRevisionFloor,
} from "./cutover-revision-floor.mjs";
import {
  CUTOVER_ANALYTICS_FLOOR_ROLE,
  CUTOVER_REVISION_FLOOR_STATEMENT,
  CUTOVER_REVISION_FLOOR_STATEMENT_SHA256,
  CutoverSourceError,
  canonicalJson,
  createWranglerCutoverTransport,
  guardCutoverTransport,
  readCutoverSeal,
  sha256Hex,
  validateCutoverInventory,
} from "./cutover-source-seal.mjs";
import { writeAnalyticsSourceFixture, SYNTHETIC_ANALYTICS_DATABASE_NAME } from "../postgres-test/fixtures/w2-seal/admin-history-fixtures.mjs";
import { SYNTHETIC_ACCOUNT_ID, SYNTHETIC_BOOKMARKS, SYNTHETIC_D1 } from "../postgres-test/fixtures/w2-seal/fence-fixtures.mjs";
import { headCommit, outputPathsOf, prepareSealWorld, sealWorld, writeFakeWranglerCli } from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { createFakeCutoverTransport, privateDirectory } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// REV-SEED (owner decisions round 14): the revision-floor capture over a
// synthetic W2-SEAL seal, its EP-8 fence fixture and a synthetic analytics D1
// carrying d43c8f92's two community daily publication tables; the floor
// file's closed format; its binding and the C-IPR cross-check; the dress
// rehearsal's synthetic floor; the pinned read role's refusals. The provider
// is never contacted: an injected fake transport, or the default Wrangler
// transport behind an injected spawn and a stand-in CLI.
// Run: node --test ./scripts/cutover-revision-floor.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = headCommit(WORKER_ROOT);
const SOURCE_A = "synthetic-analytics-source-a";
const SOURCE_B = "synthetic-analytics-source-b";
const DRIFTED = "00000001-22222222-00000008";
let world;
let seal;
let sealed;
let directory;
let analyticsPath;
let analyticsSourcePath;

const isCode = code => error => (error instanceof CutoverSourceError || error instanceof RevisionFloorError)
  && error.code === code;

/**
 * A synthetic analytics D1 with d43c8f92's analytics_community_daily_heads and
 * _publications (0007's columns), two source ids, a withheld day's older
 * publication row, and a day whose superseded publications were retired.
 */
function buildFloorD1(name, { heads, publications }) {
  const path = join(directory, name);
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE analytics_community_daily_publications (
       source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
       cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
       released_at TEXT NOT NULL,PRIMARY KEY(source_id,day,revision)) STRICT, WITHOUT ROWID;
     CREATE TABLE analytics_community_daily_heads (
       source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
       cohort_digest TEXT NOT NULL,PRIMARY KEY(source_id,day)) STRICT, WITHOUT ROWID;
     CREATE TABLE analytics_community_daily_queue (
       source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
       PRIMARY KEY(source_id,day)) STRICT, WITHOUT ROWID;`);
    const head = database.prepare("INSERT INTO analytics_community_daily_heads VALUES (?, ?, ?, 'cohort')");
    for (const [source, day, revision] of heads) head.run(source, day, revision);
    const publication = database.prepare(`INSERT INTO analytics_community_daily_publications
      VALUES (?, ?, ?, 'cohort', '{}', '{}', 'sha', '2026-10-01T00:00:00.000Z')`);
    for (const [source, day, revision] of publications) publication.run(source, day, revision);
    // The work counter is not a published revision and must not be read.
    database.prepare("INSERT INTO analytics_community_daily_queue VALUES (?, ?, ?)").run(SOURCE_A, "2026-09-28", 999);
  } finally {
    database.close();
  }
  return path;
}

const HEADS = [[SOURCE_A, "2026-09-28", 4], [SOURCE_A, "2026-09-29", 1], [SOURCE_B, "2026-09-28", 7],
  [SOURCE_A, "2026-09-30", 2]];
const PUBLICATIONS = [[SOURCE_A, "2026-09-28", 3], [SOURCE_A, "2026-09-28", 4], [SOURCE_A, "2026-09-29", 1],
  [SOURCE_B, "2026-09-28", 7], [SOURCE_A, "2026-09-27", 2]];
// 09-27: only a publication row (its head is not yet visible to a reader of
// heads alone); 09-28: the larger revision over both source ids; 09-30: a head
// whose publication rows were retired.
const EXPECTED_DAYS = [["2026-09-27", 2], ["2026-09-28", 7], ["2026-09-29", 1], ["2026-09-30", 2]];

before(async () => {
  world = await prepareSealWorld({ commit: COMMIT });
  const run = await sealWorld(world);
  const result = await run.run();
  seal = { manifestPath: outputPathsOf(run.out).manifest, sealId: result.sealId };
  sealed = await readCutoverSeal({ manifestPath: seal.manifestPath, expectedSealId: seal.sealId });
  directory = await privateDirectory("rev-seed-check-");
  analyticsPath = buildFloorD1("analytics-floor.sqlite", { heads: HEADS, publications: PUBLICATIONS });
  analyticsSourcePath = await writeAnalyticsSourceFixture({ directory });
});

after(async () => {
  await world?.dispose();
});

function capture({ ownerDirectory, bookmarks = {}, tamper = null, calls = [], path = analyticsPath, ...overrides } = {}) {
  return captureRevisionFloor({
    inventoryPath: world.inventory.path, manifestPath: seal.manifestPath, sealId: seal.sealId, analyticsSourcePath,
    fenceReceiptPath: world.fence.path, ownerDirectory, execute: true, remote: true, ownerReadOnly: true,
    transport: createFakeCutoverTransport({ sources: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: path },
      bookmarks: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: SYNTHETIC_BOOKMARKS.analytics, ...bookmarks }, tamper, calls }),
    now: () => new Date("2026-10-02T01:30:00.000Z"),
    ...overrides,
  });
}

/** A valid synthetic floor body bound to the test seal. */
function body(days = EXPECTED_DAYS, overrides = {}) {
  return { schema: CUTOVER_REVISION_FLOOR_SCHEMA, provenance: "synthetic", ...revisionFloorSealFacts(sealed),
    capturedAt: "2026-10-02T01:30:00.000Z", capture: null, days, dayCount: days.length,
    maxRevision: Math.max(...days.map(([, revision]) => revision)), ...overrides };
}

test("the pinned read role admits exactly its one statement and is never sealable", async () => {
  assert.equal(sha256Hex(CUTOVER_REVISION_FLOOR_STATEMENT), CUTOVER_REVISION_FLOOR_STATEMENT_SHA256);
  assert.match(CUTOVER_REVISION_FLOOR_STATEMENT, /analytics_community_daily_heads/u);
  assert.match(CUTOVER_REVISION_FLOOR_STATEMENT, /analytics_community_daily_publications/u);
  assert.doesNotMatch(CUTOVER_REVISION_FLOOR_STATEMENT, /queue|source_id|payload/u, "days and revisions only");
  assert.match(CUTOVER_REVISION_FLOOR_STATEMENT, new RegExp(`LIMIT ${REVISION_FLOOR_MAX_DAYS + 1}$`, "u"));
  const source = { role: CUTOVER_ANALYTICS_FLOOR_ROLE, binding: "ANALYTICS_DB", databaseName: SYNTHETIC_ANALYTICS_DATABASE_NAME,
    databaseId: SYNTHETIC_D1.analytics };
  const scope = { accountId: SYNTHETIC_ACCOUNT_ID, sources: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: source } };
  const calls = [];
  const guarded = guardCutoverTransport(createFakeCutoverTransport({ sources: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: analyticsPath },
    bookmarks: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: SYNTHETIC_BOOKMARKS.analytics }, calls }), scope);
  for (const sql of ["SELECT 1", "SELECT day,revision FROM analytics_community_daily_heads",
    `${CUTOVER_REVISION_FLOOR_STATEMENT} `, CUTOVER_REVISION_FLOOR_STATEMENT.replace("4001", "4002"),
    "SELECT payload_json FROM analytics_community_daily_publications", "SELECT name FROM sqlite_schema"]) {
    await assert.rejects(guarded.query(source, sql), isCode("CUTOVER_FLOOR_STATEMENT_REFUSED"), sql);
  }
  // The SELECT-only rule still comes first.
  await assert.rejects(guarded.query(source, "DELETE FROM analytics_community_daily_heads"),
    isCode("CUTOVER_REMOTE_SQL_NOT_SELECT"));
  assert.deepEqual(calls, [], "no refused statement reached the transport");
  assert.equal((await guarded.query(source, CUTOVER_REVISION_FLOOR_STATEMENT)).length, EXPECTED_DAYS.length);
  // The default Wrangler transport refuses it too, before any spawn.
  const transportDirectory = await privateDirectory("rev-seed-transport-");
  let spawned = 0;
  const wrangler = createWranglerCutoverTransport({ inventory: scope, transportDirectory, remote: true, ownerReadOnly: true,
    spawn: () => { spawned += 1; return { status: 1 }; }, environment: {} });
  await assert.rejects(wrangler.query(source, "SELECT 1"), isCode("CUTOVER_FLOOR_STATEMENT_REFUSED"));
  assert.equal(spawned, 0);
  assert.deepEqual(await readdir(transportDirectory), []);
  // Another role is not narrowed by the pin, and no inventory may name this one.
  assert.equal((await guardCutoverTransport(createFakeCutoverTransport({ sources: { analytics: analyticsPath },
    bookmarks: {} }), { accountId: SYNTHETIC_ACCOUNT_ID, sources: { analytics: { ...source, role: "analytics" } } })
    .query({ ...source, role: "analytics" }, "SELECT 1 AS n")).length, 1);
  const inventory = JSON.parse(await readFile(world.inventory.path, "utf8"));
  assert.throws(() => validateCutoverInventory({ ...inventory, sources: [...inventory.sources,
    { role: CUTOVER_ANALYTICS_FLOOR_ROLE, binding: "ANALYTICS_DB", databaseName: SYNTHETIC_ANALYTICS_DATABASE_NAME,
      databaseId: SYNTHETIC_D1.analytics, ledgers: {} }] }), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
});

test("a dry run reads local files only and spawns nothing", async () => {
  const out = await privateDirectory("rev-seed-dry-");
  const calls = [];
  const result = await capture({ ownerDirectory: out, execute: false, calls });
  assert.deepEqual(result, { mode: "dry-run", sealId: seal.sealId, fenceReceiptSha256: world.fence.sha256,
    analyticsDatabaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`), statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 });
  await assert.rejects(capture({ ownerDirectory: out, ownerReadOnly: false, calls }), isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(out), []);
});

test("captures the per-day maximum over every source id, bracketed by the fenced bookmark, deterministic and content-free", async () => {
  const out = await privateDirectory("rev-seed-capture-");
  const calls = [];
  const result = await capture({ ownerDirectory: out, calls });
  assert.deepEqual(calls.map(call => [call.kind, call.role]), [["bookmark", CUTOVER_ANALYTICS_FLOOR_ROLE],
    ["query", CUTOVER_ANALYTICS_FLOOR_ROLE], ["bookmark", CUTOVER_ANALYTICS_FLOOR_ROLE]]);
  assert.deepEqual(await readdir(out), [CUTOVER_REVISION_FLOOR_FILE]);
  const path = join(out, CUTOVER_REVISION_FLOOR_FILE);
  assert.equal((await lstat(path)).mode & 0o777, 0o400);
  const text = await readFile(path, "utf8");
  assert.equal(sha256Hex(text), result.floorSha256);
  assert.deepEqual({ ...result, path: undefined }, { mode: "captured", path: undefined, floorSha256: result.floorSha256,
    dayCount: 4, maxRevision: 7, firstDay: "2026-09-27", lastDay: "2026-09-30" });
  const value = JSON.parse(text);
  assert.equal(`${canonicalJson(value)}\n`, text);
  assert.deepEqual(value, { schema: CUTOVER_REVISION_FLOOR_SCHEMA, provenance: "captured", sealId: seal.sealId,
    fenceReceiptSha256: world.fence.sha256, sourceCommit: COMMIT, capturedAt: "2026-10-02T01:30:00.000Z",
    capture: { analyticsDatabaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`),
      analyticsBookmarkSha256: sha256Hex(SYNTHETIC_BOOKMARKS.analytics), statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 },
    days: EXPECTED_DAYS, dayCount: 4, maxRevision: 7 });
  // (The queue's work counter, 999 on 2026-09-28, is not a published revision and was not read.)
  for (const secret of [SOURCE_A, SOURCE_B, SYNTHETIC_BOOKMARKS.analytics, SYNTHETIC_D1.analytics, SYNTHETIC_ACCOUNT_ID,
    SYNTHETIC_ANALYTICS_DATABASE_NAME]) {
    assert.equal(text.includes(secret), false, `no ${secret} in the file`);
    assert.equal(JSON.stringify(result).includes(secret), false, `no ${secret} in the result`);
  }
  const read = await readRevisionFloorFile({ path, expectedSha256: result.floorSha256 });
  assert.deepEqual(read.days, EXPECTED_DAYS);
  assert.equal(read.floorSha256, result.floorSha256);
  assertRevisionFloorBinding(read, revisionFloorSealFacts(sealed));
  // The same fence and the same instant give the same bytes; an existing file is never overwritten.
  const again = await capture({ ownerDirectory: await privateDirectory("rev-seed-capture-again-") });
  assert.equal(again.floorSha256, result.floorSha256);
  await assert.rejects(capture({ ownerDirectory: out }), isCode("CUTOVER_OUTPUT_EXISTS"));
  assert.equal(sha256Hex(await readFile(path)), result.floorSha256);
});

test("refuses a moved bookmark and any response that is not a closed, bounded floor, leaving nothing", async () => {
  const refuse = async (overrides, code, label) => {
    const out = await privateDirectory("rev-seed-refuse-");
    await assert.rejects(capture({ ownerDirectory: out, ...overrides }), isCode(code), label);
    assert.deepEqual(await readdir(out), [], `${label}: nothing is left`);
  };
  await refuse({ bookmarks: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: DRIFTED } }, "CUTOVER_SOURCE_BOOKMARK_DRIFT", "B0 is not the fence pin");
  await refuse({ bookmarks: { [CUTOVER_ANALYTICS_FLOOR_ROLE]: call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics : DRIFTED) } },
    "CUTOVER_SOURCE_BOOKMARK_DRIFT", "B1 differs from B0");
  const rows = (mutate) => ({ tamper: (role, sql, result) => mutate(result.map(row => ({ ...row }))) });
  await refuse(rows(() => []), "REVISION_FLOOR_EMPTY", "no published day");
  await refuse(rows(result => result.map((row, index) => (index === 1 ? { ...row, day: "2026-02-30" } : row))),
    "REVISION_FLOOR_DAY_INVALID", "not a calendar day");
  await refuse(rows(result => result.map((row, index) => (index === 1 ? { ...row, day: "2026-9-28" } : row))),
    "REVISION_FLOOR_DAY_INVALID", "not YYYY-MM-DD");
  await refuse(rows(result => [...result, result[0]]), "REVISION_FLOOR_DAY_INVALID", "a repeated day");
  await refuse(rows(result => [...result].reverse()), "REVISION_FLOOR_DAY_INVALID", "out of order");
  await refuse(rows(result => result.map((row, index) => (index === 1 ? { ...row, revision: 0 } : row))),
    "REVISION_FLOOR_REVISION_INVALID", "revision 0");
  await refuse(rows(result => result.map((row, index) => (index === 1 ? { ...row, revision: 2_000_000_001 } : row))),
    "REVISION_FLOOR_REVISION_INVALID", "over the seed bound");
  await refuse(rows(result => result.map((row, index) => (index === 1 ? { ...row, revision: "7" } : row))),
    "REVISION_FLOOR_REVISION_INVALID", "a text revision");
  await refuse(rows(result => result.map(row => ({ ...row, source_id: SOURCE_A }))), "CUTOVER_REMOTE_RESPONSE_INVALID",
    "an extra column");
  // More days than the bound (LIMIT 4001 shows the overflow).
  const start = Date.parse("2010-01-01T00:00:00.000Z");
  const many = Array.from({ length: REVISION_FLOOR_MAX_DAYS + 1 }, (_, index) =>
    [SOURCE_A, new Date(start + index * 86_400_000).toISOString().slice(0, 10), 1]);
  await refuse({ path: buildFloorD1(`analytics-many-${randomUUID()}.sqlite`, { heads: many, publications: [] }) },
    "REVISION_FLOOR_TOO_LARGE", "4,001 days");
});

test("refuses an analytics source that is a sealed D1 or not the fenced one, and a foreign seal, before any read", async () => {
  for (const [options, code] of [[{ databaseId: SYNTHETIC_D1.ingestion }, "CUTOVER_SOURCE_NOT_ALLOWED"],
    [{ databaseId: SYNTHETIC_D1["catchup-control"] }, "CUTOVER_FENCE_SOURCE_MISMATCH"],
    [{ databaseId: randomUUID() }, "CUTOVER_FENCE_SOURCE_MISMATCH"]]) {
    const path = await writeAnalyticsSourceFixture({ directory, name: `analytics-source-${randomUUID()}.json`, ...options });
    const calls = [];
    await assert.rejects(capture({ ownerDirectory: await privateDirectory("rev-seed-source-"), analyticsSourcePath: path, calls }),
      isCode(code), JSON.stringify(options));
    assert.deepEqual(calls, []);
  }
  const calls = [];
  await assert.rejects(capture({ ownerDirectory: await privateDirectory("rev-seed-seal-"), sealId: "e".repeat(64), calls }),
    isCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  await assert.rejects(capture({ ownerDirectory: await privateDirectory("rev-seed-fence-"), fenceReceiptPath: world.proof.path,
    calls }), isCode("CUTOVER_FENCE_RECEIPT_INVALID"));
  assert.deepEqual(calls, []);
});

test("the default Wrangler transport leaves only the floor, or nothing", async () => {
  const cliPath = await writeFakeWranglerCli(await privateDirectory("rev-seed-cli-"));
  const spawn = ({ bookmark = () => SYNTHETIC_BOOKMARKS.analytics, calls = [] } = {}) => {
    let bookmarks = 0;
    return (command, args) => {
      const configPath = args[args.indexOf("--config") + 1];
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.d1_databases?.[0]?.database_id !== SYNTHETIC_D1.analytics) return { status: 1, stdout: "" };
      calls.push(statSync(configPath).mode & 0o777);
      if (args.includes("time-travel")) {
        bookmarks += 1;
        return { status: 0, signal: null, stdout: JSON.stringify({ bookmark: bookmark(bookmarks) }), stderr: "" };
      }
      const flag = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const sql = readFileSync(flag("--tibo-query-path"), "utf8");
      if (sha256Hex(sql) !== flag("--tibo-query-sha256") || sql !== CUTOVER_REVISION_FLOOR_STATEMENT) return { status: 1, stdout: "" };
      const database = new DatabaseSync(analyticsPath, { readOnly: true });
      try {
        const results = database.prepare(sql).all().map(row => ({ ...row }));
        return { status: 0, signal: null, stdout: JSON.stringify([{ results, success: true, meta: {} }]), stderr: "" };
      } finally {
        database.close();
      }
    };
  };
  const base = { transport: undefined, cliPath, environment: {} };
  const out = await privateDirectory("rev-seed-default-");
  const calls = [];
  const result = await capture({ ownerDirectory: out, ...base, spawn: spawn({ calls }) });
  assert.equal(result.dayCount, EXPECTED_DAYS.length);
  assert.deepEqual(await readdir(out), [CUTOVER_REVISION_FLOOR_FILE]);
  assert.ok(calls.length === 3 && calls.every(mode => mode === 0o600));
  const failed = await privateDirectory("rev-seed-default-drift-");
  await assert.rejects(capture({ ownerDirectory: failed, ...base,
    spawn: spawn({ bookmark: call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics : DRIFTED) }) }),
  isCode("CUTOVER_SOURCE_BOOKMARK_DRIFT"));
  assert.deepEqual(await readdir(failed), [], "no pinned config and no floor is left");
});

test("the floor file is a closed, canonical format read only at its pin", async () => {
  const valid = renderRevisionFloorFile(body());
  const bytes = text => new TextEncoder().encode(text);
  assert.deepEqual(parseRevisionFloorFile(bytes(valid.text), valid.floorSha256).days, EXPECTED_DAYS);
  const reseal = value => `${canonicalJson(value)}\n`;
  const invalid = {
    "another pin": [valid.text, "0".repeat(64), "REVISION_FLOOR_FILE_INVALID"],
    "not canonical": [JSON.stringify(body(), null, 2), null, "REVISION_FLOOR_FILE_INVALID"],
    "an extra key": [reseal({ ...body(), extra: 1 }), null, "REVISION_FLOOR_FILE_INVALID"],
    "another schema": [reseal(body(EXPECTED_DAYS, { schema: "tibotattle-cutover-revision-floor-v0" })), null,
      "REVISION_FLOOR_FILE_INVALID"],
    "an unknown provenance": [reseal(body(EXPECTED_DAYS, { provenance: "inferred" })), null, "REVISION_FLOOR_FILE_INVALID"],
    "synthetic with a capture": [reseal(body(EXPECTED_DAYS, { capture: { analyticsDatabaseIdSha256: "1".repeat(64),
      analyticsBookmarkSha256: "2".repeat(64), statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 } })), null,
    "REVISION_FLOOR_FILE_INVALID"],
    "captured without one": [reseal(body(EXPECTED_DAYS, { provenance: "captured" })), null, "REVISION_FLOOR_FILE_INVALID"],
    "captured by another statement": [reseal(body(EXPECTED_DAYS, { provenance: "captured", capture: {
      analyticsDatabaseIdSha256: "1".repeat(64), analyticsBookmarkSha256: "2".repeat(64), statementSha256: "3".repeat(64) } })),
    null, "REVISION_FLOOR_FILE_INVALID"],
    "a wrong day count": [reseal(body(EXPECTED_DAYS, { dayCount: 5 })), null, "REVISION_FLOOR_FILE_INVALID"],
    "a wrong maximum": [reseal(body(EXPECTED_DAYS, { maxRevision: 8 })), null, "REVISION_FLOOR_FILE_INVALID"],
    "a non-canonical instant": [reseal(body(EXPECTED_DAYS, { capturedAt: "2026-10-02T01:30:00Z" })), null,
      "REVISION_FLOOR_FILE_INVALID"],
    "a short commit": [reseal(body(EXPECTED_DAYS, { sourceCommit: "abc" })), null, "REVISION_FLOOR_FILE_INVALID"],
    "no days": [reseal(body([], { maxRevision: 1 })), null, "REVISION_FLOOR_EMPTY"],
    "an impossible day": [reseal(body([["2026-02-30", 1]])), null, "REVISION_FLOOR_DAY_INVALID"],
    "days out of order": [reseal(body([...EXPECTED_DAYS].reverse())), null, "REVISION_FLOOR_DAY_INVALID"],
    "a repeated day": [reseal(body([EXPECTED_DAYS[0], EXPECTED_DAYS[0]])), null, "REVISION_FLOOR_DAY_INVALID"],
    "revision 0": [reseal(body([["2026-09-28", 0]], { maxRevision: 0 })), null, "REVISION_FLOOR_REVISION_INVALID"],
    "a fractional revision": [reseal(body([["2026-09-28", 1.5]], { maxRevision: 1.5 })), null, "REVISION_FLOOR_REVISION_INVALID"],
    "a malformed pair": [reseal(body([["2026-09-28", 1, 2]], { maxRevision: 1 })), null, "REVISION_FLOOR_FILE_INVALID"],
  };
  for (const [label, [text, pin, code]] of Object.entries(invalid)) {
    assert.throws(() => parseRevisionFloorFile(bytes(text), pin ?? sha256Hex(text)), isCode(code), label);
  }
  assert.throws(() => parseRevisionFloorFile(bytes(valid.text), "not-a-digest"), isCode("REVISION_FLOOR_USAGE"));
  assert.throws(() => renderRevisionFloorFile(body(Array.from({ length: REVISION_FLOOR_MAX_DAYS + 1 }, (_, index) =>
    [new Date(Date.parse("2010-01-01T00:00:00.000Z") + index * 86_400_000).toISOString().slice(0, 10), 1]))),
  isCode("REVISION_FLOOR_TOO_LARGE"));
  // The reader wants a private, owner-only file at its pin.
  const path = join(directory, `floor-${randomUUID()}.json`);
  await writeFile(path, valid.text, { mode: 0o600, flag: "wx" });
  assert.equal((await readRevisionFloorFile({ path, expectedSha256: valid.floorSha256 })).floorSha256, valid.floorSha256);
  await chmod(path, 0o644);
  await assert.rejects(readRevisionFloorFile({ path, expectedSha256: valid.floorSha256 }), isCode("REVISION_FLOOR_FILE_INVALID"));
  await assert.rejects(readRevisionFloorFile({ path: join(directory, "absent.json"), expectedSha256: valid.floorSha256 }),
    isCode("REVISION_FLOOR_FILE_INVALID"));
});

test("the floor is bound to its seal and must cover every frozen-read revision", () => {
  const floor = parseRevisionFloorFile(new TextEncoder().encode(renderRevisionFloorFile(body()).text),
    renderRevisionFloorFile(body()).floorSha256);
  const facts = revisionFloorSealFacts(sealed);
  assert.equal(assertRevisionFloorBinding(floor, facts), floor);
  for (const key of ["sealId", "fenceReceiptSha256", "sourceCommit"]) {
    assert.throws(() => assertRevisionFloorBinding(floor, { ...facts, [key]: key === "sourceCommit" ? "e".repeat(40)
      : "e".repeat(64) }), isCode("REVISION_FLOOR_SEAL_MISMATCH"), key);
  }
  // The frozen export is taken before the fence and the floor after it: the floor can only be higher.
  assert.deepEqual(assertRevisionFloorCoversFrozen(floor, [{ day: "2026-09-28", revision: 7 },
    { day: "2026-09-28", revision: 3 }, { day: "2026-09-27", revision: 1 }]), { frozenDays: 3 });
  assert.deepEqual(assertRevisionFloorCoversFrozen(floor, []), { frozenDays: 0 });
  assert.throws(() => assertRevisionFloorCoversFrozen(floor, [{ day: "2026-09-28", revision: 8 }]),
    isCode("REVISION_FLOOR_BELOW_FROZEN_EXPORT"));
  assert.throws(() => assertRevisionFloorCoversFrozen(floor, [{ day: "2026-10-01", revision: 1 }]),
    isCode("REVISION_FLOOR_BELOW_FROZEN_EXPORT"), "a frozen day the floor lacks");
  assert.throws(() => assertRevisionFloorCoversFrozen(floor, [{ day: "2026-10-01", revision: 0 }]),
    isCode("REVISION_FLOOR_USAGE"));
});

test("the dress rehearsal's synthetic floor: each frozen day at its frozen revision, bound to the seal", async () => {
  const out = await privateDirectory("rev-seed-synthetic-");
  const frozen = [{ day: "2026-09-29", revision: 2 }, { day: "2026-09-28", revision: 5 }];
  const result = await writeSyntheticRevisionFloor({ manifestPath: seal.manifestPath, sealId: seal.sealId, frozenDays: frozen,
    ownerDirectory: out, now: () => new Date("2026-10-02T01:30:00.000Z") });
  assert.deepEqual({ ...result, path: undefined }, { mode: "synthetic", path: undefined, floorSha256: result.floorSha256,
    dayCount: 2, maxRevision: 5 });
  assert.equal((await lstat(result.path)).mode & 0o777, 0o400);
  const floor = await readRevisionFloorFile({ path: result.path, expectedSha256: result.floorSha256 });
  assert.equal(floor.provenance, "synthetic");
  assert.equal(floor.capture, null);
  assert.deepEqual(floor.days, [["2026-09-28", 5], ["2026-09-29", 2]]);
  assertRevisionFloorBinding(floor, revisionFloorSealFacts(sealed));
  assertRevisionFloorCoversFrozen(floor, frozen);
  await assert.rejects(writeSyntheticRevisionFloor({ manifestPath: seal.manifestPath, sealId: seal.sealId, frozenDays: frozen,
    ownerDirectory: out }), isCode("CUTOVER_OUTPUT_EXISTS"));
  await assert.rejects(writeSyntheticRevisionFloor({ manifestPath: seal.manifestPath, sealId: seal.sealId, frozenDays: [],
    ownerDirectory: await privateDirectory("rev-seed-synthetic-empty-") }), isCode("REVISION_FLOOR_EMPTY"));
  const checked = await checkRevisionFloor({ floorPath: result.path, floorSha256: result.floorSha256,
    manifestPath: seal.manifestPath, sealId: seal.sealId });
  assert.equal(checked.mode, "check");
  assert.equal(checked.provenance, "synthetic");
});

test("the CLI: a content-free dry run, an offline check, and closed flags", async () => {
  const script = join(WORKER_ROOT, "scripts", "cutover-revision-floor.mjs");
  const args = ["capture", "--inventory", world.inventory.path, "--seal", seal.manifestPath, "--seal-id", seal.sealId,
    "--analytics-source", analyticsSourcePath, "--fence-receipt", world.fence.path, "--out", directory];
  const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(stdout), { command: "capture", mode: "dry-run", fenceReceiptSha256: world.fence.sha256,
    analyticsDatabaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`), statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 });
  const out = await privateDirectory("rev-seed-cli-check-");
  const written = await capture({ ownerDirectory: out });
  const checked = execFileSync(process.execPath, [script, "check", "--floor", join(out, CUTOVER_REVISION_FLOOR_FILE),
    "--sha256", written.floorSha256, "--seal", seal.manifestPath, "--seal-id", seal.sealId], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(checked), { command: "check", mode: "check", provenance: "captured",
    floorSha256: written.floorSha256, dayCount: 4, maxRevision: 7, firstDay: "2026-09-27", lastDay: "2026-09-30" });
  for (const bad of [[], ["seal"], ["capture", "--inventory"], [...args, "--execute", "--execute"],
    ["check", "--floor", "x", "--sha256", "y", "--seal", "z"]]) {
    assert.throws(() => parseRevisionFloorArguments(bad), isCode("REVISION_FLOOR_USAGE"), JSON.stringify(bad));
  }
  assert.throws(() => execFileSync(process.execPath, [script, "capture", "--seal-id", "x"], { stdio: ["ignore", "pipe", "pipe"] }),
    error => error.status === 2 && error.stderr.toString().trim() === "REVISION_FLOOR_USAGE" && error.stdout.length === 0);
  // The loader's tables are the store's (the floor) and the contract's (the published heads).
  const storeRun = readFileSync(join(WORKER_ROOT, "src", "analytics-v2", "store-run.ts"), "utf8");
  const contract = readFileSync(join(WORKER_ROOT, "src", "analytics-v2", "contract.ts"), "utf8");
  for (const [text, key, table] of [[storeRun, "revisionFloor", REVISION_FLOOR_TABLES.floor],
    [storeRun, "revisionFloorSource", REVISION_FLOOR_TABLES.source], [contract, "publishedDaily", REVISION_FLOOR_TABLES.published]]) {
    assert.match(text, new RegExp(`\\b${key}: "${table}",`, "u"), key);
  }
});
