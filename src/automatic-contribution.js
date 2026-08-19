import { randomUUID } from "node:crypto";
import { resolve, win32 } from "node:path";

import {
  createLocalAutomaticContributionContext,
} from "./application/index.js";
import {
  AutomaticContributionError,
} from "./contribution/index.js";
import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./platform/index.js";

export {
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION,
  AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
  AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
  AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
  AutomaticContributionError,
  automaticContributionRequiredConsent,
} from "./contribution/index.js";

const MAXIMUM_INSTANCE_LOCK_BYTES = 4 * 1_024;
const storage = createOwnerOnlyAutomaticContributionStorageContext({
  createError: (code) => new AutomaticContributionError(code),
});
const automaticContribution = createLocalAutomaticContributionContext({
  storage,
  randomUuid: randomUUID,
  resolvePath: resolve,
});

// Exact legacy composition surface. Scheduling and transition orchestration
// are application-owned; this file supplies Node and owner-only storage ports.
export const AUTOMATIC_CONTRIBUTION_LIMITS =
  automaticContribution.AUTOMATIC_CONTRIBUTION_LIMITS;
export const AutomaticContributionController =
  automaticContribution.AutomaticContributionController;

function createAutomaticContributionStorage({
  platform = process.platform,
  windowsProtectedStateStore = null,
} = {}) {
  return createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => new AutomaticContributionError(code),
    platform,
    windowsProtectedStateStore,
  });
}

// The ordinary Mac/Linux factory remains bound to its reviewed local storage
// context. A Windows composition must opt into the branded protected store;
// constructing a fresh application context here keeps that dependency
// explicit until the companion server wires its complete state composition.
export function createAutomaticContributionController(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("automatic contribution options must be an object");
  }
  const hasWindowsComposition = Object.hasOwn(options, "platform")
    || Object.hasOwn(options, "windowsProtectedStateStore");
  if (!hasWindowsComposition) {
    return automaticContribution.createAutomaticContributionController(options);
  }
  const {
    platform = process.platform,
    windowsProtectedStateStore = null,
    ...controllerOptions
  } = options;
  const context = createLocalAutomaticContributionContext({
    storage: createAutomaticContributionStorage({
      platform,
      windowsProtectedStateStore,
    }),
    randomUuid: randomUUID,
    resolvePath: platform === "win32" ? win32.resolve : resolve,
  });
  return context.createAutomaticContributionController(controllerOptions);
}

export function acquireAutomaticContributionInstanceLock({
  lockFile,
  pid,
  now,
  processIsAlive,
} = {}) {
  return storage.acquireInstanceLock({
    lockFile,
    pid,
    now,
    processIsAlive,
    maximumBytes: MAXIMUM_INSTANCE_LOCK_BYTES,
  });
}
