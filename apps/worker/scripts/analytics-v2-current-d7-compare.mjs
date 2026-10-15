#!/usr/bin/env node
// Explicit v3 current D1/D7 comparison. This module consumes only accepted,
// current-source evidence and saved DTOs; it never computes analytics or reads
// PostgreSQL. The v2 comparator remains a separate, unchanged mode.

import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CURRENT_Q1_D7_NOW_MS,
  validateCurrentQ1D7Binding,
  validateCurrentQ1D7ProducerAcceptance,
} from "../postgres-test/fixtures/current-q1-d7-contract.mjs";

// Resolve Vite from this Worker package boundary. Vite's public SSR loader is
// the current-Q1 source-capture seam; direct Node imports of owning .ts files
// cannot resolve their extensionless internal imports. Load only this explicit
// authority allowlist, close Vite, then retain the pure source functions.
const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const VITE_MODULE_PATHS = Object.freeze([
  ["admin", "/src/admin-community-allowance.ts"],
  ["dailySpend", "/src/community-daily-spend.ts"],
  ["breakdowns", "/src/analytics-v2/public-allowance-breakdowns-v13.ts"],
  ["metadata", "/src/analytics-v2/public-model-metadata-current.ts"],
  ["cache", "/src/cache-retention-values.ts"],
  ["telemetry", "/node_modules/@app-usagemonitor/telemetry-contract/index.js"],
]);
// This is the exact closed Vite module graph for the current DTO authority
// entrypoints on source 879e5e. Hash it before/after load and require the graph
// to remain exact, so a long-lived Node process cannot retain old factories
// while accepting newer source pins.
const CURRENT_DTO_SOURCE_PATHS = Object.freeze([
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/index.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/admin-model-history.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/constants.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/envelope.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/errors.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog-contract.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/performance-histogram.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/primitives.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-performance-v1.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v0.1.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v0.2.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v1.1-domain.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v1.1.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v1.2-domain.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/telemetry-v1.2.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/upload.js",
  "apps/worker/src/admin-community-allowance.ts",
  "apps/worker/src/admin-operations.ts",
  "apps/worker/src/analytics-v2/public-allowance-breakdowns-v13.ts",
  "apps/worker/src/analytics-v2/public-allowance-breakdowns-v14.ts",
  "apps/worker/src/analytics-v2/public-allowance-breakdowns-v15.ts",
  "apps/worker/src/analytics-v2/public-model-metadata-current.ts",
  "apps/worker/src/cache-retention-values.ts",
  "apps/worker/src/canonical-json.ts",
  "apps/worker/src/collection-controls.ts",
  "apps/worker/src/community-allowance.ts",
  "apps/worker/src/community-analysis-queue.ts",
  "apps/worker/src/community-daily-spend.ts",
  "apps/worker/src/community-publication.ts",
  "apps/worker/src/constants.ts",
  "apps/worker/src/crypto.ts",
  "apps/worker/src/errors.ts",
  "apps/worker/src/host-primitives.ts",
  "apps/worker/src/model-history-window.ts",
  "apps/worker/src/quarantine-reconciliation.ts",
  "apps/worker/src/quota-analysis-v1-reader.ts",
  "apps/worker/src/quota-analysis-v1.ts",
  "apps/worker/src/quota-analysis-v11-contract.ts",
  "apps/worker/src/quota-analysis-v11-reader.ts",
  "apps/worker/src/quota-analysis-v11.ts",
  "apps/worker/src/quota-analysis.ts",
  "apps/worker/src/quota-endpoint-collapse.ts",
  "apps/worker/src/server-pricing.ts",
  "apps/worker/src/storage-admin-overview.ts",
  "apps/worker/src/stored-record.ts",
  "apps/worker/src/strict-json.ts",
  "apps/worker/src/telemetry-transport-policy.ts",
  "apps/worker/src/telemetry-v1-source-selection.ts",
  "apps/worker/src/telemetry-v1.ts",
  "apps/worker/src/telemetry-v11-compatibility.ts",
  "apps/worker/src/telemetry-v11-domain.ts",
  "apps/worker/src/telemetry-v12-table.ts",
  "apps/worker/src/telemetry-validation.ts",
  "apps/worker/src/typed-telemetry-codec.ts",
  "apps/worker/src/typed-telemetry-compatibility.ts",
  "apps/worker/src/typed-telemetry-read-layout.ts",
  "apps/worker/src/typed-v1-analysis-reader.ts",
  "apps/worker/src/typed-v11-analysis-reader.ts",
  "apps/worker/src/typed-v11-quota-reader.ts",
]);
export const CURRENT_Q1_D7_VITE_SERVER_POLICY = Object.freeze({
  configFile: false,
  envDir: false,
  appType: "custom",
  logLevel: "silent",
  server: Object.freeze({ middlewareMode: true, hmr: false, ws: false, watch: null }),
});
const DTO_AUTHORITY_KEYS = Object.freeze([
  "ADMIN_MODEL_HISTORY_CATALOG_VERSION", "projectAdminModelHistoryDay", "ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG",
  "COMMUNITY_DAILY_SPEND_BASIS", "COMMUNITY_DAILY_SPEND_PRICING_METHOD", "COMMUNITY_DAILY_SPEND_REGISTRY_SHA256",
  "isCurrentCommunityDailySpend", "PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS", "isPublicModelMetadataBlock",
  "buildCurrentPublicModelMetadata", "CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION", "CACHE_RETENTION_BAND_IDS",
  "CACHE_RETENTION_METHOD", "CACHE_RETENTION_METRIC_ID", "CACHE_RETENTION_PUBLIC_MODEL_LIMIT",
  "CACHE_RETENTION_PUBLIC_SCHEMA_VERSION", "CACHE_RETENTION_WINDOWS", "publicCacheRetentionCurve",
  "publicCacheRetentionWindow", "validCacheRetentionBandCounters",
]);
const DTO_AUTHORITY_FUNCTIONS = new Set([
  "projectAdminModelHistoryDay", "isCurrentCommunityDailySpend", "isPublicModelMetadataBlock",
  "buildCurrentPublicModelMetadata", "publicCacheRetentionCurve", "publicCacheRetentionWindow",
  "validCacheRetentionBandCounters",
]);
const DTO_AUTHORITY_ARRAYS = new Set([
  "ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG", "PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS", "CACHE_RETENTION_BAND_IDS",
  "CACHE_RETENTION_WINDOWS",
]);
const DTO_AUTHORITY_STRINGS = new Set([
  "ADMIN_MODEL_HISTORY_CATALOG_VERSION", "COMMUNITY_DAILY_SPEND_BASIS", "COMMUNITY_DAILY_SPEND_PRICING_METHOD",
  "COMMUNITY_DAILY_SPEND_REGISTRY_SHA256", "CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION",
  "CACHE_RETENTION_METRIC_ID", "CACHE_RETENTION_PUBLIC_SCHEMA_VERSION",
]);

function assertD7ScratchIdentity(before, after) {
  if (!before?.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid()
      || (before.mode & 0o077) !== 0 || !after?.isDirectory() || after.isSymbolicLink()
      || after.uid !== process.getuid() || after.dev !== before.dev || after.ino !== before.ino
      || (after.mode & 0o077) !== 0) {
    throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_CLEANUP_FAILED");
  }
}

function freezeAuthorityData(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeAuthorityData));
  if (!isPlainObject(value)) return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeAuthorityData(child)])));
}

async function captureCurrentDtoSourceHashes() {
  const hashes = Object.create(null);
  for (const path of CURRENT_DTO_SOURCE_PATHS) {
    const bytes = await readFile(resolve(REPOSITORY_ROOT, ...path.split("/")));
    hashes[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return Object.freeze(hashes);
}

async function currentLoadedDtoGraphPaths(vite) {
  const moduleGraph = vite.environments?.ssr?.moduleGraph;
  if (typeof moduleGraph?.getModuleByUrl !== "function") {
    throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID");
  }
  const packageEntry = await realpath(join(WORKER_ROOT, "node_modules/@app-usagemonitor/telemetry-contract/index.js"));
  const canonicalRepositoryRoot = resolve(packageEntry, "../../../../../..");
  const repositoryRoots = [...new Set([await realpath(REPOSITORY_ROOT), canonicalRepositoryRoot])];
  const roots = await Promise.all(VITE_MODULE_PATHS.map(([, url]) => moduleGraph.getModuleByUrl(url)));
  if (roots.some((module) => !module)) throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID");
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const module = pending.pop();
    if (visited.has(module)) continue;
    visited.add(module);
    for (const imported of module.importedModules ?? []) pending.push(imported);
  }
  const paths = new Set();
  for (const module of visited) {
    if (!module.file) continue;
    const info = await lstat(module.file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID");
    }
    const canonicalFile = await realpath(module.file);
    let path;
    for (const root of repositoryRoots) {
      const relativePath = relative(root, canonicalFile);
      if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
          && !isAbsolute(relativePath)) {
        path = relativePath.split(sep).join("/");
        break;
      }
    }
    if (!path) throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID");
    paths.add(path);
  }
  return [...paths].sort();
}

function sameOrderedStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameSourceHashes(left, right) {
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((path) => left[path] === right[path]);
}

async function loadCurrentD7DtoAuthority() {
  const workerRequire = createRequire(join(WORKER_ROOT, "package.json"));
  let vite;
  let cacheRoot;
  let cacheIdentity;
  let sourceHashesBefore;
  let sourceGraphPaths;
  let sourceAuthority;
  try {
    cacheRoot = await mkdtemp(join(tmpdir(), "tibotattle-current-d7-dto-vite-"));
    cacheIdentity = await lstat(cacheRoot);
    if (!cacheIdentity.isDirectory() || cacheIdentity.isSymbolicLink() || cacheIdentity.uid !== process.getuid()
        || (cacheIdentity.mode & 0o077) !== 0) {
      throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_SCRATCH_INVALID");
    }
    await chmod(cacheRoot, 0o700);
    const viteEntry = workerRequire.resolve("vite");
    const { createServer } = await import(pathToFileURL(viteEntry).href);
    vite = await createServer({ root: WORKER_ROOT, cacheDir: cacheRoot,
      ...CURRENT_Q1_D7_VITE_SERVER_POLICY, server: { ...CURRENT_Q1_D7_VITE_SERVER_POLICY.server } });
    sourceHashesBefore = await captureCurrentDtoSourceHashes();
    const loaded = Object.create(null);
    for (const [name, path] of VITE_MODULE_PATHS) loaded[name] = await vite.ssrLoadModule(path);
    sourceGraphPaths = await currentLoadedDtoGraphPaths(vite);
    if (!sameOrderedStrings(sourceGraphPaths, CURRENT_DTO_SOURCE_PATHS)) {
      throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID");
    }
    const selectedAuthority = {
      ADMIN_MODEL_HISTORY_CATALOG_VERSION: loaded.telemetry.ADMIN_MODEL_HISTORY_CATALOG_VERSION,
      projectAdminModelHistoryDay: loaded.telemetry.projectAdminModelHistoryDay,
      ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG: loaded.admin.ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
      COMMUNITY_DAILY_SPEND_BASIS: loaded.dailySpend.COMMUNITY_DAILY_SPEND_BASIS,
      COMMUNITY_DAILY_SPEND_PRICING_METHOD: loaded.dailySpend.COMMUNITY_DAILY_SPEND_PRICING_METHOD,
      COMMUNITY_DAILY_SPEND_REGISTRY_SHA256: loaded.dailySpend.COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
      isCurrentCommunityDailySpend: loaded.dailySpend.isCurrentCommunityDailySpend,
      PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS: loaded.breakdowns.PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS,
      isPublicModelMetadataBlock: loaded.breakdowns.isPublicModelMetadataBlock,
      buildCurrentPublicModelMetadata: loaded.metadata.buildCurrentPublicModelMetadata,
      CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION: loaded.metadata.CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION,
      CACHE_RETENTION_BAND_IDS: loaded.cache.CACHE_RETENTION_BAND_IDS,
      CACHE_RETENTION_METHOD: loaded.cache.CACHE_RETENTION_METHOD,
      CACHE_RETENTION_METRIC_ID: loaded.cache.CACHE_RETENTION_METRIC_ID,
      CACHE_RETENTION_PUBLIC_MODEL_LIMIT: loaded.cache.CACHE_RETENTION_PUBLIC_MODEL_LIMIT,
      CACHE_RETENTION_PUBLIC_SCHEMA_VERSION: loaded.cache.CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
      CACHE_RETENTION_WINDOWS: loaded.cache.CACHE_RETENTION_WINDOWS,
      publicCacheRetentionCurve: loaded.cache.publicCacheRetentionCurve,
      publicCacheRetentionWindow: loaded.cache.publicCacheRetentionWindow,
      validCacheRetentionBandCounters: loaded.cache.validCacheRetentionBandCounters,
    };
    sourceAuthority = Object.freeze(Object.fromEntries(DTO_AUTHORITY_KEYS.map((key) => [key,
      DTO_AUTHORITY_FUNCTIONS.has(key) ? selectedAuthority[key] : freezeAuthorityData(selectedAuthority[key])] )));
    const keys = Object.keys(sourceAuthority);
    if (keys.length !== DTO_AUTHORITY_KEYS.length || keys.some((key) => !DTO_AUTHORITY_KEYS.includes(key))) {
      throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_AUTHORITY_INVALID");
    }
    for (const key of DTO_AUTHORITY_KEYS) {
      const value = sourceAuthority[key];
      if (DTO_AUTHORITY_FUNCTIONS.has(key) ? typeof value !== "function"
        : DTO_AUTHORITY_ARRAYS.has(key) ? !Array.isArray(value)
          : DTO_AUTHORITY_STRINGS.has(key) ? typeof value !== "string"
            : key === "CACHE_RETENTION_METHOD" ? !isPlainObject(value)
              : key === "CACHE_RETENTION_PUBLIC_MODEL_LIMIT" ? !Number.isSafeInteger(value)
                : true) {
        throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_AUTHORITY_INVALID");
      }
    }
  } catch (error) {
    if (error?.message === "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_SCRATCH_INVALID"
        || error?.message === "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_AUTHORITY_INVALID"
        || error?.message === "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_GRAPH_INVALID"
        || error?.message === "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_SOURCE_CHANGED"
        || error?.message === "ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_CLEANUP_FAILED") throw error;
    throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_FAILED");
  } finally {
    try {
      await vite?.close();
    } catch {
      throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_CLEANUP_FAILED");
    } finally {
      if (cacheRoot && cacheIdentity) {
        try {
          const after = await lstat(cacheRoot);
          assertD7ScratchIdentity(cacheIdentity, after);
          await rm(cacheRoot, { recursive: true });
        } catch {
          throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_CLEANUP_FAILED");
        }
      }
    }
  }
  let sourceHashesAfter;
  try { sourceHashesAfter = await captureCurrentDtoSourceHashes(); }
  catch { throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_FAILED"); }
  if (!sameSourceHashes(sourceHashesBefore, sourceHashesAfter)
      || !sameOrderedStrings(sourceGraphPaths, CURRENT_DTO_SOURCE_PATHS)) {
    throw new Error("ANALYTICS_V2_CURRENT_D7_SOURCE_LOADER_SOURCE_CHANGED");
  }
  return Object.freeze({ authority: sourceAuthority, sourceSha256: sourceHashesAfter });
}

const LOADED_DTO_SOURCE = await loadCurrentD7DtoAuthority();
export const CURRENT_Q1_D7_DTO_AUTHORITY = LOADED_DTO_SOURCE.authority;
export const CURRENT_Q1_D7_DTO_SOURCE_SHA256 = LOADED_DTO_SOURCE.sourceSha256;
const {
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay,
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  COMMUNITY_DAILY_SPEND_BASIS,
  COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  isCurrentCommunityDailySpend,
  PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS,
  isPublicModelMetadataBlock,
  buildCurrentPublicModelMetadata,
  CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION,
  CACHE_RETENTION_BAND_IDS,
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_MODEL_LIMIT,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  publicCacheRetentionCurve,
  publicCacheRetentionWindow,
  validCacheRetentionBandCounters,
} = CURRENT_Q1_D7_DTO_AUTHORITY;

export const ANALYTICS_V2_CURRENT_D7_CONTRACT_REPORT_VERSION = "analytics-v2-current-d7-contract-report-v3";
export const ANALYTICS_V2_CURRENT_D7_MODE = "current-worker-d1-d7";
export const ANALYTICS_V2_CURRENT_D7_NORMALIZATIONS = Object.freeze([
  "days[].revision", "days[].releasedAt", "payload.revision", "payload.releasedAt",
  "payload.aggregateId :r<revision> suffix",
]);

const CASE_IDS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const MAX_DIFFS = 80;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const INPUT_KEYS = Object.freeze(["inputBinding", "binding", "cases", "expectations", "expectationSha256", "pgInputs",
  "producerAcceptance", "expectedController"]);
const CASE_INPUT_KEYS = Object.freeze(["caseId", "reference", "expectation", "actualResponse", "actualPreview", "currentDay"]);
const SAFE_FIELDS = new Set(["schemaVersion", "from", "to", "allowanceState", "allowanceReadState", "allowanceBreakdowns",
  "basis", "generatedAt", "days", "day", "combined", "participantCount", "byPlanType", "models", "cacheRetention",
  "windows", "revision", "releasedAt", "payload", "aggregateId", "totals", "usageEvents", "cells", "cellsTruncated",
  "apiEquivalentSpend", "knownCostUsd", "status", "body", "referencePlanType", "trailingDays", "qualification",
  "spanFloorPp", "coverage", "recentFittedParticipantCount", "noRecentFitParticipantCount", "gate", "modelConfig",
  "modelId", "catalogVersion", "values", "fittedParticipantCount", "unstableParticipantCount", "staleParticipantCount",
  "refusedParticipantCount", "v1ParticipantCount", "unsupportedSourceParticipantCount"]);
const DAY_READ_KEYS = Object.freeze(["schemaVersion", "from", "to", "allowanceState", "allowanceReadState",
  "allowanceBreakdowns", "cacheRetention", "days"]);
const DAILY_WRAPPER_KEYS = Object.freeze(["day", "revision", "releasedAt", "payload"]);
const DAILY_PAYLOAD_KEYS = Object.freeze(["schemaVersion", "aggregateId", "day", "revision", "releasedAt",
  "immutableRevision", "recomputesOnLateData", "policyVersion", "suppression", "totals", "cellsTruncated", "cells"]);
const DAILY_TOTAL_FIELDS = Object.freeze(["contributingParticipants", "contributingDevices", "usageEvents",
  "quotaObservations", "sessionDimensions", "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens"]);
const DAILY_CELL_COUNT_FIELDS = Object.freeze(["usageEvents", "inputUncachedTokens", "inputCacheReadTokens",
  "inputCacheWriteTokens", "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens"]);
const DAILY_SPEND_KEYS = Object.freeze(["basis", "currency", "knownCostUsd", "coverage", "usageEvents",
  "fullyPricedUsageEvents", "partiallyPricedUsageEvents", "unpricedUsageEvents", "pricingMethodVersion", "registrySha256"]);
const DAILY_ALLOWANCE_KEYS = Object.freeze(["basis", "limitId", "referencePlanType", "normalization", "windowDurationMinutes",
  "trailingDays", "qualification", "spanFloorPp", "fitCount", "participantCount", "centralUsd", "band80Usd"]);
const PUBLIC_BREAKDOWN_KEYS = Object.freeze([...PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS, "modelConfig"]);
const PUBLIC_BREAKDOWN_DAY_KEYS = Object.freeze(["day", "combined", "byPlanType", "models"]);
const SUMMARY_KEYS = Object.freeze(["fitCount", "participantCount", "centralUsd", "band80Usd"]);
const PREVIEW_COVERAGE_KEYS = Object.freeze(["uploadingParticipantCount", "cachedParticipantCount", "recentFittedParticipantCount",
  "mergeEligibleParticipantCount", "noQualifyingFitParticipantCount", "noRecentFitParticipantCount", "unsupportedPlanParticipantCount"]);
const ADMIN_PREVIEW_KEYS = Object.freeze(["schemaVersion", "generatedAt", "from", "to", "basis", "referencePlanType",
  "trailingDays", "qualification", "spanFloorPp", "plans", "coverage", "days", "models"]);
const PLAN_TYPES = Object.freeze(["pro", "prolite", "promax", "plus"]);
const PREVIEW_PLANS = Object.freeze([
  { planType: "pro", label: "Pro 20x", multiplier: 1 },
  { planType: "prolite", label: "Pro 5x", multiplier: 4 },
  { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
  { planType: "plus", label: "Plus", multiplier: 20 },
]);
const CURRENT_ALLOWANCE_BASIS = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25";
const CURRENT_ALLOWANCE_NORMALIZATION = "pro_x1_prolite_x4_promax_x0_8_plus_x20";
const CURRENT_QUALIFICATION = "shared_reset_fit_gates_25pp_span_floor";
const CURRENT_MODEL_BASIS = "seven_day_codex_pro20x_equivalent_per_model_composition_promax25";
const CURRENT_MODEL_GATE = "shared_composition_kernel_identification";
const CURRENT_MODEL_CATALOG_VERSION = CURRENT_PUBLIC_MODEL_METADATA_CATALOG_VERSION;
const CURRENT_ADMIN_MODEL_CONFIG = Object.freeze(ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG.map((entry) => ({ ...entry })));
const CURRENT_PRIMARY_MODEL_IDS = new Set(CURRENT_ADMIN_MODEL_CONFIG
  .filter((entry) => entry.allowanceTrack === "primary" && entry.pricingStatus === "published")
  .map((entry) => entry.modelId));
const CURRENT_PUBLIC_METADATA = Object.freeze(buildCurrentPublicModelMetadata().map((entry) => ({ ...entry })));
const CURRENT_CACHE_WINDOWS = Object.freeze(CACHE_RETENTION_WINDOWS.map(({ id, days }) => ({ window: id, days })));
const CACHE_BAND_KEYS = Object.freeze(["band", "startMs", "endMs", "adjacencies", "sessions", "contributors",
  "reusedMoreThanHalf", "matchedOrExceeded", "reusedMoreThanHalfRate", "matchedOrExceededRate", "topContributorShare",
  "excludedInsufficientEvidence", "excludedContextContracted", "unorderedTies"]);
const CACHE_COUNTER_KEYS = Object.freeze(["band", "adjacencies", "reusedMoreThanHalf", "matchedOrExceeded", "unorderedTies",
  "excludedInsufficientEvidence", "excludedContextContracted", "sessions"]);
const CACHE_SERIES_KEYS = Object.freeze(["schemaVersion", "metric", "methodVersion", "measures", "gapBasis", "windows"]);
const CACHE_WINDOW_KEYS = Object.freeze(["window", "days", "bands", "byModel", "modelsTruncated"]);
const CACHE_MODEL_KEYS = Object.freeze(["model", "bands"]);
const CACHE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const CURRENT_DAILY_POLICY_VERSION = "community-daily-v1.0";
const CURRENT_DAILY_SUPPRESSION = "none_daily_grain_by_owner_decision";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dtoInvalid() {
  throw new TypeError("ANALYTICS_V2_CURRENT_D7_DTO_INVALID");
}

function closedKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return false;
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function exactKeyOrder(value, expected) {
  return isPlainObject(value) && Object.keys(value).length === expected.length
    && Object.keys(value).every((key, index) => key === expected[index]);
}

function requireClosedKeys(value, required, optional = []) {
  if (!closedKeys(value, required, optional)) dtoInvalid();
}

function currentDateRange(from, count) {
  if (!isDay(from) || !Number.isSafeInteger(count) || count < 1 || count > 70) dtoInvalid();
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) dtoInvalid();
  return value;
}

function requireFiniteNonNegative(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) dtoInvalid();
  return value;
}

