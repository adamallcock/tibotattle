import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertAnalyticsMutationProofV2,MUTATION_SNAPSHOT_SCHEMA,MUTATION_SOURCE_TABLES,
 MUTATION_TARGET_TABLES,MUTATION_CANDIDATE_ONLY_TABLES,MUTATION_REQUIRED_COLUMNS} from './analytics-workload-mutation-proof-v2.mjs';
const OPTIONS={contract:'native-existing-owner-v2',clockPolicy:'native-v11-trigger-clocks-v1'};

const A='a'.repeat(64),B='b'.repeat(64),P='c'.repeat(64),R='d'.repeat(64),OWNER='e'.repeat(64),MANIFEST='f'.repeat(64);
const NOW=10_500,OLD='1970-01-01T00:00:01.000Z',ISO=new Date(NOW).toISOString();
const SELECTED_DAY='2026-09-30',SELECTED_DAY_NUMBER=Date.parse(SELECTED_DAY+'T00:00:00.000Z')/86_400_000,
 SELECTED_AT=Date.parse(SELECTED_DAY+'T12:00:00.000Z');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
 ?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
function cell(value){if(value===null)return ['null',null];if(value&&typeof value==='object'&&'blobHex' in value)return ['blob',value.blobHex];
 if(Number.isInteger(value))return ['integer',String(value)];return ['text',value];}
const blob=value=>({blobHex:'00'+Buffer.from(value,'utf8').toString('hex').toUpperCase()});
const digestBlob=value=>({blobHex:value.toUpperCase()});
const PHYSICAL={
 state:['id','source_namespace','namespace_id','next_source_row_id'],
 ownerMembership:['participant_id','typed_owner_id'],
 allocation:['chunk_id','namespace_id','chunk_original','first_source_row_id','record_count'],
 manifestMembership:['manifest_id','typed_manifest_id'],
 proof:['typed_record_id','chunk_key','manifest_key','stream_code','occurrence_blob','base_digest','legacy_occurrence_blob','legacy_digest','observed_at_ms'],
 namespace:['id','original_id'],owner:['id','namespace_id','original_id'],
 device:['id','namespace_id','owner_id','original_id'],
 manifest:['id','namespace_id','owner_id','device_id','original_id','chunk_day'],
 chunk:['id','namespace_id','format','owner_id','device_id','manifest_id','original_id','stream','chunk_day'],
 record:['id','namespace_id','format','source_row_id','owner_id','device_id','chunk_id','manifest_id','stream','occurrence_id','observed_at_ms','observed_day','provider_id','canonical_digest'],
 usage:['record_id','stream','session_id','model_id','speed_mode_id','api_service_tier_id','surface_id','billing_surface_id',
  'reasoning_effort_id','agent_scope_id','outcome_id','attribution_id','total_input_context_tokens','input_uncached_tokens',
  'input_cache_read_tokens','input_cache_write_tokens','output_text_tokens','output_reasoning_tokens','output_combined_tokens'],
};
function table(names,keys=['id'],values=[]){const columns=names.map(name=>({name,type:name.endsWith('_ms')||['sequence','revision','authority_epoch','public_authority_epoch','head_revision',
 'singleton','singleton_id','mutation_epoch','graph_append_epoch','graph_invalidation_epoch','is_append','compared_records'].includes(name)?'INTEGER':'TEXT'}));
 const rows=values.map(obj=>({key:keys.map(name=>cell(obj[name])),cells:names.map(name=>cell(obj[name]??null))}));
 rows.sort((a,b)=>canonical(a.key).localeCompare(canonical(b.key)));return {columns,keyColumns:keys,rows};}
