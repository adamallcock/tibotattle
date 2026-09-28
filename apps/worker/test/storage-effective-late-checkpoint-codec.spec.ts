import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { finishEffectiveQuotaDay } from '../src/effective-quota-day';
import {reduceGraphDayProjection} from '../src/graph-day-projection';
import { createV11QuotaAcquisitionCheckpoint } from '../src/quota-analysis-v11-reader';
import { STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD, storageGraphEffectiveCheckpointKey } from '../src/storage-community-graph';
import type { StorageEffectiveHistoryCheckpoint } from '../src/storage-effective-history';
import {
  loadStorageHistoryCheckpoint, saveStorageHistoryCheckpoint, storageHistoryKeyDigest,
  storageHistoryCheckpointParts,
  type StorageHistoryCheckpoint, type StorageHistoryKey,
} from '../src/storage-history-checkpoint';

const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const target = () => bindings.STORAGE_ANALYTICS_DB;
const sourceId = 'synthetic-late-effective-codec';
const sourceNamespace = 'synthetic-late-effective-origin';
const ownerDigest = 'a'.repeat(64);
const day = '2026-09-05';
const phases = ['plan', 'clusters', 'fitability', 'endpoints'] as const;
type Acquisition = Extract<StorageEffectiveHistoryCheckpoint, { phase: 'acquisition' }>;
const key = (): Promise<StorageHistoryKey> => storageGraphEffectiveCheckpointKey({
  sourceId, sourceNamespace, ownerDigest, day, dependencyDigest: 'b'.repeat(64),
  method: STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD,
}, true);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
    .bind(sourceId, ownerDigest).run();
});

function checkpoint(phase: typeof phases[number]): Acquisition {
  const identity = {
    participantId: 'synthetic-late-effective-participant', inputFingerprint: 'c'.repeat(64),
    sourceMethodVersion: 'synthetic-effective-reader-1', observedAtCutoff: '2026-05-28T00:00:00.000Z',
    resetsAtCutoff: '2026-06-04T00:00:00.000Z', windowMinutes: 10080, maxQuotaRows: 60000,
  };
  const inputDay = '2026-05-29';
  const observedAtMs = Date.parse(`${inputDay}T12:00:00.000Z`);
  const acquisition = createV11QuotaAcquisitionCheckpoint(identity);
  acquisition.phase = phase;
  acquisition.cursor = { observedAtMs: observedAtMs + 1, sourceRowId: 17 };
  return {
    version: 1, source: 'effective', day, layout: `effective:${sourceNamespace}`, identity,
    phase: 'acquisition', acquisition,
    effectiveCursor: {
      phase, day: inputDay, after: { observedAtMs: observedAtMs + 1, occurrenceId: 'synthetic-row-17' },
      ordinal: 17, complete: false,
    },
    effectiveDays: { quota: [inputDay], usage: [] },
    // Day-local row ordinals remain distinct from the window-global cursor.
    preparingQuota: {
      day: inputDay, quotaRowsRead: 2,
      rows: [0, 1].map(index => ({ sourceRowId: index + 1, observedAtMs: observedAtMs + index, anchor: null, row: null })),
    },
  };
}

async function save(value: StorageHistoryCheckpoint) {
  const storageKey = await key();
  const result = await saveStorageHistoryCheckpoint({ target: target(), key: storageKey, checkpoint: value, expectedHead: null });
  if (result.status !== 'saved') throw new Error('synthetic pending day did not promote');
  return { key: storageKey, ...result };
}

function withCoverage(state:'reading'|'ready'):Acquisition {
  const value=checkpoint('endpoints'),quota=value.preparingQuota!;
  delete value.preparingQuota;
  // The independent gap is strictly behind the analytical cursor. Its local
  // ordinal is unrelated to that cursor's global ordinal.
  value.effectiveDays.quota=[quota.day,'2026-05-30'];
  value.effectiveCursor={phase:'endpoints',day:'2026-05-30',after:null,ordinal:27,complete:false};
  const day=finishEffectiveQuotaDay(quota);
  if(!day)throw new Error('synthetic empty effective day unavailable');
  value.quotaCoverage={next:'analysis',refusedDays:[],pending:state==='ready'?{state,day}:{state,quota,
    after:{observedAtMs:quota.rows.at(-1)!.observedAtMs,occurrenceId:'synthetic-gap-2'}}};
  return value;
}