function currentExpectedPublicMetadata() {
  if (ADMIN_MODEL_HISTORY_CATALOG_VERSION !== CURRENT_MODEL_CATALOG_VERSION
      || !isPublicModelMetadataBlock(CURRENT_PUBLIC_METADATA)) dtoInvalid();
  return CURRENT_PUBLIC_METADATA;
}

function validateCurrentModelDay(value, expectedDay) {
  if (!isPlainObject(value) || value.day !== expectedDay
      || value.catalogVersion !== ADMIN_MODEL_HISTORY_CATALOG_VERSION) dtoInvalid();
  let projected;
  try { projected = projectAdminModelHistoryDay(value); } catch { dtoInvalid(); }
  if (projected === null || projected === undefined || projected.catalogVersion !== CURRENT_MODEL_CATALOG_VERSION
      || !same(projected, value)) dtoInvalid();
  for (const tuple of projected.values) {
    if (!CURRENT_PRIMARY_MODEL_IDS.has(tuple[0])) dtoInvalid();
  }
  return projected;
}

function validateCurrentExpectation(expectation, graphDays) {
  if (!isPlainObject(expectation) || !Array.isArray(expectation.days) || expectation.days.length !== 70
      || !same(expectation.days.map((entry) => entry?.day), graphDays)) dtoInvalid();
  const values = new Map();
  expectation.days.forEach((entry, index) => values.set(graphDays[index], validateCurrentModelDay(entry, graphDays[index])));
  return values;
}

