import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { accountScopedQuotaAnalysis } from './quota-analysis';
import { accountScopedQuotaAnalysisV1, accountScopedHistoricalModelCompositionV1,
  MODEL_HISTORY_METHOD_VERSION, type V1ModelCompositionResult } from './quota-analysis-v1';
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
  V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } from './quota-analysis-v11';
import { assertV11SourcePinCurrent,type V11SourcePin } from './telemetry-v11-domain';
import { assertTypedV11GenerationSnapshotLive,type V11GenerationSnapshot } from './typed-v11-quota-reader';
import { assertV1SourcePinCurrent, loadV1SourcePin } from './telemetry-v1-source-selection';
import { modelHistoryWindow } from './model-history-window';
import { communityAnalysisCacheVersion, loadCommunitySourcePin, parsedCachedFits,
  selectCommunityAllowanceAnalysisFits, validCompleteCachedComposition, validCompleteScalarAnalysis,
  COMMUNITY_ALLOWANCE_FIT_METHOD,
  type CommunityAllowanceFit } from './community-allowance';
import { captureStorageCommunityAuthority, sameStorageCommunityCalculationAuthority,
  storageCommunityCalculationAuthorityIsCurrent,
  type StorageCommunityAuthority, type StorageCommunityOwner } from './storage-community-authority';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { createD1InvocationBudget } from './d1-invocation-budget';
import { advanceStorageV1CurrentFitAnalysis,advanceStorageV1HistoricalAnalysis,type StorageV1HistoryCheckpoint } from './storage-v1-history';
import { V1_QUOTA_ACQUISITION_VERSION } from './quota-analysis-v1-reader';
import { advanceStorageV11Analysis,loadStorageV11PreparedDays,STORAGE_V11_PREPARED_FOLD,
  type StorageV11HistoryCheckpoint } from './storage-v11-history';
import type { GraphDayProjection } from './graph-day-projection-values';
import { loadStorageHistoryCheckpoint, readStorageHistoryCheckpointHead, saveStorageHistoryCheckpoint,
  storageHistoryCheckpointParts,
  type StorageHistoryCheckpoint,type StorageHistoryKey,type StorageHistoryLoadCursor,
  type StorageHistorySaveCursor } from './storage-history-checkpoint';
import { caughtStorageGraphFailureFields, withStorageGraphFailureStage,
  type StorageGraphFailureFields } from './storage-analytics-failure';

export const STORAGE_GRAPH_METHOD = communityAnalysisCacheVersion() + ':separate-results-1';
// Checkpoint storage is an implementation detail, separate from the semantic
// result identity above. Bump only this namespace when a prior generation's
// permanent anti-resurrection tombstones must remain valid but must not block
// a repaired reader from making new resumable progress.
export const STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':checkpoint-store-3';
export const STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':current-fit-checkpoint-2';
// -4: the v1.1 acquisition can now be settled by folding prepared per-day
// projections instead of paging the owner's whole window once per sub-phase.
// The RESULT identity is deliberately unchanged, because the fold is proven
// byte-identical by the parity oracle and an identical result must not retire
// a computed day; the checkpoint FORMAT is what a resumed acquisition would
// mix, so only this separate namespace moves. In-flight parts under -3 are
// abandoned, which is the documented purpose of this namespace.
export const STORAGE_GRAPH_V11_CHECKPOINT_METHOD = STORAGE_GRAPH_METHOD + ':v11-shared-checkpoint-4';
/** The v1.1 checkpoint namespaces, as a pure rule so both branches can be
 * proven rather than described.
 *
 * The metrics share one usage reduction until the prepared-day fold is on.
 * Once it is, the model metric runs that reduction WITHOUT its scalar half, so
 * a model successor is not one a fits claim may resume and the two must not
 * share a key. Until then they still run the identical reduction, and splitting
 * would only throw away the reuse a fits claim and a model claim get from one
 * shared successor — doubling v1.1 usage checkpoint work in exactly the
 * configuration this change is meant to deploy inert. So the split is gated on
 * the same flag as the fold, and the shared base is the live method while it is
 * off. Switching the flag abandons in-flight v1.1 checkpoints, which is already
 * what switching the fold on does. */
export function storageGraphV11CheckpointMethods(foldEnabled: boolean): {
  fits: string; model: string; live: readonly string[];
} {
  const fits = foldEnabled ? STORAGE_GRAPH_V11_CHECKPOINT_METHOD + ':fits-1'
    : STORAGE_GRAPH_V11_CHECKPOINT_METHOD;
  const model = foldEnabled ? STORAGE_GRAPH_V11_CHECKPOINT_METHOD + ':model-1'
    : STORAGE_GRAPH_V11_CHECKPOINT_METHOD;
  return { fits, model, live: [...new Set([fits, model])] };
}
/** The method one metric's key is built with, under the fold configuration this
 * caller actually runs. The fold is a DEPLOYMENT switch, so the namespace it
 * governs must follow the same runtime value as the behaviour it governs: a
 * reader that drops the scalar half while still naming the shared method would
 * stage a model-only successor under the key a fits claim resumes. The scalar
 * mode fence then fails that resume closed, and the finisher degrades a fits
 * claim to `supported_quota_track_unavailable` under an unchanged result
 * identity, publishing a refusal the evidence never made. Defaulting to the
 * module constant keeps every caller that has no switch on the shared base. */
export function storageGraphV11CheckpointMethod(metric: 'fits' | 'model',
  foldEnabled: boolean = STORAGE_V11_PREPARED_FOLD): string {
  const methods = storageGraphV11CheckpointMethods(foldEnabled);
  return metric === 'fits' ? methods.fits : methods.model;
}
/** The method names under the MODULE DEFAULT configuration, for callers and
 * tests that hold no deployment switch. Production readers must not use these:
 * they name a namespace the deployment may have moved, which is the defect
 * `storageGraphV11CheckpointMethod` exists to prevent. */
export const STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD =
  storageGraphV11CheckpointMethod('fits');
export const STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD =
  storageGraphV11CheckpointMethod('model');
/** The v1.1 methods a `fits` claim can have staged work under, across both fold
 * configurations. Retirement maps a stage's method back to its metric, and a
 * stage written before a flag flip is still that metric's. */
export const STORAGE_GRAPH_V11_FITS_CHECKPOINT_METHODS = Object.freeze([
  storageGraphV11CheckpointMethods(false).fits, storageGraphV11CheckpointMethods(true).fits]);
/** Every checkpoint method a live reader can build a key with. Retirement
 * reclaims any stage under another method on sight, so a new method must be
 * registered here before a reader starts writing under it.
 *
 * BOTH fold configurations are registered, unconditionally. The switch can be
 * thrown in either direction while stages are in flight, and the stages the
 * other configuration wrote must age out through the ordinary result-backed
 * path rather than be reclaimed on sight the moment the flag moves. */
