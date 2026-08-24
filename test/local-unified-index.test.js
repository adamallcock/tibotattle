import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCacheImpacts } from "../src/cache-switch-impact.js";
import { readLocalUnifiedCompanionProjection } from "../src/local-unified-companion-source.js";
import { createLocalUnifiedAccountingSource } from "../src/local-unified-accounting-source.js";

import {
  balanceComponents,
  lineageComponents,
  modelDeclaration,
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  extractRolloutUsage,
  parseCompactionPrefix,
  salvagePartialTokenCount,
} from "../src/local-unified-index-extract.js";
import {
  classifySource,
  ingestLocalUnifiedIndexIncrement,
} from "../src/local-unified-index-ingest.js";
import {
  createLocalUnifiedIndexSecondaryIndexes,
  createUnifiedIndexWriter,
  beginUnifiedIndexGeneration,
  inspectLocalUnifiedIndex,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  localDigest,
  openLocalUnifiedIndex,
  OUTCOMES,
  outcomeOrdinal,
  readUnifiedIndexAggregate,
  readUnifiedIndexGenerationDescriptor,
  REASONING_EFFORTS,
  reasoningEffortOrdinal,
  sessionLocal,
} from "../src/local-unified-index.js";
import { readLocalUnifiedWindowBreakdown } from "../src/local-unified-window-breakdown.js";

const CONTRACT = "usage-event-v0.2";
const THREAD_ONE = "11111111-1111-4111-8111-111111111111";
const THREAD_TWO = "22222222-2222-4222-8222-222222222222";
const ROLLOUT_TWO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_THREE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function canonicalRolloutName(timestamp, threadId, rolloutId = null) {
  return `rollout-${timestamp}-${threadId}${rolloutId === null ? "" : `_${rolloutId}`}.jsonl`;
}

function paginatedSessionMeta(sessionId, {
  ordinal,
  baseRolloutId,
  endOrdinalExclusive,
  endByteOffset,
  parentId = null,
} = {}) {
  return JSON.stringify({
    ordinal,
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      history_mode: "paginated",
      history_base: {
        thread_id: baseRolloutId,
        end_ordinal_exclusive: endOrdinalExclusive,
        end_byte_offset: endByteOffset,
      },
      ...(parentId === null ? {} : {
        forked_from_id: parentId,
        parent_thread_id: parentId,
      }),
      thread_source: "user",
      originator: "codex_cli_rs",
    },
  });
}

function jsonlBytes(lines) {
  return Buffer.byteLength(`${lines.join("\n")}\n`);
}

function sessionMeta(sessionId, { parentId = null, threadSource = "user" } = {}) {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      ...(parentId === null ? {} : { forked_from_id: parentId, parent_thread_id: parentId }),
      thread_source: threadSource,
      originator: "codex_cli_rs",
      cwd: "/Users/nobody/project",
    },
  });
}

function turnContext(timestamp, model, effort = "high") {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: "turn-1",
      cwd: "/Users/nobody/project",
      model,
      effort,
      summary: "auto",
      collaboration_mode: {
        mode: "default",
        settings: { developer_instructions: "SECRET INSTRUCTIONS DO NOT INDEX" },
      },
    },
  });
}

function threadSettings(timestamp, serviceTier) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { service_tier: serviceTier, reasoning_effort: "medium" },
    },
  });
}

function toolCall(timestamp, payload) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload,
  });
}

function tokenCount(timestamp, total, last, { usedPercent = null } = {}) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
      ...(usedPercent === null ? {} : {
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: usedPercent,
            window_minutes: 10_080,
            resets_at: 1_785_258_363,
          },
        },
      }),
    },
  });
}

function tokenCountTotalOnly(timestamp, total) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total } },
  });
}

function compacted(timestamp, paddingBytes = 0) {
  return JSON.stringify({
    timestamp,
    type: "compacted",
    payload: {
      message: "SECRET COMPACTION SUMMARY DO NOT INDEX",
      replacement_history: [{
        role: "user",
        content: "SECRET REPLACEMENT HISTORY DO NOT INDEX",
      }],
      padding: "p".repeat(paddingBytes),
    },
  });
}

function usage(input, output = 0, cached = 0, write = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function corpus(files) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(join(sessions, name), `${lines.join("\n")}\n`);
  }
  return { root, sessions };
}

async function build(root, extra = {}) {
  return rebuildLocalUnifiedIndex({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
    ...extra,
  });
}

const SECONDARY_INDEX_NAMES = [
  "usage_event_observed",
  "usage_event_session",
  "usage_event_boundary_session",
  "usage_event_replay_order",
  "quota_occurrence_canonical",
  "quota_occurrence_replay_order",
  "tool_class_fact_generation",
  "tool_class_fact_source",
];

