import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBaselineCorrectionMigration } from "../src/correction-migration.js";
import { stableJson, withOwnerOnlyFileLock } from "../src/storage.js";

function fixture() {
  const knownComponents = {
    input_uncached_tokens: 40,
    input_cache_read_tokens: 50,
    input_cache_write_tokens: 0,
    output_text_tokens: 6,
    output_reasoning_tokens: 4,
  };
  const unknownComponents = {
    input_uncached_tokens: 2_685_437,
    input_cache_read_tokens: 68_264_192,
    input_cache_write_tokens: 0,
    output_text_tokens: 65_468,
    output_reasoning_tokens: 45_402,
  };
  const observation = {
    schemaVersion: "0.1",
    kind: "codex_quota_observation",
    observationId: "legacy-baseline",
    capturedAt: "2026-07-23T16:15:40.974Z",
    windows: [{
      local: {
        runcost: {
          totalTokens: 71_060_599,
          totalUsd: 1.25,
          components: Object.fromEntries(Object.keys(knownComponents).map((key) => [key, knownComponents[key] + unknownComponents[key]])),
          byModel: {
            "gpt-known": { components: knownComponents, events: 3, costUsd: 1.25, warningCounts: {} },
            unknown: { components: unknownComponents, events: 471, costUsd: 0, warningCounts: { unknown_model: 471 } },
          },
          warningCounts: { unknown_model: 471 },
        },
        diagnostics: { partiallyPricedEvents: 471 },
      },
    }],
  };
  const transitionDataset = {
    schemaVersion: "0.3",
    scope: { startAt: "2026-07-21T17:06:03.000Z", endAt: observation.capturedAt },
    pricing: { estimatorVersion: "runcost-api-price-v0.3", selectedSource: "fixture" },
    summary: {
      filesScanned: 2,
      usageEvents: 3,
      pricedEvents: 3,
      partiallyPricedEvents: 0,
      unpricedModels: [],
      tokenComponentsByModel: { "gpt-known": knownComponents },
    },
    diagnostics: { forkReplayEventsSkipped: 1, malformedLines: 0, lineageParentsMissing: 0 },
  };
  return { observation, transitionDataset };
}

test("baseline replay migration is deterministic, append-only, and idempotent", () => {
  const { observation, transitionDataset } = fixture();
  const originalBytes = stableJson(observation);
  const first = planBaselineCorrectionMigration({ observations: [observation], transitionDataset });
  const second = planBaselineCorrectionMigration({
    observations: [observation],
    transitionDataset,
    existingCorrections: [first.correction],
  });

  assert.equal(stableJson(observation), originalBytes);
  assert.equal(first.recordsToAppend.length, 1);
  assert.equal(second.recordsToAppend.length, 0);
  assert.equal(stableJson(first.correction), stableJson(second.correction));
  const effective = second.resolution.effectiveByOriginalId[observation.observationId].derived;
  assert.equal(effective.aggregateTokenTotal, 100);
  assert.equal(effective.apiPricedCostUsd, 1.25);
  assert.deepEqual(effective.warnings, []);
  assert.equal(Object.hasOwn(effective.byModel, "unknown"), false);
  assert.equal(second.correction.diagnostics.replayedForkHistoryTokensRemoved, 71_060_499);
  assert.equal(second.correction.diagnostics.originalObservationRewritten, false);
});

test("the correction ledger lock excludes concurrent migrations and is cleaned after release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-lock-"));
  const lockPath = join(directory, "corrections.lock");
  let release;
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });

  try {
    const first = withOwnerOnlyFileLock(lockPath, async () => {
      const metadata = await stat(lockPath);
      assert.equal(metadata.mode & 0o777, 0o600);
      signalEntered();
      await held;
    });
    await entered;
    await assert.rejects(
      () => withOwnerOnlyFileLock(lockPath, async () => {}),
      /already held/i,
    );
    release();
    await first;
    await withOwnerOnlyFileLock(lockPath, async () => {});
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});
