/**
 * POST /api/v1/admin/action on the PostgreSQL origin (GCP, C-ADMIN).
 *
 * d43c8f92 handleAdminAction in access mode (index.ts:3735-3949), in the
 * Worker's order:
 *
 * 1. the owner identity from the chokepoint (403 ADMIN_REQUIRED without it);
 * 2. POST only (405 Allow: POST);
 * 3. the session-independent admin CSRF check, session.ts assertAdminCsrf:
 *    Origin must equal the request origin, Sec-Fetch-Site absent or
 *    same-origin, and x-usage-monitor-admin exactly "1" (403 CSRF_INVALID);
 * 4. the bounded JSON body (415, 413, 408, 400 as readBoundedJson);
 * 5. an object with a string action from the closed set (400 BODY_INVALID);
 * 6. the action:
 *    - run_maintenance checks its task keys in the Worker's order:
 *      telemetryRuntimeActivation, transportRollback, v11EvidenceAdoption,
 *      participantErasure; otherwise the body must be exactly {action} and
 *      the maintenance pass runs between a started and a terminal audit row
 *      (MAINTENANCE_IN_PROGRESS is 409 LIFECYCLE_STATE_CONFLICT);
 *    - sync_distribution must be exactly {action}; it runs between a started
 *      and a terminal audit row, and GITHUB_SYNC_FAILED is 503
 *      DISTRIBUTION_SYNC_UNAVAILABLE;
 *    - set_collection_controls takes exactly the seven keys, a known reason
 *      and a positive expected revision, and compare-and-sets the controls.
 *
 * Decided differences, all fail-closed and storage-free:
 * - participantErasure: the running service performs no erasure (append-only
 *   decision D2, Variant B; AA-1 v4). A body carrying it is answered exactly
 *   as the Worker answers a body with no recognised task, 400 BODY_INVALID,
 *   with no audit row and no storage call.
 * - A task whose PostgreSQL port is not injected (the maintenance pass, the
 *   distribution sync, runtime activation, transport rollback, v1.1 evidence
 *   adoption) answers 503 POSTGRES_ROUTE_NOT_PORTED with no retry-after
 *   (OD-CR-3, OD-CR-6 iv), before any audit row or storage call.
 *
 * Every 200 is {schemaVersion: 'admin-action-v0.1', action, result} (or
 * collection for set_collection_controls) with no-store and vary: Cookie.
 */

import { ApiError } from "../../src/errors.ts";
import { assertAdminCsrf } from "../../src/session.ts";
import { readBoundedJsonRequest } from "../postgres-family-contract.mjs";
import {
  adminFamilyDispatcher,
  adminOk,
  adminTaskNotPorted,
  assertAdminFamilyDeps,
  assertAdminMethod,
  familyClock,
  optionalFunction,
  requireAdminIdentity,
  requiredFunction,
} from "./admin-route-support.mjs";

export const ADMIN_ACTION_PATHNAMES = Object.freeze(["/api/v1/admin/action"]);
export const ADMIN_ACTION_SCHEMA_VERSION = "admin-action-v0.1";

/** d43c8f92 ADMIN_ACTIONS, in its order. */
export const ADMIN_ACTIONS = Object.freeze([
  "set_collection_controls",
  "run_maintenance",
  "sync_distribution",
]);

/** d43c8f92 ADMIN_CONTROL_REASONS, in its order. */
export const ADMIN_CONTROL_REASONS = Object.freeze([
  "drill_containment",
  "drill_restore",
  "privacy_incident",
  "security_incident",
  "abuse_or_cost",
  "maintenance",
]);

/** The run_maintenance task keys handleAdminAction tests, in its order. */
export const RUN_MAINTENANCE_TASK_KEYS = Object.freeze([
  "telemetryRuntimeActivation",
  "transportRollback",
  "v11EvidenceAdoption",
  "participantErasure",
]);

/** The task keys the origin closes without a port (append-only decision D2). */
export const CLOSED_RUN_MAINTENANCE_TASK_KEYS = Object.freeze(["participantErasure"]);

