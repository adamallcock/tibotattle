import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeClaudeStatusline } from "../src/claude-statusline.js";
import { writeClaudeStatusSnapshot } from "../src/claude-statusline-storage.js";
import {
  appendClaudeStatusWorkspaceSource,
  ClaudeStatusWorkspaceSourceError,
  createClaudeStatusWorkspaceSource,
} from "../src/claude-statusline-workspace-source.js";
import { createSupplementalSourcePlan } from "../src/export-supplemental-source-plan.js";
import { localExportSourcePipeline, localExportWorkspace } from
  "../src/local-node-runtime.js";

const { openExportWorkspace } = localExportWorkspace;
const { createLocalExportWorkspace, resumeLocalExportWorkspace } =
  localExportSourcePipeline.controller;

const SECRET = Buffer.alloc(32, 97);
const SESSION_SECRET = Buffer.alloc(32, 98);
const START = "2026-07-24T12:00:00.000Z";
const END = "2026-07-24T13:00:00.000Z";
const CANARY = "PRIVATE_CLAUDE_WORKSPACE_CANARY_account@example.com_/secret";

function status(capturedAt, usedPercent = 20) {
  return sanitizeClaudeStatusline({
    version: "2.1.176",
    model: { id: "claude-opus-4-20260701", display_name: CANARY },
    session_id: "private-claude-session",
    cwd: `/private/${CANARY}`,
    prompt: CANARY,
    account_id: CANARY,
    rate_limits: {
      five_hour: { used_percentage: usedPercent, resets_at: 1_774_608_000 },
      seven_day: { used_percentage: 40, resets_at: 1_775_212_800 },
    },
  }, capturedAt, { sessionSecret: SESSION_SECRET });
}

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "usage-monitor-claude-workspace-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const codexHome = join(root, "codex-home");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  return {
    root,
    codexHome,
    stateDirectory: join(root, "claude-state"),
    workspace: join(root, "workspace"),
  };
}

async function writeStatus(value, at, uuid, usedPercent = 20) {
  return writeClaudeStatusSnapshot(status(at, usedPercent), {
    stateDirectory: value.stateDirectory,
    uuid,
  });
}

async function controllerRun(value, options = {}) {
  return createLocalExportWorkspace({
    directory: value.workspace,
    startAt: START,
    endAt: END,
    createdAt: END,
    codexHome: value.codexHome,
    claudeStateDirectory: value.stateDirectory,
    secret: SECRET,
    ...options,
  });
}

async function claudeSnapshots(directory) {
  const workspace = await openExportWorkspace({ directory });
  try {
    return [...workspace.iterateRecords()]
      .filter((row) => row.record.provider === "anthropic_claude_code")
      .map((row) => row.record);
  } finally {
    workspace.close();
  }
}

