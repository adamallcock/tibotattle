import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { D1_BUDGET_ATTACHMENT, D1InvocationBudgetExceededError, readD1SchemaObjectsAvailable, type D1BudgetAttachment } from './d1-invocation-budget';
import type { EffectiveDependencyMutationToken } from './storage-effective-dependency-mutations';
import { readEffectiveDependencySourceFence, readEffectiveScopeMutationTokens,
  type EffectiveDependencyScopeBounds, type EffectiveDependencySourceFence } from './storage-effective-selective-dependencies';
import type { StorageCommunityOwner } from './storage-community-authority';
import type { EffectiveHistoryDependency } from './effective-history-dependency';

const METHOD='effective-history-dependency-v3';
const TABLE='analytics_effective_dependency_summaries';
const MAX_PAYLOAD_BYTES=262_144;
export const EFFECTIVE_DEPENDENCY_SUMMARY_TABLES = Object.freeze([TABLE]);
const TRIGGERS=['insert','update','owner_update','owner_delete','runtime_update','runtime_delete',
  'terminal_insert','terminal_update','contract_v1'].map(suffix=>`analytics_effective_dependency_${suffix}`);
export const EFFECTIVE_DEPENDENCY_SUMMARY_TRIGGERS = Object.freeze(TRIGGERS);
const unavailable=()=>new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
interface Context extends D1BudgetAttachment {
  kind:'effective-dependency-summaries-v1'; target:D1Database; sourceId:string; sourceNamespace:string;
}
function context(source:D1Database):Context|undefined {
  const value:unknown=Reflect.get(source,D1_BUDGET_ATTACHMENT);
  if(!value||typeof value!=='object'||!('kind' in value)||value.kind!=='effective-dependency-summaries-v1')return;
  return value as Context;
}
/** Carry the private summary target at the request composition boundary. The
 * D1 meter remaps its attachment through every nested phase's same meter. */
export function withMaintainedEffectiveDependencies(source:D1Database,target:D1Database,
  sourceId:string,sourceNamespace:string):D1Database {
  if(source===target)throw unavailable();
  const make=(db:D1Database):Context=>({kind:'effective-dependency-summaries-v1',target:db,sourceId,sourceNamespace,
    withBudget(wrap){return make(wrap(db));}});
  const attached=make(target);
  return new Proxy(source,{get(db,property){
    if(property===D1_BUDGET_ATTACHMENT)return attached;
    const value:unknown=Reflect.get(db,property);
    return typeof value==='function'?value.bind(db):value;
  }});
}
function budgetError(error:unknown):void {
  if(error instanceof D1InvocationBudgetExceededError)throw error;
}
async function available(ctx:Context):Promise<boolean> {
  try {
    return await readD1SchemaObjectsAvailable(ctx.target,[['table',TABLE],
      ...TRIGGERS.map(name=>['trigger',name] as const),['index','analytics_effective_dependency_owner']]);
  }catch(error){budgetError(error);throw error;}
}
function validToken(token: EffectiveDependencyMutationToken | undefined): token is EffectiveDependencyMutationToken {
  return !!token && /^[0-9a-f]{64}$/u.test(token.stamp)
    && Number.isSafeInteger(token.validUntilMs) && token.validUntilMs > Date.now();
}
interface Snapshot {
  readonly fence: EffectiveDependencySourceFence;
  readonly tokens: readonly EffectiveDependencyMutationToken[];
}
function sameFence(a: EffectiveDependencySourceFence | undefined, b: EffectiveDependencySourceFence | undefined): boolean {
  return !!a && !!b && a.generation === b.generation && a.capabilityVersion === b.capabilityVersion;
}
/** Full coverage, identity and clock checks precede this request-local fence.
 * Each day retains its own token; a range stamp cannot stand in for all days. */
