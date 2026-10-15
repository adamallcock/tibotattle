import { ApiError } from "./errors";
import type { UploadIngressBudgetPolicy } from "./ingress-budget";

const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function unavailable(): ApiError {
  return new ApiError(503, "ADMISSION_RATE_LIMIT_UNAVAILABLE", {
    responseHeaders: { "retry-after": "60" },
  });
}

/** Bounded acquisition/release; the configured finite lease covers a lost Worker. */
export async function acquireOperationalLease(
  env: Env, objectName: string, policy: Readonly<UploadIngressBudgetPolicy>,
): Promise<() => Promise<void>> {
  const namespace = env.UPLOAD_INGRESS_BUDGET;
  if (!namespace || typeof namespace.getByName !== "function") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  let stub: ReturnType<typeof namespace.getByName>;
  try {
    stub = namespace.getByName(objectName);
  } catch {
    throw unavailable();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const acquisition = Promise.resolve().then(() => stub.acquire(policy));
  // A late response must not leak a slot. A failed release still expires after
  // the policy TTL, and no work starts until a timely acquisition completes.
  void acquisition.then(async (decision) => {
    if (expired && decision?.allowed === true && typeof decision.leaseId === "string"
        && LEASE_ID.test(decision.leaseId)) await stub.release(decision.leaseId);
  }).catch(() => {});
  try {
    const decision = await Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(unavailable()); }, 1_000);
      }),
    ]);
    if (!decision || typeof decision.allowed !== "boolean"
        || !Number.isSafeInteger(decision.retryAfterSeconds)
        || decision.retryAfterSeconds < 0 || decision.retryAfterSeconds > 300
        || (decision.allowed
          ? typeof decision.leaseId !== "string" || !LEASE_ID.test(decision.leaseId)
          : decision.leaseId !== null)) throw unavailable();
    if (!decision.allowed || decision.leaseId === null) {
      throw new ApiError(429, "ATTEMPT_LIMIT_REACHED", {
        responseHeaders: { "retry-after": String(Math.max(1, decision.retryAfterSeconds)) },
      });
    }
    const leaseId = decision.leaseId;
    return async () => {
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stub.release(leaseId),
          new Promise<void>((resolve) => { releaseTimer = setTimeout(resolve, 1_000); }),
        ]);
      } catch {
        // Keep the primary request outcome. The finite lease is the fallback
        // for a failed RPC or a Worker terminated before finally can run.
      } finally {
        if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      }
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
