import { ApiError } from "./errors";
import { acquireOperationalLease } from "./operational-lease";

export const PUBLIC_PROBE_MAXIMUM_MILLISECONDS = 15_000;
export const PUBLIC_PROBE_BUDGET_POLICY = Object.freeze({
  maximumConcurrent: 2,
  maximumStartsPerMinute: 60,
  burst: 2,
  leaseMilliseconds: 30_000,
});

export function publicProbeBudgetObjectName(route: "health" | "ready"): string {
  return `public-probe-${route}-budget-v1`;
}

function unavailable(): ApiError {
  return new ApiError(503, "ADMISSION_RATE_LIMIT_UNAVAILABLE", {
    responseHeaders: { "retry-after": "60" },
  });
}

/**
 * Bound simultaneous probe chains across edge locations. A timed-out backend
 * call cannot start later probes: callers fence each awaited group with
 * assertActive. Retain the slot until that chain settles (or its finite lease
 * expires after Worker loss), rather than releasing while work is still live.
 */
export async function runPublicProbe<T>(
  env: Env,
  route: "health" | "ready",
  operation: (assertActive: () => void) => Promise<T>,
): Promise<T> {
  const release = await acquireOperationalLease(env, publicProbeBudgetObjectName(route), PUBLIC_PROBE_BUDGET_POLICY);
  const deadline = Date.now() + PUBLIC_PROBE_MAXIMUM_MILLISECONDS;
  const assertActive = () => { if (Date.now() >= deadline) throw unavailable(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(() => operation(assertActive))
    .then((result) => { assertActive(); return result; }).finally(release);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), PUBLIC_PROBE_MAXIMUM_MILLISECONDS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
