import assert from 'node:assert/strict';
import test from 'node:test';
import {runStorageShardReadinessOperator,storageShardCapacityEvidence,
 validateStorageShardReadinessConfiguration} from './storage-shard-readiness-operator.mjs';

const now=2_000;
const capacityObservation=storageShardCapacityEvidence({
 databaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',observedBytes:1_000,
 observedAt:1_900,validUntil:2_100});
const plan={schema:'storage-shard-readiness-operator-v1',
 qualificationId:'11111111-1111-4111-8111-111111111111',shardId:'spare-a',
 catalogDatabaseId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 bindingName:'STORAGE_INGESTION_A',ingestionDatabaseId:capacityObservation.databaseId,
 sourceId:'source-a',sourceNamespace:'namespace-a',analyticsTargetId:'analytics-a',
 analyticsBindingName:'STORAGE_ANALYTICS_A',
 analyticsDatabaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',erasureTargetId:'analytics-a',
 deletionLedgerBindingName:'DELETION_LEDGER',
 deletionLedgerDatabaseId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 publicationBindingName:'STORAGE_PUBLICATION_DB',publicationDatabaseId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',allocationTier:'spare',
 capacityObservation,qualifiedAt:1_950,expiresAt:2_500,
 expectedSchemaDigests:{catalog:'0'.repeat(64),ingestion:'1'.repeat(64),analytics:'2'.repeat(64),
  deletionLedger:'3'.repeat(64),publication:'4'.repeat(64)}};
const resources=[
 {role:'catalog',bindingName:'STORAGE_ROUTING_DB',databaseId:plan.catalogDatabaseId},
 {role:'ingestion',bindingName:plan.bindingName,databaseId:plan.ingestionDatabaseId},
 {role:'analytics',bindingName:plan.analyticsBindingName,databaseId:plan.analyticsDatabaseId},
 {role:'deletionLedger',bindingName:plan.deletionLedgerBindingName,databaseId:plan.deletionLedgerDatabaseId},
 {role:'publication',bindingName:plan.publicationBindingName,databaseId:plan.publicationDatabaseId},
];
const configuration={d1_databases:resources.map(row=>({binding:row.bindingName,database_id:row.databaseId}))};
function fixture(){
 const calls=[];let policy=null;
 const candidate={qualificationId:plan.qualificationId,shardId:plan.shardId,
  catalogDatabaseId:plan.catalogDatabaseId,catalogBindingName:'STORAGE_ROUTING_DB',catalogSchemaDigest:'0'.repeat(64),bindingName:plan.bindingName,
  ingestionDatabaseId:plan.ingestionDatabaseId,sourceId:plan.sourceId,sourceNamespace:plan.sourceNamespace,
  ingestionSchemaDigest:'1'.repeat(64),analyticsTargetId:plan.analyticsTargetId,
  analyticsBindingName:plan.analyticsBindingName,analyticsDatabaseId:plan.analyticsDatabaseId,
  analyticsSchemaDigest:'2'.repeat(64),erasureTargetId:plan.erasureTargetId,
  deletionLedgerBindingName:plan.deletionLedgerBindingName,deletionLedgerDatabaseId:plan.deletionLedgerDatabaseId,
  deletionSchemaDigest:'3'.repeat(64),publicationBindingName:plan.publicationBindingName,
  publicationDatabaseId:plan.publicationDatabaseId,publicationSchemaDigest:'4'.repeat(64),
  readinessDigest:'f'.repeat(64),qualifiedAt:plan.qualifiedAt,state:'active',revokedAt:null,contractVersion:1};
 const api={
  async describeResources(){calls.push('describe');return structuredClone(resources);},
  async measureIngestionSize(){calls.push('measure');return structuredClone(capacityObservation);},
  async qualify(){calls.push('qualify');return candidate;},
  async record(){calls.push('record');return candidate;},
  async observe(){calls.push('observe');},
  async configure(value){calls.push('configure');policy={allocationTier:value.allocationTier,
   allocationEnabled:value.allocationEnabled,qualificationDigest:value.qualificationDigest,updatedAt:value.updatedAt};},
  async readPolicy(){calls.push('readPolicy');return policy;},
 };
 return {api,calls};
}

test('activates only after exact tuple, receipt and independent size evidence',async()=>{
 const {api,calls}=fixture();const result=await runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now});
 assert.deepEqual(calls,['describe','measure','qualify','record','observe','configure','readPolicy']);
 assert.equal(result.readinessDigest,'f'.repeat(64));
 assert.equal(result.qualifiedAt,plan.qualifiedAt);
});

test('refuses stale or changed physical evidence before catalog mutation',async()=>{
 const {api,calls}=fixture();api.measureIngestionSize=async()=>({...capacityObservation,observedBytes:1_001});
 await assert.rejects(runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now}),/CAPACITY_EVIDENCE_CHANGED/);
 assert.deepEqual(calls,['describe']);
 await assert.rejects(runStorageShardReadinessOperator({plan:{...plan,expiresAt:1_999},api,configuration,clock:()=>now}),/WINDOW_CLOSED/);
});