async function snapshot(source: D1Database, ctx: Context, owner: StorageCommunityOwner,
  scopes: readonly EffectiveDependencyScopeBounds[]): Promise<Snapshot | undefined> {
  if (!owner.ownerDigest) return;
  const before = await readEffectiveDependencySourceFence(source);
  if (!before) return;
  const tokens = await readEffectiveScopeMutationTokens(source, {
    participantId: owner.participantId, ownerDigest: owner.ownerDigest,
    sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace,
  }, scopes);
  const after = await readEffectiveDependencySourceFence(source);
  if (!tokens || tokens.length !== scopes.length || !tokens.every(validToken) || !sameFence(before, after)) return;
  return { fence: after!, tokens };
}
async function sameSnapshot(source: D1Database, ctx: Context, owner: StorageCommunityOwner,
  captured: Snapshot, capabilities=true): Promise<boolean> {
  if (!captured.tokens.every(validToken)) return false;
  const current=capabilities?await readEffectiveDependencySourceFence(source)
    :await source.prepare(`SELECT sequence AS generation,method AS capabilityVersion
      FROM storage_effective_selective_runtime WHERE id=1 AND method=?`)
      .bind(captured.fence.capabilityVersion).first<EffectiveDependencySourceFence>()??undefined;
  if (!sameFence(captured.fence,current) || !await targetCurrent(ctx,owner)) return false;
  return captured.tokens.every(validToken);
}
async function key(ctx:Context,owner:StorageCommunityOwner,fromDay:string,throughDay:string,includeSessions:boolean) {
  return sha256Hex(canonicalJson([METHOD,ctx.sourceId,ctx.sourceNamespace,owner.ownerDigest,fromDay,throughDay,includeSessions]));
}
const TARGET_FENCE=`EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
 WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.revision=? AND o.authority_epoch=?
 AND r.source_namespace=? AND r.contract_version=1 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))`;
function fence(ctx:Context,owner:StorageCommunityOwner) {
  return [ctx.sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,ctx.sourceNamespace];
}
async function targetCurrent(ctx: Context, owner: StorageCommunityOwner): Promise<boolean> {
  return (await ctx.target.prepare(`SELECT ${TARGET_FENCE} AS current`)
    .bind(...fence(ctx, owner)).first<number>('current')) === 1;
}
interface Row {scope_key:string;mutation_stamp:string;dependency_digest:string;payload:string|null;valid_until_ms:number}
async function readRows(ctx:Context,owner:StorageCommunityOwner,keys:readonly string[],payload:boolean):Promise<Row[]> {
  try {
    return (await ctx.target.prepare(`SELECT scope_key,mutation_stamp,dependency_digest,
      ${payload?'payload':'NULL AS payload'},valid_until_ms FROM ${TABLE}
      WHERE source_id=? AND owner_digest=? AND scope_key IN(SELECT value FROM json_each(?)) AND ${TARGET_FENCE}`)
      .bind(ctx.sourceId,owner.ownerDigest,JSON.stringify(keys),...fence(ctx,owner)).all<Row>()).results;
  }catch(error){budgetError(error);throw error;}
}
function current(row:Row|undefined,token:EffectiveDependencyMutationToken):row is Row {
  return !!row&&row.mutation_stamp===token.stamp&&Number.isSafeInteger(row.valid_until_ms)
    &&row.valid_until_ms>Date.now()&&/^[0-9a-f]{64}$/u.test(row.dependency_digest);
}
function decode(payload:string,owner:StorageCommunityOwner,fromDay:string,throughDay:string,
  includeSessions:boolean):EffectiveHistoryDependency|undefined {
  try {
    if(new TextEncoder().encode(payload).length>MAX_PAYLOAD_BYTES)return;
    const value:unknown=JSON.parse(payload);
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const v=value as EffectiveHistoryDependency;
    if(Object.keys(v).sort().join(',')!=='correctionRuntime,corrections,fromDay,occurrenceLinks,participantId,streams,throughDay,v1,v11,v12,version'
      ||v.version!==METHOD||v.participantId!==owner.participantId||v.fromDay!==fromDay||v.throughDay!==throughDay
      ||!['staged','active'].includes(v.correctionRuntime)||!Array.isArray(v.streams)
      ||v.streams.join(',')!==(includeSessions?'quota,session,usage':'quota,usage'))return;
    for(const name of ['v1','v11','v12','corrections','occurrenceLinks'] as const) {
      const rows=v[name];
      if(!Array.isArray(rows)||rows.length>30_000||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)
        ||Object.keys(row).length>24||Object.values(row).some(field=>field!==null
          &&typeof field!=='string'&&!(typeof field==='number'&&Number.isFinite(field)))))return;
      rows.forEach(Object.freeze);Object.freeze(rows);
    }
    Object.freeze(v.streams);return Object.freeze(v);
  }catch{return;}
}
interface Write {
  scopeKey: string; fromDay: string; throughDay: string; includeSessions: boolean;
  digest: string; payload: string | null; token: EffectiveDependencyMutationToken;
}
async function save(ctx: Context, owner: StorageCommunityOwner, rows: readonly Write[]): Promise<void> {
  const now = Date.now();
  if (!rows.length || rows.some(row => row.token.validUntilMs <= now)) return;
  if (rows.length > 16) throw unavailable();
  const data = rows.map(row => [row.scopeKey, row.fromDay, row.throughDay, row.includeSessions ? 1 : 0,
    row.digest, row.payload, row.token.stamp, row.token.validUntilMs]);
  try {
    // Storage and cleanup are bounded independently of the retained history.
    await ctx.target.prepare(`DELETE FROM ${TABLE} WHERE scope_key IN(SELECT scope_key FROM ${TABLE}
      WHERE source_id=? AND owner_digest=? ORDER BY updated_ms,scope_key LIMIT 8)
      AND (SELECT count(*) FROM ${TABLE} WHERE source_id=? AND owner_digest=?)>1000`)
      .bind(ctx.sourceId,owner.ownerDigest,ctx.sourceId,owner.ownerDigest).run();
    const written = (await ctx.target.prepare(`INSERT INTO ${TABLE}(scope_key,source_id,source_namespace,owner_digest,from_day,
      through_day,include_sessions,mutation_stamp,dependency_digest,payload,owner_revision,authority_epoch,updated_ms,valid_until_ms)
      SELECT json_extract(value,'$[0]'),?,?,?,json_extract(value,'$[1]'),json_extract(value,'$[2]'),
        json_extract(value,'$[3]'),json_extract(value,'$[6]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),?,?,?,json_extract(value,'$[7]')
      FROM json_each(?) WHERE ${TARGET_FENCE}
      ON CONFLICT(scope_key) DO UPDATE SET mutation_stamp=excluded.mutation_stamp,dependency_digest=excluded.dependency_digest,
        payload=CASE WHEN excluded.payload IS NULL AND mutation_stamp=excluded.mutation_stamp
          THEN payload ELSE excluded.payload END,owner_revision=excluded.owner_revision,authority_epoch=excluded.authority_epoch,
        updated_ms=excluded.updated_ms,valid_until_ms=excluded.valid_until_ms
      WHERE updated_ms<=excluded.updated_ms AND owner_revision<=excluded.owner_revision
        AND authority_epoch<=excluded.authority_epoch RETURNING scope_key`)
      .bind(ctx.sourceId,ctx.sourceNamespace,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,
        now,JSON.stringify(data),...fence(ctx,owner)).all<{scope_key:string}>()).results;
    if (written.length !== rows.length) throw unavailable();
  } catch (error) {
    budgetError(error);
    // Capacity only refuses this optional memo. A terminal/changed target must
    // refuse the work; it cannot be hidden by treating the cache as unavailable.
    if (String(error).includes('analytics_effective_dependency_ineligible') && await targetCurrent(ctx, owner)) return;
    throw error;
  }
}
/** Exact range identities retain their native bytes. The cache is reusable
 * only with fresh source metadata before and after acquisition/lookup. */
