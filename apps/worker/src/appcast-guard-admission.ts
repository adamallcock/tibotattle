import type { UploadIngressBudgetPolicy } from "./ingress-budget";
import { acquireOperationalLease } from "./operational-lease";

// Separate named state from participant uploads, even though both use the
// reviewed bounded lease implementation. No identity or request body is stored.
export const APPCAST_GUARD_BUDGET_OBJECT_NAME = "appcast-guard-body-budget-v1";
export const APPCAST_GUARD_BODY_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
});
export const APPCAST_GUARD_BUDGET_POLICY: Readonly<UploadIngressBudgetPolicy> = Object.freeze({
  maximumConcurrent: 4,
  maximumStartsPerMinute: 12,
  burst: 4,
  leaseMilliseconds: 30_000,
});
export function acquireAppcastGuardBodyLease(env: Env): Promise<() => Promise<void>> {
  return acquireOperationalLease(env, APPCAST_GUARD_BUDGET_OBJECT_NAME, APPCAST_GUARD_BUDGET_POLICY);
}
