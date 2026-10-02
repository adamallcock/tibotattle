import {expect,it} from 'vitest';
import publication from '../analytics-migrations/0011_community_graph_publication.sql?raw';
import fences from '../analytics-migrations/0014_publication_erasure_fences.sql?raw';
import {startFunctionalActionPreviewTrace,assertFunctionalActionPreviewStartup} from './helpers/analytics-functional-action-trace';
import {nativePreviewCounterSql} from './helpers/analytics-preview-counter';
import {createWholeWorkloadMeter} from './helpers/analytics-whole-workload';
const sourceId='synthetic-p11-action-trace';
function fixture(){
 const schema=[{type:'table',name:'analytics_community_graph_previews',tbl_name:'analytics_community_graph_previews',sql:publication.match(/CREATE TABLE analytics_community_graph_previews[\s\S]*?WITHOUT ROWID/u)![0]},...(['insert','update'] as const).map(operation=>({type:'trigger',name:'analytics_preview_authority_'+operation,tbl_name:'analytics_community_graph_previews',sql:fences.match(new RegExp('CREATE TRIGGER analytics_preview_authority_'+operation+'[\\s\\S]*?END','u'))![0]}))];
 const initial={source_id:sourceId,revision:1,method:'synthetic',cohort_digest:'a',authority_json:'{}',model_revision:1,payload_json:'{}',payload_sha256:'b',generated_at:'2026-10-01T12:00:00.000Z',snapshot_source_epoch:1,inputs_current:1,oldest_computed_ms:1,newest_computed_ms:1};
 const database=()=>{let row:Record<string,unknown>|null=structuredClone(initial),queries=0;const statement=(sql:string):D1PreparedStatement=>({bind:()=>statement(sql),all:async()=>{queries++;const results=sql.includes('sqlite_schema')?schema:row?[structuredClone(row)]:[];return {success:true,results,meta:{rows_read:results.length,rows_written:0,duration:0}};},run:async()=>{queries++;row=null;return {success:true,results:[],meta:{rows_read:1,rows_written:1,duration:0}};}} as unknown as D1PreparedStatement);
  return {db:{prepare:statement} as unknown as D1Database,read:()=>row,queries:()=>queries,tamper:()=>{row={...initial,payload_json:'{"altered":true}'};}};};
 const reference=database(),candidate=database(),stores=(target:D1Database)=>({source:database().db,target,ledger:database().db});
 return {reference,candidate,initial,context:{reference:stores(reference.db),candidate:stores(candidate.db),now:Date.now,analyticalNowMs:Date.now()}};
}
it('binds opaque action checkpoints to exact actual full rows, including native retirement to null',async()=>{
 const f=fixture(),trace=await startFunctionalActionPreviewTrace({context:f.context,sourceId,expected:{reference:f.initial,candidate:f.initial}});
 for(const lane of ['reference','candidate'] as const){const db=f.context[lane],meter=createWholeWorkloadMeter(db.source,db.target,undefined,undefined,db.ledger,undefined,trace.targetObservers[lane]);
  await meter.invocation('retire',stores=>stores.target.prepare(nativePreviewCounterSql('retire')).bind(sourceId,'obsolete',sourceId,1,1,2).run());expect(meter.profile.maximumStatementsPerInvocation).toBe(4);
 }
 const complete=await trace.finish();for(const lane of ['reference','candidate'] as const){const checkpoint=complete.checkpoints[lane];assertFunctionalActionPreviewStartup(checkpoint,null);expect(checkpoint.receipt).toMatchObject({complete:true,initialRevision:1,finalRevision:null,counts:{retire:1}});expect(()=>assertFunctionalActionPreviewStartup(checkpoint,f.initial)).toThrow('UNPROVED_STARTUP');expect(()=>assertFunctionalActionPreviewStartup({receipt:checkpoint.receipt},null)).toThrow('UNPROVED_STARTUP');expect(complete.receipt.controls[lane]).toMatchObject({statements:5,metadataSamples:5,maximumStatementsPerInvocation:3});}
 await expect(trace.finish()).rejects.toThrow('CLOSED');trace.close();
});
it('does not turn an unobserved payload change or forged checkpoint into action proof',async()=>{
 const f=fixture(),trace=await startFunctionalActionPreviewTrace({context:f.context,sourceId,expected:{reference:f.initial,candidate:f.initial}});f.reference.tamper();
 await expect(trace.finish()).rejects.toThrow('FINAL_ROW');expect(trace.diagnostic().complete).toBe(false);trace.close();expect(()=>assertFunctionalActionPreviewStartup({receipt:{complete:true}},null)).toThrow('UNPROVED_STARTUP');
});
