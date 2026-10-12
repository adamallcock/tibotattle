// Synthetic saved-cohort fixtures only: historical repricing must preserve
// membership and every non-spend value, and refuse unproven input association.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import {
  ANALYTICS_V2_REPRICE_LIMITS,
  analyticsV2RepriceNonSpend,
  prepareAnalyticsV2RepriceHead,
  repriceAnalyticsV2Contribution,
  validAnalyticsV2RepriceBounds,
  type AnalyticsV2RepriceHead,
  type AnalyticsV2RepriceMember,
} from "../src/analytics-v2/reprice";
import {
  ANALYTICS_V2_PRICE_STATUS,
  analyticsV2PriceInput,
  analyticsV2PriceInputsBytes,
  encodeAnalyticsV2PriceInputs,
  priceAnalyticsV2Input,
  type AnalyticsV2PricedEvent,
} from "../src/analytics-v2/price-attribution";
import { analyticsV2DailyContentSha256 } from "../src/analytics-v2/store-run";
import {
  buildCommunityDailyPayload,
  createV11DailyProjectionValues,
  foldV11DailyProjectionValues,
  publicInputs,
  validateV11DailyProjectionValues,
  type V11DailyProjectionValues,
} from "../vendor/analytics-d43c8f92/entry";
import { dayMs, syntheticOwner, usage } from "./fixtures/synthetic-occurrences.mjs";

const DAY = "2026-09-20";
const RELEASED_AT = "2026-09-21T03:00:00.000Z";
const RUN = "11111111-1111-4111-8111-111111111111";
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const OWNER = syntheticOwner(1);

function records(count = 1, overrides: (index: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    ...JSON.parse(usage(OWNER, index + 1, dayMs(DAY) + (index + 1) * 1000).recordJson),
    ...overrides(index),
  }));
}

async function member(n = 1, rows = records()): Promise<AnalyticsV2RepriceMember> {
  let values = createV11DailyProjectionValues(DAY);
  for (let offset = 0; offset < rows.length; offset += 200) {
    values = foldV11DailyProjectionValues(values, rows.slice(offset, offset + 200));
  }
  const events = rows.map((row) => {
    const input = analyticsV2PriceInput(row);
    return { input, priced: priceAnalyticsV2Input(input) };
  });
  const { inputs } = await encodeAnalyticsV2PriceInputs(events);
  return { ownerDigest: n.toString(16).padStart(64, "0"), version: 3, devices: 2,
    values, valuesSha256: sha(values), runId: RUN, priceKernelId: 11,
    participantLinked: true, excluded: false, priceRunId: RUN, inputKernelId: 11,
    inputs: { ...inputs, bytes: analyticsV2PriceInputsBytes(inputs.data) } };
}

async function head(members: readonly AnalyticsV2RepriceMember[],
  mutate?: (payload: Record<string, unknown>) => void): Promise<AnalyticsV2RepriceHead> {
  const folded = [...members].filter((m) => !m.excluded).sort((a, b) => a.ownerDigest.localeCompare(b.ownerDigest));
  const payload = buildCommunityDailyPayload({ day: DAY, revision: 7, releasedAt: RELEASED_AT,
    ...publicInputs(folded.map((m) => m.values as V11DailyProjectionValues), folded.map((m) => m.devices)) }) as unknown as Record<string, unknown>;
  mutate?.(payload);
  return { day: DAY, revision: 7, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
    recorded: true, members };
}

const spend = (payload: Record<string, unknown>) => payload.apiEquivalentSpend as Record<string, unknown>;
const full = (costNanousd: number): AnalyticsV2PricedEvent => ({ costNanousd,
  status: ANALYTICS_V2_PRICE_STATUS.fullyPriced, cardIds: [] });

