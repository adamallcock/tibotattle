import {
  createLocalExportSetVerificationContext,
} from "./application/index.js";
import {
  loadVerifiedLocalMetadataBundleBytes,
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
} from "./export-set-materializer.js";
import {
  createExportSetVerificationStorageContext,
} from "./platform/index.js";

const LEGACY_EXPORT_SET_VERIFICATION =
  createLocalExportSetVerificationContext({
    storage: createExportSetVerificationStorageContext(),
    bundleVerification: {
      loadVerifiedLocalMetadataBundleBytes,
      loadVerifiedLocalMetadataBundleFiles,
    },
    exportCompatibilityTuple,
    manifestBasename: EXPORT_SET_MANIFEST_BASENAME,
    manifestReceiptBasename: EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  });

export {
  ExportSetVerificationError,
} from "./export/index.js";

export const { verifyLocalExportSet } = LEGACY_EXPORT_SET_VERIFICATION;
