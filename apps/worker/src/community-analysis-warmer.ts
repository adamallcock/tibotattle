import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { advanceCommunityAnalysisRun } from "./community-analysis-runner";
import type { CommunityAnalysisWorkIdentity } from "./community-analysis-work";
import {
  communityAnalysisCachesCurrent, completedCommunityAnalysisCachesCurrent,
  loadCommunitySourcePin, publishCommunityAnalysisCaches,
  type CommunityAnalysisCacheIdentity, type CommunityModelCacheReadBudget,
} from "./community-allowance";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import {
  V1_ANALYSIS_WINDOW_DAYS, MAX_DOWNSAMPLED_QUOTA_ROWS, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
  finishAccountScopedAnalysesV1, v1PreparedFinishQueryReserve, v1QuotaFinishQueryReserve, type V1ModelCompositionResult,
} from "./quota-analysis-v1";
import { accountScopedModelCompositionV11, accountScopedQuotaAnalysisV11 } from "./quota-analysis-v11";
import type { D1InvocationBudget } from "./d1-invocation-budget";
import { readCommunityRefreshLane, recordCommunityRefreshLane } from "./community-refresh-lanes";
import { ensurePreparedV1Window, createPreparedV1EvidenceReader, canPrepareV1Window } from "./prepared-v1-evidence";
import { acknowledgeCurrentAnalysisJob, claimCurrentAnalysisJob, prepareCurrentAnalysisQueue,
  retireEmptyCurrentAnalysisJob } from "./community-analysis-queue";

const DAY_MS = 86_400_000;
const FINAL_RESERVE = 12;
export interface CommunityAnalysisWarmResult {
  status: "complete" | "deferred" | "unavailable";
  visited: number;
  published: number;
  resumed: number;
}

const LEGACY_OVERLAP_SQL = `SELECT EXISTS (
    SELECT 1 FROM telemetry_records r INDEXED BY telemetry_records_participant_time
    WHERE r.participant_id=?1 AND r.observed_at>=?2 AND r.record_kind='quota'
      AND r.provider='openai_codex' AND r.limit_id='codex'
      AND EXISTS (
        SELECT 1 FROM telemetry_contribution_occurrences o INDEXED BY telemetry_contribution_occurrences_record
        JOIN telemetry_contributions c ON c.id=o.contribution_id
        WHERE o.participant_id=r.participant_id AND o.record_kind=r.record_kind
          AND o.occurrence_id=r.occurrence_id AND c.status='accepted'
          AND c.transport_schema_version='telemetry-contribution-v0.2'
      )
  ) AS legacy_overlap`;

function validBudget(budget: CommunityModelCacheReadBudget, required: number): boolean {
  const now=(budget.now??Date.now)();
  return Number.isSafeInteger(budget.remainingQueries) && budget.remainingQueries >= required
    && Number.isFinite(now) && Number.isFinite(budget.deadlineMs) && now < budget.deadlineMs;
}

/** A bounded, fair scheduled warmer. Browser and graph consumers never call it.
 * `meter` is the SAME actual-statement meter wrapping both scheduled bindings;
 * each participant gets a conservative allocation from its current remainder.
 * No additional infrastructure or unbounded raw quota query is introduced.
 */
