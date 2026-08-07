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

export const createIncrementalContributionSyncController =
  incrementalContribution.createIncrementalContributionSyncController;
