import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractRolloutUsage } from "../src/local-unified-index-extract.js";
import {
  createHistoryBaseSeedResolver,
  createParentModelResolver,
  selectRolloutUsageSeed,
} from "../src/local-unified-index-history.js";

const timestamp = (second) => new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();
const at = (second) => Date.parse(timestamp(second));
const meta = (second, extra = {}) => ({
  timestamp: timestamp(second), type: "session_meta", payload: {}, ...extra,
});
const context = (second, model, extra = {}) => ({
  timestamp: timestamp(second), type: "turn_context",
  payload: { ...(model === undefined ? {} : { model }), ...extra },
});
const settings = (second, model, extra = {}) => ({
  timestamp: timestamp(second), type: "event_msg",
  payload: { type: "thread_settings_applied", thread_settings: { model, ...extra } },
});
const usage = (input) => ({
  input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0, total_tokens: input,
});
const tokens = (second, input) => ({
  timestamp: timestamp(second), type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: usage(input), last_token_usage: usage(10) },
  },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "parent-model-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return async (name, records, lineage = {}, overrides = {}) => {
    const path = join(root, `${name}.jsonl`);
    const body = records.map((record) => typeof record === "string"
      ? record : JSON.stringify(record)).join("\n") + "\n";
    await writeFile(path, body);
    const info = await stat(path);
    return {
      path, ...info, rolloutKey: name, rolloutId: name, resolvedHead: true,
      lineage: {
        sessionId: name, parentId: null, historyMode: "paginated", historyBase: null,
        ...lineage,
      },
      ...overrides,
    };
  };
}

async function extract(info, options = {}) {
  const events = [];
  const outcome = await extractRolloutUsage(info.path, {
    size: info.size, ...options, onEvent: (event) => { events.push(event); },
  });
  return { events, outcome };
}

test("parent fallback follows copied history and freezes at the child creation time", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [
    meta(0), context(1, "gpt-5.6-luna"), context(5, "gpt-5.6-terra"),
    settings(20, "gpt-5.6-sol"),
  ]);
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([parent, child]).forSource(child);
  assert.equal(modelAt(at(0)), null);
  assert.equal(modelAt(at(2)), "gpt-5.6-luna");
  assert.equal(modelAt(at(6)), "gpt-5.6-terra");
  assert.equal(modelAt(at(30)), "gpt-5.6-terra");
  assert.equal(modelAt(Number.NaN), null);
});

test("ordinal-first paginated metadata supplies creation time and model changes", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [
    { ordinal: 0, ...meta(0) }, { ordinal: 1, ...context(1, "gpt-5.6-luna") },
  ]);
  const child = await source("child", [{ ordinal: 0, ...meta(10) }], { parentId: "parent" });
  const modelAt = await createParentModelResolver([parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "gpt-5.6-luna");
});

test("settings key order and a subtype beyond the header limit preserve explicit model switches", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [
    meta(0), context(1, "gpt-5.6-luna"), {
      timestamp: timestamp(2), type: "event_msg",
      payload: {
        thread_settings: { model: "gpt-5.6-sol", padding: "x".repeat(256) },
        type: "thread_settings_applied",
      },
    },
  ]);
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "gpt-5.6-sol");
});

test("out-of-order model timestamps invalidate the timeline instead of losing a repeated declaration", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [
    meta(0), context(1, "gpt-5.6-luna"), context(10, "gpt-5.6-luna"),
    context(5, "gpt-5.6-sol"),
  ]);
  const child = await source("child", [meta(20)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([parent, child]).forSource(child);
  assert.equal(modelAt(at(6)), null);
  assert.equal(modelAt(at(11)), null);
});

