import { env, reset, type D1Migration } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from '@app-usagemonitor/telemetry-contract';
import { advanceAnalyticsModelBlock, appendModelBlockDependencies, ModelBlockSourceChanged,
  readVerifiedAnalyticsModelBlock } from '../src/analytics-model-block';
import { planHistoricalModelBlockRanges, type ModelBlockCheckpoint, type ModelBlockDependency,
  type ModelBlockIdentity } from '../src/analytics-model-block-contract';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from '../src/device-auth';
import { ensureModelBlockJob, modelBlockJobKey, prepareModelBlockAdmission, readModelBlockJob } from '../src/storage-analytics-model-block';
import { captureStorageGraphScope, computeStorageGraphResult, readStorageGraphResult } from '../src/storage-community-graph';
import * as graphFacade from '../src/storage-community-graph';
import { withMaintainedEffectiveDependencies } from '../src/storage-effective-dependency-summaries';
import { advanceEffectiveDependencyCoverage } from '../src/storage-effective-selective-dependencies';
import { advanceStorageModelBlockGraphWork } from '../src/storage-community-graph-model-block';
import { captureStorageCommunityAuthority, readStorageCommunityOwnerPage } from '../src/storage-community-authority';
import { publishStorageCommunityModelDay } from '../src/storage-community-graph-publication';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { registerTelemetryV11DayManifest } from '../src/telemetry-v11-repository';
import { readEffectiveTelemetryOwnerDayPage } from '../src/telemetry-usage-effective-reader';
import { persistTypedV11StagedChunk } from '../src/typed-v11-admission';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from './fixtures/shared-analytics-corpus';
import { createAnalyticsProfile, profileAnalyticsDatabase, summarizeAnalyticsProfile } from './helpers/analytics-profile';
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from './helpers/telemetry-v11';

