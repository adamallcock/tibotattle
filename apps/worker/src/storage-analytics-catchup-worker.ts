import { readCollectionControls } from './collection-controls';
import { runStorageAnalyticsV1CatchupPass, type StorageAnalyticsCatchupMetrics } from './storage-analytics-runtime';

export const STORAGE_ANALYTICS_CATCHUP_CONTROL_SQL=`CREATE TABLE storage_analytics_v1_catchup_runs(
 run_id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL,
 source_namespace TEXT NOT NULL,
 page_events INTEGER NOT NULL CHECK(page_events BETWEEN 1 AND 16),
 max_pages INTEGER NOT NULL CHECK(max_pages BETWEEN 1 AND 10000),
 pages_completed INTEGER NOT NULL DEFAULT 0 CHECK(pages_completed BETWEEN 0 AND max_pages),
 expected_collection_revision INTEGER NOT NULL CHECK(expected_collection_revision>=1),
 expected_publication_enabled INTEGER NOT NULL CHECK(expected_publication_enabled IN (0,1)),
 generation INTEGER NOT NULL CHECK(generation>=1),
 expected_sequence INTEGER NOT NULL CHECK(expected_sequence>=0),
 state TEXT NOT NULL CHECK(state IN ('send-pending','sent','running','complete','blocked')),
 claim_id TEXT,
 result_reason TEXT,
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 CHECK((state IN ('complete','blocked'))=(result_reason IS NOT NULL)),
 CHECK((state='running')=(claim_id IS NOT NULL))
) STRICT`;
export const STORAGE_ANALYTICS_CATCHUP_RECEIPT_SQL=`CREATE TABLE storage_analytics_v1_catchup_receipts(
 run_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>=1),
 expected_sequence INTEGER NOT NULL CHECK(expected_sequence>=0),
 observed_sequence INTEGER NOT NULL CHECK(observed_sequence>=expected_sequence),
 events_applied INTEGER NOT NULL CHECK(events_applied=observed_sequence-expected_sequence),
 records_read INTEGER,
 decoded_bytes INTEGER,
 metered_queries INTEGER,
 source_read_ms INTEGER,
 fold_ms INTEGER,
 source_recheck_ms INTEGER,
 target_write_ms INTEGER,
 page_duration_ms INTEGER,
 invocation_duration_ms INTEGER NOT NULL CHECK(invocation_duration_ms>=0),
 result_reason TEXT NOT NULL,
 completed_ms INTEGER NOT NULL CHECK(completed_ms>=0),
 PRIMARY KEY(run_id,generation),
 CHECK(records_read IS NULL OR records_read>=0),
 CHECK(decoded_bytes IS NULL OR decoded_bytes>=0),
 CHECK(metered_queries IS NULL OR metered_queries>=0),
 CHECK(source_read_ms IS NULL OR source_read_ms>=0),
 CHECK(fold_ms IS NULL OR fold_ms>=0),
 CHECK(source_recheck_ms IS NULL OR source_recheck_ms>=0),
 CHECK(target_write_ms IS NULL OR target_write_ms>=0),
 CHECK(page_duration_ms IS NULL OR page_duration_ms>=0)
) STRICT`;

export interface StorageAnalyticsV1CatchupMessage {
 schema:'storage-analytics-v1-catchup-message-v3';runId:string;generation:number;
 expectedSequence:number;pageEvents:number;maxPages:number;expectedCollectionRevision:number;expectedPublicationEnabled:boolean;
}
interface RunRow {run_id:string;source_id:string;source_namespace:string;page_events:number;max_pages:number;
 pages_completed:number;expected_collection_revision:number;expected_publication_enabled:number;generation:number;expected_sequence:number;
 state:'send-pending'|'sent'|'running'|'complete'|'blocked';claim_id:string|null;result_reason:CatchupResultReason|null;updated_ms:number;}
