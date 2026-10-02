/**
 * RD-2 /api/ready for the Cloud Run origin: the pure half (CR-6/CR-7 phase A).
 *
 * lifecycleReadiness is a verbatim port of the d43c8f92 Worker function of
 * the same name (src/index.ts, before handleReady), over the PostgreSQL
 * reader shapes of src/postgres-lifecycle-state.ts instead of D1 rows.
 * buildPostgresReadinessBody mirrors handleReady's body for typed storage
 * mode, where the aggregate rebuild is delegated.
 *
 * Nothing here reads storage. The readers (one REPEATABLE READ READ ONLY
 * transaction over the primary receipt, retention_state,
 * quarantine_reconciliation_state and the typed pins) and the
 * postgres-readiness-dispatch.mjs dispatcher are phase B: they need
 * LEAD-SIMP's single primary-only receipt reader (critic conflict 3). A
 * missing retention or reconciliation row, an unpinned namespace or a
 * receipt that is not current is the reader's 503
 * BACKEND_STORAGE_UNAVAILABLE, before this builder runs, exactly as the
 * Worker throws before building its body.
 */
import { BACKEND_LIFECYCLE_STALE_MILLISECONDS } from "./constants";
import {
  maintenanceCyclesMatch,
  type PostgresQuarantineReconciliationState,
  type PostgresRetentionState,
} from "./postgres-lifecycle-state";
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
