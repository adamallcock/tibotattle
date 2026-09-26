/**
 * Address-keyed admission evaluated at the Cloudflare edge.
 *
 * When the production Worker is a thin proxy in front of the PostgreSQL
 * origin, every rate limit keyed on the client address is evaluated here, at
 * the edge, with the existing Workers Rate Limiting bindings and the
 * UNCHANGED src/admission.ts helpers. The origin never receives the client
 * address or anything derived from it; it only replays the outcome.
 *
 * EDGE_ADMISSION_POLICY is the reviewed map from Worker route id to the
 * helper, purpose and bindings that index.ts uses for that route. It is not a
 * second policy; test/edge-admission-policy.spec.ts holds it to index.ts in
 * two ways. A probe drives handleRequest for every registry route and method
 * with spy limiters and compares the address-keyed calls it observes, both
 * when the last predicted call is limited and when every call is admitted.
 * The probe sees only the calls a synthetic request reaches before an earlier
 * guard refuses it, so a raw-source ratchet also ties every helper call site
 * in index.ts, directly or through a wrapper such as deviceSyncPrincipal, to
 * the routeApi route ids and signatures in this policy.
 *
 * The purpose and outcome wire vocabulary belongs to the edge/origin contract
 * (edge-origin-contract.ts). This module deliberately exports no competing
 * vocabulary: EdgePolicyPurpose and EdgePolicyOutcome name only what this
 * policy can report, and each must stay assignable to the contract's
 * admission types where the edge proxy encodes an evaluation.
 *
 * Identity-keyed limits (UPLOAD_AUTHORIZATION, UPLOAD_PRINCIPAL), the upload
 * ingress budget and the global sign-in start window stay at the origin, so
 * device_upload_authorization is deliberately absent.
 */
import {
  assertAttemptAllowed,
  assertPublicAggregateReadAllowed,
  assertUploadIngressRequestAllowed,
} from "./admission";
import { ApiError } from "./errors";
import type { ExactWorkerRouteId } from "./route-registry";

/** The six Workers Rate Limiting bindings that stay at the edge. */
export const EDGE_ADMISSION_BINDINGS = Object.freeze([
  "ENROLLMENT_RATE_LIMIT",
  "RECOVERY_RATE_LIMIT",
  "CLIENT_ATTEMPT_RATE_LIMIT",
  "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
] as const);

export type EdgeAdmissionBinding = (typeof EDGE_ADMISSION_BINDINGS)[number];

export type EdgeAdmissionHelper = "attempt" | "public_read" | "upload_ingress";

export type EdgeAttemptPurpose =
  | "enrollment"
  | "sign_in_start"
  | "device_disconnect"
  | "device_credential_renew"
  | "device_sync"
  | "accountless_ownership"
  | "accountless_renewal";

/** The purposes this policy can report; a subset of the contract's purposes. */
export type EdgePolicyPurpose =
  | EdgeAttemptPurpose
  | "public_aggregate_read"
  | "upload_ingress";

/** The outcomes this policy can report; the contract owns their encoding. */
export type EdgePolicyOutcome = "allowed" | "limited" | "unavailable";

export type EdgeAdmissionPolicyEntry =
  | Readonly<{
      helper: "attempt";
      purpose: EdgeAttemptPurpose;
      coarseBinding: "ENROLLMENT_RATE_LIMIT" | "RECOVERY_RATE_LIMIT";
      clientBinding: "CLIENT_ATTEMPT_RATE_LIMIT";
    }>
  | Readonly<{
      helper: "upload_ingress";
      purpose: "upload_ingress";
      coarseBinding: "UPLOAD_INGRESS_REQUEST_RATE_LIMIT";
      clientBinding: "UPLOAD_INGRESS_CLIENT_RATE_LIMIT";
    }>
  | Readonly<{
      helper: "public_read";
      purpose: "public_aggregate_read";
      coarseBinding: null;
      clientBinding: "PUBLIC_READ_RATE_LIMIT";
    }>;

