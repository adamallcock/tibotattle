import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {advanceCanonicalInputWork,readCanonicalInputMembership,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {countStorageDailyContributingDevices,readStorageCanonicalSourceMembership} from '../src/storage-community-daily-devices';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-membership',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
it('derives opaque complete credential/day membership from the same native effective and legacy selections',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
 calendarDays:14,graphDays:2,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 for(let i=0;i<48;i++){const result=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace:sourceId,
 participantId:corpus.participantId,maxSteps:64,maxRows:128});if(result.status==='complete')break;}
 for(const selectionMethod of ['effective-union-v1','legacy-selected-v1'] as const){
 const day=corpus.equivalentDay,scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
 participantId:corpus.participantId,day,stream:'usage',selectionMethod};
 for(let i=0;i<32;i++){
 const result=await advanceCanonicalInputWork(source(),target(),{...scope,budget:{meter:createD1InvocationBudget(900),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60000}});
 if(result.state==='complete')break;expect(result.state).toBe('progress');}
 const result=await readCanonicalInputMembership(source(),target(),scope,readStorageCanonicalSourceMembership);
 expect(result.state).toBe('complete');if(result.state!=='complete')throw Error(result.reason);
 const native=await countStorageDailyContributingDevices(source(),day,[{owner:corpus.owner,effective:selectionMethod==='effective-union-v1'}]);
 expect(result.deviceKeys.length).toBe(native.get(corpus.owner.ownerDigest));
 expect(result.deviceKeys).toEqual([...result.deviceKeys].sort());
 expect(new Set(result.deviceKeys).size).toBe(result.deviceKeys.length);
 expect(result.contributorKey).toMatch(/^[0-9a-f]{64}$/u);expect(result.sourceToken).toMatch(/^[0-9a-f]{64}$/u);
 const serialized=JSON.stringify(result);expect(serialized).not.toContain(corpus.participantId);
 const privateDeviceIds=(await source().prepare('SELECT id FROM device_credentials WHERE participant_id=?').bind(corpus.participantId).all<{id:string}>()).results;
 for(const device of privateDeviceIds)expect(serialized).not.toContain(device.id);
 }
},120000);
it('does not return a proof for changed owner authority or a wrong source-private identity',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,calendarDays:14,graphDays:2,
 anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 const identity={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,participantId:corpus.participantId,
 day:corpus.equivalentDay,stream:'usage' as const,selectionMethod:'effective-union-v1' as const,
 ownerRevision:corpus.owner.ownerRevision,authorityEpoch:corpus.owner.authorityEpoch,sourceStamp:'a'.repeat(64)};
 expect(await readStorageCanonicalSourceMembership(source(),{...identity,participantId:'synthetic-wrong'})).toBeNull();
 expect(await readStorageCanonicalSourceMembership(source(),{...identity,ownerRevision:identity.ownerRevision+1})).toBeNull();
},120000);
