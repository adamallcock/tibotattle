import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {expect,it,beforeEach} from 'vitest';
import {typedTelemetryV12Id} from '../src/telemetry-v12-typed-codec';
import * as native from './helpers/analytics-native-reference';
import * as candidate from './helpers/analytics-candidate';
import {createWholeWorkloadMeter,summarizeWholeWorkload,wholeWorkloadRoleEnvironment,wholeWorkloadOptimizationProfile,advanceNativeWholeWorkloadGraph} from './helpers/analytics-whole-workload';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

beforeEach(()=>{const now=Date.now();for(const kernel of [native,candidate])if(kernel.publicationClockAdapted)kernel.setAnalyticsWorkloadPublicationClock(now);});

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const b=env as Bindings,sourceId='synthetic-p11-fixture-authority';
for(const targetAuthority of ['fixture-direct','ordered-delivery'] as const) {
 it(`keeps accepted source mutations separate from ${targetAuthority} target authority`,async()=>{
  await reset();
  const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB;
  await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,
   calendarDays:10,graphDays:2,anchorDay:new Date().toISOString().slice(0,10),
   correctionAffectsModelFit:true,...(targetAuthority==='ordered-delivery'?{targetAuthority}:{})});
  const pin=()=>target.prepare('SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
   .bind(sourceId,corpus.owner.ownerDigest).first<{revision:number;authority_epoch:number}>();
  const expectPin=async(owner:typeof corpus.owner)=>{
   if(targetAuthority==='ordered-delivery')expect(await pin()).toBeNull();
   else expect(await pin()).toEqual({revision:owner.ownerRevision,authority_epoch:owner.authorityEpoch});
  };
  await expectPin(corpus.owner);
  const appended=await corpus.appendOutsideV11();
  expect(appended.ownerRevision).toBeGreaterThan(corpus.owner.ownerRevision);
  await expectPin(appended);
  const corrected=await corpus.mutateCorrection();
  expect(corrected.ownerRevision).toBeGreaterThan(appended.ownerRevision);
  await expectPin(corrected);
  expect(await target.prepare('SELECT count(*) n FROM analytics_applied_events').first<number>('n')).toBe(0);
 },60_000);
}

for(const [lane,kernel,shared] of [['reference',native,false],['candidate',candidate,true]] as const) {
 it(`runs one actual ${lane} three-role cycle on ordered-delivery input with separately metered ledger`,async()=>{
  await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB;
  const migrations={...b};
  for(const [key,names] of Object.entries(native.nativeMigrationNames)) {
   const group=key as keyof SharedAnalyticsCorpusMigrations;
   migrations[group]=b[group].filter(migration=>names.includes(migration.name));
  }
  await native.initializeSharedAnalyticsCorpusDatabases(source,target,migrations,sourceId);
  if(shared)await applyD1Migrations(target,b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
  await native.seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,
   calendarDays:10,graphDays:2,anchorDay:new Date().toISOString().slice(0,10),targetAuthority:'ordered-delivery'});
  await applyD1Migrations(source,b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  const measured=createWholeWorkloadMeter(source,target,undefined,shared?candidate.createD1InvocationBudget:undefined,b.DELETION_LEDGER);
  for(const [role,run] of [['analytics',kernel.runStorageAnalyticsSchedule],['cache',kernel.runCacheRetentionDaySchedule],
   ['publication',kernel.runStoragePublicationSchedule]] as const) {
   measured.setPhase(`${role}_role`);
   await measured.invocation(`${role}_schedule`,async(db,_meter,ledger)=>{
    if(!ledger)throw new Error('missing metered ledger');
    await run(wholeWorkloadRoleEnvironment({...db,ledger},sourceId,sourceId,wholeWorkloadOptimizationProfile(shared?'canonical':'native')));
   });
  }
  const profile=summarizeWholeWorkload(measured.profile);
  expect(profile.invocations).toBe(3);expect(profile.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);
  expect(profile.measurementFailures).toBe(0);expect(profile.failedStatements).toBe(0);
  expect(profile.metadataSamples).toBe(profile.statements);
  for(const role of ['analytics','cache','publication'])expect(profile.phaseStatements[`${role}_role`]).toBeGreaterThan(0);
  if(shared) {
   const roles=(await target.prepare('SELECT role,canonical_enabled,model_blocks_enabled,max_queries FROM analytics_pipeline_runtime ORDER BY role').all()).results;
   expect(roles).toEqual(['analytics','cache','publication'].map(role=>({role,canonical_enabled:1,model_blocks_enabled:1,max_queries:950})));
   const before=await target.prepare('SELECT count(*) cohorts FROM analytics_canonical_publication_cohorts').first();
   const diagnostic=await candidate.readCandidateDailyFailureSnapshot({source,target,sourceId,sourceNamespace:sourceId,
    day:new Date().toISOString().slice(0,10)});
   expect(diagnostic.firstMissingGuard).toBe('maintained_fence');
   expect(diagnostic.fence.initialPresent).toBe(false);
   expect(diagnostic.queries).toBeGreaterThan(0);expect(diagnostic.queries).toBeLessThanOrEqual(200);
   expect(diagnostic.ownerProjections).toEqual([]);expect(diagnostic.deviceMembership).toEqual([]);
   expect(await target.prepare('SELECT count(*) cohorts FROM analytics_canonical_publication_cohorts').first()).toEqual(before);
  }
  console.log('analytics-role-cycle-smoke',JSON.stringify({lane,referenceCommit:native.referenceCommit,profile}));
 },60_000);
}

