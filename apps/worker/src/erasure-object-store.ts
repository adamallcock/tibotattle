import {
  assertQuarantineObjectDeleteBatch,
  type QuarantineObjectStore,
} from "./quarantine-object-store";

export type ParticipantErasureObjectSource =
  | "synthetic"
  | "telemetry"
  | "telemetry_v1"
  | "telemetry_v11";

/**
 * A database row plus the provider version observed for its object. D1/R2
 * rows currently have no version column and use null; providers with object
 * generations must carry the opaque generation through this boundary.
 */
export interface ParticipantErasureObjectRef {
  readonly source: ParticipantErasureObjectSource;
  readonly id: string;
  readonly key: string;
  readonly createdAt: string;
  readonly version: string | null;
}

export interface ParticipantErasureObjectPage {
  readonly objects: readonly ParticipantErasureObjectRef[];
  readonly nextCursor: { readonly createdAt: string; readonly id: string } | null;
}

/** The existing D1 lifecycle uses one hundred rows per provider operation. */
export const PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT = 100;

/** Provider diagnostics and object keys never cross the lifecycle boundary. */
export class ParticipantErasureObjectStorageUnavailableError extends Error {
  constructor() {
    super("PARTICIPANT_ERASURE_OBJECT_STORAGE_UNAVAILABLE");
    this.name = "ParticipantErasureObjectStorageUnavailableError";
  }
}

export interface ParticipantErasureObjectStore {
  /**
   * Success means the provider's retained-data guarantee is satisfied for
   * every ref in the batch. A rejection leaves the source rows and tombstone
   * available for a later retry; adapters must not silently delete by key when
   * a generation-aware operation cannot be proved safe.
   */
  deleteBatch(objects: readonly ParticipantErasureObjectRef[]): Promise<void>;
}

/**
 * Reuses the reviewed R2/Miniflare quarantine contract for the current D1
 * deployment. R2 has no generation token in the existing journal, so a
 * versioned ref is rejected rather than silently downgraded to key deletion.
 */
export function createQuarantineParticipantErasureObjectStore(
  quarantine: QuarantineObjectStore,
): ParticipantErasureObjectStore {
  return {
    async deleteBatch(objects): Promise<void> {
      if (!Array.isArray(objects)
          || objects.length > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
        throw new TypeError("invalid participant erasure object batch");
      }
      for (const object of objects) {
        if (object === null || typeof object !== "object"
            || typeof object.key !== "string" || object.key.length === 0
            || object.version !== null) {
          throw new ParticipantErasureObjectStorageUnavailableError();
        }
      }
      const keys = objects.map((object) => object.key);
      assertQuarantineObjectDeleteBatch(keys);
      await quarantine.deleteMany(keys);
    },
  };
}
