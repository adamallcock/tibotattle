import { validateDesktopTrayPreferences } from "./desktop-tray-preferences.js";
/**
 * Pure, content-free status projection for the Electron tray.
 *
 * The native menu-bar implementation deliberately separates lifecycle phase
 * from evidence freshness.  This smaller cross-platform contract exposes the
 * five user-visible states the tray may claim and carries only the companion's
 * closed, direct allowance windows when it has supplied fresh, validated
 * evidence. During an active refresh, a prior fresh observation may be
 * retained in the reducer, or the companion may publish a separately
 * validated overview allowance while notification evidence remains absent.
 * Retained v2 evidence is revalidated against its observation age at
 * projection time; the overview path is accepted only through the closed
 * main-process status contract. This module does not read the filesystem,
 * inspect a renderer, preserve raw errors, or infer a value from stale data.
 */

import { projectDesktopShellDisplayEvidence, projectDesktopShellNotificationEvidence } from "../../src/desktop-shell-status.js";

export const DESKTOP_TRAY_STATUS_STATES = Object.freeze([
  "starting",
  "analyzing",
  "fresh",
  "stale",
  "unavailable",
]);

export const DESKTOP_TRAY_ALLOWANCE_WINDOWS = Object.freeze([
  "five_hour",
  "seven_day",
]);

export const DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES = 256;

export const DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS = Object.freeze({
  starting: "electron.tray.statusStarting",
  analyzing: "electron.tray.statusAnalyzing",
  fresh: "electron.tray.statusFresh",
  stale: "electron.tray.statusStale",
  unavailable: "electron.tray.statusUnavailable",
});

export const DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS = Object.freeze({
  five_hour: "electron.tray.allowanceFiveHour",
  seven_day: "electron.tray.allowanceSevenDay",
});

const STATUS_SET = new Set(DESKTOP_TRAY_STATUS_STATES);
const ALLOWANCE_WINDOW_SET = new Set(DESKTOP_TRAY_ALLOWANCE_WINDOWS);
const INITIAL_STATUS = Object.freeze({
  status: "starting",
  allowance: null,
  notificationEvidence: null,
});

const DEFAULT_STATUS_LABELS = Object.freeze({
  starting: "Starting",
  analyzing: "Analyzing",
  fresh: "Fresh",
  stale: "Stale",
  unavailable: "Status unavailable",
});

const DEFAULT_ALLOWANCE_LABELS = Object.freeze({
  five_hour: "Five-hour allowance",
  seven_day: "Seven-day allowance",
});

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertPlainRecord(value, label) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertStatus(value) {
  if (typeof value !== "string" || !STATUS_SET.has(value)) {
    throw new TypeError("tray status is invalid");
  }
  return value;
}

