import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { warmCommunityAnalysisCaches } from "../src/community-analysis-warmer";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL, CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL,
  COMMUNITY_ATTRIBUTION_METHOD_VERSION, communityAnalysisCachesCurrent, loadCommunitySourcePin,
  publishCommunityAnalysisCaches, readCachedCommunityAllowanceCorpus, readCachedCommunityModelCompositions,
  type CommunityAnalysisCacheIdentity } from "../src/community-allowance";
import { warmAdminCommunityAllowancePreviewCache } from "../src/admin-community-allowance";
import { rebuildPendingCommunityDailyAggregates } from "../src/community-daily-aggregates";
import { V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, V1_ANALYSIS_WINDOW_DAYS } from "../src/quota-analysis-v1";
import { V1_PLAN_QUOTA_PAGE_SQL, V1_FIT_QUOTA_PAGE_SQL } from "../src/quota-fit-projection";
import { V1_PREPARATION_SOURCE_PAGE_SQL, V1_PREPARED_PLAN_PAGE_SQL, V1_PREPARED_FIT_PAGE_SQL } from "../src/prepared-v1-evidence";
import { createV11DeviceFixture, makeV11Day, stageV11Day } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { createUploadAuthorizationMaterial, storeUploadAuthorization, claimUploadAuthorization } from "../src/session";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";
import { beginCommunityAnalysisWork, type CommunityAnalysisWorkIdentity } from "../src/community-analysis-work";
import { V1_QUOTA_ACQUISITION_VERSION } from "../src/quota-analysis-v1-reader";

const db = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-01T12:00:00.000Z"), DAY = "2026-08-01";
const TIME = `${DAY}T00:00:00.000Z`, RESET = "2026-08-08T00:00:00.000Z", LEASE = "synthetic-warmer-lease";
const FROM = new Date(NOW-V1_ANALYSIS_WINDOW_DAYS*86_400_000).toISOString().slice(0,10);
const allocation = (remainingQueries=800) => ({ remainingQueries,deadlineMs:Date.now()+30_000 });
const refusal = { status:"not_testable" as const,reason:"plan_attribution_limit_exceeded" };

beforeEach(async () => {
  await reset();await applyD1Migrations(db(),(env as Env & {TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS);
  await db().prepare("UPDATE retention_state SET maintenance_lease_token=?,maintenance_lease_expires_at='2027-01-01T00:00:00.000Z' WHERE singleton=1")
    .bind(LEASE).run();
});

async function seed(participantId="warmer-participant",count=120) {
  const fixture=await createV11DeviceFixture(db(),{participantId});
  const principal=await authenticateDevice(db(),fixture.authorization);
  for(let offset=0;offset<count;offset+=200) {
    const digest=(offset+1).toString(16).padStart(64,"0");
    const upload=await createDeviceUploadAuthorization(db(),principal,digest,200);
    const claimed=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,
      {envelopeDigest:digest,bodyBytes:200,contentType:"application/json"});
    await db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES (?,?,?,'quota',?,?,1,?,?,'synthetic-warmer',?,?,?,?,?)`)
      .bind(`${participantId}:chunk:${offset}`,participantId,fixture.deviceId,DAY,offset/200,digest,digest,
        Math.min(200,count-offset),Math.min(200,count-offset),`synthetic/warmer/${participantId}/${offset}`,claimed.authorizationId,TIME).run();
  }
  await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
      provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json)
    SELECT ?||':chunk:'||(CAST((n-1)/200 AS INTEGER)*200),?,?,'quota','synthetic-quota-'||n,
      strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||n||' seconds'),?,'openai_codex','pro','unknown','codex','seven_day',
      CAST((n-1)/2 AS INTEGER)%100,10080,?,'{}' FROM s`)
    .bind(count,participantId,participantId,fixture.deviceId,TIME,DAY,RESET).run();
  return fixture;
}
async function seedPricedReset() {
  const fixture=await seed("warmer-participant",9);
  await db().prepare(`UPDATE telemetry_v1_records SET used_percent=10+(id-1)*5,
    observed_at=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||((id-1)*300)||' seconds')`).bind(TIME).run();
  const digest="c".repeat(64),principal=await authenticateDevice(db(),fixture.authorization);
  const upload=await createDeviceUploadAuthorization(db(),principal,digest,200);
  const claimed=await claimDeviceUploadAuthorization(db(),`Upload ${upload.uploadAuthorization}`,
    {envelopeDigest:digest,bodyBytes:200,contentType:"application/json"});
  const chunk=`${fixture.participantId}:usage`;
  await db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
    chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
    VALUES(?,?,?,'usage',?,0,1,?,?,'synthetic-warmer',8,8,?,?,?)`)
    .bind(chunk,fixture.participantId,fixture.deviceId,DAY,digest,digest,`synthetic/${chunk}`,claimed.authorizationId,TIME).run();
  const record=JSON.stringify({provider:"openai_codex",modelId:"gpt-5.6-sol",billingSurface:"chatgpt_subscription",
    apiServiceTier:"priority",speedMode:"fast",reasoningEffort:"xhigh",totalInputContextTokens:null,
    components:{inputUncachedTokens:100,inputCacheReadTokens:900,inputCacheWriteTokens:0,outputTextTokens:50,
      outputReasoningTokens:25,outputCombinedTokens:null}});
  await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<7)
    INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
      provider,model_id,record_json)
    SELECT ?,?,?,'usage','synthetic-usage-'||n,strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||(n*300+150)||' seconds'),
      ?,'openai_codex','gpt-5.6-sol',? FROM s`).bind(chunk,fixture.participantId,fixture.deviceId,TIME,DAY,record).run();
  return fixture;
}
async function identity(participantId="warmer-participant",source:CommunityAnalysisCacheIdentity["source"]="v1",compositionSupported=true) {
  const pin=await loadCommunitySourcePin(db(),participantId,FROM,source);
  return {participantId,source,sourcePin:pin.sourcePin,fitFingerprint:pin.fingerprint,fromDay:FROM,compositionSupported};
}
async function legacy(fixture:Awaited<ReturnType<typeof createV11DeviceFixture>>,overlap=false) {
  // The current deployment rejects new v0.2 uploads. Explicitly accept that
  // format in this synthetic database to reconstruct retained legacy history.
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE format_rank=2").run();
  const authorization=await createUploadAuthorizationMaterial(fixture.participantId,fixture.sessionId,"b".repeat(64),1);
  await storeUploadAuthorization(db(),authorization);
  const claimed=await claimUploadAuthorization(db(),`Upload ${authorization.encoded}`,
    {envelopeDigest:"b".repeat(64),bodyBytes:1,contentType:"application/json"});
  const id=`legacy:${fixture.participantId}`;
  await db().prepare(`INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,
    schema_version,transport_schema_version,range_start,range_end,client_platform,provider_policy_epoch,
    estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,
    price_basis,declared_record_count,created_at,upload_authorization_id)
    VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1','telemetry-contribution-v0.2',?,?,'macos','unknown',
      NULL,0,0,0,'unavailable',?,?,?)`)
    .bind(id,fixture.participantId,"a".repeat(64),"b".repeat(64),`synthetic/${id}`,TIME,`${DAY}T23:59:59.999Z`,
      overlap?1:0,TIME,claimed.authorizationId).run();
  if(overlap)await db().batch([
    db().prepare(`INSERT INTO telemetry_records(origin_contribution_id,participant_id,record_kind,occurrence_id,
      observed_at,provider,limit_id,record_json) VALUES(?,?,'quota','legacy-quota',?,'openai_codex','codex','{}')`)
      .bind(id,fixture.participantId,TIME),
    db().prepare(`INSERT INTO telemetry_contribution_occurrences(contribution_id,participant_id,record_kind,occurrence_id)
      VALUES(?,?,'quota','legacy-quota')`).bind(id,fixture.participantId),
  ]);
}

