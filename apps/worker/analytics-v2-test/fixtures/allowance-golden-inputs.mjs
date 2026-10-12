// Synthetic, content-free inputs for the retained allowance-preview goldens.
//
// allowance-preview-v04.json and allowance-breakdowns-v14-expected.json were
// produced from exactly these inputs by the Pro 10x (v0.4) builder and the
// v1.4 projection at production commit 22d9d90f, before the Pro 20x B'
// projection replaced them. No production payload, participant or private
// diagnostic: owner ids are synthetic, and capacities come from a fixed linear
// congruential sequence (non-round nanousd, every personal plan plus one
// unsupported plan, Pro Max included). Tests rebuild the current preview from
// the same inputs to compare the new projection with the retained bytes.

export const GOLDEN_ALLOWANCE_NOW_MS = Date.parse("2026-10-09T12:00:00.000Z");
const DAY_MS = 86_400_000;
const PLAN_CENTRAL_USD = Object.freeze([["pro", 1_400], ["prolite", 350], ["promax", 1_750], ["plus", 70], ["team", 500]]);
const TRACKED_MODELS = Object.freeze(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-terra"]);
const COMPOSITION_PLANS = Object.freeze(["pro", "pro", "prolite", "promax", "plus", "plus", "team"]);

/**
 * @returns {{
 *   nowMs: number,
 *   fits: { participantId: string, planType: string, capacityNanousd: number, lastObservedAt: string }[],
 *   participantIds: string[],
 *   compositions: { participantId: string, composition: Record<string, unknown> }[],
 *   modelDayDates: string[],
 *   metadata: { id: string, label: string, family: string, order: number }[],
 * }}
 */
export function goldenAllowanceInputs() {
  const now = GOLDEN_ALLOWANCE_NOW_MS;
  let seed = 0x5eed1234;
  const rand = () => { seed = (seed * 1_103_515_245 + 12_345) >>> 0; return seed / 2 ** 32; };
  const fits = [];
  let owner = 0;
  for (const [planType, centralUsd] of PLAN_CENTRAL_USD) {
    const owners = planType === "team" ? 2 : 6;
    for (let o = 0; o < owners; o++) {
      const participantId = `synthetic-golden-owner-${String(owner++).padStart(2, "0")}`;
      const resets = 3 + Math.floor(rand() * 9);
      for (let r = 0; r < resets; r++) {
        const ageDays = rand() * 99;
        const capacityUsd = centralUsd * (0.55 + rand() * 0.9);
        fits.push({ participantId, planType,
          capacityNanousd: Math.round(capacityUsd * 1e9) + Math.floor(rand() * 997),
          lastObservedAt: new Date(now - ageDays * DAY_MS).toISOString() });
      }
    }
  }
  fits.sort((a, b) => a.lastObservedAt < b.lastObservedAt ? -1 : a.lastObservedAt > b.lastObservedAt ? 1
    : a.participantId < b.participantId ? -1 : 1);
  const compositions = COMPOSITION_PLANS.map((planType, index) => {
    const capacityUsdByModel = {};
    for (const model of TRACKED_MODELS) capacityUsdByModel[model] = Math.round((50 + rand() * 900) * 1e4) / 1e4;
    return { participantId: `synthetic-golden-model-${index}`, composition: { status: "ready", planType,
      latestQuotaObservedAt: new Date(now - (1 + index * 3) * DAY_MS).toISOString(),
      fit: { status: "fitted", capacityUsdByModel } } };
  });
  const modelDayDates = [];
  for (let back = 30; back >= 0; back -= 3) modelDayDates.push(new Date(now - back * DAY_MS).toISOString().slice(0, 10));
  return {
    nowMs: now,
    fits,
    participantIds: [...new Set(fits.map((fit) => fit.participantId)), "synthetic-golden-owner-nofit"],
    compositions,
    modelDayDates,
    metadata: [{ id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 }],
  };
}

/** Every closed preview day except a deterministic one-in-five gap. */
export function goldenPublishedDays(preview) {
  return preview.days.map((day) => day.day).filter((_day, index) => index % 5 !== 2);
}
