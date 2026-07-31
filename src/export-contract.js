import {
  createExportCompatibilityContext,
} from "./application/index.js";
import {
  readExportCompatibilityArtifactSet,
  sha256Hex,
} from "./platform/index.js";

const legacyCompatibility = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
});

export const buildExportCompatibilityTuple =
  legacyCompatibility.buildExportCompatibilityTuple;
export const exportCompatibilityTuple =
  legacyCompatibility.exportCompatibilityTuple;

export { EXPORTER_VERSION } from "./export/index.js";
