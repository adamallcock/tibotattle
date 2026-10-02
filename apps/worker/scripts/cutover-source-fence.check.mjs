import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_BARRIER_ERROR_CODE,
  validateBarrierProof,
  verifyCutoverFence,
  verifyCutoverUnchanged,
} from "./cutover-source-fence.mjs";
import { CUTOVER_SCHEMA_SQL, CutoverSourceError, canonicalJson, readCutoverInventory } from "./cutover-source-seal.mjs";
import {
  SYNTHETIC_BOOKMARKS,
  SYNTHETIC_D1,
  SYNTHETIC_SOURCE_COMMIT,
  writeBarrierProofFixture,
  writeFenceReceiptFixture,
  writeInventoryFixture,
} from "../postgres-test/fixtures/w2-seal/fence-fixtures.mjs";
import { headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
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
    execute: true,
    remote: true,
    ownerReadOnly: true,
    ...overrides,
  };
}

test("verify-unchanged emits 0400 flip evidence only when every bookmark and aggregate equals the seal", async () => {
  const out = await privateDirectory("w2-seal-flip-");
  const calls = [];
  const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS, calls });
  const result = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: out, transport }));
  assert.equal(result.mode, "verified");
  const files = await readdir(out);
  assert.equal(files.length, 1);
  assert.match(files[0], /^flip-evidence-\d{8}T\d{9}Z\.json$/u);
  const path = join(out, files[0]);
  assert.equal((await lstat(path)).mode & 0o777, 0o400);
  const bytes = await readFile(path);
  assert.equal(result.flipEvidenceSha256, createHash("sha256").update(bytes).digest("hex"));
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.sealId, sealed.sealId);
  assert.deepEqual(evidence.sources.map(source => source.role), ["ingestion", "deletion-ledger"]);
  assert.equal(bytes.includes(Buffer.from(world.fixture.ids.participant)), false);
  assert.ok(calls.some(call => call.kind === "bookmark") && calls.every(call => call.role !== undefined));

  const dry = await privateDirectory("w2-seal-flip-dry-");
  const dryCalls = [];
  const plan = await verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: dry, execute: false,
    transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS, calls: dryCalls }) }));
  assert.equal(plan.mode, "dry-run");
  assert.equal(dryCalls.length, 0);
  assert.deepEqual(await readdir(dry), []);
  await assert.rejects(verifyCutoverUnchanged(unchangedArgs({ ownerDirectory: dry, remote: false, transport })),
    isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
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
    const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS, ...drift });
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
    transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS, calls }) })),
  isCode("CUTOVER_SEALED_SOURCE_CHANGED"));
  assert.equal(calls.length, 0);
});
