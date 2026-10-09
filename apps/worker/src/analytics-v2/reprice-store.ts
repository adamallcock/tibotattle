/** Separate bounded plan/execute lane. Neither advances the journal nor rewrites owner-day evidence. */
import { withPostgresRead, withPostgresMutation, type PostgresPool } from "../postgres-client";
import { canonicalJson } from "../canonical-json";
import { ANALYTICS_V2_REFRESH_LOCK_KEY, ANALYTICS_V2_TABLES as T, type AnalyticsV2DailyMember } from "./contract";
import { quotedSchema } from "./owners";
import { validRunStamp, registerAnalyticsV2RunKernel, analyticsV2DailyContentSha256,
  type PreparedDailyCandidate } from "./store-run";
import { writeAnalyticsV2PublishedDaily } from "./store-publication";
import { writeAnalyticsV2OwnerSets } from "./store-owner-sets";
import { analyticsV2ContributionDigests } from "./owner-sets";
import { decodeAnalyticsV2PriceInputs, encodeAnalyticsV2PriceInputs, priceAnalyticsV2Input,
  assertAnalyticsV2PricesMatchDaily } from "./price-attribution";
import type { AnalyticsV2RunStamp } from "./kernel";
import { ANALYTICS_V2_REPRICE_TABLES as R, AnalyticsV2RepriceError, repriceFail,
  validAnalyticsV2RepriceBounds, prepareAnalyticsV2RepriceHead, type AnalyticsV2RepriceBounds,
  type AnalyticsV2RepriceRefusal } from "./reprice";
import { analyticsV2RepriceTarget, readAnalyticsV2RepriceMetadata, loadAnalyticsV2RepriceHeads,
  readAnalyticsV2RepriceEquivalences,validAnalyticsV2RepriceStoredReceipt } from "./reprice-read";
export { readAnalyticsV2RepriceEquivalences } from "./reprice-read";
export { ANALYTICS_V2_REPRICE_LIMITS, AnalyticsV2RepriceError } from "./reprice";

const REFUSALS = ["owner_set_unavailable","member_link_unavailable","price_inputs_unavailable",
  "price_input_association_unproven","price_inputs_corrupt","contribution_invalid",
  "reprice_membership_or_evidence_drift"] as const;
