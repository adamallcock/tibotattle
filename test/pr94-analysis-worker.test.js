import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPr94QuotaGroups, derivePr94BatchedTransitions } from "../scripts/lib/pr94-analysis-worker.mjs";
import * as quota from "../packages/quota-analysis/index.js";
import * as miner from "../src/codex-transition-miner.js";
import * as accounting from "../packages/accounting/index.js";
import { createLocalUnifiedAccountingSource } from "../src/local-unified-accounting-source.js";
import { beginUnifiedIndexGeneration, createUnifiedIndexWriter, openLocalUnifiedIndex } from "../src/local-unified-index.js";
import { createPr94LedgerEvidence, importPr94LedgerEvidencePrivate, comparePr94LedgerEvidence,
  disposePr94LedgerEvidencePrivate } from "../scripts/lib/pr94-ledger-evidence.mjs";
import { importPr94CalibrationEvidence, disposePr94CalibrationEvidencePrivate } from "../scripts/lib/pr94-calibration-evidence.mjs";
import { validatePr94AnalysisResult } from "../scripts/lib/pr94-receipt-validation.mjs";

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";
const WEEK = 604_800_000;
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const KEY = new Uint8Array(32).fill(29);

function snapshot(at, percent, reset, planType = "pro", duration = 10_080, slot = "primary") {
  return { timestamp: new Date(at).toISOString(), timestampMs: at,
    window: { provider: "openai_codex", planType, limitId: "codex", slot, usedPercent: percent,
      windowDurationMins: duration, resetsAt: reset / 1_000 } };
}

function usage(at, ordinal, planType = "pro") {
  return { timestamp: new Date(at).toISOString(), timestampMs: at, model: "gpt-5.6-sol",
    components: { input_uncached_tokens: 100_000 + ordinal, input_cache_read_tokens: 500,
      input_cache_write_tokens: 0, output_text_tokens: 20, output_reasoning_tokens: 10, output_combined_tokens: 0 },
    tierSemantics: { codexSpeedMode: ordinal % 3 === 0 ? "fast" : "standard" },
    planAttribution: { basis: "same_record", planType, planVariant: null },
    usageIntervalStartedAt: new Date(at - 1_000).toISOString(), usageIntervalBasis: "previous_source_record" };
}

function completeFixture() {
  const snapshots = []; const events = [];
  for (let reset = 0; reset < 3; reset += 1) {
    const start = Date.parse(START) + reset * WEEK;
    for (let boundary = 0; boundary < 13; boundary += 1) {
      const at = start + boundary * 3_600_000;
      snapshots.push(snapshot(at, boundary, start + WEEK, "pro", 10_080, boundary < 6 ? "primary" : "secondary"));
      if (boundary > 0) events.push(usage(at - 30_000, events.length));
    }
  }
  return { snapshots, usage: events };
}

async function oracle(fixture) {
  return miner.deriveCodexTransitionSeriesCooperatively({ startAt: START, endAt: END,
    rawUsageEvents: fixture.usage, rateLimitSnapshots: fixture.snapshots,
    diagnostics: {}, includeSnapshotIntervals: false, windowDurationMins: 10_080,
    includeNormalizedInputs: false });
}

test("PR94 complete multi-reset batches equal actual unbatched miner output without mutating input", async () => {
  const fixture = completeFixture();
  const before = structuredClone(fixture);
  const grouped = buildPr94QuotaGroups(fixture.snapshots, { quota, revisionKind: "final" });
  let resourceChecks = 0;
  const batched = await derivePr94BatchedTransitions({ modules: { miner }, usage: fixture.usage, grouped,
    startAt: START, endAt: END, resourceCheck() { resourceChecks += 1; } });
  const full = await oracle(fixture);
  assert.deepEqual(batched.transitions, full.transitions);
  assert.equal(batched.deduplicatedSnapshotCount, full.deduplicatedSnapshotCount);
  assert.equal(batched.batchMetrics.batches, 3);
  assert.equal(batched.batchMetrics.maximumUsageSlice, 12);
  assert.ok(resourceChecks >= 3);
  assert.deepEqual(fixture, before);
});

