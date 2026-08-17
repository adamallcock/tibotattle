import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseClaudeDesktopPlanHistory,
  readClaudeDesktopPlanHistory,
} from "../src/claude-desktop-plan-history.js";
import {
  openClaudeDesktopLedgerPrototype,
  projectProviderOutput,
} from "../src/claude-desktop-ledger-prototype.js";
import { benchmarkClaudeDesktopPhase0 } from "../src/claude-desktop-phase0-benchmark.js";
import {
  benchmarkClaudeDesktopIncremental,
  benchmarkClaudeDesktopIncrementalIsolated,
} from "../src/claude-desktop-incremental-benchmark.js";
import {
  CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT,
  createClaudeDesktopLedgerCandidate,
  runClaudeDesktopIncrementalRefresh,
} from "../src/claude-desktop-incremental-refresh.js";
import { readClaudeDesktopPricingCache } from "../src/claude-desktop-pricing-cache.js";

const SECRET = Buffer.alloc(32, 41);
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/claude-desktop-phase0/", import.meta.url));
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function json(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8"));
}

async function materializeBenchmarkCorpus() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-phase0-benchmark-"));
  await chmod(root, 0o700);
  const metadataDirectory = join(root, "metadata");
  const projectsDirectory = join(root, "projects");
  const marker = join(root, ".last-cleanup");
  const quota = join(root, "plan-usage-history.json");
  await mkdir(metadataDirectory, { mode: 0o700 });
  await mkdir(projectsDirectory, { mode: 0o700 });
  const fixture = await json("desktop-corpus-v1.json");
  for (const item of fixture.metadata) {
    await writeFile(join(metadataDirectory, item.filename), JSON.stringify(item.value), { mode: 0o600 });
  }
  for (const item of fixture.transcripts) {
    const path = join(projectsDirectory, item.relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, item.rows.length === 0 ? "" : `${item.rows.map(JSON.stringify).join("\n")}\n`, {
      mode: 0o600,
    });
  }
  await writeFile(marker, "2026-08-16T17:12:48.034Z\n", { mode: 0o600 });
  await writeFile(quota, await readFile(join(FIXTURE_ROOT, "quota-history-v2.json")), { mode: 0o600 });
  return { root, metadataDirectory, projectsDirectory, marker, quota };
}

test("native quota parser keys accounts, preserves corrections, and contains unknown meters", async () => {
  const raw = await readFile(join(FIXTURE_ROOT, "quota-history-v2.json"));
  const result = parseClaudeDesktopPlanHistory(raw, { secret: SECRET });
  assert.equal(result.sampleCount, 4);
  assert.equal(result.observationCount, 9);
  assert.equal(result.accountCount, 2);
  assert.equal(result.unknownMeterCount, 1);
  const corrected = result.observations.filter((item) => (
    item.observedAtMs === 1784894460000 && item.meterId === "five_hour"
  ));
  assert.deepEqual(corrected.map((item) => item.utilizationPercent), [17, 15]);
  assert.deepEqual(corrected.map((item) => item.revision), [1, 2]);
  assert.ok(result.observations.every((item) => item.resetsAtMs === null));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("fixture-organization"), false);
  assert.equal(serialized.includes("future_meter"), false);
});

