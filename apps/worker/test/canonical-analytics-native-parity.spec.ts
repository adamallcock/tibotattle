import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
import { normalizeNativeEffectiveOccurrence, normalizeSelectedTelemetryRecord, canonicalSelectedSlotKey, canonicalFieldPresence } from '../src/canonical-analytics-facts';
import { readEffectiveUsageOwnerDayPage, readEffectiveTelemetryOwnerDayPage, selectedTypedTelemetryAnalyticalJson } from '../src/telemetry-usage-effective-reader';
import { persistTypedTelemetryBatch, type TypedTelemetrySourceRecord } from '../src/typed-telemetry-repository';
import { readTypedTelemetryCompatibilityPage } from '../src/typed-telemetry-compatibility';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { canonicalCacheItems, cacheRetentionEventFromRecord } from '../src/cache-retention-events';
import { loadCanonicalLegacySourcePin, readCanonicalLegacySourcePage } from '../src/canonical-analytics-legacy-source';
import { readTypedV11UsageAnalysisPage } from '../src/typed-v11-analysis-reader';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
it('matches native admitted v1/v11/v12 overlap, sparse corrections, quota and session evidence',async()=>{
  await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-native';
  await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
    anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  let pin=corpus.owner;
  const read=(day:string)=>readEffectiveUsageOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:pin.ownerDigest,
    ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,day,limit:16});
  const scope={sourceNamespace:sourceId,ownerDigest:pin.ownerDigest,selectionMethod:'effective-union-v1' as const};
  const overlap=(await read(corpus.equivalentDay)).rows.find(row=>row.occurrenceId===corpus.equivalentOccurrenceId)!;
  expect(overlap.sourceFormats).toEqual(['v1','v11','v12']);
  const canonical=await normalizeNativeEffectiveOccurrence(scope,overlap,0),native=JSON.parse(overlap.analyticalRecordJson!);
  expect(canonical.status).toBe(overlap.status);
  expect(canonical.values.totalInputContextTokens).toBe(native.totalInputContextTokens);
  for(const key of ['inputUncachedTokens','inputCacheReadTokens','inputCacheWriteTokens','outputTextTokens','outputReasoningTokens','outputCombinedTokens'] as const)
    expect(canonical.values[key]).toBe(native.components[key]);
  expect(new Set(canonical.provenance.variants.map(row=>row.format))).toEqual(new Set(['v1','v11','v12']));
  const sparse=(await read(corpus.correctionDay)).rows.find(row=>row.occurrenceId===corpus.correctionOccurrenceId)!;
  const before=await normalizeNativeEffectiveOccurrence(scope,sparse,0);
  expect(canonicalFieldPresence(before,'totalInputContextTokens')).toBe('unknown');
  pin=await corpus.mutateCorrection();
  const corrected=(await read(corpus.correctionDay)).rows.find(row=>row.occurrenceId===corpus.correctionOccurrenceId)!;
  const after=await normalizeNativeEffectiveOccurrence(scope,corrected,0);
  expect(after.occurrenceKey).toBe(before.occurrenceKey);expect(after.revision).not.toBe(before.revision);
  expect(after.values.totalInputContextTokens).toBe(JSON.parse(corrected.analyticalRecordJson!).totalInputContextTokens);
  expect(canonicalFieldPresence(after,'totalInputContextTokens')).toBe('reported');
  for(const [stream,day] of [['session',corpus.sessionDay],['quota',corpus.modelFitDates[0]!]] as const) {
    const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:pin.ownerDigest,
      ownerRevision:pin.ownerRevision,authorityEpoch:pin.authorityEpoch,day,stream,limit:16});
    expect(page.rows.length).toBeGreaterThan(0);
    for(const [rank,row] of page.rows.entries()) {
      const fact=await normalizeNativeEffectiveOccurrence(scope,row,rank),native=JSON.parse(row.recordJson!);
      expect(fact.status).toBe(row.status);expect(fact.provenance.coverage).toBe('complete');
      if(stream==='session')expect(Object.fromEntries(fact.toolCounts.map(row=>[row.toolClass,row.count]))).toEqual(native.toolClassCounts);
      else expect(fact.values.usedPercent).toBe(native.usedPercent);
    }
  }
},120_000);


