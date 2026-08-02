import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIndexedCodexLogScan,
  inspectLocalAnalysisIndex,
} from "../src/local-analysis-index.js";

// The extraction worker reads a chunk at a time into one reused buffer. A
// record that starts before a read ends and finishes after it is held across
// the read that overwrites those bytes, which is the only place a record can
// be lost without anything downstream noticing.
const READ_BUFFER_BYTES = 4 * 1024 * 1024;
const START_AT = "2026-07-24T11:55:00.000Z";
const END_AT = "2026-07-24T12:30:00.000Z";
const STRADDLING_AT = "2026-07-24T12:05:00.000Z";

function usage(input, output) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function tokenLine(timestamp, total, last, usedPercent) {
  return `${JSON.stringify({
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
      },
    },
  })}\n`;
}

// An irrelevant record of an exact byte length, used to steer the record under
// test onto the read boundary. Padding is plain ASCII so it never re-encodes.
function fillerLine(timestamp, totalBytes) {
  const empty = `${JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", text: "" },
  })}\n`;
  const padding = totalBytes - empty.length;
  assert.ok(padding >= 0, "filler line is longer than the requested size");
  return `${JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", text: "x".repeat(padding) },
  })}\n`;
}

async function straddlingFixture() {
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-read-boundary-",
  ));
  const sessions = join(root, "codex-home", "sessions");
  await mkdir(sessions, { recursive: true });
  const path = join(
    sessions,
    "rollout-2026-07-24T12-00-00-private-boundary.jsonl",
  );

  const lines = [];
  let size = 0;
  const push = (text) => {
    lines.push(text);
    size += Buffer.byteLength(text);
  };
  push(`${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "PRIVATE_BOUNDARY" },
  })}\n`);
  push(`${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.010Z",
    type: "turn_context",
    payload: { model: "gpt-5.6-sol" },
  })}\n`);
  push(tokenLine(
    "2026-07-24T12:01:00.000Z",
    usage(100, 20),
    usage(100, 20),
    10,
  ));

  const straddling = tokenLine(
    STRADDLING_AT,
    usage(600, 120),
    usage(200, 40),
    12,
  );
  // Land the record so that half of it sits either side of the boundary.
  const startByte = READ_BUFFER_BYTES
    - Math.floor(Buffer.byteLength(straddling) / 2);
  while (startByte - size > 65_536) {
    push(fillerLine("2026-07-24T12:02:00.000Z", 65_536));
  }
  push(fillerLine("2026-07-24T12:02:00.000Z", startByte - size));
  assert.equal(size, startByte);
  push(straddling);
  assert.ok(
    startByte < READ_BUFFER_BYTES && size > READ_BUFFER_BYTES,
    "the record under test does not straddle the read boundary",
  );

  // The read that follows has to be long enough to reach back over the held
  // bytes, so the file has to carry on for a further full read.
  while (size < READ_BUFFER_BYTES * 2 + 262_144) {
    push(fillerLine("2026-07-24T12:06:00.000Z", 65_536));
  }
  push(tokenLine(
    "2026-07-24T12:08:00.000Z",
    usage(900, 200),
    usage(300, 80),
    14,
  ));

  await writeFile(path, lines.join(""));
  return {
    root,
    codexHome: join(root, "codex-home"),
    startByte,
    endByte: startByte + Buffer.byteLength(straddling),
  };
}

test("a record straddling the read buffer boundary survives extraction", async () => {
  const { root, codexHome, startByte, endByte } = await straddlingFixture();
  const indexFile = join(root, "local-analysis-index-v2.sqlite");
  const indexedScan = createIndexedCodexLogScan({
    indexFile,
    secretFile: join(root, "local-analysis-index-secret-v2"),
    workerCount: 1,
    // One chunk, so the only boundary in play is the read buffer's.
    chunkBytes: 16 * 1024 * 1024,
  });

  const usageAt = [];
  const quotaAt = [];
  const result = await indexedScan({
    codexHome,
    startAt: START_AT,
    endAt: END_AT,
    onUsage(value) {
      usageAt.push(value.timestamp);
    },
    onRateLimitSnapshot(value) {
      quotaAt.push(value.timestamp);
    },
  });

  assert.ok(
    startByte < READ_BUFFER_BYTES && endByte > READ_BUFFER_BYTES,
    "fixture no longer straddles the read boundary",
  );
  // Held across a read and rebuilt afterwards: before the carried bytes were
  // copied this record vanished from usage_facts and quota_facts entirely.
  assert.equal(usageAt.includes(STRADDLING_AT), true);
  assert.equal(quotaAt.includes(STRADDLING_AT), true);
  assert.equal(usageAt.length, 3);
  assert.equal(quotaAt.length, 3);

  // Nothing was silently dropped on the way: the parser counted every
  // token_count record it saw, and every rebuilt line matched what was read.
  assert.equal(result.diagnostics.tokenCountRecords, 3);
  assert.equal(result.diagnostics.reassembledLineMismatches, 0);
  assert.equal(result.diagnostics.malformedLines, 0);
  assert.equal(result.diagnostics.impossibleSnapshotSets, 0);

  const inspected = await inspectLocalAnalysisIndex({ indexFile });
  assert.equal(inspected.tokenCountRecords, 3);
  assert.equal(inspected.reassembledLineMismatches, 0);
  // Distinct cumulative-token keys can only ever be fewer than the records
  // they were deduplicated from; here all three totals differ.
  assert.equal(inspected.snapshotKeys, 3);
  assert.equal(result.diagnostics.snapshotKeysStored, 3);
});
