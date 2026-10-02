import {applyD1Migrations} from 'cloudflare:test';
import type {SharedAnalyticsCorpusMigrations} from './shared-analytics-corpus';
import {initializeStorageSource} from '../../src/analytics-delivery';
import {initializeTypedV1Admission} from '../../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../../src/typed-v11-admission';
import {drainCommunityPublicSourceBootstrap} from '../../src/community-daily-aggregates';
import {initializeStorageAnalyticsRuntime} from '../../src/storage-analytics-runtime';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest,type TelemetryV11QuotaObservation} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from '../helpers/telemetry-v11';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../../src/device-auth';
import {persistTypedV11StagedChunk} from '../../src/typed-v11-admission';
import {registerTelemetryV11DayManifest} from '../../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../../src/telemetry-v11-domain';
import {sha256Hex} from '../../src/crypto';
import {readStorageCommunityOwnerPage} from '../../src/storage-community-authority';

/** Accepted synthetic native v1.1 source. No v1.2 owner exists and correction
 * remains staged; both pinned/current consumers read these exact accepted rows. */
export async function seedLegacySelectedFunctionalCorpus(source:D1Database,sourceNamespace:string,nowMs:number){
 const correction=await source.prepare('SELECT state FROM telemetry_usage_correction_runtime WHERE id=1').first<string>('state');
 if(correction!=='staged')throw Error('LEGACY_FUNCTIONAL_RUNTIME_MUST_BE_STAGED');
 const device=await createV11DeviceFixture(source,{participantId:'participant:synthetic-legacy-functional',grant:true});
 const today=new Date(nowMs).toISOString().slice(0,10),todayMs=Date.parse(today+'T00:00:00.000Z');
 const days=Array.from({length:4},(_,i)=>new Date(todayMs+(i-3)*86400000).toISOString().slice(0,10));
 const day=days[1]!,nextDay=days[2]!,cutoff=Date.parse(nextDay+'T00:00:00.000Z');
 const usageTimes=[Date.parse(days[0]+'T23:55:00.000Z'),cutoff-300000,cutoff-1,cutoff,cutoff+1];
 const attribution={accountBasis:'same_source' as const,accountTrackId:'account-track:v2:'+'a'.repeat(64),
  planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};
 const usage=usageTimes.map((ms,i)=>v11UsageRecord(new Date(ms).toISOString().slice(0,10),String(i+1),{
  eventTime:new Date(ms).toISOString(),accountPlanAttribution:{...attribution}}));
 const quotaTimes=[cutoff-600000,cutoff-1,cutoff,cutoff+1];
 const quota:TelemetryV11QuotaObservation[]=quotaTimes.map((ms,i)=>({schemaVersion:'quota-observation-v1.1',
  observationId:'quota:synthetic-boundary:'+i,observedTime:new Date(ms).toISOString(),provider:'openai_codex',planType:'pro',
  planVariant:'unknown',limitId:'codex',slot:'seven_day',usedPercent:10+i*5,windowDurationMinutes:10080,
  resetsAt:new Date(todayMs+7*86400000).toISOString(),accountPlanAttribution:{...attribution}}));
 const ready=[];
 for(const date of days){
  const prepared=await makeV11Day(date,{usage:usage.filter(r=>r.eventTime.startsWith(date)),quota:quota.filter(r=>r.observedTime.startsWith(date))},'synthetic-legacy-functional-v11');
  await registerTelemetryV11DayManifest(source,device,prepared.manifest);
  for(const chunk of prepared.chunks){
   const label='synthetic-legacy-functional:'+chunk.manifestDigest+':'+chunk.chunkId,envelopeDigest=await sha256Hex(label);
   const principal=await authenticateDevice(source,device.authorization);
   const authorization=await createDeviceUploadAuthorization(source,principal,envelopeDigest,4096);
   const claim=await claimDeviceUploadAuthorization(source,'Upload '+authorization.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
   await persistTypedV11StagedChunk(source,principal,chunk,{sourceNamespace,chunkRowId:'chunk:'+(await sha256Hex(label)).slice(0,36),
    r2Key:'synthetic/functional/'+await sha256Hex(label),envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  const registered=await registerTelemetryV11DayManifest(source,device,prepared.manifest);
  ready.push({day:date,manifestId:registered.manifestId,manifestDigest:registered.manifestDigest});
 }
 const predecessor=await createTelemetryV11DomainPredecessor(source,device);
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:days[0]!,throughDay:today,
  predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},days:ready,manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));await activateTelemetryV11Domain(source,device,manifest);
 const [owner]=await readStorageCommunityOwnerPage(source);
 if(!owner||!owner.hasV11||owner.hasV12||owner.hasEffective)throw Error('LEGACY_FUNCTIONAL_SELECTION');
 return {owner,participantId:device.participantId,deviceId:device.deviceId,days,day,nextDay,today,cutoff,ready,
  expectedUsageTimes:usageTimes,expectedQuotaTimes:quotaTimes};
}

/** Same real migration/bootstrap sequence, with activation intentionally absent.
 * Activation is forward-only; a fixture never downgrades an active runtime. */
export async function initializeLegacyFunctionalDatabases(source:D1Database,target:D1Database,migrations:SharedAnalyticsCorpusMigrations,sourceId:string){
 for(const group of [migrations.TEST_MIGRATIONS,migrations.TEST_TYPED_INGESTION_MIGRATIONS,migrations.TEST_INGESTION_BRIDGE_MIGRATIONS,
  migrations.TEST_TYPED_V1_ADMISSION_MIGRATIONS,migrations.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source,group);
 await initializeStorageSource(source,sourceId);await initializeTypedV1Admission(source,sourceId);await initializeTypedV11Admission(source,sourceId);
 await applyD1Migrations(source,migrations.TEST_INGESTION_ISOLATION_MIGRATIONS);await applyD1Migrations(target,migrations.TEST_ANALYTICS_MIGRATIONS);
 if(!(await drainCommunityPublicSourceBootstrap(source)).completed)throw Error('LEGACY_FUNCTIONAL_BOOTSTRAP');
 await initializeStorageAnalyticsRuntime({source,target,sourceId,sourceNamespace:sourceId});
}
