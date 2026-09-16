import type { TelemetryV1Backend } from "./telemetry-v1-backend";
import {
  createExperimentalPostgresTelemetryV1ContributionStore,
  type PostgresTelemetryV1Pool,
} from "./postgres-telemetry-v1-contribution-store";
import { createExperimentalPostgresTelemetryV1ContributionReader } from "./postgres-telemetry-v1-contribution-reader";
import { createExperimentalPostgresTelemetryV1SyncStore } from "./postgres-telemetry-v1-sync-store";

/**
 * Qualification composition for the reviewed tibotattle_v1_test schema.
 * The caller supplies its pool and credentials. This factory does not select
 * a runtime, migrate a database, or replace the D1 authorization boundary.
 */
export function createExperimentalPostgresTelemetryV1Backend(
  pool: PostgresTelemetryV1Pool,
): TelemetryV1Backend {
  return {
    contributions: createExperimentalPostgresTelemetryV1ContributionStore(pool),
    reader: createExperimentalPostgresTelemetryV1ContributionReader(pool),
    sync: createExperimentalPostgresTelemetryV1SyncStore(pool),
  };
}
