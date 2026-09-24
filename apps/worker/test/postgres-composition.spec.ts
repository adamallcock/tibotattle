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

  it("validates two explicit pools without claiming current Worker readiness", () => {
    const backend = createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: pool(),
    });

    expect(backend.provider).toBe("postgres");
    expect(backend.applicationReady).toBe(false);
    expect(backend.schemas).toEqual({
      primary: "tibotattle",
      ledger: "tibotattle_ledger",
    });
    expect(backend.unsupportedContracts).toEqual(POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS);
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: pool(),
      schemaOptions: { primarySchema: "pg_catalog" },
    })).toThrow("invalid PostgreSQL schema configuration");
  });

  it("does not route an injected PostgreSQL foundation through a D1 request handler", async () => {
    const backend = createPostgresWorkerBackend({ primaryPool: pool(), ledgerPool: pool() });
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
