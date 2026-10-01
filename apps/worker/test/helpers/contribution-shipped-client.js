// Test-only seam: the shipped desktop client's own v1.0 sync engine, its
// local unified-index writer and its v1.1 envelope builder, so an origin
// spec drives production client code rather than a hand-built request.
export { runIncrementalContributionSyncOnce } from "../../../../src/contribution-incremental-sync.js";
export {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  outcomeOrdinal,
  reasoningEffortOrdinal,
} from "../../../../src/local-unified-index.js";
export { createTelemetryV11Envelope } from "../../../../src/platform/telemetry-v11-envelope.js";
