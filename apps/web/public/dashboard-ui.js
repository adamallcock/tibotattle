// Small, presentation-only helpers shared by dashboard views. The companion
// owns the evidence and reporting contracts; this module only normalizes the
// values that a view is allowed to show and builds semantic DOM fragments.

export const REPORTING_PERIODS = Object.freeze(["24h", "7d", "30d", "all"]);
export const REPORTING_REQUEST_PERIOD = Object.freeze({
  "24h": "1",
  "7d": "7",
  "30d": "30",
  all: "all",
});
export const REPORTING_DURATION_MS = Object.freeze({
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
});

const canonicalInstant = (value, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 && new Date(parsed).toISOString() === value
    ? value
    : null;
};

/**
 * Return a canonical shared reporting window, or null while the global
 * accounting snapshot has not supplied a usable bound. No period default is
 * selected here because callers must render a waiting state until the bound
 * is known.
 */
export function normalizeReportingWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !REPORTING_PERIODS.includes(value.period)) return null;
  const startAt = canonicalInstant(value.startAt, true);
  const endAt = canonicalInstant(value.endAt);
  if (!Object.hasOwn(value, "startAt")
      || value.startAt !== null && startAt === null
      || endAt === null
      || value.period === "all" && startAt !== null
      || value.period !== "all" && startAt === null) return null;
  const endMs = Date.parse(endAt);
  if (value.period !== "all") {
    const expectedStart = Math.max(0, endMs - REPORTING_DURATION_MS[value.period]);
    if (Date.parse(startAt) !== expectedStart) return null;
  }
  return Object.freeze({ period: value.period, startAt, endAt });
}

export function reportingRequestPeriod(period) {
  return REPORTING_REQUEST_PERIOD[period] ?? null;
}

export function reportingPeriodLabel(period, translate) {
  if (typeof translate !== "function") return period;
  return translate(period === "24h" || period === "7d" || period === "30d"
    ? period
    : "all");
}

/**
 * Format the shared range using a caller's locale-aware date formatter. The
 * all-history wording deliberately says "available" because retention is not
 * completeness.
 */
export function reportingWindowRange(window, { translate, formatDate } = {}) {
  if (!window || typeof formatDate !== "function"
      || typeof translate !== "function") return null;
  const endAt = canonicalInstant(window.endAt);
  if (!endAt) return null;
  const end = formatDate(endAt);
  if (window.period === "all") return translate("allThrough", { end });
  const startAt = window.startAt ?? (
    REPORTING_DURATION_MS[window.period] === undefined
      ? null
      : new Date(Date.parse(endAt) - REPORTING_DURATION_MS[window.period]).toISOString()
  );
  return startAt
    ? translate("range", { start: formatDate(startAt), end })
    : end;
}

export function appendEvidenceRow(documentRef, list, {
  kind,
  label,
  value,
  state = null,
  className = "performance-evidence-row",
} = {}) {
  const row = documentRef.createElement("div");
  row.className = className;
  if (kind) row.dataset.evidence = kind;
  if (state) row.dataset.state = state;
  const labelNode = documentRef.createElement("dt");
  labelNode.className = "performance-evidence-label";
  labelNode.textContent = label ?? "";
  const valueNode = documentRef.createElement("dd");
  valueNode.className = "performance-evidence-value";
  valueNode.textContent = value ?? "";
  row.append(labelNode, valueNode);
  list.append(row);
  return row;
}

export function createEvidenceList(documentRef, className = "performance-evidence") {
  const list = documentRef.createElement("dl");
  list.className = className;
  return list;
}

/**
 * Observation recency is independent of a running job or stale cost cache.
 * Derive age from the timestamp every time so an open surface cannot remain
 * visually fresh merely because its serialized `ageSeconds` stopped changing.
 */
export function observationRecency(data, now = Date.now()) {
  if (data?.mode === "demo") {
    return Object.freeze({
      status: "demo",
      latestObservedAt: null,
      ageSeconds: null,
      staleAfterSeconds: null,
    });
  }
  const freshness = data?.freshness;
  const latestObservedAt = freshness?.latestObservedAt;
  const observedAt = typeof latestObservedAt === "string"
    ? Date.parse(latestObservedAt)
    : Number.NaN;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const staleAfterSeconds = freshness?.staleAfterSeconds;
  if (!Number.isFinite(observedAt)
      || !Number.isFinite(nowMs)
      || observedAt > nowMs
      || !Number.isFinite(staleAfterSeconds)
      || staleAfterSeconds < 0) {
    return Object.freeze({
      status: "unknown",
      latestObservedAt: null,
      ageSeconds: null,
      staleAfterSeconds: null,
    });
  }
  const ageSeconds = (nowMs - observedAt) / 1_000;
  return Object.freeze({
    status: ageSeconds <= staleAfterSeconds ? "current" : "stale",
    latestObservedAt: new Date(observedAt).toISOString(),
    ageSeconds,
    staleAfterSeconds,
  });
}

export function observationFreshness(data, now = Date.now()) {
  return observationRecency(data, now).status;
}

/**
 * Keep one bounded, one-shot clock for open dashboard freshness. It wakes at
 * least once a minute and exactly when a current observation crosses its stale
 * boundary. Updating the source replaces the prior timer.
 */
export function createObservationFreshnessClock({
  onTick,
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  intervalMs = 60_000,
} = {}) {
  if (typeof onTick !== "function"
      || typeof now !== "function"
      || typeof schedule !== "function"
      || typeof cancel !== "function"
      || !Number.isSafeInteger(intervalMs)
      || intervalMs <= 0) {
    throw new TypeError("freshness clock options are invalid");
  }
  let source = null;
  let timer = null;
  let stopped = false;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const arm = () => {
    clearTimer();
    if (stopped || source === null) return;
    const nowMs = now();
    const recency = observationRecency(source, nowMs);
    let delay = intervalMs;
    if (recency.status === "current") {
      const staleAt = Date.parse(recency.latestObservedAt)
        + recency.staleAfterSeconds * 1_000;
      delay = Math.min(intervalMs, Math.max(1, Math.floor(staleAt - nowMs) + 1));
    }
    timer = schedule(() => {
      timer = null;
      if (stopped || source === null) return;
      onTick(observationRecency(source, now()), source);
      arm();
    }, delay);
    timer?.unref?.();
  };

  return Object.freeze({
    update(next) {
      source = next;
      stopped = false;
      onTick(observationRecency(source, now()), source);
      arm();
    },
    stop() {
      stopped = true;
      source = null;
      clearTimer();
    },
  });
}
