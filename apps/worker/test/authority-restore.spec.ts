import { canonicalTelemetryV11Json, type TelemetryV11Record } from '@app-usagemonitor/telemetry-contract';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords } from '../src/typed-telemetry-codec';
import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authoritySchemaInventory, authoritySchemaDigest, authorityMigrationLedgerDigest, authorityRestoreContractDigest,
 copyAuthorityTypedPage, verifyAuthorityTypedPage, freezeAuthorityRestoreSource, beginAuthorityRestore, copyAuthorityPage, sealAuthorityRestore,
 completeAuthorityVerification, finalizeAuthorityRestore, promoteAuthorityRestore, type AuthorityRestoreContract } from '../src/authority-restore';
const source=()=>env.USAGE_MONITOR_DB;
const target=()=>(env as Env & {STORAGE_INGESTION_A:D1Database}).STORAGE_INGESTION_A;
beforeEach(async()=>reset());
async function fixture(count=35,auto=false){
 const sql=[
 `CREATE TABLE participants(id TEXT PRIMARY KEY NOT NULL,state TEXT NOT NULL,secret_hash BLOB NOT NULL,note TEXT) STRICT`,
 `CREATE TABLE device_credentials(id TEXT PRIMARY KEY NOT NULL,participant_id TEXT NOT NULL REFERENCES participants(id),state TEXT NOT NULL,expires_at TEXT NOT NULL,secret_hash BLOB NOT NULL) STRICT`,
 `CREATE TABLE telemetry_v11_device_consents(participant_id TEXT NOT NULL REFERENCES participants(id),device_id TEXT NOT NULL REFERENCES device_credentials(id),version TEXT NOT NULL,PRIMARY KEY(participant_id,device_id)) STRICT, WITHOUT ROWID`,
 `CREATE TABLE telemetry_v11_day_manifests(id TEXT PRIMARY KEY NOT NULL,participant_id TEXT NOT NULL REFERENCES participants(id),device_id TEXT NOT NULL REFERENCES device_credentials(id),state TEXT NOT NULL,manifest_json TEXT NOT NULL) STRICT`,
 `CREATE TABLE device_upload_authorizations(id TEXT PRIMARY KEY NOT NULL,participant_id TEXT NOT NULL REFERENCES participants(id),device_id TEXT NOT NULL REFERENCES device_credentials(id),state TEXT NOT NULL,consumed_contribution_id TEXT,secret_hash BLOB NOT NULL) STRICT`];
 await source().batch(sql.map(s=>source().prepare(s)));
 await source().batch(Array.from({length:count},(_,n)=>source().prepare('INSERT INTO participants VALUES(?,?,?,?)').bind(`synthetic-${n}`,n?'active':'deleting',new Uint8Array([0,1,255]).buffer,n?'':null)));
 await source().batch([
 source().prepare("INSERT INTO device_credentials VALUES('device','synthetic-0','revoked','2000-01-01',?)").bind(new Uint8Array([255,0,2]).buffer),
 source().prepare("INSERT INTO telemetry_v11_device_consents VALUES('synthetic-0','device','old-version')"),
 source().prepare("INSERT INTO telemetry_v11_day_manifests VALUES('manifest','synthetic-0','device','ready','{}')"),
 source().prepare("INSERT INTO device_upload_authorizations VALUES('claim','synthetic-0','device','consumed','retained-contribution',?)").bind(new Uint8Array([4,5]).buffer),
 source().prepare('CREATE INDEX synthetic_device_owner ON device_credentials(participant_id)'),
 source().prepare("CREATE TRIGGER synthetic_current_guard BEFORE INSERT ON participants WHEN NEW.state!='active' BEGIN SELECT RAISE(ABORT,'current_admission'); END")]);
 if(auto){await source().prepare('CREATE TABLE admin_action_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,details_json TEXT NOT NULL) STRICT').run();await source().prepare("INSERT INTO admin_action_audit VALUES(500,'synthetic')").run();await source().prepare('DELETE FROM admin_action_audit').run();}
 const sourceSchema=await authoritySchemaInventory(source());
 const finalSchema=sourceSchema.map(o=>({...o,sql:o.type==='table'?o.sql.replace(/\b(CREATE TABLE|REFERENCES) ([A-Za-z_][A-Za-z0-9_]*)/g,'$1 "$2"'):o.sql}));
 const contract:AuthorityRestoreContract={version:'authority-restore-v1',runId:'restore-synthetic',sourceId:'synthetic-journal',sourceNamespace:'source-synthetic',sourceSnapshotDigest:'a'.repeat(64),sourceSchema,sourceSchemaDigest:await authoritySchemaDigest(sourceSchema),targetBaseSchema:[],targetBaseSchemaDigest:await authoritySchemaDigest([]),tables:sourceSchema.filter(o=>o.type==='table').map(o=>({name:o.name,disposition:'authority'})),finalSchema,finalSchemaDigest:await authoritySchemaDigest(finalSchema),typedCopies:[],authoritySequences:auto?[{name:'admin_action_audit',sequence:500}]:[],operatingLimitBytes:64*1024*1024};
 return {contract,pin:await authorityRestoreContractDigest(contract)};
}
async function prepared(count=35){const f=await fixture(count);await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);return f;}
async function drain(f:Awaited<ReturnType<typeof fixture>>,kind:'copy'|'verify'='copy',db=target()){
 for(let n=0;n<30;n++){const r=await copyAuthorityPage(source(),db,f.contract,f.pin,kind);expect(r.rows).toBeLessThanOrEqual(32);if(r.state==='complete')return;}throw new Error('Synthetic restore did not finish');
}
function wrapped(batch:D1Database['batch']){return new Proxy(target(),{get(db,key){if(key==='batch')return batch;const v=Reflect.get(db,key);return typeof v==='function'?v.bind(db):v;}});}
async function rawFixture(){
 const f=await fixture(1);
 const day='2026-09-11';
 await source().prepare("ALTER TABLE telemetry_v11_day_manifests ADD COLUMN chunk_day TEXT NOT NULL DEFAULT '2026-09-11'").run();
 await source().prepare('CREATE TABLE telemetry_v11_chunks(id TEXT PRIMARY KEY,participant_id TEXT NOT NULL REFERENCES participants(id),device_id TEXT NOT NULL REFERENCES device_credentials(id),manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id),stream TEXT NOT NULL,chunk_day TEXT NOT NULL) STRICT').run();
 await source().prepare('CREATE TABLE telemetry_v11_records(chunk_id TEXT NOT NULL REFERENCES telemetry_v11_chunks(id),manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id),stream TEXT NOT NULL,occurrence_id TEXT NOT NULL,observed_at TEXT NOT NULL,record_json TEXT NOT NULL,legacy_occurrence_id TEXT,legacy_record_json TEXT) STRICT').run();
 const records:TelemetryV11Record[]=[v11UsageRecord(day),{schemaVersion:'quota-observation-v1.1',observationId:`quota-occurrence:v1:${'b'.repeat(64)}`,provider:'openai_codex',observedTime:`${day}T12:05:00.000Z`,planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',usedPercent:0.30000000000000004,windowDurationMinutes:null,resetsAt:null,accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,planBasis:'same_source_occurrence',planType:'pro',planEraId:null}},
 {schemaVersion:'session-dimension-v1.1',sessionUuid:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',firstEventTime:`${day}T12:05:00.000Z`,provider:'openai_codex',toolClassCounts:{shell:0,other:3}}];
 for(const record of records){
  const fields=encodeTypedTelemetryRecord('v11',record), decoded=typedTelemetryCanonicalRecords(fields);
  const occurrence=fields.stream==='usage'?Reflect.get(record,'eventId'):fields.stream==='quota'?Reflect.get(record,'observationId'):Reflect.get(record,'sessionUuid');
  await source().prepare("INSERT INTO telemetry_v11_chunks VALUES(?,'synthetic-0','device','manifest',?,?)").bind(`chunk-${fields.stream}`,fields.stream,day).run();
  await source().prepare("INSERT INTO telemetry_v11_records VALUES(?,'manifest',?,?,?,?,?,?)").bind(`chunk-${fields.stream}`,fields.stream,occurrence,new Date(fields.observedAtMs).toISOString(),canonicalTelemetryV11Json(record),decoded.legacy?.occurrenceId??null,decoded.legacy?.canonicalRecord??null).run();
 }
 await applyD1Migrations(target(),(env as Env&{TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]}).TEST_TYPED_INGESTION_MIGRATIONS);
 f.contract.sourceSchema=await authoritySchemaInventory(source());f.contract.sourceSchemaDigest=await authoritySchemaDigest(f.contract.sourceSchema);
 f.contract.targetMigrationLedgerDigest=await authorityMigrationLedgerDigest(target());
 f.contract.targetBaseSchema=await authoritySchemaInventory(target());f.contract.targetBaseSchemaDigest=await authoritySchemaDigest(f.contract.targetBaseSchema);
 f.contract.tables=f.contract.sourceSchema.filter(x=>x.type==='table').map(x=>({name:x.name,disposition:x.name==='telemetry_v11_records'?'typed-v11':'authority'}));
 f.contract.finalSchema=[...f.contract.sourceSchema.filter(x=>x.name!=='telemetry_v11_records').map(o=>({...o,sql:o.type==='table'?o.sql.replace(/\b(CREATE TABLE|REFERENCES) ([A-Za-z_][A-Za-z0-9_]*)/g,'$1 "$2"'):o.sql})),...f.contract.targetBaseSchema].sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:1);
 f.contract.finalSchemaDigest=await authoritySchemaDigest(f.contract.finalSchema);
 f.contract.typedCopies=[{runId:'synthetic-copy-v11',sourceNamespace:f.contract.sourceNamespace,sourceSnapshotDigest:f.contract.sourceSnapshotDigest,format:'v11'}];
 f.pin=await authorityRestoreContractDigest(f.contract);return f;
}
describe('isolated authority restore protocol',()=>{
 it('preserves historical authority exactly and installs final guards only after second-pass verification',async()=>{
  const f=await prepared();
  await expect(source().prepare("UPDATE participants SET state='active'").run()).rejects.toThrow('AUTHORITY_SNAPSHOT_FROZEN');
  await expect(target().prepare('SELECT * FROM participants').all()).rejects.toThrow();
  await expect(target().prepare("INSERT INTO _authority_stage_participants VALUES('foreign','active',x'01',NULL)").run()).rejects.toThrow('AUTHORITY_RESTORE_WRITE_DENIED');
  await expect(promoteAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow();
  await drain(f);await sealAuthorityRestore(source(),target(),f.contract,f.pin);
  await expect(completeAuthorityVerification(source(),target(),f.contract,f.pin)).rejects.toThrow('authority_restore_unverified');
  await drain(f,'verify');await completeAuthorityVerification(source(),target(),f.contract,f.pin);await promoteAuthorityRestore(source(),target(),f.contract,f.pin);await finalizeAuthorityRestore(source(),target(),f.contract,f.pin);
  expect(await target().prepare('SELECT count(*) n FROM participants').first('n')).toBe(35);
  expect(await target().prepare("SELECT state,expires_at,hex(secret_hash) digest FROM device_credentials WHERE id='device'").first()).toEqual({state:'revoked',expires_at:'2000-01-01',digest:'FF0002'});
  expect(await target().prepare('SELECT state,consumed_contribution_id FROM device_upload_authorizations').first()).toEqual({state:'consumed',consumed_contribution_id:'retained-contribution'});
  expect(await target().prepare("SELECT note,hex(secret_hash) digest FROM participants WHERE id='synthetic-0'").first()).toEqual({note:null,digest:'0001FF'});
  expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await expect(target().prepare("INSERT INTO participants VALUES('new','deleting',x'01',NULL)").run()).rejects.toThrow('current_admission');
  await expect(target().prepare("UPDATE _authority_restore_run SET phase='copying'").run()).rejects.toThrow('authority_restore_state_conflict');
  expect(await authoritySchemaInventory(target())).toEqual(f.contract.finalSchema);
  await promoteAuthorityRestore(source(),target(),f.contract,f.pin);await finalizeAuthorityRestore(source(),target(),f.contract,f.pin);
 });
 it('acknowledges exact committed pages after response loss and converges concurrent retries',async()=>{
  const f=await prepared();let lose=true;
  const db=wrapped(async <T,>(statements:D1PreparedStatement[])=>{const result=await target().batch<T>(statements);if(lose){lose=false;throw new Error('synthetic response loss');}return result;});
  expect((await copyAuthorityPage(source(),db,f.contract,f.pin)).rows).toBe(32);
  await Promise.all([copyAuthorityPage(source(),target(),f.contract,f.pin),copyAuthorityPage(source(),target(),f.contract,f.pin)]);
  await drain(f);
  expect(await target().prepare('SELECT count(*) n FROM _authority_stage_participants').first('n')).toBe(35);
 });
 it('rolls back a failed page, permission and cursor together before retry',async()=>{
  const f=await prepared();const db=wrapped(statements=>target().batch([...statements,target().prepare('INSERT INTO nonexistent VALUES(1)')]));
  await expect(copyAuthorityPage(source(),db,f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_PAGE_UNACKNOWLEDGED');
  expect(await target().prepare('SELECT count(*) n FROM _authority_stage_participants').first('n')).toBe(0);
  expect(await target().prepare('SELECT count(*) n FROM _authority_restore_permission').first('n')).toBe(0);
  expect(await target().prepare("SELECT copy_cursor FROM _authority_restore_tables WHERE name='participants'").first('copy_cursor')).toBe('[]');
  await drain(f);
 });
 it('refuses absent freeze, dirty target and missing source write fence',async()=>{
  const f=await fixture();await expect(beginAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow();
  await freezeAuthorityRestoreSource(source(),f.contract,f.pin);
  await target().prepare('CREATE TABLE unrelated(id INTEGER)').run();
  await expect(beginAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
  await target().prepare('DROP TABLE unrelated').run();await beginAuthorityRestore(source(),target(),f.contract,f.pin);
  await source().prepare('DROP TRIGGER _authority_freeze_update_participants').run();
  await expect(copyAuthorityPage(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_EVIDENCE_MISMATCH');
  expect(await target().prepare('SELECT count(*) n FROM _authority_stage_participants').first('n')).toBe(0);
 });
 it('rolls back original names and trigger installation when exact final role schema differs',async()=>{
  const f=await fixture(1);f.contract.finalSchema.find(o=>o.name==='participants')!.sql+=' ';
  f.contract.finalSchemaDigest=await authoritySchemaDigest(f.contract.finalSchema);f.pin=await authorityRestoreContractDigest(f.contract);
  await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f);
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f,'verify');await completeAuthorityVerification(source(),target(),f.contract,f.pin);
  await expect(promoteAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_PROMOTION_UNACKNOWLEDGED');
  expect(await target().prepare('SELECT phase FROM _authority_restore_run').first('phase')).toBe('verified');
  expect(await target().prepare("SELECT name FROM sqlite_master WHERE name='participants'").first()).toBeNull();
  expect(await target().prepare('SELECT count(*) n FROM _authority_stage_participants').first('n')).toBe(1);
 });
 it('preserves an empty AUTOINCREMENT table high-water mark without reinserting historical audit rows',async()=>{
  const f=await fixture(1,true);await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f);
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f,'verify');await completeAuthorityVerification(source(),target(),f.contract,f.pin);await promoteAuthorityRestore(source(),target(),f.contract,f.pin);await finalizeAuthorityRestore(source(),target(),f.contract,f.pin);
  await target().prepare("INSERT INTO admin_action_audit(details_json) VALUES('new synthetic')").run();
  expect(await target().prepare('SELECT id FROM admin_action_audit').first('id')).toBe(501);
 });

 it('restores authority with all three typed streams, without a second legacy JSON store',async()=>{
  const f=await rawFixture();await freezeAuthorityRestoreSource(source(),f.contract,f.pin);await beginAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f);
  await expect(sealAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_TYPED_COPY_INCOMPLETE');
  expect((await copyAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).copied).toBe(3);
  expect((await copyAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).reachedEnd).toBe(true);
  await sealAuthorityRestore(source(),target(),f.contract,f.pin);await drain(f,'verify');
  await expect(completeAuthorityVerification(source(),target(),f.contract,f.pin)).rejects.toThrow('authority_restore_unverified');
  expect((await verifyAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).verified).toBe(3);
  expect((await verifyAuthorityTypedPage(source(),target(),f.contract,f.pin,'v11')).reachedEnd).toBe(true);
  await completeAuthorityVerification(source(),target(),f.contract,f.pin);await promoteAuthorityRestore(source(),target(),f.contract,f.pin);await finalizeAuthorityRestore(source(),target(),f.contract,f.pin);
  expect(await target().prepare('SELECT count(*) n FROM typed_telemetry_records').first('n')).toBe(3);
  expect(await target().prepare("SELECT name FROM sqlite_master WHERE name='telemetry_v11_records'").first()).toBeNull();
  expect(await source().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBe(3);
  expect(await target().prepare('SELECT state FROM device_credentials').first('state')).toBe('revoked');
 });
 it('refuses a nonempty typed target even when its schema matches',async()=>{
  const f=await rawFixture();await freezeAuthorityRestoreSource(source(),f.contract,f.pin);
  await target().prepare("INSERT INTO typed_telemetry_dictionary(value) VALUES('foreign')").run();
  await expect(beginAuthorityRestore(source(),target(),f.contract,f.pin)).rejects.toThrow('AUTHORITY_RESTORE_TARGET_NOT_EMPTY');
 });

});
