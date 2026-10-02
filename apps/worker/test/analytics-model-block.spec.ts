import { env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { advanceAnalyticsModelBlock, appendModelBlockDependencies, readAnalyticsModelBlock } from '../src/analytics-model-block';
import { createD1InvocationBudget } from '../src/d1-invocation-budget';
import { modelBlockInputDays } from '../src/analytics-model-block-contract';
import { withMaintainedEffectiveDependencies } from '../src/storage-effective-dependency-summaries';
import { createSharedAnalyticsInputCache } from '../src/analytics-shared-input';
import { evaluateSharedModelDate } from '../src/analytics-shared-reducers';
import { modelHistoryWindow } from '../src/model-history-window';
import { readModelBlockJob, readRebasableModelBlockCheckpoint } from '../src/storage-analytics-model-block';
import type { ModelBlockCheckpoint } from '../src/analytics-model-block-contract';
import { captureStorageCommunityAuthority } from '../src/storage-community-authority';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };

const bindings = env as Bindings;
const sourceId = 'synthetic-model-block-integration';
const sourceNamespace = sourceId;
const source = () => bindings.USAGE_MONITOR_DB;
const target = () => bindings.STORAGE_ANALYTICS_DB;

function withoutFingerprint(value: object): object {
  const result = { ...value } as Record<string, unknown>;
  delete result.inputFingerprint;
  return result;
}

/** Every call is a fresh invocation. The independent D1 profiler checks the
 * runner's own combined source/target statement meter, including batches. */
async function advanceMeasured(owner: Awaited<ReturnType<typeof seedSharedAnalyticsCorpus>>['owner'],
  day: string, short = false, throughDay = day, steps = short ? 1 : 20,
  resumeCandidate?: ModelBlockCheckpoint) {
  const profile = createAnalyticsProfile();
  const measuredSource = profileAnalyticsDatabase(source(), 'source', profile, () => 'block');
  const measuredTarget = profileAnalyticsDatabase(target(), 'target', profile, () => 'block');
  const result = await advanceAnalyticsModelBlock({ source: measuredSource, target: measuredTarget,
    sourceId, sourceNamespace, owner, outputFromDay: day, outputThroughDay: throughDay,
    maxQueries: 950, maxSteps: steps, pageSize: short ? 1 : 200,
    ...(resumeCandidate ? { resumeCandidate } : {}),
    deadlineMs: Date.now() + 60_000 });
  const measured = summarizeAnalyticsProfile(profile);
  expect(measured.statements).toBe(result.queriesUsed);
  expect(result.queriesUsed).toBeLessThanOrEqual(950);
  expect(measured.metadataSamples).toBe(measured.statements - measured.failedStatements);
  return result;
}

