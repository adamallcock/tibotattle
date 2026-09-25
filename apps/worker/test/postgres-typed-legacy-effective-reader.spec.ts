import { describe, expect, it, vi } from "vitest";
import {
  finalizePostgresTypedLegacyFamilyReceipts,
  listPostgresEffectiveOwners,
  readPostgresEffectiveHistoryPage,
} from "../src/postgres-typed-legacy-effective-reader";
import type { PostgresPool } from "../src/postgres-client";

describe("PostgreSQL typed v1/v1.1 effective source gates", () => {
  it("rejects partial or malformed receipt finalization before opening a connection", async () => {
    const connect = vi.fn(async () => {
      throw new Error("must not connect for invalid receipt input");
    });
    const pool = { connect } as unknown as PostgresPool;
    const receipt = {
      sourceFormat: 10 as const,
      generation: 1,
      sourceDigest: "a".repeat(64),
      sourceRowCount: 0,
      membershipRowCount: 0,
    };

    await expect(finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId: "synthetic-source",
      sourceNamespace: "synthetic-namespace",
      receipts: [receipt],
    })).rejects.toMatchObject({
      code: "POSTGRES_LEGACY_EFFECTIVE_INVALID",
    });
    await expect(finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId: "synthetic-source",
      sourceNamespace: "synthetic-namespace",
      receipts: [receipt, { ...receipt, sourceFormat: 11, sourceDigest: "not-a-sha256" }],
    })).rejects.toMatchObject({
      code: "POSTGRES_LEGACY_EFFECTIVE_INVALID",
    });
    await expect(readPostgresEffectiveHistoryPage(pool, {
      sourceId: "synthetic-source",
      sourceNamespace: "synthetic-namespace",
      ownerDigest: "b".repeat(64),
      day: "2026-09-24",
      stream: "session",
      sourceFetchBatchSize: 513,
    })).rejects.toMatchObject({ code: "POSTGRES_LEGACY_EFFECTIVE_INVALID" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps typed legacy owner reads closed until the admission transfer receipt matches both base generations", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        statements.push(text);
        if (text.includes("FROM pg_class relation")) {
          const names = values[1] as string[];
          return { rows: names.map((name) => ({ name })), rowCount: names.length };
        }
        if (text.includes("FROM \"tibotattle\".\"storage_source_state\" source")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPool;

    await expect(listPostgresEffectiveOwners(pool, {
      sourceId: "synthetic-source",
      sourceNamespace: "synthetic-namespace",
    })).rejects.toMatchObject({ code: "POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE" });

    const sourcePinQuery = statements.find((text) => text.includes("storage_source_state\" source"));
    expect(sourcePinQuery).toContain("typed_telemetry_admission_transfer_receipts");
    expect(sourcePinQuery).toContain("v1_base_generation=v1.generation");
    expect(sourcePinQuery).toContain("v11_base_generation=v11.generation");
  });
});
