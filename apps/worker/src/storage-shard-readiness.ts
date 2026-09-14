import { sha256Hex } from './crypto';
import { StorageRoutingError } from './storage-routing';
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from './typed-telemetry-origins';

const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const BINDING=/^[A-Z][A-Z0-9_]{0,63}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_SCHEMA_OBJECTS=800;
const invalid=()=>new StorageRoutingError('INVALID_ROUTING_INPUT');
const unavailable=()=>new StorageRoutingError('STORAGE_UNAVAILABLE');

export interface StorageShardReadinessTuple {
  readonly qualificationId:string;
  readonly shardId:string;
  readonly catalogDatabaseId:string;
  readonly catalogBindingName:string;
  readonly catalogSchemaDigest:string;
  readonly bindingName:string;
  readonly ingestionDatabaseId:string;
  readonly sourceId:string;
  readonly sourceNamespace:string;
  readonly ingestionSchemaDigest:string;
  readonly analyticsTargetId:string;
  readonly analyticsBindingName:string;
  readonly analyticsDatabaseId:string;
  readonly analyticsSchemaDigest:string;
  readonly erasureTargetId:string;
  readonly deletionLedgerBindingName:string;
  readonly deletionLedgerDatabaseId:string;
  readonly deletionSchemaDigest:string;
  readonly publicationDatabaseId:string;
  readonly publicationBindingName:string;
  readonly publicationSchemaDigest:string;
}
export interface StorageShardReadinessReceipt extends StorageShardReadinessTuple {
  readonly readinessDigest:string;
  readonly qualifiedAt:number;
  readonly state:'active'|'revoked';
  readonly revokedAt:number|null;
  readonly contractVersion:1;
}
export interface StorageShardReadinessDatabases {
  readonly catalog:D1Database;
  readonly ingestion:D1Database;
  readonly analytics:D1Database;
  readonly deletionLedger:D1Database;
  readonly publication:D1Database;
}
export interface StorageShardReadinessPlan {
  readonly qualificationId:string;
  readonly shardId:string;
  readonly catalogDatabaseId:string;
  readonly catalogBindingName:string;
  readonly bindingName:string;
  readonly ingestionDatabaseId:string;
  readonly sourceId:string;
  readonly sourceNamespace:string;
  readonly analyticsTargetId:string;
  readonly analyticsBindingName:string;
  readonly analyticsDatabaseId:string;
  readonly erasureTargetId:string;
  readonly deletionLedgerBindingName:string;
  readonly deletionLedgerDatabaseId:string;
  readonly publicationDatabaseId:string;
  readonly publicationBindingName:string;
  readonly qualifiedAt:number;
  readonly expectedSchemaDigests:StorageShardReadinessSchemaDigests;
}
export interface StorageShardReadinessSchemaDigests {
 readonly catalog:string;readonly ingestion:string;readonly analytics:string;
 readonly deletionLedger:string;readonly publication:string;
}

const TUPLE_KEYS=['qualificationId','shardId','catalogDatabaseId','catalogBindingName','catalogSchemaDigest','bindingName','ingestionDatabaseId','sourceId',
  'sourceNamespace','ingestionSchemaDigest','analyticsTargetId','analyticsBindingName','analyticsDatabaseId',
  'analyticsSchemaDigest','erasureTargetId','deletionLedgerBindingName','deletionLedgerDatabaseId','deletionSchemaDigest',
  'publicationBindingName','publicationDatabaseId','publicationSchemaDigest'] as const;
const PLAN_KEYS=['qualificationId','shardId','catalogDatabaseId','catalogBindingName','bindingName','ingestionDatabaseId','sourceId',
  'sourceNamespace','analyticsTargetId','analyticsBindingName','analyticsDatabaseId','erasureTargetId',
  'deletionLedgerBindingName','deletionLedgerDatabaseId','publicationBindingName','publicationDatabaseId','qualifiedAt','expectedSchemaDigests'] as const;
