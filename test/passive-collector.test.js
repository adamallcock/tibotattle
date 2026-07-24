import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerError } from "../src/codex-app-server.js";
import { deriveOpenAIAccountScope } from "../src/account-scope.js";
import {
  acquireCollectorLock,
  appServerSnapshotRecord,
  commitCollectorRecordBatch,
  ingestRolloutUpdates,
  recoverCollectorBatchJournal,
  runCollectorForeground,
  runCollectorOnce,
} from "../src/passive-collector.js";

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
  return {
    root,
    codexHome,
    sessions,
    archive,
    rollout,
    dataFile: join(root, "state", "events.jsonl"),
    checkpointFile: join(root, "state", "checkpoint.json"),
    lockFile: join(root, "state", "collector.lock"),
  };
}

async function readLines(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

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

test("append success followed by checkpoint failure replays exactly once", async () => {
  const fixture = await collectorFixture();
  try {
    const options = { ...fixture, refreshStale: false, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    await runCollectorOnce(options);
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 1)}\n`);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    await assert.rejects(() => ingestRolloutUpdates({
      codexHome: fixture.codexHome,
      checkpoint,
      dataFile: fixture.dataFile,
      clock: options.clock,
      commitRecordBatch: (records) => commitCollectorRecordBatch({
        records,
        checkpoint,
        dataFile: fixture.dataFile,
        checkpointFile: fixture.checkpointFile,
        clock: options.clock,
        writeCheckpoint: async () => { throw new Error("injected checkpoint failure"); },
      }),
    }), /injected checkpoint failure/);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
    const recoveryOrder = [];
    await assert.rejects(() => recoverCollectorBatchJournal({
      dataFile: fixture.dataFile,
      checkpointFile: fixture.checkpointFile,
      truncateLedger: async () => {
        recoveryOrder.push("truncate");
        throw new Error("injected rollback sync failure");
      },
      removeJournal: async () => recoveryOrder.push("remove"),
    }), /injected rollback sync failure/);
    assert.deepEqual(recoveryOrder, ["truncate"]);
    const retried = await runCollectorOnce(options);
    assert.equal(retried.rolloutRecordsWritten, 1);
    assert.equal((await readLines(fixture.dataFile)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true });
  }
});

test("a committed batch is retained when journal cleanup fails", async () => {
  const fixture = await collectorFixture();
  try {
    const options = { ...fixture, refreshStale: false, clock: () => Date.parse("2026-07-23T00:01:00.000Z") };
    await runCollectorOnce(options);
    await appendFile(fixture.rollout, `${tokenRecord("2026-07-23T00:01:01.000Z", usage(10), usage(10), 1)}\n`);
    const checkpoint = JSON.parse(await readFile(fixture.checkpointFile, "utf8"));
    await assert.rejects(() => ingestRolloutUpdates({
      codexHome: fixture.codexHome,
      checkpoint,
      dataFile: fixture.dataFile,
      clock: options.clock,
      commitRecordBatch: (records) => commitCollectorRecordBatch({
        records,
        checkpoint,
        dataFile: fixture.dataFile,
        checkpointFile: fixture.checkpointFile,
        clock: options.clock,
        removeJournal: async () => { throw new Error("injected journal cleanup failure"); },
      }),
    }), /injected journal cleanup failure/);
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

test("a fresh app-server account marker provisionally scopes only new nearby rollout events", async () => {
  const fixture = await collectorFixture();
  const previousSecret = process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
  process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = "test-only-account-marker-secret";
  class ScopedClient {
    async start() {}
    async readRateLimits() { return appPayload(2); }
    async readAccount() { return { account: { email: "private.owner@example.test", planType: "pro" } }; }
    async readAccountUsage() { return { dailyUsageBuckets: [] }; }
    close() {}
  }
  try {
    await runCollectorOnce({
      ...fixture,
      staleAfterMs: 0,
      appServerFactory: () => new ScopedClient(),
      clock: () => Date.parse("2026-07-23T00:01:00.000Z"),
    });
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
  } finally {
    if (previousSecret === undefined) delete process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
    else process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = previousSecret;
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
      commitBatch: (options) => commitCollectorRecordBatch({
        ...options,
        writeCheckpoint: async () => { throw new Error("injected app checkpoint failure"); },
      }),
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

test("run-once restores app state after journal preparation fails", async () => {
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
      commitBatch: (options) => commitCollectorRecordBatch({
        ...options,
        writeJournal: async () => { throw new Error("injected journal preparation failure"); },
      }),
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

test("collector lock rejects contention and recovers a stale lock", async () => {
  const fixture = await collectorFixture();
  try {
    const release = await acquireCollectorLock(fixture.lockFile, { processExists: () => true });
    await assert.rejects(() => acquireCollectorLock(fixture.lockFile, { processExists: () => true }), /already held/);
    await release();
    await writeFile(fixture.lockFile, JSON.stringify({ pid: 999999, startedAt: "2026-07-22T00:00:00.000Z" }));
    const releaseRecovered = await acquireCollectorLock(fixture.lockFile, { processExists: () => false });
    await releaseRecovered();
  } finally {
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
      if (factoryCalls > 1) setTimeout(() => controller.abort(), 30);
      return appPayload(2);
    }
    close() {}
  }
  try {
    const hardStop = setTimeout(() => controller.abort(), 1_000);
    const result = await runCollectorForeground({
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
  const secret = "foreground-account-switch-test-secret";
  const previousSecret = process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
  process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = secret;
  let currentEmail = "first.owner@example.test";
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
    setTimeout(() => controller.abort(), 140);
    await runCollectorForeground({
      ...fixture,
      signal: controller.signal,
      staleAfterMs: 0,
      reconciliationMs: 20,
      appServerFactory: () => new SwitchingClient(),
      clock: () => nowMs,
    });
    const records = await readLines(fixture.dataFile);
    const rollout = records.find((record) => record.kind === "codex_rollout_usage_snapshot");
    const expected = deriveOpenAIAccountScope({ account: { email: "second.owner@example.test" } }, { secret, planType: "pro" });
    const prior = deriveOpenAIAccountScope({ account: { email: "first.owner@example.test" } }, { secret, planType: "pro" });
    assert.equal(rollout.accountScope.scopeId, expected.scopeId);
    assert.notEqual(rollout.accountScope.scopeId, prior.scopeId);
    assert.equal(JSON.stringify(records).includes("owner@example.test"), false);
  } finally {
    if (previousSecret === undefined) delete process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
    else process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = previousSecret;
    await rm(fixture.root, { recursive: true });
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
    setTimeout(() => controller.abort(), 100);
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
