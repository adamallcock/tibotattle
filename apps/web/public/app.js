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
  normalizeParticipantHistory,
  selectPrimaryCodexQuotaWindow
} from "./data-client.js";
import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  contributionBatchAdmission,
  createDiagnosticReference,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
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
  formatLocal,
  formatNumber,
  formatReportingTime,
  formatTimeZoneLabel,
  getFormattingLocale,
  localCalendarParts,
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
let activeWindowHours = 1;
let activeUsageRangeDays = 7;
let activeCalibrationRangeDays = 7;
let activeUsageGrouping = "hour";
let activeAccountingPeriod = "7d";
let activeWeeklyRangeDays = 31;
let activeWeeklyMinimumObservedSpanPp = 50;
let timelineViewport = null;
let timelinePointerStart = null;
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
let fastModePreference = null;
let fastModePreferenceBusy = false;
let participantContributionAdmission = null;
let localOnboarding = null;
let contributionPreparationBusy = false;
let communityConnectBusy = false;
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
let activeContributionLookbackHours = 24;
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
  element.removeAttribute("data-i18n-skip");
  localization.setLegacyText(element, englishText);
}

function setRawText(element, value) {
  if (!element) return;
  element.setAttribute("data-i18n-skip", "");
  element.textContent = value == null ? "" : String(value);
}

