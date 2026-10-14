const DAY_MS = 86_400_000;
// Retain the existing owner-selected acquisition horizon for both paths.
export const V1_ANALYSIS_WINDOW_DAYS = 100;

export interface ModelHistoryWindow {
  day: string;
  fromDay: string;
  observedAtCutoff: string;
  observedAtBefore: string;
  fixedNow: string;
}

/** A historical UTC day, with the SAME acquisition horizon as the current
 * model estimator. The exclusive upper bound is applied before fitting and
 * source election. The fixed clock never advances while a job is resumed.
 */
export function modelHistoryWindow(day: string): ModelHistoryWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new TypeError("model history day invalid");
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== day) {
    throw new TypeError("model history day invalid");
  }
  const fromMs = startMs - V1_ANALYSIS_WINDOW_DAYS * DAY_MS;
  if (fromMs < 0) throw new TypeError("model history range invalid");
  const observedAtCutoff = new Date(fromMs).toISOString();
  return { day, fromDay: observedAtCutoff.slice(0, 10), observedAtCutoff,
    observedAtBefore: new Date(startMs + DAY_MS).toISOString(),
    fixedNow: new Date(startMs + DAY_MS - 1).toISOString() };
}
