import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  digestDetailedAccountingBenchmarkFile,
  inspectDetailedAccountingBenchmarkIndex,
  parseMacOsTimeMetrics,
  parseSuccessfulAccountingEnvelope,
  projectDetailedAccountingBenchmarkGeneration,
  runBoundedBenchmarkCommand,
  snapshotDetailedAccountingDependencies,
  verifyAccountingBenchmarkArtifact,
} from "../benchmark-detailed-accounting.mjs";

// Production child resource evidence only. No ledger observer, instrumentation,
// ingestion, installed-app work, cache publication or application refresh runs
// in the timed process. Repeated fresh processes prove child repeatability, not
// an app-level no-change cache hit, relaunch, refresh or cancellation outcome.
const SCHEMA = "pr94-production-resource-v2";
const DAY_MS = 86_400_000;
const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const TRANSPORT_BYTES = 64 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const MAX_RSS_BYTES = 6_442_450_944;
const POLICY_KEYS = ["maximumRssBytes", "rssDeltaBudgetBytes", "rebuildChildOldSpaceMib",
  "archiveMaximumRssBytes", "archiveRssDeltaBudgetBytes"];
const INPUT_LIMITS = ["usageEvents", "weeklySnapshots", "combinedInputs", "retainedBytes"];
const CACHE_ARRAYS = ["periods", "timeline", "sparkUsageTimeline", "quotaTimeline", "sparkQuotaTimeline"];
const RUN_KINDS = ["primary", "fresh_process_repeat"];
const BEFORE_REVISION = "a3c850360bc83c0e27bef2171aeb4a302b72f472";
const AFTER_REVISION = "20f449ff5c222989029fe343f219f02b497ae1d4";
const QUERY_PLAN_SCHEMA = "pr94-attribution-query-plans-v1";
const QUERY_ROLES = ["membership", "same_record_plans", "source_predecessor", "session_predecessor"];
const QUERY_METHODS = ["get", "all", "get", "get"];
const QUERY_ARITIES = [2, 5, 3, 5];
const QUERY_COUNTS = ["steps", "search", "scan", "tempSort", "other"];
const MODULE_FILE = fileURLToPath(import.meta.url);
const SAFE_FAILURES = new Set([
  "invalid", "approval_required", "runtime_invalid", "window_invalid", "policy_invalid", "path_invalid",
  "source_invalid", "source_changed", "index_mismatch", "index_changed", "generation_invalid", "generation_mismatch", "generation_changed",
  "request_version_invalid", "cache_context_mismatch", "probe_invalid", "artifact_changed", "repeat_mismatch", "cancelled",
  "command_failed", "command_timeout", "command_output_limit", "command_aborted", "command_termination_unconfirmed",
  "metrics_invalid", "envelope_invalid", "child_refused", "artifact_invalid", "artifact_mismatch", "index_invalid",
  "resource_limit_exceeded", "dependency_invalid", "dependency_changed", "dependency_limit_exceeded", "refused",
  "query_plan_invalid", "query_plan_changed",
]);
export const PR94_PRODUCTION_ERROR_CODES = Object.freeze([...SAFE_FAILURES].map((code) => `pr94_production_${code}`));

function fail(code = "invalid") { throw Object.assign(new Error(`pr94_production_${code}`), { code: `pr94_production_${code}` }); }
function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code.replace(/^pr94_production_/u, "") : "refused";
  return SAFE_FAILURES.has(code) ? code : "refused";
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) fail();
  return value;
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || Object.is(value, -0)) fail();
  return value;
}
function digest(value) { if (typeof value !== "string" || !HASH.test(value)) fail(); return value; }
function cancelled(signal) { if (signal?.aborted) fail("cancelled"); }
function instant(value) {
  if (typeof value !== "string" || value.length !== 24 || !Number.isSafeInteger(Date.parse(value))
      || new Date(value).toISOString() !== value) fail();
  return value;
}
function sameFile(left, right) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid", "nlink"]
    .every((key) => left[key] === right[key]);
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function validatePr94AttributionQueryPlans(value, revision) {
  exact(value, ["schema", "scope", "binding", "status", "statements"]);
  if (typeof revision !== "string" || !REVISION.test(revision)
      || value.schema !== QUERY_PLAN_SCHEMA || value.scope !== "attribution_point_queries_explain_only"
      || value.binding !== "synthetic") fail("query_plan_invalid");
  if (revision === BEFORE_REVISION) {
    if (value.status !== "feature_absent" || value.statements !== null) fail("query_plan_invalid");
    return value;
  }
  if (value.status !== "observed") fail("query_plan_invalid");
  exact(value.statements, QUERY_ROLES);
  for (const role of QUERY_ROLES) {
    const counts = exact(value.statements[role], QUERY_COUNTS);
    QUERY_COUNTS.forEach((key) => integer(counts[key]));
    if (counts.steps < 1 || integer(counts.search + counts.scan + counts.tempSort + counts.other) !== counts.steps) {
      fail("query_plan_invalid");
    }
  }
  return value;
}