it('carries a partial model selection across accepted same-owner v1.1 outside-window appends', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 130, graphDays: 2 });
  const day = corpus.graphDates[0]!;
  const first = await advanceMeasured(corpus.owner, day, false, day, 60);
  expect(first.status).toBe('deferred');
  const original = (await readModelBlockJob({ target: target(), identity: first.identity! }))!.checkpoint;
  expect(original.phase).toBe('select');
  expect(original.dependencies.length).toBeGreaterThan(1);
  const owner = await corpus.appendOutsideV11();
  expect(owner.ownerRevision).toBeGreaterThan(corpus.owner.ownerRevision);
  const candidate = await readRebasableModelBlockCheckpoint({ target: target(),
    identity: { ...first.identity!, ownerRevision: owner.ownerRevision,
      inputRevision: owner.inputRevision }, now: Date.now() });
  expect(candidate).toEqual(original);
  const resumed = await advanceMeasured(owner, day, true, day, 1, candidate!);
  expect(resumed.status).toBe('deferred');
  expect(resumed.identity!.ownerRevision).toBe(owner.ownerRevision);
  const carried = (await readModelBlockJob({ target: target(), identity: resumed.identity! }))!.checkpoint;
  expect(carried.dependencies.length).toBe(original.dependencies.length + 1);
  const nextOwner = await corpus.appendOutsideV11();
  const nextCandidate = await readRebasableModelBlockCheckpoint({ target: target(),
    identity: { ...resumed.identity!, ownerRevision: nextOwner.ownerRevision,
      inputRevision: nextOwner.inputRevision }, now: Date.now() });
  expect(nextCandidate).toEqual(carried);
  const nextResume = await advanceMeasured(nextOwner, day, true, day, 1, nextCandidate!);
  const carriedAgain = (await readModelBlockJob({ target: target(),
    identity: nextResume.identity! }))!.checkpoint;
  expect(carriedAgain.dependencies.length).toBe(carried.dependencies.length + 1);
  const selected = await advanceMeasured(nextOwner, day, false, day, 101);
  const selectedCheckpoint = (await readModelBlockJob({ target: target(),
    identity: selected.identity! }))!.checkpoint;
  expect(selectedCheckpoint.dependencies.length).toBeGreaterThan(carried.dependencies.length);
  const correctedOwner = await corpus.appendV11Day(corpus.correctionDay);
  const correctedIdentity = { ...selected.identity!, ownerRevision: correctedOwner.ownerRevision,
    inputRevision: correctedOwner.inputRevision };
  const staleCandidate = await readRebasableModelBlockCheckpoint({ target: target(),
    identity: correctedIdentity, now: Date.now() });
  expect(staleCandidate).toEqual(selectedCheckpoint);
  const corrected = await advanceMeasured(correctedOwner, day, true, day, 1, staleCandidate!);
  expect(corrected.status).toBe('deferred');
  const fresh = (await readModelBlockJob({ target: target(), identity: corrected.identity! }))!.checkpoint;
  expect(fresh.phase).toBe('select');
  expect(fresh.dependencies).toHaveLength(1);
});

it('selects a bounded cold maintained prefix and resumes in exact order with bulk day proofs', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 14, graphDays: 1 });
  const first = await advanceMeasured(corpus.owner, corpus.graphDates[0]!, true);
  const identity = first.identity!;
  const allDays = modelBlockInputDays(identity);
  const run = async (prefix: readonly {day:string;digest:string;hasQuota:boolean;hasUsage:boolean}[],
    stopAfter:number,individual=false,durable=false) => {
    const budget=createD1InvocationBudget(950);
    const profile=createAnalyticsProfile();
    const measuredSource=profileAnalyticsDatabase(source(),'source',profile,()=> 'selection');
    const measuredTarget=profileAnalyticsDatabase(target(),'target',profile,()=> 'selection');
    const attached=budget.wrap(withMaintainedEffectiveDependencies(measuredSource,measuredTarget,sourceId,sourceNamespace));
    const chosen:typeof prefix[number][]=[];
    await appendModelBlockDependencies(attached,identity,corpus.owner,prefix,
      queries=>{if(budget.remainingQueries<queries)throw new Error('MODEL_BLOCK_TEST_QUERY_BUDGET');},
      dependency=>chosen.push(dependency),stopAfter,
      individual?()=>1:durable?()=>stopAfter-prefix.length-chosen.length:undefined);
    const measured=summarizeAnalyticsProfile(profile);
    expect(measured.statements).toBe(budget.queriesUsed);
    expect(budget.queriesUsed).toBeLessThanOrEqual(950);
    return {chosen,queries:budget.queriesUsed,rowsRead:measured.rowsRead};
  };
  const initial=await run([],4,false,true);
  expect(initial.chosen.map(value=>value.day)).toEqual(allDays.slice(0,4));
  const resumed=await run(initial.chosen,16,false,true);
  expect(resumed.chosen.map(value=>value.day)).toEqual(allDays.slice(4,16));
  const complete=[...initial.chosen,...resumed.chosen];
  const warmed=await run([],16);
  const individual=await run([],16,true);
  expect(warmed.chosen).toEqual(complete);
  expect(individual.chosen).toEqual(complete);
  expect(warmed.queries).toBeLessThan(resumed.queries+initial.queries);
  expect(warmed.queries).toBeLessThan(individual.queries);
  expect(warmed.rowsRead).toBeLessThan(individual.rowsRead);
  console.log(JSON.stringify({schema:'model-block-bulk-day-local-profile-v1',
    coldPrefix:{queries:initial.queries,rowsRead:initial.rowsRead},
    coldResume:{queries:resumed.queries,rowsRead:resumed.rowsRead},
    warmBatch:{queries:warmed.queries,rowsRead:warmed.rowsRead},
    warmIndividual:{queries:individual.queries,rowsRead:individual.rowsRead}}));
  // readVerified uses this no-selection-limit path. A plain source lacks the
  // maintained bulk API, so its native headers must cover the full >16-day
  // request after the bounded capability probe.
  const nativeRanges:Array<readonly [unknown,unknown]>=[];
  const observedSource=new Proxy(source(),{get(db,key){
    if(key==='prepare')return(sql:string)=>{
      const statement=db.prepare(sql);
      if(!sql.includes('FROM telemetry_v1_chunks c')||!sql.includes('JOIN typed_v1_event_sources event'))
        return statement;
      return new Proxy(statement,{get(prepared,method){
        if(method==='bind')return(...values:unknown[])=>{
          nativeRanges.push([values[3],values[4]]);
          return Reflect.apply(prepared.bind,prepared,values) as D1PreparedStatement;
        };
        const value:unknown=Reflect.get(prepared,method);
        return typeof value==='function'?value.bind(prepared):value;
      }});
    };
    const value:unknown=Reflect.get(db,key);
    return typeof value==='function'?value.bind(db):value;
  }});
  const nativeBudget=createD1InvocationBudget(950),native:typeof complete=[];
  await appendModelBlockDependencies(nativeBudget.wrap(observedSource),identity,corpus.owner,[],
    queries=>{if(nativeBudget.remainingQueries<queries)throw new Error('MODEL_BLOCK_TEST_QUERY_BUDGET');},
    dependency=>native.push(dependency),20);
  expect(native.slice(0,16)).toEqual(complete);
  expect(native.map(value=>value.day)).toEqual(allDays.slice(0,20));
  expect(nativeRanges.some(([from,through])=>from===allDays[0]&&through===allDays[19])).toBe(true);
  expect(nativeBudget.queriesUsed).toBeLessThanOrEqual(950);
});