function validateAllowanceSummary(value) {
  requireClosedKeys(value, SUMMARY_KEYS);
  const fits = requireCount(value.fitCount);
  const participants = requireCount(value.participantCount);
  if (participants > fits) dtoInvalid();
  if (fits === 0) {
    if (participants !== 0 || value.centralUsd !== null || value.band80Usd !== null) dtoInvalid();
    return value;
  }
  if (participants < 1) dtoInvalid();
  const central = requireFiniteNonNegative(value.centralUsd);
  if (fits < 3) {
    if (value.band80Usd !== null) dtoInvalid();
    return value;
  }
  requireClosedKeys(value.band80Usd, ["lowerUsd", "upperUsd"]);
  const lower = requireFiniteNonNegative(value.band80Usd.lowerUsd);
  const upper = requireFiniteNonNegative(value.band80Usd.upperUsd);
  if (lower > central || central > upper) dtoInvalid();
  return value;
}

function validateCurrentAdminPreview(preview, graphDays, pinnedNowMs) {
  requireClosedKeys(preview, ADMIN_PREVIEW_KEYS);
  if (preview.schemaVersion !== "admin-community-allowance-preview-v0.5"
      || preview.generatedAt !== new Date(pinnedNowMs).toISOString()
      || !isCanonicalInstant(preview.generatedAt)
      || preview.from !== graphDays[0] || preview.to !== graphDays.at(-1)
      || preview.basis !== `${CURRENT_ALLOWANCE_BASIS}_preview`
      || preview.referencePlanType !== "pro" || preview.trailingDays !== 30
      || preview.qualification !== CURRENT_QUALIFICATION || preview.spanFloorPp !== 25
      || !Array.isArray(preview.plans) || !same(preview.plans, PREVIEW_PLANS)) dtoInvalid();

  if (!Array.isArray(preview.days) || preview.days.length !== 70
      || !same(preview.days.map((entry) => entry?.day), graphDays)) dtoInvalid();
  const daySummaries = new Map();
  preview.days.forEach((entry, index) => {
    requireClosedKeys(entry, ["day", "combined", "byPlanType"]);
    if (entry.day !== graphDays[index]) dtoInvalid();
    validateAllowanceSummary(entry.combined);
    requireClosedKeys(entry.byPlanType, PLAN_TYPES);
    let fitSum = 0, participantSum = 0, largestParticipants = 0;
    for (const plan of PLAN_TYPES) {
      const summary = validateAllowanceSummary(entry.byPlanType[plan]);
      fitSum += summary.fitCount;
      participantSum += summary.participantCount;
      largestParticipants = Math.max(largestParticipants, summary.participantCount);
    }
    if (!Number.isSafeInteger(fitSum) || !Number.isSafeInteger(participantSum)
        || entry.combined.fitCount !== fitSum
        || entry.combined.participantCount < largestParticipants
        || entry.combined.participantCount > participantSum) dtoInvalid();
    daySummaries.set(entry.day, entry);
  });

  requireClosedKeys(preview.coverage, PREVIEW_COVERAGE_KEYS);
  const coverage = Object.fromEntries(PREVIEW_COVERAGE_KEYS.map((key) => [key, requireCount(preview.coverage[key])]));
  if (coverage.cachedParticipantCount !== coverage.uploadingParticipantCount
      || coverage.recentFittedParticipantCount !== coverage.mergeEligibleParticipantCount + coverage.unsupportedPlanParticipantCount
      || coverage.uploadingParticipantCount !== coverage.noQualifyingFitParticipantCount
        + coverage.noRecentFitParticipantCount + coverage.recentFittedParticipantCount) dtoInvalid();

  requireClosedKeys(preview.models, ["modelConfig", "basis", "gate", "days"]);
  if (preview.models.basis !== CURRENT_MODEL_BASIS || preview.models.gate !== CURRENT_MODEL_GATE
      || !same(preview.models.modelConfig, CURRENT_ADMIN_MODEL_CONFIG)
      || !Array.isArray(preview.models.days) || preview.models.days.length > 70) dtoInvalid();
  let prior = "";
  const modelDays = new Map();
  for (const entry of preview.models.days) {
    if (!isPlainObject(entry) || !graphDays.includes(entry.day) || entry.day <= prior || modelDays.has(entry.day)) dtoInvalid();
    prior = entry.day;
    const projected = validateCurrentModelDay(entry, entry.day);
    modelDays.set(entry.day, projected);
  }
  const latest = daySummaries.get(graphDays.at(-1));
  if (!latest || latest.combined.participantCount !== coverage.mergeEligibleParticipantCount) dtoInvalid();
  return { daySummaries, modelDays };
}

function validateCurrentPublicSummary(value) {
  validateAllowanceSummary(value);
  return value;
}

function validatePublicBreakdownDays(value, publicDays) {
  if (!Array.isArray(value) || value.length !== publicDays.length
      || !same(value.map((entry) => entry?.day), publicDays)) dtoInvalid();
  const result = new Map();
  value.forEach((entry, index) => {
    requireClosedKeys(entry, PUBLIC_BREAKDOWN_DAY_KEYS);
    const day = publicDays[index];
    if (entry.day !== day) dtoInvalid();
    validateCurrentPublicSummary(entry.combined);
    requireClosedKeys(entry.byPlanType, PLAN_TYPES);
    for (const plan of PLAN_TYPES) validateCurrentPublicSummary(entry.byPlanType[plan]);
    if (!Array.isArray(entry.models) || entry.models.length > CURRENT_PRIMARY_MODEL_IDS.size) dtoInvalid();
    const seen = new Set();
    for (const tuple of entry.models) {
      if (!Array.isArray(tuple) || tuple.length !== 3 || typeof tuple[0] !== "string"
          || !CURRENT_PRIMARY_MODEL_IDS.has(tuple[0]) || seen.has(tuple[0])) dtoInvalid();
      seen.add(tuple[0]);
      requireFiniteNonNegative(tuple[1]);
      if (requireCount(tuple[2]) < 1) dtoInvalid();
    }
    result.set(day, entry);
  });
  return result;
}

function validateCurrentCacheBand(value, definition) {
  requireClosedKeys(value, CACHE_BAND_KEYS);
  if (value.band !== definition.id || value.startMs !== definition.startMs || value.endMs !== definition.endMs) dtoInvalid();
  const counters = Object.fromEntries(CACHE_COUNTER_KEYS.map((key) => [key, value[key]]));
  if (!validCacheRetentionBandCounters(counters)) dtoInvalid();
  const adjacencies = counters.adjacencies;
  const sessions = counters.sessions;
  const contributors = requireCount(value.contributors);
  if (adjacencies === 0
      ? sessions !== 0 || contributors !== 0 || counters.reusedMoreThanHalf !== 0 || counters.matchedOrExceeded !== 0
        || value.reusedMoreThanHalfRate !== null || value.matchedOrExceededRate !== null || value.topContributorShare !== null
      : sessions < 1 || contributors < 1 || contributors > sessions
        || value.reusedMoreThanHalfRate !== counters.reusedMoreThanHalf / adjacencies
        || value.matchedOrExceededRate !== counters.matchedOrExceeded / adjacencies
        || typeof value.topContributorShare !== "number" || !Number.isFinite(value.topContributorShare)
        || value.topContributorShare <= 0 || value.topContributorShare > 1) dtoInvalid();
  return { ...counters, contributors, reusedMoreThanHalfRate: value.reusedMoreThanHalfRate,
    matchedOrExceededRate: value.matchedOrExceededRate, topContributorShare: value.topContributorShare };
}

function validateCurrentCacheBands(value) {
  if (!Array.isArray(value) || value.length !== CACHE_RETENTION_BAND_IDS.length) dtoInvalid();
  const definitions = CACHE_RETENTION_METHOD.bands;
  if (!Array.isArray(definitions) || definitions.length !== value.length) dtoInvalid();
  const communityBands = value.map((entry, index) => validateCurrentCacheBand(entry, definitions[index]));
  let projected;
  try { projected = publicCacheRetentionCurve(communityBands, CACHE_RETENTION_METHOD.version).bands; } catch { dtoInvalid(); }
  if (!Array.isArray(projected) || !same(projected, value)) dtoInvalid();
  return communityBands;
}

