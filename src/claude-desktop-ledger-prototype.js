import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { addUsdStrings } from "@app-usagemonitor/accounting";
import {
  CLAUDE_DESKTOP_ACCOUNTING_VENDOR,
  CLAUDE_DESKTOP_PRODUCT_PROVIDER,
  claudeDesktopWinnerToPricingRecord,
  priceClaudeDesktopWinner,
} from "./claude-desktop-pricing.js";

export const CLAUDE_DESKTOP_LEDGER_PROTOTYPE_VERSION =
  "claude-desktop-ledger-prototype-v0.3";

const PROVIDERS = new Set(["anthropic_claude_code", "openai_codex"]);
const OUTPUT_KINDS = new Set(["provider_reported_combined", "separate_text_reasoning"]);
const CLAUDE_PROVIDER = CLAUDE_DESKTOP_PRODUCT_PROVIDER;
const CLAUDE_BILLING_SURFACE = "claude_subscription";
const CLAUDE_PRICING_PROJECTION_VERSION = "claude-desktop-pricing-projection-v0.1";
const PRICING_OPTION_KEYS = new Set(["priceCards", "region", "priceEpochBasis", "apiServiceTier"]);
const USAGE_CANDIDATE_PRICING_COLUMNS = Object.freeze([
  ["event_time", "TEXT"],
  ["model_declaration_json", "TEXT"],
  ["billing_surface", "TEXT"],
  ["total_input_context_tokens", "INTEGER"],
  ["input_cache_write_5m_tokens", "INTEGER"],
  ["input_cache_write_1h_tokens", "INTEGER"],
]);

export class ClaudeDesktopLedgerPrototypeError extends Error {
  constructor(code) {
    super(`Claude Desktop ledger prototype failed (${code})`);
    this.name = "ClaudeDesktopLedgerPrototypeError";
    this.code = `claude_desktop_ledger_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopLedgerPrototypeError(code);
}

function safeSignal(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object"
      || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function") fail("signal");
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function safeProvider(value) {
  if (!PROVIDERS.has(value)) fail("provider");
  return value;
}

function safeKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("key");
  return value;
}

function safeCount(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("count");
  return value;
}

function safePositiveCount(value) {
  const selected = safeCount(value);
  if (selected < 1) fail("count");
  return selected;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("timestamp");
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function projectProviderOutput({
  provider,
  outputKind,
  outputTextTokens,
  outputReasoningTokens,
  outputCombinedTokens,
}) {
  safeProvider(provider);
  if (!OUTPUT_KINDS.has(outputKind)) fail("output_kind");
  if (outputKind === "provider_reported_combined") {
    if (provider !== "anthropic_claude_code") fail("output_kind");
    const combined = safeCount(outputCombinedTokens);
    if (outputTextTokens !== null || outputReasoningTokens !== null) fail("output_kind");
    return {
      outputTextTokens: combined,
      outputReasoningTokens: 0,
      outputCombinedTokens: combined,
      outputKind,
    };
  }
  const text = safeCount(outputTextTokens);
  const reasoning = safeCount(outputReasoningTokens);
  if (outputCombinedTokens !== null) fail("output_kind");
  return {
    outputTextTokens: text,
    outputReasoningTokens: reasoning,
    outputCombinedTokens: null,
    outputKind,
  };
}

function configure(database) {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_state (
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 1),
      status TEXT NOT NULL CHECK(status IN ('present', 'missing_suspected', 'inaccessible')),
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      PRIMARY KEY(provider, source_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_candidate (
      provider TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_generation INTEGER NOT NULL CHECK(source_generation >= 1),
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      model_key TEXT NOT NULL,
      event_time TEXT,
      model_declaration_json TEXT,
      billing_surface TEXT,
      total_input_context_tokens INTEGER,
      input_uncached_tokens INTEGER NOT NULL CHECK(input_uncached_tokens >= 0),
      input_cache_read_tokens INTEGER NOT NULL CHECK(input_cache_read_tokens >= 0),
      input_cache_write_tokens INTEGER NOT NULL CHECK(input_cache_write_tokens >= 0),
      input_cache_write_5m_tokens INTEGER
        CHECK(input_cache_write_5m_tokens IS NULL OR input_cache_write_5m_tokens >= 0),
      input_cache_write_1h_tokens INTEGER
        CHECK(input_cache_write_1h_tokens IS NULL OR input_cache_write_1h_tokens >= 0),
      output_text_tokens INTEGER CHECK(output_text_tokens IS NULL OR output_text_tokens >= 0),
      output_reasoning_tokens INTEGER CHECK(output_reasoning_tokens IS NULL OR output_reasoning_tokens >= 0),
      output_combined_tokens INTEGER CHECK(output_combined_tokens IS NULL OR output_combined_tokens >= 0),
      output_kind TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
      PRIMARY KEY(provider, candidate_key)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_candidate_logical
      ON usage_candidate(provider, logical_key, output_combined_tokens, observed_at_ms, candidate_key);
    CREATE TABLE IF NOT EXISTS usage_winner (
      provider TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      PRIMARY KEY(provider, logical_key),
      FOREIGN KEY(provider, candidate_key) REFERENCES usage_candidate(provider, candidate_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS quota_revision (
      provider TEXT NOT NULL,
      account_scope TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      meter_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      utilization_percent REAL NOT NULL CHECK(utilization_percent >= 0 AND utilization_percent <= 100),
      resets_at_ms INTEGER CHECK(resets_at_ms IS NULL OR resets_at_ms >= 0),
      source_key TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
      PRIMARY KEY(provider, account_scope, observed_at_ms, meter_id, revision)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS coverage_gap (
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_at_ms INTEGER NOT NULL CHECK(start_at_ms >= 0),
      end_at_ms INTEGER CHECK(end_at_ms IS NULL OR end_at_ms >= start_at_ms),
      PRIMARY KEY(provider, source_key, kind, start_at_ms)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ingest_checkpoint (
      provider TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL,
      source_key TEXT NOT NULL,
      cursor_version TEXT NOT NULL,
      next_byte INTEGER NOT NULL CHECK(next_byte >= 0),
      next_line_ordinal INTEGER NOT NULL CHECK(next_line_ordinal >= 1),
      next_cost_ordinal INTEGER NOT NULL CHECK(next_cost_ordinal >= 0),
      complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      PRIMARY KEY(provider, plan_sha256, source_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS projection_manifest (
      provider TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 1),
      ledger_high_water INTEGER NOT NULL CHECK(ledger_high_water >= 0),
      payload_sha256 TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL CHECK(published_at_ms >= 0),
      PRIMARY KEY(provider, generation)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS projection_row (
      provider TEXT NOT NULL,
      generation INTEGER NOT NULL,
      logical_key TEXT NOT NULL,
      output_text_tokens INTEGER NOT NULL CHECK(output_text_tokens >= 0),
      output_reasoning_tokens INTEGER NOT NULL CHECK(output_reasoning_tokens >= 0),
      output_combined_tokens INTEGER CHECK(output_combined_tokens IS NULL OR output_combined_tokens >= 0),
      output_kind TEXT NOT NULL,
      PRIMARY KEY(provider, generation, logical_key),
      FOREIGN KEY(provider, generation) REFERENCES projection_manifest(provider, generation)
        ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS projection_state (
      provider TEXT PRIMARY KEY,
      current_generation INTEGER NOT NULL CHECK(current_generation >= 1)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS purge_tombstone (
      provider TEXT NOT NULL,
      start_at_ms INTEGER NOT NULL CHECK(start_at_ms >= 0),
      end_at_ms INTEGER NOT NULL CHECK(end_at_ms >= start_at_ms),
      receipt_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      PRIMARY KEY(provider, start_at_ms, end_at_ms, receipt_sha256)
    ) STRICT, WITHOUT ROWID;
  `);
  const usageCandidateColumns = new Set(database.prepare("PRAGMA table_info(usage_candidate)")
    .all().map((row) => row.name));
  for (const [name, type] of USAGE_CANDIDATE_PRICING_COLUMNS) {
    if (!usageCandidateColumns.has(name)) {
      database.exec(`ALTER TABLE usage_candidate ADD COLUMN ${name} ${type}`);
    }
  }
  database.prepare("INSERT OR REPLACE INTO ledger_meta(key, value) VALUES ('schema_version', ?)")
    .run(CLAUDE_DESKTOP_LEDGER_PROTOTYPE_VERSION);
}

