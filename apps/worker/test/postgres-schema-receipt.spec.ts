import { describe, expect, it } from "vitest";

import {
  POSTGRES_SCHEMA_RECEIPT_MAJOR,
  POSTGRES_SCHEMA_RECEIPT_STATUSES,
  readSchemaReceipt,
  type PostgresSchemaReceiptClient,
  type PostgresSchemaReceiptMigration,
} from "../src/postgres-schema-receipt";

// The one migration-receipt reader (OWN-19, D-CRB) over a scripted client:
// each of its four statuses, its three argument refusals (raised before any
// query) and a driver error that propagates. The lifecycle pass, the storage
// gate and RD-2 read the receipt only through it; their PostgreSQL 17 runs
// are in postgres-test/. Every value is synthetic.

const SCHEMA = "receipt_primary";
const HISTORY = `"${SCHEMA}"."_tibotattle_migration_history"`;
const MANIFEST: readonly PostgresSchemaReceiptMigration[] = Object.freeze([
  Object.freeze({ version: 1, name: "0001_synthetic_base.sql", sha256: "a".repeat(64) }),
  Object.freeze({ version: 2, name: "0002_synthetic_next.sql", sha256: "b".repeat(64) }),
]);

interface Script {
  readonly serverVersionNum?: unknown;
  readonly schemaExists?: unknown;
  readonly history?: unknown;
  readonly rows?: readonly unknown[];
  readonly fail?: Error;
}

function historyRows(manifest: readonly PostgresSchemaReceiptMigration[]): unknown[] {
  return manifest.map((entry) => ({ version: entry.version, name: entry.name, checksum_sha256: entry.sha256 }));
}

function scripted(script: Script = {}): {
  readonly client: PostgresSchemaReceiptClient;
  readonly queries: { readonly text: string; readonly values: readonly unknown[] | undefined }[];
} {
  const queries: { text: string; values: readonly unknown[] | undefined }[] = [];
  const client: PostgresSchemaReceiptClient = {
    async query(text, values) {
      queries.push({ text, values });
      if (script.fail !== undefined) throw script.fail;
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [{
            server_version_num: "serverVersionNum" in script ? script.serverVersionNum : 170_004,
            schema_exists: "schemaExists" in script ? script.schemaExists : true,
            history: "history" in script ? script.history : HISTORY,
          }],
        };
      }
      if (text.startsWith("SELECT version, name, checksum_sha256")) {
        return { rows: script.rows ?? historyRows(MANIFEST) };
      }
      throw new Error("unexpected statement");
    },
  };
  return { client, queries };
}

async function refusal(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected a refusal");
}

