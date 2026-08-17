import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION,
  compareLocalAccountingSemanticReceipts,
  createLocalAccountingSemanticReceipt,
} from "../src/local-accounting-parity-receipt.js";
import {
  createLocalAnalysisIndexReadScan,
  refreshLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import { buildReplaySafeAccountingCache } from "../src/replay-safe-accounting-cache.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { createLocalUnifiedAccountingSource } from "../src/local-unified-accounting-source.js";

const START_AT = "2026-08-01T00:00:00.000Z";
const END_AT = "2026-08-02T00:00:00.000Z";
const CONTRACT_VERSION = "local-index-retirement-shadow-parity-v1";
const PARITY_KEY = Buffer.from(
  "local-index-retirement-shadow-parity-key-v1",
);

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

function tokenCount(timestamp, total, last, usedPercent) {
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
          window_minutes: 10_080,
          resets_at: Math.floor(Date.parse("2026-08-08T00:00:00.000Z") / 1_000),
        },
      },
    },
  });
}

async function createCorpus() {
  const root = await mkdtemp(join(tmpdir(), "local-index-retirement-shadow-"));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "08", "01");
  const state = join(root, "state");
  await mkdir(sessions, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(sessions, "rollout-2026-08-01T12-00-00-shadow.jsonl"),
    `${[
      JSON.stringify({
        timestamp: "2026-08-01T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "SHADOW_PARITY_SESSION",
          session_id: "SHADOW_PARITY_SESSION",
          thread_source: "user",
          originator: "codex_cli_rs",
          cwd: "/private/shadow-parity-project",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T12:00:00.010Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", effort: "medium" },
      }),
      tokenCount(
        "2026-08-01T12:01:00.000Z",
        usage(100, 20),
        usage(100, 20),
        10,
      ),
      tokenCount(
        "2026-08-01T12:02:00.000Z",
        usage(180, 35),
        usage(80, 15),
        12,
      ),
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  return { root, codexHome, state };
}

function accountingProjection(cache) {
  return {
    periods: cache.periods,
    timeline: cache.timeline,
    sparkUsageTimeline: cache.sparkUsageTimeline,
    quotaTimeline: cache.quotaTimeline,
    sparkQuotaTimeline: cache.sparkQuotaTimeline,
    weekly: cache.weekly,
    weeklyCalibration: cache.weeklyCalibration,
    weeklyCalibrationInput: cache.weeklyCalibrationInput,
  };
}

async function fileReceipt(indexFile, unified = false) {
  const scan = unified
    ? createLocalUnifiedAccountingSource({ indexFile })
    : createLocalAnalysisIndexReadScan({ indexFile, requireComplete: true });
  return createLocalAccountingSemanticReceipt({
    scan,
    startAt: START_AT,
    endAt: END_AT,
    byteKey: PARITY_KEY,
  });
}

function assertContextPresenceMismatch(legacyReceipt, unifiedReceipt) {
  assert.equal(legacyReceipt.usage.missingTotalInputContextCount, 0);
  assert.equal(legacyReceipt.usage.count, unifiedReceipt.usage.count);
  assert.equal(
    unifiedReceipt.usage.missingTotalInputContextCount,
    unifiedReceipt.usage.count,
  );
  // This is a known cutover blocker: the legacy reader materializes a missing
  // context value as explicit zero, while unified preserves SQL NULL as an
  // omitted callback field. Keep the mismatch classified; do not canonicalize
  // it away in the test or production reader.
  assert.deepEqual(
    compareLocalAccountingSemanticReceipts(legacyReceipt, unifiedReceipt),
    {
      equal: false,
      mismatchCategories: [
        "usage_tokens",
        "usage_digest",
        "usage_dimensions",
      ],
    },
  );
}

test("published legacy and unified indexes classify context-presence mismatch that blocks cutover", async () => {
  const { root, codexHome, state } = await createCorpus();
  const legacyIndexFile = join(state, "local-analysis-index-v2.sqlite");
  const legacySecretFile = join(state, "local-analysis-index-secret-v2");
  const unifiedIndexFile = join(state, "local-unified-index-v1.sqlite");
  const unifiedSecretFile = join(state, "local-unified-index-device-salt-v1");
  try {
    await refreshLocalAnalysisIndex({
      indexFile: legacyIndexFile,
      secretFile: legacySecretFile,
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      workerCount: 1,
      chunkBytes: 4 * 1024 * 1024,
    });
    await rebuildLocalUnifiedIndex({
      codexHome,
      indexFile: unifiedIndexFile,
      secretFile: unifiedSecretFile,
      contractVersion: CONTRACT_VERSION,
    });

    const unifiedReader = createLocalUnifiedAccountingSource({
      indexFile: unifiedIndexFile,
    });
    const unifiedReadResult = await unifiedReader({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(unifiedReadResult.coverage.status, "partial");
    assert.equal(
      unifiedReadResult.coverage.blockReason,
      "accounting_contract_incomplete",
    );
    assert.equal(unifiedReadResult.diagnosticCoverage, "unavailable");
    assert.deepEqual(unifiedReadResult.diagnostics, {});
    assert.deepEqual(unifiedReadResult.capabilities, {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: false,
      sourceOffsetProvenance: false,
      sourceScopedQuotaOccurrences: false,
      durableDiagnostics: false,
      crashSafeGenerationPublication: false,
    });

    const legacyReceipt = await fileReceipt(legacyIndexFile);
    const unifiedReceipt = await fileReceipt(unifiedIndexFile, true);
    assert.equal(legacyReceipt.version, LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION);
    assert.equal(unifiedReceipt.version, LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION);
    assertContextPresenceMismatch(legacyReceipt, unifiedReceipt);

    const legacyCache = await buildReplaySafeAccountingCache({
      codexHome,
      scan: createLocalAnalysisIndexReadScan({
        indexFile: legacyIndexFile,
        requireComplete: true,
      }),
      now: () => Date.parse(END_AT),
      windowDays: 365,
    });
    const unifiedCache = await buildReplaySafeAccountingCache({
      codexHome,
      scan: createLocalUnifiedAccountingSource({ indexFile: unifiedIndexFile }),
      now: () => Date.parse(END_AT),
      windowDays: 365,
    });
    assert.deepEqual(
      accountingProjection(legacyCache),
      accountingProjection(unifiedCache),
    );

    // Exercise the opt-in full-history calibration reader without changing
    // production authority: legacyCache above remains the authoritative
    // shadow result.
    const unifiedHistoryCache = await buildReplaySafeAccountingCache({
      codexHome,
      scan: unifiedReader,
      unifiedIndexFile,
      now: () => Date.parse(END_AT),
      windowDays: 365,
    });
    assert.equal(
      unifiedHistoryCache.weeklyCalibrationInput.source,
      "unified_index",
    );
    const legacyHistoryCache = await buildReplaySafeAccountingCache({
      codexHome,
      scan: createLocalAnalysisIndexReadScan({
        indexFile: legacyIndexFile,
        requireComplete: true,
      }),
      unifiedIndexFile,
      now: () => Date.parse(END_AT),
      windowDays: 365,
    });
    assert.deepEqual(
      accountingProjection(legacyHistoryCache),
      accountingProjection(unifiedHistoryCache),
    );

    // The legacy result remains the authoritative shadow result. This test only
    // reads the published generations and never writes either database.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published readers stay usable after raw fixture sources disappear", async () => {
  const { root, codexHome, state } = await createCorpus();
  const legacyIndexFile = join(state, "local-analysis-index-v2.sqlite");
  const legacySecretFile = join(state, "local-analysis-index-secret-v2");
  const unifiedIndexFile = join(state, "local-unified-index-v1.sqlite");
  const unifiedSecretFile = join(state, "local-unified-index-device-salt-v1");
  try {
    await refreshLocalAnalysisIndex({
      indexFile: legacyIndexFile,
      secretFile: legacySecretFile,
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      workerCount: 1,
      chunkBytes: 4 * 1024 * 1024,
    });
    await rebuildLocalUnifiedIndex({
      codexHome,
      indexFile: unifiedIndexFile,
      secretFile: unifiedSecretFile,
      contractVersion: CONTRACT_VERSION,
    });

    const before = await Promise.all([
      stat(legacyIndexFile),
      stat(unifiedIndexFile),
    ]);
    const expectedLegacy = await fileReceipt(legacyIndexFile);
    const expectedUnified = await fileReceipt(unifiedIndexFile, true);
    await rm(codexHome, { recursive: true, force: true });

    const actualLegacy = await fileReceipt(legacyIndexFile);
    const actualUnified = await fileReceipt(unifiedIndexFile, true);
    assert.deepEqual(actualLegacy, expectedLegacy);
    assert.deepEqual(actualUnified, expectedUnified);
    assertContextPresenceMismatch(actualLegacy, actualUnified);

    const after = await Promise.all([
      stat(legacyIndexFile),
      stat(unifiedIndexFile),
    ]);
    for (const [beforeStat, afterStat] of before.map((value, index) => [value, after[index]])) {
      assert.equal(afterStat.size, beforeStat.size);
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
