import { env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';

// A local support probe, not a VDBE interpreter. SQL/results/opcode operands
// remain local; its receipt contains only closed labels, hashes and counters.
type Unsupported = 'unavailable_extension' | 'authorization_refused' | 'syntax_unsupported' | 'capability_unsupported';
type Attempt<T> = { status: 'supported'; value: T } | { status: 'unsupported'; reason: Unsupported };
type SchemaRow = {type:string;name:string;tbl_name:string;rootpage:number;sql:string|null};
type Opcode = {addr:number;opcode:string;p1:number;p2:number;p3:number;p4:string|number|null;p5:number;comment:string|null};
const PREFIX = 'synthetic_explain_';
const MAX_OPCODE_ROWS = 1024;
const MAX_CASES = 16;
function unsupported(error:unknown):Unsupported|undefined {
 const message=error instanceof Error?error.message:String(error);
 if(/no such (?:table|function|module):?\s*(?:tables_used|fts5|sqlite_source_id)/iu.test(message))return 'unavailable_extension';
 if(/not authorized|authorization denied/iu.test(message))return 'authorization_refused';
 if(/syntax error/iu.test(message))return 'syntax_unsupported';
 if(/not supported|unsupported/iu.test(message))return 'capability_unsupported';
}
async function optional<T>(run:()=>Promise<T>):Promise<Attempt<T>> {
 try{return {status:'supported',value:await run()};}
 catch(error){const reason=unsupported(error);if(reason)return {status:'unsupported',reason};
  throw new Error('EXPLAIN_CAPABILITY_UNEXPECTED_DATABASE_FAILURE');}
}
const descriptor=<T>(result:Attempt<T>)=>result.status==='supported'?{status:'supported' as const}:result;
const cleanShape=(rows:unknown[]):rows is Opcode[]=>rows.length>0&&rows.length<=MAX_OPCODE_ROWS&&rows.every(value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const row=value as Record<string,unknown>;
 return Object.keys(row).sort().join(',')==='addr,comment,opcode,p1,p2,p3,p4,p5'
  &&['addr','p1','p2','p3','p5'].every(key=>Number.isSafeInteger(row[key]))
  &&typeof row.opcode==='string'&&/^[A-Za-z][A-Za-z0-9]*$/u.test(row.opcode)
  &&(row.p4===null||typeof row.p4==='string'||typeof row.p4==='number')
  &&(row.comment===null||typeof row.comment==='string');
});