export const STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS = Object.freeze([
  STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD, STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,
  ...new Set([...storageGraphV11CheckpointMethods(false).live,
    ...storageGraphV11CheckpointMethods(true).live])]);
// Execution-only revision for the single optimistic direct historical read.
// This is deliberately absent from result/checkpoint identities: a reader fix
// may reopen one direct attempt without changing the analysis semantics.
const STORAGE_GRAPH_DIRECT_HISTORY_READER_REVISION = 'typed-v1-direct-cross-1';
const MAX_RESULT_BYTES = 1024 * 1024;
// Acquisition may consume its cooperative work deadline exactly. Keep an
// outer window for the final source proof and the resumable checkpoint-save
// batches, otherwise a deadline-limited pass can discard the group it acquired.
// A multi-megabyte v1.1 acquisition stages several 30-part batches at a few
// hundred milliseconds of D1 round trip each; staging left unfinished here is
// continued by the next pass because the group successor is deterministic.
const STORAGE_GRAPH_CHECKPOINT_SAVE_HEADROOM_MS = 12_000;
// The v1 readers keep the 1,024-row page and their own `maxPages<=32` bound.
const STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM = 32;
/** Pages in the fixed whole v1.1 group, the fallback taken when a partial group
 * is not permitted (a multi-batch successor, or the `endpoints` sub-phase) or
 * not affordable. A whole group is all-or-nothing: a group that reads fewer
 * pages than it asked for is a `cut`, and its successor is discarded rather
 * than staged, so the group's wall clock has to fit the checkpoint work window
 * or the claim makes no durable progress at all.
 *
 * The source page is now 16,384 rows rather than 4,096, so a page costs at
 * most four times what it did. Eight pages therefore bound the group by the
 * same 131,072 source rows and the same worst-case wall clock as the previous
 * 32 pages of 4,096: no stage that finishes its group today can start being
 * cut. The statement cost falls with the page count, so the same rows now cost
 *   8 pages + 4 fences + 6 pre-checks + 37 first save = 55 statements
 * instead of 32 + 4 + 6 + 37 = 79, which is 2,383 source rows per statement
 * against 1,659, and lets one 900-statement claim run 15 whole groups where it
 * previously ran 10. */
export const STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM = 8;
// One save batch stages at most 30 parts, so a successor at or below that
// bound is promoted or abandoned whole and never has to be reproduced to
// resume its staged parts. Larger successors keep the fixed whole-group rule.
export const STORAGE_GRAPH_V11_SINGLE_BATCH_PARTS = 30;
/** Statement costs of one v1.1 group and its promotion. A partial group is
 * sized to leave all of them affordable, otherwise a claim can read a whole
 * window of pages and then find it cannot stage the successor at all:
 * `group` is the reserve `advanceStorageV11Analysis` takes from its own local
 * budget (the meter itself pays only the pages and the fences, so this entry
 * is conservatism rather than a meter cost),
 * `fences` the source statements it issues around the pages (snapshot load,
 * two live proofs and the reader scope), `persistPreChecks` the source and
 * target proofs `persistCheckpoint` runs before its save loop,
 * `saveLoopGuard` that loop's own admission bound, `firstSave` one save call
 * (5 reads, a batch of at most 31 statements and the head read) and
 * `extraSave` each resumed batch. Exported so the bound can be proven. */
export const STORAGE_GRAPH_V11_GROUP_QUERY_COSTS = Object.freeze({
  group: 7, fences: 4, persistPreChecks: 6, saveLoopGuard: 40, firstSave: 37, extraSave: 32, margin: 7 });
// The largest successor this store can hold is 1,024 parts, but a v1.1 graph
// checkpoint at its own byte limits frames to roughly 240 parts (30 MB), which
// is eight save batches. A partial group is sized to leave that whole
// promotion affordable, because a partial successor it cannot stage is work no
// later pass can reproduce and therefore work simply thrown away.
export const STORAGE_GRAPH_V11_MAX_SAVE_BATCHES = 8;
const STORAGE_GRAPH_V11_PARTIAL_QUERY_RESERVE = STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.group
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.fences + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.persistPreChecks
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.saveLoopGuard + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.firstSave
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.extraSave * (STORAGE_GRAPH_V11_MAX_SAVE_BATCHES - 1)
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.margin;
/** A claim only starts another whole group while that group and the promotion
 * of its successor both still fit the meter, so this is derived from the group
 * rather than carried as a number that a page-count change would silently
 * invalidate. The group itself spends its pages and its fences on the meter;
 * `persistCheckpoint` then runs the source and target proofs, and its save loop
 * admits a call only while `saveLoopGuard` statements remain, spending at most
 * `firstSave` on that call:
 *   8 pages + 4 fences + 6 persistPreChecks + 40 saveLoopGuard + 7 margin = 65
 * After the group (12) and the pre-checks (6) the meter still holds 47, which
 * is above the guard (40) and above one save (37). Larger successors are the
 * whole-group rule's own business: they are reproducible from this head, so an
 * unfinished save is resumed by the next pass instead of abandoned. */
export const STORAGE_GRAPH_V11_CONTINUE_QUERIES = STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.fences + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.persistPreChecks
  + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.saveLoopGuard + STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.margin;
// Leave the save of the successor a whole round trip and its batch.
const STORAGE_GRAPH_V11_SAVE_RESERVE_MS = 4_000;
// One save batch is a D1 round trip of a larger payload, so it is never
// assumed faster than this nor faster than twice the measured round trip.
const STORAGE_GRAPH_V11_SAVE_BATCH_MS = 1_500;
// A single immeasurably fast or pathologically slow statement must not size a
// whole claim, and an unmeasured compute assumes an ordinary D1 round trip.
const STORAGE_GRAPH_V11_ROUND_TRIP_MIN_MS = 150, STORAGE_GRAPH_V11_ROUND_TRIP_MAX_MS = 3_000,
  STORAGE_GRAPH_V11_ROUND_TRIP_DEFAULT_MS = 400;
const STORAGE_GRAPH_V11_MAX_PARTIAL_PAGES = 1024;
const fail = () => new Error('STORAGE_GRAPH_RESULT_UNAVAILABLE');

/** Whether one claim may take a partial v1.1 group from this head. A partial
 * group stages the successor a budget or deadline cut produced, which is only
 * safe while that successor is promoted or abandoned whole: a fresh key has no
 * staged parts to reproduce, and a head that fits one save batch cannot leave
 * half a generation behind. The acquisition `endpoints` sub-phase is excluded
 * because that is where a checkpoint grows to hundreds of parts inside one
 * group, so its successor must stay the fixed, reproducible whole group. The
 * caller still runs the whole group when the meter cannot afford any partial
 * group, and the boundary stop inside the acquisition is what keeps a partial
 * successor compact between sub-phases. Pure. */