export type EdgeAdmissionPolicy = Readonly<
  Partial<Record<ExactWorkerRouteId, EdgeAdmissionPolicyEntry>>
>;

function attempt(
  purpose: EdgeAttemptPurpose,
  coarseBinding: "ENROLLMENT_RATE_LIMIT" | "RECOVERY_RATE_LIMIT",
): EdgeAdmissionPolicyEntry {
  return Object.freeze({
    helper: "attempt",
    purpose,
    coarseBinding,
    clientBinding: "CLIENT_ATTEMPT_RATE_LIMIT",
  });
}

function deviceSync(): EdgeAdmissionPolicyEntry {
  // index.ts deviceSyncPrincipal: one helper call shared by every device
  // bearer read/manifest/domain route below.
  return attempt("device_sync", "RECOVERY_RATE_LIMIT");
}

const POLICY_ENTRIES = {
  // handleEnroll and handleAccountlessEnrollment.
  enroll: attempt("enrollment", "ENROLLMENT_RATE_LIMIT"),
  accountless_enrollment: attempt("enrollment", "ENROLLMENT_RATE_LIMIT"),
  // handleAccountlessOwnership and both accountless grant handlers.
  accountless_ownership: attempt("accountless_ownership", "RECOVERY_RATE_LIMIT"),
  accountless_telemetry_v12_authorization:
    attempt("accountless_ownership", "RECOVERY_RATE_LIMIT"),
  accountless_telemetry_performance_authorization:
    attempt("accountless_ownership", "RECOVERY_RATE_LIMIT"),
  accountless_renewal: attempt("accountless_renewal", "RECOVERY_RATE_LIMIT"),
  // handleIdentityGoogleStart and handleIdentityAppleStart.
  identity_google_start: attempt("sign_in_start", "ENROLLMENT_RATE_LIMIT"),
  identity_apple_start: attempt("sign_in_start", "ENROLLMENT_RATE_LIMIT"),
  device_disconnect: attempt("device_disconnect", "RECOVERY_RATE_LIMIT"),
  device_credential_renew:
    attempt("device_credential_renew", "RECOVERY_RATE_LIMIT"),
  device_sync_state: deviceSync(),
  device_sync_capabilities: deviceSync(),
  device_sync_capabilities_v12: deviceSync(),
  telemetry_performance_capabilities: deviceSync(),
  telemetry_performance_reports: deviceSync(),
  telemetry_v11_day_manifests: deviceSync(),
  telemetry_v12_day_manifests: deviceSync(),
  telemetry_v11_domain_predecessor: deviceSync(),
  telemetry_v11_domain_activate: deviceSync(),
  telemetry_v12_domain_predecessor: deviceSync(),
  telemetry_v12_domain_activate: deviceSync(),
  device_sync_manifest: deviceSync(),
  // handleContribution, before the body is read.
  contributions: Object.freeze({
    helper: "upload_ingress",
    purpose: "upload_ingress",
    coarseBinding: "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
    clientBinding: "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
  }),
  // handleCommunityDaily: the only call is the per-client binding.
  community_daily: Object.freeze({
    helper: "public_read",
    purpose: "public_aggregate_read",
    coarseBinding: null,
    clientBinding: "PUBLIC_READ_RATE_LIMIT",
  }),
} as const satisfies EdgeAdmissionPolicy;

/**
 * Frozen and prototype-free, so an arbitrary route id such as "constructor"
 * can never resolve to an inherited value.
 */
export const EDGE_ADMISSION_POLICY: EdgeAdmissionPolicy = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, EdgeAdmissionPolicyEntry>,
    POLICY_ENTRIES,
  ),
);

export function edgeAdmissionPolicyFor(
  routeId: string,
): EdgeAdmissionPolicyEntry | null {
  if (!Object.hasOwn(EDGE_ADMISSION_POLICY, routeId)) return null;
  return EDGE_ADMISSION_POLICY[routeId as ExactWorkerRouteId] ?? null;
}

