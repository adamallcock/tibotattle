import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_PROBE_TIMEOUT_MS, readAdminDatabaseHealth } from "../src/admin-database-health";

function database(all: () => Promise<unknown>) {
  const prepare = vi.fn(() => ({ all }));
  return { prepare } as unknown as D1Database;
}
const success = () => Promise.resolve({ success: true, results: [{ reachable: 1 }], meta: { size_after: 8192 } });
const settings = (overrides: Record<string, unknown> = {}) => ({ ...env,
  TELEMETRY_STORAGE_MODE: "json", ...overrides }) as Env;

describe("read-only database health", () => {
  it("reads real empty D1 databases without requiring migrations or inspecting rows", async () => {
    const result = await readAdminDatabaseHealth(settings());
    expect(result.status).toBe("available");
    expect(result.databases.map(row => row.status)).toEqual(["reachable", "reachable", "not_applicable"]);
  });
  it("isolates typed failures and never returns raw errors or database identifiers", async () => {
    const primary = database(success);
    const result = await readAdminDatabaseHealth(settings({ USAGE_MONITOR_DB: primary,
      DELETION_LEDGER: database(() => Promise.reject(new Error("private-database-id"))),
      TELEMETRY_STORAGE_MODE: "typed", TELEMETRY_STORAGE_NAMESPACE: "synthetic",
      ANALYTICS_DB: database(async () => ({ success: true, results: [{ reachable: 1 }], meta: {} })),
    }));
    expect(result.status).toBe("degraded");
    expect(result.databases[0]).toMatchObject({ status: "reachable", databaseBytes: 8192 });
    expect(result.databases[1]).toEqual({ role: "deletion_ledger", status: "unavailable", responseMs: null, databaseBytes: null });
    expect(result.databases[2]).toMatchObject({ status: "reachable", databaseBytes: null });
    expect(JSON.stringify(result)).not.toContain("private-database-id");
    expect(primary.prepare).toHaveBeenCalledExactlyOnceWith("SELECT 1 AS reachable");
  });
  it("reports missing required bindings and invalid mode without silently using JSON", async () => {
    const result = await readAdminDatabaseHealth(settings({ TELEMETRY_STORAGE_MODE: "invalid", DELETION_LEDGER: undefined }));
    expect(result).toMatchObject({ storageMode: "unknown", status: "degraded" });
    expect(result.databases.map(row => row.status)).toEqual(["reachable", "not_configured", "not_configured"]);
  });
  it("bounds a stalled probe and keeps other results", async () => {
    vi.useFakeTimers();
    try {
      const pending = readAdminDatabaseHealth(settings({ USAGE_MONITOR_DB: database(() => new Promise(() => {})),
        DELETION_LEDGER: database(success) }));
      await vi.advanceTimersByTimeAsync(DATABASE_PROBE_TIMEOUT_MS);
      const result = await pending;
      expect(result.databases.map(row => row.status)).toEqual(["timeout", "reachable", "not_applicable"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
