import { canonicalJson } from "./canonical-json";
import {
  communityAnalysisWorkStore, createCommunityAnalysisWorkStore,
  COMMUNITY_ANALYSIS_PARTS_PER_READ,
  type CommunityAnalysisWorkIdentity, type CommunityAnalysisWorkBudget, type CommunityAnalysisWorkHead,
  type CommunityAnalysisWorkStage, type CommunityAnalysisStageTarget, type CommunityAnalysisWorkStore,
} from "./community-analysis-work";
import {
  advanceV1QuotaAcquisitionPage, createV1QuotaAcquisitionCheckpoint,
  createV1QuotaWorkInterner, decodeV1QuotaWorkCheckpoint, encodeV1QuotaWorkCheckpoint,
  validateV1CompletedQuotaAcquisition, type V1QuotaAcquisitionIdentity,
  type V1QuotaAcquisitionCheckpoint, type V1QuotaPageReader, type V1QuotaPageReplay,
  type V1QuotaWorkComponent, type V1QuotaInvocationBudget,
} from "./quota-analysis-v1-reader";
import { createV1QuotaPageReader, V1QuotaFitProjectionUnavailableError } from "./quota-fit-projection";
import { loadV1SourcePin, type V1SourcePin } from "./telemetry-v1-source-selection";
import type { V1AcquiredQuotaEvidence } from "./quota-analysis-v1";
import { MODEL_HISTORY_METHOD_VERSION } from "./quota-analysis-v1";
import { modelHistoryWindow } from "./model-history-window";

const historyWorkStore = createCommunityAnalysisWorkStore("model-history");

export type CommunityAnalysisRunResult =
  | { status: "ready"; evidence: V1AcquiredQuotaEvidence; head: CommunityAnalysisWorkHead }
  | { status: "deferred" | "stale" | "corrupt" | "projection_unavailable" }
  | { status: "not_testable"; reason: "plan_attribution_limit_exceeded" | "downsampled_quota_limit_exceeded" };

/** Keep the original fixedNow and its exact observed/reset cutoffs throughout a
 * run. Recomputing them on each invocation invalidates resumability. The caller
 * chooses the shared finisher's horizon and source-method version, and pins the
 * same participant/day winner vector. This helper only narrows that identity;
 * it never changes a horizon, method, source revision, or quota cap. */
export function communityAnalysisAcquisitionIdentity(identity: CommunityAnalysisWorkIdentity): V1QuotaAcquisitionIdentity {
  const result = { participantId: identity.participantId, inputFingerprint: identity.inputFingerprint,
    sourceMethodVersion: identity.sourceMethodVersion, observedAtCutoff: identity.observedAtCutoff,
    resetsAtCutoff: identity.resetsAtCutoff, windowMinutes: identity.windowMinutes, maxQuotaRows: identity.maxQuotaRows };
  createV1QuotaAcquisitionCheckpoint(result);
  return result;
}

