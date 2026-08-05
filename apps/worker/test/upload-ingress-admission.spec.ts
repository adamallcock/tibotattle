import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_INGRESS_LIFETIME_MILLISECONDS } from "../src/constants";
import {
  acquireUploadIngressLease,
  assertUploadIngressConfiguration,
  probeUploadIngressBudget,
  startUploadIngressLeaseHeartbeat,
  uploadIngressBodyReadPolicy,
} from "../src/upload-ingress-admission";

const LEASE_ID = "12345678-1234-4234-8234-1234567890ab";

function ingressEnvironment(stub: Partial<{
  acquire: () => Promise<unknown>;
  probe: () => Promise<unknown>;
  release: () => Promise<void>;
  renew: () => Promise<unknown>;
}> = {}): Env {
  return {
    UPLOAD_INGRESS_BUDGET: {
      getByName: () => ({
        acquire: stub.acquire ?? (async () => ({
          allowed: true,
          leaseId: LEASE_ID,
          retryAfterSeconds: 0,
        })),
        probe: stub.probe ?? (async () => true),
        release: stub.release ?? (async () => {}),
        renew: stub.renew ?? (async () => true),
      }),
    },
    UPLOAD_INGRESS_QUEUE_MODE: "disabled",
    UPLOAD_INGRESS_MAX_CONCURRENT: "8",
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "120",
    UPLOAD_INGRESS_BURST: "16",
    UPLOAD_INGRESS_LEASE_SECONDS: "90",
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
  } as unknown as Env;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upload ingress admission", () => {
  it("fails closed for missing, malformed, or incompatible body and lease limits", () => {
    const environment = ingressEnvironment() as unknown as Record<string, unknown>;
    delete environment.UPLOAD_INGRESS_BODY_TOTAL_SECONDS;
    expect(() => uploadIngressBodyReadPolicy(environment as unknown as Env))
      .toThrowError("ADMISSION_CONFIGURATION_INVALID");

    environment.UPLOAD_INGRESS_BODY_TOTAL_SECONDS = "60.5";
    expect(() => uploadIngressBodyReadPolicy(environment as unknown as Env))
      .toThrowError("ADMISSION_CONFIGURATION_INVALID");

    environment.UPLOAD_INGRESS_BODY_TOTAL_SECONDS = "90";
    environment.UPLOAD_INGRESS_LEASE_SECONDS = "90";
    expect(() => uploadIngressBodyReadPolicy(environment as unknown as Env))
      .toThrowError("ADMISSION_CONFIGURATION_INVALID");
    expect(() => assertUploadIngressConfiguration(environment as unknown as Env))
      .toThrowError("ADMISSION_CONFIGURATION_INVALID");
  });

  it("fails closed with Retry-After when the Durable Object cannot be probed or returns an invalid admission", async () => {
    await expect(probeUploadIngressBudget(ingressEnvironment({
      probe: async () => {
        throw new Error("budget unavailable");
      },
    }))).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_INGRESS_UNAVAILABLE",
      responseHeaders: { "retry-after": "60" },
    });

    await expect(acquireUploadIngressLease(ingressEnvironment({
      acquire: async () => ({ allowed: true, leaseId: "not-a-lease", retryAfterSeconds: 0 }),
    }))).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_INGRESS_UNAVAILABLE",
      responseHeaders: { "retry-after": "60" },
    });
  });

  it("marks a request inactive when a lease renewal fails", async () => {
    vi.useFakeTimers();
    const heartbeat = startUploadIngressLeaseHeartbeat(ingressEnvironment({
      renew: async () => false,
    }), {
      leaseId: LEASE_ID,
      policy: {
        maximumConcurrent: 8,
        maximumStartsPerMinute: 120,
        burst: 16,
        leaseMilliseconds: 10_000,
      },
    });

    await vi.advanceTimersByTimeAsync(3_334);
    await expect(heartbeat.assertActive()).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_INGRESS_UNAVAILABLE",
    });
    await heartbeat.stop();
  });

  it("never renews a live request beyond the fixed ingress lifetime", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => true);
    const heartbeat = startUploadIngressLeaseHeartbeat(ingressEnvironment({ renew }), {
      leaseId: LEASE_ID,
      policy: {
        maximumConcurrent: 8,
        maximumStartsPerMinute: 120,
        burst: 16,
        leaseMilliseconds: 10_000,
      },
    });

    await vi.advanceTimersByTimeAsync(MAX_UPLOAD_INGRESS_LIFETIME_MILLISECONDS);
    await expect(heartbeat.assertActive()).rejects.toMatchObject({
      status: 503,
      code: "UPLOAD_INGRESS_UNAVAILABLE",
    });
    expect(renew).toHaveBeenCalled();
    await heartbeat.stop();
  });
});