type CatchupResultReason='complete'|'step_limit'|'page_limit'|'format_boundary'|'deadline'|'query_budget'|'capacity'
 |'cursor_reconciled'|'cursor_advanced'|'cursor_regressed'|'publication_control'|'failed';
interface Receipt {run_id:string;generation:number;expected_sequence:number;observed_sequence:number;events_applied:number;
 records_read:number|null;decoded_bytes:number|null;metered_queries:number|null;source_read_ms:number|null;fold_ms:number|null;
 source_recheck_ms:number|null;target_write_ms:number|null;page_duration_ms:number|null;invocation_duration_ms:number;
 result_reason:CatchupResultReason;completed_ms:number;}
export interface StorageAnalyticsCatchupWorkerEnv {
 STORAGE_ANALYTICS_CATCHUP_MODE?:'disabled'|'enabled';STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME?:string;
 STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT?:string;STORAGE_SOURCE_ID?:string;TELEMETRY_STORAGE_NAMESPACE?:string;
 STORAGE_INGESTION_DB?:D1Database;STORAGE_ANALYTICS_DB?:D1Database;DELETION_LEDGER?:D1Database;
 STORAGE_ANALYTICS_CATCHUP_CONTROL_DB?:D1Database;STORAGE_ANALYTICS_CATCHUP_QUEUE?:Queue<StorageAnalyticsV1CatchupMessage>;
}
const invalid=()=>new Error('STORAGE_ANALYTICS_CATCHUP_INVALID');
const cursorAdvanced=()=>new Error('STORAGE_ANALYTICS_CATCHUP_CURSOR_ADVANCED');
const cursorRegressed=()=>new Error('STORAGE_ANALYTICS_CATCHUP_CURSOR_REGRESSED');
const resultReasons:ReadonlySet<string>=new Set(['complete','step_limit','page_limit','format_boundary','deadline','query_budget','capacity',
 'cursor_reconciled','cursor_advanced','cursor_regressed','publication_control','failed']);
// Amortize Queue delivery latency without widening a 16-event D1 transaction.
// Every internal page retains its own authority checks, generation and receipt;
// three pages remain inside the existing 20-second invocation deadline.
const MAX_PAGES_PER_DELIVERY=3;
// D1 permits 1,000 queries per Worker invocation. Leave explicit headroom for
// cursor/control checks, checkpoint receipts, recovery and the final send.
const PAGE_QUERY_BUDGET_PER_DELIVERY=840,MIN_PAGE_QUERY_BUDGET=250;
const runId=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sourceId=/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const elapsed=(started:number)=>Math.max(0,Math.ceil(performance.now()-started));
function integer(value:number,min=0,max=Number.MAX_SAFE_INTEGER):number{
 if(!Number.isSafeInteger(value)||value<min||value>max)throw invalid();return value;
}
function message(value:unknown):StorageAnalyticsV1CatchupMessage{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='expectedCollectionRevision,expectedPublicationEnabled,expectedSequence,generation,maxPages,pageEvents,runId,schema'
  ||v.schema!=='storage-analytics-v1-catchup-message-v3'||typeof v.runId!=='string'||!runId.test(v.runId)
  ||typeof v.expectedPublicationEnabled!=='boolean')throw invalid();
 return {schema:v.schema,runId:v.runId,generation:integer(v.generation as number,1),expectedSequence:integer(v.expectedSequence as number),
  pageEvents:integer(v.pageEvents as number,1,16),maxPages:integer(v.maxPages as number,1,10000),
  expectedCollectionRevision:integer(v.expectedCollectionRevision as number,1),expectedPublicationEnabled:v.expectedPublicationEnabled};
}
function exactMessage(row:RunRow):StorageAnalyticsV1CatchupMessage{return {schema:'storage-analytics-v1-catchup-message-v3',
 runId:row.run_id,generation:row.generation,expectedSequence:row.expected_sequence,pageEvents:row.page_events,
 maxPages:row.max_pages,expectedCollectionRevision:row.expected_collection_revision,
 expectedPublicationEnabled:row.expected_publication_enabled===1};}
