import { canonicalJson } from './canonical-json';
import { validCompleteCachedComposition } from './community-allowance';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { MODEL_BLOCK_METHOD, planHistoricalModelBlockRanges,
  type ModelBlockIdentity } from './analytics-model-block-contract';
import { advanceAnalyticsModelBlock, assertModelBlockSourceCurrent, assertModelBlockTargetCurrent,
  captureModelBlockAuthorityDigest, ModelBlockSourceChanged, modelBlockSourcePinForDay,
  readVerifiedAnalyticsModelBlock } from './analytics-model-block';
import { modelBlockStoreSupported, prepareModelBlockAdmission, readRebasableModelBlockCheckpoint,
  retireModelBlockJobs } from './storage-analytics-model-block';
import { captureStorageGraphScope, readStorageGraphResult, reuseStorageGraphResult, saveStorageGraphResult,
  STORAGE_GRAPH_METHOD, type StorageGraphScope } from './storage-community-graph';
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';

/** These paths use the same effective reader and model kernel. Changes to any
 * member require native/adopted numerical and publication parity qualification. */
export const MODEL_BLOCK_GRAPH_COMPATIBILITY = Object.freeze({
  block: MODEL_BLOCK_METHOD, graph: STORAGE_GRAPH_METHOD,
  attribution: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
});

export interface StorageModelBlockGraphProgress {
  state: 'complete' | 'deferred' | 'unsupported';
  reused?: boolean;
  reason?: string;
  adoptedDates: number;
  queriesUsed: number;
}
class AdoptionYield extends Error { constructor(readonly reason: string) { super(reason); } }

/** Opt-in scheduler adapter. A complete block is private until its whole input
 * vector is proved current. Native owner/day rows remain the adoption cursor;
 * the existing cohort publisher decides when a date is publicly complete. */