function validateCurrentCacheRetention(value) {
  requireClosedKeys(value, CACHE_SERIES_KEYS);
  if (value.schemaVersion !== CACHE_RETENTION_PUBLIC_SCHEMA_VERSION
      || value.metric !== CACHE_RETENTION_METRIC_ID || value.methodVersion !== CACHE_RETENTION_METHOD.version
      || value.measures !== "consecutive_requests" || value.gapBasis !== "response_end_to_response_end"
      || !Array.isArray(value.windows) || value.windows.length !== CURRENT_CACHE_WINDOWS.length) dtoInvalid();
  value.windows.forEach((window, index) => {
    requireClosedKeys(window, CACHE_WINDOW_KEYS);
    const expectedWindow = CURRENT_CACHE_WINDOWS[index];
    if (window.window !== expectedWindow.window || window.days !== expectedWindow.days
        || typeof window.modelsTruncated !== "boolean" || !Array.isArray(window.byModel)
        || window.byModel.length > CACHE_RETENTION_PUBLIC_MODEL_LIMIT) dtoInvalid();
    const pooled = validateCurrentCacheBands(window.bands);
    const seenModels = new Set();
    for (const model of window.byModel) {
      requireClosedKeys(model, CACHE_MODEL_KEYS);
      if (typeof model.model !== "string" || !CACHE_TOKEN.test(model.model) || seenModels.has(model.model)) dtoInvalid();
      seenModels.add(model.model);
      validateCurrentCacheBands(model.bands);
    }
    try {
      const projection = publicCacheRetentionWindow({ window: expectedWindow.window, days: expectedWindow.days,
        pooled, modelRows: [] });
      if (projection.window !== window.window || projection.days !== window.days) dtoInvalid();
    } catch { dtoInvalid(); }
  });
  return value;
}

function validateCurrentDailySpend(value, usageEvents) {
  requireClosedKeys(value, DAILY_SPEND_KEYS);
  if (!isCurrentCommunityDailySpend(value) || value.basis !== COMMUNITY_DAILY_SPEND_BASIS || value.currency !== "USD"
      || value.pricingMethodVersion !== COMMUNITY_DAILY_SPEND_PRICING_METHOD
      || value.registrySha256 !== COMMUNITY_DAILY_SPEND_REGISTRY_SHA256) dtoInvalid();
  const events = requireCount(value.usageEvents);
  const full = requireCount(value.fullyPricedUsageEvents);
  const partial = requireCount(value.partiallyPricedUsageEvents);
  const unpriced = requireCount(value.unpricedUsageEvents);
  if (events !== usageEvents || full + partial + unpriced !== events) dtoInvalid();
  const known = events === 0 || full + partial > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  if (value.coverage !== coverage) dtoInvalid();
  if (known) {
    requireFiniteNonNegative(value.knownCostUsd);
    if (events === 0 && value.knownCostUsd !== 0) dtoInvalid();
  } else if (value.knownCostUsd !== null) dtoInvalid();
}

function validateCurrentDailyAllowance(value) {
  requireClosedKeys(value, DAILY_ALLOWANCE_KEYS);
  if (value.basis !== CURRENT_ALLOWANCE_BASIS || value.limitId !== "codex" || value.referencePlanType !== "pro"
      || value.normalization !== CURRENT_ALLOWANCE_NORMALIZATION || value.windowDurationMinutes !== 10080
      || value.trailingDays !== 30 || value.qualification !== CURRENT_QUALIFICATION || value.spanFloorPp !== 25) dtoInvalid();
  validateAllowanceSummary({ fitCount: value.fitCount, participantCount: value.participantCount,
    centralUsd: value.centralUsd, band80Usd: value.band80Usd });
}

function validateCurrentDailyPayload(entry, expectedDay) {
  requireClosedKeys(entry, DAILY_WRAPPER_KEYS);
  if (entry.day !== expectedDay || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || !isCanonicalInstant(entry.releasedAt)) dtoInvalid();
  requireClosedKeys(entry.payload, DAILY_PAYLOAD_KEYS, ["apiEquivalentSpend", "allowance"]);
  const payload = entry.payload;
  if (payload.schemaVersion !== "community-daily-aggregate-v1.0" || payload.day !== expectedDay
      || payload.revision !== entry.revision || payload.releasedAt !== entry.releasedAt
      || payload.aggregateId !== `community-daily:${expectedDay}:r${entry.revision}`
      || payload.immutableRevision !== true || payload.recomputesOnLateData !== true
      || payload.policyVersion !== CURRENT_DAILY_POLICY_VERSION || payload.suppression !== CURRENT_DAILY_SUPPRESSION
      || payload.cellsTruncated !== false) dtoInvalid();
  requireClosedKeys(payload.totals, DAILY_TOTAL_FIELDS);
  const totals = Object.fromEntries(DAILY_TOTAL_FIELDS.map((key) => [key, requireCount(payload.totals[key])]));
  if (totals.contributingParticipants > 4 || totals.contributingDevices < totals.contributingParticipants
      || totals.contributingDevices > 14832 || totals.usageEvents < 1) dtoInvalid();
  if (!Array.isArray(payload.cells) || payload.cells.length > 100) dtoInvalid();
  let priorCell = "";
  const sums = Object.fromEntries(DAILY_CELL_COUNT_FIELDS.map((key) => [key, 0]));
  for (const cell of payload.cells) {
    requireClosedKeys(cell, ["provider", "modelId", ...DAILY_CELL_COUNT_FIELDS]);
    if (cell.provider !== "openai_codex" || typeof cell.modelId !== "string"
        || !CURRENT_PRIMARY_MODEL_IDS.has(cell.modelId)) dtoInvalid();
    const order = `${cell.provider}\u0000${cell.modelId}`;
    if (order <= priorCell) dtoInvalid();
    priorCell = order;
    for (const key of DAILY_CELL_COUNT_FIELDS) sums[key] += requireCount(cell[key]);
    if (!Number.isSafeInteger(sums.usageEvents) || !Number.isSafeInteger(sums.inputUncachedTokens)
        || !Number.isSafeInteger(sums.inputCacheReadTokens) || !Number.isSafeInteger(sums.inputCacheWriteTokens)
        || !Number.isSafeInteger(sums.outputTextTokens) || !Number.isSafeInteger(sums.outputReasoningTokens)
        || !Number.isSafeInteger(sums.outputCombinedTokens)) dtoInvalid();
  }
  for (const key of DAILY_CELL_COUNT_FIELDS) if (sums[key] !== totals[key]) dtoInvalid();
  if (!Object.hasOwn(payload, "apiEquivalentSpend")) dtoInvalid();
  validateCurrentDailySpend(payload.apiEquivalentSpend, totals.usageEvents);
  if (Object.hasOwn(payload, "allowance")) validateCurrentDailyAllowance(payload.allowance);
  return entry;
}

function validateCurrentPublicResponse(value, graphDays) {
  requireClosedKeys(value, DAY_READ_KEYS);
  const currentDay = graphDays.at(-1);
  const publicDays = graphDays.filter((day) => day < currentDay);
  if (value.schemaVersion !== "community-daily-read-v1.0" || value.from !== graphDays[0] || value.to !== currentDay
      || value.allowanceState !== "ready" || value.allowanceReadState !== "confirmed"
      || !Array.isArray(value.days) || value.days.length !== graphDays.length
      || !same(value.days.map((entry) => entry?.day), graphDays)) dtoInvalid();
  value.days.forEach((entry, index) => validateCurrentDailyPayload(entry, graphDays[index]));

  const breakdowns = value.allowanceBreakdowns;
  if (!exactKeyOrder(breakdowns, PUBLIC_BREAKDOWN_KEYS)
      || breakdowns.schemaVersion !== "community-allowance-breakdowns-v1.5"
      || breakdowns.basis !== CURRENT_ALLOWANCE_BASIS || breakdowns.referencePlanType !== "pro"
      || breakdowns.normalization !== CURRENT_ALLOWANCE_NORMALIZATION || breakdowns.modelBasis !== CURRENT_MODEL_BASIS
      || breakdowns.modelGate !== CURRENT_MODEL_GATE || !isCanonicalInstant(breakdowns.generatedAt)
      || !same(breakdowns.modelConfig, currentExpectedPublicMetadata())) dtoInvalid();
  if (!isPublicModelMetadataBlock(breakdowns.modelConfig)) dtoInvalid();
  const publicModels = validatePublicBreakdownDays(breakdowns.days, publicDays);
  validateCurrentCacheRetention(value.cacheRetention);
  return { currentDay, publicDays, publicModels };
}

function requireCurrentDtoSourcePins(inputBinding, binding) {
  const pinnedHashes = (value) => {
    const files = value?.source?.files;
    if (!Array.isArray(files)) throw new TypeError("ANALYTICS_V2_CURRENT_D7_SOURCE_BINDING_INVALID");
    return new Map(files.map((file) => [file?.path, file?.sha256]));
  };
  const initial = pinnedHashes(inputBinding);
  const final = pinnedHashes(binding);
  for (const path of CURRENT_DTO_SOURCE_PATHS) {
    const loaded = CURRENT_Q1_D7_DTO_SOURCE_SHA256[path];
    let current;
    try {
      current = createHash("sha256").update(readFileSync(resolve(REPOSITORY_ROOT, ...path.split("/")))).digest("hex");
    } catch {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_SOURCE_BINDING_INVALID");
    }
    if (!/^[a-f0-9]{64}$/u.test(loaded ?? "") || initial.get(path) !== loaded || final.get(path) !== loaded
        || current !== loaded) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_SOURCE_BINDING_INVALID");
    }
  }
}