test("native quota reader fails closed on truncated, unsupported, unsafe, and invalid data", async () => {
  assert.throws(
    () => parseClaudeDesktopPlanHistory('{"version":2,"samples":[', { secret: SECRET }),
    (error) => error.code === "claude_desktop_plan_history_malformed",
  );
  assert.throws(
    () => parseClaudeDesktopPlanHistory({ version: 3, samples: [] }, { secret: SECRET }),
    (error) => error.code === "claude_desktop_plan_history_unsupported_schema",
  );
  assert.throws(
    () => parseClaudeDesktopPlanHistory({
      version: 2,
      samples: [{ t: 1, org: "fixture", u: { fh: 101 } }],
    }, { secret: SECRET }),
    (error) => error.code === "claude_desktop_plan_history_invalid_utilization",
  );

  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-quota-reader-"));
  try {
    const path = join(root, "plan-usage-history.json");
    await writeFile(path, await readFile(join(FIXTURE_ROOT, "quota-history-v2.json")), { mode: 0o600 });
    assert.equal((await readClaudeDesktopPlanHistory(path, { secret: SECRET })).sampleCount, 4);
    await chmod(path, 0o666);
    await assert.rejects(
      readClaudeDesktopPlanHistory(path, { secret: SECRET }),
      (error) => error.code === "claude_desktop_plan_history_source_unsafe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function claudeCandidate(keys, { final = false } = {}) {
  return {
    provider: "anthropic_claude_code",
    logicalKey: keys.logical,
    candidateKey: final ? keys.candidateFinal : keys.candidatePartial,
    sourceKey: keys.claudeSource,
    sourceGeneration: 1,
    observedAtMs: final ? 1784894460000 : 1784894400000,
    modelKey: keys.claudeModel,
    inputUncachedTokens: 10,
    inputCacheReadTokens: 30,
    inputCacheWriteTokens: 40,
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: final ? 29 : 3,
    outputKind: "provider_reported_combined",
    parserVersion: "fixture-parser-v1",
  };
}

function codexCandidate(keys) {
  return {
    provider: "openai_codex",
    logicalKey: keys.codexLogical,
    candidateKey: keys.codexCandidate,
    sourceKey: keys.codexSource,
    sourceGeneration: 1,
    observedAtMs: 1784894400000,
    modelKey: keys.codexModel,
    inputUncachedTokens: 7,
    inputCacheReadTokens: 11,
    inputCacheWriteTokens: 0,
    outputTextTokens: 13,
    outputReasoningTokens: 17,
    outputCombinedTokens: null,
    outputKind: "separate_text_reasoning",
    parserVersion: "fixture-parser-v1",
  };
}

function richClaudeCandidate(keys, { final = false } = {}) {
  const eventTime = new Date(final ? 1784894460000 : 1784894400000).toISOString();
  const candidate = {
    provider: "anthropic_claude_code",
    occurrenceMaterial: keys.logical,
    eventTime,
    modelDeclaration: {
      modelId: "claude-opus-4-8",
      modelRecognition: "recognized",
      modelFingerprint: null,
    },
    billingSurface: "claude_subscription",
    outputKind: "provider_reported_combined",
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 30,
      inputCacheWriteTokens: 40,
      inputCacheWrite5mTokens: 13,
      inputCacheWrite1hTokens: 27,
      outputCombinedTokens: final ? 29 : 3,
    },
    totalInputContextTokens: 80,
    candidateVersion: "fixture-pricing-v1",
  };
  return createClaudeDesktopLedgerCandidate({
    candidate,
    sourceKey: keys.claudeSource,
    sourceGeneration: 1,
  });
}

test("durable prototype preserves winners, provider isolation, quota revisions, and purge tombstones", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const quota = parseClaudeDesktopPlanHistory(
    await readFile(join(FIXTURE_ROOT, "quota-history-v2.json")),
    { secret: SECRET },
  );
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  try {
    assert.deepEqual(ledger.mergeUsageCandidates([claudeCandidate(keys)]), {
      inserted: 1,
      superseded: 0,
      tombstoned: 0,
    });
    assert.throws(
      () => ledger.mergeUsageCandidates([{
        ...claudeCandidate(keys),
        modelKey: keys.codexModel,
      }]),
      (error) => error.code === "claude_desktop_ledger_candidate_conflict",
    );
    ledger.markSourcesMissing("anthropic_claude_code", [keys.claudeSource], {
      observedAtMs: 1784894430000,
    });
    assert.equal(ledger.providerSnapshot("anthropic_claude_code").winnerCount, 1);

    ledger.mergeUsageCandidates([codexCandidate(keys)]);
    ledger.publishProjection("openai_codex", { publishedAtMs: 1784894500000 });
    const codexBefore = ledger.providerSnapshot("openai_codex");

    assert.deepEqual(ledger.mergeUsageCandidates([claudeCandidate(keys, { final: true })]), {
      inserted: 1,
      superseded: 1,
      tombstoned: 0,
    });
    ledger.publishProjection("anthropic_claude_code", { publishedAtMs: 1784894500000 });
    const claudeProjected = ledger.providerSnapshot("anthropic_claude_code");
    assert.equal(claudeProjected.rows[0].outputTextTokens, 29);
    assert.equal(claudeProjected.rows[0].outputReasoningTokens, 0);
    assert.equal(claudeProjected.rows[0].outputCombinedTokens, 29);
    assert.equal(
      ledger.providerSummary("anthropic_claude_code").projectionPayloadSha256,
      createHash("sha256").update(stableJson(claudeProjected.rows)).digest("hex"),
    );
    assert.deepEqual(ledger.providerSnapshot("openai_codex"), codexBefore);

    const beforeFailedProjection = ledger.providerSnapshot("anthropic_claude_code");
    assert.throws(
      () => ledger.publishProjection("anthropic_claude_code", {
        publishedAtMs: 1784894510000,
        simulateFailure: true,
      }),
      (error) => error.code === "claude_desktop_ledger_projection_failed",
    );
    assert.deepEqual(ledger.providerSnapshot("anthropic_claude_code"), beforeFailedProjection);

    const mergedQuota = ledger.mergeQuotaObservations(quota.observations, {
      sourceKey: keys.quotaSource,
      acceptedAtMs: 1784894600000,
    });
    assert.deepEqual(mergedQuota, { inserted: 8, duplicates: 1, tombstoned: 0 });
    assert.equal(ledger.providerSnapshot("anthropic_claude_code").quotaRevisionCount, 8);
    assert.deepEqual(ledger.mergeQuotaObservations(quota.observations.slice(2), {
      sourceKey: keys.quotaSource,
      acceptedAtMs: 1784894700000,
    }), { inserted: 0, duplicates: 7, tombstoned: 0 });

    const purge = ledger.purge("anthropic_claude_code", {
      startAtMs: 1784894400000,
      endAtMs: 1784894460000,
      createdAtMs: 1784894800000,
    });
    assert.equal(purge.usageDeleted, 2);
    assert.ok(purge.quotaDeleted > 0);
    assert.equal(ledger.providerSnapshot("anthropic_claude_code").winnerCount, 0);
    assert.deepEqual(ledger.mergeUsageCandidates([claudeCandidate(keys, { final: true })]), {
      inserted: 0,
      superseded: 0,
      tombstoned: 1,
    });
    assert.deepEqual(ledger.providerSnapshot("openai_codex"), codexBefore);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("partial purge retains exact before and after coverage ranges", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-gaps-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  try {
    ledger.markSourcesMissing("anthropic_claude_code", [keys.claudeSource], {
      observedAtMs: 100,
    });
    ledger.markSourcesObserved("anthropic_claude_code", [{
      sourceKey: keys.claudeSource,
      sourceGeneration: 1,
    }], { observedAtMs: 1000 });
    ledger.markSourcesMissing("anthropic_claude_code", [keys.codexSource], {
      observedAtMs: 100,
    });

    ledger.purge("anthropic_claude_code", {
      startAtMs: 400,
      endAtMs: 600,
      createdAtMs: 2000,
    });

    assert.deepEqual(ledger.readCoverageGaps("anthropic_claude_code"), [
      {
        sourceKey: keys.claudeSource,
        kind: "missing_suspected",
        startAtMs: 100,
        endAtMs: 399,
      },
      {
        sourceKey: keys.claudeSource,
        kind: "missing_suspected",
        startAtMs: 601,
        endAtMs: 1000,
      },
      {
        sourceKey: keys.codexSource,
        kind: "missing_suspected",
        startAtMs: 100,
        endAtMs: 399,
      },
      {
        sourceKey: keys.codexSource,
        kind: "missing_suspected",
        startAtMs: 601,
        endAtMs: null,
      },
    ]);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("purging an unrelated interval preserves surviving winner revision provenance", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const survivorKeys = {
    ...keys,
    logical: "a".repeat(64),
    candidatePartial: "b".repeat(64),
    candidateFinal: "c".repeat(64),
    claudeSource: "d".repeat(64),
    claudeModel: "e".repeat(64),
  };
  const purgedKeys = {
    ...keys,
    logical: "f".repeat(64),
    candidatePartial: "a".repeat(63) + "b",
    candidateFinal: "a".repeat(63) + "c",
    claudeSource: "a".repeat(63) + "d",
    claudeModel: "a".repeat(63) + "e",
  };
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-revisions-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  try {
    ledger.mergeUsageCandidates([{
      ...claudeCandidate(survivorKeys),
      observedAtMs: 100,
    }], { acceptedAtMs: 10 });
    ledger.mergeUsageCandidates([{
      ...claudeCandidate(survivorKeys, { final: true }),
      observedAtMs: 200,
    }], { acceptedAtMs: 20 });
    ledger.mergeUsageCandidates([{
      ...claudeCandidate(purgedKeys),
      observedAtMs: 500,
    }], { acceptedAtMs: 30 });
    assert.deepEqual(ledger.readWinnerProvenance("anthropic_claude_code"), [
      {
        logicalKey: survivorKeys.logical,
        candidateKey: survivorKeys.candidateFinal,
        revision: 2,
        updatedAtMs: 20,
      },
      {
        logicalKey: purgedKeys.logical,
        candidateKey: purgedKeys.candidatePartial,
        revision: 1,
        updatedAtMs: 30,
      },
    ]);

    assert.equal(ledger.purge("anthropic_claude_code", {
      startAtMs: 500,
      endAtMs: 500,
      createdAtMs: 40,
    }).usageDeleted, 1);
    assert.deepEqual(ledger.readWinnerProvenance("anthropic_claude_code"), [{
      logicalKey: survivorKeys.logical,
      candidateKey: survivorKeys.candidateFinal,
      revision: 2,
      updatedAtMs: 20,
    }]);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude pricing inputs survive replay, winner correction, and ledger reopen", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-pricing-"));
  const path = join(root, "ledger.sqlite");
  let ledger = openClaudeDesktopLedgerPrototype(path);
  try {
    const partial = richClaudeCandidate(keys);
    assert.deepEqual(ledger.mergeUsageCandidates([partial]), {
      inserted: 1,
      superseded: 0,
      tombstoned: 0,
    });
    ledger.publishProjection("anthropic_claude_code", { publishedAtMs: 1784894500000 });
    const first = ledger.readPricingProjection();
    assert.equal(first.productProvider, "anthropic_claude_code");
    assert.equal(first.accountingVendor, "anthropic");
    assert.equal(first.coverageStatus, "fully_priced");
    assert.equal(first.coverageCounts.fullyPriced, 1);
    assert.equal(first.rows[0].pricingCoverageStatus, "fully_priced");
    assert.equal(first.rows[0].projection.pricing.pricingContext.pricedAt, partial.eventTime);
    assert.equal(first.rows[0].projection.pricing.components.some((item) => (
      item.name === "input_cache_write_tokens"
        && item.pricingStatus === "priced"
    )), true);

    assert.deepEqual(ledger.mergeUsageCandidates([partial]), {
      inserted: 0,
      superseded: 0,
      tombstoned: 0,
    });
    assert.deepEqual(ledger.readPricingProjection(), first);

    ledger.close();
    ledger = openClaudeDesktopLedgerPrototype(path);
    assert.deepEqual(ledger.readPricingProjection(), first);

    const final = richClaudeCandidate(keys, { final: true });
    assert.deepEqual(ledger.mergeUsageCandidates([final]), {
      inserted: 1,
      superseded: 1,
      tombstoned: 0,
    });
    const corrected = ledger.readPricingProjection();
    assert.equal(corrected.usageProjectionGeneration, first.usageProjectionGeneration);
    assert.notEqual(corrected.payloadSha256, first.payloadSha256);
    assert.equal(corrected.rows[0].candidateKey, final.candidateKey);
    assert.equal(corrected.rows[0].revision, 2);
    assert.equal(corrected.rows[0].projection.pricing.components.some((item) => (
      item.name === "output_combined_tokens" && item.quantity === "29"
    )), true);
    assert.deepEqual(ledger.mergeUsageCandidates([final]), {
      inserted: 0,
      superseded: 0,
      tombstoned: 0,
    });
    assert.deepEqual(ledger.readPricingProjection(), corrected);
    assert.throws(
      () => ledger.readPricingProjection("openai_codex"),
      (error) => error.code === "claude_desktop_ledger_pricing_provider",
    );
    assert.throws(
      () => ledger.readPricingProjection("anthropic_claude_code", {
        priceEpochBasis: "current_price_sensitivity",
      }),
      (error) => error.code === "claude_desktop_ledger_pricing_options",
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy Claude ledger rows remain visible as unpriced coverage", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-legacy-pricing-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  try {
    ledger.mergeUsageCandidates([claudeCandidate(keys)]);
    const projection = ledger.readPricingProjection();
    assert.equal(projection.eventCount, 1);
    assert.equal(projection.coverageStatus, "unpriced");
    assert.deepEqual(projection.coverageCounts, {
      fullyPriced: 0,
      partiallyPriced: 0,
      unpriced: 1,
    });
    assert.equal(projection.rows[0].projection, null);
    assert.deepEqual(projection.rows[0].reasonCodes, ["pricing_inputs_unavailable"]);
    assert.equal(
      projection.warnings.coverage.some((warning) => warning.code === "pricing_inputs_unavailable"),
      true,
    );
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty Claude pricing projection is unavailable rather than fully priced zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-ledger-empty-pricing-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  try {
    const projection = ledger.readPricingProjection();
    assert.equal(projection.eventCount, 0);
    assert.equal(projection.totalUsd, "0");
    assert.equal(projection.coverageStatus, "unpriced");
    assert.deepEqual(projection.coverageCounts, {
      fullyPriced: 0,
      partiallyPriced: 0,
      unpriced: 0,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("combined output projection is an explicit view rule, not a fabricated reasoning split", () => {
  assert.deepEqual(projectProviderOutput({
    provider: "anthropic_claude_code",
    outputKind: "provider_reported_combined",
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: 47,
  }), {
    outputTextTokens: 47,
    outputReasoningTokens: 0,
    outputCombinedTokens: 47,
    outputKind: "provider_reported_combined",
  });
  assert.throws(() => projectProviderOutput({
    provider: "anthropic_claude_code",
    outputKind: "provider_reported_combined",
    outputTextTokens: 47,
    outputReasoningTokens: 0,
    outputCombinedTokens: 47,
  }), (error) => error.code === "claude_desktop_ledger_output_kind");
});

test("incremental provider candidates bind source generation into immutable identity", () => {
  const candidate = {
    provider: "anthropic_claude_code",
    occurrenceMaterial: "a".repeat(64),
    eventTime: "2026-07-24T12:10:00.000Z",
    modelDeclaration: {
      modelId: "claude-opus-4-8",
      modelRecognition: "recognized",
      modelFingerprint: null,
    },
    billingSurface: "claude_subscription",
    outputKind: "provider_reported_combined",
    components: {
      inputUncachedTokens: 11,
      inputCacheReadTokens: 17,
      inputCacheWriteTokens: 13,
      inputCacheWrite5mTokens: 13,
      inputCacheWrite1hTokens: 0,
      outputCombinedTokens: 3,
    },
    totalInputContextTokens: 41,
    candidateVersion: "fixture-v1",
  };
  const first = createClaudeDesktopLedgerCandidate({
    candidate, sourceKey: "b".repeat(64), sourceGeneration: 1,
  });
  const rebuilt = createClaudeDesktopLedgerCandidate({
    candidate, sourceKey: "b".repeat(64), sourceGeneration: 2,
  });
  assert.equal(first.sourceGeneration, 1);
  assert.equal(rebuilt.sourceGeneration, 2);
  assert.notEqual(first.candidateKey, rebuilt.candidateKey);
});

test("usage merge and transcript cursor checkpoint commit atomically across restart", async () => {
  const { keys } = await json("ledger-lifecycle-v1.json");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-checkpoint-"));
  const path = join(root, "ledger.sqlite");
  const planSha256 = "c".repeat(64);
  const firstCursor = {
    schemaVersion: "claude-transcript-export-cursor-v0.2",
    sourceKey: keys.claudeSource,
    nextByte: 100,
    nextLineOrdinal: 3,
    nextCostOrdinal: 0,
  };
  let ledger = openClaudeDesktopLedgerPrototype(path);
  try {
    ledger.mergeUsageCandidates([claudeCandidate(keys)], {
      acceptedAtMs: 1784894400000,
      checkpoint: {
        provider: "anthropic_claude_code",
        planSha256,
        sourceKey: keys.claudeSource,
        cursor: firstCursor,
        complete: false,
      },
    });
  } finally {
    ledger.close();
  }

  ledger = openClaudeDesktopLedgerPrototype(path);
  try {
    assert.deepEqual(ledger.readIngestCheckpoint(
      "anthropic_claude_code", planSha256, keys.claudeSource,
    ), { cursor: firstCursor, complete: false });
    assert.throws(() => ledger.mergeUsageCandidates([claudeCandidate(keys, { final: true })], {
      acceptedAtMs: 1784894460000,
      checkpoint: {
        provider: "anthropic_claude_code",
        planSha256,
        sourceKey: keys.claudeSource,
        cursor: { ...firstCursor, nextByte: 99 },
        complete: false,
      },
    }), (error) => error.code === "claude_desktop_ledger_checkpoint_regression");
    assert.equal(ledger.providerSnapshot("anthropic_claude_code").candidateCount, 1);
    assert.deepEqual(ledger.readIngestCheckpoint(
      "anthropic_claude_code", planSha256, keys.claudeSource,
    ), { cursor: firstCursor, complete: false });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 0 benchmark measures only Desktop-selected parents and children", async () => {
  const value = await materializeBenchmarkCorpus();
  try {
    const result = await benchmarkClaudeDesktopPhase0({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      quotaHistoryPath: value.quota,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
      temporaryRoot: value.root,
      simulateRestartAfterCandidates: 1,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.inventory.selectedParents, 1);
    assert.equal(result.inventory.selectedChildren, 1);
    assert.equal(result.canonicalization.sourceFiles, 2);
    assert.equal(result.canonicalization.selectedLogicalMessages, 2);
    assert.equal(result.scan.candidateCount, 2);
    assert.equal(result.scan.restartCount, 1);
    assert.equal(result.quota.observations, 9);
    assert.equal(result.merge.inserted, 2);
    assert.equal(result.quotaMerge.inserted, 8);
    assert.equal(result.unchangedRefresh.insertedUsageCandidates, 0);
    assert.equal(result.unchangedRefresh.insertedQuotaRevisions, 0);
    assert.ok(result.databaseBytes > 0);
    assert.ok(result.checkpointBytes > 0);
    assert.ok(result.peakRssBytes > 0);
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("incremental benchmark covers fresh inventory and quota on a zero-read unchanged refresh", async () => {
  const value = await materializeBenchmarkCorpus();
  try {
    const result = await benchmarkClaudeDesktopIncremental({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      quotaHistoryPath: value.quota,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
      temporaryRoot: value.root,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.initial.canonical.sourceCount, 2);
    assert.equal(result.initial.canonical.candidateCount, 2);
    assert.equal(result.initial.merge.inserted, 2);
    assert.equal(result.unchanged.canonical.unchangedSources, 2);
    assert.equal(result.unchanged.canonical.parsedBytes, 0);
    assert.equal(result.unchanged.canonical.parsedLines, 0);
    assert.equal(result.unchanged.canonical.candidateCount, 0);
    assert.equal(result.unchanged.merge.inserted, 0);
    assert.equal(result.unchanged.quotaMerge.inserted, 0);
    assert.equal(result.ledgerSnapshot.winnerCount, 2);
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("incremental refresh defaults to a bounded pricing summary without a cache file", async () => {
  const value = await materializeBenchmarkCorpus();
  const pricingCachePath = join(value.root, "default-pricing-cache.sqlite");
  try {
    const result = await runClaudeDesktopIncrementalRefresh({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      quotaHistoryPath: value.quota,
      canonicalPath: join(value.root, "default-refresh-canonical.sqlite"),
      ledgerPath: join(value.root, "default-refresh-ledger.sqlite"),
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.pricingProjection, null);
    assert.equal(result.pricingSummary.eventCount, 2);
    assert.equal(result.pricingSummary.coverageStatus, "unpriced");
    assert.equal(Object.hasOwn(result.pricingSummary, "rows"), false);
    assert.equal(result.pricingCachePublication, null);
    await assert.rejects(stat(pricingCachePath), /ENOENT/u);
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("usage-only incremental refresh does not require or parse a quota source", async () => {
  const value = await materializeBenchmarkCorpus();
  try {
    const result = await runClaudeDesktopIncrementalRefresh({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      canonicalPath: join(value.root, "usage-only-canonical.sqlite"),
      ledgerPath: join(value.root, "usage-only-ledger.sqlite"),
      includeQuota: false,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.canonical.candidateCount, 2);
    assert.equal(result.quotaParseMs, 0);
    assert.equal(result.quotaMerge, null);
    assert.equal(result.ledgerSnapshot.quotaRevisionCount, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("downstream shadow failure leaves canonical groups replayable", async () => {
  const value = await materializeBenchmarkCorpus();
  const configuration = {
    metadataDirectory: value.metadataDirectory,
    projectsDirectory: value.projectsDirectory,
    cleanupMarkerPath: value.marker,
    canonicalPath: join(value.root, "replay-canonical.sqlite"),
    ledgerPath: join(value.root, "replay-ledger.sqlite"),
    includeQuota: false,
    startAt: START_AT,
    endAt: END_AT,
    secret: SECRET,
  };
  try {
    await assert.rejects(
      runClaudeDesktopIncrementalRefresh({
        ...configuration,
        shadowSink: async () => { throw new Error("private shadow failure"); },
      }),
      /private shadow failure/u,
    );
    const replay = await runClaudeDesktopIncrementalRefresh({
      ...configuration,
      shadowSink: async () => ({ status: "enabled" }),
    });
    assert.equal(replay.canonical.dirtyGroupCount, 2);
    assert.equal(replay.canonical.candidateCount, 2);
    assert.equal(replay.merge.inserted, 0);
    assert.equal(replay.projection.generation, 2);
    assert.deepEqual(replay.canonicalSnapshot, {
      sources: 2,
      groups: 2,
      tools: 0,
      dirtyGroups: 0,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("production-shaped refresh records source disappearance without deleting winners", async () => {
  const value = await materializeBenchmarkCorpus();
  const configuration = {
    metadataDirectory: value.metadataDirectory,
    projectsDirectory: value.projectsDirectory,
    cleanupMarkerPath: value.marker,
    canonicalPath: join(value.root, "missing-canonical.sqlite"),
    ledgerPath: join(value.root, "missing-ledger.sqlite"),
    includeQuota: false,
    startAt: START_AT,
    endAt: END_AT,
    secret: SECRET,
  };
  try {
    const first = await runClaudeDesktopIncrementalRefresh(configuration);
    assert.equal(first.ledgerSnapshot.winnerCount, 2);
    assert.equal(first.sourceLifecycle.observed, 2);
    assert.equal(first.ledgerSnapshot.openCoverageGapCount, 0);

    await rm(join(
      value.projectsDirectory,
      "project",
      "11111111-1111-4111-8111-111111111111",
      "subagents",
      "agent-a.jsonl",
    ));
    const missing = await runClaudeDesktopIncrementalRefresh(configuration);
    assert.equal(missing.canonical.missingSources, 1);
    assert.equal(missing.sourceLifecycle.missing, 1);
    assert.equal(missing.ledgerSnapshot.winnerCount, 2);
    assert.equal(missing.ledgerSnapshot.openCoverageGapCount, 1);

    const repeated = await runClaudeDesktopIncrementalRefresh(configuration);
    assert.equal(repeated.ledgerSnapshot.openCoverageGapCount, 1);
    assert.equal(repeated.ledgerSnapshot.coverageGapCount, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an already-aborted incremental refresh creates no canonical or ledger state", async () => {
  const value = await materializeBenchmarkCorpus();
  const canonicalPath = join(value.root, "aborted-canonical.sqlite");
  const ledgerPath = join(value.root, "aborted-ledger.sqlite");
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runClaudeDesktopIncrementalRefresh({
        metadataDirectory: value.metadataDirectory,
        projectsDirectory: value.projectsDirectory,
        cleanupMarkerPath: value.marker,
        canonicalPath,
        ledgerPath,
        includeQuota: false,
        startAt: START_AT,
        endAt: END_AT,
        secret: SECRET,
        signal: controller.signal,
      }),
      (error) => error?.name === "AbortError",
    );
    await assert.rejects(stat(canonicalPath), /ENOENT/u);
    await assert.rejects(stat(ledgerPath), /ENOENT/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("incremental refresh exposes row-rich pricing only with explicit debug opt-in", async () => {
  const value = await materializeBenchmarkCorpus();
  try {
    const result = await runClaudeDesktopIncrementalRefresh({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      quotaHistoryPath: value.quota,
      canonicalPath: join(value.root, "refresh-canonical.sqlite"),
      ledgerPath: join(value.root, "refresh-ledger.sqlite"),
      includeDebugPricingRows: true,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.pricingProjection.provider, "anthropic_claude_code");
    assert.equal(result.pricingProjection.eventCount, 2);
    assert.equal(result.pricingProjection.coverageStatus, "unpriced");
    assert.equal(result.pricingProjection.coverageCounts.unpriced, 2);
    assert.equal(result.pricingProjection.rows.every((row) => row.projection !== null), true);
    assert.equal(result.pricingProjection.rows.every((row) => row.reasonCodes.includes("unknown_model")), true);
    assert.equal(result.pricingSummary.eventCount, 2);
    assert.equal(Object.hasOwn(result.pricingSummary, "rows"), false);
    assert.equal(result.pricingCachePublication, null);
    await assert.rejects(stat(join(value.root, "claude-pricing-cache.sqlite")), /ENOENT/u);
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("incremental refresh rejects oversized debug pricing before creating its cache", async () => {
  const value = await materializeBenchmarkCorpus();
  const ledgerPath = join(value.root, "oversized-debug-ledger.sqlite");
  const pricingCachePath = join(value.root, "oversized-debug-pricing.sqlite");
  const ledger = openClaudeDesktopLedgerPrototype(ledgerPath);
  try {
    const candidates = Array.from({ length: CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT + 1 }, (_, index) => (
      richClaudeCandidate({
        logical: index.toString(16).padStart(64, "0"),
        claudeSource: "c".repeat(64),
      })
    ));
    assert.equal(ledger.mergeUsageCandidates(candidates).inserted, candidates.length);
  } finally {
    ledger.close();
  }
  try {
    await assert.rejects(
      runClaudeDesktopIncrementalRefresh({
        metadataDirectory: value.metadataDirectory,
        projectsDirectory: value.projectsDirectory,
        cleanupMarkerPath: value.marker,
        quotaHistoryPath: value.quota,
        canonicalPath: join(value.root, "oversized-debug-canonical.sqlite"),
        ledgerPath,
        pricingCachePath,
        includeDebugPricingRows: true,
        startAt: START_AT,
        endAt: END_AT,
        secret: SECRET,
      }),
      (error) => error.code === "claude_desktop_incremental_refresh_debug_pricing_row_limit"
        && error.winnerCount === CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT + 3
        && error.maximumWinnerCount === CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT,
    );
    await assert.rejects(stat(pricingCachePath), /ENOENT/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("incremental refresh opts into the bounded Claude pricing cache explicitly", async () => {
  const value = await materializeBenchmarkCorpus();
  const configuration = {
    metadataDirectory: value.metadataDirectory,
    projectsDirectory: value.projectsDirectory,
    cleanupMarkerPath: value.marker,
    quotaHistoryPath: value.quota,
    canonicalPath: join(value.root, "cache-refresh-canonical.sqlite"),
    ledgerPath: join(value.root, "cache-refresh-ledger.sqlite"),
    pricingCachePath: join(value.root, "cache-refresh-pricing.sqlite"),
    startAt: START_AT,
    endAt: END_AT,
    secret: SECRET,
  };
  try {
    const first = await runClaudeDesktopIncrementalRefresh(configuration);
    assert.equal(first.status, "completed");
    assert.equal(first.pricingProjection, null);
    assert.equal(first.pricingSummary.eventCount, 2);
    assert.equal(first.pricingCachePublication.status, "published");
    assert.equal(first.pricingCachePublication.invalidated, false);

    const replay = await runClaudeDesktopIncrementalRefresh(configuration);
    assert.equal(replay.pricingProjection, null);
    assert.equal(replay.pricingSummary.payloadSha256, first.pricingSummary.payloadSha256);
    assert.equal(replay.pricingCachePublication.status, "reused");
    assert.equal(replay.pricingCachePublication.publicationGeneration, 1);
    assert.equal(readClaudeDesktopPricingCache(configuration.pricingCachePath).status, "available");
    assert.equal(JSON.stringify(replay).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("isolated incremental workers release first-import memory before unchanged refresh", async () => {
  const value = await materializeBenchmarkCorpus();
  try {
    const result = await benchmarkClaudeDesktopIncrementalIsolated({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      quotaHistoryPath: value.quota,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
      temporaryRoot: value.root,
    });
    assert.equal(result.initial.canonical.candidateCount, 2);
    assert.equal(result.unchanged.canonical.parsedBytes, 0);
    assert.equal(result.unchanged.canonical.candidateCount, 0);
    assert.equal(result.unchanged.ledgerSnapshot.winnerCount, 2);
    assert.ok(result.unchangedPeakRssBytes > 0);
    assert.equal(JSON.stringify(result).includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
