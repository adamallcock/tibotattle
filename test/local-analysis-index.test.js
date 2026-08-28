import test from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { recognizedExportModelId } from "../src/export/index.js";
import {
  configureDatabase,
  createIndexedCodexLogScan,
  inspectLocalAnalysisIndex,
  LOCAL_ANALYSIS_INDEX_PARSER_VERSION,
  markLocalAnalysisIndexCoveragePartial,
  refreshLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import {
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import {
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";

const { scanCodexLogEvents } = localCodexLogScanner;

const START_AT = "2026-07-24T11:55:00.000Z";
const END_AT = "2026-07-24T12:10:00.000Z";
const CHUNK_BYTES = 4 * 1024 * 1024;
const FILLER_RECORD = JSON.stringify({
  timestamp: "2026-07-24T12:05:00.000Z",
  type: "synthetic_padding",
  payload: {
    bytes: "x".repeat(1024),
  },
});

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

function token(
  timestamp,
  total,
  last,
  usedPercent,
  {
    primaryDuration = 300,
    secondaryDuration = 10080,
    primaryResetAt = 1784912400,
    secondaryResetAt = 1785430800,
    model,
  } = {},
) {
  const payload = {
    type: "token_count",
    info: {
      total_token_usage: total,
      last_token_usage: last,
    },
    rate_limits: {
      limit_id: "codex",
      plan_type: "pro",
      primary: {
        used_percent: usedPercent,
        window_minutes: primaryDuration,
        resets_at: primaryResetAt,
      },
      secondary: {
        used_percent: usedPercent / 2,
        window_minutes: secondaryDuration,
        resets_at: secondaryResetAt,
      },
    },
  };
  if (model !== undefined) payload.model = model;
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload,
  });
}

async function fixture() {
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-local-analysis-index-",
  ));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const parentPath = join(
    sessions,
    "rollout-2026-07-24T12-00-00-private-parent.jsonl",
  );
  const childPath = join(
    sessions,
    "rollout-2026-07-24T12-03-00-private-child.jsonl",
  );
  await writeFile(parentPath, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_PARENT" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    token(
      "2026-07-24T12:01:00.000Z",
      usage(100, 20),
      usage(100, 20),
      10,
    ),
    token(
      "2026-07-24T12:02:00.000Z",
      usage(160, 35),
      usage(60, 15),
      12,
    ),
  ].join("\n")}\n`);
  await writeFile(childPath, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:03:00.000Z",
      type: "session_meta",
      payload: {
        id: "PRIVATE_CHILD",
        forked_from_id: "PRIVATE_PARENT",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:03:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    token(
      "2026-07-24T12:03:01.000Z",
      usage(160, 35),
      usage(60, 15),
      12,
    ),
    token(
      "2026-07-24T12:04:00.000Z",
      usage(220, 50),
      usage(60, 15),
      15,
    ),
  ].join("\n")}\n`);
  return { root, codexHome, parentPath, childPath };
}

async function chunkedFixture({ includeSecondSource = false } = {}) {
  const result = await fixture();
  if (!includeSecondSource) {
    await rm(result.childPath, { force: true });
  }
  const filler = `${FILLER_RECORD}\n`.repeat(8_000);
  await appendFile(result.parentPath, `${filler}${token(
    "2026-07-24T12:06:00.000Z",
    usage(240, 50),
    usage(140, 30),
    18,
  )}\n`);
  return result;
}

async function countWorkerLaunches(callback) {
  let count = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === "WORKER") count += 1;
    },
  });
  hook.enable();
  try {
    await callback();
  } finally {
    hook.disable();
  }
  return count;
}

