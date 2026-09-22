import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { lstat, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { applyPostgresMigrations } from '../scripts/postgres-migrations.mjs';
import { eraseParticipantWithStore } from '../src/participant-erasure-store.ts';
import { createExperimentalPostgresParticipantErasureStores } from '../src/postgres-participant-erasure-store.ts';
import { registerParticipantErasureTests } from './erasure-fixtures.mjs';
import { registerSyncTests } from './sync-fixtures.mjs';
import { registerQuotaFitTests } from './quota-fit-fixtures.mjs';
import { registerProjectionTests, projectionTables, resetProjectionState } from './projection-fixtures.mjs';
import { registerModelHistoryTests } from './model-history-fixtures.mjs';
import { createExperimentalPostgresTelemetryV1ContributionStore } from '../src/postgres-telemetry-v1-contribution-store.ts';
import { createExperimentalPostgresTelemetryV1ContributionReader } from '../src/postgres-telemetry-v1-contribution-reader.ts';
import { createExperimentalPostgresTelemetryV1Backend } from '../src/postgres-telemetry-v1-backend.ts';
import { buildTelemetryV1ReplayReceipt, resolveTelemetryV1Replay } from '../src/telemetry-v1-contribution-reader.ts';
import { parseTelemetryV1Chunk } from '../src/telemetry-v1.ts';
import { canonicalJson } from '../src/canonical-json.ts';

// This is an explicitly isolated operational schema. It receives the same
// numbered primary/ledger migrations as production; the disposable database
// keeps the qualification lane independent from other PostgreSQL tests.
const schema = 'tibotattle_v1_test';
const ledgerSchema = 'tibotattle_ledger_test';
const database = `tibotattle_pg_test_${randomBytes(12).toString('hex')}`;
const ledgerDatabase = `tibotattle_pg_test_${randomBytes(12).toString('hex')}`;
const tables = ['accountless_upload_owners','admin_action_audit','web_sessions','device_upload_authorizations',
  'device_pairings','device_credentials','telemetry_v11_chunks','telemetry_v1_quota_fit_rows','telemetry_v1_quota_fit_backfill',...projectionTables,'community_model_history_dependencies','community_model_composition_days','telemetry_v1_records','telemetry_v1_chunks','device_upload_authorizations','telemetry_v1_device_consents','telemetry_v1_chunk_admission_windows',
  'input_versions','pending_objects','participants'];
const pid = 'synthetic-participant', did = 'synthetic-device';
const day = '2026-09-01';
const consent = {telemetrySchemaVersion:'telemetry-contribution-v1.0',
  fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
  privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'};
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
let admin, pool, ledgerPool, store, reader, backend, created = false, ledgerCreated = false;

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (!socket || !isAbsolute(socket) || !socket.startsWith('/private/tmp/tibotattle-pg-')) {
    throw new Error('PG_TEST_SOCKET must name an explicitly provisioned temporary PostgreSQL socket directory');
  }
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    throw new Error('PG_TEST_SOCKET must be a canonical owner-only directory');
  }
  const port = Number(process.env.PG_TEST_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PG_TEST_PORT');
  // pg falls back to environment for falsy options. Remove ambient provider
  // configuration inside this isolated test worker before constructing clients.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PG') && !key.startsWith('PG_TEST_')) vi.stubEnv(key, undefined);
  }
  const options = {host:socket, port, user:'postgres', password:'synthetic-local-only', database:'postgres',
    ssl:false, options:'', application_name:'tibotattle-pg-test',
    types:{getTypeParser(oid,format){return oid===1082 ? value=>value : pg.types.getTypeParser(oid,format);}},
    connectionTimeoutMillis:3000, statement_timeout:12000, idleTimeoutMillis:1000, max:6};
  admin = new pg.Pool(options);
  expect(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await admin.query(`CREATE DATABASE "${ledgerDatabase}"`);
  ledgerCreated = true;
  ledgerPool = new pg.Pool({...options, database: ledgerDatabase});
  pool = new pg.Pool({...options, database});
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await ledgerPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
  const primaryMigrations = await applyPostgresMigrations({ role: 'primary', schema, pool });
  const ledgerMigrations = await applyPostgresMigrations({ role: 'ledger', schema: ledgerSchema, pool: ledgerPool });
  expect(primaryMigrations.applied).toBeGreaterThanOrEqual(4);
  expect(ledgerMigrations.applied).toBeGreaterThanOrEqual(3);
  backend = createExperimentalPostgresTelemetryV1Backend(pool, {
    primarySchema: schema,
    ledgerSchema,
  });
  store = backend.contributions;
  reader = backend.reader;
});
afterAll(async () => {
  try {
    await Promise.all([pool?.end(), ledgerPool?.end()]);
    if (ledgerCreated) await admin.query(`DROP DATABASE "${ledgerDatabase}"`);
    if (created) await admin.query(`DROP DATABASE "${database}"`);
  } finally {
    await admin?.end();
    vi.unstubAllEnvs();
  }
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ${schema}.participants, ${schema}.pending_objects CASCADE`);
  await resetProjectionState(pool,schema);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await pool.query(`INSERT INTO ${schema}.participants
    (id,state,owner_kind,consent_version,consented_at,created_at)
    VALUES($1,'active','social',$2,$3,$3)`, [pid, consent.privacyContractVersion, issuedAt]);
  await pool.query(`INSERT INTO ${schema}.web_sessions
    (id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,'personal','active',$5,$6,$5)`,
  [`session-${pid}`, pid, Buffer.alloc(32, 1), Buffer.alloc(32, 2), issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${schema}.device_pairings
    (id,participant_id,issued_by_session_id,secret_hash,consent_version,
      transport_consent_version,state,issued_at,expires_at,claimed_device_id)
    VALUES($1,$2,$3,$4,$5,$6,'consumed',$7,$8,$9)`,
  [`pairing-${did}`, pid, `session-${pid}`, Buffer.alloc(32, 3), consent.privacyContractVersion,
    consent.telemetrySchemaVersion, issuedAt, expiresAt, did]);
  await pool.query(`INSERT INTO ${schema}.device_credentials
    (id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,
      issued_at,expires_at,last_used_at,social_verified_at)
    VALUES($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
  [did, pid, `pairing-${did}`, Buffer.alloc(32, 4), issuedAt, expiresAt]);
  await pool.query(`INSERT INTO ${schema}.telemetry_v1_device_consents
    (participant_id,device_id,telemetry_schema_version,field_dictionary_version,
      privacy_contract_version,consented_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [pid, did, ...Object.values(consent), issuedAt]);
});

