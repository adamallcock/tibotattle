import { createHash } from "node:crypto";
import { stableJson } from "./storage.js";

export const EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION = "supplemental-export-source-plan-v1";
export const SUPPLEMENTAL_SOURCE_KINDS = Object.freeze([
  "codex_collector_ledger",
  "claude_status_snapshot",
]);

const SOURCE_KINDS = new Set(SUPPLEMENTAL_SOURCE_KINDS);
const BINDING_KINDS = new Set(["file_prefix", "frozen_inventory"]);
const MAXIMUM_SOURCES = 5_000;
const MAXIMUM_CURSOR_BYTES = 16 * 1024;
const MAXIMUM_CURSOR_DEPTH = 8;
const MAXIMUM_CURSOR_NODES = 1_024;
const MAXIMUM_CURSOR_ARRAY_ITEMS = 128;
const MAXIMUM_CURSOR_OBJECT_KEYS = 64;
const MAXIMUM_CURSOR_STRING_BYTES = 1_024;

const SAFE_CODES = new Set(["schema"]);

export class ExportSupplementalSourcePlanError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown supplemental source-plan failure code");
    super(`Local supplemental source plan failed (${code})`);
    this.name = "ExportSupplementalSourcePlanError";
    this.code = `export_supplemental_source_${code}`;
  }
}

function fail(code = "schema") {
  throw new ExportSupplementalSourcePlanError(code);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function boundedCursorValue(value, state, depth = 0) {
  if (depth > MAXIMUM_CURSOR_DEPTH) fail();
  state.nodes += 1;
  if (state.nodes > MAXIMUM_CURSOR_NODES) fail();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail();
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_CURSOR_STRING_BYTES) fail();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAXIMUM_CURSOR_ARRAY_ITEMS) fail();
    for (const item of value) boundedCursorValue(item, state, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Object.keys(value);
  if (keys.length > MAXIMUM_CURSOR_OBJECT_KEYS
      || keys.some((key) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))) fail();
  for (const key of keys) boundedCursorValue(value[key], state, depth + 1);
}

/**
 * Supplemental adapters communicate opaque progress only as canonical JSON.
 * The bounded grammar keeps this durable cursor from becoming an unbounded
 * carrier for source content while leaving source-specific cursor fields to
 * the adapter that owns them.
 */
export function assertCanonicalSupplementalCursorJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAXIMUM_CURSOR_BYTES) fail();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail();
  }
  boundedCursorValue(parsed, { nodes: 0 });
  if (stableJson(parsed) !== value) fail();
  return value;
}

function normalizeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !BINDING_KINDS.has(value.kind)) fail();
  if (value.kind === "file_prefix") {
    const keys = ["kind", "device", "inode", "birthtimeMs", "prefixBytes", "prefixSha256"];
    if (!exactKeys(value, keys) || !safeCount(value.device) || !safeCount(value.inode)
        || !safeCount(value.birthtimeMs) || !safeCount(value.prefixBytes)
        || !validSha256(value.prefixSha256)) fail();
    return {
      kind: "file_prefix",
      device: value.device,
      inode: value.inode,
      birthtimeMs: value.birthtimeMs,
      prefixBytes: value.prefixBytes,
      prefixSha256: value.prefixSha256,
    };
  }
  const keys = ["kind", "inventoryEntries", "inventoryBytes", "inventorySha256"];
  if (!exactKeys(value, keys) || !safeCount(value.inventoryEntries)
      || !safeCount(value.inventoryBytes) || !validSha256(value.inventorySha256)) fail();
  return {
    kind: "frozen_inventory",
    inventoryEntries: value.inventoryEntries,
    inventoryBytes: value.inventoryBytes,
    inventorySha256: value.inventorySha256,
  };
}

function normalizeSource(value, ordinal) {
  const keys = ["ordinal", "sourceKey", "kind", "parserVersion", "binding", "initialCursorJson"];
  if (!exactKeys(value, keys) || value.ordinal !== ordinal || !validSha256(value.sourceKey)
      || !SOURCE_KINDS.has(value.kind) || typeof value.parserVersion !== "string"
      || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.parserVersion)) fail();
  const binding = normalizeBinding(value.binding);
  if ((value.kind === "codex_collector_ledger" && binding.kind !== "file_prefix")
      || (value.kind === "claude_status_snapshot" && binding.kind !== "frozen_inventory")) fail();
  return {
    ordinal,
    sourceKey: value.sourceKey,
    kind: value.kind,
    parserVersion: value.parserVersion,
    binding,
    initialCursorJson: assertCanonicalSupplementalCursorJson(value.initialCursorJson),
  };
}

function sourceDigest(sources) {
  return createHash("sha256")
    .update("app-usagemonitor/supplemental-export-source-plan/v1\0")
    .update(stableJson(sources))
    .digest("hex");
}

function normalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length > MAXIMUM_SOURCES) fail();
  const normalized = sources.map((source, ordinal) => normalizeSource(source, ordinal));
  if (new Set(normalized.map((source) => source.sourceKey)).size !== normalized.length) fail();
  return normalized;
}

function sourceTotals(sources) {
  return sources.reduce((totals, source) => {
    if (source.binding.kind === "file_prefix") {
      totals.sourceFiles += 1;
      totals.sourceBytes += source.binding.prefixBytes;
    } else {
      totals.sourceFiles += source.binding.inventoryEntries;
      totals.sourceBytes += source.binding.inventoryBytes;
    }
    if (!safeCount(totals.sourceFiles) || !safeCount(totals.sourceBytes)) fail();
    return totals;
  }, { sourceFiles: 0, sourceBytes: 0 });
}

export function createSupplementalSourcePlan({ sources = [] } = {}) {
  const normalized = normalizeSources(sources);
  return {
    schemaVersion: EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
    supplementalSourcePlanSha256: sourceDigest(normalized),
    sources: normalized,
  };
}

export function createEmptySupplementalSourcePlan() {
  return createSupplementalSourcePlan();
}

export function normalizeSupplementalSourcePlan(value) {
  const keys = ["schemaVersion", "supplementalSourcePlanSha256", "sources"];
  if (!exactKeys(value, keys) || value.schemaVersion !== EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION
      || !validSha256(value.supplementalSourcePlanSha256)) fail();
  const sources = normalizeSources(value.sources);
  if (value.supplementalSourcePlanSha256 !== sourceDigest(sources)) fail();
  return {
    schemaVersion: EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
    supplementalSourcePlanSha256: value.supplementalSourcePlanSha256,
    sources,
  };
}

export function summarizeSupplementalSourcePlan(value) {
  const plan = normalizeSupplementalSourcePlan(value);
  const totals = sourceTotals(plan.sources);
  return {
    schemaVersion: EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
    supplementalSourcePlanSha256: plan.supplementalSourcePlanSha256,
    sourceCount: plan.sources.length,
    sourceFiles: totals.sourceFiles,
    sourceBytes: totals.sourceBytes,
  };
}
