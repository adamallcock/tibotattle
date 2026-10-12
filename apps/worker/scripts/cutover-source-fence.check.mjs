import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_BARRIER_ERROR_CODE,
  finalizeCutoverFlipEvidence,
  validateBarrierProof,
  verifyCutoverFence,
  verifyCutoverUnchanged,
} from "./cutover-source-fence.mjs";
import {
  CUTOVER_ANALYTICS_BOOKMARK_ROLE,
  CUTOVER_SCHEMA_SQL,
  CutoverSourceError,
  canonicalJson,
  guardCutoverTransport,
  readCutoverInventory,
  sha256Hex,
} from "./cutover-source-seal.mjs";
import { SYNTHETIC_ANALYTICS_DATABASE_NAME, writeAnalyticsSourceFixture } from "../postgres-test/fixtures/w2-seal/admin-history-fixtures.mjs";
import {
  SYNTHETIC_BOOKMARKS,
  SYNTHETIC_D1,
  SYNTHETIC_SOURCE_COMMIT,
  writeBarrierProofFixture,
  writeFenceReceiptFixture,
  writeInventoryFixture,
} from "../postgres-test/fixtures/w2-seal/fence-fixtures.mjs";
import {
  SYNTHETIC_UNCHANGED_BOOKMARKS,
  createFakeWranglerProviderSpawn,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
  writeFakeWranglerCli,
} from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { createFakeCutoverTransport, privateDirectory } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// PT-2-lite fence consumption: verify-fence over a synthetic EP-8 receipt
// pair read by cloudflare-writer-fence.mjs's own consumer reader plus the
// barrier proof, and verify-unchanged over a synthetic seal. Files only; no
// fetch, no provider. Run: node --test ./scripts/cutover-source-fence.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = headCommit(WORKER_ROOT);
const MINUTE = 60_000;
let world;
let inventory;
let sealed;

const isCode = code => error => error instanceof CutoverSourceError && error.code === code;

before(async () => {
  world = await prepareSealWorld({ commit: COMMIT });
  inventory = await readCutoverInventory(world.inventory.path);
  const run = await sealWorld(world);
  const result = await run.run();
  sealed = { out: run.out, sealId: result.sealId, paths: outputPathsOf(run.out) };
});

after(async () => {
  await world?.dispose();
});

function fenceArgs(overrides = {}) {
  return { inventory, fenceReceiptPath: world.fence.path, fenceReceiptSha256: world.fence.sha256,
    barrierProofPath: world.proof.path, ...overrides };
}

test("verify-fence binds the EP-8 receipt bookmarks to the inventory and the barrier proof to the fenced commit", async () => {
  const verified = await verifyCutoverFence(fenceArgs());
  assert.equal(verified.fenceReceiptSha256, world.fence.sha256);
  assert.equal(verified.sourceCommit, SYNTHETIC_SOURCE_COMMIT);
  assert.deepEqual(Object.fromEntries(Object.entries(verified.sources).map(([role, source]) => [role, source.bookmark])),
    { ingestion: SYNTHETIC_BOOKMARKS.ingestion, "deletion-ledger": SYNTHETIC_BOOKMARKS["deletion-ledger"] });
  assert.equal(verified.verificationSha256, createHash("sha256").update(canonicalJson(verified.summary)).digest("hex"));
  assert.equal(JSON.stringify(verified).includes(SYNTHETIC_D1.ingestion), false, "D1 ids only as digests");
});

