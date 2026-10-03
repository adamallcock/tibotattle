#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { assertSame, COMPONENT_KEYS, corpusRecords, loadPricers, ordinaryEvent, syntheticManifest } from "./gcp-pricer-perf-lib.mjs";

const args = process.argv.slice(2);
const count = Number(args.find((value) => value.startsWith("--events="))?.split("=")[1] ?? 3_000_000);
assert.ok(Number.isSafeInteger(count) && count >= 0);
const corpusRoot = args.find((value) => value.startsWith("--corpus="))?.slice("--corpus=".length);
const reference = await loadPricers();
const bound = await loadPricers({ bound: true });
const old = reference.module.priceTelemetryUsageEvent;
const fast = bound.module.fastPriceTelemetryUsageEvent;
let compared = 0, errors = 0;
const reasons = new Set(), statuses = new Set();
const start = performance.now();
function compare(event) {
  const result = assertSame(old, fast, event, compared++);
  if (result.errorClass) errors += 1;
  else { const value = JSON.parse(result.json); for (const code of value.unpricedReasonCodes) reasons.add(code); statuses.add(value.coverageStatus); }
}
try {
  const models = [...new Set([...reference.module.TELEMETRY_MODEL_IDS,
    ...reference.module.APP_OFFICIAL_PRICE_CARDS.flatMap((card) => [card.model, ...(card.aliases ?? [])]),
    "unknown", "unrecognized", "synthetic-unlisted-model", " GPT-5.5 ", ""] )];
  const boundaries = [...new Set(reference.module.APP_OFFICIAL_PRICE_CARDS.flatMap((card) =>
    Object.values(card.effective ?? {}).flatMap((date) => {
      const time = Date.parse(date);
      return [-1, 0, 1, 86_399_999, 86_400_000, 86_400_001].map((offset) => new Date(time + offset).toISOString());
    })))];
  const eventTimes = [...boundaries, "1900-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
    "2026-09-25T12:00:00.000Z", null, undefined, "invalid", "2026-02-30T00:00:00.000Z", "2026-09-25T12:00:00Z"];
  const contexts = [...new Set([null, undefined, 0, 1, 50_000, 271_998, 271_999, 272_000, 272_001, 272_002,
    Number.MAX_SAFE_INTEGER, ...reference.module.APP_OFFICIAL_PRICE_CARDS.flatMap((card) => card.components.flatMap((component) =>
      Object.values(component.conditions ?? {}).flatMap((value) => [Number(value) - 1, Number(value), Number(value) + 1])))])];
  const values = [null, 0, 1, 1234, 1_000_000, 100_000_000, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1, 10n ** 25n, "10000000000000000000000000", "1.25", -1, NaN, Infinity];
  // Exhaust every catalog/alias identity with every card window and context threshold.
  for (const modelId of models) for (const provider of ["openai_codex", "anthropic_claude_code"]) {
    for (const eventTime of eventTimes) for (const totalInputContextTokens of contexts) {
      compare(ordinaryEvent({ modelId, provider, eventTime, totalInputContextTokens }));
    }
  }
  // Every observed/unavailable/zero combination, for both provider mappings.
  for (const provider of ["openai_codex", "anthropic_claude_code"]) for (let mask = 0; mask < 6561; mask += 1) {
    let digits = mask;
    const components = {};
    for (const key of COMPONENT_KEYS) { components[key] = [null, 0, 1][digits % 3]; digits = Math.floor(digits / 3); }
    compare(ordinaryEvent({ provider, modelId: provider === "openai_codex" ? "gpt-5.5" : reference.module.APP_OFFICIAL_PRICE_CARDS.find((card) => card.provider === "anthropic").model, components }));
  }
  // Malformed and alias-bearing inputs execute the original path, including its exceptions.
  for (const provider of ["openai_codex", "anthropic_claude_code", "unknown"]) for (const key of COMPONENT_KEYS) for (const value of values) {
    compare(ordinaryEvent({ provider, components: { ...ordinaryEvent().components, [key]: value } }));
  }
  for (const components of [null, undefined, [], {}, { inputUncachedTokens: 1 },
    { inputUncachedTokens: 1, input_uncached_tokens: 2, synthetic_component: 3 }, { inputUncachedTokens: "1e1001" }]) compare(ordinaryEvent({ components }));
  for (const event of [null, undefined, [], 1, "event"]) compare(event);
  let state = 0x61c0ffee;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const pick = (items) => items[random() % items.length];
  const tiers = ["standard", "priority", "flex", "batch", "unknown", "unrecognized", "fast", "other", "default", null];
  const speeds = ["standard", "fast", "unknown", "unrecognized", "other", null];
  const surfaces = ["chatgpt_subscription", "claude_subscription", "openai_api", "anthropic_api", "unknown"];
  for (let i = 0; i < count; i += 1) {
    const provider = pick(["openai_codex", "anthropic_claude_code"]);
    const modelId = pick(models);
    const components = {};
    for (const key of COMPONENT_KEYS) components[key] = i % 23 === 0 ? pick(values) : pick([null, 0, 1, random() % 100_000]);
    if (i % 4 === 0 && provider === "openai_codex" && typeof components.outputTextTokens === "number" && typeof components.outputReasoningTokens === "number") {
      components.outputCombinedTokens = components.outputTextTokens + components.outputReasoningTokens;
    }
    if (i % 4 === 0 && provider === "anthropic_claude_code") {
      components.inputCacheWrite5mTokens = random() % 1000; components.inputCacheWrite1hTokens = random() % 1000;
      components.inputCacheWriteTokens = components.inputCacheWrite5mTokens + components.inputCacheWrite1hTokens;
    }
    compare(ordinaryEvent({ provider, modelId, modelRecognition: i % 19 === 0 ? pick(["unrecognized", "unknown", "missing"]) : "recognized",
      billingSurface: pick(surfaces), apiServiceTier: pick(tiers), speedMode: pick(speeds),
      eventTime: pick(eventTimes), totalInputContextTokens: pick(contexts), components }));
    if ((i + 1) % 250_000 === 0) console.log(JSON.stringify({ progress: "fuzz", events: i + 1 }));
  }
  const fuzz = { comparisons: compared, generatedEvents: count, errors, models: models.length,
    eventTimes: eventTimes.length, contexts: contexts.length, reasonCodes: [...reasons].sort(), statuses: [...statuses].sort() };
  let corpus = null;
  if (corpusRoot) {
    const manifest = await syntheticManifest(corpusRoot);
    const formats = { 10: 0, 11: 0, 12: 0 };
    let rows = 0, shapeable = 0;
    for (const item of corpusRecords(corpusRoot)) {
      const event = reference.module.buildPricingEvent(item.record, item.eventTime);
      if (event !== null) { compare(event); shapeable += 1; }
      // Compare the actual bound/unbound stored-record entrypoint as well.
      const json = JSON.stringify(item.record);
      const a = reference.module.priceChunkUsageRecord(json, item.eventTime);
      const b = bound.module.priceChunkUsageRecord(json, item.eventTime);
      assert.equal(JSON.stringify(b), JSON.stringify(a), `record adapter mismatch at synthetic row ${rows}`);
      formats[item.format] += 1; rows += 1;
      if (rows % 250_000 === 0) console.log(JSON.stringify({ progress: "corpus", rows }));
    }
    assert.equal(rows, manifest.totals.usage, "every synthetic usage row was priced");
    assert.deepEqual(formats, { 10: 738860, 11: 5151789, 12: 967202 });
    corpus = { rows, shapeable, formats, recordAdapterComparisons: rows };
  }
  console.log(JSON.stringify({ status: "ok", node: process.version, fuzz, corpus, totalComparisons: compared,
    wallSeconds: (performance.now() - start) / 1000 }));
} finally { await reference.dispose(); await bound.dispose(); }
