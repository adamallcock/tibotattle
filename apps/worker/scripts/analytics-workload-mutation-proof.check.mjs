import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertAnalyticsMutationProof,MUTATION_SNAPSHOT_SCHEMA,MUTATION_SOURCE_TABLES,
 MUTATION_TARGET_TABLES,MUTATION_CANDIDATE_ONLY_TABLES,MUTATION_REQUIRED_COLUMNS} from './analytics-workload-mutation-proof.mjs';

const A='a'.repeat(64),B='b'.repeat(64),P='c'.repeat(64),R='d'.repeat(64),OWNER='e'.repeat(64),MANIFEST='f'.repeat(64);
const NOW=10_500,OLD='1970-01-01T00:00:01.000Z',ISO=new Date(NOW).toISOString();
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
 ?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
function cell(value){if(value===null)return ['null',null];if(Number.isInteger(value))return ['integer',String(value)];return ['text',value];}
function table(names,keys=['id'],values=[]){const columns=names.map(name=>({name,type:name.endsWith('_ms')||['sequence','revision','authority_epoch','public_authority_epoch','head_revision'].includes(name)?'INTEGER':'TEXT'}));
 const rows=values.map(obj=>({key:keys.map(name=>cell(obj[name])),cells:names.map(name=>cell(obj[name]??null))}));
 rows.sort((a,b)=>canonical(a.key).localeCompare(canonical(b.key)));return {columns,keyColumns:keys,rows};}
