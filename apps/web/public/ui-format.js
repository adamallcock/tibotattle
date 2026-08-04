// Formatting and DOM helpers shared by the local dashboard and the public
// community surface. Translation language and regional formatting remain
// separate: choosing Spanish or Simplified Chinese never changes an instant,
// accounting value, or the browser/Mac regional number convention.
import { DEFAULT_LOCALE, translate } from "./localization.js";

function canonicalLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

function browserLocale() {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const requested = navigator.languages?.find((value) =>
    typeof value === "string" && value.trim() !== "",
  ) ?? navigator.language;
  return canonicalLocale(requested) ?? DEFAULT_LOCALE;
}

function systemTimeZone() {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.length > 0 ? value : "UTC";
  } catch {
    return "UTC";
  }
}

export const USER_TIME_ZONE = systemTimeZone();
// Compatibility exports for existing browser modules. The values retain the
// old reporting-time semantics while their formatting follows the live locale.
export const REPORTING_TIME_ZONE = USER_TIME_ZONE;
export let USER_LOCALE = browserLocale();

let formattingLocale = USER_LOCALE;
let messageLocale = DEFAULT_LOCALE;

export function setFormattingLocale(value) {
  formattingLocale = canonicalLocale(value) ?? browserLocale();
  USER_LOCALE = formattingLocale;
  return formattingLocale;
}

export function getFormattingLocale() {
  return formattingLocale;
}

export function setMessageLocale(value) {
  messageLocale = canonicalLocale(value) ?? DEFAULT_LOCALE;
  return messageLocale;
}

export function getMessageLocale() {
  return messageLocale;
}

const USER_TIME_ZONE_OPTION = Object.freeze({ timeZone: USER_TIME_ZONE });

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function formatNumber(value, options = undefined) {
  return new Intl.NumberFormat(formattingLocale, options).format(value);
}

export function formatDate(value, options = undefined) {
  const date = instant(value);
  if (date === null) throw new RangeError("A valid date is required");
  return new Intl.DateTimeFormat(formattingLocale, options).format(date);
}

export function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function compact(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : formatNumber(number, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
}

export function formatLocal(value, { dateOnly = false } = {}) {
  const date = instant(value);
  if (date === null) return translate("format.unknown", {}, messageLocale);
  return new Intl.DateTimeFormat(formattingLocale, dateOnly
    ? {
      ...USER_TIME_ZONE_OPTION,
      month: "short",
      day: "numeric",
      year: "numeric",
    }
    : {
      ...USER_TIME_ZONE_OPTION,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
}

// Existing browser imports use this name. Keep it as an alias so all
// timestamp surfaces inherit the selected regional formatter.
export function formatReportingTime(value, options = {}) {
  return formatLocal(value, options);
}

export function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) {
    return translate("format.unknownAge", {}, messageLocale);
  }
  const formatter = new Intl.RelativeTimeFormat(messageLocale, {
    numeric: "always",
    style: "long",
  });
  if (seconds < 90) return formatter.format(-1, "minute");
  if (seconds < 7200) return formatter.format(-Math.round(seconds / 60), "minute");
  if (seconds < 172800) return formatter.format(-Number((seconds / 3600).toFixed(1)), "hour");
  return formatter.format(-Number((seconds / 86400).toFixed(1)), "day");
}

export function localCalendarParts() {
  return new Intl.DateTimeFormat(formattingLocale, {
    ...USER_TIME_ZONE_OPTION,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function reportingCalendarParts() {
  return localCalendarParts();
}

/**
 * Element helpers bound to one document. Passing the document in keeps these
 * usable from a unit test with a minimal document stand-in, and keeps a single
 * definition of "make an element" for both entry points.
 */
export function createDomHelpers(documentRef) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("A document with createElement is required.");
  }
  return {
    clear(element) {
      element.replaceChildren();
    },
    node(tag, className, text) {
      const element = documentRef.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    },
  };
}
