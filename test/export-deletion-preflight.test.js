import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import { combinedSourcePlanCommitment, materializeLocalExportSet } from "../src/export-set-materializer.js";
import {
  buildLocalExportDeletionPlan,
  ExportDeletionError,
  planLocalExportDeletion,
} from "../src/export-deletion.js";
import { validateExportDeletionJournal, validateExportDeletionPreflight } from "../src/export-deletion-schema.js";
import { openExportWorkspace } from "../src/export-workspace.js";

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

async function fixture({
  secret = Buffer.alloc(32, 71),
  suffix = "one",
  collectorContents = null,
  codexHome = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-delete-preflight-"));
  const home = codexHome ?? join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  const collectorPath = collectorContents === null ? null : join(root, "collector-ledger.jsonl");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const first = usage(suffix === "one" ? 10 : 20);
  await writeFile(join(home, "sessions", `rollout-2026-07-24T12-00-00-${suffix}.jsonl`), `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: `PRIVATE_SESSION_${suffix}`, prompt: `PRIVATE_PROMPT_${suffix}` },
    }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } },
    }),
  ].join("\n")}\n`);
  if (collectorPath !== null) await writeFile(collectorPath, collectorContents, { mode: 0o600 });
  await createLocalExportWorkspace({
    directory: workspace,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome: home,
    secret,
    ...(collectorPath === null ? {} : { collectorPath }),
  });
  await materializeLocalExportSet({ workspaceDirectory: workspace, outputDirectory: output, secret });
  return { root, home, workspace, output, collectorPath };
}

async function directorySnapshot(directory) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stats = await stat(path);
    if (!stats.isFile()) {
      result.push({ name, type: "other" });
      continue;
    }
    const bytes = await readFile(path);
    result.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: stats.mode & 0o777,
    });
  }
  return result;
}

test("deletion preflight is non-mutating, content-free, exact, and requires no secret", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.output, "unrelated-sibling.txt"), "preserve me", { mode: 0o600 });
    const beforeWorkspace = await directorySnapshot(value.workspace);
    const beforeOutput = await directorySnapshot(value.output);
    const plan = await buildLocalExportDeletionPlan({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
    });
    assert.equal(validateExportDeletionPreflight(plan.summary).valid, true);
    assert.equal(validateExportDeletionJournal(plan.journal).valid, true);
    assert.match(plan.summary.confirmationToken, /^[A-Z2-7]{16}$/);
    assert.equal(plan.summary.fileCounts.chunkArtifacts, 1);
    assert.equal(plan.summary.fileCounts.totalFiles, 5);
    assert.equal(plan.journal.inventory.length, 5);
    assert.equal(plan.paths.length, 5);
    const publicText = JSON.stringify(await planLocalExportDeletion({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
    }));
    for (const privateValue of [value.root, "PRIVATE_SESSION", "PRIVATE_PROMPT", "participant:v1:", "export-set:v1:"]) {
      assert.equal(publicText.includes(privateValue), false);
    }
    assert.deepEqual(await directorySnapshot(value.workspace), beforeWorkspace);
    assert.deepEqual(await directorySnapshot(value.output), beforeOutput);
    assert.equal(await readFile(join(value.output, "unrelated-sibling.txt"), "utf8"), "preserve me");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deletion preflight binds the workspace to the independently verified set", async () => {
  const first = await fixture({ secret: Buffer.alloc(32, 72), suffix: "first" });
  const second = await fixture({ secret: Buffer.alloc(32, 73), suffix: "second" });
  try {
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: first.workspace, outputDirectory: second.output }),
      (error) => error instanceof ExportDeletionError
        && error.code === "export_deletion_binding"
        && !error.message.includes(first.root)
        && !error.message.includes(second.root),
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("deletion preflight authenticates the materialized composite supplemental source commitment", async () => {
  const secret = Buffer.alloc(32, 74);
  const first = await fixture({ secret, suffix: "supplemental", collectorContents: "" });
  const second = await fixture({
    secret,
    suffix: "supplemental",
    collectorContents: "",
    codexHome: first.home,
  });
  try {
    const plan = await buildLocalExportDeletionPlan({
      workspaceDirectory: first.workspace,
      outputDirectory: first.output,
    });
    assert.equal(plan.summary.readiness, "ready");
    const firstWorkspace = await openExportWorkspace({ directory: first.workspace });
    const secondWorkspace = await openExportWorkspace({ directory: second.workspace });
    let firstDescriptor;
    let secondDescriptor;
    try {
      firstDescriptor = firstWorkspace.getDescriptor();
      secondDescriptor = secondWorkspace.getDescriptor();
    } finally {
      firstWorkspace.close();
      secondWorkspace.close();
    }
    const manifest = JSON.parse(await readFile(join(first.output, "export-set-manifest.json"), "utf8"));
    assert.equal(firstDescriptor.sourcePlan.sourcePlanSha256, secondDescriptor.sourcePlan.sourcePlanSha256);
    assert.notEqual(
      firstDescriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
      secondDescriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
    );
    assert.deepEqual(manifest.sourcePlan, combinedSourcePlanCommitment(firstDescriptor));
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: first.workspace, outputDirectory: second.output }),
      (error) => error instanceof ExportDeletionError && error.code === "export_deletion_binding",
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("deletion preflight rejects nested, symlinked, and unexpected workspace targets", async () => {
  const value = await fixture();
  try {
    const nested = join(value.workspace, "nested-output");
    await mkdir(nested, { mode: 0o700 });
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: nested }),
      (error) => error.code === "export_deletion_directory_relation",
    );
    await rm(nested, { recursive: true, force: true });

    const alias = join(value.root, "workspace-alias");
    await symlink(value.workspace, alias);
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: alias, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_directory",
    );

    await writeFile(join(value.workspace, "unexpected.txt"), "do not delete", { mode: 0o600 });
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_workspace_entries",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deletion preflight rejects unsafe modes and active deletion controls", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  try {
    await (await import("node:fs/promises")).chmod(value.output, 0o755);
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_directory",
    );
    await (await import("node:fs/promises")).chmod(value.output, 0o700);
    await writeFile(join(value.output, ".app-usagemonitor-deletion-journal.json"), "{}", { mode: 0o600 });
    await assert.rejects(
      planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
      (error) => error.code === "export_deletion_active_control",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("deletion preflight rejects an unsafe immediate parent for either target", async () => {
  if (process.platform === "win32") return;
  for (const unsafeTarget of ["workspace", "output"]) {
    const value = await fixture({ suffix: `parent-${unsafeTarget}` });
    try {
      const safeParent = join(value.root, `safe-${unsafeTarget === "workspace" ? "output" : "workspace"}-parent`);
      await mkdir(safeParent, { mode: 0o700 });
      const movedKey = unsafeTarget === "workspace" ? "output" : "workspace";
      const movedPath = join(safeParent, movedKey);
      await rename(value[movedKey], movedPath);
      value[movedKey] = movedPath;
      await chmod(value.root, 0o777);
      await assert.rejects(
        planLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output }),
        (error) => error.code === "export_deletion_directory",
      );
    } finally {
      await chmod(value.root, 0o700).catch(() => {});
      await rm(value.root, { recursive: true, force: true });
    }
  }
});