function validateCurrentDTOCase({ reference, expectation, actualResponse, actualPreview, currentDay, pinnedNowMs }) {
  const graphDays = reference.graphDays;
  if (!Array.isArray(graphDays) || graphDays.length !== 70 || graphDays.at(-1) !== currentDay
      || !same(graphDays, currentDateRange(graphDays[0], 70))) dtoInvalid();
  const expectedModels = validateCurrentExpectation(expectation, graphDays);
  const base = reference.snapshot?.publicResponse?.body;
  const candidate = actualResponse;
  const basePublic = validateCurrentPublicResponse(base, graphDays);
  const candidatePublic = validateCurrentPublicResponse(candidate, graphDays);
  if (!isPlainObject(actualPreview)) dtoInvalid();
  const basePreview = validateCurrentAdminPreview(reference.snapshot.adminPreview, graphDays, pinnedNowMs);
  const candidatePreview = validateCurrentAdminPreview(actualPreview, graphDays, pinnedNowMs);
  if (base.allowanceBreakdowns.generatedAt !== reference.snapshot.adminPreview.generatedAt
      || candidate.allowanceBreakdowns.generatedAt !== actualPreview.generatedAt) dtoInvalid();

  for (const day of basePublic.publicDays) {
    const publicEntry = basePublic.publicModels.get(day);
    const previewEntry = basePreview.modelDays.get(day);
    if (previewEntry ? !same(publicEntry?.models, previewEntry.values)
      : !Array.isArray(publicEntry?.models) || publicEntry.models.length !== 0) dtoInvalid();
  }
  for (const day of candidatePublic.publicDays) {
    const publicEntry = candidatePublic.publicModels.get(day);
    const previewEntry = candidatePreview.modelDays.get(day);
    if (!previewEntry || !same(publicEntry?.models, previewEntry.values)
        || !same(publicEntry?.combined, candidatePreview.daySummaries.get(day)?.combined)
        || !same(publicEntry?.byPlanType, candidatePreview.daySummaries.get(day)?.byPlanType)) dtoInvalid();
  }
  for (const day of basePublic.publicDays) {
    const publicEntry = basePublic.publicModels.get(day);
    const previewDay = basePreview.daySummaries.get(day);
    if (!same(publicEntry?.combined, previewDay?.combined) || !same(publicEntry?.byPlanType, previewDay?.byPlanType)) dtoInvalid();
  }
  return { expectedModels, basePublic, candidatePublic, basePreview, candidatePreview };
}

function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function sha256Json(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError("ANALYTICS_V2_CURRENT_D7_JSON_INVALID"); }
  if (typeof encoded !== "string") throw new TypeError("ANALYTICS_V2_CURRENT_D7_JSON_INVALID");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function safeSegment(value) {
  return SAFE_FIELDS.has(value) ? value : "<other-field>";
}

function safePath(path) {
  return path.replace(/\.([^.[\]]+)/gu, (_match, field) => `.${safeSegment(field)}`);
}

function shape(value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

function diffValues(expected, actual, path = "$", output = []) {
  if (output.length >= MAX_DIFFS) return output;
  if (Object.is(expected, actual)) return output;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (output.length >= MAX_DIFFS) break;
      if (index >= expected.length) output.push({ path: `${path}[${index}]`, expected: undefined, actual: actual[index] });
      else if (index >= actual.length) output.push({ path: `${path}[${index}]`, expected: expected[index], actual: undefined });
      else diffValues(expected[index], actual[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (output.length >= MAX_DIFFS) break;
      if (!Object.hasOwn(expected, key)) output.push({ path: `${path}.${safeSegment(key)}`, expected: undefined, actual: actual[key] });
      else if (!Object.hasOwn(actual, key)) output.push({ path: `${path}.${safeSegment(key)}`, expected: expected[key], actual: undefined });
      else diffValues(expected[key], actual[key], `${path}.${safeSegment(key)}`, output);
    }
    return output;
  }
  output.push({ path, expected, actual });
  return output;
}

function same(expected, actual) {
  return diffValues(expected, actual).length === 0;
}

function isPerDatePath(path) {
  return path.startsWith("modelPublicationDays") || path.startsWith("models[") || path.startsWith("publicModels[")
    || path.startsWith("publicResponse.allowanceBreakdowns.days[*].day")
    || /^publicResponse\.allowanceBreakdowns\.days\[\d+\]\.day$/u.test(path)
    || /^publicResponse\.allowanceBreakdowns\.days\[(?:\d+|\d{4}-\d{2}-\d{2})\]\.models(?:\[|$)/u.test(path)
    || path.startsWith("adminPreview.models.days");
}

function isWithheldModelProjectionPath(path, withheldDates) {
  const publicMatch = /^publicResponse\.allowanceBreakdowns\.days\[(\d{4}-\d{2}-\d{2})\]\.models$/u.exec(path);
  if (publicMatch) return withheldDates.has(publicMatch[1]);
  const previewMatch = /^adminPreview\.models\.days\[(\d{4}-\d{2}-\d{2})\]$/u.exec(path);
  return Boolean(previewMatch && withheldDates.has(previewMatch[1]));
}

function normalizedDay(entry) {
  const { revision: _revision, releasedAt: _releasedAt, payload, ...rest } = entry;
  const { revision: _payloadRevision, releasedAt: _payloadReleasedAt, aggregateId, ...payloadRest } = payload;
  return { ...rest, payload: {
    ...payloadRest,
    aggregateId: aggregateId.replace(/:r[1-9][0-9]*$/u, ""),
  } };
}

function validateCurrentD7Scheduler(value) {
  if (!isObject(value) || !Array.isArray(value.days)) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_SCHEDULE_INVALID");
  }
  let graphDays;
  try { graphDays = currentDateRange(value.from, 70); } catch {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_SCHEDULE_INVALID");
  }
  if (graphDays.at(-1) !== value.to || value.days.length !== graphDays.length) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_SCHEDULE_INVALID");
  }
  const seen = new Set();
  let previousDay = "";
  value.days.forEach((entry, index) => {
    const payload = entry?.payload;
    const releasedAt = entry?.releasedAt;
    const epoch = typeof releasedAt === "string" ? Date.parse(releasedAt) : NaN;
    if (!isObject(entry) || !isDay(entry.day) || entry.day !== graphDays[index] || !isObject(payload)
        || !Number.isSafeInteger(entry.revision) || entry.revision < 1
        || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== releasedAt
        || epoch > CURRENT_Q1_D7_NOW_MS
        || payload.day !== entry.day || payload.revision !== entry.revision
        || payload.releasedAt !== releasedAt
        || payload.aggregateId !== `community-daily:${entry.day}:r${entry.revision}`
        || seen.has(entry.day) || entry.day <= previousDay) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_SCHEDULE_INVALID");
    }
    seen.add(entry.day);
    previousDay = entry.day;
  });
  return graphDays;
}

/** Validate the existing scheduler contract before removing its five fields. */
export function normalizeCurrentD7Response(value) {
  const graphDays = validateCurrentD7Scheduler(value);
  // Close the full current DTO on both sides before removing scheduler fields.
  validateCurrentPublicResponse(value, graphDays);
  const days = value.days.map(normalizedDay);
  return { ...value, days };
}

function byDay(entries) {
  if (!Array.isArray(entries)) throw new TypeError("ANALYTICS_V2_CURRENT_D7_DAYS_INVALID");
  const result = new Map();
  for (const entry of entries) {
    if (!isObject(entry) || !isDay(entry.day) || result.has(entry.day)) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_DAYS_INVALID");
    }
    result.set(entry.day, entry);
  }
  return result;
}

function without(object, key) {
  if (!isObject(object)) return object;
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

function addDiffs(diffs, expected, actual, path) {
  for (const diff of diffValues(expected, actual, path)) {
    if (diffs.length >= MAX_DIFFS) break;
    diffs.push({ path: safePath(diff.path), expected: shape(diff.expected), actual: shape(diff.actual) });
  }
}

function exactDayInventory(reference, expectation) {
  const inventory = byDay(reference.publicationInventory);
  const expected = byDay(expectation.days);
  const graphDays = reference.graphDays;
  const inventoryDays = reference.publicationInventory.map((entry) => entry.day);
  const expectedDays = expectation.days.map((entry) => entry.day);
  if (!Array.isArray(graphDays) || graphDays.length !== 70 || inventory.size !== 70 || expected.size !== 70
      || !same(inventoryDays, graphDays) || !same(expectedDays, graphDays)) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_INVENTORY_INVALID");
  }
  return { inventory, expected, graphDays };
}

