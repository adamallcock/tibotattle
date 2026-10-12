/**
 * Runtime-neutral upload ingress budget policy.
 *
 * The Durable Object and PostgreSQL implementations both use this state
 * machine.  Persistence owns serialization and locking; this module owns the
 * bounded token, lease, retry, and pressure semantics.
 */

export interface UploadIngressBudgetPolicy {
  readonly maximumConcurrent: number;
  readonly maximumStartsPerMinute: number;
  readonly burst: number;
  readonly leaseMilliseconds: number;
}

export interface UploadIngressBudgetDecision {
  readonly allowed: boolean;
  readonly leaseId: string | null;
  readonly retryAfterSeconds: number;
}

export interface UploadIngressBudgetStatus {
  readonly activeLeases: number;
  readonly maximumConcurrent: number;
  readonly availableStartTokens: number;
  readonly burst: number;
  readonly concurrencyDenials: number;
  readonly startRateDenials: number;
  readonly lastDeniedAtEpoch: number | null;
}

export interface UploadIngressBudgetState {
  readonly schemaVersion: "upload-ingress-budget-v0.1";
  tokens: number;
  updatedAt: number;
  leases: Record<string, number>;
  concurrencyDenials: number;
  startRateDenials: number;
  lastDeniedAtEpoch: number | null;
}

export const UPLOAD_INGRESS_BUDGET_SCHEMA_VERSION = "upload-ingress-budget-v0.1" as const;
export const UPLOAD_INGRESS_BUDGET_MAX_DENIAL_COUNT = 1_000_000_000;
export const UPLOAD_INGRESS_BUDGET_LEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validPositiveInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

export function assertUploadIngressBudgetPolicy(policy: UploadIngressBudgetPolicy): void {
  if (!policy
      || !validPositiveInteger(policy.maximumConcurrent, 1, 64)
      || !validPositiveInteger(policy.maximumStartsPerMinute, 1, 1_200)
      || !validPositiveInteger(policy.burst, 1, 1_200)
      || !validPositiveInteger(policy.leaseMilliseconds, 10_000, 5 * 60 * 1_000)) {
    throw new TypeError("Invalid upload ingress budget policy");
  }
}

export function emptyUploadIngressBudgetState(
  now: number,
  policy: UploadIngressBudgetPolicy,
): UploadIngressBudgetState {
  assertUploadIngressBudgetPolicy(policy);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid upload ingress budget clock");
  return {
    schemaVersion: UPLOAD_INGRESS_BUDGET_SCHEMA_VERSION,
    tokens: policy.burst,
    updatedAt: now,
    leases: {},
    concurrencyDenials: 0,
    startRateDenials: 0,
    lastDeniedAtEpoch: null,
  };
}

function parseDenialCount(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  return Math.min(UPLOAD_INGRESS_BUDGET_MAX_DENIAL_COUNT, value as number);
}

function parseLastDeniedAt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  return value as number;
}

