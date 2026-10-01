import { env, applyD1Migrations, reset } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSingleIngestionShardRouter, createCatalogStorageRouter, createOwnerMoveCoordinator,
  STORAGE_SHARD_OPERATING_CAP_BYTES, type VerifyOwnerCopy } from '../src/storage-routing';
import { prepareTypedTelemetryInsert, readTypedTelemetryPage, type TypedTelemetrySourceRecord } from '../src/typed-telemetry-repository';
import { MAX_STORAGE_APPLICATION_STATEMENTS, MAX_STORAGE_TRANSACTION_STATEMENTS, STORAGE_WRITE_FENCE_STATEMENTS } from '../src/storage-routing-batch-budget';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { STORAGE_ROUTING_FENCE_SCHEMA_SQL, ownerWriteFenceStatement } from '../src/storage-routing-fence';
interface TestBindings extends Env { STORAGE_ROUTING_DB: D1Database; STORAGE_INGESTION_A: D1Database;
  STORAGE_INGESTION_B: D1Database; TEST_ROUTING_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; }
const bindings = () => env as TestBindings;
const catalog = () => bindings().STORAGE_ROUTING_DB;
const source = () => bindings().STORAGE_INGESTION_A;
const destination = () => bindings().STORAGE_INGESTION_B;
const map = () => ({ INGESTION_A: source(), INGESTION_B: destination() });
const router = () => createCatalogStorageRouter({ catalog: catalog(), bindings: map(), clock: () => 1234 });
const HASH = 'a'.repeat(64);
const verifyRows: VerifyOwnerCopy = async ({move, source, destination}) => {
  const sql = 'SELECT source_sequence, tokens FROM synthetic_owner_rows WHERE owner_id = ? ORDER BY source_sequence LIMIT 3';
  const left = await source.prepare(sql).bind(move.owner_id).all();
  const right = await destination.prepare(sql).bind(move.owner_id).all();
  if (JSON.stringify(left.results) !== JSON.stringify(right.results)) throw Error('SYNTHETIC_COPY_INCOMPLETE');
  return HASH;
};
const mover = (verifyDestinationCopy: VerifyOwnerCopy = verifyRows) => createOwnerMoveCoordinator({
  catalog: catalog(), bindings: map(), clock: () => 1234, verifyDestinationCopy });
