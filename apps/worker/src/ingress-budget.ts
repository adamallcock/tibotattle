import { DurableObject } from "cloudflare:workers";

export interface UploadIngressBudgetPolicy {
  maximumConcurrent: number;
  maximumStartsPerMinute: number;
  burst: number;
  leaseMilliseconds: number;
}

export interface UploadIngressBudgetDecision {
  allowed: boolean;
  leaseId: string | null;
  retryAfterSeconds: number;
}

/**
 * A read-only pressure snapshot for the owner operations surface. It contains
 * capacity numbers and content-free denial counters only — never a lease ID,
 * IP, participant, or request detail.
 */
export interface UploadIngressBudgetStatus {
  activeLeases: number;
  maximumConcurrent: number;
  availableStartTokens: number;
  burst: number;
  concurrencyDenials: number;
  startRateDenials: number;
  lastDeniedAtEpoch: number | null;
}

interface StoredIngressBudget {
  schemaVersion: "upload-ingress-budget-v0.1";
  tokens: number;
  updatedAt: number;
  leases: Record<string, number>;
  concurrencyDenials: number;
  startRateDenials: number;
  lastDeniedAtEpoch: number | null;
}

const STATE_KEY = "upload-ingress-budget-state-v0.1";
// Counters exist to show pressure, not to account precisely forever. A hard
// ceiling keeps the stored value a small bounded integer under any flood.
const MAX_DENIAL_COUNT = 1_000_000_000;
const LEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validPositiveInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function assertPolicy(policy: UploadIngressBudgetPolicy): void {
  if (!policy
      || !validPositiveInteger(policy.maximumConcurrent, 1, 64)
      || !validPositiveInteger(policy.maximumStartsPerMinute, 1, 1_200)
      || !validPositiveInteger(policy.burst, 1, 1_200)
      || !validPositiveInteger(policy.leaseMilliseconds, 10_000, 5 * 60 * 1_000)) {
    throw new TypeError("Invalid upload ingress budget policy");
  }
}

function emptyState(now: number, policy: UploadIngressBudgetPolicy): StoredIngressBudget {
  return {
    schemaVersion: "upload-ingress-budget-v0.1",
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
  return Math.min(MAX_DENIAL_COUNT, value as number);
}

function parseLastDeniedAt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  return value as number;
}

