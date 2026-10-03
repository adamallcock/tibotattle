// K-PERCARD: kernel transitions and per-card price staleness
// (src/analytics-v2/price-transition.ts). A transition is compatible only
// when both compute classes are known and equal AND every stored event the
// older kernel fully priced with unchanged cards prices exactly as before;
// the stale set (a removed or changed card, a repriced event, an unknown
// price) is recorded either way. The derived regime recomputes exactly the
// owner-days a transition leaves unproven, incompatible or stale.
// Synthetic, content-free inputs only.
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_V2_PRICE_STATUS,
  analyticsV2KernelPriceCards,
  analyticsV2PriceInput,
  priceAnalyticsV2Input,
  type AnalyticsV2PriceCard,
  type AnalyticsV2PriceInput,
  type AnalyticsV2PriceInputEvent,
  type AnalyticsV2PricedEvent,
} from "../src/analytics-v2/price-attribution";
import {
  ANALYTICS_V2_STALE_CAUSE,
  analyticsV2PriceDirtyOwnerDays,
  analyticsV2PriceTransitionProof,
  analyticsV2WindowPriceBasisSha256,
  diffAnalyticsV2KernelCards,
  proveAnalyticsV2DayPrices,
} from "../src/analytics-v2/price-transition";

const hex = (digit: string) => digit.repeat(64);
const card = (cardId: string, content: string): AnalyticsV2PriceCard => ({ cardId, contentSha256: hex(content) });
const OWNER = hex("1");
const OTHER = hex("2");

/** One synthetic stored event: a projection and the result an older kernel stored for it. */
function stored(modelId: string, priced: AnalyticsV2PricedEvent): AnalyticsV2PriceInputEvent {
  const input = analyticsV2PriceInput({ provider: "openai_codex", modelId, billingSurface: "chatgpt_subscription",
    speedMode: "standard", apiServiceTier: "default", reasoningEffort: "high", eventTime: "2026-09-20T12:00:00.000Z",
    totalInputContextTokens: 1000, components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } });
  return { input, priced };
}
const full = (cost: number, ...cardIds: string[]): AnalyticsV2PricedEvent =>
  ({ costNanousd: cost, status: ANALYTICS_V2_PRICE_STATUS.fullyPriced, cardIds });
const unpriced: AnalyticsV2PricedEvent = { costNanousd: 0, status: ANALYTICS_V2_PRICE_STATUS.unpriced, cardIds: [] };
/** A stand-in for a newer kernel's pricer: a fixed result per model. */
const pricer = (byModel: Record<string, AnalyticsV2PricedEvent>) =>
  (input: AnalyticsV2PriceInput): AnalyticsV2PricedEvent => byModel[input.modelId!] ?? unpriced;

describe("kernel card diff", () => {
  it("separates added, removed, changed and unchanged cards by id and content", () => {
    const diff = diffAnalyticsV2KernelCards([card("a", "1"), card("b", "2"), card("c", "3")],
      [card("a", "1"), card("b", "9"), card("d", "4")]);
    expect([diff.added, diff.removed, diff.changed, [...diff.unchanged]]).toEqual([["d"], ["c"], ["b"], ["a"]]);
    expect(() => diffAnalyticsV2KernelCards([card("a", "1"), card("a", "2")], []))
      .toThrow("ANALYTICS_V2_PRICE_TRANSITION_INVALID");
  });
});

