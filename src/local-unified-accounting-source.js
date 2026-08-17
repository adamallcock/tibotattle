import { lstat } from "node:fs/promises";

import { isValidQuotaWindowDuration } from "@app-usagemonitor/quota-analysis";

import {
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  openLocalUnifiedIndex,
} from "./local-unified-index.js";
import { validAbortSignal } from "./valid-abort-signal.js";

// Read-only characterization adapter from the current unified fact store to
// the callback contract consumed by replay-safe accounting. This module never
// discovers or opens rollout JSONL. It deliberately reports accounting
// coverage as partial until source ordering, source-scoped quota occurrences,
// durable diagnostics, and crash-safe generation publication are persisted.
export const LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION =
  "local-unified-accounting-source-v1";

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const QUOTA_SLOTS = new Set(["primary", "secondary"]);
const REQUIRED_META_KEYS = Object.freeze([
  "schema_version",
  "status",
  "generated_at",
  "source_count",
  "source_bytes",
  "usage_events",
  "contract_version",
]);
const ADAPTER_ABORT = Symbol("local-unified-accounting-source-abort");

function fixedError(code, name = "Error") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
      && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("local_unified_index_read_aborted", "AbortError");
  error[ADAPTER_ABORT] = true;
  throw error;
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function safeInteger(value, { nullable = false, nullValue = null } = {}) {
  if (value === null && nullable) return nullValue;
  if (value === undefined
      || (typeof value !== "number" && typeof value !== "bigint")) {
    throw fixedError("local_unified_index_row_invalid");
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return numeric;
}

function safeNonNegativeInteger(value, options = {}) {
  const numeric = safeInteger(value, {
    nullValue: 0,
    ...options,
  });
  if (numeric === null) return null;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return numeric;
}

function safeText(value, { nullable = false } = {}) {
  if (value === null && nullable) return "unknown";
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return value;
}

function readMeta(database) {
  const result = {};
  for (const row of database.prepare(
    "SELECT key, value FROM meta ORDER BY key",
  ).iterate()) {
    if (typeof row.key !== "string" || typeof row.value !== "string") {
      throw fixedError("local_unified_index_meta_invalid");
    }
    result[row.key] = row.value;
  }
  return result;
}

function requiredMetaText(meta, key) {
  if (!Object.hasOwn(meta, key)
      || typeof meta[key] !== "string"
      || meta[key].length < 1) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  return meta[key];
}

function metaCount(meta, key) {
  const value = requiredMetaText(meta, key);
  if (!/^\d+$/u.test(value)) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  return numeric;
}

function parserCompatibility(database, contractVersion) {
  const rows = database.prepare(`
    SELECT DISTINCT parser_version, contract_version
    FROM parser_version
    ORDER BY parser_version, contract_version
  `).all();
  if (rows.length === 0) {
    throw fixedError("local_unified_index_compatibility_invalid");
  }
  const parserVersions = [];
  const contractVersions = [];
  for (const row of rows) {
    const parserVersion = safeText(row.parser_version);
    const rowContractVersion = safeText(row.contract_version);
    if (rowContractVersion !== contractVersion) {
      throw fixedError("local_unified_index_compatibility_invalid");
    }
    parserVersions.push(parserVersion);
    contractVersions.push(rowContractVersion);
  }
  const uniqueParserVersions = [...new Set(parserVersions)];
  const uniqueContractVersions = [...new Set(contractVersions)];
  return {
    status: uniqueParserVersions.length === 1
      ? "compatible"
      : "mixed_parser_versions",
    parserVersions: uniqueParserVersions,
    contractVersions: uniqueContractVersions,
    contractVersion,
  };
}

function accountingCoverage(database, meta, requestedWindow) {
  for (const key of REQUIRED_META_KEYS) requiredMetaText(meta, key);
  const schemaVersion = requiredMetaText(meta, "schema_version");
  const indexStatus = requiredMetaText(meta, "status");
  if (schemaVersion !== LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
      || !new Set(["complete", "partial"]).has(indexStatus)) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  const generatedAtText = requiredMetaText(meta, "generated_at");
  const generatedAt = canonicalInstant(generatedAtText);
  if (generatedAt === null) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  const sourceCount = metaCount(meta, "source_count");
  const sourceBytes = metaCount(meta, "source_bytes");
  // Do not compare these totals to source_cursor here: rotated rollout files
  // can vanish while their durable facts and retained cursors remain, and the
  // current schema has no generation-scoped coverage record that distinguishes
  // that history from an in-progress discovery set.
  const declaredUsageEvents = metaCount(meta, "usage_events");
  const usageEvents = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM usage_event",
  ).get()?.count ?? 0);
  const quotaObservations = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM quota_observation",
  ).get()?.count ?? 0);
  if (![usageEvents, quotaObservations].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) || usageEvents !== declaredUsageEvents) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  return {
    // Even a source-complete current index is not yet accounting-complete: the
    // current schema cannot prove the contracts named in `capabilities`.
    status: indexStatus === "unavailable" ? "unavailable" : "partial",
    indexStatus,
    blockReason: indexStatus === "complete"
      ? "accounting_contract_incomplete"
      : "unified_index_incomplete",
    generatedAt,
    generationProof: false,
    requestedWindow,
    sourceCount,
    sourceBytes,
    usageEvents,
    quotaObservations,
  };
}

