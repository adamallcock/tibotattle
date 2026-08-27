import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile as readFileNative,
  rename,
  rm,
  stat as statNative,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CodexAppServerError,
  deriveOpenAIAccountScope,
} from "../src/providers/codex/account.js";
import {
  appServerSnapshotRecord,
  discoverCollectorRollouts,
  ingestRolloutUpdates,
  notificationEvidenceFromAppServerRecord,
  MAX_DISCOVERY_DIRECTORY_ENTRIES,
  MAX_DISCOVERY_ROLLOUT_FILES,
  runCollectorForeground,
  runCollectorOnce,
} from "../src/passive-collector.js";
import {
  acquireLocalCollectorStateLock,
  commitLocalCollectorState,
  readLocalCollectorRecords,
  readLocalCollectorState,
} from "../src/local-collector-state.js";

const virtualCollectorStatePaths = new Map();

function virtualCollectorState(path) {
  return virtualCollectorStatePaths.get(path) ?? null;
}

async function readFile(path, options) {
  const virtual = virtualCollectorState(path);
  if (virtual === null) return readFileNative(path, options);
  const state = await readLocalCollectorState({ stateFile: virtual.stateFile });
  const contents = virtual.kind === "checkpoint"
    ? JSON.stringify(state.checkpoint)
    : (state.records ?? []).map((record) => JSON.stringify(record)).join("\n")
      + ((state.records ?? []).length > 0 ? "\n" : "");
  return options === "utf8" || options?.encoding === "utf8"
    ? contents
    : Buffer.from(contents);
}

async function stat(path) {
  const virtual = virtualCollectorState(path);
  return statNative(virtual?.stateFile ?? path);
}

test("collector discovery defaults leave room for the resumable archive index", () => {
  assert.equal(MAX_DISCOVERY_DIRECTORY_ENTRIES, 500_000);
  assert.equal(MAX_DISCOVERY_ROLLOUT_FILES, 125_000);
});

function usage(input) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input,
  };
}

function rateLimits(percent = 1, reset = 1784854800) {
  return {
    limit_id: "codex",
    plan_type: "pro",
    primary: { used_percent: percent, window_minutes: 10080, resets_at: reset },
    secondary: null,
  };
}

function tokenRecord(timestamp, total, last, percent = 1, reset = 1784854800) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
      rate_limits: rateLimits(percent, reset),
    },
  });
}

function tierRecord(timestamp, serviceTier, { omitTier = false } = {}) {
  const threadSettings = {
    model: "sensitive-model-setting",
    cwd: "/sensitive/local/path",
  };
  if (!omitTier) threadSettings.service_tier = serviceTier;
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: threadSettings,
    },
  });
}

function appPayload(percent = 2) {
  return {
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: 1784854800 },
      secondary: null,
    },
    rateLimitsByLimitId: {},
  };
}

async function collectorFixture(lines = []) {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-collector-"));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions");
  const archive = join(codexHome, "archived_sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(archive, { recursive: true });
  const rollout = join(sessions, "rollout-2026-07-23T00-00-00-fixture.jsonl");
  await writeFile(rollout, lines.length ? `${lines.join("\n")}\n` : "");
  const stateFile = join(root, "state", "local-collector-state-v1.sqlite");
  const dataFile = join(root, "state", "events.virtual");
  const checkpointFile = join(root, "state", "checkpoint.virtual");
  virtualCollectorStatePaths.set(dataFile, { stateFile, kind: "records" });
  virtualCollectorStatePaths.set(checkpointFile, { stateFile, kind: "checkpoint" });
  return {
    root,
    codexHome,
    sessions,
    archive,
    rollout,
    stateFile,
    dataFile,
    checkpointFile,
    lockFile: join(root, "state", "collector.lock"),
  };
}