describe("bounded historical saved-cohort repricing", () => {
  it("keeps an unchanged head and contribution byte-for-byte", async () => {
    const saved = await member();
    const input = await head([saved]);
    const before = structuredClone(input);
    const result = await prepareAnalyticsV2RepriceHead(input);
    expect(result.outcome).toBe("unchanged");
    expect(result.refusal).toBeNull();
    expect(result.payload).toEqual(input.payload);
    expect(result.members.map((entry) => entry.values)).toEqual([saved.values]);
    expect(input).toEqual(before);
  });

  it("recognizes a stamp-only equivalence without changing the revision or release time", async () => {
    const input = await head([await member()], (payload) => {
      spend(payload).registrySha256 = "a".repeat(64);
      spend(payload).pricingMethodVersion = "synthetic-historical-price-method";
    });
    const result = await prepareAnalyticsV2RepriceHead(input);
    expect(result.outcome).toBe("equivalent");
    expect(spend(result.payload!).registrySha256).toBe(createV11DailyProjectionValues(DAY).registrySha256);
    expect(result.payload!.revision).toBe(7);
    expect(result.payload!.releasedAt).toBe(RELEASED_AT);
    expect(analyticsV2RepriceNonSpend(result.payload!)).toBe(analyticsV2RepriceNonSpend(input.payload));
  });

  it("accepts historical contribution stamps only after verifying the exact saved-value digest", async () => {
    const current = await member();
    const values = structuredClone(current.values) as V11DailyProjectionValues;
    values.registrySha256 = "b".repeat(64);
    values.pricingMethodVersion = "server-api-price-equivalent-v0.5";
    const saved = { ...current, values, valuesSha256: sha(values) };
    expect(await repriceAnalyticsV2Contribution(DAY, saved)).toEqual(current.values);
    await expect(repriceAnalyticsV2Contribution(DAY, { ...saved, valuesSha256: current.valuesSha256 }))
      .rejects.toThrow("contribution_invalid");
    expect(saved.values).toEqual(values);
  });

  it.each([
    { registrySha256: "malformed" },
    { registrySha256: "A".repeat(64) },
    { pricingMethodVersion: "synthetic-historical-price-method" },
    { pricingMethodVersion: "server-api-price-equivalent-v0" },
  ])("refuses a malformed historical price identity even with a matching saved digest: %j", async (change) => {
    const saved = await member();
    const values = { ...(saved.values as V11DailyProjectionValues), ...change };
    await expect(repriceAnalyticsV2Contribution(DAY, { ...saved, values, valuesSha256: sha(values) }))
      .rejects.toThrow("contribution_invalid");
  });

  it("changes spend while preserving all non-spend values and the saved cohort", async () => {
    const saved = await member(2);
    const departed = await member(1, records(2));
    const input = await head([saved, departed]);
    const result = await prepareAnalyticsV2RepriceHead(input, () => full(123));
    expect(result.outcome).toBe("changed");
    expect(result.members.map((entry) => entry.member.ownerDigest)).toEqual([departed.ownerDigest, saved.ownerDigest]);
    expect(result.members.map((entry) => entry.member.version)).toEqual([3, 3]);
    expect(result.members.map((entry) => entry.values.pricing.knownNanousd)).toEqual(["246", "123"]);
    expect(analyticsV2RepriceNonSpend(result.payload!)).toBe(analyticsV2RepriceNonSpend(input.payload));
    // No roster is supplied: a departed linked member remains part of S(d).
    expect(input.members).toEqual([saved, departed]);
  });

  it("retains an excluded departed member in S(d) but folds and reprices none of its values", async () => {
    const included = await member(1);
    const excluded = { ...await member(2, records(3)), excluded: true, inputs: null,
      priceRunId: null, inputKernelId: null };
    const input = await head([excluded, included]);
    const price = vi.fn(() => full(42));
    const result = await prepareAnalyticsV2RepriceHead(input, price);
    expect(result.outcome).toBe("changed");
    expect(price).toHaveBeenCalledTimes(1);
    expect(result.members.map((entry) => entry.member.ownerDigest)).toEqual([included.ownerDigest]);
    expect(result.head.members).toEqual([excluded, included]);
    expect(analyticsV2RepriceNonSpend(result.payload!)).toBe(analyticsV2RepriceNonSpend(input.payload));
  });

  it.each([
    ["different run", { priceRunId: "22222222-2222-4222-8222-222222222222" }],
    ["different kernel", { inputKernelId: 10 }],
    ["missing run", { priceRunId: null }],
    ["missing kernel", { inputKernelId: null }],
  ])("refuses %s association even when the input bytes and contribution are valid", async (_name, change) => {
    const saved = { ...await member(), ...change };
    const price = vi.fn(() => full(1));
    const result = await prepareAnalyticsV2RepriceHead(await head([saved]), price);
    expect(result).toMatchObject({ outcome: "refused", refusal: "price_input_association_unproven",
      payload: null, members: [] });
    expect(price).not.toHaveBeenCalled();
  });

  it("refuses missing inputs, an unrecorded set, and a missing departed-owner link", async () => {
    const saved = await member();
    expect(await prepareAnalyticsV2RepriceHead(await head([{ ...saved, inputs: null }])))
      .toMatchObject({ outcome: "refused", refusal: "price_inputs_unavailable" });
    expect(await prepareAnalyticsV2RepriceHead({ ...await head([saved]), recorded: false }))
      .toMatchObject({ outcome: "refused", refusal: "owner_set_unavailable" });
    expect(await prepareAnalyticsV2RepriceHead(await head([{ ...saved, participantLinked: false }])))
      .toMatchObject({ outcome: "refused", refusal: "member_link_unavailable" });
  });

  it("refuses corrupt compressed bytes, a wrong input digest and mismatched decoded event counts", async () => {
    const saved = await member();
    for (const inputs of [
      { ...saved.inputs!, bytes: new Uint8Array([255, 0, 1]) },
      { ...saved.inputs!, sha256: "0".repeat(64) },
      { ...saved.inputs!, events: 2 },
    ]) {
      expect(await prepareAnalyticsV2RepriceHead(await head([{ ...saved, inputs }])))
        .toMatchObject({ outcome: "refused", refusal: "price_inputs_corrupt", payload: null, members: [] });
    }
  });

  it("refuses a contribution digest mismatch or a tampered public-head digest", async () => {
    const saved = await member();
    expect(await prepareAnalyticsV2RepriceHead(await head([{ ...saved, valuesSha256: "0".repeat(64) }])))
      .toMatchObject({ outcome: "refused", refusal: "contribution_invalid" });
    expect(await prepareAnalyticsV2RepriceHead({ ...await head([saved]), payloadSha256: "0".repeat(64) }))
      .toMatchObject({ outcome: "refused", refusal: "contribution_invalid" });
  });

  it("refuses validly hashed inputs whose stored pricing no longer matches their contribution", async () => {
    const saved = await member();
    const different = await member(2, records(2));
    const result = await prepareAnalyticsV2RepriceHead(await head([{ ...saved, inputs: different.inputs }]));
    expect(result).toMatchObject({ outcome: "refused", refusal: "price_inputs_corrupt", payload: null });
  });

  it("refuses non-spend drift even with a valid payload digest", async () => {
    const saved = await member();
    const differentCohort = await head([saved, await member(2)]);
    const result = await prepareAnalyticsV2RepriceHead({ ...differentCohort, members: [saved] }, () => full(1));
    expect(result).toMatchObject({ outcome: "refused", refusal: "reprice_membership_or_evidence_drift",
      payload: null, members: [] });
  });

  it("keeps unsupported prices unknown rather than publishing zero known spend", async () => {
    const saved = await member(1, records(2, () => ({ modelId: "synthetic-unpriced-model" })));
    const values = await repriceAnalyticsV2Contribution(DAY, saved);
    expect(values.pricing).toEqual({ knownNanousd: "0", fullyPriced: 0, partiallyPriced: 0, unpriced: 2 });
    const result = await prepareAnalyticsV2RepriceHead(await head([saved]));
    expect(result.outcome).toBe("unchanged");
    expect(spend(result.payload!).knownCostUsd).toBeNull();
  });

  it("adds rounded per-event costs and conserves every kept and omitted cell subtotal", async () => {
    const rows = records(205, (index) => ({ modelId: `synthetic-model-${String(index).padStart(3, "0")}`,
      components: { inputUncachedTokens: 1, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: null } }));
    const saved = await member(1, rows);
    const price = vi.fn((input) => full(Math.round(input.components[0]! * 0.6)));
    const values = await repriceAnalyticsV2Contribution(DAY, saved, price);
    expect(price).toHaveBeenCalledTimes(205);
    expect(values.pricing).toEqual({ knownNanousd: "205", fullyPriced: 205, partiallyPriced: 0, unpriced: 0 });
    expect(values.pricing.knownNanousd).not.toBe(String(Math.round(205 * 0.6)));
    expect(values.cells).toHaveLength(200);
    expect(values.cells.every((cell) => cell.pricing.knownNanousd === "1" && cell.pricing.fullyPriced === 1)).toBe(true);
    expect(values.omitted).toMatchObject({ usageEvents: 5,
      pricing: { knownNanousd: "5", fullyPriced: 5, partiallyPriced: 0, unpriced: 0 } });
    expect(() => validateV11DailyProjectionValues(values)).not.toThrow();
    const { pricing: _pricing, ...rest } = values;
    const original = structuredClone(saved.values) as V11DailyProjectionValues;
    expect(rest.tokens).toEqual(original.tokens);
    expect(rest.counts).toEqual(original.counts);
    expect(rest.cells.map(({ pricing: _cellPricing, ...cell }) => cell))
      .toEqual(original.cells.map(({ pricing: _cellPricing, ...cell }) => cell));
  });

  it("reproduces real kernel per-event pricing rather than estimating from daily token totals", async () => {
    const rows = records(3, (index) => ({ totalInputContextTokens: index === 1 ? null : 1000,
      modelId: index === 2 ? "synthetic-unpriced-model" : "gpt-5.6-sol" }));
    const saved = await member(1, rows);
    expect(await repriceAnalyticsV2Contribution(DAY, saved)).toEqual(saved.values);
  });

  it("conserves mixed full, partial and unknown coverage independently of known cost", async () => {
    const saved = await member(1, records(3));
    const prices: AnalyticsV2PricedEvent[] = [full(3),
      { costNanousd: 2, status: ANALYTICS_V2_PRICE_STATUS.partiallyPriced, cardIds: [] },
      { costNanousd: 0, status: ANALYTICS_V2_PRICE_STATUS.unpriced, cardIds: [] }];
    let index = 0;
    const values = await repriceAnalyticsV2Contribution(DAY, saved, () => prices[index++]!);
    const expected = { knownNanousd: "5", fullyPriced: 1, partiallyPriced: 1, unpriced: 1 };
    expect(values.pricing).toEqual(expected);
    expect(values.cells[0]!.pricing).toEqual(expected);
    expect(() => validateV11DailyProjectionValues(values)).not.toThrow();
  });

  it("refuses duplicate saved members before double counting", async () => {
    const saved = await member();
    expect(await prepareAnalyticsV2RepriceHead(await head([saved, { ...saved, version: 4 }])))
      .toMatchObject({ outcome: "refused", refusal: "contribution_invalid", payload: null });
  });

  it("enforces the cumulative event bound before decoding oversized stored inputs", async () => {
    const saved = await member();
    const input = await head([{ ...saved, inputs: { ...saved.inputs!, events: ANALYTICS_V2_REPRICE_LIMITS.events + 1 } }]);
    await expect(prepareAnalyticsV2RepriceHead(input)).rejects.toMatchObject({ code: "ANALYTICS_V2_REPRICE_LIMIT" });
  });

  it("enforces the member hard bound before folding an oversized saved cohort", async () => {
    const saved = await member();
    const input = await head([saved]);
    const oversized = Array.from({ length: ANALYTICS_V2_REPRICE_LIMITS.members + 1 }, (_, index) =>
      ({ ...saved, ownerDigest: (index + 1).toString(16).padStart(64, "0") }));
    await expect(prepareAnalyticsV2RepriceHead({ ...input, members: oversized }))
      .rejects.toMatchObject({ code: "ANALYTICS_V2_REPRICE_LIMIT" });
  });

  it("enforces the compressed input byte hard bound before inflation", async () => {
    const saved = await member();
    const input = await head([saved]);
    const oversized = { ...saved, inputs: { ...saved.inputs!,
      bytes: new Uint8Array(ANALYTICS_V2_REPRICE_LIMITS.inputBytes + 1) } };
    await expect(prepareAnalyticsV2RepriceHead({ ...input, members: [oversized] }))
      .rejects.toMatchObject({ code: "ANALYTICS_V2_REPRICE_LIMIT" });
  });

  it("preserves a nonempty quota-only contribution without inventing usage inputs", async () => {
    const values = createV11DailyProjectionValues(DAY);
    values.counts.quota = 2;
    const saved = { ...await member(), values, valuesSha256: sha(values), inputs: null,
      priceRunId: null, inputKernelId: null };
    const price = vi.fn(() => full(1));
    const result = await prepareAnalyticsV2RepriceHead(await head([saved]), price);
    expect(result.outcome).toBe("unchanged");
    expect(result.members[0]!.values).toEqual(values);
    expect(price).not.toHaveBeenCalled();
  });

  it("rejects invalid calendar bounds, unbounded counts and unknown options", () => {
    const valid = { fromDay: DAY, throughDay: DAY, maxDays: 1, maxMembers: 1, maxInputBytes: 1024 };
    expect(validAnalyticsV2RepriceBounds(valid)).toEqual(valid);
    expect(Object.isFrozen(validAnalyticsV2RepriceBounds(valid))).toBe(true);
    for (const change of [
      { fromDay: "2026-02-30" }, { throughDay: "2026-09-19" }, { maxDays: 0 },
      { maxDays: 33 }, { maxMembers: 1001 }, { maxMembers: 1.5 }, { maxInputBytes: 0 },
      { maxInputBytes: ANALYTICS_V2_REPRICE_LIMITS.inputBytes + 1 }, { extra: true },
    ]) {
      expect(() => validAnalyticsV2RepriceBounds({ ...valid, ...change }))
        .toThrow("ANALYTICS_V2_REPRICE_INVALID");
    }
  });
});