type Bindings = Env & { STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const b = env as Bindings, sourceId = 'synthetic-block-adoption', sourceNamespace = sourceId;
const source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const bindings = () => ({ source: source(), target: target(), sourceId, sourceNamespace });

async function setup(crossDayLinks = false) {
  await reset();
  await initializeSharedAnalyticsCorpusDatabases(source(), target(), b, sourceId, sourceNamespace);
  const nowMs = Date.now(), today = new Date(nowMs).toISOString().slice(0, 10);
  const range = planHistoricalModelBlockRanges(today).find(value =>
    Date.parse(value.outputThroughDay) - Date.parse(value.outputFromDay) === 31 * 86_400_000)!;
  const corpus = await seedSharedAnalyticsCorpus({ ...bindings(), anchorDay: range.outputThroughDay,
    calendarDays: 14, graphDays: 2, crossDayLinks });
  const scope = await captureStorageGraphScope(source(), { owner: corpus.owner,
    day: range.outputThroughDay, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
  return { corpus, nowMs, range, scope };
}
async function completed(context: Awaited<ReturnType<typeof setup>>) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = await advanceAnalyticsModelBlock({ ...bindings(), owner: context.corpus.owner,
      ...context.range, maxQueries: 950, deadlineMs: Date.now() + 60_000 });
    if (next.status === 'complete') {
      const job = await readModelBlockJob({ target: target(), identity: next.identity! });
      expect(job?.checkpoint.phase).toBe('complete');
      return { identity: next.identity!, checkpoint: job!.checkpoint };
    }
    expect(next.status).toBe('deferred');
  }
  throw new Error('synthetic block failed to finish');
}
async function replaceJob(identity: ModelBlockIdentity, checkpoint: ModelBlockCheckpoint) {
  await target().prepare('DELETE FROM analytics_model_blocks WHERE job_key=?').bind(await modelBlockJobKey(identity)).run();
  const todayDay = new Date().toISOString().slice(0, 10);
  const admission = await prepareModelBlockAdmission({ target: target(), identity, todayDay, now: Date.now(),
    assertSourceCurrent: async () => undefined });
  expect(admission).not.toBeNull();
  expect(await ensureModelBlockJob({ target: target(), identity, initial: checkpoint, now: Date.now(),
    admission: admission!, historicalTodayDay: todayDay })).toBe(true);
  return admission!;
}
const graphRows = () => target().prepare('SELECT COUNT(*) n FROM analytics_community_graph_results').first<number>('n');

async function appendAcceptedV11Day(device: Awaited<ReturnType<typeof createV11DeviceFixture>>, day: string,
  options: { prior?: readonly { day: string; manifestId: string; manifestDigest: string }[];
    withUsage?: boolean; activate?: boolean } = {}) {
  const prepared = await makeV11Day(day, options.withUsage === false ? {} : {
    usage: [v11UsageRecord(day, 'd')],
  });
  await registerTelemetryV11DayManifest(source(), device, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-outside-window:${chunk.chunkDigest}`);
    const principal = await authenticateDevice(source(), device.authorization);
    const upload = await createDeviceUploadAuthorization(source(), principal, envelopeDigest, 4096);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 4096, contentType: 'application/json' });
    await persistTypedV11StagedChunk(source(), device, chunk, {
      sourceNamespace, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/outside-window/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  const ready = await registerTelemetryV11DayManifest(source(), device, prepared.manifest);
  if (options.activate === false) return ready;
  const predecessor = await createTelemetryV11DomainPredecessor(source(), device);
  const days = [...(options.prior ?? []), ready].sort((left, right) => left.day.localeCompare(right.day));
  if (days[0]!.day > predecessor.fromDay || days.at(-1)!.day < predecessor.throughDay)
    throw new Error(`synthetic predecessor range ${predecessor.fromDay}..${predecessor.throughDay} exceeds ${days[0]!.day}..${days.at(-1)!.day}`);
  const manifest: TelemetryV11DomainManifest = {
    schemaVersion: 'telemetry-domain-manifest-v1.1', fromDay: days[0]!.day,
    throughDay: days.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: days.map(value => ({ day: value.day, manifestId: value.manifestId,
      manifestDigest: value.manifestDigest })),
    manifestDigest: '0'.repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), device, manifest);
  return ready;
}

it('adopts only complete source-proved outputs, validates both fingerprint contracts and preserves analytical fields', async () => {
  const context = await setup(), { corpus, scope, nowMs, range } = context;
  const partial = await advanceAnalyticsModelBlock({ ...bindings(), owner: corpus.owner,
    ...range, maxSteps: 1, deadlineMs: Date.now() + 60_000 });
  expect(partial.status).toBe('deferred');
  expect(await readVerifiedAnalyticsModelBlock({ ...bindings(), identity: partial.identity!,
    owner: corpus.owner, check: () => undefined })).toBeNull();
  expect(await graphRows()).toBe(0);
  const { identity, checkpoint } = await completed(context);
  expect(await graphRows()).toBe(0);
  expect(checkpoint.outputs).toHaveLength(32);
  const output = checkpoint.outputs.find(value => value.day === scope.day)!;
  expect(output.value.status).toBe('ready');
  expect(output.fingerprint).not.toBe(scope.pin.fingerprint);

  // Valid framing/hash alone cannot prove dependencies. Simulate a stale
  // internal producer without bypassing any storage validator or trigger.
  const mismatched = { ...checkpoint, dependencies: checkpoint.dependencies.map((value, index) =>
    index === 0 ? { ...value, digest: 'e'.repeat(64) } : value) };
  const admission = await replaceJob(identity, mismatched);
  await expect(readVerifiedAnalyticsModelBlock({ ...bindings(), identity, owner: corpus.owner, admission,
    check: () => undefined })).rejects.toBeInstanceOf(ModelBlockSourceChanged);
  expect(await advanceStorageModelBlockGraphWork({ ...bindings(), scope, nowMs, maxQueries: 950,
    deadlineMs: Date.now() + 60_000 })).toMatchObject({ state: 'deferred', reason: 'source_changed' });
  expect(await graphRows()).toBe(0);

  const wrongPin = { ...checkpoint, outputs: checkpoint.outputs.map(value => value.day !== scope.day ? value : {
    ...value, fingerprint: 'f'.repeat(64), value: value.value.status === 'ready'
      ? { ...value.value, inputFingerprint: 'f'.repeat(64) } : value.value,
  }) };
  await replaceJob(identity, wrongPin);
  await expect(advanceStorageModelBlockGraphWork({ ...bindings(), scope, nowMs, maxQueries: 950,
    deadlineMs: Date.now() + 60_000 })).rejects.toThrow('MODEL_BLOCK_ADOPTION_PROOF_INVALID');
  expect(await graphRows()).toBe(0);
  await replaceJob(identity, checkpoint);

  const profile = createAnalyticsProfile();
  const adopted = await advanceStorageModelBlockGraphWork({ ...bindings(),
    source: profileAnalyticsDatabase(source(), 'source', profile, () => 'adopt'),
    target: profileAnalyticsDatabase(target(), 'target', profile, () => 'adopt'),
    scope, nowMs, maxQueries: 950, deadlineMs: Date.now() + 60_000 });
  expect(adopted).toMatchObject({ state: 'complete', reused: false });
  expect(adopted.adoptedDates).toBeGreaterThan(0);
  expect(adopted.queriesUsed).toBe(summarizeAnalyticsProfile(profile).statements);
  expect(adopted.queriesUsed).toBeLessThanOrEqual(950);
  const native = await readStorageGraphResult(bindings(), scope);
  expect(native?.composition).toEqual({ ...output.value, inputFingerprint: scope.pin.fingerprint });
  const row = await target().prepare(`SELECT payload_json,payload_fingerprint,source_kind
    FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND day=? AND metric='model'`)
    .bind(sourceId, corpus.owner.ownerDigest, scope.day)
    .first<{ payload_json: string; payload_fingerprint: string; source_kind: string }>();
  expect(row).toMatchObject({ payload_fingerprint: scope.pin.fingerprint, source_kind: 'effective' });
  expect(row?.payload_json).toBe(canonicalJson(native!.composition));
  // Reusing a complete, validated native result requires no private job access.
  // The only permitted write is the native graph's exact input-revision proof
  // refresh, and an unchanged replay must not need even that write.
  let refreshWrites = 0;
  const warmTarget = new Proxy(target(), { get(database, key) {
    if (key === 'prepare') return (sql: string) => {
      if (/analytics_model_block/iu.test(sql))
        throw new Error('unexpected private-job work on unchanged replay');
      if (/^\s*(?:INSERT|UPDATE|DELETE)/iu.test(sql)) {
        if (!/^\s*UPDATE analytics_community_graph_results SET input_revision=\?\s+WHERE\b/iu.test(sql)
          || !/\bAND input_revision<\?/iu.test(sql))
          throw new Error('unexpected graph mutation on unchanged replay');
        refreshWrites++;
      }
      return database.prepare(sql);
    };
    const value = Reflect.get(database, key, database);
    return typeof value === 'function' ? value.bind(database) : value;
  } });
  const warm = await advanceStorageModelBlockGraphWork({ ...bindings(), target: warmTarget,
    scope, nowMs, maxQueries: 25, deadlineMs: Date.now() + 60_000 });
  expect(warm).toMatchObject({ state: 'complete', reused: true, adoptedDates: 0 });
  expect(warm.queriesUsed).toBeLessThanOrEqual(20);
  expect(refreshWrites).toBe(0);
  // An independently advancing target must still reject this cached result.
  await target().prepare(`UPDATE analytics_owner_state SET revision=revision+1
    WHERE source_id=? AND owner_digest=?`).bind(sourceId, corpus.owner.ownerDigest).run();
  expect(await advanceStorageModelBlockGraphWork({ ...bindings(), target: warmTarget,
    scope, nowMs, maxQueries: 25, deadlineMs: Date.now() + 60_000 }))
    .toMatchObject({ state: 'deferred', reason: 'source_changed', adoptedDates: 0 });
}, 180_000);

it('refreshes a proved historical row after an accepted append beyond its window and publishes current cohort proof', async () => {
  const { corpus, nowMs, range } = await setup();
  const device = await createV11DeviceFixture(source(), {
    participantId: 'participant:synthetic-warm-append', grant: true });
  const appendDay = new Date(Date.parse(`${corpus.sessionDay}T00:00:00.000Z`) + 86_400_000)
    .toISOString().slice(0, 10);
  expect(corpus.sessionDay < appendDay).toBe(true);
  const throughDay = new Date(nowMs).toISOString().slice(0, 10);
  const initialDays: { day: string; manifestId: string; manifestDigest: string }[] = [];
  for (let epoch = Date.parse(`${corpus.sessionDay}T00:00:00.000Z`);
    epoch <= Date.parse(`${throughDay}T00:00:00.000Z`); epoch += 86_400_000) {
    const day = new Date(epoch).toISOString().slice(0, 10);
    initialDays.push(await appendAcceptedV11Day(device, day, {
      prior: initialDays, withUsage: false, activate: day === throughDay,
    }));
  }
  const owner = (await readStorageCommunityOwnerPage(source()))
    .find(value => value.participantId === device.participantId);
  if (!owner?.ownerDigest) throw new Error('synthetic append owner unavailable');
  const blockOwner = owner as typeof owner & { ownerDigest: string };
  expect(owner.hasEffective).toBe(true);
  await target().prepare(`INSERT INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
    .bind(sourceId, owner.ownerDigest, owner.ownerRevision, owner.authorityEpoch, 'active').run();
  const scope = await captureStorageGraphScope(source(), { owner,
    day: corpus.sessionDay, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
  let blockComplete = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = await advanceAnalyticsModelBlock({ ...bindings(), owner: blockOwner, ...range,
      maxQueries: 950, deadlineMs: Date.now() + 60_000 });
    if (next.status === 'complete') { blockComplete = true; break; }
    expect(next.status).toBe('deferred');
  }
  expect(blockComplete).toBe(true);
  expect(await advanceStorageModelBlockGraphWork({ ...bindings(), scope, nowMs,
    maxQueries: 950, deadlineMs: Date.now() + 60_000 }))
    .toMatchObject({ state: 'complete' });
  const readRow = () => target().prepare(`SELECT input_revision,dependency_digest,payload_json,payload_sha256,computed_ms
    FROM analytics_community_graph_results WHERE source_id=? AND owner_digest=? AND day=? AND metric='model'`)
    .bind(sourceId, owner.ownerDigest, scope.day).first<{
      input_revision: number; dependency_digest: string; payload_json: string;
      payload_sha256: string; computed_ms: number }>();
  const before = await readRow();
  expect(before?.input_revision).toBe(owner.inputRevision);
  const compositionBefore = (await readStorageGraphResult(bindings(), scope))?.composition;
  expect(compositionBefore).toBeDefined();

  await appendAcceptedV11Day(device, appendDay, {
    prior: initialDays.filter(value => value.day !== appendDay),
  });
  const corrected = (await readStorageCommunityOwnerPage(source()))
    .find(value => value.participantId === device.participantId)!;
  expect(corrected.inputRevision).toBeGreaterThan(owner.inputRevision);
  await target().prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
    WHERE source_id=? AND owner_digest=? AND state='active'`)
    .bind(corrected.ownerRevision, corrected.authorityEpoch, sourceId, corrected.ownerDigest).run();
  const currentScope = await captureStorageGraphScope(source(), { owner: corrected,
    day: corpus.sessionDay, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
  expect(currentScope.dependencyDigest).toBe(scope.dependencyDigest);
  expect(currentScope.pin.fingerprint).toBe(scope.pin.fingerprint);
  const reused = await advanceStorageModelBlockGraphWork({ ...bindings(), scope: currentScope,
    nowMs: Date.now(), maxQueries: 50, deadlineMs: Date.now() + 60_000 });
  expect(reused).toMatchObject({ state: 'complete', reused: true, adoptedDates: 0 });
  expect(reused.queriesUsed).toBeLessThanOrEqual(50);
  const after = await readRow();
  expect(after).toMatchObject({
    input_revision: corrected.inputRevision, dependency_digest: before!.dependency_digest,
    payload_json: before!.payload_json, payload_sha256: before!.payload_sha256,
    computed_ms: before!.computed_ms,
  });
  expect((await readStorageGraphResult(bindings(), currentScope))?.composition).toEqual(compositionBefore);

  for (const cohortOwner of (await readStorageCommunityOwnerPage(source()))
    .filter(value => value.participantId !== device.participantId)) {
    if (cohortOwner.participantId !== corpus.participantId) {
      await target().prepare(`INSERT INTO analytics_owner_state
        (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
        .bind(sourceId, cohortOwner.ownerDigest, cohortOwner.ownerRevision,
          cohortOwner.authorityEpoch, 'active').run();
    }
    const cohortScope = await captureStorageGraphScope(source(), { owner: cohortOwner,
      day: corpus.sessionDay, metric: 'model', sourceId, sourceNamespace, preparedFold: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      const computed = await computeStorageGraphResult(bindings(), cohortScope, {
        maxQueries: 950, deadlineMs: Date.now() + 60_000, preparedFold: true });
      if (computed.state === 'complete') break;
      if (attempt === 19) throw new Error(`synthetic cohort owner did not complete: ${computed.reason}`);
    }
  }
  expect(await publishStorageCommunityModelDay(bindings(), { day: corpus.sessionDay }))
    .toMatchObject({ state: 'published', memberCount: 3 });
  const publication = await target().prepare(`SELECT authority_json,payload_json
    FROM analytics_community_model_publications WHERE source_id=? AND day=?`)
    .bind(sourceId, corpus.sessionDay).first<{ authority_json: string; payload_json: string }>();
  const authority = await captureStorageCommunityAuthority(source(), bindings());
  expect(JSON.parse(publication!.authority_json)).toMatchObject({
    sourceEpoch: authority.sourceEpoch, sequence: authority.sequence,
  });
  expect(JSON.parse(publication!.payload_json)).toMatchObject({ day: corpus.sessionDay,
    v1ParticipantCount: 3 });
}, 180_000);

it('retains explicit cross-day conflicts and invalidates their linked-day dependency after correction', async () => {
  const { corpus, range } = await setup(true);
  const partial = await advanceAnalyticsModelBlock({ ...bindings(), owner: corpus.owner,
    ...range, maxSteps: 1, deadlineMs: Date.now() + 60_000 });
  expect(partial.status).toBe('deferred');
  const readDependencies = async (owner: typeof corpus.owner) => {
    const values: ModelBlockDependency[] = [];
    await appendModelBlockDependencies(source(), partial.identity!, owner, [], () => undefined,
      dependency => { values.push(dependency); });
    return values;
  };
  const before = await readDependencies(corpus.owner);
  const page = await readEffectiveTelemetryOwnerDayPage(source(), { sourceNamespace,
    ownerDigest: corpus.owner.ownerDigest, ownerRevision: corpus.owner.ownerRevision,
    authorityEpoch: corpus.owner.authorityEpoch, day: corpus.crossDayLinkDay!, stream: 'usage', limit: 200 });
  expect(page.rows.some(row => row.status === 'conflict')).toBe(true);
  const corrected = await corpus.mutateCorrection();
  const after = await readDependencies(corrected);
  expect(after.find(value => value.day === corpus.crossDayLinkDay)?.digest)
    .not.toBe(before.find(value => value.day === corpus.crossDayLinkDay)?.digest);
  await expect(readVerifiedAnalyticsModelBlock({ ...bindings(), identity: partial.identity!,
    owner: corrected, check: () => undefined })).rejects.toBeInstanceOf(ModelBlockSourceChanged);
  expect(await graphRows()).toBe(0);
}, 180_000);

it('keeps runtime, owner, erasure and the per-date input-revision CAS authoritative during adoption', async () => {
  const context = await setup(), { corpus, scope, nowMs } = context;
  const { identity, checkpoint } = await completed(context);
  const call = (patch: Partial<Parameters<typeof advanceStorageModelBlockGraphWork>[0]> = {}) =>
    advanceStorageModelBlockGraphWork({ ...bindings(), scope, nowMs, maxQueries: 950,
      deadlineMs: Date.now() + 60_000, ...patch });
  await source().prepare("UPDATE telemetry_v12_runtime SET state='staged' WHERE id=1").run();
  await expect(readVerifiedAnalyticsModelBlock({ ...bindings(), identity, owner: corpus.owner,
    check: () => undefined })).rejects.toBeInstanceOf(ModelBlockSourceChanged);
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  expect((await call()).state).toBe('complete');
  const prior = await target().prepare(`SELECT payload_sha256 FROM analytics_community_graph_results
    WHERE source_id=? AND owner_digest=? AND day=? AND metric='model'`)
    .bind(sourceId, corpus.owner.ownerDigest, scope.day).first<string>('payload_sha256');
  // A competing later result cannot be overwritten with the older revision.
  await target().prepare(`UPDATE analytics_community_graph_results SET input_revision=?,dependency_digest=?
    WHERE source_id=? AND owner_digest=? AND day=? AND metric='model'`)
    .bind(corpus.owner.inputRevision + 1, 'd'.repeat(64), sourceId, corpus.owner.ownerDigest, scope.day).run();
  expect(await call()).toMatchObject({ state: 'deferred', reason: 'source_changed' });
  expect(await target().prepare(`SELECT payload_sha256 FROM analytics_community_graph_results
    WHERE source_id=? AND owner_digest=? AND day=? AND metric='model'`)
    .bind(sourceId, corpus.owner.ownerDigest, scope.day).first('payload_sha256')).toBe(prior);
  await target().prepare('DELETE FROM analytics_community_graph_results').run();
  await replaceJob(identity, checkpoint);

  // Place a target erasure receipt immediately before the actual native INSERT.
  // The graph commit's SQL fence must prevent resurrection, independently of
  // the earlier in-memory source/target proof.
  let fired = false;
  const raceTarget = new Proxy(target(), { get(db, property) {
    if (property === 'prepare') return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(inner, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(inner.bind(...values));
        if (key === 'run' && sql.includes('INSERT INTO analytics_community_graph_results')) return async () => {
          if (!fired) {
            fired = true;
            await target().prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)')
              .bind(sourceId, corpus.owner.ownerDigest, 'c'.repeat(64), 1, 1,
                corpus.owner.authorityEpoch, corpus.owner.authorityEpoch).run();
          }
          return inner.run();
        };
        const value = Reflect.get(inner, key); return typeof value === 'function' ? value.bind(inner) : value;
      } });
      return wrap(db.prepare(sql));
    };
    const value = Reflect.get(db, property); return typeof value === 'function' ? value.bind(db) : value;
  } });
  expect(await call({ target: raceTarget })).toMatchObject({ state: 'deferred', reason: 'source_changed' });
  expect(fired).toBe(true);
  expect(await graphRows()).toBe(0);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_model_block_parts').first('n')).toBe(0);
}, 180_000);


