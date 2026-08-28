import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { createIndexedCodexLogScan } from "../src/local-analysis-index.js";

const { scanCodexLogEvents } = localCodexLogScanner;

async function removeIndexedFixture(path) {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 0,
      retryDelay: 20,
    });
  } catch (error) {
    // Node's synchronous SQLite binding can retain a Windows delete-sharing
    // lock until the test process exits even after DatabaseSync.close(). The
    // runner workspace is disposable; never mask any other teardown failure.
    if (process.platform !== "win32" || error?.code !== "EBUSY") throw error;
  }
}

const START_AT = "2026-07-25T00:00:00.000Z";
const END_AT = "2026-07-25T02:00:00.000Z";
const WEEKLY_RESETS_AT = 1785441981;

function usage(input, output = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function token(timestamp, total, last, usedPercent, {
  resetsAt = WEEKLY_RESETS_AT,
  secondaryPercent = null,
} = {}) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: {
          used_percent: usedPercent,
          window_minutes: 10080,
          resets_at: resetsAt,
        },
        ...(secondaryPercent === null ? {} : {
          secondary: {
            used_percent: secondaryPercent,
            window_minutes: 300,
            resets_at: resetsAt + 1,
          },
        }),
      },
    },
  });
}

function sessionMeta(timestamp, id, parentId = null) {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id,
      ...(parentId === null ? {} : { forked_from_id: parentId }),
    },
  });
}

function turnContext(timestamp) {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { model: "gpt-test" },
  });
}

