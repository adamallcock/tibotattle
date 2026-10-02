import { describe, expect, it } from "vitest";

import {
  createPostgresWorkerBackend,
  POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS,
} from "../src/backend-composition";
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
