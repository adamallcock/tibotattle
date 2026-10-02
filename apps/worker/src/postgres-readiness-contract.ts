/**
 * RD-2: the closed GET /api/ready DTO the Cloud Run origin answers (CR-6/CR-7
 * phase A, pure half).
 *
 * The behavioural reference is the d43c8f92 Worker handleReady in typed
 * storage mode (src/index.ts, unchanged at the wave-2 base apart from line
 * offsets). The GCP origin is always typed, so the aggregate rebuild is always
 * delegated: aggregateRebuildComplete is false and aggregateRebuildDelegated is
 * true, exactly as the Worker reports for TELEMETRY_STORAGE_MODE=typed.
 *
 * This module is deliberately import-free so plain Node scripts (the
 * owner-run verifier smoke, scripts/gcp-origin-verifier-smoke.mjs) can load it
 * without a bundler, as they load src/edge-origin-contract.ts. The builder in
 * src/postgres-readiness.ts pins POSTGRES_READINESS_STALE_AFTER_MILLISECONDS to
 * the Worker's BACKEND_LIFECYCLE_STALE_MILLISECONDS when it loads.
 */

/** The Worker's BACKEND_LIFECYCLE_STALE_MILLISECONDS (src/constants.ts). */
export const POSTGRES_READINESS_STALE_AFTER_MILLISECONDS = 7_200_000;

/** checks.lifecycle: the Worker's LifecycleReadinessState (never 'completed'). */
export const POSTGRES_READINESS_LIFECYCLE_STATES = Object.freeze([
  "ready",
  "never_run",
  "running",
  "failed",
  "stale",
  "incomplete",
] as const);

/** checks.quarantineReconciliation: the stored run state, verbatim. */
export const POSTGRES_READINESS_RUN_STATES = Object.freeze([
  "never_run",
  "running",
  "completed",
  "failed",
] as const);

export const POSTGRES_READINESS_BODY_KEYS = Object.freeze([
  "status",
  "checks",
  "policy",
] as const);

/** Worker key order for typed (delegated) storage mode. */
export const POSTGRES_READINESS_CHECK_KEYS = Object.freeze([
  "lifecycle",
  "lifecycleFresh",
  "quarantineRetentionComplete",
  "restoreReplayComplete",
  "aggregateRebuildComplete",
  "aggregateRebuildDelegated",
  "maintenanceCycleMatched",
  "quarantineReconciliation",
  "quarantineReconciliationComplete",
] as const);

export const POSTGRES_READINESS_POLICY_KEYS = Object.freeze([
  "lifecycleStaleAfterMilliseconds",
] as const);

/**
 * OD-CR-4 (open owner decision): what /api/ready means on GCP. Only the
 * Worker-exact definition is implemented; it serves options (a) and (b),
 * which differ in the rollout gates and the maintenance writer, not in this
 * DTO. Option (c), a GCP-specific definition, would add a value here. The
 * builder takes this as a required parameter with no default.
 */
export const POSTGRES_READINESS_SEMANTICS = Object.freeze(["worker-exact"] as const);

export type PostgresReadinessSemantics = (typeof POSTGRES_READINESS_SEMANTICS)[number];
export type PostgresReadinessLifecycleState = (typeof POSTGRES_READINESS_LIFECYCLE_STATES)[number];
export type PostgresReadinessRunState = (typeof POSTGRES_READINESS_RUN_STATES)[number];

