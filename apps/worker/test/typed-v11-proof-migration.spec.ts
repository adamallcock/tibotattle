import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
const b=env as Env&{STORAGE_INGESTION_A:D1Database;TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[]};
beforeEach(async()=>{await reset();});
describe('compact proof forward migration',()=>{
 it('refuses any retained old proof before destructive schema work and preserves its bytes',async()=>{
  const db=b.STORAGE_INGESTION_A;
  // The first migration gate only counts prior proofs; use a minimal legacy
  // fixture so an accidentally removed guard would proceed to destructive DROP.
  await db.prepare('CREATE TABLE typed_v11_record_admissions(typed_record_id INTEGER PRIMARY KEY,base_digest BLOB NOT NULL)').run();
  await db.prepare('INSERT INTO typed_v11_record_admissions VALUES(7,?)').bind(new Uint8Array(32).fill(19).buffer).run();
  const before=(await db.prepare('SELECT * FROM typed_v11_record_admissions').all()).results;
  await expect(applyD1Migrations(db,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS.filter(m=>m.name==='0006_compact_admission_proofs.sql'))).rejects.toThrow();
  expect((await db.prepare('SELECT * FROM typed_v11_record_admissions').all()).results).toEqual(before);
  expect(await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='typed_v11_record_proofs'").first('n')).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM d1_migrations WHERE name='0006_compact_admission_proofs.sql'").first('n')).toBe(0);
 });
});
