import { createD1InvocationBudget, D1InvocationBudgetExceededError,
  type D1InvocationBudget } from './d1-invocation-budget';

export const ANALYTICS_WORK_CONTRACT = 'analytics-partition-work-v1' as const;
export type AnalyticsWorkStage = 'canonical' | 'features' | 'activity' | 'fits' | 'cache' | 'publication' | 'cleanup';
export type AnalyticsWorkDegree = 1 | 2 | 4 | 8;
export type AnalyticsWorkLane = 'withdrawal'|'new'|'recovery'|'history';
export interface AnalyticsWorkRequest {
  readonly sourceId:string;
  /** Erasure/fairness metadata only; it is not the scheduling hierarchy. */
  readonly ownerDigest:string|null;
  readonly stage:AnalyticsWorkStage;readonly lane:AnalyticsWorkLane;
  readonly partitionKey:string;readonly headKey:string;
  readonly inputRevision:string;readonly policyRevision:string;
  readonly day:string|null;readonly stream:'usage'|'quota'|'session'|null;
  readonly selectionMethod:'effective-union-v1'|'legacy-selected-v1'|null;
  readonly residentBytes:number;readonly admissionQueries:number;
}
export interface AnalyticsStoredWork extends AnalyticsWorkRequest {readonly workKey:string;readonly attempts:number}
export interface AnalyticsPartitionEstimate {
  readonly partitionKey: string;
  readonly rows: number;
  readonly bytes: number;
}
/** Group already split logical partitions without introducing an owner/device
 * job hierarchy. The artifact's writer remains responsible for exact limits. */
export function groupAnalyticsPartitions(partitions: readonly AnalyticsPartitionEstimate[],
  limits: { maxPartitions: number; maxRows: number; maxBytes: number }): readonly (readonly AnalyticsPartitionEstimate[])[] {
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!integer(limits.maxPartitions) || limits.maxPartitions < 1 || limits.maxPartitions > 16
    || !integer(limits.maxRows) || limits.maxRows < 1 || !integer(limits.maxBytes) || limits.maxBytes < 1
    || partitions.length > 128 || new Set(partitions.map(p => p.partitionKey)).size !== partitions.length) throw invalid();
  const groups: AnalyticsPartitionEstimate[][] = [];
  let group: AnalyticsPartitionEstimate[] = [], rows = 0, bytes = 0;
  for (const p of partitions) {
    if (typeof p.partitionKey !== 'string' || !p.partitionKey || p.partitionKey.length > 256
      || !integer(p.rows) || !integer(p.bytes) || p.rows > limits.maxRows || p.bytes > limits.maxBytes) throw invalid();
    if (group.length && (group.length === limits.maxPartitions || rows + p.rows > limits.maxRows
      || bytes + p.bytes > limits.maxBytes)) { groups.push(group); group = []; rows = 0; bytes = 0; }
    group.push(Object.freeze({ ...p })); rows += p.rows; bytes += p.bytes;
  }
  if (group.length) groups.push(group);
  return Object.freeze(groups.map(g => Object.freeze(g)));
}
export interface AnalyticsWorkLease {
  readonly contract: typeof ANALYTICS_WORK_CONTRACT;
  readonly workKey: string;
  /** Equal head keys serialize even when the partition computations differ. */
  readonly headKey: string;
  readonly claimToken: string;
  readonly revision: number;
  readonly stage: AnalyticsWorkStage;
  readonly residentBytes: number;
  readonly admissionQueries: number;
  readonly expiresAtMs: number;
}
export interface AnalyticsWorkExecutionBudget {
  /** Wrap every carried database through this meter and the invocation meter. */
  readonly meter: D1InvocationBudget;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly remainingQueries: () => number;
}
export type AnalyticsWorkOutcome = 'complete' | 'deferred' | 'refused';
export interface AnalyticsWorkDispatcherInput {
  readonly degree: AnalyticsWorkDegree;
  readonly maxResidentBytes: number;
  readonly invocation: D1InvocationBudget;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly releaseQueries: number;
  /** P8 supplies the sole durable claim/CAS policy. No independent queue here. */
  readonly claim: (limit: number) => Promise<readonly AnalyticsWorkLease[]>;
  readonly execute: (lease: AnalyticsWorkLease, budget: AnalyticsWorkExecutionBudget) => Promise<AnalyticsWorkOutcome>;
  /** Must use lease token/revision CAS; killed execution recovers by expiry. */
  readonly release: (lease: AnalyticsWorkLease, outcome: AnalyticsWorkOutcome | 'failure' | 'not_admitted') => Promise<void>;
}
export interface AnalyticsWorkDispatchProgress {
  readonly claimed: number; readonly admitted: number; readonly complete: number;
  readonly deferred: number; readonly refused: number; readonly failed: number;
  readonly releaseDeferred: number; readonly statements: number;
}
const invalid = () => new Error('ANALYTICS_WORK_CONTRACT_INVALID');
function validLease(lease: AnalyticsWorkLease): boolean {
  return !!lease && Object.keys(lease).sort().join(',') ===
    'admissionQueries,claimToken,contract,expiresAtMs,headKey,residentBytes,revision,stage,workKey'
    && lease.contract === ANALYTICS_WORK_CONTRACT
    && /^[0-9a-f]{64}$/u.test(lease.workKey) && /^[0-9a-f]{64}$/u.test(lease.headKey)
    && typeof lease.claimToken === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(lease.claimToken)
    && Number.isSafeInteger(lease.revision) && lease.revision > 0
    && ['canonical','features','activity','fits','cache','publication','cleanup'].includes(lease.stage)
    && Number.isSafeInteger(lease.residentBytes) && lease.residentBytes >= 0
    && Number.isSafeInteger(lease.admissionQueries) && lease.admissionQueries > 0
    && Number.isSafeInteger(lease.expiresAtMs) && lease.expiresAtMs >= 0;
}
/** A bounded cooperative dispatch wave. Concurrent jobs have independent phase
 * limits but every actual statement still charges the same invocation. This
 * does not imply that a single D1 primary executes SQL in parallel. */
