import { canonicalLegacySourceStamp, readCanonicalLegacySourcePage, createCanonicalLegacyReadContext, canonicalLegacyReadContextCurrent,
  type CanonicalLegacyReadContext, type CanonicalSelectedOccurrence } from './canonical-analytics-legacy-source';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { D1InvocationBudgetExceededError,readD1SchemaObjectsAvailable, type D1InvocationBudget } from './d1-invocation-budget';
import { canonicalDay, canonicalDigest, canonicalFail, canonicalInteger, canonicalOccurrenceKey, canonicalSelectedOccurrenceKey,
  normalizeNativeEffectiveOccurrence, normalizeSelectedTelemetryRecord, type CanonicalEffect, type CanonicalScope } from './canonical-analytics-facts';
import { materializeCanonicalPage, type CanonicalPageUpdate } from './storage-canonical-analytics-facts';
import { readStorageCommunityOwner, type StorageCommunityOwner } from './storage-community-authority';
import { readEffectiveDependencyResumeCursor, readEffectiveScopeMutationToken, createEffectiveDependencyReadContext,
  effectiveDependencyReadContextCurrent,type EffectiveDependencyReadContext,
  type EffectiveScopeMutationScope } from './storage-effective-selective-dependencies';
import { readEffectiveTelemetryOwnerDayPage, readEffectiveUsageOwnerDayPage,
  type EffectiveTelemetryOccurrence, type EffectiveUsageOccurrence,
  type EffectiveTelemetryStream, type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';

const PAGE_SIZE = 16;
const MIN_PAGE_QUERIES = 150;
const LEASE_MS = 120_000;
export interface CanonicalInputBudget {
  /** The request's actual D1 statement meter; both bindings are wrapped here. */
  readonly meter: D1InvocationBudget;
  readonly maxSteps: number;
  readonly deadlineMs: number;
  readonly now: () => number;
}
export interface CanonicalInputScope {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly participantId: string;
  readonly day: string;
  readonly stream: EffectiveTelemetryStream;
  readonly selectionMethod: CanonicalScope['selectionMethod'];
}
export interface AdvanceCanonicalInputOptions extends CanonicalInputScope {
  readonly budget: CanonicalInputBudget;
  readonly context?: CanonicalInputReadContext;
}
export interface CanonicalInputSeal {
  readonly scopeKey: string;
  readonly sourceStamp: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly day: string;
  readonly stream: EffectiveTelemetryStream;
  readonly seenCount: number;
  readonly empty: boolean;
}
export interface CanonicalInputProgress {
  readonly state: 'progress' | 'complete' | 'deferred' | 'unavailable';
  readonly steps: number;
  readonly pages: number;
  readonly effects: readonly CanonicalEffect[];
  readonly queriesUsed: number;
  readonly seal: CanonicalInputSeal | null;
}
interface WorkRow {
  scope_key: string; source_stamp: string; owner_revision: number; authority_epoch: number;
  state: 'reading'|'draining'|'sealed'; cursor_key: string|null; cursor_ms: number|null;
  tie_rank: number; page_ordinal: number; seen_count: number; version: number;
  claim_token: string|null; claim_expires_ms: number;
}
interface PendingRow {
  scope_key: string; source_stamp: string; page_key: string; source_revision: string;
  next_key: string|null; next_ms: number|null; next_tie_rank: number;
  seen_keys_json: string; terminal: number;
}
interface HeadRow { occurrence_key:string; revision:string }
interface PageData {
  rows: readonly (EffectiveTelemetryOccurrence|EffectiveUsageOccurrence|CanonicalSelectedOccurrence)[];
  keys: readonly string[];
  nextKey: string|null; nextMs: number|null; nextTieRank: number;
  terminal: boolean;
  ranks: readonly number[];
}
const WORK_TABLES = ['analytics_canonical_input_work','analytics_canonical_input_pending','analytics_canonical_input_seen'];
const WORK_TRIGGERS = ['analytics_canonical_input_admit','analytics_canonical_input_seal',
  'analytics_canonical_input_owner_terminal','analytics_canonical_input_erasure',
  'analytics_canonical_input_owner_delete'];
function validateScope(scope:CanonicalInputScope):void {
  canonicalDigest(scope.ownerDigest); canonicalDay(scope.day);
  if(!['effective-union-v1','legacy-selected-v1'].includes(scope.selectionMethod)||!['usage','quota','session'].includes(scope.stream)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(scope.sourceId)
    || !scope.sourceNamespace || scope.sourceNamespace.length>256
    || !scope.participantId || scope.participantId.length>256)canonicalFail();
}
function mutationScope(scope:CanonicalInputScope):EffectiveScopeMutationScope {
  return {sourceId:scope.sourceId,sourceNamespace:scope.sourceNamespace,ownerDigest:scope.ownerDigest,
    participantId:scope.participantId,fromDay:scope.day,throughDay:scope.day,includeSessions:scope.stream==='session'};
}
async function scopeKey(scope:CanonicalInputScope):Promise<string> {
  return sha256Hex(canonicalJson(['canonical-input-v1',scope.sourceId,scope.sourceNamespace,
    scope.ownerDigest,scope.selectionMethod,scope.stream,scope.day]));
}
async function schemaAvailable(target:D1Database):Promise<boolean> {
  return readD1SchemaObjectsAvailable(target,[...WORK_TABLES.map(name=>['table',name] as const),
    ...WORK_TRIGGERS.map(name=>['trigger',name] as const)]);
}
declare const canonicalInputReadContextBrand:unique symbol;
export interface CanonicalInputReadContext {readonly [canonicalInputReadContextBrand]:true}
interface InputReadContextState {
 source:D1Database;target:D1Database;owner:StorageCommunityOwner;identity:string;scopes:Set<string>;
 selective:EffectiveDependencyReadContext;expiresMs:number;
 legacy:Map<string,CanonicalLegacyReadContext>;tokens:Map<string,{stamp:string;validUntilMs:number}>;
}
const inputReadContexts=new WeakMap<CanonicalInputReadContext,InputReadContextState>();
function contextIdentity(scope:CanonicalInputScope):string {
 return canonicalJson([scope.sourceId,scope.sourceNamespace,scope.ownerDigest,scope.participantId,scope.selectionMethod]);
}
function contextScope(scope:CanonicalInputScope):string{return canonicalJson([scope.day,scope.stream]);}
function inputContext(source:D1Database,target:D1Database|undefined,scope:CanonicalInputScope,
 context:CanonicalInputReadContext):InputReadContextState|null {
 const state=inputReadContexts.get(context);
 return state&&state.source===source&&(target===undefined||state.target===target)&&state.identity===contextIdentity(scope)
  &&state.scopes.has(contextScope(scope))&&Date.now()<state.expiresMs?state:null;
}
async function contextCurrent(state:InputReadContextState,capabilities=false):Promise<boolean> {
 if(Date.now()>=state.expiresMs||!await effectiveDependencyReadContextCurrent(state.source,state.selective,capabilities))return false;
 const owner=await readStorageCommunityOwner(state.source,{ownerDigest:state.owner.ownerDigest!});
 // Includes input revision, selected family, owner revision and terminal epoch.
 // A mutation, even outside the scope, ends this invocation proof. A later
 // invocation can retain the unchanged narrow native/selective identities.
 return !!owner&&canonicalJson(owner)===canonicalJson(state.owner)&&Date.now()<state.expiresMs;
}
export async function createCanonicalInputReadContext(source:D1Database,target:D1Database,
 scopes:readonly CanonicalInputScope[],deadlineMs:number):Promise<CanonicalInputReadContext|null> {
 if(!Array.isArray(scopes)||scopes.length<1||scopes.length>132)return null;
 for(const scope of scopes)validateScope(scope);
 const first=scopes[0]!;
 if(scopes.some(scope=>contextIdentity(scope)!==contextIdentity(first))||!await schemaAvailable(target))return null;
 const owner=await readStorageCommunityOwner(source,{ownerDigest:first.ownerDigest});
 if(!owner||owner.participantId!==first.participantId||owner.ownerRevision<1||owner.authorityEpoch<1)return null;
 const selective=await createEffectiveDependencyReadContext(source,{sourceId:first.sourceId,sourceNamespace:first.sourceNamespace,
  participantId:first.participantId,ownerDigest:first.ownerDigest},scopes.map(scope=>({fromDay:scope.day,throughDay:scope.day,
   includeSessions:scope.stream==='session'})),deadlineMs,first.selectionMethod==='legacy-selected-v1'&&!owner.hasV11?'typed-v1-analysis':undefined);
 if(!selective)return null;
 const state:InputReadContextState={source,target,owner,identity:contextIdentity(first),
  scopes:new Set(scopes.map(contextScope)),selective,expiresMs:deadlineMs,legacy:new Map(),tokens:new Map()};
 if(!await contextCurrent(state,true))return null;
 const context=Object.freeze({}) as CanonicalInputReadContext;
 inputReadContexts.set(context,state);return context;
}
/** Validate a held invocation without exposing its source proof. Intermediate
 * immutable preparation may use cheap guards; its consumer must request the
 * full capability proof before returning or promoting a completed value. */
export async function canonicalInputReadContextCurrent(source:D1Database,target:D1Database,
 scope:CanonicalInputScope,context:CanonicalInputReadContext,capabilities=true):Promise<boolean> {
 const state=inputContext(source,target,scope,context);if(!state)return false;
 if(capabilities&&!await schemaAvailable(target))return false;
 const pin=await currentPin(source,target,scope,context);if(!pin)return false;
 const token=await contextToken(state,scope);
 return !!token&&await sourceProof(source,scope,pin,token.stamp,context,capabilities);
}
/** End the invocation explicitly; an old caller-held handle cannot renew it. */
export function closeCanonicalInputReadContext(context:CanonicalInputReadContext):void {
 inputReadContexts.delete(context);
}
async function contextLegacy(state:InputReadContextState,scope:CanonicalInputScope):Promise<CanonicalLegacyReadContext> {
 let legacy=state.legacy.get(scope.day);
 if(!legacy){legacy=await createCanonicalLegacyReadContext(state.source,scope,()=>contextCurrent(state),state.expiresMs)??undefined;
  if(!legacy)canonicalFail('CANONICAL_UNAVAILABLE');state.legacy.set(scope.day,legacy);}
 return legacy;
}
async function contextToken(state:InputReadContextState,scope:CanonicalInputScope):Promise<{stamp:string;validUntilMs:number}|undefined> {
 const key=contextScope(scope),old=state.tokens.get(key);if(old)return old;
 const token=await readEffectiveScopeMutationToken(state.source,mutationScope(scope),state.selective);if(!token)return;
 const value=scope.selectionMethod==='effective-union-v1'?token:{...token,
  stamp:await canonicalLegacySourceStamp(state.source,scope,token.stamp,await contextLegacy(state,scope))};
 state.tokens.set(key,value);return value;
}
async function currentPin(source:D1Database,target:D1Database,scope:CanonicalInputScope,context?:CanonicalInputReadContext):Promise<{
  ownerRevision:number;authorityEpoch:number;
}|null> {
  const state=context?inputContext(source,target,scope,context):null;
  // Every caller follows this target pin with sourceToken/sourceProof. Those
  // recheck the exact source capability/owner snapshot immediately; avoid
  // duplicating that same source query pair here.
  if(context&&!state)return null;
  const owner=state?.owner??await readStorageCommunityOwner(source,{ownerDigest:scope.ownerDigest});
  if(!owner||owner.ownerDigest!==scope.ownerDigest||owner.participantId!==scope.participantId
    ||owner.ownerRevision<1||owner.authorityEpoch<1)return null;
  const ready=await target.prepare(`SELECT 1 ready FROM analytics_owner_state o JOIN analytics_runtime_sources s
    ON s.source_id=o.source_id WHERE o.source_id=? AND o.owner_digest=? AND o.revision=?
    AND o.authority_epoch=? AND o.state='active' AND s.source_namespace=? AND s.contract_version=1
    AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
      WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
    .bind(scope.sourceId,scope.ownerDigest,owner.ownerRevision,owner.authorityEpoch,scope.sourceNamespace)
    .first<number>('ready');
  return ready===1?{ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch}:null;
}
async function sourceToken(source:D1Database,scope:CanonicalInputScope,context?:CanonicalInputReadContext):Promise<{stamp:string;validUntilMs:number}|undefined> {
  if(context){const state=inputContext(source,undefined,scope,context);
    return state&&await contextCurrent(state)?contextToken(state,scope):undefined;}
  const token=await readEffectiveScopeMutationToken(source,mutationScope(scope));
  if(!token||scope.selectionMethod==='effective-union-v1')return token;
  return {...token,stamp:await canonicalLegacySourceStamp(source,scope,token.stamp)};
}
async function sourceProof(source:D1Database,scope:CanonicalInputScope,pin:{ownerRevision:number;authorityEpoch:number},
  stamp:string,context?:CanonicalInputReadContext,capabilities=false):Promise<boolean> {
  if(context){const state=inputContext(source,undefined,scope,context);
    if(!state||state.owner.ownerRevision!==pin.ownerRevision||state.owner.authorityEpoch!==pin.authorityEpoch
      ||!await contextCurrent(state,capabilities))return false;
    const token=await contextToken(state,scope);
    if(capabilities&&scope.selectionMethod==='legacy-selected-v1'
      &&!await canonicalLegacyReadContextCurrent(source,scope,await contextLegacy(state,scope)))return false;
    return !!token&&token.stamp===stamp&&token.validUntilMs>Date.now();}
  const token=await sourceToken(source,scope);
  if(!token||token.stamp!==stamp||token.validUntilMs<=Date.now())return false;
  const owner=await readStorageCommunityOwner(source,{ownerDigest:scope.ownerDigest});
  return owner?.participantId===scope.participantId&&owner.ownerRevision===pin.ownerRevision
    &&owner.authorityEpoch===pin.authorityEpoch;
}
async function readWork(target:D1Database,key:string):Promise<WorkRow|null> {
  return await target.prepare('SELECT * FROM analytics_canonical_input_work WHERE scope_key=?').bind(key).first<WorkRow>()??null;
}
function canStep(budget:CanonicalInputBudget):boolean {
  return budget.meter.remainingQueries>=MIN_PAGE_QUERIES && budget.now()<budget.deadlineMs-2_000;
}
function candidateMs(row:EffectiveTelemetryOccurrence|EffectiveUsageOccurrence|CanonicalSelectedOccurrence,day:string):number {
  if(!row.canonicalEvidence||row.canonicalEvidence.variants.length===0)canonicalFail('CANONICAL_UNAVAILABLE');
  const times=row.canonicalEvidence.variants.map(variant=>variant.observedAtMs)
    .filter(time=>Number.isSafeInteger(time)&&Number.isFinite(new Date(time).valueOf())
      &&new Date(time).toISOString().slice(0,10)===day);
  if(!times.length)canonicalFail('CANONICAL_UNAVAILABLE');
  return Math.min(...times);
}
async function readPage(source:D1Database,scope:CanonicalInputScope,pin:{ownerRevision:number;authorityEpoch:number},
  work:WorkRow,context?:CanonicalInputReadContext):Promise<PageData> {
  const state=context?inputContext(source,undefined,scope,context):null;
  if(context&&(!state||!await contextCurrent(state)))canonicalFail('CANONICAL_UNAVAILABLE');
  let after:EffectiveUsageReaderCursor|undefined;
  if(work.cursor_key!==null) {
    const resolved=await readEffectiveDependencyResumeCursor(source,mutationScope(scope),scope.stream,
      work.cursor_key,work.cursor_ms!,state?.selective);
    if(!resolved)canonicalFail('CANONICAL_UNAVAILABLE');
    after=resolved;
  }
  const readerInput={sourceNamespace:scope.sourceNamespace,ownerDigest:scope.ownerDigest,
    ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,day:scope.day,after,limit:PAGE_SIZE};
  const page=scope.selectionMethod==='legacy-selected-v1'
    ?await readCanonicalLegacySourcePage(source,scope,after,PAGE_SIZE,state?await contextLegacy(state,scope):undefined)
    :scope.stream==='usage'
    ?await readEffectiveUsageOwnerDayPage(source,readerInput)
    :await readEffectiveTelemetryOwnerDayPage(source,{...readerInput,stream:scope.stream});
  if(page.participantId!==scope.participantId||page.ownerDigest!==scope.ownerDigest
    ||page.day!==scope.day||page.rows.length>PAGE_SIZE)canonicalFail('CANONICAL_CONFLICT');
  const keys:string[]=[],logicalKeys:string[]=[],ranks:number[]=[];
  let time=work.cursor_ms,rank=work.tie_rank;
  for(const row of page.rows) {
    const nextTime=candidateMs(row,scope.day);
    if(time!==null&&nextTime<time)canonicalFail('CANONICAL_CONFLICT');
    rank=time===nextTime?rank+1:0;
    time=nextTime;
    ranks.push(row.eventTime===null?0:rank);
    const canonicalScope={sourceNamespace:scope.sourceNamespace,ownerDigest:scope.ownerDigest,selectionMethod:scope.selectionMethod};
    logicalKeys.push(await canonicalOccurrenceKey(canonicalScope,scope.stream,row.occurrenceId));
    keys.push('selection' in row?await canonicalSelectedOccurrenceKey(canonicalScope,scope.stream,row.occurrenceId,row.selectedSlotKey)
      :logicalKeys.at(-1)!);
  }
  if(new Set(keys).size!==keys.length)canonicalFail('CANONICAL_CONFLICT');
  if(page.next!==null&&page.rows.length===0)canonicalFail('CANONICAL_CONFLICT');
  if(page.next!==null && (page.next.observedAtMs!==time
    ||page.next.occurrenceId!==page.rows.at(-1)?.occurrenceId))canonicalFail('CANONICAL_CONFLICT');
  return {rows:page.rows,keys,nextKey:logicalKeys.at(-1)??work.cursor_key,nextMs:time,
    nextTieRank:rank,terminal:page.rows.length===0,ranks};
}
async function readHeads(target:D1Database,keys:readonly string[],method:CanonicalScope['selectionMethod']):Promise<Map<string,string>> {
  if(!keys.length)return new Map();
  const rows=(await target.prepare(`SELECT occurrence_key,revision FROM analytics_canonical_heads
    WHERE selection_method=? AND occurrence_key IN(SELECT value FROM json_each(?))`)
    .bind(method,JSON.stringify(keys)).all<HeadRow>()).results;
  return new Map(rows.map(row=>[row.occurrence_key,row.revision]));
}
async function pageUpdates(target:D1Database,scope:CanonicalInputScope,data:PageData):Promise<CanonicalPageUpdate[]> {
  const current=await readHeads(target,data.keys,scope.selectionMethod);
  const canonicalScope:CanonicalScope={sourceNamespace:scope.sourceNamespace,ownerDigest:scope.ownerDigest,
    selectionMethod:scope.selectionMethod};
  const updates:CanonicalPageUpdate[]=[];
  for(let i=0;i<data.rows.length;i++) {
    const row=data.rows[i]!;
    const fact='selection' in row?await normalizeSelectedTelemetryRecord(canonicalScope,{stream:row.stream,
      occurrenceId:row.occurrenceId,eventTime:row.eventTime,recordJson:row.recordJson,evidence:row.canonicalEvidence,nativeOrder:data.ranks[i]!,
      selectedSlotKey:row.selectedSlotKey,sourceFamily:row.sourceFamily,occurrenceTieOrder:row.occurrenceTieOrder??data.ranks[i]!})
      :await normalizeNativeEffectiveOccurrence(canonicalScope,row,data.ranks[i]!);
    updates.push({occurrenceKey:data.keys[i]!,stream:scope.stream,
      expectedRevision:current.get(data.keys[i]!)??null,fact});
  }
  return updates;
}
async function insertPending(target:D1Database,key:string,claim:string,work:WorkRow,pending:PendingRow,nowMs:number):Promise<boolean> {
  const result=await target.prepare(`INSERT INTO analytics_canonical_input_pending
    (scope_key,source_stamp,page_key,source_revision,next_key,next_ms,next_tie_rank,seen_keys_json,terminal)
    SELECT scope_key,?,?,?,?,?,?,?,? FROM analytics_canonical_input_work
    WHERE scope_key=? AND source_stamp=? AND version=? AND claim_token=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000 AND state='reading'
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_pending WHERE scope_key=?)`)
    .bind(pending.source_stamp,pending.page_key,pending.source_revision,pending.next_key,pending.next_ms,
      pending.next_tie_rank,pending.seen_keys_json,pending.terminal,key,work.source_stamp,work.version,claim,nowMs,key).run();
  return result.meta.changes===1;
}
async function finishPending(target:D1Database,key:string,claim:string,work:WorkRow,pending:PendingRow,
  changeKey:string,nowMs:number):Promise<boolean> {
  const nextVersion=work.version+1;
  const results=await target.batch([
    target.prepare(`UPDATE analytics_canonical_input_work SET cursor_key=?,cursor_ms=?,tie_rank=?,page_ordinal=page_ordinal+1,
      state=?,version=version+1 WHERE scope_key=? AND source_stamp=? AND version=? AND claim_token=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000
      AND EXISTS(SELECT 1 FROM analytics_canonical_input_pending p JOIN analytics_canonical_pages c
        ON c.change_key=? AND c.state='complete' WHERE p.scope_key=? AND p.page_key=? AND p.source_stamp=?)`)
      .bind(pending.next_key,pending.next_ms,pending.next_tie_rank,pending.terminal===1?'draining':'reading',
        key,work.source_stamp,work.version,claim,nowMs,changeKey,key,pending.page_key,pending.source_stamp),
    target.prepare(`INSERT INTO analytics_canonical_input_seen(scope_key,occurrence_key)
      SELECT ?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM analytics_canonical_input_work
      WHERE scope_key=? AND claim_token=? AND version=?) ON CONFLICT(scope_key,occurrence_key) DO NOTHING`)
      .bind(key,pending.seen_keys_json,key,claim,nextVersion),
    target.prepare(`UPDATE analytics_canonical_input_work SET seen_count=(SELECT count(*)
      FROM analytics_canonical_input_seen WHERE scope_key=?) WHERE scope_key=? AND claim_token=? AND version=?`)
      .bind(key,key,claim,nextVersion),
    target.prepare(`DELETE FROM analytics_canonical_input_pending WHERE scope_key=? AND page_key=?
      AND EXISTS(SELECT 1 FROM analytics_canonical_input_work WHERE scope_key=? AND claim_token=? AND version=?)`)
      .bind(key,pending.page_key,key,claim,nextVersion),
  ]);
  return results[0]!.meta.changes===1;
}
async function staleHeads(target:D1Database,scope:CanonicalInputScope,key:string):Promise<HeadRow[]> {
  return (await target.prepare(`SELECT h.occurrence_key,h.revision FROM analytics_canonical_heads h
    JOIN analytics_canonical_facts f ON f.revision=h.revision
    JOIN analytics_canonical_days d ON d.revision=f.revision AND d.day=?
    WHERE f.source_id=? AND f.owner_digest=? AND f.selection_method=? AND f.stream=?
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_seen s
        WHERE s.scope_key=? AND s.occurrence_key=h.occurrence_key)
    ORDER BY h.occurrence_key LIMIT ?`).bind(scope.day,scope.sourceId,scope.ownerDigest,
      scope.selectionMethod,scope.stream,key,PAGE_SIZE).all<HeadRow>()).results;
}
function sealFrom(work:WorkRow):CanonicalInputSeal {
  return {scopeKey:work.scope_key,sourceStamp:work.source_stamp,ownerRevision:work.owner_revision,
    authorityEpoch:work.authority_epoch,day:'',stream:'usage',seenCount:work.seen_count,empty:work.seen_count===0};
}
/** A seal is usable only while the source mutation proof and both owner pins still
 * match. A retained target row alone never proves completed or empty input. */
export async function readCanonicalInputSeal(source:D1Database,target:D1Database,
  scope:CanonicalInputScope,context?:CanonicalInputReadContext):Promise<CanonicalInputSeal|null> {
  return readInputSeal(source,target,scope,context,true);
}
/** Private immutable preparation only. The held context proves initial schema
 * capability; fresh generation, owner, clock, target pins and inventory remain
 * mandatory. The bounded consumer must take a full final context fence before
 * returning a checkpoint or completed value. */
export async function readCanonicalInputPreparationSeal(source:D1Database,target:D1Database,
  scope:CanonicalInputScope,context:CanonicalInputReadContext):Promise<CanonicalInputSeal|null> {
  if(!inputContext(source,target,scope,context))return null;
  return readInputSeal(source,target,scope,context,false);
}
async function readInputSeal(source:D1Database,target:D1Database,scope:CanonicalInputScope,
  context:CanonicalInputReadContext|undefined,capabilities:boolean):Promise<CanonicalInputSeal|null> {
  validateScope(scope);
  if(capabilities&&!await schemaAvailable(target))return null;
  const key=await scopeKey(scope),work=await readWork(target,key);
  if(!work||work.state!=='sealed')return null;
  const pin=await currentPin(source,target,scope,context);
  if(!pin||!await sourceProof(source,scope,pin,work.source_stamp,context,capabilities))return null;
  const inventory=await target.prepare(`SELECT (SELECT count(*) FROM analytics_canonical_input_seen WHERE scope_key=?) AS seen,
    (SELECT count(*) FROM analytics_canonical_input_pending WHERE scope_key=?) AS pending,
    (SELECT count(*) FROM analytics_canonical_input_seen s JOIN analytics_canonical_heads h ON h.occurrence_key=s.occurrence_key
      AND h.selection_method=? JOIN analytics_canonical_facts f ON f.revision=h.revision AND f.source_id=? AND f.owner_digest=?
      AND f.stream=? AND f.coverage='complete' WHERE s.scope_key=?) AS heads`)
    .bind(key,key,scope.selectionMethod,scope.sourceId,scope.ownerDigest,scope.stream,key).first<{seen:number;pending:number;heads:number}>();
  if(!inventory||inventory.pending!==0||inventory.seen!==work.seen_count||inventory.heads!==work.seen_count
    ||(await staleHeads(target,scope,key)).length!==0)return null;
  const current=await readWork(target,key),finalPin=await currentPin(source,target,scope,context);
  if(!current||current.state!=='sealed'||current.version!==work.version||current.source_stamp!==work.source_stamp
    ||!finalPin||finalPin.ownerRevision!==pin.ownerRevision||finalPin.authorityEpoch!==pin.authorityEpoch
    ||!await sourceProof(source,scope,pin,work.source_stamp,context,capabilities))return null;
  return {...sealFrom(work),ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,day:scope.day,stream:scope.stream};
}
export interface CanonicalInputFactPage {
  readonly seal:CanonicalInputSeal;
  readonly refs:readonly {readonly occurrenceKey:string;readonly revision:string;readonly partitionKey:string}[];
  readonly next:string|null;
}
/** Enumerate the sealed input membership, including explicit empty membership.
 * The keyset is an opaque selected/logical occurrence key. Native temporal
 * ordering remains on immutable facts. The native option uses that ordering
 * and resolves its opaque last-key cursor against this exact sealed scope. */
export async function readCanonicalInputFactPage(source:D1Database,target:D1Database,scope:CanonicalInputScope,
  options:{afterKey?:string;limit?:number;order?:'identity'|'native';context?:CanonicalInputReadContext}={}):Promise<CanonicalInputFactPage|null> {
  return readInputFactPage(source,target,scope,options,true);
}
/** A bounded private consumer may reuse held metadata across its page group.
 * This result does not authorize sealing, serving or publication. */
export async function readCanonicalInputPreparationFactPage(source:D1Database,target:D1Database,scope:CanonicalInputScope,
  context:CanonicalInputReadContext,options:{afterKey?:string;limit?:number;order?:'identity'|'native'}={}):Promise<CanonicalInputFactPage|null> {
  if(!inputContext(source,target,scope,context))return null;
  return readInputFactPage(source,target,scope,{...options,context},false);
}
async function readInputFactPage(source:D1Database,target:D1Database,scope:CanonicalInputScope,
  options:{afterKey?:string;limit?:number;order?:'identity'|'native';context?:CanonicalInputReadContext},
  capabilities:boolean):Promise<CanonicalInputFactPage|null> {
  const limit=options.limit??128;
  if(!Number.isSafeInteger(limit)||limit<1||limit>128)canonicalFail();
  if(options.afterKey!==undefined)canonicalDigest(options.afterKey);
  if(options.order!==undefined&&!['identity','native'].includes(options.order))canonicalFail();
  const seal=await readInputSeal(source,target,scope,options.context,capabilities);if(!seal)return null;
  let cursor:{at:number;orderScope:string;nativeOrder:number;key:string}|null=null;
  if(options.order==='native'&&options.afterKey!==undefined) {
    cursor=await target.prepare(`SELECT f.observed_at_ms AS at,f.order_scope_key AS orderScope,
      f.native_order AS nativeOrder,h.occurrence_key AS key FROM analytics_canonical_input_seen s
      JOIN analytics_canonical_heads h ON h.occurrence_key=s.occurrence_key AND h.selection_method=?
      JOIN analytics_canonical_facts f ON f.revision=h.revision AND f.source_id=? AND f.owner_digest=? AND f.stream=?
      WHERE s.scope_key=? AND s.occurrence_key=?`).bind(scope.selectionMethod,scope.sourceId,scope.ownerDigest,
      scope.stream,seal.scopeKey,options.afterKey).first();
    if(!cursor||!Number.isSafeInteger(cursor.at))return null;
  }
  const native=options.order==='native';
  const predicate=native?'(? IS NULL OR (f.observed_at_ms,f.order_scope_key,f.native_order,h.occurrence_key)>(?,?,?,?))'
    :'s.occurrence_key>?';
  const order=native?'f.observed_at_ms,f.order_scope_key,f.native_order,h.occurrence_key':'s.occurrence_key';
  const rows=(await target.prepare(`SELECT h.occurrence_key AS occurrenceKey,h.revision,h.partition_key AS partitionKey
    FROM analytics_canonical_input_seen s JOIN analytics_canonical_heads h ON h.occurrence_key=s.occurrence_key AND h.selection_method=?
    JOIN analytics_canonical_facts f ON f.revision=h.revision AND f.source_id=? AND f.owner_digest=? AND f.stream=?
    WHERE s.scope_key=? AND ${predicate} ORDER BY ${order} LIMIT ?`)
    .bind(scope.selectionMethod,scope.sourceId,scope.ownerDigest,scope.stream,seal.scopeKey,
      ...(native?[cursor?.at??null,cursor?.at??null,cursor?.orderScope??null,cursor?.nativeOrder??null,cursor?.key??null]
        :[options.afterKey??'']),limit+1).all<{occurrenceKey:string;revision:string;partitionKey:string}>()).results;
  const current=await readInputSeal(source,target,scope,options.context,capabilities);
  if(!current||canonicalJson(current)!==canonicalJson(seal))return null;
  const refs=rows.slice(0,limit);
  return {seal,refs,next:rows.length>limit?refs.at(-1)!.occurrenceKey:null};
}

/** One bounded native acquisition phase. The native reader is the selection
 * oracle. Pending opaque page metadata bridges a lost D1 page receipt response;
 * a complete receipt is replayed before any normalization callback runs. */
export async function advanceCanonicalInputWork(sourceDb:D1Database,targetDb:D1Database,
  options:AdvanceCanonicalInputOptions):Promise<CanonicalInputProgress> {
  validateScope(options);
  canonicalInteger(options.budget.maxSteps,1);
  if(options.budget.maxSteps>32||!Number.isSafeInteger(options.budget.deadlineMs)
    ||typeof options.budget.now!=='function')canonicalFail();
  const source=options.budget.meter.wrap(sourceDb),target=options.budget.meter.wrap(targetDb);
  const started=options.budget.meter.queriesUsed,effects:CanonicalEffect[]=[];
  const previousReserve=options.budget.meter.reserveQueries;
  let steps=0,pages=0,claim='',finishedQueries:number|null=null;
  const output=(state:CanonicalInputProgress['state'],seal:CanonicalInputSeal|null=null):CanonicalInputProgress=>{
    if(!claim)finishedQueries=options.budget.meter.queriesUsed;
    return {state,steps,pages,effects,get queriesUsed(){return (finishedQueries??options.budget.meter.queriesUsed)-started;},seal};
  };
  if(!canStep(options.budget))return output('deferred');
  if(!await schemaAvailable(target))return output('unavailable');
  const pin=await currentPin(source,target,options,options.context);
  if(!pin)return output('unavailable');
  const token=await sourceToken(source,options,options.context);
  if(!token||token.validUntilMs<=Date.now())return output('unavailable');
  const key=await scopeKey(options);
  claim=crypto.randomUUID();
  options.budget.meter.reserveQueries=previousReserve+1;
  const expires=Math.max(options.budget.now()+1,Math.min(options.budget.deadlineMs+5_000,options.budget.now()+LEASE_MS));
  try {
    await target.prepare(`INSERT INTO analytics_canonical_input_work
      (scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,owner_revision,
       authority_epoch,state,claim_token,claim_expires_ms)
      VALUES(?,?,?,?,?,?,?,?,?,'reading',?,?) ON CONFLICT(scope_key) DO NOTHING`)
      .bind(key,options.sourceId,options.ownerDigest,options.selectionMethod,options.stream,options.day,
        token.stamp,pin.ownerRevision,pin.authorityEpoch,claim,expires).run();
    let work=await readWork(target,key);
    if(!work)return output('unavailable');
    if(work.claim_token!==claim) {
      const acquired=await target.prepare(`UPDATE analytics_canonical_input_work SET claim_token=?,claim_expires_ms=?
        WHERE scope_key=? AND (claim_token IS NULL OR claim_expires_ms<=?)`)
        .bind(claim,expires,key,options.budget.now()).run();
      if(acquired.meta.changes!==1)return output('deferred');
      work=await readWork(target,key);
      if(!work||work.claim_token!==claim||work.claim_expires_ms<=options.budget.now())return output('deferred');
    }
    // A complete narrow content proof is reusable under a fresh live owner pin.
    // Authority is revalidated for this read; cosmetic revisions do not replay
    // native acquisition or discard the accepted membership checkpoint.
    if(work.state==='sealed'&&work.source_stamp===token.stamp){
      const seal=await readCanonicalInputSeal(source,target,options,options.context);
      return seal?output('complete',seal):output('unavailable');
    }
    if(work.source_stamp===token.stamp&&(work.owner_revision!==pin.ownerRevision||work.authority_epoch!==pin.authorityEpoch)){
      await target.prepare(`UPDATE analytics_canonical_input_work SET owner_revision=?,authority_epoch=?,version=version+1
        WHERE scope_key=? AND source_stamp=? AND claim_token=? AND version=? AND claim_expires_ms>?
          AND claim_expires_ms>(julianday('now')-2440587.5)*86400000`)
        .bind(pin.ownerRevision,pin.authorityEpoch,key,token.stamp,claim,work.version,options.budget.now()).run();
      work=await readWork(target,key);
      if(!work||work.claim_token!==claim||work.owner_revision!==pin.ownerRevision||work.authority_epoch!==pin.authorityEpoch)return output('deferred');
    }
    if(work.source_stamp!==token.stamp) {
      // Retain the old stamp while a bounded reset drains its seen set. The
      // draining state prevents a partially reset scope from being served.
      const resetVersion=work.version+1;
      await target.batch([
        target.prepare(`UPDATE analytics_canonical_input_work SET state='draining',version=version+1
          WHERE scope_key=? AND source_stamp=? AND claim_token=? AND version=? AND claim_expires_ms>?
          AND claim_expires_ms>(julianday('now')-2440587.5)*86400000`)
          .bind(key,work.source_stamp,claim,work.version,options.budget.now()),
        target.prepare(`DELETE FROM analytics_canonical_input_pending WHERE scope_key=?
          AND EXISTS(SELECT 1 FROM analytics_canonical_input_work WHERE scope_key=? AND claim_token=? AND version=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000)`)
          .bind(key,key,claim,resetVersion,options.budget.now()),
        target.prepare(`DELETE FROM analytics_canonical_input_seen WHERE scope_key=? AND occurrence_key IN(
          SELECT occurrence_key FROM analytics_canonical_input_seen WHERE scope_key=? ORDER BY occurrence_key LIMIT 128)
          AND EXISTS(SELECT 1 FROM analytics_canonical_input_work WHERE scope_key=? AND claim_token=? AND version=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000)`)
          .bind(key,key,key,claim,resetVersion,options.budget.now()),
        target.prepare(`UPDATE analytics_canonical_input_work SET source_stamp=?,owner_revision=?,authority_epoch=?,
          state='reading',cursor_key=NULL,cursor_ms=NULL,tie_rank=0,page_ordinal=0,seen_count=0,version=version+1
          WHERE scope_key=? AND claim_token=? AND version=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000
          AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_seen WHERE scope_key=?)
          AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_pending WHERE scope_key=?)`)
          .bind(token.stamp,pin.ownerRevision,pin.authorityEpoch,key,claim,resetVersion,options.budget.now(),key,key),
      ]);
      work=await readWork(target,key);
      if(!work||work.claim_token!==claim||work.claim_expires_ms<=options.budget.now())return output('deferred');
      if(work.source_stamp!==token.stamp)return output('progress');
    }
    if(work.state==='sealed') {
      const seal=await readCanonicalInputSeal(source,target,options,options.context);
      return seal?output('complete',seal):output('unavailable');
    }
    for(;steps<options.budget.maxSteps;steps++) {
      if(!canStep(options.budget))return output('deferred');
      work=await readWork(target,key);
      if(!work||work.claim_token!==claim||work.claim_expires_ms<=options.budget.now()||work.source_stamp!==token.stamp)return output('deferred');
      if(!await sourceProof(source,options,pin,token.stamp,options.context))return output('unavailable');
      const leaseCurrent=async()=>{const current=await readWork(target,key);return !!current&&current.claim_token===claim
        &&current.version===work!.version&&current.claim_expires_ms>options.budget.now()
        &&await sourceProof(source,options,pin,token.stamp,options.context);};
      const inputLease={scopeKey:key,claimToken:claim,version:work.version,nowMs:options.budget.now()};
      if(work.state==='reading') {
        let pending=await target.prepare('SELECT * FROM analytics_canonical_input_pending WHERE scope_key=?')
          .bind(key).first<PendingRow>();
        let data:PageData|undefined;
        if(!pending) {
          data=await readPage(source,options,pin,work,options.context);
          if(!await sourceProof(source,options,pin,token.stamp,options.context))return output('unavailable');
          const pageKey=await sha256Hex(canonicalJson(['canonical-input-page-v1',key,token.stamp,work.page_ordinal]));
          const sourceRevision=await sha256Hex(canonicalJson(['canonical-input-source-v1',token.stamp,
            work.cursor_key,work.cursor_ms,data.nextKey,data.nextMs,data.keys]));
          pending={scope_key:key,source_stamp:token.stamp,page_key:pageKey,source_revision:sourceRevision,
            next_key:data.nextKey,next_ms:data.nextMs,next_tie_rank:data.nextTieRank,
            seen_keys_json:JSON.stringify(data.keys),terminal:data.terminal?1:0};
          if(!await insertPending(target,key,claim,work,pending,options.budget.now()))return output('deferred');
        }
        if(pending.source_stamp!==token.stamp||pending.scope_key!==key) return output('unavailable');
        const expectedKeys=JSON.parse(pending.seen_keys_json) as unknown;
        if(!Array.isArray(expectedKeys)||expectedKeys.length>PAGE_SIZE
          ||expectedKeys.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value)))canonicalFail();
        const receipt=await materializeCanonicalPage({db:target,sourceId:options.sourceId,
          scope:{sourceNamespace:options.sourceNamespace,ownerDigest:options.ownerDigest,
            selectionMethod:options.selectionMethod},ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,
          pageKey:pending.page_key,sourceRevision:pending.source_revision,
          inputLease,stillCurrent:leaseCurrent,
          load:async()=>{
            const page=data??await readPage(source,options,pin,work!,options.context);
            if(JSON.stringify(page.keys)!==pending!.seen_keys_json||page.nextKey!==pending!.next_key
              ||page.nextMs!==pending!.next_ms||page.nextTieRank!==pending!.next_tie_rank
              ||Number(page.terminal)!==pending!.terminal)canonicalFail('CANONICAL_CONFLICT');
            return pageUpdates(target,options,page);
          }});
        effects.push(...receipt.effects);
        if(!await finishPending(target,key,claim,work,pending,receipt.changeKey,options.budget.now()))return output('deferred');
        pages++;
        continue;
      }
      if(work.state==='draining') {
        const stale=await staleHeads(target,options,key);
        if(stale.length) {
          const pageKey=await sha256Hex(canonicalJson(['canonical-input-withdraw-v1',key,token.stamp,stale]));
          const sourceRevision=await sha256Hex(canonicalJson(['canonical-input-withdraw-proof-v1',token.stamp,stale]));
          const receipt=await materializeCanonicalPage({db:target,sourceId:options.sourceId,
            scope:{sourceNamespace:options.sourceNamespace,ownerDigest:options.ownerDigest,
              selectionMethod:options.selectionMethod},ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,
            pageKey,sourceRevision,inputLease,stillCurrent:leaseCurrent,
            load:async()=>stale.map(row=>({occurrenceKey:row.occurrence_key,stream:options.stream,
              expectedRevision:row.revision,fact:null}))});
          effects.push(...receipt.effects);pages++;
          continue;
        }
        if(!await sourceProof(source,options,pin,token.stamp,options.context,true))return output('unavailable');
        const sealed=await target.prepare(`UPDATE analytics_canonical_input_work SET state='sealed',version=version+1
          WHERE scope_key=? AND source_stamp=? AND state='draining' AND claim_token=? AND version=? AND claim_expires_ms>? AND claim_expires_ms>(julianday('now')-2440587.5)*86400000 RETURNING scope_key`)
          .bind(key,token.stamp,claim,work.version,options.budget.now()).first<string>('scope_key');
        // Downstream queue triggers may change additional rows. Only this CAS
        // row proves admission; D1 meta.changes includes those trigger effects.
        if(sealed!==key)return output('deferred');
        const seal=await readCanonicalInputSeal(source,target,options,options.context);
        return seal?output('complete',seal):output('unavailable');
      }
      canonicalFail('CANONICAL_CONFLICT');
    }
    return output('progress');
  } catch(error) {
    if(error instanceof D1InvocationBudgetExceededError)return output('deferred');
    throw error;
  } finally {
    options.budget.meter.reserveQueries=previousReserve;
    if(claim) {
      try {await target.prepare(`UPDATE analytics_canonical_input_work SET claim_token=NULL,claim_expires_ms=0
        WHERE scope_key=? AND claim_token=?`).bind(key,claim).run();} catch { /* expiry recovers a failed release */ }
    }
    finishedQueries=options.budget.meter.queriesUsed;
  }
}

/** The source owner/device selection primitive runs only at the admission edge.
 * Its private participant identifier is never written to analytical storage or
 * returned with the sealed result. P7 owns capture and replacement policy. */
export interface CanonicalSourceMembershipIdentity extends CanonicalInputScope {
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly sourceStamp: string;
}
export const CANONICAL_INPUT_MEMBERSHIP_SCHEMA = 'canonical-input-membership-v1' as const;
export const CANONICAL_INPUT_MEMBERSHIP_METHOD = 'contributing-devices-by-reader-v1' as const;
export interface CanonicalSourceMembershipProof {
  readonly schema: typeof CANONICAL_INPUT_MEMBERSHIP_SCHEMA;
  readonly contributorKey: string;
  readonly deviceKeys: readonly string[];
  readonly method: typeof CANONICAL_INPUT_MEMBERSHIP_METHOD;
  readonly dependencyRevision: string;
  readonly sourceDay: string;
  readonly selectionMethod: CanonicalScope['selectionMethod'];
  readonly sourceToken: string;
  readonly coverage: 'complete';
}
export type CanonicalSourceMembershipReader = (source:D1Database,
  privateIdentity:CanonicalSourceMembershipIdentity)=>Promise<CanonicalSourceMembershipProof|null>;
export type CanonicalInputMembership = ({readonly state:'complete';readonly seal:CanonicalInputSeal}
  & CanonicalSourceMembershipProof) | {readonly state:'unavailable';readonly reason:
    'input_unsealed'|'reader_unavailable'|'membership_unavailable'|'proof_changed'};
function validateMembershipProof(proof:CanonicalSourceMembershipProof,seal:CanonicalInputSeal,
  scope:CanonicalInputScope):void {
  if(Object.keys(proof).sort().join(',')!==
    'contributorKey,coverage,dependencyRevision,deviceKeys,method,schema,selectionMethod,sourceDay,sourceToken')canonicalFail();
  canonicalDigest(proof.contributorKey);canonicalDigest(proof.dependencyRevision);canonicalDigest(proof.sourceToken);
  if(proof.schema!==CANONICAL_INPUT_MEMBERSHIP_SCHEMA||proof.method!==CANONICAL_INPUT_MEMBERSHIP_METHOD
    ||proof.coverage!=='complete'||proof.sourceDay!==scope.day||proof.selectionMethod!==scope.selectionMethod
    ||proof.sourceToken!==seal.sourceStamp||!Array.isArray(proof.deviceKeys)||proof.deviceKeys.length>128
    ||!proof.deviceKeys.every((key,index)=>typeof key==='string'&&/^[0-9a-f]{64}$/u.test(key)
      &&(index===0||proof.deviceKeys[index-1]!<key))
    ||new TextEncoder().encode(canonicalJson(proof)).length>16_384)canonicalFail('CANONICAL_LIMIT');
}
/** Read source-private selected membership only under a complete input seal.
 * The callback returns a closed opaque proof; absent coverage never becomes an
 * empty set or an inferred device count. No second membership store is created. */
export async function readCanonicalInputMembership(source:D1Database,target:D1Database,
  scope:CanonicalInputScope,reader?:CanonicalSourceMembershipReader,context?:CanonicalInputReadContext):Promise<CanonicalInputMembership> {
  const before=await readCanonicalInputSeal(source,target,scope,context);
  if(!before)return {state:'unavailable',reason:'input_unsealed'};
  if(!reader)return {state:'unavailable',reason:'reader_unavailable'};
  const proof=await reader(source,{...scope,ownerRevision:before.ownerRevision,
    authorityEpoch:before.authorityEpoch,sourceStamp:before.sourceStamp});
  if(!proof)return {state:'unavailable',reason:'membership_unavailable'};
  validateMembershipProof(proof,before,scope);
  const after=await readCanonicalInputSeal(source,target,scope,context);
  if(!after||JSON.stringify(after)!==JSON.stringify(before))return {state:'unavailable',reason:'proof_changed'};
  return Object.freeze({state:'complete',seal:after,...proof,
    deviceKeys:Object.freeze([...proof.deviceKeys])});
}
