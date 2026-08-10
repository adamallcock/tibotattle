import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanCodexLogEvents } from "../src/codex-log-scan.js";
import { extractRolloutUsage } from "../src/local-unified-index-extract.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { openLocalUnifiedIndex } from "../src/local-unified-index.js";

// Regression fixture for the interleaved-cumulative-stream pathology,
// reproduced from the live corpus (~/.codex sessions from Jun 16): within a
// single rollout file two cumulative `total_token_usage` streams interleave
// line-by-line, both climbing, and counters reset mid-file. The old delta
// derivation clamped every negative swing to zero and then charged every
// positive inter-stream swing as real usage — on Jun 29 that materialized
// ~378 phantom events totaling 13.02B tokens in one session, including a
// single 5.42B-token "event" right after a counter reset — while the
// co-reported `last_token_usage` stayed honest (125k-240k per turn)
// throughout. Both restatements of the derivation must charge exactly the
// per-turn values here: the derived events sum to the sum of the honest
// `last_token_usage` rows, with no phantom inter-stream gap.

const START_AT = "2026-06-29T13:00:00.000Z";
const END_AT = "2026-06-29T15:00:00.000Z";

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

function tokenCount(timestamp, total, last) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  });
}

// Honest per-turn values, one per event, in file order.
const LASTS = [
  usage(100_000, 10_000), // stream A, turn 1
  usage(60_000, 6_000), //   stream B, turn 1 (regression: 66_000 < 110_000)
  usage(130_000, 13_000), // stream A, turn 2 (inter-stream positive swing)
  usage(61_000, 6_100), //   stream B, turn 2 (regression)
  usage(132_000, 13_200), // stream A, turn 3 (inter-stream positive swing)
  usage(50_000, 5_000), //   reset stream, turn 1 (mid-file counter reset)
  usage(138_000, 13_800), // stream A, turn 4 (the "5.42B event" analogue)
  usage(51_000, 5_100), //   reset stream, turn 2 (regression)
];

// Cumulative totals per stream: each stream's total is its own prior total
// plus its own per-turn value, exactly as measured on the live corpus.
const TOTALS = [
  usage(100_000, 10_000), //  A1 = L1
  usage(60_000, 6_000), //    B1 = L2
  usage(230_000, 23_000), //  A2 = A1 + L3
  usage(121_000, 12_100), //  B2 = B1 + L4
  usage(362_000, 36_200), //  A3 = A2 + L5
  usage(50_000, 5_000), //    R1 = L6 (counter reset)
  usage(500_000, 50_000), //  A4 = A3 + L7
  usage(101_000, 10_100), //  R2 = R1 + L8
];

const EXPECTED_INPUT = LASTS.reduce((sum, last) => sum + last.input_tokens, 0);
const EXPECTED_OUTPUT = LASTS.reduce((sum, last) => sum + last.output_tokens, 0);
const LARGEST_HONEST_TURN = Math.max(...LASTS.map((last) => last.total_tokens));

function rolloutLines() {
  const lines = [
    JSON.stringify({
      timestamp: "2026-06-29T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-interleaved" },
    }),
    JSON.stringify({
      timestamp: "2026-06-29T14:00:00.100Z",
      type: "turn_context",
      payload: { model: "gpt-test" },
    }),
  ];
  for (const [index, total] of TOTALS.entries()) {
    lines.push(tokenCount(
      `2026-06-29T14:00:${String(index + 1).padStart(2, "0")}.000Z`,
      total,
      LASTS[index],
    ));
  }
  return lines;
}

async function interleavedCorpus() {
  const root = await mkdtemp(join(tmpdir(), "interleaved-streams-"));
  const sessions = join(root, "sessions", "2026", "06", "29");
  await mkdir(sessions, { recursive: true });
  const path = join(
    sessions,
    "rollout-2026-06-29T14-00-00-interleaved.jsonl",
  );
  await writeFile(path, `${rolloutLines().join("\n")}\n`);
  return { root, path };
}

