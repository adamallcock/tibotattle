import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginUnifiedIndexGeneration, createUnifiedIndexWriter, openLocalUnifiedIndex,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION, outcomeName, reasoningEffortName,
} from "../src/local-unified-index.js";
import { createLocalUnifiedTelemetryV11Reader } from "../src/local-unified-contribution-attribution.js";
import { createLocalUnifiedUsageAttributionReader } from "../src/local-unified-accounting-source.js";
import { createTelemetryV1IndexReader } from "../src/contribution/telemetry-v1-chunks.js";
import { createTelemetryV11Day } from "../src/contribution/index.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";

const DAY = "2026-08-01";
const START = Date.parse(`${DAY}T12:00:00.000Z`);
const RESET = Date.parse("2026-08-08T12:00:00.000Z");
const codecs = { outcomeName, reasoningEffortName, fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION };
const binding = { destinationOrigin: "https://telemetry.example", enrollmentNamespace: "synthetic_enrollment_0001" };
const secret = Buffer.alloc(32, 9);
const stamp = (offset) => new Date(START + offset).toISOString();
const eventKey = (id) => { const key = Buffer.alloc(32); key.writeUInt32BE(id, 28); return key; };
const scope = (id = 7, planType = "pro") => ({
  status: "available", reason: null, version: "openai-account-v1",
  scopeId: `openai-account:v1:${Buffer.alloc(32, id).toString("base64url")}`, planType,
});
const marker = (options = {}) => ({
  version: "provisional-account-marker-v2", capturedAt: stamp(-1), receivedAt: stamp(2_000),
  accountScope: scope(), source: "app_server_read", observationBinding: binding, ...options,
});

async function writeFixture(t, { records = [], sources = [1], file = null, replace = false, size = 4096, publish = true } = {}) {
  if (file === null) {
    const root = await mkdtemp(join(tmpdir(), "telemetry-v11-local-proof-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    file = join(root, "index.sqlite");
  }
  const database = openLocalUnifiedIndex(file, { create: true });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2", receivedAtMs: START,
    discoveredSourceCount: sources.length, discoveredSourceBytes: sources.length * size,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2", receivedAtMs: START,
    generationId: generation.generationId, parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
  });
  if (replace) {
    for (const source of sources) writer.deleteSourceFacts(Buffer.alloc(32, source), Buffer.alloc(32, source + 20));
  }
  const accountScopeId = writer.internAccountScope({ status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null });
  const modelId = writer.internModel("gpt-5.6-sol", "recognized");
  const tierId = writer.internTier({
    apiServiceTier: "unknown", billingSurface: "chatgpt_subscription", codexSpeedMode: "standard",
    tierSource: "unknown", providerTierRaw: null,
  });
  const surfaceId = writer.internSurface({ agentScope: "root", surface: "cli_exec", threadSource: "user", lineageDisposition: "standalone" });
  const coords = (source = 1) => ({
    sourceLocal: Buffer.alloc(32, source), sourceOrdinal: sources.indexOf(source), sessionLocal: Buffer.alloc(32, source + 20),
  });
  for (const [index, record] of records.entries()) {
    const source = coords(record.source);
    const at = START + (record.at ?? index * 1_000);
    const offset = record.offset ?? index + 1;
    let quotaObservationId = null;
    for (const [slotOrder, quota] of (record.quotas ?? []).entries()) {
      const window = {
        observedAtMs: at, limitId: quota.limitId ?? "codex", slot: quota.slot ?? (slotOrder ? "secondary" : "primary"),
        planType: quota.plan ?? null, usedPercent: quota.percent ?? 10, resetsAtMs: quota.missingReset ? null : RESET,
        durationMins: quota.duration ?? 10_080,
      };
      const canonicalObservationId = writer.internQuota(window);
      quotaObservationId ??= canonicalObservationId;
      writer.writeQuotaOccurrence({
        ...source, sourceOffset: offset, generationId: generation.generationId, surfaceId,
        canonicalObservationId, ...window, provider: "openai_codex", slotOrder,
        admission: quota.admission ?? "admitted",
      });
    }
    if (record.usage !== false) writer.writeUsageEvent({
      eventKey: eventKey(record.id ?? index + 1), observedAtMs: at, generationId: generation.generationId,
      ...source, sourceOffset: offset, accountScopeId, modelId, tierId, surfaceId, quotaObservationId,
      reasoningEffort: 4, outcome: 5, tierObservedAtMs: null,
      tokensInUncached: record.tokens ?? 10, tokensInCacheRead: 20, tokensInCacheWrite: 0,
      tokensInCacheWrite5m: null, tokensInCacheWrite1h: null, tokensOutText: 1,
      tokensOutReasoning: 0, tokensOutCombined: null, totalInputContext: null, partial: false,
    });
  }
  for (const sourceId of sources) {
    const source = coords(sourceId);
    writer.recordSessionIdentity(source.sessionLocal, `11111111-2222-4333-8444-${String(sourceId).padStart(12, "0")}`);
    if (records.length) writer.writeToolClassFact({ ...source, eventKey: Buffer.alloc(32, sourceId + 71),
      sourceOffset: 1, generationId: generation.generationId, observedAtMs: START,
      toolOrdinal: 0, toolClass: "localShell", sourceKind: "response_item" });
    writer.writeSourceCursor({
      ...source, scannedBytes: size, sizeBytes: size, mtimeMs: START,
      snapshotsPersisted: true, turnContextSeen: true, carryModel: "gpt-5.6-sol", carryEffort: "high",
      carryTierRaw: null, carryTierObservedAtMs: null, carryTotals: null,
    });
    writer.writeGenerationSource({
      ...source, generationId: generation.generationId, surfaceId, status: "complete",
      discoveredSizeBytes: size, scannedBytes: size, mtimeMs: START, diagnosticsComplete: true,
    });
    writer.writeSourceDiagnostics(source.sourceLocal, {}, { generationId: generation.generationId });
  }
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", "complete");
  const commitPublication = async () => {
    writer.finalizeGeneration({
      status: "complete", blockReason: null, discoveredSourceCount: sources.length,
      discoveredSourceBytes: sources.length * size, indexedSourceCount: sources.length,
      indexedSourceBytes: sources.length * size, discoveryComplete: true, diagnosticsComplete: true,
    });
    await writer.close({ fsyncPath: file });
  };
  if (publish) await commitPublication();
  else {
    writer.flush();
    t.after(async () => { if (database.isOpen) await writer.close({ fsyncPath: file }); });
  }
  return { file, generationId: generation.generationId, commitPublication };
}

