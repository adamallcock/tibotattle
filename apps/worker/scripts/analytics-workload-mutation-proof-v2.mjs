import {createHash} from 'node:crypto';
import {assertAnalyticsMutationProof as assertStrictMutationProof} from './analytics-workload-mutation-proof.mjs';

/** Local benchmark proof only. Input rows never leave the caller; failures expose static codes. */
export const MUTATION_PROOF_SCHEMA='analytics-mutation-proof-v2';
export const MUTATION_SNAPSHOT_SCHEMA='analytics-mutation-logical-snapshot-v1';
const EXTRA_SOURCE_TABLES=Object.freeze([
 'storage_effective_dependency_mutation_runtime','storage_effective_dependency_owner_mutations',
 'storage_effective_selective_runtime','storage_effective_selective_bootstrap',
 'storage_effective_selective_owners','storage_effective_selective_work',
 'storage_effective_selective_variants','storage_effective_selective_reverse_work',
 'storage_effective_selective_days','storage_effective_selective_ranges',
 'storage_effective_selective_effects',
]);
const TARGET_TABLES=Object.freeze([
 'analytics_applied_events','analytics_source_cursors','analytics_owner_state',
 'analytics_v11_projection_work','analytics_v11_projection_steps','analytics_v11_owner_heads',
 'analytics_v11_day_references','analytics_v11_value_pages','analytics_v11_reusable_values',
 'analytics_v11_discard_receipts','analytics_v11_retirement_receipts',
 'analytics_community_daily_queue',
]);
const REQUIRED_SOURCE=Object.freeze([
 'storage_source_state','storage_owner_revisions','storage_ingestion_changes',
 'storage_v11_owner_links','storage_v11_event_sources','storage_v12_event_sources',
 'telemetry_v11_domains','telemetry_v11_domain_days','telemetry_v11_domain_heads','telemetry_v11_domain_predecessors',
 'telemetry_v12_domains','telemetry_v12_domain_days','telemetry_v12_domain_heads','telemetry_v12_domain_predecessors',
 'community_analytical_input_versions','typed_telemetry_records','telemetry_v12_records',
 'telemetry_usage_correction_history','telemetry_usage_correction_facts',
 'accountless_v11_device_authorizations','accountless_v12_device_authorizations',
 'storage_v11_append_transitions','community_snapshot_mutation_control','community_allowance_publication_state',
]);
export const MUTATION_SOURCE_TABLES=REQUIRED_SOURCE;
export const MUTATION_TARGET_TABLES=TARGET_TABLES;
export const MUTATION_CANDIDATE_ONLY_TABLES=EXTRA_SOURCE_TABLES;
const REQUIRED_COLUMNS=Object.freeze({
 storage_ingestion_changes:['sequence','event_digest','owner_digest','revision','kind','object_digest','content_digest','authority_epoch','public_authority_epoch','recorded_ms'],
 storage_v11_event_sources:['event_digest','owner_digest','participant_id','device_id','generation_id','manifest_digest','from_day','through_day','head_revision','input_revision','recorded_ms'],
 storage_v12_event_sources:['event_digest','owner_digest','participant_id','device_id','generation_id','previous_generation_id','manifest_digest','head_revision','recorded_ms'],
 storage_v11_owner_links:['participant_id','owner_digest','state','generation_id','head_revision','object_digest','manifest_digest'],
 analytics_applied_events:['source_id','sequence','event_digest','owner_digest','revision','kind','object_digest','content_digest','authority_epoch','public_authority_epoch','recorded_ms'],
 analytics_source_cursors:['source_id','sequence','authority_epoch'],
 analytics_owner_state:['source_id','owner_digest','revision','authority_epoch','state'],
 analytics_v11_projection_steps:['source_id','event_digest','revision','step_digest'],
 storage_effective_dependency_mutation_runtime:['id','method','global_revision'],
 storage_effective_dependency_owner_mutations:['participant_id','revision'],
 storage_effective_selective_bootstrap:['id','owner_cursor','complete'],
 storage_effective_selective_days:['participant_id','source_day','stream','stamp'],
 storage_effective_selective_effects:['participant_id','source_day','through_day','stream','stamp'],
 storage_effective_selective_owners:['participant_id','needs_work','seeded','seed_day','broad_stamp','source_namespace','owner_digest'],
 storage_effective_selective_ranges:['participant_id','from_day','through_day','stamp'],
 storage_effective_selective_reverse_work:['participant_id','occurrence_id','stamp','day_cursor'],
 storage_effective_selective_runtime:['id','method','sequence','policy_stamp','acknowledged_policy_stamp'],
 storage_effective_selective_variants:['id','participant_id','family','source_row','occurrence_id','occurrence_key','stream','source_day','observed_at_ms','session_key','variant_digest'],
 storage_effective_selective_work:['id','participant_id','from_day','through_day','stamp','day_cursor','family','row_cursor'],
 storage_v11_append_transitions:['generation_id','previous_generation_id','participant_id','head_revision','is_append','compared_records'],
 community_snapshot_mutation_control:['singleton_id','mutation_epoch','graph_append_epoch','graph_invalidation_epoch',
  'graph_append_reason','graph_last_change_reason','graph_last_change_at','graph_last_invalidated_at'],
 community_allowance_publication_state:['singleton','publication_state','expected_basis','safe_from_day','safe_to_day','changed_at','attribution_method_version'],
});
export const MUTATION_REQUIRED_COLUMNS=REQUIRED_COLUMNS;
const TARGET_DIGEST_COLUMNS=Object.freeze({
 analytics_v11_projection_work:['event_digest'],analytics_v11_projection_steps:['event_digest'],
 analytics_v11_owner_heads:['event_digest'],analytics_v11_day_references:['event_digest'],
 analytics_v11_value_pages:['producer_event'],analytics_v11_discard_receipts:['event_digest'],
 analytics_v11_retirement_receipts:['event_digest'],
});
const HEX=/^[0-9a-f]{64}$/u, ISO_DAY=/^\d{4}-\d{2}-\d{2}$/u;
const fail=code=>{throw new Error(`ANALYTICS_MUTATION_PROOF_${code}`);};
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join('\0')===expected.slice().sort().join('\0');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest=value=>sha(canonical(value));
function compareKeys(a,b){for(let i=0;i<a.length;i++){const left=a[i],right=b[i];if(left[0]!==right[0])return left[0]<right[0]?-1:1;if(left[1]===right[1])continue;if(left[0]==='integer')return BigInt(left[1])<BigInt(right[1])?-1:1;if(left[0]==='real')return Number(left[1])<Number(right[1])?-1:1;return String(left[1])<String(right[1])?-1:1;}return 0;}
const same=(a,b)=>canonical(a)===canonical(b);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const textCell=value=>Array.isArray(value)&&value.length===2&&value[0]==='text'&&typeof value[1]==='string'?value[1]:fail('CELL_TYPE');
const intCell=value=>{if(!Array.isArray(value)||value.length!==2||value[0]!=='integer'||typeof value[1]!=='string'||!/^\d+$/u.test(value[1]))fail('CELL_TYPE');const n=Number(value[1]);if(!integer(n))fail('CELL_RANGE');return n;};
const signedIntCell=value=>{if(!Array.isArray(value)||value.length!==2||value[0]!=='integer'||typeof value[1]!=='string'||! /^-?(?:0|[1-9]\d*)$/u.test(value[1]))fail('CELL_TYPE');
 const n=Number(value[1]);if(!Number.isSafeInteger(n))fail('CELL_RANGE');return n;};