async function input({sequence=0, revision=1, supersedes=null, occurrence=randomUUID(), count=1, stream='session',chunkDay=day}={}) {
  const records = Array.from({length:count},(_,i)=> {
    const identity = `${occurrence}-${i}`;
    if (stream==='quota') return {schemaVersion:'quota-observation-v1.0', observationId:identity,
      observedTime:`${chunkDay}T12:00:00.000Z`,provider:'synthetic',planType:'pro',planVariant:'unknown',
      limitId:'synthetic',slot:'primary',usedPercent:20,windowDurationMinutes:300,resetsAt:`${chunkDay}T17:00:00.000Z`};
    if (stream==='usage') return {schemaVersion:'usage-event-v1.0',eventId:identity,eventTime:`${chunkDay}T12:00:00.000Z`,
      sessionUuid:identity,provider:'synthetic',modelId:'synthetic',speedMode:'unknown',apiServiceTier:'unknown',
      surface:'unknown',billingSurface:'unknown',reasoningEffort:'unknown',agentScope:'unknown',outcome:'unknown',
      totalInputContextTokens:null,components:{inputUncachedTokens:1,inputCacheReadTokens:null,inputCacheWriteTokens:null,
        outputTextTokens:2,outputReasoningTokens:null,outputCombinedTokens:null}};
    return {schemaVersion:'session-dimension-v1.0',sessionUuid:identity,firstEventTime:`${chunkDay}T12:00:00.000Z`,
      provider:'synthetic',toolClassCounts:{read:1}};
  });
  const chunk = parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:`${stream}:${chunkDay}:${sequence}`,
    chunkRevision:revision,chunkDigest:digest(records),parserVersion:'synthetic',consent,records});
  const id = `synthetic-${randomUUID()}`;
  return {participantId:pid,deviceId:did,uploadAuthorizationId:`auth-${id}`,chunkId:id,
    objectKey:`synthetic/${id}`,envelopeDigest:digest(id),chunk,supersedes,createdAt:new Date().toISOString()};
}
async function grant(value) {
  const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await pool.query(`INSERT INTO ${schema}.device_upload_authorizations
    (id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
      content_type,state,issued_at,expires_at,consume_lease_expires_at)
    VALUES($1,$2,$3,$4,$5,1024,'application/json','consuming',$6,$7,$8)`,
  [value.uploadAuthorizationId, value.participantId, value.deviceId, Buffer.alloc(32, 5),
    value.envelopeDigest, value.createdAt, expiresAt, leaseExpiresAt]);
  await pool.query(`INSERT INTO ${schema}.pending_objects VALUES($1,$2)`,[value.chunkId,value.objectKey]);
  return {...value, uploadAuthorizationLeaseExpiresAt: leaseExpiresAt};
}
async function rows(table) {
  const canonical = {
    chunks: `SELECT *, r2_key AS object_key, device_upload_authorization_id AS authorization_id
      FROM ${schema}.telemetry_v1_chunks`,
    records: `SELECT id,chunk_row_id AS chunk_id,participant_id,device_id,stream,occurrence_id,
      observed_at,payload_json AS payload,observed_day,provider,model_id,session_uuid,plan_type,
      plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at
      FROM ${schema}.telemetry_v1_records`,
    devices: `SELECT id,participant_id,state,issued_at,expires_at FROM ${schema}.device_credentials`,
    consents: `SELECT participant_id,device_id,telemetry_schema_version AS schema_version,
      field_dictionary_version AS dictionary_version,privacy_contract_version AS privacy_version,
      consented_at FROM ${schema}.telemetry_v1_device_consents`,
    authorizations: `SELECT id,participant_id,issued_by_device_id AS device_id,envelope_digest,state,
      consume_lease_expires_at AS lease_expires_at,expires_at,consumed_contribution_id,consumed_at
      FROM ${schema}.device_upload_authorizations`,
    admission_windows: `SELECT participant_id,device_id,window_day,accepted_count,last_accepted_at
      FROM ${schema}.telemetry_v1_chunk_admission_windows`,
  }[table];
  return (await pool.query(canonical ?? `SELECT * FROM ${schema}.${table}`)).rows;
}
async function snapshot() {
  const result={};
  for (const table of tables) result[table]=(await rows(table)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}

// Hold the shared admission row until both real client transactions are waiting.
async function race(a,b) {
  const blocker=await pool.connect();let outcomes;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM ${schema}.participants WHERE id=$1 FOR UPDATE`,[pid]);
    outcomes=Promise.allSettled([store.insert(a),store.insert(b)]);
    let waiting=0;
    for(let attempt=0;attempt<80;attempt++) {
      waiting=(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE 'SELECT accepted_records%' AND wait_event_type='Lock'`)).rowCount;
      if(waiting===2) break;
      await pool.query('SELECT pg_sleep(0.025)');
    }
    expect(waiting).toBe(2);
    await blocker.query('ROLLBACK');
    return await outcomes;
  } finally {await blocker.query('ROLLBACK');blocker.release();await outcomes;}
}

