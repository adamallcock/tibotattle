import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  inspectExportWorkspaceDiscardState,
  openExportWorkspace,
} from "../src/export-workspace.js";
import {
  buildLocalExportWorkspaceDiscardPlan,
  ExportWorkspaceDiscardError,
  planLocalExportWorkspaceDiscard,
} from "../src/export-workspace-discard.js";
import {
  discardLocalExportWorkspace,
  ExportWorkspaceDiscardExecutionError,
  recoverLocalExportWorkspaceDiscard,
} from "../src/export-workspace-discard-executor.js";
import {
  validateExportWorkspaceDiscardCommitMarker,
  validateExportWorkspaceDiscardJournal,
  validateExportWorkspaceDiscardPreflight,
  validateExportWorkspaceDiscardReceipt,
} from "../src/export-workspace-discard-schema.js";
import { stableJson } from "../src/storage.js";

const PRIVATE_PROMPT = "PRIVATE_WORKSPACE_DISCARD_PROMPT";
const PRIVATE_SESSION = "PRIVATE_WORKSPACE_DISCARD_SESSION";
const SECRET = Buffer.alloc(32, 101);

async function fixture({ poison = false, sidecars = [], complete = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-workspace-discard-"));
  const home = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "independent-output");
  const identity = join(root, "identity-state");
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-discard.jsonl");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  await writeFile(source, `${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: PRIVATE_SESSION, prompt: PRIVATE_PROMPT },
  })}\n`);
  await writeFile(join(output, "published-artifact.json"), "independent-output-preserved", { mode: 0o600 });
  await writeFile(identity, "identity-preserved", { mode: 0o600 });
  const sourcePlan = await createCodexExportSourcePlan({
    codexHome: home,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
  });
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET),
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: sourcePlan.startAt, endAt: sourcePlan.endAt },
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    activityPlan: {
      recordCount: 0,
      recordsSha256: createHash("sha256")
        .update("app-usagemonitor/export-activity-plan/v1\0").update("[]").digest("hex"),
    },
  });
  let api;
  if (complete) {
    await createLocalExportWorkspace({
      directory: workspace,
      startAt: sourcePlan.startAt,
      endAt: sourcePlan.endAt,
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: home,
      secret: SECRET,
    });
    api = await openExportWorkspace({ directory: workspace });
  } else {
    api = await createExportWorkspace({ directory: workspace, descriptor, sourcePlan });
  }
  if (poison) api.markPoisoned("source_integrity");
  api.close();
  for (const sidecar of sidecars) {
    // A zeroed rollback journal is closed/inactive and must not change the
    // narrow database state inspected by the discard preflight.
    const bytes = sidecar === "journal" ? Buffer.alloc(512) : Buffer.from(`closed-${sidecar}-sidecar`);
    await writeFile(join(workspace, `workspace.sqlite3-${sidecar}`), bytes, { mode: 0o600 });
  }
  return {
    root, home, workspace, output, identity, source, descriptor, sourcePlan,
    protected: new Map(await Promise.all([source, identity, join(output, "published-artifact.json")]
      .map(async (path) => [path, await readFile(path)]))),
  };
}

async function snapshot(directory) {
  const rows = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stats = await stat(path);
    rows.push({ name, size: stats.size, digest: createHash("sha256").update(await readFile(path)).digest("hex") });
  }
  return rows;
}

async function assertDiscarded(value) {
  assert.deepEqual(await readdir(value.workspace), ["workspace-discard-receipt.json"]);
  for (const [path, bytes] of value.protected) assert.deepEqual(await readFile(path), bytes);
  const receipt = JSON.parse(await readFile(join(value.workspace, "workspace-discard-receipt.json"), "utf8"));
  assert.equal(validateExportWorkspaceDiscardReceipt(receipt).valid, true);
  assert.equal(receipt.independentOutputPreserved, true);
}

test("workspace discard preflight is non-mutating, secret-free, path-free, and exactly bounded", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  try {
    const before = await snapshot(value.workspace);
    const plan = await buildLocalExportWorkspaceDiscardPlan({ workspaceDirectory: value.workspace });
    assert.equal(validateExportWorkspaceDiscardPreflight(plan.summary).valid, true);
    assert.equal(validateExportWorkspaceDiscardJournal(plan.journal).valid, true);
    assert.match(plan.summary.confirmationToken, /^[A-Z2-7]{16}$/);
    assert.match(plan.journal.planToken, /^[A-Z2-7]{20}$/);
    assert.deepEqual(plan.journal.inventory.map((row) => row.role), [
      "workspace_sqlite_journal", "workspace_database",
    ]);
    assert.equal(plan.summary.fileCounts.totalFiles, 2);
    const publicText = JSON.stringify({ summary: plan.summary, journal: plan.journal });
    for (const canary of [
      value.root, PRIVATE_PROMPT, PRIVATE_SESSION, "participant:v1:", "source_path",
      "sha256", "inode", "device", "digest", "modifiedMs",
    ]) {
      assert.equal(publicText.includes(canary), false);
    }
    assert.deepEqual(await snapshot(value.workspace), before);
    assert.deepEqual(await inspectExportWorkspaceDiscardState({ directory: value.workspace }), {
      poisoned: false, scanComplete: false, hasManifestState: false, chunkCount: 0,
    });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("workspace discard refuses complete, manifested, chunked, unexpected, symlink, and hardlink workspaces", async () => {
  const complete = await fixture({ complete: true });
  const manifested = await fixture();
  const chunked = await fixture();
  const unexpected = await fixture();
  const linked = await fixture();
  const unsafeParent = await fixture();
  try {
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: complete.workspace }),
      (error) => error instanceof ExportWorkspaceDiscardError && error.code === "export_workspace_discard_workspace_state");

    let api = await openExportWorkspace({ directory: manifested.workspace });
    api.markManifestComplete({ private: "not exported" });
    api.close();
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: manifested.workspace }),
      (error) => error.code === "export_workspace_discard_manifest_state");

    api = await openExportWorkspace({ directory: chunked.workspace });
    api.recordChunk(0, "planned", { private: "not exported" });
    api.close();
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: chunked.workspace }),
      (error) => error.code === "export_workspace_discard_chunks_present");

    await writeFile(join(unexpected.workspace, "unrelated.txt"), "preserve", { mode: 0o600 });
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: unexpected.workspace }),
      (error) => error.code === "export_workspace_discard_workspace_entries");

    const alias = join(linked.root, "workspace-alias");
    await symlink(linked.workspace, alias);
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: alias }),
      (error) => error.code === "export_workspace_discard_directory");
    const database = join(linked.workspace, "workspace.sqlite3");
    await link(database, join(linked.root, "database-hardlink"));
    await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: linked.workspace }),
      (error) => error.code === "export_workspace_discard_artifact_links");

    if (process.platform !== "win32") {
      await chmod(unsafeParent.root, 0o777);
      await assert.rejects(planLocalExportWorkspaceDiscard({ workspaceDirectory: unsafeParent.workspace }),
        (error) => error.code === "export_workspace_discard_directory");
      await chmod(unsafeParent.root, 0o700);
    }
  } finally {
    await chmod(unsafeParent.root, 0o700).catch(() => {});
    await Promise.all([complete, manifested, chunked, unexpected, linked, unsafeParent]
      .map((value) => rm(value.root, { recursive: true, force: true })));
  }
});

test("wrong and stale confirmation tokens mutate nothing", async () => {
  const value = await fixture();
  try {
    const before = await snapshot(value.workspace);
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: "AAAAAAAAAAAAAAAA",
    }), (error) => error instanceof ExportWorkspaceDiscardExecutionError
      && error.code === "export_workspace_discard_execute_confirmation");
    assert.deepEqual(await snapshot(value.workspace), before);

    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    const database = join(value.workspace, "workspace.sqlite3");
    const replacement = join(value.root, "replacement.sqlite3");
    await copyFile(database, replacement);
    await unlink(database);
    await rename(replacement, database);
    const next = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    assert.notEqual(next.confirmationToken, plan.confirmationToken);
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.confirmationToken,
    }), (error) => error.code === "export_workspace_discard_execute_confirmation");
    assert.equal((await stat(database)).isFile(), true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("confirmed workspace discard removes only fixed workspace storage and is idempotently recoverable", async () => {
  for (const poison of [false, true]) {
    const value = await fixture({ poison, sidecars: ["journal"] });
    try {
      const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
      assert.equal(plan.eligibility, poison ? "poisoned" : "scan_incomplete");
      const receipt = await discardLocalExportWorkspace({
        workspaceDirectory: value.workspace,
        confirmationToken: plan.confirmationToken,
      });
      assert.equal(receipt.logicalRemovalConfirmed, true);
      await assertDiscarded(value);
      assert.deepEqual(await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace }), receipt);
      await assertDiscarded(value);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("committed discard recovers monotonically across every artifact and control boundary", async () => {
  const cases = [
    ["after_journal_commit", () => true],
    ["after_inventory_quarantine", (detail) => detail.role === "workspace_sqlite_journal"],
    ["after_inventory_unlink", (detail) => detail.role === "workspace_sqlite_journal"],
    ["after_inventory_quarantine", (detail) => detail.role === "workspace_database"],
    ["after_quarantine_link", (detail) => detail.role === "workspace_database"],
    ["after_inventory_unlink", (detail) => detail.role === "workspace_database"],
    ["after_receipt_publish", () => true],
    ["after_quarantine_link", (detail) => detail?.control === "journal"],
    ["after_journal_quarantine", () => true],
    ["after_journal_unlink", () => true],
    ["after_quarantine_link", (detail) => detail?.control === "commit_marker"],
    ["after_commit_marker_quarantine", () => true],
    ["after_commit_marker_unlink", () => true],
  ];
  for (const [target, predicate] of cases) {
    const value = await fixture({ sidecars: ["journal"] });
    try {
      const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
      let tripped = false;
      await assert.rejects(discardLocalExportWorkspace({
        workspaceDirectory: value.workspace,
        confirmationToken: plan.confirmationToken,
        async failpoint(stage, detail) {
          if (!tripped && stage === target && predicate(detail)) {
            tripped = true;
            throw new Error("simulated process death");
          }
        },
      }), /simulated process death/);
      assert.equal(tripped, true);
      await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
      await assertDiscarded(value);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("a crash after journal preparation aborts safely without authorizing deletion", async () => {
  const value = await fixture();
  try {
    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    const database = join(value.workspace, "workspace.sqlite3");
    const before = await readFile(database);
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_prepare") throw new Error("crash before commit marker");
      },
    }), /crash before commit marker/);
    assert.equal((await stat(join(value.workspace, ".app-usagemonitor-workspace-discard-journal.json"))).isFile(), true);
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace }),
      (error) => error.code === "export_workspace_discard_execute_journal_missing");
    assert.deepEqual(await readFile(database), before);
    assert.equal((await readdir(value.workspace)).includes(".app-usagemonitor-workspace-discard-journal.json"), false);
    assert.equal((await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace })).readiness, "ready");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("SIGKILL after the committed marker leaves a recoverable durable workspace", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  let child;
  try {
    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    child = fork(resolve("test/support/export-workspace-discard-sigkill-child.mjs"), [
      value.workspace,
      plan.confirmationToken,
    ], { cwd: resolve("."), stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("discard child did not reach committed state")), 10_000);
      child.once("message", (message) => {
        clearTimeout(timer);
        if (message?.type === "committed") resolveReady();
        else rejectReady(new Error("discard child sent an invalid handshake"));
      });
      child.once("error", rejectReady);
      child.once("exit", (code, signal) => {
        if (signal !== "SIGKILL") rejectReady(new Error(`discard child exited before kill (${code}/${signal})`));
      });
    });
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
    assert.equal((await readdir(value.workspace)).includes(".app-usagemonitor-workspace-discard-journal.json"), true);
    assert.equal((await readdir(value.workspace)).includes(".app-usagemonitor-workspace-discard-commit.json"), true);
    await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    await assertDiscarded(value);
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("receipt and control filesystem failures recover after explicit local transient-lock cleanup", async () => {
  const cases = [
    {
      label: "receipt publication",
      shouldMakeReadOnly: (stage, detail) => stage === "after_inventory_unlink" && detail?.ordinal === 1,
    },
    {
      label: "journal durable unlink",
      shouldMakeReadOnly: (stage) => stage === "after_journal_quarantine",
    },
    {
      label: "marker durable unlink",
      shouldMakeReadOnly: (stage) => stage === "after_commit_marker_quarantine",
    },
  ];
  for (const { label, shouldMakeReadOnly } of cases) {
    const value = await fixture({ sidecars: ["journal"] });
    try {
      const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
      await assert.rejects(discardLocalExportWorkspace({
        workspaceDirectory: value.workspace,
        confirmationToken: plan.confirmationToken,
        async failpoint(stage, detail) {
          if (shouldMakeReadOnly(stage, detail)) await chmod(value.workspace, 0o500);
        },
      }), (error) => error.code === "export_workspace_discard_execute_replacement"
        && !error.message.includes(value.workspace));
      const interruptedEntries = await readdir(value.workspace);
      assert.equal(interruptedEntries.includes(".app-usagemonitor-export-workspace.lock"), true, label);
      if (label === "receipt publication") {
        assert.equal(interruptedEntries.includes("workspace-discard-receipt.json"), false, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-journal.json"), true, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-commit.json"), true, label);
        assert.equal(interruptedEntries.includes("workspace.sqlite3"), false, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-quarantine-01"), false, label);
      } else if (label === "journal durable unlink") {
        assert.equal(interruptedEntries.includes("workspace-discard-receipt.json"), true, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-quarantine-journal"), true, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-commit.json"), true, label);
      } else {
        assert.equal(interruptedEntries.includes("workspace-discard-receipt.json"), true, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-journal.json"), false, label);
        assert.equal(interruptedEntries.includes(".app-usagemonitor-workspace-discard-quarantine-commit"), true, label);
      }
      await chmod(value.workspace, 0o700);
      // The forced permissions failure also prevents the lease's final lock
      // cleanup. This test explicitly performs local transient-lock cleanup;
      // it is not evidence of autonomous stale-lock recovery.
      await unlink(join(value.workspace, ".app-usagemonitor-export-workspace.lock")).catch(() => {});
      await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
      await assertDiscarded(value);
    } finally {
      await chmod(value.workspace, 0o700).catch(() => {});
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("recovery rejects a canonical evidence-token mutation in the durable journal", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  try {
    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("retain journal");
      },
    }), /retain journal/);
    const database = join(value.workspace, "workspace.sqlite3");
    const before = await readFile(database);
    const journalPath = join(value.workspace, ".app-usagemonitor-workspace-discard-journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.inventory[0].evidenceToken = "Z".repeat(52);
    await writeFile(journalPath, stableJson(journal), { mode: 0o600 });
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace }),
      (error) => [
        "export_workspace_discard_execute_journal_invalid",
        "export_workspace_discard_execute_commit_invalid",
      ].includes(error.code));
    assert.deepEqual(await readFile(database), before);
    assert.equal((await stat(join(value.workspace, "workspace.sqlite3-journal"))).isFile(), true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("recovery refuses a same-size database replacement after a sidecar was durably removed", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  try {
    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage, detail) {
        if (stage === "after_inventory_unlink" && detail.role === "workspace_sqlite_journal") {
          throw new Error("crash after sidecar removal");
        }
      },
    }), /crash after sidecar removal/);
    const database = join(value.workspace, "workspace.sqlite3");
    const bytes = await readFile(database);
    const replacement = join(value.root, "same-size-replacement.sqlite3");
    await writeFile(replacement, bytes, { mode: 0o600 });
    await unlink(database);
    await rename(replacement, database);
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace }),
      (error) => error.code === "export_workspace_discard_execute_replacement");
    assert.deepEqual(await readFile(database), bytes);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("recovery rejects unexpected entries in paired and marker-only committed states", async () => {
  const paired = await fixture();
  const markerOnly = await fixture();
  try {
    const pairedPlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: paired.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: paired.workspace,
      confirmationToken: pairedPlan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("retain paired controls");
      },
    }), /retain paired controls/);
    await writeFile(join(paired.workspace, "unexpected-control-adjacent-file"), "preserve", { mode: 0o600 });
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: paired.workspace }),
      (error) => error.code === "export_workspace_discard_execute_receipt_invalid");
    assert.equal((await stat(join(paired.workspace, "workspace.sqlite3"))).isFile(), true);

    const markerPlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: markerOnly.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: markerOnly.workspace,
      confirmationToken: markerPlan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_unlink") throw new Error("retain marker and receipt");
      },
    }), /retain marker and receipt/);
    await writeFile(join(markerOnly.workspace, "workspace.sqlite3"), "foreign-live-artifact", { mode: 0o600 });
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: markerOnly.workspace }),
      (error) => error.code === "export_workspace_discard_execute_receipt_invalid");
    assert.equal((await stat(join(markerOnly.workspace, ".app-usagemonitor-workspace-discard-commit.json"))).isFile(), true);
    assert.equal((await stat(join(markerOnly.workspace, "workspace.sqlite3"))).isFile(), true);
  } finally {
    await rm(paired.root, { recursive: true, force: true });
    await rm(markerOnly.root, { recursive: true, force: true });
  }
});

test("recovery refuses and preserves a foreign export transaction root", async () => {
  const value = await fixture();
  try {
    const transactionRoot = join(value.workspace, ".app-usagemonitor-export-transactions");
    const foreignDirectory = join(transactionRoot, "foreign-transaction");
    const canary = join(foreignDirectory, "PRIVATE_FOREIGN_TRANSACTION_CANARY");
    await mkdir(foreignDirectory, { recursive: true, mode: 0o700 });
    await writeFile(canary, "foreign-transaction-preserved", { mode: 0o600 });
    const beforeEntries = await readdir(transactionRoot);
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace }),
      (error) => error.code === "export_workspace_discard_execute_foreign_transaction"
        && !error.message.includes(value.root));
    assert.deepEqual(await readdir(transactionRoot), beforeEntries);
    assert.equal(await readFile(canary, "utf8"), "foreign-transaction-preserved");
    assert.equal((await stat(join(value.workspace, "workspace.sqlite3"))).isFile(), true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("WAL-backed poisoned eligibility remains authorized after sidecars are removed", async () => {
  const value = await fixture({ complete: true });
  try {
    const databasePath = join(value.workspace, "workspace.sqlite3");
    const child = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      process.umask(0o077);
      const database = new DatabaseSync(process.argv[1]);
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      const poison = JSON.stringify({ code: "source_integrity" }, null, 2) + "\\n";
      database.prepare("INSERT OR REPLACE INTO workspace_meta(key, value_json) VALUES ('poison', ?)").run(poison);
      process.kill(process.pid, "SIGKILL");
    `, databasePath], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    for (const suffix of ["wal", "shm"]) await chmod(`${databasePath}-${suffix}`, 0o600);

    const immutable = new DatabaseSync(`${pathToFileURL(databasePath).href}?immutable=1`, { readOnly: true });
    try {
      assert.equal(Number(immutable.prepare("SELECT COUNT(*) AS count FROM workspace_meta WHERE key = 'poison'").get().count), 0);
    } finally { immutable.close(); }

    const plan = await buildLocalExportWorkspaceDiscardPlan({ workspaceDirectory: value.workspace });
    assert.equal(plan.summary.eligibility, "poisoned");
    const sidecars = plan.journal.inventory.filter((row) => row.role !== "workspace_database");
    assert.ok(sidecars.some((row) => row.role === "workspace_sqlite_wal"));
    const lastSidecar = sidecars.at(-1).role;
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.summary.confirmationToken,
      async failpoint(stage, detail) {
        if (stage === "after_inventory_unlink" && detail.role === lastSidecar) {
          throw new Error("crash after WAL-backed authorization sidecars");
        }
      },
    }), /crash after WAL-backed authorization sidecars/);
    await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    await assertDiscarded(value);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("no-replace quarantine preserves a destination created in the link gap", async () => {
  const attacked = await fixture();
  try {
    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: attacked.workspace });
    let injected = false;
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: attacked.workspace,
      confirmationToken: plan.confirmationToken,
      async linkFile(from, to) {
        if (!injected && to.endsWith("-00")) {
          injected = true;
          await writeFile(to, "unrelated-gap-winner", { mode: 0o600 });
        }
        await link(from, to);
      },
    }), (error) => error.code === "export_workspace_discard_execute_replacement");
    assert.equal(injected, true);
    assert.equal(await readFile(join(attacked.workspace, ".app-usagemonitor-workspace-discard-quarantine-00"), "utf8"), "unrelated-gap-winner");
  } finally {
    await rm(attacked.root, { recursive: true, force: true });
  }
});

