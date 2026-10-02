import { ApiError } from './errors';

/** Consolidated physical inventory for maintained analytics. Subject roots are
 * explicitly checked before ledger completion. Child rows retain reviewed FKs;
 * mixed parent artifacts are removed by the listed BEFORE-delete hooks. Global
 * clocks, anonymous dirty partitions and irreversible terminal ledgers survive.
 * Keep the inventory test equal to every table in migrations0034–0048/0014–0016. */
interface Table {readonly name:string;readonly subject:boolean;readonly references:readonly string[]}
interface Family {readonly migration:string;readonly tables:readonly Table[];readonly triggers:readonly string[]}
export const MAINTAINED_ANALYTICS_ERASURE_FAMILIES:readonly Family[] = [
 {migration:'0034',tables:[
  {"name":"analytics_cache_retention_date_cursor","subject":true,"references":["analytics_runtime_sources","analytics_owner_state"]},
  {"name":"analytics_community_daily_owner_cursor","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_shared_preparation_cursor","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_shared_preparation_ranges","subject":true,"references":["analytics_owner_state"]},
 ],triggers:[
  'analytics_cache_retention_date_cursor_insert',
  'analytics_cache_retention_date_cursor_update',
  'analytics_cache_retention_date_cursor_owner_terminal',
  'analytics_cache_retention_date_cursor_erasure',
  'analytics_cache_retention_date_cursor_erasure_replay',
  'analytics_cache_retention_date_cursor_owner_delete',
  'analytics_community_daily_owner_cursor_update',
  'analytics_shared_preparation_range_insert',
  'analytics_shared_preparation_range_update',
  'analytics_shared_preparation_owner_terminal',
  'analytics_shared_preparation_erasure',
  'analytics_shared_feature_day_update',
  'analytics_shared_feature_release_v1',
 ]},
 {migration:'0035',tables:[
  {"name":"analytics_effective_dependency_summaries","subject":true,"references":[]},
 ],triggers:[
  'analytics_effective_dependency_insert',
  'analytics_effective_dependency_update',
  'analytics_effective_dependency_owner_update',
  'analytics_effective_dependency_owner_delete',
  'analytics_effective_dependency_runtime_update',
  'analytics_effective_dependency_runtime_delete',
  'analytics_effective_dependency_terminal_insert',
  'analytics_effective_dependency_terminal_update',
  'analytics_effective_dependency_contract_v1',
 ]},
 {migration:'0036',tables:[
  {"name":"analytics_canonical_facts","subject":true,"references":["analytics_owner_state"]},
  {"name":"analytics_canonical_variants","subject":false,"references":["analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_days","subject":false,"references":["analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_tools","subject":false,"references":["analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_heads","subject":false,"references":["analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_pages","subject":true,"references":["analytics_owner_state"]},
  {"name":"analytics_canonical_effects","subject":false,"references":["analytics_canonical_pages:cascade","analytics_canonical_facts:cascade","analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_dirty_partitions","subject":false,"references":[]},
  {"name":"analytics_canonical_manifests","subject":false,"references":[]},
  {"name":"analytics_canonical_manifest_rows","subject":false,"references":["analytics_canonical_manifests:cascade","analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_partition_heads","subject":false,"references":["analytics_canonical_manifests:cascade"]},
  {"name":"analytics_canonical_input_work","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_input_pending","subject":false,"references":["analytics_canonical_input_work:cascade"]},
  {"name":"analytics_canonical_input_seen","subject":false,"references":["analytics_canonical_input_work:cascade"]},
 ],triggers:[
  'analytics_canonical_fact_admit',
  'analytics_canonical_fact_immutable',
  'analytics_canonical_page_admit',
  'analytics_canonical_page_seal',
  'analytics_canonical_effect_admit',
  'analytics_canonical_effect_apply',
  'analytics_canonical_effect_immutable',
  'analytics_canonical_manifest_seal',
  'analytics_canonical_fact_remove',
  'analytics_canonical_owner_terminal',
  'analytics_canonical_erasure',
  'analytics_canonical_owner_delete',
  'analytics_canonical_variants_immutable',
  'analytics_canonical_days_immutable',
  'analytics_canonical_tools_immutable',
  'analytics_canonical_manifest_rows_immutable',
  'analytics_canonical_input_admit',
  'analytics_canonical_input_seal',
  'analytics_canonical_input_owner_terminal',
  'analytics_canonical_input_erasure',
  'analytics_canonical_input_owner_delete',
 ]},
 {migration:'0037',tables:[
  {"name":"analytics_canonical_feature_quantities","subject":false,"references":["analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_feature_prices","subject":false,"references":["analytics_canonical_feature_quantities:cascade"]},
  {"name":"analytics_canonical_feature_membership","subject":false,"references":["analytics_canonical_feature_quantities:cascade"]},
  {"name":"analytics_canonical_activity_heads","subject":false,"references":["analytics_canonical_manifests:cascade"]},
 ],triggers:[
  'analytics_canonical_feature_quantity_admit',
  'analytics_canonical_feature_quantity_immutable',
  'analytics_canonical_feature_price_admit',
  'analytics_canonical_feature_price_immutable',
  'analytics_canonical_feature_membership_admit',
  'analytics_canonical_feature_membership_immutable',
  'analytics_canonical_activity_admit',
  'analytics_canonical_activity_immutable',
 ]},
 {migration:'0038',tables:[
  {"name":"analytics_partition_work","subject":true,"references":["analytics_runtime_sources","analytics_owner_state"]},
  {"name":"analytics_partition_schedule","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_partition_subject_schedule","subject":true,"references":["analytics_runtime_sources"]},
  {"name":"analytics_partition_canonical_effects","subject":false,"references":["analytics_canonical_effects:cascade"]},
  {"name":"analytics_partition_reconciliation","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_partition_ranges","subject":true,"references":["analytics_owner_state"]},
  {"name":"analytics_partition_global_changes","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_partition_dirty_work","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_partition_effect_refs","subject":false,"references":["analytics_partition_work:cascade","analytics_canonical_effects:cascade"]},
  {"name":"analytics_partition_work_links","subject":false,"references":["analytics_partition_work:cascade","analytics_partition_work:cascade"]},
  {"name":"analytics_partition_work_subjects","subject":true,"references":["analytics_partition_work:cascade","analytics_owner_state"]},
 ],triggers:[
  'analytics_partition_canonical_outbox',
  'analytics_partition_work_admit',
  'analytics_partition_work_immutable',
  'analytics_partition_range_admit',
  'analytics_partition_owner_terminal',
  'analytics_partition_erasure',
  'analytics_partition_owner_delete',
  'analytics_partition_dirty_insert',
  'analytics_partition_dirty_update',
  'analytics_partition_work_link_acyclic',
  'analytics_partition_manifest_admit',
  'analytics_partition_manifest_subjects',
  'analytics_partition_subject_terminal',
  'analytics_partition_subject_erasure',
  'analytics_partition_subject_owner_delete',
 ]},
 {migration:'0039',tables:[
  {"name":"analytics_canonical_rolling_segments","subject":true,"references":["analytics_canonical_input_work:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_rolling_rows","subject":false,"references":["analytics_canonical_rolling_segments:cascade","analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_rolling_windows","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_rolling_members","subject":false,"references":["analytics_canonical_rolling_windows:cascade","analytics_canonical_rolling_segments:cascade"]},
 ],triggers:[
  'analytics_canonical_rolling_segment_admit',
  'analytics_canonical_rolling_segment_update',
  'analytics_canonical_rolling_row_admit',
  'analytics_canonical_rolling_row_immutable',
  'analytics_canonical_rolling_window_admit',
  'analytics_canonical_rolling_window_update',
  'analytics_canonical_rolling_member_admit',
  'analytics_canonical_rolling_member_immutable',
  'analytics_canonical_rolling_head_insert',
  'analytics_canonical_rolling_head_update',
  'analytics_canonical_rolling_head_delete',
  'analytics_canonical_rolling_erasure',
  'analytics_canonical_rolling_owner_terminal',
  'analytics_canonical_rolling_row_remove',
 ]},
 {migration:'0040',tables:[
  {"name":"analytics_canonical_cache_clock","subject":false,"references":[]},
  {"name":"analytics_canonical_cache_logical_work","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_pair_work","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_slots","subject":true,"references":["analytics_canonical_facts:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_nodes","subject":true,"references":["analytics_canonical_facts:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_days","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_session_proofs","subject":true,"references":["analytics_canonical_cache_days:cascade"]},
  {"name":"analytics_canonical_cache_groups","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_pairs","subject":true,"references":["analytics_canonical_cache_nodes:cascade","analytics_canonical_cache_nodes:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_counters","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_sessions","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_partitions","subject":false,"references":["analytics_canonical_manifests:cascade"]},
  {"name":"analytics_canonical_cache_window_heads","subject":true,"references":["analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_windows","subject":true,"references":["analytics_canonical_cache_window_heads:cascade"]},
 ],triggers:[
  'analytics_canonical_cache_clock_cas',
  'analytics_canonical_cache_group_insert',
  'analytics_canonical_cache_group_delete',
  'analytics_canonical_cache_effect',
  'analytics_canonical_cache_slot_insert',
  'analytics_canonical_cache_node_insert',
  'analytics_canonical_cache_slot_delete',
  'analytics_canonical_cache_node_delete',
  'analytics_canonical_cache_pair_insert',
  'analytics_canonical_cache_pair_delete',
  'analytics_canonical_cache_slot_admit',
  'analytics_canonical_cache_node_admit',
  'analytics_canonical_cache_pair_admit',
  'analytics_canonical_cache_slots_immutable',
  'analytics_canonical_cache_nodes_immutable',
  'analytics_canonical_cache_pairs_immutable',
  'analytics_canonical_cache_owner_terminal',
  'analytics_canonical_cache_erasure',
  'analytics_canonical_cache_erasure_update',
  'analytics_canonical_cache_owner_delete',
  'analytics_canonical_cache_fact_remove',
 ]},
 {migration:'0041',tables:[
  {"name":"analytics_canonical_publication_parts","subject":false,"references":["analytics_runtime_sources","analytics_canonical_manifests:cascade"]},
  {"name":"analytics_canonical_publication_part_facts","subject":false,"references":["analytics_canonical_publication_parts:cascade","analytics_canonical_facts:cascade"]},
  {"name":"analytics_canonical_publication_part_subjects","subject":true,"references":["analytics_canonical_publication_parts:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_publication_part_heads","subject":false,"references":["analytics_runtime_sources","analytics_canonical_publication_parts:cascade"]},
  {"name":"analytics_canonical_publication_replacements","subject":false,"references":["analytics_runtime_sources","analytics_canonical_publication_parts:cascade"]},
  {"name":"analytics_canonical_publication_closures","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_canonical_publication_expected","subject":false,"references":["analytics_canonical_publication_closures:cascade","analytics_canonical_publication_parts"]},
  {"name":"analytics_canonical_publication_subjects","subject":true,"references":["analytics_canonical_publication_closures:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_publication_graph_refs","subject":true,"references":["analytics_canonical_publication_closures:cascade","analytics_community_graph_results:cascade"]},
  {"name":"analytics_canonical_publication_cohorts","subject":false,"references":["analytics_runtime_sources"]},
  {"name":"analytics_canonical_publication_cohort_members","subject":true,"references":["analytics_canonical_publication_cohorts:cascade","analytics_owner_state:cascade"]},
  {"name":"analytics_canonical_cache_publications","subject":false,"references":["analytics_runtime_sources","analytics_canonical_publication_closures:cascade","analytics_canonical_publication_cohorts:cascade"]},
 ],triggers:[
  'analytics_canonical_publication_part_admit',
  'analytics_canonical_publication_part_immutable',
  'analytics_canonical_publication_part_delete',
  'analytics_canonical_publication_fact_delete',
  'analytics_canonical_publication_owner_terminal',
  'analytics_canonical_publication_erasure',
  'analytics_canonical_publication_expected_revision',
  'analytics_canonical_publication_expected_immutable',
  'analytics_canonical_publication_subject_admit',
  'analytics_canonical_publication_cohort_admit',
  'analytics_canonical_publication_cohort_terminal',
  'analytics_canonical_publication_cohort_erasure',
  'analytics_canonical_publication_cohort_owner_delete',
  'analytics_canonical_publication_graph_admit',
  'analytics_canonical_publication_graph_change',
  'analytics_canonical_publication_graph_delete',
  'analytics_canonical_publication_head_changed',
  'analytics_canonical_publication_partition_dirty',
  'analytics_canonical_publication_part_subject_admit',
  'analytics_canonical_publication_part_subject_terminal',
  'analytics_canonical_publication_part_subject_erasure',
  'analytics_canonical_publication_owner_delete',
  'analytics_canonical_publication_fence_replay',
  'analytics_canonical_cache_publication_admit',
  'analytics_canonical_cache_publication_update',
 ]},
 {migration:'0043',tables:[
  {name:'analytics_partition_work_counts',subject:false,references:['analytics_runtime_sources:cascade']},
  {name:'analytics_pipeline_runtime',subject:false,references:['analytics_runtime_sources:cascade']},
 ],triggers:[
  'analytics_partition_capacity_insert','analytics_partition_capacity_reopen',
  'analytics_partition_counts_insert','analytics_partition_counts_state','analytics_partition_counts_delete','analytics_partition_counts_claim',
 ]},
 {migration:'0045',tables:[
  {name:'analytics_partition_graph_dirty',subject:false,references:['analytics_runtime_sources:cascade']},
  {name:'analytics_partition_policy_work',subject:false,references:['analytics_runtime_sources:cascade']},
  {name:'analytics_partition_graph_subjects',subject:true,references:['analytics_owner_state:cascade']},
  {name:'analytics_partition_graph_input_refs',subject:true,references:['analytics_canonical_input_work:cascade','analytics_partition_graph_subjects:cascade','analytics_owner_state:cascade']},
  {name:'analytics_partition_graph_demands',subject:true,references:['analytics_partition_graph_subjects:cascade','analytics_owner_state:cascade']},
  {name:'analytics_partition_graph_control',subject:false,references:['analytics_runtime_sources:cascade','analytics_partition_graph_subjects:set null','analytics_partition_graph_input_refs:set null']},
 ],triggers:['analytics_partition_graph_insert','analytics_partition_graph_update','analytics_partition_graph_delete',
  'analytics_partition_graph_subject_added',
  'analytics_partition_graph_subject_admit','analytics_partition_graph_subject_update','analytics_partition_graph_ref_admit','analytics_partition_graph_ref_update',
  'analytics_partition_graph_demand_admit','analytics_partition_graph_demand_update','analytics_partition_graph_input_sealed','analytics_partition_graph_input_insert',
  'analytics_partition_graph_subject_terminal','analytics_partition_graph_subject_erasure','analytics_partition_graph_subject_replay','analytics_partition_graph_subject_delete']},
 {migration:'0046',tables:[
  {name:'analytics_partition_empty_outcomes',subject:true,references:['analytics_owner_state:cascade']},
 ],triggers:['analytics_partition_empty_admit','analytics_partition_empty_update','analytics_partition_empty_terminal',
  'analytics_partition_empty_erasure','analytics_partition_empty_erasure_replay']},
 {migration:'0047',tables:[
  {name:'analytics_partition_maintenance',subject:false,references:['analytics_runtime_sources:cascade']},
 ],triggers:[]},
 {migration:'0048',tables:[
  {name:'analytics_canonical_cache_prepared_receipts',subject:false,references:['analytics_partition_work:cascade']},
 ],triggers:[]},
];
export const MAINTAINED_ANALYTICS_REPLAY_TRIGGERS:readonly string[] = [
  "analytics_cache_retention_date_cursor_erasure_replay",
  "analytics_shared_preparation_erasure_replay",
  "analytics_canonical_erasure_replay",
  "analytics_canonical_input_erasure_replay",
  "analytics_partition_erasure_replay",
  "analytics_partition_subject_erasure_replay",
  "analytics_canonical_rolling_erasure_replay",
  "analytics_partition_subject_schedule_admit",
  "analytics_partition_subject_schedule_update",
  "analytics_canonical_effect_cursor_remove",
  "analytics_canonical_page_cursor_remove",
  "analytics_partition_manifest_admit",
  "analytics_partition_manifest_subjects",
  "analytics_shared_preparation_owner_delete"
];
export const MAINTAINED_SOURCE_ERASURE_FAMILIES = [
  {
    "migration": "0014",
    "tables": [
      "storage_effective_dependency_mutation_runtime",
      "storage_effective_dependency_owner_mutations"
    ],
    "triggers": [
      "storage_effective_mutation_participant_erase",
      "storage_effective_mutation_owner_erase",
      "storage_effective_mutation_link_erase"
    ]
  },
  {
    "migration": "0015",
    "tables": [
      "storage_effective_selective_runtime",
      "storage_effective_selective_bootstrap",
      "storage_effective_selective_owners",
      "storage_effective_selective_work",
      "storage_effective_selective_variants",
      "storage_effective_selective_reverse_work",
      "storage_effective_selective_days",
      "storage_effective_selective_ranges",
      "storage_effective_selective_effects"
    ],
    "triggers": [
      "storage_effective_selective_participants_delete",
      "storage_effective_selective_erase_storage_owner_revisions",
      "storage_effective_selective_erase_storage_v11_owner_links"
    ]
  }
] as const;
export const MAINTAINED_SOURCE_REPLAY_TRIGGERS:readonly string[] = [
  "storage_effective_selective_bootstrap_participant_erase",
  "storage_effective_selective_bootstrap_owner_erase",
  "storage_effective_selective_bootstrap_link_erase"
];
const unavailable=()=>new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
interface Schema {type:string;name:string;sql:string}
async function schema(db:D1Database,names:readonly string[]):Promise<Map<string,Schema>> {
 const result=await db.prepare(`SELECT type,name,sql FROM sqlite_schema WHERE name IN(SELECT value FROM json_each(?))`)
  .bind(JSON.stringify(names)).all<Schema>();
 if(result.success!==true||!Array.isArray(result.results))throw unavailable();
 return new Map(result.results.map(row=>[row.name,row]));
}
function requireObjects(rows:Map<string,Schema>,names:readonly string[],type:'table'|'trigger'):void {
 if(names.some(name=>rows.get(name)?.type!==type))throw unavailable();
}
export interface MaintainedErasureInventory {readonly ownerTables:readonly string[];readonly predicates:readonly string[]}
/** Optional predecessor schemas remain supported. Once any maintained family
 * is installed, incomplete physical cleanup or replay capability refuses. */
export async function readMaintainedAnalyticsErasureInventory(db:D1Database):Promise<MaintainedErasureInventory> {
 const rows=await schema(db,[...MAINTAINED_ANALYTICS_ERASURE_FAMILIES.flatMap(f=>[...f.tables.map(t=>t.name),...f.triggers]),
  ...MAINTAINED_ANALYTICS_REPLAY_TRIGGERS]);
 const present=MAINTAINED_ANALYTICS_ERASURE_FAMILIES.filter(f=>f.tables.some(t=>rows.has(t.name)));
 if(present.length)requireObjects(rows,MAINTAINED_ANALYTICS_REPLAY_TRIGGERS,'trigger');
 const ownerTables:string[]=[],predicates:string[]=[];
 for(const family of present) {
  requireObjects(rows,family.tables.map(t=>t.name),'table');requireObjects(rows,family.triggers,'trigger');
  for(const table of family.tables) {
   if(table.subject)ownerTables.push(table.name);
   for(const reference of table.references) {
    const [parent,action]=reference.split(':');
    const required=new RegExp('\\bREFERENCES\\s+"?'+parent+'"?\\s*\\([^)]*\\)'+(action==='cascade'?'\\s+ON DELETE CASCADE':action==='set null'?'\\s+ON DELETE SET NULL':''),'iu');
    if(!required.test(rows.get(table.name)!.sql))throw unavailable();
   }
  }
 }
 if(rows.has('analytics_shared_preparation_cursor'))predicates.push(`NOT EXISTS(SELECT 1 FROM analytics_shared_preparation_cursor
  WHERE source_id=?1 AND ?2 IN(after_recent_owner,after_dirty_owner,after_history_owner))`);
 if(rows.has('analytics_partition_global_changes'))predicates.push(`NOT EXISTS(SELECT 1 FROM analytics_partition_global_changes
  WHERE source_id=?1 AND after_owner_digest=?2)`);
 return {ownerTables:Object.freeze(ownerTables),predicates:Object.freeze(predicates)};
}
/** Source participant FKs remove reverse-link metadata. The legacy mutation
 * clock has its own erase hook; a bootstrap cursor must not retain a dead ID. */
export async function requireMaintainedSourceErasureProof(db:D1Database,checkAbsence=false):Promise<void> {
 const rows=await schema(db,[...MAINTAINED_SOURCE_ERASURE_FAMILIES.flatMap(f=>[...f.tables,...f.triggers]),
  ...MAINTAINED_SOURCE_REPLAY_TRIGGERS]);
 for(const family of MAINTAINED_SOURCE_ERASURE_FAMILIES)if(family.tables.some(t=>rows.has(t))) {
  requireObjects(rows,family.tables,'table');requireObjects(rows,family.triggers,'trigger');
  if(family.migration==='0015')for(const table of family.tables.slice(2)) {
   if(!/\bREFERENCES\s+"?participants"?\s*\(id\)\s+ON DELETE CASCADE/iu.test(rows.get(table)!.sql))throw unavailable();
  }
 }
 if(rows.has('storage_effective_selective_bootstrap'))requireObjects(rows,MAINTAINED_SOURCE_REPLAY_TRIGGERS,'trigger');
 if(checkAbsence) {
  if(rows.has('storage_effective_dependency_owner_mutations')&&await db.prepare(`SELECT 1 FROM storage_effective_dependency_owner_mutations m
   LEFT JOIN participants p ON p.id=m.participant_id WHERE p.id IS NULL LIMIT 1`).first())throw unavailable();
  if(rows.has('storage_effective_selective_bootstrap')&&await db.prepare(`SELECT 1 FROM storage_effective_selective_bootstrap b
   WHERE b.owner_cursor!='' AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l JOIN participants p ON p.id=l.participant_id WHERE l.owner_digest=b.owner_cursor) LIMIT 1`).first())throw unavailable();
 }
}