export async function maintainedEffectiveHistoryDependency(source: D1Database, owner: StorageCommunityOwner,
  sourceNamespace: string, fromDay: string, throughDay: string, includeSessions: boolean,
  native: () => Promise<EffectiveHistoryDependency>): Promise<EffectiveHistoryDependency> {
  const ctx = context(source);
  if (!ctx || ctx.sourceNamespace !== sourceNamespace || !await available(ctx)) return native();
  const captured = await snapshot(source, ctx, owner, [{fromDay, throughDay, includeSessions}]);
  if (!captured) return native();
  const token = captured.tokens[0]!;
  const scopeKey = await key(ctx, owner, fromDay, throughDay, includeSessions);
  const row = (await readRows(ctx, owner, [scopeKey], true))[0];
  if (!await sameSnapshot(source, ctx, owner, captured)) throw unavailable();
  if (current(row, token) && row.payload !== null && await sha256Hex(row.payload) === row.dependency_digest) {
    const dependency = decode(row.payload, owner, fromDay, throughDay, includeSessions);
    if (dependency && await sameSnapshot(source, ctx, owner, captured)) return dependency;
  }
  const value = await native();
  if (!await sameSnapshot(source, ctx, owner, captured)) throw unavailable();
  const payload = canonicalJson(value);
  if (new TextEncoder().encode(payload).length <= MAX_PAYLOAD_BYTES) {
    await save(ctx, owner, [{scopeKey, fromDay, throughDay, includeSessions, token,
      digest: await sha256Hex(payload), payload}]);
    if (!await sameSnapshot(source, ctx, owner, captured)) throw unavailable();
  }
  return value;
}
interface DayReader {readDigest(day: string): Promise<string | undefined>;readDigests?():Promise<readonly string[]|undefined>}
/** Misses use the exact native reader. Warm singleton hashes reuse one initial
 * bulk coverage proof, then bounded source capability/clock and target fences. */
