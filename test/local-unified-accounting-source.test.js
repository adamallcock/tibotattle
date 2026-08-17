import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION,
  createLocalUnifiedAccountingSource,
} from "../src/local-unified-accounting-source.js";
import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";

const START_AT = "2026-08-01T00:00:00.000Z";
const END_AT = "2026-08-02T00:00:00.000Z";
const OBSERVED_MS = Date.parse("2026-08-01T12:00:00.000Z");
const RESET_MS = Date.parse("2026-08-08T00:00:00.000Z");

async function createIndex({ status = "complete", empty = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-accounting-source-"));
  const indexFile = join(root, "unified.sqlite");
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
  });
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", status);
  writer.writeMeta("generated_at", "2026-08-01T13:00:00.000Z");
  writer.writeMeta("source_count", empty ? 0 : 1);
  writer.writeMeta("source_bytes", empty ? 0 : 4096);
  if (!empty) {
    const accountScopeId = writer.internAccountScope({
      status: "unavailable",
      reason: "missing_account",
      planType: null,
      scopeLocal: null,
    });
    const modelId = writer.internModel("gpt-5.6-sol", "recognized");
    const tierId = writer.internTier({
      apiServiceTier: "unknown",
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      tierSource: "rollout_thread_settings",
      providerTierRaw: "priority",
    });
    const surfaceId = writer.internSurface({
      agentScope: "root",
      surface: "cli_exec",
      threadSource: "user",
      lineageDisposition: "standalone",
    });
    const quotaObservationId = writer.internQuota({
      observedAtMs: OBSERVED_MS + 1_000,
      limitId: "codex",
      slot: "primary",
      planType: null,
      usedPercent: 12.5,
      resetsAtMs: RESET_MS,
      durationMins: 10_080,
    });
    const writeUsage = (eventKeyByte, inputTokens) => writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, eventKeyByte),
      observedAtMs: OBSERVED_MS,
      sessionLocal: Buffer.alloc(32, 7),
      accountScopeId,
      modelId,
      tierId,
      surfaceId,
      quotaObservationId,
      reasoningEffort: 4,
      outcome: 5,
      tokensInUncached: inputTokens,
      tokensInCacheRead: 0,
      tokensInCacheWrite: 0,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: 2,
      tokensOutReasoning: 1,
      tokensOutCombined: null,
      totalInputContext: null,
      partial: false,
    });
    // Insert in reverse key order; the read contract must still be stable.
    writeUsage(2, 20);
    writeUsage(1, 10);
    // Quota-only token records exist in the current schema. They must not
    // become zero-token accounting usage callbacks.
    writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, 3),
      observedAtMs: OBSERVED_MS + 1_000,
      sessionLocal: Buffer.alloc(32, 7),
      accountScopeId,
      modelId,
      tierId,
      surfaceId,
      quotaObservationId,
      reasoningEffort: 4,
      outcome: 5,
      tokensInUncached: null,
      tokensInCacheRead: null,
      tokensInCacheWrite: null,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: null,
      tokensOutReasoning: null,
      tokensOutCombined: null,
      totalInputContext: null,
      partial: false,
    });
  }
  writer.writeMeta("usage_events", writer.usageRows);
  await writer.close({ fsyncPath: indexFile });
  return { root, indexFile };
}

async function scan(indexFile, options = {}) {
  const usage = [];
  const quota = [];
  const source = createLocalUnifiedAccountingSource({ indexFile, ...options });
  const result = await source({
    startAt: START_AT,
    endAt: END_AT,
    onUsage: async (row) => {
      await Promise.resolve();
      usage.push(row);
    },
    onRateLimitSnapshot: async (row) => {
      await Promise.resolve();
      quota.push(row);
    },
  });
  return { result, usage, quota };
}

test("the current unified index maps deterministically without mutating SQLite", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const before = await stat(indexFile);
    const { result, usage, quota } = await scan(indexFile);
    const after = await stat(indexFile);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(result.readerVersion, LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION);
    assert.equal(result.schemaVersion, "local-unified-index-v1");
    assert.equal(result.parserVersion, "unified-rollout-typed-v3");
    assert.equal(result.contractVersion, "usage-event-v0.2");
    assert.deepEqual(result.compatibility.contractVersions, ["usage-event-v0.2"]);
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.coverage.indexStatus, "complete");
    assert.equal(result.coverage.blockReason, "accounting_contract_incomplete");
    assert.deepEqual(result.capabilities, {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: false,
      sourceOffsetProvenance: false,
      sourceScopedQuotaOccurrences: false,
      durableDiagnostics: false,
      crashSafeGenerationPublication: false,
    });
    assert.equal(result.diagnosticsAvailable, false);
    assert.deepEqual(usage.map((row) => row.components.input_uncached_tokens), [10, 20]);
    assert.deepEqual(usage.map((row) => row.sequence), [0, 1]);
    assert.equal(Object.hasOwn(usage[0], "totalInputContextTokens"), false);
    assert.equal(usage[0].model, "gpt-5.6-sol");
    assert.deepEqual(usage[0].tierSemantics, {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "unknown",
      tierSource: "rollout_thread_settings",
      tierObservedAt: null,
    });
    assert.deepEqual(usage[0].surfaceClassification, {
      surface: "cli_exec",
      threadSource: "user",
      agentScope: "root",
      lineageDisposition: "standalone",
    });
    assert.equal(quota.length, 1);
    assert.equal(quota[0].sequence, 2);
    assert.deepEqual(quota[0].window, {
      provider: "openai_codex",
      planType: "unknown",
      limitId: "codex",
      slot: "primary",
      usedPercent: 12.5,
      windowDurationMins: 10_080,
      resetsAt: RESET_MS / 1_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict metadata validation rejects missing or stale required fields", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("DELETE FROM meta WHERE key = ?").run("contract_version");
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_meta_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const stale = await createIndex();
  try {
    const database = openLocalUnifiedIndex(stale.indexFile);
    database.prepare(
      "UPDATE meta SET value = ? WHERE key = ?",
    ).run("1", "usage_events");
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: stale.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_meta_invalid",
    );
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});

