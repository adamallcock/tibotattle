import test from "node:test";
import assert from "node:assert/strict";
import { classifySessionSurface } from "../src/providers/codex/logs.js";

test("classifies scheduled tasks and subagents without retaining raw session metadata", () => {
  assert.deepEqual(classifySessionSurface({
    id: "private-session-id-9e841",
    title: "Payroll notes /Users/private-user/Documents",
    source: { type: "scheduled", originator: "private-runner-token" },
    forked_from_id: "private-parent-id",
  }), {
    schemaVersion: "0.1",
    threadSource: "automation",
    surface: "scheduled_task",
    agentScope: "automation",
    lineageDisposition: "forked",
  });

  assert.deepEqual(classifySessionSurface({
    source: { type: "collaboration", client: { kind: "subagent" } },
    parent_thread_id: "secret-parent-thread",
  }), {
    schemaVersion: "0.1",
    threadSource: "subagent",
    surface: "subagent",
    agentScope: "subagent",
    lineageDisposition: "parent_linked",
  });
});

test("classifies structured IDE, CLI, and local-interactive metadata conservatively", () => {
  assert.equal(classifySessionSurface({ source: { client: { type: "vscode" } } }).surface, "extension_or_ide");
  assert.equal(classifySessionSurface({ origin: { type: "terminal" } }).surface, "cli_exec");
  const interactive = classifySessionSurface({ originator: "user" });
  assert.equal(interactive.surface, "local_interactive_unclassified");
  assert.equal(interactive.agentScope, "root");
  assert.equal(classifySessionSurface({}).surface, "local_rollout_unclassified");
  assert.equal(classifySessionSurface(null).threadSource, "unknown");
});

test("Codex 0.149.1 custom thread sources remain safe until their semantics are reviewed", () => {
  assert.deepEqual(classifySessionSurface({
    source: "exec",
    thread_source: "automated_review",
  }), {
    schemaVersion: "0.1",
    threadSource: "unknown",
    surface: "cli_exec",
    agentScope: "unknown",
    lineageDisposition: "standalone",
  });

  assert.deepEqual(classifySessionSurface({
    thread_source: "memory_consolidation",
  }), {
    schemaVersion: "0.1",
    threadSource: "unknown",
    surface: "local_rollout_unclassified",
    agentScope: "unknown",
    lineageDisposition: "standalone",
  });
});

test("never serializes private source, identifier, path, title, or nested metadata", () => {
  const privateValues = [
    "private-source-token-511",
    "private-originator-token-512",
    "/Users/secret-person/private/project",
    "private-session-id-513",
    "very private title 514",
    "private-parent-id-515",
  ];
  const result = classifySessionSurface({
    id: privateValues[3],
    title: privateValues[4],
    path: privateValues[2],
    source: {
      type: "vscode",
      name: privateValues[0],
      originator: privateValues[1],
      nested: { id: "private-nested-id-516" },
    },
    forked_from_id: privateValues[5],
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of privateValues) assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(Object.keys(result).sort(), ["agentScope", "lineageDisposition", "schemaVersion", "surface", "threadSource"]);
});

test("does not invoke malicious getters while reading structured source metadata", () => {
  const payload = { source: {} };
  Object.defineProperty(payload.source, "type", {
    enumerable: true,
    get() { throw new Error("must not execute metadata getter"); },
  });
  assert.deepEqual(classifySessionSurface(payload), {
    schemaVersion: "0.1",
    threadSource: "unknown",
    surface: "local_rollout_unclassified",
    agentScope: "unknown",
    lineageDisposition: "standalone",
  });
});

test("exact guardian markers classify auto-review independently of model, surface, scope and lineage", () => {
  for (const model of [undefined, "gpt-5.6-auto-review", "gpt-5.6-sol", "unknown-model"]) {
    for (const extra of [{}, { originator: "cli" }, { agent_scope: "subagent" },
      { originator: "scheduled", forked_from_id: "synthetic-parent" },
      { originator: "user", parent_thread_id: "synthetic-parent" }]) {
      const payload = {
        thread_source: "guardian_review",
        source: { subagent: { other: "guardian" } },
        model,
        ...extra,
      };
      const priorClassification = classifySessionSurface({
        ...payload, source: { subagent: { other: "unreviewed" } },
      });
      assert.deepEqual(classifySessionSurface(payload), {
        ...priorClassification, threadSource: "auto_review",
      });
    }
  }
});

test("auto-review requires both exact markers and never infers from near strings or model names", () => {
  for (const payload of [
    { thread_source: "guardian_review" },
    { source: { subagent: { other: "guardian" } } },
    { thread_source: "auto_review", source: { subagent: { other: "guardian" } } },
    { thread_source: "automated_review", source: { subagent: { other: "guardian" } } },
    { threadSource: "guardian_review", source: { subagent: { other: "guardian" } } },
    { thread_source: "guardian_review", source: { other: "guardian" } },
    ...["Guardian_review", " guardian_review", "guardian_review ", "guardian-review", null, 1]
      .map((thread_source) => ({ thread_source, source: { subagent: { other: "guardian" } } })),
    ...["Guardian", " guardian", "guardian ", "guardian_review", null, 1]
      .map((other) => ({ thread_source: "guardian_review", source: { subagent: { other } } })),
    { model: "gpt-5.6-auto-review", thread_source: "user" },
    { model: "gpt-5.6-auto-review", thread_source: "subagent" },
  ]) {
    assert.notEqual(classifySessionSurface(payload).threadSource, "auto_review");
  }
});

test("each auto-review marker and container must be an own data property", () => {
  for (const keyPath of [["thread_source"], ["source"], ["source", "subagent"],
    ["source", "subagent", "other"]]) {
    for (const kind of ["inherited", "accessor"]) {
      const payload = { thread_source: "guardian_review", source: { subagent: { other: "guardian" } } };
      let object = payload;
      for (const key of keyPath.slice(0, -1)) object = object[key];
      const key = keyPath.at(-1);
      const value = object[key];
      delete object[key];
      let getterCalls = 0;
      if (kind === "inherited") Object.setPrototypeOf(object, { [key]: value });
      else Object.defineProperty(object, key, {
        enumerable: true,
        get() { getterCalls += 1; return value; },
      });
      assert.notEqual(classifySessionSurface(payload).threadSource, "auto_review", `${kind} ${keyPath.join(".")}`);
      assert.equal(getterCalls, 0);
    }
  }
});
