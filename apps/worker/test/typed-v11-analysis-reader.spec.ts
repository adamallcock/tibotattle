import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json,telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource,readIngestionChanges, STORAGE_OPERATING_BUDGET_BYTES } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11ExportEntries } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin } from "../src/telemetry-v11-domain";
import { accountScopedQuotaAnalysisV11 } from "../src/quota-analysis-v11";
import { loadTypedV11AnalysisScope,readTypedV11UsageAnalysisPage, readTypedV11ChunkRecords, TYPED_V11_USAGE_PAGE_SQL } from "../src/typed-v11-analysis-reader";
import { typedTelemetryReadNamespace } from "../src/typed-telemetry-read-layout";
import { sha256Hex } from "../src/crypto";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from "../src/storage-analytics-runtime";
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult } from "../src/storage-community-graph";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { readPublishedStorageCommunityDaily } from "../src/storage-community-daily";
import { readPublishedStorageCommunityGraph } from "../src/storage-community-graph-publication";
import { readStorageCommunityProgress } from "../src/storage-community-progress";
import { handleRequest } from "../src/index";
import { runBackendLifecycle } from "../src/retention";
import { reconcilePendingQuarantineObjects } from "../src/quarantine-reconciliation";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { persistTypedTelemetryBatch } from "../src/typed-telemetry-repository";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from "../src/typed-telemetry-origins";
import { advanceV11DailyProjection,readV11ProjectedOwnerDays } from "../src/v11-daily-projection";

const b=env as Env & { STORAGE_INGESTION_A:D1Database; TEST_MIGRATIONS:D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];
  STORAGE_ANALYTICS_DB:D1Database;TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[] };