const optionalTextCell=value=>value[0]==='null'&&value[1]===null?null:textCell(value);
function validCell(cell){
 if(!Array.isArray(cell)||cell.length!==2)fail('CELL_SHAPE');
 const [type,value]=cell;
 if(type==='null'){if(value!==null)fail('CELL_TYPE');return;}
 if(type==='text'){if(typeof value!=='string')fail('CELL_TYPE');return;}
 if(type==='blob'){if(typeof value!=='string'||! /^(?:[0-9A-F]{2})*$/u.test(value))fail('CELL_TYPE');return;}
 if(type==='integer'){if(typeof value!=='string'||! /^-?(?:0|[1-9]\d*)$/u.test(value)||BigInt(value)<-(1n<<63n)||BigInt(value)>=(1n<<63n))fail('CELL_TYPE');return;}
 if(type==='real'){if(typeof value!=='string'||!Number.isFinite(Number(value)))fail('CELL_TYPE');return;}
 fail('CELL_TYPE');
}
function validateStore(store,side){
 if(!keys(store,side==='target'?['schemaSha256','tables','stepPreimages']:['schemaSha256','tables'])||!HEX.test(store.schemaSha256)||!store.tables||typeof store.tables!=='object'||Array.isArray(store.tables))fail('STORE_SHAPE');
 const names=Object.keys(store.tables);if(names.length>300||names.some(name=>! /^[a-z][a-z0-9_]*$/u.test(name)))fail('TABLE_NAME');
 for(const [name,table] of Object.entries(store.tables)){
  if(!keys(table,['columns','keyColumns','rows'])||!Array.isArray(table.columns)||!Array.isArray(table.keyColumns)||!Array.isArray(table.rows)
   ||table.columns.length<1||table.columns.length>128||table.rows.length>1_000_000)fail('TABLE_SHAPE');
  const columnNames=table.columns.map(value=>{if(!keys(value,['name','type'])||! /^[a-z][a-z0-9_]*$/u.test(value.name)||typeof value.type!=='string'||value.type.length>80)fail('COLUMN_SHAPE');return value.name;});
  if(new Set(columnNames).size!==columnNames.length||table.keyColumns.length<1||table.keyColumns.length>8
   ||table.keyColumns.some(value=>value!=='rowid'&&!columnNames.includes(value))
   ||(table.keyColumns.includes('rowid')&&table.keyColumns.length!==1))fail('KEY_SHAPE');
  if(REQUIRED_COLUMNS[name]&&!same(columnNames,REQUIRED_COLUMNS[name]))fail('COLUMN_SCHEMA');
  let prior=null;for(const row of table.rows){
   if(!keys(row,['key','cells'])||!Array.isArray(row.key)||!Array.isArray(row.cells)
    ||row.key.length!==table.keyColumns.length||row.cells.length!==columnNames.length)fail('ROW_SHAPE');
   for(const value of [...row.key,...row.cells])validCell(value);
   for(let i=0;i<table.keyColumns.length;i++)if(table.keyColumns[i]!=='rowid'
    &&!same(row.key[i],row.cells[columnNames.indexOf(table.keyColumns[i])]))fail('KEY_VALUE');
   if(prior&&compareKeys(row.key,prior)<=0)fail('ROW_ORDER');prior=row.key;
  }
 }
 const required=side==='source'?REQUIRED_SOURCE:TARGET_TABLES;
 if(required.some(name=>!Object.hasOwn(store.tables,name)))fail('TABLE_MISSING');
 if(side==='target'&&!same(names.sort(),[...TARGET_TABLES].sort()))fail('TARGET_CATALOG');
}
function value(table,row,column){const at=table.columns.findIndex(item=>item.name===column);if(at<0)fail('COLUMN_MISSING');return row.cells[at];}
function str(table,row,column){return textCell(value(table,row,column));}
function num(table,row,column){return intCell(value(table,row,column));}
function rowMap(table){return new Map(table.rows.map(row=>[canonical(row.key),row]));}
function priorRowsIntact(before,after,tableName){
 const a=before.tables[tableName],b=after.tables[tableName],next=rowMap(b),old=rowMap(a);
 if(!same(a.columns,b.columns)||!same(a.keyColumns,b.keyColumns))fail('SCHEMA_DRIFT');
 for(const old of a.rows)if(!same(old,next.get(canonical(old.key))))fail('PRIOR_ROW_CHANGED');
 return b.rows.filter(row=>!old.has(canonical(row.key)));
}
function eventRows(before,after,name){
 const added=priorRowsIntact(before,after,name);if(after.tables[name].rows.length!==before.tables[name].rows.length+added.length)fail('SOURCE_DELETE');return added;
}
function compareCommonStores(left,right,except){
 const names=Object.keys(left.tables).sort();if(!same(names,Object.keys(right.tables).sort()))fail('COMMON_CATALOG');
 for(const name of names)if(!except.has(name)&&!same(left.tables[name],right.tables[name]))fail('COMMON_TABLE_DIVERGENCE');
}
function rowWith(table,row,overrides){return table.columns.map((column,index)=>Object.hasOwn(overrides,column.name)?overrides[column.name]:row.cells[index]);}
function expiryBoundary(snapshot,interval){
 // Cutoff evidence uses actual milliseconds; only receipt times are rounded.
 const start=interval.startMs,end=interval.endMs;
 for(const table of Object.values(snapshot.source.tables))for(const column of table.columns){
  if(!['expires_at','consume_lease_expires_at','valid_until_ms'].includes(column.name))continue;
  const at=table.columns.findIndex(item=>item.name===column.name);
  for(const row of table.rows){const cell=row.cells[at];if(cell[0]==='null')continue;
   const time=cell[0]==='integer'?Number(cell[1]):cell[0]==='text'?Date.parse(cell[1]):NaN;
   if(Number.isFinite(time)&&time>=start&&time<=end)fail('CUTOFF_BOUNDARY');
  }
 }
}
function validInterval(value){if(!keys(value,['startMs','endMs'])||!integer(value.startMs)||!integer(value.endMs)||value.endMs<value.startMs||value.endMs-value.startMs>300_000)fail('INTERVAL');}
function validateSnapshot(snapshot){
 if(!keys(snapshot,['schemaVersion','source','target','affectedDays'])||snapshot.schemaVersion!==MUTATION_SNAPSHOT_SCHEMA
  ||!Array.isArray(snapshot.affectedDays)||new Set(snapshot.affectedDays).size!==snapshot.affectedDays.length
  ||snapshot.affectedDays.some(day=>typeof day!=='string'||!ISO_DAY.test(day)||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)
  ||!same(snapshot.affectedDays,[...snapshot.affectedDays].sort()))fail('SNAPSHOT');
 validateStore(snapshot.source,'source');
 if(!keys(snapshot.target,['schemaSha256','tables','stepPreimages']))fail('TARGET_SHAPE');
 validateStore(snapshot.target,'target');
 if(!Array.isArray(snapshot.target.stepPreimages)||snapshot.target.stepPreimages.length>100_000)fail('STEP_PROOFS');
}
const NATIVE_TYPES=Object.freeze({
 storage_v11_append_transitions:['TEXT','TEXT','TEXT','INTEGER','INTEGER','INTEGER'],
 community_snapshot_mutation_control:['INTEGER','INTEGER','INTEGER','INTEGER','TEXT','TEXT','TEXT','TEXT'],
 community_allowance_publication_state:['INTEGER','TEXT','TEXT','TEXT','TEXT','TEXT','TEXT'],
});
function nativeTable(snapshot,name,keyColumn){
 const table=snapshot.source.tables[name],names=REQUIRED_COLUMNS[name],types=NATIVE_TYPES[name];
 if(!table||!same(table.columns,names.map((column,index)=>({name:column,type:types[index]})))
  ||!same(table.keyColumns,[keyColumn]))fail('NATIVE_SCHEMA');
 return table;
}
function nativeSingleton(snapshot,name,keyColumn){
 const table=nativeTable(snapshot,name,keyColumn);
 if(table.rows.length!==1||signedIntCell(value(table,table.rows[0],keyColumn))!==1)fail('NATIVE_SINGLETON');
 return {table,row:table.rows[0]};
}
function rawSnapshotHashes(input){return Object.fromEntries(['before','after'].map(phase=>[phase,
  Object.fromEntries(['reference','candidate'].map(lane=>[lane,digest(input[phase][lane])]))]));}
