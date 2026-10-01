import { ApiError } from "./errors";

/** Fold this constant-size capability check into existing scheduled SELECTs.
 * A staged chunk is accepted even before a domain selects it; a partial schema
 * cannot yield an honest admin total or safe quarantine decision. */
export const TELEMETRY_V12_ADMIN_SCHEMA_SQL = `
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type='table' AND name GLOB 'telemetry_v12_*') AS v12_table_count,
  (SELECT COUNT(*) FROM sqlite_schema
    WHERE type='table' AND name IN (
      'telemetry_v12_runtime','telemetry_v12_chunks','telemetry_v12_domains',
      'telemetry_v12_domain_days','telemetry_v12_domain_heads'
    )) AS v12_required_count`;

export interface TelemetryV12AdminSchemaRow {
  v12_table_count: number;
  v12_required_count: number;
}

export function telemetryV12AdminSchemaPresent(
  row: TelemetryV12AdminSchemaRow,
): boolean {
  if (!Number.isSafeInteger(row.v12_table_count)
      || !Number.isSafeInteger(row.v12_required_count)
      || row.v12_table_count < 0 || row.v12_required_count < 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (row.v12_table_count === 0 && row.v12_required_count === 0) return false;
  if (row.v12_required_count !== 5) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return true;
}

export async function hasTelemetryV12ChunkTable(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT ${TELEMETRY_V12_ADMIN_SCHEMA_SQL}`)
    .first<TelemetryV12AdminSchemaRow>();
  if (!row) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return telemetryV12AdminSchemaPresent(row);
}