export interface AnalyticsV2RepricePlanOptions {
  readonly schema: string; readonly bounds: AnalyticsV2RepriceBounds; readonly stamp: AnalyticsV2RunStamp;
}
export interface AnalyticsV2RepriceExecutionReceipt {
  readonly schema: "analytics-v2-reprice-execution-v1"; readonly status: "complete"; readonly planSha256: string;
  readonly counts: { planned: number; changed: number; equivalent: number; unchanged: number; refused: number; contributionVersions: number };
  readonly refusals: Readonly<Record<AnalyticsV2RepriceRefusal,number>>; readonly replayed: boolean;
}
const preserve = (error: unknown): Error | null => error instanceof AnalyticsV2RepriceError ? error : null;
/** Planning is genuinely read-only: counts, cap flags and a digest only. */
export async function planAnalyticsV2Reprice(pool: PostgresPool, options: AnalyticsV2RepricePlanOptions) {
  const bounds = validAnalyticsV2RepriceBounds(options.bounds), stamp = validRunStamp(options.stamp);
  try {
    return await withPostgresRead(pool,async (client) => {
      const metadata = await readAnalyticsV2RepriceMetadata(client,{ schema: options.schema,bounds,stamp });
      return { schema: "analytics-v2-reprice-plan-v1" as const,status: "planned" as const,
        planSha256: metadata.planSha256,counts: metadata.counts,caps: metadata.caps,target: analyticsV2RepriceTarget(stamp) };
    },{ statementTimeoutMilliseconds: 15000,lockTimeoutMilliseconds: 250,operation: "analytics_v2.reprice_plan",preserveSafeError: preserve });
  } catch(error) { if(error instanceof AnalyticsV2RepriceError) throw error; return repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED"); }
}
/** The caller explicitly binds execution to a prior bounded plan. No retry or implicit discovery expansion. */
export async function executeAnalyticsV2Reprice(pool: PostgresPool, options: AnalyticsV2RepricePlanOptions & {
  readonly runId: string; readonly expectedPlanSha256: string; readonly nowMs: number;
}): Promise<AnalyticsV2RepriceExecutionReceipt> {
  const bounds = validAnalyticsV2RepriceBounds(options.bounds),stamp = validRunStamp(options.stamp);
  const s = quotedSchema(options.schema),target = analyticsV2RepriceTarget(stamp);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.runId)
    || !/^[0-9a-f]{64}$/u.test(options.expectedPlanSha256) || !Number.isSafeInteger(options.nowMs) || options.nowMs < 0) {
    repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  }
  try {
    return await withPostgresMutation(pool,async (client) => {
      // Lock mutable sources before the first snapshot SELECT. Coarse locks
      // are deliberate for this small, separately authorized bounded lane.
      // They prevent insert phantoms/source/exclusion races while pricing.
      await client.query(`LOCK TABLE ${s}.${T.publishedDaily},${s}.${T.dailyOwnerSets},${s}.${T.dailyContributions},
        ${s}.${T.ownerSetBootstrap},${s}.${T.ownerDayPrice},${s}.storage_v11_owner_links,
        ${s}.community_aggregate_exclusions IN SHARE MODE`);
      const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
        [ANALYTICS_V2_REFRESH_LOCK_KEY]);
      if (lock.rows[0]?.acquired !== true) repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED");
      // Schema presence is checked through the metadata reader, before a missing migration can be used.
      const metadata = await readAnalyticsV2RepriceMetadata(client,{ schema: options.schema,bounds,stamp });
      const existing = await client.query<Record<string, unknown>>(`SELECT plan_sha256::text,kernel_id,manifest_version,
        bounds,receipt FROM ${s}.${R.runs} WHERE run_id=$1::uuid`,[options.runId]);
      if (existing.rows.length > 0) {
        const row = existing.rows[0]!;
        if(row.plan_sha256 !== options.expectedPlanSha256 || row.kernel_id !== target.kernelId
          || row.manifest_version !== target.manifestVersion || canonicalJson(row.bounds) !== canonicalJson(bounds)) {
          repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
        }
        const receipt = row.receipt as AnalyticsV2RepriceExecutionReceipt;
        if(!validAnalyticsV2RepriceStoredReceipt(receipt,options.expectedPlanSha256)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
        return { ...receipt,replayed: true };
      }
      if(metadata.planSha256 !== options.expectedPlanSha256) repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
      if(Object.values(metadata.caps).some(Boolean)) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
      const already = await readAnalyticsV2RepriceEquivalences(client,{ schema: options.schema,stamp,
        heads: metadata.headRows.map((h) => ({ day: String(h.day),revision: Number(h.revision),payloadSha256: String(h.payload_sha256) })) });
      const heads = await loadAnalyticsV2RepriceHeads(client,options.schema,metadata);
      const counts = { planned: heads.length,changed: 0,equivalent: 0,unchanged: 0,refused: 0,contributionVersions: 0 };
      const refusals = Object.fromEntries(REFUSALS.map((code) => [code,0])) as Record<AnalyticsV2RepriceRefusal,number>;
      const prepared = [];
      for(const head of heads) {
        if(already.has(head.day)) { counts.unchanged++; continue; }
        const candidate = await prepareAnalyticsV2RepriceHead(head);
        counts[candidate.outcome]++;
        if(candidate.refusal !== null) refusals[candidate.refusal]++;
        else prepared.push(candidate);
      }
      const changed = prepared.filter((p) => p.outcome === "changed");
      const candidates: PreparedDailyCandidate[] = [];
      for(const candidate of changed) {
        const repriced = new Map(candidate.members.map((m) => [m.member.ownerDigest,m]));
        const members: AnalyticsV2DailyMember[] = candidate.head.members.map((member) => member.excluded
          ? { ownerDigest: member.ownerDigest,origin: "excluded",values: null,devices: null,savedVersion: null }
          : { ownerDigest: member.ownerDigest,origin: "computed",values: repriced.get(member.ownerDigest)!.values,
              devices: member.devices,savedVersion: null });
        candidates.push({ day: candidate.head.day,payload: candidate.payload!,
          payloadSha256: await analyticsV2DailyContentSha256(candidate.payload!),members,bootstrap: null });
      }
      const releasedAt = new Date(options.nowMs).toISOString();
      await registerAnalyticsV2RunKernel(client,s,stamp,releasedAt);
      const newer = await client.query<{ newest: number | null }>(`SELECT max(kernel_id)::integer AS newest FROM ${s}.${R.runs}`);
      if((newer.rows[0]?.newest ?? 0) > target.kernelId) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
      const publication = await writeAnalyticsV2PublishedDaily(client,s,{ dailyCandidates: candidates,revisionSeed: 0 },
        options.runId,releasedAt,stamp);
      const saved = await writeAnalyticsV2OwnerSets(client,s,candidates,publication,
        { contributionRetainedEvidenceAbsent: 0,savedMembersFolded: 0,memberContributionUnavailableDays: [],memberLinkUnavailableDays: [] },options.runId,stamp);
      counts.contributionVersions = saved.contributionVersions;
      // Store exact current-priced document for each version this lane appended.
      for(const candidate of changed) for(const { member,values } of candidate.members) {
        const digest = await analyticsV2ContributionDigests(values);
        if(digest.valuesSha256 === member.valuesSha256) continue;
        const decoded = member.inputs === null ? { events: [] } : await decodeAnalyticsV2PriceInputs(member.inputs);
        const events = decoded.events.map((event) => ({ input: event.input,priced: priceAnalyticsV2Input(event.input) }));
        assertAnalyticsV2PricesMatchDaily(candidate.head.day,events,values);
        const { inputs } = await encodeAnalyticsV2PriceInputs(events);
        await client.query(`INSERT INTO ${s}.${R.contributionPriceInputs}
          (day,owner_digest,version,values_sha256,projection_version,codec,inputs,inputs_sha256,
           source_inputs_sha256,input_events,run_id,kernel_id)
          VALUES($1::date,$2,$3,$4,$5,$6,decode($7,'base64'),$8,$9,$10,$11::uuid,$12)`,
          [candidate.head.day,member.ownerDigest,member.version+1,digest.valuesSha256,inputs.projectionVersion,inputs.codec,
            inputs.data,inputs.sha256,member.inputs?.sha256 ?? inputs.sha256,inputs.events,options.runId,target.kernelId]);
      }
      for(const candidate of prepared.filter((p) => p.outcome === "equivalent")) {
        await client.query(`INSERT INTO ${s}.${R.equivalences}
          (day,revision,payload_sha256,source_sha256,exclusions_sha256,kernel_id,manifest_version,
           registry_sha256,pricing_method_version,run_id)
          VALUES($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid)`,[candidate.head.day,candidate.head.revision,
            candidate.head.payloadSha256,metadata.sourceSha256.get(candidate.head.day),metadata.exclusionsSha256,
            target.kernelId,target.manifestVersion,target.registrySha256,target.pricingMethodVersion,options.runId]);
      }
      const receipt: AnalyticsV2RepriceExecutionReceipt = { schema: "analytics-v2-reprice-execution-v1",status: "complete",
        planSha256: options.expectedPlanSha256,counts,refusals,replayed: false };
      await client.query(`INSERT INTO ${s}.${R.runs}
        (run_id,plan_sha256,kernel_id,manifest_version,registry_sha256,pricing_method_version,bounds,receipt,finished_at)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::timestamptz)`,[options.runId,
          options.expectedPlanSha256,target.kernelId,target.manifestVersion,target.registrySha256,target.pricingMethodVersion,
          bounds,receipt,releasedAt]);
      return receipt;
    },{ isolationLevel: "repeatable_read",statementTimeoutMilliseconds: 30000,lockTimeoutMilliseconds: 250,
      operation: "analytics_v2.reprice_execute",preserveSafeError: preserve });
  } catch(error) { if(error instanceof AnalyticsV2RepriceError) throw error; return repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED"); }
}
