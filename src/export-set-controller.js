import { exportCompatibilityTuple } from "./export-contract.js";
import { deriveParticipantId } from "./export-identity.js";
import { createExportResourceGuard, normalizeExportResourceLimits } from "./export-resource-policy.js";
import {
  normalizeActivityMarker,
  normalizeExportBounds,
  summarizeActivityMarkerPlan,
} from "./export-safe-records.js";
import { populateCheckpointedCodexSources } from "./codex-export-checkpoint-scan.js";
import {
  createCodexExportSourcePlan,
  resolveCodexExportSourcePlan,
  ExportSourcePlanError,
} from "./export-source-plan.js";
import {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS,
  ExportWorkspaceError,
  openExportWorkspace,
} from "./export-workspace.js";
import { stableJson } from "./storage.js";
import { withExportWorkspaceLease } from "./export-workspace-lock.js";

async function populateWorkspace({
  workspace,
  sourcePlan,
  secret,
  activityMarkers,
  resourceGuard,
  failpoint = async () => {},
  checkpointLinesPerBatch,
} = {}) {
  await populateCheckpointedCodexSources({
    workspace,
    sourcePlan,
    secret,
    resourceGuard,
    failpoint,
    ...(checkpointLinesPerBatch === undefined ? {} : { maximumLinesPerBatch: checkpointLinesPerBatch }),
  });
  const bounds = {
    startAt: sourcePlan.startAt,
    endAt: sourcePlan.endAt,
    startMs: Date.parse(sourcePlan.startAt),
    endMs: Date.parse(sourcePlan.endAt),
  };
  const pendingMarkerIds = new Set();
  const markerBatch = [];
  for (const marker of activityMarkers) {
    const record = normalizeActivityMarker(secret, marker, bounds);
    if (!record || pendingMarkerIds.has(record.markerId)
        || workspace.hasRecord("activityMarker", record.markerId)) continue;
    resourceGuard.observeOutputRecord(Buffer.byteLength(stableJson(record), "utf8"));
    markerBatch.push({ recordType: "activityMarker", record });
    pendingMarkerIds.add(record.markerId);
    if (markerBatch.length >= DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) {
      await workspace.insertRecordBatch(markerBatch.splice(0, markerBatch.length));
      pendingMarkerIds.clear();
      await failpoint("after_record_batch");
    }
  }
  if (markerBatch.length > 0) {
    await workspace.insertRecordBatch(markerBatch);
    await failpoint("after_record_batch");
  }
  await failpoint("after_diagnostics");
  workspace.finalizeScan();
  await failpoint("after_scan_complete");
  return workspace.status();
}

function assertResumeDescriptor(descriptor, secret, resourceLimits) {
  if (descriptor.participantId !== deriveParticipantId(secret)
      || stableJson(descriptor.compatibility) !== stableJson(exportCompatibilityTuple())
      || stableJson(descriptor.resourceLimits) !== stableJson(resourceLimits)) {
    throw new ExportWorkspaceError("checkpoint_mismatch");
  }
}

async function createLocalExportWorkspaceUnlocked({
  directory,
  startAt,
  endAt,
  codexHome,
  secret,
  activityMarkers = [],
  createdAt = new Date().toISOString(),
  resourceLimits = {},
  resourceClock,
  resourceRss,
  failpoint,
  checkpointLinesPerBatch,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const bounds = normalizeExportBounds(startAt, endAt);
  const resourceGuard = createExportResourceGuard({
    limits: resourceLimits,
    scope: "export_set",
    ...(resourceClock ? { clock: resourceClock } : {}),
    ...(resourceRss ? { rss: resourceRss } : {}),
  });
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  const sourcePlan = await createCodexExportSourcePlan({
    codexHome,
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    resourceGuard,
  });
  const activityPlan = summarizeActivityMarkerPlan(secret, activityMarkers, bounds);
  for (const source of sourcePlan.sources) source.rolloutInfo.sourcePlanOrdinal = source.ordinal;
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(secret),
    createdAt,
    coveredAt: bounds,
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    activityPlan,
    resourceLimits: resourceGuard.limits,
  });
  const workspace = await createExportWorkspace({
    directory,
    descriptor,
    sourcePlan,
    maximumWorkspaceBytes: resourceGuard.limits.maximumWorkspaceBytes,
  });
  let invocationBegun = false;
  let invocationSucceeded = false;
  try {
    workspace.beginInvocation();
    invocationBegun = true;
    const status = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
      checkpointLinesPerBatch,
    });
    invocationSucceeded = true;
    return { descriptor, status, resourceUsage: resourceGuard.snapshot() };
  } finally {
    try {
      let durableUsage = null;
      try {
        durableUsage = resourceGuard.durableSnapshot();
      } catch {
        // Preserve the original failure; the stale-invocation reservation
        // remains the conservative fallback if this process cannot finish.
      }
      if (invocationBegun && (durableUsage !== null || invocationSucceeded)) {
        workspace.finishInvocation({ resourceUsage: durableUsage });
      }
    } finally {
      workspace.close();
    }
  }
}

