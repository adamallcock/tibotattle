import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  outcomeName,
  outcomeOrdinal,
  reasoningEffortName,
  reasoningEffortOrdinal,
} from "../src/local-unified-index.js";
import {
  MAX_TELEMETRY_V1_CHUNK_RECORDS,
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
  TelemetryV1ChunkError,
  buildTelemetryV1ChunkPlaintext,
  createTelemetryV1IndexReader,
  planTelemetryV1Upload,
  telemetryV1CanonicalJson,
  telemetryV1ChunkDigest,
  telemetryV1DayDigest,
  telemetryV1HistoryDigest,
  telemetryV1RequiredConsent,
} from "../src/contribution/telemetry-v1-chunks.js";
import {
  createTelemetryV1Envelope,
} from "../src/platform/telemetry-v1-envelope.js";

const DAY_ONE = "2026-08-01";
const DAY_TWO = "2026-08-02";
const SESSION_A_UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_A_LOCAL = Buffer.alloc(32, 0x0a);
const SESSION_B_LOCAL = Buffer.alloc(32, 0x0b);

// The same index-port composition the production sync engine performs: the
// reader receives the unified index's row codecs by injection.
function indexReader(database) {
  return createTelemetryV1IndexReader(database, {
    outcomeName,
    reasoningEffortName,
    fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  });
}

function dayMs(day, offsetMs = 0) {
  return Date.parse(`${day}T00:00:00.000Z`) + offsetMs;
}

function eventKey(index) {
  const key = Buffer.alloc(32, 0);
  key.writeUInt32BE(index, 28);
  return key;
}

/**
 * Build a real unified index from typed rows, in a caller-chosen insertion
 * order, so determinism is proven against storage order rather than assumed.
 */
async function buildIndex(file, { events, quotas = [], toolCounts = [] }) {
  const database = openLocalUnifiedIndex(file, {
    readOnly: false,
    create: true,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "telemetry-contribution-v0.1",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: "missing_account",
    planType: null,
    scopeLocal: null,
  });
  const defaultModelRowId = writer.internModel("gpt-5.6-sol", "recognized");
  const modelRowIds = new Map([["gpt-5.6-sol", defaultModelRowId]]);
  function modelRowId(name) {
    if (name === undefined) return defaultModelRowId;
    let id = modelRowIds.get(name);
    if (id === undefined) {
      id = writer.internModel(name, "recognized");
      modelRowIds.set(name, id);
    }
    return id;
  }
  const tierId = writer.internTier({
    apiServiceTier: "unknown",
    billingSurface: "chatgpt_subscription",
    codexSpeedMode: "standard",
    tierSource: "rollout_thread_settings",
    providerTierRaw: "default",
  });
  const surfaceId = writer.internSurface({
    agentScope: "root",
    surface: "extension_or_ide",
    threadSource: "rollout",
    lineageDisposition: "standalone",
  });
  writer.recordSessionIdentity(SESSION_A_LOCAL, SESSION_A_UUID);
  // A filename-shaped fallback id must never be stored as identity.
  assert.equal(
    writer.recordSessionIdentity(
      SESSION_B_LOCAL,
      "rollout-2026-08-01T00-00-00-bbbb.jsonl",
    ),
    false,
  );
  for (const quota of quotas) writer.internQuota(quota);
  for (const event of events) {
    writer.writeUsageEvent({
      eventKey: event.eventKey,
      observedAtMs: event.observedAtMs,
      sessionLocal: event.sessionLocal,
      accountScopeId,
      modelId: modelRowId(event.model),
      tierId,
      surfaceId,
      quotaObservationId: null,
      reasoningEffort: reasoningEffortOrdinal("medium"),
      outcome: outcomeOrdinal("unknown"),
      tokensInUncached: event.tokensInUncached ?? 100,
      tokensInCacheRead: 200,
      tokensInCacheWrite: null,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: 5,
      tokensOutReasoning: 2,
      tokensOutCombined: null,
      totalInputContext: null,
    });
  }
  for (const tool of toolCounts) {
    writer.addToolClassCount(tool.sessionLocal, tool.toolClass, tool.count);
  }
  await writer.close({ integrityCheck: true, fsyncPath: null });
}

