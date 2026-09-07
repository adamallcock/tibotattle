import {
  createEmptySupplementalSourcePlan,
  ExportResourceLimitError,
  ExportSupplementalSourcePlanError,
  summarizeSupplementalSourcePlan,
  stableJson,
} from "../../export/index.js";
import { validSha256 } from "./source-validation.js";

export function createSourcePlanBundleContext(configuration) {
const {
  bufferByteLength,
  claudeStatusExport,
  claudeStatusWorkspace,
  claudeTranscriptExport,
  claudeTranscriptWorkspace,
  codexCollectorExport,
  codexCollectorWorkspace,
  codexSourcePlan,
  createHash,
  isProxy,
  normalizeExportBounds,
  resolvePath,
} = configuration;
const {
  createCodexCollectorWorkspaceSource,
  appendCodexCollectorWorkspaceSource,
} = codexCollectorWorkspace;
const { verifyCodexCollectorExportSourcePlan } = codexCollectorExport;
const {
  appendClaudeStatusWorkspaceSource,
  claudeStatusWorkspaceSourceKey,
  createClaudeStatusWorkspaceSource,
} = claudeStatusWorkspace;
const { verifyClaudeStatusLedgerExportSourcePlan } = claudeStatusExport;
const {
  appendClaudeTranscriptWorkspaceSources,
  createClaudeTranscriptWorkspaceSource,
} = claudeTranscriptWorkspace;
const {
  sliceClaudeTranscriptExportSourcePlans,
  verifyClaudeTranscriptExportSource,
} = claudeTranscriptExport;
const { createCodexExportSourcePlan, verifyCodexExportSourcePlan } = codexSourcePlan;

const EXPORT_SOURCE_PLAN_BUNDLE_VERSION = "export-source-plan-bundle-v0.1";

const BUNDLE_KEYS = Object.freeze([
  "schemaVersion",
  "startAt",
  "endAt",
  "codexPlan",
  "collectorPlan",
  "claudeStatusPlan",
  "claudeTranscriptPlan",
  "sourcePlanBundleSha256",
]);
const SAFE_CODES = new Set(["configuration", "interval", "hash", "integrity"]);
const FAILURE_OPERATIONS = new Set(["create", "verify", "summarize"]);
const FAILURE_SOURCES = new Set([
  "codex", "collector", "claude_status", "claude_transcript", "workspace_projection", "totals",
]);
// Keep diagnostic provenance out of mutable Error properties. A caller cannot
// forge context by setting error.context, and no raw error/plan is retained.
const FAILURE_CONTEXTS = new WeakMap();

class ExportSourcePlanBundleError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export source-plan bundle failure code");
    super(`Local export source-plan bundle failed (${code})`);
    this.name = "ExportSourcePlanBundleError";
    this.code = `export_source_plan_bundle_${code}`;
  }
}

function fail(code) {
  throw new ExportSourcePlanBundleError(code);
}

const REASON_OWNERS = [
  [ExportSourcePlanBundleError, "export_source_plan_bundle_"],
  [ExportResourceLimitError, "export_resource_"],
  [ExportSupplementalSourcePlanError, "export_supplemental_source_"],
  [codexSourcePlan.ExportSourcePlanError, "export_source_"],
  [codexCollectorExport.CodexCollectorExportSourceError, "codex_collector_export_"],
  [codexCollectorWorkspace.CodexCollectorWorkspaceSourceError, "codex_collector_workspace_source_"],
  [claudeStatusExport.ClaudeStatusLedgerExportSourceError, "claude_status_ledger_export_"],
  [claudeStatusWorkspace.ClaudeStatusWorkspaceSourceError, "claude_status_workspace_source_"],
  [claudeTranscriptExport.ClaudeTranscriptExportSourceError, "claude_transcript_export_"],
  [claudeTranscriptWorkspace.ClaudeTranscriptWorkspaceSourceError, "claude_transcript_workspace_"],
];

function safeErrorObject(error) {
  return error !== null && typeof error === "object" && !isProxy(error);
}

function hasErrorPrototype(error, prototype) {
  // Preserve genuine typed errors (including subclasses), without invoking a
  // foreign Proxy's getPrototypeOf trap or Error property getters.
  let current = error;
  for (let depth = 0; depth < 32 && safeErrorObject(current); depth += 1) {
    current = Object.getPrototypeOf(current);
    if (current === prototype) return true;
  }
  return false;
}