const SCHEMA_DIGEST_KEYS=['catalog','ingestion','analytics','deletionLedger','publication'] as const;
const RECEIPT_KEYS=[...TUPLE_KEYS,'readinessDigest','qualifiedAt','state','revokedAt','contractVersion'] as const;
function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function integer(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>=0;}
function validateTuple(value:unknown):asserts value is StorageShardReadinessTuple{
 if(!exact(value,TUPLE_KEYS)||!UUID.test(String(value.qualificationId))
  ||!ID.test(String(value.shardId))||!UUID.test(String(value.catalogDatabaseId))
  ||value.catalogBindingName!=='STORAGE_ROUTING_DB'
  ||!BINDING.test(String(value.bindingName))
  ||!UUID.test(String(value.ingestionDatabaseId))||!ID.test(String(value.sourceId))
  ||typeof value.sourceNamespace!=='string'||value.sourceNamespace.length<1||value.sourceNamespace.length>256
  ||!DIGEST.test(String(value.ingestionSchemaDigest))||!ID.test(String(value.analyticsTargetId))
  ||!BINDING.test(String(value.analyticsBindingName))
  ||!UUID.test(String(value.analyticsDatabaseId))||!DIGEST.test(String(value.analyticsSchemaDigest))
  ||!ID.test(String(value.erasureTargetId))||!BINDING.test(String(value.deletionLedgerBindingName))
  ||!UUID.test(String(value.deletionLedgerDatabaseId))
  ||!DIGEST.test(String(value.deletionSchemaDigest))||!BINDING.test(String(value.publicationBindingName))
  ||!UUID.test(String(value.publicationDatabaseId))
  ||!DIGEST.test(String(value.publicationSchemaDigest)))throw invalid();
 const suffix=/^(?:STORAGE_)?INGESTION_([ABC])$/u.exec(String(value.bindingName))?.[1];
 if(!suffix||value.analyticsBindingName!==`STORAGE_ANALYTICS_${suffix}`
  ||value.analyticsTargetId!==`analytics-${suffix.toLowerCase()}`
  ||value.erasureTargetId!==value.analyticsTargetId
  ||value.deletionLedgerBindingName!=='DELETION_LEDGER'
  ||value.publicationBindingName!=='STORAGE_PUBLICATION_DB')throw invalid();
 const databaseIds=[value.catalogDatabaseId,value.ingestionDatabaseId,value.analyticsDatabaseId,
  value.deletionLedgerDatabaseId,value.publicationDatabaseId];
 if(new Set(databaseIds).size!==databaseIds.length)throw invalid();
}
function validatePlan(value:unknown):asserts value is StorageShardReadinessPlan{
 if(!exact(value,PLAN_KEYS)||!integer(value.qualifiedAt)
  ||!exact(value.expectedSchemaDigests,SCHEMA_DIGEST_KEYS)
  ||SCHEMA_DIGEST_KEYS.some(key=>!DIGEST.test(String((value.expectedSchemaDigests as Record<string,unknown>)[key]))))throw invalid();
 const tuple={qualificationId:value.qualificationId,shardId:value.shardId,catalogDatabaseId:value.catalogDatabaseId,
  catalogBindingName:value.catalogBindingName,
  catalogSchemaDigest:'0'.repeat(64),
  bindingName:value.bindingName,
  ingestionDatabaseId:value.ingestionDatabaseId,sourceId:value.sourceId,sourceNamespace:value.sourceNamespace,
  analyticsTargetId:value.analyticsTargetId,analyticsBindingName:value.analyticsBindingName,
  analyticsDatabaseId:value.analyticsDatabaseId,erasureTargetId:value.erasureTargetId,
  deletionLedgerBindingName:value.deletionLedgerBindingName,deletionLedgerDatabaseId:value.deletionLedgerDatabaseId,
  publicationBindingName:value.publicationBindingName,publicationDatabaseId:value.publicationDatabaseId,
  ingestionSchemaDigest:'0'.repeat(64),
  analyticsSchemaDigest:'0'.repeat(64),deletionSchemaDigest:'0'.repeat(64),publicationSchemaDigest:'0'.repeat(64)};
 validateTuple(tuple);
}
function tupleFrom(value:StorageShardReadinessTuple):StorageShardReadinessTuple{
 return Object.fromEntries(TUPLE_KEYS.map(key=>[key,value[key]])) as unknown as StorageShardReadinessTuple;
}
function tupleBytes(tuple:StorageShardReadinessTuple):string{
 return JSON.stringify(['storage-shard-runtime-readiness-v1',...TUPLE_KEYS.map(key=>tuple[key])]);
}
export async function storageShardReadinessDigest(tuple:StorageShardReadinessTuple):Promise<string>{
 validateTuple(tuple);return sha256Hex(tupleBytes(tuple));
}

