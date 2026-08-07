import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  balanceComponents,
  lineageComponents,
  modelDeclaration,
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  extractRolloutUsage,
  salvagePartialTokenCount,
} from "../src/local-unified-index-extract.js";
import {
  classifySource,
  ingestLocalUnifiedIndexIncrement,
} from "../src/local-unified-index-ingest.js";
import {
  inspectLocalUnifiedIndex,
  localDigest,
  openLocalUnifiedIndex,
  OUTCOMES,
  outcomeOrdinal,
  readUnifiedIndexAggregate,
  REASONING_EFFORTS,
  reasoningEffortOrdinal,
  sessionLocal,
} from "../src/local-unified-index.js";

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
      tokenCount("2026-07-25T00:00:02.000Z", usage(300, 30), usage(200, 20)),
    ],
    "rollout-2026-07-25T01-00-00-child.jsonl": [
      sessionMeta("session-child", { parentId: "session-parent", threadSource: "subagent" }),
      // The replay carries the parent's turn_context with it.
      turnContext("2026-07-25T01:00:00.000Z", "gpt-5.6-terra"),
      tokenCount("2026-07-25T01:00:01.000Z", usage(100, 10), usage(100, 10)),
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
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const totals = database.prepare(
        "SELECT SUM(tokens_in_uncached) AS iu, SUM(tokens_out_text) AS ot FROM usage_event",
      ).get();
      assert.equal(Number(totals.iu), 400);
      assert.equal(Number(totals.ot), 50);
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
      tokenCount(`2026-07-25T0${index}:00:02.000Z`, usage(250, 25), usage(150, 15)),
    ];
  }
  const { root } = await corpus(files);
  try {
    const single = await build(root, { workerCount: 1 });
    const singleDatabase = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    const singleAggregate = readUnifiedIndexAggregate(singleDatabase);
    singleDatabase.close();

    const parallel = await build(root, { workerCount: 3 });
    const parallelDatabase = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    const parallelAggregate = readUnifiedIndexAggregate(parallelDatabase);
    parallelDatabase.close();

    assert.equal(single.usageEvents, 12);
    assert.equal(parallel.usageEvents, single.usageEvents);
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

    // Append one turn that reports only a cumulative total. The delta can
    // only be computed against the carried baseline, so this fails loudly if
    // the cursor's carry state is wrong.
    await appendFile(path, `${tokenCountTotalOnly(
      "2026-07-25T00:00:03.000Z",
      usage(450, 55),
    )}\n`);
    const first = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(first.sourcesResumed, 1);
    assert.equal(first.sourcesRescanned, 0);
    assert.equal(first.insertedUsageEvents, 1);
    assert.equal(first.totalUsageEvents, 3);
    // Only the appended bytes were read.
    const appended = Buffer.byteLength(
      `${tokenCountTotalOnly("2026-07-25T00:00:03.000Z", usage(450, 55))}\n`,
    );
    assert.equal(first.bytesScanned, appended);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT tokens_in_uncached AS iu, tokens_out_text AS ot,
               tokens_out_reasoning AS orz
        FROM usage_event ORDER BY observed_at_ms`).all();
      assert.equal(rows.length, 3);
      // 450 - 300 input, 55 - 30 output against the carried baseline.
      assert.equal(rows[2].iu, 150);
      assert.equal(rows[2].ot, 25);
    } finally {
      database.close();
    }

    // Nothing changed: the next pass reads nothing and inserts nothing.
    const second = await ingestLocalUnifiedIndexIncrement({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(second.sourcesSkipped, 1);
    assert.equal(second.sourcesScanned, 0);
    assert.equal(second.bytesScanned, 0);
    assert.equal(second.insertedUsageEvents, 0);
    assert.equal(second.totalUsageEvents, 3);
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
    // 2026-08-07 widening.
    {
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(join(root, "index.sqlite"));
      raw.exec(`
        DROP TABLE source_cursor;
        DROP TABLE lineage_snapshot;
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
      2,
    );
    assert.equal(
      Number(writable.prepare("SELECT COUNT(*) AS c FROM usage_event").get().c),
      1,
    );
    writable.prepare("SELECT COUNT(*) AS c FROM source_cursor").get();
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
    { mode: "rescan" },
  );
});
