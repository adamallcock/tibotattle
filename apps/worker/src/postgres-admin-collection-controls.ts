/**
 * POST /api/v1/admin/action set_collection_controls over PostgreSQL (GCP,
 * C-ADMIN): the Worker's setCollectionControls (admin-operations.ts at
 * d43c8f92) as one PostgreSQL transaction.
 *
 * The Worker runs one D1 batch: a 'started' audit row, the compare-and-set
 * of the controls singleton on expectedRevision, then the audit row moved to
 * 'success' when the new row is in place, or to 'failure' with code
 * ADMIN_ACTION_CONFLICT when the revision did not match (answered 409
 * ADMIN_ACTION_CONFLICT). Here the same three steps share one transaction
 * through the AA-0 audit helpers, with the Worker's actor digest, operation
 * id, timestamps and the three detail objects byte for byte. A conflict
 * commits its failure audit and then answers 409.
 *
 * One PostgreSQL-only case: a reviewed controls guard trigger (SQLSTATE
 * P1005, for example 0042's import lock) refuses the UPDATE. The Worker has
 * no such guard. The transaction rolls back, a second transaction records the
 * started and failed audit pair with code LIFECYCLE_STATE_CONFLICT, and the
 * answer is 409 LIFECYCLE_STATE_CONFLICT (the AA-1 reviewed mapping). Any
 * other storage failure is 503 BACKEND_STORAGE_UNAVAILABLE with nothing
 * committed.
 */
import {
  COLLECTION_CONTROLS_SCHEMA_VERSION,
  type CollectionControls,
} from "./collection-controls";
import type { CollectionControlReason } from "./admin-operations";
import { ApiError } from "./errors";
import {
  beginPostgresAdminOperation,
  beginPostgresAdminOperationInTransaction,
  boundedAuditDetails,
  finishPostgresAdminOperationBestEffort,
  finishPostgresAdminOperationInTransaction,
} from "./postgres-admin-audit";
import {
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
} from "./postgres-client";

/** The Worker's ADMIN_CONTROL_REASONS (index.ts), in its order. */
export const POSTGRES_ADMIN_CONTROL_REASONS = Object.freeze([
  "drill_containment",
  "drill_restore",
  "privacy_incident",
  "security_incident",
  "abuse_or_cost",
  "maintenance",
] as const satisfies readonly CollectionControlReason[]);

export interface PostgresCollectionControlFlags {
  readonly enrollment: boolean;
  readonly uploadRegistration: boolean;
  readonly processing: boolean;
  readonly publication: boolean;
}

export interface PostgresSetCollectionControlsInput {
  readonly identityKey: string;
  readonly flags: PostgresCollectionControlFlags;
  readonly reasonCode: CollectionControlReason;
  readonly expectedRevision: number;
  readonly nowEpoch: number;
}

const TIMEOUT_MILLISECONDS = 5_000;
const CONTROL_GUARD_SQLSTATE = "P1005";

function storageUnavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/** d43c8f92 admin-operations.ts collectionControlState. */
function collectionControlState(flags: PostgresCollectionControlFlags): CollectionControls["state"] {
  const enabledCount = Object.values(flags).filter(Boolean).length;
  return enabledCount === 4 ? "operational" : enabledCount === 0 ? "contained" : "degraded";
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

class ControlGuardRefusal extends Error {
  constructor() {
    super("CONTROL_GUARD_REFUSAL");
  }
}

/**
 * Compare-and-set the controls singleton with its audit trail. Returns the
 * Worker's CollectionControls DTO for the new revision.
 */
export async function setPostgresCollectionControls(
  pool: PostgresPool,
  schema: string,
  input: PostgresSetCollectionControlsInput,
): Promise<CollectionControls> {
  const { identityKey, flags, reasonCode, expectedRevision, nowEpoch } = input;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (!POSTGRES_ADMIN_CONTROL_REASONS.includes(reasonCode)
      || typeof flags?.enrollment !== "boolean" || typeof flags.uploadRegistration !== "boolean"
      || typeof flags.processing !== "boolean" || typeof flags.publication !== "boolean") {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) storageUnavailable();
  let table: string;
  try {
    table = `${quotePostgresIdentifier(schema)}."collection_controls"`;
  } catch {
    return storageUnavailable();
  }
  // The Worker's flag object is rebuilt in its own key order.
  const orderedFlags = {
    enrollment: flags.enrollment,
    uploadRegistration: flags.uploadRegistration,
    processing: flags.processing,
    publication: flags.publication,
  };
  const state = collectionControlState(orderedFlags);
  const nextRevision = expectedRevision + 1;
  const updatedAt = new Date(nowEpoch).toISOString();
  const operationId = crypto.randomUUID();
  // Validated before any database work, exactly as the Worker's safeJson does.
  const requestedDetails = { expectedRevision, flags: orderedFlags, reasonCode };
  const successDetails = {
    expectedRevision, revision: nextRevision, state, flags: orderedFlags, reasonCode,
  };
  const failureDetails = (code: string) => ({ expectedRevision, flags: orderedFlags, reasonCode, code });
  for (const details of [requestedDetails, successDetails, failureDetails("ADMIN_ACTION_CONFLICT"),
    failureDetails("LIFECYCLE_STATE_CONFLICT")]) {
    boundedAuditDetails(details);
  }

  let outcome: "updated" | "conflict";
  try {
    outcome = await withPostgresMutation(pool, async (client) => {
      await beginPostgresAdminOperationInTransaction(client, schema, {
        operationId,
        action: "set_collection_controls",
        identityKey,
        details: requestedDetails,
        nowIso: updatedAt,
      });
      let changed: readonly { revision: unknown }[];
      try {
        changed = (await client.query<{ revision: unknown }>(
          `UPDATE ${table}
              SET enrollment_enabled = $1,
                  upload_registration_enabled = $2,
                  processing_enabled = $3,
                  publication_enabled = $4,
                  control_state = $5,
                  revision = revision + 1,
                  reason_code = $6,
                  updated_at = $7::timestamptz
            WHERE singleton = 1 AND revision = $8
          RETURNING revision::text AS revision`,
          [orderedFlags.enrollment, orderedFlags.uploadRegistration, orderedFlags.processing,
            orderedFlags.publication, state, reasonCode, updatedAt, expectedRevision],
        )).rows;
      } catch (error) {
        if (sqlState(error) === CONTROL_GUARD_SQLSTATE) throw new ControlGuardRefusal();
        throw error;
      }
      if (changed.length === 1 && changed[0]?.revision === String(nextRevision)) {
        await finishPostgresAdminOperationInTransaction(client, schema, {
          operationId, outcome: "success", details: successDetails,
        });
        return "updated" as const;
      }
      if (changed.length !== 0) storageUnavailable();
      await finishPostgresAdminOperationInTransaction(client, schema, {
        operationId, outcome: "failure", details: failureDetails("ADMIN_ACTION_CONFLICT"),
      });
      return "conflict" as const;
    }, {
      operation: "admin_action.set_collection_controls",
      statementTimeoutMilliseconds: TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: TIMEOUT_MILLISECONDS,
      preserveSafeError: (error) => (
        error instanceof ApiError || error instanceof ControlGuardRefusal ? error : null),
    });
  } catch (error) {
    if (error instanceof ControlGuardRefusal) {
      // The refused transaction rolled back with its audit row; record the
      // refusal on its own, then answer the conflict.
      try {
        const refusalId = await beginPostgresAdminOperation(pool, schema, {
          action: "set_collection_controls",
          identityKey,
          details: requestedDetails,
          nowIso: updatedAt,
        });
        await finishPostgresAdminOperationBestEffort(pool, schema, {
          operationId: refusalId, outcome: "failure", details: failureDetails("LIFECYCLE_STATE_CONFLICT"),
        });
      } catch {
        // The refusal is the answer even when its audit cannot be written.
      }
      throw new ApiError(409, "LIFECYCLE_STATE_CONFLICT");
    }
    if (error instanceof ApiError) throw error;
    return storageUnavailable();
  }
  if (outcome === "conflict") throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  return Object.freeze({
    schemaVersion: COLLECTION_CONTROLS_SCHEMA_VERSION,
    state,
    revision: nextRevision,
    ...orderedFlags,
  } satisfies CollectionControls);
}
