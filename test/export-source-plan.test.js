import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexExportSourcePlan,
  ExportSourcePlanError,
  openVerifiedCodexExportSource,
  resolveCodexExportSourcePlan,
  summarizeExportSourcePlan,
  verifyCodexExportSourcePlan,
  verifyCodexExportSourceHandle,
} from "../src/export-source-plan.js";
import { scanCodexSafeRecords } from "../src/export-safe-records.js";

async function fixture({ incompleteTail = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "usage-monitor-source-plan-"));
  await mkdir(join(home, "sessions", "2026", "07", "24"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const path = join(home, "sessions", "2026", "07", "24", "rollout-2026-07-24T12-00-00-source.jsonl");
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "private-session" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  await writeFile(path, `${lines.join("\n")}\n${incompleteTail ? "partial-private-content" : ""}`);
  return { home, path, complete: `${lines.join("\n")}\n` };
}

async function writeRollout(home, name, sessionId, timestamp) {
  const sessions = join(home, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const contents = `${JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: { id: sessionId },
  })}\n`;
  const path = join(sessions, name);
  await writeFile(path, contents);
  return { path, contents };
}

function safeFailure(code) {
  return (error) => {
    assert.equal(error instanceof ExportSourcePlanError, true);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("private-session"), false);
    return true;
  };
}

test("source plan rejects an incomplete trailing JSONL record", async () => {
  const value = await fixture({ incompleteTail: true });
  try {
    await assert.rejects(createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    }), safeFailure("export_source_codex_rollout_tail_incomplete"));
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("source plan freezes a complete source and allows later appends", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    assert.equal(plan.sources.length, 1);
    assert.equal(plan.sources[0].prefixBytes, Buffer.byteLength(value.complete));
    assert.deepEqual(summarizeExportSourcePlan(plan), {
      schemaVersion: "codex-export-source-plan-v2",
      sourcePlanSha256: plan.sourcePlanSha256,
      sourceFiles: 1,
      sourceBytes: Buffer.byteLength(value.complete),
    });
    await appendFile(value.path, "\n");
    await verifyCodexExportSourcePlan(plan);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("multi-root source plans contain the union once and ignore root input order", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-source-plan-roots-"));
  const first = join(root, "first");
  const second = join(root, "second");
  try {
    await writeRollout(
      first,
      "rollout-2026-07-24T12-00-00-first.jsonl",
      "10000000-0000-4000-8000-000000000001",
      "2026-07-24T12:00:00.000Z",
    );
    await writeRollout(
      second,
      "rollout-2026-07-24T12-05-00-second.jsonl",
      "10000000-0000-4000-8000-000000000002",
      "2026-07-24T12:05:00.000Z",
    );
    const options = {
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    };
    const forward = await createCodexExportSourcePlan({
      ...options,
      codexHomes: [first, second],
    });
    const reversed = await createCodexExportSourcePlan({
      ...options,
      codexHomes: [second, first],
    });
    assert.equal(forward.sources.length, 2);
    assert.deepEqual(
      forward.sources.map((source) => source.sourceKey),
      reversed.sources.map((source) => source.sourceKey),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source planning refuses unavailable roots and resume refuses a missing frozen source", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-source-plan-coverage-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const offline = join(root, "second-offline");
  const missing = join(root, "missing");
  const options = {
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
  };
  try {
    await writeRollout(
      first,
      "rollout-2026-07-24T12-00-00-first.jsonl",
      "10000000-0000-4000-8000-000000000011",
      "2026-07-24T12:00:00.000Z",
    );
    await writeRollout(
      second,
      "rollout-2026-07-24T12-05-00-second.jsonl",
      "10000000-0000-4000-8000-000000000012",
      "2026-07-24T12:05:00.000Z",
    );
    await assert.rejects(
      createCodexExportSourcePlan({ ...options, codexHomes: [missing] }),
      safeFailure("export_source_codex_rollout_roots_unavailable"),
    );
    await assert.rejects(
      createCodexExportSourcePlan({ ...options, codexHomes: [first, missing] }),
      safeFailure("export_source_codex_rollout_roots_unavailable"),
    );

    const plan = await createCodexExportSourcePlan({
      ...options,
      codexHomes: [first, second],
    });
    await rename(second, offline);
    await assert.rejects(
      resolveCodexExportSourcePlan(plan, { codexHomes: [first, second] }),
      safeFailure("export_source_source_missing"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical rollout replicas across roots enter a source plan once", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-source-plan-replicas-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const name = "rollout-2026-07-24T12-00-00-replica.jsonl";
  const sessionId = "10000000-0000-4000-8000-000000000003";
  try {
    await writeRollout(first, name, sessionId, "2026-07-24T12:00:00.000Z");
    await writeRollout(second, name, sessionId, "2026-07-24T12:00:00.000Z");
    const plan = await createCodexExportSourcePlan({
      codexHomes: [first, second],
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    assert.equal(plan.sources.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source plan detects prefix mutation and truncation with content-free errors", async () => {
  for (const mutation of [
    (value) => writeFile(value.path, value.complete.replace("private-session", "changed-session")),
    (value) => writeFile(value.path, "{}\n"),
  ]) {
    const value = await fixture();
    try {
      const plan = await createCodexExportSourcePlan({
        codexHome: value.home,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
      });
      await mutation(value);
      await assert.rejects(verifyCodexExportSourcePlan(plan), safeFailure("export_source_source_changed"));
    } finally {
      await rm(value.home, { recursive: true, force: true });
    }
  }
});

test("source plan resolves an archive move by privacy-safe source key", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    const moved = join(value.home, "archived_sessions", "rollout-2026-07-24T12-00-00-source.jsonl");
    await rename(value.path, moved);
    const resolved = await resolveCodexExportSourcePlan(plan, { codexHome: value.home });
    assert.equal(resolved.sources[0].path, moved);
    assert.equal(resolved.sourcePlanSha256, plan.sourcePlanSha256);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("plural source-plan resume accepts only a byte-proven replacement replica", async () => {
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-source-plan-resume-replica-",
  ));
  const first = join(root, "first");
  const second = join(root, "second");
  const name = "rollout-2026-07-24T12-00-00-resume-replica.jsonl";
  const sessionId = "10000000-0000-4000-8000-000000000004";
  try {
    await writeRollout(
      first,
      name,
      sessionId,
      "2026-07-24T12:00:00.000Z",
    );
    const replacement = await writeRollout(
      second,
      name,
      sessionId,
      "2026-07-24T12:00:00.000Z",
    );
    const plan = await createCodexExportSourcePlan({
      codexHome: first,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });

    await rm(first, { recursive: true, force: true });
    const resolved = await resolveCodexExportSourcePlan(plan, {
      codexHomes: [first, second],
    });
    assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.sources[0].path, replacement.path);
    assert.equal(resolved.sourcePlanSha256, plan.sourcePlanSha256);

    await writeFile(
      replacement.path,
      replacement.contents.replace(sessionId, "changed-private-session"),
    );
    await assert.rejects(
      resolveCodexExportSourcePlan(plan, {
        codexHomes: [first, second],
      }),
      safeFailure("export_source_source_changed"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe-record scanning ignores complete records appended beyond the frozen prefix", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    plan.sources[0].rolloutInfo.sourcePlanOrdinal = 0;
    await appendFile(value.path, `\n${JSON.stringify({
      timestamp: "2026-07-24T12:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
            output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11,
          },
        },
      },
    })}\n`);
    const records = [];
    await scanCodexSafeRecords({
      startAt: plan.startAt,
      endAt: plan.endAt,
      secret: Buffer.alloc(32, 7),
      rolloutInfos: plan.sources.map((source) => source.rolloutInfo),
      openRolloutSource(info) {
        return openVerifiedCodexExportSource(plan.sources[info.sourcePlanOrdinal]);
      },
      onRecord(record) {
        records.push(record);
      },
    });
    assert.deepEqual(records, []);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("source plan refuses a substituted symlink", async () => {
  const value = await fixture();
  const target = join(value.home, "target.jsonl");
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    await rename(value.path, target);
    await symlink(target, value.path);
    await assert.rejects(verifyCodexExportSourcePlan(plan), (error) => {
      assert.equal(error instanceof ExportSourcePlanError, true);
      assert.match(error.code, /^export_source_source_(?:type|changed)$/);
      return true;
    });
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("same-handle post-read verification detects an in-place prefix rewrite", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    plan.sources[0].rolloutInfo.sourcePlanOrdinal = 0;
    await assert.rejects(
      scanCodexSafeRecords({
        startAt: plan.startAt,
        endAt: plan.endAt,
        secret: Buffer.alloc(32, 7),
        rolloutInfos: plan.sources.map((source) => source.rolloutInfo),
        async openRolloutSource(info) {
          const handle = await openVerifiedCodexExportSource(plan.sources[info.sourcePlanOrdinal]);
          await writeFile(value.path, value.complete.replace("private-session", "changed-session"));
          return handle;
        },
        verifyRolloutSource(info, handle) {
          return verifyCodexExportSourceHandle(plan.sources[info.sourcePlanOrdinal], handle);
        },
        onRecord() {},
      }),
      safeFailure("export_source_source_changed"),
    );
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});
