import { storageError } from './d1-storage-plan.mjs';
const assert=(value)=>{if(!value)throw storageError('RESTORED_RUNTIME_PROOF_FAILED');};
/** Synthetic credentials remain in memory; no bearer or owner ID is returned in
 * the content-free receipt. This uses the same enrollment/ownership APIs. */
export async function createSyntheticRestoreOwner(api,source){
 const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
 const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
 const bytes=new Uint8Array(prefix.length+secret.length);bytes.set(prefix);bytes.set(secret,prefix.length);
 const deviceSecretHash=await api.sha256Hex(bytes),authorization=`Device um_device_${deviceId}.${api.encodeBase64Url(secret)}`;
 secret.fill(0);bytes.fill(0);
 await api.enrollAccountlessDevice(source,api.parseAccountlessEnrollmentRequest({schemaVersion:'accountless-enrollment-v0.1',deviceId,deviceSecretHash,
  policyVersion:'accountless-opt-out-v1',authorizationBasis:'accountless-policy-v1'}));
 await api.createAccountlessUploadOwner(source,authorization,{schemaVersion:'accountless-upload-owner-v0.1',
  policyVersion:'accountless-opt-out-v1',authorizationBasis:'accountless-policy-v1',telemetrySchemaVersion:'telemetry-contribution-v1.1'});
 const participantId=await source.prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?').bind(deviceId).first('participant_id');
 assert(typeof participantId==='string');return {participantId,deviceId,authorization};
}
/** Mandatory local end-to-end gate AFTER immutable restore/measurement checks.
 * All erasure targets are synthetic restored copies; the frozen source is read
 * only. This is not permission to activate a remote app or reset its ledger. */