// Compile the selected reader's original four point-query statements against
// the real read-only schema, using only synthetic bind values. The adapter
// NEVER steps a data SELECT. Its synthetic membership drives the public
// reader's branches, not a claim that an index row exists. Statement order,
// method and arity are a closed contract of the reviewed after/final readers.
// This excludes full scans, optional precomputation and query execution cost.
export function collectPr94AttributionQueryPlans({ readerModule, database, generationId, observedAtMs, revision }) {
  try {
    if (typeof revision !== "string" || !REVISION.test(revision)
        || typeof database?.prepare !== "function") fail("query_plan_invalid");
    integer(generationId, 1);
    integer(observedAtMs, -8_640_000_000_000_000, 8_640_000_000_000_000);
    const createReader = readerModule?.createLocalUnifiedUsageAttributionReader;
    const evidence = { schema: QUERY_PLAN_SCHEMA, scope: "attribution_point_queries_explain_only",
      binding: "synthetic", status: "feature_absent", statements: null };
    if (revision === BEFORE_REVISION) {
      if (createReader !== undefined) fail("query_plan_invalid");
      return validatePr94AttributionQueryPlans(evidence, revision);
    }
    if (typeof createReader !== "function") fail("query_plan_invalid");
    const source = Buffer.alloc(32, 17); const session = Buffer.alloc(32, 29);
    const prepared = []; const statements = {};
    const explainOnly = {
      prepare(sql) {
        const index = prepared.length;
        if (index >= QUERY_ROLES.length || typeof sql !== "string" || !/^\s*SELECT\b/u.test(sql)) fail("query_plan_invalid");
        const state = { used: false }; prepared.push(state);
        function explain(method, parameters) {
          if (state.used || method !== QUERY_METHODS[index] || parameters.length !== QUERY_ARITIES[index]) fail("query_plan_invalid");
          state.used = true;
          const counts = { steps: 0, search: 0, scan: 0, tempSort: 0, other: 0 };
          // Iteration bounds retained memory independently of plan length;
          // the surrounding untimed probe keeps its existing 30-second bound.
          for (const row of database.prepare(`EXPLAIN QUERY PLAN ${sql}`).iterate(...parameters)) {
            exact(row, ["id", "parent", "notused", "detail"]);
            integer(row.id); integer(row.parent); integer(row.notused);
            if (typeof row.detail !== "string" || row.detail.length === 0) fail("query_plan_invalid");
            const kind = /^SEARCH\b/u.test(row.detail) ? "search"
              : /^SCAN\b/u.test(row.detail) ? "scan"
                : /^USE TEMP B-TREE\b/u.test(row.detail) ? "tempSort" : "other";
            counts.steps = integer(counts.steps + 1);
            counts[kind] = integer(counts[kind] + 1);
          }
          statements[QUERY_ROLES[index]] = counts;
          if (index === 0) return { source_ordinal: 0, session_local: session, scanned_bytes: 1 };
          return index === 1 ? [] : undefined;
        }
        return { get: (...parameters) => explain("get", parameters), all: (...parameters) => explain("all", parameters) };
      },
    };
    const reader = createReader({ database: explainOnly, generationId });
    reader.read({ source_local: source, source_ordinal: 0, source_offset: 1,
      session_local: session, observed_at_ms: observedAtMs });
    if (prepared.length !== QUERY_ROLES.length || prepared.some((state) => !state.used)) fail("query_plan_invalid");
    return validatePr94AttributionQueryPlans({ ...evidence, status: "observed", statements }, revision);
  } catch {
    // SQLite errors can contain SQL, schema names or private bindings.
    fail("query_plan_invalid");
  }
}

