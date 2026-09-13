import { D1_PROVIDER_SCHEMA_PREDICATE } from './d1-provider-schema';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { beginRawTelemetryCopy, copyLegacyTelemetryPage, verifyLegacyTelemetryCopyPage, readLegacyTelemetryCopyPage, type RawCopyRun } from './typed-telemetry-copy';
import { restoreTypedAdmissionPage } from './authority-restore-adoption';
import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { initializeStorageSource } from './analytics-delivery';
import { AUTHORITY_RESTORE_SCHEMA } from './authority-restore-schema';

/** Privileged LOCAL restore protocol. No route, binding switch, secret logging,
 * automatic unfreeze or production authority is provided by these functions.
 * Source DML is mechanically frozen; the operator must also exclude DDL and
 * deployments. Snapshot/role digests must name independently reviewed inputs.
 * Authority staging completion alone is never runtime readiness.
 */
export const MAX_AUTHORITY_COPY_ROWS = 32;
export const MAX_AUTHORITY_COPY_BYTES = 1_048_576;
const PREFIX = '_authority_stage_';
const OWNED = '_authority_';
const AUTHORITY_TABLES = new Set(`accountless_enrollment_issuance accountless_enrollment_ledger accountless_upload_owners accountless_v11_device_authorizations attribution_enrollments collection_controls device_credential_rotations device_credentials device_pairing_events device_pairings device_upload_authorizations enrollment_grants identity_link_secret_configuration identity_reenrollment_cooldowns participant_community_eligibility participants pending_quarantine_objects quarantine_reconciliation_state recovery_retry_receipts retention_state telemetry_contribution_admission_windows telemetry_transport_floor_rollbacks telemetry_transport_formats telemetry_transport_participant_floors telemetry_v11_device_consents telemetry_v1_chunk_admission_windows telemetry_v1_device_consents upload_authorizations web_sessions telemetry_v11_chunks telemetry_v11_day_manifests telemetry_v11_domain_days telemetry_v11_domain_heads telemetry_v11_domain_predecessors telemetry_v11_domains telemetry_v1_chunks community_analytical_input_versions community_graph_update_scope community_snapshot_mutation_control community_aggregate_exclusions community_snapshot_policy admin_action_audit contributions telemetry_contributions telemetry_records telemetry_contribution_occurrences apple_signin_handoffs google_signin_handoffs sign_in_start_admission_windows sparkle_appcast_guard_nonces diagnostic_error_events github_distribution_snapshots github_distribution_sync_state github_release_asset_snapshots github_release_snapshots`.split(' '));
const DERIVED_TABLES = new Set(`admin_community_allowance_preview_cache admin_community_allowance_preview_refresh_state admin_metric_snapshots admin_metrics_history_cache community_allowance_fit_cache community_allowance_publication_state community_analysis_work community_analysis_work_parts community_analysis_work_stage community_current_analysis_queue community_current_analysis_queue_state community_daily_aggregate_rebuilds community_daily_aggregates community_model_composition_cache community_model_composition_days community_model_history_dependencies community_model_history_results community_model_history_work community_model_history_work_parts community_model_history_work_stage community_preparation_progress_counters community_prepared_fit_rows community_prepared_plan_rows community_prepared_source_days community_prepared_usage_bins community_prepared_usage_rows community_public_source_bootstrap community_publication_changes community_publication_generation community_publication_members community_refresh_lanes community_snapshot_builders community_weekly_snapshot_rebuilds community_weekly_snapshots telemetry_v1_quota_fit_backfill telemetry_v1_quota_fit_rows`.split(' '));
export const authorityRestoreRetainedTableNames = ():readonly string[] => Object.freeze([...AUTHORITY_TABLES].sort());
const EXCLUDED_RAW = new Set(['telemetry_v1_records', 'telemetry_v11_records']);
const q = (name: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) fail(); return `"${name}"`; };
function fail(): never { throw new Error('AUTHORITY_RESTORE_EVIDENCE_MISMATCH'); }
const hash = (value: unknown) => sha256Hex(canonicalJson(value));
const digest = (value: string) => { if (!/^[0-9a-f]{64}$/.test(value)) fail(); };
const operation = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) fail(); };
export const AUTHORITY_OPERATOR_LEDGER_SQL = 'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
export interface AuthoritySchemaObject { type: 'table'|'index'|'view'|'trigger'; name: string; tbl_name: string; sql: string; }
export interface AuthorityRestoreContract {
  version: 'authority-restore-v1'; runId: string; sourceId:string; sourceNamespace: string; sourceSnapshotDigest: string;
  sourceSchema: AuthoritySchemaObject[]; sourceSchemaDigest: string;
  targetBaseSchema: AuthoritySchemaObject[]; targetBaseSchemaDigest: string;
  targetMigrationLedgerDigest?:string;
  targetOperatorLedgerDigest?:string;
  /** Must cover every source table exactly. Non-authority dispositions need a
   * separately reviewed role contract; no table silently disappears. */
  tables: { name: string; disposition: 'authority'|'typed-v1'|'typed-v11'|'analytics'|'outside-role' }[];
  finalSchema: AuthoritySchemaObject[]; finalSchemaDigest: string;
  typedCopies: RawCopyRun[];
  /** Exact sqlite_sequence high-water marks, including empty retained tables. */
  admissionContract?:'typed-v1-v11-restore-v1';
  authoritySequences: {name:string;sequence:number}[];
  operatingLimitBytes: number;
}
interface Column { name: string; type: string; pk: number; hidden: number; }
interface Descriptor { name: string; columns: string[]; keys: string[]; rowid: boolean; sql: string; }
type Cell = ['null'] | ['text',string] | ['number',number] | ['blob',number[]];
type Cursor = Cell[];
type EncodedRow = { cells: Cell[]; cursor: Cursor };
interface TableState { name: string; descriptor:string; copy_cursor: string; verify_cursor: string; copied: number; verified: number; copy_done: number; verify_done: number; }

