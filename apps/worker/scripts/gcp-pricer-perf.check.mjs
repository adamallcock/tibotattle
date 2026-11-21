import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { analyticsFastPricerPlugin, assertAnalyticsFastPricerBinding, fastPricerImport,
  FAST_PRICER_CONSUMER, FAST_PRICER_MODULE } from "../cloud-run/analytics-fast-pricer-binding.mjs";
import { assertSame, COMPONENT_KEYS, loadPricers, ordinaryEvent, WORKER_ROOT } from "./gcp-pricer-perf-lib.mjs";
import { dayMs, syntheticOwner, usage, quota } from "../analytics-v2-test/fixtures/synthetic-occurrences.mjs";

const oracle = await loadPricers();
const fast = await loadPricers({ bound: true, instrument: true });
test.after(async () => { await oracle.dispose(); await fast.dispose(); });

test("binding replaces exactly the reviewed edge and refuses an unbound graph", () => {
  assert.equal(fastPricerImport("./server-pricing", FAST_PRICER_CONSUMER), FAST_PRICER_MODULE);
  assert.equal(fastPricerImport("./apps/worker/src/server-pricing", resolve(WORKER_ROOT, "vendor/analytics-d43c8f92/entry.ts")), null);
  assert.equal(fastPricerImport("./server-pricing", resolve(WORKER_ROOT, "src/quota-analysis-v1.ts")), null);
  const graph = (target) => ({ inputs: { [FAST_PRICER_CONSUMER]: { imports: [{ original: "./server-pricing", path: target }] } } });
  assert.doesNotThrow(() => assertAnalyticsFastPricerBinding(graph(FAST_PRICER_MODULE), WORKER_ROOT));
  assert.throws(() => assertAnalyticsFastPricerBinding(graph(resolve(WORKER_ROOT, "vendor/analytics-d43c8f92/apps/worker/src/server-pricing.ts")), WORKER_ROOT),
    { message: "ANALYTICS_FAST_PRICER_BINDING_MISSING" });
  assert.equal(analyticsFastPricerPlugin().name, "analytics-v2-fast-pricer");
});

test("inclusive effective-to dates and both context threshold conventions are cached without crossing", () => {
  const pricer = fast.module.createFastTelemetryUsagePricer();
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-sol", "gpt-6-astra"]) {
    for (const eventTime of ["2026-07-29T00:00:00.000Z", "2026-07-29T23:59:59.999Z", "2026-07-30T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z", "2026-08-20T23:59:59.999Z", "2026-08-21T00:00:00.000Z",
      "2026-09-02T23:59:59.999Z", "2026-09-03T00:00:00.000Z", "2026-09-21T23:59:59.999Z", "2026-09-22T00:00:00.000Z"]) {
      for (const totalInputContextTokens of [271999, 272000, 272001]) for (const speedMode of ["standard", "fast"]) {
        assertSame(oracle.module.priceTelemetryUsageEvent, pricer, ordinaryEvent({ modelId, eventTime, totalInputContextTokens, speedMode }), "boundary");
      }
    }
  }
});