function windowFor(startAt, endAt) {
  instant(startAt); instant(endAt);
  const duration = Date.parse(endAt) - Date.parse(startAt);
  if (!Number.isSafeInteger(duration) || duration % DAY_MS !== 0) fail("window_invalid");
  // Exact production range: never round or widen the caller's comparison.
  const windowDays = integer(duration / DAY_MS, 365, 3653);
  return { startAt, endAt, nowMs: Date.parse(endAt), windowDays };
}

function validatePolicy(policy) {
  exact(policy, POLICY_KEYS);
  POLICY_KEYS.forEach((key) => integer(policy[key], 1));
  if (policy.maximumRssBytes > MAX_RSS_BYTES) fail("policy_invalid");
  if (integer(policy.rebuildChildOldSpaceMib * 1024 * 1024, 1) < policy.maximumRssBytes) fail("policy_invalid");
  return policy;
}

function validateProjection(value) {
  exact(value, ["schemaVersion", "source", "weeklyInput", "rows"]);
  if (!["local-replay-safe-accounting-v0.13", "local-replay-safe-accounting-v0.14",
    "local-replay-safe-accounting-v0.15"].includes(value.schemaVersion)) fail();
  exact(value.source, ["mode", "contextBehavior", "accountingCoverage", "generationMatched", "readsRawSources"]);
  if (value.source.mode !== "unified" || value.source.contextBehavior !== "legacy_zero"
      || value.source.accountingCoverage !== "complete" || value.source.generationMatched !== true
      || value.source.readsRawSources !== false) fail();
  const input = value.weeklyInput;
  exact(input, ["status", "encoding", "source", "retainedUsageEvents", "retainedWeeklySnapshots", "estimatedRetainedBytes", "limits"]);
  if (input.status !== "complete" || input.source !== "unified_index"
      || !["accounting_compact_v2", "accounting_compact_v3"].includes(input.encoding)) fail();
  exact(input.limits, INPUT_LIMITS);
  INPUT_LIMITS.forEach((key) => integer(input.limits[key], 1));
  integer(input.retainedUsageEvents, 0, input.limits.usageEvents);
  integer(input.retainedWeeklySnapshots, 0, input.limits.weeklySnapshots);
  integer(input.estimatedRetainedBytes, 0, input.limits.retainedBytes);
  integer(input.retainedUsageEvents + input.retainedWeeklySnapshots, 0, input.limits.combinedInputs);
  // Each revision's public validator owns its retained-byte formula: v2 and
  // v3 intentionally charge different per-usage retained sizes.
  exact(value.rows, CACHE_ARRAYS);
  CACHE_ARRAYS.forEach((key) => integer(value.rows[key]));
  return value;
}

/** Bind even a refused historical artifact without treating it as valid. */
export function assertPr94ProductionCacheContext(cache, { startAt, endAt, generationId, generationFingerprint }) {
  windowFor(startAt, endAt);
  integer(generationId, 1);
  if (!/^generation-v2-[a-f0-9]{64}$/u.test(generationFingerprint)) fail();
  if (cache?.generatedAt !== endAt || cache?.coveredAt?.startAt !== startAt || cache.coveredAt.endAt !== endAt
      || cache?.sourceDescriptor?.generation !== String(generationId)
      || cache.sourceDescriptor.generationFingerprint !== generationFingerprint) fail("cache_context_mismatch");
}

