import {sha256Hex} from '../../src/crypto';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './analytics-profile';
import {logicalJson} from './analytics-logical-bytes';

export const SOURCE_SNAPSHOT_CONTRACT='accepted-native-logical-snapshot-v1: generate one accepted synthetic source through the pinned native oracle, then copy its exact installed-Miniflare SQL export into an empty independent source before candidate-only schema upgrades. Export schema/data bytes and actual rowid inventories must match exactly. Admission was executed once and is not a second measured candidate admission. Copy/import/proof costs are laboratory setup, never production restore or incremental mutation evidence. Native/candidate targets and deletion ledgers remain independent.';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

/** Private laboratory copy proof. Exact user schema determines the closed
 * AUTOINCREMENT names; no sequence values or table names enter the receipt. */
async function autoIncrementSequenceDigest(db:D1Database,
 schema:readonly {type:string;name:string;tbl_name:string;sql:string}[]):Promise<string>{
 const unquoted=(sql:string)=>sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/gu,' ');
 const names=schema.filter(row=>row.type==='table'&&/\bAUTOINCREMENT\b/iu.test(unquoted(row.sql))).map(row=>row.name).sort();
 if(names.length>1024||new Set(names).size!==names.length)throw new Error('snapshot sequence schema bound');
 const objects=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='sqlite_sequence'")
  .all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 if(objects.length>1||(objects.length===0&&names.length>0))throw new Error('snapshot sequence storage unavailable');
 if(objects.length===0)return sha256Hex(logicalJson([])!);
 const object=objects[0]!;
 if(object.type!=='table'||object.name!=='sqlite_sequence'||object.tbl_name!=='sqlite_sequence'
  ||object.sql!=='CREATE TABLE sqlite_sequence(name,seq)')throw new Error('snapshot sequence schema mismatch');
 const rows=(await db.prepare(`SELECT name,seq,typeof(name) name_type,typeof(seq) seq_type FROM sqlite_sequence
  WHERE name IN(SELECT value FROM json_each(?)) ORDER BY name LIMIT 1025`).bind(JSON.stringify(names))
  .all<{name:string;seq:number;name_type:string;seq_type:string}>()).results;
 if(rows.length>names.length||new Set(rows.map(row=>row.name)).size!==rows.length
  ||rows.some(row=>row.name_type!=='text'||row.seq_type!=='integer'||!names.includes(row.name)
   ||!Number.isSafeInteger(row.seq)||row.seq<0))throw new Error('snapshot sequence value invalid');
 // A never-used table may genuinely have no sequence entry; that absence is
 // pinned distinctly from zero and from any deleted-row high-water.
 return sha256Hex(logicalJson(names.map(name=>[name,rows.find(row=>row.name===name)?.seq??null]))!);
}

/** Installed Miniflare local-only export. Deliberately bypasses the ordinary
 * profiler because this endpoint returns no D1 resource metadata. */