export async function verifyRestoredRuntime({api,source,ingestion,analytics,ledger,quarantine,contract,fixture,tombstoned,preparedDay,records,onProgress=()=>{}}){
 assert(source!==ingestion&&ingestion!==analytics&&ledger!==source&&ledger!==ingestion&&ledger!==analytics);
 const bindings={source:ingestion,target:analytics,ledger,sourceId:contract.sourceId,sourceNamespace:contract.sourceNamespace};
 const runtime={ENVIRONMENT:'synthetic-development',USAGE_MONITOR_DB:ingestion,ANALYTICS_DB:analytics,DELETION_LEDGER:ledger,
  QUARANTINE:quarantine,TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:contract.sourceNamespace};
 assert(await api.hasDeletionTombstone(ledger,tombstoned.participantId));
 // Check before binding any public app. Preserved ledger authority wins over a
 // restored active owner; never replace this ledger with an empty one.
 await api.initializeStorageAnalyticsRuntime(bindings);
 const suppression=await api.replayDeletionTombstones(ingestion,ledger,quarantine,Date.now(),undefined,true,bindings);
 assert(suppression.complete&&suppression.suppressed===1);
 assert(!await ingestion.prepare('SELECT 1 FROM participants WHERE id=?').bind(tombstoned.participantId).first());
 assert(await source.prepare('SELECT 1 FROM participants WHERE id=?').bind(tombstoned.participantId).first());
 const mode=await api.resolveTelemetryStorageMode(ingestion,runtime);
 const principal=await api.authenticateDevice(ingestion,fixture.authorization);
 assert(principal.participantId===fixture.participantId&&principal.deviceId===fixture.deviceId);
 for(const chunk of preparedDay.chunks)assert(await api.readTelemetryV11StorageReplay(ingestion,mode,fixture,chunk));
 const originalDay=preparedDay.manifest.day,newDay=new Date(Date.parse(originalDay)-86400000).toISOString().slice(0,10);
 const prepared=await api.makeV11Day(newDay,{usage:[api.v11UsageRecord(newDay,'f')]});
 const day=await api.registerTelemetryV11DayManifest(ingestion,fixture,prepared.manifest);
 for(const chunk of prepared.chunks){
  const envelopeDigest=await api.sha256Hex(`synthetic-restored-runtime:${chunk.chunkDigest}`);
  const issued=await api.createDeviceUploadAuthorization(ingestion,principal,envelopeDigest,200);
  const claimed=await api.claimDeviceUploadAuthorization(ingestion,`Upload ${issued.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
  await api.persistTelemetryV11StorageChunk(ingestion,mode,fixture,chunk,{chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:'synthetic/new-runtime',envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId});
 }
 const existing=await api.registerTelemetryV11DayManifest(ingestion,fixture,preparedDay.manifest);
 const previous=await api.createTelemetryV11DomainPredecessor(ingestion,fixture);
 const manifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:newDay,throughDay:originalDay,
  predecessor:{token:previous.token,previousGenerationId:previous.previousGenerationId,legacyFingerprint:previous.legacyFingerprint},
  days:[{day:newDay,manifestId:day.manifestId,manifestDigest:day.manifestDigest},{day:originalDay,manifestId:existing.manifestId,manifestDigest:existing.manifestDigest}],manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await api.sha256Hex(api.telemetryV11DomainManifestDigestInput(manifest));await api.activateTelemetryV11Domain(ingestion,fixture,manifest);
 let passes=0;async function drain(){for(let n=0;n<128;n++){
  onProgress({stage:'restored-runtime-drain',steps:passes});passes++;
  const result=await api.runStorageAnalyticsPass({...bindings,maxSteps:8,publishCommunity:false});
  if(result.state==='idle')return;
 }throw storageError('RESTORED_RUNTIME_DRAIN_LIMIT');}
 await drain();
 const ownerDigest=await ingestion.prepare('SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?').bind(fixture.participantId).first('owner_digest');
 const read=()=>api.readV11ProjectedOwnerDays({source:ingestion,target:analytics,sourceId:contract.sourceId,ownerDigest,fromDay:newDay,throughDay:originalDay});
 const values=await read();assert(values.state==='available'&&values.values.length===2);
 assert(values.values.reduce((n,v)=>n+v.counts.usage,0)===records+1);
 assert(values.values.reduce((n,v)=>n+BigInt(v.tokens.nonOverlappingTotal.knownSum),0n)===BigInt(records+1)*1075n);
 assert(values.values.every(v=>v.tokens.nonOverlappingTotal.unavailable===0&&v.counts.quota===0&&v.counts.session===0));
 assert(await api.revokeAccountlessEnrollment(ingestion,fixture.deviceId,'user_opt_out',Date.now()));
 assert((await read()).state==='authority-unavailable');
 let refused=false;try{await api.authenticateDevice(ingestion,fixture.authorization);}catch{refused=true;}assert(refused);
 await drain();assert((await read()).values.length===0);
 const erased=await api.eraseParticipantAsOwner(runtime,'synthetic-restore-owner',fixture.participantId);assert(erased.deleted);
 await drain();
 assert(await api.hasDeletionTombstone(ledger,fixture.participantId));
 assert(!await ingestion.prepare('SELECT 1 FROM participants WHERE id=?').bind(fixture.participantId).first());
 assert(await ledger.prepare("SELECT 1 FROM storage_erasure_jobs WHERE state='pending' LIMIT 1").first()===null);
 assert(await analytics.prepare('SELECT count(*) n FROM analytics_v11_value_pages').first('n')===0);
 assert(await source.prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')===records);
 assert(await source.prepare('SELECT 1 FROM accountless_enrollment_ledger WHERE device_id=? AND state=\'active\'').bind(fixture.deviceId).first());
 return {schema:'d1-storage-restored-runtime-v1',status:'passed',scope:'synthetic-restored-ingestion-analytics-erasure',
  credentialsPreserved:true,acceptedReceiptReplayVerified:true,newUploadAccepted:true,journalDrained:true,dailyValuesExact:true,
  retainedTombstoneSuppressed:true,optOutImmediate:true,revokedCredentialsRefused:true,physicalErasureComplete:true,
  independentLedgerPreserved:true,sourceUnchanged:true,passes,recordsBefore:records,recordsAfterAccepted:records+1,
  publicGraphQualification:'separate',remoteOperations:false,runtimeActivationAuthorized:false};
}
