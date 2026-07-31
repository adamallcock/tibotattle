import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { validateClaudeStatusSnapshot } from "./claude-statusline.js";
import { createLocalCodexLogScanner } from "./application/index.js";
import { createLocalCodexLogPorts } from "./platform/index.js";
import {
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
} from "./export-identity.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  createCodexCheckpointStateContext,
  createSafeRecordsContext,
  stableJson,
} from "./export/index.js";
import { createExportResourceGuard } from "./export-resource-policy.js";
import { assertValidExportRecord } from "./export-schema.js";

const { scanCodexLogEvents } = createLocalCodexLogScanner(createLocalCodexLogPorts());
const checkpointState = createCodexCheckpointStateContext({ createHash, isProxy });
const safeRecords = createSafeRecordsContext({
  assertValidExportRecord,
  createHash,
  createExportResourceGuard,
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  exportCompatibilityTuple,
  isProxy,
  scanCodexLogEvents,
  stableJson,
  validateClaudeStatusSnapshot,
  ...checkpointState,
});

// Exact legacy composition shim. The export owner contains all record logic;
// this file supplies concrete Node/legacy ports only.
export const createEmptySafeToolClassCounts = safeRecords.createEmptySafeToolClassCounts;
export const diagnosticsFromCodexScan = safeRecords.diagnosticsFromCodexScan;
export const normalizeActivityMarker = safeRecords.normalizeActivityMarker;
export const normalizeClaudeStatusQuotaSnapshots = safeRecords.normalizeClaudeStatusQuotaSnapshots;
export const normalizeClaudeTranscriptUsageCandidate = safeRecords.normalizeClaudeTranscriptUsageCandidate;
export const normalizeCodexCollectorQuotaCandidate = safeRecords.normalizeCodexCollectorQuotaCandidate;
export const normalizeCodexQuotaSnapshot = safeRecords.normalizeCodexQuotaSnapshot;
export const normalizeCodexUsageEvent = safeRecords.normalizeCodexUsageEvent;
export const normalizeExportBounds = safeRecords.normalizeExportBounds;
export const quotaObservationIdentitySubject = safeRecords.quotaObservationIdentitySubject;
export const quotaStateIdentitySubject = safeRecords.quotaStateIdentitySubject;
export const safeExportModelDeclaration = safeRecords.safeExportModelDeclaration;
export const safeToolCountFieldForScannerToolClass = safeRecords.safeToolCountFieldForScannerToolClass;
export const scanCodexSafeRecords = safeRecords.scanCodexSafeRecords;
export const summarizeActivityMarkerPlan = safeRecords.summarizeActivityMarkerPlan;
export const usageEventIdentitySubject = safeRecords.usageEventIdentitySubject;