test('accepts equivalent capacity evidence independent of property insertion order',async()=>{
 const {api}=fixture();api.measureIngestionSize=async()=>({evidenceDigest:capacityObservation.evidenceDigest,
  validUntil:capacityObservation.validUntil,observedAt:capacityObservation.observedAt,
  observedBytes:capacityObservation.observedBytes,databaseId:capacityObservation.databaseId});
 await assert.doesNotReject(runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now}));
});

test('an unknown activation acknowledgement reuses the retained receipt across an advancing clock',async()=>{
 const {api,calls}=fixture();let retained=null,policy=null,lost=true;
 api.record=async candidate=>{calls.push('record');retained??=structuredClone(candidate);return structuredClone(retained);};
 api.configure=async value=>{calls.push('configure');policy=structuredClone(value);if(lost){lost=false;throw Error('lost acknowledgement');}};
 api.readPolicy=async()=>{calls.push('readPolicy');return {allocationTier:policy.allocationTier,
  allocationEnabled:policy.allocationEnabled,qualificationDigest:policy.qualificationDigest,updatedAt:policy.updatedAt};};
 await assert.rejects(runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now}),/lost acknowledgement/);
 assert.equal(retained.qualifiedAt,plan.qualifiedAt);assert.equal(policy.updatedAt,plan.qualifiedAt);
 await assert.doesNotReject(runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now+100}));
 assert.equal(retained.qualifiedAt,plan.qualifiedAt);assert.equal(policy.updatedAt,plan.qualifiedAt);
});

test('configuration and provider readback bind every role to one exact physical database',async()=>{
 assert.deepEqual(validateStorageShardReadinessConfiguration(configuration,plan),resources);
 for(const changed of [
  {d1_databases:configuration.d1_databases.map((row,index)=>index===1?{...row,database_id:plan.analyticsDatabaseId}:row)},
  {d1_databases:configuration.d1_databases.map((row,index)=>index===1?{...row,binding:'STORAGE_ANALYTICS_A'}:row)},
 ])assert.throws(()=>validateStorageShardReadinessConfiguration(changed,plan),/CONFIG_INVALID/);
 const {api,calls}=fixture();api.describeResources=async()=>resources.map((row,index)=>index===1
  ?{...row,databaseId:plan.analyticsDatabaseId}:row);
 await assert.rejects(runStorageShardReadinessOperator({plan,api,configuration,clock:()=>now}),/RESOURCE_IDENTITY_CHANGED/);
 assert.deepEqual(calls,[]);
});

test('refuses broader, contradictory and incomplete plans',async()=>{
 const {api}=fixture();
 await assert.rejects(runStorageShardReadinessOperator({plan:{...plan,unexpected:true},api,configuration,clock:()=>now}),/PLAN_INVALID/);
 await assert.rejects(runStorageShardReadinessOperator({plan:{...plan,
  publicationDatabaseId:plan.analyticsDatabaseId},api,configuration,clock:()=>now}),/PLAN_INVALID/);
 await assert.rejects(runStorageShardReadinessOperator({plan:{...plan,capacityObservation:{...capacityObservation,
  evidenceDigest:'0'.repeat(64)}},api,configuration,clock:()=>now}),/CAPACITY_EVIDENCE_INVALID/);
 const full=storageShardCapacityEvidence({databaseId:capacityObservation.databaseId,
  observedBytes:6_000_000_000,observedAt:capacityObservation.observedAt,
  validUntil:capacityObservation.validUntil});
 await assert.rejects(runStorageShardReadinessOperator({plan:{...plan,capacityObservation:full},api,
  configuration,clock:()=>now}),/PLAN_INVALID/);
});

test('refuses changed qualification or record receipts before capacity activation',async()=>{
 const changedQualification=fixture();
 const qualify=changedQualification.api.qualify;
 changedQualification.api.qualify=async value=>({...await qualify(value),qualifiedAt:now-1});
 await assert.rejects(runStorageShardReadinessOperator({plan,api:changedQualification.api,configuration,clock:()=>now}),
  /QUALIFICATION_CHANGED/);
 assert.deepEqual(changedQualification.calls,['describe','measure','qualify']);

 const changedRecord=fixture();
 const record=changedRecord.api.record;
 changedRecord.api.record=async value=>({...await record(value),publicationSchemaDigest:'9'.repeat(64)});
 await assert.rejects(runStorageShardReadinessOperator({plan,api:changedRecord.api,configuration,clock:()=>now}),
  /RECEIPT_CHANGED/);
 assert.deepEqual(changedRecord.calls,['describe','measure','qualify','record']);
});