it('isolates an exact accepted native source snapshot before candidate-only upgrades',async()=>{
 const {copyAcceptedAnalyticsSource,captureAcceptedSourceTransfer,importAcceptedSourceTransfer}=await import('./helpers/analytics-source-snapshot');
 const {snapshotLogicalStores}=await import('./helpers/analytics-logical-bytes');
 const bindings=b as typeof b&{STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database};
 await reset();const migrations={...b};
 for(const [key,names] of Object.entries(native.nativeMigrationNames)) {
  const group=key as keyof SharedAnalyticsCorpusMigrations;migrations[group]=b[group].filter(migration=>names.includes(migration.name));
 }
 await native.initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,bindings.STORAGE_INGESTION_A,migrations,sourceId);
 await native.seedSharedAnalyticsCorpus({source:b.USAGE_MONITOR_DB,target:bindings.STORAGE_INGESTION_A,sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:2,anchorDay:new Date().toISOString().slice(0,10),targetAuthority:'ordered-delivery'});
 const copied=await copyAcceptedAnalyticsSource(b.USAGE_MONITOR_DB,bindings.STORAGE_INGESTION_B);
 const transfer=await captureAcceptedSourceTransfer(b.USAGE_MONITOR_DB);
 const freshProof=await importAcceptedSourceTransfer(transfer.transfer,(b as typeof b&{STORAGE_ROUTING_DB:D1Database}).STORAGE_ROUTING_DB);
 expect(freshProof.proof.sqlSha256).toBe(copied.sqlSha256);expect(freshProof.proof.schemaSha256).toBe(copied.schemaSha256);expect(freshProof.proof.rowidInventorySha256).toBe(copied.rowidInventorySha256);
 expect(copied.exactSchemaAndData).toBe(true);expect(copied.exactRowids).toBe(true);expect(copied.exportStatements).toBeGreaterThan(100);
 for(const profile of Object.values(copied.importAndProof)){expect(profile.measurementFailures).toBe(0);expect(profile.failedStatements).toBe(0);}
 expect(await native.readStorageCommunityOwnerPage(b.USAGE_MONITOR_DB)).toEqual(await native.readStorageCommunityOwnerPage(bindings.STORAGE_INGESTION_B));
 await applyD1Migrations(bindings.STORAGE_INGESTION_B,b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 expect(await native.readStorageCommunityOwnerPage(b.USAGE_MONITOR_DB)).toEqual(await native.readStorageCommunityOwnerPage(bindings.STORAGE_INGESTION_B));
 const reference=await snapshotLogicalStores(b.USAGE_MONITOR_DB,'source'),candidate=await snapshotLogicalStores(bindings.STORAGE_INGESTION_B,'source');
 expect(Object.values(reference.tables).filter(table=>table.present)).toHaveLength(native.referenceCommit===null?13:2);
 expect(Object.values(candidate.tables).filter(table=>table.present)).toHaveLength(13);
 console.log('analytics-source-snapshot-smoke',JSON.stringify(copied));
},60_000);

