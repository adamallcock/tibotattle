// Exact legacy alias over the one process-wide workspace composition.
import { LEGACY_EXPORT_WORKSPACE_INTERNAL as workspace } from "./export-workspace-compatibility-internal.js";

export const EXPORT_WORKSPACE_VERSION = workspace.EXPORT_WORKSPACE_VERSION;
export const DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES = workspace.DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES;
export const DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS = workspace.DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS;
export const EXPORT_WORKSPACE_DATABASE_BASENAME = workspace.EXPORT_WORKSPACE_DATABASE_BASENAME;
export const ExportWorkspaceError = workspace.ExportWorkspaceError;
export const sourceCheckpointBatchSha256 = workspace.sourceCheckpointBatchSha256;
export const supplementalSourceCheckpointBatchSha256 = workspace.supplementalSourceCheckpointBatchSha256;
export const buildExportWorkspaceDescriptor = workspace.buildExportWorkspaceDescriptor;
export const createExportWorkspace = workspace.createExportWorkspace;
export const openExportWorkspace = workspace.openExportWorkspace;
export const inspectExportWorkspaceDiscardState = workspace.inspectExportWorkspaceDiscardState;
