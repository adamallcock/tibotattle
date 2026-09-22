import { env,reset,applyD1Migrations,type D1Migration } from 'cloudflare:test';
import { beforeEach,describe,expect,it } from 'vitest';
import { createV11DeviceFixture } from './helpers/telemetry-v11';
import { eraseParticipantAsOwner } from '../src/participant-erasure';
import { initializeStorageSource,readIngestionChanges } from '../src/analytics-delivery';
import { bootstrapLegacyStorageOwner,advanceLegacyStorageAcknowledgement } from '../src/legacy-storage-journal';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const db=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,id='synthetic-legacy-source';
const changes=()=>readIngestionChanges(db(),id,0);
beforeEach(async()=>{
 await reset();await applyD1Migrations(db(),b.TEST_MIGRATIONS);
 await applyD1Migrations(db(),b.TEST_TYPED_INGESTION_MIGRATIONS.filter(x=>x.name.startsWith('0002_')));
 await applyD1Migrations(db(),b.TEST_INGESTION_BRIDGE_MIGRATIONS);
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS.filter(x=>x.name.startsWith('0001_')||x.name.startsWith('0009_')));
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await initializeStorageSource(db(),id);
 await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v0.2'").run();
});
async function insert(owner:Awaited<ReturnType<typeof createV11DeviceFixture>>,ordinal=1,records=1,occurrencePrefix='quota:synthetic-shared'){
 const contribution=`contribution:${crypto.randomUUID()}`,upload=`upload:${crypto.randomUUID()}`;
 const digest=ordinal.toString(16).padStart(64,'0'),now=new Date().toISOString(),future=new Date(Date.now()+86400000).toISOString();
 const statements=[
 db().prepare("INSERT INTO upload_authorizations(id,participant_id,issued_by_session_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at) VALUES(?,?,?,?,?,1,'application/json','consuming',?,?,?)").bind(upload,owner.participantId,owner.sessionId,new Uint8Array(32).buffer,digest,now,future,future),
 db().prepare("INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,schema_version,range_start,range_end,client_platform,provider_policy_epoch,estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at,upload_authorization_id,transport_schema_version,dataset_id,dataset_part_index,dataset_part_count,dataset_completeness,dataset_range_start,dataset_range_end) VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1',?,?,'macos','synthetic',NULL,100,0,0,'server_repricing',?,?,?,'telemetry-contribution-v0.2',?,1,1,'complete',?,?)").bind(contribution,owner.participantId,digest,digest,`synthetic/${contribution}`,now,now,records,now,upload,`dataset:v1:${digest}`,now,now),
 db().prepare("INSERT OR IGNORE INTO telemetry_records(origin_contribution_id,participant_id,record_kind,occurrence_id,observed_at,provider,used_percent,record_json) VALUES(?,?,'quota',?,?,'openai_codex',0.30000000000000004,?)").bind(contribution,owner.participantId,occurrencePrefix,now,'{"synthetic":true,"value":0.30000000000000004}'),
 db().prepare("INSERT INTO telemetry_contribution_occurrences(contribution_id,participant_id,record_kind,occurrence_id,dataset_id,account_track_id,policy_epoch) VALUES(?,?,'quota',?,?,'unattributed','synthetic')").bind(contribution,owner.participantId,occurrencePrefix,`dataset:v1:${digest}`),
 ];
 for(let n=1;n<records;n++){
  const occurrence=`${occurrencePrefix}-${n}`;
  statements.push(db().prepare("INSERT OR IGNORE INTO telemetry_records(origin_contribution_id,participant_id,record_kind,occurrence_id,observed_at,provider,used_percent,record_json) VALUES(?,?,'quota',?,?,'openai_codex',0.30000000000000004,?)").bind(contribution,owner.participantId,occurrence,now,'{"synthetic":true,"value":0.30000000000000004}'));
  statements.push(db().prepare("INSERT INTO telemetry_contribution_occurrences(contribution_id,participant_id,record_kind,occurrence_id,dataset_id,account_track_id,policy_epoch) VALUES(?,?,'quota',?,?,'unattributed','synthetic')").bind(contribution,owner.participantId,occurrence,`dataset:v1:${digest}`));
 }
 await db().batch(statements);return contribution;
}
async function drain(){for(let n=0;n<100;n++){const r=await advanceLegacyStorageAcknowledgement({source:db(),target:target(),sourceId:id});if(r.state==='idle')return;}throw new Error('bounded synthetic drain exceeded');}
describe('legacy fit-only authority bridge',()=>{
 it('keeps ordinary distinct appends visible while overlap and corrections hard-fence immediately',async()=>{
  const owner=await createV11DeviceFixture(db());const first=await insert(owner,1,1,'quota:synthetic-first');
  await db().prepare('UPDATE telemetry_contributions SET accepted_record_count=1,server_cost_nanousd=0 WHERE id=?').bind(first).run();await drain();
  const authority=await db().prepare('SELECT authority_epoch FROM storage_source_state').first<number>('authority_epoch');
  const hard=await db().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first<number>('graph_invalidation_epoch');
  const second=await insert(owner,2,1,'quota:synthetic-second');
  expect((await changes()).at(-1)?.kind).toBe('source-updated');
  await db().prepare('UPDATE telemetry_contributions SET accepted_record_count=1,server_cost_nanousd=0 WHERE id=?').bind(second).run();
  expect((await changes()).at(-1)?.kind).toBe('source-updated');
  expect(await db().prepare('SELECT authority_epoch FROM storage_source_state').first('authority_epoch')).toBe(authority);
  expect(await db().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first('graph_invalidation_epoch')).toBe(hard);await drain();
  // New dataset with an old occurrence is a winner/attribution change. The
  // membership INSERT hard-fences in the same admission batch, without outbox
  // growth per record or waiting for the later accounting UPDATE.
  await insert(owner,3,1,'quota:synthetic-first');
  expect(await db().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first<number>('graph_invalidation_epoch')).toBeGreaterThan(hard!);
  const before=(await changes()).length;
  await db().prepare("UPDATE telemetry_contributions SET dataset_completeness='partial' WHERE id=?").bind(second).run();
  expect((await changes()).at(-1)?.kind).toBe('owner-active');expect((await changes()).length).toBe(before+1);
  expect(await db().prepare('SELECT authority_epoch FROM storage_source_state').first<number>('authority_epoch')).toBeGreaterThan(authority!);await drain();
 });

 it('keeps deduplicated records and dataset memberships, acknowledges no fabricated daily values',async()=>{
  const owner=await createV11DeviceFixture(db());await insert(owner);await insert(owner,2);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_records').first('n')).toBe(1);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_contribution_occurrences').first('n')).toBe(2);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_analytical_records').first('n')).toBe(0);
  expect(await bootstrapLegacyStorageOwner(db(),owner.participantId)).toBe('eligible-legacy');
  const count=(await changes()).length;await bootstrapLegacyStorageOwner(db(),owner.participantId);
  expect(await changes()).toHaveLength(count);await drain();
  expect(await target().prepare('SELECT count(*) n FROM analytics_legacy_authority_receipts').first('n')).toBe(count);
  expect(await target().prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'analytics_legacy_%values%'").first('n')).toBe(0);
  expect(await target().prepare('SELECT sequence FROM analytics_source_cursors').first('sequence')).toBe(count);
 });
 it('separately invalidates final accounting after a response lost between the two original writes',async()=>{
  const owner=await createV11DeviceFixture(db()),contribution=await insert(owner);await drain();
  const before=(await changes()).length;
  expect(await db().prepare('SELECT accepted_record_count FROM telemetry_contributions WHERE id=?').bind(contribution).first('accepted_record_count')).toBeNull();
  await db().prepare('UPDATE telemetry_contributions SET accepted_record_count=1,server_cost_nanousd=0 WHERE id=?').bind(contribution).run();
  expect((await changes()).length).toBe(before+1);await drain();
  await db().prepare('UPDATE telemetry_contributions SET accepted_record_count=1,server_cost_nanousd=0 WHERE id=?').bind(contribution).run();
  expect((await changes()).length).toBe(before+1);
  const prior=(await changes()).length;
  const inputBefore=await db().prepare('SELECT revision FROM community_analytical_input_versions WHERE participant_id=?').bind(owner.participantId).first<number>('revision');
  const hardBefore=await db().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first<number>('graph_invalidation_epoch');
  await db().prepare("UPDATE telemetry_contribution_occurrences SET policy_epoch='synthetic-corrected'").run();
  await db().prepare('UPDATE telemetry_records SET server_cost_nanousd=7').run();
  expect((await changes()).length).toBe(prior);
  expect(await db().prepare('SELECT revision FROM community_analytical_input_versions WHERE participant_id=?').bind(owner.participantId).first<number>('revision')).toBeGreaterThan(inputBefore!);
  expect(await db().prepare('SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control').first<number>('graph_invalidation_epoch')).toBeGreaterThan(hardBefore!);await drain();
 });
 it('keeps journal growth constant for a 200-record admission while preserving every occurrence',async()=>{
  const owner=await createV11DeviceFixture(db()),contribution=await insert(owner,1,200);
  expect(await changes()).toHaveLength(1);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_records').first('n')).toBe(200);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_contribution_occurrences').first('n')).toBe(200);
  await db().prepare('UPDATE telemetry_contributions SET accepted_record_count=200,server_cost_nanousd=0 WHERE id=?').bind(contribution).run();
  expect(await changes()).toHaveLength(2);await drain();
 });
 it('rolls back the full original admission transaction when its source journal fails',async()=>{
  const owner=await createV11DeviceFixture(db());
  await db().prepare("CREATE TRIGGER synthetic_legacy_failure BEFORE INSERT ON storage_ingestion_changes BEGIN SELECT RAISE(ABORT,'synthetic_legacy_failure'); END").run();
  await expect(insert(owner)).rejects.toThrow('synthetic_legacy_failure');
  for(const table of ['telemetry_contributions','telemetry_records','telemetry_contribution_occurrences','storage_v11_owner_links','storage_legacy_event_sources'])
   expect(await db().prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
 });
 it('preserves exact delivery after response loss and refuses forged or absent source metadata',async()=>{
  const owner=await createV11DeviceFixture(db());await insert(owner);
  const original=target(),wrapper=new Proxy(original,{get(o,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await o.batch(statements);throw new Error('synthetic response loss');};const value=Reflect.get(o,key);return typeof value==='function'?value.bind(o):value;}});
  expect((await advanceLegacyStorageAcknowledgement({source:db(),target:wrapper,sourceId:id})).state).toBe('applied');
  expect(await target().prepare('SELECT count(*) n FROM analytics_applied_events').first('n')).toBe(1);
  await expect(db().prepare('UPDATE storage_legacy_event_sources SET input_revision=input_revision+1').run()).rejects.toThrow('storage_legacy_event_immutable');
  await expect(db().prepare('DELETE FROM storage_legacy_event_sources').run()).rejects.toThrow('storage_legacy_terminal_required');
 });
 it('acknowledges delayed legacy events after exact owner erasure without retaining raw identities in analytics',async()=>{
  const owner=await createV11DeviceFixture(db());await insert(owner);
  await expect(eraseParticipantAsOwner({...b,ENVIRONMENT:'synthetic-development'},'e'.repeat(64),owner.participantId)).resolves.toMatchObject({deleted:true});
  expect((await changes()).at(-1)?.kind).toBe('owner-erased');
  expect(await db().prepare('SELECT count(*) n FROM storage_legacy_event_sources').first('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM telemetry_records').first('n')).toBe(0);
  expect((await advanceLegacyStorageAcknowledgement({source:db(),target:target(),sourceId:id})).state).toBe('discarded');
  const receipt=await target().prepare('SELECT * FROM analytics_legacy_authority_receipts').first();
  expect(receipt?.disposition).toBe('owner-erased');
  expect(JSON.stringify(receipt)).not.toContain(owner.participantId);
 });
 it('uses original owner withdrawal proof for delayed legacy acknowledgements',async()=>{
  const owner=await createV11DeviceFixture(db());await insert(owner);
  await db().prepare("UPDATE participants SET state='deleting',deletion_session_id='synthetic-deleting' WHERE id=?").bind(owner.participantId).run();
  expect((await changes()).at(-1)?.kind).toBe('owner-withdrawn');
  expect((await advanceLegacyStorageAcknowledgement({source:db(),target:target(),sourceId:id})).state).toBe('discarded');
  expect(await target().prepare('SELECT disposition FROM analytics_legacy_authority_receipts').first('disposition')).toBe('owner-withdrawn');
  expect(await bootstrapLegacyStorageOwner(db(),owner.participantId)).toBe('ineligible');
 });
});