async function receipt(scan, codexHome) {
  const usageRows = [];
  const quotaRows = [];
  const result = await scan({
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    onUsage(value) {
      usageRows.push({
        timestamp: value.timestamp,
        model: value.model,
        components: value.components,
      });
    },
    onRateLimitSnapshot(value) {
      quotaRows.push({
        timestamp: value.timestamp,
        window: value.window,
      });
    },
  });
  const order = (left, right) => JSON.stringify(left)
    .localeCompare(JSON.stringify(right));
  return {
    usageRows: usageRows.sort(order),
    quotaRows: quotaRows.sort(order),
    diagnostics: {
      filesScanned: result.diagnostics.filesScanned,
      forkReplayEventsSkipped:
        result.diagnostics.forkReplayEventsSkipped,
      duplicateSnapshotsSkipped:
        result.diagnostics.duplicateSnapshotsSkipped,
    },
  };
}

test("does not launch an empty worker for one source with many chunks", async () => {
  const { root, codexHome } = await chunkedFixture();
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const secretFile = join(root, "local-analysis-index-secret-v2");
  let refreshed;
  const workerLaunches = await countWorkerLaunches(async () => {
    refreshed = await refreshLocalAnalysisIndex({
      indexFile,
      secretFile,
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      workerCount: 2,
      chunkBytes: CHUNK_BYTES,
    });
  });

  assert.equal(refreshed.sourceCount, 1);
  assert.ok(refreshed.scanBytes > CHUNK_BYTES * 2);
  assert.equal(workerLaunches, 1);
});

test("preserves bounded accounting callback stops for cache-level handling", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-analysis-index-callback-stop.sqlite");
  const secretFile = join(root, "local-analysis-index-callback-stop-secret");
  let callbackCount = 0;
  const callbackStop = new Error("accounting_transition_rss_limit_exceeded");
  callbackStop.code = "accounting_transition_rss_limit_exceeded";

  await assert.rejects(
    refreshLocalAnalysisIndex({
      indexFile,
      secretFile,
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
      onUsage() {
        callbackCount += 1;
        throw callbackStop;
      },
    }),
    { code: "accounting_transition_rss_limit_exceeded" },
  );
  assert.equal(callbackCount > 0, true);
});

test("preserves source-affine shard mapping and chunk order", async () => {
  const { root, codexHome } = await chunkedFixture({
    includeSecondSource: true,
  });
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const secretFile = join(root, "local-analysis-index-secret-v2");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 3,
    chunkBytes: CHUNK_BYTES,
  });
  const legacy = await receipt(scanCodexLogEvents, codexHome);
  const usageRows = [];
  const quotaRows = [];
  let indexed;
  const workerLaunches = await countWorkerLaunches(async () => {
    indexed = await indexedScan({
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      onUsage(value) {
        usageRows.push({
          timestamp: value.timestamp,
          model: value.model,
          components: value.components,
          sourceRolloutOrdinal: value.sourceRolloutOrdinal,
          sourceRecordOrdinal: value.sourceRecordOrdinal,
        });
      },
      onRateLimitSnapshot(value) {
        quotaRows.push({
          timestamp: value.timestamp,
          window: value.window,
        });
      },
    });
  });

  const order = (left, right) => JSON.stringify(left)
    .localeCompare(JSON.stringify(right));
  assert.equal(workerLaunches, 2);
  assert.deepEqual(
    usageRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      components: row.components,
    })).sort(order),
    legacy.usageRows,
  );
  assert.deepEqual({
    quotaRows: quotaRows.sort(order),
    diagnostics: {
      filesScanned: indexed.diagnostics.filesScanned,
      forkReplayEventsSkipped:
        indexed.diagnostics.forkReplayEventsSkipped,
      duplicateSnapshotsSkipped:
        indexed.diagnostics.duplicateSnapshotsSkipped,
    },
  }, {
    quotaRows: legacy.quotaRows,
    diagnostics: legacy.diagnostics,
  });
  assert.deepEqual(
    usageRows.map((row) => row.sourceRolloutOrdinal),
    [0, 0, 0, 1],
  );
  assert.ok(
    usageRows[0].sourceRecordOrdinal
      < usageRows[1].sourceRecordOrdinal,
  );
  assert.ok(
    usageRows[1].sourceRecordOrdinal
      < usageRows[2].sourceRecordOrdinal,
  );
});