async function activateEmptySuccessor(fixture:Awaited<ReturnType<typeof createV11DeviceFixture>>) {
  const day=new Date().toISOString().slice(0,10);
  const staged=await stageV11Day(db(),fixture,await makeV11Day(day,{}));
  const prior=await createTelemetryV11DomainPredecessor(db(),fixture);
  expect(prior.fromDay).toBe(day);expect(prior.throughDay).toBe(day);
  const manifest:TelemetryV11DomainManifest={schemaVersion:"telemetry-domain-manifest-v1.1",fromDay:day,throughDay:day,
    predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
    days:[{day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest}],manifestDigest:"0".repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(db(),fixture,manifest);
  return day;
}
async function cacheRows() {
  return Promise.all(["community_allowance_fit_cache","community_model_composition_cache"].map(async table =>
    (await db().prepare(`SELECT * FROM ${table} ORDER BY participant_id`).all()).results));
}
function observer(hook?: (sql:string,moment:"before"|"after")=>Promise<void>) {
  const queries:string[]=[], originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>(), texts=new WeakMap<D1PreparedStatement,string>();
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,key){
      if(key==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
      if(["first","all","run","raw"].includes(String(key)))return async(...args:unknown[])=>{
        queries.push(sql);await hook?.(sql,"before");
        const value:unknown=await Reflect.apply(Reflect.get(target,key),target,args);
        await hook?.(sql,"after");return value;
      };
      const value:unknown=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});originals.set(proxy,statement);texts.set(proxy,sql);return proxy;
  };
  const database=new Proxy(db(),{get(target,key){
    if(key==="prepare")return(sql:string)=>wrap(target.prepare(sql),sql);
    if(key==="batch")return async(statements:D1PreparedStatement[])=>{
      const sql=statements.map(statement=>texts.get(statement)??"");queries.push(...sql);
      for(const text of sql)await hook?.(text,"before");
      const result=await target.batch(statements.map(statement=>originals.get(statement)??statement));
      for(const text of sql)await hook?.(text,"after");return result;
    };
    const value:unknown=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});
  return {database,queries,raw:()=>queries.filter(sql=>sql===V1_PLAN_QUOTA_PAGE_SQL||sql===V1_FIT_QUOTA_PAGE_SQL)};
}
async function warm(queries=900,nowMs=NOW,observation=observer()) {
  const meter=createD1InvocationBudget(queries);
  const result=await warmCommunityAnalysisCaches(meter.wrap(observation.database),nowMs,
    {meter,deadlineMs:Date.now()+30_000,maintenanceLease:LEASE});
  expect(meter.queriesUsed).toBe(observation.queries.length);expect(meter.queriesUsed).toBeLessThanOrEqual(queries);
  return {result,meter,observation};
}

/** A physical 0053 fixture. Do not call today's owner-aware source readers
 * before 0058: that would test an impossible mixed schema rather than the
 * migration's preservation contract. */
