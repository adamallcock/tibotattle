import { describe, expect, it } from "vitest";
import {
  withPostgresMutation, withPostgresRead, withPostgresTransaction,
  type PostgresPool, type PostgresTransactionOptions,
} from "../src/postgres-client";
import { AnalyticsV2SourceError, withAnalyticsV2ReadSnapshot } from "../src/analytics-v2/owners";

function scriptedPool() {
  const sent: string[] = [];
  const released: (boolean | undefined)[] = [];
  let connected = 0;
  const client = {
    async query(text: string) {
      sent.push(text);
      return { rows: text.includes("transaction_read_only") ? [{ read_only: "on" }] : [], rowCount: 0 };
    },
    release(discard?: boolean) { released.push(discard); },
  };
  const pool = { async connect() { connected += 1; return client; } } as unknown as PostgresPool;
  return { pool, sent, released, connected: () => connected };
}

describe("analytics read transaction timeout policy", () => {
  it("admits one hour only for the exact read-only analytics operation", async () => {
    for (const milliseconds of [600_000, 600_001, 3_600_000]) {
      const script = scriptedPool();
      await withPostgresRead(script.pool, async () => 1,
        { operation: "analytics_v2.read", statementTimeoutMilliseconds: milliseconds });
      expect(script.sent).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        `SET LOCAL statement_timeout='${milliseconds}ms'`, "SET LOCAL lock_timeout='5000ms'", "COMMIT"]);
      expect(script.released).toEqual([false]);
    }
  });

  it("refuses out-of-scope or malformed larger bounds before connecting", async () => {
    const invalid: PostgresTransactionOptions[] = [
      { readOnly: true, operation: "analytics_v2.read", statementTimeoutMilliseconds: 3_600_001 },
      { readOnly: false, operation: "analytics_v2.read", statementTimeoutMilliseconds: 600_001 },
      { operation: "analytics_v2.read", statementTimeoutMilliseconds: 600_001 },
      { readOnly: true, operation: "other.read", statementTimeoutMilliseconds: 600_001 },
      { readOnly: true, operation: "ANALYTICS_V2.READ", statementTimeoutMilliseconds: 600_001 },
      { readOnly: true, operation: "analytics_v2.read ", statementTimeoutMilliseconds: 600_001 },
      { readOnly: 1 as unknown as boolean, operation: "analytics_v2.read", statementTimeoutMilliseconds: 600_001 },
      { readOnly: true, operation: "analytics_v2.read", lockTimeoutMilliseconds: 600_001 },
      ...[0, -1, NaN, Infinity, 1.5].map((statementTimeoutMilliseconds) =>
        ({ readOnly: true, operation: "analytics_v2.read", statementTimeoutMilliseconds })),
    ];
    for (const options of invalid) {
      const script = scriptedPool();
      await expect(withPostgresTransaction(script.pool, async () => 1, options)).rejects.toThrow(TypeError);
      expect(script.connected()).toBe(0);
    }
    const script = scriptedPool();
    await expect(withPostgresMutation(script.pool, async () => 1,
      { operation: "analytics_v2.read", statementTimeoutMilliseconds: 600_001 })).rejects.toThrow(TypeError);
    expect(script.connected()).toBe(0);
  });

  it("keeps defaults and the ordinary read/write and lock ceilings", async () => {
    for (const read of [true, false]) {
      const execute = read ? withPostgresRead : withPostgresMutation;
      const script = scriptedPool();
      await execute(script.pool, async () => 1, { operation: "analytics_v2.read" });
      expect(script.sent.slice(1, 3)).toEqual(["SET LOCAL statement_timeout='10000ms'", "SET LOCAL lock_timeout='5000ms'"]);
      const bounded = scriptedPool();
      await execute(bounded.pool, async () => 1,
        { operation: "other", statementTimeoutMilliseconds: 600_000, lockTimeoutMilliseconds: 600_000 });
      expect(bounded.sent.slice(1, 3)).toEqual(["SET LOCAL statement_timeout='600000ms'", "SET LOCAL lock_timeout='600000ms'"]);
    }
  });
});

const PRIVATE = "synthetic-private-message SQL SELECT secret /private/synthetic/session token";
async function failRead(upstream: unknown) {
  const script = scriptedPool();
  const error = await withAnalyticsV2ReadSnapshot({ pool: script.pool, schema: "synthetic", nowMs: 0 },
    async () => { throw upstream; }).catch((failure: Error) => failure);
  expect(script.sent.slice(0, 3)).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout='3600000ms'", "SET LOCAL lock_timeout='5000ms'"]);
  expect(script.sent.at(-1)).toBe("ROLLBACK");
  expect(script.sent).not.toContain("COMMIT");
  expect(script.released).toEqual([false]);
  return error;
}

describe("content-free analytics read timeout failures", () => {
  it.each([['57014', 'STATEMENT'], ['55P03', 'LOCK']])("preserves %s safely before normalization", async (sqlState, reason) => {
    for (const field of ["code", "sqlState"]) {
      const upstream = Object.assign(new Error(PRIVATE), { [field]: sqlState, detail: PRIVATE,
        hint: PRIVATE, where: PRIVATE, query: PRIVATE, values: [PRIVATE], cause: new Error(PRIVATE) });
      upstream.stack = PRIVATE;
      const error = await failRead(upstream);
      expect(error).toMatchObject({ code: `ANALYTICS_V2_READ_${reason}_TIMEOUT`, sqlState,
        message: `ANALYTICS_V2_READ_${reason}_TIMEOUT` });
      expect(Object.keys(error).sort()).toEqual(["code", "name", "sqlState"]);
      expect(JSON.stringify(error)).not.toContain(PRIVATE);
      expect(String(error.stack)).not.toContain(PRIVATE);
      expect(error.cause).toBeUndefined();
      expect(error).not.toBe(upstream);
      expect(error.code).not.toMatch(/^ANALYTICS_V2_SOURCE_/u);
    }
  });

  it("keeps source refusals intact and other driver failures fatal and sanitized", async () => {
    const source = new AnalyticsV2SourceError("ANALYTICS_V2_SOURCE_CONFLICT");
    expect(await failRead(source)).toBe(source);
    for (const code of ["ECONNRESET", "42501", "57014-private", "55P03-private"]) {
      const error = await failRead(Object.assign(new Error(PRIVATE), { code }));
      expect(error).toMatchObject({ code: "unavailable", operation: "analytics_v2.read" });
      expect(JSON.stringify(error)).not.toContain(PRIVATE);
      expect(error.sqlState).toBeUndefined();
      expect(error.cause).toBeUndefined();
    }
    const hostile = Object.defineProperty({}, "code", { get() { throw new Error(PRIVATE); } });
    expect(await failRead(hostile)).toMatchObject({ code: "unavailable" });
  });
});