async function readLines(path) {
  const virtual = virtualCollectorState(path);
  if (virtual !== null) {
    return (await readLocalCollectorRecords({ stateFile: virtual.stateFile })).records;
  }
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("recursive rollout discovery stops promptly when its AbortSignal fires", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  let abortChecks = 0;
  const signal = {
    get aborted() {
      abortChecks += 1;
      if (abortChecks === 9) controller.abort();
      return controller.signal.aborted;
    },
    addEventListener: (...args) => controller.signal.addEventListener(...args),
    removeEventListener: (...args) => controller.signal.removeEventListener(...args),
  };
  try {
    await writeFile(join(fixture.sessions, "second.jsonl"), "");
    await assert.rejects(
      () => discoverCollectorRollouts(fixture.codexHome, { signal }),
      (error) => {
        assert.equal(error.name, "AbortError");
        assert.equal(error.code, "collector_discovery_aborted");
        assert.ok(error.discoveryProgress.directoryEntries >= 1);
        assert.equal(JSON.stringify(error).includes(fixture.root), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("recursive rollout discovery enforces a content-free directory-entry ceiling", async () => {
  const fixture = await collectorFixture();
  try {
    await writeFile(join(fixture.sessions, "unrelated.txt"), "");
    await assert.rejects(
      () => discoverCollectorRollouts(fixture.codexHome, {
        maximumDirectoryEntries: 1,
      }),
      (error) => {
        assert.equal(error.code, "collector_resource_directory_entries_limit_exceeded");
        assert.deepEqual(error.resourceLimit, {
          code: "collector_resource_directory_entries_limit_exceeded",
          dimension: "directory_entries",
          limit: 1,
          observed: 2,
        });
        assert.equal(JSON.stringify(error).includes(fixture.root), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("recursive rollout discovery enforces a content-free rollout-file ceiling", async () => {
  const fixture = await collectorFixture();
  try {
    await writeFile(join(fixture.sessions, "second.jsonl"), "");
    await assert.rejects(
      () => discoverCollectorRollouts(fixture.codexHome, {
        maximumRolloutFiles: 1,
      }),
      (error) => {
        assert.equal(error.code, "collector_resource_rollout_files_limit_exceeded");
        assert.deepEqual(error.resourceLimit, {
          code: "collector_resource_rollout_files_limit_exceeded",
          dimension: "rollout_files",
          limit: 1,
          observed: 2,
        });
        assert.equal(JSON.stringify(error).includes(fixture.root), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once exposes discovery ceilings as a bounded pause without replacing the last good index", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  const clock = () => Date.parse("2026-07-23T00:01:00.000Z");
  try {
    const complete = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      clock,
    });
    assert.equal(complete.status, "complete");
    const checkpointBefore = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const dataBefore = await readFile(fixture.dataFile);
    await writeFile(join(fixture.sessions, "unrelated.txt"), "");

    const paused = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      maximumDiscoveryDirectoryEntries: 1,
      clock,
    });
    assert.equal(paused.status, "bounded_pause");
    assert.equal(paused.pauseReason, "collector_resource_directory_entries_limit_exceeded");
    assert.deepEqual(paused.resourceLimit, {
      code: "collector_resource_directory_entries_limit_exceeded",
      dimension: "directory_entries",
      limit: 1,
      observed: 2,
    });
    const checkpointPaused = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.deepEqual(checkpointPaused.files, checkpointBefore.files);
    assert.deepEqual(checkpointPaused.indexing, checkpointBefore.indexing);
    assert.deepEqual(await readFile(fixture.dataFile), dataBefore);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once restarts from byte checkpoints without duplicate records", async () => {
  const fixture = await collectorFixture([
    JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-test" } }),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
  ]);
  try {
    const options = { ...fixture, refreshStale: false, backfill: true, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    const first = await runCollectorOnce(options);
    const second = await runCollectorOnce(options);
    assert.equal(first.rolloutRecordsWritten, 2);
    assert.equal(second.rolloutRecordsWritten, 0);
    assert.equal((await readLines(fixture.dataFile)).length, 2);
    assert.equal((await stat(fixture.dataFile)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.checkpointFile)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("unified quota-only collection does not resume an inherited rollout backfill", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
  ]);
  const clock = () => Date.parse("2026-07-23T00:01:00.000Z");
  class MinimalClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const paused = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentRunBytes: 1,
      clock,
    });
    assert.equal(paused.status, "bounded_pause");
    const before = await readLocalCollectorState({
      stateFile: fixture.stateFile,
      includeRecords: true,
    });

    // The unified authority must remain usable even if the raw source is not
    // available to this collector pass. No discovery or rollout read is
    // needed for the independent provider quota snapshot.
    await rm(fixture.codexHome, { recursive: true, force: true });
    const options = {
      ...fixture,
      backfill: false,
      skipRolloutIngestion: true,
      staleAfterMs: 0,
      appServerFactory: () => new MinimalClient(),
      clock,
    };
    const first = await runCollectorOnce(options);
    const second = await runCollectorOnce(options);
    assert.equal(first.status, "complete");
    assert.equal(first.indexing.status, "bounded_pause");
    assert.equal(first.rolloutRecordsWritten, 0);
    assert.equal(first.filesDiscovered, 0);
    assert.equal(first.refresh.attempted, true);
    assert.equal(second.rolloutRecordsWritten, 0);
    const after = await readLocalCollectorState({
      stateFile: fixture.stateFile,
      includeRecords: true,
    });
    const rolloutCount = (state) => state.records.filter(
      (record) => record.kind === "codex_rollout_usage_snapshot",
    ).length;
    assert.equal(rolloutCount(after), rolloutCount(before));
    assert.equal(
      after.records.filter((record) => record.kind === "codex_rollout_usage_snapshot").length,
      0,
    );
    assert.equal(
      after.records.filter((record) => record.kind === "codex_quota_snapshot").length,
      1,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fresh recent backfill selects only overlapping archives and reports content-free progress", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  const oldArchive = join(
    fixture.archive,
    "rollout-2026-06-01T00-00-00-old.jsonl",
  );
  const recentArchive = join(
    fixture.archive,
    "rollout-2026-07-22T00-00-00-recent.jsonl",
  );
  try {
    await writeFile(
      oldArchive,
      `${tokenRecord("2026-06-01T00:00:01.000Z", usage(10), usage(10), 1)}\n`,
    );
    await utimes(
      oldArchive,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await writeFile(
      recentArchive,
      `${tokenRecord("2026-07-22T00:00:01.000Z", usage(10), usage(10), 2)}\n`,
    );
    const progress = [];
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-16T00:00:00.000Z",
      onProgress: (value) => progress.push(value),
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.filesDiscovered, 3);
    assert.equal(result.filesSelected, 2);
    assert.equal(result.rolloutRecordsWritten, 2);
    assert.deepEqual(result.indexing, {
      mode: "recent_7d",
      status: "recent_7d_complete",
      phase: "complete",
      boundedBy: "modified_at_and_collection_start",
      filesDiscovered: 3,
      filesSelected: 2,
      filesProcessed: 2,
      recordsWritten: 2,
      coveredAt: {
        startAt: "2026-07-16T00:00:00.000Z",
        endAt: "2026-07-23T00:01:00.000Z",
      },
    });
    assert.ok(progress.length >= 3);
    assert.ok(progress.every((value) => {
      const serialized = JSON.stringify(value);
      return !serialized.includes(fixture.root)
        && !serialized.includes("old.jsonl")
        && !serialized.includes("recent.jsonl");
    }));
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
    assert.equal(Object.keys(result).includes("stateFile"), false);
    assert.equal(result.stateFile, fixture.stateFile);
    assert.equal((await readLines(fixture.dataFile)).length, 2);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.deepEqual(checkpoint.indexing, result.indexing);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("large active rollouts use a bounded recent tail and preserve pre-boundary state", async () => {
  const recent = tokenRecord(
    "2026-07-23T00:00:01.000Z",
    usage(125),
    usage(25),
    2,
  );
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-19T23:59:57.000Z",
      type: "session_meta",
      payload: { id: "private-session-value", originator: "codex" },
    }),
    JSON.stringify({
      timestamp: "2026-07-19T23:59:58.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
    tierRecord("2026-07-19T23:59:58.500Z", "default"),
    tokenRecord(
      "2026-07-19T23:59:59.000Z",
      usage(100),
      usage(100),
      1,
    ),
    JSON.stringify({
      timestamp: "2026-07-22T23:59:59.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(600) },
    }),
    recent,
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes: Buffer.byteLength(recent) + 128,
      maximumRecentPreludeBytes: 4 * 1024,
      maximumRecentRunBytes: 16 * 1024,
      maximumLineagePrefixBytes: 2 * 1024,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.status, "complete");
    assert.equal(result.indexing.status, "recent_7d_complete");
    assert.equal(result.rolloutRecordsWritten, 1);
    const [record] = await readLines(fixture.dataFile);
    assert.equal(record.observedAt, "2026-07-23T00:00:01.000Z");
    assert.equal(record.model, "gpt-test");
    assert.equal(record.components.input_uncached_tokens, 25);
    assert.equal(record.tierSemantics.codexSpeedMode, "standard");
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const [cursor] = Object.values(checkpoint.files);
    assert.equal(cursor.recentTail.strategy, "bounded_recent_tail_v0.2");
    assert.equal(cursor.recentTail.coverageComplete, true);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a bounded tail that cannot reach the requested boundary is reported as partial", async () => {
  const recent = tokenRecord(
    "2026-07-23T00:00:01.000Z",
    usage(25),
    usage(25),
    2,
  );
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-22T23:59:59.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(900) },
    }),
    recent,
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes: Buffer.byteLength(recent) + 64,
      maximumRecentPreludeBytes: 32,
      maximumRecentRunBytes: 8 * 1024,
      maximumLineagePrefixBytes: 64,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.status, "partial");
    assert.equal(result.indexing.status, "recent_7d_partial");
    assert.equal(result.indexing.phase, "complete");
    assert.equal(result.indexing.coveredAt.startAt, "2026-07-23T00:00:01.000Z");
    assert.equal(result.rolloutRecordsWritten, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("an in-window token event seen only in the state prelude cannot make coverage complete", async () => {
  const omittedPreludeEvent = tokenRecord(
    "2026-07-22T23:59:58.000Z",
    usage(20),
    usage(20),
    1,
  );
  const retainedTailEvent = tokenRecord(
    "2026-07-23T00:00:01.000Z",
    usage(25),
    usage(5),
    2,
  );
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-19T23:59:59.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
    omittedPreludeEvent,
    JSON.stringify({
      timestamp: "2026-07-23T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(500) },
    }),
    retainedTailEvent,
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes: Buffer.byteLength(retainedTailEvent) + 64,
      maximumRecentPreludeBytes: 4 * 1024,
      maximumRecentRunBytes: 16 * 1024,
      maximumLineagePrefixBytes: 512,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.status, "partial");
    assert.equal(result.indexing.status, "recent_7d_partial");
    const records = await readLines(fixture.dataFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].observedAt, "2026-07-23T00:00:01.000Z");
    assert.equal(records[0].components.input_uncached_tokens, 5);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("out-of-order timestamps in a bounded tail cannot prove recent coverage complete", async () => {
  const firstRecent = tokenRecord(
    "2026-07-23T00:00:01.000Z",
    usage(10),
    usage(10),
    1,
  );
  const copiedOld = tokenRecord(
    "2026-07-19T23:59:59.000Z",
    usage(20),
    usage(10),
    2,
  );
  const lastRecent = tokenRecord(
    "2026-07-23T00:00:02.000Z",
    usage(30),
    usage(10),
    3,
  );
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-18T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(4 * 1024) },
    }),
    firstRecent,
    copiedOld,
    lastRecent,
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes:
        Buffer.byteLength(firstRecent)
        + Buffer.byteLength(copiedOld)
        + Buffer.byteLength(lastRecent)
        + 128,
      maximumRecentPreludeBytes: 64,
      maximumRecentRunBytes: 32 * 1024,
      maximumLineagePrefixBytes: 64,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.status, "partial");
    assert.equal(result.indexing.status, "recent_7d_partial");
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const [cursor] = Object.values(checkpoint.files);
    assert.equal(cursor.recentTail.timestampOrderViolated, true);
    assert.equal(cursor.recentTail.coverageComplete, false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("timestamp order is checked across a resumed bounded-tail scan", async () => {
  const firstRecent = tokenRecord(
    "2026-07-23T00:00:01.000Z",
    usage(10),
    usage(10),
    1,
  );
  const copiedOld = tokenRecord(
    "2026-07-19T23:59:59.000Z",
    usage(20),
    usage(10),
    2,
  );
  const lastRecent = tokenRecord(
    "2026-07-23T00:00:02.000Z",
    usage(30),
    usage(10),
    3,
  );
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-18T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(4 * 1024) },
    }),
    firstRecent,
    copiedOld,
    lastRecent,
  ]);
  const controller = new AbortController();
  const options = {
    ...fixture,
    refreshStale: false,
    backfill: true,
    backfillSinceAt: "2026-07-20T00:00:00.000Z",
    maximumRecentTailBytes:
      Buffer.byteLength(firstRecent)
      + Buffer.byteLength(copiedOld)
      + Buffer.byteLength(lastRecent)
      + 128,
    maximumRecentPreludeBytes: 64,
    maximumRecentRunBytes: 32 * 1024,
    maximumLineagePrefixBytes: 64,
    maximumRecordBatchSize: 1,
    clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
  };
  try {
    const paused = await runCollectorOnce({
      ...options,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.recordsWritten >= 1) controller.abort();
      },
    });
    assert.equal(paused.status, "bounded_pause");
    const pausedCheckpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const [pausedCursor] = Object.values(pausedCheckpoint.files);
    assert.equal(pausedCursor.recentTail.lastScannedAt, "2026-07-23T00:00:01.000Z");
    assert.equal(pausedCursor.recentTail.timestampOrderViolated, false);

    const resumed = await runCollectorOnce(options);
    assert.equal(resumed.status, "partial");
    assert.equal(resumed.indexing.status, "recent_7d_partial");
    const resumedCheckpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const [resumedCursor] = Object.values(resumedCheckpoint.files);
    assert.equal(resumedCursor.recentTail.timestampOrderViolated, true);
    assert.equal(resumedCursor.recentTail.orderingVerified, false);
    assert.equal(resumedCursor.recentTail.coverageComplete, false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("the recent-run byte budget pauses before reading the next source and resumes safely", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  const second = join(
    fixture.sessions,
    "rollout-2026-07-23T00-01-00-second.jsonl",
  );
  try {
    await writeFile(
      second,
      `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 2)}\n`,
    );
    const firstSize = (await stat(fixture.rollout)).size;
    const options = {
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes: 16 * 1024,
      maximumRecentPreludeBytes: 64,
      maximumRecentRunBytes: firstSize + 1,
      maximumLineagePrefixBytes: 1,
      clock: () => Date.parse("2026-07-23T00:02:00.000Z"),
    };
    const first = await runCollectorOnce(options);
    assert.equal(first.status, "bounded_pause");
    assert.equal(first.filesProcessed, 1);
    assert.equal((await readLines(fixture.dataFile)).length, 1);

    const reseeded = await runCollectorOnce(options);
    assert.equal(reseeded.status, "bounded_pause");
    assert.equal(reseeded.filesProcessed, 1);
    const resumed = await runCollectorOnce(options);
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.filesProcessed, 2);
    assert.equal((await readLines(fixture.dataFile)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("the per-run byte ceiling also pauses a post-index delta without advancing durable state", async () => {
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-23T00:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  const clock = () => Date.parse("2026-07-23T00:02:00.000Z");
  try {
    const initial = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      clock,
    });
    assert.equal(initial.status, "complete");
    const checkpointBefore = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const dataBefore = await readFile(fixture.dataFile);
    const delta = `${tokenRecord("2026-07-23T00:01:01.000Z", usage(20), usage(10), 2)}\n`;
    await appendFile(fixture.rollout, delta);

    const paused = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      maximumRecentRunBytes: Buffer.byteLength(delta) - 1,
      clock,
    });
    assert.equal(paused.status, "bounded_pause");
    assert.equal(paused.pauseReason, "collector_resource_source_bytes_limit_exceeded");
    assert.deepEqual(paused.resourceLimit, {
      code: "collector_resource_source_bytes_limit_exceeded",
      dimension: "source_bytes",
      limit: Buffer.byteLength(delta) - 1,
      observed: Buffer.byteLength(delta),
    });
    assert.equal(paused.rolloutRecordsWritten, 0);
    const checkpointPaused = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.deepEqual(checkpointPaused.files, checkpointBefore.files);
    assert.deepEqual(checkpointPaused.recentEventKeys, checkpointBefore.recentEventKeys);
    assert.deepEqual(await readFile(fixture.dataFile), dataBefore);

    const resumed = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      maximumRecentRunBytes: Buffer.byteLength(delta),
      clock,
    });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.rolloutRecordsWritten, 1);
    assert.equal((await readLines(fixture.dataFile)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("alignment bytes are reserved before an oversized recent tail is opened", async () => {
  const fixture = await collectorFixture([
    JSON.stringify({
      timestamp: "2026-07-22T23:59:59.000Z",
      type: "event_msg",
      payload: { type: "irrelevant", padding: "x".repeat(2 * 1024) },
    }),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      maximumRecentTailBytes: 256,
      maximumRecentPreludeBytes: 64,
      maximumRecentRunBytes: 639,
      maximumLineagePrefixBytes: 64,
      maximumBufferedLineBytes: 256,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.status, "bounded_pause");
    assert.equal(result.filesProcessed, 0);
    assert.equal((await readLines(fixture.dataFile)).length, 0);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.deepEqual(checkpoint.files, {});
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a first cumulative total without a last-usage baseline is never charged as a delta", async () => {
  const withoutLast = (timestamp, total, percent) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total },
      rate_limits: rateLimits(percent),
    },
  });
  const fixture = await collectorFixture([
    withoutLast("2026-07-23T00:00:01.000Z", usage(100), 1),
    withoutLast("2026-07-23T00:00:02.000Z", usage(130), 2),
  ]);
  try {
    await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-20T00:00:00.000Z",
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    assert.equal(records.length, 2);
    assert.equal(records[0].components, null);
    assert.equal(records[1].components.input_uncached_tokens, 30);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("recent backfill pauses on abort and resumes from the durable checkpoint", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
  ]);
  const controller = new AbortController();
  try {
    const first = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-16T00:00:00.000Z",
      maximumRecordBatchSize: 1,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.recordsWritten >= 1) controller.abort();
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(first.status, "bounded_pause");
    assert.equal(first.indexing.status, "bounded_pause");
    assert.equal(first.indexing.phase, "paused");
    assert.equal(first.indexing.coveredAt.endAt, null);
    assert.equal((await readLines(fixture.dataFile)).length, 1);

    const resumed = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-16T00:00:00.000Z",
      maximumRecordBatchSize: 1,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.indexing.status, "recent_7d_complete");
    assert.equal(resumed.indexing.recordsWritten, 2);
    assert.equal((await readLines(fixture.dataFile)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a backfill request never rewinds an existing prospective checkpoint", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-01T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  const now = Date.parse("2026-07-23T00:01:00.000Z");
  try {
    await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      clock: () => now,
    });
    const before = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      backfillSinceAt: "2026-07-16T00:00:00.000Z",
      clock: () => now,
    });
    const after = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));

    assert.equal(after.collectionStartedAt, before.collectionStartedAt);
    assert.equal(result.indexing.mode, "prospective");
    assert.equal(result.indexing.status, "prospective_only");
    assert.equal((await readLines(fixture.dataFile)).length, 0);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("first-start EOF seeding recovers active model context and cumulative counters", async () => {
  const fixture = await collectorFixture([
    JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-test" } }),
    tierRecord("2026-07-23T00:00:00.500Z", "default"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  try {
    const options = { ...fixture, refreshStale: false, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    const initial = await runCollectorOnce(options);
    assert.equal(initial.rolloutRecordsWritten, 0);
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:02.000Z", usage(25), usage(15), 2)}\n`);
    const resumed = await runCollectorOnce(options);
    assert.equal(resumed.rolloutRecordsWritten, 1);
    const [record] = await readLines(fixture.dataFile);
    assert.equal(record.model, "gpt-test");
    assert.equal(record.components.input_uncached_tokens, 15);
    assert.equal(record.tierSemantics.codexSpeedMode, "standard");
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("collector propagates only timestamped tier state, preserves omissions, and clears explicitly", async () => {
  const fixture = await collectorFixture([
    tierRecord("2026-07-23T00:00:00.000Z", "default"),
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tierRecord("2026-07-23T00:00:02.000Z", undefined, { omitTier: true }),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(20), usage(10), 2),
    tierRecord("2026-07-23T00:00:04.000Z", "priority"),
    tokenRecord("2026-07-23T00:00:05.000Z", usage(30), usage(10), 3),
    tierRecord("2026-07-23T00:00:06.000Z", null),
    tokenRecord("2026-07-23T00:00:07.000Z", usage(40), usage(10), 4),
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    assert.deepEqual(records.map((record) => record.tierSemantics.codexSpeedMode), ["standard", "standard", "fast", "unknown"]);
    assert.deepEqual(records.map((record) => record.tierSemantics.apiServiceTier), ["unknown", "unknown", "unknown", "unknown"]);
    assert.equal(result.diagnostics.tierSettingEvents, 3);
    assert.equal(result.diagnostics.tierSettingOmissions, 1);
    const serialized = JSON.stringify({ records, checkpoint: result.diagnostics });
    assert.equal(serialized.includes("/sensitive/local/path"), false);
    assert.equal(serialized.includes("sensitive-model-setting"), false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("collector marks tier unavailable when a setting timestamp follows the usage timestamp", async () => {
  const fixture = await collectorFixture([
    tierRecord("2026-07-23T00:00:03.000Z", "priority"),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:04.000Z", usage(20), usage(10), 2),
  ]);
  try {
    await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    assert.deepEqual(records.map((record) => record.tierSemantics.codexSpeedMode), ["unknown", "fast"]);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a partial final line is deferred and consumed after completion", async () => {
  const fixture = await collectorFixture();
  try {
    const complete = tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1);
    const split = Math.floor(complete.length / 2);
    await writeFile(fixture.rollout, complete.slice(0, split));
    const options = { ...fixture, refreshStale: false, backfill: true, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    const first = await runCollectorOnce(options);
    await appendFile(fixture.rollout, `${complete.slice(split)}\n`);
    const second = await runCollectorOnce(options);
    assert.equal(first.rolloutRecordsWritten, 0);
    assert.equal(first.diagnostics.partialLinesDeferred, 1);
    assert.equal(second.rolloutRecordsWritten, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("collector streams appended files and skips an oversized line without losing the following token record", async () => {
  const fixture = await collectorFixture();
  try {
    await writeFile(fixture.rollout, `${"x".repeat(2_048)}\n${tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1)}\n`);
    const result = await runCollectorOnce({
      ...fixture,
      backfill: true,
      refreshStale: false,
      maximumBufferedLineBytes: 1_024,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(result.rolloutRecordsWritten, 1);
    assert.equal(result.diagnostics.oversizedLinesSkipped, 1);
    assert.equal((await readLines(fixture.dataFile))[0].components.input_uncached_tokens, 10);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("collector bounds record buffering and commits a large backfill in batches", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), 3),
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      backfill: true,
      refreshStale: false,
      maximumRecordBatchSize: 2,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(result.rolloutRecordsWritten, 3);
    assert.equal(result.recordBatchesWritten, 2);
    assert.equal(result.maximumBufferedRecords, 2);
    assert.equal(result.diagnostics.rolloutRecordBatchesWritten, 2);
    assert.equal((await readLines(fixture.dataFile)).length, 3);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("collector compacts recent event keys once per batch", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), 3),
    tokenRecord("2026-07-23T00:00:04.000Z", usage(40), usage(10), 4),
    tokenRecord("2026-07-23T00:00:05.000Z", usage(50), usage(10), 5),
  ]);
  try {
    await runCollectorOnce({
      ...fixture,
      backfill: true,
      refreshStale: false,
      maximumRecordBatchSize: 2,
      maximumRecentEventKeys: 3,
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.equal(checkpoint.recentEventKeys.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a failed SQLite transaction leaves no partial collector batch and retries exactly once", async () => {
  const fixture = await collectorFixture();
  try {
    const options = { ...fixture, refreshStale: false, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    await runCollectorOnce(options);
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 1)}\n`);
    await assert.rejects(() => runCollectorOnce({
      ...options,
      commitState: async () => {
        throw new Error("injected sqlite transaction failure");
      },
    }), /injected sqlite transaction failure/);
    assert.equal((await readLines(fixture.dataFile)).length, 0);
    const retried = await runCollectorOnce(options);
    assert.equal(retried.rolloutRecordsWritten, 1);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a committed SQLite batch is retained when its caller loses the acknowledgment", async () => {
  const fixture = await collectorFixture();
  try {
    const options = { ...fixture, refreshStale: false, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    await runCollectorOnce(options);
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 1)}\n`);
    await assert.rejects(() => runCollectorOnce({
      ...options,
      commitState: async (commit) => {
        await commitLocalCollectorState(commit);
        throw new Error("injected post-commit acknowledgment failure");
      },
    }), /injected post-commit acknowledgment failure/);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
    const retried = await runCollectorOnce(options);
    assert.equal(retried.rolloutRecordsWritten, 0);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("truncation is detected and archive movement does not replay an inode", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 2),
    tokenRecord("2026-07-23T00:00:03.000Z", usage(30), usage(10), 3),
  ]);
  try {
    const options = { ...fixture, refreshStale: false, backfill: true, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    await runCollectorOnce(options);
    await writeFile(fixture.rollout, `${tokenRecord("2026-07-23T00:00:04.000Z", usage(5), usage(5), 4)}\n`);
    const truncated = await runCollectorOnce(options);
    assert.equal(truncated.diagnostics.filesTruncated, 1);
    assert.equal(truncated.rolloutRecordsWritten, 1);
    const archived = join(fixture.archive, "rollout-2026-07-23T00-00-00-fixture.jsonl");
    await rename(fixture.rollout, archived);
    const moved = await runCollectorOnce(options);
    assert.equal(moved.rolloutRecordsWritten, 0);
    assert.equal((await readLines(fixture.dataFile)).length, 4);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("active copy wins over an archive duplicate", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1),
  ]);
  try {
    await writeFile(join(fixture.archive, "rollout-2026-07-23T00-00-00-fixture.jsonl"), `${tokenRecord("2026-07-23T00:00:01.000Z", usage(999), usage(999), 99)}\n`);
    const result = await runCollectorOnce({ ...fixture, refreshStale: false, backfill: true, clock: () => Date.parse("2026-07-23T00:01:00.000Z") });
    assert.equal(result.filesDiscovered, 1);
    const records = await readLines(fixture.dataFile);
    assert.equal(records[0].windows[0].usedPercent, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("clock reversal is clamped and a reset change while offline remains separate", async () => {
  const fixture = await collectorFixture([
    tokenRecord("2026-07-23T00:00:01.000Z", usage(10), usage(10), 1, 1784854800),
    tokenRecord("2026-07-23T00:00:02.000Z", usage(20), usage(10), 0, 1785459600),
  ]);
  try {
    const result = await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      backfill: true,
      clock: () => Date.parse("2026-07-22T23:59:00.000Z"),
    });
    assert.equal(result.rolloutRecordsWritten, 2);
    const records = await readLines(fixture.dataFile);
    assert.deepEqual(records.map((record) => record.stalenessMs), [0, 0]);
    assert.equal(new Set(records.map((record) => record.windows[0].resetsAt)).size, 2);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("notification event identity deduplicates repeated snapshots without retaining account fields", () => {
  const first = appServerSnapshotRecord(appPayload(5), { source: "app_server_notification", receivedAt: "2026-07-23T00:00:00.000Z" });
  const repeated = appServerSnapshotRecord(appPayload(5), { source: "app_server_notification", receivedAt: "2026-07-23T00:00:10.000Z" });
  assert.equal(first.eventKey, repeated.eventKey);
  assert.equal(first.stalenessMs, 0);
  assert.equal(JSON.stringify(first).includes("fixture"), false);
});

test("app-server records retain bounded local names without making them quota identity", () => {
  const payload = (futureName) => ({
    rateLimits: {
      limitId: "codex",
      limitName: null,
      planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1784854800 },
      secondary: null,
    },
    rateLimitsByLimitId: {
      future_alpha: {
        limitId: "future_alpha",
        limitName: futureName,
        planType: "plus",
        primary: { usedPercent: 10, windowDurationMins: 1_440, resetsAt: 1784854800 },
        secondary: null,
      },
      future_beta: {
        limitId: "future_beta",
        limitName: "Account alice@example.com",
        planType: "plus",
        primary: { usedPercent: 20, windowDurationMins: 43_200, resetsAt: 1784854800 },
        secondary: null,
      },
    },
  });
  const first = appServerSnapshotRecord(payload("Future Alpha"), {
    source: "app_server_notification",
    receivedAt: "2026-07-23T00:00:00.000Z",
  });
  const renamed = appServerSnapshotRecord(payload("Future Alpha Preview"), {
    source: "app_server_notification",
    receivedAt: "2026-07-23T00:00:10.000Z",
  });

  assert.deepEqual(
    first.windows.map((window) => [
      window.limitId,
      window.limitName ?? null,
      window.windowDurationMins,
    ]),
    [
      ["codex", null, 300],
      ["future_alpha", "Future Alpha", 1_440],
      ["future_beta", null, 43_200],
    ],
  );
  assert.equal(first.eventKey, renamed.eventKey);
  assert.notEqual(first.windows[1].limitName, renamed.windows[1].limitName);
});

test("fresh direct app-server records expose a closed local notification projection", () => {
  assert.equal(notificationEvidenceFromAppServerRecord(null), null);
  const rateLimit = appPayload(84).rateLimits;
  const record = appServerSnapshotRecord({
    accountScope: {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: `openai-account:v1:${"A".repeat(43)}`,
      planType: "pro",
    },
    canonical: rateLimit,
    byLimitId: { codex: rateLimit },
  }, {
    source: "app_server_read",
    receivedAt: "2026-07-23T00:00:00.000Z",
  });
  const evidence = notificationEvidenceFromAppServerRecord(record);
  assert.deepEqual(evidence, {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-07-23T00:00:00.000Z",
    continuityKey: evidence.continuityKey,
    windows: [{
      lane: "primary",
      usedPercent: 84,
      durationMinutes: 10080,
      resetAt: new Date(1784854800 * 1_000).toISOString(),
      resetProofKind: "provider_reported_schedule_only",
    }],
  });
  assert.match(evidence.continuityKey, /^[A-Za-z0-9_-]{43}$/u);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(record.accountScope.scopeId), false);
  assert.equal(serialized.includes("planType"), false);
  assert.equal(
    notificationEvidenceFromAppServerRecord({
      ...record,
      source: "app_server_notification",
    }),
    null,
  );
  assert.equal(
    notificationEvidenceFromAppServerRecord({ ...record, stalenessMs: 1 }),
    null,
  );
  assert.equal(
    notificationEvidenceFromAppServerRecord({
      ...record,
      accountScope: { ...record.accountScope, scopeId: null },
    }),
    null,
  );
  assert.equal(
    notificationEvidenceFromAppServerRecord({
      ...record,
      windows: [{ ...record.windows[0], windowDurationMins: 60 }],
    }),
    null,
  );
});

test("Spark windows in a fresh snapshot leave the codex notification evidence intact", () => {
  const codexLimit = {
    limitId: "codex",
    planType: "pro",
    primary: { usedPercent: 84, windowDurationMins: 300, resetsAt: 1784768400 },
    secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1785369600 },
  };
  // The Spark limit's re-introduced two-slot shape, exactly as observed on
  // the wire 2026-08-19: the 5-hour window in the limit's primary slot with
  // the Spark seven-day window alongside in secondary. Both durations mirror
  // the codex ones, so only the limit id separates the pools.
  const sparkLimit = {
    limitId: "codex_bengalfox",
    planType: "pro",
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787201379 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1787788179 },
  };
  // The Spark shape live from 2026-07-23 to 2026-08-19: one 365-day window
  // under a provider-private plan label that normalizes to "unknown". Every
  // numeric and plan rule the codex windows must satisfy fails here, which is
  // exactly why holding Spark windows to those rules suppressed evidence.
  const earlySparkLimit = {
    limitId: "codex_bengalfox",
    planType: "provider-private-plan",
    primary: { usedPercent: 40, windowDurationMins: 525600, resetsAt: 1817001960 },
    secondary: null,
  };
  const recordWith = (byLimitId, canonical = codexLimit) => appServerSnapshotRecord({
    accountScope: {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: `openai-account:v1:${"B".repeat(43)}`,
      planType: "pro",
    },
    canonical,
    byLimitId,
  }, {
    source: "app_server_read",
    receivedAt: "2026-07-23T00:00:00.000Z",
  });

  const record = recordWith({ codex: codexLimit, codex_bengalfox: sparkLimit });
  assert.equal(record.windows.length, 4);
  const evidence = notificationEvidenceFromAppServerRecord(record);
  assert.deepEqual(evidence, {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-07-23T00:00:00.000Z",
    continuityKey: evidence.continuityKey,
    windows: [{
      lane: "primary",
      usedPercent: 84,
      durationMinutes: 300,
      resetAt: new Date(1784768400 * 1_000).toISOString(),
      resetProofKind: "provider_reported_schedule_only",
    }, {
      lane: "secondary",
      usedPercent: 21,
      durationMinutes: 10080,
      resetAt: new Date(1785369600 * 1_000).toISOString(),
      resetProofKind: "provider_reported_schedule_only",
    }],
  });
  assert.equal(JSON.stringify(evidence).includes("bengalfox"), false);
  assert.notEqual(
    notificationEvidenceFromAppServerRecord(
      recordWith({ codex: codexLimit, codex_bengalfox: earlySparkLimit }),
    ),
    null,
  );
  assert.notEqual(
    notificationEvidenceFromAppServerRecord(
      recordWith({ codex: codexLimit, "codex-spark": sparkLimit }),
    ),
    null,
  );
  // A Spark-only snapshot has no codex windows to be evidence about.
  assert.equal(
    notificationEvidenceFromAppServerRecord(
      recordWith({ codex_bengalfox: sparkLimit }, sparkLimit),
    ),
    null,
  );
  // The fail-closed posture survives for genuinely unfamiliar limit ids and
  // for corrupted entries; only the recognized Spark pool is passed over.
  assert.equal(
    notificationEvidenceFromAppServerRecord(
      recordWith({ codex: codexLimit, codex_quokka: { ...sparkLimit, limitId: "codex_quokka" } }),
    ),
    null,
  );
  const sparkWindow = record.windows.find((window) => window.limitId === "codex_bengalfox");
  assert.equal(
    notificationEvidenceFromAppServerRecord({
      ...record,
      windows: [...record.windows, { ...sparkWindow, provider: "unknown" }],
    }),
    null,
  );
  // An invalid codex window still suppresses even with Spark alongside.
  assert.equal(
    notificationEvidenceFromAppServerRecord({
      ...record,
      windows: record.windows.map((window) => (window.limitId === "codex" && window.slot === "primary"
        ? { ...window, windowDurationMins: 60 }
        : window)),
    }),
    null,
  );
});

test("a fresh app-server account marker provisionally scopes only new nearby rollout events", async () => {
  const fixture = await collectorFixture();
  const accountSecret = Buffer.alloc(32, 81);
  class ScopedClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return { account: { email: "private.owner@example.test", planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const firstRefresh = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new ScopedClient(),
      loadAccountObservationSecret: async () => Buffer.from(accountSecret),
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(
      firstRefresh.refresh.notificationEvidence?.source,
      "app_server_read",
    );
    assert.match(
      firstRefresh.refresh.notificationEvidence?.continuityKey ?? "",
      /^[A-Za-z0-9_-]{43}$/u,
    );
    assert.equal(
      JSON.stringify(firstRefresh.refresh.notificationEvidence)
        .includes("private.owner"),
      false,
    );
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 2)}\n`);
    await runCollectorOnce({
      ...fixture,
      refreshStale: false,
      appServerFactory: () => new ScopedClient(),
      clock: () => Date.parse("2026-07-23T00:01:02.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    const rollout = records.find((record) => record.kind === "codex_rollout_usage_snapshot");
    assert.equal(rollout.accountScope.status, "available");
    assert.equal(rollout.accountScopeAttribution, "provisional_fresh_app_server_marker");
    assert.equal(JSON.stringify(records).includes("private.owner"), false);
    assert.equal(JSON.stringify(records).includes(accountSecret.toString("base64url")), false);
    assert.equal((await readFile(fixture.checkpointFile, "utf8")).includes(accountSecret.toString("base64url")), false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a refresh whose snapshot carries Spark windows still exposes notification evidence", async () => {
  const fixture = await collectorFixture();
  const accountSecret = Buffer.alloc(32, 82);
  class SparkClient {
    async start() {}
    async readRateLimits() {
      return {
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1784854800 },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            planType: "pro",
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787201379 },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1787788179 },
          },
        },
      };
    }
    async readAccount() { return { account: { email: "spark.owner@example.test", planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const result = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new SparkClient(),
      loadAccountObservationSecret: async () => Buffer.from(accountSecret),
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(result.refresh.recordWritten, true);
    assert.deepEqual(
      result.refresh.notificationEvidence?.windows.map(
        (window) => [window.lane, window.durationMinutes, window.usedPercent],
      ),
      [["primary", 10_080, 61]],
    );
    assert.equal(JSON.stringify(result.refresh.notificationEvidence).includes("bengalfox"), false);
    // The evidence projection narrows; the committed record still archives
    // the Spark windows themselves.
    const records = await readLines(fixture.dataFile);
    const snapshot = records.find((record) => record.kind === "codex_quota_snapshot");
    assert.deepEqual(
      snapshot.windows.map((window) => [window.limitId, window.slot]),
      [["codex", "primary"], ["codex_bengalfox", "primary"], ["codex_bengalfox", "secondary"]],
    );
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once distinguishes an app-server authentication failure without losing checkpoint progress", async () => {
  const fixture = await collectorFixture();
  class FailingClient {
    async start() {
      throw new CodexAppServerError("authentication_failure", "not authenticated");
    }
    close() {}
  }
  try {
    const result = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new FailingClient(),
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(result.refresh.attempted, true);
    assert.equal(result.refresh.errorCode, "authentication_failure");
    assert.equal(result.diagnostics.appServerErrorCounts.authentication_failure, 1);
    assert.equal((await stat(fixture.checkpointFile)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a first-ever unified pass records a failed quota read instead of failing forever", async () => {
  const fixture = await collectorFixture();
  class UnavailableClient {
    async start() {
      throw new CodexAppServerError("app_server_unavailable", "Unable to start the Codex app-server");
    }
    close() {}
  }
  try {
    // No durable checkpoint exists before the first pass: the row is only
    // written after the quota refresh, so a failed provider read here used to
    // abort this pass — and, because the abort also skipped the save, every
    // later pass too.
    const options = {
      ...fixture,
      backfill: false,
      skipRolloutIngestion: true,
      staleAfterMs: 0,
      appServerFactory: () => new UnavailableClient(),
      clock: () => Date.parse("2026-08-19T00:01:00.000Z"),
    };
    const first = await runCollectorOnce(options);
    assert.equal(first.status, "complete");
    assert.equal(first.refresh.attempted, true);
    assert.equal(first.refresh.recordWritten, false);
    assert.equal(first.refresh.errorCode, "app_server_unavailable");
    assert.equal(first.diagnostics.appServerErrorCounts.app_server_unavailable, 1);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.equal(checkpoint.diagnostics.appServerErrorCounts.app_server_unavailable, 1);
    assert.equal(checkpoint.lastQuotaObservedAt, null);
    assert.equal(checkpoint.recentEventKeys.length, 0);

    // The pass persisted its checkpoint, so the next failing pass recovers
    // from the durable row and keeps counting.
    const second = await runCollectorOnce(options);
    assert.equal(second.status, "complete");
    assert.equal(second.refresh.errorCode, "app_server_unavailable");
    assert.equal(second.diagnostics.appServerErrorCounts.app_server_unavailable, 2);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a first-ever legacy pass with no rollouts survives a failed quota read", async () => {
  const fixture = await collectorFixture();
  class FailingClient {
    async start() {
      throw new CodexAppServerError("authentication_failure", "not authenticated");
    }
    close() {}
  }
  try {
    // A machine with no rollout history commits no ingestion change, so
    // nothing durable exists when the quota refresh fails.
    await rm(fixture.rollout);
    const result = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new FailingClient(),
      clock: () => Date.parse("2026-08-19T00:01:00.000Z"),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.refresh.attempted, true);
    assert.equal(result.refresh.errorCode, "authentication_failure");
    assert.equal(result.diagnostics.appServerErrorCounts.authentication_failure, 1);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.equal(checkpoint.diagnostics.appServerErrorCounts.authentication_failure, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a checkpoint that disappears mid-run still fails the pass under a stable code", async () => {
  const fixture = await collectorFixture();
  const clock = () => Date.parse("2026-08-19T00:01:00.000Z");
  class VanishingCheckpointClient {
    async start() {
      // Externally strip the checkpoint row between the run's opening read
      // and its recovery read, leaving the store itself healthy. First-run
      // recovery must not soften this: the run STARTED from a durable
      // checkpoint.
      const database = new DatabaseSync(fixture.stateFile);
      try {
        database.prepare("DELETE FROM meta WHERE key = 'checkpoint'").run();
      } finally {
        database.close();
      }
      throw new CodexAppServerError("temporary_disconnect", "connection lost");
    }
    close() {}
  }
  try {
    const seeded = await runCollectorOnce({ ...fixture, refreshStale: false, clock });
    assert.equal(seeded.status, "complete");
    await assert.rejects(
      () => runCollectorOnce({
        ...fixture,
        staleAfterMs: 0,
        appServerFactory: () => new VanishingCheckpointClient(),
        clock,
      }),
      (error) => {
        assert.equal(error.code, "app_record_checkpoint_unavailable");
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("run-once records quota safely without account attribution when the credential is unavailable", async () => {
  const fixture = await collectorFixture();
  const canary = "DO-NOT-LEAK-account-credential";
  class ScopedClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return { account: { email: "private.owner@example.test", planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const result = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new ScopedClient(),
      loadAccountObservationSecret: async () => { throw new Error(canary); },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].accountScope.status, "unavailable");
    assert.equal(records[0].accountScope.reason, "credential_unavailable");
    assert.equal(result.diagnostics.accountCredentialUnavailable, 1);
    assert.equal(JSON.stringify({ records, diagnostics: result.diagnostics }).includes(canary), false);
    assert.equal(JSON.stringify(records).includes("private.owner"), false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once distinguishes an active account credential lease from backend unavailability", async () => {
  const fixture = await collectorFixture();
  class ScopedClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return { account: { email: "private.owner@example.test", planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const result = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new ScopedClient(),
      loadAccountObservationSecret: async () => {
        const error = new Error("content-free upstream canary");
        error.code = "account_observation_credential_locked";
        throw error;
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    const records = await readLines(fixture.dataFile);
    assert.equal(records[0].accountScope.reason, "credential_locked");
    assert.equal(result.diagnostics.accountCredentialLocked, 1);
    assert.equal(result.diagnostics.accountCredentialUnavailable, 0);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once rolls back an app snapshot after checkpoint failure and retries it exactly once", async () => {
  const fixture = await collectorFixture();
  class SnapshotClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  const clock = () => Date.parse("2026-07-23T00:01:00.000Z");
  try {
    await runCollectorOnce({ ...fixture, refreshStale: false, clock });
    const failed = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new SnapshotClient(),
      clock,
      commitState: async () => {
        throw new Error("injected app transaction failure");
      },
    });
    assert.equal(failed.refresh.recordWritten, false);
    assert.equal(failed.refresh.errorCode, "temporary_disconnect");
    assert.equal((await readLines(fixture.dataFile)).length, 0);

    const retried = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new SnapshotClient(),
      clock,
    });
    assert.equal(retried.refresh.recordWritten, true);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("run-once restores app state after a SQLite transaction preparation failure", async () => {
  const fixture = await collectorFixture();
  class SnapshotClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  const clock = () => Date.parse("2026-07-23T00:01:00.000Z");
  try {
    await runCollectorOnce({ ...fixture, refreshStale: false, clock });
    const failed = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new SnapshotClient(),
      clock,
      commitState: async () => {
        throw new Error("injected transaction preparation failure");
      },
    });
    assert.equal(failed.refresh.recordWritten, false);
    assert.equal((await readLines(fixture.dataFile)).length, 0);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    assert.equal(checkpoint.lastQuotaObservedAt, null);
    assert.equal(checkpoint.accountScopeMarker, null);
    assert.equal(checkpoint.recentEventKeys.length, 0);

    const retried = await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new SnapshotClient(),
      clock,
    });
    assert.equal(retried.refresh.recordWritten, true);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("SQLite collector lock rejects contention and recovers a stale lock", async () => {
  const fixture = await collectorFixture();
  try {
    const release = await acquireLocalCollectorStateLock(fixture.stateFile, { processExists: () => true });
    await assert.rejects(
      () => acquireLocalCollectorStateLock(fixture.stateFile, { processExists: () => true }),
      /local_collector_state_lock_held/,
    );
    await release();
    const releaseRecovered = await acquireLocalCollectorStateLock(
      fixture.stateFile,
      { processExists: () => false },
    );
    await releaseRecovered();
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("foreground degrades to reconciliation when recursive watchers fail asynchronously", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  const canary = "DO-NOT-LEAK-watcher-error";
  let watcherCalls = 0;
  let watchersClosed = 0;
  let ingestionCalls = 0;
  let hardStop;

  class ErrorWatcher extends EventEmitter {
    closed = false;

    close() {
      if (this.closed) return;
      this.closed = true;
      watchersClosed += 1;
    }
  }

  class MinimalClient extends EventEmitter {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }

  try {
    await assert.rejects(
      () => runCollectorForeground({ ...fixture, signal: controller.signal, watchRoot: null }),
      /watchRoot must be a function/,
    );
    await assert.rejects(() => stat(fixture.lockFile), /ENOENT/);
    hardStop = setTimeout(() => controller.abort(), 10_000);
    const result = await runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 10,
      appServerFactory: () => new MinimalClient(),
      watchRoot: () => {
        watcherCalls += 1;
        const watcher = new ErrorWatcher();
        queueMicrotask(() => {
          const error = new Error(canary);
          error.code = "EMFILE";
          watcher.emit("error", error);
        });
        return watcher;
      },
      ingestUpdates: async (options) => {
        ingestionCalls += 1;
        const ingested = await ingestRolloutUpdates(options);
        if (ingestionCalls >= 3) queueMicrotask(() => controller.abort());
        return ingested;
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });

    assert.equal(result.shutdown, "clean");
    assert.equal(watcherCalls, 2);
    assert.equal(watchersClosed, 2);
    assert.ok(ingestionCalls >= 3);
    assert.equal(result.resourceActivity.watcherFallbackActive, true);
    assert.equal(result.diagnostics.watcherErrorCounts.EMFILE, 2);
    assert.equal(JSON.stringify(result).includes(canary), false);
  } finally {
    clearTimeout(hardStop);
    controller.abort();
    await rm(fixture.root, { recursive: true });
  }
});

test("foreground consumes a notification, reconnects, and shuts down cleanly", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  let factoryCalls = 0;
  class FakeClient extends EventEmitter {
    async start() {
      if (factoryCalls === 1) throw new CodexAppServerError("temporary_disconnect", "temporary");
      setTimeout(() => {
        this.emit("rateLimitsUpdated", appPayload(3));
        this.emit("rateLimitsUpdated", appPayload(3));
      }, 5);
    }
    async readRateLimits() {
      return appPayload(2);
    }
    close() {}
  }
  try {
    const hardStop = setTimeout(() => controller.abort(), 10_000);
    const foreground = runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 20,
      reconnectBaseMs: 5,
      appServerFactory: () => {
        factoryCalls += 1;
        return new FakeClient();
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const pending = await readLines(fixture.dataFile);
      const sources = new Set(pending.map((record) => record.source));
      if (sources.has("app_server_notification") && sources.has("app_server_read")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await foreground;
    clearTimeout(hardStop);
    const records = await readLines(fixture.dataFile);
    assert.equal(result.shutdown, "clean");
    assert.ok(result.reconnectAttempts >= 1);
    assert.ok(result.resourceActivity.checkpointWrites >= 2);
    assert.ok(result.resourceActivity.ingestionRuns >= 1);
    assert.ok(result.resourceActivity.reconciliationCycles >= 1);
    assert.equal(result.resourceActivity.reconciliationMs, 20);
    assert.equal(records.filter((record) => record.source === "app_server_notification").length, 1);
    assert.equal(records.filter((record) => record.source === "app_server_read").length, 1);
    await assert.rejects(() => stat(fixture.lockFile), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("foreground re-reads account scope before attributing a rate-limit notification", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  const secret = Buffer.alloc(32, 82);
  let currentEmail = "first.owner@example.test";
  let credentialLoads = 0;
  let nowMs = Date.parse("2026-07-23T00:01:00.000Z");
  class SwitchingClient extends EventEmitter {
    async start() {
      setTimeout(() => {
        currentEmail = "second.owner@example.test";
        nowMs = Date.parse("2026-07-23T00:01:02.000Z");
        this.emit("rateLimitsUpdated", appPayload(3));
        setTimeout(() => {
          appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:02.000Z", usage(10), usage(10), 3)}\n`);
        }, 5);
      }, 10);
    }
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return { account: { email: currentEmail, planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    const hardStop = setTimeout(() => controller.abort(), 10_000);
    const foreground = runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 20,
      appServerFactory: () => new SwitchingClient(),
      loadAccountObservationSecret: async () => {
        credentialLoads += 1;
        return Buffer.from(secret);
      },
      clock: () => nowMs,
    });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const pending = await readLines(fixture.dataFile);
      if (pending.some((record) => record.kind === "codex_rollout_usage_snapshot")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await foreground;
    clearTimeout(hardStop);
    const records = await readLines(fixture.dataFile);
    const rollout = records.find((record) => record.kind === "codex_rollout_usage_snapshot");
    assert.ok(rollout, "collector should ingest the post-switch rollout before shutdown");
    const expected = deriveOpenAIAccountScope({ account: { email: "second.owner@example.test" } }, { secret, planType: "pro" });
    const prior = deriveOpenAIAccountScope({ account: { email: "first.owner@example.test" } }, { secret, planType: "pro" });
    assert.equal(rollout.accountScope.scopeId, expected.scopeId);
    assert.notEqual(rollout.accountScope.scopeId, prior.scopeId);
    assert.ok(credentialLoads >= 2, "initial read and notification must independently reload the account capability");
    assert.equal(JSON.stringify(records).includes("owner@example.test"), false);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("foreground coalesces a notification burst to one pending payload and re-reads the switched account", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  const secret = Buffer.alloc(32, 83);
  let currentEmail = "first.burst@example.test";
  let accountReads = 0;
  let credentialLoads = 0;
  let nowMs = Date.parse("2026-07-23T00:01:00.000Z");
  let releaseFirstNotificationRead;
  const firstNotificationReadReleased = new Promise((resolve) => { releaseFirstNotificationRead = resolve; });
  let markFirstNotificationReadStarted;
  const firstNotificationReadStarted = new Promise((resolve) => { markFirstNotificationReadStarted = resolve; });
  let activeClient;
  let foreground;

  class BurstClient extends EventEmitter {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() {
      accountReads += 1;
      const observedEmail = currentEmail;
      if (accountReads === 2) {
        markFirstNotificationReadStarted();
        await firstNotificationReadReleased;
      }
      return { account: { email: observedEmail, planType: "pro" } };
    }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }

  try {
    const hardStop = setTimeout(() => controller.abort(), 10_000);
    foreground = runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 60_000,
      appServerFactory: () => {
        activeClient = new BurstClient();
        return activeClient;
      },
      loadAccountObservationSecret: async () => {
        credentialLoads += 1;
        return Buffer.from(secret);
      },
      clock: () => nowMs,
    });

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const records = await readLines(fixture.dataFile);
      if (records.some((record) => record.source === "app_server_read")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    activeClient.emit("rateLimitsUpdated", appPayload(3));
    await firstNotificationReadStarted;
    currentEmail = "second.burst@example.test";
    nowMs = Date.parse("2026-07-23T00:01:02.000Z");
    for (let percent = 1; percent <= 100; percent += 1) {
      activeClient.emit("rateLimitsUpdated", appPayload(percent));
    }
    releaseFirstNotificationRead();

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const records = await readLines(fixture.dataFile);
      const notifications = records.filter((record) => record.source === "app_server_notification");
      if (notifications.some((record) => record.windows[0].usedPercent === 100)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:02.000Z", usage(10), usage(10), 100)}\n`);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const records = await readLines(fixture.dataFile);
      if (records.some((record) => record.kind === "codex_rollout_usage_snapshot")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await foreground;
    clearTimeout(hardStop);

    const records = await readLines(fixture.dataFile);
    const notifications = records.filter((record) => record.source === "app_server_notification");
    assert.deepEqual(notifications.map((record) => record.windows[0].usedPercent), [3, 100]);
    const rollout = records.find((record) => record.kind === "codex_rollout_usage_snapshot");
    const expected = deriveOpenAIAccountScope({ account: { email: currentEmail } }, { secret, planType: "pro" });
    assert.equal(rollout.accountScope.scopeId, expected.scopeId);
    assert.equal(credentialLoads, 3, "initial read plus two processed notifications load the capability");
    assert.equal(result.resourceActivity.rateLimitNotificationEvents, 101);
    assert.equal(result.resourceActivity.rateLimitNotificationOperations, 1);
    assert.equal(result.resourceActivity.rateLimitNotificationPayloadsProcessed, 2);
    assert.equal(result.resourceActivity.rateLimitNotificationPayloadsCoalesced, 99);
    assert.equal(result.resourceActivity.maximumPendingRateLimitNotifications, 1);
    assert.equal(JSON.stringify(records).includes("burst@example.test"), false);
  } finally {
    controller.abort();
    releaseFirstNotificationRead?.();
    await foreground?.catch(() => {});
    await rm(fixture.root, { recursive: true });
  }
});

test("foreground notification processing preserves locked and unavailable credential reasons", async () => {
  for (const [credentialCode, expectedReason, diagnostic] of [
    ["account_observation_credential_locked", "credential_locked", "accountCredentialLocked"],
    ["account_observation_credential_unavailable", "credential_unavailable", "accountCredentialUnavailable"],
  ]) {
    const fixture = await collectorFixture();
    const controller = new AbortController();
    let activeClient;
    let credentialLoads = 0;
    let foreground;
    class CredentialStateClient extends EventEmitter {
      async start() {}
      async readRateLimits() { return appPayload(2); }
      async readAccount() { return { account: { email: "private.state@example.test", planType: "pro" } }; }
      async readAccountUsage() { return { dailyUsageBuckets: [] }; }
      close() {}
    }
    try {
      foreground = runCollectorForeground({
        ...fixture,
        signal: controller.signal,
        staleAfterMs: 0,
        reconciliationMs: 60_000,
        appServerFactory: () => {
          activeClient = new CredentialStateClient();
          return activeClient;
        },
        loadAccountObservationSecret: async () => {
          credentialLoads += 1;
          if (credentialLoads === 1) return Buffer.alloc(32, 84);
          const error = new Error("DO-NOT-LEAK-foreground-credential");
          error.code = credentialCode;
          throw error;
        },
        clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
      });
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const records = await readLines(fixture.dataFile);
        if (records.some((record) => record.source === "app_server_read")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      activeClient.emit("rateLimitsUpdated", appPayload(4));
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const records = await readLines(fixture.dataFile);
        if (records.some((record) => record.source === "app_server_notification")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      const result = await foreground;
      const notification = (await readLines(fixture.dataFile))
        .find((record) => record.source === "app_server_notification");
      assert.equal(notification.accountScope.status, "unavailable");
      assert.equal(notification.accountScope.reason, expectedReason);
      assert.equal(result.diagnostics[diagnostic], 1);
      assert.equal(result.resourceActivity.maximumPendingRateLimitNotifications, 1);
      assert.equal(JSON.stringify({ notification, diagnostics: result.diagnostics })
        .includes("DO-NOT-LEAK-foreground-credential"), false);
    } finally {
      controller.abort();
      await foreground?.catch(() => {});
      await rm(fixture.root, { recursive: true });
    }
  }
});

test("foreground ingestion queue recovers after one transient failure", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  let attempts = 0;
  class MinimalClient extends EventEmitter {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    // SQLite initialization and its first durable transaction can take longer
    // than the old JSON checkpoint write on a cold filesystem. Leave enough
    // time for the scheduled reconciliation to demonstrate recovery.
    setTimeout(() => controller.abort(), 300);
    const result = await runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 20,
      appServerFactory: () => new MinimalClient(),
      ingestUpdates: async (options) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("temporary fixture failure");
          error.code = "EIO";
          throw error;
        }
        return ingestRolloutUpdates(options);
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    assert.equal(result.shutdown, "clean");
    assert.ok(attempts >= 2);
    assert.equal(result.diagnostics.ingestionErrorCounts["rollout_ingestion:EIO"], 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("idle reconciliation does not rewrite the full checkpoint every cycle", async () => {
  const fixture = await collectorFixture();
  const controller = new AbortController();
  class IdleClient extends EventEmitter {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return null; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    let ingestionCalls = 0;
    const hardStop = setTimeout(() => controller.abort(), 1_000);
    const result = await runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 15,
      appServerFactory: () => new IdleClient(),
      ingestUpdates: async (options) => {
        const result = await ingestRolloutUpdates(options);
        ingestionCalls += 1;
        if (ingestionCalls >= 4) queueMicrotask(() => controller.abort());
        return result;
      },
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
    clearTimeout(hardStop);
    assert.ok(result.resourceActivity.reconciliationCycles >= 3);
    assert.ok(result.resourceActivity.ingestionRuns >= result.resourceActivity.reconciliationCycles);
    assert.ok(result.resourceActivity.checkpointWrites <= 3);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});