function validateUsageJoins(database, usageEvents) {
  const joinedEvents = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class s ON s.id = u.surface_id
    JOIN account_scope a ON a.id = u.account_scope_id
  `).get()?.count ?? 0);
  if (!Number.isSafeInteger(joinedEvents) || joinedEvents !== usageEvents) {
    throw fixedError("local_unified_index_row_invalid");
  }
}

function validateEventKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw fixedError("local_unified_index_row_invalid");
  }
}

function timestampForMs(value) {
  const observedAtMs = safeInteger(value);
  try {
    const timestamp = new Date(observedAtMs).toISOString();
    if (canonicalInstant(timestamp) === null) {
      throw fixedError("local_unified_index_row_invalid");
    }
    return { observedAtMs, timestamp };
  } catch (error) {
    if (error?.code === "local_unified_index_row_invalid") throw error;
    throw fixedError("local_unified_index_row_invalid");
  }
}

function usageComponents(row) {
  return {
    input_uncached_tokens: safeNonNegativeInteger(
      row.tokens_in_uncached,
      { nullable: true },
    ),
    input_cache_read_tokens: safeNonNegativeInteger(
      row.tokens_in_cache_read,
      { nullable: true },
    ),
    input_cache_write_tokens: safeNonNegativeInteger(
      row.tokens_in_cache_write,
      { nullable: true },
    ),
    output_text_tokens: safeNonNegativeInteger(
      row.tokens_out_text,
      { nullable: true },
    ),
    output_reasoning_tokens: safeNonNegativeInteger(
      row.tokens_out_reasoning,
      { nullable: true },
    ),
    output_combined_tokens: safeNonNegativeInteger(
      row.tokens_out_combined,
      { nullable: true },
    ),
  };
}

function hasUsage(components) {
  return Object.values(components).some((value) => value > 0);
}

async function invoke(callback, value) {
  if (callback === undefined) return;
  try {
    const result = callback(value);
    if (result && typeof result.then === "function") await result;
  } catch {
    throw fixedError("local_unified_index_callback_failed");
  }
}

function sameOpenedFile(before, after) {
  if (!ownerOnlyRegularFile(after)) return false;
  const canCompareIdentity = [before.dev, before.ino, after.dev, after.ino]
    .every((value) => value !== undefined && value !== null);
  return !canCompareIdentity
    || (before.dev === after.dev && before.ino === after.ino);
}

function validateRequest({
  startAt,
  endAt,
  signal,
  onUsage,
  onRateLimitSnapshot,
}) {
  const start = canonicalInstant(startAt);
  const end = canonicalInstant(endAt);
  if (start === null || end === null || Date.parse(start) > Date.parse(end)
      || !validAbortSignal(signal)
      || (onUsage !== undefined && typeof onUsage !== "function")
      || (onRateLimitSnapshot !== undefined
        && typeof onRateLimitSnapshot !== "function")) {
    throw fixedError("local_unified_index_read_request_invalid", "TypeError");
  }
  return { startAt: start, endAt: end };
}

/**
 * Return a scanner-shaped function over one already-published unified index.
 * The connection is always read-only and is closed after callbacks settle.
 */
export function createLocalUnifiedAccountingSource({
  indexFile,
  requireComplete = false,
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1
      || typeof requireComplete !== "boolean") {
    throw fixedError("local_unified_index_source_options_invalid", "TypeError");
  }
  return async function scanLocalUnifiedAccountingSource({
    startAt,
    endAt,
    signal = null,
    onUsage,
    onRateLimitSnapshot,
  } = {}) {
    const window = validateRequest({
      startAt,
      endAt,
      signal,
      onUsage,
      onRateLimitSnapshot,
    });
    throwIfAborted(signal);
    let metadata;
    try {
      metadata = await lstat(indexFile);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw fixedError("local_unified_index_missing");
      }
      throw fixedError("local_unified_index_unavailable");
    }
    if (!ownerOnlyRegularFile(metadata)) {
      throw fixedError("local_unified_index_file_invalid");
    }

    let database;
    let snapshotOpen = false;
    try {
      database = openLocalUnifiedIndex(indexFile, { readOnly: true });
      let reopenedMetadata;
      try {
        reopenedMetadata = await lstat(indexFile);
      } catch {
        throw fixedError("local_unified_index_file_changed");
      }
      if (!sameOpenedFile(metadata, reopenedMetadata)) {
        throw fixedError("local_unified_index_file_changed");
      }
      // Keep metadata, row counts and both callback streams on one SQLite
      // snapshot. Without this deferred transaction a foreground ingest could
      // publish additional facts between the validation and the callbacks.
      database.exec("BEGIN");
      snapshotOpen = true;
      const meta = readMeta(database);
      const coverage = accountingCoverage(database, meta, window);
      const contractVersion = requiredMetaText(meta, "contract_version");
      if (!SAFE_TOKEN.test(contractVersion)) {
        throw fixedError("local_unified_index_meta_invalid");
      }
      validateUsageJoins(database, coverage.usageEvents);
      if (requireComplete && coverage.status !== "complete") {
        throw fixedError("local_unified_index_accounting_coverage_incomplete");
      }
      const compatibility = parserCompatibility(database, contractVersion);
      const startMs = Date.parse(window.startAt);
      const endMs = Date.parse(window.endAt);
      let sequence = 0;
      const usageStatement = database.prepare(`
        SELECT u.event_key,
               u.observed_at_ms,
               u.total_input_context,
               u.tokens_in_uncached,
               u.tokens_in_cache_read,
               u.tokens_in_cache_write,
               u.tokens_out_text,
               u.tokens_out_reasoning,
               u.tokens_out_combined,
               m.model_id,
               t.billing_surface,
               t.codex_speed_mode,
               t.api_service_tier,
               t.tier_source,
               s.surface,
               s.thread_source,
               s.agent_scope,
               s.lineage_disposition
        FROM usage_event u
        JOIN model m ON m.id = u.model_id
        JOIN tier_semantics t ON t.id = u.tier_id
        JOIN surface_class s ON s.id = u.surface_id
        JOIN account_scope a ON a.id = u.account_scope_id
        WHERE u.observed_at_ms >= ? AND u.observed_at_ms <= ?
        ORDER BY u.observed_at_ms, u.event_key
      `);
      for (const row of usageStatement.iterate(startMs, endMs)) {
        throwIfAborted(signal);
        validateEventKey(row.event_key);
        const { observedAtMs, timestamp } = timestampForMs(row.observed_at_ms);
        const components = usageComponents(row);
        if (!hasUsage(components)) continue;
        const totalInputContextTokens = safeNonNegativeInteger(
          row.total_input_context,
          { nullable: true, nullValue: null },
        );
        const usage = {
          timestamp,
          timestampMs: observedAtMs,
          model: safeText(row.model_id),
          components,
          tierSemantics: {
            billingSurface: safeText(row.billing_surface),
            codexSpeedMode: safeText(row.codex_speed_mode),
            apiServiceTier: safeText(row.api_service_tier),
            tierSource: safeText(row.tier_source),
            tierObservedAt: null,
          },
          surfaceClassification: {
            surface: safeText(row.surface),
            threadSource: safeText(row.thread_source),
            agentScope: safeText(row.agent_scope),
            lineageDisposition: safeText(row.lineage_disposition),
          },
        };
        if (totalInputContextTokens !== null) {
          usage.totalInputContextTokens = totalInputContextTokens;
        }
        if (onUsage !== undefined) {
          usage.sequence = sequence++;
          await invoke(onUsage, usage);
        }
      }

      const quotaStatement = database.prepare(`
        SELECT id, observed_at_ms, limit_id, slot, plan_type, used_percent,
               resets_at_ms, duration_mins
        FROM quota_observation
        WHERE observed_at_ms >= ? AND observed_at_ms <= ?
        ORDER BY observed_at_ms, limit_id, slot, id
      `);
      for (const row of quotaStatement.iterate(startMs, endMs)) {
        throwIfAborted(signal);
        const { observedAtMs, timestamp } = timestampForMs(row.observed_at_ms);
        const durationMins = safeNonNegativeInteger(row.duration_mins);
        const resetsAtMs = safeNonNegativeInteger(row.resets_at_ms);
        if (row.used_percent === null
            || (typeof row.used_percent !== "number"
              && typeof row.used_percent !== "bigint")) {
          throw fixedError("local_unified_index_row_invalid");
        }
        const usedPercent = Number(row.used_percent);
        const slot = safeText(row.slot);
        if (!isValidQuotaWindowDuration(durationMins)
            || resetsAtMs <= 0
            || resetsAtMs % 1_000 !== 0
            || !Number.isFinite(usedPercent)
            || usedPercent < 0
            || usedPercent > 100
            || !QUOTA_SLOTS.has(slot)) {
          throw fixedError("local_unified_index_row_invalid");
        }
        const quota = {
          timestamp,
          timestampMs: observedAtMs,
          window: {
            provider: "openai_codex",
            planType: safeText(row.plan_type, { nullable: true }),
            limitId: safeText(row.limit_id),
            slot,
            usedPercent,
            windowDurationMins: durationMins,
            resetsAt: resetsAtMs / 1_000,
          },
        };
        if (onRateLimitSnapshot !== undefined) {
          quota.sequence = sequence++;
          await invoke(onRateLimitSnapshot, quota);
        }
      }
      throwIfAborted(signal);
      return {
        readerVersion: LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION,
        schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        parserVersion: compatibility.parserVersions.length === 1
          ? compatibility.parserVersions[0]
          : null,
        contractVersion,
        compatibility,
        coverage,
        capabilities: {
          readsRawSources: false,
          deterministicCanonicalOrder: true,
          sourceOrderingProvenance: false,
          sourceOffsetProvenance: false,
          sourceScopedQuotaOccurrences: false,
          durableDiagnostics: false,
          crashSafeGenerationPublication: false,
        },
        diagnosticCoverage: "unavailable",
        diagnosticsAvailable: false,
        diagnostics: {},
        toolCallsByClass: {},
        toolObservationsBySource: {},
        serverBillableUnits: {},
      };
    } catch (error) {
      if (typeof error?.code === "string"
          && (error.code.startsWith("local_unified_index_")
            || error[ADAPTER_ABORT] === true)) {
        throw error;
      }
      throw fixedError("local_unified_index_read_failed");
    } finally {
      if (snapshotOpen) {
        try {
          database?.exec("ROLLBACK");
        } catch {
          // The connection is closing; no error detail is safe or actionable.
        }
      }
      database?.close();
    }
  };
}
