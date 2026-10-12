/**
 * RD-2 /api/ready for the Cloud Run origin (CR-6/CR-7).
 *
 * lifecycleReadiness is a verbatim port of the d43c8f92 Worker function of
 * the same name (src/index.ts, before handleReady), over the PostgreSQL
 * reader shapes of src/postgres-lifecycle-state.ts instead of D1 rows.
 * buildPostgresReadinessBody mirrors handleReady's body for typed storage
 * mode, where the aggregate rebuild is delegated.
 *
 * readPostgresReadinessState is the one storage read (D-CRB): a single
 * REPEATABLE READ READ ONLY transaction over the primary migration receipt
 * (through the one shared reader, src/postgres-schema-receipt.ts),
 * retention_state and quarantine_reconciliation_state (the rows C-MAINT's
 * lifecycle pass writes) and the typed v1 and v1.1 namespace pins. A receipt
 * that is not current, a missing row or an unpinned namespace is 503
 * BACKEND_STORAGE_UNAVAILABLE, before the builder runs, exactly as the
 * Worker throws before building its body (owner decision OD-CR-4:
 * Worker-exact readiness; an empty origin reads not_ready until the first
 * pass). It reads no ledger and no erasure relation.
 */
import { BACKEND_LIFECYCLE_STALE_MILLISECONDS } from "./constants";
import { ApiError } from "./errors";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";
import {
  maintenanceCyclesMatch,
  readPostgresQuarantineReconciliationState,
  readPostgresRetentionState,
  StateShapeError,
  type PostgresQuarantineReconciliationState,
  type PostgresRetentionState,
} from "./postgres-lifecycle-state";
import { readSchemaReceipt, type PostgresSchemaReceiptMigration } from "./postgres-schema-receipt";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import {
  POSTGRES_READINESS_RUN_STATES,
  POSTGRES_READINESS_SEMANTICS,
  POSTGRES_READINESS_STALE_AFTER_MILLISECONDS,
  type PostgresReadinessBody,
  type PostgresReadinessLifecycleState,
  type PostgresReadinessSemantics,
} from "./postgres-readiness-contract";

export {
  POSTGRES_READINESS_SEMANTICS,
  validatePostgresReadinessBody,
  type PostgresReadinessBody,
  type PostgresReadinessSemantics,
} from "./postgres-readiness-contract";

// The import-free contract carries its own copy of the Worker policy so plain
// Node scripts can validate a live body. Refuse to load if the two drift.
if (POSTGRES_READINESS_STALE_AFTER_MILLISECONDS !== BACKEND_LIFECYCLE_STALE_MILLISECONDS) {
  throw new Error("POSTGRES_READINESS_POLICY_DRIFT");
}

/** The retention fields readiness reads (readPostgresRetentionState). */
export type PostgresReadinessRetention = Pick<
  PostgresRetentionState,
  | "state"
  | "lastCompletedAtMs"
  | "maintenanceRunAtIso"
  | "quarantineRetentionComplete"
  | "restoreReplayComplete"
>;

/** The reconciliation fields readiness reads (readPostgresQuarantineReconciliationState). */
export type PostgresReadinessReconciliation = Pick<
  PostgresQuarantineReconciliationState,
  "state" | "maintenanceRunAtIso" | "reconciliationComplete"
>;

export interface PostgresReadinessState {
  readonly retention: PostgresReadinessRetention;
  readonly reconciliation: PostgresReadinessReconciliation;
}

export interface PostgresReadinessOptions {
  /** OD-CR-4, required: there is no default readiness definition. */
  readonly semantics: PostgresReadinessSemantics;
}

export interface PostgresReadinessResult {
  /** 200 only when ready, else 503 (Worker parity). */
  readonly httpStatus: 200 | 503;
  readonly body: PostgresReadinessBody;
}

const RUN_STATES: ReadonlySet<string> = new Set(POSTGRES_READINESS_RUN_STATES);