const CONTROL_KEYS = Object.freeze([
  "action", "enrollment", "uploadRegistration", "processing", "publication",
  "reasonCode", "expectedRevision",
].sort());

/** The maintenance result fields the Worker's success audit records, in its order. */
export const RUN_MAINTENANCE_AUDIT_FIELDS = Object.freeze([
  "code",
  "lifecycleComplete",
  "quarantineReconciliationComplete",
  "expiredIdentityHandoffsPurged",
  "expiredIdentityHandoffPurgeComplete",
  "expiredDeletionTombstonesPurged",
  "deletionTombstonePurgeComplete",
  "expiredPrimaryIdentityReenrollmentCooldownsPurged",
  "primaryIdentityReenrollmentCooldownPurgeComplete",
  "expiredIdentityReenrollmentCooldownsPurged",
  "identityReenrollmentCooldownPurgeComplete",
  "aggregateRebuildComplete",
  "publicationEnabled",
]);

function bodyInvalid() {
  return new ApiError(400, "BODY_INVALID");
}

function failureCode(error) {
  return error instanceof ApiError ? error.code : "INTERNAL_ERROR";
}

function respond(action, result) {
  return adminOk({ schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, action, result });
}

/**
 * deps.admin:
 *   setCollectionControls({identityKey, flags, reasonCode, expectedRevision, nowEpoch}) -> controls
 *   beginAudit({action, identityKey, details, nowIso}) -> operationId
 *   finishAudit({operationId, outcome, details})
 *   finishAuditBestEffort({operationId, outcome, details})
 * deps.admin.maintenance (each optional; absent answers 503 POSTGRES_ROUTE_NOT_PORTED):
 *   runMaintenance(nowEpoch) -> {code, ...}
 *   syncDistribution(nowEpoch) -> {code, observedAt, failureCode}
 *   telemetryRuntimeActivation({body, identityKey}) -> result
 *   transportRollback({body, identityKey}) -> result
 *   v11EvidenceAdoption({body, identityKey}) -> result
 */