function physical(names,keys,integers,blobs,values=[]){const result=table(names,keys,values);
 result.columns=names.map(name=>({name,type:integers.includes(name)?'INTEGER':blobs.includes(name)?'BLOB':'TEXT'}));return result;}
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
   storage_v11_append_transitions:table(MUTATION_REQUIRED_COLUMNS.storage_v11_append_transitions,['generation_id']),
   community_snapshot_mutation_control:table(MUTATION_REQUIRED_COLUMNS.community_snapshot_mutation_control,['singleton_id'],
    [{singleton_id:1,mutation_epoch:1,graph_append_epoch:-1,graph_invalidation_epoch:-1,
      graph_append_reason:null,graph_last_change_reason:null,graph_last_change_at:OLD,graph_last_invalidated_at:null}]),
   community_allowance_publication_state:table(MUTATION_REQUIRED_COLUMNS.community_allowance_publication_state,['singleton'],
    [{singleton:1,publication_state:'updating',expected_basis:'synthetic-basis',safe_from_day:'1970-01-01',
      safe_to_day:'1970-01-01',changed_at:OLD,attribution_method_version:null}]),
   telemetry_v11_day_manifests:table(['id','participant_id','device_id','chunk_day','manifest_digest','parser_version','manifest_json','expected_chunk_count','state'],['id'],
    [{id:'m0',participant_id:'owner',device_id:'device',chunk_day:'2026-09-29',manifest_digest:MANIFEST,parser_version:'v1',manifest_json:'{"consent":true,"excluded":[],"chunks":[]}',expected_chunk_count:0,state:'ready'},
     {id:'mEmpty',participant_id:'owner',device_id:'device',chunk_day:'2026-09-30',manifest_digest:MANIFEST,parser_version:'v1',manifest_json:'{"consent":true,"excluded":[],"chunks":[]}',expected_chunk_count:0,state:'ready'}]),
   telemetry_v11_chunks:table(['id','manifest_id','participant_id','device_id','stream','chunk_day','chunk_seq','chunk_id','chunk_digest','envelope_digest','parser_version','record_count','r2_key','device_upload_authorization_id','quarantine_deleted_at','created_at'],['id']),
   telemetry_v11_records:table(['chunk_id','manifest_id','stream','occurrence_id','observed_at','record_json','legacy_occurrence_id','legacy_record_json'],['chunk_id','occurrence_id']),
   typed_v11_admission_state:physical(PHYSICAL.state,['id'],['id','namespace_id','next_source_row_id'],[],
    [{id:1,source_namespace:'source-ns',namespace_id:1,next_source_row_id:1}]),
   typed_v11_owner_memberships:physical(PHYSICAL.ownerMembership,['participant_id'],['typed_owner_id'],[],
    [{participant_id:'owner',typed_owner_id:1}]),
   typed_v11_chunk_allocations:physical(PHYSICAL.allocation,['chunk_id'],['namespace_id','first_source_row_id','record_count'],['chunk_original']),
   typed_v11_manifest_memberships:physical(PHYSICAL.manifestMembership,['manifest_id'],['typed_manifest_id'],[]),
   typed_v11_record_proofs:physical(PHYSICAL.proof,['typed_record_id'],['typed_record_id','chunk_key','manifest_key','stream_code','observed_at_ms'],
    ['occurrence_blob','base_digest','legacy_occurrence_blob','legacy_digest']),
   typed_telemetry_namespaces:physical(PHYSICAL.namespace,['id'],['id'],['original_id'],[{id:1,original_id:blob('source-ns')}]),
   typed_telemetry_owners:physical(PHYSICAL.owner,['id'],['id','namespace_id'],['original_id'],[{id:1,namespace_id:1,original_id:blob('owner')}]),
   typed_telemetry_devices:physical(PHYSICAL.device,['id'],['id','namespace_id','owner_id'],['original_id'],
    [{id:1,namespace_id:1,owner_id:1,original_id:blob('device')}]),
   typed_telemetry_manifests:physical(PHYSICAL.manifest,['id'],['id','namespace_id','owner_id','device_id','chunk_day'],['original_id']),
   typed_telemetry_chunks:physical(PHYSICAL.chunk,['id'],['id','namespace_id','format','owner_id','device_id','manifest_id','stream','chunk_day'],['original_id']),
   typed_telemetry_records:physical(PHYSICAL.record,['id'],['id','namespace_id','format','source_row_id','owner_id','device_id','chunk_id','manifest_id','stream','observed_at_ms','observed_day','provider_id'],['occurrence_id','canonical_digest']),
   typed_telemetry_usage:physical(PHYSICAL.usage,['record_id'],PHYSICAL.usage,[]),
   telemetry_v11_domains:table(['id','participant_id','manifest_digest','previous_generation_id','predecessor_token_hash','created_at'],['id'],[{id:'g0',participant_id:'owner',manifest_digest:MANIFEST,previous_generation_id:null,predecessor_token_hash:'t0',created_at:OLD}]),
   telemetry_v11_domain_days:table(['generation_id','observed_day','manifest_id'],['generation_id','observed_day'],
    [{generation_id:'g0',observed_day:'2026-09-29',manifest_id:'m0'},
     {generation_id:'g0',observed_day:'2026-09-30',manifest_id:'mEmpty'}]),
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
  const format=kind==='old_correction'?'v12':'v11',gen=format==='v11'?'g1':'v1',oldGen=format==='v11'?'g0':'v0',token=format==='v11'?'t1':'u1';
  const authority=kind==='unrelated_append'?1:2,journalKind=kind==='unrelated_append'?'source-updated':'owner-active';
  const event={event_digest:D,owner_digest:OWNER,participant_id:'owner',device_id:'device',generation_id:gen,manifest_digest:MANIFEST,head_revision:2,recorded_ms:time};
  if(format==='v11')Object.assign(event,{from_day:'2026-09-29',through_day:'2026-09-30',input_revision:2});
  else event.previous_generation_id=oldGen;
  set(next.source,`storage_${format}_event_sources`,event);
  set(next.source,'storage_ingestion_changes',{sequence:2,event_digest:D,owner_digest:OWNER,revision:2,kind:journalKind,object_digest:D,content_digest:MANIFEST,authority_epoch:authority,public_authority_epoch:authority,recorded_ms:time});
  change(next.source,'storage_owner_revisions',{owner_digest:OWNER},{revision:2,authority_epoch:authority});
  change(next.source,'storage_source_state',{singleton:1},{authority_epoch:authority});
  if(format==='v11')change(next.source,'storage_v11_owner_links',{participant_id:'owner'},{generation_id:gen,head_revision:2,object_digest:D});
  if(format==='v11'){
   set(next.source,'storage_v11_append_transitions',{generation_id:gen,previous_generation_id:oldGen,participant_id:'owner',
    head_revision:2,is_append:kind==='unrelated_append'?1:0,compared_records:0});
   const parser=kind==='metadata_change'?'v2':'v1';
   set(next.source,'telemetry_v11_day_manifests',{id:'m1',participant_id:'owner',device_id:'device',
    chunk_day:'2026-09-30',manifest_digest:MANIFEST,parser_version:parser,
    manifest_json:JSON.stringify({consent:true,excluded:[],chunks:[{chunkId:'new-id',chunkDigest:A,recordCount:1}]}),expected_chunk_count:1,state:'ready'});
   set(next.source,'telemetry_v11_chunks',{id:'chunk1',manifest_id:'m1',participant_id:'owner',device_id:'device',stream:'usage',chunk_day:SELECTED_DAY,chunk_seq:0,chunk_id:'new-id',
    chunk_digest:A,record_count:1,parser_version:parser});
   change(next.source,'typed_v11_admission_state',{id:1},{next_source_row_id:2});
   set(next.source,'typed_v11_manifest_memberships',{manifest_id:'m1',typed_manifest_id:1});
   set(next.source,'typed_v11_chunk_allocations',{chunk_id:'chunk1',namespace_id:1,
    chunk_original:blob('chunk1'),first_source_row_id:1,record_count:1});
   set(next.source,'typed_telemetry_manifests',{id:1,namespace_id:1,owner_id:1,device_id:1,
    original_id:blob('m1'),chunk_day:SELECTED_DAY_NUMBER});
   set(next.source,'typed_telemetry_chunks',{id:1,namespace_id:1,format:11,owner_id:1,device_id:1,
    manifest_id:1,original_id:blob('chunk1'),stream:1,chunk_day:SELECTED_DAY_NUMBER});
   set(next.source,'typed_telemetry_records',{id:1,namespace_id:1,format:11,source_row_id:1,
    owner_id:1,device_id:1,chunk_id:1,manifest_id:1,stream:1,occurrence_id:blob('new'),
    observed_at_ms:SELECTED_AT,observed_day:SELECTED_DAY_NUMBER,provider_id:1,canonical_digest:digestBlob(B)});
   set(next.source,'typed_v11_record_proofs',{typed_record_id:1,chunk_key:1,manifest_key:1,stream_code:1,
    occurrence_blob:blob('new'),base_digest:digestBlob(A),legacy_occurrence_blob:null,legacy_digest:null,
    observed_at_ms:SELECTED_AT});
   set(next.source,'typed_telemetry_usage',{record_id:1,stream:1,session_id:1,model_id:1,speed_mode_id:1,
    api_service_tier_id:1,surface_id:1,billing_surface_id:1,reasoning_effort_id:1,agent_scope_id:1,
    outcome_id:1,attribution_id:null,total_input_context_tokens:100,input_uncached_tokens:100,
    input_cache_read_tokens:0,input_cache_write_tokens:0,output_text_tokens:1,output_reasoning_tokens:0,
    output_combined_tokens:1});
   change(next.source,'community_snapshot_mutation_control',{singleton_id:1},kind==='unrelated_append'
    ?{mutation_epoch:2,graph_append_epoch:2,graph_append_reason:'accepted-v11-append',
      graph_last_change_reason:'accepted-v11-append',graph_last_change_at:new Date(time+100).toISOString()}
    :{mutation_epoch:2,graph_invalidation_epoch:2,graph_last_change_reason:'authority-or-unrecognized-change',
      graph_last_change_at:new Date(time+100).toISOString(),graph_last_invalidated_at:new Date(time+100).toISOString()});
  }
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
function prove(input,options=OPTIONS){return assertAnalyticsMutationProofV2(input,options);}
function rejects(input,code,options=OPTIONS){assert.throws(()=>prove(input,options),new RegExp(`ANALYTICS_MUTATION_PROOF_${code}$`));}
const append=fixture('unrelated_append'),hard=fixture('metadata_change');
for(const [kind,input] of [['unrelated_append',append],['metadata_change',hard],['old_correction',fixture('old_correction')],['no_op',fixture('no_op')]]){
 const receipt=prove(input);assert.equal(receipt.schemaVersion,'analytics-mutation-proof-v2');
 assert.equal(receipt.comparisonContract,OPTIONS.contract);assert.equal(receipt.clockPolicy,OPTIONS.clockPolicy);
 assert.equal(receipt.verifiedNativeBranch,kind);assert.equal(receipt.verified.newEvents,kind==='no_op'?0:1);
 assert.equal(receipt.validatedClockPairs,kind==='old_correction'||kind==='no_op'?0:kind==='metadata_change'?4:2);
 assert.ok(receipt.rawSnapshotSha256.before.reference);assert.ok(receipt.rawSnapshotSha256.after.candidate);
}
assert.throws(()=>assertAnalyticsMutationProofV2(append),/ANALYTICS_MUTATION_PROOF_OPTIONS$/);
for(const options of [null,{}, {...OPTIONS,extra:true},{...OPTIONS,contract:'other'},
 {...OPTIONS,clockPolicy:'other'},true])rejects(append,'OPTIONS',options);
