import {
  IncrementalContributionSyncError,
  createLocalIncrementalContributionSyncContext,
} from "./application/local-incremental-contribution-sync.js";
import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./platform/index.js";

export {
  INCREMENTAL_CONTRIBUTION_INTERVAL_HOURS,
  INCREMENTAL_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
  INCREMENTAL_CONTRIBUTION_STATUS_SCHEMA_VERSION,
  IncrementalContributionSyncError,
  incrementalContributionRequiredConsent,
} from "./application/local-incremental-contribution-sync.js";
// The contract identifier callers surface beside sync status, re-exported
// from the contribution owner's reviewed chunk entrypoint so applications
// compose against this facade rather than reaching into the owner directly.
export {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
} from "./contribution/telemetry-v1-chunks.js";

// Exact composition surface, mirroring automatic-contribution.js: the
// scheduling and consent state machine is application-owned; this file
// supplies the owner-only settings storage port.
const storage = createOwnerOnlyAutomaticContributionStorageContext({
  createError: (code) => new IncrementalContributionSyncError(
    code === "instance_lock_unavailable" || code === "instance_active"
      ? "settings_unavailable"
      : code,
  ),
});
const incrementalContribution = createLocalIncrementalContributionSyncContext({
  storage,
});

function createIncrementalContributionStorage({
  platform = process.platform,
  windowsProtectedStateStore = null,
} = {}) {
  return createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => new IncrementalContributionSyncError(
      code === "instance_lock_unavailable" || code === "instance_active"
        ? "settings_unavailable"
        : code,
    ),
    platform,
    windowsProtectedStateStore,
  });
}

// Keep the default Mac/Linux context and expose an explicit Windows
// composition seam. The latter can only reach the controller through the
// protected-store-backed storage port, never through an arbitrary reader or
// writer object.
export function createIncrementalContributionSyncController(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("incremental contribution options must be an object");
  }
  const hasWindowsComposition = Object.hasOwn(options, "platform")
    || Object.hasOwn(options, "windowsProtectedStateStore");
  if (!hasWindowsComposition) {
    return incrementalContribution.createIncrementalContributionSyncController(options);
  }
  const {
    platform = process.platform,
    windowsProtectedStateStore = null,
    ...controllerOptions
  } = options;
  const context = createLocalIncrementalContributionSyncContext({
    storage: createIncrementalContributionStorage({
      platform,
      windowsProtectedStateStore,
    }),
  });
  return context.createIncrementalContributionSyncController(controllerOptions);
}
