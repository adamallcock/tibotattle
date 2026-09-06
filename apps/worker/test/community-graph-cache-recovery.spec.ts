import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({ fits: vi.fn(), corpus: vi.fn(), models: vi.fn(), rawFits: vi.fn(), rawModels: vi.fn() }));
vi.mock("../src/community-allowance", async (original) => ({
  ...await original<typeof import("../src/community-allowance")>(),
  readCachedCommunityAllowanceFits: readers.fits,
  readCachedCommunityAllowanceCorpus: readers.corpus,
  readCachedCommunityModelCompositions: readers.models,
  collectCommunityAllowanceFits: readers.rawFits,
  collectCommunityModelCompositions: readers.rawModels,
}));

import { summarizeCommunityAllowanceDay } from "../src/community-allowance";
import { rebuildPendingCommunityDailyAggregates } from "../src/community-daily-aggregates";
import { buildAdminCommunityAllowancePreview, buildAdminCommunityAllowancePreviewFromSource,
  buildCommunityModelCompositionDay, warmAdminCommunityAllowancePreviewCache } from "../src/admin-community-allowance";
import { priceChunkUsageRecord } from "../src/quota-analysis-v1";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[] }
const db = () => (env as Bindings).USAGE_MONITOR_DB;
const DAY = "2026-09-01", NOW = Date.parse(`${DAY}T12:00:00.000Z`);
const fits = [{ participantId: "synthetic-cache-participant", planType: "pro", capacityNanousd: 250_000_000_000,
  lastObservedAt: `${DAY}T01:00:00.000Z` }];
const collection = { compositions: [], v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0,
  refusedParticipantCount: 1, storeAvailable: true };
const recovery = (remainingQueries = 800) => ({ mode: "cache-only" as const,
  budget: { remainingQueries, deadlineMs: 1, now: () => 0 } });
const activityRecovery = () => ({ ...recovery(100), mode: "activity-only" as const });