export function createAdminActionDispatch(deps) {
  const route = "admin_action";
  assertAdminFamilyDeps(route, deps);
  const admin = deps.admin ?? {};
  const setCollectionControls = requiredFunction(route, "setCollectionControls", admin.setCollectionControls);
  const beginAudit = requiredFunction(route, "beginAudit", admin.beginAudit);
  const finishAudit = requiredFunction(route, "finishAudit", admin.finishAudit);
  const finishAuditBestEffort = requiredFunction(route, "finishAuditBestEffort", admin.finishAuditBestEffort);
  const maintenance = admin.maintenance ?? {};
  if (maintenance === null || typeof maintenance !== "object") {
    throw new TypeError("ADMIN_ROUTE_CONFIGURATION_INVALID: admin_action: maintenance");
  }
  for (const key of Object.keys(maintenance)) {
    if (!["runMaintenance", "syncDistribution", ...RUN_MAINTENANCE_TASK_KEYS].includes(key)
        || CLOSED_RUN_MAINTENANCE_TASK_KEYS.includes(key)) {
      throw new TypeError(`ADMIN_ROUTE_CONFIGURATION_INVALID: admin_action: maintenance.${key}`);
    }
  }
  const runMaintenance = optionalFunction(route, "runMaintenance", maintenance.runMaintenance);
  const syncDistribution = optionalFunction(route, "syncDistribution", maintenance.syncDistribution);
  const tasks = Object.freeze({
    telemetryRuntimeActivation: optionalFunction(route, "telemetryRuntimeActivation",
      maintenance.telemetryRuntimeActivation),
    transportRollback: optionalFunction(route, "transportRollback", maintenance.transportRollback),
    v11EvidenceAdoption: optionalFunction(route, "v11EvidenceAdoption", maintenance.v11EvidenceAdoption),
  });
  const clock = familyClock(deps);

  async function audited(action, identityKey, work) {
    const operationId = await beginAudit({
      action, identityKey, details: { phase: "started" }, nowIso: new Date(clock()).toISOString(),
    });
    return work(operationId);
  }

  async function plainMaintenance(identityKey) {
    if (runMaintenance === undefined) throw adminTaskNotPorted();
    return audited("run_maintenance", identityKey, async (operationId) => {
      try {
        const result = await runMaintenance(clock());
        if (result?.code === "MAINTENANCE_IN_PROGRESS") {
          throw new ApiError(409, "LIFECYCLE_STATE_CONFLICT");
        }
        const details = {};
        for (const field of RUN_MAINTENANCE_AUDIT_FIELDS) details[field] = result?.[field];
        await finishAudit({ operationId, outcome: "success", details });
        return respond("run_maintenance", result);
      } catch (error) {
        await finishAuditBestEffort({ operationId, outcome: "failure", details: { code: failureCode(error) } });
        throw error;
      }
    });
  }

  async function distributionSync(identityKey) {
    if (syncDistribution === undefined) throw adminTaskNotPorted();
    return audited("sync_distribution", identityKey, async (operationId) => {
      try {
        const result = await syncDistribution(clock());
        if (result?.code === "GITHUB_SYNC_FAILED") {
          await finishAudit({
            operationId, outcome: "failure", details: { code: result.failureCode ?? "GITHUB_UNAVAILABLE" },
          });
          throw new ApiError(503, "DISTRIBUTION_SYNC_UNAVAILABLE");
        }
        await finishAudit({
          operationId, outcome: "success", details: { code: result?.code, observedAt: result?.observedAt },
        });
        return respond("sync_distribution", result);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "DISTRIBUTION_SYNC_UNAVAILABLE")) {
          await finishAuditBestEffort({ operationId, outcome: "failure", details: { code: failureCode(error) } });
        }
        throw error;
      }
    });
  }

  return adminFamilyDispatcher(deps, async (request) => {
    const identityKey = requireAdminIdentity(deps, request);
    assertAdminMethod(request, "POST");
    assertAdminCsrf(request);
    const body = await readBoundedJsonRequest(request);
    const value = body.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)
        || typeof Reflect.get(value, "action") !== "string") {
      throw bodyInvalid();
    }
    const action = Reflect.get(value, "action");
    if (!ADMIN_ACTIONS.includes(action)) throw bodyInvalid();

    if (action === "run_maintenance") {
      for (const key of RUN_MAINTENANCE_TASK_KEYS) {
        if (!Object.hasOwn(value, key)) continue;
        if (CLOSED_RUN_MAINTENANCE_TASK_KEYS.includes(key)) throw bodyInvalid();
        const task = tasks[key];
        if (task === undefined) throw adminTaskNotPorted();
        return respond(action, await task({ body: value, identityKey }));
      }
      if (Object.keys(value).length !== 1) throw bodyInvalid();
      return plainMaintenance(identityKey);
    }

    if (action === "sync_distribution") {
      if (Object.keys(value).length !== 1) throw bodyInvalid();
      return distributionSync(identityKey);
    }

    if (Object.keys(value).sort().join("\0") !== CONTROL_KEYS.join("\0")
        || typeof value.enrollment !== "boolean"
        || typeof value.uploadRegistration !== "boolean"
        || typeof value.processing !== "boolean"
        || typeof value.publication !== "boolean"
        || typeof value.reasonCode !== "string"
        || !Number.isSafeInteger(value.expectedRevision)
        || value.expectedRevision < 1
        || !ADMIN_CONTROL_REASONS.includes(value.reasonCode)) {
      throw bodyInvalid();
    }
    const collection = await setCollectionControls({
      identityKey,
      flags: {
        enrollment: value.enrollment,
        uploadRegistration: value.uploadRegistration,
        processing: value.processing,
        publication: value.publication,
      },
      reasonCode: value.reasonCode,
      expectedRevision: value.expectedRevision,
      nowEpoch: clock(),
    });
    return adminOk({ schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, action, collection });
  });
}
