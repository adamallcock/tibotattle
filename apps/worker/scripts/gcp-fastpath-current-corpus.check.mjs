import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseTelemetryV11Record, parseTelemetryV12Record } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from '../src/canonical-json.ts';
import { priceTelemetryUsageEvent } from '../src/server-pricing.ts';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-compatibility.ts';
import { buildCurrentCorpus, CURRENT_CORPUS_CASES, generateCurrentCorpus } from './gcp-fastpath-current-corpus.mjs';

// The repository's Worker TypeScript uses extensionless internal imports.
// Resolve those while loading the canonical v1.0 admission parser, then remove
// the hook so this check does not change resolution for later modules.
const typescriptResolutionHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[A-Za-z0-9]+$/u.test(specifier)) {
        try { return nextResolve(`${specifier}.ts`, context); } catch { /* Keep the original resolution error. */ }
      }
      throw error;
    }
  },
});
let telemetryV1;
try { telemetryV1 = await import('../src/telemetry-v1.ts'); }
finally { typescriptResolutionHooks.deregister(); }

const GOLDEN = new URL('../analytics-v2-test/golden/corpus/', import.meta.url);
const DAY_MS = 86_400_000;
const EXPECTED_COUNTS = {
  a: { quota: 692, session: 668, usage: 2324 },
  b: { quota: 688, session: 663, usage: 2311 },
  c: { quota: 690, session: 666, usage: 2293 },
  d: { quota: 724, session: 700, usage: 2411 },
};

function readCase(directory) {
  const index = JSON.parse(readFileSync(join(directory, 'corpus.json'), 'utf8'));
  const owners = Object.fromEntries(Object.entries(index.shards).map(([key, name]) => [
    key,
    JSON.parse(readFileSync(join(directory, name), 'utf8')),
  ]));
  return { index, owners };
}

function usageAdmissions(owner) {
  return owner.days.flatMap((day) => [
    ...day.records.usage,
    ...(day.v1Extra?.usage ?? []),
  ]);
}

function eventCost(record) {
  const c = record.components;
  const priced = priceTelemetryUsageEvent({
    schemaVersion: 'usage-event-v0.1', eventTime: record.eventTime, provider: record.provider,
    modelId: record.modelId, modelRecognition: 'recognized', modelFingerprint: null,
    billingSurface: record.billingSurface, speedMode: record.speedMode, apiServiceTier: record.apiServiceTier,
    reasoningEffort: record.reasoningEffort,
    components: { inputUncachedTokens: c.inputUncachedTokens, inputCacheReadTokens: c.inputCacheReadTokens,
      inputCacheWriteTokens: c.inputCacheWriteTokens, inputCacheWrite5mTokens: null, inputCacheWrite1hTokens: null,
      outputTextTokens: c.outputTextTokens, outputReasoningTokens: c.outputReasoningTokens,
      outputCombinedTokens: c.outputCombinedTokens },
    totalInputContextTokens: record.totalInputContextTokens,
  });
  assert.equal(priced.coverageStatus, 'fully_priced');
  assert.ok(priced.costNanousd > 0);
  return priced.costNanousd / 1e9;
}

function normalizeOwnerADay(day, boundaryDays) {
  const normalized = structuredClone(day);
  normalized.records.quota = normalized.records.quota.map((record) => ({ ...record, usedPercent: null }));
  if (day.day === boundaryDays[1]) normalized.records.usage.shift();
  if (day.day === boundaryDays[0]) normalized.v1Extra.usage = [];
  return normalized;
}

function duplicateEventGroups(owner) {
  const byId = new Map();
  for (const record of usageAdmissions(owner)) {
    const group = byId.get(record.eventId) ?? [];
    group.push(record);
    byId.set(record.eventId, group);
  }
  return [...byId.entries()].filter(([, rows]) => rows.length > 1);
}

