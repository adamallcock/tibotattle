const ADMIN_OVERVIEW_SCHEMA_VERSION = "admin-overview-v0.1";
const ADMIN_ACTION_SCHEMA_VERSION = "admin-action-v0.1";
const ADMIN_ACTIONS = new Set(["set_collection_controls", "run_maintenance"]);
const COLLECTION_STATES = new Set(["operational", "degraded", "contained"]);
const LIFECYCLE_STATES = new Set(["never_run", "running", "completed", "failed"]);
const RECONCILIATION_STATES = new Set([
  "never_run",
  "running",
  "completed",
  "failed",
]);
const SNAPSHOT_STATES = new Set(["published", "suppressed", "withdrawn"]);
const AUDIT_OUTCOMES = new Set(["started", "success", "failure"]);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AdminResponseError extends Error {
  constructor(code, requestId = null) {
    super(code);
    this.name = "AdminResponseError";
    this.code = code;
    this.requestId = requestId;
  }
}

function invalid(code) {
  throw new AdminResponseError(code);
}

function record(value, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(code);
  }
  return value;
}

function string(value, code) {
  if (typeof value !== "string" || value.length === 0) invalid(code);
  return value;
}

function nullableString(value, code) {
  return value === null ? null : string(value, code);
}

function boolean(value, code) {
  if (typeof value !== "boolean") invalid(code);
  return value;
}

function count(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(code);
  return value;
}

function array(value, code) {
  if (!Array.isArray(value)) invalid(code);
  return value;
}

function enumValue(value, values, code) {
  if (typeof value !== "string" || !values.has(value)) invalid(code);
  return value;
}

function projectCollection(value, code = "ADMIN_OVERVIEW_INVALID") {
  const collection = record(value, code);
  const flags = {
    enrollment: boolean(collection.enrollment, code),
    uploadRegistration: boolean(collection.uploadRegistration, code),
    processing: boolean(collection.processing, code),
    publication: boolean(collection.publication, code),
  };
  const state = enumValue(collection.state, COLLECTION_STATES, code);
  const enabled = Object.values(flags).filter(Boolean).length;
  if ((state === "operational" && enabled !== 4)
      || (state === "contained" && enabled !== 0)
      || (state === "degraded" && (enabled === 0 || enabled === 4))) {
    invalid(code);
  }
  return Object.freeze({
    state,
    revision: positiveInteger(collection.revision, code),
    ...flags,
  });
}

function projectOverviewCounts(value) {
  const counts = record(value, "ADMIN_OVERVIEW_INVALID");
  const participants = record(counts.participants, "ADMIN_OVERVIEW_INVALID");
  const contributions = record(counts.contributions, "ADMIN_OVERVIEW_INVALID");
  const telemetry = record(contributions.telemetry, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    participants: Object.freeze({
      active: count(participants.active, "ADMIN_OVERVIEW_INVALID"),
      total: count(participants.total, "ADMIN_OVERVIEW_INVALID"),
      bounded: boolean(participants.bounded, "ADMIN_OVERVIEW_INVALID"),
    }),
    contributions: Object.freeze({
      telemetry: Object.freeze({
        accepted: count(telemetry.accepted, "ADMIN_OVERVIEW_INVALID"),
        total: count(telemetry.total, "ADMIN_OVERVIEW_INVALID"),
        bounded: boolean(telemetry.bounded, "ADMIN_OVERVIEW_INVALID"),
      }),
      storedTelemetryRecords: count(
        contributions.storedTelemetryRecords,
        "ADMIN_OVERVIEW_INVALID",
      ),
      storedTelemetryRecordsBounded: boolean(
        contributions.storedTelemetryRecordsBounded,
        "ADMIN_OVERVIEW_INVALID",
      ),
    }),
    pendingQuarantineObjects: count(
      counts.pendingQuarantineObjects,
      "ADMIN_OVERVIEW_INVALID",
    ),
    pendingQuarantineObjectsBounded: boolean(
      counts.pendingQuarantineObjectsBounded,
      "ADMIN_OVERVIEW_INVALID",
    ),
  });
}

function projectLifecycle(value) {
  const lifecycle = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    state: enumValue(lifecycle.state, LIFECYCLE_STATES, "ADMIN_OVERVIEW_INVALID"),
    quarantineRetentionComplete: boolean(
      lifecycle.quarantineRetentionComplete,
      "ADMIN_OVERVIEW_INVALID",
    ),
    restoreReplayComplete: boolean(
      lifecycle.restoreReplayComplete,
      "ADMIN_OVERVIEW_INVALID",
    ),
    maintenanceRunAt: nullableString(
      lifecycle.maintenanceRunAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    failureCode: nullableString(lifecycle.failureCode, "ADMIN_OVERVIEW_INVALID"),
  });
}

function projectReconciliation(value) {
  const reconciliation = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    state: enumValue(
      reconciliation.state,
      RECONCILIATION_STATES,
      "ADMIN_OVERVIEW_INVALID",
    ),
    reconciliationComplete: boolean(
      reconciliation.reconciliationComplete,
      "ADMIN_OVERVIEW_INVALID",
    ),
  });
}