export interface PostgresReadinessBody {
  readonly status: "ready" | "not_ready";
  readonly checks: Readonly<{
    lifecycle: PostgresReadinessLifecycleState;
    lifecycleFresh: boolean;
    quarantineRetentionComplete: boolean;
    restoreReplayComplete: boolean;
    aggregateRebuildComplete: false;
    aggregateRebuildDelegated: true;
    maintenanceCycleMatched: boolean;
    quarantineReconciliation: PostgresReadinessRunState;
    quarantineReconciliationComplete: boolean;
  }>;
  readonly policy: Readonly<{ lifecycleStaleAfterMilliseconds: number }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

/**
 * Validate a readiness body against the closed GCP contract: exact keys in
 * Worker order, closed values, the typed-mode constants and the Worker's own
 * consistency rules (ready only when the lifecycle is ready and the
 * reconciliation completed in the same maintenance cycle). With httpStatus,
 * 200 must carry 'ready' and 503 'not_ready'. Returns the violated paths,
 * each a schema name and never a value; an empty list means valid.
 */
export function validatePostgresReadinessBody(
  value: unknown,
  httpStatus?: number,
): readonly string[] {
  const violations: string[] = [];
  if (!isPlainRecord(value)) return Object.freeze(["body"]);
  if (!exactKeys(value, POSTGRES_READINESS_BODY_KEYS)) violations.push("body:keys");
  if (!oneOf(value.status, ["ready", "not_ready"])) violations.push("status");
  if (httpStatus !== undefined
      && !((httpStatus === 200 && value.status === "ready")
        || (httpStatus === 503 && value.status === "not_ready"))) {
    violations.push("status:http");
  }
  const checks = value.checks;
  if (!isPlainRecord(checks)) {
    violations.push("checks");
  } else {
    if (!exactKeys(checks, POSTGRES_READINESS_CHECK_KEYS)) violations.push("checks:keys");
    if (!oneOf(checks.lifecycle, POSTGRES_READINESS_LIFECYCLE_STATES)) violations.push("checks.lifecycle");
    for (const key of [
      "lifecycleFresh",
      "quarantineRetentionComplete",
      "restoreReplayComplete",
      "maintenanceCycleMatched",
      "quarantineReconciliationComplete",
    ] as const) {
      if (typeof checks[key] !== "boolean") violations.push(`checks.${key}`);
    }
    if (checks.aggregateRebuildComplete !== false) violations.push("checks.aggregateRebuildComplete");
    if (checks.aggregateRebuildDelegated !== true) violations.push("checks.aggregateRebuildDelegated");
    if (!oneOf(checks.quarantineReconciliation, POSTGRES_READINESS_RUN_STATES)) {
      violations.push("checks.quarantineReconciliation");
    }
    // The Worker's derivations, so a body that could not have come from
    // handleReady (or from buildPostgresReadinessBody) is refused.
    const lifecycle = checks.lifecycle;
    const fresh = checks.lifecycleFresh;
    if ((lifecycle === "ready" || lifecycle === "incomplete") && fresh !== true) {
      violations.push("checks.lifecycleFresh:inconsistent");
    }
    if ((lifecycle === "stale" || lifecycle === "never_run" || lifecycle === "running"
        || lifecycle === "failed") && fresh !== false) {
      violations.push("checks.lifecycleFresh:inconsistent");
    }
    const retained = checks.quarantineRetentionComplete === true && checks.restoreReplayComplete === true;
    if ((lifecycle === "ready" && !retained) || (lifecycle === "incomplete" && retained)) {
      violations.push("checks.lifecycle:inconsistent");
    }
    if (checks.quarantineReconciliationComplete === true
        && (checks.maintenanceCycleMatched !== true || checks.quarantineReconciliation !== "completed")) {
      violations.push("checks.quarantineReconciliationComplete:inconsistent");
    }
    const ready = lifecycle === "ready" && checks.quarantineReconciliationComplete === true;
    if (oneOf(value.status, ["ready", "not_ready"]) && (value.status === "ready") !== ready) {
      violations.push("status:inconsistent");
    }
  }
  const policy = value.policy;
  if (!isPlainRecord(policy)) {
    violations.push("policy");
  } else {
    if (!exactKeys(policy, POSTGRES_READINESS_POLICY_KEYS)) violations.push("policy:keys");
    if (policy.lifecycleStaleAfterMilliseconds !== POSTGRES_READINESS_STALE_AFTER_MILLISECONDS) {
      violations.push("policy.lifecycleStaleAfterMilliseconds");
    }
  }
  return Object.freeze([...new Set(violations)]);
}
