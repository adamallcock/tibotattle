import { createLocalCodexLogScanner } from "./application/index.js";
import { createLocalCodexLogPorts } from "./platform/index.js";

// Temporary Node composition and legacy import facade. Migrate every flat
// consumer to the reviewed provider entrypoint, then remove this file before
// the final R7 source freeze and receipt regeneration.
const localPorts = createLocalCodexLogPorts();
const scanner = createLocalCodexLogScanner(localPorts);

export const {
  appendedRolloutSourcesAreAfterEnd,
  codexLogSourceFingerprint,
  codexRolloutDiscoveryReceipt,
  discoverCodexRolloutInfos,
  discoverCodexRollouts,
  hasForkReplayPrefix,
  readRolloutLineage,
  scanCodexLogEvents,
  summarizeCodexRolloutSources,
} = scanner;

export {
  CodexLogSourceChangedError,
  canonicalComponentAvailability,
  canonicalComponents,
  canonicalRateLimitWindows,
  classifyToolCall,
  createLeadingRateLimitGate,
  createSnapshotLineage,
  cumulativeSnapshotKey,
  deltaComponentPresence,
  extractToolObservations,
  normalizeTokenUsage,
  sameUsage,
  subtractUsage,
  tokenComponentPresence,
} from "./providers/codex/logs.js";

// Pricing remains application-owned. This exact legacy re-export preserves the
// pre-owner-move scanner entrypoint for callers that have not migrated yet.
export { scanAndPriceCodexLogs } from "./codex-local-usage-analysis.js";
