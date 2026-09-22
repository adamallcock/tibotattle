import type { TelemetryV1Backend } from "./telemetry-v1-backend";
import type { PostgresSchemaOptions } from "./postgres-client";
import {
  createExperimentalPostgresTelemetryV1ContributionStore,
  type PostgresTelemetryV1Pool,
} from "./postgres-telemetry-v1-contribution-store";
import { createExperimentalPostgresTelemetryV1ContributionReader } from "./postgres-telemetry-v1-contribution-reader";
import { createExperimentalPostgresTelemetryV1SyncStore } from "./postgres-telemetry-v1-sync-store";

/**
 * Canonical v1 composition. The caller supplies its pool and credentials;
 * runtime selection and migration application remain composition-root work.
 */
export function createExperimentalPostgresTelemetryV1Backend(
  pool: PostgresTelemetryV1Pool,
  schemaOptions: PostgresSchemaOptions = {},
): TelemetryV1Backend {
  return {
    contributions: createExperimentalPostgresTelemetryV1ContributionStore(pool, schemaOptions),
    reader: createExperimentalPostgresTelemetryV1ContributionReader(pool, schemaOptions),
    sync: createExperimentalPostgresTelemetryV1SyncStore(pool, schemaOptions),
  };
}
