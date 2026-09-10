import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRetainedReferenceQualification, RETAINED_QUALIFICATION_CODE_FILES, RETAINED_QUALIFICATION_NAME } from './prepare-retained-reference-qualification.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value));

test('freezes and independently replays retained11 guarded movement, range records, exact migrations and expected rollbacks',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'retained-qualification-'));
 const directory=join(temporary,'bundle');const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON;PRAGMA max_page_count=24576;PRAGMA cache_size=-4096');
 try {
  const prepared=await prepareRetainedReferenceQualification({outputDirectory:directory});
  const bytes=await readFile(join(directory,'manifest.json'));const manifest=JSON.parse(bytes);
  assert.equal(sha(bytes),prepared.manifestSha256);assert.equal(manifest.databaseName,RETAINED_QUALIFICATION_NAME);
  assert.equal(manifest.mode,'plan-only');assert.equal(manifest.hostedExecuted,false);assert.equal(manifest.productionReady,false);
  assert.equal(manifest.canonicalCommitted,true);assert.match(manifest.sourceRevision,/^[a-f0-9]{40}$/);
  assert.deepEqual(manifest.code.map(x=>x.file),[...RETAINED_QUALIFICATION_CODE_FILES]);
  assert.equal(manifest.fixture.movedTables.length,41);assert.equal(manifest.fixture.retainedTables.length,11);
  assert.equal(manifest.fixture.addedRangeRecords,8192);assert.equal(manifest.fixture.localOriginalValuesAndMovedRowidsPreserved,true);
  assert.ok(manifest.fixture.referenceCounts.device_upload_authorizations>=26000);assert.ok(manifest.fixture.referenceCounts.telemetry_v1_chunks>=26000);
  assert.equal(manifest.migrations.length,59);assert.equal((await readdir(join(directory,'canonical'))).length,59);
  assert.ok(manifest.steps.length<=256);assert.ok(prepared.maxQueryBytes<=256*1024);
  assert.ok(manifest.steps.some(s=>s.name.startsWith('range-evacuate-')));assert.ok(manifest.steps.some(s=>s.name.startsWith('range-restore-')));
  for(const phase of ['evacuate','restore']){const ranges=manifest.steps.filter(s=>s.name.startsWith('range-'+phase+'-'));assert.deepEqual(ranges.map(s=>s.rangeBenchmark.rows),[1024,7188]);assert.deepEqual(ranges.map(s=>s.rangeBenchmark.maxRows),[1024,8192]);}
  assert.ok(manifest.steps.some(s=>s.name==='late-failure-rollback'));assert.ok(manifest.steps.some(s=>s.name==='committed-replay-refused'));
  assert.equal((await stat(directory)).mode&0o777,0o700);
  let failures=0;
  for(const migration of manifest.migrations)assert.equal(sha(await readFile(join(directory,'canonical',migration.name))),migration.sha256);
  for(const step of manifest.steps){
   const path=join(directory,step.file),sql=await readFile(path,'utf8');assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(sha(sql),step.sqlSha256);assert.equal(Buffer.byteLength(sql),step.sqlBytes);
   db.exec('BEGIN IMMEDIATE');let rejected=false;
   try{db.exec(sql);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');assert.equal(step.expectedFailure,true,step.name);assert.match(error.message,step.expectedError==='MUTATION_BARRIER'?/ACCOUNTLESS_MIGRATION_MUTATION_BARRIER/:/CHECK constraint failed/);rejected=true;failures++;}
   assert.equal(rejected,step.expectedFailure,step.name);assert.deepEqual(plain(db.prepare(step.readback).all()),step.expectedRows,step.name);
  }
  assert.ok(failures>=4);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n,59);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telemetry_v1_records').get().n,8212);
  assert.equal(manifest.fixture.syntheticAuthorizationIdLength,96);assert.equal(manifest.fixture.syntheticR2KeyPaddingBytes,64);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_upload_authorizations WHERE id LIKE 'synthetic-residual-%' AND length(id)=96").get().n,26000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM telemetry_v1_chunks WHERE id LIKE 'synthetic-residual-%' AND substr(r2_key,-64)=?").get('x'.repeat(64)).n,26000);
  assert.equal(db.prepare('SELECT CAST(rowid AS TEXT) AS id FROM telemetry_v11_records').get().id,'9007199254742001');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _accountless_migration_barrier_permission_v1').get().n,0);
  // Preparation refuses an existing evidence directory; earlier receipts survive.
  await assert.rejects(prepareRetainedReferenceQualification({outputDirectory:directory}),{code:'EEXIST'});
  assert.equal(sha(await readFile(join(directory,'manifest.json'))),prepared.manifestSha256);
 }finally{db.close();await rm(temporary,{recursive:true,force:true});}
});
test('requires an explicit local output path before any preparation',async()=>{
 await assert.rejects(prepareRetainedReferenceQualification(),/OUTPUT_REQUIRED/);
});