function assertBoundedText(value, label) {
  if (typeof value !== "string"
      || value.length === 0
      || new TextEncoder().encode(value).byteLength
        > DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES) {
    throw new TypeError(`${label} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new TypeError(`${label} is invalid`);
    }
  }
  return value;
}

function cloneAllowance(allowance, { allowNull = true } = {}) {
  if (allowance === null) {
    if (allowNull) return null;
    throw new TypeError("allowance is required");
  }
  assertPlainRecord(allowance, "allowance");
  if (!hasExactKeys(allowance, ["source", "window", "remainingPercent"])) {
    throw new TypeError("allowance has unexpected fields");
  }
  if (allowance.source !== "direct") {
    throw new TypeError("allowance source is invalid");
  }
  if (typeof allowance.window !== "string"
      || !ALLOWANCE_WINDOW_SET.has(allowance.window)) {
    throw new TypeError("allowance window is invalid");
  }
  if (typeof allowance.remainingPercent !== "number"
      || !Number.isFinite(allowance.remainingPercent)
      || allowance.remainingPercent < 0
      || allowance.remainingPercent > 100) {
    throw new TypeError("allowance remainingPercent is invalid");
  }
  return Object.freeze({
    source: "direct",
    window: allowance.window,
    remainingPercent: allowance.remainingPercent,
  });
}

function cloneNotificationEvidence(value, { allowNull = true } = {}) {
  if (value === null) {
    if (allowNull) return null;
    throw new TypeError("notification evidence is required");
  }
  const observedAt = Date.parse(value?.observedAt);
  const projected = projectDesktopShellNotificationEvidence(value, {
    now: observedAt,
  });
  if (projected === null) {
    throw new TypeError("notification evidence lanes are invalid");
  }
  return projected;
}

function statusSnapshot(status, allowance = null, notificationEvidence = null, displayEvidence = null) {
  assertStatus(status);
  if (!["fresh", "analyzing"].includes(status)
      && (allowance !== null || notificationEvidence !== null)) {
    throw new TypeError("only fresh or analyzing status may carry evidence");
  }
  const display = displayEvidence === null ? null : projectDesktopShellDisplayEvidence(displayEvidence, { now: null });
  if (displayEvidence !== null && (display === null || !["fresh", "analyzing"].includes(status))) throw new TypeError("tray display evidence is invalid");
  return Object.freeze({
    status,
    ...(display === null ? {} : { displayEvidence: display }),
    allowance: cloneAllowance(allowance),
    notificationEvidence: cloneNotificationEvidence(notificationEvidence),
  });
}

/**
 * Validate and freeze the reducer state. Stale, unavailable, and starting
 * states intentionally have no allowance field beyond `null`; analyzing may
 * carry retained v2 evidence or a current closed overview allowance.
 */
export function validateDesktopTrayStatus(value) {
  assertPlainRecord(value, "tray status");
  if (!hasExactKeys(value, ["status", "allowance", "notificationEvidence", ...(Object.hasOwn(value, "displayEvidence") ? ["displayEvidence"] : [])])) {
    throw new TypeError("tray status has unexpected fields");
  }
  return statusSnapshot(value.status, value.allowance, value.notificationEvidence, value.displayEvidence);
}

/**
 * Validate a fixed direct allowance summary independently of lifecycle state.
 * This is useful at the companion adapter boundary before emitting a `fresh`
 * event; the reducer still validates it again.
 */
export function validateDesktopTrayAllowance(value) {
  return cloneAllowance(value, { allowNull: false });
}

/**
 * Reduce one bounded lifecycle/evidence event into the next tray state.
 *
 * Events use the same closed vocabulary as the output status. A `fresh`
 * event carries the already-validated notification evidence alongside its
 * optional primary summary. A payload-free `analyzing` event may retain the
 * prior fresh evidence in memory. An explicit analyzing snapshot replaces
 * that retained state with the companion's current closed allowance; it may
 * have null notification evidence because notification authority remains
 * separate from display authority. All other events reject evidence and error
 * payloads and clear every previously displayed numeric claim.
 */
export function reduceDesktopTrayStatus(current, event) {
  const previous = validateDesktopTrayStatus(current);
  assertPlainRecord(event, "tray event");
  if (typeof event.type !== "string") {
    throw new TypeError("tray event type is invalid");
  }
  switch (event.type) {
    case "starting":
    case "stale":
    case "unavailable":
      if (!hasExactKeys(event, ["type"])) {
        throw new TypeError("tray event has unexpected fields");
      }
      return statusSnapshot(event.type);
    case "analyzing": {
      const isPayloadFreeTransition = hasExactKeys(event, ["type"]);
      const isExplicitSnapshot = hasExactKeys(event, [
        "type",
        "allowance",
        "notificationEvidence",
        ...(Object.hasOwn(event, "displayEvidence") ? ["displayEvidence"] : []),
      ]);
      if (!isPayloadFreeTransition && !isExplicitSnapshot) {
        throw new TypeError("tray event has unexpected fields");
      }
      if (isExplicitSnapshot) {
        return statusSnapshot(
          "analyzing",
          event.allowance,
          event.notificationEvidence,
          event.displayEvidence,
        );
      }
      // The status endpoint intentionally reports only the lifecycle phase.
      // Keep an already-validated live observation across that transition so
      // the compact status item does not flash to an unknown value while a
      // newer pass is being calculated. The projector still expires it using
      // the current clock.
      const retainingEvidence = ["fresh", "analyzing"].includes(previous.status)
        && (previous.notificationEvidence !== null || previous.displayEvidence != null);
      return statusSnapshot(
        "analyzing",
        retainingEvidence ? previous.allowance : null,
        retainingEvidence ? previous.notificationEvidence : null,
        retainingEvidence ? previous.displayEvidence : null,
      );
    }
    case "fresh":
      if (!hasExactKeys(event, ["type", "allowance", "notificationEvidence", ...(Object.hasOwn(event, "displayEvidence") ? ["displayEvidence"] : [])])) {
        throw new TypeError("fresh tray event has unexpected fields");
      }
      return statusSnapshot("fresh", event.allowance, event.notificationEvidence, event.displayEvidence);
    default:
      // Keep `previous` referenced so a debugger can inspect the validated
      // boundary without changing the fail-closed behavior.
      void previous;
      throw new TypeError("tray event type is invalid");
  }
}

function defaultLocalize(key, values = {}) {
  const status = Object.entries(DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS)
    .find(([, candidate]) => candidate === key)?.[0];
  if (status !== undefined) {
    return DEFAULT_STATUS_LABELS[status];
  }
  const window = Object.entries(DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS)
    .find(([, candidate]) => candidate === key)?.[0];
  if (window !== undefined) {
    const percent = values.remainingPercent;
    return `${DEFAULT_ALLOWANCE_LABELS[window]}: ${percent}% remaining`;
  }
  if (key === "electron.tray.evidenceCurrent") {
    return `Observed ${values.age} · verified current evidence`;
  }
  if (key === "electron.tray.windowFiveHour") {
    return `Five-hour allowance: ${values.remainingPercent}% remaining · resets in ${values.reset}`;
  }
  if (key === "electron.tray.windowSevenDay") {
    return `Seven-day allowance: ${values.elapsedPercent}% elapsed · ${values.usedPercent}% used · resets in ${values.reset}`;
  }
  if (key === "electron.tray.selectedUnavailable") return `${values.window} remaining: unavailable`;
  if (key === "electron.tray.resetCountdown") return `${values.window} resets in ${values.reset}`;
  if (key === "electron.tray.resetClock") return `${values.window} resets at ${values.reset}`;
  if (key === "electron.tray.low") return `${values.window}: low allowance`;
  if (key === "electron.tray.dualMeterHint") return "Top meter: 5-hour remaining; bottom meter: 7-day remaining";
  throw new TypeError("tray localization key is invalid");
}

function localizeText(localize, key, values, label) {
  let text;
  try {
    text = localize(key, Object.freeze({ ...values }));
  } catch {
    throw new TypeError(`${label} is unavailable`);
  }
  return assertBoundedText(text, label);
}

/**
 * Project semantic state into fixed tray copy.  `localize` is the only copy
 * seam: it receives a reviewed key and a bounded numeric value, never a raw
 * companion payload.  The default keeps the pure module usable in tests and
 * before Electron's desktop catalog is wired in.
 */
export function projectDesktopTrayStatus(value, options = {}) {
  assertPlainRecord(options, "projector options");
  if (Reflect.ownKeys(options).some((key) => !["localize", "now", "preferences", "lowState", "locale"].includes(key))) {
    throw new TypeError("projector options have unexpected fields");
  }
  const { localize = defaultLocalize, now = Date.now(), preferences, lowState = {}, locale } = options;
  if (locale !== undefined && locale !== "system") {
    try { new Intl.DateTimeFormat(locale); } catch { throw new TypeError("tray locale is invalid"); }
  }
  const configured = preferences === undefined ? null : validateDesktopTrayPreferences(preferences);
  const status = validateDesktopTrayStatus(value);
  if (typeof localize !== "function") {
    throw new TypeError("localize must be a function");
  }

  // Structural validation proves the evidence shape. Revalidate the retained
  // observation's age at render time while an analysis is running: this is
  // what makes the preserved percentage safe without changing the existing
  // fresh-state contract, which the companion status endpoint already
  // rechecks on every poll.
  const evidence = status.notificationEvidence === null
    ? null
    : (configured !== null || status.status === "analyzing")
      ? projectDesktopShellNotificationEvidence(
        status.notificationEvidence,
        { now },
      )
      : status.notificationEvidence;
  const display = status.displayEvidence == null ? null : projectDesktopShellDisplayEvidence(status.displayEvidence, { now });
  const evidenceExpired = (configured !== null || status.status === "analyzing")
    && status.notificationEvidence !== null
    && (evidence === null || (configured !== null && evidence.windows.every((window) => Date.parse(window.resetAt) <= now)));
  const displayStatus = status.status === "fresh" && ((evidenceExpired && display === null) || (status.displayEvidence != null && display === null && evidence === null))
    ? "stale"
    : status.status;

  const statusLabel = localizeText(
    localize,
    DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS[displayStatus],
    {},
    "status label",
  );
  let allowance = null;
  // A closed analyzing snapshot may carry a current overview allowance while
  // its stricter notification evidence is deliberately null. That allowance
  // remains displayable because the companion has already proved its own
  // freshness; only a retained v2 observation can expire locally here.
  const canDisplayAllowance = status.allowance !== null && !evidenceExpired;
  if (canDisplayAllowance) {
    const roundedRemainingPercent = Math.round(status.allowance.remainingPercent);
    allowance = Object.freeze({
      window: status.allowance.window,
      remainingPercent: roundedRemainingPercent,
      label: localizeText(
        localize,
        DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS[status.allowance.window],
        { remainingPercent: roundedRemainingPercent },
        "allowance label",
      ),
    });
  }
  const notificationWindows = evidence === null ? [] : evidence.windows.filter((window) => configured === null || (Date.parse(window.resetAt) > now && evidence.windows.filter((candidate) => candidate.durationMinutes === window.durationMinutes).length === 1));
  const currentWindows = [...notificationWindows, ...(display?.windows ?? []).filter((item) => !notificationWindows.some((window) => window.durationMinutes === item.durationMinutes)).map((item) => ({ ...item, usedPercent: 100 - item.remainingPercent }))];
  const windows = currentWindows.map((window) => {
    const remainingPercent = Math.round(100 - window.usedPercent);
    const resetMs = Math.max(0, Date.parse(window.resetAt) - now);
    const resetMinutes = Math.ceil(resetMs / 60_000);
    const resetText = resetMinutes >= 1_440
      ? `${Math.floor(resetMinutes / 1_440)}d ${Math.floor((resetMinutes % 1_440) / 60)}h`
      : resetMinutes >= 60
        ? `${Math.floor(resetMinutes / 60)}h ${resetMinutes % 60}m`
        : `${resetMinutes}m`;
    const isWeekly = window.durationMinutes === 10_080;
    const elapsedPercent = Math.max(0, Math.min(100, Math.round(
      ((now - (Date.parse(window.resetAt) - window.durationMinutes * 60_000))
        / (window.durationMinutes * 60_000)) * 100,
    )));
    const label = localizeText(
      localize,
      isWeekly ? "electron.tray.windowSevenDay" : "electron.tray.windowFiveHour",
      isWeekly
        ? { elapsedPercent, usedPercent: Math.round(window.usedPercent), reset: resetText }
        : { remainingPercent, reset: resetText },
      "quota window label",
    );
    return Object.freeze({ ...window, remainingPercent, label });
  });
  const observation = evidence?.observedAt ?? display?.windows.map((item) => item.observedAt).sort()[0] ?? null;
  const observedMinutes = observation === null ? null : Math.max(0, Math.floor((now - Date.parse(observation)) / 60_000));
  // The compact status-item title may make only the already-validated direct
  // allowance claim.  Do not promote a secondary lane (or a renderer-shaped
  // value) into the title when the primary summary is unavailable.
  let compactTitle = allowance === null
    ? (displayStatus === "analyzing" ? "…" : "–")
    : `${allowance.remainingPercent}%`;
  let configuredFields = {};
  if (configured !== null) {
    const lane = (kind) => {
      const matching = windows.find((window) => window.durationMinutes === (kind === "five_hour" ? 300 : 10_080));
      if (matching !== undefined) return { window: kind, remainingPercent: matching.remainingPercent, actualRemainingPercent: 100 - matching.usedPercent, resetAt: matching.resetAt };
      // A closed overview summary is a display authority only for its own lane.
      // Never use it to replace an expired/conflicting detailed observation.
      return status.notificationEvidence === null && status.displayEvidence == null && allowance?.window === kind
        ? { ...allowance, actualRemainingPercent: status.allowance.remainingPercent, resetAt: null } : null;
    };
    const selectedKinds = configured.preset === "both" ? ["five_hour", "seven_day"]
      : configured.preset === "automatic" ? [allowance?.window ?? (currentWindows.some((window) => window.durationMinutes === 10_080) ? "seven_day" : currentWindows.some((window) => window.durationMinutes === 300) ? "five_hour" : "seven_day")]
        : [configured.preset === "five-hour" ? "five_hour" : configured.preset === "weekly" ? "seven_day"
          : configured.meterWindow === "five-hour" ? "five_hour" : "seven_day"];
    const short = (kind) => kind === "five_hour" ? "5h" : "7d";
    const scope = evidence?.continuityKey ?? null;
    const selected = selectedKinds.map((kind) => {
      const item = lane(kind);
      const displayLane = display?.windows.find((window) => window.durationMinutes === (kind === "five_hour" ? 300 : 10_080));
      const identity = item === null ? null : scope !== null && notificationWindows.some((window) => window.durationMinutes === (kind === "five_hour" ? 300 : 10_080)) ? `${scope}:${item.resetAt}`
        : displayLane ? `display:${display.scopeKey ?? displayLane.observedAt}:${displayLane.resetAt}` : null;
      const previous = lowState[kind];
      const low = configured.emphasizeLow && identity !== null && item !== null
        && (item.actualRemainingPercent <= 10 || (previous?.identity === identity && previous.low && item.actualRemainingPercent < 12));
      lowState[kind] = { identity, low };
      return Object.freeze({ window: kind, remainingPercent: item?.remainingPercent ?? null, resetAt: item?.resetAt ?? null, low });
    });
    for (const kind of ["five_hour", "seven_day"]) {
      if (!selectedKinds.includes(kind)) delete lowState[kind];
    }
    const resetText = (item) => {
      if (item.resetAt === null || Date.parse(item.resetAt) <= now) return "—";
      if (configured.resetFormat === "clock") {
        const date = new Date(item.resetAt);
        const sameDay = date.toDateString() === new Date(now).toDateString();
        return new Intl.DateTimeFormat(locale === "system" ? undefined : locale, {
          hour: "numeric", minute: "2-digit", ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
        }).format(date);
      }
      const minutes = Math.ceil((Date.parse(item.resetAt) - now) / 60_000);
      return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
        : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    };
    compactTitle = configured.preset === "icon-only" ? "" : selected.map((item) => {
      const remaining = `${short(item.window)} ${item.remainingPercent === null ? "—" : `${item.remainingPercent}%`}`;
      const reset = localizeText(localize, configured.resetFormat === "clock" ? "electron.tray.resetClock" : "electron.tray.resetCountdown", { window: short(item.window), reset: resetText(item) }, "reset label");
      return configured.barMetric === "remaining" ? remaining : configured.barMetric === "reset" ? reset : `${remaining} · ${reset}`;
    }).join(" · ");
    const meterKind = ["five-hour", "weekly"].includes(configured.preset) ? selectedKinds[0]
      : configured.preset === "automatic" ? selectedKinds[0]
        : configured.meterWindow === "five-hour" ? "five_hour" : "seven_day";
    const meterKinds = configured.iconMode === "dual-meter" ? ["five_hour", "seven_day"] : [meterKind];
    const meters = meterKinds.map((kind) => ({ window: kind, remainingPercent: lane(kind)?.remainingPercent ?? null,
      low: selected.find((item) => item.window === kind)?.low === true }));
    const selectionLabel = selected.map((item) => item.remainingPercent === null
      ? localizeText(localize, "electron.tray.selectedUnavailable", { window: short(item.window) }, "selection label")
      : localizeText(localize, DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS[item.window], { remainingPercent: item.remainingPercent }, "selection label")
    ).concat(selected.filter((item) => item.low).map((item) => localizeText(localize, "electron.tray.low", { window: short(item.window) }, "low label")))
      .concat(configured.iconMode === "dual-meter" ? [localizeText(localize, "electron.tray.dualMeterHint", {}, "meter label")] : []).join(" · ");
    configuredFields = { selectionLabel, selected: Object.freeze(selected), meters: Object.freeze(meters.map(Object.freeze)), iconMode: configured.iconMode };
  }
  return Object.freeze({
    ...configuredFields,
    status: displayStatus,
    label: statusLabel,
    allowance,
    compactTitle,
    evidenceLabel: observation === null ? statusLabel : localizeText(
      localize,
      "electron.tray.evidenceCurrent",
      { age: observedMinutes === 0 ? "just now" : `${observedMinutes} minute${observedMinutes === 1 ? "" : "s"} ago` },
      "evidence label",
    ),
    windows: Object.freeze(windows),
  });
}

/**
 * Stateful convenience wrapper around the pure reducer.  The returned object
 * has no method that accepts raw labels, paths, or arbitrary errors.
 */
export function createDesktopTrayStatusReducer() {
  let current = INITIAL_STATUS;
  return Object.freeze({
    dispatch(event) {
      current = reduceDesktopTrayStatus(current, event);
      return current;
    },
    project(options = {}) {
      return projectDesktopTrayStatus(current, options);
    },
    reset() {
      current = INITIAL_STATUS;
      return current;
    },
    get state() {
      return current;
    },
  });
}

export { INITIAL_STATUS as DESKTOP_TRAY_INITIAL_STATUS };