const typed=()=>b.STORAGE_INGESTION_A, legacy=()=>b.USAGE_MONITOR_DB;
const namespace="synthetic-analysis-source", participantId="participant:synthetic-analysis";
const day=()=>new Date().toISOString().slice(0,10);
type Fixture=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Prepared=Awaited<ReturnType<typeof makeV11Day>>;
const binary=(value:string)=>Uint8Array.from(encodeTypedTelemetryId(value)).buffer;
beforeEach(async()=>{
  await reset();
  await applyD1Migrations(legacy(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(typed(),b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(typed(),namespace);
  await initializeTypedV11Admission(typed(),namespace);
});
async function stage(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  if(!isTyped)return stageV11Day(db,f,prepared);
  await registerTelemetryV11DayManifest(db,f,prepared.manifest);
  for(const chunk of prepared.chunks){
    const digest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const device=await authenticateDevice(db,f.authorization);
    const grant=await createDeviceUploadAuthorization(db,device,digest,200);
    const claim=await claimDeviceUploadAuthorization(db,`Upload ${grant.uploadAuthorization}`,
      {envelopeDigest:digest,bodyBytes:200,contentType:"application/json"});
    await persistTypedV11StagedChunk(db,f,chunk,{sourceNamespace:namespace,
      chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,
      envelopeDigest:digest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  return registerTelemetryV11DayManifest(db,f,prepared.manifest);
}
async function activate(db:D1Database,f:Fixture,prepared:Prepared,isTyped:boolean){
  const candidate=await stage(db,f,prepared,isTyped);
  const prior=await createTelemetryV11DomainPredecessor(db,f);
  const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",
    fromDay:day(),throughDay:day(),predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
      legacyFingerprint:prior.legacyFingerprint},days:[{day:day(),manifestId:candidate.manifestId,
      manifestDigest:candidate.manifestDigest}],manifestDigest:"0".repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db,f,manifest);
}
async function retainStagedV11Origin(f:Fixture,prepared:Prepared,sourceNamespace:string){
 const manifestId=(await typed().prepare('SELECT id FROM telemetry_v11_day_manifests WHERE manifest_digest=?')
  .bind(prepared.manifest.manifestDigest).first<string>('id'))!;
 const header=(await typed().prepare('SELECT id FROM telemetry_v11_chunks WHERE manifest_id=?').bind(manifestId).first<string>('id'))!;
 const oldProof=(await typed().prepare(`SELECT p.base_digest,p.legacy_occurrence_blob,p.legacy_digest
  FROM typed_v11_record_proofs p JOIN typed_v11_chunk_allocations a ON a.namespace_id=(SELECT namespace_id FROM typed_telemetry_records WHERE id=p.typed_record_id)
  JOIN typed_telemetry_chunks c ON c.id=p.chunk_key AND c.namespace_id=a.namespace_id AND c.original_id=a.chunk_original
  WHERE a.chunk_id=?`).bind(header).first<{base_digest:ArrayBuffer;legacy_occurrence_blob:ArrayBuffer|null;legacy_digest:ArrayBuffer|null}>())!;
 const recordIds=(await typed().prepare(`SELECT p.typed_record_id FROM typed_v11_record_proofs p
  JOIN typed_v11_chunk_allocations a ON a.namespace_id=(SELECT namespace_id FROM typed_telemetry_records WHERE id=p.typed_record_id)
  JOIN typed_telemetry_chunks c ON c.id=p.chunk_key AND c.namespace_id=a.namespace_id AND c.original_id=a.chunk_original
  WHERE a.chunk_id=?`).bind(header).all<{typed_record_id:number}>()).results;
 await typed().batch(recordIds.map(row=>typed().prepare('DELETE FROM typed_v11_record_proofs WHERE typed_record_id=?').bind(row.typed_record_id)));
 await typed().prepare('DELETE FROM typed_v11_manifest_memberships WHERE manifest_id=?').bind(manifestId).run();
 await typed().prepare('DELETE FROM typed_v11_chunk_allocations WHERE chunk_id=?').bind(header).run();
 const rows=prepared.chunks[0]!.records.map((record,index)=>({sourceNamespace,format:'v11' as const,sourceRowId:index+1,
  participantId:f.participantId,deviceId:f.deviceId,chunkRowId:header,manifestId,chunkDay:prepared.manifest.day,
  observedDay:prepared.manifest.day,record}));
 const allocated=(await typed().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='typed_v11_typed_row_allocation'").first<string>('sql'))!;
 await typed().exec('DROP TRIGGER typed_v11_typed_row_allocation');await persistTypedTelemetryBatch(typed(),rows);await typed().prepare(allocated).run();
 const namespaceId=(await typed().prepare('SELECT id FROM typed_telemetry_namespaces WHERE original_id=?').bind(binary(sourceNamespace)).first<number>('id'))!;
 await typed().prepare(`INSERT INTO typed_telemetry_origin_contracts(namespace_id,namespace_original,access_mode,
  v1_read_contract_version,v11_read_contract_version,source_schema_digest,registered_move_id,registered_at)
  VALUES(?,?,'retained-read',0,2,?,'synthetic-v11-reader-move','2026-09-13T00:00:00.000Z')`)
  .bind(namespaceId,binary(sourceNamespace),TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).run();
 const core=(await typed().prepare(`SELECT r.id record_id,r.owner_id,r.chunk_id chunk_key,r.manifest_id manifest_key,
  r.stream stream_code,r.occurrence_id occurrence_blob,r.observed_at_ms FROM typed_telemetry_records r
  WHERE r.namespace_id=? AND r.format=11 ORDER BY r.source_row_id`).bind(namespaceId)
  .all<{record_id:number;owner_id:number;chunk_key:number;manifest_key:number;stream_code:number;occurrence_blob:ArrayBuffer;observed_at_ms:number}>()).results;
 await typed().prepare('INSERT INTO typed_v11_owner_memberships(participant_id,namespace_id,typed_owner_id) VALUES(?,?,?)')
  .bind(f.participantId,namespaceId,core[0]!.owner_id).run();
 const allocationSql=[];for(const name of ['typed_v11_allocation_guard','typed_v11_allocation_advance']){
  allocationSql.push((await typed().prepare('SELECT sql FROM sqlite_schema WHERE type=\'trigger\' AND name=?').bind(name).first<string>('sql'))!);
  await typed().exec(`DROP TRIGGER ${name}`);
 }
 await typed().prepare(`INSERT INTO typed_v11_chunk_allocations(chunk_id,namespace_id,chunk_original,first_source_row_id,record_count)
  VALUES(?,?,?,?,?)`).bind(header,namespaceId,binary(header),1,rows.length).run();
 for(const sql of allocationSql)await typed().prepare(sql).run();
 const typedManifest=(await typed().prepare('SELECT id FROM typed_telemetry_manifests WHERE namespace_id=? AND original_id=?')
  .bind(namespaceId,binary(manifestId)).first<number>('id'))!;
 await typed().prepare('INSERT INTO typed_v11_manifest_memberships(manifest_id,namespace_id,typed_manifest_id) VALUES(?,?,?)')
  .bind(manifestId,namespaceId,typedManifest).run();
 const membershipTrigger=(await typed().prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='typed_v11_record_membership'")
  .first<string>('sql'))!;await typed().exec('DROP TRIGGER typed_v11_record_membership');
 await typed().batch(core.map(row=>typed().prepare(`INSERT INTO typed_v11_record_proofs(typed_record_id,chunk_key,manifest_key,
  stream_code,occurrence_blob,base_digest,legacy_occurrence_blob,legacy_digest,observed_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
  .bind(row.record_id,row.chunk_key,row.manifest_key,row.stream_code,row.occurrence_blob,oldProof.base_digest,
    oldProof.legacy_occurrence_blob,oldProof.legacy_digest,row.observed_at_ms)));
 await typed().prepare(membershipTrigger).run();
 return manifestId;
}
function evidence(){
  const start=Date.parse(day()+"T01:00:00.000Z");
  const attribution={accountBasis:"same_source" as const,accountTrackId:"account-track:v2:"+"a".repeat(64),
    planBasis:"same_source_occurrence" as const,planType:"pro" as const,planEraId:null};
  const quota:TelemetryV11QuotaObservation[]=Array.from({length:9},(_,i)=>({schemaVersion:"quota-observation-v1.1",
    observationId:`quota:synthetic:${i}`,observedTime:new Date(start+i*300000).toISOString(),provider:"openai_codex",
    planType:"pro",planVariant:"unknown",limitId:"codex",slot:"seven_day",usedPercent:10+i*5,
    windowDurationMinutes:10080,resetsAt:new Date(start+7*86400000).toISOString(),accountPlanAttribution:{...attribution}}));
  const usage=Array.from({length:8},(_,i)=>v11UsageRecord(day(),"a",{eventId:`event:synthetic:${i}`,
    eventTime:new Date(start+i*300000+150000).toISOString(),accountPlanAttribution:{...attribution}}));
  return {quota,usage};
}

describe("typed active-domain analytical reads",()=>{
  it("reads one active owner across retained and current manifest origins without relabeling",async()=>{
    const firstDay=new Date(Date.parse(day()+"T00:00:00.000Z")-86400000).toISOString().slice(0,10);
    const secondDay=day(),retainedNamespace="synthetic-analysis-retained";
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const firstPrepared=await makeV11Day(firstDay,{usage:[v11UsageRecord(firstDay,"a",{eventId:`event:v2:${"1".repeat(64)}`})]});
    const first=await stage(typed(),f,firstPrepared,true);await retainStagedV11Origin(f,firstPrepared,retainedNamespace);
    const secondPrepared=await makeV11Day(secondDay,{usage:[v11UsageRecord(secondDay,"b",{eventId:`event:v2:${"2".repeat(64)}`})]});
    const second=await stage(typed(),f,secondPrepared,true);
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    const prior=await createTelemetryV11DomainPredecessor(typed(),f);
    const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",fromDay:firstDay,throughDay:secondDay,
      predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
      days:[{day:firstDay,manifestId:first.manifestId,manifestDigest:first.manifestDigest},
        {day:secondDay,manifestId:second.manifestId,manifestDigest:second.manifestDigest}],manifestDigest:"0".repeat(64)};
    manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(typed(),f,manifest);
    const pin=(await loadV11SourcePin(typed(),participantId))!,scope=(await loadTypedV11AnalysisScope(typed(),participantId))!;
    expect(scope.origins.map(origin=>origin.sourceNamespace)).toEqual([namespace,retainedNamespace].sort());
    const read=async(targetDay:string)=>readTypedV11UsageAnalysisPage(typed(),{scope,pin,day:targetDay,
      from:targetDay+"T00:00:00.000Z",to:targetDay+"T23:59:59.999Z",afterTime:targetDay+"T00:00:00.000Z",afterOccurrence:""});
    expect(await read(firstDay)).toMatchObject([{source_namespace:retainedNamespace}]);
    expect(await read(secondDay)).toMatchObject([{source_namespace:namespace}]);
    expect((await read(firstDay))[0]!.record_json).toBe(canonicalTelemetryV11Json(firstPrepared.chunks[0]!.records[0]!));
    const change=(await readIngestionChanges(typed(),namespace,0,1))[0]!;
    const retainedContract=await typed().prepare(`SELECT namespace_id,namespace_original,access_mode,
      v1_read_contract_version,v11_read_contract_version,source_schema_digest,registered_move_id,registered_at
      FROM typed_telemetry_origin_contracts WHERE source_namespace=?`).bind(retainedNamespace).first<Record<string,unknown>>();
    const retainedTrigger=(await typed().prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='typed_telemetry_origin_retained'`).first<string>('sql'))!;
    let sourcePageRead=false;
    const changingSource=new Proxy(typed(),{get(db,key){
      if(key==='prepare')return(sql:string)=>{
        const statement=db.prepare(sql);
        if(!sql.includes('FROM typed_v11_record_admissions'))return statement;
        const wrap=(candidate:D1PreparedStatement):D1PreparedStatement=>new Proxy(candidate,{get(stmt,method){
          if(method==='bind')return(...args:unknown[])=>wrap(Reflect.apply(stmt.bind,stmt,args));
          if(method==='all')return async(...args:unknown[])=>{
            const result=await Reflect.apply(stmt.all,stmt,args);
            if(!sourcePageRead){sourcePageRead=true;await typed().exec('DROP TRIGGER typed_telemetry_origin_retained');
              await typed().prepare('DELETE FROM typed_telemetry_origin_contracts WHERE source_namespace=?')
                .bind(retainedNamespace).run();await typed().prepare(retainedTrigger).run();}
            return result;
          };
          const value=Reflect.get(stmt,method,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
        return wrap(statement);
      };
      const value=Reflect.get(db,key,db);return typeof value==='function'?value.bind(db):value;
    }});
    await expect(advanceV11DailyProjection({source:changingSource,target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,
      sourceLayout:{kind:'typed-v11',sourceNamespace:namespace}})).rejects.toThrow();
    expect(await b.STORAGE_ANALYTICS_DB.prepare('SELECT count(*) n FROM analytics_v11_day_references').first('n')).toBe(0);
    await typed().prepare(`INSERT INTO typed_telemetry_origin_contracts(namespace_id,namespace_original,access_mode,
      v1_read_contract_version,v11_read_contract_version,source_schema_digest,registered_move_id,registered_at)
      VALUES(?,?,?,?,?,?,?,?)`).bind(...Object.values(retainedContract!)).run();
    for(let n=0;n<5;n++)await advanceV11DailyProjection({source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,
      sourceLayout:{kind:"typed-v11",sourceNamespace:namespace}});
    const projected=await readV11ProjectedOwnerDays({source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,
      ownerDigest:change.ownerDigest,fromDay:firstDay,throughDay:secondDay});
    expect(projected.state).toBe("available");
    expect(projected.values.map(value=>[value.day,value.counts.usage])).toEqual([[firstDay,1],[secondDay,1]]);
    expect((await b.STORAGE_ANALYTICS_DB.prepare(`SELECT day,source_namespace FROM analytics_v11_reusable_values
      WHERE owner_digest=? ORDER BY day`).bind(change.ownerDigest).all()).results)
      .toEqual([{day:firstDay,source_namespace:retainedNamespace},{day:secondDay,source_namespace:namespace}]);
  });
  it("qualifies ingestion independently of analytics without claiming its rebuild completed",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
    const now=Date.now();
    await runBackendLifecycle(typed(),b.DELETION_LEDGER,b.QUARANTINE,now);
    await reconcilePendingQuarantineObjects(typed(),b.QUARANTINE,now);
    const settings:Env={...b,USAGE_MONITOR_DB:typed()};
    Reflect.set(settings,'TELEMETRY_STORAGE_MODE','typed');
    Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE',namespace);
    Object.defineProperty(settings,'ANALYTICS_DB',{get(){throw new Error('analytics offline');}});
    const response=await handleRequest(new Request('https://example.test/api/ready'),settings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:'ready',checks:{aggregateRebuildComplete:false,aggregateRebuildDelegated:true}});
    Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE','uninitialized-source');
    expect((await handleRequest(new Request('https://example.test/api/ready'),settings)).status).toBe(503);
  });
  it("advances the independent scheduler through daily and graph publication without legacy analytical writes",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence()),true);
    let available=false;
    for(let n=0;n<12;n++){
      const pass=await runStorageAnalyticsPass({...bindings,publishCommunity:true,maxSteps:3});
      expect(pass.queriesUsed).toBeLessThanOrEqual(900);
      const daily=await readPublishedStorageCommunityDaily({...bindings,fromDay:day(),throughDay:day()});
      if(daily.rows.length>0&&await readPublishedStorageCommunityGraph(bindings)){available=true;break;}
    }
    expect(available).toBe(true);
    const progress=await readStorageCommunityProgress(bindings,Date.now(),{includePreparation:true});
    expect(progress.publication.state).toBe('ready');expect(progress.work.updatedAt).not.toBeNull();
    expect(JSON.stringify(progress)).not.toContain(participantId);
    expect(await typed().prepare('SELECT count(*) n FROM community_allowance_fit_cache').first('n')).toBe(0);
    expect(await typed().prepare('SELECT count(*) n FROM community_prepared_usage_rows').first('n')).toBe(0);
    // The operating cap blocks new calculation, but must not trap obsolete
    // results forever, including while public serving is paused.
    await bindings.target.prepare(`INSERT INTO analytics_community_model_publications
      SELECT source_id,'2000-01-01',revision,method,cohort_digest,authority_json,payload_json,payload_sha256,computed_ms
      FROM analytics_community_model_publications LIMIT 1`).run();
    expect(await bindings.target.prepare("SELECT count(*) n FROM analytics_community_model_publications WHERE day='2000-01-01'").first('n')).toBe(1);
    await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    const before=await bindings.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(namespace).first('sequence');
    const full=new Proxy(bindings.target,{get(db,key){
      if(key==='prepare')return (sql:string)=>{
        const statement=db.prepare(sql);
        if(sql!=='SELECT 1 AS capacity_probe')return statement;
        return new Proxy(statement,{get(stmt,method){
          if(method==='run')return async()=>{const receipt=await stmt.run();
            return {...receipt,meta:{...receipt.meta,size_after:STORAGE_OPERATING_BUDGET_BYTES}};};
          const value=Reflect.get(stmt,method,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(db,key,db);return typeof value==='function'?value.bind(db):value;
    }});
    const capped=await runStorageAnalyticsPass({...bindings,target:full,publishCommunity:true,maxSteps:1});
    expect(capped.reason).toBe('capacity');expect(capped.steps).toBe(0);expect(capped.graphCalculations).toBe(0);
    expect(await bindings.target.prepare("SELECT count(*) n FROM analytics_community_model_publications WHERE day='2000-01-01'").first('n')).toBe(0);
    expect(await bindings.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(namespace).first('sequence')).toBe(before);
  },60000);
  it("preserves scalar quota results while keeping the JSON record table empty",async()=>{
    const a=await createV11DeviceFixture(legacy(),{participantId,grant:true});
    const c=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const prepared=await makeV11Day(day(),evidence());
    await activate(legacy(),a,prepared,false);await activate(typed(),c,prepared,true);
    const old=await accountScopedQuotaAnalysisV11(legacy(),participantId);
    const next=await accountScopedQuotaAnalysisV11(typed(),participantId);
    const summarize=(value:object)=>{
      const parsed=value as {status:string;tracks:Array<{continuity:{accountScopeId:string;planType:string};
        calibration:{tracks:Array<{resets:Array<{status:string;capacityNanousd:number|null;refusalCodes:string[]}>}>}}>};
      return {status:parsed.status,tracks:parsed.tracks.map(t=>({account:t.continuity.accountScopeId,plan:t.continuity.planType,
        resets:t.calibration.tracks.flatMap(q=>q.resets.map(r=>({status:r.status,capacity:r.capacityNanousd,refusals:r.refusalCodes})))}))};
    };
    expect(summarize(old).tracks).toHaveLength(1);
    expect(summarize(old).tracks[0]!.resets.some(r=>r.capacity!==null)).toBe(true);
    expect(summarize(next)).toEqual(summarize(old));
    expect(await typed().prepare("SELECT count(*) FROM telemetry_v11_records").first("count(*)")).toBe(0);
  });

  it("pages exact usage across chunks and rejects a different namespace",async()=>{
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const records=Array.from({length:5003},(_,i)=>v11UsageRecord(day(),"a",{eventId:`event:synthetic:${i.toString().padStart(5,"0")}`,
      eventTime:new Date(Date.parse(day()+"T01:00:00.000Z")+i*1000).toISOString()}));
    await activate(typed(),f,await makeV11Day(day(),{usage:records}),true);
    const pin=(await loadV11SourcePin(typed(),participantId))!;
    const scope=(await loadTypedV11AnalysisScope(typed(),participantId))!;
    const options={scope,pin,day:day(),from:day()+"T00:00:00.000Z",to:day()+"T23:59:59.999Z",
      afterTime:day()+"T00:00:00.000Z",afterOccurrence:""};
    const meter=createD1InvocationBudget(1);
    const first=await readTypedV11UsageAnalysisPage(meter.wrap(typed()),options);
    expect(first).toHaveLength(5000);
    expect(meter.queriesUsed).toBe(1);
    const second=await readTypedV11UsageAnalysisPage(typed(),{...options,afterTime:first.at(-1)!.observed_at,
      afterOccurrence:first.at(-1)!.occurrence_id,afterSourceNamespace:first.at(-1)!.source_namespace});
    expect(second).toHaveLength(3);
    expect([...first,...second].map(r=>JSON.parse(r.record_json))).toEqual(records);
    await expect(readTypedV11UsageAnalysisPage(typed(),{...options,scope:{...scope,origins:[]}})).rejects.toThrow();
    const explain=await typed().prepare("EXPLAIN QUERY PLAN "+TYPED_V11_USAGE_PAGE_SQL).bind(participantId,pin.generationId,
      day(),Date.parse(options.from),Date.parse(options.to),Date.parse(options.afterTime),"","",200).all<{detail:string}>();
    expect(explain.results.some(r=>r.detail.includes("MATERIALIZE page"))).toBe(true);
    expect(explain.results.some(r=>r.detail.includes("MATERIALIZE scoped"))).toBe(false);
    expect(explain.results.some(r=>r.detail.includes("typed_v11_manifest_observed"))).toBe(true);
  },60_000);

  it("exports staged typed records through the existing private export iterator",async()=>{
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    const records=[v11UsageRecord(day(),"b"),v11UsageRecord(day(),"a")];
    await stage(typed(),f,await makeV11Day(day(),{usage:records}),true);
    const entries=[];for await(const entry of telemetryV11ExportEntries(typed(),participantId,new Date().toISOString()))entries.push(entry);
    const chunks=entries.filter(x=>Reflect.get(x,"kind")==="chunk");expect(chunks).toHaveLength(1);
    expect(Reflect.get(chunks[0]!,"records")).toEqual([...records].reverse());
    expect(Reflect.get(chunks[0]!,"activeWhenRead")).toBe(false);
    const chunkId=(await typed().prepare("SELECT id FROM telemetry_v11_chunks").first<string>("id"))!;
    await expect(readTypedV11ChunkRecords(typed(),{sourceNamespace:namespace,participantId:"foreign",chunkId,expectedCount:2})).rejects.toThrow();
    expect(await typedTelemetryReadNamespace(legacy())).toBeNull();
  });

  it("calculates and reuses exact allowance fits in the separate database, then fences a policy change",async()=>{
    await applyD1Migrations(typed(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(typed(),namespace);
    await applyD1Migrations(typed(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(b.STORAGE_ANALYTICS_DB,b.TEST_ANALYTICS_MIGRATIONS);
    expect((await drainCommunityPublicSourceBootstrap(typed())).completed).toBe(true);
    const bindings={source:typed(),target:b.STORAGE_ANALYTICS_DB,sourceId:namespace,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(bindings);
    const f=await createV11DeviceFixture(typed(),{participantId,grant:true});
    await activate(typed(),f,await makeV11Day(day(),evidence()),true);
    const owner=(await readStorageCommunityOwnerPage(typed()))[0]!;
    const scope=await captureStorageGraphScope(typed(),{owner,day:day(),metric:"fits",sourceId:namespace,sourceNamespace:namespace});
    const computed=await computeStorageGraphResult(bindings,scope);
    expect(computed.state).toBe("complete");
    if(computed.state!=="complete")throw new Error("synthetic fit did not complete");
    expect(computed.result.fits!.length).toBeGreaterThan(0);
    expect(computed.result.fits!.every(fit=>fit.participantId===owner.ownerDigest)).toBe(true);
    expect(computed.reused).toBe(false);
    const meter=createD1InvocationBudget(20);
    const repeated=await computeStorageGraphResult({...bindings,source:meter.wrap(typed()),target:meter.wrap(bindings.target)},scope);
    expect(repeated.state==="complete"&&repeated.reused).toBe(true);
    expect(await typed().prepare("SELECT count(*) FROM community_allowance_fit_cache").first("count(*)")).toBe(0);
    expect(await typed().prepare("SELECT count(*) FROM telemetry_v11_records").first("count(*)")).toBe(0);
    expect(await bindings.target.prepare("SELECT count(*) FROM analytics_community_graph_results").first("count(*)")).toBe(1);
    await typed().prepare("UPDATE collection_controls SET publication_enabled=0,control_state='degraded',revision=revision+1 WHERE singleton=1").run();
    await expect(readStorageGraphResult(bindings,scope)).rejects.toThrow();
    expect(await typed().prepare("SELECT count(*) FROM typed_telemetry_records").first("count(*)")).toBe(17);
  });
});