const AUTHORITY_SCHEMA_QUERY = `SELECT s.type,s.name,s.tbl_name,s.sql FROM sqlite_master s WHERE s.sql IS NOT NULL
    AND s.name NOT GLOB 'sqlite_*' AND s.name NOT GLOB '_authority_*'
    AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) ORDER BY s.type,s.name LIMIT 1025`;
export async function authoritySchemaInventory(db: D1Database): Promise<AuthoritySchemaObject[]> {
  const rows = (await db.prepare(AUTHORITY_SCHEMA_QUERY).all<AuthoritySchemaObject>()).results;
  if (rows.length > 1024) fail();
  return rows;
}
export const authoritySchemaDigest = (objects: AuthoritySchemaObject[]): Promise<string> => hash(objects);
async function validate(contract: AuthorityRestoreContract, expectedDigest: string) {
  operation(contract.runId); operation(contract.sourceId); encodeTypedTelemetryId(contract.sourceNamespace); digest(contract.sourceSnapshotDigest);
  digest(expectedDigest);
  if (contract.version !== 'authority-restore-v1' || await hash(contract) !== expectedDigest
      || !Number.isSafeInteger(contract.operatingLimitBytes) || contract.operatingLimitBytes < 33_554_432
      || contract.operatingLimitBytes > 9_000_000_000) fail();
  for (const [objects, pin] of [[contract.sourceSchema,contract.sourceSchemaDigest], [contract.targetBaseSchema,contract.targetBaseSchemaDigest], [contract.finalSchema,contract.finalSchemaDigest]] as const) {
    if (!Array.isArray(objects) || objects.length > 1024 || new Set(objects.map(x=>x.name)).size !== objects.length || await hash(objects) !== pin) fail();
    for (const object of objects) { q(object.name); q(object.tbl_name); if (object.name.startsWith(OWNED) || !['table','index','view','trigger'].includes(object.type) || typeof object.sql !== 'string' || object.sql.length > 100_000) fail(); }
  }
  const tables = contract.sourceSchema.filter(x=>x.type==='table').map(x=>x.name).sort();
  if (canonicalJson(tables) !== canonicalJson(contract.tables.map(x=>x.name).sort()) || new Set(contract.tables.map(x=>x.name)).size !== tables.length || tables.length > 128) fail();
  for (const table of contract.tables) {
    if (!['authority','typed-v1','typed-v11','analytics','outside-role'].includes(table.disposition)) fail();
    if(table.disposition==='analytics'&&!DERIVED_TABLES.has(table.name))fail();
    if(table.disposition==='outside-role'&&table.name!=='d1_migrations')fail();
    if (AUTHORITY_TABLES.has(table.name) && table.disposition !== 'authority') fail();
    if (table.disposition === 'authority' && !AUTHORITY_TABLES.has(table.name)) fail();
    if (EXCLUDED_RAW.has(table.name) && table.disposition !== (table.name==='telemetry_v1_records'?'typed-v1':'typed-v11')) fail();
    if ((table.disposition==='typed-v1' || table.disposition==='typed-v11') && !EXCLUDED_RAW.has(table.name)) fail();
  }
  const auto=contract.sourceSchema.filter(x=>x.type==='table'&&(AUTHORITY_TABLES.has(x.name)||x.name==='telemetry_v1_records')&&/\bAUTOINCREMENT\b/i.test(x.sql)).map(x=>x.name).sort();
  if(!Array.isArray(contract.authoritySequences)||canonicalJson(auto)!==canonicalJson(contract.authoritySequences.map(x=>x.name).sort())||new Set(auto).size!==contract.authoritySequences.length||contract.authoritySequences.some(x=>!Number.isSafeInteger(x.sequence)||x.sequence<0))fail();
  if (!tables.includes('participants') || !contract.tables.some(x=>x.disposition==='authority')) fail();
  const formats = contract.tables.filter(x=>x.disposition.startsWith('typed-')).map(x=>x.disposition==='typed-v1'?'v1':'v11').sort();
  if (canonicalJson(formats)!==canonicalJson(contract.typedCopies.map(x=>x.format).sort())) fail();
  for (const copy of contract.typedCopies) if (copy.sourceNamespace!==contract.sourceNamespace || copy.sourceSnapshotDigest!==contract.sourceSnapshotDigest) fail();
  for(const objects of [contract.targetBaseSchema,contract.finalSchema]){
    const ledger=objects.filter(x=>x.tbl_name==='d1_storage_migrations');
    if(contract.targetOperatorLedgerDigest!==undefined){digest(contract.targetOperatorLedgerDigest);
      if(ledger.length!==1||ledger[0]?.type!=='table'||ledger[0]?.name!=='d1_storage_migrations'||ledger[0]?.sql!==AUTHORITY_OPERATOR_LEDGER_SQL)fail();
    }else if(ledger.length)fail();
  }
  const finalTables = new Set(contract.finalSchema.filter(x=>x.type==='table').map(x=>x.name));
  for (const table of contract.tables.filter(x=>x.disposition==='authority')) if (!finalTables.has(table.name)) fail();
  // A typed role must not accidentally recreate the removed raw JSON store.
  if(contract.admissionContract!==undefined&&contract.admissionContract!=='typed-v1-v11-restore-v1')fail();
  if (!contract.admissionContract&&contract.finalSchema.some(x=>EXCLUDED_RAW.has(x.name))) fail();
  if(contract.admissionContract){for(const format of formats)for(const suffix of ['admission_state','chunk_allocations','owner_memberships',...(format==='v11'?['record_proofs','manifest_memberships']:['record_admissions'])])if(!contract.targetBaseSchema.some(x=>x.type==='table'&&x.name===`typed_${format}_${suffix}`))fail();}
}
export const authorityMigrationLedgerDigest = async (db:D1Database):Promise<string> => {const rows=(await db.prepare('SELECT * FROM d1_migrations ORDER BY id LIMIT 129').all()).results;if(rows.length>128)fail();return hash(rows);};
export const authorityRestoreContractDigest = (contract: AuthorityRestoreContract): Promise<string> => hash(contract);
const frozenTrigger = (verb: string, name: string, prefix = '_authority_freeze_') => ({ name: `${prefix}${verb.toLowerCase()}_${name}`,
  sql: `CREATE TRIGGER ${q(`${prefix}${verb.toLowerCase()}_${name}`)} BEFORE ${verb} ON ${q(name)} BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END` });