test("explicit child selection overrides fallback, sparse settings preserve it, and custom selection blocks it", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  const child = await source("child", [
    meta(10), tokens(11, 10), context(12, undefined, { effort: "high" }),
    tokens(13, 20), context(14, "gpt-5.6-terra"), tokens(15, 30),
    settings(16, "gpt-5.6-sol"), tokens(17, 40),
    settings(18, "custom-local-model"), tokens(19, 50),
    context(20, undefined), tokens(21, 60),
  ], { parentId: "parent" });
  const parentModelAt = await createParentModelResolver([parent, child]).forSource(child);
  const { events } = await extract(child, { parentModelAt });
  assert.deepEqual(events.map((event) => event.model), [
    "gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol",
    "custom-local-model", "custom-local-model",
  ]);
  assert.deepEqual(events.map((event) => event.modelInherited === true), [
    true, true, false, false, false, false,
  ]);
});

test("an explicit custom parent selection blocks older reviewed ancestry", async (t) => {
  const source = await fixture(t);
  const grandparent = await source("grandparent", [meta(0), context(1, "gpt-5.6-sol")]);
  const parent = await source("parent", [meta(2), context(3, "custom-local-model")], {
    parentId: "grandparent",
  });
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([grandparent, parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "unknown");
});

test("a parent without its own model inherits its ancestor only through its creation boundary", async (t) => {
  const source = await fixture(t);
  const grandparent = await source("grandparent", [
    meta(0), context(1, "gpt-5.6-luna"), context(5, "gpt-5.6-sol"),
  ]);
  const parent = await source("parent", [meta(2)], { parentId: "grandparent" });
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([grandparent, parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "gpt-5.6-luna");
});

test("missing parents, ambiguous selected heads, and ancestry cycles do not inherit", async (t) => {
  const source = await fixture(t);
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  const duplicate = await source("duplicate", [meta(0), context(1, "gpt-5.6-sol")], {
    sessionId: "parent",
  });
  for (const infos of [
    [child], [parent, duplicate, child],
    [{ ...parent, lineage: { ...parent.lineage, parentId: "child" } }, child],
  ]) {
    const modelAt = await createParentModelResolver(infos).forSource(child);
    assert.equal(modelAt(at(11)), null);
  }
});

test("malformed and oversized relevant parent metadata fail closed", async (t) => {
  const source = await fixture(t);
  const child = await source("child", [meta(10)], { parentId: "parent" });
  for (const [index, record] of [
    '{"timestamp":"2026-09-01T00:00:02.000Z","type":"turn_context","payload":',
    context(2, "gpt-5.6-sol", { padding: "x".repeat(1024) }),
    { ...context(2, "gpt-5.6-sol"), timestamp: "invalid-time" },
    context(2, 123),
  ].entries()) {
    const parent = await source(`parent-${index}`, [meta(0), context(1, "gpt-5.6-luna"), record], {
      sessionId: "parent",
    });
    const modelAt = await createParentModelResolver([parent, child], {
      maximumLineBytes: 512,
    }).forSource(child);
    assert.equal(modelAt(at(11)), null);
  }
});

test("absent or malformed child creation metadata does not inherit", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  for (const [index, records] of [
    [], [{ ...meta(10), timestamp: "invalid-time" }],
    ['{"timestamp":"2026-09-01T00:00:10.000Z","type":"session_meta","payload":'],
  ].entries()) {
    const child = await source(`child-${index}`, records, { parentId: "parent" });
    const modelAt = await createParentModelResolver([parent, child]).forSource(child);
    assert.equal(modelAt(at(11)), null);
  }
});

test("fallback changes only model attribution, preserving tokens, counters, effort and tier", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [
    meta(0), context(1, "gpt-5.6-luna", { effort: "high" }),
    settings(2, "gpt-5.6-luna", { service_tier: "priority" }), tokens(3, 900),
  ]);
  const child = await source("child", [meta(10), tokens(11, 10), tokens(12, 25)], { parentId: "parent" });
  const parentModelAt = await createParentModelResolver([parent, child]).forSource(child);
  const before = await extract(child);
  const after = await extract(child, { parentModelAt });
  assert.deepEqual(after.outcome, {
    ...before.outcome,
    diagnostics: { ...before.outcome.diagnostics, modelMissing: 0 },
  });
  assert.equal(before.outcome.diagnostics.modelMissing, 2);
  assert.deepEqual(after.events.map(({ model, modelInherited, ...event }) => event),
    before.events.map(({ model, modelInherited, ...event }) => event));
  assert.ok(after.events.every((event) => event.reasoningEffort === null && event.tier === null));
  assert.equal(after.outcome.finalTotals.total_tokens, 25);
});