export function storageGraphV11GroupMode(input:{staged:boolean;singleBatch:boolean;
 checkpoint:StorageV11HistoryCheckpoint|null}):'partial'|'whole'{
 if(!input.staged)return 'partial';
 if(!input.singleBatch)return 'whole';
 const checkpoint=input.checkpoint;
 return checkpoint!==null&&checkpoint.phase==='acquisition'&&checkpoint.acquisition.phase==='endpoints'
  ?'whole':'partial';
}

/** Pure test of whether this invocation can certainly complete every batch of
 * a successor's save, which is what makes staging a non-reproducible partial
 * successor safe. It mirrors `persistCheckpoint`'s own admission rule exactly:
 * the source and target proofs run first, then the save loop admits a call
 * only while the meter still holds `saveLoopGuard`, the first call costs at
 * most `firstSave` and each resumed batch at most `extraSave`. A batch is also
 * never assumed faster than a D1 round trip of its own payload. */
export function storageGraphV11SaveAffordable(input:{parts:number;remainingQueries:number;
 nowMs:number;deadlineMs:number;estimateMs:number}):boolean{
 const costs=STORAGE_GRAPH_V11_GROUP_QUERY_COSTS;
 const batches=Math.max(1,Math.ceil(input.parts/STORAGE_GRAPH_V11_SINGLE_BATCH_PARTS));
 const queries=costs.persistPreChecks+costs.saveLoopGuard
  +(batches>1?costs.firstSave+costs.extraSave*(batches-2):0);
 const perBatchMs=Math.max(STORAGE_GRAPH_V11_SAVE_BATCH_MS,2*input.estimateMs);
 return input.remainingQueries>=queries&&input.nowMs+batches*perBatchMs<=input.deadlineMs;
}

/** Pure page bound for one partial v1.1 group. The round trip is this compute's
 * own measured D1 latency (elapsed milliseconds per statement it issued),
 * clamped so one outlier cannot size the claim and defaulted when nothing was
 * measured. The group then spends the window that remains before the
 * checkpoint work deadline, minus the reserve its save needs, and never more
 * pages than the invocation meter still owes the group. */
export function storageGraphV11PartialGroupPages(input:{nowMs:number;deadlineMs:number;
 elapsedMs:number;statements:number;remainingQueries:number}):{estimateMs:number;maxPages:number}{
 const measured=Number.isSafeInteger(input.statements)&&input.statements>0
  &&Number.isFinite(input.elapsedMs)&&input.elapsedMs>0?input.elapsedMs/input.statements:null;
 const estimateMs=measured===null?STORAGE_GRAPH_V11_ROUND_TRIP_DEFAULT_MS
  :Math.min(STORAGE_GRAPH_V11_ROUND_TRIP_MAX_MS,Math.max(STORAGE_GRAPH_V11_ROUND_TRIP_MIN_MS,measured));
 const window=input.deadlineMs-input.nowMs-STORAGE_GRAPH_V11_SAVE_RESERVE_MS;
 const byTime=Number.isFinite(window)?Math.floor(window/estimateMs):0;
 const byQueries=Math.min(STORAGE_GRAPH_V11_MAX_PARTIAL_PAGES,
  input.remainingQueries-STORAGE_GRAPH_V11_PARTIAL_QUERY_RESERVE);
 // Below one page the claim cannot afford a group and the promotion of its
 // successor together, so it reports no group at all rather than reading pages
 // it would have to discard.
 return {estimateMs,maxPages:byQueries<1?0:Math.max(1,Math.min(byTime,byQueries))};
}
const scopeChanged = () => new Error('storage graph scope changed');
export type StorageGraphSource = 'v0.2' | 'v1' | 'v1.1' | 'mixed';
type Source = StorageGraphSource;
type Pin = Awaited<ReturnType<typeof loadCommunitySourcePin>>['sourcePin'];
export interface StorageGraphScope {
  authority: StorageCommunityAuthority; owner: StorageCommunityOwner & {ownerDigest:string};
  source: Source; pin: Pin; day: string; fixedNow: string; metric:'fits'|'model';
  dependencyDigest:string; checkpointDependencyDigest:string;
  /** Graph-only immutable v1.1 generation selected before newer source work. */
  snapshot?:V11GenerationSnapshot;
  /** Target owner epoch captured by the work-selection CAS. */
  ownerAuthorityEpoch?:number;
}
export interface StorageGraphResult {
  scope:StorageGraphScope; fits:CommunityAllowanceFit[] | null; composition:V1ModelCompositionResult | null;
  unsupportedSource?:boolean;
}

/** Shared byte identity for computation and bounded publication revalidation.
 * Callers supply the exact elected metadata, never counts or newest timestamps. */
export async function storageGraphDependencyDigest(options:{
  authority:Pick<StorageCommunityAuthority,'sourceId'|'sourceNamespace'>;ownerDigest:string;
  source:StorageGraphSource;metric:'fits'|'model';day:string;dependency:unknown;
}):Promise<string> {
  const history=modelHistoryWindow(options.day);
  // Each source's acquisition version is part of only that source's identity.
  // A change to how v1.1 or v1 evidence is acquired must retire that source's
  // results, and must not discard the other's, nor v0.2's, which were computed
  // by readers the change never touched. `mixed` keeps the legacy identity.
  return sha256Hex(canonicalJson([options.authority.sourceId,options.authority.sourceNamespace,
    options.ownerDigest,options.source,options.metric,history.day,history.fromDay,STORAGE_GRAPH_METHOD,options.dependency,
    // The fit gates and the reset-evidence method beneath them, on the FITS
    // identity only. `buildResetEvidence` is reached solely from the scalar
    // half, so a change there cannot alter a model composition — and folding
    // this into STORAGE_GRAPH_METHOD instead would retire the whole by-model
    // corpus to recompute a statistic the model metric does not contain.
    ...(options.metric==='fits'?[COMMUNITY_ALLOWANCE_FIT_METHOD]:[]),
    ...(options.source==='v1.1'?[V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION]:[]),
    ...(options.source==='v1'?[V1_QUOTA_ACQUISITION_VERSION]:[])]));
}

async function storageGraphCheckpointDependencyDigest(options:{
 authority:Pick<StorageCommunityAuthority,'sourceId'|'sourceNamespace'>;ownerDigest:string;
 source:StorageGraphSource;metric:'fits'|'model';day:string;dependency:unknown;
 preparedFold?:boolean;
}):Promise<string>{
 const history=modelHistoryWindow(options.day);
 // Only v1.1 owners hold this key, so the acquisition version is always part
 // of it: a resumed checkpoint must never mix two acquisition contracts. The
 // usage reduction is no longer shared between the metrics — the model metric
 // runs it without the scalar half — so the metric is part of the identity as
 // well as of the method, and neither metric can load the other's successor.
 return sha256Hex(canonicalJson([options.authority.sourceId,options.authority.sourceNamespace,
  options.ownerDigest,options.source,
  // Gated on the same flag as the method, and on the RUNTIME value of it: while
  // the fold is off the metrics run the identical reduction and keep sharing one
  // successor, and only the fold's model-only mode makes them incompatible. A
  // digest that read the module constant here would keep the metrics sharing a
  // key in exactly the deployed configuration that makes them incompatible.
  (options.preparedFold??STORAGE_V11_PREPARED_FOLD)
    ?(options.metric==='fits'?'v11-usage:fits-1':'v11-usage:model-1'):'shared-v11-usage',
  history.day,history.fromDay,STORAGE_GRAPH_METHOD,options.dependency,
  V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION]));
}

