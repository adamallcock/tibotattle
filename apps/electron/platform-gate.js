import {
  assertWindowsProductionReadiness,
} from "../../src/platform/index.js";

import { shellError } from "./errors.js";

/**
 * Electron does not authorize Windows production storage. On Windows the
 * shell may launch only after the same branded readiness attestation used by
 * the credential consumers is supplied. macOS/Linux development remain
 * available for the shared-shell work.
 */
export function assertElectronPlatformGate({
  platform = process.platform,
  architecture = process.arch,
  readiness = null,
} = {}) {
  if (platform !== "win32") {
    return Object.freeze({
      platform,
      architecture,
      windowsProductionReady: false,
    });
  }
  try {
    assertWindowsProductionReadiness({
      platform,
      architecture,
      readiness,
    });
  } catch {
    throw shellError("windows_readiness_unavailable");
  }
  return Object.freeze({
    platform,
    architecture,
    windowsProductionReady: true,
  });
}