export async function maintainedEffectiveHistoryDayReader(source: D1Database, owner: StorageCommunityOwner,
  sourceNamespace: string, days: readonly string[], includeSessions: boolean,
  native: () => Promise<DayReader | undefined>, canContinue?: () => boolean): Promise<DayReader | undefined> {
  const ctx = context(source);
  if (!ctx || ctx.sourceNamespace !== sourceNamespace || !await available(ctx)) return;
  const captured = await snapshot(source, ctx, owner,
    days.map(day => ({fromDay: day, throughDay: day, includeSessions})));
  if (!captured) return;
  if (canContinue?.() === false) return;
  const keys = await Promise.all(days.map(day => key(ctx, owner, day, day, includeSessions)));
  const rows = new Map((await readRows(ctx, owner, keys, false)).map(row => [row.scope_key, row]));
  if (!await sameSnapshot(source, ctx, owner, captured)) throw unavailable();
  let nativeReader: Promise<DayReader | undefined> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  const pending: Write[] = [], seen = new Set<string>();
  const readDay=async(day:string,capabilities:boolean):Promise<string|undefined>=>{
    const index=days.indexOf(day);
    if(index<0)throw unavailable();
    const scopeKey=keys[index]!,token=captured.tokens[index]!,row=rows.get(scopeKey);
    if(canContinue?.()===false||!validToken(token))return;
    const reused=current(row,token);
    // A batch exposes no partial result. Bound private warm lookups in groups
    // of sixteen between cheap guards; native misses keep their own guards.
    if((capabilities||index%16===0||!reused)&&!await sameSnapshot(source,ctx,owner,captured,capabilities))return;
    if(reused)return row!.dependency_digest;
    const reader=await(nativeReader??=native());if(!reader)return;
    const result=await reader.readDigest(day);
    if(result===undefined||canContinue?.()===false||!await sameSnapshot(source,ctx,owner,captured,capabilities))return;
    if(!seen.has(day)) {
      pending.push({scopeKey,fromDay:day,throughDay:day,includeSessions,digest:result,payload:null,token});
      seen.add(day);
    }
    rows.set(scopeKey,{scope_key:scopeKey,mutation_stamp:token.stamp,dependency_digest:result,
      payload:null,valid_until_ms:token.validUntilMs});
    if(pending.length>=16||seen.size===days.length||day===days.at(-1)) {
      // An intermediate batch read is private. Promotion of even this optional
      // memo still requires the complete capability proof immediately before it.
      if(!capabilities&&!await sameSnapshot(source,ctx,owner,captured))return;
      await save(ctx,owner,pending);pending.length=0;
      if(!await sameSnapshot(source,ctx,owner,captured))return;
    }
    return result;
  };
  const serialized=<T>(operation:()=>Promise<T>):Promise<T>=>{
    const result=serial.then(operation);
    serial=result.then(()=>undefined,()=>undefined);return result;
  };
  return {
    // Independent calls retain the full fence before exposing each digest.
    readDigest(day){return serialized(()=>readDay(day,true));},
    // Only this complete bounded list may share capability validation. Exact
    // singleton tokens, expiry and target authority remain checked internally.
    readDigests(){return serialized(async()=>{
      if(canContinue?.()===false||!await sameSnapshot(source,ctx,owner,captured))return;
      const digests:string[]=[];
      for(const day of days){const digest=await readDay(day,false);if(digest===undefined)return;digests.push(digest);}
      if(canContinue?.()===false||!await available(ctx)||!await sameSnapshot(source,ctx,owner,captured))return;
      if(pending.length){await save(ctx,owner,pending);pending.length=0;
        if(!await sameSnapshot(source,ctx,owner,captured))return;}
      // Time may have crossed a capability expiry during the final target read.
      return captured.tokens.every(validToken)?Object.freeze(digests):undefined;
    });},
  };
}

export interface EffectiveHistoryRangeDependencyReader {
  readDependency(index:number):Promise<EffectiveHistoryDependency>;
  assertCurrent():Promise<void>;
  close():void;
}
/** Private, invocation-local range acquisition. Each range keeps its native v3
 * identity; singleton session proofs never replace a range. Misses are lazy so
 * a cold batch can publish its selected date before acquiring sibling ranges. */