/** Call only after the selected revision's assertReplaySafeAccountingCache. */
export function projectPr94ProductionCache(cache, context) {
  assertPr94ProductionCacheContext(cache, context);
  const { endAt } = context;
  const input = cache.weeklyCalibrationInput;
  if (!input || !input.coveredAt) fail();
  instant(input.coveredAt.startAt); instant(input.coveredAt.endAt);
  if (input.coveredAt.startAt > input.coveredAt.endAt || input.coveredAt.endAt > endAt) fail();
  const projection = {
    schemaVersion: cache.schemaVersion,
    source: { mode: cache.sourceDescriptor.mode, contextBehavior: cache.sourceDescriptor.contextBehavior,
      accountingCoverage: cache.sourceDescriptor.coverageStatus,
      generationMatched: cache.sourceDescriptor.generationMatched,
      readsRawSources: cache.sourceDescriptor.capabilities?.readsRawSources },
    weeklyInput: { status: input.status, encoding: input.encoding, source: input.source,
      retainedUsageEvents: input.retainedUsageEvents, retainedWeeklySnapshots: input.retainedWeeklySnapshots,
      estimatedRetainedBytes: input.estimatedRetainedBytes,
      limits: Object.fromEntries(INPUT_LIMITS.map((key) => [key, input.limits?.[key]])) },
    rows: Object.fromEntries(CACHE_ARRAYS.map((key) => {
      if (!Array.isArray(cache[key])) fail();
      return [key, cache[key].length];
    })),
  };
  return validateProjection(projection);
}

/** Exact production request; no scan/rss hooks or PR94 export instrumentation. */
export function buildPr94ProductionResourceRequest({ startAt, endAt, indexFile, codexHome, generation, policy, requestVersion }) {
  const clock = windowFor(startAt, endAt);
  validatePolicy(policy);
  projectDetailedAccountingBenchmarkGeneration(generation);
  if (requestVersion !== "replay-safe-accounting-rebuild-request-v1") fail("request_version_invalid");
  for (const path of [indexFile, codexHome]) if (typeof path !== "string" || resolve(path) !== path) fail("path_invalid");
  return { version: requestVersion, nowMs: clock.nowMs, windowDays: clock.windowDays,
    codexHome, sourceMode: "unified", contextBehavior: "legacy_zero", expectedGeneration: generation,
    unifiedIndexFile: indexFile, declaredSpeedBaselines: [], transitionResourceLimits: null,
    maximumRssBytes: policy.maximumRssBytes };
}

async function privateDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o077) !== 0 || await realpath(path) !== path) fail("path_invalid");
  return metadata;
}