function readFixture(t, file, options = {}, readOnly = true) {
  const database = openLocalUnifiedIndex(file, { readOnly });
  t.after(() => database.close());
  return { database, reader: createLocalUnifiedTelemetryV11Reader(database, { ...codecs, ...options }) };
}

function project(day, options = {}) {
  return createTelemetryV11Day({ day: DAY, ...day, accountObservationSecret: secret, binding,
    parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION, ...options });
}
const stream = (result, name) => result.chunks.filter((chunk) => (chunk.stream ?? chunk.chunkId.split(":")[0]) === name).flatMap((chunk) => chunk.records);

test("exact historical plans survive canonical collisions while usage/session identities and totals stay unchanged", async (t) => {
  const { file } = await writeFixture(t, { sources: [1, 2], records: [
    { source: 1, at: 0, tokens: 23, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
    { source: 2, at: 0, tokens: 47, quotas: [{ plan: "plus", duration: 300, percent: 90 }, { plan: "plus", percent: 90 }] },
  ] });
  const { database, reader } = readFixture(t, file);
  assert.deepEqual(database.prepare("SELECT DISTINCT plan_type FROM quota_observation").all().map((row) => row.plan_type), ["plus"]);
  const base = createTelemetryV1IndexReader(database, codecs).deriveDay(DAY);
  const day = reader.readDay(DAY);
  assert.deepEqual(day.recordsByStream.usage, stream(base, "usage"));
  assert.deepEqual(day.recordsByStream.session, stream(base, "session"));
  assert.equal(day.recordsByStream.quota.length, 4);
  assert.equal(new Set(day.recordsByStream.quota.map((row) => row.observationId)).size, 4);
  const result = project(day);
  assert.deepEqual(stream(result, "usage").map((row) => row.accountPlanAttribution), ["pro", "plus"].map((planType) => ({
    accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence", planType, planEraId: null,
  })));
  assert.equal(stream(result, "usage").reduce((sum, row) => sum + row.components.inputUncachedTokens, 0), 70);
  assert.deepEqual(reader.days(), [DAY]);
  assert.deepEqual(project(reader.readDay(DAY)), result);
});

test("held/suppressed quota cannot attribute usage and quota-only plan changes are retained", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { quotas: [{ plan: "plus", admission: "held" }] },
    { quotas: [{ plan: "plus", admission: "suppressed" }] },
    { usage: false, quotas: [{ plan: "plus" }] },
    { quotas: [{ plan: "pro" }, { plan: "plus" }] },
    { quotas: [{ plan: null }] },
    { quotas: [{ plan: "pro", missingReset: true }] },
  ] });
  const { reader } = readFixture(t, file);
  const day = reader.readDay(DAY);
  const result = project(day);
  assert.equal(stream(result, "usage").length, 5);
  assert.equal(stream(result, "quota").length, 5);
  assert.equal(stream(result, "quota").find((row) => row.observedTime === stamp(5_000)).resetsAt, null);
  assert.deepEqual(day.excluded, { usage: 0, quota: 0, session: 0 });
  assert.deepEqual(stream(result, "usage").map((row) => [row.accountPlanAttribution.planBasis, row.accountPlanAttribution.planType]), [
    ["unavailable", "unknown"], ["unavailable", "unknown"], ["conflicted", "unknown"],
    ["unavailable", "unknown"], ["same_source_occurrence", "pro"],
  ]);
});