describe('effective pending-day checkpoint codec across acquisition phases', () => {
  it.each(['reading','ready'] as const)('roundtrips an independent %s gap without moving the analytical cursor',async state=>{
    const value=withCoverage(state),saved=await save(value);
    expect(await loadStorageHistoryCheckpoint({target:target(),key:saved.key})).toEqual({
      status:'ready',headDigest:saved.headDigest,partCount:saved.totalParts,checkpoint:value});
  });

  it('retains only a completed day after acquisition finishes',async()=>{
    const value=withCoverage('ready');
    const finished:StorageEffectiveHistoryCheckpoint={...value,phase:'finish',
      acquisition:{identity:value.identity,planAnchors:[],quotaRows:[]}};
    const saved=await save(finished);
    expect(await loadStorageHistoryCheckpoint({target:target(),key:saved.key})).toMatchObject({status:'ready',checkpoint:finished});
  });

  it.each(['unknown-key','variant','cursor','day','refused-duplicate','refused-ready','inline','reading-after-finish'] as const)(
    'rejects a malformed independent cache buffer: %s',async mismatch=>{
      const value=withCoverage(mismatch==='refused-ready'?'ready':'reading');
      const malformed=structuredClone(value) as any;
      if(mismatch==='unknown-key')malformed.quotaCoverage.extra=true;
      if(mismatch==='variant')malformed.quotaCoverage.pending.state='pending';
      if(mismatch==='cursor')malformed.quotaCoverage.pending.after.observedAtMs++;
      if(mismatch==='day')malformed.effectiveDays.quota=['2026-05-30'];
      if(mismatch==='refused-duplicate')malformed.quotaCoverage.refusedDays=['2026-05-29','2026-05-29'];
      if(mismatch==='refused-ready')malformed.quotaCoverage.refusedDays=['2026-05-29'];
      if(mismatch==='inline')malformed.preparingQuota=checkpoint('endpoints').preparingQuota;
      if(mismatch==='reading-after-finish'){
        malformed.phase='finish';malformed.acquisition={identity:value.identity,planAnchors:[],quotaRows:[]};
      }
      await expect(save(malformed)).rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
      expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
    });
  it.each(phases)('roundtrips a partial prepared day in %s without changing its ordinals or payload', async phase => {
    const value = checkpoint(phase), saved = await save(value);
    expect(await loadStorageHistoryCheckpoint({ target: target(), key: saved.key })).toEqual({
      status: 'ready', headDigest: saved.headDigest, partCount: saved.totalParts, checkpoint: value,
    });
  });

  it.each(['phase', 'complete', 'day', 'ordinal'] as const)('rejects a pending day with incompatible %s before staging', async mismatch => {
    const value = checkpoint('clusters');
    if (mismatch === 'phase') value.effectiveCursor.phase = 'plan';
    if (mismatch === 'complete') value.effectiveCursor.complete = true;
    if (mismatch === 'day') value.effectiveCursor.day = '2026-05-30';
    if (mismatch === 'ordinal') value.effectiveCursor.ordinal = 1;
    await expect(save(value)).rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
    expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
    expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_heads').first('n')).toBe(0);
  });

  it('rejects pending preparation after acquisition has finished', async () => {
    const value = checkpoint('endpoints');
    const finished = { ...value, phase: 'finish', acquisition: { identity: value.identity, planAnchors: [], quotaRows: [] } };
    await expect(save(finished as StorageHistoryCheckpoint)).rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
    expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
  });

  it.each(['phase', 'complete'] as const)('rejects a correctly hashed retained stage with a %s mismatch during decode', async mismatch => {
    const saved = await save(checkpoint('endpoints'));
    const oldDigest = await storageHistoryKeyDigest(saved.key);
    const stage = await target().prepare('SELECT control_json,manifest_json,authority_epoch FROM analytics_history_checkpoint_stages WHERE key_digest=? AND generation=?')
      .bind(oldDigest, saved.headDigest).first<{ control_json: string; manifest_json: string; authority_epoch: number }>();
    if (!stage) throw new Error('synthetic stage missing');
    const control = JSON.parse(stage.control_json);
    if (mismatch === 'phase') control.effectiveCursor.phase = 'plan';
    else control.effectiveCursor.complete = true;
    const controlText = canonicalJson(control);
    const malformedKey = { ...saved.key, dependencyDigest: 'd'.repeat(64) };
    const malformedDigest = await storageHistoryKeyDigest(malformedKey);
    const generation = await sha256Hex(canonicalJson({
      key: malformedKey, expectedHead: null, authorityEpoch: stage.authority_epoch,
      control: controlText, manifest: JSON.parse(stage.manifest_json),
    }));
    // This disposable fixture installs an internally hashed old/future writer
    // artifact. Keep all DB guards enabled and preserve the original stage, so
    // failure is attributable to semantic decoding rather than hash corruption.
    await target().batch([
      target().prepare(`INSERT INTO analytics_history_checkpoint_stages
        (key_digest,generation,source_id,owner_digest,day,dependency_digest,source_namespace,method,expected_head,owner_revision,authority_epoch,control_json,manifest_json,part_count)
        SELECT ?,?,source_id,owner_digest,day,?,source_namespace,method,NULL,owner_revision,authority_epoch,?,manifest_json,part_count
        FROM analytics_history_checkpoint_stages WHERE key_digest=? AND generation=?`)
        .bind(malformedDigest, generation, malformedKey.dependencyDigest, controlText, oldDigest, saved.headDigest),
      target().prepare(`INSERT INTO analytics_history_checkpoint_parts
        SELECT ?,?,part_index,sha256,payload_bytes,payload_json FROM analytics_history_checkpoint_parts WHERE key_digest=? AND generation=?`)
        .bind(malformedDigest, generation, oldDigest, saved.headDigest),
      target().prepare('INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired) VALUES(?,?,0)')
        .bind(malformedDigest, generation),
    ]);
    await expect(loadStorageHistoryCheckpoint({ target: target(), key: malformedKey }))
      .rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
    expect(await loadStorageHistoryCheckpoint({ target: target(), key: saved.key }))
      .toMatchObject({ status: 'ready', headDigest: saved.headDigest, checkpoint: checkpoint('endpoints') });
  });
});

