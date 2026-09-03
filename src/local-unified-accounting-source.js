import { lstat } from "node:fs/promises";

import { isValidQuotaWindowDuration } from "@app-usagemonitor/quota-analysis";

import {
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
  readUnifiedIndexToolFactFingerprint,
} from "./local-unified-index.js";
import { validAbortSignal } from "./valid-abort-signal.js";

// Read-only adapter from the current unified fact store to the callback
// contract consumed by replay-safe accounting. This module never discovers
// or opens rollout JSONL. Coverage is complete only for an attested staged
// generation whose persisted provenance, quota occurrences, diagnostics, and
// publication state prove the reader contract.
export const LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION =
  "local-unified-accounting-source-v3";

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const GENERATION_FINGERPRINT = /^generation-v2-[a-f0-9]{64}$/u;
const TOOL_FACT_FINGERPRINT = /^tool-facts-v1-[a-f0-9]{64}$/u;
const QUOTA_SLOTS = new Set(["primary", "secondary"]);
const REQUIRED_META_KEYS = Object.freeze([
  "schema_version",
  "status",
  "contract_version",
  "current_generation_id",
]);
const CALLBACK_RESOURCE_CODES = new Set([
  "accounting_refresh_aborted",
  "accounting_scan_source_bytes_limit_exceeded",
  "accounting_scan_rss_limit_exceeded",
  "accounting_transition_rss_measurement_invalid",
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_transition_usage_limit_exceeded",
  "accounting_transition_snapshot_limit_exceeded",
  "accounting_transition_input_limit_exceeded",
  "accounting_transition_derivation_limit_exceeded",
  "accounting_archive_rss_measurement_invalid",
  "accounting_archive_rss_limit_exceeded",
]);
const GENERATION_STATUSES = new Set([
  "in_progress",
  "complete",
  "partial",
  "failed",
]);
const CONTEXT_BEHAVIORS = new Set(["source_native", "legacy_zero"]);
const ADAPTER_ABORT = Symbol("local-unified-accounting-source-abort");
const ATTRIBUTION_MEMBERSHIP_CACHE_ROWS = 256;
const MINIMUM_TIMESTAMP_MS = -8_640_000_000_000_000;

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

