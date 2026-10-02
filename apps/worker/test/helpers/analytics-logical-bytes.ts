import {ANALYTICS_STORE_COLUMNS,type InventorySide} from './analytics-store-inventory';

export const LOGICAL_BYTE_CONTRACT='logical-sqlite-values-v1: retained rows are SQLite JSON arrays in declared column order; each cell is [typeof,value], with NULL null, TEXT unchanged, INTEGER/REAL SQLite quote() text, BLOB uppercase hex. Sizes are UTF-8 octets. Payload-column bytes overlap row bytes and are not additive. Submitted bind JSON tags binary values as {$blobHex:uppercasehex}; SQL text plus these binds is a logical request representation, not wire, pages, indexes, WAL, physical writes, peak memory or billed storage.';
export function logicalJson(value:unknown):string|undefined {
 return JSON.stringify(value,(_key,item:unknown)=>{
  const bytes=item instanceof ArrayBuffer?new Uint8Array(item):ArrayBuffer.isView(item)?new Uint8Array(item.buffer,item.byteOffset,item.byteLength):null;
  return bytes?{$blobHex:Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase()}:item;
 });
}
export function logicalBytes(value:unknown):number {const text=logicalJson(value);return text===undefined?0:new TextEncoder().encode(text).byteLength;}
const utf8=(text:string)=>new TextEncoder().encode(text).byteLength;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function payloadColumns(side:InventorySide,table:string):string[] {
 return (ANALYTICS_STORE_COLUMNS[side][table]??[]).map(([name])=>name).filter(name=>name==='payload'||name.endsWith('_json'));
}
export function retainedStoreSql(side:InventorySide,table:string):string {
 const columns=ANALYTICS_STORE_COLUMNS[side][table];if(!columns)throw new Error('unregistered logical store');
 const cells=columns.map(([name])=>{const c=quote(name);return `json_array(typeof(${c}),CASE typeof(${c}) WHEN 'blob' THEN hex(${c}) WHEN 'integer' THEN quote(${c}) WHEN 'real' THEN quote(${c}) ELSE ${c} END)`;});
 const payload=payloadColumns(side,table).map(name=>`coalesce(length(CAST(${quote(name)} AS BLOB)),0)`).join('+')||'0';
 return `SELECT count(*) rows,coalesce(sum(length(CAST(json_array(${cells.join(',')}) AS BLOB))),0) row_bytes,coalesce(sum(${payload}),0) payload_bytes FROM ${quote(table)}`;
}
export interface LogicalStoreSnapshot {schemaVersion:'analytics-logical-stores-v1';side:InventorySide;complete:true;tables:Record<string,{present:boolean;rows:number;rowBytes:number;payloadBytes:number}>;rows:number;rowBytes:number;payloadBytes:number;contract:string;}
/** Queries return schema metadata or one aggregate row per table, never bodies. */
export async function snapshotLogicalStores(db:D1Database,side:InventorySide):Promise<LogicalStoreSnapshot> {
 const domain=side==='target'?"s.name GLOB 'analytics_*'":side==='source'?"s.name GLOB 'storage_effective_*'":"s.name NOT GLOB 'sqlite_*' AND s.name!='d1_migrations' AND s.name!='_cf_METADATA'";
 const schema=(await db.prepare(`SELECT s.name table_name,p.cid,p.name column_name,upper(p.type) column_type FROM sqlite_schema s JOIN pragma_table_info(s.name) p WHERE s.type='table' AND ${domain} ORDER BY s.name,p.cid`).all<{table_name:string;cid:number;column_name:string;column_type:string}>()).results;
 const actual:Record<string,[string,string][]>=Object.create(null) as Record<string,[string,string][]>;
 for(const row of schema){if(!ANALYTICS_STORE_COLUMNS[side][row.table_name])throw new Error('unregistered maintained logical table: '+side+'.'+row.table_name);(actual[row.table_name]??=[]).push([row.column_name,row.column_type]);}
 for(const [table,columns] of Object.entries(actual))if(JSON.stringify(columns)!==JSON.stringify(ANALYTICS_STORE_COLUMNS[side][table]))throw new Error('maintained logical column inventory changed');
 const tables:LogicalStoreSnapshot['tables']={};let rows=0,rowBytes=0,payloadBytes=0;
 for(const table of Object.keys(ANALYTICS_STORE_COLUMNS[side])) {
  if(!actual[table]){tables[table]={present:false,rows:0,rowBytes:0,payloadBytes:0};continue;}
  const value=await db.prepare(retainedStoreSql(side,table)).first<{rows:number;row_bytes:number;payload_bytes:number}>();
  if(!value||![value.rows,value.row_bytes,value.payload_bytes].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('invalid logical aggregate bytes');
  tables[table]={present:true,rows:value.rows,rowBytes:value.row_bytes,payloadBytes:value.payload_bytes};rows+=value.rows;rowBytes+=value.row_bytes;payloadBytes+=value.payload_bytes;
 }
 if(![rows,rowBytes,payloadBytes].every(Number.isSafeInteger))throw new Error('logical inventory total exceeds exact integer range');
 return {schemaVersion:'analytics-logical-stores-v1',side,complete:true,tables,rows,rowBytes,payloadBytes,contract:LOGICAL_BYTE_CONTRACT};
}

type Token={text:string;bind?:number};
/** Small SQL lexer, used only to classify immutable measured SQL; never executes
 * rewritten SQL and never persists values. Unknown payload forms stay unknown. */
function tokens(sql:string):Token[] {
 const result:Token[]=[];let next=0;
 const re=/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\?(?:\d+)?|[A-Za-z_][A-Za-z_\d]*|\d+(?:\.\d+)?|./gu;
 for(const match of sql.matchAll(re)){const text=match[0];if(/^\s|^--|^\/\*/u.test(text))continue;
  if(text.startsWith('?')){const bind=text.length>1?Number(text.slice(1))-1:next;next=Math.max(next,bind+1);result.push({text,bind});}else result.push({text});}
 return result;
}
const lower=(token:Token|undefined)=>token?.text.replace(/^"|"$/gu,'').toLowerCase();
function split(tokens:Token[]):Token[][] {const result:Token[][]=[[]];let depth=0;for(const token of tokens){if(token.text==='(')depth++;if(token.text===')')depth--;if(token.text===','&&depth===0)result.push([]);else result.at(-1)!.push(token);}return result;}
function close(tokens:Token[],start:number):number {let depth=0;for(let i=start;i<tokens.length;i++){if(tokens[i]!.text==='(')depth++;if(tokens[i]!.text===')'&&--depth===0)return i;}return -1;}
type PayloadExpression={column:string;kind:'bound';index:number}|{column:string;kind:'literal';value:string|null}|{column:string;kind:'page';index:number;field:string|number}|{column:string;kind:'derived'|'unknown'};
type Shape={table:string;mutation:string;payloads:PayloadExpression[];unknown:boolean};
const shapes=new Map<string,Shape|null>();
const SHAPE_CACHE_LIMIT=2048;
function cacheShape(key:string,value:Shape|null) {if(key.length>16_384)return;if(!shapes.has(key)&&shapes.size>=SHAPE_CACHE_LIMIT)shapes.delete(shapes.keys().next().value!);shapes.set(key,value);}
export function logicalShapeCacheRetention(){return {entries:shapes.size,maximumEntries:SHAPE_CACHE_LIMIT,retainedBindingValues:0};}
function shapeFor(sql:string,side:InventorySide):Shape|null {
 const cacheKey=side+'\0'+sql;if(shapes.has(cacheKey))return shapes.get(cacheKey)!;
 const t=tokens(sql);if(!['with','insert','replace','update','delete'].includes(lower(t[0])??'')){cacheShape(cacheKey,null);return null;}let depth=0,index=-1;
 for(let i=0;i<t.length;i++){if(t[i]!.text==='(')depth++;if(t[i]!.text===')')depth--;if(depth===0&&['insert','replace','update','delete'].includes(lower(t[i])??'')){index=i;break;}}
 if(index<0){cacheShape(cacheKey,null);return null;}
 const mutation=lower(t[index])!;let tableIndex=index+1;
 if(lower(t[tableIndex])==='or')tableIndex+=2;
 if(['into','from'].includes(lower(t[tableIndex])??''))tableIndex++;
 const table=lower(t[tableIndex])!;
 if(!ANALYTICS_STORE_COLUMNS[side][table]) {
  const belongs=side==='target'?table?.startsWith('analytics_'):side==='source'?table?.startsWith('storage_effective_'):false;
  const unknown=belongs?{table:'unregistered_store',mutation,payloads:[],unknown:true}:null;return unknown; // Do not pin imported source SQL containing literal telemetry.
 }
 const payloads:PayloadExpression[]=[];const columns=payloadColumns(side,table);let unknown=false;
 const classify=(column:string,expression:Token[])=>{
  if(expression.length===1&&expression[0]!.bind!==undefined){payloads.push({column,kind:'bound',index:expression[0]!.bind!});return;}
  if(expression.length===1&&(expression[0]!.text.startsWith("'")||lower(expression[0])==='null')){payloads.push({column,kind:'literal',value:lower(expression[0])==='null'?null:expression[0]!.text.slice(1,-1).replaceAll("''","'")});return;}
  const text=expression.map(token=>token.text).join('');
  const named=/^json_extract\(value,'\$\.([A-Za-z_][A-Za-z_\d]*)'\)$/iu.exec(text)?.[1];
  const indexed=/^json_extract\(value,'\$\[(\d+)\]'\)$/iu.exec(text)?.[1];
  const field=named??(indexed===undefined?undefined:Number(indexed));
  const each=t.findIndex((token,i)=>lower(token)==='json_each'&&t[i+1]?.text==='('&&t[i+2]?.bind!==undefined&&t[i+3]?.text===')');
  if(field!==undefined&&each>=0){payloads.push({column,kind:'page',index:t[each+2]!.bind!,field});return;}
  if(expression.every(token=>token.bind===undefined)&&/^(?:[A-Za-z_][\w]*\.)?[A-Za-z_][\w]*$/u.test(text)){payloads.push({column,kind:'derived'});return;}
  payloads.push({column,kind:'unknown'});unknown=true;
 };
 if(mutation==='delete') { /* No new payload is submitted. */ }
 else if(mutation==='insert'||mutation==='replace') {
  const end=close(t,tableIndex+1),names=end<0?[]:split(t.slice(tableIndex+2,end)).map(part=>lower(part[0])!);
  const start=end+1,kind=lower(t[start]);let expressions:Token[][]=[];
  if(kind==='values'&&t[start+1]?.text==='(')expressions=split(t.slice(start+2,close(t,start+1)));
  else if(kind==='select'){let finish=t.length,d=0;for(let i=start+1;i<t.length;i++){if(t[i]!.text==='(')d++;if(t[i]!.text===')')d--;if(d===0&&['from','where','on','returning'].includes(lower(t[i])??'')){finish=i;break;}}expressions=split(t.slice(start+1,finish));}
  if(names.length!==expressions.length||end<0){unknown=columns.length>0;for(const column of columns)payloads.push({column,kind:'unknown'});}
  else for(const column of columns){const i=names.indexOf(column);if(i>=0)classify(column,expressions[i]!);}
  // Multiple VALUES tuples are deliberately unqualified until reviewed.
  if(kind==='values'&&t[close(t,start+1)+1]?.text===',')unknown=true;
 } else {
  const start=t.findIndex((token,i)=>i>tableIndex&&lower(token)==='set');let end=t.length,d=0;
  for(let i=start+1;i<t.length;i++){if(t[i]!.text==='(')d++;if(t[i]!.text===')')d--;if(d===0&&['where','returning'].includes(lower(t[i])??'')){end=i;break;}}
  for(const assignment of split(t.slice(start+1,end))){const column=lower(assignment[0]);if(column&&columns.includes(column)&&assignment[1]?.text==='=')classify(column,assignment.slice(2));}
 }
 const shape={table,mutation,payloads,unknown};cacheShape(cacheKey,shape);return shape;
}
export interface StoreSubmission {statements:number;failedStatements:number;logicalRequestBytes:number;payloadBytes:number;payloadAssignments:number;derivedPayloadAssignments:number;unknownPayloadStatements:number;}
export function recordLogicalSubmission(stores:Record<string,StoreSubmission>,side:InventorySide,sql:string,bound:readonly unknown[],failed:boolean):void {
 const shape=shapeFor(sql,side);if(!shape)return;
 const current=stores[side+'.'+shape.table]??={statements:0,failedStatements:0,logicalRequestBytes:0,payloadBytes:0,payloadAssignments:0,derivedPayloadAssignments:0,unknownPayloadStatements:0};
 current.statements++;if(failed)current.failedStatements++;current.logicalRequestBytes+=utf8(sql)+logicalBytes(bound);let unknown=shape.unknown;
 const add=(value:unknown)=>{if(value===null)return;if(typeof value==='string')current.payloadBytes+=utf8(value);else unknown=true;};
 for(const expression of shape.payloads) {
  current.payloadAssignments++;
  if(expression.kind==='bound')add(bound[expression.index]);
  else if(expression.kind==='literal')add(expression.value);
  else if(expression.kind==='derived')current.derivedPayloadAssignments++;
  else if(expression.kind==='page'){
   try{const values=JSON.parse(String(bound[expression.index])) as unknown;if(!Array.isArray(values))throw new Error();for(const value of values){if(!value||typeof value!=='object'||!Object.hasOwn(value,expression.field))throw new Error();add(Reflect.get(value,expression.field));}}
   catch{unknown=true;}
  } else unknown=true;
 }
 if(unknown)current.unknownPayloadStatements++;
}
