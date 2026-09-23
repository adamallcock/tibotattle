import { compareModelPresentation, modelUsagePresentation, modelThemeIcon } from "./model-visuals.js";
import {
  formatNumber,
  formatLocal,
  formatModelName,
  formatCodexThreadParts,
  formatApiMoney,
  formatSharePercent,
} from "./ui-format.js";
import {
  REPORTING_PERIODS,
  REPORTING_DURATION_MS,
  normalizeReportingWindow,
  appendEvidenceRow,
  createEvidenceList,
} from "./dashboard-ui.js";
export { normalizeReportingWindow } from "./dashboard-ui.js";
const SCHEMA = "local-work-usage-v1";
const PERIOD_IDS = REPORTING_PERIODS;
// Give the selected report a chance to paint before the bounded background
// warm-up starts. The warm-up is deliberately sequential: the local service
// already shares one all-period projection, while each report still occupies
// one of its two live snapshot slots.
const PERIOD_PRELOAD_DELAY_MS = 250;
const PREPARING_POLL_DELAY_MS = 750;
const MAX_PREPARING_POLLS = 20;
const COVERAGE_NOTICE_THRESHOLD = 0.95;
// Cold accounting can take minutes. Spread the same bounded request budget
// over that work instead of exhausting it in the first fifteen seconds.
const preloadPollDelay = attempt => Math.min(10_000, PREPARING_POLL_DELAY_MS * 2 ** attempt);
const PRELOAD_REQUEST_TIMEOUT_MS = 10_000;
const COMPONENTS = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];
const COMPONENT_LABELS = [
  "uncached",
  "cacheRead",
  "cacheWrite",
  "outputText",
  "reasoning",
  "combined",
];
const safeNumber = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const timestamp = (v) => count(v) && v <= 8_640_000_000_000_000;
const shortText = (v, maximum = 200) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const codexThreadId = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
const nullableName = (value, maximum = 512) =>
  value === null || shortText(value, maximum);