it('uses durable shared feature days to prepare model inputs across bounded invocations', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 14, graphDays: 2 });
  const day = corpus.graphDates[0]!;
  let sourcePages = 0, complete: Awaited<ReturnType<typeof advanceAnalyticsModelBlock>> | null = null;
  for (let invocation = 0; invocation < 120; invocation++) {
    const result = await advanceAnalyticsModelBlock({ source: source(), target: target(),
      sourceId, sourceNamespace, owner: corpus.owner, outputFromDay: day,
      outputThroughDay: day, maxQueries: 950, maxSteps: 20,
      deadlineMs: Date.now() + 20_000, sharedFeatures: true });
    expect(result.queriesUsed).toBeLessThanOrEqual(950);
    sourcePages += result.sourcePages;
    if (result.status === 'complete') { complete = result; break; }
    expect(result.status).toBe('deferred');
  }
  expect(complete).not.toBeNull();
  expect(sourcePages).toBe(0);
  expect(await target().prepare(`SELECT count(*) n FROM analytics_shared_feature_days
    WHERE owner_digest=? AND state='complete'`).bind(corpus.owner.ownerDigest).first<number>('n'))
    .toBeGreaterThan(0);
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: complete!.identity!, owner: corpus.owner })).toEqual(complete!.outputs);
});

async function finishBlock(owner: Awaited<ReturnType<typeof seedSharedAnalyticsCorpus>>['owner'],
  day: string) {
  let preparedDays = 0, reusedDays = 0, sourcePages = 0;
  for (let invocation = 0; invocation < 160; invocation++) {
    const result = await advanceMeasured(owner, day);
    preparedDays += result.preparedDays;
    reusedDays += result.reusedDays;
    sourcePages += result.sourcePages;
    expect(result.identity).not.toBeNull();
    if (result.status === 'complete') {
      expect(result.modelDatesCompleted).toBeGreaterThanOrEqual(0);
      return { result, preparedDays, reusedDays, sourcePages, invocations: invocation + 1 };
    }
    expect(result.status).toBe('deferred');
    expect(await readAnalyticsModelBlock({ source: source(), target: target(),
      identity: result.identity!, owner })).toBeNull();
  }
  throw new Error('synthetic model block did not finish within bounded invocations');
}