function parseState(
  value: unknown,
  now: number,
  policy: UploadIngressBudgetPolicy,
): StoredIngressBudget {
  if (value === undefined) return emptyState(now, policy);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  const candidate = value as Partial<StoredIngressBudget>;
  const tokens = candidate.tokens;
  const updatedAt = candidate.updatedAt;
  const leasesValue = candidate.leases;
  if (candidate.schemaVersion !== "upload-ingress-budget-v0.1"
      || typeof tokens !== "number"
      || !Number.isFinite(tokens)
      || tokens < 0
      || typeof updatedAt !== "number"
      || !Number.isSafeInteger(updatedAt)
      || updatedAt < 0
      || !leasesValue
      || typeof leasesValue !== "object"
      || Array.isArray(leasesValue)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  const leases = Object.entries(leasesValue);
  // A safer rollout can lower either cap while old leases/tokens are still
  // present. Keep honoring those existing leases, clamp stored burst credit,
  // and admit no new work until the new policy permits it.
  if (leases.length > 64
      || leases.some(([leaseId, expiresAt]) => !LEASE_ID.test(leaseId)
        || !Number.isSafeInteger(expiresAt)
        || expiresAt < 0)) {
    throw new TypeError("Invalid upload ingress budget state");
  }
  return {
    schemaVersion: candidate.schemaVersion,
    tokens: Math.min(policy.burst, tokens),
    updatedAt,
    leases: Object.fromEntries(leases),
    // Older stored records predate the denial counters; absence means zero
    // observed denials, not corruption.
    concurrencyDenials: parseDenialCount(candidate.concurrencyDenials),
    startRateDenials: parseDenialCount(candidate.startRateDenials),
    lastDeniedAtEpoch: parseLastDeniedAt(candidate.lastDeniedAtEpoch),
  };
}

function recordDenial(
  state: StoredIngressBudget,
  kind: "concurrency" | "startRate",
  now: number,
): void {
  const field = kind === "concurrency" ? "concurrencyDenials" : "startRateDenials";
  state[field] = Math.min(MAX_DENIAL_COUNT, state[field] + 1);
  state.lastDeniedAtEpoch = now;
}

function replenishTokens(
  state: StoredIngressBudget,
  now: number,
  policy: UploadIngressBudgetPolicy,
): void {
  const elapsed = Math.max(0, now - state.updatedAt);
  const tokens = state.tokens
    + ((elapsed * policy.maximumStartsPerMinute) / 60_000);
  state.tokens = Math.min(policy.burst, tokens);
  state.updatedAt = Math.max(state.updatedAt, now);
}

function dropExpiredLeases(state: StoredIngressBudget, now: number): void {
  for (const [leaseId, expiresAt] of Object.entries(state.leases)) {
    if (expiresAt <= now) delete state.leases[leaseId];
  }
}

function tokenRetryAfterSeconds(
  state: StoredIngressBudget,
  policy: UploadIngressBudgetPolicy,
): number {
  const missing = Math.max(0, 1 - state.tokens);
  return Math.max(
    1,
    Math.ceil((missing * 60_000) / policy.maximumStartsPerMinute / 1_000),
  );
}

function leaseRetryAfterSeconds(state: StoredIngressBudget, now: number): number {
  const nextLeaseExpiry = Math.min(...Object.values(state.leases));
  return Math.max(1, Math.ceil((nextLeaseExpiry - now) / 1_000));
}

/**
 * The Worker calls one named instance for every accepted upload. It stores only
 * opaque short-lived lease IDs, never an IP, participant ID, envelope, or body.
 */
export class UploadIngressBudget extends DurableObject<Env> {
  async acquire(policy: UploadIngressBudgetPolicy): Promise<UploadIngressBudgetDecision> {
    assertPolicy(policy);
    return this.ctx.storage.transaction(async (storage) => {
      // Read the clock after this invocation has reached the serialized
      // transaction. Capturing it outside can shorten a lease while a busy DO
      // waits to enter storage.
      const now = Date.now();
      const state = parseState(
        await storage.get<StoredIngressBudget>(STATE_KEY),
        now,
        policy,
      );
      replenishTokens(state, now, policy);
      dropExpiredLeases(state, now);
      if (Object.keys(state.leases).length >= policy.maximumConcurrent) {
        recordDenial(state, "concurrency", now);
        await storage.put(STATE_KEY, state);
        return {
          allowed: false,
          leaseId: null,
          retryAfterSeconds: leaseRetryAfterSeconds(state, now),
        };
      }
      if (state.tokens < 1) {
        recordDenial(state, "startRate", now);
        await storage.put(STATE_KEY, state);
        return {
          allowed: false,
          leaseId: null,
          retryAfterSeconds: tokenRetryAfterSeconds(state, policy),
        };
      }
      const leaseId = crypto.randomUUID();
      state.tokens -= 1;
      state.leases[leaseId] = now + policy.leaseMilliseconds;
      await storage.put(STATE_KEY, state);
      return { allowed: true, leaseId, retryAfterSeconds: 0 };
    });
  }

  /**
   * A live Worker renews its opaque lease while it is reading and validating a
   * request. If a Worker dies, the lease remains finite and another request
   * can eventually make progress; if it is still alive, a stale lease cannot
   * silently open an extra concurrent slot.
   */
  async renew(leaseId: string, policy: UploadIngressBudgetPolicy): Promise<boolean> {
    assertPolicy(policy);
    if (!LEASE_ID.test(leaseId)) return false;
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      const state = parseState(
        await storage.get<StoredIngressBudget>(STATE_KEY),
        now,
        policy,
      );
      replenishTokens(state, now, policy);
      dropExpiredLeases(state, now);
      if (!(leaseId in state.leases)) {
        await storage.put(STATE_KEY, state);
        return false;
      }
      state.leases[leaseId] = now + policy.leaseMilliseconds;
      await storage.put(STATE_KEY, state);
      return true;
    });
  }

  // Readiness needs to prove that the namespace can service a non-consuming
  // RPC, not merely that its binding has a `getByName` method.
  async probe(policy: UploadIngressBudgetPolicy): Promise<boolean> {
    assertPolicy(policy);
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      const state = parseState(
        await storage.get<StoredIngressBudget>(STATE_KEY),
        now,
        policy,
      );
      replenishTokens(state, now, policy);
      dropExpiredLeases(state, now);
      await storage.put(STATE_KEY, state);
      return true;
    });
  }

  /**
   * A read-only pressure snapshot for the owner operations surface. Like
   * `probe`, it performs the routine lease/token maintenance so the numbers it
   * reports are current, but it never admits work or issues a lease.
   */
  async status(policy: UploadIngressBudgetPolicy): Promise<UploadIngressBudgetStatus> {
    assertPolicy(policy);
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      const state = parseState(
        await storage.get<StoredIngressBudget>(STATE_KEY),
        now,
        policy,
      );
      replenishTokens(state, now, policy);
      dropExpiredLeases(state, now);
      await storage.put(STATE_KEY, state);
      return {
        activeLeases: Object.keys(state.leases).length,
        maximumConcurrent: policy.maximumConcurrent,
        availableStartTokens: Math.min(policy.burst, Math.floor(state.tokens)),
        burst: policy.burst,
        concurrencyDenials: state.concurrencyDenials,
        startRateDenials: state.startRateDenials,
        lastDeniedAtEpoch: state.lastDeniedAtEpoch,
      };
    });
  }

  async release(leaseId: string): Promise<void> {
    if (!LEASE_ID.test(leaseId)) return;
    await this.ctx.storage.transaction(async (storage) => {
      const value = await storage.get<StoredIngressBudget>(STATE_KEY);
      if (value === undefined || !value.leases || typeof value.leases !== "object") {
        return;
      }
      if (!(leaseId in value.leases)) return;
      delete value.leases[leaseId];
      await storage.put(STATE_KEY, value);
    });
  }
}