export async function warmCommunityAnalysisCaches(db: D1Database, nowMs: number, options: {
  meter: D1InvocationBudget; deadlineMs: number; maintenanceLease: string;
}): Promise<CommunityAnalysisWarmResult> {
  const result: CommunityAnalysisWarmResult = {status:"deferred",visited:0,published:0,resumed:0};
  if (!Number.isFinite(nowMs) || !Number.isFinite(options.deadlineMs) || !options.maintenanceLease) return result;
  if (options.meter.remainingQueries < FINAL_RESERVE + 2 || Date.now() >= options.deadlineMs) return result;
  const lane = await readCommunityRefreshLane(db, "current", nowMs);
  if (lane.current) return {...result, status:"complete"};
  const fromDay=new Date(nowMs-V1_ANALYSIS_WINDOW_DAYS*DAY_MS).toISOString().slice(0,10);
  const observedAtCutoff=`${fromDay}T00:00:00.000Z`;
  const resetsAtCutoff=new Date(Date.parse(observedAtCutoff)+SEVEN_DAY_WINDOW_MINUTES*60_000).toISOString();
  const pass = await prepareCurrentAnalysisQueue(db, lane.day, lane.method, options.maintenanceLease);
  if (!pass) return result;
  // The durable queue is ordered by actual service, not the scheduled minute.
  // Claiming moves a job to the back before any expensive work. The initial
  // sequence admits each account at most once here; SQL/time budgets, not an
  // arbitrary account count, determine useful throughput.
  while(options.meter.remainingQueries>=FINAL_RESERVE+22 && Date.now()<options.deadlineMs) {
    const candidate=await claimCurrentAnalysisJob(db,pass,options.maintenanceLease);
    if(!candidate) break;
    result.visited++;
    if (!candidate.hasV1 && !candidate.hasV11 && !candidate.hasLegacy) {
      await retireEmptyCurrentAnalysisJob(db,candidate,options.maintenanceLease);
      continue;
    }
    const source=candidate.hasV11?"v1.1":candidate.hasV1?candidate.hasLegacy?"mixed":"v1":"v0.2";
    if (source === "v1"
        && await completedCommunityAnalysisCachesCurrent(db, candidate.participantId, candidate.inputRevision, fromDay)) {
      await acknowledgeCurrentAnalysisJob(db,candidate,options.maintenanceLease);
      continue;
    }
    const legacyOverlap = source === "mixed" ? await db.prepare(LEGACY_OVERLAP_SQL)
      .bind(candidate.participantId,observedAtCutoff).first<{legacy_overlap:number}>() : null;
    if (source === "mixed" && (!legacyOverlap || ![0,1].includes(legacyOverlap.legacy_overlap))) return {...result,status:"unavailable"};
    const {sourcePin,fingerprint}=await loadCommunitySourcePin(db,candidate.participantId,fromDay,source,
      { includeDayDependencies: true });
    if (sourcePin.inputRevision !== candidate.inputRevision) continue;
    const identity: CommunityAnalysisCacheIdentity = {participantId:candidate.participantId,source,sourcePin,
      fitFingerprint:fingerprint,fromDay,compositionSupported:source!=="v0.2"&&!legacyOverlap?.legacy_overlap};
    if(await communityAnalysisCachesCurrent(db,identity)) {
      await acknowledgeCurrentAnalysisJob(db,candidate,options.maintenanceLease);
      continue;
    }
    const allocation: CommunityModelCacheReadBudget = {remainingQueries:Math.max(0,options.meter.remainingQueries-FINAL_RESERVE),deadlineMs:options.deadlineMs};
    const analyses: {source:"v0.2"|"v1"|"v1.1";analysis:object}[]=[];
    let composition: V1ModelCompositionResult|null=null;
    if("source" in sourcePin && sourcePin.source==="v1.1") {
      // The successor adapter already uses bounded daily usage pages; it is
      // never sent through the legacy quota projection. Activation is unchanged.
      if(!validBudget(allocation,640)) continue;
      analyses.push({source:"v1.1",analysis:await accountScopedQuotaAnalysisV11(db,candidate.participantId,{nowMs,sourcePin})});
      composition=await accountScopedModelCompositionV11(db,candidate.participantId,{nowMs,sourcePin});
    } else if(source!=="v0.2") {
      if(!("scope" in sourcePin) || sourcePin.inputRevision===null) throw new TypeError("v1 analysis source unavailable");
      const previous=await db.prepare(`SELECT fixed_now,input_revision,input_fingerprint,source_method_version,observed_at_cutoff,resets_at_cutoff
        FROM community_analysis_work WHERE participant_id=?`).bind(candidate.participantId)
        .first<{fixed_now:string;input_revision:number;input_fingerprint:string;source_method_version:string;observed_at_cutoff:string;resets_at_cutoff:string}>();
      allocation.remainingQueries=Math.max(0,options.meter.remainingQueries-FINAL_RESERVE);
      const reuse=previous && previous.input_revision===sourcePin.inputRevision && previous.input_fingerprint===sourcePin.fingerprint
        && previous.source_method_version===V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION
        && previous.observed_at_cutoff===observedAtCutoff && previous.resets_at_cutoff===resetsAtCutoff;
      const workIdentity: CommunityAnalysisWorkIdentity = {participantId:candidate.participantId,inputRevision:sourcePin.inputRevision,
        inputFingerprint:sourcePin.fingerprint,sourceKind:"v1",sourceMethodVersion:V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
        fixedNow:reuse?previous.fixed_now:new Date(nowMs).toISOString(),observedAtCutoff,resetsAtCutoff,
        windowMinutes:SEVEN_DAY_WINDOW_MINUTES,maxQuotaRows:MAX_DOWNSAMPLED_QUOTA_ROWS};
      let preparedEvidence: Awaited<ReturnType<typeof createPreparedV1EvidenceReader>> | undefined;
      if (canPrepareV1Window(sourcePin)) {
        const preparation = await ensurePreparedV1Window(db, sourcePin,
          { maxPages: 64, deadlineMs: options.deadlineMs, budget: allocation });
        if (preparation.status !== "complete" || !validBudget(allocation, 1)) continue;
        allocation.remainingQueries -= 1;
        preparedEvidence = await createPreparedV1EvidenceReader(db, sourcePin);
      }
      const finishReserve = preparedEvidence ? v1PreparedFinishQueryReserve(preparedEvidence) : v1QuotaFinishQueryReserve();
      // Acquisition makes durable progress even when this pass cannot finish.
      // A completed checkpoint can be finished in the next independent pass.
      const acquired=await advanceCommunityAnalysisRun(db,{identity:workIdentity,sourcePin,budget:allocation,
        preparedReader: preparedEvidence,
        completedEvidenceReserveQueries:finishReserve});
      result.resumed++;
      if(acquired.status==="not_testable") {
        analyses.push({source:"v1",analysis:{status:"not_testable",reason:acquired.reason}});
        if(identity.compositionSupported) composition={status:"not_testable",reason:acquired.reason};
      } else if(acquired.status==="ready") {
        // Refresh from actual usage: acquisition's conservative reservations
        // must not be confused with statements actually sent to the database.
        allocation.remainingQueries=Math.max(0,options.meter.remainingQueries-FINAL_RESERVE);
        if(!validBudget(allocation,finishReserve)) continue;
        const finished=await finishAccountScopedAnalysesV1(db,candidate.participantId,acquired.evidence,allocation,
          {nowMs:Date.parse(workIdentity.fixedNow),sourcePin,preparedEvidence});
        if(finished.status!=="complete") continue;
        analyses.push({source:"v1",analysis:finished.quotaAnalysis});
        if(identity.compositionSupported) composition=finished.modelComposition;
      } else continue;
    }
    if(source==="mixed"||source==="v0.2") {
      if(options.meter.remainingQueries<FINAL_RESERVE+5) continue;
      analyses.push({source:"v0.2",analysis:await accountScopedQuotaAnalysis(db,candidate.participantId)});
    }
    if(options.meter.remainingQueries<FINAL_RESERVE) continue;
    if(await publishCommunityAnalysisCaches(db,identity,analyses,composition,options.maintenanceLease,candidate)) result.published++;
  }
  // Completion is an atomic queue-empty/source/lease check, not a census or
  // a count of how many jobs happened to finish in this invocation.
  const recorded = options.meter.remainingQueries > FINAL_RESERVE && Date.now() < options.deadlineMs
    && await recordCommunityRefreshLane(db, lane, true, nowMs, options.maintenanceLease);
  return {...result,status:recorded ? "complete":"deferred"};
}