test("Claude workspace planning rejects a second distinct Claude inventory", async () => {
  const value = await fixture();
  const secondStateDirectory = join(value.root, "claude-state-two");
  try {
    await writeStatus(value, "2026-07-24T12:01:00.000Z", "01000000-0000-4000-8000-000000000001");
    await writeClaudeStatusSnapshot(status("2026-07-24T12:02:00.000Z", 21), {
      stateDirectory: secondStateDirectory,
      uuid: "01000000-0000-4000-8000-000000000002",
    });
    const first = await createClaudeStatusWorkspaceSource({
      stateDirectory: value.stateDirectory,
      startAt: START,
      endAt: END,
      secret: SECRET,
    });
    const second = await createClaudeStatusWorkspaceSource({
      stateDirectory: secondStateDirectory,
      startAt: START,
      endAt: END,
      secret: SECRET,
    });
    assert.notEqual(first.source.sourceKey, second.source.sourceKey);
    const base = createSupplementalSourcePlan({ sources: [first.source] });
    assert.throws(
      () => appendClaudeStatusWorkspaceSource(base, second.claudePlan),
      (error) => error instanceof ClaudeStatusWorkspaceSourceError
        && error.code === "claude_status_workspace_source_configuration",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude workspace source freezes an opaque inventory, preserves physical occurrences, and is batch deterministic", async () => {
  const one = await fixture();
  const manyWorkspace = join(one.root, "workspace-many");
  try {
    const identical = status("2026-07-24T12:10:00.000Z", 33);
    await writeClaudeStatusSnapshot(identical, { stateDirectory: one.stateDirectory, uuid: "10000000-0000-4000-8000-000000000001" });
    await writeClaudeStatusSnapshot(identical, { stateDirectory: one.stateDirectory, uuid: "10000000-0000-4000-8000-000000000002" });
    const first = await controllerRun(one, { claudeRecordsPerBatch: 1 });
    const second = await createLocalExportWorkspace({
      directory: manyWorkspace,
      startAt: START,
      endAt: END,
      createdAt: END,
      codexHome: one.codexHome,
      claudeStateDirectory: one.stateDirectory,
      secret: SECRET,
      claudeRecordsPerBatch: 500,
    });
    assert.equal(first.status.scanComplete, true);
    assert.deepEqual(first.descriptor.sourceProviders, ["openai_codex", "anthropic_claude_code"]);
    const firstSnapshots = await claudeSnapshots(one.workspace);
    const secondSnapshots = await claudeSnapshots(manyWorkspace);
    assert.deepEqual(firstSnapshots, secondSnapshots);
    assert.equal(firstSnapshots.length, 4);
    assert.equal(new Set(firstSnapshots.map((record) => record.snapshotId)).size, 4);
    const workspace = await openExportWorkspace({ directory: one.workspace });
    try {
      const source = workspace.loadSupplementalSourcePlan().sources[0];
      assert.equal(source.kind, "claude_status_snapshot");
      assert.match(source.sourceKey, /^[a-f0-9]{64}$/);
      assert.equal(source.initialCursorJson.includes("claude-ledger-source"), false);
      assert.equal(source.initialCursorJson.includes(one.stateDirectory), false);
    } finally {
      workspace.close();
    }
    const publicText = JSON.stringify({ descriptor: first.descriptor, records: firstSnapshots });
    for (const forbidden of [CANARY, "private-claude-session", one.stateDirectory, "claude-ledger-source"]) {
      assert.equal(publicText.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(one.root, { recursive: true, force: true });
  }
});

test("Claude workspace checkpoints resume without full-inventory replay and ignore later appends", async () => {
  const value = await fixture();
  try {
    await writeStatus(value, "2026-07-24T12:01:00.000Z", "20000000-0000-4000-8000-000000000001", 10);
    await writeStatus(value, "2026-07-24T12:02:00.000Z", "20000000-0000-4000-8000-000000000002", 20);
    await writeStatus(value, "2026-07-24T12:03:00.000Z", "20000000-0000-4000-8000-000000000003", 30);
    const opened = [];
    let interrupted = false;
    await assert.rejects(controllerRun(value, {
      claudeRecordsPerBatch: 1,
      async failpoint(point, detail) {
        if (point === "before_record_open") opened.push(detail.recordIndex);
        if (point === "after_claude_status_checkpoint_batch" && !interrupted) {
          interrupted = true;
          throw new Error("Claude checkpoint interruption");
        }
      },
    }), /Claude checkpoint interruption/);
    await writeStatus(value, "2026-07-24T12:01:30.000Z", "20000000-0000-4000-8000-000000000004", 15);
    const resumed = await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.codexHome,
      claudeStateDirectory: value.stateDirectory,
      secret: SECRET,
      claudeRecordsPerBatch: 1,
      async failpoint(point, detail) {
        if (point === "before_record_open") opened.push(detail.recordIndex);
      },
    });
    assert.equal(resumed.status.scanComplete, true);
    assert.deepEqual(opened, [0, 1, 2]);
    assert.equal((await claudeSnapshots(value.workspace)).length, 6);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude selected record and directory mutations poison an incomplete workspace", async () => {
  const mutations = [
    async (value, record) => unlink(record.recordFile),
    async (value, record) => {
      const bytes = await (await import("node:fs/promises")).readFile(record.recordFile);
      await unlink(record.recordFile);
      await writeFile(record.recordFile, bytes, { mode: 0o600 });
    },
    async (value, record) => link(record.recordFile, join(value.root, "extra-link")),
    async (value) => {
      const records = join(value.stateDirectory, "records");
      await rename(records, join(value.root, "records-backup"));
      await mkdir(records, { mode: 0o700 });
    },
  ];
  for (const mutate of mutations) {
    const value = await fixture();
    try {
      await writeStatus(value, "2026-07-24T12:04:00.000Z", "30000000-0000-4000-8000-000000000001");
      const second = await writeStatus(value, "2026-07-24T12:05:00.000Z", "30000000-0000-4000-8000-000000000002");
      await assert.rejects(controllerRun(value, {
        claudeRecordsPerBatch: 1,
        async failpoint(point) {
          if (point === "after_claude_status_checkpoint_batch") throw new Error("pause");
        },
      }), /pause/);
      await mutate(value, second);
      await assert.rejects(resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.codexHome,
        claudeStateDirectory: value.stateDirectory,
        secret: SECRET,
      }));
      const workspace = await openExportWorkspace({ directory: value.workspace });
      try {
        assert.equal(workspace.isPoisoned(), true);
      } finally {
        workspace.close();
      }
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Claude committed-prefix mutation cannot alter committed output, while directory poisoning persists after restoration", async () => {
  const value = await fixture();
  try {
    const first = await writeStatus(value, "2026-07-24T12:07:00.000Z", "50000000-0000-4000-8000-000000000001", 11);
    await writeStatus(value, "2026-07-24T12:08:00.000Z", "50000000-0000-4000-8000-000000000002", 22);
    await assert.rejects(controllerRun(value, {
      claudeRecordsPerBatch: 1,
      async failpoint(point) {
        if (point === "after_claude_status_checkpoint_batch") throw new Error("pause");
      },
    }), /pause/);
    const committed = await claudeSnapshots(value.workspace);
    await unlink(first.recordFile);
    await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.codexHome,
      claudeStateDirectory: value.stateDirectory,
      secret: SECRET,
      claudeRecordsPerBatch: 1,
    });
    assert.deepEqual((await claudeSnapshots(value.workspace)).filter((record) => record.observedTime === "2026-07-24T12:07:00.000Z"), committed);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }

  const directoryCase = await fixture();
  try {
    await writeStatus(directoryCase, "2026-07-24T12:09:00.000Z", "50000000-0000-4000-8000-000000000003");
    await writeStatus(directoryCase, "2026-07-24T12:10:00.000Z", "50000000-0000-4000-8000-000000000004");
    await assert.rejects(controllerRun(directoryCase, {
      claudeRecordsPerBatch: 1,
      async failpoint(point) {
        if (point === "after_claude_status_checkpoint_batch") throw new Error("pause");
      },
    }), /pause/);
    const records = join(directoryCase.stateDirectory, "records");
    const backup = join(directoryCase.root, "records-backup");
    await rename(records, backup);
    await mkdir(records, { mode: 0o700 });
    await assert.rejects(resumeLocalExportWorkspace({
      directory: directoryCase.workspace,
      codexHome: directoryCase.codexHome,
      claudeStateDirectory: directoryCase.stateDirectory,
      secret: SECRET,
    }));
    await rm(records, { recursive: true, force: true });
    await rename(backup, records);
    await assert.rejects(resumeLocalExportWorkspace({
      directory: directoryCase.workspace,
      codexHome: directoryCase.codexHome,
      claudeStateDirectory: directoryCase.stateDirectory,
      secret: SECRET,
    }), (error) => error.code === "export_workspace_checkpoint_mismatch");
  } finally {
    await rm(directoryCase.root, { recursive: true, force: true });
  }
});

test("Claude selection and resume require the same explicit state-directory enablement", async () => {
  const value = await fixture();
  try {
    await writeStatus(value, "2026-07-24T12:06:00.000Z", "40000000-0000-4000-8000-000000000001");
    await assert.rejects(controllerRun(value, {
      claudeRecordsPerBatch: 1,
      async failpoint(point) {
        if (point === "after_claude_status_checkpoint_batch") throw new Error("pause");
      },
    }), /pause/);
    await assert.rejects(resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.codexHome,
      secret: SECRET,
    }), (error) => error.code === "export_workspace_checkpoint_mismatch");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
