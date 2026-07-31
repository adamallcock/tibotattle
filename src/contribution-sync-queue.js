import { resolve } from "node:path";

import {
  createLocalContributionSyncQueueContext,
} from "./application/index.js";
import { syncPreparedContributionEntryOnce } from
  "./contribution-device-sync.js";
import {
  createLocalContributionSyncQueueStorageContext,
} from "./platform/index.js";
import {
  loadVerifiedPreparedContribution,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";

const contributionSyncQueue = createLocalContributionSyncQueueContext({
  createStorage: createLocalContributionSyncQueueStorageContext,
  resolvePath: resolve,
  verifyPreparedSet: verifyPreparedContributionSet,
  loadPreparedContribution: loadVerifiedPreparedContribution,
  syncPreparedEntry: syncPreparedContributionEntryOnce,
});

// Exact legacy composition surface. Queue policy is application-owned; this
// file supplies Node path, prepared-set, transport, and platform storage ports.
export const ACCEPTED_ARTIFACT_MAXIMUM_AGE_DAYS =
  contributionSyncQueue.ACCEPTED_ARTIFACT_MAXIMUM_AGE_DAYS;
export const ACCEPTED_ARTIFACT_MAXIMUM_RETAINED_SETS =
  contributionSyncQueue.ACCEPTED_ARTIFACT_MAXIMUM_RETAINED_SETS;
export const ACCEPTED_ARTIFACT_MAXIMUM_RETIREMENTS_PER_PASS =
  contributionSyncQueue.ACCEPTED_ARTIFACT_MAXIMUM_RETIREMENTS_PER_PASS;
export const CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA =
  contributionSyncQueue.CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA;
export const CONTRIBUTION_SYNC_PREVIEW_SCHEMA =
  contributionSyncQueue.CONTRIBUTION_SYNC_PREVIEW_SCHEMA;
export const CONTRIBUTION_SYNC_QUEUE_LIMITS =
  contributionSyncQueue.CONTRIBUTION_SYNC_QUEUE_LIMITS;
export const CONTRIBUTION_SYNC_QUEUE_SCHEMA =
  contributionSyncQueue.CONTRIBUTION_SYNC_QUEUE_SCHEMA;
export const CONTRIBUTION_SYNC_STATUS_SCHEMA =
  contributionSyncQueue.CONTRIBUTION_SYNC_STATUS_SCHEMA;
export const ContributionSyncQueueError =
  contributionSyncQueue.ContributionSyncQueueError;
export const conservativeUploadReservationBytes =
  contributionSyncQueue.conservativeUploadReservationBytes;
export const defaultContributionSyncQueueFile =
  contributionSyncQueue.defaultContributionSyncQueueFile;
export const discoverCommittedPreparedSets =
  contributionSyncQueue.discoverCommittedPreparedSets;
export const inspectContributionSyncQueue =
  contributionSyncQueue.inspectContributionSyncQueue;
export const inspectExactNextContributionSyncUpload =
  contributionSyncQueue.inspectExactNextContributionSyncUpload;
export const inspectNextContributionSyncUpload =
  contributionSyncQueue.inspectNextContributionSyncUpload;
export const retireAcceptedContributionArtifacts =
  contributionSyncQueue.retireAcceptedContributionArtifacts;
export const runContributionSyncQueueOnce =
  contributionSyncQueue.runContributionSyncQueueOnce;
export const runContributionSyncQueueWatch =
  contributionSyncQueue.runContributionSyncQueueWatch;
export const setContributionSyncPaused =
  contributionSyncQueue.setContributionSyncPaused;
