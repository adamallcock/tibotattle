import {
  CommunityClient,
  isPrimaryCodexQuotaWindow,
  isPrimaryCodexWeeklyQuotaWindow,
  LocalCompanionClient,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  demoDashboard,
  isValidQuotaWindowDuration,
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
  refreshNeedsContinuation,
  serviceRequestId,
  validateContributionForUpload
} from "./lib.js";
import {
  mountDashboardNavigation,
} from "./navigation.js";
import {
  renderInstallerJourney as renderSharedInstallerJourney,
} from "./install-cta.js";
import {
  createBrowserLocalization,
} from "./localization.js";
import {
  compact,
  adaptiveChartTickCount,
  classifyTimelineEvidence,
  createDomHelpers,
  finite,
  formatAge,
  formatChartTimestamp,
  formatLocal,
  formatModelName,
  formatNumber,
  formatReportingTime,
  formatTimeZoneLabel,
  getFormattingLocale,
  localCalendarParts,
  numberFormatter,
  selectAvailableAccountingPeriod,
  setFormattingLocale,
  setMessageLocale,
  REPORTING_TIME_ZONE,
  USER_TIME_ZONE,
} from "./ui-format.js";

const localization = createBrowserLocalization();
setFormattingLocale(localization.formatLocale());
setMessageLocale(localization.locale());
const t = localization.t;
const tPlural = localization.tPlural;

const localClient = new LocalCompanionClient();
let communitySession = null;
const communityClient = new CommunityClient({
  getCsrfToken: () => communitySession?.csrfToken ?? null,
  getParticipantId: () => communitySession?.participantId ?? null
});

let dashboard = null;
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
let localCompanionHealth = null;
// This is an optional, short-lived rendering hint from the public health
// endpoint. The Worker remains authoritative; a missing or stale health read
// never blocks a legitimate sign-in, while an explicit paused state avoids
// sending somebody into an OAuth ceremony that the service will refuse.
let communityServiceHealth = null;
let contributionSyncStatus = null;
let contributionSyncPreview = null;
let contributionSyncExactReview = null;
let contributionSyncBusy = false;
// The prepared set the page last verified by itself. The summary card is the
// review — there is no separate reveal click — so when a ready prepared set
// appears, the page runs the exact local verification once for that set. The
// key prevents a failing verification from being retried in a render loop:
// retrying is an explicit action again after a failure.
let contributionSyncAutoReviewedKey = null;
// Approval state for the approve-once incremental consent surface. It exists
// only while the companion advertises the v1.0 sync capability. The page
// itself holds nothing durable: the approved flag is re-read from the
// companion's incremental-status projection, which also feeds the modest
// days-synced/paused/last-error status line under the surface.
let incrementalConsentApproved = false;
let incrementalConsentBusy = false;
let incrementalSyncStatus = null;
// The invisible review bootstrap prepares one real instance of the covered
// data at most once per queue state, so a failing preparation cannot loop;
// trying again is the explicit "Check again" action.
let incrementalReviewPrepareAttempted = false;
// One silent authorization repair per page load (owner-directed 2026-08-08):
// a Mac whose earlier pairing carried the v0.1 consent has no server-side
// v1.0 grant, so its uploads pause with consent_rejected. When the page holds
// the session, it re-runs the pairing ceremony with the v1.0 consent by
// itself — once — instead of surfacing a failure the user cannot act on.
let incrementalRepairAttempted = false;
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
// The short read-only polling loop behind the live first-pass status line.
// setTimeout-chained (never an interval), bounded, and it only ever performs
// the same GET the page performs on load.
let incrementalSyncPollTimer = null;
let incrementalSyncPollCount = 0;
let fastModePreference = null;
let fastModePreferenceBusy = false;
let localOnboarding = null;
let communityConnectBusy = false;
// True once this Mac has actually been paired as an upload-only device in
// this session.
let communityDevicePaired = false;
// True once THIS session claimed a pairing that carried the v1.0 incremental
// consent — the claim is what records the server-side consent-once grant. A
// v0.1-era credential or a previously accepted upload is deliberately not
// enough: the ceremony re-pairs unless this exact evidence exists.
let communityDevicePairedV1 = false;
// The opaque sign-in proof lives only in this module-scoped memory; it is
// never persisted to storage and disappears with the tab.
let hostedIdentity = null;
let hostedIdentityBusy = false;
// A single page-local attempt owns the short polling loop. It is never stored
// with the opaque proof and lets the user cancel a stalled browser handoff
// without waiting for the server's five-minute expiry.
let activeHostedSignIn = null;
// Only the contribution service knows whether each hosted provider is
// configured, so these stay false until a start attempt says otherwise.
let appleSignInUnavailable = false;
let googleSignInUnavailable = false;
let localActionBusy = false;
let localRefreshInProgress = false;
let localRefreshCancelRequested = false;
// Archive indexing progress is intentionally transient: the durable dashboard
// continues to show only the last verified complete/partial coverage receipt.
// While a refresh owns a new pass, make that distinction visible beside cost
// rather than letting a previous complete receipt look current.
let archiveHistoryScanActive = false;
let returnRefreshScheduled = false;
let returnRefreshDeferrals = 0;
let globalState = null;
let visibleConnectionNotice = null;
let dashboardUnavailableState = null;

const $ = (selector) => document.querySelector(selector);
const { clear, node } = createDomHelpers(document);

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
}

window.addEventListener("tibotattle:locale-change", (event) => {
  setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
  setMessageLocale(event.detail?.locale ?? localization.locale());
  rerenderLocalizedDashboard();
});

// The release-slot marker for "this build is paired with a hosted contribution
// service". It is read as a build signal only: the client id itself no longer
// travels anywhere from this page, because the service now builds the
// authorization request. It stays here because it is the one fact a build
// carries about whether hosted participation — and therefore mandatory
// sign-in — applies at all.
function configuredGoogleClientId() {
  const value = document
    .querySelector('meta[name="usage-monitor-google-client-id"]')
    ?.getAttribute("content")
    ?.trim();
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]{7,255}$/u.test(value)
    ? value
    : null;
}

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