describe("the proof over one stored owner-day", () => {
  const same = diffAnalyticsV2KernelCards([card("a", "1"), card("b", "2")], [card("a", "1"), card("b", "2")]);

  it("an owner-day that prices exactly as stored is not stale", () => {
    const events = [stored("m1", full(10, "a")), stored("m2", unpriced)];
    expect(proveAnalyticsV2DayPrices(events, same, pricer({ m1: full(10, "a") })))
      .toEqual({ cause: null, violation: false, events: 2 });
  });

  it("a removed or changed card in the basis makes the owner-day stale (cause 1)", () => {
    const events = [stored("m1", full(10, "a")), stored("m2", full(20, "b"))];
    const changed = diffAnalyticsV2KernelCards([card("a", "1"), card("b", "2")], [card("a", "1"), card("b", "7")]);
    // Even when the new card happens to price it the same.
    expect(proveAnalyticsV2DayPrices(events, changed, pricer({ m1: full(10, "a"), m2: full(20, "b") })))
      .toEqual({ cause: ANALYTICS_V2_STALE_CAUSE.cardChanged, violation: false, events: 2 });
    const removed = diffAnalyticsV2KernelCards([card("a", "1"), card("b", "2")], [card("a", "1")]);
    expect(proveAnalyticsV2DayPrices(events, removed, pricer({ m1: full(10, "a") })))
      .toEqual({ cause: ANALYTICS_V2_STALE_CAUSE.cardChanged, violation: false, events: 2 });
  });

  it("an unpriced or partial event a new card now prices makes the owner-day stale (cause 2), compatibly", () => {
    const added = diffAnalyticsV2KernelCards([card("a", "1")], [card("a", "1"), card("n", "5")]);
    const events = [stored("m1", full(10, "a")), stored("new-model", unpriced)];
    expect(proveAnalyticsV2DayPrices(events, added, pricer({ m1: full(10, "a"), "new-model": full(7, "n") })))
      .toEqual({ cause: ANALYTICS_V2_STALE_CAUSE.repriced, violation: false, events: 2 });
    const partial: AnalyticsV2PricedEvent = { costNanousd: 3, status: ANALYTICS_V2_PRICE_STATUS.partiallyPriced,
      cardIds: ["a"] };
    expect(proveAnalyticsV2DayPrices([stored("m1", partial)], added, pricer({ m1: full(9, "a", "n") })))
      .toEqual({ cause: ANALYTICS_V2_STALE_CAUSE.repriced, violation: false, events: 1 });
  });

  it("a fully priced event on unchanged cards that prices differently is a proof violation", () => {
    for (const now of [full(11, "a"), full(10, "a", "n"), unpriced,
      { costNanousd: 10, status: ANALYTICS_V2_PRICE_STATUS.partiallyPriced, cardIds: ["a"] }]) {
      expect(proveAnalyticsV2DayPrices([stored("m1", full(10, "a"))], same, pricer({ m1: now as AnalyticsV2PricedEvent })))
        .toEqual({ cause: ANALYTICS_V2_STALE_CAUSE.repriced, violation: true, events: 1 });
    }
  });

  it("repricing with this bundle's own kernel reproduces what it stored", () => {
    const cards = new Set<string>();
    const events = ["gpt-5.6-sol", "gpt-5.5", "synthetic-unpriced-model"].map((modelId) => {
      const input = stored(modelId, unpriced).input;
      const priced = priceAnalyticsV2Input(input);
      for (const cardId of priced.cardIds) cards.add(cardId);
      return { input, priced };
    });
    const own = [...cards].map((cardId) => card(cardId, "c"));
    expect(proveAnalyticsV2DayPrices(events, diffAnalyticsV2KernelCards(own, own)))
      .toEqual({ cause: null, violation: false, events: 3 });
  });
});

describe("the transition verdict", () => {
  const diff = diffAnalyticsV2KernelCards([card("a", "1")], [card("a", "1"), card("n", "2")]);
  const base = { fromKernel: 3, toKernel: 4, fromComputeSha256: hex("c"), toComputeSha256: hex("c"), diff,
    ownerDays: 3, events: 9, violation: false, stale: [] };

  it("is compatible only when both compute classes are known and equal and the proof holds", () => {
    expect(analyticsV2PriceTransitionProof(base)).toMatchObject({ computeEqual: true, proofHolds: true, compatible: true,
      cardsAdded: 1, cardsRemoved: 0, cardsChanged: 0 });
    expect(analyticsV2PriceTransitionProof({ ...base, violation: true }))
      .toMatchObject({ computeEqual: true, proofHolds: false, compatible: false });
    expect(analyticsV2PriceTransitionProof({ ...base, toComputeSha256: hex("d") }))
      .toMatchObject({ computeEqual: false, compatible: false });
    // An unknown compute class is no claim: never compatible, even against another unknown.
    for (const [from, to] of [[null, hex("c")], [hex("c"), null], [null, null]] as const) {
      expect(analyticsV2PriceTransitionProof({ ...base, fromComputeSha256: from, toComputeSha256: to }).compatible).toBe(false);
    }
    // Unknown cards: no diff counts.
    expect(analyticsV2PriceTransitionProof({ ...base, fromComputeSha256: null, diff: null }))
      .toMatchObject({ cardsAdded: null, cardsRemoved: null, cardsChanged: null, compatible: false });
  });

  it("sorts its stale set and refuses an inconsistent one", () => {
    const proof = analyticsV2PriceTransitionProof({ ...base, stale: [
      { ownerDigest: OTHER, day: "2026-09-01", cause: ANALYTICS_V2_STALE_CAUSE.priceUnknown },
      { ownerDigest: OWNER, day: "2026-09-02", cause: ANALYTICS_V2_STALE_CAUSE.repriced },
      { ownerDigest: OWNER, day: "2026-09-01", cause: ANALYTICS_V2_STALE_CAUSE.cardChanged }] });
    expect(proof.stale.map((entry) => [entry.ownerDigest[0], entry.day])).toEqual([["1", "2026-09-01"],
      ["1", "2026-09-02"], ["2", "2026-09-01"]]);
    const refused = "ANALYTICS_V2_PRICE_TRANSITION_INVALID";
    const entry = { ownerDigest: OWNER, day: "2026-09-01", cause: ANALYTICS_V2_STALE_CAUSE.repriced };
    expect(() => analyticsV2PriceTransitionProof({ ...base, stale: [entry, entry] })).toThrow(refused);
    expect(() => analyticsV2PriceTransitionProof({ ...base, ownerDays: 0, stale: [entry] })).toThrow(refused);
    expect(() => analyticsV2PriceTransitionProof({ ...base, stale: [{ ...entry, cause: 4 as 1 }] })).toThrow(refused);
    expect(() => analyticsV2PriceTransitionProof({ ...base, fromKernel: 4 })).toThrow(refused);
    expect(() => analyticsV2PriceTransitionProof({ ...base, fromComputeSha256: "C".repeat(64) })).toThrow(refused);
  });
});