function usagePreparation(state:'reading'|'ready'|'disabled'|'pending'):StorageEffectiveHistoryCheckpoint {
 const old=checkpoint('endpoints'),inputDay=old.effectiveCursor.day;
 const {preparingQuota:_,...base}=old;
 const observedAtMs=Date.parse(`${inputDay}T12:00:00.000Z`);
 const projection=reduceGraphDayProjection(inputDay,[],{rowsRead:1,events:[{sessionDigest:'d'.repeat(64),
  observedAtMs,provider:'openai_codex',accountScopeId:null,planBasis:null,planType:null,planEraId:null,
  kind:'priced',model:'gpt-5.6-sol',costNanousd:10}]});
 return {...base,phase:'finish',acquisition:{identity:base.identity,planAnchors:[],quotaRows:[]},
  effectiveDays:{quota:base.effectiveDays.quota,usage:[inputDay]},usagePreparation:state==='disabled'?{state}:
   state==='pending'?{state,rowsRead:200}:state==='ready'?{state,rowsRead:201,day:{projection}}:
    {state,rowsRead:201,day:{projection,lastObservedAtMs:observedAtMs},
    after:{observedAtMs,occurrenceId:'synthetic-usage-tail'}}};
}
describe('compact effective model usage preparation codec',()=>{
 it.each(['reading','ready'] as const)('replays an interrupted >30-part %s successor from the same durable head',async state=>{
  const original=await key(),usageKey=await storageGraphEffectiveCheckpointKey({...original,dependencyDigest:'b'.repeat(64)},true,5);
  const prior=usagePreparation(state);
  const first=await saveStorageHistoryCheckpoint({target:target(),key:usageKey,checkpoint:prior,expectedHead:null});
  if(first.status!=='saved')throw new Error('synthetic prior did not promote');
  const inputDay=prior.effectiveDays.usage[0]!,at=Date.parse(`${inputDay}T12:00:00.000Z`),rows=11_000;
  const projection=reduceGraphDayProjection(inputDay,[],{rowsRead:rows,events:Array.from({length:rows},(_,index)=>({
   sessionDigest:null,observedAtMs:at,provider:'openai_codex',
   accountScopeId:`account-track:v2:${index.toString(16).padStart(64,'0')}`,
   planBasis:'same_source_occurrence' as const,planType:'pro',planEraId:`plan-era:v1:${'b'.repeat(64)}`,
   kind:'priced' as const,model:'gpt-5.6-sol',costNanousd:10}))});
  const value:StorageEffectiveHistoryCheckpoint={...prior,usagePreparation:state==='ready'?{state,rowsRead:rows,day:{projection}}:
   {state,rowsRead:rows,day:{projection,lastObservedAtMs:at},after:{observedAtMs:at,occurrenceId:'synthetic-large-usage-tail'}}};
  expect(await storageHistoryCheckpointParts(usageKey,value)).toBeGreaterThan(30);
  let lost=false;
  const interrupted=new Proxy(target(),{get(database,key){
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    const result=await database.batch(statements);if(!lost){lost=true;throw new Error('synthetic committed usage checkpoint loss');}return result;
   };const result=Reflect.get(database,key);return typeof result==='function'?result.bind(database):result;
  }});
  await expect(saveStorageHistoryCheckpoint({target:interrupted,key:usageKey,checkpoint:value,
   expectedHead:first.headDigest,maxWrites:8})).rejects.toThrow('synthetic committed usage checkpoint loss');
  expect(await loadStorageHistoryCheckpoint({target:target(),key:usageKey})).toMatchObject({status:'ready',headDigest:first.headDigest,checkpoint:prior});
  let saved=await saveStorageHistoryCheckpoint({target:target(),key:usageKey,checkpoint:value,expectedHead:first.headDigest});
  for(let count=0;saved.status==='staging'&&count<4;count++)saved=await saveStorageHistoryCheckpoint({target:target(),
   key:usageKey,checkpoint:value,expectedHead:first.headDigest,cursor:saved.cursor});
  expect(saved.status).toBe('saved');
  let loaded=await loadStorageHistoryCheckpoint({target:target(),key:usageKey,maxParts:32});
  for(let count=0;loaded.status==='deferred'&&count<4;count++)loaded=await loadStorageHistoryCheckpoint({target:target(),
   key:usageKey,maxParts:32,cursor:loaded.cursor});
  expect(loaded).toMatchObject({status:'ready',checkpoint:value});
 },30_000);
 it.each(['reading','ready','disabled','pending'] as const)('roundtrips closed %s state under a separately versioned key',async state=>{
  const original=await key(),usageKey=await storageGraphEffectiveCheckpointKey({...original,dependencyDigest:'b'.repeat(64)},true,5);
  const value=usagePreparation(state);
  const saved=await saveStorageHistoryCheckpoint({target:target(),key:usageKey,checkpoint:value,expectedHead:null});
  expect(saved.status).toBe('saved');
  expect(await loadStorageHistoryCheckpoint({target:target(),key:usageKey})).toMatchObject({status:'ready',checkpoint:value});
  expect(await loadStorageHistoryCheckpoint({target:target(),key:original})).toMatchObject({status:'absent'});
 });
 it.each(['unknown','after','row-time','wrong-day','acquisition','quota-buffer','raw-session','counter-low','counter-high','counter-type'] as const)(
  'rejects an incompatible compact usage preparation: %s',async kind=>{
   const value=usagePreparation('reading') as any;
   if(kind==='unknown')value.usagePreparation.private=true;
   if(kind==='after')value.usagePreparation.after.observedAtMs++;
   if(kind==='row-time')value.usagePreparation.day.lastObservedAtMs--;
   if(kind==='wrong-day')value.effectiveDays.usage=['2026-05-30'];
   if(kind==='acquisition'){value.phase='acquisition';value.acquisition=checkpoint('endpoints').acquisition;}
   if(kind==='quota-buffer')value.quotaCoverage=withCoverage('ready').quotaCoverage;
   if(kind==='raw-session')value.usagePreparation.day.projection.usage.sessions[0].sessionDigest='synthetic-raw-session';
   if(kind==='counter-low')value.usagePreparation.rowsRead=0;
   if(kind==='counter-high')value.usagePreparation.rowsRead=1_000_001;
   if(kind==='counter-type')value.usagePreparation.rowsRead='201';
   await expect(save(value)).rejects.toThrow('STORAGE_HISTORY_CHECKPOINT_UNAVAILABLE');
   expect(await target().prepare('SELECT count(*) n FROM analytics_history_checkpoint_stages').first('n')).toBe(0);
  });
});