function safeDigest(value, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return Buffer.from(value);
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

function metaCountOptional(meta, key) {
  if (!Object.hasOwn(meta, key)) return null;
  return metaCount(meta, key);
}

function generationIdFromValue(value) {
  if (typeof value === "number" || typeof value === "bigint") {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
    return null;
  }
  if (typeof value !== "string" || !/^\d+(?:\.0+)?$/u.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validateStoredGenerationFingerprint(meta, canonicalFingerprint) {
  for (const key of [
    "current_generation_fingerprint",
    "generation_fingerprint",
  ]) {
    if (!Object.hasOwn(meta, key)) continue;
    if (meta[key] !== canonicalFingerprint) {
      throw fixedError("local_unified_index_generation_invalid");
    }
  }
}

function expectedGenerationDescriptor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") {
    const id = generationIdFromValue(value);
    if (id === null) {
      throw fixedError(
        "local_unified_index_generation_request_invalid",
        "TypeError",
      );
    }
    return { id, fingerprint: null };
  }
  if (typeof value === "string") {
    const id = generationIdFromValue(value);
    if (id !== null) return { id, fingerprint: null };
    if (!SAFE_TOKEN.test(value) && !GENERATION_FINGERPRINT.test(value)) {
      throw fixedError(
        "local_unified_index_generation_request_invalid",
        "TypeError",
      );
    }
    return { id: null, fingerprint: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fixedError(
      "local_unified_index_generation_request_invalid",
      "TypeError",
    );
  }
  const id = generationIdFromValue(
    value.id ?? value.generationId ?? value.currentGenerationId,
  );
  const fingerprint = value.fingerprint
    ?? value.generationFingerprint
    ?? value.currentGenerationFingerprint
    ?? null;
  if (fingerprint !== null
      && (typeof fingerprint !== "string"
        || (!SAFE_TOKEN.test(fingerprint)
          && !GENERATION_FINGERPRINT.test(fingerprint)))) {
    throw fixedError(
      "local_unified_index_generation_request_invalid",
      "TypeError",
    );
  }
  if (id === null && (typeof fingerprint !== "string"
      || (!SAFE_TOKEN.test(fingerprint)
        && !GENERATION_FINGERPRINT.test(fingerprint)))) {
    throw fixedError(
      "local_unified_index_generation_request_invalid",
      "TypeError",
    );
  }
  return { id, fingerprint };
}

function boundedCount(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function parserCompatibility(database, contractVersion, generationId) {
  // Dimension history is retained across additive migrations. Only parser
  // versions referenced by facts (plus the current generation for an empty
  // index) describe the published generation; an orphaned old dimension row
  // must not make every read look mixed forever.
  const rows = database.prepare(`
    SELECT DISTINCT p.parser_version, p.contract_version
    FROM parser_version p
    JOIN (
      SELECT DISTINCT parser_version_id
      FROM usage_event
      UNION
      SELECT parser_version_id
      FROM index_generation
      WHERE id = ?
    ) referenced ON referenced.parser_version_id = p.id
    ORDER BY p.parser_version, p.contract_version
  `).all(generationId);
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

function queryCount(database, sql, ...parameters) {
  const value = database.prepare(sql).get(...parameters)?.count;
  const count = boundedCount(value ?? 0);
  if (count === null) throw fixedError("local_unified_index_meta_invalid");
  return count;
}

function readCurrentGeneration(
  database,
  meta,
  requestedWindow,
  { verifyPublishedGeneration = false } = {},
) {
  for (const key of REQUIRED_META_KEYS) requiredMetaText(meta, key);
  const schemaVersion = requiredMetaText(meta, "schema_version");
  if (schemaVersion !== LOCAL_UNIFIED_INDEX_SCHEMA_VERSION) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  const indexStatus = requiredMetaText(meta, "status");
  if (!["complete", "partial"].includes(indexStatus)) {
    throw fixedError("local_unified_index_meta_invalid");
  }
  const currentGenerationId = generationIdFromValue(
    requiredMetaText(meta, "current_generation_id"),
  );
  if (currentGenerationId === null) {
    throw fixedError("local_unified_index_generation_invalid");
  }
  let generation;
  try {
    generation = database.prepare(`
      SELECT id, started_at_ms, completed_at_ms, parser_version_id,
             contract_version, status, block_reason,
             discovered_source_count, discovered_source_bytes,
             indexed_source_count, indexed_source_bytes,
             skipped_source_count, skipped_source_bytes,
             skipped_thread_count, usage_events,
             quota_occurrences, covered_start_ms, covered_end_ms,
             discovery_complete, diagnostics_complete,
             usage_provenance_complete, source_order_complete,
             quota_provenance_complete, tool_facts,
             tool_fact_fingerprint, tool_provenance_complete
      FROM index_generation
      WHERE id = ?
    `).get(currentGenerationId);
  } catch {
    throw fixedError("local_unified_index_generation_invalid");
  }
  if (!generation || Number(generation.id) !== currentGenerationId
      || !GENERATION_STATUSES.has(generation.status)) {
    throw fixedError("local_unified_index_generation_invalid");
  }
  const contractVersion = requiredMetaText(meta, "contract_version");
  if (generation.contract_version !== contractVersion
      || !SAFE_TOKEN.test(contractVersion)) {
    throw fixedError("local_unified_index_compatibility_invalid");
  }
  // The fingerprint is derived only from the published generation row. Meta
  // values are compatibility breadcrumbs, not an authority that can replace
  // the canonical identity handed to downstream accounting.
  const descriptor = readUnifiedIndexGenerationDescriptor(
    database,
    currentGenerationId,
  );
  if (!descriptor || descriptor.id !== currentGenerationId
      || !GENERATION_FINGERPRINT.test(descriptor.fingerprint)) {
    throw fixedError("local_unified_index_generation_invalid");
  }
  validateStoredGenerationFingerprint(meta, descriptor.fingerprint);
  const fingerprint = descriptor.fingerprint;
  const generatedAtMs = boundedCount(
    generation.completed_at_ms ?? generation.started_at_ms,
  );
  if (generatedAtMs === null) {
    throw fixedError("local_unified_index_generation_invalid");
  }
  const generatedAt = new Date(generatedAtMs).toISOString();
  const coveredStartMs = boundedCount(generation.covered_start_ms);
  const coveredEndMs = boundedCount(generation.covered_end_ms);
  const coveredAt = coveredStartMs !== null && coveredEndMs !== null
    && coveredEndMs >= coveredStartMs
    ? {
      startAt: new Date(coveredStartMs).toISOString(),
      endAt: new Date(coveredEndMs).toISOString(),
    }
    : null;

  const declaredUsageEvents = boundedCount(generation.usage_events);
  const declaredQuotaOccurrences = boundedCount(generation.quota_occurrences);
  const declaredToolFacts = boundedCount(generation.tool_facts);
  const declaredToolFactFingerprint = typeof generation.tool_fact_fingerprint
      === "string" && TOOL_FACT_FINGERPRINT.test(
        generation.tool_fact_fingerprint,
      )
    ? generation.tool_fact_fingerprint
    : null;
  const declaredSourceCount = boundedCount(generation.indexed_source_count);
  const declaredSourceBytes = boundedCount(generation.indexed_source_bytes);
  const skippedSourceCount = boundedCount(generation.skipped_source_count) ?? 0;
  const skippedSourceBytes = boundedCount(generation.skipped_source_bytes) ?? 0;
  const skippedThreadCount = boundedCount(generation.skipped_thread_count) ?? 0;
  const usageProvenanceAttested = generation.usage_provenance_complete === 1;
  const sourceOrderAttested = generation.source_order_complete === 1;
  const quotaProvenanceAttested = generation.quota_provenance_complete === 1;
  const toolProvenanceAttested = generation.tool_provenance_complete === 1;
  const generationAttestationComplete = usageProvenanceAttested
    && sourceOrderAttested
    && quotaProvenanceAttested;
  if (declaredUsageEvents === null
      || declaredQuotaOccurrences === null
      || declaredToolFacts === null
      || declaredToolFactFingerprint === null
      || declaredSourceCount === null
      || declaredSourceBytes === null) {
    // A completed generation without its immutable count attestation is not a
    // safe publication. The optional full verifier below can explain the
    // mismatch, but the normal reader must fail closed immediately.
    return {
      status: "partial",
      indexStatus,
      blockReason: "generation_attestation_incomplete",
      generatedAt,
      coveredAt,
      generationId: currentGenerationId,
      generationFingerprint: fingerprint,
      generationProof: false,
      requestedWindow,
      sourceCount: declaredSourceCount ?? 0,
      sourceBytes: declaredSourceBytes ?? 0,
      usageEvents: declaredUsageEvents ?? 0,
      quotaObservations: metaCountOptional(meta, "quota_observations"),
      quotaOccurrences: declaredQuotaOccurrences ?? 0,
      toolFacts: declaredToolFacts ?? 0,
      toolFactFingerprint: declaredToolFactFingerprint,
      admittedQuotaOccurrences: metaCountOptional(
        meta,
        "admitted_quota_occurrences",
      ),
      provenanceComplete: false,
      quotaOccurrencesComplete: false,
      toolFactsComplete: false,
      diagnosticsComplete: false,
      usageProvenanceAttested,
      sourceOrderAttested,
      quotaProvenanceAttested,
      toolProvenanceAttested,
      currentGeneration: generation,
    };
  }

  // Staged publication persists these values before the rename. Keep the hot
  // accounting path on the generation attestation; the explicit verifier is
  // available for migration audits and tests that need to prove every row.
  let usageEvents = declaredUsageEvents;
  let quotaOccurrences = declaredQuotaOccurrences;
  let toolFacts = declaredToolFacts;
  let admittedQuotaOccurrences = metaCountOptional(
    meta,
    "admitted_quota_occurrences",
  );
  let quotaObservations = metaCountOptional(meta, "quota_observations");
  let sourceCount = declaredSourceCount;
  let sourceBytes = declaredSourceBytes;
  let countsMatch = true;
  let sourceIncomplete = false;
  let sourceOrdinalMissing = false;
  let usageProvenanceMissing = false;
  let quotaProvenanceMissing = false;
  let toolProvenanceMissing = false;
  let toolFactFingerprintMatches = true;

  if (verifyPublishedGeneration) {
    // These checks deliberately inspect the facts themselves. A generation's
    // summary is not proof when a migrated row still has NULL provenance or
    // when an occurrence was lost between a source cursor and publication.
    usageEvents = queryCount(database, `
      SELECT COUNT(*) AS count FROM usage_event
    `);
    quotaOccurrences = queryCount(database, `
      SELECT COUNT(*) AS count FROM quota_occurrence
    `);
    toolFacts = queryCount(database, `
      SELECT COUNT(*) AS count FROM tool_class_fact
      WHERE generation_id = ?
    `, currentGenerationId);
    admittedQuotaOccurrences = queryCount(database, `
      SELECT COUNT(*) AS count FROM quota_occurrence
      WHERE admission = 'admitted'
    `);
    quotaObservations = queryCount(database, `
      SELECT COUNT(*) AS count FROM quota_observation
    `);
    sourceCount = queryCount(database, `
      SELECT COUNT(*) AS count FROM generation_source
      WHERE generation_id = ? AND status <> 'failed'
    `, currentGenerationId);
    const sourceBytesValue = database.prepare(`
      SELECT COALESCE(SUM(discovered_size_bytes), 0) AS bytes
      FROM generation_source
      WHERE generation_id = ? AND status <> 'failed'
    `).get(currentGenerationId)?.bytes;
    sourceBytes = boundedCount(sourceBytesValue);
    if (sourceBytes === null) {
      throw fixedError("local_unified_index_meta_invalid");
    }
    sourceIncomplete = queryCount(database, `
      SELECT COUNT(*) AS count FROM generation_source
      WHERE generation_id = ?
        AND (status = 'pending' OR diagnostics_complete <> 1)
    `, currentGenerationId) > 0;
    sourceOrdinalMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM generation_source
      WHERE generation_id = ? AND source_ordinal IS NULL
    `, currentGenerationId) > 0;
    sourceOrdinalMissing = sourceOrdinalMissing || queryCount(database, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT source_ordinal
        FROM generation_source
        WHERE generation_id = ?
        GROUP BY source_ordinal
        HAVING COUNT(*) > 1
      )
    `, currentGenerationId) > 0;
    sourceOrdinalMissing = sourceOrdinalMissing || queryCount(database, `
      SELECT (
        (SELECT COUNT(*) FROM source_cursor sc
         WHERE NOT EXISTS (
           SELECT 1 FROM generation_source gs
           WHERE gs.generation_id = ? AND gs.source_local = sc.source_local
             AND gs.source_ordinal = sc.source_ordinal))
        +
        (SELECT COUNT(*) FROM generation_source gs
         LEFT JOIN source_cursor sc ON sc.source_local = gs.source_local
         WHERE gs.generation_id = ?
           AND gs.status <> 'failed'
           AND (sc.source_local IS NULL OR sc.source_ordinal IS NULL
             OR sc.source_ordinal != gs.source_ordinal))
      ) AS count
    `, currentGenerationId, currentGenerationId) > 0;
    usageProvenanceMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM usage_event
      WHERE source_local IS NULL OR source_offset IS NULL
        OR source_ordinal IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM generation_source gs
          WHERE gs.generation_id = ?
            AND gs.source_local = usage_event.source_local
            AND gs.source_ordinal = usage_event.source_ordinal)
    `, currentGenerationId) > 0;
    quotaProvenanceMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM quota_occurrence
      WHERE source_local IS NULL OR source_offset IS NULL
        OR source_ordinal IS NULL OR slot_order IS NULL
        OR surface_id IS NULL OR admission IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM generation_source gs
          WHERE gs.generation_id = ?
            AND gs.source_local = quota_occurrence.source_local
            AND gs.source_ordinal = quota_occurrence.source_ordinal)
    `, currentGenerationId) > 0 || queryCount(database, `
      SELECT COUNT(*) AS count
      FROM quota_observation q
      WHERE NOT EXISTS (
        SELECT 1
        FROM quota_occurrence o
        WHERE o.canonical_observation_id = q.id
      )
    `) > 0;
    toolProvenanceMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM tool_class_fact f
      WHERE f.generation_id = ?
        AND (f.source_local IS NULL OR f.source_offset IS NULL
          OR f.source_ordinal IS NULL OR f.session_local IS NULL
          OR f.tool_class IS NULL OR f.source_kind IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM generation_source gs
            WHERE gs.generation_id = ?
              AND gs.source_local = f.source_local
              AND gs.source_ordinal = f.source_ordinal))
    `, currentGenerationId, currentGenerationId) > 0;
    toolFactFingerprintMatches = readUnifiedIndexToolFactFingerprint(
      database,
      currentGenerationId,
    ) === declaredToolFactFingerprint;
    countsMatch = declaredUsageEvents === usageEvents
      && declaredQuotaOccurrences === quotaOccurrences
      && declaredToolFacts === toolFacts
      && declaredSourceCount === sourceCount
      && declaredSourceBytes === sourceBytes;
  } else {
    // Range-scoped checks catch a legacy nullable row before it can be
    // emitted, without turning every short history read into a full-table
    // audit. The generation attestation remains the source of whole-index
    // counts and publication capabilities.
    const startMs = Date.parse(requestedWindow.startAt);
    const endMs = Date.parse(requestedWindow.endAt);
    usageProvenanceMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM usage_event
      WHERE observed_at_ms >= ? AND observed_at_ms <= ?
        AND (source_local IS NULL OR source_offset IS NULL
          OR source_ordinal IS NULL OR NOT EXISTS (
            SELECT 1 FROM generation_source gs
            WHERE gs.generation_id = ?
              AND gs.source_local = usage_event.source_local
              AND gs.source_ordinal = usage_event.source_ordinal))
    `, startMs, endMs, currentGenerationId) > 0;
    quotaProvenanceMissing = queryCount(database, `
      SELECT COUNT(*) AS count FROM quota_occurrence
      WHERE observed_at_ms >= ? AND observed_at_ms <= ?
        AND (source_local IS NULL OR source_offset IS NULL
          OR source_ordinal IS NULL OR slot_order IS NULL
          OR surface_id IS NULL OR admission IS NULL OR NOT EXISTS (
            SELECT 1 FROM generation_source gs
            WHERE gs.generation_id = ?
              AND gs.source_local = quota_occurrence.source_local
              AND gs.source_ordinal = quota_occurrence.source_ordinal))
    `, startMs, endMs, currentGenerationId) > 0;
  }
  const toolOnlyPartial = generation.status === "partial"
    && indexStatus === "partial"
    && generation.block_reason === "tool_provenance_incomplete"
    && !toolProvenanceAttested;
  const quarantinePartial = generation.status === "partial"
    && indexStatus === "partial"
    && generation.block_reason === "codex_rollout_sources_quarantined"
    && skippedSourceCount > 0
    && skippedThreadCount > 0;
  const generationComplete = ((generation.status === "complete"
      && indexStatus === "complete") || toolOnlyPartial || quarantinePartial)
    && generation.discovery_complete === 1
    && generation.diagnostics_complete === 1;
  const diagnosticsComplete = !sourceIncomplete
    && generation.diagnostics_complete === 1;
  const provenanceComplete = !usageProvenanceMissing
    && !quotaProvenanceMissing
    && !sourceOrdinalMissing
    && generationAttestationComplete;
  const quotaOccurrencesComplete = declaredQuotaOccurrences !== null
    && quotaOccurrences === declaredQuotaOccurrences
    && quotaProvenanceAttested
    && !quotaProvenanceMissing;
  const toolFactsComplete = declaredToolFacts !== null
    && toolFacts === declaredToolFacts
    && toolProvenanceAttested
    && !toolProvenanceMissing
    && toolFactFingerprintMatches;
  let blockReason = null;
  if (!generationComplete) {
    blockReason = typeof generation.block_reason === "string"
      && SAFE_TOKEN.test(generation.block_reason)
      ? generation.block_reason
      : "generation_incomplete";
  } else if (!generationAttestationComplete) {
    blockReason = "generation_attestation_incomplete";
  }
  else if (!countsMatch) blockReason = "generation_counts_mismatch";
  else if (!provenanceComplete) blockReason = "legacy_nullable_rows";
  else if (!quotaOccurrencesComplete) {
    blockReason = "quota_occurrences_incomplete";
  } else if (!diagnosticsComplete) {
    blockReason = "source_diagnostics_incomplete";
  }
  const partialGapProof = quarantinePartial
    && countsMatch
    && provenanceComplete
    && quotaOccurrencesComplete
    && diagnosticsComplete;
  // A proven gap is still a gap. Preserve its fixed reason for downstream
  // coverage/UI contracts even though every published fact is fully attested.
  if (partialGapProof && blockReason === null) {
    blockReason = "codex_rollout_sources_quarantined";
  }
  const generationProof = blockReason === null || partialGapProof;
  return {
    status: quarantinePartial ? "partial" : generationProof ? "complete" : "partial",
    indexStatus,
    blockReason,
    generatedAt,
    coveredAt,
    generationId: currentGenerationId,
    generationFingerprint: fingerprint,
    generationProof,
    requestedWindow,
    sourceCount,
    sourceBytes,
    skippedSourceCount,
    skippedSourceBytes,
    skippedThreadCount,
    usageEvents,
    quotaObservations,
    quotaOccurrences,
    toolFacts,
    toolFactFingerprint: declaredToolFactFingerprint,
    admittedQuotaOccurrences,
    provenanceComplete,
    quotaOccurrencesComplete,
    toolFactsComplete,
    diagnosticsComplete,
    usageProvenanceAttested,
    sourceOrderAttested,
    quotaProvenanceAttested,
    toolProvenanceAttested,
    currentGeneration: generation,
  };
}