async function seedHistorical0053State() {
  const participantId="historical-0053-participant",deviceId="historical-0053-device",sessionId="historical-0053-session";
  const pairingId="historical-0053-pairing",uploadId="historical-0053-upload",chunkId="historical-0053-chunk";
  const hash="a".repeat(64),now=new Date(NOW).toISOString(),future="2027-01-01T00:00:00.000Z";
  await db().batch([
    db().prepare(`INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
      state,consent_version,consented_at,created_at) VALUES(?,?,zeroblob(32),?,zeroblob(32),'active',?,?,?)`)
      .bind(participantId,"historical-access","historical-recovery","privacy-safe-telemetry-v0.1",now,now),
    db().prepare(`INSERT INTO web_sessions(id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
      VALUES(?,?,zeroblob(32),zeroblob(32),'personal','active',?,?,?)`).bind(sessionId,participantId,now,future,now),
    db().prepare(`INSERT INTO device_pairings(id,participant_id,issued_by_session_id,secret_hash,consent_version,state,
      issued_at,expires_at,transport_consent_version) VALUES(?,?,?,zeroblob(32),'ongoing-privacy-safe-telemetry-v1.0',
      'unused',?,?,'ongoing-privacy-safe-telemetry-v1.0')`).bind(pairingId,participantId,sessionId,now,future),
    db().prepare(`INSERT INTO device_credentials(id,participant_id,paired_via_pairing_id,secret_hash,state,issued_at,
      expires_at,last_used_at,social_verified_at,credential_generation) VALUES(?,?,?,zeroblob(32),'active',?,?,?,?,1)`)
      .bind(deviceId,participantId,pairingId,now,future,now,now),
    db().prepare(`INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
      body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at) VALUES(?,?,?,zeroblob(32),?,1,
      'application/json','consuming',?,?,?)`).bind(uploadId,participantId,deviceId,hash,now,future,future),
    db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
      device_upload_authorization_id,created_at) VALUES(?,?,?,'quota',?,0,1,?,?,'historical-0053',1,1,?,?,?)`)
      .bind(chunkId,participantId,deviceId,DAY,hash,"b".repeat(64),`synthetic/${chunkId}`,uploadId,now),
    db().prepare(`INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,
      observed_day,provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json)
      VALUES(?,?,?,'quota','historical-0053-observation',?,'2026-08-01','openai_codex','pro','unknown','codex','seven_day',
      10,10080,?,'{}')`).bind(chunkId,participantId,deviceId,now,RESET),
    db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at,
      model_observations_json,input_fingerprint,source_method_version) VALUES(?,?,'[]',?,'[]',?,?)`)
      .bind(participantId,"historical-0053-fit-cache",now,hash,"historical-0053"),
    db().prepare(`INSERT INTO community_model_composition_cache(participant_id,cache_key,composition_json,computed_at,
      input_fingerprint,source_method_version) VALUES(?,?,'[]',?,?,?)`)
      .bind(participantId,"historical-0053-model-cache",now,hash,"historical-0053"),
    db().prepare(`INSERT INTO community_analysis_work(participant_id,run_id,input_revision,input_fingerprint,source_kind,
      source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,window_minutes,max_quota_rows,phase,
      progress_revision,control_json,manifest_json,state_sha256) VALUES(?,'11111111-1111-4111-8111-111111111111',1,?,'v1',
      'historical-0053',?,?,?,10080,60000,'plan',0,'{}','[]',?)`).bind(participantId,hash,now,`${FROM}T00:00:00.000Z`,RESET,hash),
  ]);
  const snapshot=()=>Promise.all([
    db().prepare("SELECT * FROM telemetry_v1_chunks ORDER BY id").all().then(value=>value.results),
    db().prepare("SELECT * FROM telemetry_v1_records ORDER BY id").all().then(value=>value.results),
    db().prepare("SELECT * FROM community_allowance_fit_cache ORDER BY participant_id").all().then(value=>value.results),
    db().prepare("SELECT * FROM community_model_composition_cache ORDER BY participant_id").all().then(value=>value.results),
    db().prepare("SELECT * FROM community_analysis_work ORDER BY participant_id").all().then(value=>value.results),
    db().prepare(`SELECT id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,state,consent_version,
      consented_at,created_at,deletion_session_id,identity_link_key,identity_cooldown_digest FROM participants ORDER BY id`).all()
      .then(value=>value.results),
    db().prepare(`SELECT id,participant_id,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at,
      revoked_at,social_verified_at,credential_generation FROM device_credentials ORDER BY id`).all().then(value=>value.results),
  ]);
  return {participantId,deviceId,snapshot};
}

