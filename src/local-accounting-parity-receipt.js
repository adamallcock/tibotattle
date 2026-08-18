import { createHmac } from "node:crypto";

import { isValidQuotaWindowDuration } from "@app-usagemonitor/quota-analysis";

import {
  COMPONENT_KEYS,
  KNOWN_AGENT_SCOPES,
  KNOWN_API_TIERS,
  KNOWN_LINEAGE,
  KNOWN_LIMITS,
  KNOWN_PLANS,
  KNOWN_SLOTS,
  KNOWN_SPEEDS,
  KNOWN_SURFACES,
} from "./local-companion-usage-model.js";
import { recognizedCodexModelId } from "./export/index.js";
import { validAbortSignal } from "./valid-abort-signal.js";

// This receipt is deliberately a content-free, pre-calibration callback
// characterization boundary. It records only normalized usage/quota callback
// inputs; it is not a pricing, declared-speed, or final-accounting proof.
// Keyed multiset checksums make the result useful for comparing two scanners
// without retaining their rows or source identifiers.
export const LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION =
  "local-accounting-semantic-receipt-v1";
export const LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE =
  "pre_calibration_callback_semantics";
export const LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE_VERSION = "v1";

export const LOCAL_ACCOUNTING_PARITY_MISMATCH_CATEGORIES = Object.freeze([
  "receipt_schema",
  "window",
  "usage_count",
  "usage_tokens",
  "usage_components",
  "usage_digest",
  "usage_dimensions",
  "quota_count",
  "quota_digest",
  "quota_dimensions",
]);

const ERROR_CODES = Object.freeze({
  options: "accounting_parity_options_invalid",
  window: "accounting_parity_window_invalid",
  byteKey: "accounting_parity_byte_key_invalid",
  signal: "accounting_parity_signal_invalid",
  scanner: "accounting_parity_scanner_invalid",
  usage: "accounting_parity_usage_callback_invalid",
  quota: "accounting_parity_quota_callback_invalid",
  aborted: "accounting_parity_aborted",
  scan: "accounting_parity_scan_failed",
  receipt: "accounting_parity_receipt_invalid",
  overflow: "accounting_parity_total_overflow",
});
const PARITY_ERROR = Symbol("local-accounting-parity-error");

const DIGEST_PATTERN = /^hmac-sha256-multiset-v1:[0-9a-f]{64}:[0-9a-f]{64}$/u;
const MODULUS = 1n << 256n;

const USAGE_DIMENSIONS = Object.freeze([
  "model",
  "speed",
  "apiServiceTier",
  "surface",
  "agentScope",
  "lineage",
]);
const QUOTA_DIMENSIONS = Object.freeze([
  "provider",
  "planType",
  "limitId",
  "slot",
  "durationMinutes",
]);
const KNOWN_PROVIDERS = new Set(["openai_codex", "unknown"]);

function fixedError(code, name = "Error") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  error[PARITY_ERROR] = true;
  return error;
}

