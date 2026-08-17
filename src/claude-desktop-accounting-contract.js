/**
 * Closed, provider-specific accounting semantics for the Claude Desktop
 * preparation lane.
 *
 * This module is intentionally a pure boundary.  It does not read Claude
 * files, persist state, expose a route, or price a raw transcript.  Callers
 * must first supply privacy-minimized facts and receive a closed projection
 * whose keys and values are deliberately finite.  In particular, this
 * contract never accepts a path, prompt, session identifier, raw account
 * identifier, or arbitrary metadata field.
 */

export const CLAUDE_DESKTOP_ACCOUNTING_CONTRACT_VERSION =
  "claude-desktop-accounting-contract-v0.1";

export const CLAUDE_DESKTOP_PRODUCT_PROVIDER = "anthropic_claude_code";
export const CLAUDE_DESKTOP_DEFAULT_SOURCE_RETENTION_DAYS = 30;
export const CLAUDE_DESKTOP_CONFIGURED_SOURCE_RETENTION_DAYS = 90;

const CAPTURE_STATUS = new Set(["enabled", "disabled"]);
const CAPTURE_START_BASIS = new Set([
  "first_enabled_refresh",
  "first_forward_event",
  "not_started",
]);
const SOURCE_LIFECYCLE = new Set([
  "present",
  "missing_suspected",
  "inaccessible",
  "cleanup_paused",
  "aggregate_only",
]);
const SOURCE_CLEANUP_STATE = new Set(["not_observed", "provider_cleanup"]);
const SOURCE_CLEANUP_EVIDENCE = new Set([
  "none",
  "cleanup_marker_advanced",
  "provider_runtime_observed",
]);
const PURGE_STATE = new Set(["not_purged", "user_purged"]);
const ATTRIBUTION_STATUS = new Set(["attributed", "unattributed"]);
const RETENTION_BASIS = new Set([
  "provider_default",
  "provider_configured",
  "unknown",
]);
const GAP_REASONS = new Set([
  "before_capture",
  "app_off",
  "source_cleanup",
  "source_inaccessible",
  "user_purge",
]);
const PRICING_STATUS = new Set(["fully_priced", "partially_priced", "unpriced"]);
const MODEL_RECOGNITION = new Set(["recognized", "missing", "unrecognized"]);
const PRICING_BASIS = "api_price_equivalent";
const PRICING_REASON_CODES = new Set([
  "unknown_model",
  "pricing_inputs_unavailable",
  "historical_price_missing",
  "component_price_missing",
  "cache_ttl_split_missing",
  "anthropic_cache_write_ttl_split_missing",
  "component_observation_unavailable",
  "pricing_input_invalid",
]);
const OPAQUE_ACCOUNT_SCOPE = /^account-scope:v1:[a-f0-9]{64}$/u;
const MAX_GAPS = 4_096;

const CAPTURE_KEYS = Object.freeze(["status", "startedAt", "startBasis"]);
const GAP_KEYS = Object.freeze(["startAt", "endAt", "reason"]);
const SOURCE_KEYS = Object.freeze([
  "lifecycle",
  "cleanupState",
  "cleanupEvidence",
  "purgeState",
]);
const ATTRIBUTION_KEYS = Object.freeze(["status", "accountScope"]);
const RETENTION_KEYS = Object.freeze([
  "sourceHorizonDays",
  "sourceHorizonBasis",
  "ledgerHorizon",
  "restoresDeletedHistory",
]);
const PRICING_KEYS = Object.freeze([
  "status",
  "modelRecognition",
  "pricedComponents",
  "unpricedComponents",
  "unavailableComponents",
  "reasonCodes",
  "basis",
]);
const OUTPUT_KEYS = Object.freeze(["outputKind", "outputCombinedTokens"]);
const CONTRACT_KEYS = Object.freeze([
  "capture",
  "source",
  "attribution",
  "retention",
  "pricing",
  "output",
  "gaps",
]);

