// Internal composition root shared only by the two historical deletion shims.
// Keeping the singleton here preserves binding identity without expanding
// either legacy module's named-export surface.
import { createLocalExportDeletion } from "./application/index.js";
import { verifyLocalExportSet } from "./export-set-verifier.js";
import {
  EXPORT_WORKSPACE_DATABASE_BASENAME,
  openExportWorkspace,
} from "./export-workspace.js";
import { LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL } from "./export-workspace-lock-compatibility-internal.js";
import {
  createOwnerOnlyExportDeletionPreflightInspector,
  createOwnerOnlyExportDeletionStorage,
} from "./platform/index.js";

export const LEGACY_EXPORT_DELETION_INTERNAL = createLocalExportDeletion(Object.freeze({
  verifyExportSet: verifyLocalExportSet,
  openExportWorkspace,
  withExistingExportWorkspaceLease: LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL.withExistingExportWorkspaceLease,
  isTrustedExportWorkspaceLockError: LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL.isTrustedExportWorkspaceLockError,
  workspaceDatabaseBasename: EXPORT_WORKSPACE_DATABASE_BASENAME,
  createPreflightInspector: createOwnerOnlyExportDeletionPreflightInspector,
  createDeletionStorage: createOwnerOnlyExportDeletionStorage,
}));