function isParityError(error) {
  return error?.[PARITY_ERROR] === true;
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function validateWindow(startAt, endAt) {
  const start = canonicalInstant(startAt);
  const end = canonicalInstant(endAt);
  if (start === null || end === null || Date.parse(start) > Date.parse(end)) {
    throw fixedError(ERROR_CODES.window, "TypeError");
  }
  return { startAt: start, endAt: end };
}

function validateByteKey(value) {
  if (!(value instanceof Uint8Array)
      || value.byteLength < 32
      || value.byteLength > 256) {
    throw fixedError(ERROR_CODES.byteKey, "TypeError");
  }
  return Buffer.from(value);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw fixedError(ERROR_CODES.aborted, "AbortError");
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function closedEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

function closedModel(value) {
  return recognizedCodexModelId(value) ?? "unknown";
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw fixedError(ERROR_CODES.overflow);
  }
  return result;
}

function componentTotals() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

function normalizeUsage(raw) {
  if (!isPlainObject(raw)
      || typeof raw.model !== "string"
      || !isPlainObject(raw.components)) {
    throw fixedError(ERROR_CODES.usage);
  }
  const timestamp = canonicalInstant(raw.timestamp);
  if (timestamp === null) throw fixedError(ERROR_CODES.usage);

  const components = {};
  for (const key of COMPONENT_KEYS) {
    const value = raw.components[key];
    if (value !== undefined && !nonNegativeSafeInteger(value)) {
      throw fixedError(ERROR_CODES.usage);
    }
    // The legacy indexed reader omits the combined-output alias. Replay-safe
    // accounting's component normalizer treats that omission as zero.
    components[key] = value ?? 0;
  }

  // Preserve the distinction between a reported zero and an omitted database
  // value. The replay pricer uses input components when this field is absent,
  // so normalizing absence to zero can silently change long-context pricing.
  const totalInputContextTokens = raw.totalInputContextTokens === undefined
    || raw.totalInputContextTokens === null
    ? null
    : raw.totalInputContextTokens;
  if (totalInputContextTokens !== null
      && !nonNegativeSafeInteger(totalInputContextTokens)) {
    throw fixedError(ERROR_CODES.usage);
  }

  const tier = raw.tierSemantics;
  const surface = raw.surfaceClassification;
  if (tier !== undefined && !isPlainObject(tier)) {
    throw fixedError(ERROR_CODES.usage);
  }
  if (surface !== undefined && !isPlainObject(surface)) {
    throw fixedError(ERROR_CODES.usage);
  }

  const projection = {
    timestamp,
    model: closedModel(raw.model),
    totalInputContextTokens,
    components,
    speed: closedEnum(tier?.codexSpeedMode, KNOWN_SPEEDS),
    apiServiceTier: closedEnum(tier?.apiServiceTier, KNOWN_API_TIERS),
    surface: closedEnum(surface?.surface, KNOWN_SURFACES),
    agentScope: closedEnum(surface?.agentScope, KNOWN_AGENT_SCOPES),
    lineage: closedEnum(
      surface?.lineageDisposition,
      KNOWN_LINEAGE,
    ),
  };
  const inputTokens = components.input_uncached_tokens
    + components.input_cache_read_tokens
    + components.input_cache_write_tokens;
  const separatedOutput = components.output_text_tokens
    + components.output_reasoning_tokens;
  // Mirror eventProjection: a non-empty separated output split is more
  // informative than the overlapping combined alias.
  if (components.output_combined_tokens > 0 && separatedOutput > 0) {
    components.output_combined_tokens = 0;
  }
  const outputTokens = separatedOutput > 0
    ? separatedOutput
    : components.output_combined_tokens;
  projection.totalTokens = checkedAdd(inputTokens, outputTokens);
  return projection;
}

function normalizeQuota(raw) {
  if (!isPlainObject(raw) || typeof raw.timestamp !== "string") {
    throw fixedError(ERROR_CODES.quota);
  }
  const timestamp = canonicalInstant(raw.timestamp);
  const window = raw.window;
  if (timestamp === null || !isPlainObject(window)) {
    throw fixedError(ERROR_CODES.quota);
  }
  const durationMinutes = window.windowDurationMins;
  const resetsAt = window.resetsAt;
  const usedPercent = window.usedPercent;
  if (!Number.isSafeInteger(durationMinutes)
      || !isValidQuotaWindowDuration(durationMinutes)
      || !Number.isFinite(usedPercent)
      || usedPercent < 0
      || usedPercent > 100
      || !Number.isSafeInteger(resetsAt)
      || resetsAt <= 0
      || !Number.isFinite(new Date(resetsAt * 1_000).getTime())) {
    throw fixedError(ERROR_CODES.quota);
  }
  return {
    timestamp,
    provider: closedEnum(window.provider, KNOWN_PROVIDERS),
    planType: closedEnum(window.planType, KNOWN_PLANS),
    limitId: closedEnum(window.limitId, KNOWN_LIMITS),
    slot: closedEnum(window.slot, KNOWN_SLOTS),
    usedPercent,
    durationMinutes,
    resetsAt,
  };
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${bytes.toString("hex")}`);
}

function formatBigInt(value) {
  return value.toString(16).padStart(64, "0");
}

// An internal characterization checksum. Keeping only two 256-bit sums and a
// count makes this order-independent and multiplicity-sensitive without
// retaining rows (or even their individual digests). The modular sums are
// algebraically collisionable, so this is not an adversarial proof; callers
// must pair it with the shadow final-projection comparison before cutover.
class MultisetAccumulator {
  #key;
  #domain;
  #sum = 0n;
  #secondary = 0n;

  constructor(key, domain) {
    this.#key = key;
    this.#domain = domain;
  }

  add(serialized) {
    const first = createHmac("sha256", this.#key)
      .update(`${this.#domain}\0${serialized}`)
      .digest();
    const second = createHmac("sha256", this.#key)
      .update(`${this.#domain}\0secondary\0${serialized}`)
      .digest();
    this.#sum = (this.#sum + bytesToBigInt(first)) % MODULUS;
    this.#secondary = (this.#secondary + bytesToBigInt(second)) % MODULUS;
  }

  digest() {
    return [
      "hmac-sha256-multiset-v1",
      formatBigInt(this.#sum),
      formatBigInt(this.#secondary),
    ].join(":");
  }
}

function newDimensionState(kind) {
  return Object.fromEntries(kind === "usage"
    ? USAGE_DIMENSIONS.map((dimension) => [dimension, new Map()])
    : QUOTA_DIMENSIONS.map((dimension) => [dimension, new Map()]));
}

function dimensionValueKey(value) {
  return typeof value === "number" ? String(value) : value;
}

function addDimensionRow({
  state,
  key,
  domain,
  value,
  serialized,
  count,
  totalTokens = 0,
}) {
  const dimension = state[domain];
  const valueKey = dimensionValueKey(value);
  let row = dimension.get(valueKey);
  if (!row) {
    row = {
      count: 0,
      totalTokens: 0,
      digest: new MultisetAccumulator(
        key,
        `${domain}\0${valueKey}`,
      ),
    };
    dimension.set(valueKey, row);
  }
  row.count = checkedAdd(row.count, count);
  row.totalTokens = checkedAdd(row.totalTokens, totalTokens);
  row.digest.add(serialized);
}

function sortedDimensionDigests(state, includeTokens = true) {
  const result = {};
  for (const dimension of Object.keys(state).sort()) {
    const rows = state[dimension];
    result[dimension] = {};
    for (const value of [...rows.keys()].sort()) {
      const row = rows.get(value);
      result[dimension][value] = {
        count: row.count,
        ...(includeTokens ? { totalTokens: row.totalTokens } : {}),
        digest: row.digest.digest(),
      };
    }
  }
  return result;
}

function createUsageState(key) {
  return {
    count: 0,
    totalTokens: 0,
    totalInputContextTokens: 0,
    missingTotalInputContextCount: 0,
    components: componentTotals(),
    digest: new MultisetAccumulator(key, "usage"),
    dimensions: newDimensionState("usage"),
  };
}

function addUsage(state, raw, startMs, endMs) {
  const row = normalizeUsage(raw);
  const observedMs = Date.parse(row.timestamp);
  if (observedMs < startMs || observedMs > endMs) return;
  // Replay-safe accounting suppresses zero-token usage callbacks before they
  // affect counts, totals, dimensions, or digests.
  if (row.totalTokens === 0) return;
  const serialized = JSON.stringify(row);
  state.count = checkedAdd(state.count, 1);
  state.totalTokens = checkedAdd(state.totalTokens, row.totalTokens);
  if (row.totalInputContextTokens === null) {
    state.missingTotalInputContextCount = checkedAdd(
      state.missingTotalInputContextCount,
      1,
    );
  } else {
    state.totalInputContextTokens = checkedAdd(
      state.totalInputContextTokens,
      row.totalInputContextTokens,
    );
  }
  for (const key of COMPONENT_KEYS) {
    state.components[key] = checkedAdd(state.components[key], row.components[key]);
  }
  state.digest.add(serialized);
  for (const dimension of USAGE_DIMENSIONS) {
    addDimensionRow({
      state: state.dimensions,
      key: state.key,
      domain: dimension,
      value: row[dimension],
      serialized,
      count: 1,
      totalTokens: row.totalTokens,
    });
  }
}

function createQuotaState(key) {
  return {
    count: 0,
    digest: new MultisetAccumulator(key, "quota"),
    dimensions: newDimensionState("quota"),
  };
}

function addQuota(state, raw, startMs, endMs) {
  // This is the raw normalized callback semantics. Final replay-safe quota
  // acceptance/projection remains a separate shadow-cache comparison.
  const row = normalizeQuota(raw);
  const observedMs = Date.parse(row.timestamp);
  if (observedMs < startMs || observedMs > endMs) return;
  const serialized = JSON.stringify(row);
  state.count = checkedAdd(state.count, 1);
  state.digest.add(serialized);
  for (const dimension of QUOTA_DIMENSIONS) {
    addDimensionRow({
      state: state.dimensions,
      key: state.key,
      domain: dimension,
      value: row[dimension],
      serialized,
      count: 1,
    });
  }
}

function finalizeState(state) {
  return {
    count: state.count,
    ...(state.totalTokens === undefined
      ? {}
      : {
        totalTokens: state.totalTokens,
        totalInputContextTokens: state.totalInputContextTokens,
        missingTotalInputContextCount: state.missingTotalInputContextCount,
        components: state.components,
      }),
    digest: state.digest.digest(),
    dimensionDigests: sortedDimensionDigests(
      state.dimensions,
      state.totalTokens !== undefined,
    ),
  };
}

function validateReceiptDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function validateReceiptDimensionMap(value, includeTokens) {
  if (!isPlainObject(value)) return false;
  for (const dimension of Object.values(value)) {
    if (!isPlainObject(dimension)) return false;
    for (const row of Object.values(dimension)) {
      if (!isPlainObject(row)
          || !nonNegativeSafeInteger(row.count)
          || (includeTokens && !nonNegativeSafeInteger(row.totalTokens))
          || !validateReceiptDigest(row.digest)) return false;
    }
  }
  return true;
}

function validReceipt(value) {
  if (!isPlainObject(value)
      || typeof value.version !== "string"
      || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.version)
      || value.scope !== LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE
      || value.scopeVersion !== LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE_VERSION
      || !isPlainObject(value.window)
      || canonicalInstant(value.window.startAt) !== value.window.startAt
      || canonicalInstant(value.window.endAt) !== value.window.endAt
      || Date.parse(value.window.startAt) > Date.parse(value.window.endAt)
      || !isPlainObject(value.usage)
      || !isPlainObject(value.quota)) return false;
  const usage = value.usage;
  const quota = value.quota;
  if (!nonNegativeSafeInteger(usage.count)
      || !nonNegativeSafeInteger(usage.totalTokens)
      || !nonNegativeSafeInteger(usage.totalInputContextTokens)
      || !nonNegativeSafeInteger(usage.missingTotalInputContextCount)
      || !isPlainObject(usage.components)
      || COMPONENT_KEYS.some((key) => !nonNegativeSafeInteger(usage.components[key]))
      || !validateReceiptDigest(usage.digest)
      || !validateReceiptDimensionMap(usage.dimensionDigests, true)) {
    return false;
  }
  return nonNegativeSafeInteger(quota.count)
    && validateReceiptDigest(quota.digest)
    && validateReceiptDimensionMap(quota.dimensionDigests, false);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addMismatch(categories, category) {
  if (!categories.includes(category)) categories.push(category);
}

/**
 * Stream one scanner-shaped source into a content-free semantic receipt.
 * `scan` receives only the pinned inclusive window and the callbacks used by
 * replay-safe accounting; scanner return values and diagnostics are ignored
 * so paths, source names, and error text cannot enter the receipt. The result
 * is explicitly scoped to pre-calibration callback semantics and must not be
 * read as pricing, declared-speed, or final-accounting evidence.
 */
export async function createLocalAccountingSemanticReceipt({
  scan,
  scanner,
  startAt,
  endAt,
  byteKey,
  signal = null,
} = {}) {
  const selectedScan = scan ?? scanner;
  if (typeof selectedScan !== "function") {
    throw fixedError(ERROR_CODES.scanner, "TypeError");
  }
  if (!validAbortSignal(signal)) {
    throw fixedError(ERROR_CODES.signal, "TypeError");
  }
  const window = validateWindow(startAt, endAt);
  const key = validateByteKey(byteKey);
  throwIfAborted(signal);

  // `key` is kept only by the short-lived accumulators. It is never copied to
  // the returned object, and raw scanner rows are reduced before the next
  // callback returns.
  const usage = createUsageState(key);
  const quota = createQuotaState(key);
  const startMs = Date.parse(window.startAt);
  const endMs = Date.parse(window.endAt);
  usage.key = key;
  quota.key = key;
  try {
    await selectedScan({
      startAt: window.startAt,
      endAt: window.endAt,
      signal,
      onUsage: (row) => {
        throwIfAborted(signal);
        addUsage(usage, row, startMs, endMs);
      },
      onRateLimitSnapshot: (row) => {
        throwIfAborted(signal);
        addQuota(quota, row, startMs, endMs);
      },
    });
    throwIfAborted(signal);
  } catch (error) {
    if (isParityError(error)) throw error;
    if (signal?.aborted) throw fixedError(ERROR_CODES.aborted, "AbortError");
    throw fixedError(ERROR_CODES.scan);
  }

  return {
    version: LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION,
    scope: LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE,
    scopeVersion: LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE_VERSION,
    window,
    usage: finalizeState(usage),
    quota: finalizeState(quota),
  };
}

/**
 * Compare two receipts without exposing differing values. The result is
 * intentionally a fixed category set, suitable for a durable parity report
 * that must not contain source paths, row content, or scanner error text.
 */
export function compareLocalAccountingSemanticReceipts(left, right) {
  if (!validReceipt(left) || !validReceipt(right)) {
    throw fixedError(ERROR_CODES.receipt, "TypeError");
  }
  const categories = [];
  if (left.version !== right.version) addMismatch(categories, "receipt_schema");
  if (!sameValue(left.window, right.window)) addMismatch(categories, "window");
  if (left.usage.count !== right.usage.count) addMismatch(categories, "usage_count");
  if (left.usage.totalTokens !== right.usage.totalTokens
      || left.usage.totalInputContextTokens
        !== right.usage.totalInputContextTokens
      || left.usage.missingTotalInputContextCount
        !== right.usage.missingTotalInputContextCount) {
    addMismatch(categories, "usage_tokens");
  }
  if (!sameValue(left.usage.components, right.usage.components)) {
    addMismatch(categories, "usage_components");
  }
  if (left.usage.digest !== right.usage.digest) addMismatch(categories, "usage_digest");
  if (!sameValue(left.usage.dimensionDigests, right.usage.dimensionDigests)) {
    addMismatch(categories, "usage_dimensions");
  }
  if (left.quota.count !== right.quota.count) addMismatch(categories, "quota_count");
  if (left.quota.digest !== right.quota.digest) addMismatch(categories, "quota_digest");
  if (!sameValue(left.quota.dimensionDigests, right.quota.dimensionDigests)) {
    addMismatch(categories, "quota_dimensions");
  }
  return {
    equal: categories.length === 0,
    mismatchCategories: categories,
  };
}
