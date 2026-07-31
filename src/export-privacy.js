import {
  createPrivacySafeBundleVerifier,
} from "./export/bundle-verification.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import { sha256Hex } from "./platform/index.js";

export {
  inspectSensitiveExportStrings,
} from "./export/bundle-verification.js";

export const verifyPrivacySafeBundle = createPrivacySafeBundleVerifier({
  sha256Hex,
  compatibilityTuple: exportCompatibilityTuple,
});
