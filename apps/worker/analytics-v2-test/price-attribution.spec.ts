// K-PERCARD: the prepared-day price observer (src/analytics-v2/price-attribution.ts).
// Each prepared owner-day's usage events are projected onto exactly what the
// vendored buildPricingEvent reads, priced through buildPricingEvent and
// priceTelemetryUsageEvent, checked against the kernel's own daily pricing
// block (any difference ends the run), and stored as one canonical, deflated
// document whose sha256 is its identity. Synthetic, content-free records only.
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { prepareAnalyticsV2Day } from "../src/analytics-v2/native-path";
import {
  ANALYTICS_V2_PRICE_INPUTS_CODEC,
  ANALYTICS_V2_PRICE_PROJECTION_VERSION,
  ANALYTICS_V2_PRICE_STATUS,
  analyticsV2KernelPriceCards,
  analyticsV2PriceCards,
  analyticsV2PriceCardSetSha256,
  analyticsV2PriceInput,
  analyticsV2PriceInputsBytes,
  analyticsV2PriceInputsText,
  assertAnalyticsV2PricesMatchDaily,
  attributeAnalyticsV2DayPrices,
  decodeAnalyticsV2PriceInputs,
  encodeAnalyticsV2PriceInputs,
  priceAnalyticsV2Input,
  type AnalyticsV2PriceInputEvent,
} from "../src/analytics-v2/price-attribution";
import { ANALYTICS_V2_DEFAULT_RESOURCES } from "../src/analytics-v2/resources";
import {
  APP_OFFICIAL_PRICE_CARDS,
  createV11DailyProjectionValues,
  foldV11DailyProjectionValues,
  type EffectiveTelemetryOccurrence,
} from "../vendor/analytics-d43c8f92/entry";
import { dayMs, occurrence, quota, syntheticOwner, usage } from "./fixtures/synthetic-occurrences.mjs";

const OWNER = syntheticOwner(1);
const DAY = "2026-09-20";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const at = (minutes: number) => dayMs(DAY) + minutes * 60_000;

/** A v1.1 usage record like the fixture's, with `overrides` applied (synthetic names only). */
function usageWith(index: number, overrides: Record<string, unknown>): EffectiveTelemetryOccurrence {
  const base = usage(OWNER, index, at(index)) as EffectiveTelemetryOccurrence;
  const record = { ...JSON.parse(base.recordJson!), ...overrides };
  return occurrence(OWNER, "usage", at(index), base.occurrenceId, record) as EffectiveTelemetryOccurrence;
}

/** A mixed day: priced events, an unknown model, a missing context, a bare record. */
function mixedUsage(): EffectiveTelemetryOccurrence[] {
  return [
    usage(OWNER, 1, at(1)) as EffectiveTelemetryOccurrence,
    usage(OWNER, 2, at(2)) as EffectiveTelemetryOccurrence,
    usageWith(3, { modelId: "synthetic-unpriced-model" }),
    usageWith(4, { totalInputContextTokens: null }),
    usageWith(5, { components: { inputUncachedTokens: null, inputCacheReadTokens: null, inputCacheWriteTokens: null,
      outputTextTokens: null, outputReasoningTokens: null, outputCombinedTokens: null } }),
    usageWith(6, { modelId: "gpt-5.5", components: { inputUncachedTokens: 1_000_000, inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0, outputTextTokens: 10, outputReasoningTokens: null, outputCombinedTokens: null } }),
  ];
}

async function preparedDaily(rows: readonly EffectiveTelemetryOccurrence[]) {
  const prepared = await prepareAnalyticsV2Day({ day: DAY, ownerDigest: OWNER.digest, usage: rows,
    quota: [quota(OWNER, 90, at(30), 10, at(30) + 8 * 86_400_000)] as EffectiveTelemetryOccurrence[], session: [] },
  ANALYTICS_V2_DEFAULT_RESOURCES);
  return prepared.daily;
}

/** The kernel's own fold of one record: the pricing block the attribution must reproduce. */
function kernelPricing(row: EffectiveTelemetryOccurrence) {
  return foldV11DailyProjectionValues(createV11DailyProjectionValues(DAY), [JSON.parse(row.recordJson!)]).pricing;
}