test("the bundled GCP adapter prices GPT-6.2 exact tiers, contexts and epochs", () => {
  const pricer = fast.module.createFastTelemetryUsagePricer();
  const launch = "2026-11-17T00:00:00.000Z";
  const prelaunch = "2026-11-16T23:59:59.999Z";
  const promoEnd = "2027-03-01T07:59:59.999Z";
  const listStart = "2027-03-01T08:00:00.000Z";
  const modelPrices = [
    { modelId: "gpt-6.2-astra", standard: [5_560_000_000, 9_120_016_000],
      batch: [2_780_000_000, 4_560_008_000], priority: [11_120_000_000, 18_240_032_000],
      promo: [16_680_000_000, 27_360_048_000], list: [33_360_000_000, 54_720_096_000] },
    { modelId: "gpt-6.2-sol", standard: [1_390_000_000, 2_280_004_000],
      batch: [695_000_000, 1_140_002_000], priority: [2_780_000_000, 4_560_008_000],
      promo: [4_170_000_000, 6_840_012_000], list: [8_340_000_000, 13_680_024_000] },
  ];
  function event(modelId, context = 272_000) {
    return ordinaryEvent({ modelId, eventTime: launch, billingSurface: "openai_api", apiServiceTier: "standard",
      totalInputContextTokens: context, components: { ...ordinaryEvent().components,
        inputUncachedTokens: context - 172_000, inputCacheReadTokens: 100_000, inputCacheWriteTokens: 72_000,
        outputTextTokens: 40_000, outputReasoningTokens: 60_000, outputCombinedTokens: 100_000 } });
  }
  function verify(row, costNanousd) {
    assertSame(oracle.module.priceTelemetryUsageEvent, pricer, row, "GPT-6.2 oracle parity");
    const expected = { costNanousd: costNanousd ?? 0,
      pricingStatus: costNanousd === null ? "unpriced" : "fully_priced", modelId: row.modelId };
    assert.deepEqual(fast.module.priceChunkUsageRecord(JSON.stringify(row), row.eventTime), expected,
      "actual bound stored record adapter");
    assert.equal(pricer(row).registrySha256, "eca860219a79a24a2cc1ba07471e2ecc321281508dc7e8d48412deef77609c77");
  }
  for (const prices of modelPrices) {
    for (const [index, context] of [272_000, 272_001].entries()) {
      const row = event(prices.modelId, context);
      for (const apiServiceTier of ["standard", "batch", "priority"]) {
        verify({ ...row, apiServiceTier }, prices[apiServiceTier][index]);
        verify({ ...row, apiServiceTier, eventTime: prelaunch }, null);
      }
      for (const apiServiceTier of ["unknown", "flex"]) verify({ ...row, apiServiceTier }, null);
      verify({ ...row, billingSurface: "chatgpt_subscription", apiServiceTier: "unknown", speedMode: "fast" }, prices.priority[index]);
      for (const billingSurface of ["openai_api", "chatgpt_subscription"]) {
        const ultra = { ...row, billingSurface, apiServiceTier: billingSurface === "openai_api" ? "ultrafast" : "unknown", speedMode: "ultrafast" };
        verify({ ...ultra, eventTime: promoEnd }, prices.promo[index]);
        verify({ ...ultra, eventTime: listStart }, prices.list[index]);
      }
    }
  }
  const law = event("gpt-6.2-astra-law");
  verify(law, 5_560_000_000);
  verify({ ...law, eventTime: prelaunch }, null);
  verify({ ...law, eventTime: "2026-12-31T23:59:59.999Z" }, 5_560_000_000);
  verify({ ...law, eventTime: "2027-01-01T00:00:00.000Z" }, null);
  for (const apiServiceTier of ["unknown", "batch", "priority", "flex", "ultrafast"]) verify({ ...law, apiServiceTier }, null);
  verify({ ...law, billingSurface: "chatgpt_subscription", apiServiceTier: "unknown", speedMode: "fast" }, null);

  const zeros = { ...law, components: Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0])) };
  verify(zeros, 0);
  verify({ ...zeros, apiServiceTier: "flex" }, null);
  verify({ ...zeros, eventTime: prelaunch }, null);
  assert.ok(pricer.getStats().fastPathHits > 0);
  assert.ok(pricer.getStats().fallbackCalls > 0);
});

test("partial observations, split writes, duplicate aliases and large/invalid quantities retain reasons and errors", () => {
  for (const provider of ["openai_codex", "anthropic_claude_code", "unknown"]) {
    const modelId = provider === "anthropic_claude_code" ? "claude-fable-5" : "gpt-5.5";
    for (const key of COMPONENT_KEYS) for (const value of [null, 0, 1, Number.MAX_SAFE_INTEGER, "1.25", "1e1001", -1, 10n ** 25n]) {
      assertSame(oracle.module.priceTelemetryUsageEvent, fast.module.fastPriceTelemetryUsageEvent,
        ordinaryEvent({ provider, modelId, components: { ...ordinaryEvent().components, [key]: value } }), "quantity");
    }
  }
  const event = ordinaryEvent({ provider: "anthropic_claude_code", modelId: "claude-fable-5", components: {
    ...ordinaryEvent().components, inputCacheWriteTokens: null, inputCacheWrite5mTokens: 1, inputCacheWrite1hTokens: null } });
  assertSame(oracle.module.priceTelemetryUsageEvent, fast.module.fastPriceTelemetryUsageEvent, event, "missing-TTL regression");
});

test("result arrays are independently writable and input data is preserved", () => {
  const event = ordinaryEvent();
  const before = JSON.stringify(event), expected = JSON.stringify(oracle.module.priceTelemetryUsageEvent(event));
  const result = fast.module.fastPriceTelemetryUsageEvent(event);
  result.selectedPriceCardIds.push("synthetic-card-mutation"); result.unpricedReasonCodes.push("synthetic-reason-mutation");
  assert.equal(JSON.stringify(fast.module.fastPriceTelemetryUsageEvent(event)), expected);
  assert.equal(JSON.stringify(event), before);
});

