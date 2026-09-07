/** Closed presentation-only preferences. No live evidence belongs in this record. */
export const DESKTOP_TRAY_DEFAULTS = Object.freeze({
  schemaVersion: 1,
  preset: "weekly",
  iconMode: "meter",
  meterWindow: "weekly",
  barMetric: "remaining",
  resetFormat: "countdown",
  sections: Object.freeze(["allowances", "pace", "usage"]),
  historyRange: "7d",
  showChart: true,
  metrics: Object.freeze(["tokens", "cost", "changes"]),
  density: "comfortable",
  emphasizeLow: false,
});
export const DESKTOP_TRAY_UPGRADE_DEFAULTS = Object.freeze({ ...DESKTOP_TRAY_DEFAULTS, preset: "automatic" });
const ENUMS = Object.freeze({
  preset: ["automatic", "five-hour", "weekly", "both", "icon-only"],
  iconMode: ["app", "meter", "dual-meter"],
  meterWindow: ["five-hour", "weekly"],
  barMetric: ["remaining", "reset", "remaining-reset"],
  resetFormat: ["countdown", "clock"],
  historyRange: ["7d", "30d"],
  density: ["comfortable", "compact"],
});
export function validateDesktopTrayPreferences(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("tray preferences must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(DESKTOP_TRAY_DEFAULTS).length
      || keys.some((key) => !Object.hasOwn(DESKTOP_TRAY_DEFAULTS, key))) throw new TypeError("tray preferences have unexpected fields");
  if (value.schemaVersion !== 1) throw new TypeError("tray preference version is unsupported");
  for (const [key, values] of Object.entries(ENUMS)) {
    if (!values.includes(value[key])) throw new TypeError(`tray ${key} is invalid`);
  }
  for (const key of ["showChart", "emphasizeLow"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`tray ${key} is invalid`);
  }
  for (const [key, choices] of [["sections", ["allowances", "pace", "usage", "cache"]], ["metrics", ["tokens", "cost", "changes"]]]) {
    if (!Array.isArray(value[key]) || value[key].length > choices.length
        || new Set(value[key]).size !== value[key].length || value[key].some((item) => !choices.includes(item))) {
      throw new TypeError(`tray ${key} is invalid`);
    }
  }
  if (value.preset === "both" && value.barMetric !== "remaining") throw new TypeError("both windows support remaining only");
  if (value.sections.includes("usage") && !value.showChart && value.metrics.length === 0) throw new TypeError("usage needs a chart or totals");
  return Object.freeze({ ...value, sections: Object.freeze([...value.sections]), metrics: Object.freeze([...value.metrics]) });
}

export function migrateDesktopTrayPreferences(legacy) {
  const modes = { "five-hour": "five-hour", fiveHour: "five-hour", five_hour: "five-hour", "5h": "five-hour", weekly: "weekly", sevenDay: "weekly", seven_day: "weekly", "7d": "weekly", both: "both", off: "icon-only" };
  if (legacy === undefined) return DESKTOP_TRAY_UPGRADE_DEFAULTS;
  if (typeof legacy === "string" && Object.hasOwn(modes, legacy)) {
    return validateDesktopTrayPreferences({ ...DESKTOP_TRAY_DEFAULTS, preset: modes[legacy], ...(legacy === "off" ? { iconMode: "app" } : {}) });
  }
  return validateDesktopTrayPreferences(legacy);
}