function updateLocalActionButtons() {
  const allowed = localAnalysisAllowed();
  const label = localAnalysisLabel();
  for (const selector of ["#refresh-button", "#setup-refresh"]) {
    const button = $(selector);
    button.disabled = localActionBusy || !allowed;
    if (!localActionBusy) button.textContent = label;
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

function setCommunitySession(value) {
  communitySession = value;
  if (!value) {
    // Losing the session means the next primary action is a connection again,
    // not a review of something this Mac can no longer send.
    communityDevicePaired = false;
    renderContributionActionState();
  }
}

function formatMoney(value, digits = 0) {
  const number = finite(value);
  return number === null
    ? "—"
    : formatNumber(number, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
}

function formatApiMoney(value) {
  const number = finite(value);
  if (number === null) return "—";
  if (number > 0 && number < .01) {
    return `<${formatNumber(.01, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return formatNumber(number, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A percentage near an end of the scale must not be printed as if it were at
 * that end. `Intl` rounds 99.96 to "100%" and 0.04 to "0%", and on this
 * dashboard both ends are load-bearing claims rather than cosmetics:
 *
 *   100% price coverage means every usage change carries a reviewed price,
 *        which is why the rounded "100%" sat next to a note saying coverage
 *        was partial - the note was right and the number was rounded.
 *     0% remaining means the allowance is gone, which is a different fact
 *        from "a sliver is left".
 *
 * So only an exact 0 or 100 may print as 0% or 100%. Anything strictly
 * between prints as a bounded "<" or ">" reading, the same idiom
 * `formatApiMoney` already uses for amounts under a cent.
 */
function formatPercent(value, digits = 0) {
  const number = finite(value);
  if (number === null) return "—";
  const places = Number.isInteger(number) ? 0 : digits;
  const percentFormatter = numberFormatter({
    maximumFractionDigits: places,
    minimumFractionDigits: 0,
    style: "percent",
  });
  const format = (amount) => percentFormatter.format(amount / 100);
  // The test is whether this value *renders* as an endpoint, not whether it
  // is near one: at whole-number precision 99.2 renders as "99%", which is
  // honest and needs no bound, while 99.5 renders as "100%", which is not.
  // Comparing rendered strings also keeps this agreeing with whatever
  // rounding mode the locale's formatter uses.
  const step = 10 ** -places;
  const rendered = format(number);
  if (number > 0 && rendered === format(0)) return `<${format(step)}`;
  if (number < 100 && rendered === format(100)) return `>${format(100 - step)}`;
  return rendered;
}

/**
 * One whole-number formatter for tabular counts.
 *
 * `compact` is right for a headline chip, where a single number stands alone.
 * It is wrong for a column: it renders "154.9K" next to "74" and silently
 * changes precision partway down the table, so nothing can be compared or
 * added up by eye. Grouped exact integers stay comparable at every magnitude.
 */
function formatCount(value) {
  const number = finite(value);
  if (number === null || number < 0) return t("accounting.model.notReported");
  return formatNumber(Math.trunc(number), { maximumFractionDigits: 0 });
}

function formatDecimal(value, digits = 0) {
  const number = finite(value);
  return number === null
    ? "—"
    : numberFormatter({
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(number);
}

let activeInformationPopover = null;
let nextInformationPopoverId = 1;

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
  if (restoreFocus && current.button.isConnected) current.button.focus();
}

function openInformationPopover(button) {
  if (activeInformationPopover?.button === button) {
    closeInformationPopover({ restoreFocus: false });
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
  activeInformationPopover = { button, popover };
  positionInformationPopover(popover, button);
}

function informationLabel(label, explanation) {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(label));
  const button = node("button", "info-button", "i");
  button.type = "button";
  button.dataset.informationExplanation = explanation;
  button.setAttribute("aria-label", t("aria.moreInformation", { label }));
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openInformationPopover(button);
  });
  fragment.append(button);
  return fragment;
}

function formatPp(value, digits = 1) {
  const number = finite(value);
  return number === null ? "—" : `${formatDecimal(number, digits)} pp`;
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

function formatTimeRemaining(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("format.timeUnavailable");
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return t("format.resetDue");
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t("format.remainingDays", { days, hours });
  if (hours > 0) return t("format.remainingHours", { hours, minutes });
  return t("format.remainingMinutes", { minutes });
}

function formatSpanLength(spanMs) {
  const minutes = Math.max(1, Math.round(spanMs / 60_000));
  if (minutes < 90) return tPlural("format.durationMinute", minutes);
  const hours = minutes / 60;
  if (hours < 48) {
    const value = Number(hours.toFixed(hours < 10 ? 1 : 0));
    return tPlural("format.durationHour", value, {
      count: formatDecimal(value, hours < 10 ? 1 : 0),
    });
  }
  const value = Number((hours / 24).toFixed(1));
  return tPlural("format.durationDay", value, { count: formatDecimal(value, 1) });
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
  if (data?.mode === "demo" || complete
      || indexed === null || total === null || total <= 0) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  setRawText(badge, t("status.indexingHistory", {
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
  pill.className = `state-pill state-${globalState.state}`;
  pill.replaceChildren(
    node("span", "state-dot"),
    document.createTextNode(t(keys[globalState.state] ?? "status.unknown")),
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

function renderDashboardUnavailableState(kind) {
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
  $("#setup-title").textContent = boundedPause
    ? "Continue your local analysis"
    : ready
      ? "This Mac is ready"
      : value.stateStatus === "unwritable" && sourceReady
        ? "Local app state needs attention"
        : sourceGuidance.title;
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

function renderDashboard(data) {
  dashboardUnavailableState = null;
  dashboard = data;
  if (data.mode === "demo") {
    setJourneyState("demo-mode");
    $("#setup-card").hidden = true;
  }
  setGlobalState(data.state, {
    companionReachable: data.mode !== "demo"
  });
  renderHistoryIndexBadge(data);
  $("#latest-observation").textContent = data.freshness.latestObservedAt
    ? formatAge(data.freshness.ageSeconds ?? (Date.now() - Date.parse(data.freshness.latestObservedAt)) / 1000)
    : "No timestamp";
  $("#data-source").textContent = data.mode === "demo"
    ? "Illustrative fixture — not your usage"
    : `${formatLocal(data.freshness.latestObservedAt)} · local companion`;
  // The footer's "Dashboard contract" line is gone (owner-directed,
  // 2026-08-08): the version stays machine-discoverable on data.schemaVersion
  // and in the share card's text transcript, and was never a user fact.

  if (data.mode === "demo") {
    showConnectionNotice({
      title: "You are exploring a labeled demonstration",
      copy: "Every number on this page is illustrative. Open the Mac app and use the TiboTattle in-app window to see your own evidence.",
      kind: "demo",
      showCheck: true
    });
  } else if (data.state === "stale") {
    // A stale cached accounting result makes the companion's single freshness
    // verdict "stale" even when the newest observation is seconds old. Saying
    // the observation is old in that case is simply untrue, and it is the
    // reason a refresh appears to change nothing: the observation was never
    // what was stale.
    const observationIsCurrent = finite(data.freshness.ageSeconds) !== null
      && finite(data.freshness.staleAfterSeconds) !== null
      && data.freshness.ageSeconds <= data.freshness.staleAfterSeconds;
    if (observationIsCurrent && data.freshness.accountingStatus === "stale") {
      showConnectionNotice({
        copyKey: "dashboard.stale.accountingCopy",
        kind: "warning",
        titleKey: "dashboard.stale.accountingTitle",
      });
    } else {
      showConnectionNotice({
        title: "The local evidence is stale",
        copy: "The dashboard is showing real local artifacts, but the latest collector observation is older than its freshness threshold.",
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

  renderQuotaCards(data);
  renderEvidenceWarnings(data);
  renderPricing(data);
  renderComparison(data);
  // The share card renders inside renderWeekly, from the same history model
  // as the chart it summarizes (owner-verified regression, 2026-08-08).
  renderUsageTimeline(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  renderCommunityJourney();
}

function renderQuotaCards(data) {
  const container = $("#quota-cards");
  clear(container);
  const normalWindows = data.quotaWindows.filter(isPrimaryCodexQuotaWindow);
  const sparkWindows = data.quotaWindows.filter((window) => (
    window?.limitId === CODEX_SPARK_LIMIT_ID
      && isValidQuotaWindowDuration(finite(window?.durationMinutes))
  ));
  const primaryWindow = selectPrimaryCodexQuotaWindow(normalWindows);
  const normalOrderedWindows = primaryWindow === null
    ? normalWindows
    : [primaryWindow, ...normalWindows.filter((window) => window !== primaryWindow)];
  // Spark is a separate provider limit. Keep it out of the normal allowance
  // selection so it cannot be mistaken for the five-hour or seven-day track.
  const windows = [...normalOrderedWindows, ...sparkWindows];
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
  for (const window of windows) {
    const remaining = finite(window.remainingPercent);
    const spark = window.limitId === CODEX_SPARK_LIMIT_ID;
    const card = node("article", [
      "metric-card",
      window.status === "stale" ? "stale" : "",
      spark ? "quota-card-spark" : "",
    ].filter(Boolean).join(" "));
    const header = node("div", "metric-card-header");
    const name = node("span", "metric-name", localizedQuotaWindowLabel(window));
    const plan = node("span", "evidence-chip");
    const reportedPlan = providerReportedPlanEvidence(window.planType);
    if (spark) {
      setLocalizedText(plan, "dashboard.quota.spark");
    } else if (data.mode === "demo") {
      setLocalizedText(plan, "dashboard.quota.demo");
    } else if (reportedPlan) {
      plan.textContent = reportedPlan;
    } else {
      setLocalizedText(plan, "dashboard.quota.observed");
    }
    header.append(
      name,
      plan,
    );
    const value = node("strong", "metric-value");
    setLocalizedText(value, "dashboard.quota.remaining", {
      value: remaining === null
        ? "—"
        : formatPercent(remaining, window.precision ?? 0),
    });
    const progress = node("div", "mini-progress");
    const fill = node("i");
    fill.style.width = `${Math.max(0, Math.min(100, remaining ?? 0))}%`;
    progress.append(fill);
    const meta = node("div", "metric-meta");
    meta.append(
      node(
        "span",
        "",
        window.usedPercent === null
          ? t("dashboard.quota.usedUnknown")
          : t("dashboard.quota.used", {
            value: formatPercent(window.usedPercent),
          }),
      ),
      node(
        "span",
        "",
        window.resetAt
          ? t("dashboard.quota.resets", { time: formatLocal(window.resetAt) })
          : t("dashboard.quota.resetUnknown"),
      ),
    );
    card.append(header, value, progress, meta);
    if (window.resetAt) card.append(node("p", "", formatTimeRemaining(window.resetAt)));
    if (window.observedAt) {
      card.append(node("p", "", t("dashboard.quota.observedAtPlain", {
        time: formatLocal(window.observedAt),
      })));
    }
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
  if (window?.limitId === CODEX_SPARK_LIMIT_ID) {
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
  return t("dashboard.quota.windowOther");
}

function renderPricing(data) {
  const pricing = data.pricing;
  const fastMode = pricing.fastMode;
  setRawText($("#cost-period"), pricing.periodLabel);
  // The headline is the quota-weighted figure whenever a weighting exists;
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
 * refuses everywhere else. The block is absent entirely once the index is
 * complete, and absent when there is no denominator to divide by.
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
  if (history === null || history.status === "complete" || total <= 0) {
    container.hidden = true;
    return false;
  }
  container.hidden = false;
  const percent = (indexed / total) * 100;
  setLocalizedText(
    $("#history-progress-headline"),
    archiveHistoryScanActive
      ? "dashboard.history.indexingActive"
      : history.phase === "not_started"
        ? "dashboard.history.indexingNotStarted"
        : "dashboard.history.indexingPaused",
    { percent: formatPercent(percent, 1) },
  );
  container.classList.toggle("active", archiveHistoryScanActive);
  const track = $("#history-progress-track");
  track.setAttribute("aria-valuenow", String(Math.round(percent)));
  // The bar alone would announce a bare percentage. The counted sources are
  // the fact worth hearing, so they are what it reports.
  track.setAttribute("aria-valuetext", t("dashboard.history.indexingSources", {
    bytesIndexed: formatBytes(history.indexedBytes),
    bytesTotal: formatBytes(history.sourceBytes),
    indexed: formatNumber(indexed),
    total: formatNumber(total),
  }));
  // A started-but-tiny index must still be visibly non-empty, or 2.7% reads as
  // "nothing has happened".
  $("#history-progress-fill").style.width =
    `${indexed > 0 ? Math.max(1.5, percent) : 0}%`;
  setLocalizedText($("#history-progress-detail"), "dashboard.history.indexingSources", {
    bytesIndexed: formatBytes(history.indexedBytes),
    bytesTotal: formatBytes(history.sourceBytes),
    indexed: formatNumber(indexed),
    total: formatNumber(total),
  });
  setLocalizedText($("#history-progress-note"), "dashboard.history.indexingResumes");
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

function latestRollingPair(data) {
  if (data.timeline?.usage?.length) {
    const live = liveTimelinePoints(data, {
      windowHours: CALIBRATION_WINDOW_HOURS,
      rangeDays: activeUsageRangeDays,
    })
      .filter((row) => row.observed !== null && row.expected !== null)
      .at(-1);
    if (live) return live;
  }
  if (data.gradient.rollingDetail.length) {
    const row = data.gradient.rollingDetail.at(-1);
    return {
      observed: finite(row.observed_quota_change_pp ?? row.observedQuotaChangePp),
      expected: finite(row.expected_quota_change_pp ?? row.expectedQuotaChangePp),
      residual: finite(row.residual_pp ?? row.residualPp)
    };
  }
  // The canonical artifact rolling series is the three-hour smoothing; the
  // hourly rows are diagnostic extras, and the owner fixed every comparison
  // to the three-hour width (2026-08-06).
  const groups = groupRolling(data.gradient.rolling, CALIBRATION_WINDOW_HOURS);
  const last = groups.at(-1);
  return last ? { observed: last.observed, expected: last.expected, residual: last.observed - last.expected } : null;
}

function renderComparison(data) {
  const pair = latestRollingPair(data);
  const summary = data.gradient.summary ?? {};
  const weeklySummary = data.weekly.summary ?? {};
  const mae = finite(summary.mean_absolute_error_pp ?? summary.meanAbsoluteErrorPp);
  const within = finite(summary.points_within_80_band_fraction ?? summary.pointsWithin80BandFraction);
  // The weekly estimator is the canonical fitted-rate source. Older gradient
  // artifacts used a separate summary shape, which is retained only as a
  // compatibility fallback for old demo payloads.
  const capacity = finite(
    weeklySummary.median_weekly_value_usd
      ?? weeklySummary.medianWeeklyValueUsd
      ?? summary.capacity_usd
      ?? summary.capacityUsd,
  );
  const lower = finite(
    weeklySummary.lower_80_across_resets_usd
      ?? weeklySummary.lower80Usd
      ?? summary.lower_80_usd
      ?? summary.lower80Usd,
  );
  const upper = finite(
    weeklySummary.upper_80_across_resets_usd
      ?? weeklySummary.upper80Usd
      ?? summary.upper_80_usd
      ?? summary.upper80Usd,
  );
  const qualifyingResets = finite(
    weeklySummary.qualifying_resets ?? weeklySummary.qualifyingResets,
    0,
  );
  const chip = $("#fit-chip");
  renderCalibrationRate({ capacity, lower, upper, qualifyingResets });
  if (!pair || pair.observed === null || pair.expected === null) {
    setProductText(chip, "Insufficient");
    setProductText(
      $("#comparison-result"),
      "There is not yet a matched quota-and-cost window to compare.",
    );
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
function renderCalibrationRate({ capacity, lower, upper, qualifyingResets = 0 }) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
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
 * A date-only label for a derived reset estimate. The card deliberately omits
 * a time of day and any raw-log timestamp.
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
  const points = (Array.isArray(history?.points) ? history.points : [])
    .map((point) => {
      const value = finite(point?.value);
      if (!Number.isFinite(point?.at) || value === null || value <= 0) return null;
      const low = finite(point?.low);
      const high = finite(point?.high);
      return Object.freeze({
        at: point.at,
        dateLabel: point.dateLabel,
        value,
        low,
        high,
        historicalMedian: finite(point?.historicalMedian),
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
} = {}) {
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")) {
    throw new TypeError("A results card requires a minted reference.");
  }
  const isDemo = data?.mode === "demo";
  const pricing = data?.pricing ?? {};
  const fastMode = pricing.fastMode ?? {};
  // The share card's third figure is specifically the weekly reset fit. Do
  // not substitute the older general-gradient summary here: both are API-price
  // equivalents, but their evidence source and denominator are different.
  const summary = data?.weekly?.summary ?? {};

  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = shareCardWindowKind(allowanceWindow) === "seven_day";
  const remaining = finite(allowanceWindow?.remainingPercent);
  const windowLabel = shareCardWindowLabel(allowanceWindow);

  const weighted = finite(pricing.quotaWeightedTotalCostUsd);
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  const spend = useWeighted ? weighted : finite(pricing.totalCostUsd);
  const excluded = finite(fastMode.unweightedUnknownApiPriceEquivalentUsd, 0);
  const period = shareCardPeriodLabel(pricing.periodLabel);

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
      label: t("share.stat.recordedActivity"),
      value: spend === null ? t("share.value.notAvailable") : formatMoney(spend, 0),
      detail: spend === null
        ? t("share.detail.noPricedUsage")
        : t("share.detail.activityPeriod", { period }),
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
  if (excluded > 0) {
    caveats.push(t("share.caveat.unweighted", {
      amount: formatMoney(excluded, 2),
    }));
  }
  if (fastMode.weightingStatus === "unknown") {
    caveats.push(t("share.caveat.noWeighted"));
  } else if (fastMode.weightingStatus !== "complete") {
    caveats.push(t("share.caveat.fastPartial"));
  }
  const coverage = finite(pricing.coveragePercent);
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
    // The strongest claim on the card is the one a fixture must not borrow.
    // A demo card says so in the line under the title and in a mark beside the
    // wordmark, not only in the smallest copy on the image, because a reader
    // scrolling a timeline reads the title and the figures and nothing else.
    subtitle: isDemo
      ? t("share.subtitle.demo")
      : t("share.subtitle.local"),
    badge: isDemo ? t("share.badge.demo") : "",
    stats: Object.freeze(stats.map((stat) => Object.freeze({ ...stat }))),
    // Reset-fit history is an explicitly seven-day model. It is never drawn
    // behind a five-hour or provider-reported generic allowance window.
    trend,
    trendLabel: t("share.trend.label"),
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
    figures,
    shareCardTrendText(card),
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
  const padTop = 40;
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

function shareCardFileName(card) {
  // The reference is the only variable part, and it matched the fixed
  // reference pattern before the card was composed.
  return `tibotattle-results-${card.reference}.png`;
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
function renderShareCard(data, { history: sharedHistory = null } = {}) {
  const canvas = $("#share-card-canvas");
  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = shareCardWindowKind(allowanceWindow) === "seven_day";
  const history = isWeeklyWindow
    ? sharedHistory ?? allowanceHistoryChartModel(data)
    : null;
  const trend = isWeeklyWindow ? shareCardTrend(history) : null;
  const signature = JSON.stringify([
    data?.mode,
    shareCardWindowKind(allowanceWindow),
    finite(allowanceWindow?.durationMinutes),
    finite(allowanceWindow?.remainingPercent),
    finite(data?.pricing?.quotaWeightedTotalCostUsd),
    finite(data?.pricing?.totalCostUsd),
    finite(data?.pricing?.coveragePercent),
    data?.pricing?.fastMode?.weightingStatus ?? "",
    finite(data?.pricing?.fastMode?.unweightedUnknownApiPriceEquivalentUsd, 0),
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
  });
  // The header's reference chip is gone (owner-directed, 2026-08-08): the
  // reference still exists — the saved file name carries it — but the panel
  // header no longer prints a code the reader cannot act on.
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

function downloadShareCard() {
  return runShareCardAction(async (card) => {
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
    link.download = shareCardFileName(card);
    link.click();
    URL.revokeObjectURL(url);
    // The image no longer prints the reference (owner-directed, 2026-08-08),
    // so the claim moved with the fact: the file name carries it.
    const saved = `Saved as ${shareCardFileName(card)}. The file name carries reference ${card.reference}.`;
    // Reveal is native-only: the shell tracks where the download landed and
    // shows it in Finder itself, so the page never learns a filesystem path.
    // In a plain browser the button is absent rather than disabled.
    const bridge = document.body.classList.contains("native-dashboard")
      ? window.webkit?.messageHandlers?.tibotattleDownloads
      : undefined;
    showShareCardToast(saved, bridge ? {
      actionLabel: t("shareCard.showInFinder"),
      onAction: () => bridge.postMessage({ type: "reveal-latest-download" }),
    } : {});
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
    const blob = await shareCardBlob($("#share-card-canvas"));
    if (blob === null) {
      setShareCardStatus(
        "TiboTattle could not turn the card into a PNG. Nothing was copied.",
        { error: true },
      );
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      // A stale error from an earlier attempt would otherwise sit under the
      // fresh confirmation.
      setShareCardStatus("");
      showShareCardToast(
        `Copied. Paste it anywhere; reference ${card.reference} identifies these figures.`,
      );
    } catch {
      setShareCardStatus(
        "The browser refused clipboard access, so nothing was copied. Use Save image instead.",
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
  const latest = data.timeline.usage.at(-1)?.endAt
    ?? mainWeeklyQuotaTrack(data.timeline.quota).at(-1)?.observedAt
    ?? data.freshness.latestObservedAt;
  const latestMs = Date.parse(latest);
  return Number.isFinite(latestMs) ? latestMs : null;
}

function timelineCutoffMs(data, rangeDays) {
  const latestMs = latestTimelineObservationMs(data);
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
  write: (value) => { timelineViewport = value; },
  render: () => scheduleTimelineRender(),
});

const USAGE_CHART_VIEWPORT = Object.freeze({
  read: () => usageTimelineViewport,
  write: (value) => { usageTimelineViewport = value; },
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
  unexplained_without_local_activity: "chart.status.unexplainedWithoutLocalActivity",
  missing_quota_bracket: "chart.status.missingQuotaBracket",
  reset_or_track_change: "chart.status.resetOrTrackChange",
  backward_or_ambiguous: "chart.status.backwardOrAmbiguous",
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
  return rows.flatMap(({ point, at: current }, index) => {
    if (!point.status || point.status === "matched" || point.status === "inactive") return [];
    const previous = index === 0 ? viewport.startMs : rows[index - 1].at;
    const next = index === rows.length - 1 ? viewport.endMs : rows[index + 1].at;
    return [{
      status: point.status,
      startMs: Math.max(viewport.startMs, (previous + current) / 2),
      endMs: Math.min(viewport.endMs, (current + next) / 2),
    }];
  });
}

function mainWeeklyQuotaTrack(rows) {
  const weeklyCodex = rows.filter(isPrimaryCodexWeeklyQuotaWindow);
  if (!weeklyCodex.length) return [];
  const primary = weeklyCodex.filter((row) => row.slot === "primary");
  if (primary.length) return primary;
  const bySlot = new Map();
  for (const row of weeklyCodex) {
    const slot = row.slot ?? "unknown";
    const group = bySlot.get(slot) ?? [];
    group.push(row);
    bySlot.set(slot, group);
  }
  return [...bySlot.entries()]
    .sort((left, right) => (
      right[1].length - left[1].length
      || left[0].localeCompare(right[0])
    ))[0]?.[1] ?? [];
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

function liveTimelinePoints(
  data,
  {
    windowHours = CALIBRATION_WINDOW_HOURS,
    rangeDays = activeCalibrationRangeDays,
  } = {},
) {
  const usage = data.timeline.usage;
  const capacity = finite(
    data.weekly.summary?.median_weekly_value_usd
      ?? data.gradient.summary?.capacity_usd
  );
  if (!usage.length) return [];
  const windowMs = windowHours * 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, rangeDays);
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  const points = [];
  let startIndex = 0;
  let rollingCost = 0;
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
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    rollingCost += current.apiPriceEquivalentUsd;
    rollingEvents += current.usageEvents;
    driftCostUsd += current.apiPriceEquivalentUsd;
    while (startIndex <= index
        && Date.parse(usage[startIndex].endAt) <= endMs - windowMs) {
      rollingCost -= usage[startIndex].apiPriceEquivalentUsd;
      rollingEvents -= usage[startIndex].usageEvents;
      startIndex += 1;
    }
    if (endMs < cutoff) continue;
    const startMs = endMs - windowMs;
    const beforeMatch = quotaLookup.atOrBefore(startMs);
    const afterMatch = quotaLookup.atOrBefore(endMs);
    const before = beforeMatch?.row ?? null;
    const after = afterMatch?.row ?? null;
    const maximumBracketGapMs = Math.max(30 * 60 * 1_000, windowMs);
    const bracketed = before && after
      && startMs - beforeMatch.timestampMs <= maximumBracketGapMs
      && endMs - afterMatch.timestampMs <= maximumBracketGapMs;
    const sameReset = Boolean(bracketed)
      && sameResetBoundary(before.resetAt, after.resetAt);
    const observed = sameReset && after.usedPercent >= before.usedPercent
      ? after.usedPercent - before.usedPercent
      : null;
    const expected = capacity !== null && capacity > 0
      ? rollingCost / capacity * 100
      : null;
    const evidence = classifyTimelineEvidence({
      bracketed,
      sameReset,
      observed,
      expected,
      usageEvents: rollingEvents,
      apiCostUsd: rollingCost,
    });
    let cumulativeResidual = null;
    // A re-anchor marks the first drift observation of a new reset or track:
    // the deviation-period detector splits its runs here, so a sustained drift
    // that crosses a boundary is never read as one continuous period across the
    // reset. Stamped on the point so the flag survives viewport filtering.
    let driftReanchor = false;
    if (capacity !== null && capacity > 0
        && after !== null
        && Number.isFinite(finite(after.usedPercent))
        && endMs - afterMatch.timestampMs <= maximumBracketGapMs) {
      if (driftAnchor === null
          || !sameResetBoundary(driftAnchor.resetAt, after.resetAt)) {
        // A boundary or track change re-anchors the accumulation: drift is
        // zero by definition at the first observation of a new reset.
        driftAnchor = { resetAt: after.resetAt, usedPercent: after.usedPercent };
        driftCostUsd = 0;
        cumulativeResidual = 0;
        driftReanchor = true;
      } else {
        cumulativeResidual = after.usedPercent - driftAnchor.usedPercent
          - driftCostUsd / capacity * 100;
      }
    }
    points.push({
      timestamp: current.endAt,
      timestampMs: endMs,
      observed,
      expected,
      residual: evidence.residual,
      cumulativeResidual,
      driftReanchor,
      apiCostUsd: Math.max(0, rollingCost),
      usageEvents: Math.max(0, rollingEvents),
      status: evidence.status,
    });
  }
  return points;
}

function groupedUsageTimeline(data) {
  const hourMs = 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, activeUsageRangeDays);
  const groups = new Map();
  for (const row of data.timeline.usage) {
    const timestamp = Date.parse(row.startAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
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
      apiCostUsd: 0,
      usageEvents: 0,
      totalTokens: 0
    };
    group.periodStartMs = Math.min(group.periodStartMs, rowStartMs);
    group.periodEndMs = Math.max(group.periodEndMs, rowEndMs);
    group.apiCostUsd += row.apiPriceEquivalentUsd;
    group.usageEvents += row.usageEvents;
    group.totalTokens += row.totalTokens;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.sortMs - right.sortMs)
    .map(({ sortMs: _sortMs, periodStartMs, periodEndMs, ...row }) => ({
      ...row,
      timestamp: new Date(periodEndMs).toISOString(),
      timestampMs: periodEndMs,
      periodStartAt: new Date(periodStartMs).toISOString(),
      periodEndAt: new Date(periodEndMs).toISOString(),
      apiCostUsd: Number(row.apiCostUsd.toFixed(6))
    }));
}

function usagePointsWithAllowance(data, points) {
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  const maximumObservationAgeMs = {
    hour: 6 * 60 * 60 * 1_000,
    day: 12 * 60 * 60 * 1_000,
    week: 24 * 60 * 60 * 1_000
  }[activeUsageGrouping] ?? 6 * 60 * 60 * 1_000;
  return points.map((point) => {
    const endMs = Date.parse(point.periodEndAt ?? point.timestamp);
    const observationMatch = quotaLookup.atOrBefore(endMs);
    const observationAge = observationMatch
      ? endMs - observationMatch.timestampMs
      : Number.POSITIVE_INFINITY;
    return {
      ...point,
      allowanceRemaining: observationAge <= maximumObservationAgeMs
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

function usageChartAxisLabels(grouping = activeUsageGrouping) {
  return Object.freeze({
    primary: {
      key: USAGE_GROUPING_AXIS_KEYS[grouping] ?? "chart.axis.apiEquivalentPerInterval",
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
  if (usageSeriesMemo !== null
      && usageSeriesMemo.data === data
      && usageSeriesMemo.grouping === activeUsageGrouping
      && usageSeriesMemo.rangeDays === activeUsageRangeDays) {
    return usageSeriesMemo.points;
  }
  const points = usagePointsWithAllowance(data, groupedUsageTimeline(data));
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
    return;
  }
  if (usageRenderFrame !== 0) return;
  usageRenderFrame = requestAnimationFrame(() => {
    usageRenderFrame = 0;
    if (dashboard) renderUsageTimeline(dashboard);
  });
}

function resetUsageTimelineViewport() {
  usageTimelineViewport = null;
}

function renderUsageTimeline(data) {
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
  const axisLabels = usageChartAxisLabels();
  setLocalizedText($("#usage-timeline-title"), "chart.usage.heading", {
    unit,
    range: tPlural("format.durationDay", activeUsageRangeDays, {
      count: formatDecimal(activeUsageRangeDays, 0),
    }),
  });
  if (!visiblePoints.length) {
    shell.hidden = true;
    empty.hidden = false;
  } else {
    shell.hidden = false;
    empty.hidden = true;
    drawChart(shell, lineChart({
      points: visiblePoints,
      series: [{
        key: "apiCostUsd",
        className: "chart-line-value",
        label: { key: "chart.series.apiEquivalentUsage" },
        // Dense per-interval samples: dots would merge into a solid band, so
        // the line carries the shape and each sample stays hoverable. This is
        // the opposite of the allowance history chart, on purpose.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: (value) => formatApiMoney(value),
      }],
      yLabel: axisLabels.primary,
      secondarySeries: [{
        key: "allowanceRemaining",
        className: "chart-line-allowance",
        label: { key: "chart.series.sevenDayAllowanceRemaining" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
      }],
      secondaryYLabel: axisLabels.secondary,
      yTickFormat: (value) => formatApiMoney(value),
      title: { key: "chart.usage.title" },
      description: {
        key: "chart.usage.description",
        values: { unit, timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: TIMELINE_CHART_HEIGHT,
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
  const total = visiblePoints.reduce((sum, row) => sum + row.apiCostUsd, 0);
  for (const [name, explanation, value] of [
    [
      "Time intervals",
      "The number of displayed hour, day, or week intervals.",
      compact(visiblePoints.length)
    ],
    [
      "API-price equivalent",
      "A public API-price measuring stick for the local usage observed here, not a bill.",
      formatApiMoney(total)
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
  const livePoints = liveTimelinePoints(data);
  const cutoff = timelineCutoffMs(data, activeCalibrationRangeDays);
  const historicalPoints = groupRolling(
    [...data.gradient.rollingHistory, ...data.gradient.rolling],
    CALIBRATION_WINDOW_HOURS,
  ).filter((row) => pointTimestampMs(row) >= cutoff);
  const liveMatched = livePoints.filter(
    (row) => row.observed !== null && row.expected !== null,
  ).length;
  const usingLive = liveMatched > 0 || historicalPoints.length === 0;
  const selection = { points: usingLive ? livePoints : historicalPoints, usingLive };
  timelineSeriesMemo = {
    data,
    rangeDays: activeCalibrationRangeDays,
    selection,
  };
  return selection;
}

function renderTimeline(data) {
  const { points, usingLive } = selectedTimelinePoints(data);
  const viewport = normalizeTimelineViewport(points);
  const visiblePoints = timelinePointsInViewport(points, viewport);
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
    ? t("dashboard.timeline.liveCopy", { timeZone: formatTimeZoneLabel() })
    : t("dashboard.timeline.historicalCopy", {
      generatedAt: formatLocal(data.artifactStatus.gradient.generatedAt),
      window: windowLabel,
    });
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  if (!visiblePoints.length || (usingLive && matchedVisible.length === 0)) {
    shell.hidden = true;
    empty.hidden = false;
    empty.querySelector("strong").textContent = visiblePoints.length
      ? t("dashboard.timeline.notComparableYet")
      : tPlural("dashboard.timeline.series", 0, { window: windowLabel });
    empty.querySelector("p").textContent = visiblePoints.length
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
          pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
          format: formatPp,
        },
        {
          key: "expected",
          className: "chart-line-expected",
          label: { key: "dashboard.timeline.expectedCost" },
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
      height: TIMELINE_CHART_HEIGHT,
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
    }));
    bindTimelineInteractions(shell, points, viewport);
  }
  renderSeriesCoverage(
    $("#timeline-coverage"),
    data,
    activeCalibrationRangeDays,
  );
  renderTimelineSummary(data, visiblePoints);
  renderTimelineConfidence(points, visiblePoints, usingLive, viewport);
  renderResiduals(data, visiblePoints, viewport);
  // The divergence panel reads the whole selected calibration range, not the
  // zoomed viewport: it answers "across this range, where did observed and
  // priced usage persistently disagree", so pan and zoom must not reshape it.
  renderDivergencePeriods(data, points);
}

function renderTimelineConfidence(allPoints, visiblePoints, usingLive, viewport) {
  const element = $("#timeline-confidence");
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
      excluded: tPlural("dashboard.timeline.excludedWindow", excluded),
    });
  } else if (excluded > 0) {
    setLocalizedText(element, "dashboard.timeline.excludedShown", {
      shown: tPlural("dashboard.timeline.shownWindow", matched),
      excluded: tPlural("dashboard.timeline.excludedWindow", excluded),
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
    const elapsedHours =
      (pointTimestampMs(current) - pointTimestampMs(prior)) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    area += elapsedHours
      * ((prior.observed - prior.expected) + (current.observed - current.expected))
      / 2;
  }
  return area;
}

// A signed pp·hours figure keeps its sign visible: "+" is printed explicitly
// because the sign IS the finding — which side of the cost-implied line the
// observed movement accumulated on.
function formatSignedPpHours(value) {
  const number = finite(value);
  if (number === null) return "—";
  return t("format.ppHours", {
    value: `${number < 0 ? "" : "+"}${formatDecimal(number, 1)}`,
  });
}

// A signed percentage-point figure, same convention as the pp·hours reading:
// the "+" or "−" is which side of the cost-implied line the drift sits on.
function formatSignedPp(value) {
  const number = finite(value);
  if (number === null) return "—";
  return `${number < 0 ? "" : "+"}${formatPp(number)}`;
}

function renderTimelineSummary(data, points) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === CALIBRATION_WINDOW_HOURS);
  const activePoints = points.filter((row) => row.status !== "inactive");
  const matched = activePoints.filter((row) => row.observed !== null && row.expected !== null);
  const live = points.some((row) => Object.hasOwn(row, "status"));
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
  const values = [
    [
      "Matched windows",
      "Windows with both observed quota movement and a comparable cost-implied movement.",
      compact(matched.length),
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
  if (!computed.length) {
    empty.hidden = false;
    shell.hidden = true;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    drawChart(shell, lineChart({
      points: residuals,
      series: [{
        key: "residual",
        className: "chart-line-value",
        label: { key: "chart.residual.series" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: formatPp,
      }, {
        // The designed cumulative view (owner-directed, 2026-08-08): the
        // running sum of per-bucket observed-minus-expected movement,
        // re-anchored at each reset boundary or track change — computed in
        // liveTimelinePoints beside the evidence it reads. Live points only:
        // the historical artifact view carries no per-window reset
        // annotations, so its rows have no such key and this series simply
        // draws nothing there instead of inventing anchors.
        key: "cumulativeResidual",
        className: "chart-line-expected",
        label: { key: "chart.residual.cumulativeSeries" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: formatPp,
      }],
      yLabel: { key: "dashboard.timeline.percentagePoints" },
      title: { key: "chart.residual.title" },
      description: {
        key: "chart.residual.description",
        values: { timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: COMPACT_CHART_HEIGHT,
      xDomain: domain,
      statusIntervals: domain === null
        ? []
        : timelineStatusIntervals(residuals, domain),
    }));
  }
  renderResidualCoverage(residuals, computed);
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
    row.append(
      node("td", "", formatChartTimestamp(item.timestamp)),
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? t("residual.table.notComparable") : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      node("td", "", timelineStatusLabel(item.status ?? "matched")),
    );
    table.append(row);
  }
  if (!pagination) return;
  pagination.hidden = false;
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
// One id per rendered divergence period, so each period's expandable breakdown
// panel has a stable target for its toggle's `aria-controls`.
let nextDivergenceBreakdownId = 0;

function divergenceRangeContext(data) {
  const accounting = accountingPeriod(data);
  if (!accounting) return null;
  const models = modelUsageRows(accounting);
  const topModel = models.find((row) => !modelRowIsSeparateAllowance(row))
    ?? models[0]
    ?? null;
  const modelLabel = topModel === null ? null
    : topModel.model === "unknown" || topModel.pricingStatus === "unrecognized"
      ? t("accounting.model.unrecognized")
      : formatModelName(topModel.model) || topModel.model;
  const bySpeed = accounting.bySpeed ?? {};
  const rankedSpeed = ["fast", "standard", "unknown"]
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
function divergencePeriodItem(period, rangeContext) {
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
      ? "divergence.underCosted"
      : "divergence.overCosted",
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

  item.append(header, finding, magnitude, mix);

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

  let loadState = "idle";
  const loadBreakdown = async () => {
    if (loadState === "loaded" || loadState === "loading") return;
    loadState = "loading";
    clear(panel);
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-status",
      "divergence.breakdown.loading",
    ));
    let breakdown = null;
    try {
      breakdown = await localClient.windowBreakdown(period.startMs, period.endMs);
    } catch {
      breakdown = null;
    }
    loadState = "loaded";
    renderDivergenceBreakdown(panel, breakdown, rangeContext);
  };
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    setLocalizedText(
      toggle,
      open ? "divergence.breakdown.show" : "divergence.breakdown.hide",
    );
    panel.hidden = open;
    if (!open) loadBreakdown();
  });

  item.append(toggle, panel);
  return item;
}

// The window's own repriced contributor mix, or a clearly-marked fallback. The
// per-model and per-speed rows are the true per-period evidence the endpoint
// exists to supply; an unavailable breakdown falls back to the range-level
// context rather than pretending this window had none.
function divergenceModelLabel(model) {
  if (model === "unknown") return t("accounting.model.unrecognized");
  return formatModelName(model) || model;
}

function renderDivergenceBreakdown(panel, breakdown, rangeContext) {
  clear(panel);
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

  const speedEntries = Object.values(breakdown.bySpeed)
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
  if (breakdown.unpricedShare > 0) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-unpriced",
      "divergence.breakdown.unpriced",
      { share: formatPercent(breakdown.unpricedShare * 100, 1) },
    ));
  }
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
  if (!list || !empty || !summary) return;
  clear(list);

  const result = detectDeviationPeriods(points, {
    usageBuckets: data?.timeline?.usage ?? [],
  });

  if (!result.periods.length) {
    list.hidden = true;
    summary.hidden = true;
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
    setLocalizedText(caveat, "divergence.methodCaveat");
  }
  if (result.truncated) {
    setLocalizedText(summary, "divergence.truncated", {
      shown: formatNumber(result.periods.length),
      total: formatNumber(result.totalFound),
    });
    // No silent truncation: the cap is a display bound, and the full count is
    // both stated above and recorded here.
    console.info(
      `[divergence] ${result.totalFound} periods detected; showing the `
        + `${result.periods.length} widest.`,
    );
  } else {
    setLocalizedPluralText(summary, "divergence.count", result.totalFound, {
      count: formatNumber(result.totalFound),
    });
  }

  const rangeContext = divergenceRangeContext(data);
  for (const period of result.periods) {
    list.append(divergencePeriodItem(period, rangeContext));
  }
}

// A tick label's resolution follows the span the axis actually covers, so
// every tick on one axis has the same compact shape instead of each one
// carrying a full date and time.
const CHART_TICK_TIME_ONLY_SPAN_MS = 36 * 60 * 60 * 1_000;
const CHART_TICK_MONTH_ONLY_SPAN_MS = 365 * 24 * 60 * 60 * 1_000;

// The three tick shapes, hoisted so each one is a stable object rather than a
// literal rebuilt per call, and one live formatter per (locale, shape).
// `formatChartTimeLabel` runs once per tick and per rendered frame; building an
// `Intl.DateTimeFormat` for each half of each label was a measurable share of
// the pan and zoom cost, and nothing about the formatter depends on the instant
// being formatted. Keying on the live formatting locale means a language change
// needs no invalidation — it simply misses the cache once per shape.
const CHART_TICK_SHAPES = Object.freeze({
  day: Object.freeze({ month: "short", day: "numeric" }),
  clock: Object.freeze({ hour: "numeric", minute: "2-digit" }),
  month: Object.freeze({ month: "short", year: "numeric" }),
});

const chartTickFormatters = new Map();

function chartTickFormatter(shape) {
  const locale = getFormattingLocale();
  const key = `${locale} ${shape}`;
  const cached = chartTickFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: USER_TIME_ZONE,
    ...CHART_TICK_SHAPES[shape],
  });
  chartTickFormatters.set(key, formatter);
  return formatter;
}

/**
 * The one axis-tick label formatter.
 *
 * Two properties are deliberate and both were reported as defects:
 *
 * 1. No tick carries a time-zone name. A chart states its zone exactly once,
 *    in its caption, through `formatTimeZoneLabel()` — which reads
 *    `Intl.DateTimeFormat().resolvedOptions().timeZone`, so it is correct for
 *    whatever zone the reader's Mac is in and is never assumed. Repeating a
 *    short name ("EDT") on ticks while the caption said a long generic name
 *    ("Eastern Time") stated the same fact two different ways.
 *
 * 2. The date and time halves are formatted independently and joined with a
 *    separator chosen here. Asking one `Intl.DateTimeFormat` for both halves
 *    delegates the join to ICU, and WebKit's ICU supplies a localized
 *    connective — "Jan 5 at 3:04 PM" — that Node's ICU does not, so no Node
 *    test can see it. Composing the halves removes that glue by construction
 *    rather than by rewriting a string after the fact.
 */
function formatChartTimeLabel(value, { dateOnly = false, spanMs = null } = {}) {
  const timestamp = value instanceof Date
    ? value.valueOf()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("format.unknown");
  const span = finite(spanMs);
  const resolution = dateOnly ? "date"
    : span === null ? "dateAndTime"
      : span <= CHART_TICK_TIME_ONLY_SPAN_MS ? "time"
        : span <= CHART_TICK_MONTH_ONLY_SPAN_MS ? "date"
          : "month";
  try {
    const instant = new Date(timestamp);
    const part = (shape) => chartTickFormatter(shape).format(instant);
    if (resolution === "time") return part("clock");
    if (resolution === "month") return part("month");
    if (resolution === "date") return part("day");
    return `${part("day")} · ${part("clock")}`;
  } catch {
    return formatChartTimestamp(new Date(timestamp).toISOString(), { dateOnly });
  }
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
function drawChart(shell, chart) {
  for (const previous of shell.children ?? []) {
    previous.chartTickDensityObserver?.disconnect();
  }
  shell.replaceChildren(chart);
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
  const width = 900;
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

  const tooltipWidth = 330;
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
    tooltipHeading.textContent = heading.slice(0, 72);
    tooltipDetail.textContent = detail.slice(0, 86);
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
    const start = margin.left + (interval.startMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
    const end = margin.left + (interval.endMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(Math.max(margin.left, start)));
    rect.setAttribute("y", String(margin.top));
    rect.setAttribute("width", String(Math.max(1, Math.min(width - margin.right, end) - Math.max(margin.left, start))));
    rect.setAttribute("height", String(height - margin.top - margin.bottom));
    rect.setAttribute("class", `chart-status-${interval.status === "reset_or_track_change" ? "reset" : interval.status === "missing_quota_bracket" ? "missing" : "ambiguous"}`);
    const intervalTitle = document.createElementNS(svg.namespaceURI, "title");
    setRawText(
      intervalTitle,
      chartText({ key: timelineStatusKey(interval.status) }, "status interval"),
    );
    rect.append(intervalTitle);
    svg.append(rect);
  }

  for (const item of chartSeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
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
        const detail = [
          item.detail ? chartText(item.detail(point), "series detail") : null,
          timestamp ? formatChartTimestamp(timestamp) : null,
        ].filter(Boolean).join(" · ");
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
  const latestObservedAt = allPoints.at(-1)?.at ?? null;
  const validRangeDays = Number.isFinite(rangeDays) && rangeDays > 0 ? rangeDays : null;
  const boundedRangeDays = validRangeDays !== null
    && validRangeDays < ALL_HISTORY_RANGE_DAYS
    ? validRangeDays
    : null;
  const cutoffAt = latestObservedAt === null || validRangeDays === null
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
  const inRange = allPoints.filter((point) => point.at >= cutoffAt);
  const points = inRange.filter((point) => (
    spanFloorPp === 0
      || (point.observedSpanPp !== null
        && point.observedSpanPp >= spanFloorPp)
  ));
  const axis = allowanceHistoryAxis(points);
  return Object.freeze({
    allPoints: Object.freeze(allPoints),
    points: Object.freeze(points),
    axis,
    xTicks: allowanceHistoryDateTicks(points),
    // The population facts the sentences around this model state: the corpus
    // size, how many fits fall in the selected range, the span floor that was
    // actually applied, the bounded range (null for "All"), and the newest
    // fit the range is anchored at.
    totalCount: allPoints.length,
    inRangeCount: inRange.length,
    spanFloorPp,
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

function renderAllowanceHistoryChart(history) {
  return lineChart({
    points: history.points,
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
    yLabel: { key: "chart.axis.apiEquivalentPerSevenDays" },
    title: { key: "weekly.chart.title" },
    description: {
      key: "weekly.chart.description",
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

function ensureWeeklyPaceForecastCard() {
  const hero = $(".weekly-hero");
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

function weeklyPaceDirection(percentagePointsPerHour, baseline = null) {
  const pace = finite(percentagePointsPerHour);
  const steady = firstFiniteForecastNumber(
    baseline,
    // A seven-day allowance paced evenly across its full window is the only
    // baseline this card can derive without inventing a user schedule.
    100 / (CODEX_WEEKLY_ALLOWANCE_MINUTES / 60),
  );
  if (pace === null || steady === null || steady <= 0) return null;
  if (pace > steady * 1.1) return "Recent pace is ahead of a steady weekly pace.";
  if (pace < steady * .9) return "Recent pace is behind a steady weekly pace.";
  return "Recent pace is close to a steady weekly pace.";
}

function renderWeeklyPaceForecast(data) {
  const card = ensureWeeklyPaceForecastCard();
  if (!card) return;
  card.hidden = true;
  card.className = "weekly-pace-forecast";
  card.removeAttribute("aria-labelledby");
  clear(card);

  const forecast = data?.weekly?.paceForecast;
  if (!forecast || typeof forecast !== "object" || Array.isArray(forecast)) return;
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
  if (resetAt === null || resetAt <= now) return;

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

  const percentagePointsPerHour = firstFiniteForecastNumber(
    pace.percentagePointsPerHour,
    pace.percentPerHour,
    pace.pacePercentPerHour,
    forecast.percentagePointsPerHour,
    forecast.pacePercentPerHour,
    forecast.pacePpPerHour,
  );
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
    || (status === "" && etaAt !== null && percentagePointsPerHour !== null);
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
  if (available && (etaAt === null || etaAt <= now || etaAt > resetAt)) return;
  if (!available && !reachesResetFirst && !collectingEvidence) return;
  if (collectingEvidence && remaining === null) return;
  if (!collectingEvidence
      && remaining === null
      && percentagePointsPerHour === null
      && !reachesResetFirst) return;

  const title = node("h3", "weekly-pace-forecast-title");
  const cardId = "weekly-pace-forecast-title";
  title.id = cardId;
  title.textContent = collectingEvidence
    ? "Pace estimate ready after one more refresh"
    : reachesResetFirst
      ? "At the recent pace, the weekly allowance should last to reset"
      : etaAt === null
        ? "At this pace: weekly allowance exhaustion is approaching"
        : `At this pace: reaches weekly allowance ${formatReportingTime(etaAt)}`;
  card.setAttribute("aria-labelledby", cardId);

  const heading = node("div", "weekly-pace-forecast-heading");
  heading.append(
    node(
      "p",
      "panel-kicker",
      collectingEvidence ? "Collecting forecast evidence" : "Forecast from recent pace",
    ),
    node(
      "span",
      collectingEvidence
        ? "evidence-chip weekly-pace-forecast-collecting-chip"
        : earlyEstimate
          ? "evidence-chip weekly-pace-forecast-early-chip"
          : "evidence-chip",
      collectingEvidence ? "One more refresh" : earlyEstimate ? "Early estimate" : "Observed pace",
    ),
  );

  const direction = weeklyPaceDirection(
    percentagePointsPerHour,
    firstFiniteForecastNumber(
      pace.steadyPercentagePointsPerHour,
      forecast.steadyPercentagePointsPerHour,
    ),
  );
  const copy = node("p", "weekly-pace-forecast-copy");
  copy.textContent = collectingEvidence
    ? "One clean weekly allowance observation is saved. The next fresh observation for this account and reset will establish its pace."
    : earlyEstimate
      ? "This is an early estimate from a small amount of recent evidence; it will settle as more observations arrive."
      : direction ?? (reachesResetFirst
        ? "Recent allowance movement is not fast enough to exhaust this window before its reset."
        : "The estimate uses the latest clean allowance observations.");

  const metrics = node("div", "weekly-pace-forecast-metrics");
  if (remaining !== null) {
    metrics.append(
      node("div", "weekly-pace-forecast-metric", "Allowance left"),
    );
    const item = metrics.lastElementChild;
    item.replaceChildren(
      node("span", "", "Allowance left"),
      node("strong", "", formatPercent(remaining)),
    );
  }
  const resetDuration = formatForecastDuration(hoursToReset);
  if (resetDuration) {
    metrics.append(
      node("div", "weekly-pace-forecast-metric"),
    );
    const item = metrics.lastElementChild;
    item.append(
      node("span", "", "Reset"),
      node("strong", "", `in ${resetDuration}`),
    );
  }
  if (collectingEvidence) {
    metrics.append(
      node("div", "weekly-pace-forecast-metric"),
    );
    const item = metrics.lastElementChild;
    item.append(
      node("span", "", "Evidence"),
      node("strong", "", "1 saved"),
    );
  } else if (percentagePointsPerHour !== null && percentagePointsPerHour > 0) {
    metrics.append(
      node("div", "weekly-pace-forecast-metric"),
    );
    const item = metrics.lastElementChild;
    item.append(
      node("span", "", "Recent pace"),
      node("strong", "", `${formatDecimal(percentagePointsPerHour, 1)} pp/hour`),
    );
  }

  const observationDuration = formatForecastDuration(paceElapsedHours);
  const evidence = observations !== null && observations >= 1
    ? node(
      "p",
      "weekly-pace-forecast-evidence",
      collectingEvidence
        ? "One fresh allowance observation is saved for this weekly reset."
        : `Based on ${Math.round(observations)} recent allowance observation${Math.round(observations) === 1 ? "" : "s"}${observationDuration ? ` over ${observationDuration}` : ""}.`,
    )
    : null;
  card.className = [
    "weekly-pace-forecast",
    collectingEvidence
      ? "is-insufficient"
      : reachesResetFirst
        ? "is-reset-first"
        : "is-available",
    earlyEstimate ? "is-early-estimate" : "",
  ].filter(Boolean).join(" ");
  card.append(heading, title, copy, metrics);
  if (evidence) card.append(evidence);
  card.hidden = false;
}

function renderWeekly(data) {
  renderWeeklyPaceForecast(data);
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
  setLocalizedText($("#weekly-estimate-label"), "weekly.headline.label");
  $("#weekly-estimate").textContent = estimate === null
    ? t("weekly.headline.insufficient")
    : t("weekly.headline.value", { amount: formatMoney(estimate) });
  $("#weekly-range").textContent = lower === null || upper === null
    ? t("weekly.headline.rangeUnavailable")
    : t("weekly.headline.range", {
      lower: formatMoney(lower),
      upper: formatMoney(upper),
    });
  $("#weekly-explanation").textContent = qualifying
    ? t("weekly.headline.relationship", {
      qualifying: formatDecimal(qualifying, 0),
      shown: formatDecimal(chartValues.length, 0),
      total: formatDecimal(values.length, 0),
      // The floor the model actually applied — a short range relaxes it —
      // and the newest fit the range is anchored at, so "7d" reads as seven
      // days back from that fit rather than from today (estimator audit,
      // 2026-08-08).
      span: spanFloorSentenceLabel(history.spanFloorPp),
      anchor: history.anchorAt === null
        ? "—"
        : shareCardDateLabel(history.anchorAt),
    })
    : t("weekly.headline.pending");

  setLocalizedText($("#weekly-chart-timezone"), "chart.timeZoneNote", {
    timeZone: formatTimeZoneLabel(),
  });
  $("#weekly-span-value").textContent = weeklySpanLabel();
  $("#weekly-span-legend").textContent = chartText(weeklyObservedSeriesLabel());
  $("#weekly-partial-legend").hidden = !chartValues.some((row) => !row.wellObserved);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!chartValues.length) {
    empty.hidden = false;
    shell.hidden = true;
    // An empty chart names its reason instead of the generic sentence: either
    // no fits fall in the selected range at all, or fits are in range and the
    // span floor filtered every one of them (estimator audit, 2026-08-08).
    if (values.length === 0) {
      setLocalizedText(empty, "weekly.chart.empty");
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
    shell.replaceChildren(renderAllowanceHistoryChart(history));
  }
  renderWeeklyTable(values);
  // The chart renderer owns the card re-render (owner-verified regression,
  // 2026-08-08). The old wiring re-rendered the card only where a caller
  // remembered to, so a path that redrew the chart without the extra call
  // left the card describing the previous filters. Every path that renders
  // the allowance history — the range buttons, the span slider, a dashboard
  // load, a locale change — now redraws the card from the SAME model
  // instance, so the two surfaces cannot disagree.
  renderShareCard(data, { history });
}

function renderWeeklyTable(values) {
  const table = $("#weekly-table");
  clear(table);
  if (!values.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", t("weekly.table.empty"));
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const row of values.slice(-14).reverse()) {
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
}

function accountingPeriod(data) {
  const periods = Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : [];
  const selected = periods.find(
    (period) => period?.periodId === activeAccountingPeriod,
  );
  if (!selected) return null;
  return {
    ...data.accounting,
    ...selected,
    replayExclusionDiagnostics: data.accounting.replayExclusionDiagnostics,
    accountingSource: data.accounting.accountingSource,
  };
}

function syncAccountingPeriodControls(data) {
  const controls = $("#accounting-period-controls");
  if (!controls) return;
  const periods = Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : [];
  const available = new Set(
    periods
      .map((period) => period?.periodId)
      .filter((periodId) => typeof periodId === "string" && periodId !== ""),
  );
  if (!available.has(activeAccountingPeriod)) {
    activeAccountingPeriod = selectAvailableAccountingPeriod(periods, activeAccountingPeriod);
  }
  for (const control of controls.querySelectorAll("button")) {
    const periodId = control.dataset.period;
    const present = available.has(periodId);
    // The indexed-history option is a capability, not a promise made by the
    // static page. If the payload does not carry it, keep the control out of
    // the UI rather than making the 31-day cache look like full history.
    control.hidden = periodId === "history" && !present;
    control.disabled = !present;
    control.setAttribute("aria-disabled", String(!present));
    const active = present && periodId === activeAccountingPeriod;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
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

function renderAccounting(data) {
  syncAccountingPeriodControls(data);
  const accounting = accountingPeriod(data);
  if (accounting === null) {
    clear($("#accounting-summary"));
    clear($("#accounting-component-counts"));
    clear($("#accounting-component-costs"));
    clear($("#accounting-models"));
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
  const weighted = accounting.quotaWeightedApiPriceEquivalentUsd;
  for (const [label, explanation, value, note] of [
    [
      fastMode.metricShortLabel,
      "A public API-price measuring stick for the usage observed locally. It is not a bill or a subscription limit.",
      weighted === null ? "—" : formatApiMoney(weighted),
      weighted === null
        ? "No increment in this period could be weighted"
        : `${formatApiMoney(accounting.apiPriceEquivalentUsd)} at Standard rates before Fast weighting`
    ],
    [
      "Tokens",
      "The tokens attached to those usage changes during the selected time period.",
      compact(accounting.totalTokens),
      accounting.periodLabel
    ]
  ]) {
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

  const componentCountRows = Object.entries(accounting.components ?? {})
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, tokens }))
    .sort((left, right) => right.tokens - left.tokens);
  renderAccountingComponentBars("#accounting-component-counts", componentCountRows, {
    emptyMessage: "No token-component accounting in this period.",
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
    emptyMessage: "No component costs were priced in this period.",
    valueFor: (row) => row.costUsd,
    displayValue: (row) => row.costUsd > 0
      ? formatApiMoney(row.costUsd)
      : "—",
    titleFor: (row) => `${compact(row.tokens)} tokens`,
  });

  renderAccountingModels(accounting);
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
function modelApiEquivalentCell(row) {
  const cell = node("td", "model-api-equivalent");
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
    cell.title = t("accounting.model.notPricedUnknownTitle");
    return cell;
  }
  const amount = finite(row?.apiPriceEquivalentUsd);
  if (amount === null || amount < 0) {
    setLocalizedText(cell, "accounting.model.notReported");
    cell.title = t("accounting.model.notReportedTitle");
    return cell;
  }
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
    return t("accounting.pricing.coverageReviewed");
  }
  const priced = finite(accounting?.pricingCoverage?.fullyPricedEvents, 0)
    + finite(accounting?.pricingCoverage?.partiallyPricedEvents, 0);
  return t("accounting.pricing.partialCoverage", {
    percent: formatPercent(priced / events * 100, 1),
  });
}

function renderAccountingModels(accounting) {
  const models = $("#accounting-models");
  if (!models) return;
  clear(models);
  const coverage = $("#accounting-price-coverage");
  if (coverage) {
    const note = pricingCoverageNote(accounting);
    setRawText(coverage, note ?? "");
    coverage.hidden = note === null;
  }
  const modelRows = modelUsageRows(accounting);
  if (!modelRows.length) {
    const row = node("tr");
    const cell = localizedNode("td", "empty-cell", "accounting.model.noneInPeriod");
    cell.colSpan = 4;
    row.append(cell);
    models.append(row);
    return;
  }
  for (const model of modelRows) {
    const row = node("tr");
    const identity = node("td", "model-identity");
    // "Unrecognized model" now means exactly one thing: an identifier this
    // build has never reviewed, so it is withheld rather than printed.
    if (model.model === "unknown" || model.pricingStatus === "unrecognized") {
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
    row.append(
      identity,
      rawNode("td", "numeric-cell", formatCount(model.events)),
      rawNode("td", "numeric-cell", formatCount(model.totalTokens)),
      modelApiEquivalentCell(model),
    );
    models.append(row);
  }
}

function fastModeCoverageSentence(fastMode) {
  const coverage = fastMode.coverage;
  if (coverage.totalEvents === 0) {
    return t("accounting.fastMode.noUsage");
  }
  const parts = [
    t("accounting.fastMode.observed", {
      count: compact(coverage.observedEvents),
    }),
    t("accounting.fastMode.stated", {
      count: compact(coverage.assumedFromPreferenceEvents),
    }),
    t("accounting.fastMode.inferred", {
      count: compact(coverage.inferredEvents),
    }),
    t("accounting.fastMode.unknown", {
      count: compact(coverage.unknownEvents),
    })
  ];
  const share = coverage.unknownSharePercent === null
    ? ""
    : t("accounting.fastMode.unknownShare", {
      percent: formatPercent(coverage.unknownSharePercent, 1),
    });
  const unweighted = fastMode.unweightedUnknownApiPriceEquivalentUsd > 0
    ? t("accounting.fastMode.unweighted", {
      amount: formatApiMoney(fastMode.unweightedUnknownApiPriceEquivalentUsd),
    })
    : "";
  return t("accounting.fastMode.coverage", {
    total: compact(coverage.totalEvents),
    parts: parts.join(", "),
    share,
    unweighted,
  });
}

function fastModeInferenceSentence(fastMode) {
  const inference = fastMode.inference;
  if (inference.status !== "inferred") {
    return t("accounting.fastMode.inferenceNotRun");
  }
  if (inference.inferredFastWindows === 0) {
    return t("accounting.fastMode.inferenceNone", {
      scored: compact(inference.scoredWindowCount),
      reference: compact(inference.referenceWindowCount),
    });
  }
  return t("accounting.fastMode.inferenceSome", {
    fast: compact(inference.inferredFastWindows),
    scored: compact(inference.scoredWindowCount),
    reference: compact(inference.referenceWindowCount),
  });
}

function renderFastModePreference() {
  const controls = $("#fast-mode-preference-controls");
  const coverage = $("#fast-mode-coverage");
  if (!controls || !coverage) return;
  const accounting = dashboard === null ? null : accountingPeriod(dashboard);
  const stated = fastModePreference?.mode
    ?? accounting?.fastMode?.preference
    ?? "standard";
  for (const control of controls.querySelectorAll("[data-fast-mode]")) {
    const active = control.dataset.fastMode === stated;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
    control.disabled = fastModePreferenceBusy;
  }
  if (accounting === null) {
    setProductText(coverage, "Awaiting local evidence.");
    return;
  }
  coverage.textContent = [
    fastModeCoverageSentence(accounting.fastMode),
    fastModeInferenceSentence(accounting.fastMode),
  ].join(" ");
}

async function selectFastModePreference(mode) {
  if (fastModePreferenceBusy) return;
  const status = $("#fast-mode-preference-status");
  fastModePreferenceBusy = true;
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Saving your Codex speed mode…";
  renderFastModePreference();
  try {
    fastModePreference = await localClient.selectFastModePreference(mode);
    status.textContent = fastModePreference.mode === "mixed_unknown"
      ? "Saved. Increments with an observed tier keep it; the rest stay unknown unless residual inference can label their calibration window."
      : `Saved. Increments with an observed tier keep it; the rest are now weighted as ${fastModePreference.mode === "fast" ? "Fast" : "Standard"}.`;
    await refreshDashboardAfterFastModeChange();
  } catch (error) {
    await showFailure(status, {
      surface: "fast_mode_preference",
      error,
      fallback:
        "Your Codex speed mode could not be saved. Nothing was assumed; check the local companion and try again."
    });
  } finally {
    fastModePreferenceBusy = false;
    renderFastModePreference();
  }
}

function renderContributionSyncStatus(status) {
  const value = status ?? {
    state: "unavailable",
    paused: null,
    counts: {},
  };
  contributionSyncStatus = value;
  renderContributionActionState();
}

// The legacy "Prepare and review a contribution" surface is gone
// (owner-directed, 2026-08-08): the prepared-set queue no longer renders its
// own card. The queue still matters — it is the review bootstrap behind the
// approve-once surface and the evidence of a previously accepted upload — so
// its state is stored and the consent surface re-renders from it.
function renderContributionSyncPreview(preview) {
  const value = preview ?? {
    status: "unavailable",
    state: "unavailable",
    item: null
  };
  contributionSyncPreview = value;
  renderContributionActionState();
  maybeReviewPreparedSummary();
}

// Whether this build is paired with a hosted contribution service at all. A
// build without one has nothing to sign into or connect to, and — with the
// approve-once surface as the only contribution flow — nothing to approve.
function contributionServiceConfigured() {
  return localCompanionHealth?.capabilities?.contributionDevicePairing === true;
}

/**
 * Whether this page can honestly claim this Mac holds upload authority. Only
 * two measured facts support that claim: the pairing ceremony completed in
 * this session, or the local queue records a previously accepted upload —
 * which only a paired device can produce. Anything less is a guess, and a
 * guess here is exactly what produced "connecting fails anyway -> no send".
 */
function communityUploadAuthorityEvidence() {
  return communityDevicePaired
    || finite(contributionSyncStatus?.counts?.accepted, 0) > 0
    || Boolean(contributionSyncStatus?.lastAcceptedAt);
}

// (communityAuthorizationSatisfied left with the two-card flow, owner-directed
// 2026-08-08: the review bootstrap is purely local and no longer waits for
// pairing, and the single ceremony performs the pairing itself.)

// One re-render entry point for everything the contribution state feeds now
// that the legacy send card is gone: the approve-once surface and the
// journey strip. It also gives the silent authorization repair its chance —
// the repair is guarded to run at most once per page load.
function renderContributionActionState() {
  renderIncrementalConsent();
  renderCommunityJourney();
  maybeRepairIncrementalAuthorization();
}

// The approve-once surface's own status line. It inherits the role the old
// #sync-action-status played for the send card: verification progress, and
// each failure with its quotable reference.
function showIncrementalReviewStatus(message, error = false) {
  const status = $("#incremental-consent-status");
  if (!status) return;
  status.hidden = false;
  // A direct write over a node the keyed variant may have registered.
  forgetLocalizedNode(status);
  status.textContent = message;
  status.classList.toggle("error", error);
}

function showIncrementalReviewStatusKey(key, values = {}) {
  const status = $("#incremental-consent-status");
  if (!status) return;
  status.hidden = false;
  status.classList.remove("error");
  setLocalizedText(status, key, values);
}

function clearContributionSyncExactReview() {
  contributionSyncExactReview = null;
}

function renderContributionSyncExactReview(value) {
  if (value?.schemaVersion !== "contribution-sync-exact-review-v0.1"
      || value.status !== "available"
      || value.state !== "ready"
      || value.networkActivity !== false
      || value.includesExactRetainedFields !== true
      || value.includesRawContent !== false
      || value.includesPaths !== false
      || value.includesDirectIdentifiers !== false
      || value.includesCredentials !== false
      || !/^[A-Za-z0-9_-]{43}$/u.test(value.reviewToken ?? "")
      || !Number.isSafeInteger(value.payloadBytes)
      || value.payloadBytes < 1
      || value.payloadBytes > 1_310_720) {
    throw new Error("The exact local review response was not usable.");
  }
  validateContributionForUpload(value.payload);
  contributionSyncExactReview = {
    state: value.state,
    payloadBytes: value.payloadBytes,
    reviewToken: value.reviewToken,
  };
}

async function refreshContributionSyncControls() {
  clearContributionSyncExactReview();
  // Preview discovery commits newly prepared sets to the queue. Read queue
  // status afterwards so the two cards describe the same durable state.
  const preview = await localClient.contributionSyncPreview();
  const status = await localClient.contributionSyncStatus();
  renderContributionSyncStatus(status);
  renderContributionSyncPreview(preview);
}

// The manual "Send summary" action is gone with the prepare-and-review
// surface (owner-directed, 2026-08-08). After the approve-once consent, the
// companion's incremental engine uploads by itself; the page only reflects
// that engine's bounded status line.

/**
 * A stable identity for the currently prepared set, from its own printed
 * facts. It exists so the page verifies each prepared set exactly once by
 * itself; a verification that failed is retried only by an explicit action.
 */
function preparedSummaryIdentity() {
  const item = contributionSyncPreview?.item;
  if (!item) return null;
  return [
    item.coveredAt?.startAt,
    item.coveredAt?.endAt,
    item.preparedBytes,
    item.recordCounts?.total,
  ].join("|");
}

/**
 * The invisible review bootstrap behind the approve-once surface.
 *
 * The approve gate keeps the review-bootstrap requirement — one verified
 * real instance of the covered data on screen before approval can be given —
 * but the owner removed every user-facing preparation step with the legacy
 * prepare flow (2026-08-08). So the page produces that instance itself: a
 * ready prepared set verifies itself exactly as before, and an empty queue
 * triggers one silent local preparation whose result then verifies itself.
 * The token gate is unchanged — Approve stays disabled until the exact local
 * verification succeeds, and the approval carries the minted token.
 */
function maybeReviewPreparedSummary() {
  if (contributionSyncBusy || incrementalConsentBusy) return;
  // The token feeds only the approve-once consent now, so nothing prepares
  // or verifies on a build without the capability or after approval.
  if (!incrementalSyncCapabilityAdvertised() || incrementalConsentApproved) return;
  // The bootstrap no longer waits for pairing (owner-directed 2026-08-08,
  // one-step flow): pairing now happens INSIDE the single Review-and-approve
  // interaction, so the facts must already be on screen when that interaction
  // begins. The bootstrap is purely local — prepare and verify on this Mac,
  // no network — and the minted token still only ever feeds the explicit
  // approval.
  if (contributionSyncPreview?.status !== "available") return;
  if (contributionSyncPreview.state !== "ready"
      || contributionSyncPreview.item == null) {
    maybePrepareIncrementalReviewInstance();
    return;
  }
  if (contributionSyncExactReview?.state === "ready") return;
  const key = preparedSummaryIdentity();
  if (key === null || key === contributionSyncAutoReviewedKey) return;
  contributionSyncAutoReviewedKey = key;
  void reviewPreparedSummary({ refreshFirst: false });
}

/**
 * One silent preparation per queue state, and only when the queue is truly
 * empty: retry-wait, paused, and not-configured states are real conditions
 * that a fresh preparation would not change. A failed attempt never loops;
 * "Check again" on the approve card is the explicit retry.
 */
function maybePrepareIncrementalReviewInstance() {
  if (contributionSyncPreview?.state !== "empty") return;
  if (incrementalReviewPrepareAttempted) return;
  incrementalReviewPrepareAttempted = true;
  void prepareIncrementalReviewInstance();
}

async function prepareIncrementalReviewInstance() {
  if (contributionSyncBusy) return;
  contributionSyncBusy = true;
  const retry = $("#incremental-review-retry");
  if (retry) retry.hidden = true;
  renderContributionActionState();
  showIncrementalReviewStatusKey("consent.preparingReview");
  clearContributionSyncExactReview();
  // A fresh preparation may reproduce byte-identical facts; it must still
  // verify itself again, so the once-per-set marker is cleared with the token.
  contributionSyncAutoReviewedKey = null;
  let preparedCommitted = false;
  try {
    let prepared;
    try {
      prepared = await localClient.prepareContribution({ lookbackHours: 24 });
    } catch (error) {
      // A very active day can exceed the fixed reviewed-set safety bound at
      // 24 hours. The lookback was only ever a size guard — never a consent
      // decision — so the bootstrap narrows to the latest hour by itself
      // instead of surfacing a window picker the owner removed.
      if (error?.code !== "export_too_large") throw error;
      prepared = await localClient.prepareContribution({ lookbackHours: 1 });
    }
    if (prepared.status !== "prepared") {
      const error = new Error("Preparation did not return a verified contribution.");
      error.code = "preparation_failed";
      throw error;
    }
    // The busy flag this preparation holds makes the refresh's automatic
    // verification pass bail out, so the pass is re-run explicitly below
    // once the flag is released.
    await refreshContributionSyncControls();
    preparedCommitted = true;
  } catch (error) {
    if (retry) retry.hidden = false;
    showIncrementalReviewStatus((await describeFailure({
      surface: "contribution_prepare",
      error,
      messages: INCREMENTAL_PREPARATION_ERROR_COPY,
      fallback:
        "A privacy-verified instance of the covered data could not be prepared. No upload occurred and incomplete staging is ignored by the queue."
    })).text, true);
  } finally {
    contributionSyncBusy = false;
    renderContributionActionState();
  }
  if (preparedCommitted) maybeReviewPreparedSummary();
}

// Fixed sentences for the silent preparation's own failure codes. They speak
// on the approve card, so each names the reader's actual next action there.
const INCREMENTAL_PREPARATION_ERROR_COPY = {
  identity_unavailable:
    "The local Keychain identity is unavailable. Open Keychain Access, select the login Keychain, unlock it, then choose Check again. Do not reset, delete, rotate, or broaden access to the identity. No upload occurred.",
  coverage_unavailable:
    "No usable local coverage is available yet. Analyze local usage first, then choose Check again. No upload occurred.",
  coverage_invalid:
    "The available local coverage is not usable for a contribution yet. No upload occurred.",
  no_safe_records:
    "No privacy-safe records were found in the recent local evidence. Analyze local usage again later. No upload occurred.",
  export_too_large:
    "Even the latest hour exceeded a fixed reviewed-set safety bound. Nothing was truncated or uploaded.",
  privacy_verification_failed:
    "Privacy verification rejected the prepared data, so it was not queued or uploaded.",
  preparation_in_progress:
    "A local preparation is already running. Nothing has been uploaded.",
  review_archive_invalid:
    "TiboTattle could not save the copy you would review, so nothing was queued and nothing was uploaded.",
  prepared_spool_invalid:
    "The place TiboTattle keeps a prepared instance on this Mac is not usable, so nothing was queued and nothing was uploaded.",
  preparation_failed:
    "A privacy-verified instance of the covered data could not be prepared. No upload occurred and incomplete staging is ignored by the queue.",
};

async function reviewPreparedSummary({ refreshFirst = true } = {}) {
  if (contributionSyncBusy) return;
  contributionSyncBusy = true;
  const retry = $("#incremental-review-retry");
  if (retry) retry.hidden = true;
  renderContributionActionState();
  showIncrementalReviewStatusKey("syncStatus.verifyingSummary");
  try {
    // Preview discovery commits newly prepared sets to the queue, so an
    // explicit re-check refreshes first; the automatic verification is
    // itself triggered by a fresh render and skips the redundant read.
    if (refreshFirst) await refreshContributionSyncControls();
    const review = await localClient.contributionSyncExactReview();
    renderContributionSyncExactReview(review);
    contributionSyncAutoReviewedKey = preparedSummaryIdentity();
    showIncrementalReviewStatusKey("syncStatus.summaryVerified");
  } catch (error) {
    // A bare `catch {}` discarded the only evidence of what actually failed
    // and printed one sentence for every cause. Surface the real one, and
    // offer the explicit re-check: automatic verification never retries a
    // failure by itself.
    if (retry) retry.hidden = false;
    showIncrementalReviewStatus((await describeFailure({
      surface: "contribution_prepare",
      error,
      fallback:
        "The prepared instance could not be verified on this Mac. Nothing was uploaded."
    })).text, true);
  } finally {
    contributionSyncBusy = false;
    renderContributionActionState();
  }
}

/**
 * The explicit retry behind "Check again": clear the once-only markers, then
 * re-read the queue. The render that follows re-runs the same automatic
 * bootstrap — verify a ready set, or prepare one silently when the queue is
 * empty — so recovery walks exactly the path the happy case walks.
 */
async function retryIncrementalReviewBootstrap() {
  if (contributionSyncBusy) return;
  incrementalReviewPrepareAttempted = false;
  contributionSyncAutoReviewedKey = null;
  const retry = $("#incremental-review-retry");
  if (retry) retry.hidden = true;
  await refreshContributionSyncControls();
}

/**
 * Stop only this installation's background upload capability. The hosted
 * contribution account/session remains intact: sign-out and metadata deletion
 * are separate controls with their own explicit confirmation.
 */
async function loadLocalDashboard() {
  const previousBusy = localActionBusy;
  localActionBusy = true;
  const button = $("#refresh-button");
  button.textContent = "Connecting…";
  updateLocalActionButtons();
  try {
    const syncState = (async () => {
      const [preview, status] = await Promise.all([
        localClient.contributionSyncPreview().catch(() => null),
        localClient.contributionSyncStatus().catch(() => null)
      ]);
      return { preview, status };
    })();
    const loadDashboardData = async () => {
      try {
        return await localClient.load();
      } catch (firstError) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        try {
          return await localClient.load();
        } catch {
          throw firstError;
        }
      }
    };
    const [data, sync, localHealth, onboarding, speedPreference] = await Promise.all([
      loadDashboardData(),
      syncState,
      localClient.health().catch(() => null),
      localClient.onboarding().catch(() => null),
      localClient.fastModePreference().catch(() => null)
    ]);
    localCompanionHealth = localHealth;
    fastModePreference = speedPreference;
    renderDashboard(data);
    // Health arrives after the first paint, and the sign-in controls are gated
    // on a capability it carries. Without this re-render they keep the
    // disabled state bootstrap gave them when the capability was still unknown.
    renderHostedIdentity();
    renderContributionSyncStatus(sync.status);
    // Consent state is read from the companion before the queue renders, so
    // an already-approved Mac never re-prepares a review instance it no
    // longer needs.
    await loadIncrementalSyncStatus();
    renderContributionSyncPreview(sync.preview);
    renderLocalOnboarding(onboarding);
  } catch {
    const [localHealth, onboarding] = await Promise.all([
      localClient.health().catch(() => null),
      localClient.onboarding().catch(() => null),
    ]);
    localCompanionHealth = localHealth;
    dashboard = null;
    renderHostedIdentity();
    renderContributionSyncStatus(null);
    await loadIncrementalSyncStatus();
    renderContributionSyncPreview(null);
    renderLocalOnboarding(onboarding);
    renderDashboardUnavailableState(
      localHealth ? "dashboard-unavailable" : "companion-unavailable",
    );
  } finally {
    localActionBusy = previousBusy;
    updateLocalActionButtons();
  }
}

// The "preparation identity" Keychain notice left with the prepare surface it
// annotated (owner-directed, 2026-08-08). The one case that still matters —
// the login Keychain is unreachable, so the silent review bootstrap will
// fail — speaks through that bootstrap's own identity_unavailable sentence
// on the approve card.

function renderDashboardSkeleton() {
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
  const data = await localClient.load();
  renderDashboard(data);
  if (localOnboarding) renderLocalOnboarding(localOnboarding);
}

/**
 * The accounting projection is derived from the stated speed mode, so the
 * overview is re-read after it changes. A failed re-read leaves the previous
 * numbers on screen rather than blanking them.
 */
async function refreshDashboardAfterFastModeChange() {
  try {
    renderDashboard(await localClient.load());
  } catch {
    renderFastModePreference();
  }
}

/**
 * True when the local history index has discovered more sources than it has
 * indexed — a one-time build or a parser-version reparse is still catching up.
 * Reads the same coverage the top-bar badge uses; demo mode is never pending.
 */
function historyIndexIncomplete() {
  if (!dashboard || dashboard.mode === "demo") return false;
  const history = dashboard?.pricing?.historyCoverage
    ?? dashboard?.accounting?.historyCoverage
    ?? null;
  const indexed = finite(history?.indexedSourceCount, null);
  const total = finite(history?.sourceCount, null);
  if (history?.status === "complete") return false;
  return indexed !== null && total !== null && total > 0 && indexed < total;
}

/**
 * After a successful refresh that left the history index incomplete, run the
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
  if (!historyIndexIncomplete()) {
    reindexAutoContinuations = 0;
    return;
  }
  if (reindexAutoContinuations >= REINDEX_AUTO_CONTINUE_LIMIT) return;
  reindexAutoContinueTimer = setTimeout(() => {
    reindexAutoContinueTimer = null;
    if (localActionBusy || !historyIndexIncomplete()) {
      reindexAutoContinuations = 0;
      return;
    }
    reindexAutoContinuations += 1;
    void requestRefresh({ autoContinue: true });
  }, REINDEX_AUTO_CONTINUE_DELAY_MS);
}

async function requestRefresh({ autoContinue = false } = {}) {
  if (localActionBusy) return;
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
  let refreshAccepted = false;
  let cancelled = false;
  let quickResultLoaded = false;
  let continuationLimitReached = false;
  localActionBusy = true;
  localRefreshInProgress = true;
  localRefreshCancelRequested = false;
  archiveHistoryScanActive = false;
  button.textContent = "Starting local analysis…";
  updateLocalActionButtons();
  setGlobalState("updating");
  try {
    await localClient.refresh();
    refreshAccepted = true;
    let activePassStartedMs = Date.now();
    const pollingBudget = createRefreshPollingBudget();
    let consecutiveStatusFailures = 0;
    let outcome = "running";
    let finalErrorCode = null;
    let finalFailedStep = null;
    let finalFailureCode = null;
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
        button.textContent = "Update running; reconnecting…";
        if (consecutiveStatusFailures >= 8) throw error;
        continue;
      }
      const refresh = status?.refresh ?? {};
      outcome = refresh.status ?? "failed";
      finalErrorCode = refresh.errorCode ?? null;
      finalFailedStep = refresh.failedStep ?? finalFailedStep;
      finalFailureCode = refresh.failureCode ?? finalFailureCode;
      const progress = refresh.progress ?? refresh.result?.indexing ?? null;
      const archiveScanning = progress?.kind === "archive_index";
      if (archiveScanning && !archiveHistoryScanActive) {
        archiveHistoryScanActive = true;
        if (dashboard) renderPricing(dashboard);
      }
      if (progress?.phase === "quick_result" && !quickResultLoaded) {
        try {
          await loadQuickResultDashboard();
          quickResultLoaded = true;
        } catch {
          // Keep polling. The verified quick snapshot can still be loaded when
          // deep accounting finishes, and no partial replacement is invented.
        }
      }
      const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - activePassStartedMs) / 1_000),
      );
      const elapsedLabel = elapsedSeconds >= 60
        ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
        : `${elapsedSeconds}s`;
      const processed = Number.isSafeInteger(progress?.filesProcessed)
        ? progress.filesProcessed : null;
      const selected = Number.isSafeInteger(progress?.filesSelected)
        ? progress.filesSelected : null;
      button.textContent = outcome === "cancelling"
        ? "Stopping safely…"
        : archiveScanning
          ? `Indexing archive history… ${elapsedLabel}`
        : progress?.phase === "quick_result"
          ? `Headline ready; finishing deeper accounting… ${elapsedLabel}`
        : processed !== null && selected !== null
        ? selected > 0 && processed >= selected
          ? `Calculating usage and allowance… ${elapsedLabel}`
          : `Analyzing ${processed}/${selected} files…`
        : pollCount < 3 ? "Analyzing local evidence…" : `Analyzing… ${elapsedLabel}`;
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
          await localClient.refresh();
          pollingBudget.noteContinuation();
          activePassStartedMs = Date.now();
          timeoutSettlementNoted = false;
          button.textContent = "Continuing local analysis…";
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
        button.textContent = "Finalizing bounded pause…";
        if (!timeoutSettlementNoted) {
          pollingBudget.noteSettling();
          timeoutSettlementNoted = true;
        }
        outcome = "running";
      }
    }
    cancelled = outcome === "cancelled";
    if (cancelled) {
      button.textContent = "Loading saved results…";
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
      button.textContent = "Loading saved results…";
      await loadLocalDashboard();
      showConnectionNotice({
        title: "This scan paused to protect your Mac",
        copy: "Your last verified results are still shown. This unusually large history reached TiboTattle’s fixed local safety limit, so it paused before exceeding it. No partial result replaced your existing results, and nothing left this Mac.",
        kind: "warning",
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
    button.textContent = "Loading updated evidence…";
    await loadLocalDashboard();
    scheduleReindexAutoContinuation();
  } catch (error) {
    if (dashboard) {
      setGlobalState(dashboard.state, {
        companionReachable: dashboard.mode !== "demo",
      });
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
    const wasArchiveScanning = archiveHistoryScanActive;
    archiveHistoryScanActive = false;
    if (wasArchiveScanning && dashboard) renderPricing(dashboard);
    localActionBusy = false;
    localRefreshInProgress = false;
    localRefreshCancelRequested = false;
    updateLocalActionButtons();
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

function scheduleReturningUserRefresh() {
  // The native macOS shell owns the foreground cadence. Running both the web
  // return-visit timer and the native timer races the same bounded companion
  // request, which can surface a harmless 409 as a confusing dashboard error.
  // What the shell owes in return is a signal when its refresh finished, which
  // `tibotattle:local-evidence-updated` carries.
  if (runsInsideNativeDashboard()) return;
  const priorEvidence = dashboard?.mode !== "demo"
    && Boolean(
      dashboard?.activity?.lastScanAt
      || dashboard?.collector?.lastScanAt
      || dashboard?.freshness?.latestObservedAt
    );
  if (returnRefreshScheduled
      || !priorEvidence
      || !localAnalysisAllowed()
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

const HOSTED_IDENTITY_ERROR_COPY = {
  IDENTITY_REQUIRED:
    "Hosted participation requires sign-in. Sign in with Google or Apple above, then try again. Nothing was uploaded.",
  IDENTITY_TOKEN_INVALID:
    "The sign-in was cancelled or could not be completed. Nothing was uploaded. You can try again.",
  IDENTITY_CONFIGURATION_INVALID:
    "Hosted sign-in is not configured on the contribution service, so hosted actions are unavailable. Local reporting continues unchanged.",
  IDENTITY_PROVIDER_UNAVAILABLE:
    "The sign-in provider could not be reached by the contribution service. Try again shortly. Nothing was uploaded."
};

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

function hostedIdentityErrorCopy(error) {
  return fixedCopy(HOSTED_IDENTITY_ERROR_COPY, error?.code);
}

const CONTRIBUTION_DEVICE_CONFLICT_COPY =
  "This Mac still holds a contribution-device credential from an earlier install, and the local record that paired it is gone, so it cannot be used or replaced. Nothing was uploaded and nothing was changed. Clear the leftover credential below, then connect again.";

// Fixed contribution-service codes this page knows how to explain. The
// service's own codes are never rendered; each one is answered with a sentence
// written here, and anything unrecognized falls back to the caller's copy.
const SERVICE_ERROR_COPY = {
  ...HOSTED_IDENTITY_ERROR_COPY,
  AUTH_REQUIRED:
    "The contribution service did not recognize this app's contribution session. Reopen TiboTattle, then try again. Nothing was uploaded.",
  AUTH_INVALID:
    "The contribution service rejected this app's contribution session. Reopen TiboTattle, then sign in again. Nothing was uploaded.",
  CSRF_INVALID:
    "This app's contribution session expired while the request was in flight. Reopen TiboTattle, then try again. Nothing was uploaded.",
  BODY_INVALID:
    "TiboTattle and the contribution service did not agree on this connection request. Nothing was uploaded; install the current signed build, then sign in again.",
  CONTENT_TYPE_INVALID:
    "The contribution service rejected this connection request before processing it. Nothing was uploaded; install the current signed build, then sign in again.",
  NOT_FOUND:
    "This build points to a contribution-service route that is unavailable. Nothing was uploaded; install the current signed build before trying again.",
  ATTEMPT_LIMIT_REACHED:
    "Too many attempts were made in a short window. Wait a few minutes before trying again. Nothing was uploaded.",
  ADMISSION_CONFIGURATION_INVALID:
    "The contribution service is not ready to accept uploads. Nothing was uploaded; try again shortly.",
  UPLOAD_ADMISSION_LIMIT_REACHED:
    "Too many upload authorizations were requested in a short window. Wait a minute before trying again. Nothing was uploaded.",
  UPLOAD_INGRESS_LIMIT_REACHED:
    "The contribution service is temporarily busy. Wait for the stated retry time before trying again. Nothing was uploaded.",
  UPLOAD_INGRESS_UNAVAILABLE:
    "The contribution service cannot admit uploads right now. Nothing was uploaded; try again shortly.",
  BACKEND_STORAGE_UNAVAILABLE:
    "The contribution service could not reach its own storage. Nothing was uploaded; try again shortly.",
  COLLECTION_CONTROL_UNAVAILABLE:
    "The contribution service could not report whether it is accepting evidence. Nothing was uploaded; try again shortly.",
  COLLECTION_ENROLLMENT_DISABLED:
    "The contribution service has paused new enrollment. Nothing was uploaded, and local reporting is unaffected.",
  ENROLLMENT_DISABLED:
    "The contribution service is not accepting new participants right now. Nothing was uploaded, and local reporting is unaffected.",
  CONTRIBUTION_LIMIT_REACHED:
    "This participant has used its community batch allowance for the current window. Nothing was uploaded; the allowance renews on its fixed schedule.",
  CONTRIBUTION_DELETE_CONFLICT:
    "A deletion for this contribution is already in progress. Wait for it to finish, then check the history again.",
  PARTICIPANT_DELETING:
    "A deletion is still running for this participant. Wait for it to finish, then try again. Nothing was uploaded.",
  DEVICE_AUTH_INVALID:
    "The contribution service did not accept this Mac's upload device. Nothing was uploaded; review the contribution again before retrying.",
  DEVICE_NOT_FOUND:
    "The contribution service has no record of this Mac as an upload device. Connect this Mac again. Nothing was uploaded.",
  PAIRING_AUTH_INVALID:
    "The pairing this page presented was not accepted. Nothing was uploaded; start the connection again.",
  UPLOAD_AUTH_INVALID:
    "The one-use upload authorization was not accepted. Nothing was uploaded; prepare and review the contribution again.",
  UPLOAD_IN_PROGRESS:
    "Another upload for this participant is already in flight. Wait for it to finish, then try again.",
  UPLOAD_REGISTRATION_DISABLED:
    "The contribution service has paused new uploads. Nothing was uploaded, and local reporting is unaffected.",
  PROCESSING_DISABLED:
    "The contribution service has paused ingestion. Nothing was uploaded, and local reporting is unaffected.",
  PUBLICATION_DISABLED:
    "The contribution service has paused community publication, so no newer snapshot can appear yet.",
  PRIVACY_CANARY_DETECTED:
    "The contribution service found a content marker in the upload and rejected it. Nothing was stored; this is a defect worth reporting.",
  DECRYPTION_FAILED:
    "The contribution service could not decrypt this upload. Nothing was stored; prepare and review the contribution again.",
  ENVELOPE_INVALID:
    "The contribution service rejected the encrypted envelope's shape. Nothing was stored; prepare and review the contribution again.",
  TELEMETRY_RECORD_INVALID:
    "The contribution service rejected a record against its closed schema. Nothing was stored.",
  TELEMETRY_OCCURRENCE_CONFLICT:
    "The contribution service already holds a conflicting record for this interval. Nothing new was stored.",
  BODY_TOO_LARGE:
    "The request exceeded the service's fixed size bound. Nothing was uploaded; choose a shorter interval.",
  INTERNAL_ERROR:
    "The contribution service failed while handling this request. Nothing was uploaded; try again shortly.",
  // Codes the service can return that previously had no sentence here, so
  // every one of them produced "the cause was not reported in a form this page
  // can explain". Admin-only and updater-guard codes are deliberately absent:
  // this page cannot reach those routes.
  BODY_TIMEOUT:
    "The request to the contribution service did not finish in time. Nothing was uploaded; check your connection and try again.",
  METHOD_NOT_ALLOWED:
    "This build asked the contribution service for something it does not offer on that route. Nothing was uploaded; install the current signed build.",
  MAINTENANCE_IN_PROGRESS:
    "The contribution service is in maintenance. Nothing was uploaded, and local reporting is unaffected. Try again later.",
  MAINTENANCE_INCOMPLETE:
    "The contribution service has not finished its maintenance pass. Nothing was uploaded; try again shortly.",
  ADMISSION_RATE_LIMIT_UNAVAILABLE:
    "The contribution service could not check its own upload rate limits, so it declined rather than guessing. Nothing was uploaded; try again shortly.",
  DELETION_LEDGER_UNAVAILABLE:
    "The contribution service could not reach the record of deletions, so it declined rather than acting without it. Nothing was changed or uploaded.",
  IDENTITY_REQUIRED_FOR_UPLOAD:
    "Hosted participation requires sign-in before an upload. Sign in with Google or Apple above, then try again. Nothing was uploaded.",
  IDENTITY_REENROLLMENT_COOLDOWN:
    "This sign-in enrolled recently and is inside a fixed cooldown before it can enroll again. Nothing was uploaded; wait and try again.",
  IDENTITY_RESULT_PENDING:
    "The sign-in has not finished in the browser window yet. Complete it there, then choose Check sign-in. Nothing was uploaded.",
  SIGN_IN_START_LIMIT_REACHED:
    "Too many sign-ins were started in a short window. Wait a few minutes before trying again. Nothing was uploaded.",
  INVITE_GRANT_INVALID:
    "The contribution service did not accept this build's enrollment request. Nothing was uploaded; install the current signed build, then sign in again.",
  KEY_CONFIGURATION_INVALID:
    "The contribution service has no usable upload key configured, so it cannot accept encrypted evidence. Nothing was uploaded; try again later.",
  KEY_ID_INVALID:
    "The upload key this build used is not one the contribution service recognizes. Nothing was uploaded; install the current signed build.",
  LIFECYCLE_BOUNDS_EXCEEDED:
    "The request went beyond a fixed safety bound in the contribution service. Nothing was uploaded; choose a shorter interval.",
  LIFECYCLE_STATE_CONFLICT:
    "The contribution service is in a different state than this page expected. Nothing was uploaded; reload TiboTattle and try again.",
  TELEMETRY_REQUIRED:
    "The contribution service expected privacy-safe evidence and did not receive any. Nothing was uploaded; prepare and review a contribution first.",
  SYNTHETIC_REQUIRED:
    "That route accepts only test evidence, and this is real evidence. Nothing was uploaded; this is a defect worth reporting.",
  SYNTHETIC_RECORD_INVALID:
    "The contribution service rejected a test record against its closed schema. Nothing was stored.",
  ACCOUNT_SCOPED_LOCAL_ONLY:
    "This build keeps account-scoped evidence on your Mac and does not send it. Nothing was uploaded, and local reporting is unaffected.",
  ACCOUNT_SCOPED_INGEST_DISABLED:
    "The contribution service is not accepting account-scoped evidence right now. Nothing was uploaded, and local reporting is unaffected.",
  ACCOUNT_SCOPED_CONFIGURATION_INVALID:
    "The contribution service is not configured to handle account-scoped evidence. Nothing was uploaded; try again later."
};

// Fixed local companion codes. These describe this Mac, not the service, so
// they must never send the user looking at the network or the invitation.
const LOCAL_COMPANION_ERROR_COPY = {
  central_participant_request_not_authorized:
    "The local dashboard request was not accepted by this Mac. Reload TiboTattle, then sign in again. Nothing was uploaded.",
  central_participant_relay_not_configured:
    "This build is not configured to connect to a contribution service, so there is nothing to pair with. Local reporting is unaffected.",
  central_participant_service_unavailable:
    "TiboTattle could not reach the contribution service. Nothing was uploaded; check your connection and try again.",
  central_participant_response_invalid:
    "The contribution service returned an unexpected response. Nothing was uploaded; try again shortly.",
  central_participant_response_too_large:
    "The contribution service returned more data than TiboTattle accepts for a connection. Nothing was uploaded; try again shortly.",
  contribution_device_pairing_not_authorized:
    "The local companion refused this pairing request because it did not come from the local dashboard. Nothing was uploaded; reload TiboTattle and try again.",
  contribution_device_pairing_response_invalid:
    "The local companion returned an invalid pairing result. Nothing was uploaded; reload TiboTattle and try again.",
  contribution_device_pairing_not_configured:
    "This build is not configured to connect to a contribution service, so there is nothing to pair with. Local reporting is unaffected.",
  contribution_device_pairing_failed:
    "The contribution service did not complete device pairing. Nothing was uploaded; try again shortly.",
  contribution_device_recovery_required: CONTRIBUTION_DEVICE_CONFLICT_COPY,
  contribution_device_credential_conflict: CONTRIBUTION_DEVICE_CONFLICT_COPY,
  unsupported_media_type:
    "The local companion rejected this request format. Nothing was uploaded; reload TiboTattle and try again.",
  request_too_large:
    "The local request exceeded the local safety bound. Nothing was uploaded; reload TiboTattle and try again.",
  invalid_json:
    "The local companion could not read this request. Nothing was uploaded; reload TiboTattle and try again.",
  invalid_request:
    "The local companion could not validate this request. Nothing was uploaded; reload TiboTattle and try again.",
  review_expired_or_changed:
    "The reviewed contribution changed or the review expired before sending. Nothing was uploaded; review it again.",
  sync_in_progress:
    "A contribution pass is already running. Wait for it to finish before starting another.",
  sync_not_configured:
    "This build has no contribution delivery configured, so there is nothing to send.",
  sync_failed:
    "The local companion could not complete the contribution pass. Anything not accepted stays queued locally.",
  refresh_in_progress:
    "A local analysis is already running. Wait for it to finish before starting another.",
  fast_mode_preference_unavailable:
    "The local companion could not read or write your Codex speed mode. No mode was assumed and the accounting is unchanged.",
  fast_mode_preference_invalid:
    "That Codex speed mode is not one this build accepts. Nothing was stored.",
  fast_mode_preference_not_authorized:
    "The local companion refused this request because it did not arrive from the local dashboard. Nothing was stored.",
  // Codes the local app can return that previously had no sentence here.
  // Everything below describes this Mac, so none of it sends the reader
  // looking at the network or at the contribution service.
  enrollment_response_invalid:
    "The contribution service replied in a shape TiboTattle does not accept, so no pseudonymous access was established. Nothing was uploaded; sign in again and retry.",
  device_credential_reset_failed:
    "The leftover device credential could not be cleared. Nothing was deleted on this Mac or in the service; try again, or reopen TiboTattle first.",
  device_credential_reset_not_authorized:
    "TiboTattle refused this reset because it did not come from the local dashboard. Nothing was deleted.",
  review_required_before_send:
    "The prepared summary has not been verified on this Mac yet, so sending is not offered. Wait for the summary card to finish checking, or choose Check summary again. Nothing was uploaded.",
  sync_unavailable:
    "TiboTattle could not run a delivery pass. Anything queued stays on this Mac and nothing was uploaded.",
  sync_not_authorized:
    "TiboTattle refused this send because it did not come from the local dashboard. Nothing was uploaded.",
  sync_control_not_authorized:
    "TiboTattle refused this change because it did not come from the local dashboard. Nothing was changed.",
  sync_control_failed:
    "TiboTattle could not change the delivery setting. The previous setting still applies and nothing was uploaded.",
  sync_preview_not_authorized:
    "TiboTattle refused to describe the queue because the request did not come from the local dashboard. Nothing was uploaded.",
  exact_review_not_authorized:
    "TiboTattle refused to open the exact local review because the request did not come from the local dashboard. Nothing was uploaded.",
  preparation_not_authorized:
    "TiboTattle refused to prepare a contribution because the request did not come from the local dashboard. Nothing was prepared or uploaded.",
  refresh_not_authorized:
    "TiboTattle refused to analyze local usage because the request did not come from the local dashboard. Nothing was changed.",
  refresh_cancel_not_authorized:
    "TiboTattle refused to cancel the analysis because the request did not come from the local dashboard. The analysis is still running.",
  refresh_not_running:
    "There is no local analysis running to cancel. Nothing was changed.",
  diagnostic_note_not_authorized:
    "TiboTattle refused to write a diagnostic note because the request did not come from the local dashboard. The reference above is still quotable.",
  diagnostic_note_not_recorded:
    "TiboTattle could not write the diagnostic note to its local log. The reference above is still quotable.",
  contribution_device_disconnect_not_authorized:
    "TiboTattle refused to disconnect this Mac because the request did not come from the local dashboard. This Mac is unchanged.",
  contribution_device_disconnect_not_configured:
    "This build has no contribution service configured, so there is no device to disconnect. Local reporting is unaffected.",
  contribution_device_disconnect_failed:
    "This Mac could not be disconnected. It may still be able to upload; try again, or reopen TiboTattle first.",
  contribution_device_disconnect_cleanup_pending:
    "This Mac stopped uploading, but clearing its local credential has not finished. Reopen TiboTattle and check again.",
  automatic_contribution_not_authorized:
    "TiboTattle refused this automatic contribution change because it did not come from the local dashboard. Nothing was changed.",
  automatic_contribution_not_configured:
    "This build has no automatic contribution to configure. Local reporting is unaffected.",
  automatic_contribution_first_review_required:
    "Automatic contribution cannot start until you have reviewed and sent one contribution by hand. Nothing was uploaded.",
  automatic_contribution_consent_binding_mismatch:
    "The stored automatic contribution consent no longer matches this build, so nothing runs automatically. Nothing was uploaded; consent again to resume.",
  automatic_contribution_settings_unavailable:
    "TiboTattle could not read the automatic contribution setting. Nothing runs automatically until it can, and nothing was uploaded.",
  automatic_contribution_bootstrap_persist_failed:
    "TiboTattle could not store the automatic contribution setting, so it stays off. Nothing was uploaded.",
  automatic_contribution_lock_release_failed:
    "A background contribution pass did not release its lock cleanly. Reopen TiboTattle before trying again; nothing was uploaded.",
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
  // The local relay that forwards a request to the contribution service. A
  // failure here means the request never left this Mac.
  central_service_not_configured:
    "This build is not configured to reach a contribution service, so the request never left this Mac. Local reporting is unaffected.",
  central_service_unavailable:
    "TiboTattle could not reach the contribution service. Nothing was uploaded; check your connection and try again.",
  central_request_not_authorized:
    "TiboTattle refused to forward this request because it did not come from the local dashboard. Nothing left this Mac.",
  central_request_invalid:
    "TiboTattle would not forward this request because it did not match what the relay accepts. Nothing left this Mac.",
  central_request_too_large:
    "The request exceeded the local relay's fixed size bound, so it was not forwarded. Nothing left this Mac.",
  central_route_not_allowed:
    "This build asked to reach a service route the local relay does not allow. Nothing left this Mac; install the current signed build.",
  central_method_not_allowed:
    "The local relay does not forward that action. Nothing left this Mac; install the current signed build.",
  central_content_type_invalid:
    "The local relay rejected this request's format before forwarding it. Nothing left this Mac.",
  // The participant-scoped relay, which also carries the browser session.
  central_participant_authorization_invalid:
    "TiboTattle did not accept the authorization on this participant request. Nothing was uploaded; reload TiboTattle and sign in again.",
  central_participant_cookie_invalid:
    "The contribution session stored for this app is not usable. Nothing was uploaded; sign in again.",
  central_participant_csrf_invalid:
    "The contribution session expired while the request was in flight. Nothing was uploaded; reload TiboTattle and try again.",
  central_participant_content_type_invalid:
    "TiboTattle rejected this participant request's format before forwarding it. Nothing was uploaded.",
  central_participant_request_invalid:
    "TiboTattle would not forward this participant request because it did not match what the relay accepts. Nothing was uploaded.",
  central_participant_request_too_large:
    "The participant request exceeded the local relay's fixed size bound, so it was not forwarded. Nothing was uploaded.",
  central_participant_route_not_allowed:
    "This build asked to reach a participant route the local relay does not allow. Nothing was uploaded; install the current signed build.",
  central_participant_method_not_allowed:
    "The local relay does not forward that participant action. Nothing was uploaded; install the current signed build."
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
  const explanation = fixedCopy(messages, code)
    ?? fixedCopy(SERVICE_ERROR_COPY, code)
    ?? fixedCopy(LOCAL_COMPANION_ERROR_COPY, code)
    ?? fallback;
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

/**
 * Report a failure into a status element, preserving the specific cause.
 */
async function showFailure(status, options) {
  const described = await describeFailure(options);
  status.hidden = false;
  status.className = `${options.statusClass ?? "participant-action-status"} error`;
  status.textContent = described.text;
  return described;
}

// Production builds carry a Google client id in the release-slot meta tag and
// require sign-in before hosted actions, mirroring the server's mandatory
// hosted identity. Development builds leave the slot empty: the Google button
// stays disabled with fixed copy, hosted Apple sign-in remains available
// whenever the service is configured for it, and the server stays the
// authority on whether identity is required.
function hasCommunitySession() {
  return typeof communitySession?.csrfToken === "string"
    && communitySession.csrfToken.length > 0;
}

function hostedEnrollmentIsPaused() {
  // Only the operator's collection-control incident brake closes the door
  // for everyone. A routine "disabled" enrollment mode pauses NEW sign-ups
  // at the service's enrollment write, while the sign-in ceremony stays open
  // so an existing contributor can reattach - the service decides which one
  // this identity is.
  if (hasCommunitySession()) return false;
  const controls = communityServiceHealth?.collectionControls;
  return controls != null
    && controls.state !== "operational"
    && controls.enrollment === false;
}

function hostedNewEnrollmentIsPaused() {
  // Informational, never a lockout: new sign-ups are paused, but signing in
  // still reconnects an existing contributor.
  return communityServiceHealth?.enrollmentMode === "disabled";
}

function hostedSignInRequired() {
  return configuredGoogleClientId() !== null
    && hostedIdentity === null
    && !hasCommunitySession()
    && !hostedEnrollmentIsPaused();
}

// The provider is the only identity fact this page ever holds. No name, email,
// or picture is requested, so the signed-in row can show nothing more.
const HOSTED_IDENTITY_PROVIDERS = {
  google: {
    label: "Signed in with Google",
    mark: "#provider-mark-google",
  },
  apple: {
    label: "Signed in with Apple",
    mark: "#provider-mark-apple",
  },
};

function renderHostedIdentity() {
  const googleButton = $("#identity-google-signin");
  const appleButton = $("#identity-apple-signin");
  const pendingActions = $("#identity-signin-pending-actions");
  const checkButton = $("#identity-signin-check");
  const cancelButton = $("#identity-signin-cancel");
  const chip = $("#identity-signin-state");
  const googleUnavailable = $("#identity-google-unavailable");
  const appleUnavailable = $("#identity-apple-unavailable");
  // Both providers complete through the contribution service: it owns the
  // redirect target, the client secret, and the one-time result each sign-in
  // is read back from. A build with no service configured therefore cannot
  // sign in at all, so the controls say so instead of failing after the click.
  const serviceConfigured =
    localCompanionHealth?.capabilities?.contributionDevicePairing === true;
  const hasServerSession = hasCommunitySession();
  const signedIn = hostedIdentity !== null || hasServerSession;
  const provider = HOSTED_IDENTITY_PROVIDERS[hostedIdentity?.provider] ?? null;
  const enrollmentPaused = hostedEnrollmentIsPaused();
  const googleUnavailableNow = googleSignInUnavailable
    || configuredGoogleClientId() === null
    || !serviceConfigured
    || enrollmentPaused;
  googleButton.disabled = hostedIdentityBusy
    || signedIn
    || googleUnavailableNow;
  googleUnavailable.hidden = !googleUnavailableNow || signedIn;
  // Written through the registering helpers: a line produced by `t(...)` is
  // already in the old language after a switch, so it has to be re-translated
  // from its key rather than from its rendered text.
  if (enrollmentPaused) {
    setLocalizedText(googleUnavailable, "contribution.enrollmentPaused");
  } else if (hostedNewEnrollmentIsPaused() && !signedIn && !googleUnavailableNow) {
    // The buttons stay enabled: sign-in reconnects an existing contributor
    // even while new sign-ups are paused.
    googleUnavailable.hidden = false;
    setLocalizedText(googleUnavailable, "contribution.newEnrollmentPausedSignInWorks");
  } else {
    setProductText(googleUnavailable, serviceConfigured
      ? "Hosted sign-in is not configured for this build."
      : "This build has no contribution service, so hosted sign-in is unavailable.");
  }
  const appleUnavailableNow = appleSignInUnavailable
    || !serviceConfigured
    || enrollmentPaused;
  // When enrollment is paused, use one shared sentence instead of displaying
  // the same global status below both provider buttons.
  appleUnavailable.hidden = !appleUnavailableNow || signedIn || enrollmentPaused;
  setProductText(appleUnavailable, serviceConfigured
    ? "Hosted Apple sign-in is not configured for this build."
    : "This build has no contribution service, so hosted sign-in is unavailable.");
  appleButton.disabled = hostedIdentityBusy
    || signedIn
    || appleUnavailableNow;
  // Exactly one of the two states is present: the provider choices, or the
  // signed-in account row that can hand the page back to the choices.
  $("#identity-signin-choices").hidden = signedIn;
  $("#identity-account").hidden = !signedIn;
  $("#identity-signout").disabled = hostedIdentityBusy || !signedIn;
  pendingActions.hidden = !hostedIdentityBusy || signedIn;
  checkButton.disabled = !hostedIdentityBusy || signedIn;
  cancelButton.disabled = !hostedIdentityBusy || signedIn;
  $("#identity-account-badge").hidden = provider === null;
  setRawText($("#identity-account-provider"), provider?.label ?? t("contribution.identityGenericSession"));
  if (provider !== null) {
    $("#identity-account-mark").setAttribute("href", provider.mark);
  }
  setProductText(
    $("#identity-account-detail"),
    provider !== null
      ? "Signing out ends this app's contribution session."
      : "This app already has a contribution session. Signing out ends it.",
  );
  setProductText(chip, signedIn
    ? "Signed in"
    : hostedIdentityBusy ? "Signing in…" : "Not signed in");
  chip.className = signedIn
    ? "evidence-chip"
    : "evidence-chip neutral";
  // Sign-in state gates the single approve ceremony, so the merged surface
  // and the journey strip re-render with it (owner-directed 2026-08-08: the
  // separate connect button this used to refresh is gone).
  renderContributionActionState();
}

// A completed hosted handoff is memory-only, but enrollment also creates an
// HttpOnly service session. When one exists, acknowledge its server-side
// revocation before changing the UI: otherwise this page would say "signed
// out" while the browser still held a usable session cookie. A proof that was
// never enrolled has no session and can be forgotten locally.
async function signOutHostedIdentity() {
  if (hostedIdentityBusy || (hostedIdentity === null && !hasCommunitySession())) {
    return;
  }
  const status = $("#identity-signin-status");
  const hadServerSession = Boolean(communitySession?.csrfToken);
  hostedIdentityBusy = true;
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  setLocalizedText(status, hadServerSession
    ? "contribution.signOutStarting"
    : "contribution.signOutForgetting");
  try {
    if (hadServerSession) await communityClient.logout();
    hostedIdentity = null;
    setCommunitySession(null);
    $("#participant-controls")?.setAttribute("hidden", "");
    setLocalizedText(status, hadServerSession
      ? "contribution.signOutCompleted"
      : "contribution.signOutUnfinished");
  } catch (error) {
    await showFailure(status, {
      surface: "hosted_identity",
      error,
      fallback: t("contribution.signOutFailed")
    });
  } finally {
    hostedIdentityBusy = false;
    renderHostedIdentity();
  }
}

// The service holds a completed sign-in for five minutes, so the poll stops
// exactly when the handoff can no longer be delivered rather than earlier: the
// user is authenticating in a separate browser window and may be typing a
// password and a second factor.
const HOSTED_SIGNIN_POLL_ATTEMPTS = 150;
const HOSTED_SIGNIN_POLL_INTERVAL_MS = 2_000;
// The service-side hold, stated once: the poll budget IS the validity window,
// and the persisted pending handoff below uses the same bound so this page
// never claims a proof the service has already discarded.
const HOSTED_SIGNIN_HANDOFF_VALIDITY_MS =
  HOSTED_SIGNIN_POLL_ATTEMPTS * HOSTED_SIGNIN_POLL_INTERVAL_MS;

// The packaged Mac app stamps this fixed marker before any dashboard script
// runs. A normal browser keeps the dashboard page open in a second tab while
// it polls for the result; the packaged app instead makes a main-frame
// navigation. Its WebKit navigation policy hands the remote URL straight to
// the default browser, without first showing the app's "continue" pop-up.
function runsInsideNativeDashboard() {
  return document.documentElement.classList.contains("native-dashboard")
    || document.body?.classList.contains("native-dashboard");
}

function openHostedSignInInBrowser(authorizeUrl) {
  if (runsInsideNativeDashboard()) {
    window.location.assign(authorizeUrl);
    return;
  }
  // A regular browser needs to keep this dashboard alive so its bounded poll
  // can collect the one-time result. The callback page still offers the same
  // safe return link to the installed app.
  window.open(authorizeUrl, "_blank", "noopener,noreferrer");
}

function foregroundNativeDashboardAfterSignIn() {
  if (runsInsideNativeDashboard() && SEMANTIC_OPEN_TARGET) {
    // The native host accepts only the exact fixed app link and brings this
    // already-running window forward. No provider value travels through it.
    window.location.assign(SEMANTIC_OPEN_TARGET);
  }
}

function wakeHostedSignInPoll(attempt) {
  if (activeHostedSignIn !== attempt || attempt.cancelled) return;
  attempt.returnedToApp = true;
  if (typeof attempt.wake === "function") {
    attempt.wake();
  } else {
    attempt.pollImmediately = true;
  }
}

function waitForHostedSignInPoll(attempt) {
  return new Promise((resolveWait) => {
    if (activeHostedSignIn !== attempt || attempt.cancelled) {
      resolveWait();
      return;
    }
    let timeoutId = null;
    const resume = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (attempt.wake === resume) attempt.wake = null;
      resolveWait();
    };
    attempt.wake = resume;
    if (attempt.pollImmediately) {
      attempt.pollImmediately = false;
      resume();
      return;
    }
    timeoutId = window.setTimeout(resume, HOSTED_SIGNIN_POLL_INTERVAL_MS);
  });
}

function checkHostedSignInNow() {
  if (activeHostedSignIn !== null) wakeHostedSignInPoll(activeHostedSignIn);
}

function cancelHostedSignIn() {
  const attempt = activeHostedSignIn;
  if (attempt === null) return;
  attempt.cancelled = true;
  activeHostedSignIn = null;
  hostedIdentityBusy = false;
  // An explicit cancel is a user decision: the persisted handoff must not
  // resurrect this sign-in on the next reactivation.
  clearPendingHostedSignIn();
  attempt.wake?.();
  const status = $("#identity-signin-status");
  status.hidden = false;
  status.className = "participant-action-status";
  setLocalizedText(status, "contribution.signInCancelled", {
    provider: attempt.label,
  });
  renderHostedIdentity();
}

// One shape for both providers. Neither can complete inside this page: Apple
// provisions Sign in with Apple only for distributions this Developer ID build
// cannot use, refuses loopback redirects, and answers with
// response_mode=form_post; Google's Web application client requires its client
// secret on the token exchange. In both cases the contribution service owns
// the redirect and the secret, this page opens the authorize URL it is given,
// and the sign-in is read back here through the unguessable state.
//
// That is also what lets the dashboard complete a sign-in while it is running
// inside the macOS app, whose web view will not load a provider host: the
// browser that finishes the sign-in hands nothing back to this page, and this
// page asks the service for the result instead.
const HOSTED_SIGNIN_FLOWS = {
  google: {
    label: "Google",
    start: () => communityClient.identityGoogleStart(),
    result: (state, verifier) =>
      communityClient.identityGoogleResult(state, verifier),
    waiting:
      "Finish signing in with Google in your browser. TiboTattle returns to the front when it is ready. You can cancel this sign-in here at any time; nothing is uploaded until you review it.",
    signedIn:
      "Signed in with Google. This page holds only a short-lived opaque proof; the service keeps only an irreversible identity hash, never your email or name.",
    timedOut:
      "Google sign-in did not finish in time. Nothing was stored. Press Sign in with Google again to start a fresh sign-in.",
    unconfigured: "Hosted Google sign-in is not configured for this build.",
    failed: "Google sign-in could not be completed. Sign in again.",
    markUnavailable: () => {
      googleSignInUnavailable = true;
    },
  },
  apple: {
    label: "Apple",
    start: () => communityClient.identityAppleStart(),
    result: (state, verifier) =>
      communityClient.identityAppleResult(state, verifier),
    waiting:
      "Finish signing in with Apple in your browser. TiboTattle returns to the front when it is ready. You can cancel this sign-in here at any time; nothing is uploaded until you review it.",
    signedIn:
      "Signed in with Apple. This page holds only a short-lived opaque proof; the service keeps only an irreversible identity hash, never your email or name.",
    timedOut:
      "Apple sign-in did not finish in time. Nothing was stored. Press Sign in with Apple again to start a fresh sign-in.",
    unconfigured: "Hosted Apple sign-in is not configured for this build.",
    failed: "Apple sign-in could not be completed. Sign in again.",
    markUnavailable: () => {
      appleSignInUnavailable = true;
    },
  },
};

// The pending sign-in handoff survives a dashboard reload (owner-reported
// orphaned proof, 2026-08-08: a server-side COMPLETED Google sign-in expired
// unread because the state token needed to collect it lived only in page
// memory, and the native deep-link reactivation reloaded the page). The
// moment the browser is opened, {provider, state, startedAt} is persisted to
// sessionStorage — tab-scoped and gone when the tab closes, holding only the
// single-use five-minute read-back handle, never a proof or a session. These
// three helpers are the ONLY place this page touches web storage; the source
// contract test cuts this block out and holds the rest of the file to zero.
const PENDING_HOSTED_SIGNIN_STORAGE_KEY = "tibotattle.pending-hosted-sign-in.v1";

function persistPendingHostedSignIn(providerId, state, verifier) {
  try {
    window.sessionStorage?.setItem(
      PENDING_HOSTED_SIGNIN_STORAGE_KEY,
      JSON.stringify({
        provider: providerId,
        state,
        verifier,
        startedAt: Date.now(),
      }),
    );
  } catch {
    // Storage being unavailable only removes the reload resilience; the live
    // poll still collects the proof exactly as before.
  }
}

function clearPendingHostedSignIn() {
  try {
    window.sessionStorage?.removeItem(PENDING_HOSTED_SIGNIN_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function readPendingHostedSignIn() {
  try {
    const raw = window.sessionStorage?.getItem(PENDING_HOSTED_SIGNIN_STORAGE_KEY);
    if (typeof raw !== "string" || raw === "") return null;
    const value = JSON.parse(raw);
    // The state token and the client verifier keep the exact shape the service
    // mints and requires (the same bounds the client's own read-back enforces),
    // so a corrupt record is discarded here instead of failing the read-back
    // forever. The verifier is the initiator binding: without it a resumed poll
    // can no longer collect the proof, so a record missing it is unusable.
    if (!Object.hasOwn(HOSTED_SIGNIN_FLOWS, value?.provider ?? "")
        || typeof value?.state !== "string"
        || !/^[A-Za-z0-9_-]{43,128}$/u.test(value.state)
        || typeof value?.verifier !== "string"
        || !/^[A-Za-z0-9_-]{43,128}$/u.test(value.verifier)
        || !Number.isFinite(value?.startedAt)) {
      clearPendingHostedSignIn();
      return null;
    }
    return value;
  } catch {
    clearPendingHostedSignIn();
    return null;
  }
}

// One resume at a time; re-entrant activations (load + focus + deep link in
// the same second) must not race two read-backs of the one-time result.
let pendingHostedSignInResumeInFlight = false;

/**
 * Collect a sign-in this page started but never read back (owner-reported
 * orphaned proof, 2026-08-08). Runs on load and on every reactivation —
 * deep-link return, visibilitychange to visible, window focus — and reads the
 * persisted handoff's result with a couple of bounded retries inside the
 * five-minute validity window. Success completes the identical journey the
 * live poll would have: identity adopted, record cleared, and the pending
 * repair ceremony resumed. A proof that expired unread, or a definite service
 * verdict, is reported through describeFailure so a reference and request id
 * reach the local diagnostics log; an unreachable service leaves the record
 * for the next activation instead of logging a note per focus change.
 */
async function resumePendingHostedSignIn({ retries = 2 } = {}) {
  if (pendingHostedSignInResumeInFlight) return;
  if (hostedIdentityBusy || activeHostedSignIn !== null || hostedIdentity !== null) {
    return;
  }
  const pending = readPendingHostedSignIn();
  if (pending === null) return;
  const flow = HOSTED_SIGNIN_FLOWS[pending.provider];
  const status = $("#identity-signin-status");
  if (Date.now() - pending.startedAt > HOSTED_SIGNIN_HANDOFF_VALIDITY_MS) {
    clearPendingHostedSignIn();
    const error = new Error("The completed sign-in expired before this Mac collected it.");
    error.code = "HOSTED_SIGNIN_HANDOFF_EXPIRED";
    await showFailure(status, {
      surface: "hosted_identity",
      error,
      messages: {
        HOSTED_SIGNIN_HANDOFF_EXPIRED:
          `The completed ${flow.label} sign-in expired before this Mac could collect it. Nothing was uploaded; sign in again.`,
      },
      fallback: flow.failed,
    });
    renderHostedIdentity();
    return;
  }
  pendingHostedSignInResumeInFlight = true;
  try {
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      let identity = null;
      try {
        identity = await flow.result(pending.state, pending.verifier);
      } catch (error) {
        if (error?.code === "IDENTITY_RESULT_PENDING") {
          // The provider has not returned yet; retry shortly, then leave the
          // record for the next activation inside the validity window.
          identity = null;
        } else if (error?.code === undefined && error?.status === undefined) {
          // Unreachable service: not a verdict on the proof. Keep the record
          // and try again on the next activation rather than logging a note
          // per focus change.
          return;
        } else {
          clearPendingHostedSignIn();
          await showFailure(status, {
            surface: "hosted_identity",
            error,
            fallback: hostedIdentityErrorCopy(error) ?? flow.failed,
          });
          renderHostedIdentity();
          return;
        }
      }
      if (identity !== null) {
        clearPendingHostedSignIn();
        hostedIdentity = identity;
        status.hidden = false;
        status.className = "participant-action-status";
        status.textContent = flow.signedIn;
        renderHostedIdentity();
        foregroundNativeDashboardAfterSignIn();
        resumeContributionCeremonyAfterSignIn();
        return;
      }
      if (attemptIndex < retries) {
        await new Promise((resolveWait) => {
          setTimeout(resolveWait, HOSTED_SIGNIN_POLL_INTERVAL_MS);
        });
      }
    }
  } finally {
    pendingHostedSignInResumeInFlight = false;
  }
}

async function beginHostedSignIn(providerId) {
  const flow = HOSTED_SIGNIN_FLOWS[providerId];
  if (flow === undefined || hostedIdentityBusy || hostedIdentity !== null
      || pendingHostedSignInResumeInFlight) {
    return;
  }
  const status = $("#identity-signin-status");
  const attempt = {
    cancelled: false,
    label: flow.label,
    pollImmediately: false,
    returnedToApp: false,
    wake: null,
  };
  activeHostedSignIn = attempt;
  hostedIdentityBusy = true;
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  setLocalizedText(status, "contribution.signInStarting", {
    provider: flow.label,
  });
  try {
    const request = await flow.start();
    // Persisted BEFORE the browser opens: from this moment a completed
    // sign-in exists server-side that only this state token AND the client
    // verifier can collect, so both must survive a dashboard reload
    // (owner-reported orphaned proof, 2026-08-08).
    persistPendingHostedSignIn(providerId, request.state, request.verifier);
    openHostedSignInInBrowser(request.authorizeUrl);
    status.textContent = flow.waiting;
    for (let poll = 0; poll < HOSTED_SIGNIN_POLL_ATTEMPTS; poll += 1) {
      if (attempt.cancelled || activeHostedSignIn !== attempt) return;
      let identity = null;
      try {
        identity = await flow.result(request.state, request.verifier);
      } catch (error) {
        if (error?.code !== "IDENTITY_RESULT_PENDING") throw error;
        // The fixed callback page wakes the native dashboard only after the
        // provider has returned. A current service turns a cancelled callback
        // into IDENTITY_TOKEN_INVALID; this branch preserves the same safe UI
        // outcome while a previously deployed service still reports pending.
        if (attempt.returnedToApp) {
          // A completed callback whose result stays pending is a read-back
          // failure the user acted on, so it is referenced and logged like
          // one (owner-reported silent failure, 2026-08-08) instead of
          // rendering copy with no diagnostic note behind it.
          clearPendingHostedSignIn();
          await showFailure(status, {
            surface: "hosted_identity",
            error,
            messages: {
              IDENTITY_RESULT_PENDING:
                `${flow.label} sign-in did not complete. Nothing was uploaded. You can try again.`,
            },
            fallback: flow.failed,
          });
          return;
        }
      }
      if (identity !== null) {
        if (attempt.cancelled || activeHostedSignIn !== attempt) return;
        clearPendingHostedSignIn();
        hostedIdentity = identity;
        activeHostedSignIn = null;
        hostedIdentityBusy = false;
        status.textContent = flow.signedIn;
        renderHostedIdentity();
        foregroundNativeDashboardAfterSignIn();
        resumeContributionCeremonyAfterSignIn();
        return;
      }
      if (poll + 1 < HOSTED_SIGNIN_POLL_ATTEMPTS) {
        await waitForHostedSignInPoll(attempt);
      }
    }
    // A bounded poll that ran out is still a failed action from the user's
    // side, so it is referenced and logged like any other. The poll budget IS
    // the handoff's validity window, so the persisted record is expired with
    // it.
    clearPendingHostedSignIn();
    await showFailure(status, {
      surface: "hosted_identity",
      error: null,
      fallback: flow.timedOut,
    });
  } catch (error) {
    if (attempt.cancelled || activeHostedSignIn !== attempt) return;
    // A definite verdict (a coded or HTTP-status failure) retires the
    // persisted handoff; a transient unreachable-service throw keeps it, so
    // the reactivation resume can still collect the proof inside its window.
    if (error?.code !== undefined || error?.status !== undefined) {
      clearPendingHostedSignIn();
    }
    const unconfigured = error?.code === "IDENTITY_CONFIGURATION_INVALID";
    if (unconfigured) flow.markUnavailable();
    await showFailure(status, {
      surface: "hosted_identity",
      error,
      messages: unconfigured
        ? { IDENTITY_CONFIGURATION_INVALID: flow.unconfigured }
        : error?.code === "IDENTITY_TOKEN_INVALID"
          ? {
            IDENTITY_TOKEN_INVALID:
              `${flow.label} sign-in was cancelled or did not complete. Nothing was uploaded. You can try again.`,
          }
          : {},
      fallback: hostedIdentityErrorCopy(error)
        ?? (error instanceof Error && error.status === undefined
          ? error.message
          : flow.failed),
    });
  } finally {
    if (activeHostedSignIn === attempt) {
      activeHostedSignIn = null;
      hostedIdentityBusy = false;
      renderHostedIdentity();
    }
  }
}

// (communityContributionIsConnected and updateCommunityConnectButton left
// with the separate connect card, owner-directed 2026-08-08: the one-step
// ceremony pairs and approves in the same interaction, so there is no
// standalone connect button to label or gate any more.)

// The chip vocabulary of the journey strip. Four states, each an honest
// summary of the detail line beside it: finished, measurably under way,
// waiting on something else, or waiting on the reader.
const JOURNEY_STATE_KEYS = Object.freeze({
  action: "journey.state.actionNeeded",
  done: "journey.state.done",
  progress: "journey.state.inProgress",
  waiting: "journey.state.waiting",
});

/**
 * The guided journey as explicit stages with visible state: app/companion →
 * index building → evidence → community. Every line is rendered from a
 * measured fact — companion health, the counted index sources (the same
 * numbers as the history progress surface), evidence freshness, and the
 * sign-in/connection facts — and each stage says plainly whether it is done,
 * in progress with real numbers, or blocked and by what.
 */
function renderCommunityJourney() {
  if (!$("#community-journey")) return;
  const stage = (name, state, detailKey, detailValues = {}) => {
    const item = $(`#journey-stage-${name}`);
    const chip = $(`#journey-stage-${name}-state`);
    const detail = $(`#journey-stage-${name}-detail`);
    if (!item || !chip || !detail) return;
    setLocalizedText(chip, JOURNEY_STATE_KEYS[state]);
    chip.className =
      `evidence-chip journey-stage-state${state === "done" ? "" : " neutral"}`;
    setLocalizedText(detail, detailKey, detailValues);
    item.className = `journey-stage journey-stage-${state}`;
  };

  // 1 — the Mac app and its loopback companion.
  if (localCompanionHealth !== null) {
    stage("app", "done", "journey.app.connected");
  } else {
    stage("app", "action", "journey.app.missing");
  }

  // 2 — the local index, with the same measured counts the history progress
  // surface reports. Nothing here estimates a finish time.
  const history = dashboard?.pricing?.historyCoverage
    ?? dashboard?.accounting?.historyCoverage
    ?? null;
  const totalSources = finite(history?.sourceCount, 0);
  if (dashboard && dashboard.mode !== "demo" && history?.status === "complete") {
    stage("index", "done", "journey.index.complete");
  } else if (dashboard && dashboard.mode !== "demo" && totalSources > 0) {
    // The same measured counts the history progress surface reports, stated
    // as one short sentence: the two-sentence byte breakdown wrapped this
    // card to eight lines (owner-directed tightening, 2026-08-08).
    stage("index", "progress", "journey.index.progress", {
      indexed: formatNumber(finite(history.indexedSourceCount, 0)),
      total: formatNumber(totalSources),
    });
  } else {
    stage("index", "waiting", "journey.index.waiting");
  }

  // 3 — local evidence.
  if (dashboard && dashboard.mode !== "demo" && dashboard.freshness?.latestObservedAt) {
    stage("evidence", "done", "journey.evidence.ready", {
      time: formatLocal(dashboard.freshness.latestObservedAt),
    });
  } else if (dashboard?.mode === "demo") {
    stage("evidence", "action", "journey.evidence.demo");
  } else {
    stage("evidence", "action", "journey.evidence.missing");
  }

  // 4 — sign in, then the single review-and-approve ceremony (owner-directed
  // 2026-08-08: connecting is no longer a user-visible step — the ceremony
  // pairs this Mac itself). Once approval stands the line states the flow's
  // remaining truth: it syncs automatically.
  if (localCompanionHealth === null) {
    stage("community", "waiting", "journey.community.waitingCompanion");
  } else if (!contributionServiceConfigured()) {
    stage("community", "waiting", "journey.community.noService");
  } else if (!incrementalSyncCapabilityAdvertised()) {
    // A build whose companion does not advertise the v1.0 transport has no
    // in-page ceremony; a Mac already holding upload authority still reads
    // as connected rather than pending.
    if (communityUploadAuthorityEvidence()) {
      stage("community", "done", "journey.community.connected");
    } else {
      stage("community", "waiting", "journey.community.waitingIndex");
    }
  } else if (incrementalConsentApproved && incrementalGrantRejected()) {
    // The transparent re-pair is pending, so this stage must not claim
    // "done · syncing" while the approve card is asking for a sign-in
    // (owner-reported contradictory state, 2026-08-08). One truth: a missing
    // sign-in is the reader's action; otherwise the authorization refresh is
    // simply in flight.
    if (hostedSignInRequired()) {
      stage("community", "action", "journey.community.signInAgain");
    } else {
      stage("community", "progress", "journey.community.refreshingAuthority");
    }
  } else if (incrementalConsentApproved) {
    stage("community", "done", "journey.community.syncing");
  } else if (hostedEnrollmentIsPaused()) {
    stage("community", "waiting", "journey.community.paused");
  } else if (hostedSignInRequired()) {
    stage("community", "action", "journey.community.signInFirst");
  } else {
    stage("community", "action", "journey.community.approveNext");
  }
}

// The incremental full-history contribution contract this dashboard is ready
// to collect consent for. The approve-once surface renders only when the
// local companion's health payload advertises exactly this capability; until
// that transport exists the surface stays out of the document entirely, so
// the page never claims an automatic upload that cannot happen.
const INCREMENTAL_SYNC_CONTRACT = "telemetry-contribution-v1.0";

function incrementalSyncCapabilityAdvertised() {
  return localCompanionHealth?.capabilities?.incrementalContributionSync
    === INCREMENTAL_SYNC_CONTRACT;
}

/**
 * Whether the service refused this Mac's uploads for want of the v1.0
 * consent-once grant. The engine pauses with exactly this fixed reason when
 * an upload comes back 403 TELEMETRY_CONSENT_INVALID — the mark of a pairing
 * that was claimed carrying the v0.1 consent, so no grant was recorded.
 */
function incrementalGrantRejected() {
  return incrementalSyncStatus?.status === "available"
    && incrementalSyncStatus.pausedReason === "consent_rejected";
}

/**
 * The one merged surface (owner-directed 2026-08-08). Approval covers the
 * KIND of data, once, and the first approval keeps the review-bootstrap
 * requirement — one verified real instance of the data is on screen before
 * approval can be given. The single button also owns the pairing ceremony:
 * sign-in is the only prerequisite it states.
 */
function renderIncrementalConsent() {
  const surface = $("#incremental-consent");
  if (!surface) return;
  if (!incrementalSyncCapabilityAdvertised()) {
    surface.hidden = true;
    return;
  }
  surface.hidden = false;
  const approve = $("#incremental-consent-approve");
  const gate = $("#incremental-consent-gate");
  const chip = $("#incremental-consent-state");
  const reviewVerified = contributionSyncExactReview?.state === "ready";
  const busy = incrementalConsentBusy || communityConnectBusy;
  // A recorded approval whose claim carried the v0.1 consent re-opens the
  // same single action (the transparent re-pair). The chip stays "Approved":
  // the user's approval stands; only the transport authorization re-runs.
  const repairNeeded = incrementalConsentApproved && incrementalGrantRejected();
  setLocalizedText(chip, incrementalConsentApproved
    ? "consent.stateApproved"
    : "consent.stateNotApproved");
  chip.className = incrementalConsentApproved
    ? "evidence-chip"
    : "evidence-chip neutral";
  approve.disabled = busy
    || (incrementalConsentApproved && !repairNeeded)
    || (!incrementalConsentApproved && !reviewVerified)
    || hostedSignInRequired();
  const remove = $("#delete-contributions");
  if (remove) {
    remove.hidden = !hasCommunitySession();
    remove.disabled = busy;
  }
  // The review the approve gate requires, on screen: the verified prepared
  // instance's own facts. They come from the same queue item the one-use
  // token was minted for, and they leave with approval — the card then
  // describes the running sync instead.
  const facts = $("#incremental-review-facts");
  const item = contributionSyncPreview?.item;
  if (facts) {
    const show = !incrementalConsentApproved && reviewVerified && item != null;
    facts.hidden = !show;
    if (show) {
      setRawText(
        $("#incremental-review-coverage"),
        `${formatLocal(item.coveredAt.startAt)} – ${formatLocal(item.coveredAt.endAt)}`,
      );
      setRawText(
        $("#incremental-review-records"),
        `${compact(item.recordCounts.total)} total · ${compact(item.recordCounts.usageEvents)} usage · ${compact(item.recordCounts.quotaSnapshots)} quota`,
      );
      setRawText(
        $("#incremental-review-bytes"),
        `${compact(item.preparedBytes)} bytes, verified on this Mac`,
      );
    }
  }
  if (incrementalConsentApproved && !(repairNeeded && hostedSignInRequired())) {
    forgetLocalizedNode(gate);
    gate.textContent = "";
    gate.hidden = true;
  } else {
    gate.hidden = false;
    // Why the button is off, stated where the button is, in gate order: the
    // missing sign-in first, then the in-flight review. Connection is no
    // longer a stated prerequisite — the ceremony performs it itself. A
    // signed-out Mac that needs the transparent re-pair names the repair's
    // own next step (owner-reported repair loop, 2026-08-08): sign in again,
    // and connecting resumes by itself.
    setLocalizedText(gate, hostedSignInRequired()
      ? repairNeeded
        ? "consent.signInAgainToFinish"
        : "consent.signInFirst"
      : reviewVerified
        ? "consent.readyToApprove"
        : "consent.reviewFirst");
  }
  renderIncrementalSyncStatusLine();
}

/**
 * The status line for the approved sync, from the companion's bounded
 * incremental-status projection: live first-pass progress as day counts, the
 * paused reason code, and the last error code. Every value is a number or a
 * fixed vocabulary code the projection validated; no path, content, or
 * identifier can reach this line.
 *
 * Re-pinned 2026-08-08 (owner-directed): approval starts the first pass
 * immediately and the page polls this projection while it runs, so the line
 * shows "Uploading day 3 of 82…" instead of an indefinite "waiting".
 */
function renderIncrementalSyncStatusLine() {
  const line = $("#incremental-sync-status");
  if (!line) return;
  if (!incrementalSyncCapabilityAdvertised()
      || !incrementalConsentApproved
      || incrementalSyncStatus?.status !== "available") {
    forgetLocalizedNode(line);
    line.textContent = "";
    line.hidden = true;
    return;
  }
  // The transparent re-pair state renders as the routine it is — an
  // authorization refresh — never as a failure the user must interpret. When
  // the page cannot run the refresh yet (signed out), the gate line asks for
  // sign-in and this line stays quiet rather than claiming work in progress.
  if (incrementalGrantRejected()) {
    if (hostedSignInRequired()) {
      forgetLocalizedNode(line);
      line.textContent = "";
      line.hidden = true;
      return;
    }
    setRawText(line, t("consent.syncRefreshingAuthority"));
    line.hidden = false;
    return;
  }
  const progress = incrementalSyncStatus.progress;
  const parts = [];
  if (progress === null) {
    parts.push(t("consent.syncStarting"));
  } else if (progress.daysPending > 0 && !incrementalSyncStatus.paused) {
    // Mid catch-up: the day currently being uploaded, from the settled pass
    // counts the engine reports between its bounded passes.
    parts.push(t("consent.syncUploading", {
      current: formatNumber(Math.min(progress.daysSynced + 1, progress.daysTotal)),
      total: formatNumber(progress.daysTotal),
    }));
  } else {
    parts.push(t("consent.syncProgress", {
      pending: formatNumber(progress.daysPending),
      synced: formatNumber(progress.daysSynced),
      total: formatNumber(progress.daysTotal),
    }));
  }
  if (incrementalSyncStatus.paused) {
    parts.push(t("consent.syncPaused", {
      reason: incrementalSyncStatus.pausedReason ?? "unknown",
    }));
  }
  const outcome = incrementalSyncStatus.lastOutcome;
  // A bounded partial pass is progress, not an error; only a failed or
  // paused outcome earns the "Last error" clause (2026-08-08).
  if (outcome !== null && ["failed", "paused"].includes(outcome.status)) {
    parts.push(t("consent.syncLastError", { code: outcome.code }));
  }
  // A composed multi-part sentence: raw write, like the other composed
  // status lines, so a stale registry entry cannot resurrect over it.
  setRawText(line, parts.join(" "));
  line.hidden = false;
}

// The live-progress poll behind the first pass (owner-directed 2026-08-08).
// A chained setTimeout — never an interval — that repeats the same bounded
// GET the page performs on load, while there is measurable movement to show:
// a running pass, a first pass that has not settled yet, or pending days
// between bounded passes. It stops on pause, on completion, and at a fixed
// budget, so an idle dashboard never polls forever.
const INCREMENTAL_SYNC_POLL_INTERVAL_MS = 4_000;
const INCREMENTAL_SYNC_POLL_LIMIT = 450;

function incrementalSyncPollWorthwhile() {
  if (!incrementalSyncCapabilityAdvertised() || !incrementalConsentApproved) {
    return false;
  }
  const status = incrementalSyncStatus;
  if (status?.status !== "available" || status.paused) return false;
  if (status.running) return true;
  if (status.progress === null) return true;
  return status.progress.daysPending > 0;
}

function scheduleIncrementalSyncStatusPoll({ reset = false } = {}) {
  if (reset) incrementalSyncPollCount = 0;
  if (incrementalSyncPollTimer !== null) return;
  if (!incrementalSyncPollWorthwhile()) return;
  if (incrementalSyncPollCount >= INCREMENTAL_SYNC_POLL_LIMIT) return;
  incrementalSyncPollTimer = window.setTimeout(() => {
    incrementalSyncPollTimer = null;
    incrementalSyncPollCount += 1;
    void loadIncrementalSyncStatus().catch(() => {});
  }, INCREMENTAL_SYNC_POLL_INTERVAL_MS);
}

/**
 * Re-read the bounded incremental sync status. It carries the durable
 * consent verdict — so an approved Mac renders as approved after a reload —
 * and the progress facts the status line prints.
 */
async function loadIncrementalSyncStatus() {
  if (!incrementalSyncCapabilityAdvertised()) {
    incrementalSyncStatus = null;
    incrementalConsentApproved = false;
    renderContributionActionState();
    return;
  }
  incrementalSyncStatus = await localClient.incrementalContributionSyncStatus();
  // Only an available projection may change the consent verdict: a transient
  // read failure normalizes to a fail-closed shape whose false consent must
  // not un-approve a Mac the companion just recorded an approval for.
  if (incrementalSyncStatus?.status === "available") {
    incrementalConsentApproved =
      incrementalSyncStatus.consent.approved === true
      && incrementalSyncStatus.consent.current === true;
  }
  renderContributionActionState();
  scheduleIncrementalSyncStatusPoll();
}

/**
 * The one-step ceremony (owner-directed, 2026-08-08): a single "Review and
 * approve" interaction does everything after sign-in. It mints the pairing
 * WITH the v1.0 consent identifier (the server session is already held), has
 * the companion claim it — the claim is what records the server-side
 * consent-once grant every chunk upload is verified against — then records
 * the local approve-once consent with the review token, and the companion
 * starts the first sync pass immediately.
 *
 * The same ceremony is the transparent re-pair path: a Mac whose earlier
 * claim carried the v0.1 consent has no grant, so its uploads pause with
 * consent_rejected. Re-running the ceremony re-pairs with the v1.0 consent
 * and skips the local approval it already holds — nothing is reported as a
 * failure, because nothing the user did failed.
 */
async function approveIncrementalContribution() {
  if (incrementalConsentBusy || communityConnectBusy
      || !incrementalSyncCapabilityAdvertised()) {
    return;
  }
  const status = $("#incremental-consent-status");
  const needsLocalApproval = !incrementalConsentApproved;
  if (needsLocalApproval && contributionSyncExactReview?.state !== "ready") {
    status.hidden = false;
    status.className = "participant-action-status error";
    setLocalizedText(status, "consent.reviewFirst");
    return;
  }
  if (hostedEnrollmentIsPaused()) {
    status.hidden = false;
    status.className = "participant-action-status error";
    setLocalizedText(status, "contribution.enrollmentPausedNoUpload");
    return;
  }
  if (hostedSignInRequired()) {
    status.hidden = false;
    status.className = "participant-action-status error";
    setLocalizedText(status, "consent.signInFirst");
    return;
  }
  incrementalConsentBusy = true;
  // A hosted proof is intentionally one-use. If enrollment itself fails, the
  // page must not claim the same proof can be retried: it is dropped and the
  // next action is a fresh browser sign-in. Failures after a session is
  // established can be retried without authenticating again.
  let enrollmentAttemptedWithHostedIdentity = false;
  let enrollmentEstablished = false;
  renderContributionActionState();
  try {
    // --- Upload authority, inside the same interaction. -------------------
    // Only a v1.0-consent claim made by THIS session proves the server-side
    // grant exists; anything less re-pairs. The claim is idempotent for a
    // valid credential and the companion resumes its engine on pairing, so
    // re-pairing is safe even when a grant already existed.
    if (!communityDevicePairedV1) {
      await contributionConnectStep("service_check", status, () => {
        if (localCompanionHealth?.capabilities?.contributionDevicePairing !== true) {
          const error = new Error(
            "The local app is not connected to a configured contribution service."
          );
          error.code = "contribution_device_pairing_not_configured";
          throw error;
        }
      });
      let pairing;
      // A pending sign-in proof ALWAYS establishes its own fresh session
      // first (owner-reported resume bug, 2026-08-08): after a
      // session-rejected repair, any stored csrfToken is either gone or
      // exactly the credential the service just refused, and minting the
      // pairing with it burned the sign-in behind repeated AUTH_REQUIRED
      // failures the user had already fixed by signing in. The stored
      // session mints directly only when NO proof is in hand, so the
      // post-sign-in order is fixed: enroll with the proof, adopt the
      // session it returns, then mint and claim the v1.0 pairing.
      if (hostedIdentity === null && communitySession?.csrfToken) {
        pairing = await contributionConnectStep(
          "hosted_enrollment",
          status,
          () => communityClient.createDevicePairing(false),
        );
      } else {
        // This page never collects or sends an invitation code. The Worker
        // is the authority on whether its current enrollment mode admits
        // this hosted proof; a paused service fails before the browser
        // OAuth start. The enrollment deliberately does NOT request the
        // device bootstrap: the Worker's bootstrap pairing may only carry
        // the v0.1 ongoing consent, so the pairing is minted separately
        // with the session the enrollment just established — the one route
        // that can carry the v1.0 consent (2026-08-08).
        enrollmentAttemptedWithHostedIdentity = hostedIdentity !== null;
        pairing = await contributionConnectStep("hosted_enrollment", status, async () => {
          const enrollment = await communityClient.enroll(
            null,
            "telemetry-contribution-v0.1",
            { deviceBootstrap: false, identity: hostedIdentity }
          );
          if (enrollment?.schemaVersion !== "participant-bootstrap-v0.1"
              || typeof enrollment?.csrfToken !== "string") {
            const error = new Error(
              "The contribution service did not establish pseudonymous access."
            );
            error.code = "enrollment_response_invalid";
            throw error;
          }
          setCommunitySession({
            csrfToken: enrollment.csrfToken,
            participantId: enrollment.participantId ?? null,
            consentVersion: "privacy-safe-telemetry-v0.1"
          });
          enrollmentEstablished = true;
          return communityClient.createDevicePairing(false);
        });
      }
      await contributionConnectStep(
        "device_pairing",
        status,
        () => finishCommunityDevicePairing(pairing, status),
      );
      pairing = null;
      communityDevicePairedV1 = true;
    }
    // --- Local consent, and the first pass starts now. --------------------
    if (needsLocalApproval) {
      status.hidden = false;
      status.className = "participant-action-status";
      setLocalizedText(status, "consent.approving");
      const result = await localClient.approveIncrementalContribution(
        contributionSyncExactReview.reviewToken
      );
      if (result?.status !== "approved") {
        const error = new Error("The local companion did not record the approval.");
        error.code = "incremental_consent_failed";
        throw error;
      }
      incrementalConsentApproved = true;
      setLocalizedText(status, "consent.approved");
    } else {
      // The transparent re-pair: the local approval already stands, the
      // fresh claim recorded the grant, and the companion's pairing route
      // resumed and kicked the engine. Say what happened, not "failed".
      status.hidden = false;
      status.className = "participant-action-status";
      setLocalizedText(status, "consent.authorityRefreshed");
    }
    // The companion starts the first pass immediately on approval; read the
    // bounded status now and keep polling so the line shows live progress.
    await loadIncrementalSyncStatus().catch(() => {});
    scheduleIncrementalSyncStatusPoll({ reset: true });
  } catch (error) {
    if (contributionConnectStepOf(error) !== null
        && contributionSessionWasRejected(error)) {
      // The stored session was rejected mid-ceremony. This is the repair
      // loop's root (owner-reported, 2026-08-08): failure copy here repeated
      // on every load while the dead session survived. Render the sign-in
      // gate instead — once signed in, the ceremony resumes automatically.
      renderContributionSessionSignInGate(status);
    } else if (contributionConnectStepOf(error) !== null
        || contributionDeviceRecoveryIsRequired(error)) {
      await reportContributionConnectFailure(status, error, {
        enrollmentAttemptedWithHostedIdentity,
        enrollmentEstablished,
      });
    } else {
      await showFailure(status, {
        surface: "automatic_contribution",
        error,
        fallback:
          "The approval could not be recorded on this Mac, so nothing changed and nothing uploads automatically."
      });
    }
  } finally {
    incrementalConsentBusy = false;
    renderContributionActionState();
  }
}

/**
 * The silent authorization repair (owner-directed, 2026-08-08): when the
 * engine reports consent_rejected — the first upload came back 403
 * TELEMETRY_CONSENT_INVALID because the earlier claim carried the v0.1
 * consent — and this page holds the session, the ceremony re-runs by itself,
 * once per page load. The user approved this exact kind of data already; the
 * re-pair is transport repair, not a new decision, so it must not read as a
 * failure or ask again.
 */
function maybeRepairIncrementalAuthorization() {
  if (incrementalRepairAttempted) return;
  if (incrementalConsentBusy || communityConnectBusy) return;
  if (!incrementalSyncCapabilityAdvertised()) return;
  if (!incrementalConsentApproved || !incrementalGrantRejected()) return;
  if (!hasCommunitySession()) return;
  incrementalRepairAttempted = true;
  void approveIncrementalContribution();
}

/**
 * After a completed hosted sign-in, finish what the sign-in was for
 * (owner-reported repair loop, 2026-08-08): a Mac whose approval stands but
 * whose upload authority was refused resumes the connect ceremony immediately
 * with the fresh proof — the promised "sign in again to finish connecting
 * this Mac" journey ends here without another click. Only the repair path
 * resumes automatically; a Mac that never approved still gets its explicit
 * Review-and-approve action.
 */
function resumeContributionCeremonyAfterSignIn() {
  if (!incrementalSyncCapabilityAdvertised()) return;
  if (!incrementalConsentApproved || !incrementalGrantRejected()) return;
  if (incrementalConsentBusy || communityConnectBusy) return;
  void approveIncrementalContribution();
}

// Deletion honesty (owner-directed, 2026-08-08): the card no longer states a
// deletion promise without a control behind it. This is the control — the
// service's participant deletion (DELETE /api/v1/me), which purges accepted
// chunks and stored uploads and tombstones the account. It needs the live
// session, asks for explicit confirmation, and touches nothing local.
const CONTRIBUTION_DELETION_CONFIRMATION =
  "Delete everything you contributed?\n\nThe service deletes your contributed usage data and this account's records, and this Mac's upload authority stops working. Local reporting on this Mac is unchanged. This cannot be undone.";

async function deleteCommunityContributions() {
  if (incrementalConsentBusy || communityConnectBusy) return;
  if (!hasCommunitySession()) return;
  if (!window.confirm(CONTRIBUTION_DELETION_CONFIRMATION)) return;
  const status = $("#incremental-consent-status");
  incrementalConsentBusy = true;
  renderContributionActionState();
  status.hidden = false;
  status.className = "participant-action-status";
  setProductText(status, "Deleting your contributed data from the service…");
  try {
    await communityClient.deleteParticipant();
    // The account is tombstoned server-side: the session, the sign-in proof
    // and this Mac's pairing evidence are all dead with it.
    hostedIdentity = null;
    setCommunitySession(null);
    communityDevicePairedV1 = false;
    status.hidden = false;
    status.className = "participant-action-status";
    setProductText(
      status,
      "Deleted. The service removed your contributed data and this account's records. Local reporting on this Mac is unchanged.",
    );
    renderHostedIdentity();
    await loadIncrementalSyncStatus().catch(() => {});
  } catch (error) {
    await showFailure(status, {
      surface: "participant_deletion",
      error,
      fallback:
        "The service did not confirm the deletion, so nothing is assumed deleted. Try again."
    });
  } finally {
    incrementalConsentBusy = false;
    renderContributionActionState();
  }
}

function contributionDeviceRecoveryIsRequired(error) {
  try {
    return error?.code === "contribution_device_recovery_required"
      || error?.code === "contribution_device_credential_conflict";
  } catch {
    return false;
  }
}

// The service's three session-rejection codes: the stored browser session or
// its CSRF confirmation was not recognized — a session that predates the last
// service deploy, or one that expired server-side. Nothing about the user's
// approval or this Mac's queue is wrong when one of these comes back, so the
// honest next step is a fresh sign-in, never a retry with the same dead
// session (owner-reported repair loop, 2026-08-08).
const CONTRIBUTION_SESSION_REJECTION_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "CSRF_INVALID",
]);

function contributionSessionWasRejected(error) {
  try {
    return CONTRIBUTION_SESSION_REJECTION_CODES.has(error?.code);
  } catch {
    return false;
  }
}

/**
 * The one fallback for a rejected stored session (owner-reported repair loop,
 * 2026-08-08). The silent repair used to treat a session-rejected pairing
 * mint as a terminal step-2 failure, keep the dead session, and repeat the
 * identical failure on every load. A rejected session is not a failure the
 * user must interpret: clear the dead session and the stale identity proof,
 * say the one action that fixes it, and render the sign-in gate. The user's
 * approval still stands, and after the next sign-in the ceremony resumes by
 * itself — see resumeContributionCeremonyAfterSignIn.
 */
function renderContributionSessionSignInGate(status) {
  hostedIdentity = null;
  communityDevicePairedV1 = false;
  // Any auth rejection consumes this load's one automatic attempt: after the
  // gate, only an explicit user action — completing a sign-in, or pressing
  // Review and approve — may run the ceremony again (owner-reported repeated
  // AUTH_REQUIRED burst, 2026-08-08).
  incrementalRepairAttempted = true;
  // Clearing the session re-renders the approve surface, whose gate line now
  // asks for the sign-in; the guarded auto-repair cannot re-run without a
  // session, so this cannot loop.
  setCommunitySession(null);
  status.hidden = false;
  status.className = "participant-action-status";
  setLocalizedText(status, "consent.signInAgainToFinish");
  // One truth about being signed in (owner-reported contradictory state,
  // 2026-08-08): the identity card's status line is rewritten too, so a
  // stale "Signed in with Google" sentence cannot sit beside a "Not signed
  // in" chip after the proof and session were cleared.
  const identityStatus = $("#identity-signin-status");
  if (identityStatus) {
    identityStatus.hidden = false;
    identityStatus.className = "participant-action-status";
    setLocalizedText(identityStatus, "consent.signInAgainToFinish");
  }
  renderHostedIdentity();
}

async function renderContributionDeviceRecovery(status, { error } = {}) {
  const described = await describeFailure({
    surface: "contribution_connect",
    error,
    fallback: CONTRIBUTION_DEVICE_CONFLICT_COPY
  });
  const reset = node(
    "button",
    "button button-danger",
    "Reset this Mac's device credential"
  );
  reset.type = "button";
  reset.id = "reset-device-credential";
  reset.addEventListener("click", () => {
    void resetContributionDeviceCredential();
  });
  const action = node("a", "button button-secondary", "Open TiboTattle");
  if (SEMANTIC_OPEN_TARGET) {
    action.href = SEMANTIC_OPEN_TARGET;
  } else {
    action.hidden = true;
  }
  const actions = node("div", "contribution-cta-buttons");
  actions.append(reset, action);
  status.hidden = false;
  status.className = "participant-action-status error";
  status.replaceChildren(
    node(
      "strong",
      "",
      "This Mac has a leftover contribution-device credential."
    ),
    document.createTextNode(` ${described.text}`),
    node(
      "p",
      "annotation",
      "Resetting clears only that unusable credential and its local record. Then choose Review and approve again."
    ),
    actions
  );
  return described;
}

const DEVICE_CREDENTIAL_RESET_CONFIRMATION =
  "Clear this Mac's unusable contribution-device credential?\n\nThis clears only the leftover credential in this Mac's Keychain and its local record. Local reporting is unchanged.";

async function resetContributionDeviceCredential() {
  if (communityConnectBusy || incrementalConsentBusy) return;
  if (!window.confirm(DEVICE_CREDENTIAL_RESET_CONFIRMATION)) return;
  // The recovery reports on the merged ceremony's own status line
  // (owner-directed 2026-08-08: the separate connect card is gone).
  const status = $("#incremental-consent-status");
  communityConnectBusy = true;
  renderContributionActionState();
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Clearing the unusable local device credential…";
  try {
    const result = await localClient.resetContributionDeviceCredential();
    if (result.status === "unavailable") {
      // Carry a code: a codeless throw always fell through to the generic
      // "the cause was not reported in a form this page can explain".
      const error = new Error("The local companion did not confirm the reset.");
      error.code = "device_credential_reset_failed";
      throw error;
    }
    status.textContent = result.status === "already_absent"
      ? "No leftover device credential was present. Choose Review and approve to continue."
      : "The leftover device credential was cleared. Choose Review and approve again.";
  } catch (error) {
    await showFailure(status, {
      surface: "device_credential_reset",
      error,
      fallback:
        "The leftover device credential could not be cleared. Nothing was deleted on this Mac or in the service."
    });
  } finally {
    communityConnectBusy = false;
    renderContributionActionState();
  }
}

async function finishCommunityDevicePairing(pairing, status) {
  if (typeof pairing?.pairingCode !== "string") {
    const error = new Error("The service did not return a one-use pairing capability.");
    error.code = "contribution_device_pairing_response_invalid";
    throw error;
  }
  const paired = await localClient.pairContributionDevice(pairing.pairingCode);
  if (paired.status !== "paired") {
    const error = new Error("The local app did not accept the upload-only pairing.");
    error.code = "contribution_device_pairing_response_invalid";
    throw error;
  }
  communityDevicePaired = true;
  status.textContent =
    `This Mac is connected through ${formatLocal(paired.expiresAt)}. Nothing was uploaded.`;
  return paired;
}

/**
 * The named steps of "connect this Mac", each with its own progress line and
 * its own honest failure sentence.
 *
 * Six distinct operations used to share one try/catch and one fallback
 * sentence, so every failure — a build with no service configured, a rejected
 * hosted proof, a refused local pairing, an unreadable local queue — produced
 * the same paragraph. That made the actual failing step unidentifiable, which
 * is why "submitting still seems to not be working" could not be narrowed
 * down. Each step now reports itself.
 *
 * `connects` marks the steps that must succeed before this Mac counts as
 * connected. Anything after that point is a local follow-up: it must never
 * claim the connection failed.
 */
const CONTRIBUTION_CONNECT_STEPS = Object.freeze({
  service_check: Object.freeze({
    connects: true,
    progress: "Checking that this build has a contribution service…",
    stopped: "Connecting stopped at step 1 of 3, checking the contribution service.",
    failure:
      "This build is not paired with a contribution service, so there is nothing to connect to. Nothing was uploaded and local reporting is unaffected.",
  }),
  hosted_enrollment: Object.freeze({
    connects: true,
    progress: "Creating pseudonymous contribution access…",
    stopped: "Connecting stopped at step 2 of 3, creating pseudonymous contribution access.",
    failure:
      "The contribution service did not establish pseudonymous access. Nothing was uploaded; sign in again and retry.",
  }),
  device_pairing: Object.freeze({
    connects: true,
    progress: "Connecting this Mac as an upload-only device…",
    stopped: "Connecting stopped at step 3 of 3, pairing this Mac as an upload-only device.",
    failure:
      "The pairing was not completed, so this Mac is not connected. Nothing was uploaded; retrying is safe.",
  }),
  // The queue_refresh follow-up step left with the separate connect flow
  // (owner-directed, 2026-08-08): the merged ceremony's review bootstrap owns
  // the queue and reports its own failures on the same surface.
});

/**
 * Run one named step, tagging any failure with the step it came from.
 *
 * The tag is what lets the single reporting site name the failing step and
 * choose that step's own fallback sentence, instead of collapsing six
 * different situations into one generic paragraph.
 */
async function contributionConnectStep(stepId, status, run) {
  const step = CONTRIBUTION_CONNECT_STEPS[stepId];
  status.hidden = false;
  status.className = "participant-action-status";
  setProductText(status, step.progress);
  try {
    return await run();
  } catch (error) {
    const tagged = error instanceof Error ? error : new Error("Step failed.");
    tagged.contributionStep = stepId;
    throw tagged;
  }
}

function contributionConnectStepOf(error) {
  const stepId = error?.contributionStep;
  return typeof stepId === "string"
    && Object.hasOwn(CONTRIBUTION_CONNECT_STEPS, stepId)
    ? CONTRIBUTION_CONNECT_STEPS[stepId]
    : null;
}

// (connectCommunityContribution and its openIncrementalConsent routing left
// with the two-card flow, owner-directed 2026-08-08: the merged ceremony in
// approveIncrementalContribution owns enrollment, the v1.0-consent pairing,
// and the local approval in one interaction.)

/**
 * Report one connect failure, naming the step it came from.
 *
 * The step's own sentence is the fallback, so an error code this page has
 * never seen still produces "step 3 of 3, connecting this Mac as an
 * upload-only device: …" rather than "the cause was not reported in a form
 * this page can explain".
 */
async function reportContributionConnectFailure(status, error, {
  enrollmentAttemptedWithHostedIdentity,
  enrollmentEstablished,
}) {
  if (contributionDeviceRecoveryIsRequired(error)) {
    await renderContributionDeviceRecovery(status, { error });
    return;
  }
  const step = contributionConnectStepOf(error);
  const retryNeedsFreshSignIn = enrollmentAttemptedWithHostedIdentity
    && !enrollmentEstablished
    && hostedIdentity !== null;
  if (retryNeedsFreshSignIn) {
    hostedIdentity = null;
    renderHostedIdentity();
  }
  const described = await describeFailure({
    surface: "contribution_connect",
    error,
    fallback: step?.failure
      ?? "This Mac could not be connected, and no evidence was uploaded. Retrying is safe."
  });
  // The step is stated even when the code itself is explainable. Knowing that
  // pairing failed rather than enrolling is the part that was missing.
  const stepLine = step === null ? "" : `${step.stopped} `;
  status.hidden = false;
  status.className = "participant-action-status error";
  status.textContent = `${stepLine}${described.text}`;
  if (retryNeedsFreshSignIn) {
    setLocalizedText(status, "contribution.signInDiscarded", {
      message: `${stepLine}${described.text}`,
    });
  }
}

// The preparation preflight estimate and its lookback picker left with the
// prepare surface (owner-directed, 2026-08-08). Size limits are enforced by
// the companion itself during the silent review bootstrap, which narrows the
// window on export_too_large instead of asking the reader to.

async function loadCommunityResults() {
  const centralConfigured = localCompanionHealth === null
    || localCompanionHealth?.capabilities?.centralServiceProxy === true;
  if (!centralConfigured) {
    communityServiceHealth = null;
    renderHostedIdentity();
    return;
  }
  try {
    communityServiceHealth = await communityClient.health();
  } catch {
    communityServiceHealth = null;
  }
  renderHostedIdentity();
}

async function restoreCommunitySession() {
  try {
    const session = await communityClient.session();
    if (typeof session?.csrfToken !== "string") return;
    setCommunitySession({
      csrfToken: session.csrfToken,
      participantId: session.participantId ?? null,
      consentVersion: session.consentVersion ?? null
    });
  } catch {
    setCommunitySession(null);
  } finally {
    // A restored host-only session is already sufficient for protected
    // browser actions and device pairing. Reflect it as a generic signed-in
    // state instead of falsely showing a Google/Apple choice or asking for a
    // redundant browser ceremony after every reload.
    renderHostedIdentity();
  }
}

$("#refresh-button").addEventListener("click", requestRefresh);
$("#setup-refresh").addEventListener("click", requestRefresh);
$("#cancel-refresh").addEventListener("click", cancelLocalAnalysis);
$("#open-installed-app").addEventListener("click", openInstalledApp);
$("#connection-check").addEventListener("click", checkLocalSetup);
$("#companion-check").addEventListener("click", checkLocalSetup);
$("#setup-check-again").addEventListener("click", checkLocalSetup);
$("#identity-google-signin").addEventListener("click", () => {
  void beginHostedSignIn("google");
});
$("#identity-apple-signin").addEventListener("click", () => {
  void beginHostedSignIn("apple");
});
$("#identity-signout").addEventListener("click", () => {
  void signOutHostedIdentity();
});
$("#identity-signin-check").addEventListener("click", checkHostedSignInNow);
$("#identity-signin-cancel").addEventListener("click", cancelHostedSignIn);
window.addEventListener("tibotattle:hosted-sign-in-return", checkHostedSignInNow);
// Reactivation hooks for the persisted handoff (owner-reported orphaned
// proof, 2026-08-08): the deep-link return, the page becoming visible again,
// and the window regaining focus each try to collect a pending sign-in this
// page (or its pre-reload incarnation) started. The resume self-guards, so
// overlapping activations cannot race the one-time read-back.
window.addEventListener("tibotattle:hosted-sign-in-return", () => {
  void resumePendingHostedSignIn();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void resumePendingHostedSignIn();
});
window.addEventListener("focus", () => {
  void resumePendingHostedSignIn();
});
window.addEventListener("tibotattle:local-evidence-updated", () => {
  void reloadLocalEvidenceAfterNativeRefresh();
});
// The connect-consent checkbox, the connect button and "Not now" left with
// the two-card flow (owner-directed, 2026-08-08): after sign-in, the single
// Review-and-approve button below is the one contribution action, and its
// explicit approval is the consent.
$("#demo-button").addEventListener("click", () => renderDashboard(demoDashboard()));
// The prepare, lookback, and send controls left with the legacy prepare flow
// (owner-directed, 2026-08-08). The approve card's only companion control is
// the error-recovery re-check for its invisible review bootstrap.
$("#incremental-review-retry").addEventListener("click", () => {
  void retryIncrementalReviewBootstrap();
});
$("#incremental-consent-approve").addEventListener("click", () => {
  void approveIncrementalContribution();
});
$("#delete-contributions").addEventListener("click", () => {
  void deleteCommunityContributions();
});
$("#range-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-days]");
  if (!button || !dashboard) return;
  activeUsageRangeDays = Number(button.dataset.days);
  for (const control of $("#range-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  // Choosing a date range restates what the chart should cover, so a zoom left
  // over from the previous range cannot survive it. This is the same rule the
  // calibration range control follows.
  resetUsageTimelineViewport();
  renderUsageTimeline(dashboard);
  renderComparison(dashboard);
});
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
  if (dashboard) renderUsageTimeline(dashboard);
});
$("#calibration-range-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-days]");
  if (!button || !dashboard) return;
  activeCalibrationRangeDays = Number(button.dataset.days);
  for (const control of $("#calibration-range-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetTimelineViewport();
  renderTimeline(dashboard);
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
  if (dashboard) renderTimeline(dashboard);
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
  renderUsageTimeline(dashboard);
});
$("#weekly-range-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-days]");
  if (!button || !dashboard) return;
  activeWeeklyRangeDays = Number(button.dataset.days);
  for (const control of $("#weekly-range-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  // renderWeekly itself re-renders the share card from the same model
  // (owner-verified regression, 2026-08-08), so a control cannot redraw the
  // chart while leaving the card on the previous filters.
  renderWeekly(dashboard);
});
$("#weekly-span-control").addEventListener("input", (event) => {
  if (!dashboard) return;
  activeWeeklyMinimumObservedSpanPp = Math.min(99, Math.max(0, Number(event.target.value)));
  renderWeekly(dashboard);
});
$("#accounting-period-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-period]");
  if (!button || !dashboard) return;
  const available = new Set(
    (Array.isArray(dashboard.accounting?.periods) ? dashboard.accounting.periods : [])
      .map((period) => period?.periodId),
  );
  if (!available.has(button.dataset.period) || button.disabled) {
    syncAccountingPeriodControls(dashboard);
    return;
  }
  activeAccountingPeriod = button.dataset.period;
  renderAccounting(dashboard);
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
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
});
document.addEventListener("scroll", () => {
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
}, true);

mountDashboardNavigation({
  documentRef: document,
  windowRef: window,
});

async function bootstrapDashboard() {
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  renderHostedIdentity();
  updateLocalActionButtons();
  await loadLocalDashboard();
  if (
    localCompanionHealth === null
    || localCompanionHealth?.capabilities?.centralServiceProxy === true
  ) {
    await restoreCommunitySession();
  }
  await loadCommunityResults();
  // A sign-in the pre-reload page started but never read back is collected
  // now, while its five-minute handoff is still valid (owner-reported
  // orphaned proof, 2026-08-08).
  void resumePendingHostedSignIn();
  scheduleReturningUserRefresh();
}

bootstrapDashboard();
