import type { TelemetryV1Backend } from "./telemetry-v1-backend";
import { createD1TelemetryV1ContributionStore } from "./d1-telemetry-v1-contribution-store";
import { createD1TelemetryV1ContributionReader } from "./d1-telemetry-v1-contribution-reader";
import { createD1TelemetryV1SyncStore } from "./d1-telemetry-v1-sync-store";

export function createD1TelemetryV1Backend(db: D1Database): TelemetryV1Backend {
  return {
    contributions: createD1TelemetryV1ContributionStore(db),
    reader: createD1TelemetryV1ContributionReader(db),
    sync: createD1TelemetryV1SyncStore(db),
  };
}