it('lazily adopts the selected cold date through real bounded maintained scope batches',async()=>{
  const context=await setup(),{corpus,scope,nowMs}=context;
  const {checkpoint}=await completed(context);
  let covered=false;
  for(let pass=0;pass<48;pass++){
    const progress=await advanceEffectiveDependencyCoverage(source(),{sourceId,sourceNamespace,
      participantId:corpus.owner.participantId,maxSteps:64,maxRows:128});
    if(progress.status==='complete'){covered=true;break;}
    expect(progress.status).not.toBe('unavailable');
  }
  expect(covered).toBe(true);
  expect(await target().prepare('SELECT count(*) n FROM analytics_effective_dependency_summaries')
    .first<number>('n')).toBe(0);
  const original=graphFacade.createStorageGraphScopeBatch,reads:string[]=[],sizes:number[]=[];
  let captured=0,closed=0;
  const spy=vi.spyOn(graphFacade,'createStorageGraphScopeBatch').mockImplementation(async(...args)=>{
    const batch=await original(...args);if(!batch)return;
    captured++;sizes.push(args[1].days.length);
    return {readScope:async day=>{reads.push(day);return batch.readScope(day);},
      assertCurrent:()=>batch.assertCurrent(),close:()=>{closed++;batch.close();}};
  });
  const profiles:{statements:number;rowsRead:number;rowsWritten:number;adoptedDates:number}[]=[];
  let complete=false;
  try{
    for(let pass=0;pass<20;pass++){
      const profile=createAnalyticsProfile();
      const profiledSource=profileAnalyticsDatabase(source(),'source',profile,()=> 'adoption');
      const profiledTarget=profileAnalyticsDatabase(target(),'target',profile,()=> 'adoption');
      const result=await advanceStorageModelBlockGraphWork({...bindings(),source:withMaintainedEffectiveDependencies(
        profiledSource,profiledTarget,sourceId,sourceNamespace),target:profiledTarget,scope,nowMs,
        maxQueries:950,deadlineMs:Date.now()+60_000});
      const costs=summarizeAnalyticsProfile(profile);
      expect(costs.statements).toBe(result.queriesUsed);expect(result.queriesUsed).toBeLessThanOrEqual(950);
      profiles.push({statements:costs.statements,rowsRead:costs.rowsRead,rowsWritten:costs.rowsWritten,
        adoptedDates:result.adoptedDates});
      expect(closed).toBe(captured);
      if(result.state==='complete'){complete=true;break;}
      expect(result.state).toBe('deferred');
    }
    expect(complete).toBe(true);expect(captured).toBeGreaterThan(0);
    expect(reads[0]).toBe(scope.day);expect(sizes.every(size=>size<=16)).toBe(true);
    const expected=checkpoint.outputs.find(output=>output.day===scope.day)!;
    const native=await readStorageGraphResult(bindings(),scope);
    expect(native?.composition).toEqual(expected.value.status==='ready'
      ?{...expected.value,inputFingerprint:scope.pin.fingerprint}:expected.value);
    console.log('P11_MODEL_BLOCK_LAZY_ADOPTION',JSON.stringify({passes:profiles.length,batches:captured,
      closed,rangeReads:reads.length,batchSizes:sizes,profiles}));
  }finally{spy.mockRestore();}
},180_000);
