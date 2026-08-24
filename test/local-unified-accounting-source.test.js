import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
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
  beginUnifiedIndexGeneration,
  createUnifiedIndexWriter,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
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
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    discoveredSourceCount: empty ? 0 : 1,
    discoveredSourceBytes: empty ? 0 : 4096,
  });
  const sourceLocal = Buffer.alloc(32, 4);
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    generationId: generation.generationId,
    parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
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
    const writeUsage = (eventKeyByte, inputTokens, sourceOffset) => writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, eventKeyByte),
      observedAtMs: OBSERVED_MS,
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset,
      sourceOrdinal: 0,
      tierObservedAtMs: OBSERVED_MS - 1_000,
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
    writeUsage(2, 20, 2);
    writeUsage(1, 10, 1);
    // Quota-only token records exist in the current schema. They must not
    // become zero-token accounting usage callbacks.
    writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, 3),
      observedAtMs: OBSERVED_MS + 1_000,
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset: 3,
      sourceOrdinal: 0,
      tierObservedAtMs: OBSERVED_MS - 1_000,
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
    writer.writeQuotaOccurrence({
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset: 3,
      sourceOrdinal: 0,
      surfaceId,
      canonicalObservationId: quotaObservationId,
      observedAtMs: OBSERVED_MS + 1_000,
      provider: "openai_codex",
      planType: null,
      limitId: "codex",
      slot: "primary",
      slotOrder: 0,
      usedPercent: 12.5,
      resetsAtMs: RESET_MS,
      durationMins: 10_080,
      admission: "admitted",
    });
    writer.writeSourceCursor({
      sourceLocal,
      sourceOrdinal: 0,
      sessionLocal: Buffer.alloc(32, 7),
      scannedBytes: 4096,
      sizeBytes: 4096,
      mtimeMs: OBSERVED_MS,
      snapshotsPersisted: true,
      turnContextSeen: true,
      carryModel: "gpt-5.6-sol",
      carryEffort: "high",
      carryTierRaw: "priority",
      carryTierObservedAtMs: OBSERVED_MS - 1_000,
      carryTotals: null,
    });
    writer.writeGenerationSource({
      generationId: generation.generationId,
      sourceLocal,
      sourceOrdinal: 0,
      sessionLocal: Buffer.alloc(32, 7),
      surfaceId,
      status: "complete",
      discoveredSizeBytes: 4096,
      scannedBytes: 4096,
      mtimeMs: OBSERVED_MS,
      diagnosticsComplete: true,
    });
    writer.writeSourceDiagnostics(sourceLocal, {}, {
      generationId: generation.generationId,
    });
  }
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", status);
  writer.finalizeGeneration({
    status,
    blockReason: status === "complete" ? null : "unified_index_incomplete",
    discoveredSourceCount: empty ? 0 : 1,
    discoveredSourceBytes: empty ? 0 : 4096,
    indexedSourceCount: empty ? 0 : 1,
    indexedSourceBytes: empty ? 0 : 4096,
    discoveryComplete: status === "complete",
    diagnosticsComplete: status === "complete",
  });
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
    assert.equal(result.schemaVersion, "local-unified-index-v2");
    assert.equal(result.parserVersion, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
    assert.equal(result.contractVersion, "usage-event-v0.2");
    assert.deepEqual(result.compatibility.contractVersions, ["usage-event-v0.2"]);
    assert.equal(result.coverage.status, "complete");
    assert.equal(result.coverage.indexStatus, "complete");
    assert.equal(result.coverage.blockReason, null);
    assert.equal(result.coverage.usageProvenanceAttested, true);
    assert.equal(result.coverage.sourceOrderAttested, true);
    assert.equal(result.coverage.quotaProvenanceAttested, true);
    assert.equal(result.coverage.toolProvenanceAttested, true);
    assert.equal(result.coverage.toolFactsComplete, true);
    assert.equal(result.coverage.toolFacts, 0);
    assert.match(
      result.coverage.toolFactFingerprint,
      /^tool-facts-v1-[a-f0-9]{64}$/u,
    );
    assert.deepEqual(result.capabilities, {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: true,
      sourceOffsetProvenance: true,
      sourceScopedQuotaOccurrences: true,
      durableDiagnostics: true,
      crashSafeGenerationPublication: true,
    });
    assert.equal(result.diagnosticsAvailable, true);
    assert.deepEqual(usage.map((row) => row.components.input_uncached_tokens), [10, 20]);
    assert.deepEqual(usage.map((row) => row.sequence), [0, 1]);
    assert.equal(Object.hasOwn(usage[0], "totalInputContextTokens"), false);
    assert.equal(usage[0].model, "gpt-5.6-sol");
    assert.deepEqual(usage[0].tierSemantics, {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "unknown",
      tierSource: "rollout_thread_settings",
      tierObservedAt: "2026-08-01T11:59:59.000Z",
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
    assert.equal(quota[0].surfaceClassification.surface, "cli_exec");
    assert.equal(quota[0].sourceRecordOrdinal, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context behavior is explicit and expected generations are bound", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const native = await scan(indexFile, { contextBehavior: "source_native" });
    assert.equal(Object.hasOwn(native.usage[0], "totalInputContextTokens"), false);
    const legacy = await scan(indexFile, { contextBehavior: "legacy_zero" });
    assert.equal(legacy.usage[0].totalInputContextTokens, 0);
    assert.equal(native.result.coverage.generationId > 0, true);
    assert.equal(
      native.result.coverage.generationFingerprint.startsWith("generation-v2-"),
      true,
    );
    const bound = await scan(indexFile, {
      expectedGeneration: {
        id: native.result.coverage.generationId,
        fingerprint: native.result.coverage.generationFingerprint,
      },
    });
    assert.equal(bound.result.coverage.generationId, native.result.coverage.generationId);
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile,
        expectedGeneration: native.result.coverage.generationId + 1,
      })({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_generation_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation fingerprints are canonical and metadata overrides must agree", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const baseline = await scan(indexFile);
    const canonical = baseline.result.coverage.generationFingerprint;
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run("current_generation_fingerprint", canonical);
    database.close();
    const accepted = await scan(indexFile);
    assert.equal(accepted.result.coverage.generationFingerprint, canonical);

    const wrong = `generation-v2-${"0".repeat(64)}`;
    const tampered = openLocalUnifiedIndex(indexFile);
    tampered.prepare(`
      UPDATE meta SET value = ? WHERE key = 'current_generation_fingerprint'
    `).run(wrong);
    tampered.close();
    await assert.rejects(
      scan(indexFile),
      (error) => error.code === "local_unified_index_generation_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy nullable provenance is partial even when generation status is complete", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(
      "UPDATE usage_event SET source_offset = NULL WHERE source_offset = 1",
    ).run();
    database.close();
    const result = await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.coverage.blockReason, "legacy_nullable_rows");
    assert.equal(result.capabilities.sourceOffsetProvenance, false);
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile,
        requireComplete: true,
      })({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
    );
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
      `UPDATE index_generation
       SET usage_events = usage_events + 1
       WHERE id = (SELECT value FROM meta WHERE key = 'current_generation_id')`,
    ).run();
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile: stale.indexFile,
        requireComplete: true,
        verifyPublishedGeneration: true,
      })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
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
    const parserVersionId = database.prepare(
      `SELECT id FROM parser_version
       WHERE parser_version = 'unified-rollout-typed-v2'`,
    ).get().id;
    database.prepare(
      `UPDATE usage_event SET parser_version_id = ?
       WHERE rowid = (SELECT MIN(rowid) FROM usage_event)`,
    ).run(parserVersionId);
    database.close();
    const result = await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(result.parserVersion, null);
    assert.equal(result.compatibility.status, "mixed_parser_versions");
    assert.deepEqual(result.compatibility.parserVersions, [
      LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      "unified-rollout-typed-v2",
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

    for (const abortError of [
      Object.assign(new Error("PRIVATE_ABORT_CANARY"), { name: "AbortError" }),
      Object.assign(new Error("PRIVATE_ABORT_CODE_CANARY"), { code: "ABORT_ERR" }),
    ]) {
      await assert.rejects(
        createLocalUnifiedAccountingSource({ indexFile })({
          startAt: START_AT,
          endAt: END_AT,
          onUsage: () => {
            throw abortError;
          },
        }),
        (error) => error.name === "AbortError"
          && error.code === "local_unified_index_read_aborted"
          && !error.message.includes("PRIVATE_ABORT"),
      );
    }

    const resourceError = Object.assign(
      new Error("PRIVATE_RESOURCE_CANARY"),
      { code: "accounting_scan_rss_limit_exceeded" },
    );
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: () => {
          throw resourceError;
        },
      }),
      (error) => error.code === "accounting_scan_rss_limit_exceeded"
        && !error.message.includes("PRIVATE_RESOURCE_CANARY"),
    );

    for (const code of [
      "accounting_refresh_aborted",
      "accounting_transition_rss_measurement_invalid",
      "accounting_archive_rss_measurement_invalid",
    ]) {
      await assert.rejects(
        createLocalUnifiedAccountingSource({ indexFile })({
          startAt: START_AT,
          endAt: END_AT,
          onUsage: () => {
            throw Object.assign(new Error("PRIVATE_FIXED_CODE_CANARY"), {
              code,
            });
          },
        }),
        (error) => error.code === code
          && !error.message.includes("PRIVATE_FIXED_CODE_CANARY"),
      );
    }

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
    database.prepare("UPDATE model SET model_id = ?").run("invalid model");
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
    database.prepare("UPDATE quota_occurrence SET resets_at_ms = NULL").run();
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
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("UPDATE usage_event SET source_local = NULL").run();
    database.close();
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