test("daily fold, shared preparation and effective usage preparation actually execute the fast binding, with identical bytes", async () => {
  const owner = syntheticOwner(1), day = "2026-09-25";
  const rows = [usage(owner, 1, dayMs(day) + 1000), usage(owner, 2, dayMs(day) + 2000)];
  const marker = Symbol.for("gcp-pricer-binding-proof");
  const compare = async (name, operation) => {
    globalThis[marker] = 0;
    const before = await operation(oracle.module), after = await operation(fast.module);
    assert.equal(JSON.stringify(after), JSON.stringify(before), name);
    assert.ok(globalThis[marker] > 0, `${name} must hit the fast binding`);
  };
  await compare("daily fold", (module) => module.foldV11DailyProjectionValues(module.createV11DailyProjectionValues(day),
    rows.map((row) => JSON.parse(row.recordJson))));
  await compare("shared preparation", (module) => module.prepareSharedAnalyticsDay({ day, ownerDigest: owner.digest,
    usage: rows, quota: [], session: [] }));
  await compare("effective usage preparation", (module) => module.appendEffectiveUsageDay(null, day,
    rows.map(module.mapEffectiveUsagePageRow), owner.digest));
});


test("inherited, non-enumerable and accessor-bearing inputs preserve values and exception evaluation", () => {
  const reference = oracle.module.priceTelemetryUsageEvent;
  const pricer = fast.module.createFastTelemetryUsagePricer();
  const inherited = Object.create(ordinaryEvent());
  assertSame(reference, pricer, inherited, "inherited fields");
  const hidden = ordinaryEvent();
  Object.defineProperty(hidden, "provider", { value: hidden.provider, enumerable: false });
  assertSame(reference, pricer, hidden, "non-enumerable selection field");
  const extra = ordinaryEvent();
  Object.defineProperty(extra, "unused", { enumerable: true, get() { throw new RangeError("synthetic extra field"); } });
  assertSame(reference, pricer, extra, "ignored extra accessor");
  const accessor = ordinaryEvent();
  Object.defineProperty(accessor, "speedMode", { enumerable: true, get() { throw new RangeError("synthetic speed field"); } });
  assertSame(reference, pricer, accessor, "selection accessor exception");
  const hiddenComponent = ordinaryEvent();
  Object.defineProperty(hiddenComponent.components, "inputUncachedTokens", { value: 1500, enumerable: false });
  hiddenComponent.components.synthetic_component = 10;
  assertSame(reference, pricer, hiddenComponent, "hidden known component replaced by extra enumerable component");
  const component = ordinaryEvent();
  Object.defineProperty(component.components, "inputUncachedTokens", { enumerable: true, get() { throw new RangeError("synthetic component field"); } });
  assertSame(reference, pricer, component, "component accessor exception");
});

// Preparation must execute the production binding; reductions reuse its memoized
// prices while retaining the exact scalar and model output bytes.
test("V11 scalar and model reductions preserve bytes through the bound runtime", async () => {
  const owner = syntheticOwner(1), day = "2026-09-28", start = dayMs(day);
  const rows = Array.from({ length: 9 }, (_, i) => usage(owner, i + 1, start + (i + 0.5) * 3_600_000));
  const quotas = Array.from({ length: 9 }, (_, i) => quota(owner, i + 1, start + i * 3_600_000, 5 + i * 10, start + 8 * 86_400_000));
  const pin = { source: "v1.1", participantId: owner.participant, generationId: "synthetic-pricer-reduction",
    fromDay: day, throughDay: day, inputRevision: 1, mutationEpoch: 1, fingerprint: "d".repeat(64) };
  const input = { day, ownerDigest: owner.digest, usage: rows, quota: quotas, session: [] };
  const marker = Symbol.for("gcp-pricer-binding-proof");
  const beforeDay = await oracle.module.prepareSharedAnalyticsDay(input);
  globalThis[marker] = 0;
  const afterDay = await fast.module.prepareSharedAnalyticsDay(input);
  assert.ok(globalThis[marker] > 0, "preparation must execute the fast binding");
  globalThis[marker] = 0;
  const scalarBefore = await oracle.module.evaluateSharedScalarDate({ pin, day, ownerDigest: owner.digest, days: [beforeDay] });
  const scalarAfter = await fast.module.evaluateSharedScalarDate({ pin, day, ownerDigest: owner.digest, days: [afterDay] });
  assert.equal(scalarAfter.analysis.status, "ready");
  assert.ok(scalarAfter.selectedFits.length > 0);
  assert.equal(JSON.stringify(scalarAfter), JSON.stringify(scalarBefore));
  assert.equal(globalThis[marker], 0, "scalar finisher must reuse prepared prices");
  const modelBefore = await oracle.module.evaluateSharedModelDate({ pin, day, ownerDigest: owner.digest, days: [beforeDay] });
  const modelAfter = await fast.module.evaluateSharedModelDate({ pin, day, ownerDigest: owner.digest, days: [afterDay] });
  assert.equal(modelAfter.status, "ready");
  assert.equal(JSON.stringify(modelAfter), JSON.stringify(modelBefore));
  assert.equal(globalThis[marker], 0, "model reduction must reuse prepared prices");
});