function validThreadDecoration(thread, url) {
  return (
    thread &&
    typeof thread === "object" &&
    !Array.isArray(thread) &&
    codexThreadId(thread.id) &&
    url?.toLowerCase() === `codex://threads/${thread.id.toLowerCase()}` &&
    nullableName(thread.name) &&
    nullableName(thread.nickname, 80) &&
    (thread.parent === null ||
      (thread.parent &&
        typeof thread.parent === "object" &&
        !Array.isArray(thread.parent) &&
        codexThreadId(thread.parent.id) &&
        thread.parent.id.toLowerCase() !== thread.id.toLowerCase() &&
        nullableName(thread.parent.name)))
  );
}
export function validateWorkUsageResponse(value) {
  if (
    !value ||
    value.schemaVersion !== SCHEMA ||
    !["available", "preparing", "missing", "unavailable", "cancelled"].includes(
      value.status,
    )
  )
    throw new Error("invalid_response");
  for (const key of ["retained", "refreshing", "namesAvailable"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error("invalid_response");
  if (
    (value.retained === true && (value.status !== "available"
      || typeof value.refreshing !== "boolean" || typeof value.namesAvailable !== "boolean"))
    || (value.refreshing === true && value.retained !== true)
    || (value.namesAvailable === false && value.retained !== true)
    || (value.refreshSnapshotId != null && (!value.retained || !value.refreshing
      || !shortText(value.refreshSnapshotId) || value.refreshSnapshotId === value.snapshotId))
    || (value.refreshing === true && !shortText(value.refreshSnapshotId))
  ) throw new Error("invalid_response");
  if (value.status === "cancelled") return value;
  if (!shortText(value.snapshotId)) throw new Error("invalid_response");
  if (value.status !== "available") return value;
  if (
    !timestamp(value.fromMs) ||
    !timestamp(value.toMs) ||
    value.toMs < value.fromMs ||
    !value.metadata ||
    !timestamp(value.metadata.observedAt) ||
    !count(value.offset) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 100 ||
    !value.totals ||
    !safeNumber(value.totals.tokens) ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 0 ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.scopes) ||
    value.models.length > 1000 ||
    value.scopes.length > 1000 ||
    !value.display ||
    typeof value.display !== "object" ||
    Array.isArray(value.display) ||
    !value.models.every((id) => shortText(id)) ||
    !value.scopes.every(
      (scope) => scope && shortText(scope.id) && shortText(scope.status),
    ) ||
    (value.nextCursor !== null && !shortText(value.nextCursor)) ||
    !count(value.totals.activeThreads) ||
    !count(value.totals.activeProjects)
  )
    throw new Error("invalid_response");
  if (value.namesAvailable === false && (Object.keys(value.display).length !== 0
    || value.scopes.length !== 0 || value.nextCursor !== null))
    throw new Error("invalid_response");
  for (const row of value.rows) {
    if (row.subworkerCount !== undefined && !count(row.subworkerCount)) throw new Error("invalid_response");
    if (row.contributions !== undefined && (!Array.isArray(row.contributions) || row.contributions.length > 2
      || row.contributions.some(part => part?.kind !== "contribution" || !["primary", "subworkers"].includes(part.id)))) throw new Error("invalid_response");
    if (row.modelBreakdown !== undefined && (row.kind !== "thread" || !Array.isArray(row.modelBreakdown)
        || row.modelBreakdown.length > 50_000 || row.modelBreakdown.some(model => model?.kind !== "model"))) throw new Error("invalid_response");
  }
  for (const row of [value.totals, ...value.rows, ...value.rows.flatMap(row => [...(row.modelBreakdown ?? []), ...(row.contributions ?? [])])]) {
    if (
      !row ||
      !safeNumber(row.tokens) ||
      !shortText(row.id) ||
      !["total", "project", "worktree", "thread", "model", "contribution"].includes(row.kind) ||
      (row.lastAt !== null && !timestamp(row.lastAt)) ||
      !count(row.incompleteEvents) ||
      (row.assumedEvents !== undefined && !count(row.assumedEvents)) ||
      !count(row.events) ||
      !["complete", "partial", "unpriced"].includes(row.priceStatus) ||
      (row.share !== null &&
        (typeof row.share !== "number" ||
          !Number.isFinite(row.share) ||
          row.share < 0 ||
          row.share > 1)) ||
      !row.components ||
      !COMPONENTS.every((key) => safeNumber(row.components[key])) ||
      (row.costUsdExact !== null &&
        (typeof row.costUsdExact !== "string" ||
          !/^\d+(?:\.\d+)?$/u.test(row.costUsdExact) ||
          row.costUsdExact.length > 100))
    )
      throw new Error("invalid_response");
  }
  for (const decoration of Object.values(value.display)) {
    if (
      !decoration ||
      typeof decoration !== "object" ||
      Array.isArray(decoration) ||
      (decoration.name != null && !shortText(decoration.name, 1000)) ||
      (decoration.thread != null &&
        !validThreadDecoration(decoration.thread, decoration.codexUrl)) ||
      (decoration.shortId != null && !shortText(decoration.shortId)) ||
      (decoration.codexUrl != null &&
        !/^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          decoration.codexUrl,
        ))
    )
      throw new Error("invalid_response");
  }
  return value;
}
export function mountWorkUsageView(options = {}) {
  const {
    root,
    t,
    windowRef = window,
    fetchRef = (input, init) => windowRef.fetch(input, init),
  } = options;
  const documentRef = root.ownerDocument;
  let sharedReporting = options.sharedReporting === true || Object.hasOwn(options, "reportingWindow");
  let reportingWindow = sharedReporting ? normalizeReportingWindow(options.reportingWindow) : null;
  const tr = (key, values) => t(`workUsage.${key}`, values);
  const reportTranslate = (key, values) => t(`reporting.${key}`, values);
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let query = {
    schemaVersion: SCHEMA,
    period: sharedReporting ? reportingWindow?.period ?? null : "7d",
    grouping: "project",
    sort: "tokens",
    pageSize: 25,
  };
  if (sharedReporting && reportingWindow) query.endAt = reportingWindow.endAt;
  let response = null;
  let responseQueryKey = null;
  let retainedWindowQueryKey = null;
  // Work Usage responses are immutable, bounded page DTOs. Their snapshot
  // ids are leases owned by the service and may be evicted as the next warm
  // report is created, so the displayed cache is kept separate from the one
  // live foreground anchor used to create a fresh report.
  const periodCache = new Map();
  let periodCacheFamilyKey = null;
  let periodCacheAnchor = null;
  let liveAnchor = null;
  const queryKey = () => JSON.stringify(Object.entries(query)
    .filter(([key]) => !["snapshotId", "sourceSnapshotId"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  const retainedReport = () => Boolean(response?.retained || retainedWindowQueryKey !== null);
  const displayedForQuery = () => response !== null
    && (responseQueryKey === queryKey() || retainedWindowQueryKey === queryKey());
  const queryFamilyKey = (value = query) => JSON.stringify(Object.entries(value)
    .filter(([key]) => !["period", "cursor", "snapshotId", "sourceSnapshotId"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  let serial = 0;
  let controller = null;
  let timer = null;
  let started = false;
  let ancestors = [];
  let pages = [];
  let selectedTitle = null;
  let pendingFocus = null;
  let nested = null;
  let expandedThread = null;
  let nextNestedId = 0;
  let statusKey = "preparing";
  let statusValues;
  let leaseTimer = null;
  let leaseController = null;
  let destroyed = false;
  let searchTimer = null;
  let searchPending = false;
  let composing = false;
  let periodPreloadTimer = null;
  let periodPreloadController = null;
  let periodPreloadSerial = 0;
  let periodPreloadInFlight = null;
  let periodPreloadAllowInactive = false;
  let loadInFlight = null;
  let loadInFlightKey = null;
  let loadInFlightBackground = false;
  let foregroundLoadQueued = false;
  let preloadInFlight = null;
  let needsLeaseValidation = false;
  const scheduleLease = windowRef.setTimeout?.bind(windowRef) ?? setTimeout;
  const clearLeaseTimer = windowRef.clearTimeout?.bind(windowRef) ?? clearTimeout;
  const visible = () => !destroyed && !root.inert && documentRef.visibilityState !== "hidden";
  const documentVisible = () => !destroyed && documentRef.visibilityState !== "hidden";

  function generationKey(value) {
    const generation = value?.generation;
    if (typeof generation === "string" && shortText(generation)) return `string:${generation}`;
    if (!generation || typeof generation !== "object" || Array.isArray(generation)) return "unknown";
    if (shortText(generation.fingerprint)) return `fingerprint:${generation.fingerprint}`;
    if (shortText(generation.id)) return `id:${generation.id}`;
    if (Number.isSafeInteger(generation.id)) return `id:${generation.id}`;
    return "unknown";
  }

  function responseAnchor(value, snapshotId = value?.snapshotId) {
    if (!value || value.retained || !shortText(snapshotId) || !timestamp(value.toMs)) return null;
    return {
      snapshotId,
      generation: generationKey(value),
      toMs: value.toMs,
    };
  }

  function stableAnchor(anchor) {
    return anchor !== null && anchor.generation !== "unknown";
  }

  function sameAnchor(left, right) {
    return left !== null && right !== null
      && left.generation === right.generation
      && left.toMs === right.toMs;
  }

  function clearPeriodCache() {
    periodCache.clear();
    periodCacheFamilyKey = null;
    periodCacheAnchor = null;
  }

  function cachePeriod(periodId, value, familyKey, anchor) {
    if (!stableAnchor(anchor) || !PERIOD_IDS.includes(periodId) || value?.status !== "available"
        || !sameAnchor(anchor, responseAnchor(value))) return;
    if (periodCacheFamilyKey !== familyKey || !sameAnchor(periodCacheAnchor, anchor)) {
      periodCache.clear();
      periodCacheFamilyKey = familyKey;
      periodCacheAnchor = { ...anchor };
    }
    periodCache.set(periodId, structuredClone(value));
  }

  function cachedPeriod(periodId, familyKey, anchor) {
    if (periodCacheFamilyKey !== familyKey || !sameAnchor(periodCacheAnchor, anchor)) return null;
    const value = periodCache.get(periodId);
    return value ? structuredClone(value) : null;
  }

  function stopPeriodPreload() {
    clearLeaseTimer(periodPreloadTimer);
    periodPreloadTimer = null;
    periodPreloadSerial += 1;
    periodPreloadController?.abort();
    periodPreloadController = null;
    periodPreloadInFlight = null;
    periodPreloadAllowInactive = false;
  }

  function delayPeriodPreload(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timerId = null;
      let abort;
      const cleanup = () => {
        if (abort) signal?.removeEventListener?.("abort", abort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      abort = () => {
        if (settled) return;
        settled = true;
        clearLeaseTimer(timerId);
        timerId = null;
        cleanup();
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      timerId = scheduleLease(finish, milliseconds);
      timerId?.unref?.();
      signal?.addEventListener?.("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async function requestPeriodPreload(periodId, baseQuery, anchor, signal) {
    let bodyQuery = {
      ...baseQuery,
      period: periodId,
      sourceSnapshotId: anchor.snapshotId,
    };
    for (let attempt = 0; attempt <= MAX_PREPARING_POLLS; attempt += 1) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const requestController = new AbortController();
      const forwardAbort = () => requestController.abort();
      const requestTimer = scheduleLease(
        () => requestController.abort(),
        PRELOAD_REQUEST_TIMEOUT_MS,
      );
      requestTimer?.unref?.();
      signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        const http = await fetchRef("/api/local/work-usage/query", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-usage-monitor-local": "1",
          },
          cache: "no-store",
          body: JSON.stringify(bodyQuery),
          signal: requestController.signal,
        });
        if (requestController.signal.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const payload = http.status === 409
          ? await http.json().catch(() => null)
          : http.ok ? await http.json() : null;
        if (requestController.signal.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (http.status === 409) {
          return {
            result: null,
            invalidated: !bodyQuery.snapshotId && bodyQuery.sourceSnapshotId === anchor.snapshotId
              && [
              "work_usage_snapshot_expired",
              "work_usage_snapshot_changed",
              ].includes(payload?.error?.code),
          };
        }
        if (!http.ok) return {
          result: null,
          invalidated: http.status === 401 || http.status === 403,
        };
        const result = validateWorkUsageResponse(payload);
        // A saved report cannot anchor speculative periods or become a live
        // report through warming. Its replacement belongs to the foreground.
        if (result.retained) return { result: null, invalidated: false };
        if (result.status !== "preparing") {
          if (result.status === "available" && !sameAnchor(anchor, responseAnchor(result))) {
            return { result: null, invalidated: true };
          }
          return { result, invalidated: false };
        }
        if (attempt === MAX_PREPARING_POLLS) return { result: null, invalidated: false };
        await delayPeriodPreload(preloadPollDelay(attempt), signal);
        bodyQuery = {
          ...baseQuery,
          period: periodId,
          snapshotId: result.snapshotId,
        };
      } finally {
        clearLeaseTimer(requestTimer);
        signal.removeEventListener("abort", forwardAbort);
      }
    }
    return { result: null, invalidated: false };
  }

  async function runPeriodPreload({ allowInactive = false } = {}) {
    const canRun = allowInactive ? documentVisible() : visible();
    if (!canRun || statusKey !== "snapshot" || !liveAnchor || !stableAnchor(liveAnchor)
        || !response || query.cursor) return false;
    const token = ++periodPreloadSerial;
    const anchor = { ...liveAnchor };
    const familyKey = queryFamilyKey();
    if (periodCacheFamilyKey !== familyKey || !sameAnchor(periodCacheAnchor, anchor)) {
      clearPeriodCache();
    }
    const baseQuery = Object.fromEntries(Object.entries(query)
      .filter(([key]) => !["period", "cursor", "snapshotId", "sourceSnapshotId"].includes(key)));
    const controllerRef = new AbortController();
    periodPreloadController = controllerRef;
    try {
      for (const periodId of PERIOD_IDS) {
        const stillVisible = allowInactive ? documentVisible() : visible();
        if (token !== periodPreloadSerial || !stillVisible || !liveAnchor
            || liveAnchor.snapshotId !== anchor.snapshotId
            || queryFamilyKey() !== familyKey) return;
        if (periodCache.has(periodId)) continue;
        const { result, invalidated } = await requestPeriodPreload(
          periodId,
          baseQuery,
          anchor,
          controllerRef.signal,
        );
        if (token !== periodPreloadSerial || controllerRef.signal.aborted) return;
        if (invalidated) {
          if (liveAnchor?.snapshotId === anchor.snapshotId) {
            clearPeriodCache();
            liveAnchor = null;
            body.inert = true;
            refresh();
          }
          return;
        }
        if (result?.status === "available") cachePeriod(periodId, result, familyKey, anchor);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        // Warm-up is opportunistic. A failed speculative request must not
        // replace the visible report or turn a transient source failure into
        // a page-level error.
      }
    } finally {
      if (periodPreloadController === controllerRef) periodPreloadController = null;
    }
    return true;
  }

  function preloadPeriods(options = {}) {
    const allowInactive = options.allowInactive === true;
    if (periodPreloadInFlight) {
      if (!allowInactive || periodPreloadAllowInactive) return periodPreloadInFlight;
      stopPeriodPreload();
    }
    const promise = runPeriodPreload(options);
    const tracked = promise.finally(() => {
      if (periodPreloadInFlight === tracked) periodPreloadInFlight = null;
    });
    periodPreloadInFlight = tracked;
    periodPreloadAllowInactive = allowInactive;
    return tracked;
  }

  function schedulePeriodPreload() {
    clearLeaseTimer(periodPreloadTimer);
    periodPreloadTimer = null;
    if (!visible() || statusKey !== "snapshot" || !liveAnchor || !stableAnchor(liveAnchor)
        || !response || query.cursor) return;
    const familyKey = queryFamilyKey();
    if (periodCacheFamilyKey !== familyKey || !sameAnchor(periodCacheAnchor, liveAnchor)
        || PERIOD_IDS.some((periodId) => !periodCache.has(periodId))) {
      periodPreloadTimer = scheduleLease(() => {
        periodPreloadTimer = null;
        void preloadPeriods();
      }, PERIOD_PRELOAD_DELAY_MS);
      periodPreloadTimer?.unref?.();
    }
  }
  function stopLease() {
    clearLeaseTimer(leaseTimer);
    leaseTimer = null;
    leaseController?.abort();
    leaseController = null;
  }
  function queueLease() {
    clearLeaseTimer(leaseTimer);
    if (visible() && statusKey === "snapshot") {
      leaseTimer = scheduleLease(keepReportAlive, 60_000);
      leaseTimer?.unref?.();
    }
  }
  async function keepReportAlive() {
    if (!visible() || statusKey !== "snapshot" || !query.snapshotId || leaseController) return;
    const snapshotId = query.snapshotId;
    const token = serial;
    const requestController = new AbortController();
    leaseController = requestController;
    const timeout = scheduleLease(() => requestController.abort(), 10_000);
    try {
      const http = await fetchRef("/api/local/work-usage/query", {
        method: "POST",
        headers: { "content-type": "application/json", "x-usage-monitor-local": "1" },
        cache: "no-store",
        body: JSON.stringify({ schemaVersion: SCHEMA, action: "touch", snapshotId }),
        signal: requestController.signal,
      });
      if (http.status === 409 && token === serial && !requestController.signal.aborted && visible()) {
        const error = await http.json();
        if (error.error?.code === "work_usage_snapshot_expired" && token === serial
            && !requestController.signal.aborted && visible()) {
          liveAnchor = null;
          clearPeriodCache();
          refresh();
        }
      }
    } catch {} // A transient lease failure must not erase the displayed report.
    finally {
      clearLeaseTimer(timeout);
      if (leaseController === requestController) {
        leaseController = null;
        queueLease();
      }
    }
  }
  const setStatus = (key, values) => {
    statusKey = key;
    statusValues = values;
    const messageKey = key === "error" ? "error" : key;
    message.textContent = key === "waiting"
      ? reportTranslate("waiting")
      : sharedReporting && key === "missing"
        ? reportTranslate("unavailable")
        : tr(messageKey, values);
    message.dataset.state = key === "snapshot" ? "ready" : key === "preparing" ? "loading" : key;
  };
  const button = (label, action, className = "button button-secondary") => {
    const b = el("button", className, label);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const heading = el("div", "dashboard-page-header");
  const headingText = el("div");
  const title = el("h2", null, tr("title"));
  title.id = "work-usage-title";
  headingText.append(title, el("p", "page-description", tr("subtitle")));
  const period = el("div", "segmented-control");
  period.setAttribute("role", "group");
  period.setAttribute("aria-label", tr("period"));
  for (const id of PERIOD_IDS) {
    const b = button(id === "all" ? tr("all") : id, () => {
      query = { ...query, period: id };
      delete query.scope;
      resetPage();
      const anchor = liveAnchor?.snapshotId ?? null;
      const cached = cachedPeriod(id, queryFamilyKey(), liveAnchor);
      if (cached) {
        response = cached;
        responseQueryKey = queryKey();
        body.hidden = false;
        body.inert = true;
        render();
      }
      refresh(anchor, { preservePeriodCache: true });
    });
    b.dataset.period = id;
    period.append(b);
  }
  heading.append(headingText);
  if (!sharedReporting) heading.append(period);
  const toolbar = el("div", "work-usage-toolbar");
  const views = el("div", "work-usage-period segmented-control");
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", tr("title"));
  for (const id of ["project", "thread"]) {
    const viewButton = button(
      tr(id === "project" ? "projects" : "threads"),
      () => {
        ancestors = [];
        selectedTitle = null;
        clearSearchTimer();
        searchPending = false;
        input.value = "";
        delete query.project;
        delete query.worktree;
        delete query.thread;
        delete query.findThread;
        delete query.search;
        query.grouping = id;
        resetPage();
        load();
      },
    );
    viewButton.dataset.grouping = id;
    views.append(viewButton);
  }
  const select = (label, options, change) => {
    const wrapper = el("label", "work-usage-select");
    wrapper.append(el("span", null, label));
    const control = el("select");
    for (const [value, text] of options) {
      const o = el("option", null, text);
      o.value = value;
      control.append(o);
    }
    control.addEventListener("change", () => change(control.value));
    wrapper.append(control);
    return { wrapper, control };
  };
  const sort = select(
    tr("measure"),
    [
      ["tokens", tr("tokens")],
      ["cost", tr("cost")],
      ["recent", tr("recent")],
    ],
    (value) => {
      query.sort = value;
      resetPage();
      load();
    },
  );
  const model = select(tr("model"), [["", tr("allModels")]], (value) => {
    if (value) query.model = value;
    else delete query.model;
    resetPage();
    load();
  });
  model.control.classList.add("model-picker");
  function renderModelOptions(ids) {
    model.control.replaceChildren(
      ...[
        ["", tr("allModels")],
        ...[...ids].sort(compareModelPresentation).map((id) => [id, formatModelName(id)]),
      ].map(([value, text]) => {
        const option = el("option", null, text);
        option.value = value;
        option.title = value || text;
        const presentation = value ? modelUsagePresentation(value)
          : { theme: "layers", className: "allowance-model-classic" };
        const icon = modelThemeIcon(documentRef, presentation.theme);
        if (icon) {
          icon.classList.add(presentation.className);
          option.replaceChildren(icon, el("span", null, text));
        }
        return option;
      }),
    );
    // Customizable native selects retain platform keyboard/dismiss behavior
    // while allowing the same SVG identity in the list and selected value.
    if (windowRef.CSS?.supports("appearance", "base-select")) {
      const selected = el("button");
      selected.type = "button";
      selected.append(el("selectedcontent"));
      model.control.prepend(selected);
    }
    model.control.value = query.model ?? "";
  }
  renderModelOptions([]);
  const scope = select(tr("scope"), [], (value) => {
    if (retainedReport()) return;
    query.scope = value;
    refresh(liveAnchor?.snapshotId ?? null);
  });
  scope.wrapper.hidden = true;
  const refreshButton = button(tr("refresh"), refresh);
  const form = el("form", "work-usage-find");
  const input = el("input");
  input.type = "text";
  input.maxLength = 100;
  input.placeholder = tr("findHint");
  input.setAttribute("aria-label", tr("findHint"));
  form.append(input);
  const filters = el("div", "work-usage-filter-controls");
  filters.append(sort.wrapper, model.wrapper, scope.wrapper, refreshButton);
  toolbar.append(views, form, filters);
  function clearSearchTimer() {
    clearLeaseTimer(searchTimer);
    searchTimer = null;
  }
  function searchValue() {
    const value = input.value.trim();
    return value.length >= 2 ? value : "";
  }
  function deferSearch() {
    if (destroyed) return;
    clearSearchTimer();
    if (!searchPending && statusKey === "snapshot"
        && searchValue() === (query.search ?? query.findThread ?? "")) return;
    searchPending = true;
    // Fence old responses as soon as the text changes, before the debounce fires.
    serial++;
    controller?.abort();
    clearLeaseTimer(timer);
    timer = null;
    stopLease();
    clearNested();
    body.hidden = true;
    setStatus("preparing");
    if (!composing) searchTimer = scheduleLease(() => load(), 300);
  }
  input.addEventListener("input", deferSearch);
  input.addEventListener("compositionstart", () => {
    composing = true;
    deferSearch();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    deferSearch();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (composing || destroyed) return;
    searchPending = true;
    load();
  });
  function applySearch() {
    const value = searchValue();
    const exactThread = /^(?:codex:\/\/threads\/)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    if (value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)
        || (/^codex:\/\//iu.test(value) && !exactThread)) {
      setStatus("invalid");
      return false;
    }
    ancestors = [];
    selectedTitle = null;
    delete query.project;
    delete query.worktree;
    delete query.thread;
    delete query.findThread;
    delete query.search;
    if (exactThread) query.findThread = value;
    else if (value) query.search = value;
    query.grouping = exactThread ? "thread" : "project";
    resetPage();
    return true;
  }
  const message = el("p", "work-usage-status");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const cancel = button(tr("cancel"), async () => {
    clearSearchTimer();
    searchPending = false;
    stopLease();
    serial++;
    clearNested();
    controller?.abort();
    clearLeaseTimer(timer);
    timer = null;
    stopPeriodPreload();
    if (query.snapshotId) {
      try {
        await fetchRef("/api/local/work-usage/query", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-usage-monitor-local": "1",
          },
          body: JSON.stringify({
            schemaVersion: SCHEMA,
            action: "cancel",
            snapshotId: query.snapshotId,
          }),
        });
      } catch {}
    }
    delete query.snapshotId;
    delete query.sourceSnapshotId;
    liveAnchor = null;
    clearPeriodCache();
    cancel.hidden = true;
    root.removeAttribute("aria-busy");
    // Retained values stay readable, but their cancelled/expired report must
    // not regain active drill-down controls until a fresh query succeeds.
    body.inert = response !== null;
    body.dataset.state = "cancelled";
    setStatus("cancelled");
  });
  cancel.hidden = true;
  const body = el("div");
  const eyebrow = el("p", "annotation", tr("local"));
  const actions = el("div", "dashboard-actions work-usage-actions");
  actions.append(message, cancel);
  root.replaceChildren(
    heading,
    eyebrow,
    toolbar,
    actions,
    body,
  );
  function resetPage() {
    delete query.cursor;
    pages = [];
  }
  function refresh(sourceSnapshotId = null, { preservePeriodCache = false } = {}) {
    stopPeriodPreload();
    if (!preservePeriodCache) clearPeriodCache();
    delete query.snapshotId;
    delete query.sourceSnapshotId;
    if (typeof sourceSnapshotId === "string" && !retainedReport()) query.sourceSnapshotId = sourceSnapshotId;
    resetPage();
    load(true, { force: true });
  }
  function descend(row, grouping = null) {
    if (retainedReport()) return;
    ancestors.push({
      query: { ...query },
      pages: [...pages],
      title: selectedTitle,
      rowId: row.id,
    });
    selectedTitle = label(row);
    pendingFocus = "heading";
    resetPage();
    if (row.kind === "project") {
      query.project = row.id;
      query.grouping = "thread";
    } else if (row.kind === "worktree") {
      query.worktree = row.id;
      query.grouping = "thread";
    } else query.thread = row.id;
    if (grouping) query.grouping = grouping;
    load();
  }
  function label(row, report = response) {
    const display = report?.display[row.id];
    if (report?.namesAvailable === false && !["unassigned", "non-project"].includes(row.id))
      return tr(row.kind === "project" ? "savedProject" : row.kind === "worktree" ? "savedWorktree" : "savedThread", {
        number: report.offset + report.rows.indexOf(row) + 1,
      });
    return row.id === "unassigned"
      ? tr("unassigned")
      : row.id === "non-project" ? tr("nonProject")
      : (display?.name ??
          `${tr(row.kind === "project" ? "projects" : row.kind === "worktree" ? "worktrees" : "threads")} · ${display?.shortId ?? row.id.slice(-10)}`);
  }
  const quantity = (n) => (n === null ? "—" : formatNumber(n));
  const resultCount = (count, grouping) => tr(
    `${grouping}Count${count === 1 ? "One" : "Other"}`, { count: quantity(count) },
  );
  const expectedReportingBounds = (window) => {
    if (!window) return null;
    const endMs = Date.parse(window.endAt);
    if (!Number.isSafeInteger(endMs) || endMs < 0) return null;
    const fromMs = window.period === "all"
      ? (window.startAt === null ? null : Date.parse(window.startAt))
      : Math.max(0, endMs - REPORTING_DURATION_MS[window.period]);
    return { fromMs, toMs: endMs };
  };
  const assertExactReportingBounds = (result) => {
    if (!sharedReporting || !reportingWindow || result.status !== "available") return;
    const expected = expectedReportingBounds(reportingWindow);
    if (!expected || result.toMs !== expected.toMs
        || expected.fromMs !== null && result.fromMs !== expected.fromMs)
      throw new Error("unavailable");
  };
  function appendUsageEvidence() {
    const evidence = createEvidenceList(documentRef, "work-usage-evidence");
    const totalEvents = response?.totals?.events;
    const incompleteEvents = response?.totals?.incompleteEvents;
    if (count(totalEvents) && count(incompleteEvents) && incompleteEvents <= totalEvents) {
      const complete = totalEvents - incompleteEvents;
      if (totalEvents > 0 && complete / totalEvents < COVERAGE_NOTICE_THRESHOLD) {
        appendEvidenceRow(documentRef, evidence, {
          kind: "token-coverage",
          label: tr("coverage", { known: quantity(complete), total: quantity(totalEvents) }),
          value: "",
          state: "partial",
        });
      }
    }
    const unpricedEvents = response?.totals?.unpricedEvents;
    const priced = count(totalEvents) && count(unpricedEvents) && unpricedEvents <= totalEvents
      ? totalEvents - unpricedEvents
      : response?.totals?.priceStatus === "complete" && count(totalEvents)
        ? totalEvents
        : null;
    if (priced !== null && totalEvents > 0
        && priced / totalEvents < COVERAGE_NOTICE_THRESHOLD) {
      appendEvidenceRow(documentRef, evidence, {
        kind: "price-coverage",
        label: tr("priceCoverage", { priced: quantity(priced), total: quantity(totalEvents) }),
        value: "",
        state: "partial",
      });
    }
    return evidence.children.length ? evidence : null;
  }
  function appendModelIcon(target, id) {
    const presentation = modelUsagePresentation(id);
    const icon = modelThemeIcon(documentRef, presentation.theme);
    if (icon) {
      icon.classList.add("model-usage-icon", presentation.className);
      target.prepend(icon);
    }
  }
  const quietButton = (text, action) =>
    button(text, action, "button button-quiet compact");
  function clearNested() {
    expandedThread = null;
    nested?.controller?.abort();
    nested = null;
  }
  function toggleProject(row) {
    if (retainedReport()) return;
    if (nested?.project === row.id) clearNested();
    else {
      clearNested();
      nested = {
        project: row.id,
        regionId: `${root.id || "work-usage"}-children-${++nextNestedId}`,
        pages: [],
        cursor: null,
        status: "preparing",
      };
      loadNested(nested);
    }
    pendingFocus = row.id;
    render();
  }
  async function loadNested(entry) {
    expandedThread = null;
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    entry.status = "preparing";
    const token = serial;
    const childQuery = { ...query, grouping: "thread", project: entry.project };
    delete childQuery.cursor;
    if (entry.cursor) childQuery.cursor = entry.cursor;
    try {
      const http = await fetchRef("/api/local/work-usage/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-usage-monitor-local": "1",
        },
        cache: "no-store",
        body: JSON.stringify(childQuery),
        signal: controller.signal,
      });
      if (http.status === 409) {
        const error = await http.json();
        if (error.error?.code === "work_usage_snapshot_expired" && token === serial
            && nested === entry && !controller.signal.aborted) {
          refresh();
          return;
        }
      }
      if (!http.ok)
        throw new Error(http.status === 409 ? "expired" : "unavailable");
      const result = validateWorkUsageResponse(await http.json());
      if (
        result.status !== "available" ||
        result.snapshotId !== response.snapshotId ||
        result.scope !== response.scope ||
        result.fromMs !== response.fromMs ||
        result.toMs !== response.toMs
      )
        throw new Error("unavailable");
      if (token !== serial || nested !== entry || controller.signal.aborted)
        return;
      entry.response = result;
      entry.status = "available";
    } catch (error) {
      if (token !== serial || nested !== entry || controller.signal.aborted)
        return;
      entry.status = error.message === "expired" ? "expired" : "unavailable";
    }
    if (nested === entry && token === serial) {
      pendingFocus = documentRef.activeElement?.classList?.contains(
        "work-usage-project-toggle",
      )
        ? entry.focusFirst
          ? entry.response?.rows[0]?.id
          : entry.project
        : null;
      entry.focusFirst = false;
      render();
    }
  }
  function render() {
    body.replaceChildren();
    const evidence = appendUsageEvidence();
    if (evidence) body.append(evidence);
    let focusTarget;
    if (ancestors.length)
      body.append(
        button(`← ${tr("back")}`, () => {
          const previous = ancestors.pop();
          query = previous.query;
          pages = previous.pages;
          selectedTitle = previous.title;
          pendingFocus = previous.rowId;
          load();
        }),
      );
    if (selectedTitle) {
      const detailTitle = el("h3", "work-usage-detail-title", selectedTitle);
      detailTitle.tabIndex = -1;
      body.append(detailTitle);
      if (pendingFocus === "heading") focusTarget = detailTitle;
    }
    if (!response.rowCount) {
      body.dataset.state = "empty";
      const searching = Boolean(query.search || query.findThread);
      const empty = el("div", "work-usage-empty dashboard-state");
      empty.dataset.state = "empty";
      const copy = el("p", null, tr(searching ? "searchEmpty" : "empty"));
      copy.setAttribute("role", "status");
      empty.append(copy);
      if (searching) {
        const recovery = el("div", "dashboard-state-actions");
        recovery.append(button(tr("clearSearch"), () => {
          input.value = "";
          searchPending = true;
          input.focus();
          load();
        }));
        empty.append(recovery);
      }
      body.append(empty);
      focusTarget?.focus();
      pendingFocus = null;
      return;
    }
    const summaries = el("div", "work-usage-summary");
    for (const [label, n] of [
      [tr("tokens"), response.totals.tokens],
      [tr("activeProjects"), response.totals.activeProjects],
      [tr("activeThreads"), response.totals.activeThreads],
    ]) {
      const card = el("div", "work-usage-card");
      card.append(el("span", null, label), el("strong", null, quantity(n)));
      summaries.append(card);
    }
    body.append(summaries);
    const totalTokens = response.totals.tokens;
    if (totalTokens > 0) {
      const mix = el("section", "work-usage-mix");
      mix.append(el("h3", null, tr("tokenMix")));
      const strip = el("div", "work-usage-mix-strip");
      strip.setAttribute("aria-hidden", "true");
      const legend = el("ul", "work-usage-mix-legend");
      for (const index of [1, 0, 2, 3, 4, 5]) {
        const amount = response.totals.components[COMPONENTS[index]];
        if (!(amount > 0)) continue;
        const style = `work-usage-component-${index}`;
        const segment = el("span", style);
        segment.style.width = `${Math.min(100, amount / totalTokens * 100)}%`;
        strip.append(segment);
        const item = el("li");
        const swatch = el("span", `work-usage-mix-swatch ${style}`);
        swatch.setAttribute("aria-hidden", "true");
        item.append(swatch, el("span", null, tr(COMPONENT_LABELS[index])),
          el("strong", null, formatSharePercent(amount, totalTokens)),
          el("span", "work-usage-mix-count", quantity(amount)));
        legend.append(item);
      }
      mix.append(strip, legend);
      body.append(mix);
    }
    if (query.search) body.append(el("p", "annotation work-usage-search-note", tr("searchNote")));
    body.append(
      el(
        "p",
        "work-usage-caption",
        `${formatLocal(new Date(response.fromMs).toISOString())} — ${formatLocal(new Date(response.toMs).toISOString())}`,
      ),
    );
    if (query.project && !query.thread && !query.worktree)
      body.append(
        button(
          tr(query.grouping === "worktree" ? "threads" : "worktrees"),
          () => {
            query.grouping =
              query.grouping === "worktree" ? "thread" : "worktree";
            pendingFocus = "heading";
            resetPage();
            load();
          },
        ),
      );
    if (query.thread) {
      const details = el("dl", "work-usage-components");
      COMPONENTS.forEach((key, i) => {
        const group = el("div");
        group.append(
          el("dt", null, tr(COMPONENT_LABELS[i])),
          el("dd", null, quantity(response.totals.components[key])),
        );
        details.append(group);
      });
      body.append(el("h3", null, tr("details")), details);
      const link = response.display[query.thread]?.codexUrl;
      if (/^codex:\/\/threads\/[0-9a-f-]{36}$/iu.test(link ?? "")) {
        const a = el("a", "button button-secondary", tr("open"));
        a.href = link;
        a.rel = "noreferrer";
        body.append(a);
      }
    }
    const panel = el("div", "accounting-models-panel work-usage-table-panel");
    const wrap = el("div", "table-wrap dashboard-table-scroll");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", tr("title"));
    const table = el("table", "work-usage-table dashboard-data-table");
    table.setAttribute("aria-label", tr("title"));
    const head = el("thead");
    const header = el("tr");
    const columns = [
      tr("nameColumn"),
      tr("changes"),
      tr("tokenColumn"),
      tr("tokenShare"),
      tr("cost"),
      tr("valueShare"),
    ];
    columns.forEach((name, index) => {
      const isShare = index === 3 || index === 5;
      const th = el(
        "th",
        index === 0 ? null : isShare ? "numeric-cell model-share-head" : "numeric-cell",
        isShare ? tr("shareColumn") : name,
      );
      if (isShare) th.setAttribute("aria-label", name);
      th.scope = "col";
      if (isShare) {
        if (options.renderInformationLabel) {
          th.replaceChildren(options.renderInformationLabel(tr("shareColumn"), tr("shareNote"), name));
        } else {
          th.title = tr("shareNote");
        }
      }
      header.append(th);
    });
    head.append(header);
    table.append(head);
    let tbody = el("tbody");
    const addRow = (row, report, child = false) => {
      const trNode = el(
        "tr",
        child ? "model-component-row work-usage-thread-row" : null,
      );
      const identity = el(
        "td",
        `model-identity cache-drop-thread-cell${child ? " model-component-identity" : ""}`,
      );
      identity.setAttribute("data-label", columns[0]);
      const display = report.display[row.id];
      const name = label(row, report);
      let control;
      if (row.kind === "project" && !query.project) {
        const open = nested?.project === row.id;
        control = button(
          name,
          () => toggleProject(row),
          "work-usage-project-toggle",
        );
        control.setAttribute("aria-expanded", String(open));
        control.setAttribute(
          "aria-label",
          tr(open ? "collapseProject" : "expandProject", { name }),
        );
        if (open) control.setAttribute("aria-controls", nested.regionId);
        const caret = el("span", "model-disclosure-caret", "›");
        caret.setAttribute("aria-hidden", "true");
        control.prepend(caret);
      } else if (row.kind === "thread" && display?.codexUrl) {
        const parts = formatCodexThreadParts(
          display.thread ?? { id: display.codexUrl.split("/").at(-1), name },
          t,
        );
        const content = el("span", "cache-drop-thread-content");
        for (const part of parts) {
          if (part.href === null) {
            control = el("span", "cache-drop-thread-unavailable",
              `${part.name}: ${t("accounting.cacheDropThread.unavailable")}`);
            content.append(control);
            continue;
          }
          const link = el("a", "cache-drop-thread-link", part.name);
          link.title = part.name;
          link.href = part.href;
          link.rel = "noreferrer";
          link.setAttribute(
            "aria-label",
            tr("openThread", { name: part.name }),
          );
          if (part.worker) {
            const worker = el("span", "cache-drop-subworker");
            worker.append(
              documentRef.createTextNode("["),
              link,
              documentRef.createTextNode("]"),
            );
            if (parts.length > 1)
              content.append(documentRef.createTextNode(" "));
            content.append(worker);
          } else {
            content.append(link);
            if (part.autoReview) {
              content.append(el("span", "cache-drop-subworker", " [Auto review]"));
            }
          }
          control = link;
        }
        identity.append(content);
      } else if (row.kind === "thread") {
        control = el("span", "cache-drop-thread-unavailable", name);
        control.tabIndex = -1;
      } else control = button(name, () => descend(row), "work-usage-row-link");
      if (!identity.contains(control)) identity.append(control);
      const lastActive =
        row.lastAt === null
          ? "—"
          : formatLocal(new Date(row.lastAt).toISOString());
      control.title = `${control.title ? `${control.title}\n` : ""}${tr("recent")}: ${lastActive}`;
      if (display?.shortId) control.title += ` · ${display.shortId}`;
      if (row.kind === "project" && display?.shortId)
        identity.append(el("small", "muted", ` · ${display.shortId}`));
      if (row.subworkerCount > 0) identity.append(el("small", "work-usage-muted work-usage-family-count", tr("subworkersIncluded", {count:quantity(row.subworkerCount)})));
      if (row.kind === "thread" && row.modelBreakdown?.length) {
        const open = expandedThread === row.id;
        const toggle = button("", () => {
          expandedThread = open ? null : row.id;
          pendingFocus = row.id;
          render();
        }, "work-usage-project-toggle work-usage-model-toggle");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", tr(open ? "collapseModels" : "expandModels", { name }));
        if (open) toggle.setAttribute("aria-controls", `${root.id}-model-breakdown`);
        const caret = el("span", "model-disclosure-caret", "›");
        caret.setAttribute("aria-hidden", "true");
        toggle.append(caret);
        identity.prepend(toggle);
        const primary = row.modelBreakdown[0];
        const primaryLabel = el("small", "work-usage-muted work-usage-primary-model",
          tr("primaryModel", { model: formatModelName(primary.id), extra: row.modelBreakdown.length > 1 ? ` +${row.modelBreakdown.length - 1}` : "" }));
        appendModelIcon(primaryLabel, primary.id);
        identity.append(primaryLabel);
        control = toggle;
      }
      if (
        pendingFocus === row.id ||
        (pendingFocus === "first-row" && !focusTarget)
      )
        focusTarget = control;
      const numericCell = (value, index, className = "numeric-cell") => {
        const cell = el("td", className, value);
        cell.setAttribute("data-label", columns[index]);
        return cell;
      };
      const tokens = numericCell(quantity(row.tokens), 2);
      if (row.incompleteEvents)
        tokens.append(el("small", "work-usage-muted", tr("partial")));
      if (row.assumedEvents)
        tokens.append(el("small", "work-usage-muted", tr("assumed")));
      const cost = numericCell(
        formatApiMoney(row.costUsdExact),
        4,
        "numeric-cell model-api-equivalent",
      );
      if (row.priceStatus === "partial")
        cost.append(el("small", "work-usage-muted", tr("partial")));
      const shareCell = (part, whole, index) => {
        const cell = numericCell(formatSharePercent(part, whole) ?? "—", index, "numeric-cell model-share");
        if (part !== null && whole > 0 && Number.isFinite(part)) {
          const bar = el("span", "work-usage-bar");
          bar.setAttribute("aria-hidden", "true");
          const fill = el("span");
          fill.style.width = `${Math.max(0, Math.min(100, part / whole * 100))}%`;
          bar.append(fill); cell.append(bar);
        }
        return cell;
      };
      const costNumber =
        row.costUsdExact === null ? null : Number(row.costUsdExact);
      const totalCost =
        response.totals.costUsdExact === null
          ? null
          : Number(response.totals.costUsdExact);
      trNode.append(
        identity,
        numericCell(quantity(row.events), 1),
        tokens,
        shareCell(row.tokens, response.totals.tokens, 3),
        cost,
        shareCell(costNumber, totalCost, 5),
      );
      return trNode;
    };
    const appendRow = (group, row, report, child = false) => {
      group.append(addRow(row, report, child));
      if (row.kind !== "thread" || expandedThread !== row.id || !row.modelBreakdown?.length) return;
      const detailRow = el("tr", "work-usage-model-detail");
      const cell = el("td");
      cell.colSpan = 6;
      const region = el("div", "work-usage-model-breakdown");
      region.id = `${root.id}-model-breakdown`;
      const detail = el("table", "work-usage-model-table");
      detail.setAttribute("aria-label", tr("modelBreakdown", { name: label(row, report) }));
      const components = [
        ["input_cache_read_tokens", "cacheRead"],
        ["input_uncached_tokens", "uncached"],
        ["output_text_tokens", "outputText"],
        ["output_reasoning_tokens", "reasoning"],
      ];
      if (row.modelBreakdown.some(model => (model.components.input_cache_write_tokens ?? 0) > 0)) components.splice(2,0,["input_cache_write_tokens", "cacheWrite"]);
      if (row.modelBreakdown.some(model => model.components.output_combined_tokens !== null)) components.push(["output_combined_tokens", "combined"]);
      const headers = [tr("model"), ...components.map(([,key])=>tr(key)), tr("cost")];
      const head = el("thead"); const header = el("tr");
      headers.forEach((name,i) => { const th=el("th", i ? "numeric-cell" : null, name); th.scope="col"; header.append(th); });
      head.append(header); detail.append(head);
      const body = el("tbody");
      for (const model of row.modelBreakdown) {
        const line = el("tr");
        const modelName = el("td", "model-identity", formatModelName(model.id));
        appendModelIcon(modelName, model.id);
        line.append(modelName);
        for (const [key] of components) line.append(el("td","numeric-cell",quantity(model.components[key])));
        const cost = el("td","numeric-cell model-api-equivalent",formatApiMoney(model.costUsdExact));
        if (model.priceStatus === "partial") cost.append(el("small","work-usage-muted",tr("partial")));
        line.append(cost); body.append(line);
      }
      detail.append(body); region.append(detail);
      if (row.subworkerCount > 0) {
        const totals = el("table", "work-usage-contributions");
        totals.setAttribute("aria-label", tr("contributions"));
        const head=el("thead"); const heading=el("tr");
        [tr("contributions"),tr("tokenColumn"),tr("cost")].forEach((text,i)=>{const th=el("th",i ? "numeric-cell" : null,text);th.scope="col";heading.append(th);});head.append(heading);totals.append(head);
        const rows=el("tbody");
        for (const part of row.contributions ?? []) {
          const line=el("tr");const cost=el("td","numeric-cell",formatApiMoney(part.costUsdExact));
          if (part.priceStatus === "partial") cost.append(el("small","work-usage-muted",tr("partial")));
          line.append(el("td",null,tr(part.id === "primary" ? "primaryThread" : "subworkers")),el("td","numeric-cell",quantity(part.tokens)),cost);rows.append(line);
        }
        totals.append(rows); region.prepend(totals);
      }
      region.append(el("p","annotation",tr("modelBreakdownNote")));
      cell.append(region); detailRow.append(cell); group.append(detailRow);
    };
    for (const row of response.rows) {
      appendRow(tbody, row, response);
      if (nested?.project !== row.id) continue;
      const entry = nested;
      const childGroup = el("tbody", "work-usage-children");
      childGroup.id = entry.regionId;
      // Keep all six columns in the parent table; each expansion is its own
      // semantic row group, never a second table with a different column grid.
      table.append(tbody);
      if (entry.status === "available") {
        for (const child of entry.response.rows)
          appendRow(childGroup, child, entry.response, true);
      }
      const controlsRow = el("tr", "model-component-row");
      const controlsCell = el("td", "work-usage-child-controls");
      controlsCell.colSpan = 6;
      if (entry.status !== "available") {
        const status = el("span", "annotation", tr(entry.status));
        status.setAttribute("role", "status");
        controlsCell.append(status);
        if (entry.status === "expired")
          controlsCell.append(quietButton(tr("refresh"), refresh));
        else if (entry.status !== "preparing")
          controlsCell.append(
            quietButton(tr("retry"), () => {
              loadNested(entry);
              pendingFocus = row.id;
              render();
            }),
          );
      } else {
        const page = el("div", "table-pagination");
        const previous = quietButton(tr("previous"), () => {
          entry.cursor = entry.pages.pop() ?? null;
          entry.focusFirst = true;
          loadNested(entry);
          pendingFocus = row.id;
          render();
        });
        previous.disabled = !entry.pages.length;
        const next = quietButton(tr("next"), () => {
          entry.pages.push(entry.cursor);
          entry.cursor = entry.response.nextCursor;
          entry.focusFirst = true;
          loadNested(entry);
          pendingFocus = row.id;
          render();
        });
        next.disabled = !entry.response.nextCursor;
        for (const button of [previous, next])
          button.setAttribute("aria-controls", entry.regionId);
        const singlePage = entry.response.offset === 0 && !entry.pages.length
          && !entry.response.nextCursor && entry.response.rowCount <= entry.response.rows.length;
        previous.hidden = singlePage;
        next.hidden = singlePage;
        page.append(
          previous,
          el(
            "span",
            "table-pagination-status",
            singlePage ? resultCount(entry.response.rowCount, "thread") : tr("rows", {
              from: entry.response.rowCount ? entry.response.offset + 1 : 0,
              to: Math.min(
                entry.response.offset + query.pageSize,
                entry.response.rowCount,
              ),
              total: entry.response.rowCount,
            }),
          ),
          next,
        );
        controlsCell.append(page);
      }
      controlsCell.append(
        quietButton(tr("worktrees"), () => descend(row, "worktree")),
      );
      controlsRow.append(controlsCell);
      childGroup.append(controlsRow);
      table.append(childGroup);
      tbody = el("tbody");
    }
    // Parent rows following the expansion need a fresh row group so their
    // visual order stays project -> children -> next project.
    if (!tbody.parentNode) table.append(tbody);
    wrap.append(table);
    panel.append(wrap);
    body.append(panel);
    body.dataset.state = "ready";
    const pagination = el("div", "table-pagination");
    const previous = quietButton(tr("previous"), () => {
      if (retainedReport()) return;
      pendingFocus = "first-row";
      const cursor = pages.pop();
      if (cursor) query.cursor = cursor;
      else delete query.cursor;
      load();
    });
    previous.disabled = !pages.length;
    const next = quietButton(tr("next"), () => {
      if (retainedReport()) return;
      pendingFocus = "first-row";
      pages.push(query.cursor ?? null);
      query.cursor = response.nextCursor;
      load();
    });
    next.disabled = !response.nextCursor;
    const singlePage = response.offset === 0 && !pages.length
      && !response.nextCursor && response.rowCount <= response.rows.length;
    previous.hidden = singlePage;
    next.hidden = singlePage;
    pagination.append(
      previous,
      el(
        "span",
        "table-pagination-status",
        singlePage ? resultCount(response.rowCount, query.grouping) : tr("rows", {
          from: response.rowCount ? response.offset + 1 : 0,
          to: Math.min(response.offset + query.pageSize, response.rowCount),
          total: response.rowCount,
        }),
      ),
      next,
    );
    body.append(pagination);
    if (response.namesAvailable === false)
      body.append(el("p", "work-usage-caption", tr("savedNamesUnavailable")));
    focusTarget?.focus();
    pendingFocus = null;
  }
  function load(recoverExpired = true, options = {}) {
    const background = options.background === true;
    const force = options.force === true;
    if (force) foregroundLoadQueued = false;
    if (loadInFlight && !force) {
      if (loadInFlightKey === queryKey() && !background && loadInFlightBackground) {
        foregroundLoadQueued = true;
        const current = loadInFlight;
        return current.then(() => {
          if (!foregroundLoadQueued || destroyed) return undefined;
          foregroundLoadQueued = false;
          return load(recoverExpired);
        });
      }
      if (loadInFlightKey === queryKey()) return loadInFlight;
      serial++;
      controller?.abort();
      clearLeaseTimer(timer);
      timer = null;
      loadInFlight = null;
      loadInFlightKey = null;
      loadInFlightBackground = false;
      foregroundLoadQueued = false;
    }
    const promise = performLoad(recoverExpired, { background, preparingAttempt: 0 });
    const key = queryKey();
    let tracked;
    tracked = promise.finally(() => {
      if (loadInFlight === tracked) {
        loadInFlight = null;
        loadInFlightKey = null;
        loadInFlightBackground = false;
      }
    });
    loadInFlight = tracked;
    loadInFlightKey = key;
    loadInFlightBackground = background;
    return tracked;
  }

  async function performLoad(
    recoverExpired = true,
    { background = false, preparingAttempt = 0 } = {},
  ) {
    if (destroyed || composing) return;
    clearSearchTimer();
    if (searchPending) {
      searchPending = false;
      if (!applySearch()) {
        serial++;
        controller?.abort();
        clearLeaseTimer(timer);
        timer = null;
        stopLease();
        cancel.hidden = true;
        root.removeAttribute("aria-busy");
        return;
      }
    }
    if (sharedReporting && !reportingWindow) {
      started = false;
      stopLease();
      serial++;
      controller?.abort();
      controller = null;
      clearLeaseTimer(timer);
      timer = null;
      clearNested();
      body.replaceChildren();
      body.hidden = true;
      body.inert = true;
      body.dataset.state = "waiting";
      cancel.hidden = true;
      root.removeAttribute("aria-busy");
      setStatus("waiting");
      return;
    }
    stopLease();
    stopPeriodPreload();
    const familyKey = queryFamilyKey();
    if (periodCacheFamilyKey !== null && periodCacheFamilyKey !== familyKey) clearPeriodCache();
    started = true;
    clearNested();
    const token = ++serial;
    controller?.abort();
    clearLeaseTimer(timer);
    timer = null;
    controller = new AbortController();
    const loadController = controller;
    body.dataset.state = "loading";
    body.inert = true;
    // Keep the exact query's previous report visible during revalidation, but
    // disable old snapshot controls until the replacement is authoritative.
    // Scope, filters, grouping, period and page are all part of this key.
    body.hidden = !displayedForQuery();
    setStatus(retainedReport() && !body.hidden ? "savedUpdating" : "preparing", response
      ? { date: formatLocal(new Date(response.toMs).toISOString()) } : undefined);
    cancel.hidden = false;
    root.setAttribute("aria-busy", "true");
    for (const b of views.children)
      b.setAttribute(
        "aria-pressed",
        String(
          b.dataset.grouping === (query.project ? "project" : query.grouping),
        ),
      );
    for (const b of period.children)
      b.setAttribute("aria-pressed", String(b.dataset.period === query.period));
    sort.control.value = query.sort;
    try {
      const requestController = background ? new AbortController() : loadController;
      const requestSignal = requestController.signal;
      const forwardAbort = background ? () => requestController.abort() : null;
      const requestTimer = background
        ? scheduleLease(() => requestController.abort(), PRELOAD_REQUEST_TIMEOUT_MS)
        : null;
      requestTimer?.unref?.();
      if (forwardAbort) loadController.signal.addEventListener("abort", forwardAbort, { once: true });
      let http;
      let payload = null;
      try {
        http = await fetchRef("/api/local/work-usage/query", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-usage-monitor-local": "1",
          },
          cache: "no-store",
          body: JSON.stringify(query),
          signal: requestSignal,
        });
        if (requestSignal.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (http.status === 409 || http.ok) payload = await http.json();
        if (requestSignal.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
      } finally {
        clearLeaseTimer(requestTimer);
        if (forwardAbort) loadController.signal.removeEventListener("abort", forwardAbort);
      }
      if (token !== serial) return;
      if (!http.ok && http.status === 409 && recoverExpired) {
        const error = payload;
        if (token !== serial) return;
        if (error.error?.code === "work_usage_snapshot_expired") {
          liveAnchor = null;
          clearPeriodCache();
          delete query.snapshotId;
          delete query.sourceSnapshotId;
          resetPage();
          return performLoad(false, { background, preparingAttempt: 0 });
        }
      }
      if (!http.ok) {
        if (http.status === 409 || http.status === 401 || http.status === 403) {
          liveAnchor = null;
          clearPeriodCache();
          response = null;
          responseQueryKey = null;
          retainedWindowQueryKey = null;
          body.hidden = true;
          body.dataset.state = http.status === 409 ? "expired" : "unavailable";
        }
        throw new Error(http.status === 409 ? "expired" : "unavailable");
      }
      const result = validateWorkUsageResponse(payload);
      if (token !== serial) return;
      assertExactReportingBounds(result);
      query.snapshotId = result.snapshotId;
      delete query.sourceSnapshotId;
      if (result.status === "preparing") {
        if (background) {
          if (preparingAttempt >= MAX_PREPARING_POLLS) return;
          await delayPeriodPreload(preloadPollDelay(preparingAttempt), loadController.signal);
          return performLoad(recoverExpired, {
            background,
            preparingAttempt: preparingAttempt + 1,
          });
        }
        timer = scheduleLease(
          () => load(recoverExpired, { background }),
          PREPARING_POLL_DELAY_MS,
        );
        return;
      }
      if (result.status !== "available") {
        liveAnchor = null;
        clearPeriodCache();
        if (retainedReport() && !body.hidden && displayedForQuery()) {
          setStatus("savedUnavailable", { date: formatLocal(new Date(response.toMs).toISOString()) });
          body.dataset.state = "error";
          return;
        }
        response = null;
        responseQueryKey = null;
        retainedWindowQueryKey = null;
        body.hidden = true;
        body.dataset.state = result.status === "missing" ? "missing" : "unavailable";
        setStatus(result.status === "missing" ? "missing" : "unavailable");
        return;
      }
      response = result;
      responseQueryKey = queryKey();
      retainedWindowQueryKey = null;
      liveAnchor = result.retained ? null : responseAnchor(result);
      if (result.retained) clearPeriodCache();
      else if (!query.cursor) cachePeriod(query.period, result, familyKey, liveAnchor);
      setStatus(result.retained ? (result.refreshing ? "savedUpdating" : "savedUnavailable") : "snapshot", {
        date: formatLocal(new Date(result.toMs).toISOString()),
      });
      renderModelOptions(result.models);
      scope.control.replaceChildren(
        ...result.scopes.map((s, i) => {
          const option = el(
            "option",
            null,
            s.status === "unavailable"
              ? tr("unknownScope")
              : tr("account", { number: i + 1 }),
          );
          option.value = s.id;
          return option;
        }),
      );
      scope.control.value = result.scope;
      scope.wrapper.hidden = Boolean(result.retained) || result.scopes.length < 2;
      for (const control of [views, sort.wrapper, model.wrapper, scope.wrapper, form])
        control.inert = Boolean(result.retained);
      body.hidden = false;
      const retainForInactive = !visible() && (background || needsLeaseValidation);
      if (retainForInactive) needsLeaseValidation = true;
      else needsLeaseValidation = false;
      body.inert = Boolean(result.retained) || retainForInactive;
      render();
      if (result.retained) {
        body.dataset.state = result.refreshing ? "loading" : "error";
        if (result.refreshing) {
          query.snapshotId = result.refreshSnapshotId;
          if (background) {
            if (preparingAttempt >= MAX_PREPARING_POLLS) return;
            await delayPeriodPreload(preloadPollDelay(preparingAttempt), loadController.signal);
            return performLoad(recoverExpired, { background, preparingAttempt: preparingAttempt + 1 });
          }
          timer = scheduleLease(() => load(recoverExpired), PREPARING_POLL_DELAY_MS);
        }
      } else if (retainForInactive) {
        stopLease();
        stopPeriodPreload();
      } else {
        queueLease();
        schedulePeriodPreload();
      }
    } catch (error) {
      if (token !== serial || error.name === "AbortError") return;
      if (retainedReport() && !body.hidden && displayedForQuery())
        setStatus("savedUnavailable", { date: formatLocal(new Date(response.toMs).toISOString()) });
      else setStatus(error.message === "expired" ? "expired" : "error");
      body.dataset.state = error.message === "expired" ? "expired" : "error";
    } finally {
      if (token === serial) {
        cancel.hidden = timer === null;
        if (cancel.hidden) root.removeAttribute("aria-busy");
      }
    }
  }
  function setReportingWindow(value) {
    const next = normalizeReportingWindow(value);
    const retainPrevious = next && reportingWindow && next.period === reportingWindow.period
      && Date.parse(next.endAt) > Date.parse(reportingWindow.endAt) && displayedForQuery();
    const previousKey = queryKey();
    const sameEnd = next && reportingWindow?.endAt === next.endAt;
    sharedReporting = true;
    reportingWindow = next;
    query = { ...query, period: next?.period ?? null };
    if (next) query.endAt = next.endAt;
    else delete query.endAt;
    const nextKey = queryKey();
    if (previousKey === nextKey) {
      if (next === null) setStatus("waiting");
      return next !== null;
    }
    const prepared = sameEnd ? cachedPeriod(next.period, queryFamilyKey(), periodCacheAnchor) : null;
    stopLease();
    stopPeriodPreload();
    preloadInFlight = null;
    liveAnchor = null;
    needsLeaseValidation = false;
    if (!sameEnd) clearPeriodCache();
    // A reporting-window change is a new exact evidence scope. Fence every
    // old request before replacing the query so a late response cannot revive
    // a snapshot or period cache from the previous window.
    serial++;
    controller?.abort();
    controller = null;
    clearLeaseTimer(timer);
    timer = null;
    clearSearchTimer();
    searchPending = false;
    clearNested();
    delete query.snapshotId;
    delete query.sourceSnapshotId;
    if (prepared) query.snapshotId = prepared.snapshotId;
    resetPage();
    ancestors = [];
    selectedTitle = null;
    response = prepared ?? (retainPrevious ? response : null);
    responseQueryKey = prepared ? queryKey() : retainPrevious ? responseQueryKey : null;
    retainedWindowQueryKey = prepared || retainPrevious ? queryKey() : null;
    started = false;
    cancel.hidden = true;
    root.removeAttribute("aria-busy");
    if (!prepared && !retainPrevious) body.replaceChildren();
    body.hidden = !prepared && !retainPrevious;
    body.inert = true;
    body.dataset.state = next === null ? "waiting" : "loading";
    if (next === null) {
      setStatus("waiting");
      return false;
    }
    if (prepared || retainPrevious) {
      setStatus("savedUpdating", { date: formatLocal(new Date(response.toMs).toISOString()) });
      scope.wrapper.hidden = true;
      for (const control of [views, sort.wrapper, model.wrapper, scope.wrapper, form]) control.inert = true;
      if (prepared) render();
    }
    if (visible()) load();
    return true;
  }

  function preload() {
    if (preloadInFlight) return preloadInFlight;
    if (!documentVisible()) return Promise.resolve(false);
    if (!visible()) {
      needsLeaseValidation = true;
      body.inert = true;
    }
    const operation = (async () => {
      if (statusKey !== "snapshot" || !response || !liveAnchor)
        await load(true, { background: true });
      if (!documentVisible() || !response || statusKey !== "snapshot" || !liveAnchor)
        return false;
      if (!visible()) {
        needsLeaseValidation = true;
        body.inert = true;
      } else if (needsLeaseValidation) {
        await load();
        if (!documentVisible() || statusKey !== "snapshot" || !response || !liveAnchor)
          return false;
      }
      await preloadPeriods({ allowInactive: true });
      return PERIOD_IDS.every((periodId) => periodCache.has(periodId));
    })();
    const tracked = operation.finally(() => {
      if (preloadInFlight === tracked) preloadInFlight = null;
    });
    preloadInFlight = tracked;
    return tracked;
  }

  function visibilityChanged() {
    stopLease();
    if (!documentVisible()) {
      stopPeriodPreload();
      foregroundLoadQueued = false;
      if (loadInFlightBackground) {
        serial++;
        controller?.abort();
        clearLeaseTimer(timer);
        timer = null;
      }
      return;
    }
    if (!visible()) {
      if (!periodPreloadAllowInactive) stopPeriodPreload();
      return;
    }
    if (!started || !response || responseQueryKey !== queryKey() || needsLeaseValidation) load();
    else {
      keepReportAlive();
      schedulePeriodPreload();
    }
  }
  const observer = new windowRef.MutationObserver(visibilityChanged);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["aria-hidden"],
  });
  if (visible()) load();
  else if (sharedReporting && !reportingWindow) setStatus("waiting");
  documentRef.addEventListener?.("visibilitychange", visibilityChanged);
  windowRef.addEventListener("pageshow", visibilityChanged);
  function relocalize() {
    eyebrow.textContent = tr("local");
    title.textContent = tr("title");
    headingText.lastChild.textContent = tr("subtitle");
    period.setAttribute("aria-label", tr("period"));
    if (period.lastChild) period.lastChild.textContent = tr("all");
    for (const b of views.children)
      b.textContent = tr(
        b.dataset.grouping === "project" ? "projects" : "threads",
      );
    sort.wrapper.firstChild.textContent = tr("measure");
    [...sort.control.options].forEach((o) => {
      o.textContent = tr(o.value);
    });
    model.wrapper.firstChild.textContent = tr("model");
    scope.wrapper.firstChild.textContent = tr("scope");
    renderModelOptions([...model.control.options].map(option => option.value).filter(Boolean));
    [...scope.control.options].forEach((option, i) => {
      option.textContent =
        response?.scopes[i]?.status === "unavailable"
          ? tr("unknownScope")
          : tr("account", { number: i + 1 });
    });
    refreshButton.textContent = tr("refresh");
    input.placeholder = tr("findHint");
    input.setAttribute("aria-label", tr("findHint"));
    cancel.textContent = tr("cancel");
    if (["snapshot", "savedUpdating", "savedUnavailable"].includes(statusKey) && response)
      statusValues = {
        date: formatLocal(new Date(response.toMs).toISOString()),
      };
    setStatus(statusKey, statusValues);
    if (response && !body.hidden) render();
  }
  windowRef.addEventListener("tibotattle:locale-change", relocalize);
  return {
    refresh,
    setReportingWindow,
    preload,
    destroy() {
      destroyed = true;
      clearSearchTimer();
      stopLease();
      stopPeriodPreload();
      liveAnchor = null;
      clearPeriodCache();
      serial++;
      clearNested();
      controller?.abort();
      clearLeaseTimer(timer);
      timer = null;
      observer.disconnect();
      documentRef.removeEventListener?.("visibilitychange", visibilityChanged);
      windowRef.removeEventListener("pageshow", visibilityChanged);
      windowRef.removeEventListener("tibotattle:locale-change", relocalize);
    },
  };
}
