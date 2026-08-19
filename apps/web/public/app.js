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
  normalizeIncrementalContributionSyncStatus,
  selectPrimaryCodexQuotaWindow
} from "./data-client.js";
import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  createDiagnosticReference,
  createLatestContributionReviewFence,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  contributionReviewBootstrapAction,
  detectDeviationPeriods,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  isContributionReviewableQueueState,
  refreshNeedsContinuation,
  serviceRequestId,
  withContributionReviewDeadline,
  validateContributionForUpload
} from "./lib.js";
import {
  mountDashboardNavigation,
} from "./navigation.js";
import {
  renderInstallerJourney as renderSharedInstallerJourney,
} from "./install-cta.js";
import {
  COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT,
  createBrowserLocalization,
} from "./localization.js";
import {
  TELEMETRY_PLAN_TYPES,
} from "./telemetry-shared.generated.js";
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
const cacheContinuityGapTablePagination = { page: 0, signature: "" };
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
// A timed-out loopback operation can still finish after the UI exposes its
// retry. Only the newest generation may commit preview/review state, so an old
// response can never overwrite the result of Check again or a fresh approval.
const contributionReviewFence = createLatestContributionReviewFence();
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
// The optional lastOutcome.detail.code the 0.1.2 companion records beside the
// bare outcome code, so "Last error: device credential unavailable" can be
// stated instead of an anonymous "run_failed". The bounded normalizer keeps
// its fixed three-field outcome, so the page reads the raw projection once
// and holds only this one fixed-vocabulary code beside it.
let incrementalSyncLastOutcomeDetailCode = null;
// The manual "Retry now" lever against an inherited retry backoff
// (owner-directed 2026-08-10): POST incremental-run, render its projection.
let incrementalSyncRetryBusy = false;
// The invisible review bootstrap prepares one real instance of the covered
// data at most once per queue state, so a failing preparation cannot loop;
// trying again is the explicit "Check again" action.
let incrementalReviewPrepareAttempted = false;
// A missing/unusable queue preview used to strand the approve button without
// producing either recovery UI or a diagnostics file. Record each distinct
// unavailable state once per page load; an explicit Check again resets it.
let contributionReviewUnavailableKey = null;
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
// When THIS page last minted a fresh community session (the enrollment adopts
// one in the same ceremony). A session-rejection on a pairing mint fired
// milliseconds after this is the WKWebView cookie-commit race, not a dead
// stored session, so the sign-in gate must not discard the session this
// ceremony just established (owner-reported "the sign-in that just worked was
// thrown away", 2026-08-10). Restored or stored sessions leave this null: only
// a mint records a timestamp, so an old session is never mistaken for fresh.
let communitySessionMintedAt = null;
// The opaque sign-in proof lives only in this module-scoped memory; it is
// never persisted to storage and disappears with the tab. Only its bounded
// state+verifier recovery handle is persisted below.
let hostedIdentity = null;
let hostedIdentityBusy = false;
// A single page-local attempt owns the short polling loop. It is never stored
// with the opaque proof and lets the user cancel a stalled browser handoff
// without waiting for the server's authorization expiry.
let activeHostedSignIn = null;
// Clearing the durable handoff is asynchronous. Fence that short interval so
// a second sign-in cannot store a new state+verifier immediately before the
// first attempt's cancellation clears the shared recovery file.
let hostedSignInCancellationInFlight = false;
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
    // A cleared session is no longer freshly minted, so a later rejection is a
    // genuine dead-session gate rather than the mint race.
    communitySessionMintedAt = null;
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
 * A share for a table column, always at one decimal place.
 *
 * `formatPercent` drops to whole numbers whenever the value happens to be an
 * integer, which is right for a sentence and wrong for a column: it renders
 * "20%" directly above "20.9%", so the decimal point moves down the page and
 * two figures that exist to be compared have to be read digit by digit. Here
 * the precision is fixed, and the same bounded "<" idiom keeps a sliver from
 * rendering as an exact zero it is not.
 *
 * Returns `null` when the denominator cannot carry a share at all, so callers
 * withhold the cell rather than printing a share of nothing.
 */
