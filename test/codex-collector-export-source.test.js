import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexCollectorExportSourceError,
  createCodexCollectorExportCursor,
  createCodexCollectorExportSourcePlan,
  scanCodexCollectorExportSource,
  verifyCodexCollectorExportSourcePlan,
} from "../src/codex-collector-export-source.js";
import { createExportResourceGuard, ExportResourceLimitError } from "../src/export-resource-policy.js";

const START = "2026-07-20T00:00:00.000Z";
const END = "2026-07-25T00:00:00.000Z";
const ACCOUNT_SCOPE = `openai-account:v1:${"A".repeat(43)}`;

function window({
  planType = "pro",
  limitId = "codex",
  slot = "primary",
  usedPercent = 12.34,
  windowDurationMins = 10_080,
  resetsAt = 1_784_854_800,
} = {}) {
  return { provider: "openai_codex", planType, limitId, slot, usedPercent, windowDurationMins, resetsAt };
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
  source = "app_server_read",
  windows = [window()],
  account = accountScope(),
  officialDailyTokens = [{ date: "2026-07-23", tokens: 123_456_789 }],
  officialUsageSummary = {
    currentStreakDays: 9,
    lifetimeTokens: 987_654_321,
    longestRunningTurnSec: 88,
    longestStreakDays: 7,
    peakDailyTokens: 66,
  },
} = {}) {
  if (source === "app_server_notification") {
    officialDailyTokens = [];
    officialUsageSummary = null;
  }
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
    officialDailyTokens,
    officialUsageSummary,
    controlledState: "unknown",
    eventKey: "e".repeat(64),
  };
}