test("verify-fence refuses anything but a valid, unreleased, fenced EP-8 verify receipt for these D1s", async () => {
  await assert.rejects(verifyCutoverFence(fenceArgs({ fenceReceiptSha256: "0".repeat(64) })),
    isCode("CUTOVER_FENCE_RECEIPT_INVALID"));
  const cases = [
    { mutate: receipt => { receipt.productionWorker.mode = "worker"; } },
    { mutate: receipt => { receipt.window.quietWindowMinutes = 5; } },
    { mutate: receipt => { receipt.fencedScripts[0].crons = ["* * * * *"]; } },
    { mutate: receipt => { receipt.analytics.d1[0].rowsWritten = 1; } },
    { mutate: receipt => { receipt.d1.pop(); } },
    { released: true },
  ];
  for (const options of cases) {
    const directory = await privateDirectory("w2-seal-fence-");
    const fence = await writeFenceReceiptFixture({ directory, ...options });
    await assert.rejects(verifyCutoverFence(fenceArgs({ fenceReceiptPath: fence.path, fenceReceiptSha256: fence.sha256 })),
      isCode("CUTOVER_FENCE_RECEIPT_INVALID"), JSON.stringify(Object.keys(options)));
  }
  const directory = await privateDirectory("w2-seal-fence-ids-");
  const foreign = await writeFenceReceiptFixture({ directory,
    d1Ids: { ...SYNTHETIC_D1, ingestion: "55555555-5555-4555-8555-555555555555" } });
  await assert.rejects(verifyCutoverFence(fenceArgs({ fenceReceiptPath: foreign.path, fenceReceiptSha256: foreign.sha256 })),
    error => isCode("CUTOVER_FENCE_SOURCE_MISMATCH")(error) && error.role === "ingestion");
});