test("PR94 quota-only short-window plan switch remains global across reset batches", async () => {
  const start = Date.parse(START);
  const snapshots = [snapshot(start, 0, start + WEEK), snapshot(start + 3_600_000, 1, start + WEEK),
    snapshot(start + 2 * 3_600_000, 0, start + 5 * 3_600_000, "plus", 300),
    snapshot(start + 3 * 3_600_000, 2, start + WEEK), snapshot(start + 4 * 3_600_000, 3, start + WEEK),
    snapshot(start + WEEK, 0, start + 2 * WEEK), snapshot(start + WEEK + 3_600_000, 1, start + 2 * WEEK)];
  const events = [usage(start + 30_000, 0), usage(start + 3 * 3_600_000 + 30_000, 1), usage(start + WEEK + 30_000, 2)];
  const grouped = buildPr94QuotaGroups(snapshots, { quota, revisionKind: "final" });
  const batched = await derivePr94BatchedTransitions({ modules: { miner }, usage: events, grouped, startAt: START, endAt: END });
  const full = await oracle({ snapshots, usage: events });
  assert.deepEqual(batched.transitions, full.transitions);
  assert.equal(new Set(batched.transitions.map((row) => row.planEraKey)).size, 2);
  const lostChronology = await oracle({ snapshots: snapshots.filter((row) => row.window.windowDurationMins === 10_080), usage: events });
  assert.notDeepEqual(batched.transitions, lostChronology.transitions);
  assert.equal(grouped.rawParents.length, 2);
});

test("PR94 valid unknown-plan anchors retain original attribution semantics", () => {
  const start = Date.parse(START);
  const snapshots = [snapshot(start, 0, start + WEEK, null), snapshot(start + 3_600_000, 1, start + WEEK, null)];
  const grouped = buildPr94QuotaGroups(snapshots, { quota, revisionKind: "final" });
  assert.equal(grouped.attribution.status, "ready");
  assert.equal(grouped.attribution.ignoredObservationCount, 2);
  assert.equal(grouped.rawParents[0].matchedSnapshotCount, 0);
  assert.equal(grouped.rawParents[0].unavailableSnapshotCount, 2);
  assert.equal(grouped.selectedPlanType, "unknown");
});

test("PR94 raw occurrence counts survive slim projection and deduplicate only for calibration", async () => {
  const fixture = completeFixture();
  fixture.snapshots.splice(1, 0, structuredClone(fixture.snapshots[0]));
  const grouped = buildPr94QuotaGroups(fixture.snapshots, { quota, revisionKind: "final" });
  assert.equal(grouped.rawParents[0].snapshotCount, 14);
  assert.equal(grouped.rawParents[0].uniqueSnapshotCount, 13);
  const batched = await derivePr94BatchedTransitions({ modules: { miner }, usage: fixture.usage, grouped, startAt: START, endAt: END });
  assert.deepEqual(batched.transitions, (await oracle(fixture)).transitions);
  assert.equal(batched.deduplicatedSnapshotCount, 39);
});

test("PR94 equal-time contradictory plan evidence cannot choose a population by insertion order", () => {
  const start = Date.parse(START);
  const snapshots = [snapshot(start, 10, start + WEEK, "pro"), snapshot(start, 10, start + WEEK, "plus")];
  for (const input of [snapshots, [...snapshots].reverse()]) {
    const grouped = buildPr94QuotaGroups(input, { quota, revisionKind: "final" });
    assert.equal(grouped.selectedPlanType, "unknown");
    assert.equal(grouped.attribution.conflicts.length, 1);
    assert.ok(grouped.rawParents.every((row) => row.conflictedSnapshotCount === 1 && row.matchedSnapshotCount === 0));
  }
});

test("PR94 batch resource failures propagate without partial successful evidence", async () => {
  const fixture = completeFixture();
  const grouped = buildPr94QuotaGroups(fixture.snapshots, { quota, revisionKind: "final" });
  const failure = Object.assign(new Error("synthetic_resource_guard"), { code: "synthetic_resource_guard" });
  await assert.rejects(() => derivePr94BatchedTransitions({ modules: { miner }, usage: fixture.usage, grouped,
    startAt: START, endAt: END, resourceCheck() { throw failure; } }), (error) => error === failure);
});

