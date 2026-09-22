import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
  parseTelemetryV12DayManifest,
  telemetryV12DayManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import {
  createTelemetryV11Day,
  createTelemetryV12Day,
  telemetryV12FieldInventory,
} from "../src/contribution/index.js";

const DAY = "2026-09-03";
const ACTIVATION = `${DAY}T12:00:00.000Z`;
const PARSER = "synthetic-v12";
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function usage(id, eventTime = `${DAY}T12:05:00.000Z`, overrides = {}) {
  return {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:v12:${id}`,
    eventTime,
    sessionUuid: "session-fixture-1",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 100,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 10,
      outputTextTokens: 5,
      outputReasoningTokens: 0,
      outputCombinedTokens: 5,
    },
    ...overrides,
  };
}

function quota() {
  return {
    schemaVersion: "quota-observation-v1.0",
    observationId: "quota:v12:fixture-1",
    observedTime: `${DAY}T12:05:00.000Z`,
    provider: "openai_codex",
    planType: "plus",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 20,
    windowDurationMinutes: 10_080,
    resetsAt: `${DAY}T13:05:00.000Z`,
  };
}

function session() {
  return {
    schemaVersion: "session-dimension-v1.0",
    sessionUuid: "session-fixture-1",
    firstEventTime: `${DAY}T12:05:00.000Z`,
    provider: "openai_codex",
    toolClassCounts: { localShell: 1 },
  };
}

function usageRecords(prepared) {
  return prepared.chunks.filter((chunk) => chunk.chunkId.startsWith("usage:"))
    .flatMap((chunk) => chunk.records);
}

function prepare(overrides = {}) {
  return createTelemetryV12Day({
    day: DAY,
    parserVersion: PARSER,
    recordsByStream: { usage: [usage("a")], quota: [quota()], session: [session()] },
    activationTime: ACTIVATION,
    continuityForRecord: () => ({ boundaryFlags: 0, tieOrder: 0 }),
    cacheWriteTtlForRecord: () => ({ fiveMinuteTokens: 4, oneHourTokens: 6 }),
    ...overrides,
  });
}

test("v1.2 cutoff keeps historical continuity unknown and accepts all boundary masks", () => {
  const source = [
    usage("before", `${DAY}T11:59:59.999Z`),
    usage("at", ACTIVATION),
    usage("zero", `${DAY}T12:01:00.000Z`),
    usage("turn", `${DAY}T12:02:00.000Z`),
    usage("compact", `${DAY}T12:03:00.000Z`),
    usage("both", `${DAY}T12:04:00.000Z`),
    usage("unknown", `${DAY}T12:05:00.000Z`),
  ];
  const masks = new Map([
    ["event:v12:at", 0], ["event:v12:zero", 0], ["event:v12:turn", 1],
    ["event:v12:compact", 2], ["event:v12:both", 3], ["event:v12:unknown", null],
  ]);
  const prepared = prepare({
    recordsByStream: { usage: source, quota: [quota()], session: [session()] },
    continuityForRecord: (_stream, record) => ({
      boundaryFlags: masks.get(record.eventId),
      tieOrder: 0,
    }),
  });
  const records = usageRecords(prepared);
  assert.deepEqual(records.map((record) => [record.eventId, record.boundaryFlags, record.tieOrder]), [
    ["event:v12:before", null, null],
    ["event:v12:at", 0, 0],
    ["event:v12:zero", 0, 0],
    ["event:v12:turn", 1, 0],
    ["event:v12:compact", 2, 0],
    ["event:v12:both", 3, 0],
    ["event:v12:unknown", null, 0],
  ]);
  assert.deepEqual(records.find((record) => record.eventId === "event:v12:before").cacheWriteTtl,
    { fiveMinuteTokens: 4, oneHourTokens: 6 });
  assert.deepEqual(records.find((record) => record.eventId === "event:v12:at").cacheWriteTtl,
    { fiveMinuteTokens: 4, oneHourTokens: 6 });
  assert.equal(prepared.chunks.find((chunk) => chunk.chunkId.startsWith("quota:")).records[0].schemaVersion,
    "quota-observation-v1.2");
  assert.equal(prepared.chunks.find((chunk) => chunk.chunkId.startsWith("session:")).records[0].schemaVersion,
    "session-dimension-v1.2");
});

test("v1.2 rejects invalid activation times and never reuses old consent", () => {
  assert.throws(() => prepare({ activationTime: "2026-09-03T12:00:00Z" }), /activation time/u);
  assert.throws(() => prepare({ activationTime: "not-a-date" }), /activation time/u);
  assert.throws(() => prepare({ activationTime: "+010000-01-01T00:00:00.000Z" }), /activation time/u);
  assert.throws(() => prepare({ activationTime: "-000001-01-01T00:00:00.000Z" }), /activation time/u);
  assert.throws(() => prepare({ activationTime: "2026-02-30T12:00:00.000Z" }), /activation time/u);
  const prepared = prepare({ activationTime: null });
  const record = usageRecords(prepared)[0];
  assert.equal(record.boundaryFlags, null);
  assert.equal(record.tieOrder, null);
  assert.deepEqual(record.cacheWriteTtl, { fiveMinuteTokens: 4, oneHourTokens: 6 });
  assert.equal(prepared.manifest.consent.telemetrySchemaVersion, "telemetry-contribution-v1.2");
  assert.notEqual(prepared.manifest.consent.telemetrySchemaVersion, "telemetry-contribution-v1.1");
});

test("v1.2 validates a tied group across the 200-record chunk boundary", () => {
  const source = Array.from({ length: 205 }, (_, index) => usage(
    String(index).padStart(3, "0"), `${DAY}T12:05:00.000Z`, {
      eventId: `event:v12:tied-${String(index).padStart(3, "0")}`,
    },
  ));
  const prepared = prepare({
    recordsByStream: { usage: source },
    continuityForRecord: (_stream, record) => ({
      boundaryFlags: 0,
      tieOrder: Number(record.eventId.slice(-3)),
    }),
  });
  const chunks = prepared.chunks.filter((chunk) => chunk.chunkId.startsWith("usage:"));
  assert.deepEqual(chunks.map((chunk) => chunk.records.length), [200, 5]);
  assert.deepEqual(usageRecords(prepared).map((record) => record.tieOrder).sort((a, b) => a - b),
    Array.from({ length: 205 }, (_, index) => index));
});

test("v1.2 refuses partial or gapped tie ranks, duplicate occurrences, and TTL mismatches", () => {
  const badRanks = [0, 1, null];
  assert.throws(() => prepare({
    recordsByStream: { usage: badRanks.map((rank, index) => usage(`partial-${index}`, ACTIVATION, {
      eventId: `event:v12:partial-${index}`,
    })) },
    continuityForRecord: (_stream, record) => ({
      boundaryFlags: 0,
      tieOrder: badRanks[Number(record.eventId.slice(-1))],
    }),
  }));
  assert.throws(() => prepare({
    recordsByStream: { usage: [usage("gap-a"), usage("gap-b")] },
    continuityForRecord: (_stream, record) => ({
      boundaryFlags: 0,
      tieOrder: record.eventId.endsWith("a") ? 0 : 2,
    }),
  }));
  assert.throws(() => prepare({
    recordsByStream: { usage: [usage("duplicate"), usage("duplicate")] },
  }), /occurrence/u);
  assert.throws(() => prepare({
    cacheWriteTtlForRecord: () => ({ fiveMinuteTokens: 3, oneHourTokens: 3 }),
  }), /reconcile/u);
  assert.throws(() => prepare({
    continuityForRecord: () => ({ turnContextBefore: true, compactionBefore: false }),
  }), /boundaryFlags/u);
});

test("v1.2 strips private source and callback fields and snapshots deterministic immutable bytes", () => {
  const source = usage("private", `${DAY}T12:05:00.000Z`, {
    prompt: "private-synthetic-canary",
    source_local: Buffer.alloc(32, 4),
    source_offset: 8,
    path: "/Users/private/rollout.jsonl",
  });
  const options = {
    recordsByStream: { usage: [source] },
    continuityForRecord: () => ({
      boundaryFlags: 3,
      tieOrder: 0,
      prompt: "private-callback-canary",
      source_offset: 42,
    }),
    cacheWriteTtlForRecord: () => ({ fiveMinuteTokens: 4, oneHourTokens: 6,
      path: "/Users/private/ttl.json" }),
  };
  const first = prepare(options);
  const second = prepare(options);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("private-synthetic-canary"), false);
  assert.equal(JSON.stringify(first).includes("private-callback-canary"), false);
  assert.equal(JSON.stringify(first).includes("/Users/private"), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.manifest), true);
  assert.equal(Object.isFrozen(first.chunks[0].records[0]), true);
  assert.equal(Object.isFrozen(first.chunks[0].records[0].components), true);
  source.components.inputUncachedTokens = 999;
  assert.equal(usageRecords(first)[0].components.inputUncachedTokens, 100);
  assert.equal(first.manifest.manifestDigest, hash(telemetryV12DayManifestDigestInput(first.manifest)));
  for (const chunk of first.chunks) {
    assert.equal(chunk.chunkDigest, hash(canonicalTelemetryV12Json(chunk.records)));
    assert.deepEqual(parseTelemetryV12Chunk(chunk), chunk);
  }
  assert.deepEqual(parseTelemetryV12DayManifest(first.manifest), first.manifest);

  const legacy = createTelemetryV11Day({
    day: DAY,
    parserVersion: "synthetic-v11",
    recordsByStream: { usage: [usage("legacy")] },
  });
  assert.equal(legacy.chunks[0].records[0].schemaVersion, "usage-event-v1.1");
  assert.equal(Object.hasOwn(legacy.chunks[0].records[0], "boundaryFlags"), false);
  assert.equal(Object.hasOwn(legacy.chunks[0].records[0], "cacheWriteTtl"), false);
});

test("v1.2 inventory makes consent, nullable continuity, and TTL purposes reviewable", () => {
  const inventory = telemetryV12FieldInventory();
  assert.equal(inventory.contractState, "staged");
  assert.deepEqual(inventory.nullableUsageFields, ["boundaryFlags", "tieOrder", "cacheWriteTtl"]);
  assert.deepEqual(inventory.boundaryFlags, {
    nullable: true,
    minimum: 0,
    maximum: 3,
    bit0: "turn_context_before",
    bit1: "compaction_before",
  });
  assert.deepEqual(inventory.tieOrder, {
    nullable: true,
    minimum: 0,
    maximum: 819_199,
    group: ["sessionUuid", "eventTime"],
    rankStart: 0,
  });
  assert.deepEqual(inventory.cacheWriteTtl, {
    fields: ["fiveMinuteTokens", "oneHourTokens"],
    aggregateField: "components.inputCacheWriteTokens",
    additive: false,
  });
  assert.ok(inventory.fields.usage.includes("boundaryFlags"));
  assert.ok(inventory.fields.usage.includes("tieOrder"));
  assert.ok(inventory.fields.usage.includes("cacheWriteTtl"));
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.fields), true);
});
