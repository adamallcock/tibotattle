/** Storage selection for internal readers. An initialized typed namespace must
 * never appear empty because a reader silently fell back to the old JSON table.
 * Configuration and full schema qualification belong to the runtime initializer.
 */
export async function typedTelemetryReadNamespace(db: D1Database): Promise<string | null> {
  const present = await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v11_admission_state'").first();
  if (!present) return null;
  const state = await db.prepare(`SELECT s.source_namespace,s.runtime_contract_version
    FROM typed_v11_admission_state s JOIN typed_telemetry_origin_contracts origin
      ON origin.namespace_id=s.namespace_id AND origin.source_namespace=s.source_namespace
     AND origin.access_mode='current-write' AND origin.v11_read_contract_version=2
    WHERE s.id=1`)
    .first<{ source_namespace: string; runtime_contract_version: number }>();
  if (!state) return null;
  if (state.runtime_contract_version !== 1 || typeof state.source_namespace !== "string"
      || state.source_namespace.length < 1 || state.source_namespace.length > 256) {
    throw new Error("TELEMETRY_STORAGE_READ_NOT_READY");
  }
  return state.source_namespace;
}
