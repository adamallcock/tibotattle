// Exact legacy composition shim for the platform-owned lease protocol.
import { LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL as lease } from "./export-workspace-lock-compatibility-internal.js";

export const ExportWorkspaceLockError = lease.ExportWorkspaceLockError;
export const withExportWorkspaceLease = lease.withExportWorkspaceLease;
export const withExistingExportWorkspaceLease = lease.withExistingExportWorkspaceLease;
