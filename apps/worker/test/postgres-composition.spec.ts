import { describe, expect, it } from "vitest";

import {
  createPostgresWorkerBackend,
  POSTGRES_ADMIN_HOST_ROUTE_IDS,
  POSTGRES_PORTED_WORKER_ROUTE_IDS,
  POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS,
} from "../src/backend-composition";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import {
  handleRequest,
  isPostgresWorkerRequestPathSupported,
} from "../src/index";
import {
  setTimingSafeEqualImplementation,
  timingSafeEqual,
} from "../src/crypto";
import type { PostgresPool } from "../src/postgres-client";

function pool(): PostgresPool {
  return {
    async connect() {
      throw new Error("composition must not open a PostgreSQL connection");
    },
  };
}

describe("PostgreSQL migration foundation", () => {
  it("compares equal-length inputs and rejects mismatches", () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
  });

  it("validates one explicit primary pool without claiming current Worker readiness", () => {
    const primaryPool = pool();
    const backend = createPostgresWorkerBackend({ primaryPool });

    expect(backend.provider).toBe("postgres");
    expect(backend.applicationReady).toBe(false);
    expect(backend.schemas).toEqual({ primary: "tibotattle" });
    expect(backend.pools).toEqual({ primary: primaryPool });
    expect(Object.keys(backend.pools)).toEqual(["primary"]);
    expect(backend.unsupportedContracts).toEqual(POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS);
    expect(createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "tibotattle_isolated" },
    }).schemas).toEqual({ primary: "tibotattle_isolated" });
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "pg_catalog" },
    })).toThrow("invalid PostgreSQL schema configuration");
  });

  it("refuses the retired deletion-ledger pool and schema options", () => {
    // A stale caller fails closed rather than having either option ignored.
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: pool(),
    } as unknown as Parameters<typeof createPostgresWorkerBackend>[0])).toThrow("POSTGRES_LEDGER_POOL_RETIRED");
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: undefined,
    } as unknown as Parameters<typeof createPostgresWorkerBackend>[0])).toThrow("POSTGRES_LEDGER_POOL_RETIRED");
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "tibotattle", ledgerSchema: "tibotattle_ledger" } as never,
    })).toThrow("invalid PostgreSQL schema configuration");
    expect(() => createPostgresWorkerBackend({ ledgerPool: pool() } as never)).toThrow("POSTGRES_POOL_INVALID");
  });

  it("does not route an injected PostgreSQL foundation through a D1 request handler", async () => {
    const backend = createPostgresWorkerBackend({ primaryPool: pool() });
    const response = await handleRequest(
      new Request("https://worker.test/api/v1/community/daily"),
      { POSTGRES_WORKER_BACKEND: backend } as unknown as Env,
      false,
    );

    expect(isPostgresWorkerRequestPathSupported()).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "POSTGRES_REQUEST_PATH_UNSUPPORTED" },
    });
  });

  it("names the origin's ported pathnames and keeps the zero-argument call false", () => {
    // OD-CR-1: the 21 scope routes plus all nine contested ones; OD-CR-2: the
    // six admin routes are admin-host only and the other 13 stay unported.
    expect(POSTGRES_PORTED_WORKER_ROUTE_IDS).toHaveLength(30);
    expect(Object.isFrozen(POSTGRES_PORTED_WORKER_ROUTE_IDS)).toBe(true);
    expect(POSTGRES_ADMIN_HOST_ROUTE_IDS).toEqual([
      "admin_overview", "admin_metrics_history", "admin_community_allowance_preview",
      "admin_database_health", "admin_reconstruction_progress", "admin_action",
    ]);
    const policyOrder = WORKER_ROUTE_POLICY.map((route) => route.id)
      .filter((id) => (POSTGRES_PORTED_WORKER_ROUTE_IDS as readonly string[]).includes(id));
    expect(policyOrder).toEqual([...POSTGRES_PORTED_WORKER_ROUTE_IDS]);
    expect(isPostgresWorkerRequestPathSupported("/api/v1/contributions")).toBe(true);
    expect(isPostgresWorkerRequestPathSupported("/api/ready")).toBe(true);
    expect(isPostgresWorkerRequestPathSupported("/api/v1/device/credential/renew")).toBe(true);
    for (const pathname of [
      "/api/v1/me/export",
      "/api/v1/admin/overview",
      "/.well-known/apple-developer-domain-association.txt",
      "/api/v1/me/telemetry-v12/effective-page",
      "/api/v1/enroll",
      "/api/v1/identity/google/start",
      "/api/v1/contributions/",
      "/api/v1/nope",
    ]) {
      expect(isPostgresWorkerRequestPathSupported(pathname)).toBe(false);
    }
    expect(isPostgresWorkerRequestPathSupported(undefined)).toBe(false);
    expect(isPostgresWorkerRequestPathSupported(["/api/ready"])).toBe(false);
    expect(isPostgresWorkerRequestPathSupported()).toBe(false);
  });

  it("lets a host install native timing-safe comparison without changing mismatch behavior", () => {
    const observed: Array<readonly [number, number[]]> = [];
    const restore = setTimingSafeEqualImplementation((left, right) => {
      observed.push([left.byteLength, Array.from(right)]);
      let difference = 0;
      for (let index = 0; index < left.byteLength; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      }
      return difference === 0;
    });
    try {
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
      expect(observed).toEqual([
        [2, [1, 2]],
        [2, [1, 3]],
        [2, [0, 0]],
      ]);
    } finally {
      restore();
    }
  });
});
