import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { commitLocalCollectorState } from "../src/local-collector-state.js";

async function captureRun(argv) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await run(argv);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("collector-state maintenance CLI is read-only and exposes a content-free retention plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-state-cli-"));
  const stateFile = join(root, "local-collector-state-v1.sqlite");
  try {
    await commitLocalCollectorState({
      stateFile,
      checkpoint: {},
      records: [
        {
          schemaVersion: "0.3",
          kind: "codex_tool_class_event",
          observedAt: "2026-08-01T00:00:00.000Z",
          eventKey: "old",
          toolClass: "other",
        },
        {
          schemaVersion: "0.3",
          kind: "codex_tool_class_event",
          observedAt: "2026-08-03T00:00:00.000Z",
          eventKey: "new",
          toolClass: "other",
        },
      ],
    });
    const status = JSON.parse(await captureRun([
      "collector-state-status",
      "--state-file", stateFile,
      "--json",
    ]));
    assert.equal(status.status, "available");
    assert.equal(status.recordCount, 2);
    const plan = JSON.parse(await captureRun([
      "plan-collector-retention",
      "--state-file", stateFile,
      "--before", "2026-08-02T00:00:00.000Z",
      "--json",
    ]));
    assert.equal(plan.action, "no_changes");
    assert.equal(plan.eligible.recordCount, 1);
    assert.equal(plan.retained.recordCount, 1);
    const after = JSON.parse(await captureRun([
      "collector-state-status",
      "--state-file", stateFile,
      "--json",
    ]));
    assert.equal(after.recordCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector-state retention parsing requires a canonical cutoff", async () => {
  await assert.rejects(
    () => run(["plan-collector-retention"]),
    /requires --before/u,
  );
});