test("published source coordinates are required, and duplicate slot labels do not collapse occurrences", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { quotas: [{ plan: "pro", slot: "primary", duration: 300 }, { plan: "pro", slot: "primary" }] },
  ] });
  const { database, reader } = readFixture(t, file, {}, false);
  const original = project(reader.readDay(DAY));
  assert.equal(stream(original, "quota").length, 2);
  assert.equal(new Set(stream(original, "quota").map((row) => row.observationId)).size, 2);
  database.prepare("UPDATE generation_source SET source_ordinal = source_ordinal + 1").run();
  assert.throws(() => reader.readDay(DAY), { code: "local_telemetry_v11_publication_mismatch" });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM usage_event").get().count, 1);
  assert.equal(database.prepare("SELECT tokens_in_uncached FROM usage_event").get().tokens_in_uncached, 10);
});

test("copy-forward membership retains exact occurrence identities; replacement refreshes plan proof", async (t) => {
  const fixture = await writeFixture(t, { records: [{ quotas: [{ plan: "pro" }] }] });
  const { reader } = readFixture(t, fixture.file);
  const first = project(reader.readDay(DAY));
  const next = await writeFixture(t, { file: fixture.file });
  assert.notEqual(next.generationId, fixture.generationId);
  assert.deepEqual(project(reader.readDay(DAY)), first);
  await writeFixture(t, { file: fixture.file, replace: true, records: [{ quotas: [{ plan: "plus" }] }] });
  const changed = project(reader.readDay(DAY));
  assert.equal(stream(changed, "usage")[0].eventId, stream(first, "usage")[0].eventId);
  assert.equal(stream(changed, "quota")[0].observationId, stream(first, "quota")[0].observationId);
  assert.equal(stream(changed, "usage")[0].accountPlanAttribution.planType, "plus");
  assert.notDeepEqual(changed.manifest, first.manifest);
});

test("same-source staged appends cannot borrow old byte bounds or publish before their generation", async (t) => {
  const first = await writeFixture(t, { size: 64, records: [{ id: 1, at: 0, offset: 1, quotas: [{ plan: "pro" }] }] });
  const { database, reader } = readFixture(t, first.file);
  const accepted = project(reader.readDay(DAY));
  const staged = await writeFixture(t, { file: first.file, size: 128, publish: false,
    records: [{ id: 2, at: 1_000, offset: 65, quotas: [{ plan: "plus" }] }],
  });
  const exact = createLocalUnifiedUsageAttributionReader({ database, generationId: first.generationId });
  const rows = database.prepare("SELECT * FROM usage_event ORDER BY observed_at_ms").all();
  assert.equal(exact.read(rows[0]).planAttribution.planType, "pro");
  assert.equal(exact.read(rows[1]).planAttribution.basis, "unavailable");
  assert.equal(exact.read(rows[1]).usageIntervalStartedAt, null);
  assert.throws(() => reader.readDay(DAY), { code: "local_telemetry_v11_index_unavailable" });
  assert.equal(stream(accepted, "usage")[0].accountPlanAttribution.planType, "pro", "last accepted result remains immutable");
  await staged.commitPublication();
  const published = project(reader.readDay(DAY));
  assert.equal(stream(published, "usage").length, 2);
  assert.deepEqual(stream(published, "usage").map((row) => row.accountPlanAttribution.planType), ["pro", "plus"]);
  assert.equal(database.prepare("SELECT generation_id FROM usage_event WHERE event_key = ?").get(eventKey(1)).generation_id,
    first.generationId, "copy-forward fact keeps its original row generation");
});

