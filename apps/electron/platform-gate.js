import {
  assertWindowsProductionReadiness,
} from "../../src/platform/index.js";

import { shellError } from "./errors.js";
import {
  validateProductionDistributionMetadata,
} from "./desktop-updater.js";
import {
  assertWindowsElectronQualificationContext,
} from "./windows-qualification.js";

/**
 * Electron does not authorize Windows production storage. An exact stable
 * Windows/x64 package may select the fixed candidate composition while native
 * filesystem claims remain false; installed lifecycle and release evidence
 * stay separate. All other Windows launches require the branded qualification
 * context or an independently established readiness attestation.
 */
export function assertElectronPlatformGate({
  platform = process.platform,
  architecture = process.arch,
  readiness = null,
  qualificationContext = null,
  productionDistribution = null,
  environment = {},
} = {}) {
  if (platform === "linux"
      && productionDistribution !== null && productionDistribution !== undefined) {
    try {
      if (architecture !== "x64" || qualificationContext !== null
          || environment?.USAGE_MONITOR_TEST_LANE !== undefined) {
        throw new Error("Mixed Linux candidate selection");
      }
      validateProductionDistributionMetadata(productionDistribution, {
        platform,
        architecture,
      });
    } catch {
      throw shellError("linux_readiness_unavailable");
    }
  }
  if (platform !== "win32") {
    return Object.freeze({
      platform,
      architecture,
      windowsProductionReady: false,
    });
  }
  if (productionDistribution !== null && productionDistribution !== undefined) {
    try {
      if (architecture !== "x64" || qualificationContext !== null
          || environment?.USAGE_MONITOR_TEST_LANE !== undefined) {
        throw new Error("Mixed Windows candidate selection");
      }
      validateProductionDistributionMetadata(productionDistribution, {
        platform,
        architecture,
      });
    } catch {
      throw shellError("windows_readiness_unavailable");
    }
    return Object.freeze({
      platform,
      architecture,
      // Candidate selection does not upgrade the native sidecar's own
      // productionSafe/pathWalkRaceSafe facts or make a release claim.
      windowsProductionReady: false,
      windowsQualificationOnly: false,
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
