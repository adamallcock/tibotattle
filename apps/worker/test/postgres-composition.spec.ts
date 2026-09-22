import { describe, expect, it } from "vitest";

import worker, {
  handleRequest,
  runScheduledMaintenance,
} from "../src/index";
import {
  createPostgresWorkerBackend,
  noD1QualifiedRouteIds,
  POSTGRES_ROUTE_COVERAGE,
  readWorkerBackend,
} from "../src/backend-composition";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";

function throwingD1Environment() {
  const unavailable = () => {
    throw new Error("D1 must not be touched by this no-D1 check");
  };
  return new Proxy({}, {
    get(target, property) {
      if (property === "DEPLOYMENT_SOURCE_COMMIT") return undefined;
      return unavailable;
    },
  }) as unknown as Env;
}

function fakePool() {
  return {
    connect() {
      throw new Error("database access is outside composition construction");
    },
  };
}

describe("PostgreSQL application composition boundary", () => {
  it("composes one primary and one ledger schema without opening a connection", () => {
    const backend = createPostgresWorkerBackend({
      primaryPool: fakePool(),
      ledgerPool: fakePool(),
    });

    expect(backend.provider).toBe("postgres");
    expect(backend.schemas).toEqual({
      primary: "tibotattle",
      ledger: "tibotattle_ledger",
    });
    expect(backend.authority).toHaveProperty("sessions");
    expect(backend.identity).toHaveProperty("apple");
    expect(backend.telemetryV1).toHaveProperty("contributions");
    expect(backend.storage).toEqual(expect.objectContaining({
      preparedSource: expect.any(Object),
      analyticalWork: expect.any(Object),
      publication: expect.any(Object),
      admin: expect.any(Object),
      lifecycle: expect.any(Object),
      analyticsDelivery: expect.any(Object),
      ownerRouter: expect.any(Object),
    }));
    expect(backend.releaseNonce).toHaveProperty("consume");
  });

  it("rejects partial host injection and inventories every exact route", () => {
    expect(() => readWorkerBackend({ POSTGRES_WORKER_BACKEND: { provider: "postgres" } }))
      .toThrow("POSTGRES_BACKEND_INVALID");
    expect(Object.keys(POSTGRES_ROUTE_COVERAGE).sort()).toEqual(
      WORKER_ROUTE_POLICY.map((route) => route.id).sort(),
    );
    expect(noD1QualifiedRouteIds()).toEqual([
      "apple_domain_association",
      "session",
      "logout",
      "device_sync_state",
      "device_sync_manifest",
    ]);
    for (const route of WORKER_ROUTE_POLICY) {
      expect(POSTGRES_ROUTE_COVERAGE[route.id], route.id).toMatch(
        /^(storage_free|barrier_only|postgres_composed|postgres_partial|d1_legacy)$/u,
      );
    }
  });

  it("runs the real fetch and scheduled entry functions on storage-free/barrier paths without D1", async () => {
    const env = throwingD1Environment();
    const retired = await worker.fetch(
      new Request("https://worker.test/.well-known/apple-developer-domain-association.txt"),
      env,
    );
    expect(retired.status).toBe(404);

    const health = await handleRequest(
      new Request("https://worker.test/api/health"),
      env,
      true,
    );
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      status: "unavailable",
      mode: "migration-mutation-barrier",
    });

    const invalidEnv = {
      POSTGRES_WORKER_BACKEND: { provider: "postgres" },
    } as unknown as Env;
    const invalid = await handleRequest(
      new Request("https://worker.test/api/v1/envelope-key"),
      invalidEnv,
      false,
    );
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({
      error: { code: "POSTGRES_BACKEND_INVALID" },
    });

    const maintenance = await runScheduledMaintenance(env, Date.now(), true);
    expect(maintenance).toMatchObject({
      outcome: "skipped",
      code: "MUTATION_BARRIER_ACTIVE",
    });
  });
});