test("production final-line offsets remain admitted through cold publication, skipped replay and resumed append", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "telemetry-v11-production-offset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", "2026", "08", "01");
  await mkdir(sessions, { recursive: true });
  const file = join(root, "index.sqlite");
  const rollout = join(sessions, "rollout-2026-08-01T12-00-00-11111111-2222-4333-8444-000000000001.jsonl");
  const count = (offset, planType, total) => JSON.stringify({
    timestamp: stamp(offset), type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100 } },
      rate_limits: { limit_id: "codex", plan_type: planType, secondary: {
        used_percent: 20, window_minutes: 10080, resets_at: RESET / 1000,
      } },
    },
  });
  let body = [JSON.stringify({ timestamp: stamp(-2), type: "session_meta", payload: {
    id: "11111111-2222-4333-8444-000000000001", thread_source: "user", originator: "codex_cli_rs",
  } }), JSON.stringify({ timestamp: stamp(-1), type: "turn_context", payload: {
    model: "gpt-5.6-sol", effort: "high",
  } }), count(0, "pro", 100), count(1_000, "pro", 200)].join("\n") + "\n";
  await writeFile(rollout, body);
  const ingest = () => ingestLocalUnifiedIndexIncrement({ codexHome: root, indexFile: file,
    secretFile: join(root, "synthetic-salt"), contractVersion: "usage-event-v0.2",
    coldRebuildIfMissing: true, coldBackfillWorkerCount: 1 });
  const inspect = (expected, expectedStatus) => {
    const database = openLocalUnifiedIndex(file, { readOnly: true });
    try {
      const member = database.prepare("SELECT * FROM generation_source ORDER BY generation_id DESC LIMIT 1").get();
      const finalUsage = database.prepare("SELECT * FROM usage_event ORDER BY source_offset DESC LIMIT 1").get();
      const finalQuota = database.prepare("SELECT * FROM quota_occurrence ORDER BY source_offset DESC LIMIT 1").get();
      assert.equal(member.scanned_bytes, Buffer.byteLength(body));
      assert.equal(finalUsage.source_offset, member.scanned_bytes, "extractor stores the complete line end, not its start");
      assert.equal(finalQuota.source_offset, member.scanned_bytes);
      assert.equal(member.diagnostics_complete, 1);
      if (expectedStatus) assert.equal(member.status, expectedStatus);
      const exact = createLocalUnifiedUsageAttributionReader({ database, generationId: member.generation_id });
      assert.equal(exact.read(finalUsage).planAttribution.planType, expected.at(-1));
      const day = createLocalUnifiedTelemetryV11Reader(database, codecs).readDay(DAY);
      assert.equal(day.recordsByStream.usage.length, expected.length);
      assert.equal(day.recordsByStream.quota.length, expected.length, JSON.stringify({
        quota: database.prepare("SELECT source_offset, observed_at_ms, plan_type, admission, duration_mins, used_percent FROM quota_occurrence ORDER BY source_offset").all(),
        excluded: day.excluded,
      }));
      assert.deepEqual(day.recordsByStream.usage.map((row) => day.attributionForRecord("usage", row).planType), expected);
    } finally { database.close(); }
  };
  await ingest();
  inspect(["pro", "pro"]);
  await ingest();
  // A wholly unchanged pass can retain its already-published generation.
  inspect(["pro", "pro"], "complete");
  const appended = count(2_000, "plus", 300) + "\n";
  await appendFile(rollout, appended);
  body += appended;
  await ingest();
  inspect(["pro", "pro", "plus"], "resumed");
  await ingest();
  inspect(["pro", "pro", "plus"], "resumed");
});

