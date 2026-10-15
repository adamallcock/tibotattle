import { describe, expect, it, vi } from "vitest";
import { acquireOperationalLease } from "../src/operational-lease";
import { APPCAST_GUARD_BUDGET_POLICY } from "../src/appcast-guard-admission";

const leaseId = "11111111-1111-4111-8111-111111111111";
function runtime(stub: unknown): Env {
  return { UPLOAD_INGRESS_BUDGET: { getByName: () => stub } } as unknown as Env;
}

describe("operational lease failure boundaries", () => {
  it("maps synchronous namespace and RPC failures to a bounded content-free error", async () => {
    for (const env of [
      { UPLOAD_INGRESS_BUDGET: { getByName() { throw new Error("private backend detail"); } } } as unknown as Env,
      runtime({ acquire() { throw new Error("private backend detail"); } }),
    ]) {
      await expect(acquireOperationalLease(env, "test", APPCAST_GUARD_BUDGET_POLICY)).rejects.toMatchObject({
        status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
      });
    }
  });

  it("releases a valid late lease and safely ignores malformed late decisions", async () => {
    for (const decision of [null, {}, { allowed: true, leaseId: "malformed" }, { allowed: true, leaseId, retryAfterSeconds: 0 }]) {
      let resolve!: (value: unknown) => void;
      const release = vi.fn(() => { throw new Error("late release unavailable"); });
      const env = runtime({ acquire: () => new Promise((done) => { resolve = done; }), release });
      vi.useFakeTimers();
      try {
        const pending = acquireOperationalLease(env, "test", APPCAST_GUARD_BUDGET_POLICY);
        const outcome = expect(pending).rejects.toMatchObject({ status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE" });
        await vi.advanceTimersByTimeAsync(1_001);
        await outcome;
        resolve(decision);
        await vi.advanceTimersByTimeAsync(1);
        expect(release).toHaveBeenCalledTimes(decision && "leaseId" in decision && decision.leaseId === leaseId ? 1 : 0);
      } finally { vi.useRealTimers(); }
    }
  });

  it("does not wait forever for a release RPC after the work has finished", async () => {
    const release = await acquireOperationalLease(runtime({
      acquire: async () => ({ allowed: true, leaseId, retryAfterSeconds: 0 }),
      release: () => new Promise(() => {}),
    }), "test", APPCAST_GUARD_BUDGET_POLICY);
    vi.useFakeTimers();
    try {
      const pending = release();
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(pending).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
