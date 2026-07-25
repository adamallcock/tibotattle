import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCodexCollectorWorkspaceSource,
  collectorPlanningGuard,
  CodexCollectorWorkspaceSourceError,
  createCodexCollectorWorkspaceSource,
  populateCodexCollectorWorkspaceSource,
  summarizeCodexCollectorDiagnostics,
} from "../src/codex-collector-workspace-source.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createExportResourceGuard, ExportResourceLimitError } from "../src/export-resource-policy.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import { createEmptySupplementalSourcePlan } from "../src/export-supplemental-source-plan.js";
import {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
} from "../src/export-workspace.js";
import {
  createLocalExportWorkspace,
  resumeLocalExportWorkspace,
} from "../src/export-set-controller.js";

const SECRET = Buffer.alloc(32, 83);
const START = "2026-07-20T00:00:00.000Z";
const END = "2026-07-25T00:00:00.000Z";
const ACCOUNT_SCOPE = `openai-account:v1:${"A".repeat(43)}`;

function window({
  slot = "primary",
  usedPercent = 12.34,
  resetsAt = 1_784_854_800,
  windowDurationMins = 10_080,
} = {}) {
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot,
    usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

function accountScope(available = true) {
  return available ? {
    status: "available",
    reason: null,
    version: "openai-account-v1",
    scopeId: ACCOUNT_SCOPE,
    planType: "pro",
  } : {
    status: "unavailable",
    reason: "missing_secret",
    version: "openai-account-v1",
    scopeId: null,
    planType: "pro",
  };
}

function quotaRecord({
  at = "2026-07-23T12:00:00.000Z",
  windows = [window()],
  source = "app_server_read",
  account = accountScope(),
} = {}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: at,
    receivedAt: at,
    stalenessMs: 0,
    source,
    windows,
    providerSurface: "account_shared_unallocated",
    accountScope: account,
    officialDailyTokens: source === "app_server_notification" ? [] : [{ date: "2026-07-23", tokens: 123 }],
    officialUsageSummary: source === "app_server_notification" ? null : {
      currentStreakDays: 1,
      lifetimeTokens: 2,
      longestRunningTurnSec: 3,
      longestStreakDays: 4,
      peakDailyTokens: 5,
    },
    controlledState: "unknown",
    eventKey: "e".repeat(64),
  };
}

async function fixture(lines, { tail = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-collector-workspace-"));
  const codexHome = join(root, "codex-home");
  const collectorDirectory = join(root, "collector");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  await mkdir(collectorDirectory, { mode: 0o700 });
  const collectorPath = join(collectorDirectory, "events.jsonl");
  const complete = lines.length === 0 ? "" : `${lines.map((line) => (
    typeof line === "string" ? line : JSON.stringify(line)
  )).join("\n")}\n`;
  await writeFile(collectorPath, `${complete}${tail}`, { mode: 0o600 });
  return {
    root,
    codexHome,
    collectorPath,
    complete,
    workspace: join(root, "workspace"),
  };
}

async function readSnapshots(directory) {
  const workspace = await (await import("../src/export-workspace.js")).openExportWorkspace({ directory });
  try {
    return [...workspace.iterateRecords()]
      .filter((row) => row.family === "quotaSnapshots")
      .map((row) => row.record);
  } finally {
    workspace.close();
  }
}

async function controllerRun(value, options = {}) {
  return createLocalExportWorkspace({
    directory: value.workspace,
    startAt: START,
    endAt: END,
    createdAt: END,
    codexHome: value.codexHome,
    collectorPath: value.collectorPath,
    secret: SECRET,
    ...options,
  });
}

function activityPlan() {
  return {
    recordCount: 0,
    recordsSha256: createHash("sha256")
      .update("app-usagemonitor/export-activity-plan/v1\0")
      .update("[]")
      .digest("hex"),
  };
}

async function manualWorkspace(value) {
  const planningGuard = createExportResourceGuard();
  const collector = await createCodexCollectorWorkspaceSource({
    collectorPath: value.collectorPath,
    startAt: START,
    endAt: END,
    resourceGuard: planningGuard,
  });
  const supplementalSourcePlan = appendCodexCollectorWorkspaceSource(
    createEmptySupplementalSourcePlan(),
    collector.collectorPlan,
  );
  const sourcePlan = await createCodexExportSourcePlan({
    codexHome: value.codexHome,
    startAt: START,
    endAt: END,
  });
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET),
    createdAt: END,
    coveredAt: { startAt: START, endAt: END },
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    supplementalSourcePlan,
    activityPlan: activityPlan(),
  });
  const workspace = await createExportWorkspace({
    directory: value.workspace,
    descriptor,
    sourcePlan,
    supplementalSourcePlan,
  });
  const resourceGuard = createExportResourceGuard({
    scope: "export_set",
    initialUsage: workspace.resourceUsage(),
  });
  return { workspace, resourceGuard };
}

