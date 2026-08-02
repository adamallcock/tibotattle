import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanCodexLogEvents } from "../src/codex-log-scan.js";
import {
  createIndexedCodexLogScan,
  inspectLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import {
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";

const START_AT = "2026-07-24T11:55:00.000Z";
const END_AT = "2026-07-24T12:10:00.000Z";

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

function token(timestamp, total, last, usedPercent) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
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
          window_minutes: 300,
          resets_at: 1784912400,
        },
        secondary: {
          used_percent: usedPercent / 2,
          window_minutes: 10080,
          resets_at: 1785430800,
        },
      },
    },
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

  assert.deepEqual(await receipt(indexedScan, codexHome), legacy);
  const reused = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(reused.lastScan.bytes, 0);

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

test("committed index projection recovers a malformed compatibility cache", async () => {
  const { root, codexHome } = await fixture();
  const cacheFile = join(root, "accounting.json");
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const indexSecretFile = join(
    root,
    "local-analysis-index-secret-v2",
  );
  const nowMs = Date.parse(END_AT);
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    indexFile,
    indexSecretFile,
    codexHome,
    now: () => nowMs,
    windowDays: 1,
    indexWorkerCount: 2,
    indexChunkBytes: 4 * 1024 * 1024,
  });
  await writeFile(cacheFile, "{malformed compatibility cache");
  const recovered = await readReplaySafeAccountingCache({
    cacheFile,
    indexFile,
    now: () => nowMs,
  });
  assert.equal(recovered.status, "available");
  assert.deepEqual(recovered.cache, written);
});
