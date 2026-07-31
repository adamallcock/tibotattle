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
