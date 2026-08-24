import { OPENAI_CODEX_MODEL_IDS } from "./registries.js";
import { EXPORT_CHECKPOINT_PARSER_VERSION } from "./versions.js";
import { stableJson } from "./canonical-json.js";

/**
 * This state is deliberately limited to the state needed to continue parsing a
 * single frozen Codex JSONL source.  The workspace owns progress (cursor,
 * phase, and checkpoint sequence) so it can advance that data atomically with
 * records and this parser state.
 */
export { EXPORT_CHECKPOINT_PARSER_VERSION };

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

/**
 * Runtime-neutral checkpoint-state owner. The command composition root
 * supplies the one platform capability (SHA-256) needed for a digest.
 */
export function createCodexCheckpointStateContext({ createHash, isProxy } = {}) {
  const proxyCheck = requireFunction(isProxy, "isProxy");
  const hash = requireFunction(createHash, "createHash");
  try {
    if (proxyCheck(hash)) throw new TypeError("createHash must be a trusted function");
  } catch (error) {
    if (error instanceof TypeError && error.message === "createHash must be a trusted function") throw error;
    throw new TypeError("createHash must be a trusted function");
  }

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TOKEN_FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);
const TOOL_FIELDS = Object.freeze([
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "hostedShell",
  "computerUse",
  "mcp",
  "applyPatch",
  "localShell",
  "subagent",
  "toolGateway",
  "other",
  "unknown",
]);
const MODEL_IDS = new Set(OPENAI_CODEX_MODEL_IDS);
const SPEED_MODES = new Set(["standard", "fast", "unknown", "other"]);
const API_SERVICE_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown", "other"]);
const FINGERPRINT = /^model:v1:[a-f0-9]{64}$/;

const STATE_KEYS = Object.freeze([
  "schemaVersion",
  "currentModel",
  "previousTotals",
  "previousTotalsPresence",
  "reAnchored",
  "sessionMetaSeen",
  "tier",
  "pendingToolCounts",
]);
const MODEL_KEYS = Object.freeze(["modelId", "modelRecognition", "modelFingerprint"]);
const TIER_KEYS = Object.freeze(["timelineIndex", "speedMode", "apiServiceTier"]);

function invalid() {
  // Deliberately do not interpolate values: state may have come from a raw log.
  throw new TypeError("Invalid privacy-safe Codex checkpoint state");
}

function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value, keys) {
  if (!isObject(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const propertyNames = Object.getOwnPropertyNames(value);
  return propertyNames.length === keys.length
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}

function nonNegativeInteger(value, maximum = MAX_SAFE) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function normalizeModel(value) {
  if (!hasExactlyKeys(value, MODEL_KEYS)) invalid();
  const { modelId, modelRecognition, modelFingerprint } = value;
  if (modelRecognition === "recognized") {
    if (typeof modelId !== "string" || !MODEL_IDS.has(modelId) || modelFingerprint !== null) invalid();
  } else if (modelRecognition === "unrecognized") {
    if (modelId !== "unknown" || typeof modelFingerprint !== "string" || !FINGERPRINT.test(modelFingerprint)) invalid();
  } else if (modelRecognition === "missing") {
    if (modelId !== "unknown" || modelFingerprint !== null) invalid();
  } else {
    invalid();
  }
  return { modelId, modelRecognition, modelFingerprint };
}

function normalizeTokenTotals(value) {
  if (!hasExactlyKeys(value, TOKEN_FIELDS)) invalid();
  const normalized = {};
  for (const field of TOKEN_FIELDS) {
    if (!nonNegativeInteger(value[field])) invalid();
    normalized[field] = value[field];
  }
  return normalized;
}

function normalizePresence(value) {
  if (!hasExactlyKeys(value, TOKEN_FIELDS)) invalid();
  const normalized = {};
  for (const field of TOKEN_FIELDS) {
    if (typeof value[field] !== "boolean") invalid();
    normalized[field] = value[field];
  }
  return normalized;
}

function normalizeTier(value) {
  if (!hasExactlyKeys(value, TIER_KEYS)
      || !nonNegativeInteger(value.timelineIndex)
      || !SPEED_MODES.has(value.speedMode)
      || !API_SERVICE_TIERS.has(value.apiServiceTier)) invalid();
  return {
    timelineIndex: value.timelineIndex,
    speedMode: value.speedMode,
    apiServiceTier: value.apiServiceTier,
  };
}

function normalizePendingTools(value) {
  if (!hasExactlyKeys(value, TOOL_FIELDS)) invalid();
  const normalized = {};
  for (const field of TOOL_FIELDS) {
    // Match the telemetry schema bound; a larger count is not useful metadata.
    if (!nonNegativeInteger(value[field], 1_000_000)) invalid();
    normalized[field] = value[field];
  }
  return normalized;
}

function emptyPendingTools() {
  return Object.fromEntries(TOOL_FIELDS.map((field) => [field, 0]));
}

/** Return a new state; callers may safely mutate their copy before normalization. */
function createEmptyCodexCheckpointState() {
  return {
    schemaVersion: EXPORT_CHECKPOINT_PARSER_VERSION,
    currentModel: null,
    previousTotals: null,
    previousTotalsPresence: null,
    reAnchored: false,
    sessionMetaSeen: false,
    tier: {
      timelineIndex: 0,
      speedMode: "unknown",
      apiServiceTier: "unknown",
    },
    pendingToolCounts: emptyPendingTools(),
  };
}

/**
 * Validate a closed state shape and return a canonical deep clone.  Unknown
 * raw model strings, provider tier labels, IDs, paths, and arbitrary parser
 * bookkeeping cannot enter checkpoint JSON through this boundary.
 */
function normalizeCodexCheckpointState(value) {
  if (!hasExactlyKeys(value, STATE_KEYS) || value.schemaVersion !== EXPORT_CHECKPOINT_PARSER_VERSION) invalid();
  if (value.currentModel !== null && !isObject(value.currentModel)) invalid();
  const hasTotals = value.previousTotals !== null;
  if (hasTotals !== (value.previousTotalsPresence !== null)) invalid();
  if (typeof value.reAnchored !== "boolean"
      || typeof value.sessionMetaSeen !== "boolean") invalid();

  return {
    schemaVersion: EXPORT_CHECKPOINT_PARSER_VERSION,
    currentModel: value.currentModel === null ? null : normalizeModel(value.currentModel),
    previousTotals: hasTotals ? normalizeTokenTotals(value.previousTotals) : null,
    previousTotalsPresence: hasTotals ? normalizePresence(value.previousTotalsPresence) : null,
    reAnchored: value.reAnchored,
    sessionMetaSeen: value.sessionMetaSeen,
    tier: normalizeTier(value.tier),
    pendingToolCounts: normalizePendingTools(value.pendingToolCounts),
  };
}

function serializeCodexCheckpointState(value) {
  return stableJson(normalizeCodexCheckpointState(value));
}

function digestCodexCheckpointState(value) {
  return hash("sha256")
    .update("app-usagemonitor/codex-checkpoint-state/v1\0")
    .update(serializeCodexCheckpointState(value), "utf8")
    .digest("hex");
}

  return Object.freeze({
    createEmptyCodexCheckpointState,
    normalizeCodexCheckpointState,
    serializeCodexCheckpointState,
    digestCodexCheckpointState,
  });
}