const CLOCK=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function nativeClock(cell,prior,interval){
 const value=textCell(cell),time=Date.parse(value);
 if(!CLOCK.test(value)||!Number.isFinite(time)||new Date(time).toISOString()!==value
  ||time<interval.startMs||time>interval.endMs)fail('NATIVE_CLOCK_INTERVAL');
 const previous=optionalTextCell(prior);
 if(previous!==null){const old=Date.parse(previous);
  if(!CLOCK.test(previous)||!Number.isFinite(old)||new Date(old).toISOString()!==previous||time<old)fail('NATIVE_CLOCK_ORDER');}
 return time;
}
function nativeControlProof(input,kind){
 const pairs=[];let validated=0,different=0,maxSkewMs=0;
 for(const lane of ['reference','candidate']){
  const before=nativeSingleton(input.before[lane],'community_snapshot_mutation_control','singleton_id');
  const after=nativeSingleton(input.after[lane],'community_snapshot_mutation_control','singleton_id');
  const publicationBefore=nativeSingleton(input.before[lane],'community_allowance_publication_state','singleton');
  const publicationAfter=nativeSingleton(input.after[lane],'community_allowance_publication_state','singleton');
  if(!same(publicationBefore.table,publicationAfter.table))fail('PUBLICATION_STATE_CHANGED');
  const b=column=>value(before.table,before.row,column),a=column=>value(after.table,after.row,column);
  const mutation=signedIntCell(b('mutation_epoch'));
  if(signedIntCell(a('mutation_epoch'))!==mutation+1)fail('NATIVE_MUTATION_EPOCH');
  if(kind==='unrelated_append'){
   if(signedIntCell(a('graph_append_epoch'))!==mutation+1
    ||optionalTextCell(a('graph_append_reason'))!=='accepted-v11-append'
    ||optionalTextCell(a('graph_last_change_reason'))!=='accepted-v11-append'
    ||!same(a('graph_invalidation_epoch'),b('graph_invalidation_epoch'))
    ||!same(a('graph_last_invalidated_at'),b('graph_last_invalidated_at')))fail('NATIVE_APPEND_CONTROL');
  }else{
   if(!same(a('graph_append_epoch'),b('graph_append_epoch'))
    ||!same(a('graph_append_reason'),b('graph_append_reason'))
    ||signedIntCell(a('graph_invalidation_epoch'))!==mutation+1
    ||optionalTextCell(a('graph_last_change_reason'))!=='authority-or-unrecognized-change')fail('NATIVE_HARD_CONTROL');
  }
  const interval=input.action.intervals[lane],change=nativeClock(a('graph_last_change_at'),b('graph_last_change_at'),interval);
  let invalidated=null;
  if(kind==='metadata_change'){
   invalidated=nativeClock(a('graph_last_invalidated_at'),b('graph_last_invalidated_at'),interval);
   if(change!==invalidated)fail('NATIVE_HARD_CLOCK_PAIR');
  }
  for(const name of REQUIRED_COLUMNS.community_snapshot_mutation_control){
   if(name==='graph_last_change_at'||kind==='metadata_change'&&name==='graph_last_invalidated_at')continue;
   if(name==='mutation_epoch'||name==='graph_append_epoch'||name==='graph_invalidation_epoch'
    ||name==='graph_append_reason'||name==='graph_last_change_reason')continue;
   if(!same(a(name),b(name)))fail('NATIVE_CONTROL_CHANGED');
  }
  pairs.push({change,invalidated});validated+=kind==='metadata_change'?2:1;
 }
 for(const name of ['community_allowance_publication_state']){
  if(!same(input.after.reference.source.tables[name],input.after.candidate.source.tables[name]))fail('PUBLICATION_STATE_DIVERGENCE');
 }
 for(const name of REQUIRED_COLUMNS.community_snapshot_mutation_control){
  if(name==='graph_last_change_at'||kind==='metadata_change'&&name==='graph_last_invalidated_at')continue;
  const ref=nativeSingleton(input.after.reference,'community_snapshot_mutation_control','singleton_id');
  const cand=nativeSingleton(input.after.candidate,'community_snapshot_mutation_control','singleton_id');
  if(!same(value(ref.table,ref.row,name),value(cand.table,cand.row,name)))fail('NATIVE_CONTROL_DIVERGENCE');
 }
 for(const field of ['change',...(kind==='metadata_change'?['invalidated']:[])]){
  const left=pairs[0][field],right=pairs[1][field];if(left!==right)different++;
  maxSkewMs=Math.max(maxSkewMs,Math.abs(left-right));
 }
 return {validatedClockPairs:validated,differentClockPairs:different,maxInterLaneClockSkewMs:maxSkewMs};
}
function nativeTransitionProof(input,kind,events){
 for(const lane of ['reference','candidate']){
  const before=nativeTable(input.before[lane],'storage_v11_append_transitions','generation_id');
  const after=nativeTable(input.after[lane],'storage_v11_append_transitions','generation_id');
  const added=priorRowsIntact({tables:{storage_v11_append_transitions:before}},
   {tables:{storage_v11_append_transitions:after}},'storage_v11_append_transitions');
  if(kind==='old_correction'||kind==='no_op'){
   if(added.length!==0)fail('NATIVE_TRANSITION_COUNT');continue;
  }
  if(added.length!==1)fail('NATIVE_TRANSITION_COUNT');
  const row=added[0],event=events[lane],oldLink=input.before[lane].source.tables.storage_v11_owner_links;
  const prior=oldLink.rows.filter(item=>str(oldLink,item,'participant_id')===event.participantId);
  if(prior.length!==1||str(after,row,'generation_id')!==event.generationId
   ||str(after,row,'previous_generation_id')!==str(oldLink,prior[0],'generation_id')
   ||str(after,row,'participant_id')!==event.participantId
   ||num(after,row,'head_revision')!==num(event.table,event.row,'head_revision')
   ||num(after,row,'is_append')!==(kind==='unrelated_append'?1:0)
   )fail('NATIVE_TRANSITION');
 }
}
// Byte-for-byte local copy of the reviewed typed-telemetry identifier tags.
// This benchmark proof imports no Worker private module or mutable runtime.
const TYPED_ID_FORMS=[
 ['',16,true],['participant:',16,true],['device:',16,true],['v1:',16,true],['contribution:',16,true],
 ['',32,false],['event:v2:',32,false],['quota-occurrence:v1:',32,false],
 ['account-track:v2:',32,false],['plan-era:v1:',32,false],['chunk:',16,true],
];
function typedIdBlob(value){
 if(typeof value!=='string'||! /^[A-Za-z0-9._:-]{1,256}$/u.test(value))fail('NATIVE_TYPED_ID');
 for(let index=0;index<TYPED_ID_FORMS.length;index++){
  const [prefix,length,uuid]=TYPED_ID_FORMS[index];if(!value.startsWith(prefix))continue;
  const body=value.slice(prefix.length);
  if(!(uuid?/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u:/^[0-9a-f]{64}$/u).test(body))continue;
  return ['blob',(index+1).toString(16).padStart(2,'0').toUpperCase()+body.replaceAll('-','').toUpperCase()];
 }
 return ['blob','00'+Buffer.from(value,'utf8').toString('hex').toUpperCase()];
}
function one(table,rows,code){if(rows.length!==1)fail(code);return rows[0];}
function nativeV11ActionProof(input,kind,events){
 for(const lane of ['reference','candidate']){
  const before=input.before[lane].source,after=input.after[lane].source,event=events[lane];
  for(const name of ['telemetry_v11_day_manifests','telemetry_v11_chunks','telemetry_v11_records','typed_telemetry_records']){
   if(!before.tables[name]||!after.tables[name])fail('NATIVE_INPUT_TABLE');
   priorRowsIntact(before,after,name);
  }
  const domains=after.tables.telemetry_v11_domains,domain=domains.rows.find(row=>str(domains,row,'id')===event.generationId);
  if(!domain)fail('NATIVE_DOMAIN');
  const priorGeneration=textCell(value(domains,domain,'previous_generation_id'));
  const days=after.tables.telemetry_v11_domain_days;
  const old=new Map(days.rows.filter(row=>str(days,row,'generation_id')===priorGeneration)
   .map(row=>[str(days,row,'observed_day'),str(days,row,'manifest_id')]));
  const next=new Map(days.rows.filter(row=>str(days,row,'generation_id')===event.generationId)
   .map(row=>[str(days,row,'observed_day'),str(days,row,'manifest_id')]));
  if(old.size!==next.size||[...old].filter(([day,id])=>next.get(day)!==id).length!==1
   ||[...old.keys()].some(day=>!next.has(day)))fail('NATIVE_DAY_VECTOR');
  const changed=[...old.keys()].find(day=>next.get(day)!==old.get(day));
  if(!same(input.after[lane].affectedDays,[changed]))fail('NATIVE_AFFECTED_DAY');
  const manifests=after.tables.telemetry_v11_day_manifests;
  const prior=manifests.rows.find(row=>str(manifests,row,'id')===old.get(changed));
  const current=manifests.rows.find(row=>str(manifests,row,'id')===next.get(changed));
  if(!prior||!current||str(manifests,prior,'state')!=='ready'||str(manifests,current,'state')!=='ready'
   ||str(manifests,prior,'participant_id')!==event.participantId
   ||str(manifests,current,'participant_id')!==event.participantId
   ||str(manifests,prior,'device_id')!==str(manifests,current,'device_id')
   ||str(manifests,prior,'chunk_day')!==changed||str(manifests,current,'chunk_day')!==changed)fail('NATIVE_MANIFEST');
  let oldJson,newJson;
  try {oldJson=JSON.parse(str(manifests,prior,'manifest_json'));
   newJson=JSON.parse(str(manifests,current,'manifest_json'));}
  catch {fail('NATIVE_MANIFEST_JSON');}
  if(!same(oldJson?.consent,newJson?.consent)||!same(oldJson?.excluded,newJson?.excluded))fail('NATIVE_METADATA');
  const oldParser=str(manifests,prior,'parser_version'),newParser=str(manifests,current,'parser_version');
  if((kind==='unrelated_append'&&oldParser!==newParser)
   ||(kind==='metadata_change'&&oldParser===newParser))fail('NATIVE_PARSER_BRANCH');
  const chunks=after.tables.telemetry_v11_chunks;
  for(const column of ['manifest_id','stream','chunk_id','chunk_digest','record_count','parser_version'])
   if(!chunks.columns.some(item=>item.name===column))fail('NATIVE_CHUNK_SCHEMA');
  const oldChunks=chunks.rows.filter(row=>str(chunks,row,'manifest_id')===old.get(changed));
  const newChunks=chunks.rows.filter(row=>str(chunks,row,'manifest_id')===next.get(changed));
  if(oldChunks.length!==0||newChunks.length!==1||num(manifests,prior,'expected_chunk_count')!==0
   ||num(manifests,current,'expected_chunk_count')!==1)fail('NATIVE_CHUNK_COUNT');
  const header=newChunks[0];
  if(str(chunks,header,'stream')!=='usage'||num(chunks,header,'record_count')!==1
   ||str(chunks,header,'participant_id')!==event.participantId
   ||str(chunks,header,'device_id')!==str(manifests,current,'device_id')
   ||str(chunks,header,'chunk_day')!==changed
   ||str(chunks,header,'parser_version')!==newParser)fail('NATIVE_CHUNK_HEADER');
  if(!Array.isArray(oldJson?.chunks)||oldJson.chunks.length!==0||!Array.isArray(newJson?.chunks)
   ||newJson.chunks.length!==1||!same(newJson.chunks[0],{chunkId:str(chunks,header,'chunk_id'),
    chunkDigest:str(chunks,header,'chunk_digest'),recordCount:1}))fail('NATIVE_MANIFEST_CHUNKS');
  const comparable=['chunk_id','stream','chunk_digest','record_count','parser_version'];
  const unmatched=oldChunks.filter(row=>!newChunks.some(nextRow=>comparable.every(column=>
   same(value(chunks,row,column),value(chunks,nextRow,column)))));
  if(unmatched.length>201)fail('NATIVE_COMPARISON_CAPACITY');
  const compared=Math.min(201,unmatched.reduce((sum,row)=>sum+num(chunks,row,'record_count'),0));
  const transitions=after.tables.storage_v11_append_transitions;
  const transition=transitions.rows.find(row=>str(transitions,row,'generation_id')===event.generationId);
  if(!transition||num(transitions,transition,'compared_records')!==compared)fail('NATIVE_COMPARED_RECORDS');
  const legacy=after.tables.telemetry_v11_records;
  if(legacy.rows.some(row=>[old.get(changed),next.get(changed)].includes(str(legacy,row,'manifest_id')))
   ||eventRows(before,after,'telemetry_v11_records').length)fail('NATIVE_LEGACY_ROW');
  const physical=['typed_v11_admission_state','typed_v11_owner_memberships','typed_v11_chunk_allocations',
   'typed_v11_manifest_memberships','typed_v11_record_proofs','typed_telemetry_namespaces',
   'typed_telemetry_owners','typed_telemetry_devices','typed_telemetry_manifests',
   'typed_telemetry_chunks','typed_telemetry_records','typed_telemetry_usage'];
  if(physical.some(name=>!before.tables[name]||!after.tables[name]))fail('NATIVE_PHYSICAL_TABLE');
  for(const name of physical.filter(name=>!['typed_v11_admission_state','typed_telemetry_records'].includes(name)))
   priorRowsIntact(before,after,name);
  for(const name of ['typed_v11_owner_memberships','typed_telemetry_namespaces','typed_telemetry_owners','typed_telemetry_devices'])
   if(!same(before.tables[name],after.tables[name]))fail('NATIVE_OWNER_PHYSICAL_CHANGED');
  const added=(name,code)=>one(after.tables[name],eventRows(before,after,name),code);
  const recordTable=after.tables.typed_telemetry_records,
   record=added('typed_telemetry_records','NATIVE_TYPED_RECORD');
  const usageTable=after.tables.typed_telemetry_usage,
   usage=added('typed_telemetry_usage','NATIVE_TYPED_USAGE');
  const proofTable=after.tables.typed_v11_record_proofs,
   proof=added('typed_v11_record_proofs','NATIVE_TYPED_PROOF');
  const allocationTable=after.tables.typed_v11_chunk_allocations,
   allocation=added('typed_v11_chunk_allocations','NATIVE_TYPED_ALLOCATION');
  const membershipTable=after.tables.typed_v11_manifest_memberships,
   membership=added('typed_v11_manifest_memberships','NATIVE_TYPED_MEMBERSHIP');
  const typedChunkTable=after.tables.typed_telemetry_chunks,
   typedChunk=added('typed_telemetry_chunks','NATIVE_TYPED_CHUNK');
  const typedManifestTable=after.tables.typed_telemetry_manifests,
   typedManifest=added('typed_telemetry_manifests','NATIVE_TYPED_MANIFEST');
  const oldManifestId=str(manifests,prior,'id'),manifestId=str(manifests,current,'id');
  if(membershipTable.rows.some(row=>str(membershipTable,row,'manifest_id')===oldManifestId)
   ||str(membershipTable,membership,'manifest_id')!==manifestId
   ||num(membershipTable,membership,'typed_manifest_id')!==num(typedManifestTable,typedManifest,'id'))
   fail('NATIVE_TYPED_MEMBERSHIP');
  const stateBefore=one(before.tables.typed_v11_admission_state,
   before.tables.typed_v11_admission_state.rows,'NATIVE_TYPED_NAMESPACE');
  const stateAfter=one(after.tables.typed_v11_admission_state,
   after.tables.typed_v11_admission_state.rows,'NATIVE_TYPED_NAMESPACE');
  const namespaceId=num(after.tables.typed_v11_admission_state,stateAfter,'namespace_id');
  const first=num(allocationTable,allocation,'first_source_row_id');
  if(num(after.tables.typed_v11_admission_state,stateAfter,'id')!==1
   ||num(before.tables.typed_v11_admission_state,stateBefore,'id')!==1
   ||str(after.tables.typed_v11_admission_state,stateAfter,'source_namespace')!==
      str(before.tables.typed_v11_admission_state,stateBefore,'source_namespace')
   ||num(before.tables.typed_v11_admission_state,stateBefore,'namespace_id')!==namespaceId
   ||num(before.tables.typed_v11_admission_state,stateBefore,'next_source_row_id')!==first
   ||num(after.tables.typed_v11_admission_state,stateAfter,'next_source_row_id')!==first+1)
   fail('NATIVE_TYPED_NAMESPACE');
  const namespaceTable=after.tables.typed_telemetry_namespaces;
  const namespace=one(namespaceTable,namespaceTable.rows.filter(row=>num(namespaceTable,row,'id')===namespaceId),'NATIVE_TYPED_NAMESPACE');
  if(!same(value(namespaceTable,namespace,'original_id'),typedIdBlob(str(after.tables.typed_v11_admission_state,stateAfter,'source_namespace'))))
   fail('NATIVE_TYPED_NAMESPACE');
  const ownerMembershipTable=after.tables.typed_v11_owner_memberships;
  const ownerMembership=one(ownerMembershipTable,ownerMembershipTable.rows.filter(row=>
   str(ownerMembershipTable,row,'participant_id')===event.participantId),'NATIVE_TYPED_OWNER');
  const ownerId=num(ownerMembershipTable,ownerMembership,'typed_owner_id');
  const ownerTable=after.tables.typed_telemetry_owners;
  const owner=one(ownerTable,ownerTable.rows.filter(row=>num(ownerTable,row,'id')===ownerId),'NATIVE_TYPED_OWNER');
  if(num(ownerTable,owner,'namespace_id')!==namespaceId
   ||!same(value(ownerTable,owner,'original_id'),typedIdBlob(event.participantId)))fail('NATIVE_TYPED_OWNER');
  const deviceTable=after.tables.typed_telemetry_devices;
  const device=one(deviceTable,deviceTable.rows.filter(row=>
   same(value(deviceTable,row,'original_id'),typedIdBlob(str(manifests,current,'device_id')))
   &&num(deviceTable,row,'namespace_id')===namespaceId&&num(deviceTable,row,'owner_id')===ownerId),'NATIVE_TYPED_DEVICE');
  const deviceId=num(deviceTable,device,'id'),typedManifestId=num(typedManifestTable,typedManifest,'id'),
   typedChunkId=num(typedChunkTable,typedChunk,'id'),typedRecordId=num(recordTable,record,'id'),
   dayNumber=Date.parse(changed+'T00:00:00.000Z')/86_400_000;
  if(!Number.isSafeInteger(dayNumber))fail('NATIVE_TYPED_DAY');
  if(num(typedManifestTable,typedManifest,'namespace_id')!==namespaceId
   ||num(typedManifestTable,typedManifest,'owner_id')!==ownerId
   ||num(typedManifestTable,typedManifest,'device_id')!==deviceId
   ||num(typedManifestTable,typedManifest,'chunk_day')!==dayNumber
   ||!same(value(typedManifestTable,typedManifest,'original_id'),typedIdBlob(manifestId)))
   fail('NATIVE_TYPED_MANIFEST');
  if(str(allocationTable,allocation,'chunk_id')!==str(chunks,header,'id')
   ||num(allocationTable,allocation,'namespace_id')!==namespaceId
   ||num(allocationTable,allocation,'record_count')!==1
   ||!same(value(allocationTable,allocation,'chunk_original'),typedIdBlob(str(chunks,header,'id'))))
   fail('NATIVE_TYPED_ALLOCATION');
  if(num(typedChunkTable,typedChunk,'namespace_id')!==namespaceId
   ||num(typedChunkTable,typedChunk,'format')!==11
   ||num(typedChunkTable,typedChunk,'owner_id')!==ownerId
   ||num(typedChunkTable,typedChunk,'device_id')!==deviceId
   ||num(typedChunkTable,typedChunk,'manifest_id')!==typedManifestId
   ||num(typedChunkTable,typedChunk,'stream')!==1
   ||num(typedChunkTable,typedChunk,'chunk_day')!==dayNumber
   ||!same(value(typedChunkTable,typedChunk,'original_id'),value(allocationTable,allocation,'chunk_original')))
   fail('NATIVE_TYPED_CHUNK');
  if(num(recordTable,record,'namespace_id')!==namespaceId||num(recordTable,record,'format')!==11
   ||num(recordTable,record,'source_row_id')!==first||num(recordTable,record,'owner_id')!==ownerId
   ||num(recordTable,record,'device_id')!==deviceId||num(recordTable,record,'chunk_id')!==typedChunkId
   ||num(recordTable,record,'manifest_id')!==typedManifestId||num(recordTable,record,'stream')!==1
   ||num(recordTable,record,'observed_day')!==dayNumber
   ||!Number.isFinite(num(recordTable,record,'observed_at_ms'))
   ||new Date(num(recordTable,record,'observed_at_ms')).toISOString().slice(0,10)!==changed)
   fail('NATIVE_TYPED_RECORD');
  if(num(proofTable,proof,'typed_record_id')!==typedRecordId
   ||num(proofTable,proof,'chunk_key')!==typedChunkId
   ||num(proofTable,proof,'manifest_key')!==typedManifestId
   ||num(proofTable,proof,'stream_code')!==1
   ||num(proofTable,proof,'observed_at_ms')!==num(recordTable,record,'observed_at_ms')
   ||!same(value(proofTable,proof,'occurrence_blob'),value(recordTable,record,'occurrence_id')))
   fail('NATIVE_TYPED_PROOF');
  if(num(usageTable,usage,'record_id')!==typedRecordId||num(usageTable,usage,'stream')!==1)
   fail('NATIVE_TYPED_USAGE');
 }
}
function afterEvent(snapshot,kind,before){
 const name=kind==='old_correction'?'storage_v12_event_sources':'storage_v11_event_sources';
 const event=eventRows(before.source,snapshot.source,name);if(event.length!==1)fail('EVENT_COUNT');
 const table=snapshot.source.tables[name],row=event[0];
 const journal=eventRows(before.source,snapshot.source,'storage_ingestion_changes');if(journal.length!==1)fail('JOURNAL_COUNT');
 const jt=snapshot.source.tables.storage_ingestion_changes,jr=journal[0];
 const eventDigest=str(table,row,'event_digest'),recorded=num(table,row,'recorded_ms');
 if(!HEX.test(eventDigest)||recorded%1000!==0||str(jt,jr,'event_digest')!==eventDigest||str(jt,jr,'object_digest')!==eventDigest
  ||str(jt,jr,'owner_digest')!==str(table,row,'owner_digest')||str(jt,jr,'content_digest')!==str(table,row,'manifest_digest')
  ||num(jt,jr,'recorded_ms')!==recorded||str(jt,jr,'kind')!==(kind==='unrelated_append'?'source-updated':'owner-active'))fail('EVENT_LINEAGE');
 const priorOwner=before.source.tables.storage_owner_revisions;
 const owner=priorOwner.rows.filter(item=>str(priorOwner,item,'owner_digest')===str(table,row,'owner_digest'));
 const currentOwner=snapshot.source.tables.storage_owner_revisions;
 const current=currentOwner.rows.filter(item=>str(currentOwner,item,'owner_digest')===str(table,row,'owner_digest'));
 const priorState=before.source.tables.storage_source_state,currentState=snapshot.source.tables.storage_source_state;
 if(owner.length!==1||current.length!==1||priorState.rows.length!==1||currentState.rows.length!==1
  ||str(priorOwner,owner[0],'state')!=='active'||str(currentOwner,current[0],'state')!=='active'
  ||num(jt,jr,'revision')!==num(priorOwner,owner[0],'revision')+1
  ||num(currentOwner,current[0],'revision')!==num(jt,jr,'revision')
  ||num(jt,jr,'authority_epoch')!==num(priorOwner,owner[0],'authority_epoch')+(kind==='unrelated_append'?0:1)
  ||num(currentOwner,current[0],'authority_epoch')!==num(jt,jr,'authority_epoch')
  ||num(jt,jr,'public_authority_epoch')!==num(priorState,priorState.rows[0],'authority_epoch')+(kind==='unrelated_append'?0:1)
  ||num(currentState,currentState.rows[0],'authority_epoch')!==num(jt,jr,'public_authority_epoch'))fail('AUTHORITY_LINEAGE');
 return {table,row,jt,jr,eventDigest,recorded,generationId:str(table,row,'generation_id'),
  ownerDigest:str(table,row,'owner_digest'),participantId:str(table,row,'participant_id'),sequence:num(jt,jr,'sequence')};
}
function domainProof(snapshot,event,kind,nowEpoch){
 const format=kind==='old_correction'?'v12':'v11';const store=snapshot.source.tables;
 const domain=store[`telemetry_${format}_domains`],rows=domain.rows.filter(row=>str(domain,row,'id')===event.generationId);
 if(rows.length!==1||str(domain,rows[0],'participant_id')!==event.participantId
  ||str(domain,rows[0],'manifest_digest')!==str(event.table,event.row,'manifest_digest')
  ||str(domain,rows[0],'created_at')!==new Date(nowEpoch).toISOString())fail('DOMAIN_TIME');
 const head=store[`telemetry_${format}_domain_heads`];const heads=head.rows.filter(row=>str(head,row,'participant_id')===event.participantId);
 if(heads.length!==1||str(head,heads[0],'generation_id')!==event.generationId
  ||str(head,heads[0],'updated_at')!==new Date(nowEpoch).toISOString())fail('HEAD_TIME');
 const predecessor=store[`telemetry_${format}_domain_predecessors`],token=str(domain,rows[0],'predecessor_token_hash');
 const matched=predecessor.rows.filter(row=>str(predecessor,row,'token_hash')===token);
 if(matched.length!==1||str(predecessor,matched[0],'consumed_at')!==new Date(nowEpoch).toISOString())fail('PREDECESSOR_TIME');
 const dayTable=store[`telemetry_${format}_domain_days`];
 const days=dayTable.rows.filter(row=>str(dayTable,row,'generation_id')===event.generationId)
  .map(row=>[str(dayTable,row,'observed_day'),str(dayTable,row,format==='v11'?'manifest_id':'manifest_digest')]);
 const previous=value(domain,rows[0],'previous_generation_id');
 const priorId=previous[0]==='null'?null:textCell(previous);
 const prior=priorId===null?[]:dayTable.rows.filter(row=>str(dayTable,row,'generation_id')===priorId)
  .map(row=>[str(dayTable,row,'observed_day'),str(dayTable,row,format==='v11'?'manifest_id':'manifest_digest')]);
 const next=new Map(days),old=new Map(prior);
 return [...new Set([...next.keys(),...old.keys()])].filter(day=>next.get(day)!==old.get(day)).sort();
}
function normalizeLinks(snapshot,event){
 const table=snapshot.source.tables.storage_v11_owner_links;
 return table.rows.map(row=>rowWith(table,row,{object_digest:str(table,row,'owner_digest')===event.ownerDigest
  &&str(table,row,'object_digest')===event.eventDigest?['text','<new-event>']:value(table,row,'object_digest')}));
}
function targetLineage(before,after,event){
 const a=after.target.tables.analytics_applied_events,b=before.target.tables.analytics_applied_events;
 const newRows=eventRows({tables:{analytics_applied_events:b}},{tables:{analytics_applied_events:a}},'analytics_applied_events');
 if(newRows.length!==1)fail('RECEIPT_COUNT');
 const receipt=newRows[0];
 const sourceState=after.source.tables.storage_source_state;
 if(sourceState.rows.length!==1||str(sourceState,sourceState.rows[0],'source_id')!==str(a,receipt,'source_id'))fail('SOURCE_ID');
 for(const name of REQUIRED_COLUMNS.analytics_applied_events) {
  if(name==='source_id')continue;
  if(!same(value(a,receipt,name),value(event.jt,event.jr,name)))fail('RECEIPT_COPY');
 }
 if(num(a,receipt,'sequence')!==event.sequence)fail('RECEIPT_SEQUENCE');
 const cursors=after.target.tables.analytics_source_cursors,scope=str(a,receipt,'source_id');
 const entries=cursors.rows.filter(row=>str(cursors,row,'source_id')===scope);
 if(entries.length!==1||num(cursors,entries[0],'sequence')!==event.sequence
  ||num(cursors,entries[0],'authority_epoch')!==num(event.jt,event.jr,'public_authority_epoch'))fail('CURSOR');
 const all=a.rows.filter(row=>str(a,row,'source_id')===scope).map(row=>num(a,row,'sequence')).sort((x,y)=>x-y);
 if(all.length!==event.sequence||all.some((sequence,index)=>sequence!==index+1))fail('CURSOR_GAP');
 const owners=after.target.tables.analytics_owner_state;
 const owner=owners.rows.filter(row=>str(owners,row,'source_id')===scope&&str(owners,row,'owner_digest')===event.ownerDigest);
 if(owner.length!==1||num(owners,owner[0],'revision')!==num(event.jt,event.jr,'revision')
  ||num(owners,owner[0],'authority_epoch')!==num(event.jt,event.jr,'authority_epoch')
  ||str(owners,owner[0],'state')!=='active')fail('OWNER_RECEIPT');
 return {sourceId:scope,receipt};
}
function verifySteps(snapshot,event,kind){
 const steps=snapshot.target.tables.analytics_v11_projection_steps;
 const matching=steps.rows.filter(row=>str(steps,row,'event_digest')===event.eventDigest);
 const proofs=snapshot.target.stepPreimages;
 if(kind==='old_correction') {if(matching.length||proofs.length)fail('UNEXPECTED_STEP');return 0;}
 if(matching.length<1||matching.length!==proofs.length)fail('STEP_COUNT');
 const works=snapshot.target.tables.analytics_v11_projection_work;
 const work=works.rows.filter(row=>str(works,row,'source_id')===str(snapshot.source.tables.storage_source_state,
  snapshot.source.tables.storage_source_state.rows[0],'source_id')&&str(works,row,'event_digest')===event.eventDigest);
 if(work.length!==1||str(works,work[0],'owner_digest')!==event.ownerDigest
  ||str(works,work[0],'generation_id')!==event.generationId
  ||str(works,work[0],'manifest_digest')!==str(event.table,event.row,'manifest_digest')
  ||str(works,work[0],'from_day')!==str(event.table,event.row,'from_day')
  ||str(works,work[0],'through_day')!==str(event.table,event.row,'through_day')
  ||str(works,work[0],'next_day')<=str(works,work[0],'through_day')
  ||num(works,work[0],'revision')!==proofs.length
  ||str(works,work[0],'phase')!=='ready')fail('WORK_CLOSURE');
 const heads=snapshot.target.tables.analytics_v11_owner_heads;
 const head=heads.rows.filter(row=>str(heads,row,'source_id')===str(works,work[0],'source_id')
  &&str(heads,row,'owner_digest')===event.ownerDigest);
 if(head.length!==1||str(heads,head[0],'event_digest')!==event.eventDigest
  ||num(heads,head[0],'sequence')!==event.sequence)fail('HEAD_CLOSURE');
 const byRevision=new Map();for(const item of proofs){
  if(!keys(item,['eventDigest','revision','preimage'])||item.eventDigest!==event.eventDigest||!integer(item.revision)||item.revision<1
   ||byRevision.has(item.revision))fail('STEP_PROOF_SHAPE');
  const body=item.preimage,fields=['eventDigest','revision','day','afterStream','afterOccurrence','recordCount','completeDay','valueKey','pageDigest','values'];
  if(!keys(body,fields)||body.eventDigest!==event.eventDigest||body.revision!==item.revision
   ||typeof body.day!=='string'||!ISO_DAY.test(body.day)||typeof body.afterStream!=='string'||typeof body.afterOccurrence!=='string'
   ||!integer(body.recordCount)||typeof body.completeDay!=='boolean'||typeof body.valueKey!=='string'
   ||(body.pageDigest!==null&&(!HEX.test(body.pageDigest)))||!body.values||typeof body.values!=='object')fail('STEP_PROOF_SHAPE');
  byRevision.set(item.revision,{body,sha:sha(canonical(body))});
 }
 for(const row of matching){const revision=num(steps,row,'revision'),proof=byRevision.get(revision);
  if(!proof||str(steps,row,'step_digest')!==proof.sha)fail('STEP_DIGEST');}
 if([...byRevision.keys()].sort((a,b)=>a-b).some((revision,index)=>revision!==index+1))fail('STEP_SEQUENCE');
 const first=str(event.table,event.row,'from_day'),last=str(event.table,event.row,'through_day');
 const expected=[];let cursor=new Date(`${first}T00:00:00Z`).getTime(),end=new Date(`${last}T00:00:00Z`).getTime();
 if(!ISO_DAY.test(first)||!ISO_DAY.test(last)||!Number.isFinite(cursor)||!Number.isFinite(end)||cursor>end)fail('DAY_RANGE');
 for(;cursor<=end&&expected.length<=400;cursor+=86_400_000)expected.push(new Date(cursor).toISOString().slice(0,10));
 if(expected.length>400||!same(expected.at(-1),last))fail('DAY_RANGE');
 const completed=[...byRevision.values()].filter(item=>item.body.completeDay)
  .map(item=>[item.body.day,item.body.valueKey]);
 const refs=snapshot.target.tables.analytics_v11_day_references;
 const linked=refs.rows.filter(row=>str(refs,row,'event_digest')===event.eventDigest)
  .map(row=>[str(refs,row,'day'),str(refs,row,'value_key')]);
 if(!same(completed.map(item=>item[0]).sort(),expected)
  ||!same(linked.sort((a,b)=>a[0].localeCompare(b[0])),completed.sort((a,b)=>a[0].localeCompare(b[0]))))fail('DAY_CLOSURE');
 return proofs.length;
}
function normalizedTarget(snapshot,event,kind){
 const result={};for(const [name,table] of Object.entries(snapshot.target.tables)){
  if(name==='analytics_applied_events'){
   result[name]=table.rows.map(row=>table.columns.map((col,index)=>{
    if(str(table,row,'event_digest')!==event.eventDigest)return row.cells[index];
    if(['event_digest','object_digest'].includes(col.name))return ['text','<new-event>'];
    if(col.name==='recorded_ms')return ['integer','<new-time>'];
    return row.cells[index];
   })).sort((a,b)=>canonical(a).localeCompare(canonical(b)));continue;
  }
  if(name==='analytics_v11_projection_steps'){
   const preimages=new Map(snapshot.target.stepPreimages.map(item=>[item.revision,item.preimage]));
   result[name]=table.rows.map(row=>{
    const cells=[...row.cells];if(str(table,row,'event_digest')===event.eventDigest){
     cells[table.columns.findIndex(item=>item.name==='event_digest')]=['text','<new-event>'];
     const proof=preimages.get(num(table,row,'revision'));if(!proof)fail('STEP_PROOF_MISSING');
     cells[table.columns.findIndex(item=>item.name==='step_digest')]=['text',sha(canonical({...proof,eventDigest:'<new-event>'}))];
    }return cells;
   }).sort((a,b)=>canonical(a).localeCompare(canonical(b)));continue;
  }
  const fields=TARGET_DIGEST_COLUMNS[name]??[];
  result[name]=table.rows.map(row=>table.columns.map((col,index)=>fields.includes(col.name)
   &&same(row.cells[index],['text',event.eventDigest])?['text','<new-event>']:row.cells[index]))
   .sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 }
 return result;
}
function compareEventRows(left,right,kind){
 const lt=left.table,rt=right.table;
 const lo={event_digest:['text','<new-event>'],recorded_ms:['integer','<new-time>']};
 if(!same(rowWith(lt,left.row,lo),rowWith(rt,right.row,lo)))fail('EVENT_ROW_DIVERGENCE');
 const jo={event_digest:['text','<new-event>'],object_digest:['text','<new-event>'],recorded_ms:['integer','<new-time>']};
 if(!same(rowWith(left.jt,left.jr,jo),rowWith(right.jt,right.jr,jo)))fail('JOURNAL_DIVERGENCE');
 if(left.sequence!==right.sequence||left.ownerDigest!==right.ownerDigest||left.generationId!==right.generationId)fail('EVENT_IDENTITY');
}
export function assertAnalyticsMutationProofV2(input,options){
 if(!keys(options,['contract','clockPolicy'])||options.contract!=='native-existing-owner-v2'
  ||options.clockPolicy!=='native-v11-trigger-clocks-v1')fail('OPTIONS');
 if(!keys(input,['before','after','action'])||!keys(input.before,['reference','candidate'])
  ||!keys(input.after,['reference','candidate'])||!keys(input.action,['kind','nowEpoch','intervals'])
  ||!['unrelated_append','metadata_change','old_correction','no_op'].includes(input.action.kind)
  ||!integer(input.action.nowEpoch)||!keys(input.action.intervals,['reference','candidate']))fail('INPUT');
 for(const lane of ['reference','candidate']){
  validateSnapshot(input.before[lane]);validateSnapshot(input.after[lane]);validInterval(input.action.intervals[lane]);
  if(input.before[lane].source.schemaSha256!==input.after[lane].source.schemaSha256
   ||input.before[lane].target.schemaSha256!==input.after[lane].target.schemaSha256)fail('SCHEMA_DRIFT');
  for(const side of ['source','target'])for(const [name,table] of Object.entries(input.before[lane][side].tables)) {
   const next=input.after[lane][side].tables[name];if(!next||!same(table.columns,next.columns)||!same(table.keyColumns,next.keyColumns))fail('SCHEMA_DRIFT');
  }
  if(!same(Object.keys(input.before[lane].source.tables).sort(),Object.keys(input.after[lane].source.tables).sort()))fail('SCHEMA_DRIFT');
  for(const snapshot of [input.before[lane],input.after[lane]]){
   nativeTable(snapshot,'storage_v11_append_transitions','generation_id');
   nativeSingleton(snapshot,'community_snapshot_mutation_control','singleton_id');
   nativeSingleton(snapshot,'community_allowance_publication_state','singleton');
  }
  if(!same(input.before[lane].source.tables.community_allowance_publication_state,
   input.after[lane].source.tables.community_allowance_publication_state))fail('PUBLICATION_STATE_CHANGED');
 }
 // Sequential lane calls can cross a deadline in the gap between their
 // individual intervals. Preserve one eligibility epoch across both calls.
 const intervalSpan={startMs:Math.min(input.action.intervals.reference.startMs,input.action.intervals.candidate.startMs),
  endMs:Math.max(input.action.intervals.reference.endMs,input.action.intervals.candidate.endMs)};
 if(new Date(intervalSpan.startMs).toISOString().slice(0,10)!==
  new Date(intervalSpan.endMs).toISOString().slice(0,10))fail('UTC_DAY_BOUNDARY');
 for(const lane of ['reference','candidate']){
  expiryBoundary(input.before[lane],intervalSpan);
  expiryBoundary(input.after[lane],intervalSpan);
 }
 const beforeRef=input.before.reference,beforeCand=input.before.candidate;
 const refTables=Object.keys(beforeRef.source.tables).sort(),candTables=Object.keys(beforeCand.source.tables).sort();
 const extra=candTables.filter(name=>!refTables.includes(name));
 if(!same(extra,[...EXTRA_SOURCE_TABLES].sort())||refTables.some(name=>!candTables.includes(name)))fail('SOURCE_CATALOG');
 const commonSource=new Set(refTables),excluded=new Set(['storage_ingestion_changes','storage_v11_event_sources','storage_v12_event_sources','storage_v11_owner_links']);
 const common=(snapshot)=>({tables:Object.fromEntries([...commonSource].map(name=>[name,snapshot.source.tables[name]]))});
 compareCommonStores(common(beforeRef),common(beforeCand),new Set());
 if(input.action.kind==='no_op'||input.action.kind==='old_correction'){
  nativeTransitionProof(input,input.action.kind,{});
  const strict=assertStrictMutationProof(input);
  return Object.freeze({...strict,schemaVersion:MUTATION_PROOF_SCHEMA,
   comparisonContract:options.contract,clockPolicy:options.clockPolicy,
   verifiedNativeBranch:input.action.kind,permittedClockPairs:0,validatedClockPairs:0,differentClockPairs:0,
   maxInterLaneClockSkewMs:0,rawSnapshotSha256:rawSnapshotHashes(input)});
 }
 const afterRef=input.after.reference,afterCand=input.after.candidate;
 for(const name of TARGET_TABLES){
  const left=beforeRef.target.tables[name],right=beforeCand.target.tables[name];
  if(!same(left.columns,right.columns)||!same(left.keyColumns,right.keyColumns))fail('TARGET_SCHEMA_DIVERGENCE');
 }
 excluded.add('community_snapshot_mutation_control');
 compareCommonStores(common(afterRef),common(afterCand),excluded);
 for(const name of ['storage_ingestion_changes','storage_v11_event_sources','storage_v12_event_sources'])for(const lane of ['reference','candidate'])priorRowsIntact(input.before[lane].source,input.after[lane].source,name);
 const selected='storage_v11_event_sources';
 const other=selected==='storage_v11_event_sources'?'storage_v12_event_sources':'storage_v11_event_sources';
 for(const lane of ['reference','candidate'])if(eventRows(input.before[lane].source,input.after[lane].source,other).length)fail('UNEXPECTED_EVENT');
 const events={reference:afterEvent(afterRef,input.action.kind,beforeRef),candidate:afterEvent(afterCand,input.action.kind,beforeCand)};
 nativeTransitionProof(input,input.action.kind,events);
 nativeV11ActionProof(input,input.action.kind,events);
 const clockProof=nativeControlProof(input,input.action.kind);
 compareEventRows(events.reference,events.candidate,input.action.kind);
 for(const lane of ['reference','candidate']){
  const event=events[lane],time=Math.floor(input.action.intervals[lane].startMs/1000)*1000,
   until=Math.floor(input.action.intervals[lane].endMs/1000)*1000;
  if(event.recorded<time||event.recorded>until)fail('EVENT_TIME_INTERVAL');
  for(const name of ['storage_ingestion_changes','storage_v11_event_sources','storage_v12_event_sources']){
   const table=input.before[lane].source.tables[name];if(table.rows.some(row=>str(table,row,'event_digest')===event.eventDigest))fail('REUSED_EVENT_DIGEST');
  }
  const expectedDays=domainProof(input.after[lane],event,input.action.kind,input.action.nowEpoch);
  if(!same(expectedDays,input.after[lane].affectedDays))fail('AFFECTED_DAYS');
  targetLineage(input.before[lane],input.after[lane],event);
 }
 if(!same(afterRef.affectedDays,afterCand.affectedDays))fail('AFFECTED_DAY_DIVERGENCE');
 if(!same(normalizeLinks(afterRef,events.reference),normalizeLinks(afterCand,events.candidate)))fail('OWNER_LINK_DIVERGENCE');
 for(const lane of ['reference','candidate']){
  const before=input.before[lane].source.tables.storage_v11_owner_links,after=input.after[lane].source.tables.storage_v11_owner_links;
  if(before.rows.length!==after.rows.length)fail('OWNER_LINK_COUNT');
  for(const row of before.rows){const next=rowMap(after).get(canonical(row.key));if(!next)fail('OWNER_LINK_REMOVED');
   const event=events[lane],owns=str(before,row,'owner_digest')===event.ownerDigest;
   const format=true;
   const oldGeneration=value(before,row,'generation_id');
   const v12LinkUpdate=owns&&!format&&oldGeneration[0]==='null';
   const v11LinkUpdate=owns&&format;
   if(v11LinkUpdate){
    if(str(after,next,'generation_id')!==event.generationId
     ||num(after,next,'head_revision')!==num(event.table,event.row,'head_revision')
     ||str(after,next,'object_digest')!==event.eventDigest
     ||str(after,next,'manifest_digest')!==str(event.table,event.row,'manifest_digest'))fail('OWNER_LINK_LINEAGE');
   }else if(v12LinkUpdate&&(str(after,next,'object_digest')!==event.eventDigest
     ||str(after,next,'manifest_digest')!==str(event.table,event.row,'manifest_digest')))fail('OWNER_LINK_LINEAGE');
   const allowed=v11LinkUpdate?['generation_id','head_revision','object_digest','manifest_digest']
    :v12LinkUpdate?['object_digest','manifest_digest']:[];
   const overrides=Object.fromEntries(allowed.map(name=>[name,value(before,row,name)]));
   if(!same(rowWith(before,row,{}),rowWith(after,next,overrides)))fail('OWNER_LINK_CHANGED');
  }
 }
 const counts={reference:verifySteps(afterRef,events.reference,input.action.kind),candidate:verifySteps(afterCand,events.candidate,input.action.kind)};
 if(counts.reference!==counts.candidate)fail('STEP_COUNT_DIVERGENCE');
 if(!same(normalizedTarget(afterRef,events.reference,input.action.kind),normalizedTarget(afterCand,events.candidate,input.action.kind)))fail('TARGET_LINEAGE_DIVERGENCE');
 return Object.freeze({schemaVersion:MUTATION_PROOF_SCHEMA,kind:input.action.kind,
  comparisonContract:options.contract,clockPolicy:options.clockPolicy,verifiedNativeBranch:input.action.kind,
  permittedClockPairs:input.action.kind==='metadata_change'?4:2,
  ...clockProof,rawSnapshotSha256:rawSnapshotHashes(input),
  verified:{newEvents:1,receipts:1,steps:counts.reference,affectedDays:afterRef.affectedDays.length},
  sourceSha256:digest({event:rowWith(events.reference.table,events.reference.row,{event_digest:['text','<new-event>'],recorded_ms:['integer','<new-time>']}),
   journal:rowWith(events.reference.jt,events.reference.jr,{event_digest:['text','<new-event>'],object_digest:['text','<new-event>'],recorded_ms:['integer','<new-time>']}),days:afterRef.affectedDays}),
  targetLineageSha256:digest(normalizedTarget(afterRef,events.reference,input.action.kind))});
}