test("persistent local index preserves replay-safe accounting and appends only new bytes", async () => {
  const {
    root,
    codexHome,
    parentPath,
    childPath,
  } = await fixture();
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const secretFile = join(root, "local-analysis-index-secret-v2");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 2,
    chunkBytes: 4 * 1024 * 1024,
  });

  const [legacy, indexed] = await Promise.all([
    receipt(scanCodexLogEvents, codexHome),
    receipt(indexedScan, codexHome),
  ]);
  assert.deepEqual(indexed, legacy);

  const first = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(first.lastScan.bytes > 0, true);
  assert.equal(first.usageFacts, 3);
  assert.equal(first.snapshotKeys, 3);
  assert.equal((await stat(indexFile)).mode & 0o777, 0o600);
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600);

  const bytes = await readFile(indexFile);
  for (const canary of [
    "PRIVATE_PARENT",
    "PRIVATE_CHILD",
    parentPath,
    childPath,
    "private-parent.jsonl",
    "private-child.jsonl",
  ]) {
    assert.equal(bytes.includes(Buffer.from(canary)), false);
  }

  const indexCtimeBeforeReuse = (await stat(indexFile, { bigint: true }))
    .ctimeNs;
  assert.deepEqual(await receipt(indexedScan, codexHome), legacy);
  const reused = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(reused.lastScan.bytes, first.lastScan.bytes);
  assert.equal(
    (await stat(indexFile, { bigint: true })).ctimeNs,
    indexCtimeBeforeReuse,
  );

  const verifiedReuse = await refreshLocalAnalysisIndex({
    indexFile,
    secretFile,
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 2,
    chunkBytes: 4 * 1024 * 1024,
  });
  assert.equal(verifiedReuse.status, "reused");
  assert.equal(verifiedReuse.scanBytes, 0);
  assert.equal(verifiedReuse.sourceProjectionReusedCount, 2);

  const beforeAppendSize = (await stat(childPath)).size;
  await appendFile(childPath, `${token(
    "2026-07-24T12:05:00.000Z",
    usage(250, 60),
    usage(30, 10),
    17,
  )}\n`);
  const appended = await receipt(indexedScan, codexHome);
  assert.equal(appended.usageRows.length, legacy.usageRows.length + 1);
  const updated = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(updated.lastScan.bytes > 0, true);
  assert.equal(
    updated.lastScan.bytes <= (await stat(childPath)).size - beforeAppendSize,
    true,
  );
});

test("local index keeps quota durations distinct and relays a valid generic window", async () => {
  const { root, codexHome, parentPath } = await fixture();
  await appendFile(parentPath, `${[
    token(
      "2026-07-24T12:06:00.000Z",
      usage(240, 50),
      usage(20, 10),
      18,
      {
        primaryDuration: 43_200,
        primaryResetAt: 1784912400,
      },
    ),
    token(
      "2026-07-24T12:07:00.000Z",
      usage(260, 60),
      usage(20, 10),
      30,
      {
        primaryDuration: 43_200,
        primaryResetAt: 1784912400,
      },
    ),
  ].join("\n")}\n`);
  const indexFile = join(root, "local-analysis-index-generic.sqlite");
  const secretFile = join(root, "local-analysis-index-generic-secret");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 2,
    chunkBytes: CHUNK_BYTES,
  });

  const result = await receipt(indexedScan, codexHome);
  const genericRows = result.quotaRows.filter(
    (row) => row.window.windowDurationMins === 43_200,
  );
  assert.deepEqual(
    genericRows.map((row) => [row.timestamp, row.window.usedPercent]),
    [["2026-07-24T12:07:00.000Z", 30]],
  );
  assert.equal(
    result.quotaRows.some(
      (row) => row.window.windowDurationMins === 300,
    ),
    true,
  );
  assert.equal(
    result.quotaRows.some(
      (row) => row.window.windowDurationMins === 10_080,
    ),
    true,
  );
  assert.equal(
    (await inspectLocalAnalysisIndex({ indexFile })).schemaVersion,
    "local-analysis-index-v5",
  );
});