async function sourceIdentity(root, { signal, command }) {
  if (await realpath(root) !== root) fail("source_invalid");
  const git = (args) => command("/usr/bin/git", ["-C", root, ...args], { signal });
  const revision = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (!REVISION.test(revision)
      || (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout !== "") fail("source_invalid");
  return { revision, dependencies: await snapshotDetailedAccountingDependencies(root, { signal }) };
}

function validateSource(value, expectedRevision) {
  exact(value, ["revision", "dependencies"]);
  if (value.revision !== expectedRevision) fail("source_changed");
  exact(value.dependencies, ["sourceSha256", "runtimeSha256", "lockSha256", "identitySha256"]);
  Object.values(value.dependencies).forEach(digest);
  return value;
}

// Static public owners selected beneath the authenticated revision. The
// projection helper is observer code, loaded only in this untimed probe.
async function probeRevision({ root, stage, path, context, command, environment, signal, cwd }) {
  const cacheUrl = JSON.stringify(pathToFileURL(join(root, "src/replay-safe-accounting-cache.js")).href);
  const indexUrl = JSON.stringify(pathToFileURL(join(root, "src/local-unified-index.js")).href);
  const readerUrl = JSON.stringify(pathToFileURL(join(root, "src/local-unified-accounting-source.js")).href);
  const projectionUrl = JSON.stringify(pathToFileURL(MODULE_FILE).href);
  const program = `import { readFile } from 'node:fs/promises';
import { REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY as policy, REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION as requestVersion, assertReplaySafeAccountingCache } from ${cacheUrl};
import { openLocalUnifiedIndex, readUnifiedIndexGenerationDescriptor } from ${indexUrl};
import * as readerModule from ${readerUrl};
import { assertPr94ProductionCacheContext, projectPr94ProductionCache, collectPr94AttributionQueryPlans } from ${projectionUrl};
try {
 if (process.argv[1] === 'metadata') {
  const db = openLocalUnifiedIndex(process.argv[2], { readOnly: true });
  try {
   const generation = readUnifiedIndexGenerationDescriptor(db);
   const context = JSON.parse(process.argv[3]);
   const queryPlans = collectPr94AttributionQueryPlans({ readerModule, database: db, generationId: generation.id,
    observedAtMs: context.observedAtMs, revision: context.revision });
   process.stdout.write(JSON.stringify({ policy, requestVersion, generation, queryPlans }));
  } finally { db.close(); }
 } else {
  const cache = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const context = JSON.parse(process.argv[3]);
  assertPr94ProductionCacheContext(cache, context);
  let assertionRefused = false;
  try {
   assertReplaySafeAccountingCache(cache);
  } catch (error) {
   if (context?.revision !== '${AFTER_REVISION}' || error?.code !== 'cache_invalid') throw error;
   assertionRefused = true;
  }
  if (assertionRefused) process.stdout.write(JSON.stringify({ status: 'refused', code: 'cache_invalid' }));
  else process.stdout.write(JSON.stringify(projectPr94ProductionCache(cache, context)));
 }
} catch { process.exitCode = 1; }`;
  let output;
  try {
    output = await command(process.execPath, ["--input-type=module", "--eval", program,
      stage, path, JSON.stringify(context ?? null)], { cwd, env: environment, signal, timeoutMs: 30_000 });
  } catch (error) {
    if (error?.code === "command_failed") fail(stage === "artifact" ? "artifact_invalid" : "generation_invalid");
    throw error;
  }
  try { return JSON.parse(output.stdout); } catch { fail("probe_invalid"); }
}

export function validatePr94ProductionResourceEvidence(value) {
  exact(value, ["schema", "scope", "revision", "dependencies", "clock", "index", "generation", "policy",
    "limits", "runs", "queryPlans", "exactRepeatOutput", "indexUnchanged", "sourceUnchanged", "dependenciesUnchanged", "notMeasured"]);
  if (value.schema !== SCHEMA || value.scope !== "isolated_child_repeatability" || !REVISION.test(value.revision)) fail();
  validateSource({ revision: value.revision, dependencies: value.dependencies }, value.revision);
  exact(value.clock, ["startAt", "endAt", "nowMs", "windowDays"]);
  if (!same(value.clock, windowFor(value.clock.startAt, value.clock.endAt))) fail();
  exact(value.index, ["sha256", "bytes"]); digest(value.index.sha256); integer(value.index.bytes, 1);
  exact(value.generation, ["id", "publicationStatus", "toolProvenanceComplete", "usageEvents", "quotaOccurrences"]);
  integer(value.generation.id, 1); integer(value.generation.usageEvents); integer(value.generation.quotaOccurrences);
  if (!["complete", "partial"].includes(value.generation.publicationStatus) || typeof value.generation.toolProvenanceComplete !== "boolean") fail();
  validatePolicy(value.policy);
  validatePr94AttributionQueryPlans(value.queryPlans, value.revision);
  exact(value.limits, ["envelopeBytes", "transportBytes", "durableCacheBytes"]);
  if (!same(value.limits, { envelopeBytes: 64 * 1024, transportBytes: TRANSPORT_BYTES, durableCacheBytes: CACHE_BYTES })) fail();
  if (!Array.isArray(value.runs) || value.runs.length !== 2) fail();
  value.runs.forEach((run, index) => {
    exact(run, ["kind", "metrics", "envelope", "artifact", "cache"]);
    if (run.kind !== RUN_KINDS[index]) fail();
    exact(run.metrics, ["wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes"]);
    Object.values(run.metrics).forEach((measurement) => integer(measurement));
    integer(run.metrics.peakRssBytes, 1, value.policy.maximumRssBytes);
    const envelope = parseSuccessfulAccountingEnvelope(JSON.stringify(run.envelope));
    exact(run.artifact, ["sha256", "bytes"]); digest(run.artifact.sha256); integer(run.artifact.bytes, 2, CACHE_BYTES);
    if (envelope.resultBytes !== run.artifact.bytes || envelope.resultSha256 !== run.artifact.sha256) fail();
    validateProjection(run.cache);
  });
  if (!same(value.runs[0].artifact, value.runs[1].artifact) || !same(value.runs[0].cache, value.runs[1].cache)
      || value.exactRepeatOutput !== true || value.indexUnchanged !== true || value.sourceUnchanged !== true
      || value.dependenciesUnchanged !== true
      || !same(value.notMeasured, ["app_no_change_cache_hit", "app_relaunch", "end_to_end_refresh", "cancellation", "evidence_observer_overhead"])) fail();
  return value;
}

function validateHistoricalCacheAssertion(value) {
  exact(value, ["status", "code"]);
  if (value.status !== "refused" || value.code !== "cache_invalid") fail();
  return value;
}

function historicalCacheAssertion(value) {
  try { return validateHistoricalCacheAssertion(value); }
  catch { return null; }
}

function validateHistoricalArtifactRefusal(value) {
  exact(value, ["schema", "scope", "status", "revision", "dependencies", "clock", "index", "generation", "policy",
    "limits", "runs", "queryPlans", "exactRepeatOutput", "indexUnchanged", "sourceUnchanged", "dependenciesUnchanged", "notMeasured"]);
  if (value.schema !== SCHEMA || value.scope !== "isolated_child_repeatability"
      || value.status !== "historical_artifact_refused" || value.revision !== AFTER_REVISION) fail();
  validateSource({ revision: value.revision, dependencies: value.dependencies }, AFTER_REVISION);
  exact(value.clock, ["startAt", "endAt", "nowMs", "windowDays"]);
  if (!same(value.clock, windowFor(value.clock.startAt, value.clock.endAt))) fail();
  exact(value.index, ["sha256", "bytes"]); digest(value.index.sha256); integer(value.index.bytes, 1);
  exact(value.generation, ["id", "publicationStatus", "toolProvenanceComplete", "usageEvents", "quotaOccurrences"]);
  integer(value.generation.id, 1); integer(value.generation.usageEvents); integer(value.generation.quotaOccurrences);
  if (!["complete", "partial"].includes(value.generation.publicationStatus)
      || typeof value.generation.toolProvenanceComplete !== "boolean") fail();
  validatePolicy(value.policy);
  validatePr94AttributionQueryPlans(value.queryPlans, AFTER_REVISION);
  exact(value.limits, ["envelopeBytes", "transportBytes", "durableCacheBytes"]);
  if (!same(value.limits, { envelopeBytes: 64 * 1024, transportBytes: TRANSPORT_BYTES, durableCacheBytes: CACHE_BYTES })) fail();
  if (!Array.isArray(value.runs) || value.runs.length !== 2) fail();
  value.runs.forEach((run, index) => {
    exact(run, ["kind", "metrics", "envelope", "artifact", "cacheAssertion"]);
    if (run.kind !== RUN_KINDS[index]) fail();
    exact(run.metrics, ["wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes"]);
    Object.values(run.metrics).forEach((measurement) => integer(measurement));
    integer(run.metrics.peakRssBytes, 1, value.policy.maximumRssBytes);
    const envelope = parseSuccessfulAccountingEnvelope(JSON.stringify(run.envelope));
    exact(run.artifact, ["sha256", "bytes"]); digest(run.artifact.sha256); integer(run.artifact.bytes, 2, CACHE_BYTES);
    if (envelope.resultBytes !== run.artifact.bytes || envelope.resultSha256 !== run.artifact.sha256) fail();
    validateHistoricalCacheAssertion(run.cacheAssertion);
  });
  if (!same(value.runs[0].envelope, value.runs[1].envelope)
      || !same(value.runs[0].artifact, value.runs[1].artifact)
      || !same(value.runs[0].cacheAssertion, value.runs[1].cacheAssertion)
      || value.exactRepeatOutput !== true || value.indexUnchanged !== true || value.sourceUnchanged !== true
      || value.dependenciesUnchanged !== true
      || !same(value.notMeasured, ["app_no_change_cache_hit", "app_relaunch", "end_to_end_refresh", "cancellation", "evidence_observer_overhead"])) fail();
  return value;
}

/** Strict production evidence, or the one pinned historical refusal outcome. */
export function validatePr94ProductionResourceOutcome(value) {
  const status = value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "status") : null;
  if (status && Object.hasOwn(status, "value")) return validateHistoricalArtifactRefusal(value);
  return validatePr94ProductionResourceEvidence(value);
}