test("copied receipt, copied controls, and missing-workspace recovery are refused", async () => {
  const copied = await fixture();
  const committedSource = await fixture();
  const committedTarget = await fixture();
  try {
    const completed = await fixture();
    try {
      const completePlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: completed.workspace });
      await discardLocalExportWorkspace({
        workspaceDirectory: completed.workspace,
        confirmationToken: completePlan.confirmationToken,
      });
      await copyFile(
        join(completed.workspace, "workspace-discard-receipt.json"),
        join(copied.workspace, "workspace-discard-receipt.json"),
      );
      await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: copied.workspace }),
        (error) => error.code === "export_workspace_discard_execute_receipt_invalid");
    } finally { await rm(completed.root, { recursive: true, force: true }); }

    const missing = join(copied.root, "missing-workspace");
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: missing }));
    await assert.rejects(stat(missing));

    const committedPlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: committedSource.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: committedSource.workspace,
      confirmationToken: committedPlan.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("retain committed controls");
      },
    }), /retain committed controls/);
    for (const name of [
      ".app-usagemonitor-workspace-discard-journal.json",
      ".app-usagemonitor-workspace-discard-commit.json",
    ]) {
      await copyFile(join(committedSource.workspace, name), join(committedTarget.workspace, name));
    }
    await assert.rejects(recoverLocalExportWorkspaceDiscard({ workspaceDirectory: committedTarget.workspace }),
      (error) => error.code === "export_workspace_discard_execute_replacement");
    assert.equal((await stat(join(committedTarget.workspace, "workspace.sqlite3"))).isFile(), true);
  } finally {
    await rm(copied.root, { recursive: true, force: true });
    await rm(committedSource.root, { recursive: true, force: true });
    await rm(committedTarget.root, { recursive: true, force: true });
  }
});

