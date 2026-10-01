import { parseTelemetryStorageMode } from "./telemetry-storage-mode";

export const DATABASE_PROBE_TIMEOUT_MS = 5_000;
const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** One constant read per role; no scans, schema changes, or participant data.
 * The deadline bounds the response, not execution of an already admitted D1 query. */
async function probe(database: D1Database | undefined) {
  const empty = { responseMs: null, databaseBytes: null };
  if (!database || typeof database.prepare !== "function") {
    return { status: "not_configured" as const, ...empty };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = Date.now();
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const result = await database.prepare("SELECT 1 AS reachable").all<{ reachable: number }>();
        if (!result.success || result.results[0]?.reachable !== 1) throw new Error("PROBE_FAILED");
        return { status: "reachable" as const,
          responseMs: Math.max(0, Date.now() - start),
          databaseBytes: nullableNumber(result.meta?.size_after) };
      }),
      new Promise<{ status: "timeout"; responseMs: null; databaseBytes: null }>(resolve => {
        timer = setTimeout(() => resolve({ status: "timeout", ...empty }), DATABASE_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { status: "unavailable" as const, ...empty };
  } finally {
    clearTimeout(timer);
  }
}

export async function readAdminDatabaseHealth(env: Env) {
  let storageMode: "json" | "typed" | "unknown" = "unknown";
  try { storageMode = parseTelemetryStorageMode(env).kind; } catch { /* Keep the other roles visible. */ }
  const analytics = Reflect.get(env, "ANALYTICS_DB") as D1Database | undefined;
  const [primary, deletion, analytical] = await Promise.all([
    probe(env.USAGE_MONITOR_DB), probe(env.DELETION_LEDGER),
    storageMode === "json"
      ? Promise.resolve({ status: "not_applicable" as const, responseMs: null, databaseBytes: null })
      : probe(analytics),
  ]);
  const databases = [
    { role: "primary" as const, ...primary },
    { role: "deletion_ledger" as const, ...deletion },
    { role: "analytics" as const, ...analytical },
  ];
  return { schemaVersion: "admin-database-health-v0.1", observedAt: new Date().toISOString(),
    storageMode, status: storageMode !== "unknown" && databases.every(row =>
      row.status === "reachable" || row.status === "not_applicable") ? "available" : "degraded",
    databases };
}
