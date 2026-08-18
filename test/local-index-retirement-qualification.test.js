import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS,
  createSyntheticLocalIndexRetirementCorpus,
  runLocalIndexRetirementQualification,
} from "../scripts/benchmark-local-index-retirement.mjs";

test("synthetic unified index retirement path qualifies without legacy state", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "local-index-retirement-qualification-"),
  );
  try {
    const receipt = await runLocalIndexRetirementQualification({
      stateDirectory,
    });

    assert.equal(receipt.synthetic, true);
    assert.deepEqual(receipt.accountingWindow, {
      startAt: "2025-08-02T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      durationDays: 365,
    });
    assert.equal(receipt.accounting.sourceMode, "unified");
    assert.equal(receipt.accounting.contextBehavior, "legacy_zero");
    assert.equal(receipt.accounting.weeklyCalibrationSource, "unified_index");
    assert.equal(receipt.accounting.relaunchedStatus, "available");
    assert.equal(receipt.companion.timelineSource, "unified_local_index");
    assert.equal(receipt.companion.historyStatus, "complete");
    assert.equal(receipt.noChange.unchanged, true);
    assert.equal(receipt.noChange.bytesScanned, 0);
    assert.equal(receipt.noChange.sizeUnchanged, true);
    assert.equal(receipt.noChange.mtimeUnchanged, true);
    assert.equal(receipt.append.sourcesResumed, 1);
    assert.equal(receipt.append.bytesScanned, receipt.appendedBytes);
    assert.ok(receipt.append.insertedUsageEvents >= 1);
    assert.equal(receipt.legacyPathsAbsent, true);
    assert.deepEqual(receipt.legacyState, {
      analysisSentinelsSeeded: false,
      analysisSentinelsPresentAfter: false,
      analysisSentinelsUnchanged: true,
      archiveFilesAbsentAfter: true,
    });
    assert.ok(receipt.sourceCount >= 2);
    assert.ok(receipt.usageEvents >= 5);
    assert.ok(receipt.sourceBytes > 0);
    assert.equal(receipt.finalSourceBytes, receipt.sourceBytes + receipt.appendedBytes);
    assert.ok(receipt.appendedBytes > 0);
    assert.notEqual(receipt.generations.cold.fingerprint, receipt.generations.append.fingerprint);
    assert.equal(receipt.runCount, 1);
    assert.equal(receipt.statistics.runCount, 1);
    assert.equal(
      receipt.statistics.timings.coldRebuild.median,
      receipt.timings.coldRebuild,
    );
    assert.ok(receipt.counts.usageCallbacks >= receipt.counts.usageEvents);
    assert.ok(receipt.counts.quotaCallbacks >= 0);
    assert.equal(
      receipt.counts.indexedFacts,
      receipt.counts.usageFacts + receipt.counts.quotaFacts,
    );

    for (const elapsedMs of Object.values(receipt.timings)) {
      assert.ok(Number.isFinite(elapsedMs));
      assert.ok(elapsedMs <= LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxPhaseMs);
    }
    assert.ok(receipt.timings.totalMs <= LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxTotalMs);
    assert.ok(receipt.rssDeltaBytes <= LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxRssDeltaBytes);
    assert.ok(receipt.diskBytes <= LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxDiskBytes);
    assert.ok(receipt.sourceBytes <= LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxSourceBytes);

    // The benchmark receipt is safe to persist or attach to a release record:
    // it reports bounded counters and fingerprints only, never fixture paths,
    // source filenames, or raw JSONL/event content.
    const serializedReceipt = JSON.stringify(receipt);
    assert.doesNotMatch(
      serializedReceipt,
      /synthetic-codex-home|rollout-|synthetic-qualification|token_count|\.jsonl|\.sqlite/u,
    );
    assert.equal(Object.hasOwn(receipt, "stateDirectory"), false);
    assert.equal(Object.hasOwn(receipt, "paths"), false);
    assert.equal(receipt.legacyComparison, null);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("unified refresh preserves existing legacy analysis sentinels byte-for-byte", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "local-index-retirement-legacy-sentinels-"),
  );
  try {
    const receipt = await runLocalIndexRetirementQualification({
      stateDirectory,
      seedLegacySentinels: true,
    });
    assert.equal(receipt.legacyPathsAbsent, false);
    assert.deepEqual(receipt.legacyState, {
      analysisSentinelsSeeded: true,
      analysisSentinelsPresentAfter: true,
      analysisSentinelsUnchanged: true,
      archiveFilesAbsentAfter: true,
    });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("explicit real-corpus mode supports repeated statistics and explicit legacy comparison", async () => {
  const corpusDirectory = await mkdtemp(
    join(tmpdir(), "local-index-retirement-real-corpus-fixture-"),
  );
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "local-index-retirement-real-corpus-state-"),
  );
  try {
    const corpus = await createSyntheticLocalIndexRetirementCorpus(corpusDirectory);
    const receipt = await runLocalIndexRetirementQualification({
      codexHome: corpus.codexHome,
      stateDirectory,
      runs: 2,
      startAt: "2024-08-02T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      workerCount: 2,
      compareLegacy: true,
    });
    assert.equal(receipt.synthetic, false);
    assert.equal(receipt.runCount, 2);
    assert.equal(receipt.statistics.runCount, 2);
    assert.ok(receipt.statistics.timings.coldRebuild.median >= 0);
    assert.ok(receipt.statistics.timings.coldRebuild.p95 >= receipt.statistics.timings.coldRebuild.median);
    assert.ok(receipt.statistics.counts.sourceBytes.median > 0);
    assert.equal(receipt.runs.every((run) => run.synthetic === false), true);
    assert.equal(receipt.runs.every((run) => run.append.status === "not_run"), true);
    assert.equal(receipt.legacyComparison.mode, "legacy");
    assert.equal(receipt.legacyComparison.selection, "explicit");
    assert.deepEqual(receipt.accountingWindow, {
      startAt: "2024-08-02T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      durationDays: 730,
    });
    assert.equal(receipt.workerCount, 2);
    assert.equal(
      receipt.legacyComparison.runs.every((run) => run.workerCount === 2),
      true,
    );
    assert.deepEqual(
      receipt.legacyComparison.accountingWindow,
      receipt.accountingWindow,
    );
    assert.equal(receipt.legacyComparison.runCount, 2);
    assert.match(
      receipt.legacyComparison.invocation.legacyCommandTemplate,
      /benchmark-local-analysis-pipeline\.mjs .*--start-at <ISO> .*--workers <WORKERS>/u,
    );
    assert.equal(
      receipt.legacyComparison.runs.every((run) => run.mode === "legacy"),
      true,
    );
    const serializedReceipt = JSON.stringify(receipt);
    assert.doesNotMatch(
      serializedReceipt,
      /local-index-retirement-real-corpus|synthetic-codex-home|\.jsonl|\.sqlite/u,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(corpusDirectory, { recursive: true, force: true });
  }
});