/**
 * Compare one already-validated case's reference snapshot with candidate DTOs.
 * The negative case can vary only the two model projections for dates the
 * current D1 inventory proves withheld. The positive case is fully strict.
 */
export function compareCurrentQ1D7CaseDTOs({ caseId, reference, expectation, actualResponse, actualPreview, currentDay }) {
  if (!CASE_IDS.includes(caseId) || !isObject(reference) || !isObject(reference.snapshot)
      || !isObject(reference.snapshot.publicResponse) || reference.snapshot.publicResponse.status !== 200
      || !isObject(reference.snapshot.publicResponse.body) || !isObject(reference.snapshot.adminPreview)) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_CASE_INVALID");
  }
  const { inventory, expected, graphDays } = exactDayInventory(reference, expectation);
  if (!isDay(currentDay) || graphDays.at(-1) !== currentDay) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_CURRENT_DAY_INVALID");
  }
  validateCurrentD7Scheduler(reference.snapshot.publicResponse.body);
  validateCurrentD7Scheduler(actualResponse);
  validateCurrentDTOCase({ reference, expectation, actualResponse, actualPreview, currentDay,
    pinnedNowMs: CURRENT_Q1_D7_NOW_MS });
  const expectedPublicDays = graphDays.filter((day) => day < currentDay);
  const baseResponse = normalizeCurrentD7Response(reference.snapshot.publicResponse.body);
  const candidateResponse = normalizeCurrentD7Response(actualResponse);
  const basePreview = reference.snapshot.adminPreview;
  if (!isObject(actualPreview)) throw new TypeError("ANALYTICS_V2_CURRENT_D7_PREVIEW_INVALID");
  const differences = [];

  if (caseId === "conflictFreePositive") {
    if ([...inventory.values()].some((entry) => entry.state !== "published")) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_POSITIVE_INVENTORY_INVALID");
    }
    const basePublicDays = byDay(baseResponse.allowanceBreakdowns?.days);
    const basePreviewDays = byDay(candidatePreviewDays(basePreview));
    const candidatePublicDays = byDay(candidateResponse.allowanceBreakdowns?.days);
    const candidatePreviewMap = byDay(candidatePreviewDays(actualPreview));
    if (!same([...basePublicDays.keys()], expectedPublicDays)
        || !same([...basePreviewDays.keys()], graphDays)) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_REFERENCE_DAY_SET_INVALID");
    }
    addDiffs(differences, baseResponse, candidateResponse, "publicResponse");
    addDiffs(differences, basePreview, actualPreview, "adminPreview");
    if (!same([...candidatePublicDays.keys()], expectedPublicDays)
        || !same([...candidatePreviewMap.keys()], graphDays)) {
      differences.push({ path: "modelPublicationDays", expected: "canonical current day sets", actual: "candidate mismatch" });
    }
    for (const day of graphDays) {
      const dto = expected.get(day);
      const previewEntry = candidatePreviewMap.get(day);
      if (!dto || !previewEntry || !same(previewEntry, dto)
          || (expectedPublicDays.includes(day) && !candidatePublicDays.has(day))) {
        differences.push({ path: `models[${day}]`, expected: "current per-date DTO", actual: "candidate mismatch" });
      }
      if (expectedPublicDays.includes(day)) {
        const publicEntry = candidatePublicDays.get(day);
        if (!publicEntry || !same(publicEntry.models, dto?.values)
          || !same(previewEntry, dto)) {
          differences.push({ path: `publicModels[${day}]`, expected: "current public projection", actual: "candidate mismatch" });
        }
      }
    }
  } else {
    const withheld = [...inventory.values()].filter((entry) => entry.state === "withheld").map((entry) => entry.day).sort();
    if (withheld.length === 0) throw new TypeError("ANALYTICS_V2_CURRENT_D7_NEGATIVE_WITHHELD_DATES_EMPTY");
    const withheldSet = new Set(withheld);
    const basePublicDays = byDay(baseResponse.allowanceBreakdowns?.days);
    const candidatePublicDays = byDay(candidateResponse.allowanceBreakdowns?.days);
    const basePreviewDays = byDay(candidatePreviewDays(basePreview));
    const candidatePreviewMap = byDay(candidatePreviewDays(actualPreview));

    const expectedD1PreviewDays = graphDays.filter((day) => !withheldSet.has(day));
    if (!same([...basePublicDays.keys()], expectedPublicDays)
        || !same([...basePreviewDays.keys()], expectedD1PreviewDays)) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_REFERENCE_DAY_SET_INVALID");
    }

    addDiffs(differences,
      without(baseResponse, "allowanceBreakdowns"), without(candidateResponse, "allowanceBreakdowns"), "publicResponse");
    addDiffs(differences,
      without(baseResponse.allowanceBreakdowns, "days"), without(candidateResponse.allowanceBreakdowns, "days"),
      "publicResponse.allowanceBreakdowns");
    addDiffs(differences,
      [...basePublicDays.keys()], [...candidatePublicDays.keys()], "publicResponse.allowanceBreakdowns.days[*].day");
    for (const day of [...new Set([...basePublicDays.keys(), ...candidatePublicDays.keys()])].sort()) {
      const baseEntry = basePublicDays.get(day), candidateEntry = candidatePublicDays.get(day);
      if (baseEntry && candidateEntry) {
        addDiffs(differences, without(baseEntry, "models"), without(candidateEntry, "models"),
          `publicResponse.allowanceBreakdowns.days[${day}]`);
      }
      const dto = expected.get(day);
      if (!dto) {
        differences.push({ path: `expectation.days[${day}]`, expected: "present", actual: "absent" });
        continue;
      }
      if (withheldSet.has(day)) {
        if (expectedPublicDays.includes(day)
            && (!baseEntry || !candidateEntry || !Array.isArray(baseEntry.models) || baseEntry.models.length !== 0)) {
          differences.push({ path: `referenceD1Withholding[${day}]`,
            expected: "current D1 withheld empty model list", actual: "D1 withholding mismatch" });
        }
        if (expectedPublicDays.includes(day) && (!candidateEntry || !same(candidateEntry.models, dto.values))) {
          differences.push({ path: `publicResponse.allowanceBreakdowns.days[${day}].models`,
            expected: "independent current per-date values", actual: "candidate mismatch" });
        }
      } else {
        if (expectedPublicDays.includes(day) && (!baseEntry || !candidateEntry || !same(baseEntry.models, dto.values))) {
          differences.push({ path: `publicResponse.allowanceBreakdowns.days[${day}].models`,
            expected: "current per-date values on shared date", actual: "D1 reference mismatch" });
        }
        if (expectedPublicDays.includes(day) && (!candidateEntry || !same(candidateEntry.models, baseEntry?.models))) {
          differences.push({ path: `publicResponse.allowanceBreakdowns.days[${day}].models`,
            expected: "shared current D1 models", actual: "candidate mismatch" });
        }
      }
    }

    addDiffs(differences, without(basePreview, "models"), without(actualPreview, "models"), "adminPreview");
    addDiffs(differences, without(basePreview.models, "days"), without(actualPreview.models, "days"), "adminPreview.models");
    const baseShared = [...basePreviewDays.keys()];
    const actualShared = [...candidatePreviewMap.keys()].filter((day) => !withheldSet.has(day));
    addDiffs(differences, baseShared, actualShared, "adminPreview.models.days[*].shared-day");
    addDiffs(differences, graphDays, [...candidatePreviewMap.keys()], "adminPreview.models.days[*].day");
    for (const day of [...new Set([...basePreviewDays.keys(), ...candidatePreviewMap.keys()])].sort()) {
      const baseEntry = basePreviewDays.get(day), candidateEntry = candidatePreviewMap.get(day);
      const dto = expected.get(day);
      if (withheldSet.has(day)) {
        if (baseEntry !== undefined) {
          differences.push({ path: `adminPreview.models.days[${day}]`, expected: "withheld in current D1", actual: "present" });
        }
        if (!candidateEntry || !dto || !same(candidateEntry, dto)) {
          differences.push({ path: `adminPreview.models.days[${day}]`,
            expected: "independent current per-date DTO", actual: "candidate mismatch" });
        }
      } else if (!baseEntry || !candidateEntry || !same(baseEntry, dto)
          || !same(candidateEntry, baseEntry)) {
        differences.push({ path: `adminPreview.models.days[${day}]`,
          expected: "shared current per-date DTO", actual: "candidate mismatch" });
      }
    }
  }

  const family = caseId === "conflictPreserving" ? "negative-d7-model-publication" : "positive-strict-full-dto";
  const withheldSet = new Set(caseId === "conflictPreserving"
    ? [...inventory.values()].filter((entry) => entry.state === "withheld").map((entry) => entry.day) : []);
  const strictUnaffectedEqual = caseId === "conflictPreserving"
    ? differences.every((entry) => isWithheldModelProjectionPath(entry.path, withheldSet))
    : differences.length === 0;
  const exactPerDateEqual = differences.every((entry) => !isPerDatePath(entry.path));
  return Object.freeze({
    caseId,
    family,
    equal: strictUnaffectedEqual && exactPerDateEqual,
    strictUnaffectedEqual,
    exactPerDateEqual,
    comparedDates: expected.size,
    d1WithheldDates: caseId === "conflictPreserving"
      ? [...inventory.values()].filter((entry) => entry.state === "withheld").map((entry) => entry.day).sort() : [],
    diffCount: differences.length,
    diffs: differences.slice(0, MAX_DIFFS).map((entry) => ({
      path: safePath(entry.path), expected: shape(entry.expected), actual: shape(entry.actual),
    })),
  });
}