function available(budget: CommunityAnalysisWorkBudget, count: number): boolean {
  if (!Number.isSafeInteger(budget.remainingQueries) || budget.remainingQueries < 0
    || !Number.isSafeInteger(budget.reserveQueries ?? 0) || (budget.reserveQueries ?? 0) < 0
    || !Number.isFinite(budget.deadlineMs)) throw new TypeError("community analysis run budget invalid");
  const now = (budget.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new TypeError("community analysis run clock invalid");
  return budget.remainingQueries - (budget.reserveQueries ?? 0) >= count && now < budget.deadlineMs;
}
function spend(budget: CommunityAnalysisWorkBudget, count: number): boolean {
  if (!available(budget, count)) return false;
  budget.remainingQueries -= count;
  return true;
}
async function sourceCurrent(db: D1Database, pin: V1SourcePin,
  budget: CommunityAnalysisWorkBudget): Promise<"ready" | "stale" | "deferred"> {
  if (!spend(budget, 2)) return "deferred";
  const current = await loadV1SourcePin(db, pin.scope);
  return current.fingerprint === pin.fingerprint && current.inputRevision === pin.inputRevision
    && current.winnersJson === pin.winnersJson && canonicalJson(current.winners) === canonicalJson(pin.winners)
    ? "ready" : "stale";
}

async function loadCheckpoint(work: CommunityAnalysisWorkStore, db: D1Database, head: CommunityAnalysisWorkHead,
  budget: CommunityAnalysisWorkBudget, progressReserve: number): Promise<
    | { status: "ready"; state: V1QuotaAcquisitionCheckpoint }
    | { status: "deferred" | "stale" | "corrupt" }> {
  // Part rehydration is not itself resumable. Admit the complete bounded read
  // before allocating, instead of rereading a doomed prefix every invocation.
  if (!available(budget, 3 * Math.ceil(head.manifest.length / COMMUNITY_ANALYSIS_PARTS_PER_READ) + progressReserve)) return { status: "deferred" };
  const components: Record<V1QuotaWorkComponent, unknown[]> = { "plan-anchors": [], "plan-runs": [],
    "plan-equal-time": [], "fit-stats": [], eligible: [], "endpoint-runs": [], endpoints: [] };
  const interner = createV1QuotaWorkInterner();
  try {
    for (let offset = 0; offset < head.manifest.length;) {
      const page = await work.readCommunityAnalysisWorkParts(db, head, offset, budget);
      if (page.status !== "ready") return page;
      for (const part of page.parts) {
        try { interner.internPart(part.component, part.value); }
        catch { return { status: "corrupt" }; }
        if (!Array.isArray(part.value)) return { status: "corrupt" };
        for (const entry of part.value) components[part.component].push(entry);
      }
      offset = page.nextOffset;
    }
  } finally { interner.release(); }
  try {
    return { status: "ready", state: decodeV1QuotaWorkCheckpoint(communityAnalysisAcquisitionIdentity(head.identity), head.control, components) };
  } catch { return { status: "corrupt" }; }
}

type AcquiredPage = { status: "ready"; state: V1QuotaAcquisitionCheckpoint;
  target: CommunityAnalysisStageTarget; replay: V1QuotaPageReplay };
async function acquirePage(reader: V1QuotaPageReader, head: CommunityAnalysisWorkHead,
  state: V1QuotaAcquisitionCheckpoint, winners: ReadonlyMap<string, string>,
  budget: CommunityAnalysisWorkBudget): Promise<AcquiredPage | { status: "deferred" }
    | Extract<CommunityAnalysisRunResult, { status: "not_testable" }>> {
  // At least one statement remains for a durable staged target if the small
  // atomic delta will not fit. This is a view of the SAME allocation, not a
  // fresh allowance. The reader always performs exactly one physical page.
  if (!available(budget, 2)) return { status: "deferred" };
  const readerBudget: V1QuotaInvocationBudget = {
    get remainingQueries() { return Math.max(0, budget.remainingQueries - (budget.reserveQueries ?? 0) - 1); },
    set remainingQueries(value) {
      const previous = this.remainingQueries;
      if (!Number.isSafeInteger(value) || value < 0 || value > previous) throw new TypeError("community analysis reader budget invalid");
      budget.remainingQueries -= previous - value;
    },
    get deadlineMs() { return budget.deadlineMs; },
    now: budget.now,
  };
  const step = await advanceV1QuotaAcquisitionPage(reader, communityAnalysisAcquisitionIdentity(head.identity), winners, readerBudget, state);
  if (step.result.status === "not_testable") return step.result;
  if (!step.checkpoint || !step.replay) return { status: "deferred" };
  const encoded = encodeV1QuotaWorkCheckpoint(step.checkpoint);
  // The temporary completion attribution index remains confined to this frame;
  // it must not overlap the separate usage/scalar/composition finisher.
  return { status: "ready", state: step.checkpoint, replay: step.replay,
    target: { phase: step.replay.through.phase, control: encoded.control, components: encoded.components } };
}

async function disposeObsolete(work: CommunityAnalysisWorkStore, db: D1Database, identity: CommunityAnalysisWorkIdentity,
  budget: CommunityAnalysisWorkBudget): Promise<{ status: "discarded" | "deferred" | "stale" | "corrupt" }> {
  let inspected = await work.readCommunityAnalysisWorkForDiscard(db, identity.participantId, identity.inputRevision, budget);
  let supersession = false;
  if (inspected.status === "stale") {
    inspected = await work.readCommunityAnalysisWorkForSupersession(db, identity, budget);
    supersession = true;
  }
  if (inspected.status !== "ready") return { status: inspected.status === "absent" ? "stale" : inspected.status };
  let stage = inspected.stage;
  const sameDisposal = stage?.mode === "discarding" && stage.discardInputRevision === identity.inputRevision
    && (!supersession || canonicalJson(stage.replay) === canonicalJson({
      version: "community-analysis-supersession-1", replacementIdentity: identity }));
  if (!sameDisposal) {
    const begun = supersession
      ? await work.beginCommunityAnalysisSupersession(db, inspected.head, identity, budget, stage ?? undefined)
      : await work.beginCommunityAnalysisDiscard(db, inspected.head, identity.inputRevision, budget, stage ?? undefined);
    if (begun.status !== "ready") return { status: begun.status === "corrupt" ? "corrupt" : begun.status === "deferred" ? "deferred" : "stale" };
    stage = begun.stage;
  }
  if (!stage) return { status: "corrupt" };
  for (;;) {
    const collected = await work.collectCommunityAnalysisWorkGarbage(db, inspected.head, stage, budget);
    if (collected.status !== "ready") return collected;
    if (collected.done) return { status: "discarded" };
    stage = collected.stage;
  }
}

/** Local coordinator only: no scheduling, backfill, cache publication or policy
 * activation. Every durable page is source/CAS-fenced by the store. Hard query
 * failure/deadline termination retains the last durable checkpoint; an in-flight
 * uncommitted page is replayed, never interpreted as a partial result. */
export async function advanceCommunityAnalysisRun(db: D1Database, options: {
  identity: CommunityAnalysisWorkIdentity; sourcePin: V1SourcePin; budget: CommunityAnalysisWorkBudget;
  storage?: "current" | "model-history";
  /** Required follow-on allowance after rehydrating a completed head. This is
   * admission-only: incomplete acquisition still uses all its phase allocation,
   * and no queries are charged here for work the caller has not executed. */
  completedEvidenceReserveQueries?: number;
}): Promise<CommunityAnalysisRunResult> {
  const { identity, sourcePin, budget } = options;
  if (options.storage !== undefined && options.storage !== "current" && options.storage !== "model-history") {
    throw new TypeError("community analysis storage invalid");
  }
  const work = options.storage === "model-history" ? historyWorkStore : communityAnalysisWorkStore;
  const throughDay = "participantId" in sourcePin.scope ? sourcePin.scope.throughDay : undefined;
  const history = options.storage === "model-history" && throughDay ? modelHistoryWindow(throughDay) : undefined;
  if (options.storage === "model-history" ? !history || identity.fixedNow !== history.fixedNow
    || identity.observedAtCutoff !== history.observedAtCutoff
    || identity.sourceMethodVersion !== MODEL_HISTORY_METHOD_VERSION
    || !("participantId" in sourcePin.scope) || sourcePin.scope.fromDay !== history.fromDay
    : throughDay !== undefined) throw new TypeError("community analysis historical scope mismatch");
  const completedReserve = options.completedEvidenceReserveQueries === undefined ? 0 : options.completedEvidenceReserveQueries;
  if (!Number.isSafeInteger(completedReserve) || completedReserve < 0) throw new TypeError("community analysis completed reserve invalid");
  const acquisitionIdentity = communityAnalysisAcquisitionIdentity(identity);
  if (!("participantId" in sourcePin.scope) || sourcePin.scope.participantId !== identity.participantId
    || sourcePin.inputRevision !== identity.inputRevision || sourcePin.fingerprint !== identity.inputFingerprint
    || sourcePin.winners.some(winner => winner.participant_id !== identity.participantId)
    || sourcePin.winnersJson !== JSON.stringify(sourcePin.winners.map(winner =>
      [winner.participant_id, winner.observed_day, winner.device_id]))) throw new TypeError("community analysis run source mismatch");
  const current = await sourceCurrent(db, sourcePin, budget);
  if (current !== "ready") return { status: current };
  let read = await work.readCommunityAnalysisWork(db, identity, budget);
  if (read.status === "stale") {
    const disposed = await disposeObsolete(work, db, identity, budget);
    if (disposed.status !== "discarded") return { status: disposed.status };
    read = { status: "absent" };
  }
  if (read.status === "absent") {
    read = await work.beginCommunityAnalysisWork(db, identity,
      encodeV1QuotaWorkCheckpoint(createV1QuotaAcquisitionCheckpoint(acquisitionIdentity)).control, budget);
  }
  if (read.status !== "ready") return { status: read.status === "absent" ? "stale" : read.status };
  let head = read.head;
  const staged = await work.readCommunityAnalysisStage(db, head, budget);
  if (staged.status !== "ready" && staged.status !== "absent") return { status: staged.status === "deferred" ? "deferred" : staged.status === "corrupt" ? "corrupt" : "stale" };
  let stage: CommunityAnalysisWorkStage | null = staged.status === "ready" ? staged.stage : null;
  let state: V1QuotaAcquisitionCheckpoint | null = null;
  let reader: V1QuotaPageReader | null = null;
  let pending: AcquiredPage | null = null;
  const winners = new Map(sourcePin.winners.map(winner => [winner.observed_day, winner.device_id]));
  for (;;) {
    if (stage?.mode === "garbage_collecting" || stage?.mode === "discarding") {
      const collected = await work.collectCommunityAnalysisWorkGarbage(db, head, stage, budget);
      if (collected.status !== "ready") return collected;
      if (!collected.done) { stage = collected.stage; continue; }
      if (collected.discarded) return { status: "stale" };
      stage = null;
    }
    if (stage?.mode === "verifying") {
      if (stage.verifiedOffset < stage.target.manifest.length) {
        const verified = await work.verifyCommunityAnalysisStagePage(db, head, stage, budget);
        if (verified.status !== "ready") return { status: verified.status === "deferred" ? "deferred" : verified.status === "corrupt" ? "corrupt" : "stale" };
        stage = verified.stage; continue;
      }
      const promoted = await work.promoteCommunityAnalysisStage(db, head, stage, budget);
      if (promoted.status !== "ready") return promoted;
      head = promoted.head; stage = promoted.stage; pending = null;
      continue;
    }
    if (!state) {
      const reserve = head.phase === "complete" ? 3 + completedReserve
        : stage?.mode === "writing" ? (reader ? 1 : 2) + Math.min(32, stage.writeManifest.length - stage.writeOffset) + 1
        : reader ? 2 : 3;
      const loaded = await loadCheckpoint(work, db, head, budget, reserve);
      if (loaded.status !== "ready") return loaded;
      state = loaded.state;
    }
    if (head.phase === "complete") {
      if (state.phase !== "endpoints" || state.runs.length > 0) return { status: "corrupt" };
      if (!available(budget, 3)) return { status: "deferred" };
      const finalSource = await sourceCurrent(db, sourcePin, budget);
      if (finalSource !== "ready") return { status: finalSource };
      const finalHead = await work.readCommunityAnalysisWork(db, identity, budget);
      if (finalHead.status !== "ready" || canonicalJson(finalHead.head) !== canonicalJson(head)) return { status: finalHead.status === "corrupt" ? "corrupt" : finalHead.status === "deferred" ? "deferred" : "stale" };
      const acquisition = { planAnchors: state.plan.anchors, quotaRows: state.endpoints.map(endpoint => endpoint.row) };
      if (!validateV1CompletedQuotaAcquisition(acquisition)) return { status: "corrupt" };
      return { status: "ready", evidence: { identity: acquisitionIdentity, acquisition }, head };
    }
    if (!pending) {
      if (!available(budget, reader ? 2 : 3)) return { status: "deferred" };
      if (!reader) {
        if (!spend(budget, 1)) return { status: "deferred" };
        try { reader = await createV1QuotaPageReader(db, identity.participantId, history?.observedAtBefore); }
        catch (error) { if (error instanceof V1QuotaFitProjectionUnavailableError) return { status: "projection_unavailable" }; throw error; }
      }
      const page = await acquirePage(reader, head, state, winners, budget);
      if (page.status === "not_testable") {
        if (!available(budget, 3)) return { status: "deferred" };
        const finalSource = await sourceCurrent(db, sourcePin, budget);
        if (finalSource !== "ready") return { status: finalSource };
        const finalHead = await work.readCommunityAnalysisWork(db, identity, budget);
        return finalHead.status === "ready" && canonicalJson(finalHead.head) === canonicalJson(head)
          ? page : { status: finalHead.status === "corrupt" ? "corrupt" : finalHead.status === "deferred" ? "deferred" : "stale" };
      }
      if (page.status !== "ready") return page;
      pending = page; state = page.state;
    }
    if (!stage) {
      const delta = await work.prepareCommunityAnalysisWorkDelta(head, pending.target.components);
      if (delta.status === "ready") {
        const committed = await work.commitCommunityAnalysisWorkPage(db, head,
          { control: pending.target.control, phase: pending.target.phase, parts: delta.parts }, budget);
        if (committed.status === "ready") { head = committed.head; pending = null; continue; }
        if (committed.status !== "deferred") return { status: committed.status === "corrupt" ? "corrupt" : "stale" };
      }
      const begun = await work.beginCommunityAnalysisStage(db, head, pending.target, pending.replay, budget);
      if (begun.status !== "ready") return { status: begun.status === "deferred" ? "deferred" : begun.status === "corrupt" || begun.status === "replay_unresolved" ? "corrupt" : "stale" };
      stage = begun.stage;
    }
    if (stage.mode === "writing") {
      const written = await work.writeCommunityAnalysisStagePage(db, head, stage, pending.target, pending.replay, budget);
      if (written.status !== "ready") return { status: written.status === "deferred" ? "deferred" : written.status === "corrupt" || written.status === "replay_unresolved" ? "corrupt" : "stale" };
      stage = written.stage;
    }
  }
}