it('resumes a durable mixed-format model day with exact output, correction reuse and erasure fencing', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 14, graphDays: 2 });
  const day = corpus.graphDates[0]!;
  const nextDay = corpus.graphDates[1]!;

  // A one-step, one-row invocation must leave a recoverable private checkpoint.
  const partial = await advanceMeasured(corpus.owner, day, true);
  expect(partial.status).toBe('deferred');
  expect(partial.identity).not.toBeNull();
  expect(partial.modelDatesCompleted).toBe(0);
  const selected = await readModelBlockJob({ target: target(), identity: partial.identity! });
  expect(selected?.checkpoint.phase).toBe('select');
  expect(selected?.checkpoint.dependencies).toHaveLength(1);
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: partial.identity!, owner: corpus.owner })).toBeNull();
  expect(await target().prepare('SELECT state FROM analytics_model_blocks WHERE owner_digest=?')
    .bind(corpus.owner.ownerDigest).first('state')).toBe('pending');

  // A global ingestion freshness tick can belong to another owner. It must
  // not change this owner's private calculation identity or discard its job.
  const ownerBefore = await source().prepare(`SELECT revision,authority_epoch,state
    FROM storage_owner_revisions WHERE owner_digest=?`)
    .bind(corpus.owner.ownerDigest).first();
  const authorityBefore = await captureStorageCommunityAuthority(source(), { sourceId, sourceNamespace });
  await source().prepare(`UPDATE community_snapshot_mutation_control
    SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1`).run();
  const authorityAfter = await captureStorageCommunityAuthority(source(), { sourceId, sourceNamespace });
  expect(authorityAfter.sourceEpoch).toBeGreaterThan(authorityBefore.sourceEpoch);
  expect(await source().prepare(`SELECT revision,authority_epoch,state
    FROM storage_owner_revisions WHERE owner_digest=?`)
    .bind(corpus.owner.ownerDigest).first()).toEqual(ownerBefore);
  const globalResume = await advanceMeasured(corpus.owner, day, true);
  expect(globalResume.status).toBe('deferred');
  expect(globalResume.identity).toEqual(partial.identity);

  const cold = await finishBlock(corpus.owner, day);
  expect(cold.sourcePages).toBeGreaterThan(0);
  expect(cold.preparedDays).toBeGreaterThan(0);
  expect(cold.result.identity).toEqual(partial.identity);
  const prepared = await readModelBlockJob({ target: target(), identity: cold.result.identity! });
  const empty = prepared!.checkpoint.dependencies.find(value => !value.hasQuota && !value.hasUsage);
  expect(empty).toBeDefined();
  expect(await target().prepare(`SELECT COUNT(*) AS count FROM analytics_graph_day_values
    WHERE source_id=? AND owner_digest=? AND day=?`).bind(sourceId, corpus.owner.ownerDigest, empty!.day)
    .first<number>('count')).toBe(0);
  const completed = await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: cold.result.identity!, owner: corpus.owner });
  expect(completed).toEqual(cold.result.outputs);
  expect(completed).toHaveLength(1);
  const first = completed![0]!;
  expect(first.day).toBe(day);
  expect(first.value.status).toBe('ready');
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect((first.value as { inputFingerprint?: string }).inputFingerprint).toBe(first.fingerprint);

  const reference = async(owner: typeof corpus.owner, outputDay: string) => {
    const cache = createSharedAnalyticsInputCache({ source: source(), sourceNamespace });
    const snapshot = await cache.load({ owner, fromDay: modelHistoryWindow(outputDay).fromDay,
      throughDay: outputDay, deadlineMs: Date.now() + 60_000 });
    const pin = await snapshot.pinForDate(outputDay);
    const value = await evaluateSharedModelDate({ pin, day: outputDay, ownerDigest: owner.ownerDigest,
      days: snapshot.days });
    await snapshot.assertCurrent();
    return value;
  };
  expect(withoutFingerprint(first.value)).toEqual(withoutFingerprint(await reference(corpus.owner, day)));
  await source().prepare(`UPDATE community_snapshot_mutation_control
    SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1`).run();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: cold.result.identity!, owner: corpus.owner })).toEqual(completed);
  // Runtime activation is part of the effective reader's calculation policy.
  await source().prepare("UPDATE telemetry_v12_runtime SET state='staged' WHERE id=1").run();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: cold.result.identity!, owner: corpus.owner })).toBeNull();
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: cold.result.identity!, owner: corpus.owner })).toEqual(completed);

  // Interrupt a second output date after its durable job has begun. A
  // corrected accepted v1.2 day changes the exact source identity mid-run.
  const interrupted = await advanceMeasured(corpus.owner, nextDay, true);
  expect(interrupted.status).toBe('deferred');
  expect(interrupted.identity).not.toBeNull();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: interrupted.identity!, owner: corpus.owner })).toBeNull();
  const correctedOwner = await corpus.mutateCorrection();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: cold.result.identity!, owner: correctedOwner })).toBeNull();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: interrupted.identity!, owner: correctedOwner })).toBeNull();
  expect((await advanceMeasured(corpus.owner, nextDay)).status).toBe('stale');
  const corrected = await finishBlock(correctedOwner, nextDay);
  expect(corrected.result.identity).not.toEqual(interrupted.identity);
  expect(corrected.reusedDays).toBeGreaterThan(0);
  const correctedOutputs = await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: corrected.result.identity!, owner: correctedOwner });
  expect(correctedOutputs).toEqual(corrected.result.outputs);
  expect(correctedOutputs).toHaveLength(1);
  expect(correctedOutputs![0]!.value.status).toBe('ready');
  expect(withoutFingerprint(correctedOutputs![0]!.value))
    .toEqual(withoutFingerprint(await reference(correctedOwner, nextDay)));

  // Source terminal state can precede target receipt delivery. A retained
  // target job must already be unreadable under the source owner fence.
  const targetRowsBefore = await target().prepare(`SELECT COUNT(*) AS count
    FROM analytics_model_blocks WHERE owner_digest=?`)
    .bind(correctedOwner.ownerDigest).first<number>('count');
  expect(targetRowsBefore).toBeGreaterThan(0);
  await source().prepare(`UPDATE storage_owner_revisions SET state='erased'
    WHERE owner_digest=?`).bind(correctedOwner.ownerDigest).run();
  expect(await target().prepare(`SELECT COUNT(*) AS count FROM analytics_model_blocks
    WHERE owner_digest=?`).bind(correctedOwner.ownerDigest).first<number>('count'))
    .toBe(targetRowsBefore);
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: corrected.result.identity!, owner: correctedOwner })).toBeNull();
  expect((await advanceMeasured(correctedOwner, nextDay)).status).toBe('stale');

  // The later target receipt must retire the still-present private job and
  // block another attempt independently of the source-side refusal above.
  await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
    .bind(sourceId, correctedOwner.ownerDigest, 'e'.repeat(64), 1, 1,
      correctedOwner.authorityEpoch, correctedOwner.authorityEpoch).run();
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: corrected.result.identity!, owner: correctedOwner })).toBeNull();
  expect(await target().prepare('SELECT COUNT(*) AS count FROM analytics_model_blocks WHERE owner_digest=?')
    .bind(correctedOwner.ownerDigest).first<number>('count')).toBe(0);
  const afterErasure = await advanceMeasured(correctedOwner, nextDay);
  expect(['stale', 'unsupported']).toContain(afterErasure.status);
  expect(afterErasure.outputs).toBeUndefined();
}, 300_000);