async function runWorker(options, {
  signal = null, command = runBoundedBenchmarkCommand, inspectSource = sourceIdentity,
  probe = probeRevision, runtime = { version: process.version, platform: process.platform, arch: process.arch },
} = {}) {
  if (options?.privateOperationApproved !== true) fail("approval_required");
  const required = ["privateOperationApproved", "root", "expectedRevision", "indexFile", "expectedIndex", "outputDirectory", "startAt", "endAt"];
  exact(options, Object.hasOwn(options, "timeoutSeconds") ? [...required, "timeoutSeconds"] : required);
  if (runtime.version !== "v26.2.0" || runtime.platform !== "darwin" || runtime.arch !== "arm64") fail("runtime_invalid");
  const clock = windowFor(options.startAt, options.endAt);
  const timeoutSeconds = integer(options.timeoutSeconds ?? 1800, 1, 3600);
  if (!REVISION.test(options.expectedRevision)) fail();
  exact(options.expectedIndex, ["sha256", "bytes", "generationId"]);
  digest(options.expectedIndex.sha256); integer(options.expectedIndex.bytes, 1); integer(options.expectedIndex.generationId, 1);
  for (const key of ["root", "indexFile", "outputDirectory"]) {
    if (typeof options[key] !== "string" || resolve(options[key]) !== options[key]) fail("path_invalid");
  }
  cancelled(signal);
  const beforeSource = validateSource(await inspectSource(options.root, { signal, command }), options.expectedRevision);
  if (await realpath(options.indexFile) !== options.indexFile) fail("path_invalid");
  const indexStat = await inspectDetailedAccountingBenchmarkIndex(options.indexFile);
  const indexSha256 = await digestDetailedAccountingBenchmarkFile(options.indexFile, indexStat, { signal });
  if (indexStat.size !== options.expectedIndex.bytes || indexSha256 !== options.expectedIndex.sha256) fail("index_mismatch");
  await privateDirectory(dirname(options.outputDirectory));
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const outputStat = await privateDirectory(options.outputDirectory);
  const codexHome = join(options.outputDirectory, "empty-codex-home");
  const temporary = join(options.outputDirectory, "temporary");
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  const environment = { TMPDIR: temporary, LC_ALL: "C" };
  const probeOptions = { root: options.root, command, environment, signal, cwd: options.outputDirectory };
  const metadataContext = { revision: options.expectedRevision, observedAtMs: clock.nowMs };
  const initial = await probe({ ...probeOptions, stage: "metadata", path: options.indexFile, context: metadataContext });
  exact(initial, ["policy", "requestVersion", "generation", "queryPlans"]);
  validatePolicy(initial.policy);
  validatePr94AttributionQueryPlans(initial.queryPlans, options.expectedRevision);
  const generation = projectDetailedAccountingBenchmarkGeneration(initial.generation);
  if (generation.id !== options.expectedIndex.generationId) fail("generation_mismatch");
  const request = buildPr94ProductionResourceRequest({ ...clock, indexFile: options.indexFile, codexHome, ...initial });
  const context = { startAt: clock.startAt, endAt: clock.endAt, generationId: generation.id,
    generationFingerprint: initial.generation.fingerprint, revision: options.expectedRevision };
  const runs = [];
  for (const kind of RUN_KINDS) {
    cancelled(signal);
    if (!sameFile(indexStat, await inspectDetailedAccountingBenchmarkIndex(options.indexFile))) fail("index_changed");
    const directory = join(options.outputDirectory, kind);
    await mkdir(directory, { mode: 0o700 });
    const requestFile = join(directory, "request.json");
    const resultFile = join(directory, "result.json");
    await writeFile(requestFile, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    const output = await command("/usr/bin/time", ["-l", process.execPath,
      `--max-old-space-size=${initial.policy.rebuildChildOldSpaceMib}`,
      join(options.root, "src/replay-safe-accounting-rebuild-child.js"), requestFile, resultFile],
    { cwd: directory, env: environment, signal, timeoutMs: timeoutSeconds * 1000 });
    const envelope = parseSuccessfulAccountingEnvelope(output.stdout);
    const metrics = parseMacOsTimeMetrics(output.stderr);
    if (metrics.peakRssBytes > initial.policy.maximumRssBytes) fail("resource_limit_exceeded");
    const artifact = await verifyAccountingBenchmarkArtifact(resultFile, envelope, { signal });
    const probed = await probe({ ...probeOptions, stage: "artifact", path: resultFile, context });
    const cacheAssertion = historicalCacheAssertion(probed);
    const cache = cacheAssertion === null ? validateProjection(probed) : null;
    if (cacheAssertion !== null && options.expectedRevision !== AFTER_REVISION) fail("artifact_invalid");
    // Bind the exact file validated by the selected revision's public facade.
    if (!same(artifact, await verifyAccountingBenchmarkArtifact(resultFile, envelope, { signal }))) fail("artifact_changed");
    const priorCache = runs.length && Object.hasOwn(runs[0], "cache") ? runs[0].cache : null;
    const priorAssertion = runs.length && Object.hasOwn(runs[0], "cacheAssertion") ? runs[0].cacheAssertion : null;
    if (runs.length && (!same(runs[0].envelope, envelope) || !same(runs[0].artifact, artifact)
        || !same(priorCache, cache) || !same(priorAssertion, cacheAssertion))) fail("repeat_mismatch");
    runs.push(cacheAssertion === null
      ? { kind, metrics, envelope, artifact, cache }
      : { kind, metrics, envelope, artifact, cacheAssertion });
  }
  cancelled(signal);
  if (!sameFile(indexStat, await inspectDetailedAccountingBenchmarkIndex(options.indexFile))
      || await digestDetailedAccountingBenchmarkFile(options.indexFile, indexStat, { signal }) !== indexSha256) fail("index_changed");
  if (!same(beforeSource, validateSource(await inspectSource(options.root, { signal, command }), options.expectedRevision))) fail("source_changed");
  const finalMetadata = await probe({ ...probeOptions, stage: "metadata", path: options.indexFile, context: metadataContext });
  exact(finalMetadata, ["policy", "requestVersion", "generation", "queryPlans"]);
  validatePr94AttributionQueryPlans(finalMetadata.queryPlans, options.expectedRevision);
  if (!same(initial.queryPlans, finalMetadata.queryPlans)) fail("query_plan_changed");
  if (!same(initial, finalMetadata)) fail("generation_changed");
  const finalOutputStat = await privateDirectory(options.outputDirectory);
  if (outputStat.dev !== finalOutputStat.dev || outputStat.ino !== finalOutputStat.ino) fail("path_invalid");
  cancelled(signal);
  const shared = { schema: SCHEMA, scope: "isolated_child_repeatability",
    revision: beforeSource.revision, dependencies: beforeSource.dependencies, clock,
    index: { sha256: indexSha256, bytes: indexStat.size },
    generation: { id: generation.id, publicationStatus: generation.publicationStatus,
      toolProvenanceComplete: generation.toolProvenanceComplete, usageEvents: generation.usageEvents,
      quotaOccurrences: generation.quotaOccurrences }, policy: initial.policy, queryPlans: initial.queryPlans,
    limits: { envelopeBytes: 64 * 1024, transportBytes: TRANSPORT_BYTES, durableCacheBytes: CACHE_BYTES }, runs,
    exactRepeatOutput: true, indexUnchanged: true, sourceUnchanged: true, dependenciesUnchanged: true,
    notMeasured: ["app_no_change_cache_hit", "app_relaunch", "end_to_end_refresh", "cancellation", "evidence_observer_overhead"] };
  if (runs.every((run) => Object.hasOwn(run, "cacheAssertion"))) {
    if (options.expectedRevision !== AFTER_REVISION) fail("artifact_invalid");
    return validatePr94ProductionResourceOutcome({ ...shared, status: "historical_artifact_refused" });
  }
  return validatePr94ProductionResourceOutcome(shared);
}

/** Characterization adapters are function-only seams, never CLI input. */
export async function runPr94ProductionResourceWorker(options, adapters = {}) {
  try { return await runWorker(options, adapters); }
  catch (error) {
    // Filesystem, subprocess and selected-revision exceptions may hold private
    // paths or diagnostics. No arbitrary exception crosses this public seam.
    fail(safeFailureCode(error));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_FILE) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    let request = "";
    for await (const chunk of process.stdin) {
      request += chunk;
      if (Buffer.byteLength(request) > 64 * 1024) fail();
    }
    const result = await runPr94ProductionResourceWorker(JSON.parse(request), { signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ status: "ok", result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "error", code: `pr94_production_${safeFailureCode(error)}` })}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