test("resuming at a complete event retains inherited model attribution deterministically", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  const child = await source("child", [
    meta(10), tokens(11, 10), context(12, undefined), tokens(13, 20),
    settings(14, "gpt-5.6-sol"), tokens(15, 30), tokens(16, 40),
  ], { parentId: "parent" });
  const parentModelAt = await createParentModelResolver([parent, child]).forSource(child);
  const whole = await extract(child, { parentModelAt });
  for (const index of [0, 1, 2]) {
    const prefix = await extract(child, { parentModelAt, size: whole.events[index].sourceOffset });
    const resumed = await extract(child, {
      parentModelAt,
      startOffset: prefix.outcome.read.nextOffset,
      seedModel: prefix.outcome.finalModel,
      seedEffort: prefix.outcome.finalEffort,
      seedTier: prefix.outcome.finalTier,
      seedTotals: prefix.outcome.finalTotals,
      seedCompactionPending: prefix.outcome.finalCompactionPending,
      seedTurnContextPending: prefix.outcome.finalTurnContextPending,
      seedTurnContextSeen: prefix.outcome.finalTurnContextSeen,
    });
    assert.deepEqual([...prefix.events, ...resumed.events], whole.events);
    assert.equal(resumed.outcome.finalModel, whole.outcome.finalModel);
    assert.deepEqual(resumed.outcome.finalTotals, whole.outcome.finalTotals);
  }
});

test("exact history bases retain their existing model and counter seed without logical fallback", async (t) => {
  const source = await fixture(t);
  const base = await source("base", [meta(0), context(1, "gpt-5.6-terra"), tokens(2, 50)]);
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  const child = await source("child", [meta(10)], {
    parentId: "parent",
    historyBase: { rolloutId: "base", endByteOffset: base.size, endOrdinalExclusive: 3 },
  });
  const infos = [base, parent, child];
  const modelAt = await createParentModelResolver(infos).forSource(child);
  assert.equal(modelAt(at(11)), null);
  const historySeed = await createHistoryBaseSeedResolver(infos).resolveSeed(child);
  const selected = selectRolloutUsageSeed(child, {
    historySeed, logicalSeed: { seedModel: "gpt-5.6-luna" },
  });
  assert.equal(selected.seedModel, "gpt-5.6-terra");
  assert.equal(selected.seedTotals.total_tokens, 50);
});

test("parent physical history traversal excludes declarations after its exact byte boundary", async (t) => {
  const source = await fixture(t);
  const records = [meta(0), context(1, "gpt-5.6-luna")];
  const prefixSize = Buffer.byteLength(records.map(JSON.stringify).join("\n") + "\n");
  const base = await source("base", [...records, context(5, "gpt-5.6-sol")]);
  const parent = await source("parent", [meta(7)], {
    historyBase: { rolloutId: "base", endByteOffset: prefixSize, endOrdinalExclusive: 2 },
  });
  const child = await source("child", [meta(10)], { parentId: "parent" });
  const modelAt = await createParentModelResolver([base, parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "gpt-5.6-luna");
});

test("resolver reads only the discovery snapshot and rejects replaced parent contents", async (t) => {
  const source = await fixture(t);
  const parent = await source("parent", [meta(0), context(1, "gpt-5.6-luna")]);
  const child = await source("child", [meta(10)], { parentId: "parent" });
  await appendFile(parent.path, JSON.stringify(context(5, "gpt-5.6-sol")) + "\n");
  const modelAt = await createParentModelResolver([parent, child]).forSource(child);
  assert.equal(modelAt(at(11)), "gpt-5.6-luna");
  await writeFile(parent.path, "{}\n");
  await assert.rejects(
    createParentModelResolver([parent, child]).forSource(child),
    { code: "codex_rollout_source_changed" },
  );
});
