// Internal composition shared by the historical lock shim and deletion owner.
// The public lock shim deliberately continues to expose only its three legacy
// bindings; the recognizer remains an internal trust-boundary capability.
import { stableJson } from "./export/index.js";
import { createLocalExportWorkspaceLeaseContext } from "./application/index.js";
import { createOwnerOnlyExportWorkspaceLeaseContext } from "./platform/index.js";

export const LEGACY_EXPORT_WORKSPACE_LEASE_INTERNAL = createLocalExportWorkspaceLeaseContext({
  stableJson,
  createLease: createOwnerOnlyExportWorkspaceLeaseContext,
});