export type EdgeAdmissionLimiters = Readonly<
  Partial<Record<EdgeAdmissionBinding, RateLimit>>
>;

export interface EdgeAdmissionEvaluation {
  readonly purpose: EdgePolicyPurpose;
  readonly outcome: EdgePolicyOutcome;
}

export interface EdgeAdmissionInput {
  readonly routeId: string;
  /** The original client request; the runtime CF-Connecting-IP is read from it. */
  readonly request: Request;
  /** Only the six EDGE_ADMISSION_BINDINGS names are read from this object. */
  readonly limiters: EdgeAdmissionLimiters;
  /** Edge-only HMAC secret for client rate-limit keys. */
  readonly clientKeySecret: string;
}

/** admission.ts derives a keyed HMAC only from a secret of at least this length. */
const MINIMUM_CLIENT_KEY_SECRET_LENGTH = 32;

function evaluation(
  purpose: EdgePolicyPurpose,
  outcome: EdgePolicyOutcome,
): EdgeAdmissionEvaluation {
  return Object.freeze({ purpose, outcome });
}

function namedLimiters(
  limiters: EdgeAdmissionLimiters,
): Partial<Record<EdgeAdmissionBinding, RateLimit>> {
  const selected: Partial<Record<EdgeAdmissionBinding, RateLimit>> = {};
  if (limiters === null || typeof limiters !== "object") return selected;
  for (const name of EDGE_ADMISSION_BINDINGS) {
    const limiter = Reflect.get(limiters, name) as RateLimit | undefined;
    if (limiter !== undefined) selected[name] = limiter;
  }
  return selected;
}

/**
 * Runs the Worker's own admission helper for `routeId` against the edge
 * bindings and reports only the purpose and outcome. The helper receives the
 * ORIGINAL request, so the runtime CF-Connecting-IP is HMACed under the
 * edge-only secret exactly as admission.ts does in the Worker. Rate-limit
 * keys, addresses and secrets are never logged or returned, and the request
 * body is never read.
 *
 * Returns null for a route without an address-keyed limit; such a route never
 * touches a limiter.
 */
export async function evaluateEdgeAdmission(
  input: EdgeAdmissionInput,
): Promise<EdgeAdmissionEvaluation | null> {
  const policy = edgeAdmissionPolicyFor(input.routeId);
  if (policy === null) return null;
  const clientKeySecret = input.clientKeySecret;
  if (typeof clientKeySecret !== "string"
      || clientKeySecret.length < MINIMUM_CLIENT_KEY_SECRET_LENGTH) {
    // The helper would spend the coarse budget before refusing an unkeyed
    // hosted environment; refuse first so no limiter is touched.
    return evaluation(policy.purpose, "unavailable");
  }
  // Copy only the six named bindings, so a caller that hands over a whole
  // Worker env can never replace ENVIRONMENT or the edge-only secret.
  const limiters = namedLimiters(input.limiters);
  const admissionEnv = Object.freeze({
    ...limiters,
    ENVIRONMENT: "production",
    IDENTITY_LINK_SECRET: clientKeySecret,
  }) as unknown as Env;
  try {
    switch (policy.helper) {
      case "attempt":
        await assertAttemptAllowed(
          limiters[policy.coarseBinding],
          limiters[policy.clientBinding],
          input.request,
          admissionEnv,
          policy.purpose,
        );
        break;
      case "upload_ingress":
        await assertUploadIngressRequestAllowed(
          limiters[policy.coarseBinding],
          limiters[policy.clientBinding],
          input.request,
          admissionEnv,
        );
        break;
      case "public_read":
        await assertPublicAggregateReadAllowed(
          limiters[policy.clientBinding],
          input.request,
          admissionEnv,
        );
        break;
    }
  } catch (error) {
    return evaluation(
      policy.purpose,
      error instanceof ApiError && error.status === 429 ? "limited" : "unavailable",
    );
  }
  return evaluation(policy.purpose, "allowed");
}