test("local index refuses an out-of-range provider duration without losing source data", async () => {
  const { root, codexHome, parentPath } = await fixture();
  await appendFile(parentPath, `${token(
    "2026-07-24T12:06:00.000Z",
    usage(240, 50),
    usage(20, 10),
    18,
    { primaryDuration: 525_601 },
  )}\n`);
  const indexFile = join(root, "local-analysis-index-invalid-duration.sqlite");
  const secretFile = join(root, "local-analysis-index-invalid-duration-secret");
  const result = await receipt(createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  }), codexHome);

  assert.equal(
    result.quotaRows.some(
      (row) => row.window.windowDurationMins === 525_601,
    ),
    false,
  );
  assert.equal((await stat(parentPath)).size > 0, true);
  assert.equal(
    (await inspectLocalAnalysisIndex({ indexFile })).quotaFacts > 0,
    true,
  );
});

test("recognized Spark survives worker extraction and rebuilds a pre-Spark index", async () => {
  assert.equal(
    recognizedExportModelId("GPT-5.3-Codex-Spark"),
    "gpt-5.3-codex-spark",
  );
  const { root, codexHome, parentPath } = await fixture();
  await appendFile(parentPath, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:05:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.3-codex-spark" },
    }),
    token(
      "2026-07-24T12:06:00.000Z",
      usage(240, 50),
      usage(20, 10),
      18,
      { model: "gpt-5.3-codex-spark" },
    ),
  ].join("\n")}\n`);
  const indexFile = join(root, "local-analysis-index-spark.sqlite");
  const secretFile = join(root, "local-analysis-index-spark-secret");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });

  const initial = await receipt(indexedScan, codexHome);
  assert.equal(
    initial.usageRows.some((row) => row.model === "gpt-5.3-codex-spark"),
    true,
  );
  const database = new DatabaseSync(indexFile);
  try {
    assert.deepEqual(
      [...database.prepare("SELECT DISTINCT model FROM usage_facts").iterate()]
        .map((row) => row.model)
        .sort(),
      ["gpt-5.3-codex-spark", "gpt-5.6-sol"].sort(),
    );
    database.prepare(
      "UPDATE meta SET value = ? WHERE key = 'parser_version'",
    ).run("parallel-jsonl-accounting-v5");
    database.prepare("UPDATE usage_facts SET model = 'unknown'").run();
    database.prepare(
      "UPDATE sources SET current_model = 'unknown', current_model_seen = 1",
    ).run();
  } finally {
    database.close();
  }

  const rebuilt = await receipt(indexedScan, codexHome);
  assert.equal(
    rebuilt.usageRows.some((row) => row.model === "gpt-5.3-codex-spark"),
    true,
  );
  assert.equal(rebuilt.usageRows.some((row) => row.model === "unknown"), false);
  const inspected = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(inspected.parserVersion, LOCAL_ANALYSIS_INDEX_PARSER_VERSION);
  assert.equal(inspected.parserVersion, "parallel-jsonl-accounting-v6");
});

test("local index rebuilds a prior semantic generation from source logs", async () => {
  const { root, codexHome, parentPath } = await fixture();
  await appendFile(parentPath, `${token(
    "2026-07-24T12:06:00.000Z",
    usage(240, 50),
    usage(20, 10),
    18,
    { primaryDuration: 43_200 },
  )}\n`);
  const indexFile = join(root, "local-analysis-index-rebuild.sqlite");
  const secretFile = join(root, "local-analysis-index-rebuild-secret");
  await refreshLocalAnalysisIndex({
    indexFile,
    secretFile,
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });
  const sourceBytesBefore = (await stat(parentPath)).size;
  const database = new DatabaseSync(indexFile);
  try {
    database.exec("PRAGMA user_version=4");
    database.prepare(
      "UPDATE meta SET value = ? WHERE key = ?",
    ).run("local-analysis-index-v4", "schema_version");
    database.prepare(
      "UPDATE meta SET value = ? WHERE key = ?",
    ).run("parallel-jsonl-accounting-v4", "parser_version");
  } finally {
    database.close();
  }

  const rebuilt = await refreshLocalAnalysisIndex({
    indexFile,
    secretFile,
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });
  assert.equal(rebuilt.status, "built");
  assert.equal(rebuilt.scanBytes > 0, true);
  assert.equal(rebuilt.sourceProjectionReusedCount, 0);
  assert.equal((await stat(parentPath)).size, sourceBytesBefore);
  assert.equal(
    (await inspectLocalAnalysisIndex({ indexFile })).schemaVersion,
    "local-analysis-index-v5",
  );
});

test("partial index batches retain durable cursors and resume to the exact receipt", async () => {
  const { root, codexHome, parentPath, childPath } = await chunkedFixture({
    includeSecondSource: true,
  });
  const indexFile = join(root, "local-analysis-index-v4.sqlite");
  const secretFile = join(root, "local-analysis-index-secret-v4");
  const legacy = await receipt(scanCodexLogEvents, codexHome);

  let refreshed = null;
  let partialPasses = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    refreshed = await refreshLocalAnalysisIndex({
      indexFile,
      secretFile,
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      workerCount: 2,
      chunkBytes: CHUNK_BYTES,
      maximumSourcesPerRefresh: 1,
      maximumScanBytesPerRefresh: CHUNK_BYTES,
    });
    const inspection = await inspectLocalAnalysisIndex({ indexFile });
    assert.deepEqual(inspection.coverage, refreshed.coverage);
    assert.equal(inspection.coverage.sourceCount, 2);
    assert.equal(
      inspection.coverage.indexedSourceCount
        + inspection.coverage.pendingSourceCount,
      2,
    );
    assert.equal(refreshed.scanBytes <= CHUNK_BYTES, true);
    if (refreshed.coverage.status === "complete") break;
    partialPasses += 1;
    assert.equal(inspection.coverage.status, "partial");
    assert.equal(inspection.coverage.pendingSourceCount > 0, true);
    assert.equal(
      inspection.coverage.indexedBytes < inspection.coverage.sourceBytes,
      true,
    );
  }

  assert.ok(refreshed);
  assert.equal(partialPasses >= 2, true);
  assert.deepEqual(refreshed.coverage, {
    status: "complete",
    sourceCount: 2,
    indexedSourceCount: 2,
    pendingSourceCount: 0,
    sourceBytes: refreshed.sourceBytes,
    indexedBytes: refreshed.sourceBytes,
  });
  assert.deepEqual(
    await receipt(createIndexedCodexLogScan({
      indexFile,
      secretFile,
      workerCount: 2,
      chunkBytes: CHUNK_BYTES,
    }), codexHome),
    legacy,
  );

  const bytes = await readFile(indexFile);
  for (const canary of ["PRIVATE_PARENT", "PRIVATE_CHILD", parentPath, childPath]) {
    assert.equal(bytes.includes(Buffer.from(canary)), false);
  }
});

test("coverage marker withholds a nominally complete archive until a fresh check clears it", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-analysis-index-coverage.sqlite");
  const secretFile = join(root, "local-analysis-index-coverage-secret");
  await refreshLocalAnalysisIndex({
    indexFile,
    secretFile,
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });

  await markLocalAnalysisIndexCoveragePartial({
    indexFile,
    reason: "timeout",
    observedAt: END_AT,
  });
  const blocked = (await inspectLocalAnalysisIndex({ indexFile })).coverage;
  assert.deepEqual(blocked, {
    status: "partial",
    sourceCount: 2,
    indexedSourceCount: 2,
    pendingSourceCount: 0,
    sourceBytes: blocked.sourceBytes,
    indexedBytes: blocked.indexedBytes,
    blockReason: "timeout",
  });

  const refreshed = await refreshLocalAnalysisIndex({
    indexFile,
    secretFile,
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });
  assert.equal(refreshed.coverage.status, "complete");
  assert.equal(
    Object.hasOwn(
      (await inspectLocalAnalysisIndex({ indexFile })).coverage,
      "blockReason",
    ),
    false,
  );
});

test("same-size prefix rewrites invalidate a cached index even when millisecond metadata collides", async () => {
  const { root, codexHome, parentPath } = await fixture();
  // Keep the terminal 4 KiB unchanged: a tail-only boundary HMAC cannot see
  // a rewrite to the first token record by itself.
  await appendFile(parentPath, `${JSON.stringify({
    type: "synthetic_padding",
    padding: "x".repeat(10 * 1024),
  })}\n`);
  const indexFile = join(root, "local-analysis-index-v3.sqlite");
  const secretFile = join(root, "local-analysis-index-secret-v3");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile,
    workerCount: 2,
    chunkBytes: 4 * 1024 * 1024,
  });

  const initial = await receipt(indexedScan, codexHome);
  const initialSize = (await stat(parentPath)).size;
  const original = await readFile(parentPath, "utf8");
  const rewritten = original.replace('"used_percent":10', '"used_percent":11');
  assert.notEqual(rewritten, original);
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  await writeFile(parentPath, rewritten);
  const rewrittenMetadata = await stat(parentPath);
  const rewrittenCtimeNs = (await stat(parentPath, { bigint: true }))
    .ctimeNs.toString();

  // Model a filesystem whose exposed millisecond timestamp has collided. The
  // durable index still has the original ctime_ns, which must force a reset.
  const database = new DatabaseSync(indexFile);
  try {
    const source = database.prepare(`
      SELECT source_key, ctime_ns FROM sources
      WHERE file_size = ?
      ORDER BY ordinal
      LIMIT 1
    `).get(initialSize);
    assert.ok(source);
    assert.notEqual(source.ctime_ns, rewrittenCtimeNs);
    database.prepare(`
      UPDATE sources
      SET mtime_ms = ?, ctime_ms = ?
      WHERE source_key = ?
    `).run(
      rewrittenMetadata.mtimeMs,
      rewrittenMetadata.ctimeMs,
      source.source_key,
    );
  } finally {
    database.close();
  }

  const [legacy, refreshed] = await Promise.all([
    receipt(scanCodexLogEvents, codexHome),
    receipt(indexedScan, codexHome),
  ]);
  assert.equal((await inspectLocalAnalysisIndex({ indexFile })).lastScan.bytes > 0, true);
  assert.deepEqual(refreshed, legacy);
  assert.notDeepEqual(refreshed, initial);
});

test("the canonical SQLite accounting state never falls back to an index projection", async () => {
  const { root, codexHome } = await fixture();
  const stateFile = join(root, "local-collector-state-v1.sqlite");
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const indexSecretFile = join(
    root,
    "local-analysis-index-secret-v2",
  );
  const nowMs = Date.parse(END_AT);
  const written = await refreshReplaySafeAccountingCache({
    stateFile,
    sourceMode: "legacy",
    indexFile,
    indexSecretFile,
    codexHome,
    now: () => nowMs,
    // Re-pinned 1 -> 365 (2026-08-08): the standing owner rule forbids
    // convenience-sized history windows, so 365 is the smallest accepted.
    // The fixture corpus is tiny either way.
    windowDays: 365,
    indexWorkerCount: 2,
    indexChunkBytes: 4 * 1024 * 1024,
  });
  const invalid = structuredClone(written);
  delete invalid.quotaTimeline;
  await writeLocalCollectorAccountingCache({ stateFile, cache: invalid });
  const recovered = await readReplaySafeAccountingCache({
    stateFile,
    now: () => nowMs,
  });
  assert.deepEqual(recovered, {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
});

// PRAGMA journal_mode returns a result row, so issuing it through exec()
// prepares the statement without stepping it and the requested change is
// silently discarded. These tests assert the mode SQLite actually granted,
// read back after configuration -- not that a write was attempted.
test("configureDatabase grants a MEMORY journal in staging and DELETE+FULL durably, verified by readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-journal-mode-"));
  try {
    const stagingDatabase = new DatabaseSync(join(root, "staging.sqlite"));
    try {
      configureDatabase(stagingDatabase, { staging: true });
      assert.equal(
        stagingDatabase.prepare("PRAGMA journal_mode").get().journal_mode,
        "memory",
      );
      assert.equal(
        Number(stagingDatabase.prepare("PRAGMA synchronous").get().synchronous),
        0,
      );
      assert.equal(
        stagingDatabase.prepare("PRAGMA locking_mode").get().locking_mode,
        "exclusive",
      );
    } finally {
      stagingDatabase.close();
    }

    // Start the durable connection in WAL so the DELETE readback proves the
    // pragma took effect rather than observing the fresh-database default.
    const durableDatabase = new DatabaseSync(join(root, "durable.sqlite"));
    try {
      assert.equal(
        durableDatabase.prepare("PRAGMA journal_mode = WAL").get().journal_mode,
        "wal",
      );
      configureDatabase(durableDatabase, { staging: false });
      assert.equal(
        durableDatabase.prepare("PRAGMA journal_mode").get().journal_mode,
        "delete",
      );
      assert.equal(
        Number(durableDatabase.prepare("PRAGMA synchronous").get().synchronous),
        2,
      );
    } finally {
      durableDatabase.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A fork child whose tail is entirely replayed parent rows leaves the
// interleaved quota statement mid-step: every row `continue`s past the drain,
// the statement keeps a read transaction on the extracted shard schema, and
// the DETACH after the derivation commit fails with "database extract_N is
// locked" unless the iterator is explicitly closed. Observed on the real
// corpus; whether it surfaced depended on garbage-collection timing.
test("a fork child that only replays parent rows still lets the shard detach", async () => {
  const { root, codexHome, childPath } = await fixture();
  await writeFile(childPath, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:03:00.000Z",
      type: "session_meta",
      payload: {
        id: "PRIVATE_CHILD",
        forked_from_id: "PRIVATE_PARENT",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:03:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    // Replays of the parent's cumulative snapshots, and nothing after them.
    token(
      "2026-07-24T12:03:01.000Z",
      usage(100, 20),
      usage(100, 20),
      10,
    ),
    token(
      "2026-07-24T12:03:02.000Z",
      usage(160, 35),
      usage(60, 15),
      12,
    ),
  ].join("\n")}\n`);
  const refreshed = await refreshLocalAnalysisIndex({
    indexFile: join(root, "local-analysis-index-replay-tail.sqlite"),
    secretFile: join(root, "local-analysis-index-replay-tail-secret"),
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    workerCount: 1,
    chunkBytes: CHUNK_BYTES,
  });
  assert.equal(refreshed.status, "built");
  assert.equal(refreshed.coverage.status, "complete");
});

test("configureDatabase throws when the runtime refuses the requested journal mode", () => {
  // Models a runtime that answers every journal_mode request with "delete",
  // exactly how the bundled SQLite refuses journal_mode=OFF. A silently
  // degraded journal is the defect this guard exists to catch.
  const refusingDatabase = {
    prepare: () => ({ get: () => ({ journal_mode: "delete" }) }),
    exec: () => {},
  };
  assert.throws(
    () => configureDatabase(refusingDatabase, { staging: true }),
    { code: "local_analysis_index_journal_mode_refused" },
  );
});
