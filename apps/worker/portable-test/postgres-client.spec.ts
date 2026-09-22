import { describe, expect, it } from "vitest";
import {
  createPostgresSchemaConfig,
  DEFAULT_POSTGRES_SCHEMA_CONFIG,
  normalizePostgresError,
  PostgresStorageError,
  quotePostgresIdentifier,
  type PostgresClient,
  type PostgresPool,
  withPostgresMutation,
  withPostgresRead,
} from "../src/postgres-client";

interface ClientFixture {
  readonly client: PostgresClient;
  readonly calls: string[];
  readonly releases: boolean[];
  failBegin?: boolean;
  failStatement?: boolean;
  failRollback?: boolean;
  failCommit?: boolean;
  failRelease?: boolean;
}

function fixture(): ClientFixture {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const state: ClientFixture = {
    calls,
    releases,
    client: {
      async query(text) {
        calls.push(text);
        if (state.failBegin && text.startsWith("BEGIN")) throw new Error("private begin detail");
        if (state.failStatement && text.startsWith("SET LOCAL")) throw new Error("private SET detail");
        if (state.failRollback && text === "ROLLBACK") throw new Error("private rollback detail");
        if (state.failCommit && text === "COMMIT") throw new Error("private commit detail");
        return { rows: [], rowCount: 0 };
      },
      async release(discard = false) {
        releases.push(discard);
        if (state.failRelease) throw new Error("private release detail");
      },
    },
  };
  return state;
}

function poolFor(fixtureValue: ClientFixture): PostgresPool {
  return { connect: async () => fixtureValue.client };
}

describe("shared PostgreSQL client boundary", () => {
  it("uses independent validated primary and ledger schema defaults", () => {
    expect(createPostgresSchemaConfig()).toEqual(DEFAULT_POSTGRES_SCHEMA_CONFIG);
    expect(createPostgresSchemaConfig({
      primarySchema: "tibotattle_test_primary",
      ledgerSchema: "tibotattle_test_ledger",
    })).toEqual({
      primarySchema: "tibotattle_test_primary",
      ledgerSchema: "tibotattle_test_ledger",
    });
    expect(() => createPostgresSchemaConfig({
      primarySchema: "tibotattle;drop",
      ledgerSchema: "tibotattle_ledger",
    })).toThrow(TypeError);
    expect(() => createPostgresSchemaConfig({
      primarySchema: "tibotattle",
      ledgerSchema: "tibotattle",
    })).toThrow(TypeError);
    expect(quotePostgresIdentifier("tibotattle_test")).toBe('"tibotattle_test"');
  });

  it("bounds read transactions and releases a known-good client once", async () => {
    const state = fixture();
    await expect(withPostgresRead(
      poolFor(state),
      async (client) => {
        const result = await client.query("SELECT 1", [1]);
        expect(result.rowCount).toBe(0);
        return "read";
      },
      {
        operation: "reader",
        statementTimeoutMilliseconds: 123,
        lockTimeoutMilliseconds: 45,
      },
    )).resolves.toBe("read");
    expect(state.calls).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout='123ms'",
      "SET LOCAL lock_timeout='45ms'",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(state.releases).toEqual([false]);
  });

  it("rolls back a failed mutation and sanitizes SQLSTATE details", async () => {
    const state = fixture();
    await expect(withPostgresMutation(
      poolFor(state),
      async () => {
        throw Object.assign(new Error("secret SQL and bind values"), { code: "40001" });
      },
      { operation: "writer" },
    )).rejects.toMatchObject({
      name: "PostgresStorageError",
      code: "conflict",
      operation: "writer",
      message: "POSTGRES_CONFLICT:writer",
    });
    expect(state.calls.at(-1)).toBe("ROLLBACK");
    expect(state.releases).toEqual([false]);
  });

  it("fails closed on BEGIN failure and discards the acquired client", async () => {
    const state = fixture();
    state.failBegin = true;
    await expect(withPostgresMutation(
      poolFor(state),
      async () => "unreachable",
      { operation: "writer" },
    )).rejects.toMatchObject({ code: "unavailable", operation: "writer.begin" });
    expect(state.calls).toEqual(["BEGIN"]);
    expect(state.releases).toEqual([true]);
  });

  it("rolls back a failed timeout setup", async () => {
    const state = fixture();
    state.failStatement = true;
    await expect(withPostgresMutation(
      poolFor(state),
      async () => "unreachable",
      { operation: "writer" },
    )).rejects.toMatchObject({ code: "unavailable", operation: "writer" });
    expect(state.calls.at(-1)).toBe("ROLLBACK");
    expect(state.releases).toEqual([false]);
  });

  it("discards after rollback failure", async () => {
    const state = fixture();
    state.failRollback = true;
    await expect(withPostgresMutation(
      poolFor(state),
      async () => { throw new Error("private callback detail"); },
      { operation: "writer" },
    )).rejects.toMatchObject({
      code: "unavailable",
      operation: "writer.rollback",
    });
    expect(state.releases).toEqual([true]);
  });

  it("does not issue rollback after uncertain commit and discards once", async () => {
    const state = fixture();
    state.failCommit = true;
    await expect(withPostgresMutation(
      poolFor(state),
      async () => "written",
      { operation: "writer" },
    )).rejects.toMatchObject({
      code: "unavailable",
      operation: "writer.commit",
    });
    expect(state.calls).not.toContain("ROLLBACK");
    expect(state.releases).toEqual([true]);
  });

  it("does not release a second time when a healthy release reports failure", async () => {
    const state = fixture();
    state.failRelease = true;
    await expect(withPostgresMutation(
      poolFor(state),
      async () => "written",
      { operation: "writer" },
    )).rejects.toMatchObject({ code: "unavailable", operation: "writer.commit" });
    expect(state.releases).toEqual([false]);
    expect(state.calls).not.toContain("ROLLBACK");
  });

  it("preserves a caller-mapped closed domain error after rollback", async () => {
    const state = fixture();
    const providerError = new Error("private provider detail");
    const domainError = new Error("SAFE_DOMAIN_ERROR");
    await expect(withPostgresMutation(
      poolFor(state),
      async () => { throw providerError; },
      {
        operation: "writer",
        preserveSafeError: (error) => error === providerError ? domainError : null,
      },
    )).rejects.toBe(domainError);
    expect(state.releases).toEqual([false]);
  });

  it("maps an arbitrary provider failure without retaining its message", () => {
    const error = normalizePostgresError(
      Object.assign(new Error("password=secret host=private"), { code: "XX000" }),
      "reader",
    );
    expect(error).toBeInstanceOf(PostgresStorageError);
    expect(error.message).toBe("POSTGRES_UNAVAILABLE:reader");
    expect(error.message).not.toContain("password");
  });

  it("does not trust a hostile SQLSTATE getter", () => {
    const error = new Error("private provider detail");
    Object.defineProperty(error, "code", {
      get() { throw new Error("getter detail"); },
    });
    expect(normalizePostgresError(error, "reader")).toMatchObject({
      code: "unavailable",
      operation: "reader",
    });
  });

  it("rejects invalid options before acquiring a client", async () => {
    let connections = 0;
    const pool: PostgresPool = {
      async connect() {
        connections += 1;
        return fixture().client;
      },
    };
    await expect(withPostgresMutation(pool, async () => "unreachable", {
      operation: "writer",
      lockTimeoutMilliseconds: 0,
    })).rejects.toThrow(TypeError);
    expect(connections).toBe(0);
  });
});
