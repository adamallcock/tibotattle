// Formatting and DOM helpers shared by both browser surfaces: the in-app
// dashboard entry (app.js, served by the loopback companion) and the public
// community entry (community.js, served by the release site). Neither surface
// keeps a private copy, so a wording or rounding change lands in one place.
//
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  formatDate as formatLocaleDate,
  formatNumber as formatLocaleNumber,
  negotiateLocale,
} from "./i18n.generated.js";

const requestedLocales = typeof navigator !== "undefined"
  ? navigator.languages?.length > 0
    ? navigator.languages
    : [navigator.language]
  : [DEFAULT_LOCALE];

export const USER_LOCALE = negotiateLocale(
  requestedLocales,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
);

export function formatNumber(value, options) {
  return formatLocaleNumber(value, USER_LOCALE, options);
}

export function formatDate(value, options) {
  return formatLocaleDate(value, USER_LOCALE, options);
}

// Instants remain UTC in every local/hosted contract. This is the one display
// policy for a person reading them: use the Mac/browser's configured zone, and
// fall back to UTC only if the runtime cannot report a usable system zone.
function systemTimeZone() {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.length > 0 ? value : "UTC";
  } catch {
    return "UTC";
  }
}

export const REPORTING_TIME_ZONE = systemTimeZone();

const REPORTING_TIME_ZONE_OPTION = Object.freeze({
  timeZone: REPORTING_TIME_ZONE,
});

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
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

export function formatReportingTime(value, { dateOnly = false } = {}) {
  const date = instant(value);
  if (date === null) return "Unknown";
  return formatDate(date, dateOnly
    ? {
      ...REPORTING_TIME_ZONE_OPTION,
      month: "short",
      day: "numeric",
      year: "numeric",
    }
    : {
      ...REPORTING_TIME_ZONE_OPTION,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
}

// Existing dashboard imports use this name. It is deliberately an alias, not
// a second browser-local formatter, so every visible timestamp follows the
// same reporting-zone policy.
export function formatLocal(value, options = {}) {
  return formatReportingTime(value, options);
}

export function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) return "Unknown age";
  if (seconds < 90) return "Less than 2 minutes ago";
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
}

export function reportingCalendarParts() {
  return new Intl.DateTimeFormat(USER_LOCALE, {
    ...REPORTING_TIME_ZONE_OPTION,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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
