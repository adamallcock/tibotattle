import {createHash} from 'node:crypto';

const SHA=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const BINDING=/^[A-Z][A-Z0-9_]{0,63}$/u;
const fail=code=>{throw new Error(`STORAGE_SHARD_READINESS_${code}`);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const KEYS=['schema','qualificationId','shardId','catalogDatabaseId','bindingName','ingestionDatabaseId','sourceId',
 'sourceNamespace','analyticsTargetId','analyticsBindingName','analyticsDatabaseId','erasureTargetId',
 'deletionLedgerBindingName','deletionLedgerDatabaseId','publicationBindingName','publicationDatabaseId',
 'allocationTier','capacityObservation','qualifiedAt','expiresAt','expectedSchemaDigests'];
const RECEIPT_KEYS=['qualificationId','shardId','catalogDatabaseId','catalogBindingName','catalogSchemaDigest','bindingName',
 'ingestionDatabaseId','sourceId','sourceNamespace','ingestionSchemaDigest','analyticsTargetId',
 'analyticsBindingName','analyticsDatabaseId','analyticsSchemaDigest','erasureTargetId',
 'deletionLedgerBindingName','deletionLedgerDatabaseId','deletionSchemaDigest','publicationBindingName',
 'publicationDatabaseId','publicationSchemaDigest','readinessDigest','qualifiedAt','state','revokedAt',
 'contractVersion'];
const SCHEMA_KEYS=['catalog','ingestion','analytics','deletionLedger','publication'];
const RESOURCE_ROLES=['catalog','ingestion','analytics','deletionLedger','publication'];

function expectedResources(plan){return [
 {role:'catalog',bindingName:'STORAGE_ROUTING_DB',databaseId:plan.catalogDatabaseId},
 {role:'ingestion',bindingName:plan.bindingName,databaseId:plan.ingestionDatabaseId},
 {role:'analytics',bindingName:plan.analyticsBindingName,databaseId:plan.analyticsDatabaseId},
 {role:'deletionLedger',bindingName:plan.deletionLedgerBindingName,databaseId:plan.deletionLedgerDatabaseId},
 {role:'publication',bindingName:plan.publicationBindingName,databaseId:plan.publicationDatabaseId},
];}
function validateResources(value,plan,code){
 if(!Array.isArray(value)||value.length!==5||value.some((row,index)=>!exact(row,['role','bindingName','databaseId'])
  ||row.role!==RESOURCE_ROLES[index]||row.bindingName!==expectedResources(plan)[index].bindingName
  ||row.databaseId!==expectedResources(plan)[index].databaseId))fail(code);
 return value;
}
export function validateStorageShardReadinessConfiguration(configuration,plan){
 plan=validateStorageShardReadinessOperatorPlan(plan);
 const rows=configuration?.d1_databases;
 if(!Array.isArray(rows)||rows.length<5||rows.length>32||rows.some(row=>!row||typeof row!=='object'
  ||!BINDING.test(row.binding)||!UUID.test(row.database_id)))fail('CONFIG_INVALID');
 if(new Set(rows.map(row=>row.binding)).size!==rows.length||new Set(rows.map(row=>row.database_id)).size!==rows.length)
  fail('CONFIG_INVALID');
 const resources=expectedResources(plan);
 for(const expected of resources){const matches=rows.filter(row=>row.binding===expected.bindingName);
  if(matches.length!==1||matches[0].database_id!==expected.databaseId)fail('CONFIG_INVALID');}
 return Object.freeze(resources.map(Object.freeze));
}

export function validateStorageShardReadinessOperatorPlan(value){
 if(!exact(value,KEYS)||value.schema!=='storage-shard-readiness-operator-v1'
  ||!UUID.test(value.qualificationId)||!ID.test(value.shardId)||!BINDING.test(value.bindingName)
  ||![value.catalogDatabaseId,value.ingestionDatabaseId,value.analyticsDatabaseId,value.deletionLedgerDatabaseId,
   value.publicationDatabaseId].every(id=>UUID.test(id))
  ||new Set([value.catalogDatabaseId,value.ingestionDatabaseId,value.analyticsDatabaseId,
   value.deletionLedgerDatabaseId,value.publicationDatabaseId]).size!==5||!ID.test(value.sourceId)
  ||typeof value.sourceNamespace!=='string'||value.sourceNamespace.length<1||value.sourceNamespace.length>256
  ||!ID.test(value.analyticsTargetId)||!BINDING.test(value.analyticsBindingName)
  ||!ID.test(value.erasureTargetId)||!BINDING.test(value.deletionLedgerBindingName)
  ||!BINDING.test(value.publicationBindingName)
  ||!/^STORAGE_INGESTION_[ABC]$/u.test(value.bindingName)
  ||value.analyticsBindingName!==value.bindingName.replace('INGESTION','ANALYTICS')
  ||value.analyticsTargetId!==`analytics-${value.bindingName.at(-1).toLowerCase()}`
  ||value.erasureTargetId!==value.analyticsTargetId
  ||value.deletionLedgerBindingName!=='DELETION_LEDGER'
  ||value.publicationBindingName!=='STORAGE_PUBLICATION_DB'
  ||!['active','spare'].includes(value.allocationTier)||!Number.isSafeInteger(value.qualifiedAt)
  ||!Number.isSafeInteger(value.expiresAt)||value.qualifiedAt<0||value.qualifiedAt>value.expiresAt
  ||!exact(value.expectedSchemaDigests,SCHEMA_KEYS)
  ||SCHEMA_KEYS.some(key=>!SHA.test(value.expectedSchemaDigests[key]))
  ||!exact(value.capacityObservation,['databaseId','observedBytes','observedAt','validUntil','evidenceDigest'])
  ||value.capacityObservation.databaseId!==value.ingestionDatabaseId
  ||!Number.isSafeInteger(value.capacityObservation.observedBytes)||value.capacityObservation.observedBytes<0
  ||value.capacityObservation.observedBytes>=6_000_000_000
  ||!Number.isSafeInteger(value.capacityObservation.observedAt)||value.capacityObservation.observedAt<0
  ||!Number.isSafeInteger(value.capacityObservation.validUntil)
  ||value.capacityObservation.validUntil<value.capacityObservation.observedAt
  ||value.qualifiedAt<value.capacityObservation.observedAt||value.expiresAt<value.capacityObservation.observedAt
  ||!SHA.test(value.capacityObservation.evidenceDigest))fail('PLAN_INVALID');
 const expected=digest(['storage-shard-capacity-evidence-v1',value.ingestionDatabaseId,
  value.capacityObservation.observedBytes,value.capacityObservation.observedAt,
  value.capacityObservation.validUntil]);
 if(expected!==value.capacityObservation.evidenceDigest)fail('CAPACITY_EVIDENCE_INVALID');
 return structuredClone(value);
}

/** Explicit root-only composition. The injected API is the reviewed Worker
 * runtime facade over exact D1 bindings; this module is never an HTTP or Cron
 * entrypoint. A caller retries only by invoking the same pinned plan again. */
export async function runStorageShardReadinessOperator({plan,api,configuration,clock=Date.now}){
 plan=validateStorageShardReadinessOperatorPlan(plan);
 const now=clock();
 if(!Number.isSafeInteger(now)||now>plan.expiresAt||plan.capacityObservation.observedAt>now
  ||plan.qualifiedAt>now||plan.capacityObservation.validUntil<now)fail('WINDOW_CLOSED');
 const configured=validateStorageShardReadinessConfiguration(configuration,plan);
 if(!api||!['describeResources','measureIngestionSize','qualify','record','observe','configure','readPolicy']
  .every(name=>typeof api[name]==='function'))fail('API_INVALID');
 validateResources(await api.describeResources(),plan,'RESOURCE_IDENTITY_CHANGED');
 const measured=await api.measureIngestionSize(plan.ingestionDatabaseId);
 if(!exact(measured,['databaseId','observedBytes','observedAt','validUntil','evidenceDigest'])
  ||measured.databaseId!==plan.capacityObservation.databaseId
  ||measured.observedBytes!==plan.capacityObservation.observedBytes
  ||measured.observedAt!==plan.capacityObservation.observedAt
  ||measured.validUntil!==plan.capacityObservation.validUntil
  ||measured.evidenceDigest!==plan.capacityObservation.evidenceDigest)fail('CAPACITY_EVIDENCE_CHANGED');
 const runtimePlan={qualificationId:plan.qualificationId,shardId:plan.shardId,
  catalogDatabaseId:plan.catalogDatabaseId,catalogBindingName:'STORAGE_ROUTING_DB',bindingName:plan.bindingName,
  ingestionDatabaseId:plan.ingestionDatabaseId,sourceId:plan.sourceId,sourceNamespace:plan.sourceNamespace,
  analyticsTargetId:plan.analyticsTargetId,analyticsBindingName:plan.analyticsBindingName,
  analyticsDatabaseId:plan.analyticsDatabaseId,erasureTargetId:plan.erasureTargetId,
  deletionLedgerBindingName:plan.deletionLedgerBindingName,deletionLedgerDatabaseId:plan.deletionLedgerDatabaseId,
  publicationBindingName:plan.publicationBindingName,publicationDatabaseId:plan.publicationDatabaseId,
  qualifiedAt:plan.qualifiedAt,expectedSchemaDigests:plan.expectedSchemaDigests};
 const candidate=await api.qualify(runtimePlan);
  if(!exact(candidate,RECEIPT_KEYS)||candidate.qualificationId!==plan.qualificationId||candidate.shardId!==plan.shardId
  ||candidate.catalogDatabaseId!==plan.catalogDatabaseId||candidate.catalogBindingName!=='STORAGE_ROUTING_DB'
  ||candidate.bindingName!==plan.bindingName
  ||candidate.ingestionDatabaseId!==plan.ingestionDatabaseId
  ||candidate.sourceId!==plan.sourceId||candidate.sourceNamespace!==plan.sourceNamespace
  ||candidate.analyticsTargetId!==plan.analyticsTargetId||candidate.analyticsBindingName!==plan.analyticsBindingName
  ||candidate.erasureTargetId!==plan.erasureTargetId
  ||candidate.deletionLedgerBindingName!==plan.deletionLedgerBindingName
  ||candidate.publicationBindingName!==plan.publicationBindingName
  ||candidate.analyticsDatabaseId!==plan.analyticsDatabaseId
  ||candidate.deletionLedgerDatabaseId!==plan.deletionLedgerDatabaseId
  ||candidate.publicationDatabaseId!==plan.publicationDatabaseId
  ||candidate.catalogSchemaDigest!==plan.expectedSchemaDigests.catalog
  ||candidate.ingestionSchemaDigest!==plan.expectedSchemaDigests.ingestion
  ||candidate.analyticsSchemaDigest!==plan.expectedSchemaDigests.analytics
  ||candidate.deletionSchemaDigest!==plan.expectedSchemaDigests.deletionLedger
  ||candidate.publicationSchemaDigest!==plan.expectedSchemaDigests.publication
  ||candidate.qualifiedAt!==plan.qualifiedAt||candidate.state!=='active'||candidate.revokedAt!==null
  ||candidate.contractVersion!==1
  ||!SHA.test(candidate.readinessDigest??''))fail('QUALIFICATION_CHANGED');
 const receipt=await api.record(candidate);
 if(!exact(receipt,RECEIPT_KEYS)||RECEIPT_KEYS.some(key=>receipt[key]!==candidate[key]))fail('RECEIPT_CHANGED');
 await api.observe({shardId:plan.shardId,observedBytes:measured.observedBytes,
  observedAt:measured.observedAt,validUntil:measured.validUntil,pressureState:'normal'});
 await api.configure({shardId:plan.shardId,allocationTier:plan.allocationTier,allocationEnabled:true,
  qualificationDigest:receipt.readinessDigest,updatedAt:plan.qualifiedAt});
 const policy=await api.readPolicy(plan.shardId);
 if(!exact(policy,['allocationTier','allocationEnabled','qualificationDigest','updatedAt'])
  ||policy.allocationTier!==plan.allocationTier||policy.allocationEnabled!==true
  ||policy.qualificationDigest!==receipt.readinessDigest||policy.updatedAt!==plan.qualifiedAt)fail('ACTIVATION_UNCERTAIN');
 return Object.freeze({schema:'storage-shard-readiness-activation-v1',shardId:plan.shardId,
  readinessDigest:receipt.readinessDigest,capacityEvidenceDigest:measured.evidenceDigest,
  qualifiedAt:plan.qualifiedAt,observedAt:now,allocationTier:plan.allocationTier,
  resourceDigest:digest(['storage-shard-readiness-resources-v1',configured])});
}

export function storageShardCapacityEvidence(input){
 if(!exact(input,['databaseId','observedBytes','observedAt','validUntil']))fail('CAPACITY_EVIDENCE_INVALID');
 const evidenceDigest=digest(['storage-shard-capacity-evidence-v1',input.databaseId,input.observedBytes,
  input.observedAt,input.validUntil]);
 return Object.freeze({...input,evidenceDigest});
}
