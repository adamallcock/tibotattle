import {
  createObservationFreshnessClock,
  observationRecency,
} from "./dashboard-ui.js";
import { createElectronRefreshLease } from "./electron-refresh-lifecycle.js";
import { createReportingPeriod, reportingDays, reportingSelection, mountReportingPeriodDismissal } from "./reporting-period.js";
import { createCacheReuseMatrix } from "./cache-reuse-matrix.js";
import { cacheReuseMetricLines, cacheReuseCoverageNote } from "./cache-reuse-metrics.js";
import { mountTrendsHorizon, createSpendRateLookup } from "./trends-horizon.js";
import { mountAllowanceTanks } from "./allowance-tanks.js";
import { modelUsagePresentation, modelThemeIcon } from "./model-visuals.js";
import { buildAllowanceTrends } from "./allowance-trends.js";
import { mountWorkUsageView } from "./work-usage-view.js";
import { mountModelPerformance } from "./model-performance.js";
import { createDashboardReportPreloader } from "./dashboard-report-preload.js";
import {
  isPrimaryCodexQuotaWindow,
  isPrimaryCodexWeeklyQuotaWindow,
  isSparkQuotaLimitId,
  LocalCompanionClient,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  cacheDropThreadLookupKey,
  demoDashboard,
  isValidQuotaWindowDuration,
  selectAllowancePlanPopulation,
  selectPrimaryCodexQuotaWindow
} from "./data-client.js";
import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  createDiagnosticReference,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  detectDeviationPeriods,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  historyCoverageNoticeKind,
  historyIndexContinuationDecision,
  refreshAccountingStatus,
  refreshQuickResultStatus,
  refreshNeedsContinuation,
  serviceRequestId,
} from "./lib.js";
import {
  mountDashboardNavigation,
} from "./navigation.js";
import { resolveElectronStartupAppearance } from "./desktop-appearance.js";
import {
  renderInstallerJourney as renderSharedInstallerJourney,
} from "./install-cta.js";
import {
  COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT,
  createBrowserLocalization,
} from "./localization.js";
import {
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "./telemetry-shared.generated.js";
import {
  compact,
  formatCodexThreadParts,
  formatApiMoney,
  formatSharePercent,
  adaptiveChartTickCount,
  classifyTimelineEvidence,
  createDomHelpers,
  finite,
  formatAge,
  formatChartTimestamp,
  formatChartTimeLabel,
  formatCount,
  formatDecimal,
  formatMoney,
  formatPercent,
  formatPp,
  formatLocal,
  formatModelName,
  formatNumber,
  formatReportingTime,
  formatSignedPp,
  formatSignedPpHours,
  formatSpanLength,
  formatTimeRemaining,
  dateTimeFormatter,
  formatTimeZoneLabel,
  getFormattingLocale,
  localCalendarParts,
  setFormattingLocale,
  setMessageLocale,
  USER_TIME_ZONE,
} from "./ui-format.js";

const NATIVE_APPEARANCE_THEMES = new Set(["light", "dark"]);

function applyNativeAppearanceTheme(theme) {
  if (!NATIVE_APPEARANCE_THEMES.has(theme)) return false;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = theme === "dark" ? "#141a17" : "#f5f1e8";
  }
  return true;
}

// WKWebView installs this handoff at document start, before the stylesheet can
// paint. Electron applies nativeTheme before creating its BrowserWindow, so
// Chromium's effective color-scheme synchronously covers its first render.
// Reapplying both here owns live Settings changes and keeps the browser metadata
// in step without reloading a dashboard or losing in-memory state.
applyNativeAppearanceTheme(
  globalThis.__TIBOTATTLE_APPEARANCE__?.resolvedTheme,
);
applyNativeAppearanceTheme(resolveElectronStartupAppearance());
window.addEventListener("tibotattle:appearance-override", (event) => {
  applyNativeAppearanceTheme(event.detail?.resolvedTheme);
});

const localization = createBrowserLocalization();
setFormattingLocale(localization.formatLocale());
setMessageLocale(localization.locale());
const t = localization.t;
const tPlural = localization.tPlural;

// Accountless sharing uses the existing Electron preload bridge. The Electron
// main/application controller remains the policy owner; this page receives only
// its bounded projection through the versioned preload bridge. A missing or malformed
// projection never becomes an implied permission.
const ELECTRON_SHARING_API_VERSION = "v1";
const ELECTRON_SHARING_BASES = new Set([
  "default_on",
  "default_off",
  "migration_default_on",
  "user_choice",
  "legacy_preserved",
]);
const ELECTRON_SHARING_STATES = new Set([
  "pending_notices",
  "enabled",
  "disabled",
  "legacy_preserved",
]);
const ELECTRON_SHARING_TRANSPORT_STATUSES = new Set(["unavailable", "off", "uploading", "pending", "up_to_date", "retry_wait", "paused", "recovery_required"]);

function electronSharingBridge(windowRef = globalThis.window) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version !== ELECTRON_SHARING_API_VERSION
      || typeof bridge.getSharingPreference !== "function"
      || typeof bridge.setSharingEnabled !== "function"
      || typeof bridge.sharingNoticePresented !== "function") {
    return null;
  }
  return bridge;
}

function validSharingTimestamp(value) {
  if (value === null) return true;
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function normalizeElectronSharingPreference(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const available = raw.available === true;
  const current = raw.current === true;
  const state = ELECTRON_SHARING_STATES.has(raw.state) ? raw.state : null;
  const basis = ELECTRON_SHARING_BASES.has(raw.basis) ? raw.basis : null;
  const noticeCount = Number.isInteger(raw.noticeCount)
    && raw.noticeCount >= 0 && raw.noticeCount <= 3
    ? raw.noticeCount
    : 0;
  const nextNoticeIndex = raw.nextNoticeIndex === null
    ? null
    : Number.isInteger(raw.nextNoticeIndex)
      && raw.nextNoticeIndex >= 1 && raw.nextNoticeIndex <= 3
      ? raw.nextNoticeIndex
      : null;
  const nextNoticeAt = validSharingTimestamp(raw.nextNoticeAt) ? raw.nextNoticeAt : null;
  const earliestActivationAt = validSharingTimestamp(raw.earliestActivationAt)
    ? raw.earliestActivationAt
    : validSharingTimestamp(raw.activatesAt) ? raw.activatesAt : null;
  const transportStatus = ELECTRON_SHARING_TRANSPORT_STATUSES.has(raw.transportStatus)
    ? raw.transportStatus
    : raw.enabled === true ? "unavailable" : "off";
  if (raw.nextNoticeAt !== undefined && !validSharingTimestamp(raw.nextNoticeAt)) return null;
  if (raw.earliestActivationAt !== undefined && !validSharingTimestamp(raw.earliestActivationAt)) return null;
  if (raw.activatesAt !== undefined && !validSharingTimestamp(raw.activatesAt)) return null;
  return Object.freeze({
    available,
    current,
    enabled: available && current && raw.enabled === true,
    state,
    basis,
    noticeCount,
    nextNoticeIndex,
    noticeDue: raw.noticeDue === true,
    nextNoticeAt,
    earliestActivationAt,
    transportStatus,
  });
}

const localClient = new LocalCompanionClient();
let dashboard = null;
// Private, local-only display enrichment. Thread names never become part of
// an accounting/dashboard DTO, share card, contribution, or browser storage.
const cacheDropThreadLinks = {
  dashboard: null,
  generation: null,
  generationFingerprint: null,
  requestToken: 0,
  loadToken: 0,
  requested: false,
  entries: new Map(),
  cells: { switch: [], continuity: [] },
};
// Owner decision 2026-08-06: the calibration rolling comparison window is
// fixed at three hours. The 15-minute and 1-hour widths the old segmented
// control offered proved inaccurate, so the chart, its summary tiles, the
// sensitivity lookup, and the exact-windows inspection table all read this
// one width instead of a selection.
const CALIBRATION_WINDOW_HOURS = 3;
let activeUsageRangeDays = 7;
let activeCalibrationRangeDays = 7;
let activeUsageGrouping = "hour";
let activeAccountingPeriod = "7d";
// Every date-range control on the dashboard now offers the same three bounded
// windows before "All", and the cost-accounting period selector's own middle
// window is a 30-day one published by the companion. A chart labelled 31d beside
// an accounting total labelled 30d described two different periods with no
// visible reason, which is the inconsistency this settles.
let activeWeeklyRangeDays = 30;
let activeWeeklyMinimumObservedSpanPp = 50;
// The seven-day allowance stays the preferred initial view whenever it has
// evidence. A user's explicit window choice survives redraws and refreshes;
// if that duration disappears from a later payload, resolution falls back to
// the best available window instead of leaving a stale selection on screen.
let activeAllowanceWindowMinutes = null;
// Null follows the latest observed plan, including an insufficient one. An
// explicit choice stays in memory across refreshes, ranges and locale changes.
let activeWeeklyPlanType = null;
let timelineViewport = null;
let usageTimelineViewport = null;
let timelinePointerStart = null;
let usagePointerStart = null;
// The exact-windows inspection table pages through its full merged row set
// (owner-directed 2026-08-08) instead of capping at eight rows: ten rows per
// page, newest first, with the shown range stated as "N–M of T". The rows are
// re-derived on every timeline render; the page index is clamped there and
// returns to the first page whenever the underlying selection changes shape,
// so Prev/Next can never show a stale slice of a different selection.
const RESIDUAL_TABLE_PAGE_SIZE = 10;
let residualTablePage = 0;
let residualInspectionRows = [];
let residualInspectionSignature = "";
// Accounting tables use the dashboard's established ten-row pager rather than
// growing indefinitely. Each table owns its page because the model, switch,
// time-band, and recent-continuity row sets change independently. A changed
// period or refreshed row set returns to page one.
const CACHE_IMPACT_TABLE_PAGE_SIZE = 10;
const accountingModelsTablePagination = { page: 0, signature: "" };
// Which model rows the reader has opened. Held outside the render so a
// background refresh redraws the table without collapsing a row mid-read.
const accountingExpandedModels = new Set();
const cacheSwitchTablePagination = { page: 0, signature: "" };
const cacheContinuityTablePagination = { page: 0, signature: "" };
const sideChatTablePagination = { page: 0, signature: "" };

function paginateCacheImpactRows(rows, state, signature) {
  const selectedRows = Array.isArray(rows) ? rows : [];
  if (state.signature !== signature) {
    state.signature = signature;
    state.page = 0;
  }
  const pageCount = Math.max(
    1,
    Math.ceil(selectedRows.length / CACHE_IMPACT_TABLE_PAGE_SIZE),
  );
  state.page = Math.min(Math.max(0, state.page), pageCount - 1);
  const start = state.page * CACHE_IMPACT_TABLE_PAGE_SIZE;
  const pageRows = selectedRows.slice(
    start,
    start + CACHE_IMPACT_TABLE_PAGE_SIZE,
  );
  return {
    rows: pageRows,
    start,
    end: start + pageRows.length,
    total: selectedRows.length,
    pageCount,
  };
}
// Last successful health read, kept separate from host presentation permissions.
let localCompanionHealth = null;
let localOnboarding = null;
let localReadinessPollTimer = null;
let localReadinessPollCount = 0;
// Accountless sharing is deliberately page-local presentation state. Durable
// choice, transition receipts, and transport authority stay in the companion.
let electronSharingPreference = null;
let electronSharingBusy = false;
let electronSharingNoticeAcked = new Set();
let electronSharingNoticeReceiptIndex = null;
let electronSharingNoticeAckScheduled = null;
let electronSharingNoticeAckCleanup = null;
let electronSharingNoticeAckError = false;
// The last refresh run's accounting-rebuild deferral, read from the local
// refresh status alongside each dashboard load. A rebuild that keeps missing
// its memory budget is otherwise invisible here: the refresh SUCCEEDS, the
// cache-derived figures simply never appear, and the 2026-08-19 livelock ran
// for hours behind that silence. Only a successful status read updates this,
// so a transient poll failure cannot clear an honest note.
let accountingRebuildDeferral = null;
// One-time history-index build (and a parser-version reparse) advances one
// bounded pass per foreground refresh. Left to the sparse auto-cadence, a
// full build crawls across many timer ticks with the machine idle between
// them, and — while a reparse deletes-then-re-derives — cost reads low until
// it completes. So a successful refresh that leaves the history index
// incomplete chains the next one promptly, bounded, until coverage catches
// up. Reset on a manual refresh or when coverage completes.
let reindexAutoContinuations = 0;
const REINDEX_AUTO_CONTINUE_LIMIT = 40;
const REINDEX_AUTO_CONTINUE_DELAY_MS = 1_500;
let reindexAutoContinueTimer = null;
let lastReindexProgressReceipt = null;
let localActionBusy = false;
// Overlapping primary reads share the original busy owner. Publication uses
// the same load token as quick reloads and cache-drop links below.
let activeLocalDashboardLoad = null;
let localRefreshInProgress = false;
let localRefreshCancelRequested = false;
// Archive indexing progress is intentionally transient: the durable dashboard
// continues to show only the last verified complete/partial coverage receipt.
// While a refresh owns a new pass, make that distinction visible beside cost
// rather than letting a previous complete receipt look current.
let archiveHistoryScanActive = false;
let returnRefreshScheduled = false;
let returnRefreshDeferrals = 0;
// Electron's main process owns the recurring cadence. The renderer lifecycle
// module keeps the accepted companion operation heartbeating without exposing
// its lease value to presentation state.
let electronRefreshLifecycleState = null;
let electronStartupRefreshTriggered = false;
// A qualified startup observer can release while the first local-dashboard
// load still owns the action lock. Keep that one launch pass pending until the
// owner clears the lock instead of treating its harmless early return as the
// completed Electron refresh.
let electronStartupRefreshDeferred = false;
let globalState = null;
let visibleConnectionNotice = null;
let dashboardUnavailableState = null;
let lastObservationPresentationStatus = null;

const $ = (selector) => document.querySelector(selector);
const { clear, node } = createDomHelpers(document);
const observationFreshnessClock = createObservationFreshnessClock({
  onTick(recency, source) {
    if (source !== dashboard) return;
    renderLiveObservationPresentation(source, recency);
    void refreshElectronCadenceHealth();
  },
});

// Product-owned legacy copy stays explicitly registered with the bounded
// migration bridge. Values originating in a local report, provider response,
// file, or user choice use the raw helpers instead, so localization can never
// reinterpret them just because they happen to equal an English UI label.
function setProductText(element, englishText) {
  if (!element) return;
  forgetLocalizedNode(element);
  element.removeAttribute("data-i18n-skip");
  localization.setLegacyText(element, englishText);
}

// Every node this page fills from a message key is remembered as it is
// written: the element, the key, and the values it was rendered with. A
// language change then re-runs the same translation over the same nodes.
//
// This deliberately replaces the previous hand-maintained list of renderers to
// call again after a switch. Text produced by `t(...)` is already in the old
// language, so the exact-text migration bridge cannot recover it — a status
// line whose renderer was missing from that list stayed frozen in the previous
// language forever. A registry cannot drift: a surface added later is covered
// the moment it writes its first localized string.
const localizedNodes = new Map();

function forgetLocalizedNode(element) {
  if (element) localizedNodes.delete(element);
}

function setRawText(element, value) {
  if (!element) return;
  forgetLocalizedNode(element);
  element.setAttribute("data-i18n-skip", "");
  element.textContent = value == null ? "" : String(value);
}

function setLocalizedText(element, key, values = {}) {
  if (!element) return;
  element.removeAttribute("data-i18n-skip");
  localizedNodes.set(element, { key, values, plural: null });
  element.textContent = t(key, values);
}

function setLocalizedPluralText(element, key, count, values = {}) {
  if (!element) return;
  element.removeAttribute("data-i18n-skip");
  localizedNodes.set(element, { key, values, plural: count });
  element.textContent = tPlural(key, count, values);
}

// A created element that carries localized copy, registered the same way.
function localizedNode(tag, className, key, values = {}) {
  const element = node(tag, className, "");
  setLocalizedText(element, key, values);
  return element;
}

function retranslateLocalizedNodes() {
  for (const [element, entry] of localizedNodes) {
    if (!element.isConnected) {
      localizedNodes.delete(element);
      continue;
    }
    const next = entry.plural === null
      ? t(entry.key, entry.values)
      : tPlural(entry.key, entry.plural, entry.values);
    if (element.textContent !== next) element.textContent = next;
  }
}

function rawNode(tag, className, value) {
  const element = node(tag, className, value == null ? "" : String(value));
  element.setAttribute("data-i18n-skip", "");
  return element;
}

function configuredSemanticOpenTarget(documentRef) {
  const target = documentRef
    .querySelector('meta[name="usage-monitor-semantic-open-target"]')
    ?.getAttribute("content")
    ?.trim();
  return target && /^[a-z][a-z0-9+.-]*:\/\/open$/iu.test(target)
    ? target
    : null;
}

const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget(document);
const installedAppLink = $("#open-installed-app");
if (SEMANTIC_OPEN_TARGET) {
  installedAppLink.href = SEMANTIC_OPEN_TARGET;
} else {
  installedAppLink.removeAttribute("href");
  installedAppLink.setAttribute("aria-disabled", "true");
}

// A language change redraws browser-generated values using the same display
// locale and leaves data, timestamps, and request ownership untouched. The
// native host dispatches the same event after its Settings picker changes, so
// the existing WebView is updated rather than reloaded.
function rerenderLocalizedDashboard() {
  // Register the current English-owned text before replacing any generated
  // values, then run the bridge once more afterwards. This prevents a previous
  // locale's nodes from surviving a switch back to English (or Spanish) in the
  // same WebView.
  localization.localizeTree();
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  // Charts write formatted instants and numbers straight into an
  // `data-i18n-skip` SVG text layer, so the evidence view is redrawn from the
  // state it was built from. This is a single state-driven redraw, not a list
  // of surfaces someone has to remember to extend.
  if (dashboard) {
    renderDashboard(dashboard);
  } else if (dashboardUnavailableState) {
    renderDashboardUnavailableState(dashboardUnavailableState);
  } else if (globalState) {
    renderGlobalState();
  }
  // Everything else — every status line, chip, and button label written from a
  // message key anywhere on this page — re-translates from the registry those
  // writes populate. Nothing has to be named here for it to be covered.
  retranslateLocalizedNodes();
  localization.localizeTree();
  renderElectronAccountlessCommunity();
  renderElectronSharingNotice();
}

window.addEventListener("tibotattle:locale-change", (event) => {
  setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
  setMessageLocale(event.detail?.locale ?? localization.locale());
  rerenderLocalizedDashboard();
});

function openInstalledApp() {
  const status = $("#open-installed-app-status");
  status.hidden = false;
  status.textContent =
    "Opening TiboTattle… If no app appears, install the signed Mac download above, then try again.";
  window.setTimeout(() => {
    if (!status.hidden) {
      status.textContent =
        "Continue in the TiboTattle in-app window. If nothing opened, the app is not installed or macOS blocked the link.";
    }
  }, 2_000);
}

function isLoopbackDashboard() {
  const host = String(window.location?.hostname ?? "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function setJourneyState(state) {
  const body = document.body;
  body.classList.remove("first-run", "needs-local-setup", "local-ready", "demo-mode");
  body.classList.add(state);
  // The installation journey belongs to the hosted first-visit page. If the
  // loopback dashboard loses its local service briefly, showing instructions
  // for installing the app inside the already-installed app is actively
  // misleading.
  $("#companion-setup").hidden = state !== "first-run" || isLoopbackDashboard();
  const hasEvidence = state === "local-ready" || state === "demo-mode";
  for (const element of document.querySelectorAll("[data-requires-evidence]")) {
    element.hidden = !hasEvidence;
  }
}

function localAnalysisAllowed(value = localOnboarding) {
  return Boolean(
    value
      && value.state === "ready"
      && (value.sessionsReadable || value.archivedSessionsReadable)
      && value.rolloutFilesPresent
      && value.stateWritable
      && value.explicitRefresh,
  );
}

function localAnalysisLabel() {
  if (dashboard?.collector?.indexing?.status === "bounded_pause") {
    return "Continue local analysis";
  }
  return dashboard?.activity?.lastScanAt || dashboard?.collector?.lastScanAt
    ? "Update local usage"
    : "Analyze local usage";
}

// Keep phase, count and elapsed time in stable slots across refresh updates.
function renderRefreshProgress(button, phase, { processed = null, selected = null, elapsedSeconds = null } = {}) {
  button.classList.add("refresh-progress");
  const label = node("span", "refresh-progress-phase", phase);
  const count = node("span", "refresh-progress-count");
  if (processed !== null && selected !== null) {
    const current = node("span", "refresh-progress-current", String(processed));
    current.style.minWidth = `${String(selected).length}ch`;
    count.append(current, document.createTextNode(`/${selected}`));
  }
  const elapsed = elapsedSeconds === null ? "" :
    `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const timer = node("span", "refresh-progress-time", elapsed);
  const description = [phase, count.textContent, elapsed].filter(Boolean).join(" · ");
  button.title = description;
  button.setAttribute("aria-label", description);
  button.replaceChildren(label, count, timer);
}

/**
 * Keep the elapsed display on wall-clock second boundaries instead of tying it
 * to the 750 ms companion-status poll. The self-correcting timeout deliberately
 * recalculates its next boundary after every callback: a delayed renderer may
 * skip a hidden second, but it does not accumulate drift or create a repeating
 * fast-fast-fast-slow beat.
 */
function startRefreshProgressClock(button, phase, options = {}) {
  let {
    processed = null,
    selected = null,
    startedAtMs = Date.now(),
    now = () => Date.now(),
    schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel = (timer) => window.clearTimeout(timer),
  } = options;
  let active = true;
  let timer = null;
  let currentPhase = phase;
  let currentProcessed = processed;
  let currentSelected = selected;

  const elapsedMilliseconds = () => Math.max(0, now() - startedAtMs);
  const paint = () => {
    renderRefreshProgress(button, currentPhase, {
      processed: currentProcessed,
      selected: currentSelected,
      elapsedSeconds: Math.floor(elapsedMilliseconds() / 1_000),
    });
  };
  const scheduleNextBoundary = () => {
    if (!active) return;
    const remainder = elapsedMilliseconds() % 1_000;
    const delayMs = remainder === 0 ? 1_000 : 1_000 - remainder;
    timer = schedule(tick, Math.max(1, Math.ceil(delayMs)));
  };
  function tick() {
    timer = null;
    if (!active) return;
    paint();
    scheduleNextBoundary();
  }

  paint();
  scheduleNextBoundary();
  return Object.freeze({
    update(nextPhase, { processed: nextProcessed = null, selected: nextSelected = null } = {}) {
      if (!active) return;
      currentPhase = nextPhase;
      currentProcessed = nextProcessed;
      currentSelected = nextSelected;
      paint();
    },
    reset(nextPhase, { processed: nextProcessed = null, selected: nextSelected = null } = {}) {
      if (!active) return;
      if (timer !== null) cancel(timer);
      timer = null;
      startedAtMs = now();
      currentPhase = nextPhase;
      currentProcessed = nextProcessed;
      currentSelected = nextSelected;
      paint();
      scheduleNextBoundary();
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  });
}

function updateLocalActionButtons() {
  const allowed = localAnalysisAllowed();
  const label = localAnalysisLabel();
  const refreshActive = localRefreshInProgress;
  for (const selector of ["#refresh-button", "#setup-refresh"]) {
    const button = $(selector);
    // A refresh owns both visible controls for its whole lifetime. The
    // progress renderer and cancel action are deliberately independent of the
    // primary load lock, because a terminal dashboard reload can release that
    // lock before the refresh's finalizer clears its own lifecycle state.
    button.disabled = localActionBusy || refreshActive || !allowed;
    if (refreshActive && !button.classList.contains("refresh-progress")) {
      // Recover a progress affordance if a nested dashboard render released
      // the primary load lock after the refresh began.
      renderRefreshProgress(button, "Update running…");
    }
    if (!localActionBusy && !refreshActive) {
      button.textContent = label;
      button.classList.remove("refresh-progress");
      button.removeAttribute("aria-label");
      button.removeAttribute("title");
    }
  }
  const setupCheck = $("#setup-check-again");
  if (setupCheck) setupCheck.disabled = localActionBusy;
  const companionCheck = $("#companion-check");
  if (companionCheck) companionCheck.disabled = localActionBusy;
  const connectionCheck = $("#connection-check");
  if (connectionCheck) connectionCheck.disabled = localActionBusy;
  const cancel = $("#cancel-refresh");
  cancel.hidden = !localRefreshInProgress;
  cancel.disabled = localRefreshCancelRequested;
  cancel.textContent = localRefreshCancelRequested ? "Cancelling…" : "Cancel";
}

let activeInformationPopover = null;
let nextInformationPopoverId = 1;
let suppressInformationPopoverFocus = false;

function positionInformationPopover(popover, button) {
  const anchor = button.getBoundingClientRect();
  const viewportPadding = 16;
  const preferredTop = anchor.bottom + 8;
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.min(
    Math.max(viewportPadding, anchor.left),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  );
  const top = preferredTop + height <= window.innerHeight - viewportPadding
    ? preferredTop
    : Math.max(viewportPadding, anchor.top - height - 8);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeInformationPopover({ restoreFocus = false } = {}) {
  const current = activeInformationPopover;
  if (!current) return;
  current.popover.remove();
  current.button.setAttribute("aria-expanded", "false");
  current.button.removeAttribute("aria-describedby");
  activeInformationPopover = null;
  if (restoreFocus && current.button.isConnected) {
    suppressInformationPopoverFocus = true;
    current.button.focus();
    suppressInformationPopoverFocus = false;
  }
}

function openInformationPopover(button, { pinned = false } = {}) {
  if (activeInformationPopover?.button === button) {
    activeInformationPopover.pinned ||= pinned;
    positionInformationPopover(activeInformationPopover.popover, button);
    return;
  }
  closeInformationPopover();
  const popover = node("span", "info-popover");
  const id = `information-popover-${nextInformationPopoverId++}`;
  popover.id = id;
  popover.setAttribute("role", "tooltip");
  popover.textContent = button.dataset.informationExplanation ?? "";
  document.body.append(popover);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", id);
  activeInformationPopover = { button, popover, pinned };
  positionInformationPopover(popover, button);
}

function informationLabel(label, explanation, accessibleLabel = label) {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(label));
  const button = node("button", "info-button", "i");
  button.type = "button";
  button.dataset.informationExplanation = explanation;
  button.setAttribute("aria-label", t("aria.moreInformation", {
    label: accessibleLabel,
  }));
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("mouseenter", () => openInformationPopover(button));
  button.addEventListener("mouseleave", () => {
    if (activeInformationPopover?.button === button
        && !activeInformationPopover.pinned
        && document.activeElement !== button)
      closeInformationPopover();
  });
  button.addEventListener("focus", () => {
    if (!suppressInformationPopoverFocus) openInformationPopover(button);
  });
  button.addEventListener("blur", () => {
    if (activeInformationPopover?.button === button
        && !activeInformationPopover.pinned)
      closeInformationPopover();
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeInformationPopover?.button === button
        && activeInformationPopover.pinned) {
      closeInformationPopover();
      return;
    }
    openInformationPopover(button, { pinned: true });
  });
  fragment.append(button);
  return fragment;
}

const COMPONENT_LABELS = Object.freeze({
  input_uncached_tokens: "Uncached input",
  input_cache_read_tokens: "Cached input",
  input_cache_write_tokens: "Cache writes",
  output_text_tokens: "Output text",
  output_reasoning_tokens: "Reasoning output",
  output_combined_tokens: "Output (split unavailable)"
});

function componentLabel(value) {
  return COMPONENT_LABELS[value] ?? humanize(value);
}

function setGlobalState(state, { companionReachable = false } = {}) {
  globalState = { companionReachable, state };
  renderGlobalState();
}

// The state pill said "Fresh" while the history index was one-third built,
// because quota observation freshness and index completeness are different
// facts. This badge states the second fact until it stops being true.
function renderHistoryIndexBadge(data) {
  const badge = $("#history-index-badge");
  if (!badge) return;
  const history = data?.pricing?.historyCoverage
    ?? data?.accounting?.historyCoverage
    ?? null;
  const indexed = finite(history?.indexedSourceCount, null);
  const total = finite(history?.sourceCount, null);
  const complete = history?.status === "complete"
    || (indexed !== null && total !== null && total > 0 && indexed >= total);
  const partialTerminal = history?.phase === "partial_terminal"
    || (history?.phase === "aggregate_unavailable"
      && finite(history?.skippedSourceCount, 0) > 0);
  if (data?.mode === "demo" || complete
      || indexed === null || total === null || total <= 0) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  setRawText(badge, partialTerminal
    ? t("status.historyPartial", {
      skipped: compact(history?.skippedSourceCount ?? 0),
    })
    : t("status.indexingHistory", {
      indexed: compact(indexed),
      total: compact(total),
    }));
}

function renderGlobalState() {
  if (!globalState) return;
  const keys = {
    live: "status.fresh",
    updating: "status.running",
    stale: "status.needsRefresh",
    insufficient: "status.moreDataNeeded",
    setup: "status.setUpMac",
    offline: globalState.companionReachable
      ? "status.readyToAnalyze"
      : "status.openMacApp",
    demo: "status.labeledDemoData",
  };
  const pill = $("#global-state");
  if (!pill) return;
  const state = localRefreshInProgress ? "updating" : globalState.state;
  pill.className = `state-pill state-${state}`;
  pill.replaceChildren(
    node("span", "state-dot"),
    document.createTextNode(t(keys[state] ?? "status.unknown")),
  );
}

function showConnectionNotice({
  title,
  titleKey = null,
  copy,
  copyKey = null,
  kind = "warning",
  showDemo = false,
  showCheck = false,
}) {
  visibleConnectionNotice = {
    copy,
    copyKey,
    kind,
    showCheck,
    showDemo,
    title,
    titleKey,
  };
  renderConnectionNotice();
}

function renderConnectionNotice() {
  if (!visibleConnectionNotice) return;
  const {
    copy,
    copyKey,
    kind,
    showCheck,
    showDemo,
    title,
    titleKey,
  } = visibleConnectionNotice;
  const notice = $("#connection-notice");
  notice.className = `notice notice-${kind}`;
  if (titleKey) {
    setLocalizedText($("#connection-title"), titleKey);
  } else {
    setProductText($("#connection-title"), title);
  }
  if (copyKey) {
    setLocalizedText($("#connection-copy"), copyKey);
  } else {
    setProductText($("#connection-copy"), copy);
  }
  $("#connection-check").hidden = !showCheck;
  $("#demo-button").hidden = !showDemo;
  notice.hidden = false;
}

function hideConnectionNotice() {
  visibleConnectionNotice = null;
  $("#connection-notice").hidden = true;
}

function electronSharingStateMessageKey(preference) {
  if (!preference?.available || !preference.current) {
    return "electron.sharing.state.unavailable";
  }
  if (preference.state === "pending_notices") {
    return "electron.sharing.state.pending";
  }
  if (preference.enabled && ["default_on", "migration_default_on"].includes(preference.basis)) {
    return "electron.sharing.state.defaultOn";
  }
  if (preference.enabled) return "electron.sharing.state.enabled";
  return preference.state === "legacy_preserved"
    ? "electron.sharing.state.legacy"
    : "electron.sharing.state.off";
}

function electronSharingTransportMessageKey(preference) {
  switch (preference?.transportStatus) {
    case "uploading": case "pending": case "up_to_date": case "retry_wait": case "paused": case "recovery_required":
      return `electron.sharing.transport.${preference.transportStatus}`;
    case "off":
      return "electron.sharing.transport.off";
    case "unavailable":
    default:
      return "electron.sharing.transport.unavailable";
  }
}

function clearElectronSharingNoticeAckSchedule() {
  const cleanup = electronSharingNoticeAckCleanup;
  electronSharingNoticeAckCleanup = null;
  electronSharingNoticeAckScheduled = null;
  cleanup?.();
}

function electronSharingSurfaceIsVisible() {
  if (document.visibilityState !== "visible") return false;
  const notice = $("#electron-sharing-notice");
  if (!notice || notice.hidden || notice.isConnected === false) return false;
  for (let element = notice; element; element = element.parentElement) {
    if (element.hidden || element.inert || element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
  }
  if (typeof notice.getBoundingClientRect !== "function") return false;
  const rectangle = notice.getBoundingClientRect();
  const viewportWidth = Number(globalThis.window?.innerWidth);
  const viewportHeight = Number(globalThis.window?.innerHeight);
  const left = Number(rectangle?.left);
  const right = Number(rectangle?.right);
  const top = Number(rectangle?.top);
  const bottom = Number(rectangle?.bottom);
  const width = Number(rectangle?.width ?? right - left);
  const height = Number(rectangle?.height ?? bottom - top);
  if (![viewportWidth, viewportHeight, left, right, top, bottom, width, height]
    .every(Number.isFinite)
    || viewportWidth <= 0 || viewportHeight <= 0 || width <= 0 || height <= 0) {
    return false;
  }
  const visibleWidth = Math.min(right, viewportWidth) - Math.max(left, 0);
  const visibleHeight = Math.min(bottom, viewportHeight) - Math.max(top, 0);
  const requiredWidth = Math.min(width, viewportWidth) / 2;
  const requiredHeight = Math.min(height, viewportHeight) / 2;
  return visibleWidth >= requiredWidth && visibleHeight >= requiredHeight;
}

function scheduleElectronSharingNoticeAck(index) {
  if (electronSharingNoticeAcked.has(index)
      || electronSharingNoticeAckScheduled === index) return;
  const bridge = electronSharingBridge();
  if (!bridge) return;
  electronSharingNoticeAckScheduled = index;
  let finished = false;
  let framePending = false;
  const removers = [];
  const listen = (target, type, handler) => {
    if (typeof target?.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener?.(type, handler));
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const remove of removers.splice(0)) remove();
    if (electronSharingNoticeAckCleanup === finish) {
      electronSharingNoticeAckCleanup = null;
      electronSharingNoticeAckScheduled = null;
    }
  };
  electronSharingNoticeAckCleanup = finish;
  const scheduleFrame = (callback) => {
    const raf = globalThis.window?.requestAnimationFrame;
    if (typeof raf === "function") {
      raf.call(globalThis.window, callback);
      return;
    }
    const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
    if (typeof schedule === "function") schedule(callback, 0);
  };
  const attempt = () => {
    if (finished || framePending) return;
    const preference = electronSharingPreference;
    if (!preference || preference.state !== "pending_notices"
        || preference.nextNoticeIndex !== index || !preference.noticeDue) {
      finish();
      return;
    }
    // A hidden Electron renderer can run JavaScript while its BrowserWindow is
    // backgrounded. Do not count a notice until the two-frame paint has landed
    // while the document is visible. Visibility/focus listeners retry it.
    if (!electronSharingSurfaceIsVisible()) return;
    framePending = true;
    scheduleFrame(() => scheduleFrame(async () => {
      framePending = false;
      if (finished || !electronSharingSurfaceIsVisible()) return;
      const current = electronSharingPreference;
      if (!current || current.state !== "pending_notices"
          || current.nextNoticeIndex !== index || !current.noticeDue) {
        finish();
        return;
      }
      electronSharingNoticeAckError = false;
      try {
        const result = await bridge.sharingNoticePresented(index);
        const next = normalizeElectronSharingPreference(result);
        if (next === null) throw new Error("Sharing notice response was invalid");
        electronSharingPreference = next;
        electronSharingNoticeAcked.add(index);
        electronSharingNoticeReceiptIndex = index;
        finish();
        renderElectronAccountlessCommunity();
        renderElectronSharingNotice();
      } catch {
        // Keep the visible notice and its retry listeners. A transient bridge
        // failure must not be turned into a false displayed receipt.
        electronSharingNoticeAckError = true;
        renderElectronSharingNotice();
      }
    }));
  };
  const retry = () => {
    if (electronSharingSurfaceIsVisible()) attempt();
  };
  listen(document, "visibilitychange", retry);
  listen(globalThis.window, "focus", retry);
  listen(globalThis.window, "hashchange", retry);
  listen(globalThis.window, "popstate", retry);
  listen(document, "scroll", retry);
  listen(globalThis.window, "scroll", retry);
  listen(globalThis.window, "resize", retry);
  attempt();
}

function renderElectronSharingNotice() {
  const notice = $("#electron-sharing-notice");
  if (!notice) return;
  const bridge = electronSharingBridge();
  const preference = electronSharingPreference;
  const receiptIndex = electronSharingNoticeReceiptIndex;
  const receiptStillCurrent = Number.isInteger(receiptIndex)
    && preference?.available === true
    && preference.current === true
    && preference.state === "pending_notices"
    && preference.noticeCount === receiptIndex
    && preference.nextNoticeIndex === (receiptIndex < 3 ? receiptIndex + 1 : null)
    && !(preference.noticeDue === true
      && preference.nextNoticeIndex === (receiptIndex < 3 ? receiptIndex + 1 : null));
  if (Number.isInteger(receiptIndex) && !receiptStillCurrent) {
    electronSharingNoticeReceiptIndex = null;
  }
  const heldIndex = receiptStillCurrent ? receiptIndex : null;
  const index = heldIndex ?? preference?.nextNoticeIndex;
  const projectedNoticeEligible = preference?.noticeDue === true
    && Number.isInteger(preference?.nextNoticeIndex)
    && preference.noticeCount === preference.nextNoticeIndex - 1;
  const eligible = bridge !== null
    && dashboard !== null
    && document.documentElement.dataset.localDashboardReady === "true"
    && preference?.available === true
    && preference.current === true
    && preference.state === "pending_notices"
    && Number.isInteger(index)
    && index >= 1 && index <= 3
    && (heldIndex !== null || projectedNoticeEligible);
  if (!eligible) {
    notice.hidden = true;
    clearElectronSharingNoticeAckSchedule();
    return;
  }
  notice.hidden = false;
  notice.dataset.noticeIndex = String(index);
  setLocalizedText(
    $("#electron-sharing-notice-copy"),
    "electron.sharing.notice.copy",
    { index },
  );
  const earliest = $("#electron-sharing-notice-earliest");
  if (earliest) {
    if (preference.earliestActivationAt) {
      setLocalizedText(
        earliest,
        "electron.sharing.notice.earliest",
        { date: formatLocal(preference.earliestActivationAt, { dateOnly: true }) },
      );
      earliest.hidden = false;
    } else {
      earliest.hidden = true;
    }
  }
  setLocalizedText(
    $("#electron-sharing-notice-transport"),
    electronSharingTransportMessageKey(preference),
  );
  const shareNow = $("#electron-sharing-share-now");
  const keepOff = $("#electron-sharing-keep-off");
  if (shareNow) shareNow.disabled = electronSharingBusy;
  if (keepOff) keepOff.disabled = electronSharingBusy;
  const status = $("#electron-sharing-notice-status");
  if (status) {
    status.hidden = !electronSharingNoticeAckError;
    if (electronSharingNoticeAckError) {
      setLocalizedText(status, "electron.sharing.notice.error");
    }
  }
  if (!electronSharingNoticeAckError) scheduleElectronSharingNoticeAck(index);
}

function renderElectronAccountlessCommunity() {
  const surface = $("#electron-accountless-community");
  if (!surface) return;
  const bridge = electronSharingBridge();
  if (!bridge) {
    surface.hidden = true;
    return;
  }
  surface.hidden = false;
  setLocalizedText(
    $("#electron-accountless-community-state"),
    electronSharingStateMessageKey(electronSharingPreference),
  );
  setLocalizedText(
    $("#electron-accountless-community-transport"),
    electronSharingTransportMessageKey(electronSharingPreference),
  );
  const enabled = $("#electron-accountless-sharing-enabled");
  const usable = electronSharingPreference?.available === true
    && electronSharingPreference.current === true;
  if (enabled) {
    enabled.checked = usable && electronSharingPreference.enabled === true;
    enabled.disabled = !usable || electronSharingBusy;
  }
  const error = $("#electron-accountless-sharing-error");
  if (error) error.hidden = !electronSharingNoticeAckError;
}

async function loadElectronSharingPreference({ dashboardReady = false } = {}) {
  const bridge = electronSharingBridge();
  if (!bridge || !dashboardReady || dashboard === null) {
    electronSharingPreference = null;
    electronSharingNoticeAckError = false;
    renderElectronAccountlessCommunity();
    renderElectronSharingNotice();
    return null;
  }
  try {
    const next = normalizeElectronSharingPreference(
      await bridge.getSharingPreference(),
    );
    electronSharingPreference = next;
    electronSharingNoticeAckError = false;
  } catch {
    electronSharingPreference = null;
    electronSharingNoticeAckError = false;
  }
  renderElectronAccountlessCommunity();
  renderElectronSharingNotice();
  return electronSharingPreference;
}

async function setElectronSharingEnabled(enabled) {
  if (typeof enabled !== "boolean" || electronSharingBusy) return false;
  const bridge = electronSharingBridge();
  if (!bridge) return false;
  electronSharingBusy = true;
  electronSharingNoticeAckError = false;
  renderElectronAccountlessCommunity();
  renderElectronSharingNotice();
  try {
    const next = normalizeElectronSharingPreference(
      await bridge.setSharingEnabled(enabled),
    );
    if (next === null) throw new Error("Sharing preference response was invalid");
    electronSharingPreference = next;
    renderElectronAccountlessCommunity();
    renderElectronSharingNotice();
    return true;
  } catch {
    electronSharingNoticeAckError = true;
    renderElectronSharingNotice();
    return false;
  } finally {
    electronSharingBusy = false;
    renderElectronAccountlessCommunity();
    renderElectronSharingNotice();
  }
}

function renderDashboardUnavailableState(kind) {
  // The last accounting rows remain visible during a failed refresh.
  resetCacheDropThreadLinks(cacheDropThreadLinks.dashboard);
  const companionCopy = isLoopbackDashboard()
    ? "dashboard.unavailable.companionInAppCopy"
    : "dashboard.unavailable.companionCopy";
  const variants = {
    "backend-only": {
      latestObservation: "dashboard.unavailable.backendOnlyOrigin",
      title: "dashboard.unavailable.backendOnlyTitle",
      copy: "dashboard.unavailable.backendOnlyCopy",
    },
    "dashboard-unavailable": {
      latestObservation: "dashboard.unavailable.companionUnavailable",
      title: "dashboard.unavailable.dashboardTitle",
      copy: "dashboard.unavailable.dashboardCopy",
    },
    "companion-unavailable": {
      latestObservation: "dashboard.unavailable.companionUnavailable",
      title: "dashboard.unavailable.companionTitle",
      copy: companionCopy,
    },
  };
  const selected = variants[kind] ?? variants["companion-unavailable"];
  dashboardUnavailableState = Object.hasOwn(variants, kind)
    ? kind
    : "companion-unavailable";
  setGlobalState("offline");
  setLocalizedText($("#latest-observation"), selected.latestObservation);
  setLocalizedText($("#data-source"), "dashboard.unavailable.noRealUsage");
  showConnectionNotice({
    titleKey: selected.title,
    copyKey: selected.copy,
    kind: "error",
    showDemo: true,
    showCheck: true,
  });
  renderDashboardSkeleton();
}

function onboardingSourceGuidance(value) {
  const customLocation = value.customCodexHomeConfigured
    ? "The custom Codex data location configured for this app"
    : "The usual Codex data folder";
  const guidance = {
    codex_home_missing: {
      title: value.customCodexHomeConfigured
        ? "The configured Codex location is missing"
        : "Open Codex once, then check again",
      summary: `${customLocation} was not found. ${
        value.customCodexHomeConfigured
          ? "Reopen the normal app build or restore the configured location, then check again."
          : "Open Codex, start or resume a task, and let one response finish."
      }`,
      check: `${customLocation} was not found`,
    },
    codex_home_unreadable: {
      title: "Allow local Codex access, then check again",
      summary: `${customLocation} exists but cannot be read. Quit TiboTattle, open System Settings → Privacy & Security → Files and Folders, allow TiboTattle if it is listed, then reopen the app.`,
      check: `${customLocation} cannot be read`,
    },
    session_directories_missing: {
      title: "Complete one Codex task, then check again",
      summary: "Codex is present but has not created a readable sessions folder. Start or resume a Codex task, let one response finish, then check again.",
      check: "No Codex sessions folder has been created yet",
    },
    session_directories_unreadable: {
      title: "Allow access to Codex sessions, then check again",
      summary: "Codex session folders exist but cannot be read. Quit TiboTattle, allow it under System Settings → Privacy & Security → Files and Folders if it is listed, then reopen the app.",
      check: "Codex session folders cannot be read",
    },
    no_rollout_files: {
      title: "Complete one Codex response, then check again",
      summary: "The Codex sessions folder is readable but contains no completed rollout yet. Start or resume a task and let one response finish.",
      check: "No completed local Codex task was detected",
    },
  };
  return guidance[value.sourceStatus] ?? {
    title: "Open Codex once, then check again",
    summary: "TiboTattle cannot find readable Codex session metadata yet. Open Codex, start or resume a task, and let one response finish.",
    check: "Codex session metadata is not ready",
  };
}

let reportingWindow = null;
let reportingAccountingPeriod = null;
const reportingPeriod = createReportingPeriod({
  onChange: () => {
    resetTimelineViewport();
    resetUsageTimelineViewport();
    timelineSeriesMemo = null;
    if (dashboard) {
      renderDashboard(dashboard);
      dashboardReportPreloader.schedule();
    } else renderReportingPeriod();
  },
});

function renderReportingPeriod(data = dashboard) {
  const selection = reportingSelection(data, reportingPeriod.period);
  reportingWindow = selection.window;
  reportingAccountingPeriod = selection.accountingPeriod;
  activeAccountingPeriod = reportingAccountingPeriod;
  activeUsageRangeDays = reportingDays(selection.period);
  activeCalibrationRangeDays = activeUsageRangeDays;
  activeWeeklyRangeDays = activeUsageRangeDays;
  if (data) {
    data.reportingWindow = reportingWindow;
    data.reportingAccountingPeriod = reportingAccountingPeriod;
  }
  for (const control of document.querySelectorAll("#reporting-period-controls button")) {
    const selected = control.dataset.period === selection.period;
    control.classList.toggle("active", selected);
    control.setAttribute("aria-pressed", String(selected));
  }
  const range = document.querySelector("#reporting-period-range");
  if (range) range.textContent = reportingWindow
    ? reportingWindow.startAt
      ? t("reporting.range", { start: formatLocal(reportingWindow.startAt), end: formatLocal(reportingWindow.endAt) })
      : t("reporting.allThrough", { end: formatLocal(reportingWindow.endAt) })
    : t("reporting.waiting");
  const rangeToggle = document.querySelector(".reporting-period-details > summary");
  if (rangeToggle && range) rangeToggle.title = range.textContent;
  workUsageView.setReportingWindow(reportingWindow);
  modelPerformance.setReportingWindow(reportingWindow);
}

function renderLocalOnboarding(value) {
  localOnboarding = value;
  const card = $("#setup-card");
  if (!card) return;
  if (runsInsideNativeDashboard()) {
    card.hidden = true;
    card.setAttribute("aria-hidden", "true");
    setJourneyState(
      dashboard?.mode === "demo"
        ? "demo-mode"
        : dashboard
          ? "local-ready"
          : value && value.state !== "unavailable"
            ? "needs-local-setup"
            : "first-run",
    );
    updateLocalActionButtons();
    return;
  }
  if (!value || value.state === "unavailable") {
    card.hidden = true;
    setJourneyState(
      dashboard?.mode === "demo"
        ? "demo-mode"
        : dashboard
          ? "local-ready"
          : "first-run",
    );
    updateLocalActionButtons();
    return;
  }
  const sourceReady = value.sourceStatus === "ready";
  const sourceAccessible = ["ready", "no_rollout_files"].includes(
    value.sourceStatus,
  );
  const sourceGuidance = onboardingSourceGuidance(value);
  const indexing = dashboard?.collector?.indexing ?? null;
  const boundedPause = indexing?.status === "bounded_pause";
  const ready = localAnalysisAllowed(value);
  card.hidden = false;
  card.removeAttribute("aria-hidden");
  card.classList.toggle("needs-attention", !ready);
  // Preserve a manual disclosure choice while readiness stays unchanged.
  const compactSetup = ready && !boundedPause && Boolean(dashboard);
  const setupMode = compactSetup ? "ready" : "attention";
  if (card.dataset.setupMode !== setupMode) card.open = !compactSetup;
  card.dataset.setupMode = setupMode;
  $("#setup-title").textContent = boundedPause
    ? "Continue your local analysis"
    : ready
      ? t("setup.title")
      : value.stateStatus === "unwritable" && sourceReady
        ? "Local app state needs attention"
        : sourceGuidance.title;
  $("#setup-ready-label").hidden = !ready || boundedPause;
  $("#setup-summary").textContent = boundedPause
    ? `A bounded pass completed safely: ${compact(indexing.filesProcessed)} of ${compact(indexing.filesSelected)} recent rollout files are analyzed. Continue when convenient; existing results remain usable.`
    : ready
      ? "Codex metadata and TiboTattle's private state are available. Raw logs remain inside the local companion."
    : value.stateStatus === "unwritable" && sourceReady
      ? "TiboTattle can read Codex metadata but cannot safely write its private app state. Quit and reopen the Mac app, then check again before attempting an analysis."
      : sourceGuidance.summary;

  const checks = $("#setup-checks");
  clear(checks);
  const items = [
    {
      ok: sourceAccessible,
      text: sourceAccessible
        ? "Codex session metadata is readable"
        : sourceGuidance.check
    },
    {
      ok: value.stateWritable,
      text: value.stateWritable
        ? "Private app state is writable"
        : "Quit and reopen TiboTattle"
    },
    {
      ok: value.rolloutFilesPresent,
      text: value.rolloutFilesPresent
        ? `${value.rolloutFilesObservedCapped ? `${compact(value.rolloutFilesObserved)}+` : compact(value.rolloutFilesObserved)} local rollout file${value.rolloutFilesObserved === 1 ? "" : "s"} detected`
        : "No completed local Codex task detected yet"
    }
  ];
  for (const item of items) {
    const row = node("li", item.ok ? "" : "missing", item.text);
    checks.append(row);
  }
  $("#setup-note").textContent = ready
    ? boundedPause
      ? "Continue when convenient. A useful headline is already available; later bounded updates are normally faster. Existing results remain visible, and every additional pass stays on this Mac."
      : "A useful headline often appears in seconds. The first deep pass can take a few minutes and later updates are normally faster. Work stops or checkpoints at a fixed bound; prompts, responses, commands, paths, and account identifiers never enter this page."
      : "After completing the action above, choose Check again. Checking does not analyze logs or upload anything.";
  if (!ready) setGlobalState("setup", { companionReachable: true });
  setJourneyState(ready ? "local-ready" : "needs-local-setup");
  updateLocalActionButtons();
}

function dashboardObservationPresentation(data, recency) {
  const observationStale = recency.status === "stale";
  const observationUnavailable = recency.status === "unknown";
  const observationNotCurrent = observationStale || observationUnavailable;
  const freshnessStatus = recency.status === "current"
    ? "live"
    : observationStale
      ? "stale"
      : observationUnavailable
        ? "insufficient"
        : data?.freshness?.status;
  return {
    ...data,
    state: observationNotCurrent && data?.state === "live"
      ? (observationStale ? "stale" : "insufficient")
      : data?.state,
    freshness: {
      ...data?.freshness,
      status: freshnessStatus,
      latestObservedAt: recency.latestObservedAt ?? data?.freshness?.latestObservedAt ?? null,
      ageSeconds: recency.ageSeconds,
      staleAfterSeconds: recency.staleAfterSeconds ?? data?.freshness?.staleAfterSeconds,
    },
    quotaWindows: observationNotCurrent
      ? (Array.isArray(data?.quotaWindows) ? data.quotaWindows : []).map((window) => ({
        ...window,
        status: window?.status === "live" ? "stale" : window?.status,
      }))
      : data?.quotaWindows,
  };
}

function renderObservationConnectionState(data, recency) {
  if (data.mode === "demo") {
    showConnectionNotice({
      title: "You are exploring a labeled demonstration",
      copy: "Every number on this page is illustrative. Open the Mac app and use the TiboTattle in-app window to see your own evidence.",
      kind: "demo",
      showCheck: true
    });
  } else if (data.state === "stale") {
    if (recency.status === "current" && data.freshness.accountingStatus === "stale") {
      showConnectionNotice({
        copyKey: "dashboard.stale.accountingCopy",
        kind: "warning",
        titleKey: "dashboard.stale.accountingTitle",
      });
    } else {
      showConnectionNotice({
        titleKey: "dashboard.stale.observationTitle",
        copyKey: "dashboard.stale.observationCopy",
        kind: "warning"
      });
    }
  } else if (data.state === "insufficient") {
    showConnectionNotice({
      title: "The companion is connected, but evidence is incomplete",
      copy: "Available measurements are shown below. Missing estimates remain blank rather than being filled with demo values.",
      kind: "warning",
      showCheck: true
    });
  } else {
    hideConnectionNotice();
  }
  $("#connection-notice").classList.toggle("notice-compact", data.state === "stale");
}

function renderLiveObservationPresentation(data, recency = observationRecency(data)) {
  const presentation = dashboardObservationPresentation(data, recency);
  const priorStatus = lastObservationPresentationStatus;
  lastObservationPresentationStatus = recency.status;
  const card = $(".freshness-card");
  card.dataset.freshness = recency.status;
  setLocalizedText(card.querySelector("span"), recency.status === "stale"
    ? "dashboard.freshness.stale" : "dashboard.freshness.observation");
  $("#latest-observation").textContent = recency.ageSeconds !== null
    ? formatAge(recency.ageSeconds)
    : "No timestamp";
  $("#data-source").textContent = data.mode === "demo"
    ? "Illustrative fixture — not your usage"
    : formatLocal(data.freshness.latestObservedAt);

  if (priorStatus !== recency.status) {
    setGlobalState(presentation.state, {
      companionReachable: data.mode !== "demo"
    });
    renderObservationConnectionState(presentation, recency);
    allowanceTankView?.dispose();
    renderQuotaCards(presentation);
    renderWeeklyPaceForecast(presentation);
    allowanceTankView = mountAllowanceTanks(
      $("#quota-cards"),
      $("#weekly-pace-forecast"),
      { t },
    );
  }
}

async function refreshElectronCadenceHealth() {
  const element = $("#automatic-refresh-health");
  if (!element) return;
  const bridge = runsInsideElectronDashboard() ? globalThis.tibotattleDesktop : null;
  if (localRefreshInProgress || typeof bridge?.getRefreshStatus !== "function") {
    element.hidden = true;
    return;
  }
  let status = null;
  try {
    status = await bridge.getRefreshStatus();
  } catch {
    status = null;
  }
  const leaseAwaitingRecovery = status?.schemaVersion === "tibotattle-desktop-refresh-status-v1"
    && status.activeLease === true
    && status.cadenceTimerArmed === false;
  if (!leaseAwaitingRecovery) {
    element.hidden = true;
    return;
  }
  setLocalizedText(element, electronRefreshLifecycleState?.reason === "settlement_failed"
    ? "dashboard.refresh.recovering"
    : "dashboard.refresh.waitingForRecovery");
  element.hidden = false;
}

function renderDashboard(data) {
  renderReportingPeriod(data);
  dashboardUnavailableState = null;
  dashboard = data;
  if (!isCacheDropThreadDashboard(data) || !data?.accounting?.cacheDiagnosticsSource
      || cacheDropThreadLinks.dashboard !== data
      || cacheDropThreadLinks.generation !== data?.accounting?.cacheDiagnosticsSource?.generation
      || cacheDropThreadLinks.generationFingerprint
        !== data?.accounting?.cacheDiagnosticsSource?.generationFingerprint) {
    resetCacheDropThreadLinks(data);
  }
  if (data.mode === "demo") {
    setJourneyState("demo-mode");
    $("#setup-card").hidden = true;
  }
  renderHistoryIndexBadge(data);
  const recency = observationRecency(data);
  lastObservationPresentationStatus = null;
  renderLiveObservationPresentation(data, recency);
  // The footer's "Dashboard contract" line is gone (owner-directed,
  // 2026-08-08): the version stays machine-discoverable on data.schemaVersion
  // and in the share card's text transcript, and was never a user fact.

  renderEvidenceWarnings(data);
  renderPricing(data);
  renderComparison(data);
  // The share card renders inside renderWeekly, from the same history model
  // as the chart it summarizes (owner-verified regression, 2026-08-08).
  renderUsageTimeline(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  observationFreshnessClock.update(data);
  // This optional lookup must never delay the native readiness marker or the
  // accounting render. Only the first-column cells are updated when it lands.
  void loadCacheDropThreadLinks(data);
}

let allowanceTankView = null;

function renderQuotaCards(data) {
  closeInformationPopover();
  const container = $("#quota-cards");
  clear(container);
  if ($("#allowance-context")) $("#allowance-context").hidden = true;
  const normalWindows = data.quotaWindows.filter(isPrimaryCodexQuotaWindow);
  const sparkWindows = data.quotaWindows.filter((window) => (
    isSparkQuotaLimitId(window?.limitId)
      && isValidQuotaWindowDuration(finite(window?.durationMinutes))
  ));
  const otherWindows = data.quotaWindows.filter((window) => (
    !isPrimaryCodexQuotaWindow(window)
      && !isSparkQuotaLimitId(window?.limitId)
      && isValidQuotaWindowDuration(finite(window?.durationMinutes))
  ));
  const primaryWindow = selectPrimaryCodexQuotaWindow(normalWindows);
  const normalOrderedWindows = primaryWindow === null
    ? normalWindows
    : [primaryWindow, ...normalWindows.filter((window) => window !== primaryWindow)];
  // Spark is a separate provider limit. Keep it out of the normal allowance
  // selection so it cannot be mistaken for the five-hour or seven-day track.
  // The forecast's primary pool leads the tanks. Within Spark, order by
  // duration rather than the provider's slot assignment. Future pools follow
  // both reviewed groups and never enter primary selection or calibration.
  const sparkOrderedWindows = [...sparkWindows].sort((left, right) => (
    finite(left.durationMinutes) - finite(right.durationMinutes)
  ));
  // Unknown pools stay out of both headline selection and calibration, but a
  // bounded local observation should not disappear. Technical ids only keep
  // separate future pools distinct; they are never rendered as copy.
  const otherOrderedWindows = [...otherWindows].sort((left, right) => (
    String(left.limitId).localeCompare(String(right.limitId))
      || finite(left.durationMinutes) - finite(right.durationMinutes)
      || String(left.slot).localeCompare(String(right.slot))
  ));
  const windows = [
    ...normalOrderedWindows,
    ...sparkOrderedWindows,
    ...otherOrderedWindows,
  ];
  if (!windows.length) {
    const card = node("article", "metric-card insufficient");
    const header = node("div", "metric-card-header");
    const name = node("span", "metric-name");
    setLocalizedText(name, "dashboard.quota.observations");
    const chip = node("span", "evidence-chip");
    setLocalizedText(chip, "dashboard.quota.insufficient");
    const value = node("strong", "metric-value", "—");
    const copy = node("p");
    setLocalizedText(copy, "dashboard.quota.noCurrent");
    header.append(name, chip);
    card.append(header, value, copy);
    container.append(card);
    return;
  }
  const context = $("#allowance-context");
  if (context) {
    context.textContent = data.mode === "demo" ? t("dashboard.quota.demo") : "";
    context.hidden = !context.textContent;
  }
  for (const window of windows) {
    const reportedRemaining = finite(window.remainingPercent);
    const remaining = reportedRemaining !== null
      && reportedRemaining >= 0 && reportedRemaining <= 100
      ? reportedRemaining : null;
    const spark = isSparkQuotaLimitId(window.limitId);
    const card = node("article", [
      "metric-card quota-tank",
      spark ? "quota-card-spark" : "",
      window.status === "stale" ? "stale" : "",
      remaining === null ? "insufficient" : "",
    ].filter(Boolean).join(" "));
    card.setAttribute("aria-label", spark
      ? `GPT-5.3 Codex Spark · ${localizedQuotaWindowDuration(window.durationMinutes)}`
      : localizedQuotaWindowLabel(window));
    card.dataset.shortWindow = String(window.durationMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES);
    card.dataset.remaining = remaining === null ? "" : String(remaining);
    card.dataset.forecastPool = String(isPrimaryCodexWeeklyQuotaWindow(window));
    card.dataset.resetAt = String(forecastTimestamp(window.resetAt) ?? "");
    card.dataset.stale = String(window.status === "stale");
    if (remaining !== null) {
      const fuel = node("div", "quota-tank-fuel");
      fuel.style.blockSize = `${remaining}%`;
      fuel.setAttribute("aria-hidden", "true");
      card.append(fuel);
    }
    const header = node("div", "quota-tank-header");
    const family = node("span", "quota-tank-family");
    if (spark) {
      family.className += " allowance-model-spark";
      family.append(modelThemeIcon(document, "spark"), node("span", "", "GPT-5.3 Codex Spark"));
    } else if (isPrimaryCodexQuotaWindow(window)) {
      const logo = node("img", "quota-codex-icon");
      logo.setAttribute("src", "./codex-color.svg");
      logo.setAttribute("alt", "");
      logo.setAttribute("aria-hidden", "true");
      family.append(logo, node("span", "", "Codex"));
    } else {
      family.textContent = window.limitName || t("dashboard.quota.windowOther");
    }
    header.append(family);
    header.append(node("span", "quota-tank-period",
      localizedQuotaWindowDuration(window.durationMinutes)));
    if (window.status === "stale") {
      header.append(node("span", "evidence-chip", t("allowance.stale")));
    }
    const bottom = node("div", "quota-tank-bottom");
    const amount = node("div");
    amount.append(node("strong", "quota-tank-value", remaining === null
      ? "—" : formatPercent(remaining, window.precision ?? 0)));
    amount.append(node("span", "quota-tank-caption", t(remaining === null
      ? "allowance.unknown" : "allowance.remaining")));
    const reset = node("div", "quota-tank-reset");
    const resetAt = forecastTimestamp(window.resetAt);
    const hoursLeft = resetAt === null ? null : (resetAt - Date.now()) / 3_600_000;
    reset.append(node("span", "", t(hoursLeft !== null && hoursLeft > 0
      ? "allowance.resetsIn" : resetAt !== null ? "allowance.resets" : "dashboard.quota.resetUnknown")));
    if (hoursLeft !== null && hoursLeft > 0) {
      reset.append(allowanceTimestamp(formatAllowanceDuration(hoursLeft), resetAt));
    } else if (resetAt !== null) {
      reset.append(allowanceTimestamp(t("allowance.resetPassed"), resetAt));
    }
    bottom.append(amount, reset);
    card.append(header, bottom);
    container.append(card);
  }
}

function providerReportedPlanEvidence(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate === "" || candidate.toLowerCase() === "unknown") return "";
  return t("dashboard.quota.providerPlan", { plan: candidate });
}

function localizedQuotaWindowDuration(durationMinutes) {
  const duration = finite(durationMinutes, null);
  if (!isValidQuotaWindowDuration(duration)) return "";
  if (duration % (24 * 60) === 0) {
    return tPlural("quota.durationDay", duration / (24 * 60));
  }
  if (duration % 60 === 0) {
    return tPlural("quota.durationHour", duration / 60);
  }
  return tPlural("quota.durationMinute", duration);
}

function localizedQuotaWindowLabel(window) {
  const duration = finite(window?.durationMinutes, null);
  if (isSparkQuotaLimitId(window?.limitId)) {
    // The provider re-introduced the 5-hour "Codex Spark" window on the Spark
    // limit (wire: codex_bengalfox, window_minutes 300) alongside the Spark
    // seven-day window, so the two Spark cards need distinct duration-named
    // titles. An unfamiliar Spark duration keeps the honest generic name.
    if (duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) {
      return t("dashboard.quota.windowSparkFiveHour");
    }
    if (duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
      return t("dashboard.quota.windowSparkSevenDay");
    }
    return t("dashboard.quota.windowSpark");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) {
    return t("dashboard.quota.windowFiveHour");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return t("dashboard.quota.windowSevenDay");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && isValidQuotaWindowDuration(duration)) {
    return t("dashboard.quota.windowProviderReported", {
      duration: localizedQuotaWindowDuration(duration),
    });
  }
  if (isValidQuotaWindowDuration(duration)) {
    const localizedDuration = localizedQuotaWindowDuration(duration);
    if (window?.limitName) {
      return t("dashboard.quota.windowNamedObserved", {
        name: window.limitName,
        duration: localizedDuration,
      });
    }
    return t("dashboard.quota.windowOtherDuration", {
      duration: localizedDuration,
    });
  }
  return t("dashboard.quota.windowOther");
}

function dashboardAccountingProjection(data) {
  return data?.accounting?.projection ?? {
    status: "available",
    reason: null,
    terminal: false,
  };
}

function accountingRequiresNewerBuild(data) {
  return dashboardAccountingProjection(data).reason
    === "local_unified_index_schema_newer";
}

function accountingIsUnavailable(data) {
  return dashboardAccountingProjection(data).status === "unavailable";
}

function projectionUnavailableCopyKey(data) {
  return accountingRequiresNewerBuild(data)
    ? "accounting.projection.newerBuild"
    : "accounting.projection.unavailable";
}

function renderPricing(data) {
  const selected = data.reportingWindow ? accountingPeriod(data) : null;
  if (data.reportingWindow && selected === null) {
    setRawText($("#cost-period"), t("reporting.unavailable"));
    $("#cost-total").textContent = "—";
    clear($("#cost-components"));
    $("#cost-components").append(node("p", "empty-inline", t("reporting.unavailable")));
    renderHistoryProgress(data);
    return;
  }
  const pricing = selected ? {
    ...data.pricing,
    periodLabel: t(`reporting.${data.reportingWindow.period}`),
    totalCostUsd: selected.apiPriceEquivalentUsd,
    quotaWeightedTotalCostUsd: selected.quotaWeightedApiPriceEquivalentUsd,
    fastMode: selected.fastMode,
    components: Object.entries(selected.componentCosts).map(([name, row]) => ({ name, ...row })),
  } : data.pricing;
  const projection = dashboardAccountingProjection(data);
  const retainedPeriod = projection.status === "retained"
    ? data.reportingWindow ? selected : staleAccountingServePeriod(data) ?? data.accounting
    : null;
  const retainedEvidence = retainedPeriod !== null
    && finite(retainedPeriod.apiPriceEquivalentUsd, 0) > 0;
  if (projection.status !== "available") {
    setLocalizedText(
      $("#cost-period"),
      retainedEvidence
        ? "accounting.projection.lastVerifiedPeriod"
        : "accounting.projection.periodUnavailable",
      retainedEvidence ? { period: retainedPeriod.periodLabel } : {},
    );
    setLocalizedText(
      $("#cost-metric-kicker"),
      retainedEvidence
        ? "accounting.projection.lastVerifiedMetric"
        : "accounting.projection.metricUnavailable",
    );
    $("#cost-metric-kicker").title = t(projectionUnavailableCopyKey(data));
    $("#cost-total").textContent = retainedEvidence
      ? formatApiMoney(retainedPeriod.apiPriceEquivalentUsd)
      : "—";
    renderHistoryProgress(data);
    const list = $("#cost-components");
    clear(list);
    list.append(node(
      "p",
      "empty-inline",
      t(retainedEvidence
        ? "accounting.projection.retainedComponents"
        : projectionUnavailableCopyKey(data)),
    ));
    return;
  }
  const fastMode = pricing.fastMode;
  setRawText($("#cost-period"), pricing.periodLabel);
  // The headline is the speed-priced figure whenever a weighting exists;
  // when nothing can be weighted legitimately the label falls back to the
  // Standard-rate name rather than presenting an unweighted number under a
  // weighted heading.
  const weighted = pricing.quotaWeightedTotalCostUsd;
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  setRawText($("#cost-metric-kicker"), useWeighted
    ? fastMode.metricLabel
    : fastMode.standardMetricLabel);
  $("#cost-metric-kicker").title = useWeighted
    ? fastMode.metricExplainer
    : t("dashboard.pricing.noWeightedTitle");
  $("#cost-total").textContent = formatMoney(
    useWeighted ? weighted : pricing.totalCostUsd,
    2
  );
  // Drawn above the early return for a period with no priced components: a
  // figure of nothing is exactly when a reader most needs to know how little
  // of their history is indexed. Calling it from here rather than from
  // `renderDashboard` also means the two points where an active archive pass
  // flips `archiveHistoryScanActive` and re-runs this renderer move the
  // progress statement with it.
  renderHistoryProgress(data);
  // The metadata line under the total ("100% coverage · stale replay-safe
  // cache · price registry … · History index complete") is gone
  // (owner-directed, 2026-08-10). Trace of its "stale replay-safe cache"
  // fragment: the companion called the cache stale from wall-clock age since
  // the last rebuild, while the refresh loop deliberately reuses the cache on
  // passes that add no rollout usage — so the label condemned totals that
  // covered every known usage record. The companion now derives staleness
  // against the newest exportable evidence (src/local-companion-data.js), and
  // the surviving honesty surfaces here are the history-progress block above,
  // the routed evidence warnings, and the share card's registry provenance.
  const list = $("#cost-components");
  clear(list);
  const components = pricing.components.filter(
    (row) => finite(row.costUsd, 0) > 0 || finite(row.tokens, 0) > 0
  );
  if (!components.length) {
    list.append(node("p", "empty-inline", t("dashboard.pricing.noComponents")));
    return;
  }
  const max = Math.max(...components.map((row) => row.costUsd ?? 0), .01);
  for (const component of components) {
    const row = node("div", "component-row");
    row.append(node("span", "", componentLabel(component.name)));
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(component.costUsd > 0 ? 1 : 0, ((component.costUsd ?? 0) / max) * 100)}%`;
    track.append(fill);
    row.append(
      track,
      node("strong", "", formatApiMoney(component.costUsd))
    );
    row.title = t("dashboard.pricing.tokens", { count: compact(component.tokens) });
    list.append(row);
  }
}

// Decimal steps, so the unit named here is the unit the companion counted in.
const BYTE_UNITS = Object.freeze([
  "byte",
  "kilobyte",
  "megabyte",
  "gigabyte",
  "terabyte",
]);

function formatBytes(value) {
  const number = finite(value);
  if (number === null || number < 0) return "—";
  let amount = number;
  let index = 0;
  while (amount >= 1_000 && index < BYTE_UNITS.length - 1) {
    amount /= 1_000;
    index += 1;
  }
  return formatNumber(amount, {
    style: "unit",
    unit: BYTE_UNITS[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  });
}

/**
 * How much of the discovered history the figures on this page are drawn from.
 *
 * Every number here is measured: the local companion publishes how many
 * sources it discovered and how many it has indexed, and the share is that
 * division. Nothing estimates a finish time, because none is known — a
 * progress bar that implied one would be the same invention this product
 * refuses everywhere else. The block is absent once both indexed history and
 * its accounting summary are available, or there is no measured denominator.
 *
 * It sits with the API-price-equivalent total because that total, and every
 * figure derived from it, covers only the indexed share.
 */
function renderHistoryProgress(data) {
  const container = $("#history-progress");
  if (!container) return;
  const history = data?.pricing?.historyCoverage
    ?? data?.accounting?.historyCoverage
    ?? null;
  const total = finite(history?.sourceCount, 0);
  const indexed = finite(history?.indexedSourceCount, 0);
  const partialTerminal = history?.phase === "partial_terminal";
  const aggregateUnavailable = history?.phase === "aggregate_unavailable";
  if (history === null || history.status === "complete" || total <= 0) {
    container.hidden = true;
    return false;
  }
  container.hidden = false;
  const percent = (indexed / total) * 100;
  const skippedSourceCount = finite(history?.skippedSourceCount, 0);
  const skippedSources = tPlural(
    "format.rolloutSourceCount",
    skippedSourceCount,
    { count: formatNumber(skippedSourceCount) },
  );
  if (aggregateUnavailable) {
    setLocalizedText(
      $("#history-progress-headline"),
      "dashboard.history.scanFinished",
    );
  } else if (partialTerminal) {
    setRawText(
      $("#history-progress-headline"),
      t("dashboard.history.partialHeadline", {
        sources: skippedSources,
      }),
    );
  } else {
    setLocalizedText(
      $("#history-progress-headline"),
      archiveHistoryScanActive
      ? "dashboard.history.indexingActive"
      : history.phase === "not_started"
        ? "dashboard.history.indexingNotStarted"
        : "dashboard.history.indexingPaused",
      { percent: formatPercent(percent, 1) },
    );
  }
  container.classList.toggle(
    "active", archiveHistoryScanActive && !aggregateUnavailable,
  );
  const track = $("#history-progress-track");
  track.setAttribute("aria-valuenow", String(Math.round(percent)));
  const coverageKey = partialTerminal
      || (aggregateUnavailable && skippedSourceCount > 0)
    ? "dashboard.history.partialSources"
    : aggregateUnavailable
      ? "dashboard.history.indexedSources"
      : "dashboard.history.indexingSources";
  const coverageValues = {
    bytesIndexed: formatBytes(history.indexedBytes),
    bytesTotal: formatBytes(history.sourceBytes),
    indexed: formatNumber(indexed),
    total: formatNumber(total),
    sources: skippedSources,
  };
  // The bar alone would announce a bare percentage. The counted sources are
  // the fact worth hearing, so they are what it reports.
  track.setAttribute("aria-valuetext", t(coverageKey, coverageValues));
  // A started-but-tiny index must still be visibly non-empty, or 2.7% reads as
  // "nothing has happened".
  $("#history-progress-fill").style.width =
    `${indexed > 0 ? Math.max(1.5, percent) : 0}%`;
  setLocalizedText($("#history-progress-detail"), coverageKey, coverageValues);
  if (aggregateUnavailable) {
    setLocalizedText(
      $("#history-progress-note"),
      "dashboard.history.summaryUnavailable",
    );
  } else if (partialTerminal) {
    const affectedThreads = finite(history?.skippedThreadCount, 0);
    setRawText(
      $("#history-progress-note"),
      tPlural("dashboard.history.partialNote", affectedThreads, {
        count: formatNumber(affectedThreads),
      }),
    );
  } else {
    setLocalizedText(
      $("#history-progress-note"),
      "dashboard.history.indexingResumes",
    );
  }
  return true;
}

/**
 * Statements the local companion published about the evidence behind a figure.
 *
 * The companion writes each one as a finished English sentence and publishes no
 * category alongside it. This page therefore decides only *where* a sentence
 * appears, never what it says: each string is written with `setRawText`, so it
 * reaches the document as text, unreworded and untruncated, and localization
 * cannot reinterpret it.
 *
 * Placement is matched on the vocabulary the companion itself assembles these
 * strings from. A sentence this build does not recognize is still shown — with
 * the observations at the top of the overview — rather than dropped.
 */
const EVIDENCE_WARNING_ROUTES = Object.freeze([
  // Anything about the history index qualifies the indexed-history totals,
  // which are the figures the accounting period selector can show.
  { pattern: /\bindex(?:ed|ing)\b/iu, selector: "#accounting-warnings" },
  // Anything about prices, cost, or the accounting cache qualifies the
  // API-price-equivalent figure the overview headlines.
  {
    pattern: /\b(?:accounting|cost|price|prices|priced|pricing|unpriced)\b/iu,
    selector: "#cost-warnings",
  },
]);
const EVIDENCE_WARNING_FALLBACK = "#evidence-warnings";
// Coverage that is still growing is progress, not a failure. A caveat on a
// figure that is already being shown is not progress, and must not be dressed
// as it.
const EVIDENCE_WARNING_PROGRESS =
  /\b(?:advance|advances|advancing|expand|expands|still)\b/iu;
// A load already in flight, and tracking that simply started fresh, are
// information, not faults: the sentence names its own resolution. These share
// the quiet blue treatment, so the alert color is reserved for caveats on
// figures that are actually degraded (owner-directed, 2026-08-19: degraded
// notes read as errors in dogfood). Deliberately absent: the withheld-cache
// sentences and their vocabulary — that state is being replaced wholesale by
// serve-stale-while-recalculating, and its rendering is owned there.
const EVIDENCE_WARNING_INFORMATIONAL =
  /\b(?:loading|started fresh|limited history coverage)\b/iu;

function evidenceWarningTarget(message) {
  return EVIDENCE_WARNING_ROUTES
    .find((route) => route.pattern.test(message))
    ?.selector ?? EVIDENCE_WARNING_FALLBACK;
}

function renderEvidenceWarnings(data) {
  const grouped = new Map([
    ...EVIDENCE_WARNING_ROUTES.map((route) => [route.selector, []]),
    [EVIDENCE_WARNING_FALLBACK, []],
  ]);
  for (const message of Array.isArray(data?.warnings) ? data.warnings : []) {
    if (typeof message !== "string" || message === "") continue;
    if (/^Quota tracking started fresh on this Mac, so its retained records begin /u.test(message)) continue;
    grouped.get(evidenceWarningTarget(message)).push(message);
  }
  for (const [selector, messages] of grouped) {
    const list = $(selector);
    if (!list) continue;
    clear(list);
    // Nothing published means nothing rendered: no empty container and no
    // "no warnings" state.
    list.hidden = messages.length === 0;
    for (const message of messages) {
      const item = node("li", EVIDENCE_WARNING_PROGRESS.test(message)
        ? "evidence-warning progress"
        : EVIDENCE_WARNING_INFORMATIONAL.test(message)
          ? "evidence-warning informational"
          : "evidence-warning");
      setRawText(item, message);
      list.append(item);
    }
  }
}

function humanize(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function matchedRollingPairs(data) {
  if (allowanceTimelineUsage(data).length) {
    return liveTimelinePoints(data, {
      windowHours: CALIBRATION_WINDOW_HOURS,
      rangeDays: activeUsageRangeDays,
    })
      .filter((row) => row.observed !== null && row.expected !== null);
  }
  // Retained gradient artifacts are Standard-priced. They remain historical
  // diagnostics, but cannot supply an allowance comparison without the
  // bucket-level speed evidence needed to match the numerator and capacity.
  return [];
}

function allowanceTimelineUsage(data) {
  return data.allowancePlanSelection
    ? data.timeline?.selectedPlanUsage ?? []
    : data.timeline?.usage ?? [];
}

function renderComparison(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  const planNote = $("#comparison-plan-note");
  if (planNote) {
    planNote.hidden = data.allowancePlanSelection?.comparisonAvailable !== true;
    if (!planNote.hidden) setLocalizedText(planNote,
      "weekly.plan.comparisonConditional",
      { plan: shareCardPlanLabel(data.weekly.planType) || t("weekly.plan.unknown") });
  }
  // The observed-versus-calculated comparison depends on the calibration
  // capacity; when that capacity is served from the previous version's cache
  // during a recalculation, the comparison says so, quietly.
  renderStaleServeNote(
    $("#comparison-stale-note"),
    data?.timeline?.allowanceCapacity?.stale?.stale === true,
  );
  const matchedPairs = matchedRollingPairs(data);
  const pair = matchedPairs.at(-1) ?? null;
  const summary = data.gradient.summary ?? {};
  const weeklySummary = data.weekly.summary ?? {};
  const legacyDemo = data.mode === "demo" && !data.allowancePlanSelection;
  const mae = matchedPairs.length > 0
    ? matchedPairs.reduce(
      (sum, row) => sum + Math.abs(row.observed - row.expected),
      0,
    ) / matchedPairs.length
    : legacyDemo
      ? finite(summary.mean_absolute_error_pp ?? summary.meanAbsoluteErrorPp)
      : null;
  const within = legacyDemo
    ? finite(
      summary.points_within_80_band_fraction
        ?? summary.pointsWithin80BandFraction,
    )
    : null;
  // The weekly estimator is the canonical fitted-rate source. The
  // composition-aware blended rate (cost-weighted over the recent model mix)
  // is preferred when the v0.7 cache fitted one; the across-reset median is
  // the fallback, and older gradient artifacts remain a compatibility
  // fallback for old demo payloads.
  const capacity = finite(
    weeklySummary.blended_capacity_usd
      ?? weeklySummary.median_weekly_value_usd
      ?? weeklySummary.medianWeeklyValueUsd
      ?? (legacyDemo ? summary.capacity_usd ?? summary.capacityUsd : null),
  );
  const capacityByModel = weeklySummary.capacity_by_model
      && typeof weeklySummary.capacity_by_model === "object"
      && !Array.isArray(weeklySummary.capacity_by_model)
    ? weeklySummary.capacity_by_model
    : null;
  // The fitted mix behind that vector, so the disclosure can name the models
  // that consumed the allowance without earning a column of their own.
  const modelCostShares = weeklySummary.model_cost_shares
      && typeof weeklySummary.model_cost_shares === "object"
      && !Array.isArray(weeklySummary.model_cost_shares)
    ? weeklySummary.model_cost_shares
    : null;
  const lower = finite(
    weeklySummary.lower_80_across_resets_usd
      ?? weeklySummary.lower80Usd
      ?? (legacyDemo ? summary.lower_80_usd ?? summary.lower80Usd : null),
  );
  const upper = finite(
    weeklySummary.upper_80_across_resets_usd
      ?? weeklySummary.upper80Usd
      ?? (legacyDemo ? summary.upper_80_usd ?? summary.upper80Usd : null),
  );
  const qualifyingResets = finite(
    weeklySummary.qualifying_resets ?? weeklySummary.qualifyingResets,
    0,
  );
  const chip = $("#fit-chip");
  renderCalibrationRate({
    capacity,
    lower,
    upper,
    qualifyingResets,
    capacityByModel,
    modelCostShares,
  });
  if (!pair || pair.observed === null || pair.expected === null) {
    // A new population must not retain the previous plan's visible bars.
    for (const row of $("#comparison-visual").querySelectorAll(".comparison-row")) {
      row.querySelector("i").style.width = "0%";
      row.querySelector("strong").textContent = "—";
    }
    setProductText(chip, "Insufficient");
    if (data.allowancePlanSelection?.comparisonAvailable === false) {
      setLocalizedText($("#comparison-result"), "weekly.plan.comparisonPending");
    } else {
      setProductText(
        $("#comparison-result"),
        "There is not yet a matched quota-and-cost window to compare.",
      );
    }
    return;
  }
  const max = Math.max(Math.abs(pair.observed), Math.abs(pair.expected), 1);
  const rows = $("#comparison-visual").querySelectorAll(".comparison-row");
  const values = [pair.observed, pair.expected];
  rows.forEach((row, index) => {
    row.querySelector("i").style.width = `${Math.min(100, Math.abs(values[index]) / max * 100)}%`;
    row.querySelector("strong").textContent = formatPp(values[index]);
  });
  const residual = pair.residual ?? pair.observed - pair.expected;
  chip.textContent = mae === null
    ? t("dashboard.comparison.matchedWindow")
    : t("dashboard.comparison.mae", { value: formatDecimal(mae, 1) });
  const latestMovement = t("dashboard.comparison.latestMovement", {
    residual: formatPp(Math.abs(residual)),
  });
  const seriesBand = within === null
    ? ""
    : ` ${t("dashboard.comparison.seriesBand", {
      percent: formatPercent(within * 100),
    })}`;
  $("#comparison-result").textContent = latestMovement + seriesBand;
}

// Owner-directed restyle (2026-08-10): the fitted-rate facts render as a
// compact stat row. Each tile holds the bare figure; its unit lives in the
// fixed label beneath it, and the sentence-length "example translation" moved
// into the prose below the stats — it is a sentence, not a datum.
function renderCalibrationRate({
  capacity,
  lower,
  upper,
  qualifyingResets = 0,
  capacityByModel = null,
  modelCostShares = null,
}) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
  renderCalibrationModelRates(capacityByModel, modelCostShares);
  if (capacity === null || capacity <= 0) {
    setProductText(rate, "Not estimable");
    setProductText(range, "Not estimable");
    if (example) example.hidden = true;
    setLocalizedText(explanation, "dashboard.calibration.noRate");
    return;
  }
  const perPoint = capacity / 100;
  const movementForHundred = 10_000 / capacity;
  const hasRange = lower !== null && lower > 0 && upper !== null && upper > 0;
  setRawText(rate, formatMoney(perPoint, 2));
  if (hasRange) {
    setRawText(
      range,
      `${formatMoney(lower / 100, 2)}–${formatMoney(upper / 100, 2)}`,
    );
  } else {
    setLocalizedText(range, "dashboard.calibration.rangeUnavailable");
  }
  if (example) example.hidden = false;
  setLocalizedText(example, "dashboard.calibration.example", {
    points: formatDecimal(movementForHundred, 1),
  });
  if (hasRange) {
    setLocalizedText(explanation, "dashboard.calibration.withRange", {
      count: Math.max(1, Math.round(qualifyingResets)),
      amount: formatMoney(capacity, 0),
      lower: formatMoney(lower, 0),
      upper: formatMoney(upper, 0),
    });
  } else {
    setLocalizedText(explanation, "dashboard.calibration.withoutRange", {
      amount: formatMoney(capacity, 0),
    });
  }
}

// Mirrors `MODEL_COMPOSITION_POLICY.otherModelKey` in the composition kernel:
// the column every model under the share floor is folded into. It is a rate,
// not a model, so it is never listed as one.
const COMPOSITION_OTHER_MODEL_KEY = "other";

// One row of the per-model disclosure: the model's display name, an optional
// qualifier explaining why it has no fitted rate of its own, and the rate the
// fit charges it.
function calibrationModelRow(model, perPointUsd, qualifier) {
  const item = node("li", "");
  const label = node("span", "calibration-model-label");
  const name = node("span", "");
  // Model identifiers arrive from the local companion payload; the formatter
  // maps only reviewed fragments and never echoes free text.
  setRawText(name, formatModelName(model));
  label.append(name);
  if (qualifier) {
    label.append(localizedNode("small", "", qualifier.key, qualifier.values));
  }
  const perPoint = node("strong", "");
  if (perPointUsd === null) {
    setLocalizedText(perPoint, "dashboard.calibration.perModelRateUnavailable");
  } else {
    setLocalizedText(perPoint, "dashboard.calibration.perModelRate", {
      amount: formatMoney(perPointUsd, 2),
    });
  }
  item.append(label, perPoint);
  return item;
}

// The per-model disclosure under the blended headline (owner decision
// 2026-08-10: blended "$X per point" stays the headline; per-model detail on
// expand).
//
// The rates the NNLS fit resolved lead the list. Under them come the models
// the fit saw but could not price on their own — anything below the kernel's
// share floor is folded into the pooled remainder column, which is exactly
// how their cost is priced downstream. Listing only the resolved rates read as
// if the missing models had never been used at all, which is the one thing
// this card must not imply about real usage. With no resolved rate the whole
// disclosure still stays hidden: there is no per-model detail to disclose.
function renderCalibrationModelRates(capacityByModel, modelCostShares) {
  const details = $("#calibration-models");
  const list = $("#calibration-model-list");
  const sharedNote = $("#calibration-model-shared");
  if (!details || !list) return;
  const vector = capacityByModel && typeof capacityByModel === "object"
      && !Array.isArray(capacityByModel)
    ? capacityByModel
    : {};
  const fittedRate = (model) => (
    model !== COMPOSITION_OTHER_MODEL_KEY
      && Number.isFinite(vector[model])
      && vector[model] > 0
      ? vector[model]
      : null
  );
  const rows = Object.keys(vector)
    .filter((model) => typeof model === "string" && fittedRate(model) !== null)
    .sort((left, right) => fittedRate(right) - fittedRate(left));
  const pooled = Number.isFinite(vector[COMPOSITION_OTHER_MODEL_KEY])
      && vector[COMPOSITION_OTHER_MODEL_KEY] > 0
    ? vector[COMPOSITION_OTHER_MODEL_KEY]
    : null;
  const shares = modelCostShares && typeof modelCostShares === "object"
      && !Array.isArray(modelCostShares)
    ? modelCostShares
    : {};
  const shared = Object.entries(shares)
    .filter(([model, share]) => typeof model === "string"
      && model !== COMPOSITION_OTHER_MODEL_KEY
      && fittedRate(model) === null
      && Number.isFinite(share)
      && share > 0)
    .sort(([, left], [, right]) => right - left);
  list.textContent = "";
  if (sharedNote) sharedNote.hidden = true;
  if (rows.length === 0) {
    details.hidden = true;
    details.open = false;
    return;
  }
  for (const model of rows) {
    list.append(calibrationModelRow(model, fittedRate(model) / 100, null));
  }
  for (const [model, share] of shared) {
    list.append(calibrationModelRow(
      model,
      pooled === null ? null : pooled / 100,
      {
        key: pooled === null
          ? "dashboard.calibration.perModelNoRate"
          : "dashboard.calibration.perModelShared",
        values: { share: formatPercent(share * 100, 1) },
      },
    ));
  }
  if (sharedNote && shared.length > 0) {
    setLocalizedText(sharedNote, "dashboard.calibration.perModelSharedExplainer", {
      threshold: formatPercent(COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT),
    });
    sharedNote.hidden = false;
  }
  details.hidden = false;
}

// ---------------------------------------------------------------------------
// Shareable results card
//
// This is the strictest surface on the page: the user may post the result in
// public, so the card may carry only figures this dashboard already derived
// plus fixed copy written here. Nothing that reaches the browser as free-form
// text is ever echoed onto it. A quota window's label, a plan name and a
// period name all arrive as unconstrained strings, so each is recomputed from
// a structural field or matched against a fixed vocabulary first; the version
// identifiers are accepted only in an identifier shape that cannot hold a
// path, a sentence, or a quoted value. The traceable identifier reuses the
// diagnostic-reference idiom rather than a parallel scheme: fresh WebCrypto
// randomness, never derived from a participant id, an account, a hostname, a
// figure, or a timestamp.
// ---------------------------------------------------------------------------

const SHARE_CARD_WIDTH = 1200;
// 3:2. Three figures, the history behind them, every qualification that
// applies and the identifier line do not fit in 16:9 at a size a feed can
// still resolve, and shrinking the type was the wrong lever: the smallest
// copy is already the first thing to break when a timeline scales the image.
const SHARE_CARD_HEIGHT = 800;
// Drawn at twice the posted size so the text stays clean after a feed
// resamples it, and legible once a timeline scales it down.
const SHARE_CARD_PIXEL_SCALE = 2;
// A shared image is read at a glance. Keep only the two qualifications that
// materially change how a reader should compare its headline figures.
const SHARE_CARD_MAX_CAVEATS = 2;
const SHARE_CARD_MAX_CAVEAT_LINES = 2;
// One type size for all three figures, reduced until the longest of them fits
// its column. A figure is never cut off: "Not estimable" and a seven-figure
// total both overrun the column at the full size, and an ellipsis in the
// largest type on the card is unreadable and easy to misread.
const SHARE_CARD_VALUE_SIZE = 54;
const SHARE_CARD_VALUE_MIN_SIZE = 34;
// The plot has 94 px of fixed axis padding, so anything shorter cannot carry
// an honest chart. This lower bound prevents a caveat from collapsing the
// evidence region into a zero-height plot.
const SHARE_CARD_TREND_MIN_HEIGHT = 168;
// The chart is the evidence on the image, not decorative garnish. Reserve a
// meaningful vertical lane for it instead of compressing it below three cards
// and a verbose footer. Raised 420 → 472 (owner-directed, 2026-08-08): the
// identifier footer and its rule are gone from the image, and every one of
// those reclaimed pixels belongs to the plot.
const SHARE_CARD_TREND_MAX_HEIGHT = 472;
// Identifier-shaped only, exactly as a diagnostic code is: no space, no
// slash, no separator that could carry a path or a folder name.
const SHARE_CARD_REGISTRY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;
const SHARE_CARD_APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SHARE_CARD_HOME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;
// The exact period names this product emits, each mapped to an owned message
// key. An unrecognized source value is replaced rather than printed, so a
// renamed or injected label can never reach a shared card.
const SHARE_CARD_PERIOD_KEYS = new Map([
  ["All retained evidence", "share.period.allRetained"],
  ["Cached 31-day window", "share.period.cachedThirtyOneDay"],
  ["Cached 31-day collector window", "share.period.cachedThirtyOneDayCollector"],
  ["Last 24 hours", "share.period.lastDay"],
  ["Last 30 days", "share.period.lastThirtyDays"],
  ["Last 7 days", "share.period.lastSevenDays"],
  ["Recorded period", "share.period.recorded"],
]);
// Fixed window names, keyed on the observed window duration rather than on the
// companion's own label field.
const SHARE_CARD_WINDOW_KEYS = Object.freeze({
  five_hour: "share.window.fiveHour",
  other: "share.window.other",
  seven_day: "share.window.sevenDay",
});
// The friendly name the card prints for a reported Codex plan. The keys are
// Codex's own KnownPlan vocabulary (TELEMETRY_PLAN_TYPES) verbatim. Product
// labels state the configured personal-plan ratios independently of upstream
// display aliases; the Pro rename does not alter the recorded plan identity.
// Plans without a configured ratio are named without a fabricated number.
// "unknown" is Codex's sentinel for an unnamed plan and is deliberately
// absent, so it — like any unmapped or empty reading — draws no chip.
const SHARE_CARD_PLAN_LABELS = Object.freeze({
  ...TELEMETRY_PLAN_DISPLAY_NAMES,
  pro: "Pro (10×)",
  prolite: "Pro Lite (5×)",
  promax: "Pro Max 25×",
  self_serve_business_prolite: "Business · Pro Lite (5×)",
  self_serve_business_usage_based: "Business · usage-based",
  enterprise_cbp_automation: "Enterprise · automation",
  enterprise_cbp_usage_based: "Enterprise · usage-based",
});

/**
 * The display label for one reported plan_type, or "" when nothing nameable
 * was reported. Only the bounded KnownPlan enum reaches a label: "unknown",
 * an empty reading, and any value outside the map all resolve to "", so the
 * card prints no plan chip rather than an invented label.
 */
function shareCardPlanLabel(planType) {
  const candidate = typeof planType === "string" ? planType.trim() : "";
  return TELEMETRY_PLAN_TYPES.includes(candidate)
    && Object.hasOwn(SHARE_CARD_PLAN_LABELS, candidate)
    ? SHARE_CARD_PLAN_LABELS[candidate]
    : "";
}

/**
 * The reader's most-recently-observed plan, as a display label.
 *
 * Reads only the bounded plan_type enum and the observation time the card
 * already holds on each quota window. A window with no parseable time sorts
 * as the oldest, so a timestamped reading always wins recency. "" is
 * returned when no window names a plan, and the card then omits the chip.
 */
function shareCardPlan(windows) {
  let label = "";
  let newest = -Infinity;
  for (const observation of Array.isArray(windows) ? windows : []) {
    const candidate = shareCardPlanLabel(observation.planType);
    if (candidate === "") continue;
    const at = finite(Date.parse(observation.observedAt), -Infinity);
    if (at < newest) continue;
    label = candidate;
    newest = at;
  }
  return label;
}
let shareCard = null;
let shareCardReference = "";
let shareCardSignature = "";
let shareCardBusy = false;
// The posted image uses the same bundled mark as the dashboard and macOS app.
// If it loads after a card has been drawn, repaint the existing card rather
// than leaving an approximated logo in the image.
const shareCardBrandImage = new Image();
shareCardBrandImage.addEventListener("load", () => {
  if (shareCard !== null) drawShareCard($("#share-card-canvas"), shareCard);
});
shareCardBrandImage.src = "./tibotattle-icon.png";

function shareCardRegistryVersion(candidate) {
  return typeof candidate === "string"
    && SHARE_CARD_REGISTRY_VERSION_PATTERN.test(candidate)
    ? candidate
    : "";
}

function configuredAppVersion() {
  const value = document
    .querySelector('meta[name="usage-monitor-app-version"]')
    ?.getAttribute("content")
    ?.trim();
  return SHARE_CARD_APP_VERSION_PATTERN.test(value ?? "") ? value : "";
}

/**
 * The home a shared card prints.
 *
 * A release build fills its own canonical slot, and that wins; otherwise the
 * fixed home declared in the page is used. Only the host is printed, so no
 * path, query, or fragment from either source can reach the image.
 */
function shareCardHome() {
  const declared = document
    .querySelector('meta[name="usage-monitor-share-home"]')
    ?.getAttribute("content")
    ?.trim()
    ?.toLowerCase() ?? "";
  const fallback = SHARE_CARD_HOME_PATTERN.test(declared) ? declared : "";
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href")
    ?.trim();
  if (!canonical) return fallback;
  try {
    const host = new URL(canonical).hostname.replace(/^www\./u, "");
    return SHARE_CARD_HOME_PATTERN.test(host) ? host : fallback;
  } catch {
    return fallback;
  }
}

function shareCardWindowKind(window) {
  if (!isPrimaryCodexQuotaWindow(window)) return "other";
  const minutes = finite(window?.durationMinutes);
  if (minutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) return "seven_day";
  if (minutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) return "five_hour";
  return "other";
}

/**
 * Choose the one allowance window the card reports.
 *
 * The selected normal Codex window is the card's allowance denominator. A
 * provider-reported duration is never silently replaced with a shorter named
 * window: seven-day reset history and its estimate stay absent unless the
 * selected window is genuinely seven days.
 */
function shareCardWindow(windows) {
  const observed = (Array.isArray(windows) ? windows : [])
    .filter((window) => (
      isPrimaryCodexQuotaWindow(window)
      && finite(window?.remainingPercent) !== null
    ));
  const selected = selectPrimaryCodexQuotaWindow(observed);
  return selected;
}

function shareCardPeriodLabel(candidate) {
  return t(SHARE_CARD_PERIOD_KEYS.get(candidate) ?? "share.period.recorded");
}

function shareCardWindowLabel(window) {
  const kind = shareCardWindowKind(window);
  if (kind !== "other") {
    return t(SHARE_CARD_WINDOW_KEYS[kind]);
  }
  const duration = localizedQuotaWindowDuration(window?.durationMinutes);
  return duration === ""
    ? t(SHARE_CARD_WINDOW_KEYS.other)
    : t("share.window.providerReportedDuration", { duration });
}

/**
 * A date-only label for a derived reset estimate or the latest observation.
 * The card deliberately omits a time of day and any raw-log timestamp.
 */
function shareCardDateLabel(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(getFormattingLocale(), {
    ...(USER_TIME_ZONE === "local time" ? {} : { timeZone: USER_TIME_ZONE }),
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

function shareCardHeadlineDate(data, history) {
  const latestObservedAt = Date.parse(data?.freshness?.latestObservedAt ?? "");
  const timestamp = Number.isFinite(history?.anchorAt)
    ? history.anchorAt
    : latestObservedAt;
  return shareCardDateLabel(timestamp);
}

/**
 * The history the card plots: the exact allowance-history series the weekly
 * panel uses, including shorter diagnostic observations. The horizontal axis
 * carries date-only labels for the derived estimate availability, never a
 * raw-log timestamp or a time of day.
 */
function shareCardTrend(history) {
  // The card is a compact rendering of the exact series on Allowance estimate
  // history. It must not silently remove shorter fits, change the active
  // period, or rescale the chart just because it is being shared.
  let skippedPoint = false;
  const points = (Array.isArray(history?.points) ? history.points : [])
    .map((point) => {
      const value = finite(point?.value);
      if (!Number.isFinite(point?.at) || value === null || value <= 0) {
        skippedPoint = true;
        return null;
      }
      const low = finite(point?.low);
      const high = finite(point?.high);
      const lowessBreakBefore = skippedPoint;
      skippedPoint = false;
      return Object.freeze({
        at: point.at,
        dateLabel: point.dateLabel,
        value,
        low,
        high,
        historicalMedian: finite(point?.historicalMedian),
        allowanceLowess: finite(point?.allowanceLowess),
        lowessBreakBefore,
        acrossResetLow: finite(point?.acrossResetLow),
        acrossResetHigh: finite(point?.acrossResetHigh),
        wellObserved: point.wellObserved === true,
      });
    })
    .filter((point) => point !== null);
  const axisLow = finite(history?.axis?.low);
  const axisHigh = finite(history?.axis?.high);
  if (!points.length || axisLow === null || axisHigh === null || axisHigh <= axisLow) {
    return null;
  }
  const observedBounds = points.flatMap((point) => [
    point.value,
    point.low,
    point.high,
  ]).filter((value) => value !== null);
  return Object.freeze({
    points: Object.freeze(points),
    low: Math.min(...observedBounds),
    high: Math.max(...observedBounds),
    axis: Object.freeze({
      low: axisLow,
      high: axisHigh,
      ticks: Object.freeze([...(history?.axis?.ticks ?? [])]),
    }),
    xTicks: Object.freeze([...(history?.xTicks ?? [])]),
    count: points.length,
    lowessCount: points.filter((point) => point.allowanceLowess !== null).length,
    lowessReason: history?.lowessReason === "tooMany" ? "tooMany" : null,
    // How many plotted fits carry the outlined short-observation marker, and
    // the floor that classified them. The outline is a claim about evidence
    // quality that the picture cannot explain on its own, so the key beside
    // the plot and the transcript's sentence both read these instead of
    // re-deriving a classification the dashboard already made.
    shortCount: points.filter((point) => !point.wellObserved).length,
    wellObservedFloorPp: finite(history?.wellObservedFloorPp, 0),
    // The population the count sentence names. The page headline counts the
    // whole corpus while the chart draws the filtered subset; the card used
    // to print only the subset count, which read as a different dataset. The
    // shared history model carries the corpus size and the filter it applied,
    // so the card can state "{shown} of {total}" exactly like the hero.
    totalCount: Math.max(
      points.length,
      finite(history?.totalCount, points.length),
    ),
    spanFloorPp: finite(history?.spanFloorPp, 0),
    rangeDays: finite(history?.rangeDays),
    firstDateLabel: points[0].dateLabel,
    lastDateLabel: points[points.length - 1].dateLabel,
  });
}

/**
 * Compose one card from figures the dashboard already derived.
 *
 * Pure: it reads the normalized dashboard contract and the identifiers handed
 * to it, and returns only numbers and fixed copy. Every claim it makes about
 * precision is generated from the same state the panels above report, so the
 * card cannot describe the evidence as better than the page does.
 */
function buildShareCard(data, {
  reference,
  appVersion = "",
  registryVersion = "",
  home = "",
  contractVersion = "",
  history = null,
  activity = null,
} = {}) {
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")) {
    throw new TypeError("A results card requires a minted reference.");
  }
  const isDemo = data?.mode === "demo";
  const headlineDate = shareCardHeadlineDate(data, history);
  const pricing = data?.pricing ?? {};
  const projection = dashboardAccountingProjection(data);
  const accountingEvidenceAvailable = projection.status === "available"
    || (projection.status === "retained" && activity !== null);
  // The activity figure follows the usage chart's selected date range
  // (owner-directed, 2026-08-10) whenever the accounting periods carry that
  // range; the pricing fallback preserves the old 7-day-selected behavior
  // for payloads without per-period accounting (the demo fixture among them).
  const fastMode = accountingEvidenceAvailable
    ? activity?.fastMode ?? pricing.fastMode ?? {}
    : {};
  // The share card's third figure is specifically the weekly reset fit. Do
  // not substitute the older general-gradient summary here: both are API-price
  // equivalents, but their evidence source and denominator are different.
  const summary = data?.weekly?.summary ?? {};

  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = data.allowancePlanSelection !== undefined
    || shareCardWindowKind(allowanceWindow) === "seven_day";
  const remaining = finite(allowanceWindow?.remainingPercent);
  const windowLabel = shareCardWindowLabel(allowanceWindow);
  // The reader's most-recent plan, read from the same bounded plan_type enum
  // the quota cards use. "" leaves the header chip off entirely.
  const planLabel = data.allowancePlanSelection
    ? shareCardPlanLabel(data?.weekly?.planType) || t("weekly.plan.unknown")
    : shareCardPlan(data?.quotaWindows ?? []);

  const weighted = !accountingEvidenceAvailable
    ? null
    : activity !== null
      ? activity.quotaWeightedTotalCostUsd
      : finite(pricing.quotaWeightedTotalCostUsd);
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  const spend = !accountingEvidenceAvailable
    ? null
    : useWeighted
    ? weighted
    : activity !== null
      ? activity.totalCostUsd
      : finite(pricing.totalCostUsd);
  const excluded = finite(fastMode.unweightedUnknownApiPriceEquivalentUsd, 0);
  const period = activity !== null
    ? t(activity.labelKey)
    : shareCardPeriodLabel(pricing.periodLabel);

  const capacity = isWeeklyWindow ? finite(
    summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd,
  ) : null;
  const lower = isWeeklyWindow ? finite(
    summary.lower_80_across_resets_usd ?? summary.lower80Usd,
  ) : null;
  const upper = isWeeklyWindow ? finite(
    summary.upper_80_across_resets_usd ?? summary.upper80Usd,
  ) : null;
  const hasCapacity = capacity !== null && capacity > 0;
  const hasRange = hasCapacity
    && lower !== null && lower > 0
    && upper !== null && upper > 0;

  // The allowance estimate leads: it is the card's headline claim, and the
  // title promises it (owner-directed reorder, 2026-08-07).
  const stats = [
    {
      label: isWeeklyWindow
        ? t("share.stat.estimatedAllowance")
        : t("share.stat.estimatedAllowanceUnavailable"),
      value: hasCapacity ? formatMoney(capacity, 0) : t("share.value.notEstimable"),
      detail: !isWeeklyWindow
        ? t("share.detail.notApplicableToWindow")
        : hasRange
        ? t("share.detail.resetRange", {
          lower: formatMoney(lower, 0),
          upper: formatMoney(upper, 0),
        })
        : hasCapacity
          ? t("share.detail.noAcrossResetRange")
          : t("share.detail.notEnoughMatchedWindows"),
    },
    {
      label: t("share.stat.allowanceLeft"),
      value: remaining === null ? t("share.value.notObserved") : formatPercent(remaining),
      detail: remaining === null
        ? t("share.detail.noCurrentAllowance")
        : t("share.detail.ofWindow", { window: windowLabel }),
    },
    {
      // This is the complete rolling ledger selection, not a single weekly
      // allowance. The label must make the different denominator clear on the
      // image itself: an activity total can legitimately exceed one estimated
      // allowance without being a billing error or an allowance overrun.
      label: t(data.allowancePlanSelection
        ? "share.stat.recordedActivityAllPlans" : "share.stat.recordedActivity"),
      value: spend === null ? t("share.value.notAvailable") : formatMoney(spend, 0),
      // The "event-time API equivalent" caption is gone (owner-directed,
      // 2026-08-10): the detail line states the selected range and nothing
      // else.
      detail: spend !== null
        ? projection.status === "retained"
          ? t(
            projection.reason === "local_unified_index_schema_newer"
              ? "share.detail.lastVerifiedNewerBuild"
              : "share.detail.lastVerifiedPeriod",
            { period },
          )
          : period
        : projection.reason === "local_unified_index_schema_newer"
          ? t("share.detail.newerBuildRequired")
          : projection.status !== "available"
            ? t("share.detail.accountingUnavailable")
            : t("share.detail.noPricedUsage"),
    },
  ];

  // Assembled from the same state the panels report, strongest qualification
  // first. The old separate activity-versus-allowance sentence is gone
  // (owner-directed, 2026-08-07): each stat's own detail line already names
  // its denominator, and the reclaimed row belongs to the chart.
  const caveats = [];
  if (isDemo) {
    caveats.push(t("share.caveat.demo"));
  }
  if (data.allowancePlanSelection) {
    caveats.push(t("share.caveat.planConditional"));
  }
  if (spend !== null && excluded > 0) {
    caveats.push(t("share.caveat.unweighted", {
      amount: formatMoney(excluded, 2),
    }));
  }
  if (spend !== null && fastMode.weightingStatus === "unknown") {
    caveats.push(t("share.caveat.noWeighted"));
  } else if (spend !== null && fastMode.weightingStatus !== "complete") {
    caveats.push(t("share.caveat.fastPartial"));
  }
  // The caveat qualifies the figure actually printed, so it reads the same
  // selected range the activity stat does.
  const coverage = spend === null
    ? null
    : activity !== null
    ? activity.coveragePercent
    : finite(pricing.coveragePercent);
  if (coverage !== null && coverage < 100) {
    caveats.push(t("share.caveat.coverage", {
      percent: formatPercent(coverage, 1),
    }));
  }
  const identifiers = [
    t("share.identifier.debug", { reference }),
    appVersion === "" ? t("share.identifier.unversioned") : t("share.identifier.version", {
      version: appVersion,
    }),
  ].filter((part) => part !== "");

  const trend = isWeeklyWindow ? shareCardTrend(history) : null;
  return Object.freeze({
    reference,
    isDemo,
    title: t("share.title"),
    // A real card carries the same newest-fit date as the weekly headline,
    // falling back to the latest observation only when no weekly history is
    // available. The strongest claim on the card is still the one a fixture
    // must not borrow, so a demo keeps its warning here and beside the mark.
    subtitle: isDemo
      ? t("share.subtitle.demo")
      : headlineDate,
    badge: isDemo ? t("share.badge.demo") : "",
    // The Codex plan name is presented as-is; only the surrounding word is
    // localized (share.plan). "" when no window named a plan, so a card that
    // cannot name a plan carries no chip and no empty wrapper.
    plan: planLabel === "" ? "" : t(
      data.allowancePlanSelection ? "share.planAllowance" : "share.plan",
      { plan: planLabel },
    ),
    stats: Object.freeze(stats.map((stat) => Object.freeze({ ...stat }))),
    // Reset-fit history is an explicitly seven-day model. It is never drawn
    // behind a five-hour or provider-reported generic allowance window.
    trend,
    trendLabel: t("share.trend.label"),
    // The plot's marker key. The dashboard reveals its own only when a short
    // observation is actually drawn (`#weekly-partial-legend`), and the card
    // follows: a card whose fits are all well observed carries no key, and
    // the labels are the chart's own, so the two surfaces say one thing.
    trendLegend: shareCardTrendLegend(trend),
    trendLineLegend: shareCardTrendLineLegend(trend),
    // The count sentence mirrors the Allowance hero's phrasing: shown of
    // total, plus the range and span filter the shared model applied. A bare
    // subset count beside the page's corpus count read as two different
    // datasets (owner review, 2026-08-08).
    trendCount: trend === null ? "" : shareCardTrendCountLabel(trend),
    trendEmpty: isWeeklyWindow
      ? t("share.trend.empty")
      : t("share.trend.unavailableForWindow"),
    trendEmptyDetail: isWeeklyWindow
      ? t("share.trend.emptyDetail")
      : t("share.trend.unavailableForWindowDetail"),
    caveats: Object.freeze(caveats),
    identifierLine: identifiers.join(" · "),
    contractVersion,
    home,
    // Drawn at the image's top-right corner in place of the home host
    // (owner-directed, 2026-08-08). Empty when the build is unversioned, so
    // the corner is blank rather than carrying an invented number.
    versionLabel: appVersion === ""
      ? ""
      : t("share.identifier.version", { version: appVersion }),
  });
}

/**
 * The plotted history's population sentence: shown of total, with the fixed
 * range vocabulary and the span floor the shared model applied. Only numbers
 * and fixed copy can reach it.
 */
function shareCardTrendCountLabel(trend) {
  const range = trend.rangeDays === null
    || trend.rangeDays >= ALL_HISTORY_RANGE_DAYS
    ? t("share.range.all")
    : t("share.range.days", { days: formatNumber(trend.rangeDays) });
  const values = {
    range,
    shown: formatNumber(trend.count),
    total: formatNumber(trend.totalCount),
  };
  return trend.spanFloorPp > 0
    ? t("share.trend.countWithFloor", {
      ...values,
      span: formatNumber(trend.spanFloorPp),
    })
    : t("share.trend.countAnySpan", values);
}

/**
 * The plot's two markers, named: filled for a well-observed fit, outlined for
 * a short observation.
 *
 * Empty unless a short observation is actually plotted, so the common card
 * spends no pixels explaining a marker it never draws. The branch mirrors the
 * dashboard's own series label, so a card and the page it came from describe
 * the same classification.
 */
function shareCardTrendLegend(trend) {
  if (trend === null || trend.shortCount === 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      filled: true,
      label: trend.wellObservedFloorPp > 0
        ? t("weekly.series.wellObserved", {
          span: formatDecimal(trend.wellObservedFloorPp, 0),
        })
        : t("weekly.series.allSpans"),
    }),
    Object.freeze({
      filled: false,
      label: t("weekly.series.shortObservation"),
    }),
  ]);
}

/** Fixed, localized labels for the same reference and fit drawn by the page. */
function shareCardTrendLineLegend(trend) {
  if (trend === null) return Object.freeze([]);
  const entries = [];
  if (finite(trend.points[0]?.historicalMedian) !== null) {
    entries.push(Object.freeze({ kind: "median", label: t("weekly.series.allDataMedian") }));
  }
  entries.push(Object.freeze({
    kind: trend.lowessCount > 0 ? "lowess" : "unavailable",
    label: t(trend.lowessCount > 0 ? "weekly.controls.lowess"
      : trend.lowessReason === "tooMany" ? "weekly.controls.lowessTooMany" : "weekly.controls.lowessUnavailable"),
  }));
  return Object.freeze(entries);
}

function shareCardTrendFitText(card) {
  if (card.trend === null) return "";
  return t(card.trend.lowessCount > 0 ? "weekly.controls.trendNote"
    : card.trend.lowessReason === "tooMany" ? "weekly.controls.trendTooMany" : "weekly.controls.trendSparse");
}

/**
 * The same card as a sentence, for a screen reader and for a text-only post.
 */
function shareCardText(card) {
  const figures = card.stats
    .map((stat) => t("share.text.figure", stat))
    .join(" ");
  const trailer = card.contractVersion === ""
    ? card.identifierLine
    : t("share.text.contract", {
      identifier: card.identifierLine,
      version: card.contractVersion,
    });
  return [
    t("share.text.header", { subtitle: card.subtitle, title: card.title }),
    // Already the fully composed "Plan …" line, or "" — the trailing filter
    // drops it so the transcript names the plan only when one was reported.
    card.plan,
    figures,
    shareCardTrendText(card),
    shareCardTrendShortText(card),
    shareCardTrendFitText(card),
    card.caveats.join(" "),
    t("share.text.trailer", { trailer }),
    card.home === "" ? "" : t("share.text.more", { home: card.home }),
  ].filter((line) => line !== "").join("\n");
}

/**
 * The plotted history as a sentence. The picture may not say anything the
 * text beside it does not.
 */
function shareCardTrendText(card) {
  return card.trend === null
    ? t("share.text.trendEmpty", {
      detail: card.trendEmptyDetail,
      empty: card.trendEmpty,
      label: card.trendLabel,
    })
    : t("share.text.trendPopulated", {
      end: card.trend.lastDateLabel,
      // The same shown-of-total sentence the image prints, so the text
      // transcript and the picture state one population.
      fits: card.trendCount,
      high: formatMoney(card.trend.high, 0),
      label: card.trendLabel,
      low: formatMoney(card.trend.low, 0),
      start: card.trend.firstDateLabel,
    });
}

/**
 * The outlined marker, in words.
 *
 * The plot draws a short observation differently from a well-observed fit,
 * and a difference a reader can see is a claim the transcript owes them.
 * "" when every plotted fit is well observed, which is also when the image
 * draws no key.
 */
function shareCardTrendShortText(card) {
  return card.trend === null || card.trend.shortCount === 0
    ? ""
    : tPlural("share.text.shortObservation", card.trend.shortCount, {
      count: formatNumber(card.trend.shortCount),
    });
}

function shareCardFont(weight, size, family = "sans") {
  return family === "serif"
    ? `${weight} ${size}px "Iowan Old Style", Baskerville, "Times New Roman", serif`
    : `${weight} ${size}px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

/**
 * Break one line into at most `maxLines` measured lines.
 *
 * Every string on the card is bounded by construction; this only guarantees
 * that a long fixed sentence wraps inside the card rather than running off it.
 */
function shareCardWrap(context, value, maxWidth, maxLines) {
  const lines = [];
  let current = "";
  const source = String(value).trim();
  const words = /\s/u.test(source)
    ? source.split(/\s+/u)
    : typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(localization.locale(), {
        granularity: "grapheme",
      }).segment(source)].map(({ segment }) => segment)
      : Array.from(source);
  const separator = /\s/u.test(source) ? " " : "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current}${separator}${word}`;
    if (current !== "" && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) return lines;
    } else {
      current = candidate;
    }
  }
  if (current !== "" && lines.length < maxLines) lines.push(current);
  return lines;
}

function shareCardFit(context, value, maxWidth) {
  if (context.measureText(value).width <= maxWidth) return value;
  const units = Array.from(String(value));
  while (units.length > 1
    && context.measureText(`${units.join("")}…`).width > maxWidth) {
    units.pop();
  }
  return `${units.join("")}…`;
}

function drawShareCardBrand(context, x, y) {
  if (!shareCardBrandImage.complete || shareCardBrandImage.naturalWidth === 0) return;
  context.drawImage(shareCardBrandImage, x, y - 19, 38, 38);
}

function drawShareCardPanel(context, x, y, width, height) {
  context.save();
  context.fillStyle = "#fffef9";
  context.strokeStyle = "rgba(23, 33, 30, .16)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x + .5, y + .5, width - 1, height - 1, 10);
  context.fill();
  context.stroke();
  context.restore();
}

/**
 * The one type size every figure on the card is drawn at.
 *
 * The row reads as a single scale, and the size is chosen so the longest
 * figure fits its column whole: a seven-figure total and a spelled-out "Not
 * estimable" both overrun the column at the full size, and a figure cut off
 * mid-word in the largest type on the card is unreadable at a glance and easy
 * to misread as a smaller number.
 */
function shareCardValueSize(context, values, maxWidth) {
  let size = SHARE_CARD_VALUE_SIZE;
  while (size > SHARE_CARD_VALUE_MIN_SIZE) {
    context.font = shareCardFont(500, size, "serif");
    if (values.every((value) => context.measureText(value).width <= maxWidth)) {
      break;
    }
    size -= 1;
  }
  return size;
}

/**
 * Draw a demo card's mark: the one qualification a reader must not miss, at
 * the top of the card rather than in the caveats.
 */
function drawShareCardBadge(context, badge, x, y) {
  context.save();
  context.font = shareCardFont(750, 15);
  const width = context.measureText(badge).width + 26;
  context.fillStyle = "#8c2f1d";
  context.beginPath();
  context.roundRect(x, y - 17, width, 26, 13);
  context.fill();
  context.fillStyle = "#fdf6f2";
  context.fillText(badge, x + 13, y);
  context.restore();
  return width;
}

/**
 * Draw the reader's current plan as a quiet chip beside the subtitle.
 *
 * The plan name is Codex's own, so it keeps its friendly case rather than
 * being upper-cased like the loud demo mark. The caller only reaches this
 * with a non-empty label; an absent plan draws nothing.
 */
function drawShareCardPlan(context, plan, right, baseline) {
  context.save();
  context.textAlign = "left";
  context.font = shareCardFont(700, 15);
  const width = context.measureText(plan).width + 26;
  const x = right - width;
  context.fillStyle = "rgba(23, 79, 69, .08)";
  context.strokeStyle = "rgba(23, 79, 69, .28)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x + .5, baseline - 17.5, width - 1, 26, 13);
  context.fill();
  context.stroke();
  context.fillStyle = "#174f45";
  context.fillText(plan, x + 13, baseline);
  context.restore();
  return width;
}

function drawShareCardTrend(context, card, x, y, width, height) {
  drawShareCardPanel(context, x, y, width, height);
  context.save();
  if (card.trend === null) {
    // Two lines rather than one: an empty plot area should say what will fill
    // it, not read as a panel that failed to draw.
    context.textAlign = "center";
    context.fillStyle = "#17211e";
    context.font = shareCardFont(600, 19);
    context.fillText(card.trendEmpty, x + width / 2, y + height / 2 - 4);
    context.fillStyle = "#65706b";
    context.font = shareCardFont(500, 17);
    context.fillText(card.trendEmptyDetail, x + width / 2, y + height / 2 + 24);
    context.restore();
    return;
  }
  const { points, axis, xTicks } = card.trend;
  const xAxisLabel = t("share.axis.resetEstimateDate");
  const yAxisLabel = t("share.axis.allowance");
  const padTop = 64;
  const padBottom = 54;
  const padLeft = 92;
  const padRight = 20;
  context.font = shareCardFont(600, 14);
  const axisDigits = axis.high < 100 ? 2 : 0;
  const plotLeft = x + padLeft;
  const plotRight = x + width - padRight;
  const plotTop = y + padTop;
  const plotBottom = y + height - padBottom;
  const domainStart = points[0].at;
  const domainEnd = points.at(-1).at;
  const span = domainEnd - domainStart;
  const range = axis.high - axis.low;
  const positionX = (point) => points.length === 1 || span <= 0
    ? (plotLeft + plotRight) / 2
    : plotLeft + (point.at - domainStart) / span * (plotRight - plotLeft);
  const positionY = (value) => range <= 0
    ? (plotTop + plotBottom) / 2
    : plotBottom - (value - axis.low) / range * (plotBottom - plotTop);

  context.strokeStyle = "rgba(23, 33, 30, .12)";
  context.lineWidth = 1;
  for (const value of axis.ticks) {
    const gridY = Math.round(positionY(value)) + .5;
    context.beginPath();
    context.moveTo(plotLeft, gridY);
    context.lineTo(plotRight, gridY);
    context.stroke();
  }

  context.strokeStyle = "rgba(23, 33, 30, .28)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(plotLeft, plotTop);
  context.lineTo(plotLeft, plotBottom);
  context.lineTo(plotRight, plotBottom);
  context.stroke();

  const bandLow = finite(points[0]?.acrossResetLow);
  const bandHigh = finite(points[0]?.acrossResetHigh);
  if (bandLow !== null && bandHigh !== null && bandHigh > bandLow) {
    context.fillStyle = "rgba(49, 95, 132, .14)";
    context.fillRect(
      plotLeft,
      positionY(bandHigh),
      plotRight - plotLeft,
      positionY(bandLow) - positionY(bandHigh),
    );
  }

  for (const point of points) {
    const pointX = Math.round(positionX(point)) + .5;
    if (point.low !== null && point.high !== null) {
      context.strokeStyle = "rgba(49, 95, 132, .78)";
      context.lineWidth = 1.8;
      context.beginPath();
      context.moveTo(pointX, positionY(point.high));
      context.lineTo(pointX, positionY(point.low));
      context.stroke();
      for (const bound of [point.high, point.low]) {
        const capY = Math.round(positionY(bound)) + .5;
        context.beginPath();
        context.moveTo(pointX - 5, capY);
        context.lineTo(pointX + 5, capY);
        context.stroke();
      }
    }
  }

  const median = finite(points[0]?.historicalMedian);
  if (median !== null) {
    const medianY = Math.round(positionY(median)) + .5;
    context.strokeStyle = "#174f45";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(plotLeft, medianY);
    context.lineTo(plotRight, medianY);
    context.stroke();
  }

  // Consume the shared fit; never refit, interpolate nulls or bridge a gap
  // when exporting the image. Geometry uses the same dates and axis as SVG.
  context.strokeStyle = "#97402a";
  context.lineWidth = 3;
  context.beginPath();
  let connected = false;
  for (const point of points) {
    // If card admission omitted an invalid raw estimate, keep the source
    // chart's break even though that null point is absent from this projection.
    if (point.lowessBreakBefore) connected = false;
    const value = finite(point.allowanceLowess);
    if (value === null) { connected = false; continue; }
    if (connected) context.lineTo(positionX(point), positionY(value));
    else context.moveTo(positionX(point), positionY(value));
    connected = true;
  }
  context.stroke();

  for (const point of points) {
    const pointX = Math.round(positionX(point)) + .5;
    context.fillStyle = point.wellObserved ? "#315f84" : "#fffef9";
    context.beginPath();
    context.arc(pointX, positionY(point.value), 4.5, 0, Math.PI * 2);
    context.fill();
    if (!point.wellObserved) {
      context.strokeStyle = "#a9492f";
      context.lineWidth = 2.4;
      context.stroke();
    }
  }

  context.fillStyle = "#65706b";
  context.font = shareCardFont(600, 14);
  context.textAlign = "right";
  for (const value of axis.ticks) {
    context.fillText(
      formatMoney(value, axisDigits),
      plotLeft - 10,
      positionY(value) + 5,
    );
  }
  context.textAlign = "left";
  context.font = shareCardFont(700, 13);
  context.fillText(yAxisLabel, plotLeft, y + 22);

  // The marker key shares that strip, right-aligned to the plot's right edge:
  // the panel's top padding is already reserved and the axis label leaves it
  // free. Each swatch is drawn by the same two calls the points are, at the
  // same radius, so the key cannot drift from what it explains.
  if (card.trendLegend.length > 0) {
    context.save();
    context.font = shareCardFont(600, 13);
    const swatch = 9;
    const gap = 7;
    const between = 18;
    const widths = card.trendLegend.map((entry) =>
      swatch + gap + context.measureText(entry.label).width);
    let cursor = plotRight - widths.reduce(
      (total, width) => total + width + between,
      -between,
    );
    card.trendLegend.forEach((entry, index) => {
      context.fillStyle = entry.filled ? "#315f84" : "#fffef9";
      context.beginPath();
      context.arc(cursor + swatch / 2, y + 17, 4.5, 0, Math.PI * 2);
      context.fill();
      if (!entry.filled) {
        context.strokeStyle = "#a9492f";
        context.lineWidth = 2.4;
        context.stroke();
      }
      context.fillStyle = "#65706b";
      context.fillText(entry.label, cursor + swatch + gap, y + 22);
      cursor += widths[index] + between;
    });
    context.restore();
  }

  // A separate row keeps trend labels clear of the observation-marker key.
  context.font = shareCardFont(600, 13);
  context.textAlign = "left";
  let lineCursor = plotLeft;
  for (const entry of card.trendLineLegend) {
    if (entry.kind !== "unavailable") {
      context.strokeStyle = entry.kind === "lowess" ? "#97402a" : "#174f45";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(lineCursor, y + 43);
      context.lineTo(lineCursor + 20, y + 43);
      context.stroke();
      lineCursor += 27;
    }
    context.fillStyle = "#65706b";
    context.fillText(entry.label, lineCursor, y + 47);
    lineCursor += context.measureText(entry.label).width + 20;
  }

  for (const tick of xTicks) {
    // SVG uses `middle`; Canvas uses the equivalent `center` value.
    context.textAlign = tick.alignment === "middle" ? "center" : tick.alignment;
    const tickX = points.length === 1 || span <= 0
      ? (plotLeft + plotRight) / 2
      : plotLeft + (tick.at - domainStart) / span * (plotRight - plotLeft);
    context.fillText(tick.label, tickX, plotBottom + 21);
  }
  context.font = shareCardFont(600, 13);
  context.textAlign = "center";
  context.fillText(xAxisLabel, (plotLeft + plotRight) / 2, y + height - 11);
  context.restore();
}

/**
 * Paint the card. Every string drawn here comes from the composed model.
 */
function drawShareCard(canvas, card) {
  const context = canvas.getContext("2d");
  if (context === null) return false;
  canvas.width = SHARE_CARD_WIDTH * SHARE_CARD_PIXEL_SCALE;
  canvas.height = SHARE_CARD_HEIGHT * SHARE_CARD_PIXEL_SCALE;
  context.setTransform(
    SHARE_CARD_PIXEL_SCALE, 0, 0, SHARE_CARD_PIXEL_SCALE, 0, 0,
  );
  const margin = 56;
  const inner = SHARE_CARD_WIDTH - margin * 2;

  context.fillStyle = "#f5f1e8";
  context.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  context.fillStyle = "#174f45";
  context.fillRect(0, 0, SHARE_CARD_WIDTH, 8);
  context.strokeStyle = "rgba(23, 33, 30, .16)";
  context.lineWidth = 2;
  context.strokeRect(1, 1, SHARE_CARD_WIDTH - 2, SHARE_CARD_HEIGHT - 2);

  // Header band (owner-directed tightening, 2026-08-07): brand, title and
  // subtitle sit in 170px instead of the old 207px, and every reclaimed pixel
  // below goes to the chart.
  drawShareCardBrand(context, margin, 54);
  context.textBaseline = "alphabetic";
  context.fillStyle = "#17211e";
  context.font = shareCardFont(800, 25);
  context.fillText("TiboTattle", margin + 52, 63);
  if (card.badge !== "") {
    drawShareCardBadge(
      context,
      card.badge,
      margin + 68 + context.measureText("TiboTattle").width,
      61,
    );
  }

  // The top-right corner names the build that produced these figures
  // (owner-directed, 2026-08-08): the app version replaced the home host,
  // which already reaches a reader through the text transcript's "More at"
  // line. An unversioned build leaves the corner blank.
  context.textAlign = "right";
  context.font = shareCardFont(700, 20);
  context.fillStyle = "#65706b";
  if (card.versionLabel !== "") {
    context.fillText(card.versionLabel, SHARE_CARD_WIDTH - margin, 63);
  }
  context.textAlign = "left";

  context.fillStyle = "#17211e";
  context.font = shareCardFont(500, 50, "serif");
  context.fillText(shareCardFit(context, card.title, inner), margin, 126);
  context.font = shareCardFont(600, 20);
  context.fillStyle = "#65706b";
  context.fillText(shareCardFit(context, card.subtitle, inner), margin, 156);
  // The reader's plan sits right-aligned on the subtitle row, above the
  // figures it contextualises. Empty when no window named a plan, so the row
  // stays a single subtitle rather than carrying an empty chip.
  if (card.plan !== "") {
    drawShareCardPlan(context, card.plan, SHARE_CARD_WIDTH - margin, 156);
  }

  const gap = 22;
  const columnWidth = (inner - gap * 2) / 3;
  const statTop = 176;
  const statHeight = 152;
  const padding = 20;
  const textWidth = columnWidth - padding * 2;
  const valueSize = shareCardValueSize(
    context,
    card.stats.map((stat) => stat.value),
    textWidth,
  );
  card.stats.forEach((stat, index) => {
    const x = margin + index * (columnWidth + gap);
    drawShareCardPanel(context, x, statTop, columnWidth, statHeight);
    context.fillStyle = "#65706b";
    context.font = shareCardFont(750, 15);
    const labelLines = shareCardWrap(
      context, stat.label.toLocaleUpperCase(localization.locale()), textWidth, 2,
    );
    labelLines.forEach((line, lineIndex) => {
      context.fillText(line, x + padding, statTop + 32 + lineIndex * 19);
    });
    context.fillStyle = "#174f45";
    context.font = shareCardFont(500, valueSize, "serif");
    context.fillText(
      shareCardFit(context, stat.value, textWidth),
      x + padding,
      statTop + 98,
    );
    context.fillStyle = "#65706b";
    context.font = shareCardFont(600, 16);
    shareCardWrap(context, stat.detail, textWidth, 2).forEach((line, lineIndex) => {
      context.fillText(line, x + padding, statTop + 126 + lineIndex * 20);
    });
  });

  // Qualifications are reserved only for incomplete data. A complete card
  // gives the plot its natural visual weight instead of spending the lower
  // third on generic methodology copy. The old activity-versus-allowance
  // sentence row is gone with its field (owner-directed, 2026-08-07).
  context.font = shareCardFont(500, 17);
  const caveatLines = card.caveats
    .slice(0, SHARE_CARD_MAX_CAVEATS)
    .flatMap((caveat) => shareCardWrap(context, caveat, inner - 20, 2))
    .slice(0, SHARE_CARD_MAX_CAVEAT_LINES);
  const caveatStep = 23;
  // The identifier/debug footer and its rule are gone from the image
  // (owner-directed, 2026-08-08). The reference still reaches a reader
  // through the text transcript, the saved file's name, and the chip beside
  // the card; on the picture, every reclaimed pixel belongs to the chart.
  // Caveats, when present, now anchor directly above the card's bottom edge.
  const caveatBaseY = SHARE_CARD_HEIGHT - 26;
  const caveatTop = caveatLines.length === 0
    ? caveatBaseY + 22
    : caveatBaseY - (caveatLines.length - 1) * caveatStep;
  const trendTop = statTop + statHeight + 34;
  const trendHeight = Math.min(
    SHARE_CARD_TREND_MAX_HEIGHT,
    Math.max(SHARE_CARD_TREND_MIN_HEIGHT, caveatTop - 30 - trendTop),
  );
  context.fillStyle = "#65706b";
  context.font = shareCardFont(750, 15);
  context.fillText(
    card.trendLabel.toLocaleUpperCase(localization.locale()),
    margin,
    trendTop - 14,
  );
  if (card.trendCount !== "") {
    context.textAlign = "right";
    context.fillText(
      card.trendCount,
      SHARE_CARD_WIDTH - margin,
      trendTop - 14,
    );
    context.textAlign = "left";
  }
  drawShareCardTrend(context, card, margin, trendTop, inner, trendHeight);

  if (caveatLines.length > 0) {
    context.font = shareCardFont(500, 17);
    let caveatY = caveatTop;
    context.fillStyle = "rgba(23, 79, 69, .3)";
    context.fillRect(
      margin,
      caveatY - 16,
      3,
      (caveatLines.length - 1) * caveatStep + 22,
    );
    context.fillStyle = "#65706b";
    for (const line of caveatLines) {
      context.fillText(line, margin + 20, caveatY);
      caveatY += caveatStep;
    }
  }
  return true;
}

const SHARE_CARD_SAVED_FILE_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-tibotattle-results(?:-[0-9]+)?\.png$/u;

function shareCardFileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}-${pad(now.getMinutes())}-tibotattle-results.png`;
}

function setShareCardStatus(text, { error = false } = {}) {
  const status = $("#share-card-status");
  status.className = `participant-action-status${error ? " error" : ""}`;
  status.textContent = text;
  status.hidden = text === "";
}

// Confirmation of a completed copy is transient: the owner reported the
// previous static status line as broken, because every copy appended
// permanent text under the card. The toast appears over the panel, holds
// long enough to read the printed reference, and removes itself. It is a
// role="status" live region — the same announcement pattern the other action
// statuses on this page use — and contains no focusable content, so it
// cannot trap focus. Its entrance and exit motion live in the stylesheet
// behind prefers-reduced-motion.
const SHARE_CARD_TOAST_HOLD_MS = 6_000;
const SHARE_CARD_TOAST_LEAVE_MS = 300;
let shareCardToastHoldTimer = null;
let shareCardToastLeaveTimer = null;

function dismissShareCardToast() {
  const toast = $("#share-card-toast");
  clearTimeout(shareCardToastHoldTimer);
  clearTimeout(shareCardToastLeaveTimer);
  shareCardToastHoldTimer = null;
  shareCardToastLeaveTimer = null;
  toast.classList.remove("share-toast-leaving");
  toast.textContent = "";
  toast.hidden = true;
}

function showShareCardToast(text, { actionLabel = "", onAction = null } = {}) {
  const toast = $("#share-card-toast");
  dismissShareCardToast();
  toast.hidden = false;
  toast.textContent = text;
  // An optional single action, used by Save to reveal the file. The button is
  // only ever offered when a caller verified the capability exists, so the
  // toast never shows a control that cannot act.
  if (actionLabel !== "" && typeof onAction === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "button button-quiet compact share-toast-action";
    action.textContent = actionLabel;
    action.addEventListener("click", onAction);
    toast.append(action);
  }
  shareCardToastHoldTimer = setTimeout(() => {
    toast.classList.add("share-toast-leaving");
    shareCardToastLeaveTimer = setTimeout(
      dismissShareCardToast,
      SHARE_CARD_TOAST_LEAVE_MS,
    );
  }, SHARE_CARD_TOAST_HOLD_MS);
}

function updateShareCardActions() {
  const ready = shareCard !== null && !shareCardBusy;
  for (const id of [
    "share-card-download",
    "share-card-copy",
  ]) {
    $(`#${id}`).disabled = !ready;
  }
}

/**
 * Render the shareable card for the current evidence.
 *
 * A fresh reference is minted whenever the figures change, so one posted image
 * and one reference always describe the same numbers.
 *
 * Owner-verified regression fix (2026-08-08): the chart renderer hands its
 * OWN history model in through `history`, so the card and the chart are two
 * renderings of one model instance. A card that derived its own model relied
 * on every caller re-rendering it after every filter change — the coupling
 * that broke. Standalone calls (the brand-image late load) still derive the
 * model themselves and read the same active-filter state.
 */
// The share card's activity figure follows the usage chart's selected date
// range (owner-directed, 2026-08-10). The selection is structural — period
// ids and fixed message keys — so no free-form label can reach the image,
// and "All" states the honest denominator: everything recorded, not one
// bounded window.
const SHARE_CARD_RANGE_PERIODS = Object.freeze({
  1: Object.freeze({ id: "24h", labelKey: "share.period.lastDay" }),
  7: Object.freeze({ id: "7d", labelKey: "share.period.lastSevenDays" }),
  30: Object.freeze({ id: "30d", labelKey: "share.period.lastThirtyDays" }),
});

function shareCardActivitySelection(data, rangeDays) {
  const projection = dashboardAccountingProjection(data);
  if (projection.status === "unavailable") return null;
  const selected = { ...(SHARE_CARD_RANGE_PERIODS[rangeDays]
    ?? { id: "all", labelKey: "share.period.allRecorded" }) };
  if (data.reportingWindow) {
    const matched = data.accounting.periods.find(row => row.periodId === data.reportingAccountingPeriod);
    if (!matched) return null;
    selected.id = matched.periodId;
  }
  const period = (Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : []).find((row) => row?.periodId === selected.id) ?? null;
  if (period === null) return null;
  const events = finite(period.events, 0);
  const totalCostUsd = finite(period.apiPriceEquivalentUsd);
  const quotaWeightedTotalCostUsd = finite(
    period.quotaWeightedApiPriceEquivalentUsd,
  );
  if (projection.status === "retained"
      && finite(totalCostUsd, 0) <= 0
      && finite(quotaWeightedTotalCostUsd, 0) <= 0) return null;
  const priced = finite(period.pricingCoverage?.fullyPricedEvents, 0)
    + finite(period.pricingCoverage?.partiallyPricedEvents, 0);
  return {
    labelKey: selected.labelKey,
    totalCostUsd,
    quotaWeightedTotalCostUsd,
    fastMode: period.fastMode ?? {},
    coveragePercent: events > 0
      ? Number(((priced / events) * 100).toFixed(6))
      : null,
  };
}

function renderShareCard(data, { history: sharedHistory = null } = {}) {
  const canvas = $("#share-card-canvas");
  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = data.allowancePlanSelection !== undefined
    || shareCardWindowKind(allowanceWindow) === "seven_day";
  const history = isWeeklyWindow
    ? sharedHistory ?? allowanceHistoryChartModel(data)
    : null;
  const trend = isWeeklyWindow ? shareCardTrend(history) : null;
  const activity = shareCardActivitySelection(data, activeUsageRangeDays);
  const headlineDate = shareCardHeadlineDate(data, history);
  const signature = JSON.stringify([
    data?.mode,
    // The date is printed in the header, so a different visible date is a
    // different card even when its three figures happen to be unchanged.
    headlineDate,
    shareCardWindowKind(allowanceWindow),
    finite(allowanceWindow?.durationMinutes),
    finite(allowanceWindow?.remainingPercent),
    shareCardPlan(data?.quotaWindows ?? []),
    data.allowancePlanSelection ?? null,
    finite(data?.pricing?.quotaWeightedTotalCostUsd),
    finite(data?.pricing?.totalCostUsd),
    finite(data?.pricing?.coveragePercent),
    data?.pricing?.fastMode?.weightingStatus ?? "",
    finite(data?.pricing?.fastMode?.unweightedUnknownApiPriceEquivalentUsd, 0),
    // A changed range selection is a different card: the activity figure,
    // its label, and its coverage caveat all follow it.
    activeUsageRangeDays,
    activity,
    finite(data?.weekly?.summary?.median_weekly_value_usd
      ?? data?.weekly?.summary?.medianWeeklyValueUsd),
    // The plotted history is on the image too, so any change to the canonical
    // dashboard model becomes a new card.
    trend,
  ]);
  if (signature !== shareCardSignature || shareCardReference === "") {
    shareCardSignature = signature;
    shareCardReference = createDiagnosticReference();
  }
  shareCard = buildShareCard(data, {
    reference: shareCardReference,
    appVersion: configuredAppVersion(),
    registryVersion: shareCardRegistryVersion(data?.pricing?.registryVersion),
    contractVersion: shareCardRegistryVersion(data?.schemaVersion),
    home: shareCardHome(),
    history,
    activity,
  });
  // The header's reference chip is gone (owner-directed, 2026-08-08). The
  // reference remains in the selectable transcript, while saved names use
  // local time and do not expose a diagnostic identifier.
  // This generated transcript replaces the initial placeholder. The static
  // localizer must not overwrite the selected-plan figures after a language
  // change; renderWeekly rebuilds the transcript in the new language.
  canvas.removeAttribute("data-i18n-aria-label");
  canvas.setAttribute("aria-label", shareCardText(shareCard));
  if (!drawShareCard(canvas, shareCard)) {
    shareCard = null;
    setShareCardStatus(
      "TiboTattle could not get a drawing surface, so no image could be produced. The card's figures are listed below it as text.",
      { error: true },
    );
  } else {
    setShareCardStatus("");
  }
  updateShareCardActions();
}

function shareCardBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
}

async function runShareCardAction(action) {
  if (shareCard === null || shareCardBusy) return;
  shareCardBusy = true;
  updateShareCardActions();
  try {
    await action(shareCard);
  } finally {
    shareCardBusy = false;
    updateShareCardActions();
  }
}

function waitForShareDownloadResult(requestedFilename) {
  let settle;
  const promise = new Promise((resolve) => {
    const onResult = (event) => {
      if (event.detail?.requestedFilename !== requestedFilename) return;
      settle(event.detail);
    };
    const timer = setTimeout(() => settle({ status: "unconfirmed" }), 30_000);
    settle = (result) => {
      clearTimeout(timer);
      window.removeEventListener("tibotattle:share-download-result", onResult);
      resolve(result);
    };
    window.addEventListener("tibotattle:share-download-result", onResult);
  });
  return { promise, cancel: () => settle({ status: "cancelled" }) };
}

function waitForElectronShareDownloadResult() {
  let settle;
  const promise = new Promise((resolve) => {
    const onCompleted = (event) => settle({ status: "saved", filename: event.detail?.filename });
    const onFailed = () => settle({ status: "failed" });
    const timer = setTimeout(() => settle({ status: "unconfirmed" }), 30_000);
    settle = (result) => {
      clearTimeout(timer);
      window.removeEventListener("tibotattle:share-card-download-completed", onCompleted);
      window.removeEventListener("tibotattle:share-card-download-failed", onFailed);
      resolve(result);
    };
    window.addEventListener("tibotattle:share-card-download-completed", onCompleted);
    window.addEventListener("tibotattle:share-card-download-failed", onFailed);
  });
  return { promise, cancel: () => settle({ status: "cancelled" }) };
}

function openSavedShareImage(bridge, filename) {
  const fail = () => setShareCardStatus(
    t("shareCard.openFailed"),
    { error: true },
  );
  const cleanup = () => {
    clearTimeout(timer);
    window.removeEventListener("tibotattle:share-open-result", onResult);
  };
  const onResult = (event) => {
    if (event.detail?.filename !== filename) return;
    cleanup();
    if (event.detail.opened !== true) fail();
  };
  const timer = setTimeout(() => {
    cleanup();
    fail();
  }, 10_000);
  window.addEventListener("tibotattle:share-open-result", onResult);
  try {
    bridge.postMessage({ type: "open-completed-download", filename });
  } catch {
    cleanup();
    fail();
  }
}

function downloadShareCard() {
  return runShareCardAction(async () => {
    dismissShareCardToast();
    setShareCardStatus("");
    const blob = await shareCardBlob($("#share-card-canvas"));
    if (blob === null) {
      setShareCardStatus(
        "TiboTattle could not turn the card into a PNG. Nothing was saved; the figures remain listed below as text.",
        { error: true },
      );
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const filename = shareCardFileName();
    link.download = filename;
    // The native host confirms completion and supplies only the final basename.
    // The page never receives the filesystem path.
    const bridge = document.body.classList.contains("native-dashboard")
      ? window.webkit?.messageHandlers?.tibotattleDownloads
      : undefined;
    const electron = window.tibotattleDesktop?.version === "v1"
      && typeof window.tibotattleDesktop.openLatestDownload === "function"
      ? window.tibotattleDesktop : null;
    const completion = bridge
      ? waitForShareDownloadResult(filename)
      : electron ? waitForElectronShareDownloadResult() : null;
    try {
      link.click();
    } catch {
      completion?.cancel();
      setShareCardStatus(t("shareCard.downloadStartFailed"), { error: true });
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!completion) {
      showShareCardToast(t("shareCard.downloadRequested", { filename }));
      return;
    }
    const result = await completion.promise;
    if (result.status !== "saved"
      || typeof result.filename !== "string"
      || !SHARE_CARD_SAVED_FILE_PATTERN.test(result.filename)) {
      setShareCardStatus(
        result.status === "failed"
          ? t("shareCard.saveFailed")
          : t("shareCard.saveUnconfirmed"),
        { error: true },
      );
      return;
    }
    setShareCardStatus("");
    showShareCardToast(t("shareCard.savedToDownloads", { filename: result.filename }), {
      actionLabel: t("shareCard.openImage"),
      onAction: () => {
        if (bridge) openSavedShareImage(bridge, result.filename);
        else if (electron) {
          Promise.resolve().then(() => electron.openLatestDownload()).then((status) => {
            if (status !== "opened") setShareCardStatus(t("shareCard.openFailed"), { error: true });
          }).catch(() => setShareCardStatus(t("shareCard.openFailed"), { error: true }));
        }
      },
    });
  });
}

function copyShareCardImage() {
  return runShareCardAction(async (card) => {
    if (typeof ClipboardItem !== "function"
      || typeof navigator.clipboard?.write !== "function") {
      setShareCardStatus(
        "TiboTattle cannot put an image on the clipboard here. Use Save image instead, or Copy as text.",
        { error: true },
      );
      return;
    }
    // WebKit requires the write to start during the click gesture. Give the
    // ClipboardItem a promise so canvas.toBlob can finish after write starts.
    const png = shareCardBlob($("#share-card-canvas")).then((blob) => {
      if (blob === null) throw new Error("share-card-png-unavailable");
      return blob;
    });
    // Observe conversion separately even if ClipboardItem construction or
    // clipboard.write fails before the canvas callback runs.
    const pngReady = png.then(() => true, () => false);
    try {
      const write = navigator.clipboard.write([
        new ClipboardItem({ "image/png": png }),
      ]);
      await Promise.all([write, png]);
      // A stale error from an earlier attempt would otherwise sit under the
      // fresh confirmation.
      setShareCardStatus("");
      showShareCardToast(
        `Copied. Paste it anywhere; reference ${card.reference} identifies these figures.`,
      );
    } catch {
      setShareCardStatus(
        (await pngReady)
          ? "The image could not be copied to the clipboard. Use Save image instead."
          : "TiboTattle could not turn the card into a PNG. Nothing was copied.",
        { error: true },
      );
    }
  });
}

function copyShareCardText() {
  return runShareCardAction(async (card) => {
    if (typeof navigator.clipboard?.writeText !== "function") {
      setShareCardStatus(
        "TiboTattle cannot write to the clipboard here. The card's text is listed below it and can be selected.",
        { error: true },
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(shareCardText(card));
      setShareCardStatus("Copied the card as text.");
    } catch {
      setShareCardStatus(
        "The browser refused clipboard access, so nothing was copied. The card's text is listed below it and can be selected.",
        { error: true },
      );
    }
  });
}

function groupRolling(rows, hours) {
  const groups = new Map();
  for (const row of rows) {
    const rowHours = finite(row.smoothing_hours ?? row.smoothingHours, hours);
    if (rowHours !== hours) continue;
    const timestamp = row.timestamp ?? row.window_end_utc ?? row.observed_at;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
    const group = groups.get(timestamp)
      ?? { timestamp, timestampMs: Date.parse(timestamp), observed: null, expected: null };
    const series = String(row.series ?? "").toLowerCase();
    const value = finite(row.quota_change_pp ?? row.quotaChangePp);
    if (series.includes("observ")) group.observed = value;
    else if (series.includes("expect") || series.includes("cost")) group.expected = value;
    else {
      group.observed ??= finite(row.observed_quota_change_pp);
      group.expected ??= finite(row.expected_quota_change_pp);
    }
    groups.set(timestamp, group);
  }
  return [...groups.values()]
    .filter((row) => row.observed !== null || row.expected !== null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function latestTimelineObservationMs(data) {
  const latest = allowanceTimelineUsage(data).at(-1)?.endAt
    ?? mainWeeklyQuotaTrack(data.timeline.quota).at(-1)?.observedAt
    ?? data.freshness.latestObservedAt;
  const latestMs = Date.parse(latest);
  return Number.isFinite(latestMs) ? latestMs : null;
}

function timelineCutoffMs(data, rangeDays) {
  const selectedEnd = Date.parse(data.reportingWindow?.endAt ?? "");
  const latestMs = Number.isFinite(selectedEnd) ? selectedEnd : latestTimelineObservationMs(data);
  if (data.reportingWindow?.startAt === null) return Number.NEGATIVE_INFINITY;
  return latestMs === null
    ? Number.NEGATIVE_INFINITY
    : latestMs - rangeDays * 24 * 60 * 60 * 1_000;
}

// The "All" range button claims everything retained, so it is covered by
// definition and is the one range that cannot fall short.
const ALL_HISTORY_RANGE_DAYS = 36_500;
// A retained series legitimately begins a bucket or so inside the requested
// window, so only a real shortfall is reported rather than rounding.
const SERIES_COVERAGE_TOLERANCE = 0.95;

/**
 * How much of the labelled range the retained series can actually cover.
 *
 * A range control labels the chart with a period; the series behind that label
 * can reach back far less far, and a line chart cannot show the difference
 * between "nothing happened then" and "that time is missing". Two different
 * things produce it and neither is visible: the evidence may simply not go back
 * that far, and a rejected accounting cache makes the companion fall back to a
 * much smaller live collector projection. Rebuilding identical evidence with
 * the cache withheld took the usage series from 1,716 points spanning 30.9 days
 * to 589 spanning 16.7, and the quota series from 10,000 points spanning 30.9
 * days to 940 spanning 10.1, while the only warning the dashboard offered was
 * about prices.
 *
 * The comparison is against the extent of the retained series, not against the
 * first drawn point. An idle night at the start of a selected week leaves the
 * first bucket hours inside the window while the week itself is fully covered
 * by evidence; that is an honest label, and reporting it would bury the case
 * where the evidence really does stop short.
 *
 * Returns null when the label is honest.
 */
function seriesCoverageShortfall(data, rangeDays) {
  if (!Number.isFinite(rangeDays) || rangeDays >= ALL_HISTORY_RANGE_DAYS) return null;
  const usage = data?.timeline?.usage;
  if (!Array.isArray(usage) || usage.length === 0) return null;
  const latestMs = latestTimelineObservationMs(data);
  // The series is ascending by time - the rolling-window walk in
  // `liveTimelinePoints` and the `at(-1)` read above both depend on it - so the
  // earliest retained observation is the head, not a scan on every pan frame.
  const earliestMs = Date.parse(usage[0].startAt ?? usage[0].endAt);
  if (latestMs === null || !Number.isFinite(earliestMs)) return null;
  const claimedMs = rangeDays * 24 * 60 * 60 * 1_000;
  const coveredMs = Math.max(0, latestMs - earliestMs);
  if (coveredMs >= claimedMs * SERIES_COVERAGE_TOLERANCE) return null;
  return { claimedMs, coveredMs };
}

/**
 * State the shortfall next to the chart that is understating its own history.
 *
 * When the cause is known it is named: a withheld accounting cache is
 * repairable by a local replay, and saying only that prices are withheld leaves
 * the reader to interpret two thirds of their history vanishing as a quiet
 * month.
 */
function renderSeriesCoverage(element, data, rangeDays) {
  if (!element) return;
  const shortfall = seriesCoverageShortfall(data, rangeDays);
  if (shortfall === null) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(
    element,
    data?.pricing?.accountingCacheStatus === "unavailable"
      ? "dashboard.series.shortOfRangeWithheldCache"
      : "dashboard.series.shortOfRange",
    {
      claimed: formatSpanLength(shortfall.claimedMs),
      covered: formatSpanLength(shortfall.coveredMs),
    },
  );
}

function timelineBounds(points) {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let counted = 0;
  // A single loop over stamped milliseconds, rather than map/filter/spread over
  // re-parsed strings: this runs several times per redraw and once more for the
  // residual chart, on every frame of a pan.
  for (const point of points) {
    const at = pointTimestampMs(point);
    if (!Number.isFinite(at)) continue;
    counted += 1;
    if (at < startMs) startMs = at;
    if (at > endMs) endMs = at;
  }
  if (counted < 2) return null;
  return { startMs, endMs };
}

function normalizeTimelineViewport(points) {
  const bounds = timelineBounds(points);
  if (bounds === null) return null;
  const stored = chartViewportTarget.read();
  if (stored === null) return bounds;
  const startMs = Math.max(bounds.startMs, Math.min(stored.startMs, bounds.endMs));
  const endMs = Math.max(startMs + 1, Math.min(stored.endMs, bounds.endMs));
  if (endMs - startMs < 60_000) return bounds;
  return { startMs, endMs };
}

function timelinePointsInViewport(points, viewport) {
  if (viewport === null) return points;
  return points.filter((point) => {
    const timestamp = pointTimestampMs(point);
    return Number.isFinite(timestamp)
      && timestamp >= viewport.startMs
      && timestamp <= viewport.endMs;
  });
}

function resetTimelineViewport() {
  chartViewportTarget.write(null);
}

/**
 * Which chart the shared zoom and pan policy is acting on.
 *
 * Every interactive chart on the dashboard zooms and pans by the same rules:
 * the clamped per-event step, the minimum useful span, the rule that a fully
 * zoomed-out chart stores no viewport at all, and the reset that returns to the
 * selected date range. Those rules live once, in `zoomTimeline`, `panTimeline`,
 * and `updateTimelineViewport` below, and are reviewed there.
 *
 * A chart is therefore not a copy of that policy — it is a place to keep a
 * viewport and a way to redraw. `withChartViewport` names one for the duration
 * of a single synchronous gesture call and restores the previous target on the
 * way out, so a chart can never leak its identity into another chart's handler.
 * The calibration chart is the default target because it is the chart every
 * pre-existing caller was written against.
 */
const CALIBRATION_CHART_VIEWPORT = Object.freeze({
  read: () => timelineViewport,
  write: (value) => { timelineViewport = value; usageTimelineViewport = value; },
  render: () => scheduleUsageTimelineRender(),
});

const USAGE_CHART_VIEWPORT = Object.freeze({
  read: () => usageTimelineViewport,
  write: (value) => { usageTimelineViewport = value; timelineViewport = value; },
  render: () => scheduleUsageTimelineRender(),
});

let chartViewportTarget = CALIBRATION_CHART_VIEWPORT;

function withChartViewport(chart, run) {
  const previous = chartViewportTarget;
  chartViewportTarget = chart;
  try {
    return run();
  } finally {
    chartViewportTarget = previous;
  }
}

// Zoom is a ratio applied per step, so one step feels the same at every scale.
// A wheel step is one mouse notch — trackpads emit many small deltas per
// gesture, and each one moves only its own fraction of that step.
const TIMELINE_WHEEL_ZOOM_STEP = 1.12;
const TIMELINE_WHEEL_NOTCH_PIXELS = 100;
const TIMELINE_BUTTON_ZOOM_STEP = 1.25;
// No single wheel event, however large, may move more than one button press.
const TIMELINE_MAXIMUM_ZOOM_STEP = 1.25;
const TIMELINE_MINIMUM_SPAN_MS = 15 * 60_000;
const TIMELINE_FLOOR_SPAN_MS = 60_000;

function minimumTimelineSpanMs(bounds) {
  return Math.min(
    TIMELINE_MINIMUM_SPAN_MS,
    Math.max(TIMELINE_FLOOR_SPAN_MS, (bounds.endMs - bounds.startMs) / 200),
  );
}

function updateTimelineViewport(points, update) {
  const bounds = timelineBounds(points);
  const current = normalizeTimelineViewport(points);
  if (bounds === null || current === null) return;
  const next = update({ ...current }, bounds);
  if (!next || !Number.isFinite(next.startMs) || !Number.isFinite(next.endMs)) return;
  const minimumSpanMs = minimumTimelineSpanMs(bounds);
  const startMs = Math.max(bounds.startMs, Math.min(next.startMs, bounds.endMs - minimumSpanMs));
  const endMs = Math.min(bounds.endMs, Math.max(next.endMs, startMs + minimumSpanMs));
  chartViewportTarget.write(endMs - startMs >= bounds.endMs - bounds.startMs - 1
    ? null
    : { startMs, endMs });
  chartViewportTarget.render();
}

/**
 * One redraw per displayed frame, however many input events arrive.
 *
 * A mouse notch is one event, but a trackpad flick emits dozens of small wheel
 * deltas and a drag emits a `pointermove` for every sampled position — the
 * pointer sampling rate is well above the display rate on current hardware.
 * Redrawing synchronously inside each handler meant the chart was rebuilt many
 * times for a single painted frame, and the extra rebuilds were never shown to
 * anyone. The viewport arithmetic still runs on every event, so the gesture
 * stays exact; only the drawing is coalesced.
 */
let timelineRenderFrame = 0;

function scheduleTimelineRender() {
  if (!dashboard) return;
  if (typeof requestAnimationFrame !== "function") {
    renderTimeline(dashboard);
    return;
  }
  if (timelineRenderFrame !== 0) return;
  timelineRenderFrame = requestAnimationFrame(() => {
    timelineRenderFrame = 0;
    if (dashboard) renderTimeline(dashboard);
  });
}

function wheelZoomFactor(event) {
  // deltaMode 1 reports lines and 2 reports pages; both are converted to the
  // pixel delta a mouse notch reports so one notch is one step on any device.
  const pixels = event.deltaMode === 1
    ? event.deltaY * 16
    : event.deltaMode === 2
      ? event.deltaY * 400
      : event.deltaY;
  return TIMELINE_WHEEL_ZOOM_STEP ** (pixels / TIMELINE_WHEEL_NOTCH_PIXELS);
}

function zoomTimeline(points, factor, anchorRatio = .5) {
  const step = Math.max(
    1 / TIMELINE_MAXIMUM_ZOOM_STEP,
    Math.min(TIMELINE_MAXIMUM_ZOOM_STEP, factor),
  );
  const anchorAt = Math.max(0, Math.min(1, anchorRatio));
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const nextSpan = Math.min(
      bounds.endMs - bounds.startMs,
      Math.max(minimumTimelineSpanMs(bounds), span * step),
    );
    const anchor = current.startMs + span * anchorAt;
    return {
      startMs: anchor - nextSpan * anchorAt,
      endMs: anchor + nextSpan * (1 - anchorAt),
    };
  });
}

function panTimeline(points, fraction) {
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const shift = span * fraction;
    let startMs = current.startMs + shift;
    let endMs = current.endMs + shift;
    if (startMs < bounds.startMs) {
      endMs += bounds.startMs - startMs;
      startMs = bounds.startMs;
    }
    if (endMs > bounds.endMs) {
      startMs -= endMs - bounds.endMs;
      endMs = bounds.endMs;
    }
    return { startMs, endMs };
  });
}

// Evidence-state names reach both the SVG text layer (as shaded-interval
// tooltips) and the residual table, so they resolve through the catalogue like
// every other chart string rather than being stamped as English.
const TIMELINE_STATUS_KEYS = Object.freeze({
  matched: "chart.status.matched",
  inactive: "chart.status.inactive",
  unpriced_local_activity: "chart.status.unpricedLocalActivity",
  quota_weighting_unavailable: "chart.status.quotaWeightingUnavailable",
  unexplained_without_local_activity: "chart.status.unexplainedWithoutLocalActivity",
  missing_quota_bracket: "chart.status.missingQuotaBracket",
  reset_or_track_change: "chart.status.resetOrTrackChange",
  backward_or_ambiguous: "chart.status.backwardOrAmbiguous",
  pool_saturated: "chart.status.poolSaturated",
});

function timelineStatusKey(status) {
  return TIMELINE_STATUS_KEYS[status] ?? "chart.status.historical";
}

function timelineStatusLabel(status) {
  return t(timelineStatusKey(status));
}

function timelineStatusIntervals(points, viewport) {
  // Sorting through `Date.parse` in the comparator re-parsed each instant
  // O(log n) times. The instants are read once, then sorted as numbers.
  const rows = points
    .map((point) => ({ point, at: pointTimestampMs(point) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at);
  // A run of consecutive windows excluded by ONE mechanism is one region, and
  // merging it is a correctness fix rather than a tidy-up. Emitted per window,
  // each rect is floored to a full viewBox unit by the renderer; at 30d the
  // spacing between windows is well under a unit, so neighbours in a run
  // overlapped and composited their alpha on top of each other. The wash then
  // darkened with point DENSITY instead of duration — dense runs read as solid
  // blocks while isolated windows stayed invisible, which is precisely the
  // "I never see them" the exclusion legend was failing to explain.
  const merged = [];
  rows.forEach(({ point, at: current }, index) => {
    if (!TIMELINE_STATUS_BAND_CLASSES[point.status]) return;
    const previous = index === 0 ? viewport.startMs : rows[index - 1].at;
    const next = index === rows.length - 1 ? viewport.endMs : rows[index + 1].at;
    const startMs = Math.max(viewport.startMs, (previous + current) / 2);
    const endMs = Math.min(viewport.endMs, (current + next) / 2);
    const last = merged[merged.length - 1];
    // Adjacent windows meet exactly at their shared midpoint, so touching is
    // the test for contiguity. A matched window in between pushes the next
    // start past the previous end and correctly breaks the run.
    if (last && last.status === point.status && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }
    merged.push({ status: point.status, startMs, endMs });
  });
  return merged;
}

// The weekly track is identified by (limitId, duration) alone. The provider's
// primary/secondary slots are server-assigned UI roles — the weekly window
// flipped from `secondary` to `primary` around 2026-07-06 — so filtering by
// slot here cut the entire pre-flip era out of the series. Distinct concurrent
// instances stay separated downstream by their reset boundaries
// (sameResetBoundary), and the local pipeline already emits at most one row
// per (limitId, duration, instant).
function mainWeeklyQuotaTrack(rows) {
  return rows.filter(isPrimaryCodexWeeklyQuotaWindow);
}

// The provider restates the same reset boundary with a slightly different
// instant on each snapshot; the observed drift across this corpus is one to
// twenty-two seconds. Comparing the two strings exactly therefore reported a
// reset or track change for roughly one window in ten that had neither, and
// discarded a usable observation each time.
//
// A genuine change moves the boundary by hours — the short window is five
// hours and the long one is seven days — so two minutes is wide enough to
// absorb every observed restatement and still far too narrow to merge two
// distinct reset cycles.
const RESET_BOUNDARY_TOLERANCE_MS = 2 * 60 * 1_000;
// The weekly pool's displayed ceiling. A window whose start edge already
// reads 100 is measuring a pegged pool: observed cannot rise while cost
// keeps accruing, so the residual machinery suspends there instead of
// booking the interregnum as negative drift (pool-lifecycle addendum,
// docs/design/composition-aware-expected-line.md).
const POOL_SATURATION_CEILING_PP = 100;
// A displayed used_percent DECREASE beyond display jitter inside one reset
// boundary is a genuine reset (banked or automatic): the drift accumulation
// re-anchors rather than reading the drop as movement.
const RESET_DECREASE_THRESHOLD_PP = 5;

function sameResetBoundary(before, after) {
  if (!before || !after) return false;
  const beforeMs = Date.parse(before);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) {
    // An unparseable boundary carries no tolerance to reason about, so fall
    // back to demanding that the provider repeated itself verbatim.
    return before === after;
  }
  return Math.abs(afterMs - beforeMs) <= RESET_BOUNDARY_TOLERANCE_MS;
}

function timelineCalibrationCapacity(data) {
  const capacity = data?.timeline?.allowanceCapacity;
  if (capacity?.status !== "available") return null;
  const scenario = capacity.selectedScenario;
  const selected = capacity.scenarios?.[scenario];
  const medianCapacityUsd = finite(selected?.medianCapacityUsd);
  return scenario !== null && medianCapacityUsd !== null
      && medianCapacityUsd > 0
    ? {
      scenario,
      basisId: selected.basisId,
      medianCapacityUsd,
    }
    : null;
}

function timelineAllowanceWeightedCost(row, capacitySelection) {
  const weighting = row?.allowanceWeighting;
  return capacitySelection !== null
      && weighting?.status === "complete"
      && weighting.selectedScenario === capacitySelection.scenario
      && weighting.scenarios?.[capacitySelection.scenario]?.basisId
        === capacitySelection.basisId
    ? finite(weighting.selectedUsd)
    : null;
}

function timelineComparisonInterval(data, startMs, endMs) {
  // Legacy DTOs have no plan-selection contract. A selected-plan view must
  // positively cover the entire span; absence is not evidence of continuity.
  if (!data.allowancePlanSelection) return null;
  const intervals = data.timeline.comparisonIntervals ?? [];
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle][0] <= startMs) low = middle + 1;
    else high = middle;
  }
  const interval = intervals[low - 1];
  return interval && endMs <= interval[1] ? interval : false;
}

// Reset classification comes from the validated companion DTO. Quota boundary
// events follow the selected main weekly plan; credits belong to the account
// and are explicitly labelled that way in the Horizon inspection text.
function timelineTypedResetEvents(data) {
  const planType = data.allowancePlanSelection?.planType ?? data.weekly?.planType;
  return (data.timeline.resetEvents ?? []).flatMap(event => {
    const lifecycle = event.kind === "reset_credit_granted" || event.kind === "reset_credit_expired";
    if (!lifecycle && (event.planType !== planType || !isPrimaryCodexWeeklyQuotaWindow({
      limitId: event.limitId, durationMinutes: event.windowDurationMins,
    }))) return [];
    return [{ ...event,
      // An interval observation cannot provide an exact reset instant. Locate
      // its marker at the confirming observation and show both interval ends.
      timestampMs: Date.parse(event.precision === "observation_interval" ? event.observedAt : event.occurredAt),
      observedAtMs: Date.parse(event.observedAt),
      intervalStartedAtMs: Date.parse(event.intervalStartedAt),
    }];
  });
}

function liveTimelinePoints(
  data,
  {
    windowHours = CALIBRATION_WINDOW_HOURS,
    rangeDays = activeCalibrationRangeDays,
    usage = allowanceTimelineUsage(data),
  } = {},
) {
  const capacitySelection = timelineCalibrationCapacity(data);
  const capacity = capacitySelection?.medianCapacityUsd ?? null;
  if (!usage.length) return [];
  const windowMs = windowHours * 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, rangeDays);
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  // Prefix sums over the usage buckets so a shrunken window (see the
  // forward-recovery branch below) can integrate cost and events over exactly
  // the span it actually measured, instead of scaling the full-window sums.
  const usageEndsMs = usage.map((row) => Date.parse(row.endAt));
  const weightedCosts = usage.map((row) => (
    timelineAllowanceWeightedCost(row, capacitySelection)
  ));
  const costPrefix = new Float64Array(usage.length + 1);
  const weightingGapPrefix = new Uint32Array(usage.length + 1);
  const eventsPrefix = new Float64Array(usage.length + 1);
  for (let index = 0; index < usage.length; index += 1) {
    costPrefix[index + 1] = costPrefix[index]
      + (weightedCosts[index] ?? 0);
    weightingGapPrefix[index + 1] = weightingGapPrefix[index]
      + (weightedCosts[index] === null ? 1 : 0);
    eventsPrefix[index + 1] = eventsPrefix[index] + usage[index].usageEvents;
  }
  const points = [];
  let startIndex = 0;
  let rollingCost = 0;
  let rollingWeightingGaps = 0;
  let rollingEvents = 0;
  // Cumulative drift (owner-directed, 2026-08-08): the running sum of
  // per-bucket observed-minus-expected movement since the last reset boundary
  // or track change — the same signed observed-versus-expected accumulation
  // the reporting module's signed AUC integrates (see buildRollingResidual in
  // src/simple-quota-gradient.js), expressed over NON-OVERLAPPING usage
  // buckets so the rolling windows above can never double-count an hour. The
  // sum re-anchors at each boundary: within one reset it answers "how far
  // ahead of the cost-implied line has observed quota movement run since this
  // reset began". Honesty guards: no capacity or no quota row means no value,
  // and a stale quota bracket suspends the line rather than letting a static
  // observation read as growing negative drift.
  let driftAnchor = null;
  let driftCostUsd = 0;
  let comparisonSegment = 0;
  let previousComparable = false;
  let previousPlanInterval = null;
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    const currentWeightedCost = weightedCosts[index];
    const planInterval = timelineComparisonInterval(data, Date.parse(current.startAt), endMs);
    if (planInterval === false || planInterval !== previousPlanInterval) {
      driftAnchor = null;
      driftCostUsd = 0;
    }
    previousPlanInterval = planInterval;
    if (currentWeightedCost === null) rollingWeightingGaps += 1;
    else rollingCost += currentWeightedCost;
    rollingEvents += current.usageEvents;
    if (currentWeightedCost === null) {
      // A missing or basis-mismatched bucket is a hard break. No rolling
      // comparison or cumulative residual may bridge an unweighted interval.
      driftAnchor = null;
      driftCostUsd = 0;
    } else if (driftAnchor !== null) {
      driftCostUsd += currentWeightedCost;
    }
    while (startIndex <= index
        && Date.parse(usage[startIndex].endAt) <= endMs - windowMs) {
      const expiredWeightedCost = weightedCosts[startIndex];
      if (expiredWeightedCost === null) rollingWeightingGaps -= 1;
      else rollingCost -= expiredWeightedCost;
      rollingEvents -= usage[startIndex].usageEvents;
      startIndex += 1;
    }
    if (endMs < cutoff || endMs > Date.parse(data.reportingWindow?.endAt ?? "9999-12-31")) continue;
    const startMs = endMs - windowMs;
    const afterMatch = quotaLookup.atOrBefore(endMs);
    const maximumBracketGapMs = Math.max(30 * 60 * 1_000, windowMs);
    // The start edge prefers a backward observation, like the end edge. But
    // backward-only matching poisons every window whose start edge falls in a
    // collection silence (sleep or idle): the first ~windowMs of the next
    // work session would reach back into the silence and be excluded even
    // though observations exist just inside the window. When no backward
    // match lands within the gap, anchor on the earliest observation inside
    // the window instead and shrink the measured span to what the two
    // observations actually cover; the cost-implied side below integrates
    // the same shrunken span, so observed and expected stay commensurable.
    // A recovered span needs TWO distinct observations: with a single one,
    // the end anchor resolves to the same row as the start anchor, observed
    // is zero by construction over a zero-length span, and any cost in the
    // window would fabricate a negative residual nobody measured — so that
    // window stays honestly unbracketed.
    let startMatch = quotaLookup.atOrBefore(startMs);
    let spanStartMs = startMs;
    let spanEndMs = endMs;
    let shrunkenSpan = false;
    if (!(startMatch && startMs - startMatch.timestampMs <= maximumBracketGapMs)) {
      const forwardMatch = quotaLookup.atOrAfter(startMs);
      if (forwardMatch && forwardMatch.timestampMs < endMs
          && afterMatch && afterMatch.timestampMs > forwardMatch.timestampMs) {
        startMatch = forwardMatch;
        spanStartMs = forwardMatch.timestampMs;
        // Observed movement ends at the end-edge observation, not at the
        // bucket boundary: integrate the expected side to the same instant.
        spanEndMs = afterMatch.timestampMs;
        shrunkenSpan = true;
      } else {
        startMatch = null;
      }
    }
    const before = startMatch?.row ?? null;
    const after = afterMatch?.row ?? null;
    const planComparable = timelineComparisonInterval(data,
      Math.min(spanStartMs, startMatch?.timestampMs ?? spanStartMs),
      Math.max(spanEndMs, afterMatch?.timestampMs ?? spanEndMs)) !== false;
    const bracketed = before && after
      && planComparable
      && spanStartMs - startMatch.timestampMs <= maximumBracketGapMs
      && endMs - afterMatch.timestampMs <= maximumBracketGapMs;
    const sameReset = Boolean(bracketed)
      && sameResetBoundary(before.resetAt, after.resetAt);
    // Pool saturated: the window STARTS at the ceiling, so the display
    // cannot move no matter what the workload costs. Both series suspend —
    // a zero observed against a live expected here is not a measurement.
    //
    // Gated on `bracketed`, NOT on `sameReset`. Exhausting a pool spawns a
    // fresh pool carrying a new `resets_at`, so a window that starts pegged
    // almost always ends on a different boundary; requiring `sameReset` here
    // made saturation unobservable in exactly the case it exists to describe,
    // and every such window was booked as a plain track change instead. This
    // also restores parity with the local pipeline, which has always read
    // saturation off the start edge alone (`src/simple-quota-gradient.js`).
    // `observed` already required `sameReset`, so no window changes from
    // measured to suspended — only the label it is suspended under.
    const poolSaturated = Boolean(bracketed)
      && before.usedPercent >= POOL_SATURATION_CEILING_PP;
    const observed = !poolSaturated
        && sameReset
        && after.usedPercent >= before.usedPercent
      ? after.usedPercent - before.usedPercent
      : null;
    let windowCostUsd = Math.max(0, rollingCost);
    let windowWeightingGaps = rollingWeightingGaps;
    let windowEvents = Math.max(0, rollingEvents);
    if (shrunkenSpan) {
      // Only the usage buckets ending inside the measured span count, so the
      // expected line integrates the interval the observed delta covers —
      // (spanStartMs, spanEndMs], both edges pinned to real observations.
      let lower = startIndex;
      let upper = index + 1;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (usageEndsMs[middle] <= spanStartMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      let top = lower;
      let topUpper = index + 1;
      while (top < topUpper) {
        const middle = top + Math.floor((topUpper - top) / 2);
        if (usageEndsMs[middle] <= spanEndMs) {
          top = middle + 1;
        } else {
          topUpper = middle;
        }
      }
      windowCostUsd = Math.max(0, costPrefix[top] - costPrefix[lower]);
      windowWeightingGaps = weightingGapPrefix[top]
        - weightingGapPrefix[lower];
      windowEvents = Math.max(0, eventsPrefix[top] - eventsPrefix[lower]);
    }
    const expected = !poolSaturated
        && planComparable
        && capacity !== null && capacity > 0
        && windowWeightingGaps === 0
      ? windowCostUsd / capacity * 100
      : null;
    const classifiedEvidence = classifyTimelineEvidence({
      bracketed,
      sameReset,
      observed,
      expected,
      usageEvents: windowEvents,
      apiCostUsd: windowWeightingGaps === 0 ? windowCostUsd : 0,
      poolSaturated,
    });
    const evidence = !planComparable
      ? { status: "reset_or_track_change", residual: null }
      : windowWeightingGaps === 0 ? classifiedEvidence
        : { status: "quota_weighting_unavailable", residual: null };
    let cumulativeResidual = null;
    // A re-anchor marks the first drift observation of a new reset or track:
    // the deviation-period detector splits its runs here, so a sustained drift
    // that crosses a boundary is never read as one continuous period across the
    // reset. Stamped on the point so the flag survives viewport filtering.
    let driftReanchor = false;
    let resetEvent = null;
    if (capacity !== null && capacity > 0
        && currentWeightedCost !== null
        && after !== null
        && timelineComparisonInterval(data,
          Math.min(Date.parse(current.startAt), afterMatch.timestampMs), endMs) !== false
        && Number.isFinite(finite(after.usedPercent))
        && endMs - afterMatch.timestampMs <= maximumBracketGapMs) {
      // A used_percent DECREASE beyond display jitter inside one boundary is
      // a genuine reset (banked/automatic resets keep resets_at) — but ONLY
      // when a SECOND, distinct observation confirms it. A single sub-envelope
      // reading that immediately recovers is a stale interleaved source (the
      // composition kernel's rule; live-corpus precedent 59 -> 6 -> 61), and
      // re-anchoring on it would poison the baseline so the recovery reads as
      // a fabricated +50pp drift period.
      const boundaryChanged = driftAnchor === null
        || !sameResetBoundary(driftAnchor.resetAt, after.resetAt);
      const subEnvelope = !boundaryChanged
        && after.usedPercent
          < driftAnchor.maxUsedPercent - RESET_DECREASE_THRESHOLD_PP;
      const confirmedReset = subEnvelope
        && driftAnchor.pendingDrop !== null
        && afterMatch.timestampMs !== driftAnchor.pendingDrop.timestampMs
        && after.usedPercent
          <= driftAnchor.pendingDrop.usedPercent + RESET_DECREASE_THRESHOLD_PP;
      if (boundaryChanged || confirmedReset) {
        // Expose the existing anchor decision; do not classify scheduled/banked
        // resets without provider evidence. Initial anchors and recovery after
        // missing pricing or a plan transition are not reset events.
        if (driftAnchor !== null) {
          resetEvent = {
            timestampMs: confirmedReset ? driftAnchor.pendingDrop.timestampMs : afterMatch.timestampMs,
            confirmedAtMs: afterMatch.timestampMs,
            kind: confirmedReset || after.usedPercent < driftAnchor.maxUsedPercent - RESET_DECREASE_THRESHOLD_PP
              ? "observed_reset" : "window_change",
          };
        }
        // A boundary or track change re-anchors the accumulation: drift is
        // zero by definition at the first observation of a new reset.
        driftAnchor = {
          resetAt: after.resetAt,
          usedPercent: after.usedPercent,
          maxUsedPercent: after.usedPercent,
          pendingDrop: null,
        };
        driftCostUsd = 0;
        cumulativeResidual = 0;
        driftReanchor = true;
      } else if (subEnvelope) {
        // First (or non-confirming) sub-envelope observation: either a stale
        // source or the first sight of a reset — unmeasurable against this
        // anchor either way, so the accumulation suspends for this point
        // (null splits detector runs) instead of booking the dip as drift.
        if (driftAnchor.pendingDrop === null
            || afterMatch.timestampMs !== driftAnchor.pendingDrop.timestampMs) {
          driftAnchor.pendingDrop = {
            usedPercent: after.usedPercent,
            timestampMs: afterMatch.timestampMs,
          };
        }
        if (driftAnchor.maxUsedPercent >= POOL_SATURATION_CEILING_PP) {
          // Still inside a pegged span: keep post-peg cost out of the
          // accumulation exactly as the saturated branch below does.
          driftCostUsd -= currentWeightedCost;
        }
        cumulativeResidual = null;
      } else if (driftAnchor.maxUsedPercent >= POOL_SATURATION_CEILING_PP) {
        driftAnchor.pendingDrop = null;
        // The pool pegged earlier in this reset: post-peg cost cannot be
        // measured against a display that can no longer move. Suspend the
        // accumulation (null splits detector runs) and keep the accrued cost
        // out of it, so a later re-anchor starts clean.
        driftCostUsd -= currentWeightedCost;
        cumulativeResidual = null;
      } else {
        // Recovery or normal movement clears any unconfirmed drop candidate.
        driftAnchor.pendingDrop = null;
        driftAnchor.maxUsedPercent = Math.max(
          driftAnchor.maxUsedPercent,
          after.usedPercent,
        );
        cumulativeResidual = after.usedPercent - driftAnchor.usedPercent
          - driftCostUsd / capacity * 100;
      }
    }
    const comparable = observed !== null && expected !== null;
    if (comparable && !previousComparable) comparisonSegment += 1;
    previousComparable = comparable;
    points.push({
      timestamp: current.endAt,
      timestampMs: endMs,
      observed,
      expected,
      residual: evidence.residual,
      cumulativeResidual,
      driftReanchor,
      resetEvent,
      // Kept under the legacy internal key for downstream chart diagnostics,
      // but this is now the selected speed-priced amount, never Standard
      // dollars paired with a Fast-adjusted capacity.
      apiCostUsd: planComparable && windowWeightingGaps === 0 ? windowCostUsd : null,
      allowanceWeightedUsd: planComparable && windowWeightingGaps === 0
        ? windowCostUsd
        : null,
      allowanceBasisId: capacitySelection?.basisId ?? null,
      residualSegment: comparable ? comparisonSegment : null,
      usageEvents: windowEvents,
      // The span both lines actually integrate: the nominal window unless the
      // start edge was recovered forward past a collection silence, in which
      // case both edges sit on real observations.
      measuredSpanMs: spanEndMs - spanStartMs,
      status: evidence.status,
    });
  }
  return points;
}

function groupedUsageTimeline(data) {
  const capacitySelection = timelineCalibrationCapacity(data);
  const hourMs = 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, activeUsageRangeDays);
  const groups = new Map();
  for (const row of allowanceTimelineUsage(data)) {
    const timestamp = Date.parse(row.startAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff
        || Date.parse(row.endAt) > Date.parse(data.reportingWindow?.endAt ?? "9999-12-31")) continue;
    let key;
    let sortMs;
    if (activeUsageGrouping === "hour") {
      sortMs = Math.floor(timestamp / hourMs) * hourMs;
      key = `hour:${sortMs}`;
    } else {
      const parts = Object.fromEntries(
        localCalendarParts().formatToParts(timestamp)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );
      const civilDayMs = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day)
      );
      sortMs = activeUsageGrouping === "week"
        ? civilDayMs - ((new Date(civilDayMs).getUTCDay() + 6) % 7) * 24 * hourMs
        : civilDayMs;
      key = `${activeUsageGrouping}:${new Date(sortMs).toISOString().slice(0, 10)}`;
    }
    const rowStartMs = Date.parse(row.startAt);
    const rowEndMs = Date.parse(row.endAt);
    const group = groups.get(key) ?? {
      sortMs,
      periodStartMs: rowStartMs,
      periodEndMs: rowEndMs,
      standardApiCostUsd: 0,
      quotaWeightedCostUsd: 0,
      weightingGaps: 0,
      usageEvents: 0,
      totalTokens: 0
    };
    group.periodStartMs = Math.min(group.periodStartMs, rowStartMs);
    group.periodEndMs = Math.max(group.periodEndMs, rowEndMs);
    group.standardApiCostUsd += row.apiPriceEquivalentUsd;
    const weighted = timelineAllowanceWeightedCost(row, capacitySelection);
    if (weighted === null) group.weightingGaps += 1;
    else group.quotaWeightedCostUsd += weighted;
    group.usageEvents += row.usageEvents;
    group.totalTokens += row.totalTokens;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.sortMs - right.sortMs)
    .map(({ sortMs: _sortMs, periodStartMs, periodEndMs, ...row }) => {
      const quotaWeightedCostUsd = row.weightingGaps === 0
        ? Number(row.quotaWeightedCostUsd.toFixed(6))
        : null;
      return {
        ...row,
        timestamp: new Date(periodEndMs).toISOString(),
        timestampMs: periodEndMs,
        periodStartAt: new Date(periodStartMs).toISOString(),
        periodEndAt: new Date(periodEndMs).toISOString(),
        standardApiCostUsd: Number(row.standardApiCostUsd.toFixed(6)),
        quotaWeightedCostUsd,
        allowanceBasisId: quotaWeightedCostUsd === null
          ? null
          : capacitySelection.basisId,
      };
    });
}

function usagePointsWithAllowance(data, points, includeAllowance) {
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  const maximumObservationAgeMs = {
    hour: 6 * 60 * 60 * 1_000,
    day: 12 * 60 * 60 * 1_000,
    week: 24 * 60 * 60 * 1_000
  }[activeUsageGrouping] ?? 6 * 60 * 60 * 1_000;
  let allowanceSegment = 0;
  let lastResetAt = null;
  return points.map((point) => {
    const endMs = Date.parse(point.periodEndAt ?? point.timestamp);
    const observationMatch = quotaLookup.atOrBefore(endMs);
    const observationAge = observationMatch
      ? endMs - observationMatch.timestampMs
      : Number.POSITIVE_INFINITY;
    const resetAt = observationMatch?.row.resetAt ?? null;
    if (lastResetAt !== null && !sameResetBoundary(lastResetAt, resetAt)) allowanceSegment += 1;
    lastResetAt = resetAt;
    return {
      ...point,
      allowanceSegment,
      allowanceObservedAt: observationMatch?.row.observedAt ?? null,
      allowanceRemaining: includeAllowance
          && point.quotaWeightedCostUsd !== null
          && observationAge <= maximumObservationAgeMs
        ? finite(observationMatch.row.remainingPercent)
        : null
    };
  });
}

function usageGroupingsForRange(rangeDays = activeUsageRangeDays) {
  if (rangeDays <= 1) return ["hour"];
  if (rangeDays <= 7) return ["hour", "day"];
  return ["hour", "day", "week"];
}

function syncUsageGroupingControls() {
  const controls = $("#usage-group-controls");
  if (!controls) return;
  const allowed = new Set(usageGroupingsForRange());
  if (!allowed.has(activeUsageGrouping)) activeUsageGrouping = "hour";
  for (const control of controls.querySelectorAll("button[data-group]")) {
    const visible = allowed.has(control.dataset.group);
    const active = visible && control.dataset.group === activeUsageGrouping;
    control.hidden = !visible;
    control.disabled = !visible;
    control.setAttribute("aria-hidden", String(!visible));
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
}

// The vertical axis has to state its unit and its aggregation together: the
// same series is dollars per hour, per day, or per week depending on the
// selected grouping, and "API equivalent" alone said neither.
const USAGE_GROUPING_UNIT_KEYS = Object.freeze({
  hour: "chart.unit.hour",
  day: "chart.unit.day",
  week: "chart.unit.week",
});

const USAGE_GROUPING_AXIS_KEYS = Object.freeze({
  hour: "chart.axis.apiEquivalentPerHour",
  day: "chart.axis.apiEquivalentPerDay",
  week: "chart.axis.apiEquivalentPerWeek",
});

function usageGroupingUnitKey(grouping = activeUsageGrouping) {
  return USAGE_GROUPING_UNIT_KEYS[grouping] ?? "chart.unit.interval";
}

function usageChartAxisLabels(
  grouping = activeUsageGrouping,
  quotaWeighted = true,
) {
  return Object.freeze({
    primary: {
      key: quotaWeighted
        ? {
          hour: "chart.axis.quotaWeightedPerHour",
          day: "chart.axis.quotaWeightedPerDay",
          week: "chart.axis.quotaWeightedPerWeek",
        }[grouping] ?? "chart.axis.quotaWeightedPerInterval"
        : USAGE_GROUPING_AXIS_KEYS[grouping]
          ?? "chart.axis.apiEquivalentPerInterval",
    },
    secondary: { key: "chart.axis.sevenDayAllowanceRemaining" },
  });
}

// The usage chart's own derive/draw split, for the same reason the calibration
// chart has one: grouping every usage bucket in the artifact and matching each
// one against the quota track depends on the evidence and the two segmented
// controls, never on the zoom viewport, so a pan must not pay for it.
let usageSeriesMemo = null;

function selectedUsagePoints(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  if (usageSeriesMemo !== null
      && usageSeriesMemo.data === data
      && usageSeriesMemo.grouping === activeUsageGrouping
      && usageSeriesMemo.rangeDays === activeUsageRangeDays) {
    return usageSeriesMemo.points;
  }
  const includeAllowance = timelineCalibrationCapacity(data) !== null;
  const points = usagePointsWithAllowance(
    data,
    groupedUsageTimeline(data),
    includeAllowance,
  );
  usageSeriesMemo = {
    data,
    grouping: activeUsageGrouping,
    rangeDays: activeUsageRangeDays,
    points,
  };
  return points;
}

let usageRenderFrame = 0;

function scheduleUsageTimelineRender() {
  if (!dashboard) return;
  if (typeof requestAnimationFrame !== "function") {
    renderUsageTimeline(dashboard);
    renderTimeline(dashboard);
    return;
  }
  if (usageRenderFrame !== 0) return;
  usageRenderFrame = requestAnimationFrame(() => {
    usageRenderFrame = 0;
    if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
  });
}

function resetUsageTimelineViewport() {
  timelineViewport = null;
  usageTimelineViewport = null;
}

function completeUsageTimelineTotal(points, key) {
  let total = 0;
  for (const point of points) {
    const value = finite(point?.[key]);
    if (value === null) return null;
    total += value;
  }
  return total;
}

function renderUsageTimeline(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  syncUsageGroupingControls();
  const points = selectedUsagePoints(data);
  const viewport = withChartViewport(
    USAGE_CHART_VIEWPORT,
    () => normalizeTimelineViewport(points),
  );
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const shell = $("#usage-timeline-chart");
  const empty = $("#usage-timeline-empty");
  const unit = t(usageGroupingUnitKey());
  const quotaComparable = timelineCalibrationCapacity(data) !== null;
  const axisLabels = usageChartAxisLabels(activeUsageGrouping, quotaComparable);
  const unavailable = accountingIsUnavailable(data);
  setLocalizedText(
    $("#usage-cost-legend-label"),
    quotaComparable
      ? "chart.series.quotaWeightedUsage"
      : "chart.series.standardApiUsage",
  );
  $("#usage-allowance-legend").hidden = !quotaComparable;
  // The shared header owns the reporting period; a numerical "All" sentinel
  // must never become a user-visible duration in a chart heading.
  setLocalizedText(
    $("#usage-timeline-title"),
    "trends.allowanceActivity",
  );
  const allowanceShell = $("#allowance-timeline-chart");
  const hasAllowance = visiblePoints.some(point => finite(point.allowanceRemaining) !== null);
  allowanceShell.hidden = !hasAllowance;
  $("#allowance-timeline-empty").hidden = hasAllowance;
  if (hasAllowance) drawChart(allowanceShell, lineChart({
    points: visiblePoints,
    series: [{ key: "allowanceRemaining", className: "chart-line-observed", label: { key: "trends.allowance" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY, format: value => formatPercent(value, 1),
      segmentKey: "allowanceSegment", maxGapMs: { hour: 6, day: 36, week: 192 }[activeUsageGrouping] * 3_600_000 }],
    yLabel: { key: "trends.remainingPercent" }, title: { key: "trends.allowance" },
    description: { key: "trends.allowanceDescription" },
    yDomain: { low: 0, high: 100, ticks: [0, 25, 50, 75, 100] }, height: 260, xDomain: viewport,
    width: Math.max(360, allowanceShell.clientWidth || 900),
  }));
  if (!visiblePoints.length) {
    shell.hidden = true;
    empty.hidden = false;
    empty.dataset.state = unavailable ? "unavailable" : "empty";
    empty.querySelector("strong").textContent = unavailable
      ? t(accountingRequiresNewerBuild(data)
        ? "chart.usage.newerBuildTitle"
        : "chart.usage.unavailableTitle")
      : t("chart.usage.emptyTitle");
    empty.querySelector("p").textContent = unavailable
      ? t(projectionUnavailableCopyKey(data))
      : t("chart.usage.emptyCopy");
  } else {
    shell.hidden = false;
    empty.hidden = true;
    drawChart(shell, lineChart({
      points: visiblePoints,
      series: [{
        key: quotaComparable ? "quotaWeightedCostUsd" : "standardApiCostUsd",
        className: "chart-line-value",
        label: {
          key: quotaComparable
            ? "chart.series.quotaWeightedUsage"
            : "chart.series.standardApiUsage",
        },
        // Bars carry per-interval activity; hover targets retain exact values.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        connect: false,
        format: (value) => formatApiMoney(value),
      }],
      yLabel: axisLabels.primary,
      yTickFormat: (value) => formatApiMoney(value),
      title: {
        key: quotaComparable
          ? "chart.usage.title"
          : "chart.usage.standardTitle",
      },
      description: {
        key: quotaComparable
          ? "chart.usage.description"
          : "chart.usage.standardDescription",
        values: { unit, timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 150,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: viewport,
    }));
    bindUsageTimelineInteractions(shell, points, viewport);
  }
  setLocalizedText($("#usage-timeline-copy"), "chart.timeZoneNote", {
    timeZone: formatTimeZoneLabel(),
  });
  renderSeriesCoverage(
    $("#usage-timeline-coverage"),
    data,
    activeUsageRangeDays,
  );
  const summary = $("#usage-timeline-summary");
  clear(summary);
  // The plotted weighted series already renders a missing interval as a gap.
  // Its summary must do the same: adding only finite points would publish a
  // deceptively partial allowance-facing aggregate.
  const total = unavailable && visiblePoints.length === 0
    ? null
    : completeUsageTimelineTotal(
      visiblePoints,
      quotaComparable ? "quotaWeightedCostUsd" : "standardApiCostUsd",
    );
  for (const [name, explanation, value] of [
    [
      "Time intervals",
      "The number of displayed hour, day, or week intervals.",
      unavailable && visiblePoints.length === 0
        ? "—"
        : compact(visiblePoints.length)
    ],
    [
      quotaComparable
        ? "Speed-priced API equivalent"
        : "Standard-rate API-price equivalent",
      quotaComparable
        ? "Standard API prices with Fast and Ultrafast increments priced at their published API rates, compared only with a capacity fitted on the same basis. This is a comparison, not a bill or included-allowance formula."
        : "A Standard-rate accounting series. Provider allowance is hidden because no matching weighted capacity is available.",
      total === null ? "—" : formatApiMoney(total)
    ]
  ]) {
    const item = node("div");
    const label = node("span");
    label.append(informationLabel(name, explanation));
    item.append(label, node("strong", "", value));
    summary.append(item);
  }
}

/**
 * Wheel, drag, and keyboard zoom for the usage chart.
 *
 * This is deliberately the same gesture vocabulary as the calibration chart
 * below it — wheel to zoom about the pointer, drag to pan, `+`/`-` and the
 * arrow keys from the keyboard, `Home` to reset — and it reaches the same
 * `zoomTimeline` and `panTimeline` policy, so both charts move by identical
 * steps and clamp identically. It is a separate binder rather than a shared one
 * because it targets a different element with its own pointer state and its own
 * viewport; the behaviour that has to stay uniform lives in the functions both
 * binders call, not in the wiring.
 */
function bindUsageTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", t("chart.usage.aria", {
    timeZone: USER_TIME_ZONE,
  }));
  setLocalizedText($("#usage-zoom-status"), "dashboard.timeline.status", {
    start: formatLocal(new Date(viewport.startMs).toISOString()),
    end: formatLocal(new Date(viewport.endMs).toISOString()),
    span: formatSpanLength(viewport.endMs - viewport.startMs),
  });
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomUsageTimeline(points, wheelZoomFactor(event), ratio);
  };
  shell.onpointerdown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    usagePointerStart = { x: event.clientX, dragging: false };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-pointer-active");
  };
  shell.onpointermove = (event) => {
    if (usagePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - usagePointerStart.x;
    if (Math.abs(delta) < 8) return;
    usagePointerStart.dragging = true;
    usagePointerStart.x = event.clientX;
    shell.classList.add("is-panning");
    event.preventDefault();
    panUsageTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    const wasDragging = usagePointerStart?.dragging === true;
    usagePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-pointer-active");
    shell.classList.remove("is-panning");
    if (wasDragging) event.preventDefault();
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
  shell.onselectstart = (event) => {
    if (usagePointerStart !== null) event.preventDefault();
  };
  shell.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoomUsageTimeline(points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
    } else if (["-", "_"].includes(event.key)) {
      event.preventDefault();
      zoomUsageTimeline(points, TIMELINE_BUTTON_ZOOM_STEP);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panUsageTimeline(points, -.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panUsageTimeline(points, .2);
    } else if (event.key === "Home") {
      event.preventDefault();
      resetUsageTimelineViewport();
      scheduleUsageTimelineRender();
    }
  };
}

function zoomUsageTimeline(points, factor, anchorRatio = .5) {
  withChartViewport(
    USAGE_CHART_VIEWPORT,
    () => zoomTimeline(points, factor, anchorRatio),
  );
}

function panUsageTimeline(points, fraction) {
  withChartViewport(USAGE_CHART_VIEWPORT, () => panTimeline(points, fraction));
}

/**
 * Deriving the calibration series is the expensive half of this page: it walks
 * every usage bucket in the artifact to rebuild the rolling window, builds a
 * quota lookup, and classifies each window's evidence state. None of that
 * depends on the zoom or pan viewport — only on the loaded evidence and the
 * date-range control above the chart — yet it ran again for every wheel event,
 * which is what made the chart feel heavy to drag.
 *
 * The result is remembered against exactly the inputs it is a function of. The
 * dashboard payload is compared by identity, so a refresh that produces a new
 * object invalidates the memo without any explicit clearing, and a payload that
 * has not changed cannot serve a stale series.
 */
let timelineSeriesMemo = null;

function selectedTimelinePoints(data) {
  if (timelineSeriesMemo !== null
      && timelineSeriesMemo.data === data
      && timelineSeriesMemo.rangeDays === activeCalibrationRangeDays) {
    return timelineSeriesMemo.selection;
  }
  const scopedUsage = allowanceTimelineUsage(data);
  // Side-chat estimates predate plan-era attribution. They remain visible in
  // all-plan accounting, but cannot enter a current-plan numerator until they
  // carry the same plan/generation scope as the exact usage timeline.
  const sideChatAdjusted = !data.allowancePlanSelection
    && data.accounting?.sideChatEstimates?.status
      === "available"
    && data.accounting.sideChatEstimates.methodology
      ?.includedInCalibrationTimeline === true
    && Array.isArray(data.timeline.calibrationUsage)
    && data.timeline.calibrationUsage.length > 0;
  const exactByBucket = new Map(scopedUsage.map((row) => [
    `${row.startAt}|${row.endAt}`,
    row,
  ]));
  // Keep the comparison on identical timestamps. A side-chat-only bucket is
  // represented by a zero-cost baseline row so a changed sampling grid cannot
  // masquerade as a changed area under the residual curve.
  const alignedExactUsage = sideChatAdjusted
    ? data.timeline.calibrationUsage.map((row) => (
      exactByBucket.get(`${row.startAt}|${row.endAt}`) ?? {
        ...row,
        usageEvents: 0,
        totalTokens: 0,
        apiPriceEquivalentUsd: 0,
        allowanceWeighting: {
          status: data.timeline.allowanceCapacity?.status === "available"
            ? "complete"
            : data.timeline.allowanceCapacity?.status === "range"
              ? "range"
              : "unavailable",
          basisFamilyId: row.allowanceWeighting.basisFamilyId,
          selectedScenario:
            data.timeline.allowanceCapacity?.selectedScenario ?? null,
          selectedUsd:
            data.timeline.allowanceCapacity?.status === "available" ? 0 : null,
          scenarios: Object.fromEntries(Object.entries(
            row.allowanceWeighting.scenarios,
          ).map(([scenario, value]) => [scenario, {
            ...value,
            sourceWeightingStatus: "complete",
            quotaWeightedUsd: 0,
            coveredSubtotalUsd: 0,
            coverage: {
              totalEvents: 0,
              observedEvents: 0,
              declaredFromConfigEvents: 0,
              assumedEvents: 0,
              inferredEvents: 0,
              unknownEvents: 0,
              observedSharePercent: null,
              unknownSharePercent: null,
            },
          }])),
          rangeUsd: data.timeline.allowanceCapacity?.status === "range"
            ? { lower: 0, upper: 0 }
            : null,
        },
      }
    ))
    : [];
  const exactLivePoints = sideChatAdjusted
    ? liveTimelinePoints(data, { usage: alignedExactUsage })
    : [];
  const livePoints = liveTimelinePoints(data, {
    usage: sideChatAdjusted
      ? data.timeline.calibrationUsage
      : scopedUsage,
  });
  // Retained gradient artifacts carry only Standard-rate rolling cost. They
  // can remain historical evidence elsewhere, but may never replace the
  // speed-priced allowance comparison. An unavailable weighted live series
  // therefore stays unavailable instead of silently drawing the old red line.
  const selection = {
    points: livePoints,
    baselinePoints: exactLivePoints,
    usingLive: true,
    sideChatAdjusted,
  };
  timelineSeriesMemo = {
    data,
    rangeDays: activeCalibrationRangeDays,
    selection,
  };
  return selection;
}

let spendRateMemo = null;
function selectedSpendRateLookup(data) {
  if (spendRateMemo?.data === data) return spendRateMemo.lookup;
  const capacity = timelineCalibrationCapacity(data);
  const buckets = allowanceTimelineUsage(data).map(row => ({
    startMs: Date.parse(row.startAt), endMs: Date.parse(row.endAt),
    usd: timelineAllowanceWeightedCost(row, capacity),
  }));
  const lookup = createSpendRateLookup(buckets, {
    intervals: data.allowancePlanSelection ? data.timeline.comparisonIntervals ?? [] : undefined,
    // The plan-scoped contract publishes fixed fifteen-minute buckets even
    // when the legacy all-plan timeline uses a different grouping.
    bucketMs: data.allowancePlanSelection ? 900_000 : (data.timeline.bucketMinutes ?? 15) * 60_000,
  });
  spendRateMemo = { data, lookup };
  return lookup;
}

function renderTimeline(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  const {
    points,
    baselinePoints,
    usingLive,
    sideChatAdjusted,
  } = selectedTimelinePoints(data);
  const usageBounds = timelineBounds(selectedUsagePoints(data));
  const viewport = usageTimelineViewport ?? timelineViewport ?? usageBounds ?? normalizeTimelineViewport(points);
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const visibleBaselinePoints = timelinePointsInViewport(
    baselinePoints,
    viewport,
  );
  const matchedVisible = visiblePoints.filter(
    (point) => point.observed !== null && point.expected !== null,
  );
  const windowLabel = t("dashboard.timeWindow.hours", {
    count: CALIBRATION_WINDOW_HOURS,
  });
  setLocalizedText($("#timeline-chart-title"), "dashboard.timeline.title", {
    window: windowLabel,
  });
  $("#timeline-chart-copy").textContent = usingLive
    ? t(
      sideChatAdjusted
        ? "dashboard.timeline.liveCopySideChatAdjusted"
        : "dashboard.timeline.liveCopy",
      { timeZone: formatTimeZoneLabel() },
    )
    : t("dashboard.timeline.historicalCopy", {
      generatedAt: formatLocal(data.artifactStatus.gradient.generatedAt),
      window: windowLabel,
    });
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  const unavailable = accountingIsUnavailable(data);
  if (!visiblePoints.length || (usingLive && matchedVisible.length === 0)) {
    shell.hidden = true;
    empty.hidden = false;
    empty.dataset.state = unavailable ? "unavailable" : "empty";
    empty.querySelector("strong").textContent = unavailable
      ? t(accountingRequiresNewerBuild(data)
        ? "dashboard.timeline.newerBuildTitle"
        : "dashboard.timeline.unavailableTitle")
      : visiblePoints.length
        ? t("dashboard.timeline.notComparableYet")
        : tPlural("dashboard.timeline.series", 0, { window: windowLabel });
    empty.querySelector("p").textContent = unavailable
      ? t(projectionUnavailableCopyKey(data))
      : data.allowancePlanSelection?.comparisonAvailable === false
        ? t("weekly.plan.comparisonPending")
      : visiblePoints.length
        ? t("dashboard.timeline.noBracket", { window: windowLabel })
        : t("dashboard.timeline.missingData");
  } else {
    empty.hidden = true;
    shell.hidden = false;
    drawChart(shell, lineChart({
      points: visiblePoints,
      series: [
        {
          key: "observed",
          className: "chart-line-observed",
          label: { key: "dashboard.timeline.observedQuota" },
          segmentKey: "residualSegment",
          pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
          format: formatPp,
        },
        {
          key: "expected",
          className: "chart-line-expected",
          label: { key: "dashboard.timeline.expectedCost" },
          segmentKey: "residualSegment",
          pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
          format: formatPp,
        }
      ],
      yLabel: { key: "dashboard.timeline.percentagePoints" },
      title: {
        key: "dashboard.timeline.movementTitle",
        values: { window: windowLabel },
      },
      description: {
        key: "dashboard.timeline.chartDescription",
        values: { timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 270,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
    }));
    bindTimelineInteractions(shell, selectedUsagePoints(data).length > 1 ? selectedUsagePoints(data) : points, viewport);
  }
  renderSeriesCoverage(
    $("#timeline-coverage"),
    data,
    activeCalibrationRangeDays,
  );
  renderTimelineSummary(data, visiblePoints, visibleBaselinePoints, usingLive);
  renderTimelineConfidence(data, points, visiblePoints, usingLive, viewport);
  const differenceShell = $("#difference-timeline-chart");
  const differenceLimit = visiblePoints.reduce((maximum, point) => Math.max(maximum, Math.abs(finite(point.residual, 0))), 1) * 1.1;
  differenceShell.hidden = shell.hidden;
  if (!shell.hidden) drawChart(differenceShell, lineChart({
    points: visiblePoints,
    series: [{ key: "residual", className: "chart-line-value", label: { key: "trends.difference" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY, format: formatPp, connect: false }],
    yLabel: { key: "dashboard.timeline.percentagePoints" }, title: { key: "trends.difference" },
    description: { key: "trends.differenceDescription" }, includeZero: true, height: 125, xDomain: viewport,
    width: Math.max(360, differenceShell.clientWidth || 900),
    yDomain: { low: -differenceLimit, high: differenceLimit },
  }));
  renderResiduals(data, visiblePoints, viewport);
  // The divergence panel reads the whole selected calibration range, not the
  // zoomed viewport: it answers "across this range, where did observed and
  // priced usage persistently disagree", so pan and zoom must not reshape it.
  renderDivergencePeriods(data, points);
  trendsHorizonView?.setSpendLookup(selectedSpendRateLookup(data));
  // The instrument reads observations, not the end-of-hour/day chart buckets.
  // Incompatible intervals explicitly interrupt the sample stream.
  trendsHorizonView?.setAllowanceSamples(mainWeeklyQuotaTrack(data.timeline.quota).map(row => {
    const timestampMs = Date.parse(row.observedAt);
    return { timestampMs, allowanceRemaining:
      timelineComparisonInterval(data, timestampMs, timestampMs) !== false
        ? finite(row.remainingPercent) : null };
  }));
  trendsHorizonView?.setEvents(timelineTypedResetEvents(data));
  trendsHorizonView?.refresh();
}

// The copy names each exclusion mechanism that actually fired, in classifier
// order. A mechanism with zero windows is never mentioned, so the sentence
// cannot claim ambiguity (or anything else) that did not occur.
const TIMELINE_EXCLUSION_MESSAGE_KEYS = Object.freeze([
  ["quota_weighting_unavailable", "dashboard.timeline.excludedQuotaWeighting"],
  ["missing_quota_bracket", "dashboard.timeline.excludedMissingBracket"],
  ["reset_or_track_change", "dashboard.timeline.excludedResetOrTrackChange"],
  ["backward_or_ambiguous", "dashboard.timeline.excludedAmbiguousMovement"],
  ["pool_saturated", "dashboard.timeline.excludedPoolSaturated"],
]);

function describeTimelineExclusions(activePoints) {
  const counts = new Map();
  for (const point of activePoints) {
    if (point.observed !== null && point.expected !== null) continue;
    counts.set(point.status, (counts.get(point.status) ?? 0) + 1);
  }
  const described = TIMELINE_EXCLUSION_MESSAGE_KEYS
    .filter(([status]) => (counts.get(status) ?? 0) > 0)
    .map(([status, key]) => tPlural(key, counts.get(status)))
    .join(t("dashboard.timeline.exclusionJoin"));
  return described === "" ? t("dashboard.timeline.noExclusions") : described;
}

function renderTimelineConfidence(
  data,
  allPoints,
  visiblePoints,
  usingLive,
  viewport,
) {
  const element = $("#timeline-confidence");
  if (accountingIsUnavailable(data)) {
    element.classList.add("low");
    setLocalizedText(element, projectionUnavailableCopyKey(data));
    return;
  }
  if (data.allowancePlanSelection?.comparisonAvailable === false) {
    element.classList.add("low");
    setLocalizedText(element, "weekly.plan.comparisonPending");
    return;
  }
  const activePoints = visiblePoints.filter((point) => point.status !== "inactive");
  const matched = activePoints.filter((point) => point.observed !== null && point.expected !== null).length;
  const excluded = activePoints.length - matched;
  const full = timelineBounds(allPoints);
  const zoomed = viewport !== null && full !== null
    && (viewport.startMs !== full.startMs || viewport.endMs !== full.endMs);
  element.classList.toggle("low", matched < 3 || excluded > matched);
  if (!visiblePoints.length) {
    setProductText(
      element,
      "No points fall inside this zoomed interval. Reset the view to return to the available evidence.",
    );
  } else if (activePoints.length === 0) {
    setProductText(
      element,
      "No local activity or provider-reported quota movement occurred in this interval.",
    );
  } else if (!usingLive) {
    setProductText(
      element,
      "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.",
    );
  } else if (matched < 3) {
    setLocalizedText(element, "dashboard.timeline.lowConfidence", {
      visible: tPlural("dashboard.timeline.visibleWindow", matched),
      excluded: describeTimelineExclusions(activePoints),
    });
  } else if (excluded > 0) {
    setLocalizedText(element, "dashboard.timeline.excludedShown", {
      shown: tPlural("dashboard.timeline.shownWindow", matched),
      excluded: describeTimelineExclusions(activePoints),
    });
  } else {
    setLocalizedText(element, "dashboard.timeline.allMatched", {
      visible: tPlural("dashboard.timeline.visibleWindow", matched),
    });
  }
  if (zoomed) element.textContent += ` ${t("dashboard.timeline.resetView")}`;
}

function bindTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", t("dashboard.timeline.aria", {
    timeZone: USER_TIME_ZONE,
  }));
  const status = $("#timeline-zoom-status");
  setLocalizedText(status, "dashboard.timeline.status", {
    start: formatLocal(new Date(viewport.startMs).toISOString()),
    end: formatLocal(new Date(viewport.endMs).toISOString()),
    span: formatSpanLength(viewport.endMs - viewport.startMs),
  });
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomTimeline(points, wheelZoomFactor(event), ratio);
  };
  shell.onpointerdown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    timelinePointerStart = { x: event.clientX, dragging: false };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-pointer-active");
  };
  shell.onpointermove = (event) => {
    if (timelinePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - timelinePointerStart.x;
    if (Math.abs(delta) < 8) return;
    timelinePointerStart.dragging = true;
    timelinePointerStart.x = event.clientX;
    shell.classList.add("is-panning");
    event.preventDefault();
    panTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    const wasDragging = timelinePointerStart?.dragging === true;
    timelinePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-pointer-active");
    shell.classList.remove("is-panning");
    if (wasDragging) event.preventDefault();
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
  shell.onselectstart = (event) => {
    if (timelinePointerStart !== null) event.preventDefault();
  };
  shell.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
    } else if (["-", "_"].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, TIMELINE_BUTTON_ZOOM_STEP);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panTimeline(points, -.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panTimeline(points, .2);
    } else if (event.key === "Home") {
      event.preventDefault();
      resetTimelineViewport();
      renderUsageTimeline(dashboard);
      renderTimeline(dashboard);
    }
  };
}

/**
 * The signed observed-minus-expected area under a matched residual series, in
 * percentage-point-hours. Trapezoidal over consecutive matched points, the
 * same integration buildRollingResidual performs for the artifact summary in
 * src/simple-quota-gradient.js: positive means observed quota movement ran
 * ahead of what recorded cost implies across the covered span.
 */
function signedResidualAucPpHours(matched) {
  if (!Array.isArray(matched) || matched.length < 2) return null;
  let area = 0;
  for (let index = 1; index < matched.length; index += 1) {
    const prior = matched[index - 1];
    const current = matched[index];
    if (prior.residualSegment === null
        || current.residualSegment === null
        || prior.residualSegment !== current.residualSegment) continue;
    const elapsedHours =
      (pointTimestampMs(current) - pointTimestampMs(prior)) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    area += elapsedHours
      * ((prior.observed - prior.expected) + (current.observed - current.expected))
      / 2;
  }
  return area;
}

function renderTimelineSummary(
  data,
  points,
  baselinePoints = [],
  usingLive = true,
) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === CALIBRATION_WINDOW_HOURS);
  const activePoints = points.filter((row) => row.status !== "inactive");
  const matched = activePoints.filter((row) => row.observed !== null && row.expected !== null);
  const live = usingLive;
  const unavailable = accountingIsUnavailable(data) && activePoints.length === 0;
  const liveMae = matched.length
    ? matched.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / matched.length
    : null;
  const livePeak = matched.length
    ? Math.max(...matched.map((row) => Math.abs(row.observed - row.expected)))
    : null;
  // Signed AUC over the visible matched residuals (owner-directed,
  // 2026-08-08): the trapezoidal observed-minus-expected integral in
  // pp·hours, exactly as buildRollingResidual computes it for the artifact
  // summary in src/simple-quota-gradient.js. The historical view reports the
  // artifact's own whole-history figure instead of re-deriving one.
  const liveSignedAuc = signedResidualAucPpHours(matched);
  const baselineMatched = baselinePoints.filter(
    (row) => row.status !== "inactive"
      && row.observed !== null
      && row.expected !== null,
  );
  const baselineSignedAuc = signedResidualAucPpHours(baselineMatched);
  const baselineByTimestamp = new Map(
    baselineMatched.map((row) => [row.timestamp, row]),
  );
  const sideChatMatchedOverlap = matched.filter((row) => {
    const baseline = baselineByTimestamp.get(row.timestamp);
    return baseline !== undefined
      && Math.abs(row.expected - baseline.expected) > 1e-12;
  }).length;
  const values = [
    [
      "Matched windows",
      "Windows with both observed quota movement and a comparable cost-implied movement.",
      unavailable ? "—" : compact(matched.length),
    ],
    [
      "Mean absolute error",
      "The average absolute difference between observed and cost-implied quota movement, in percentage points.",
      formatPp(live ? liveMae : sensitivity?.mae_pp ?? sensitivity?.weighted_mae_pp ?? summary.mean_absolute_error_pp),
    ],
    [
      "Peak residual",
      "The largest absolute observed-versus-calculated difference in the selected calibration view.",
      formatPp(live ? livePeak : summary.rolling_peak_absolute_residual_pp),
    ],
    [
      t("dashboard.summary.cumulativeDrift"),
      t("dashboard.summary.cumulativeDriftExplanation"),
      formatSignedPpHours(
        live ? liveSignedAuc : summary.rolling_signed_auc_pp_hours,
      ),
    ],
    [
      "Usable quota coverage",
      "The share of active windows with enough quota evidence to make a comparison.",
      activePoints.length
        ? formatPercent(matched.length / activePoints.length * 100, 1)
        : "—",
    ],
  ];
  if (live && baselineMatched.length > 0) {
    values.splice(4, 0,
      [
        t("dashboard.summary.sideChatBaseline"),
        t("dashboard.summary.sideChatBaselineExplanation"),
        formatSignedPpHours(baselineSignedAuc),
      ],
      [
        t("dashboard.summary.sideChatAdjustment"),
        t(
          sideChatMatchedOverlap > 0
            ? "dashboard.summary.sideChatAdjustmentExplanation"
            : "dashboard.summary.sideChatAdjustmentNoOverlapExplanation",
        ),
        sideChatMatchedOverlap > 0
          ? formatSignedPpHours(
            liveSignedAuc === null || baselineSignedAuc === null
              ? null
              : liveSignedAuc - baselineSignedAuc,
          )
          : t("dashboard.summary.sideChatNoMatchedOverlap"),
      ],
    );
  }
  const container = $("#timeline-summary");
  clear(container);
  for (const [label, explanation, value] of values) {
    const item = node("div");
    const labelElement = node("span");
    labelElement.append(informationLabel(label, explanation));
    item.append(labelElement, node("strong", "", value));
    container.append(item);
  }
}

function residualRows(data, points) {
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const visibleBounds = timelineBounds(points);
  const pointResiduals = points.map((row) => ({
    ...row,
    residual: row.observed === null || row.expected === null
      ? null
      : row.observed - row.expected,
  }));
  const artifactResiduals = !live && data.gradient.residual.length
    ? data.gradient.residual.map((row) => {
        const timestamp = row.timestamp ?? row.window_end_utc;
        return {
          timestamp,
          timestampMs: Date.parse(timestamp),
          observed: finite(row.observed_quota_change_pp),
          expected: finite(row.expected_quota_change_pp),
          residual: finite(row.residual_pp)
        };
      })
    : [];
  const visibleArtifactResiduals = artifactResiduals.filter((row) => {
    const timestamp = pointTimestampMs(row);
    return Number.isFinite(timestamp)
      && visibleBounds !== null
      && timestamp >= visibleBounds.startMs
      && timestamp <= visibleBounds.endMs;
  });
  const source = visibleArtifactResiduals.length
    ? visibleArtifactResiduals
    : pointResiduals;
  // Windows that cannot be differenced are kept with a null residual so the
  // chart spans the same history as the calibration chart and shows the gap,
  // instead of quietly starting at the first computable point.
  return source
    .filter((row) => {
      const timestamp = pointTimestampMs(row);
      return row.status !== "inactive"
        && Number.isFinite(timestamp)
        && (visibleBounds === null
          || (timestamp >= visibleBounds.startMs && timestamp <= visibleBounds.endMs));
    })
    .sort((a, b) => pointTimestampMs(a) - pointTimestampMs(b));
}

function residualGapReasons(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.residual !== null) continue;
    const label = row.status
      ? timelineStatusLabel(row.status)
      : "no recorded evidence state";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, total]) => `${total} ${label.toLowerCase()}`);
}

function renderResidualCoverage(rows, computed) {
  const element = $("#residual-coverage");
  const missing = rows.length - computed.length;
  element.classList.toggle("low", rows.length > 0 && missing > computed.length);
  if (!rows.length) {
    setProductText(element, "No windows fall inside this date range.");
  } else if (missing === 0) {
    setLocalizedPluralText(element, "dashboard.residual.allComputable", rows.length);
  } else {
    setLocalizedText(element, "dashboard.residual.partial", {
      computed: computed.length,
      total: rows.length,
      missing,
      reasons: residualGapReasons(rows).join(", "),
    });
  }
}

/**
 * Merge two already-ranked lists into one bounded inspection list without
 * letting the longer list starve the shorter one.
 *
 * Each list is guaranteed its own half of `limit`; whatever a short list does
 * not use is handed to the other. Rows are deduplicated by timestamp, keeping
 * the first (higher-ranked) occurrence, and returned newest first.
 */
function balancedInspectionRows(first, second, limit) {
  const firstShare = Math.min(first.length, Math.ceil(limit / 2));
  const selected = [];
  const seen = new Set();
  const take = (rows, count) => {
    for (const row of rows) {
      if (selected.length >= limit || count <= 0) return;
      if (seen.has(row.timestamp)) continue;
      seen.add(row.timestamp);
      selected.push(row);
      count -= 1;
    }
  };
  take(first, firstShare);
  take(second, limit - selected.length);
  // Backfill only after the second list has had its reserved share, so a long
  // unmatched list can still fill the table when nothing is comparable.
  take(first, limit - selected.length);
  return selected.sort(
    (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
  );
}

function renderResiduals(data, points, viewport = null) {
  const timeHeading = $("#residual-time-heading");
  if (timeHeading) {
    setLocalizedText(timeHeading, "format.localTime");
  }
  const residuals = residualRows(data, points);
  const computed = residuals.filter((row) => row.residual !== null);
  // The residual axis is pinned to the calibration chart's own domain so a
  // shorter run of computable residuals cannot silently shorten the history.
  const domain = viewport ?? timelineBounds(points);
  const empty = $("#residual-empty");
  const shell = $("#residual-chart");
  if (!residuals.some(row => finite(row.cumulativeResidual) !== null)) {
    empty.hidden = false;
    shell.hidden = true;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    drawChart(shell, lineChart({
      points: residuals,
      series: [{
        key: "cumulativeResidual", className: "chart-line-observed",
        label: { key: "trends.drift" }, pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: formatPp, breakBefore: "driftReanchor",
      }],
      yLabel: { key: "dashboard.timeline.percentagePoints" },
      title: { key: "trends.drift" },
      description: {
        key: "trends.driftCopy",
        values: { timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 230,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: domain,

    }));
  }
  renderResidualCoverage(residuals, computed);
  setLocalizedText($("#trends-drift-coverage"), "trends.driftCoverage", {
    computed: formatNumber(residuals.filter(row => finite(row.cumulativeResidual) !== null).length),
    total: formatNumber(residuals.length),
  });
  const unmatched = points
    .filter((point) => point.timestamp && point.status
      && !["matched", "inactive"].includes(point.status))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const largest = [...computed]
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  // Both halves of this table matter: the windows that could not be compared,
  // and the comparable windows whose residual is largest. Pagination replaced
  // the old eight-row cap (owner-directed, 2026-08-08): nothing is dropped
  // any more — the merge keeps every row from both halves, deduplicated by
  // timestamp and ordered newest first, and the reader pages through it ten
  // rows at a time.
  const inspection = balancedInspectionRows(
    unmatched,
    largest,
    unmatched.length + largest.length,
  );
  // A changed selection restarts at the first page: the page index describes
  // a position within ONE row set, and surviving a range change would show an
  // arbitrary slice of a different one.
  const signature = `${inspection.length}`
    + `:${inspection[0]?.timestamp ?? ""}`
    + `:${inspection.at(-1)?.timestamp ?? ""}`;
  if (signature !== residualInspectionSignature) {
    residualInspectionSignature = signature;
    residualTablePage = 0;
  }
  residualInspectionRows = inspection;
  renderResidualInspectionTable();
}

// Explain the existing classification; do not promote absent quality metadata
// or an absent estimate into a comparable window.
function residualEvidence(row) {
  const status = row.status;
  if (status === "matched") {
    if (finite(row.observed) === null) return ["trends.evidenceMissing", "trends.evidenceMissingWhy"];
    if (finite(row.expected) === null) return ["trends.evidenceEstimate", "trends.evidenceEstimateWhy"];
    return ["trends.evidenceComparable", "trends.evidenceComparableWhy"];
  }
  const keys = {
    missing_quota_bracket: ["trends.evidenceMissing", "trends.evidenceMissingWhy"],
    reset_or_track_change: ["trends.evidenceReset", "trends.evidenceResetWhy"],
    backward_or_ambiguous: ["trends.evidenceBackward", "trends.evidenceBackwardWhy"],
    pool_saturated: ["trends.evidenceExhausted", "trends.evidenceExhaustedWhy"],
    quota_weighting_unavailable: ["trends.evidencePricing", "trends.evidencePricingWhy"],
    unpriced_local_activity: ["trends.evidenceUnpriced", "trends.evidenceUnpricedWhy"],
    unexplained_without_local_activity: ["trends.evidenceUnrecorded", "trends.evidenceUnrecordedWhy"],
    inactive: ["trends.evidenceQuiet", "trends.evidenceQuietWhy"],
  };
  return Object.hasOwn(keys, status) ? keys[status] : ["trends.evidenceUnknown", "trends.evidenceUnknownWhy"];
}

/**
 * One page of the exact-windows inspection table, plus the pager beneath it.
 * Rendered from the module-held row set so Prev/Next can redraw the table
 * without re-deriving the timeline.
 */
function renderResidualInspectionTable() {
  const table = $("#residual-table");
  clear(table);
  const rows = residualInspectionRows;
  const pagination = $("#residual-pagination");
  if (!rows.length) {
    if (pagination) pagination.hidden = true;
    const row = node("tr");
    const cell = node("td", "empty-cell", t("residual.table.empty"));
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  const pageCount = Math.ceil(rows.length / RESIDUAL_TABLE_PAGE_SIZE);
  residualTablePage = Math.min(Math.max(0, residualTablePage), pageCount - 1);
  const start = residualTablePage * RESIDUAL_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + RESIDUAL_TABLE_PAGE_SIZE);
  for (const item of pageRows) {
    const row = node("tr");
    const residual = item.observed === null || item.expected === null
      ? null
      : item.residual;
    const [labelKey, detailKey] = residualEvidence(item);
    const evidence = node("td", "residual-evidence");
    evidence.append(node("strong", "residual-evidence-label", t(labelKey)),
      node("span", "residual-evidence-detail", t(detailKey)));
    const time = node("td", "residual-window-time", formatChartTimestamp(item.timestamp));
    if (finite(item.measuredSpanMs) > 0) time.append(node("small", "residual-window-span",
      t("trends.measuredSpan", { duration: formatSpanLength(item.measuredSpanMs) })));
    row.append(
      time,
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? t("residual.table.notComparable") : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      evidence,
    );
    table.append(row);
  }
  if (!pagination) return;
  // Same rule as the weekly and model tables: no pager for a single page.
  pagination.hidden = pageCount <= 1;
  setLocalizedText($("#residual-page-status"), "residual.table.page", {
    start: formatNumber(start + 1),
    end: formatNumber(start + pageRows.length),
    total: formatNumber(rows.length),
  });
  const previous = $("#residual-page-prev");
  const next = $("#residual-page-next");
  if (previous) previous.disabled = residualTablePage === 0;
  if (next) next.disabled = residualTablePage >= pageCount - 1;
}

/**
 * The range-level model and observed-speed context for the divergence panel.
 *
 * This is deliberately NOT period-specific: the timeline usage buckets carry
 * cost, tokens, and price coverage but no per-bucket model or speed breakdown,
 * so the only model/speed evidence client-side is the whole-selected-period
 * `byModel`/`bySpeed` on the accounting payload. Each period surfaces its own
 * exact cost/token/unpriced mix from its buckets; this line adds the range's
 * dominant priced model and observed speed as clearly-marked context.
 */
function focusTrendsPeriod(period) {
  if (!dashboard) return;
  const padding = Math.max(30 * 60_000, period.durationMs * .12);
  updateTimelineViewport(selectedUsagePoints(dashboard), () => ({
    startMs: period.startMs - padding, endMs: period.endMs + padding,
  }));
  requestAnimationFrame(() => {
    trendsHorizonView?.select(period.endMs, true);
    $("#timeline").scrollIntoView({ block: "start", behavior: "instant" });
    $("#trends-time").focus({ preventScroll: true });
  });
}

// One id per rendered divergence period, so each expandable breakdown has a
// stable target for its toggle's aria-controls.
let nextDivergenceBreakdownId = 0;

// Display-only state for the detector's ranked windows. Index revisions refresh
// details without changing a window's identity; a changed population or
// contributor mix cannot inherit another window's answer. Pagination controls
// readability without dropping evidence from the detector result.
const divergenceDetails = new Map();
const DIVERGENCE_PAGE_SIZE = 10;
let divergenceTablePage = 0;
let divergencePeriodRows = [];
let divergencePeriodDetailScope = "";
let divergencePeriodRangeContext = null;
let divergencePeriodSignature = "";

function divergenceDetailScope(data) {
  const scope = data?.timeline?.planScoped?.planScope;
  return JSON.stringify([
    data?.mode,
    data?.allowancePlanSelection?.planType ?? null,
    scope?.planType ?? null,
    scope?.methodVersion ?? null,
    scope?.basisFamilyId ?? null,
    scope?.cohortId ?? null,
  ]);
}

function divergenceDetailKey(period, scope) {
  return JSON.stringify([scope, period.startMs, period.endMs, period.contributors]);
}

function prepareDivergenceDetails(data, periods) {
  const scope = divergenceDetailScope(data);
  const generation = data?.accounting?.generation;
  const planScope = data?.timeline?.planScoped?.planScope;
  const revision = generation == null && !planScope?.sourceGeneration
    ? data
    : JSON.stringify([generation, data?.accounting?.generationFingerprint,
      planScope?.sourceGeneration, planScope?.sourceGenerationFingerprint]);
  const retained = new Set();
  for (const period of periods) {
    const key = divergenceDetailKey(period, scope);
    retained.add(key);
    let state = divergenceDetails.get(key);
    if (!state) {
      state = { key, expanded: false, breakdown: null, loadedRevision: null,
        pending: false, render: null, load: null };
      divergenceDetails.set(key, state);
    }
    state.revision = revision;
    state.local = ["local", "real_local_evidence"].includes(data?.mode);
  }
  for (const key of divergenceDetails.keys()) {
    if (!retained.has(key)) divergenceDetails.delete(key);
  }
  return scope;
}

function divergenceRangeContext(data) {
  const accounting = accountingPeriod(data);
  if (!accounting) return null;
  const models = modelUsageRows(accounting);
  const topModel = models.find((row) => !modelRowIsSeparateAllowance(row))
    ?? models[0]
    ?? null;
  const modelLabel = topModel === null ? null
    : topModel.model === "unknown"
      ? t("accounting.model.identityUnavailable")
      : topModel.pricingStatus === "unrecognized"
        ? t("accounting.model.unrecognized")
        : formatModelName(topModel.model) || topModel.model;
  const bySpeed = accounting.bySpeed ?? {};
  const rankedSpeed = ["ultrafast", "fast", "standard", "unknown"]
    .map((key) => [key, finite(bySpeed?.[key]?.events, 0)])
    .sort((left, right) => right[1] - left[1]);
  const topSpeed = rankedSpeed[0]?.[1] > 0 ? rankedSpeed[0][0] : null;
  if (modelLabel === null && topSpeed === null) return null;
  return {
    model: modelLabel ?? t("divergence.speed.unknown"),
    speed: divergenceSpeedLabel(topSpeed ?? "unknown"),
  };
}

// Static speed keys so the translated-inventory gate can verify every one. A
// computed `t(\`divergence.speed.${key}\`)` would resolve at runtime but read
// as no key to the source scanner.
function divergenceSpeedLabel(key) {
  if (key === "ultrafast") return t("divergence.speed.ultrafast");
  if (key === "fast") return t("divergence.speed.fast");
  if (key === "standard") return t("divergence.speed.standard");
  return t("divergence.speed.unknown");
}

/**
 * One detected divergence period, rendered to match the Trends card copy: a
 * localized date range and duration, the finding in plain words, the signed
 * magnitude, and the contributor mix (exact per-period totals plus range-level
 * model/speed context).
 */
function divergencePeriodItem(period, rangeContext, state) {
  const item = node(
    "li",
    `divergence-period ${period.direction === "under_costed"
      ? "under-costed"
      : "over-costed"}`,
  );

  const header = node("div", "divergence-period-header");
  header.append(
    rawNode(
      "span",
      "divergence-period-range",
      t("divergence.dateRange", {
        start: formatChartTimestamp(period.startAt),
        end: formatChartTimestamp(period.endAt),
      }),
    ),
    localizedNode("span", "divergence-period-duration", "divergence.duration", {
      duration: formatSpanLength(period.durationMs),
    }),
  );

  const finding = localizedNode(
    "p",
    "divergence-period-finding",
    period.direction === "under_costed"
      ? "trends.faster"
      : "trends.slower",
    { pp: formatPp(period.absPeakDriftPp) },
  );

  const magnitude = localizedNode(
    "p",
    "divergence-period-magnitude",
    "divergence.magnitude",
    {
      peak: formatSignedPp(period.peakDriftPp),
      auc: formatSignedPpHours(period.signedAucPpHours),
    },
  );

  const contributors = period.contributors;
  const mix = localizedNode("p", "divergence-period-mix", "divergence.mix", {
    cost: formatApiMoney(contributors.costUsd),
    tokens: compact(contributors.totalTokens),
    events: compact(contributors.usageEvents),
  });

  const gap = node("div", "divergence-gap");
  gap.append(rawNode("strong", "divergence-gap-value", formatSignedPp(period.peakDriftPp)),
    localizedNode("span", "", "trends.maxGap"));
  gap.setAttribute("title", t("trends.gapExplanation"));
  const focus = localizedNode("button", "button button-quiet compact divergence-focus", "trends.viewPeriod");
  focus.type = "button";
  focus.addEventListener("click", () => focusTrendsPeriod(period));
  item.append(header, gap, finding, focus);

  if (contributors.unpricedEventShare !== null
      && contributors.unpricedEvents > 0) {
    item.append(localizedNode(
      "p",
      "divergence-period-unpriced",
      "divergence.unpricedShare",
      { share: formatPercent(contributors.unpricedEventShare * 100, 1) },
    ));
  }

  // The per-period model and speed mix is not in the timeline payload, so it is
  // fetched on demand: expanding the period asks the companion to reprice just
  // this window from the unified index. This replaces the old whole-selected-
  // range context line with the window's OWN contributor mix; the range context
  // survives only as the fallback when a companion predating the route cannot
  // answer.
  const breakdownId = `divergence-breakdown-${nextDivergenceBreakdownId++}`;
  const toggle = node("button", "divergence-period-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", breakdownId);
  setLocalizedText(toggle, "divergence.breakdown.show");
  const panel = node("div", "divergence-period-breakdown");
  panel.id = breakdownId;
  panel.hidden = true;

  const renderBreakdown = () => {
    if (state.breakdown !== null || !state.pending) {
      renderDivergenceBreakdown(panel, state.breakdown, rangeContext);
    } else {
      clear(panel);
      panel.append(localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.loading",
      ));
    }
    panel.append(magnitude, mix);
    if (state.failed && !state.pending && state.local) {
      if (state.breakdown) panel.append(localizedNode("p", "divergence-breakdown-status", "trends.mixRetained"));
      const retry = localizedNode("button", "button button-quiet compact divergence-retry", "trends.mixRetry");
      retry.type = "button";
      retry.addEventListener("click", () => {
        state.toggle.focus({ preventScroll: true });
        state.load();
      });
      panel.append(retry);
    }
  };
  state.render = renderBreakdown;
  const loadBreakdown = async () => {
    if (!state.local || state.pending
        || state.loadedRevision === state.revision) return;
    const revision = state.revision;
    state.pending = true;
    state.failed = false;
    renderBreakdown();
    let breakdown = null;
    try {
      breakdown = await localClient.windowBreakdown(period.startMs, period.endMs);
    } catch {
      breakdown = null;
    }
    state.pending = false;
    if (divergenceDetails.get(state.key) !== state) return;
    if (state.revision !== revision) {
      if (state.expanded) state.load();
      return;
    }
    state.failed = breakdown?.status !== "available";
    if (breakdown?.status === "available") {
      state.breakdown = breakdown;
      state.loadedRevision = revision;
    }
    // Failed refreshes never erase a successful answer or mark failure as
    // loaded. Reopening or the next dashboard refresh can try again.
    state.render();
  };
  state.load = loadBreakdown;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    state.expanded = !open;
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    setLocalizedText(
      toggle,
      open ? "divergence.breakdown.show" : "divergence.breakdown.hide",
    );
    panel.hidden = open;
    if (!open) loadBreakdown();
  });
  toggle.setAttribute("aria-expanded", String(state.expanded));
  setLocalizedText(toggle, state.expanded
    ? "divergence.breakdown.hide" : "divergence.breakdown.show");
  panel.hidden = !state.expanded;
  renderBreakdown();
  if (state.expanded) loadBreakdown();

  state.toggle = toggle;
  item.append(toggle, panel);
  return item;
}

// The window's own repriced contributor mix, or a clearly-marked fallback. The
// per-model and per-speed rows are the true per-period evidence the endpoint
// exists to supply; an unavailable breakdown falls back to the range-level
// context rather than pretending this window had none.
function divergenceModelLabel(model) {
  if (model === "unknown") return t("accounting.model.identityUnavailable");
  return formatModelName(model) || model;
}

function renderDivergenceBreakdown(panel, breakdown, rangeContext) {
  clear(panel);
  panel.append(localizedNode("p", "divergence-breakdown-purpose", "trends.mixPurpose"));
  if (!breakdown || breakdown.status !== "available") {
    panel.append(rangeContext !== null
      ? localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.unavailable",
        { model: rangeContext.model, speed: rangeContext.speed },
      )
      : localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.unavailablePlain",
      ));
    return;
  }
  if (!breakdown.byModel.length) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-status",
      "divergence.breakdown.empty",
    ));
    return;
  }

  panel.append(localizedNode(
    "p",
    "divergence-breakdown-heading",
    "divergence.breakdown.modelHeading",
  ));
  const modelList = node("ul", "divergence-breakdown-list");
  for (const row of breakdown.byModel) {
    const share = breakdown.costUsd > 0 ? row.costUsd / breakdown.costUsd : 0;
    modelList.append(localizedNode(
      "li",
      "divergence-breakdown-row",
      "divergence.breakdown.modelRow",
      {
        model: divergenceModelLabel(row.model),
        cost: formatApiMoney(row.costUsd),
        share: formatPercent(share * 100, 1),
      },
    ));
  }
  panel.append(modelList);

  const speedEntries = Object.entries(breakdown.bySpeed)
    .map(([speed, row]) => ({ ...row, speed }))
    .filter((row) => row.events > 0)
    .sort((left, right) => right.costUsd - left.costUsd);
  if (speedEntries.length) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-heading",
      "divergence.breakdown.speedHeading",
    ));
    const speedList = node("ul", "divergence-breakdown-list");
    for (const row of speedEntries) {
      speedList.append(localizedNode(
        "li",
        "divergence-breakdown-row",
        "divergence.breakdown.speedRow",
        {
          speed: divergenceSpeedLabel(row.speed),
          cost: formatApiMoney(row.costUsd),
          events: compact(row.events),
        },
      ));
    }
    panel.append(speedList);
  }

  if (breakdown.fastCostUsd > 0) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-fast",
      "divergence.breakdown.fastCost",
      { cost: formatApiMoney(breakdown.fastCostUsd) },
    ));
  }
  if (breakdown.ultrafastCostUsd > 0) {
    panel.append(localizedNode("p", "divergence-breakdown-fast", "divergence.breakdown.ultrafastCost",
      { cost: formatApiMoney(breakdown.ultrafastCostUsd) }));
  }
  if (breakdown.unpricedShare > 0) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-unpriced",
      "divergence.breakdown.unpriced",
      { share: formatPercent(breakdown.unpricedShare * 100, 1) },
    ));
  }
}

function divergenceRowsSignature(periods, detailScope) {
  return JSON.stringify([
    detailScope,
    periods.map((period) => [
      period.startMs,
      period.endMs,
      period.contributors,
    ]),
  ]);
}

/**
 * Render one readable page of the complete, widest-first divergence set.
 * Detail state is retained for every detected window, so a reader can page
 * away from an expanded row and return without losing its loaded evidence.
 */
function renderDivergencePeriodPage({ focusedKey = null } = {}) {
  const list = $("#divergence-list");
  const pagination = $("#divergence-pagination");
  if (!list) return;
  clear(list);

  const pageCount = Math.max(
    1,
    Math.ceil(divergencePeriodRows.length / DIVERGENCE_PAGE_SIZE),
  );
  divergenceTablePage = Math.min(
    Math.max(0, divergenceTablePage),
    pageCount - 1,
  );
  const start = divergenceTablePage * DIVERGENCE_PAGE_SIZE;
  const pageRows = divergencePeriodRows.slice(
    start,
    start + DIVERGENCE_PAGE_SIZE,
  );

  for (const period of pageRows) {
    const key = divergenceDetailKey(period, divergencePeriodDetailScope);
    const state = divergenceDetails.get(key);
    list.append(divergencePeriodItem(
      period,
      divergencePeriodRangeContext,
      state,
    ));
    if (key === focusedKey) state.toggle.focus({ preventScroll: true });
  }

  if (!pagination) return;
  pagination.hidden = pageCount <= 1;
  if (pagination.hidden) return;
  setLocalizedText(
    $("#divergence-page-status"),
    "divergence.pagination.page",
    {
      start: formatNumber(start + 1),
      end: formatNumber(start + pageRows.length),
      total: formatNumber(divergencePeriodRows.length),
    },
  );
  const previous = $("#divergence-page-prev");
  const next = $("#divergence-page-next");
  if (previous) previous.disabled = divergenceTablePage === 0;
  if (next) next.disabled = divergenceTablePage >= pageCount - 1;
}

/**
 * The "Where observed and priced usage diverge" panel. It runs the pure
 * detector over the whole selected calibration range and lists each sustained
 * period, or states plainly that nothing diverged in this range.
 */
function renderDivergencePeriods(data, points) {
  const list = $("#divergence-list");
  const empty = $("#divergence-empty");
  const summary = $("#divergence-summary");
  const caveat = $("#divergence-caveat");
  const pagination = $("#divergence-pagination");
  if (!list || !empty || !summary) return;
  const focusedKey = [...divergenceDetails.values()]
    .find((state) => state.toggle === document.activeElement)?.key;
  clear(list);

  const result = detectDeviationPeriods(points, {
    usageBuckets: data?.timeline?.usage ?? [],
  });
  const detailScope = prepareDivergenceDetails(data, result.periods);
  const signature = divergenceRowsSignature(result.periods, detailScope);
  if (signature !== divergencePeriodSignature) {
    divergencePeriodSignature = signature;
    divergenceTablePage = 0;
  }
  divergencePeriodRows = result.periods;
  divergencePeriodDetailScope = detailScope;
  divergencePeriodRangeContext = divergenceRangeContext(data);

  if (!result.periods.length) {
    list.hidden = true;
    summary.hidden = true;
    if (pagination) pagination.hidden = true;
    if (caveat) caveat.hidden = true;
    empty.hidden = false;
    // "Nothing diverged" and "there is no drift series to judge" are different
    // facts: the historical artifact view carries no per-window reset anchors,
    // so it can never earn the clean-bill-of-health copy.
    setLocalizedText(
      empty,
      result.hasDriftSeries ? "divergence.empty" : "divergence.emptyNoDrift",
    );
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  summary.hidden = false;
  // Honest-estimator label (2026-08-10): the constant-rate expected line
  // reads model-mix shifts as divergence (established by the full-history
  // deviation investigation — sol-heavy stretches imply ~$2,300/100pp and
  // terra-heavy ~$1,100 against one blended constant). Until the per-model
  // expected line ships, every listed period carries this caveat.
  if (caveat) {
    caveat.hidden = false;
    setLocalizedText(caveat, "trends.divergenceBasis");
  }
  setLocalizedPluralText(summary, "divergence.count", result.totalFound, {
    count: formatNumber(result.totalFound),
  });
  renderDivergencePeriodPage({ focusedKey });
}

/**
 * Whether a series draws its data points. This is decided per chart, and there
 * is deliberately no global switch, because the dashboard's two chart families
 * want opposite answers and both answers are correct:
 *
 *  - EVIDENCE_DOTS — the allowance estimate history. Each dot is one observed
 *    seven-day reset: sparse, individually meaningful evidence. The dots are
 *    what that chart is for, and they must be visible.
 *  - HOVER_ONLY — the dense usage, calibration, and residual timelines. Those
 *    plot hundreds of adjacent samples, where dots smear into a band. The line
 *    carries the shape while every sample keeps an invisible hit target, so
 *    hover, keyboard focus, and assistive technology still reach each value.
 *
 * Every series must name one. There is no default to fall back to and no
 * boolean to flip in one place, so "hide the dots" can only ever be said about
 * a single chart. A previous change that flipped one shared flag silently
 * erased the allowance chart's points; this makes that edit impossible to
 * write by accident.
 */
const CHART_POINT_STYLE = Object.freeze({
  EVIDENCE_DOTS: "evidence-dots",
  HOVER_ONLY: "hover-only",
});

const CHART_POINT_STYLES = new Set(Object.values(CHART_POINT_STYLE));

/**
 * Drawing heights, in viewBox units, for the charts whose CSS lets them take
 * their height from the shape of their drawing rather than from a fixed pixel
 * value.
 *
 * The timeline charts were drawn into a 900x300 box inside a shell that is
 * routinely 977px wide. An SVG scales its viewBox to fit, so the smaller ratio
 * won: the plot was pinned to 300px tall and letterboxed with 77px of dead
 * space across the width. These heights pair with `aspect-ratio` rules in
 * `styles.css` so each chart fills its card in both directions, which roughly
 * doubles the plot area the same evidence is drawn into.
 *
 * Each value must stay in step with the matching `aspect-ratio`; a height with
 * no matching rule only reintroduces the letterbox.
 */
const TIMELINE_CHART_HEIGHT = 420;
const COMPACT_CHART_HEIGHT = 340;

/**
 * The one place a plotted point's instant is turned into milliseconds.
 *
 * Every series carries its instant as an ISO string, because that is what the
 * evidence artifacts and the local companion emit and what the tooltips print.
 * Re-parsing that string is not free, and the viewport helpers, the status
 * intervals, the residual filter, and the x-scale each parsed the same strings
 * again on every redraw: a single wheel notch over a month of calibration
 * evidence was measured at 18,177 `Date.parse` calls.
 *
 * Series builders now stamp `timestampMs` alongside `timestamp`, and this
 * reader prefers it. The fallback keeps the helper honest for points that come
 * straight from an artifact — a caller never has to know which kind it holds.
 */
function pointTimestampMs(point) {
  const stamped = point?.timestampMs;
  if (typeof stamped === "number" && Number.isFinite(stamped)) return stamped;
  return Date.parse(point?.timestamp ?? point?.date);
}

/**
 * Swap a chart into its shell, releasing what the outgoing chart still held.
 *
 * `lineChart` attaches a `ResizeObserver` so the axis can shed tick labels as
 * the card narrows. A pan or zoom replaces the whole SVG on every frame, so
 * without this the page kept one live observer per rendered frame, each still
 * watching a detached tree and each waking on the next real resize.
 */
let trendsHorizonView = null;

function drawChart(shell, chart) {
  for (const previous of shell.children ?? []) {
    previous.chartTickDensityObserver?.disconnect();
  }
  shell.replaceChildren(chart);
  if (shell.closest?.("#timeline") && chart.timelinePresentation) {
    trendsHorizonView ??= mountTrendsHorizon($("#timeline"), { t, locale: getFormattingLocale(), timeZone: USER_TIME_ZONE,
      formatMoney: formatApiMoney, formatPercent, formatDuration: formatSpanLength });
    trendsHorizonView.refreshLocale(getFormattingLocale());
    trendsHorizonView.register(shell, chart.timelinePresentation);
  }
}

function chartSeriesDrawsPoints(item, field) {
  const style = item?.pointStyle;
  if (!CHART_POINT_STYLES.has(style)) {
    throw new TypeError(
      `lineChart ${field} needs an explicit pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS draws visible data points, CHART_POINT_STYLE.HOVER_ONLY keeps them reachable without drawing them.`,
    );
  }
  return style === CHART_POINT_STYLE.EVIDENCE_DOTS;
}

/**
 * The localization hook for everything the chart writes into the SVG text
 * layer: axis labels, series names, the `<title>`/`<desc>` accessibility pair,
 * and hover tooltips.
 *
 * SVG text nodes are stamped `data-i18n-skip` because they already contain
 * formatted numbers and instants that exact-text translation must never touch.
 * That left the text layer as the one surface the localization bridge could not
 * see, and hardcoded English flowed straight through it. Resolving the strings
 * here, at the single chart-rendering helper, closes that gap for every chart
 * at once.
 *
 * Callers pass a descriptor rather than a string:
 *   { key: "chart.residual.title" }               → t(key)
 *   { key: "weekly.point.detail", values: {...} } → t(key, values)
 *   { key: "share.resetFit", plural: count }      → tPlural(key, count, values)
 *   { data: alreadyFormattedSourceValue }         → verbatim, never translated
 *
 * A bare string throws. That is the enforcement: a chart added later cannot
 * reintroduce untranslated English without failing the moment it renders.
 */
function chartText(descriptor, field = "text") {
  if (descriptor === null || descriptor === undefined) return "";
  if (typeof descriptor === "object" && !Array.isArray(descriptor)) {
    if (typeof descriptor.key === "string") {
      return typeof descriptor.plural === "number"
        ? tPlural(descriptor.key, descriptor.plural, descriptor.values ?? {})
        : t(descriptor.key, descriptor.values ?? {});
    }
    if (Object.hasOwn(descriptor, "data")) {
      return descriptor.data == null ? "" : String(descriptor.data);
    }
  }
  throw new TypeError(
    `lineChart ${field} must be a localization descriptor ({ key }) or explicit source data ({ data }). Hardcoded strings cannot reach the SVG text layer.`,
  );
}

function chartSeriesCaption(label, value) {
  return t("chart.seriesValue", { label, value });
}

/**
 * Which evidence states shade the plot, and under which hue.
 *
 * This is an explicit table with NO fallback, and both properties matter. The
 * renderer used to end its status test in `: "ambiguous"`, so three unrelated
 * states — `quota_weighting_unavailable`, `unpriced_local_activity` and
 * `unexplained_without_local_activity` — all drew in the violet the legend
 * captions "Movement needs context". Violet therefore meant four different
 * things and mapped back to nothing.
 *
 * Worse, the last two carry BOTH series and are counted as matched windows, so
 * the chart was shading spans the caption underneath it calls excluded. A
 * status absent from this table is not shaded at all: shading is reserved for
 * the mechanisms that actually suspend a measurement, which is exactly the set
 * `TIMELINE_EXCLUSION_MESSAGE_KEYS` enumerates and the legend keys.
 */
const TIMELINE_STATUS_BAND_CLASSES = Object.freeze({
  missing_quota_bracket: "missing",
  reset_or_track_change: "reset",
  quota_weighting_unavailable: "weighting",
  backward_or_ambiguous: "ambiguous",
  pool_saturated: "saturated",
});

// A band narrower than this cannot be seen, so every region also draws a
// full-strength tick along the top edge of the plot at no less than this
// width. The wash keeps the true extent and never widens; the tick is an
// explicit presence marker, which is why the two are allowed to disagree.
const STATUS_TICK_MINIMUM_WIDTH = 3;
const STATUS_TICK_HEIGHT = 4;

function lineChart({
  points,
  series,
  yLabel,
  title,
  description,
  includeZero = false,
  confidence = null,
  errorBars = null,
  xDomain = null,
  xTicks = null,
  yDomain = null,
  yTickFormat = null,
  statusIntervals = [],
  secondarySeries = [],
  secondaryYLabel = null,
  // The drawing height, in viewBox units. It pairs with an `aspect-ratio` in
  // `styles.css`: the SVG is laid out at the card's full width and takes its
  // height from this ratio, so the plot fills the box in both directions
  // instead of being letterboxed by a fixed CSS height. A chart whose CSS
  // pins an explicit height keeps the default, because raising this without
  // raising that one only reintroduces the letterbox it is meant to remove.
  height = 300,
  width = 900,
}) {
  // Hover, keyboard focus, and the accessible name are unconditional. Only the
  // visible dot is a per-chart decision, and every series has to state it.
  const chartSeries = (Array.isArray(series) ? series : []).map((item) => ({
    ...item,
    label: chartText(item.label, "series label"),
    markers: chartSeriesDrawsPoints(item, "series"),
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const chartSecondarySeries = (Array.isArray(secondarySeries) ? secondarySeries : []).map((item) => ({
    ...item,
    label: chartText(item.label, "secondary series label"),
    markers: chartSeriesDrawsPoints(item, "secondary series"),
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const hasSecondary = chartSecondarySeries.length > 0;
  const margin = {
    top: 12,
    right: hasSecondary ? 96 : 24,
    // Tick labels are horizontal. They used to be rotated -24° and given a
    // 66px gutter because each one carried a full date and time; now that a
    // tick reads "Jul 15" or "2:04 PM", rotation only made short text harder
    // to read and cost the plot 22px of height. The gutter is sized to the one
    // line of 10px text it holds — it was carrying 22px of slack beneath the
    // baseline, which is plot area no chart was using.
    bottom: 30,
    left: 72,
  };
  const tickLabelBaseline = height - 11;
  let min = finite(yDomain?.low);
  let max = finite(yDomain?.high);
  if (min === null || max === null || max <= min) {
    const values = points.flatMap((point) => chartSeries.map((item) => finite(point[item.key])).filter((value) => value !== null));
    if (confidence) values.push(...points.flatMap((point) => [finite(point[confidence.low]), finite(point[confidence.high])].filter((value) => value !== null)));
    if (errorBars) values.push(...points.flatMap((point) => [finite(point[errorBars.low]), finite(point[errorBars.high])].filter((value) => value !== null)));
    if (includeZero) values.push(0);
    min = Math.min(...values);
    max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * .1;
    min = includeZero && min >= 0 ? 0 : min - pad;
    max += pad;
  }
  const timestamps = points.map(pointTimestampMs);
  const timed = timestamps.every(Number.isFinite);
  const dataStartMs = timed ? Math.min(...timestamps) : 0;
  const dataEndMs = timed ? Math.max(...timestamps) : Math.max(1, points.length - 1);
  const domainStartMs = timed && Number.isFinite(xDomain?.startMs)
    ? xDomain.startMs
    : dataStartMs;
  const domainEndMs = timed && Number.isFinite(xDomain?.endMs)
    ? xDomain.endMs
    : dataEndMs;
  const safeDomainEndMs = domainEndMs > domainStartMs
    ? domainEndMs
    : domainStartMs + 1;
  // `timestamps` was already computed above, once per point, so the x-scale
  // reads that array instead of re-parsing the same ISO string on every call.
  const plotWidth = width - margin.left - margin.right;
  const lastIndex = Math.max(1, points.length - 1);
  const x = (index, point = points[index]) => {
    const at = timed
      ? (index >= 0 && timestamps[index] !== undefined
        ? timestamps[index]
        : pointTimestampMs(point))
      : null;
    const coordinate = timed
      ? (at - domainStartMs) / (safeDomainEndMs - domainStartMs)
      : index / lastIndex;
    return margin.left + coordinate * plotWidth;
  };
  const y = (value) => margin.top + (max - value) / (max - min) * (height - margin.top - margin.bottom);
  const ySecondary = (value) => margin.top
    + (100 - Math.max(0, Math.min(100, value))) / 100
      * (height - margin.top - margin.bottom);

  // Six candidate divisions rather than five. Ticks are now kept inside the
  // domain instead of rounding outwards past each end, which costs the axis
  // roughly one tick; asking for one more division back restores the density a
  // chart this tall needs to stay readable.
  const chartTickStep = (low, high, target = 6) => {
    const span = Math.abs(high - low);
    if (!Number.isFinite(span) || span <= 0) return 1;
    const raw = span / Math.max(1, target - 1);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const factor = normalized <= 1 ? 1
      : normalized <= 2 ? 2
        : normalized <= 2.5 ? 2.5
          : normalized <= 5 ? 5
            : 10;
    return factor * magnitude;
  };
  // The fewest decimals that write the step exactly. The old rule returned 0
  // for any step of 1 or more, so a 2.5 step printed its own grid lines as
  // "0, -3, -5, -8, -10" — two labels naming a value their line was not drawn
  // at. It also under-reported fractional steps: 0.25 needs two places, not
  // one.
  const chartTickDigits = (step) => {
    if (!Number.isFinite(step) || step <= 0) return 0;
    for (let digits = 0; digits < 3; digits += 1) {
      if (Math.abs(step - Number(step.toFixed(digits))) <= step * 1e-9) return digits;
    }
    return 3;
  };
  const yStep = chartTickStep(min, max);
  const yDigits = chartTickDigits(yStep);
  const yTicks = Array.isArray(yDomain?.ticks) && yDomain.ticks.length > 0
    ? yDomain.ticks.filter((value) => Number.isFinite(value))
    : (() => {
      // Ticks sit on round multiples of the step, but only where the axis
      // actually goes. Rounding outwards put a grid line and a label a whole
      // step beyond each end of the domain: on the residual chart that drew
      // two of five grid lines outside the SVG box entirely, and `overflow:
      // visible` meant they were painted over the card below rather than
      // clipped. Rounding inwards keeps every tick on the plot.
      const first = Math.floor(max / yStep) * yStep;
      const last = Math.ceil(min / yStep) * yStep;
      const values = [];
      for (let value = first; value >= last - yStep / 100; value -= yStep) {
        values.push(Number(value.toFixed(Math.max(0, yDigits + 2))));
        if (values.length >= 8) break;
      }
      return values.length >= 2 ? values : [max, min];
    })();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  // The chart's accessible name and description live on aria attributes
  // rather than a root <title>/<desc> pair: a root <title> also acts as a
  // delayed grey native tooltip over every hover target inside the SVG, which
  // is the double-tooltip the owner removed (2026-08-08). Both strings still
  // pass through chartText, so hardcoded English still cannot reach them.
  svg.setAttribute("aria-label", chartText(title, "title"));
  const chartDescription = chartText(description, "description");
  if (chartDescription !== "") {
    svg.setAttribute("aria-description", chartDescription);
  }

  const tooltipWidth = Math.min(330, width - margin.left - margin.right);
  const tooltipHeight = 48;
  const tooltip = document.createElementNS(svg.namespaceURI, "g");
  tooltip.setAttribute("class", "chart-hover-tooltip");
  tooltip.setAttribute("visibility", "hidden");
  tooltip.setAttribute("aria-hidden", "true");
  const tooltipBackground = document.createElementNS(svg.namespaceURI, "rect");
  tooltipBackground.setAttribute("width", String(tooltipWidth));
  tooltipBackground.setAttribute("height", String(tooltipHeight));
  tooltipBackground.setAttribute("rx", "6");
  const tooltipHeading = svgText(10, 18, "", "chart-tooltip-heading");
  const tooltipDetail = svgText(10, 36, "", "chart-tooltip-detail");
  tooltip.append(tooltipBackground, tooltipHeading, tooltipDetail);
  const showTooltip = (xPosition, yPosition, heading, detail = "") => {
    const tooltipX = Math.max(
      margin.left,
      Math.min(width - margin.right - tooltipWidth, xPosition + 10),
    );
    const tooltipY = yPosition - tooltipHeight - 10 < margin.top
      ? yPosition + 10
      : yPosition - tooltipHeight - 10;
    tooltip.setAttribute("transform", `translate(${tooltipX} ${tooltipY})`);
    tooltipHeading.textContent = heading.slice(0, Math.min(72, Math.floor((tooltipWidth - 20) / 6)));
    tooltipDetail.textContent = detail.slice(0, Math.min(86, Math.floor((tooltipWidth - 20) / 5.5)));
    tooltip.setAttribute("visibility", "visible");
    tooltip.setAttribute("aria-hidden", "false");
  };
  const hideTooltip = () => {
    tooltip.setAttribute("visibility", "hidden");
    tooltip.setAttribute("aria-hidden", "true");
  };

  const bindChartInteraction = ({
    element,
    heading,
    detail = "",
    xPosition,
    yPosition,
    pointer = true,
    focus = true,
    label = `${heading}${detail ? ` · ${detail}` : ""}`,
  }) => {
    if (focus) {
      element.setAttribute("tabindex", "0");
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", label);
    }
    if (typeof element.addEventListener !== "function") return;
    if (pointer) {
      element.addEventListener("pointerenter", () => showTooltip(
        xPosition,
        yPosition,
        heading,
        detail,
      ));
      element.addEventListener("pointerleave", hideTooltip);
    }
    if (focus) {
      element.addEventListener("focus", () => showTooltip(
        xPosition,
        yPosition,
        heading,
        detail,
      ));
      element.addEventListener("blur", hideTooltip);
    }
  };

  const installTickDensity = (tickLabels) => {
    if (tickLabels.length === 0) return;
    const update = (renderedWidth) => {
      const widthForDensity = Number.isFinite(renderedWidth) && renderedWidth > 0
        ? renderedWidth
        : width;
      const target = Math.min(
        tickLabels.length,
        adaptiveChartTickCount(widthForDensity, {
          left: margin.left,
          right: margin.right,
        }),
      );
      const visible = new Set();
      if (target === 1) {
        visible.add(0);
      } else {
        for (let index = 0; index < target; index += 1) {
          visible.add(Math.round(index * (tickLabels.length - 1) / (target - 1)));
        }
      }
      tickLabels.forEach((label, index) => {
        label.setAttribute("display", visible.has(index) ? "inline" : "none");
        label.setAttribute("aria-hidden", visible.has(index) ? "false" : "true");
      });
    };
    const renderedWidth = typeof svg.getBoundingClientRect === "function"
      ? svg.getBoundingClientRect().width
      : width;
    update(renderedWidth);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver((entries) => {
        // A pan redraws the chart every frame, discarding the SVG this observer
        // was created for. Once that SVG leaves the document the observer has
        // nothing to report, so it releases itself rather than accumulating one
        // live observer per rendered frame.
        if (svg.isConnected === false) {
          observer.disconnect();
          return;
        }
        update(entries[0]?.contentRect?.width ?? renderedWidth);
      });
      observer.observe(svg);
      svg.chartTickDensityObserver = observer;
    }
  };

  for (const value of yTicks) {
    const yPosition = y(value);
    svg.append(svgLine(margin.left, yPosition, width - margin.right, yPosition, "chart-grid"));
    const label = yTickFormat === null
      ? formatDecimal(value, yDigits)
      : yTickFormat(value, yDigits);
    svg.append(svgText(margin.left - 8, yPosition + 3, label, "chart-axis-label", "end"));
  }

  if (hasSecondary) {
    // The percentage axis is drawn on its own round quarters. It used to reuse
    // the left axis's tick positions, so a four-tick dollar axis produced
    // 100 / 67 / 33 / 0 % — arithmetically true and unreadable. The percentage
    // scale is fixed at 0–100, so its ticks do not depend on the other axis.
    for (const percent of [100, 75, 50, 25, 0]) {
      svg.append(svgText(
        width - margin.right + 8,
        ySecondary(percent) + 3,
        formatPercent(percent, 0),
        "chart-axis-label",
        "start"
      ));
    }
  }

  if (includeZero && min <= 0 && max >= 0) {
    svg.append(svgLine(margin.left, y(0), width - margin.right, y(0), "chart-zero"));
  }

  if (timed) {
    // Render the widest useful candidate set once, then hide labels as the
    // SVG's actual CSS width changes. The plotted geometry stays stable while
    // narrow cards shed labels instead of acquiring a horizontal scrollbar.
    const automaticTickCount = adaptiveChartTickCount(width, {
      left: margin.left,
      right: margin.right,
    });
    const domainSpanMs = safeDomainEndMs - domainStartMs;
    const ticks = Array.isArray(xTicks) && xTicks.length > 0
      ? xTicks
      : Array.from({ length: automaticTickCount }, (_, index) => {
        const at = domainStartMs + domainSpanMs * index / (automaticTickCount - 1);
        return {
          at,
          label: formatChartTimeLabel(at, { spanMs: domainSpanMs }),
          alignment: index === 0
            ? "start"
            : index === automaticTickCount - 1
              ? "end"
              : "middle",
        };
      });
    const tickLabels = [];
    for (const tick of ticks) {
      const at = finite(tick?.at);
      if (at === null) continue;
      const position = margin.left + (at - domainStartMs)
        / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
      const tickLabel = svgText(
        position,
        tickLabelBaseline,
        typeof tick.label === "string"
          ? tick.label
          : formatChartTimeLabel(at, { spanMs: domainSpanMs }),
        "chart-axis-label",
        tick.alignment ?? "middle",
      );
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  } else {
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
    const tickLabels = [];
    for (const index of labelIndexes) {
      const timestamp = points[index]?.timestamp ?? points[index]?.date;
      const tickLabel = svgText(x(index), tickLabelBaseline, formatChartTimeLabel(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle");
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  }
  const yAxisLabel = svgText(
    15,
    height / 2,
    chartText(yLabel, "yLabel"),
    "chart-axis-label",
    "middle",
  );
  yAxisLabel.setAttribute("transform", `rotate(-90 15 ${height / 2})`);
  svg.append(yAxisLabel);
  if (hasSecondary && secondaryYLabel) {
    const secondaryLabel = svgText(
      width - 8,
      height / 2,
      chartText(secondaryYLabel, "secondaryYLabel"),
      "chart-axis-label",
      "middle"
    );
    secondaryLabel.setAttribute(
      "transform",
      `rotate(90 ${width - 8} ${height / 2})`
    );
    svg.append(secondaryLabel);
  }

  if (confidence) {
    const confidencePoints = points
      .map((point, index) => ({
        point,
        index,
        low: finite(point[confidence.low]),
        high: finite(point[confidence.high]),
      }))
      .filter((point) => point.low !== null && point.high !== null);
    if (confidencePoints.length >= 2) {
      const upper = confidencePoints.map(
        ({ point, index, high }) => [x(index, point), y(high)],
      );
      const lower = confidencePoints.map(
        ({ point, index, low }) => [x(index, point), y(low)],
      ).reverse();
      const polygon = document.createElementNS(svg.namespaceURI, "polygon");
      polygon.setAttribute("points", [...upper, ...lower].map(([a, b]) => `${a},${b}`).join(" "));
      polygon.setAttribute("class", "chart-area-confidence");
      const bandLow = Math.min(...confidencePoints.map(({ low }) => low));
      const bandHigh = Math.max(...confidencePoints.map(({ high }) => high));
      const bandFormat = confidence.format ?? formatMoney;
      const bandHeading = chartText(confidence.label, "confidence label");
      const bandDetail = `${bandFormat(bandLow)}–${bandFormat(bandHigh)}`;
      const bandCaption = chartSeriesCaption(bandHeading, bandDetail);
      // No native <title> here: the styled hover tooltip already shows this
      // caption immediately, and the browser's delayed grey tooltip repeated
      // it (owner-reported double tooltip, 2026-08-08). The caption stays on
      // aria-label for assistive technology.
      const middlePoint = confidencePoints[Math.floor(confidencePoints.length / 2)];
      bindChartInteraction({
        element: polygon,
        heading: bandHeading,
        detail: bandDetail,
        xPosition: x(middlePoint.index, middlePoint.point),
        yPosition: y((bandLow + bandHigh) / 2),
        pointer: confidence.tooltip !== false,
        focus: confidence.focusable !== false,
        label: bandCaption,
      });
      svg.append(polygon);
    }
  }

  if (errorBars) {
    const format = errorBars.format ?? formatMoney;
    points.forEach((point, index) => {
      const low = finite(point[errorBars.low]);
      const high = finite(point[errorBars.high]);
      if (low === null || high === null) return;
      const position = x(index, point);
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", errorBars.className);
      group.append(
        svgLine(position, y(low), position, y(high), "chart-error-bar-line"),
        svgLine(position - 5, y(low), position + 5, y(low), "chart-error-bar-cap"),
        svgLine(position - 5, y(high), position + 5, y(high), "chart-error-bar-cap"),
      );
      if (errorBars.tooltip !== false) {
        const barTitle = document.createElementNS(svg.namespaceURI, "title");
        const barCaption = chartSeriesCaption(
          chartText(errorBars.label, "errorBars label"),
          `${format(low)}–${format(high)}`,
        );
        setRawText(
          barTitle,
          point.timestamp
            ? `${barCaption} · ${formatChartTimestamp(point.timestamp)}`
            : barCaption,
        );
        group.append(barTitle);
      }
      svg.append(group);
    });
  }

  for (const interval of statusIntervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)
        || interval.endMs <= interval.startMs) continue;
    const band = TIMELINE_STATUS_BAND_CLASSES[interval.status];
    // No entry means no legend swatch, so nothing is drawn. Silently shading
    // an unkeyed status is what made the violet band unreadable.
    if (!band) continue;
    const plotWidth = width - margin.left - margin.right;
    const start = margin.left + (interval.startMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * plotWidth;
    const end = margin.left + (interval.endMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * plotWidth;
    const left = Math.max(margin.left, start);
    const bandWidth = Math.max(1, Math.min(width - margin.right, end) - left);
    const label = chartText(
      { key: timelineStatusKey(interval.status) },
      "status interval",
    );
    const shade = (element) => {
      const elementTitle = document.createElementNS(svg.namespaceURI, "title");
      setRawText(elementTitle, label);
      element.append(elementTitle);
      svg.append(element);
    };

    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(left));
    rect.setAttribute("y", String(margin.top));
    rect.setAttribute("width", String(bandWidth));
    rect.setAttribute("height", String(height - margin.top - margin.bottom));
    rect.setAttribute("class", `chart-status-${band}`);
    shade(rect);

    // The wash carries EXTENT and is never widened, so it cannot overstate how
    // long a mechanism was in force. This tick carries IDENTITY: a fixed
    // minimum width at legend-swatch strength, so a single excluded window —
    // four in the owner's 30d view, each under half a unit wide — reads as a
    // marker in its own hue instead of resolving to nothing. Drawn before the
    // series, so a line crossing the top of the plot still wins.
    const tickWidth = Math.max(STATUS_TICK_MINIMUM_WIDTH, bandWidth);
    const tickLeft = Math.min(
      width - margin.right - tickWidth,
      Math.max(margin.left, left + bandWidth / 2 - tickWidth / 2),
    );
    const tick = document.createElementNS(svg.namespaceURI, "rect");
    tick.setAttribute("x", String(tickLeft));
    tick.setAttribute("y", String(margin.top));
    tick.setAttribute("width", String(tickWidth));
    tick.setAttribute("height", String(STATUS_TICK_HEIGHT));
    tick.setAttribute("class", `chart-status-tick chart-status-${band}`);
    shade(tick);
  }

  for (const item of chartSeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      const previous = segment.at(-1);
      if (previous && ((item.segmentKey && previous.point[item.segmentKey] !== point[item.segmentKey])
          || (item.breakBefore && point[item.breakBefore])
          || (Number.isFinite(item.maxGapMs) && pointTimestampMs(point) - pointTimestampMs(previous.point) > item.maxGapMs))) {
        segments.push(segment);
        segment = [];
      }
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push({
        point,
        index,
        value,
        x: x(index, point),
        y: y(value),
      });
    });
    if (segment.length) segments.push(segment);
    if (item.connect !== false) for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute("points", pathPoints.map(({ x: xPosition, y: yPosition }) => `${xPosition},${yPosition}`).join(" "));
      path.setAttribute("class", item.className);
      if (item.lineFocusable === true) {
        const format = item.format ?? formatMoney;
        const representative = pathPoints[Math.floor(pathPoints.length / 2)];
        const heading = chartSeriesCaption(item.label, format(representative.value));
        const detail = typeof item.lineDetail === "function"
          ? chartText(
            item.lineDetail(pathPoints.map(({ point }) => point)),
            "lineDetail",
          )
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // The styled hover is the one tooltip; a native <title> repeated it
        // after a delay as the grey system tooltip. The caption survives on
        // aria-label.
        bindChartInteraction({
          element: path,
          heading,
          detail,
          xPosition: representative.x,
          yPosition: representative.y,
          pointer: item.lineTooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
      }
      svg.append(path);
    }
    {
      const format = item.format ?? formatMoney;
      points.forEach((point, index) => {
        // A classified series must not leave an invisible hover target over
        // a point belonging to another series. Marker visibility alone is
        // separate: dense timelines intentionally retain hover-only points.
        if (typeof item.pointFilter === "function" && !item.pointFilter(point)) return;
        const value = finite(point[item.key]);
        if (value === null) return;
        // Both coordinates are used three times each — the attribute, the
        // tooltip anchor, and the focus anchor — so they are computed once.
        const markerX = x(index, point);
        const markerY = y(value);
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(markerX));
        marker.setAttribute("cy", String(markerY));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 4;
        const showMarker = item.markers
          && Number.isFinite(visualRadius)
          && visualRadius > 0;
        const markerOpacity = typeof item.markerOpacity === "function"
          ? item.markerOpacity(point)
          : item.markerOpacity;
        marker.setAttribute("r", String(showMarker
          ? visualRadius
          : Math.max(7, finite(item.hitRadius, 8))));
        if (showMarker && Number.isFinite(markerOpacity)) {
          marker.setAttribute(
            "opacity",
            String(Math.max(0, Math.min(1, markerOpacity))),
          );
        }
        marker.setAttribute("class", showMarker
          ? `${item.className} chart-point`
          : `${item.className} chart-point chart-point-hit-target`);
        const timestamp = point.timestamp ?? point.date;
        const heading = chartSeriesCaption(item.label, format(value));
        const timestampDetail = timestamp ? formatChartTimestamp(timestamp) : null;
        const seriesDetail = item.detail
          ? chartText(item.detail(point), "series detail")
          : null;
        const detail = (item.timestampFirst
          ? [timestampDetail, seriesDetail]
          : [seriesDetail, timestampDetail]
        ).filter(Boolean).join(" · ");
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // Deliberately no native <title> on a point: the styled hover shows
        // this caption immediately, and the browser's delayed grey tooltip
        // then repeated it word for word (owner-reported double tooltip,
        // 2026-08-08). Keyboard and assistive technology keep the identical
        // sentence through the aria-label below.
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: markerX,
          yPosition: markerY,
          pointer: item.tooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
        svg.append(marker);
      });
    }
  }
  for (const item of chartSecondarySeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else {
        segment.push({
          point,
          index,
          value,
          x: x(index, point),
          y: ySecondary(value),
        });
      }
    });
    if (segment.length) segments.push(segment);
    for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute(
        "points",
        pathPoints.map(({ x: xPosition, y: yPosition }) => `${xPosition},${yPosition}`).join(" ")
      );
      path.setAttribute("class", item.className);
      if (item.lineFocusable === true) {
        const format = item.format ?? ((value) => formatPercent(value, 1));
        const representative = pathPoints[Math.floor(pathPoints.length / 2)];
        const heading = chartSeriesCaption(item.label, format(representative.value));
        const detail = typeof item.lineDetail === "function"
          ? chartText(
            item.lineDetail(pathPoints.map(({ point }) => point)),
            "secondary lineDetail",
          )
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // Same rule as the primary series: the styled hover owns the
        // tooltip, aria-label owns the accessible name, no native <title>.
        bindChartInteraction({
          element: path,
          heading,
          detail,
          xPosition: representative.x,
          yPosition: representative.y,
          pointer: item.lineTooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
      }
      svg.append(path);
    }
    {
      const format = item.format ?? ((value) => formatPercent(value, 1));
      points.forEach((point, index) => {
        // A classified series must not leave an invisible hover target over
        // a point belonging to another series. Marker visibility alone is
        // separate: dense timelines intentionally retain hover-only points.
        if (typeof item.pointFilter === "function" && !item.pointFilter(point)) return;
        const value = finite(point[item.key]);
        if (value === null) return;
        const markerX = x(index, point);
        const markerY = ySecondary(value);
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(markerX));
        marker.setAttribute("cy", String(markerY));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 2.6;
        const showMarker = item.markers
          && Number.isFinite(visualRadius)
          && visualRadius > 0;
        marker.setAttribute("r", String(showMarker
          ? visualRadius
          : Math.max(7, finite(item.hitRadius, 8))));
        marker.setAttribute("class", showMarker
          ? `${item.className} chart-point`
          : `${item.className} chart-point chart-point-hit-target`);
        const heading = chartSeriesCaption(item.label, format(value));
        const detail = point.timestamp ? formatChartTimestamp(point.timestamp) : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // No native <title>: the styled hover is the one tooltip on a point.
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: markerX,
          yPosition: markerY,
          pointer: item.tooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
        svg.append(marker);
      });
    }
  }
  svg.append(tooltip);
  svg.timelinePresentation = {
    svg, points: points.map((point, index) => ({ ...point, timestampMs: timestamps[index] })),
    series: chartSeries.map(item => ({ ...item, format: item.format ?? formatMoney })),
    x: point => margin.left + (point.timestampMs - domainStartMs) / (safeDomainEndMs - domainStartMs) * plotWidth,
    y, domain: { startMs: domainStartMs, endMs: safeDomainEndMs }, margin, width, height,
  };
  return svg;
}

function svgLine(x1, y1, x2, y2, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
  element.setAttribute("x1", x1);
  element.setAttribute("y1", y1);
  element.setAttribute("x2", x2);
  element.setAttribute("y2", y2);
  element.setAttribute("class", className);
  return element;
}

function svgText(x, y, value, className, anchor = "start") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "text");
  element.setAttribute("x", x);
  element.setAttribute("y", y);
  element.setAttribute("class", className);
  element.setAttribute("text-anchor", anchor);
  // SVG text stays out of the exact-text bridge: it mixes localized copy with
  // formatted numbers and instants that must never be matched against an
  // English phrase table. Its words are localized upstream instead, by
  // `chartText` inside `lineChart`, which is why that helper refuses a bare
  // string — this attribute is the reason a gap here would be invisible.
  element.setAttribute("data-i18n-skip", "");
  element.textContent = value;
  return element;
}

function isWellObservedWeeklyFit(observedSpanPp) {
  // An unrecorded span cannot be promoted to primary evidence. It remains an
  // outlined diagnostic so a missing measurement is never silently discarded.
  return observedSpanPp !== null && observedSpanPp >= activeWeeklyMinimumObservedSpanPp;
}

/**
 * The one presentation model for the allowance history in the dashboard and
 * on the share card. It deliberately contains only derived numerical evidence
 * and date-only labels, so both surfaces inherit the same inclusion, range,
 * point-classification, and axis decisions without exposing source rows.
 */
function allowanceHistoryChartModel(data, {
  rangeDays = activeWeeklyRangeDays,
} = {}) {
  const summary = data?.weekly?.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const allPoints = (Array.isArray(data?.weekly?.weeklyValues) ? data.weekly.weeklyValues : [])
    .map((row, index) => {
      const at = Date.parse(row?.last_observed_at ?? row?.first_observed_at ?? "");
      const value = finite(row?.value_usd ?? row?.value);
      const observedSpanPp = finite(row?.displayed_span_pp);
      if (!Number.isFinite(at) || value === null) return null;
      return Object.freeze({
        timestamp: row?.last_observed_at ?? row?.first_observed_at,
        at,
        dateLabel: shareCardDateLabel(at),
        resetDueAt: row?.reset_due_at ?? row?.resetAt ?? null,
        value,
        low: finite(row?.pairwise_p10_usd ?? row?.lower),
        high: finite(row?.pairwise_p90_usd ?? row?.upper),
        observedSpanPp,
        wellObserved: isWellObservedWeeklyFit(observedSpanPp),
        historicalMedian: estimate,
        acrossResetLow: lower,
        acrossResetHigh: upper,
        index,
      });
    })
    .filter((point) => point !== null)
    .sort((left, right) => left.at - right.at);
  const selectedEnd = Date.parse(data.reportingWindow?.endAt ?? "");
  const latestObservedAt = Number.isFinite(selectedEnd) ? selectedEnd : allPoints.at(-1)?.at ?? null;
  const validRangeDays = Number.isFinite(rangeDays) && rangeDays > 0 ? rangeDays : null;
  const boundedRangeDays = validRangeDays !== null
    && validRangeDays < ALL_HISTORY_RANGE_DAYS
    ? validRangeDays
    : null;
  const cutoffAt = latestObservedAt === null || boundedRangeDays === null
    ? Number.NEGATIVE_INFINITY
    : latestObservedAt - validRangeDays * 24 * 60 * 60 * 1_000;
  // A 7-day window over a roughly weekly per-reset series holds one or two
  // fits at most, and the shared span slider then filtered those away almost
  // every time, so the 7d button was near-guaranteed to show an empty chart
  // (estimator audit, 2026-08-08). Short ranges therefore relax the span
  // floor to zero: every fit in range draws, with short observations keeping
  // their outlined diagnostic styling. The effective floor travels with the
  // model so the hero sentence, the chart caption, and the share card all
  // describe the filter that actually applied.
  const spanFloorPp = boundedRangeDays !== null && boundedRangeDays <= 7
    ? 0
    : activeWeeklyMinimumObservedSpanPp;
  const inRange = allPoints.filter((point) => point.at >= cutoffAt
    && (latestObservedAt === null || point.at <= latestObservedAt));
  const points = inRange.filter((point) => (
    spanFloorPp === 0
      || (point.observedSpanPp !== null
        && point.observedSpanPp >= spanFloorPp)
  ));
  // Fit once after population/range/span selection. Both the dashboard and
  // the social image consume these exact values, including null gap breaks.
  const trends = buildAllowanceTrends(points);
  const axis = allowanceHistoryAxis(trends.points);
  return Object.freeze({
    allPoints: Object.freeze(allPoints),
    points: Object.freeze(trends.points.map((point) => Object.freeze(point))),
    lowessCount: trends.lowessCount,
    lowessReason: trends.reason,
    axis,
    xTicks: allowanceHistoryDateTicks(points),
    // The population facts the sentences around this model state: the corpus
    // size, how many fits fall in the selected range, the span floor that was
    // actually applied, the bounded range (null for "All"), and the selected
    // reporting end (falling back to the newest fit for standalone charts).
    totalCount: allPoints.length,
    inRangeCount: inRange.length,
    spanFloorPp,
    // The floor `wellObserved` classified against, which a relaxed range
    // leaves above `spanFloorPp`: the inclusion filter and the marker split
    // are two different decisions, and a surface that named the applied floor
    // beside an outlined point would explain the outline with the wrong
    // number. It travels with the model so the card can name it without
    // reading the slider itself.
    wellObservedFloorPp: activeWeeklyMinimumObservedSpanPp,
    rangeDays: boundedRangeDays,
    anchorAt: latestObservedAt,
  });
}

/**
 * Keep both renderers on the same vertical scale. This is the dashboard's
 * former chart-domain calculation expressed once: fitted values, across-reset
 * range, and each measured sensitivity range all count toward the domain.
 */
function allowanceHistoryAxis(points) {
  const values = (Array.isArray(points) ? points : [])
    .flatMap((point) => [
      finite(point?.value),
      finite(point?.historicalMedian),
      finite(point?.acrossResetLow),
      finite(point?.acrossResetHigh),
      finite(point?.low),
      finite(point?.high),
    ])
    .filter((value) => value !== null);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const padding = (high - low) * .1;
  low -= padding;
  high += padding;
  // Tick values a person could have chosen: snap outward to a 1/2/2.5/5-step
  // grid instead of slicing the raw data range into equal fourths, which
  // printed amounts like $1,006 and $2,447 on a dollar axis.
  const rawStep = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10]
    .map((base) => base * magnitude)
    .find((candidate) => candidate >= rawStep) ?? rawStep;
  const firstTick = Math.max(0, Math.floor(low / step) * step);
  const lastTick = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = lastTick; value >= firstTick - step / 2; value -= step) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return Object.freeze({
    low: firstTick,
    high: lastTick,
    ticks: Object.freeze(ticks),
  });
}

/**
 * Four evenly spaced date labels are legible in both the interactive view and
 * a posted image. They are based on the selected history domain rather than
 * on the density of reset fits.
 */
function allowanceHistoryDateTicks(points, maximum = 4) {
  const first = points?.[0]?.at;
  const last = points?.at(-1)?.at;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return Object.freeze([]);
  // Ticks take their resolution from the span they cover, so a month of resets
  // reads "Jan 5" while a multi-year history reads "Jan 2026" instead of every
  // tick repeating a full date.
  const spanMs = Math.max(0, last - first);
  if (last <= first) {
    return Object.freeze([
      Object.freeze({
        at: first,
        label: formatChartTimeLabel(first, { spanMs }),
        alignment: "middle",
      }),
    ]);
  }
  return Object.freeze(Array.from({ length: maximum }, (_, index) => {
    const at = first + spanMs * index / (maximum - 1);
    return Object.freeze({
      at,
      label: formatChartTimeLabel(at, { spanMs }),
      alignment: index === 0 ? "start" : index === maximum - 1 ? "end" : "middle",
    });
  }));
}

function weeklySpanLabel() {
  return activeWeeklyMinimumObservedSpanPp === 0
    ? t("weekly.span.all")
    : t("weekly.span.minimum", {
      span: formatDecimal(activeWeeklyMinimumObservedSpanPp, 0),
    });
}

// Sentences describe the floor the model actually applied, not the slider
// position: a short range relaxes the floor to zero, and a caption that kept
// naming the slider's floor would describe points the chart is not drawing.
function spanFloorSentenceLabel(spanFloorPp) {
  return spanFloorPp === 0
    ? t("weekly.span.none")
    : t("weekly.span.minimum", {
      span: formatDecimal(spanFloorPp, 0),
    });
}


function weeklyObservedSeriesLabel() {
  return activeWeeklyMinimumObservedSpanPp === 0
    ? { key: "weekly.series.allSpans" }
    : {
      key: "weekly.series.wellObserved",
      values: { span: formatDecimal(activeWeeklyMinimumObservedSpanPp, 0) },
    };
}

function weeklyPointDetail(point) {
  return {
    key: "weekly.point.detail",
    values: {
      span: formatPp(point.observedSpanPp),
      low: formatMoney(point.low),
      high: formatMoney(point.high),
    },
  };
}

function renderAllowanceHistoryChart(
  history,
  windowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES,
) {
  const fiveHour = windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  const lowessLegend = $("#weekly-lowess-legend");
  if (lowessLegend) lowessLegend.hidden = history.lowessCount === 0;
  const note = $("#weekly-trend-note");
  if (note) {
    note.hidden = false;
    setLocalizedText(note, history.lowessReason === "tooMany"
      ? "weekly.controls.trendTooMany"
      : history.lowessCount === 0 ? "weekly.controls.trendSparse" : "weekly.controls.trendNote");
  }
  return lineChart({
    points: history.points,
    width: Math.max(240, $("#weekly-chart")?.clientWidth || 900),
    series: [
      {
        key: "historicalMedian",
        className: "chart-line-weekly-center",
        label: { key: "weekly.series.allDataMedian" },
        // A flat reference line: one value repeated at every x, so a dot per
        // point would say nothing the line does not already say.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        lineFocusable: true,
        lineDetail: (points) => ({
          key: "share.resetFit",
          plural: points.length,
        }),
        format: (value) => formatMoney(value),
      },
      {
        key: "allowanceLowess",
        className: "chart-line-weekly-lowess",
        label: { key: "weekly.controls.lowess" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: (value) => formatMoney(value),
      },
      {
        key: "value",
        className: "chart-point-weekly-mature",
        label: weeklyObservedSeriesLabel(),
        connect: false,
        // Each dot is one observed seven-day reset. These are the plotted
        // points the chart exists to show; a shared "hide markers" flag once
        // turned every one of them into an invisible hit target. `markerRadius`
        // still splits well-observed from short observations across the two
        // point series, so exactly one of the pair draws each estimate.
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        format: (value) => formatMoney(value),
        detail: weeklyPointDetail,
        timestampFirst: true,
        pointFilter: (point) => point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 4 : 0,
      },
      {
        key: "value",
        className: "chart-point-weekly-partial",
        label: { key: "weekly.series.shortObservation" },
        connect: false,
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        format: (value) => formatMoney(value),
        detail: weeklyPointDetail,
        timestampFirst: true,
        pointFilter: (point) => !point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 0 : 4,
      },
    ],
    confidence: {
      low: "acrossResetLow",
      high: "acrossResetHigh",
      label: { key: "weekly.series.acrossResetRange" },
      format: (value) => formatMoney(value),
    },
    errorBars: {
      low: "low",
      high: "high",
      className: "chart-error-bar-weekly",
      label: { key: "weekly.series.measuredRange" },
      tooltip: false,
    },
    xDomain: {
      startMs: history.points[0]?.at,
      endMs: history.points.at(-1)?.at,
    },
    xTicks: history.xTicks,
    yDomain: history.axis,
    yTickFormat: (value, digits) => formatMoney(value, digits),
    yLabel: { key: fiveHour
      ? "weekly.chart.fiveHourAxis"
      : "chart.axis.apiEquivalentPerSevenDays" },
    title: { key: fiveHour
      ? "weekly.chart.fiveHourTitle"
      : "weekly.chart.title" },
    description: {
      key: fiveHour
        ? "weekly.chart.fiveHourDescription"
        : "weekly.chart.description",
      values: {
        span: spanFloorSentenceLabel(history.spanFloorPp),
        timeZone: formatTimeZoneLabel(),
      },
    },
  });
}

// The local pace engine is deliberately optional. Older companions and
// community/demo payloads do not carry this field, so the card is mounted
// lazily and remains hidden unless the engine returns current, safe weekly
// allowance evidence. One clean observation gets a quiet collecting state;
// this presentation never calls the allowance "tokens" and does not turn a
// pace estimate into a probability.
function firstFiniteForecastNumber(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

function forecastTimestamp(...values) {
  for (const value of values) {
    if (value instanceof Date && Number.isFinite(value.valueOf())) {
      return value.valueOf();
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length > 0) {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return null;
}

function formatAllowanceDuration(hours) {
  const value = finite(hours);
  if (value === null || value < 0) return null;
  if (value < 1) return t("allowance.lessThanHour");
  const wholeHours = Math.floor(value + 1e-8);
  const days = Math.floor(wholeHours / 24);
  return days > 0
    ? t("allowance.daysHours", { days: formatDecimal(days), hours: formatDecimal(wholeHours % 24) })
    : t("allowance.hours", { hours: formatDecimal(wholeHours) });
}

function allowanceTimestamp(label, timestamp) {
  if (timestamp === null) return node("span", "", label);
  const button = node("button", "allowance-timestamp", label);
  button.type = "button";
  const exact = dateTimeFormatter({
    timeZone: USER_TIME_ZONE, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(timestamp));
  button.dataset.informationExplanation = exact;
  button.setAttribute("aria-label", `${label} · ${exact}`);
  button.setAttribute("aria-expanded", "false");
  const show = () => {
    if (activeInformationPopover?.button !== button) openInformationPopover(button);
  };
  const hide = () => {
    if (activeInformationPopover?.button === button) closeInformationPopover();
  };
  button.addEventListener("mouseenter", show);
  button.addEventListener("mouseleave", () => {
    if (document.activeElement !== button) hide();
  });
  button.addEventListener("focus", show);
  button.addEventListener("blur", hide);
  button.addEventListener("click", (event) => { event.stopPropagation(); show(); });
  return button;
}

function formatForecastDuration(hours) {
  const value = finite(hours);
  if (value === null || value <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(value * 60));
  const days = Math.floor(totalMinutes / 1_440);
  const remainingHours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (remainingHours > 0) return `${remainingHours}h ${minutes}m`;
  return `${minutes}m`;
}

let weeklyPaceDetailsOpen = false;

function ensureWeeklyPaceForecastCard() {
  const hero = $("#quota-cards");
  if (!hero?.parentNode) return null;
  let card = $("#weekly-pace-forecast");
  if (!card) {
    card = node("aside", "weekly-pace-forecast");
    card.id = "weekly-pace-forecast";
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-atomic", "true");
    hero.parentNode.insertBefore(card, hero.nextSibling);
  }
  return card;
}

// Over, on and under pace are judged against the pace this window can still
// sustain - the allowance that is left, spread evenly across the time that is
// left - and never against a fixed 100%-per-seven-days rate.
//
// The fixed rate cannot answer the question a reader is actually asking,
// because it ignores where in the window they already stand. At 3% left with
// a day to go, "a steady weekly pace" is more than ten times too fast to
// survive the reset, yet the card called that "ahead of a steady weekly pace"
// and stayed green, because colour tracked whether the engine had an ETA
// rather than whether the reader was about to run dry (community report,
// 2026-08-18).
const PACE_ON_TRACK_LOWER_RATIO = .85;
const PACE_ON_TRACK_UPPER_RATIO = 1.15;
// At twice the sustainable pace the allowance covers less than half the time
// that is left, so the window ends with more dry hours than covered ones.
const PACE_CRITICAL_RATIO = 2;
// Under an hour of observations an overall rate is whatever the reader
// happened to be doing in that hour, so the headline falls back to the
// engine's active-interval pace and the card keeps saying it is early.
const PACE_AVERAGE_MINIMUM_HOURS = 1;
const PACE_STATE_LABELS = Object.freeze({
  over: "allowance.over",
  on: "allowance.on",
  under: "allowance.under",
});

/**
 * The two rates this card carries answer different questions and routinely
 * disagree by an order of magnitude.
 *
 * `pace.activePercentagePointsPerHour` is the engine's median over adjacent
 * intervals that actually moved, so it measures the pace *while working* and
 * discards every idle gap. Extrapolated across a whole window it assumes the
 * reader never stops, which is why a forecast built on it alone always lands
 * earlier than what happens - the "it always underestimates the time I have
 * left" complaint this card drew.
 *
 * `pace.overallPercentagePointsPerHour` is the same window's rate with idle
 * time included, and since quota-pace-forecast-v0.2 it is what the engine's
 * own `etaAt` and `status` are built from. That is the honest headline; the
 * active rate remains in the evidence disclosure as the without-pausing edge.
 * Only the headline run-out is marked on the track.
 *
 * The `movementPp / elapsedHours` fallback covers a payload that predates the
 * named rates. It carries a minimum-span guard the engine field does not need,
 * because a derived average over a few minutes is whatever the reader happened
 * to be doing; the engine gates the same risk through `earlyEstimate` instead.
 */
function weeklyPaceRates(pace, forecast) {
  const active = firstFiniteForecastNumber(
    pace.activePercentagePointsPerHour,
    pace.percentPerHour,
    pace.pacePercentPerHour,
    forecast.percentagePointsPerHour,
    forecast.pacePercentPerHour,
    forecast.pacePpPerHour,
  );
  const elapsedHours = firstFiniteForecastNumber(pace.elapsedHours);
  const movementPp = firstFiniteForecastNumber(pace.movementPp);
  const derivedAverage = elapsedHours !== null
    && elapsedHours >= PACE_AVERAGE_MINIMUM_HOURS
    && movementPp !== null
    && movementPp > 0
    ? movementPp / elapsedHours
    : null;
  const reported = firstFiniteForecastNumber(
    pace.overallPercentagePointsPerHour,
  );
  const average = reported !== null && reported > 0 ? reported : derivedAverage;
  return {
    active: active !== null && active > 0 ? active : null,
    average,
    // The wall-clock rate leads. Falling back to the working rate keeps the
    // card readable rather than blank when only that one is available.
    headline: average ?? (active !== null && active > 0 ? active : null),
  };
}

/**
 * Where the reader stands relative to the pace that just reaches the reset.
 *
 * `ratio` is the whole classification: 1 means the allowance runs out exactly
 * at the reset, above 1 means it runs out early, below 1 means some is left
 * over. Because the sustainable pace is `remaining / hoursToReset`, the ratio
 * is also `hoursToReset / hoursToExhaustion`, so the track below can be drawn
 * straight from it without a second, separately-rounded division.
 */
function weeklyPaceStanding({ remainingPercent, hoursToReset, pacePpPerHour }) {
  const remaining = finite(remainingPercent);
  const hoursLeft = finite(hoursToReset);
  const pace = finite(pacePpPerHour);
  if (remaining === null
      || hoursLeft === null
      || hoursLeft <= 0
      || remaining <= 0
      || pace === null
      || pace <= 0) return null;
  const sustainable = remaining / hoursLeft;
  const ratio = pace / sustainable;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const coveredHours = Math.min(hoursLeft, remaining / pace);
  const state = ratio > PACE_ON_TRACK_UPPER_RATIO
    ? "over"
    : ratio < PACE_ON_TRACK_LOWER_RATIO ? "under" : "on";
  return {
    ratio,
    state,
    critical: state === "over" && ratio >= PACE_CRITICAL_RATIO,
    sustainable,
    coveredHours,
    dryHours: Math.max(0, hoursLeft - coveredHours),
    // Only meaningful when the pace does not exhaust the window; an over-pace
    // reading leaves nothing spare by definition.
    sparePercent: Math.max(0, remaining - pace * hoursLeft),
  };
}

function formatPaceRatio(ratio) {
  const value = finite(ratio);
  if (value === null) return null;
  return `${formatDecimal(value, value < 10 ? 1 : 0)}×`;
}

/**
 * The window as a single track: how much of the time left to the reset the
 * remaining allowance actually covers, and how much of it is dry.
 *
 * The bar is deliberately a picture of time, not of allowance. "You have 3%
 * left" tells a reader nothing on its own; "that covers the next 20 minutes
 * of a day and five hours" is the fact they act on. The state name, the
 * heading and this track's own label all state the standing in words, so
 * colour is never the only carrier.
 */
function weeklyPaceTrack(standing, hoursToReset, resetAt) {
  const hoursLeft = finite(hoursToReset);
  if (!standing || hoursLeft === null || hoursLeft <= 0) return null;
  const coveredShare = Math.max(0, Math.min(1, standing.coveredHours / hoursLeft));
  const track = node("div", "weekly-pace-track");
  track.style.setProperty("--pace-covered", `${(coveredShare * 100).toFixed(2)}%`);
  // Near either edge, stack callouts and retain the exact marker position.
  // This avoids overlapping labels without falsifying the time geometry.
  track.classList.toggle("is-edge", coveredShare < .22 || coveredShare > .78);
  const labels = node("div", "weekly-pace-track-labels");
  const dry = standing.dryHours > 0;
  if (dry) {
    const runout = node("div", "weekly-pace-track-runout");
    runout.append(node("span", "", t("allowance.runout")),
      allowanceTimestamp(t("allowance.inDuration", {
        duration: formatAllowanceDuration(standing.coveredHours),
      }), resetAt - standing.dryHours * 3_600_000));
    labels.append(runout);
  }
  const reset = node("div", "weekly-pace-track-reset");
  reset.append(node("span", "", t("allowance.resets")),
    allowanceTimestamp(t("allowance.inDuration", {
      duration: formatAllowanceDuration(hoursLeft),
    }), resetAt));
  labels.append(reset);
  const bar = node("div", "weekly-pace-track-bar");
  const covered = node("div", "weekly-pace-track-covered");
  covered.style.inlineSize = `${(coveredShare * 100).toFixed(2)}%`;
  bar.append(covered);
  if (dry) {
    const mark = node("div", "weekly-pace-track-mark");
    mark.style.insetInlineStart = `${(coveredShare * 100).toFixed(2)}%`;
    bar.append(mark);
  }
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", t(dry ? "allowance.trackDry" : "allowance.trackCovered", {
    reset: formatAllowanceDuration(hoursLeft),
    covered: formatAllowanceDuration(standing.coveredHours),
    dry: formatAllowanceDuration(standing.dryHours),
  }));
  const scale = node("div", "weekly-pace-track-scale");
  scale.append(node("span", "", t("allowance.now")));
  scale.append(node("span", "weekly-pace-track-gap", dry
    ? t("allowance.dryDuration", { duration: formatAllowanceDuration(standing.dryHours) })
    : t("allowance.untilReset")));
  track.append(labels, bar, scale);
  return track;
}

function renderWeeklyPaceWaiting(card, data) {
  const primary = Array.isArray(data?.quotaWindows)
    ? data.quotaWindows.find(isPrimaryCodexWeeklyQuotaWindow)
    : null;
  if (!primary) return;
  const stale = primary.status === "stale";
  const heading = node("div", "weekly-pace-forecast-heading");
  const kicker = node("p", "panel-kicker");
  const logo = node("img", "quota-codex-icon");
  logo.setAttribute("src", "./codex-color.svg");
  logo.setAttribute("alt", "");
  logo.setAttribute("aria-hidden", "true");
  kicker.append(logo, node("span", "", t("allowance.forecast")));
  heading.append(kicker, node("span", "evidence-chip weekly-pace-forecast-collecting-chip",
    t(stale ? "allowance.stale" : "allowance.waiting")));
  const title = node("h3", "weekly-pace-forecast-title",
    t(stale ? "allowance.waitingStaleTitle" : "allowance.waitingTitle"));
  title.id = "weekly-pace-forecast-title";
  card.setAttribute("aria-labelledby", title.id);
  card.className = "weekly-pace-forecast is-insufficient is-waiting";
  card.append(heading, title, node("p", "weekly-pace-forecast-copy",
    t(stale ? "allowance.waitingStaleCopy" : "allowance.waitingCopy")));
  card.hidden = false;
}

function renderWeeklyPaceForecast(data) {
  const card = ensureWeeklyPaceForecastCard();
  if (!card) return;
  card.hidden = true;
  card.className = "weekly-pace-forecast";
  delete card.dataset.tankRatio;
  delete card.dataset.tankReset;
  delete card.dataset.tankRemaining;
  card.removeAttribute("aria-labelledby");
  clear(card);

  const forecast = data?.weekly?.paceForecast;
  const stalePrimary = Array.isArray(data?.quotaWindows)
    && data.quotaWindows.some(window => isPrimaryCodexWeeklyQuotaWindow(window)
      && window.status === "stale");
  if (stalePrimary || !forecast || typeof forecast !== "object" || Array.isArray(forecast)) {
    return renderWeeklyPaceWaiting(card, data);
  }
  const pace = forecast.pace && typeof forecast.pace === "object"
    ? forecast.pace
    : {};
  const rawStatus = String(forecast.status ?? forecast.state ?? "")
    .trim()
    .toLowerCase();
  const status = rawStatus === "reset_before_exhaustion"
    ? "will_reach_reset_first"
    : rawStatus;
  const resetAt = forecastTimestamp(
    forecast.resetsAt,
    forecast.resetAt,
    forecast.reset_at,
  );
  const now = Date.now();
  if (resetAt === null || resetAt <= now) return renderWeeklyPaceWaiting(card, data);

  let remaining = firstFiniteForecastNumber(
    forecast.remainingPercent,
    forecast.remaining_percentage,
    forecast.currentRemainingPercent,
  );
  const used = firstFiniteForecastNumber(
    forecast.currentUsedPercent,
    forecast.usedPercent,
    forecast.current_used_percent,
  );
  if (remaining === null && used !== null) remaining = 100 - used;
  if (remaining !== null && (remaining < 0 || remaining > 100)) remaining = null;

  const rates = weeklyPaceRates(pace, forecast);
  const headlinePace = rates.headline;
  const hoursToReset = firstFiniteForecastNumber(
    (resetAt - now) / 3_600_000,
    forecast.hoursToReset,
    forecast.resetHours,
  );
  const suppliedHoursToExhaustion = firstFiniteForecastNumber(
    forecast.hoursToExhaustion,
    forecast.hoursToAllowance,
    forecast.etaHours,
  );
  let etaAt = forecastTimestamp(
    forecast.etaAt,
    forecast.exhaustionAt,
    forecast.allowanceAt,
  );
  if (etaAt === null && suppliedHoursToExhaustion !== null && suppliedHoursToExhaustion > 0) {
    etaAt = now + suppliedHoursToExhaustion * 3_600_000;
  }
  const available = status === "available"
    || (status === "" && etaAt !== null && headlinePace !== null);
  const reachesResetFirst = status === "will_reach_reset_first"
    || status === "reset_before_exhaustion";
  const paceIntervals = firstFiniteForecastNumber(pace.sampleCount);
  const observations = firstFiniteForecastNumber(
    forecast.observationCount,
    forecast.observations,
    forecast.sampleCount,
    paceIntervals === null ? null : paceIntervals + 1,
  );
  const paceElapsedHours = firstFiniteForecastNumber(pace.elapsedHours);
  // A single trusted snapshot cannot establish a rate, but it is useful to
  // say why the forecast is not visible yet. Do not surface an unbounded or
  // otherwise unusable engine result as a generic empty state.
  const collectingEvidence = status === "insufficient_observations"
    && observations === 1;
  const earlyEstimate = available && (
    (observations !== null && observations <= 2)
    || (paceElapsedHours !== null && paceElapsedHours < 1)
  );
  // A contradiction between the status and dates is an integration error, not
  // a reason to show a confident-looking card. Wait for the next refresh.
  if (available && (etaAt === null || etaAt <= now || etaAt > resetAt)) return renderWeeklyPaceWaiting(card, data);
  if (!available && !reachesResetFirst && !collectingEvidence) return renderWeeklyPaceWaiting(card, data);
  if (collectingEvidence && remaining === null) return renderWeeklyPaceWaiting(card, data);
  if (!collectingEvidence
      && remaining === null
      && headlinePace === null
      && !reachesResetFirst) return renderWeeklyPaceWaiting(card, data);

  // The standing is computed from the headline rate, so the card's colour,
  // its heading and its arithmetic all come from one number. The engine's own
  // `available` / `will_reach_reset_first` split still gates whether a card
  // appears at all, but it no longer decides how the card reads: an engine ETA
  // built on the active-interval pace is exactly the reading that overstated
  // the burn.
  const standing = collectingEvidence
    ? null
    : weeklyPaceStanding({
      remainingPercent: remaining,
      hoursToReset,
      pacePpPerHour: headlinePace,
    });
  if (standing) {
    card.dataset.tankRatio = String(standing.ratio);
    card.dataset.tankReset = String(resetAt);
    card.dataset.tankRemaining = String(remaining);
  }
  const paceState = standing?.state
    ?? (collectingEvidence ? null : reachesResetFirst ? "under" : null);
  const projectedEtaAt = standing !== null && standing.state === "over"
    ? now + standing.coveredHours * 3_600_000
    : null;

  const title = node("h3", "weekly-pace-forecast-title");
  const cardId = "weekly-pace-forecast-title";
  title.id = cardId;
  title.textContent = collectingEvidence
    ? t("allowance.collectingTitle")
    : paceState === "over"
      ? projectedEtaAt === null
        ? t("allowance.beforeReset")
        : t("allowance.headline", { duration: formatAllowanceDuration(standing.coveredHours) })
      : paceState === "on"
        ? t("allowance.nearReset")
        : t("allowance.spareTitle");
  if (projectedEtaAt !== null) {
    const [before, after] = t("allowance.headline", { duration: "{duration}" }).split("{duration}");
    title.replaceChildren(document.createTextNode(before),
      allowanceTimestamp(formatAllowanceDuration(standing.coveredHours), projectedEtaAt),
      document.createTextNode(after ?? ""));
  }
  card.setAttribute("aria-labelledby", cardId);

  const heading = node("div", "weekly-pace-forecast-heading");
  const kicker = node("p", "panel-kicker");
  if (collectingEvidence) {
    kicker.textContent = t("allowance.collecting");
  } else {
    const logo = node("img", "quota-codex-icon");
    logo.setAttribute("src", "./codex-color.svg");
    logo.setAttribute("alt", "");
    logo.setAttribute("aria-hidden", "true");
    kicker.append(logo, node("span", "", t("allowance.forecast")));
  }
  heading.append(kicker);
  if (collectingEvidence) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-collecting-chip",
      t("allowance.oneMore"),
    ));
  } else if (paceState) {
    // The standing is named in words on the chip as well as carried in the
    // card's colour, so the over/on/under reading survives a monochrome
    // screen, a colour-vision difference and a screen reader alike.
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-state-chip",
      t(standing?.critical ? "allowance.wayOver" : PACE_STATE_LABELS[paceState]),
    ));
  }
  if (earlyEstimate) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-early-chip",
      t("allowance.early"),
    ));
  }

  const ratioLabel = standing === null ? null : formatPaceRatio(standing.ratio);
  const dryDuration = standing === null
    ? null
    : standing.dryHours > 0 ? formatAllowanceDuration(standing.dryHours) : null;
  const copy = node("p", "weekly-pace-forecast-copy");
  copy.textContent = collectingEvidence
    ? t("allowance.collectingCopy")
    : standing === null
      ? t("allowance.slowCopy")
      : standing.state === "over"
        ? t("allowance.overCopy", { ratio: ratioLabel, gap: dryDuration ? t("allowance.gapCopy", { duration: dryDuration }) : "" })
        : standing.state === "on"
          ? t("allowance.onCopy")
          : t("allowance.underCopy", { ratio: ratioLabel });
  if (earlyEstimate) {
    copy.textContent += ` ${t("allowance.earlyCopy")}`;
  }

  const metrics = node("div", "weekly-pace-forecast-metrics");
  const addMetric = (label, value) => {
    const item = node("div", "weekly-pace-forecast-metric");
    item.append(node("span", "", label), node("strong", "", value));
    metrics.append(item);
  };
  if (remaining !== null) addMetric(t("allowance.left"), formatPercent(remaining));
  const resetDuration = formatAllowanceDuration(hoursToReset);
  if (resetDuration) addMetric(t("allowance.resetsIn"), resetDuration);
  if (collectingEvidence) {
    addMetric(t("allowance.evidence"), t("allowance.oneSaved"));
  } else if (dryDuration) {
    // A dry stretch and spare allowance are mutually exclusive, and the tile
    // reports whichever one the reading actually produced rather than pinning
    // itself to the state name.
    addMetric(t("allowance.dry"), dryDuration);
  } else if (standing !== null) {
    addMetric(t("allowance.spare"), formatPercent(standing.sparePercent));
  } else if (headlinePace !== null && headlinePace > 0) {
    addMetric(t("allowance.recentPace"), t("allowance.rate", { rate: formatDecimal(headlinePace, 1) }));
  }

  const track = collectingEvidence
    ? null
    : weeklyPaceTrack(standing, hoursToReset, resetAt);

  // The evidence line names both rates. A reader who wondered why the old
  // card's forecast kept arriving early can see the difference between the
  // pace with idle time counted and the pace while working, instead of being
  // handed one number with no way to tell which it was.
  const observationDuration = formatForecastDuration(paceElapsedHours);
  const rateSentences = [];
  if (rates.average !== null) {
    rateSentences.push(t("allowance.overallRate", { rate: formatDecimal(rates.average, 1) }));
  }
  if (rates.active !== null) {
    rateSentences.push(t("allowance.activeRate", { rate: formatDecimal(rates.active, 1) }));
  }
  const evidence = observations !== null && observations >= 1
    ? node(
      "p",
      "weekly-pace-forecast-evidence",
      collectingEvidence
        ? t("allowance.oneObservation")
        : t("allowance.observations", { count: formatDecimal(Math.round(observations), 0), duration: observationDuration ? t("allowance.overDuration", { duration: observationDuration }) : "", rates: rateSentences.length > 0 ? `: ${rateSentences.join(", ")}` : "" }),
    )
    : null;
  card.className = [
    "weekly-pace-forecast",
    collectingEvidence
      ? "is-insufficient"
      : paceState === "over"
        ? "is-over-pace"
        : paceState === "on" ? "is-on-pace" : "is-under-pace",
    standing?.critical ? "is-critical" : "",
    earlyEstimate ? "is-early-estimate" : "",
    // Retained so the engine's own split stays inspectable from the DOM even
    // though it no longer drives presentation.
    reachesResetFirst ? "is-reset-first" : "",
    available ? "is-available" : "",
  ].filter(Boolean).join(" ");
  card.append(heading, title, copy);
  if (track) card.append(track);
  const details = node("details", "weekly-pace-details");
  details.open = weeklyPaceDetailsOpen;
  details.addEventListener("toggle", () => { weeklyPaceDetailsOpen = details.open; });
  details.append(node("summary", "", t("allowance.basis")), metrics);
  if (evidence) details.append(evidence);
  if (rates.active !== null && remaining !== null && rates.active > 0) {
    details.append(node("p", "weekly-pace-track-note", t("allowance.active", {
      duration: formatAllowanceDuration(remaining / rates.active),
    })));
  }
  card.append(details);
  card.hidden = false;
}

function allowanceHistoryForWindow(data, windowMinutes) {
  if (windowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) return data?.weekly ?? null;
  if (windowMinutes !== CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) return null;
  return data?.allowanceHistoryByWindow?.[
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
  ] ?? null;
}

function allowanceHistoryHasEvidence(history) {
  return history !== null && (
    history?.status === "available"
    || (Array.isArray(history?.weeklyValues) && history.weeklyValues.length > 0)
  );
}

function resolvedAllowanceWindowMinutes(data) {
  const fiveHour = allowanceHistoryForWindow(
    data,
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  );
  if (activeAllowanceWindowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      && fiveHour !== null) return CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  if (activeAllowanceWindowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return allowanceHistoryHasEvidence(data?.weekly) || fiveHour === null
      ? CODEX_WEEKLY_ALLOWANCE_MINUTES
      : CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  }
  if (allowanceHistoryHasEvidence(data?.weekly)) {
    return CODEX_WEEKLY_ALLOWANCE_MINUTES;
  }
  return fiveHour !== null
    ? CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
    : CODEX_WEEKLY_ALLOWANCE_MINUTES;
}

function allowanceWindowView(data) {
  const windowMinutes = resolvedAllowanceWindowMinutes(data);
  if (windowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return {
      ...selectAllowancePlanPopulation(data, activeWeeklyPlanType),
      allowanceWindowDurationMinutes: windowMinutes,
    };
  }
  const windowData = {
    ...data,
    weekly: allowanceHistoryForWindow(data, windowMinutes),
    quotaWindows: (Array.isArray(data?.quotaWindows) ? data.quotaWindows : [])
      .filter((window) => (
        isPrimaryCodexQuotaWindow(window)
        && finite(window?.durationMinutes) === windowMinutes
      )),
    allowanceWindowDurationMinutes: windowMinutes,
  };
  return selectAllowancePlanPopulation(windowData, activeWeeklyPlanType);
}

function renderAllowanceWindowChrome(data, windowMinutes) {
  const fiveHourSelected = windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  const fiveHourAvailable = allowanceHistoryForWindow(
    data,
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  ) !== null;
  const controls = $("#allowance-window-controls");
  const buttons = typeof controls?.querySelectorAll === "function"
    ? controls.querySelectorAll("button[data-window-minutes]")
    : [];
  for (const button of buttons) {
    const duration = Number(button.dataset.windowMinutes);
    const active = duration === windowMinutes;
    const unavailable = duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      && !fiveHourAvailable;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = unavailable;
    button.title = unavailable ? t("weekly.window.unavailable") : "";
    setLocalizedText(button, duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      ? "weekly.window.fiveHour"
      : "weekly.window.sevenDay");
  }
  setLocalizedText($("#weekly-title"), "page.weekly.title");
  const note = $("#allowance-window-note");
  note.hidden = !fiveHourSelected && fiveHourAvailable;
  if (!note.hidden) setLocalizedText(note, fiveHourSelected
    ? "weekly.window.historyOnly"
    : "weekly.window.unavailable");
  $("#share-panel").hidden = fiveHourSelected;
  setLocalizedText($("#weekly-table-caption"), fiveHourSelected
    ? "weekly.table.fiveHourCaption"
    : "weekly.table.sevenDayCaption");
}

function renderWeeklyPlanControl(data) {
  const control = $("#weekly-plan-control");
  const select = $("#weekly-plan-select");
  const note = $("#weekly-plan-note");
  if (!control || !select || !note) return;
  const selection = data.allowancePlanSelection;
  const previewPlan = data.mode === "demo"
    ? shareCardPlanLabel(data?.weekly?.planType)
    : "";
  control.hidden = !selection && previewPlan === "";
  note.hidden = !selection;
  if (!selection) {
    if (previewPlan !== "") {
      const signature = `preview:${data.weekly.planType}:${localization.locale()}`;
      if (select.dataset.populationSignature !== signature) {
        const option = node("option");
        option.value = data.weekly.planType;
        option.textContent = t("weekly.plan.latestOption", { plan: previewPlan });
        select.replaceChildren(option);
        select.dataset.populationSignature = signature;
      }
      select.value = data.weekly.planType;
      select.disabled = true;
    }
    return;
  }
  const populations = data.weekly.planPopulations ?? [];
  const signature = JSON.stringify([
    populations.map((row) => row.planType),
    selection.currentPlanType,
    localization.locale(),
  ]);
  if (select.dataset.populationSignature !== signature) {
    select.replaceChildren(...populations.map((row) => {
      const option = node("option");
      option.value = row.planType;
      option.textContent = t(row.planType === selection.currentPlanType
        ? "weekly.plan.latestOption" : "weekly.plan.historyOption", {
        plan: shareCardPlanLabel(row.planType) || t("weekly.plan.unknown"),
      });
      return option;
    }));
    select.dataset.populationSignature = signature;
  }
  select.value = selection.planType;
  select.disabled = populations.length < 2;
  setLocalizedText(note, selection.isCurrentPlan
    ? "weekly.plan.conditional" : "weekly.plan.historicalConditional", {
    plan: shareCardPlanLabel(selection.planType) || t("weekly.plan.unknown"),
  });
}

function renderWeekly(data) {
  const rootData = data;
  data = allowanceWindowView(data);
  const windowMinutes = data.allowanceWindowDurationMinutes;
  renderAllowanceWindowChrome(rootData, windowMinutes);
  renderWeeklyPlanControl(data);
  // A weekly estimate carried over from the previous app version while the
  // recalculation runs announces itself here, quietly.
  renderStaleServeNote(
    $("#weekly-stale-note"),
    data?.weekly?.stale?.stale === true,
  );
  const summary = data.weekly.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const qualifying = finite(summary.qualifying_resets ?? summary.qualifyingResets, 0);

  const history = allowanceHistoryChartModel(data);
  const values = history.allPoints;
  const chartValues = history.points;

  // The headline is a stable all-data median. The range buttons and the
  // minimum-observed-span slider filter the chart and nothing else, so the two
  // numbers could differ by hundreds of dollars with nothing on screen saying
  // why. They now say so: the hero names its population, and the sentence
  // underneath reports how much of that population the chart is drawing. The
  // headline is deliberately not made to follow the filter — a figure people
  // quote should not move when they adjust a chart control.
  const planLabel = shareCardPlanLabel(data.weekly.planType) || t("weekly.plan.unknown");
  setLocalizedText($("#weekly-estimate-label"), data.allowancePlanSelection
    ? "weekly.headline.planLabel" : "weekly.headline.label", { plan: planLabel });
  $("#weekly-estimate").textContent = estimate === null
    ? t("weekly.headline.insufficient")
    : t("weekly.headline.value", { amount: formatMoney(estimate) });
  $("#weekly-range").textContent = lower === null || upper === null
    ? t("weekly.headline.rangeUnavailable")
    : t(data.allowancePlanSelection
      ? "weekly.headline.planRange" : "weekly.headline.range", {
      plan: planLabel,
      lower: formatMoney(lower),
      upper: formatMoney(upper),
    });
  $("#weekly-explanation").textContent = qualifying
    ? t("weekly.headline.relationship", {
      qualifying: formatDecimal(qualifying, 0),
      shown: formatDecimal(chartValues.length, 0),
      total: formatDecimal(values.length, 0),
      // The floor the model actually applied — a short range relaxes it —
      // and the selected reporting end. Standalone charts fall back to the
      // newest fit, while the dashboard follows the shared reporting window.
      span: spanFloorSentenceLabel(history.spanFloorPp),
      anchor: history.anchorAt === null
        ? "—"
        : shareCardDateLabel(history.anchorAt),
    })
    : t("weekly.headline.pending");

  setLocalizedText($("#weekly-chart-timezone"), "chart.timeZoneNote", {
    timeZone: formatTimeZoneLabel(),
  });
  // Short ranges include every fit; here the slider only classifies markers.
  // Name that role explicitly instead of presenting an inactive minimum filter.
  const shortRange = history.rangeDays !== null && history.rangeDays <= 7;
  setLocalizedText($("#weekly-span-label"), shortRange
    ? "weekly.controls.observedSpan" : "weekly.controls.minimumSpan");
  const spanNote = $("#weekly-span-note");
  spanNote.hidden = !shortRange;
  setLocalizedText(spanNote, "weekly.controls.shortRangeNote");
  $("#weekly-span-value").textContent = weeklySpanLabel();
  $("#weekly-span-legend").textContent = chartText(weeklyObservedSeriesLabel());
  $("#weekly-partial-legend").hidden = !chartValues.some((row) => !row.wellObserved);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!chartValues.length) {
    $("#weekly-lowess-legend").hidden = true;
    $("#weekly-trend-note").hidden = true;
    empty.hidden = false;
    shell.hidden = true;
    // An empty chart names its reason instead of the generic sentence: either
    // no fits fall in the selected range at all, or fits are in range and the
    // span floor filtered every one of them (estimator audit, 2026-08-08).
    if (values.length === 0) {
      setLocalizedText(empty, windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
        ? "weekly.chart.fiveHourEmpty"
        : "weekly.chart.empty");
    } else if (history.inRangeCount === 0) {
      setLocalizedText(empty, "weekly.chart.emptyRange");
    } else {
      setLocalizedPluralText(
        empty,
        "weekly.chart.emptyBelowFloor",
        history.inRangeCount,
        { span: formatDecimal(history.spanFloorPp, 0) },
      );
    }
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(renderAllowanceHistoryChart(history, windowMinutes));
  }
  renderWeeklyTable(values, windowMinutes);
  // The chart renderer owns the card re-render (owner-verified regression,
  // 2026-08-08). The old wiring re-rendered the card only where a caller
  // remembered to, so a path that redrew the chart without the extra call
  // left the card describing the previous filters. Every path that renders
  // the allowance history — the range buttons, the span slider, a dashboard
  // load, a locale change — now redraws the card from the SAME model
  // instance, so the two surfaces cannot disagree.
  if (windowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    renderShareCard(data, { history });
  }
}

// The Allowance page's reset-estimate table pages through its full row set
// (owner-directed 2026-08-10) instead of truncating to the newest fourteen:
// twenty rows per page, newest first, same pager idiom as the exact-windows
// inspection table. The state lives beside its renderers so the render
// harness that extracts this section gets the whole mechanism.
const WEEKLY_TABLE_PAGE_SIZE = 20;
let weeklyTablePage = 0;
let weeklyTableRows = [];
let weeklyTableSignature = "";
let weeklyTableWindowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES;

function renderWeeklyTable(values, windowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES) {
  // Newest first over the FULL set: the old `.slice(-14)` silently dropped
  // every earlier reset estimate. A changed row set restarts at the first
  // page, exactly like the exact-windows inspection table: a page index only
  // describes a position within one row set.
  const rows = [...values].reverse();
  const signature = `${rows.length}`
    + `:${rows[0]?.timestamp ?? ""}`
    + `:${rows.at(-1)?.timestamp ?? ""}`;
  if (signature !== weeklyTableSignature) {
    weeklyTableSignature = signature;
    weeklyTablePage = 0;
  }
  weeklyTableRows = rows;
  weeklyTableWindowMinutes = windowMinutes;
  renderWeeklyTablePage();
}

function renderWeeklyTablePage() {
  const table = $("#weekly-table");
  if (!table) return;
  clear(table);
  const rows = weeklyTableRows;
  const pagination = $("#weekly-table-pagination");
  if (!rows.length) {
    if (pagination) pagination.hidden = true;
    const row = node("tr");
    const cell = node("td", "empty-cell", t(
      weeklyTableWindowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
        ? "weekly.table.fiveHourEmpty"
        : "weekly.table.empty",
    ));
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  const pageCount = Math.ceil(rows.length / WEEKLY_TABLE_PAGE_SIZE);
  weeklyTablePage = Math.min(Math.max(0, weeklyTablePage), pageCount - 1);
  const start = weeklyTablePage * WEEKLY_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + WEEKLY_TABLE_PAGE_SIZE);
  for (const row of pageRows) {
    const span = row.observedSpanPp ?? finite(row.displayed_span_pp);
    const status = isWellObservedWeeklyFit(span)
      ? t("weekly.table.wellObserved")
      : span === null
        ? t("weekly.table.spanNotRecorded")
        : t("weekly.series.shortObservation");
    const evidenceDate = formatLocal(row.timestamp, { dateOnly: true });
    const tr = node("tr");
    tr.append(
      node("td", "", evidenceDate),
      node("td", "", formatPp(span)),
      node("td", "", formatMoney(row.value)),
      node("td", "", row.low === null || row.high === null ? "—" : `${formatMoney(row.low)}–${formatMoney(row.high)}`),
      node("td", "", status),
    );
    table.append(tr);
  }
  if (!pagination) return;
  // The pager renders only when there is something to page through; a set
  // that fits one page keeps the plain table.
  pagination.hidden = pageCount <= 1;
  setLocalizedText($("#weekly-table-status"), "weekly.table.page", {
    start: formatNumber(start + 1),
    end: formatNumber(start + pageRows.length),
    total: formatNumber(rows.length),
  });
  const previous = $("#weekly-table-prev");
  const next = $("#weekly-table-next");
  if (previous) previous.disabled = weeklyTablePage === 0;
  if (next) next.disabled = weeklyTablePage >= pageCount - 1;
}

function accountingPeriod(data) {
  const periods = Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : [];
  const selected = periods.find(
    (period) => period?.periodId === activeAccountingPeriod,
  );
  if (!selected) return null;
  // Accounting calls the archive-backed broad period `history`; the switch
  // analyzer calls the same complete unified-index scan `all`.
  const cacheSwitchPeriodId = selected.periodId === "history"
    ? "all"
    : selected.periodId;
  const rootCacheSwitchImpact = data.accounting.cacheSwitchImpact;
  const periodCacheSwitchImpact = Array.isArray(rootCacheSwitchImpact?.periods)
    ? rootCacheSwitchImpact.periods.find(
      (period) => period?.periodId === cacheSwitchPeriodId,
    )
    : null;
  const selectedCacheSwitchImpact = selected.cacheSwitchImpact?.status === "available"
    ? selected.cacheSwitchImpact
    : periodCacheSwitchImpact?.status === "available"
      ? periodCacheSwitchImpact
      : rootCacheSwitchImpact?.status === "available"
          && rootCacheSwitchImpact.periodId === cacheSwitchPeriodId
        ? rootCacheSwitchImpact
        : { status: "unavailable", recent: [], allowanceImpact: { status: "unavailable" } };
  // The weekly allowance translation is attached only to the selected root
  // summary unless the companion explicitly places one on this period. Never
  // let a 7-day translation leak onto a 24-hour or history selection.
  const allowanceImpact = ["complete", "range"].includes(
    selectedCacheSwitchImpact.allowanceImpact?.status,
  )
    ? selectedCacheSwitchImpact.allowanceImpact
    : rootCacheSwitchImpact?.periodId === cacheSwitchPeriodId
      ? rootCacheSwitchImpact.allowanceImpact
      : { status: "unavailable" };
  const rootCacheContinuityImpact = data.accounting.cacheContinuityImpact;
  const periodCacheContinuityImpact = Array.isArray(
    rootCacheContinuityImpact?.periods,
  )
    ? rootCacheContinuityImpact.periods.find(
      (period) => period?.periodId === cacheSwitchPeriodId,
    )
    : null;
  const selectedCacheContinuityImpact = selected.cacheContinuityImpact?.status
      === "available"
    ? selected.cacheContinuityImpact
    : periodCacheContinuityImpact?.status === "available"
      ? periodCacheContinuityImpact
      : rootCacheContinuityImpact?.status === "available"
          && rootCacheContinuityImpact.periodId === cacheSwitchPeriodId
        ? rootCacheContinuityImpact
        : { status: "unavailable", recent: [], allowanceImpact: { status: "unavailable" } };
  const continuityAllowanceImpact = selectedCacheContinuityImpact
    .allowanceImpact?.status && ["complete", "range"].includes(
      selectedCacheContinuityImpact.allowanceImpact.status,
    )
    ? selectedCacheContinuityImpact.allowanceImpact
    : rootCacheContinuityImpact?.periodId === cacheSwitchPeriodId
      ? rootCacheContinuityImpact.allowanceImpact
      : { status: "unavailable" };
  const rootSideChatEstimates = data.accounting.sideChatEstimates;
  const sideChatPeriod = rootSideChatEstimates?.status === "available"
    ? rootSideChatEstimates.periods.find(
      (period) => period?.periodId === cacheSwitchPeriodId,
    )
    : null;
  const sideChatStartMs = Date.parse(sideChatPeriod?.startAt ?? "");
  const sideChatEndMs = Date.parse(sideChatPeriod?.endAt ?? "");
  const sideChatNumericCoverageStartMs = Date.parse(
    rootSideChatEstimates?.coverage?.logs2?.startAt ?? "",
  );
  const sideChatSelectionCoverage = sideChatPeriod !== null
      && Number.isFinite(sideChatStartMs)
      && Number.isFinite(sideChatNumericCoverageStartMs)
      && sideChatNumericCoverageStartMs <= sideChatStartMs
    ? "selected_period_within_numeric_retention"
    : "retained_subset_of_selected_period";
  const sideChatRecent = sideChatPeriod === null
    ? []
    : rootSideChatEstimates.recent.filter((row) => {
      const observedMs = Date.parse(row.observedAt);
      return Number.isFinite(observedMs)
        && (!Number.isFinite(sideChatStartMs) || observedMs >= sideChatStartMs)
        && (!Number.isFinite(sideChatEndMs) || observedMs <= sideChatEndMs);
    });
  return {
    ...data.accounting,
    ...selected,
    cacheSwitchImpact: {
      ...selectedCacheSwitchImpact,
      allowanceImpact,
    },
    cacheContinuityImpact: {
      ...selectedCacheContinuityImpact,
      allowanceImpact: continuityAllowanceImpact,
    },
    sideChatEstimates: sideChatPeriod === null
      ? rootSideChatEstimates
      : {
        ...rootSideChatEstimates,
        ...sideChatPeriod,
        periods: rootSideChatEstimates.periods,
        recent: sideChatRecent,
        selectedAccountingPeriodId: selected.periodId,
        selectionCoverage: sideChatSelectionCoverage,
        retainedEvidenceStartAt:
          rootSideChatEstimates?.coverage?.logs2?.startAt ?? null,
      },
    replayExclusionDiagnostics: data.accounting.replayExclusionDiagnostics,
    accountingSource: data.accounting.accountingSource,
  };
}

function renderAccountingDimension(containerSelector, dimension, {
  emptyMessage = "No observations in this period.",
  unknownLabel = "Not recorded",
  eventNoun = "usage changes",
  labels = {}
} = {}) {
  const container = $(containerSelector);
  clear(container);
  const rows = Object.entries(dimension ?? {})
    .filter(([, row]) => finite(row.events, 0) > 0)
    .sort((left, right) => right[1].events - left[1].events);
  if (!rows.length) {
    container.append(node("p", "empty-inline", emptyMessage));
    return;
  }
  const totalCost = rows.reduce(
    (sum, [, row]) => sum + finite(row.apiPriceEquivalentUsd, 0),
    0
  );
  const totalEvents = rows.reduce((sum, [, row]) => sum + row.events, 0);
  const useCost = totalCost > 0;
  for (const [key, row] of rows) {
    const item = node("div", "dimension-row");
    const copy = node("div");
    copy.append(
      node(
        "strong",
        "",
        key === "unknown" ? unknownLabel : labels[key] ?? humanize(key)
      ),
      node(
        "span",
        "",
        useCost
          ? `${formatApiMoney(row.apiPriceEquivalentUsd)} · ${compact(row.events)} ${eventNoun}`
          : `${compact(row.events)} ${eventNoun}`
      )
    );
    item.append(
      copy,
      node(
        "span",
        "dimension-share",
        formatPercent(
          (useCost ? row.apiPriceEquivalentUsd / totalCost : row.events / Math.max(1, totalEvents)) * 100,
          1
        )
      )
    );
    container.append(item);
  }
}

function renderAccountingComponentBars(containerSelector, rows, {
  emptyMessage,
  valueFor,
  displayValue,
  titleFor = () => ""
}) {
  const container = $(containerSelector);
  clear(container);
  if (!rows.length) {
    container.append(node("p", "empty-inline", emptyMessage));
    return;
  }
  const maximum = Math.max(1, ...rows.map(valueFor));
  for (const rowData of rows) {
    const value = valueFor(rowData);
    const row = node("div", "component-row");
    const label = node("span", "", componentLabel(rowData.key));
    const title = titleFor(rowData);
    if (title) label.title = title;
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%`;
    track.append(fill);
    row.append(label, track, node("strong", "", displayValue(rowData)));
    container.append(row);
  }
}

function cacheSwitchMetricValue(impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null) return "—";
  const weighting = cost.allowanceWeighting;
  const display = (value) => value;
  if (weighting?.status === "complete") {
    const premium = finite(weighting.selectedPremiumUsd, null);
    return premium === null ? "—" : display(formatApiMoney(premium));
  }
  if (weighting?.status === "range") {
    const lower = finite(weighting.rangePremiumUsd?.lower, null);
    const upper = finite(weighting.rangePremiumUsd?.upper, null);
    return lower === null || upper === null
      ? "—"
      : display(`${formatApiMoney(lower)}–${formatApiMoney(upper)}`);
  }
  if (cost.isSubtotal && cost.standardApiPremiumUsd !== null) {
    return display(formatApiMoney(cost.standardApiPremiumUsd));
  }
  return "—";
}

function cacheContinuityStandardMetricValue(impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null || cost.standardApiPremiumUsd === null) return "—";
  const amount = formatApiMoney(cost.standardApiPremiumUsd);
  return amount;
}

function cacheContinuityMetricValue(impact) {
  const weighted = cacheSwitchMetricValue(impact);
  return weighted === "—"
    ? cacheContinuityStandardMetricValue(impact)
    : weighted;
}

function cacheContinuityUsesStandardFallback(impact) {
  const cost = cacheImpactCostView(impact);
  return cost !== null && cost.standardApiPremiumUsd !== null
    && !["complete", "range"].includes(cost.allowanceWeighting?.status);
}

function cacheImpactCostView(impact) {
  if (impact?.status !== "available") return null;
  // No compared requests is not an observed zero-dollar overhead.
  if (impact.cacheReadDrops === 0
      && (impact.proximateConfigurationChanges ?? impact.comparableReturns) === 0) {
    return null;
  }
  const isSubtotal = impact.coverageStatus === "incomplete"
    || impact.unpricedDrops > 0;
  const selected = isSubtotal ? impact.coveredSubtotal : impact;
  if (!selected || (isSubtotal
      && (selected.scope !== "covered_priced_drops"
        || !Number.isSafeInteger(selected.pricedDrops)
        || selected.pricedDrops <= 0
        || selected.pricedDrops !== impact.pricedDrops))) return null;
  return {
    isSubtotal,
    pricedDrops: selected.pricedDrops,
    standardApiPremiumUsd: finite(selected.standardApiPremiumUsd, null),
    allowanceWeighting: selected.allowanceWeighting,
  };
}

function appendCacheImpactSubtotalNote(container, impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null || !cost.isSubtotal) return false;
  container.append(
    document.createTextNode(" "),
    localizedNode("span", "", "accounting.cacheImpact.subtotalScope", {
      priced: formatCount(cost.pricedDrops),
    }),
  );
  if (cost.standardApiPremiumUsd !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode("span", "", cacheContinuityUsesStandardFallback(impact)
        ? "accounting.cacheImpact.subtotalStandardOnly"
        : "accounting.cacheImpact.subtotalStandard", {
        amount: formatApiMoney(cost.standardApiPremiumUsd),
      }),
    );
  }
  if (finite(impact.unpricedDrops, 0) > 0) {
    container.append(
      document.createTextNode(" "),
      localizedNode("span", "", "accounting.cacheImpact.subtotalUnpriced", {
        unpriced: formatCount(impact.unpricedDrops),
      }),
    );
  }
  return true;
}

function cacheImpactMetricBullets(impact, appendDetails) {
  const details = node("span");
  appendDetails(details, impact);
  const list = node("ul", "cache-impact-bullets");
  // Keep the full evidence explanation reachable without crowding the card.
  list.title = details.textContent;
  const cost = cacheImpactCostView(impact);
  if (cost === null) {
    list.append(node("li", "", details.textContent));
    return list;
  }
  list.append(localizedNode("li", "", cost.isSubtotal
    ? "accounting.cacheImpact.bulletPartial" : "accounting.cacheImpact.bulletPriced", {
    priced: formatCount(cost.pricedDrops ?? impact.pricedDrops),
  }));
  const excluded = [];
  for (const [count, key] of [
    [impact.unpricedDrops, "accounting.cacheImpact.bulletUnpriced"],
    [impact.uncoveredConfigurationChanges ?? impact.uncoveredReturns, "accounting.cacheImpact.bulletUncovered"],
  ]) {
    if (finite(count, 0) > 0) excluded.push(t(key, { count: formatCount(count) }));
  }
  if (excluded.length) list.append(node("li", "", excluded.join(" · ")));
  return list;
}

function formatCacheSwitchPercentagePoints(value) {
  const number = finite(value, null);
  if (number === null) return "—";
  if (number > 0 && number < 0.01) return `<${formatDecimal(0.01, 2)}`;
  return formatDecimal(number, 2);
}

function appendCacheSwitchMetricNote(container, impact) {
  if (impact?.status !== "available") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteUnavailable",
    ));
    return;
  }
  if (impact.coverageStatus !== "complete") {
    const uncovered = finite(impact.uncoveredConfigurationChanges, 0);
    const ordering = finite(impact.orderingCoverageGaps, 0);
    container.append(localizedNode(
      "span",
      "",
      ordering > 0
        ? uncovered > 0
          ? "accounting.cacheSwitch.noteIncompleteCombined"
          : "accounting.cacheSwitch.noteIncompleteOrdering"
        : "accounting.cacheSwitch.noteIncomplete",
      {
        uncovered: formatCount(uncovered),
        ordering: formatCount(ordering),
      },
    ));
    appendCacheImpactSubtotalNote(container, impact);
    return;
  }
  const drops = finite(impact.cacheReadDrops, 0);
  const proximate = finite(impact.proximateConfigurationChanges, 0);
  if (drops === 0) {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteZero",
      { proximate: formatCount(proximate) },
    ));
  } else {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteObserved",
      {
        drops: formatCount(drops),
        proximate: formatCount(proximate),
      },
    ));
    if (finite(impact.unpricedDrops, 0) > 0) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          finite(impact.pricedDrops, 0) > 0
            ? "accounting.cacheSwitch.notePartialPricing"
            : "accounting.cacheSwitch.noteUnpriced",
          {
            priced: formatCount(impact.pricedDrops),
            total: formatCount(drops),
          },
        ),
      );
    }
  }
  if (appendCacheImpactSubtotalNote(container, impact)) return;
  if (cacheImpactCostView(impact) === null) return;
  if (finite(impact.standardApiPremiumUsd, null) !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheSwitch.standardPremium",
        { amount: formatApiMoney(impact.standardApiPremiumUsd) },
      ),
    );
  }
  const allowance = impact.allowanceImpact;
  if (!["complete", "range"].includes(allowance?.status)) return;
  const range = allowance.status === "range"
    ? allowance.percentagePointRange
    : allowance.plausibleRangePercentagePoints;
  container.append(
    document.createTextNode(" "),
    localizedNode(
      "span",
      "",
      range === null
        ? "accounting.cacheSwitch.allowanceMedian"
        : "accounting.cacheSwitch.allowanceRange",
      range === null
        ? { median: formatCacheSwitchPercentagePoints(allowance.medianPercentagePoints) }
        : {
          lower: formatCacheSwitchPercentagePoints(range.lower),
          upper: formatCacheSwitchPercentagePoints(range.upper),
        },
    ),
  );
}

function cacheSwitchChangeDescription(row) {
  const previousModel = formatModelName(row?.previous?.model);
  const currentModel = formatModelName(row?.current?.model);
  const previousEffort = t(
    `accounting.cacheSwitch.effort.${row?.previous?.reasoningEffort}`,
  );
  const currentEffort = t(
    `accounting.cacheSwitch.effort.${row?.current?.reasoningEffort}`,
  );
  if (row?.changeType === "model_only") {
    return t("accounting.cacheSwitch.change.model", {
      previous: previousModel,
      current: currentModel,
    });
  }
  if (row?.changeType === "reasoning_only") {
    return t("accounting.cacheSwitch.change.reasoning", {
      previous: previousEffort,
      current: currentEffort,
    });
  }
  return t("accounting.cacheSwitch.change.both", {
    previousModel,
    currentModel,
    previousEffort,
    currentEffort,
  });
}

function cacheImpactTableSignature(kind, impact, rows) {
  const first = rows[0];
  const last = rows.at(-1);
  return [
    kind,
    impact?.periodId ?? "unavailable",
    rows.length,
    first?.observedAt ?? first?.model ?? first?.id ?? "",
    last?.observedAt ?? last?.model ?? last?.id ?? "",
  ].join(":");
}

function renderCacheImpactPagination(prefix, state, page) {
  const pagination = $(`#${prefix}-pagination`);
  if (!pagination) return;
  // The pager renders only when there is something to page through; a set that
  // fits one page keeps the plain table. A control whose two buttons are both
  // disabled above a "1–6 of 6" status is furniture: it says only what the
  // rows underneath it already show. This matches the weekly table, which has
  // always drawn its pager this way.
  pagination.hidden = page.total === 0 || page.pageCount <= 1;
  if (pagination.hidden) return;
  setLocalizedText($(`#${prefix}-page-status`), "table.pagination.page", {
    start: formatNumber(page.start + 1),
    end: formatNumber(page.end),
    total: formatNumber(page.total),
  });
  const previous = $(`#${prefix}-page-prev`);
  const next = $(`#${prefix}-page-next`);
  if (previous) previous.disabled = state.page === 0;
  if (next) next.disabled = state.page >= page.pageCount - 1;
}

function cacheSwitchDataCell(className, value, labelKey) {
  const cell = rawNode("td", className, value);
  cell.setAttribute("data-label", t(labelKey));
  return cell;
}

function isCacheDropThreadDashboard(data) {
  return ["local", "real_local_evidence"].includes(data?.mode);
}

const CACHE_DROP_AUTO_REVIEW_LABEL = "Auto review";

function cacheDropThreadParts(thread) {
  return formatCodexThreadParts(thread, t);
}

function fillCacheDropThreadCell(cell, thread, observedAt) {
  const focused = cell.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedHref = focused?.getAttribute("href") ?? null;
  clear(cell);
  cell.setAttribute("data-label", t("accounting.cacheDropThread.column"));
  const time = t("accounting.cacheDropThread.localTime", {
    time: formatLocal(observedAt),
  });
  cell.setAttribute("title", time);
  const content = rawNode("span", "cache-drop-thread-content", "");
  const parts = cacheDropThreadParts(thread);
  if (parts.length === 0) {
    const unavailable = rawNode("span", "cache-drop-thread-unavailable",
      t("accounting.cacheDropThread.unavailable"));
    unavailable.tabIndex = 0;
    unavailable.setAttribute("title", time);
    unavailable.setAttribute("aria-label",
      `${t("accounting.cacheDropThread.unavailable")}. ${time}`);
    content.append(unavailable);
  }
  for (const part of parts) {
    if (part.href === null) {
      const unavailableText = `${part.name}: ${t("accounting.cacheDropThread.unavailable")}`;
      const unavailable = rawNode("span", "cache-drop-thread-unavailable", unavailableText);
      unavailable.tabIndex = 0;
      unavailable.setAttribute("title", time);
      unavailable.setAttribute("aria-label", `${unavailableText}. ${time}`);
      content.append(unavailable);
      continue;
    }
    const link = rawNode("a", "cache-drop-thread-link", part.name);
    link.href = part.href;
    link.setAttribute("title", time);
    link.setAttribute("aria-label", t("accounting.cacheDropThread.open", {
      name: part.name,
      time,
    }));
    // Suppress any page URL as a referrer when the operating system opens
    // Codex. No arbitrary upstream URL is ever accepted by this renderer.
    link.setAttribute("rel", "noreferrer");
    if (part.worker) {
      const worker = rawNode("span", "cache-drop-subworker", "");
      worker.append(document.createTextNode("["), link, document.createTextNode("]"));
      content.append(document.createTextNode(parts.length > 1 ? " " : ""), worker);
    } else {
      content.append(link);
      if (part.autoReview) {
        const origin = rawNode("span", "cache-drop-subworker", "");
        origin.append(document.createTextNode(" ["),
          document.createTextNode(CACHE_DROP_AUTO_REVIEW_LABEL),
          document.createTextNode("]"));
        content.append(origin);
      }
    }
  }
  cell.append(content);
  if (focused) {
    const links = [...content.querySelectorAll("a")];
    const target = links.find((link) => link.getAttribute("href") === focusedHref)
      ?? links[0]
      ?? content.querySelector(".cache-drop-thread-unavailable");
    target?.focus({ preventScroll: true });
  }
}

function cacheDropThreadCell(kind, item) {
  const cell = rawNode("td", "cache-drop-thread-cell", "");
  fillCacheDropThreadCell(cell,
    cacheDropThreadLinks.entries.get(cacheDropThreadLookupKey(kind, item)),
    item.observedAt);
  cacheDropThreadLinks.cells[kind].push({ cell, item });
  return cell;
}

function updateCacheDropThreadCells() {
  for (const [kind, cells] of Object.entries(cacheDropThreadLinks.cells)) {
    for (const { cell, item } of cells) {
      if (!cell.isConnected) continue;
      fillCacheDropThreadCell(cell,
        cacheDropThreadLinks.entries.get(cacheDropThreadLookupKey(kind, item)),
        item.observedAt);
    }
  }
}

function cacheDropThreadKeys(data) {
  const keys = new Set();
  if (!isCacheDropThreadDashboard(data) || !isLoopbackDashboard()) return keys;
  for (const [kind, impact] of [
    ["switch", data.accounting?.cacheSwitchImpact],
    ["continuity", data.accounting?.cacheContinuityImpact],
  ]) {
    if (impact?.status !== "available") continue;
    const periods = Array.isArray(impact.periods) ? impact.periods.slice(0, 4) : [];
    for (const period of [impact, ...periods]) {
      const recent = Array.isArray(period?.recent) ? period.recent.slice(0, 250) : [];
      for (const row of recent) {
        const key = cacheDropThreadLookupKey(kind, row);
        if (key !== null) keys.add(key);
        if (keys.size === 2_000) return keys;
      }
    }
  }
  return keys;
}

function resetCacheDropThreadLinks(data = null) {
  const sameDashboard = cacheDropThreadLinks.dashboard === data;
  const previousGeneration = cacheDropThreadLinks.generation;
  const previousFingerprint = cacheDropThreadLinks.generationFingerprint;
  cacheDropThreadLinks.requestToken += 1;
  cacheDropThreadLinks.dashboard = data;
  cacheDropThreadLinks.generation = isCacheDropThreadDashboard(data)
      && typeof data.accounting?.cacheDiagnosticsSource?.generation === "string"
    ? data.accounting.cacheDiagnosticsSource.generation
    : null;
  cacheDropThreadLinks.generationFingerprint =
    data?.accounting?.cacheDiagnosticsSource?.generationFingerprint ?? null;
  cacheDropThreadLinks.requested = false;
  // An unchanged tuple can become ambiguous when another source is indexed.
  // Reuse navigation only within the same attested diagnostic publication;
  // a changed or missing proof requires a new successful identity lookup.
  if (previousGeneration !== cacheDropThreadLinks.generation
      || previousFingerprint !== cacheDropThreadLinks.generationFingerprint) {
    cacheDropThreadLinks.entries.clear();
  }
  const retainedKeys = cacheDropThreadKeys(data);
  for (const key of cacheDropThreadLinks.entries.keys()) {
    if (!retainedKeys.has(key)) cacheDropThreadLinks.entries.delete(key);
  }
  updateCacheDropThreadCells();
  if (!sameDashboard) cacheDropThreadLinks.cells = { switch: [], continuity: [] };
}

async function loadCacheDropThreadLinks(data) {
  const generation = cacheDropThreadLinks.generation;
  const fingerprint = cacheDropThreadLinks.generationFingerprint;
  if (data !== dashboard || data !== cacheDropThreadLinks.dashboard
      || !isCacheDropThreadDashboard(data) || !isLoopbackDashboard()
      || generation === null || generation === ""
      || fingerprint === null
      || generation !== data.accounting?.cacheDiagnosticsSource?.generation
      || fingerprint !== data.accounting?.cacheDiagnosticsSource?.generationFingerprint
      || cacheDropThreadLinks.requested
      || typeof localClient.cacheDropThreadLinks !== "function") return;
  cacheDropThreadLinks.requested = true;
  const token = ++cacheDropThreadLinks.requestToken;
  const loadToken = cacheDropThreadLinks.loadToken;
  let completed = false;
  try {
    const result = await localClient.cacheDropThreadLinks();
    if (token !== cacheDropThreadLinks.requestToken
        || loadToken !== cacheDropThreadLinks.loadToken
        || data !== dashboard || data !== cacheDropThreadLinks.dashboard
        || !isCacheDropThreadDashboard(data) || !isLoopbackDashboard()
        || generation !== data.accounting?.cacheDiagnosticsSource?.generation
        || fingerprint !== data.accounting?.cacheDiagnosticsSource?.generationFingerprint
        || result?.status !== "available"
        || result.generation !== generation) return;
    const selectedKeys = cacheDropThreadKeys(data);
    const resolvedEntries = new Map();
    for (const { key, thread } of result.entries) {
      if (!selectedKeys.has(key)) continue;
      const previous = cacheDropThreadLinks.entries.get(key);
      // Optional name-store failures must not erase details already known for
      // this UUID. A newly resolved identity replaces the old entry outright.
      resolvedEntries.set(key, previous?.id === thread.id ? {
        ...thread,
        name: thread.name ?? previous.name,
        nickname: thread.nickname ?? previous.nickname,
        parent: thread.parent === null ? previous.parent : {
          ...thread.parent,
          name: thread.parent.name ?? (thread.parent.id === previous.parent?.id
            ? previous.parent.name : null),
        },
      } : thread);
    }
    // A qualified empty/partial result withdraws unresolved identities. It is
    // different from a failed lookup, which leaves same-publication UI intact.
    cacheDropThreadLinks.entries = resolvedEntries;
    completed = true;
    updateCacheDropThreadCells();
  } catch {
    // Keep resolved details usable through temporary local lookup failures.
  } finally {
    if (!completed && token === cacheDropThreadLinks.requestToken) {
      cacheDropThreadLinks.requested = false;
    }
  }
}

function renderAccountingCacheSwitchDetails(impact) {
  const disclosure = $("#cache-switch-details");
  const rows = $("#cache-switch-rows");
  if (!disclosure || !rows) return;
  cacheDropThreadLinks.cells.switch = [];
  clear(rows);
  const available = impact?.status === "available";
  disclosure.hidden = !available;
  if (!available) {
    disclosure.open = false;
    renderCacheImpactPagination(
      "cache-switch",
      cacheSwitchTablePagination,
      paginateCacheImpactRows(
        [],
        cacheSwitchTablePagination,
        "switch:unavailable",
      ),
    );
    return;
  }
  const recent = Array.isArray(impact.recent) ? impact.recent : [];
  const sampleNote = disclosure.querySelector(".cache-impact-sample");
  if (sampleNote) {
    sampleNote.hidden = impact.cacheReadDrops <= recent.length;
    setLocalizedText(sampleNote, "accounting.cacheImpact.bulletSample", {
      shown: formatCount(recent.length), total: formatCount(impact.cacheReadDrops),
    });
  }
  const page = paginateCacheImpactRows(
    recent,
    cacheSwitchTablePagination,
    cacheImpactTableSignature("switch", impact, recent),
  );
  renderCacheImpactPagination("cache-switch", cacheSwitchTablePagination, page);
  if (!recent.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.cacheSwitch.detailsEmpty",
    );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      cacheDropThreadCell("switch", item),
      cacheSwitchDataCell(
        "cache-switch-change",
        cacheSwitchChangeDescription(item),
        "accounting.cacheSwitch.column.change",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        `${formatCount(item.previousCacheReadTokens)} → ${formatCount(item.currentCacheReadTokens)}`,
        "accounting.cacheSwitch.column.cacheRead",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        formatCount(item.lostCacheTokens),
        "accounting.cacheSwitch.column.lostTokens",
      ),
      cacheSwitchDataCell(
        "model-api-equivalent",
        item.estimatedPremiumUsd === null
          ? "—"
          : formatApiMoney(item.estimatedPremiumUsd),
        "accounting.cacheSwitch.column.apiEquivalent",
      ),
    );
    rows.append(row);
  }
}

function appendCacheContinuityAllowance(container, impact, {
  includeStandardPremium = true,
} = {}) {
  if (includeStandardPremium
      && finite(impact?.standardApiPremiumUsd, null) !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheSwitch.standardPremium",
        { amount: formatApiMoney(impact.standardApiPremiumUsd) },
      ),
    );
  }
  const allowance = impact?.allowanceImpact;
  if (!["complete", "range"].includes(allowance?.status)) return;
  const range = allowance.status === "range"
    ? allowance.percentagePointRange
    : allowance.plausibleRangePercentagePoints;
  container.append(
    document.createTextNode(" "),
    localizedNode(
      "span",
      "",
      range === null
        ? "accounting.cacheSwitch.allowanceMedian"
        : "accounting.cacheSwitch.allowanceRange",
      range === null
        ? { median: formatCacheSwitchPercentagePoints(allowance.medianPercentagePoints) }
        : {
          lower: formatCacheSwitchPercentagePoints(range.lower),
          upper: formatCacheSwitchPercentagePoints(range.upper),
        },
    ),
  );
}

function appendCacheContinuityMetricNote(container, impact) {
  if (impact?.status !== "available") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteUnavailable",
    ));
    return;
  }
  if (impact.coverageStatus !== "complete") {
    const uncovered = finite(impact.uncoveredReturns, 0);
    const ordering = finite(impact.orderingCoverageGaps, 0);
    container.append(localizedNode(
      "span",
      "",
      ordering > 0
        ? uncovered > 0
          ? "accounting.cacheContinuity.noteIncompleteCombined"
          : "accounting.cacheContinuity.noteIncompleteOrdering"
        : "accounting.cacheContinuity.noteIncomplete",
      {
        uncovered: formatCount(uncovered),
        ordering: formatCount(ordering),
      },
    ));
  } else if (finite(impact.cacheReadDrops, 0) === 0) {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteZero",
      { comparable: formatCount(impact.comparableReturns) },
    ));
  } else {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteObserved",
      {
        drops: formatCount(impact.cacheReadDrops),
        comparable: formatCount(impact.comparableReturns),
      },
    ));
    if (finite(impact.unpricedDrops, 0) > 0) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          "accounting.cacheContinuity.noteUnpriced",
          {
            priced: formatCount(impact.pricedDrops),
            total: formatCount(impact.cacheReadDrops),
          },
        ),
      );
    }
  }
  if (finite(impact.postCompactionRequests, 0) > 0) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheContinuity.noteCompaction",
        {
          requests: formatCount(impact.postCompactionRequests),
          drops: formatCount(impact.postCompactionCacheReadDrops),
        },
      ),
    );
  }
  if (appendCacheImpactSubtotalNote(container, impact)) return;
  if (cacheImpactCostView(impact) === null) return;
  if (impact.coverageStatus === "complete"
      && finite(impact.unpricedDrops, 0) === 0) {
    const standardFallback = cacheContinuityUsesStandardFallback(impact);
    if (standardFallback) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          "accounting.cacheContinuity.noteStandardFallback",
        ),
      );
    }
    appendCacheContinuityAllowance(container, impact, {
      includeStandardPremium: !standardFallback,
    });
  }
}

function formatCacheContinuityGap(seconds) {
  const value = finite(seconds, 0);
  if (value < 3_600) {
    return t("accounting.cacheContinuity.gapMinutes", {
      value: formatDecimal(value / 60, value % 60 === 0 ? 0 : 1),
    });
  }
  if (value < 86_400) {
    return t("accounting.cacheContinuity.gapHours", {
      value: formatDecimal(value / 3_600, value % 3_600 === 0 ? 0 : 1),
    });
  }
  return t("accounting.cacheContinuity.gapDays", {
    value: formatDecimal(value / 86_400, value % 86_400 === 0 ? 0 : 1),
  });
}

function cacheContinuityConfigurationDescription(row) {
  return t("accounting.cacheContinuity.configuration", {
    model: formatModelName(row?.configuration?.model),
    effort: t(
      `accounting.cacheSwitch.effort.${row?.configuration?.reasoningEffort}`,
    ),
  });
}

let cacheReuseMatrix = null;

function renderAccountingCacheReuseOutcome(impact) {
  const outcome = $("#cache-reuse-outcome");
  const container = $("#cache-reuse-matrix");
  if (!outcome || !container) return;
  outcome.hidden = false;
  cacheReuseMatrix ??= createCacheReuseMatrix({
    container,
    t,
    formatNumber: formatCount,
    formatPercent: (value) => formatPercent(value, 1),
    formatModelName,
    formatMetric: (summary, selectedImpact) => [
      ...cacheReuseMetricLines(summary, selectedImpact, { t, formatCount, formatApiMoney }),
      cacheReuseCoverageNote(selectedImpact, { t, formatCount }),
    ].filter(Boolean),
  });
  cacheReuseMatrix.render({ impact });
}

function renderAccountingCacheContinuityDetails(impact) {
  const disclosure = $("#cache-continuity-details");
  const rows = $("#cache-continuity-rows");
  if (!disclosure || !rows) return;
  cacheDropThreadLinks.cells.continuity = [];
  clear(rows);
  const available = impact?.status === "available";
  disclosure.hidden = !available;
  renderAccountingCacheReuseOutcome(available ? impact : null);
  if (!available) {
    disclosure.open = false;
    renderCacheImpactPagination(
      "cache-continuity",
      cacheContinuityTablePagination,
      paginateCacheImpactRows(
        [],
        cacheContinuityTablePagination,
        "continuity:unavailable",
      ),
    );
    return;
  }
  const recent = Array.isArray(impact.recent) ? impact.recent : [];
  const sampleNote = disclosure.querySelector(".cache-impact-sample");
  if (sampleNote) {
    sampleNote.hidden = impact.cacheReadDrops <= recent.length;
    setLocalizedText(sampleNote, "accounting.cacheImpact.bulletSample", {
      shown: formatCount(recent.length), total: formatCount(impact.cacheReadDrops),
    });
  }
  const page = paginateCacheImpactRows(
    recent,
    cacheContinuityTablePagination,
    cacheImpactTableSignature("continuity", impact, recent),
  );
  renderCacheImpactPagination(
    "cache-continuity",
    cacheContinuityTablePagination,
    page,
  );
  if (!recent.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.cacheContinuity.detailsEmpty",
    );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      cacheDropThreadCell("continuity", item),
      cacheSwitchDataCell(
        "numeric-cell", formatCacheContinuityGap(item.gapSeconds),
        "accounting.cacheContinuity.column.gap",
      ),
      cacheSwitchDataCell(
        "cache-switch-change",
        cacheContinuityConfigurationDescription(item),
        "accounting.cacheContinuity.column.configuration",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        `${formatCount(item.previousCacheReadTokens)} → ${formatCount(item.currentCacheReadTokens)}`,
        "accounting.cacheContinuity.column.cacheRead",
      ),
      cacheSwitchDataCell(
        "model-api-equivalent",
        item.estimatedPremiumUsd === null
          ? "—"
          : formatApiMoney(item.estimatedPremiumUsd),
        "accounting.cacheContinuity.column.apiEquivalent",
      ),
    );
    rows.append(row);
  }
}

function sideChatConfigurationDescription(row) {
  const configuration = t("accounting.sideChat.configuration", {
    model: formatModelName(row?.model),
    effort: t(
      `accounting.cacheSwitch.effort.${row?.reasoningEffort}`,
    ),
  });
  return row?.pricingBasis === "reviewed_alias_assumption"
    ? t("accounting.sideChat.configurationAliasAssumption", { configuration })
    : configuration;
}

function sideChatEstimateRange(row) {
  if (row?.estimatedApiPriceEquivalentUsd === null) return "—";
  const range = row?.estimatedRangeUsd;
  return range === null
    ? formatApiMoney(row.estimatedApiPriceEquivalentUsd)
    : t("accounting.sideChat.estimateRange", {
      point: formatApiMoney(row.estimatedApiPriceEquivalentUsd),
      lower: formatApiMoney(range.lower),
      upper: formatApiMoney(range.upper),
    });
}

function sideChatCalibrationKey(status) {
  return {
    eligible_active_retention:
      "accounting.sideChat.calibration.eligibleActiveRetention",
    withheld_no_retained_calls:
      "accounting.sideChat.calibration.withheldNoCalls",
    withheld_unpriced_calls:
      "accounting.sideChat.calibration.withheldUnpriced",
    withheld_parser_gaps:
      "accounting.sideChat.calibration.withheldParserGaps",
    withheld_cohort_mismatch:
      "accounting.sideChat.calibration.withheldCohortMismatch",
    withheld_context_mismatch:
      "accounting.sideChat.calibration.withheldContextMismatch",
    withheld_stale_calibration:
      "accounting.sideChat.calibration.withheldStaleCalibration",
  }[status] ?? "accounting.sideChat.calibration.withheldUnavailable";
}

function appendSideChatMetricNote(container, estimate) {
  if (estimate?.status !== "available") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.sideChat.noteUnavailable",
    ));
    return;
  }
  if (estimate.selectionCoverage === "retained_subset_of_selected_period") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.sideChat.noteRetainedSubset",
      {
        estimate: estimate.estimatedApiPriceEquivalentUsd === null
          ? "—"
          : formatApiMoney(estimate.estimatedApiPriceEquivalentUsd),
        start: estimate.retainedEvidenceStartAt
          ? formatLocal(estimate.retainedEvidenceStartAt, { dateOnly: true })
          : t("format.unknown"),
      },
    ));
    return;
  }
  container.append(localizedNode(
    "span",
    "",
    "accounting.sideChat.noteObserved",
    {
      calls: formatCount(estimate.samplingCalls),
      retained: formatCount(estimate.retainedSessions),
      detected: formatCount(estimate.detectedSessions),
    },
  ));
  if (estimate.estimatedRangeUsd !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.sideChat.noteRange",
        {
          lower: formatApiMoney(estimate.estimatedRangeUsd.lower),
          upper: formatApiMoney(estimate.estimatedRangeUsd.upper),
        },
      ),
    );
  }
  if (estimate.methodology?.calibrationStatus
      !== "eligible_active_retention") {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        sideChatCalibrationKey(estimate.methodology?.calibrationStatus),
      ),
    );
  }
}

function formatHistoricalGapPercentagePointRange(range) {
  const lower = finite(range?.lower, null);
  const upper = finite(range?.upper, null);
  if (lower === null || upper === null) return "—";
  return closeEnough(lower, upper)
    ? t("accounting.sideChat.historicalGap.percentagePoints", {
      value: formatDecimal(lower, 2),
    })
    : t("accounting.sideChat.historicalGap.percentagePointRange", {
      lower: formatDecimal(lower, 2),
      upper: formatDecimal(upper, 2),
    });
}

function formatHistoricalGapWeightedUsage(weighting) {
  if (weighting?.status === "complete") {
    return formatApiMoney(weighting.selectedUsd);
  }
  if (weighting?.status === "range") {
    return t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(weighting.rangeUsd?.lower),
      upper: formatApiMoney(weighting.rangeUsd?.upper),
    });
  }
  return "—";
}

function formatHistoricalGapExpected(comparison) {
  if (comparison?.status === "complete") {
    return formatHistoricalGapPercentagePointRange({
      lower: comparison.selectedExpectedPercentagePoints,
      upper: comparison.selectedExpectedPercentagePoints,
    });
  }
  if (comparison?.status === "range") {
    return formatHistoricalGapPercentagePointRange(
      comparison.expectedRangePercentagePoints,
    );
  }
  return "—";
}

function formatHistoricalGapBackcast(estimate) {
  if (estimate?.allowanceComparison?.status === "complete") {
    return t("accounting.sideChat.historicalGap.backcastValue", {
      standard: formatApiMoney(
        estimate.impliedMissingStandardApiEquivalentUsd,
      ),
      weighted: formatApiMoney(
        estimate.impliedMissingQuotaWeightedApiEquivalentUsd,
      ),
    });
  }
  return t("accounting.sideChat.historicalGap.backcastRange", {
    standard: t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(estimate?.sensitivityRangeUsd?.lower),
      upper: formatApiMoney(estimate?.sensitivityRangeUsd?.upper),
    }),
    weighted: t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(
        estimate?.quotaWeightedSensitivityRangeUsd?.lower,
      ),
      upper: formatApiMoney(
        estimate?.quotaWeightedSensitivityRangeUsd?.upper,
      ),
    }),
  });
}

function closeEnough(left, right) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) < 1e-9;
}

function historicalGapPeakThreeHourPoint(probe) {
  if (!dashboard || probe?.status !== "available") return null;
  const startMs = Date.parse(probe.startAt);
  const endMs = Date.parse(probe.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return liveTimelinePoints(dashboard, {
    windowHours: CALIBRATION_WINDOW_HOURS,
    rangeDays: ALL_HISTORY_RANGE_DAYS,
  }).filter((point) => (
    point.timestampMs >= startMs
      && point.timestampMs <= endMs
      && point.observed !== null
      && point.expected !== null
      && point.residual !== null
  )).sort((left, right) => right.residual - left.residual)[0] ?? null;
}

function appendHistoricalGapMetric(container, labelKey, value) {
  const item = node("div");
  item.append(
    localizedNode("span", "", labelKey),
    rawNode("strong", "", value),
  );
  container.append(item);
}

function renderSideChatHistoricalGapProbe(probe) {
  const section = $("#side-chat-historical-gap");
  const summary = $("#side-chat-historical-gap-summary");
  const explanation = $("#side-chat-historical-gap-explanation");
  const note = $("#side-chat-historical-gap-note");
  const focus = $("#side-chat-historical-gap-focus");
  if (!section || !summary || !explanation || !note || !focus) return;
  clear(summary);
  const available = probe?.status === "available";
  section.hidden = !available;
  focus.disabled = !available;
  if (!available) {
    explanation.textContent = "";
    note.textContent = "";
    return;
  }
  const exact = probe.exactUsage;
  const quota = probe.quota;
  const estimate = probe.estimate;
  const calibration = probe.calibration;
  const date = formatLocal(probe.startAt, { dateOnly: true });
  explanation.textContent = t(
    "accounting.sideChat.historicalGap.explanation",
    {
      date,
      events: formatCount(exact.events),
      sessions: formatCount(exact.sessions),
      model: formatModelName(estimate.assumedMissingModel),
      multiplier: formatDecimal(estimate.fastQuotaMultiplier, 1),
    },
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.quota",
    formatHistoricalGapPercentagePointRange({
      lower: quota.minimumMovementPercentagePoints,
      upper: quota.maximumMovementPercentagePoints,
    }),
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.exact",
    t("accounting.sideChat.historicalGap.exactValue", {
      cost: formatApiMoney(exact.standardApiPriceEquivalentUsd),
      events: formatCount(exact.events),
    }),
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.weighted",
    formatHistoricalGapWeightedUsage(exact.allowanceWeighting),
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.expected",
    formatHistoricalGapExpected(estimate.allowanceComparison),
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.unexplained",
    formatHistoricalGapPercentagePointRange(
      estimate.unexplainedMedianRangePercentagePoints,
    ),
  );
  appendHistoricalGapMetric(
    summary,
    "accounting.sideChat.historicalGap.metric.backcast",
    formatHistoricalGapBackcast(estimate),
  );
  const peak = historicalGapPeakThreeHourPoint(probe);
  if (peak !== null) {
    appendHistoricalGapMetric(
      summary,
      "accounting.sideChat.historicalGap.metric.peak",
      t("accounting.sideChat.historicalGap.peakValue", {
        residual: formatDecimal(peak.residual, 2),
        observed: formatDecimal(peak.observed, 2),
        expected: formatDecimal(peak.expected, 2),
      }),
    );
  }
  note.textContent = t("accounting.sideChat.historicalGap.note", {
    fast: formatCount(exact.bySpeed.fast.events),
    ultrafast: formatCount(exact.bySpeed.ultrafast.events),
    standard: formatCount(exact.bySpeed.standard.events),
    unknown: formatCount(exact.bySpeed.unknown.events),
    standardSensitivity: t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(estimate.sensitivityRangeUsd.lower),
      upper: formatApiMoney(estimate.sensitivityRangeUsd.upper),
    }),
    weightedSensitivity: t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(
        estimate.quotaWeightedSensitivityRangeUsd.lower,
      ),
      upper: formatApiMoney(
        estimate.quotaWeightedSensitivityRangeUsd.upper,
      ),
    }),
    resets: formatCount(
      calibration.scenarios.unresolved_as_standard.qualifyingResets,
    ),
    capacity: t("accounting.sideChat.historicalGap.moneyRange", {
      lower: formatApiMoney(Math.min(
        calibration.scenarios.unresolved_as_standard
          .medianWeeklyCapacityUsd,
        calibration.scenarios.unresolved_as_fast.medianWeeklyCapacityUsd,
      )),
      upper: formatApiMoney(Math.max(
        calibration.scenarios.unresolved_as_standard
          .medianWeeklyCapacityUsd,
        calibration.scenarios.unresolved_as_fast.medianWeeklyCapacityUsd,
      )),
    }),
  });
}

function renderAccountingSideChatDetails(estimate) {
  const disclosure = $("#side-chat-details");
  const rows = $("#side-chat-rows");
  const summary = $("#side-chat-evidence-summary");
  const coverage = $("#side-chat-coverage-note");
  if (!disclosure || !rows || !summary || !coverage) return;
  renderSideChatHistoricalGapProbe(estimate?.historicalGapProbe);
  clear(rows);
  clear(summary);
  const available = estimate?.status === "available";
  const historicalGapAvailable = estimate?.historicalGapProbe?.status
    === "available";
  disclosure.hidden = !available && !historicalGapAvailable;
  if (!available) {
    disclosure.open = false;
    coverage.textContent = "";
    renderCacheImpactPagination(
      "side-chat",
      sideChatTablePagination,
      paginateCacheImpactRows([], sideChatTablePagination, "side-chat:unavailable"),
    );
    return;
  }
  for (const [labelKey, value] of [
    ["accounting.sideChat.summary.detected", formatCount(estimate.detectedSessions)],
    ["accounting.sideChat.summary.visibleTurns", formatCount(estimate.visibleTurns)],
    ["accounting.sideChat.summary.samplingCalls", formatCount(estimate.samplingCalls)],
    ["accounting.sideChat.summary.activeContext", compact(estimate.activeContextTokens)],
  ]) {
    const item = node("div");
    item.append(
      localizedNode("span", "", labelKey),
      rawNode("strong", "", value),
    );
    summary.append(item);
  }
  const globalCoverage = estimate.coverage;
  const coverageParts = [t(
    globalCoverage?.status === "partial_diagnostic_retention"
      ? "accounting.sideChat.coveragePartial"
      : "accounting.sideChat.coverageComplete",
    {
      retained: formatCount(globalCoverage?.retainedNumericSessions ?? 0),
      detected: formatCount(globalCoverage?.detectedSessions ?? 0),
      missing: formatCount(globalCoverage?.sessionsWithoutNumericEvidence ?? 0),
    },
  )];
  if ((globalCoverage?.sessionsAtRetentionLimit ?? 0) > 0) {
    coverageParts.push(tPlural(
      "accounting.sideChat.coverageRetentionLimit",
      globalCoverage.sessionsAtRetentionLimit,
      {
        count: formatCount(globalCoverage.sessionsAtRetentionLimit),
      },
    ));
  }
  if ((globalCoverage?.duplicateSamplingMarkers ?? 0) > 0) {
    coverageParts.push(tPlural(
      "accounting.sideChat.coverageDuplicates",
      globalCoverage.duplicateSamplingMarkers,
      {
        count: formatCount(globalCoverage.duplicateSamplingMarkers),
      },
    ));
  }
  coverageParts.push(t("accounting.sideChat.coverageActiveRetention"));
  coverageParts.push(t("accounting.sideChat.coverageKnownFormats"));
  if ((globalCoverage?.rejectedSamplingMarkers ?? 0) > 0
      || (globalCoverage?.rejectedCompactionMarkers ?? 0) > 0
      || (globalCoverage?.ambiguousDuplicateMarkers ?? 0) > 0
      || (globalCoverage?.desktop?.oversizedLinesSkipped ?? 0) > 0) {
    coverageParts.push(t("accounting.sideChat.coverageParserGaps", {
      sampling: formatCount(globalCoverage?.rejectedSamplingMarkers ?? 0),
      compactions: formatCount(
        globalCoverage?.rejectedCompactionMarkers ?? 0,
      ),
      duplicates: formatCount(
        globalCoverage?.ambiguousDuplicateMarkers ?? 0,
      ),
      lines: formatCount(
        globalCoverage?.desktop?.oversizedLinesSkipped ?? 0,
      ),
    }));
  }
  coverageParts.push(t("accounting.sideChat.pricingCoverage", {
    priced: formatCount(estimate.pricedCalls ?? 0),
    calls: formatCount(estimate.samplingCalls ?? 0),
    unpriced: formatCount(estimate.unpricedCalls ?? 0),
  }));
  const omittedDetails = Math.max(
    0,
    (estimate.samplingCalls ?? 0) - (estimate.recent?.length ?? 0),
  );
  if (omittedDetails > 0) {
    coverageParts.push(tPlural(
      "accounting.sideChat.detailsTruncated",
      omittedDetails,
      {
        count: formatCount(omittedDetails),
        limit: formatCount(estimate.recentDetailLimit ?? 500),
      },
    ));
  }
  coverageParts.push(t(sideChatCalibrationKey(
    estimate.methodology?.calibrationStatus,
  )));
  coverage.textContent = coverageParts.join(" ");
  const recent = Array.isArray(estimate.recent) ? estimate.recent : [];
  const page = paginateCacheImpactRows(
    recent,
    sideChatTablePagination,
    cacheImpactTableSignature("side-chat", estimate, recent),
  );
  renderCacheImpactPagination("side-chat", sideChatTablePagination, page);
  if (!recent.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.sideChat.detailsEmpty",
    );
    cell.colSpan = 6;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      rawNode("td", "", formatLocal(item.observedAt)),
      localizedNode(
        "td",
        "numeric-cell",
        "accounting.sideChat.turnOrdinal",
        { ordinal: formatCount(item.turnOrdinal) },
      ),
      rawNode(
        "td",
        "cache-switch-change",
        sideChatConfigurationDescription(item),
      ),
      rawNode("td", "numeric-cell", formatCount(item.activeContextTokens)),
      localizedNode(
        "td",
        "",
        item.cacheAssumption === "cold_after_compaction"
          ? "accounting.sideChat.cache.coldAfterCompaction"
          : item.cacheAssumption === "retention_unknown"
            ? "accounting.sideChat.cache.retentionUnknown"
            : "accounting.sideChat.cache.warmPrefix",
      ),
      rawNode("td", "model-api-equivalent", sideChatEstimateRange(item)),
    );
    rows.append(row);
  }
}

/**
 * Say WHY the replay-safe accounting artifacts are missing when the rebuild
 * keeps being postponed, instead of leaving bare zero cards. The rebuild
 * defers softly when it would push the app past its memory ceiling; one miss
 * is routine backoff, but a streak with no cache on disk means the reader is
 * looking at an empty cost view with a cause the app knows and was not
 * saying (the 2026-08-19 livelock recurred hourly for a whole afternoon).
 */
/**
 * True while the accounting rebuild has been deferred repeatedly — the state
 * the stale-serve label upgrades to its "being retried" wording.
 */
function accountingRebuildRetrying() {
  return Number.isSafeInteger(accountingRebuildDeferral?.consecutive)
    && accountingRebuildDeferral.consecutive >= 2;
}

/**
 * The prior-version period row backing the cost view while no current source
 * exists, or null. The provenance-bearing block arrives only on the explicit
 * stale channel, so a rendered row is labeled by construction.
 */
function staleAccountingServePeriod(data) {
  const serve = data?.accounting?.staleServe;
  if (serve?.stale !== true || !Array.isArray(serve.periods)) return null;
  return serve.periods.find(
    (period) => period.periodId === activeAccountingPeriod,
  )
    ?? serve.periods.find((period) => period.periodId === "all")
    ?? null;
}

/**
 * The quiet informational recalculating label over stale-served figures:
 * "computed by the previous version", with the live rebuild state folded in
 * ("recalculating now" while attempts proceed normally, "being retried" once
 * the rebuild has deferred repeatedly). Deliberately an annotation, not an
 * alert — the replaced red withheld-cache banner over-alarmed a routine
 * update recalculation.
 */
function renderStaleServeNote(element, active, reason = null) {
  if (!element) return;
  if (!active) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(
    element,
    reason === "local_unified_index_schema_newer"
      ? "accounting.staleServe.newerBuild"
      : reason === "current_projection_unavailable"
        ? "accounting.staleServe.lastVerified"
        : accountingRebuildRetrying()
          ? "accounting.staleServe.retrying"
          : "accounting.staleServe.recalculating",
  );
}

function renderAccountingRebuildDeferral(data, { staleServeShown = false } = {}) {
  const element = $("#accounting-rebuild-deferred");
  if (!element) return;
  const deferral = accountingRebuildDeferral;
  const persistent = Number.isSafeInteger(deferral?.consecutive)
    && deferral.consecutive >= 2;
  // With a retained cache the figures still render; the honest-empty copy is
  // for the state where no replay-safe cache exists at all. A stale serve is
  // likewise not an empty view — its own label already folds the retry state
  // in — so the deferral banner stays down rather than doubling the message.
  const cacheMissing = data?.accounting?.accountingCacheStatus === "unavailable";
  const terminalProjection = dashboardAccountingProjection(data).terminal === true;
  if (!persistent || !cacheMissing || staleServeShown || terminalProjection) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(element, "accounting.rebuildDeferred.persistent", {
    count: formatNumber(deferral.consecutive),
  });
}

function accountingPriceHeadline(accounting) {
  const weighted = accounting.quotaWeightedApiPriceEquivalentUsd;
  const explanation = [t("accounting.apiEquivalent.explanation")];
  if (weighted !== null) {
    explanation.push(t("accounting.apiEquivalent.standardRateDetail", {
      amount: formatApiMoney(accounting.apiPriceEquivalentUsd),
    }));
  }
  return [
    accounting.fastMode.metricShortLabel,
    explanation.join(" "),
    weighted === null ? "—" : formatApiMoney(weighted),
    weighted === null
      ? t("accounting.apiEquivalent.noWeightedUsage")
      : accounting.periodLabel,
  ];
}

function renderAccounting(data) {
  const projection = dashboardAccountingProjection(data);
  // The prior-version figures stand in only while the current channels are
  // genuinely empty: no current cache AND no events from any live source for
  // the selected period. The moment a current source serves (unified index or
  // a fresh cache), it wins and the stale label leaves this section.
  const livePeriod = accountingPeriod(data);
  const staleRow = !data.reportingWindow && projection.status !== "available"
      && data?.accounting?.accountingCacheStatus === "unavailable"
      && (livePeriod === null || finite(livePeriod.events, 0) === 0)
    ? staleAccountingServePeriod(data)
    : null;
  const retainedEvidence = projection.status === "retained"
    && ((staleRow !== null
      && (finite(staleRow.events, 0) > 0
        || finite(staleRow.totalTokens, 0) > 0
        || finite(staleRow.apiPriceEquivalentUsd, 0) > 0))
      || (livePeriod !== null
        && (finite(livePeriod.events, 0) > 0
          || finite(livePeriod.totalTokens, 0) > 0
          || finite(livePeriod.apiPriceEquivalentUsd, 0) > 0)));
  renderStaleServeNote(
    $("#accounting-stale-serve"),
    retainedEvidence,
    projection.reason,
  );
  renderAccountingRebuildDeferral(data, {
    staleServeShown: retainedEvidence,
  });
  const accounting = livePeriod;
  if (accounting === null || (projection.status !== "available" && !retainedEvidence)) {
    const unavailableCopy = accounting === null && data.reportingWindow
      ? t("reporting.unavailable") : t(projectionUnavailableCopyKey(data));
    const summary = $("#accounting-summary");
    clear(summary);
    for (const [label, explanation] of [
      [
        t("accounting.projection.metricUnavailable"),
        unavailableCopy,
      ],
      ["Tokens", unavailableCopy],
    ]) {
      const card = node("article", "metric-card compact-metric");
      const metricLabel = node("span", "metric-name");
      metricLabel.append(informationLabel(label, explanation));
      card.append(
        metricLabel,
        node("strong", "metric-value", "—"),
        node("p", "", unavailableCopy),
      );
      summary.append(card);
    }
    renderAccountingComponentBars("#accounting-component-counts", [], {
      emptyMessage: t("accounting.projection.componentsUnavailable"),
      valueFor: () => 0,
      displayValue: () => "—",
    });
    renderAccountingComponentBars("#accounting-component-costs", [], {
      emptyMessage: t("accounting.projection.componentsUnavailable"),
      valueFor: () => 0,
      displayValue: () => "—",
    });
    renderAccountingModels(data.accounting, { unavailable: true });
    renderAccountingCacheSwitchDetails(null);
    renderAccountingCacheContinuityDetails(null);
    renderAccountingSideChatDetails(null);
    return;
  }
  const summary = $("#accounting-summary");
  clear(summary);
  // Price coverage used to sit here as a third headline metric. It now reads
  // as a caption under the model table instead: with every retained usage
  // change priced at the rate in effect when it occurred, coverage is a
  // reassurance rather than a number worth a card, and when it is not complete
  // the rows that lack a price are the useful thing to be standing next to.
  const fastMode = accounting.fastMode;
  // Stale substitution serves the version-stable Standard-price scalar and
  // labels itself as previous-version output; quota weighting belongs to the
  // current pipeline and is not reconstructed from an old artifact.
  const headlineRows = projection.status === "retained"
    ? [
      [
        t("accounting.staleServe.metricLabel"),
        "A public API-price measuring stick for the usage observed locally. It is not a bill or a subscription limit.",
        finite((staleRow ?? accounting).apiPriceEquivalentUsd, 0) > 0
          ? formatApiMoney((staleRow ?? accounting).apiPriceEquivalentUsd)
          : "—",
        t("accounting.projection.lastVerifiedPeriod", {
          period: (staleRow ?? accounting).periodLabel,
        }),
      ],
      [
        "Tokens",
        "The tokens attached to those usage changes during the selected time period.",
        finite((staleRow ?? accounting).totalTokens, 0) > 0
          ? compact((staleRow ?? accounting).totalTokens)
          : "—",
        t("accounting.projection.lastVerifiedPeriod", {
          period: (staleRow ?? accounting).periodLabel,
        }),
      ],
    ]
    : [
      accountingPriceHeadline(accounting),
      [
        "Tokens",
        "The tokens attached to those usage changes during the selected time period.",
        compact(accounting.totalTokens),
        accounting.periodLabel
      ]
    ];
  for (const [label, explanation, value, note] of headlineRows) {
    const card = node("article", "metric-card compact-metric");
    const metricLabel = node("span", "metric-name");
    metricLabel.append(informationLabel(label, explanation));
    card.append(
      metricLabel,
      node("strong", "metric-value", value),
      node("p", "", note)
    );
    summary.append(card);
  }
  // Keep the visible attribution note focused on what changed the headline:
  // directly known speed, the Standard fallback, and any genuinely unweighted
  // usage. Calibration diagnostics remain available in the accounting data but
  // do not help a reader interpret this number.
  if (staleRow === null) {
    const attributionNote = node("p", "annotation accounting-speed-coverage");
    const sentences = [fastModeCoverageSentence(fastMode)];
    if (fastMode.assumedRatioStandardApiPriceEquivalentUsd > 0) {
      sentences.push(t("accounting.fastMode.assumedRatio", {
        amount: formatApiMoney(
          fastMode.assumedRatioStandardApiPriceEquivalentUsd,
        ),
      }));
    }
    attributionNote.textContent = sentences.join(" ");
    summary.append(attributionNote);
  }
  const cacheSwitchImpact = accounting.cacheSwitchImpact;
  const cacheSwitchCard = node("article", "metric-card compact-metric cache-impact-card");
  const cacheSwitchLabel = node("span", "metric-name");
  cacheSwitchLabel.append(informationLabel(
    t("accounting.cacheSwitch.metricLabel"),
    t("accounting.cacheSwitch.metricExplanation"),
  ));
  const cacheSwitchNote = cacheImpactMetricBullets(cacheSwitchImpact, appendCacheSwitchMetricNote);
  cacheSwitchCard.append(
    cacheSwitchLabel,
    rawNode("strong", "metric-value", cacheSwitchMetricValue(cacheSwitchImpact)),
    cacheSwitchNote,
  );
  summary.append(cacheSwitchCard);

  const cacheContinuityImpact = accounting.cacheContinuityImpact;
  const cacheContinuityCard = node("article", "metric-card compact-metric cache-impact-card");
  const cacheContinuityLabel = node("span", "metric-name");
  cacheContinuityLabel.append(informationLabel(
    t("accounting.cacheContinuity.metricLabel"),
    t("accounting.cacheContinuity.metricExplanation"),
  ));
  const cacheContinuityNote = cacheImpactMetricBullets(cacheContinuityImpact, appendCacheContinuityMetricNote);
  cacheContinuityCard.append(
    cacheContinuityLabel,
    rawNode(
      "strong",
      "metric-value",
      cacheContinuityMetricValue(cacheContinuityImpact),
    ),
    cacheContinuityNote,
  );
  summary.append(cacheContinuityCard);

  const sideChatEstimates = accounting.sideChatEstimates;
  if (sideChatEstimates?.status === "available") {
    const sideChatCard = node("article", "metric-card compact-metric");
    const sideChatLabel = node("span", "metric-name");
    sideChatLabel.append(informationLabel(
      t("accounting.sideChat.metricLabel"),
      t("accounting.sideChat.metricExplanation"),
    ));
    const sideChatNote = node("p");
    appendSideChatMetricNote(sideChatNote, sideChatEstimates);
    sideChatCard.append(
      sideChatLabel,
      rawNode(
        "strong",
        "metric-value",
        sideChatEstimates.selectionCoverage
            === "retained_subset_of_selected_period"
          ? "—"
          : sideChatEstimates.estimatedApiPriceEquivalentUsd === null
          ? "—"
          : formatApiMoney(
            sideChatEstimates.estimatedApiPriceEquivalentUsd,
          ),
      ),
      sideChatNote,
    );
    summary.append(sideChatCard);
  }

  const componentCountRows = Object.entries(accounting.components ?? {})
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, tokens }))
    .sort((left, right) => right.tokens - left.tokens);
  renderAccountingComponentBars("#accounting-component-counts", componentCountRows, {
    emptyMessage: projection.status === "retained" && staleRow !== null
      ? t("accounting.projection.retainedComponents")
      : "No token-component accounting in this period.",
    valueFor: (row) => row.tokens,
    displayValue: (row) => compact(row.tokens)
  });

  const componentCostRows = Object.entries(accounting.componentCosts ?? {})
    .map(([key, value]) => ({
      key,
      tokens: finite(value?.tokens, 0),
      costUsd: finite(value?.costUsd, 0)
    }))
    .filter((row) => row.tokens > 0 || row.costUsd > 0)
    .sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens);
  renderAccountingComponentBars("#accounting-component-costs", componentCostRows, {
    emptyMessage: projection.status === "retained" && staleRow !== null
      ? t("accounting.projection.retainedComponents")
      : "No component costs were priced in this period.",
    valueFor: (row) => row.costUsd,
    displayValue: (row) => row.costUsd > 0
      ? formatApiMoney(row.costUsd)
      : "—",
    titleFor: (row) => `${compact(row.tokens)} tokens`,
  });

  renderAccountingModels(accounting, {
    unavailable: projection.status === "retained" && staleRow !== null,
  });
  renderAccountingCacheSwitchDetails(cacheSwitchImpact);
  renderAccountingCacheContinuityDetails(cacheContinuityImpact);
  renderAccountingSideChatDetails(sideChatEstimates);
}

/**
 * Every model identity observed in the period, across both allowance tracks.
 *
 * `byModel` describes the primary Codex pool only, because the separately
 * metered Spark allowance is kept out of that pool's own totals. `modelUsage`
 * is the combined list, each row carrying its own allowance track. Reading
 * only `byModel` is what previously left Spark usage invisible, or collapsed
 * into "Unrecognized model".
 */
function modelUsageRows(accounting) {
  const combined = Array.isArray(accounting?.modelUsage)
    ? accounting.modelUsage
    : [
      ...(accounting?.byModel ?? []),
      ...(accounting?.spark?.byModel ?? []),
    ];
  return [...combined].sort((left, right) => (
    // A separate allowance has no comparable money figure, so those rows
    // cannot be ranked against the primary pool. They sort last.
    Number(modelRowIsSeparateAllowance(left))
      - Number(modelRowIsSeparateAllowance(right))
    || finite(right.apiPriceEquivalentUsd, 0) - finite(left.apiPriceEquivalentUsd, 0)
    || finite(right.totalTokens, 0) - finite(left.totalTokens, 0)
    || String(left.model ?? "").localeCompare(String(right.model ?? ""))
  ));
}

function modelRowIsSeparateAllowance(row) {
  return row?.allowanceTrack === "spark"
    || row?.apiPriceEquivalentApplicable === false;
}

/**
 * The API-equivalent cell, which used to print one em dash for four different
 * situations. They are not the same fact and a reader has to be able to tell
 * them apart:
 *
 *   separate allowance - Spark is metered against its own pool, so an
 *                        API-price equivalent is not a meaningful figure at
 *                        all, as opposed to a missing one.
 *   no published price - a recognised model OpenAI publishes no price card
 *                        for. Deliberately not priced; not an error.
 *   not priced         - an identifier this build has never reviewed. No
 *                        price is invented for it, and it is not a zero.
 *   not reported       - the row carried no usable number. Malformed input,
 *                        never silently shown as zero.
 *   a real amount      - including an honest, priced $0.00.
 */
/**
 * Whether this row states an API-price equivalent that can be compared with
 * the pool's total at all.
 *
 * The share column has to ask the same question the amount column already
 * asks. A row whose amount reads "No published price" holds no money figure,
 * so its share of the period's money is not zero — it is unknown, and printing
 * "0.0%" beside "No published price" would contradict the cell next to it.
 */
function modelHasComparableCost(row) {
  if (modelRowIsSeparateAllowance(row)) return false;
  if (row?.pricingStatus === "known_unpriced") return false;
  if (row?.pricingStatus === "unrecognized") return false;
  const amount = finite(row?.apiPriceEquivalentUsd);
  return amount !== null && amount >= 0;
}

function modelApiEquivalentCell(row) {
  const cell = node("td", "model-api-equivalent data-value-unavailable");
  if (modelRowIsSeparateAllowance(row)) {
    setLocalizedText(cell, "accounting.model.separateAllowance");
    cell.title = t("accounting.model.separateAllowanceTitle");
    return cell;
  }
  if (row?.pricingStatus === "known_unpriced") {
    setLocalizedText(cell, "accounting.model.noPublishedPrice");
    cell.title = t("accounting.model.noPublishedPriceTitle");
    return cell;
  }
  if (row?.pricingStatus === "unrecognized") {
    // An identifier this build has never reviewed carries no price, and a
    // guessed one would be worse than none. Printing "$0.00" here read as a
    // priced zero, which is a different and untrue claim.
    setLocalizedText(cell, "accounting.model.notPricedUnknown");
    cell.title = t(row.model === "unknown"
      ? "accounting.model.identityUnavailableTitle"
      : "accounting.model.notPricedUnknownTitle");
    return cell;
  }
  const amount = finite(row?.apiPriceEquivalentUsd);
  if (amount === null || amount < 0) {
    setLocalizedText(cell, "accounting.model.notReported");
    cell.title = t("accounting.model.notReportedTitle");
    return cell;
  }
  cell.className = "model-api-equivalent";
  setRawText(cell, formatApiMoney(amount));
  if (amount === 0) cell.title = t("accounting.model.zeroTitle");
  return cell;
}

/**
 * Price coverage as a sentence beside the rows it describes, rather than a
 * headline metric. `null` means the period holds no usage change at all, so
 * there is no coverage claim to make and the caption stays off entirely.
 */
function pricingCoverageNote(accounting) {
  const events = finite(accounting?.events, 0);
  if (events <= 0) return null;
  if (finite(accounting?.pricingCoverage?.unpricedEvents, 0) <= 0) {
    return null;
  }
  const priced = finite(accounting?.pricingCoverage?.fullyPricedEvents, 0)
    + finite(accounting?.pricingCoverage?.partiallyPricedEvents, 0);
  return t("accounting.pricing.partialCoverage", {
    percent: formatPercent(priced / events * 100, 1),
  });
}

/**
 * The token components a model row can break down into, in reading order:
 * input before output, and within each the cheaper-per-token part first. The
 * label is a key rather than a string so the rows retranslate in place.
 */
const MODEL_COMPONENT_ROWS = Object.freeze([
  ["input_cache_read_tokens", "accounting.model.componentCached"],
  ["input_uncached_tokens", "accounting.model.componentUncached"],
  ["input_cache_write_tokens", "accounting.model.componentCacheWrite"],
  ["output_text_tokens", "accounting.model.componentOutputText"],
  ["output_reasoning_tokens", "accounting.model.componentReasoning"],
  ["output_combined_tokens", "accounting.model.componentCombined"],
]);

/**
 * A share cell. `null` prints the same withheld glyph the rest of this table
 * uses, so "no denominator to divide by" never renders as an exact 0.0%.
 */
function modelShareCell(part, whole) {
  const share = formatSharePercent(part, whole);
  if (share === null) {
    return localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld");
  }
  return rawNode("td", "numeric-cell model-share", share);
}

/**
 * One component of one model, built as a row of the same table rather than a
 * nested grid: same columns, same alignment, one level of indent. Only the
 * denominator differs from the model row above it, and that is stated once in
 * the caption under the table.
 */
function modelComponentRow(model, key, labelKey, totals) {
  const row = node("tr", "model-component-row");
  row.dataset.componentOf = model.model;

  const identity = node("td", "model-identity model-component-identity");
  const swatch = node("span", `component-swatch component-swatch-${key.replace(/_/gu, "-")}`);
  swatch.setAttribute("aria-hidden", "true");
  identity.append(swatch, localizedNode("span", "", labelKey));

  // A usage change carries every component at once, so the count does not
  // divide between them. Withheld with its reason, never shown as zero.
  const events = localizedNode(
    "td",
    "numeric-cell model-component-withheld",
    "accounting.model.componentEventsWithheld",
  );
  events.title = t("accounting.model.componentEventsWithheldTitle");

  const tokens = finite(model.components?.[key], 0);
  const cost = model.componentCosts?.[key] ?? null;

  // A separate allowance carries no comparable money, and a row whose
  // components were never priced carries none either. Both withhold the
  // amount instead of dividing the row total into an invented one.
  let costCell;
  let costShareCell;
  if (!modelHasComparableCost(model) || cost === null) {
    costCell = localizedNode(
      "td",
      "numeric-cell model-component-withheld",
      "accounting.model.componentCostWithheld",
    );
    costCell.title = t(
      modelRowIsSeparateAllowance(model)
        ? "accounting.model.separateAllowanceTitle"
        : model.pricingStatus === "known_unpriced"
          ? "accounting.model.noPublishedPriceTitle"
          : model.pricingStatus === "unrecognized"
            ? model.model === "unknown"
              ? "accounting.model.identityUnavailableTitle"
              : "accounting.model.notPricedUnknownTitle"
            : "accounting.model.componentCostWithheldTitle",
    );
    costShareCell = localizedNode(
      "td",
      "numeric-cell model-share",
      "accounting.model.shareWithheld",
    );
  } else {
    costCell = rawNode("td", "numeric-cell", formatApiMoney(finite(cost.costUsd, 0)));
    costShareCell = modelShareCell(finite(cost.costUsd, 0), totals.cost);
  }

  row.append(
    identity,
    events,
    rawNode("td", "numeric-cell", formatCount(tokens)),
    modelRowIsSeparateAllowance(model)
      ? localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld")
      : modelShareCell(tokens, totals.tokens),
    costCell,
    costShareCell,
  );
  return row;
}

function renderAccountingModels(accounting, { unavailable = false } = {}) {
  const models = $("#accounting-models");
  if (!models) return;
  clear(models);
  const coverage = $("#accounting-price-coverage");
  if (coverage) {
    const note = unavailable ? null : pricingCoverageNote(accounting);
    setRawText(coverage, note ?? "");
    coverage.hidden = note === null;
  }
  const modelRows = unavailable ? [] : modelUsageRows(accounting);
  const page = paginateCacheImpactRows(
    modelRows,
    accountingModelsTablePagination,
    cacheImpactTableSignature("models", accounting, modelRows),
  );
  renderCacheImpactPagination(
    "accounting-model",
    accountingModelsTablePagination,
    page,
  );
  if (!modelRows.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      unavailable
        ? "accounting.model.unavailable"
        : "accounting.model.noneInPeriod",
    );
    cell.colSpan = 6;
    row.append(cell);
    models.append(row);
    return;
  }
  // Both share columns are against the primary pool's own totals, so the model
  // rows add up to 100% and each model's components add up to their model. A
  // separately metered row is not part of that pool and withholds both shares,
  // the same rule its money cell already follows.
  const totals = {
    tokens: finite(accounting?.totalTokens, 0),
    cost: finite(accounting?.apiPriceEquivalentUsd, 0),
  };
  for (const model of page.rows) {
    const row = node("tr");
    const identity = node("td", "model-identity");
    const presentation = modelUsagePresentation(
      model.pricingStatus === "unrecognized" ? "unknown" : model.model,
    );
    const icon = modelThemeIcon(document, presentation.theme);
    if (icon) {
      icon.classList.add("model-usage-icon", presentation.className);
      identity.append(icon);
    }
    // The unknown aggregate combines missing attribution and unreviewed
    // identifiers. Its label must not claim either cause as established.
    if (model.model === "unknown") {
      const label = localizedNode("span", "", "accounting.model.identityUnavailable");
      label.title = t("accounting.model.identityUnavailableTitle");
      identity.append(label);
    } else if (model.pricingStatus === "unrecognized") {
      identity.append(localizedNode("span", "", "accounting.model.unrecognized"));
    } else {
      // The wire identifier is what the provider reported and what any
      // support conversation will quote, so it stays reachable on hover even
      // though the readable name is what gets printed.
      const name = formatModelName(model.model);
      const label = rawNode("span", "", name);
      if (name !== model.model) label.title = model.model;
      identity.append(label);
    }
    if (modelRowIsSeparateAllowance(model)) {
      // A filled chip on every Spark row shouted the same fact once per row and
      // crowded the identity column. One marker on the name, carrying the same
      // sentence as its expansion and pointing at the standing footnote under
      // the table, says it without competing with the figures.
      const marker = rawNode("abbr", "model-allowance-marker", "*");
      marker.title = t("accounting.model.separateAllowanceTitle");
      identity.append(marker);
    }
    // One formatter for both count columns. Compact notation put "154.9K"
    // beside "74" in the same column, which no reader can compare by eye.
    const separate = modelRowIsSeparateAllowance(model);
    row.append(
      identity,
      rawNode(
        "td",
        "numeric-cell",
        formatCount(model.events, { missing: t("accounting.model.notReported") }),
      ),
      rawNode(
        "td",
        "numeric-cell",
        formatCount(model.totalTokens, { missing: t("accounting.model.notReported") }),
      ),
      separate
        ? localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld")
        : modelShareCell(model.totalTokens, totals.tokens),
      modelApiEquivalentCell(model),
      modelHasComparableCost(model)
        ? modelShareCell(model.apiPriceEquivalentUsd, totals.cost)
        : localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld"),
    );

    // A row can only be opened when it actually carries a split. Older cached
    // projections have none, and drawing four zeroed rows for them would be a
    // claim the row never made.
    const componentRows = model.components === null || model.components === undefined
      ? []
      : MODEL_COMPONENT_ROWS
        .filter(([key]) => finite(model.components[key], 0) > 0)
        .map(([key, labelKey]) => modelComponentRow(model, key, labelKey, totals));

    if (componentRows.length > 0) {
      const expanded = accountingExpandedModels.has(model.model);
      row.classList.add("model-row-expandable");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", String(expanded));
      const describe = () => {
        row.setAttribute(
          "aria-label",
          t(
            row.getAttribute("aria-expanded") === "true"
              ? "accounting.model.collapse"
              : "accounting.model.expand",
            { model: model.model === "unknown"
              ? t("accounting.model.identityUnavailable")
              : model.pricingStatus === "unrecognized"
                ? t("accounting.model.unrecognized")
                : formatModelName(model.model) },
          ),
        );
      };
      describe();
      identity.prepend(modelDisclosureCaret());
      for (const componentRow of componentRows) componentRow.hidden = !expanded;
      const toggle = () => {
        const open = row.getAttribute("aria-expanded") === "true";
        row.setAttribute("aria-expanded", String(!open));
        if (open) accountingExpandedModels.delete(model.model);
        else accountingExpandedModels.add(model.model);
        for (const componentRow of componentRows) componentRow.hidden = open;
        describe();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    }

    models.append(row, ...componentRows);
  }
}

/** The affordance that says a model row opens. Decorative; the row is the control. */
function modelDisclosureCaret() {
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("class", "model-disclosure-caret");
  caret.setAttribute("viewBox", "0 0 16 16");
  caret.setAttribute("aria-hidden", "true");
  caret.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 3.5 10.5 8 6 12.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  caret.append(path);
  return caret;
}

function fastModeCoverageSentence(fastMode) {
  const coverage = fastMode.coverage;
  if (coverage.totalEvents === 0) {
    return t("accounting.fastMode.noUsage");
  }
  const knownEvents = coverage.observedEvents + coverage.declaredFromConfigEvents;
  const sentences = [t("accounting.fastMode.coverageSummary", {
    known: compact(knownEvents),
    total: compact(coverage.totalEvents),
  })];
  if (coverage.assumedEvents > 0) {
    sentences.push(t("accounting.fastMode.coverageAssumed", {
      count: compact(coverage.assumedEvents),
    }));
  }
  if (coverage.unknownEvents === 0) {
    sentences.push(t("accounting.fastMode.coverageComplete"));
    return sentences.join(" ");
  }
  sentences.push(t("accounting.fastMode.coverageUnknown", {
    count: compact(coverage.unknownEvents),
    percent: coverage.unknownSharePercent === null
      ? "—"
      : formatPercent(coverage.unknownSharePercent, 1),
  }));
  sentences.push(fastMode.unweightedUnknownApiPriceEquivalentUsd > 0
    ? t("accounting.fastMode.coverageUnknownCost", {
      amount: formatApiMoney(fastMode.unweightedUnknownApiPriceEquivalentUsd),
    })
    : t("accounting.fastMode.coverageUnknownExcluded"));
  return sentences.join(" ");
}


function scheduleLocalReadinessPoll(isCurrent) {
  if (!isCurrent()
      || (localCompanionHealth !== null && localOnboarding?.state !== "unavailable"
        && localOnboarding !== null)
      || localReadinessPollTimer !== null || localReadinessPollCount >= 450) return;
  localReadinessPollTimer = window.setTimeout(() => {
    localReadinessPollTimer = null;
    if (!isCurrent()) return;
    localReadinessPollCount += 1;
    void loadLocalDashboardSecondaryState({ isCurrent }).catch(() => {
      scheduleLocalReadinessPoll(isCurrent);
    });
  }, 4_000);
}

async function loadLocalDashboardSecondaryState({ isCurrent }) {
  const read = async (request, publish = () => {}) => {
    const value = await Promise.resolve().then(request).catch(() => null);
    if (isCurrent()) publish(value);
    return value;
  };
  const health = read(() => localClient.health(), (localHealth) => {
    // A failed read says nothing about the companion. Never replace a health
    // answer that landed with one that did not.
    if (localHealth === null) return;
    localCompanionHealth = localHealth;
    if (dashboard === null) {
      renderDashboardUnavailableState("dashboard-unavailable");
    }
  });
  const onboarding = read(() => localClient.onboarding(), (value) => {
    if (value === null) return;
    renderLocalOnboarding(value);
    // Bootstrap may have finished before this verdict arrived. Electron's
    // launch pass is gated on this readiness verdict, so retry it here before
    // preserving the browser's return-visit cadence.
    startElectronStartupRefresh();
    scheduleReturningUserRefresh();
  });
  const refresh = read(() => localClient.refreshStatus(), (refreshState) => {
    if (refreshState === null) return;
    accountingRebuildDeferral =
      refreshState?.refresh?.result?.accountingRebuildDeferred ?? null;
    if (dashboard) renderAccounting(dashboard);
  });
  await Promise.all([health, onboarding, refresh]);
  scheduleLocalReadinessPoll(isCurrent);
}

/** Mark the first real local-dashboard render for the native shell. */
function markLocalDashboardReady() {
  // The native shell uses this app-owned marker instead of mistaking static
  // hero copy for a loaded evidence view. It contains no data; it means only
  // that the first local dashboard result (available or honestly unavailable)
  // has finished rendering.
  document.documentElement.dataset.localDashboardReady = "true";
}

async function loadLocalDashboard() {
  const loadToken = ++cacheDropThreadLinks.loadToken;
  const load = {
    previousBusy: activeLocalDashboardLoad?.pending
      ? activeLocalDashboardLoad.previousBusy
      : localActionBusy,
    pending: true,
  };
  activeLocalDashboardLoad = load;
  const isCurrent = () => cacheDropThreadLinks.loadToken === loadToken;
  let primaryAvailable = false;
  localActionBusy = true;
  const button = $("#refresh-button");
  if (localRefreshInProgress) renderRefreshProgress(button, "Loading evidence…");
  else button.textContent = "Connecting…";
  updateLocalActionButtons();
  try {
    const loadDashboardData = async () => {
      try {
        return await localClient.load();
      } catch (firstError) {
        if (!isCurrent()) throw firstError;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (!isCurrent()) throw firstError;
        try {
          return await localClient.load();
        } catch {
          throw firstError;
        }
      }
    };
    const data = await loadDashboardData();
    if (!isCurrent()) return;
    renderDashboard(data);
    // Clear the first-run evidence curtain using the result we actually have,
    // even while the next optional onboarding verdict is still pending.
    renderLocalOnboarding(localOnboarding);
    markLocalDashboardReady();
    primaryAvailable = true;
    dashboardReportPreloader.schedule();
  } catch {
    if (!isCurrent()) return;
    dashboard = null;
    observationFreshnessClock.stop();
    lastObservationPresentationStatus = null;
    renderLocalOnboarding(localOnboarding);
    renderDashboardUnavailableState(
      localCompanionHealth ? "dashboard-unavailable" : "companion-unavailable",
    );
    markLocalDashboardReady();
  } finally {
    if (activeLocalDashboardLoad === load) {
      load.pending = false;
      localActionBusy = load.previousBusy;
      updateLocalActionButtons();
      if (electronStartupRefreshDeferred) {
        electronStartupRefreshDeferred = false;
        startElectronStartupRefresh();
      }
    }
  }
  if (isCurrent()) {
    // The dashboard has painted a real local result before the accountless
    // preference is read. This ordering is also the authorization boundary for
    // a notice receipt: unavailable/hidden startup never counts as displayed.
    void loadElectronSharingPreference({ dashboardReady: primaryAvailable }).catch(() => {});
    // Optional reads never own primary readiness or the action's busy state.
    void loadLocalDashboardSecondaryState({ isCurrent, primaryAvailable }).catch(() => {});
  }
}

function renderDashboardSkeleton() {
  closeInformationPopover();
  allowanceTankView?.dispose();
  allowanceTankView = null;
  const forecast = $("#weekly-pace-forecast");
  if (forecast) { forecast.hidden = true; clear(forecast); }
  if ($("#allowance-context")) $("#allowance-context").hidden = true;
  const container = $("#quota-cards");
  clear(container);
  const card = node("article", "metric-card insufficient");
  const header = node("div", "metric-card-header");
  header.append(
    node("span", "metric-name", t("dashboard.unavailable.noLocalEvidence")),
    node("span", "evidence-chip", t("dashboard.unavailable.offline")),
  );
  card.append(
    header,
    node("strong", "metric-value", "—"),
    node("p", "", t("dashboard.unavailable.emptyState")),
  );
  container.append(card);
}

async function loadQuickResultDashboard() {
  const loadToken = ++cacheDropThreadLinks.loadToken;
  const isCurrent = () => cacheDropThreadLinks.loadToken === loadToken;
  try {
    const data = await localClient.load();
    if (!isCurrent()) return;
    renderDashboard(data);
    renderLocalOnboarding(localOnboarding);
    dashboardReportPreloader.schedule();
  } finally {
    // This generation replaces any pending startup reads too. Keep optional
    // recovery alive without making native evidence reloads wait for it.
    if (isCurrent()) {
      void loadLocalDashboardSecondaryState({
        isCurrent,
        primaryAvailable: dashboard !== null && dashboard.mode !== "demo",
      }).catch(() => {});
    }
  }
}

function showDemoDashboard() {
  cacheDropThreadLinks.loadToken += 1;
  if (activeLocalDashboardLoad?.pending) {
    localActionBusy = activeLocalDashboardLoad.previousBusy;
  }
  activeLocalDashboardLoad = null;
  renderDashboard(demoDashboard());
  updateLocalActionButtons();
}

/**
 * True when the local history index has discovered more sources than it has
 * indexed — a one-time build or a parser-version reparse is still catching up.
 * Reads the same coverage the top-bar badge uses; demo mode is never pending.
 */
function historyIndexIncomplete() {
  if (!dashboard || dashboard.mode === "demo") return false;
  return currentHistoryContinuationDecision().incomplete;
}

function currentHistoryContinuationDecision() {
  const history = dashboard?.pricing?.historyCoverage
    ?? dashboard?.accounting?.historyCoverage
    ?? null;
  return historyIndexContinuationDecision({
    history,
    generation: dashboard?.accounting?.generation ?? null,
    generationFingerprint:
      dashboard?.accounting?.generationFingerprint ?? null,
    previousReceipt: lastReindexProgressReceipt,
  });
}

function historyProgressReceipt() {
  return currentHistoryContinuationDecision().receipt;
}

/**
 * After an explicit detailed refresh that left the history index incomplete, run the
 * next pass promptly instead of waiting for the sparse auto-cadence, bounded
 * by REINDEX_AUTO_CONTINUE_LIMIT. Stops the moment coverage completes, the
 * user interacts, or the bound is reached (the ordinary cadence then carries
 * the remainder). Never runs in demo mode or while another action is busy.
 */
function scheduleReindexAutoContinuation() {
  if (reindexAutoContinueTimer !== null) {
    clearTimeout(reindexAutoContinueTimer);
    reindexAutoContinueTimer = null;
  }
  const decision = currentHistoryContinuationDecision();
  if (!decision.incomplete) {
    reindexAutoContinuations = 0;
    lastReindexProgressReceipt = null;
    return;
  }
  if (!decision.shouldContinue) return;
  lastReindexProgressReceipt = decision.receipt;
  if (reindexAutoContinuations >= REINDEX_AUTO_CONTINUE_LIMIT) return;
  reindexAutoContinueTimer = setTimeout(() => {
    reindexAutoContinueTimer = null;
    if (localActionBusy || !historyIndexIncomplete()) {
      reindexAutoContinuations = 0;
      return;
    }
    reindexAutoContinuations += 1;
    void requestRefresh({ autoContinue: true, detailed: true });
  }, REINDEX_AUTO_CONTINUE_DELAY_MS);
}

async function requestRefresh({ autoContinue = false, detailed = false } = {}) {
  if (localActionBusy) return;
  const previousGlobalState = globalState;
  // Fence continuation against the exact coverage visible before this pass.
  // If the terminal reload presents the same generation/count/byte receipt,
  // scheduleReindexAutoContinuation stops immediately instead of spending the
  // rest of its 40-pass budget on identical work.
  lastReindexProgressReceipt = historyProgressReceipt();
  // A person pressing Refresh restarts the auto-continuation budget; a chained
  // reindex pass keeps counting toward the bound set when it began.
  if (!autoContinue) reindexAutoContinuations = 0;
  if (!localAnalysisAllowed()) {
    showConnectionNotice({
      title: "Finish the local check before analyzing",
      copy: "Open Codex and complete one response, then choose Check again. TiboTattle will not start an analysis while its local preflight is incomplete.",
      kind: "warning",
      showCheck: true,
      showDemo: !dashboard,
    });
    updateLocalActionButtons();
    return;
  }
  const button = $("#refresh-button");
  const electronRefresh = runsInsideElectronDashboard();
  let refreshAccepted = false;
  let cancelled = false;
  let quickResultLoaded = false;
  let continuationLimitReached = false;
  let refreshLeaseSession = null;
  let refreshProgressClock = null;
  localActionBusy = true;
  localRefreshInProgress = true;
  localRefreshCancelRequested = false;
  archiveHistoryScanActive = false;
  renderRefreshProgress(button, detailed
    ? "Starting detailed accounting…"
    : "Starting local analysis…");
  updateLocalActionButtons();
  setGlobalState("updating");
  try {
    await (detailed
      ? localClient.recalculateDetailedAccounting()
      : localClient.refresh());
    refreshAccepted = true;
    if (electronRefresh) {
      refreshLeaseSession = createElectronRefreshLease({
        bridge: globalThis.tibotattleDesktop,
        mode: detailed ? "detailed" : "quick",
        onState(next) {
          electronRefreshLifecycleState = next;
          if (!localRefreshInProgress) void refreshElectronCadenceHealth();
        },
      });
      // Cadence bookkeeping must never delay companion polling. A bounded late
      // start reply is still settled by the lifecycle module after completion.
      void refreshLeaseSession.start();
    }
    refreshProgressClock = startRefreshProgressClock(button, detailed
      ? "Starting detailed accounting…"
      : "Starting local analysis…");
    const pollingBudget = createRefreshPollingBudget();
    let consecutiveStatusFailures = 0;
    let outcome = "running";
    let finalErrorCode = null;
    let finalFailedStep = null;
    let finalFailureCode = null;
    let finalUnifiedIndex = null;
    let pollCount = 0;
    let timeoutSettlementNoted = false;
    while (pollingBudget.hasTime()
        && ["running", "cancelling"].includes(outcome)) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      pollCount += 1;
      let status;
      try {
        status = await localClient.refreshStatus();
        consecutiveStatusFailures = 0;
      } catch (error) {
        consecutiveStatusFailures += 1;
        refreshProgressClock.update("Update running; reconnecting…");
        if (consecutiveStatusFailures >= 8) throw error;
        continue;
      }
      const refresh = status?.refresh ?? {};
      outcome = refresh.status ?? "failed";
      finalErrorCode = refresh.errorCode ?? null;
      finalFailedStep = refresh.failedStep ?? finalFailedStep;
      finalFailureCode = refresh.failureCode ?? finalFailureCode;
      finalUnifiedIndex = refresh.result?.unifiedIndex ?? finalUnifiedIndex;
      const progress = refresh.progress ?? refresh.result?.indexing ?? null;
      const collectorProgress = progress?.kind === undefined;
      const archiveScanning = progress?.kind === "archive_index";
      const unifiedIndexScanning = progress?.kind === "unified_index"
        && progress?.status === "scanning"
        && progress?.phase === "rollout_index";
      if (archiveScanning && !archiveHistoryScanActive) {
        archiveHistoryScanActive = true;
        if (dashboard) renderPricing(dashboard);
      }
      if (collectorProgress
          && progress?.phase === "quick_result" && !quickResultLoaded) {
        try {
          await loadQuickResultDashboard();
          quickResultLoaded = true;
        } catch {
          // Keep polling. The verified quick snapshot can still be loaded when
          // deep accounting finishes, and no partial replacement is invented.
        }
      }
      const accountingStatus = outcome === "running"
        ? refreshAccountingStatus({ progress })
        : null;
      const countedProgress = collectorProgress || unifiedIndexScanning;
      const processed = countedProgress
          && Number.isSafeInteger(progress?.filesProcessed)
        ? progress.filesProcessed : null;
      const selected = countedProgress
          && Number.isSafeInteger(progress?.filesSelected)
        ? progress.filesSelected : null;
      const phase = outcome === "cancelling"
        ? "Stopping safely…"
        : accountingStatus !== null
          ? accountingStatus
        : archiveScanning
          ? "Indexing archive history…"
        : collectorProgress && progress?.phase === "quick_result"
          ? refreshQuickResultStatus({
              dashboardLoaded: quickResultLoaded,
            })
        : unifiedIndexScanning && (selected === null || selected === 0)
          ? "Scanning local history…"
        : processed !== null && selected !== null
        ? selected > 0 && processed >= selected
          ? "Calculating usage and allowance…"
          : "Analyzing files…"
        : pollCount < 3 ? "Analyzing local evidence…" : "Analyzing…";
      refreshProgressClock.update(phase, { processed, selected });
      if (refreshNeedsContinuation({
        outcome,
        errorCode: refresh.errorCode,
        progress,
      })) {
        if (!pollingBudget.canContinue()) {
          continuationLimitReached = true;
          throw new Error("The bounded continuation limit was reached.");
        }
        try {
          await (detailed
            ? localClient.recalculateDetailedAccounting()
            : localClient.refresh());
          pollingBudget.noteContinuation();
          timeoutSettlementNoted = false;
          refreshProgressClock.reset("Continuing local analysis…");
        } catch (error) {
          // A 409 means a timed-out pass is still finishing its durable
          // checkpoint. Keep polling until it becomes resumable.
          if (error?.status !== 409) throw error;
          if (!timeoutSettlementNoted) {
            pollingBudget.noteSettling();
            timeoutSettlementNoted = true;
          }
        }
        outcome = "running";
        continue;
      }
      if (outcome === "failed"
          && refresh.errorCode === "refresh_timed_out") {
        refreshProgressClock.update("Stopping timed-out analysis…");
        if (!timeoutSettlementNoted) {
          pollingBudget.noteSettling();
          timeoutSettlementNoted = true;
        }
        outcome = "running";
      }
    }
    cancelled = outcome === "cancelled";
    if (cancelled) {
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, "Loading saved results…");
      await loadLocalDashboard();
      showConnectionNotice({
        title: "Local analysis cancelled",
        copy: "TiboTattle stopped at a safe boundary. Verified existing results were kept, and the resumable checkpoint remains on this Mac.",
        kind: "info",
      });
      return;
    }
    if (outcome === "failed"
        && finalErrorCode === "refresh_resource_limited") {
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, "Loading saved results…");
      await loadLocalDashboard();
      showConnectionNotice({
        title: "This scan paused to protect your Mac",
        copy: "Your last verified results are still shown. This unusually large history reached TiboTattle’s fixed local safety limit, so it paused before exceeding it. No partial result replaced your existing results, and nothing left this Mac.",
        kind: "warning",
      });
      return;
    }
    if (outcome === "degraded") {
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, t("refresh.degradedLoading"));
      await loadLocalDashboard();
      lastReindexProgressReceipt = historyProgressReceipt();
      const history = dashboard?.pricing?.historyCoverage
        ?? dashboard?.accounting?.historyCoverage
        ?? null;
      const skipped = finite(
        finalUnifiedIndex?.generation?.skippedSourceCount,
        0,
      );
      const threads = finite(
        finalUnifiedIndex?.generation?.skippedThreadCount,
        0,
      );
      showConnectionNotice({
        title: t("refresh.degradedTitle"),
        copy: skipped > 0
          ? t("refresh.degradedCopy", {
            sources: tPlural("format.rolloutSourceCount", skipped, {
              count: formatNumber(skipped),
            }),
            threads: tPlural("format.affectedThreadCount", threads, {
              count: formatNumber(threads),
            }),
          })
          : t("refresh.degradedGenericCopy", {
            code: finalFailureCode ?? "unified_index",
          }),
        kind: historyCoverageNoticeKind({
          history,
          accountingProjection: dashboard?.accounting?.projection,
        }),
      });
      return;
    }
    if (outcome !== "succeeded") {
      // The companion stamps failures with a fixed step name and a bounded
      // machine code; carrying them here is the difference between "it did
      // not finish" and something a person can act on.
      const failureDetail = [finalFailedStep, finalFailureCode]
        .filter(Boolean).join(" · ");
      const failure = new Error(failureDetail
        ? `The local refresh failed at: ${failureDetail}.`
        : "The local refresh did not complete successfully.");
      if (finalFailureCode) failure.code = finalFailureCode;
      failure.refreshFailureDetail = failureDetail || null;
      throw failure;
    }
    archiveHistoryScanActive = false;
    refreshProgressClock.stop();
    refreshProgressClock = null;
    renderRefreshProgress(button, "Loading updated evidence…");
    await loadLocalDashboard();
    if (detailed) scheduleReindexAutoContinuation();
  } catch (error) {
    if (dashboard) {
      const presentation = dashboardObservationPresentation(
        dashboard,
        observationRecency(dashboard),
      );
      setGlobalState(presentation.state, {
        companionReachable: dashboard.mode !== "demo",
      });
    }
    if (!refreshAccepted && error?.status === 409) {
      // Another surface owns the shared controller. In particular, a quick
      // run is not proof that this request's detailed work was accepted. Do
      // not enqueue an escalation or turn a safe conflict into a failure.
      showConnectionNotice({
        title: t("refresh.alreadyRunningTitle"),
        copy: t("refresh.alreadyRunningCopy"),
        kind: "info",
      });
      return;
    }
    // This was a bare `catch {}`: it printed one of three sentences for every
    // possible cause and discarded the only evidence of which one occurred.
    // That is the same defect this file already fixed for the contribution
    // path, left in place on the product's most important path - so a refresh
    // that failed for a specific, named reason was indistinguishable from one
    // that merely did not finish, and there was nothing to quote when asking
    // for help. `local_refresh` was already a reviewed diagnostic surface with
    // no caller; this is that caller. The three sentences below remain as the
    // fallback for a cause with no fixed copy of its own.
    const described = await describeFailure({
      surface: "local_refresh",
      error,
      fallback: continuationLimitReached
        ? "TiboTattle stopped this one-click analysis rather than repeatedly reading a very large history. Your available headline and previously verified results remain usable; you can run the analysis again later from its durable checkpoint."
        : refreshAccepted
          ? (error?.refreshFailureDetail
            ? `The analysis failed at: ${error.refreshFailureDetail}. Existing evidence is still available and no partial accounting result replaced it.`
            : "The analysis was accepted, but it did not reach a verified completion state. Existing evidence is still available and no partial accounting result replaced it.")
        : "The local companion may be offline, busy, or rejecting this request. Existing evidence has not been altered.",
    });
    showConnectionNotice({
      title: continuationLimitReached
        ? "Deep analysis paused after two bounded continuations"
        : refreshAccepted
          ? "The local analysis did not finish"
        : "Local analysis could not be started",
      copy: described.text,
      kind: continuationLimitReached ? "warning" : "error",
      showDemo: !dashboard
    });
  } finally {
    refreshProgressClock?.stop();
    if (electronRefresh && refreshAccepted) await refreshLeaseSession?.finish();
    const wasArchiveScanning = archiveHistoryScanActive;
    archiveHistoryScanActive = false;
    if (wasArchiveScanning && dashboard) renderPricing(dashboard);
    localActionBusy = false;
    localRefreshInProgress = false;
    localRefreshCancelRequested = false;
    updateLocalActionButtons();
    void refreshElectronCadenceHealth();
    // The updating pill is derived from the renderer-owned lifecycle flag.
    // Restore the dashboard's last verified status after the refresh reaches a
    // terminal state so it cannot remain stuck on "Running" beside the idle
    // action button.
    const currentDashboardState = dashboard
      ? dashboardObservationPresentation(dashboard, observationRecency(dashboard)).state
      : null;
    const stableState = [currentDashboardState, globalState?.state, previousGlobalState?.state]
      .find((state) => state && state !== "updating");
    const candidateState = stableState ?? "insufficient";
    setGlobalState(
      candidateState,
      {
        companionReachable: dashboard
          ? dashboard.mode !== "demo"
          : previousGlobalState?.companionReachable ?? false,
      },
    );
  }
}

async function cancelLocalAnalysis() {
  if (!localRefreshInProgress || localRefreshCancelRequested) return;
  localRefreshCancelRequested = true;
  updateLocalActionButtons();
  try {
    await localClient.cancelRefresh();
    showConnectionNotice({
      title: "Cancellation requested",
      copy: "TiboTattle is stopping after its current atomic step and preserving a resumable local checkpoint.",
      kind: "info",
    });
  } catch {
    localRefreshCancelRequested = false;
    showConnectionNotice({
      title: "Cancellation could not be requested",
      copy: "The analysis may already have finished or the local companion may be reconnecting. Existing verified results are unchanged.",
      kind: "warning",
      showCheck: true,
    });
  }
  updateLocalActionButtons();
}

async function checkLocalSetup() {
  if (localActionBusy) return;
  localActionBusy = true;
  for (const selector of [
    "#connection-check",
    "#companion-check",
    "#setup-check-again",
  ]) {
    const button = $(selector);
    if (button) button.textContent = "Checking…";
  }
  updateLocalActionButtons();
  try {
    await loadLocalDashboard();
  } finally {
    localActionBusy = false;
    $("#connection-check").textContent = "Check again";
    $("#companion-check").textContent = "Check this page again";
    $("#setup-check-again").textContent = "Check again";
    updateLocalActionButtons();
  }
}

let nativeEvidenceReloadInFlight = false;

/**
 * Re-read the companion's fragments after the native shell finished a refresh.
 *
 * In a browser, `requestRefresh` drives the refresh itself and re-renders when
 * it completes. Inside the app that path stands down (see
 * `scheduleReturningUserRefresh` below), so this is the only thing that moves
 * the rendered numbers off the snapshot the page loaded with. Without it the
 * dashboard keeps showing the pre-refresh figures while the toolbar reports
 * the refresh finished - the UI asserting a freshness it does not have.
 */
async function reloadLocalEvidenceAfterNativeRefresh() {
  // A refresh started from this page re-renders on its own completion, and a
  // second overlapping read would only race it.
  if (nativeEvidenceReloadInFlight || localRefreshInProgress || localActionBusy) {
    return;
  }
  nativeEvidenceReloadInFlight = true;
  try {
    await loadQuickResultDashboard();
  } catch {
    // A failed re-read leaves the previous numbers on screen rather than
    // blanking them. The next finished refresh signals again.
  } finally {
    nativeEvidenceReloadInFlight = false;
  }
}

/**
 * Start Electron's one launch-time refresh after the local onboarding verdict
 * is available. The qualified smoke preload may hold this call behind its
 * CDP observation barrier; ordinary Electron renderers have no such bridge.
 */
function runsInsideNativeDashboard() {
  return document.documentElement.classList.contains("native-dashboard")
    || document.body?.classList.contains("native-dashboard");
}

function runsInsideElectronDashboard() {
  return globalThis.window?.tibotattleDesktop?.version === "v1";
}

function startElectronStartupRefresh() {
  if (electronStartupRefreshTriggered
      || !runsInsideElectronDashboard()
      || !localAnalysisAllowed()) {
    return false;
  }
  electronStartupRefreshTriggered = true;
  const runStartupRefresh = () => {
    if (localActionBusy) {
      // Only the bootstrap owner is guaranteed to call us again after it
      // clears its lock. Preserve the established one-shot suppression for
      // every other busy owner rather than leaving a deferred launch stuck.
      if (activeLocalDashboardLoad?.pending) {
        electronStartupRefreshTriggered = false;
        electronStartupRefreshDeferred = true;
      }
      return;
    }
    // Quick quota observations and accounting-cache generation do not advance
    // the unified index. Use its persisted publication time so repeated short
    // launches cannot keep old usage unindexed indefinitely. Match the host's
    // hourly detailed cadence; unknown/future evidence cannot prove freshness.
    // Evaluate after any startup barrier or dashboard lock has cleared.
    const projection = dashboard?.accounting?.projection;
    const history = dashboard?.timeline?.history;
    const generatedAt = history?.generatedAt;
    const generatedMs = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
    const ageMs = Date.now() - generatedMs;
    const freshIndex = projection?.status === "available"
      && projection.reason === null
      && projection.terminal === false
      && dashboard.accounting.generationMatched === true
      && history?.source === "unified_local_index"
      && ["complete", "partial"].includes(history.status)
      && Number.isFinite(generatedMs)
      && new Date(generatedMs).toISOString() === generatedAt
      && ageMs >= 0 && ageMs < 60 * 60_000;
    const startupRefreshOptions = freshIndex ? {} : { detailed: true };
    void requestRefresh(startupRefreshOptions);
  };
  const macSmokeBridge = globalThis.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__;
  const windowsSmokeBridge = globalThis.__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__;
  // A mixed or stale preload must not choose one platform barrier silently.
  const smokeBridge = macSmokeBridge !== undefined
    && windowsSmokeBridge !== undefined
    ? null
    : windowsSmokeBridge !== undefined
      ? windowsSmokeBridge
      : macSmokeBridge;
  if (smokeBridge !== undefined) {
    if (smokeBridge === null
        || smokeBridge.version !== "v1"
        || typeof smokeBridge.waitForStartupRefresh !== "function") {
      return true;
    }
    let gate;
    try {
      gate = smokeBridge.waitForStartupRefresh();
    } catch {
      return true;
    }
    if (!gate || typeof gate.then !== "function") return true;
    void Promise.resolve(gate).then(runStartupRefresh).catch(() => {});
    return true;
  }
  runStartupRefresh();
  return true;
}

function scheduleReturningUserRefresh() {
  // The native macOS shell owns the foreground cadence. Running both the web
  // return-visit timer and the native timer races the same bounded companion
  // request, which can surface a harmless 409 as a confusing dashboard error.
  // What the shell owes in return is a signal when its refresh finished, which
  // `tibotattle:local-evidence-updated` carries.
  if (runsInsideNativeDashboard()) return;
  if (runsInsideElectronDashboard()
      && (electronStartupRefreshTriggered || electronStartupRefreshDeferred)) return;
  const priorEvidence = dashboard?.mode !== "demo"
    && Boolean(
      dashboard?.activity?.lastScanAt
      || dashboard?.collector?.lastScanAt
      || dashboard?.freshness?.latestObservedAt
    );
  const terminalHistoryGap = currentHistoryContinuationDecision().terminalGap;
  if (returnRefreshScheduled
      || !priorEvidence
      || !localAnalysisAllowed()
      || terminalHistoryGap
      || localRefreshInProgress) {
    return;
  }
  returnRefreshScheduled = true;
  window.setTimeout(() => {
    if (localActionBusy || localRefreshInProgress) {
      returnRefreshScheduled = false;
      returnRefreshDeferrals += 1;
      if (returnRefreshDeferrals < 20) scheduleReturningUserRefresh();
      return;
    }
    returnRefreshDeferrals = 0;
    showConnectionNotice({
      title: "Cached results are ready",
      copy: "TiboTattle is checking for new local evidence from the last verified checkpoint. You can keep reading or cancel the update; no upload occurs.",
      kind: "info",
    });
    void requestRefresh();
  }, 750);
}

/**
 * Consume only the closed automatic refresh mode sent by the Electron main
 * process. Manual dashboard controls continue to request detailed accounting;
 * this event keeps the host-owned foreground cadence explicit in the page.
 */
function handleElectronAutomaticRefresh(event) {
  const detail = event?.detail;
  if (detail === null
      || typeof detail !== "object"
      || Array.isArray(detail)
      || Object.getPrototypeOf(detail) !== Object.prototype
      || Reflect.ownKeys(detail).length !== 1
      || !Object.hasOwn(detail, "mode")
      || (detail.mode !== "quick" && detail.mode !== "detailed")) return;
  void requestRefresh({ detailed: detail.mode === "detailed" });
}

/**
 * Look one fixed code up in a copy map.
 *
 * Own properties only: a code is an untrusted string, and plain member access
 * would otherwise resolve "constructor" or "toString" to something inherited
 * and render it as copy.
 */
function fixedCopy(map, code) {
  return typeof code === "string" && Object.hasOwn(map, code)
    ? map[code]
    : null;
}

const LOCAL_COMPANION_ERROR_COPY = {
  unsupported_media_type:
    "The local companion rejected this request format. Nothing was uploaded; reload TiboTattle and try again.",
  request_too_large:
    "The local request exceeded the local safety bound. Nothing was uploaded; reload TiboTattle and try again.",
  invalid_json:
    "The local companion could not read this request. Nothing was uploaded; reload TiboTattle and try again.",
  invalid_request:
    "The local companion could not validate this request. Nothing was uploaded; reload TiboTattle and try again.",
  refresh_in_progress:
    "A local analysis is already running. Wait for it to finish before starting another.",
  refresh_not_authorized:
    "TiboTattle refused to analyze local usage because the request did not come from the local dashboard. Nothing was changed.",
  refresh_cancel_not_authorized:
    "TiboTattle refused to cancel the analysis because the request did not come from the local dashboard. The analysis is still running.",
  refresh_not_running:
    "There is no local analysis running to cancel. Nothing was changed.",
  app_record_checkpoint_unavailable:
    "The analysis checkpoint stored on this Mac disappeared while the analysis was running, so TiboTattle stopped rather than continue without it. Existing results are unchanged; run the analysis again to start over safely.",
  diagnostic_note_not_authorized:
    "TiboTattle refused to write a diagnostic note because the request did not come from the local dashboard. The reference above is still quotable.",
  diagnostic_note_not_recorded:
    "TiboTattle could not write the diagnostic note to its local log. The reference above is still quotable.",
  loopback_required:
    "This request has to come from the local dashboard on this Mac. Nothing was changed. Open TiboTattle and try again.",
  host_not_allowed:
    "TiboTattle only answers the local dashboard on this Mac and refused this request. Nothing was changed.",
  method_not_allowed:
    "TiboTattle does not offer that action on this route. Nothing was changed; install the current signed build.",
  not_found:
    "This build asked TiboTattle for something it does not provide. Nothing was changed; install the current signed build.",
  internal_error:
    "TiboTattle failed while handling this request on your Mac. Nothing was uploaded; reopen TiboTattle and try again.",
  request_failed:
    "TiboTattle could not complete this request. Nothing was uploaded; reopen TiboTattle and try again.",
};

/**
 * Turn one failure into honest copy plus a quotable reference.
 *
 * The reference is fresh WebCrypto randomness, never derived from anything the
 * user typed or the service returned. The page waits for the local diagnostics
 * POST and claims the write only after the companion confirms it; when that
 * confirmation fails, the reference remains visible without the write claim,
 * and a companion that answered yet refused the note is reported to the
 * console rather than blending into an unreachable one.
 * The sentence itself always comes from a map written here or from the caller's
 * fallback; no server string is ever rendered.
 */
async function describeFailure({ surface, error, messages = {}, fallback }) {
  const reference = createDiagnosticReference();
  const code = diagnosticErrorCode(error?.code);
  const requestId = serviceRequestId(error?.requestId);
  // Some codes classify a family rather than a cause. When the failure knows
  // which member it was, the reference must be able to say so, or looking it
  // up later answers no more than the sentence already did. An absent or
  // malformed detail stays empty and none is filed; the companion accepts only
  // the closed vocabulary it owns, so one it does not recognise is refused
  // aloud through the path below rather than written.
  const detailCode = diagnosticErrorCode(error?.detail?.code);
  let writtenToLocalLog = false;
  // "recorded" | "refused" | "unreachable": a companion that answered without
  // confirming this exact reference refused the note, which is a contract
  // break between this build and the companion; only a request that never got
  // an answer counts as unreachable.
  let localNote = "unreachable";
  try {
    const recorded = await localClient.recordDiagnosticNote({
      reference,
      surface: diagnosticSurface(surface),
      code,
      detail: detailCode,
      requestId
    });
    writtenToLocalLog = recorded?.status === "recorded"
      && recorded.reference === reference;
    localNote = writtenToLocalLog ? "recorded" : "refused";
  } catch (noteError) {
    // The reference remains useful even when the local companion cannot write
    // its diagnostics log. Do not claim a write that was not confirmed.
    localNote = typeof noteError?.status === "number"
      ? "refused"
      : "unreachable";
  }
  if (localNote === "refused") {
    // Never silent: a running companion that declines this page's own note
    // means the reference shown below cannot be looked up later.
    console.error(
      `Diagnostic note ${reference} was refused by the local companion.`
    );
  }
  const fixedExplanation = fixedCopy(messages, code)
    ?? fixedCopy(LOCAL_COMPANION_ERROR_COPY, code);
  const explanation = fixedExplanation ?? fallback;
  const trailer = diagnosticReferenceSentence({
    reference,
    requestId,
    writtenToLocalLog,
  });
  return Object.freeze({
    reference,
    requestId,
    code,
    localNote,
    text: trailer === "" ? explanation : `${explanation} ${trailer}`
  });
}

$("#refresh-button").addEventListener("click", () => {
  void requestRefresh({ detailed: true });
});
$("#setup-refresh").addEventListener("click", () => {
  void requestRefresh({ detailed: true });
});
$("#cancel-refresh").addEventListener("click", cancelLocalAnalysis);
$("#open-installed-app").addEventListener("click", openInstalledApp);
$("#connection-check").addEventListener("click", checkLocalSetup);
$("#companion-check").addEventListener("click", checkLocalSetup);
$("#setup-check-again").addEventListener("click", checkLocalSetup);
window.addEventListener("tibotattle:automatic-refresh", handleElectronAutomaticRefresh);
window.addEventListener("focus", () => {
  if (electronSharingBridge() !== null && dashboard !== null) {
    void loadElectronSharingPreference({ dashboardReady: true }).catch(() => {});
  }
});
$("#electron-sharing-share-now")?.addEventListener("click", () => {
  void setElectronSharingEnabled(true);
});
$("#electron-sharing-keep-off")?.addEventListener("click", () => {
  void setElectronSharingEnabled(false);
});
$("#electron-accountless-sharing-enabled")?.addEventListener("change", (event) => {
  void setElectronSharingEnabled(event.target.checked === true);
});
window.addEventListener("tibotattle:local-evidence-updated", () => {
  void reloadLocalEvidenceAfterNativeRefresh();
});
$("#demo-button").addEventListener("click", showDemoDashboard);
$("#usage-zoom-in").addEventListener("click", () => {
  if (!dashboard) return;
  zoomUsageTimeline(selectedUsagePoints(dashboard), 1 / TIMELINE_BUTTON_ZOOM_STEP);
});
$("#usage-zoom-out").addEventListener("click", () => {
  if (!dashboard) return;
  zoomUsageTimeline(selectedUsagePoints(dashboard), TIMELINE_BUTTON_ZOOM_STEP);
});
$("#usage-pan-back").addEventListener("click", () => {
  if (!dashboard) return;
  panUsageTimeline(selectedUsagePoints(dashboard), -.2);
});
$("#usage-pan-forward").addEventListener("click", () => {
  if (!dashboard) return;
  panUsageTimeline(selectedUsagePoints(dashboard), .2);
});
$("#usage-reset-zoom").addEventListener("click", () => {
  resetUsageTimelineViewport();
  resetTimelineViewport();
  if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
});

$("#timeline-zoom-in").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
});
$("#timeline-zoom-out").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, TIMELINE_BUTTON_ZOOM_STEP);
});
$("#timeline-pan-back").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, -.2);
});
$("#timeline-pan-forward").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, .2);
});
$("#timeline-reset-zoom").addEventListener("click", () => {
  resetTimelineViewport();
  if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
});
// The exact-windows pager (owner-directed, 2026-08-08). The page index is
// clamped inside the renderer, so a click at either end can never leave the
// row set.
$("#residual-page-prev").addEventListener("click", () => {
  residualTablePage -= 1;
  renderResidualInspectionTable();
});
$("#residual-page-next").addEventListener("click", () => {
  residualTablePage += 1;
  renderResidualInspectionTable();
});
// Same clamped-in-renderer rule for the Allowance page's reset-estimate table.
$("#weekly-table-prev").addEventListener("click", () => {
  weeklyTablePage -= 1;
  renderWeeklyTablePage();
});
$("#weekly-table-next").addEventListener("click", () => {
  weeklyTablePage += 1;
  renderWeeklyTablePage();
});
$("#divergence-page-prev").addEventListener("click", () => {
  divergenceTablePage -= 1;
  renderDivergencePeriodPage();
});
$("#divergence-page-next").addEventListener("click", () => {
  divergenceTablePage += 1;
  renderDivergencePeriodPage();
});
$("#accounting-model-page-prev").addEventListener("click", () => {
  accountingModelsTablePagination.page -= 1;
  renderAccountingModels(
    dashboard === null ? null : accountingPeriod(dashboard),
  );
});
$("#accounting-model-page-next").addEventListener("click", () => {
  accountingModelsTablePagination.page += 1;
  renderAccountingModels(
    dashboard === null ? null : accountingPeriod(dashboard),
  );
});
$("#cache-switch-page-prev").addEventListener("click", () => {
  cacheSwitchTablePagination.page -= 1;
  renderAccountingCacheSwitchDetails(
    dashboard === null ? null : accountingPeriod(dashboard)?.cacheSwitchImpact,
  );
});
$("#cache-switch-page-next").addEventListener("click", () => {
  cacheSwitchTablePagination.page += 1;
  renderAccountingCacheSwitchDetails(
    dashboard === null ? null : accountingPeriod(dashboard)?.cacheSwitchImpact,
  );
});
$("#cache-continuity-page-prev").addEventListener("click", () => {
  cacheContinuityTablePagination.page -= 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
  );
});
$("#cache-continuity-page-next").addEventListener("click", () => {
  cacheContinuityTablePagination.page += 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
  );
});
$("#side-chat-page-prev").addEventListener("click", () => {
  sideChatTablePagination.page -= 1;
  renderAccountingSideChatDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.sideChatEstimates,
  );
});
$("#side-chat-page-next").addEventListener("click", () => {
  sideChatTablePagination.page += 1;
  renderAccountingSideChatDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.sideChatEstimates,
  );
});
$("#side-chat-historical-gap-focus").addEventListener("click", () => {
  if (!dashboard) return;
  const probe = accountingPeriod(dashboard)?.sideChatEstimates
    ?.historicalGapProbe;
  const startMs = Date.parse(probe?.startAt ?? "");
  const endMs = Date.parse(probe?.endAt ?? "");
  if (probe?.status !== "available"
      || !Number.isFinite(startMs) || !Number.isFinite(endMs)
      || endMs <= startMs) return;
  reportingPeriod.select("all");
  timelineViewport = { startMs, endMs };
  usageTimelineViewport = { startMs, endMs };
  timelineSeriesMemo = null;
  window.location.hash = "#timeline";
  renderUsageTimeline(dashboard);
  renderTimeline(dashboard);
});
$("#usage-group-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (!button || !dashboard || !usageGroupingsForRange().includes(button.dataset.group)) return;
  activeUsageGrouping = button.dataset.group;
  for (const control of $("#usage-group-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetUsageTimelineViewport();
  resetTimelineViewport();
  renderUsageTimeline(dashboard);
  renderTimeline(dashboard);
});
$("#allowance-window-controls")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-window-minutes]");
  if (!button || !dashboard || button.disabled) return;
  const windowMinutes = Number(button.dataset.windowMinutes);
  if (![CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, CODEX_WEEKLY_ALLOWANCE_MINUTES]
      .includes(windowMinutes)) return;
  activeAllowanceWindowMinutes = windowMinutes;
  renderWeekly(dashboard);
});
$("#weekly-plan-select")?.addEventListener("change", (event) => {
  if (!dashboard || !dashboard.weekly.planPopulations.some(
    (population) => population.planType === event.target.value,
  )) return;
  activeWeeklyPlanType = event.target.value;
  timelineSeriesMemo = null;
  renderComparison(dashboard);
  resetTimelineViewport();
  renderUsageTimeline(dashboard);
  renderTimeline(dashboard);
  renderWeekly(dashboard);
});
$("#weekly-span-control").addEventListener("input", (event) => {
  if (!dashboard) return;
  activeWeeklyMinimumObservedSpanPp = Math.min(99, Math.max(0, Number(event.target.value)));
  renderWeekly(dashboard);
});

$("#share-card-download").addEventListener("click", downloadShareCard);
$("#share-card-copy").addEventListener("click", copyShareCardImage);
document.addEventListener("click", (event) => {
  const current = activeInformationPopover;
  if (!current) return;
  if (current.button.contains(event.target) || current.popover.contains(event.target)) return;
  closeInformationPopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !activeInformationPopover) return;
  event.preventDefault();
  closeInformationPopover({ restoreFocus: true });
});
window.addEventListener("resize", () => {
  if (dashboard && !$("#timeline").inert) scheduleUsageTimelineRender();
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
});
let allowanceChartResizeFrame = null;
window.addEventListener("resize", () => {
  if (allowanceChartResizeFrame !== null) cancelAnimationFrame(allowanceChartResizeFrame);
  allowanceChartResizeFrame = requestAnimationFrame(() => {
    allowanceChartResizeFrame = null;
    const shell = $("#weekly-chart");
    if (!dashboard || !shell || shell.hidden || !shell.getClientRects().length) return;
    const data = allowanceWindowView(dashboard);
    const history = allowanceHistoryChartModel(data);
    drawChart(shell, renderAllowanceHistoryChart(history, data.allowanceWindowDurationMinutes));
  });
});
document.addEventListener("scroll", () => {
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
}, true);

const workUsageView = mountWorkUsageView({ root: document.querySelector("#projects"), t, renderInformationLabel: informationLabel, sharedReporting: true, reportingWindow: null });
const modelPerformance = mountModelPerformance({
  root: document.querySelector("#performance"), client: localClient,
  t, locale: () => localization.formatLocale(), sharedReporting: true, reportingWindow: null,
});
window.addEventListener("tibotattle:locale-change", () => {
  modelPerformance.render();
  renderReportingPeriod();
});
mountReportingPeriodDismissal(document);
document.querySelector("#reporting-period-controls").addEventListener("click", event => {
  const button = event.target.closest("button[data-period]");
  if (button) reportingPeriod.select(button.dataset.period);
});
renderReportingPeriod();
const dashboardReportPreloader = createDashboardReportPreloader({ reports: [workUsageView, modelPerformance] });

mountDashboardNavigation({
  documentRef: document,
  windowRef: window,
});

async function bootstrapDashboard() {
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  updateLocalActionButtons();
  await loadLocalDashboard();
  startElectronStartupRefresh();
  scheduleReturningUserRefresh();
}

bootstrapDashboard();
