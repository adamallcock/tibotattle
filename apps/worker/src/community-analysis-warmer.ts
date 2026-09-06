import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { advanceCommunityAnalysisRun } from "./community-analysis-runner";
import type { CommunityAnalysisWorkIdentity } from "./community-analysis-work";
import {
  COMMUNITY_PARTICIPANT_PAGE_CTE, communityAnalysisCachesCurrent,
  loadCommunitySourcePin, publishCommunityAnalysisCaches,
  type CommunityAnalysisCacheIdentity, type CommunityModelCacheReadBudget,
} from "./community-allowance";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import {
  V1_ANALYSIS_WINDOW_DAYS, MAX_DOWNSAMPLED_QUOTA_ROWS, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
  finishAccountScopedAnalysesV1, v1QuotaFinishQueryReserve, type V1ModelCompositionResult,
} from "./quota-analysis-v1";
import { accountScopedModelCompositionV11, accountScopedQuotaAnalysisV11 } from "./quota-analysis-v11";
import type { D1InvocationBudget } from "./d1-invocation-budget";

const DAY_MS = 86_400_000;
const PAGE_SIZE = 64;
const MAX_CENSUS_PAGES = 16;
const MAX_PARTICIPANTS_PER_PASS = 4;
const FINAL_RESERVE = 12;

interface Candidate {
  participant_id: string;
  has_v1: number;
  has_v11: number;
  has_legacy: number;
  legacy_overlap: number;
}
export interface CommunityAnalysisWarmResult {
  status: "complete" | "deferred" | "unavailable";
  visited: number;
  published: number;
  resumed: number;
}

