import { ApiError } from "./errors";
import {
  type UploadIngressBudgetDecision,
  type UploadIngressBudgetPolicy,
} from "./ingress-budget";
import { assertDeferredUploadQueueIngress } from "./queue-ingress-stub";

export const UPLOAD_INGRESS_BUDGET_OBJECT_NAME = "upload-ingress-budget-v0.1";
const RETRY_AFTER_FALLBACK_SECONDS = 60;
const LEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface UploadIngressLease {
  leaseId: string;
  policy: UploadIngressBudgetPolicy;
}

export interface UploadIngressLeaseHeartbeat {
  assertActive(): Promise<void>;
  stop(): Promise<void>;
}

function configuredInteger(
  env: Env,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Reflect.get(env, name);
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return parsed;
}

function configuredPolicy(env: Env): UploadIngressBudgetPolicy {
  return {
    maximumConcurrent: configuredInteger(
      env,
      "UPLOAD_INGRESS_MAX_CONCURRENT",
      1,
      64,
    ),
    maximumStartsPerMinute: configuredInteger(
      env,
      "UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE",
      1,
      1_200,
    ),
    burst: configuredInteger(env, "UPLOAD_INGRESS_BURST", 1, 1_200),
    leaseMilliseconds: configuredInteger(
      env,
      "UPLOAD_INGRESS_LEASE_SECONDS",
      10,
      300,
    ) * 1_000,
  };
}

function configuredNamespace(env: Env): DurableObjectNamespace {
  const namespace = Reflect.get(env, "UPLOAD_INGRESS_BUDGET");
  if (!namespace || typeof namespace !== "object"
      || typeof Reflect.get(namespace, "getByName") !== "function") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  return namespace as DurableObjectNamespace;
}

function retryAfterHeader(seconds: number): HeadersInit {
  return { "retry-after": String(Math.max(1, seconds)) };
}

function unavailable(): ApiError {
  return new ApiError(503, "UPLOAD_INGRESS_UNAVAILABLE", {
    responseHeaders: retryAfterHeader(RETRY_AFTER_FALLBACK_SECONDS),
  });
}

function configuredBudgetStub(env: Env): {
  acquire: (policy: UploadIngressBudgetPolicy) => Promise<UploadIngressBudgetDecision>;
  probe: (policy: UploadIngressBudgetPolicy) => Promise<boolean>;
  release: (leaseId: string) => Promise<void>;
  renew: (leaseId: string, policy: UploadIngressBudgetPolicy) => Promise<boolean>;
} {
  return configuredNamespace(env).getByName(
    UPLOAD_INGRESS_BUDGET_OBJECT_NAME,
  ) as unknown as {
    acquire: (policy: UploadIngressBudgetPolicy) => Promise<UploadIngressBudgetDecision>;
    probe: (policy: UploadIngressBudgetPolicy) => Promise<boolean>;
    release: (leaseId: string) => Promise<void>;
    renew: (leaseId: string, policy: UploadIngressBudgetPolicy) => Promise<boolean>;
  };
}

function validDecision(value: unknown): value is UploadIngressBudgetDecision {
  return value !== null
    && typeof value === "object"
    && typeof Reflect.get(value, "allowed") === "boolean"
    && typeof Reflect.get(value, "retryAfterSeconds") === "number"
    && Number.isSafeInteger(Reflect.get(value, "retryAfterSeconds"))
    && (Reflect.get(value, "retryAfterSeconds") as number) >= 0
    && (Reflect.get(value, "retryAfterSeconds") as number) <= 300
    && (Reflect.get(value, "allowed") === false
      ? Reflect.get(value, "leaseId") === null
      : typeof Reflect.get(value, "leaseId") === "string"
        && LEASE_ID.test(Reflect.get(value, "leaseId") as string));
}

export function assertUploadIngressConfiguration(env: Env): void {
  configuredNamespace(env);
  configuredPolicy(env);
  assertDeferredUploadQueueIngress(env);
}

export async function acquireUploadIngressLease(env: Env): Promise<UploadIngressLease> {
  assertUploadIngressConfiguration(env);
  const policy = configuredPolicy(env);
  let decision: UploadIngressBudgetDecision;
  try {
    decision = await configuredBudgetStub(env).acquire(policy);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
  if (!validDecision(decision)) {
    throw unavailable();
  }
  if (!decision.allowed) {
    throw new ApiError(429, "UPLOAD_INGRESS_LIMIT_REACHED", {
      responseHeaders: retryAfterHeader(decision.retryAfterSeconds),
    });
  }
  if (decision.leaseId === null) {
    throw unavailable();
  }
  return { leaseId: decision.leaseId, policy };
}

export async function probeUploadIngressBudget(env: Env): Promise<void> {
  assertUploadIngressConfiguration(env);
  try {
    if (await configuredBudgetStub(env).probe(configuredPolicy(env)) !== true) {
      throw unavailable();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

export async function renewUploadIngressLease(
  env: Env,
  lease: UploadIngressLease,
): Promise<boolean> {
  if (!lease || !LEASE_ID.test(lease.leaseId)) return false;
  try {
    return await configuredBudgetStub(env).renew(lease.leaseId, lease.policy) === true;
  } catch {
    return false;
  }
}

export function startUploadIngressLeaseHeartbeat(
  env: Env,
  lease: UploadIngressLease,
): UploadIngressLeaseHeartbeat {
  let active = true;
  let renewal: Promise<void> = Promise.resolve();
  const intervalMilliseconds = Math.max(
    1_000,
    Math.floor(lease.policy.leaseMilliseconds / 3),
  );
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!active || !await renewUploadIngressLease(env, lease)) {
        active = false;
      }
    }, () => {
      active = false;
    });
  }, intervalMilliseconds);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    async assertActive(): Promise<void> {
      await renewal;
      if (!active) throw unavailable();
    },
    async stop(): Promise<void> {
      clearInterval(timer);
      await renewal;
    },
  };
}

export async function releaseUploadIngressLease(
  env: Env,
  lease: UploadIngressLease,
): Promise<void> {
  if (!lease || !LEASE_ID.test(lease.leaseId)) return;
  await configuredBudgetStub(env).release(lease.leaseId);
}