function safeNullableCount(value) {
  return value === null ? null : safeCount(value);
}

function safeEventTimeMs(value) {
  if (typeof value !== "string" || value.length > 32) fail("candidate_pricing");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("candidate_pricing");
  }
  return timestamp;
}

function hasClaudePricingInput(candidate) {
  return [
    "eventTime",
    "modelDeclaration",
    "billingSurface",
    "totalInputContextTokens",
    "inputCacheWrite5mTokens",
    "inputCacheWrite1hTokens",
  ].some((key) => Object.hasOwn(candidate, key));
}

function normalizeClaudePricingInput(candidate) {
  // Rows created by the Phase 0 scanner predate this pricing boundary. Keep
  // them for output/count continuity, but mark their pricing inputs absent so
  // reads can report them as unpriced instead of inventing values.
  if (!hasClaudePricingInput(candidate)) {
    return {
      eventTime: null,
      modelDeclaration: null,
      billingSurface: null,
      totalInputContextTokens: null,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
    };
  }
  const winner = {
    provider: candidate.provider,
    eventTime: candidate.eventTime,
    modelDeclaration: candidate.modelDeclaration,
    billingSurface: candidate.billingSurface,
    outputKind: candidate.outputKind,
    totalInputContextTokens: candidate.totalInputContextTokens,
    components: {
      inputUncachedTokens: candidate.inputUncachedTokens,
      inputCacheReadTokens: candidate.inputCacheReadTokens,
      inputCacheWriteTokens: candidate.inputCacheWriteTokens,
      inputCacheWrite5mTokens: candidate.inputCacheWrite5mTokens,
      inputCacheWrite1hTokens: candidate.inputCacheWrite1hTokens,
      outputCombinedTokens: candidate.outputCombinedTokens,
    },
  };
  let record;
  try {
    record = claudeDesktopWinnerToPricingRecord(winner);
  } catch {
    fail("candidate_pricing");
  }
  const eventTimeMs = safeEventTimeMs(record.eventTime);
  if (candidate.observedAtMs !== eventTimeMs) fail("candidate_pricing");
  const declaration = candidate.modelDeclaration;
  return {
    eventTime: record.eventTime,
    modelDeclaration: {
      modelId: declaration.modelId,
      modelRecognition: declaration.modelRecognition,
      modelFingerprint: declaration.modelFingerprint,
    },
    billingSurface: CLAUDE_BILLING_SURFACE,
    totalInputContextTokens: record.totalInputContextTokens,
    inputCacheWrite5mTokens: record.components.inputCacheWrite5mTokens,
    inputCacheWrite1hTokens: record.components.inputCacheWrite1hTokens,
  };
}

function normalizeCandidate(candidate, acceptedAtMs) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("candidate");
  const provider = safeProvider(candidate.provider);
  projectProviderOutput({
    provider,
    outputKind: candidate.outputKind,
    outputTextTokens: candidate.outputTextTokens ?? null,
    outputReasoningTokens: candidate.outputReasoningTokens ?? null,
    outputCombinedTokens: candidate.outputCombinedTokens ?? null,
  });
  if (typeof candidate.parserVersion !== "string" || candidate.parserVersion.length < 1
      || candidate.parserVersion.length > 128) fail("candidate");
  const claudePricing = provider === CLAUDE_PROVIDER
    ? normalizeClaudePricingInput(candidate)
    : {
      eventTime: null,
      modelDeclaration: null,
      billingSurface: null,
      totalInputContextTokens: null,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
    };
  return {
    provider,
    logicalKey: safeKey(candidate.logicalKey),
    candidateKey: safeKey(candidate.candidateKey),
    sourceKey: safeKey(candidate.sourceKey),
    sourceGeneration: safePositiveCount(candidate.sourceGeneration),
    observedAtMs: safeTimestamp(candidate.observedAtMs),
    modelKey: safeKey(candidate.modelKey),
    eventTime: claudePricing.eventTime,
    modelDeclaration: claudePricing.modelDeclaration,
    billingSurface: claudePricing.billingSurface,
    totalInputContextTokens: claudePricing.totalInputContextTokens,
    inputUncachedTokens: safeCount(candidate.inputUncachedTokens),
    inputCacheReadTokens: safeCount(candidate.inputCacheReadTokens),
    inputCacheWriteTokens: safeCount(candidate.inputCacheWriteTokens),
    inputCacheWrite5mTokens: provider === CLAUDE_PROVIDER
      ? safeNullableCount(claudePricing.inputCacheWrite5mTokens) : null,
    inputCacheWrite1hTokens: provider === CLAUDE_PROVIDER
      ? safeNullableCount(claudePricing.inputCacheWrite1hTokens) : null,
    outputTextTokens: candidate.outputTextTokens ?? null,
    outputReasoningTokens: candidate.outputReasoningTokens ?? null,
    outputCombinedTokens: candidate.outputCombinedTokens ?? null,
    outputKind: candidate.outputKind,
    parserVersion: candidate.parserVersion,
    acceptedAtMs: safeTimestamp(acceptedAtMs),
  };
}