async function usageDay() {
  const time = new Date(NOW).toISOString(), future = "2027-01-01T00:00:00.000Z";
  const hash = new Uint8Array(32).fill(7);
  const usage = { provider: "openai_codex", modelId: "gpt-5.6-sol", billingSurface: "chatgpt_subscription",
    speedMode: "standard", apiServiceTier: "standard", reasoningEffort: "high",
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } };
  await db().batch([
    db().prepare(`INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
      state,consent_version,consented_at,created_at) VALUES ('activity-person','activity-access',?,'activity-recovery',?,
      'active','privacy-safe-telemetry-v0.2',?,?)`).bind(hash,hash,time,time),
    db().prepare(`INSERT INTO web_sessions(id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
      VALUES ('activity-session','activity-person',?,?,'personal','active',?,?,?)`).bind(hash,hash,time,future,time),
    db().prepare(`INSERT INTO device_pairings(id,participant_id,issued_by_session_id,secret_hash,consent_version,
      transport_consent_version,state,issued_at,expires_at) VALUES ('activity-pair','activity-person','activity-session',?,
      'ongoing-privacy-safe-telemetry-v1.0','ongoing-privacy-safe-telemetry-v1.0','unused',?,?)`).bind(hash,time,future),
    db().prepare(`INSERT INTO device_credentials(id,participant_id,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at)
      VALUES ('activity-device','activity-person','activity-pair',?,'active',?,?,?)`).bind(hash,time,future,time),
    db().prepare(`INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
      body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at) VALUES ('activity-auth','activity-person',
      'activity-device',?,?,1024,'application/json','consuming',?,?,?)`).bind(hash,'a'.repeat(64),time,future,future),
    db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
      envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES ('activity-chunk','activity-person','activity-device','usage',?,0,1,?,?,'synthetic',1,1,'synthetic/activity',
      'activity-auth',?)`).bind(DAY,'b'.repeat(64),'a'.repeat(64),time),
    db().prepare(`INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,
      observed_day,provider,model_id,input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
      output_reasoning_tokens,record_json) VALUES ('activity-chunk','activity-person','activity-device','usage','activity-occurrence',
      ?,?,'openai_codex','gpt-5.6-sol',100,900,0,50,25,?)`).bind(time,DAY,JSON.stringify(usage)),
  ]);
  return priceChunkUsageRecord(JSON.stringify(usage),time)!;
}

async function queue(day = DAY) {
  await db().prepare(`INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT ?,mutation_epoch,? FROM community_snapshot_mutation_control WHERE singleton_id=1`)
    .bind(day,new Date(NOW).toISOString()).run();
}
async function snapshot() {
  const tables = ["community_daily_aggregate_rebuilds", "community_daily_aggregates",
    "community_allowance_publication_state", "community_model_composition_days", "admin_community_allowance_preview_cache"];
  return Promise.all(tables.map(async table => (await db().prepare(`SELECT * FROM ${table}`).all()).results));
}
function observed(beforeRun?: (sql: string) => Promise<void>) {
  const mutations: string[] = [];
  const prepared: string[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values),sql);
      if (key === "run") return async () => { await beforeRun?.(sql); return target.run(); };
      const value = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = new Proxy(db(), { get(target,key) {
    if (key === "prepare") return (sql: string) => {
      prepared.push(sql);
      if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/u.test(sql)) mutations.push(sql);
      return wrap(target.prepare(sql),sql);
    };
    const value = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database,mutations,prepared };
}

beforeEach(async () => {
  await reset(); await applyD1Migrations(db(),(env as Bindings).TEST_MIGRATIONS);
  vi.clearAllMocks();
  readers.fits.mockResolvedValue(fits);
  readers.corpus.mockResolvedValue({ fits,participantIds: fits.map(row => row.participantId) });
  readers.models.mockResolvedValue(collection);
  readers.rawFits.mockImplementation(() => { throw new Error("raw allowance analysis forbidden in recovery"); });
  readers.rawModels.mockImplementation(() => { throw new Error("raw composition analysis forbidden in recovery"); });
});

describe("cache-only graph recovery publication", () => {
  it("defers a missing fit cohort before drift/readiness writes or source queue drain", async () => {
    await queue(); readers.fits.mockResolvedValue(null);
    const prior = await snapshot(), observation = observed();
    expect(await rebuildPendingCommunityDailyAggregates(observation.database,NOW,1,{chunks:8},recovery()))
      .toEqual({processed:0,remaining:true,aggregateIds:[],deferred:true});
    expect(observation.mutations).toEqual([]); expect(await snapshot()).toEqual(prior);
    expect(readers.rawFits).not.toHaveBeenCalled(); expect(readers.rawModels).not.toHaveBeenCalled();
  });

  it("publishes valid cached fit output with the same allowance calculation and exact activity totals", async () => {
    await queue(); const options = recovery();
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW,1,{chunks:8},options))
      .toMatchObject({processed:1,remaining:false});
    const row = await db().prepare("SELECT payload_json FROM community_daily_aggregates WHERE day=?").bind(DAY).first<{payload_json:string}>();
    const payload = JSON.parse(row!.payload_json);
    expect(payload.allowance).toEqual(summarizeCommunityAllowanceDay(fits,DAY));
    expect(payload.totals.usageEvents).toBe(0); expect(payload.apiEquivalentSpend.knownCostUsd).toBe(0);
    expect(readers.fits).toHaveBeenCalledWith(expect.anything(),NOW,{budget:options.budget});
    expect(readers.rawFits).not.toHaveBeenCalled();
  });

  it("a mutation during complete-cohort acquisition defers without any graph mutations", async () => {
    await queue(); let afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
    readers.fits.mockImplementation(async () => {
      await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
      afterMutation = await snapshot();
      return fits;
    });
    const observation = observed();
    expect(await rebuildPendingCommunityDailyAggregates(observation.database,NOW,1,{chunks:8},recovery()))
      .toMatchObject({processed:0,deferred:true});
    expect(observation.mutations).toEqual([]);expect(afterMutation).toBeDefined();
    expect(await snapshot()).toEqual(afterMutation);
  });

  it("insufficient phase admission does not start cache reads or mutate the queue", async () => {
    await queue(); const prior = await snapshot(); const options = recovery(50);
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW,1,{chunks:8},options)).toMatchObject({deferred:true});
    expect(readers.fits).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(prior);
    expect(options.budget.remainingQueries).toBe(50);
  });

  it("missing model composition defers the admin graph without an empty model-day substitute", async () => {
    readers.models.mockResolvedValue(null); const prior = await snapshot(), observation = observed();
    expect(await warmAdminCommunityAllowancePreviewCache(observation.database,NOW,recovery()))
      .toEqual({code:"ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE"});
    expect(observation.mutations).toEqual([]);expect(await snapshot()).toEqual(prior);
    expect(readers.rawModels).not.toHaveBeenCalled();
  });

  it("admin recovery retains previous cache and model-day when a refresh cohort is incomplete", async () => {
    expect((await warmAdminCommunityAllowancePreviewCache(db(),NOW,recovery())).code).toBe("ALLOWANCE_PREVIEW_CACHE_REFRESHED");
    const prior = await snapshot(); readers.corpus.mockResolvedValue(null);
    expect(await warmAdminCommunityAllowancePreviewCache(db(),NOW+3_600_000,recovery()))
      .toEqual({code:"ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE"});
    expect(await snapshot()).toEqual(prior);expect(readers.rawModels).not.toHaveBeenCalled();
  });

  it("valid admin cache payloads preserve scalar and model-day parity and publish together", async () => {
    const options = recovery(), observation = observed();
    expect((await warmAdminCommunityAllowancePreviewCache(observation.database,NOW,options)).code).toBe("ALLOWANCE_PREVIEW_CACHE_REFRESHED");
    // Cache readers are isolated spies here; all six surrounding source/history/
    // publication statements are accounted separately from those readers.
    expect(observation.prepared).toHaveLength(6);
    expect(options.budget.remainingQueries).toBe(794);
    const row = await db().prepare("SELECT payload_json,source_mutation_epoch FROM admin_community_allowance_preview_cache").first<{payload_json:string;source_mutation_epoch:number}>();
    const preview = JSON.parse(row!.payload_json);
    const expected = buildAdminCommunityAllowancePreview(fits,NOW,fits.map(row => row.participantId));
    expect(preview.days).toEqual(expected.days);expect(preview.coverage).toEqual(expected.coverage);
    expect(preview.models.days).toEqual([buildCommunityModelCompositionDay(collection,DAY)]);
    const day = await db().prepare("SELECT payload_json,source_mutation_epoch FROM community_model_composition_days WHERE day=?").bind(DAY)
      .first<{payload_json:string;source_mutation_epoch:number}>();
    expect(JSON.parse(day!.payload_json)).toEqual(preview.models.days[0]);expect(day!.source_mutation_epoch).toBe(row!.source_mutation_epoch);
    expect(readers.rawModels).not.toHaveBeenCalled();
  });

  it("the atomic admin publication rolls back its model day if the preview write fails", async () => {
    await db().prepare(`CREATE TRIGGER synthetic_preview_failure BEFORE INSERT ON admin_community_allowance_preview_cache
      BEGIN SELECT RAISE(ABORT,'synthetic preview failure'); END`).run();
    const prior = await snapshot();
    expect((await warmAdminCommunityAllowancePreviewCache(db(),NOW,recovery())).code).toBe("ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE");
    expect(await snapshot()).toEqual(prior);
  });

  it("a source mutation after acquisition prevents both admin publications", async () => {
    let afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
    readers.models.mockImplementation(async () => {
      await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
      afterMutation = await snapshot();
      return collection;
    });
    const observation = observed();
    expect((await warmAdminCommunityAllowancePreviewCache(observation.database,NOW,recovery())).code).toBe("ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE");
    expect(observation.mutations).toEqual([]);expect(afterMutation).toBeDefined();
    expect(await snapshot()).toEqual(afterMutation);
  });

  it("the final transaction fence rejects an epoch change immediately before both admin writes", async () => {
    let raced = false;
    const database = new Proxy(db(), { get(target,key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        raced = true;
        await target.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
        return target.batch(statements);
      };
      const value = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await warmAdminCommunityAllowancePreviewCache(database,NOW,recovery())).code).toBe("ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE");
    expect(raced).toBe(true);
    expect(await db().prepare("SELECT * FROM community_model_composition_days").all()).toMatchObject({results:[]});
    expect(await db().prepare("SELECT * FROM admin_community_allowance_preview_cache").all()).toMatchObject({results:[]});
  });

  it("the explicit source builder also refuses missing cached models without raw fallback", async () => {
    readers.models.mockResolvedValue(null);const observation = observed();
    expect(await buildAdminCommunityAllowancePreviewFromSource(observation.database,NOW,recovery())).toBeNull();
    expect(observation.mutations).toEqual([]);expect(readers.rawModels).not.toHaveBeenCalled();
  });

  it("activity-only publishes exact tokens/spend without allowance and durably rehydrates later", async () => {
    const price = await usageDay(); readers.fits.mockResolvedValue(null);
    const queued = (await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results;
    const options = activityRecovery(), observation = observed();
    expect(await rebuildPendingCommunityDailyAggregates(observation.database,NOW,1,{chunks:8},options))
      .toMatchObject({processed:1,remaining:true});
    expect(observation.prepared).toHaveLength(14);
    expect(options.budget.remainingQueries).toBe(85);
    const row = await db().prepare("SELECT revision,payload_json FROM community_daily_aggregates WHERE day=? ORDER BY revision DESC LIMIT 1")
      .bind(DAY).first<{revision:number;payload_json:string}>();
    const payload = JSON.parse(row!.payload_json);
    expect(payload).not.toHaveProperty("allowance");
    expect(payload.totals).toMatchObject({usageEvents:1,inputUncachedTokens:100,inputCacheReadTokens:900,
      inputCacheWriteTokens:0,outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:75});
    expect(payload.apiEquivalentSpend).toMatchObject({coverage:"complete",usageEvents:1,
      knownCostUsd:Number((BigInt(price.costNanousd)+50_000n)/100_000n)/10_000});
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results).toEqual(queued);
    expect(readers.fits).not.toHaveBeenCalled();expect(readers.rawFits).not.toHaveBeenCalled();
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW+1000,1,{chunks:8},activityRecovery()))
      .toMatchObject({processed:0,remaining:true});
    expect((await db().prepare("SELECT COUNT(*) AS n FROM community_daily_aggregates").first())?.n).toBe(1);
    readers.fits.mockResolvedValue(fits);
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW+2000,1,{chunks:8},recovery()))
      .toMatchObject({processed:1,remaining:false});
    const complete = await db().prepare("SELECT revision,payload_json FROM community_daily_aggregates WHERE day=? ORDER BY revision DESC LIMIT 1")
      .bind(DAY).first<{revision:number;payload_json:string}>();
    expect(complete!.revision).toBe(2);expect(JSON.parse(complete!.payload_json).allowance).toEqual(summarizeCommunityAllowanceDay(fits,DAY));
    expect(JSON.parse(complete!.payload_json).totals).toEqual(payload.totals);
  });

  it("activity-only never overwrites an existing allowance or lets its retained request block a new day", async () => {
    await queue();await rebuildPendingCommunityDailyAggregates(db(),NOW,1,{chunks:8},recovery());
    const original = await db().prepare("SELECT * FROM community_daily_aggregates WHERE day=?").bind(DAY).first();
    await queue();await queue("2026-09-02");vi.clearAllMocks();
    expect(await rebuildPendingCommunityDailyAggregates(db(),NOW+86_400_000,1,{chunks:8},activityRecovery()))
      .toMatchObject({processed:1,remaining:true});
    expect(await db().prepare("SELECT * FROM community_daily_aggregates WHERE day=?").bind(DAY).first()).toEqual(original);
    expect((await db().prepare("SELECT day FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results)
      .toEqual([{day:DAY},{day:"2026-09-02"}]);
    expect(readers.fits).not.toHaveBeenCalled();expect(readers.rawFits).not.toHaveBeenCalled();
  });

  it("activity-only keeps the request and publishes nothing when the final source epoch changes", async () => {
    await usageDay();let raced = false;
    const database = new Proxy(db(), { get(target,key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (statements.length === 1) {
          raced = true;
          await target.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const queued = (await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results;
    expect(await rebuildPendingCommunityDailyAggregates(database,NOW,1,{chunks:8},activityRecovery()))
      .toMatchObject({remaining:true});
    expect(raced).toBe(true);
    expect((await db().prepare("SELECT * FROM community_daily_aggregates").all()).results).toEqual([]);
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds").all()).results).toEqual(queued);
    expect(readers.fits).not.toHaveBeenCalled();expect(readers.rawFits).not.toHaveBeenCalled();
  });
});