async function createPublishedFixtureIndex(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const generation = beginUnifiedIndexGeneration(database, { contractVersion: "usage-event-v0.2", receivedAtMs: Date.parse(END),
    discoveredSourceCount: 1, discoveredSourceBytes: 4_096 });
  const writer = createUnifiedIndexWriter(database, { contractVersion: "usage-event-v0.2", receivedAtMs: Date.parse(END),
    generationId: generation.generationId, parserVersionId: generation.parserVersionId, ingestRunId: generation.ingestRunId });
  const sourceLocal = Buffer.alloc(32, 7); const sessionLocal = Buffer.alloc(32, 8);
  const accountScopeId = writer.internAccountScope({ status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null });
  const modelId = writer.internModel("gpt-5.6-sol", "recognized");
  const tierId = writer.internTier({ apiServiceTier: "unknown", billingSurface: "chatgpt_subscription",
    codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null });
  const surfaceId = writer.internSurface({ agentScope: "root", surface: "cli_exec", threadSource: "user", lineageDisposition: "standalone" });
  for (let index = 0; index < 14; index += 1) {
    const observedAtMs = Date.parse(START) + index * 3_600_000;
    const sourceOffset = index + 1;
    const window = { observedAtMs, limitId: "codex", slot: "primary", planType: "pro",
      usedPercent: index, resetsAtMs: Date.parse(START) + WEEK, durationMins: 10_080 };
    const quotaObservationId = writer.internQuota(window);
    writer.writeQuotaOccurrence({ ...window, generationId: generation.generationId, sourceLocal, sourceOffset, sourceOrdinal: 0,
      surfaceId, canonicalObservationId: quotaObservationId, provider: "openai_codex", slotOrder: 0, admission: "admitted" });
    const eventKey = Buffer.alloc(32); eventKey.writeUInt32BE(index + 1, 28);
    writer.writeUsageEvent({ eventKey, observedAtMs, generationId: generation.generationId, sourceLocal, sourceOffset, sourceOrdinal: 0,
      sessionLocal, accountScopeId, modelId, tierId, surfaceId, quotaObservationId,
      reasoningEffort: 4, outcome: 5, tierObservedAtMs: null,
      tokensInUncached: index === 0 ? null : 100_000, tokensInCacheRead: index === 0 ? null : 500,
      tokensInCacheWrite: index === 0 ? null : 0, tokensInCacheWrite5m: null, tokensInCacheWrite1h: null,
      tokensOutText: index === 0 ? null : 20, tokensOutReasoning: index === 0 ? null : 10,
      tokensOutCombined: null, totalInputContext: null, partial: false });
  }
  writer.writeSourceCursor({ sourceLocal, sourceOrdinal: 0, sessionLocal, scannedBytes: 4_096, sizeBytes: 4_096,
    mtimeMs: Date.parse(END), snapshotsPersisted: true, turnContextSeen: true,
    carryModel: "gpt-5.6-sol", carryEffort: "high", carryTierRaw: null, carryTierObservedAtMs: null, carryTotals: null });
  writer.writeGenerationSource({ generationId: generation.generationId, sourceLocal, sourceOrdinal: 0, sessionLocal, surfaceId,
    status: "complete", discoveredSizeBytes: 4_096, scannedBytes: 4_096, mtimeMs: Date.parse(END), diagnosticsComplete: true });
  writer.writeSourceDiagnostics(sourceLocal, {}, { generationId: generation.generationId });
  for (const [key, value] of Object.entries({ contract_version: "usage-event-v0.2", status: "complete", generated_at: END, source_count: 1, source_bytes: 4_096 })) writer.writeMeta(key, value);
  writer.finalizeGeneration({ status: "complete", blockReason: null, discoveredSourceCount: 1, discoveredSourceBytes: 4_096,
    indexedSourceCount: 1, indexedSourceBytes: 4_096, discoveryComplete: true, diagnosticsComplete: true });
  await writer.close({ fsyncPath: indexFile });
}

