import { createHash } from "node:crypto";
import { runClaudeDesktopIncrementalRefresh } from "./claude-desktop-incremental-refresh.js";
import { ANTHROPIC_CLAUDE_MODEL_IDS } from "./export/index.js";
import {
  CLAUDE_DESKTOP_SHADOW_PROVIDER,
  openClaudeDesktopShadowStore,
} from "./claude-desktop-shadow-store.js";

export const CLAUDE_DESKTOP_SHADOW_REFRESH_VERSION =
  "claude-desktop-shadow-refresh-v0.1";

class ClaudeDesktopShadowRefreshError extends Error {
  constructor(code) {
    super(`Claude Desktop shadow refresh failed (${code})`);
    this.name = "ClaudeDesktopShadowRefreshError";
    this.code = `claude_desktop_shadow_refresh_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopShadowRefreshError(code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("timestamp");
  return value;
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail("source_generation");
  return value;
}

const CANDIDATE_KEYS = new Set([
  "candidateVersion",
  "provider",
  "eventTime",
  "modelDeclaration",
  "billingSurface",
  "speedMode",
  "components",
  "totalInputContextTokens",
  "surface",
  "agentScope",
  "lineageDisposition",
  "toolClassCounts",
  "sessionScopeId",
  "occurrenceMaterial",
]);
const MODEL_KEYS = new Set(["modelId", "modelRecognition", "modelFingerprint"]);
const REVIEWED_MODEL_IDS = new Set(ANTHROPIC_CLAUDE_MODEL_IDS);
const COMPONENT_KEYS = new Set([
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite5mTokens",
  "inputCacheWrite1hTokens",
  "outputCombinedTokens",
]);
const TOOL_KEYS = new Set([
  "web_search",
  "file_search",
  "code_interpreter",
  "hosted_shell",
  "computer_use",
  "mcp",
  "apply_patch",
  "local_shell",
  "subagent",
  "tool_gateway",
  "other",
  "unknown",
]);

function validateObjectKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function safeCount(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("candidate");
  return value;
}

function safeChoice(value, choices) {
  if (!choices.has(value)) fail("candidate");
  return value;
}

function safeBoundedString(value, pattern = null) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
      || (pattern && !pattern.test(value))) fail("candidate");
  return value;
}

function closedCandidate(candidate) {
  validateObjectKeys(candidate, CANDIDATE_KEYS, "candidate");
  if (candidate.provider !== CLAUDE_DESKTOP_SHADOW_PROVIDER) fail("candidate");
  if (candidate.candidateVersion !== "claude-transcript-usage-candidate-v0.2") fail("candidate");
  const eventTime = safeBoundedString(candidate.eventTime);
  const parsed = Date.parse(eventTime);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== eventTime) fail("candidate");
  validateObjectKeys(candidate.modelDeclaration, MODEL_KEYS, "candidate");
  safeBoundedString(candidate.modelDeclaration.modelId);
  safeChoice(candidate.modelDeclaration.modelRecognition,
    new Set(["recognized", "missing", "unrecognized"]));
  if (candidate.modelDeclaration.modelRecognition === "recognized"
      && (candidate.modelDeclaration.modelFingerprint !== null
        || !REVIEWED_MODEL_IDS.has(candidate.modelDeclaration.modelId))) fail("candidate");
  if (candidate.modelDeclaration.modelRecognition === "missing"
      && (candidate.modelDeclaration.modelFingerprint !== null
        || candidate.modelDeclaration.modelId !== "unknown")) fail("candidate");
  if (candidate.modelDeclaration.modelRecognition === "unrecognized"
      && (candidate.modelDeclaration.modelId !== "unknown"
        || typeof candidate.modelDeclaration.modelFingerprint !== "string"
        || !/^model:v1:[a-f0-9]{64}$/u.test(candidate.modelDeclaration.modelFingerprint))) {
    fail("candidate");
  }
  validateObjectKeys(candidate.components, COMPONENT_KEYS, "candidate");
  for (const key of COMPONENT_KEYS) {
    safeCount(candidate.components[key], {
      nullable: key === "inputCacheWrite5mTokens" || key === "inputCacheWrite1hTokens",
    });
  }
  safeCount(candidate.totalInputContextTokens);
  if (candidate.billingSurface !== "claude_subscription") fail("candidate");
  safeChoice(candidate.speedMode, new Set(["standard", "fast", "unknown", "other"]));
  safeChoice(candidate.surface, new Set(["subagent", "local_interactive_unclassified"]));
  safeChoice(candidate.agentScope, new Set(["root", "subagent"]));
  safeChoice(candidate.lineageDisposition, new Set(["standalone", "parent_linked"]));
  if (candidate.toolClassCounts !== undefined) {
    validateObjectKeys(candidate.toolClassCounts, TOOL_KEYS, "candidate");
    for (const key of TOOL_KEYS) {
      const value = safeCount(candidate.toolClassCounts[key]);
      if (value > 1_000_000) fail("candidate");
    }
  }
  if (typeof candidate.sessionScopeId !== "string"
      || !/^session:v1:[a-f0-9]{64}$/u.test(candidate.sessionScopeId)) fail("candidate");
  if (typeof candidate.occurrenceMaterial !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.occurrenceMaterial)) fail("candidate");
  return candidate;
}

function parseEventTime(candidate, fallback) {
  const value = candidate?.eventTime ?? candidate?.timestamp ?? candidate?.selected?.timestamp;
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function candidateRecord(entry, sourceGeneration, acceptedAtMs) {
  const candidate = entry?.candidate ?? entry;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("candidate");
  }
  closedCandidate(candidate);
  const generation = safeGeneration(entry?.sourceGeneration ?? sourceGeneration);
  const sourceKey = entry?.sourceKey ?? null;
  if (typeof sourceKey !== "string" || !/^[a-f0-9]{64}$/u.test(sourceKey)) fail("candidate");
  const recordKey = sha256(stableJson({
    sourceKey,
    sourceGeneration: generation,
    candidate,
  }));
  return {
    kind: "usage",
    sourceGeneration: generation,
    eventTimeMs: parseEventTime(candidate, acceptedAtMs),
    recordKey,
    payloadDigest: sha256(stableJson(candidate)),
    revision: 1,
  };
}

function digestArtifact(kind, sourceGeneration, summary) {
  const artifactDigest = sha256(stableJson(summary));
  return {
    kind,
    sourceGeneration,
    // Derived artifacts cover a whole source generation. Keeping their event
    // time unknown makes any bounded purge invalidate them instead of leaving
    // a full-generation digest that may include the deleted interval.
    eventTimeMs: null,
    artifactKey: sha256(stableJson({
      provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
      kind,
      sourceGeneration,
      artifactDigest,
    })),
    artifactDigest,
  };
}

function count(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function digestOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("projection");
  return value;
}

function canonicalSnapshot(value) {
  return {
    sources: count(value?.sources),
    groups: count(value?.groups),
    tools: count(value?.tools),
    dirtyGroups: count(value?.dirtyGroups),
  };
}

function nullableCount(value, code) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function projectionSummary(value) {
  if (value === null || value === undefined) return null;
  validateObjectKeys(value, new Set([
    "provider", "generation", "highWater", "payloadSha256", "rowCount", "elapsedMs",
  ]), "projection");
  if (value.provider !== CLAUDE_DESKTOP_SHADOW_PROVIDER) fail("projection");
  return {
    generation: nullableCount(value.generation, "projection"),
    highWater: nullableCount(value.highWater, "projection"),
    payloadSha256: digestOrNull(value.payloadSha256),
    rowCount: nullableCount(value.rowCount, "projection"),
  };
}

function pricingSummary(value) {
  if (value === null || value === undefined) return null;
  validateObjectKeys(value, new Set([
    "schemaVersion", "provider", "productProvider", "accountingVendor",
    "usageProjectionGeneration", "eventCount", "totalUsd", "coverageStatus",
    "coverageCounts", "warningCodes", "pricingDigest", "payloadSha256",
  ]), "pricing");
  if (value.provider !== CLAUDE_DESKTOP_SHADOW_PROVIDER
      || value.productProvider !== CLAUDE_DESKTOP_SHADOW_PROVIDER
      || value.accountingVendor !== "anthropic"
      || value.schemaVersion !== "claude-desktop-pricing-summary-v0.1") fail("pricing");
  validateObjectKeys(value.coverageCounts,
    new Set(["fullyPriced", "partiallyPriced", "unpriced"]), "pricing");
  const coverageCounts = {
    fullyPriced: nullableCount(value.coverageCounts.fullyPriced, "pricing"),
    partiallyPriced: nullableCount(value.coverageCounts.partiallyPriced, "pricing"),
    unpriced: nullableCount(value.coverageCounts.unpriced, "pricing"),
  };
  if (!new Set(["fully_priced", "partially_priced", "unpriced"]).has(value.coverageStatus)) {
    fail("pricing");
  }
  return {
    payloadSha256: digestOrNull(value.payloadSha256),
    eventCount: nullableCount(value.eventCount, "pricing"),
    coverageStatus: value.coverageStatus,
    coverageCounts,
  };
}

/**
 * Converts the bounded incremental result into keyed digests only. The input
 * candidates are never stored in the shadow namespace or returned to callers.
 */
export function buildClaudeDesktopShadowBatch({
  canonical,
  projection = null,
  pricingProjection = null,
  pricingSummary: boundedPricingSummary = null,
  sourceGeneration = 1,
  acceptedAtMs = Date.now(),
} = {}) {
  const accepted = safeTimestamp(acceptedAtMs);
  const generation = safeGeneration(sourceGeneration);
  const candidates = Array.isArray(canonical?.candidates) ? canonical.candidates : [];
  const records = candidates.map((entry) => candidateRecord(entry, generation, accepted));
  const seen = new Set();
  const uniqueRecords = records.filter((record) => {
    const identity = stableJson([
      record.kind,
      record.sourceGeneration,
      record.eventTimeMs,
      record.recordKey,
      record.revision,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const commonSummary = {
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    sourceGeneration: generation,
    candidateCount: candidates.length,
    canonicalSourceCount: count(canonical?.sourceCount),
    canonicalDirtyGroupCount: count(canonical?.dirtyGroupCount),
    canonicalParsedLines: count(canonical?.parsedLines),
    canonicalSnapshot: canonicalSnapshot(canonical?.snapshot),
    projection: projectionSummary(projection),
    // The row-rich debug projection is intentionally ignored. Only the
    // bounded summary is eligible for a shadow cache artifact.
    pricing: pricingSummary(boundedPricingSummary),
  };
  const artifacts = [
    digestArtifact("canonical", generation, commonSummary),
    digestArtifact("checkpoint", generation, commonSummary.canonicalSnapshot),
    digestArtifact("projection", generation, commonSummary.projection),
    digestArtifact("cache", generation, commonSummary.pricing),
  ];
  return {
    schemaVersion: CLAUDE_DESKTOP_SHADOW_REFRESH_VERSION,
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    records: uniqueRecords,
    artifacts,
    counts: {
      records: uniqueRecords.length,
      usageRecords: uniqueRecords.filter((record) => record.kind === "usage").length,
      quotaRecords: 0,
      artifacts: artifacts.length,
    },
  };
}

export function ingestClaudeDesktopShadowBatch(store, input) {
  if (!store || typeof store.ingest !== "function" || typeof store.putArtifact !== "function") {
    fail("store");
  }
  const batch = input?.records && input?.artifacts
    ? input
    : buildClaudeDesktopShadowBatch(input);
  const merged = store.ingest(batch.records, { acceptedAtMs: input?.acceptedAtMs ?? Date.now() });
  let insertedArtifacts = 0;
  let duplicateArtifacts = 0;
  let tombstonedArtifacts = 0;
  for (const artifact of batch.artifacts) {
    const result = store.putArtifact(artifact, { updatedAtMs: input?.acceptedAtMs ?? Date.now() });
    insertedArtifacts += result.inserted ?? 0;
    duplicateArtifacts += result.duplicate ? 1 : 0;
    tombstonedArtifacts += result.tombstoned ?? 0;
  }
  const status = merged.status === "disabled" ? "disabled" : "enabled";
  return {
    schemaVersion: CLAUDE_DESKTOP_SHADOW_REFRESH_VERSION,
    provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
    status,
    records: merged,
    artifacts: {
      inserted: insertedArtifacts,
      duplicates: duplicateArtifacts,
      tombstoned: tombstonedArtifacts,
    },
    batchCounts: batch.counts,
  };
}

/**
 * Optional wrapper for the real incremental refresh. With the default
 * `enabled: false` it runs no shadow writes and creates no shadow state. When
 * explicitly enabled, it owns only the separate local shadow namespace and
 * passes a digest-only sink into the existing refresh; Codex tables remain
 * untouched by this lane.
 */
export async function runClaudeDesktopShadowRefresh({
  refreshOptions = {},
  incrementalResult = null,
  incrementalRefresh = runClaudeDesktopIncrementalRefresh,
  shadowStore = null,
  shadowStatePath = null,
  enabled = false,
  sourceGeneration = 1,
  acceptedAtMs = Date.now(),
} = {}) {
  if (!refreshOptions || typeof refreshOptions !== "object" || Array.isArray(refreshOptions)) {
    fail("configuration");
  }
  if (shadowStore && shadowStatePath !== null) fail("configuration");
  let store = shadowStore;
  let ownsStore = false;
  if (!store && enabled === true) {
    store = openClaudeDesktopShadowStore({ statePath: shadowStatePath, enabled: true });
    ownsStore = true;
  }
  const ingest = (payload) => {
    if (!store) {
      return {
        schemaVersion: CLAUDE_DESKTOP_SHADOW_REFRESH_VERSION,
        provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
        status: "disabled",
        records: { status: "disabled", inserted: 0, duplicates: 0, tombstoned: 0 },
        artifacts: { inserted: 0, duplicates: 0, tombstoned: 0 },
        batchCounts: { records: 0, usageRecords: 0, quotaRecords: 0, artifacts: 0 },
      };
    }
    return ingestClaudeDesktopShadowBatch(store, {
      ...payload,
      sourceGeneration,
      acceptedAtMs,
    });
  };
  try {
    let result = incrementalResult;
    let shadow = null;
    if (result === null) {
      if (typeof incrementalRefresh !== "function") fail("refresh");
      if (store && (typeof refreshOptions.pricingCachePath !== "string"
          || refreshOptions.pricingCachePath.length === 0)) {
        // Enabling the shadow lane must never silently reactivate the row-rich
        // debug pricing projection that fails the realistic memory gate.
        fail("pricing_cache_required");
      }
      result = await incrementalRefresh({
        ...refreshOptions,
        shadowSink: store ? ingest : undefined,
      });
      shadow = result.shadow ?? null;
    }
    if (result === null || typeof result !== "object" || Array.isArray(result)) fail("result");
    if (store && shadow === null) {
      shadow = ingest({
      canonical: result.canonicalInput ?? result.canonical ?? null,
        projection: result.projection ?? null,
        pricingProjection: result.pricingProjection ?? null,
        pricingSummary: result.pricingSummary ?? null,
      });
    }
    return {
      ...result,
      shadow: shadow ?? ingest(null),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export { ClaudeDesktopShadowRefreshError };
