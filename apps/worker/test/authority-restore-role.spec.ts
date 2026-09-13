import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { insertTelemetryV1Chunk } from '../src/telemetry-v1-repository';
import { parseTelemetryV1Chunk } from '../src/telemetry-v1';
import { initializeAuthorityRestoreBootstrap,bootstrapAuthorityRestorePage } from '../src/authority-restore-bootstrap';
import { bootstrapRestoredV1Chunk } from '../src/authority-restore-adoption';
import { sha256Hex } from '../src/crypto';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { bootstrapV11StorageHead } from '../src/v11-storage-journal';
import { prepareAuthorityRoleTarget } from '../src/authority-restore-role';
import { AUTHORITY_OPERATOR_LEDGER_SQL,authoritySchemaInventory, authoritySchemaDigest, authorityRestoreContractDigest, authorityRestoreRetainedTableNames,
 freezeAuthorityRestoreSource,beginAuthorityRestore,copyAuthorityPage,copyAuthorityTypedPage,adoptAuthorityTypedPage,
 sealAuthorityRestore,verifyAuthorityTypedPage,completeAuthorityVerification,finalizeAuthorityRestore,promoteAuthorityRestore,type AuthorityRestoreContract } from '../src/authority-restore';
const b=env as Env&{STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_INGESTION_A,reference=()=>b.STORAGE_INGESTION_B;
const today=()=>new Date().toISOString().slice(0,10);
beforeEach(async()=>reset());
async function activate(db:D1Database,fixture:Awaited<ReturnType<typeof createV11DeviceFixture>>,day:Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>){
 const previous=await createTelemetryV11DomainPredecessor(db,fixture);
 const value:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:day.day,throughDay:day.day,predecessor:{token:previous.token,previousGenerationId:previous.previousGenerationId,legacyFingerprint:previous.legacyFingerprint},days:[{day:day.day,manifestId:day.manifestId,manifestDigest:day.manifestDigest}],manifestDigest:'0'.repeat(64)};
 value.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(value));return activateTelemetryV11Domain(db,fixture,value);
}
async function prepare(withV1=false){
 await applyD1Migrations(source(),b.TEST_MIGRATIONS);
 const fixture=await createV11DeviceFixture(source(),{grant:true});
 const records=[v11UsageRecord(today())];
 const staged=await stageV11Day(source(),fixture,await makeV11Day(today(),{usage:records}));
 const original=await activate(source(),fixture,staged);
 let legacyChunk:string|undefined;
 if(withV1){const legacy=await createV11DeviceFixture(source());const record={schemaVersion:'quota-observation-v1.0',observationId:`quota-occurrence:v1:${'c'.repeat(64)}`,observedTime:`${today()}T12:00:00.000Z`,provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:0.30000000000000004,windowDurationMinutes:10080,resetsAt:`${today()}T13:00:00.000Z`};
 const envelopeDigest=await sha256Hex('synthetic-v1-preserved');const principal=await authenticateDevice(source(),legacy.authorization);const upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,200);const claim=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
 const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`quota:${today()}:0`,chunkRevision:1,chunkDigest:await sha256Hex(canonicalTelemetryV11Json([record])),parserVersion:'synthetic-v1',consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records:[record]});legacyChunk=`chunk:${crypto.randomUUID()}`;
 await insertTelemetryV1Chunk(source(),{chunkRowId:legacyChunk,participantId:legacy.participantId,deviceId:legacy.deviceId,chunk,envelopeDigest,r2Key:'synthetic/legacy',deviceUploadAuthorizationId:claim.authorizationId,createdAt:new Date().toISOString(),supersedes:null});await source().prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='telemetry_v1_records'").run();}

 const oldOwner=await createV11DeviceFixture(source());
 const now=new Date().toISOString(),future=new Date(Date.now()+86400000).toISOString();
 const oldContribution=`contribution:${crypto.randomUUID()}`,oldUpload=`upload:${crypto.randomUUID()}`,oldDigest='d'.repeat(64);
 await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v0.2'").run();
 await source().batch([
  source().prepare("INSERT INTO upload_authorizations(id,participant_id,issued_by_session_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at) VALUES(?,?,?,?,?,1,'application/json','consuming',?,?,?)").bind(oldUpload,oldOwner.participantId,oldOwner.sessionId,new Uint8Array(32).buffer,oldDigest,now,future,future),
  source().prepare("INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,schema_version,range_start,range_end,client_platform,provider_policy_epoch,estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at,upload_authorization_id,transport_schema_version) VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1',?,?,'macos','synthetic',NULL,100,0,0,'server_repricing',1,?,?,'telemetry-contribution-v0.2')").bind(oldContribution,oldOwner.participantId,oldDigest,oldDigest,'synthetic/old-contribution',now,now,now,oldUpload),
  source().prepare("INSERT INTO telemetry_records(id,origin_contribution_id,participant_id,record_kind,occurrence_id,observed_at,provider,used_percent,record_json) VALUES(41,?,?,'quota','quota:synthetic-retained-v02',?,'openai_codex',0.30000000000000004,?)").bind(oldContribution,oldOwner.participantId,now,'{"synthetic":true,"value":0.30000000000000004}'),
  source().prepare("INSERT INTO telemetry_contribution_occurrences(contribution_id,participant_id,record_kind,occurrence_id) VALUES(?,?,'quota','quota:synthetic-retained-v02')").bind(oldContribution,oldOwner.participantId),
 ]);
 await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='blocked' WHERE schema_version='telemetry-contribution-v0.2'").run();
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,b.TEST_INGESTION_ISOLATION_MIGRATIONS])await applyD1Migrations(reference(),migrations);
 const role=await prepareAuthorityRoleTarget(reference(),target(),await authoritySchemaDigest(await authoritySchemaInventory(reference())));
 const sourceSchema=await authoritySchemaInventory(source()),retained=new Set(authorityRestoreRetainedTableNames());
 const sourceNamespace='synthetic.restored.'+'x'.repeat(130),sourceSnapshotDigest='a'.repeat(64);
 const tables:AuthorityRestoreContract['tables']=sourceSchema.filter(x=>x.type==='table').map(x=>({name:x.name,disposition:retained.has(x.name)?'authority':x.name==='telemetry_v1_records'?'typed-v1':x.name==='telemetry_v11_records'?'typed-v11':x.name==='d1_migrations'?'outside-role':'analytics'}));
 const authoritySequences=[];for(const object of sourceSchema.filter(x=>x.type==='table'&&(retained.has(x.name)||x.name==='telemetry_v1_records')&&/AUTOINCREMENT/.test(x.sql)))authoritySequences.push({name:object.name,sequence:await source().prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(object.name).first<number>('seq')??0});
 const ledgerRows=[{name:'0001_restore_base.sql',sha256:'f'.repeat(64)}] as const;
 await target().batch([target().prepare(AUTHORITY_OPERATOR_LEDGER_SQL),target().prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').bind(ledgerRows[0].name,ledgerRows[0].sha256)]);
 role.baseSchema.push({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:AUTHORITY_OPERATOR_LEDGER_SQL});
 role.finalSchema.push({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:AUTHORITY_OPERATOR_LEDGER_SQL});
 role.baseSchema.sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);role.finalSchema.sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
 const contract:AuthorityRestoreContract={targetOperatorLedgerDigest:await sha256Hex(canonicalTelemetryV11Json(ledgerRows)),version:'authority-restore-v1',runId:'synthetic-real-role',sourceId:'synthetic-restored-journal',sourceNamespace,sourceSnapshotDigest,sourceSchema,sourceSchemaDigest:await authoritySchemaDigest(sourceSchema),targetBaseSchema:role.baseSchema,targetBaseSchemaDigest:await authoritySchemaDigest(role.baseSchema),tables,finalSchema:role.finalSchema,finalSchemaDigest:await authoritySchemaDigest(role.finalSchema),typedCopies:['v1','v11'].map(format=>({runId:`restore-${format}`,sourceNamespace,sourceSnapshotDigest,format:format as 'v1'|'v11'})),authoritySequences,admissionContract:'typed-v1-v11-restore-v1',operatingLimitBytes:64*1024*1024};
 return {fixture,records,original,legacyChunk,contract,pin:await authorityRestoreContractDigest(contract)};
}
async function drain(step:()=>Promise<boolean>){for(let n=0;n<256;n++)if(await step())return;throw new Error('Synthetic bounded operation did not complete');}
describe('actual baseline to typed ingestion role',()=>{
 it('preserves a real accepted head and credentials, adopts typed history and accepts an ordinary successor',async()=>{
  const f=await prepare(true);
  const {targetOperatorLedgerDigest:excluded,...missing}=f.contract;void excluded;await expect(freezeAuthorityRestoreSource(source(),missing,await authorityRestoreContractDigest(missing))).rejects.toThrow();
  await freezeAuthorityRestoreSource(source(),f.contract,f.pin);
  await target().prepare('UPDATE d1_storage_migrations SET sha256=?').bind('e'.repeat(64)).run();
  await expect(beginAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
  await target().prepare('UPDATE d1_storage_migrations SET sha256=?').bind('f'.repeat(64)).run();
  await beginAuthorityRestore(source(),target(),f.contract,f.pin);
  await drain(async()=>(await copyAuthorityPage(source(),target(),f.contract,f.pin)).state==='complete');
  for(const format of ['v1','v11'] as const){await drain(async()=>(await copyAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).reachedEnd);await drain(async()=>(await adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).done);}
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  await drain(async()=>(await copyAuthorityPage(source(),target(),f.contract,f.pin,'verify')).state==='complete');
  for(const format of ['v1','v11'] as const){await drain(async()=>(await verifyAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).reachedEnd);await drain(async()=>(await adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,format,true)).done);}
  await completeAuthorityVerification(source(),target(),f.contract,f.pin);await promoteAuthorityRestore(source(),target(),f.contract,f.pin);await finalizeAuthorityRestore(source(),target(),f.contract,f.pin);
  expect(await target().prepare('SELECT id,used_percent,record_json FROM telemetry_records').first()).toEqual({id:41,used_percent:0.30000000000000004,record_json:'{"synthetic":true,"value":0.30000000000000004}'});
  expect(await target().prepare('SELECT count(*) n FROM telemetry_contribution_occurrences').first('n')).toBe(1);
  expect(await target().prepare("SELECT state FROM upload_authorizations WHERE consumed_contribution_id IS NOT NULL").first('state')).toBe('consumed');
  expect(await target().prepare('SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(f.fixture.participantId).first('generation_id')).toBe(f.original.generationId);
  expect(await target().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM typed_v11_record_admissions').first('n')).toBe(1);
  await initializeAuthorityRestoreBootstrap(target(),f.pin);
  expect(await target().prepare('SELECT source_id FROM storage_source_state').first('source_id')).toBe(f.contract.sourceId);
  expect(await target().prepare('SELECT source_namespace FROM typed_v11_admission_state').first('source_namespace')).toBe(f.contract.sourceNamespace);
  expect(await target().prepare('SELECT name,sha256 FROM d1_storage_migrations').first()).toEqual({name:'0001_restore_base.sql',sha256:'f'.repeat(64)});
  expect(await target().prepare('SELECT completed FROM community_public_source_bootstrap').first('completed')).toBe(0);
  await expect(target().prepare('UPDATE participants SET state=state').run()).rejects.toThrow('authority_restore_bootstrap_frozen');
  for(const table of ['typed_v11_record_proofs','typed_v11_manifest_memberships'])for(const action of ['UPDATE','DELETE']){
   expect(await target().prepare('SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND name=?').bind(`_authority_bootstrap_${table}_${action}`).first()).not.toBeNull();
  }
  const guard=await target().prepare("SELECT name,sql FROM sqlite_master WHERE name='_authority_bootstrap_participants_UPDATE'").first<{name:string;sql:string}>();
  await target().prepare(`DROP TRIGGER "${guard!.name}"`).run();
  await expect(bootstrapAuthorityRestorePage(target(),f.pin)).rejects.toThrow('AUTHORITY_RESTORE_BOOTSTRAP_UNQUALIFIED');
  expect(await target().prepare('SELECT completed FROM community_public_source_bootstrap').first('completed')).toBe(0);
  await target().prepare(guard!.sql).run();
  const actualTarget=target();let loseResponse=true;
  const responseLostTarget=new Proxy(actualTarget,{get(o,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await o.batch(statements);if(loseResponse){loseResponse=false;throw new Error('synthetic bootstrap response loss');}return result;};const value=Reflect.get(o,key);return typeof value==='function'?value.bind(o):value;}});
  await expect(bootstrapAuthorityRestorePage(responseLostTarget,f.pin)).rejects.toThrow('synthetic bootstrap response loss');
  await drain(async()=>(await bootstrapAuthorityRestorePage(target(),f.pin)).completed);
  expect(await target().prepare('SELECT completed FROM community_public_source_bootstrap').first('completed')).toBe(1);
  expect(await target().prepare('SELECT count(*) n FROM storage_legacy_event_sources').first('n')).toBe(1);
  const journalCount=await target().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n');
  await initializeAuthorityRestoreBootstrap(target(),f.pin);
  expect((await bootstrapAuthorityRestorePage(target(),f.pin)).completed).toBe(true);
  expect(await target().prepare('SELECT count(*) n FROM storage_ingestion_changes').first('n')).toBe(journalCount);
  expect(await bootstrapRestoredV1Chunk(target(),f.pin,f.legacyChunk!)).toBe('eligible-chunk');
  expect(await bootstrapRestoredV1Chunk(target(),f.pin,f.legacyChunk!)).toBe('eligible-chunk');
  expect(await target().prepare('SELECT next_source_row_id FROM typed_v1_admission_state').first('next_source_row_id')).toBe(501);
  expect(await target().prepare('SELECT count(*) n FROM typed_v1_event_sources').first('n')).toBe(1);
  expect(await target().prepare('SELECT used_percent,analysis_source_row_id FROM typed_telemetry_quota WHERE analysis_source_row_id IS NOT NULL').first()).toEqual({used_percent:0.30000000000000004,analysis_source_row_id:1});
  expect(await bootstrapV11StorageHead(target(),f.fixture.participantId)).toBe('eligible-head');
  const principal=await authenticateDevice(target(),f.fixture.authorization);
  const next=await makeV11Day(today(),{usage:[...f.records,v11UsageRecord(today(),'b')]});
  await registerTelemetryV11DayManifest(target(),f.fixture,next.manifest);
  for(const chunk of next.chunks){
   const envelopeDigest=await sha256Hex(`synthetic-new:${chunk.chunkDigest}`);
   const issued=await createDeviceUploadAuthorization(target(),principal,envelopeDigest,200);
   const claimed=await claimDeviceUploadAuthorization(target(),`Upload ${issued.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
   await persistTypedV11StagedChunk(target(),f.fixture,chunk,{sourceNamespace:f.contract.sourceNamespace,chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:'synthetic/new',envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId});
  }
  const completed=await registerTelemetryV11DayManifest(target(),f.fixture,next.manifest);
  expect((await activate(target(),f.fixture,completed)).generationId).not.toBe(f.original.generationId);
  expect(await target().prepare('SELECT next_source_row_id FROM typed_v11_admission_state').first('next_source_row_id')).toBe(4);
  expect(await target().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(0);
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(1);
  expect(await target().prepare('SELECT count(*) n FROM community_prepared_usage_rows').first('n')).toBe(0);
 },30000);
 it('fails closed on a corrupted adopted proof without promoting or deleting either copy',async()=>{
  const f=await prepare();await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);
  await drain(async()=>(await copyAuthorityPage(source(),target(),f.contract,f.pin)).state==='complete');
  for(const format of ['v1','v11'] as const){await drain(async()=>(await copyAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).reachedEnd);await drain(async()=>(await adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,format)).done);}
  await target().prepare("UPDATE typed_v11_record_proofs SET base_digest=zeroblob(32)").run();
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  await expect(adoptAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11',true)).rejects.toThrow('AUTHORITY_RESTORE_ADOPTION_MISMATCH');
  await expect(promoteAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow();
  expect(await target().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(1);
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(1);
 },30000);

});