export async function createMaintainedEffectiveHistoryRangeReader(source:D1Database,target:D1Database,
  inputOwner:StorageCommunityOwner,sourceNamespace:string,ranges:readonly EffectiveDependencyScopeBounds[],
  proofDays:readonly string[],native:(index:number)=>Promise<EffectiveHistoryDependency>,
  options:{deadlineMs:number;now:()=>number}):Promise<EffectiveHistoryRangeDependencyReader|undefined> {
  const ctx=context(source),owner=Object.freeze({...inputOwner});
  if(!ctx)return;
  if(ctx.target!==target||ctx.sourceNamespace!==sourceNamespace||source===target)throw unavailable();
  if(!Array.isArray(ranges)||ranges.length<1||ranges.length>16||!Array.isArray(proofDays)
    ||new Set(proofDays).size!==proofDays.length||ranges.length+proofDays.length>132
    ||!Number.isFinite(options.deadlineMs)||!Number.isFinite(options.now())
    ||options.deadlineMs-options.now()>120_000)throw unavailable();
  const started=Date.now();let closed=false;
  const active=()=>!closed&&options.now()<options.deadlineMs&&Date.now()<started+120_000;
  if(!active()||!await available(ctx))return;
  const scopes=[...ranges,...proofDays.map(day=>({fromDay:day,throughDay:day,includeSessions:true}))];
  const captured=await snapshot(source,ctx,owner,scopes);
  if(!captured||!active())return;
  const keys=await Promise.all(ranges.map(range=>key(ctx,owner,range.fromDay,range.throughDay,range.includeSessions)));
  if(new Set(keys).size!==keys.length)throw unavailable();
  // Check aggregate and individual lengths in SQL before any payload transfer.
  // The original256KiB member limit stays fixed;16 members share one4MiB cap.
  const rows=(await ctx.target.prepare(`WITH requested AS MATERIALIZED (
    SELECT scope_key,mutation_stamp,dependency_digest,payload,valid_until_ms FROM ${TABLE}
    WHERE source_id=? AND owner_digest=? AND scope_key IN(SELECT value FROM json_each(?)) AND ${TARGET_FENCE}
    LIMIT 17)
    SELECT scope_key,mutation_stamp,dependency_digest,payload,valid_until_ms FROM requested
    WHERE (SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM requested)<=?
      AND (SELECT coalesce(max(length(CAST(payload AS BLOB))),0) FROM requested)<=?`)
    .bind(ctx.sourceId,owner.ownerDigest,JSON.stringify(keys),...fence(ctx,owner),16*MAX_PAYLOAD_BYTES,MAX_PAYLOAD_BYTES)
    .all<Row>()).results;
  const retained=new Map(rows.map(row=>[row.scope_key,row]));
  async function assertSnapshot(capabilities=true):Promise<void> {
    if(!active()||capabilities&&!await available(ctx!)
      ||!await sameSnapshot(source,ctx!,owner,captured!,capabilities)||!active())throw unavailable();
  }
  await assertSnapshot();
  let pending:Promise<unknown>=Promise.resolve();
  const serialized=<T>(work:()=>Promise<T>):Promise<T>=>{
    const result=pending.then(work);pending=result.then(()=>undefined,()=>undefined);return result;
  };
  return {
    readDependency(index){return serialized(async()=>{
      if(!Number.isSafeInteger(index)||index<0||index>=ranges.length)throw unavailable();
      await assertSnapshot(false);
      const range=ranges[index]!,token=captured.tokens[index]!,scopeKey=keys[index]!,row=retained.get(scopeKey);
      if(current(row,token)&&row.payload!==null&&await sha256Hex(row.payload)===row.dependency_digest){
        const value=decode(row.payload,owner,range.fromDay,range.throughDay,range.includeSessions);
        if(value){await assertSnapshot(false);return value;}
      }
      // Only this requested range is acquired. Native acquisition and memo
      // promotion retain the full source/target seals used by the singleton API.
      await assertSnapshot();
      const value=await native(index);
      await assertSnapshot();
      const payload=canonicalJson(value);
      if(new TextEncoder().encode(payload).length<=MAX_PAYLOAD_BYTES){
        await save(ctx,owner,[{scopeKey,...range,token,digest:await sha256Hex(payload),payload}]);
        await assertSnapshot();
      }
      return value;
    });},
    assertCurrent(){return serialized(()=>assertSnapshot());},
    close(){closed=true;retained.clear();},
  };
}
