import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createLocalContributionPreparationContext as createApplicationPreparationContext,
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
  LOCAL_CONTRIBUTION_PREPARATION_DETAIL_CODES,
  LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS,
  LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS,
  LocalContributionPreparationError,
  projectLocalContributionPreparationError,
} from "./application/local-contribution-preparation.js";

const defaultPreparationContextOptions = Object.freeze({
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

const preparationContext = createApplicationPreparationContext(
  defaultPreparationContextOptions,
);

function hasOwn(value, name) {
  return Object.prototype.hasOwnProperty.call(value, name);
}

function configuredPreparationContext(options = {}) {
  const selectedStorage = hasOwn(options, "preparationStorage")
    ? options.preparationStorage
    : options.storage;
  const selectedValidator = hasOwn(options, "preparationStorageValidator")
    ? options.preparationStorageValidator
    : options.storageValidator;
  if (selectedStorage === undefined) return preparationContext;
  if (typeof selectedValidator !== "function") {
    throw new TypeError(
      "preparationStorageValidator is required for injected preparation storage",
    );
  }
  const contextOptions = {
    ...defaultPreparationContextOptions,
    storage: selectedStorage,
    storageValidator: selectedValidator,
  };
  for (const name of [
    "defaultStateDirectory",
    "defaultCodexHome",
    "defaultActivityFile",
    "joinPath",
  ]) {
    if (hasOwn(options, name)) contextOptions[name] = options[name];
  }
  return createApplicationPreparationContext(contextOptions);
}

/**
 * Build a preparation runner over a caller-selected, reviewed storage port.
 * The ordinary invocation remains bound to the POSIX owner-only context;
 * Windows composition supplies `preparationStorage` (or the compatibility
 * name `storage`) together with its brand validator.  Storage selection is
 * consumed here, before runner options are forwarded to an attempt, so a
 * per-attempt function cannot replace the captured directory operations.
 */
export function createLocalContributionPreparationRunner(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("local contribution preparation options are invalid");
  }
  const context = configuredPreparationContext(options);
  const {
    preparationStorage: _preparationStorage,
    storage: _storage,
    preparationStorageValidator: _preparationStorageValidator,
    storageValidator: _storageValidator,
    defaultStateDirectory: _defaultStateDirectory,
    defaultCodexHome: _defaultCodexHome,
    defaultActivityFile: _defaultActivityFile,
    joinPath: _joinPath,
    ...runnerOptions
  } = options;
  return context.createLocalContributionPreparationRunner(runnerOptions);
}

export const {
  defaultLocalContributionPreparationDirectories,
  prepareLatestHourLocalContribution,
  prepareRecentLocalContribution,
} = preparationContext;