describe("derived-regime dirtiness", () => {
  const transitions = [
    { transitionId: 1, fromKernel: 1, toKernel: 3, compatible: false },
    { transitionId: 2, fromKernel: 2, toKernel: 3, compatible: true },
    // A transition to another kernel says nothing about this one.
    { transitionId: 3, fromKernel: 1, toKernel: 2, compatible: true },
  ];
  const stale = [{ transitionId: 2, ownerDigest: OWNER, day: "2026-09-02" },
    { transitionId: 3, ownerDigest: OWNER, day: "2026-09-04" }];

  it("recomputes exactly the owner-days a transition leaves unproven, incompatible or stale", () => {
    const rows = [
      { ownerDigest: OWNER, day: "2026-09-01", kernelId: 3 },
      { ownerDigest: OWNER, day: "2026-09-02", kernelId: 2 },
      { ownerDigest: OWNER, day: "2026-09-03", kernelId: 2 },
      { ownerDigest: OWNER, day: "2026-09-04", kernelId: 1 },
      { ownerDigest: OTHER, day: "2026-09-01", kernelId: null },
    ];
    expect(analyticsV2PriceDirtyOwnerDays({ currentKernelId: 3, transitions, stale, rows })).toEqual([
      { ownerDigest: OWNER, day: "2026-09-02", cause: "stale" },
      { ownerDigest: OWNER, day: "2026-09-04", cause: "incompatible" },
      { ownerDigest: OTHER, day: "2026-09-01", cause: "unattributed" },
    ]);
    // No recorded transition: nothing proves the row, so it is dirty.
    expect(analyticsV2PriceDirtyOwnerDays({ currentKernelId: 4, transitions, stale,
      rows: [{ ownerDigest: OWNER, day: "2026-09-03", kernelId: 2 }] }))
      .toEqual([{ ownerDigest: OWNER, day: "2026-09-03", cause: "unproven" }]);
  });

  it("refuses a row from a newer kernel and a duplicated transition", () => {
    expect(() => analyticsV2PriceDirtyOwnerDays({ currentKernelId: 2, transitions: [], stale: [],
      rows: [{ ownerDigest: OWNER, day: "2026-09-01", kernelId: 3 }] })).toThrow("ANALYTICS_V2_PRICE_TRANSITION_INVALID");
    expect(() => analyticsV2PriceDirtyOwnerDays({ currentKernelId: 3, transitions: [transitions[0]!, transitions[0]!],
      stale: [], rows: [] })).toThrow("ANALYTICS_V2_PRICE_TRANSITION_INVALID");
  });

  it("a window's price-basis digest moves with exactly the days whose basis changed", async () => {
    const days = [{ day: "2026-09-01", basisSha256: hex("a") }, { day: "2026-09-02", basisSha256: null },
      { day: "2026-09-03", basisSha256: hex("b") }];
    const digest = await analyticsV2WindowPriceBasisSha256(days);
    expect(await analyticsV2WindowPriceBasisSha256([...days].reverse())).toBe(digest);
    expect(await analyticsV2WindowPriceBasisSha256([days[0]!, days[1]!, { ...days[2]!, basisSha256: hex("c") }]))
      .not.toBe(digest);
    // No price row is not an empty basis.
    expect(await analyticsV2WindowPriceBasisSha256([days[0]!, { ...days[1]!, basisSha256: hex("e") }, days[2]!]))
      .not.toBe(digest);
    await expect(analyticsV2WindowPriceBasisSha256([days[0]!, days[0]!])).rejects.toThrow("ANALYTICS_V2_PRICE_TRANSITION_INVALID");
  });

  it("the bundle's own cards diff to nothing", async () => {
    const { cards } = await analyticsV2KernelPriceCards();
    const diff = diffAnalyticsV2KernelCards(cards, cards);
    expect([diff.added.length, diff.removed.length, diff.changed.length, diff.unchanged.size]).toEqual([0, 0, 0, cards.length]);
  });
});