function normalizeIngestCheckpoint(value, acceptedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.cursor?.schemaVersion !== "claude-transcript-export-cursor-v0.2"
      || value.cursor.sourceKey !== value.sourceKey
      || !Number.isSafeInteger(value.cursor.nextLineOrdinal)
      || value.cursor.nextLineOrdinal < 1
      || typeof value.complete !== "boolean") fail("checkpoint");
  return {
    provider: safeProvider(value.provider),
    planSha256: safeKey(value.planSha256),
    sourceKey: safeKey(value.sourceKey),
    cursorVersion: value.cursor.schemaVersion,
    nextByte: safeCount(value.cursor.nextByte),
    nextLineOrdinal: value.cursor.nextLineOrdinal,
    nextCostOrdinal: safeCount(value.cursor.nextCostOrdinal),
    complete: value.complete,
    updatedAtMs: safeTimestamp(acceptedAtMs),
  };
}

function checkpointAfter(next, prior) {
  if (!prior) return true;
  if (prior.complete === 1 && !next.complete) return false;
  if (next.nextByte !== prior.next_byte) return next.nextByte > prior.next_byte;
  if (next.nextLineOrdinal !== prior.next_line_ordinal) {
    return next.nextLineOrdinal > prior.next_line_ordinal;
  }
  return next.nextCostOrdinal >= prior.next_cost_ordinal;
}

function betterCandidate(candidate, winner) {
  if (!winner) return true;
  const candidateOutput = candidate.outputCombinedTokens
    ?? (candidate.outputTextTokens + candidate.outputReasoningTokens);
  const winnerOutput = winner.output_combined_tokens
    ?? (winner.output_text_tokens + winner.output_reasoning_tokens);
  if (candidateOutput !== winnerOutput) return candidateOutput > winnerOutput;
  if (candidate.observedAtMs !== winner.observed_at_ms) {
    return candidate.observedAtMs > winner.observed_at_ms;
  }
  return candidate.candidateKey > winner.candidate_key;
}

function storedModelDeclaration(value) {
  if (value === null || value === undefined) return null;
  try {
    const declaration = JSON.parse(value);
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return null;
    return declaration;
  } catch {
    return null;
  }
}

function storedCandidatePayload(row) {
  return {
    logicalKey: row.logical_key,
    sourceKey: row.source_key,
    sourceGeneration: row.source_generation,
    observedAtMs: row.observed_at_ms,
    modelKey: row.model_key,
    eventTime: row.event_time ?? null,
    modelDeclaration: storedModelDeclaration(row.model_declaration_json),
    billingSurface: row.billing_surface ?? null,
    totalInputContextTokens: row.total_input_context_tokens ?? null,
    inputUncachedTokens: row.input_uncached_tokens,
    inputCacheReadTokens: row.input_cache_read_tokens,
    inputCacheWriteTokens: row.input_cache_write_tokens,
    inputCacheWrite5mTokens: row.input_cache_write_5m_tokens ?? null,
    inputCacheWrite1hTokens: row.input_cache_write_1h_tokens ?? null,
    outputTextTokens: row.output_text_tokens,
    outputReasoningTokens: row.output_reasoning_tokens,
    outputCombinedTokens: row.output_combined_tokens,
    outputKind: row.output_kind,
    parserVersion: row.parser_version,
  };
}

function normalizedCandidatePayload(candidate) {
  return {
    logicalKey: candidate.logicalKey,
    sourceKey: candidate.sourceKey,
    sourceGeneration: candidate.sourceGeneration,
    observedAtMs: candidate.observedAtMs,
    modelKey: candidate.modelKey,
    eventTime: candidate.eventTime,
    modelDeclaration: candidate.modelDeclaration,
    billingSurface: candidate.billingSurface,
    totalInputContextTokens: candidate.totalInputContextTokens,
    inputUncachedTokens: candidate.inputUncachedTokens,
    inputCacheReadTokens: candidate.inputCacheReadTokens,
    inputCacheWriteTokens: candidate.inputCacheWriteTokens,
    inputCacheWrite5mTokens: candidate.inputCacheWrite5mTokens,
    inputCacheWrite1hTokens: candidate.inputCacheWrite1hTokens,
    outputTextTokens: candidate.outputTextTokens,
    outputReasoningTokens: candidate.outputReasoningTokens,
    outputCombinedTokens: candidate.outputCombinedTokens,
    outputKind: candidate.outputKind,
    parserVersion: candidate.parserVersion,
  };
}

function normalizeQuotaObservation(value, sourceKey, acceptedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("quota");
  const provider = safeProvider(value.provider);
  if (typeof value.accountScope !== "string" || !/^[a-f0-9]{64}$/u.test(value.accountScope)
      || typeof value.meterId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.meterId)
      || typeof value.utilizationPercent !== "number" || !Number.isFinite(value.utilizationPercent)
      || value.utilizationPercent < 0 || value.utilizationPercent > 100
      || (value.resetsAtMs !== null && (!Number.isSafeInteger(value.resetsAtMs) || value.resetsAtMs < 0))) {
    fail("quota");
  }
  return {
    provider,
    accountScope: value.accountScope,
    observedAtMs: safeTimestamp(value.observedAtMs),
    meterId: value.meterId,
    utilizationPercent: value.utilizationPercent,
    resetsAtMs: value.resetsAtMs,
    sourceKey: safeKey(sourceKey),
    acceptedAtMs: safeTimestamp(acceptedAtMs),
  };
}

function winnerFromStoredRow(row) {
  const modelDeclaration = storedModelDeclaration(row.model_declaration_json);
  if (row.event_time === null || row.event_time === undefined
      || row.billing_surface === null || row.billing_surface === undefined
      || row.total_input_context_tokens === null || row.total_input_context_tokens === undefined
      || modelDeclaration === null) {
    return null;
  }
  return {
    provider: row.provider,
    eventTime: row.event_time,
    modelDeclaration,
    billingSurface: row.billing_surface,
    outputKind: row.output_kind,
    totalInputContextTokens: Number(row.total_input_context_tokens),
    components: {
      inputUncachedTokens: Number(row.input_uncached_tokens),
      inputCacheReadTokens: Number(row.input_cache_read_tokens),
      inputCacheWriteTokens: Number(row.input_cache_write_tokens),
      inputCacheWrite5mTokens: row.input_cache_write_5m_tokens === null
        ? null : Number(row.input_cache_write_5m_tokens),
      inputCacheWrite1hTokens: row.input_cache_write_1h_tokens === null
        ? null : Number(row.input_cache_write_1h_tokens),
      outputCombinedTokens: row.output_combined_tokens === null
        ? null : Number(row.output_combined_tokens),
    },
  };
}