describe("readSchemaReceipt", () => {
  it("names exactly four statuses and requires PostgreSQL 17", () => {
    expect([...POSTGRES_SCHEMA_RECEIPT_STATUSES]).toEqual([
      "current", "unsupported_postgres_version", "schema_missing", "receipt_mismatch",
    ]);
    expect(POSTGRES_SCHEMA_RECEIPT_MAJOR).toBe(17);
  });

  it("is current only for the exact manifest, read in version order from the schema's history", async () => {
    const { client, queries } = scripted();
    await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST })).resolves.toBe("current");
    expect(queries).toHaveLength(2);
    expect(queries[0]?.values).toEqual([SCHEMA, HISTORY]);
    expect(queries[1]?.text).toBe(`SELECT version, name, checksum_sha256 FROM ${HISTORY} ORDER BY version`);
  });

  it("refuses any major version but 17 before it reads the history", async () => {
    for (const serverVersionNum of [160_004, 160_000, 180_000, 90_624, null, "PostgreSQL 17", Number.NaN]) {
      const { client, queries } = scripted({ serverVersionNum });
      await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST }),
        String(serverVersionNum)).resolves.toBe("unsupported_postgres_version");
      expect(queries, String(serverVersionNum)).toHaveLength(1);
    }
    // A string the driver might return for an integer still names version 17.
    const text = scripted({ serverVersionNum: "170004" });
    expect(await readSchemaReceipt(text.client, { schema: SCHEMA, expected: MANIFEST })).toBe("current");
  });

  it("reports a missing schema, and a missing history table as a mismatch, without reading a history", async () => {
    for (const schemaExists of [false, null, "t", 1]) {
      const { client, queries } = scripted({ schemaExists });
      await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST }), String(schemaExists))
        .resolves.toBe("schema_missing");
      expect(queries).toHaveLength(1);
    }
    for (const history of [null, undefined, 0]) {
      const { client, queries } = scripted({ history });
      await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST }), String(history))
        .resolves.toBe("receipt_mismatch");
      expect(queries).toHaveLength(1);
    }
  });

  it("reports an older, newer, drifted or reordered history as a mismatch", async () => {
    const rows = historyRows(MANIFEST) as { version: unknown; name: unknown; checksum_sha256: unknown }[];
    for (const [label, history] of [
      ["empty", []],
      ["older", rows.slice(0, 1)],
      ["newer", [...rows, { version: 3, name: "0003_synthetic_later.sql", checksum_sha256: "c".repeat(64) }]],
      ["drifted checksum", [rows[0], { ...rows[1], checksum_sha256: "0".repeat(64) }]],
      ["drifted name", [rows[0], { ...rows[1], name: "0002_synthetic_renamed.sql" }]],
      ["reordered", [rows[1], rows[0]]],
      ["a version as text", [{ ...rows[0], version: "1" }, rows[1]]],
    ] as const) {
      const { client } = scripted({ rows: history });
      await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST }), label)
        .resolves.toBe("receipt_mismatch");
    }
  });

  it("refuses a malformed schema, manifest or client before any query, in that order", async () => {
    for (const schema of ["", "Receipt", "pg_catalog", "pg_receipt", "information_schema", "receipt-primary",
      "receipt\"primary", "1receipt", "a".repeat(64), undefined, 7]) {
      const { client, queries } = scripted();
      expect(await refusal(() => readSchemaReceipt(client, { schema, expected: MANIFEST } as never)), String(schema))
        .toBe("POSTGRES_SCHEMA_RECEIPT_SCHEMA_INVALID");
      expect(queries).toHaveLength(0);
    }
    for (const [label, expected] of [
      ["empty", []],
      ["not an array", { 0: MANIFEST[0] }],
      ["a gap", [MANIFEST[0], { ...MANIFEST[1], version: 3 }]],
      ["starts at 0", [{ ...MANIFEST[0], version: 0 }]],
      ["a bad name", [{ ...MANIFEST[0], name: "0001_Synthetic.sql" }]],
      ["a bad checksum", [{ ...MANIFEST[0], sha256: "A".repeat(64) }]],
      ["a short checksum", [{ ...MANIFEST[0], sha256: "a".repeat(63) }]],
      ["a null entry", [null]],
    ] as const) {
      const { client, queries } = scripted();
      expect(await refusal(() => readSchemaReceipt(client, { schema: SCHEMA, expected } as never)), label)
        .toBe("POSTGRES_SCHEMA_RECEIPT_MANIFEST_INVALID");
      expect(queries).toHaveLength(0);
    }
    for (const client of [null, undefined, {}, { query: "SELECT 1" }, "client"]) {
      expect(await refusal(() => readSchemaReceipt(client as never, { schema: SCHEMA, expected: MANIFEST })),
        String(client)).toBe("POSTGRES_SCHEMA_RECEIPT_CLIENT_INVALID");
    }
    expect(await refusal(() => readSchemaReceipt(null as never, null as never)))
      .toBe("POSTGRES_SCHEMA_RECEIPT_SCHEMA_INVALID");
    expect(await refusal(() => readSchemaReceipt(null as never, { schema: SCHEMA, expected: [] })))
      .toBe("POSTGRES_SCHEMA_RECEIPT_MANIFEST_INVALID");
  });

  it("lets a driver error propagate to the caller, which owns the transaction", async () => {
    const lost = new Error("synthetic connection lost");
    const { client } = scripted({ fail: lost });
    await expect(readSchemaReceipt(client, { schema: SCHEMA, expected: MANIFEST })).rejects.toBe(lost);
  });
});