export class ClaudeDesktopAccountingContractError extends Error {
  constructor(code) {
    super(`Claude Desktop accounting contract failed (${code})`);
    this.name = "ClaudeDesktopAccountingContractError";
    this.code = `claude_desktop_accounting_contract_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopAccountingContractError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length
      || actual.some((key) => typeof key !== "string" || !expected.includes(key))) {
    fail(code);
  }
  return value;
}

function canonicalInstant(value, code) {
  if (typeof value !== "string" || value.length > 32) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code);
  }
  return value;
}

function safeCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function normalizedCapture(value) {
  hasExactKeys(value, CAPTURE_KEYS, "capture_shape");
  if (!CAPTURE_STATUS.has(value.status) || !CAPTURE_START_BASIS.has(value.startBasis)) {
    fail("capture_state");
  }
  if (value.status === "disabled") {
    if (value.startedAt !== null || value.startBasis !== "not_started") {
      fail("capture_disabled_state");
    }
  } else {
    if (value.startedAt === null || value.startBasis === "not_started") {
      fail("capture_started_state");
    }
    canonicalInstant(value.startedAt, "capture_start");
  }
  return {
    status: value.status,
    startedAt: value.startedAt,
    startBasis: value.startBasis,
    historyBeforeStart: "unavailable",
  };
}

function normalizedGap(value) {
  hasExactKeys(value, GAP_KEYS, "gap_shape");
  if (!GAP_REASONS.has(value.reason)) fail("gap_reason");
  const startAt = canonicalInstant(value.startAt, "gap_start");
  const endAt = value.endAt === null ? null : canonicalInstant(value.endAt, "gap_end");
  if (endAt !== null && Date.parse(endAt) < Date.parse(startAt)) fail("gap_interval");
  // A pre-capture interval ends when the first capture starts; a purge is an
  // explicit finite user action. Open-ended gaps remain valid for app-off or
  // source-health failures that have not yet recovered.
  if ((value.reason === "before_capture" || value.reason === "user_purge") && endAt === null) {
    fail("gap_interval");
  }
  return {
    startAt,
    endAt,
    reason: value.reason,
    availability: value.reason === "user_purge" ? "purged" : "unavailable",
  };
}

function normalizedGaps(value) {
  if (!Array.isArray(value) || value.length > MAX_GAPS) fail("gaps");
  const rows = value.map(normalizedGap);
  for (let index = 1; index < rows.length; index += 1) {
    if (Date.parse(rows[index - 1].startAt) > Date.parse(rows[index].startAt)) {
      fail("gap_order");
    }
  }
  return rows;
}

function normalizedSource(value) {
  hasExactKeys(value, SOURCE_KEYS, "source_shape");
  if (!SOURCE_LIFECYCLE.has(value.lifecycle)
      || !SOURCE_CLEANUP_STATE.has(value.cleanupState)
      || !SOURCE_CLEANUP_EVIDENCE.has(value.cleanupEvidence)
      || !PURGE_STATE.has(value.purgeState)) {
    fail("source_state");
  }
  if (value.cleanupState === "provider_cleanup" && value.lifecycle !== "missing_suspected") {
    fail("source_cleanup_state");
  }
  if (value.cleanupState === "provider_cleanup" && value.cleanupEvidence === "none") {
    fail("source_cleanup_evidence");
  }
  if (value.cleanupState === "not_observed" && value.cleanupEvidence !== "none") {
    fail("source_cleanup_evidence");
  }
  return {
    lifecycle: value.lifecycle,
    cleanupState: value.cleanupState,
    cleanupEvidence: value.cleanupEvidence,
    purgeState: value.purgeState,
  };
}

function normalizedAttribution(value) {
  hasExactKeys(value, ATTRIBUTION_KEYS, "attribution_shape");
  if (!ATTRIBUTION_STATUS.has(value.status)) fail("attribution_status");
  if (value.status === "attributed") {
    if (typeof value.accountScope !== "string" || !OPAQUE_ACCOUNT_SCOPE.test(value.accountScope)) {
      fail("attribution_scope");
    }
  } else if (value.accountScope !== null) {
    fail("unattributed_scope");
  }
  return {
    status: value.status,
    accountScope: value.accountScope,
  };
}

function normalizedRetention(value) {
  hasExactKeys(value, RETENTION_KEYS, "retention_shape");
  if (!RETENTION_BASIS.has(value.sourceHorizonBasis)
      || value.ledgerHorizon !== "prospective_after_capture_start"
      || value.restoresDeletedHistory !== false) {
    fail("retention_policy");
  }
  if (value.sourceHorizonBasis === "unknown") {
    if (value.sourceHorizonDays !== null) fail("retention_horizon");
  } else if (!Number.isSafeInteger(value.sourceHorizonDays) || value.sourceHorizonDays < 1) {
    fail("retention_horizon");
  }
  return {
    sourceHorizonDays: value.sourceHorizonDays,
    sourceHorizonBasis: value.sourceHorizonBasis,
    ledgerHorizon: value.ledgerHorizon,
    restoresDeletedHistory: false,
  };
}

function normalizedReasonCodes(value) {
  if (!Array.isArray(value) || value.length > 32) fail("pricing_reasons");
  const codes = [];
  for (const code of value) {
    if (typeof code !== "string" || !PRICING_REASON_CODES.has(code) || codes.includes(code)) {
      fail("pricing_reasons");
    }
    codes.push(code);
  }
  return [...codes].sort();
}

function normalizedPricing(value) {
  hasExactKeys(value, PRICING_KEYS, "pricing_shape");
  if (!PRICING_STATUS.has(value.status) || !MODEL_RECOGNITION.has(value.modelRecognition)) {
    fail("pricing_state");
  }
  if (value.basis !== PRICING_BASIS) fail("pricing_basis");
  const priced = safeCount(value.pricedComponents, "pricing_count");
  const unpriced = safeCount(value.unpricedComponents, "pricing_count");
  const unavailable = safeCount(value.unavailableComponents, "pricing_count");
  const reasonCodes = normalizedReasonCodes(value.reasonCodes);
  const expectedStatus = priced > 0
    ? (unpriced === 0 && unavailable === 0 ? "fully_priced" : "partially_priced")
    : "unpriced";
  if (value.status !== expectedStatus) fail("pricing_status");
  if (unpriced > 0 && reasonCodes.length === 0) fail("pricing_reasons");
  if (value.modelRecognition !== "recognized") {
    if (!reasonCodes.includes("unknown_model") || priced !== 0 || value.status !== "unpriced") {
      fail("unknown_model");
    }
  } else if (reasonCodes.includes("unknown_model")) {
    fail("unknown_model");
  }
  return {
    status: value.status,
    modelRecognition: value.modelRecognition,
    pricedComponents: priced,
    unpricedComponents: unpriced,
    unavailableComponents: unavailable,
    reasonCodes,
    basis: PRICING_BASIS,
  };
}

function normalizedOutput(value) {
  hasExactKeys(value, OUTPUT_KEYS, "output_shape");
  if (value.outputKind !== "provider_reported_combined") fail("output_kind");
  const combined = safeCount(value.outputCombinedTokens, "output_tokens");
  return {
    outputKind: value.outputKind,
    outputCombinedTokens: combined,
  };
}

/**
 * Normalize a provider-reported Claude combined-output fact into the existing
 * text/reasoning display vocabulary. `reasoningTokens: 0` is explicitly a
 * display compatibility value; it is never presented as provider telemetry.
 */
export function projectClaudeDesktopDisplayOutput(value) {
  const output = normalizedOutput(value);
  return {
    outputTextTokens: output.outputCombinedTokens,
    outputReasoningTokens: 0,
    outputCombinedTokens: output.outputCombinedTokens,
    outputKind: output.outputKind,
    projectionKind: "display_only_compatibility",
    reasoningProvenance: "not_reported_by_provider",
  };
}

/**
 * Build the complete closed accounting/coverage envelope. This is a pure
 * contract constructor, not a parser or a persistence API. Every input
 * section has an exact shape and all returned fields are either fixed enums,
 * opaque keys, bounded timestamps, or nonnegative counters.
 */
export function createClaudeDesktopAccountingContract(value) {
  hasExactKeys(value, CONTRACT_KEYS, "contract_shape");
  const capture = normalizedCapture(value.capture);
  const source = normalizedSource(value.source);
  const attribution = normalizedAttribution(value.attribution);
  const retention = normalizedRetention(value.retention);
  const pricing = normalizedPricing(value.pricing);
  const output = normalizedOutput(value.output);
  const gaps = normalizedGaps(value.gaps);

  if (source.cleanupState === "provider_cleanup"
      && !gaps.some((gap) => gap.reason === "source_cleanup")) {
    fail("source_cleanup_gap");
  }
  if (source.purgeState === "user_purged"
      && !gaps.some((gap) => gap.reason === "user_purge")) {
    fail("purge_gap");
  }
  if (capture.status === "enabled" && capture.startedAt !== null) {
    const startedAt = Date.parse(capture.startedAt);
    for (const gap of gaps) {
      if (gap.reason === "before_capture"
          && (gap.endAt === null || Date.parse(gap.endAt) > startedAt)) {
        fail("capture_gap");
      }
    }
  }

  return {
    schemaVersion: CLAUDE_DESKTOP_ACCOUNTING_CONTRACT_VERSION,
    provider: CLAUDE_DESKTOP_PRODUCT_PROVIDER,
    localOnly: true,
    capture,
    source,
    attribution,
    retention,
    pricing,
    output: projectClaudeDesktopDisplayOutput(output),
    gaps,
  };
}