function pricingWarningCodes(pricing) {
  return [...new Set([
    ...(pricing?.warnings?.coverage ?? []).map((warning) => warning.code),
    ...(pricing?.warnings?.informational ?? []).map((warning) => warning.code),
  ])].sort();
}

function coverageStatusFromCounts(counts) {
  if (counts.fullyPriced === 0 && counts.partiallyPriced === 0
      && counts.unpriced === 0) return "unpriced";
  if (counts.unpriced === 0 && counts.partiallyPriced === 0) return "fully_priced";
  if (counts.fullyPriced > 0 || counts.partiallyPriced > 0) return "partially_priced";
  return "unpriced";
}

function pricingProjectionWarning(code) {
  return {
    code,
    message: code === "pricing_inputs_unavailable"
      ? "Claude winner pricing inputs were not retained; the event remains visibly unpriced."
      : "Claude winner pricing inputs failed validation; the event remains visibly unpriced.",
    metadata: {},
  };
}

function validatePricingProjectionOptions(options) {
  for (const key of Object.keys(options)) {
    if (!PRICING_OPTION_KEYS.has(key)) fail("pricing_options");
  }
  if (Object.hasOwn(options, "priceEpochBasis") && options.priceEpochBasis !== "event_time") {
    fail("pricing_options");
  }
  if (Object.hasOwn(options, "apiServiceTier") && options.apiServiceTier !== "standard") {
    fail("pricing_options");
  }
}

