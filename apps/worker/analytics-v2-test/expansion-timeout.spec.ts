import { describe, expect, it } from "vitest";
import { readOwnerDayFingerprints, readOwnerOccurrences } from "../src/analytics-v2/occurrence-source";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import type { PostgresClient, PostgresPool } from "../src/postgres-client";

const ownerDigest = "a".repeat(64);
const options = { ownerDigest, stream: "usage" as const, fromDay: "2026-10-01", throughDay: "2026-10-01" };
const privateMessage = "synthetic-private SQL SELECT secret /private/synthetic/session";

function expansionScript(family: string, failure: unknown) {
  const sent: string[] = [];
  const attempts: number[] = [];
  const client = {
    async query(statement: string | { text: string; values?: unknown[] }, parameters?: unknown[]) {
      const sql = typeof statement === "string" ? statement : statement.text;
      const binds = typeof statement === "string" ? parameters : statement.values;
      sent.push(sql);
      if (sql.includes("transaction_read_only")) return { rows: [{ read_only: "on" }] };
      if (sql.includes("occurrences.scope")) return { rows: [{ participant_id: "synthetic-participant",
        v1_namespace: "synthetic-namespace", v11_namespace: null, correction_present: true,
        correction_active: true, correction_facts_present: true, v12_ready_manifests: true,
        legacy_owner_index_ready: false, v12_state: "active", v12_generation_id: "synthetic-generation" }] };
      if (sql.includes("occurrences.legacy_candidates")) return { rows: Array.from({ length: 201 }, (_, index) => ({
        occurrence_id: encodeTypedTelemetryId(`synthetic-occurrence:${index.toString().padStart(4, "0")}`),
        observed_day: 20727, observed_at_ms: Date.UTC(2026, 9, 1),
      })) };
      if (sql.includes("current_setting('plan_cache_mode')")) return { rows: [{ previous: "auto",
        previous_jit: "off", previous_work_mem: "4MB" }] };
      if (sql.includes(`occurrences.${family}`)) {
        attempts.push((binds?.[family === "legacy_sources" ? 4 : family === "v12_sources" ? 3 : 1] as unknown[]).length);
        throw failure;
      }
      return { rows: [] };
    },
    release() {},
  } as unknown as PostgresClient;
  const pool = { async connect() { return client; } } as PostgresPool;
  return { client, pool, sent, attempts };
}

describe("grouped occurrence expansion operational failures", () => {
  for (const family of ["legacy_sources", "v12_sources", "correction_sources"]) {
    it.each([
      ["57014", "canceling statement due to user request"],
      ["57014", "canceling statement due to statement timeout"],
      ["57014", privateMessage],
      ["55P03", "canceling statement due to lock timeout"],
    ])(`${family}: %s escapes without granular retry`, async (code, message) => {
      const failure = Object.assign(new Error(message), { code });
      const script = expansionScript(family, failure);
      await expect(readOwnerOccurrences({ ...script, schema: "synthetic", nowMs: 0 }, options)).rejects.toBe(failure);
      expect(script.attempts).toEqual([201]);
      expect(script.sent.filter((sql) => sql.includes("SAVEPOINT analytics_v2_expansion"))
        .map((sql) => sql.slice(sql.indexOf("*/") + 2).trim())).toEqual([
          "SAVEPOINT analytics_v2_expansion", "ROLLBACK TO SAVEPOINT analytics_v2_expansion",
          "RELEASE SAVEPOINT analytics_v2_expansion",
        ]);
    });
  }

  it.each([["57014", "STATEMENT"], ["55P03", "LOCK"]])("preserves the closed %s read failure and rolls back without writes", async (code, reason) => {
    const script = expansionScript("legacy_sources", Object.assign(new Error(privateMessage), { code,
      query: privateMessage, detail: privateMessage, values: [privateMessage] }));
    const error = await readOwnerOccurrences({ pool: script.pool, schema: "synthetic", nowMs: 0 }, options)
      .catch((error: Error) => error);
    expect(error).toMatchObject({ code: `ANALYTICS_V2_READ_${reason}_TIMEOUT`, sqlState: code });
    expect(JSON.stringify(error)).not.toContain(privateMessage);
    expect(Object.keys(error).sort()).toEqual(["code", "name", "sqlState"]);
    expect(script.attempts).toEqual([201]);
    expect(script.sent.at(-1)).toBe("ROLLBACK");
    expect(script.sent.some((sql) => /\b(?:INSERT|UPDATE|DELETE|COMMIT)\b/u.test(sql))).toBe(false);
  });

  it("retains granular retry for other SQL failures and preserves the original error", async () => {
    const failure = Object.assign(new Error("synthetic division by zero"), { code: "22012" });
    const script = expansionScript("legacy_sources", failure);
    await expect(readOwnerOccurrences({ ...script, schema: "synthetic", nowMs: 0 }, options)).rejects.toBe(failure);
    expect(script.attempts).toEqual([201, 200]);
  });

  it.each(["57014", "55P03"])("fingerprinting preserves terminal %s failures without retry", async (code) => {
    const failure = Object.assign(new Error(privateMessage), { code });
    const script = expansionScript("legacy_sources", failure);
    await expect(readOwnerDayFingerprints({ ...script, schema: "synthetic", nowMs: 0 }, options)).rejects.toBe(failure);
    expect(script.attempts).toEqual([201]);
  });
});