function validateUsageJoins(
  database,
  { startAt, endAt, verifyPublishedGeneration = false } = {},
) {
  const where = verifyPublishedGeneration ? "" : `
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms <= ?`;
  const parameters = verifyPublishedGeneration
    ? []
    : [Date.parse(startAt), Date.parse(endAt)];
  const usageCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM usage_event u${where}
  `).get(...parameters)?.count ?? 0);
  // Every dimension id is an INTEGER PRIMARY KEY, so an inner join over the
  // four dimensions matches each usage row at most once and the joined count
  // equals the usage count exactly when no row references a missing
  // dimension. Ask that question directly: the planner turns the four-way
  // join into a scan of the smallest dimension times the whole usage range
  // (~4.5 s per call on a 727k-row index), while four correlated primary-key
  // probes finish the same proof in ~0.3 s. The pass/fail result is identical.
  const orphanedEvents = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM usage_event u
    ${verifyPublishedGeneration ? "WHERE" : `${where}
      AND`} (
      NOT EXISTS (SELECT 1 FROM model m WHERE m.id = u.model_id)
      OR NOT EXISTS (SELECT 1 FROM tier_semantics t WHERE t.id = u.tier_id)
      OR NOT EXISTS (SELECT 1 FROM surface_class s WHERE s.id = u.surface_id)
      OR NOT EXISTS (
        SELECT 1 FROM account_scope a WHERE a.id = u.account_scope_id))
  `).get(...parameters)?.count ?? 0);
  if (!Number.isSafeInteger(usageCount)
      || !Number.isSafeInteger(orphanedEvents)
      || orphanedEvents !== 0) {
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

function mapCallbackError(error, signal) {
  if (error?.name === "AbortError"
      || error?.code === "ABORT_ERR"
      || signal?.aborted) {
    const aborted = fixedError(
      "local_unified_index_read_aborted",
      "AbortError",
    );
    aborted[ADAPTER_ABORT] = true;
    return aborted;
  }
  if (CALLBACK_RESOURCE_CODES.has(error?.code)) {
    return fixedError(error.code);
  }
  return fixedError("local_unified_index_callback_failed");
}

// Deliver one row. A synchronous consumer costs no promise at all; only a
// consumer that returns a thenable is awaited. Either way a throw or a
// rejection maps to the same fixed, content-free codes.
function invoke(callback, value, signal) {
  let result;
  try {
    result = callback(value);
  } catch (error) {
    throw mapCallbackError(error, signal);
  }
  if (result && typeof result.then === "function") {
    return result.then(undefined, (error) => {
      throw mapCallbackError(error, signal);
    });
  }
  return undefined;
}

function readDiagnostics(database, generationId) {
  const diagnostics = {};
  for (const row of database.prepare(`
    SELECT code, SUM(count) AS count
    FROM source_diagnostic
    WHERE generation_id = ?
    GROUP BY code
    ORDER BY code
  `).iterate(generationId)) {
    const code = safeText(row.code);
    const count = safeNonNegativeInteger(row.count);
    diagnostics[code] = count;
  }
  return diagnostics;
}

function sameOpenedFile(before, after) {
  if (!ownerOnlyRegularFile(after)) return false;
  const canCompareIdentity = [before.dev, before.ino, after.dev, after.ino]
    .every((value) => value !== undefined && value !== null);
  return !canCompareIdentity
    || (before.dev === after.dev && before.ino === after.ino);
}

async function revalidatePublishedSnapshot({
  indexFile,
  metadata,
  database,
  coverage,
  requestedWindow,
  verifyPublishedGeneration,
}) {
  let finalMetadata;
  try {
    finalMetadata = await lstat(indexFile);
  } catch {
    throw fixedError("local_unified_index_file_changed");
  }
  if (!sameOpenedFile(metadata, finalMetadata)) {
    throw fixedError("local_unified_index_file_changed");
  }

  const finalCoverage = readCurrentGeneration(
    database,
    readMeta(database),
    requestedWindow,
    { verifyPublishedGeneration },
  );
  if (finalCoverage.generationId !== coverage.generationId
      || finalCoverage.generationFingerprint
        !== coverage.generationFingerprint) {
    throw fixedError("local_unified_index_generation_mismatch");
  }

  // Close the race between the final lstat and the generation read. A
  // copy-on-write publisher must leave the same inode at the path for the
  // entire callback/read boundary.
  let settledMetadata;
  try {
    settledMetadata = await lstat(indexFile);
  } catch {
    throw fixedError("local_unified_index_file_changed");
  }
  if (!sameOpenedFile(finalMetadata, settledMetadata)) {
    throw fixedError("local_unified_index_file_changed");
  }
}

function capabilitiesFor(coverage) {
  return {
    readsRawSources: false,
    deterministicCanonicalOrder: coverage.generationProof,
    sourceOrderingProvenance: coverage.provenanceComplete,
    sourceOffsetProvenance: coverage.provenanceComplete,
    sourceScopedQuotaOccurrences: coverage.quotaOccurrencesComplete,
    durableDiagnostics: coverage.diagnosticsComplete,
    crashSafeGenerationPublication: coverage.generationProof,
  };
}

function unavailableHistoryRead(errorCode) {
  return {
    status: "unavailable",
    errorCode,
    coverage: null,
    capabilities: null,
    diagnosticsAvailable: null,
  };
}

function rememberBounded(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Derive historical association metadata from the same pinned SQLite facts as
 * the caller's usage rows. Nothing is persisted, and no account is inferred.
 *
 * read(row) accepts raw usage_event columns source_local, source_offset,
 * source_ordinal, session_local and observed_at_ms. Callers retain ownership
 * of the read-only connection and must revalidate its published generation
 * before publishing their result. Indexed predecessor lookups support repeated
 * or out-of-order corpus slices without retaining whole sessions.
 */
/**
 * One ordered pass over a published generation that pre-derives the two
 * expensive per-row lookups the attribution reader performs — the same-record
 * quota plans and the same-source predecessor — for every usage row, keyed
 * by rowid, plus the set of sessions whose rows span more than one source
 * (the only sessions for which the cross-source session predecessor query can
 * return anything). The reader's decision logic is untouched: given this
 * structure it consults these results instead of issuing point queries, and
 * falls back to the queries for any rowid the pass did not see.
 *
 * Why it is exact:
 * - the pass walks usage_event in (source_local, source_offset,
 *   observed_at_ms) order — the covering predecessor index's own order, with
 *   (source_ordinal, session_local, rowid) as the implicit tail — so a row's
 *   same-source predecessor is the last eligible row of the previous offset
 *   group, exactly the row the reader's `ORDER BY source_offset DESC,
 *   observed_at_ms DESC LIMIT 1` reverse index walk returns, under the same
 *   eligibility (generation membership, matching ordinal, offset within the
 *   member's scanned bytes, non-null offset);
 * - same-record plans arrive joined on the reader's own four-column key and
 *   filters, and are reduced with the same DISTINCT / ORDER BY / LIMIT 2 rule;
 * - a session confined to one source has no row from another source, so the
 *   session-predecessor query is provably empty for it.
 * Everything retained is content-free: offsets, ordinals, timestamps, plan
 * labels and salted digests, the same columns the point queries read.
 */
export function precomputeLocalUnifiedUsageAttribution({
  database,
  generationId,
} = {}) {
  if (typeof database?.prepare !== "function"
      || !Number.isSafeInteger(generationId) || generationId < 1) {
    throw fixedError("local_unified_index_attribution_options_invalid", "TypeError");
  }
  const maxRowId = Number(database.prepare(
    "SELECT COALESCE(MAX(rowid), 0) AS max_row_id FROM usage_event",
  ).get()?.max_row_id);
  if (!Number.isSafeInteger(maxRowId) || maxRowId < 0) {
    throw fixedError("local_unified_index_row_invalid");
  }
  const size = maxRowId + 1;
  const seen = new Uint8Array(size);
  const predecessorMs = new Float64Array(size).fill(Number.NaN);
  const predecessorSessionMatches = new Uint8Array(size);
  const planCount = new Uint8Array(size);
  const planFirst = new Int32Array(size).fill(-1);
  const planSecond = new Int32Array(size).fill(-1);
  const planTable = [];
  const planIndexByLabel = new Map();
  const internPlan = (label) => {
    let index = planIndexByLabel.get(label);
    if (index === undefined) {
      index = planTable.push(label) - 1;
      planIndexByLabel.set(label, index);
    }
    return index;
  };
  const members = new Map();
  for (const row of database.prepare(`
    SELECT source_local, source_ordinal, session_local, scanned_bytes
    FROM generation_source
    WHERE generation_id = ?
      AND status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
      AND diagnostics_complete = 1`).iterate(generationId)) {
    members.set(Buffer.from(row.source_local).toString("hex"), {
      sourceOrdinal: Number(row.source_ordinal),
      sessionLocal: row.session_local === null
        ? null
        : Buffer.from(row.session_local),
      scannedBytes: Number(row.scanned_bytes),
    });
  }
  const multiSourceSessions = new Set();
  for (const row of database.prepare(`
    SELECT session_local FROM usage_event
    GROUP BY session_local HAVING COUNT(DISTINCT source_local) > 1`).iterate()) {
    if (row.session_local !== null) {
      multiSourceSessions.add(Buffer.from(row.session_local).toString("hex"));
    }
  }
  const stream = database.prepare(`
    SELECT u.rowid AS row_id, u.source_local, u.source_offset,
           u.source_ordinal, u.session_local, u.observed_at_ms, q.plan_type
    FROM usage_event u
    LEFT JOIN quota_occurrence q
      ON q.source_local = u.source_local AND q.source_offset = u.source_offset
        AND q.source_ordinal = u.source_ordinal
        AND q.observed_at_ms = u.observed_at_ms
        AND q.provider = 'openai_codex' AND q.admission = 'admitted'
        AND q.plan_type IS NOT NULL AND q.plan_type <> 'unknown'
    ORDER BY u.source_local, u.source_offset, u.observed_at_ms`);
  let currentSourceHex = null;
  let member = null;
  let groupOffset = null;
  let previousGroupLast = null;
  let currentGroupLast = null;
  let lastRowId = -1;
  const rowPlans = new Set();
  const settlePlans = (rowId) => {
    if (rowPlans.size === 0) return;
    // The reader keeps the two smallest distinct labels (ORDER BY ... LIMIT 2,
    // SQLite's BINARY collation = UTF-8 byte order) and treats a second one
    // as a conflict; both survive so the reader validates exactly what the
    // query would have handed it.
    const ordered = [...rowPlans].sort(utf8ByteCompare).slice(0, 2);
    planCount[rowId] = ordered.length;
    planFirst[rowId] = internPlan(ordered[0]);
    if (ordered.length > 1) planSecond[rowId] = internPlan(ordered[1]);
    rowPlans.clear();
  };
  for (const row of stream.iterate()) {
    const rowId = Number(row.row_id);
    if (!Number.isSafeInteger(rowId) || rowId < 0 || rowId > maxRowId) {
      throw fixedError("local_unified_index_row_invalid");
    }
    if (rowId !== lastRowId) {
      if (lastRowId !== -1) settlePlans(lastRowId);
      lastRowId = rowId;
      const sourceHex = row.source_local === null
        ? null
        : Buffer.from(row.source_local).toString("hex");
      if (sourceHex !== currentSourceHex) {
        currentSourceHex = sourceHex;
        member = sourceHex === null ? null : members.get(sourceHex) ?? null;
        groupOffset = null;
        previousGroupLast = null;
        currentGroupLast = null;
      }
      const offset = row.source_offset === null ? null : Number(row.source_offset);
      if (offset !== groupOffset) {
        if (currentGroupLast !== null) previousGroupLast = currentGroupLast;
        currentGroupLast = null;
        groupOffset = offset;
      }
      seen[rowId] = 1;
      if (previousGroupLast !== null) {
        predecessorMs[rowId] = previousGroupLast.observedAtMs;
        predecessorSessionMatches[rowId] = previousGroupLast.sessionMatches ? 1 : 0;
      }
      if (member !== null && offset !== null
          && Number(row.source_ordinal) === member.sourceOrdinal
          && offset <= member.scannedBytes) {
        currentGroupLast = {
          observedAtMs: row.observed_at_ms,
          sessionMatches: member.sessionLocal !== null
            && row.session_local !== null
            && member.sessionLocal.equals(row.session_local),
        };
      }
    }
    if (typeof row.plan_type === "string") rowPlans.add(row.plan_type);
  }
  if (lastRowId !== -1) settlePlans(lastRowId);
  return {
    has: (rowId) => Number.isSafeInteger(rowId) && rowId >= 0
      && rowId <= maxRowId && seen[rowId] === 1,
    plansFor: (rowId) => {
      const count = planCount[rowId];
      if (count === 0) return [];
      if (count === 1) return [planTable[planFirst[rowId]]];
      return [planTable[planFirst[rowId]], planTable[planSecond[rowId]]];
    },
    predecessorFor: (rowId) => (
      Number.isNaN(predecessorMs[rowId])
        ? undefined
        : {
          observed_at_ms: predecessorMs[rowId],
          session_matches: predecessorSessionMatches[rowId],
        }
    ),
    multiSourceSessions,
  };
}

function utf8ByteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createLocalUnifiedUsageAttributionReader({
  database,
  generationId,
  precomputed = null,
} = {}) {
  if (typeof database?.prepare !== "function"
      || !Number.isSafeInteger(generationId) || generationId < 1
      || (precomputed !== null
        && (typeof precomputed?.has !== "function"
          || typeof precomputed.plansFor !== "function"
          || typeof precomputed.predecessorFor !== "function"
          || !(precomputed.multiSourceSessions instanceof Set)))) {
    throw fixedError("local_unified_index_attribution_options_invalid", "TypeError");
  }
  const membership = database.prepare(`
    SELECT source_ordinal, session_local, scanned_bytes
    FROM generation_source
    WHERE generation_id = ? AND source_local = ?
      AND status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
      AND diagnostics_complete = 1`);
  const plans = database.prepare(`
    SELECT DISTINCT q.plan_type
    FROM quota_occurrence q
    JOIN generation_source gs
      ON gs.generation_id = ? AND gs.source_local = q.source_local
        AND gs.source_ordinal = q.source_ordinal
        AND q.source_offset <= gs.scanned_bytes
        AND gs.status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
        AND gs.diagnostics_complete = 1
    WHERE q.source_local = ? AND q.source_offset = ?
      AND q.source_ordinal = ? AND q.observed_at_ms = ?
      AND q.provider = 'openai_codex' AND q.admission = 'admitted'
      AND q.plan_type IS NOT NULL AND q.plan_type <> 'unknown'
    ORDER BY q.plan_type LIMIT 2`);
  const sourceBefore = database.prepare(`
    SELECT p.source_offset, p.observed_at_ms,
           p.session_local = gs.session_local AS session_matches
    FROM usage_event p
    JOIN generation_source gs
      ON gs.generation_id = ? AND gs.source_local = p.source_local
        AND gs.source_ordinal = p.source_ordinal
        AND p.source_offset <= gs.scanned_bytes
        AND gs.status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
        AND gs.diagnostics_complete = 1
    WHERE p.source_local = ? AND p.source_offset IS NOT NULL
      AND p.source_offset < ?
    ORDER BY p.source_offset DESC, p.observed_at_ms DESC LIMIT 1`);
  const sessionBefore = database.prepare(`
    SELECT p.observed_at_ms
    FROM usage_event p
    JOIN generation_source gs
      ON gs.generation_id = ? AND gs.source_local = p.source_local
        AND gs.source_ordinal = p.source_ordinal
        AND p.source_offset <= gs.scanned_bytes
        AND gs.session_local = p.session_local
        AND gs.status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
        AND gs.diagnostics_complete = 1
    WHERE p.session_local = ? AND p.source_local <> ?
      AND p.source_offset IS NOT NULL
      AND p.observed_at_ms >= ? AND p.observed_at_ms < ?
    ORDER BY p.observed_at_ms DESC LIMIT 1`);
  const memberships = new Map();

  function projectPredecessor(row, { source = false } = {}) {
    if (row === undefined) return null;
    const { observedAtMs } = timestampForMs(row.observed_at_ms);
    return {
      observedAtMs,
      sessionMatches: source && row.session_matches === 1,
    };
  }

  return {
    read(row) {
      const result = {
        planAttribution: {
          basis: "unavailable",
          planType: null,
          // Schema 11 does not record a plan variant on quota occurrences.
          planVariant: null,
        },
        usageIntervalStartedAt: null,
        usageIntervalBasis: "unavailable",
      };
      const sourceLocal = safeDigest(row?.source_local ?? null, { nullable: true });
      const sourceOffset = safeNonNegativeInteger(row?.source_offset ?? null, {
        nullable: true,
        nullValue: null,
      });
      const sourceOrdinal = safeNonNegativeInteger(row?.source_ordinal ?? null, {
        nullable: true,
        nullValue: null,
      });
      if (sourceLocal === null || sourceOffset === null || sourceOrdinal === null) {
        return result;
      }
      const { observedAtMs } = timestampForMs(row.observed_at_ms);
      const sourceKey = sourceLocal.toString("hex");
      let member = memberships.get(sourceKey);
      if (member === undefined) {
        member = membership.get(generationId, sourceLocal) ?? null;
      }
      rememberBounded(memberships, sourceKey, member, ATTRIBUTION_MEMBERSHIP_CACHE_ROWS);
      if (member === null || member.source_ordinal !== sourceOrdinal
          || !Number.isSafeInteger(member.scanned_bytes) || member.scanned_bytes < 0
          || sourceOffset > member.scanned_bytes) return result;

      const rowId = precomputed === null ? null : Number(row.row_id);
      const usePrecomputed = rowId !== null && precomputed.has(rowId);
      const observedPlans = (usePrecomputed
        ? precomputed.plansFor(rowId)
        : plans.all(
          generationId, sourceLocal, sourceOffset, sourceOrdinal, observedAtMs,
        ).map((value) => value.plan_type)
      ).map((value) => safeText(value));
      if (observedPlans.length === 1) {
        result.planAttribution.basis = "same_record";
        result.planAttribution.planType = observedPlans[0];
      } else if (observedPlans.length > 1) {
        result.planAttribution.basis = "conflicted";
      }

      // Physical order can positively reveal a reversed clock. Do not hide
      // that contradiction by picking some earlier wall-clock timestamp.
      const sourcePrevious = projectPredecessor(usePrecomputed
        ? precomputed.predecessorFor(rowId)
        : sourceBefore.get(generationId, sourceLocal, sourceOffset), { source: true });
      if (sourcePrevious !== null && sourcePrevious.observedAtMs > observedAtMs) {
        return result;
      }
      const sessionLocal = safeDigest(row.session_local ?? null, { nullable: true });
      const memberSession = safeDigest(member.session_local, { nullable: true });
      const hasSessionLineage = sessionLocal !== null && memberSession !== null
        && sessionLocal.equals(memberSession);
      let previous = null;
      if (hasSessionLineage) {
        // Any other-source candidate older than this valid local predecessor
        // cannot improve the bound. Keeping the lookup inside that interval is
        // important for a long session held entirely in one source: excluding
        // that source must not scan its whole history on every usage row.
        // A session confined to a single source has no other-source record,
        // so the query below is provably empty for it; only sessions the
        // precomputation saw spanning several sources still pay for it.
        previous = projectPredecessor(usePrecomputed
            && !precomputed.multiSourceSessions.has(sessionLocal.toString("hex"))
          ? undefined
          : sessionBefore.get(
            generationId,
            sessionLocal,
            sourceLocal,
            sourcePrevious?.sessionMatches === true
              ? sourcePrevious.observedAtMs : MINIMUM_TIMESTAMP_MS,
            observedAtMs,
          ));
        // Equal-time order is meaningful within this physical source, not
        // between sources with coincident timestamps/discovery ordinals.
        if (sourcePrevious?.sessionMatches === true
            && (previous === null
              || sourcePrevious.observedAtMs >= previous.observedAtMs)) {
          previous = sourcePrevious;
        }
        if (previous !== null) result.usageIntervalBasis = "previous_session_record";
      }
      if (previous === null && sourcePrevious !== null) {
        previous = sourcePrevious;
        result.usageIntervalBasis = "previous_source_record";
      }
      if (previous !== null) {
        result.usageIntervalStartedAt = new Date(previous.observedAtMs).toISOString();
      }
      return result;
    },
  };
}

// What a usage consumer declares about the per-row attribution it will read.
// "required" (the default, and the historical behavior) enriches every usage
// row with plan attribution and usage-interval metadata, which costs a
// membership lookup plus up to three indexed point queries per row. "none" is
// for aggregate consumers that never read those fields — the rows carry no
// attribution keys at all, so an accidental reader fails loudly rather than
// reading a silently absent value.
const USAGE_ATTRIBUTION_MODES = new Set(["required", "none"]);
// Rows delivered between event-loop yields. Consumers run synchronously, so
// a yield every so often is what lets an abort signalled from a macrotask
// (SIGTERM, a timer, the parent's watchdog) actually reach the loop's abort
// check instead of waiting for the whole stream.
const CALLBACK_YIELD_ROWS = 2_048;

function validateRequest({
  startAt,
  endAt,
  signal,
  onUsage,
  onRateLimitSnapshot,
  usageAttribution,
  indexedHistory,
}) {
  const start = canonicalInstant(startAt);
  const end = canonicalInstant(endAt);
  if (start === null || end === null || Date.parse(start) > Date.parse(end)
      || !validAbortSignal(signal)
      || (onUsage !== undefined && typeof onUsage !== "function")
      || (onRateLimitSnapshot !== undefined
        && typeof onRateLimitSnapshot !== "function")
      || (usageAttribution !== undefined
        && !USAGE_ATTRIBUTION_MODES.has(usageAttribution))
      || (indexedHistory !== undefined
        && (indexedHistory === null
          || typeof indexedHistory !== "object"
          || Array.isArray(indexedHistory)
          || typeof indexedHistory.onUsage !== "function"))) {
    throw fixedError("local_unified_index_read_request_invalid", "TypeError");
  }
  return {
    startAt: start,
    endAt: end,
    usageAttribution: usageAttribution ?? "required",
  };
}

function cooperativeYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Return a scanner-shaped function over one already-published unified index.
 * The connection is always read-only and is closed after callbacks settle.
 */
export function createLocalUnifiedAccountingSource({
  indexFile,
  requireComplete = false,
  expectedGeneration = null,
  contextBehavior = "source_native",
  verifyPublishedGeneration = false,
  fullIntegrity = false,
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1
      || typeof requireComplete !== "boolean"
      || typeof verifyPublishedGeneration !== "boolean"
      || typeof fullIntegrity !== "boolean"
      || !CONTEXT_BEHAVIORS.has(contextBehavior)) {
    throw fixedError("local_unified_index_source_options_invalid", "TypeError");
  }
  const verifyGeneration = verifyPublishedGeneration || fullIntegrity;
  const expected = expectedGenerationDescriptor(expectedGeneration);
  return async function scanLocalUnifiedAccountingSource({
    startAt,
    endAt,
    signal = null,
    onUsage,
    onRateLimitSnapshot,
    usageAttribution,
    // Optional second consumer: `{ onUsage }` receives every usage row of the
    // published generation's whole covered range (never quota rows, never
    // attribution) in the SAME physical pass as the requested window. The
    // covered range is proven with exactly the checks a separate read of it
    // would run; if that proof fails with a reader code the result reports
    // `indexedHistory.status: "unavailable"` with the code, the pass shrinks
    // back to the requested window, and the requested window's own read is
    // unaffected — the two outcomes are independent, as two reads would be.
    indexedHistory,
  } = {}) {
    const window = validateRequest({
      startAt,
      endAt,
      signal,
      onUsage,
      onRateLimitSnapshot,
      usageAttribution,
      indexedHistory,
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
      const meta = readMeta(database);
      // The proof one requested window needs, in the order the reader has
      // always run it. The covered-range consumer below runs the identical
      // sequence for its own window, so a fused read proves each window
      // exactly as a separate read of that window would.
      const validateWindow = ({ startAt: requestedStartAt, endAt: requestedEndAt }) => {
        const requested = { startAt: requestedStartAt, endAt: requestedEndAt };
        const proven = readCurrentGeneration(database, meta, requested, {
          verifyPublishedGeneration: verifyGeneration,
        });
        if (expected !== null
            && ((expected.id !== null && expected.id !== proven.generationId)
              || (expected.fingerprint !== null
                && expected.fingerprint !== proven.generationFingerprint))) {
          throw fixedError("local_unified_index_generation_mismatch");
        }
        const provenContractVersion = requiredMetaText(meta, "contract_version");
        if (!SAFE_TOKEN.test(provenContractVersion)) {
          throw fixedError("local_unified_index_meta_invalid");
        }
        validateUsageJoins(database, {
          startAt: requested.startAt,
          endAt: requested.endAt,
          verifyPublishedGeneration: verifyGeneration,
        });
        const provenCompatibility = parserCompatibility(
          database,
          provenContractVersion,
          proven.generationId,
        );
        if (provenCompatibility.status !== "compatible"
            && proven.status === "complete") {
          proven.status = "partial";
          proven.generationProof = false;
          proven.blockReason = "mixed_parser_versions";
        }
        const attestedGap = proven.status === "partial"
          && proven.blockReason === "codex_rollout_sources_quarantined"
          && proven.generationProof === true;
        if (requireComplete && proven.status !== "complete" && !attestedGap) {
          throw fixedError("local_unified_index_accounting_coverage_incomplete");
        }
        return {
          coverage: proven,
          contractVersion: provenContractVersion,
          compatibility: provenCompatibility,
          diagnostics: readDiagnostics(database, proven.generationId),
        };
      };
      const { coverage, contractVersion, compatibility, diagnostics } =
        validateWindow(window);
      const startMs = Date.parse(window.startAt);
      const endMs = Date.parse(window.endAt);
      let historyRead = null;
      let historyRange = null;
      if (indexedHistory !== undefined) {
        const coveredAt = coverage.coveredAt;
        if (coveredAt === null) {
          historyRead = unavailableHistoryRead(
            "local_unified_index_coverage_unavailable",
          );
        } else {
          try {
            const proven = validateWindow({
              startAt: coveredAt.startAt,
              endAt: coveredAt.endAt,
            });
            historyRange = {
              startMs: Date.parse(coveredAt.startAt),
              endMs: Date.parse(coveredAt.endAt),
            };
            historyRead = {
              status: "available",
              errorCode: null,
              coverage: proven.coverage,
              capabilities: capabilitiesFor(proven.coverage),
              diagnosticsAvailable: proven.coverage.diagnosticsComplete,
            };
          } catch (error) {
            if (typeof error?.code !== "string"
                || !error.code.startsWith("local_unified_index_")) {
              throw error;
            }
            historyRead = unavailableHistoryRead(error.code);
          }
        }
      }
      // One physical pass over the union of the proven windows; each row is
      // delivered only to the consumers whose window contains it, exactly as
      // separate bounded reads would have delivered it.
      const scanStartMs = historyRange === null
        ? startMs
        : Math.min(startMs, historyRange.startMs);
      const scanEndMs = historyRange === null
        ? endMs
        : Math.max(endMs, historyRange.endMs);
      // Attribution is derived only for a consumer that declared it will read
      // it. The aggregate consumers (period totals, timelines) never do, and
      // on a large index the per-row lookups were two thirds of a rebuild.
      const attributionReader = onUsage === undefined
          || window.usageAttribution !== "required"
        ? null
        : createLocalUnifiedUsageAttributionReader({
          database,
          generationId: coverage.generationId,
        });
      let sequence = 0;
      let deliveredSinceYield = 0;
      const deliver = async (callback, value) => {
        const pending = invoke(callback, value, signal);
        if (pending !== undefined) await pending;
        deliveredSinceYield += 1;
        if (deliveredSinceYield === CALLBACK_YIELD_ROWS) {
          deliveredSinceYield = 0;
          await cooperativeYield();
        }
      };
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
               u.source_local,
               u.source_offset,
               u.source_ordinal,
               u.session_local,
               u.tier_observed_at_ms,
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
        ORDER BY u.observed_at_ms,
                 COALESCE(u.source_ordinal, 2147483647),
                 COALESCE(u.source_local, zeroblob(32)),
                 COALESCE(u.source_offset, 9223372036854775807),
                 u.event_key
      `);
      for (const row of usageStatement.iterate(scanStartMs, scanEndMs)) {
        throwIfAborted(signal);
        validateEventKey(row.event_key);
        const { observedAtMs, timestamp } = timestampForMs(row.observed_at_ms);
        const inWindow = observedAtMs >= startMs && observedAtMs <= endMs;
        const inHistory = historyRange !== null
          && observedAtMs >= historyRange.startMs
          && observedAtMs <= historyRange.endMs;
        const components = usageComponents(row);
        if (!hasUsage(components)) continue;
        const totalInputContextTokens = safeNonNegativeInteger(
          row.total_input_context,
          { nullable: true, nullValue: null },
        );
        const sourceLocal = safeDigest(row.source_local, { nullable: true });
        const sourceOffset = safeNonNegativeInteger(
          row.source_offset,
          { nullable: true },
        );
        const sourceOrdinal = safeNonNegativeInteger(
          row.source_ordinal,
          { nullable: true },
        );
        const tierObservedAtMs = safeNonNegativeInteger(
          row.tier_observed_at_ms,
          { nullable: true },
        );
        const tierObservedAt = tierObservedAtMs === null
          ? null
          : timestampForMs(tierObservedAtMs).timestamp;
        const usage = {
          ...(inWindow ? attributionReader?.read(row) : undefined),
          timestamp,
          timestampMs: observedAtMs,
          model: safeText(row.model_id),
          components,
          tierSemantics: {
            billingSurface: safeText(row.billing_surface),
            codexSpeedMode: safeText(row.codex_speed_mode),
            apiServiceTier: safeText(row.api_service_tier),
            tierSource: safeText(row.tier_source),
            tierObservedAt,
          },
          surfaceClassification: {
            surface: safeText(row.surface),
            threadSource: safeText(row.thread_source),
            agentScope: safeText(row.agent_scope),
            lineageDisposition: safeText(row.lineage_disposition),
          },
        };
        if (totalInputContextTokens !== null
            || contextBehavior === "legacy_zero") {
          usage.totalInputContextTokens = totalInputContextTokens ?? 0;
        }
        if (sourceLocal !== null) usage.sourceLocal = sourceLocal;
        if (sourceOffset !== null) {
          usage.sourceRecordOrdinal = sourceOffset;
          usage.sourceOffset = sourceOffset;
        }
        if (sourceOrdinal !== null) {
          usage.sourceRolloutOrdinal = sourceOrdinal;
          usage.sourceOrdinal = sourceOrdinal;
        }
        if (inWindow && onUsage !== undefined) {
          usage.sequence = sequence++;
          await deliver(onUsage, usage);
        }
        if (inHistory) {
          if (usage.sequence === undefined) usage.sequence = sequence++;
          await deliver(indexedHistory.onUsage, usage);
        }
      }

      const quotaStatement = database.prepare(`
        SELECT q.id, q.observed_at_ms, q.provider, q.limit_id, q.slot,
               q.plan_type, q.used_percent, q.resets_at_ms,
               q.duration_mins, q.source_local, q.source_offset,
               q.source_ordinal, q.slot_order,
               s.surface, s.thread_source, s.agent_scope,
               s.lineage_disposition
        FROM quota_occurrence q
        JOIN surface_class s ON s.id = q.surface_id
        WHERE q.admission = 'admitted'
          AND q.observed_at_ms >= ? AND q.observed_at_ms <= ?
        ORDER BY q.observed_at_ms,
                 q.source_ordinal,
                 q.source_local,
                 q.source_offset,
                 q.slot_order,
                 q.id
      `);
      // Quota rows across the whole scanned range are validated (a separate
      // read of the covered range validated them too); only the requested
      // window's rows are delivered, since the history consumer takes none.
      for (const row of quotaStatement.iterate(scanStartMs, scanEndMs)) {
        throwIfAborted(signal);
        const { observedAtMs, timestamp } = timestampForMs(row.observed_at_ms);
        const durationMins = safeNonNegativeInteger(row.duration_mins);
        const resetsAtMs = safeNonNegativeInteger(row.resets_at_ms, {
          nullable: true,
          nullValue: null,
        });
        if (row.used_percent === null
            || (typeof row.used_percent !== "number"
              && typeof row.used_percent !== "bigint")) {
          throw fixedError("local_unified_index_row_invalid");
        }
        const usedPercent = Number(row.used_percent);
        const slot = safeText(row.slot);
        const sourceLocal = safeDigest(row.source_local);
        const sourceOffset = safeNonNegativeInteger(row.source_offset);
        const sourceOrdinal = safeNonNegativeInteger(row.source_ordinal);
        const slotOrder = safeNonNegativeInteger(row.slot_order);
        if (!isValidQuotaWindowDuration(durationMins)
            || resetsAtMs === null
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
            provider: safeText(row.provider),
            planType: safeText(row.plan_type, { nullable: true }),
            limitId: safeText(row.limit_id),
            slot,
            usedPercent,
            windowDurationMins: durationMins,
            resetsAt: resetsAtMs / 1_000,
          },
          surfaceClassification: {
            surface: safeText(row.surface),
            threadSource: safeText(row.thread_source),
            agentScope: safeText(row.agent_scope),
            lineageDisposition: safeText(row.lineage_disposition),
          },
          sourceRolloutOrdinal: sourceOrdinal,
          sourceRecordOrdinal: sourceOffset,
          sourceLocal,
          sourceOrdinal,
          sourceOffset,
          slotOrder,
        };
        if (onRateLimitSnapshot !== undefined
            && observedAtMs >= startMs && observedAtMs <= endMs) {
          quota.sequence = sequence++;
          await deliver(onRateLimitSnapshot, quota);
        }
      }
      throwIfAborted(signal);
      await revalidatePublishedSnapshot({
        indexFile,
        metadata,
        database,
        coverage,
        requestedWindow: window,
        verifyPublishedGeneration: verifyGeneration,
      });
      if (historyRange !== null) {
        await revalidatePublishedSnapshot({
          indexFile,
          metadata,
          database,
          coverage: historyRead.coverage,
          requestedWindow: {
            startAt: coverage.coveredAt.startAt,
            endAt: coverage.coveredAt.endAt,
          },
          verifyPublishedGeneration: verifyGeneration,
        });
      }
      const capabilities = capabilitiesFor(coverage);
      return {
        ...(historyRead === null ? {} : { indexedHistory: historyRead }),
        readerVersion: LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION,
        schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
        parserVersion: compatibility.parserVersions.length === 1
          ? compatibility.parserVersions[0]
          : null,
        contractVersion,
        compatibility,
        coverage,
        capabilities,
        diagnosticCoverage: coverage.diagnosticsComplete
          ? "complete"
          : "partial",
        diagnosticsAvailable: coverage.diagnosticsComplete,
        diagnostics,
        toolCallsByClass: {},
        toolObservationsBySource: {},
        serverBillableUnits: {},
      };
    } catch (error) {
      if (typeof error?.code === "string"
          && (error.code.startsWith("local_unified_index_")
            || CALLBACK_RESOURCE_CODES.has(error.code)
            || error[ADAPTER_ABORT] === true)) {
        throw error;
      }
      throw fixedError("local_unified_index_read_failed");
    } finally {
      database?.close();
    }
  };
}