test("mixed parser rows are reported without pretending to have one parser", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(
      "INSERT INTO parser_version(parser_version, contract_version) VALUES (?, ?)",
    ).run("unified-rollout-typed-v2", "usage-event-v0.2");
    database.close();
    const result = await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(result.parserVersion, null);
    assert.equal(result.compatibility.status, "mixed_parser_versions");
    assert.deepEqual(result.compatibility.parserVersions, [
      "unified-rollout-typed-v2",
      "unified-rollout-typed-v3",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callback errors stay fixed and content-free, and sequence counts callbacks only", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const callbackError = Object.assign(
      new Error("PRIVATE_CALLBACK_CANARY"),
      { code: "accounting_private_callback" },
    );
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: () => {
          throw callbackError;
        },
      }),
      (error) => error.code === "local_unified_index_callback_failed"
        && !error.message.includes("PRIVATE_CALLBACK_CANARY"),
    );

    const quota = [];
    await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
      onRateLimitSnapshot: (row) => quota.push(row),
    });
    assert.equal(quota[0].sequence, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphaned dimensions and null quota percentages fail closed", async () => {
  const orphan = await createIndex();
  try {
    const database = openLocalUnifiedIndex(orphan.indexFile);
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("UPDATE usage_event SET model_id = 999").run();
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: orphan.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(orphan.root, { recursive: true, force: true });
  }

  const nullQuota = await createIndex();
  try {
    const database = openLocalUnifiedIndex(nullQuota.indexFile);
    database.prepare("UPDATE quota_observation SET used_percent = NULL").run();
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: nullQuota.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(nullQuota.root, { recursive: true, force: true });
  }
});

test("tampered short event keys fail the fixed row boundary", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(`
      UPDATE usage_event
      SET event_key = ?
      WHERE rowid = (SELECT MIN(rowid) FROM usage_event)
    `).run(Buffer.alloc(1, 9));
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete index status cannot overstate current accounting coverage", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const source = createLocalUnifiedAccountingSource({
      indexFile,
      requireComplete: true,
    });
    await assert.rejects(
      source({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty and source-partial indexes remain honest readable characterizations", async () => {
  for (const fixture of [
    { status: "complete", empty: true, expectedReason: "accounting_contract_incomplete" },
    { status: "partial", empty: false, expectedReason: "unified_index_incomplete" },
  ]) {
    const { root, indexFile } = await createIndex(fixture);
    try {
      const { result, usage } = await scan(indexFile);
      assert.equal(result.coverage.status, "partial");
      assert.equal(result.coverage.indexStatus, fixture.status);
      assert.equal(result.coverage.blockReason, fixture.expectedReason);
      if (fixture.empty) assert.deepEqual(usage, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing, insecure, and incompatible files fail with fixed errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-accounting-source-bad-"));
  try {
    const missing = createLocalUnifiedAccountingSource({
      indexFile: join(root, "missing.sqlite"),
    });
    await assert.rejects(
      missing({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_missing",
    );
    const incompatibleFile = join(root, "incompatible.sqlite");
    await writeFile(incompatibleFile, "PRIVATE_UNIFIED_SOURCE_CANARY", { mode: 0o600 });
    const incompatible = createLocalUnifiedAccountingSource({
      indexFile: incompatibleFile,
    });
    await assert.rejects(
      incompatible({ startAt: START_AT, endAt: END_AT }),
      (error) => (
        error.code === "local_unified_index_schema_invalid"
        || error.code === "local_unified_index_unavailable"
      ) && !error.message.includes("PRIVATE_UNIFIED_SOURCE_CANARY"),
    );
    await chmod(incompatibleFile, 0o644);
    await assert.rejects(
      incompatible({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_file_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requests and aborts fail before publishing partial callback output", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const source = createLocalUnifiedAccountingSource({ indexFile });
    await assert.rejects(
      source({ startAt: "2026-08-01T00:00:00Z", endAt: END_AT }),
      (error) => error.code === "local_unified_index_read_request_invalid",
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      source({
        startAt: START_AT,
        endAt: END_AT,
        signal: preAborted.signal,
      }),
      (error) => error.name === "AbortError"
        && error.code === "local_unified_index_read_aborted",
    );
    const midAbort = new AbortController();
    const seen = [];
    await assert.rejects(
      source({
        startAt: START_AT,
        endAt: END_AT,
        signal: midAbort.signal,
        onUsage: (row) => {
          seen.push(row);
          midAbort.abort();
        },
      }),
      (error) => error.name === "AbortError"
        && error.code === "local_unified_index_read_aborted",
    );
    assert.equal(seen.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed stored scalars fail content-free and the module has no raw-log boundary", async () => {
  const { root, indexFile } = await createIndex();
  const privateCanary = "/private/rollout/PRIVATE_UNIFIED_SOURCE_CANARY.jsonl";
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("UPDATE model SET model_id = ?").run(privateCanary);
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid"
        && !error.message.includes(privateCanary),
    );
    const source = await readFile(
      new URL("../src/local-unified-accounting-source.js", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "codex-log-scan",
      "discoverCodexRolloutInfos",
      "rollout-line-reader",
      "local-analysis-index",
    ]) assert.equal(source.includes(forbidden), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