function negative(kind,mutate,code){const input=fixture(kind);mutate(input);rejects(input,code);}
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_v11_append_transitions',{generation_id:'g1'},{is_append:0});},'NATIVE_TRANSITION');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_v11_append_transitions',{generation_id:'g1'},{compared_records:1});},'NATIVE_COMPARED_RECORDS');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_v11_append_transitions',{generation_id:'g1'},{previous_generation_id:'other'});},'NATIVE_TRANSITION');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_v11_append_transitions',{generation_id:'g1'},{head_revision:3});},'NATIVE_TRANSITION');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])x.after[lane].source.tables.storage_v11_append_transitions.rows.pop();},'NATIVE_TRANSITION_COUNT');
negative('unrelated_append',x=>change(x.after.candidate.source,'storage_ingestion_changes',{sequence:2},{kind:'owner-active'}),'EVENT_LINEAGE');
negative('metadata_change',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_v11_append_transitions',{generation_id:'g1'},{is_append:1});},'NATIVE_TRANSITION');
negative('metadata_change',x=>change(x.after.candidate.source,'storage_ingestion_changes',{sequence:2},{kind:'source-updated'}),'EVENT_LINEAGE');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_invalidation_epoch:2}),'NATIVE_APPEND_CONTROL');
negative('metadata_change',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_invalidated_at:'1970-01-01T00:00:11.200Z'}),'NATIVE_HARD_CLOCK_PAIR');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_change_at:'1970-01-01T00:00:12.000Z'}),'NATIVE_CLOCK_INTERVAL');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_change_at:'1970-01-01T00:00:11Z'}),'NATIVE_CLOCK_INTERVAL');
negative('unrelated_append',x=>{for(const phase of ['before','after'])for(const lane of ['reference','candidate'])
 change(x[phase][lane].source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_invalidated_at:'1970-01-01T00:00:01.000Z'});
 change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_invalidated_at:'1970-01-01T00:00:11.100Z'});},'NATIVE_APPEND_CONTROL');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{mutation_epoch:3}),'NATIVE_MUTATION_EPOCH');
