import {expect,it} from 'vitest';
import {createNativePreviewActionGuard} from './helpers/analytics-preview-counter';
function fake(){const calls:string[]=[];const result={success:true,results:[],meta:{changes:0}};
 const statement=(sql:string):D1PreparedStatement=>({bind:()=>statement(sql),run:async()=>{calls.push(sql);return result;},all:async()=>{calls.push(sql);return result;},first:async()=>{calls.push(sql);return null;},raw:async()=>{calls.push(sql);return [];}} as unknown as D1PreparedStatement);
 const db={prepare:statement,batch:async(items:D1PreparedStatement[])=>Promise.all(items.map(item=>item.run()))} as unknown as D1Database;
 return {db,calls,result};
}
it('allows native unrelated target work and exact preview reads without claiming to trace a write',async()=>{
 const f=fake(),g=createNativePreviewActionGuard(f.db);
 expect(await g.target.prepare('SELECT * FROM analytics_community_graph_previews WHERE source_id=?').bind('synthetic').all()).toBe(f.result);
 await g.target.batch([g.target.prepare('UPDATE analytics_owner_state SET revision=revision+1 WHERE source_id=?').bind('synthetic')]);
 expect(f.calls).toHaveLength(2);expect(g.assertNoMutation()).toEqual({contract:'native-preview-zero-action-writes-v1',previewMutationAttempts:0,unsupportedAttempts:0});
});
it('rejects all preview mutation methods before execution and remains sticky even when callers catch them',async()=>{
 for(const sql of ['UPDATE analytics_community_graph_previews SET revision=revision','-- comment\n DELETE FROM analytics_community_graph_previews','WITH x AS (SELECT 1) DELETE FROM analytics_community_graph_previews','INSERT INTO analytics_community_graph_previews SELECT * FROM analytics_community_graph_previews']){
  for(const method of ['run','all','first','raw'] as const){const f=fake(),g=createNativePreviewActionGuard(f.db);
   expect(()=>{const statement=g.target.prepare(sql);return Reflect.apply(Reflect.get(statement,method) as ()=>unknown,statement,[]);}).toThrow('PREVIEW_ACTION_MUTATION');expect(f.calls).toHaveLength(0);expect(()=>g.assertNoMutation()).toThrow('INCOMPLETE');}
 }
 const f=fake(),g=createNativePreviewActionGuard(f.db);expect(()=>g.target.batch([g.target.prepare('SELECT 1'),g.target.prepare('DELETE FROM analytics_community_graph_previews')])).toThrow('MUTATION');expect(f.calls).toHaveLength(0);
});
it('refuses DDL, foreign batches and unsupported methods without silently bypassing action coverage',()=>{
 for(const sql of ['CREATE TRIGGER test AFTER INSERT ON other BEGIN DELETE FROM analytics_community_graph_previews; END','/* prefix */ DROP TABLE other','PRAGMA foreign_keys=OFF']){const f=fake(),g=createNativePreviewActionGuard(f.db);expect(()=>g.target.prepare(sql).run()).toThrow('SCHEMA_MUTATION');expect(()=>g.assertNoMutation()).toThrow('INCOMPLETE');expect(f.calls).toHaveLength(0);}
 const f=fake(),g=createNativePreviewActionGuard(f.db);expect(()=>g.target.batch([f.db.prepare('SELECT 1')])).toThrow('FOREIGN_BATCH');expect(()=>g.assertNoMutation()).toThrow('INCOMPLETE');
 for(const method of ['exec','dump','withSession']){const guard=createNativePreviewActionGuard(fake().db);expect(()=>Reflect.get(guard.target,method)('SELECT 1')).toThrow('UNSUPPORTED_METHOD');expect(()=>guard.assertNoMutation()).toThrow('INCOMPLETE');}
});

