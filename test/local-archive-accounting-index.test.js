import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES,
  ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES,
  ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES,
  ARCHIVE_INDEX_MAX_ROLLOUT_FILES,
  ARCHIVE_INDEX_PASS_TIMEOUT_MS,
  ARCHIVE_INDEX_STORAGE_RESERVE_BYTES,
  inspectLocalArchiveAccountingIndex,
  readLocalArchiveAccountingPeriod,
  refreshLocalArchiveAccountingIndex,
} from "../src/local-archive-accounting-index.js";
import {
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY,
  buildReplaySafeAccountingPeriod,
} from "../src/replay-safe-accounting-cache.js";

const CHUNK_BYTES = 4 * 1024 * 1024;
const PRIVATE_CANARY = "PRIVATE_ARCHIVE_INDEX_CANARY";

async function fixture({
  includeSecondSource = false,
  model = "gpt-5.6-sol",
  secondModel = null,
  includeUsage = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-archive-index-"));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const writeRollout = async (path, sessionId, timestamp, rolloutModel = model) => {
    await writeFile(path, `${[
      JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: { id: sessionId },
      }),
      JSON.stringify({
        timestamp: `${timestamp.slice(0, -5)}.010Z`,
        type: "turn_context",
        payload: { model: rolloutModel },
      }),
      ...(includeUsage ? [JSON.stringify({
        timestamp: `${timestamp.slice(0, -5)}.020Z`,
        type: "event_msg",
        payload: {
          type: "token_count",
          model: rolloutModel,
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 100,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 100,
            },
          },
        },
      })] : []),
    ].join("\n")}\n`);
    await appendFile(path, `${JSON.stringify({
      timestamp,
      type: "synthetic_padding",
      payload: { padding: "x".repeat(1024) },
    })}\n`.repeat(8_000));
  };
  await writeRollout(
    join(sessions, "rollout-2026-07-24T12-00-00-archive.jsonl"),
    PRIVATE_CANARY,
    "2026-07-24T12:00:00.000Z",
  );
  if (includeSecondSource) {
    await writeRollout(
      join(sessions, "rollout-2026-07-24T12-02-00-second.jsonl"),
      "SECOND_ARCHIVE_SOURCE",
      "2026-07-24T12:02:00.000Z",
      secondModel ?? model,
    );
  }
  return { root, codexHome };
}