function failureReason(error) {
  if (!safeErrorObject(error)) return "unknown";
  const prototype = Object.getPrototypeOf(error);
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (!descriptor || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string" || descriptor.value.length > 128) return "unknown";
  for (const [Owner, prefix] of REASON_OWNERS) {
    if (prototype !== Owner.prototype || !descriptor.value.startsWith(prefix)) continue;
    try {
      // The owning constructor is the closed vocabulary authority; neither a
      // foreign code nor a getter can enlarge the diagnostic vocabulary.
      const known = new Owner(descriptor.value.slice(prefix.length));
      return known.code === descriptor.value ? known.code : "unknown";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

function rethrowWithContext(error, operation, source, { preserveResourceError = false } = {}) {
  if (!FAILURE_OPERATIONS.has(operation) || !FAILURE_SOURCES.has(source)) {
    throw new TypeError("Unknown export source-plan failure context");
  }
  const failure = hasErrorPrototype(error, ExportSourcePlanBundleError.prototype)
    || (preserveResourceError && hasErrorPrototype(error, ExportResourceLimitError.prototype))
    ? error : new ExportSourcePlanBundleError("integrity");
  if (!FAILURE_CONTEXTS.has(failure)) {
    FAILURE_CONTEXTS.set(failure, Object.freeze({ operation, source, reason: failureReason(error) }));
  }
  throw failure;
}

/** Only failures observed at this bundle's real catch boundaries have context. */
function exportSourcePlanBundleFailureContext(error) {
  return FAILURE_CONTEXTS.get(error) ?? null;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function bundleDigest(value) {
  const { sourcePlanBundleSha256: ignored, ...payload } = value;
  return createHash("sha256")
    .update("app-usagemonitor/export-source-plan-bundle/v0.1\0")
    .update(stableJson(payload))
    .digest("hex");
}

function assertBundleEnvelope(bundle) {
  if (!exactKeys(bundle, BUNDLE_KEYS)
      || bundle.schemaVersion !== EXPORT_SOURCE_PLAN_BUNDLE_VERSION
      || !validSha256(bundle.sourcePlanBundleSha256)) fail("configuration");
  if (bundle.sourcePlanBundleSha256 !== bundleDigest(bundle)) fail("hash");
}

function combinedPlanGuard(resourceGuard) {
  if (!resourceGuard?.limits) fail("configuration");
  return {
    limits: resourceGuard.limits,
    assertCoveredInterval: resourceGuard.assertCoveredInterval.bind(resourceGuard),
    checkRuntime: resourceGuard.checkRuntime.bind(resourceGuard),
    observeDirectoryEntry: resourceGuard.observeDirectoryEntry.bind(resourceGuard),
    observeLine: resourceGuard.observeLine.bind(resourceGuard),
    assertSourceSelection: resourceGuard.assertSourceSelection.bind(resourceGuard),
    observeSourceFile() {
      resourceGuard.checkRuntime();
    },
    // Each native planner/verifier validates its own totals. The canonical
    // aggregate selection is charged exactly once after every plan agrees.
    observeSourcePlan() {
      resourceGuard.checkRuntime();
    },
  };
}

function planTotals(bundle) {
  let sourceFiles = bundle.codexPlan.sources.length;
  let sourceBytes = bundle.codexPlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0);
  if (bundle.collectorPlan !== null) {
    sourceFiles += 1;
    sourceBytes += bundle.collectorPlan.prefixBytes;
  }
  if (bundle.claudeStatusPlan !== null) {
    sourceFiles += bundle.claudeStatusPlan.recordCount;
    sourceBytes += bundle.claudeStatusPlan.totalBytes;
  }
  if (bundle.claudeTranscriptPlan !== null) {
    sourceFiles += bundle.claudeTranscriptPlan.sourceCount;
    sourceBytes += bundle.claudeTranscriptPlan.totalBytes;
  }
  if (!Number.isSafeInteger(sourceFiles) || !Number.isSafeInteger(sourceBytes)) fail("integrity");
  return { sourceFiles, sourceBytes };
}

function assertPlanInterval(plan, bounds) {
  if (!plan || plan.startAt !== bounds.startAt || plan.endAt !== bounds.endAt) fail("interval");
}

function derivedWorkspacePlans(bundle, secret) {
  let supplementalSourcePlan = createEmptySupplementalSourcePlan();
  const supplementalPrivatePlans = [];
  if (bundle.collectorPlan !== null) {
    supplementalSourcePlan = appendCodexCollectorWorkspaceSource(
      supplementalSourcePlan,
      bundle.collectorPlan,
    );
  }
  if (bundle.claudeStatusPlan !== null) {
    supplementalSourcePlan = appendClaudeStatusWorkspaceSource(
      supplementalSourcePlan,
      bundle.claudeStatusPlan,
    );
    supplementalPrivatePlans.push({
      sourceKey: claudeStatusWorkspaceSourceKey(bundle.claudeStatusPlan.sourceKey),
      valueJson: stableJson(bundle.claudeStatusPlan),
    });
  }
  if (bundle.claudeTranscriptPlan !== null) {
    supplementalSourcePlan = appendClaudeTranscriptWorkspaceSources(
      supplementalSourcePlan,
      bundle.claudeTranscriptPlan,
      { secret },
    );
    const singlePlans = sliceClaudeTranscriptExportSourcePlans(bundle.claudeTranscriptPlan, { secret });
    supplementalPrivatePlans.push(...singlePlans.map((plan) => ({
      sourceKey: plan.sources[0].sourceKey,
      valueJson: stableJson(plan),
    })));
  }
  // Re-normalize and total the derived public plan before it reaches workspace
  // persistence. This also proves that all private rows have public peers.
  summarizeSupplementalSourcePlan(supplementalSourcePlan);
  return { supplementalSourcePlan, supplementalPrivatePlans };
}

/**
 * Return only content-free aggregate measurements of the canonical private
 * bundle representation. Callers can compare canonicalBytes with a transport
 * ceiling without rendering or logging the bundle itself.
 */
function summarizeExportSourcePlanBundle(bundle) {
  assertBundleEnvelope(bundle);
  try {
    const totals = planTotals(bundle);
    const codex = {
      sourceFiles: bundle.codexPlan.sources.length + (bundle.collectorPlan === null ? 0 : 1),
      sourceBytes: bundle.codexPlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0)
        + (bundle.collectorPlan?.prefixBytes ?? 0),
      completeLinePrefixBytes:
        bundle.codexPlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0)
        + (bundle.collectorPlan?.prefixBytes ?? 0),
    };
    const claude = {
      sourceFiles: (bundle.claudeStatusPlan?.recordCount ?? 0)
        + (bundle.claudeTranscriptPlan?.sourceCount ?? 0),
      sourceBytes: (bundle.claudeStatusPlan?.totalBytes ?? 0)
        + (bundle.claudeTranscriptPlan?.totalBytes ?? 0),
      completeLinePrefixBytes: (bundle.claudeStatusPlan?.totalBytes ?? 0)
        + (bundle.claudeTranscriptPlan?.totalBytes ?? 0),
    };
    return {
      schemaVersion: EXPORT_SOURCE_PLAN_BUNDLE_VERSION,
      canonicalBytes: bufferByteLength(stableJson(bundle), "utf8"),
      ...totals,
      codex,
      claude,
    };
  } catch (error) {
    rethrowWithContext(error, "summarize", "totals");
  }
}

/**
 * Freeze every explicitly enabled local source once. The returned value is a
 * private capability: it can contain paths, filesystem identities, and HMAC-
 * bound source selections and must never be rendered or logged.
 */
async function createExportSourcePlanBundle({
  startAt,
  endAt,
  codexHome,
  secret,
  collectorPath = null,
  claudeStateDirectory = null,
  claudeProjectsDirectory = null,
  resourceGuard,
} = {}) {
  if (!secret || !resourceGuard?.limits || typeof codexHome !== "string" || codexHome.length === 0
      || (collectorPath !== null && (typeof collectorPath !== "string" || collectorPath.length === 0))
      || (claudeStateDirectory !== null
        && (typeof claudeStateDirectory !== "string" || claudeStateDirectory.length === 0))
      || (claudeProjectsDirectory !== null
        && (typeof claudeProjectsDirectory !== "string" || claudeProjectsDirectory.length === 0))) {
    fail("configuration");
  }
  const bounds = normalizeExportBounds(startAt, endAt);
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  const planningGuard = combinedPlanGuard(resourceGuard);
  let source = "collector";
  try {
    const collector = collectorPath === null ? null : await createCodexCollectorWorkspaceSource({
      collectorPath: resolvePath(collectorPath),
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard: planningGuard,
    });
    source = "claude_status";
    const claudeStatus = claudeStateDirectory === null ? null : await createClaudeStatusWorkspaceSource({
      stateDirectory: resolvePath(claudeStateDirectory),
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      secret,
      resourceGuard: planningGuard,
    });
    source = "claude_transcript";
    const claudeTranscript = claudeProjectsDirectory === null ? null
      : await createClaudeTranscriptWorkspaceSource({
        projectsDirectory: resolvePath(claudeProjectsDirectory),
        startAt: bounds.startAt,
        endAt: bounds.endAt,
        secret,
        resourceGuard: planningGuard,
      });
    if (claudeTranscript !== null && claudeTranscript.sources.length === 0) fail("configuration");
    source = "codex";
    const codexPlan = await createCodexExportSourcePlan({
      codexHome,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard: planningGuard,
    });
    source = "workspace_projection";
    const bundle = {
      schemaVersion: EXPORT_SOURCE_PLAN_BUNDLE_VERSION,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      codexPlan,
      collectorPlan: collector?.collectorPlan ?? null,
      claudeStatusPlan: claudeStatus?.claudePlan ?? null,
      claudeTranscriptPlan: claudeTranscript?.transcriptPlan ?? null,
      sourcePlanBundleSha256: "0".repeat(64),
    };
    bundle.sourcePlanBundleSha256 = bundleDigest(bundle);
    source = "totals";
    const totals = planTotals(bundle);
    resourceGuard.observeSourcePlan(totals.sourceFiles, totals.sourceBytes);
    return bundle;
  } catch (error) {
    rethrowWithContext(error, "create", source, { preserveResourceError: true });
  }
}

/** Verify and expand a private frozen bundle without source rediscovery. */
async function resolveExportSourcePlanBundle(bundle, {
  startAt,
  endAt,
  secret,
  resourceGuard,
} = {}) {
  if (!secret || !resourceGuard?.limits) fail("configuration");
  assertBundleEnvelope(bundle);
  const bounds = normalizeExportBounds(startAt, endAt);
  if (bundle.startAt !== bounds.startAt || bundle.endAt !== bounds.endAt) fail("interval");
  for (const plan of [
    bundle.codexPlan,
    bundle.collectorPlan,
    bundle.claudeStatusPlan,
    bundle.claudeTranscriptPlan,
  ]) {
    if (plan !== null) assertPlanInterval(plan, bounds);
  }
  const verificationGuard = combinedPlanGuard(resourceGuard);
  let source = "codex";
  try {
    await verifyCodexExportSourcePlan(bundle.codexPlan, { resourceGuard: verificationGuard });
    if (bundle.collectorPlan !== null) {
      source = "collector";
      await verifyCodexCollectorExportSourcePlan(bundle.collectorPlan, { resourceGuard: verificationGuard });
    }
    if (bundle.claudeStatusPlan !== null) {
      source = "claude_status";
      await verifyClaudeStatusLedgerExportSourcePlan(bundle.claudeStatusPlan, {
        secret,
        resourceGuard: verificationGuard,
      });
    }
    if (bundle.claudeTranscriptPlan !== null) {
      source = "claude_transcript";
      for (const transcriptSource of bundle.claudeTranscriptPlan.sources) {
        await verifyClaudeTranscriptExportSource(bundle.claudeTranscriptPlan, transcriptSource.sourceKey, {
          secret,
          resourceGuard: verificationGuard,
        });
      }
    }
    source = "workspace_projection";
    const workspacePlans = derivedWorkspacePlans(bundle, secret);
    source = "totals";
    const totals = planTotals(bundle);
    const supplementalSummary = summarizeSupplementalSourcePlan(workspacePlans.supplementalSourcePlan);
    const derivedFiles = bundle.codexPlan.sources.length + supplementalSummary.sourceFiles;
    const derivedBytes = bundle.codexPlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0)
      + supplementalSummary.sourceBytes;
    if (derivedFiles !== totals.sourceFiles || derivedBytes !== totals.sourceBytes) fail("integrity");
    resourceGuard.observeSourcePlan(totals.sourceFiles, totals.sourceBytes);
    return {
      // The controller annotates rolloutInfo with a workspace-local ordinal.
      // Keep those annotations out of the reusable hash-bound capability.
      sourcePlan: structuredClone(bundle.codexPlan),
      ...workspacePlans,
      collectorPath: bundle.collectorPlan?.path ?? null,
      claudeStateDirectory: bundle.claudeStatusPlan?.stateDirectory ?? null,
      claudeProjectsDirectory: bundle.claudeTranscriptPlan?.rootDirectory ?? null,
    };
  } catch (error) {
    rethrowWithContext(error, "verify", source, { preserveResourceError: true });
  }
}

return Object.freeze({
  EXPORT_SOURCE_PLAN_BUNDLE_VERSION,
  ExportSourcePlanBundleError,
  exportSourcePlanBundleFailureContext,
  createExportSourcePlanBundle,
  resolveExportSourcePlanBundle,
  summarizeExportSourcePlanBundle,
});
}