negative('unrelated_append',x=>{const table=x.after.candidate.source.tables.community_snapshot_mutation_control;
 table.columns.push({name:'unexpected',type:'TEXT'});for(const row of table.rows)row.cells.push(cell(null));},'COLUMN_SCHEMA');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_allowance_publication_state',{singleton:1},{publication_state:'ready'}),'PUBLICATION_STATE_CHANGED');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_allowance_publication_state',{singleton:1},{attribution_method_version:'different'}),'PUBLICATION_STATE_CHANGED');
negative('unrelated_append',x=>{const table=x.after.candidate.source.tables.community_allowance_publication_state;
 table.columns.pop();for(const row of table.rows)row.cells.pop();},'COLUMN_SCHEMA');
negative('unrelated_append',x=>{const table=x.after.candidate.source.tables.community_allowance_publication_state;
 table.columns.push({name:'unexpected',type:'TEXT'});for(const row of table.rows)row.cells.push(cell(null));},'COLUMN_SCHEMA');
negative('unrelated_append',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_append_reason:'other'}),'NATIVE_APPEND_CONTROL');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'telemetry_v11_day_manifests',{id:'m1'},{parser_version:'v2'});},'NATIVE_PARSER_BRANCH');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'telemetry_v11_day_manifests',{id:'m1'},{manifest_json:'{"consent":false,"excluded":[]}'});},'NATIVE_METADATA');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 x.after[lane].source.tables.typed_v11_record_proofs.rows.pop();},'NATIVE_TYPED_PROOF');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 x.after[lane].source.tables.typed_v11_chunk_allocations.rows.pop();},'NATIVE_TYPED_ALLOCATION');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 x.after[lane].source.tables.typed_v11_manifest_memberships.rows.pop();},'NATIVE_TYPED_MEMBERSHIP');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 x.after[lane].source.tables.typed_telemetry_usage.rows.pop();},'NATIVE_TYPED_USAGE');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_v11_chunk_allocations',{chunk_id:'chunk1'},{first_source_row_id:3});},'NATIVE_TYPED_NAMESPACE');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_v11_admission_state',{id:1},{next_source_row_id:3});},'NATIVE_TYPED_NAMESPACE');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_telemetry_records',{id:1},{source_row_id:3});},'NATIVE_TYPED_RECORD');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_telemetry_chunks',{id:1},{stream:2});},'NATIVE_TYPED_CHUNK');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_telemetry_records',{id:1},{observed_day:SELECTED_DAY_NUMBER+1});},'NATIVE_TYPED_RECORD');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_v11_manifest_memberships',{manifest_id:'m1'},{typed_manifest_id:2});},'NATIVE_TYPED_MEMBERSHIP');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_v11_owner_memberships',{participant_id:'owner'},{typed_owner_id:2});},'PRIOR_ROW_CHANGED');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_telemetry_manifests',{id:1},{namespace_id:2});},'NATIVE_TYPED_MANIFEST');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 change(x.after[lane].source,'typed_v11_record_proofs',{typed_record_id:1},{occurrence_blob:blob('other')});},'NATIVE_TYPED_PROOF');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 set(x.after[lane].source,'typed_telemetry_records',{id:2,namespace_id:1,format:11,source_row_id:2,
  owner_id:1,device_id:1,chunk_id:1,manifest_id:1,stream:1,occurrence_id:blob('extra'),
  observed_at_ms:SELECTED_AT,observed_day:SELECTED_DAY_NUMBER,provider_id:1,canonical_digest:digestBlob(B)});},'NATIVE_TYPED_RECORD');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])
 set(x.after[lane].source,'telemetry_v11_records',{chunk_id:'chunk1',manifest_id:'m1',stream:'usage',occurrence_id:'new'});},'NATIVE_LEGACY_ROW');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'typed_telemetry_records',{id:1},{format:10});},'NATIVE_TYPED_RECORD');
