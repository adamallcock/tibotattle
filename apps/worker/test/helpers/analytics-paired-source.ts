import {logicalJson} from './analytics-logical-bytes';

export const PAIRED_SOURCE_CONTRACT='paired-native-admission-v1: one pinned native caller generates accepted SQL/binds once, executes them against independent lane sources, and compares every returned data/proof row exactly. Success and write-versus-no-write must agree. Trigger-inclusive meta.changes, rows_read, rows_written, duration, size_after and last_row_id are never substituted or numerically equated; each physical lane keeps its own profile. No authority, provenance, input timestamp or arithmetic normalization.';
export interface PairedSourceProof {calls:number;statements:number;returnedRows:number;mutatingStatements:number;divergences:number;physicalFailures:number;}
/** Admission only. It does not wrap either lane's later scheduler/reader work.
 * This deliberately exposes no raw difference in an error or report. */
export function pairAnalyticsSources(reference:D1Database,candidate:D1Database,proof:PairedSourceProof={calls:0,statements:0,returnedRows:0,mutatingStatements:0,divergences:0,physicalFailures:0}):{database:D1Database;proof:PairedSourceProof;assertExact:()=>void} {
 const original=new WeakMap<D1PreparedStatement,{reference:D1PreparedStatement;candidate:D1PreparedStatement;sql:string}>();
 const equal=(left:unknown,right:unknown,sql:string)=>{
  const a=left as D1Result<Record<string,unknown>>,b=right as D1Result<Record<string,unknown>>;
  if(!a||!b||a.success!==true||b.success!==true||logicalJson(a.results)!==logicalJson(b.results)){proof.divergences++;const columns=a?.results?.flatMap((row,i)=>Object.keys(row).filter(key=>logicalJson(row[key])!==logicalJson(b?.results?.[i]?.[key])))??[];throw new Error('paired source returned data/proof divergence; columns='+[...new Set(columns)].sort().join(','));}
  const mutation=/^\s*(?:INSERT|REPLACE|UPDATE|DELETE)\b/iu.test(sql);
  if(mutation) {
   if(!Number.isFinite(a.meta.changes)||!Number.isFinite(b.meta.changes)||(a.meta.changes>0)!==(b.meta.changes>0)){proof.divergences++;throw new Error('paired source mutation outcome divergence');}
   proof.mutatingStatements++;
  }
  proof.statements++;proof.returnedRows+=a.results.length;
 };
 const execute=async<T>(a:()=>Promise<T>,b:()=>Promise<T>):Promise<[T,T]>=>{
  proof.calls++;const result=await Promise.allSettled([a(),b()]);
  if(result.some(value=>value.status==='rejected')){proof.physicalFailures++;throw new Error('paired source physical SQL failure');}
  return [(result[0] as PromiseFulfilledResult<T>).value,(result[1] as PromiseFulfilledResult<T>).value];
 };
 const wrap=(a:D1PreparedStatement,b:D1PreparedStatement,sql:string):D1PreparedStatement=>{
  const statement=new Proxy(a,{get(inner,key){
   if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),b.bind(...values),sql);
   if(['all','run','first'].includes(String(key)))return async(column?:string)=>{
    const [left,right]=await execute(()=>inner.all<Record<string,unknown>>(),()=>b.all<Record<string,unknown>>());equal(left,right,sql);
    if(key!=='first')return left;
    const row=left.results[0];if(row===undefined)return null;
    if(column===undefined)return row;
    if(!Object.hasOwn(row,column))throw new Error('paired source first column missing');return row[column];
   };
   if(key==='raw')return()=>{throw new Error('paired source raw method needs an explicit proof adapter');};
   const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
  }});original.set(statement,{reference:a,candidate:b,sql});return statement;
 };
 const database=new Proxy(reference,{get(inner,key){
  if(key==='constructor')return inner.constructor;
  if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),candidate.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const entries=statements.map(statement=>original.get(statement));if(entries.some(entry=>!entry))throw new Error('paired source foreign statement');
   const [a,b]=await execute(()=>inner.batch(entries.map(entry=>entry!.reference)),()=>candidate.batch(entries.map(entry=>entry!.candidate)));
   if(a.length!==entries.length||b.length!==entries.length)throw new Error('paired source incomplete batch');
   for(let i=0;i<entries.length;i++)equal(a[i],b[i],entries[i]!.sql);return a;
  };
  if(key==='exec'||key==='withSession'||key==='dump')return()=>{throw new Error('paired source requires reviewed prepared operations');};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
 return {database,proof,assertExact(){if(proof.divergences||proof.physicalFailures)throw new Error('paired source proof contains prior divergence or SQL failure');}};
}