async function resumeLocalExportWorkspaceUnlocked({
  directory,
  codexHome,
  secret,
  activityMarkers = [],
  resourceLimits = {},
  resourceClock,
  resourceRss,
  failpoint,
  checkpointLinesPerBatch,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const normalizedLimits = normalizeExportResourceLimits(resourceLimits);
  const workspace = await openExportWorkspace({
    directory,
    maximumWorkspaceBytes: normalizedLimits.maximumWorkspaceBytes,
  });
  let invocationBegun = false;
  let resourceGuard = null;
  let invocationSucceeded = false;
  try {
    const descriptor = workspace.getDescriptor();
    assertResumeDescriptor(descriptor, secret, normalizedLimits);
    if (workspace.isPoisoned()) throw new ExportWorkspaceError("checkpoint_mismatch");
    workspace.beginInvocation();
    invocationBegun = true;
    resourceGuard = createExportResourceGuard({
      limits: normalizedLimits,
      scope: "export_set",
      initialUsage: workspace.resourceUsage(),
      ...(resourceClock ? { clock: resourceClock } : {}),
      ...(resourceRss ? { rss: resourceRss } : {}),
    });
    const storedPlan = workspace.loadSourcePlan();
    resourceGuard.assertCoveredInterval(Date.parse(storedPlan.startAt), Date.parse(storedPlan.endAt));
    let sourcePlan;
    try {
      sourcePlan = await resolveCodexExportSourcePlan(storedPlan, { codexHome, resourceGuard });
    } catch (error) {
      if (error instanceof ExportSourcePlanError) workspace.markPoisoned("source_integrity");
      throw error;
    }
    workspace.rebindSourcePaths(sourcePlan);
    const activityPlan = summarizeActivityMarkerPlan(secret, activityMarkers, {
      startAt: storedPlan.startAt,
      endAt: storedPlan.endAt,
      startMs: Date.parse(storedPlan.startAt),
      endMs: Date.parse(storedPlan.endAt),
    });
    if (stableJson(activityPlan) !== stableJson(descriptor.activityPlan)) {
      throw new ExportWorkspaceError("checkpoint_mismatch");
    }
    for (const source of sourcePlan.sources) source.rolloutInfo.sourcePlanOrdinal = source.ordinal;
    if (workspace.isScanComplete()) {
      resourceGuard.observeWorkspace((await workspace.status()).workspaceBytes);
      invocationSucceeded = true;
      return { descriptor, status: await workspace.status(), resourceUsage: resourceGuard.snapshot() };
    }
    const status = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
      checkpointLinesPerBatch,
    });
    invocationSucceeded = true;
    return { descriptor, status, resourceUsage: resourceGuard.snapshot() };
  } finally {
    try {
      let durableUsage = null;
      try {
        durableUsage = resourceGuard?.durableSnapshot() ?? null;
      } catch {
        // Preserve the original failure; recovery will charge a reservation.
      }
      if (invocationBegun && (durableUsage !== null || invocationSucceeded)) {
        workspace.finishInvocation({ resourceUsage: durableUsage });
      }
    } finally {
      workspace.close();
    }
  }
}

async function inspectLocalExportWorkspaceUnlocked({ directory } = {}) {
  const workspace = await openExportWorkspace({ directory });
  try {
    const descriptor = workspace.getDescriptor();
    return {
      workspaceVersion: descriptor.workspaceVersion,
      resourcePolicyVersion: descriptor.resourcePolicyVersion,
      coveredAt: structuredClone(descriptor.coveredAt),
      sourcePlan: structuredClone(descriptor.sourcePlan),
      ...await workspace.status(),
    };
  } finally {
    workspace.close();
  }
}

export async function createLocalExportWorkspace(options = {}) {
  if (!options.directory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.directory, () => createLocalExportWorkspaceUnlocked(options));
}

export async function resumeLocalExportWorkspace(options = {}) {
  if (!options.directory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.directory, () => resumeLocalExportWorkspaceUnlocked(options));
}

export async function inspectLocalExportWorkspace(options = {}) {
  if (!options.directory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.directory, () => inspectLocalExportWorkspaceUnlocked(options));
}