async function invokeWorker(options) {
  const workerUrl = new URL("../scripts/lib/pr94-analysis-worker.mjs", import.meta.url).href;
  // Exercise the exported worker in a clean process without making this source
  // test a native platform claim. The protected CLI separately pins its runtime.
  const code = `import { runPr94AnalysisWorker } from ${JSON.stringify(workerUrl)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { key, ...options } = JSON.parse(input);
    try { process.stdout.write(JSON.stringify(await runPr94AnalysisWorker(options, Buffer.from(key, 'hex')))); }
    catch(error) { process.stdout.write(JSON.stringify({status:'error',code:typeof error.code==='string'?error.code:'unclassified'})); process.exitCode=1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ ...options, key: Buffer.from(KEY).toString("hex") }));
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  return { exit, stdout, stderr };
}

test("PR94 worker completes on an actual published synthetic index and binds both private evidence streams", async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pr94-worker-synthetic-")));
  await chmod(temporary, 0o700);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const indexFile = join(temporary, "index.sqlite");
  const outputDirectory = join(temporary, "out");
  await mkdir(outputDirectory, { mode: 0o700 });
  await createPublishedFixtureIndex(indexFile);
  await chmod(indexFile, 0o400);
  const before = await readFile(indexFile);
  const result = await invokeWorker({ root: ROOT, indexFile, outputDirectory, startAt: START, endAt: END, revisionKind: "final" });
  assert.equal(result.exit, 0, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "ok");
  const body = await readFile(join(outputDirectory, "analysis.json"));
  assert.equal(envelope.resultBytes, body.length);
  assert.equal(envelope.resultSha256, createHash("sha256").update(body).digest("hex"));
  const analysis = JSON.parse(body);
  assert.deepEqual(validatePr94AnalysisResult(analysis), analysis);
  assert.equal(analysis.contextBehavior, "legacy_zero");
  assert.equal(analysis.ledger.usage.events, 13);
  assert.equal(analysis.ledger.quota.events, 14);
  assert.equal(analysis.inventory.zeroComponentUsageRows, 1);
  assert.equal(analysis.calibration.status, "pass");
  assert.equal(analysis.calibration.counts.rawParents, 1);
  assert.equal(analysis.calibration.candidates[0].primary.count, 1);
  assert.equal(analysis.ledger.usage.context.zeroEvents, 13);
  assert.equal(analysis.ledger.usage.context.missingEvents, 0);
  assert.deepEqual(await readFile(indexFile), before);
  for (const name of ["analysis.json", "ledger.ndjson", "calibration.ndjson"]) {
    assert.equal((await stat(join(outputDirectory, name))).mode & 0o777, 0o600);
  }
  const readFrames = async (name) => (await readFile(join(outputDirectory, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const importedLedger = await importPr94LedgerEvidencePrivate(await readFrames("ledger.ndjson"), { hmacKey: KEY });
  t.after(() => disposePr94LedgerEvidencePrivate(importedLedger));
  assert.deepEqual(importedLedger, analysis.ledger);
  const expected = createPr94LedgerEvidence({ hmacKey: KEY });
  await createLocalUnifiedAccountingSource({ indexFile, requireComplete: true, verifyPublishedGeneration: true, contextBehavior: "legacy_zero" })({
    startAt: START, endAt: END, onUsage(row) { expected.consumeUsage(row, accounting.priceCodexUsageEvent(row)); },
    onRateLimitSnapshot(row) { expected.consumeQuota(row); },
  });
  const expectedEvidence = expected.finish();
  t.after(() => disposePr94LedgerEvidencePrivate(expectedEvidence));
  assert.equal(comparePr94LedgerEvidence(expectedEvidence, importedLedger).status, "equal");
  const importedCalibration = await importPr94CalibrationEvidence({ aggregate: analysis.calibration,
    frames: await readFrames("calibration.ndjson"), hmacKey: KEY });
  t.after(() => disposePr94CalibrationEvidencePrivate(importedCalibration));
  assert.deepEqual(importedCalibration, analysis.calibration);
  assert.doesNotMatch(result.stdout + body.toString("utf8"), /sourceLocal|sourceOffset|sourceOrdinal|sessionLocal|index\.sqlite|pr94-worker-synthetic|parentKey|fragmentKey/);
});