test("the barrier proof is closed: barrier health with sourceCommit and a 503 MUTATION_BARRIER_ACTIVE probe with retry-after 300", async () => {
  const proof = JSON.parse(await readFile(world.proof.path, "utf8"));
  assert.equal(validateBarrierProof(proof).sourceCommit, SYNTHETIC_SOURCE_COMMIT);
  assert.equal(proof.probe.body.error.code, CUTOVER_BARRIER_ERROR_CODE);
  const variants = [
    proof => { delete proof.health.body.deployment; },
    proof => { proof.health.status = 503; proof.health.body.status = "unavailable"; },
    proof => { proof.health.body.mode = "worker"; },
    proof => { proof.health.body.maintenance.storageQualified = true; },
    proof => { proof.health.url = "https://example.invalid/api/health"; },
    proof => { proof.health.url = "https://tibotattle.com/api/ready"; },
    proof => { proof.health.headers["cache-control"] = "max-age=60"; },
    proof => { proof.probe.status = 404; },
    proof => { proof.probe.headers["retry-after"] = "60"; },
    proof => { delete proof.probe.headers["retry-after"]; },
    proof => { proof.probe.body.error.code = "NOT_FOUND"; },
    proof => { proof.probe.url = "https://tibotattle.com/api/health"; },
    proof => { proof.probe.url = "https://tibotattle.com/index.html"; },
    proof => { proof.probe.body.error.requestId = "not-a-request-id"; },
    proof => { proof.extra = true; },
    proof => { proof.schema = "other"; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const copy = structuredClone(proof);
    mutate(copy);
    assert.throws(() => validateBarrierProof(copy), isCode("CUTOVER_BARRIER_PROOF_INVALID"), `variant ${index}`);
  }
  const directory = await privateDirectory("w2-seal-proof-");
  const otherCommit = await writeBarrierProofFixture({ directory, sourceCommit: "e".repeat(40), name: "other.json" });
  await assert.rejects(verifyCutoverFence(fenceArgs({ barrierProofPath: otherCommit.path })),
    error => isCode("CUTOVER_BARRIER_PROOF_INVALID")(error) && error.check === "source-commit");
  // EP-8 records a null commit when the live binding is absent or invalid:
  // no proof, from any build, binds to that receipt.
  const unpinned = await writeFenceReceiptFixture({ directory: await privateDirectory("w2-seal-fence-unpinned-"),
    sourceCommit: null });
  for (const commit of [SYNTHETIC_SOURCE_COMMIT, "e".repeat(40), "1".repeat(40)]) {
    const proofFile = await writeBarrierProofFixture({ directory, sourceCommit: commit, name: `unpinned-${commit[0]}.json` });
    await assert.rejects(verifyCutoverFence(fenceArgs({ fenceReceiptPath: unpinned.path, fenceReceiptSha256: unpinned.sha256,
      barrierProofPath: proofFile.path })), error => isCode("CUTOVER_BARRIER_PROOF_INVALID")(error)
      && error.check === "source-commit", commit);
  }
  const early = await writeBarrierProofFixture({ directory, observedAtMs: world.fence.observedAfterMs - MINUTE, name: "early.json" });
  await assert.rejects(verifyCutoverFence(fenceArgs({ barrierProofPath: early.path })),
    error => isCode("CUTOVER_BARRIER_PROOF_INVALID")(error) && error.check === "observed-at");
  const future = await writeBarrierProofFixture({ directory, observedAtMs: Date.now() + 10 * MINUTE, name: "future.json" });
  await assert.rejects(verifyCutoverFence(fenceArgs({ barrierProofPath: future.path })),
    isCode("CUTOVER_BARRIER_PROOF_INVALID"));
  const loose = join(directory, "loose.json");
  await writeFile(loose, JSON.stringify(proof), { mode: 0o644 });
  await chmod(loose, 0o644);
  await assert.rejects(verifyCutoverFence(fenceArgs({ barrierProofPath: loose })), isCode("CUTOVER_BARRIER_PROOF_INVALID"));
  // No proof at all is a refusal, never a pass.
  await assert.rejects(verifyCutoverFence(fenceArgs({ barrierProofPath: join(directory, "absent.json") })),
    isCode("CUTOVER_BARRIER_PROOF_INVALID"));
});

function unchangedArgs(overrides = {}) {
  return {
    inventoryPath: world.inventory.path,
    manifestPath: sealed.paths.manifest,
    sealId: sealed.sealId,
    analyticsSourcePath: world.analyticsSource,
    fenceReceiptPath: world.fence.path,
    execute: true,
    remote: true,
    ownerReadOnly: true,
    ...overrides,
  };
}

test("verify-unchanged emits 0400 flip evidence only when every bookmark and aggregate equals the seal", async () => {
  const out = await privateDirectory("w2-seal-flip-");
  const calls = [];
  const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS, calls });
  const result = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, transport }));
  assert.equal(result.mode, "verified");
  const files = await readdir(out);
  assert.equal(files.length, 1);
  assert.equal(files[0], "flip-evidence.json");
  const path = join(out, files[0]);
  assert.equal((await lstat(path)).mode & 0o777, 0o400);
  const bytes = await readFile(path);
  assert.equal(result.flipEvidenceSha256, createHash("sha256").update(bytes).digest("hex"));
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.sealId, sealed.sealId);
  assert.deepEqual(evidence.sources.map(source => source.role), ["ingestion", "deletion-ledger"]);
  assert.equal(evidence.schema, "tibotattle-cutover-flip-evidence-v2");
  // R19 (c): the analytics D1's fenced bookmark, re-read; never its id.
  assert.deepEqual(evidence.analytics, { databaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`),
    bookmark: SYNTHETIC_BOOKMARKS.analytics });
  assert.equal(bytes.includes(Buffer.from(SYNTHETIC_D1.analytics)), false);
  assert.equal(bytes.includes(Buffer.from(world.fixture.ids.participant)), false);
  assert.ok(calls.some(call => call.kind === "bookmark") && calls.every(call => call.role !== undefined));
  // The bracket: the analytics bookmark is read first and last, and never queried.
  assert.deepEqual([calls[0], calls.at(-1)], [{ kind: "bookmark", role: CUTOVER_ANALYTICS_BOOKMARK_ROLE },
    { kind: "bookmark", role: CUTOVER_ANALYTICS_BOOKMARK_ROLE }]);
  assert.equal(calls.filter(call => call.role === CUTOVER_ANALYTICS_BOOKMARK_ROLE).length, 2);

  const dry = await privateDirectory("w2-seal-flip-dry-");
  const dryCalls = [];
  const plan = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: dry, execute: false,
    transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS, calls: dryCalls }) }));
  assert.equal(plan.mode, "dry-run");
  assert.equal(dryCalls.length, 0);
  assert.deepEqual(await readdir(dry), []);
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: dry, remote: false, transport })),
    isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, transport })),
    isCode("CUTOVER_OUTPUT_EXISTS"), "a second verification never overwrites the evidence");
});

test("verify-unchanged through the default Wrangler transport leaves only flip-evidence.json, or nothing", async () => {
  // The real transport code path, driven by an injected spawn and a
  // synthetic CLI stand-in; no provider and no Wrangler is run.
  const cliPath = await writeFakeWranglerCli(await privateDirectory("w2-seal-cli-"));
  const out = await privateDirectory("w2-seal-flip-default-");
  const calls = [];
  const result = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, cliPath, environment: {},
    spawn: createFakeWranglerProviderSpawn(world, { calls }) }));
  assert.equal(result.mode, "verified");
  assert.deepEqual(await readdir(out), ["flip-evidence.json"]);
  for (const role of ["ingestion", "deletion-ledger"]) {
    assert.ok(calls.some(call => call.role === role && call.kind === "bookmark"), role);
    assert.ok(calls.some(call => call.role === role && call.kind === "query"), role);
  }
  // The analytics D1: two bookmark reads through its own pinned config, no query.
  assert.deepEqual(calls.filter(call => call.role === "analytics").map(call => call.kind), ["bookmark", "bookmark"]);
  assert.ok(calls.every(call => call.configMode === 0o600));

  for (const bookmarks of [{ ...SYNTHETIC_BOOKMARKS, ingestion: "00000001-11111111-00000045" },
    { ...SYNTHETIC_BOOKMARKS, "deletion-ledger": "00000001-33333333-00000004" }]) {
    const failed = await privateDirectory("w2-seal-flip-default-drift-");
    await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: failed, cliPath, environment: {},
      spawn: createFakeWranglerProviderSpawn(world, { bookmarks }) })), isCode("CUTOVER_SOURCE_CHANGED_AFTER_SEAL"));
    assert.deepEqual(await readdir(failed), [], "no pinned config is left");
  }
  // The analytics D1 moved after the fence (before the first read, or between the two).
  for (const analytics of ["00000001-22222222-00000008", call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics
    : "00000001-22222222-00000008")]) {
    const failed = await privateDirectory("w2-seal-flip-default-analytics-");
    await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: failed, cliPath, environment: {},
      spawn: createFakeWranglerProviderSpawn(world, { bookmarks: { ...SYNTHETIC_BOOKMARKS, analytics } }) })),
    isCode("CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE"));
    assert.deepEqual(await readdir(failed), [], "no pinned config and no evidence is left");
  }
  // A config this verification did not write is refused and left alone.
  const stale = await privateDirectory("w2-seal-flip-default-stale-");
  await writeFile(join(stale, "ingestion.wrangler.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: stale, cliPath, environment: {},
    spawn: createFakeWranglerProviderSpawn(world) })), isCode("CUTOVER_OUTPUT_EXISTS"));
  assert.deepEqual(await readdir(stale), ["ingestion.wrangler.json"]);
});

test("verify-unchanged brackets the analytics D1's fenced bookmark through a bookmark-only role (R19 (c))", async () => {
  // A Cloudflare publication after the fence (and so after the floor's
  // capture) moves the analytics bookmark: before the sealed reads, or between
  // the two analytics reads. Nothing is written either way.
  const moved = "00000001-22222222-00000008";
  for (const [label, analytics, expectedCalls] of [["moved before", moved, 1],
    ["moved between", call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics : moved), null]]) {
    const out = await privateDirectory("w2-seal-flip-analytics-");
    const calls = [];
    const transport = createFakeCutoverTransport({ sources: world.remotePaths, calls,
      bookmarks: { ...SYNTHETIC_UNCHANGED_BOOKMARKS, [CUTOVER_ANALYTICS_BOOKMARK_ROLE]: analytics } });
    await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, transport })),
      isCode("CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE"), label);
    assert.deepEqual(await readdir(out), [], label);
    if (expectedCalls !== null) assert.equal(calls.length, expectedCalls, "no sealed source is read after a moved bracket");
    assert.ok(calls.every(call => call.role !== CUTOVER_ANALYTICS_BOOKMARK_ROLE || call.kind === "bookmark"), label);
  }
  // The role reads bookmarks only: every statement is refused, the floor's too.
  const scope = { accountId: inventory.accountId, sources: { [CUTOVER_ANALYTICS_BOOKMARK_ROLE]: {
    role: CUTOVER_ANALYTICS_BOOKMARK_ROLE, binding: "ANALYTICS_DB", databaseName: SYNTHETIC_ANALYTICS_DATABASE_NAME,
    databaseId: SYNTHETIC_D1.analytics } } };
  const fake = createFakeCutoverTransport({ sources: {}, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS });
  const guarded = guardCutoverTransport(fake, scope);
  assert.equal(await guarded.bookmark(scope.sources[CUTOVER_ANALYTICS_BOOKMARK_ROLE]), SYNTHETIC_BOOKMARKS.analytics);
  for (const sql of ["SELECT 1", "SELECT day,MAX(revision) AS revision FROM analytics_community_daily_heads GROUP BY day"]) {
    await assert.rejects(guarded.query(scope.sources[CUTOVER_ANALYTICS_BOOKMARK_ROLE], sql),
      isCode("CUTOVER_BOOKMARK_ROLE_QUERY_REFUSED"), sql);
  }
  await assert.rejects(guarded.query(scope.sources[CUTOVER_ANALYTICS_BOOKMARK_ROLE], "DELETE FROM x"),
    isCode("CUTOVER_REMOTE_SQL_NOT_SELECT"));
  // The analytics source must be the fenced D1 and never a sealed one; both
  // inputs are required; the fence receipt is read at the seal's pin. All
  // refuse before any remote read, in a dry run too.
  const directory = await privateDirectory("w2-seal-flip-analytics-source-");
  const other = await writeAnalyticsSourceFixture({ directory, name: "other.json", databaseId: SYNTHETIC_D1["catchup-control"] });
  const sealedD1 = await writeAnalyticsSourceFixture({ directory, name: "sealed.json", databaseId: SYNTHETIC_D1.ingestion });
  const refusals = [[{ analyticsSourcePath: other }, "CUTOVER_FENCE_SOURCE_MISMATCH"],
    [{ analyticsSourcePath: sealedD1 }, "CUTOVER_SOURCE_NOT_ALLOWED"],
    [{ analyticsSourcePath: undefined }, "CUTOVER_ARGUMENT_INVALID"],
    [{ fenceReceiptPath: undefined }, "CUTOVER_ARGUMENT_INVALID"],
    [{ fenceReceiptPath: world.proof.path }, "CUTOVER_FENCE_RECEIPT_INVALID"]];
  for (const [overrides, code] of refusals) {
    for (const execute of [true, false]) {
      const calls = [];
      const out = await privateDirectory("w2-seal-flip-analytics-refused-");
      await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, execute, ...overrides,
        transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS, calls }) })),
      isCode(code), `${code} execute=${execute}`);
      assert.equal(calls.length, 0);
      assert.deepEqual(await readdir(out), []);
    }
  }
  // The CLI names both inputs; without them it refuses.
  const script = join(WORKER_ROOT, "scripts", "cutover-source-fence.mjs");
  const base = ["verify-unchanged", "--inventory", world.inventory.path, "--seal", sealed.paths.manifest,
    "--seal-id", sealed.sealId, "--out", await privateDirectory("w2-seal-flip-cli-")];
  const dry = execFileSync(process.execPath, [script, ...base, "--analytics-source", world.analyticsSource,
    "--fence-receipt", world.fence.path], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(dry), { command: "verify-unchanged", mode: "dry-run" });
  assert.throws(() => execFileSync(process.execPath, [script, ...base], { stdio: ["ignore", "pipe", "pipe"] }),
    error => error.status === 1 && error.stderr.toString().trim() === "CUTOVER_ARGUMENT_INVALID" && error.stdout.length === 0);
});

test("verify-unchanged refuses a moved bookmark, a changed aggregate, a changed schema or a changed sealed file", async () => {
  const drifts = [
    { bookmarks: { ...SYNTHETIC_BOOKMARKS, "deletion-ledger": "00000001-33333333-00000004" } },
    { tamper: (role, sql, rows) => (role === "ingestion" && sql.includes("count(*) AS n")
      ? rows.map(row => (row.t === "web_sessions" ? { ...row, len: row.len + 1 } : row)) : rows) },
    { tamper: (role, sql, rows) => (role === "deletion-ledger" && sql === CUTOVER_SCHEMA_SQL
      ? rows.filter(row => row.type !== "index") : rows) },
  ];
  for (const drift of drifts) {
    const out = await privateDirectory("w2-seal-flip-drift-");
    const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS,
      ...drift, ...(drift.bookmarks === undefined ? {} : { bookmarks: { ...SYNTHETIC_UNCHANGED_BOOKMARKS, ...drift.bookmarks } }) });
    await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, transport })),
      isCode("CUTOVER_SOURCE_CHANGED_AFTER_SEAL"));
    assert.deepEqual(await readdir(out), [], "no evidence is written");
  }
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: await privateDirectory("w2-seal-flip-id-"),
    sealId: "0".repeat(64) })), isCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  const directory = await privateDirectory("w2-seal-flip-inventory-");
  const otherInventory = await writeInventoryFixture({ directory, commit: SYNTHETIC_SOURCE_COMMIT });
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ inventoryPath: otherInventory.path,
    ownerDirectory: directory })), isCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  // A sealed file changed after the seal refuses before any remote read.
  await chmod(sealed.paths.ledger, 0o600);
  await writeFile(sealed.paths.ledger, Buffer.from("tampered"), { flag: "a" });
  await chmod(sealed.paths.ledger, 0o400);
  const calls = [];
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: await privateDirectory("w2-seal-flip-file-"),
    transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS, calls }) })),
  isCode("CUTOVER_SEALED_SOURCE_CHANGED"));
  assert.equal(calls.length, 0);
});


test("fixed flip drafts cannot enter admission until successor coverage is reopened", async () => {
  const { writeCaptureProofFixture, captureProofInstant } = await import("../postgres-test/fixtures/w2-seal/capture-proof-fixtures.mjs");
  const { readCaptureAnchor, createCaptureDraft } = await import("./cutover-capture-proof.mjs");
  const { validateFlipEvidence } = await import("./postgres-production-transfer.mjs");
  const fixture = await writeCaptureProofFixture();
  try {
    const anchor = await readCaptureAnchor({ fenceReceiptPath: fixture.original.path, fenceReceiptSha256: fixture.original.sha256 });
    const sourceRoles = ["ingestion", "deletion-ledger"];
    const sources = sourceRoles.map(role => {
      const pin = anchor.receipt.d1.find(item => item.label === role);
      return { role, databaseIdSha256: pin.idSha256, bookmark: pin.bookmark,
        schemaSha256: "1".repeat(64), aggregatesSha256: "2".repeat(64), sealedSha256: "3".repeat(64) };
    });
    const analytics = anchor.receipt.d1.find(item => item.label === "analytics");
    const body = { schema: "tibotattle-cutover-flip-evidence-v3", sealId: "5".repeat(64),
      inventorySha256: "4".repeat(64), fenceReceiptSha256: fixture.original.sha256,
      verifiedAt: captureProofInstant(52), sources,
      analytics: { databaseIdSha256: analytics.idSha256, bookmark: analytics.bookmark } };
    const roles = [...sources.map(source => ({ role: source.role, label: source.role, databaseIdSha256: source.databaseIdSha256,
      bookmarkSha256: sha256Hex(source.bookmark) })), { role: "analytics-bookmark", label: "analytics",
      databaseIdSha256: analytics.idSha256, bookmarkSha256: sha256Hex(analytics.bookmark) }];
    const draft = createCaptureDraft({ kind: "flip-evidence", body, anchor,
      capture: { startedAt: captureProofInstant(50), endpointTimestamp: captureProofInstant(51), completedAt: captureProofInstant(52), roles } });
    const draftPin = await fixture.save("flip-draft.json", draft);
    const canonicalDraft = `${canonicalJson(draft)}\n`;
    await writeFile(draftPin.path, canonicalDraft, { mode: 0o600 });
    draftPin.sha256 = sha256Hex(canonicalDraft);
    const fakeSeal = { manifest: { sealId: body.sealId, inventorySha256: body.inventorySha256,
      fence: { fenceReceiptSha256: fixture.original.sha256 }, sources } };
    const parserArgs = { afterMs: Date.parse(captureProofInstant(49)), fencedAnalytics: { ...analytics, receipt: anchor.receipt },
      originalFenceReceiptPath: fixture.original.path, successorFenceReceiptPath: fixture.successor.path };
    await assert.rejects(validateFlipEvidence(draftPin.path, fakeSeal, parserArgs));
    const downgraded = await fixture.save("downgraded-flip.json", { ...body, schema: "tibotattle-cutover-flip-evidence-v2" });
    await assert.rejects(validateFlipEvidence(downgraded.path, fakeSeal, parserArgs),
      error => error.code === "CUTOVER_FLIP_EVIDENCE_INVALID");
    const out = await privateDirectory("flip-fixed-finalized-");
    const args = { draftPath: draftPin.path, draftSha256: draftPin.sha256, fenceReceiptPath: fixture.original.path,
      successorFenceReceiptPath: fixture.successor.path, successorFenceReceiptSha256: fixture.successor.sha256, ownerDirectory: out };
    const malformedDraft = createCaptureDraft({ kind: "flip-evidence", body: { ...body, unexpected: 1 }, anchor, capture: draft.capture });
    const malformedPin = await fixture.save("malformed-flip-draft.json", malformedDraft);
    const malformedBytes = `${canonicalJson(malformedDraft)}\n`;
    await writeFile(malformedPin.path, malformedBytes, { mode: 0o600 });
    await assert.rejects(finalizeCutoverFlipEvidence({ ...args, draftPath: malformedPin.path, draftSha256: sha256Hex(malformedBytes) }));
    assert.deepEqual(await readdir(out), []);
    const noncanonical = await fixture.save("noncanonical-flip-draft.json", draft);
    await assert.rejects(finalizeCutoverFlipEvidence({ ...args, draftPath: noncanonical.path, draftSha256: noncanonical.sha256 }));
    assert.deepEqual(await readdir(out), []);
    const short = await fixture.fence(55);
    await assert.rejects(finalizeCutoverFlipEvidence({ ...args, successorFenceReceiptPath: short.path,
      successorFenceReceiptSha256: short.sha256 }));
    assert.deepEqual(await readdir(out), []);
    const finalized = await finalizeCutoverFlipEvidence(args);
    assert.equal((await lstat(finalized.path)).mode & 0o777, 0o400);
    const valid = await validateFlipEvidence(finalized.path, fakeSeal, parserArgs);
    assert.equal(valid.sha256, finalized.flipEvidenceSha256);
    await assert.rejects(validateFlipEvidence(finalized.path, fakeSeal, { ...parserArgs,
      afterMs: Date.parse(captureProofInstant(50)) }), error => error.code === "CUTOVER_FLIP_EVIDENCE_STALE");
    await assert.rejects(validateFlipEvidence(finalized.path, fakeSeal, { ...parserArgs, successorFenceReceiptPath: short.path }));
    await fixture.release();
    await assert.rejects(validateFlipEvidence(finalized.path, fakeSeal, parserArgs));
  } finally { await fixture.dispose(); }
});

test("fixed verify-unchanged selects common fresh endpoints and emits only a draft", async () => {
  const { writeCaptureProofFixture, captureProofInstant } = await import("../postgres-test/fixtures/w2-seal/capture-proof-fixtures.mjs");
  const freshWorld = await prepareSealWorld({ commit: COMMIT });
  const freshRun = await sealWorld(freshWorld);
  await freshRun.run();
  const freshPaths = outputPathsOf(freshRun.out);
  const fixture = await writeCaptureProofFixture({ accountSha256: sha256Hex(`account:${(await readCutoverInventory(freshWorld.inventory.path)).accountId}`),
    sourceCommit: SYNTHETIC_SOURCE_COMMIT, d1: ["ingestion", "analytics", "deletion-ledger", "catchup-control"].map(label => ({
    label, idSha256: sha256Hex(`d1:${SYNTHETIC_D1[label]}`), bookmark: SYNTHETIC_BOOKMARKS[label] })) });
  try {
    const body = JSON.parse(await readFile(freshPaths.manifest, "utf8"));
    const { readCaptureAnchor, createCaptureDraft, finalizeCaptureDraft } = await import("./cutover-capture-proof.mjs");
    async function pinManifest(manifest, pinFixture) {
      manifest.schema = "tibotattle-cutover-seal-v2";
      manifest.fence.fenceReceiptSha256 = pinFixture.original.sha256;
      const { sealId, captureProof, ...unsigned } = manifest;
      manifest.sealId = sha256Hex(canonicalJson(unsigned));
      const anchor = await readCaptureAnchor({ fenceReceiptPath: pinFixture.original.path, fenceReceiptSha256: pinFixture.original.sha256 });
      const draft = createCaptureDraft({ kind: "seal", body: manifest, anchor,
        capture: { startedAt: captureProofInstant(40), endpointTimestamp: captureProofInstant(41), completedAt: captureProofInstant(42),
          roles: manifest.sources.map(source => ({ role: source.role, label: source.role, databaseIdSha256: source.databaseIdSha256,
            bookmarkSha256: sha256Hex(source.bookmark) })) } });
      const finalized = await finalizeCaptureDraft({ draft, originalFenceReceiptPath: pinFixture.original.path,
        successorFenceReceiptPath: pinFixture.successor.path, successorFenceReceiptSha256: pinFixture.successor.sha256 });
      return { ...finalized.body, captureProof: finalized.proof };
    }
    const pinnedBody = await pinManifest(body, fixture);
    const manifestPath = join(dirname(freshPaths.manifest), "fixed-flip-test-manifest.json");
    await writeFile(manifestPath, JSON.stringify(pinnedBody), { mode: 0o600 });
    const out = await privateDirectory("flip-fixed-capture-");
    const calls = [];
    const transport = createFakeCutoverTransport({ sources: freshWorld.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS });
    const bookmark = transport.bookmark.bind(transport);
    transport.bookmark = async (source, selection) => { calls.push({ role: source.role, timestamp: selection?.timestamp });
      return bookmark(source, selection); };
    const times = [50, 51, 52, 53];
    const result = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, manifestPath, sealId: body.sealId, inventoryPath: freshWorld.inventory.path, analyticsSourcePath: freshWorld.analyticsSource,
      fenceReceiptPath: fixture.original.path, transport, now: () => new Date(captureProofInstant(times.shift())) }));
    assert.equal(result.mode, "draft");
    assert.deepEqual(await readdir(out), ["flip-evidence-draft.json"]);
    assert.equal(result.evidence.capture.startedAt, captureProofInstant(50));
    assert.equal(result.evidence.capture.completedAt, captureProofInstant(52));
    assert.ok(calls.every(call => typeof call.timestamp === "string"));
    const wrongAccount = await writeCaptureProofFixture({ sourceCommit: SYNTHETIC_SOURCE_COMMIT, d1: fixture.original.receipt.d1 });
    try {
      const wrongBody = await pinManifest(structuredClone(body), wrongAccount);
      const wrongManifest = join(dirname(manifestPath), "wrong-account-flip-test-manifest.json");
      await writeFile(wrongManifest, JSON.stringify(wrongBody), { mode: 0o600 });
      const badOut = await privateDirectory("flip-fixed-wrong-account-");
      const beforeCalls = calls.length;
      await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: badOut, manifestPath: wrongManifest,
        sealId: wrongBody.sealId, inventoryPath: freshWorld.inventory.path, analyticsSourcePath: freshWorld.analyticsSource,
        fenceReceiptPath: wrongAccount.original.path, transport })), isCode("CUTOVER_FENCE_SOURCE_MISMATCH"));
      assert.equal(calls.length, beforeCalls);
      assert.deepEqual(await readdir(badOut), []);
    } finally { await wrongAccount.dispose(); }
    for (const timestamp of [30, 50, 51].map(captureProofInstant)) {
      assert.deepEqual([...new Set(calls.filter(call => call.timestamp === timestamp).map(call => call.role))],
        ["ingestion", "deletion-ledger", "analytics-bookmark"]);
    }
  } finally { await fixture.dispose(); await freshWorld.dispose(); }
});