export async function dispatchAnalyticsWork(input: AnalyticsWorkDispatcherInput): Promise<AnalyticsWorkDispatchProgress> {
  if (![1,2,4,8].includes(input.degree) || !Number.isSafeInteger(input.maxResidentBytes)
    || input.maxResidentBytes < 1 || input.maxResidentBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(input.releaseQueries) || input.releaseQueries < 1 || input.releaseQueries > 16
    || !Number.isFinite(input.deadlineMs)) throw invalid();
  const started = input.invocation.queriesUsed;
  const counts = { claimed: 0, admitted: 0, complete: 0, deferred: 0, refused: 0, failed: 0, releaseDeferred: 0 };
  const done = () => Object.freeze({ ...counts, statements: input.invocation.queriesUsed - started });
  if (input.now() >= input.deadlineMs || input.invocation.remainingQueries <= input.releaseQueries * input.degree) return done();
  const leases = await input.claim(input.degree);
  if (leases.length > input.degree || leases.some(lease => !validLease(lease))
    || new Set(leases.map(lease => lease.workKey)).size !== leases.length) throw invalid();
  counts.claimed = leases.length;
  if (!leases.length) return done();
  const reserve = input.invocation.reserveQueries;
  const releaseReserve = leases.length * input.releaseQueries;
  // A claim may consume its admission allowance. If final release no longer
  // fits, do no work; durable leases remain discoverable after expiry.
  if (input.invocation.remainingQueries < releaseReserve) {
    counts.deferred = leases.length; counts.releaseDeferred = leases.length; return done();
  }
  input.invocation.reserveQueries = reserve + releaseReserve;
  const admitted: AnalyticsWorkLease[] = [], outcomes = new Map<string, AnalyticsWorkOutcome | 'failure' | 'not_admitted'>();
  const heads = new Set<string>();
  let bytes = 0, admission = 0;
  for (const lease of leases) {
    if (input.now() >= Math.min(input.deadlineMs, lease.expiresAtMs)
      || heads.has(lease.headKey) || bytes + lease.residentBytes > input.maxResidentBytes
      || admission + lease.admissionQueries > input.invocation.remainingQueries) {
      counts.deferred++; outcomes.set(lease.workKey, 'not_admitted'); continue;
    }
    admitted.push(lease); heads.add(lease.headKey); bytes += lease.residentBytes; admission += lease.admissionQueries;
  }
  counts.admitted = admitted.length;
  try {
    const extra = admitted.length ? Math.floor((input.invocation.remainingQueries - admission) / admitted.length) : 0;
    await Promise.all(admitted.map(async lease => {
      const meter = createD1InvocationBudget(lease.admissionQueries + extra);
      try {
        const outcome = await input.execute(lease, { meter, deadlineMs: Math.min(input.deadlineMs, lease.expiresAtMs),
          now: input.now, remainingQueries: () => Math.max(0, Math.min(meter.remainingQueries, input.invocation.remainingQueries)) });
        if (!['complete','deferred','refused'].includes(outcome)) throw invalid();
        outcomes.set(lease.workKey, outcome); counts[outcome]++;
      } catch (error) {
        const budget = error instanceof D1InvocationBudgetExceededError;
        outcomes.set(lease.workKey, budget ? 'deferred' : 'failure');
        if (budget) counts.deferred++; else counts.failed++;
      }
    }));
    for (const lease of leases) {
      input.invocation.reserveQueries -= input.releaseQueries;
      try { await input.release(lease, outcomes.get(lease.workKey) ?? 'not_admitted'); }
      catch { counts.releaseDeferred++; }
    }
  } finally { input.invocation.reserveQueries = reserve; }
  return done();
}

