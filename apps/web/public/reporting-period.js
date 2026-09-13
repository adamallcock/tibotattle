import { REPORTING_PERIODS } from "./dashboard-ui.js";
export { REPORTING_PERIODS };
const STORAGE_KEY = "tibotattle.reporting-period";
const DAYS = Object.freeze({ "24h": 1, "7d": 7, "30d": 30, all: 36_500 });

export function reportingDays(period) { return DAYS[period] ?? 7; }

export function reportingSelection(data, period) {
  const selectedPeriod = REPORTING_PERIODS.includes(period) ? period : "7d";
  const periods = data?.accounting?.periods ?? [];
  const accountingPeriod = selectedPeriod === "all"
    ? periods.find(row => row.periodId === "history") ?? periods.find(row => row.periodId === "all")
    : periods.find(row => row.periodId === selectedPeriod);
  const knownWindow = accountingPeriod?.reportingWindow;
  const endMs = Date.parse(knownWindow?.endAt ?? data?.generatedAt ?? "");
  if (!Number.isFinite(endMs)) return { period: selectedPeriod, window: null, accountingPeriod: null };
  const endAt = new Date(endMs).toISOString();
  const startAt = selectedPeriod === "all" ? null
    : new Date(Math.max(0, endMs - reportingDays(selectedPeriod) * 86_400_000)).toISOString();
  return {
    period: selectedPeriod,
    window: Object.freeze({ period: selectedPeriod, startAt, endAt }),
    // Never attach unanchored accounting totals to a labelled reporting window.
    accountingPeriod: knownWindow?.endAt === endAt && knownWindow?.startAt === startAt
      ? accountingPeriod.periodId : null,
  };
}

function preferenceStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function createReportingPeriod({ storage = preferenceStorage(), onChange = () => {} } = {}) {
  let period = "7d";
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (REPORTING_PERIODS.includes(saved)) period = saved;
  } catch { /* Session state remains usable when storage is disabled. */ }
  return {
    get period() { return period; },
    select(next) {
      if (!REPORTING_PERIODS.includes(next) || next === period) return false;
      period = next;
      try { storage?.setItem(STORAGE_KEY, period); } catch { /* Best effort preference. */ }
      onChange(period);
      return true;
    },
  };
}

export function mountReportingPeriodDismissal(documentRef = document) {
  const details = documentRef.querySelector('.reporting-period-details');
  if (!details) return () => {};
  const outside = (event) => {
    if (details.open && !details.contains(event.target)) details.open = false;
  };
  const escape = (event) => {
    if (event.key !== 'Escape' || !details.open) return;
    details.open = false;
    event.preventDefault();
    if (details.contains(documentRef.activeElement)) details.querySelector('summary')?.focus();
  };
  documentRef.addEventListener('pointerdown', outside);
  documentRef.addEventListener('keydown', escape);
  return () => {
    documentRef.removeEventListener('pointerdown', outside);
    documentRef.removeEventListener('keydown', escape);
  };
}
