import { createLocalExportWorkspaceRuntimeContext } from "./application/index.js";
import {
  createOwnerOnlyExportWorkspaceLeaseContext,
  createOwnerOnlyExportWorkspaceStorageContext,
  localPlatformName,
  sha256Hex,
} from "./platform/index.js";

export const LEGACY_EXPORT_WORKSPACE_INTERNAL = createLocalExportWorkspaceRuntimeContext({
  createStorage: createOwnerOnlyExportWorkspaceStorageContext,
  createLease: createOwnerOnlyExportWorkspaceLeaseContext,
  sha256Hex,
  platformName: localPlatformName,
});
