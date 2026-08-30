import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import {
  readLocalUnifiedCompanionProjection,
} from "../src/local-unified-companion-source.js";
import {
  readLocalUnifiedCompanionProjectionOffMain,
  shouldRunLocalUnifiedCompanionProjectionOffMain,
} from "../src/local-unified-companion-off-main.js";
import {
  createCachedLocalUnifiedProjectionReader,
} from "../apps/local/server.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const NOW_MS = Date.parse("2026-08-24T01:00:00.000Z");

function rolloutFixture() {
  const rows = [
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: THREAD_ID,
        session_id: THREAD_ID,
        thread_source: "user",
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "high" },
    },
    {
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 10,
            window_minutes: 300,
            resets_at: 1_777_000_000,
          },
        },
      },
    },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function createProjectionIndex(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessions = join(root, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
    rolloutFixture(),
  );
  const indexFile = join(root, "index.sqlite");
  await rebuildLocalUnifiedIndex({
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: "companion-off-main-test-v1",
  });
  return { root, indexFile };
}

test("only a full native macOS projection selects the worker boundary", () => {
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "darwin",
    mode: "full",
  }), true);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "darwin",
    mode: "deferred",
  }), false);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "linux",
    mode: "full",
  }), false);
  assert.equal(shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform: "win32",
    mode: "full",
  }), false);
});

test("deferred projection stays cheap and never constructs a worker", async () => {
  class RefusingWorker {
    constructor() {
      throw new Error("worker must not start");
    }
  }
  const projection = await readLocalUnifiedCompanionProjectionOffMain({
    indexFile: "/does/not/matter.sqlite",
    nowMs: NOW_MS,
    mode: "deferred",
  }, {
    platform: "darwin",
    WorkerClass: RefusingWorker,
  });
  assert.equal(projection.status, "deferred");
  assert.equal(projection.errorCode, "local_unified_index_deferred");
});

test("the real projection worker preserves the direct reader contract", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-contract-",
  );
  let workerCount = 0;
  class CapturingWorker extends Worker {
    constructor(...arguments_) {
      super(...arguments_);
      workerCount += 1;
    }
  }
  try {
    const options = { indexFile, nowMs: NOW_MS, mode: "full" };
    const [direct, offMain] = await Promise.all([
      readLocalUnifiedCompanionProjection(options),
      readLocalUnifiedCompanionProjectionOffMain(options, {
        platform: "darwin",
        WorkerClass: CapturingWorker,
      }),
    ]);
    assert.equal(workerCount, 1);
    assert.deepEqual(
      { ...offMain, readWallMs: null },
      { ...direct, readWallMs: null },
    );
    assert.equal(offMain.status, "available");
    assert.equal(offMain.usageEvents, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real unchanged publication reuses the completed projection without another worker read", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-projection-cache-",
  );
  let workerReads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (options, controls) => {
      workerReads += 1;
      return readLocalUnifiedCompanionProjectionOffMain(options, {
        ...controls,
        platform: "darwin",
      });
    },
  });
  try {
    const options = {
      indexFile,
      nowMs: NOW_MS,
      declaredSpeedBaselines: [],
      mode: "full",
    };
    const first = await reader(options);
    assert.equal(first.status, "available");
    assert.equal(workerReads, 1);

    const second = await reader(
      { ...options, nowMs: NOW_MS + 1_000 },
      {
        reuse: {
          generationFingerprint: first.generation.fingerprint,
        },
      },
    );
    assert.equal(second.status, "available");
    assert.equal(second.generation.fingerprint, first.generation.fingerprint);
    assert.equal(workerReads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large synchronous SQLite projection does not block the companion loop", {
  timeout: 30_000,
}, async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-responsive-",
  );
  const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
  const insert = database.prepare(`
    INSERT INTO quota_observation(
      observed_at_ms, limit_id, slot, plan_type, used_percent,
      resets_at_ms, duration_mins
    ) VALUES (?, 'codex', 'secondary', 'pro', ?, ?, 300)
  `);
  const rowCount = 150_000;
  try {
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < rowCount; index += 1) {
      insert.run(
        NOW_MS - rowCount * 1_000 + index * 1_000,
        index % 101,
        NOW_MS + 300 * 60_000,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the insertion failure.
    }
    throw error;
  } finally {
    database.close();
  }

  let heartbeats = 0;
  let maximumHeartbeatGapMs = 0;
  let priorHeartbeatAt = performance.now();
  const heartbeat = setInterval(() => {
    const observedAt = performance.now();
    maximumHeartbeatGapMs = Math.max(
      maximumHeartbeatGapMs,
      observedAt - priorHeartbeatAt,
    );
    priorHeartbeatAt = observedAt;
    heartbeats += 1;
  }, 20);
  const startedAt = performance.now();
  try {
    const projection = await readLocalUnifiedCompanionProjectionOffMain({
      indexFile,
      nowMs: NOW_MS,
      mode: "full",
    }, { platform: "darwin" });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(projection.status, "available");
    assert.equal(projection.quotaObservations, rowCount + 1);
    assert.ok(elapsedMs >= 100, `projection completed unexpectedly fast in ${elapsedMs}ms`);
    assert.ok(heartbeats >= 3, `only ${heartbeats} loop heartbeats during ${elapsedMs}ms`);
    assert.ok(
      maximumHeartbeatGapMs < 500,
      `companion loop heartbeat stalled for ${maximumHeartbeatGapMs}ms`,
    );
  } finally {
    clearInterval(heartbeat);
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled read-only projection terminates with a bounded typed error", async () => {
  const { root, indexFile } = await createProjectionIndex(
    "unified-companion-off-main-abort-",
  );
  const controller = new AbortController();
  try {
    const reading = readLocalUnifiedCompanionProjectionOffMain({
      indexFile,
      nowMs: NOW_MS,
      mode: "full",
    }, { platform: "darwin", signal: controller.signal });
    controller.abort();
    await assert.rejects(
      reading,
      (error) => error?.code === "local_unified_companion_projection_aborted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