const CANDIDATE_PAGE_SQL = `${COMMUNITY_PARTICIPANT_PAGE_CTE}
SELECT s.id AS participant_id, s.has_v1, s.has_v11, s.has_legacy,
  CASE WHEN s.has_v11=0 AND s.has_v1=1 AND s.has_legacy=1 THEN EXISTS (
    SELECT 1 FROM telemetry_records r INDEXED BY telemetry_records_participant_time
    WHERE r.participant_id=s.id AND r.observed_at>=?3 AND r.record_kind='quota'
      AND r.provider='openai_codex' AND r.limit_id='codex'
      AND EXISTS (
        SELECT 1 FROM telemetry_contribution_occurrences o INDEXED BY telemetry_contribution_occurrences_record
        JOIN telemetry_contributions c ON c.id=o.contribution_id
        WHERE o.participant_id=r.participant_id AND o.record_kind=r.record_kind
          AND o.occurrence_id=r.occurrence_id AND c.status='accepted'
          AND c.transport_schema_version='telemetry-contribution-v0.2'
      )
  ) ELSE 0 END AS legacy_overlap
FROM sources s ORDER BY s.id`;

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
  const fromDay=new Date(nowMs-V1_ANALYSIS_WINDOW_DAYS*DAY_MS).toISOString().slice(0,10);
  const observedAtCutoff=`${fromDay}T00:00:00.000Z`;
  const resetsAtCutoff=new Date(Date.parse(observedAtCutoff)+SEVEN_DAY_WINDOW_MINUTES*60_000).toISOString();
  const candidates: Candidate[]=[];
  let cursor="", complete=false;
  for(let page=0;page<MAX_CENSUS_PAGES;page++) {
    if(options.meter.remainingQueries<FINAL_RESERVE+1 || Date.now()>=options.deadlineMs) return result;
    const rows=(await db.prepare(CANDIDATE_PAGE_SQL).bind(cursor,PAGE_SIZE+1,observedAtCutoff).all<Candidate>()).results;
    if(!Array.isArray(rows)||rows.length>PAGE_SIZE+1) return {...result,status:"unavailable"};
    let previous=cursor;
    for(const row of rows) {
      if(typeof row.participant_id!=="string"||row.participant_id<=previous||row.participant_id.length>128
        ||![row.has_v1,row.has_v11,row.has_legacy,row.legacy_overlap].every(value=>value===0||value===1)) return {...result,status:"unavailable"};
      previous=row.participant_id;
    }
    for(const row of rows.slice(0,PAGE_SIZE)) {
      cursor=row.participant_id;
      if(row.has_v1||row.has_v11||row.has_legacy) candidates.push(row);
    }
    if(rows.length<=PAGE_SIZE) {complete=true;break;}
  }
  if(!complete) return result;
  if(candidates.length===0) return {...result,status:"complete"};
  // Rotate over a stable participant-ID census: a large or continuously changing
  // first account cannot monopolize every pass. No participant ID enters logs.
  const start=Math.floor(nowMs/60_000)%candidates.length;
  let deferred=false, attempted=0;
  // Current-cache probes remain metered, but do not consume useful-work slots.
  // Scan at most the bounded census once in the same rotating order; a prefix
  // of already-finished accounts must not hide unfinished work on an idle pass.
  // This is still sequential and does not increase the shared time/query limits.
  for(let index=0;index<candidates.length&&attempted<MAX_PARTICIPANTS_PER_PASS;index++) {
    if(options.meter.remainingQueries<FINAL_RESERVE+20 || Date.now()>=options.deadlineMs) {deferred=true;break;}
    const candidate=candidates[(start+index)%candidates.length]!;
    const source=candidate.has_v11?"v1.1":candidate.has_v1?candidate.has_legacy?"mixed":"v1":"v0.2";
    const {sourcePin,fingerprint}=await loadCommunitySourcePin(db,candidate.participant_id,fromDay,source);
    const identity: CommunityAnalysisCacheIdentity = {participantId:candidate.participant_id,source,sourcePin,
      fitFingerprint:fingerprint,fromDay,compositionSupported:source!=="v0.2"&&!candidate.legacy_overlap};
    result.visited++;
    if(await communityAnalysisCachesCurrent(db,identity)) continue;
    attempted++;
    const allocation: CommunityModelCacheReadBudget = {remainingQueries:Math.max(0,options.meter.remainingQueries-FINAL_RESERVE),deadlineMs:options.deadlineMs};
    const analyses: {source:"v0.2"|"v1"|"v1.1";analysis:object}[]=[];
    let composition: V1ModelCompositionResult|null=null;
    if("source" in sourcePin && sourcePin.source==="v1.1") {
      // The successor adapter already uses bounded daily usage pages; it is
      // never sent through the legacy quota projection. Activation is unchanged.
      if(!validBudget(allocation,640)) {deferred=true;continue;}
      analyses.push({source:"v1.1",analysis:await accountScopedQuotaAnalysisV11(db,candidate.participant_id,{nowMs,sourcePin})});
      composition=await accountScopedModelCompositionV11(db,candidate.participant_id,{nowMs,sourcePin});
    } else if(source!=="v0.2") {
      if(!("scope" in sourcePin) || sourcePin.inputRevision===null) throw new TypeError("v1 analysis source unavailable");
      const previous=await db.prepare(`SELECT fixed_now,input_revision,input_fingerprint,source_method_version,observed_at_cutoff,resets_at_cutoff
        FROM community_analysis_work WHERE participant_id=?`).bind(candidate.participant_id)
        .first<{fixed_now:string;input_revision:number;input_fingerprint:string;source_method_version:string;observed_at_cutoff:string;resets_at_cutoff:string}>();
      allocation.remainingQueries=Math.max(0,options.meter.remainingQueries-FINAL_RESERVE);
      const reuse=previous && previous.input_revision===sourcePin.inputRevision && previous.input_fingerprint===sourcePin.fingerprint
        && previous.source_method_version===V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION
        && previous.observed_at_cutoff===observedAtCutoff && previous.resets_at_cutoff===resetsAtCutoff;
      const workIdentity: CommunityAnalysisWorkIdentity = {participantId:candidate.participant_id,inputRevision:sourcePin.inputRevision,
        inputFingerprint:sourcePin.fingerprint,sourceKind:"v1",sourceMethodVersion:V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
        fixedNow:reuse?previous.fixed_now:new Date(nowMs).toISOString(),observedAtCutoff,resetsAtCutoff,
        windowMinutes:SEVEN_DAY_WINDOW_MINUTES,maxQuotaRows:MAX_DOWNSAMPLED_QUOTA_ROWS};
      // Acquisition makes durable progress even when this pass cannot finish.
      // A completed checkpoint can be finished in the next independent pass.
      const acquired=await advanceCommunityAnalysisRun(db,{identity:workIdentity,sourcePin,budget:allocation,
        completedEvidenceReserveQueries:v1QuotaFinishQueryReserve()});
      result.resumed++;
      if(acquired.status==="not_testable") {
        analyses.push({source:"v1",analysis:{status:"not_testable",reason:acquired.reason}});
        if(identity.compositionSupported) composition={status:"not_testable",reason:acquired.reason};
      } else if(acquired.status==="ready") {
        // Refresh from actual usage: acquisition's conservative reservations
        // must not be confused with statements actually sent to the database.
        allocation.remainingQueries=Math.max(0,options.meter.remainingQueries-FINAL_RESERVE);
        if(!validBudget(allocation,v1QuotaFinishQueryReserve())) {deferred=true;continue;}
        const finished=await finishAccountScopedAnalysesV1(db,candidate.participant_id,acquired.evidence,allocation,
          {nowMs:Date.parse(workIdentity.fixedNow),sourcePin});
        if(finished.status!=="complete") {deferred=true;continue;}
        analyses.push({source:"v1",analysis:finished.quotaAnalysis});
        if(identity.compositionSupported) composition=finished.modelComposition;
      } else {deferred=true;continue;}
    }
    if(source==="mixed"||source==="v0.2") {
      if(options.meter.remainingQueries<FINAL_RESERVE+5) {deferred=true;continue;}
      analyses.push({source:"v0.2",analysis:await accountScopedQuotaAnalysis(db,candidate.participant_id)});
    }
    if(options.meter.remainingQueries<FINAL_RESERVE) {deferred=true;continue;}
    if(await publishCommunityAnalysisCaches(db,identity,analyses,composition,options.maintenanceLease)) result.published++;
    else deferred=true;
  }
  return {...result,status:!deferred&&result.visited===candidates.length?"complete":"deferred"};
}
