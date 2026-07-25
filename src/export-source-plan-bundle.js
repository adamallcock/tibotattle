import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createCodexCollectorWorkspaceSource, appendCodexCollectorWorkspaceSource } from "./codex-collector-workspace-source.js";
import { verifyCodexCollectorExportSourcePlan } from "./codex-collector-export-source.js";
import {
  appendClaudeStatusWorkspaceSource,
  claudeStatusWorkspaceSourceKey,
  createClaudeStatusWorkspaceSource,
} from "./claude-statusline-workspace-source.js";
import { verifyClaudeStatusLedgerExportSourcePlan } from "./claude-statusline-export-source.js";
import {
  appendClaudeTranscriptWorkspaceSources,
  createClaudeTranscriptWorkspaceSource,
} from "./claude-transcript-workspace-source.js";
import {
  sliceClaudeTranscriptExportSourcePlans,
  verifyClaudeTranscriptExportSource,
} from "./claude-transcript-export-source.js";
import { createCodexExportSourcePlan, verifyCodexExportSourcePlan } from "./export-source-plan.js";
import {
  createEmptySupplementalSourcePlan,
  summarizeSupplementalSourcePlan,
} from "./export-supplemental-source-plan.js";
import { normalizeExportBounds } from "./export-safe-records.js";
import { stableJson } from "./storage.js";

export const EXPORT_SOURCE_PLAN_BUNDLE_VERSION = "export-source-plan-bundle-v0.1";

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

export class ExportSourcePlanBundleError extends Error {
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

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
export function summarizeExportSourcePlanBundle(bundle) {
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
      canonicalBytes: Buffer.byteLength(stableJson(bundle), "utf8"),
      ...totals,
      codex,
      claude,
    };
  } catch (error) {
    if (error instanceof ExportSourcePlanBundleError) throw error;
    fail("integrity");
  }
}

/**
 * Freeze every explicitly enabled local source once. The returned value is a
 * private capability: it can contain paths, filesystem identities, and HMAC-
 * bound source selections and must never be rendered or logged.
 */
export async function createExportSourcePlanBundle({
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
  try {
    const collector = collectorPath === null ? null : await createCodexCollectorWorkspaceSource({
      collectorPath: resolvePath(collectorPath),
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard: planningGuard,
    });
    const claudeStatus = claudeStateDirectory === null ? null : await createClaudeStatusWorkspaceSource({
      stateDirectory: resolvePath(claudeStateDirectory),
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      secret,
      resourceGuard: planningGuard,
    });
    const claudeTranscript = claudeProjectsDirectory === null ? null
      : await createClaudeTranscriptWorkspaceSource({
        projectsDirectory: resolvePath(claudeProjectsDirectory),
        startAt: bounds.startAt,
        endAt: bounds.endAt,
        secret,
        resourceGuard: planningGuard,
      });
    if (claudeTranscript !== null && claudeTranscript.sources.length === 0) fail("configuration");
    const codexPlan = await createCodexExportSourcePlan({
      codexHome,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard: planningGuard,
    });
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
    const totals = planTotals(bundle);
    resourceGuard.observeSourcePlan(totals.sourceFiles, totals.sourceBytes);
    return bundle;
  } catch (error) {
    if (error instanceof ExportSourcePlanBundleError || error?.name === "ExportResourceLimitError") throw error;
    fail("integrity");
  }
}

/** Verify and expand a private frozen bundle without source rediscovery. */
export async function resolveExportSourcePlanBundle(bundle, {
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
  try {
    await verifyCodexExportSourcePlan(bundle.codexPlan, { resourceGuard: verificationGuard });
    if (bundle.collectorPlan !== null) {
      await verifyCodexCollectorExportSourcePlan(bundle.collectorPlan, { resourceGuard: verificationGuard });
    }
    if (bundle.claudeStatusPlan !== null) {
      await verifyClaudeStatusLedgerExportSourcePlan(bundle.claudeStatusPlan, {
        secret,
        resourceGuard: verificationGuard,
      });
    }
    if (bundle.claudeTranscriptPlan !== null) {
      for (const source of bundle.claudeTranscriptPlan.sources) {
        await verifyClaudeTranscriptExportSource(bundle.claudeTranscriptPlan, source.sourceKey, {
          secret,
          resourceGuard: verificationGuard,
        });
      }
    }
    const workspacePlans = derivedWorkspacePlans(bundle, secret);
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
    if (error instanceof ExportSourcePlanBundleError || error?.name === "ExportResourceLimitError") throw error;
    fail("integrity");
  }
}