function fixtureEvents() {
  return [
    // DAY_ONE: three events across two sessions.
    { eventKey: eventKey(1), observedAtMs: dayMs(DAY_ONE, 1_000), sessionLocal: SESSION_A_LOCAL },
    { eventKey: eventKey(2), observedAtMs: dayMs(DAY_ONE, 2_000), sessionLocal: SESSION_A_LOCAL },
    { eventKey: eventKey(3), observedAtMs: dayMs(DAY_ONE, 3_000), sessionLocal: SESSION_B_LOCAL },
    // DAY_TWO: one event.
    { eventKey: eventKey(4), observedAtMs: dayMs(DAY_TWO, 1_000), sessionLocal: SESSION_A_LOCAL },
  ];
}

function fixtureQuotas() {
  return [
    {
      observedAtMs: dayMs(DAY_ONE, 1_500),
      limitId: "codex",
      slot: "primary",
      planType: "plus",
      usedPercent: 41.5,
      resetsAtMs: dayMs(DAY_TWO, 0),
      durationMins: 300,
    },
    {
      // Incomplete observation: no percentage. Deterministically excluded
      // from transport, never invented.
      observedAtMs: dayMs(DAY_ONE, 1_600),
      limitId: "codex",
      slot: "secondary",
      planType: null,
      usedPercent: null,
      resetsAtMs: null,
      durationMins: null,
    },
  ];
}

function fixtureToolCounts() {
  return [
    { sessionLocal: SESSION_A_LOCAL, toolClass: "localShell", count: 3 },
    { sessionLocal: SESSION_A_LOCAL, toolClass: "webSearch", count: 1 },
  ];
}

