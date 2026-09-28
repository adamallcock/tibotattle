/** Model-date jobs for the opt-in local scheduler experiment. Durable
 * progress contains reduced inputs only; production routing remains off. */
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { COMPOSITION_CACHE_KEY_SUFFIX } from './community-allowance';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { MODEL_BLOCK_METHOD, createModelBlockSelection, evaluatePreparedModelDate,
  modelBlockInputDays, modelBlockOutputDays, validModelBlockCheckpoint, validModelBlockIdentity,
  type ModelBlockCheckpoint, type ModelBlockDependency, type ModelBlockIdentity,
  type ModelBlockOutput, type ModelBlockPending } from './analytics-model-block-contract';
import { claimModelBlockJob, ensureModelBlockJob, modelBlockStoreSupported,
  readModelBlockJob, releaseModelBlockJob, retireModelBlockJobs, saveModelBlockJob,
  type ModelBlockAdmission } from './storage-analytics-model-block';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, mapEffectiveQuotaPageRow,
  validEffectiveQuotaDay, type EffectiveQuotaDay } from './effective-quota-day';
import { appendEffectiveUsageDay, mapEffectiveUsagePageRow, validEffectiveUsageDay,
  type EffectiveUsageDay } from './effective-usage-day';
import { GRAPH_DAY_EFFECTIVE_DEVICE_ID, GRAPH_DAY_EFFECTIVE_MANIFEST_ID,
  GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX, graphDayEffectiveQuotaSupported,
  graphDayEffectiveUsageSupported, graphDayProjectionValueKey,
  readGraphDayEffectiveQuotaHeads, readGraphDayEffectiveUsageHeads,
  readGraphDayProjection, reduceGraphDayProjection,
  writeGraphDayProjection, type GraphDayProjectionKey,
  type GraphDayProjectionWriteCursor, type GraphDayEffectiveQuotaHead } from './graph-day-projection';