function verifyPositiveCalibration(owner, ownerDays) {
  const events = usageAdmissions(owner).map((record) => ({
    ms: Date.parse(record.eventTime), modelId: record.modelId, cost: eventCost(record),
  }));
  const capacities = owner.capacitiesUsdPerWindow;
  for (const day of ownerDays) {
    for (const quota of day.records.quota) {
      const observed = Date.parse(quota.observedTime);
      const reset = Date.parse(quota.resetsAt);
      const start = reset - 7 * DAY_MS;
      let percent = 0;
      for (const event of events) if (event.ms >= start && event.ms <= observed) {
        percent += event.cost * 100 / capacities[event.modelId];
      }
      const expected = Math.round(percent * 10_000) / 10_000;
      assert.ok(Math.abs(quota.usedPercent - expected) < 0.00011,
        `quota calibration mismatch at ${quota.observedTime}`);
    }
  }
}

function parseCanonicalRecord(format, stream, record) {
  return format === 'v12'
    ? parseTelemetryV12Record(stream, record)
    : parseTelemetryV11Record(stream, record);
}

function parseLegacyUsage(day, record) {
  const parsed = parseTelemetryV11Record('usage', record);
  const projection = telemetryV11LegacyProjection('usage', parsed);
  assert.ok(projection, 'the V1 extra must have a canonical legacy projection');
  const legacyRecord = JSON.parse(projection.canonicalRecord);
  const consent = {
    telemetrySchemaVersion: telemetryV1.TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    fieldDictionaryVersion: telemetryV1.TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: telemetryV1.TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  };
  telemetryV1.assertTelemetryV1ConsentCurrent(consent);
  const chunk = telemetryV1.parseTelemetryV1Chunk({
    schemaVersion: telemetryV1.TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: createHash('sha256').update(canonicalJson([legacyRecord])).digest('hex'),
    parserVersion: 'synthetic-gcp-oracle-v1',
    consent,
    records: [legacyRecord],
  });
  const parsedLegacy = chunk.records[0];
  assert.equal(parsedLegacy.eventId, parsed.eventId);
  assert.equal(parsedLegacy.eventTime, parsed.eventTime);
  assert.equal(parsedLegacy.sessionUuid, parsed.sessionUuid);
  assert.equal(parsedLegacy.provider, parsed.provider);
  return parsedLegacy;
}

function assertPositiveCorpusSessionAssociations(owners) {
  for (const owner of owners) {
    const sessions = new Map();
    const usages = [];
    for (const day of owner.days) {
      const format = day.format ?? 'v11';
      for (const raw of day.records.session) {
        const session = parseCanonicalRecord(format, 'session', raw);
        assert.equal(session.firstEventTime.slice(0, 10), day.day);
        assert.equal(sessions.has(session.sessionUuid), false, 'session IDs are unique within an owner window');
        sessions.set(session.sessionUuid, { day: day.day, record: session });
      }
      for (const raw of day.records.usage) {
        usages.push({ day: day.day, record: parseCanonicalRecord(format, 'usage', raw) });
      }
      for (const raw of day.v1Extra?.usage ?? []) {
        usages.push({ day: day.day, record: parseLegacyUsage(day.day, raw) });
      }
    }
    for (const { day, record } of usages) {
      const dimension = sessions.get(record.sessionUuid);
      assert.ok(dimension, `${owner.key}/${day} usage must resolve to an admitted session dimension`);
      assert.equal(dimension.day, day, `${owner.key}/${day} usage must bind to a session in that owner's day`);
      assert.equal(dimension.record.provider, record.provider, `${owner.key}/${day} provider must agree`);
      assert.ok(dimension.record.firstEventTime <= record.eventTime,
        `${owner.key}/${day} usage must not precede its session's first event`);
    }
  }
}

