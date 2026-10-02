import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { sha256Hex } from '../src/crypto';

const b=env as Env & {
  TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
};
const name='0015_effective_selective_dependencies.sql';
const sourceSha256='f13862cca051ff88e4f9e67363b131483311ad085cf4bc8d7c006506c729706a';
const bodySha256='d3e365e19ae62a3d351dda95626cd395bab8b8ebb0055e8cc1a958efdf99a820';

it('exact selective 130-entry native D1 batch rolls back late and ledger failures, then commits once',async()=>{
  await reset();const db=b.USAGE_MONITOR_DB;
  const migration=b.TEST_INGESTION_ISOLATION_MIGRATIONS.find(value=>value.name===name);
  expect(migration).toBeDefined();
  const queries=[...migration!.queries.map(sql=>({sql,params:[] as string[]})),
    {sql:'INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)',params:[name,sourceSha256]}];
  const body=JSON.stringify({batch:queries});
  expect(queries).toHaveLength(130);expect(new TextEncoder().encode(body).byteLength).toBe(273935);
  expect(await sha256Hex(body)).toBe(bodySha256);
  expect(Math.max(...queries.map(query=>new TextEncoder().encode(query.sql).byteLength))).toBe(7253);
  for(const prefix of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
    b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(value=>value.name<'0015_')])await applyD1Migrations(db,prefix);
  await db.prepare('CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT').run();
  await db.prepare('INSERT INTO participants(id,owner_kind,created_at) VALUES(?,?,?)')
    .bind('synthetic-transport-retained','accountless','2026-10-01T00:00:00.000Z').run();
  const snapshot=async()=>({
    schema:(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()).results,
    ledger:(await db.prepare('SELECT name,sha256 FROM d1_storage_migrations ORDER BY name').all()).results,
    retained:(await db.prepare('SELECT id,owner_kind,created_at FROM participants ORDER BY id').all()).results,
  });
  const statements=queries.map(query=>db.prepare(query.sql).bind(...query.params));

  // A duplicate ledger entry fails last, after every migration statement.
  await db.prepare('INSERT INTO d1_storage_migrations(name,sha256) VALUES(?,?)').bind(name,sourceSha256).run();
  const ledgerFailure=await snapshot();
  await expect(db.batch(statements)).rejects.toThrow();expect(await snapshot()).toEqual(ledgerFailure);
  await db.prepare('DELETE FROM d1_storage_migrations WHERE name=?').bind(name).run();

  // This added failure is confined to the disposable test; the candidate
  // transport rejects any payload other than the exact130-entry body above.
  const lateFailure=await snapshot();
  await expect(db.batch([...statements,db.prepare('INSERT INTO synthetic_missing_transport_failure VALUES(1)')])).rejects.toThrow();
  expect(await snapshot()).toEqual(lateFailure);

  expect(await db.batch(statements)).toHaveLength(130);
  expect((await snapshot()).retained).toEqual(lateFailure.retained);
  expect((await snapshot()).ledger).toEqual([{name,sha256:sourceSha256}]);
  expect(await db.prepare('SELECT count(*) n FROM sqlite_schema WHERE name=?')
    .bind('storage_effective_selective_runtime').first<number>('n')).toBe(1);
},60000);