it('measures full retained logical rows with exact SQLite type and payload byte representations',async()=>{
 const {snapshotLogicalStores}=await import('./helpers/analytics-logical-bytes');
 await reset();
 await initializeSharedAnalyticsCorpusDatabases(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB,b,sourceId);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 const measured=createWholeWorkloadMeter(b.USAGE_MONITOR_DB,b.STORAGE_ANALYTICS_DB,undefined,undefined,b.DELETION_LEDGER);
 measured.setPhase('logical_inventory');
 const snapshots=await measured.invocation('closed_inventory',async(db,_meter,ledger)=>({source:await snapshotLogicalStores(db.source,'source'),target:await snapshotLogicalStores(db.target,'target'),ledger:await snapshotLogicalStores(ledger!,'ledger')}));
 expect(Object.keys(snapshots.source.tables)).toHaveLength(13);expect(Object.keys(snapshots.target.tables)).toHaveLength(127);expect(Object.keys(snapshots.ledger.tables)).toHaveLength(3);
 for(const snapshot of Object.values(snapshots))expect(Object.values(snapshot.tables).every(table=>table.present)).toBe(true);
 expect(summarizeWholeWorkload(measured.profile).statements).toBe(146);
 expect(summarizeWholeWorkload(measured.profile).rowsWritten).toBe(0);
 const source=b.USAGE_MONITOR_DB;
 await source.prepare('CREATE TABLE p11_value_proof(a,b,c INTEGER,d REAL,e BLOB)').run();
 await source.prepare('INSERT INTO p11_value_proof VALUES(?,?,?,?,?)').bind(null,'é',1,0.25,new Uint8Array([0,255])).run();
 const row=await source.prepare("SELECT json_array(json_array(typeof(a),a),json_array(typeof(b),b),json_array(typeof(c),quote(c)),json_array(typeof(d),quote(d)),json_array(typeof(e),hex(e))) value FROM p11_value_proof").first<string>('value');
 expect(row).toBe('[["null",null],["text","é"],["integer","1"],["real","0.25"],["blob","00FF"]]');
},30_000);

it('transfers accepted rowids, text ordering and typed values into a fresh source without fabricated identity',async()=>{
 const {captureAcceptedSourceTransfer,importAcceptedSourceTransfer}=await import('./helpers/analytics-source-snapshot');
 await reset();const source=b.USAGE_MONITOR_DB,target=(b as typeof b&{STORAGE_INGESTION_B:D1Database}).STORAGE_INGESTION_B;
 await source.prepare('CREATE TABLE accepted(id INTEGER PRIMARY KEY,value TEXT,amount REAL,bytes BLOB)').run();
 await source.prepare('INSERT INTO accepted VALUES(?,?,?,?)').bind(17,'02',0.25,new Uint8Array([0,255])).run();
 await source.prepare('INSERT INTO accepted VALUES(?,?,?,?)').bind(3,'2',null,null).run();
 const seed=await captureAcceptedSourceTransfer(source),proof=await importAcceptedSourceTransfer(seed.transfer,target);
 expect(proof.proof).toEqual(seed.transfer.proof);expect(proof.exactSchemaAndData&&proof.exactRowids).toBe(true);
 expect((await target.prepare('SELECT rowid,id,value,amount,hex(bytes) bytes FROM accepted ORDER BY rowid').all()).results)
  .toEqual((await source.prepare('SELECT rowid,id,value,amount,hex(bytes) bytes FROM accepted ORDER BY rowid').all()).results);
 const changed=structuredClone(seed.transfer);changed.statements.push("INSERT INTO accepted VALUES(99,'tampered',0,NULL)");
 await expect(importAcceptedSourceTransfer(changed,b.DELETION_LEDGER)).rejects.toThrow('digest mismatch');
 await expect(importAcceptedSourceTransfer(seed.transfer,target)).rejects.toThrow('empty laboratory');
});


