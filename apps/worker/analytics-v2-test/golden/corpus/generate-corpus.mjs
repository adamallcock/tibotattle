#!/usr/bin/env node
// Deterministic generator for the GCP fast-path production-oracle corpus.
//
// Synthetic and content-free: opaque hash-derived identifiers, no paths,
// prompts, commands, accounts or emails. Run from apps/worker with a Node that
// can import TypeScript by type stripping (Node 23.6 or later, or Node 22 with
// --experimental-strip-types), because quota percentages are derived from the
// Worker's own server pricer so that every fit is exactly identified:
//
//   node test/fixtures/gcp-fastpath/generate-corpus.mjs [--days N] [--out FILE]
//
// The default output is test/fixtures/gcp-fastpath/corpus.json plus one
// corpus-owner-<key>.json shard per owner beside it.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { priceTelemetryUsageEvent } = await import(join(here, '../../../src/server-pricing.ts'));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const DAYS = Number(option('--days', '170'));
const OUT = option('--out', join(here, 'corpus.json'));
if (!Number.isSafeInteger(DAYS) || DAYS < 8 || DAYS > 366) throw new Error('invalid --days');

const SEED = 'gcp-fastpath-oracle-2026-10-01';
const THROUGH_DAY = '2026-10-01';
const DAY_MS = 86_400_000, MINUTE = 60_000;
const throughMs = Date.parse(`${THROUGH_DAY}T00:00:00.000Z`);
const days = Array.from({ length: DAYS }, (_, i) => new Date(throughMs - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10));
const hex = (...parts) => createHash('sha256').update([SEED, ...parts].join('\u0000')).digest('hex');
const uuid = (...parts) => {
  const h = hex('uuid', ...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// mulberry32, one stream per owner so owners are independent of each other.
function prng(label) {
  let state = parseInt(hex('prng', label).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const iso = (ms) => new Date(ms).toISOString();

// Base weekly capacity, USD of API-price-equivalent spend per 100% of a pro
// seven-day window. Plan factors follow the published normalization
// pro_x1_prolite_x4_plus_x20 (a prolite window is a quarter of pro, plus a
// twentieth). Activity scales keep every week below its reset.
const BASE_CAPACITY = { 'gpt-5.6-sol': 900, 'gpt-5.6-terra': 420, 'gpt-5.5': 700 };
const PLAN_FACTOR = { pro: 1, prolite: 0.25, plus: 0.05 };
const OWNERS = [
  { key: 'a', kind: 'social', format: 'v11', planType: 'pro', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'], activity: 1, resetWeekday: 1 },
  { key: 'b', kind: 'accountless', format: 'v11', planType: 'plus', models: ['gpt-5.6-terra', 'gpt-5.6-sol'], activity: 0.06, resetWeekday: 3 },
  { key: 'c', kind: 'social', format: 'v12', planType: 'pro', models: ['gpt-5.6-sol', 'gpt-5.6-terra'], activity: 0.8, resetWeekday: 5 },
  { key: 'd', kind: 'social', format: 'mixed', planType: 'prolite', models: ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra'], activity: 0.22, resetWeekday: 0 },
];
// Owner (d) holds one legacy v1.0 chunk on this day whose single usage record
// is the same occurrence the v1.1 domain carries: one duplicate occurrence
// across formats. Activating a v1.1 domain requires every legacy winner to be
// preserved byte-equivalently inside it (telemetry_domain_compatibility_unproven),
// which is why the legacy evidence is that one occurrence.
const DUPLICATE_DAY = days[Math.floor(DAYS * 0.45)];
// Owner (a) crossed-day event-time conflict: one occurrence ID accepted on two
// adjacent observed days with different event times. Early in the window so it
// touches as few 101-day model windows as possible.
const CONFLICT_DAYS = [days[2], days[3]];

function priceCost(record) {
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
  if (priced.coverageStatus !== 'fully_priced' || !(priced.costNanousd > 0)) {
    throw new Error(`synthetic model must be fully priced: ${record.modelId} ${record.eventTime}`);
  }
  return priced.costNanousd / 1e9;
}

function ownerCorpus(spec) {
  const random = prng(`owner:${spec.key}`);
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(random() * list.length)];
  // Accountless participants are minted by the ownership route; the oracle pins
  // that one draw so every run folds owners in the same participant order.
  const participantId = `participant:${uuid('participant', spec.key)}`;
  const accountTrackId = `account-track:v2:${hex('track', spec.key)}`;
  const ownerDigest = hex('owner-digest', spec.key);
  const attribution = () => ({ accountBasis: 'same_source', accountTrackId, planBasis: 'same_source_occurrence',
    planType: spec.planType, planEraId: null });
  const nextReset = (ms) => {
    // Next reset instant strictly after ms: 00:00Z on the owner's weekday.
    const dayStart = ms - (ms % DAY_MS);
    const weekday = new Date(dayStart).getUTCDay();
    let delta = (spec.resetWeekday - weekday + 7) % 7;
    if (delta === 0) delta = 7;
    return dayStart + delta * DAY_MS;
  };
  const events = [];
  let usageSeq = 0, quotaSeq = 0;
  const output = [];
  for (const day of days) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const last = day === THROUGH_DAY;
    const sessions = int(2, 6);
    // The current day closes early so admission on the real clock never sees
    // a future instant; earlier days spread sessions over the working day.
    const windowStart = dayStart + (last ? 5 : 6 * 60) * MINUTE;
    const windowEnd = dayStart + (last ? 150 : 23 * 60) * MINUTE;
    const slot = Math.floor((windowEnd - windowStart) / sessions);
    const records = { quota: [], session: [], usage: [] };
    for (let s = 0; s < sessions; s++) {
      const sessionUuid = uuid('session', spec.key, day, s);
      let at = windowStart + s * slot + int(0, Math.floor(slot / 4 / MINUTE)) * MINUTE + int(0, 59) * 1000;
      const count = int(2, 5);
      const firstEventTime = iso(at);
      for (let e = 0; e < count; e++) {
        const modelId = pick(spec.models);
        const scale = spec.activity * (0.4 + random() * 1.6);
        const inputUncachedTokens = Math.round((2_000 + random() * 30_000) * scale);
        const inputCacheReadTokens = e === 0 && random() < 0.5 ? 0 : Math.round((20_000 + random() * 600_000) * scale);
        const outputTextTokens = Math.max(1, Math.round((800 + random() * 12_000) * scale));
        const outputReasoningTokens = Math.round(random() * 9_000 * scale);
        const record = {
          schemaVersion: 'usage-event-v1.1', eventId: `event:v2:${hex('event', spec.key, String(usageSeq++))}`,
          eventTime: iso(at), sessionUuid, provider: 'openai_codex', modelId, speedMode: 'standard',
          apiServiceTier: 'default', surface: 'local_interactive_unclassified', billingSurface: 'chatgpt_subscription',
          reasoningEffort: pick(['low', 'medium', 'high']), agentScope: e > 2 && random() < 0.3 ? 'subagent' : 'root',
          outcome: 'completed', totalInputContextTokens: inputUncachedTokens + inputCacheReadTokens,
          components: { inputUncachedTokens, inputCacheReadTokens, inputCacheWriteTokens: 0,
            outputTextTokens, outputReasoningTokens, outputCombinedTokens: null },
          accountPlanAttribution: attribution(),
        };
        records.usage.push(record);
        events.push({ ms: at, cost: priceCost(record), modelId });
        // Pauses between consecutive requests span every cache-retention band,
        // but a session never leaves its own slot (or the UTC day).
        const pause = Math.round(pick([0.5, 1, 2, 3, 4, 6, 9, 14, 22, 35, 50, 70]) * MINUTE) + int(1, 50) * 1000;
        const sessionEnd = windowStart + (s + 1) * slot - 2 * MINUTE;
        at += at + pause <= sessionEnd ? pause : 30_000;
      }
      records.session.push({ schemaVersion: 'session-dimension-v1.1', sessionUuid, firstEventTime,
        provider: 'openai_codex', toolClassCounts: { localShell: int(1, 40), web: int(0, 6) + 1, other: int(1, 9) } });
      records.quota.push({ schemaVersion: 'quota-observation-v1.1',
        observationId: `quota-occurrence:v1:${hex('quota', spec.key, String(quotaSeq++))}`,
        observedTime: iso(at + 30_000), provider: 'openai_codex', planType: spec.planType, planVariant: 'unknown',
        limitId: 'codex', slot: 'seven_day', usedPercent: null, windowDurationMinutes: 10_080, resetsAt: null,
        accountPlanAttribution: attribution() });
    }
    output.push({ day, records });
  }
  // Exact seven-day windows: usedPercent is the window's cumulative priced
  // spend divided by the owner's per-model capacity, reset weekly.
  const capacities = Object.fromEntries(spec.models.map((model) => [model,
    BASE_CAPACITY[model] * PLAN_FACTOR[spec.planType]]));
  const quotaRows = output.flatMap((day) => day.records.quota);
  const fill = (scale) => {
    let peak = 0;
    for (const quota of quotaRows) {
      const observed = Date.parse(quota.observedTime), reset = nextReset(observed), start = reset - 7 * DAY_MS;
      let percent = 0;
      for (const event of events) if (event.ms >= start && event.ms <= observed) {
        percent += event.cost * 100 / (capacities[event.modelId] * scale);
      }
      quota.usedPercent = Math.round(percent * 10_000) / 10_000;
      quota.resetsAt = iso(reset);
      peak = Math.max(peak, quota.usedPercent);
    }
    return peak;
  };
  // Scale capacity so the busiest week peaks near 60%: realistic movement per
  // observation and never a crossed reset.
  const capacityScale = Math.round(fill(1) / 60 * 10_000) / 10_000;
  if (!(fill(capacityScale) < 90)) throw new Error('synthetic week crosses its reset');
  for (const model of spec.models) capacities[model] = Math.round(capacities[model] * capacityScale * 100) / 100;
  // One start-of-window zero observation per reset keeps every week anchored.
  for (const day of output) {
    const dayStart = Date.parse(`${day.day}T00:00:00.000Z`);
    if (new Date(dayStart).getUTCDay() !== spec.resetWeekday) continue;
    day.records.quota.unshift({ schemaVersion: 'quota-observation-v1.1',
      observationId: `quota-occurrence:v1:${hex('quota-reset', spec.key, day.day)}`,
      observedTime: iso(dayStart + 2 * MINUTE), provider: 'openai_codex', planType: spec.planType, planVariant: 'unknown',
      limitId: 'codex', slot: 'seven_day', usedPercent: 0, windowDurationMinutes: 10_080,
      resetsAt: iso(nextReset(dayStart + 2 * MINUTE)), accountPlanAttribution: attribution() });
  }
  // Per-day storage format.
  const formatted = output.map(({ day, records }) => {
    if (spec.format === 'v12') {
      return { day, format: 'v12', records: {
        quota: records.quota.map((r) => ({ ...r, schemaVersion: 'quota-observation-v1.2' })),
        session: records.session.map((r) => ({ ...r, schemaVersion: 'session-dimension-v1.2' })),
        usage: records.usage.map((r) => ({ ...r, schemaVersion: 'usage-event-v1.2', boundaryFlags: null,
          tieOrder: null, cacheWriteTtl: null })),
      } };
    }
    if (spec.format === 'mixed' && day === DUPLICATE_DAY) {
      return { day, format: 'v11', records, v1Extra: { quota: [], session: [], usage: [records.usage[0]] } };
    }
    return { day, format: 'v11', records };
  });
  let conflict = null, duplicate = null;
  if (spec.key === 'a') {
    const [first, second] = CONFLICT_DAYS;
    const occurrenceId = `event:v2:${hex('crossed-day-conflict', spec.key)}`;
    const base = formatted.find((d) => d.day === first).records.usage[0];
    const variant = (day, time) => ({ ...base, eventId: occurrenceId, eventTime: time, sessionUuid: uuid('conflict-session', spec.key) });
    // v1.1 domain activation refuses a repeated occurrence inside one
    // participant's domain (telemetry_domain_occurrence_conflict) and requires
    // earlier legacy winners to be preserved, so the production shape of this
    // conflict is a later legacy v1.0 upload (another device, older client) of
    // the same occurrence carrying the other event time: one single-record
    // v1.0 chunk admitted after the v1.1 domain is active.
    formatted.find((d) => d.day === first).v1Extra = { quota: [], session: [], usage: [variant(first, `${first}T23:58:30.000Z`)] };
    formatted.find((d) => d.day === second).records.usage.unshift(variant(second, `${second}T00:01:30.000Z`));
    conflict = { occurrenceId, days: [first, second], formats: { [first]: 'v1', [second]: 'v11' },
      v1AdmittedAfterV11Domain: true };
  }
  if (spec.key === 'd') {
    duplicate = { occurrenceId: formatted.find((d) => d.day === DUPLICATE_DAY).v1Extra.usage[0].eventId,
      day: DUPLICATE_DAY, formats: ['v1', 'v11'], v1AdmittedBeforeV11Domain: true };
  }
  return {
    key: spec.key, kind: spec.kind, participantId, pinnedOwnerDigest: ownerDigest, planType: spec.planType,
    accountTrackId, models: spec.models, capacitiesUsdPerWindow: capacities, resetWeekdayUtc: spec.resetWeekday,
    storage: spec.format === 'mixed' ? { v11: [days[0], THROUGH_DAY], v1DuplicateChunk: [DUPLICATE_DAY, DUPLICATE_DAY] }
      : spec.key === 'a' ? { v11: [days[0], THROUGH_DAY], v1ConflictChunk: [CONFLICT_DAYS[0], CONFLICT_DAYS[0]] }
      : { [spec.format]: [days[0], THROUGH_DAY] },
    ...(conflict ? { conflict } : {}), ...(duplicate ? { duplicate } : {}),
    days: formatted,
  };
}

const owners = OWNERS.map(ownerCorpus);
const counts = Object.fromEntries(owners.map((owner) => [owner.key, owner.days.reduce((n, d) => {
  for (const stream of ['quota', 'session', 'usage']) n[stream] += d.records[stream].length;
  return n;
}, { quota: 0, session: 0, usage: 0 })]));
const corpus = {
  schemaVersion: 'gcp-fastpath-oracle-corpus-v1',
  sourceCommit: 'd43c8f92a059d9c577776f7eca8a331eb305b8a6',
  generator: 'generate-corpus.mjs',
  seed: SEED,
  synthetic: true,
  window: { fromDay: days[0], throughDay: THROUGH_DAY, days: DAYS },
  pinnedNow: `${THROUGH_DAY}T12:00:00.000Z`,
  correctionRuntimeState: 'active',
  conflict: { owner: 'a', ...owners[0].conflict },
  duplicate: { owner: 'd', ...owners[3].duplicate },
  recordCounts: counts,
  owners,
};
// The index (corpus.json) holds everything except owner-days; each owner's
// days live in corpus-owner-<key>.json, one owner-day per line. Workerd
// refuses a single ~11 MB JSON module, so the spec imports the shards.
const shardName = (key) => `corpus-owner-${key}.json`;
const index = { ...corpus, shards: Object.fromEntries(owners.map((owner) => [owner.key, shardName(owner.key)])),
  owners: owners.map((owner) => ({ ...owner, days: undefined, dayCount: owner.days.length })) };
const text = `${JSON.stringify(index, null, 1)}\n`;
const shards = owners.map((owner) => [shardName(owner.key),
  `{"key":${JSON.stringify(owner.key)},"days":[\n${owner.days.map((d) => JSON.stringify(d)).join(',\n')}\n]}\n`]);
JSON.parse(text);
writeFileSync(OUT, text);
for (const [name, body] of shards) { JSON.parse(body); writeFileSync(join(dirname(OUT), name), body); }
console.log(JSON.stringify({ out: OUT, days: DAYS, recordCounts: counts,
  bytes: Buffer.byteLength(text) + shards.reduce((n, [, body]) => n + Buffer.byteLength(body), 0) }));