function invalid(code: string): never {
  throw Object.assign(new TypeError(code), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableEpoch(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validRetention(value: unknown): value is PostgresReadinessRetention {
  return isRecord(value)
    && typeof value.state === "string" && RUN_STATES.has(value.state)
    && nullableEpoch(value.lastCompletedAtMs)
    && nullableString(value.maintenanceRunAtIso)
    && typeof value.quarantineRetentionComplete === "boolean"
    && typeof value.restoreReplayComplete === "boolean";
}

function validReconciliation(value: unknown): value is PostgresReadinessReconciliation {
  return isRecord(value)
    && typeof value.state === "string" && RUN_STATES.has(value.state)
    && nullableString(value.maintenanceRunAtIso)
    && typeof value.reconciliationComplete === "boolean";
}

/**
 * Verbatim port of the Worker's lifecycleReadiness: a run that has not
 * completed reports its own state; a completed run is fresh only when its
 * completion instant is finite, not in the future and at most
 * BACKEND_LIFECYCLE_STALE_MILLISECONDS old; a fresh run is incomplete until
 * both the quarantine retention and the restore replay completed. It never
 * returns 'completed'.
 */
export function lifecycleReadiness(
  retention: PostgresReadinessRetention,
  nowEpoch: number,
): { readonly fresh: boolean; readonly state: PostgresReadinessLifecycleState } {
  if (retention.state !== "completed") {
    return { fresh: false, state: retention.state };
  }
  const completedEpoch = retention.lastCompletedAtMs === null
    ? Number.NaN
    : retention.lastCompletedAtMs;
  const fresh = Number.isFinite(completedEpoch)
    && completedEpoch <= nowEpoch
    && nowEpoch - completedEpoch <= BACKEND_LIFECYCLE_STALE_MILLISECONDS;
  if (!fresh) return { fresh: false, state: "stale" };
  if (!retention.quarantineRetentionComplete || !retention.restoreReplayComplete) {
    return { fresh: true, state: "incomplete" };
  }
  return { fresh: true, state: "ready" };
}

/**
 * The Worker's handleReady body and status for typed storage mode, from the
 * PostgreSQL reader shapes. The maintenance cycles match only when both
 * markers are present, canonical and identical (maintenanceCyclesMatch, the
 * Worker's string identity over canonical instants).
 *
 * Throws a TypeError with a closed code, never a value: an undecided or
 * unknown semantics (OD-CR-4) is POSTGRES_READINESS_SEMANTICS_UNDECIDED, a
 * non-integer clock POSTGRES_READINESS_CLOCK_INVALID and a state outside the
 * reader contract POSTGRES_READINESS_STATE_INVALID.
 */
export function buildPostgresReadinessBody(
  state: PostgresReadinessState,
  nowEpoch: number,
  options: PostgresReadinessOptions,
): PostgresReadinessResult {
  const semantics: unknown = isRecord(options) ? options.semantics : undefined;
  if (typeof semantics !== "string"
      || !(POSTGRES_READINESS_SEMANTICS as readonly string[]).includes(semantics)) {
    invalid("POSTGRES_READINESS_SEMANTICS_UNDECIDED");
  }
  if (!Number.isSafeInteger(nowEpoch)) invalid("POSTGRES_READINESS_CLOCK_INVALID");
  if (!isRecord(state)
      || !validRetention(state.retention)
      || !validReconciliation(state.reconciliation)) {
    invalid("POSTGRES_READINESS_STATE_INVALID");
  }
  const { retention, reconciliation } = state;
  const lifecycle = lifecycleReadiness(retention, nowEpoch);
  const maintenanceCycleMatched = maintenanceCyclesMatch(
    retention.maintenanceRunAtIso,
    reconciliation.maintenanceRunAtIso,
  );
  const reconciliationComplete = reconciliation.state === "completed"
    && reconciliation.reconciliationComplete
    && maintenanceCycleMatched;
  // Typed storage: the rebuild is delegated, so it never gates readiness and
  // is reported as unconfirmed (false), never as a completed claim.
  const ready = lifecycle.state === "ready" && reconciliationComplete;
  const body: PostgresReadinessBody = {
    status: ready ? "ready" : "not_ready",
    checks: {
      lifecycle: lifecycle.state,
      lifecycleFresh: lifecycle.fresh,
      quarantineRetentionComplete: retention.quarantineRetentionComplete,
      restoreReplayComplete: retention.restoreReplayComplete,
      aggregateRebuildComplete: false,
      aggregateRebuildDelegated: true,
      maintenanceCycleMatched,
      quarantineReconciliation: reconciliation.state,
      quarantineReconciliationComplete: reconciliationComplete,
    },
    policy: {
      lifecycleStaleAfterMilliseconds: BACKEND_LIFECYCLE_STALE_MILLISECONDS,
    },
  };
  return { httpStatus: ready ? 200 : 503, body };
}

/** The transaction bounds of the readiness read (the readiness pool, one connection). */
export const POSTGRES_READINESS_READ_TIMEOUTS = Object.freeze({
  statementTimeoutMilliseconds: 3_000,
  lockTimeoutMilliseconds: 1_000,
});

export interface PostgresReadinessReadOptions {
  readonly primarySchema: string;
  /** TELEMETRY_STORAGE_NAMESPACE: the typed v1 and v1.1 pins must name it. */
  readonly sourceNamespace: string;
  /** The image's manifest (POSTGRES_RUNTIME_MIGRATIONS.primary). */
  readonly expectedPrimaryMigrations: readonly PostgresSchemaReceiptMigration[];
}

function storageUnavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function sameBytes(value: unknown, expected: Uint8Array): boolean {
  return value instanceof Uint8Array && value.byteLength === expected.byteLength
    && value.every((byte, index) => byte === expected[index]);
}

/**
 * The d43c8f92 typed pin (telemetry-storage-mode.ts resolveTelemetryStorageMode
 * for 'v1' and 'v11'): the singleton admission state names the configured
 * namespace, carries runtime contract version 1 and joins a namespace row
 * whose original id is exactly encodeTypedTelemetryId(namespace).
 * PostgreSQL has no typed_telemetry_schema table, so that third join of the
 * D1 query is omitted.
 */
async function assertTypedPin(
  client: PostgresClient,
  quotedSchema: string,
  stateTable: "typed_v1_admission_state" | "typed_v11_admission_state",
  sourceNamespace: string,
): Promise<void> {
  const originalId = encodeTypedTelemetryId(sourceNamespace);
  const result = await client.query<{ source_namespace: unknown; runtime_contract_version: unknown; original_id: unknown }>(
    `SELECT state.source_namespace, state.runtime_contract_version, namespace.original_id
       FROM ${quotedSchema}."${stateTable}" state
       JOIN ${quotedSchema}."typed_telemetry_namespaces" namespace ON namespace.id = state.namespace_id
      WHERE state.id = 1`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || row.source_namespace !== sourceNamespace
      || Number(row.runtime_contract_version) !== 1 || !sameBytes(row.original_id, originalId)) {
    throw storageUnavailable();
  }
}

/**
 * Read the state readiness reports, in one REPEATABLE READ READ ONLY snapshot
 * with POSTGRES_READINESS_READ_TIMEOUTS. Throws 503 BACKEND_STORAGE_UNAVAILABLE
 * for a receipt that is not current, a missing or malformed row, or an
 * unpinned namespace (an invalid namespace setting included); a driver
 * failure propagates as the sanitized PostgresStorageError, which the root
 * answers 500 INTERNAL_ERROR, as the Worker answers a D1 failure.
 */
export async function readPostgresReadinessState(
  pool: PostgresPool,
  options: PostgresReadinessReadOptions,
): Promise<PostgresReadinessState> {
  const { primarySchema, sourceNamespace, expectedPrimaryMigrations } = options;
  let quotedSchema: string;
  try {
    quotedSchema = quotePostgresIdentifier(primarySchema);
    encodeTypedTelemetryId(sourceNamespace);
  } catch {
    throw storageUnavailable();
  }
  return withPostgresRead(pool, async (client) => {
    const receipt = await readSchemaReceipt(client, { schema: primarySchema, expected: expectedPrimaryMigrations });
    if (receipt !== "current") throw storageUnavailable();
    const schema = { primarySchema };
    const retention = await readPostgresRetentionState(client, schema);
    if (retention === null) throw storageUnavailable();
    const reconciliation = await readPostgresQuarantineReconciliationState(client, schema);
    if (reconciliation === null) throw storageUnavailable();
    await assertTypedPin(client, quotedSchema, "typed_v1_admission_state", sourceNamespace);
    await assertTypedPin(client, quotedSchema, "typed_v11_admission_state", sourceNamespace);
    return Object.freeze({ retention, reconciliation });
  }, {
    ...POSTGRES_READINESS_READ_TIMEOUTS,
    operation: "readiness.read",
    preserveSafeError: (error) => error instanceof ApiError ? error
      : error instanceof StateShapeError ? storageUnavailable() : null,
  });
}
