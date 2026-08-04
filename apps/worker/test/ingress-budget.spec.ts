import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UploadIngressBudgetPolicy } from "../src/ingress-budget";

async function freshBudget(name: string) {
  const budget = env.UPLOAD_INGRESS_BUDGET.getByName(name);
  await runInDurableObject(budget, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  return budget;
}

describe("UploadIngressBudget", () => {
  it("globally holds a bounded in-flight lease until it is released", async () => {
    const budget = await freshBudget("test-upload-ingress-concurrency-v1");
    const policy: UploadIngressBudgetPolicy = {
      maximumConcurrent: 1,
      maximumStartsPerMinute: 1_200,
      burst: 2,
      leaseMilliseconds: 10_000,
    };

    const first = await budget.acquire(policy);
    const rejected = await budget.acquire(policy);
    expect(first).toMatchObject({
      allowed: true,
      leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      retryAfterSeconds: 0,
    });
    expect(rejected).toMatchObject({
      allowed: false,
      leaseId: null,
    });
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(10);

    await budget.release(first.leaseId!);
    const admittedAfterRelease = await budget.acquire(policy);
    expect(admittedAfterRelease.allowed).toBe(true);
  });

  it("enforces the shared start-rate budget even after the in-flight lease is released", async () => {
    const budget = await freshBudget("test-upload-ingress-rate-v1");
    const policy: UploadIngressBudgetPolicy = {
      maximumConcurrent: 2,
      maximumStartsPerMinute: 1,
      burst: 1,
      leaseMilliseconds: 10_000,
    };

    const first = await budget.acquire(policy);
    expect(first.allowed).toBe(true);
    await budget.release(first.leaseId!);

    const rejected = await budget.acquire(policy);
    expect(rejected).toEqual({
      allowed: false,
      leaseId: null,
      retryAfterSeconds: 60,
    });
  });

  it("safely applies a lower cap while old leases and tokens are persisted", async () => {
    const budget = await freshBudget("test-upload-ingress-lower-cap-v1");
    const initialPolicy: UploadIngressBudgetPolicy = {
      maximumConcurrent: 2,
      maximumStartsPerMinute: 1_200,
      burst: 4,
      leaseMilliseconds: 10_000,
    };
    const loweredPolicy: UploadIngressBudgetPolicy = {
      ...initialPolicy,
      maximumConcurrent: 1,
      burst: 1,
    };

    const first = await budget.acquire(initialPolicy);
    const second = await budget.acquire(initialPolicy);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);

    // Lowering maxConcurrent must not turn persisted old leases into a 503.
    const blockedByExistingLeases = await budget.acquire(loweredPolicy);
    expect(blockedByExistingLeases.allowed).toBe(false);
    await budget.release(first.leaseId!);
    const blockedByOneRemainingLease = await budget.acquire(loweredPolicy);
    expect(blockedByOneRemainingLease.allowed).toBe(false);
    await budget.release(second.leaseId!);

    const admittedAfterDraining = await budget.acquire(loweredPolicy);
    expect(admittedAfterDraining.allowed).toBe(true);
  });

  it("serializes concurrent acquires and supports non-consuming readiness probes", async () => {
    const budget = await freshBudget("test-upload-ingress-atomic-v1");
    const policy: UploadIngressBudgetPolicy = {
      maximumConcurrent: 2,
      maximumStartsPerMinute: 1_200,
      burst: 4,
      leaseMilliseconds: 10_000,
    };
    await expect(budget.probe(policy)).resolves.toBe(true);
    const outcomes = await Promise.all([
      budget.acquire(policy),
      budget.acquire(policy),
      budget.acquire(policy),
      budget.acquire(policy),
    ]);
    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(2);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(2);
  });

  it("renews only a live opaque lease", async () => {
    const budget = await freshBudget("test-upload-ingress-renew-v1");
    const policy: UploadIngressBudgetPolicy = {
      maximumConcurrent: 1,
      maximumStartsPerMinute: 1_200,
      burst: 2,
      leaseMilliseconds: 10_000,
    };
    const lease = await budget.acquire(policy);
    expect(lease.allowed).toBe(true);
    await expect(budget.renew(lease.leaseId!, policy)).resolves.toBe(true);
    await expect(budget.renew("00000000-0000-4000-8000-000000000000", policy))
      .resolves.toBe(false);
    await budget.release(lease.leaseId!);
    await expect(budget.renew(lease.leaseId!, policy)).resolves.toBe(false);
  });
});