/** The cache key is the exact selected evidence in this window, not the newest
 * whole-domain generation. An append outside a closed historical window does
 * not invalidate completed work. The live pin still fences every calculation. */
export async function captureStorageGraphScope(sourceDb:D1Database, options:{
  owner:StorageCommunityOwner; day:string; metric:'fits'|'model';
  sourceId?:string; sourceNamespace?:string;
  /** The pass's own fold switch. It names the checkpoint namespace this scope's
   * work will be staged under, so it must be the value the compute will run. */
  preparedFold?:boolean;
}):Promise<StorageGraphScope> {
  const owner={...options.owner}, history=modelHistoryWindow(options.day);
  if(!owner.ownerDigest || !/^[a-f0-9]{64}$/.test(owner.ownerDigest)
    || !['fits','model'].includes(options.metric))throw fail();
  const authority=await captureStorageCommunityAuthority(sourceDb,options);
  const source:Source=owner.hasV11?'v1.1':owner.hasV1?owner.hasLegacy?'mixed':'v1':'v0.2';
  // Pure-v1 history depends only on the closed model window. Loading the
  // current-fit adapter first materialized the wider open-ended chunk vector,
  // scanned irrelevant legacy metadata, reloaded that vector as an assertion,
  // then discarded it for this same closed pin. Mixed sources still require
  // the combined adapter and its legacy dependency vector.
  let loaded:Awaited<ReturnType<typeof loadCommunitySourcePin>>;
  if(options.metric==='model'&&source==='v1') {
    const sourcePin=await withStorageGraphFailureStage('graph_historical_pin',()=>loadV1SourcePin(sourceDb,
      {participantId:owner.participantId,fromDay:history.fromDay,throughDay:history.day},{includeDayDependencies:true}));
    loaded={sourcePin,fingerprint:sourcePin.fingerprint};
  } else loaded=await loadCommunitySourcePin(sourceDb,owner.participantId,history.fromDay,source,
    {includeDayDependencies:true});
  if(loaded.sourcePin.inputRevision!==owner.inputRevision)throw scopeChanged();
  let dependency:unknown=loaded.fingerprint;
  if('source' in loaded.sourcePin) {
    const rows=(await sourceDb.prepare(`SELECT d.observed_day,m.id,m.manifest_digest,m.device_id
      FROM telemetry_v11_domain_days d JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
      WHERE d.generation_id=? AND d.observed_day>=? AND d.observed_day<=?
      ORDER BY d.observed_day LIMIT 102`).bind(loaded.sourcePin.generationId,history.fromDay,history.day)
      .all<Record<string,unknown>>()).results;
    if(rows.length>101)throw fail();
    dependency=rows;
  } else if(source==='v1') {
    // The current legacy source-only adapter has no upper time predicate.
    // Retain its complete dependency vector; historical composition uses its
    // separate closed-window adapter and must not reuse this current result.
    if(!loaded.sourcePin.dayDependencies)throw fail();
    dependency=loaded.sourcePin.dayDependencies;
  }
  const dependencyDigest=await storageGraphDependencyDigest({authority,ownerDigest:owner.ownerDigest,
    source,metric:options.metric,day:history.day,dependency});
  const checkpointDependencyDigest=source==='v1.1'?await storageGraphCheckpointDependencyDigest({authority,
    ownerDigest:owner.ownerDigest,source,metric:options.metric,day:history.day,dependency,
    ...(options.preparedFold===undefined?{}:{preparedFold:options.preparedFold})}):dependencyDigest;
  if(!await storageCommunityCalculationAuthorityIsCurrent(sourceDb,authority))throw scopeChanged();
  return {authority,owner:owner as StorageGraphScope['owner'],source,pin:loaded.sourcePin,
    day:history.day,fixedNow:history.fixedNow,metric:options.metric,dependencyDigest,checkpointDependencyDigest};
}

/** Reconstruct a graph scope from one retained v1.1 generation selected before
 * a newer head was admitted. Dependency identities are recomputed from that
 * immutable generation; callers cannot supply or weaken them. */
export async function captureSelectedStorageGraphScope(sourceDb:D1Database,options:{
 owner:StorageCommunityOwner;day:string;metric:'fits'|'model';snapshot:V11GenerationSnapshot;
 ownerAuthorityEpoch:number;sourceId?:string;sourceNamespace?:string;
 /** As `captureStorageGraphScope`. A recomputed scope must name the same
  * namespace the envelope recorded, or the selection is correctly superseded. */
 preparedFold?:boolean;
}):Promise<StorageGraphScope>{
 const owner={...options.owner},history=modelHistoryWindow(options.day),snapshot=structuredClone(options.snapshot);
 if(!owner.ownerDigest||!/^[a-f0-9]{64}$/u.test(owner.ownerDigest)||!owner.hasV11
  ||owner.participantId!==snapshot.participantId||!Number.isSafeInteger(options.ownerAuthorityEpoch)
  ||options.ownerAuthorityEpoch<1||snapshot.sourceNamespace!==options.sourceNamespace)throw fail();
 const authority=await captureStorageCommunityAuthority(sourceDb,options);
 await assertTypedV11GenerationSnapshotLive(sourceDb,snapshot);
 const rows=(await sourceDb.prepare(`SELECT d.observed_day,m.id,m.manifest_digest,m.device_id
   FROM telemetry_v11_domain_days d JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id
   WHERE d.generation_id=? AND d.observed_day>=? AND d.observed_day<=?
   ORDER BY d.observed_day LIMIT 102`).bind(snapshot.generationId,history.fromDay,history.day)
   .all<Record<string,unknown>>()).results;
 if(rows.length>101)throw fail();
 const dependencyDigest=await storageGraphDependencyDigest({authority,ownerDigest:owner.ownerDigest,
  source:'v1.1',metric:options.metric,day:history.day,dependency:rows});
 const checkpointDependencyDigest=await storageGraphCheckpointDependencyDigest({authority,
  ownerDigest:owner.ownerDigest,source:'v1.1',metric:options.metric,day:history.day,dependency:rows,
  ...(options.preparedFold===undefined?{}:{preparedFold:options.preparedFold})});
 const pin:V11SourcePin={source:'v1.1',participantId:snapshot.participantId,generationId:snapshot.generationId,
  fromDay:snapshot.fromDay,throughDay:snapshot.throughDay,inputRevision:snapshot.inputRevision,
  mutationEpoch:authority.sourceEpoch,fingerprint:snapshot.fingerprint};
 if(!await storageCommunityCalculationAuthorityIsCurrent(sourceDb,authority))throw scopeChanged();
 return {authority,owner:{...owner,inputRevision:snapshot.inputRevision,ownerDigest:owner.ownerDigest},source:'v1.1',pin,
  day:history.day,fixedNow:history.fixedNow,metric:options.metric,dependencyDigest,checkpointDependencyDigest,
  snapshot,ownerAuthorityEpoch:options.ownerAuthorityEpoch};
}