function countingWorkspaceGuard(workspace) {
  const delegate = createExportResourceGuard({ scope: "export_set", initialUsage: workspace.resourceUsage() });
  let runtimeChecks = 0;
  return {
    get runtimeChecks() { return runtimeChecks; },
    limits: delegate.limits,
    assertCoveredInterval: delegate.assertCoveredInterval.bind(delegate),
    checkRuntime() {
      runtimeChecks += 1;
      return delegate.checkRuntime();
    },
    observeLine: delegate.observeLine.bind(delegate),
    observeOutputRecord: delegate.observeOutputRecord.bind(delegate),
    durableSnapshot: delegate.durableSnapshot.bind(delegate),
  };
}

test("collector controller is deterministic across batch sizes and preserves distinct physical occurrences", async () => {
  const lines = [
    quotaRecord({
      at: "2026-07-23T12:02:00.000Z",
      windows: [window(), window({ slot: "secondary", usedPercent: 56, windowDurationMins: 300 })],
    }),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z" }),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z" }),
    quotaRecord({ at: "2026-07-23T12:03:00.000Z", account: accountScope(false), source: "app_server_notification" }),
  ];
  const one = await fixture(lines);
  const many = await fixture(lines);
  try {
    const first = await controllerRun(one, { collectorCandidatesPerBatch: 1 });
    const second = await controllerRun(many, { collectorCandidatesPerBatch: 1_000 });
    assert.equal(first.status.scanComplete, true);
    assert.equal(second.status.scanComplete, true);
    const firstRecords = await readSnapshots(one.workspace);
    const secondRecords = await readSnapshots(many.workspace);
    assert.deepEqual(firstRecords, secondRecords);
    assert.equal(firstRecords.length, 5);
    assert.equal(new Set(firstRecords.map((record) => record.snapshotId)).size, 5);
    assert.deepEqual(firstRecords.map((record) => record.observedTime), [
      "2026-07-23T12:01:00.000Z",
      "2026-07-23T12:01:00.000Z",
      "2026-07-23T12:02:00.000Z",
      "2026-07-23T12:02:00.000Z",
      "2026-07-23T12:03:00.000Z",
    ]);
    assert.equal(firstRecords.at(-1).sessionScopeId, null);
    assert.equal(firstRecords.at(-1).accountScopeId, "unattributed");
    assert.equal(first.resourceUsage.counters.sourceFiles, 1);
    assert.equal(first.resourceUsage.counters.sourceBytes, Buffer.byteLength(one.complete));
  } finally {
    await rm(one.root, { recursive: true, force: true });
    await rm(many.root, { recursive: true, force: true });
  }
});