// Counter metadata classification is independent from action mutation refusal.
import {createNativePreviewCounter} from './helpers/analytics-preview-counter';
import {sha256Hex} from '../src/crypto';
const retirementMetadataSql=[
 'PRAGMA table_info(analytics_partition_work)',
 'PRAGMA table_info(analytics_partition_canonical_effects)',
 'PRAGMA table_info(analytics_partition_effect_refs)',
];
it('recognizes only the three unchanged unbound native batch metadata reads',async()=>{
 const f=fake(),counter=createNativePreviewCounter('synthetic-p11-metadata'),observed=counter.wrap(f.db);
 const results=await observed.batch(retirementMetadataSql.map(sql=>observed.prepare(sql)));
 expect(f.calls).toEqual(retirementMetadataSql);expect(results).toEqual([f.result,f.result,f.result]);
 for(const result of results)expect(result).toBe(f.result);
 expect(counter.diagnostic()).toMatchObject({complete:false,gaps:[],classification:{
  readOnlyMetadata:{statements:3,shapes:[
   {id:'partition_work_columns',method:'batch',attempts:1},
   {id:'canonical_effect_columns',method:'batch',attempts:1},
   {id:'effect_reference_columns',method:'batch',attempts:1},
  ]},unsupported:{attempts:0,fingerprints:[],overflow:false}}});
 counter.close();
});
it('keeps unknown or mutating PRAGMAs, SQL suffixes, binds and every nonnative method sticky with only hashed diagnostics',async()=>{
 const variants=[
  {sql:'PRAGMA foreign_keys=OFF',method:'batch',bound:[]},
  {sql:'PRAGMA table_info(analytics_owner_state)',method:'batch',bound:[]},
  {sql:retirementMetadataSql[0]+'; SELECT 1',method:'batch',bound:[]},
  {sql:retirementMetadataSql[0]+' ',method:'batch',bound:[]},
  {sql:retirementMetadataSql[0]!,method:'batch',bound:['synthetic-private-bind-marker']},
  ...(['run','all','first','raw'] as const).map(method=>({sql:retirementMetadataSql[0]!,method,bound:[]})),
 ];
 for(const variant of variants){
  const f=fake(),counter=createNativePreviewCounter('synthetic-p11-metadata'),observed=counter.wrap(f.db);
  const statement=observed.prepare(variant.sql).bind(...variant.bound);
  if(variant.method==='batch')await observed.batch([statement]);
  else await Reflect.apply(Reflect.get(statement,variant.method) as ()=>Promise<unknown>,statement,[]);
  // A later legitimate call cannot erase the caught classification gap.
  await observed.batch(retirementMetadataSql.map(sql=>observed.prepare(sql)));
  const receipt=counter.diagnostic();expect(receipt.gaps).toEqual(['UNREVIEWED_TARGET_DDL','UNSUPPORTED_SQL_SHAPE']);
  expect(receipt.classification.unsupported).toEqual({attempts:1,fingerprintLimit:64,omittedAttempts:0,overflow:false,
   fingerprints:[{sha256:await sha256Hex(variant.sql),method:variant.method,attempts:1,reasons:['UNSUPPORTED_SQL_SHAPE','UNREVIEWED_TARGET_DDL']}]});
  const encoded=JSON.stringify(receipt);expect(encoded).not.toContain(variant.sql);expect(encoded).not.toContain('synthetic-private-bind-marker');
  expect(f.calls).toEqual([variant.sql,...retirementMetadataSql]);counter.close();
 }
});
it('retains bounded unsupported fingerprint evidence and explicit overflow without clearing the trace refusal',async()=>{
 const f=fake(),counter=createNativePreviewCounter('synthetic-p11-metadata'),observed=counter.wrap(f.db);
 for(let i=0;i<65;i++)await observed.prepare(`PRAGMA table_info(synthetic_unknown_${i})`).all();
 await observed.prepare('PRAGMA table_info(synthetic_unknown_0)').all();
 const receipt=counter.diagnostic();expect(receipt.classification.unsupported).toMatchObject({attempts:66,fingerprintLimit:64,omittedAttempts:1,overflow:true});
 expect(receipt.classification.unsupported.fingerprints).toHaveLength(64);
 expect(receipt.classification.unsupported.fingerprints[0]).toMatchObject({attempts:2});
 expect(receipt.gaps).toContain('UNSUPPORTED_FINGERPRINT_BOUND');expect(JSON.stringify(receipt)).not.toContain('synthetic_unknown_');counter.close();
});
