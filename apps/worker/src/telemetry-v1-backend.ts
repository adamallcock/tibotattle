import type { TelemetryV1ContributionStore } from "./telemetry-v1-contribution-store";
import type { TelemetryV1ContributionReader } from "./telemetry-v1-contribution-reader";
import type { TelemetryV1SyncStore } from "./telemetry-v1-sync-store";

/** Select matching v1 adapters at the composition root, once per request. */
export interface TelemetryV1Backend {
  readonly contributions: TelemetryV1ContributionStore;
  readonly reader: TelemetryV1ContributionReader;
  readonly sync: TelemetryV1SyncStore;
}