test("persisted controls and CLI output contain no paths, identifiers, digests, or content canaries", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  try {
    const command = resolve("src/cli.js");
    const args = [command, "discard-export-workspace", "--workspace", value.workspace];
    const preview = execFileSync(process.execPath, args, { cwd: resolve("."), encoding: "utf8" });
    const token = preview.match(/Confirmation token: ([A-Z2-7]{16})/)?.[1];
    assert.equal(typeof token, "string");
    assert.match(preview, /--confirm-discard TOKEN/);
    assert.match(preview, /accepts|No files changed|Source logs/);
    assert.equal(preview.includes(value.root), false);
    const wrongIntent = spawnSync(process.execPath, [
      ...args, "--confirm-deletion", token,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(wrongIntent.status, 0);
    assert.match(wrongIntent.stderr, /uses --confirm-discard, not --confirm-deletion/);
    assert.equal(wrongIntent.stderr.includes(value.root), false);
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: token,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw new Error("stop after commit");
      },
    }), /stop after commit/);
    const journalText = await readFile(join(value.workspace, ".app-usagemonitor-workspace-discard-journal.json"), "utf8");
    const markerText = await readFile(join(value.workspace, ".app-usagemonitor-workspace-discard-commit.json"), "utf8");
    const controls = `${journalText}\n${markerText}`;
    assert.equal(validateExportWorkspaceDiscardJournal(JSON.parse(journalText)).valid, true);
    assert.equal(validateExportWorkspaceDiscardCommitMarker(JSON.parse(markerText)).valid, true);
    for (const canary of [
      value.root, PRIVATE_PROMPT, PRIVATE_SESSION, "participant:v1:", "source_path",
      "sha256", "inode", "device", "digest", "modifiedMs",
    ]) {
      assert.equal(controls.includes(canary), false);
      assert.equal(preview.includes(canary), false);
    }
    assert.equal(/[a-f0-9]{64}/.test(controls), false);
    await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    const completed = execFileSync(process.execPath, [
      command, "recover-export-workspace-discard", "--workspace", value.workspace,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(completed.includes(value.root), false);
    await assertDiscarded(value);

    const rejected = spawnSync(process.execPath, [
      command, "discard-export-workspace", "--workspace", value.workspace, "--directory", value.output,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /accepts --workspace only/);
    assert.equal(rejected.stderr.includes(value.root), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("CLI confirms workspace discard only through the dedicated discard token option", async () => {
  const value = await fixture();
  try {
    const command = resolve("src/cli.js");
    const base = [command, "discard-export-workspace", "--workspace", value.workspace];
    const preview = execFileSync(process.execPath, base, { cwd: resolve("."), encoding: "utf8" });
    const token = preview.match(/Confirmation token: ([A-Z2-7]{16})/)?.[1];
    assert.equal(typeof token, "string");
    const output = execFileSync(process.execPath, [...base, "--confirm-discard", token], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.match(output, /Local export workspace discard: complete/);
    assert.equal(output.includes(value.root), false);
    await assertDiscarded(value);
    const help = execFileSync(process.execPath, [command, "--help"], { cwd: resolve("."), encoding: "utf8" });
    assert.match(help, /discard-export-workspace --workspace PATH \[--confirm-discard TOKEN\]/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("local-review previews, confirms, and replays the fixed discard receipt without leaking paths", async () => {
  const value = await fixture({ sidecars: ["journal"] });
  try {
    const command = resolve("local-review/cli.js");
    const base = [command, "discard-export-workspace", "--workspace", value.workspace];
    const preview = execFileSync(process.execPath, base, { cwd: resolve("."), encoding: "utf8" });
    const token = preview.match(/Confirmation token: ([A-Z2-7]{16})/)?.[1];
    assert.equal(typeof token, "string");
    assert.equal(preview.includes(value.root), false);
    const wrong = spawnSync(process.execPath, [...base, "--confirm-discard", "AAAAAAAAAAAAAAAA"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(wrong.status, 0);
    assert.equal(wrong.stderr.includes(value.root), false);
    const completed = execFileSync(process.execPath, [...base, "--confirm-discard", token], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.match(completed, /Local export workspace discard: complete/);
    const replay = execFileSync(process.execPath, [
      command, "recover-export-workspace-discard", "--workspace", value.workspace,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(replay, /Local export workspace discard recovery: complete/);
    assert.equal(`${completed}\n${replay}`.includes(value.root), false);
    await assertDiscarded(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("storage and lease failures surface only fixed content-free discard errors", async () => {
  const writeFailure = await fixture();
  const leaseFailure = await fixture();
  const pathCanary = "/PRIVATE/PATH/CANARY/workspace.sqlite3";
  try {
    const writePlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: writeFailure.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: writeFailure.workspace,
      confirmationToken: writePlan.confirmationToken,
      async linkFile() { throw new Error(`EIO at ${pathCanary}`); },
    }), (error) => error.code === "export_workspace_discard_execute_replacement"
      && !error.message.includes(pathCanary));

    const leasePlan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: leaseFailure.workspace });
    await assert.rejects(discardLocalExportWorkspace({
      workspaceDirectory: leaseFailure.workspace,
      confirmationToken: leasePlan.confirmationToken,
      async withLease() { throw new Error(`lease failed at ${pathCanary}`); },
    }), (error) => error.code === "export_workspace_discard_execute_replacement"
      && !error.message.includes(pathCanary));
    await assert.rejects(recoverLocalExportWorkspaceDiscard({
      workspaceDirectory: leaseFailure.workspace,
      async withLease() { throw new Error(`recovery lease failed at ${pathCanary}`); },
    }), (error) => error.code === "export_workspace_discard_execute_replacement"
      && !error.message.includes(pathCanary));
  } finally {
    await rm(writeFailure.root, { recursive: true, force: true });
    await rm(leaseFailure.root, { recursive: true, force: true });
  }
});

test("workspace discard implementation contains no recursive deletion primitive", async () => {
  const files = [
    "src/export-workspace-discard.js",
    "src/export-workspace-discard-executor.js",
    "src/export-workspace-discard-schema.js",
    "src/application/local-export-workspace-discard.js",
    "src/export-workspace-discard-compatibility-internal.js",
    "src/platform/owner-only-export-workspace-discard-preflight.js",
    "src/platform/owner-only-export-workspace-discard-storage.js",
  ];
  for (const file of files) {
    const source = await readFile(resolve(file), "utf8");
    assert.equal(/\brm\s*\(/.test(source), false);
    assert.equal(/\brmdir\s*\(/.test(source), false);
    assert.equal(/recursive\s*:\s*true/.test(source), false);
  }
});
