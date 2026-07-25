import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import { materializeLocalExportSet } from "../src/export-set-materializer.js";
import { exportSetChunkBasenames } from "../src/export-set-schema.js";
import { buildLocalExportDeletionPlan, planLocalExportDeletion } from "../src/export-deletion.js";
import {
  deleteLocalExport,
  ExportDeletionExecutionError,
  recoverLocalExportDeletion,
} from "../src/export-deletion-executor.js";
import { stableJson } from "../src/storage.js";

const PRIVATE_CANARY = "PRIVATE_DELETE_EXECUTOR_CANARY";

function usage(tokens) {
  return {
    input_tokens: tokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: tokens + 1,
  };
}

async function fixture({ maximumRecordsPerChunk, includeSidecar = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-delete-executor-"));
  const home = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  const identityFile = join(root, "participant-secret-preserved");
  const collectorFile = join(root, "collector-state-preserved");
  const activityFile = join(root, "activity-markers-preserved");
  const reportFile = join(root, "report-preserved");
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-delete.jsonl");
  const secret = Buffer.alloc(32, 81);
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const first = usage(10);
  const second = usage(20);
  const sourceText = `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION", prompt: PRIVATE_CANARY },
    }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:03:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: second, last_token_usage: first } },
    }),
  ].join("\n")}\n`;
  await writeFile(source, sourceText);
  await writeFile(identityFile, "identity-state-preserved", { mode: 0o600 });
  await writeFile(collectorFile, "collector-state-preserved", { mode: 0o600 });
  await writeFile(activityFile, "activity-markers-preserved", { mode: 0o600 });
  await writeFile(reportFile, "report-preserved", { mode: 0o600 });
  await createLocalExportWorkspace({
    directory: workspace,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome: home,
    secret,
  });
  await materializeLocalExportSet({
    workspaceDirectory: workspace,
    outputDirectory: output,
    secret,
    ...(maximumRecordsPerChunk ? { maximumRecordsPerChunk } : {}),
  });
  if (includeSidecar) {
    await writeFile(join(workspace, "workspace.sqlite3-journal"), "closed-sidecar-preserved-until-delete", { mode: 0o600 });
  }
  await writeFile(join(output, "unrelated-sibling.txt"), "preserve sibling", { mode: 0o600 });
  const protectedFiles = [source, identityFile, collectorFile, activityFile, reportFile];
  const protectedBytes = new Map(await Promise.all(protectedFiles.map(async (path) => [path, await readFile(path)])));
  return {
    root, home, workspace, output, identityFile, collectorFile, activityFile, reportFile, source, protectedBytes,
  };
}

async function assertDeletedState(value) {
  assert.deepEqual(await readdir(value.workspace), []);
  assert.deepEqual((await readdir(value.output)).sort(), [
    "local-export-deletion-receipt.json",
    "unrelated-sibling.txt",
  ]);
  assert.equal(await readFile(value.source, "utf8").then((text) => text.includes(PRIVATE_CANARY)), true);
  assert.equal(await readFile(value.identityFile, "utf8"), "identity-state-preserved");
  assert.equal(await readFile(value.collectorFile, "utf8"), "collector-state-preserved");
  assert.equal(await readFile(value.activityFile, "utf8"), "activity-markers-preserved");
  assert.equal(await readFile(value.reportFile, "utf8"), "report-preserved");
  assert.equal(await readFile(join(value.output, "unrelated-sibling.txt"), "utf8"), "preserve sibling");
  for (const [path, expected] of value.protectedBytes) {
    assert.deepEqual(await readFile(path), expected);
  }
}

test("wrong confirmation token is non-mutating and creates no journal", async () => {
  const value = await fixture();
  try {
    const beforeWorkspace = (await readdir(value.workspace)).sort();
    const beforeOutput = (await readdir(value.output)).sort();
    await assert.rejects(
      deleteLocalExport({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        confirmationToken: "AAAAAAAAAAAAAAAA",
      }),
      (error) => error instanceof ExportDeletionExecutionError
        && error.code === "export_deletion_execute_confirmation",
    );
    assert.deepEqual((await readdir(value.workspace)).sort(), beforeWorkspace);
    assert.deepEqual((await readdir(value.output)).sort(), beforeOutput);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a formerly valid token becomes stale after byte-identical inode replacement", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    const artifact = join(value.output, exportSetChunkBasenames(0).bundle);
    const bytes = await readFile(artifact);
    await unlink(artifact);
    await writeFile(artifact, bytes, { mode: 0o600 });
    const next = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    assert.notEqual(next.confirmationToken, plan.confirmationToken);
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
    }), (error) => error.code === "export_deletion_execute_confirmation");
    assert.equal((await stat(artifact)).isFile(), true);
    assert.equal((await readdir(value.output)).includes(".app-usagemonitor-deletion-journal.json"), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("confirmed deletion removes only the exact export inventory and is recoverably idempotent", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    const receipt = await deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
    });
    assert.equal(receipt.logicalRemovalConfirmed, true);
    assert.equal(receipt.networkActivity, "absent");
    assert.equal(receipt.secureErasureClaimed, false);
    await assertDeletedState(value);
    assert.deepEqual(await recoverLocalExportDeletion({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
    }), receipt);
    await assertDeletedState(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deletion CLI is deliberately two-step and prints only content-free counts and claims", async () => {
  const value = await fixture();
  try {
    const command = resolve("src/cli.js");
    const baseArgs = [command, "delete-local-export", "--workspace", value.workspace, "--directory", value.output];
    const manifest = JSON.parse(await readFile(join(value.output, "export-set-manifest.json"), "utf8"));
    const forbidden = [
      value.root,
      PRIVATE_CANARY,
      "identity-state-preserved",
      "collector-state-preserved",
      "activity-markers-preserved",
      "report-preserved",
      manifest.exportSetId,
      manifest.participantId,
      manifest.chunks[0].bundleId,
      manifest.chunks[0].artifactSha256,
      "export-set-manifest.json",
      "chunk-000000.bundle.json.gz",
    ];
    const preview = execFileSync(process.execPath, baseArgs, { cwd: resolve("."), encoding: "utf8" });
    const token = preview.match(/Confirmation token: ([A-Z2-7]+)/)?.[1];
    assert.equal(typeof token, "string");
    assert.match(preview, /No files changed/);
    assert.match(preview, /Network activity: none; secure erasure: not claimed/);
    assert.match(preview, /Artifact class: complete_local_export_set/);
    for (const canary of forbidden) assert.equal(preview.includes(canary), false);
    assert.equal((await readdir(value.workspace)).includes("workspace.sqlite3"), true);

    const wrong = spawnSync(process.execPath, [...baseArgs, "--confirm-deletion", "AAAAAAAAAAAAAAAA"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /Local export deletion failed \(confirmation\)/);
    for (const canary of forbidden) assert.equal(`${wrong.stdout}${wrong.stderr}`.includes(canary), false);
    assert.equal((await readdir(value.workspace)).includes("workspace.sqlite3"), true);

    const completed = execFileSync(process.execPath, [
      ...baseArgs, "--confirm-deletion", token,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(completed, /Local export deletion: complete/);
    assert.match(completed, /Source logs preserved: true; local identity state preserved: true/);
    assert.match(completed, /Network activity: none; secure erasure: not claimed/);
    for (const canary of forbidden) assert.equal(completed.includes(canary), false);
    await assertDeletedState(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deletion CLI rejects missing required paths with fixed content-free errors", () => {
  for (const command of ["delete-local-export", "recover-local-export-deletion"]) {
    const result = spawnSync(process.execPath, [resolve("src/cli.js"), command], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${command} requires --workspace and --directory`));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(PRIVATE_CANARY), false);
  }
  const help = execFileSync(process.execPath, [resolve("src/cli.js"), "--help"], {
    cwd: resolve("."), encoding: "utf8",
  });
  assert.match(help, /delete-local-export --workspace PATH --directory PATH \[--confirm-deletion TOKEN\]/);
  assert.match(help, /recover-local-export-deletion --workspace PATH --directory PATH/);
});

test("recovery CLI resumes a committed deletion without printing paths or content", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause for CLI recovery");
      },
    }), /pause for CLI recovery/);
    const output = execFileSync(process.execPath, [
      resolve("src/cli.js"), "recover-local-export-deletion",
      "--workspace", value.workspace, "--directory", value.output,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(output, /Local export deletion recovery: complete/);
    assert.match(output, /Network activity: none; secure erasure: not claimed/);
    assert.equal(output.includes(value.root), false);
    assert.equal(output.includes(PRIVATE_CANARY), false);
    await assertDeletedState(value);
    const repeated = execFileSync(process.execPath, [
      resolve("src/cli.js"), "recover-local-export-deletion",
      "--workspace", value.workspace, "--directory", value.output,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(repeated, /Local export deletion recovery: complete/);
    assert.equal(repeated.includes(value.root), false);
    await assertDeletedState(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("committed deletion resumes across journal, inventory, receipt, and cleanup failpoints", async () => {
  const cases = [
    ["after_journal_commit", () => true],
    ["after_inventory_unlink", (detail) => detail.role === "set_manifest"],
    ["after_inventory_unlink", (detail) => detail.role === "workspace_database"],
    ["after_receipt_publish", () => true],
    ["after_journal_unlink", () => true],
  ];
  for (const [targetStage, targetDetail] of cases) {
    const value = await fixture();
    try {
      const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
      let failed = false;
      await assert.rejects(
        deleteLocalExport({
          workspaceDirectory: value.workspace,
          outputDirectory: value.output,
          confirmationToken: plan.confirmationToken,
          async failpoint(stage, detail) {
            if (!failed && stage === targetStage && targetDetail(detail)) {
              failed = true;
              throw new Error("simulated deletion crash");
            }
          },
        }),
        /simulated deletion crash/,
      );
      assert.equal(failed, true);
      const receipt = await recoverLocalExportDeletion({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
      });
      assert.equal(receipt.state, "complete");
      await assertDeletedState(value);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("SIGKILL recovery is monotonic across commit, each artifact class, receipt, and cleanup", async () => {
  const cases = [
    { stage: "after_journal_commit" },
    { stage: "after_inventory_unlink", role: "set_manifest", position: "first" },
    { stage: "after_inventory_quarantine", role: "chunk_artifact", position: "first" },
    { stage: "after_inventory_unlink", role: "chunk_artifact", position: "first" },
    { stage: "after_inventory_unlink", role: "chunk_artifact", position: "last" },
    { stage: "after_inventory_unlink", role: "workspace_database", position: "first" },
    { stage: "after_inventory_unlink", role: "chunk_receipt", position: "first" },
    { stage: "after_inventory_unlink", role: "chunk_receipt", position: "last" },
    { stage: "after_inventory_unlink", role: "set_manifest_receipt", position: "first" },
    { stage: "after_receipt_publish" },
    { stage: "after_journal_quarantine" },
    { stage: "after_journal_unlink" },
    { stage: "after_commit_marker_quarantine" },
    { stage: "after_commit_marker_unlink" },
  ];
  for (const { stage, role = "", position = "first" } of cases) {
    const value = await fixture({ maximumRecordsPerChunk: 1 });
    try {
      const plan = await buildLocalExportDeletionPlan({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
      });
      const matchingRows = role ? plan.journal.inventory.filter((row) => row.role === role) : [];
      if (role === "chunk_artifact" || role === "chunk_receipt") assert.ok(matchingRows.length >= 2);
      const target = position === "last" ? matchingRows.at(-1) : matchingRows[0];
      if (role) assert.ok(target, `missing ${role}`);
      const child = spawnSync(process.execPath, [
        resolve("scripts/export-deletion-sigkill-child.js"),
        "delete",
        value.workspace,
        value.output,
        plan.summary.confirmationToken,
        stage,
        role,
        target ? String(target.ordinal) : "",
      ], { cwd: resolve("."), encoding: "utf8", timeout: 30_000 });
      assert.equal(child.signal, "SIGKILL", `${stage}/${role}: ${child.stderr}`);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, "");
      const receipt = await recoverLocalExportDeletion({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
      });
      assert.equal(receipt.state, "complete");
      await assertDeletedState(value);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("SIGKILL recovery covers an authenticated closed SQLite sidecar", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause to add authenticated sidecar fixture");
      },
    }), /pause to add authenticated sidecar fixture/);

    const sidecarPath = join(value.workspace, "workspace.sqlite3-journal");
    await writeFile(sidecarPath, "closed-sqlite-sidecar", { mode: 0o600 });
    const sidecarStats = await stat(sidecarPath);
    const sidecarBytes = await readFile(sidecarPath);
    const journalPath = join(value.output, ".app-usagemonitor-deletion-journal.json");
    const markerPath = join(value.output, ".app-usagemonitor-deletion-commit.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const insertAt = journal.inventory.findIndex((row) => row.role === "workspace_database");
    journal.inventory.splice(insertAt, 0, {
      ordinal: insertAt,
      role: "workspace_sqlite_journal",
      chunkIndex: null,
      device: Number(sidecarStats.dev),
      inode: Number(sidecarStats.ino),
      fileType: "regular_file",
      linkCount: 1,
      byteSize: sidecarBytes.length,
      sha256: createHash("sha256").update(sidecarBytes).digest("hex"),
    });
    journal.inventory.forEach((row, ordinal) => { row.ordinal = ordinal; });
    journal.inventoryCounts.workspaceFiles += 1;
    journal.inventoryCounts.totalFiles += 1;
    journal.inventoryCounts.totalBytes += sidecarBytes.length;
    journal.planSha256 = createHash("sha256").update(`sidecar-fixture:${journal.planSha256}`).digest("hex");
    const journalText = stableJson(journal);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.planSha256 = journal.planSha256;
    marker.journalSha256 = createHash("sha256").update(journalText).digest("hex");
    await writeFile(journalPath, journalText, { mode: 0o600 });
    await writeFile(markerPath, stableJson(marker), { mode: 0o600 });

    const sidecarRow = journal.inventory.find((row) => row.role === "workspace_sqlite_journal");
    const child = spawnSync(process.execPath, [
      resolve("scripts/export-deletion-sigkill-child.js"),
      "recover",
      value.workspace,
      value.output,
      "",
      "after_inventory_unlink",
      sidecarRow.role,
      String(sidecarRow.ordinal),
    ], { cwd: resolve("."), encoding: "utf8", timeout: 30_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const receipt = await recoverLocalExportDeletion({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
    });
    assert.equal(receipt.state, "complete");
    await assertDeletedState(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("atomic quarantine preserves a replacement introduced at the move boundary", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    const artifact = join(value.output, exportSetChunkBasenames(0).bundle);
    let swapped = false;
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async moveFile(source, destination) {
        if (!swapped && source.endsWith(`/${exportSetChunkBasenames(0).bundle}`)) {
          swapped = true;
          await unlink(source);
          await writeFile(source, "replacement survives quarantine", { mode: 0o600 });
        }
        await rename(source, destination);
      },
    }), (error) => error.code === "export_deletion_execute_replacement");
    assert.equal(swapped, true);
    const quarantine = (await readdir(value.output))
      .find((name) => name.startsWith(".app-usagemonitor-deletion-quarantine-0001-"));
    assert.equal(typeof quarantine, "string");
    assert.equal(await readFile(join(value.output, quarantine), "utf8"), "replacement survives quarantine");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("recovery rejects a renamed directory replacement even when controls are copied into it", async () => {
  const value = await fixture();
  const originalOutput = `${value.output}-original`;
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause before directory replacement");
      },
    }), /pause before directory replacement/);
    await rename(value.output, originalOutput);
    await mkdir(value.output, { mode: 0o700 });
    for (const name of [
      ".app-usagemonitor-deletion-journal.json",
      ".app-usagemonitor-deletion-commit.json",
    ]) {
      await copyFile(join(originalOutput, name), join(value.output, name));
    }
    await assert.rejects(
      recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_execute_replacement",
    );
    assert.equal((await stat(join(originalOutput, "export-set-manifest.json"))).isFile(), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("recovery never creates a missing workspace", async () => {
  const value = await fixture();
  const missing = join(value.root, "mistyped-workspace");
  try {
    await assert.rejects(recoverLocalExportDeletion({
      workspaceDirectory: missing,
      outputDirectory: value.output,
    }), /Local export workspace lock failed \(invalid\)/);
    await assert.rejects(stat(missing), (error) => error.code === "ENOENT");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("receipt-only recovery refuses a live export even when a valid receipt was copied in", async () => {
  const completed = await fixture();
  const live = await fixture();
  try {
    const plan = await planLocalExportDeletion({
      workspaceDirectory: completed.workspace,
      outputDirectory: completed.output,
    });
    await deleteLocalExport({
      workspaceDirectory: completed.workspace,
      outputDirectory: completed.output,
      confirmationToken: plan.confirmationToken,
    });
    await copyFile(
      join(completed.output, "local-export-deletion-receipt.json"),
      join(live.output, "local-export-deletion-receipt.json"),
    );
    await assert.rejects(
      recoverLocalExportDeletion({ workspaceDirectory: live.workspace, outputDirectory: live.output }),
      (error) => error.code === "export_deletion_execute_receipt_invalid",
    );
    assert.equal((await stat(join(live.output, "export-set-manifest.json"))).isFile(), true);
    assert.equal((await stat(join(live.workspace, "workspace.sqlite3"))).isFile(), true);
  } finally {
    await rm(completed.root, { recursive: true, force: true });
    await rm(live.root, { recursive: true, force: true });
  }
});

test("recovery refuses a replaced artifact without deleting the replacement", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause after commit");
      },
    }), /pause after commit/);
    const artifact = join(value.output, exportSetChunkBasenames(0).bundle);
    await unlink(artifact);
    await writeFile(artifact, "replacement must survive", { mode: 0o600 });
    await assert.rejects(
      recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_execute_replacement",
    );
    assert.equal(await readFile(artifact, "utf8"), "replacement must survive");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("recovery rejects a mutated durable journal before deleting any inventory row", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause before journal mutation");
      },
    }), /pause before journal mutation/);
    const journalPath = join(value.output, ".app-usagemonitor-deletion-journal.json");
    const original = await readFile(journalPath, "utf8");
    await writeFile(journalPath, `${original}\n`, { mode: 0o600 });
    await assert.rejects(
      recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_execute_journal_invalid",
    );
    assert.equal((await stat(join(value.output, "export-set-manifest.json"))).isFile(), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("durable deletion controls and final receipt exclude paths, pseudonyms, identifiers, and content", async () => {
  const value = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(value.output, "export-set-manifest.json"), "utf8"));
    const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("pause for privacy scan");
      },
    }), /pause for privacy scan/);
    const controls = `${await readFile(join(value.output, ".app-usagemonitor-deletion-journal.json"), "utf8")}
${await readFile(join(value.output, ".app-usagemonitor-deletion-commit.json"), "utf8")}`;
    const forbidden = [
      value.root,
      "PRIVATE_SESSION",
      PRIVATE_CANARY,
      "identity-state-preserved",
      manifest.participantId,
      manifest.exportSetId,
      manifest.chunks[0].bundleId,
      "export-set-manifest.json",
      exportSetChunkBasenames(0).bundle,
    ];
    for (const canary of forbidden) assert.equal(controls.includes(canary), false);
    await recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    const receipt = await readFile(join(value.output, "local-export-deletion-receipt.json"), "utf8");
    for (const canary of forbidden) assert.equal(receipt.includes(canary), false);
    assert.equal(receipt.includes("sha256"), false);
    await assertDeletedState(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("production deletion modules contain no recursive removal primitive", async () => {
  for (const path of [resolve("src/export-deletion.js"), resolve("src/export-deletion-executor.js")]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /\brm\s*\(/);
    assert.doesNotMatch(source, /\brmdir\s*\(/);
    assert.doesNotMatch(source, /recursive\s*:/);
  }
});

test("recovery refuses symlink and hardlink substitutions without removing their targets", async () => {
  for (const kind of ["symlink", "hardlink"]) {
    const value = await fixture();
    try {
      const plan = await planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
      await assert.rejects(deleteLocalExport({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        confirmationToken: plan.confirmationToken,
        async failpoint(stage) {
          if (stage === "after_journal_commit") throw new Error("pause after commit");
        },
      }), /pause after commit/);
      const artifact = join(value.output, exportSetChunkBasenames(0).bundle);
      const foreign = join(value.root, `${kind}-target`);
      await writeFile(foreign, "foreign survives", { mode: 0o600 });
      await unlink(artifact);
      if (kind === "symlink") await symlink(foreign, artifact);
      else await link(foreign, artifact);
      await assert.rejects(
        recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
        (error) => error.code === "export_deletion_execute_replacement",
      );
      assert.equal(await readFile(foreign, "utf8"), "foreign survives");
      assert.equal((await stat(foreign)).isFile(), true);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});
