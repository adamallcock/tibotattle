// Internal singleton shared by the two historical discard facades. Keeping
// composition here preserves export binding identity while all real ownership
// lives in export/application/platform.
import { createLocalExportWorkspaceDiscard } from "./application/index.js";
import { readBoundedDirectoryEntries } from "./export-resource-policy.js";
import {
  EXPORT_WORKSPACE_DATABASE_BASENAME,
  inspectExportWorkspaceDiscardState,
} from "./export-workspace.js";
import { LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL } from "./export-workspace-lock-compatibility-internal.js";
import {
  createOwnerOnlyExportWorkspaceDiscardPreflight,
  createOwnerOnlyExportWorkspaceDiscardStorage,
} from "./platform/index.js";

export const LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL = createLocalExportWorkspaceDiscard(Object.freeze({
  workspaceDatabaseBasename: EXPORT_WORKSPACE_DATABASE_BASENAME,
  inspectExportWorkspaceDiscardState,
  readBoundedDirectoryEntries,
  withExistingExportWorkspaceLease: LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL.withExistingExportWorkspaceLease,
  createPreflight: createOwnerOnlyExportWorkspaceDiscardPreflight,
  createStorage: createOwnerOnlyExportWorkspaceDiscardStorage,
}));
