import { AUTHORITY_ADMISSION_TABLES } from './authority-restore-adoption';
import { authoritySchemaInventory, authoritySchemaDigest, authorityRestoreRetainedTableNames, type AuthoritySchemaObject } from './authority-restore';

const fail=()=>new Error('AUTHORITY_RESTORE_ROLE_UNQUALIFIED');
const quoted=(name:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))throw fail();return `"${name}"`;};
/** Token-aware enough for the closed maintained DDL: never rewrite comments or
 * quoted string values. Unsupported table identifiers refuse qualification. */
function references(sql:string,names:Set<string>,staged:boolean,ownName?:string){
 let own=false;
 const result=sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|\b(CREATE\s+TABLE|REFERENCES)\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/gi,(full,kind:string,quote:string,bare:string)=>{
  if(!kind)return full;const name=quote??bare;
  if(/CREATE/i.test(kind)){if(!ownName)return full;if(name!==ownName)throw fail();own=true;return `${kind} ${quoted(staged?'_authority_stage_'+name:name)}`;}
  return names.has(name)?`${kind} ${quoted(staged?'_authority_stage_'+name:name)}`:full;
 });
 if(ownName&&!own)throw fail();return result;
}
export function authorityRoleFinalSchema(reference:AuthoritySchemaObject[]):AuthoritySchemaObject[]{
 const retained=new Set(authorityRestoreRetainedTableNames());
 return reference.map(object=>({...object,sql:object.type==='table'&&(retained.has(object.name)||AUTHORITY_ADMISSION_TABLES.includes(object.name))
  ?references(object.sql,retained,false,retained.has(object.name)?object.name:undefined):object.sql}));
}
/** Build only the fresh unbound typed foundation and trigger-free adoption
 * metadata from an exact reviewed disposable role reference. This is NOT an
 * ordinary role migration and does not invent applied-migration ledger rows.
 * Retained authority, final role effects and readiness are coordinator-owned. */
export async function prepareAuthorityRoleTarget(reference:D1Database,target:D1Database,referenceSchemaDigest:string){
 const inventory=await authoritySchemaInventory(reference);
 if(await authoritySchemaDigest(inventory)!==referenceSchemaDigest||(await authoritySchemaInventory(target)).length)throw fail();
 const retained=new Set(authorityRestoreRetainedTableNames());
 const baseNames=new Set(inventory.filter(x=>x.type==='table'&&(x.name.startsWith('typed_telemetry_')||x.name.startsWith('storage_raw_copy_')||['storage_source_state','storage_owner_revisions','storage_ingestion_changes','typed_v1_analytical_schema','ingestion_analytics_separation'].includes(x.name))).map(x=>x.name));
 const adoptionNames=new Set(AUTHORITY_ADMISSION_TABLES);
 for(const name of adoptionNames)if(!inventory.some(x=>x.type==='table'&&x.name===name))throw fail();
 const objects=inventory.filter(x=>x.type==='table'&&(baseNames.has(x.name)||adoptionNames.has(x.name))
  ||x.type==='view'&&(x.name.startsWith('typed_telemetry_')||x.name==='typed_v11_record_admissions')
  ||x.type==='index'&&baseNames.has(x.tbl_name)
  ||x.type==='trigger'&&baseNames.has(x.tbl_name)&&(x.name.startsWith('typed_telemetry_')||x.name.startsWith('storage_raw_copy_')||['typed_v1_quota_analysis_initial','typed_v1_quota_analysis_keys','storage_source_identity_immutable','storage_ingestion_change_validate','storage_ingestion_change_commit','storage_ingestion_change_immutable','storage_ingestion_change_retained'].includes(x.name)));
 const ordered=['table','index','view','trigger'].flatMap(type=>objects.filter(x=>x.type===type));
 const statements=ordered.map(object=>target.prepare(object.type==='table'&&adoptionNames.has(object.name)?references(object.sql,retained,true):object.sql));
 statements.push(target.prepare('INSERT INTO typed_telemetry_schema VALUES(1,1)'));
 if(baseNames.has('typed_v1_analytical_schema'))statements.push(target.prepare('INSERT INTO typed_v1_analytical_schema VALUES(1,1)'));
 if(baseNames.has('ingestion_analytics_separation'))statements.push(target.prepare("INSERT INTO ingestion_analytics_separation VALUES(1,'prepared',1,1)"));
 if(statements.length>400)throw fail();
 await target.batch(statements);
 const baseSchema=await authoritySchemaInventory(target);
 return {baseSchema,baseSchemaDigest:await authoritySchemaDigest(baseSchema),finalSchema:authorityRoleFinalSchema(inventory),referenceSchemaDigest};
}
