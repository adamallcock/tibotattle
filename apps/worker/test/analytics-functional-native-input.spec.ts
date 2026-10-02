import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import * as native from './helpers/analytics-mutation-current';
import {createFunctionalNativeInput,prepareFunctionalV11Repair,type FunctionalNativeReceipt} from './helpers/analytics-functional-native-input';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {encodeTypedTelemetryId} from '../src/typed-telemetry-codec';
import type {DevicePrincipal} from '../src/device-auth';
import type {TelemetryV12UsageEvent} from '@app-usagemonitor/telemetry-contract';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-functional-native-input';
function semantic(receipt:FunctionalNativeReceipt,occurrenceId:string,days:readonly string[]){
 expect(receipt.outcome).toBe('accepted');
 for(const day of days){const row=receipt.effective?.find(value=>value.day===day&&value.occurrenceId===occurrenceId);
  expect(row).toBeTruthy();expect(['compatible','conflict','absent']).toContain(row!.status);
  expect(row!.status==='compatible'?row!.recordDigest:row!.recordDigest===null).toBeTruthy();}
}
const today=()=>new Date(Date.now()-86_400_000).toISOString().slice(0,10);
async function setup(){await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 return seedSharedAnalyticsCorpus({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:1,anchorDay:today()});}
async function device(format:'v11'|'v12',participantId:string){const row=await source().prepare(`SELECT credential.id AS deviceId,
 credential.participant_id AS participantId,participant.consent_version AS participantConsentVersion,
 credential.expires_at AS expiresAt,credential.credential_generation AS credentialGeneration,
 credential.social_verified_at AS socialVerifiedAt,credential.authority_kind AS authorityKind
 FROM telemetry_${format}_domain_heads head JOIN telemetry_${format}_domains domain ON domain.id=head.generation_id
 JOIN device_credentials credential ON credential.id=domain.device_id
 JOIN participants participant ON participant.id=credential.participant_id WHERE head.participant_id=?`)
 .bind(participantId).first<DevicePrincipal>();expect(row).toBeTruthy();return row!;}
async function currentRows(participantId:string,day:string,stream:'usage'|'quota'){
 const page=await native.readTelemetryV12EffectivePage(source(),{participantId,day,stream,limit:200});
 expect(page.available).toBe(true);expect(page.next).toBeNull();
 return page.records.map(row=>JSON.parse(row.sourceRecordJson));}
async function selectedUsageCount(participantId:string,day:string,eventId:string){
 const blob=Uint8Array.from(encodeTypedTelemetryId(eventId)).buffer;
 return (await source().prepare(`SELECT count(*) AS n FROM telemetry_v12_domain_heads head
  JOIN telemetry_v12_domain_days selected ON selected.generation_id=head.generation_id AND selected.observed_day=?
  JOIN telemetry_v12_day_manifests manifest ON manifest.id=selected.manifest_id
   AND manifest.manifest_digest=selected.manifest_digest AND manifest.state='ready'
  JOIN telemetry_v12_records record ON record.manifest_id=manifest.id
   AND record.stream='usage' AND record.occurrence_id=?
  WHERE head.participant_id=?`).bind(day,blob,participantId).first<number>('n'))!;
}
it('repairs only qualified totals of the same accepted v1.1 and v1.2 occurrence through native immutable admission',async()=>{
 const corpus=await setup(),v12=await device('v12',corpus.participantId);
 const selected=(await currentRows(corpus.participantId,corpus.correctionDay,'usage'))
  .find((record):record is TelemetryV12UsageEvent=>record.schemaVersion==='usage-event-v1.2'
   &&record.eventId===corpus.correctionOccurrenceId);
 expect(selected).toBeTruthy();expect(selected!.components.outputCombinedTokens).toBeNull();
 await prepareFunctionalV11Repair(native,source(),{sourceNamespace:sourceId,participantId:corpus.participantId,
  day:corpus.correctionDay,occurrenceId:selected!.eventId,nowEpoch:Date.now()});
 const prior=(await source().prepare(`SELECT count(*) n FROM typed_v11_record_admissions WHERE occurrence_id=?`)
  .bind(corpus.correctionOccurrenceId).first<number>('n'))!;
 const result=await createFunctionalNativeInput(native,sourceId).apply(source(),{
  kind:'same_occurrence_total_repair',participantId:corpus.participantId,deviceId:v12.deviceId,
  day:corpus.correctionDay,occurrenceId:corpus.correctionOccurrenceId,nowEpoch:Date.now()});
 expect(result).toMatchObject({outcome:'accepted',affectedDays:[corpus.correctionDay],priorRecords:1,newRecords:1,
  changedFields:['components.outputCombinedTokens']});
 semantic(result,corpus.correctionOccurrenceId,[corpus.correctionDay]);
 expect((await source().prepare(`SELECT count(*) n FROM typed_v11_record_admissions WHERE occurrence_id=?`)
  .bind(corpus.correctionOccurrenceId).first<number>('n'))).toBe(prior);
 const after=(await currentRows(corpus.participantId,corpus.correctionDay,'usage'))
  .filter(record=>record.eventId===corpus.correctionOccurrenceId);
 expect(after.length).toBeGreaterThanOrEqual(2); // retained old and newly selected records
 expect(after.some(record=>record.components.outputCombinedTokens===75)).toBe(true);
});