describe("price attribution (K-PERCARD)", () => {
  it("prices each projection exactly as the kernel's daily fold prices the record", () => {
    const statuses = new Set<number>();
    for (const row of mixedUsage()) {
      const input = analyticsV2PriceInput(JSON.parse(row.recordJson!));
      const priced = priceAnalyticsV2Input(input);
      statuses.add(priced.status);
      const kernel = kernelPricing(row);
      expect(priced.costNanousd.toString()).toBe(kernel.knownNanousd);
      expect([kernel.fullyPriced, kernel.partiallyPriced, kernel.unpriced]).toEqual([
        priced.status === ANALYTICS_V2_PRICE_STATUS.fullyPriced ? 1 : 0,
        priced.status === ANALYTICS_V2_PRICE_STATUS.partiallyPriced ? 1 : 0,
        priced.status <= ANALYTICS_V2_PRICE_STATUS.unpriced ? 1 : 0,
      ]);
      // Every priced event names the cards that priced it; an unpriced one names none.
      if (priced.status >= ANALYTICS_V2_PRICE_STATUS.partiallyPriced) expect(priced.cardIds.length).toBeGreaterThan(0);
      expect([...priced.cardIds]).toEqual([...new Set(priced.cardIds)].sort());
    }
    // The corpus reaches the unshapeable, unpriced and fully priced statuses.
    expect([...statuses].sort()).toEqual(expect.arrayContaining([ANALYTICS_V2_PRICE_STATUS.unshapeable,
      ANALYTICS_V2_PRICE_STATUS.unpriced, ANALYTICS_V2_PRICE_STATUS.fullyPriced]));
  });

  it("projects only what buildPricingEvent reads: other fields do not change the price input", () => {
    const record = JSON.parse(mixedUsage()[0]!.recordJson!);
    const projection = analyticsV2PriceInput(record);
    expect(Object.keys(projection).sort()).toEqual(["apiServiceTier", "billingSurface", "components", "eventTimeMs",
      "modelId", "provider", "reasoningEffort", "speedMode", "totalInputContextTokens"]);
    expect(analyticsV2PriceInput({ ...record, sessionUuid: "another-synthetic-session", outcome: "interrupted",
      surface: "another", agentScope: "subagent" })).toEqual(projection);
    // An absent field and a null field price the same, so null stands for both.
    const { totalInputContextTokens: _context, ...withoutContext } = record;
    expect(analyticsV2PriceInput(withoutContext)).toEqual(analyticsV2PriceInput({ ...record, totalInputContextTokens: null }));
  });

  it("attributes a prepared day and agrees with the kernel's daily pricing block", async () => {
    const rows = mixedUsage();
    const daily = await preparedDaily(rows);
    const attribution = await attributeAnalyticsV2DayPrices({ day: DAY, usage: rows, daily });
    expect(attribution.usageEvents).toBe(rows.length);
    expect(attribution.unpricedEvents).toBe(daily.pricing.unpriced);
    expect(attribution.partiallyPricedEvents).toBe(daily.pricing.partiallyPriced);
    expect(attribution.inputs).toMatchObject({ projectionVersion: ANALYTICS_V2_PRICE_PROJECTION_VERSION,
      codec: ANALYTICS_V2_PRICE_INPUTS_CODEC, events: rows.length });
    // The basis is every card any event selected, from the kernel's own card set.
    const cards = new Set((await analyticsV2KernelPriceCards()).cards.map((card) => card.cardId));
    expect(attribution.cardIds.length).toBeGreaterThan(0);
    expect(attribution.cardIds.every((cardId) => cards.has(cardId))).toBe(true);
    // The stored document decodes to the same events, under the same digest.
    const decoded = await decodeAnalyticsV2PriceInputs({ ...attribution.inputs,
      bytes: analyticsV2PriceInputsBytes(attribution.inputs.data) });
    expect(decoded.cardIds).toEqual(attribution.cardIds);
    expect(decoded.events.map((event) => event.priced)).toEqual(rows.map((row) =>
      priceAnalyticsV2Input(analyticsV2PriceInput(JSON.parse(row.recordJson!)))));
    expect(sha(analyticsV2PriceInputsText(decoded.events).text)).toBe(attribution.inputs.sha256);
    // Deterministic: the same day encodes to the same identity.
    expect((await attributeAnalyticsV2DayPrices({ day: DAY, usage: rows, daily })).inputs.sha256)
      .toBe(attribution.inputs.sha256);
  });

  it("checks the omitted subtotal past the 200 lexical cells", async () => {
    // 205 synthetic models (unpriced) plus priced fixture events.
    const rows = [usage(OWNER, 1, at(1)) as EffectiveTelemetryOccurrence,
      ...Array.from({ length: 205 }, (_, index) => usageWith(10 + index, { modelId: `synthetic-model-${index}` }))]
      .sort((left, right) => left.eventTime! < right.eventTime! ? -1 : left.eventTime! > right.eventTime! ? 1
        : left.occurrenceId < right.occurrenceId ? -1 : 1);
    const daily = await preparedDaily(rows);
    expect(daily.omitted.usageEvents).toBeGreaterThan(0);
    const attribution = await attributeAnalyticsV2DayPrices({ day: DAY, usage: rows, daily });
    expect(attribution.usageEvents).toBe(206);
  });

  it("fails the run on any disagreement with the kernel's daily values (ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH)", async () => {
    const rows = mixedUsage();
    const daily = await preparedDaily(rows);
    const events: AnalyticsV2PriceInputEvent[] = rows.map((row) => {
      const input = analyticsV2PriceInput(JSON.parse(row.recordJson!));
      return { input, priced: priceAnalyticsV2Input(input) };
    });
    expect(() => assertAnalyticsV2PricesMatchDaily(DAY, events, daily)).not.toThrow();
    const mismatch = { code: "ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH" };
    const tampered = (edit: (copy: typeof daily) => void) => {
      const copy = structuredClone(daily);
      edit(copy);
      return () => assertAnalyticsV2PricesMatchDaily(DAY, events, copy);
    };
    expect(tampered((copy) => { copy.pricing.knownNanousd = (BigInt(copy.pricing.knownNanousd) + 1n).toString(); }))
      .toThrow(expect.objectContaining(mismatch));
    expect(tampered((copy) => { copy.cells[0]!.pricing.fullyPriced += 1; copy.cells[0]!.pricing.unpriced -= 1; }))
      .toThrow(expect.objectContaining(mismatch));
    expect(tampered((copy) => { copy.cells.reverse(); })).toThrow(expect.objectContaining(mismatch));
    expect(tampered((copy) => { copy.counts.usage += 1; })).toThrow(expect.objectContaining(mismatch));
    expect(tampered((copy) => { copy.omitted.usageEvents = 1; })).toThrow(expect.objectContaining(mismatch));
    expect(tampered((copy) => { copy.day = "2026-09-21"; })).toThrow(expect.objectContaining(mismatch));
    // One event priced differently (a stale pricer) disagrees, in either direction.
    const shifted = events.map((event, index) => index !== 0 ? event
      : { ...event, priced: { ...event.priced, costNanousd: event.priced.costNanousd + 1 } });
    expect(() => assertAnalyticsV2PricesMatchDaily(DAY, shifted, daily)).toThrow(expect.objectContaining(mismatch));
    // An event missing from the attribution disagrees.
    expect(() => assertAnalyticsV2PricesMatchDaily(DAY, events.slice(1), daily)).toThrow(expect.objectContaining(mismatch));
    await expect(attributeAnalyticsV2DayPrices({ day: DAY, usage: rows.slice(1), daily }))
      .rejects.toMatchObject(mismatch);
  });

  it("refuses a value it cannot store instead of dropping or renaming it (ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE)", () => {
    const record = JSON.parse(mixedUsage()[0]!.recordJson!);
    const unrepresentable = { code: "ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE" };
    for (const value of [
      { ...record, modelId: "a model with spaces" }, { ...record, modelId: "m".repeat(65) },
      { ...record, provider: null }, { ...record, eventTime: "not-a-time" }, { ...record, speedMode: 7 },
      { ...record, totalInputContextTokens: -1 }, { ...record, totalInputContextTokens: 1.5 },
      { ...record, components: { ...record.components, inputUncachedTokens: Number.MAX_SAFE_INTEGER + 2 } },
      null, [], "record",
    ]) {
      expect(() => analyticsV2PriceInput(value)).toThrow(expect.objectContaining(unrepresentable));
    }
  });

  it("decodes only an intact, canonical document (ANALYTICS_V2_PRICE_INPUTS_CORRUPT)", async () => {
    const rows = mixedUsage();
    const events = rows.map((row) => {
      const input = analyticsV2PriceInput(JSON.parse(row.recordJson!));
      return { input, priced: priceAnalyticsV2Input(input) };
    });
    const { inputs } = await encodeAnalyticsV2PriceInputs(events);
    const stored = { ...inputs, bytes: analyticsV2PriceInputsBytes(inputs.data) };
    await expect(decodeAnalyticsV2PriceInputs(stored)).resolves.toMatchObject({ events: expect.any(Array) });
    const corrupt = { code: "ANALYTICS_V2_PRICE_INPUTS_CORRUPT" };
    // The stored identity, the codec and the event count are checked.
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, sha256: "0".repeat(64) })).rejects.toMatchObject(corrupt);
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, events: stored.events + 1 })).rejects.toMatchObject(corrupt);
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, codec: "gzip" })).rejects.toMatchObject(corrupt);
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, projectionVersion: "analytics-v2-price-input-v2" }))
      .rejects.toMatchObject(corrupt);
    // Damaged bytes never decode partially.
    const damaged = Uint8Array.from(stored.bytes);
    damaged[Math.floor(damaged.length / 2)]! ^= 0xff;
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, bytes: damaged })).rejects.toMatchObject(corrupt);
    expect(() => analyticsV2PriceInputsBytes("not base64!")).toThrow(expect.objectContaining(corrupt));
    // A document that is valid JSON with the right digest is still refused
    // when it is not the canonical form of what it claims.
    const { text } = analyticsV2PriceInputsText(events);
    const document = JSON.parse(text) as { cards: string[]; keys: unknown[]; events: unknown[][]; v: string };
    const restored = async (edit: (copy: typeof document) => void) => {
      const copy = structuredClone(document);
      edit(copy);
      const body = JSON.stringify(copy);
      return decodeAnalyticsV2PriceInputs({ ...stored, events: copy.events.length, sha256: sha(body),
        bytes: new Uint8Array(deflateRawSync(Buffer.from(body))) });
    };
    await expect(restored(() => {})).resolves.toMatchObject({ cardIds: expect.any(Array) });
    await expect(restored((copy) => { copy.cards.reverse(); })).rejects.toMatchObject(corrupt);
    await expect(restored((copy) => { copy.events[0]![11] = [copy.cards.length]; })).rejects.toMatchObject(corrupt);
    await expect(restored((copy) => {
      const unpriced = copy.events.find((event) => (event[10] as number) <= ANALYTICS_V2_PRICE_STATUS.unpriced)!;
      unpriced[9] = 5;
    })).rejects.toMatchObject(corrupt);
    await expect(restored((copy) => { copy.events[0]![1] = copy.keys.length; })).rejects.toMatchObject(corrupt);
    await expect(restored((copy) => { copy.events[0]!.push(0); })).rejects.toMatchObject(corrupt);
    await expect(restored((copy) => { (copy as Record<string, unknown>).extra = 1; })).rejects.toMatchObject(corrupt);
    // Valid content in another key order is not the canonical text.
    const reordered = JSON.stringify({ v: document.v, events: document.events, keys: document.keys, cards: document.cards });
    await expect(decodeAnalyticsV2PriceInputs({ ...stored, sha256: sha(reordered),
      bytes: new Uint8Array(deflateRawSync(Buffer.from(reordered))) })).rejects.toMatchObject(corrupt);
  });

  it("registers the kernel's cards by id and canonical content", async () => {
    const kernel = await analyticsV2KernelPriceCards();
    expect(kernel.cards.length).toBe(APP_OFFICIAL_PRICE_CARDS.length);
    expect(kernel.cards.map((card) => card.cardId)).toEqual(APP_OFFICIAL_PRICE_CARDS.map((card) => card.id)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    const first = APP_OFFICIAL_PRICE_CARDS[0]!;
    expect(kernel.cards.find((card) => card.cardId === first.id)!.contentSha256).toBe(sha(canonicalJson(first)));
    expect(kernel.cardsSha256).toBe(await analyticsV2PriceCardSetSha256(kernel.cards));
    // A changed card (same id, other content) is another card, and another set.
    const changed = await analyticsV2PriceCards([...APP_OFFICIAL_PRICE_CARDS.slice(1),
      { ...first, effective: { to: "2099-01-01" } }]);
    expect(changed.cards.find((card) => card.cardId === first.id)!.contentSha256)
      .not.toBe(sha(canonicalJson(first)));
    expect(changed.cardsSha256).not.toBe(kernel.cardsSha256);
    // Order does not matter; duplicates and malformed ids are refused.
    expect((await analyticsV2PriceCards([...APP_OFFICIAL_PRICE_CARDS].reverse())).cardsSha256).toBe(kernel.cardsSha256);
    const invalid = { code: "ANALYTICS_V2_PRICE_CARDS_INVALID" };
    await expect(analyticsV2PriceCards([first, first])).rejects.toMatchObject(invalid);
    await expect(analyticsV2PriceCards([{ ...first, id: "a card id" }])).rejects.toMatchObject(invalid);
    await expect(analyticsV2PriceCards([])).rejects.toMatchObject(invalid);
  });
});