async function selectedOwnerAuthorityIsCurrent(source:D1Database,scope:StorageGraphScope):Promise<boolean>{
 if(scope.ownerAuthorityEpoch===undefined)return true;
 const row=await source.prepare(`SELECT 1 AS ready FROM storage_v11_owner_links l
  JOIN storage_owner_revisions r ON r.owner_digest=l.owner_digest AND r.state='active' AND r.authority_epoch=?
  WHERE l.participant_id=? AND l.owner_digest=? AND l.state='active'`).bind(scope.ownerAuthorityEpoch,
   scope.owner.participantId,scope.owner.ownerDigest).first<number>('ready');
 return row===1;
}

async function current(source:D1Database,scope:StorageGraphScope):Promise<boolean> {
  if(scope.snapshot)await assertTypedV11GenerationSnapshotLive(source,scope.snapshot);
  else if('source' in scope.pin)await assertV11SourcePinCurrent(source,scope.pin);
  else await assertV1SourcePinCurrent(source,scope.pin);
  return await selectedOwnerAuthorityIsCurrent(source,scope)
    &&storageCommunityCalculationAuthorityIsCurrent(source,scope.authority);
}
async function targetReady(target:D1Database,scope:StorageGraphScope):Promise<void> {
  if(scope.snapshot&&(scope.source!=='v1.1'||!('source'in scope.pin)
    ||scope.snapshot.participantId!==scope.owner.participantId
    ||scope.snapshot.sourceNamespace!==scope.authority.sourceNamespace
    ||scope.snapshot.fingerprint!==scope.pin.fingerprint))throw fail();
  if(!await target.prepare(`SELECT 1 FROM analytics_runtime_sources WHERE source_id=?
    AND source_namespace=? AND contract_version=1`).bind(scope.authority.sourceId,scope.authority.sourceNamespace).first())throw fail();
  if(scope.ownerAuthorityEpoch!==undefined&&(!Number.isSafeInteger(scope.ownerAuthorityEpoch)
    ||scope.ownerAuthorityEpoch<0||!await target.prepare(`SELECT 1 FROM analytics_owner_state
      WHERE source_id=? AND owner_digest=? AND state='active' AND authority_epoch=?`)
      .bind(scope.authority.sourceId,scope.owner.ownerDigest,scope.ownerAuthorityEpoch).first()))throw fail();
}
function decoded(row:{payload_json:string;payload_fingerprint:string;source_kind:StorageGraphSource},scope:StorageGraphScope):StorageGraphResult|null {
  if(row.source_kind!==scope.source)return null;
  if(scope.metric==='fits') {
    const fits=parsedCachedFits(row.payload_json,scope.owner.ownerDigest);
    return fits===null?null:{scope,fits,composition:null};
  }
  let composition:unknown;try{composition=JSON.parse(row.payload_json)}catch{return null}
  if(canonicalJson(composition)==='{"reason":"legacy_source_overlap","status":"unsupported_source"}') {
    return scope.source==='v0.2'||scope.source==='mixed'?{scope,fits:null,composition:null,unsupportedSource:true}:null;
  }
  const method=scope.source==='v1.1'?V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:MODEL_HISTORY_METHOD_VERSION;
  return validCompleteCachedComposition(composition,row.payload_fingerprint,method)
    ?{scope,fits:null,composition}:null;
}

/** Private read. A matching method/dependency proves data reuse; a final source
 * read independently proves authority. Cache timestamps never prove either. */
export async function readStorageGraphResult(bindings:StorageAnalyticsBindings,scope:StorageGraphScope):Promise<StorageGraphResult|null> {
  if(bindings.sourceId!==scope.authority.sourceId||bindings.sourceNamespace!==scope.authority.sourceNamespace
    || bindings.source===bindings.target)throw fail();
  await targetReady(bindings.target,scope);
  const row=await bindings.target.prepare(`SELECT payload_json,payload_fingerprint,payload_sha256,authority_json,source_kind
    FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND metric=? AND day=?
      AND method=? AND dependency_digest=?`).bind(bindings.sourceId,scope.owner.ownerDigest,scope.metric,
        scope.day,STORAGE_GRAPH_METHOD,scope.dependencyDigest)
    .first<{payload_json:string;payload_fingerprint:string;payload_sha256:string;authority_json:string;source_kind:StorageGraphSource}>();
  if(!row)return null;
  let authority:StorageCommunityAuthority;try{authority=JSON.parse(row.authority_json)}catch{return null}
  if(!authority||!sameStorageCommunityCalculationAuthority(authority,scope.authority)
    ||new TextEncoder().encode(row.payload_json).byteLength>MAX_RESULT_BYTES
    ||await sha256Hex(row.payload_json)!==row.payload_sha256)return null;
  const result=decoded(row,scope);
  return result && await current(bindings.source,scope)?result:null;
}

/** Runs the existing kernels against read-only source evidence. Only their
 * completed, validated output is persisted in analytics. A target failure has
 * no transaction, cache write or backpressure hook in ingestion. */