export const ANALYTICS_FEATURE_GROUP_LIMITS = Object.freeze({members:8,facts:16,scopes:4,
  residentBytes:32*1024*1024,computeQueries:600,releaseQueries:2});
/** Measured activity adoption includes every original part and completion CAS. */
export const ANALYTICS_ACTIVITY_GROUP_LIMITS=Object.freeze({...ANALYTICS_FEATURE_GROUP_LIMITS,computeQueries:850});
/** Conservative cache bound; the concrete group retains one exact input scope. */
export const ANALYTICS_CACHE_GROUP_LIMITS=Object.freeze({...ANALYTICS_FEATURE_GROUP_LIMITS,scopes:1,computeQueries:850});
export interface AnalyticsFeatureGroupEstimate {
  readonly workKey:string;readonly headKey:string;readonly stage:AnalyticsWorkStage;
  readonly sourceId:string;readonly policyRevision:string;readonly day:string|null;
  readonly stream:string|null;readonly selectionMethod:string|null;readonly partitionKey:string;
  readonly residentBytes:number;
  readonly refs:readonly {occurrenceKey:string;revision:string}[];
  /** Exact source/owner/day/stream/selection tuples, serialized by the caller. */
  readonly scopeKeys:readonly string[];
}
/** Select in claim order. An excluded leaf stays independently discoverable;
 * a hot first leaf cannot prevent later compatible sparse leaves progressing. */