test("collector resumes an interrupted multi-window source without replaying or losing records", async () => {
  const value = await fixture([
    quotaRecord({ windows: [window(), window({ slot: "secondary", usedPercent: 44, windowDurationMins: 300 })] }),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z" }),
  ]);
  try {
    await assert.rejects(controllerRun(value, {
      collectorCandidatesPerBatch: 1,
      async failpoint(stage) {
        if (stage === "after_collector_checkpoint_batch") throw new Error("collector interruption");
      },
    }), /collector interruption/);
    const resumed = await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.codexHome,
      collectorPath: value.collectorPath,
      secret: SECRET,
      collectorCandidatesPerBatch: 1,
    });
    assert.equal(resumed.status.scanComplete, true);
    const records = await readSnapshots(value.workspace);
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map((record) => record.snapshotId)).size, 3);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector appends after planning remain outside the frozen prefix", async () => {
  const value = await fixture([quotaRecord()], { tail: "PRIVATE-PARTIAL" });
  try {
    let appended = false;
    await assert.rejects(controllerRun(value, {
      async failpoint(stage) {
        if (stage === "after_collector_checkpoint_batch" && !appended) {
          appended = true;
          await appendFile(value.collectorPath, `-complete\n${JSON.stringify(quotaRecord({ at: "2026-07-23T12:01:00.000Z" }))}\n`);
          throw new Error("append after frozen batch");
        }
      },
    }), /append after frozen batch/);
    const resumed = await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.codexHome,
      collectorPath: value.collectorPath,
      secret: SECRET,
    });
    assert.equal(resumed.status.scanComplete, true);
    assert.deepEqual((await readSnapshots(value.workspace)).map((record) => record.observedTime), [
      "2026-07-23T12:00:00.000Z",
    ]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector source mutation, truncation, replacement, symlink, and hardlink poison the incomplete workspace", async () => {
  const mutations = [
    async (value) => writeFile(value.collectorPath, `${JSON.stringify(quotaRecord({ at: "2026-07-23T12:00:01.000Z" }))}\n`, { mode: 0o600 }),
    async (value) => truncate(value.collectorPath, 0),
    async (value) => {
      const replacement = join(value.root, "replacement.jsonl");
      await writeFile(replacement, value.complete, { mode: 0o600 });
      await rename(replacement, value.collectorPath);
    },
    async (value) => {
      const target = join(value.root, "target.jsonl");
      await rename(value.collectorPath, target);
      await symlink(target, value.collectorPath);
    },
    async (value) => link(value.collectorPath, join(value.root, "extra-hardlink.jsonl")),
  ];
  for (const mutate of mutations) {
    const value = await fixture([quotaRecord()]);
    let workspace;
    try {
      ({ workspace } = await manualWorkspace(value));
      await mutate(value);
      await assert.rejects(populateCodexCollectorWorkspaceSource({
        workspace,
        collectorPath: value.collectorPath,
        secret: SECRET,
        resourceGuard: createExportResourceGuard({ scope: "export_set", initialUsage: workspace.resourceUsage() }),
      }), (error) => {
        assert.equal(error instanceof CodexCollectorWorkspaceSourceError, true);
        assert.equal(error.message.includes(value.collectorPath), false);
        return true;
      });
      assert.equal(workspace.isPoisoned(), true);
    } finally {
      workspace?.close();
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("collector rehashes the frozen prefix before committing its terminal checkpoint", async () => {
  const value = await fixture([
    quotaRecord(),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z" }),
  ]);
  let workspace;
  try {
    ({ workspace } = await manualWorkspace(value));
    let rewritten = false;
    await assert.rejects(populateCodexCollectorWorkspaceSource({
      workspace,
      collectorPath: value.collectorPath,
      secret: SECRET,
      resourceGuard: createExportResourceGuard({ scope: "export_set", initialUsage: workspace.resourceUsage() }),
      maximumCandidateRecords: 1,
      async failpoint(stage) {
        if (stage !== "after_collector_checkpoint_batch" || rewritten) return;
        rewritten = true;
        const original = await readFile(value.collectorPath, "utf8");
        const replacement = original.replace("12.34", "12.35");
        assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
        await writeFile(value.collectorPath, replacement, { mode: 0o600 });
      },
    }), (error) => error instanceof CodexCollectorWorkspaceSourceError
      && error.code === "codex_collector_workspace_source_source_integrity");
    assert.equal(rewritten, true);
    assert.equal(workspace.isPoisoned(), true);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector checkpoint batches avoid rehashing and recounting the whole frozen prefix", async () => {
  const irrelevant = `irrelevant-${"x".repeat(384 * 1024)}`;
  const value = await fixture([
    irrelevant,
    quotaRecord(),
    irrelevant,
    quotaRecord({ at: "2026-07-23T12:01:00.000Z" }),
    irrelevant,
    quotaRecord({ at: "2026-07-23T12:02:00.000Z" }),
  ]);
  let workspace;
  try {
    ({ workspace } = await manualWorkspace(value));
    const resourceGuard = countingWorkspaceGuard(workspace);
    const result = await populateCodexCollectorWorkspaceSource({
      workspace,
      collectorPath: value.collectorPath,
      secret: SECRET,
      resourceGuard,
      maximumCandidateRecords: 1,
    });
    assert.equal(result.checkpoint.status, "complete");
    // Three bounded candidate batches stream the source once, followed by one
    // terminal whole-prefix proof. The prior O(prefix × batches) verifier
    // exceeded this count from repeated prefix hash/count passes alone.
    assert.ok(resourceGuard.runtimeChecks < 32, `unexpected runtime checks: ${resourceGuard.runtimeChecks}`);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector skips a completed supplemental checkpoint without reopening its external ledger", async () => {
  const value = await fixture([quotaRecord()]);
  let workspace;
  try {
    ({ workspace } = await manualWorkspace(value));
    const first = await populateCodexCollectorWorkspaceSource({
      workspace,
      collectorPath: value.collectorPath,
      secret: SECRET,
      resourceGuard: createExportResourceGuard({ scope: "export_set", initialUsage: workspace.resourceUsage() }),
    });
    assert.equal(first.checkpoint.status, "complete");
    await rm(value.collectorPath);
    const resumed = await populateCodexCollectorWorkspaceSource({
      workspace,
      collectorPath: value.collectorPath,
      secret: SECRET,
      resourceGuard: createExportResourceGuard({ scope: "export_set", initialUsage: workspace.resourceUsage() }),
    });
    assert.equal(resumed.checkpoint.status, "complete");
    assert.equal(workspace.isPoisoned(), false);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector resource usage survives reopening and no-collector workspaces retain the existing path", async () => {
  const value = await fixture([quotaRecord(), quotaRecord({ at: "2026-07-23T12:01:00.000Z" })]);
  const empty = await fixture([]);
  try {
    const result = await controllerRun(value, { enableCollector: true });
    const reopened = await (await import("../src/export-workspace.js")).openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(reopened.resourceUsage().sourceFiles, 1);
      assert.equal(reopened.resourceUsage().sourceBytes, Buffer.byteLength(value.complete));
      assert.equal(reopened.resourceUsage().outputRecords, 2);
      assert.equal(result.resourceUsage.counters.lines, reopened.resourceUsage().lines);
    } finally {
      reopened.close();
    }
    const noCollector = await createLocalExportWorkspace({
      directory: empty.workspace,
      startAt: START,
      endAt: END,
      createdAt: END,
      codexHome: empty.codexHome,
      secret: SECRET,
    });
    assert.equal(noCollector.status.scanComplete, true);
    assert.equal(noCollector.descriptor.supplementalSourcePlan.sourceCount, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(empty.root, { recursive: true, force: true });
  }
});

test("collector commits newly reviewed diagnostic rows without a supplemental registry gap", async () => {
  const value = await fixture([
    { schemaVersion: "0.3", kind: "unrelated_private_event" },
    "{not-json",
    quotaRecord(),
  ]);
  try {
    const result = await controllerRun(value, { collectorCandidatesPerBatch: 1 });
    assert.equal(result.status.scanComplete, true);
    assert.deepEqual(result.collectorDiagnosticRegistryGaps, []);
    const workspace = await (await import("../src/export-workspace.js")).openExportWorkspace({ directory: value.workspace });
    try {
      const sourceKey = workspace.loadSupplementalSourcePlan().sources[0].sourceKey;
      assert.deepEqual(workspace.supplementalDiagnosticRegistryGaps(sourceKey), []);
      assert.deepEqual(workspace.diagnostics(), [
        { code: "collector_irrelevant_records", count: 1 },
        { code: "malformed_lines", count: 1 },
      ]);
    } finally {
      workspace.close();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector diagnostic registry report uses every reviewed collector row and rejects future shapes", () => {
  const summary = summarizeCodexCollectorDiagnostics({
    linesSeen: 12,
    candidatesEmitted: 1,
    emptyLines: 2,
    irrelevantRecords: 3,
    malformedJsonLines: 4,
    malformedRecordShapes: 5,
    unsupportedSchemaRecords: 6,
    unsupportedSourceRecords: 7,
    malformedWindows: 8,
    malformedAccountScopes: 9,
    outOfBoundsRecords: 10,
    oversizedIrrelevantLines: 11,
  });
  assert.deepEqual(summary.reviewed, [
    { code: "malformed_lines", count: 4 },
    { code: "malformed_rate_limit_records", count: 22 },
    { code: "collector_empty_lines", count: 2 },
    { code: "collector_irrelevant_records", count: 3 },
    { code: "collector_unsupported_schema_records", count: 6 },
    { code: "collector_unsupported_source_records", count: 7 },
    { code: "collector_out_of_bounds_records", count: 10 },
    { code: "collector_oversized_irrelevant_lines", count: 11 },
  ]);
  assert.deepEqual(summary.missingRegistryRows, []);
  assert.throws(() => summarizeCodexCollectorDiagnostics({
    linesSeen: 0, candidatesEmitted: 0, emptyLines: 0, irrelevantRecords: 0, malformedJsonLines: 0,
    malformedRecordShapes: 0, unsupportedSchemaRecords: 0, unsupportedSourceRecords: 0,
    malformedWindows: 0, malformedAccountScopes: 0, outOfBoundsRecords: 0, oversizedIrrelevantLines: 0,
    futureCollectorDiagnostic: 1,
  }));
});

test("collector planning shares the owning export invocation elapsed budget", async () => {
  const value = await fixture([]);
  try {
    let now = 0;
    const owner = createExportResourceGuard({
      limits: { maximumElapsedMs: 1 },
      scope: "export_set",
      clock: () => now,
      rss: () => 0,
    });
    owner.assertCoveredInterval(Date.parse(START), Date.parse(END));
    now = 2;
    await assert.rejects(createCodexCollectorWorkspaceSource({
      collectorPath: value.collectorPath,
      startAt: START,
      endAt: END,
      resourceGuard: collectorPlanningGuard(owner),
    }), (error) => error instanceof ExportResourceLimitError
      && error.code === "export_resource_elapsed_time");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