test("provider parser charges per-turn values across interleaved streams and a mid-file reset", async () => {
  const { root } = await interleavedCorpus();
  try {
    const events = [];
    const result = await scanCodexLogEvents({
      codexHome: root,
      startAt: START_AT,
      endAt: END_AT,
      onUsage: (event) => events.push(event),
    });

    assert.equal(events.length, LASTS.length, "every honest turn is charged once");
    for (const [index, event] of events.entries()) {
      assert.deepEqual(
        { input: event.raw.input_tokens, output: event.raw.output_tokens },
        {
          input: LASTS[index].input_tokens,
          output: LASTS[index].output_tokens,
        },
        `event ${index} charges its own per-turn value`,
      );
      assert.ok(
        event.raw.total_tokens <= LARGEST_HONEST_TURN,
        `event ${index} carries no phantom inter-stream gap`,
      );
    }
    const inputSum = events.reduce((sum, event) => sum + event.raw.input_tokens, 0);
    const outputSum = events.reduce((sum, event) => sum + event.raw.output_tokens, 0);
    assert.equal(inputSum, EXPECTED_INPUT);
    assert.equal(outputSum, EXPECTED_OUTPUT);

    // Four regressions (B1, B2, the reset, R2) re-anchored without charging a
    // swing; three inter-stream positive swings (A2, A3, A4) had their deltas
    // suppressed in favour of the per-turn value.
    assert.equal(result.diagnostics.cumulativeCounterRegressions, 4);
    assert.equal(result.diagnostics.crossStreamDeltasSuppressed, 3);
    assert.equal(result.diagnostics.lastVsCumulativeMismatches, 3);
    assert.equal(result.diagnostics.duplicateSnapshotsSkipped, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("unified-index extract charges per-turn values across interleaved streams and a mid-file reset", async () => {
  const { root, path } = await interleavedCorpus();
  try {
    const events = [];
    const { size } = await stat(path);
    const outcome = await extractRolloutUsage(path, {
      size,
      onEvent: (event) => events.push(event),
    });

    assert.equal(events.length, LASTS.length);
    for (const [index, event] of events.entries()) {
      assert.deepEqual(
        {
          input: event.components.inputUncachedTokens,
          output: event.components.outputTextTokens,
        },
        {
          input: LASTS[index].input_tokens,
          output: LASTS[index].output_tokens,
        },
        `event ${index} charges its own per-turn value`,
      );
    }
    const inputSum = events.reduce(
      (sum, event) => sum + event.components.inputUncachedTokens,
      0,
    );
    const outputSum = events.reduce(
      (sum, event) => sum + event.components.outputTextTokens,
      0,
    );
    assert.equal(inputSum, EXPECTED_INPUT);
    assert.equal(outputSum, EXPECTED_OUTPUT);
    assert.equal(outcome.diagnostics.cumulativeCounterRegressions, 4);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("both restatements derive identical charges from the pathological file", async () => {
  const { root, path } = await interleavedCorpus();
  try {
    const parserEvents = [];
    await scanCodexLogEvents({
      codexHome: root,
      startAt: START_AT,
      endAt: END_AT,
      onUsage: (event) => parserEvents.push({
        input: event.components.input_uncached_tokens,
        output: event.components.output_text_tokens,
      }),
    });
    const extractEvents = [];
    const { size } = await stat(path);
    await extractRolloutUsage(path, {
      size,
      onEvent: (event) => extractEvents.push({
        input: event.components.inputUncachedTokens,
        output: event.components.outputTextTokens,
      }),
    });
    assert.deepEqual(extractEvents, parserEvents);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a full index rebuild over the pathological file stores no phantom tokens", async () => {
  const { root } = await interleavedCorpus();
  try {
    const result = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: "usage-event-v0.2",
    });
    assert.equal(result.usageEvents, LASTS.length);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      const totals = database.prepare(`
        SELECT SUM(tokens_in_uncached) AS iu, SUM(tokens_out_text) AS ot,
               MAX(tokens_in_uncached) AS max_iu
        FROM usage_event`).get();
      assert.equal(Number(totals.iu), EXPECTED_INPUT);
      assert.equal(Number(totals.ot), EXPECTED_OUTPUT);
      assert.ok(Number(totals.max_iu) <= 138_000);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
