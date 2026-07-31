import {
  createExportCompatibilityContext,
  createLocalExportSourcePipelineContext,
} from "./application/index.js";
import {
  createLocalExportSourcePorts,
  localIsProxy,
  readExportCompatibilityArtifactSet,
  sha256Hex,
} from "./platform/index.js";
import { LEGACY_EXPORT_WORKSPACE_INTERNAL as workspace } from "./export-workspace-compatibility-internal.js";

const exportCompatibility = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
});
export const exportSourcePipelineCompatibility = createLocalExportSourcePipelineContext(
  localIsProxy,
  createLocalExportSourcePorts(),
  {
    exportCompatibilityTuple: exportCompatibility.exportCompatibilityTuple,
    workspace,
  },
);
