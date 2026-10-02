import {sha256Hex} from '../../src/crypto';
import {canonicalJson} from '../../src/canonical-json';
import {createD1InvocationBudget} from '../../src/d1-invocation-budget';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './analytics-profile';
// This local-only validator is shared with the Node qualification gate.
// @ts-expect-error The reviewed benchmark-only ESM module has no TS declarations.
import {MUTATION_SNAPSHOT_SCHEMA,MUTATION_TARGET_TABLES} from '../../scripts/analytics-workload-mutation-proof.mjs';

export type MutationCell=readonly [type:'null'|'text'|'blob'|'integer'|'real',value:string|null];
export interface MutationTable {
 columns:{name:string;type:string}[];keyColumns:string[];
 rows:{key:MutationCell[];cells:MutationCell[]}[];
}
export interface MutationStepPreimage {eventDigest:string;revision:number;preimage:Record<string,unknown>}
export interface MutationSnapshot {
 schemaVersion:'analytics-mutation-logical-snapshot-v1';
 source:{schemaSha256:string;tables:Record<string,MutationTable>};
 target:{schemaSha256:string;tables:Record<string,MutationTable>;stepPreimages:MutationStepPreimage[]};
 affectedDays:string[];
}
const fail=()=>{throw Error('ANALYTICS_MUTATION_CAPTURE_INVALID');};
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const cell=(column:string)=>`json_array(typeof(${column}),CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) WHEN 'integer' THEN quote(${column}) WHEN 'real' THEN quote(${column}) ELSE ${column} END)`;
function compareKeys(a:readonly MutationCell[],b:readonly MutationCell[]):number {
 for(let i=0;i<a.length;i++){
  const x=a[i]!,y=b[i]!;if(x[0]!==y[0])return x[0]<y[0]?-1:1;if(x[1]===y[1])continue;
  if(x[0]==='integer')return BigInt(x[1]!)<BigInt(y[1]!)?-1:1;
  if(x[0]==='real')return Number(x[1])<Number(y[1])?-1:1;
  return String(x[1])<String(y[1])?-1:1;
 }return 0;
}
async function captureStore(db:D1Database,selection?:readonly string[]) {
 const schema=(await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'
  AND name NOT GLOB '_cf_*' AND name!='d1_migrations' AND tbl_name!='d1_migrations' ORDER BY type,name`)
  .all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 const catalog=schema.filter(row=>row.type==='table');
 if(catalog.length>300||catalog.some(row=>! /^[a-z][a-z0-9_]*$/u.test(row.name)))fail();
 if(selection&&(new Set(selection).size!==selection.length||selection.some(name=>!catalog.some(row=>row.name===name))))fail();
 const tables:Record<string,MutationTable>={};let rows=0,logicalBytes=0;
 for(const table of catalog.filter(row=>!selection||selection.includes(row.name))) {
  const info=(await db.prepare('SELECT name,type,pk FROM pragma_table_info(?) ORDER BY cid').bind(table.name)
   .all<{name:string;type:string;pk:number}>()).results;
  if(!info.length||info.length>128)fail();
  const primary=info.filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk).map(column=>column.name);
  if(!primary.length&&(info.some(column=>['rowid','_rowid_','oid'].includes(column.name))||/WITHOUT\s+ROWID/iu.test(table.sql)))fail();
  const keyColumns=primary.length?primary:['rowid'],key=keyColumns.map(quote),columns=info.map(({name,type})=>({name,type}));
  const captured:MutationTable={columns,keyColumns,rows:[]};
  for(let page=0;page<1000;page++) {
   const pageRows=(await db.prepare(`SELECT json_array(${key.map(cell).join(',')}) AS key_json,
    json_array(${columns.map(column=>cell(quote(column.name))).join(',')}) AS cells_json FROM ${quote(table.name)}
    ORDER BY ${key.join(',')} LIMIT 128 OFFSET ?`).bind(page*128).all<{key_json:string;cells_json:string}>()).results;
   for(const row of pageRows){logicalBytes+=new TextEncoder().encode(row.key_json+row.cells_json).length;
    if(++rows>100_000||logicalBytes>32*1024*1024)fail();
    captured.rows.push({key:JSON.parse(row.key_json) as MutationCell[],cells:JSON.parse(row.cells_json) as MutationCell[]});}
   if(pageRows.length<128)break;if(page===999)fail();
  }
  // Match the validator's closed typed-key order; initial clone proof separately
  // establishes actual SQLite rowid and native lexical ordering before upgrades.
  captured.rows.sort((a,b)=>compareKeys(a.key,b.key));
  if(captured.rows.some((row,index)=>index>0&&compareKeys(captured.rows[index-1]!.key,row.key)>=0))fail();
  tables[table.name]=captured;
 }
 return {schemaSha256:await sha256Hex(canonicalJson(schema)),tables,counts:{tables:Object.keys(tables).length,rows,logicalBytes}};
}
/** Synthetic local rows/preimages remain memory-only. Measurement covers the
 * capture itself, outside admission/delivery or analytical performance costs. */
export async function captureAnalyticsMutationSnapshot(input:{source:D1Database;target:D1Database;
 stepPreimages?:readonly MutationStepPreimage[];affectedDays?:readonly string[]}) {
 const profile=createAnalyticsProfile(),meter=createD1InvocationBudget(950),started=performance.now();
 const source=await captureStore(meter.wrap(profileAnalyticsDatabase(input.source,'source',profile,()=> 'mutation_capture')));
 const target=await captureStore(meter.wrap(profileAnalyticsDatabase(input.target,'target',profile,()=> 'mutation_capture')),MUTATION_TARGET_TABLES as readonly string[]);
 const steps=structuredClone([...input.stepPreimages??[]]),affectedDays=[...input.affectedDays??[]].sort();
 if(steps.length>100_000||new Set(affectedDays).size!==affectedDays.length)fail();
 const snapshot:MutationSnapshot={schemaVersion:MUTATION_SNAPSHOT_SCHEMA as MutationSnapshot['schemaVersion'],
  source:{schemaSha256:source.schemaSha256,tables:source.tables},target:{schemaSha256:target.schemaSha256,tables:target.tables,stepPreimages:steps},affectedDays};
 profile.wallMs=performance.now()-started;profile.invocations=1;profile.maximumStatementsPerInvocation=meter.queriesUsed;
 return {snapshot,measurement:summarizeAnalyticsProfile(profile),counts:{source:source.counts,target:target.counts,steps:steps.length},
  snapshotSha256:await sha256Hex(canonicalJson(snapshot))};
}