interface SchemaRow{type:string;name:string;tbl_name:string;sql:string;}
async function schemaEvidence(database:D1Database,required:readonly string[]):Promise<string>{
 let result:D1Result<SchemaRow>;
 try{result=await database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
  ORDER BY type,name,tbl_name LIMIT ?`).bind(MAX_SCHEMA_OBJECTS+1).all<SchemaRow>();}
 catch{throw unavailable();}
 const rows=result.results;
 if(rows.length>MAX_SCHEMA_OBJECTS)throw unavailable();
 const names=new Set(rows.map(row=>row.name));
 if(required.some(name=>!names.has(name)))throw unavailable();
 return sha256Hex(JSON.stringify(['storage-shard-schema-v1',rows.map(row=>
  [row.type,row.name,row.tbl_name,row.sql])]));
}
const INGESTION_REQUIRED=['storage_source_state','typed_v1_admission_state','typed_v11_admission_state',
 'typed_telemetry_origin_contracts','storage_owner_fences','participants'] as const;
const ANALYTICS_REQUIRED=['analytics_runtime_sources','analytics_storage_erasure_fences',
 'analytics_storage_erasure_receipts','analytics_multi_source_control','analytics_multi_source_publications'] as const;
const DELETION_REQUIRED=['deletion_tombstones','storage_erasure_jobs','storage_erasure_targets',
 'storage_catalog_deletion_replay_pending'] as const;
const PUBLICATION_REQUIRED=['analytics_multi_source_control','analytics_multi_source_publications'] as const;
const CATALOG_REQUIRED=['storage_shards','storage_shard_capacity_observations','storage_shard_allocation_policy',
 'storage_shard_runtime_readiness','storage_owner_routes','storage_owner_moves'] as const;

export async function captureStorageShardReadinessSchemaDigests(
 databases:StorageShardReadinessDatabases,
):Promise<StorageShardReadinessSchemaDigests>{
 if(!databases||new Set(Object.values(databases)).size!==5)throw invalid();
 const [catalog,ingestion,analytics,deletionLedger,publication]=await Promise.all([
  schemaEvidence(databases.catalog,CATALOG_REQUIRED),schemaEvidence(databases.ingestion,INGESTION_REQUIRED),
  schemaEvidence(databases.analytics,ANALYTICS_REQUIRED),schemaEvidence(databases.deletionLedger,DELETION_REQUIRED),
  schemaEvidence(databases.publication,PUBLICATION_REQUIRED),
 ]);
 return Object.freeze({catalog,ingestion,analytics,deletionLedger,publication});
}

/** Root-only qualification seam. It reads a bounded, content-free schema and
 * exact runtime identities from every member of the proposed tuple. */
export async function qualifyStorageShardRuntimeTuple(
 plan:StorageShardReadinessPlan,databases:StorageShardReadinessDatabases,
):Promise<StorageShardReadinessReceipt>{
 validatePlan(plan);
 if(!databases||new Set(Object.values(databases)).size!==5)throw invalid();
 let source,origin,analyticsSource;
 try{
  [source,origin,analyticsSource]=await Promise.all([
   databases.ingestion.prepare(`SELECT s.source_id,v1.source_namespace v1_namespace,
    v1.runtime_contract_version v1_contract,v11.source_namespace v11_namespace,
    v11.runtime_contract_version v11_contract FROM storage_source_state s
    JOIN typed_v1_admission_state v1 ON v1.id=1 JOIN typed_v11_admission_state v11 ON v11.id=1
    WHERE s.singleton=1 LIMIT 2`).all<Record<string,unknown>>(),
   databases.ingestion.prepare(`SELECT source_namespace,access_mode,v1_read_contract_version,
    v11_read_contract_version,source_schema_digest,registered_move_id
    FROM typed_telemetry_origin_contracts WHERE source_namespace=? LIMIT 2`)
    .bind(plan.sourceNamespace).all<Record<string,unknown>>(),
   databases.analytics.prepare(`SELECT source_namespace,contract_version FROM analytics_runtime_sources
    WHERE source_id=? LIMIT 2`).bind(plan.sourceId).all<Record<string,unknown>>(),
  ]);
 }catch{throw unavailable();}
 const s=source.results[0],o=origin.results[0],a=analyticsSource.results[0];
 if(source.results.length!==1||s?.source_id!==plan.sourceId||s.v1_namespace!==plan.sourceNamespace
  ||s.v11_namespace!==plan.sourceNamespace||s.v1_contract!==1||s.v11_contract!==1
  ||origin.results.length!==1||o?.source_namespace!==plan.sourceNamespace
  ||o.access_mode!=='current-write'||o.v1_read_contract_version!==2||o.v11_read_contract_version!==2
  ||o.source_schema_digest!==TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST||o.registered_move_id!==null
  ||analyticsSource.results.length!==1||a?.source_namespace!==plan.sourceNamespace||a.contract_version!==1){
  throw unavailable();
 }
 const observed=await captureStorageShardReadinessSchemaDigests(databases);
 if(SCHEMA_DIGEST_KEYS.some(key=>observed[key]!==plan.expectedSchemaDigests[key]))throw unavailable();
 const tuple:StorageShardReadinessTuple={qualificationId:plan.qualificationId,shardId:plan.shardId,
  catalogDatabaseId:plan.catalogDatabaseId,catalogBindingName:plan.catalogBindingName,
  catalogSchemaDigest:observed.catalog,
  bindingName:plan.bindingName,ingestionDatabaseId:plan.ingestionDatabaseId,sourceId:plan.sourceId,
  sourceNamespace:plan.sourceNamespace,ingestionSchemaDigest:observed.ingestion,analyticsTargetId:plan.analyticsTargetId,
  analyticsBindingName:plan.analyticsBindingName,
  analyticsDatabaseId:plan.analyticsDatabaseId,analyticsSchemaDigest:observed.analytics,erasureTargetId:plan.erasureTargetId,
  deletionLedgerBindingName:plan.deletionLedgerBindingName,
  deletionLedgerDatabaseId:plan.deletionLedgerDatabaseId,deletionSchemaDigest:observed.deletionLedger,
  publicationBindingName:plan.publicationBindingName,
  publicationDatabaseId:plan.publicationDatabaseId,publicationSchemaDigest:observed.publication};
 return Object.freeze({...tuple,readinessDigest:await storageShardReadinessDigest(tuple),
  qualifiedAt:plan.qualifiedAt,state:'active' as const,revokedAt:null,contractVersion:1 as const});
}

interface ReceiptRow{readiness_digest:string;qualification_id:string;shard_id:string;catalog_database_id:string;catalog_binding_name:string;catalog_schema_digest:string;binding_name:string;
 ingestion_database_id:string;source_id:string;source_namespace:string;ingestion_schema_digest:string;
 analytics_target_id:string;analytics_binding_name:string;analytics_database_id:string;analytics_schema_digest:string;erasure_target_id:string;
 deletion_ledger_binding_name:string;deletion_ledger_database_id:string;deletion_schema_digest:string;
 publication_binding_name:string;publication_database_id:string;
 publication_schema_digest:string;qualified_at:number;state:'active'|'revoked';revoked_at:number|null;contract_version:number;}
const READ_RECEIPT=`SELECT readiness_digest,qualification_id,shard_id,catalog_database_id,catalog_binding_name,catalog_schema_digest,binding_name,ingestion_database_id,
 source_id,source_namespace,ingestion_schema_digest,analytics_target_id,analytics_binding_name,analytics_database_id,
 analytics_schema_digest,erasure_target_id,deletion_ledger_binding_name,deletion_ledger_database_id,deletion_schema_digest,
 publication_binding_name,publication_database_id,publication_schema_digest,qualified_at,state,revoked_at,contract_version
 FROM storage_shard_runtime_readiness WHERE readiness_digest=? LIMIT 1`;
function receipt(row:ReceiptRow|undefined):StorageShardReadinessReceipt{
 if(!row||row.contract_version!==1)throw unavailable();
 return Object.freeze({readinessDigest:row.readiness_digest,qualificationId:row.qualification_id,
  catalogDatabaseId:row.catalog_database_id,catalogBindingName:row.catalog_binding_name,catalogSchemaDigest:row.catalog_schema_digest,
  shardId:row.shard_id,bindingName:row.binding_name,ingestionDatabaseId:row.ingestion_database_id,
  sourceId:row.source_id,sourceNamespace:row.source_namespace,ingestionSchemaDigest:row.ingestion_schema_digest,
  analyticsTargetId:row.analytics_target_id,analyticsBindingName:row.analytics_binding_name,
  analyticsDatabaseId:row.analytics_database_id,
  analyticsSchemaDigest:row.analytics_schema_digest,erasureTargetId:row.erasure_target_id,
  deletionLedgerBindingName:row.deletion_ledger_binding_name,
  deletionLedgerDatabaseId:row.deletion_ledger_database_id,deletionSchemaDigest:row.deletion_schema_digest,
  publicationBindingName:row.publication_binding_name,
  publicationDatabaseId:row.publication_database_id,publicationSchemaDigest:row.publication_schema_digest,
  qualifiedAt:row.qualified_at,state:row.state,revokedAt:row.revoked_at,contractVersion:1});
}
function same(left:StorageShardReadinessReceipt,right:StorageShardReadinessReceipt):boolean{
 return TUPLE_KEYS.every(key=>left[key]===right[key])&&left.readinessDigest===right.readinessDigest;
}

/** Exact read-only receipt seam for root operation recovery. Missing evidence
 * remains null; callers may not create or refresh a receipt through this API. */
export async function readStorageShardReadiness(catalog:D1Database,
 readinessDigest:string):Promise<StorageShardReadinessReceipt|null>{
 if(!catalog||typeof catalog.prepare!=='function'||!DIGEST.test(readinessDigest))throw invalid();
 let row:ReceiptRow|null;
 try{row=await catalog.prepare(READ_RECEIPT).bind(readinessDigest).first<ReceiptRow>();}
 catch{throw unavailable();}
 if(!row)return null;
 const stored=receipt(row);
 try{validateTuple(tupleFrom(stored));}catch{throw unavailable();}
 if(stored.readinessDigest!==readinessDigest||!integer(stored.qualifiedAt)
  ||stored.readinessDigest!==await storageShardReadinessDigest(tupleFrom(stored))
  ||stored.state==='active'&&stored.revokedAt!==null
  ||stored.state==='revoked'&&(!integer(stored.revokedAt)||stored.revokedAt<stored.qualifiedAt))throw unavailable();
 return stored;
}

/** Durable catalog publication. Response loss converges by the digest; a
 * competing active tuple or a revoked prior attempt is never adopted. */
export async function recordStorageShardReadiness(catalog:D1Database,
 candidate:StorageShardReadinessReceipt):Promise<StorageShardReadinessReceipt>{
 if(!exact(candidate,RECEIPT_KEYS))throw invalid();
 const candidateTuple=tupleFrom(candidate);validateTuple(candidateTuple);
 if(candidate.state!=='active'||candidate.revokedAt!==null||candidate.contractVersion!==1
  ||!integer(candidate.qualifiedAt)||candidate.readinessDigest!==await storageShardReadinessDigest(candidateTuple))throw invalid();
 try{await catalog.prepare(`INSERT INTO storage_shard_runtime_readiness(
  readiness_digest,qualification_id,shard_id,catalog_database_id,catalog_binding_name,catalog_schema_digest,binding_name,ingestion_database_id,source_id,source_namespace,
  ingestion_schema_digest,analytics_target_id,analytics_binding_name,analytics_database_id,analytics_schema_digest,erasure_target_id,
  deletion_ledger_binding_name,deletion_ledger_database_id,deletion_schema_digest,publication_binding_name,
  publication_database_id,publication_schema_digest,qualified_at,state,revoked_at,contract_version)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',NULL,1)
  ON CONFLICT(readiness_digest) DO NOTHING`).bind(candidate.readinessDigest,candidate.qualificationId,
  candidate.shardId,candidate.catalogDatabaseId,candidate.catalogBindingName,candidate.catalogSchemaDigest,candidate.bindingName,candidate.ingestionDatabaseId,
  candidate.sourceId,candidate.sourceNamespace,candidate.ingestionSchemaDigest,candidate.analyticsTargetId,
  candidate.analyticsBindingName,candidate.analyticsDatabaseId,candidate.analyticsSchemaDigest,
  candidate.erasureTargetId,candidate.deletionLedgerBindingName,candidate.deletionLedgerDatabaseId,
  candidate.deletionSchemaDigest,candidate.publicationBindingName,candidate.publicationDatabaseId,candidate.publicationSchemaDigest,
  candidate.qualifiedAt).run();}catch{/* exact readback below distinguishes races */}
 const stored=await readStorageShardReadiness(catalog,candidate.readinessDigest);
 if(!stored)throw unavailable();
 if(stored.state!=='active'||!same(stored,candidate))throw unavailable();
 return stored;
}

export async function revokeStorageShardReadiness(catalog:D1Database,readinessDigest:string,
 revokedAt:number):Promise<StorageShardReadinessReceipt>{
 if(!DIGEST.test(readinessDigest)||!integer(revokedAt))throw invalid();
 try{await catalog.prepare(`UPDATE storage_shard_runtime_readiness SET state='revoked',revoked_at=?
  WHERE readiness_digest=? AND state='active' AND qualified_at<=?`).bind(revokedAt,readinessDigest,revokedAt).run();}
 catch{throw unavailable();}
 const stored=await readStorageShardReadiness(catalog,readinessDigest);
 if(!stored)throw unavailable();
 if(stored.state!=='revoked'||stored.revokedAt===null||stored.revokedAt>revokedAt)throw unavailable();
 return stored;
}
