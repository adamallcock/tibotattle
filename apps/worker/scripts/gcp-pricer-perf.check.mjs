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

// The production scalar finisher reprices raw rows even after day preparation.
// Reset the counter after preparation so this assertion proves that second seam.
test("V11 scalar and model reductions preserve bytes through the bound runtime", async () => {
  const owner = syntheticOwner(1), day = "2026-09-28", start = dayMs(day);
  const rows = Array.from({ length: 9 }, (_, i) => usage(owner, i + 1, start + (i + 0.5) * 3_600_000));
  const quotas = Array.from({ length: 9 }, (_, i) => quota(owner, i + 1, start + i * 3_600_000, 5 + i * 10, start + 8 * 86_400_000));
  const pin = { source: "v1.1", participantId: owner.participant, generationId: "synthetic-pricer-reduction",
    fromDay: day, throughDay: day, inputRevision: 1, mutationEpoch: 1, fingerprint: "d".repeat(64) };
  const input = { day, ownerDigest: owner.digest, usage: rows, quota: quotas, session: [] };
  const beforeDay = await oracle.module.prepareSharedAnalyticsDay(input);
  const afterDay = await fast.module.prepareSharedAnalyticsDay(input);
  const marker = Symbol.for("gcp-pricer-binding-proof");
  globalThis[marker] = 0;
  const scalarBefore = await oracle.module.evaluateSharedScalarDate({ pin, day, ownerDigest: owner.digest, days: [beforeDay] });
  const scalarAfter = await fast.module.evaluateSharedScalarDate({ pin, day, ownerDigest: owner.digest, days: [afterDay] });
  assert.equal(scalarAfter.analysis.status, "ready");
  assert.ok(scalarAfter.selectedFits.length > 0);
  assert.equal(JSON.stringify(scalarAfter), JSON.stringify(scalarBefore));
  assert.ok(globalThis[marker] > 0, "scalar finisher must execute the fast binding after preparation");
  const modelBefore = await oracle.module.evaluateSharedModelDate({ pin, day, ownerDigest: owner.digest, days: [beforeDay] });
  const modelAfter = await fast.module.evaluateSharedModelDate({ pin, day, ownerDigest: owner.digest, days: [afterDay] });
  assert.equal(modelAfter.status, "ready");
  assert.equal(JSON.stringify(modelAfter), JSON.stringify(modelBefore));
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