/** Parse persisted state while allowing a safer rollout to lower a cap. */
export function parseUploadIngressBudgetState(
  value: unknown,
  now: number,
  policy: UploadIngressBudgetPolicy,
): UploadIngressBudgetState {
  assertUploadIngressBudgetPolicy(policy);
  if (value === undefined) return emptyUploadIngressBudgetState(now, policy);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  const candidate = value as Partial<UploadIngressBudgetState>;
  const leasesValue = candidate.leases;
  if (candidate.schemaVersion !== UPLOAD_INGRESS_BUDGET_SCHEMA_VERSION
      || typeof candidate.tokens !== "number"
      || !Number.isFinite(candidate.tokens)
      || candidate.tokens < 0
      || typeof candidate.updatedAt !== "number"
      || !Number.isSafeInteger(candidate.updatedAt)
      || candidate.updatedAt < 0
      || !leasesValue
      || typeof leasesValue !== "object"
      || Array.isArray(leasesValue)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  const leases = Object.entries(leasesValue);
  if (leases.length > 64
      || leases.some(([leaseId, expiresAt]) => !UPLOAD_INGRESS_BUDGET_LEASE_ID.test(leaseId)
        || !Number.isSafeInteger(expiresAt)
        || expiresAt < 0)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  return {
    schemaVersion: UPLOAD_INGRESS_BUDGET_SCHEMA_VERSION,
    tokens: Math.min(policy.burst, candidate.tokens),
    updatedAt: candidate.updatedAt,
    leases: Object.fromEntries(leases),
    concurrencyDenials: parseDenialCount(candidate.concurrencyDenials),
    startRateDenials: parseDenialCount(candidate.startRateDenials),
    lastDeniedAtEpoch: parseLastDeniedAt(candidate.lastDeniedAtEpoch),
  };
}

export function replenishUploadIngressBudgetTokens(
  state: UploadIngressBudgetState,
  now: number,
  policy: UploadIngressBudgetPolicy,
): void {
  const elapsed = Math.max(0, now - state.updatedAt);
  const tokens = state.tokens + ((elapsed * policy.maximumStartsPerMinute) / 60_000);
  state.tokens = Math.min(policy.burst, tokens);
  state.updatedAt = Math.max(state.updatedAt, now);
}

export function dropExpiredUploadIngressLeases(
  state: UploadIngressBudgetState,
  now: number,
): void {
  for (const [leaseId, expiresAt] of Object.entries(state.leases)) {
    if (expiresAt <= now) delete state.leases[leaseId];
  }
}

function recordDenial(
  state: UploadIngressBudgetState,
  kind: "concurrency" | "startRate",
  now: number,
): void {
  const field = kind === "concurrency" ? "concurrencyDenials" : "startRateDenials";
  state[field] = Math.min(UPLOAD_INGRESS_BUDGET_MAX_DENIAL_COUNT, state[field] + 1);
  state.lastDeniedAtEpoch = now;
}

function tokenRetryAfterSeconds(
  state: UploadIngressBudgetState,
  policy: UploadIngressBudgetPolicy,
): number {
  const missing = Math.max(0, 1 - state.tokens);
  return Math.max(
    1,
    Math.ceil((missing * 60_000) / policy.maximumStartsPerMinute / 1_000),
  );
}

function leaseRetryAfterSeconds(state: UploadIngressBudgetState, now: number): number {
  const nextLeaseExpiry = Math.min(...Object.values(state.leases));
  return Math.max(1, Math.ceil((nextLeaseExpiry - now) / 1_000));
}

export function acquireUploadIngressBudgetLease(
  state: UploadIngressBudgetState,
  policy: UploadIngressBudgetPolicy,
  now: number,
  leaseId: string = crypto.randomUUID(),
): UploadIngressBudgetDecision {
  if (!UPLOAD_INGRESS_BUDGET_LEASE_ID.test(leaseId)) {
    throw new TypeError("Invalid upload ingress lease ID");
  }
  if (Object.keys(state.leases).length >= policy.maximumConcurrent) {
    recordDenial(state, "concurrency", now);
    return { allowed: false, leaseId: null, retryAfterSeconds: leaseRetryAfterSeconds(state, now) };
  }
  if (state.tokens < 1) {
    recordDenial(state, "startRate", now);
    return { allowed: false, leaseId: null, retryAfterSeconds: tokenRetryAfterSeconds(state, policy) };
  }
  state.tokens -= 1;
  state.leases[leaseId] = now + policy.leaseMilliseconds;
  return { allowed: true, leaseId, retryAfterSeconds: 0 };
}

export function renewUploadIngressBudgetLease(
  state: UploadIngressBudgetState,
  leaseId: string,
  policy: UploadIngressBudgetPolicy,
  now: number,
): boolean {
  if (!UPLOAD_INGRESS_BUDGET_LEASE_ID.test(leaseId) || !(leaseId in state.leases)) return false;
  state.leases[leaseId] = now + policy.leaseMilliseconds;
  return true;
}

export function releaseUploadIngressBudgetLease(
  state: UploadIngressBudgetState,
  leaseId: string,
): void {
  if (UPLOAD_INGRESS_BUDGET_LEASE_ID.test(leaseId)) delete state.leases[leaseId];
}

export function uploadIngressBudgetStatus(
  state: UploadIngressBudgetState,
  policy: UploadIngressBudgetPolicy,
): UploadIngressBudgetStatus {
  return {
    activeLeases: Object.keys(state.leases).length,
    maximumConcurrent: policy.maximumConcurrent,
    availableStartTokens: Math.min(policy.burst, Math.floor(state.tokens)),
    burst: policy.burst,
    concurrencyDenials: state.concurrencyDenials,
    startRateDenials: state.startRateDenials,
    lastDeniedAtEpoch: state.lastDeniedAtEpoch,
  };
}