function selectAnalyticsPreparationGroup(members:readonly AnalyticsFeatureGroupEstimate[],stage:'features'|'cache'):{
  selected:readonly string[];excluded:readonly string[];facts:number;scopes:number;residentBytes:number} {
  const limits=stage==='cache'?ANALYTICS_CACHE_GROUP_LIMITS:ANALYTICS_FEATURE_GROUP_LIMITS;
  if(!Array.isArray(members)||members.length>limits.members
    ||new Set(members.map(value=>value.workKey)).size!==members.length)throw invalid();
  const selected:string[]=[],excluded:string[]=[],refs=new Set<string>(),occurrences=new Set<string>(),scopes=new Set<string>();
  const heads=new Set<string>(),partitions:string[]=[];let first:AnalyticsFeatureGroupEstimate|undefined,bytes=0;
  for(const member of members){
    if(!/^[a-f0-9]{64}$/u.test(member.workKey)||! /^[a-f0-9]{64}$/u.test(member.headKey)
      ||!Number.isSafeInteger(member.residentBytes)||member.residentBytes<0
      ||!Array.isArray(member.refs)||!Array.isArray(member.scopeKeys)
      ||member.refs.some((ref:{occurrenceKey:string;revision:string})=>! /^[a-f0-9]{64}$/u.test(ref.occurrenceKey)||! /^[a-f0-9]{64}$/u.test(ref.revision))
      ||member.scopeKeys.some((scope:string)=>typeof scope!=='string'||!scope||scope.length>1024))throw invalid();
    const compatible=member.stage===stage&&(!first||['sourceId','policyRevision','day','stream','selectionMethod']
      .every(key=>member[key as keyof AnalyticsFeatureGroupEstimate]===first![key as keyof AnalyticsFeatureGroupEstimate]));
    const nextScopes=new Set([...scopes,...member.scopeKeys]);
    const overlap=partitions.some(partition=>partition.startsWith(member.partitionKey)||member.partitionKey.startsWith(partition));
    if(!compatible||overlap||heads.has(member.headKey)
      ||new Set(member.refs.map((ref:{occurrenceKey:string;revision:string})=>ref.revision)).size!==member.refs.length
      ||new Set(member.refs.map((ref:{occurrenceKey:string;revision:string})=>ref.occurrenceKey)).size!==member.refs.length
      ||member.refs.some((ref:{occurrenceKey:string;revision:string})=>refs.has(ref.revision)||occurrences.has(ref.occurrenceKey))
      ||refs.size+member.refs.length>limits.facts
      ||nextScopes.size>limits.scopes
      ||bytes+member.residentBytes>limits.residentBytes){excluded.push(member.workKey);continue;}
    first??=member;selected.push(member.workKey);partitions.push(member.partitionKey);heads.add(member.headKey);bytes+=member.residentBytes;
    for(const ref of member.refs){refs.add(ref.revision);occurrences.add(ref.occurrenceKey);}
    for(const scope of member.scopeKeys)scopes.add(scope);
  }
  return {selected:Object.freeze(selected),excluded:Object.freeze(excluded),facts:refs.size,scopes:scopes.size,residentBytes:bytes};
}
/** Closed feature and cache selection facades preserve original claim order. */
export function selectAnalyticsFeatureGroup(members:readonly AnalyticsFeatureGroupEstimate[]) {
  return selectAnalyticsPreparationGroup(members,'features');
}
export function selectAnalyticsCacheGroup(members:readonly AnalyticsFeatureGroupEstimate[]) {
  return selectAnalyticsPreparationGroup(members,'cache');
}
export interface AnalyticsFeatureGroupMemberOutcome {readonly workKey:string;readonly outcome:AnalyticsWorkOutcome;readonly admitted:boolean}
export interface AnalyticsFeatureGroupDispatcherInput {
  readonly invocation:D1InvocationBudget;readonly deadlineMs:number;readonly now:()=>number;
  readonly claim:(limit:number)=>Promise<readonly AnalyticsWorkLease[]>;
  readonly execute:(leases:readonly AnalyticsWorkLease[],budget:AnalyticsWorkExecutionBudget)=>Promise<readonly AnalyticsFeatureGroupMemberOutcome[]>;
  readonly release:AnalyticsWorkDispatcherInput['release'];
}
/** One computation, never a larger concurrent pool. Every leaf keeps its own
 * durable claim and release; bounds and compatible subset selection belong to
 * the concrete producer after metered discovery. */