export function openClaudeDesktopLedgerPrototype(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("configuration");
  const database = new DatabaseSync(path);
  try {
    configure(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    mergeUsageCandidates(candidates, { acceptedAtMs = Date.now(), checkpoint = null } = {}) {
      if (!Array.isArray(candidates)) fail("candidate");
      const normalized = candidates.map((candidate) => normalizeCandidate(candidate, acceptedAtMs));
      const normalizedCheckpoint = checkpoint === null
        ? null : normalizeIngestCheckpoint(checkpoint, acceptedAtMs);
      if (normalizedCheckpoint && normalized.some((candidate) => (
        candidate.provider !== normalizedCheckpoint.provider
        || candidate.sourceKey !== normalizedCheckpoint.sourceKey
      ))) fail("checkpoint");
      let inserted = 0;
      let superseded = 0;
      let tombstoned = 0;
      const tombstoneStatement = database.prepare(`
        SELECT 1 FROM purge_tombstone
        WHERE provider = ? AND start_at_ms <= ? AND end_at_ms >= ? LIMIT 1
      `);
      const existingCandidateStatement = database.prepare(
        "SELECT * FROM usage_candidate WHERE provider = ? AND candidate_key = ?",
      );
      const insertSourceStatement = database.prepare(`
        INSERT OR IGNORE INTO source_state(
          provider, source_key, generation, status, observed_at_ms
        ) VALUES (?, ?, ?, 'present', ?)
      `);
      const updateSourceStatement = database.prepare(`
        UPDATE source_state SET generation = MAX(generation, ?), status = 'present',
          observed_at_ms = MAX(observed_at_ms, ?)
        WHERE provider = ? AND source_key = ?
      `);
      const closeMissingGapStatement = database.prepare(`
        UPDATE coverage_gap SET end_at_ms = ?
        WHERE provider = ? AND source_key = ?
          AND kind = 'missing_suspected' AND end_at_ms IS NULL
      `);
      const insertCandidateStatement = database.prepare(`
        INSERT OR IGNORE INTO usage_candidate(
          provider, logical_key, candidate_key, source_key, source_generation,
          observed_at_ms, model_key, event_time, model_declaration_json, billing_surface,
          total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
          input_cache_write_tokens, input_cache_write_5m_tokens, input_cache_write_1h_tokens,
          output_text_tokens, output_reasoning_tokens, output_combined_tokens, output_kind,
          parser_version, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const winnerStatement = database.prepare(`
        SELECT c.*, w.revision FROM usage_winner w
        JOIN usage_candidate c ON c.provider = w.provider AND c.candidate_key = w.candidate_key
        WHERE w.provider = ? AND w.logical_key = ?
      `);
      const upsertWinnerStatement = database.prepare(`
        INSERT INTO usage_winner(provider, logical_key, candidate_key, revision, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, logical_key) DO UPDATE SET
          candidate_key = excluded.candidate_key,
          revision = excluded.revision,
          updated_at_ms = excluded.updated_at_ms
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const candidate of normalized) {
          if (tombstoneStatement.get(
            candidate.provider, candidate.observedAtMs, candidate.observedAtMs,
          )) {
            tombstoned += 1;
            continue;
          }
          const existingCandidate = existingCandidateStatement.get(
            candidate.provider, candidate.candidateKey,
          );
          if (existingCandidate && stableJson(storedCandidatePayload(existingCandidate))
              !== stableJson(normalizedCandidatePayload(candidate))) {
            fail("candidate_conflict");
          }
          insertSourceStatement.run(
            candidate.provider,
            candidate.sourceKey,
            candidate.sourceGeneration,
            candidate.observedAtMs,
          );
          updateSourceStatement.run(
            candidate.sourceGeneration,
            candidate.observedAtMs,
            candidate.provider,
            candidate.sourceKey,
          );
          closeMissingGapStatement.run(
            candidate.acceptedAtMs,
            candidate.provider,
            candidate.sourceKey,
          );
          const result = insertCandidateStatement.run(
            candidate.provider,
            candidate.logicalKey,
            candidate.candidateKey,
            candidate.sourceKey,
            candidate.sourceGeneration,
            candidate.observedAtMs,
            candidate.modelKey,
            candidate.eventTime,
            candidate.modelDeclaration === null ? null : stableJson(candidate.modelDeclaration),
            candidate.billingSurface,
            candidate.totalInputContextTokens,
            candidate.inputUncachedTokens,
            candidate.inputCacheReadTokens,
            candidate.inputCacheWriteTokens,
            candidate.inputCacheWrite5mTokens,
            candidate.inputCacheWrite1hTokens,
            candidate.outputTextTokens,
            candidate.outputReasoningTokens,
            candidate.outputCombinedTokens,
            candidate.outputKind,
            candidate.parserVersion,
            candidate.acceptedAtMs,
          );
          inserted += Number(result.changes);
          const winner = winnerStatement.get(candidate.provider, candidate.logicalKey) ?? null;
          if (betterCandidate(candidate, winner)) {
            const nextRevision = (winner?.revision ?? 0) + 1;
            upsertWinnerStatement.run(
              candidate.provider,
              candidate.logicalKey,
              candidate.candidateKey,
              nextRevision,
              candidate.acceptedAtMs,
            );
            if (winner) superseded += 1;
          }
        }
        if (normalizedCheckpoint) {
          const prior = database.prepare(`
            SELECT * FROM ingest_checkpoint
            WHERE provider = ? AND plan_sha256 = ? AND source_key = ?
          `).get(
            normalizedCheckpoint.provider,
            normalizedCheckpoint.planSha256,
            normalizedCheckpoint.sourceKey,
          );
          if (!checkpointAfter(normalizedCheckpoint, prior)) fail("checkpoint_regression");
          database.prepare(`
            INSERT INTO ingest_checkpoint(
              provider, plan_sha256, source_key, cursor_version, next_byte,
              next_line_ordinal, next_cost_ordinal, complete, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, plan_sha256, source_key) DO UPDATE SET
              cursor_version = excluded.cursor_version,
              next_byte = excluded.next_byte,
              next_line_ordinal = excluded.next_line_ordinal,
              next_cost_ordinal = excluded.next_cost_ordinal,
              complete = excluded.complete,
              updated_at_ms = excluded.updated_at_ms
          `).run(
            normalizedCheckpoint.provider,
            normalizedCheckpoint.planSha256,
            normalizedCheckpoint.sourceKey,
            normalizedCheckpoint.cursorVersion,
            normalizedCheckpoint.nextByte,
            normalizedCheckpoint.nextLineOrdinal,
            normalizedCheckpoint.nextCostOrdinal,
            normalizedCheckpoint.complete ? 1 : 0,
            normalizedCheckpoint.updatedAtMs,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { inserted, superseded, tombstoned };
    },

    readIngestCheckpoint(providerValue, planSha256, sourceKey) {
      const provider = safeProvider(providerValue);
      const plan = safeKey(planSha256);
      const source = safeKey(sourceKey);
      const row = database.prepare(`
        SELECT cursor_version, next_byte, next_line_ordinal, next_cost_ordinal, complete
        FROM ingest_checkpoint WHERE provider = ? AND plan_sha256 = ? AND source_key = ?
      `).get(provider, plan, source);
      if (!row) return null;
      return {
        cursor: {
          schemaVersion: row.cursor_version,
          sourceKey: source,
          nextByte: Number(row.next_byte),
          nextLineOrdinal: Number(row.next_line_ordinal),
          nextCostOrdinal: Number(row.next_cost_ordinal),
        },
        complete: row.complete === 1,
      };
    },

    markSourcesMissing(providerValue, sourceKeys, { observedAtMs = Date.now(), kind = "missing_suspected" } = {}) {
      const provider = safeProvider(providerValue);
      if (!Array.isArray(sourceKeys) || !/^[a-z_]{1,64}$/u.test(kind)) fail("source");
      const timestamp = safeTimestamp(observedAtMs);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const sourceKey of sourceKeys.map(safeKey)) {
          database.prepare(`
            UPDATE source_state SET status = 'missing_suspected', observed_at_ms = ?
            WHERE provider = ? AND source_key = ?
          `).run(timestamp, provider, sourceKey);
          database.prepare(`
            INSERT INTO coverage_gap(provider, source_key, kind, start_at_ms, end_at_ms)
            SELECT ?, ?, ?, ?, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM coverage_gap
              WHERE provider = ? AND source_key = ? AND kind = ? AND end_at_ms IS NULL
            )
          `).run(
            provider, sourceKey, kind, timestamp,
            provider, sourceKey, kind,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    markSourcesObserved(providerValue, sources, { observedAtMs = Date.now() } = {}) {
      const provider = safeProvider(providerValue);
      if (!Array.isArray(sources)) fail("source");
      const timestamp = safeTimestamp(observedAtMs);
      const normalized = sources.map((source) => {
        if (!source || typeof source !== "object" || Array.isArray(source)
            || Object.keys(source).length !== 2
            || !Object.hasOwn(source, "sourceKey")
            || !Object.hasOwn(source, "sourceGeneration")) fail("source");
        return {
          sourceKey: safeKey(source.sourceKey),
          sourceGeneration: safePositiveCount(source.sourceGeneration),
        };
      });
      let gapsClosed = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        const upsert = database.prepare(`
          INSERT INTO source_state(
            provider, source_key, generation, status, observed_at_ms
          ) VALUES (?, ?, ?, 'present', ?)
          ON CONFLICT(provider, source_key) DO UPDATE SET
            generation = MAX(generation, excluded.generation),
            status = 'present',
            observed_at_ms = MAX(observed_at_ms, excluded.observed_at_ms)
        `);
        const closeGap = database.prepare(`
          UPDATE coverage_gap SET end_at_ms = ?
          WHERE provider = ? AND source_key = ?
            AND kind = 'missing_suspected' AND end_at_ms IS NULL
        `);
        for (const source of normalized) {
          upsert.run(provider, source.sourceKey, source.sourceGeneration, timestamp);
          gapsClosed += Number(closeGap.run(
            timestamp,
            provider,
            source.sourceKey,
          ).changes);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { observed: normalized.length, gapsClosed };
    },

    mergeQuotaObservations(observations, {
      sourceKey,
      acceptedAtMs = Date.now(),
    } = {}) {
      if (!Array.isArray(observations)) fail("quota");
      const normalized = observations.map((item) => (
        normalizeQuotaObservation(item, sourceKey, acceptedAtMs)
      ));
      let inserted = 0;
      let duplicates = 0;
      let tombstoned = 0;
      const tombstoneStatement = database.prepare(`
        SELECT 1 FROM purge_tombstone
        WHERE provider = ? AND start_at_ms <= ? AND end_at_ms >= ? LIMIT 1
      `);
      const duplicateStatement = database.prepare(`
        SELECT 1 FROM quota_revision
        WHERE provider = ? AND account_scope = ? AND observed_at_ms = ? AND meter_id = ?
          AND utilization_percent = ? AND resets_at_ms IS ?
        LIMIT 1
      `);
      const revisionStatement = database.prepare(`
        SELECT MAX(revision) AS revision FROM quota_revision
        WHERE provider = ? AND account_scope = ? AND observed_at_ms = ? AND meter_id = ?
      `);
      const insertQuotaStatement = database.prepare(`
        INSERT INTO quota_revision(
          provider, account_scope, observed_at_ms, meter_id, revision,
          utilization_percent, resets_at_ms, source_key, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const item of normalized) {
          if (tombstoneStatement.get(item.provider, item.observedAtMs, item.observedAtMs)) {
            tombstoned += 1;
            continue;
          }
          const duplicate = duplicateStatement.get(
            item.provider,
            item.accountScope,
            item.observedAtMs,
            item.meterId,
            item.utilizationPercent,
            item.resetsAtMs,
          );
          if (duplicate) {
            duplicates += 1;
            continue;
          }
          const row = revisionStatement.get(
            item.provider, item.accountScope, item.observedAtMs, item.meterId,
          );
          const revision = Number(row?.revision ?? 0) + 1;
          insertQuotaStatement.run(
            item.provider,
            item.accountScope,
            item.observedAtMs,
            item.meterId,
            revision,
            item.utilizationPercent,
            item.resetsAtMs,
            item.sourceKey,
            item.acceptedAtMs,
          );
          inserted += 1;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { inserted, duplicates, tombstoned };
    },

    publishProjection(providerValue, {
      publishedAtMs = Date.now(),
      simulateFailure = false,
      signal = null,
    } = {}) {
      const provider = safeProvider(providerValue);
      const selectedSignal = safeSignal(signal);
      throwIfAborted(selectedSignal);
      const timestamp = safeTimestamp(publishedAtMs);
      const current = database.prepare(
        "SELECT current_generation FROM projection_state WHERE provider = ?",
      ).get(provider);
      const generation = Number(current?.current_generation ?? 0) + 1;
      const winnerCandidates = database.prepare(`
        SELECT c.* FROM usage_winner w
        JOIN usage_candidate c ON c.provider = w.provider AND c.candidate_key = w.candidate_key
        WHERE w.provider = ? ORDER BY w.logical_key
      `);
      const highWater = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM usage_candidate WHERE provider = ?
      `).get(provider).count);
      const insertProjectionRowStatement = database.prepare(`
        INSERT INTO projection_row(
          provider, generation, logical_key, output_text_tokens,
          output_reasoning_tokens, output_combined_tokens, output_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const updateManifestDigestStatement = database.prepare(`
        UPDATE projection_manifest SET payload_sha256 = ?
        WHERE provider = ? AND generation = ?
      `);
      let payloadSha256;
      let rowCount = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        // The manifest must exist before projection rows because of their
        // foreign key. Its digest is replaced inside this same transaction
        // after the ordered array has been streamed exactly.
        database.prepare(`
          INSERT INTO projection_manifest(
            provider, generation, ledger_high_water, payload_sha256, published_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `).run(provider, generation, highWater, "0".repeat(64), timestamp);
        const payloadDigest = createHash("sha256");
        payloadDigest.update("[");
        for (const candidate of winnerCandidates.iterate(provider)) {
          if ((rowCount & 255) === 0) throwIfAborted(selectedSignal);
          const row = {
            logicalKey: candidate.logical_key,
            ...projectProviderOutput({
              provider,
              outputKind: candidate.output_kind,
              outputTextTokens: candidate.output_text_tokens,
              outputReasoningTokens: candidate.output_reasoning_tokens,
              outputCombinedTokens: candidate.output_combined_tokens,
            }),
          };
          if (rowCount > 0) payloadDigest.update(",");
          payloadDigest.update(stableJson(row));
          insertProjectionRowStatement.run(
            provider,
            generation,
            row.logicalKey,
            row.outputTextTokens,
            row.outputReasoningTokens,
            row.outputCombinedTokens,
            row.outputKind,
          );
          rowCount += 1;
        }
        payloadDigest.update("]");
        payloadSha256 = payloadDigest.digest("hex");
        updateManifestDigestStatement.run(payloadSha256, provider, generation);
        if (simulateFailure) throw new ClaudeDesktopLedgerPrototypeError("projection_failed");
        database.prepare(`
          INSERT INTO projection_state(provider, current_generation) VALUES (?, ?)
          ON CONFLICT(provider) DO UPDATE SET current_generation = excluded.current_generation
        `).run(provider, generation);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { provider, generation, highWater, payloadSha256, rowCount };
    },

    readPricingProjection(providerValue = CLAUDE_PROVIDER, options = {}) {
      const provider = safeProvider(providerValue);
      if (provider !== CLAUDE_PROVIDER) fail("pricing_provider");
      if (!options || typeof options !== "object" || Array.isArray(options)) fail("pricing_options");
      validatePricingProjectionOptions(options);
      const current = database.prepare(
        "SELECT current_generation FROM projection_state WHERE provider = ?",
      ).get(provider);
      const generation = current ? Number(current.current_generation) : null;
      const winnerRows = database.prepare(`
        SELECT c.*, w.revision
        FROM usage_winner w
        JOIN usage_candidate c
          ON c.provider = w.provider AND c.candidate_key = w.candidate_key
        WHERE w.provider = ? ORDER BY w.logical_key
      `).all(provider);
      const coverageCounts = {
        fullyPriced: 0,
        partiallyPriced: 0,
        unpriced: 0,
      };
      const warningMap = new Map();
      let totalUsd = "0";
      const rows = winnerRows.map((row) => {
        const winner = winnerFromStoredRow(row);
        let projection = null;
        let reasonCodes;
        if (winner) {
          try {
            projection = priceClaudeDesktopWinner(winner, options);
          } catch {
            reasonCodes = ["pricing_input_invalid"];
          }
        } else {
          reasonCodes = ["pricing_inputs_unavailable"];
        }
        const pricingCoverageStatus = projection?.pricing?.coverageStatus ?? "unpriced";
        if (pricingCoverageStatus === "fully_priced") coverageCounts.fullyPriced += 1;
        else if (pricingCoverageStatus === "partially_priced") coverageCounts.partiallyPriced += 1;
        else coverageCounts.unpriced += 1;
        if (projection) {
          totalUsd = addUsdStrings(totalUsd, projection.pricing.totalUsd);
          reasonCodes = pricingWarningCodes(projection.pricing);
          for (const warning of [
            ...(projection.pricing.warnings?.coverage ?? []),
            ...(projection.pricing.warnings?.informational ?? []),
          ]) {
            warningMap.set(warning.code, warning);
          }
        } else {
          for (const code of reasonCodes) warningMap.set(code, pricingProjectionWarning(code));
        }
        return {
          logicalKey: row.logical_key,
          candidateKey: row.candidate_key,
          revision: Number(row.revision),
          eventTime: row.event_time ?? null,
          pricingCoverageStatus,
          reasonCodes,
          pricing: projection?.pricing ?? null,
          projection,
        };
      });
      const warnings = [...warningMap.values()].sort((left, right) => left.code.localeCompare(right.code));
      const projection = {
        schemaVersion: CLAUDE_PRICING_PROJECTION_VERSION,
        provider,
        productProvider: provider,
        accountingVendor: CLAUDE_DESKTOP_ACCOUNTING_VENDOR,
        // This generation belongs to the ordinary usage projection. Pricing
        // can change when its current winner changes before that projection is
        // republished, so cache consumers must bind the digest below instead.
        usageProjectionGeneration: generation,
        eventCount: rows.length,
        totalUsd,
        coverageStatus: coverageStatusFromCounts(coverageCounts),
        coverageCounts,
        rows,
        warnings: { coverage: warnings, informational: [] },
      };
      return {
        ...projection,
        payloadSha256: sha256(stableJson(projection)),
      };
    },

    /**
     * Read the bounded, cacheable pricing projection without materializing a
     * row-rich array. Each winner is priced one at a time and contributes to
     * an ordered digest; only aggregate coverage and warning codes are
     * retained. The debug/readability projection above remains available for
     * small local fixtures, but callers that persist a projection should use
     * this streaming summary.
     */
    readPricingSummary(
      providerValue = CLAUDE_PROVIDER,
      options = {},
      { signal = null } = {},
    ) {
      const provider = safeProvider(providerValue);
      const selectedSignal = safeSignal(signal);
      throwIfAborted(selectedSignal);
      if (provider !== CLAUDE_PROVIDER) fail("pricing_provider");
      if (!options || typeof options !== "object" || Array.isArray(options)) fail("pricing_options");
      validatePricingProjectionOptions(options);
      const current = database.prepare(
        "SELECT current_generation FROM projection_state WHERE provider = ?",
      ).get(provider);
      const generation = current ? Number(current.current_generation) : null;
      const coverageCounts = {
        fullyPriced: 0,
        partiallyPriced: 0,
        unpriced: 0,
      };
      const warningCodes = new Set();
      const rowDigest = createHash("sha256");
      let eventCount = 0;
      let totalUsd = "0";
      const winnerRows = database.prepare(`
        SELECT c.*, w.revision
        FROM usage_winner w
        JOIN usage_candidate c
          ON c.provider = w.provider AND c.candidate_key = w.candidate_key
        WHERE w.provider = ? ORDER BY w.logical_key
      `);
      for (const row of winnerRows.iterate(provider)) {
        if ((eventCount & 255) === 0) throwIfAborted(selectedSignal);
        eventCount += 1;
        const winner = winnerFromStoredRow(row);
        let projection = null;
        let reasonCodes;
        if (winner) {
          try {
            projection = priceClaudeDesktopWinner(winner, options);
          } catch {
            reasonCodes = ["pricing_input_invalid"];
          }
        } else {
          reasonCodes = ["pricing_inputs_unavailable"];
        }
        const pricingCoverageStatus = projection?.pricing?.coverageStatus ?? "unpriced";
        if (pricingCoverageStatus === "fully_priced") coverageCounts.fullyPriced += 1;
        else if (pricingCoverageStatus === "partially_priced") coverageCounts.partiallyPriced += 1;
        else coverageCounts.unpriced += 1;
        if (projection) {
          totalUsd = addUsdStrings(totalUsd, projection.pricing.totalUsd);
          reasonCodes = pricingWarningCodes(projection.pricing);
          for (const warning of [
            ...(projection.pricing.warnings?.coverage ?? []),
            ...(projection.pricing.warnings?.informational ?? []),
          ]) warningCodes.add(warning.code);
          // The full pricing object is used only for this one-row digest and
          // is immediately eligible for collection; it is never returned or
          // persisted by the summary path.
        } else {
          for (const code of reasonCodes) warningCodes.add(code);
        }
        rowDigest.update(stableJson({
          logicalKey: row.logical_key,
          candidateKey: row.candidate_key,
          revision: Number(row.revision),
          eventTime: row.event_time ?? null,
          pricingCoverageStatus,
          reasonCodes,
          pricing: projection?.pricing ?? null,
        }));
        rowDigest.update("\n");
      }
      const summary = {
        schemaVersion: "claude-desktop-pricing-summary-v0.1",
        provider,
        productProvider: provider,
        accountingVendor: CLAUDE_DESKTOP_ACCOUNTING_VENDOR,
        usageProjectionGeneration: generation,
        eventCount,
        totalUsd,
        coverageStatus: coverageStatusFromCounts(coverageCounts),
        coverageCounts,
        warningCodes: [...warningCodes].sort(),
        pricingDigest: rowDigest.digest("hex"),
      };
      return {
        ...summary,
        payloadSha256: sha256(stableJson(summary)),
      };
    },

    purge(providerValue, {
      startAtMs = 0,
      endAtMs = Number.MAX_SAFE_INTEGER,
      createdAtMs = Date.now(),
    } = {}) {
      const provider = safeProvider(providerValue);
      const start = safeTimestamp(startAtMs);
      const end = safeTimestamp(endAtMs);
      const created = safeTimestamp(createdAtMs);
      if (end < start) fail("purge");
      const receiptSha256 = sha256(stableJson({ provider, startAtMs: start, endAtMs: end, createdAtMs: created }));
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT OR IGNORE INTO purge_tombstone(
            provider, start_at_ms, end_at_ms, receipt_sha256, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `).run(provider, start, end, receiptSha256, created);
        const priorWinners = new Map(database.prepare(`
          SELECT logical_key, candidate_key, revision, updated_at_ms
          FROM usage_winner WHERE provider = ?
        `).all(provider).map((row) => [row.logical_key, row]));
        database.prepare(`
          DELETE FROM usage_winner WHERE provider = ? AND candidate_key IN (
            SELECT candidate_key FROM usage_candidate
            WHERE provider = ? AND observed_at_ms BETWEEN ? AND ?
          )
        `).run(provider, provider, start, end);
        const usageDeleted = Number(database.prepare(`
          DELETE FROM usage_candidate
          WHERE provider = ? AND observed_at_ms BETWEEN ? AND ?
        `).run(provider, start, end).changes);
        const quotaDeleted = Number(database.prepare(`
          DELETE FROM quota_revision
          WHERE provider = ? AND observed_at_ms BETWEEN ? AND ?
        `).run(provider, start, end).changes);
        database.prepare("DELETE FROM usage_winner WHERE provider = ?").run(provider);
        const logicalKeys = database.prepare(`
          SELECT DISTINCT logical_key FROM usage_candidate WHERE provider = ? ORDER BY logical_key
        `).all(provider);
        for (const { logical_key: logicalKey } of logicalKeys) {
          const candidate = database.prepare(`
            SELECT * FROM usage_candidate WHERE provider = ? AND logical_key = ?
            ORDER BY COALESCE(output_combined_tokens, output_text_tokens + output_reasoning_tokens) DESC,
                     observed_at_ms DESC, candidate_key DESC LIMIT 1
          `).get(provider, logicalKey);
          const priorWinner = priorWinners.get(logicalKey);
          const winnerUnchanged = priorWinner?.candidate_key === candidate.candidate_key;
          const revision = winnerUnchanged
            ? Number(priorWinner.revision)
            : Number(priorWinner?.revision ?? 0) + 1;
          const updatedAt = winnerUnchanged
            ? Number(priorWinner.updated_at_ms)
            : created;
          database.prepare(`
            INSERT INTO usage_winner(provider, logical_key, candidate_key, revision, updated_at_ms)
            VALUES (?, ?, ?, ?, ?)
          `).run(provider, logicalKey, candidate.candidate_key, revision, updatedAt);
        }
        database.prepare("DELETE FROM projection_manifest WHERE provider = ?").run(provider);
        database.prepare("DELETE FROM projection_state WHERE provider = ?").run(provider);
        const intersectingGaps = database.prepare(`
          SELECT source_key, kind, start_at_ms, end_at_ms
          FROM coverage_gap WHERE provider = ?
            AND start_at_ms <= ? AND COALESCE(end_at_ms, ?) >= ?
          ORDER BY source_key, kind, start_at_ms
        `).all(provider, end, Number.MAX_SAFE_INTEGER, start);
        const deleteGap = database.prepare(`
          DELETE FROM coverage_gap
          WHERE provider = ? AND source_key = ? AND kind = ? AND start_at_ms = ?
        `);
        const insertGap = database.prepare(`
          INSERT INTO coverage_gap(provider, source_key, kind, start_at_ms, end_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const gap of intersectingGaps) {
          const gapStart = Number(gap.start_at_ms);
          const gapEnd = gap.end_at_ms === null ? null : Number(gap.end_at_ms);
          deleteGap.run(provider, gap.source_key, gap.kind, gapStart);
          if (gapStart < start) {
            insertGap.run(provider, gap.source_key, gap.kind, gapStart, start - 1);
          }
          if (end < Number.MAX_SAFE_INTEGER && (gapEnd === null || gapEnd > end)) {
            insertGap.run(provider, gap.source_key, gap.kind, end + 1, gapEnd);
          }
        }
        if (start === 0 && end === Number.MAX_SAFE_INTEGER) {
          database.prepare("DELETE FROM source_state WHERE provider = ?").run(provider);
          database.prepare("DELETE FROM ingest_checkpoint WHERE provider = ?").run(provider);
        }
        database.exec("COMMIT");
        return { provider, startAtMs: start, endAtMs: end, usageDeleted, quotaDeleted, receiptSha256 };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    readCoverageGaps(providerValue) {
      const provider = safeProvider(providerValue);
      return database.prepare(`
        SELECT source_key AS sourceKey, kind,
               start_at_ms AS startAtMs, end_at_ms AS endAtMs
        FROM coverage_gap WHERE provider = ?
        ORDER BY source_key, kind, start_at_ms
      `).all(provider).map((row) => ({
        sourceKey: row.sourceKey,
        kind: row.kind,
        startAtMs: Number(row.startAtMs),
        endAtMs: row.endAtMs === null ? null : Number(row.endAtMs),
      }));
    },

    readWinnerProvenance(providerValue) {
      const provider = safeProvider(providerValue);
      return database.prepare(`
        SELECT logical_key AS logicalKey, candidate_key AS candidateKey,
               revision, updated_at_ms AS updatedAtMs
        FROM usage_winner WHERE provider = ? ORDER BY logical_key
      `).all(provider).map((row) => ({
        logicalKey: row.logicalKey,
        candidateKey: row.candidateKey,
        revision: Number(row.revision),
        updatedAtMs: Number(row.updatedAtMs),
      }));
    },

    providerSnapshot(providerValue) {
      const provider = safeProvider(providerValue);
      const current = database.prepare(
        "SELECT current_generation FROM projection_state WHERE provider = ?",
      ).get(provider);
      const generation = current ? Number(current.current_generation) : null;
      const rows = generation === null ? [] : database.prepare(`
        SELECT logical_key AS logicalKey,
               output_text_tokens AS outputTextTokens,
               output_reasoning_tokens AS outputReasoningTokens,
               output_combined_tokens AS outputCombinedTokens,
               output_kind AS outputKind
        FROM projection_row WHERE provider = ? AND generation = ? ORDER BY logical_key
      `).all(provider, generation);
      const value = {
        provider,
        generation,
        rows,
        candidateCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM usage_candidate WHERE provider = ?",
        ).get(provider).count),
        winnerCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM usage_winner WHERE provider = ?",
        ).get(provider).count),
        quotaRevisionCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM quota_revision WHERE provider = ?",
        ).get(provider).count),
        coverageGapCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM coverage_gap WHERE provider = ?",
        ).get(provider).count),
        openCoverageGapCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM coverage_gap WHERE provider = ? AND end_at_ms IS NULL",
        ).get(provider).count),
      };
      return { ...value, snapshotSha256: sha256(stableJson(value)) };
    },

    providerSummary(providerValue) {
      const provider = safeProvider(providerValue);
      const current = database.prepare(`
        SELECT s.current_generation, m.payload_sha256
        FROM projection_state s
        JOIN projection_manifest m
          ON m.provider = s.provider AND m.generation = s.current_generation
        WHERE s.provider = ?
      `).get(provider);
      return {
        provider,
        generation: current ? Number(current.current_generation) : null,
        projectionPayloadSha256: current?.payload_sha256 ?? null,
        candidateCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM usage_candidate WHERE provider = ?",
        ).get(provider).count),
        winnerCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM usage_winner WHERE provider = ?",
        ).get(provider).count),
        quotaRevisionCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM quota_revision WHERE provider = ?",
        ).get(provider).count),
        coverageGapCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM coverage_gap WHERE provider = ?",
        ).get(provider).count),
        openCoverageGapCount: Number(database.prepare(
          "SELECT COUNT(*) AS count FROM coverage_gap WHERE provider = ? AND end_at_ms IS NULL",
        ).get(provider).count),
      };
    },

    close() {
      database.close();
    },
  };
}
