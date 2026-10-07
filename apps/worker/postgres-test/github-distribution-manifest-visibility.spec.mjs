// Local PostgreSQL 17 qualification only. No remote endpoint or credentials.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {applyPostgresMigrations, readPostgresMigrations} from '../scripts/postgres-migrations.mjs';
import {postgresTestEndpoint} from './staged-migrations-harness.mjs';

const endpoint=await postgresTestEndpoint();
test('forward 0075 preserves all history and leaves release/asset authority intact',{skip:endpoint===null?'requires an explicitly supplied local PostgreSQL 17 endpoint':false,timeout:120_000},async()=>{
 const pool=new pg.Pool({...endpoint,max:1,connectionTimeoutMillis:5_000});
 const schema='distribution_visibility_'+randomBytes(8).toString('hex'),quoted='"'+schema+'"';
 const root=await mkdtemp(join(tmpdir(),'tibotattle-distribution-0074-'));
 const primary=join(root,'primary');await mkdir(primary,{mode:0o700});
 try{
  assert.match(String((await pool.query('SHOW server_version')).rows[0].server_version),/^17\./u);
  await pool.query(`CREATE SCHEMA ${quoted}`);
  const migrations=await readPostgresMigrations({role:'primary'});
  for(const migration of migrations.filter(m=>m.version<=74))await writeFile(join(primary,migration.name),migration.sql);
  await applyPostgresMigrations({role:'primary',schema,pool,rootDirectory:root});
  const completed='2026-10-06T12:00:00.000Z',pending='2026-10-06T13:00:00.000Z';
  await pool.query(`INSERT INTO ${quoted}.github_distribution_snapshots VALUES($1,$1)`,[completed]);
  const insertRelease=(at,id)=>pool.query(`INSERT INTO ${quoted}.github_release_snapshots VALUES($1,$2,'synthetic-v1',$1,false)`,[at,id]);
  const insertAsset=(at,release,id)=>pool.query(`INSERT INTO ${quoted}.github_release_asset_snapshots VALUES($1,$2,'synthetic-v1',$1,false,$3,'installer.dmg',NULL,10,true)`,[at,release,id]);
  await insertRelease(completed,1);await insertAsset(completed,1,1);
  await assert.rejects(insertRelease(pending,2),{code:'23503'});
  const next=migrations.find(m=>m.version===75);await writeFile(join(primary,next.name),next.sql);
  const migrated=await applyPostgresMigrations({role:'primary',schema,pool,rootDirectory:root});
  assert.equal(migrated.applied,75);
  await insertRelease(pending,2);await insertAsset(pending,2,2);
  await assert.rejects(insertRelease(pending,2),{code:'23505'});
  await assert.rejects(insertAsset(pending,999,3),{code:'23503'});
  const counts=await pool.query(`SELECT (SELECT count(*)::int FROM ${quoted}.github_release_snapshots) AS releases,(SELECT count(*)::int FROM ${quoted}.github_release_asset_snapshots) AS assets,(SELECT count(*)::int FROM ${quoted}.github_distribution_snapshots) AS completed`);
  assert.deepEqual(counts.rows,[{releases:2,assets:2,completed:1}]);
  const constraints=await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`,[schema+'.github_release_snapshots']);
  assert.ok(constraints.rows.some(r=>r.conname==='github_release_snapshots_pkey'));
  assert.equal(constraints.rows.some(r=>r.conname==='github_release_snapshots_observed_at_fkey'),false);
  const visible=()=>pool.query(`SELECT release_id::int FROM ${quoted}.github_release_snapshots release JOIN ${quoted}.github_distribution_snapshots manifest USING(observed_at) ORDER BY release_id`);
  assert.deepEqual((await visible()).rows,[{release_id:1}]);
  await pool.query(`INSERT INTO ${quoted}.github_distribution_snapshots VALUES($1,$1)`,[pending]);
  assert.deepEqual((await visible()).rows,[{release_id:1},{release_id:2}]);
 }finally{
  try{await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`)}finally{await pool.end();await rm(root,{recursive:true,force:true})}
 }
});
