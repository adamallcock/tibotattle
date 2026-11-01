/** Same bounded carrier and publication writers; a distinct, explicit source contract. */
import { withPostgresRead, withPostgresMutation, type PostgresPool } from "../postgres-client";
import { canonicalJson } from "../canonical-json";
import { ANALYTICS_V2_REFRESH_LOCK_KEY, ANALYTICS_V2_TABLES as T, type AnalyticsV2DailyMember } from "./contract";
import { quotedSchema } from "./owners";
import { validRunStamp, registerAnalyticsV2RunKernel, analyticsV2DailyContentSha256, type PreparedDailyCandidate } from "./store-run";
import { writeAnalyticsV2PublishedDaily } from "./store-publication";
import { writeAnalyticsV2OwnerSets } from "./store-owner-sets";
import { analyticsV2ContributionDigests } from "./owner-sets";
import { encodeAnalyticsV2PriceInputs, assertAnalyticsV2PricesMatchDaily } from "./price-attribution";
import { ANALYTICS_V2_REPRICE_TABLES as R, AnalyticsV2RepriceError, repriceFail, validAnalyticsV2RepriceBounds } from "./reprice";
import { analyticsV2RepriceTarget } from "./reprice-read";
import { ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS, prepareAnalyticsV2CurrentCorrectionHead,
  validAnalyticsV2CurrentCorrectionStoredReceipt, validCurrentCorrectionSourceKernel,
  type CurrentCorrectionReceipt, type CurrentCorrectionRefusal } from "./current-correction";
import { requireCurrentCorrectionSchema, readCurrentCorrectionMetadata, loadCurrentCorrectionHeads,
  type CurrentCorrectionOptions } from "./current-correction-read";
