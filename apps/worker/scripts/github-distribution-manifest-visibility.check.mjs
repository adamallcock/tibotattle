import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {after, test} from 'node:test';
import {build} from 'esbuild';
import {readPostgresMigrations} from './postgres-migrations.mjs';
import {assertExpandCompatible, CONTRACT_MIGRATIONS} from '../cloud-run/postgres-production-migrations.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(join(tmpdir(),'tibotattle-distribution-reader-'));
const bundle=await build({stdin:{contents:`export {readGithubDistributionSnapshot,syncGithubDistributionSnapshots} from './src/github-distribution-history.ts'; export {readPostgresGithubDistributionSnapshot} from './src/postgres-admin-distribution.ts'; export {readAdminMetricsHistory} from './src/admin-metrics-history.ts';`,resolveDir:root},bundle:true,format:'esm',platform:'node',mainFields:['module','main'],target:'node22',write:false,logLevel:'silent'});
const modulePath=join(temporary,'readers.mjs');
await writeFile(modulePath,bundle.outputFiles[0].contents);
const readers=await import(pathToFileURL(modulePath));
after(()=>rm(temporary,{recursive:true,force:true}));
const FIRST='2026-10-05T12:00:00.000Z', CURRENT='2026-10-06T12:00:00.000Z', INCOMPLETE='2026-10-06T13:00:00.000Z';
const migrationName='0075_github_distribution_manifest_visibility.sql';

async function fixture() {
 const sql=await readFile(join(root,'migrations/0037_admin_distribution_history.sql'),'utf8');
 const database=new DatabaseSync(':memory:');
 // Execute the maintained D1 distribution DDL, excluding its independent audit migration.
 database.exec(sql.slice(sql.indexOf('CREATE TABLE github_distribution_sync_state')));
 const add=(time,count,complete=true,id=1)=>{
  database.prepare('INSERT INTO github_release_snapshots VALUES(?,?,?,?,?)').run(time,id,'v1','2026-10-01T00:00:00Z',0);
  database.prepare('INSERT INTO github_release_asset_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(time,id,'v1','2026-10-01T00:00:00Z',0,id,'installer.dmg',null,count,1);
  if(complete)database.prepare('INSERT INTO github_distribution_snapshots VALUES(?,?)').run(time,time);
 };
 add(FIRST,5);add(CURRENT,9);
 database.prepare('UPDATE github_distribution_sync_state SET last_success_at=?,last_observed_at=? WHERE singleton=1').run(CURRENT,CURRENT);
 return {database,add};
}
function d1(database,{failManifest=false}={}) {
 const prepare=sql=>{
  const statement=values=>({bind:(...next)=>statement(next),
   async all(){return {success:true,results:run('all',sql,values),meta:{}}},
   async first(){return run('get',sql,values)??null},
   async run(){if(failManifest&&/^\s*INSERT INTO github_distribution_snapshots/u.test(sql))throw Error('synthetic completion write failure');return {success:true,results:[],meta:{changes:Number(run('run',sql,values).changes)}}},
  });return statement([]);
 };
 function run(method,sql,values){
  const prepared=database.prepare(sql.replace(/\?(\d+)/gu,':p$1'));
  return /\?\d/u.test(sql)?prepared[method](Object.fromEntries(values.map((v,i)=>['p'+(i+1),v]))):prepared[method](...values);
 }
 return {prepare,async batch(statements){database.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());database.exec('COMMIT');return rows}catch(e){database.exec('ROLLBACK');throw e}}};
}
function pgFixture(database) {
 const queries=[];let released=0;
 const client={async query(sql,values=[]){queries.push({sql,values});
  if(/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql))return {rows:[]};
  let query;
  if(sql.includes('"github_distribution_sync_state"'))query='SELECT * FROM github_distribution_sync_state WHERE singleton=1';
  else if(sql.includes('"github_release_asset_snapshots"'))query='SELECT * FROM github_release_asset_snapshots WHERE observed_at=? ORDER BY release_published_at DESC,release_id,asset_id';
  else if(sql.includes('"github_release_snapshots"'))query='SELECT * FROM github_release_snapshots WHERE observed_at=? ORDER BY release_published_at DESC,release_id';
  else if(sql.includes('MIN(observed_at)'))query='SELECT MIN(observed_at) AS observed_at FROM github_distribution_snapshots';
  else if(sql.includes('MAX(observed_at)'))query='SELECT MAX(observed_at) AS observed_at FROM github_distribution_snapshots WHERE observed_at<?';
  else if(sql.includes('"github_distribution_snapshots"'))query='SELECT observed_at FROM github_distribution_snapshots WHERE observed_at=?';
  else throw Error('unknown synthetic PG statement');
  return {rows:database.prepare(query).all(...values)};
 },release(){released++}};
 return {pool:{async connect(){return client}},queries,released:()=>released};
}