async function nativeOptimizedFixture(options:{withoutBlocks?:boolean}={}) {
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB;
 const migrations={...b};
 for(const [key,names] of Object.entries(native.nativeMigrationNames)) {
  const group=key as keyof SharedAnalyticsCorpusMigrations;
  migrations[group]=b[group].filter(migration=>names.includes(migration.name));
 }
 // A real prerequisite migration frontier proves unsupported-only fallback.
 if(options.withoutBlocks)migrations.TEST_ANALYTICS_MIGRATIONS=migrations.TEST_ANALYTICS_MIGRATIONS.filter(migration=>migration.name<'0030_');
 await native.initializeSharedAnalyticsCorpusDatabases(source,target,migrations,sourceId);
 const today=new Date().toISOString().slice(0,10),range=native.planHistoricalModelBlockRanges(today).find(value=>
  Date.parse(value.outputThroughDay)-Date.parse(value.outputFromDay)===31*86_400_000)!;
 const corpus=await native.seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,
  calendarDays:14,graphDays:2,anchorDay:range.outputThroughDay});
 return {source,target,range,corpus};
}
it('uses nonempty pinned shared heads and real model-block adoption under the explicit scoped lease',async()=>{
 const {source,target,range,corpus}=await nativeOptimizedFixture();
 const measured=createWholeWorkloadMeter(source,target),profile=wholeWorkloadOptimizationProfile('native');
 let blocks=0,adopted=0,fallbacks=0;
 const kernel={...native,advanceStorageModelBlockGraphWork:async(...args:Parameters<typeof native.advanceStorageModelBlockGraphWork>)=>{
  blocks++;const result=await native.advanceStorageModelBlockGraphWork(...args);adopted+=result.adoptedDates;return result;
 },computeStorageGraphResult:async(...args:Parameters<typeof native.computeStorageGraphResult>)=>{
  fallbacks++;expect(args[2]).not.toHaveProperty('preparedEffectiveUsage');return native.computeStorageGraphResult(...args);
 }};
 let result:Awaited<ReturnType<typeof advanceNativeWholeWorkloadGraph>>|undefined;
 for(let attempt=0;attempt<100;attempt++) {
  result=await measured.invocation('scoped_graph_request',(db,meter)=>advanceNativeWholeWorkloadGraph({kernel,
   bindings:{...db,sourceId,sourceNamespace:sourceId},owner:corpus.owner,day:range.outputThroughDay,metric:'model',meter,profile,
   leased:true,setPhase:phase=>measured.setPhase(phase)}));
  if(result.state==='complete')break;
  expect(result.failure).toBeUndefined();
 }
 expect(result?.state).toBe('complete');if(result?.state!=='complete')throw new Error('optimized graph did not complete');
 expect(result.result.composition?.status).toBe('ready');expect(blocks).toBeGreaterThan(0);expect(adopted).toBeGreaterThan(0);expect(fallbacks).toBe(0);
 expect(await target.prepare("SELECT count(*) n FROM analytics_model_blocks WHERE state='complete'").first<number>('n')).toBeGreaterThan(0);
 expect(await target.prepare("SELECT count(*) n FROM analytics_shared_feature_days WHERE state='complete' AND payload_bytes>0").first<number>('n')).toBeGreaterThan(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_shared_feature_parts').first<number>('n')).toBeGreaterThan(0);
 expect(await native.readStorageGraphWorkSelection(target,{sourceId,ownerDigest:corpus.owner.ownerDigest,day:range.outputThroughDay,metric:'model'})).toBeNull();
 const costs=summarizeWholeWorkload(measured.profile);expect(costs.maximumStatementsPerInvocation).toBeLessThanOrEqual(950);expect(costs.measurementFailures).toBe(0);
 console.log('p11-optimized-native-path',JSON.stringify({blocks,adopted,fallbacks,invocations:costs.invocations,statements:costs.statements,max:costs.maximumStatementsPerInvocation}));
},180_000);
it('falls back only after the actual native block adapter refuses an uninstalled block frontier',async()=>{
 const {source,target,range,corpus}=await nativeOptimizedFixture({withoutBlocks:true});
 const measured=createWholeWorkloadMeter(source,target);let unsupported=0,fallbacks=0;
 const kernel={...native,advanceStorageModelBlockGraphWork:async(...args:Parameters<typeof native.advanceStorageModelBlockGraphWork>)=>{
  const result=await native.advanceStorageModelBlockGraphWork(...args);expect(result.state).toBe('unsupported');unsupported++;return result;
 },computeStorageGraphResult:async(...args:Parameters<typeof native.computeStorageGraphResult>)=>{
  fallbacks++;expect(args[2]).not.toHaveProperty('preparedEffectiveUsage');return native.computeStorageGraphResult(...args);
 }};
 let result:Awaited<ReturnType<typeof advanceNativeWholeWorkloadGraph>>|undefined;
 for(let attempt=0;attempt<100;attempt++) {
  result=await measured.invocation('scoped_graph_request',(db,meter)=>advanceNativeWholeWorkloadGraph({kernel,
   bindings:{...db,sourceId,sourceNamespace:sourceId},owner:corpus.owner,day:range.outputThroughDay,metric:'model',meter,
   profile:wholeWorkloadOptimizationProfile('native'),leased:true,setPhase:phase=>measured.setPhase(phase)}));
  if(result.state==='complete')break;expect(result.failure).toBeUndefined();
 }
 expect(result?.state).toBe('complete');expect(unsupported).toBeGreaterThan(0);expect(fallbacks).toBe(unsupported);
 expect(await native.readStorageGraphWorkSelection(target,{sourceId,ownerDigest:corpus.owner.ownerDigest,day:range.outputThroughDay,metric:'model'})).toBeNull();
 expect(summarizeWholeWorkload(measured.profile).maximumStatementsPerInvocation).toBeLessThanOrEqual(950);
},90_000);


it('creates an optional genuine accountless secondary before ordered delivery without changing the two-owner population',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,migrations={...b};
 for(const [key,names] of Object.entries(native.nativeMigrationNames)){
  const group=key as keyof SharedAnalyticsCorpusMigrations;migrations[group]=b[group].filter(migration=>names.includes(migration.name));
 }
 await native.initializeSharedAnalyticsCorpusDatabases(source,target,migrations,sourceId);
 const corpus=await native.seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:2,anchorDay:new Date().toISOString().slice(0,10),targetAuthority:'ordered-delivery',secondaryOwnerKind:'accountless'});
 const secondary=corpus.secondaryAccountless;if(!secondary)throw Error('ACCOUNTLESS_FIXTURE_REQUIRED');
 const owners=await native.readStorageCommunityOwnerPage(source);expect(owners).toHaveLength(2);
 expect(owners.find(owner=>owner.participantId===corpus.participantId)).toMatchObject({hasV1:true,hasV11:true,hasV12:true});
 expect(owners.find(owner=>owner.participantId===secondary.participantId)).toMatchObject({hasV1:false,hasV11:false,hasV12:true});
 expect(await source.prepare(`SELECT p.owner_kind,l.state AS enrollment_state,o.state AS owner_state,g.state AS grant_state
  FROM accountless_upload_owners o JOIN participants p ON p.id=o.participant_id
  JOIN accountless_enrollment_ledger l ON l.device_id=o.enrollment_device_id
  JOIN accountless_v12_device_authorizations g ON g.enrollment_device_id=l.device_id
  WHERE o.participant_id=? AND l.device_id=?`).bind(secondary.participantId,secondary.enrollmentDeviceId).first())
  .toEqual({owner_kind:'accountless',enrollment_state:'active',owner_state:'active',grant_state:'active'});
 expect(await source.prepare(`SELECT count(*) n FROM telemetry_v12_domain_heads h
  JOIN telemetry_v12_domain_days d ON d.generation_id=h.generation_id WHERE h.participant_id=?`)
  .bind(secondary.participantId).first<number>('n')).toBe(10);
 expect(await source.prepare(`SELECT count(*) n FROM telemetry_v12_records r
  JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id WHERE m.participant_id=? AND r.occurrence_id=?`)
  .bind(secondary.participantId,typedTelemetryV12Id(corpus.duplicateAcrossOwnersOccurrenceId)).first<number>('n')).toBe(1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_applied_events').first<number>('n')).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_owner_state').first<number>('n')).toBe(0);
},60_000);
