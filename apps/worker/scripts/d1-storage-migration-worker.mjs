import { runStorageRestoreStep, STORAGE_RESTORE_STAGES } from './d1-storage-restore-runner.mjs';

const TABLE='_authority_operator_progress';
export const MIGRATION_JOURNAL_DDL=`CREATE TABLE ${TABLE}(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,execution_digest TEXT NOT NULL,stage TEXT,steps INTEGER NOT NULL CHECK(steps>=0),intent TEXT) STRICT`;
const DDL=MIGRATION_JOURNAL_DDL;
export const MIGRATION_JOURNAL_GUARD=`(SELECT count(*) FROM sqlite_schema WHERE tbl_name='${TABLE}')=1
 AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='${TABLE}' AND tbl_name='${TABLE}' AND sql=?)`;
const JOURNAL_GUARD=MIGRATION_JOURNAL_GUARD;
const fail=code=>{throw new Error(`D1_STORAGE_${code}`);};
/** Bundled contract and API are supplied by the reviewed generated entrypoint,
 * never an HTTP request or a runtime JSON variable. Deployment/binding approval
 * is an independent operator gate. This adapter does not reconcile a deletion
 * ledger or enable ordinary traffic; ready means restore APIs completed only.
 * A private queue advances pages immediately. Cron only repairs a lost wakeup;
 * it never replays an uncertain page or paces the whole copy one page/minute. */
export function createStorageMigrationWorker({api,contract,contractDigest,executionDigest=contractDigest,expiresAt,frozenSource=false,clock=()=>Date.now()}){
 const fixed=structuredClone(contract);
 if(!/^[a-f0-9]{64}$/.test(executionDigest)||!/^[a-f0-9]{64}$/.test(contractDigest)||!Number.isSafeInteger(expiresAt))fail('MIGRATION_CONFIGURATION_INVALID');
 const enabled=async env=>{
   if(env.STORAGE_RESTORE_MODE===undefined||env.STORAGE_RESTORE_MODE==='disabled')return;
   if(env.STORAGE_RESTORE_MODE!=='enabled'||frozenSource!==true||clock()>=expiresAt||!env.SOURCE||!env.TARGET||env.SOURCE===env.TARGET
    ||typeof env.STORAGE_RESTORE_QUEUE?.send!=='function'
    ||await api.authorityRestoreContractDigest(fixed)!==contractDigest)fail('MIGRATION_CONFIGURATION_INVALID');
   return true;
 };
 const readState=async target=>{
   const objects=(await target.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? OR name=?').bind(TABLE,TABLE).all()).results;
   if(objects.length===0){
    // The first target mutation is allowed only on the exact fresh restore base.
    if(await api.authoritySchemaDigest(await api.authoritySchemaInventory(target))!==fixed.targetBaseSchemaDigest)fail('MIGRATION_TARGET_INVALID');
    await target.batch([target.prepare(DDL),target.prepare(`INSERT INTO ${TABLE} VALUES(1,?,?,'freeze-source',0,NULL)`).bind(contractDigest,executionDigest)]);
   }else if(objects.length!==1||objects[0].type!=='table'||objects[0].name!==TABLE||objects[0].sql!==DDL)fail('MIGRATION_JOURNAL_INVALID');
   const state=await target.prepare(`SELECT contract_digest,execution_digest,stage,steps,intent FROM ${TABLE} WHERE id=1`).first();
   if(!state||state.contract_digest!==contractDigest||state.execution_digest!==executionDigest||!Number.isSafeInteger(state.steps)||state.steps<0
    ||state.steps===Number.MAX_SAFE_INTEGER||!(state.stage===null||STORAGE_RESTORE_STAGES.includes(state.stage))
    ||!(state.intent===null||state.intent===state.stage))fail('MIGRATION_JOURNAL_INVALID');
   return state;
 };
 const wakeup=async(env,state)=>{
  if(state.intent!==null)fail('RESTORE_RECONCILE_REQUIRED');
  if(state.stage!==null){
   if(clock()>=expiresAt)fail('MIGRATION_CONFIGURATION_INVALID');
   await env.STORAGE_RESTORE_QUEUE.send({schema:'d1-storage-restore-wakeup-v1',contractDigest,stage:state.stage,steps:state.steps});
  }
 };
 return {
  fetch(){return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});},
  async scheduled(_controller,env){
   if(!await enabled(env))return;
   await wakeup(env,await readState(env.TARGET));
  },
  async queue(batch,env){
   if(!await enabled(env))return;
   // Exactly one bounded page per invocation; deployment also sets consumer
   // concurrency to one. The durable claim remains the correctness boundary.
   if(!Array.isArray(batch?.messages)||batch.messages.length!==1)fail('MIGRATION_MESSAGE_INVALID');
   const message=batch.messages[0],body=message.body;
   if(!body||Object.keys(body).sort().join()!=='contractDigest,schema,stage,steps'
    ||body.schema!=='d1-storage-restore-wakeup-v1'||body.contractDigest!==contractDigest
    ||!Number.isSafeInteger(body.steps)||body.steps<0||!STORAGE_RESTORE_STAGES.includes(body.stage)
    ||typeof message.ack!=='function')fail('MIGRATION_MESSAGE_INVALID');
   const source=env.SOURCE,target=env.TARGET,state=await readState(target);
   // Lost send/ack responses may duplicate a wakeup. It names an exact step,
   // so replay acknowledges old work without advancing another page.
   if(body.steps<state.steps){message.ack();return;}
   if(body.steps!==state.steps||body.stage!==state.stage)fail('MIGRATION_MESSAGE_INVALID');
   if(state.intent!==null)fail('RESTORE_RECONCILE_REQUIRED');
   if(clock()>=expiresAt)fail('MIGRATION_CONFIGURATION_INVALID');
   // This CAS is the invocation lease. A concurrent schedule can neither call a
   // second page nor clear an uncertain intent. No wall-clock lease stealing.
   const claimed=await target.prepare(`UPDATE ${TABLE} SET intent=? WHERE id=1 AND contract_digest=? AND execution_digest=? AND steps=? AND stage=? AND intent IS NULL
    AND ${JOURNAL_GUARD} RETURNING id`)
    .bind(state.stage,contractDigest,executionDigest,state.steps,state.stage,DDL).all();
   if(claimed.results.length!==1)fail('RESTORE_RECONCILE_REQUIRED');
   const result=await runStorageRestoreStep({api,source,target,contract:fixed,contractDigest,stage:state.stage});
   const completed=await target.prepare(`UPDATE ${TABLE} SET stage=?,steps=steps+1,intent=NULL WHERE id=1 AND contract_digest=? AND execution_digest=? AND steps=? AND stage=? AND intent=?
    AND ${JOURNAL_GUARD} RETURNING id`)
    .bind(result.nextStage,contractDigest,executionDigest,state.steps,state.stage,state.stage,DDL).all();
   if(completed.results.length!==1)fail('RESTORE_RECONCILE_REQUIRED');
   // Sending only after the progress commit leaves a safe lost-send boundary:
   // the next cron reads the exact new state and queues it without rerunning us.
   await wakeup(env,{stage:result.nextStage,steps:state.steps+1,intent:null});
   message.ack();
  },
 };
}