function formatSharePercent(part, whole) {
  const numerator = finite(part);
  const denominator = finite(whole);
  if (numerator === null || denominator === null || denominator <= 0) return null;
  if (numerator < 0) return null;
  const percentFormatter = numberFormatter({
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    style: "percent",
  });
  const format = (amount) => percentFormatter.format(amount / 100);
  const value = numerator / denominator * 100;
  const rendered = format(value);
  if (value > 0 && rendered === format(0)) return `<${format(.1)}`;
  if (value < 100 && rendered === format(100)) return `>${format(99.9)}`;
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

function matchedRollingPairs(data) {
  if (data.timeline?.usage?.length) {
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

function renderComparison(data) {
  const matchedPairs = matchedRollingPairs(data);
  const pair = matchedPairs.at(-1) ?? null;
  const summary = data.gradient.summary ?? {};
  const weeklySummary = data.weekly.summary ?? {};
  const legacyDemo = data.mode === "demo";
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
// Codex's own KnownPlan vocabulary (TELEMETRY_PLAN_TYPES) verbatim, so the
// card never invents a plan label. The usage multiplier is intrinsic to the
// plan (pro = 20x, prolite = 5x), so a plan that documents one states it
// inline; a plan that documents none is named without a fabricated number.
// "unknown" is Codex's sentinel for an unnamed plan and is deliberately
// absent, so it — like any unmapped or empty reading — draws no chip.
const SHARE_CARD_PLAN_LABELS = Object.freeze({
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro (20×)",
  prolite: "Pro Lite (5×)",
  business: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  team: "Team",
  edu: "Edu",
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
  // The activity figure follows the usage chart's selected date range
  // (owner-directed, 2026-08-10) whenever the accounting periods carry that
  // range; the pricing fallback preserves the old 7-day-selected behavior
  // for payloads without per-period accounting (the demo fixture among them).
  const fastMode = activity?.fastMode ?? pricing.fastMode ?? {};
  // The share card's third figure is specifically the weekly reset fit. Do
  // not substitute the older general-gradient summary here: both are API-price
  // equivalents, but their evidence source and denominator are different.
  const summary = data?.weekly?.summary ?? {};

  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = shareCardWindowKind(allowanceWindow) === "seven_day";
  const remaining = finite(allowanceWindow?.remainingPercent);
  const windowLabel = shareCardWindowLabel(allowanceWindow);
  // The reader's most-recent plan, read from the same bounded plan_type enum
  // the quota cards use. "" leaves the header chip off entirely.
  const planLabel = shareCardPlan(data?.quotaWindows ?? []);

  const weighted = activity !== null
    ? activity.quotaWeightedTotalCostUsd
    : finite(pricing.quotaWeightedTotalCostUsd);
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  const spend = useWeighted
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
      label: t("share.stat.recordedActivity"),
      value: spend === null ? t("share.value.notAvailable") : formatMoney(spend, 0),
      // The "event-time API equivalent" caption is gone (owner-directed,
      // 2026-08-10): the detail line states the selected range and nothing
      // else.
      detail: spend === null ? t("share.detail.noPricedUsage") : period,
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
  // The caveat qualifies the figure actually printed, so it reads the same
  // selected range the activity stat does.
  const coverage = activity !== null
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
    plan: planLabel === "" ? "" : t("share.plan", { plan: planLabel }),
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
  const selected = SHARE_CARD_RANGE_PERIODS[rangeDays]
    ?? { id: "all", labelKey: "share.period.allRecorded" };
  const period = (Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : []).find((row) => row?.periodId === selected.id) ?? null;
  if (period === null) return null;
  const events = finite(period.events, 0);
  const priced = finite(period.pricingCoverage?.fullyPricedEvents, 0)
    + finite(period.pricingCoverage?.partiallyPricedEvents, 0);
  return {
    labelKey: selected.labelKey,
    totalCostUsd: finite(period.apiPriceEquivalentUsd),
    quotaWeightedTotalCostUsd:
      finite(period.quotaWeightedApiPriceEquivalentUsd),
    fastMode: period.fastMode ?? {},
    coveragePercent: events > 0
      ? Number(((priced / events) * 100).toFixed(6))
      : null,
  };
}

function renderShareCard(data, { history: sharedHistory = null } = {}) {
  const canvas = $("#share-card-canvas");
  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = shareCardWindowKind(allowanceWindow) === "seven_day";
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

function liveTimelinePoints(
  data,
  {
    windowHours = CALIBRATION_WINDOW_HOURS,
    rangeDays = activeCalibrationRangeDays,
    usage = data.timeline.usage,
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
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    const currentWeightedCost = weightedCosts[index];
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
    if (endMs < cutoff) continue;
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
    const bracketed = before && after
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
    const evidence = windowWeightingGaps === 0
      ? classifiedEvidence
      : { status: "quota_weighting_unavailable", residual: null };
    let cumulativeResidual = null;
    // A re-anchor marks the first drift observation of a new reset or track:
    // the deviation-period detector splits its runs here, so a sustained drift
    // that crosses a boundary is never read as one continuous period across the
    // reset. Stamped on the point so the flag survives viewport filtering.
    let driftReanchor = false;
    if (capacity !== null && capacity > 0
        && currentWeightedCost !== null
        && after !== null
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
      // Kept under the legacy internal key for downstream chart diagnostics,
      // but this is now the selected quota-weighted amount, never Standard
      // dollars paired with a Fast-adjusted capacity.
      apiCostUsd: windowWeightingGaps === 0 ? windowCostUsd : null,
      allowanceWeightedUsd: windowWeightingGaps === 0
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
  return points.map((point) => {
    const endMs = Date.parse(point.periodEndAt ?? point.timestamp);
    const observationMatch = quotaLookup.atOrBefore(endMs);
    const observationAge = observationMatch
      ? endMs - observationMatch.timestampMs
      : Number.POSITIVE_INFINITY;
    return {
      ...point,
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
  setLocalizedText(
    $("#usage-cost-legend-label"),
    quotaComparable
      ? "chart.series.quotaWeightedUsage"
      : "chart.series.standardApiUsage",
  );
  $("#usage-allowance-legend").hidden = !quotaComparable;
  setLocalizedText(
    $("#usage-timeline-title"),
    quotaComparable ? "chart.usage.heading" : "chart.usage.standardHeading",
    {
    unit,
    range: tPlural("format.durationDay", activeUsageRangeDays, {
      count: formatDecimal(activeUsageRangeDays, 0),
    }),
    },
  );
  if (!visiblePoints.length) {
    shell.hidden = true;
    empty.hidden = false;
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
        // Dense per-interval samples: dots would merge into a solid band, so
        // the line carries the shape and each sample stays hoverable. This is
        // the opposite of the allowance history chart, on purpose.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: (value) => formatApiMoney(value),
      }],
      yLabel: axisLabels.primary,
      secondarySeries: quotaComparable ? [{
        key: "allowanceRemaining",
        className: "chart-line-allowance",
        label: { key: "chart.series.sevenDayAllowanceRemaining" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
      }] : [],
      secondaryYLabel: quotaComparable ? axisLabels.secondary : null,
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
  // The plotted weighted series already renders a missing interval as a gap.
  // Its summary must do the same: adding only finite points would publish a
  // deceptively partial allowance-facing aggregate.
  const total = completeUsageTimelineTotal(
    visiblePoints,
    quotaComparable ? "quotaWeightedCostUsd" : "standardApiCostUsd",
  );
  for (const [name, explanation, value] of [
    [
      "Time intervals",
      "The number of displayed hour, day, or week intervals.",
      compact(visiblePoints.length)
    ],
    [
      quotaComparable
        ? "Quota-weighted API equivalent"
        : "Standard-rate API-price equivalent",
      quotaComparable
        ? "Standard API prices adjusted by the observed or selected Codex speed mode, compared only with a capacity fitted on the same basis. It is not a bill."
        : "A Standard-rate accounting series. Provider allowance is hidden because no matching weighted capacity is available.",
      total === null ? "Unavailable" : formatApiMoney(total)
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
  const sideChatAdjusted = data.accounting?.sideChatEstimates?.status
      === "available"
    && data.accounting.sideChatEstimates.methodology
      ?.includedInCalibrationTimeline === true
    && Array.isArray(data.timeline.calibrationUsage)
    && data.timeline.calibrationUsage.length > 0;
  const exactByBucket = new Map(data.timeline.usage.map((row) => [
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
              assumedFromPreferenceEvents: 0,
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
      : data.timeline.usage,
  });
  // Retained gradient artifacts carry only Standard-rate rolling cost. They
  // can remain historical evidence elsewhere, but may never replace the
  // quota-weighted allowance comparison. An unavailable weighted live series
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

function renderTimeline(data) {
  const {
    points,
    baselinePoints,
    usingLive,
    sideChatAdjusted,
  } = selectedTimelinePoints(data);
  const viewport = normalizeTimelineViewport(points);
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
  renderTimelineSummary(data, visiblePoints, visibleBaselinePoints, usingLive);
  renderTimelineConfidence(points, visiblePoints, usingLive, viewport);
  renderResiduals(data, visiblePoints, viewport);
  // The divergence panel reads the whole selected calibration range, not the
  // zoomed viewport: it answers "across this range, where did observed and
  // priced usage persistently disagree", so pan and zoom must not reshape it.
  renderDivergencePeriods(data, points);
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
  over: "Over pace",
  on: "On pace",
  under: "Under pace",
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
 * active rate stays on the card as the without-pausing edge, drawn as a
 * separate mark on the track.
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
function weeklyPaceTrack(standing, hoursToReset, activePace, remainingPercent) {
  const hoursLeft = finite(hoursToReset);
  if (!standing || hoursLeft === null || hoursLeft <= 0) return null;
  const coveredShare = Math.max(0, Math.min(1, standing.coveredHours / hoursLeft));
  const track = node("div", "weekly-pace-track");
  const bar = node("div", "weekly-pace-track-bar");
  const covered = node("div", "weekly-pace-track-covered");
  covered.style.inlineSize = `${(coveredShare * 100).toFixed(2)}%`;
  bar.append(covered);

  // The engine's active-interval pace, drawn only where it would run the
  // allowance out sooner than the headline rate does. It is the edge of the
  // estimate, not the estimate: it answers "and if I do not stop?".
  const remaining = finite(remainingPercent);
  const active = finite(activePace);
  const flatOutHours = active !== null && active > 0 && remaining !== null
    ? remaining / active
    : null;
  let flatOutLabel = null;
  if (flatOutHours !== null && flatOutHours < standing.coveredHours * .95) {
    const flatOutShare = Math.max(0, Math.min(1, flatOutHours / hoursLeft));
    const mark = node("div", "weekly-pace-track-mark");
    mark.style.insetInlineStart = `${(flatOutShare * 100).toFixed(2)}%`;
    bar.append(mark);
    flatOutLabel = formatForecastDuration(flatOutHours);
  }

  const resetDuration = formatForecastDuration(hoursLeft);
  const coveredDuration = formatForecastDuration(standing.coveredHours);
  const dryDuration = formatForecastDuration(standing.dryHours);
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    // Whether a gap exists is arithmetic, not a state name: the on-pace band
    // straddles the point where the allowance lands exactly on the reset, so
    // an on-pace card can still end with a short dry stretch.
    dryDuration
      ? `Of the ${resetDuration ?? "time"} left before the reset, the remaining allowance covers about ${coveredDuration ?? "none of it"}, leaving about ${dryDuration} with none left.`
      : `The remaining allowance covers all ${resetDuration ?? "of the time"} left before the reset.`,
  );

  const scale = node("div", "weekly-pace-track-scale");
  scale.append(
    node("span", "", "Now"),
    node(
      "span",
      "weekly-pace-track-scale-end",
      resetDuration ? `Reset in ${resetDuration}` : "Reset",
    ),
  );
  track.append(bar, scale);
  if (flatOutLabel) {
    track.append(node(
      "p",
      "weekly-pace-track-note",
      `The mark is where the allowance ends if the recent active pace continues without a pause: about ${flatOutLabel} from now.`,
    ));
  }
  return track;
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
  if (available && (etaAt === null || etaAt <= now || etaAt > resetAt)) return;
  if (!available && !reachesResetFirst && !collectingEvidence) return;
  if (collectingEvidence && remaining === null) return;
  if (!collectingEvidence
      && remaining === null
      && headlinePace === null
      && !reachesResetFirst) return;

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
  const paceState = standing?.state
    ?? (collectingEvidence ? null : reachesResetFirst ? "under" : null);
  const projectedEtaAt = standing !== null && standing.state === "over"
    ? now + standing.coveredHours * 3_600_000
    : null;

  const title = node("h3", "weekly-pace-forecast-title");
  const cardId = "weekly-pace-forecast-title";
  title.id = cardId;
  title.textContent = collectingEvidence
    ? "Pace estimate ready after one more refresh"
    : paceState === "over"
      ? projectedEtaAt === null
        ? "At this pace the weekly allowance runs out before the reset"
        : `At this pace the weekly allowance runs out ${formatReportingTime(projectedEtaAt)}`
      : paceState === "on"
        ? "At this pace the weekly allowance runs close to the reset"
        : "At this pace the weekly allowance lasts to the reset with room to spare";
  card.setAttribute("aria-labelledby", cardId);

  const heading = node("div", "weekly-pace-forecast-heading");
  heading.append(
    node(
      "p",
      "panel-kicker",
      collectingEvidence ? "Collecting forecast evidence" : "Forecast from recent pace",
    ),
  );
  if (collectingEvidence) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-collecting-chip",
      "One more refresh",
    ));
  } else if (paceState) {
    // The standing is named in words on the chip as well as carried in the
    // card's colour, so the over/on/under reading survives a monochrome
    // screen, a colour-vision difference and a screen reader alike.
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-state-chip",
      PACE_STATE_LABELS[paceState],
    ));
  }
  if (earlyEstimate) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-early-chip",
      "Early estimate",
    ));
  }

  const ratioLabel = standing === null ? null : formatPaceRatio(standing.ratio);
  const dryDuration = standing === null
    ? null
    : formatForecastDuration(standing.dryHours);
  const copy = node("p", "weekly-pace-forecast-copy");
  copy.textContent = collectingEvidence
    ? "One clean weekly allowance observation is saved. The next fresh observation for this account and reset will establish its pace."
    : standing === null
      ? "Recent allowance movement is not fast enough to exhaust this window before its reset."
      : standing.state === "over"
        ? `Recent use is running about ${ratioLabel} the pace this window can still sustain${dryDuration ? `, which leaves roughly ${dryDuration} with none left before the reset` : ""}.`
        : standing.state === "on"
          ? `Recent use is close to the pace this window can still sustain, so the allowance should land near the reset with little to spare.`
          : `Recent use is running about ${ratioLabel} the pace this window can still sustain, so some of the allowance should still be unused at the reset.`;
  if (earlyEstimate) {
    copy.textContent += " This is an early estimate from a small amount of recent evidence; it will settle as more observations arrive.";
  }

  const metrics = node("div", "weekly-pace-forecast-metrics");
  const addMetric = (label, value) => {
    const item = node("div", "weekly-pace-forecast-metric");
    item.append(node("span", "", label), node("strong", "", value));
    metrics.append(item);
  };
  if (remaining !== null) addMetric("Allowance left", formatPercent(remaining));
  const resetDuration = formatForecastDuration(hoursToReset);
  if (resetDuration) addMetric("Reset", `in ${resetDuration}`);
  if (collectingEvidence) {
    addMetric("Evidence", "1 saved");
  } else if (dryDuration) {
    // A dry stretch and spare allowance are mutually exclusive, and the tile
    // reports whichever one the reading actually produced rather than pinning
    // itself to the state name.
    addMetric("Nothing left for", dryDuration);
  } else if (standing !== null) {
    addMetric("Spare at reset", formatPercent(standing.sparePercent));
  } else if (headlinePace !== null && headlinePace > 0) {
    addMetric("Recent pace", `${formatDecimal(headlinePace, 1)} pp/hour`);
  }

  const track = collectingEvidence
    ? null
    : weeklyPaceTrack(standing, hoursToReset, rates.active, remaining);

  // The evidence line names both rates. A reader who wondered why the old
  // card's forecast kept arriving early can see the difference between the
  // pace with idle time counted and the pace while working, instead of being
  // handed one number with no way to tell which it was.
  const observationDuration = formatForecastDuration(paceElapsedHours);
  const rateSentences = [];
  if (rates.average !== null) {
    rateSentences.push(`${formatDecimal(rates.average, 1)} pp/hour overall`);
  }
  if (rates.active !== null) {
    rateSentences.push(`${formatDecimal(rates.active, 1)} pp/hour while active`);
  }
  const evidence = observations !== null && observations >= 1
    ? node(
      "p",
      "weekly-pace-forecast-evidence",
      collectingEvidence
        ? "One fresh allowance observation is saved for this weekly reset."
        : `Based on ${formatDecimal(Math.round(observations), 0)} recent allowance observation${Math.round(observations) === 1 ? "" : "s"}${observationDuration ? ` over ${observationDuration}` : ""}${rateSentences.length > 0 ? `: ${rateSentences.join(", ")}` : ""}.`,
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
  card.append(heading, title, copy, metrics);
  if (track) card.append(track);
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

// The Allowance page's reset-estimate table pages through its full row set
// (owner-directed 2026-08-10) instead of truncating to the newest fourteen:
// twenty rows per page, newest first, same pager idiom as the exact-windows
// inspection table. The state lives beside its renderers so the render
// harness that extracts this section gets the whole mechanism.
const WEEKLY_TABLE_PAGE_SIZE = 20;
let weeklyTablePage = 0;
let weeklyTableRows = [];
let weeklyTableSignature = "";

function renderWeeklyTable(values) {
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
    const cell = node("td", "empty-cell", t("weekly.table.empty"));
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

function cacheSwitchMetricValue(impact) {
  if (impact?.status !== "available") return "—";
  const weighting = impact.allowanceWeighting;
  if (weighting?.status === "complete") {
    const premium = finite(weighting.selectedPremiumUsd, null);
    return premium === null ? "—" : formatApiMoney(premium);
  }
  if (weighting?.status === "range") {
    const lower = finite(weighting.rangePremiumUsd?.lower, null);
    const upper = finite(weighting.rangePremiumUsd?.upper, null);
    return lower === null || upper === null
      ? "—"
      : `${formatApiMoney(lower)}–${formatApiMoney(upper)}`;
  }
  return "—";
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

function renderAccountingCacheSwitchDetails(impact) {
  const disclosure = $("#cache-switch-details");
  const rows = $("#cache-switch-rows");
  if (!disclosure || !rows) return;
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
      cacheSwitchDataCell(
        "",
        formatLocal(item.observedAt),
        "accounting.cacheSwitch.column.localTime",
      ),
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

function appendCacheContinuityAllowance(container, impact) {
  if (finite(impact?.standardApiPremiumUsd, null) !== null) {
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
  if (impact.coverageStatus === "complete"
      && finite(impact.unpricedDrops, 0) === 0) {
    appendCacheContinuityAllowance(container, impact);
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

const CACHE_CONTINUITY_GAP_BAND_UI = Object.freeze([
  Object.freeze({
    id: "under_one_minute",
    labelKey: "accounting.cacheContinuity.gapBand.underOneMinute",
  }),
  Object.freeze({
    id: "one_to_five_minutes",
    labelKey: "accounting.cacheContinuity.gapBand.oneToFiveMinutes",
  }),
  Object.freeze({
    id: "five_to_thirty_minutes",
    labelKey: "accounting.cacheContinuity.gapBand.fiveToThirtyMinutes",
  }),
  Object.freeze({
    id: "thirty_minutes_to_one_hour",
    labelKey: "accounting.cacheContinuity.gapBand.thirtyMinutesToOneHour",
  }),
  Object.freeze({
    id: "one_to_six_hours",
    labelKey: "accounting.cacheContinuity.gapBand.oneToSixHours",
  }),
  Object.freeze({
    id: "six_to_twenty_four_hours",
    labelKey: "accounting.cacheContinuity.gapBand.sixToTwentyFourHours",
  }),
  Object.freeze({
    id: "over_twenty_four_hours",
    labelKey: "accounting.cacheContinuity.gapBand.overTwentyFourHours",
  }),
]);

function cacheContinuityGapBandSummaries(impact) {
  if (impact?.status !== "available"
      || (impact.coverageStatus !== "complete"
        && impact.coverageStatus !== "incomplete")
      || typeof impact.byGapBand !== "object"
      || impact.byGapBand === null
      || Array.isArray(impact.byGapBand)) return null;
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const summaries = [];
  for (const band of CACHE_CONTINUITY_GAP_BAND_UI) {
    if (!Object.hasOwn(impact.byGapBand, band.id)) return null;
    const summary = impact.byGapBand[band.id];
    const premium = summary?.estimatedPremiumUsd;
    if (typeof summary !== "object"
        || summary === null
        || Array.isArray(summary)
        || !validCount(summary.cacheReadDrops)
        || !validCount(summary.comparableReturns)
        || !validCount(summary.lostCacheTokens)
        || !validCount(summary.pricedDrops)
        || !validCount(summary.unpricedDrops)
        || summary.cacheReadDrops > summary.comparableReturns
        || summary.pricedDrops + summary.unpricedDrops
          !== summary.cacheReadDrops
        || (summary.cacheReadDrops === 0 && summary.lostCacheTokens !== 0)
        || (summary.cacheReadDrops > 0 && summary.lostCacheTokens === 0)
        || (summary.coverageStatus !== "complete"
          && summary.coverageStatus !== "incomplete")
        || (premium !== null
          && (typeof premium !== "number"
            || !Number.isFinite(premium)
            || premium < 0))
        || (summary.cacheReadDrops === 0
          && premium !== null
          && premium !== 0)
        || (premium === null
          && summary.coverageStatus === "complete"
          && summary.unpricedDrops === 0)
        || (premium !== null
          && (summary.coverageStatus !== "complete"
            || summary.unpricedDrops > 0))) return null;
    summaries.push({ ...band, summary });
  }
  return summaries;
}

function renderAccountingCacheContinuityGapRows(impact, rows) {
  clear(rows);
  const summaries = cacheContinuityGapBandSummaries(impact);
  if (summaries === null) {
    const page = paginateCacheImpactRows(
      [],
      cacheContinuityGapTablePagination,
      cacheImpactTableSignature("continuity-gap-unavailable", impact, []),
    );
    renderCacheImpactPagination(
      "cache-continuity-gap",
      cacheContinuityGapTablePagination,
      page,
    );
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.cacheContinuity.gapBreakdownUnavailable",
    );
    cell.colSpan = 4;
    row.append(cell);
    rows.append(row);
    return;
  }
  const page = paginateCacheImpactRows(
    summaries,
    cacheContinuityGapTablePagination,
    cacheImpactTableSignature("continuity-gap", impact, summaries),
  );
  renderCacheImpactPagination(
    "cache-continuity-gap",
    cacheContinuityGapTablePagination,
    page,
  );
  for (const { labelKey, summary } of page.rows) {
    const row = node("tr");
    row.append(
      localizedNode("td", "", labelKey),
      rawNode(
        "td",
        "numeric-cell",
        `${formatCount(summary.cacheReadDrops)} / ${formatCount(summary.comparableReturns)}`,
      ),
      rawNode("td", "numeric-cell", formatCount(summary.lostCacheTokens)),
      impact.coverageStatus !== "complete"
        || summary.estimatedPremiumUsd === null
        ? localizedNode(
          "td",
          "cache-continuity-premium-unavailable",
          "accounting.cacheContinuity.premiumUnavailable",
        )
        : rawNode(
          "td",
          "model-api-equivalent",
          formatApiMoney(summary.estimatedPremiumUsd),
        ),
    );
    rows.append(row);
  }
}

function renderAccountingCacheContinuityDetails(impact) {
  const disclosure = $("#cache-continuity-details");
  const gapRows = $("#cache-continuity-gap-rows");
  const rows = $("#cache-continuity-rows");
  if (!disclosure || !gapRows || !rows) return;
  clear(gapRows);
  clear(rows);
  const available = impact?.status === "available";
  disclosure.hidden = !available;
  if (!available) {
    disclosure.open = false;
    renderCacheImpactPagination(
      "cache-continuity-gap",
      cacheContinuityGapTablePagination,
      paginateCacheImpactRows(
        [],
        cacheContinuityGapTablePagination,
        "continuity-gap:unavailable",
      ),
    );
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
  renderAccountingCacheContinuityGapRows(impact, gapRows);
  const recent = Array.isArray(impact.recent) ? impact.recent : [];
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
    cell.colSpan = 6;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      rawNode("td", "", formatLocal(item.observedAt)),
      rawNode("td", "numeric-cell", formatCacheContinuityGap(item.gapSeconds)),
      rawNode(
        "td",
        "cache-switch-change",
        cacheContinuityConfigurationDescription(item),
      ),
      rawNode(
        "td",
        "numeric-cell",
        `${formatCount(item.previousCacheReadTokens)} → ${formatCount(item.currentCacheReadTokens)}`,
      ),
      rawNode("td", "numeric-cell", formatCount(item.lostCacheTokens)),
      rawNode(
        "td",
        "model-api-equivalent",
        item.estimatedPremiumUsd === null
          ? "—"
          : formatApiMoney(item.estimatedPremiumUsd),
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

function renderAccounting(data) {
  syncAccountingPeriodControls(data);
  const accounting = accountingPeriod(data);
  if (accounting === null) {
    clear($("#accounting-summary"));
    clear($("#accounting-component-counts"));
    clear($("#accounting-component-costs"));
    clear($("#accounting-models"));
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
  const cacheSwitchImpact = accounting.cacheSwitchImpact;
  const cacheSwitchCard = node("article", "metric-card compact-metric");
  const cacheSwitchLabel = node("span", "metric-name");
  cacheSwitchLabel.append(informationLabel(
    t("accounting.cacheSwitch.metricLabel"),
    t("accounting.cacheSwitch.metricExplanation"),
  ));
  const cacheSwitchNote = node("p");
  appendCacheSwitchMetricNote(cacheSwitchNote, cacheSwitchImpact);
  cacheSwitchCard.append(
    cacheSwitchLabel,
    rawNode("strong", "metric-value", cacheSwitchMetricValue(cacheSwitchImpact)),
    cacheSwitchNote,
  );
  summary.append(cacheSwitchCard);

  const cacheContinuityImpact = accounting.cacheContinuityImpact;
  const cacheContinuityCard = node("article", "metric-card compact-metric");
  const cacheContinuityLabel = node("span", "metric-name");
  cacheContinuityLabel.append(informationLabel(
    t("accounting.cacheContinuity.metricLabel"),
    t("accounting.cacheContinuity.metricExplanation"),
  ));
  const cacheContinuityNote = node("p");
  appendCacheContinuityMetricNote(
    cacheContinuityNote,
    cacheContinuityImpact,
  );
  cacheContinuityCard.append(
    cacheContinuityLabel,
    rawNode(
      "strong",
      "metric-value",
      cacheSwitchMetricValue(cacheContinuityImpact),
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
            ? "accounting.model.notPricedUnknownTitle"
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
    const cell = localizedNode("td", "empty-cell", "accounting.model.noneInPeriod");
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
    const separate = modelRowIsSeparateAllowance(model);
    row.append(
      identity,
      rawNode("td", "numeric-cell", formatCount(model.events)),
      rawNode("td", "numeric-cell", formatCount(model.totalTokens)),
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
            { model: formatModelName(model.model) },
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

function setContributionReviewRecoveryVisible(visible) {
  for (const id of ["#incremental-review-retry", "#incremental-copy-diagnostics"]) {
    const control = $(id);
    if (control) control.hidden = !visible;
  }
}

function clearContributionSyncExactReview() {
  contributionSyncExactReview = null;
}

function exactReviewSummaryIdentity(value) {
  const payload = value?.payload;
  // The telemetry-contribution-v0.1 document carries its records as ARRAYS
  // (usageEvents, quotaSnapshots, activityMarkers); only the queue item
  // summarizes them as a recordCounts object. Counting the arrays compares
  // like with like against the preview card. Reading a payload-shaped
  // recordCounts object here made this identity null on every real payload,
  // so every first-time approval failed review_expired_or_changed (found by
  // the first live first-time ceremony, 2026-08-19).
  if (typeof payload?.coveredAt?.startAt !== "string"
      || typeof payload?.coveredAt?.endAt !== "string"
      || !Array.isArray(payload?.usageEvents)
      || !Array.isArray(payload?.quotaSnapshots)
      || !Array.isArray(payload?.activityMarkers)
      || !Number.isSafeInteger(value?.payloadBytes)) {
    return null;
  }
  const total = payload.usageEvents.length
    + payload.quotaSnapshots.length
    + payload.activityMarkers.length;
  return [
    payload.coveredAt.startAt,
    payload.coveredAt.endAt,
    value.payloadBytes,
    total,
  ].join("|");
}

function renderContributionSyncExactReview(value) {
  if (value?.schemaVersion !== "contribution-sync-exact-review-v0.1"
      || value.status !== "available"
      || !isContributionReviewableQueueState(value.state)
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
  const summaryIdentity = exactReviewSummaryIdentity(value);
  if (summaryIdentity === null || summaryIdentity !== preparedSummaryIdentity()) {
    const error = new Error("The reviewed contribution changed.");
    error.code = "review_expired_or_changed";
    throw error;
  }
  contributionSyncExactReview = {
    // Local review readiness is intentionally independent of whether the
    // uploader is ready, waiting for a retry deadline, or paused.
    state: "ready",
    payloadBytes: value.payloadBytes,
    reviewToken: value.reviewToken,
    summaryIdentity,
  };
}

async function refreshContributionSyncControls(generation) {
  // Preview discovery commits newly prepared sets to the queue. Read queue
  // status afterwards so the two cards describe the same durable state.
  const preview = await localClient.contributionSyncPreview();
  const status = await localClient.contributionSyncStatus();
  if (!contributionReviewFence.isCurrent(generation)) return false;
  clearContributionSyncExactReview();
  renderContributionSyncStatus(status);
  renderContributionSyncPreview(preview);
  return true;
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
  const action = contributionReviewBootstrapAction(contributionSyncPreview);
  if (action === "unavailable") {
    maybeReportContributionReviewUnavailable();
    return;
  }
  contributionReviewUnavailableKey = null;
  if (action === "prepare") {
    maybePrepareIncrementalReviewInstance();
    return;
  }
  if (contributionSyncExactReview?.state === "ready") return;
  const key = preparedSummaryIdentity();
  if (key === null || key === contributionSyncAutoReviewedKey) return;
  contributionSyncAutoReviewedKey = key;
  void reviewPreparedSummary({ refreshFirst: false });
}

function maybeReportContributionReviewUnavailable() {
  const status = contributionSyncPreview?.status ?? "missing";
  const state = contributionSyncPreview?.state ?? "missing";
  const key = `${status}:${state}`;
  if (key === contributionReviewUnavailableKey) return;
  contributionReviewUnavailableKey = key;
  setContributionReviewRecoveryVisible(true);
  // State the recovery immediately; recording the bounded diagnostic note is
  // asynchronous and must not leave the old optimistic gate as the only copy.
  showIncrementalReviewStatusKey("consent.reviewUnavailable");
  const error = new Error("The local contribution review is unavailable.");
  error.code = "local_review_bootstrap_unavailable";
  void describeFailure({
    surface: "contribution_prepare",
    error,
    fallback:
      "TiboTattle could not read the local review state. Choose Check again. Nothing was uploaded.",
  }).then((described) => {
    if (contributionReviewUnavailableKey !== key
        || contributionReviewBootstrapAction(contributionSyncPreview)
          !== "unavailable") {
      return;
    }
    showIncrementalReviewStatus(described.text, true);
  });
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
  const generation = contributionReviewFence.begin();
  contributionSyncBusy = true;
  setContributionReviewRecoveryVisible(false);
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
      prepared = await withContributionReviewDeadline(
        localClient.prepareContribution({ lookbackHours: 24 }),
      );
    } catch (error) {
      // A very active day can exceed the fixed reviewed-set safety bound at
      // 24 hours. The lookback was only ever a size guard — never a consent
      // decision — so the bootstrap narrows to the latest hour by itself
      // instead of surfacing a window picker the owner removed.
      if (error?.code !== "export_too_large") throw error;
      prepared = await withContributionReviewDeadline(
        localClient.prepareContribution({ lookbackHours: 1 }),
      );
    }
    if (prepared.status !== "prepared") {
      const error = new Error("Preparation did not return a verified contribution.");
      error.code = "preparation_failed";
      throw error;
    }
    // The busy flag this preparation holds makes the refresh's automatic
    // verification pass bail out, so the pass is re-run explicitly below
    // once the flag is released.
    const refreshed = await withContributionReviewDeadline(
      refreshContributionSyncControls(generation),
    );
    if (!refreshed) return;
    preparedCommitted = true;
  } catch (error) {
    if (!contributionReviewFence.isCurrent(generation)) return;
    setContributionReviewRecoveryVisible(true);
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
  local_review_timed_out:
    "The local review did not finish within one minute. Choose Check again. If it repeats, reopen TiboTattle. Nothing was uploaded.",
  review_archive_invalid:
    "TiboTattle could not save the copy you would review, so nothing was queued and nothing was uploaded.",
  prepared_spool_invalid:
    "The place TiboTattle keeps a prepared instance on this Mac is not usable, so nothing was queued and nothing was uploaded.",
  preparation_failed:
    "A privacy-verified instance of the covered data could not be prepared. No upload occurred and incomplete staging is ignored by the queue.",
};

async function reviewPreparedSummary({ refreshFirst = true } = {}) {
  if (contributionSyncBusy) return;
  const generation = contributionReviewFence.begin();
  contributionSyncBusy = true;
  setContributionReviewRecoveryVisible(false);
  renderContributionActionState();
  showIncrementalReviewStatusKey("syncStatus.verifyingSummary");
  try {
    // Preview discovery commits newly prepared sets to the queue, so an
    // explicit re-check refreshes first; the automatic verification is
    // itself triggered by a fresh render and skips the redundant read.
    if (refreshFirst) {
      const refreshed = await withContributionReviewDeadline(
        refreshContributionSyncControls(generation),
      );
      if (!refreshed) return;
    }
    const review = await withContributionReviewDeadline(
      localClient.contributionSyncExactReview(),
    );
    if (!contributionReviewFence.isCurrent(generation)) return;
    renderContributionSyncExactReview(review);
    contributionSyncAutoReviewedKey = preparedSummaryIdentity();
    showIncrementalReviewStatusKey("syncStatus.summaryVerified");
  } catch (error) {
    if (!contributionReviewFence.isCurrent(generation)) return;
    // A bare `catch {}` discarded the only evidence of what actually failed
    // and printed one sentence for every cause. Surface the real one, and
    // offer the explicit re-check: automatic verification never retries a
    // failure by itself.
    setContributionReviewRecoveryVisible(true);
    showIncrementalReviewStatus((await describeFailure({
      surface: "contribution_prepare",
      error,
      messages: INCREMENTAL_PREPARATION_ERROR_COPY,
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
  const generation = contributionReviewFence.begin();
  incrementalReviewPrepareAttempted = false;
  contributionSyncAutoReviewedKey = null;
  contributionReviewUnavailableKey = null;
  setContributionReviewRecoveryVisible(false);
  try {
    await withContributionReviewDeadline(
      refreshContributionSyncControls(generation),
    );
  } catch (error) {
    if (!contributionReviewFence.isCurrent(generation)) return;
    setContributionReviewRecoveryVisible(true);
    showIncrementalReviewStatus((await describeFailure({
      surface: "contribution_prepare",
      error,
      messages: INCREMENTAL_PREPARATION_ERROR_COPY,
      fallback:
        "TiboTattle could not re-check the local review state. Nothing was uploaded."
    })).text, true);
  }
}

function browserContributionDiagnosticState() {
  const signedIn = hostedIdentity !== null || hasCommunitySession();
  const paired = communityDevicePairedV1 || communityUploadAuthorityEvidence();
  const previewState = contributionSyncPreview?.status === "available"
      && ["empty", "ready", "retry_wait", "paused"].includes(
        contributionSyncPreview.state,
      )
    ? contributionSyncPreview.state
    : "not_observed";
  let journeyPhase;
  if (!contributionServiceConfigured()) {
    journeyPhase = "not_configured";
  } else if (!incrementalSyncCapabilityAdvertised()) {
    journeyPhase = "unavailable";
  } else if (incrementalConsentBusy || communityConnectBusy) {
    journeyPhase = "connecting";
  } else if (incrementalConsentApproved) {
    if (incrementalUploadAuthorityLost() || !paired) {
      journeyPhase = "approved_connection_needed";
    } else if (incrementalSyncStatus?.paused) {
      journeyPhase = "approved_paused";
    } else if (incrementalSyncStatus?.running
        || (incrementalSyncStatus?.progress?.daysPending ?? 0) > 0) {
      journeyPhase = "approved_syncing";
    } else {
      journeyPhase = "approved_idle";
    }
  } else if (!signedIn) {
    journeyPhase = "sign_in_required";
  } else if (contributionSyncExactReview?.state === "ready") {
    journeyPhase = "review_ready";
  } else {
    journeyPhase = "preparing_review";
  }
  return Object.freeze({
    journeyPhase,
    previewState,
    consent: Object.freeze({
      approved: incrementalConsentApproved,
      current: incrementalSyncStatus?.status === "available"
        ? incrementalSyncStatus.consent.current === true
        : incrementalConsentApproved,
    }),
    signedIn: Object.freeze({ observed: true, value: signedIn }),
    pairing: Object.freeze({ observed: paired, paired }),
  });
}

// Native Data & Diagnostics reads only this fixed-vocabulary snapshot from
// the active page. It intentionally exposes no proof, state, verifier,
// session, identifier, path, or contribution payload.
window.__tibotattleContributionDiagnostics = browserContributionDiagnosticState;

async function collectContributionDiagnostics() {
  const local = await localClient.contributionDiagnostics();
  const browser = browserContributionDiagnosticState();
  const localAvailable = local?.status === "available";
  return Object.freeze({
    journeyPhase: browser.journeyPhase,
    previewState: browser.previewState === "not_observed" && localAvailable
      ? local.previewState
      : browser.previewState,
    queueState: localAvailable ? local.queueState : "unavailable",
    consent: browser.consent,
    signedIn: browser.signedIn,
    pairing: browser.pairing.paired || !localAvailable
      ? browser.pairing
      : local.pairing,
    recentDiagnosticReferences: localAvailable
      ? local.recentDiagnosticReferences
      : Object.freeze([]),
  });
}

function formatContributionDiagnostics(value) {
  const lines = [
    "TiboTattle contribution diagnostics",
    "schema: tibotattle-contribution-diagnostics-v1",
    `journey_phase: ${value.journeyPhase}`,
    `preview_state: ${value.previewState}`,
    `queue_state: ${value.queueState}`,
    `consent_approved: ${value.consent.approved}`,
    `consent_current: ${value.consent.current}`,
    `signed_in_observed: ${value.signedIn.observed}`,
    `signed_in: ${value.signedIn.value}`,
    `pairing_observed: ${value.pairing.observed}`,
    `paired: ${value.pairing.paired}`,
  ];
  value.recentDiagnosticReferences.forEach((item, index) => {
    lines.push(
      `diagnostic_reference_${index + 1}: ${item.reference} @ ${item.recordedAt}`,
    );
  });
  lines.push(
    "tokens_included: false",
    "oauth_state_included: false",
    "verifiers_included: false",
    "device_identifiers_included: false",
    "account_identifiers_included: false",
    "paths_included: false",
    "content_included: false",
  );
  return lines.join("\n");
}

async function copyContributionDiagnostics() {
  const button = $("#incremental-copy-diagnostics");
  if (!button || button.disabled) return;
  button.disabled = true;
  setLocalizedText(button, "contribution.diagnostics.copying");
  try {
    if (typeof navigator.clipboard?.writeText !== "function") {
      throw new Error("Clipboard is unavailable.");
    }
    await navigator.clipboard.writeText(
      formatContributionDiagnostics(await collectContributionDiagnostics()),
    );
    setLocalizedText(button, "contribution.diagnostics.copied");
  } catch {
    setLocalizedText(button, "contribution.diagnostics.failed");
  } finally {
    window.setTimeout(() => {
      button.disabled = false;
      setLocalizedText(button, "contribution.diagnostics.copy");
    }, 2_000);
  }
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
    markLocalDashboardReady();
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
    markLocalDashboardReady();
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
    "This account already has its maximum of connected Macs, so this Mac was not connected. Sign out a Mac you no longer use from its own TiboTattle, then connect this one again. Nothing was uploaded.",
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
  // A durable checkpoint that was present when the analysis started and is
  // gone mid-run. A first-ever run without a checkpoint never reports this:
  // it completes with a provider-quota diagnostic instead, so this code only
  // names genuine loss of the stored analysis state.
  app_record_checkpoint_unavailable:
    "The analysis checkpoint stored on this Mac disappeared while the analysis was running, so TiboTattle stopped rather than continue without it. Existing results are unchanged; run the analysis again to start over safely.",
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
    || hostedSignInCancellationInFlight
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
    || hostedSignInCancellationInFlight
    || signedIn
    || appleUnavailableNow;
  // Exactly one of the two states is present: the provider choices, or the
  // signed-in account row that can hand the page back to the choices.
  $("#identity-signin-choices").hidden = signedIn;
  $("#identity-account").hidden = !signedIn;
  $("#identity-signout").disabled = hostedIdentityBusy
    || hostedSignInCancellationInFlight
    || !signedIn;
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
  // One honest, five-state identity status (owner-reported contradictions,
  // 2026-08-08/10). A single flat "Signed in"/"Not signed in" chip could not
  // tell never-tried from signing-in from reconnecting from connected, so it
  // showed a live in-page proof as "Signed in", a completed Google round trip
  // as "Not signed in", and an APPROVED Mac beside a dead action. The merged
  // model resolves all three, and the ONE next action is stated beside it so
  // the chip and the action can never disagree.
  const identityState = hostedIdentityStatusState({
    signingIn: hostedIdentityBusy
      || hostedSignInCancellationInFlight
      || activeHostedSignIn !== null
      || pendingHostedSignInResumeInFlight,
    signedIn,
    hasServerSession,
    repairPending: incrementalConsentApproved && incrementalUploadAuthorityLost(),
  });
  setLocalizedText(chip, IDENTITY_STATE_CHIP_KEYS[identityState]);
  chip.className = identityState === "connected"
    ? "evidence-chip"
    : "evidence-chip neutral";
  const nextAction = $("#identity-signin-next");
  if (nextAction) {
    setLocalizedText(
      nextAction,
      hostedIdentityNextActionKey(identityState, hostedSignInRequired()),
    );
  }
  // Sign-in state gates the single approve ceremony, so the merged surface
  // and the journey strip re-render with it (owner-directed 2026-08-08: the
  // separate connect button this used to refresh is gone).
  renderContributionActionState();
}

// The five merged identity states and their one-next-action lines. Kept beside
// renderHostedIdentity so the chip vocabulary and the action vocabulary are
// read from the same place.
const IDENTITY_STATE_CHIP_KEYS = Object.freeze({
  new: "identity.state.new",
  signingIn: "identity.state.signingIn",
  signedIn: "identity.state.signedIn",
  reconnecting: "identity.state.reconnecting",
  connected: "identity.state.connected",
});
const IDENTITY_STATE_NEXT_KEYS = Object.freeze({
  new: "identity.next.new",
  signingIn: "identity.next.signingIn",
  signedIn: "identity.next.signedIn",
  reconnecting: "identity.next.reconnecting",
  connected: "identity.next.connected",
});

/**
 * The one honest identity status, from the underlying facts. Signing-in wins
 * over everything: an in-flight ceremony is the truest current state. Otherwise
 * a Mac that holds only an in-page proof is Signed in and waiting for explicit
 * review; only upload authority actually being re-paired is Reconnecting. A
 * real server session with nothing pending is Connected; and nothing at all is
 * New — never "Not signed in" right after a completed round trip left a proof.
 */
function hostedIdentityStatusState({ signingIn, signedIn, hasServerSession, repairPending }) {
  if (signingIn) return "signingIn";
  if (repairPending) return "reconnecting";
  if (signedIn && !hasServerSession) return "signedIn";
  if (signedIn) return "connected";
  return "new";
}

// A reconnect that has lost its session names its own next step — sign in
// again — rather than implying nothing is asked of the reader.
function hostedIdentityNextActionKey(identityState, signInRequired) {
  return identityState === "reconnecting" && signInRequired
    ? "identity.next.reconnectSignIn"
    : IDENTITY_STATE_NEXT_KEYS[identityState];
}

// A completed hosted handoff is memory-only, but its state+verifier recovery
// handle remains durable until enrollment. Enrollment also creates an HttpOnly
// service session. When one exists, acknowledge its server-side
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
    // Retire the crash-recovery capability before revoking the hosted
    // session. A failed remote logout may be retried while the page still
    // truthfully shows signed in; a failed local clear must never let an
    // unconsumed proof silently sign the user back in after they chose out.
    await clearPendingHostedSignIn();
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

// The poll must cover the service's authorization window, not undershoot it
// (owner-reported, 2026-08-10). The Worker holds an unused sign-in
// authorization for ten minutes (SIGNIN_HANDOFF_AUTHORIZATION_TTL_MILLISECONDS)
// — a full human round trip: a cold-starting browser, an account chooser, a
// password, a second factor. The old five-minute client budget gave up while
// the service still held the authorization, so a careful user's completed
// sign-in expired unread and the exhaustion logged error:null → "unknown".
// Ten minutes matches the service, so the poll stops exactly when the
// authorization can no longer be redeemed rather than minutes earlier.
const HOSTED_SIGNIN_POLL_ATTEMPTS = 300;
const HOSTED_SIGNIN_POLL_INTERVAL_MS = 2_000;
// A callback can finish at the very end of the ten-minute authorization
// window and then mint a proof with its own five-minute delivery window. The
// page cannot observe the callback timestamp while it is closed, so retain the
// state+verifier for the conservative sum. The Worker remains the exact expiry
// authority and rejects an earlier-dead handle; this bound only prevents the
// client from deleting a still-live recovery path.
const HOSTED_SIGNIN_RESULT_DELIVERY_VALIDITY_MS = 5 * 60 * 1_000;
const HOSTED_SIGNIN_HANDOFF_VALIDITY_MS =
  HOSTED_SIGNIN_POLL_ATTEMPTS * HOSTED_SIGNIN_POLL_INTERVAL_MS
    + HOSTED_SIGNIN_RESULT_DELIVERY_VALIDITY_MS;

// A failure at the local relay to the contribution service — not a verdict
// from the Worker — surfaces as one of the companion's fixed
// central_participant_* codes. It means the read-back never reached the
// service, so it is transient by nature: retry it within the bounded sign-in
// budget exactly like a still-pending result, and never let it destroy the
// pending handoff (owner-reported relay identity loss, 2026-08-10).
function isTransientSignInRelayError(error) {
  return typeof error?.code === "string"
    && error.code.startsWith("central_participant_");
}

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

async function cancelHostedSignIn() {
  const attempt = activeHostedSignIn;
  if (attempt === null || hostedSignInCancellationInFlight) return;
  hostedSignInCancellationInFlight = true;
  attempt.cancelled = true;
  activeHostedSignIn = null;
  // Wake the polling loop before the local clear so its finally block cannot
  // keep a cancelled request asleep for another interval.
  attempt.wake?.();
  renderHostedIdentity();
  // An explicit cancel is a user decision: the persisted handoff must not
  // resurrect this sign-in on the next reactivation.
  try {
    await clearPendingHostedSignIn().catch(() => {});
    const status = $("#identity-signin-status");
    status.hidden = false;
    status.className = "participant-action-status";
    setLocalizedText(status, "contribution.signInCancelled", {
      provider: attempt.label,
    });
  } finally {
    hostedIdentityBusy = false;
    hostedSignInCancellationInFlight = false;
    renderHostedIdentity();
  }
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
      "Google sign-in did not finish within the live check. Nothing was uploaded. TiboTattle will check the bounded recovery handle again when the app returns; you can also sign in again.",
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
      "Apple sign-in did not finish within the live check. Nothing was uploaded. TiboTattle will check the bounded recovery handle again when the app returns; you can also sign in again.",
    unconfigured: "Hosted Apple sign-in is not configured for this build.",
    failed: "Apple sign-in could not be completed. Sign in again.",
    markUnavailable: () => {
      appleSignInUnavailable = true;
    },
  },
};

// The native companion binds a fresh random loopback port on every launch, so
// browser storage is not a cross-relaunch boundary: localStorage belongs to
// the origin including that port. Keep the short-lived {provider, state,
// verifier, startedAt} read-back capability in the companion's owner-only
// state instead. The companion validates the exact shape, applies the
// fifteen-minute expiry, and returns no proof, session, account fact, device
// identifier, path, or contribution content. OAuth is not opened unless the
// durable write succeeds.
async function persistPendingHostedSignIn(providerId, state, verifier) {
  return localClient.storeHostedSignInHandoff({
    provider: providerId,
    state,
    verifier,
  });
}

async function clearPendingHostedSignIn() {
  return localClient.clearHostedSignInHandoff();
}

async function readPendingHostedSignIn() {
  const value = await localClient.hostedSignInHandoff();
  return ["pending", "expired"].includes(value?.status) ? value : null;
}

// One resume at a time; re-entrant activations (load + focus + deep link in
// the same second) must not race two read-backs of the bounded result.
let pendingHostedSignInResumeInFlight = false;

/**
 * Collect a sign-in this page started but never read back (owner-reported
 * orphaned proof, 2026-08-08). Runs on load and on every reactivation —
 * deep-link return, visibilitychange to visible, window focus — and reads the
 * persisted handoff's result with a couple of bounded retries inside the
 * conservative authorization-plus-delivery validity window. Success completes
 * the identical journey the
 * live poll would have: identity adopted while the recovery record remains
 * until enrollment succeeds, and the pending
 * repair ceremony resumed. A proof that expired unread, or a definite service
 * verdict, is reported through describeFailure so a reference and request id
 * reach the local diagnostics log; an unreachable service leaves the record
 * for the next activation instead of logging a note per focus change.
 */
async function resumePendingHostedSignIn({ retries = 2 } = {}) {
  if (pendingHostedSignInResumeInFlight || hostedSignInCancellationInFlight) return;
  if (hostedIdentityBusy || activeHostedSignIn !== null || hostedIdentity !== null) {
    return;
  }
  // A restored HttpOnly service session is already the completed recovery
  // outcome. Retire any stale local handle without polling it into a false
  // "token invalid" failure after a successful enrollment.
  if (hasCommunitySession()) {
    await clearPendingHostedSignIn().catch(() => {});
    return;
  }
  const pending = await readPendingHostedSignIn();
  if (pending === null) return;
  const flow = HOSTED_SIGNIN_FLOWS[pending.provider];
  const status = $("#identity-signin-status");
  if (pending.status === "expired"
      || Date.now() >= pending.expiresAt) {
    await clearPendingHostedSignIn().catch(() => {});
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
  // A reactivation is collecting a completed sign-in: hold off any teardown
  // until it settles, exactly like a live sign-in.
  signalHostedSignInInFlight(true);
  try {
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      let identity = null;
      try {
        identity = await flow.result(pending.state, pending.verifier);
      } catch (error) {
        if (error?.code === "IDENTITY_RESULT_PENDING"
            || isTransientSignInRelayError(error)) {
          // Not a verdict on the proof: the provider has not returned yet, or
          // the local relay to the service failed transiently
          // (central_participant_*). Retry within the bounded window and leave
          // the record intact for the next activation either way — a transient
          // relay failure must never destroy the pending handoff
          // (owner-reported, 2026-08-10).
          identity = null;
        } else if (error?.code === undefined && error?.status === undefined) {
          // Unreachable service with no code at all: not a verdict on the
          // proof. Keep the record and try again on the next activation rather
          // than logging a note per focus change.
          return;
        } else {
          await clearPendingHostedSignIn().catch(() => {});
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
    signalHostedSignInInFlight(false);
  }
}

// Tell the native shell whether a hosted sign-in is in flight, so it refuses to
// tear the web view — and the pending handoff — down mid-sign-in (S1). A no-op
// in a normal browser, where window.webkit is undefined; it carries a single
// boolean and never a proof, provider, or account value.
function signalHostedSignInInFlight(inFlight) {
  try {
    window.webkit?.messageHandlers?.tibotattleHostedSignIn?.postMessage({
      inFlight: Boolean(inFlight),
    });
  } catch {
    // The bridge is optional; its absence only removes the native shell's
    // mid-sign-in teardown guard, never anything the sign-in itself needs.
  }
}

async function beginHostedSignIn(providerId) {
  const flow = HOSTED_SIGNIN_FLOWS[providerId];
  if (flow === undefined || hostedIdentityBusy || hostedIdentity !== null
      || pendingHostedSignInResumeInFlight
      || hostedSignInCancellationInFlight) {
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
  // The browser is about to open: from here until this settles, the shell must
  // not tear the page down and lose the handoff.
  signalHostedSignInInFlight(true);
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  setLocalizedText(status, "contribution.signInStarting", {
    provider: flow.label,
  });
  try {
    const request = await flow.start();
    if (attempt.cancelled || activeHostedSignIn !== attempt) return;
    // Persisted BEFORE the browser opens: from this moment a completed
    // sign-in exists server-side that only this state token AND the client
    // verifier can collect, so both must survive a dashboard reload
    // (owner-reported orphaned proof, 2026-08-08).
    await persistPendingHostedSignIn(
      providerId,
      request.state,
      request.verifier,
    );
    if (attempt.cancelled || activeHostedSignIn !== attempt) {
      await clearPendingHostedSignIn().catch(() => {});
      return;
    }
    openHostedSignInInBrowser(request.authorizeUrl);
    status.textContent = flow.waiting;
    for (let poll = 0; poll < HOSTED_SIGNIN_POLL_ATTEMPTS; poll += 1) {
      if (attempt.cancelled || activeHostedSignIn !== attempt) return;
      let identity = null;
      try {
        identity = await flow.result(request.state, request.verifier);
      } catch (error) {
        // A transient relay failure (central_participant_*) is retried within
        // this bounded loop exactly like a pending result rather than aborting
        // the whole poll with zero retry (owner-reported, 2026-08-10). A
        // definite verdict still throws and is handled below.
        const pendingResult = error?.code === "IDENTITY_RESULT_PENDING";
        if (!pendingResult && !isTransientSignInRelayError(error)) throw error;
        // The callback can wake the app a few milliseconds before its D1
        // completion write is visible. Pending remains normal polling even
        // after return; keep the recovery record and continue the bounded
        // loop instead of destroying a sign-in that is still completing.
      }
      if (identity !== null) {
        if (attempt.cancelled || activeHostedSignIn !== attempt) return;
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
    // side, so it is referenced and logged like any other. Do not discard the
    // persisted recovery handle here: a provider callback can complete at the
    // edge of the authorization window and mint a proof with its own delivery
    // window. Relaunch/focus may still recover that result safely.
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
      await clearPendingHostedSignIn().catch(() => {});
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
    // Whatever the outcome, this attempt is no longer in flight — the shell may
    // tear the web view down again.
    signalHostedSignInInFlight(false);
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
 * The guided journey as explicit stages with visible state: index building →
 * community. Every line is rendered from a measured fact — the counted index
 * sources (the same numbers as the history progress surface), evidence
 * freshness, and the sign-in/connection facts. Trimmed from four boxes to
 * two (owner-directed, 2026-08-10): the "Mac app & companion" box was
 * self-referential — this dashboard rendering at all proves the companion
 * answers — and the "Local evidence" observation time is a fact, not a
 * stage, so it rides as the index box's second clause.
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

  // 1 — the local index, with the same measured counts the history progress
  // surface reports, plus the newest local observation as the same line's
  // second fact. Nothing here estimates a finish time.
  const history = dashboard?.pricing?.historyCoverage
    ?? dashboard?.accounting?.historyCoverage
    ?? null;
  const totalSources = finite(history?.sourceCount, 0);
  const observedAt = dashboard && dashboard.mode !== "demo"
    && dashboard.freshness?.latestObservedAt
    ? formatLocal(dashboard.freshness.latestObservedAt)
    : null;
  if (dashboard && dashboard.mode !== "demo" && history?.status === "complete") {
    if (observedAt === null) {
      stage("index", "done", "journey.index.complete");
    } else {
      stage("index", "done", "journey.index.completeWithEvidence", {
        time: observedAt,
      });
    }
  } else if (dashboard && dashboard.mode !== "demo" && totalSources > 0) {
    // The same measured counts the history progress surface reports, stated
    // as one short sentence: the two-sentence byte breakdown wrapped this
    // card to eight lines (owner-directed tightening, 2026-08-08).
    const counts = {
      indexed: formatNumber(finite(history.indexedSourceCount, 0)),
      total: formatNumber(totalSources),
    };
    if (observedAt === null) {
      stage("index", "progress", "journey.index.progress", counts);
    } else {
      stage("index", "progress", "journey.index.progressWithEvidence", {
        ...counts,
        time: observedAt,
      });
    }
  } else {
    stage("index", "waiting", "journey.index.waiting");
  }

  // 2 — sign in, then the single review-and-approve ceremony (owner-directed
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
  } else if (incrementalConsentApproved && incrementalUploadAuthorityLost()) {
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
 * Whether this Mac's upload authority is lost and only the connect ceremony
 * can restore it. Two paused reasons qualify: consent_rejected (the service
 * refused the grant) and device_unavailable (no readable device credential —
 * after a credential reset or a broken Keychain binding). Gating repair on
 * consent_rejected alone was a designed-in deadlock: with no credential,
 * every pass dies at device_unavailable before any upload can be refused,
 * so the only state that re-opened the ceremony was unreachable from the
 * state that needed it.
 */
function incrementalUploadAuthorityLost() {
  return incrementalGrantRejected()
    || (incrementalSyncStatus?.status === "available"
      && incrementalSyncStatus.pausedReason === "device_unavailable");
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
  // A recorded approval whose upload authority is lost — a claim that
  // carried the v0.1 consent, or a missing device credential — re-opens the
  // same single action (the transparent re-pair). The chip stays "Approved":
  // the user's approval stands; only the transport authorization re-runs.
  const repairNeeded = incrementalConsentApproved
    && incrementalUploadAuthorityLost();
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
  renderIncrementalSyncRetry();
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
  if (incrementalUploadAuthorityLost()) {
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
  // paused outcome earns the "Last error" clause (2026-08-08). When the
  // companion recorded a specific cause beside the bare outcome code
  // (0.1.2's lastOutcome.detail), that cause is what the reader sees:
  // "device credential unavailable" says what to fix, "run_failed" does not.
  if (outcome !== null && ["failed", "paused"].includes(outcome.status)) {
    const code = incrementalSyncLastOutcomeDetailCode ?? outcome.code;
    parts.push(t("consent.syncLastError", {
      code: code.replaceAll("_", " "),
    }));
  }
  // A composed multi-part sentence: raw write, like the other composed
  // status lines, so a stale registry entry cannot resurrect over it.
  setRawText(line, parts.join(" "));
  line.hidden = false;
}

// The fixed-vocabulary shape every incremental outcome code already obeys;
// anything else stays off the page.
const INCREMENTAL_OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

function boundedOutcomeDetailCode(payload) {
  const code = payload?.lastOutcome?.detail?.code;
  return typeof code === "string" && INCREMENTAL_OUTCOME_CODE_PATTERN.test(code)
    ? code
    : null;
}

/**
 * The manual sync lever (owner-directed 2026-08-10): visible whenever the
 * approved engine is neither mid-pass nor paused awaiting the consent
 * repair, because those are the states where "wait out the backoff" was the
 * user's only option. Disabled while a pass runs or the request is in
 * flight; the POST's own response is the same bounded projection the status
 * line reads, so the outcome renders honestly either way.
 */
function renderIncrementalSyncRetry() {
  const button = $("#incremental-sync-retry");
  if (!button) return;
  const status = incrementalSyncStatus;
  const visible = incrementalSyncCapabilityAdvertised()
    && incrementalConsentApproved
    && status?.status === "available"
    && !incrementalGrantRejected();
  button.hidden = !visible;
  if (!visible) {
    hideIncrementalSyncRetryNote();
    return;
  }
  button.disabled = status.running === true || incrementalSyncRetryBusy;
}

function hideIncrementalSyncRetryNote() {
  const note = $("#incremental-sync-retry-note");
  if (!note) return;
  forgetLocalizedNode(note);
  note.textContent = "";
  note.hidden = true;
}

async function runIncrementalSyncNow() {
  if (incrementalSyncRetryBusy) return;
  incrementalSyncRetryBusy = true;
  hideIncrementalSyncRetryNote();
  renderIncrementalSyncRetry();
  try {
    // The route resets the retry ladder and starts the due pass, then
    // returns the bounded incremental-status projection of what it did.
    const payload =
      await localClient.localContributionMutation("incremental-run");
    incrementalSyncStatus =
      normalizeIncrementalContributionSyncStatus(payload);
    incrementalSyncLastOutcomeDetailCode = boundedOutcomeDetailCode(payload);
    if (incrementalSyncStatus?.status === "available") {
      incrementalConsentApproved =
        incrementalSyncStatus.consent.approved === true
        && incrementalSyncStatus.consent.current === true;
    }
    renderContributionActionState();
    scheduleIncrementalSyncStatusPoll({ reset: true });
  } catch (error) {
    const note = $("#incremental-sync-retry-note");
    if (note) {
      const code = typeof error?.code === "string"
        && INCREMENTAL_OUTCOME_CODE_PATTERN.test(error.code)
        ? error.code.replaceAll("_", " ")
        : "request_failed".replaceAll("_", " ");
      setLocalizedText(note, "consent.syncRetryFailed", { code });
      note.hidden = false;
    }
  } finally {
    incrementalSyncRetryBusy = false;
    renderIncrementalSyncRetry();
  }
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
  // The same bounded GET the client performs, read raw once so the optional
  // lastOutcome.detail.code survives beside the normalized projection — the
  // deliberately fixed three-field outcome shape cannot carry it. The exact
  // exported normalizer still owns every other fact.
  let payload = null;
  try {
    const response = await fetch(
      "/api/local/contribution/incremental-status",
      { headers: { Accept: "application/json" } },
    );
    payload = response.ok ? await response.json() : null;
  } catch {
    payload = null;
  }
  incrementalSyncStatus = normalizeIncrementalContributionSyncStatus(payload);
  incrementalSyncLastOutcomeDetailCode = boundedOutcomeDetailCode(payload);
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

async function freshReviewTokenForApproval(generation, expectedSummaryIdentity) {
  const review = await withContributionReviewDeadline(
    localClient.contributionSyncExactReview(),
  );
  if (!contributionReviewFence.isCurrent(generation)) return null;
  renderContributionSyncExactReview(review);
  if (contributionSyncExactReview?.summaryIdentity !== expectedSummaryIdentity) {
    const error = new Error("The local contribution review changed.");
    error.code = "review_expired_or_changed";
    throw error;
  }
  return contributionSyncExactReview.reviewToken;
}

/**
 * Commit the user's local consent before any hosted enrollment or pairing.
 * The ten-minute review capability is refreshed at click time. If it expires
 * in the tiny interval before the local mutation, discard it, mint one fresh
 * authorization for the same on-screen summary, and retry exactly once.
 */
async function recordFreshLocalContributionApproval(
  generation,
  expectedSummaryIdentity,
) {
  let reviewToken = await freshReviewTokenForApproval(
    generation,
    expectedSummaryIdentity,
  );
  if (reviewToken === null) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await localClient.approveIncrementalContribution(reviewToken);
    } catch (error) {
      if (attempt > 0 || error?.code !== "review_expired_or_changed") {
        throw error;
      }
      clearContributionSyncExactReview();
      reviewToken = await freshReviewTokenForApproval(
        generation,
        expectedSummaryIdentity,
      );
      if (reviewToken === null) return null;
    }
  }
  return null;
}

/**
 * The one-step ceremony (owner-directed, 2026-08-08): a single "Review and
 * approve" interaction does everything after sign-in. It first refreshes the
 * local review authorization and records the local approve-once consent. Only
 * then does it mint and claim the hosted v1.0 pairing. A process interruption
 * can therefore leave an approved Mac that still needs connection (which is
 * recoverable), never a server-authorized Mac whose local consent is missing.
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
  const reviewGeneration = contributionReviewFence.begin();
  const expectedSummaryIdentity = contributionSyncExactReview?.summaryIdentity
    ?? null;
  let enrollmentAttemptedWithHostedIdentity = false;
  let enrollmentEstablished = false;
  renderContributionActionState();
  try {
    // --- Local consent is durable before hosted state can change. ----------
    if (needsLocalApproval) {
      status.hidden = false;
      status.className = "participant-action-status";
      setLocalizedText(status, "consent.approving");
      const result = await recordFreshLocalContributionApproval(
        reviewGeneration,
        expectedSummaryIdentity,
      );
      if (result?.status !== "approved") {
        const error = new Error("The local companion did not record the approval.");
        error.code = "incremental_consent_failed";
        throw error;
      }
      incrementalConsentApproved = true;
      clearContributionSyncExactReview();
      setLocalizedText(status, "consent.approved");
    }
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
          // The state+verifier handoff remains durable until enrollment is
          // confirmed. A quit after result collection can therefore re-read
          // the same server proof and resume here after relaunch.
          await clearPendingHostedSignIn().catch(() => {});
          hostedIdentity = null;
          enrollmentEstablished = true;
          // Stamp the mint instant BEFORE the pairing goes out: the __Host-
          // session cookie the enroll response just set may not have committed
          // to this WKWebView's out-of-process cookie jar yet, so the mint can
          // race ahead of it. The retry below closes that millisecond window,
          // and the timestamp keeps the catch from mistaking this fresh
          // session for a dead stored one.
          communitySessionMintedAt = Date.now();
          return mintDevicePairingWithCookieCommitRetry();
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
    if (!needsLocalApproval) {
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
        && contributionSessionWasRejected(error)
        && !contributionSessionMintedWithinRaceWindow()) {
      // The stored session was rejected mid-ceremony. This is the repair
      // loop's root (owner-reported, 2026-08-08): failure copy here repeated
      // on every load while the dead session survived. Render the sign-in
      // gate instead — once signed in, the ceremony resumes automatically.
      // A session THIS ceremony minted seconds ago is deliberately excluded:
      // that is the cookie-commit race, not a dead session, so it falls
      // through to the retryable failure below and keeps the fresh session
      // rather than being silently discarded (owner-reported, 2026-08-10).
      await renderContributionSessionSignInGate(status, error);
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

// The cookie-commit race window (owner-reported, 2026-08-10). v0.1.6 restructured
// the ceremony to enroll first and then mint the device pairing, and it fires the
// mint in the same microtask as the enroll response. The just-issued __Host-
// session cookie has not necessarily committed to the WKWebView's out-of-process,
// non-persistent cookie jar by then, so the mint can go out cookie-less and the
// Worker answers with a session-rejection class code — even though the session it
// just minted is perfectly valid. The commit window is milliseconds; these three
// backoffs cover it comfortably without ever masking a genuinely refused
// credential, since a truly dead session keeps rejecting through every retry and
// then fails honestly.
const CONTRIBUTION_MINT_COOKIE_COMMIT_BACKOFFS_MS = Object.freeze([250, 500, 1_000]);
// How long after a fresh mint a session-rejection still reads as the race rather
// than a dead session. It sits well above the summed backoffs plus round trips,
// while a restored or stored session (mint time null) is never treated as fresh.
const CONTRIBUTION_FRESH_SESSION_RACE_WINDOW_MS = 10_000;

function contributionSessionMintedWithinRaceWindow() {
  return communitySessionMintedAt !== null
    && Date.now() - communitySessionMintedAt < CONTRIBUTION_FRESH_SESSION_RACE_WINDOW_MS;
}

/**
 * Mint the v1.0 device pairing, retrying only the session-rejection class
 * that the cookie-commit race produces. The first mint runs immediately; a
 * rejection inside the race window is retried on a short bounded backoff
 * before the ceremony is allowed to conclude failure, so the sign-in the user
 * just completed is not thrown away by a cookie that had not committed yet.
 */
async function mintDevicePairingWithCookieCommitRetry() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await communityClient.createDevicePairing(false);
    } catch (error) {
      if (attempt >= CONTRIBUTION_MINT_COOKIE_COMMIT_BACKOFFS_MS.length
          || !contributionSessionWasRejected(error)) {
        throw error;
      }
      await new Promise((resolveBackoff) => {
        setTimeout(resolveBackoff, CONTRIBUTION_MINT_COOKIE_COMMIT_BACKOFFS_MS[attempt]);
      });
    }
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
  if (!incrementalConsentApproved || !incrementalUploadAuthorityLost()) return;
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
  if (!incrementalConsentApproved || !incrementalUploadAuthorityLost()) return;
  if (incrementalConsentBusy || communityConnectBusy) return;
  // A post-sign-in resume IS this load's one automatic ceremony, so it spends
  // the same single-attempt budget maybeRepairIncrementalAuthorization guards.
  // Without this, a resume that consumed its one-use proof and then hit the
  // cookie-commit mint race would re-render in its finally, and the guarded
  // auto-repair — seeing an approved Mac whose authority is still lost and a
  // held session — would start a SECOND ceremony 69ms later that re-enrolled
  // the now-dead proof and drew IDENTITY_TOKEN_INVALID (owner-reported two-note
  // failure, 2026-08-11). One automatic ceremony per load, whichever entry
  // point starts it; the explicit Review-and-approve button is never gated by
  // this budget.
  incrementalRepairAttempted = true;
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
async function renderContributionSessionSignInGate(status, error) {
  // No more silent discards (owner-reported, 2026-08-10): this was the ONE
  // ceremony failure path that cleared the session and identity without ever
  // recording a diagnostics note, so a sign-in that reached the service and
  // then hit a dead stored session left nothing to look up. Record the real
  // code and request id first — the calm gate copy below is unchanged, but the
  // failure is now referenced like every other one.
  await describeFailure({
    surface: "contribution_connect",
    error,
    fallback: "The stored contribution session was rejected, so this Mac asks for a fresh sign-in.",
  });
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
  // Keep the proof and its persisted state+verifier across transport and
  // service failures: the Worker allows the same bound handle to retrieve the
  // result until enrollment consumes it or it expires. Only a definitive
  // IDENTITY_TOKEN_INVALID verdict proves this handle cannot recover. Clearing
  // on a timeout or 5xx would recreate the crash window this recovery path is
  // specifically designed to close.
  const retryNeedsFreshSignIn = enrollmentAttemptedWithHostedIdentity
    && !enrollmentEstablished
    && error?.code === "IDENTITY_TOKEN_INVALID";
  if (retryNeedsFreshSignIn) {
    await clearPendingHostedSignIn().catch(() => {});
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
// overlapping activations cannot race the bounded read-back.
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
$("#incremental-copy-diagnostics").addEventListener("click", () => {
  void copyContributionDiagnostics();
});
$("#incremental-consent-approve").addEventListener("click", () => {
  void approveIncrementalContribution();
});
$("#incremental-sync-retry").addEventListener("click", () => {
  void runIncrementalSyncNow();
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
  // The share card's activity figure follows this same selection
  // (owner-directed, 2026-08-10). The chart renderer owns the card
  // re-render, so this goes through renderWeekly — the same rule the weekly
  // range and span handlers follow — rather than a direct card call a new
  // path could forget.
  renderWeekly(dashboard);
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
// Same clamped-in-renderer rule for the Allowance page's reset-estimate table.
$("#weekly-table-prev").addEventListener("click", () => {
  weeklyTablePage -= 1;
  renderWeeklyTablePage();
});
$("#weekly-table-next").addEventListener("click", () => {
  weeklyTablePage += 1;
  renderWeeklyTablePage();
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
$("#cache-continuity-gap-page-prev").addEventListener("click", () => {
  cacheContinuityGapTablePagination.page -= 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
  );
});
$("#cache-continuity-gap-page-next").addEventListener("click", () => {
  cacheContinuityGapTablePagination.page += 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
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
  activeCalibrationRangeDays = ALL_HISTORY_RANGE_DAYS;
  for (const control of $("#calibration-range-controls").querySelectorAll(
    "button",
  )) {
    const active = Number(control.dataset.days) === ALL_HISTORY_RANGE_DAYS;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  timelineViewport = { startMs, endMs };
  timelineSeriesMemo = null;
  window.location.hash = "#timeline";
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
  // now, while its bounded recovery handle may still be valid (owner-reported
  // orphaned proof, 2026-08-08).
  void resumePendingHostedSignIn();
  scheduleReturningUserRefresh();
}

bootstrapDashboard();