const preserve = (error: unknown): Error | null => error instanceof AnalyticsV2RepriceError ? error : null;
function validated(options: CurrentCorrectionOptions): CurrentCorrectionOptions {
  return { ...options,bounds: validAnalyticsV2RepriceBounds(options.bounds),stamp: validRunStamp(options.stamp),
    sourceKernelId: validCurrentCorrectionSourceKernel(options.sourceKernelId) };
}
export async function planAnalyticsV2CurrentCorrection(pool: PostgresPool, input: CurrentCorrectionOptions) {
  const options = validated(input);
  try {
    return await withPostgresRead(pool, async client => {
      const m = await readCurrentCorrectionMetadata(client,options);
      return { schema: "analytics-v2-current-correction-plan-v1" as const,status: "planned" as const,
        inputSource: "current-owner-day" as const,sourceKernelId: options.sourceKernelId,
        planSha256: m.planSha256,counts: m.counts,caps: m.caps,target: analyticsV2RepriceTarget(options.stamp) };
    }, { statementTimeoutMilliseconds: 15000,lockTimeoutMilliseconds: 250,
      operation: "analytics_v2.current_correction_plan",preserveSafeError: preserve });
  } catch (error) { if (error instanceof AnalyticsV2RepriceError) throw error; return repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED"); }
}
export async function executeAnalyticsV2CurrentCorrection(pool: PostgresPool, input: CurrentCorrectionOptions & {
  readonly runId: string; readonly expectedPlanSha256: string; readonly nowMs: number;
}): Promise<CurrentCorrectionReceipt> {
  const options = validated(input), s = quotedSchema(options.schema), target = analyticsV2RepriceTarget(options.stamp);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.runId)
    || !/^[0-9a-f]{64}$/u.test(input.expectedPlanSha256) || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isFinite(new Date(input.nowMs).getTime())) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  try {
    return await withPostgresMutation(pool, async client => {
      // Acquire every mutable-source lock before the first snapshot SELECT.
      await client.query(`LOCK TABLE ${s}.${T.publishedDaily},${s}.${T.dailyOwnerSets},${s}.${T.dailyContributions},
        ${s}.${T.ownerSetBootstrap},${s}.${T.ownerDayPrice},${s}.${T.ownerDay},${s}.${T.runs},
        ${s}.${R.contributionPriceInputs},${s}.${R.runs},${s}.storage_v11_owner_links,
        ${s}.community_aggregate_exclusions IN SHARE MODE`);
      await requireCurrentCorrectionSchema(client,options.schema);
      const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [ANALYTICS_V2_REFRESH_LOCK_KEY]);
      if (lock.rows[0]?.acquired !== true) repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED");
      const existing = await client.query<Record<string,unknown>>(`SELECT plan_sha256::text,kernel_id,manifest_version,
        input_source,source_kernel_id,bounds,receipt FROM ${s}.${R.runs} WHERE run_id=$1::uuid`, [input.runId]);
      if (existing.rows.length > 0) {
        const r = existing.rows[0]!;
        if (r.input_source !== "current-owner-day" || r.source_kernel_id !== options.sourceKernelId
          || r.plan_sha256 !== input.expectedPlanSha256 || r.kernel_id !== target.kernelId || r.manifest_version !== target.manifestVersion
          || canonicalJson(r.bounds) !== canonicalJson(options.bounds)) repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
        if (!validAnalyticsV2CurrentCorrectionStoredReceipt(r.receipt,input.expectedPlanSha256,options.sourceKernelId)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
        return { ...(r.receipt as CurrentCorrectionReceipt),replayed: true };
      }
      const occupied = await client.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${s}.${T.runs} WHERE run_id=$1::uuid) AS present`, [input.runId]);
      if (occupied.rows[0]?.present !== false) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
      const metadata = await readCurrentCorrectionMetadata(client,options);
      if (metadata.planSha256 !== input.expectedPlanSha256) repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
      if (Object.values(metadata.caps).some(Boolean)) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
      const heads = await loadCurrentCorrectionHeads(client,options.schema,metadata);
      const counts = { planned: heads.length,changed: 0,unchanged: 0,refused: 0,contributionVersions: 0,
        currentSourceVersions: 0,archiveSourceVersions: 0 };
      const refusals = Object.fromEntries(ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS.map(code => [code,0])) as Record<CurrentCorrectionRefusal,number>;
      const changed = [];
      for (const head of heads) {
        const candidate = await prepareAnalyticsV2CurrentCorrectionHead(head,options.sourceKernelId);
        counts[candidate.outcome]++;
        if (candidate.refusal !== null) refusals[candidate.refusal]++;
        if (candidate.outcome === "changed") changed.push(candidate);
      }
      const candidates: PreparedDailyCandidate[] = [];
      for (const candidate of changed) {
        const corrected = new Map(candidate.members.map(m => [m.member.ownerDigest,m]));
        const members: AnalyticsV2DailyMember[] = candidate.head.members.map(m => m.excluded
          ? { ownerDigest: m.ownerDigest,origin: "excluded",values: null,devices: null,savedVersion: null }
          : corrected.get(m.ownerDigest)!.provenance === null
            ? { ownerDigest: m.ownerDigest,origin: "saved",values: null,devices: null,savedVersion: m.version }
            : { ownerDigest: m.ownerDigest,origin: "computed",values: corrected.get(m.ownerDigest)!.values,devices: m.devices,savedVersion: null });
        candidates.push({ day: candidate.head.day,payload: candidate.payload!,payloadSha256: await analyticsV2DailyContentSha256(candidate.payload!),members,bootstrap: null });
      }
      const releasedAt = new Date(input.nowMs).toISOString();
      await registerAnalyticsV2RunKernel(client,s,options.stamp,releasedAt);
      const publication = await writeAnalyticsV2PublishedDaily(client,s,{ dailyCandidates: candidates,revisionSeed: 0 },input.runId,releasedAt,options.stamp);
      const saved = await writeAnalyticsV2OwnerSets(client,s,candidates,publication,
        { contributionRetainedEvidenceAbsent: 0,savedMembersFolded: 0,memberContributionUnavailableDays: [],memberLinkUnavailableDays: [] },input.runId,options.stamp);
      counts.contributionVersions = saved.contributionVersions;
      for (const candidate of changed) for (const { member,values,events,provenance } of candidate.members) {
        if (provenance === null) continue;
        const digests = await analyticsV2ContributionDigests(values);
        if (digests.valuesSha256 === member.valuesSha256) continue;
        assertAnalyticsV2PricesMatchDaily(candidate.head.day,events,values);
        const { inputs } = await encodeAnalyticsV2PriceInputs(events);
        await client.query(`INSERT INTO ${s}.${R.contributionPriceInputs}
          (day,owner_digest,version,values_sha256,projection_version,codec,inputs,inputs_sha256,source_inputs_sha256,
           input_events,run_id,kernel_id,correction_provenance)
          VALUES($1::date,$2,$3,$4,$5,$6,decode($7,'base64'),$8,$9,$10,$11::uuid,$12,$13::jsonb)`,
          [candidate.head.day,member.ownerDigest,member.version+1,digests.valuesSha256,inputs.projectionVersion,inputs.codec,
            inputs.data,inputs.sha256,provenance.sourceInputsSha256,inputs.events,input.runId,target.kernelId,provenance]);
        if (provenance.inputSource === "current-owner-day") counts.currentSourceVersions++; else counts.archiveSourceVersions++;
      }
      const receipt: CurrentCorrectionReceipt = { schema: "analytics-v2-current-correction-execution-v1",status: "complete",
        inputSource: "current-owner-day",sourceKernelId: options.sourceKernelId,planSha256: input.expectedPlanSha256,counts,refusals,replayed: false };
      if (!validAnalyticsV2CurrentCorrectionStoredReceipt(receipt,input.expectedPlanSha256,options.sourceKernelId)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
      await client.query(`INSERT INTO ${s}.${R.runs}
        (run_id,plan_sha256,kernel_id,manifest_version,registry_sha256,pricing_method_version,bounds,receipt,finished_at,input_source,source_kernel_id)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::timestamptz,$10,$11)`,
        [input.runId,input.expectedPlanSha256,target.kernelId,target.manifestVersion,target.registrySha256,target.pricingMethodVersion,
          options.bounds,receipt,releasedAt,"current-owner-day",options.sourceKernelId]);
      return receipt;
    }, { isolationLevel: "repeatable_read",statementTimeoutMilliseconds: 30000,lockTimeoutMilliseconds: 250,
      operation: "analytics_v2.current_correction_execute",preserveSafeError: preserve });
  } catch (error) { if (error instanceof AnalyticsV2RepriceError) throw error; return repriceFail("ANALYTICS_V2_REPRICE_WRITE_FAILED"); }
}