async function withFixtureIndex(run, { mutate = null, reversed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "telemetry-v1-chunks-"));
  const file = join(root, "index.sqlite");
  try {
    const events = fixtureEvents();
    await buildIndex(file, {
      events: reversed ? [...events].reverse() : events,
      quotas: fixtureQuotas(),
      toolCounts: fixtureToolCounts(),
    });
    if (mutate !== null) await mutate(file);
    const database = openLocalUnifiedIndex(file, { readOnly: true });
    try {
      return await run(indexReader(database), file);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
}

test("every model identity ships, with the provider derived from the reviewed registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "telemetry-v1-models-"));
  const file = join(root, "index.sqlite");
  try {
    await buildIndex(file, {
      events: [
        // Reviewed, and previously carried by the transport allowlist.
        { eventKey: eventKey(1), observedAtMs: dayMs(DAY_ONE, 1_000), sessionLocal: SESSION_A_LOCAL, model: "gpt-5.6-sol" },
        // Reviewed by src/export/registries.js, but the stale transport
        // allowlist dropped it: exactly the class of loss this widening ends.
        { eventKey: eventKey(2), observedAtMs: dayMs(DAY_ONE, 2_000), sessionLocal: SESSION_A_LOCAL, model: "codex-auto-review" },
        // Metered against its own allowance, so it must reach the service to
        // be excluded from primary-pool comparisons rather than vanish.
        { eventKey: eventKey(3), observedAtMs: dayMs(DAY_ONE, 3_000), sessionLocal: SESSION_A_LOCAL, model: "gpt-5.3-codex-spark" },
        // A Claude identity derives the Anthropic provider, not the majority.
        { eventKey: eventKey(4), observedAtMs: dayMs(DAY_ONE, 4_000), sessionLocal: SESSION_A_LOCAL, model: "claude-sonnet-5" },
        // Never reviewed: it ships, labelled honestly rather than guessed.
        { eventKey: eventKey(5), observedAtMs: dayMs(DAY_ONE, 5_000), sessionLocal: SESSION_A_LOCAL, model: "nova-9-preview" },
      ],
      // A session record exists only where tool-class counts do.
      toolCounts: [
        { sessionLocal: SESSION_A_LOCAL, toolClass: "mcp", count: 2 },
      ],
    });
    const database = openLocalUnifiedIndex(file, { readOnly: true });
    try {
      const derived = indexReader(database).deriveDay(DAY_ONE);
      assert.equal(derived.excluded.usage, 0);
      const usage = derived.chunks
        .filter((chunk) => chunk.stream === "usage")
        .flatMap((chunk) => chunk.records);
      assert.deepEqual(
        usage.map((record) => [record.modelId, record.provider]),
        [
          ["gpt-5.6-sol", "openai_codex"],
          ["codex-auto-review", "openai_codex"],
          ["gpt-5.3-codex-spark", "openai_codex"],
          ["claude-sonnet-5", "anthropic_claude_code"],
          ["nova-9-preview", "unknown"],
        ],
      );
      // A session spanning two vendors has no single honest provider.
      const sessions = derived.chunks
        .filter((chunk) => chunk.stream === "session")
        .flatMap((chunk) => chunk.records);
      assert.deepEqual(sessions.map((record) => record.provider), ["unknown"]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the same index slice derives byte-identical digests regardless of insertion order", async () => {
  const forward = await withFixtureIndex((reader) => (
    reader.days().map((day) => reader.deriveDay(day))
  ));
  const reversedOrder = await withFixtureIndex((reader) => (
    reader.days().map((day) => reader.deriveDay(day))
  ), { reversed: true });
  assert.equal(forward.length, 2);
  assert.deepEqual(forward.map((day) => day.day), [DAY_ONE, DAY_TWO]);
  assert.deepEqual(
    forward.map((day) => day.dayDigest),
    reversedOrder.map((day) => day.dayDigest),
  );
  assert.deepEqual(
    forward.flatMap((day) => day.chunks.map(
      (chunk) => [chunk.chunkId, chunk.chunkDigest],
    )),
    reversedOrder.flatMap((day) => day.chunks.map(
      (chunk) => [chunk.chunkId, chunk.chunkDigest],
    )),
  );
  // A second derivation over the same open index is also identical.
  const again = await withFixtureIndex((reader) => {
    const first = reader.days().map((day) => reader.deriveDay(day));
    const second = reader.days().map((day) => reader.deriveDay(day));
    assert.deepEqual(
      first.map((day) => day.dayDigest),
      second.map((day) => day.dayDigest),
    );
    return first;
  });
  assert.deepEqual(
    again.map((day) => day.dayDigest),
    forward.map((day) => day.dayDigest),
  );
});

test("derived records satisfy the worker's closed v1.0 schemas and carry the raw session uuid", async () => {
  await withFixtureIndex((reader) => {
    const dayOne = reader.deriveDay(DAY_ONE);
    assert.deepEqual(
      dayOne.chunks.map((chunk) => chunk.chunkId),
      [
        `quota:${DAY_ONE}:0`,
        `session:${DAY_ONE}:0`,
        `usage:${DAY_ONE}:0`,
      ],
    );
    const usage = dayOne.chunks.find((chunk) => chunk.stream === "usage");
    assert.equal(usage.recordCount, 3);
    const [first, , third] = usage.records;
    assert.deepEqual(Object.keys(first).sort(), [
      "agentScope", "apiServiceTier", "billingSurface", "components",
      "eventId", "eventTime", "modelId", "outcome", "provider",
      "reasoningEffort", "schemaVersion", "sessionUuid", "speedMode",
      "surface", "totalInputContextTokens",
    ]);
    assert.equal(first.schemaVersion, "usage-event-v1.0");
    assert.equal(first.provider, "openai_codex");
    assert.equal(first.modelId, "gpt-5.6-sol");
    assert.equal(first.eventTime, new Date(dayMs(DAY_ONE, 1_000)).toISOString());
    assert.match(first.eventId, /^[0-9a-f]{64}$/u);
    // Session A has a recorded raw identity: the raw uuid travels.
    assert.equal(first.sessionUuid, SESSION_A_UUID);
    // Session B never had a UUID-shaped id: the stable hex of the local join
    // key stands in — content-free, never the filename-shaped fallback.
    assert.equal(third.sessionUuid, SESSION_B_LOCAL.toString("hex"));
    assert.deepEqual(first.components, {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 200,
      inputCacheWriteTokens: null,
      outputTextTokens: 5,
      outputReasoningTokens: 2,
      outputCombinedTokens: null,
    });

    const quota = dayOne.chunks.find((chunk) => chunk.stream === "quota");
    assert.equal(quota.recordCount, 1);
    assert.equal(dayOne.excluded.quota, 1);
    assert.deepEqual(quota.records[0], {
      schemaVersion: "quota-observation-v1.0",
      observationId: `q:${dayMs(DAY_ONE, 1_500)}:codex:primary`,
      observedTime: new Date(dayMs(DAY_ONE, 1_500)).toISOString(),
      provider: "openai_codex",
      planType: "plus",
      planVariant: "unknown",
      limitId: "codex",
      slot: "primary",
      usedPercent: 41.5,
      windowDurationMinutes: 300,
      resetsAt: new Date(dayMs(DAY_TWO, 0)).toISOString(),
    });

    // Only session A has tool-class counts, so only session A has a
    // dimension record; its first event pins the chunk day.
    const session = dayOne.chunks.find((chunk) => chunk.stream === "session");
    assert.equal(session.recordCount, 1);
    assert.deepEqual(session.records[0], {
      schemaVersion: "session-dimension-v1.0",
      sessionUuid: SESSION_A_UUID,
      firstEventTime: new Date(dayMs(DAY_ONE, 1_000)).toISOString(),
      provider: "openai_codex",
      toolClassCounts: { localShell: 3, webSearch: 1 },
    });

    // DAY_TWO carries only the one usage event: session A's dimension lives
    // on its first-event day, not on every day it appears.
    const dayTwo = reader.deriveDay(DAY_TWO);
    assert.deepEqual(
      dayTwo.chunks.map((chunk) => chunk.stream),
      ["usage"],
    );
  });
});

test("a changed day changes that day's digest and only that day's", async () => {
  const before = await withFixtureIndex((reader) => (
    reader.days().map((day) => reader.deriveDay(day))
  ));
  const after = await withFixtureIndex((reader) => (
    reader.days().map((day) => reader.deriveDay(day))
  ), {
    mutate: async (file) => {
      const database = openLocalUnifiedIndex(file, { readOnly: false });
      const writer = createUnifiedIndexWriter(database, {
        contractVersion: "telemetry-contribution-v0.1",
      });
      const accountScopeId = writer.internAccountScope({
        status: "unavailable",
        reason: "missing_account",
        planType: null,
        scopeLocal: null,
      });
      writer.writeUsageEvent({
        eventKey: eventKey(99),
        observedAtMs: dayMs(DAY_TWO, 9_000),
        sessionLocal: SESSION_A_LOCAL,
        accountScopeId,
        modelId: writer.internModel("gpt-5.6-sol", "recognized"),
        tierId: writer.internTier({
          apiServiceTier: "unknown",
          billingSurface: "chatgpt_subscription",
          codexSpeedMode: "standard",
          tierSource: "rollout_thread_settings",
          providerTierRaw: "default",
        }),
        surfaceId: writer.internSurface({
          agentScope: "root",
          surface: "extension_or_ide",
          threadSource: "rollout",
          lineageDisposition: "standalone",
        }),
        quotaObservationId: null,
        reasoningEffort: reasoningEffortOrdinal("medium"),
        outcome: outcomeOrdinal("unknown"),
        tokensInUncached: 7,
        tokensInCacheRead: null,
        tokensInCacheWrite: null,
        tokensInCacheWrite5m: null,
        tokensInCacheWrite1h: null,
        tokensOutText: 1,
        tokensOutReasoning: null,
        tokensOutCombined: null,
        totalInputContext: null,
      });
      await writer.close({ integrityCheck: true, fsyncPath: null });
    },
  });
  assert.equal(before[0].dayDigest, after[0].dayDigest);
  assert.notEqual(before[1].dayDigest, after[1].dayDigest);
  assert.notEqual(
    telemetryV1HistoryDigest(before),
    telemetryV1HistoryDigest(after),
  );
});

test("an over-full day splits into deterministic 200-record segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "telemetry-v1-split-"));
  const file = join(root, "index.sqlite");
  try {
    const events = Array.from({ length: 250 }, (_, index) => ({
      eventKey: eventKey(index + 1),
      observedAtMs: dayMs(DAY_ONE, 1_000 + index),
      sessionLocal: SESSION_A_LOCAL,
    }));
    await buildIndex(file, { events });
    const database = openLocalUnifiedIndex(file, { readOnly: true });
    try {
      const reader = indexReader(database);
      const derived = reader.deriveDay(DAY_ONE);
      const usageChunks = derived.chunks.filter(
        (chunk) => chunk.stream === "usage",
      );
      assert.deepEqual(
        usageChunks.map((chunk) => [chunk.chunkId, chunk.recordCount]),
        [
          [`usage:${DAY_ONE}:0`, MAX_TELEMETRY_V1_CHUNK_RECORDS],
          [`usage:${DAY_ONE}:1`, 50],
        ],
      );
      // The split boundary is positional over the total order: record 200
      // opens the second segment.
      assert.equal(
        usageChunks[1].records[0].eventTime,
        new Date(dayMs(DAY_ONE, 1_200)).toISOString(),
      );
      assert.equal(
        derived.dayDigest,
        telemetryV1DayDigest(usageChunks),
      );
      for (const chunk of usageChunks) {
        assert.equal(chunk.chunkDigest, telemetryV1ChunkDigest(chunk.records));
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the manifest diff uploads exactly the new and changed chunks, oldest day first", () => {
  const localDays = [
    {
      day: DAY_TWO,
      dayDigest: "b".repeat(64),
      chunks: [
        { stream: "usage", chunkSeq: 0, chunkId: `usage:${DAY_TWO}:0`, chunkDigest: "2".repeat(64), recordCount: 4 },
      ],
    },
    {
      day: DAY_ONE,
      dayDigest: "a".repeat(64),
      chunks: [
        { stream: "quota", chunkSeq: 0, chunkId: `quota:${DAY_ONE}:0`, chunkDigest: "0".repeat(64), recordCount: 2 },
        { stream: "usage", chunkSeq: 0, chunkId: `usage:${DAY_ONE}:0`, chunkDigest: "1".repeat(64), recordCount: 3 },
      ],
    },
  ];
  const plan = planTelemetryV1Upload({
    localDays,
    manifestDays: [{
      day: DAY_ONE,
      dayDigest: "c".repeat(64),
      chunks: [
        // Unchanged content: never re-sent.
        { chunkId: `quota:${DAY_ONE}:0`, revision: 1, chunkDigest: "0".repeat(64), recordCount: 2 },
        // Changed content: supersedes at revision + 1.
        { chunkId: `usage:${DAY_ONE}:0`, revision: 2, chunkDigest: "9".repeat(64), recordCount: 3 },
        // No local counterpart: reported, cannot be superseded from here.
        { chunkId: `usage:${DAY_ONE}:1`, revision: 1, chunkDigest: "8".repeat(64), recordCount: 1 },
      ],
    }],
  });
  assert.deepEqual(plan.uploads.map((upload) => [upload.chunkId, upload.revision]), [
    [`usage:${DAY_ONE}:0`, 3],
    [`usage:${DAY_TWO}:0`, 1],
  ]);
  assert.equal(plan.skippedChunks, 1);
  assert.deepEqual(plan.orphanChunkIds, [`usage:${DAY_ONE}:1`]);

  // A day whose digest already matches is pruned without touching chunks.
  const pruned = planTelemetryV1Upload({
    localDays: [localDays[1]],
    manifestDays: [{
      day: DAY_ONE,
      dayDigest: "a".repeat(64),
      chunks: [],
    }],
  });
  assert.equal(pruned.uploads.length, 0);
  assert.equal(pruned.skippedChunks, 2);
});

test("the chunk plaintext fails closed on digest drift and on forbidden scope identifiers", async () => {
  const consent = telemetryV1RequiredConsent();
  const records = [{
    schemaVersion: "quota-observation-v1.0",
    observationId: "q:1:codex:primary",
    observedTime: `${DAY_ONE}T00:00:01.000Z`,
    provider: "openai_codex",
    planType: "plus",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 10,
    windowDurationMinutes: 300,
    resetsAt: `${DAY_TWO}T00:00:00.000Z`,
  }];
  const chunk = {
    stream: "quota",
    chunkDay: DAY_ONE,
    chunkSeq: 0,
    chunkId: `quota:${DAY_ONE}:0`,
    chunkDigest: telemetryV1ChunkDigest(records),
    parserVersion: "unified-rollout-typed-v1",
    recordCount: 1,
    records,
  };
  const plaintext = buildTelemetryV1ChunkPlaintext({
    chunk,
    revision: 1,
    consent,
  });
  assert.equal(plaintext.schemaVersion, TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION);
  assert.equal(plaintext.chunkRevision, 1);
  assert.deepEqual(plaintext.consent, consent);

  assert.throws(
    () => buildTelemetryV1ChunkPlaintext({
      chunk: { ...chunk, chunkDigest: "f".repeat(64) },
      revision: 1,
      consent,
    }),
    (error) => error instanceof TelemetryV1ChunkError
      && error.code === "telemetry_v1_chunk_invalid",
  );

  const leakyRecords = [{
    ...records[0],
    sessionScopeId: "session:v1:leak",
  }];
  assert.throws(
    () => buildTelemetryV1ChunkPlaintext({
      chunk: {
        ...chunk,
        records: leakyRecords,
        chunkDigest: telemetryV1ChunkDigest(leakyRecords),
      },
      revision: 1,
      consent,
    }),
    (error) => error.code === "telemetry_v1_chunk_invalid",
  );
});

test("the v1.0 envelope reuses the v0.1 cryptography under the new schema version", async () => {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const chunk = {
    schemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    chunkId: `usage:${DAY_ONE}:0`,
    chunkRevision: 1,
    chunkDigest: "a".repeat(64),
    parserVersion: "unified-rollout-typed-v1",
    consent: telemetryV1RequiredConsent(),
    records: [],
  };
  const envelope = await createTelemetryV1Envelope({
    chunk,
    publicJwk,
    keyId: "key:test",
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, false);
  // RSA-2048 OAEP wrap: exactly the 342 base64url characters the worker's
  // envelope validator requires.
  assert.equal(envelope.wrappedKey.length, 342);
  const rawKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    keyPair.privateKey,
    Buffer.from(envelope.wrappedKey, "base64url"),
  );
  const payloadKey = await webcrypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const decrypted = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") },
    payloadKey,
    Buffer.from(envelope.ciphertext, "base64url"),
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(decrypted).toString("utf8")),
    JSON.parse(JSON.stringify(chunk)),
  );
});

test("canonical serialization sorts keys exactly as the worker digests them", () => {
  assert.equal(
    telemetryV1CanonicalJson([{ b: 1, a: { d: null, c: [2, 1] } }]),
    "[{\"a\":{\"c\":[2,1],\"d\":null},\"b\":1}]",
  );
});