function setLocalizedText(element, key, values = {}) {
  if (!element) return;
  element.removeAttribute("data-i18n-skip");
  element.textContent = t(key, values);
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
  // values, then run the bridge once more after every renderer has rebuilt its
  // subtree. This prevents a previous locale's nodes from surviving a switch
  // back to English (or Spanish) in the same WebView.
  localization.localizeTree();
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  if (dashboard) {
    renderDashboard(dashboard);
  } else if (dashboardUnavailableState) {
    renderDashboardUnavailableState(dashboardUnavailableState);
  } else if (globalState) {
    renderGlobalState();
  }
  if (localOnboarding) renderLocalOnboarding(localOnboarding);
  renderHostedIdentity();
  renderPreparationIdentity(localCompanionHealth);
  renderContributionSyncStatus(contributionSyncStatus);
  renderContributionSyncPreview(contributionSyncPreview);
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
  if (!hasEvidence) {
    $("#community-contribution-disclosure")?.removeAttribute("open");
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
    participantContributionAdmission = null;
    renderContributionPreparationEstimate();
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

function formatPercent(value, digits = 0) {
  const number = finite(value);
  if (number === null) return "—";
  return new Intl.NumberFormat(getFormattingLocale(), {
    maximumFractionDigits: Number.isInteger(number) ? 0 : digits,
    minimumFractionDigits: 0,
    style: "percent",
  }).format(number / 100);
}

function formatDecimal(value, digits = 0) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat(getFormattingLocale(), {
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
  $("#latest-observation").textContent = data.freshness.latestObservedAt
    ? formatAge(data.freshness.ageSeconds ?? (Date.now() - Date.parse(data.freshness.latestObservedAt)) / 1000)
    : "No timestamp";
  $("#data-source").textContent = data.mode === "demo"
    ? "Illustrative fixture — not your usage"
    : `${formatLocal(data.freshness.latestObservedAt)} · local companion`;
  $("#schema-version").textContent = t("dashboard.contract", {
    version: data.schemaVersion,
  });

  if (data.mode === "demo") {
    showConnectionNotice({
      title: "You are exploring a labeled demonstration",
      copy: "Every number on this page is illustrative. Open the Mac app and use the TiboTattle in-app window to see your own evidence.",
      kind: "demo",
      showCheck: true
    });
  } else if (data.state === "stale") {
    showConnectionNotice({
      title: "The local evidence is stale",
      copy: "The dashboard is showing real local artifacts, but the latest collector observation is older than its freshness threshold.",
      kind: "warning"
    });
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
  renderPricing(data);
  renderComparison(data);
  renderShareCard(data);
  renderUsageTimeline(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  renderContributionPreparationEstimate();
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
    name.textContent = t("dashboard.quota.observations");
    const chip = node("span", "evidence-chip");
    chip.textContent = t("dashboard.quota.insufficient");
    const value = node("strong", "metric-value", "—");
    const copy = node("p");
    copy.textContent = t("dashboard.quota.noCurrent");
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
      plan.textContent = t("dashboard.quota.spark");
    } else if (data.mode === "demo") {
      plan.textContent = t("dashboard.quota.demo");
    } else if (reportedPlan) {
      plan.textContent = reportedPlan;
    } else {
      plan.textContent = t("dashboard.quota.observed");
    }
    header.append(
      name,
      plan,
    );
    const value = node("strong", "metric-value");
    value.textContent = t("dashboard.quota.remaining", {
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

function historyCoverageLabel(history) {
  if (archiveHistoryScanActive) {
    return t(history?.status === "complete"
      ? "dashboard.pricing.historyScanningComplete"
      : "dashboard.pricing.historyScanningPartial");
  }
  if (history?.status === "complete") {
    return t("dashboard.pricing.historyComplete");
  }
  if (history?.errorCode === "archive_disk_space") {
    return t("dashboard.pricing.historyDiskSpace");
  }
  if (history?.errorCode === "archive_storage_unavailable") {
    return t("dashboard.pricing.historyStorageUnavailable");
  }
  if (history?.phase === "not_started") {
    return t("dashboard.pricing.historyNotStarted");
  }
  const indexed = finite(history?.indexedSourceCount, 0);
  const total = finite(history?.sourceCount, 0);
  if (total > 0) {
    return t("dashboard.pricing.historyProgress", {
      indexed: compact(indexed),
      total: compact(total),
    });
  }
  return t("dashboard.pricing.historyResume");
}

function pricingMethodLabel(pricing) {
  const replaySafe = finite(pricing?.replayExclusionDiagnostics?.filesScanned, 0) > 0
    || String(pricing?.accountingSource ?? "").includes("replay");
  if (!replaySafe) return t("dashboard.pricing.legacyProjection");
  const key = pricing?.accountingCacheStatus === "stale"
    ? "dashboard.pricing.staleReplaySafe"
    : "dashboard.pricing.replaySafe";
  return t(key);
}

function pricingRegistryProvenance(pricing) {
  const version = typeof pricing?.registryVersion === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(pricing.registryVersion)
    ? pricing.registryVersion
    : "";
  if (!version) return "";
  const observedAt = pricing.registryObservedAt
    ? t("dashboard.pricing.registryObservedAt", {
      time: formatLocal(pricing.registryObservedAt, { dateOnly: true }),
    })
    : "";
  return t("dashboard.pricing.registryProvenance", { version, observedAt });
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
  const eventCount = finite(pricing.eventCount, 0);
  const coverage = pricing.coveragePercent;
  const history = historyCoverageLabel(pricing.historyCoverage);
  const method = pricingMethodLabel(pricing);
  const provenance = pricingRegistryProvenance(pricing);
  const coverageElement = $("#cost-coverage");
  const coverageKey = coverage === null
    ? history
      ? "dashboard.pricing.noCoverageWithHistory"
      : "dashboard.pricing.noCoverage"
    : history
      ? "dashboard.pricing.coverageWithHistory"
      : "dashboard.pricing.coverage";
  const coverageValues = coverage === null
      ? { history }
      : {
        percent: formatPercent(coverage, 1),
        method,
        provenance,
        history,
      };
  clear(coverageElement);
  const coverageLine = node("span", "coverage-line");
  setRawText(coverageLine, t(coverageKey, coverageValues));
  coverageElement.append(coverageLine);
  if (pricing.historyCoverage?.status === "partial") {
    const startAt = pricing.historyCoverage.coveredAt?.startAt
      || pricing.evidenceStartDate
      || "";
    const warning = node("span", "coverage-warning");
    setRawText(warning, t("accounting.pricing.thirtyDayCoverageWarning", {
      date: startAt ? ` on ${formatLocal(startAt, { dateOnly: true })}` : "",
    }));
    coverageElement.append(warning);
  }
  coverageElement.title = eventCount > 0
    ? t("dashboard.pricing.coverageDenominator", { count: compact(eventCount) })
    : "";
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

function humanize(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function latestRollingPair(data) {
  if (data.timeline?.usage?.length) {
    const live = liveTimelinePoints(data, {
      windowHours: 1,
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
  const groups = groupRolling(data.gradient.rolling, 1);
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

function renderCalibrationRate({ capacity, lower, upper, qualifyingResets = 0 }) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
  if (capacity === null || capacity <= 0) {
    setProductText(rate, "Not estimable");
    setProductText(range, "Not estimable");
    setProductText(example, "Not estimable");
    explanation.textContent = t("dashboard.calibration.noRate");
    return;
  }
  const perPoint = capacity / 100;
  const movementForHundred = 10_000 / capacity;
  rate.textContent = t("dashboard.calibration.perPoint", {
    amount: formatMoney(perPoint, 2),
  });
  range.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? t("dashboard.calibration.range", {
      lower: formatMoney(lower / 100, 2),
      upper: formatMoney(upper / 100, 2),
    })
    : t("dashboard.calibration.rangeUnavailable");
  example.textContent = t("dashboard.calibration.example", {
    points: formatDecimal(movementForHundred, 1),
  });
  explanation.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? t("dashboard.calibration.withRange", {
      count: Math.max(1, Math.round(qualifyingResets)),
      amount: formatMoney(capacity, 0),
      lower: formatMoney(lower, 0),
      upper: formatMoney(upper, 0),
    })
    : t("dashboard.calibration.withoutRange", {
      amount: formatMoney(capacity, 0),
    });
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
const SHARE_CARD_TREND_MIN_HEIGHT = 142;
// The chart is the evidence on the image, not decorative garnish. Reserve a
// meaningful vertical lane for it instead of compressing it below three cards
// and a verbose footer.
const SHARE_CARD_TREND_MAX_HEIGHT = 290;
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

  const stats = [
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
  ];

  const relationshipNote = isWeeklyWindow && spend !== null && hasCapacity
    ? t("share.relationship", { period })
    : "";

  // Assembled from the same state the panels report, strongest qualification
  // first. The distinct activity-versus-allowance explanation lives directly
  // under the figures above, so it is never displaced by a shorter caveat.
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
    relationshipNote,
    // Reset-fit history is an explicitly seven-day model. It is never drawn
    // behind a five-hour or provider-reported generic allowance window.
    trend: isWeeklyWindow ? shareCardTrend(history) : null,
    trendLabel: t("share.trend.label"),
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
  });
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
      fits: tPlural("share.resetFit", card.trend.count),
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

  drawShareCardBrand(context, margin, 68);
  context.textBaseline = "alphabetic";
  context.fillStyle = "#17211e";
  context.font = shareCardFont(800, 25);
  context.fillText("TiboTattle", margin + 52, 77);
  if (card.badge !== "") {
    drawShareCardBadge(
      context,
      card.badge,
      margin + 68 + context.measureText("TiboTattle").width,
      75,
    );
  }

  context.textAlign = "right";
  context.font = shareCardFont(700, 20);
  context.fillStyle = "#65706b";
  if (card.home !== "") {
    context.fillText(card.home, SHARE_CARD_WIDTH - margin, 77);
  }
  context.textAlign = "left";

  context.fillStyle = "#17211e";
  context.font = shareCardFont(500, 52, "serif");
  context.fillText(shareCardFit(context, card.title, inner), margin, 158);
  context.font = shareCardFont(600, 21);
  context.fillStyle = "#65706b";
  context.fillText(shareCardFit(context, card.subtitle, inner), margin, 192);

  const gap = 22;
  const columnWidth = (inner - gap * 2) / 3;
  const statTop = 207;
  const statHeight = 165;
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
      context.fillText(line, x + padding, statTop + 34 + lineIndex * 19);
    });
    context.fillStyle = "#174f45";
    context.font = shareCardFont(500, valueSize, "serif");
    context.fillText(
      shareCardFit(context, stat.value, textWidth),
      x + padding,
      statTop + 104,
    );
    context.fillStyle = "#65706b";
    context.font = shareCardFont(600, 17);
    shareCardWrap(context, stat.detail, textWidth, 2).forEach((line, lineIndex) => {
      context.fillText(line, x + padding, statTop + 132 + lineIndex * 20);
    });
  });

  // A short comparison note sits directly beneath the figures because the
  // rolling activity total and the single-allowance estimate are intentionally
  // not comparable measurements. It is visual context, not a fine-print
  // caveat, so it stays readable when a card is seen outside the dashboard.
  const relationshipTop = statTop + statHeight + 21;
  if (card.relationshipNote !== "") {
    context.fillStyle = "rgba(23, 79, 69, .3)";
    context.fillRect(margin, relationshipTop - 14, 3, 22);
    context.fillStyle = "#65706b";
    context.font = shareCardFont(600, 15);
    context.fillText(
      shareCardFit(context, card.relationshipNote, inner - 20),
      margin + 18,
      relationshipTop,
    );
  }

  // Qualifications are reserved only for incomplete data. A complete card
  // gives the plot its natural visual weight instead of spending the lower
  // third on generic methodology copy.
  context.font = shareCardFont(500, 17);
  const caveatLines = card.caveats
    .slice(0, SHARE_CARD_MAX_CAVEATS)
    .flatMap((caveat) => shareCardWrap(context, caveat, inner - 20, 2))
    .slice(0, SHARE_CARD_MAX_CAVEAT_LINES);
  const caveatStep = 23;
  const ruleY = SHARE_CARD_HEIGHT - 58.5;
  const caveatTop = caveatLines.length === 0
    ? ruleY - 8
    : ruleY - 22 - (caveatLines.length - 1) * caveatStep;
  const trendTop = card.relationshipNote === ""
    ? statTop + statHeight + 36
    : statTop + statHeight + 48;
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
  if (card.trend !== null) {
    context.textAlign = "right";
    context.fillText(
      tPlural("share.resetFit", card.trend.count),
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

  context.strokeStyle = "rgba(23, 33, 30, .16)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(margin, ruleY);
  context.lineTo(SHARE_CARD_WIDTH - margin, ruleY);
  context.stroke();

  context.fillStyle = "#65706b";
  context.font = shareCardFont(500, 12);
  context.fillText(
    shareCardFit(context, card.identifierLine, inner),
    margin,
    ruleY + 24,
  );
  context.fillStyle = "#65706b";
  context.font = shareCardFont(500, 13);
  context.fillText(
    shareCardFit(
      context,
      t("share.footer"),
      inner,
    ),
    margin,
    ruleY + 48,
  );
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
 */
function renderShareCard(data) {
  const canvas = $("#share-card-canvas");
  const allowanceWindow = shareCardWindow(data?.quotaWindows ?? []);
  const isWeeklyWindow = shareCardWindowKind(allowanceWindow) === "seven_day";
  const history = isWeeklyWindow ? allowanceHistoryChartModel(data) : null;
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
  $("#share-card-reference").textContent = shareCard.reference;
  canvas.setAttribute("aria-label", shareCardText(shareCard));
  if (!drawShareCard(canvas, shareCard)) {
    shareCard = null;
    setShareCardStatus(
      "This browser did not provide a drawing surface, so no image could be produced. The card's figures are listed below it as text.",
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
        "This browser could not turn the card into a PNG. Nothing was saved; the figures remain listed below as text.",
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
    setShareCardStatus(
      `Saved as ${shareCardFileName(card)}. Reference ${card.reference} is printed on the image.`,
    );
  });
}

function copyShareCardImage() {
  return runShareCardAction(async (card) => {
    if (typeof ClipboardItem !== "function"
      || typeof navigator.clipboard?.write !== "function") {
      setShareCardStatus(
        "This browser cannot put an image on the clipboard. Use Save image instead, or Copy as text.",
        { error: true },
      );
      return;
    }
    const blob = await shareCardBlob($("#share-card-canvas"));
    if (blob === null) {
      setShareCardStatus(
        "This browser could not turn the card into a PNG. Nothing was copied.",
        { error: true },
      );
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setShareCardStatus(
        `Copied. Paste it anywhere; reference ${card.reference} is printed on the image.`,
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
        "This browser cannot write to the clipboard. The card's text is listed below it and can be selected.",
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
    const group = groups.get(timestamp) ?? { timestamp, observed: null, expected: null };
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
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
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

function timelineBounds(points) {
  const values = points
    .map((point) => Date.parse(point.timestamp))
    .filter(Number.isFinite);
  if (values.length < 2) return null;
  return { startMs: Math.min(...values), endMs: Math.max(...values) };
}

function normalizeTimelineViewport(points) {
  const bounds = timelineBounds(points);
  if (bounds === null) return null;
  if (timelineViewport === null) return bounds;
  const startMs = Math.max(bounds.startMs, Math.min(timelineViewport.startMs, bounds.endMs));
  const endMs = Math.max(startMs + 1, Math.min(timelineViewport.endMs, bounds.endMs));
  if (endMs - startMs < 60_000) return bounds;
  return { startMs, endMs };
}

function timelinePointsInViewport(points, viewport) {
  if (viewport === null) return points;
  return points.filter((point) => {
    const timestamp = Date.parse(point.timestamp);
    return Number.isFinite(timestamp)
      && timestamp >= viewport.startMs
      && timestamp <= viewport.endMs;
  });
}

function resetTimelineViewport() {
  timelineViewport = null;
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
  timelineViewport = endMs - startMs >= bounds.endMs - bounds.startMs - 1
    ? null
    : { startMs, endMs };
  if (dashboard) renderTimeline(dashboard);
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

function timelineStatusLabel(status) {
  return {
    matched: "Matched quota bracket",
    inactive: "No local activity or quota movement",
    unpriced_local_activity: "Usage change without reviewed price",
    unexplained_without_local_activity: "Quota movement without a local usage change",
    missing_quota_bracket: "Quota bracket not recorded",
    reset_or_track_change: "Window boundary or track change",
    backward_or_ambiguous: "Movement needs context",
  }[status] ?? "Historical calibration point";
}

function timelineStatusIntervals(points, viewport) {
  const rows = points
    .filter((point) => Number.isFinite(Date.parse(point.timestamp)))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return rows.flatMap((point, index) => {
    if (!point.status || point.status === "matched" || point.status === "inactive") return [];
    const current = Date.parse(point.timestamp);
    const previous = index === 0 ? viewport.startMs : Date.parse(rows[index - 1].timestamp);
    const next = index === rows.length - 1 ? viewport.endMs : Date.parse(rows[index + 1].timestamp);
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

function liveTimelinePoints(
  data,
  {
    windowHours = activeWindowHours,
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
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    rollingCost += current.apiPriceEquivalentUsd;
    rollingEvents += current.usageEvents;
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
    const sameReset = bracketed && before.resetAt && before.resetAt === after.resetAt;
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
    points.push({
      timestamp: current.endAt,
      observed,
      expected,
      residual: evidence.residual,
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

function usageChartAxisLabels(grouping = activeUsageGrouping) {
  const unit = {
    hour: "hour",
    day: "day",
    week: "week",
  }[grouping] ?? "interval";
  return Object.freeze({
    primary: `API equivalent / ${unit}`,
    secondary: "Observed allowance remaining (%)",
  });
}

function renderUsageTimeline(data) {
  syncUsageGroupingControls();
  const points = usagePointsWithAllowance(data, groupedUsageTimeline(data));
  const shell = $("#usage-timeline-chart");
  const empty = $("#usage-timeline-empty");
  const label = { hour: "hour", day: "day", week: "week" }[activeUsageGrouping];
  const axisLabels = usageChartAxisLabels();
  $("#usage-timeline-title").textContent =
    `API-price-equivalent usage by ${label} · latest ${activeUsageRangeDays} day${activeUsageRangeDays === 1 ? "" : "s"}`;
  if (!points.length) {
    shell.hidden = true;
    empty.hidden = false;
  } else {
    shell.hidden = false;
    empty.hidden = true;
    shell.replaceChildren(lineChart({
      points,
      series: [{
        key: "apiCostUsd",
        className: "chart-line-value",
        label: "API-price-equivalent usage",
        markers: false,
        hitTargets: true,
        markerRadius: 2.6,
        format: (value) => formatApiMoney(value),
      }],
      yLabel: axisLabels.primary,
      secondarySeries: [{
        key: "allowanceRemaining",
        className: "chart-line-allowance",
        label: "Observed allowance remaining",
        markers: false,
        hitTargets: true,
      }],
      secondaryYLabel: axisLabels.secondary,
      title: "Real local API-price-equivalent usage over time",
      description: `Local API-price-equivalent usage with provider-observed seven-day allowance remaining. Times are shown in ${formatTimeZoneLabel()}.`,
      includeZero: true,
      rotateXTickLabels: true,
    }));
  }
  $("#usage-timeline-copy").textContent =
    `Times shown in ${formatTimeZoneLabel()}.`;
  const summary = $("#usage-timeline-summary");
  clear(summary);
  const total = points.reduce((sum, row) => sum + row.apiCostUsd, 0);
  for (const [name, explanation, value] of [
    [
      "Time intervals",
      "The number of displayed hour, day, or week intervals.",
      compact(points.length)
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

function selectedTimelinePoints(data) {
  const livePoints = liveTimelinePoints(data);
  const cutoff = timelineCutoffMs(data, activeCalibrationRangeDays);
  const historicalPoints = groupRolling(
    [...data.gradient.rollingHistory, ...data.gradient.rolling],
    activeWindowHours,
  ).filter((row) => Date.parse(row.timestamp) >= cutoff);
  const liveMatched = livePoints.filter(
    (row) => row.observed !== null && row.expected !== null,
  ).length;
  const usingLive = liveMatched > 0 || historicalPoints.length === 0;
  return { points: usingLive ? livePoints : historicalPoints, usingLive };
}

function renderTimeline(data) {
  const { points, usingLive } = selectedTimelinePoints(data);
  const viewport = normalizeTimelineViewport(points);
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const matchedVisible = visiblePoints.filter(
    (point) => point.observed !== null && point.expected !== null,
  );
  const windowLabel = activeWindowHours === 0.25
    ? t("dashboard.timeWindow.fifteenMinutes")
    : t("dashboard.timeWindow.hours", { count: activeWindowHours });
  $("#timeline-chart-title").textContent = t("dashboard.timeline.title", {
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
    shell.replaceChildren(lineChart({
      points: visiblePoints,
      series: [
        {
          key: "observed",
          className: "chart-line-observed",
          label: t("dashboard.timeline.observedQuota"),
          markers: false,
          hitTargets: true,
          format: formatPp,
        },
        {
          key: "expected",
          className: "chart-line-expected",
          label: t("dashboard.timeline.expectedCost"),
          markers: false,
          hitTargets: true,
          format: formatPp,
        }
      ],
      yLabel: t("dashboard.timeline.percentagePoints"),
      title: t("dashboard.timeline.movementTitle", { window: windowLabel }),
      description: t("dashboard.timeline.chartDescription", {
        timeZone: formatTimeZoneLabel(),
      }),
      includeZero: true,
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
      rotateXTickLabels: true,
    }));
    bindTimelineInteractions(shell, points, viewport);
  }
  renderTimelineSummary(data, visiblePoints);
  renderTimelineConfidence(points, visiblePoints, usingLive, viewport);
  renderResiduals(data, visiblePoints, viewport);
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
    element.textContent = t("dashboard.timeline.lowConfidence", {
      visible: tPlural("dashboard.timeline.visibleWindow", matched),
      excluded: tPlural("dashboard.timeline.excludedWindow", excluded),
    });
  } else if (excluded > 0) {
    element.textContent = t("dashboard.timeline.excludedShown", {
      shown: tPlural("dashboard.timeline.shownWindow", matched),
      excluded: tPlural("dashboard.timeline.excludedWindow", excluded),
    });
  } else {
    element.textContent = t("dashboard.timeline.allMatched", {
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
  status.textContent = t("dashboard.timeline.status", {
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

function renderTimelineSummary(data, points) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === activeWindowHours);
  const activePoints = points.filter((row) => row.status !== "inactive");
  const matched = activePoints.filter((row) => row.observed !== null && row.expected !== null);
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const liveMae = matched.length
    ? matched.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / matched.length
    : null;
  const livePeak = matched.length
    ? Math.max(...matched.map((row) => Math.abs(row.observed - row.expected)))
    : null;
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
    ? data.gradient.residual.map((row) => ({
        timestamp: row.timestamp ?? row.window_end_utc,
        observed: finite(row.observed_quota_change_pp),
        expected: finite(row.expected_quota_change_pp),
        residual: finite(row.residual_pp)
      }))
    : [];
  const visibleArtifactResiduals = artifactResiduals.filter((row) => {
    const timestamp = Date.parse(row.timestamp);
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
      const timestamp = Date.parse(row.timestamp);
      return row.status !== "inactive"
        && Number.isFinite(timestamp)
        && (visibleBounds === null
          || (timestamp >= visibleBounds.startMs && timestamp <= visibleBounds.endMs));
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
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
    element.textContent = tPlural("dashboard.residual.allComputable", rows.length);
  } else {
    element.textContent = t("dashboard.residual.partial", {
      computed: computed.length,
      total: rows.length,
      missing,
      reasons: residualGapReasons(rows).join(", "),
    });
  }
}

function renderResiduals(data, points, viewport = null) {
  const timeHeading = $("#residual-time-heading");
  if (timeHeading) {
    timeHeading.textContent = t("format.localTime");
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
    shell.replaceChildren(lineChart({
      points: residuals,
      series: [{
        key: "residual",
        className: "chart-line-value",
        label: "Residual",
        markers: false,
        hitTargets: true,
        format: formatPp,
      }],
      yLabel: "Percentage points",
      title: "Quota movement residuals",
      description: "Observed quota change minus the API-cost-implied change, over the same date range as the calibration chart. Windows with no computable residual are left as shaded gaps.",
      includeZero: true,
      xDomain: domain,
      statusIntervals: domain === null
        ? []
        : timelineStatusIntervals(residuals, domain),
      rotateXTickLabels: true,
    }));
  }
  renderResidualCoverage(residuals, computed);
  const table = $("#residual-table");
  clear(table);
  const unmatched = points
    .filter((point) => point.timestamp && point.status
      && !["matched", "inactive"].includes(point.status))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const largest = [...computed]
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  const inspection = [...unmatched, ...largest]
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.timestamp === row.timestamp) === index)
    .slice(0, 8);
  if (!inspection.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No periods loaded.");
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const item of inspection) {
    const row = node("tr");
    const residual = item.observed === null || item.expected === null
      ? null
      : item.residual;
    row.append(
      node("td", "", formatReportingTime(item.timestamp)),
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? "Not comparable" : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      node("td", "", timelineStatusLabel(item.status ?? "matched")),
    );
    table.append(row);
  }
}

function formatChartTimeLabel(value, { dateOnly = false } = {}) {
  const timestamp = value instanceof Date
    ? value.valueOf()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("format.unknown");
  try {
    const locale = getFormattingLocale();
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: USER_TIME_ZONE,
      month: "short",
      day: "numeric",
      ...(dateOnly ? { year: "numeric" } : {}),
    }).format(new Date(timestamp));
    if (dateOnly) return date;
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: USER_TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
    return `${date} · ${time}`;
  } catch {
    return formatLocal(new Date(timestamp).toISOString(), { dateOnly });
  }
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
  rotateXTickLabels = false,
}) {
  // Data-point details are the safe default for every chart series. A caller
  // may opt out of the visual markers or the tooltip, but accessibility must
  // not disappear merely because a new series forgot an opt-in flag.
  const chartSeries = (Array.isArray(series) ? series : []).map((item) => ({
    ...item,
    markers: item.markers !== false,
    hitTargets: item.hitTargets !== false,
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const chartSecondarySeries = (Array.isArray(secondarySeries) ? secondarySeries : []).map((item) => ({
    ...item,
    markers: item.markers !== false,
    hitTargets: item.hitTargets !== false,
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const width = 900;
  const height = 300;
  const hasSecondary = chartSecondarySeries.length > 0;
  const margin = {
    top: 16,
    right: hasSecondary ? 96 : 24,
    bottom: rotateXTickLabels ? 66 : 44,
    left: 72,
  };
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
  const timestamps = points.map((point) => Date.parse(point.timestamp ?? point.date));
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
  const x = (index, point = points[index]) => {
    const coordinate = timed
      ? (Date.parse(point.timestamp ?? point.date) - domainStartMs)
        / (safeDomainEndMs - domainStartMs)
      : index / Math.max(1, points.length - 1);
    return margin.left + coordinate * (width - margin.left - margin.right);
  };
  const y = (value) => margin.top + (max - value) / (max - min) * (height - margin.top - margin.bottom);
  const ySecondary = (value) => margin.top
    + (100 - Math.max(0, Math.min(100, value))) / 100
      * (height - margin.top - margin.bottom);

  const chartTickStep = (low, high, target = 5) => {
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
  const chartTickDigits = (step) => {
    if (!Number.isFinite(step) || step >= 1) return 0;
    return Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))));
  };
  const yStep = chartTickStep(min, max);
  const yDigits = chartTickDigits(yStep);
  const yTicks = Array.isArray(yDomain?.ticks) && yDomain.ticks.length > 0
    ? yDomain.ticks.filter((value) => Number.isFinite(value))
    : (() => {
      const first = Math.ceil(max / yStep) * yStep;
      const last = Math.floor(min / yStep) * yStep;
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
  const titleNode = document.createElementNS(svg.namespaceURI, "title");
  setRawText(titleNode, title);
  const descNode = document.createElementNS(svg.namespaceURI, "desc");
  setRawText(descNode, description);
  svg.append(titleNode, descNode);

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
        update(entries[0]?.contentRect?.width ?? renderedWidth);
      });
      observer.observe(svg);
    }
  };

  for (const value of yTicks) {
    const yPosition = y(value);
    svg.append(svgLine(margin.left, yPosition, width - margin.right, yPosition, "chart-grid"));
    const label = yTickFormat === null
      ? formatDecimal(value, yDigits)
      : yTickFormat(value, yDigits);
    svg.append(svgText(margin.left - 8, yPosition + 3, label, "chart-axis-label", "end"));
    if (hasSecondary) {
      const secondaryRatio = yTicks.length <= 1
        ? 0
        : yTicks.indexOf(value) / (yTicks.length - 1);
      svg.append(svgText(
        width - margin.right + 8,
        margin.top + secondaryRatio * (height - margin.top - margin.bottom) + 3,
        `${formatDecimal(100 - secondaryRatio * 100, 0)}%`,
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
    const ticks = Array.isArray(xTicks) && xTicks.length > 0
      ? xTicks
      : Array.from({ length: automaticTickCount }, (_, index) => {
        const at = domainStartMs + (safeDomainEndMs - domainStartMs)
          * index / (automaticTickCount - 1);
        return {
          at,
          label: formatChartTimeLabel(at, {
            dateOnly: safeDomainEndMs - domainStartMs > 7 * 24 * 60 * 60 * 1_000,
          }),
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
        rotateXTickLabels ? height - 34 : height - 22,
        typeof tick.label === "string"
          ? tick.label
          : formatChartTimeLabel(at, { dateOnly: true }),
        "chart-axis-label",
        tick.alignment ?? "middle",
      );
      if (rotateXTickLabels) {
        tickLabel.setAttribute(
          "transform",
          `rotate(-24 ${position} ${height - 34})`,
        );
      }
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  } else {
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
    const tickLabels = [];
    for (const index of labelIndexes) {
      const timestamp = points[index]?.timestamp ?? points[index]?.date;
      const tickLabel = svgText(x(index), height - 22, formatChartTimeLabel(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle");
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  }
  const yAxisLabel = svgText(15, height / 2, yLabel, "chart-axis-label", "middle");
  yAxisLabel.setAttribute("transform", `rotate(-90 15 ${height / 2})`);
  svg.append(yAxisLabel);
  if (hasSecondary && secondaryYLabel) {
    const secondaryLabel = svgText(
      width - 8,
      height / 2,
      secondaryYLabel,
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
      const bandHeading = confidence.label ?? "Confidence band";
      const bandDetail = `${bandFormat(bandLow)}–${bandFormat(bandHigh)}`;
      const bandCaption = `${bandHeading}: ${bandDetail}`;
      const bandTitle = document.createElementNS(svg.namespaceURI, "title");
      setRawText(bandTitle, bandCaption);
      polygon.append(bandTitle);
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
        setRawText(
          barTitle,
          `${errorBars.label}: ${format(low)}–${format(high)}${point.timestamp ? ` · ${formatLocal(point.timestamp)}` : ""}`,
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
    setRawText(intervalTitle, timelineStatusLabel(interval.status));
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
        const heading = `${item.label}: ${format(representative.value)}`;
        const detail = typeof item.lineDetail === "function"
          ? item.lineDetail(pathPoints.map(({ point }) => point))
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        const lineTitle = document.createElementNS(svg.namespaceURI, "title");
        setRawText(lineTitle, caption);
        path.append(lineTitle);
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
    if (item.markers !== false || item.hitTargets !== false) {
      const format = item.format ?? formatMoney;
      points.forEach((point, index) => {
        const value = finite(point[item.key]);
        if (value === null) return;
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(x(index, point)));
        marker.setAttribute("cy", String(y(value)));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 4;
        const showMarker = item.markers !== false
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
        const heading = `${item.label}: ${format(value)}`;
        const detail = [
          item.detail?.(point),
          timestamp ? formatLocal(timestamp) : null,
        ].filter(Boolean).join(" · ");
        const caption = [heading, detail].filter(Boolean).join(" · ");
        if (item.tooltip !== false) {
          const markerTitle = document.createElementNS(svg.namespaceURI, "title");
          setRawText(markerTitle, caption);
          marker.append(markerTitle);
        }
        // A hover title alone is mouse-only, so focusable markers carry the
        // identical sentence to the keyboard and to assistive technology.
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: x(index, point),
          yPosition: y(value),
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
        const format = item.format ?? ((value) => `${formatDecimal(value, 1)}%`);
        const representative = pathPoints[Math.floor(pathPoints.length / 2)];
        const heading = `${item.label}: ${format(representative.value)}`;
        const detail = typeof item.lineDetail === "function"
          ? item.lineDetail(pathPoints.map(({ point }) => point))
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        const lineTitle = document.createElementNS(svg.namespaceURI, "title");
        setRawText(lineTitle, caption);
        path.append(lineTitle);
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
    if (item.markers !== false || item.hitTargets !== false) {
      const format = item.format ?? ((value) => `${formatDecimal(value, 1)}%`);
      points.forEach((point, index) => {
        const value = finite(point[item.key]);
        if (value === null) return;
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(x(index, point)));
        marker.setAttribute("cy", String(ySecondary(value)));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 2.6;
        const showMarker = item.markers !== false
          && Number.isFinite(visualRadius)
          && visualRadius > 0;
        marker.setAttribute("r", String(showMarker
          ? visualRadius
          : Math.max(7, finite(item.hitRadius, 8))));
        marker.setAttribute("class", showMarker
          ? `${item.className} chart-point`
          : `${item.className} chart-point chart-point-hit-target`);
        const heading = `${item.label}: ${format(value)}`;
        const detail = point.timestamp ? formatLocal(point.timestamp) : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        if (item.tooltip !== false) {
          const markerTitle = document.createElementNS(svg.namespaceURI, "title");
          setRawText(markerTitle, caption);
          marker.append(markerTitle);
        }
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: x(index, point),
          yPosition: ySecondary(value),
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
  // Chart text can include source-derived labels and values. It arrives
  // already formatted by the caller and is never eligible for exact-text
  // translation.
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
  const cutoffAt = latestObservedAt === null || validRangeDays === null
    ? Number.NEGATIVE_INFINITY
    : latestObservedAt - validRangeDays * 24 * 60 * 60 * 1_000;
  const points = allPoints.filter((point) => (
    point.at >= cutoffAt
      && (activeWeeklyMinimumObservedSpanPp === 0
        || (point.observedSpanPp !== null
          && point.observedSpanPp >= activeWeeklyMinimumObservedSpanPp))
  ));
  const axis = allowanceHistoryAxis(points);
  return Object.freeze({
    allPoints: Object.freeze(allPoints),
    points: Object.freeze(points),
    axis,
    xTicks: allowanceHistoryDateTicks(points),
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
  return Object.freeze({
    low,
    high,
    ticks: Object.freeze(
      Array.from({ length: 5 }, (_, index) => high - index / 4 * (high - low)),
    ),
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
  if (last <= first) {
    return Object.freeze([
      Object.freeze({ at: first, label: formatChartTimeLabel(first, { dateOnly: true }), alignment: "middle" }),
    ]);
  }
  return Object.freeze(Array.from({ length: maximum }, (_, index) => {
    const at = first + (last - first) * index / (maximum - 1);
    return Object.freeze({
      at,
      label: formatChartTimeLabel(at, { dateOnly: true }),
      alignment: index === 0 ? "start" : index === maximum - 1 ? "end" : "middle",
    });
  }));
}

function renderAllowanceHistoryChart(history) {
  return lineChart({
    points: history.points,
    series: [
      {
        key: "historicalMedian",
        className: "chart-line-weekly-center",
        label: "Historical median",
        markers: false,
        lineFocusable: true,
        lineDetail: (points) => `${points.length} reset estimates`,
        format: (value) => formatMoney(value),
      },
      {
        key: "value",
        className: "chart-point-weekly-mature",
        label: `Observed across ${activeWeeklyMinimumObservedSpanPp}+ points`,
        connect: false,
        markers: false,
        hitTargets: true,
        format: (value) => formatMoney(value),
        detail: (point) => `${formatPp(point.observedSpanPp)} observed · measured range ${formatMoney(point.low)}–${formatMoney(point.high)}`,
        markerRadius: (point) => point.wellObserved ? 4 : 0,
      },
      {
        key: "value",
        className: "chart-point-weekly-partial",
        label: "Short observation",
        connect: false,
        markers: false,
        hitTargets: true,
        format: (value) => formatMoney(value),
        detail: (point) => `${formatPp(point.observedSpanPp)} observed · measured range ${formatMoney(point.low)}–${formatMoney(point.high)}`,
        markerRadius: (point) => point.wellObserved ? 0 : 4,
      },
    ],
    confidence: {
      low: "acrossResetLow",
      high: "acrossResetHigh",
      label: "80% across-reset range",
      format: (value) => formatMoney(value),
    },
    errorBars: {
      low: "low",
      high: "high",
      className: "chart-error-bar-weekly",
      label: "Measured range",
      tooltip: false,
    },
    xDomain: {
      startMs: history.points[0]?.at,
      endMs: history.points.at(-1)?.at,
    },
    xTicks: history.xTicks,
    yDomain: history.axis,
    yTickFormat: (value, digits) => formatMoney(value, digits),
    yLabel: "7-day allowance ($)",
    title: "Seven-day allowance estimate history",
    description: `Each reset estimate meets the selected minimum observed quota span of ${activeWeeklyMinimumObservedSpanPp} percentage points. Measured ranges remain available on hover and focus.`,
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
  $("#weekly-estimate").textContent = estimate === null ? "Insufficient evidence" : `${formatMoney(estimate)} API equivalent`;
  $("#weekly-range").textContent = lower === null || upper === null
    ? "No evidence interval available"
    : `80% across-reset range: ${formatMoney(lower)}–${formatMoney(upper)}`;
  const evidenceExplanation = qualifying
    ? `${qualifying} qualifying reset estimates. The chart currently shows observations spanning at least ${activeWeeklyMinimumObservedSpanPp} percentage points.`
    : "The estimate will appear when enough quota transitions can be matched to priced usage.";
  $("#weekly-explanation").textContent = evidenceExplanation;

  const history = allowanceHistoryChartModel(data);
  const values = history.allPoints;
  const chartValues = history.points;
  $("#weekly-span-value").textContent = activeWeeklyMinimumObservedSpanPp === 0
    ? "All spans"
    : `${activeWeeklyMinimumObservedSpanPp}+ pp`;
  $("#weekly-span-legend").textContent = activeWeeklyMinimumObservedSpanPp === 0
    ? "All observed spans"
    : `Observed across ${activeWeeklyMinimumObservedSpanPp}+ points`;
  $("#weekly-partial-legend").hidden = !chartValues.some((row) => !row.wellObserved);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!chartValues.length) {
    empty.hidden = false;
    shell.hidden = true;
    empty.textContent = "No weekly estimates loaded.";
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(renderAllowanceHistoryChart(history));
  }
  renderWeeklyTable(values);
}

function renderWeeklyTable(values) {
  const table = $("#weekly-table");
  clear(table);
  if (!values.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No weekly evidence loaded.");
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const row of values.slice(-14).reverse()) {
    const span = row.observedSpanPp ?? finite(row.displayed_span_pp);
    const status = isWellObservedWeeklyFit(span)
      ? "Well observed"
      : span === null ? "Span not recorded" : "Short observation";
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
  const pricedEvents = finite(accounting.pricingCoverage?.fullyPricedEvents, 0)
    + finite(accounting.pricingCoverage?.partiallyPricedEvents, 0);
  const unpricedEvents = finite(accounting.pricingCoverage?.unpricedEvents, 0);
  const evidenceStartDate = /^\d{4}-\d{2}-\d{2}$/u.test(
    accounting.evidenceStartDate ?? "",
  ) ? accounting.evidenceStartDate : null;
  const periodDays = { "24h": 1, "7d": 7, "30d": 30 }[accounting.periodId] ?? null;
  const selectedPeriodCanPrecedeEvidence = evidenceStartDate !== null
    && (accounting.periodId === "all"
      || accounting.periodId === "history"
      || (periodDays !== null
        && Date.now() - periodDays * 24 * 60 * 60 * 1000
          < Date.parse(`${evidenceStartDate}T00:00:00.000Z`)));
  const historyCoverage = accounting.historyCoverage;
  const historicalCoverageWarning = accounting.periodId === "30d"
    && (selectedPeriodCanPrecedeEvidence || historyCoverage?.status === "partial");
  const historicalCoverageDate = evidenceStartDate
    ?? historyCoverage?.coveredAt?.startAt
    ?? "";
  const coveragePercent = accounting.events === 0
    ? null
    : pricedEvents / accounting.events * 100;
  const coverageDigits = 1;
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
    ],
    [
      "Price coverage",
      "The share of usage changes with a reviewed public API price. The provenance note below explains any historical coverage boundary.",
      coveragePercent === null
        ? "—"
        : formatPercent(coveragePercent, coverageDigits),
      historicalCoverageWarning
        ? t("accounting.pricing.thirtyDayCoverageWarning", {
          date: historicalCoverageDate
            ? ` on ${formatLocal(historicalCoverageDate, { dateOnly: true })}`
            : t("format.unknown"),
        })
        : unpricedEvents > 0
          ? t("accounting.pricing.partialCoverage", {
            percent: formatPercent(coveragePercent, coverageDigits),
          })
          : t("accounting.pricing.coverageReviewed")
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

  const models = $("#accounting-models");
  clear(models);
  const modelRows = [...(accounting.byModel ?? [])]
    .sort((left, right) => right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd);
  if (!modelRows.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No model accounting in this period.");
    cell.colSpan = 4;
    row.append(cell);
    models.append(row);
  } else {
    for (const model of modelRows) {
      const row = node("tr");
      const modelLabel = model.model === "unknown"
        ? "Unrecognized model"
        : model.model;
      row.append(
        node("td", "", modelLabel),
        node("td", "", compact(model.events)),
        node("td", "", compact(model.totalTokens)),
        node(
          "td",
          "",
          finite(model.apiPriceEquivalentUsd, 0) === 0
            ? "—"
            : formatApiMoney(model.apiPriceEquivalentUsd)
        )
      );
      models.append(row);
    }
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
  updateContributionSyncButtons();
}

function renderContributionSyncPreview(preview) {
  const value = preview ?? {
    status: "unavailable",
    state: "unavailable",
    item: null
  };
  contributionSyncPreview = value;
  if (!$("#sync-next-state")) {
    updateContributionSyncButtons();
    return;
  }
  const labels = {
    ready: "Ready",
    retry_wait: "Waiting to retry",
    paused: "Paused",
    empty: "Nothing queued",
    not_configured: "Not configured",
    unavailable: "Unavailable"
  };
  const chip = $("#sync-next-state");
  const state = value.status === "available"
    ? value.state
    : value.status;
  chip.textContent = labels[state] ?? "Unavailable";
  chip.className = state === "ready"
    ? "evidence-chip"
    : "evidence-chip neutral";
  if (!value.item) {
    $("#sync-next-coverage").textContent = value.status === "not_configured"
      ? "Set prepared directory at launch"
      : "—";
    $("#sync-next-records").textContent = "—";
    $("#sync-next-cost").textContent = "—";
    $("#sync-next-bytes").textContent = "—";
    updateContributionSyncButtons();
    return;
  }
  const item = value.item;
  $("#sync-next-coverage").textContent =
    `${formatLocal(item.coveredAt.startAt)} – ${formatLocal(item.coveredAt.endAt)}`;
  $("#sync-next-records").textContent =
    `${compact(item.recordCounts.total)} total · ${compact(item.recordCounts.usageEvents)} usage · ${compact(item.recordCounts.quotaSnapshots)} quota`;
 $("#sync-next-cost").textContent =
    `${item.accounting.estimatedApiCostUsd === null ? "No estimate" : formatApiMoney(Number(item.accounting.estimatedApiCostUsd))} · ${t("accounting.pricing.coverageShort", {
      percent: formatPercent(item.accounting.pricedEventCoveragePercent, 1),
    })}`;
  $("#sync-next-bytes").textContent =
    `${compact(item.reservedUploadBytes)} bytes reserved (${compact(item.preparedBytes)} prepared)`;
  updateContributionSyncButtons();
}

function updateContributionSyncButtons() {
  const available = contributionSyncPreview?.status === "available";
  const paused = contributionSyncStatus?.paused === true;
  const inspect = $("#sync-inspect");
  const send = $("#sync-run-once");
  if (!inspect || !send) return;
  inspect.disabled = contributionSyncBusy;
  send.disabled = contributionSyncBusy
    || !available
    || contributionSyncPreview?.deliveryConfigured !== true
    || contributionSyncPreview?.state !== "ready"
    || contributionSyncExactReview?.state !== "ready"
    || paused;
}

function showContributionSyncAction(message, error = false) {
  const status = $("#sync-action-status");
  if (!status) return;
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("error", error);
}

function contributionSyncPassResult(result) {
  const needsAttention = result.status === "completed"
    && result.accepted === 0
    && result.retryable + result.rejected > 0;
  const counts =
    `${compact(result.accepted)} accepted, ${compact(result.retryable)} waiting to retry, ${compact(result.rejected)} rejected`;
  const bandwidth =
    `${compact(result.reservedUploadBytes)} upload bytes reserved${result.bandwidthLimited ? "; stopped at byte cap" : ""}`;
  const guidance = needsAttention
    ? " Nothing was accepted. Check device pairing before trying again; this Mac may need to be paired as an upload-only device. These bounded counters do not identify the exact server-side reason."
    : "";
  return {
    message:
      `Pass ${result.status}: ${compact(result.processed)} processed; ${counts}; ${bandwidth}.${guidance}`,
    needsAttention
  };
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

async function runContributionSyncAction(action) {
  if (action !== "run") return;
  if (contributionSyncBusy) return;
  contributionSyncBusy = true;
  let acceptedContribution = false;
  updateContributionSyncButtons();
  showContributionSyncAction("Running one bounded foreground pass…");
  try {
    if (action === "run") {
      if (contributionSyncExactReview?.state !== "ready") {
        throw new Error("exact review required");
      }
      const result = await localClient.runContributionSyncOnce(
        contributionSyncExactReview.reviewToken
      );
      if (result.status === "unavailable") throw new Error("sync unavailable");
      const outcome = contributionSyncPassResult(result);
      acceptedContribution = result.status === "completed"
        && Number.isSafeInteger(result.accepted)
        && result.accepted > 0;
      showContributionSyncAction(outcome.message, outcome.needsAttention);
    }
    await refreshContributionSyncControls();
    if (acceptedContribution) await loadCommunityResults();
  } catch (error) {
    if (contributionDeviceRecoveryIsRequired(error)) {
      await renderContributionDeviceRecovery($("#community-connect-status"), {
        error
      });
      showContributionSyncAction(
        "Delivery stopped because this Mac has a leftover device credential. Durable queue state was retained; the repair is offered above.",
        true
      );
    } else {
      showContributionSyncAction((await describeFailure({
        surface: "contribution_send",
        error,
        fallback:
          "The local companion rejected or could not complete this action. Durable queue state was retained."
      })).text, true);
    }
  } finally {
    contributionSyncBusy = false;
    updateContributionSyncButtons();
  }
}

async function inspectNextContribution() {
  contributionSyncBusy = true;
  $("#community-contribution-disclosure")?.setAttribute("open", "");
  updateContributionSyncButtons();
  showContributionSyncAction(
    "Inspecting content-free pseudonymous metadata through loopback; no service request or upload is performed."
  );
  try {
    await refreshContributionSyncControls();
    const review = await localClient.contributionSyncExactReview();
    renderContributionSyncExactReview(review);
    showContributionSyncAction(
      "Review the concise coverage and record totals above, then confirm the send."
    );
  } catch {
    showContributionSyncAction(
      "The next contribution could not be inspected. Nothing was uploaded.",
      true
    );
  } finally {
    contributionSyncBusy = false;
    updateContributionSyncButtons();
  }
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
    renderPreparationIdentity(localHealth);
    renderContributionSyncStatus(sync.status);
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
    renderContributionSyncPreview(null);
    renderPreparationIdentity(null);
    renderLocalOnboarding(onboarding);
    renderDashboardUnavailableState(
      localHealth ? "dashboard-unavailable" : "companion-unavailable",
    );
  } finally {
    localActionBusy = previousBusy;
    updateLocalActionButtons();
  }
}

function renderPreparationIdentity(health) {
  const chip = $("#preparation-identity");
  if (!chip) return;
  const mode = health?.capabilities?.contributionPreparationIdentityMode;
  const labels = {
    production_keychain: "Keychain checked on prepare",
    development_file_override: "Development file ready",
    development_environment_override: "Development environment override",
  };
  chip.textContent = labels[mode] ?? "Unavailable";
  chip.className = mode === "development_file_override"
    ? "evidence-chip"
    : "evidence-chip neutral";
}

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

async function requestRefresh() {
  if (localActionBusy) return;
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
    if (outcome !== "succeeded") throw new Error("The local refresh did not complete successfully.");
    archiveHistoryScanActive = false;
    button.textContent = "Loading updated evidence…";
    await loadLocalDashboard();
  } catch {
    if (dashboard) {
      setGlobalState(dashboard.state, {
        companionReachable: dashboard.mode !== "demo",
      });
    }
    showConnectionNotice({
      title: continuationLimitReached
        ? "Deep analysis paused after two bounded continuations"
        : refreshAccepted
          ? "The local analysis did not finish"
        : "Local analysis could not be started",
      copy: continuationLimitReached
        ? "TiboTattle stopped this one-click analysis rather than repeatedly reading a very large history. Your available headline and previously verified results remain usable; you can run the analysis again later from its durable checkpoint."
        : refreshAccepted
          ? "The analysis was accepted, but it did not reach a verified completion state. Existing evidence is still available and no partial accounting result replaced it."
        : "The local companion may be offline, busy, or rejecting this request. Existing evidence has not been altered.",
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

function scheduleReturningUserRefresh() {
  // The native macOS shell owns the foreground cadence. Running both the web
  // return-visit timer and the native timer races the same bounded companion
  // request, which can surface a harmless 409 as a confusing dashboard error.
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
    "The contribution service did not recognize this browser session. Reload the local dashboard, then try again. Nothing was uploaded.",
  AUTH_INVALID:
    "The contribution service rejected this browser session. Reload the local dashboard, then try again. Nothing was uploaded.",
  CSRF_INVALID:
    "This browser session expired while the request was in flight. Reload the local dashboard, then try again. Nothing was uploaded.",
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
    "The contribution service failed while handling this request. Nothing was uploaded; try again shortly."
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
    "The local companion refused this request because it did not arrive from the local dashboard. Nothing was stored."
};

/**
 * Turn one failure into honest copy plus a quotable reference.
 *
 * The reference is fresh WebCrypto randomness, never derived from anything the
 * user typed or the service returned. The page waits for the local diagnostics
 * POST and claims the write only after the companion confirms it; when that
 * confirmation fails, the reference remains visible without the write claim.
 * The sentence itself always comes from a map written here or from the caller's
 * fallback; no server string is ever rendered.
 */
async function describeFailure({ surface, error, messages = {}, fallback }) {
  const reference = createDiagnosticReference();
  const code = diagnosticErrorCode(error?.code);
  const requestId = serviceRequestId(error?.requestId);
  let writtenToLocalLog = false;
  try {
    const recorded = await localClient.recordDiagnosticNote({
      reference,
      surface: diagnosticSurface(surface),
      code,
      requestId
    });
    writtenToLocalLog = recorded?.status === "recorded"
      && recorded.reference === reference;
  } catch {
    // The reference remains useful even when the local companion cannot write
    // its diagnostics log. Do not claim a write that was not confirmed.
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
  // A server-authenticated existing participant may still pair an already
  // authorised Mac while new enrollment is contained. Do not make a session
  // holder repeat a social login merely because new enrollment is paused.
  if (hasCommunitySession()) return false;
  return communityServiceHealth?.collectionControls?.enrollment === false
    || communityServiceHealth?.enrollmentMode === "disabled";
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
  googleUnavailable.textContent = enrollmentPaused
    ? t("contribution.enrollmentPaused")
    : serviceConfigured
      ? "Hosted sign-in is not configured for this build."
      : "This build has no contribution service, so hosted sign-in is unavailable.";
  const appleUnavailableNow = appleSignInUnavailable
    || !serviceConfigured
    || enrollmentPaused;
  // When enrollment is paused, use one shared sentence instead of displaying
  // the same global status below both provider buttons.
  appleUnavailable.hidden = !appleUnavailableNow || signedIn || enrollmentPaused;
  appleUnavailable.textContent = serviceConfigured
    ? "Hosted Apple sign-in is not configured for this build."
    : "This build has no contribution service, so hosted sign-in is unavailable.";
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
      ? "Signing out ends this browser's contribution session."
      : "This browser already has a contribution session. Signing out ends it.",
  );
  chip.textContent = signedIn
    ? "Signed in"
    : hostedIdentityBusy ? "Signing in…" : "Not signed in";
  chip.className = signedIn
    ? "evidence-chip"
    : "evidence-chip neutral";
  updateCommunityConnectButton();
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
  status.textContent = hadServerSession
    ? t("contribution.signOutStarting")
    : t("contribution.signOutForgetting");
  try {
    if (hadServerSession) await communityClient.logout();
    hostedIdentity = null;
    setCommunitySession(null);
    $("#participant-controls")?.setAttribute("hidden", "");
    status.textContent = hadServerSession
      ? t("contribution.signOutCompleted")
      : t("contribution.signOutUnfinished");
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
  attempt.wake?.();
  const status = $("#identity-signin-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = t("contribution.signInCancelled", {
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
    result: (state) => communityClient.identityGoogleResult(state),
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
    result: (state) => communityClient.identityAppleResult(state),
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

async function beginHostedSignIn(providerId) {
  const flow = HOSTED_SIGNIN_FLOWS[providerId];
  if (flow === undefined || hostedIdentityBusy || hostedIdentity !== null) {
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
  status.textContent = t("contribution.signInStarting", {
    provider: flow.label,
  });
  try {
    const request = await flow.start();
    openHostedSignInInBrowser(request.authorizeUrl);
    status.textContent = flow.waiting;
    for (let poll = 0; poll < HOSTED_SIGNIN_POLL_ATTEMPTS; poll += 1) {
      if (attempt.cancelled || activeHostedSignIn !== attempt) return;
      let identity = null;
      try {
        identity = await flow.result(request.state);
      } catch (error) {
        if (error?.code !== "IDENTITY_RESULT_PENDING") throw error;
        // The fixed callback page wakes the native dashboard only after the
        // provider has returned. A current service turns a cancelled callback
        // into IDENTITY_TOKEN_INVALID; this branch preserves the same safe UI
        // outcome while a previously deployed service still reports pending.
        if (attempt.returnedToApp) {
          status.hidden = false;
          status.className = "participant-action-status";
          status.textContent = t("contribution.signInIncomplete", {
            provider: flow.label,
          });
          return;
        }
      }
      if (identity !== null) {
        if (attempt.cancelled || activeHostedSignIn !== attempt) return;
        hostedIdentity = identity;
        activeHostedSignIn = null;
        hostedIdentityBusy = false;
        status.textContent = flow.signedIn;
        renderHostedIdentity();
        foregroundNativeDashboardAfterSignIn();
        return;
      }
      if (poll + 1 < HOSTED_SIGNIN_POLL_ATTEMPTS) {
        await waitForHostedSignInPoll(attempt);
      }
    }
    // A bounded poll that ran out is still a failed action from the user's
    // side, so it is referenced and logged like any other.
    await showFailure(status, {
      surface: "hosted_identity",
      error: null,
      fallback: flow.timedOut,
    });
  } catch (error) {
    if (attempt.cancelled || activeHostedSignIn !== attempt) return;
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

function updateCommunityConnectButton() {
  const button = $("#connect-community");
  const consent = $("#community-connect-consent");
  const enrollmentPaused = hostedEnrollmentIsPaused();
  consent.disabled = false;
  button.disabled = communityConnectBusy
    || enrollmentPaused
    || hostedSignInRequired()
    || !consent.checked;
  if (!communityConnectBusy) {
    button.textContent = enrollmentPaused
      ? t("contribution.enrollmentPausedButton")
      : hostedSignInRequired()
        ? "Sign in above to contribute"
        : "Review contribution";
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
      "Resetting clears only that unusable credential and its local record. Then connect this Mac again."
    ),
    actions
  );
  return described;
}

const DEVICE_CREDENTIAL_RESET_CONFIRMATION =
  "Clear this Mac's unusable contribution-device credential?\n\nThis clears only the leftover credential in this Mac's Keychain and its local record. Local reporting is unchanged.";

async function resetContributionDeviceCredential() {
  if (communityConnectBusy) return;
  if (!window.confirm(DEVICE_CREDENTIAL_RESET_CONFIRMATION)) return;
  const status = $("#community-connect-status");
  communityConnectBusy = true;
  updateCommunityConnectButton();
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Clearing the unusable local device credential…";
  try {
    const result = await localClient.resetContributionDeviceCredential();
    if (result.status === "unavailable") {
      throw new Error("The local companion did not confirm the reset.");
    }
    status.textContent = result.status === "already_absent"
      ? "No leftover device credential was present. Choose Contribute to connect this Mac."
      : "The leftover device credential was cleared. Choose Contribute to connect this Mac again.";
  } catch (error) {
    await showFailure(status, {
      surface: "device_credential_reset",
      error,
      fallback:
        "The leftover device credential could not be cleared. Nothing was deleted on this Mac or in the service."
    });
  } finally {
    communityConnectBusy = false;
    updateCommunityConnectButton();
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
  status.textContent =
    `This Mac is connected through ${formatLocal(paired.expiresAt)}. Nothing was uploaded.`;
  return paired;
}

function openContributionReview() {
  const disclosure = $("#community-contribution-disclosure");
  if (disclosure) disclosure.open = true;
  const review = $("#contribution-review");
  review?.scrollIntoView?.({ block: "start", behavior: "instant" });
  const heading = review?.querySelector?.("h3");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus?.({ preventScroll: true });
  }
}

async function connectCommunityContribution() {
  if (communityConnectBusy) return;
  const status = $("#community-connect-status");
  if (hostedEnrollmentIsPaused()) {
    status.hidden = false;
    status.className = "participant-action-status error";
    status.textContent = t("contribution.enrollmentPausedNoUpload");
    return;
  }
  if (hostedSignInRequired()) {
    status.hidden = false;
    status.className = "participant-action-status error";
    status.textContent =
      "Sign in first: hosted participation requires Google or Apple sign-in above. Local-only use needs no account, and nothing was uploaded.";
    return;
  }
  let pairing = null;
  // A hosted proof is intentionally one-use. If enrollment itself fails, do
  // not leave the page claiming that the same proof can safely be retried:
  // drop it from this memory-only page and make the next action a fresh
  // browser sign-in. Failures after a session is established are different —
  // the user can retry those local pairing steps without authenticating again.
  let enrollmentAttemptedWithHostedIdentity = false;
  let enrollmentEstablished = false;
  communityConnectBusy = true;
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent =
    "Creating pseudonymous contribution access and connecting this Mac…";
  $("#connect-community").textContent = "Connecting contribution…";
  updateCommunityConnectButton();
  try {
    if (localCompanionHealth?.capabilities?.contributionDevicePairing !== true) {
      throw new Error(
        "The local app is not connected to a configured contribution service."
      );
    }
    if (communitySession?.csrfToken) {
      pairing = await communityClient.createDevicePairing(false);
      await finishCommunityDevicePairing(pairing, status);
    } else {
      // This page never collects or sends an invitation code. The Worker is
      // the authority on whether its current enrollment mode admits this
      // hosted proof; a paused service fails before the browser OAuth start.
      enrollmentAttemptedWithHostedIdentity = hostedIdentity !== null;
      const enrollment = await communityClient.enroll(
        null,
        "telemetry-contribution-v0.1",
        { deviceBootstrap: true, identity: hostedIdentity }
      );
      if (enrollment?.schemaVersion !== "participant-bootstrap-v0.1"
          || enrollment?.state !== "pairing_ready"
          || typeof enrollment?.csrfToken !== "string"
          || typeof enrollment?.pairing?.pairingCode !== "string") {
        throw new Error(
          "The contribution service did not establish paired pseudonymous access."
        );
      }
      setCommunitySession({
        csrfToken: enrollment.csrfToken,
        participantId: enrollment.participantId ?? null,
        consentVersion: "privacy-safe-telemetry-v0.1"
      });
      enrollmentEstablished = true;
      pairing = enrollment.pairing;
      await finishCommunityDevicePairing(pairing, status);
    }
    $("#community-connect-consent").checked = false;
    openContributionReview();
    await Promise.all([
      refreshContributionSyncControls(),
      loadCommunityResults(),
    ]);
    status.textContent =
      "Connected. Review the content-free result below before deciding whether to send it. Nothing will repeat automatically.";
    await prepareLocalContribution();
    if (contributionSyncPreview?.state === "ready") {
      await inspectNextContribution();
    }
  } catch (error) {
    if (contributionDeviceRecoveryIsRequired(error)) {
      await renderContributionDeviceRecovery(status, { error });
    } else {
      const retryNeedsFreshSignIn = enrollmentAttemptedWithHostedIdentity
        && !enrollmentEstablished
        && hostedIdentity !== null;
      if (retryNeedsFreshSignIn) {
        hostedIdentity = null;
        renderHostedIdentity();
      }
      const described = await showFailure(status, {
        surface: "contribution_connect",
        error,
        fallback:
          "This Mac could not be connected, and no evidence was uploaded. The cause was not reported in a form this page can explain; retrying is safe."
      });
      if (retryNeedsFreshSignIn) {
        status.textContent = t("contribution.signInDiscarded", {
          message: described.text,
        });
      }
    }
  } finally {
    pairing = null;
    communityConnectBusy = false;
    updateCommunityConnectButton();
  }
}

function contributionPreparationEstimate(
  data = dashboard,
  lookbackHours = activeContributionLookbackHours,
  admission = participantContributionAdmission,
) {
  if (!data || data.mode === "demo") return null;
  const referenceMs = Date.parse(data.freshness?.latestObservedAt);
  const endMs = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const startMs = endMs - lookbackHours * 60 * 60 * 1_000;
  const usageEvents = (data.timeline?.usage ?? []).reduce((total, row) => {
    const rowEnd = Date.parse(row.endAt);
    return Number.isFinite(rowEnd) && rowEnd >= startMs && rowEnd <= endMs
      ? total + Math.max(0, Math.floor(finite(row.usageEvents, 0)))
      : total;
  }, 0);
  const quotaSnapshots = (data.timeline?.quota ?? []).filter((row) => {
    const observed = Date.parse(row.observedAt);
    return Number.isFinite(observed) && observed >= startMs && observed <= endMs;
  }).length;
  const records = usageEvents + quotaSnapshots;
  const batches = records > 0 ? Math.ceil(records / 200) : 0;
  const batchAdmission = contributionBatchAdmission({
    estimatedBatches: batches,
    participantAdmission: admission,
  });
  return {
    usageEvents,
    quotaSnapshots,
    records,
    batches,
    maximumSerializedBytes: batches * 1_310_720,
    localReviewLimit: batchAdmission.localReviewLimit,
    admissionKnown: batchAdmission.admissionKnown,
    remainingBatches: batchAdmission.remainingBatches,
    maximumBatches: batchAdmission.maximumBatches,
    renewsAt: batchAdmission.renewsAt,
    effectiveBatchLimit: batchAdmission.effectiveBatchLimit,
    exceedsLocalReviewLimit: batchAdmission.exceedsLocalReviewLimit,
    exceedsParticipantAdmission:
      batchAdmission.exceedsParticipantAdmission,
    tooLarge: batchAdmission.blocked,
    partial: ![
      "recent_7d_complete",
      "recent_7d_partial",
      "prospective_only",
    ].includes(data.collector?.indexing?.status),
  };
}

function renderContributionPreparationEstimate() {
  const element = $("#preparation-estimate");
  const button = $("#prepare-contribution");
  const estimate = contributionPreparationEstimate();
  if (!element || !button) return null;
  if (!estimate) {
    element.textContent =
      "Analyze local usage to estimate privacy-safe records and upload batches before preparation.";
    if (!contributionPreparationBusy) button.disabled = false;
    return null;
  }
  if (estimate.records === 0) {
    element.textContent =
      "No privacy-safe records are visible in this indexed interval. Choose another window or update local usage first.";
  } else {
    const coverage = estimate.partial
      ? " The local index is partial, so the exact count may be higher."
      : "";
    const renews = estimate.renewsAt
      ? ` The participant allowance renews ${formatLocal(estimate.renewsAt)}.`
      : "";
    if (estimate.exceedsParticipantAdmission) {
      element.textContent = estimate.remainingBatches === 0
        ? `This participant has no community batch allowance remaining.${renews} Wait for renewal before preparing another reviewed set. No local preparation or upload has started.`
        : `Preflight estimates ${compact(estimate.batches)} batches, above this participant’s ${compact(estimate.remainingBatches)} remaining community batch${estimate.remainingBatches === 1 ? "" : "es"}.${renews} Choose a shorter window or wait for renewal before preparing.${coverage}`;
    } else if (estimate.exceedsLocalReviewLimit) {
      element.textContent =
        `Preflight estimates ${compact(estimate.records)} records across ${compact(estimate.batches)} batches, above the local ${compact(estimate.localReviewLimit)}-batch reviewed-set safety cap. Choose a shorter window before preparing.${coverage}`;
    } else {
      const admission = estimate.admissionKnown
        ? ` This participant has ${compact(estimate.remainingBatches)} of ${compact(estimate.maximumBatches)} community batches remaining${estimate.renewsAt ? ` until ${formatLocal(estimate.renewsAt)}` : ""}.`
        : " Community batch allowance is unknown until this Mac is connected; the service checks it again before accepting any upload.";
      element.textContent =
        `Preflight estimates ${compact(estimate.records)} records across about ${compact(estimate.batches)} batch${estimate.batches === 1 ? "" : "es"} (${compact(estimate.maximumSerializedBytes)} bytes worst-case). Exact counts and bytes are independently verified before queueing; no wall-clock ETA is inferred from record count.${admission}${coverage}`;
    }
  }
  if (!contributionPreparationBusy) {
    button.disabled = estimate.records === 0 || estimate.tooLarge;
  }
  return estimate;
}

async function prepareLocalContribution() {
  if (contributionPreparationBusy) return;
  const estimate = renderContributionPreparationEstimate();
  if (estimate?.tooLarge) {
    const status = $("#prepare-contribution-status");
    status.classList.add("error");
    status.textContent = estimate.exceedsParticipantAdmission
      ? `This interval is estimated to exceed the participant’s remaining community allowance${estimate.renewsAt ? `, which renews ${formatLocal(estimate.renewsAt)}` : ""}. Choose a shorter window or wait for renewal. No preparation or upload started.`
      : "This interval is estimated to exceed the local 100-batch reviewed-set safety cap. Choose a shorter window. No preparation or upload started.";
    return;
  }
  contributionPreparationBusy = true;
  const button = $("#prepare-contribution");
  const status = $("#prepare-contribution-status");
  button.disabled = true;
  button.textContent = "Preparing locally…";
  status.classList.remove("error");
  const lookbackLabel = activeContributionLookbackHours === 1
    ? "latest hour"
    : activeContributionLookbackHours === 24
      ? "last 24 hours"
      : "last seven days";
  status.textContent =
    `Building and independently verifying content-free evidence from the ${lookbackLabel}. No network upload is performed.`;
  clearContributionSyncExactReview();
  try {
    const result = await localClient.prepareContribution({
      lookbackHours: activeContributionLookbackHours,
    });
    if (result.status !== "prepared") {
      throw new Error("Preparation did not return a verified contribution.");
    }
    const records = result.recordCounts.usageEvents
      + result.recordCounts.quotaSnapshots
      + result.recordCounts.activityMarkers;
    const coveredLabel = result.coveredAt?.startAt && result.coveredAt?.endAt
      ? ` covering ${formatLocal(result.coveredAt.startAt)} through ${formatLocal(result.coveredAt.endAt)}`
      : "";
    status.textContent =
      `Prepared ${compact(result.prepared.batchCount)} verified batch${result.prepared.batchCount === 1 ? "" : "es"} with ${compact(records)} safe records (${compact(result.prepared.bytes)} bytes)${coveredLabel}. Nothing was uploaded.`;
    await refreshContributionSyncControls();
  } catch (error) {
    status.classList.add("error");
    const preparationMessages = {
      identity_unavailable:
        "The local Keychain identity is unavailable. Open Keychain Access, select the login Keychain, unlock it, then retry. Do not reset, delete, rotate, or broaden access to the identity. No upload occurred.",
      coverage_unavailable:
        "No usable local coverage is available yet. Analyze local usage first. No upload occurred.",
      coverage_invalid:
        "The selected local coverage interval is not usable for a contribution. No upload occurred.",
      no_safe_records:
        "No privacy-safe records were found in the selected interval. No upload occurred.",
      export_too_large:
        activeContributionLookbackHours > 24
          ? "Seven days exceeded the current single reviewed-set safety cap. Try 24 hours; on a very active history, use 1 hour. Nothing was truncated or uploaded."
          : activeContributionLookbackHours === 24
            ? "This high-activity 24-hour interval exceeded the current single reviewed-set safety cap. Choose 1 hour. Nothing was truncated or uploaded; longer dense intervals need the planned locally aggregated export format."
            : "The latest hour exceeded a fixed reviewed-set safety bound. Nothing was truncated or uploaded.",
      privacy_verification_failed:
        "Privacy verification rejected the prepared data, so it was not queued or uploaded.",
      preparation_in_progress:
        "A local preparation is already running. Nothing has been uploaded.",
      review_archive_invalid:
        "The local review archive could not be written, so nothing was queued. No upload occurred.",
      prepared_spool_invalid:
        "The local prepared-contribution spool is not in a usable state, so nothing was queued. No upload occurred.",
      preparation_failed:
        "A privacy-verified contribution could not be prepared. No upload occurred and incomplete staging is ignored by the queue."
    };
    status.textContent = (await describeFailure({
      surface: "contribution_prepare",
      error,
      messages: preparationMessages,
      fallback:
        "A privacy-verified contribution could not be prepared. No upload occurred and incomplete staging is ignored by the queue."
    })).text;
  } finally {
    contributionPreparationBusy = false;
    button.disabled = false;
    button.textContent = activeContributionLookbackHours === 1
      ? "Prepare and review latest hour"
      : activeContributionLookbackHours === 24
        ? "Prepare and review last 24 hours"
        : "Prepare and review last 7 days";
    renderContributionPreparationEstimate();
  }
}

async function loadCommunityResults() {
  const centralConfigured = localCompanionHealth === null
    || localCompanionHealth?.capabilities?.centralServiceProxy === true;
  if (!centralConfigured) {
    participantContributionAdmission = null;
    communityServiceHealth = null;
    renderHostedIdentity();
    renderContributionPreparationEstimate();
    return;
  }
  try {
    const [healthResult, profileResult] = await Promise.allSettled([
      communityClient.health(),
      communitySession?.csrfToken
        ? communityClient.participantProfile()
        : Promise.resolve(null),
    ]);
    communityServiceHealth = healthResult.status === "fulfilled"
      ? healthResult.value
      : null;
    renderHostedIdentity();
    const normalizedProfile = normalizeParticipantHistory(
      profileResult.status === "fulfilled" ? profileResult.value : null,
    );
    participantContributionAdmission = normalizedProfile.state === "ready"
      ? normalizedProfile.contributionAdmission
      : null;
    renderContributionPreparationEstimate();
  } catch {
    participantContributionAdmission = null;
    communityServiceHealth = null;
    renderHostedIdentity();
    renderContributionPreparationEstimate();
  }
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
$("#contribution-lookback-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lookback-hours]");
  if (!button || contributionPreparationBusy) return;
  activeContributionLookbackHours = Number(button.dataset.lookbackHours);
  for (const control of $("#contribution-lookback-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  $("#prepare-contribution").textContent = activeContributionLookbackHours === 1
    ? "Prepare and review latest hour"
    : activeContributionLookbackHours === 24
      ? "Prepare and review last 24 hours"
      : "Prepare and review last 7 days";
  renderContributionPreparationEstimate();
});
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
$("#community-connect-consent").addEventListener(
  "change",
  updateCommunityConnectButton
);
$("#connect-community").addEventListener(
  "click",
  connectCommunityContribution
);
$("#contribution-not-now").addEventListener("click", () => {
  $("#community-connect-consent").checked = false;
  updateCommunityConnectButton();
  const status = $("#community-connect-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent =
    "Nothing will be contributed. Your local reporting continues unchanged.";
});
$("#prepare-contribution").addEventListener("click", prepareLocalContribution);
$("#demo-button").addEventListener("click", () => renderDashboard(demoDashboard()));
$("#sync-inspect").addEventListener("click", inspectNextContribution);
$("#sync-run-once").addEventListener("click", () => runContributionSyncAction("run"));
$("#window-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-hours]");
  if (!button || !dashboard) return;
  activeWindowHours = Number(button.dataset.hours);
  for (const control of $("#window-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetTimelineViewport();
  renderTimeline(dashboard);
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
  renderUsageTimeline(dashboard);
  renderComparison(dashboard);
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
$("#usage-group-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (!button || !dashboard || !usageGroupingsForRange().includes(button.dataset.group)) return;
  activeUsageGrouping = button.dataset.group;
  for (const control of $("#usage-group-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
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
  scheduleReturningUserRefresh();
}

bootstrapDashboard();
