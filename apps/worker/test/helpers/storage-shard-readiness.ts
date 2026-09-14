import {
  recordStorageShardReadiness,
  storageShardReadinessDigest,
  type StorageShardReadinessReceipt,
  type StorageShardReadinessTuple,
} from '../../src/storage-shard-readiness';

const shardByte=(shardId:string)=>[...shardId].reduce((value,char)=>(value+char.charCodeAt(0))%256,0)
  .toString(16).padStart(2,'0');
const uuid=(byte:string,suffix:string)=>`${byte.repeat(4)}-${byte.repeat(2)}-4${byte.repeat(2).slice(1)}-8${byte.repeat(2).slice(1)}-${suffix.repeat(12)}`;

/** Test-only catalog fixture. Runtime qualification itself is covered by the
 * dedicated D1 spec; routing tests seed a closed synthetic receipt. */
export async function qualifyStorageShardForTest(catalog:D1Database,input:Readonly<{
 shardId:string;bindingName:string;qualifiedAt?:number;
}>):Promise<StorageShardReadinessReceipt>{
 const byte=shardByte(input.shardId);
 const tuple:StorageShardReadinessTuple={
  qualificationId:uuid(byte,'a'),shardId:input.shardId,bindingName:input.bindingName,
  catalogDatabaseId:uuid(byte,'0'),catalogBindingName:'STORAGE_ROUTING_DB',catalogSchemaDigest:'0'.repeat(64),
  ingestionDatabaseId:uuid(byte,'1'),sourceId:`source-${input.shardId}`,
  sourceNamespace:`namespace-${input.shardId}`,ingestionSchemaDigest:'1'.repeat(64),
  analyticsTargetId:`analytics-${input.shardId}`,analyticsBindingName:`STORAGE_ANALYTICS_${input.shardId.toUpperCase()}`,
  analyticsDatabaseId:uuid(byte,'2'),
  analyticsSchemaDigest:'2'.repeat(64),erasureTargetId:`analytics-${input.shardId}`,
  deletionLedgerBindingName:'DELETION_LEDGER',deletionLedgerDatabaseId:uuid(byte,'3'),
  deletionSchemaDigest:'3'.repeat(64),publicationBindingName:'STORAGE_PUBLICATION_DB',
  publicationDatabaseId:uuid(byte,'4'),publicationSchemaDigest:'4'.repeat(64),
 };
 const candidate:StorageShardReadinessReceipt={...tuple,
  readinessDigest:await storageShardReadinessDigest(tuple),qualifiedAt:input.qualifiedAt??0,
  state:'active',revokedAt:null,contractVersion:1};
 return recordStorageShardReadiness(catalog,candidate);
}