it('probes local EXPLAIN physical dependency visibility without claiming executed scans or general column lineage', async()=>{
 await reset();
 const meter=createD1InvocationBudget(950),profile=createAnalyticsProfile();let phase='setup';
 const db=profileAnalyticsDatabase(meter.wrap(env.USAGE_MONITOR_DB),'source',profile,()=>phase);
 const setup=[
  `CREATE TABLE ${PREFIX}facts(id INTEGER PRIMARY KEY,owner TEXT,day TEXT,tokens INTEGER,payload TEXT)`,
  `CREATE INDEX ${PREFIX}cover ON ${PREFIX}facts(owner,tokens)`,
  `CREATE INDEX ${PREFIX}day ON ${PREFIX}facts(day)`,
  `CREATE VIEW ${PREFIX}view AS SELECT owner AS identity_hint,tokens AS revision_hint FROM ${PREFIX}facts`,
  `CREATE VIEW ${PREFIX}nested AS SELECT * FROM ${PREFIX}view`,
  `CREATE TABLE ${PREFIX}controls(id INTEGER PRIMARY KEY,ready INTEGER)`,
  `CREATE TABLE ${PREFIX}reordered(nonkey TEXT,code TEXT PRIMARY KEY,amount INTEGER) WITHOUT ROWID`,
  `CREATE TABLE ${PREFIX}actions(id INTEGER PRIMARY KEY)`,
  `CREATE TABLE ${PREFIX}marks(id INTEGER PRIMARY KEY,total INTEGER)`,
  `CREATE TRIGGER ${PREFIX}trigger AFTER INSERT ON ${PREFIX}actions BEGIN INSERT INTO ${PREFIX}marks SELECT NEW.id,sum(tokens) FROM ${PREFIX}facts; END`,
 ];
 for(const sql of setup)await db.prepare(sql).run();
 await db.prepare(`INSERT INTO ${PREFIX}facts VALUES(?,?,?,?,?)`).bind(1,'synthetic','2000-01-01',4,'synthetic-body').run();
 await db.prepare(`INSERT INTO ${PREFIX}controls VALUES(1,1)`).run();
 await db.prepare(`INSERT INTO ${PREFIX}reordered VALUES(?,?,?)`).bind('synthetic','synthetic',4).run();
 const virtual=await optional(()=>db.prepare(`CREATE VIRTUAL TABLE ${PREFIX}search USING fts5(body)`).run());
 phase='capability';
 const version=await optional(()=>db.prepare('SELECT sqlite_version() AS version').first<{version:string}>());
 if(version.status==='supported'){expect(typeof version.value?.version).toBe('string');expect(version.value?.version).toMatch(/^\d+\.\d+\.\d+/u);}
 const sourceId=await optional(()=>db.prepare('SELECT sqlite_source_id() AS source_id').first<{source_id:string}>());
 const schema=await optional(()=>db.prepare(`SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name LIKE ? ORDER BY type,name`).bind(`${PREFIX}%`).all<SchemaRow>());
 const roots=new Map<number,SchemaRow>();
 if(schema.status==='supported'){
  expect(schema.value.results.length).toBeGreaterThanOrEqual(setup.length);
  for(const row of schema.value.results){
   expect(['table','index','view','trigger'].includes(row.type)).toBe(true);
   expect(Number.isSafeInteger(row.rootpage)&&row.rootpage>=0).toBe(true);
   expect(row.name.startsWith(PREFIX)).toBe(true);
   if(row.rootpage>0){expect(roots.has(row.rootpage)).toBe(false);roots.set(row.rootpage,row);}
  }
  expect(schema.value.results.filter(row=>row.type==='view').every(row=>row.rootpage===0)).toBe(true);
 }
 const indexInfo=await optional(()=>db.prepare(`PRAGMA index_xinfo('${PREFIX}cover')`).all<{seqno:number;cid:number;name:string|null;desc:number;coll:string;key:number}>());
 if(indexInfo.status==='supported'){
  expect(indexInfo.value.results.map(row=>[row.seqno,row.cid,row.key])).toEqual([[0,1,1],[1,3,1],[2,-1,0]]);
 }
 const tableInfo=await optional(()=>db.prepare(`PRAGMA table_xinfo('${PREFIX}facts')`).all<{cid:number;name:string;hidden:number}>());
 if(tableInfo.status==='supported')expect(tableInfo.value.results.map(row=>[row.cid,row.hidden])).toEqual([[0,0],[1,0],[2,0],[3,0],[4,0]]);
 const withoutRowidInfo=await optional(()=>db.prepare(`PRAGMA index_xinfo('${PREFIX}reordered')`).all<{seqno:number;cid:number}>());
 if(withoutRowidInfo.status==='supported')expect(withoutRowidInfo.value.results.map(row=>[row.seqno,row.cid])).toEqual([[0,1],[1,0],[2,2]]);
 const cases:{label:string;sql:string;binds:unknown[];refusedReason?:string}[]=[
  {label:'direct_alias',sql:`SELECT tokens AS revision_hint FROM ${PREFIX}facts WHERE id=?`,binds:[1]},
  {label:'nested_view_alias',sql:`SELECT revision_hint FROM ${PREFIX}nested WHERE identity_hint=?`,binds:['synthetic']},
  {label:'covering_index',sql:`SELECT tokens FROM ${PREFIX}facts INDEXED BY ${PREFIX}cover WHERE owner=?`,binds:['synthetic']},
  {label:'metadata_presence',sql:`SELECT EXISTS(SELECT 1 FROM ${PREFIX}facts WHERE owner=?) AS ready`,binds:['synthetic']},
  {label:'aggregate_no_column',sql:`SELECT count(*) AS revision_hint FROM ${PREFIX}facts`,binds:[]},
  {label:'false_parameter',sql:`SELECT tokens FROM ${PREFIX}facts WHERE ?=1`,binds:[0]},
  {label:'constant_false',sql:`SELECT tokens FROM ${PREFIX}facts WHERE 0`,binds:[]},
  {label:'payload_predicate_metadata_result',sql:`SELECT id FROM ${PREFIX}facts WHERE payload=?`,binds:['synthetic-body']},
  {label:'materialized_cte',sql:`WITH x AS MATERIALIZED(SELECT tokens FROM ${PREFIX}facts) SELECT sum(tokens) FROM x`,binds:[],refusedReason:'ephemeral_column_lineage'},
  {label:'without_rowid',sql:`SELECT nonkey,amount FROM ${PREFIX}reordered WHERE code=?`,binds:['synthetic'],refusedReason:'reordered_record_layout'},
  {label:'metadata_table_only',sql:`SELECT ready FROM ${PREFIX}controls WHERE id=?`,binds:[1]},
  {label:'write_trigger_subprogram',sql:`INSERT INTO ${PREFIX}actions VALUES(?)`,binds:[2],refusedReason:'trigger_subprogram'},
 ];
 if(virtual.status==='supported')cases.push({label:'virtual_table',sql:`SELECT body FROM ${PREFIX}search WHERE ${PREFIX}search MATCH ?`,binds:['synthetic'],refusedReason:'virtual_table'});
 expect(cases.length).toBeLessThanOrEqual(MAX_CASES);
 const readings:Record<string,unknown>[]=[];
 phase='diagnostic_explain';
 for(const entry of cases){
  const explained=await optional(()=>db.prepare('EXPLAIN '+entry.sql).bind(...entry.binds).all<unknown>());
  if(explained.status!=='supported'){readings.push({case:entry.label,...descriptor(explained),noRescanQualified:false});continue;}
  expect(cleanShape(explained.value.results),'EXPLAIN fixed result schema and opcode bound').toBe(true);
  const ops=explained.value.results as Opcode[];
  const opens=ops.filter(row=>['OpenRead','ReopenIdx','OpenWrite'].includes(row.opcode));
  const mapped=opens.map(row=>row.p3===0&&!(row.p5&16)?roots.get(row.p2):undefined);
  const rawRootCount=mapped.filter(row=>row?.tbl_name===`${PREFIX}facts`).length;
  const columnCount=ops.filter(row=>row.opcode==='Column').length;
  const virtualOpcodeCount=ops.filter(row=>['VOpen','VFilter','VColumn','VNext'].includes(row.opcode)).length;
  const subprogramCount=ops.filter(row=>row.opcode==='Program').length;
  if(schema.status==='supported'&&['direct_alias','nested_view_alias','covering_index','metadata_presence','aggregate_no_column','payload_predicate_metadata_result'].includes(entry.label))expect(rawRootCount,entry.label).toBeGreaterThan(0);
  if(entry.label==='covering_index')expect(mapped.some(row=>row?.type==='index')).toBe(true);
  if(entry.label==='aggregate_no_column'||entry.label==='metadata_presence')expect(columnCount,entry.label).toBe(0);
  if(entry.label==='virtual_table'){expect(virtualOpcodeCount).toBeGreaterThan(0);expect(opens.length).toBe(0);}
  if(entry.label==='write_trigger_subprogram')expect(subprogramCount).toBeGreaterThan(0);
  readings.push({case:entry.label,status:'supported',sqlSha256:await sha256Hex(entry.sql),opcodeCount:ops.length,
   persistentOpenCount:opens.length,mappedOpenCount:mapped.filter(Boolean).length,unmappedOpenCount:mapped.filter(row=>!row).length,
   potentialRawRootOpenCount:rawRootCount,indexOpenCount:mapped.filter(row=>row?.type==='index').length,columnOpcodeCount:columnCount,
   virtualOpcodeCount,subprogramCount,ephemeralCursorCount:ops.filter(row=>['OpenEphemeral','OpenPseudo','SorterOpen','OpenAutoindex'].includes(row.opcode)).length,
   classificationGap:entry.refusedReason??null,actualRawRowsRead:null,projectedColumnLineageQualified:false,noRescanQualified:false});
 }
 phase='optional_extension';
 // This documented SQLite extension may be absent in D1. Absence is retained
 // as an unsupported capability, never a zero-access observation.
 const tablesUsed=await optional(()=>db.prepare('SELECT type,schema,name,wr,subprog FROM tables_used(?)').bind(`SELECT revision_hint FROM ${PREFIX}nested`).all<{type:string;schema:string;name:string;wr:number;subprog:string|null}>());
 if(tablesUsed.status==='supported'){
  expect(tablesUsed.value.results.length).toBeGreaterThan(0);
  expect(tablesUsed.value.results.length).toBeLessThanOrEqual(16);
  expect(tablesUsed.value.results.every(row=>['table','index'].includes(row.type)&&row.schema==='main'&&row.name.startsWith(PREFIX)&&row.wr===0&&row.subprog===null)).toBe(true);
 }
 phase='unchanged_and_false_branch_checks';
 expect((await db.prepare(`SELECT count(*) AS n FROM ${PREFIX}actions`).first<{n:number}>())?.n).toBe(0);
 expect((await db.prepare(`SELECT count(*) AS n FROM ${PREFIX}marks`).first<{n:number}>())?.n).toBe(0);
 const falseResult=await db.prepare(`SELECT tokens FROM ${PREFIX}facts WHERE ?=1`).bind(0).all();
 expect(falseResult.results).toEqual([]);
 const finalSchema=await db.prepare(`SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name LIKE ? ORDER BY type,name`).bind(`${PREFIX}%`).all<SchemaRow>();
 if(schema.status==='supported')expect(finalSchema.results).toEqual(schema.value.results);
 const totals=summarizeAnalyticsProfile(profile);
 expect(totals.statements).toBe(meter.queriesUsed);expect(meter.queriesUsed).toBeLessThanOrEqual(950);
 expect(totals.metadataSamples+totals.failedStatements).toBe(totals.statements);
 const receipt={contract:'local-d1-explain-capability-v1',sqliteVersion:version.status==='supported'?{status:'supported',version:version.value!.version}:descriptor(version),
  sqliteSourceId:sourceId.status==='supported'?{status:'supported',sha256:await sha256Hex(sourceId.value?.source_id??'')}:descriptor(sourceId),
  schema: schema.status==='supported'?{status:'supported',sha256:await sha256Hex(JSON.stringify(schema.value.results)),objects:schema.value.results.length,rootpages:roots.size}:descriptor(schema),
  indexXinfo:descriptor(indexInfo),tableXinfo:descriptor(tableInfo),withoutRowidXinfo:descriptor(withoutRowidInfo),virtualTable:descriptor(virtual),
  tablesUsed:tablesUsed.status==='supported'?{status:'supported',returnedObjectCount:tablesUsed.value.results.length}:descriptor(tablesUsed),
  maximumStatements:950,actualStatements:meter.queriesUsed,maximumOpcodeRows:MAX_OPCODE_ROWS,maximumCases:MAX_CASES,readings,
  measured:{costs:profile.costs,statements:totals.statements,failedStatements:totals.failedStatements,metadataSamples:totals.metadataSamples,rowsRead:totals.rowsRead,rowsWritten:totals.rowsWritten,measurementFailures:profile.measurementFailures},
  falseBranch:{returnedRowCount:falseResult.results.length,queryRowsRead:falseResult.meta.rows_read,actualRawRowsRead:null},
  rawSessionExecCoverage:'not_probed',failedStatementResources:'unknown_beyond_attempt_count',actualRawRowsRead:null,projectedColumnLineageQualified:false,noRescanQualified:false};
 console.log('analytics-explain-capability',JSON.stringify(receipt));
},30_000);