describe("scheduled analysis warmer and atomic cache promotion",()=>{
  it("forward-migrates populated 0053 state and preserves the post-migration warmer cache/checkpoint contract",async()=>{
    const all=(env as Env & {TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS;
    await reset(); await applyD1Migrations(db(),all.filter(migration=>migration.name<"0054"));
    await db().prepare("UPDATE retention_state SET maintenance_lease_token=?,maintenance_lease_expires_at='2027-01-01T00:00:00.000Z'")
      .bind(LEASE).run();
    const historical=await seedHistorical0053State(),historicalBefore=await historical.snapshot();
    await applyD1Migrations(db(),all);
    expect(await historical.snapshot()).toEqual(historicalBefore);
    expect(await db().prepare("SELECT owner_kind FROM participants WHERE id=?").bind(historical.participantId).first())
      .toEqual({owner_kind:"social"});
    expect(await db().prepare("SELECT authority_kind,accountless_enrollment_device_id FROM device_credentials WHERE id=?")
      .bind(historical.deviceId).first()).toEqual({authority_kind:"social",accountless_enrollment_device_id:null});
    expect(await db().prepare("SELECT participant_id,pending FROM community_current_analysis_queue").all().then(value=>value.results))
      .toEqual([{participant_id:historical.participantId,pending:1}]);
    // Keep the current-runtime exercise isolated from the retained 0053
    // fixture: it has already proved source/cache/checkpoint preservation.
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(historical.participantId).run();
    await seed("migrated-participant",9); const pin=await identity("migrated-participant");
    expect(await publishCommunityAnalysisCaches(db(),pin,[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    const work:CommunityAnalysisWorkIdentity={participantId:pin.participantId,inputRevision:pin.sourcePin.inputRevision!,
      inputFingerprint:pin.sourcePin.fingerprint,sourceKind:"v1",sourceMethodVersion:V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
      fixedNow:new Date(NOW).toISOString(),observedAtCutoff:`${FROM}T00:00:00.000Z`,
      resetsAtCutoff:new Date(Date.parse(`${FROM}T00:00:00.000Z`)+7*86_400_000).toISOString(),windowMinutes:10080,maxQuotaRows:60000};
    expect((await beginCommunityAnalysisWork(db(),work,{version:V1_QUOTA_ACQUISITION_VERSION,phase:"plan",
      cursor:{observedAt:work.observedAtCutoff,resetsAt:work.resetsAtCutoff,id:0},planTime:null,reset:null},allocation())).status).toBe("ready");
    const tables=["telemetry_v1_chunks","telemetry_v1_records","community_allowance_fit_cache",
      "community_model_composition_cache","community_analysis_work","participants"];
    const snapshot=()=>Promise.all(tables.map(async table=>(await db().prepare(`SELECT * FROM ${table}`).all()).results));
    const before=await snapshot();
    expect(await db().prepare("SELECT participant_id,pending FROM community_current_analysis_queue").all().then(value=>value.results))
      .toEqual([{participant_id:"migrated-participant",pending:1}]);
    expect((await warm()).result).toEqual({status:"complete",visited:1,published:0,resumed:0});
    expect(await snapshot()).toEqual(before);
  });

  it("uses one generation receipt without scanning unchanged accounts and rebuilds only the changed account",async()=>{
    for (let n=0;n<5;n++) await seed(`incremental-${n}`,9);
    await warm();await warm();
    const before=await cacheRows();
    const idle=await warm();
    expect(idle.result).toEqual({status:"complete",visited:0,published:0,resumed:0});
    expect(idle.meter.queriesUsed).toBe(1);
    expect(idle.observation.queries).toHaveLength(1);
    expect(idle.observation.queries[0]).toContain("community_refresh_lanes");
    expect(idle.observation.queries[0]).not.toContain("community_allowance_fit_cache");
    expect(idle.observation.queries.some(sql=>sql.includes("FROM telemetry_analytical_chunks"))).toBe(false);
    expect(await cacheRows()).toEqual(before);
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE participant_id='incremental-2'")
      .bind("f".repeat(64)).run();
    const changed=await warm();
    expect(changed.result).toEqual({status:"complete",visited:1,published:1,resumed:1});
    const unchanged=(rows:Awaited<ReturnType<typeof cacheRows>>)=>rows.map(table=>table.filter(row=>row.participant_id!=="incremental-2"));
    expect(unchanged(await cacheRows())).toEqual(unchanged(before));
  });

  it("fills both caches from fresh real D1 acquisition and feeds cache-only graph consumers",async()=>{
    await seedPricedReset();const run=await warm();
    expect(run.result).toMatchObject({status:"complete",visited:1,published:1,resumed:1});
    expect(run.observation.queries.filter(sql=>sql===V1_PREPARATION_SOURCE_PAGE_SQL).length).toBeGreaterThan(0);
    expect(run.observation.queries.filter(sql=>sql.includes(V1_PREPARED_PLAN_PAGE_SQL)).length).toBeGreaterThan(0);
    expect(run.observation.queries.filter(sql=>sql.includes(V1_PREPARED_FIT_PAGE_SQL)).length).toBeGreaterThan(0);
    expect(run.observation.raw()).toEqual([]);
    const rows=await cacheRows();expect(rows.map(value=>value.length)).toEqual([1,1]);
    expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
    const fits=await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:allocation()});
    const models=await readCachedCommunityModelCompositions(db(),NOW,{budget:allocation()});
    expect(fits).toEqual(await readCachedCommunityAllowanceCorpus(db(),NOW));
    expect(fits?.participantIds).toEqual(["warmer-participant"]);expect(models?.v1ParticipantCount).toBe(1);
    expect(fits?.fits).toHaveLength(1);expect(fits!.fits[0]!.capacityNanousd).toBeGreaterThan(0);
    expect(models?.compositions).toHaveLength(1);
    expect(models!.compositions[0]!.composition.fit.totalCostUsd).toBeGreaterThan(0);
    expect((await warmAdminCommunityAllowancePreviewCache(db(),NOW,{mode:"cache-only",budget:allocation()})).code)
      .toBe("ALLOWANCE_PREVIEW_CACHE_REFRESHED");
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW,1,{chunks:8},{mode:"cache-only",budget:allocation()}))
      .toMatchObject({processed:1,remaining:false});
    const second=await warm();expect(second.result).toMatchObject({published:0,resumed:0,status:"complete"});
    expect(second.observation.raw()).toEqual([]);expect(await cacheRows()).toEqual(rows);
  });

  it("reuses the durable fixed-now checkpoint after an acquisition-only invocation",async()=>{
    await seed( "warmer-participant",1200);const first=await warm(100);
    expect(first.result).toMatchObject({status:"deferred",published:0,resumed:1});
    const before=await db().prepare("SELECT fixed_now,run_id,progress_revision FROM community_analysis_work").first();
    expect(before?.fixed_now).toBe(new Date(NOW).toISOString());expect(await cacheRows()).toEqual([[],[]]);
    const second=await warm(900,NOW+60_000);
    expect(second.result).toMatchObject({published:1,resumed:1});
    const after=await db().prepare("SELECT fixed_now,run_id,source_method_version,phase FROM community_analysis_work").first();
    expect(after).toMatchObject({fixed_now:before!.fixed_now,run_id:before!.run_id,source_method_version:V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,phase:"complete"});
  });

  it("repairs corrupt cache payloads rather than declaring a matching key current",async()=>{
    await seed();await warm();
    for(const [table,column]of[["community_allowance_fit_cache","fits_json"],["community_model_composition_cache","composition_json"]]){
      await db().prepare(`UPDATE ${table} SET ${column}='{}'`).run();
      expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(false);
      const run=await warm();expect(run.result.published).toBe(1);expect(run.observation.raw()).toEqual([]);
      expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
    }
  });

  it("attests exact published rows even when receipt triggers add database changes",async()=>{
    await seed();await warm();
    const base=db(), batches:D1Result<{participant_id:string}>[][]=[];
    const database=new Proxy(base,{get(target,key){
      if(key==="batch")return async(statements:D1PreparedStatement[])=>{
        const results=await target.batch<{participant_id:string}>(statements);batches.push(results);return results;
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    expect(await publishCommunityAnalysisCaches(database,await identity(),[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    expect(batches).toHaveLength(2); // Source revalidation, then the atomic publication batch.
    expect(batches[0]!.every(result=>result.meta.changes===0)).toBe(true);
    const published=batches[1]!;expect(published).toHaveLength(3);
    expect(published.every(result=>result.results.length===1
      && result.results[0]?.participant_id==="warmer-participant")).toBe(true);
    expect(published.some(result=>result.meta.changes>1)).toBe(true);
    expect(await db().prepare("SELECT state FROM community_refresh_lanes WHERE lane='current'").first()).toEqual({state:"queued"});
  });

  it("keeps identical cache writes idle, queues missing caches, and rolls back failed damage atomically",async()=>{
    await seed();await warm();
    const before=await cacheRows();
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json=fits_json,computed_at=computed_at").run();
    const unchanged=await warm();
    expect(unchanged.result).toEqual({status:"complete",visited:0,published:0,resumed:0});
    expect(unchanged.meter.queriesUsed).toBe(1);expect(await cacheRows()).toEqual(before);
    await expect(db().batch([
      db().prepare("DELETE FROM community_model_composition_cache"),
      db().prepare("INSERT INTO community_refresh_lanes(lane) VALUES('invalid-lane')"),
    ])).rejects.toThrow();
    expect(await cacheRows()).toEqual(before);
    expect((await warm()).meter.queriesUsed).toBe(1);
    for(const table of ["community_allowance_fit_cache","community_model_composition_cache"]){
      await db().prepare(`DELETE FROM ${table}`).run();
      expect(await db().prepare("SELECT state,restart_reason FROM community_refresh_lanes WHERE lane='current'").first())
        .toEqual({state:"queued",restart_reason:"retry"});
      expect((await warm()).result.published).toBe(1);
      expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
    }
  });

  it.each([
    ["community_allowance_fit_cache","cache_key"],
    ["community_allowance_fit_cache","input_fingerprint"],
    ["community_allowance_fit_cache","source_method_version"],
    ["community_model_composition_cache","cache_key"],
    ["community_model_composition_cache","input_fingerprint"],
    ["community_model_composition_cache","source_method_version"],
  ])("bounds corrupt %s.%s metadata before it enters a page response",async(table,column)=>{
    await seed();await warm();
    const scalar=table==="community_allowance_fit_cache";
    const sql=scalar?CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL:CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL;
    const readPage=()=>db().prepare(sql).bind(...(scalar?["",65]:["",65,`${FROM}T00:00:00.000Z`,16*1024])).all();
    const valid=(await readPage()).results[0]!;
    expect(new TextEncoder().encode(String(valid.cache_key)).byteLength).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(String(valid.source_method_version)).byteLength).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(String(valid.input_fingerprint)).byteLength).toBe(64);
    await db().prepare(`UPDATE ${table} SET ${column}=?`).bind("x".repeat(256*1024)).run();
    const rows=(await readPage()).results;expect(rows).toHaveLength(1);expect(rows[0]![column]).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThan(8*1024);
    expect(await (scalar?readCachedCommunityAllowanceCorpus:readCachedCommunityModelCompositions)(db(),NOW,{budget:allocation()})).toBeNull();
  });

  it("accepts complete acquired refusals but rejects missing source results and transient error labels",async()=>{
    await seed();const pin=await identity();
    for(const analyses of [[],[{source:"v1" as const,analysis:{status:"deferred"}}],
      [{source:"v1" as const,analysis:{status:"not_testable",reason:"INTERNAL_ERROR"}}],
      [{source:"v1" as const,analysis:{status:"ready",tracks:[]}}],
      [{source:"v1" as const,analysis:{schemaVersion:"account-scoped-quota-analysis-v0.1",status:"ready",tracks:[null]}}],
      [{source:"v1" as const,analysis:{...refusal,tracks:[{}]}}]]){
      await expect(publishCommunityAnalysisCaches(db(),pin,analyses,refusal,LEASE)).rejects.toThrow();
      expect(await cacheRows()).toEqual([[],[]]);
    }
    expect(await publishCommunityAnalysisCaches(db(),pin,[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    expect((await readCachedCommunityModelCompositions(db(),NOW,{budget:allocation()}))?.refusedParticipantCount).toBe(1);
  });

  it("publishes a real acquisition limit refusal without fitting or accepting partial quota evidence",async()=>{
    await seed("warmer-participant",257);
    await db().prepare("UPDATE telemetry_v1_records SET provider='synthetic-provider-'||id").run();
    const run=await warm();expect(run.result).toMatchObject({status:"complete",published:1,resumed:1});
    expect(run.observation.queries.filter(sql=>sql===V1_PREPARATION_SOURCE_PAGE_SQL).length).toBeGreaterThan(0);
    expect(run.observation.queries.filter(sql=>sql.includes(V1_PREPARED_PLAN_PAGE_SQL)).length).toBeGreaterThan(0);
    expect(run.observation.queries.filter(sql=>sql.includes(V1_PREPARED_FIT_PAGE_SQL))).toEqual([]);
    expect(run.observation.queries.filter(sql=>sql===V1_FIT_QUOTA_PAGE_SQL)).toEqual([]);
    const rows=await cacheRows();expect(rows.map(value=>value.length)).toEqual([1,1]);
    expect(JSON.parse(String(rows[0]![0]!.fits_json))).toEqual([]);
    expect(JSON.parse(String(rows[1]![0]!.composition_json))).toEqual(refusal);
    expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
  });

  it.each(["legacy","mixed-disjoint","mixed-overlap"])("preserves %s precedence and only publishes supported composition",async(kind)=>{
    const mixed=kind!=="legacy",overlap=kind==="mixed-overlap";
    const fixture=mixed?await seed():await createV11DeviceFixture(db(),{participantId:"warmer-participant"});
    await legacy(fixture,overlap);
    const run=await warm();expect(run.result).toMatchObject({status:"complete",published:1,resumed:mixed?1:0});
    const rows=await cacheRows();expect(rows.map(value=>value.length)).toEqual([1,mixed&&!overlap?1:0]);
    expect(String(rows[0]![0]!.cache_key)).toMatch(mixed?/^mixed:/u:/^v0\.2:/u);
    expect(await communityAnalysisCachesCurrent(db(),await identity(fixture.participantId,mixed?"mixed":"v0.2",mixed&&!overlap))).toBe(true);
    const models=await readCachedCommunityModelCompositions(db(),NOW,{budget:allocation()});
    expect(models).not.toBeNull();
    expect(models?.refusedParticipantCount).toBe(0);
    expect(models?.v1ParticipantCount).toBe(mixed&&!overlap?1:0);
    expect(models?.unsupportedSourceParticipantCount).toBe(mixed&&!overlap?0:1);
    expect((await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:allocation()}))?.participantIds).toEqual([fixture.participantId]);
    if(!mixed)expect(run.observation.raw()).toEqual([]);
  });

  it("gives an activated v1.1 domain precedence over the retained v1 journal",async()=>{
    const original=await seed();
    // Retained zero-accepted old journals are genuine predecessor inputs, but
    // contain no canonical evidence requiring semantic transfer to this domain.
    await db().prepare("DELETE FROM telemetry_v1_records WHERE participant_id=?").bind(original.participantId).run();
    await db().prepare("UPDATE telemetry_v1_chunks SET accepted_record_count=0 WHERE participant_id=?").bind(original.participantId).run();
    const fixture=await createV11DeviceFixture(db(),{participantId:original.participantId,grant:true});
    const successorDay=await activateEmptySuccessor(fixture);
    const run=await warm();expect(run.result).toMatchObject({status:"complete",published:1,resumed:0});
    expect(run.observation.raw()).toEqual([]);
    const rows=await cacheRows();expect(rows.map(value=>value.length)).toEqual([1,1]);
    expect(rows.every(table=>String(table[0]!.cache_key).startsWith("v1.1:"))).toBe(true);
    const pin=await identity(fixture.participantId,"v1.1");
    expect("source" in pin.sourcePin&&pin.sourcePin.fromDay).toBe(successorDay);
    expect(pin.fromDay).toBe(FROM); // Source pin covers the domain, not the analysis cutoff.
    expect(await communityAnalysisCachesCurrent(db(),pin)).toBe(true);
    expect((await readCachedCommunityModelCompositions(db(),NOW,{budget:allocation()}))?.refusedParticipantCount).toBe(1);
    expect((await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:allocation()}))?.participantIds).toEqual([fixture.participantId]);
  });

  it("does not bypass the real successor-consent guard for accepted legacy history",async()=>{
    const fixture=await createV11DeviceFixture(db(),{participantId:"warmer-participant"});await legacy(fixture);
    await expect(createV11DeviceFixture(db(),{participantId:fixture.participantId,grant:true}))
      .rejects.toMatchObject({code:"TELEMETRY_TRANSPORT_BLOCKED"});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domain_heads").first()).toEqual({n:0});
    expect(await cacheRows()).toEqual([[],[]]);
  });

  it("invalidates method, fingerprint and day cutoffs instead of trusting the prior cache revision",async()=>{
    await seed();await warm();
    for(const [table,column,value]of[
      ["community_allowance_fit_cache","source_method_version","obsolete-method"],
      ["community_model_composition_cache","input_fingerprint","0".repeat(64)],
      ["community_model_composition_cache","cache_key","obsolete-day"],
    ]){
      await db().prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run();
      expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(false);
      expect((await warm()).result.published).toBe(1);
      expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
    }
    const old=await db().prepare("SELECT run_id FROM community_analysis_work").first();
    const next=await warm(900,NOW+86_400_000);expect(next.result.published).toBe(1);
    const current=await db().prepare("SELECT run_id,observed_at_cutoff FROM community_analysis_work").first();
    expect(current?.run_id).not.toBe(old?.run_id);expect(current?.observed_at_cutoff).toBe("2026-05-25T00:00:00.000Z");
    expect((await cacheRows()).every(rows=>rows[0]!.source_method_version===COMMUNITY_ATTRIBUTION_METHOD_VERSION)).toBe(true);
  });

  it.each(["correction","deleting","erasure","lease-loss","lease-expired"])("rejects both cache writes on final %s fence",async(action)=>{
    await seed();const pin=await identity();let raced=false;
    const observation=observer(async(sql,moment)=>{
      if(raced||moment!=="before"||!sql.includes("INSERT INTO community_allowance_fit_cache"))return;
      raced=true;
      if(action==="correction")await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=?").bind("e".repeat(64)).run();
      if(action==="deleting")await db().prepare("UPDATE participants SET state='deleting'").run();
      if(action==="erasure")await db().prepare("DELETE FROM participants WHERE id='warmer-participant'").run();
      if(action==="lease-loss")await db().prepare("UPDATE retention_state SET maintenance_lease_token='another-owner'").run();
      if(action==="lease-expired")await db().prepare("UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    });
    expect(await publishCommunityAnalysisCaches(observation.database,pin,[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(false);
    expect(raced).toBe(true);expect(await cacheRows()).toEqual([[],[]]);
  });

  it("rolls back the first cache when the second cache insert fails",async()=>{
    await seed();const pin=await identity();
    await db().prepare(`CREATE TRIGGER synthetic_composition_failure BEFORE INSERT ON community_model_composition_cache
      BEGIN SELECT RAISE(ABORT,'synthetic second cache failure'); END`).run();
    await expect(publishCommunityAnalysisCaches(db(),pin,[{source:"v1",analysis:refusal}],refusal,LEASE)).rejects.toThrow();
    expect(await cacheRows()).toEqual([[],[]]);
  });

  it("rolls back both conditional writes when the lease expires between batch members",async()=>{
    await seed();const pin=await identity();
    await db().prepare(`CREATE TRIGGER synthetic_mid_batch_lease_expiry AFTER INSERT ON community_allowance_fit_cache
      BEGIN UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE singleton=1; END`).run();
    expect(await publishCommunityAnalysisCaches(db(),pin,[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(false);
    expect(await cacheRows()).toEqual([[],[]]);
    expect(await db().prepare("SELECT maintenance_lease_expires_at AS expires FROM retention_state WHERE singleton=1").first())
      .toEqual({expires:"2027-01-01T00:00:00.000Z"});
  });

  it("uses available budget beyond four accounts and leaves a spent invocation unchanged",async()=>{
    for(let n=0;n<5;n++)await seed(`warmer-${n}`,1);
    const first=await warm();expect(first.result).toMatchObject({visited:5,resumed:5,published:5,status:"complete"});
    // Completion stays query-only and does not revisit the five healthy jobs.
    const second=await warm(900,NOW+60_000);expect(second.result).toMatchObject({visited:0,resumed:0,published:0,status:"complete"});
    expect((await cacheRows()).map(rows=>rows.length)).toEqual([5,5]);
    const prior=await cacheRows(),spent=await warm(12);
    expect(spent.result).toMatchObject({status:"deferred",visited:0,published:0});expect(spent.meter.queriesUsed).toBe(0);
    expect(await cacheRows()).toEqual(prior);
  });

  it("finishes cold accounts when the first hot account changes before its atomic acknowledgement",async()=>{
    await seed("hot-current-account",9);
    await seed("cold-current-account-a",9); await seed("cold-current-account-b",9);
    let changed=false;
    const observed=observer(async(sql,moment)=>{
      if(changed||moment!=="before"||!sql.includes("INSERT INTO community_allowance_fit_cache"))return;
      changed=true;
      await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE participant_id='hot-current-account'")
        .bind("e".repeat(64)).run();
    });
    const run=await warm(900,NOW,observed);
    expect(changed).toBe(true);
    expect(run.result).toEqual({status:"deferred",visited:3,published:2,resumed:3});
    expect((await cacheRows()).map(rows=>rows.map(row=>row.participant_id)))
      .toEqual([["cold-current-account-a","cold-current-account-b"],["cold-current-account-a","cold-current-account-b"]]);
    const work=await db().prepare(`SELECT w.input_revision,v.revision AS live_revision FROM community_analysis_work w
      JOIN community_analytical_input_versions v ON v.participant_id=w.participant_id
      WHERE w.participant_id='hot-current-account'`).first<{input_revision:number;live_revision:number}>();
    expect(work!.input_revision).toBeLessThan(work!.live_revision);
    expect(await db().prepare("SELECT participant_id FROM community_current_analysis_queue WHERE pending=1").all()
      .then(result=>result.results)).toEqual([{participant_id:"hot-current-account"}]);
  });

  it("cannot acknowledge cache damage racing an already-valid cache probe",async()=>{
    await seed(); await warm();
    // A harmless representation change queues a validation-only attempt.
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json=fits_json||' '").run();
    let damaged=false;
    const observed=observer(async(sql,moment)=>{
      if(damaged||moment!=="before"||!sql.includes("SET pending=0,completed_day=?1,completed_method=?2"))return;
      damaged=true; await db().prepare("UPDATE community_allowance_fit_cache SET fits_json='{}'").run();
    });
    expect((await warm(900,NOW,observed)).result).toEqual({status:"deferred",visited:1,published:0,resumed:0});
    expect(damaged).toBe(true);
    expect((await db().prepare("SELECT pending FROM community_current_analysis_queue").first())?.pending).toBe(1);
    expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(false);
    expect((await warm()).result).toMatchObject({status:"complete",published:1});
    expect(await communityAnalysisCachesCurrent(db(),await identity())).toBe(true);
  });

  it("reaches both unfinished accounts beyond a thirteen-account current prefix",async()=>{
    const ids=Array.from({length:15},(_,n)=>`current-prefix-${String(n).padStart(2,"0")}`);
    for(const id of ids)await seed(id,1);
    const start=Math.floor(NOW/60_000)%ids.length;
    const order=ids.map((_,index)=>ids[(start+index)%ids.length]!);
    for(const id of order.slice(0,13))expect(await publishCommunityAnalysisCaches(db(),await identity(id),
      [{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    const currentBefore=(await cacheRows()).map(rows=>rows.filter(row=>order.slice(0,13).includes(String(row.participant_id))));
    const run=await warm();
    expect(run.result).toMatchObject({status:"complete",visited:15,resumed:2,published:2});
    const after=await cacheRows();expect(after.map(rows=>rows.length)).toEqual([15,15]);
    expect(after.map(rows=>rows.filter(row=>order.slice(0,13).includes(String(row.participant_id))))).toEqual(currentBefore);
    const next=await warm(900,NOW+60_000);
    expect(next.result).toMatchObject({status:"complete",visited:0,resumed:0,published:0});
    expect(next.meter.queriesUsed).toBe(1);
    expect(next.observation.queries[0]).toContain("community_refresh_lanes");
    expect(next.observation.raw()).toEqual([]);expect(await cacheRows()).toEqual(after);
  });

  it("uses the remaining budget for every small stale job after acknowledging a current prefix",async()=>{
    const ids=Array.from({length:12},(_,n)=>`useful-work-${String(n).padStart(2,"0")}`);
    for(const id of ids)await seed(id,1);
    const start=Math.floor(NOW/60_000)%ids.length;
    const order=ids.map((_,index)=>ids[(start+index)%ids.length]!);
    for(const id of order.slice(0,6))expect(await publishCommunityAnalysisCaches(db(),await identity(id),
      [{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    const first=await warm();
    expect(first.result).toMatchObject({status:"complete",visited:12,resumed:6,published:6});
    expect((await db().prepare("SELECT participant_id FROM community_analysis_work ORDER BY participant_id").all()).results)
      .toEqual(order.slice(6).sort().map(participant_id=>({participant_id})));
    const second=await warm(900,NOW+60_000);
    expect(second.result).toMatchObject({status:"complete",visited:0,resumed:0,published:0});
    expect((await cacheRows()).map(rows=>rows.length)).toEqual([12,12]);
  });

  it("stops metered current-prefix scans before a spent budget without creating work",async()=>{
    for(let n=0;n<8;n++){
      const id=`metered-current-${n}`;await seed(id,1);
      expect(await publishCommunityAnalysisCaches(db(),await identity(id),[{source:"v1",analysis:refusal}],refusal,LEASE)).toBe(true);
    }
    const prior=await cacheRows(),run=await warm(40);
    expect(run.result).toMatchObject({status:"deferred",resumed:0,published:0});
    expect(run.result.visited).toBeGreaterThan(0);expect(run.result.visited).toBeLessThan(8);
    expect(run.observation.raw()).toEqual([]);expect(await cacheRows()).toEqual(prior);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_analysis_work").first()).toEqual({n:0});
  });

  it("uses the current-chunk and time-range indexes while preserving legacy overlap parity",async()=>{
    const fixture=await seed();await legacy(fixture,true);
    const candidateSql=(await warm()).observation.queries.find(sql=>sql.startsWith("SELECT EXISTS (")
      && sql.includes("telemetry_records r INDEXED BY telemetry_records_participant_time"))!;
    expect(candidateSql).toBeDefined();
    for(const [sql,bindings]of[
      [CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL,["",65]],
      [CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL,["",65,`${FROM}T00:00:00.000Z`,16*1024]],
      [candidateSql,[fixture.participantId,`${FROM}T00:00:00.000Z`]],
    ] as const){
      const plan=(await db().prepare("EXPLAIN QUERY PLAN "+sql).bind(...bindings).all<{detail:string}>()).results.map(row=>row.detail);
      if(sql!==candidateSql)expect(plan.some(row=>row.includes("SEARCH c USING INDEX telemetry_v1_chunks_current_identity")),plan.join("\n")).toBe(true);
      if(sql===CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL)continue;
      expect(plan.some(row=>row.includes("telemetry_records_participant_time")&&row.includes("participant_id=? AND observed_at>?")),plan.join("\n")).toBe(true);
      expect(plan.some(row=>row.includes("telemetry_contribution_occurrences_record")&&row.includes("occurrence_id=?")),plan.join("\n")).toBe(true);
    }
    const oldOverlap=`SELECT EXISTS(SELECT 1 FROM telemetry_records r JOIN telemetry_contribution_occurrences o
      ON o.participant_id=r.participant_id AND o.record_kind=r.record_kind AND o.occurrence_id=r.occurrence_id
      JOIN telemetry_contributions c ON c.id=o.contribution_id WHERE r.participant_id=?1 AND r.record_kind='quota'
      AND r.provider='openai_codex' AND r.limit_id='codex' AND r.observed_at>=?2 AND c.status='accepted'
      AND c.transport_schema_version='telemetry-contribution-v0.2') AS overlap`;
    for(const [time,provider,status,expected]of[
      [TIME,"openai_codex","accepted",1],
      [`${FROM}T00:00:00.000Z`,"openai_codex","accepted",1],
      ["2020-01-01T00:00:00.000Z","openai_codex","accepted",0],
      [TIME,"foreign","accepted",0],
      [TIME,"openai_codex","deleting",0],
    ] as const){
      await db().prepare("UPDATE telemetry_records SET observed_at=?,provider=? WHERE participant_id=?").bind(time,provider,fixture.participantId).run();
      await db().prepare("UPDATE telemetry_contributions SET status=? WHERE participant_id=?").bind(status,fixture.participantId).run();
      const prior=await db().prepare(oldOverlap).bind(fixture.participantId,`${FROM}T00:00:00.000Z`).first<{overlap:number}>();
      expect(prior?.overlap).toBe(expected);
      const cached=(await db().prepare(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL)
        .bind("",65,`${FROM}T00:00:00.000Z`,16*1024).all<{legacy_overlap:number}>()).results[0]!;
      const candidate=(await db().prepare(candidateSql).bind(fixture.participantId,`${FROM}T00:00:00.000Z`).all<{legacy_overlap:number}>()).results[0]!;
      expect([cached.legacy_overlap,candidate.legacy_overlap]).toEqual([prior!.overlap,prior!.overlap]);
    }
  });

  it("reads all 16 captured participants before sizing a 500-query daily publication phase",async()=>{
    for(let n=0;n<16;n++)await seed(`daily-budget-${n.toString().padStart(2,"0")}`,1);
    for(let pass=0;pass<4;pass++)await warm(900,NOW+pass*4*60_000);
    expect((await cacheRows()).map(rows=>rows.length)).toEqual([16,16]);
    const corpus=await readCachedCommunityAllowanceCorpus(db(),NOW,{budget:allocation()});
    expect(corpus?.participantIds).toHaveLength(16);expect(corpus).toEqual(await readCachedCommunityAllowanceCorpus(db(),NOW));
    const queued=(await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results;
    expect(queued).toHaveLength(1);
    const target="daily-budget-15";
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json='{}' WHERE participant_id=?").bind(target).run();
    const missingCaches=await cacheRows();
    const missing=observer(),missingMeter=createD1InvocationBudget(500),missingBudget=allocation(500);
    expect(await rebuildPendingCommunityDailyAggregates(missingMeter.wrap(missing.database),NOW,24,undefined,
      {mode:"cache-only",budget:missingBudget})).toMatchObject({processed:0,deferred:true});
    // Incomplete immutable capture may stage derived publication metadata, but
    // must not mutate telemetry, calculated caches or any daily publication.
    const mutations=missing.queries.flatMap(sql=>[...sql.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+([a-z_]+)/gu)]
      .map(match=>match[1]));
    expect(mutations.length).toBeGreaterThan(0);
    expect([...new Set(mutations)].sort()).toEqual(["community_publication_generation","community_publication_members"]);
    expect(missing.raw()).toEqual([]);
    expect(await cacheRows()).toEqual(missingCaches);
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results).toEqual(queued);
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json='[]' WHERE participant_id=?").bind(target).run();
    const observed=observer(),meter=createD1InvocationBudget(500),budget=allocation(500);
    expect(await rebuildPendingCommunityDailyAggregates(meter.wrap(observed.database),NOW,24,undefined,
      {mode:"cache-only",budget})).toMatchObject({processed:1,remaining:false});
    expect(observed.queries.filter(sql=>sql.includes("SELECT m.* FROM weighted w JOIN community_publication_members"))).toHaveLength(1);
    expect(meter.queriesUsed).toBe(observed.queries.length);expect(meter.queriesUsed).toBeLessThanOrEqual(500);
    expect(budget.remainingQueries).toBeGreaterThanOrEqual(0);expect(Object.hasOwn(budget,"reserveQueries")).toBe(false);
    expect(await db().prepare("SELECT count(*) AS n FROM community_daily_aggregate_rebuilds").first()).toEqual({n:0});
  });
});