test("published source modes require complete diagnostics but retain every admitted fact", async (t) => {
  const { file, generationId } = await writeFixture(t, { size: 64,
    records: [{ id: 1, at: 0, offset: 64, quotas: [{ plan: "pro" }] }],
  });
  const { database } = readFixture(t, file, {}, false);
  const row = database.prepare("SELECT * FROM usage_event").get();
  for (const status of ["skipped", "touched", "resumed", "rescanned", "complete"]) {
    database.prepare("UPDATE generation_source SET status = ?").run(status);
    const exact = createLocalUnifiedUsageAttributionReader({ database, generationId });
    assert.equal(exact.read(row).planAttribution.planType, "pro", status);
    assert.equal(createLocalUnifiedTelemetryV11Reader(database, codecs).readDay(DAY).recordsByStream.quota.length, 1, status);
  }
  for (const status of ["pending", "failed"]) {
    database.prepare("UPDATE generation_source SET status = ?").run(status);
    assert.equal(createLocalUnifiedUsageAttributionReader({ database, generationId }).read(row).planAttribution.basis, "unavailable");
    assert.throws(() => createLocalUnifiedTelemetryV11Reader(database, codecs).readDay(DAY), { code: "local_telemetry_v11_publication_mismatch" });
  }
  database.exec("UPDATE generation_source SET status = 'complete', diagnostics_complete = 0");
  assert.equal(createLocalUnifiedUsageAttributionReader({ database, generationId }).read(row).planAttribution.basis, "unavailable");
  assert.throws(() => createLocalUnifiedTelemetryV11Reader(database, codecs).readDay(DAY), { code: "local_telemetry_v11_publication_mismatch" });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM usage_event").get().count, 1);
});

test("captured consent/account bracket labels only fully contained intervals and deduplicates paired quota era anchors", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
    { at: 1_000, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
  ] });
  const { reader } = readFixture(t, file, { accountMarkers: [marker()] });
  const day = reader.readDay(DAY);
  const result = project(day);
  const [first, second] = stream(result, "usage").map((row) => row.accountPlanAttribution);
  assert.equal(first.planType, "pro");
  assert.equal(first.accountTrackId, null, "first cumulative interval has no proven lower bound");
  assert.equal(second.accountBasis, "provisional_marker");
  assert.match(second.accountTrackId, /^account-track:v2:/u);
  assert.notEqual(second.planEraId, null);
  const quotaEras = stream(result, "quota").map((row) => row.accountPlanAttribution.planEraId);
  assert.deepEqual(new Set(quotaEras), new Set([second.planEraId]));
  assert.equal(day.attributionForRecord("session", day.recordsByStream.session[0]), null);
  assert.equal(day.attributionForRecord("quota", day.recordsByStream.usage[1]).planType, "unknown");
  assert.equal(day.attributionForRecord("usage", { ...day.recordsByStream.usage[1] }).planType, "unknown");
  assert.throws(() => { day.recordsByStream.usage[1].components.inputUncachedTokens = 999; }, TypeError);
  const serialized = JSON.stringify(result);
  for (const forbidden of [scope().scopeId, binding.enrollmentNamespace, binding.destinationOrigin,
    "source_local", "source_offset", "source_ordinal", "accountScope", "observationBinding"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const rebound = project(day, { binding: { ...binding, enrollmentNamespace: "synthetic_enrollment_0002" } });
  assert.ok(stream(rebound, "usage").every((row) => row.accountPlanAttribution.accountTrackId === null));
  assert.ok(stream(rebound, "usage").every((row) => row.accountPlanAttribution.planType === "pro"));
});

test("untrusted plan and marker extras cannot enter content-free prepared records", async (t) => {
  const canary = "PRIVATE_CONTENT_CANARY";
  const { file } = await writeFixture(t, { records: [{ quotas: [{ plan: canary }] }, { quotas: [{ plan: "pro" }] }] });
  const { database, reader } = readFixture(t, file, {
    accountMarkers: [marker({ rawPath: `/${canary}/session.jsonl`,
      accountScope: { ...scope(), rawEmail: `${canary}@example.test` } })],
  }, false);
  database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("synthetic_private_canary", canary);
  const result = project(reader.readDay(DAY));
  assert.equal(stream(result, "usage")[0].accountPlanAttribution.planType, "unknown");
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(result).includes("rawEmail"), false);
  assert.equal(JSON.stringify(result).includes("rawPath"), false);
});