test("full integrity rejects duplicate source ordinals and orphan quota observations", async () => {
  const duplicate = await createIndex();
  try {
    const database = openLocalUnifiedIndex(duplicate.indexFile);
    const generationId = Number(database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get().value);
    const surfaceId = database.prepare(
      "SELECT surface_id FROM generation_source LIMIT 1",
    ).get().surface_id;
    database.prepare(`
      INSERT INTO generation_source(
        generation_id, source_local, source_ordinal, session_local, surface_id,
        status, discovered_size_bytes, scanned_bytes, mtime_ms,
        diagnostics_complete
      ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, 1)
    `).run(
      generationId,
      Buffer.alloc(32, 8),
      0,
      Buffer.alloc(32, 9),
      surfaceId,
      4096,
      4096,
      OBSERVED_MS,
    );
    database.prepare(`
      UPDATE index_generation
      SET indexed_source_count = 2, indexed_source_bytes = 8192
      WHERE id = ?
    `).run(generationId);
    database.close();

    const result = await scan(duplicate.indexFile, {
      verifyPublishedGeneration: true,
    });
    assert.equal(result.result.coverage.generationProof, false);
    assert.equal(result.result.coverage.provenanceComplete, false);
    assert.equal(result.result.capabilities.deterministicCanonicalOrder, false);
  } finally {
    await rm(duplicate.root, { recursive: true, force: true });
  }

  const orphan = await createIndex();
  try {
    const database = openLocalUnifiedIndex(orphan.indexFile);
    const generationId = Number(database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get().value);
    database.prepare("DELETE FROM quota_occurrence").run();
    database.prepare(`
      UPDATE index_generation SET quota_occurrences = 0 WHERE id = ?
    `).run(generationId);
    database.close();

    const result = await scan(orphan.indexFile, {
      verifyPublishedGeneration: true,
    });
    assert.equal(result.result.coverage.generationProof, false);
    assert.equal(result.result.coverage.quotaOccurrencesComplete, false);
    assert.equal(result.result.capabilities.sourceScopedQuotaOccurrences, false);
  } finally {
    await rm(orphan.root, { recursive: true, force: true });
  }
});

test("empty and source-partial indexes remain honest readable characterizations", async () => {
  for (const fixture of [
    { status: "complete", empty: true, expectedReason: null },
    { status: "partial", empty: false, expectedReason: "unified_index_incomplete" },
  ]) {
    const { root, indexFile } = await createIndex(fixture);
    try {
      const { result, usage } = await scan(indexFile);
      assert.equal(
        result.coverage.status,
        fixture.status === "complete" ? "complete" : "partial",
      );
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

test("published path identity is revalidated after callbacks", async () => {
  const original = await createIndex();
  const replacement = await createIndex();
  try {
    let swapped = false;
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: original.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: async () => {
          if (swapped) return;
          swapped = true;
          await rename(original.indexFile, `${original.indexFile}.old`);
          await rename(replacement.indexFile, original.indexFile);
        },
      }),
      (error) => error.code === "local_unified_index_file_changed",
    );
    assert.equal(swapped, true);
  } finally {
    await rm(original.root, { recursive: true, force: true });
    await rm(replacement.root, { recursive: true, force: true });
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