test("the resident archive projection reads its own ceiling, not the rebuild's", async () => {
  // This refresh runs INSIDE the menu-bar companion. Until 2026-08-20 it named
  // no ceiling and so inherited buildReplaySafeAccountingPeriod's default,
  // which was the rebuild's absolute target — a number sized for a short-lived
  // child that hands every page back on exit. Raising that constant to 6 GiB
  // for the child therefore loosened the resident process by the same 4 GiB,
  // against the whole point of moving the rebuild out of process (#38).
  const { archiveMaximumRssBytes, maximumRssBytes } =
    REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY;
  // Residency chosen to sit strictly BETWEEN the two policies: over the
  // archive ceiling, comfortably under the rebuild's. Under the old inherited
  // default this projection completed; under the archive policy it must not.
  const betweenPolicies = archiveMaximumRssBytes + 64 * 1024 * 1024;
  assert.ok(betweenPolicies > archiveMaximumRssBytes);
  assert.ok(betweenPolicies < maximumRssBytes);

  const { root, codexHome } = await fixture({ includeUsage: true });
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const observedOptions = [];
  try {
    const refreshed = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
      buildAccountingPeriod: (options) => {
        observedOptions.push(options);
        return buildReplaySafeAccountingPeriod({
          ...options,
          rss: () => betweenPolicies,
        });
      },
    });

    // The indexing pass itself is untouched — only the projection is refused,
    // and refused as a reported outcome rather than a failed refresh.
    assert.equal(refreshed.refreshStatus, "built");
    assert.equal(refreshed.projectionStatus, "unavailable");
    assert.equal(refreshed.projectionErrorCode, "archive_projection_unavailable");

    // And the call site still names no ceiling, which is what makes the
    // default the thing under test. If a future edit starts passing one, this
    // fails loudly rather than quietly moving the property somewhere else.
    assert.equal(observedOptions.length, 1);
    assert.equal(observedOptions[0].maximumRssBytes, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive read budgets remain strict for short non-aligned passes", async () => {
  const { root, codexHome } = await fixture({ includeSecondSource: true });
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const budgetBytes = 12 * 1024 * 1024;
  try {
    const result = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: budgetBytes,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
    });
    assert.equal(result.scanBytes > 0, true);
    assert.equal(result.scanBytes <= budgetBytes, true);
    assert.equal(result.status, "partial");
    assert.equal(result.projectionStatus, "available");
    const projection = await readLocalArchiveAccountingPeriod({ indexFile });
    assert.equal(projection.status, "available");
    assert.equal(projection.period.id, "history");
    assert.equal(projection.period.label, "Indexed history so far");
    assert.equal(projection.coverage.status, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive index applies the larger envelope through durable partial batches", async () => {
  assert.equal(ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES, 128 * 1024 * 1024);
  assert.equal(ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES, 1.5 * 1024 * 1024 * 1024);
  assert.equal(ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES, 500_000);
  assert.equal(ARCHIVE_INDEX_MAX_ROLLOUT_FILES, 125_000);
  assert.equal(ARCHIVE_INDEX_PASS_TIMEOUT_MS, 5 * 60_000);
  assert.equal(ARCHIVE_INDEX_STORAGE_RESERVE_BYTES, 128 * 1024 * 1024);

  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const initial = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
    });
    assert.equal(initial.status, "partial");
    assert.equal(initial.phase, "awaiting_resume");
    assert.equal(initial.readBudgetBytes, CHUNK_BYTES);
    assert.equal(initial.scanBytes, CHUNK_BYTES);
    const inspectedPartial = await inspectLocalArchiveAccountingIndex({
      indexFile,
    });
    assert.equal(inspectedPartial.status, "partial");
    assert.equal(inspectedPartial.phase, "idle");
    assert.equal(inspectedPartial.sourceCount, initial.sourceCount);
    assert.equal(inspectedPartial.indexedBytes, initial.indexedBytes);
    assert.equal(inspectedPartial.sourceBytes, initial.sourceBytes);

    const resumed = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
    });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.phase, "complete");
    assert.equal(resumed.readBudgetBytes, 16 * 1024 * 1024);
    assert.equal(resumed.indexedSourceCount, 1);
    assert.equal(resumed.pendingSourceCount, 0);
    assert.equal(resumed.indexedBytes, resumed.sourceBytes);

    let filesystemStatCalls = 0;
    const reused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
      filesystemStats: async () => {
        filesystemStatCalls += 1;
        return { bsize: 4096, bavail: 1 };
      },
    });
    assert.equal(reused.status, "complete");
    assert.equal(reused.refreshStatus, "reused");
    assert.equal(filesystemStatCalls, 0);

    const bytes = await readFile(indexFile);
    assert.equal(bytes.includes(Buffer.from(PRIVATE_CANARY)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive index preserves Spark as a separate unpriced allowance track", async () => {
  const { root, codexHome } = await fixture({
    model: "gpt-5.3-codex-spark",
    includeUsage: true,
  });
  const indexFile = join(root, "local-archive-accounting-index-spark.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-spark-secret");
  try {
    const refreshed = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      workerCount: 1,
    });
    assert.equal(refreshed.status, "complete");
    const projection = await readLocalArchiveAccountingPeriod({ indexFile });
    assert.equal(projection.status, "available");
    assert.equal(projection.period.events, 0);
    assert.equal(projection.period.apiPriceEquivalentUsd, 0);
    assert.equal(projection.period.spark.events, 1);
    assert.deepEqual(
      projection.period.spark.byModel.map((row) => row.model),
      ["gpt-5.3-codex-spark"],
    );
    assert.equal(projection.period.spark.apiPriceEquivalentUsd, 0);
    assert.deepEqual(projection.period.spark.pricingCoverage, {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Owner-reported defect: a Model usage table that showed one "Unrecognized
// model" row pooling Spark with genuinely unreviewed identifiers. These three
// states must be separately representable in the projection the dashboard
// reads, or the renderer has no honest way to draw them apart.
async function archiveModelUsage({ model, secondModel }) {
  const { root, codexHome } = await fixture({
    model,
    secondModel,
    includeSecondSource: true,
    includeUsage: true,
  });
  const indexFile = join(root, "local-archive-accounting-index-models.sqlite");
  try {
    const refreshed = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile: join(root, "local-archive-accounting-index-models-secret"),
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      workerCount: 1,
    });
    assert.equal(refreshed.status, "complete");
    const projection = await readLocalArchiveAccountingPeriod({ indexFile });
    assert.equal(projection.status, "available");
    return projection.period;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelUsageState(period) {
  return period.modelUsage.map((row) => ({
    model: row.model,
    events: row.events,
    pricingStatus: row.pricingStatus,
    allowanceTrack: row.allowanceTrack,
    apiPriceEquivalentApplicable: row.apiPriceEquivalentApplicable,
  }));
}

test("Codex auto-review is priced as a gpt-5.4 alias on the primary allowance", async () => {
  const period = await archiveModelUsage({
    model: "codex-auto-review",
    secondModel: "gpt-5.6-sol",
  });
  // Both events stay on the primary track: auto-review is billed from the
  // ordinary Codex allowance. It used to carry no price at all; by owner
  // direction it is now an alias of gpt-5.4 and is priced at those rates.
  // The alias is an assumption rather than a published mapping - OpenAI does
  // not disclose what the managed alias resolves to - so the reasoning and its
  // known limits live in OPENAI_ALIAS_ASSUMPTIONS beside the rates.
  assert.equal(period.events, 2);
  assert.equal(period.spark.events, 0);
  assert.deepEqual(modelUsageState(period).sort(
    (left, right) => left.model.localeCompare(right.model),
  ), [
    {
      model: "codex-auto-review",
      events: 1,
      pricingStatus: "priced",
      allowanceTrack: "primary",
      apiPriceEquivalentApplicable: true,
    },
    {
      model: "gpt-5.6-sol",
      events: 1,
      pricingStatus: "priced",
      allowanceTrack: "primary",
      apiPriceEquivalentApplicable: true,
    },
  ]);
  assert.equal(
    period.modelUsage.some((row) => row.model === "unknown"),
    false,
  );
});

test("Spark reaches the renderer as its own allowance with no API equivalent", async () => {
  const period = await archiveModelUsage({
    model: "gpt-5.3-codex-spark",
    secondModel: "gpt-5.6-sol",
  });
  // The period's own totals stay reconcilable with byModel, which covers only
  // the primary allowance; Spark is carried alongside on its own track.
  assert.equal(period.events, 1);
  assert.deepEqual(period.byModel.map((row) => row.model), ["gpt-5.6-sol"]);
  assert.equal(period.spark.events, 1);
  assert.deepEqual(modelUsageState(period).sort(
    (left, right) => left.model.localeCompare(right.model),
  ), [
    {
      model: "gpt-5.3-codex-spark",
      events: 1,
      pricingStatus: "known_unpriced",
      allowanceTrack: "spark",
      // A separate allowance is not substitutable for the primary pool, so
      // quoting an API-price equivalent for it would be meaningless.
      apiPriceEquivalentApplicable: false,
    },
    {
      model: "gpt-5.6-sol",
      events: 1,
      pricingStatus: "priced",
      allowanceTrack: "primary",
      apiPriceEquivalentApplicable: true,
    },
  ]);
});

test("a genuinely unreviewed model identifier is still withheld as unrecognized", async () => {
  const period = await archiveModelUsage({
    model: "gpt-9.9-never-reviewed",
    secondModel: "gpt-5.6-sol",
  });
  const unrecognized = period.modelUsage.find(
    (row) => row.pricingStatus === "unrecognized",
  );
  // The identifier itself is never echoed back; only the fact that one event
  // named something unreviewed.
  assert.equal(unrecognized.model, "unknown");
  assert.equal(unrecognized.events, 1);
  assert.equal(unrecognized.allowanceTrack, "primary");
  assert.equal(
    period.modelUsage.some((row) => row.model.includes("never-reviewed")),
    false,
  );
});

test("first-pass discovery caps persist a partial archive state", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const observedAt = "2026-07-25T12:00:00.000Z";
  try {
    await writeFile(
      join(codexHome, "sessions", "rollout-2026-07-24T12-01-00-second.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "SECOND" } })}\n`,
    );
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse(observedAt),
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 1,
      workerCount: 1,
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.phase, "awaiting_resume");
    assert.equal(paused.errorCode, "archive_rollout_files");
    assert.equal(paused.readBudgetBytes, ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES);
    assert.equal(paused.scanBytes, 0);
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.phase, "idle");
    assert.equal(coverage.errorCode, "archive_rollout_files");
    assert.equal(coverage.generatedAt, observedAt);
    assert.deepEqual(coverage.coveredAt, {
      startAt: observedAt,
      endAt: observedAt,
    });
    assert.equal(coverage.sourceCount, 0);
    assert.equal(coverage.indexedSourceCount, 0);
    assert.equal(coverage.pendingSourceCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted archive refresh persists a resumable partial marker", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      refreshLocalArchiveAccountingIndex({
        indexFile,
        secretFile,
        codexHome,
        signal: controller.signal,
        now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      }),
      (error) => error?.name === "AbortError",
    );
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.errorCode, "archive_interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive indexing pauses honestly before staging when local disk headroom is insufficient", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      filesystemStats: async () => ({ bsize: 4096, bavail: 1 }),
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.phase, "awaiting_resume");
    assert.equal(paused.errorCode, "archive_disk_space");
    assert.equal(paused.scanBytes, 0);
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.errorCode, "archive_disk_space");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive indexing distinguishes unavailable disk measurements from low disk space", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      filesystemStats: async () => {
        throw new Error("test filesystem measurement failure");
      },
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.errorCode, "archive_storage_unavailable");
    assert.equal(paused.scanBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