function exactKeys(value, keys) {
  return isObject(value) && same(Object.keys(value).sort(), [...keys].sort());
}

function requireExactKeys(value, keys, code) {
  if (!exactKeys(value, keys)) throw new TypeError(code);
}

/**
 * Compare both controller-accepted current cases. Structural/producer evidence
 * is validated before DTO comparison; this saved-evidence report never claims
 * native execution and never reads PostgreSQL or derives expectations.
 */
export function compareCurrentQ1D7Contract(input) {
  requireExactKeys(input, INPUT_KEYS, "ANALYTICS_V2_CURRENT_D7_INPUT_INVALID");
  if (!Array.isArray(input.cases) || input.cases.length !== CASE_IDS.length
      || !same(input.cases.map((entry) => entry?.caseId), CASE_IDS)) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_CASE_SET_INVALID");
  }
  for (const [record, label] of [[input.expectations, "expectations"], [input.expectationSha256, "expectationSha256"],
    [input.pgInputs, "pgInputs"]]) {
    requireExactKeys(record, CASE_IDS, `ANALYTICS_V2_CURRENT_D7_${label.toUpperCase()}_INVALID`);
  }

  validateCurrentQ1D7Binding(input.binding, input.inputBinding);
  requireCurrentDtoSourcePins(input.inputBinding, input.binding);
  const references = Object.fromEntries(input.cases.map((entry) => [entry.caseId, entry.reference]));
  const producerResult = validateCurrentQ1D7ProducerAcceptance(input.producerAcceptance, {
    inputBinding: input.inputBinding, binding: input.binding, cases: references,
    expectations: input.expectations, expectationSha256: input.expectationSha256, pgInputs: input.pgInputs,
    expectedController: input.expectedController,
  });
  if (producerResult.establishesNativeExecution !== false) {
    throw new TypeError("ANALYTICS_V2_CURRENT_D7_EVIDENCE_INCOMPLETE");
  }

  const currentDay = new Date(input.binding.runtime.pinnedNowMs).toISOString().slice(0, 10);
  const perCase = [];
  for (const entry of input.cases) {
    requireExactKeys(entry, CASE_INPUT_KEYS, "ANALYTICS_V2_CURRENT_D7_CASE_INPUT_INVALID");
    const { caseId } = entry;
    if (!CASE_IDS.includes(caseId) || !same(entry.reference, references[caseId])
        || !same(entry.expectation, input.expectations[caseId])
        || !isDay(entry.currentDay) || entry.currentDay !== currentDay) {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_CASE_BINDING_INVALID");
    }
    const result = compareCurrentQ1D7CaseDTOs({ caseId, reference: entry.reference, expectation: entry.expectation,
      actualResponse: entry.actualResponse, actualPreview: entry.actualPreview, currentDay });
    perCase.push(Object.freeze({
      caseId,
      referenceSha256: sha256Json(entry.reference),
      expectationSha256: input.expectationSha256[caseId],
      candidateSha256: sha256Json({ publicResponse: entry.actualResponse, adminPreview: entry.actualPreview }),
      family: result.family,
      comparedDates: result.comparedDates,
      equal: result.equal,
      strictUnaffectedEqual: result.strictUnaffectedEqual,
      exactPerDateEqual: result.exactPerDateEqual,
      d1WithheldDates: result.d1WithheldDates,
      diffCount: result.diffCount,
      diffs: result.diffs,
    }));
  }

  const byCase = new Map(perCase.map((record) => [record.caseId, record]));
  const negative = byCase.get(CASE_IDS[0]);
  const positive = byCase.get(CASE_IDS[1]);
  const strictUnaffectedEqual = perCase.every((record) => record.strictUnaffectedEqual);
  const exactPerDateEqual = perCase.every((record) => record.exactPerDateEqual);
  const positive70DateEqual = positive.exactPerDateEqual && positive.comparedDates === 70;
  const equal = strictUnaffectedEqual && exactPerDateEqual && positive70DateEqual;
  const unexpectedDiffs = perCase.reduce((total, record) => total + record.diffCount, 0);
  const nonqualifyingScopes = perCase.flatMap((record) => record.diffs.map((diff) => ({ caseId: record.caseId, path: diff.path })));
  const acceptedCaseDigests = Object.fromEntries(CASE_IDS.map((caseId) => [caseId, {
    corpusSha256: input.binding.cases[caseId].corpusSha256,
    admissionSha256: input.binding.cases[caseId].admissionSha256,
    sourceInvariantSha256: input.binding.cases[caseId].sourceInvariantSha256,
    pgInputSha256: sha256Json(input.pgInputs[caseId]),
    referenceSha256: sha256Json(input.cases.find((entry) => entry.caseId === caseId).reference),
    expectationSha256: input.expectationSha256[caseId],
  }]));

  return Object.freeze({
    schemaVersion: ANALYTICS_V2_CURRENT_D7_CONTRACT_REPORT_VERSION,
    comparisonMode: ANALYTICS_V2_CURRENT_D7_MODE,
    evidenceScope: "saved-comparison-only",
    decisionId: "D7",
    establishesNativeExecution: false,
    accepted: equal,
    acceptedCaseIds: [...CASE_IDS],
    bindingSha256: sha256Json(input.binding),
    producerAcceptanceSha256: sha256Json(input.producerAcceptance),
    currentDay,
    normalizations: [...ANALYTICS_V2_CURRENT_D7_NORMALIZATIONS],
    acceptedCaseDigests,
    strictUnaffectedEqual,
    acceptedD7DateSet: [...negative.d1WithheldDates],
    exactPerDateEqual,
    positive70DateEqual,
    unresolved: [],
    nonqualifyingScopes,
    unexpectedDiffs,
    perCase,
  });
}

export function parseCurrentQ1D7CompareArgs(argv) {
  const allowed = new Set(["--comparison-mode", "--input"]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || typeof value !== "string" || value.length === 0
        || value.startsWith("--")) throw new TypeError("ANALYTICS_V2_CURRENT_D7_ARGUMENTS_INVALID");
    values[flag] = value;
  }
  if (argv.length !== 4 || values["--comparison-mode"] !== ANALYTICS_V2_CURRENT_D7_MODE
      || !values["--input"]) throw new TypeError("ANALYTICS_V2_CURRENT_D7_ARGUMENTS_INVALID");
  return Object.freeze({ inputPath: values["--input"] });
}

async function runCli() {
  try {
    const { inputPath } = parseCurrentQ1D7CompareArgs(process.argv.slice(2));
    const absolute = resolve(inputPath);
    const inputInfo = await stat(absolute);
    if (!inputInfo.isFile() || inputInfo.size > MAX_INPUT_BYTES) throw new TypeError("ANALYTICS_V2_CURRENT_D7_INPUT_TOO_LARGE");
    const bytes = await readFile(absolute);
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new TypeError("ANALYTICS_V2_CURRENT_D7_INPUT_TOO_LARGE");
    let input;
    try { input = JSON.parse(bytes.toString("utf8")); } catch {
      throw new TypeError("ANALYTICS_V2_CURRENT_D7_JSON_INVALID");
    }
    const report = compareCurrentQ1D7Contract(input);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.accepted) process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.message === "string" && /^ANALYTICS_V2_CURRENT_D7_[A-Z_]+$/u.test(error.message)
      ? error.message : "ANALYTICS_V2_CURRENT_D7_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await runCli();
}

function candidatePreviewDays(preview) {
  const days = preview?.models?.days;
  if (!Array.isArray(days)) throw new TypeError("ANALYTICS_V2_CURRENT_D7_PREVIEW_DAYS_INVALID");
  return days;
}
