/** Coarse source-day presence, shared by all admitted input versions. Presence
 * is deliberately broader than eligibility: staging, superseded chunks and
 * inactive correction history may cause an exact-scan fallback. Only absence
 * allows a shortcut. It never grants authority or substitutes an owner fence. */
export const EFFECTIVE_DAY_CATALOG_TABLES = ['storage_effective_source_days',
  'storage_effective_source_days_runtime'] as const;
export const EFFECTIVE_DAY_CATALOG_TRIGGERS = [
  'storage_effective_days_v1_insert',
  'storage_effective_days_v1_update',
  'storage_effective_days_v11_insert',
  'storage_effective_days_v11_update',
  'storage_effective_days_v12_insert',
  'storage_effective_days_v12_update',
  'storage_effective_days_correction_insert',
  'storage_effective_days_correction_update',
  'storage_effective_days_immutable',
  'storage_effective_days_retained',
  'storage_effective_days_runtime_immutable',
  'storage_effective_days_runtime_retained'] as const;
const fail=()=>new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');

export function effectiveDayCatalogAvailable(rows:readonly {name:string;type:string}[]):boolean {
  const selected=rows.filter(row=>(row.type==='table'&&(EFFECTIVE_DAY_CATALOG_TABLES as readonly string[]).includes(row.name))
    ||(row.type==='trigger'&&(EFFECTIVE_DAY_CATALOG_TRIGGERS as readonly string[]).includes(row.name)));
  if(selected.length===0)return false;
  if(selected.length!==EFFECTIVE_DAY_CATALOG_TABLES.length+EFFECTIVE_DAY_CATALOG_TRIGGERS.length)throw fail();
  return true;
}

/** Static SQL fragments for the exact dependency query. The outer scope is
 * materialized only when another source day may contribute. Keeping this in
 * the existing statement preserves the shared query budget and observes day
 * presence and correction activation atomically. */
export function effectiveOutsideDayPredicate(includeSessions:boolean):string {
  const streams=includeSessions?'(1,2,3)':'(1,2)';
  return `EXISTS(SELECT 1 FROM storage_effective_source_days
      WHERE participant_id=requested.participant_id AND stream IN ${streams} AND source_day<requested.from_day)
    OR EXISTS(SELECT 1 FROM storage_effective_source_days
      WHERE participant_id=requested.participant_id AND stream IN ${streams} AND source_day>requested.through_day)`;
}
export const EFFECTIVE_DAY_CATALOG_RUNTIME_FENCE = `AND EXISTS(
  SELECT 1 FROM storage_effective_source_days_runtime catalog
  WHERE catalog.id=1 AND catalog.method='effective-source-day-presence-v1')`;
