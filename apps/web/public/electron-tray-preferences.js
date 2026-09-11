/** Presentation admission for the host-owned, closed tray preference contract. */
export const TRAY_DEFAULTS = Object.freeze({
  schemaVersion: 1, preset: "weekly", iconMode: "meter", meterWindow: "weekly",
  barMetric: "remaining", resetFormat: "countdown", sections: Object.freeze(["allowances", "pace", "usage"]),
  historyRange: "7d", showChart: true, metrics: Object.freeze(["tokens", "cost", "changes"]),
  density: "comfortable", emphasizeLow: false,
});
export const TRAY_OPTIONS = Object.freeze({
  preset: ["automatic", "five-hour", "weekly", "both", "icon-only"],
  iconMode: ["app", "meter", "dual-meter"], meterWindow: ["five-hour", "weekly"],
  barMetric: ["remaining", "reset", "remaining-reset"], resetFormat: ["countdown", "clock"],
  sections: ["allowances", "pace", "usage", "cache"], historyRange: ["7d", "30d"],
  metrics: ["tokens", "cost", "changes"], density: ["comfortable", "compact"],
});
export function validTrayPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== Object.keys(TRAY_DEFAULTS).length
      || !Object.keys(TRAY_DEFAULTS).every((key) => Object.hasOwn(value, key))
      || value.schemaVersion !== 1) return false;
  for (const [key, options] of Object.entries(TRAY_OPTIONS)) {
    if (key === "sections" || key === "metrics") {
      if (!Array.isArray(value[key]) || value[key].length > options.length
          || new Set(value[key]).size !== value[key].length
          || !value[key].every((item) => options.includes(item))) return false;
    } else if (!options.includes(value[key])) return false;
  }
  return typeof value.showChart === "boolean" && typeof value.emphasizeLow === "boolean"
    && (value.preset !== "both" || value.barMetric === "remaining")
    && (!value.sections.includes("usage") || value.showChart || value.metrics.length > 0);
}
export function normalizeTrayPreferences(value) {
  const source = validTrayPreferences(value) ? value : TRAY_DEFAULTS;
  return { ...source, sections: [...source.sections], metrics: [...source.metrics] };
}
