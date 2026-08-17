import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCacheImpacts } from "../src/cache-switch-impact.js";

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
  inspectLocalUnifiedIndex,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  localDigest,
  openLocalUnifiedIndex,
  OUTCOMES,
  outcomeOrdinal,
  readUnifiedIndexAggregate,
  REASONING_EFFORTS,
  reasoningEffortOrdinal,
  sessionLocal,
} from "../src/local-unified-index.js";
import { readLocalUnifiedWindowBreakdown } from "../src/local-unified-window-breakdown.js";

const CONTRACT = "usage-event-v0.2";

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

test("a version-1 index is migrated additively, never rebuilt", async () => {
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
        UPDATE usage_event SET source_id = NULL, source_offset = NULL;
        ALTER TABLE usage_event DROP COLUMN source_offset;
        ALTER TABLE usage_event DROP COLUMN source_id;
        DROP TABLE source_dimension;
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
      6,
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
    writable.close();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("classifySource maps growth, touch, shrink and novelty to the right work", () => {
  const info = { size: 100, mtimeMs: 5 };
  assert.deepEqual(classifySource(info, undefined), { mode: "rescan" });
  assert.deepEqual(
    classifySource(info, { size_bytes: 100, mtime_ms: 5 }),
    { mode: "skip" },
  );
  assert.deepEqual(
    classifySource(info, { size_bytes: 100, mtime_ms: 4 }),
    { mode: "touch" },
  );
  assert.deepEqual(
    classifySource(info, { size_bytes: 60, mtime_ms: 5 }),
    { mode: "resume" },
  );
  assert.deepEqual(
    classifySource(info, { size_bytes: 160, mtime_ms: 5 }),
    { mode: "rescan", reason: "shrink" },
  );
});

test("classifySource forces a whole-file rescan for cursors stamped by an older parser", () => {
  const info = { size: 100, mtimeMs: 5 };
  // An up-to-date cursor keeps its cheap classification.
  assert.deepEqual(
    classifySource(
      info,
      { size_bytes: 100, mtime_ms: 5, parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION },
      LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    ),
    { mode: "skip" },
  );
  // A cursor stamped by an older parser is re-derived regardless of size or
  // mtime — skip, touch and resume are all overridden.
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

test("a v5 development cursor migrates to v6 and backfills nullable source order", async () => {
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
    assert.equal(healed.sourcesReparsedForParserVersion, 1);
    assert.equal(healed.usageRowsDeletedForReparse, 2);
    assert.equal(healed.boundaryRowsDeletedForReparse, 2);
    assert.equal(healed.sourcesRescanned, 1);
    assert.equal(healed.insertedUsageEvents, 2);
    assert.equal(healed.insertedBoundaryLinks, 2);

    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(
        Number(database.prepare("PRAGMA user_version").get().user_version),
        6,
      );
      assert.equal(
        Number(database.prepare(`
          SELECT COUNT(*) AS c FROM usage_event
          WHERE source_id IS NULL OR source_offset IS NULL`).get().c),
        0,
      );
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
