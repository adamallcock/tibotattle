import { exportCompatibilityTuple } from "./export-contract.js";
import { deriveParticipantId } from "./export-identity.js";
import { createExportResourceGuard } from "./export-resource-policy.js";
import {
  scanCodexSafeRecords,
  normalizeExportBounds,
  summarizeActivityMarkerPlan,
} from "./export-safe-records.js";
import {
  createCodexExportSourcePlan,
  openVerifiedCodexExportSource,
  resolveCodexExportSourcePlan,
  verifyCodexExportSourceHandle,
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
} = {}) {
  const batch = [];
  async function flush() {
    if (batch.length === 0) return;
    const records = batch.splice(0, batch.length);
    await workspace.insertRecordBatch(records);
    resourceGuard.observeWorkspace((await workspace.status()).workspaceBytes);
    await failpoint("after_record_batch");
  }
  let scan;
  try {
    scan = await scanCodexSafeRecords({
      startAt: sourcePlan.startAt,
      endAt: sourcePlan.endAt,
      secret,
      activityMarkers,
      resourceGuard,
      rolloutInfos: sourcePlan.sources.map((source) => source.rolloutInfo),
      openRolloutSource(info) {
        const source = sourcePlan.sources[info.sourcePlanOrdinal];
        return openVerifiedCodexExportSource(source, { resourceGuard });
      },
      verifyRolloutSource(info, handle) {
        const source = sourcePlan.sources[info.sourcePlanOrdinal];
        return verifyCodexExportSourceHandle(source, handle, { resourceGuard });
      },
      async onRecord(envelope) {
        batch.push(envelope);
        if (batch.length >= DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) await flush();
      },
    });
  } catch (error) {
    if (error instanceof ExportSourcePlanError) workspace.markPoisoned("source_integrity");
    throw error;
  }
  await flush();
  workspace.replaceDiagnostics(scan.diagnostics.codes);
  await failpoint("after_diagnostics");
  workspace.markScanComplete({ sourceFilesScanned: scan.diagnostics.sourceFilesScanned });
  await failpoint("after_scan_complete");
  return workspace.status();
}

function assertResumeDescriptor(descriptor, secret) {
  if (descriptor.participantId !== deriveParticipantId(secret)
      || stableJson(descriptor.compatibility) !== stableJson(exportCompatibilityTuple())) {
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
  });
  const workspace = await createExportWorkspace({
    directory,
    descriptor,
    sourcePlan,
    maximumWorkspaceBytes: resourceGuard.limits.maximumWorkspaceBytes,
  });
  try {
    const status = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
    });
    return { descriptor, status, resourceUsage: resourceGuard.snapshot() };
  } finally {
    workspace.close();
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
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const resourceGuard = createExportResourceGuard({
    limits: resourceLimits,
    scope: "export_set",
    ...(resourceClock ? { clock: resourceClock } : {}),
    ...(resourceRss ? { rss: resourceRss } : {}),
  });
  const workspace = await openExportWorkspace({
    directory,
    maximumWorkspaceBytes: resourceGuard.limits.maximumWorkspaceBytes,
  });
  try {
    const descriptor = workspace.getDescriptor();
    assertResumeDescriptor(descriptor, secret);
    if (workspace.isPoisoned()) throw new ExportWorkspaceError("checkpoint_mismatch");
    const storedPlan = workspace.loadSourcePlan();
    resourceGuard.assertCoveredInterval(Date.parse(storedPlan.startAt), Date.parse(storedPlan.endAt));
    const sourcePlan = await resolveCodexExportSourcePlan(storedPlan, { codexHome, resourceGuard });
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
      return { descriptor, status: await workspace.status(), resourceUsage: resourceGuard.snapshot() };
    }
    const status = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
    });
    return { descriptor, status, resourceUsage: resourceGuard.snapshot() };
  } finally {
    workspace.close();
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
