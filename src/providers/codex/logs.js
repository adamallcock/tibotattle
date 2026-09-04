import { createCodexLogIngestion } from "./log-ingestion.js";
import { createCodexLogParser } from "./log-parser.js";
import { createCodexLogSources } from "./log-sources.js";

export const CODEX_LOG_SCAN_VERSION = "codex-log-scan-v8";

const FILESYSTEM_METHODS = Object.freeze([
  "defaultCodexHome",
  "joinPath",
  "currentUid",
  "readSelectedRolloutNames",
  "openDirectory",
  "statPath",
  "lstatPath",
  "openReadOnlyNoFollow",
  "createSha256",
  "readUtf8Range",
  "readUtf8LinesRange",
]);

const PORT_CONFIGURATION_ERROR = "createCodexLogScanner ports are invalid";

function portConfigurationError() {
  throw new TypeError(PORT_CONFIGURATION_ERROR);
}

function readPortOwner(options, name) {
  let owner;
  try {
    owner = options[name];
  } catch {
    portConfigurationError();
  }
  return owner;
}

function requireMethod(owner, ownerName, method) {
  let value;
  try {
    value = owner?.[method];
  } catch {
    portConfigurationError();
  }
  if (typeof value !== "function") {
    throw new TypeError(`${ownerName}.${method} must be a function`);
  }
  return value;
}

function normalizePorts(options) {
  const filesystem = readPortOwner(options, "filesystem");
  const lineReader = readPortOwner(options, "lineReader");
  const normalizedFilesystem = {};
  const compressedReader = {};
  if (Object.hasOwn(lineReader ?? {}, "supportsCompressedRollouts")) {
    for (const method of ["compressedRolloutHandle", "inspectCompressedRollout",
      "readCompressedRolloutBytes", "supportsCompressedRollouts"]) {
      compressedReader[method] = requireMethod(lineReader, "lineReader", method);
    }
  }
  for (const method of FILESYSTEM_METHODS) {
    normalizedFilesystem[method] = requireMethod(
      filesystem,
      "filesystem",
      method,
    );
  }
  return Object.freeze({
    filesystem: Object.freeze(normalizedFilesystem),
    lineReader: Object.freeze({
      ...compressedReader,
      readBoundedUtf8Lines: requireMethod(
        lineReader,
        "lineReader",
        "readBoundedUtf8Lines",
      ),
    }),
  });
}

/**
 * Create the provider-owned scanner with explicit platform ports. This facade
 * is runtime-neutral; Node bindings live in the calling composition root.
 */
export function createCodexLogScanner(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("createCodexLogScanner options are required");
  }
  const { filesystem, lineReader } = normalizePorts(options);

  const sources = createCodexLogSources({ filesystem, lineReader });
  const parser = createCodexLogParser({ lineReader });
  const scanCodexLogEvents = createCodexLogIngestion({
    parserVersion: CODEX_LOG_SCAN_VERSION,
    sources,
    parser,
  });

  return Object.freeze({
    readRolloutLineage: sources.readRolloutLineage,
    hasForkReplayPrefix: sources.hasForkReplayPrefix,
    discoverCodexRolloutInfos: sources.discoverCodexRolloutInfos,
    codexRolloutDiscoveryReceipt: sources.codexRolloutDiscoveryReceipt,
    discoverCodexRollouts: sources.discoverCodexRollouts,
    summarizeCodexRolloutSources: sources.summarizeCodexRolloutSources,
    codexLogSourceFingerprint: sources.codexLogSourceFingerprint,
    appendedRolloutSourcesAreAfterEnd: sources.appendedRolloutSourcesAreAfterEnd,
    scanCodexLogEvents,
  });
}

export {
  canonicalComponentAvailability,
  canonicalComponents,
  canonicalRateLimitSnapshot,
  canonicalRateLimitWindows,
  classifyToolCall,
  codexSessionMetaIdentity,
  createLeadingRateLimitGate,
  createSnapshotLineage,
  cumulativeSnapshotKey,
  deltaComponentPresence,
  extractToolObservations,
  normalizeTokenUsage,
  sameUsage,
  subtractUsage,
  tokenComponentPresence,
} from "./log-normalization.js";

export {
  CodexLogSourceChangedError,
  codexRolloutDiscoveryReceipt,
  parseCodexRolloutFilename,
} from "./log-sources.js";
export { classifySessionSurface } from "./surface-classification.js";
export {
  isCodexSpeedMode,
  normalizeProviderTier,
  unknownCodexTier,
  validateTierDeclaration,
} from "./tier-normalization.js";
