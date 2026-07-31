import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createLocalContributionPreparationContext,
} from "./application/local-contribution-preparation.js";
import {
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import { readBoundedJsonLines } from "./bounded-jsonl.js";
import {
  defaultExportStateDirectory,
  withParticipantSecretLease,
} from "./export-identity.js";
import {
  selectProductionParticipantIdentity,
} from "./export-identity-production.js";
import { createExportResourceGuard } from "./export-resource-policy.js";
import {
  buildLocalMetadataBundle,
  writeLocalMetadataBundle,
} from "./metadata-exporter.js";
import {
  preparedContributionContext,
  preparedContributionStorage,
} from "./prepared-contribution-compatibility-internal.js";
import {
  materializeTelemetryContributions,
} from "./telemetry-contribution-builder.js";

export {
  LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS,
  LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS,
  LocalContributionPreparationError,
  projectLocalContributionPreparationError,
} from "./application/local-contribution-preparation.js";

const preparationContext = createLocalContributionPreparationContext({
  defaultStateDirectory: defaultExportStateDirectory,
  defaultCodexHome: () => join(homedir(), ".codex"),
  defaultActivityFile: () => resolve(
    process.cwd(),
    ".usage-monitor",
    "activity-markers-v0.1.jsonl",
  ),
  joinPath: join,
  storage: preparedContributionStorage,
  uuid: randomUUID,
  createResourceGuard: createExportResourceGuard,
  readActivityMarkers: readBoundedJsonLines,
  selectIdentity: selectProductionParticipantIdentity,
  withIdentityLease: withParticipantSecretLease,
  buildBundle: buildLocalMetadataBundle,
  writeBundle: writeLocalMetadataBundle,
  verifySource: loadVerifiedLocalMetadataBundleFiles,
  materialize: materializeTelemetryContributions,
  verifyPreparedSet:
    preparedContributionContext.verifyPreparedContributionSet,
});

export const {
  createLocalContributionPreparationRunner,
  defaultLocalContributionPreparationDirectories,
  prepareLatestHourLocalContribution,
  prepareRecentLocalContribution,
} = preparationContext;