function secondaryIndexNames(database) {
  const placeholders = SECONDARY_INDEX_NAMES.map(() => "?").join(", ");
  return database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'index' AND name IN (${placeholders}) ORDER BY name`,
  ).all(...SECONDARY_INDEX_NAMES).map((row) => row.name);
}

function logicalProjection(database) {
  return {
    usage: database.prepare(`
      SELECT hex(u.event_key) AS event_key, u.observed_at_ms,
             m.model_id, t.billing_surface, t.codex_speed_mode,
             t.api_service_tier, t.tier_source,
             s.surface, s.thread_source, s.agent_scope,
             s.lineage_disposition,
             u.tokens_in_uncached, u.tokens_in_cache_read,
             u.tokens_in_cache_write, u.tokens_in_cache_write_5m,
             u.tokens_in_cache_write_1h, u.tokens_out_text,
             u.tokens_out_reasoning, u.tokens_out_combined,
             u.total_input_context, hex(u.source_local) AS source_local,
             u.source_offset, u.source_ordinal, u.tier_observed_at_ms
      FROM usage_event u
      JOIN model m ON m.id = u.model_id
      JOIN tier_semantics t ON t.id = u.tier_id
      JOIN surface_class s ON s.id = u.surface_id
      ORDER BY u.observed_at_ms, u.source_ordinal, u.source_local,
               u.source_offset, u.event_key`).all(),
    quotaObservations: database.prepare(`
      SELECT observed_at_ms, limit_id, slot, plan_type, used_percent,
             resets_at_ms, duration_mins
      FROM quota_observation
      ORDER BY observed_at_ms, limit_id, slot`).all(),
    quotaOccurrences: database.prepare(`
      SELECT hex(q.source_local) AS source_local, q.source_offset,
             q.source_ordinal, q.observed_at_ms, q.provider, q.plan_type,
             q.limit_id, q.slot, q.slot_order, q.used_percent,
             q.resets_at_ms, q.duration_mins, q.admission,
             s.surface, s.thread_source, s.agent_scope,
             s.lineage_disposition
      FROM quota_occurrence q
      JOIN surface_class s ON s.id = q.surface_id
      ORDER BY q.observed_at_ms, q.source_ordinal, q.source_local,
               q.source_offset, q.slot_order`).all(),
  };
}

test("the enum ordinals match the telemetry contract's fixed member lists", () => {
  assert.equal(REASONING_EFFORTS.length, 9);
  assert.equal(OUTCOMES.length, 6);
  assert.equal(reasoningEffortOrdinal("xhigh"), 5);
  assert.equal(reasoningEffortOrdinal("not-a-member"), REASONING_EFFORTS.length - 1);
  assert.equal(outcomeOrdinal("cancelled"), 2);
  assert.equal(outcomeOrdinal("not-a-member"), OUTCOMES.length - 1);
});

test("a model declaration separates recognized, unrecognized and never-observed", () => {
  assert.deepEqual(modelDeclaration("gpt-5.6-sol"), {
    modelId: "gpt-5.6-sol",
    recognition: "recognized",
  });
  assert.deepEqual(modelDeclaration("some-unreviewed-model"), {
    modelId: "unknown",
    recognition: "unrecognized",
  });
  // The old collector collapsed the last two into the same "unknown" string,
  // which is how a 309,946-record data gap stayed invisible.
  assert.deepEqual(modelDeclaration(null), {
    modelId: "unknown",
    recognition: "missing",
  });
});

test("sparse turn configuration means unchanged rather than missing", async () => {
  const sparseTurnContext = JSON.stringify({
    timestamp: "2026-07-25T00:00:02.000Z",
    type: "turn_context",
    payload: {
      turn_id: "turn-2",
      cwd: "/Users/nobody/project",
      // Model and effort are intentionally absent: this is a state delta, not
      // evidence that either applied value became unknown.
    },
  });
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-sparse.jsonl": [
      sessionMeta("session-sparse"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol", "high"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(100, 0, 80),
        usage(100, 0, 80),
      ),
      sparseTurnContext,
      tokenCount(
        "2026-07-25T00:00:03.000Z",
        usage(300, 0, 150),
        usage(200, 0, 70),
      ),
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = database.prepare(`
        SELECT m.model_id AS model, m.recognition AS recognition,
               u.reasoning_effort AS effort
        FROM usage_event u
        JOIN model m ON m.id = u.model_id
        ORDER BY u.observed_at_ms`).all();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.model), [
        "gpt-5.6-sol",
        "gpt-5.6-sol",
      ]);
      assert.deepEqual(rows.map((row) => row.recognition), [
        "recognized",
        "recognized",
      ]);
      assert.deepEqual(rows.map((row) => row.effort), [
        reasoningEffortOrdinal("high"),
        reasoningEffortOrdinal("high"),
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("session_local is a stable irreversible digest and is domain separated from scope_local", () => {
  const salt = Buffer.alloc(32, 7);
  const session = sessionLocal(salt, "019f978f-51a4-7ae3");
  assert.equal(session.length, 32);
  assert.deepEqual(session, sessionLocal(salt, "019f978f-51a4-7ae3"));
  assert.notDeepEqual(session, sessionLocal(Buffer.alloc(32, 8), "019f978f-51a4-7ae3"));
  assert.notDeepEqual(
    session,
    localDigest(salt, "unified-index-scope", "019f978f-51a4-7ae3"),
  );
  assert.ok(!session.toString("hex").includes("019f978f"));
});

test("a rebuild indexes typed usage events and never stores content", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:01.000Z", "priority"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(100, 10), usage(100, 10), { usedPercent: 12 }),
      tokenCount("2026-07-25T00:00:03.000Z", usage(300, 40), usage(200, 30)),
    ],
  });
  try {
    const result = await build(root);
    assert.equal(result.status, "built");
    assert.equal(result.sources, 1);
    assert.equal(result.usageEvents, 2);
    assert.equal(result.modelMissing, 0);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT u.observed_at_ms AS ms, m.model_id AS model, m.recognition AS recognition,
               t.codex_speed_mode AS speed, t.provider_tier_raw AS raw,
               u.reasoning_effort AS effort, u.outcome AS outcome,
               u.tokens_in_uncached AS iu, u.tokens_in_cache_read AS icr,
               u.tokens_out_text AS ot, u.tokens_out_reasoning AS orz,
               u.total_input_context AS tic,
               u.tokens_in_cache_write_5m AS w5, u.tokens_out_combined AS oc,
               u.quota_observation_id AS quota
        FROM usage_event u
        JOIN model m ON m.id = u.model_id
        JOIN tier_semantics t ON t.id = u.tier_id
        ORDER BY u.observed_at_ms`).all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].model, "gpt-5.6-sol");
      assert.equal(rows[0].recognition, "recognized");
      assert.equal(rows[0].speed, "fast");
      assert.equal(rows[0].raw, "priority");
      assert.equal(rows[0].effort, reasoningEffortOrdinal("high"));
      assert.equal(rows[0].outcome, outcomeOrdinal("unknown"));
      assert.equal(rows[0].iu, 100);
      assert.equal(rows[0].ot, 10);
      assert.notEqual(rows[0].quota, null);
      // Codex reports neither a provider total input context, nor a
      // cache-write TTL split, nor a combined output figure. NULL must stay
      // distinguishable from an observed zero.
      assert.equal(rows[0].tic, null);
      assert.equal(rows[0].w5, null);
      assert.equal(rows[0].oc, null);
      assert.equal(rows[1].quota, null);
      assert.equal(rows[1].iu, 200);

      // There is no column in this schema that can hold rollout text, and the
      // developer instructions present in every turn_context must not appear.
      const dump = [
        ...database.prepare("SELECT * FROM model").all(),
        ...database.prepare("SELECT * FROM tier_semantics").all(),
        ...database.prepare("SELECT * FROM surface_class").all(),
        ...database.prepare("SELECT * FROM account_scope").all(),
        ...database.prepare("SELECT * FROM meta").all(),
      ].map((row) => JSON.stringify(row)).join("\n");
      assert.ok(!dump.includes("SECRET INSTRUCTIONS"));
      assert.ok(!dump.includes("/Users/nobody"));
      assert.ok(!dump.includes("session-a"));
      assert.ok(!dump.includes("turn-1"));
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("deferred secondary indexes preserve logical facts and are present before publication", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-deferred.jsonl": [
      sessionMeta("session-deferred"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:01.000Z", "priority"),
      tokenCount(
        "2026-07-25T00:00:02.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
      tokenCount(
        "2026-07-25T00:00:03.000Z",
        usage(300, 40),
        usage(200, 30),
      ),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const readProjection = () => {
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      return {
        aggregate: readUnifiedIndexAggregate(database),
        logical: logicalProjection(database),
        secondaryIndexes: secondaryIndexNames(database),
      };
    } finally {
      database.close();
    }
  };
  try {
    await build(root, { deferSecondaryIndexes: false });
    const online = readProjection();
    assert.deepEqual(online.secondaryIndexes, [...SECONDARY_INDEX_NAMES].sort());

    const deferred = await build(root, { deferSecondaryIndexes: true });
    assert.equal(deferred.generation.status, "complete");
    const rebuilt = readProjection();
    assert.deepEqual(rebuilt.secondaryIndexes, [...SECONDARY_INDEX_NAMES].sort());
    assert.deepEqual(rebuilt.aggregate, online.aggregate);
    assert.deepEqual(rebuilt.logical, online.logical);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("quota coverage proof is planned through its canonical-occurrence index", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-proof-index.jsonl": [
      sessionMeta("session-proof-index"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root, { deferSecondaryIndexes: true });
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) AS count FROM quota_observation q
        WHERE NOT EXISTS (
          SELECT 1 FROM quota_occurrence o
          WHERE o.canonical_observation_id = q.id)
      `).all();
      assert.ok(
        plan.some((row) => String(row.detail).includes(
          "quota_occurrence_canonical",
        )),
        () => `quota proof plan did not use canonical index: ${JSON.stringify(plan)}`,
      );
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS count FROM quota_observation q
          WHERE NOT EXISTS (
            SELECT 1 FROM quota_occurrence o
            WHERE o.canonical_observation_id = q.id)
        `).get().count),
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("existing incremental indexes repair the quota proof index while read-only validation rejects its absence", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-proof-migration.jsonl": [
      sessionMeta("session-proof-migration"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    const writable = openLocalUnifiedIndex(indexFile, { readOnly: false });
    writable.exec("DROP INDEX quota_occurrence_canonical");
    writable.close();

    assert.throws(
      () => openLocalUnifiedIndex(indexFile, { readOnly: true }),
      (error) => error?.code === "local_unified_index_secondary_indexes_missing",
    );

    const result = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(result.status, "ingested");
    assert.equal(result.insertedUsageEvents, 0);
    assert.equal(result.totalUsageEvents, 1);

    const repaired = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.deepEqual(
        secondaryIndexNames(repaired),
        [...SECONDARY_INDEX_NAMES].sort(),
      );
    } finally {
      repaired.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("deferred secondary-index failure rolls back the stage and cannot target an existing index", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-deferred-failure.jsonl": [
      sessionMeta("session-deferred-failure"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const stageFile = join(root, "blocked-stage.sqlite");
  try {
    await build(root, { deferSecondaryIndexes: false });
    const before = await stat(indexFile);
    const beforeProjection = (() => {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      try {
        return logicalProjection(database);
      } finally {
        database.close();
      }
    })();

    const staging = openLocalUnifiedIndex(stageFile, {
      readOnly: false,
      create: true,
      staging: true,
      deferSecondaryIndexes: true,
    });
    try {
      assert.deepEqual(secondaryIndexNames(staging), []);
      // The first index can be created, but the second is deliberately blocked
      // by a table with the same name. The helper's transaction must roll the
      // first one back rather than leaving a partially indexed stage.
      staging.exec("CREATE TABLE usage_event_session(blocked INTEGER)");
      assert.throws(
        () => createLocalUnifiedIndexSecondaryIndexes(staging),
        (error) => error?.code === "local_unified_index_secondary_indexes_failed",
      );
      assert.deepEqual(secondaryIndexNames(staging), []);
    } finally {
      staging.close();
    }

    assert.throws(
      () => openLocalUnifiedIndex(indexFile, {
        readOnly: false,
        create: true,
        staging: true,
        deferSecondaryIndexes: true,
      }),
      (error) => error?.code
        === "local_unified_index_deferred_indexes_requires_new_stage",
    );
    const after = await stat(indexFile);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.deepEqual(logicalProjection(database), beforeProjection);
      assert.deepEqual(secondaryIndexNames(database), [...SECONDARY_INDEX_NAMES].sort());
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a published generation attests provenance, source order and quota occurrences", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-attested.jsonl": [
      sessionMeta("session-attested"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:01.000Z", "priority"),
      tokenCount(
        "2026-07-25T00:00:02.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
    ],
  });
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "complete");
    assert.equal(built.generation.usageProvenanceComplete, true);
    assert.equal(built.generation.sourceOrderComplete, true);
    assert.equal(built.generation.quotaProvenanceComplete, true);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const generation = database.prepare(`
        SELECT status, usage_events, quota_occurrences,
               usage_provenance_complete, source_order_complete,
               quota_provenance_complete
        FROM index_generation
        WHERE id = (SELECT CAST(value AS INTEGER)
                    FROM meta WHERE key = 'current_generation_id')
      `).get();
      assert.equal(generation.status, "complete");
      assert.equal(generation.usage_events, 1);
      assert.equal(generation.quota_occurrences, 1);
      assert.equal(generation.usage_provenance_complete, 1);
      assert.equal(generation.source_order_complete, 1);
      assert.equal(generation.quota_provenance_complete, 1);

      const usageRow = database.prepare(`
        SELECT length(source_local) AS source_bytes, source_offset,
               source_ordinal, tier_observed_at_ms
        FROM usage_event
      `).get();
      assert.equal(usageRow.source_bytes, 32);
      assert.ok(Number.isSafeInteger(usageRow.source_offset));
      assert.equal(usageRow.source_ordinal, 0);
      assert.ok(Number.isSafeInteger(usageRow.tier_observed_at_ms));

      const quota = database.prepare(`
        SELECT length(source_local) AS source_bytes, source_offset,
               source_ordinal, slot_order, admission, resets_at_ms
        FROM quota_occurrence
      `).get();
      assert.equal(quota.source_bytes, 32);
      assert.ok(Number.isSafeInteger(quota.source_offset));
      assert.equal(quota.source_ordinal, 0);
      assert.equal(quota.slot_order, 0);
      assert.equal(quota.admission, "admitted");
      assert.ok(Number.isSafeInteger(quota.resets_at_ms));

      const source = database.prepare(`
        SELECT source_ordinal, status, diagnostics_complete
        FROM generation_source
      `).get();
      assert.equal(source.source_ordinal, 0);
      assert.equal(source.status, "complete");
      assert.equal(source.diagnostics_complete, 1);

      const descriptor = readUnifiedIndexGenerationDescriptor(database);
      assert.equal(descriptor.fingerprint, built.generation.fingerprint);
      assert.equal(descriptor.usageProvenanceComplete, true);
      assert.equal(descriptor.sourceOrderComplete, true);
      assert.equal(descriptor.quotaProvenanceComplete, true);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("generation finalization rejects a cursor with missing source ordinal", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-cursor-order.jsonl": [
      sessionMeta("session-cursor-order"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
    const source = database.prepare(`
      SELECT source_local, source_ordinal, session_local, surface_id,
             discovered_size_bytes, scanned_bytes, mtime_ms, diagnostics_complete
      FROM generation_source
      WHERE generation_id = (SELECT CAST(value AS INTEGER) FROM meta
                             WHERE key = 'current_generation_id')`).get();
    database.prepare("UPDATE source_cursor SET source_ordinal = NULL").run();
    const generation = beginUnifiedIndexGeneration(database, {
      contractVersion: CONTRACT,
    });
    const writer = createUnifiedIndexWriter(database, {
      contractVersion: CONTRACT,
      generationId: generation.generationId,
      parserVersionId: generation.parserVersionId,
      ingestRunId: generation.ingestRunId,
    });
    writer.writeGenerationSource({
      sourceLocal: Buffer.from(source.source_local),
      sourceOrdinal: Number(source.source_ordinal),
      sessionLocal: Buffer.from(source.session_local),
      surfaceId: Number(source.surface_id),
      status: "complete",
      discoveredSizeBytes: Number(source.discovered_size_bytes),
      scannedBytes: Number(source.scanned_bytes),
      mtimeMs: Number(source.mtime_ms),
      diagnosticsComplete: Number(source.diagnostics_complete) === 1,
    });
    writer.finalizeGeneration({
      status: "complete",
      discoveryComplete: true,
      diagnosticsComplete: true,
    });
    await writer.close({ integrityCheck: true, fsyncPath: null });
    const published = openLocalUnifiedIndex(indexFile, { readOnly: true });
    // The staged test generation is not published over the path, but its
    // descriptor is durable in this connection before close; the source-order
    // proof itself is asserted by the generation row below.
    try {
      const row = published.prepare(`
        SELECT source_order_complete, status, block_reason
        FROM index_generation WHERE id = ?`).get(generation.generationId);
      assert.equal(row.source_order_complete, 0);
      assert.equal(row.status, "partial");
      assert.equal(row.block_reason, "source_order_incomplete");
    } finally {
      published.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("held and suppressed quota observations remain represented by a complete generation", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-quota-gate.jsonl": [
      sessionMeta("session-quota-gate"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
      // The quick ten-minute rise is withheld as a contradicted leading
      // snapshot; the later reading is admitted when the source is flushed.
      tokenCount(
        "2026-07-25T00:00:02.000Z",
        usage(200, 20),
        usage(100, 10),
        { usedPercent: 25 },
      ),
    ],
  });
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "complete");
    assert.equal(built.generation.quotaProvenanceComplete, true);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT admission, canonical_observation_id
        FROM quota_occurrence ORDER BY slot_order, id
      `).all();
      assert.ok(rows.some((row) => row.admission === "suppressed"));
      assert.ok(rows.some((row) => row.admission === "admitted"));
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM quota_observation q
          WHERE NOT EXISTS (
            SELECT 1 FROM quota_occurrence o
            WHERE o.canonical_observation_id = q.id)
        `).get().c),
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a forked source contributes only its post-fork turns", async () => {
  // Owner ruling: a fork's replayed parent history is not our spend. Those
  // turns were charged against the allowance in the parent thread; Codex
  // copying them into the child rollout does not make them new. Only turns at
  // or after the fork point count.
  //
  // The parent runs two turns (100 then 300 cumulative). The child replays
  // both, then runs one turn of its own taking the cumulative to 400. The only
  // new spend in the child is that last 100 input / 20 output.
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      // Replayed prefix, byte-identical cumulative snapshots, no turn_context.
      tokenCount("2026-07-25T01:00:00.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T01:00:01.000Z", usage(300, 30), usage(200, 20)),
      turnContext("2026-07-25T01:00:02.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T01:00:03.000Z", usage(400, 50), usage(100, 20)),
    ],
  });
  try {
    const result = await build(root);
    // Two parent turns + one real child turn. Not five.
    assert.equal(result.usageEvents, 3);
    assert.equal(result.forkReplayEventsSkipped, 2);
    assert.equal(result.modelMissing, 0);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT u.observed_at_ms AS ms, m.model_id AS model,
               u.tokens_in_uncached AS iu, u.tokens_out_text AS ot
        FROM usage_event u JOIN model m ON m.id = u.model_id
        ORDER BY u.observed_at_ms`).all();
      assert.deepEqual(rows.map((row) => row.model), [
        "gpt-5.6-terra",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
      ]);
      // The child's own turn is charged as a delta against the replayed
      // baseline. Without the rebase on a suppressed row it would be charged
      // the entire inherited 400 as one turn.
      assert.equal(rows[2].iu, 100);
      assert.equal(rows[2].ot, 20);
      // Total spend equals the parent's real history plus the child's one turn.
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS iu, SUM(tokens_out_text) AS ot
        FROM usage_event`).get();
      assert.equal(Number(totals.iu), 400);
      assert.equal(Number(totals.ot), 50);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a fork whose ancestor rollout has rotated away still suppresses its replay", async () => {
  // Rule 1 cannot fire when the parent is not in the corpus: there is no
  // ancestor snapshot set to match against. Rule 2 — no turn_context of this
  // file's own yet — is what keeps the replayed history out, and it is the
  // rule that covers the whole of a long history whose early rollouts have
  // rotated away.
  const { root } = await corpus({
    "rollout-2026-07-25T01-00-00-orphan.jsonl": [
      sessionMeta("session-child", { parentId: "session-absent", threadSource: "subagent" }),
      tokenCount("2026-07-25T01:00:00.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T01:00:01.000Z", usage(300, 30), usage(200, 20)),
      turnContext("2026-07-25T01:00:02.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T01:00:03.000Z", usage(400, 50), usage(100, 20)),
    ],
  });
  try {
    const result = await build(root);
    assert.equal(result.usageEvents, 1);
    assert.equal(result.forkReplayEventsSkipped, 0);
    assert.equal(result.unattributedForkReplayEventsSkipped, 2);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const row = database.prepare(
        "SELECT tokens_in_uncached AS iu, tokens_out_text AS ot FROM usage_event",
      ).get();
      assert.equal(row.iu, 100);
      assert.equal(row.ot, 20);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a suppressed replay rebases the cumulative baseline", async () => {
  // The post-fork turn reports only a cumulative total — there is no
  // `last_token_usage` to fall back on. If a suppressed replayed row did not
  // move the baseline, this turn would have no baseline to subtract from and
  // would be dropped entirely rather than charged its real 100 tokens. (When
  // `last` is present it masks the bug, which is why this case reports only a
  // total.)
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(300, 30), usage(300, 30)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      tokenCount("2026-07-25T01:00:00.000Z", usage(300, 30), usage(300, 30)),
      turnContext("2026-07-25T01:00:02.000Z", "gpt-5.6-sol"),
      tokenCountTotalOnly("2026-07-25T01:00:03.000Z", usage(400, 50)),
    ],
  });
  try {
    const result = await build(root);
    assert.equal(result.usageEvents, 2);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT m.model_id AS model, u.tokens_in_uncached AS iu, u.tokens_out_text AS ot
        FROM usage_event u JOIN model m ON m.id = u.model_id
        ORDER BY u.observed_at_ms`).all();
      assert.deepEqual(rows.map((row) => row.model), ["gpt-5.6-terra", "gpt-5.6-sol"]);
      assert.equal(rows[1].iu, 100);
      assert.equal(rows[1].ot, 20);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("replay after the fork's own first turn_context is still suppressed", async () => {
  // A fork can replay `turn_context` records too. Once one has been seen, rule
  // 2 stops applying and only the ancestor snapshot set can tell the remaining
  // replayed turns from real ones. This is the case that makes rule 1
  // load-bearing rather than merely corroborating.
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      compacted("2026-07-25T00:00:01.500Z"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      // The replay carries the parent's turn_context with it.
      turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T01:00:01.000Z", usage(100, 10), usage(100, 10)),
      // The inherited compaction marker must be consumed with the suppressed
      // positive replay, not attached to the child's first genuine request.
      compacted("2026-07-25T01:00:01.500Z"),
      tokenCount("2026-07-25T01:00:02.000Z", usage(300, 30), usage(200, 20)),
      // Only this is new spend.
      tokenCount("2026-07-25T01:00:03.000Z", usage(400, 50), usage(100, 20)),
    ],
  });
  try {
    const result = await build(root);
    assert.equal(result.usageEvents, 3);
    assert.equal(result.forkReplayEventsSkipped, 2);
    assert.equal(result.unattributedForkReplayEventsSkipped, 0);
    assert.equal(result.compactionEvents, 2);
    assert.equal(result.boundaryLinks, 2);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(
        "SELECT SUM(tokens_in_uncached) AS iu, SUM(tokens_out_text) AS ot FROM usage_event",
      ).get();
      assert.equal(Number(totals.iu), 400);
      assert.equal(Number(totals.ot), 50);
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM usage_event_boundary
          WHERE compaction_before = 1`).get().c),
        1,
      );
      const child = database.prepare(`
        SELECT b.compaction_before, b.turn_context_before
        FROM usage_event u
        LEFT JOIN usage_event_boundary b ON b.current_event_key = u.event_key
        WHERE u.observed_at_ms = ?`).get(Date.parse("2026-07-25T01:00:03.000Z"));
      assert.equal(child.compaction_before, null);
      assert.equal(child.turn_context_before, null);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a standalone source is never suppressed", async () => {
  // Suppression must key off lineage, not off "an event before a turn_context".
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-solo.jsonl": [
      sessionMeta("session-solo"),
      tokenCount("2026-07-25T00:00:00.000Z", usage(100, 10), usage(100, 10)),
      turnContext("2026-07-25T00:00:01.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
  });
  try {
    const result = await build(root);
    assert.equal(result.usageEvents, 2);
    assert.equal(result.forkReplayEventsSkipped, 0);
    assert.equal(result.unattributedForkReplayEventsSkipped, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a paginated replacement charges old removed work and only its post-boundary delta", async () => {
  const baseLines = [
    sessionMeta(THREAD_ONE),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    // Work later removed from the visible branch remains actual spend.
    tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
  ];
  const retainedPrefix = baseLines.slice(0, 3);
  const replacementLines = [
    paginatedSessionMeta(THREAD_ONE, {
      ordinal: retainedPrefix.length,
      baseRolloutId: THREAD_ONE,
      endOrdinalExclusive: retainedPrefix.length,
      endByteOffset: jsonlBytes(retainedPrefix),
    }),
    turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-sol"),
    // No last_token_usage: the exact history seed is the only way to derive
    // the new 150/15 delta from this cumulative 250/25 counter.
    tokenCountTotalOnly("2026-07-25T01:00:01.000Z", usage(250, 25)),
  ];
  const { root } = await corpus({
    [canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE)]: baseLines,
    [canonicalRolloutName("2026-07-25T01-00-00", THREAD_ONE, ROLLOUT_TWO)]: replacementLines,
  });
  try {
    const single = await build(root);
    assert.equal(single.generation.status, "complete");
    assert.equal(single.usageEvents, 3);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS input,
               SUM(tokens_out_text) AS output,
               COUNT(DISTINCT source_local) AS sources,
               COUNT(DISTINCT session_local) AS sessions
        FROM usage_event`).get();
      assert.equal(Number(totals.input), 450);
      assert.equal(Number(totals.output), 45);
      assert.equal(Number(totals.sources), 2);
      assert.equal(Number(totals.sessions), 1);
    } finally {
      database.close();
    }

    // Exercise the worker implementation separately; its history-base seed
    // resolver must be bit-for-bit equivalent to the in-process reference.
    await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: join(root, "parallel.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      workerCount: 2,
    });
    const reference = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    const parallel = openLocalUnifiedIndex(join(root, "parallel.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(logicalProjection(parallel), logicalProjection(reference));
    } finally {
      reference.close();
      parallel.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a later inline fork inherits only the selected paginated history snapshots", async () => {
  const baseLines = [
    sessionMeta(THREAD_ONE),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    // This paid work is retained in accounting but removed from the visible
    // branch. Its cumulative snapshot must not suppress coincidentally equal
    // new work in a later inline fork.
    tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
  ];
  const retainedPrefix = baseLines.slice(0, 3);
  const replacementLines = [
    paginatedSessionMeta(THREAD_ONE, {
      ordinal: retainedPrefix.length,
      baseRolloutId: THREAD_ONE,
      endOrdinalExclusive: retainedPrefix.length,
      endByteOffset: jsonlBytes(retainedPrefix),
    }),
  ];
  const childLines = [
    sessionMeta(THREAD_TWO, {
      parentId: THREAD_ONE,
      threadSource: "subagent",
    }),
    // Replayed retained prefix, suppressed by the pre-turn-context rule.
    tokenCount("2026-07-25T02:00:00.000Z", usage(100, 10), usage(100, 10)),
    turnContext("2026-07-25T02:00:01.000Z", "gpt-5.6-sol"),
    // This is genuinely new spend but deliberately shares the removed
    // suffix's cumulative/last snapshot. A union of every physical parent
    // generation would wrongly suppress it.
    tokenCount("2026-07-25T02:00:02.000Z", usage(300, 30), usage(200, 20)),
  ];
  const { root } = await corpus({
    [canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE)]: baseLines,
    [canonicalRolloutName(
      "2026-07-25T01-00-00",
      THREAD_ONE,
      ROLLOUT_TWO,
    )]: replacementLines,
    [canonicalRolloutName("2026-07-25T02-00-00", THREAD_TWO)]: childLines,
  });
  try {
    const single = await build(root);
    assert.equal(single.generation.status, "complete");
    assert.equal(single.usageEvents, 3);
    assert.equal(single.forkReplayEventsSkipped, 1);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS input,
               SUM(tokens_out_text) AS output
        FROM usage_event`).get();
      assert.equal(Number(totals.input), 500);
      assert.equal(Number(totals.output), 50);
    } finally {
      database.close();
    }

    const parallel = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: join(root, "parallel-history.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      workerCount: 2,
    });
    assert.equal(parallel.usageEvents, 3);
    const parallelDatabase = openLocalUnifiedIndex(
      join(root, "parallel-history.sqlite"),
      { readOnly: true },
    );
    try {
      const totals = parallelDatabase.prepare(`
        SELECT SUM(tokens_in_uncached) AS input,
               SUM(tokens_out_text) AS output
        FROM usage_event`).get();
      assert.equal(Number(totals.input), 500);
      assert.equal(Number(totals.output), 50);
    } finally {
      parallelDatabase.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a replacement counter reset re-anchors once, charges per-turn usage, and records the regression", async () => {
  const baseLines = [
    sessionMeta(THREAD_ONE),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
  ];
  const replacementLines = [
    paginatedSessionMeta(THREAD_ONE, {
      ordinal: baseLines.length,
      baseRolloutId: THREAD_ONE,
      endOrdinalExclusive: baseLines.length,
      endByteOffset: jsonlBytes(baseLines),
    }),
    turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T01:00:01.000Z", usage(50, 5), usage(50, 5)),
    tokenCount("2026-07-25T01:00:02.000Z", usage(100, 10), usage(50, 5)),
  ];
  const { root } = await corpus({
    [canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE)]: baseLines,
    [canonicalRolloutName("2026-07-25T01-00-00", THREAD_ONE, ROLLOUT_TWO)]: replacementLines,
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS input,
               SUM(tokens_out_text) AS output
        FROM usage_event`).get();
      assert.equal(Number(totals.input), 200);
      assert.equal(Number(totals.output), 20);
      assert.equal(Number(database.prepare(`
        SELECT COALESCE(SUM(count), 0) AS count FROM source_diagnostic
        WHERE code = 'cumulativeCounterRegressions'`).get().count), 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a third physical generation appends incrementally with a recursively resolved history seed", async () => {
  const baseLines = [
    sessionMeta(THREAD_ONE),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
  ];
  const replacementLines = [
    paginatedSessionMeta(THREAD_ONE, {
      ordinal: baseLines.length,
      baseRolloutId: THREAD_ONE,
      endOrdinalExclusive: baseLines.length,
      endByteOffset: jsonlBytes(baseLines),
    }),
    turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-sol"),
    tokenCountTotalOnly("2026-07-25T01:00:01.000Z", usage(150, 15)),
  ];
  const baseName = canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE);
  const replacementName = canonicalRolloutName(
    "2026-07-25T01-00-00",
    THREAD_ONE,
    ROLLOUT_TWO,
  );
  const { root, sessions } = await corpus({
    [baseName]: baseLines,
    [replacementName]: replacementLines,
  });
  const indexFile = join(root, "index.sqlite");
  try {
    const first = await build(root);
    assert.equal(first.usageEvents, 2);
    const thirdLines = [
      paginatedSessionMeta(THREAD_ONE, {
        ordinal: baseLines.length + replacementLines.length,
        baseRolloutId: ROLLOUT_TWO,
        endOrdinalExclusive: baseLines.length + replacementLines.length,
        endByteOffset: jsonlBytes(replacementLines),
      }),
      turnContext("2026-07-25T02:00:00.000Z", "gpt-5.6-sol"),
      tokenCountTotalOnly("2026-07-25T02:00:01.000Z", usage(190, 19)),
    ];
    await writeFile(join(
      sessions,
      canonicalRolloutName("2026-07-25T02-00-00", THREAD_ONE, ROLLOUT_THREE),
    ), `${thirdLines.join("\n")}\n`);

    const advanced = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(advanced.rebuilt, undefined);
    assert.equal(advanced.sourcesRescanned, 1);
    assert.equal(advanced.insertedUsageEvents, 1);
    assert.equal(advanced.totalUsageEvents, 3);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS input,
               SUM(tokens_out_text) AS output,
               COUNT(DISTINCT source_local) AS sources
        FROM usage_event`).get();
      assert.equal(Number(totals.input), 190);
      assert.equal(Number(totals.output), 19);
      assert.equal(Number(totals.sources), 3);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("same-thread rollout events at identical timestamp and byte offset keep distinct event keys", async () => {
  const baseMeta = sessionMeta(THREAD_ONE);
  const baseCutoffBytes = Buffer.byteLength(`${baseMeta}\n`);
  const replacementMeta = paginatedSessionMeta(THREAD_ONE, {
    ordinal: 1,
    baseRolloutId: THREAD_ONE,
    endOrdinalExclusive: 1,
    endByteOffset: baseCutoffBytes,
  });
  const context = turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol");
  const event = tokenCount(
    "2026-07-25T00:00:01.000Z",
    usage(10, 1),
    usage(10, 1),
  );
  const basePrefixBytes = Buffer.byteLength(`${baseMeta}\n${context}\n`);
  const replacementPrefixBytes = Buffer.byteLength(`${replacementMeta}\n${context}\n`);
  assert.ok(replacementPrefixBytes >= basePrefixBytes);
  const paddedContext = `${context}${" ".repeat(replacementPrefixBytes - basePrefixBytes)}`;
  assert.equal(
    Buffer.byteLength(`${baseMeta}\n${paddedContext}\n`),
    replacementPrefixBytes,
  );
  const { root } = await corpus({
    [canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE)]: [
      baseMeta,
      paddedContext,
      event,
    ],
    [canonicalRolloutName("2026-07-25T01-00-00", THREAD_ONE, ROLLOUT_TWO)]: [
      replacementMeta,
      context,
      event,
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT observed_at_ms, source_offset, hex(source_local) AS source_local,
               hex(event_key) AS event_key
        FROM usage_event ORDER BY source_local`).all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].observed_at_ms, rows[1].observed_at_ms);
      assert.equal(rows[0].source_offset, rows[1].source_offset);
      assert.notEqual(rows[0].source_local, rows[1].source_local);
      assert.notEqual(rows[0].event_key, rows[1].event_key);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("one divergent thread publishes an attested partial generation and an unchanged pass terminates", async () => {
  const validLines = [
    sessionMeta(THREAD_TWO),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(25, 2), usage(25, 2)),
  ];
  const divergentA = [sessionMeta(THREAD_ONE)];
  const divergentB = [
    sessionMeta(THREAD_ONE),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
  ];
  const { root } = await corpus({
    [canonicalRolloutName("2026-07-25T00-00-00", THREAD_ONE)]: divergentA,
    [canonicalRolloutName("2026-07-25T00-00-01", THREAD_ONE)]: divergentB,
    [canonicalRolloutName("2026-07-25T00-00-02", THREAD_TWO)]: validLines,
  });
  const indexFile = join(root, "index.sqlite");
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.blockReason, "codex_rollout_sources_quarantined");
    assert.equal(built.generation.discoveredSourceCount, 3);
    assert.equal(built.generation.indexedSourceCount, 1);
    assert.equal(built.generation.skippedSourceCount, 2);
    assert.equal(built.generation.skippedThreadCount, 1);
    assert.deepEqual(built.generation.issueCounts, {
      codex_rollout_generation_ambiguous: {
        threadCount: 1,
        sourceCount: 2,
        sourceBytes: jsonlBytes(divergentA) + jsonlBytes(divergentB),
      },
    });
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.deepEqual(database.prepare(`
        SELECT status, COUNT(*) AS count FROM generation_source
        WHERE generation_id = ? GROUP BY status ORDER BY status
      `).all(built.generation.id).map((row) => ({ ...row })), [
        { status: "complete", count: 1 },
        { status: "failed", count: 2 },
      ]);
      const groups = database.prepare(`
        SELECT code, source_count, source_bytes, length(group_local) AS local_bytes
        FROM generation_issue_group WHERE generation_id = ?
      `).all(built.generation.id).map((row) => ({ ...row }));
      assert.deepEqual(groups, [{
        code: "codex_rollout_generation_ambiguous",
        source_count: 2,
        source_bytes: jsonlBytes(divergentA) + jsonlBytes(divergentB),
        local_bytes: 32,
      }]);
    } finally {
      database.close();
    }

    const rows = [];
    const accountingSource = createLocalUnifiedAccountingSource({
      indexFile,
      requireComplete: true,
      expectedGeneration: built.generation,
      contextBehavior: "legacy_zero",
    });
    const accounting = await accountingSource({
      startAt: "2026-07-25T00:00:00.000Z",
      endAt: "2026-07-26T00:00:00.000Z",
      onUsage: (row) => rows.push(row),
    });
    assert.equal(accounting.coverage.status, "partial");
    assert.equal(accounting.coverage.generationProof, true);
    assert.equal(accounting.coverage.skippedSourceCount, 2);
    assert.equal(accounting.coverage.skippedThreadCount, 1);
    assert.equal(rows.length, 1);

    const unchanged = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.id, built.generation.id);
    assert.equal(unchanged.sourcesScanned, 0);
    assert.equal(unchanged.skippedSourceCount, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the worker rebuild produces the same index as the single-threaded rebuild", async () => {
  const files = {};
  for (let index = 0; index < 6; index += 1) {
    files[`rollout-2026-07-25T0${index}-00-00-s${index}.jsonl`] = [
      sessionMeta(`session-${index}`),
      turnContext(`2026-07-25T0${index}:00:00.000Z`, index % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.5"),
      tokenCount(`2026-07-25T0${index}:00:01.000Z`, usage(100, 10), usage(100, 10), { usedPercent: 5 }),
      compacted(`2026-07-25T0${index}:00:01.500Z`, 2_000),
      tokenCount(`2026-07-25T0${index}:00:02.000Z`, usage(250, 25), usage(150, 15)),
    ];
  }
  const { root } = await corpus(files);
  try {
    const single = await build(root, { workerCount: 1 });
    const singleDatabase = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    const singleAggregate = readUnifiedIndexAggregate(singleDatabase);
    const singleBoundaries = singleDatabase.prepare(`
      SELECT hex(current_event_key) AS event_key, compacted_at_ms,
             compaction_before, turn_context_before,
             hex(session_local) AS session_local
      FROM usage_event_boundary ORDER BY event_key`).all();
    const singleOrder = singleDatabase.prepare(`
      SELECT hex(event.event_key) AS event_key,
             hex(source.source_local) AS source_local, event.source_offset
      FROM usage_event event
      JOIN source_dimension source ON source.id = event.source_id
      ORDER BY event_key`).all();
    singleDatabase.close();

    const parallel = await build(root, { workerCount: 3 });
    const parallelDatabase = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    const parallelAggregate = readUnifiedIndexAggregate(parallelDatabase);
    const parallelBoundaries = parallelDatabase.prepare(`
      SELECT hex(current_event_key) AS event_key, compacted_at_ms,
             compaction_before, turn_context_before,
             hex(session_local) AS session_local
      FROM usage_event_boundary ORDER BY event_key`).all();
    const parallelOrder = parallelDatabase.prepare(`
      SELECT hex(event.event_key) AS event_key,
             hex(source.source_local) AS source_local, event.source_offset
      FROM usage_event event
      JOIN source_dimension source ON source.id = event.source_id
      ORDER BY event_key`).all();
    parallelDatabase.close();

    assert.equal(single.usageEvents, 12);
    assert.equal(parallel.usageEvents, single.usageEvents);
    assert.equal(single.compactionEvents, 6);
    assert.equal(parallel.compactionEvents, single.compactionEvents);
    assert.equal(single.boundaryLinks, 12);
    assert.equal(parallel.boundaryLinks, single.boundaryLinks);
    assert.deepEqual(parallelBoundaries, singleBoundaries);
    assert.equal(singleOrder.length, single.usageEvents);
    assert.deepEqual(parallelOrder, singleOrder);
    assert.deepEqual(parallelAggregate, singleAggregate);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("two rollout files reporting the same quota millisecond resolve deterministically", async () => {
  // Real corpus data: a fork replays the parent's older percentage stamped
  // with the fork's own timestamp, so the same (observed_at_ms, limit_id,
  // slot) genuinely arrives twice with different readings. Under a
  // first-arrival rule that resolved differently in a single-threaded and a
  // worker rebuild — measured at 180 of 1,934,526 rows.
  const shared = "2026-07-25T00:00:02.000Z";
  const files = {};
  for (const [name, percent] of [["aaaa", 14], ["bbbb", 15], ["cccc", 9]]) {
    files[`rollout-2026-07-25T00-00-00-${name}.jsonl`] = [
      sessionMeta(`session-${name}`),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(shared, usage(100, 10), usage(100, 10), { usedPercent: percent }),
    ];
  }
  const { root } = await corpus(files);
  try {
    const observed = [];
    for (const workerCount of [1, 3, 1]) {
      await build(root, { workerCount });
      const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
      try {
        observed.push(database.prepare(`
          SELECT observed_at_ms, limit_id, slot, used_percent, plan_type
          FROM quota_observation ORDER BY observed_at_ms, limit_id, slot`).all());
      } finally {
        database.close();
      }
    }
    assert.equal(observed[0].length, 1, "the three readings share one uniqueness key");
    assert.deepEqual(observed[1], observed[0]);
    assert.deepEqual(observed[2], observed[0]);
    // The tie-break keeps one whole observed tuple, the highest reading.
    assert.equal(observed[0][0].used_percent, 15);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a rerun is idempotent: the same source produces the same event keys", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T00:00:03.000Z", usage(300, 40), usage(200, 30)),
    ],
  });
  try {
    await build(root);
    const first = await inspectLocalUnifiedIndex({ indexFile: join(root, "index.sqlite") });
    await build(root);
    const second = await inspectLocalUnifiedIndex({ indexFile: join(root, "index.sqlite") });
    assert.equal(second.usageEvents, first.usageEvents);
    assert.deepEqual(second.models, first.models);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an oversized token_count is salvaged from its prefix rather than dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-salvage-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { recursive: true });
  // A token_count whose tail is padded past the cap. The six cumulative
  // counters survive in the prefix, so the accounting is exact.
  const padded = JSON.stringify({
    timestamp: "2026-07-25T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(100, 10), last_token_usage: usage(100, 10) },
      padding: "p".repeat(4_000),
    },
  });
  const path = join(sessions, "rollout-2026-07-25T00-00-00-aaaa.jsonl");
  await writeFile(path, `${[
    sessionMeta("session-a"),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    padded,
  ].join("\n")}\n`);
  try {
    const { size } = await stat(path);
    const salvaged = [];
    const run = await extractRolloutUsage(path, {
      size,
      maximumLineBytes: 1_024,
      onEvent: (event) => salvaged.push(event),
    });
    assert.equal(run.diagnostics.partialLines, 1);
    assert.equal(run.diagnostics.salvagedRecords, 1);
    assert.equal(salvaged.length, 1);
    assert.equal(salvaged[0].partial, true);
    assert.equal(salvaged[0].components.inputUncachedTokens, 100);
    assert.equal(salvaged[0].components.outputTextTokens, 10);
    // The model carried forward from turn_context survives the degraded read.
    assert.equal(salvaged[0].model, "gpt-5.6-sol");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a compaction is recognized only from its bounded top-level header", async () => {
  assert.deepEqual(
    parseCompactionPrefix(Buffer.from(compacted("2026-07-25T00:00:01.000Z"))),
    { observedAtMs: Date.parse("2026-07-25T00:00:01.000Z") },
  );
  // JSON object members are unordered. Accept the only other bounded header
  // shape without decoding payload or any free text.
  assert.deepEqual(
    parseCompactionPrefix(Buffer.from(
      '{"type":"compacted","timestamp":"2026-07-25T00:00:02.000Z",'
        + '"payload":{"content":"SECRET"}}',
    )),
    { observedAtMs: Date.parse("2026-07-25T00:00:02.000Z") },
  );
  // A content-bearing record may itself contain an object whose type happens
  // to be `compacted`. Anchoring on the top-level timestamp/type header keeps
  // that nested marker from becoming a false boundary (or making the parser
  // decode the surrounding content record).
  const nested = Buffer.from(JSON.stringify({
    timestamp: "2026-07-25T00:00:01.000Z",
    type: "response_item",
    payload: { metadata: { type: "compacted" }, content: "SECRET" },
  }));
  assert.equal(parseCompactionPrefix(nested), null);
  // Do not search later fields: once payload/unknown metadata comes first,
  // the bounded content-free proof is no longer available.
  assert.equal(parseCompactionPrefix(Buffer.from(JSON.stringify({
    timestamp: "2026-07-25T00:00:01.000Z",
    payload: { content: "SECRET", type: "compacted" },
    type: "compacted",
  }))), null);
});

test("an oversized compaction stores only a content-free boundary with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-compaction-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { recursive: true });
  const compactedAt = "2026-07-25T00:00:01.500Z";
  const path = join(sessions, "rollout-2026-07-25T00-00-00-aaaa.jsonl");
  await writeFile(path, `${[
    sessionMeta("session-a"),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    JSON.stringify({
      timestamp: "2026-07-25T00:00:01.000Z",
      type: "response_item",
      payload: { metadata: { type: "compacted" }, content: "SECRET NESTED" },
    }),
    compacted(compactedAt, 20_000),
    tokenCount("2026-07-25T00:00:02.000Z", usage(100, 10), usage(100, 10)),
  ].join("\n")}\n`);
  try {
    const { size } = await stat(path);
    const boundaries = [];
    const extracted = await extractRolloutUsage(path, {
      size,
      maximumLineBytes: 512,
      onEvent: () => {},
      onBoundary: (event) => boundaries.push(event),
    });
    assert.equal(extracted.read.oversizedLines, 1);
    assert.equal(extracted.diagnostics.compactionEvents, 1);
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].compactedAtMs, Date.parse(compactedAt));
    assert.equal(boundaries[0].compactionBefore, true);
    assert.equal(boundaries[0].turnContextBefore, true);
    assert.ok(Number.isSafeInteger(boundaries[0].currentSourceOffset));

    const built = await build(root, { maximumLineBytes: 512 });
    assert.equal(built.compactionEvents, 1);
    assert.equal(built.boundaryLinks, 1);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT ce.current_event_key, ce.compaction_before,
               ce.turn_context_before, ce.compacted_at_ms, ce.session_local,
               pv.parser_version, ir.received_at_ms
        FROM usage_event_boundary ce
        JOIN parser_version pv ON pv.id = ce.parser_version_id
        JOIN ingest_run ir ON ir.id = ce.ingest_run_id`).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].compacted_at_ms, Date.parse(compactedAt));
      assert.equal(rows[0].compaction_before, 1);
      assert.equal(rows[0].turn_context_before, 1);
      assert.equal(Buffer.from(rows[0].current_event_key).length, 32);
      assert.equal(Buffer.from(rows[0].session_local).length, 32);
      assert.equal(rows[0].parser_version, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
      assert.ok(Number.isSafeInteger(rows[0].received_at_ms));
      assert.deepEqual(
        database.prepare("PRAGMA table_info(usage_event_boundary)").all()
          .map((column) => column.name),
        [
          "current_event_key",
          "compaction_before",
          "turn_context_before",
          "compacted_at_ms",
          "ingest_run_id",
          "parser_version_id",
          "session_local",
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("boundaries attach to the exact next positive input and require a real turn marker", async () => {
  const tied = "2026-07-25T00:05:00.000Z";
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      compacted(tied),
      // Real logs can co-stamp compaction, a zero-input bookkeeping row and
      // the first positive request. The zero-input row must not consume the
      // boundary merely because its timestamp ties.
      tokenCount(tied, usage(100, 11), usage(0, 1)),
      turnContext(tied, "gpt-5.6-sol"),
      tokenCount(tied, usage(200, 20), usage(100, 9)),
      // A long tool/agent pause inside the same turn is not an older-thread
      // return: no top-level turn_context appeared before this request.
      tokenCount("2026-07-25T06:00:00.000Z", usage(300, 30), usage(100, 10)),
      turnContext("2026-07-25T07:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T07:00:01.000Z", usage(400, 40), usage(100, 10)),
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT u.observed_at_ms, u.tokens_in_uncached, u.tokens_out_text,
               b.compaction_before, b.turn_context_before, b.compacted_at_ms,
               u.source_offset, source.source_local
        FROM usage_event u
        LEFT JOIN usage_event_boundary b ON b.current_event_key = u.event_key
        LEFT JOIN source_dimension source ON source.id = u.source_id`).all();
      const zeroInput = rows.find((row) => (
        row.observed_at_ms === Date.parse(tied)
          && row.tokens_in_uncached === 0
          && row.tokens_out_text === 1
      ));
      assert.equal(zeroInput.compaction_before, null);
      assert.equal(zeroInput.turn_context_before, null);

      const tiedPositive = rows.find((row) => (
        row.observed_at_ms === Date.parse(tied)
          && row.tokens_in_uncached === 100
          && row.tokens_out_text === 9
      ));
      assert.equal(tiedPositive.compaction_before, 1);
      assert.equal(tiedPositive.turn_context_before, 1);
      assert.equal(tiedPositive.compacted_at_ms, Date.parse(tied));
      assert.ok(zeroInput.source_offset < tiedPositive.source_offset);
      assert.equal(Buffer.from(tiedPositive.source_local).length, 32);

      const longToolPause = rows.find((row) => (
        row.observed_at_ms === Date.parse("2026-07-25T06:00:00.000Z")
      ));
      assert.equal(longToolPause.compaction_before, null);
      assert.equal(longToolPause.turn_context_before, null);

      const realReturn = rows.find((row) => (
        row.observed_at_ms === Date.parse("2026-07-25T07:00:01.000Z")
      ));
      assert.equal(realReturn.compaction_before, 0);
      assert.equal(realReturn.turn_context_before, 1);
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM usage_event
          WHERE source_id IS NOT NULL AND source_offset IS NOT NULL`).get().c),
        rows.length,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cache adjacency follows exact source order and exposes incomplete order coverage", async () => {
  const tied = "2026-07-25T00:00:01.000Z";
  // With this fixed local salt/session pair, HMAC event-key order is
  // [max, high, high], while source order is [high, max, high]. That makes the
  // fixture a deterministic regression for the former HMAC tie-breaker.
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-1"),
      turnContext(tied, "gpt-5.6-sol", "high"),
      tokenCount(tied, usage(1_200, 0, 1_000), usage(1_200, 0, 1_000)),
      turnContext(tied, "gpt-5.6-sol", "max"),
      tokenCount(tied, usage(2_400, 0, 1_000), usage(1_200, 0, 0)),
      turnContext(tied, "gpt-5.6-sol", "high"),
      tokenCount(tied, usage(3_600, 0, 2_000), usage(1_200, 0, 1_000)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const nowMs = Date.parse("2026-07-25T00:10:00.000Z");
  const zeroPricer = () => ({ coverageStatus: "fully_priced", totalUsd: "0" });
  try {
    await writeFile(join(root, "salt"), Buffer.alloc(32, 7), { mode: 0o600 });
    await build(root);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      try {
        const sourceOrder = database.prepare(`
          SELECT source_offset FROM usage_event
          ORDER BY source_offset`).all().map((row) => row.source_offset);
        const hmacOrder = database.prepare(`
          SELECT source_offset FROM usage_event
          ORDER BY event_key`).all().map((row) => row.source_offset);
        assert.notDeepEqual(hmacOrder, sourceOrder);

        const impacts = readCacheImpacts(database, { nowMs, pricer: zeroPricer });
        const switched = impacts.cacheSwitchImpact.periods.find(
          (period) => period.periodId === "24h",
        );
        assert.equal(switched.configurationChanges, 2);
        assert.equal(switched.cacheReadDrops, 1);
        assert.equal(switched.recent[0].previous.reasoningEffort, "high");
        assert.equal(switched.recent[0].current.reasoningEffort, "max");
      } finally {
        database.close();
      }
    }

    // Simulate one retained older-parser event without exact order. The lens
    // keeps its periods and observed counts, but withholds affected totals
    // through a total-only coverage gap rather than inventing a category.
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
      database.prepare(`
        UPDATE usage_event SET source_id = NULL, source_offset = NULL
        WHERE source_offset = (SELECT MIN(source_offset) FROM usage_event)`).run();
      database.close();
    }
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      try {
        const impacts = readCacheImpacts(database, { nowMs, pricer: zeroPricer });
        for (const projection of [
          impacts.cacheSwitchImpact,
          impacts.cacheContinuityImpact,
        ]) {
          assert.equal(projection.status, "available");
          const period = projection.periods.find(
            (candidate) => candidate.periodId === "24h",
          );
          assert.equal(period.orderingCoverageGaps, 1);
          assert.equal(period.coverageStatus, "incomplete");
          assert.equal(period.estimatedPremiumUsd, null);
          assert.equal(period.estimatedPremiumUsdExact, null);
        }
        const switchPeriod = impacts.cacheSwitchImpact.periods.find(
          (candidate) => candidate.periodId === "24h",
        );
        assert.ok(Object.values(switchPeriod.byChangeType).every(
          (summary) => !Object.hasOwn(summary, "orderingCoverageGaps"),
        ));
        const continuityPeriod = impacts.cacheContinuityImpact.periods.find(
          (candidate) => candidate.periodId === "24h",
        );
        assert.ok(Object.values(continuityPeriod.byGapBand).every(
          (summary) => !Object.hasOwn(summary, "orderingCoverageGaps"),
        ));
      } finally {
        database.close();
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("ordering coverage is period-scoped and ignores sessions without adjacency", async () => {
  const nowMs = Date.parse("2026-07-25T12:00:00.000Z");
  const oldLatest = "2026-07-15T11:05:00.000Z";
  const singletonAt = "2026-07-25T10:00:00.000Z";
  const { root } = await corpus({
    "rollout-2026-07-25T11-00-00-recent.jsonl": [
      sessionMeta("session-recent"),
      turnContext("2026-07-25T11:00:00.000Z", "gpt-5.6-sol", "high"),
      tokenCount(
        "2026-07-25T11:00:00.000Z",
        usage(1_200, 0, 1_000),
        usage(1_200, 0, 1_000),
      ),
      turnContext("2026-07-25T11:05:00.000Z", "gpt-5.6-sol", "max"),
      tokenCount(
        "2026-07-25T11:05:00.000Z",
        usage(2_400, 0, 1_000),
        usage(1_200, 0, 0),
      ),
    ],
    "rollout-2026-07-15T11-00-00-old.jsonl": [
      sessionMeta("session-old"),
      turnContext("2026-07-15T11:00:00.000Z", "gpt-5.6-sol", "high"),
      tokenCount(
        "2026-07-15T11:00:00.000Z",
        usage(100, 0, 50),
        usage(100, 0, 50),
      ),
      tokenCount(
        oldLatest,
        usage(200, 0, 100),
        usage(100, 0, 50),
      ),
    ],
    "rollout-2026-07-25T10-00-00-single.jsonl": [
      sessionMeta("session-single"),
      turnContext(singletonAt, "gpt-5.6-sol", "high"),
      tokenCount(singletonAt, usage(100, 0, 50), usage(100, 0, 50)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const zeroPricer = () => ({ coverageStatus: "fully_priced", totalUsd: "0" });
  try {
    await build(root);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
      database.prepare(`
        UPDATE usage_event SET source_id = NULL, source_offset = NULL
        WHERE observed_at_ms <= ? OR observed_at_ms = ?`).run(
        Date.parse(oldLatest),
        Date.parse(singletonAt),
      );
      database.close();
    }
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      const impacts = readCacheImpacts(database, { nowMs, pricer: zeroPricer });
      for (const projection of [
        impacts.cacheSwitchImpact,
        impacts.cacheContinuityImpact,
      ]) {
        assert.equal(projection.status, "available");
        for (const periodId of ["24h", "7d"]) {
          const period = projection.periods.find(
            (candidate) => candidate.periodId === periodId,
          );
          assert.equal(period.orderingCoverageGaps, 0, periodId);
          assert.equal(period.coverageStatus, "complete", periodId);
          assert.equal(period.estimatedPremiumUsd, 0, periodId);
        }
        for (const periodId of ["30d", "all"]) {
          const period = projection.periods.find(
            (candidate) => candidate.periodId === periodId,
          );
          assert.equal(period.orderingCoverageGaps, 1, periodId);
          assert.equal(period.coverageStatus, "incomplete", periodId);
          assert.equal(period.estimatedPremiumUsd, null, periodId);
        }
      }

      // The known recent switch remains counted even where an older
      // unorderable session withholds the period total. The ordering gap is
      // not fabricated into a change-type bucket.
      const switchThirty = impacts.cacheSwitchImpact.periods.find(
        (period) => period.periodId === "30d",
      );
      assert.equal(switchThirty.configurationChanges, 1);
      assert.equal(switchThirty.byChangeType.reasoning_only.configurationChanges, 1);
      assert.equal(
        switchThirty.byChangeType.reasoning_only.coverageStatus,
        "complete",
      );
      assert.equal(
        switchThirty.byChangeType.reasoning_only.estimatedPremiumUsd,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an incomplete counter set is never guessed at", () => {
  assert.equal(salvagePartialTokenCount('{"input_tokens":10,"output_tokens":2'), null);
  assert.deepEqual(
    salvagePartialTokenCount(JSON.stringify(usage(10, 2))),
    usage(10, 2),
  );
});

test("lineage components keep a fork with its ancestors and balance by bytes", () => {
  const infos = [
    { rolloutKey: "a", size: 100, lineage: { sessionId: "a", parentId: null } },
    { rolloutKey: "b", size: 10, lineage: { sessionId: "b", parentId: "a" } },
    { rolloutKey: "c", size: 500, lineage: { sessionId: "c", parentId: null } },
  ];
  const components = lineageComponents(infos);
  assert.equal(components.length, 2);
  assert.deepEqual(components[0].members.map((info) => info.rolloutKey), ["c"]);
  assert.deepEqual(components[1].members.map((info) => info.rolloutKey), ["a", "b"]);

  const lanes = balanceComponents(components, 2);
  assert.equal(lanes.length, 2);
  // A child never lands in a different lane from its parent, which is what
  // makes the lineage model seed work without cross-thread coordination.
  const laneOf = new Map();
  for (const [index, lane] of lanes.entries()) {
    for (const member of lane.members) laneOf.set(member.rolloutKey, index);
  }
  assert.equal(laneOf.get("a"), laneOf.get("b"));
});

test("a rebuild refuses an unstated contract version", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [sessionMeta("session-a")],
  });
  try {
    await assert.rejects(
      () => rebuildLocalUnifiedIndex({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
      }),
      TypeError,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a rebuild setup failure removes its unpublished staging database", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-setup.jsonl": [sessionMeta("session-setup")],
  });
  try {
    await assert.rejects(
      build(root, { commitRows: 0 }),
      /commitRows must be a positive safe integer/u,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".building-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("writers refuse to replace an unsafe published-index target", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-target.jsonl": [sessionMeta("session-target")],
  });
  const sentinel = join(root, "sentinel.txt");
  const indexFile = join(root, "index.sqlite");
  try {
    await writeFile(sentinel, "do-not-touch", { mode: 0o600 });
    await symlink(sentinel, indexFile);
    await assert.rejects(
      build(root),
      (error) => error?.code === "local_unified_index_file_invalid",
    );
    assert.equal(await readFile(sentinel, "utf8"), "do-not-touch");
    assert.equal((await lstat(indexFile)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true });
  }
});

// --- Incremental ingest -----------------------------------------------------

test("an incremental pass resumes a cold rebuild's cursors and reads only appended bytes", async () => {
  const { root, sessions } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
  });
  const path = join(sessions, "rollout-2026-07-25T00-00-00-aaaa.jsonl");
  try {
    const built = await build(root);
    assert.equal(built.usageEvents, 2);
    assert.equal(built.boundaryLinks, 1);

    // Append one turn that reports only a cumulative total. The delta can
    // only be computed against the carried baseline, so this fails loudly if
    // the cursor's carry state is wrong.
    const appendedBoundary = `${compacted("2026-07-25T00:00:02.500Z")}\n`
      + `${turnContext("2026-07-25T00:00:02.600Z", "gpt-5.6-sol")}\n`;
    const appendedUsage = `${tokenCountTotalOnly(
      "2026-07-25T00:00:03.000Z",
      usage(450, 55),
    )}\n`;
    // First append only boundary markers. Both must remain in bounded,
    // content-free source state rather than being lost at EOF or linked to an
    // earlier request.
    await appendFile(path, appendedBoundary);
    const first = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(first.sourcesResumed, 1);
    assert.equal(first.sourcesRescanned, 0);
    assert.equal(first.insertedUsageEvents, 0);
    assert.equal(first.insertedBoundaryLinks, 0);
    assert.equal(first.totalUsageEvents, 2);
    assert.equal(first.totalBoundaryLinks, 1);
    // Only the appended bytes were read.
    assert.equal(first.bytesScanned, Buffer.byteLength(appendedBoundary));
    {
      const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
      try {
        const pending = database.prepare(`
          SELECT compacted_at_ms, source_offset, turn_context_pending
          FROM source_boundary_state`).get();
        assert.equal(pending.compacted_at_ms, Date.parse("2026-07-25T00:00:02.500Z"));
        assert.ok(Number.isSafeInteger(pending.source_offset));
        assert.equal(pending.turn_context_pending, 1);
      } finally {
        database.close();
      }
    }

    await appendFile(path, appendedUsage);
    const second = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(second.sourcesResumed, 1);
    assert.equal(second.insertedUsageEvents, 1);
    assert.equal(second.insertedBoundaryLinks, 1);
    assert.equal(second.totalUsageEvents, 3);
    assert.equal(second.totalBoundaryLinks, 2);
    assert.equal(second.bytesScanned, Buffer.byteLength(appendedUsage));

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT u.tokens_in_uncached AS iu, u.tokens_out_text AS ot,
               b.compaction_before, b.turn_context_before
        FROM usage_event u
        LEFT JOIN usage_event_boundary b ON b.current_event_key = u.event_key
        ORDER BY u.observed_at_ms`).all();
      assert.equal(rows.length, 3);
      // 450 - 300 input, 55 - 30 output against the carried baseline.
      assert.equal(rows[2].iu, 150);
      assert.equal(rows[2].ot, 25);
      assert.equal(rows[2].compaction_before, 1);
      assert.equal(rows[2].turn_context_before, 1);
      assert.equal(
        Number(database.prepare("SELECT COUNT(*) AS c FROM source_boundary_state").get().c),
        0,
      );
    } finally {
      database.close();
    }

    // Nothing changed: the next pass reads nothing and inserts nothing.
    const settled = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(settled.sourcesSkipped, 1);
    assert.equal(settled.sourcesScanned, 0);
    assert.equal(settled.bytesScanned, 0);
    assert.equal(settled.insertedUsageEvents, 0);
    assert.equal(settled.insertedBoundaryLinks, 0);
    assert.equal(settled.totalUsageEvents, 3);
    assert.equal(settled.totalBoundaryLinks, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a same-parser shrink removes stale usage and boundary rows before rescan", async () => {
  const keptLines = [
    sessionMeta("session-a"),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    compacted("2026-07-25T00:00:01.500Z"),
    turnContext("2026-07-25T00:00:01.600Z", "gpt-5.6-sol"),
    tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
  ];
  const { root, sessions } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      ...keptLines,
      turnContext("2026-07-25T00:00:02.500Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:03.000Z", usage(600, 60), usage(300, 30)),
    ],
  });
  const path = join(sessions, "rollout-2026-07-25T00-00-00-aaaa.jsonl");
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  try {
    const first = await ingest();
    assert.equal(first.unchanged, false);
    assert.equal(first.insertedUsageEvents, 3);
    assert.equal(first.insertedBoundaryLinks, 3);

    // Replace the file with a valid shorter prefix. The removed request had
    // both a usage row and a turn-boundary relation, neither of which can be
    // displaced by deterministic ON CONFLICT re-insertion alone.
    await writeFile(path, `${keptLines.join("\n")}\n`);
    const shrunk = await ingest();
    assert.equal(shrunk.sourcesRescanned, 1);
    assert.equal(shrunk.usageRowsDeletedForSourceRescan, 3);
    assert.equal(shrunk.boundaryRowsDeletedForSourceRescan, 3);
    assert.equal(shrunk.insertedUsageEvents, 2);
    assert.equal(shrunk.insertedBoundaryLinks, 2);
    assert.equal(shrunk.totalUsageEvents, 2);
    assert.equal(shrunk.totalBoundaryLinks, 2);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(database.prepare(`
        SELECT observed_at_ms FROM usage_event
        ORDER BY observed_at_ms`).all().map((row) => row.observed_at_ms), [
        Date.parse("2026-07-25T00:00:01.000Z"),
        Date.parse("2026-07-25T00:00:02.000Z"),
      ]);
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM usage_event
          WHERE source_id IS NOT NULL AND source_offset IS NOT NULL`).get().c),
        2,
      );
      assert.equal(
        Number(database.prepare("SELECT COUNT(*) AS c FROM usage_event_boundary").get().c),
        2,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an unchanged incremental pass preserves the live generation and file metadata", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-unchanged.jsonl": [
      sessionMeta("session-unchanged"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    const built = await build(root);
    const before = await stat(indexFile);
    const result = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    const after = await stat(indexFile);
    assert.equal(result.unchanged, true);
    assert.equal(result.bytesScanned, 0);
    assert.equal(result.insertedUsageEvents, 0);
    assert.equal(result.generation.fingerprint, built.generation.fingerprint);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".incremental-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("tool facts are private, generation-bound, incremental and rescan-safe", async () => {
  const sourceName = "rollout-2026-07-25T00-00-00-tools.jsonl";
  const privateToolName = "PRIVATE_TOOL_NAME_CANARY";
  const privateCallId = "PRIVATE_TOOL_CALL_ID_CANARY";
  const initialLines = [
    sessionMeta("session-tools"),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    toolCall("2026-07-25T00:00:01.000Z", {
      type: "function_call",
      name: "thread_spawn",
      call_id: privateCallId,
    }),
    toolCall("2026-07-25T00:00:02.000Z", {
      type: "custom_tool_call",
      name: privateToolName,
      call_id: `${privateCallId}-other`,
    }),
  ];
  const { root, sessions } = await corpus({ [sourceName]: initialLines });
  const sourceFile = join(sessions, sourceName);
  const indexFile = join(root, "index.sqlite");
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  const readFacts = () => {
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      return {
        descriptor: readUnifiedIndexGenerationDescriptor(database),
        facts: database.prepare(`
          SELECT hex(event_key) AS event_key, tool_class, source_kind,
                 source_offset, tool_ordinal, generation_id
          FROM tool_class_fact ORDER BY source_offset, tool_ordinal`).all(),
        compatibility: database.prepare(`
          SELECT tool_class, SUM(count) AS count
          FROM tool_class_count GROUP BY tool_class ORDER BY tool_class`).all()
          .map((row) => ({
            tool_class: row.tool_class,
            count: Number(row.count),
          })),
      };
    } finally {
      database.close();
    }
  };
  try {
    const built = await build(root);
    assert.equal(built.toolEvents, 2);
    assert.equal(built.generation.toolFacts, 2);
    assert.equal(built.generation.toolProvenanceComplete, true);
    assert.match(built.generation.toolFactFingerprint, /^tool-facts-v1-[a-f0-9]{64}$/u);
    const cold = readFacts();
    assert.deepEqual(cold.facts.map((row) => row.tool_class), [
      "subagent",
      "other",
    ]);
    assert.deepEqual(cold.compatibility, [
      { tool_class: "other", count: 1 },
      { tool_class: "subagent", count: 1 },
    ]);
    const publishedBytes = await readFile(indexFile);
    assert.equal(publishedBytes.includes(privateToolName), false);
    assert.equal(publishedBytes.includes(privateCallId), false);

    const before = await stat(indexFile);
    const unchanged = await ingest();
    const after = await stat(indexFile);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.bytesScanned, 0);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    await appendFile(sourceFile, `${toolCall(
      "2026-07-25T00:00:03.000Z",
      { type: "web_search_call", id: `${privateCallId}-server` },
    )}\n`);
    const appended = await ingest();
    assert.equal(appended.sourcesResumed, 1);
    assert.equal(appended.toolEvents, 1);
    assert.equal(appended.generation.toolFacts, 3);
    assert.equal(appended.generation.toolProvenanceComplete, true);
    const afterAppend = readFacts();
    assert.deepEqual(afterAppend.facts.slice(0, 2).map((row) => row.event_key),
      cold.facts.map((row) => row.event_key));
    assert.deepEqual(afterAppend.facts.map((row) => row.tool_class), [
      "subagent",
      "other",
      "web_search",
    ]);
    assert.ok(afterAppend.facts.every((row) => (
      row.generation_id === appended.generation.id
    )));

    await writeFile(sourceFile, `${[
      sessionMeta("session-tools"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      toolCall("2026-07-25T00:00:04.000Z", {
        type: "shell_call",
        id: `${privateCallId}-replacement`,
      }),
    ].join("\n")}\n`);
    const rescanned = await ingest();
    assert.equal(rescanned.sourcesRescanned, 1);
    assert.equal(rescanned.generation.toolFacts, 1);
    const afterRescan = readFacts();
    assert.deepEqual(afterRescan.facts.map((row) => row.tool_class), [
      "hosted_shell",
    ]);
    assert.deepEqual(afterRescan.compatibility, [
      { tool_class: "hosted_shell", count: 1 },
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an oversized typed tool record blocks complete generation publication", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-tool-limit.jsonl": [
      sessionMeta("session-tool-limit"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      toolCall("2026-07-25T00:00:01.000Z", {
        type: "custom_tool_call",
        name: "exec",
        input: `PRIVATE_OVERSIZED_TOOL_INPUT_${"x".repeat(4_096)}`,
      }),
    ],
  });
  try {
    const built = await build(root, { maximumLineBytes: 512 });
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.blockReason, "tool_provenance_incomplete");
    assert.equal(built.generation.toolProvenanceComplete, false);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      const skipped = database.prepare(`
        SELECT count FROM source_diagnostic
        WHERE generation_id = ? AND code = 'toolRecordsSkipped'
      `).get(built.generation.id);
      assert.equal(Number(skipped?.count), 1);
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM tool_class_fact",
      ).get().count), 0);
    } finally {
      database.close();
    }
    const unchanged = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      maximumLineBytes: 512,
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
    assert.equal(unchanged.generation.blockReason, "tool_provenance_incomplete");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("same-size replacement and truncation replace source usage and quota facts", async () => {
  const sourceName = "rollout-2026-07-25T00-00-00-replaced.jsonl";
  const initialLines = [
    sessionMeta("session-replaced"),
    turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
    tokenCount(
      "2026-07-25T00:00:01.000Z",
      usage(100, 10),
      usage(100, 10),
      { usedPercent: 12 },
    ),
  ];
  const { root, sessions } = await corpus({ [sourceName]: initialLines });
  const sourceFile = join(sessions, sourceName);
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    const original = await stat(sourceFile);
    const replacementLines = [
      sessionMeta("session-replaced"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(900, 90),
        usage(900, 90),
        { usedPercent: 92 },
      ),
    ];
    await writeFile(sourceFile, `${replacementLines.join("\n")}\n`);
    assert.equal((await stat(sourceFile)).size, original.size);
    await utimes(
      sourceFile,
      original.atime,
      new Date(original.mtimeMs + 2_000),
    );

    const replaced = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(replaced.sourcesRescanned, 1);
    assert.equal(replaced.totalUsageEvents, 1);
    assert.equal(replaced.quotaOccurrenceRowsDeletedForRescan, 1);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      try {
        assert.equal(Number(database.prepare(`
          SELECT SUM(tokens_in_uncached) AS total FROM usage_event`).get().total), 900);
        assert.equal(Number(database.prepare(`
          SELECT used_percent FROM quota_observation`).get().used_percent), 92);
        assert.equal(Number(database.prepare(`
          SELECT COUNT(*) AS count FROM quota_occurrence`).get().count), 1);
      } finally {
        database.close();
      }
    }

    await writeFile(sourceFile, `${initialLines.slice(0, 2).join("\n")}\n`);
    const truncated = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(truncated.sourcesRescanned, 1);
    assert.equal(truncated.totalUsageEvents, 0);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      try {
        assert.equal(Number(database.prepare(`
          SELECT COUNT(*) AS count FROM usage_event`).get().count), 0);
        assert.equal(Number(database.prepare(`
          SELECT COUNT(*) AS count FROM quota_occurrence`).get().count), 0);
        assert.equal(Number(database.prepare(`
          SELECT COUNT(*) AS count FROM quota_observation`).get().count), 0);
      } finally {
        database.close();
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a shrunken discovered source set publishes a new generation", async () => {
  const firstName = "rollout-2026-07-25T00-00-00-source-a.jsonl";
  const secondName = "rollout-2026-07-25T00-00-00-source-b.jsonl";
  const { root, sessions } = await corpus({
    [firstName]: [
      sessionMeta("session-source-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
    [secondName]: [
      sessionMeta("session-source-b"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(200, 20), usage(200, 20)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    const built = await build(root);
    assert.equal(built.generation.discoveredSourceCount, 2);
    await rm(join(sessions, secondName));

    const result = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });

    assert.notEqual(result.unchanged, true);
    assert.ok(result.generation.id > built.generation.id);
    assert.equal(result.generation.discoveredSourceCount, 1);
    assert.equal(result.generation.indexedSourceCount, 2);
    assert.equal(result.generation.status, "complete");
    assert.equal(result.sources, 1);
    assert.equal(result.sourcesSkipped, 1);
    assert.equal(result.bytesScanned, 0);
    assert.equal(result.totalUsageEvents, 2, "rotated raw sources remain indexed");
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM generation_source
        WHERE generation_id = ?`).get(result.generation.id).count), 2);
    } finally {
      database.close();
    }
    const projection = await readLocalUnifiedCompanionProjection({
      indexFile,
      nowMs: Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(projection.status, "available");
    assert.equal(projection.discoveredSourceCount, 1);
    assert.equal(projection.indexedSourceCount, 2);
    assert.ok(projection.indexedSourceBytes > projection.discoveredSourceBytes);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a rotated pre-tool source withholds tools without blocking accounting", async () => {
  const firstName = "rollout-2026-07-25T00-00-00-current-tools.jsonl";
  const secondName = "rollout-2026-07-25T00-00-00-rotated-v7.jsonl";
  const { root, sessions } = await corpus({
    [firstName]: [
      sessionMeta("session-current-tools"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
    [secondName]: [
      sessionMeta("session-rotated-v7"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(200, 20), usage(200, 20)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
    database.prepare(`
      INSERT INTO parser_version(parser_version, contract_version)
      VALUES ('unified-rollout-typed-v7', ?)
      ON CONFLICT(parser_version, contract_version) DO NOTHING
    `).run(CONTRACT);
    const parserVersionId = database.prepare(`
      SELECT id FROM parser_version
      WHERE parser_version = 'unified-rollout-typed-v7'
        AND contract_version = ?
    `).get(CONTRACT).id;
    const runId = database.prepare(`
      INSERT INTO ingest_run(received_at_ms, parser_version_id)
      VALUES (?, ?)
    `).run(Date.parse("2026-07-25T00:00:03.000Z"), parserVersionId)
      .lastInsertRowid;
    database.prepare(`
      UPDATE source_cursor SET ingest_run_id = ? WHERE source_ordinal = 1
    `).run(runId);
    database.close();
    await rm(join(sessions, secondName));

    const ingested = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(ingested.generation.status, "partial");
    assert.equal(
      ingested.generation.blockReason,
      "tool_provenance_incomplete",
    );
    assert.equal(ingested.generation.usageProvenanceComplete, true);
    assert.equal(ingested.generation.sourceOrderComplete, true);
    assert.equal(ingested.generation.quotaProvenanceComplete, true);
    assert.equal(ingested.generation.toolProvenanceComplete, false);

    const source = createLocalUnifiedAccountingSource({
      indexFile,
      requireComplete: true,
      expectedGeneration: ingested.generation,
      contextBehavior: "legacy_zero",
    });
    const accounting = await source({
      startAt: "2026-07-25T00:00:00.000Z",
      endAt: "2026-07-26T00:00:00.000Z",
    });
    assert.equal(accounting.coverage.status, "complete");
    assert.equal(accounting.coverage.generationProof, true);
    assert.equal(accounting.coverage.toolFactsComplete, false);

    const projection = await readLocalUnifiedCompanionProjection({
      indexFile,
      nowMs: Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(projection.status, "available");
    assert.equal(projection.toolCoverageStatus, "partial");
    assert.equal(projection.tools.total, 0);
    assert.equal(projection.discoveredSourceCount, 1);
    assert.equal(projection.indexedSourceCount, 2);

    const unchanged = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
    assert.equal(unchanged.totalUsageEvents, 2);
    assert.equal(unchanged.generation.status, "partial");
    assert.equal(
      unchanged.generation.blockReason,
      "tool_provenance_incomplete",
    );
    assert.equal(unchanged.generation.toolProvenanceComplete, false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an aborted incremental pass discards its staged clone and preserves the live index", async () => {
  const { root, sessions } = await corpus({
    "rollout-2026-07-25T00-00-00-abort.jsonl": [
      sessionMeta("session-abort"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const sourceFile = join(
    sessions,
    "rollout-2026-07-25T00-00-00-abort.jsonl",
  );
  try {
    const built = await build(root);
    const before = await stat(indexFile);
    await appendFile(
      sourceFile,
      `${tokenCountTotalOnly("2026-07-25T00:00:02.000Z", usage(150, 15))}\n`,
    );
    const controller = new AbortController();
    await assert.rejects(
      () => ingestLocalUnifiedIndexIncrement({
        codexHome: root,
        indexFile,
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      (error) => error?.code === "local_unified_index_aborted",
    );
    const after = await stat(indexFile);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(
        Number(database.prepare("SELECT COUNT(*) AS c FROM usage_event").get().c),
        built.usageEvents,
      );
      assert.equal(
        Number(database.prepare(
          "SELECT value FROM meta WHERE key = 'current_generation_id'",
        ).get().value),
        built.generation.id,
      );
    } finally {
      database.close();
    }
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".incremental-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a fork created after its parent was indexed still suppresses replay", async () => {
  // The parent is indexed in one pass, alone: nothing references it yet, so
  // no snapshot set was collected for it. The fork appears later and replays
  // the parent's history WITH its turn_context, which disarms rule 2 — only
  // the ancestor set (rule 1) can tell the replay from real spend. The
  // incremental pass must therefore re-scan the parent once to make its set
  // durable before scanning the fork.
  const { root, sessions } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
  });
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  try {
    const first = await ingest();
    assert.equal(first.insertedUsageEvents, 2);

    await writeFile(join(sessions, "rollout-2026-07-25T01-00-00-child.jsonl"), `${[
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T01:00:01.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T01:00:02.000Z", usage(300, 30), usage(200, 20)),
      tokenCount("2026-07-25T01:00:03.000Z", usage(400, 50), usage(100, 20)),
    ].join("\n")}\n`);
    const second = await ingest();
    // The parent was re-scanned once to build its durable set; its rows are
    // re-inserted into ON CONFLICT DO NOTHING, so nothing double-counts.
    assert.equal(second.sourcesRescanned, 2);
    assert.equal(second.forkReplayEventsSkipped, 2);
    assert.equal(second.insertedUsageEvents, 1);
    assert.equal(second.totalUsageEvents, 3);

    // A SECOND fork of the same parent, in a later pass. The parent's set is
    // durable now, so the parent is NOT re-scanned: suppression must come
    // from the persisted lineage_snapshot table alone.
    await writeFile(join(sessions, "rollout-2026-07-25T02-00-00-second.jsonl"), `${[
      sessionMeta("session-second", { parentId: "session-parent", threadSource: "subagent" }),
      turnContext("2026-07-25T02:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T02:00:01.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T02:00:02.000Z", usage(300, 30), usage(200, 20)),
      tokenCount("2026-07-25T02:00:03.000Z", usage(500, 70), usage(200, 40)),
    ].join("\n")}\n`);
    const third = await ingest();
    assert.equal(third.sourcesRescanned, 1, "only the new fork is scanned");
    assert.equal(third.forkReplayEventsSkipped, 2);
    assert.ok(third.lineageSnapshotLookups > 0, "membership came from the persisted set");
    assert.equal(third.insertedUsageEvents, 1);
    assert.equal(third.totalUsageEvents, 4);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(
        "SELECT SUM(tokens_in_uncached) AS iu, SUM(tokens_out_text) AS ot FROM usage_event",
      ).get();
      // Parent 300/30 + child's own 100/20 + second fork's own 200/40.
      assert.equal(Number(totals.iu), 600);
      assert.equal(Number(totals.ot), 90);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a version-1 index can be opened through the additive v10 schema migration", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  try {
    await build(root);
    // Regress the file to version 1: drop the widened tables, stamp the old
    // user_version. This is byte-equivalent to an index produced before the
    // 2026-08-07 widenings.
    {
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(join(root, "index.sqlite"));
      raw.exec(`
        DROP TABLE source_boundary_state;
        DROP TABLE source_cursor;
        DROP TABLE lineage_snapshot;
        DROP TABLE session_identity;
        DROP TABLE usage_event_boundary;
        DROP INDEX usage_event_replay_order;
        UPDATE usage_event SET source_id = NULL, source_offset = NULL;
        ALTER TABLE usage_event DROP COLUMN source_offset;
        ALTER TABLE usage_event DROP COLUMN source_id;
        DROP TABLE source_dimension;
        INSERT INTO meta(key, value) VALUES ('schema_version', 'local-unified-index-v1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        PRAGMA user_version=1;
      `);
      raw.close();
    }
    // Read-only: accepted as-is. Rows must survive.
    const readOnly = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    assert.equal(
      Number(readOnly.prepare("SELECT COUNT(*) AS c FROM usage_event").get().c),
      1,
    );
    readOnly.close();
    // Writable: migrated in place. The widened tables exist again and the
    // indexed rows are untouched.
    const writable = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: false });
    assert.equal(
      Number(writable.prepare("PRAGMA user_version").get().user_version),
      10,
    );
    assert.equal(
      Number(writable.prepare("SELECT COUNT(*) AS c FROM usage_event").get().c),
      1,
    );
    writable.prepare("SELECT COUNT(*) AS c FROM source_cursor").get();
    writable.prepare("SELECT COUNT(*) AS c FROM usage_event_boundary").get();
    writable.prepare("SELECT COUNT(*) AS c FROM source_dimension").get();
    assert.ok(writable.prepare("PRAGMA table_info(usage_event)").all()
      .some((column) => column.name === "source_offset"));
    writable.prepare("SELECT COUNT(*) AS c FROM source_boundary_state").get();
    writable.prepare("SELECT COUNT(*) AS c FROM generation_issue").get();
    writable.prepare("SELECT COUNT(*) AS c FROM generation_issue_group").get();
    writable.close();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("v7 diagnostic rows survive the closed-vocabulary v10 migration", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-v7-diagnostics.jsonl": [
      sessionMeta("session-v7-diagnostics"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(indexFile);
    const before = Number(old.prepare(
      "SELECT COUNT(*) AS count FROM source_diagnostic",
    ).get().count);
    old.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE source_diagnostic RENAME TO source_diagnostic_v8;
      CREATE TABLE source_diagnostic(
        generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
        source_local BLOB NOT NULL CHECK(length(source_local) = 32),
        code TEXT NOT NULL CHECK(code IN (
          'relevantLines', 'malformedLines', 'malformedTimestamps',
          'partialLines', 'salvagedRecords', 'turnContexts', 'tokenCounts',
          'forkReplayEventsSkipped', 'unattributedForkReplayEventsSkipped',
          'cumulativeCounterRegressions', 'tierEvents', 'modelSeededFromLineage',
          'tierSeededFromLineage', 'modelMissing', 'oversizedLines',
          'contradictedLeadingSnapshotsSkipped')),
        count INTEGER NOT NULL CHECK(count >= 0),
        PRIMARY KEY(generation_id, source_local, code)) STRICT, WITHOUT ROWID;
      INSERT INTO source_diagnostic(generation_id, source_local, code, count)
        SELECT generation_id, source_local, code, count
        FROM source_diagnostic_v8
        WHERE code NOT IN (
          'toolRecords', 'toolEvents', 'toolRecordsSkipped',
          'toolSourceHistoryUnavailable', 'malformedAccountingRecords',
          'malformedUsageRecords', 'malformedRateLimitRecords');
      DROP TABLE source_diagnostic_v8;
      PRAGMA user_version=7;
      COMMIT;
    `);
    const retained = Number(old.prepare(
      "SELECT COUNT(*) AS count FROM source_diagnostic",
    ).get().count);
    assert.ok(retained <= before);
    old.close();

    const migrated = openLocalUnifiedIndex(indexFile, { readOnly: false });
    try {
      assert.equal(
        Number(migrated.prepare("PRAGMA user_version").get().user_version),
        10,
      );
      assert.equal(Number(migrated.prepare(
        "SELECT COUNT(*) AS count FROM source_diagnostic",
      ).get().count), retained);
      const sql = migrated.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'source_diagnostic'
      `).get()?.sql;
      assert.match(sql, /toolRecordsSkipped/u);
      assert.match(sql, /malformedAccountingRecords/u);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the first ingest after a legacy migration publishes a clean authoritative rebuild", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-migrated.jsonl": [
      sessionMeta("session-migrated"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    {
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(indexFile);
      raw.exec(`
        UPDATE usage_event SET source_local = NULL, source_offset = NULL,
          source_ordinal = NULL;
        INSERT INTO meta(key, value) VALUES ('schema_version', 'local-unified-index-v1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        PRAGMA user_version=1;
      `);
      raw.close();
    }

    const healed = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(healed.rebuilt, true);
    assert.equal(healed.rebuildReason, "source_identity_changed");
    assert.equal(healed.generation.status, "complete");
    assert.equal(healed.generation.usageProvenanceComplete, true);
    assert.equal(healed.generation.sourceOrderComplete, true);
    assert.equal(healed.generation.quotaProvenanceComplete, true);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM usage_event
        WHERE source_local IS NULL OR source_offset IS NULL
          OR source_ordinal IS NULL`).get().count), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an additively widened but unattested generation rebuilds in one refresh", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-unattested.jsonl": [
      sessionMeta("session-unattested"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
      database.prepare(`
        UPDATE index_generation SET usage_provenance_complete = 0,
          source_order_complete = 0, quota_provenance_complete = 0
        WHERE id = (SELECT CAST(value AS INTEGER) FROM meta
                    WHERE key = 'current_generation_id')`).run();
      database.close();
    }
    const healed = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(healed.rebuilt, true);
    assert.equal(healed.rebuildReason, "incomplete_generation");
    assert.equal(healed.generation.status, "complete");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("classifySource maps growth, identity, corruption, shrink and novelty to the right work", () => {
  const info = {
    size: 100,
    mtimeMs: 5,
    ctimeMs: 6,
    dev: 7,
    ino: 8,
    birthtimeMs: 9,
  };
  const physicalCursor = {
    source_identity_token: "7:8:9",
    source_state_token: "5:6",
    quarantine_code: null,
    scanned_bytes: 100,
  };
  assert.deepEqual(classifySource(info, undefined), { mode: "rescan" });
  assert.deepEqual(
    classifySource(info, { ...physicalCursor, size_bytes: 100, mtime_ms: 5 }),
    { mode: "skip" },
  );
  assert.deepEqual(
    classifySource(info, {
      ...physicalCursor,
      size_bytes: 100,
      mtime_ms: 4,
      source_state_token: "4:6",
    }),
    { mode: "rescan", reason: "same_size_changed" },
  );
  assert.deepEqual(
    classifySource(info, {
      ...physicalCursor,
      size_bytes: 60,
      scanned_bytes: 60,
      mtime_ms: 5,
    }),
    { mode: "resume" },
  );
  assert.deepEqual(
    classifySource(info, {
      ...physicalCursor,
      size_bytes: 160,
      scanned_bytes: 160,
      mtime_ms: 5,
    }),
    { mode: "rescan", reason: "shrink" },
  );
  assert.deepEqual(
    classifySource(info, {
      ...physicalCursor,
      size_bytes: 100,
      scanned_bytes: 99,
    }),
    { mode: "rescan", reason: "cursor_invalid" },
  );
});

test("classifySource forces a whole-file rescan for cursors stamped by an older parser", () => {
  const info = {
    size: 100,
    mtimeMs: 5,
    ctimeMs: 6,
    dev: 7,
    ino: 8,
    birthtimeMs: 9,
  };
  // An up-to-date cursor keeps its cheap classification.
  assert.deepEqual(
    classifySource(
      info,
      {
        size_bytes: 100,
        mtime_ms: 5,
        source_identity_token: "7:8:9",
        source_state_token: "5:6",
        quarantine_code: null,
        scanned_bytes: 100,
        parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      },
      LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    ),
    { mode: "skip" },
  );
  // A cursor stamped by an older parser is re-derived regardless of size or
  // state — skip and resume are both overridden.
  for (const cursor of [
    { size_bytes: 100, mtime_ms: 5, parser_version: "unified-rollout-typed-v1" },
    { size_bytes: 100, mtime_ms: 4, parser_version: "unified-rollout-typed-v1" },
    { size_bytes: 60, mtime_ms: 5, parser_version: "unified-rollout-typed-v1" },
    // v2 rows label lineage descendants' pre-declaration turns "unobserved"
    // even when an ancestor declaration is reachable; the v3 bump (lineage
    // speed carry-forward) must flag them for re-derivation.
    { size_bytes: 100, mtime_ms: 5, parser_version: "unified-rollout-typed-v2" },
    // A cursor whose run row is missing reads as unknown, the safe direction.
    { size_bytes: 100, mtime_ms: 5, parser_version: null },
  ]) {
    assert.deepEqual(
      classifySource(info, cursor, LOCAL_UNIFIED_INDEX_PARSER_VERSION),
      { mode: "rescan", reason: "parser_version" },
    );
  }
});

test("a v5 development cursor cold-rebuilds into v10 rollout identity", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      compacted("2026-07-25T00:00:01.500Z"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  try {
    const first = await ingest();
    assert.equal(first.insertedUsageEvents, 2);
    assert.equal(first.insertedBoundaryLinks, 2);

    // Reproduce the release-blocking development state: schema version 5,
    // cursor provenance that would look current if the parser identifier were
    // not advanced, and newly migrated exact-order columns still NULL.
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
      database.prepare(`
        UPDATE parser_version
        SET parser_version = 'unified-rollout-typed-v5'`).run();
      database.prepare(`
        UPDATE usage_event SET source_id = NULL, source_offset = NULL`).run();
      database.exec("PRAGMA user_version=5");
      database.close();
    }

    const healed = await ingest();
    assert.equal(healed.rebuilt, true);
    assert.equal(healed.rebuildReason, "source_identity_changed");
    assert.equal(healed.sourcesReparsedForParserVersion ?? 0, 0);
    assert.equal(healed.usageRowsDeletedForReparse ?? 0, 0);
    assert.equal(healed.boundaryRowsDeletedForReparse ?? 0, 0);
    assert.equal(healed.generation.status, "complete");
    assert.equal(healed.generation.usageProvenanceComplete, true);
    assert.equal(healed.generation.sourceOrderComplete, true);
    assert.equal(healed.sourcesRescanned, 1);
    assert.equal(healed.insertedUsageEvents, 2);
    assert.equal(healed.insertedBoundaryLinks, 2);

    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(
        Number(database.prepare("PRAGMA user_version").get().user_version),
        10,
      );
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM usage_event
          WHERE source_id IS NULL OR source_local IS NULL
            OR source_offset IS NULL OR source_ordinal IS NULL`).get().c),
        0,
      );
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS c FROM usage_event_boundary",
      ).get().c), 2);
      assert.deepEqual(database.prepare(`
        SELECT DISTINCT parser.parser_version
        FROM usage_event event
        JOIN parser_version parser ON parser.id = event.parser_version_id`).all()
        .map((row) => row.parser_version), [
        LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      ]);
      const cursor = database.prepare(`
        SELECT parser.parser_version
        FROM source_cursor source
        JOIN ingest_run run ON run.id = source.ingest_run_id
        JOIN parser_version parser ON parser.id = run.parser_version_id`).get();
      assert.equal(cursor.parser_version, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a parser-version bump re-derives poisoned sources and replaces their rows", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-aaaa.jsonl": [
      sessionMeta("session-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
      compacted("2026-07-25T00:00:01.500Z"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
  });
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  try {
    const first = await ingest();
    assert.equal(first.insertedUsageEvents, 2);
    assert.equal(first.insertedBoundaryLinks, 2);
    assert.equal(first.sourcesReparsedForParserVersion, 0);

    // Regress the index to an older-parser state: restamp the parser_version
    // dimension row the cursor's ingest run references, and poison the stored
    // token values the way the old delta derivation did. Event keys are
    // (session, offset, observed-at), so without deletion the rescan's
    // ON CONFLICT DO NOTHING would silently keep these phantom values.
    {
      const raw = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: false });
      raw.prepare(
        "UPDATE parser_version SET parser_version = 'unified-rollout-typed-v1'",
      ).run();
      raw.prepare(
        "UPDATE usage_event SET tokens_in_uncached = 5420000000",
      ).run();
      raw.prepare(
        "UPDATE usage_event_boundary SET compacted_at_ms = 0 WHERE compaction_before = 1",
      ).run();
      raw.close();
    }

    const healed = await ingest();
    assert.equal(healed.sourcesReparsedForParserVersion, 1);
    assert.equal(healed.usageRowsDeletedForReparse, 2);
    assert.equal(healed.boundaryRowsDeletedForReparse, 2);
    assert.equal(healed.sourcesRescanned, 1);
    assert.equal(healed.insertedUsageEvents, 2, "rows are re-derived, not kept");
    assert.equal(healed.insertedBoundaryLinks, 2);
    assert.equal(healed.totalUsageEvents, 2);
    assert.equal(healed.totalBoundaryLinks, 2);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS iu, MAX(tokens_in_uncached) AS max_iu
        FROM usage_event`).get();
      assert.equal(Number(totals.iu), 300, "the phantom values are gone");
      assert.equal(Number(totals.max_iu), 200);
      const boundary = database.prepare(`
        SELECT ce.compacted_at_ms, pv.parser_version
        FROM usage_event_boundary ce
        JOIN parser_version pv ON pv.id = ce.parser_version_id
        WHERE ce.compaction_before = 1`).get();
      assert.equal(boundary.compacted_at_ms, Date.parse("2026-07-25T00:00:01.500Z"));
      assert.equal(boundary.parser_version, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
    } finally {
      database.close();
    }

    // The healed cursor is stamped with the current parser version, so the
    // next pass is quiet again.
    const settled = await ingest();
    assert.equal(settled.sourcesReparsedForParserVersion, 0);
    assert.equal(settled.sourcesSkipped, 1);
    assert.equal(settled.insertedUsageEvents, 0);
    assert.equal(settled.insertedBoundaryLinks, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("parser healing preserves stored shared-session sibling facts and quota occurrences", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-segment-a.jsonl": [
      sessionMeta("session-segment-a"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:00:01.000Z",
        usage(100, 10),
        usage(100, 10),
        { usedPercent: 12 },
      ),
    ],
    "rollout-2026-07-25T00-00-00-segment-b.jsonl": [
      sessionMeta("session-segment-b"),
      turnContext("2026-07-25T00:01:00.000Z", "gpt-5.6-sol"),
      tokenCount(
        "2026-07-25T00:01:01.000Z",
        usage(200, 20),
        usage(200, 20),
        { usedPercent: 22 },
      ),
    ],
  });
  const indexFile = join(root, "index.sqlite");
  try {
    await build(root);
    {
      const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
      database.prepare(`
        INSERT INTO parser_version(parser_version, contract_version)
        VALUES ('unified-rollout-typed-v1', ?)
        ON CONFLICT DO NOTHING`).run(CONTRACT);
      const parserId = Number(database.prepare(`
        SELECT id FROM parser_version
        WHERE parser_version = 'unified-rollout-typed-v1'
          AND contract_version = ?`).get(CONTRACT).id);
      const ingestRunId = Number(database.prepare(`
        INSERT INTO ingest_run(received_at_ms, parser_version_id)
        VALUES (?, ?)`).run(Date.now(), parserId).lastInsertRowid);
      const sources = database.prepare(`
        SELECT source_local, session_local FROM source_cursor
        ORDER BY source_ordinal`).all();
      const firstSource = sources[0];
      const secondSource = sources[1];
      database.prepare(`
        UPDATE source_cursor SET ingest_run_id = ? WHERE source_local = ?`)
        .run(ingestRunId, firstSource.source_local);
      // Model a migrated segmented session: two distinct rollout sources share
      // one stored session key. The old session-wide parser repair deleted both
      // sources while rescanning only the stale one.
      database.prepare(`
        UPDATE source_cursor SET session_local = ? WHERE source_local = ?`)
        .run(firstSource.session_local, secondSource.source_local);
      database.prepare(`
        UPDATE usage_event SET session_local = ? WHERE source_local = ?`)
        .run(firstSource.session_local, secondSource.source_local);
      database.close();
    }

    const healed = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(healed.sourcesReparsedForParserVersion, 1);
    assert.equal(healed.sourcesRescanned, 1);
    assert.equal(healed.totalUsageEvents, 2);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM usage_event`).get().count), 2);
      assert.equal(Number(database.prepare(`
        SELECT SUM(tokens_in_uncached) AS total FROM usage_event`).get().total), 300);
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM quota_occurrence`).get().count), 2);
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM quota_observation q
        WHERE NOT EXISTS (
          SELECT 1 FROM quota_occurrence o
          WHERE o.canonical_observation_id = q.id)`).get().count), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

// --- Lineage speed carry-forward --------------------------------------------

function tierRows(database) {
  return database.prepare(`
    SELECT u.observed_at_ms AS ms, m.model_id AS model,
           t.codex_speed_mode AS speed, t.tier_source AS source,
           t.provider_tier_raw AS raw
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    ORDER BY u.observed_at_ms`).all().map((row) => ({
      model: row.model,
      speed: row.speed,
      source: row.source,
      raw: row.raw,
    }));
}

test("a fork descendant inherits its ancestor's declared speed as lineage_inherited", async () => {
  // Root declares Fast; the child forks with no thread_settings_applied of its
  // own; the grandchild forks from the child, which itself only inherited.
  // The nearest reachable declaration wins for both descendants, and the
  // provenance says so: inherited tier never masquerades as an own-file
  // declaration.
  const files = {
    "rollout-2026-07-25T00-00-00-root.jsonl": [
      sessionMeta("session-root"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:00.500Z", "priority"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
    "rollout-2026-07-25T01-00-00-mid.jsonl": [
      sessionMeta("session-mid", { parentId: "session-root", threadSource: "subagent" }),
      // Replayed parent history, then the child's own turn. No declaration.
      tokenCount("2026-07-25T01:00:00.000Z", usage(100, 10), usage(100, 10)),
      turnContext("2026-07-25T01:00:01.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T01:00:02.000Z", usage(200, 20), usage(100, 10)),
    ],
    "rollout-2026-07-25T02-00-00-leaf.jsonl": [
      sessionMeta("session-leaf", { parentId: "session-mid", threadSource: "subagent" }),
      tokenCount("2026-07-25T02:00:00.000Z", usage(100, 10), usage(100, 10)),
      tokenCount("2026-07-25T02:00:01.000Z", usage(200, 20), usage(100, 10)),
      turnContext("2026-07-25T02:00:02.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T02:00:03.000Z", usage(300, 30), usage(100, 10)),
    ],
  };
  const { root } = await corpus(files);
  const expected = [
    { model: "gpt-5.6-sol", speed: "fast", source: "rollout_thread_settings", raw: "priority" },
    { model: "gpt-5.6-sol", speed: "fast", source: "lineage_inherited", raw: "priority" },
    { model: "gpt-5.6-sol", speed: "fast", source: "lineage_inherited", raw: "priority" },
  ];
  try {
    // The single-threaded rebuild and the worker rebuild must attribute
    // identically — the seed travels with the lineage component either way.
    for (const workerCount of [1, 3]) {
      await build(root, { workerCount });
      const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
      try {
        assert.deepEqual(tierRows(database), expected, `workerCount ${workerCount}`);
        // The cursor carries only own-file declarations: the descendants'
        // inherited tier is re-derived from the chain next pass, never
        // laundered into an own observation.
        const carries = database.prepare(
          "SELECT carry_tier_raw AS raw FROM source_cursor ORDER BY raw",
        ).all().map((row) => row.raw);
        assert.deepEqual(carries, [null, null, "priority"]);
      } finally {
        database.close();
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("concurrent unrelated sessions never cross-contaminate speed", async () => {
  // Three overlapping standalone threads: one Fast, one Standard, one silent.
  // service_tier is per-thread; only a session's own lineage may seed it, so
  // the silent thread stays unobserved even though two contemporaneous
  // declarations exist elsewhere.
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-fastt.jsonl": [
      sessionMeta("session-fast"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:01.000Z", "priority"),
      tokenCount("2026-07-25T00:00:02.000Z", usage(100, 10), usage(100, 10)),
    ],
    "rollout-2026-07-25T00-00-00-stand.jsonl": [
      sessionMeta("session-standard"),
      turnContext("2026-07-25T00:00:00.500Z", "gpt-5.5"),
      threadSettings("2026-07-25T00:00:01.500Z", "default"),
      tokenCount("2026-07-25T00:00:02.500Z", usage(100, 10), usage(100, 10)),
    ],
    "rollout-2026-07-25T00-00-00-quiet.jsonl": [
      sessionMeta("session-quiet"),
      turnContext("2026-07-25T00:00:01.000Z", "gpt-5.4-mini"),
      tokenCount("2026-07-25T00:00:03.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(tierRows(database), [
        { model: "gpt-5.6-sol", speed: "fast", source: "rollout_thread_settings", raw: "priority" },
        { model: "gpt-5.5", speed: "standard", source: "rollout_thread_settings", raw: "default" },
        { model: "gpt-5.4-mini", speed: "unknown", source: "unobserved", raw: null },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a fork child whose ancestor chain never declared stays unobserved", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      tokenCount("2026-07-25T01:00:00.000Z", usage(100, 10), usage(100, 10)),
      turnContext("2026-07-25T01:00:01.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T01:00:02.000Z", usage(200, 20), usage(100, 10)),
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(tierRows(database), [
        { model: "gpt-5.6-terra", speed: "unknown", source: "unobserved", raw: null },
        { model: "gpt-5.6-sol", speed: "unknown", source: "unobserved", raw: null },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a child's own declaration supersedes the inherited seed from that turn on", async () => {
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:00.500Z", "priority"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      tokenCount("2026-07-25T01:00:00.000Z", usage(100, 10), usage(100, 10)),
      turnContext("2026-07-25T01:00:01.000Z", "gpt-5.6-sol"),
      // Pre-declaration: inherits the ancestor's Fast.
      tokenCount("2026-07-25T01:00:02.000Z", usage(200, 20), usage(100, 10)),
      // The child then declares its own tier.
      threadSettings("2026-07-25T01:00:03.000Z", "default"),
      tokenCount("2026-07-25T01:00:04.000Z", usage(300, 30), usage(100, 10)),
    ],
  });
  try {
    await build(root);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(tierRows(database), [
        { model: "gpt-5.6-sol", speed: "fast", source: "rollout_thread_settings", raw: "priority" },
        { model: "gpt-5.6-sol", speed: "fast", source: "lineage_inherited", raw: "priority" },
        { model: "gpt-5.6-sol", speed: "standard", source: "rollout_thread_settings", raw: "default" },
      ]);
      // The child's cursor now carries its OWN declaration.
      const carries = database.prepare(
        "SELECT carry_tier_raw AS raw FROM source_cursor ORDER BY raw",
      ).all().map((row) => row.raw);
      assert.deepEqual(carries, ["default", "priority"]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a fork indexed in a later pass inherits from the parent's cursor and keeps provenance across resume", async () => {
  const { root, sessions } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:00.500Z", "priority"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100, 10), usage(100, 10)),
    ],
  });
  const ingest = () => ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
  const readTiers = () => {
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      return {
        rows: tierRows(database),
        carries: database.prepare(
          "SELECT carry_tier_raw AS raw FROM source_cursor ORDER BY raw",
        ).all().map((row) => row.raw),
      };
    } finally {
      database.close();
    }
  };
  const forkFile = (name, sessionId) => [
    sessionMeta(sessionId, { parentId: "session-parent", threadSource: "subagent" }),
    turnContext(`${name}`, "gpt-5.6-sol"),
    tokenCount(`${name.replace(".000Z", ".100Z")}`, usage(100, 10), usage(100, 10)),
    tokenCount(`${name.replace(".000Z", ".200Z")}`, usage(200, 20), usage(100, 10)),
  ];
  try {
    const first = await ingest();
    assert.equal(first.insertedUsageEvents, 1);

    // Pass 2: the first fork appears. The parent is re-scanned once for its
    // durable snapshot set, so the seed comes from THIS pass's derived state.
    await writeFile(
      join(sessions, "rollout-2026-07-25T01-00-00-child.jsonl"),
      `${forkFile("2026-07-25T01:00:00.000Z", "session-child").join("\n")}\n`,
    );
    const second = await ingest();
    assert.equal(second.sourcesRescanned, 2);
    assert.equal(second.insertedUsageEvents, 1);
    assert.deepEqual(readTiers().rows, [
      { model: "gpt-5.6-sol", speed: "fast", source: "rollout_thread_settings", raw: "priority" },
      { model: "gpt-5.6-sol", speed: "fast", source: "lineage_inherited", raw: "priority" },
    ]);

    // Pass 3: a second fork, with the parent's set durable — the parent is
    // NOT re-scanned, so the seed can only come from its persisted cursor.
    await writeFile(
      join(sessions, "rollout-2026-07-25T02-00-00-second.jsonl"),
      `${forkFile("2026-07-25T02:00:00.000Z", "session-second").join("\n")}\n`,
    );
    const third = await ingest();
    assert.equal(third.sourcesRescanned, 1, "only the new fork is scanned");
    assert.equal(third.insertedUsageEvents, 1);
    const afterThird = readTiers();
    assert.deepEqual(afterThird.rows[2], {
      model: "gpt-5.6-sol",
      speed: "fast",
      source: "lineage_inherited",
      raw: "priority",
    });
    // Provenance is never persisted as an own observation: only the parent's
    // cursor carries a tier.
    assert.deepEqual(afterThird.carries, [null, null, "priority"]);

    // Pass 4: the first fork's file grows. Its cursor carries no tier — it
    // never declared — so the resumed segment re-derives the lineage seed and
    // the appended turn keeps lineage_inherited, exactly as a whole-file
    // rescan would label it.
    await appendFile(
      join(sessions, "rollout-2026-07-25T01-00-00-child.jsonl"),
      `${tokenCountTotalOnly("2026-07-25T01:00:05.000Z", usage(300, 30))}\n`,
    );
    const fourth = await ingest();
    assert.equal(fourth.sourcesResumed, 1);
    assert.equal(fourth.insertedUsageEvents, 1);
    const afterFourth = readTiers();
    assert.deepEqual(afterFourth.rows[3], {
      model: "gpt-5.6-sol",
      speed: "fast",
      source: "lineage_inherited",
      raw: "priority",
    });
    assert.deepEqual(afterFourth.carries, [null, null, "priority"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an inherited Fast turn reaches Fast pricing through the speed crossing", async () => {
  // Pricing keys off codex_speed_mode alone; lineage_inherited is provenance.
  // The child's inherited-Fast turn must land in the fast speed bucket of the
  // windowed repricing with a real nonzero priced cost.
  const { root } = await corpus({
    "rollout-2026-07-25T00-00-00-parent.jsonl": [
      sessionMeta("session-parent"),
      turnContext("2026-07-25T00:00:00.000Z", "gpt-5.6-sol"),
      threadSettings("2026-07-25T00:00:00.500Z", "priority"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(1_000_000, 100_000), usage(1_000_000, 100_000)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      tokenCount("2026-07-25T01:00:00.000Z", usage(1_000_000, 100_000), usage(1_000_000, 100_000)),
      turnContext("2026-07-25T01:00:01.000Z", "gpt-5.6-sol"),
      tokenCount("2026-07-25T01:00:02.000Z", usage(2_000_000, 200_000), usage(1_000_000, 100_000)),
    ],
  });
  try {
    await build(root);
    const breakdown = await readLocalUnifiedWindowBreakdown({
      indexFile: join(root, "index.sqlite"),
      fromMs: Date.parse("2026-07-25T00:00:00.000Z"),
      toMs: Date.parse("2026-07-25T02:00:00.000Z"),
    });
    assert.equal(breakdown.status, "available");
    // The parent's own-declared Fast turn and the child's inherited one.
    assert.equal(breakdown.fastEvents, 2);
    assert.equal(breakdown.bySpeed.fast.events, 2);
    assert.ok(breakdown.bySpeed.fast.costUsd > 0, "inherited Fast is priced, not unknown");
    assert.equal(breakdown.bySpeed.unknown, undefined, "no turn fell back to unknown speed");
  } finally {
    await rm(root, { recursive: true });
  }
});