async function fixture(lines, { tail = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-codex-collector-export-"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  const path = join(root, "state", "collector-events.jsonl");
  const complete = lines.length > 0 ? `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}\n` : "";
  await writeFile(path, `${complete}${tail}`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { root, path, complete };
}

async function planFor(value, options = {}) {
  return createCodexCollectorExportSourcePlan({
    collectorPath: value.path,
    startAt: options.startAt ?? START,
    endAt: options.endAt ?? END,
    resourceGuard: options.resourceGuard,
  });
}

async function collectAll(plan, maximumCandidateRecords) {
  let cursor = createCodexCollectorExportCursor(plan);
  const candidates = [];
  const diagnostics = [];
  do {
    const batch = await scanCodexCollectorExportSource(plan, { cursor, maximumCandidateRecords });
    candidates.push(...batch.candidates);
    diagnostics.push(batch.diagnostics);
    cursor = batch.cursor;
    if (batch.complete) return { candidates, cursor, diagnostics };
  } while (true);
}

function safeFailure(expected) {
  return (error) => {
    assert.equal(error instanceof CodexCollectorExportSourceError, true);
    assert.equal(error.code, expected);
    assert.equal(error.message.includes("PRIVATE-CANARY"), false);
    return true;
  };
}

test("freezes a complete-line prefix and emits only provider-neutral quota candidates", async () => {
  const first = quotaRecord({
    windows: [
      window(),
      window({ slot: "secondary", usedPercent: 56, windowDurationMins: 300, resetsAt: 1_784_800_000 }),
    ],
  });
  const value = await fixture([first], { tail: "PRIVATE-CANARY-partial-line" });
  try {
    const plan = await planFor(value);
    assert.equal(plan.prefixBytes, Buffer.byteLength(value.complete));
    assert.equal(plan.path, value.path);
    const result = await scanCodexCollectorExportSource(plan);
    assert.equal(result.complete, true);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.slot), ["primary", "secondary"]);
    assert.equal(result.candidates[0].displayPrecision, 2);
    assert.equal(result.candidates[0].accountScopeSubject, ACCOUNT_SCOPE);
    assert.equal(result.candidates[0].sessionScopeId, null);
    assert.match(result.candidates[0].observationIdentityMaterial, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "PRIVATE-CANARY", "eventKey", "officialDailyTokens", "officialUsageSummary",
      "lifetimeTokens", "987654321", "123456789", value.path,
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retains the provider-reported prolite plan in quota candidates", async () => {
  const value = await fixture([quotaRecord({
    windows: [window({ planType: "prolite" })],
    account: { ...accountScope(), planType: "prolite" },
  })]);
  try {
    const result = await scanCodexCollectorExportSource(await planFor(value));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].planType, "prolite");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retains go and edu provider-reported plans in quota candidates", async () => {
  const value = await fixture([quotaRecord({
    windows: [
      window({ planType: "go" }),
      window({ planType: "edu", slot: "secondary" }),
    ],
    account: { ...accountScope(), planType: null },
  })]);
  try {
    const result = await scanCodexCollectorExportSource(await planFor(value));
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.planType),
      ["go", "edu"],
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("resumes at exact byte, line, and window positions with batch-size equivalence", async () => {
  const value = await fixture([
    quotaRecord({
      windows: [
        window({ usedPercent: 1 }),
        window({ slot: "secondary", usedPercent: 2, windowDurationMins: 300 }),
      ],
    }),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z", windows: [window({ usedPercent: 3 })] }),
  ]);
  try {
    const plan = await planFor(value);
    const one = await collectAll(plan, 1);
    const many = await collectAll(plan, 100);
    assert.deepEqual(one.candidates, many.candidates);
    assert.equal(one.candidates.length, 3);
    assert.equal(one.diagnostics[0].candidatesEmitted, 1);
    assert.equal(one.diagnostics[0].linesSeen, 1);
    assert.equal(one.diagnostics[1].linesSeen, 1, "a mid-line resume revalidates the same line");
    assert.deepEqual(one.cursor, many.cursor);
    assert.equal(one.cursor.nextByte, plan.prefixBytes);
    assert.equal(one.cursor.nextWindowOrdinal, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("preserves independent window absence and validates percent, reset, and duration ranges", async () => {
  const records = [
    quotaRecord({ windows: [window({ usedPercent: 0, resetsAt: 1 })] }),
    quotaRecord({ at: "2026-07-23T12:01:00.000Z", windows: [window({ usedPercent: 100 })] }),
    quotaRecord({ at: "2026-07-23T12:02:00.000Z", windows: [window({ usedPercent: 100.01 })] }),
    quotaRecord({ at: "2026-07-23T12:03:00.000Z", windows: [window({ resetsAt: 0 })] }),
    quotaRecord({ at: "2026-07-23T12:04:00.000Z", windows: [window({ windowDurationMins: 0 })] }),
  ];
  const value = await fixture(records);
  try {
    const result = await scanCodexCollectorExportSource(await planFor(value));
    assert.deepEqual(result.candidates.map((candidate) => candidate.slot), ["primary", "primary"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.usedPercent), [0, 100]);
    assert.equal(result.diagnostics.malformedWindows, 3);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("counts future schemas, unknown sources, extra keys, irrelevant records, and out-of-bounds records", async () => {
  const future = { ...quotaRecord(), schemaVersion: "0.4" };
  const unknownSource = { ...quotaRecord(), source: "PRIVATE-CANARY-future-source" };
  const extra = { ...quotaRecord(), balance: "PRIVATE-CANARY-balance" };
  const irrelevant = { schemaVersion: "0.3", kind: "codex_rollout_usage_snapshot", content: "PRIVATE-CANARY-content" };
  const outOfBounds = quotaRecord({ at: "2026-07-19T23:59:59.000Z" });
  const value = await fixture([future, unknownSource, extra, irrelevant, outOfBounds, "{bad PRIVATE-CANARY-json"]);
  try {
    const result = await scanCodexCollectorExportSource(await planFor(value));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.diagnostics.unsupportedSchemaRecords, 1);
    assert.equal(result.diagnostics.unsupportedSourceRecords, 1);
    assert.equal(result.diagnostics.malformedRecordShapes, 1);
    assert.equal(result.diagnostics.irrelevantRecords, 1);
    assert.equal(result.diagnostics.outOfBoundsRecords, 1);
    assert.equal(result.diagnostics.malformedJsonLines, 1);
    assert.equal(JSON.stringify(result).includes("PRIVATE-CANARY"), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("accepts read and notification sources and explicitly leaves unavailable accounts unattributed", async () => {
  const value = await fixture([
    quotaRecord({ source: "app_server_read" }),
    quotaRecord({
      at: "2026-07-23T12:01:00.000Z",
      source: "app_server_notification",
      account: accountScope(false),
    }),
    quotaRecord({
      at: "2026-07-23T12:02:00.000Z",
      source: "app_server_read",
      account: { ...accountScope(false), reason: "credential_unavailable" },
    }),
    quotaRecord({
      at: "2026-07-23T12:03:00.000Z",
      source: "app_server_read",
      account: { ...accountScope(false), reason: "credential_locked" },
    }),
  ]);
  try {
    const result = await scanCodexCollectorExportSource(await planFor(value));
    assert.deepEqual(result.candidates.map((candidate) => candidate.source), ["app_server_read", "app_server_notification", "app_server_read", "app_server_read"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.accountScopeSubject), [ACCOUNT_SCOPE, "unattributed", "unattributed", "unattributed"]);
    assert.deepEqual(result.candidates.map((candidate) => candidate.sessionScopeId), [null, null, null, null]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects mutation, truncation, replacement, symlink, hardlink, and unsafe permissions", async () => {
  const mutations = [
    async (value) => writeFile(value.path, `${JSON.stringify(quotaRecord({ at: "2026-07-23T12:00:01.000Z" }))}\n`, { mode: 0o600 }),
    async (value) => writeFile(value.path, "", { mode: 0o600 }),
    async (value) => {
      const replacement = join(value.root, "replacement.jsonl");
      await writeFile(replacement, value.complete, { mode: 0o600 });
      await rename(replacement, value.path);
    },
    async (value) => {
      const target = join(value.root, "target.jsonl");
      await rename(value.path, target);
      await symlink(target, value.path);
    },
    async (value) => link(value.path, join(value.root, "hardlink.jsonl")),
    async (value) => chmod(value.path, 0o640),
  ];
  for (const mutate of mutations) {
    const value = await fixture([quotaRecord()]);
    try {
      const plan = await planFor(value);
      await mutate(value);
      await assert.rejects(scanCodexCollectorExportSource(plan), (error) => {
        assert.equal(error instanceof CodexCollectorExportSourceError, true);
        assert.match(error.code, /^codex_collector_export_source_(?:changed|missing|type|links|permissions)$/);
        return true;
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("post-scan verification catches an in-place rewrite before candidates are returned", async () => {
  const value = await fixture([quotaRecord()]);
  try {
    const plan = await planFor(value);
    const delegate = createExportResourceGuard();
    let mutated = false;
    const guard = {
      ...delegate,
      observeOutputRecord(bytes) {
        delegate.observeOutputRecord(bytes);
        if (!mutated) {
          mutated = true;
          const rewritten = value.complete.replace("12.34", "12.35");
          assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(value.complete));
          writeFileSync(value.path, rewritten, { mode: 0o600 });
        }
      },
    };
    await assert.rejects(
      scanCodexCollectorExportSource(plan, { resourceGuard: guard }),
      safeFailure("codex_collector_export_source_changed"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("allows append-only growth beyond the frozen prefix and ignores a partial final line", async () => {
  const value = await fixture([quotaRecord()], { tail: "PRIVATE-CANARY-partial" });
  try {
    const plan = await planFor(value);
    await appendFile(value.path, `-completed\n${JSON.stringify(quotaRecord({ at: "2026-07-23T13:00:00.000Z" }))}\n`);
    await verifyCodexCollectorExportSourcePlan(plan);
    const result = await scanCodexCollectorExportSource(plan);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].observedTime, "2026-07-23T12:00:00.000Z");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bounds oversized lines and enforces source, output, elapsed, and RSS budgets with safe errors", async () => {
  const irrelevantValue = await fixture([`PRIVATE-CANARY-non-json-${"x".repeat(2_000)}`, quotaRecord()]);
  try {
    const guard = createExportResourceGuard({ limits: { maximumLineBytes: 1_000 } });
    const result = await scanCodexCollectorExportSource(await planFor(irrelevantValue), { resourceGuard: guard });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.diagnostics.oversizedIrrelevantLines, 1);
  } finally {
    await rm(irrelevantValue.root, { recursive: true, force: true });
  }

  const relevantValue = await fixture([{ ...quotaRecord(), padding: "PRIVATE-CANARY".repeat(200) }]);
  try {
    const plan = await planFor(relevantValue);
    await assert.rejects(
      scanCodexCollectorExportSource(plan, {
        resourceGuard: createExportResourceGuard({ limits: { maximumLineBytes: 1_000 } }),
      }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_line_bytes"
        && !error.message.includes("PRIVATE-CANARY"),
    );
  } finally {
    await rm(relevantValue.root, { recursive: true, force: true });
  }

  const value = await fixture([quotaRecord()]);
  try {
    await assert.rejects(
      planFor(value, { resourceGuard: createExportResourceGuard({ limits: { maximumSourceBytes: 1 } }) }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_source_bytes",
    );
    const plan = await planFor(value);
    await assert.rejects(
      scanCodexCollectorExportSource(plan, {
        resourceGuard: createExportResourceGuard({ limits: { maximumOutputRecords: 1 }, initialUsage: {
          policyVersion: "g1-r3-candidate-0.5",
          sourceFiles: 1,
          sourceBytes: plan.prefixBytes,
          directoryEntries: 0,
          lines: 0,
          oversizedIrrelevantLines: 0,
          outputRecords: 1,
          expandedRecordBytes: 1,
          cumulativeElapsedMs: 0,
          peakRssBytes: 0,
          workspaceHighWaterBytes: 0,
          recoveryReservations: 0,
        } }),
      }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_output_records",
    );
    await assert.rejects(
      scanCodexCollectorExportSource(plan, {
        resourceGuard: createExportResourceGuard({ limits: { maximumRssBytes: 1 }, rss: () => 2 }),
      }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_rss",
    );
    let now = 0;
    const elapsed = createExportResourceGuard({ limits: { maximumElapsedMs: 1 }, clock: () => now, rss: () => 0 });
    elapsed.assertCoveredInterval(Date.parse(START), Date.parse(END));
    now = 2;
    await assert.rejects(
      scanCodexCollectorExportSource(plan, { resourceGuard: elapsed }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_elapsed_time",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("prefix discovery rejects a sparse oversized unterminated tail before scanning beyond the source budget", async () => {
  const value = await fixture([]);
  try {
    await truncate(value.path, 64 * 1024 * 1024);
    const guard = createExportResourceGuard({ limits: { maximumSourceBytes: 1_024 } });
    await assert.rejects(
      planFor(value, { resourceGuard: guard }),
      (error) => error instanceof ExportResourceLimitError
        && error.code === "export_resource_source_bytes"
        && guard.snapshot().counters.lines === 0,
    );

    await truncate(value.path, 4_096);
    await assert.rejects(
      planFor(value, {
        resourceGuard: createExportResourceGuard({
          limits: { maximumSourceBytes: 8_192, maximumLineBytes: 1_024 },
        }),
      }),
      (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_line_bytes",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("oversized quota-shaped JSON fails closed despite whitespace and key ordering", async () => {
  const whitespaceRecord = `{ "padding" : "${"x".repeat(2_000)}", "source" : "app_server_read", "kind" : "codex_quota_snapshot" }`;
  const value = await fixture([whitespaceRecord]);
  try {
    const plan = await planFor(value);
    await assert.rejects(
      scanCodexCollectorExportSource(plan, {
        resourceGuard: createExportResourceGuard({ limits: { maximumLineBytes: 1_000 } }),
      }),
      (error) => error instanceof ExportResourceLimitError
        && error.code === "export_resource_line_bytes"
        && !error.message.includes("app_server_read"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects invalid cursors and keeps error messages content-free", async () => {
  const value = await fixture([quotaRecord()]);
  try {
    const plan = await planFor(value);
    const cursor = createCodexCollectorExportCursor(plan);
    cursor.nextByte = plan.prefixBytes + 1;
    cursor.private = "PRIVATE-CANARY";
    await assert.rejects(
      scanCodexCollectorExportSource(plan, { cursor }),
      safeFailure("codex_collector_export_cursor_invalid"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