/** Explicit source write pause. Atomic across the complete application table
 * inventory, including legacy writers. No implicit release/unfreeze operation. */
export async function freezeAuthorityRestoreSource(source: D1Database, contract: AuthorityRestoreContract, expectedDigest: string): Promise<void> {
  await validate(contract, expectedDigest);
  if (await hash(await authoritySchemaInventory(source)) !== contract.sourceSchemaDigest) fail();
  const exists = await source.prepare("SELECT 1 FROM sqlite_master WHERE name='_authority_snapshot'").first();
  if (exists) { await assertFrozen(source, contract, expectedDigest); return; }
  const statements = [source.prepare(`CREATE TABLE _authority_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,namespace TEXT NOT NULL,snapshot_digest TEXT NOT NULL) STRICT`),
    source.prepare('INSERT INTO _authority_snapshot VALUES(1,?,?,?)').bind(expectedDigest,contract.sourceNamespace,contract.sourceSnapshotDigest)];
  for (const name of [...contract.tables.map(x=>x.name), '_authority_snapshot']) for (const verb of ['INSERT','UPDATE','DELETE']) statements.push(source.prepare(frozenTrigger(verb,name).sql));
  try { await source.batch(statements); } catch { await assertFrozen(source,contract,expectedDigest); }
  await assertFrozen(source,contract,expectedDigest);
}
async function assertFrozen(source: D1Database, contract: AuthorityRestoreContract, pin: string) {
  // These reads depend only on the pinned contract, not one another. Keep a
  // fresh batch at every existing boundary; no proof survives a page operation.
  const statements = [
    source.prepare('SELECT contract_digest,namespace,snapshot_digest FROM _authority_snapshot WHERE id=1'),
    source.prepare(AUTHORITY_SCHEMA_QUERY),
    source.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB '_authority_freeze_*' ORDER BY name LIMIT 400"),
    ...contract.authoritySequences.map(entry => source.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(entry.name)),
  ];
  const results = await source.batch<Record<string, unknown>>(statements);
  if (!Array.isArray(results) || results.length !== statements.length
      || results.some(result => result?.success !== true || !Array.isArray(result.results))) fail();
  const states = results[0]!.results;
  const schema = results[1]!.results;
  const rows = results[2]!.results;
  if (states.length !== 1 || schema.length > 1024) fail();
  const state = states[0]!;
  if (state.contract_digest!==pin || state.namespace!==contract.sourceNamespace || state.snapshot_digest!==contract.sourceSnapshotDigest || await hash(schema)!==contract.sourceSchemaDigest) fail();
  const expected = [...contract.tables.map(x=>x.name),'_authority_snapshot'].flatMap(name=>['INSERT','UPDATE','DELETE'].map(verb=>frozenTrigger(verb,name))).sort((a,b)=>a.name<b.name?-1:1);
  if (canonicalJson(rows)!==canonicalJson(expected)) fail();
  for (const [index,entry] of contract.authoritySequences.entries()) {
    const sequences = results[index+3]!.results;
    if (sequences.length > 1 || (sequences[0]?.seq??0)!==entry.sequence) fail();
  }
}
async function descriptors(source: D1Database, contract: AuthorityRestoreContract): Promise<Descriptor[]> {
  const names = new Set(contract.tables.filter(x=>x.disposition==='authority').map(x=>x.name));
  const result: Descriptor[]=[]; const pending = new Map<string,{desc:Descriptor;parents:string[]}>();
  for (const name of names) {
    const object=contract.sourceSchema.find(x=>x.type==='table'&&x.name===name)!;
    const columns=(await source.prepare(`PRAGMA table_xinfo(${q(name)})`).all<Column>()).results;
    if (!columns.length || columns.length>99 || columns.some(x=>x.hidden!==0 || x.name.startsWith(OWNED)||x.name.toLowerCase()==='rowid')) fail();
    columns.forEach(x=>q(x.name));
    const rowid=!/\bWITHOUT\s+ROWID\b/i.test(object.sql);
    const keys=rowid?['_authority_original_rowid']:columns.filter(x=>x.pk>0).sort((a,b)=>a.pk-b.pk).map(x=>x.name);
    if (!keys.length) fail();
    const parents=[...new Set((await source.prepare(`PRAGMA foreign_key_list(${q(name)})`).all<{table:string}>()).results.map(x=>x.table).filter(x=>x!==name))];
    if (parents.some(x=>!names.has(x))) throw new Error('AUTHORITY_RESTORE_ROLE_DEPENDENCY_UNCOVERED');
    pending.set(name,{desc:{name,columns:columns.map(x=>x.name),keys,rowid,sql:object.sql},parents});
  }
  while(pending.size) {
    const item=[...pending.entries()].find(([,x])=>x.parents.every(parent=>result.some(d=>d.name===parent)));
    if (!item) throw new Error('AUTHORITY_RESTORE_CYCLIC_DEPENDENCY');
    result.push(item[1].desc); pending.delete(item[0]);
  }
  return result;
}
function stageSql(desc:Descriptor, names:Set<string>):string {
  let changed=false;
  const sql=desc.sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|\b(CREATE\s+TABLE|REFERENCES)\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/gi,(full,kind:string,quoted:string,bare:string)=>{
    if(!kind)return full;
    const name=quoted??bare; if(!names.has(name)) fail(); if (/CREATE/i.test(kind)) { if(name!==desc.name) fail(); changed=true; }
    return `${kind} ${q(PREFIX+name)}`;
  });
  if(!changed) fail(); return sql;
}
async function assertOperatorLedger(target:D1Database,contract:AuthorityRestoreContract){
 if(contract.targetOperatorLedgerDigest===undefined)return;
 const rows=(await target.prepare('SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 129').all()).results;
 if(rows.length<1||rows.length>128||await hash(rows)!==contract.targetOperatorLedgerDigest)fail();
}
async function runState(target:D1Database, contract:AuthorityRestoreContract,pin:string) {
  const row=await target.prepare('SELECT run_id,contract_digest,phase FROM _authority_restore_run WHERE id=1').first<{run_id:string;contract_digest:string;phase:string}>();
  if(!row || row.run_id!==contract.runId || row.contract_digest!==pin) fail(); return row;
}
export async function beginAuthorityRestore(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string):Promise<void> {
  await validate(contract,pin); await assertFrozen(source,contract,pin);await assertOperatorLedger(target,contract);
  if(await target.prepare("SELECT 1 FROM sqlite_master WHERE name='_authority_restore_run'").first()) { const state=await runState(target,contract,pin); if(state.phase==='copying'){for(const copy of contract.typedCopies)await beginRawTelemetryCopy(target,copy);if(contract.admissionContract)await initializeStorageSource(target,contract.sourceId);} return; }
  if(await hash(await authoritySchemaInventory(target))!==contract.targetBaseSchemaDigest) fail();
  if(await target.prepare('PRAGMA foreign_keys').first('foreign_keys')!==1) fail();
  for(const object of contract.targetBaseSchema.filter(x=>x.type==='table')){
    if(['typed_telemetry_schema','typed_v1_analytical_schema'].includes(object.name)){if(canonicalJson((await target.prepare(`SELECT * FROM ${q(object.name)} LIMIT 2`).all()).results)!==canonicalJson([{id:1,version:1}]))fail();}
    else if(object.name==='ingestion_analytics_separation'){if(canonicalJson((await target.prepare('SELECT * FROM ingestion_analytics_separation LIMIT 2').all()).results)!==canonicalJson([{id:1,phase:'prepared',policy_revision:1,empty_source_check:1}]))fail();}
    else if(object.name==='d1_storage_migrations'){await assertOperatorLedger(target,contract);}
    else if(object.name==='d1_migrations'){const rows=(await target.prepare('SELECT * FROM d1_migrations ORDER BY id LIMIT 129').all()).results;if(rows.length>128||await hash(rows)!==contract.targetMigrationLedgerDigest)fail();}
    else if(await target.prepare(`SELECT 1 FROM ${q(object.name)} LIMIT 1`).first())throw new Error('AUTHORITY_RESTORE_TARGET_NOT_EMPTY');
  }
  const desc=await descriptors(source,contract), names=new Set(desc.map(x=>x.name));
  if(contract.targetBaseSchema.some(x=>names.has(x.name))) fail();
  const statements=AUTHORITY_RESTORE_SCHEMA.map(sql=>target.prepare(sql));
  statements.push(target.prepare("INSERT INTO _authority_restore_run VALUES(1,?,?,?,'copying')").bind(contract.runId,pin,contract.operatingLimitBytes));
  for(const d of desc) {
    statements.push(target.prepare(stageSql(d,names)),target.prepare('INSERT INTO _authority_restore_tables(name,ordinal,descriptor) VALUES(?,?,?)').bind(d.name,desc.indexOf(d),canonicalJson(d)));
    for(const verb of ['UPDATE','DELETE']) statements.push(target.prepare(frozenTrigger(verb,PREFIX+d.name,'_authority_stage_guard_').sql));
    statements.push(target.prepare(`CREATE TRIGGER ${q('_authority_stage_insert_'+d.name)} BEFORE INSERT ON ${q(PREFIX+d.name)}
      WHEN NOT EXISTS(SELECT 1 FROM _authority_restore_permission p JOIN _authority_restore_tables t ON t.name=p.name
      JOIN _authority_restore_run r ON r.id=1 WHERE p.name='${d.name}' AND t.copy_done=0 AND r.phase='copying')
      BEGIN SELECT RAISE(ABORT,'AUTHORITY_RESTORE_WRITE_DENIED'); END`));
  }
  for(let offset=0;offset<contract.finalSchema.length;offset+=20){const page=contract.finalSchema.slice(offset,offset+20);statements.push(target.prepare(`INSERT INTO _authority_restore_expected VALUES ${page.map(()=>'(?,?,?,?)').join(',')}`).bind(...page.flatMap(object=>[object.name,object.type,object.tbl_name,object.sql])));}
  for(const copy of contract.typedCopies){statements.push(target.prepare('INSERT INTO _authority_restore_typed(format,run_id) VALUES(?,?)').bind(copy.format,copy.runId));if(contract.admissionContract)statements.push(target.prepare('INSERT INTO _authority_restore_adoption(format,high_water) VALUES(?,?)').bind(copy.format,copy.format==='v1'?(contract.authoritySequences.find(x=>x.name==='telemetry_v1_records')?.sequence??0):0));}
  await checkCapacity(target,contract);
  if(statements.length>900) fail();
  try { await target.batch(statements); } catch { if (!await target.prepare("SELECT 1 FROM sqlite_master WHERE name='_authority_restore_run'").first()) throw new Error('AUTHORITY_RESTORE_INITIALIZATION_UNACKNOWLEDGED'); await runState(target,contract,pin); }
  await checkCapacity(target,contract);
  for(const copy of contract.typedCopies) await beginRawTelemetryCopy(target,copy);
  if(contract.admissionContract)await initializeStorageSource(target,contract.sourceId);
}
function cell(value:unknown):Cell {
  if(value===null)return ['null']; if(typeof value==='string')return ['text',value];
  if(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return ['number',value];
  if(value instanceof ArrayBuffer)value=Array.from(new Uint8Array(value));
  if(Array.isArray(value)&&value.every(x=>Number.isInteger(x)&&x>=0&&x<=255))return ['blob',value];
  return fail();
}
function binding(c:Cell):string|number|null|ArrayBuffer { return c[0]==='null'?null:c[0]==='blob'?Uint8Array.from(c[1]).buffer:c[1]; }
async function page(db:D1Database,d:Descriptor,cursor:Cursor,staged:boolean):Promise<EncodedRow[]> {
  const fields=[...(d.rowid?['rowid AS _authority_original_rowid']:[]),...d.columns.map(q)];
  const keys=d.rowid?['rowid']:d.keys.map(q);
  if(cursor.length&&cursor.length!==keys.length)fail();
  const where=cursor.length?` WHERE (${keys.join(',')})>(${keys.map(()=>'?').join(',')})`:'';
  const relation=q((staged?PREFIX:'')+d.name), bounds=cursor.map(binding);
  // Inspect lengths before materializing values into JavaScript. Six bytes per
  // source byte conservatively bounds JSON escaping and BLOB array encoding.
  const lengths=d.columns.map(name=>`COALESCE(length(CAST(${q(name)} AS BLOB)),0)`).join('+');
  const sizes=(await db.prepare(`SELECT (${lengths}) raw_bytes FROM ${relation}${where} ORDER BY ${keys.join(',')} LIMIT ${MAX_AUTHORITY_COPY_ROWS}`).bind(...bounds).all<{raw_bytes:number}>()).results;
  let limit=0,reserved=0;
  for(const row of sizes){const upper=row.raw_bytes*6+d.columns.length*64+1024;if(!Number.isSafeInteger(upper)||upper>MAX_AUTHORITY_COPY_BYTES)throw new Error('AUTHORITY_RESTORE_ROW_LIMIT');if(reserved+upper>MAX_AUTHORITY_COPY_BYTES)break;reserved+=upper;limit++;}
  const rows=limit?(await db.prepare(`SELECT ${fields.join(',')} FROM ${relation}${where} ORDER BY ${keys.join(',')} LIMIT ?`).bind(...bounds,limit).all<Record<string,unknown>>()).results:[];
  const result:EncodedRow[]=[];let bytes=0;
  for(const row of rows) {
    const encoded={cells:[...(d.rowid?[cell(row._authority_original_rowid)]:[]),...d.columns.map(x=>cell(row[x]))],cursor:d.keys.map(x=>cell(row[x]))};
    if(encoded.cursor.some(x=>x[0]==='null'))fail();
    const size=new TextEncoder().encode(canonicalJson(encoded)).length;
    if(size>MAX_AUTHORITY_COPY_BYTES)throw new Error('AUTHORITY_RESTORE_ROW_LIMIT');
    if(bytes+size>MAX_AUTHORITY_COPY_BYTES)break;result.push(encoded);bytes+=size;
  }
  return result;
}
export async function copyAuthorityPage(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string,kind:'copy'|'verify'='copy') {
  await validate(contract,pin);await assertFrozen(source,contract,pin);
  const state=await runState(target,contract,pin);
  if(state.phase!==(kind==='copy'?'copying':'sealed'))fail();
  const checkpoint=await target.prepare(`SELECT * FROM _authority_restore_tables WHERE ${kind==='copy'?'copy_done':'verify_done'}=0 ORDER BY ordinal LIMIT 1`).first<TableState>();
  if(!checkpoint)return {state:'complete' as const,rows:0};
  const selected=JSON.parse(checkpoint.descriptor) as Descriptor;
  if(selected.name!==checkpoint.name||!contract.tables.some(x=>x.name===selected.name&&x.disposition==='authority'))fail();
  const before=kind==='copy'?checkpoint.copy_cursor:checkpoint.verify_cursor;
  const rows=await page(source,selected,JSON.parse(before) as Cursor,false);
  if(kind==='verify'&&canonicalJson(rows)!==canonicalJson(await page(target,selected,JSON.parse(before) as Cursor,true)))fail();
  await assertFrozen(source,contract,pin);
  const after=rows.length?canonicalJson(rows.at(-1)!.cursor):before, done=rows.length===0?1:0;
  const pageDigest=await hash({name:selected.name,kind,before,after,rows});
  const statements:D1PreparedStatement[]=[];
  if(kind==='copy'&&rows.length) {
    statements.push(target.prepare('INSERT INTO _authority_restore_permission VALUES(1,?)').bind(selected.name));
    const columns=[...(selected.rowid?['rowid']:[]),...selected.columns];
    for(const row of rows)statements.push(target.prepare(`INSERT INTO ${q(PREFIX+selected.name)}(${columns.map(q).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...row.cells.map(binding)));
  }
  if(kind==='copy'&&done){const seq=contract.authoritySequences.find(x=>x.name===selected.name);if(seq){
    statements.push(target.prepare('INSERT INTO sqlite_sequence(name,seq) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)').bind(PREFIX+seq.name,seq.sequence,PREFIX+seq.name),target.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').bind(seq.sequence,PREFIX+seq.name));
  }}
  if(kind==='verify'&&done){const seq=contract.authoritySequences.find(x=>x.name===selected.name);if(seq && await target.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(PREFIX+seq.name).first<number>('seq')!==seq.sequence)fail();}
  statements.push(target.prepare('INSERT INTO _authority_restore_pages VALUES(?,?,?,?,?,?,?)').bind(selected.name,kind,before,after,pageDigest,rows.length,done),
    target.prepare('DELETE FROM _authority_restore_permission'));
  await checkCapacity(target,contract);
  try{await target.batch(statements);}catch{
    const receipt=await target.prepare('SELECT digest FROM _authority_restore_pages WHERE name=? AND kind=? AND after_cursor=?').bind(selected.name,kind,before).first<{digest:string}>();
    if(receipt?.digest!==pageDigest)throw new Error('AUTHORITY_RESTORE_PAGE_UNACKNOWLEDGED');
  }
  await checkCapacity(target,contract);
  return {state:'progress' as const,rows:rows.length};
}
export async function copyAuthorityTypedPage(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string,format:'v1'|'v11') {
  await validate(contract,pin);await assertFrozen(source,contract,pin);if((await runState(target,contract,pin)).phase!=='copying')fail();
  const copy=contract.typedCopies.find(x=>x.format===format);if(!copy)fail();
  await checkCapacity(target,contract);
  // Reserve both fresh source proofs, bounded receipts and driver overhead.
  const result=await copyLegacyTelemetryPage(source,target,copy,{maxStatements:Math.min(800,900-64-2*contract.authoritySequences.length)});await assertFrozen(source,contract,pin);await checkCapacity(target,contract);return result;
}
export async function sealAuthorityRestore(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string) {
  await validate(contract,pin);await assertFrozen(source,contract,pin);const state=await runState(target,contract,pin);if(state.phase==='sealed')return;if(state.phase!=='copying')fail();
  for(const copy of contract.typedCopies){
    const checkpoint=await target.prepare('SELECT last_source_row_id FROM storage_raw_copy_runs WHERE run_id=?').bind(copy.runId).first<{last_source_row_id:number}>();
    if(!checkpoint || (await readLegacyTelemetryCopyPage(source,{sourceNamespace:copy.sourceNamespace,format:copy.format,afterSourceRowId:checkpoint.last_source_row_id})).length)throw new Error('AUTHORITY_RESTORE_TYPED_COPY_INCOMPLETE');
  }
  const statements=contract.targetBaseSchema.filter(x=>x.type==='table').flatMap(x=>['INSERT','UPDATE','DELETE'].map(verb=>target.prepare(frozenTrigger(verb,x.name,'_authority_seal_').sql)));
  statements.push(target.prepare("UPDATE _authority_restore_run SET phase='sealed' WHERE id=1"));await target.batch(statements);
}
export async function verifyAuthorityTypedPage(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string,format:'v1'|'v11') {
  await validate(contract,pin);await assertFrozen(source,contract,pin);if((await runState(target,contract,pin)).phase!=='sealed')fail();
  const copy=contract.typedCopies.find(x=>x.format===format);if(!copy)fail();
  const state=await target.prepare('SELECT verify_cursor,verified,done FROM _authority_restore_typed WHERE format=? AND run_id=?').bind(format,copy.runId).first<{verify_cursor:number;verified:number;done:number}>();if(!state)fail();if(state.done)return {reachedEnd:true,verified:0};
  const result=await verifyLegacyTelemetryCopyPage(source,target,copy,state.verify_cursor);await assertFrozen(source,contract,pin);
  const row=await target.prepare(`UPDATE _authority_restore_typed SET verify_cursor=?,verified=verified+?,done=? WHERE format=? AND verify_cursor=? AND done=0 RETURNING verify_cursor`)
    .bind(result.afterSourceRowId,result.verified,result.reachedEnd?1:0,format,state.verify_cursor).all();
  if(row.results.length!==1){const now=await target.prepare('SELECT verify_cursor,verified,done FROM _authority_restore_typed WHERE format=?').bind(format).first<{verify_cursor:number;verified:number;done:number}>();if(!now||now.verify_cursor!==result.afterSourceRowId||now.verified!==state.verified+result.verified||now.done!==(result.reachedEnd?1:0))throw new Error('AUTHORITY_RESTORE_VERIFY_RECONCILE_REQUIRED');}return result;
}
export async function completeAuthorityVerification(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string) {
  await validate(contract,pin);await assertFrozen(source,contract,pin);const state=await runState(target,contract,pin);if(state.phase==='verified')return;if(state.phase!=='sealed')fail();
  await target.prepare("UPDATE _authority_restore_run SET phase='verified' WHERE id=1").run();
}
/** Final role SQL is independently reviewed and hash-pinned, not a callback or
 * ready=true assertion. SQL inventory and all FKs are compared INSIDE the same
 * batch exposing original names under a temporary write freeze. D1 FK/provider
 * size checks run while frozen, then a final batch removes only that freeze and
 * marks ready. Any installation mismatch rolls back; verification failure stays
 * installed but unbound and write-frozen.
 */
export async function promoteAuthorityRestore(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string) {
  await validate(contract,pin);await assertFrozen(source,contract,pin);const state=await runState(target,contract,pin);if(state.phase==='ready'){await checkFinal(target,contract);return;}if(!['verified','installed'].includes(state.phase))fail();
  if(state.phase==='installed')return;
  const desc=await descriptors(source,contract);
  const controlTriggers=(await target.prepare("SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' AND (name GLOB '_authority_stage_*' OR name GLOB '_authority_seal_*') ORDER BY name LIMIT 800").all<{name:string;sql:string;tbl_name:string}>()).results;
  const statements:D1PreparedStatement[]=[],guardProofs:{name:string;sql:string;tbl_name:string}[]=[];
  // Keep existing temporary guards attached while SQLite renames their tables.
  // Replacing all of them would needlessly double the atomic DDL batch.
  for(const guard of controlTriggers){let sql=guard.sql;for(const d of desc)sql=sql.split(q(PREFIX+d.name)).join(q(d.name));
    guardProofs.push({name:guard.name,sql,tbl_name:guard.tbl_name.startsWith(PREFIX)?guard.tbl_name.slice(PREFIX.length):guard.tbl_name});}
  for(const d of desc)statements.push(target.prepare(`ALTER TABLE ${q(PREFIX+d.name)} RENAME TO ${q(d.name)}`));
  const existing=new Set([...contract.targetBaseSchema.map(x=>x.name),...desc.map(x=>x.name)]);
  for(const type of ['table','index','view','trigger'])for(const object of contract.finalSchema)if(object.type===type&&!existing.has(object.name))statements.push(target.prepare(object.sql));
  for(const object of contract.finalSchema.filter(x=>x.type==='table'&&!existing.has(x.name)))for(const verb of ['INSERT','UPDATE','DELETE']){const guard=frozenTrigger(verb,object.name,'_authority_final_guard_');statements.push(target.prepare(guard.sql));guardProofs.push({...guard,tbl_name:object.name});}
  for(let offset=0;offset<guardProofs.length;offset+=30){const page=guardProofs.slice(offset,offset+30);statements.push(target.prepare(`INSERT INTO _authority_restore_installed_guards VALUES ${page.map(()=>'(?,?,?)').join(',')}`).bind(...page.flatMap(x=>[x.name,x.sql,x.tbl_name])));}
  statements.push(target.prepare("UPDATE _authority_restore_run SET phase='installed' WHERE id=1"));
  if(statements.length>900)fail();
  try{await target.batch(statements);}catch{if((await runState(target,contract,pin)).phase!=='installed')throw new Error('AUTHORITY_RESTORE_PROMOTION_UNACKNOWLEDGED');}
  // Run finalizeAuthorityRestore in the next bounded operator invocation.
}

export async function finalizeAuthorityRestore(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string){
 await validate(contract,pin);await assertFrozen(source,contract,pin);const state=await runState(target,contract,pin);
 if(state.phase==='ready'){await checkFinal(target,contract);return;}
 if(state.phase!=='installed')fail();await finishPromotion(target,contract,pin);
}

/** D1 forbids table-valued PRAGMAs in triggers. These physical checks run while
 * every target application table is frozen. They observe allocation; they do not
 * claim an atomic provider reservation. The unbound restore requires exclusive
 * operator access and must leave capacity for the next bounded write. */
async function checkCapacity(db:D1Database,contract:AuthorityRestoreContract){
 const result=await db.prepare('SELECT 1 AS capacity_probe').all();
 const bytes=result.meta.size_after;
 if(!Number.isSafeInteger(bytes)||bytes<0||bytes>contract.operatingLimitBytes)throw new Error('AUTHORITY_RESTORE_CAPACITY');
}
async function checkFinal(db:D1Database,contract:AuthorityRestoreContract){
 await assertOperatorLedger(db,contract);
 await checkCapacity(db,contract);
 if(await hash(await authoritySchemaInventory(db))!==contract.finalSchemaDigest||(await db.prepare('PRAGMA foreign_key_check').all()).results.length)throw new Error('AUTHORITY_RESTORE_FINAL_CHECK_FAILED');
}
async function finishPromotion(db:D1Database,contract:AuthorityRestoreContract,pin:string){
 await checkFinal(db,contract);
 const expected=(await db.prepare('SELECT name,sql,tbl_name FROM _authority_restore_installed_guards ORDER BY name LIMIT 801').all<{name:string;sql:string;tbl_name:string}>()).results;
 const actual=(await db.prepare("SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' AND (name GLOB '_authority_stage_*' OR name GLOB '_authority_seal_*' OR name GLOB '_authority_final_guard_*') ORDER BY name LIMIT 801").all<{name:string;sql:string;tbl_name:string}>()).results;
 if(expected.length>800||canonicalJson(actual)!==canonicalJson(expected))fail();
 const names=expected.map(x=>x.name);
 const statements=names.map(name=>db.prepare(`DROP TRIGGER ${q(name)}`));
 statements.push(db.prepare("UPDATE _authority_restore_run SET phase='ready' WHERE id=1"));
 try{await db.batch(statements);}catch{if((await runState(db,contract,pin)).phase!=='ready')throw new Error('AUTHORITY_RESTORE_READY_UNACKNOWLEDGED');}
}

export async function adoptAuthorityTypedPage(source:D1Database,target:D1Database,contract:AuthorityRestoreContract,pin:string,format:'v1'|'v11',verify=false){
 await validate(contract,pin);await assertFrozen(source,contract,pin);if(!contract.admissionContract||!contract.typedCopies.some(x=>x.format===format))fail();
 if(await target.prepare('SELECT 1 FROM _authority_restore_tables WHERE copy_done=0 LIMIT 1').first())throw new Error('AUTHORITY_RESTORE_AUTHORITY_INCOMPLETE');
 // The adapter admits a deterministic prefix from exact distinct memberships,
 // including all reads, proof writes, checkpoint/CAS and uncertain readback.
 const result=await restoreTypedAdmissionPage(target,{format,sourceNamespace:contract.sourceNamespace,contractDigest:pin,verify,limit:200,maxStatements:900-64-2*contract.authoritySequences.length});
 await assertFrozen(source,contract,pin);await checkCapacity(target,contract);return result;
}