async function codexHomeWith(rollouts) {
  const codexHome = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-stale-leading-quota-",
  ));
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  for (const [name, records] of Object.entries(rollouts)) {
    await writeFile(
      join(sessions, name),
      `${records.join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  return codexHome;
}

async function collect(scan, codexHome) {
  const quota = [];
  const usageEvents = [];
  const result = await scan({
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    onUsage(value) {
      usageEvents.push(value.timestamp);
    },
    onRateLimitSnapshot(value) {
      quota.push({
        timestamp: value.timestamp,
        slot: value.window.slot,
        usedPercent: value.window.usedPercent,
      });
    },
  });
  const order = (left, right) => JSON.stringify(left)
    .localeCompare(JSON.stringify(right));
  return {
    quota: quota.sort(order),
    usageEvents: usageEvents.sort(),
    contradictedLeadingSnapshotsSkipped:
      result.diagnostics.contradictedLeadingSnapshotsSkipped,
    rateLimitSnapshots: result.diagnostics.rateLimitSnapshots,
    forkReplayEventsSkipped: result.diagnostics.forkReplayEventsSkipped,
  };
}

/**
 * The owner's real corpus: a forked rollout replays inherited history, and a
 * replayed record whose cumulative snapshot key is absent from the ancestor's
 * set is admitted as if freshly observed. It carries the ancestor's OLD
 * weekly reading, so the session appears to open at 27% and reach 70% in 92ms.
 */
function staleForkFixture() {
  return {
    "rollout-2026-07-25T01-00-00-parent.jsonl": [
      sessionMeta("2026-07-25T01:00:00.000Z", "PARENT_SESSION"),
      turnContext("2026-07-25T01:00:00.010Z"),
      token(
        "2026-07-25T01:00:01.000Z",
        usage(1000),
        usage(1000),
        27,
      ),
      token(
        "2026-07-25T01:08:45.874Z",
        usage(2000),
        usage(1000),
        70,
      ),
    ],
    "rollout-2026-07-25T01-18-43-fork.jsonl": [
      sessionMeta(
        "2026-07-25T01:18:43.477Z",
        "FORK_SESSION",
        "PARENT_SESSION",
      ),
      turnContext("2026-07-25T01:18:43.478Z"),
      // Replayed with a key the ancestor set holds: already suppressed today.
      token(
        "2026-07-25T01:18:43.500Z",
        usage(1000),
        usage(1000),
        27,
      ),
      // Replayed, but its key is missing from the ancestor set, so lineage
      // suppression does not fire and the STALE 27% is admitted.
      token(
        "2026-07-25T01:18:43.544Z",
        usage(1500),
        usage(500),
        27,
      ),
      // The same escape, 92ms later, carrying the true current reading.
      token(
        "2026-07-25T01:18:43.636Z",
        usage(2500),
        usage(1000),
        70,
      ),
      // The fork's own first turn.
      token(
        "2026-07-25T01:18:49.833Z",
        usage(3000),
        usage(500),
        71,
      ),
    ],
  };
}

test("a stale leading quota reading contradicted seconds later never becomes an observation", async () => {
  const codexHome = await codexHomeWith(staleForkFixture());
  try {
    const scanned = await collect(scanCodexLogEvents, codexHome);
    assert.deepEqual(scanned.quota, [
      { timestamp: "2026-07-25T01:00:01.000Z", slot: "primary", usedPercent: 27 },
      { timestamp: "2026-07-25T01:08:45.874Z", slot: "primary", usedPercent: 70 },
      { timestamp: "2026-07-25T01:18:43.636Z", slot: "primary", usedPercent: 70 },
      { timestamp: "2026-07-25T01:18:49.833Z", slot: "primary", usedPercent: 71 },
    ]);
    // No pair of consecutive readings claims a jump with no time to make it.
    for (let index = 1; index < scanned.quota.length; index += 1) {
      const previous = scanned.quota[index - 1];
      const current = scanned.quota[index];
      const elapsedMs = Date.parse(current.timestamp)
        - Date.parse(previous.timestamp);
      assert.equal(
        current.usedPercent - previous.usedPercent < 10 || elapsedMs >= 60_000,
        true,
        `phantom transition ${previous.usedPercent} -> ${current.usedPercent} in ${elapsedMs}ms`,
      );
    }
    // The exclusion is counted, not silent, and the emitted count matches.
    assert.equal(scanned.contradictedLeadingSnapshotsSkipped, 1);
    assert.equal(scanned.rateLimitSnapshots, scanned.quota.length);
    assert.equal(scanned.forkReplayEventsSkipped, 1);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("a session that genuinely begins low keeps its leading reading and its transitions", async () => {
  const codexHome = await codexHomeWith({
    // Standalone: the low reading is the current state and rises over real time.
    "rollout-2026-07-25T00-10-00-fresh.jsonl": [
      sessionMeta("2026-07-25T00:10:00.000Z", "FRESH_SESSION"),
      turnContext("2026-07-25T00:10:00.010Z"),
      token("2026-07-25T00:10:01.000Z", usage(1000), usage(1000), 3),
      token("2026-07-25T00:55:00.000Z", usage(9000), usage(8000), 46),
    ],
    // Forked, and also legitimately low: a real gap, not a replay artefact.
    "rollout-2026-07-25T01-30-00-slow-fork.jsonl": [
      sessionMeta(
        "2026-07-25T01:30:00.000Z",
        "SLOW_FORK_SESSION",
        "FRESH_SESSION",
      ),
      turnContext("2026-07-25T01:30:00.010Z"),
      token("2026-07-25T01:30:01.000Z", usage(11_000), usage(2000), 50),
      token("2026-07-25T01:45:00.000Z", usage(20_000), usage(9000), 74),
    ],
    // A source observed exactly once still reports what it saw.
    "rollout-2026-07-25T01-50-00-single.jsonl": [
      sessionMeta("2026-07-25T01:50:00.000Z", "SINGLE_SESSION"),
      turnContext("2026-07-25T01:50:00.010Z"),
      token("2026-07-25T01:50:01.000Z", usage(500), usage(500), 74),
    ],
  });
  try {
    const scanned = await collect(scanCodexLogEvents, codexHome);
    assert.deepEqual(scanned.quota.map((row) => row.usedPercent), [
      3,
      46,
      50,
      74,
      74,
    ]);
    assert.equal(scanned.contradictedLeadingSnapshotsSkipped, 0);
    assert.equal(scanned.rateLimitSnapshots, 5);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("each quota window is gated independently and later readings pass through untouched", async () => {
  const codexHome = await codexHomeWith({
    "rollout-2026-07-25T01-00-00-slots.jsonl": [
      sessionMeta("2026-07-25T01:00:00.000Z", "SLOT_SESSION"),
      turnContext("2026-07-25T01:00:00.010Z"),
      // Leading: weekly reading is stale, the 5-hour reading is not.
      token(
        "2026-07-25T01:00:01.000Z",
        usage(1000),
        usage(1000),
        27,
        { secondaryPercent: 8 },
      ),
      token(
        "2026-07-25T01:00:01.092Z",
        usage(2000),
        usage(1000),
        70,
        { secondaryPercent: 9 },
      ),
      token(
        "2026-07-25T01:00:07.300Z",
        usage(3000),
        usage(1000),
        71,
        { secondaryPercent: 10 },
      ),
      // A later same-window jump is left alone: only leading readings are held.
      token(
        "2026-07-25T01:00:07.400Z",
        usage(4000),
        usage(1000),
        91,
        { secondaryPercent: 30 },
      ),
    ],
  });
  try {
    const scanned = await collect(scanCodexLogEvents, codexHome);
    assert.deepEqual(scanned.quota, [
      { timestamp: "2026-07-25T01:00:01.000Z", slot: "secondary", usedPercent: 8 },
      { timestamp: "2026-07-25T01:00:01.092Z", slot: "primary", usedPercent: 70 },
      { timestamp: "2026-07-25T01:00:01.092Z", slot: "secondary", usedPercent: 9 },
      { timestamp: "2026-07-25T01:00:07.300Z", slot: "primary", usedPercent: 71 },
      { timestamp: "2026-07-25T01:00:07.300Z", slot: "secondary", usedPercent: 10 },
      { timestamp: "2026-07-25T01:00:07.400Z", slot: "primary", usedPercent: 91 },
      { timestamp: "2026-07-25T01:00:07.400Z", slot: "secondary", usedPercent: 30 },
    ]);
    assert.equal(scanned.contradictedLeadingSnapshotsSkipped, 1);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("a leading reading corroborated outside the requested interval is kept, in both paths", async () => {
  // The source's real leading reading predates the interval, so the first
  // reading inside it is already corroborated and must survive the jump that
  // follows. The durable index sees the same records and must agree.
  const rollouts = {
    "rollout-2026-07-24T23-59-00-boundary.jsonl": [
      sessionMeta("2026-07-24T23:59:00.000Z", "BOUNDARY_SESSION"),
      turnContext("2026-07-24T23:59:00.010Z"),
      token("2026-07-24T23:59:50.000Z", usage(1000), usage(1000), 30),
      token("2026-07-25T00:00:01.000Z", usage(2000), usage(1000), 32),
      token("2026-07-25T00:00:02.000Z", usage(3000), usage(1000), 45),
    ],
  };
  const codexHome = await codexHomeWith(rollouts);
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-stale-leading-quota-boundary-",
  ));
  try {
    const indexedScan = createIndexedCodexLogScan({
      indexFile: join(root, "local-analysis-index-v2.sqlite"),
      secretFile: join(root, "local-analysis-index-secret-v2"),
      workerCount: 2,
      chunkBytes: 4 * 1024 * 1024,
    });
    const streamed = await collect(scanCodexLogEvents, codexHome);
    assert.deepEqual(streamed.quota.map((row) => row.usedPercent), [32, 45]);
    assert.equal(streamed.contradictedLeadingSnapshotsSkipped, 0);
    assert.deepEqual(await collect(indexedScan, codexHome), streamed);
    assert.deepEqual(await collect(indexedScan, codexHome), streamed);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await removeIndexedFixture(root);
  }
});

test("the persistent index withholds the same stale reading as the streaming scan", async () => {
  const codexHome = await codexHomeWith(staleForkFixture());
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-stale-leading-quota-index-",
  ));
  try {
    const indexedScan = createIndexedCodexLogScan({
      indexFile: join(root, "local-analysis-index-v2.sqlite"),
      secretFile: join(root, "local-analysis-index-secret-v2"),
      workerCount: 2,
      chunkBytes: 4 * 1024 * 1024,
    });
    const streamed = await collect(scanCodexLogEvents, codexHome);
    const built = await collect(indexedScan, codexHome);
    assert.deepEqual(built, streamed);
    assert.equal(built.contradictedLeadingSnapshotsSkipped, 1);
    // The withheld reading is not persisted, so replaying the committed index
    // cannot resurrect it either.
    const replayed = await collect(indexedScan, codexHome);
    assert.deepEqual(replayed.quota, streamed.quota);
    assert.equal(
      replayed.quota.some((row) => (
        row.timestamp === "2026-07-25T01:18:43.544Z"
      )),
      false,
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await removeIndexedFixture(root);
  }
});