async function prepareMove() {
  const route = await router().ensureOwner('owner-one', 'a', 100);
  await router().write(route, db => [db.prepare('INSERT INTO synthetic_owner_rows VALUES (?, ?, ?)').bind('owner-one', 91, 42)]);
  await mover().begin('move-one', route, 'b');
  await mover().fenceSource('move-one');
  return route;
}
async function copyRows() {
  await destination().prepare('INSERT INTO synthetic_owner_rows VALUES (?, ?, ?)').bind('owner-one', 91, 42).run();
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(catalog(), bindings().TEST_ROUTING_MIGRATIONS);
  for (const database of [source(), destination()]) {
    // D1 exec splits on newlines; migration helper preserves trigger bodies.
    await applyD1Migrations(database, [{name:'0001_local_fences',queries:[STORAGE_ROUTING_FENCE_SCHEMA_SQL]}]);
    await database.prepare('CREATE TABLE synthetic_owner_rows (owner_id TEXT, source_sequence INTEGER, tokens INTEGER, PRIMARY KEY(owner_id, source_sequence))').run();
  }
  await catalog().batch([
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('a','INGESTION_A','active')"),
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('b','INGESTION_B','active')"),
  ]);
});
function typedChunkRows(): TypedTelemetrySourceRecord[] {
  return Array.from({length:32}, (_, index) => ({
    sourceNamespace:'original-ingestion', format:'v11', sourceRowId:index+1,
    participantId:'owner-one', deviceId:'device-one', chunkRowId:'usage-chunk-one',
    manifestId:'manifest-one', chunkDay:'2026-09-11', observedDay:'2026-09-11',
    record:v11UsageRecord('2026-09-11', 'a', {eventId:`event:v2:${index.toString(16).padStart(64,'0')}`}),
  }));
}
describe('explicit owner storage routing', () => {
  it('async typed preparation writes a complete >64-statement chunk with its journal and fence', async () => {
    await applyD1Migrations(source(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
    const route = await router().ensureOwner('owner-one','a',100);
    const rows = typedChunkRows();
    let count = 0;
    const results = await router().write(route, async db => {
      const prepared = await prepareTypedTelemetryInsert(db, rows);
      count = prepared.statements.length + 1;
      expect(prepared.statements.length).toBeGreaterThan(64);
      return [...prepared.statements, db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',17,32)];
    });
    expect(results).toHaveLength(count);
    expect(results.every(result=>result.success)).toBe(true);
    const copied = await readTypedTelemetryPage(source(), {sourceNamespace:'original-ingestion',format:'v11'});
    expect(copied.records.map(({canonicalRecord:_canonical,legacy:_legacy,...row})=>row)).toEqual(rows);
    expect(await source().prepare('SELECT tokens FROM synthetic_owner_rows WHERE owner_id=?').bind('owner-one').first('tokens')).toBe(32);
    expect(await source().prepare('SELECT count(*) n FROM storage_route_write_checks').first('n')).toBe(0);
  });
  it('a move during async preparation refuses the whole typed chunk and its journal', async () => {
    await applyD1Migrations(source(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
    const route = await router().ensureOwner('owner-one','a',100);
    await expect(router().write(route, async db => {
      const prepared = await prepareTypedTelemetryInsert(db, typedChunkRows());
      expect(prepared.statements.length).toBeGreaterThan(64);
      // A source move after lookup but before batch must invalidate this write.
      await mover().begin('move-during-prepare',route,'b');
      await mover().fenceSource('move-during-prepare');
      return [...prepared.statements, db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',17,32)];
    })).rejects.toMatchObject({code:'ROUTE_STALE'});
    for (const table of ['typed_telemetry_dictionary','typed_telemetry_namespaces','typed_telemetry_records','typed_telemetry_usage','synthetic_owner_rows']) {
      expect(await source().prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
    }
  });
  it('accepts the conservative transaction boundary and refuses overflow before any application writes', async () => {
    const route = await router().ensureOwner('owner-one','a',100);
    expect(MAX_STORAGE_APPLICATION_STATEMENTS+STORAGE_WRITE_FENCE_STATEMENTS).toBe(MAX_STORAGE_TRANSACTION_STATEMENTS);
    const result = await router().write(route, async db => Array.from({length:MAX_STORAGE_APPLICATION_STATEMENTS},()=>db.prepare('SELECT 1')));
    expect(result).toHaveLength(MAX_STORAGE_APPLICATION_STATEMENTS);
    await expect(router().write(route, db => Array.from({length:MAX_STORAGE_APPLICATION_STATEMENTS+1}, (_, index)=>
      db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',index,1))))
      .rejects.toMatchObject({code:'INVALID_ROUTING_INPUT'});
    expect(await source().prepare('SELECT count(*) n FROM synthetic_owner_rows').first('n')).toBe(0);
  });
  it('cannot switch the checked owner by mutating a route during asynchronous preparation', async () => {
    const original = await router().ensureOwner('owner-one','a',100);
    await router().ensureOwner('owner-two','a',100);
    const mutable = {...original};
    await expect(router().write(mutable, async db => {
      await mover().begin('move-mutable-route',original,'b');
      await mover().fenceSource('move-mutable-route');
      mutable.ownerId = 'owner-two';
      return [db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',17,32)];
    })).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await source().prepare('SELECT count(*) n FROM synthetic_owner_rows').first('n')).toBe(0);
  });
  it('async builder failures stay closed and execute no application writes', async () => {
    const route = await router().ensureOwner('owner-one','a',100);
    await expect(router().write(route, async () => { throw Error('private provider detail'); }))
      .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE',message:'STORAGE_UNAVAILABLE'});
    expect(await source().prepare('SELECT count(*) n FROM synthetic_owner_rows').first('n')).toBe(0);
  });
  it('legacy adapter accepts async builders and applies the same application ceiling', async () => {
    const single = createSingleIngestionShardRouter({database:bindings().USAGE_MONITOR_DB});
    const route = await single.resolve('owner-one');
    const results = await single.write(route, async db => [db.prepare('SELECT 7 AS n')]);
    expect(results[0]?.results).toEqual([{n:7}]);
    await expect(single.write(route, async db=>Array.from({length:MAX_STORAGE_APPLICATION_STATEMENTS+1},()=>db.prepare('SELECT 1'))))
      .rejects.toMatchObject({code:'INVALID_ROUTING_INPUT'});
  });
  it('legacy single adapter needs no catalog/fence schema and preserves original writes', async () => {
    const single = createSingleIngestionShardRouter({database: bindings().USAGE_MONITOR_DB});
    const route = await single.resolve('owner-one');
    expect(route).toMatchObject({mode:'single',generation:0,bindingName:'USAGE_MONITOR_DB'});
    await single.write(route, db => [db.prepare('CREATE TABLE legacy_row (value INTEGER)'),db.prepare('INSERT INTO legacy_row VALUES (7)')]);
    expect(await bindings().USAGE_MONITOR_DB.prepare('SELECT value FROM legacy_row').first('value')).toBe(7);
    await expect(single.write({...route,shardId:'other'},db=>[db.prepare('SELECT 1')])).rejects.toMatchObject({code:'ROUTE_STALE'});
  });
  it('new owner repeats preserve one explicit route and one reservation', async () => {
    const first = await router().ensureOwner('owner-one','a',100);
    expect(await router().ensureOwner('owner-one','a',100)).toEqual(first);
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(100);
    await expect(router().ensureOwner('owner-one','b',100)).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await catalog().prepare('SELECT count(*) AS n FROM storage_owner_routes').first('n')).toBe(1);
  });
  it('capacity includes reservations and observed bytes, never redirects to free shard', async () => {
    await catalog().prepare("UPDATE storage_shards SET observed_bytes=? WHERE shard_id='a'").bind(STORAGE_SHARD_OPERATING_CAP_BYTES-100).run();
    await router().ensureOwner('owner-one','a',100);
    await expect(router().ensureOwner('owner-two','a',1)).rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(0);
    expect(await catalog().prepare("SELECT count(*) n FROM storage_owner_routes WHERE owner_id='owner-two'").first('n')).toBe(0);
    await expect(catalog().prepare("UPDATE storage_shards SET capacity_bytes=9000000001 WHERE shard_id='a'").run()).rejects.toThrow();
  });
  it('unknown binding and stale generation refuse before owner mutations', async () => {
    await catalog().prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('unknown','NOT_BOUND','active')").run();
    await expect(router().ensureOwner('owner-one','unknown',1)).rejects.toMatchObject({code:'UNKNOWN_BINDING'});
    const route=await router().ensureOwner('owner-one','a',1);
    await expect(router().write({...route,generation:2},db=>[db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',1,99)])).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await source().prepare('SELECT count(*) n FROM synthetic_owner_rows').first('n')).toBe(0);
  });
  it('capability locator is revocable routing metadata, not a grant', async () => {
    const route=await router().ensureOwner('owner-one','a',1);
    await catalog().prepare("INSERT INTO storage_capability_locators VALUES (?,?,'active')").bind(HASH,'owner-one').run();
    expect(await router().locateCapability(HASH)).toEqual(route);
    await catalog().prepare("UPDATE storage_capability_locators SET state='revoked' WHERE capability_hash=?").bind(HASH).run();
    expect(await router().locateCapability(HASH)).toBeNull();
    await expect(catalog().prepare("UPDATE storage_capability_locators SET state='active' WHERE capability_hash=?").bind(HASH).run()).rejects.toThrow('STORAGE_CAPABILITY_LOCATOR_IMMUTABLE');
    await expect(router().locateCapability('raw-secret')).rejects.toMatchObject({code:'INVALID_ROUTING_INPUT'});
  });
  it('source-local fence rolls back the entire write batch, including an earlier mutation', async () => {
    const stale=await prepareMove();
    await expect(source().batch([
      source().prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',92,999),
      ownerWriteFenceStatement(source(),stale),
    ])).rejects.toThrow('STORAGE_ROUTE_STALE');
    expect(await source().prepare('SELECT count(*) n FROM synthetic_owner_rows').first('n')).toBe(1);
    expect(await source().prepare('SELECT count(*) n FROM storage_route_write_checks').first('n')).toBe(0);
    await expect(source().prepare("UPDATE storage_owner_fences SET state='active' WHERE owner_id='owner-one'").run()).rejects.toThrow('STORAGE_FENCE_TRANSITION_INVALID');
  });
  it('destination is not authoritative until commit, then explicit activation; source sequence unchanged', async () => {
    const stale=await prepareMove();await copyRows();await mover().verifyCopied('move-one');
    await expect(mover().activateDestination('move-one')).rejects.toMatchObject({code:'MOVE_PHASE_INVALID'});
    await expect(router().resolve('owner-one')).rejects.toMatchObject({code:'ROUTE_NOT_ACTIVE'});
    await mover().commit('move-one');
    const pending=await router().resolve('owner-one');expect(pending).toMatchObject({shardId:'b',generation:2});
    await expect(router().write(pending,db=>[db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',92,1)])).rejects.toMatchObject({code:'ROUTE_STALE'});
    // A committed-but-not-activated destination cannot start another move.
    await expect(mover().begin('move-two',pending,'a')).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await mover().activateDestination('move-one')).toEqual(pending);
    expect(await mover().activateDestination('move-one')).toEqual(pending);
    await router().write(pending,db=>[db.prepare('INSERT INTO synthetic_owner_rows VALUES(?,?,?)').bind('owner-one',92,1)]);
    await expect(router().write(stale,db=>[db.prepare('SELECT 1')])).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await destination().prepare('SELECT source_sequence FROM synthetic_owner_rows ORDER BY source_sequence').all()).toMatchObject({results:[{source_sequence:91},{source_sequence:92}]});
    // Retained source storage still consumes capacity after route commit.
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(100);
  });
  it('incomplete copy cannot produce a prepared destination or advance the journal', async () => {
    await prepareMove();await expect(mover().verifyCopied('move-one')).rejects.toMatchObject({code:'COPY_VERIFICATION_REQUIRED'});
    expect(await catalog().prepare("SELECT state FROM storage_owner_moves WHERE move_id='move-one'").first('state')).toBe('source_fenced');
    expect(await destination().prepare('SELECT count(*) n FROM storage_owner_fences').first('n')).toBe(0);
    await copyRows();expect((await mover().verifyCopied('move-one')).state).toBe('copied');
  });
  it('destination activation rechecks durable source fence and exact catalog assignment', async () => {
    await prepareMove();await copyRows();await mover().verifyCopied('move-one');await mover().commit('move-one');
    // Simulate a missing/corrupted source-side proof. No substitute boolean can activate it.
    await source().prepare("DELETE FROM storage_owner_fences WHERE owner_id='owner-one'").run();
    await expect(mover().activateDestination('move-one')).rejects.toMatchObject({code:'ROUTE_STALE'});
    expect(await destination().prepare("SELECT state FROM storage_owner_fences WHERE owner_id='owner-one'").first('state')).toBe('prepared');
  });
  it('catalog loss after source fencing is recoverable without reopening writes', async () => {
    const route=await router().ensureOwner('owner-one','a',1);await mover().begin('move-one',route,'b');
    await source().prepare("UPDATE storage_owner_fences SET state='fenced',move_id='move-one' WHERE owner_id='owner-one'").run();
    // Represents successful source commit followed by failed catalog I/O.
    expect((await mover().fenceSource('move-one')).state).toBe('source_fenced');
    expect((await mover().fenceSource('move-one')).state).toBe('source_fenced');
    await expect(router().write(route,db=>[db.prepare('SELECT 1')])).rejects.toMatchObject({code:'ROUTE_STALE'});
  });
  it('partially initialized owner resumes the original preparing assignment exactly', async () => {
    await catalog().prepare("INSERT INTO storage_owner_routes VALUES('owner-one','a',1,'preparing',100,1)").run();
    await expect(router().resolve('owner-one')).rejects.toMatchObject({code:'ROUTE_NOT_ACTIVE'});
    expect(await router().ensureOwner('owner-one','a',100)).toMatchObject({generation:1,shardId:'a'});
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(100);
  });
});

describe('routing catalog closed transitions', () => {
  it('concurrent new-owner calls do not reserve twice', async () => {
    const [one,two]=await Promise.all([router().ensureOwner('owner-race','a',100),router().ensureOwner('owner-race','a',100)]);
    expect(one).toEqual(two);
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes')).toBe(100);
  });
  it('binding identity, route history and generation cannot be rewritten', async () => {
    await router().ensureOwner('owner-one','a',100);
    await expect(catalog().prepare("UPDATE storage_shards SET binding_name='INGESTION_B' WHERE shard_id='a'").run()).rejects.toThrow();
    await expect(catalog().prepare("UPDATE storage_owner_routes SET route_generation=2 WHERE owner_id='owner-one'").run()).rejects.toThrow('STORAGE_ROUTE_TRANSITION_INVALID');
    await expect(catalog().prepare("DELETE FROM storage_owner_routes WHERE owner_id='owner-one'").run()).rejects.toThrow('STORAGE_ROUTE_HISTORY_REQUIRED');
    await expect(catalog().prepare("UPDATE storage_owner_routes SET state='invented' WHERE owner_id='owner-one'").run()).rejects.toThrow();
  });
  it('draining accepts truthful above-cap measurements but admits no new owners', async () => {
    await catalog().prepare("UPDATE storage_shards SET state='draining',observed_bytes=9000000001 WHERE shard_id='a'").run();
    await expect(router().ensureOwner('owner-one','a',1)).rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
    await expect(catalog().prepare("UPDATE storage_shards SET state='active' WHERE shard_id='a'").run()).rejects.toThrow();
  });
  it('move cannot reserve an over-cap destination or change immutable move identity', async () => {
    const route=await router().ensureOwner('owner-one','a',100);
    await catalog().prepare("UPDATE storage_shards SET observed_bytes=9000000000 WHERE shard_id='b'").run();
    await expect(mover().begin('move-one',route,'b')).rejects.toMatchObject({code:'CAPACITY_UNAVAILABLE'});
    expect(await router().resolve('owner-one')).toEqual(route);
    await catalog().prepare("UPDATE storage_shards SET observed_bytes=0 WHERE shard_id='b'").run();
    const first=await mover().begin('move-one',route,'b');expect(await mover().begin('move-one',route,'b')).toEqual(first);
    await expect(mover().begin('move-one',{...route,ownerId:'other'},'b')).rejects.toMatchObject({code:'MOVE_CONFLICT'});
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first('reserved_bytes')).toBe(100);
  });
  it('verified destination and catalog failure resume without a second copy or generation increment', async () => {
    await prepareMove();await copyRows();
    // A successful copy/fence write whose following catalog write was lost.
    await destination().prepare("INSERT INTO storage_owner_fences VALUES('owner-one','b',2,'prepared','move-one',?)").bind(HASH).run();
    expect((await mover().verifyCopied('move-one')).state).toBe('copied');
    expect((await mover().commit('move-one')).state).toBe('committed');
    expect((await router().resolve('owner-one')).generation).toBe(2);
  });
  it('copy proof is bound to exact move and cannot silently accept a conflicting retained destination', async () => {
    await prepareMove();await copyRows();
    await destination().prepare("INSERT INTO storage_owner_fences VALUES('owner-one','b',2,'prepared','foreign-move',?)").bind(HASH).run();
    await expect(mover().verifyCopied('move-one')).rejects.toMatchObject({code:'COPY_VERIFICATION_REQUIRED'});
    expect(await catalog().prepare("SELECT state FROM storage_owner_moves WHERE move_id='move-one'").first('state')).toBe('source_fenced');
  });
});