export async function computeStorageGraphResult(bindings:StorageAnalyticsBindings,scope:StorageGraphScope,
  options:{maxQueries?:number;deadlineMs?:number;now?:()=>number;
    /** Whether this pass may fold prepared days for a v1.1 owner. Absent means
     * the module constant, so the deploy is inert until the composition root
     * passes the deployment switch. */
    preparedFold?:boolean}={}):Promise<
  {state:'complete';result:StorageGraphResult;reused:boolean}
  |{state:'deferred';reason:string;failure?:StorageGraphFailureFields}> {
  if(bindings.source===bindings.target)throw fail();
  const meter=createD1InvocationBudget(options.maxQueries??900),now=options.now??Date.now,
    startedMs=now(),deadlineMs=options.deadlineMs??startedMs+20_000,
    checkpointWorkDeadlineMs=deadlineMs-STORAGE_GRAPH_CHECKPOINT_SAVE_HEADROOM_MS;
  if(!Number.isFinite(startedMs)||!Number.isFinite(deadlineMs))throw fail();
  bindings={...bindings,source:meter.wrap(bindings.source),target:meter.wrap(bindings.target)};
  const cached=await readStorageGraphResult(bindings,scope);
  if(cached) {
    // Small proof refresh only. The exact window dependency was recomputed;
    // the completed payload and its original analytical fingerprint are kept.
    await bindings.target.prepare(`UPDATE analytics_community_graph_results SET input_revision=?
      WHERE source_id=? AND owner_digest=? AND metric=? AND day=? AND method=? AND dependency_digest=?
      AND input_revision<?`).bind(scope.owner.inputRevision,bindings.sourceId,scope.owner.ownerDigest,scope.metric,
        scope.day,STORAGE_GRAPH_METHOD,scope.dependencyDigest,scope.owner.inputRevision).run();
    return {state:'complete',result:cached,reused:true};
  }
  const nowMs=Date.parse(scope.fixedNow),source=bindings.source;
  const persistCheckpoint=async(key:StorageHistoryKey,checkpoint:StorageHistoryCheckpoint,
    expectedHead:string|null,reason:string):Promise<
    {state:'saved';head:string;parts:number}|{state:'deferred';reason:string;failure?:StorageGraphFailureFields}>=>{
    if(!await current(source,scope))return {state:'deferred',reason};
    await targetReady(bindings.target,scope);
    try{
      // The first write reads the owner, head and retained parts; later writes
      // of the same generation continue from the private cursor with one part
      // batch and one head read each. The part-insert trigger and the head
      // CAS still fence every batch against a concurrent promotion. The framed
      // part count is what a v1.1 caller needs, not the number of writes this
      // call happened to make: a replayed save writes once for a generation of
      // any size.
      let cursor:StorageHistorySaveCursor|undefined;
      while(meter.remainingQueries>=STORAGE_GRAPH_V11_GROUP_QUERY_COSTS.saveLoopGuard&&now()<deadlineMs){
        const saved=await withStorageGraphFailureStage('graph_checkpoint_save',
          ()=>saveStorageHistoryCheckpoint({target:bindings.target,key,checkpoint,expectedHead,...(cursor?{cursor}:{})}));
        if(saved.status==='saved')return {state:'saved',head:saved.headDigest,parts:saved.totalParts};
        cursor=saved.cursor;
      }
    }catch(error){
      const failure=caughtStorageGraphFailureFields('graph_checkpoint_save',error);
      if(!failure||failure.reason!=='checkpoint_unavailable')throw error;
      let latest;try{latest=await readStorageHistoryCheckpointHead({target:bindings.target,key});}catch{throw error;}
      if(latest?.retired===0&&latest.generation!==null&&latest.generation!==expectedHead)
        return {state:'deferred',reason,failure};
      throw error;
    }
    return {state:'deferred',reason};
  };
  let v11CompletedFingerprint:string|null=null;
  const computeV11=async(metric:'fits'|'model',pin:Extract<Pin,{source:'v1.1'}>):Promise<
    {state:'complete';analysis:object}|{state:'deferred';reason:string;failure?:StorageGraphFailureFields}>=>{
    // A typed domain can become source-visible before its ordered owner-active
    // journal event reaches the analytics target. Do not read or stage private
    // evidence until the target has the matching active owner authority.
    const measuredFromMs=now(),measuredFromQueries=meter.queriesUsed;
    // The prepared days for this whole window, loaded once per claim. A window
    // the store does not hold completely yields nothing and the paged path
    // runs: the fold PUBLISHES its refusal rather than falling back, so an
    // incomplete set would write a wrong answer under an unchanged result
    // identity. The kernel's own coverage assertion is a backstop, not this
    // decision.
    let preparedDays:readonly GraphDayProjection[]|undefined;
    let preparedLoaded=false;
    const preparedFold=options?.preparedFold??STORAGE_V11_PREPARED_FOLD;
    const ownerReady=await bindings.target.prepare(`SELECT 1 AS ready FROM analytics_owner_state
      WHERE source_id=? AND owner_digest=? AND state='active'`).bind(bindings.sourceId,scope.owner.ownerDigest)
      .first<number>('ready');
    if(ownerReady!==1)return {state:'deferred',reason:'v11_owner_pending'};
    const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
      ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.checkpointDependencyDigest,
      method:storageGraphV11CheckpointMethod(metric,preparedFold)};
    let cursor:StorageHistoryLoadCursor|undefined,head:string|null=null,checkpoint:StorageV11HistoryCheckpoint|undefined;
    let partCount:number|null=null;
    for(;;){
      if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)return {state:'deferred',reason:'v11_checkpoint_read_budget'};
      const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
        ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
      if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
      head=loaded.headDigest??null;
      if(loaded.status==='ready'){
        if(!('source'in loaded.checkpoint)||loaded.checkpoint.source!=='v1.1')throw fail();
        checkpoint=loaded.checkpoint;partCount=loaded.partCount;
      }
      // Release the loaded part payloads before the group runs and stages.
      cursor=undefined;
      break;
    }
    // This compute's own D1 latency, measured over the owner proof and the
    // checkpoint load. It sizes partial groups only; a wrong estimate costs a
    // shorter or a cut group, never a different successor.
    const measuredMs=now()-measuredFromMs,measuredQueries=meter.queriesUsed-measuredFromQueries;
    let staged=head!==null,promoted=false,
      singleBatch=partCount!==null&&partCount<=STORAGE_GRAPH_V11_SINGLE_BATCH_PARTS;
    // Resolve and fence the source once around each bounded page group, then
    // promote its successor before starting another. If a read, a final pin
    // check or a promotion fails, the last durable head remains the replay
    // point. Groups keep running while this claim can still afford one and
    // stage it, so a long scheduler window finishes a large owner's phase
    // instead of spending a whole invocation on one fixed group.
    for(;;){
      const bound=storageGraphV11PartialGroupPages({nowMs:now(),deadlineMs:checkpointWorkDeadlineMs,
        elapsedMs:measuredMs,statements:measuredQueries,remainingQueries:meter.remainingQueries});
      // A partial group is only taken when this claim can also guarantee the
      // promotion of its successor. Otherwise the fixed whole group runs: its
      // successor is reproducible, so an unfinished save is resumed rather
      // than abandoned, and a small meter still makes durable progress. The
      // mode therefore depends on the meter as well as the head: a pass that
      // arrives nearly exhausted may stage part of a whole-group successor
      // that a later, well-funded pass supersedes with a partial one. The head
      // only moves by exact-head CAS, so that stage is swept, never promoted.
      const partialPages=storageGraphV11GroupMode({staged,singleBatch,checkpoint:checkpoint??null})==='partial'
        ?bound.maxPages:0;
      const mode=partialPages>=1?'partial':'whole';
      const maxPages=mode==='partial'?partialPages:STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM;
      if(preparedFold&&!preparedLoaded){
        preparedLoaded=true;
        const loaded=await withStorageGraphFailureStage('graph_prepared_days',
          ()=>loadStorageV11PreparedDays({source,target:bindings.target,sourceId:bindings.sourceId,
            sourceNamespace:bindings.sourceNamespace,ownerDigest:scope.owner.ownerDigest,
            snapshot:scope.snapshot!,sourcePin:pin,nowMs,
            budget:{remainingQueries:meter.remainingQueries,deadlineMs:checkpointWorkDeadlineMs,now},
            enabled:preparedFold}));
        preparedDays=loaded.days;
      }
      const next=await advanceStorageV11Analysis({source,sourceNamespace:bindings.sourceNamespace,
        participantId:scope.owner.participantId,day:scope.day,metric,nowMs,sourcePin:pin,
        generationSnapshot:scope.snapshot,
        closedDependencyDigest:scope.checkpointDependencyDigest,checkpoint,maxPages,
        ...(preparedDays!==undefined?{preparedDays,preparedFold}:{}),
        ...(mode==='partial'?{partialGroup:true}:{}),
        budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),deadlineMs:checkpointWorkDeadlineMs,now}});
      if(next.status==='complete'){
        v11CompletedFingerprint=checkpoint?.snapshot?.fingerprint??pin.fingerprint;
        return {state:'complete',analysis:next.analysis};
      }
      // A cut whole group is not staged: the next pass recomputes the same
      // deterministic successor from this head and resumes any staged parts.
      // A partial group only reports a cut when it read no source page at all.
      // `v11_checkpoint_group_budget` stays the signal that this claim promoted
      // nothing at all; a claim that already promoted reports the ordinary
      // checkpoint deferral it resumes from.
      if(next.cut)return {state:'deferred',reason:promoted?'v11_checkpoint':'v11_checkpoint_group_budget'};
      if(!next.checkpoint)return {state:'deferred',reason:'v11_checkpoint'};
      // Release the superseded checkpoint before the successor is framed:
      // holding both multi-megabyte frames and a canonical serialization at
      // once is what exhausts the isolate. `head` still carries the CAS.
      const successor=next.checkpoint;checkpoint=successor;
      if(mode==='partial'){
        // A partial successor is not reproducible, so it may only be staged
        // when this invocation can certainly finish every batch of its save.
        // Framing here is free for the save: the frame is memoized per object.
        const parts=await withStorageGraphFailureStage('graph_checkpoint_save',
          ()=>storageHistoryCheckpointParts(key,successor));
        if(!storageGraphV11SaveAffordable({parts,remainingQueries:meter.remainingQueries,
          nowMs:now(),deadlineMs,estimateMs:bound.estimateMs}))
          return {state:'deferred',reason:promoted?'v11_checkpoint':'v11_checkpoint_group_budget'};
      }
      const saved=await persistCheckpoint(key,successor,head,'v11_checkpoint');
      if(saved.state==='deferred')return saved;
      if(saved.head===head)return {state:'deferred',reason:'v11_checkpoint'};
      // Continue from the promoted successor already in memory. Its own framed
      // size, not the number of batches its save happened to take, decides
      // whether the next group may be partial.
      head=saved.head;staged=true;promoted=true;singleBatch=saved.parts<=STORAGE_GRAPH_V11_SINGLE_BATCH_PARTS;
      if(meter.remainingQueries<STORAGE_GRAPH_V11_CONTINUE_QUERIES||now()>=checkpointWorkDeadlineMs)
        return {state:'deferred',reason:'v11_checkpoint'};
    }
  };
  let payload='';
  if(scope.metric==='fits') {
    const analyses:Array<{source:'v0.2'|'v1'|'v1.1';analysis:object}>=[];
    if('source' in scope.pin){
      const next=await computeV11('fits',scope.pin);if(next.state==='deferred')return next;
      analyses.push({source:'v1.1',analysis:next.analysis});
    }
    else if(scope.source==='v1'){
      const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
       ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.dependencyDigest,
       method:STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD};
      let cursor:StorageHistoryLoadCursor|undefined,head:string|null=null;
      let checkpoint:StorageV1HistoryCheckpoint|undefined;
      for(;;){
       if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)
        return {state:'deferred',reason:'current_fit_checkpoint_read_budget'};
       const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
        ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
       if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
       head=loaded.headDigest??null;if(loaded.status==='ready'){
        if('source'in loaded.checkpoint)throw fail();checkpoint=loaded.checkpoint;
       }cursor=undefined;break;
      }
      const pin=scope.pin;
      const advance=(savedCheckpoint:typeof checkpoint,maxPages:number)=>advanceStorageV1CurrentFitAnalysis({
       source,participantId:scope.owner.participantId,day:scope.day,sourcePin:pin,
       checkpoint:savedCheckpoint,maxPages,budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),
        deadlineMs:checkpointWorkDeadlineMs,now}});
      const next=await advance(checkpoint,STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM);
      if(next.status==='complete')analyses.push({source:'v1',analysis:next.analysis});
      else {
       if(!next.checkpoint)return {state:'deferred',reason:'current_fit_checkpoint'};
       // Persist every phase successor before advancing it. In particular, a
       // finish->usage transition may itself be deferred; dropping that
       // returned cursor would make the next invocation replay the page and
       // can strand a large current-fit corpus forever.
       let staged=next.checkpoint,stagedHead=head;
       for(let transition=0;transition<3;transition++){
        const saved=await persistCheckpoint(key,staged,stagedHead,'current_fit_checkpoint');
        if(saved.state==='deferred')return saved;
        if(saved.head===stagedHead)return {state:'deferred',reason:'current_fit_checkpoint'};
        stagedHead=saved.head;
        if(staged.phase!=='finish'&&!(staged.phase==='usage'&&staged.usage.complete))
         return {state:'deferred',reason:'current_fit_checkpoint'};
        const advanced=await advance(staged,1);
        if(advanced.status==='complete'){
         analyses.push({source:'v1',analysis:advanced.analysis});break;
        }
        if(!advanced.checkpoint)return {state:'deferred',reason:'current_fit_checkpoint'};
        staged=advanced.checkpoint;
       }
      }
      if(!analyses.some(analysis=>analysis.source==='v1')){
       return {state:'deferred',reason:'current_fit_checkpoint'};
      }
    }
    else if(scope.source!=='v0.2')analyses.push({source:'v1',analysis:await accountScopedQuotaAnalysisV1(source,
      scope.owner.participantId,{nowMs,sourcePin:scope.pin})});
    if(scope.source==='mixed'||scope.source==='v0.2')analyses.push({source:'v0.2',
      analysis:await accountScopedQuotaAnalysis(source,scope.owner.participantId)});
    if(analyses.some(a=>!validCompleteScalarAnalysis(a.analysis,a.source,
      a.source==='v1.1'?v11CompletedFingerprint??scope.pin.fingerprint:scope.pin.fingerprint,
      !(scope.source==='v1'&&a.source==='v1'))))throw fail();
    payload=canonicalJson(selectCommunityAllowanceAnalysisFits(scope.owner.ownerDigest,analyses));
  } else {
    let composition:V1ModelCompositionResult | null=null;
    if('source' in scope.pin){
      const next=await computeV11('model',scope.pin);if(next.state==='deferred')return next;
      composition=next.analysis as V1ModelCompositionResult;
    }
    else {
      const window=modelHistoryWindow(scope.day);
      const overlap=scope.source==='mixed'?await source.prepare(`SELECT 1 FROM telemetry_records r
        WHERE r.participant_id=? AND r.record_kind='quota' AND r.provider='openai_codex' AND r.limit_id='codex'
          AND r.observed_at>=? AND r.observed_at<? AND EXISTS(SELECT 1 FROM telemetry_contribution_occurrences o
            JOIN telemetry_contributions c ON c.id=o.contribution_id WHERE o.participant_id=r.participant_id
              AND o.record_kind=r.record_kind AND o.occurrence_id=r.occurrence_id AND c.status='accepted'
              AND c.transport_schema_version='telemetry-contribution-v0.2') LIMIT 1`)
        .bind(scope.owner.participantId,window.observedAtCutoff,window.observedAtBefore).first():null;
      if(scope.source==='v0.2'||overlap)payload=canonicalJson({status:'unsupported_source',reason:'legacy_source_overlap'});
      else {
        // Durable intent precedes the direct read. If its response is lost or
        // execution fails, a retry takes the resumable reader instead of
        // repeating an oversized SQL reduction indefinitely.
        const executionAttemptDigest=await sha256Hex(canonicalJson([
          scope.dependencyDigest,STORAGE_GRAPH_DIRECT_HISTORY_READER_REVISION]));
        const attempt=await bindings.target.prepare(`INSERT INTO analytics_community_graph_execution
          VALUES(?,?,?,?,'checkpoint') ON CONFLICT(source_id,owner_digest,day) DO UPDATE SET
          dependency_digest=excluded.dependency_digest WHERE dependency_digest!=excluded.dependency_digest`)
          .bind(bindings.sourceId,scope.owner.ownerDigest,scope.day,executionAttemptDigest).run();
        if(attempt.meta.changes===1) {
          try {composition=await accountScopedHistoricalModelCompositionV1(source,
            scope.owner.participantId,scope.day,{sourcePin:scope.pin});}
          catch(error) {
            const failure=caughtStorageGraphFailureFields('graph_history_direct_read',error);
            return {state:'deferred',reason:'direct_read_unavailable',...(failure?{failure}:{})};
          }
        }
        else {
          const key:StorageHistoryKey={sourceId:bindings.sourceId,sourceNamespace:bindings.sourceNamespace,
            ownerDigest:scope.owner.ownerDigest,day:scope.day,dependencyDigest:scope.dependencyDigest,
            method:STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD};
          let cursor:StorageHistoryLoadCursor|undefined;
          let head:string|null=null;
          let checkpoint:StorageV1HistoryCheckpoint|undefined;
          for(;;) {
            if(meter.remainingQueries<50||now()>=checkpointWorkDeadlineMs)
              return {state:'deferred',reason:'checkpoint_read_budget'};
            const loaded=await withStorageGraphFailureStage('graph_checkpoint_load',
              ()=>loadStorageHistoryCheckpoint({target:bindings.target,key,cursor}));
            if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
            head=loaded.headDigest??null;
            if(loaded.status==='ready'){
              if('source'in loaded.checkpoint)throw fail();checkpoint=loaded.checkpoint;
            }
            cursor=undefined;
            break;
          }
          const pin=scope.pin;
          const advance=(savedCheckpoint:typeof checkpoint,maxPages:number)=>advanceStorageV1HistoricalAnalysis({
            source,participantId:scope.owner.participantId,day:scope.day,sourcePin:pin,
            checkpoint:savedCheckpoint,maxPages,budget:{remainingQueries:Math.max(0,meter.remainingQueries-40),
              deadlineMs:checkpointWorkDeadlineMs,now}});
          const next=await advance(checkpoint,STORAGE_GRAPH_CHECKPOINT_PAGES_PER_CLAIM);
          if(next.status==='complete')composition=next.analysis;
          else {
            if(!next.checkpoint)return {state:'deferred',reason:'historical_checkpoint'};
            const saved=await persistCheckpoint(key,next.checkpoint,head,'historical_checkpoint');
            if(saved.state==='deferred')return saved;
            if(saved.head===head)return {state:'deferred',reason:'historical_checkpoint'};
            if(next.checkpoint.phase==='finish'){
              const finished=await advance(next.checkpoint,1);
              if(finished.status==='complete')composition=finished.analysis;
            }
          }
          if(composition===null)return {state:'deferred',reason:'historical_checkpoint'};
        }
      }
    }
    const method=scope.source==='v1.1'?V11_PLAN_ATTRIBUTION_ADAPTER_VERSION:MODEL_HISTORY_METHOD_VERSION;
    if(composition!==null) {
      const completedFingerprint=scope.source==='v1.1'?v11CompletedFingerprint:scope.pin.fingerprint;
      if(!completedFingerprint||!validCompleteCachedComposition(composition,completedFingerprint,method))throw fail();
      payload=canonicalJson(composition);
    }
  }
  if(!payload)throw fail();
  const payloadFingerprint=scope.source==='v1.1'?v11CompletedFingerprint:scope.pin.fingerprint;
  if(!payloadFingerprint)throw fail();
  if(new TextEncoder().encode(payload).byteLength>MAX_RESULT_BYTES)return {state:'deferred',reason:'result_size_limit'};
  if(!await current(source,scope))return {state:'deferred',reason:'authority_changed'};
  await targetReady(bindings.target,scope);
  const hash=await sha256Hex(payload);
  await bindings.target.prepare(`INSERT INTO analytics_community_graph_results
    (source_id,owner_digest,metric,day,method,dependency_digest,input_revision,payload_fingerprint,
      payload_json,payload_sha256,authority_json,computed_ms,source_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,owner_digest,metric,day) DO UPDATE SET method=excluded.method,
      dependency_digest=excluded.dependency_digest,input_revision=excluded.input_revision,
      payload_fingerprint=excluded.payload_fingerprint,payload_json=excluded.payload_json,
      payload_sha256=excluded.payload_sha256,authority_json=excluded.authority_json,computed_ms=excluded.computed_ms,
      source_kind=excluded.source_kind
    WHERE excluded.input_revision>=analytics_community_graph_results.input_revision`)
    .bind(bindings.sourceId,scope.owner.ownerDigest,scope.metric,scope.day,STORAGE_GRAPH_METHOD,
      scope.dependencyDigest,scope.owner.inputRevision,payloadFingerprint,payload,hash,
      canonicalJson(scope.authority),Date.now(),scope.source).run();
  const result=await readStorageGraphResult(bindings,scope);
  return result?{state:'complete',result,reused:false}:{state:'deferred',reason:'source_changed'};
}