async function exportLocal(database:D1Database):Promise<string[]> {
 const result=await database.prepare('PRAGMA miniflare_d1_export(?,?,?);').bind(0,0).all();
 const rows=result.results as unknown;
 if(!Array.isArray(rows)||rows.length!==1||!Array.isArray(rows[0])||!rows[0].every(value=>typeof value==='string'))throw new Error('local snapshot exporter shape unavailable');
 const statements=rows[0] as string[];
 if(statements.length>100_000||new TextEncoder().encode(statements.join('\n')).byteLength>128*1024*1024)throw new Error('local source snapshot laboratory bound exceeded');
 return statements;
}
export async function copyAcceptedAnalyticsSource(reference:D1Database,candidate:D1Database) {
 const started=performance.now(),copyProfiles={reference:createAnalyticsProfile(),candidate:createAnalyticsProfile()};
 const observed={reference:profileAnalyticsDatabase(reference,'source',copyProfiles.reference,()=> 'snapshot_proof_reference'),
  candidate:profileAnalyticsDatabase(candidate,'source',copyProfiles.candidate,()=> 'snapshot_import_candidate')};
 const empty=await observed.candidate.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").first<number>('n');
 if(empty!==0)throw new Error('snapshot destination must be an empty laboratory source');
 const exportStarted=performance.now(),statements=await exportLocal(reference),exportWallMs=performance.now()-exportStarted;
 // A single explicit transaction retains exported FK deferral until all rows
 // exist. This laboratory import is outside scheduled-role invocation limits.
 const group=(kind:string)=>statements.filter(sql=>new RegExp('^CREATE (?:UNIQUE )?'+kind+'\\b','iu').test(sql));
 const schema=group('TABLE'),views=group('VIEW'),indexes=group('INDEX'),triggers=group('TRIGGER');
 const definition=new Set([...schema,...views,...indexes,...triggers]);
 const data=statements.filter(sql=>!definition.has(sql));
 const imported=await observed.candidate.batch([...schema,...data,...views,...indexes,...triggers].map(sql=>observed.candidate.prepare(sql)));
 if(imported.some(result=>result.success!==true))throw new Error('local source snapshot import incomplete');
 const verificationStarted=performance.now(),copied=await exportLocal(candidate),verificationExportWallMs=performance.now()-verificationStarted;
 const originalText=[...statements].sort().join('\n'),copiedText=[...copied].sort().join('\n');
 if(originalText!==copiedText)throw new Error('local accepted source schema/data snapshot differs');
 const schemaSql="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
 const actualSchema=(await observed.reference.prepare(schemaSql).all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 if(logicalJson(actualSchema)!==logicalJson((await observed.candidate.prepare(schemaSql).all()).results))throw new Error('accepted source actual schema differs');
 const autoIncrementSequenceSha256=await autoIncrementSequenceDigest(observed.reference,actualSchema);
 if(autoIncrementSequenceSha256!==await autoIncrementSequenceDigest(observed.candidate,actualSchema))throw new Error('accepted source sequence high-water differs');
 const tables=actualSchema.filter(row=>row.type==='table');
 let rowidRows=0,typedRowsCompared=0;
 const rowidDigests:Record<string,string>={};
 for(const table of tables) {
  const columns=(await observed.reference.prepare('SELECT name,pk FROM pragma_table_info(?) ORDER BY cid').bind(table.name).all<{name:string;pk:number}>()).results;
  const withoutRowid=/\bWITHOUT\s+ROWID\b/iu.test(table.sql);
  const cells=columns.map(({name})=>{const c=quote(name);return `json_array(typeof(${c}),CASE typeof(${c}) WHEN 'blob' THEN hex(${c}) WHEN 'integer' THEN quote(${c}) WHEN 'real' THEN quote(${c}) ELSE ${c} END)`;});
  const ordering=withoutRowid?columns.filter(col=>col.pk>0).sort((a,b)=>a.pk-b.pk).map(col=>quote(col.name)).join(','):'rowid';
  let digest='';
  for(let page=0;page<10000;page++) {
   const sql=`SELECT ${withoutRowid?'':'rowid AS snapshot_rowid,'}json_array(${cells.join(',')}) AS typed_row FROM ${quote(table.name)} ORDER BY ${ordering} LIMIT 256 OFFSET ?`;
   const left=(await observed.reference.prepare(sql).bind(page*256).all()).results,right=(await observed.candidate.prepare(sql).bind(page*256).all()).results;
   if(logicalJson(left)!==logicalJson(right))throw new Error('accepted source implicit rowid snapshot differs');
   digest=await sha256Hex(digest+'\n'+logicalJson(left));typedRowsCompared+=left.length;if(!withoutRowid)rowidRows+=left.length;
   if(left.length<256)break;
   if(page===9999)throw new Error('snapshot rowid proof page bound');
  }
  rowidDigests[table.name]=digest;
 }
 return {schemaVersion:'analytics-source-snapshot-v1',contract:SOURCE_SNAPSHOT_CONTRACT,
  exactSchemaAndData:true,exactRowids:true,autoIncrementSequenceSha256,sqlSha256:await sha256Hex(originalText),schemaSha256:await sha256Hex(logicalJson(actualSchema)!),rowidInventorySha256:await sha256Hex(logicalJson(rowidDigests)!),
  exportedLogicalSqlBytes:new TextEncoder().encode(originalText).byteLength,exportStatements:statements.length,rowidRows,typedRowsCompared,
  wallMs:performance.now()-started,exportWallMs,verificationExportWallMs,importAndProof:{reference:summarizeAnalyticsProfile(copyProfiles.reference),candidate:summarizeAnalyticsProfile(copyProfiles.candidate)},
  exportResourceMetadata:null,exportResourceGap:'The installed local-only Miniflare export endpoint returns empty metadata. Two exports are observed in wall time/logical SQL bytes only; D1 read counts, exact CPU, physical disk/wire and peak heap are unknown.',
  importOrdering:'Create exported tables, data, views, indexes, then triggers so all references exist. No schema/data statement is rewritten. Compare sorted exported statements, exact actual schema, and every typed row with rowid/native primary-key ordering afterward.',
  physicalSnapshotBytes:null,physicalSnapshotContract:'Exact logical SQLite schema/data and implicit rowid parity; not a byte-for-byte database/WAL backup. SQLite indexes are recreated.'};
}

export interface AcceptedSourceTransfer {
 schemaVersion:'analytics-accepted-source-transfer-v1';statements:string[];
 proof:{sqlSha256:string;schemaSha256:string;rowidInventorySha256:string;autoIncrementSequenceSha256:string;exportStatements:number;exportedLogicalSqlBytes:number;rowidRows:number;typedRowsCompared:number};
}
/** Only the local controller holds this transport. Never print its statements. */
export async function captureAcceptedSourceTransfer(database:D1Database,side:'source'|'target'|'ledger'='source') {
 const profile=createAnalyticsProfile(),db=profileAnalyticsDatabase(database,side,profile,()=> 'snapshot_proof');
 const started=performance.now(),statements=await exportLocal(database),exportWallMs=performance.now()-started;
 const text=[...statements].sort().join('\n');
 const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name").all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 const autoIncrementSequenceSha256=await autoIncrementSequenceDigest(db,schema);
 const rowidDigests:Record<string,string>={};let rowidRows=0,typedRowsCompared=0;
 for(const table of schema.filter(row=>row.type==='table')) {
  const columns=(await db.prepare('SELECT name,pk FROM pragma_table_info(?) ORDER BY cid').bind(table.name).all<{name:string;pk:number}>()).results;
  const withoutRowid=/\bWITHOUT\s+ROWID\b/iu.test(table.sql);
  const cells=columns.map(({name})=>{const c=quote(name);return `json_array(typeof(${c}),CASE typeof(${c}) WHEN 'blob' THEN hex(${c}) WHEN 'integer' THEN quote(${c}) WHEN 'real' THEN quote(${c}) ELSE ${c} END)`;});
  const ordering=withoutRowid?columns.filter(col=>col.pk>0).sort((a,b)=>a.pk-b.pk).map(col=>quote(col.name)).join(','):'rowid';let digest='';
  for(let page=0;page<10000;page++) {
   const rows=(await db.prepare(`SELECT ${withoutRowid?'':'rowid AS snapshot_rowid,'}json_array(${cells.join(',')}) AS typed_row FROM ${quote(table.name)} ORDER BY ${ordering} LIMIT 256 OFFSET ?`).bind(page*256).all()).results;
   digest=await sha256Hex(digest+'\n'+logicalJson(rows));typedRowsCompared+=rows.length;if(!withoutRowid)rowidRows+=rows.length;
   if(rows.length<256)break;if(page===9999)throw new Error('snapshot rowid proof page bound');
  }
  rowidDigests[table.name]=digest;
 }
 const proof={autoIncrementSequenceSha256,sqlSha256:await sha256Hex(text),schemaSha256:await sha256Hex(logicalJson(schema)!),rowidInventorySha256:await sha256Hex(logicalJson(rowidDigests)!),exportStatements:statements.length,exportedLogicalSqlBytes:new TextEncoder().encode(text).byteLength,rowidRows,typedRowsCompared};
 return {transfer:{schemaVersion:'analytics-accepted-source-transfer-v1' as const,statements,proof},profile:summarizeAnalyticsProfile(profile),exportWallMs,wallMs:performance.now()-started,
  exportResourceMetadata:null,physicalSnapshotBytes:null};
}
export async function importAcceptedSourceTransfer(transfer:AcceptedSourceTransfer,database:D1Database,side:'source'|'target'|'ledger'='source') {
 if(transfer.schemaVersion!=='analytics-accepted-source-transfer-v1'||!transfer.proof
  ||!/^([a-f0-9]{64})$/u.test(transfer.proof.autoIncrementSequenceSha256)||!Array.isArray(transfer.statements)||transfer.statements.length>100_000
  ||!transfer.statements.every(sql=>typeof sql==='string'))throw new Error('invalid accepted source transfer');
 const text=[...transfer.statements].sort().join('\n');
 if(new TextEncoder().encode(text).byteLength>128*1024*1024||await sha256Hex(text)!==transfer.proof.sqlSha256)throw new Error('accepted source transfer digest mismatch');
 const profile=createAnalyticsProfile(),db=profileAnalyticsDatabase(database,side,profile,()=> 'snapshot_import');
 if(await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").first<number>('n')!==0)throw new Error('snapshot destination must be an empty laboratory source');
 const group=(kind:string)=>transfer.statements.filter(sql=>new RegExp('^CREATE (?:UNIQUE )?'+kind+'\\b','iu').test(sql));
 const tables=group('TABLE'),views=group('VIEW'),indexes=group('INDEX'),triggers=group('TRIGGER');
 const definitions=new Set([...tables,...views,...indexes,...triggers]),data=transfer.statements.filter(sql=>!definitions.has(sql));
 const started=performance.now();
 const result=await db.batch([...tables,...data,...views,...indexes,...triggers].map(sql=>db.prepare(sql)));
 if(result.some(row=>row.success!==true))throw new Error('accepted source import incomplete');
 const verified=await captureAcceptedSourceTransfer(database,side);
 // Exact exported statement bytes and every typed row/rowid hash; no entropy,
 // authority, integer, text order or journal normalization is permitted.
 if([...verified.transfer.statements].sort().join('\n')!==text||logicalJson(verified.transfer.proof)!==logicalJson(transfer.proof))throw new Error('accepted source import exact proof mismatch');
 return {exactSchemaAndData:true,exactRowids:true,proof:verified.transfer.proof,
  importProfile:summarizeAnalyticsProfile(profile),proofProfile:verified.profile,wallMs:performance.now()-started,
  verificationExportWallMs:verified.exportWallMs,exportResourceMetadata:null,physicalSnapshotBytes:null};
}
