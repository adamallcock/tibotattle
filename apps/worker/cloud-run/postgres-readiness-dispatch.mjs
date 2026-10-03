/**
 * RD-2: GET /api/ready on the Cloud Run origin (CR-6/CR-7, D-CRB).
 *
 * Worker-exact readiness (owner decision OD-CR-4): the d43c8f92 handleReady
 * body and status for typed storage, from the rows C-MAINT's lifecycle pass
 * writes (src/postgres-lifecycle-pass.ts, run by the maintenance Job every
 * minute). An origin whose rows no pass has written reads not_ready; after
 * one complete pass it reads ready. The first roll of a fresh origin
 * therefore runs the maintenance pass before its verification (OPS-10 roll,
 * scripts/gcp-production-rollout.mjs).
 *
 * In d43c8f92 order, every evaluation runs the Worker's preflight against
 * the frozen origin env (originStatusPreflight: the admission, upload
 * authorization and ingress bindings, the ingress and sign-in
 * configuration, then a probe of the shared ingress budget; it never calls
 * a limiter's limit() and never assertDeviceSyncBindings), then the one read
 * (src/postgres-readiness.ts readPostgresReadinessState: receipt, lifecycle
 * rows and typed pins in one snapshot) and buildPostgresReadinessBody.
 *
 * Single flight: concurrent requests share one evaluation, and a completed
 * evaluation (ready or not_ready) is reused for STATUS_REUSE_MILLISECONDS; a
 * throw is never reused. A route family (FC-2): one argument, a Worker
 * envelope for every refusal under the root's request id.
 */

import {
  assertAdmissionBindings,
  assertUploadAuthorizationBindings,
  assertUploadIngressRateLimitBindings,
} from "../src/admission.ts";
import { ApiError, jsonResponse } from "../src/errors.ts";
import {
  buildPostgresReadinessBody,
  readPostgresReadinessState,
} from "../src/postgres-readiness.ts";
import { assertSignInStartAdmissionConfiguration } from "../src/signin-admission.ts";
import {
  assertUploadIngressConfiguration,
  probeUploadIngressBudget,
} from "../src/upload-ingress-admission.ts";
import { apiErrorToResponse, requestIdFor } from "./postgres-family-contract.mjs";

/** How long a completed status evaluation is reused. */
export const STATUS_REUSE_MILLISECONDS = 1_000;

/** OD-CR-4 (owner answer 2026-10-02): readiness matches the Worker exactly. */
export const ORIGIN_READINESS_SEMANTICS = "worker-exact";

export const READINESS_DISPATCH_CONFIGURATION_INVALID = "READINESS_DISPATCH_CONFIGURATION_INVALID";

function configurationError(name) {
  return Object.assign(new TypeError(`${READINESS_DISPATCH_CONFIGURATION_INVALID}: ${name}`), {
    code: READINESS_DISPATCH_CONFIGURATION_INVALID,
  });
}

function isPool(value) {
  return value !== null && typeof value === "object" && typeof value.connect === "function";
}

/** The Worker's methodNotAllowed(["GET"]) for the status routes. */
export function methodNotAllowedGet() {
  const error = new ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: Object.freeze(["GET"]) });
  return error;
}

/**
 * The d43c8f92 preflight shared by /api/ready and /api/health (index.ts
 * handleReady and the health branch), against the frozen origin env.
 */
export async function originStatusPreflight(env) {
  assertAdmissionBindings(env);
  assertUploadAuthorizationBindings(env);
  assertUploadIngressRateLimitBindings(env);
  assertUploadIngressConfiguration(env);
  assertSignInStartAdmissionConfiguration(env);
  await probeUploadIngressBudget(env);
}

/**
 * Share one evaluation between concurrent callers and reuse a completed one
 * for reuseMilliseconds; a rejection is passed to every waiting caller and
 * never reused.
 */
export function singleFlight(evaluate, clock, reuseMilliseconds = STATUS_REUSE_MILLISECONDS) {
  let inFlight = null;
  let completed = null;
  return function shared() {
    if (completed !== null) {
      const age = clock() - completed.at;
      if (Number.isFinite(age) && age >= 0 && age < reuseMilliseconds) return Promise.resolve(completed.value);
      completed = null;
    }
    if (inFlight === null) {
      inFlight = (async () => {
        try {
          const value = await evaluate();
          completed = { value, at: clock() };
          return value;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}

/**
 * deps (FC-3): requestContext (the root's accessor), env (the frozen origin
 * env), readinessPool, primarySchema, sourceNamespace,
 * expectedPrimaryMigrations (POSTGRES_RUNTIME_MIGRATIONS.primary), clock?
 * (Date.now). Returns async (request) => Response.
 */
export function createPostgresReadinessDispatch(deps) {
  if (deps === null || typeof deps !== "object") throw configurationError("deps");
  const { requestContext, env, readinessPool, primarySchema, sourceNamespace, expectedPrimaryMigrations } = deps;
  const clock = deps.clock ?? Date.now;
  if (typeof requestContext !== "function") throw configurationError("requestContext");
  if (env === null || typeof env !== "object" || !Object.isFrozen(env)) throw configurationError("env");
  if (!isPool(readinessPool)) throw configurationError("readinessPool");
  if (typeof primarySchema !== "string" || typeof sourceNamespace !== "string") {
    throw configurationError("primarySchema and sourceNamespace");
  }
  if (!Array.isArray(expectedPrimaryMigrations) || expectedPrimaryMigrations.length === 0) {
    throw configurationError("expectedPrimaryMigrations");
  }
  if (typeof clock !== "function") throw configurationError("clock");
  const evaluate = singleFlight(async () => {
    await originStatusPreflight(env);
    const state = await readPostgresReadinessState(readinessPool, {
      primarySchema, sourceNamespace, expectedPrimaryMigrations,
    });
    return buildPostgresReadinessBody(state, clock(), { semantics: ORIGIN_READINESS_SEMANTICS });
  }, clock);
  return async function dispatchPostgresReadiness(request) {
    try {
      if (request.method !== "GET") throw methodNotAllowedGet();
      const { httpStatus, body } = await evaluate();
      return jsonResponse(body, httpStatus, { "cache-control": "no-store" });
    } catch (error) {
      return apiErrorToResponse(error, requestIdFor({ requestContext }, request));
    }
  };
}