function rowValid(row:RunRow|null,env:StorageAnalyticsCatchupWorkerEnv):row is RunRow{
 return !!row&&typeof env.STORAGE_SOURCE_ID==='string'&&typeof env.TELEMETRY_STORAGE_NAMESPACE==='string'
  &&row.source_id===env.STORAGE_SOURCE_ID&&row.source_namespace===env.TELEMETRY_STORAGE_NAMESPACE&&runId.test(row.run_id)
  &&sourceId.test(row.source_id)&&row.source_namespace.length>0&&row.source_namespace.length<=256
  &&Number.isSafeInteger(row.page_events)&&row.page_events>=1&&row.page_events<=16
  &&Number.isSafeInteger(row.max_pages)&&row.max_pages>=1&&row.max_pages<=10000
  &&Number.isSafeInteger(row.pages_completed)&&row.pages_completed>=0&&row.pages_completed<=row.max_pages
  &&Number.isSafeInteger(row.expected_collection_revision)&&row.expected_collection_revision>=1
  &&(row.expected_publication_enabled===0||row.expected_publication_enabled===1)
  &&Number.isSafeInteger(row.generation)&&row.generation>=1&&Number.isSafeInteger(row.expected_sequence)&&row.expected_sequence>=0
  &&Number.isSafeInteger(row.updated_ms)&&row.updated_ms>=0&&['send-pending','sent','running','complete','blocked'].includes(row.state)
  &&((row.state==='running'&&typeof row.claim_id==='string'&&row.claim_id.length>=1&&row.claim_id.length<=128)
    ||(row.state!=='running'&&row.claim_id===null))
  &&((['complete','blocked'].includes(row.state)&&typeof row.result_reason==='string'&&resultReasons.has(row.result_reason))
    ||(!['complete','blocked'].includes(row.state)&&row.result_reason===null));
}
async function readRun(db:D1Database,id:string,env:StorageAnalyticsCatchupWorkerEnv):Promise<RunRow>{
 const row=await db.prepare('SELECT * FROM storage_analytics_v1_catchup_runs WHERE run_id=?').bind(id).first<RunRow>();
 if(!rowValid(row,env))throw invalid();return row;
}
async function cursor(db:D1Database,id:string):Promise<number>{
 const value=await db.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(id).first<number>('sequence');
 return value===null?0:integer(value);
}
async function transition(db:D1Database,sql:string,bind:unknown[],expected:Partial<RunRow>,env:StorageAnalyticsCatchupWorkerEnv):Promise<RunRow>{
 try{await db.prepare(sql).bind(...bind).run();}catch{}
 const row=await readRun(db,expected.run_id!,env);for(const [key,value] of Object.entries(expected))if(row[key as keyof RunRow]!==value)throw invalid();
 return row;
}
function receiptStatement(db:D1Database,value:Receipt):D1PreparedStatement{return db.prepare(`INSERT INTO storage_analytics_v1_catchup_receipts
 (run_id,generation,expected_sequence,observed_sequence,events_applied,records_read,decoded_bytes,metered_queries,
  source_read_ms,fold_ms,source_recheck_ms,target_write_ms,page_duration_ms,invocation_duration_ms,result_reason,completed_ms)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(value.run_id,value.generation,value.expected_sequence,value.observed_sequence,
 value.events_applied,value.records_read,value.decoded_bytes,value.metered_queries,value.source_read_ms,value.fold_ms,value.source_recheck_ms,
 value.target_write_ms,value.page_duration_ms,value.invocation_duration_ms,value.result_reason,value.completed_ms);}
async function transitionWithReceipt(db:D1Database,sql:string,bind:unknown[],expected:Partial<RunRow>,value:Receipt,
 env:StorageAnalyticsCatchupWorkerEnv):Promise<RunRow>{
 try{await db.batch([receiptStatement(db,value),db.prepare(sql).bind(...bind)]);}catch{}
 const [row,stored]=await Promise.all([readRun(db,expected.run_id!,env),db.prepare(`SELECT * FROM storage_analytics_v1_catchup_receipts
  WHERE run_id=? AND generation=?`).bind(value.run_id,value.generation).first<Receipt>()]);
 for(const [key,expectedValue] of Object.entries(expected))if(row[key as keyof RunRow]!==expectedValue)throw invalid();
 if(!stored||JSON.stringify(stored)!==JSON.stringify(value))throw invalid();return row;
}
async function markSent(control:D1Database,row:RunRow,env:StorageAnalyticsCatchupWorkerEnv):Promise<RunRow>{
 return transition(control,`UPDATE storage_analytics_v1_catchup_runs SET state='sent',updated_ms=?
  WHERE run_id=? AND generation=? AND expected_sequence=? AND state='send-pending'`,
  [Date.now(),row.run_id,row.generation,row.expected_sequence],{run_id:row.run_id,generation:row.generation,
   expected_sequence:row.expected_sequence,state:'sent'},env);
}
async function sendPending(row:RunRow,env:StorageAnalyticsCatchupWorkerEnv):Promise<void>{
 if(!env.STORAGE_ANALYTICS_CATCHUP_QUEUE||!env.STORAGE_ANALYTICS_CATCHUP_CONTROL_DB)throw invalid();
 await env.STORAGE_ANALYTICS_CATCHUP_QUEUE.send(exactMessage(row),{contentType:'json'});
 await markSent(env.STORAGE_ANALYTICS_CATCHUP_CONTROL_DB,row,env);
}
function exactInput(input:StorageAnalyticsV1CatchupMessage,row:RunRow):boolean{
 const expected=exactMessage(row);return Object.keys(expected).every(key=>input[key as keyof StorageAnalyticsV1CatchupMessage]===expected[key as keyof StorageAnalyticsV1CatchupMessage]);
}
function exactImmutableInput(input:StorageAnalyticsV1CatchupMessage,row:RunRow):boolean{
 return input.runId===row.run_id&&input.pageEvents===row.page_events&&input.maxPages===row.max_pages
  &&input.expectedCollectionRevision===row.expected_collection_revision
  &&input.expectedPublicationEnabled===(row.expected_publication_enabled===1);
}
function measuredReceipt(row:RunRow,after:number,reason:CatchupResultReason,started:number,result?:{
 recordsRead:number;queriesUsed:number;metrics:StorageAnalyticsCatchupMetrics;
}):Receipt{return {run_id:row.run_id,generation:row.generation,expected_sequence:row.expected_sequence,observed_sequence:after,
 events_applied:after-row.expected_sequence,records_read:result?.recordsRead??null,decoded_bytes:result?.metrics.decodedBytes??null,
 metered_queries:result?.queriesUsed??null,source_read_ms:result?.metrics.sourceReadMs??null,fold_ms:result?.metrics.foldMs??null,
 source_recheck_ms:result?.metrics.sourceRecheckMs??null,target_write_ms:result?.metrics.targetWriteMs??null,
 page_duration_ms:result?.metrics.pageDurationMs??null,invocation_duration_ms:elapsed(started),result_reason:reason,completed_ms:Date.now()};}

/** Queue batches are configured size one/max concurrency one. Every generation
 * is bounded by the run row. A failed generation advances to a retained blocked
 * checkpoint; an operator can inspect it, reset that exact row to send-pending,
 * and send exactMessage(row) without replaying an acknowledged analytics page. */
export async function runStorageAnalyticsV1CatchupQueue(batch:MessageBatch<StorageAnalyticsV1CatchupMessage>,
 env:StorageAnalyticsCatchupWorkerEnv):Promise<void>{
 const started=performance.now();
 if(env.STORAGE_ANALYTICS_CATCHUP_MODE!=='enabled'||!env.STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME
  ||batch.queue!==env.STORAGE_ANALYTICS_CATCHUP_QUEUE_NAME||batch.messages.length!==1||!env.STORAGE_INGESTION_DB
  ||!env.STORAGE_ANALYTICS_DB||!env.DELETION_LEDGER||!env.STORAGE_ANALYTICS_CATCHUP_CONTROL_DB
  ||!env.STORAGE_ANALYTICS_CATCHUP_QUEUE||typeof env.STORAGE_SOURCE_ID!=='string'||!sourceId.test(env.STORAGE_SOURCE_ID)
  ||typeof env.TELEMETRY_STORAGE_NAMESPACE!=='string'||!env.TELEMETRY_STORAGE_NAMESPACE
  ||typeof env.STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT!=='string')throw invalid();
 const runDeadlineMs=Date.parse(env.STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT);
 if(!Number.isFinite(runDeadlineMs)||new Date(runDeadlineMs).toISOString()!==env.STORAGE_ANALYTICS_CATCHUP_EXPIRES_AT)throw invalid();
 const invocationDeadlineMs=Math.min(runDeadlineMs,Date.now()+20_000);
 const delivered=batch.messages[0]!,input=message(delivered.body),control=env.STORAGE_ANALYTICS_CATCHUP_CONTROL_DB;
 if(typeof delivered.id!=='string'||delivered.id.length<1||delivered.id.length>128)throw invalid();
 let state=await readRun(control,input.runId,env),retryingInternalClaim=false;
 if(state.state==='complete'||state.state==='blocked'){delivered.ack();return;}
 if(input.generation<state.generation){
  if(state.state==='send-pending'){await sendPending(state,env);delivered.ack();return;}
  else if(state.state==='running'&&state.claim_id===delivered.id){
   if(!exactImmutableInput(input,state))throw invalid();retryingInternalClaim=true;
  }
  else {delivered.ack();return;}
 }
 if(!retryingInternalClaim&&!exactInput(input,state))throw invalid();
 if(!retryingInternalClaim&&state.state==='send-pending')state=await transition(control,`UPDATE storage_analytics_v1_catchup_runs SET state='running',claim_id=?,updated_ms=?
  WHERE run_id=? AND generation=? AND expected_sequence=? AND state='send-pending'`,
  [delivered.id,Date.now(),state.run_id,state.generation,state.expected_sequence],{run_id:state.run_id,generation:state.generation,
   expected_sequence:state.expected_sequence,state:'running',claim_id:delivered.id},env);
 else if(!retryingInternalClaim&&state.state==='sent')state=await transition(control,`UPDATE storage_analytics_v1_catchup_runs SET state='running',claim_id=?,updated_ms=?
  WHERE run_id=? AND generation=? AND expected_sequence=? AND state='sent'`,
  [delivered.id,Date.now(),state.run_id,state.generation,state.expected_sequence],{run_id:state.run_id,generation:state.generation,
   expected_sequence:state.expected_sequence,state:'running',claim_id:delivered.id},env);
 if(state.state!=='running'||state.claim_id!==delivered.id)throw invalid();
 let before=state.expected_sequence,pagesThisInvocation=0,generationStarted=started,remainingPageQueries=PAGE_QUERY_BUDGET_PER_DELIVERY;
 try{
  for(;;){
  before=await cursor(env.STORAGE_ANALYTICS_DB,env.STORAGE_SOURCE_ID);
  if(before<state.expected_sequence)throw cursorRegressed();
  if(before>state.expected_sequence+state.page_events)throw cursorAdvanced();
  const controls=await readCollectionControls(env.STORAGE_INGESTION_DB);
  if(controls.publication!==(state.expected_publication_enabled===1)||controls.revision!==state.expected_collection_revision)
   throw new Error('STORAGE_ANALYTICS_PUBLICATION_CONTROL_CHANGED');
  if(Date.now()>=runDeadlineMs)throw new Error('STORAGE_ANALYTICS_CATCHUP_DEADLINE');
  let result:Awaited<ReturnType<typeof runStorageAnalyticsV1CatchupPass>>|null=null;
  if(before===state.expected_sequence)result=await runStorageAnalyticsV1CatchupPass({source:env.STORAGE_INGESTION_DB,
   target:env.STORAGE_ANALYTICS_DB,ledger:env.DELETION_LEDGER,sourceId:env.STORAGE_SOURCE_ID,
   sourceNamespace:env.TELEMETRY_STORAGE_NAMESPACE,pageEvents:state.page_events,maxSteps:state.page_events,
   deadlineMs:invocationDeadlineMs,maxQueries:remainingPageQueries,publicationControlRevision:state.expected_collection_revision,
   publicationEnabled:state.expected_publication_enabled===1});
  if(result)remainingPageQueries-=result.queriesUsed;
  const after=await cursor(env.STORAGE_ANALYTICS_DB,env.STORAGE_SOURCE_ID);
  if(after<state.expected_sequence||after<before)throw cursorRegressed();
  if(after>state.expected_sequence+state.page_events)throw cursorAdvanced();
  const pagesCompleted=state.pages_completed+(result&&after>state.expected_sequence?1:0),reason=result?.reason;
  if(after>state.expected_sequence){
   let terminalReason:CatchupResultReason|null=null,terminalState:'complete'|'blocked'|null=null;
   if(pagesCompleted>=state.max_pages){terminalReason='page_limit';terminalState='complete';}
   else if(reason==='format_boundary'){terminalReason='format_boundary';terminalState='complete';}
   else if(reason==='deadline'||reason==='query_budget'||reason==='capacity'||Date.now()>=runDeadlineMs){
    terminalReason=Date.now()>=runDeadlineMs?'deadline':reason!;terminalState='blocked';
   }
   if(terminalState&&terminalReason){
    await transitionWithReceipt(control,`UPDATE storage_analytics_v1_catchup_runs SET generation=generation+1,expected_sequence=?,
     pages_completed=?,state=?,claim_id=NULL,result_reason=?,updated_ms=? WHERE run_id=? AND generation=? AND expected_sequence=?
     AND state='running' AND claim_id=?`,[after,pagesCompleted,terminalState,terminalReason,Date.now(),state.run_id,state.generation,
      state.expected_sequence,delivered.id],{run_id:state.run_id,generation:state.generation+1,expected_sequence:after,
      pages_completed:pagesCompleted,state:terminalState,claim_id:null,result_reason:terminalReason},
     measuredReceipt(state,after,terminalReason,generationStarted,result??undefined),env);
    delivered.ack();return;
   }
   state=await transitionWithReceipt(control,`UPDATE storage_analytics_v1_catchup_runs SET generation=generation+1,expected_sequence=?,
    pages_completed=?,state='send-pending',claim_id=NULL,result_reason=NULL,updated_ms=? WHERE run_id=? AND generation=?
    AND expected_sequence=? AND state='running' AND claim_id=?`,[after,pagesCompleted,Date.now(),state.run_id,state.generation,
     state.expected_sequence,delivered.id],{run_id:state.run_id,generation:state.generation+1,expected_sequence:after,
     pages_completed:pagesCompleted,state:'send-pending',claim_id:null,result_reason:null},
    measuredReceipt(state,after,reason??'cursor_reconciled',generationStarted,result??undefined),env);
   pagesThisInvocation+=result?1:0;
   if(result&&state.page_events===16&&pagesThisInvocation<MAX_PAGES_PER_DELIVERY
    &&remainingPageQueries>=MIN_PAGE_QUERY_BUDGET&&Date.now()<invocationDeadlineMs){
    state=await transition(control,`UPDATE storage_analytics_v1_catchup_runs SET state='running',claim_id=?,updated_ms=?
     WHERE run_id=? AND generation=? AND expected_sequence=? AND state='send-pending'`,
     [delivered.id,Date.now(),state.run_id,state.generation,state.expected_sequence],{run_id:state.run_id,generation:state.generation,
      expected_sequence:state.expected_sequence,state:'running',claim_id:delivered.id},env);
    generationStarted=performance.now();
    continue;
   }
   await sendPending(state,env);delivered.ack();return;
  }
  if(!reason||!['complete','format_boundary','deadline','query_budget','capacity'].includes(reason))throw invalid();
  if(pagesThisInvocation>0&&(reason==='deadline'||reason==='query_budget')&&Date.now()<runDeadlineMs){
   state=await transition(control,`UPDATE storage_analytics_v1_catchup_runs SET state='send-pending',claim_id=NULL,updated_ms=?
    WHERE run_id=? AND generation=? AND expected_sequence=? AND state='running' AND claim_id=?`,
    [Date.now(),state.run_id,state.generation,state.expected_sequence,delivered.id],{run_id:state.run_id,generation:state.generation,
     expected_sequence:state.expected_sequence,state:'send-pending',claim_id:null},env);
   await sendPending(state,env);delivered.ack();return;
  }
  const terminal=reason==='complete'||reason==='format_boundary'?'complete':'blocked';
  await transitionWithReceipt(control,`UPDATE storage_analytics_v1_catchup_runs SET generation=generation+1,state=?,claim_id=NULL,
   result_reason=?,updated_ms=? WHERE run_id=? AND generation=? AND expected_sequence=? AND state='running' AND claim_id=?`,
   [terminal,reason,Date.now(),state.run_id,state.generation,state.expected_sequence,delivered.id],{run_id:state.run_id,
    generation:state.generation+1,expected_sequence:state.expected_sequence,state:terminal,claim_id:null,result_reason:reason},
   measuredReceipt(state,state.expected_sequence,reason,generationStarted,result??undefined),env);
  delivered.ack();
  return;
  }
 }catch(error){
  const retained=await readRun(control,state.run_id,env);
  if(retained.state!=='running'||retained.generation!==state.generation||retained.claim_id!==delivered.id)throw error;
  let after=state.expected_sequence;
  try{const observed=await cursor(env.STORAGE_ANALYTICS_DB,env.STORAGE_SOURCE_ID);if(observed>=state.expected_sequence)after=observed;}catch{}
  const pagesCompleted=state.pages_completed;
  const reason=error instanceof Error&&error.message==='STORAGE_ANALYTICS_PUBLICATION_CONTROL_CHANGED'?'publication_control':
   error instanceof Error&&error.message==='STORAGE_ANALYTICS_CATCHUP_DEADLINE'?'deadline':
   error instanceof Error&&error.message==='STORAGE_ANALYTICS_CATCHUP_CURSOR_ADVANCED'?'cursor_advanced':
   error instanceof Error&&error.message==='STORAGE_ANALYTICS_CATCHUP_CURSOR_REGRESSED'?'cursor_regressed':'failed';
  await transitionWithReceipt(control,`UPDATE storage_analytics_v1_catchup_runs SET generation=generation+1,expected_sequence=?,
   pages_completed=?,state='blocked',claim_id=NULL,result_reason=?,updated_ms=? WHERE run_id=? AND generation=?
   AND expected_sequence=? AND state='running' AND claim_id=?`,[after,pagesCompleted,reason,Date.now(),state.run_id,
    state.generation,state.expected_sequence,delivered.id],{run_id:state.run_id,generation:state.generation+1,
    expected_sequence:after,pages_completed:pagesCompleted,state:'blocked',claim_id:null,result_reason:reason},
   measuredReceipt(state,after,reason,generationStarted),env);
  delivered.ack();
 }
}

export default {fetch():Response{return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
 async queue(batch:MessageBatch<StorageAnalyticsV1CatchupMessage>,env:StorageAnalyticsCatchupWorkerEnv):Promise<void>{
  await runStorageAnalyticsV1CatchupQueue(batch,env);
 }} satisfies ExportedHandler<StorageAnalyticsCatchupWorkerEnv,StorageAnalyticsV1CatchupMessage>;