test('forward migration changes exactly one named FK and requires its reviewed byte pin',async()=>{
 const migrations=await readPostgresMigrations({role:'primary'}),last=migrations.at(-1);
 assert.equal(last.name,migrationName);assert.equal(last.version,75);
 assert.equal(migrations.find(m=>m.version===22).sha256,'412b3555bd2b1aff5b667c92499cadca8d0abbdd0111fbac50a3f0eba65841e6');
 const statements=last.sql.replace(/--[^\n]*/gu,'').trim();
 assert.equal(statements,'ALTER TABLE github_release_snapshots\n  DROP CONSTRAINT github_release_snapshots_observed_at_fkey;');
 assert.deepEqual(CONTRACT_MIGRATIONS[migrationName].operations,['drop']);
 assert.equal(CONTRACT_MIGRATIONS[migrationName].sha256,createHash('sha256').update(last.sql).digest('hex'));
 assert.doesNotThrow(()=>assertExpandCompatible(migrations));
 assert.throws(()=>assertExpandCompatible(migrations.map(m=>m===last?{...m,sha256:'0'.repeat(64)}:m)),{code:'PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED'});
 const original=migrations.find(m=>m.version===22).sql;
 assert.match(original,/PRIMARY KEY \(observed_at, release_id\)/u);
 assert.match(original,/FOREIGN KEY \(observed_at, release_id\)\s+REFERENCES github_release_snapshots/u);
});
test('complete snapshots remain visible while earlier/later retained incomplete rows never enter totals or deltas',async()=>{
 const f=await fixture();try{
  f.add('2026-10-04T12:00:00.000Z',900,false);f.add(INCOMPLETE,999,false);
  const result=await readers.readGithubDistributionSnapshot(d1(f.database),Date.parse(INCOMPLETE));
  assert.equal(result.status,'available');assert.equal(result.summary.dmgDownloads,9);
  assert.equal(result.history.firstObservedAt,FIRST);assert.equal(result.history.previousObservedAt,FIRST);
  assert.equal(result.history.latestObservedAt,CURRENT);assert.equal(result.history.dmgDownloadsSincePrevious,4);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM github_release_snapshots').get().n,4);
 }finally{f.database.close()}
});
test('a state pointer without its completion manifest refuses even when release and asset rows exist',async()=>{
 const f=await fixture();try{f.add(INCOMPLETE,999,false);
  f.database.prepare('UPDATE github_distribution_sync_state SET last_observed_at=? WHERE singleton=1').run(INCOMPLETE);
  const result=await readers.readGithubDistributionSnapshot(d1(f.database),Date.parse(INCOMPLETE));
  assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'GITHUB_SNAPSHOT_MISSING');assert.equal(result.summary,null);
 }finally{f.database.close()}
});
test('public PG adapter uses the same completion-gated reader without consulting incomplete row dates',async()=>{
 const f=await fixture();try{f.add(INCOMPLETE,999,false);const pg=pgFixture(f.database);
  const result=await readers.readPostgresGithubDistributionSnapshot(pg.pool,'synthetic_history',Date.parse(INCOMPLETE));
  assert.equal(result.status,'available');assert.equal(result.summary.dmgDownloads,9);assert.equal(result.history.dmgDownloadsSincePrevious,4);
  const rowReads=pg.queries.filter(q=>/"github_release_(?:asset_)?snapshots"/u.test(q.sql));
  assert.ok(rowReads.length>=3);assert.ok(rowReads.every(q=>[FIRST,CURRENT].includes(q.values[0])));
  assert.equal(pg.queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(pg.released(),1);
 }finally{f.database.close()}
});
test('interrupted public refresh retains release/asset rows while preserving the previous complete snapshot',async()=>{
 const f=await fixture();try{
  const result=await readers.syncGithubDistributionSnapshots(d1(f.database,{failManifest:true}),{enabled:true},Date.parse(INCOMPLETE),async()=>new Response(JSON.stringify([{id:2,tag_name:'v2',published_at:'2026-10-01T00:00:00Z',draft:false,prerelease:false,assets:[{id:2,name:'installer.dmg',download_count:25,digest:null}]}]),{status:200}));
  assert.equal(result.code,'GITHUB_SYNC_FAILED');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM github_release_snapshots WHERE observed_at=?').get(INCOMPLETE).n,1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM github_release_asset_snapshots WHERE observed_at=?').get(INCOMPLETE).n,1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM github_distribution_snapshots WHERE observed_at=?').get(INCOMPLETE).n,0);
  const after=await readers.readGithubDistributionSnapshot(d1(f.database),Date.parse(INCOMPLETE));
  assert.equal(after.status,'available');assert.equal(after.summary.dmgDownloads,9);assert.equal(after.history.latestObservedAt,CURRENT);
 }finally{f.database.close()}
});
test('public admin download series chooses only completed daily manifests',async()=>{
 const f=await fixture();try{f.add(INCOMPLETE,999,false);
  f.database.exec(`CREATE TABLE participants(created_at TEXT); CREATE TABLE web_sessions(issued_at TEXT); CREATE TABLE device_pairings(issued_at TEXT); CREATE TABLE device_credentials(issued_at TEXT); CREATE TABLE telemetry_v1_device_consents(consented_at TEXT); CREATE TABLE telemetry_v1_chunks(created_at TEXT,record_count INTEGER,participant_id TEXT); CREATE TABLE telemetry_contributions(created_at TEXT,status TEXT); CREATE TABLE admin_metric_snapshots(captured_at TEXT,metrics_json TEXT);`);
  const result=await readers.readAdminMetricsHistory(d1(f.database),Date.parse(INCOMPLETE));
  assert.equal(result.downloads.available,true);
  assert.deepEqual(result.downloads.byDay,[{day:'2026-10-05',cumulativeDmgDownloads:5},{day:'2026-10-06',cumulativeDmgDownloads:9}]);
 }finally{f.database.close()}
});