test("old, future, expired, conflicting, and reversed-clock markers do not acquire historical ownership", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, quotas: [{ plan: "pro" }] }, { at: 1_000, quotas: [{ plan: "pro" }] },
  ] });
  const invalidCases = [
    [marker({ observationBinding: null })],
    [marker({ receivedAt: undefined })],
    [marker({ capturedAt: stamp(1_500), receivedAt: stamp(2_000) })],
    [marker({ capturedAt: stamp(-600_000) })],
    [marker({ capturedAt: stamp(2_000), receivedAt: stamp(-1) })],
    [marker(), marker({ accountScope: scope(8), capturedAt: stamp(500) })],
    [marker({ accountScope: scope(7, "plus") })],
  ];
  for (const accountMarkers of invalidCases) {
    const { reader } = readFixture(t, file, { accountMarkers });
    const attribution = stream(project(reader.readDay(DAY)), "usage")[1].accountPlanAttribution;
    assert.equal(attribution.accountTrackId, null);
    assert.equal(attribution.planEraId, null);
    assert.equal(attribution.planType, "pro");
  }
});

test("quota-only intervening changes and reversed source clocks retain ending plan without interval-era claims", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, offset: 1, quotas: [{ plan: "pro" }] },
    { at: 500, offset: 2, usage: false, quotas: [{ plan: "plus", duration: 300 }] },
    { at: 1_000, offset: 3, quotas: [{ plan: "pro" }] },
    { at: 900, offset: 4, quotas: [{ plan: "pro" }] },
  ] });
  const { reader } = readFixture(t, file, { accountMarkers: [marker()] });
  const result = project(reader.readDay(DAY));
  assert.equal(stream(result, "quota").length, 4);
  assert.equal(stream(result, "usage").length, 3);
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.planType === "pro"));
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.planEraId === null));
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.accountTrackId === null));
});

test("pinned reader rejects generation mutation, rolls back its scope, and can be retried", async (t) => {
  const { file } = await writeFixture(t, { records: [{ quotas: [{ plan: "pro" }] }] });
  const database = openLocalUnifiedIndex(file);
  t.after(() => database.close());
  const before = database.prepare("SELECT value FROM meta WHERE key = 'current_generation_id'").get().value;
  let mutate = true;
  const reader = createLocalUnifiedTelemetryV11Reader(database, { ...codecs,
    outcomeName(value) {
      if (mutate) {
        mutate = false;
        database.prepare("UPDATE meta SET value = '999999' WHERE key = 'current_generation_id'").run();
      }
      return outcomeName(value);
    },
  });
  assert.throws(() => reader.readDay(DAY), { code: "local_telemetry_v11_generation_changed" });
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'current_generation_id'").get().value, before);
  assert.equal(reader.readDay(DAY).recordsByStream.usage.length, 1);
  database.exec("BEGIN");
  assert.equal(reader.readDay(DAY).recordsByStream.usage.length, 1);
  assert.equal(database.isTransaction, true, "the caller's outer transaction remains open");
  database.exec("ROLLBACK");
});

test("acquisition bounds fail closed without dropping records or mutating the index", async (t) => {
  const { file } = await writeFixture(t, { records: [{ quotas: [{ plan: "pro" }] }, { quotas: [{ plan: "pro" }] }] });
  const { database, reader } = readFixture(t, file, { limits: { dayRows: 1 } });
  const before = database.prepare("SELECT * FROM usage_event ORDER BY event_key").all();
  assert.throws(() => reader.readDay(DAY), { code: "local_telemetry_v11_day_limit_exceeded" });
  assert.deepEqual(database.prepare("SELECT * FROM usage_event ORDER BY event_key").all(), before);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 11);
  assert.throws(() => reader.readDay("2026-02-30"), { code: "local_telemetry_v11_invalid_day" });
  assert.throws(() => createLocalUnifiedTelemetryV11Reader(database, { ...codecs, limits: { dayRows: Infinity } }), {
    code: "local_telemetry_v11_invalid_limits",
  });
});