test("proxies retain reference property evaluation and revoked-proxy errors", () => {
  const reference = oracle.module.priceTelemetryUsageEvent;
  const pricer = fast.module.createFastTelemetryUsagePricer();
  const proxy = new Proxy(ordinaryEvent(), { getOwnPropertyDescriptor() { throw new RangeError("synthetic descriptor trap"); } });
  assertSame(reference, pricer, proxy, "row proxy descriptor trap");
  const component = ordinaryEvent();
  component.components = new Proxy(component.components, { ownKeys() { throw new RangeError("synthetic ownKeys trap"); } });
  assertSame(reference, pricer, component, "component proxy ownKeys trap");
  for (const location of ["row", "components"]) {
    const event = ordinaryEvent();
    const revocable = Proxy.revocable(location === "row" ? event : event.components, {});
    revocable.revoke();
    if (location === "components") event.components = revocable.proxy;
    assertSame(reference, pricer, location === "row" ? revocable.proxy : event, `revoked ${location} proxy`);
  }
});


test("content-free counters count completed fast results and oracle calls independently per pricer", () => {
  const pricer = fast.module.createFastTelemetryUsagePricer();
  const initial = { fastPathHits: 0, fallbackCalls: 0, planCount: 0, maxPlans: 16_384 };
  assert.deepEqual(pricer.getStats(), initial);
  assertSame(oracle.module.priceTelemetryUsageEvent, pricer, ordinaryEvent(), "counter fast path");
  assertSame(oracle.module.priceTelemetryUsageEvent, pricer, ordinaryEvent(), "counter cached fast path");
  assertSame(oracle.module.priceTelemetryUsageEvent, pricer, ordinaryEvent({ modelId: "synthetic-unlisted-model" }), "counter fallback");
  const throwing = ordinaryEvent();
  Object.defineProperty(throwing, "speedMode", { get() { throw new RangeError("synthetic counter error"); } });
  assert.throws(() => pricer(throwing), RangeError);
  assert.deepEqual(pricer.getStats(), { fastPathHits: 2, fallbackCalls: 2, planCount: 1, maxPlans: 16_384 });
  const snapshot = pricer.getStats();
  snapshot.planCount = -1;
  assert.equal(pricer.getStats().planCount, 1);
  assert.deepEqual(fast.module.createFastTelemetryUsagePricer().getStats(), initial);
});


test("registry initialization retries after partial construction fails", async () => {
  const marker = Symbol.for("gcp-pricer-registry-failed");
  delete globalThis[marker];
  const injected = await loadPricers({ registryFailure: true });
  try {
    const pricer = injected.module.createFastTelemetryUsagePricer();
    assert.throws(() => pricer(ordinaryEvent()), /synthetic registry construction failure/);
    assert.deepEqual(pricer.getStats(), { fastPathHits: 0, fallbackCalls: 0, planCount: 0, maxPlans: 16_384 });
    assertSame(oracle.module.priceTelemetryUsageEvent, pricer, ordinaryEvent(), "retried registry construction");
    assert.equal(pricer.getStats().fastPathHits, 1);
    assert.equal(pricer.getStats().fallbackCalls, 0);
  } finally { await injected.dispose(); delete globalThis[marker]; }
});


test("bounded plan cache reports cap fallback while retained cells remain fast", async () => {
  // Inject a small cap into the real implementation to exercise saturation
  // without compiling thousands of oracle templates in every regular gate.
  const capped = await loadPricers({ planLimit: 2 });
  try {
    const pricer = capped.module.createFastTelemetryUsagePricer();
    const rows = [ordinaryEvent(), ordinaryEvent({ speedMode: "fast" }),
      ordinaryEvent({ billingSurface: "openai_api", apiServiceTier: "standard" })];
    for (const row of rows) assertSame(oracle.module.priceTelemetryUsageEvent, pricer, row, "cap parity");
    assert.deepEqual(pricer.getStats(), { fastPathHits: 2, fallbackCalls: 1, planCount: 2, maxPlans: 2 });
    assertSame(oracle.module.priceTelemetryUsageEvent, pricer, rows[0], "retained cell after saturation");
    assertSame(oracle.module.priceTelemetryUsageEvent, pricer, rows[2], "uncached cell after saturation");
    assert.deepEqual(pricer.getStats(), { fastPathHits: 3, fallbackCalls: 2, planCount: 2, maxPlans: 2 });
  } finally { await capped.dispose(); }
});
