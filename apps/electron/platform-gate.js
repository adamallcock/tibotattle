import {
  assertWindowsProductionReadiness,
} from "../../src/platform/index.js";

import { shellError } from "./errors.js";
import {
  assertWindowsElectronQualificationContext,
} from "./windows-qualification.js";

/**
 * Electron does not authorize Windows production storage. On Windows the
 * shell may launch only after the same branded readiness attestation used by
 * the credential consumers is supplied. Linux development remains available
 * for shared-shell work, but a packaged Linux production selection must stop
 * before it reaches companion, credential, network, or updater composition.
 */
export function assertElectronPlatformGate({
  platform = process.platform,
  architecture = process.arch,
  readiness = null,
  qualificationContext = null,
  productionDistribution = null,
} = {}) {
  // The current Linux receipt and Secret Service foundations are explicitly
  // development-only and dormant. They are not authority to run a stable
  // packaged candidate while its production credential/identity adapters and
  // native lifecycle gates remain unqualified.
  if (platform === "linux"
      && productionDistribution !== null && productionDistribution !== undefined) {
    throw shellError("linux_readiness_unavailable");
  }
  if (platform !== "win32") {
    return Object.freeze({
      platform,
      architecture,
      windowsProductionReady: false,
    });
  }
  try {
    try {
      assertWindowsProductionReadiness({
        platform,
        architecture,
        readiness,
      });
    } catch {
      assertWindowsElectronQualificationContext({
        context: qualificationContext,
        platform,
        architecture,
      });
      return Object.freeze({
        platform,
        architecture,
        windowsProductionReady: false,
        windowsQualificationOnly: true,
      });
    }
  } catch {
    throw shellError("windows_readiness_unavailable");
  }
  return Object.freeze({
    platform,
    architecture,
    windowsProductionReady: true,
    windowsQualificationOnly: false,
  });
}
