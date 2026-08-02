// Formatting and DOM helpers shared by both browser surfaces: the in-app
// dashboard entry (app.js, served by the loopback companion) and the public
// community entry (community.js, served by the release site). Neither surface
// keeps a private copy, so a wording or rounding change lands in one place.

export const USER_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";

const USER_TIME_ZONE_OPTION = USER_TIME_ZONE === "local time"
  ? {}
  : { timeZone: USER_TIME_ZONE };

export function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function compact(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(number);
}

export function formatLocal(value, { dateOnly = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-US", dateOnly
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
    }).format(new Date(value));
}

export function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) return "Unknown age";
  if (seconds < 90) return "Less than 2 minutes ago";
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
}

export function localCalendarParts() {
  return new Intl.DateTimeFormat("en-US", {
    ...USER_TIME_ZONE_OPTION,
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