it('keeps timestamp, quota, plan, tie, cross-day and empty replacements on native accepted domain vectors',async()=>{
 const corpus=await setup(),v12=await device('v12',corpus.participantId),apply=createFunctionalNativeInput(native,sourceId).apply;
 const day=corpus.graphDates[0]!,usageRows=await currentRows(corpus.participantId,day,'usage'),
  usage=usageRows[0] as TelemetryV12UsageEvent,moveUsage=usageRows.find(record=>record.eventId!==usage.eventId) as TelemetryV12UsageEvent,
  quota=(await currentRows(corpus.participantId,day,'quota'))[0] as {observationId:string};
 expect(usage?.eventId).toBeTruthy();expect(moveUsage?.eventId).toBeTruthy();expect(quota?.observationId).toBeTruthy();
 const base={participantId:corpus.participantId,deviceId:v12.deviceId,day,nowEpoch:Date.now()};
 const timestamp=await apply(source(),{...base,kind:'timestamp_move',occurrenceId:usage.eventId});
 expect(timestamp).toMatchObject({outcome:'accepted',changedFields:['eventTime']});semantic(timestamp,usage.eventId,[day]);
 const tied=await apply(source(),{...base,kind:'equal_time_tie',occurrenceId:usage.eventId});
 expect(tied).toMatchObject({outcome:'accepted',changedFields:['tieOrder','eventId','dayRecords']});semantic(tied,usage.eventId,[day]);
 expect(tied.effective?.filter(value=>value.stream==='usage')).toHaveLength(2);
 const quotaChanged=await apply(source(),{...base,kind:'quota_change',occurrenceId:quota.observationId});
 expect(quotaChanged).toMatchObject({outcome:'accepted',changedFields:['usedPercent']});semantic(quotaChanged,quota.observationId,[day]);
 const planChanged=await apply(source(),{...base,kind:'plan_change',occurrenceId:quota.observationId});
 expect(planChanged).toMatchObject({outcome:'accepted',changedFields:['planType','accountPlanAttribution.planType']});
 semantic(planChanged,quota.observationId,[day]);
 await expect(apply(source(),{...base,kind:'plan_change',occurrenceId:usage.eventId}))
  .rejects.toThrow('FUNCTIONAL_NATIVE_PLAN_REQUIRED');
 const destination=corpus.historyDates.find(value=>value!==day)!;
 expect(destination).toBeTruthy();
 expect(await selectedUsageCount(corpus.participantId,day,moveUsage.eventId)).toBe(1);
 expect(await selectedUsageCount(corpus.participantId,destination,moveUsage.eventId)).toBe(0);
 const moved=await apply(source(),{...base,kind:'cross_day_move',occurrenceId:moveUsage.eventId,destinationDay:destination});
 expect(moved).toMatchObject({outcome:'accepted',affectedDays:[destination,day],changedFields:['eventTime']});
 expect(moved.newRecords).toBe(moved.priorRecords);
 semantic(moved,moveUsage.eventId,[day,destination]);
 expect(await selectedUsageCount(corpus.participantId,day,moveUsage.eventId)).toBe(0);
 expect(await selectedUsageCount(corpus.participantId,destination,moveUsage.eventId)).toBe(1);
 const empty=(await source().prepare(`SELECT selected.observed_day day FROM telemetry_v12_domain_heads head
  JOIN telemetry_v12_domain_days selected ON selected.generation_id=head.generation_id
  JOIN telemetry_v12_day_manifests manifest ON manifest.id=selected.manifest_id
  WHERE head.participant_id=? AND manifest.expected_chunk_count=0 ORDER BY day LIMIT 1`)
  .bind(corpus.participantId).first<string>('day'))!;
 expect(empty).toBeTruthy();
 const filled=await apply(source(),{...base,kind:'empty_day_replacement',day:empty});
 expect(filled).toMatchObject({outcome:'accepted',affectedDays:[empty],changedFields:['dayRecords'],priorRecords:0,newRecords:1});
 expect(filled.effective).toHaveLength(1);
});
