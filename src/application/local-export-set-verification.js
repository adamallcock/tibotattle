import { createLocalExportSetVerifier } from "../export/index.js";

export function createLocalExportSetVerificationContext(options = {}) {
  return createLocalExportSetVerifier(options);
}