it.each(['v1','v11'] as const)('preserves admitted %s nullable cache quantities and rejects missing labels before typed storage',async format=>{
  await reset();const source=b.USAGE_MONITOR_DB,day='2026-09-20',sourceNamespace='synthetic-canonical-sparse';
  await applyD1Migrations(source,b.TEST_TYPED_INGESTION_MIGRATIONS.filter(m=>m.name<='0004_read_compatibility.sql'));
  const full=v11UsageRecord(day,'a',{modelId:'future-model',reasoningEffort:'unknown',speedMode:'unavailable',
    totalInputContextTokens:null,components:{inputUncachedTokens:100,inputCacheReadTokens:null,inputCacheWriteTokens:null,
      outputTextTokens:null,outputReasoningTokens:null,outputCombinedTokens:null}});
  const {accountPlanAttribution,...legacy}=full;
  const record=format==='v11'?full:{...legacy,schemaVersion:'usage-event-v1.0'};
  const participantId='participant:synthetic-canonical-sparse',deviceId='device:synthetic-canonical-sparse';
  const row:TypedTelemetrySourceRecord={sourceNamespace,participantId,deviceId,format,sourceRowId:1,
    chunkRowId:'chunk:synthetic-canonical-sparse',manifestId:format==='v11'?'manifest:synthetic-canonical-sparse':null,
    chunkDay:day,observedDay:day,record};
  const {modelId,...missingModel}=record;
  const {inputCacheReadTokens,...missingComponent}=record.components;
  // Null quantities are admitted unknowns; omitted quantities, null labels and
  // malformed JSON are not admitted older shapes. No source row is fabricated.
  for(const invalid of [{...record,modelId:null},missingModel,{...record,modelId:'invalid model'},
    {...record,components:missingComponent},'{']) {
    await expect(persistTypedTelemetryBatch(source,[{...row,record:invalid}]))
      .rejects.toMatchObject({code:'TYPED_TELEMETRY_INVALID'});
  }
  expect(await source.prepare('SELECT count(*) n FROM typed_telemetry_records').first<number>('n')).toBe(0);
  await persistTypedTelemetryBatch(source,[row]);
  const decoded=(await readTypedTelemetryCompatibilityPage(source,{sourceNamespace,participantId,stream:'usage'})).records;
  expect(decoded).toHaveLength(1);expect(decoded[0]!.record).toEqual(record);
  const scope={sourceNamespace,ownerDigest:'a'.repeat(64),selectionMethod:'legacy-selected-v1' as const};
  const unknown={presence:'unknown' as const,value:null};
  const input={stream:'usage' as const,occurrenceId:full.eventId,eventTime:full.eventTime,
    recordJson:selectedTypedTelemetryAnalyticalJson(decoded[0]!),nativeOrder:0,sourceFamily:format,occurrenceTieOrder:0,
    selectedSlotKey:await canonicalSelectedSlotKey(scope,'usage',{format,deviceId,day}),
    evidence:{linkedDays:[day],variants:[{coordinate:format+':1',format,observedAtMs:Date.parse(full.eventTime)}],
      boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown}};
  const fact=await normalizeSelectedTelemetryRecord(scope,input);
  for(const field of ['totalInputContextTokens','inputCacheReadTokens','inputCacheWriteTokens','outputTextTokens',
    'outputReasoningTokens','outputCombinedTokens'] as const) {
    expect(fact.values[field]).toBeNull();expect(canonicalFieldPresence(fact,field)).toBe('unknown');
  }
  expect(fact.values.modelId).toBe(modelId);expect(fact.values.reasoningEffort).toBe('unknown');
  const mapped=await canonicalCacheItems([fact]);expect(mapped.items).toHaveLength(1);
  const native=cacheRetentionEventFromRecord({sessionDigest:fact.nativeScopes.cacheSessionDigest!,
    observedAtMs:fact.location.observedAtMs!,orderKey:mapped.items[0]!.orderKey,recordJson:decoded[0]!.record_json});
  expect(mapped.items[0]).toEqual(native);expect(native).not.toHaveProperty('unreadable');
  expect(native).toMatchObject({cacheReadTokens:null,uncachedTokens:100,cacheWriteTokens:null});
  if(format==='v1')expect(fact.accountBasis).toBe('unavailable');
  for(const recordJson of ['{',JSON.stringify({...JSON.parse(input.recordJson),modelId:null})])
    await expect(normalizeSelectedTelemetryRecord(scope,{...input,recordJson})).rejects.toMatchObject({code:'CANONICAL_INVALID'});
});

it('refuses corrupt typed source labels in native, selected canonical and effective readers before cache mapping',async()=>{
  await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-refusal';
  await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
  const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
    anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
  const owner=corpus.owner,scope={sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,participantId:owner.participantId,
    day:corpus.equivalentDay,stream:'usage' as const};
  const selected=await loadCanonicalLegacySourcePin(source,scope);expect(selected.format).toBe('v11');
  if(selected.format!=='v11')throw new Error('synthetic selected family missing');
  const from=scope.day+'T00:00:00.000Z',to=new Date(Date.parse(from)+86_400_000).toISOString();
  const native=()=>readTypedV11UsageAnalysisPage(source,{sourceNamespace:sourceId,pin:selected.pin,day:scope.day,
    from,to,afterTime:from,afterOccurrence:''});
  expect((await native()).length).toBeGreaterThan(0);
  expect((await readCanonicalLegacySourcePage(source,scope,undefined,16)).rows.length).toBeGreaterThan(0);
  // Deliberate corruption of this disposable synthetic DB tests reader refusal,
  // not an admitted nullable record. Production immutability is unchanged.
  await source.exec('DROP TRIGGER typed_telemetry_dictionary_immutable');
  await source.prepare(`UPDATE typed_telemetry_dictionary SET value='invalid model'
    WHERE id=(SELECT u.model_id FROM typed_telemetry_usage u JOIN typed_v11_active_records r ON r.storage_row_id=u.record_id
      WHERE r.participant_id=? AND r.generation_id=? AND r.observed_day=? AND r.stream='usage' LIMIT 1)`)
    .bind(owner.participantId,selected.pin.generationId,scope.day).run();
  await expect(native()).rejects.toMatchObject({code:'TYPED_TELEMETRY_INVALID'});
  await expect(readCanonicalLegacySourcePage(source,scope,undefined,16)).rejects.toMatchObject({code:'TYPED_TELEMETRY_INVALID'});
  await expect(readEffectiveUsageOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day:scope.day,limit:16})).rejects.toMatchObject({code:'TYPED_TELEMETRY_INVALID'});
},120_000);