negative('unrelated_append',x=>{for(const lane of ['reference','candidate'])change(x.after[lane].source,'storage_ingestion_changes',{sequence:1},{recorded_ms:2_000});},'PRIOR_ROW_CHANGED');
negative('unrelated_append',x=>change(x.after.candidate.target,'analytics_applied_events',{source_id:'source',sequence:2},{recorded_ms:12_000}),'RECEIPT_COPY');
negative('unrelated_append',x=>x.after.candidate.target.stepPreimages=[],'STEP_COUNT');
negative('unrelated_append',x=>change(x.after.candidate.target,'analytics_v11_projection_steps',{source_id:'source',event_digest:B,revision:2},{step_digest:R}),'STEP_DIGEST');
negative('no_op',x=>change(x.after.reference.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_change_at:'1970-01-01T00:00:10.000Z'}),'NO_OP_CHANGED');
negative('old_correction',x=>change(x.after.candidate.source,'community_snapshot_mutation_control',{singleton_id:1},{graph_last_change_at:'1970-01-01T00:00:11.000Z'}),'COMMON_TABLE_DIVERGENCE');
negative('unrelated_append',x=>{x.action.intervals.reference={startMs:86_399_000,endMs:86_399_900};
 x.action.intervals.candidate={startMs:86_400_100,endMs:86_400_900};},'UTC_DAY_BOUNDARY');
negative('unrelated_append',x=>{for(const phase of ['before','after'])for(const lane of ['reference','candidate'])
 x[phase][lane].source.tables.accountless_v11_device_authorizations.rows[0].cells[2]=cell('1970-01-01T00:00:10.950Z');},'CUTOFF_BOUNDARY');
console.log('analytics mutation proof v2 synthetic checks passed');