function projectErrors(value) {
  const errors = record(value, "ADMIN_OVERVIEW_INVALID");
  const groups = array(errors.groups, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const group = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      routeClass: string(group.routeClass, "ADMIN_OVERVIEW_INVALID"),
      errorCode: string(group.errorCode, "ADMIN_OVERVIEW_INVALID"),
      occurrences: count(group.occurrences, "ADMIN_OVERVIEW_INVALID"),
      ratePerDay: typeof group.ratePerDay === "number" && Number.isFinite(group.ratePerDay)
        ? group.ratePerDay
        : invalid("ADMIN_OVERVIEW_INVALID"),
      latestAt: string(group.latestAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  const projectLookup = (value) => {
    if (value === null) return null;
    const lookup = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      requestId: string(lookup.requestId, "ADMIN_OVERVIEW_INVALID"),
      errorCode: string(lookup.errorCode, "ADMIN_OVERVIEW_INVALID"),
      routeClass: string(lookup.routeClass, "ADMIN_OVERVIEW_INVALID"),
      occurredAt: string(lookup.occurredAt, "ADMIN_OVERVIEW_INVALID"),
    });
  };
  return Object.freeze({ groups: Object.freeze(groups), lookup: projectLookup(errors.lookup) });
}

/**
 * Project exactly the fields the operations renderer consumes. A server
 * response is either rendered from this stable local shape or rejected before
 * it can put controls into an unknown state.
 */
export function projectAdminOverview(value) {
  const overview = record(value, "ADMIN_OVERVIEW_INVALID");
  if (overview.schemaVersion !== ADMIN_OVERVIEW_SCHEMA_VERSION) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  const service = record(overview.service, "ADMIN_OVERVIEW_INVALID");
  const snapshots = array(overview.snapshots, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const snapshot = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      snapshotId: string(snapshot.snapshotId, "ADMIN_OVERVIEW_INVALID"),
      weekStart: string(snapshot.weekStart, "ADMIN_OVERVIEW_INVALID"),
      weekEnd: string(snapshot.weekEnd, "ADMIN_OVERVIEW_INVALID"),
      releaseState: enumValue(
        snapshot.releaseState,
        SNAPSHOT_STATES,
        "ADMIN_OVERVIEW_INVALID",
      ),
      releasedAt: string(snapshot.releasedAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  const audit = array(overview.audit, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const item = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      action: enumValue(item.action, ADMIN_ACTIONS, "ADMIN_OVERVIEW_INVALID"),
      outcome: enumValue(item.outcome, AUDIT_OUTCOMES, "ADMIN_OVERVIEW_INVALID"),
      details: item.details,
      createdAt: string(item.createdAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  return Object.freeze({
    generatedAt: string(overview.generatedAt, "ADMIN_OVERVIEW_INVALID"),
    service: Object.freeze({
      environment: string(service.environment, "ADMIN_OVERVIEW_INVALID"),
    }),
    collection: projectCollection(overview.collection),
    counts: projectOverviewCounts(overview.counts),
    lifecycle: projectLifecycle(overview.lifecycle),
    reconciliation: projectReconciliation(overview.reconciliation),
    snapshots: Object.freeze(snapshots),
    pendingHistoricalRebuilds: count(
      overview.pendingHistoricalRebuilds,
      "ADMIN_OVERVIEW_INVALID",
    ),
    errors: projectErrors(overview.errors),
    audit: Object.freeze(audit),
  });
}

export function projectAdminAction(value, expectedAction) {
  if (!ADMIN_ACTIONS.has(expectedAction)) invalid("ADMIN_ACTION_INVALID");
  const action = record(value, "ADMIN_ACTION_INVALID");
  if (action.schemaVersion !== ADMIN_ACTION_SCHEMA_VERSION
      || action.action !== expectedAction) {
    invalid("ADMIN_ACTION_INVALID");
  }
  if (expectedAction === "set_collection_controls") {
    return Object.freeze({
      action: expectedAction,
      collection: projectCollection(action.collection, "ADMIN_ACTION_INVALID"),
    });
  }
  const result = record(action.result, "ADMIN_ACTION_INVALID");
  return Object.freeze({
    action: expectedAction,
    result: Object.freeze({
      code: string(result.code, "ADMIN_ACTION_INVALID"),
    }),
  });
}

export function adminResponseError(status, value) {
  const error = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value.error
    : null;
  const details = typeof error === "object" && error !== null && !Array.isArray(error)
    ? error
    : null;
  const code = typeof details?.code === "string" && ERROR_CODE_PATTERN.test(details.code)
    ? details.code
    : `HTTP_${Number.isSafeInteger(status) ? status : 0}`;
  const requestId = typeof details?.requestId === "string"
      && REQUEST_ID_PATTERN.test(details.requestId)
    ? details.requestId
    : null;
  return new AdminResponseError(code, requestId);
}

export function adminActionErrorMessage(error) {
  const response = error instanceof AdminResponseError ? error : null;
  if (response?.code === "ADMIN_ACTION_CONFLICT") {
    return "The collection state changed elsewhere. Refresh the operations view before trying again.";
  }
  if (response?.code === "ADMIN_ACTION_INVALID") {
    return "The service returned an invalid action response. No further action was taken.";
  }
  const code = response?.code ?? "UNEXPECTED_ERROR";
  const reference = response?.requestId ? ` (${response.requestId})` : "";
  return `${code}${reference}`;
}