test('current corpus keeps the negative bytes and emits a deterministic conflict-free positive case', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'gcp-fastpath-current-corpus-check-'));
  try {
    const negativeDir = join(temporaryRoot, 'negative');
    const positiveDir = join(temporaryRoot, 'positive');
    const repeatedPositiveDir = join(temporaryRoot, 'positive-repeat');
    const negativeManifest = generateCurrentCorpus({ caseId: CURRENT_CORPUS_CASES.negative.id, outDir: negativeDir });
    const positiveObject = buildCurrentCorpus(CURRENT_CORPUS_CASES.positive.id);
    const positiveManifest = generateCurrentCorpus({ caseId: CURRENT_CORPUS_CASES.positive.id, outDir: positiveDir });
    const repeatedPositiveManifest = generateCurrentCorpus({ caseId: CURRENT_CORPUS_CASES.positive.id, outDir: repeatedPositiveDir });
    const negative = readCase(negativeDir);
    const positive = readCase(positiveDir);
    const repeatedPositive = readCase(repeatedPositiveDir);

    assert.deepEqual(negativeManifest.recordCounts, EXPECTED_COUNTS);
    for (const name of ['corpus.json', 'corpus-owner-a.json', 'corpus-owner-b.json', 'corpus-owner-c.json', 'corpus-owner-d.json']) {
      const generated = readFileSync(join(negativeDir, name));
      const original = readFileSync(new URL(name, GOLDEN));
      assert.deepEqual(generated, original, `${name} must retain the original negative input bytes`);
      const manifestEntry = negativeManifest.corpusInputFiles.find((entry) => entry.path === name);
      assert.equal(manifestEntry.sha256, createHash('sha256').update(original).digest('hex'));
      assert.equal(manifestEntry.bytes, original.byteLength);
    }

    assert.equal(negativeManifest.caseId, CURRENT_CORPUS_CASES.negative.id);
    assert.equal(positiveManifest.caseId, CURRENT_CORPUS_CASES.positive.id);
    assert.notEqual(negativeManifest.caseDigest, positiveManifest.caseDigest);
    assert.equal(positiveManifest.caseDigest, repeatedPositiveManifest.caseDigest);
    assert.deepEqual(positiveManifest.corpusInputFiles, repeatedPositiveManifest.corpusInputFiles);
    for (const entry of positiveManifest.corpusInputFiles) {
      assert.deepEqual(readFileSync(join(positiveDir, entry.path)), readFileSync(join(repeatedPositiveDir, entry.path)));
    }

    assert.deepEqual(positive.index.window, negative.index.window);
    assert.equal(positive.index.window.days, 170);
    assert.equal(positive.index.pinnedNow, negative.index.pinnedNow);
    assert.equal(positive.index.conflict, undefined);
    assert.deepEqual(positive.index.recordCounts, EXPECTED_COUNTS);
    assert.deepEqual(positiveManifest.primaryRecordTotals, { quota: 2794, session: 2697, usage: 9339 });
    assert.equal(positiveManifest.extraAdmissionCount, 2);
    assert.equal(positiveManifest.totalAdmissionRecords, 14832);

    for (const key of ['a', 'b', 'c', 'd']) {
      const negativeOwner = negative.owners[key];
      const positiveOwner = positive.owners[key];
      assert.equal(positiveOwner.days.length, 170);
      assert.equal(negativeOwner.days.length, positiveOwner.days.length);
      assert.deepEqual(positive.index.recordCounts[key], EXPECTED_COUNTS[key]);
      assert.deepEqual(positiveOwner.days.map((day) => day.day), negativeOwner.days.map((day) => day.day));
      for (let index = 0; index < positiveOwner.days.length; index += 1) {
        const positiveDay = positiveOwner.days[index];
        const negativeDay = negativeOwner.days[index];
        assert.equal(positiveDay.format ?? 'v11', negativeDay.format ?? 'v11');
        for (const stream of ['quota', 'session', 'usage']) {
          assert.equal(positiveDay.records[stream].length, negativeDay.records[stream].length);
        }
        assert.deepEqual(
          Object.fromEntries(Object.entries(positiveDay.v1Extra ?? {}).map(([stream, rows]) => [stream, rows.length])),
          Object.fromEntries(Object.entries(negativeDay.v1Extra ?? {}).map(([stream, rows]) => [stream, rows.length])),
        );
        if (key === 'a') {
          assert.deepEqual(normalizeOwnerADay(positiveDay, negative.index.conflict.days),
            normalizeOwnerADay(negativeDay, negative.index.conflict.days));
        } else {
          assert.deepEqual(positiveDay, negativeDay);
        }
      }
    }

    const positiveA = positive.owners.a;
    const [firstConflictDay, secondConflictDay] = negative.index.conflict.days;
    const positiveObjectA = positiveObject.owners.find((owner) => owner.key === 'a');
    const objectFirstExtra = positiveObjectA.days.find((day) => day.day === firstConflictDay).v1Extra.usage[0];
    const objectSecondExtra = positiveObjectA.days.find((day) => day.day === secondConflictDay).records.usage[0];
    const firstExtra = positiveA.days.find((day) => day.day === firstConflictDay).v1Extra.usage[0];
    const secondExtra = positiveA.days.find((day) => day.day === secondConflictDay).records.usage[0];
    assert.deepEqual(firstExtra, objectFirstExtra);
    assert.deepEqual(secondExtra, objectSecondExtra);
    assert.notEqual(firstExtra.eventId, secondExtra.eventId);
    assert.notEqual(firstExtra.sessionUuid, secondExtra.sessionUuid);
    for (const record of [firstExtra, secondExtra]) {
      assert.match(record.eventId, /^event:v2:[0-9a-f]{64}$/);
      assert.match(record.sessionUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.deepEqual(duplicateEventGroups(positiveA), []);
    assert.deepEqual(duplicateEventGroups(positive.owners.b), []);
    assert.deepEqual(duplicateEventGroups(positive.owners.c), []);
    const ownerDDuplicates = duplicateEventGroups(positive.owners.d);
    assert.equal(ownerDDuplicates.length, 1);
    assert.equal(ownerDDuplicates[0][0], positive.index.duplicate.occurrenceId);
    assert.deepEqual(ownerDDuplicates[0][1][0], ownerDDuplicates[0][1][1]);

    const duplicateDay = positive.owners.d.days.find((day) => day.day === positive.index.duplicate.day);
    assert.deepEqual(duplicateDay.v1Extra.usage[0], duplicateDay.records.usage[0]);
    assert.deepEqual(positive.index.duplicate.formats, ['v1', 'v11']);
    verifyPositiveCalibration({
      ...positive.index.owners.find((owner) => owner.key === 'a'),
      days: positiveA.days,
    }, positiveA.days);
    assertPositiveCorpusSessionAssociations(Object.values(positive.owners));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('positive usage records parse canonically and resolve to in-window session dimensions', () => {
  const positive = buildCurrentCorpus(CURRENT_CORPUS_CASES.positive.id);
  assertPositiveCorpusSessionAssociations(positive.owners);

  const ownerA = positive.owners.find((owner) => owner.key === 'a');
  const [firstDay, secondDay] = ownerA.conflict?.days ?? [ownerA.days[2].day, ownerA.days[3].day];
  const firstExtra = ownerA.days.find((day) => day.day === firstDay).v1Extra.usage[0];
  const secondExtra = ownerA.days.find((day) => day.day === secondDay).records.usage[0];
  const firstSession = ownerA.days.find((day) => day.day === firstDay).records.session.find((session) =>
    session.sessionUuid === firstExtra.sessionUuid);
  const secondSession = ownerA.days.find((day) => day.day === secondDay).records.session.find((session) =>
    session.sessionUuid === secondExtra.sessionUuid);
  assert.ok(firstSession && secondSession);
  assert.notEqual(firstSession.sessionUuid, secondSession.sessionUuid);
  assert.ok(firstSession.firstEventTime <= firstExtra.eventTime);
  assert.ok(secondSession.firstEventTime <= secondExtra.eventTime);
});
