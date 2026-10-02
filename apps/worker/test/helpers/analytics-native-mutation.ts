import {expect} from 'vitest';
import {sha256Hex} from '../../src/crypto';
import type {DevicePrincipal} from '../../src/device-auth';
import type {TelemetryV12Chunk,TelemetryV12DayManifest,TelemetryV12Record,TelemetryV12UsageEvent} from '@app-usagemonitor/telemetry-contract';
export type NativeAnalyticsMutationKind='no_op'|'unrelated_append'|'metadata_change'|'old_correction';
/** Test-only authentic native caller. All SQL/binds pass through the supplied
 * D1 adapter; this does not rewrite source evidence or generate receipt IDs. */
export function createNativeAnalyticsMutation(native:typeof import('./analytics-mutation-native-reference'),sourceNamespace:string){
type Kind=NativeAnalyticsMutationKind;
async function device(db:D1Database,format:'v11'|'v12',participantId:string):Promise<DevicePrincipal>{
 const row=await db.prepare(`SELECT device.id AS deviceId,device.participant_id AS participantId,
  participant.consent_version AS participantConsentVersion,device.expires_at AS expiresAt,
  device.credential_generation AS credentialGeneration,device.social_verified_at AS socialVerifiedAt,device.authority_kind AS authorityKind
  FROM telemetry_${format}_domain_heads head JOIN telemetry_${format}_domains domain ON domain.id=head.generation_id
  JOIN device_credentials device ON device.id=domain.device_id JOIN participants participant ON participant.id=device.participant_id
  WHERE head.participant_id=?`).bind(participantId).first<DevicePrincipal>();
 if(!row)throw Error('MUTATION_DEVICE_MISSING');return row;
}
async function domainDays(db:D1Database,format:'v11'|'v12',participantId:string){
 return (await db.prepare(`SELECT day.observed_day AS day,day.manifest_id AS manifestId,manifest.manifest_digest AS manifestDigest
  FROM telemetry_${format}_domain_heads head JOIN telemetry_${format}_domain_days day ON day.generation_id=head.generation_id
  JOIN telemetry_${format}_day_manifests manifest ON manifest.id=day.manifest_id WHERE head.participant_id=? ORDER BY day.observed_day`)
  .bind(participantId).all<{day:string;manifestId:string;manifestDigest:string}>()).results;
}
async function grant(db:D1Database,principal:DevicePrincipal,label:string,now:number){
 const envelopeDigest=await sha256Hex(label),issued=await native.createDeviceUploadAuthorization(db,principal,envelopeDigest,4096,now);
 const claimed=await native.claimDeviceUploadAuthorization(db,'Upload '+issued.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
 return {envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId};
}
async function mutate(db:D1Database,kind:Kind,participantId:string,day:string,now:number){
 const format=kind==='old_correction'?'v12':'v11',principal=await device(db,format,participantId);
 if(kind==='no_op'){
  const row=await db.prepare(`SELECT manifest.manifest_json FROM telemetry_v11_domain_heads head
   JOIN telemetry_v11_domain_days day ON day.generation_id=head.generation_id JOIN telemetry_v11_day_manifests manifest ON manifest.id=day.manifest_id
   WHERE head.participant_id=? AND day.observed_day=?`).bind(participantId,day).first<{manifest_json:string}>();
  if(!row)throw Error('MUTATION_NOOP_MANIFEST');await native.registerTelemetryV11DayManifest(db,principal,JSON.parse(row.manifest_json),now);return;
 }
 const days=await domainDays(db,format,participantId);
 let replacement:{day:string;manifestId:string;manifestDigest:string};
 if(kind==='unrelated_append'||kind==='metadata_change'){
  const prior=await db.prepare(`SELECT manifest.manifest_json FROM telemetry_v11_domain_heads head
   JOIN telemetry_v11_domain_days day ON day.generation_id=head.generation_id JOIN telemetry_v11_day_manifests manifest ON manifest.id=day.manifest_id
   WHERE head.participant_id=? AND day.observed_day=?`).bind(participantId,day).first<{manifest_json:string}>();
  if(!prior)throw Error('MUTATION_APPEND_PRIOR_MANIFEST');
  const accepted=JSON.parse(prior.manifest_json) as {parserVersion:string;consent:unknown;excluded:unknown;chunks:unknown[]};
  expect(accepted.chunks,'APPEND_REQUIRES_GENUINE_EMPTY_SELECTED_DAY').toEqual([]);
  const prepared=await native.makeV11Day(day,{usage:[native.v11UsageRecord(day,'f')]},
   kind==='unrelated_append'?accepted.parserVersion:'synthetic-mutation-capture-v11');
  expect(prepared.manifest.consent).toEqual(accepted.consent);expect(prepared.manifest.excluded).toEqual(accepted.excluded);
  if(kind==='unrelated_append')expect(prepared.manifest.parserVersion).toBe(accepted.parserVersion);
  else expect(prepared.manifest.parserVersion).not.toBe(accepted.parserVersion);
  await native.registerTelemetryV11DayManifest(db,principal,prepared.manifest,now);
  for(const chunk of prepared.chunks){const label='synthetic-mutation:'+chunk.manifestDigest+':'+chunk.chunkId;
   await native.persistTypedV11StagedChunk(db,principal,chunk,{sourceNamespace,chunkRowId:'chunk:'+(await sha256Hex(label)).slice(0,36),
    r2Key:'synthetic/mutation/'+await sha256Hex(label),...await grant(db,principal,label,now)},now);}
  replacement=await native.registerTelemetryV11DayManifest(db,principal,prepared.manifest,now);
 }else{
  const records:TelemetryV12Record[]=[];
  for(const stream of ['quota','session','usage'] as const){
   const page=await native.readTelemetryV12EffectivePage(db,{participantId,day,stream,limit:200});
   expect(page.available).toBe(true);expect(page.next===null).toBe(true);records.push(...page.records.map(row=>JSON.parse(row.sourceRecordJson) as TelemetryV12Record));
  }
  // An additive occurrence preserves every accepted old occurrence while changing the old day's accepted input.
  const exemplar=records.find((r):r is TelemetryV12UsageEvent=>r.schemaVersion==='usage-event-v1.2');
  if(!exemplar)throw Error('MUTATION_CORRECTION_RECORD');records.push({...structuredClone(exemplar),eventId:'event:v2:'+'e'.repeat(64)});
  const consent=native.telemetryV12RequiredConsent(),chunks:TelemetryV12Chunk[]=[];
  for(const stream of ['quota','session','usage'] as const){const selected=records.filter(r=>r.schemaVersion.startsWith(stream+'-'));if(!selected.length)continue;
   chunks.push({schemaVersion:'telemetry-contribution-v1.2',manifestDigest:'0'.repeat(64),chunkId:stream+':'+day+':0',chunkRevision:1,
    chunkDigest:await sha256Hex(native.canonicalTelemetryV12Json(selected)),parserVersion:'synthetic-mutation-capture-v12',consent,records:selected});}
  const manifest:TelemetryV12DayManifest={schemaVersion:'telemetry-day-manifest-v1.2',day,parserVersion:'synthetic-mutation-capture-v12',consent,
   chunks:chunks.map(c=>({chunkId:c.chunkId,chunkDigest:c.chunkDigest,recordCount:c.records.length})),excluded:{quota:0,session:0,usage:0},manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(native.telemetryV12DayManifestDigestInput(manifest));
  await native.registerTelemetryV12DayManifest(db,principal,manifest,now);
  for(const chunk of chunks){chunk.manifestDigest=manifest.manifestDigest;const label='synthetic-mutation:'+manifest.manifestDigest+':'+chunk.chunkId;
   await native.persistTelemetryV12StagedChunk(db,principal,chunk,{chunkRowId:'chunk:'+(await sha256Hex(label)).slice(0,36),
    r2Key:'synthetic/mutation/'+await sha256Hex(label),...await grant(db,principal,label,now)},now);}
  replacement=await native.registerTelemetryV12DayManifest(db,principal,manifest,now);
 }
 const index=days.findIndex(d=>d.day===day);if(index<0)throw Error('MUTATION_DAY_OUTSIDE_DOMAIN');days[index]={day:replacement.day,manifestId:replacement.manifestId,manifestDigest:replacement.manifestDigest};
 if(kind==='unrelated_append'||kind==='metadata_change'){
  const p=await native.createTelemetryV11DomainPredecessor(db,principal,now),manifest={schemaVersion:'telemetry-domain-manifest-v1.1' as const,
   fromDay:days[0]!.day,throughDay:days.at(-1)!.day,predecessor:{token:p.token,previousGenerationId:p.previousGenerationId,legacyFingerprint:p.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(native.telemetryV11DomainManifestDigestInput(manifest));await native.activateTelemetryV11Domain(db,principal,manifest,now);
 }else{
  const p=await native.createTelemetryV12DomainPredecessor(db,principal,now),manifest={schemaVersion:'telemetry-domain-manifest-v1.2' as const,
   fromDay:days[0]!.day,throughDay:days.at(-1)!.day,predecessor:{token:p.token,previousGenerationId:p.previousGenerationId,legacyFingerprint:p.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(native.telemetryV12DomainManifestDigestInput(manifest));await native.activateTelemetryV12Domain(db,principal,manifest,now);
 }
}
 return mutate;
}