async function dispatchAnalyticsPreparationGroup(input:AnalyticsFeatureGroupDispatcherInput,stage:'features'|'activity'|'cache'):Promise<AnalyticsWorkDispatchProgress&{groupsAdmitted:number}> {
  if(!Number.isFinite(input.deadlineMs)||input.invocation.queriesUsed+input.invocation.remainingQueries+input.invocation.reserveQueries>950)throw invalid();
  const started=input.invocation.queriesUsed,counts={claimed:0,admitted:0,complete:0,deferred:0,refused:0,failed:0,releaseDeferred:0,groupsAdmitted:0};
  const done=()=>Object.freeze({...counts,statements:input.invocation.queriesUsed-started});
  const limits=stage==='activity'?ANALYTICS_ACTIVITY_GROUP_LIMITS:stage==='cache'?ANALYTICS_CACHE_GROUP_LIMITS:ANALYTICS_FEATURE_GROUP_LIMITS;
  if(input.now()>=input.deadlineMs||input.invocation.remainingQueries<limits.computeQueries+limits.releaseQueries*limits.members)return done();
  const leases=await input.claim(limits.members);
  if(leases.length>limits.members||leases.some(lease=>!validLease(lease)||lease.stage!==stage)
    ||new Set(leases.map(lease=>lease.workKey)).size!==leases.length)throw invalid();
  counts.claimed=leases.length;if(!leases.length)return done();
  const previous=input.invocation.reserveQueries,reserved=leases.length*limits.releaseQueries;
  if(input.invocation.remainingQueries<reserved){counts.deferred=leases.length;counts.releaseDeferred=leases.length;return done();}
  input.invocation.reserveQueries=previous+reserved;
  const outcomes=new Map<string,AnalyticsWorkOutcome|'failure'|'not_admitted'>();
  try{
    if(input.invocation.remainingQueries>=limits.computeQueries&&input.now()<Math.min(input.deadlineMs,...leases.map(lease=>lease.expiresAtMs))){
      const meter=createD1InvocationBudget(Math.min(950,input.invocation.remainingQueries));
      try{
        const results=await input.execute(leases,{meter,deadlineMs:Math.min(input.deadlineMs,...leases.map(lease=>lease.expiresAtMs)),now:input.now,
          remainingQueries:()=>Math.max(0,Math.min(meter.remainingQueries,input.invocation.remainingQueries))});
        if(results.length!==leases.length||new Set(results.map(result=>result.workKey)).size!==results.length
          ||results.some(result=>!leases.some(lease=>lease.workKey===result.workKey)||typeof result.admitted!=='boolean'
            ||!['complete','deferred','refused'].includes(result.outcome)))throw invalid();
        for(const result of results){outcomes.set(result.workKey,result.outcome);counts[result.outcome]++;}
        counts.admitted=results.filter(result=>result.admitted).length;counts.groupsAdmitted=counts.admitted?1:0;
      }catch(error){
        const outcome=error instanceof D1InvocationBudgetExceededError?'deferred':'failure';
        for(const lease of leases)outcomes.set(lease.workKey,outcome);
        if(outcome==='deferred')counts.deferred=leases.length;else counts.failed=leases.length;
      }
    }else counts.deferred=leases.length;
    for(const lease of leases){input.invocation.reserveQueries-=limits.releaseQueries;
      try{await input.release(lease,outcomes.get(lease.workKey)??'not_admitted');}catch{counts.releaseDeferred++;}}
  }finally{input.invocation.reserveQueries=previous;}
  return done();
}

/** Each stage retains a closed homogeneous group facade. */
export function dispatchAnalyticsFeatureGroup(input:AnalyticsFeatureGroupDispatcherInput):Promise<AnalyticsWorkDispatchProgress&{groupsAdmitted:number}> {
 return dispatchAnalyticsPreparationGroup(input,'features');
}
export function dispatchAnalyticsActivityGroup(input:AnalyticsFeatureGroupDispatcherInput):Promise<AnalyticsWorkDispatchProgress&{groupsAdmitted:number}> {
 return dispatchAnalyticsPreparationGroup(input,'activity');
}

export function dispatchAnalyticsCacheGroup(input:AnalyticsFeatureGroupDispatcherInput):Promise<AnalyticsWorkDispatchProgress&{groupsAdmitted:number}> {
 return dispatchAnalyticsPreparationGroup(input,'cache');
}