export async function advanceStorageModelBlockGraphWork(input: {
  source: D1Database; target: D1Database; sourceId: string; sourceNamespace: string;
  scope: StorageGraphScope; nowMs: number; maxQueries: number; deadlineMs?: number; now?: () => number;
  sharedFeatures?: boolean;
}): Promise<StorageModelBlockGraphProgress> {
  const now = input.now ?? Date.now, deadline = input.deadlineMs ?? now() + 20_000;
  if (input.source === input.target || !Number.isSafeInteger(input.nowMs)
    || !Number.isSafeInteger(input.maxQueries) || input.maxQueries < 1 || input.maxQueries > 950
    || !Number.isFinite(deadline) || !Number.isFinite(now())) throw new TypeError('MODEL_BLOCK_ADOPTION_INVALID');
  const meter = createD1InvocationBudget(input.maxQueries);
  const source = meter.wrap(input.source), target = meter.wrap(input.target);
  const bindings = { source, target, sourceId: input.sourceId, sourceNamespace: input.sourceNamespace };
  let adoptedDates = 0, selectedComplete = false, selectedReused = false;
  const result = (state: StorageModelBlockGraphProgress['state'], reason?: string): StorageModelBlockGraphProgress => ({
    state, ...(reason ? { reason } : {}), ...(state === 'complete' ? { reused: selectedReused } : {}),
    adoptedDates, queriesUsed: meter.queriesUsed,
  });
  const check = (queries: number) => {
    if (now() >= deadline - 1_500) throw new AdoptionYield('deadline');
    if (meter.remainingQueries < queries) throw new AdoptionYield('query_budget');
  };
  const todayDay = new Date(input.nowMs).toISOString().slice(0, 10);
  const range = planHistoricalModelBlockRanges(todayDay).find(value =>
    value.outputFromDay <= input.scope.day && input.scope.day <= value.outputThroughDay);
  if (!range || input.scope.source !== 'effective' || input.scope.metric !== 'model'
    || input.scope.authority.sourceId !== input.sourceId
    || input.scope.authority.sourceNamespace !== input.sourceNamespace) return result('unsupported', 'native_date');
  const owner = { ...input.scope.owner };
  try {
    check(25);
    const selectedScope = { ...input.scope, ownerAuthorityEpoch: owner.authorityEpoch };
    // A complete native row is already independently checked against its exact
    // window, source authority and payload hash. Reuse it before preparing any
    // private block policy, just as the ordinary graph path does. Reuse also
    // refreshes stale input proof and retires a completed prepared checkpoint.
    // A cache hit opens no job or claim; obsolete private jobs remain bounded
    // and are retired before new work or by the capacity sweep. The effective
    // source reader checks exact owner revision/epoch and links; the target
    // proof below covers those independently without adding epoch-only checks.
    const cached = await reuseStorageGraphResult(bindings, input.scope, {
      remainingQueries: () => meter.remainingQueries, deadlineMs: deadline, now,
      assertCurrent: () => assertModelBlockTargetCurrent(target, { sourceId: input.sourceId,
        sourceNamespace: input.sourceNamespace, ownerDigest: owner.ownerDigest,
        ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch }),
    });
    if (cached) {
      selectedReused = true;
      return result('complete');
    }
    if (!await modelBlockStoreSupported(target)) return result('unsupported', 'migration_required');
    const identity: ModelBlockIdentity = { version: 1, method: MODEL_BLOCK_METHOD,
      sourceId: input.sourceId, sourceNamespace: input.sourceNamespace,
      ownerDigest: owner.ownerDigest, ownerRevision: owner.ownerRevision,
      authorityEpoch: owner.authorityEpoch, inputRevision: owner.inputRevision,
      authorityDigest: await captureModelBlockAuthorityDigest(source, input), ...range };
    const fence = async () => {
      await assertModelBlockSourceCurrent(source, owner, identity);
      await assertModelBlockTargetCurrent(target, identity);
    };
    await fence();
    // Retirement is allowed even when there is too little allowance to start
    // analytical work. A current eligible partial job is never age-retired.
    check(45);
    const admission = await prepareModelBlockAdmission({ target, identity, todayDay,
      now: input.nowMs, assertSourceCurrent: () => assertModelBlockSourceCurrent(source, owner, identity) });
    if (!admission) return result('deferred', 'admission_changed');
    check(30);
    const resumeCandidate = await readRebasableModelBlockCheckpoint({ target, identity, now: now() });
    if (!resumeCandidate) await retireModelBlockJobs({ target, sourceId: input.sourceId,
      ownerDigest: owner.ownerDigest, now: now(), todayDay, currentIdentity: identity, admission });
    check(600);
    const advanced = await advanceAnalyticsModelBlock({ ...bindings, owner, ...range,
      maxQueries: meter.remainingQueries, deadlineMs: deadline, now,
      sharedFeatures: input.sharedFeatures,
      ...(resumeCandidate ? { resumeCandidate, retireBeforeEnsure: true } : {}),
      historicalAdmission: { todayDay, token: admission } });
    if (advanced.status === 'unsupported') return result('unsupported', advanced.reason);
    if (advanced.status !== 'complete') return result('deferred', advanced.reason ?? 'model_block');
    if (!advanced.identity || canonicalJson(advanced.identity) !== canonicalJson(identity))
      return result('deferred', 'source_changed');
    check(80);
    const block = await readVerifiedAnalyticsModelBlock({ source, target, identity, owner, check, admission });
    if (!block) return result('deferred', 'model_block_incomplete');

    // Serve the selected date first, then spend available capacity adopting
    // other dates. A retry discovers complete native rows without a new cursor.
    const outputs = [...block.outputs].sort((a, b) =>
      a.day === selectedScope.day ? -1 : b.day === selectedScope.day ? 1 : a.day.localeCompare(b.day));
    for (const output of outputs) {
      check(60);
      const scope = { ...await captureStorageGraphScope(source, {
        owner, day: output.day, metric: 'model', sourceId: input.sourceId,
        sourceNamespace: input.sourceNamespace, preparedFold: true,
      }), ownerAuthorityEpoch: identity.authorityEpoch };
      if (scope.source !== 'effective') throw new ModelBlockSourceChanged();
      const blockPin = await modelBlockSourcePinForDay(identity, owner, block.dependencies, output.day);
      // Native fallback outputs already carry the native window fingerprint;
      // prepared outputs must carry the exact block window fingerprint.
      if (output.fingerprint !== blockPin.fingerprint && output.fingerprint !== scope.pin.fingerprint
        || !validCompleteCachedComposition(output.value, output.fingerprint,
          MODEL_BLOCK_GRAPH_COMPATIBILITY.attribution)) throw new Error('MODEL_BLOCK_ADOPTION_PROOF_INVALID');
      const existing = await readStorageGraphResult(bindings, scope);
      if (existing) {
        await fence();
        if (output.day === selectedScope.day) { selectedComplete = true; selectedReused = true; }
        continue;
      }
      // Only the envelope identity changes. Counts, coefficients, refusals,
      // coverage and membership pass through byte-for-byte.
      const value = output.value.status === 'ready'
        ? { ...output.value, inputFingerprint: scope.pin.fingerprint } : output.value;
      if (!validCompleteCachedComposition(value, scope.pin.fingerprint,
        MODEL_BLOCK_GRAPH_COMPATIBILITY.attribution)) throw new Error('MODEL_BLOCK_ADOPTION_PROOF_INVALID');
      check(35);
      const saved = await saveStorageGraphResult(bindings, scope, {
        payload: canonicalJson(value), payloadFingerprint: scope.pin.fingerprint, assertCurrent: fence,
      });
      if (saved.state !== 'complete') return result('deferred', saved.reason);
      adoptedDates++;
      if (output.day === selectedScope.day) selectedComplete = true;
    }
    return result(selectedComplete ? 'complete' : 'deferred', selectedComplete ? undefined : 'model_block_incomplete');
  } catch (error) {
    if (error instanceof ModelBlockSourceChanged) return result('deferred', 'source_changed');
    if (error instanceof AdoptionYield || error instanceof D1InvocationBudgetExceededError) {
      return selectedComplete ? result('complete')
        : result('deferred', error instanceof AdoptionYield ? error.reason : 'query_budget');
    }
    throw error;
  }
}