it('keeps a private output prefix hidden and falls back when a prepared head retires', async () => {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), bindings, sourceId, sourceNamespace);
  const corpus = await seedSharedAnalyticsCorpus({ source: source(), target: target(),
    sourceId, sourceNamespace, calendarDays: 14, graphDays: 2 });
  const [firstDay, secondDay] = corpus.graphDates;
  expect(firstDay).toBeDefined();
  expect(secondDay).toBeDefined();
  let prefix: Awaited<ReturnType<typeof advanceMeasured>> | null = null;
  for (let invocation = 0; invocation < 160; invocation++) {
    const prior = prefix?.identity
      ? await readModelBlockJob({ target: target(), identity: prefix.identity }) : null;
    const remaining = prior ? prior.checkpoint.dependencies.length - prior.checkpoint.inputIndex : Infinity;
    const result = await advanceMeasured(corpus.owner, firstDay!, false, secondDay!,
      remaining <= 30 ? 1 : 20);
    expect(result.status).toBe('deferred');
    expect(result.identity).not.toBeNull();
    const stored = await readModelBlockJob({ target: target(), identity: result.identity! });
    expect(stored).not.toBeNull();
    prefix = result;
    if (stored!.checkpoint.outputs.length === 1) {
      expect(stored!.checkpoint.phase).toBe('emit');
      expect(stored!.checkpoint.outputs[0]!.day).toBe(firstDay);
      expect(stored!.checkpoint.outputs[0]!.value.status).toBe('ready');
      break;
    }
  }
  expect(prefix).not.toBeNull();
  const head = await readModelBlockJob({ target: target(), identity: prefix!.identity! });
  expect(head?.checkpoint.outputs).toHaveLength(1);
  expect(await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: prefix!.identity!, owner: corpus.owner })).toBeNull();

  // Retire one optional prepared usage head needed by the second window. The
  // paged effective model path must finish it without exposing the prefix.
  const retainedDay = await target().prepare(`SELECT day FROM analytics_graph_day_values
    WHERE source_id=? AND owner_digest=? AND day>=? AND day<=? AND source_layout='effective-usage'
    ORDER BY day LIMIT 1`).bind(sourceId, corpus.owner.ownerDigest,
    modelHistoryWindow(secondDay!).fromDay, firstDay).first<string>('day');
  expect(retainedDay).not.toBeNull();
  const retired = await target().prepare(`DELETE FROM analytics_graph_day_values
    WHERE source_id=? AND owner_digest=? AND day=? AND source_layout='effective-usage'`)
    .bind(sourceId, corpus.owner.ownerDigest, retainedDay).run();
  expect(retired.meta.changes).toBe(1);
  let completed: Awaited<ReturnType<typeof advanceMeasured>> | null = null;
  for (let invocation = 0; invocation < 30; invocation++) {
    const result = await advanceMeasured(corpus.owner, firstDay!, false, secondDay!);
    if (result.status === 'complete') { completed = result; break; }
    expect(result.status).toBe('deferred');
    expect(await readAnalyticsModelBlock({ source: source(), target: target(),
      identity: result.identity!, owner: corpus.owner })).toBeNull();
  }
  expect(completed).not.toBeNull();
  expect(completed!.identity).toEqual(prefix!.identity);
  // Even native fallback results stay private until the whole block is
  // independently verified and adopted by the graph adapter.
  expect(await target().prepare(`SELECT COUNT(*) AS count FROM analytics_community_graph_results`)
    .first<number>('count')).toBe(0);
  const outputs = await readAnalyticsModelBlock({ source: source(), target: target(),
    identity: completed!.identity!, owner: corpus.owner });
  expect(outputs).toEqual(completed!.outputs);
  expect(outputs?.map(output => output.day)).toEqual([firstDay, secondDay]);
  expect(outputs?.every(output => output.value.status === 'ready')).toBe(true);
  expect(outputs?.[0]).toEqual(head!.checkpoint.outputs[0]);
  const snapshot = await createSharedAnalyticsInputCache({ source: source(), sourceNamespace }).load({
    owner: corpus.owner, fromDay: modelHistoryWindow(firstDay!).fromDay,
    throughDay: secondDay!, deadlineMs: Date.now() + 60_000 });
  for (const output of outputs!) {
    const pin = await snapshot.pinForDate(output.day);
    const reference = await evaluateSharedModelDate({ pin, day: output.day,
      ownerDigest: corpus.owner.ownerDigest, days: snapshot.days });
    expect(withoutFingerprint(output.value)).toEqual(withoutFingerprint(reference));
    expect((output.value as { inputFingerprint?: string }).inputFingerprint).toBe(output.fingerprint);
  }
  await snapshot.assertCurrent();
}, 300_000);