import { modelHistoryWindow } from './model-history-window';
import { assertEffectiveHistoryOwner, createEffectiveHistoryDayDependencyReader } from './storage-effective-history';
import { advanceSharedAnalyticsFeatureDay } from './storage-analytics-shared-features';
import { captureStorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';
import { captureStorageGraphScope, computeStorageGraphResult } from './storage-community-graph';
import { readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays,
  type EffectiveTelemetryStream } from './telemetry-usage-effective-reader';
import type { V11SourcePin } from './telemetry-v11-domain';

type Owner = StorageCommunityOwner & { ownerDigest: string };
const SAVE_RESERVE = 128;
const WINDOW_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
export class ModelBlockSourceChanged extends Error { constructor() { super('MODEL_BLOCK_SOURCE_CHANGED'); } }
class YieldJob extends Error { constructor(readonly reason: string) { super(reason); } }

export interface AnalyticsModelBlockInput {
  source: D1Database;
  target: D1Database;
  sourceId: string;
  sourceNamespace: string;
  owner: Owner;
  outputFromDay: string;
  outputThroughDay: string;
  /** Counts actual source and target statements, including failed attempts. */
  maxQueries?: number;
  deadlineMs?: number;
  now?: () => number;
  /** Local interruption/benchmark seam. A page or completed output is a step. */
  maxSteps?: number;
  pageSize?: number;
  /** Whole historical block admission used by the opt-in scheduler. */
  historicalAdmission?: { todayDay: string; token: ModelBlockAdmission };
  sharedFeatures?: boolean;
  /** Committed older-revision checkpoint; every selected input is re-proved before use. */
  resumeCandidate?: ModelBlockCheckpoint;
  /** Retire stale jobs only after a captured candidate has been source-proved. */
  retireBeforeEnsure?: boolean;
  signal?: AbortSignal;
}

export interface AnalyticsModelBlockResult {
  status: 'complete' | 'deferred' | 'stale' | 'unsupported';
  reason?: string;
  queriesUsed: number;
  preparedDays: number;
  reusedDays: number;
  emptyDays: number;
  sourcePages: number;
  modelDatesCompleted: number;
  identity: ModelBlockIdentity | null;
  outputs?: readonly ModelBlockOutput[];
}

export async function captureModelBlockAuthorityDigest(source: D1Database, identity: Pick<ModelBlockIdentity,
  'sourceId' | 'sourceNamespace'>): Promise<string> {
  const authority = await captureStorageCommunityAuthority(source, identity);
  const tables = (await source.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name IN ('telemetry_usage_correction_runtime','telemetry_v12_runtime') ORDER BY name`)
    .all<{ name: string }>()).results.map(row => row.name);
  if (!tables.includes('telemetry_usage_correction_runtime')) throw new ModelBlockSourceChanged();
  const correction = await source.prepare(`SELECT schema_version,method_version,state
    FROM telemetry_usage_correction_runtime WHERE id=1`)
    .first<{ schema_version: string; method_version: string; state: string }>();
  const v12 = tables.includes('telemetry_v12_runtime') ? await source.prepare(`SELECT schema_version,
    envelope_schema_version,field_dictionary_version,privacy_contract_version,state,policy_revision
    FROM telemetry_v12_runtime WHERE id=1`).first<Record<string, string | number>>() : null;
  if (!correction || !['staged', 'active'].includes(correction.state)
    || tables.includes('telemetry_v12_runtime') && (!v12 || !['staged', 'active'].includes(String(v12.state))))
    throw new ModelBlockSourceChanged();
  // This private calculation depends on its own exact owner revision. Global
  // upload counters would restart every long job whenever any other owner
  // uploads. Runtime activation changes reader semantics independently of an
  // owner's revision. Public cohort publication keeps its global fences.
  return sha256Hex(canonicalJson({ sourceId: authority.sourceId, sourceNamespace: authority.sourceNamespace,
    policyRevision: authority.policyRevision, collectionRevision: authority.collectionRevision, correction, v12 }));
}

export async function assertModelBlockSourceCurrent(source: D1Database, owner: Owner,
  identity: ModelBlockIdentity): Promise<void> {
  if (owner.ownerDigest !== identity.ownerDigest || owner.ownerRevision !== identity.ownerRevision
    || owner.authorityEpoch !== identity.authorityEpoch || owner.inputRevision !== identity.inputRevision)
    throw new ModelBlockSourceChanged();
  try {
    await assertEffectiveHistoryOwner(source, owner);
    if (await captureModelBlockAuthorityDigest(source, identity) !== identity.authorityDigest) throw new ModelBlockSourceChanged();
  } catch (error) {
    // Provider failures remain failures; only explicit authority refusals mean
    // the old source pin is no longer usable.
    if (error instanceof Error && ['STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE',
      'STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE'].includes(error.message)) throw new ModelBlockSourceChanged();
    throw error;
  }
}

export async function assertModelBlockTargetCurrent(target: D1Database, identity: Pick<ModelBlockIdentity,
  'sourceId' | 'sourceNamespace' | 'ownerDigest' | 'ownerRevision' | 'authorityEpoch'>): Promise<void> {
  const ready = await target.prepare(`SELECT 1 AS ready FROM analytics_owner_state o
    JOIN analytics_runtime_sources r ON r.source_id=o.source_id AND r.source_namespace=? AND r.contract_version=1
    WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.authority_epoch=? AND o.revision=?
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
        WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest)`)
    .bind(identity.sourceNamespace, identity.sourceId, identity.ownerDigest, identity.authorityEpoch, identity.ownerRevision)
    .first<number>('ready');
  if (ready !== 1) throw new ModelBlockSourceChanged();
}

function keys(identity: ModelBlockIdentity, dependency: ModelBlockDependency,
  usageMethod: string): { quota: GraphDayProjectionKey; usage: GraphDayProjectionKey } {
  const common = { sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace,
    ownerDigest: identity.ownerDigest, deviceId: GRAPH_DAY_EFFECTIVE_DEVICE_ID,
    manifestDigest: dependency.digest, day: dependency.day };
  return { quota: { ...common, sourceLayout: 'effective', manifestId: GRAPH_DAY_EFFECTIVE_MANIFEST_ID },
    usage: { ...common, sourceLayout: 'effective-usage',
      manifestId: GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX + usageMethod } };
}

interface PreparedDay { quota: EffectiveQuotaDay; usage: EffectiveUsageDay }
type PreparedHeads = ReadonlyMap<string, GraphDayEffectiveQuotaHead> | null;

/** Exact manifests are fetched once per invocation. Old variants remain
 * harmless because lookup uses the full immutable key, never day alone. A
 * bounded inventory overflow is an optional-cache refusal, not empty data. */
async function loadPreparedHeads(target: D1Database, identity: ModelBlockIdentity,
  usageMethod: string, check: (queries: number) => void): Promise<PreparedHeads> {
  const days = modelBlockInputDays(identity);
  const scope = { target, sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace,
    ownerDigest: identity.ownerDigest, fromDay: days[0]!, throughDay: days.at(-1)! };
  check(2);
  const quota = await readGraphDayEffectiveQuotaHeads(scope);
  check(1);
  const usage = await readGraphDayEffectiveUsageHeads({ ...scope,
    manifestId: GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX + usageMethod });
  if (!quota || !usage) return null;
  return new Map([...quota, ...usage].map(head => [head.cursor.valueKey, head]));
}

async function selectedPreparedHeads(identity: ModelBlockIdentity, dependency: ModelBlockDependency,
  usageMethod: string, heads: PreparedHeads): Promise<Partial<Record<'quota' | 'usage', GraphDayEffectiveQuotaHead>> | null> {
  if (!heads) return null;
  const expected = keys(identity, dependency, usageMethod);
  const selected: Partial<Record<'quota' | 'usage', GraphDayEffectiveQuotaHead>> = {};
  for (const stream of ['quota', 'usage'] as const) {
    if (!(stream === 'quota' ? dependency.hasQuota : dependency.hasUsage)) continue;
    const head = heads.get(await graphDayProjectionValueKey(expected[stream]));
    if (!head) return null;
    if (canonicalJson(head.key) !== canonicalJson(expected[stream]))
      throw new Error('MODEL_BLOCK_INVALID_PREPARED_DAY');
    selected[stream] = head;
  }
  return selected;
}

async function loadPreparedDay(target: D1Database, identity: ModelBlockIdentity,
  dependency: ModelBlockDependency, usageMethod: string,
  heads: PreparedHeads, check: (queries: number) => void): Promise<PreparedDay | 'limit' | null> {
  const dayKeys = keys(identity, dependency, usageMethod);
  if (heads === null && (dependency.hasQuota || dependency.hasUsage)) return 'limit';
  const selected = await selectedPreparedHeads(identity, dependency, usageMethod, heads);
  if (!selected && (dependency.hasQuota || dependency.hasUsage)) return null;
  if (Object.values(selected ?? {}).some(head => head.cursor.partCount > 32)
    || Object.values(selected ?? {}).reduce((total, head) => total + head.payloadBytes, 0) > WINDOW_BYTES)
    return 'limit';
  const loaded: Partial<PreparedDay> = {};
  for (const stream of ['quota', 'usage'] as const) {
    // The saved, source-fenced inventory proves emptiness. Missing cache data
    // is never substituted for zero; only this explicit dependency fact is.
    if (!(stream === 'quota' ? dependency.hasQuota : dependency.hasUsage)) {
      const projection = reduceGraphDayProjection(dependency.day, []);
      if (stream === 'quota') loaded.quota = { projection, quotaRowsRead: 0 };
      else loaded.usage = { projection };
      continue;
    }
    {
      check(1);
      const cursor = selected![stream]!.cursor;
      // The ordinary reader mutates its cursor. Each payload read gets fresh
      // reduction state, even when acquisition and emission share metadata.
      const value = await readGraphDayProjection({ target, key: dayKeys[stream], maxParts: 32,
        cursor: { ...cursor, loaded: 0, components: {} } });
      if (value.status === 'absent') return null;
      // One feature gets at most one 32-part payload read. Larger optional
      // cache entries use the existing paged analysis instead of restarting
      // this uncheckpointed rolling window on every invocation.
      if (value.status === 'deferred') return 'limit';
      if (stream === 'quota') {
        if (!value.effectiveQuota || value.effectiveQuota.ownerRevision > identity.ownerRevision)
          throw new Error('MODEL_BLOCK_INVALID_PREPARED_DAY');
        const quota = { projection: value.projection, quotaRowsRead: value.effectiveQuota.quotaRowsRead };
        if (!validEffectiveQuotaDay(quota)) throw new Error('MODEL_BLOCK_INVALID_PREPARED_DAY');
        loaded.quota = quota;
      } else {
        if (!value.effectiveUsage || value.effectiveUsage.ownerRevision > identity.ownerRevision)
          throw new Error('MODEL_BLOCK_INVALID_PREPARED_DAY');
        const usage = { projection: value.projection };
        if (!validEffectiveUsageDay(usage)) throw new Error('MODEL_BLOCK_INVALID_PREPARED_DAY');
        loaded.usage = usage;
      }
    }
  }
  return loaded as PreparedDay;
}

async function storePreparedDay(target: D1Database, identity: ModelBlockIdentity,
  dependency: ModelBlockDependency, usageMethod: string, day: PreparedDay,
  check: (queries: number) => void): Promise<void> {
  const dayKeys = keys(identity, dependency, usageMethod);
  for (const stream of ['quota', 'usage'] as const) {
    if (!(stream === 'quota' ? dependency.hasQuota : dependency.hasUsage)) continue;
    let cursor: GraphDayProjectionWriteCursor | undefined;
    for (;;) {
      check(40);
      const result = await writeGraphDayProjection({ target, key: dayKeys[stream],
        projection: day[stream].projection, maxWrites: 32, ...(cursor ? { cursor } : {}),
        ...(stream === 'quota'
          ? { effectiveQuota: { quotaRowsRead: day.quota.quotaRowsRead, ownerRevision: identity.ownerRevision } }
          : { effectiveUsage: { ownerRevision: identity.ownerRevision } }) });
      if (result.status === 'stored') break;
      cursor = result.cursor;
    }
  }
}

export async function appendModelBlockDependencies(source: D1Database, identity: ModelBlockIdentity,
  owner: Owner, prefix: readonly ModelBlockDependency[], check: (queries: number) => void,
  selected: (dependency: ModelBlockDependency) => void, stopAfter?: number): Promise<void> {
  const allDays = modelBlockInputDays(identity);
  if (stopAfter !== undefined && (!Number.isSafeInteger(stopAfter) || stopAfter < prefix.length
    || stopAfter > allDays.length)) throw new TypeError('MODEL_BLOCK_INVALID_DEPENDENCIES');
  const days = stopAfter === undefined ? allDays : allDays.slice(0, stopAfter);
  for (let offset = prefix.length; offset < days.length; offset += 101) {
    const block = days.slice(offset, offset + 101);
    check(40);
    const reader = await createEffectiveHistoryDayDependencyReader(source, owner,
      identity.sourceNamespace, block, { includeSessions: true, occurrenceLinks: 'batched',
        canContinue: () => { check(2); return true; } });
    if (!reader) throw new YieldJob('dependency_budget');
    const inventory = new Map<EffectiveTelemetryStream, ReadonlySet<string>>();
    for (const stream of ['quota', 'usage'] as const) {
      check(20);
      inventory.set(stream, new Set(await readEffectiveTelemetryOwnerDays(source, {
        sourceNamespace: identity.sourceNamespace, ownerDigest: owner.ownerDigest,
        ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
        stream, fromDay: block[0]!, throughDay: block.at(-1)!,
      })));
    }
    for (const day of block) {
      check(2);
      const digest = await reader.readDigest(day);
      if (digest === undefined) throw new YieldJob('dependency_budget');
      selected({ day, digest, hasQuota: inventory.get('quota')!.has(day),
        hasUsage: inventory.get('usage')!.has(day) });
    }
  }
}

function emptyPending(day: string): ModelBlockPending {
  return { day, stream: 'quota', after: null, quota: { day, quotaRowsRead: 0, rows: [] },
    usage: { projection: reduceGraphDayProjection(day, []), lastObservedAtMs: null } };
}

export async function modelBlockSourcePinForDay(identity: ModelBlockIdentity, owner: Owner,
  dependencies: readonly ModelBlockDependency[], day: string): Promise<V11SourcePin> {
  const fromDay = modelHistoryWindow(day).fromDay;
  return { source: 'v1.1', participantId: owner.participantId,
    generationId: `effective:${owner.ownerDigest}`, fromDay, throughDay: day,
    inputRevision: identity.inputRevision, mutationEpoch: identity.authorityEpoch,
    fingerprint: await sha256Hex(canonicalJson([MODEL_BLOCK_METHOD, identity.ownerDigest,
      dependencies.filter(value => value.day >= fromDay && value.day <= day)
        .map(value => [value.day, value.digest])])) };
}

/** No retained JavaScript cache or caller cursor is needed between calls. A
 * crash can replay the last invocation; immutable day writes and the leased
 * checkpoint compare-and-swap make that replay idempotent. */
export async function advanceAnalyticsModelBlock(input: AnalyticsModelBlockInput): Promise<AnalyticsModelBlockResult> {
  const maxQueries = input.maxQueries ?? 950, maxSteps = input.maxSteps ?? 1_000;
  const pageSize = input.pageSize ?? 200, now = input.now ?? Date.now;
  const deadline = input.deadlineMs ?? now() + 20_000;
  if (input.source === input.target || !Number.isSafeInteger(maxQueries) || maxQueries < 600 || maxQueries > 950
    || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 || !Number.isFinite(deadline)
    || !Number.isFinite(now()) || !input.owner?.participantId) throw new TypeError('MODEL_BLOCK_INVALID_OPTIONS');
  const owner = { ...input.owner };
  const candidate: ModelBlockIdentity = { version: 1, method: MODEL_BLOCK_METHOD,
    sourceId: input.sourceId, sourceNamespace: input.sourceNamespace, ownerDigest: owner.ownerDigest,
    ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch, inputRevision: owner.inputRevision,
    authorityDigest: '0'.repeat(64), outputFromDay: input.outputFromDay, outputThroughDay: input.outputThroughDay };
  if (!validModelBlockIdentity(candidate) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.sourceId))
    throw new TypeError('MODEL_BLOCK_INVALID_OPTIONS');
  const meter = createD1InvocationBudget(maxQueries);
  const source = meter.wrap(input.source), target = meter.wrap(input.target);
  meter.reserveQueries = SAVE_RESERVE;
  const admission = input.historicalAdmission ? { historicalTodayDay: input.historicalAdmission.todayDay,
    admission: input.historicalAdmission.token } : {};
  let identity: ModelBlockIdentity | null = null;
  let claim: Awaited<ReturnType<typeof claimModelBlockJob>> = null;
  let checkpoint: ModelBlockCheckpoint | null = null;
  const metrics = { preparedDays: 0, reusedDays: 0, emptyDays: 0, sourcePages: 0, modelDatesCompleted: 0 };
  let steps = 0, reason = 'query_budget';
  let returned: AnalyticsModelBlockResult | undefined;
  const result = (status: AnalyticsModelBlockResult['status'], why?: string): AnalyticsModelBlockResult => (returned = {
    status, ...(why ? { reason: why } : {}), queriesUsed: meter.queriesUsed, ...metrics, identity,
    ...(status === 'complete' && checkpoint ? { outputs: checkpoint.outputs } : {}),
  });
  const check = (queries: number) => {
    if (input.signal?.aborted) throw new YieldJob('cancelled');
    if (now() >= deadline - 1_500) throw new YieldJob('deadline');
    if (meter.remainingQueries < queries) throw new YieldJob('query_budget');
  };
  const fence = async () => {
    await assertModelBlockSourceCurrent(source, owner, identity!);
    await assertModelBlockTargetCurrent(target, identity!);
  };
  const save = async () => {
    meter.reserveQueries = 0;
    await fence();
    if (!await saveModelBlockJob({ target, ...admission, identity: identity!, claim: claim!, checkpoint: checkpoint!, now: now() }))
      throw new YieldJob('lease_lost');
    claim = null;
    // Source changes between the final read and the target write cannot make
    // an old complete checkpoint visible to this caller.
    await fence();
  };
  try {
    check(20);
    // The canonical effective reader includes admitted v1/v1.1/v1.2 only
    // after its source runtime is enabled. Preserve native attribution for
    // owners still routed through the older graph paths.
    if (owner.hasEffective !== true) return result('unsupported', 'effective_source_required');
    if (!await modelBlockStoreSupported(target) || !await graphDayEffectiveQuotaSupported(target)
      || !await graphDayEffectiveUsageSupported(target)) return result('unsupported', 'migration_required');
    try {
      await assertEffectiveHistoryOwner(source, owner);
      identity = { ...candidate, authorityDigest: await captureModelBlockAuthorityDigest(source, candidate) };
    } catch (error) {
      if (error instanceof Error && ['STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE',
        'STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE'].includes(error.message)) throw new ModelBlockSourceChanged();
      throw error;
    }
    await assertModelBlockTargetCurrent(target, identity);
    let job = await readModelBlockJob({ target, identity, ...admission });
    if (job && input.retireBeforeEnsure && input.historicalAdmission) {
      check(20);
      await retireModelBlockJobs({ target, sourceId: identity.sourceId,
        ownerDigest: identity.ownerDigest, now: now(),
        todayDay: input.historicalAdmission.todayDay, currentIdentity: identity,
        admission: input.historicalAdmission.token });
    }
    if (!job) {
      await fence();
      let initial = createModelBlockSelection(identity);
      const candidate = input.resumeCandidate;
      if (candidate && candidate.dependencies.length > 0
        && validModelBlockCheckpoint(candidate, identity)) {
        let unchanged = true, checked = 0;
        await appendModelBlockDependencies(source, identity, owner, [], check, dependency => {
          if (canonicalJson(dependency) !== canonicalJson(candidate.dependencies[checked])) unchanged = false;
          checked++;
        }, candidate.dependencies.length);
        await fence();
        if (unchanged && checked === candidate.dependencies.length) initial = candidate;
      }
      if (input.retireBeforeEnsure && input.historicalAdmission) {
        await retireModelBlockJobs({ target, sourceId: identity.sourceId,
          ownerDigest: identity.ownerDigest, now: now(),
          todayDay: input.historicalAdmission.todayDay, currentIdentity: identity,
          admission: input.historicalAdmission.token });
      }
      check(12);
      if (!await ensureModelBlockJob({ target, identity,
        initial, now: now(),
        ...admission }))
        return result('deferred', 'job_unavailable');
      job = await readModelBlockJob({ target, identity, ...admission });
    }
    if (job?.checkpoint.phase === 'complete') {
      checkpoint = job.checkpoint;
      await fence();
      return result('complete');
    }
    check(10);
    claim = await claimModelBlockJob({ target, identity, ...admission, now: now() });
    if (!claim) return result('deferred', 'lease_busy');
    checkpoint = claim.checkpoint;
    const usageMethod = await sha256Hex(COMPOSITION_CACHE_KEY_SUFFIX);
    const outputDays = modelBlockOutputDays(identity);
    const window = new Map<string, PreparedDay>();
    let windowBytes = 0;
    let preparedHeads: PreparedHeads | undefined, headsChanged = false;
    const heads = async (): Promise<PreparedHeads> => {
      if (preparedHeads === undefined) preparedHeads = await loadPreparedHeads(target, identity!, usageMethod, check);
      return preparedHeads;
    };
    try {
      while (checkpoint.phase !== 'complete') {
        check(12);
        if (steps >= maxSteps) throw new YieldJob('step_limit');
        if (checkpoint.phase === 'select') {
          await appendModelBlockDependencies(source, identity, owner, checkpoint.dependencies,
            queries => { check(queries); if (steps >= maxSteps) throw new YieldJob('step_limit'); },
            dependency => {
              checkpoint = { ...checkpoint!, dependencies: [...checkpoint!.dependencies, dependency] };
              steps++;
            });
          checkpoint = { ...checkpoint, phase: 'acquire' };
          continue;
        }
        if (checkpoint.phase === 'acquire') {
          if (checkpoint.inputIndex === checkpoint.dependencies.length) {
            checkpoint = { ...checkpoint, phase: 'emit', pending: null };
            continue;
          }
          const dependency = checkpoint.dependencies[checkpoint.inputIndex]!;
          let pending: ModelBlockPending | null = checkpoint.pending;
          if (!pending) {
            const reused = await loadPreparedDay(target, identity, dependency, usageMethod, await heads(), check);
            if (reused === 'limit') { checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; continue; }
            if (reused) {
              checkpoint = { ...checkpoint, inputIndex: checkpoint.inputIndex + 1 };
              if (!dependency.hasQuota && !dependency.hasUsage) metrics.emptyDays++;
              else metrics.reusedDays++;
              steps++; continue;
            }
            if (input.sharedFeatures && (dependency.hasQuota || dependency.hasUsage)) {
              check(110);
              const feature = await advanceSharedAnalyticsFeatureDay({ source, target,
                sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace,
                owner, day: dependency.day,
                budget: { remainingQueries: () => meter.remainingQueries, deadlineMs: deadline, now } });
              if (feature.state === 'deferred') {
                if (feature.reason === 'source_changed') throw new ModelBlockSourceChanged();
                throw new YieldJob('shared_feature_pending');
              }
              if (feature.state === 'complete') {
                if (feature.dependencyDigest !== dependency.digest
                  || feature.value.day !== dependency.day
                  || feature.value.ownerDigest !== owner.ownerDigest) throw new ModelBlockSourceChanged();
                check(90);
                await fence();
                await storePreparedDay(target, identity, dependency, usageMethod,
                  { quota: feature.value.quota, usage: feature.value.modelUsage }, check);
                headsChanged = true;
                checkpoint = { ...checkpoint, inputIndex: checkpoint.inputIndex + 1 };
                if (feature.reused) metrics.reusedDays++;
                else metrics.preparedDays++;
                steps++; continue;
              }
              // A durable feature-specific size/schema refusal can use the
              // existing paged model path for this exact selected day.
            }
            pending = emptyPending(dependency.day);
            checkpoint = { ...checkpoint, pending };
          }
          if (pending.stream === 'store') {
            const quota = finishEffectiveQuotaDay(pending.quota);
            if (!quota) { checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; continue; }
            check(90);
            await fence();
            await storePreparedDay(target, identity, dependency, usageMethod,
              { quota, usage: { projection: pending.usage.projection } }, check);
            headsChanged = true;
            checkpoint = { ...checkpoint, inputIndex: checkpoint.inputIndex + 1, pending: null };
            metrics.preparedDays++; steps++; continue;
          }
          const stream: 'quota' | 'usage' = pending.stream;
          if (!(stream === 'quota' ? dependency.hasQuota : dependency.hasUsage)) {
            checkpoint = { ...checkpoint, pending: { ...pending,
              stream: stream === 'quota' ? 'usage' : 'store', after: null } };
            continue;
          }
          check(40);
          const page = await readEffectiveTelemetryOwnerDayPage(source, {
            sourceNamespace: identity.sourceNamespace, ownerDigest: owner.ownerDigest,
            ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
            day: dependency.day, stream, limit: pageSize,
            ...(pending.after ? { after: pending.after } : {}),
          });
          metrics.sourcePages++;
          if (page.next && pending.after && (page.next.observedAtMs < pending.after.observedAtMs
            || page.next.observedAtMs === pending.after.observedAtMs
              && page.next.occurrenceId <= pending.after.occurrenceId))
            throw new Error('MODEL_BLOCK_NONADVANCING_CURSOR');
          // Conflicting evidence belongs to the established analytical refusal
          // path. It must never become a fabricated empty prepared day.
          if (page.rows.some(row => row.status !== 'compatible')) {
            checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; continue;
          }
          if (stream === 'quota') {
            const quota = appendEffectiveQuotaDay(pending.quota, dependency.day,
              page.rows.map((row, index) => mapEffectiveQuotaPageRow(row, dependency.day,
                pending!.quota.quotaRowsRead + index + 1)), 10_080);
            checkpoint = quota ? { ...checkpoint, pending: { ...pending, quota, after: page.next,
              stream: page.next ? 'quota' : 'usage' } }
              : { ...checkpoint, phase: 'fallback', pending: null };
          } else {
            const usage = await appendEffectiveUsageDay(pending.usage, dependency.day,
              page.rows.map(mapEffectiveUsagePageRow), owner.ownerDigest);
            checkpoint = usage ? { ...checkpoint, pending: { ...pending, usage, after: page.next,
              stream: page.next ? 'usage' : 'store' } }
              : { ...checkpoint, phase: 'fallback', pending: null };
          }
          steps++; continue;
        }
        const day: string = outputDays[checkpoint.outputs.length]!;
        if (checkpoint.phase === 'fallback') {
          check(250);
          const scope = await captureStorageGraphScope(source, { owner, day, metric: 'model',
            sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace, preparedFold: false });
          if (scope.source !== 'effective') throw new ModelBlockSourceChanged();
          const computed = await computeStorageGraphResult({ source, target, sourceId: identity.sourceId,
            sourceNamespace: identity.sourceNamespace }, scope,
          { maxQueries: meter.remainingQueries, deadlineMs: deadline - 1_500, now,
            preparedFold: false, preparedEffectiveUsage: false, persistResult: false });
          if (computed.state === 'deferred') throw new YieldJob(computed.reason);
          if (!computed.result.composition) throw new Error('MODEL_BLOCK_MISSING_FALLBACK_RESULT');
          checkpoint = { ...checkpoint, outputs: [...checkpoint.outputs,
            { day, fingerprint: scope.pin.fingerprint, value: computed.result.composition }] };
        } else {
          if (headsChanged) { preparedHeads = undefined; headsChanged = false; }
          const selectedHeads = await heads();
          const fromDay = modelHistoryWindow(day).fromDay;
          for (const [oldDay, value] of window) if (oldDay < fromDay || oldDay > day) {
            windowBytes -= bytes(value); window.delete(oldDay);
          }
          const dependencies = checkpoint.dependencies.filter(value => value.day >= fromDay && value.day <= day);
          // Forecast the exact missing payload calls and their framed bytes
          // before loading a prefix. Metadata was acquired in two queries;
          // a populated 101-day window now needs at most 202 payload reads.
          let reloadQueries = 12, selectedBytes = 0;
          for (const dependency of dependencies) {
            if (!dependency.hasQuota && !dependency.hasUsage) continue;
            const selected = await selectedPreparedHeads(identity, dependency, usageMethod, selectedHeads);
            if (!selected || Object.values(selected).some(head => head.cursor.partCount > 32)) {
              checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; break;
            }
            for (const head of Object.values(selected)) {
              selectedBytes += head.payloadBytes;
              if (!window.has(dependency.day)) reloadQueries++;
            }
          }
          if (selectedBytes > WINDOW_BYTES) checkpoint = { ...checkpoint, phase: 'fallback', pending: null };
          if (checkpoint.phase === 'fallback') { window.clear(); windowBytes = 0; continue; }
          check(reloadQueries);
          for (const dependency of dependencies) if (!window.has(dependency.day)) {
            const prepared = await loadPreparedDay(target, identity, dependency, usageMethod, selectedHeads, check);
            if (!prepared || prepared === 'limit') {
              // Optional prepared inputs may have been retired between runs.
              // The ordinary paged model path remains authoritative.
              checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; break;
            }
            windowBytes += bytes(prepared);
            if (windowBytes > WINDOW_BYTES) {
              checkpoint = { ...checkpoint, phase: 'fallback', pending: null }; break;
            }
            window.set(dependency.day, prepared);
          }
          if (checkpoint.phase === 'fallback') { window.clear(); windowBytes = 0; continue; }
          check(8);
          const pin = await modelBlockSourcePinForDay(identity, owner, checkpoint.dependencies, day);
          const computed = await evaluatePreparedModelDate({ pin, day,
            quotaDays: dependencies.map(value => window.get(value.day)!.quota),
            usageDays: dependencies.map(value => window.get(value.day)!.usage) });
          if (computed.status === 'fallback') {
            checkpoint = { ...checkpoint, phase: 'fallback', pending: null };
            window.clear(); windowBytes = 0; continue;
          }
          checkpoint = { ...checkpoint, outputs: [...checkpoint.outputs,
            { day, fingerprint: pin.fingerprint, value: computed.value }] };
        }
        metrics.modelDatesCompleted++; steps++;
        if (checkpoint.outputs.length === outputDays.length) checkpoint = { ...checkpoint,
          phase: 'complete', inputIndex: checkpoint.dependencies.length, pending: null };
      }
    } catch (error) {
      if (error instanceof YieldJob) reason = error.reason;
      else if (error instanceof D1InvocationBudgetExceededError) reason = 'query_budget';
      else throw error;
    }
    await save();
    return result(checkpoint.phase === 'complete' ? 'complete' : 'deferred',
      checkpoint.phase === 'complete' ? undefined : reason);
  } catch (error) {
    if (error instanceof ModelBlockSourceChanged) return result('stale', 'source_changed');
    if (error instanceof YieldJob) return result('deferred', error.reason);
    if (error instanceof D1InvocationBudgetExceededError) return result('deferred', 'query_budget');
    throw error;
  } finally {
    if (claim && identity) {
      meter.reserveQueries = 0;
      await releaseModelBlockJob({ target, identity, claim, ...admission, now: now() });
    }
    if (returned) returned.queriesUsed = meter.queriesUsed;
  }
}

/** A complete private block is readable only under its exact current source
 * and target authority. Partial jobs never expose an output prefix. */
export async function readAnalyticsModelBlock(input: {
  source: D1Database; target: D1Database; identity: ModelBlockIdentity; owner: Owner;
}): Promise<readonly ModelBlockOutput[] | null> {
  if (input.source === input.target || !validModelBlockIdentity(input.identity))
    throw new TypeError('MODEL_BLOCK_INVALID_IDENTITY');
  const meter = createD1InvocationBudget(950), source = meter.wrap(input.source), target = meter.wrap(input.target);
  try {
    if (!await modelBlockStoreSupported(target)) return null;
    await assertModelBlockSourceCurrent(source, input.owner, input.identity);
    await assertModelBlockTargetCurrent(target, input.identity);
    const job = await readModelBlockJob({ target, identity: input.identity });
    if (job?.checkpoint.phase !== 'complete') return null;
    await assertModelBlockSourceCurrent(source, input.owner, input.identity);
    await assertModelBlockTargetCurrent(target, input.identity);
    return job.checkpoint.outputs;
  } catch (error) {
    if (error instanceof ModelBlockSourceChanged) return null;
    throw error;
  }
}

/** Stronger adoption proof: reload the complete immutable block and compare
 * its entire selected dependency vector with current source evidence. The
 * caller owns the shared invocation meter and cooperative deadline. */
export async function readVerifiedAnalyticsModelBlock(input: {
  source: D1Database; target: D1Database; identity: ModelBlockIdentity; owner: Owner;
  check: (queries: number) => void;
  admission?: ModelBlockAdmission;
}): Promise<ModelBlockCheckpoint | null> {
  const { source, target, identity, owner, check } = input;
  const admission = input.admission ? { admission: input.admission, historicalTodayDay: input.admission.todayDay } : {};
  if (source === target || !validModelBlockIdentity(identity))
    throw new TypeError('MODEL_BLOCK_INVALID_IDENTITY');
  check(20);
  await assertModelBlockSourceCurrent(source, owner, identity);
  await assertModelBlockTargetCurrent(target, identity);
  const job = await readModelBlockJob({ target, identity, ...admission });
  if (job?.checkpoint.phase !== 'complete') return null;
  let index = 0;
  await appendModelBlockDependencies(source, identity, owner, [], check, dependency => {
    if (canonicalJson(job.checkpoint.dependencies[index++]) !== canonicalJson(dependency))
      throw new ModelBlockSourceChanged();
  });
  if (index !== job.checkpoint.dependencies.length) throw new ModelBlockSourceChanged();
  check(20);
  await assertModelBlockSourceCurrent(source, owner, identity);
  await assertModelBlockTargetCurrent(target, identity);
  return job.checkpoint;
}