it.each(['usage','quota','session'])('commits %s records, authorization, admission and projection effects atomically',async stream=> {
  const value = await grant(await input({stream,count:3}));
  await expect(store.insert(value)).resolves.toEqual({acceptedRecords:3});
  expect(await rows('chunks')).toHaveLength(1);
  expect((await rows('records')).map(r=>r.payload).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))))
    .toEqual([...value.chunk.records].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))));
  expect((await rows('authorizations'))[0]).toMatchObject({state:'consumed',lease_expires_at:null,consumed_contribution_id:value.chunkId});
  expect((await rows('admission_windows'))[0].accepted_count).toBe(1);
  expect((await rows('input_versions'))[0].revision).toBe('1');
  expect((await rows('current_queue'))[0]).toMatchObject({participant_id:pid,dirty_generation:'1',pending:true});
  expect((await rows('daily_rebuilds'))[0]).toMatchObject({day,requested_epoch:'1'});
  expect(await rows('pending_objects')).toHaveLength(1);
});
it('inserts a maximum-size chunk in one bulk record operation',async()=> {
  const value=await grant(await input({count:200}));
  expect(await store.insert(value)).toEqual({acceptedRecords:200});
  expect(await rows('records')).toHaveLength(200);
});
it('corrects exactly the predecessor and increments analytical revision twice',async()=> {
  const first=await grant(await input({occurrence:'synthetic-occurrence'})); await store.insert(first);
  const second=await grant(await input({occurrence:'synthetic-occurrence',revision:2,supersedes:{id:first.chunkId}}));
  await store.insert(second);
  expect((await rows('chunks')).filter(r=>r.superseded_at===null).map(r=>r.id)).toEqual([second.chunkId]);
  expect((await rows('records')).map(r=>r.chunk_id)).toEqual([second.chunkId]);
  expect((await rows('input_versions'))[0].revision).toBe('3');
  expect((await rows('admission_windows'))[0].accepted_count).toBe(2);
  expect(await rows('pending_objects')).toHaveLength(2);
});
it('rolls back correction, records, admission, authorization and journal on ownership conflict',async()=> {
  const first=await grant(await input({occurrence:'original-occurrence'})); await store.insert(first);
  const other=await grant(await input({sequence:1,occurrence:'occupied-occurrence'})); await store.insert(other);
  const replacement=await grant(await input({revision:2,supersedes:{id:first.chunkId},occurrence:'occupied-occurrence'}));
  const before=await snapshot();
  await expect(store.insert(replacement)).rejects.toMatchObject({code:'RECORD_OWNED_BY_OTHER_CHUNK'});
  expect(await snapshot()).toEqual(before);
});
it('refuses replay after commit without counting twice',async()=> {
  const value=await grant(await input()); await store.insert(value);
  const before=await snapshot();
  await expect(store.insert(value)).rejects.toMatchObject({code:'UPLOAD_AUTH_INVALID'});
  expect(await snapshot()).toEqual(before);
});
it('refuses an unrelated predecessor before deleting records',async()=> {
  const first=await grant(await input()); await store.insert(first);
  const wrong=await grant(await input({sequence:1,revision:2,supersedes:{id:first.chunkId}}));
  const before=await snapshot();
  await expect(store.insert(wrong)).rejects.toMatchObject({code:'CHUNK_REVISION_CONFLICT'});
  expect(await snapshot()).toEqual(before);
});
it.each([
  ['participant deletion',`UPDATE ${schema}.participants SET state='deleting'`,'PARTICIPANT_DELETING'],
  ['accountless owner',`UPDATE ${schema}.participants SET owner_kind='accountless'`,'TELEMETRY_TRANSPORT_BLOCKED'],
  ['transport floor',`UPDATE ${schema}.telemetry_transport_participant_floors SET minimum_rank=11`,'TELEMETRY_TRANSPORT_BLOCKED'],
  ['revoked device',`UPDATE ${schema}.device_credentials SET state='revoked'`,'UPLOAD_AUTH_INVALID'],
  ['expired device',`UPDATE ${schema}.device_credentials SET expires_at=clock_timestamp()-interval '1 second'`,'UPLOAD_AUTH_INVALID'],
  ['revoked upload',`UPDATE ${schema}.device_upload_authorizations SET state='revoked'`,'UPLOAD_AUTH_INVALID'],
  ['expired lease',`UPDATE ${schema}.device_upload_authorizations SET consume_lease_expires_at=clock_timestamp()-interval '1 second'`,'UPLOAD_AUTH_INVALID'],
  ['expired upload',`UPDATE ${schema}.device_upload_authorizations SET expires_at=clock_timestamp()-interval '1 second'`,'UPLOAD_AUTH_INVALID'],
  ['wrong digest',`UPDATE ${schema}.device_upload_authorizations SET envelope_digest='${'f'.repeat(64)}'`,'UPLOAD_AUTH_INVALID'],
  ['consent drift',`UPDATE ${schema}.telemetry_v1_device_consents SET field_dictionary_version='stale'`,'TELEMETRY_CONSENT_INVALID'],
])('refuses %s without any partial state',async(_label,sql,code)=> {
  const value=await grant(await input()); await pool.query(sql); const before=await snapshot();
  await expect(store.insert(value)).rejects.toMatchObject({code}); expect(await snapshot()).toEqual(before);
});
it.each([1999,19999])('does not overshoot the admission budget under concurrent clients at %s',async prior=> {
  if(prior===19999) await pool.query(`UPDATE ${schema}.device_credentials SET issued_at=clock_timestamp()`);
  const a=await grant(await input()),b=await grant(await input({sequence:1}));
  await pool.query(`INSERT INTO ${schema}.telemetry_v1_chunk_admission_windows
    (participant_id,device_id,window_day,accepted_count,last_accepted_at)
    VALUES($1,$2,$3,$4,clock_timestamp())`,[pid,did,a.createdAt.slice(0,10),prior]);
  const outcomes=await race(a,b);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.find(r=>r.status==='rejected').reason.code).toBe('CHUNK_ADMISSION_LIMIT_REACHED');
  expect((await rows('admission_windows'))[0].accepted_count).toBe(prior+1);
  expect(await rows('chunks')).toHaveLength(1);
});
it('allows one winner when two clients claim the same identity',async()=> {
  const a=await grant(await input()), b=await grant(await input());
  const outcomes=await race(a,b);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.find(r=>r.status==='rejected').reason.code).toBe('CHUNK_REVISION_CONFLICT');
  expect((await rows('admission_windows'))[0].accepted_count).toBe(1);
});
it('allows one consumption of a shared authorization',async()=> {
  const a=await grant(await input()), b=await input({sequence:1});
  b.uploadAuthorizationId=a.uploadAuthorizationId; b.envelopeDigest=a.envelopeDigest;
  const outcomes=await race(a,b);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.find(r=>r.status==='rejected').reason.code).toBe('UPLOAD_AUTH_INVALID');
  expect(await rows('chunks')).toHaveLength(1);
});
it('reconciles a real commit whose acknowledgement is lost, with no automatic retry',async()=> {
  let commits=0,discarded=false;
  const uncertain=createExperimentalPostgresTelemetryV1ContributionStore({async connect(){
    const client=await pool.connect();return {async query(sql,values){
      const result=await client.query(sql,values);
      if(sql==='COMMIT'){commits++;throw new Error('synthetic lost acknowledgement');} return result;
    },release(discard){discarded=discard;client.release(discard);}};
  }});
  const value=await grant(await input());
  await expect(uncertain.insert(value)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(commits).toBe(1);expect(discarded).toBe(true);
  const retained=await reader.byEnvelope(pid,value.envelopeDigest);
  expect(await buildTelemetryV1ReplayReceipt(reader,retained,did)).toEqual({
    schemaVersion:'telemetry-chunk-receipt-v1.0',contributionId:value.chunkId,chunkId:value.chunk.chunkId,
    chunkRevision:1,status:'accepted',replayed:true,recordCounts:{declared:1,accepted:1},acknowledgedThroughDay:day,
  });
  expect((await rows('chunks'))[0]).toMatchObject({id:value.chunkId,envelope_digest:value.envelopeDigest,object_key:value.objectKey});
  expect((await rows('records'))[0].payload).toEqual(value.chunk.records[0]);
  const before=await snapshot();await expect(store.insert(value)).rejects.toMatchObject({code:'UPLOAD_AUTH_INVALID'});
  expect(await snapshot()).toEqual(before);
});
it('rolls back a real transaction if its connection is lost before commit',async()=> {
  const broken=createExperimentalPostgresTelemetryV1ContributionStore({async connect(){
    const client=await pool.connect();return {async query(sql,values){
      const result=await client.query(sql,values);
      if(sql.startsWith('SELECT accepted_records')) {await client.end();throw new Error('synthetic disconnect');}
      return result;
    },release(discard){client.release(discard);}};
  }});
  const value=await grant(await input()),before=await snapshot();
  await expect(broken.insert(value)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await snapshot()).toEqual(before);
});
it('checks authorization expiry after waiting for a participant lock',async()=> {
  const value=await grant(await input());
  await pool.query(`UPDATE ${schema}.authorizations SET lease_expires_at=clock_timestamp()+interval '1 second'`);
  const before=await snapshot(), blocker=await pool.connect();
  let outcome;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM ${schema}.participants WHERE id=$1 FOR UPDATE`,[pid]);
    outcome=store.insert(value).then(receipt=>({receipt}),error=>({error}));
    let waiting=false;
    for(let attempt=0;attempt<40;attempt++) {
      const result=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query LIKE 'SELECT accepted_records%' AND wait_event_type='Lock'`);
      if(result.rowCount>0){waiting=true;break;}
      await pool.query('SELECT pg_sleep(0.025)');
    }
    expect(waiting).toBe(true);
    await blocker.query('SELECT pg_sleep(1.1)');
    await blocker.query('ROLLBACK');
    expect((await outcome).error).toMatchObject({code:'UPLOAD_AUTH_INVALID'});
    expect(await snapshot()).toEqual(before);
  } finally {
    await blocker.query('ROLLBACK');blocker.release();await outcome;
  }
});
it('bounds lock contention and leaves no partial state',async()=> {
  const value=await grant(await input()),before=await snapshot(),blocker=await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT id FROM ${schema}.participants WHERE id=$1 FOR UPDATE`,[pid]);
    await expect(store.insert(value)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
    expect(await snapshot()).toEqual(before);
  } finally {await blocker.query('ROLLBACK');blocker.release();}
});

it('replays historical envelopes and selects only the current exact identity',async()=> {
  expect(await reader.byEnvelope(pid,'synthetic-missing')).toBeNull();
  expect(await reader.acknowledgedThroughDay(pid,did)).toBeNull();
  const first=await grant(await input());await store.insert(first);
  const second=await grant(await input({revision:2,supersedes:{id:first.chunkId}}));await store.insert(second);
  const historical=await reader.byEnvelope(pid,first.envelopeDigest);
  expect(await buildTelemetryV1ReplayReceipt(reader,historical,did)).toMatchObject({
    contributionId:first.chunkId,chunkRevision:1,status:'superseded',replayed:true,acknowledgedThroughDay:day,
  });
  const identity={participantId:pid,deviceId:did,stream:first.chunk.stream,chunkDay:day,chunkSeq:0};
  expect((await reader.current(identity)).id).toBe(second.chunkId);
  // A later correction must not hide the committed envelope during recovery.
  expect((await resolveTelemetryV1Replay(reader,first.envelopeDigest,identity,first.chunk.chunkDigest)).id).toBe(first.chunkId);
  expect(await resolveTelemetryV1Replay(reader,'synthetic-missing',identity,'different-digest')).toBeNull();
  expect((await resolveTelemetryV1Replay(reader,'synthetic-missing',identity,second.chunk.chunkDigest)).id).toBe(second.chunkId);
  expect(await reader.current({...identity,chunkSeq:1})).toBeNull();
  expect(await reader.current({...identity,stream:'quota'})).toBeNull();
  expect(await reader.current({...identity,deviceId:'synthetic-other-device'})).toBeNull();
  expect(await reader.current({...identity,participantId:'synthetic-other-owner'})).toBeNull();
  expect(await reader.byEnvelope('synthetic-other-owner',first.envelopeDigest)).toBeNull();
  expect(await reader.acknowledgedThroughDay(pid,'synthetic-other-device')).toBeNull();
  expect(await reader.acknowledgedThroughDay('synthetic-other-owner',did)).toBeNull();
});
it('does not convert a failed PostgreSQL replay lookup into absence',async()=> {
  const broken=createExperimentalPostgresTelemetryV1ContributionReader({async connect(){
    const client=await pool.connect();return {async query(sql,values){
      if(sql.startsWith('SELECT')) {await client.end();throw new Error('synthetic disconnect');}
      return client.query(sql,values);
    },release(discard){client.release(discard);}};
  }});
  const value=await grant(await input());await store.insert(value);const before=await snapshot();
  await expect(broken.byEnvelope(pid,value.envelopeDigest)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await snapshot()).toEqual(before);
  expect((await reader.byEnvelope(pid,value.envelopeDigest)).id).toBe(value.chunkId);
});

it('builds replay counts from stored acceptance and acknowledges the requesting device',async()=> {
  const value=await grant(await input({count:2}));await store.insert(value);
  await pool.query(`UPDATE ${schema}.telemetry_v1_chunks SET accepted_record_count=1 WHERE id=$1`,[value.chunkId]);
  const retained=await reader.byEnvelope(pid,value.envelopeDigest);
  expect(await buildTelemetryV1ReplayReceipt(reader,retained,'synthetic-other-device')).toMatchObject({
    status:'accepted',recordCounts:{declared:2,accepted:1},acknowledgedThroughDay:null,
  });
});

registerModelHistoryTests({pool:()=>pool,store:()=>store,input,grant,rows,snapshot,schema,pid,did});

it('acknowledges the maximum current day without inferring contiguous coverage',async()=> {
  const first=await grant(await input());await store.insert(first);
  const later=await grant(await input({chunkDay:'2026-09-03'}));await store.insert(later);
  expect(await reader.acknowledgedThroughDay(pid,did)).toBe('2026-09-03');
});

registerProjectionTests({pool:()=>pool,store:()=>store,input,grant,rows,snapshot,schema,pid,did});

registerSyncTests({syncStore:()=>backend.sync,contributionStore:()=>store,input,grant,pid,did});
registerQuotaFitTests({pool:()=>pool,rows,schema,pid,did});

registerParticipantErasureTests({primaryPool:()=>pool,ledgerPool:()=>ledgerPool,schema});

it('erases actual accepted v1 data and preserves the independent ledger across a primary restore',async()=>{
  const value=await grant(await input());await store.insert(value);
  const retainedTables=['participants','devices','consents','authorizations','chunks','records','pending_objects'];
  const retained={};
  for(const table of retainedTables) retained[table]=await rows(table);
  const adapters=createExperimentalPostgresParticipantErasureStores(pool,ledgerPool,{primarySchema:schema});
  const deleted=[];
  const dependencies={...adapters,objects:{async deleteBatch(refs){deleted.push(...refs.map(ref=>ref.key));}},
    hooks:{async revokeAccountlessEnrollment(){},async assertIdentityConfiguration(){},async recordIdentityCooldown(){}}};
  const now=Date.now();
  expect(await eraseParticipantWithStore(dependencies,pid,randomUUID(),now)).toMatchObject({deleted:true,contributionsDeleted:1});
  for(const table of retainedTables) expect(await rows(table)).toEqual([]);
  expect(await adapters.ledger.hasTombstone(pid,now)).toBe(true);
  expect(deleted).toEqual([value.objectKey]);
  expect(await eraseParticipantWithStore(dependencies,pid,randomUUID(),now)).toEqual({deleted:true,alreadyDeleted:true,contributionsDeleted:null});
  // Rehearse restoration of primary source rows only. The external ledger
  // deliberately remains intact and is consulted before repeating erasure.
  for(const table of retainedTables) {
    await pool.query(`INSERT INTO ${schema}.${table} SELECT * FROM jsonb_populate_recordset(NULL::${schema}.${table},$1::jsonb)`,[JSON.stringify(retained[table])]);
  }
  expect(await adapters.ledger.hasTombstone(pid,now)).toBe(true);
  expect(await reader.byEnvelope(pid,value.envelopeDigest)).not.toBeNull();
  expect(await eraseParticipantWithStore(dependencies,pid,randomUUID(),now+1000)).toMatchObject({deleted:true,contributionsDeleted:1});
  for(const table of retainedTables) expect(await rows(table)).toEqual([]);
  expect(await adapters.ledger.hasTombstone(pid,now+1000)).toBe(true);
});

it('rolls back failed erasure finalization and retries from the durable ledger and source rows',async()=>{
  const value=await grant(await input());await store.insert(value);
  const adapters=createExperimentalPostgresParticipantErasureStores(pool,ledgerPool);
  const dependencies={...adapters,objects:{async deleteBatch(){}},
    hooks:{async revokeAccountlessEnrollment(){},async assertIdentityConfiguration(){},async recordIdentityCooldown(){}}};
  await pool.query(`CREATE FUNCTION ${schema}.synthetic_erasure_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic provider failure'; END; $$;
    CREATE TRIGGER synthetic_erasure_failure BEFORE DELETE ON ${schema}.participants
    FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_erasure_failure()`);
  try {
    await expect(eraseParticipantWithStore(dependencies,pid,randomUUID())).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
    expect((await rows('participants'))[0].state).toBe('deleting');
    expect(await rows('records')).toHaveLength(1);
    expect(await rows('chunks')).toHaveLength(1);
    expect(await rows('pending_objects')).toHaveLength(1);
    expect(await adapters.ledger.hasTombstone(pid,Date.now())).toBe(true);
  } finally {
    await pool.query(`DROP TRIGGER synthetic_erasure_failure ON ${schema}.participants; DROP FUNCTION ${schema}.synthetic_erasure_failure()`);
  }
  expect(await eraseParticipantWithStore(dependencies,pid,randomUUID())).toMatchObject({deleted:true,contributionsDeleted:1});
  expect(await rows('participants')).toEqual([]);
  expect(await rows('records')).toEqual([]);
});

it('bounds PostgreSQL erasure reads while a primary table is locked',async()=>{
  const blocker=await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${schema}.participants IN ACCESS EXCLUSIVE MODE`);
    const adapters=createExperimentalPostgresParticipantErasureStores(pool,ledgerPool,
      {statementTimeoutMilliseconds:100,lockTimeoutMilliseconds:50});
    await expect(adapters.primary.readParticipant(pid)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  } finally {await blocker.query('ROLLBACK');blocker.release();}
});