function set(store,name,obj){const t=store.tables[name];const names=t.columns.map(c=>c.name);t.rows.push({key:t.keyColumns.map(k=>cell(obj[k])),cells:names.map(n=>cell(obj[n]??null))});t.rows.sort((a,b)=>canonical(a.key).localeCompare(canonical(b.key)));}
function change(store,name,key,patch){const t=store.tables[name],row=t.rows.find(r=>canonical(r.key)===canonical(t.keyColumns.map(k=>cell(key[k]))));assert.ok(row);for(const [name,value] of Object.entries(patch))row.cells[t.columns.findIndex(c=>c.name===name)]=cell(value);}
function makeStore(names){return {schemaSha256:A,tables:Object.fromEntries(names.map(name=>[name,table(MUTATION_REQUIRED_COLUMNS[name]??['id'], MUTATION_REQUIRED_COLUMNS[name]?.includes('id')?['id']:[MUTATION_REQUIRED_COLUMNS[name]?.[0]??'id'])]))};}
function fixture(kind='unrelated_append'){
 const before={},after={};for(const lane of ['reference','candidate']){
  const source=makeStore([...MUTATION_SOURCE_TABLES,...(lane==='candidate'?MUTATION_CANDIDATE_ONLY_TABLES:[])]);
  const target={...makeStore(MUTATION_TARGET_TABLES),stepPreimages:[]};
  // Source tables referenced by the fixed native event proof.
  Object.assign(source.tables,{
   storage_source_state:table(['singleton','source_id','authority_epoch'],['singleton'],[{singleton:1,source_id:'source',authority_epoch:1}]),
   storage_owner_revisions:table(['owner_digest','revision','authority_epoch','state'],['owner_digest'],[{owner_digest:OWNER,revision:1,authority_epoch:1,state:'active'}]),
   storage_v11_owner_links:table(MUTATION_REQUIRED_COLUMNS.storage_v11_owner_links,['participant_id'],[{participant_id:'owner',owner_digest:OWNER,state:'active',generation_id:'g0',head_revision:1,object_digest:P,manifest_digest:MANIFEST}]),
   storage_ingestion_changes:table(MUTATION_REQUIRED_COLUMNS.storage_ingestion_changes,['sequence'],[{sequence:1,event_digest:P,owner_digest:OWNER,revision:1,kind:'owner-active',object_digest:P,content_digest:MANIFEST,authority_epoch:1,public_authority_epoch:1,recorded_ms:1_000}]),
   storage_v11_event_sources:table(MUTATION_REQUIRED_COLUMNS.storage_v11_event_sources,['event_digest'],[{event_digest:P,owner_digest:OWNER,participant_id:'owner',device_id:'device',generation_id:'g0',manifest_digest:MANIFEST,from_day:'2026-09-29',through_day:'2026-09-29',head_revision:1,input_revision:1,recorded_ms:1_000}]),
   storage_v12_event_sources:table(MUTATION_REQUIRED_COLUMNS.storage_v12_event_sources,['event_digest']),
   telemetry_v11_domains:table(['id','participant_id','manifest_digest','previous_generation_id','predecessor_token_hash','created_at'],['id'],[{id:'g0',participant_id:'owner',manifest_digest:MANIFEST,previous_generation_id:null,predecessor_token_hash:'t0',created_at:OLD}]),
   telemetry_v11_domain_days:table(['generation_id','observed_day','manifest_id'],['generation_id','observed_day'],[{generation_id:'g0',observed_day:'2026-09-29',manifest_id:'m0'}]),
   telemetry_v11_domain_heads:table(['participant_id','generation_id','revision','updated_at'],['participant_id'],[{participant_id:'owner',generation_id:'g0',revision:1,updated_at:OLD}]),
   telemetry_v11_domain_predecessors:table(['token_hash','consumed_at','expires_at'],['token_hash'],[{token_hash:'t0',consumed_at:OLD,expires_at:'2099-01-01T00:00:00.000Z'}]),
   telemetry_v12_domains:table(['id','participant_id','manifest_digest','previous_generation_id','predecessor_token_hash','created_at'],['id'],kind==='old_correction'?[{id:'v0',participant_id:'owner',manifest_digest:MANIFEST,previous_generation_id:null,predecessor_token_hash:'u0',created_at:OLD}]:[]),
   telemetry_v12_domain_days:table(['generation_id','observed_day','manifest_id','manifest_digest'],['generation_id','observed_day'],kind==='old_correction'?[{generation_id:'v0',observed_day:'2026-09-29',manifest_id:'q0',manifest_digest:MANIFEST}]:[]),
   telemetry_v12_domain_heads:table(['participant_id','generation_id','revision','updated_at'],['participant_id'],kind==='old_correction'?[{participant_id:'owner',generation_id:'v0',revision:1,updated_at:OLD}]:[]),
   telemetry_v12_domain_predecessors:table(['token_hash','consumed_at','expires_at'],['token_hash'],kind==='old_correction'?[{token_hash:'u0',consumed_at:OLD,expires_at:'2099-01-01T00:00:00.000Z'}]:[]),
   accountless_v11_device_authorizations:table(['id','state','expires_at'],['id'],[{id:'auth',state:'active',expires_at:'2099-01-01T00:00:00.000Z'}]),
   accountless_v12_device_authorizations:table(['id','state','expires_at'],['id'],[{id:'auth',state:'active',expires_at:'2099-01-01T00:00:00.000Z'}]),
  });
  Object.assign(target.tables,{
   analytics_applied_events:table(MUTATION_REQUIRED_COLUMNS.analytics_applied_events,['source_id','sequence'],[{source_id:'source',sequence:1,event_digest:P,owner_digest:OWNER,revision:1,kind:'owner-active',object_digest:P,content_digest:MANIFEST,authority_epoch:1,public_authority_epoch:1,recorded_ms:1_000}]),
   analytics_source_cursors:table(MUTATION_REQUIRED_COLUMNS.analytics_source_cursors,['source_id'],[{source_id:'source',sequence:1,authority_epoch:1}]),
   analytics_owner_state:table(MUTATION_REQUIRED_COLUMNS.analytics_owner_state,['source_id','owner_digest'],[{source_id:'source',owner_digest:OWNER,revision:1,authority_epoch:1,state:'active'}]),
   analytics_v11_projection_steps:table(MUTATION_REQUIRED_COLUMNS.analytics_v11_projection_steps,['source_id','event_digest','revision']),
   analytics_v11_projection_work:table(['source_id','event_digest','owner_digest','generation_id','manifest_digest','from_day','through_day','next_day','revision','phase'],['source_id','event_digest']),
   analytics_v11_owner_heads:table(['source_id','owner_digest','event_digest','sequence'],['source_id','owner_digest']),
   analytics_v11_day_references:table(['source_id','event_digest','day','value_key'],['source_id','event_digest','day']),
   analytics_community_daily_queue:table(['source_id','day','revision'],['source_id','day']),
  });
  before[lane]={schemaVersion:MUTATION_SNAPSHOT_SCHEMA,source,target,affectedDays:[]};
  after[lane]=structuredClone(before[lane]);
  if(kind==='no_op')continue;
  const next=after[lane],D=lane==='reference'?A:B,time=lane==='reference'?10_000:11_000;
  const format=kind==='unrelated_append'?'v11':'v12',gen=format==='v11'?'g1':'v1',oldGen=format==='v11'?'g0':'v0',token=format==='v11'?'t1':'u1';
  const authority=2,journalKind='owner-active';
  const event={event_digest:D,owner_digest:OWNER,participant_id:'owner',device_id:'device',generation_id:gen,manifest_digest:MANIFEST,head_revision:2,recorded_ms:time};
  if(format==='v11')Object.assign(event,{from_day:'2026-09-29',through_day:'2026-09-30',input_revision:2});
  else event.previous_generation_id=oldGen;
  set(next.source,`storage_${format}_event_sources`,event);
  set(next.source,'storage_ingestion_changes',{sequence:2,event_digest:D,owner_digest:OWNER,revision:2,kind:journalKind,object_digest:D,content_digest:MANIFEST,authority_epoch:authority,public_authority_epoch:authority,recorded_ms:time});
  change(next.source,'storage_owner_revisions',{owner_digest:OWNER},{revision:2,authority_epoch:authority});
  change(next.source,'storage_source_state',{singleton:1},{authority_epoch:authority});
  if(format==='v11')change(next.source,'storage_v11_owner_links',{participant_id:'owner'},{generation_id:gen,head_revision:2,object_digest:D});
  set(next.source,`telemetry_${format}_domains`,{id:gen,participant_id:'owner',manifest_digest:MANIFEST,previous_generation_id:oldGen,predecessor_token_hash:token,created_at:ISO});
  set(next.source,`telemetry_${format}_domain_days`,{generation_id:gen,observed_day:'2026-09-29',manifest_id:format==='v11'?'m0':'q0',manifest_digest:format==='v11'?null:MANIFEST});
  set(next.source,`telemetry_${format}_domain_days`,{generation_id:gen,observed_day:'2026-09-30',manifest_id:format==='v11'?'m1':'q1',manifest_digest:format==='v11'?null:'1'.repeat(64)});
  change(next.source,`telemetry_${format}_domain_heads`,{participant_id:'owner'},{generation_id:gen,revision:2,updated_at:ISO});
  set(next.source,`telemetry_${format}_domain_predecessors`,{token_hash:token,consumed_at:ISO,expires_at:'2099-01-01T00:00:00.000Z'});
  set(next.target,'analytics_applied_events',{source_id:'source',sequence:2,event_digest:D,owner_digest:OWNER,revision:2,kind:journalKind,object_digest:D,content_digest:MANIFEST,authority_epoch:authority,public_authority_epoch:authority,recorded_ms:time});
  change(next.target,'analytics_source_cursors',{source_id:'source'},{sequence:2,authority_epoch:authority});
  change(next.target,'analytics_owner_state',{source_id:'source',owner_digest:OWNER},{revision:2,authority_epoch:authority});
  if(format==='v11'){
   set(next.target,'analytics_v11_projection_work',{source_id:'source',event_digest:D,owner_digest:OWNER,generation_id:gen,manifest_digest:MANIFEST,from_day:'2026-09-29',through_day:'2026-09-30',next_day:'2026-10-01',revision:2,phase:'ready'});
   const first={eventDigest:D,revision:1,day:'2026-09-29',afterStream:'',afterOccurrence:'',recordCount:1,completeDay:true,valueKey:'prior-value',pageDigest:null,values:{day:'2026-09-29',count:1}};
   const preimage={eventDigest:D,revision:1,day:'2026-09-30',afterStream:'',afterOccurrence:'',recordCount:1,completeDay:true,valueKey:'value',pageDigest:null,values:{day:'2026-09-30',count:1}};
   preimage.revision=2;
   set(next.target,'analytics_v11_projection_steps',{source_id:'source',event_digest:D,revision:1,step_digest:sha(canonical(first))});
   set(next.target,'analytics_v11_projection_steps',{source_id:'source',event_digest:D,revision:2,step_digest:sha(canonical(preimage))});
   next.target.stepPreimages=[{eventDigest:D,revision:1,preimage:first},{eventDigest:D,revision:2,preimage}];
   set(next.target,'analytics_v11_owner_heads',{source_id:'source',owner_digest:OWNER,event_digest:D,sequence:2});
   set(next.target,'analytics_v11_day_references',{source_id:'source',event_digest:D,day:'2026-09-29',value_key:'prior-value'});
   set(next.target,'analytics_v11_day_references',{source_id:'source',event_digest:D,day:'2026-09-30',value_key:'value'});
  }
  set(next.target,'analytics_community_daily_queue',{source_id:'source',day:'2026-09-30',revision:1});
  next.affectedDays=['2026-09-30'];
 }
 return {before,after,action:{kind,nowEpoch:NOW,intervals:{reference:{startMs:10_000,endMs:10_900},candidate:{startMs:11_000,endMs:11_900}}}};
}
function rejects(input,code){assert.throws(()=>assertAnalyticsMutationProof(input),new RegExp(`ANALYTICS_MUTATION_PROOF_${code}$`));}
for(const kind of ['unrelated_append','old_correction','no_op']){
 const receipt=assertAnalyticsMutationProof(fixture(kind));assert.equal(receipt.schemaVersion,'analytics-mutation-proof-v1');assert.equal(receipt.verified.newEvents,kind==='no_op'?0:1);
}
{
 const x=fixture();change(x.after.candidate.source,'storage_ingestion_changes',{sequence:2},{recorded_ms:12_000});rejects(x,'EVENT_LINEAGE');
}
{
 const x=fixture();change(x.after.candidate.source,'storage_v11_event_sources',{event_digest:B},{recorded_ms:12_000});change(x.after.candidate.source,'storage_ingestion_changes',{sequence:2},{recorded_ms:12_000});change(x.after.candidate.target,'analytics_applied_events',{source_id:'source',sequence:2},{recorded_ms:12_000});rejects(x,'EVENT_TIME_INTERVAL');
}
{
 const x=fixture();change(x.after.candidate.target,'analytics_applied_events',{source_id:'source',sequence:2},{recorded_ms:12_000});rejects(x,'RECEIPT_COPY');
}
{
 const x=fixture();change(x.after.candidate.source,'storage_ingestion_changes',{sequence:1},{recorded_ms:2_000});rejects(x,'PRIOR_ROW_CHANGED');
}
{
 const x=fixture();change(x.after.candidate.source,'telemetry_v11_domains',{id:'g1'},{created_at:'1970-01-01T00:00:11.000Z'});rejects(x,'COMMON_TABLE_DIVERGENCE');
}
{
 const x=fixture();change(x.after.candidate.target,'analytics_v11_projection_steps',{source_id:'source',event_digest:B,revision:2},{step_digest:R});rejects(x,'STEP_DIGEST');
}
{
 const x=fixture();x.after.candidate.target.stepPreimages=[];rejects(x,'STEP_COUNT');
}
{
 const x=fixture();change(x.after.candidate.target,'analytics_v11_projection_work',{source_id:'source',event_digest:B},{phase:'building'});rejects(x,'WORK_CLOSURE');
}
{
 const x=fixture();x.after.candidate.target.tables.analytics_v11_day_references.rows.pop();rejects(x,'DAY_CLOSURE');
}
{
 const x=fixture();change(x.after.candidate.source,'storage_ingestion_changes',{sequence:2},{authority_epoch:3});
 change(x.after.candidate.target,'analytics_applied_events',{source_id:'source',sequence:2},{authority_epoch:3});rejects(x,'AUTHORITY_LINEAGE');
}
{
 const x=fixture();change(x.after.candidate.source,'storage_v11_event_sources',{event_digest:B},{manifest_digest:R});rejects(x,'EVENT_LINEAGE');
}
{
 const x=fixture();x.after.candidate.source.tables.accountless_v11_device_authorizations.rows[0].cells[2]=cell('2098-01-01T00:00:00.000Z');rejects(x,'COMMON_TABLE_DIVERGENCE');
}
{
 const x=fixture();x.before.candidate.source.tables.accountless_v11_device_authorizations.rows[0].cells[2]=cell('1970-01-01T00:00:11.000Z');rejects(x,'CUTOFF_BOUNDARY');
}
{
 const x=fixture('no_op');change(x.after.reference.source,'storage_ingestion_changes',{sequence:1},{recorded_ms:2_000});rejects(x,'NO_OP_CHANGED');
}
{
 const x=fixture('no_op');set(x.after.candidate.target,'analytics_v11_projection_steps',
  {source_id:'source',event_digest:P,revision:1,step_digest:R});rejects(x,'NO_OP_CHANGED');
}
// A deadline strictly between lane calls is absent from either call interval.
{
 const x=fixture(),expiry='1970-01-01T00:00:10.950Z';
 for(const phase of ['before','after'])for(const lane of ['reference','candidate'])
  x[phase][lane].source.tables.accountless_v11_device_authorizations.rows[0].cells[2]=cell(expiry);
 rejects(x,'CUTOFF_BOUNDARY');
}
// Freshly changed expiry evidence must also keep the common temporal boundary.
{
 const x=fixture(),expiry='1970-01-01T00:00:10.950Z';
 for(const lane of ['reference','candidate'])
  x.after[lane].source.tables.accountless_v12_device_authorizations.rows[0].cells[2]=cell(expiry);
 rejects(x,'CUTOFF_BOUNDARY');
}
console.log('analytics mutation proof synthetic checks passed: 20');
