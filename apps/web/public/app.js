import {
  CommunityClient,
  LocalCompanionClient,
  demoDashboard,
  normalizeCommunitySnapshot,
  normalizeParticipantHistory,
  normalizeParticipantStats
} from "./data-client.js";
import {
  GOOGLE_OAUTH_RESULT_STORAGE_KEY,
  contributionBatchAdmission,
  createDiagnosticReference,
  createGoogleSignInRequest,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  createTelemetryEnvelope,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  parseGoogleSignInResult,
  parseJsonWithUniqueObjectKeys,
  refreshNeedsContinuation,
  runReviewedContributionGate,
  safeApiError,
  serviceRequestId,
  validateContributionForUpload
} from "./lib.js";
import {
  mountDashboardNavigation,
} from "./navigation.js";

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
// The observed percentage-point span a reset-series fit must exceed before it
// counts as headline evidence. It is a visible, adjustable control, not a
// hidden constant: the reader can see and move the bar the numbers clear.
const DEFAULT_WEEKLY_SPAN_THRESHOLD_PP = 50;
let weeklySpanThresholdPp = DEFAULT_WEEKLY_SPAN_THRESHOLD_PP;
let showWeeklyPartialDiagnostics = false;
let timelineViewport = null;
let timelinePointerStart = null;
let localCompanionHealth = null;
let contributionSyncStatus = null;
let contributionSyncPreview = null;
let contributionSyncExactReview = null;
let contributionSyncBusy = false;
let automaticContributionStatus = null;
let automaticContributionBusy = false;
let fastModePreference = null;
let fastModePreferenceBusy = false;
let pendingAutomaticContributionConsent = null;
let participantContributionAdmission = null;
let localOnboarding = null;
let selectedContributionValidated = false;
let contributionSelectionRevision = 0;
let contributionPreparationBusy = false;
let communityConnectBusy = false;
// The verified sign-in token lives only in this module-scoped memory; it is
// never persisted to storage and disappears with the tab.
let hostedIdentity = null;
let hostedIdentityBusy = false;
let pendingGoogleSignIn = null;
// Only the contribution service knows whether hosted Apple sign-in is
// configured, so this stays false until a start attempt says otherwise.
let appleSignInUnavailable = false;
let activeContributionLookbackHours = 24;
let localActionBusy = false;
let localRefreshInProgress = false;
let localRefreshCancelRequested = false;
let returnRefreshScheduled = false;
let returnRefreshDeferrals = 0;
const USER_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
const USER_TIME_ZONE_OPTION = USER_TIME_ZONE === "local time"
  ? {}
  : { timeZone: USER_TIME_ZONE };
const LOCAL_CALENDAR_PARTS = new Intl.DateTimeFormat("en-US", {
  ...USER_TIME_ZONE_OPTION,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const $ = (selector) => document.querySelector(selector);

function configuredSemanticOpenTarget() {
  const target = document
    .querySelector('meta[name="usage-monitor-semantic-open-target"]')
    ?.getAttribute("content")
    ?.trim();
  return target && /^[a-z][a-z0-9+.-]*:\/\/open$/iu.test(target)
    ? target
    : null;
}

const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget();
const installedAppLink = $("#open-installed-app");
if (SEMANTIC_OPEN_TARGET) {
  installedAppLink.href = SEMANTIC_OPEN_TARGET;
} else {
  installedAppLink.removeAttribute("href");
  installedAppLink.setAttribute("aria-disabled", "true");
}

function configuredInstallerUrl() {
  const raw = document
    .querySelector('meta[name="usage-monitor-installer-url"]')
    ?.getAttribute("content")
    ?.trim();
  if (!raw) return null;
  try {
    const selected = new URL(raw);
    return selected.protocol === "https:"
      && !selected.username
      && !selected.password
      && !selected.port
      && !selected.search
      && !selected.hash
      && selected.pathname.toLowerCase().endsWith(".dmg")
      ? selected.href
      : null;
  } catch {
    return null;
  }
}

function configuredInstallerMetadata(name, pattern) {
  const value = document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  return value && pattern.test(value) ? value : null;
}

function configuredGoogleClientId() {
  const value = document
    .querySelector('meta[name="usage-monitor-google-client-id"]')
    ?.getAttribute("content")
    ?.trim();
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]{7,255}$/u.test(value)
    ? value
    : null;
}

function configuredReleaseUrl(name) {
  const raw = document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  if (!raw) return null;
  try {
    const selected = new URL(raw);
    return selected.protocol === "https:"
      && !selected.username
      && !selected.password
      && !selected.port
      && !selected.search
      && !selected.hash
      ? selected.href
      : null;
  } catch {
    return null;
  }
}

function configuredInstallerRelease() {
  const installerUrl = configuredInstallerUrl();
  const version = configuredInstallerMetadata(
    "usage-monitor-installer-version",
    /^[0-9]+(?:\.[0-9]+){2,3}$/u,
  );
  const sha256 = configuredInstallerMetadata(
    "usage-monitor-installer-sha256",
    /^[a-f0-9]{64}$/u,
  );
  const byteText = configuredInstallerMetadata(
    "usage-monitor-installer-bytes",
    /^[1-9][0-9]{0,15}$/u,
  );
  const minimumMacos = configuredInstallerMetadata(
    "usage-monitor-minimum-macos",
    /^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u,
  );
  const architectureText = configuredInstallerMetadata(
    "usage-monitor-architectures",
    /^(?:arm64|x86_64)(?:,(?:arm64|x86_64))?$/u,
  );
  const architectures = architectureText?.split(",") ?? [];
  const links = {
    releaseNotes: configuredReleaseUrl("usage-monitor-release-notes-url"),
    privacy: configuredReleaseUrl("usage-monitor-privacy-url"),
    security: configuredReleaseUrl("usage-monitor-security-url"),
    support: configuredReleaseUrl("usage-monitor-support-url"),
  };
  const bytes = byteText === null ? null : Number(byteText);
  if (!installerUrl
      || !version
      || !sha256
      || !Number.isSafeInteger(bytes)
      || bytes <= 0
      || !minimumMacos
      || architectures.length === 0
      || new Set(architectures).size !== architectures.length
      || Object.values(links).some((value) => value === null)) {
    return null;
  }
  return {
    installerUrl,
    version,
    sha256,
    bytes,
    minimumMacos,
    architectures,
    links,
  };
}

function formatInstallerSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB download`;
  }
  const mebibytes = bytes / (1024 * 1024);
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: mebibytes >= 10 ? 0 : 1,
  }).format(mebibytes)} MiB download`;
}

function renderInstallerJourney() {
  const release = configuredInstallerRelease();
  const link = $("#installer-link");
  const details = $("#installer-details");
  const releaseLinks = $("#installer-links");
  const unavailable = $("#installer-unavailable");
  if (release) {
    const architectureLabel = release.architectures.length === 2
      ? "Apple silicon and Intel"
      : release.architectures[0] === "arm64"
        ? "Apple silicon"
        : "Intel";
    link.href = release.installerUrl;
    link.hidden = false;
    $("#installer-version").textContent = `Version ${release.version}`;
    $("#installer-compatibility").textContent =
      `Requires macOS ${release.minimumMacos} or later · ${architectureLabel}`;
    $("#installer-size").textContent = formatInstallerSize(release.bytes);
    $("#installer-sha256").textContent = `SHA-256 ${release.sha256}`;
    details.hidden = false;
    for (const [id, url] of [
      ["release-notes-link", release.links.releaseNotes],
      ["privacy-link", release.links.privacy],
      ["security-link", release.links.security],
      ["support-link", release.links.support],
    ]) {
      const item = $(`#${id}`);
      item.href = url;
      item.hidden = false;
    }
    releaseLinks.hidden = false;
    unavailable.hidden = true;
    return;
  }
  link.removeAttribute("href");
  link.hidden = true;
  details.hidden = true;
  for (const id of [
    "installer-version",
    "installer-compatibility",
    "installer-size",
    "installer-sha256",
  ]) {
    $(`#${id}`).textContent = "";
  }
  for (const id of [
    "release-notes-link",
    "privacy-link",
    "security-link",
    "support-link",
  ]) {
    const item = $(`#${id}`);
    item.removeAttribute("href");
    item.hidden = true;
  }
  releaseLinks.hidden = true;
  unavailable.hidden = false;
}

function openInstalledApp() {
  const status = $("#open-installed-app-status");
  status.hidden = false;
  status.textContent =
    "Opening TiboTattle… If no app appears, install the signed Mac download above, then try again.";
  window.setTimeout(() => {
    if (!status.hidden) {
      status.textContent =
        "Continue in the local dashboard tab opened by TiboTattle. If nothing opened, the app is not installed or macOS blocked the link.";
    }
  }, 2_000);
}

function setJourneyState(state) {
  const body = document.body;
  body.classList.remove("first-run", "needs-local-setup", "local-ready", "demo-mode");
  body.classList.add(state);
  $("#companion-setup").hidden = state !== "first-run";
  const hasEvidence = state === "local-ready" || state === "demo-mode";
  for (const element of document.querySelectorAll("[data-requires-evidence]")) {
    element.hidden = !hasEvidence;
  }
  if (!hasEvidence) {
    $("#community-contribution-disclosure").open = false;
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMoney(value, digits = 0) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }).format(number);
}

function formatApiMoney(value) {
  const number = finite(value);
  if (number === null) return "—";
  if (number > 0 && number < .01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

function formatPercent(value, digits = 0) {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(digits)}%`;
}

function formatPp(value, digits = 1) {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(digits)} pp`;
}

function compact(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function formatUtc(value, { dateOnly = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-US", dateOnly
    ? { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }
    : { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
  ).format(new Date(value));
}

function formatLocal(value, { dateOnly = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-US", dateOnly
    ? { ...USER_TIME_ZONE_OPTION, month: "short", day: "numeric", year: "numeric" }
    : { ...USER_TIME_ZONE_OPTION, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
  ).format(new Date(value));
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

function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) return "Unknown age";
  if (seconds < 90) return "Less than 2 minutes ago";
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
}

function formatTimeRemaining(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time remaining unavailable";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "Reset due or recently passed";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function formatSpanLength(spanMs) {
  const minutes = Math.max(1, Math.round(spanMs / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function clear(element) {
  element.replaceChildren();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function setGlobalState(state, { companionReachable = false } = {}) {
  const labels = {
    live: "Live local evidence",
    updating: "Updating local evidence",
    stale: "Stale local evidence",
    insufficient: "Insufficient evidence",
    setup: "Local setup needed",
    offline: companionReachable ? "Ready to analyze" : "Mac app not connected",
    demo: "Labeled demo data"
  };
  const pill = $("#global-state");
  pill.className = `state-pill state-${state}`;
  pill.replaceChildren(node("span", "state-dot"), document.createTextNode(labels[state] ?? "Unknown state"));
}

function showConnectionNotice({
  title,
  copy,
  kind = "warning",
  showDemo = false,
  showCheck = false,
}) {
  const notice = $("#connection-notice");
  notice.className = `notice notice-${kind}`;
  $("#connection-title").textContent = title;
  $("#connection-copy").textContent = copy;
  $("#connection-check").hidden = !showCheck;
  $("#demo-button").hidden = !showDemo;
  notice.hidden = false;
}

function hideConnectionNotice() {
  $("#connection-notice").hidden = true;
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
  if (!value || value.state === "unavailable") {
    card.hidden = true;
    setJourneyState(dashboard?.mode === "demo" ? "demo-mode" : "first-run");
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
  $("#schema-version").textContent = `Dashboard contract: ${data.schemaVersion}`;

  if (data.mode === "demo") {
    showConnectionNotice({
      title: "You are exploring a labeled demonstration",
      copy: "Every number on this page is illustrative. Open the Mac app and use the separate local dashboard tab to see your own evidence.",
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
  renderUsageTimeline(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  renderQuality(data);
  renderCollector(data);
  renderReports(data);
  renderContributionPreparationEstimate();
}

function renderQuotaCards(data) {
  const container = $("#quota-cards");
  clear(container);
  const windows = data.quotaWindows;
  if (!windows.length) {
    const card = node("article", "metric-card insufficient");
    card.innerHTML = `
      <div class="metric-card-header"><span class="metric-name">Quota observations</span><span class="evidence-chip">Insufficient</span></div>
      <strong class="metric-value">—</strong>
      <p>The local companion has not exposed a current allowance window.</p>
    `;
    container.append(card);
    return;
  }
  for (const window of windows) {
    const remaining = finite(window.remainingPercent);
    const card = node("article", `metric-card ${window.status === "stale" ? "stale" : ""}`);
    const header = node("div", "metric-card-header");
    header.append(
      node("span", "metric-name", window.label),
      node("span", "evidence-chip", window.planType || (data.mode === "demo" ? "Demo" : "Observed"))
    );
    const value = node("strong", "metric-value");
    value.textContent = remaining === null ? "—" : `${remaining.toFixed(window.precision ?? 0)}%`;
    value.append(node("small", "", " remaining"));
    const progress = node("div", "mini-progress");
    const fill = node("i");
    fill.style.width = `${Math.max(0, Math.min(100, remaining ?? 0))}%`;
    progress.append(fill);
    const meta = node("div", "metric-meta");
    meta.append(
      node("span", "", window.usedPercent === null ? "Used unknown" : `${formatPercent(window.usedPercent)} used`),
      node("span", "", window.resetAt ? `Resets ${formatLocal(window.resetAt)}` : "Reset unknown")
    );
    card.append(header, value, progress, meta);
    if (window.resetAt) card.append(node("p", "", formatTimeRemaining(window.resetAt)));
    if (window.observedAt) {
      const attribution = window.accountAttribution === "attributed_pseudonymous"
        ? "pseudonymous account attributed"
        : "account unattributed";
      card.append(node("p", "", `Observed ${formatLocal(window.observedAt)} · ${attribution}`));
    }
    container.append(card);
  }
}

function renderPricing(data) {
  const pricing = data.pricing;
  const fastMode = pricing.fastMode;
  $("#cost-period").textContent = pricing.periodLabel;
  // The headline is the quota-weighted figure whenever a weighting exists;
  // when nothing can be weighted legitimately the label falls back to the
  // Standard-rate name rather than presenting an unweighted number under a
  // weighted heading.
  const weighted = pricing.quotaWeightedTotalCostUsd;
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  $("#cost-metric-kicker").textContent = useWeighted
    ? fastMode.metricLabel
    : fastMode.standardMetricLabel;
  $("#cost-metric-kicker").title = useWeighted
    ? fastMode.metricExplainer
    : "No usage in this period could be weighted, so the Standard-rate total is shown unchanged.";
  $("#cost-total").textContent = formatMoney(
    useWeighted ? weighted : pricing.totalCostUsd,
    2
  );
  const provenance = pricing.registryVersion
    ? ` · price registry ${pricing.registryVersion}${pricing.registryObservedAt ? ` (${formatLocal(pricing.registryObservedAt)})` : ""}`
    : "";
  const replay = pricing.replayExclusionDiagnostics?.forkReplayEventsExcluded ?? 0;
  const accountingMethod = pricing.accountingSource
    === "lineage_aware_cumulative_snapshot_replay_exclusion"
    ? `${pricing.accountingCacheStatus === "stale" ? "stale replay-safe cache" : "replay-safe"} · ${compact(replay)} inherited child snapshots excluded`
    : "legacy projection; replay exclusion has not been verified";
  $("#cost-coverage").textContent = pricing.coveragePercent === null
    ? "Price coverage is not available"
    : `${formatPercent(pricing.coveragePercent, 1)} priced · ${accountingMethod}${provenance}`;
  const list = $("#cost-components");
  clear(list);
  const components = pricing.components.filter(
    (row) => finite(row.costUsd, 0) > 0 || finite(row.tokens, 0) > 0
  );
  if (!components.length) {
    list.append(node("p", "empty-inline", "No token-component accounting was returned."));
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
    const hasUnpricedTokens = finite(component.unpricedTokens, 0) > 0;
    const hasPricedTokens = finite(component.pricedTokens, 0) > 0;
    const costLabel = hasUnpricedTokens && !hasPricedTokens
      ? "Unpriced"
      : hasUnpricedTokens
        ? `${formatApiMoney(component.costUsd)} + unpriced`
        : formatApiMoney(component.costUsd);
    row.append(
      track,
      node("strong", "", costLabel)
    );
    row.title = hasUnpricedTokens
      ? `${compact(component.tokens)} tokens · ${compact(component.unpricedTokens)} unpriced`
      : `${compact(component.tokens)} tokens`;
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
  const mae = finite(summary.mean_absolute_error_pp ?? summary.meanAbsoluteErrorPp);
  const within = finite(summary.points_within_80_band_fraction ?? summary.pointsWithin80BandFraction);
  const capacity = finite(summary.capacity_usd ?? summary.capacityUsd);
  const lower = finite(summary.lower_80_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_usd ?? summary.upper80Usd);
  const chip = $("#fit-chip");
  renderCalibrationRate({ capacity, lower, upper });
  if (!pair || pair.observed === null || pair.expected === null) {
    chip.textContent = "Insufficient";
    $("#comparison-result").textContent = "There is not yet a matched quota-and-cost window to compare.";
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
  chip.textContent = mae === null ? "Matched window" : `MAE ${mae.toFixed(1)} pp`;
  $("#comparison-result").textContent = `${formatPp(Math.abs(residual))} separates the observed and cost-implied movement in the latest matched window.${within === null ? "" : ` Across the series, ${formatPercent(within * 100)} of points fall inside the modeled 80% band.`}`;
}

function renderCalibrationRate({ capacity, lower, upper }) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
  if (capacity === null || capacity <= 0) {
    rate.textContent = "Not estimable";
    range.textContent = "Not estimable";
    example.textContent = "Not estimable";
    explanation.textContent =
      "There is not yet enough matched cost and quota evidence for a positive fitted rate. API prices remain a measuring stick, not a subscription charge.";
    return;
  }
  const perPoint = capacity / 100;
  const movementForHundred = 10_000 / capacity;
  rate.textContent = `${formatMoney(perPoint, 2)} API equivalent per 1 percentage point`;
  range.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? `${formatMoney(lower / 100, 2)}–${formatMoney(upper / 100, 2)} per point`
    : "Range unavailable";
  example.textContent =
    `$100 of recorded API-price-equivalent usage corresponds to about ${movementForHundred.toFixed(1)} percentage points`;
  explanation.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? `The central fit implies a full 100-point allowance near ${formatMoney(capacity, 0)} API equivalent. The 80% range (${formatMoney(lower, 0)}–${formatMoney(upper, 0)}) describes variation across qualifying reset periods; it is not an 80% probability or a provider-published dollar cap.`
    : `The central fit implies a full 100-point allowance near ${formatMoney(capacity, 0)} API equivalent, but there is not yet a usable across-reset range. This is not a provider-published dollar cap.`;
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
    ?? data.timeline.quota.at(-1)?.observedAt
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
    missing_quota_bracket: "Missing quota bracket",
    reset_or_track_change: "Provider reset or quota-track change",
    backward_or_ambiguous: "Ambiguous quota movement",
  }[status] ?? "Historical calibration point";
}

function timelineStatusIntervals(points, viewport) {
  const rows = points
    .filter((point) => Number.isFinite(Date.parse(point.timestamp)))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return rows.flatMap((point, index) => {
    if (!point.status || point.status === "matched") return [];
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
  const weeklyCodex = rows.filter(
    (row) => row.limitId === "codex" && row.durationMinutes === 10_080,
  );
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
  const weeklyQuota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quota = (weeklyQuota.length ? weeklyQuota : data.timeline.quota);
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
    points.push({
      timestamp: current.endAt,
      observed,
      expected,
      residual: observed === null || expected === null ? null : observed - expected,
      apiCostUsd: Math.max(0, rollingCost),
      usageEvents: Math.max(0, rollingEvents),
      status: !bracketed ? "missing_quota_bracket"
        : !sameReset ? "reset_or_track_change"
          : observed === null ? "backward_or_ambiguous"
            : "matched"
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
        LOCAL_CALENDAR_PARTS.formatToParts(timestamp)
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
  const preferred = mainWeeklyQuotaTrack(data.timeline.quota);
  const fallback = data.timeline.quota.filter(
    (row) => row.durationMinutes === 10_080 || row.limitId === "codex"
  );
  const quota = preferred.length ? preferred : fallback;
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

function renderUsageTimeline(data) {
  const points = usagePointsWithAllowance(data, groupedUsageTimeline(data));
  const shell = $("#usage-timeline-chart");
  const empty = $("#usage-timeline-empty");
  const label = { hour: "hour", day: "day", week: "week" }[activeUsageGrouping];
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
        label: "API-price-equivalent usage"
      }],
      yLabel: "API-equivalent USD",
      secondarySeries: [{
        key: "allowanceRemaining",
        className: "chart-line-allowance",
        label: "Seven-day allowance remaining"
      }],
      secondaryYLabel: "Allowance remaining (%)",
      title: "Real local API-price-equivalent usage over time",
      description: `Replay-safe local usage cost with provider-observed seven-day allowance remaining in ${USER_TIME_ZONE}.`,
      includeZero: true
    }));
  }
  $("#usage-timeline-copy").textContent =
    `Replay-safe local increments · ${USER_TIME_ZONE} · current Standard API prices`;
  const summary = $("#usage-timeline-summary");
  clear(summary);
  const total = points.reduce((sum, row) => sum + row.apiCostUsd, 0);
  const events = points.reduce((sum, row) => sum + row.usageEvents, 0);
  const replayExcluded = data.accounting.replayExclusionDiagnostics
    ?.forkReplayEventsExcluded ?? 0;
  for (const [name, value] of [
    ["Replay-safe buckets", compact(points.length)],
    ["API-price equivalent", formatApiMoney(total)],
    ["Usage increments", compact(events)],
    ["Inherited replay excluded", compact(replayExcluded)]
  ]) {
    const item = node("div");
    item.append(node("span", "", name), node("strong", "", value));
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
    ? "15-minute"
    : `${activeWindowHours}-hour`;
  $("#timeline-chart-title").textContent = `${windowLabel} rolling quota change versus cost-implied change`;
  $("#timeline-chart-copy").textContent = usingLive
    ? `Replay-safe local increments · ${USER_TIME_ZONE} chart axis · exact local and UTC times below`
    : `Historical local calibration artifact from ${formatLocal(data.artifactStatus.gradient.generatedAt)} · recent quota snapshots are too sparse to bracket ${windowLabel} endpoints`;
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  if (!visiblePoints.length || (usingLive && matchedVisible.length === 0)) {
    shell.hidden = true;
    empty.hidden = false;
    empty.querySelector("strong").textContent = visiblePoints.length
      ? "Not comparable yet"
      : `No ${windowLabel} series loaded`;
    empty.querySelector("p").textContent = visiblePoints.length
      ? `Cost history exists, but quota observations do not bracket any ${windowLabel} window in this date range. The calculated line is hidden until there is measured evidence to compare it with.`
      : "This is a missing-data state, not a zero-usage period.";
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points: visiblePoints,
      series: [
        { key: "observed", className: "chart-line-observed", label: "Observed quota change" },
        { key: "expected", className: "chart-line-expected", label: "Expected from API cost" }
      ],
      yLabel: "Percentage points",
      title: `${windowLabel} rolling quota movement`,
      description: `Observed quota movement compared with movement implied by priced token usage. The horizontal axis is ${USER_TIME_ZONE}.`,
      includeZero: true,
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
    }));
    bindTimelineInteractions(shell, points, viewport);
  }
  renderTimelineSummary(data, visiblePoints);
  renderTimelineConfidence(points, visiblePoints, usingLive, viewport);
  renderResiduals(data, visiblePoints, viewport);
}

function renderTimelineConfidence(allPoints, visiblePoints, usingLive, viewport) {
  const element = $("#timeline-confidence");
  const matched = visiblePoints.filter((point) => point.observed !== null && point.expected !== null).length;
  const excluded = visiblePoints.length - matched;
  const full = timelineBounds(allPoints);
  const zoomed = viewport !== null && full !== null
    && (viewport.startMs !== full.startMs || viewport.endMs !== full.endMs);
  element.classList.toggle("low", matched < 3 || excluded > matched);
  if (!visiblePoints.length) {
    element.textContent = "No points fall inside this zoomed interval. Reset the view to return to the available evidence.";
  } else if (!usingLive) {
    element.textContent = "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.";
  } else if (matched < 3) {
    element.textContent = `Low confidence: only ${matched} matched quota window${matched === 1 ? "" : "s"} is visible; ${excluded} window${excluded === 1 ? " is" : "s are"} excluded for missing or ambiguous quota evidence.`;
  } else if (excluded > 0) {
    element.textContent = `${matched} matched windows are shown. ${excluded} excluded window${excluded === 1 ? " is" : "s are"} shaded above; do not read them as zero usage.`;
  } else {
    element.textContent = `${matched} matched quota windows are visible. This compares observed percentage-point movement with a priced-token estimate; it is not a provider-published allowance.`;
  }
  if (zoomed) element.textContent += " Use Reset view to return to the selected date range.";
}

function bindTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", `Interactive quota timeline in ${USER_TIME_ZONE}. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.`);
  const status = $("#timeline-zoom-status");
  status.textContent = `Timeline shows ${formatLocal(new Date(viewport.startMs).toISOString())} through ${formatLocal(new Date(viewport.endMs).toISOString())}, a span of ${formatSpanLength(viewport.endMs - viewport.startMs)}.`;
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomTimeline(points, wheelZoomFactor(event), ratio);
  };
  shell.onpointerdown = (event) => {
    timelinePointerStart = { x: event.clientX };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-panning");
  };
  shell.onpointermove = (event) => {
    if (timelinePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - timelinePointerStart.x;
    if (Math.abs(delta) < 3) return;
    timelinePointerStart.x = event.clientX;
    event.preventDefault();
    panTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    timelinePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-panning");
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
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
  const matched = points.filter((row) => row.observed !== null && row.expected !== null);
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const liveMae = matched.length
    ? matched.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / matched.length
    : null;
  const livePeak = matched.length
    ? Math.max(...matched.map((row) => Math.abs(row.observed - row.expected)))
    : null;
  const values = [
    ["Matched windows", compact(matched.length)],
    ["Mean absolute error", formatPp(live ? liveMae : sensitivity?.mae_pp ?? sensitivity?.weighted_mae_pp ?? summary.mean_absolute_error_pp)],
    ["Peak residual", formatPp(live ? livePeak : summary.rolling_peak_absolute_residual_pp)],
    ["Usable quota coverage", points.length
      ? formatPercent(matched.length / points.length * 100)
      : "—"]
  ];
  const container = $("#timeline-summary");
  clear(container);
  for (const [label, value] of values) {
    const item = node("div");
    item.append(node("span", "", label), node("strong", "", value));
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
      return Number.isFinite(timestamp)
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
    element.textContent = "No windows fall inside this date range.";
  } else if (missing === 0) {
    element.textContent = `All ${rows.length} window${rows.length === 1 ? "" : "s"} in this range have a computable residual.`;
  } else {
    element.textContent = `${computed.length} of ${rows.length} windows in this range have a computable residual. The other ${missing} are shown as shaded gaps on the same axis, never as zero: ${residualGapReasons(rows).join(", ")}.`;
  }
}

function renderResiduals(data, points, viewport = null) {
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
      series: [{ key: "residual", className: "chart-line-value", label: "Residual" }],
      yLabel: "Percentage points",
      title: "Quota movement residuals",
      description: "Observed quota change minus the API-cost-implied change, over the same date range as the calibration chart. Windows with no computable residual are left as shaded gaps.",
      includeZero: true,
      xDomain: domain,
      statusIntervals: domain === null
        ? []
        : timelineStatusIntervals(residuals, domain),
    }));
  }
  renderResidualCoverage(residuals, computed);
  const table = $("#residual-table");
  clear(table);
  const unmatched = points
    .filter((point) => point.timestamp && point.status && point.status !== "matched")
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
      node("td", "", `${formatLocal(item.timestamp)} · ${formatUtc(item.timestamp)}`),
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? "Not comparable" : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      node("td", "", timelineStatusLabel(item.status ?? "matched")),
    );
    table.append(row);
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
  statusIntervals = [],
  secondarySeries = [],
  secondaryYLabel = null,
}) {
  const width = 900;
  const height = 330;
  const hasSecondary = secondarySeries.length > 0;
  const margin = { top: 24, right: hasSecondary ? 64 : 22, bottom: 50, left: 58 };
  const values = points.flatMap((point) => series.map((item) => finite(point[item.key])).filter((value) => value !== null));
  if (confidence) values.push(...points.flatMap((point) => [finite(point[confidence.low]), finite(point[confidence.high])].filter((value) => value !== null)));
  if (errorBars) values.push(...points.flatMap((point) => [finite(point[errorBars.low]), finite(point[errorBars.high])].filter((value) => value !== null)));
  if (includeZero) values.push(0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * .1;
  min = includeZero && min >= 0 ? 0 : min - pad;
  max += pad;
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

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  const titleNode = document.createElementNS(svg.namespaceURI, "title");
  titleNode.textContent = title;
  const descNode = document.createElementNS(svg.namespaceURI, "desc");
  descNode.textContent = description;
  svg.append(titleNode, descNode);

  for (let index = 0; index < 5; index += 1) {
    const value = max - index / 4 * (max - min);
    const yPosition = y(value);
    svg.append(svgLine(margin.left, yPosition, width - margin.right, yPosition, "chart-grid"));
    svg.append(svgText(margin.left - 8, yPosition + 3, value.toFixed(Math.abs(max - min) < 10 ? 1 : 0), "chart-axis-label", "end"));
    if (hasSecondary) {
      svg.append(svgText(
        width - margin.right + 8,
        ySecondary(100 - index * 25) + 3,
        `${100 - index * 25}%`,
        "chart-axis-label",
        "start"
      ));
    }
  }

  if (includeZero && min <= 0 && max >= 0) {
    svg.append(svgLine(margin.left, y(0), width - margin.right, y(0), "chart-zero"));
  }

  if (timed) {
    for (let index = 0; index < 4; index += 1) {
      const timestamp = new Date(
        domainStartMs + (safeDomainEndMs - domainStartMs) * index / 3,
      ).toISOString();
      svg.append(svgText(
        margin.left + (width - margin.left - margin.right) * index / 3,
        height - 22,
        formatLocal(timestamp, { dateOnly: safeDomainEndMs - domainStartMs > 7 * 24 * 60 * 60 * 1_000 }),
        "chart-axis-label",
        index === 0 ? "start" : index === 3 ? "end" : "middle",
      ));
    }
    svg.append(svgText(width / 2, height - 6, USER_TIME_ZONE, "chart-axis-label", "middle"));
  } else {
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
    for (const index of labelIndexes) {
      const timestamp = points[index]?.timestamp ?? points[index]?.date;
      svg.append(svgText(x(index), height - 22, formatLocal(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"));
    }
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
      const barTitle = document.createElementNS(svg.namespaceURI, "title");
      barTitle.textContent = `${errorBars.label}: ${format(low)}–${format(high)}${point.timestamp ? ` · ${formatLocal(point.timestamp)}` : ""}`;
      group.append(barTitle);
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
    intervalTitle.textContent = timelineStatusLabel(interval.status);
    rect.append(intervalTitle);
    svg.append(rect);
  }

  for (const item of series) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push([x(index, point), y(value)]);
    });
    if (segment.length) segments.push(segment);
    if (item.connect !== false) for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute("points", pathPoints.map(([a, b]) => `${a},${b}`).join(" "));
      path.setAttribute("class", item.className);
      svg.append(path);
    }
    if (item.markers === true) {
      const format = item.format ?? formatMoney;
      points.forEach((point, index) => {
        const value = finite(point[item.key]);
        if (value === null) return;
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(x(index, point)));
        marker.setAttribute("cy", String(y(value)));
        marker.setAttribute("r", String(item.markerRadius ?? 4));
        marker.setAttribute("class", `${item.className} chart-point`);
        const timestamp = point.timestamp ?? point.date;
        const caption = [
          `${item.label}: ${format(value)}`,
          item.detail?.(point),
          timestamp ? formatLocal(timestamp) : null,
        ].filter(Boolean).join(" · ");
        const markerTitle = document.createElementNS(svg.namespaceURI, "title");
        markerTitle.textContent = caption;
        marker.append(markerTitle);
        // A hover title alone is mouse-only, so focusable markers carry the
        // identical sentence to the keyboard and to assistive technology.
        if (item.focusable === true) {
          marker.setAttribute("tabindex", "0");
          marker.setAttribute("role", "img");
          marker.setAttribute("aria-label", caption);
        }
        svg.append(marker);
      });
    }
  }
  for (const item of secondarySeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else {
        segment.push([x(index, point), ySecondary(value)]);
      }
    });
    if (segment.length) segments.push(segment);
    for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute(
        "points",
        pathPoints.map(([a, b]) => `${a},${b}`).join(" ")
      );
      path.setAttribute("class", item.className);
      svg.append(path);
    }
  }
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
  element.textContent = value;
  return element;
}

function aboveWeeklySpanThreshold(observedSpanPp) {
  // An unrecorded span cannot be shown to clear the threshold, so it stays a
  // diagnostic instead of being promoted to headline evidence.
  return observedSpanPp !== null && observedSpanPp > weeklySpanThresholdPp;
}

function weeklyThresholdLabel() {
  return `more than ${formatPp(weeklySpanThresholdPp, 0)}`;
}

function weeklyPointDetail(point) {
  return [
    point.observedSpanPp === null
      ? "observed span not recorded"
      : `represents ${formatPp(point.observedSpanPp)} of the 100-point allowance`,
    point.low === null || point.high === null
      ? "no within-reset sensitivity range"
      : `within-reset sensitivity ${formatMoney(point.low)}–${formatMoney(point.high)}`,
  ].join(" · ");
}

function renderWeeklySpanThresholdControls() {
  const slider = $("#weekly-span-threshold");
  slider.value = String(weeklySpanThresholdPp);
  slider.setAttribute("aria-valuetext", `${weeklySpanThresholdPp} percentage points`);
  $("#weekly-span-threshold-value").textContent = `> ${formatPp(weeklySpanThresholdPp, 0)}`;
  $("#weekly-evidence-controls").querySelector('[data-evidence="mature"]')
    .textContent = `> ${formatPp(weeklySpanThresholdPp, 0)} only`;
}

function renderWeekly(data) {
  renderWeeklySpanThresholdControls();
  const summary = data.weekly.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const qualifying = finite(summary.qualifying_resets ?? summary.qualifyingResets, 0);
  const strength = Math.min(100, Math.round(qualifying / 14 * 100));
  $("#weekly-estimate").textContent = estimate === null ? "Insufficient evidence" : `${formatMoney(estimate)} API equivalent`;
  $("#weekly-range").textContent = lower === null || upper === null
    ? "No evidence interval available"
    : `80% across-reset range: ${formatMoney(lower)}–${formatMoney(upper)}`;
  $("#evidence-meter").style.width = `${strength}%`;
  $("#evidence-label").textContent = qualifying < 3 ? "Insufficient" : qualifying < 8 ? "Developing" : qualifying < 14 ? "Moderate" : "Substantial";
  const attributionLabel = data.weekly.accountAttribution?.label;
  const evidenceExplanation = qualifying
    ? `Historical median across ${qualifying} qualifying reset-series fits. The headline chart shows fits observed across ${weeklyThresholdLabel()} of the allowance; that threshold is adjustable and shorter-span extrapolations remain available as diagnostics. This is an API-price-equivalent calibration, not a published dollar cap.`
    : "The estimate will appear when enough quota transitions can be matched to priced usage.";
  $("#weekly-explanation").textContent = attributionLabel
    ? `${evidenceExplanation} ${attributionLabel}.`
    : evidenceExplanation;

  const values = data.weekly.weeklyValues.map((row, index) => {
    const value = finite(row.value_usd ?? row.value);
    const observedSpanPp = finite(row.displayed_span_pp);
    return {
    ...row,
    timestamp: row.last_observed_at ?? row.first_observed_at,
    resetDueAt: row.reset_due_at ?? row.resetAt ?? null,
    value,
    low: finite(row.pairwise_p10_usd ?? row.lower),
    high: finite(row.pairwise_p90_usd ?? row.upper),
    observedSpanPp,
    historicalMedian: estimate,
    acrossResetLow: lower,
    acrossResetHigh: upper,
    matureValue: aboveWeeklySpanThreshold(observedSpanPp) ? value : null,
    provisionalValue: aboveWeeklySpanThreshold(observedSpanPp) ? null : value,
    index
    };
  }).filter((row) => row.timestamp && row.value !== null)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const latestObservedMs = values.reduce(
    (latest, row) => Math.max(latest, Date.parse(row.timestamp)),
    Number.NEGATIVE_INFINITY,
  );
  const cutoffMs = Number.isFinite(latestObservedMs)
    ? latestObservedMs - activeWeeklyRangeDays * 24 * 60 * 60 * 1_000
    : Number.NEGATIVE_INFINITY;
  const rangedValues = values.filter((row) => Date.parse(row.timestamp) >= cutoffMs);
  const chartValues = showWeeklyPartialDiagnostics
    ? rangedValues
    : rangedValues.filter((row) => row.matureValue !== null);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!chartValues.length) {
    empty.hidden = false;
    shell.hidden = true;
    empty.textContent = showWeeklyPartialDiagnostics
      ? "No weekly estimates loaded."
      : `No reset fits observed across ${weeklyThresholdLabel()} fall inside this date range.`;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points: chartValues,
      series: [
        {
          key: "historicalMedian",
          className: "chart-line-weekly-center",
          label: "Historical median",
        },
        {
          key: "matureValue",
          className: "chart-point-weekly-mature",
          label: `Fit observed across ${weeklyThresholdLabel()}`,
          connect: false,
          markers: true,
          markerRadius: 5,
          focusable: true,
          detail: weeklyPointDetail,
        },
        {
          key: "provisionalValue",
          className: "chart-point-weekly-partial",
          label: "Partial diagnostic extrapolated to 100 percentage points",
          connect: false,
          markers: true,
          markerRadius: 5,
          focusable: true,
          detail: weeklyPointDetail,
        },
      ],
      confidence: { low: "acrossResetLow", high: "acrossResetHigh" },
      errorBars: {
        low: "low",
        high: "high",
        className: "chart-error-bar-weekly",
        label: "Within-reset sensitivity",
      },
      yLabel: "API-equivalent USD",
      title: "Seven-day allowance estimate history",
      description: `Historical median and independent reset-series fits plotted on the date each estimate became available in ${USER_TIME_ZONE}. Each fit carries its own within-reset sensitivity bar.`
    }));
  }
  renderWeeklyStats(summary, chartValues);
  renderWeeklyTrend(chartValues);
  renderWeeklyTable(values);
}

function medianValue(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderWeeklyTrend(values) {
  const container = $("#weekly-trend");
  const enoughRows = values.length >= 6;
  const early = enoughRows
    ? medianValue(values.slice(0, 3).map((row) => row.value))
    : null;
  const recent = enoughRows
    ? medianValue(values.slice(-3).map((row) => row.value))
    : null;
  const change = early !== null && early > 0 && recent !== null
    ? recent / early - 1
    : null;
  const heading = node("strong", "", "Has the inferred limit changed?");
  let conclusion;
  if (change === null || early === null || recent === null) {
    conclusion = "Not enough comparable resets yet. We need at least three early and three recent weekly estimates before making even a descriptive comparison.";
  } else {
    const magnitude = Math.abs(change);
    const direction = change >= 0 ? "higher" : "lower";
    const comparison = `The recent three-reset median is ${formatPercent(magnitude * 100, 1)} ${direction} than the early three-reset median (${formatMoney(early)} → ${formatMoney(recent)} API equivalent).`;
    conclusion = magnitude < 0.15
      ? `${comparison} That is not a clear regime change given the observed uncertainty, so the practical conclusion is “no convincing change detected.”`
      : `${comparison} This is a possible accounting or allowance shift, but not proof: it must persist across later resets and remain after plan, account, model, and Fast-mode differences are controlled.`;
  }
  container.replaceChildren(heading, node("p", "", conclusion));
}

function renderWeeklyStats(summary, values) {
  const stats = [
    ["Fits shown", values.length],
    ["Held-out MAE", formatPp(summary.selected_holdout_mae_pp)],
    ["Prior-reset MAE", formatPp(summary.prior_reset_mae_pp)],
    ["80th pct error", formatPp(summary.prior_reset_p80_absolute_error_pp)]
  ];
  const container = $("#weekly-stats");
  clear(container);
  for (const [label, value] of stats) {
    const card = node("div", "weekly-stat");
    card.append(node("span", "", label), node("strong", "", value));
    container.append(card);
  }
}

function renderWeeklyTable(values) {
  const table = $("#weekly-table");
  clear(table);
  if (!values.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No weekly evidence loaded.");
    cell.colSpan = 8;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const row of values.slice(-14).reverse()) {
    const transitions = finite(row.eligible_transitions, 0);
    const span = row.observedSpanPp ?? finite(row.displayed_span_pp);
    const observedCost = span === null ? null : row.value * span / 100;
    const speedCoverage = finite(row.known_speed_fraction);
    const belowThreshold = !aboveWeeklySpanThreshold(span);
    const evidence = belowThreshold
      ? "Partial diagnostic"
      : transitions < 25 ? "Low" : transitions < 75 ? "Moderate" : "Higher";
    const prior = finite(row.prior_prediction_mae_pp);
    const caveat = belowThreshold
      ? span === null
        ? "Observed span not recorded; extrapolated to 100 pp"
        : `Observed ${formatPp(span)}; extrapolated to 100 pp`
      : prior === null
        ? "First estimate; no prior forecast"
        : prior < 3 ? "Prior forecast tracked closely" : prior < 7 ? "Meaningful model error" : "High-error period";
    const evidenceDate = formatLocal(row.timestamp, { dateOnly: true });
    const resetDate = row.resetDueAt
      ? formatLocal(row.resetDueAt, { dateOnly: true })
      : "unknown";
    const tr = node("tr");
    tr.append(
      node("td", "", `${evidenceDate} / ${resetDate}`),
      node("td", "", formatApiMoney(observedCost)),
      node("td", "", formatPp(span)),
      node("td", "", formatMoney(row.value)),
      node("td", "", row.low === null || row.high === null ? "—" : `${formatMoney(row.low)}–${formatMoney(row.high)}`),
      node("td", "", `${transitions} transitions`),
      node("td", "", `${evidence}${speedCoverage === null ? "" : ` · ${formatPercent(speedCoverage * 100)} speed known`}`),
      node("td", "", caveat)
    );
    table.append(tr);
  }
}

function accountingPeriod(data) {
  const selected = data.accounting.periods.find(
    (period) => period.periodId === activeAccountingPeriod
  );
  return selected
    ? {
      ...data.accounting,
      ...selected,
      replayExclusionDiagnostics: data.accounting.replayExclusionDiagnostics,
      accountingSource: data.accounting.accountingSource
    }
    : data.accounting;
}

function renderAccountingDimension(containerSelector, dimension, {
  emptyMessage = "No observations in this period.",
  unknownLabel = "Not recorded",
  eventNoun = "usage increments",
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

function renderAccounting(data) {
  const accounting = accountingPeriod(data);
  const summary = $("#accounting-summary");
  clear(summary);
  const pricedEvents = finite(accounting.pricingCoverage?.fullyPricedEvents, 0)
    + finite(accounting.pricingCoverage?.partiallyPricedEvents, 0);
  const replayExcluded = finite(
    accounting.replayExclusionDiagnostics?.forkReplayEventsExcluded,
    0
  );
  const fastMode = accounting.fastMode;
  const weighted = accounting.quotaWeightedApiPriceEquivalentUsd;
  for (const [label, value, note] of [
    ["Usage increments", compact(accounting.events), "Non-overlapping cumulative deltas"],
    [
      fastMode.metricShortLabel,
      weighted === null ? "—" : formatApiMoney(weighted),
      weighted === null
        ? "No increment in this period could be weighted"
        : `${formatApiMoney(accounting.apiPriceEquivalentUsd)} at Standard rates before Fast weighting`
    ],
    ["Non-overlapping tokens", compact(accounting.totalTokens), accounting.periodLabel],
    ["Inherited replay excluded", compact(replayExcluded), "Removed across the cached scan window"],
    ["Model price coverage", formatPercent(pricedEvents / Math.max(1, accounting.events) * 100, 1), "Share of increments with a mapped price"]
  ]) {
    const card = node("article", "metric-card compact-metric");
    card.append(
      node("span", "metric-name", label),
      node("strong", "metric-value", value),
      node("p", "", note)
    );
    summary.append(card);
  }

  const components = $("#accounting-components");
  clear(components);
  const componentRows = Object.entries(accounting.components ?? {})
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
  const maximum = Math.max(1, ...componentRows.map(([, value]) => value));
  for (const [key, value] of componentRows) {
    const row = node("div", "component-row");
    row.append(node("span", "", componentLabel(key)));
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%`;
    track.append(fill);
    row.append(track, node("strong", "", compact(value)));
    components.append(row);
  }

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
    const visibleModelRows = modelRows.some((model) => model.model === "unknown")
      ? modelRows
      : [...modelRows, {
        model: "unknown",
        events: 0,
        totalTokens: 0,
        apiPriceEquivalentUsd: 0
      }];
    for (const model of visibleModelRows) {
      const row = node("tr");
      row.append(
        node("td", "", model.model === "unknown" ? "Unrecognized / unpriced overflow" : model.model),
        node("td", "", compact(model.events)),
        node("td", "", compact(model.totalTokens)),
        node(
          "td",
          "",
          model.model === "unknown"
            ? "—"
            : formatApiMoney(model.apiPriceEquivalentUsd)
        )
      );
      models.append(row);
    }
  }

  renderAccountingDimension("#accounting-speed", accounting.bySpeed, {
    unknownLabel: "Not recorded"
  });
  renderAccountingDimension("#accounting-surface", accounting.bySurface, {
    unknownLabel: "Unclassified",
    labels: {
      extension_or_ide: "Codex desktop / IDE",
      scheduled_task: "Scheduled task",
      cli_exec: "Codex CLI",
      subagent: "Subagent"
    }
  });
  renderAccountingDimension("#accounting-lineage", accounting.byLineage, {
    unknownLabel: "Lineage unavailable"
  });
  const toolDimension = Object.fromEntries(
    Object.entries(data.accounting.toolClasses?.counts ?? {}).map(([key, events]) => [
      key,
      { events, totalTokens: 0, apiPriceEquivalentUsd: 0 }
    ])
  );
  renderAccountingDimension("#accounting-tools", toolDimension, {
    emptyMessage: "No coarse tool-class calls are retained.",
    eventNoun: "calls"
  });
  $("#accounting-tier").replaceChildren(node(
    "p",
    "empty-inline",
    "Subscription logs do not expose an API billing tier. Standard API pricing is an explicit counterfactual, not an observation."
  ));
  $("#accounting-effort").replaceChildren(node(
    "p",
    "empty-inline",
    "Reasoning-token counts are available, but the selected low/medium/high reasoning-effort setting is not retained in these usage snapshots."
  ));
  renderFastModePreference();
}

function fastModeCoverageSentence(fastMode) {
  const coverage = fastMode.coverage;
  if (coverage.totalEvents === 0) {
    return "No usage increments in this period, so there is no speed-mode attribution to report.";
  }
  const parts = [
    `${compact(coverage.observedEvents)} observed in the logs`,
    `${compact(coverage.assumedFromPreferenceEvents)} attributed from your stated mode`,
    `${compact(coverage.inferredEvents)} inferred from calibration residuals`,
    `${compact(coverage.unknownEvents)} still unknown`
  ];
  const share = coverage.unknownSharePercent === null
    ? ""
    : ` (${formatPercent(coverage.unknownSharePercent, 1)} of increments).`;
  const unweighted = fastMode.unweightedUnknownApiPriceEquivalentUsd > 0
    ? ` ${formatApiMoney(fastMode.unweightedUnknownApiPriceEquivalentUsd)} of Standard-rate cost could not be weighted and is excluded from the weighted total rather than counted at 1x.`
    : "";
  return `Of ${compact(coverage.totalEvents)} usage increments: ${parts.join(", ")}${share}${unweighted} Codex records the mode only when it is applied or changed, so turns before the first change in a session are never observed and a small structural error in the calibration cannot be engineered away.`;
}

function fastModeInferenceSentence(fastMode) {
  const inference = fastMode.inference;
  if (inference.status !== "inferred") {
    return "Residual inference has not run: there is not yet enough matched calibration evidence to compare a window against a Standard reference.";
  }
  if (inference.inferredFastWindows === 0) {
    return `Residual inference compared ${compact(inference.scoredWindowCount)} calibration windows against ${compact(inference.referenceWindowCount)} Standard references and marked none as Fast.`;
  }
  return `Residual inference marked ${compact(inference.inferredFastWindows)} of ${compact(inference.scoredWindowCount)} calibration windows as inferred Fast, against ${compact(inference.referenceWindowCount)} Standard references. Inference labels windows, never individual increments, so it is reported here and never folded into the weighted total.`;
}

function renderFastModePreference() {
  const accounting = dashboard === null ? null : accountingPeriod(dashboard);
  const stated = fastModePreference?.mode
    ?? accounting?.fastMode?.preference
    ?? "standard";
  for (const control of $("#fast-mode-preference-controls").querySelectorAll("[data-fast-mode]")) {
    const active = control.dataset.fastMode === stated;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
    control.disabled = fastModePreferenceBusy;
  }
  const coverage = $("#fast-mode-coverage");
  if (accounting === null) {
    coverage.textContent = "Awaiting local evidence.";
    return;
  }
  coverage.textContent = `${fastModeCoverageSentence(accounting.fastMode)} ${fastModeInferenceSentence(accounting.fastMode)}`;
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
    showFailure(status, {
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

// Statuses that change how a reader should trust the headline number, most
// material first. Anything else is a coverage note and stays in the inventory.
const MATERIAL_GAP_STATUSES = Object.freeze([
  "missing",
  "not_observed",
  "insufficient_evidence",
  "mostly_unknown",
  "unattributed",
  "unsupported",
  "unsupported_or_partial",
  "unavailable",
  "excluded",
  "uncertain",
  "partial"
]);
const MATERIAL_GAP_LIMIT = 4;

function materialGapRank(item) {
  const index = MATERIAL_GAP_STATUSES.indexOf(item.status ?? item.priority ?? "");
  return index === -1 ? MATERIAL_GAP_STATUSES.length : index;
}

function gapExplanation(item) {
  return item.explanation ?? item.evidence ?? item.description ?? item.action
    ?? "Additional evidence is required.";
}

function briefGapExplanation(item) {
  const source = String(gapExplanation(item)).trim();
  const end = source.indexOf(". ");
  return end === -1 ? source : source.slice(0, end + 1);
}

function gapTitle(item) {
  return item.title ?? item.dimension ?? "Unresolved coverage gap";
}

function fastModeShortCoverage(fastMode) {
  const coverage = fastMode.coverage;
  if (coverage.totalEvents === 0) {
    return "No usage increments in this period, so there is nothing to attribute.";
  }
  return `Of ${compact(coverage.totalEvents)} increments: ${compact(coverage.observedEvents)} observed, ${compact(coverage.assumedFromPreferenceEvents)} from your stated mode, ${compact(coverage.inferredEvents)} inferred, ${compact(coverage.unknownEvents)} unknown.`;
}

function renderQuality(data) {
  const coverage = data.quality.coverage;
  const summary = data.quality.summary ?? {};
  const list = $("#coverage-list");
  clear(list);
  const rows = coverage.length ? coverage : [
    { dimension: "Fit-eligible transitions", coverage_fraction: summary.fit_eligible_fraction },
    { dimension: "Known speed tier", coverage_fraction: summary.known_speed_fraction }
  ].filter((row) => finite(row.coverage_fraction) !== null);
  $("#coverage-total").textContent = `${rows.length} signals`;
  if (!rows.length) {
    list.append(node("p", "empty-inline", "No coverage dimensions were returned."));
  } else {
    for (const item of rows) {
      const fraction = Math.max(0, Math.min(1, finite(item.coverage_fraction ?? item.coverageFraction, 0)));
      const row = node("div", "coverage-row");
      row.append(node("span", "", item.dimension ?? item.label ?? "Coverage"));
      const track = node("div", "coverage-track");
      const fill = node("i");
      fill.style.width = `${fraction * 100}%`;
      track.append(fill);
      row.append(track, node("strong", "", formatPercent(fraction * 100)));
      list.append(row);
    }
  }

  const issues = [
    ...data.monitoringGaps,
    ...data.quality.opportunities,
    ...data.quality.blindSpots
  ];
  const ranked = issues
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => materialGapRank(item) < MATERIAL_GAP_STATUSES.length)
    .sort((left, right) => (
      materialGapRank(left.item) - materialGapRank(right.item)
      || left.index - right.index
    ))
    .map(({ item }) => item);
  const material = ranked.slice(0, MATERIAL_GAP_LIMIT);

  const issueList = $("#blind-spot-list");
  clear(issueList);
  if (!issues.length) {
    issueList.append(node("div", "empty-inline", "No blind-spot inventory was returned."));
  } else if (!material.length) {
    issueList.append(node(
      "div",
      "empty-inline",
      "Nothing in the current inventory changes how the headline number should be read."
    ));
  } else {
    for (const item of material) {
      const issue = node("div", "issue");
      issue.append(node("span", "issue-icon", "!"));
      const copy = node("div");
      copy.append(
        node("strong", "", gapTitle(item)),
        node("p", "", briefGapExplanation(item))
      );
      // Fast-mode attribution is a share, not a yes/no, so this row carries
      // the four-way split rather than a bare status. The full sentence lives
      // with the preference control that changes it.
      if (item.id === "fast_mode") {
        copy.append(node(
          "p",
          "issue-detail",
          fastModeShortCoverage(accountingPeriod(data).fastMode)
        ));
      }
      issue.append(copy, node("span", "issue-priority", humanize(item.status ?? item.priority ?? "Open")));
      issueList.append(issue);
    }
  }

  $("#blind-spot-count").textContent = !issues.length
    ? ""
    : ranked.length > material.length
      ? `Showing the ${material.length} most material of ${ranked.length} gaps that change how the number should be read, from an inventory of ${issues.length}.`
      : `${ranked.length} of ${issues.length} inventory items change how the number should be read.`;
  const inventory = $("#blind-spot-inventory");
  clear(inventory);
  if (!issues.length) {
    inventory.append(node("div", "empty-inline", "No blind-spot inventory was returned."));
    return;
  }
  for (const item of issues) {
    const row = node("div", "inventory-row");
    row.append(
      node("strong", "", gapTitle(item)),
      node("span", "issue-priority", humanize(item.status ?? item.priority ?? "Open")),
      node("p", "", gapExplanation(item))
    );
    inventory.append(row);
  }
}

function renderReports(data) {
  const container = $("#report-links");
  clear(container);
  if (!data.reports.length) {
    container.append(node("span", "empty-inline", "No reports advertised by the local companion."));
    return;
  }
  for (const report of data.reports) {
    if (data.mode === "demo") {
      container.append(node("span", "report-link", `${report.title} · demo only`));
      continue;
    }
    const link = node("a", "report-link", report.title);
    link.href = report.href;
    link.target = "_blank";
    link.rel = "noopener";
    container.append(link);
  }
}

function renderCollector(data) {
  const collector = data.collector ?? {};
  const state = $("#collector-state");
  state.textContent = data.state === "live"
    ? "Current"
    : data.state === "offline" && data.mode !== "demo"
      ? "Ready to analyze"
      : humanize(data.state);
  state.className = `evidence-chip ${data.state === "live" ? "" : "neutral"}`;
  const rows = [
    ["Last analysis", formatLocal(collector.lastScanAt ?? data.activity?.lastScanAt ?? data.freshness.latestObservedAt)],
    ["Safe records", compact(collector.safeRecordCount ?? data.activity?.safeRecordCount ?? data.activity?.recordCount)],
    ["Covered from", collector.coveredAt?.startAt ? formatLocal(collector.coveredAt.startAt) : "Unavailable"],
    ["Covered through", collector.coveredAt?.endAt ? formatLocal(collector.coveredAt.endAt) : "Unavailable"],
    ["Contribution through", collector.exportableCoveredAt?.endAt
      ? formatLocal(collector.exportableCoveredAt.endAt)
      : "No rollout usage available"],
    ["Usage / quota rows", `${compact(collector.recordCounts?.usage)} / ${compact(collector.recordCounts?.quota)}`],
    ["Analysis state", humanize(collector.indexingState || "Unavailable")],
    ["Source bytes", "Not exposed to browser"],
    ["Identity", collector.identityMode ?? "Pseudonymous"]
  ];
  const dl = $("#collector-details");
  clear(dl);
  for (const [term, value] of rows) {
    const wrapper = node("div");
    wrapper.append(node("dt", "", term), node("dd", "", value));
    dl.append(wrapper);
  }
  renderIndexProgress(collector.indexing ?? null, {
    status: collector.indexing?.status ?? collector.indexingState
  });
}

function renderIndexProgress(progress, { status = "" } = {}) {
  const container = $("#index-progress");
  if (!container) return;
  if (!progress || typeof progress !== "object") {
    container.hidden = true;
    return;
  }
  const allowedPhases = new Set([
    "starting",
    "discovering",
    "rollout_index",
    "quick_result",
    "quota_refresh",
    "reloading",
    "complete",
    "paused",
    "prospective",
    "failed"
  ]);
  const phase = allowedPhases.has(progress.phase) ? progress.phase : "rollout_index";
  const filesSelected = Number.isSafeInteger(progress.filesSelected)
    && progress.filesSelected >= 0 ? progress.filesSelected : null;
  const filesProcessed = Number.isSafeInteger(progress.filesProcessed)
    && progress.filesProcessed >= 0 ? progress.filesProcessed : 0;
  const filesComplete = filesSelected !== null
    && filesSelected > 0
    && filesProcessed >= filesSelected;
  const recordsWritten = Number.isSafeInteger(progress.recordsWritten)
    && progress.recordsWritten >= 0 ? progress.recordsWritten : 0;
  const startAt = Number.isFinite(Date.parse(progress.coveredAt?.startAt))
    ? progress.coveredAt.startAt : "";
  const endAt = Number.isFinite(Date.parse(progress.coveredAt?.endAt))
    ? progress.coveredAt.endAt : "";
  const bar = $("#index-progress-bar");
  if (filesSelected !== null && filesSelected > 0) {
    bar.max = filesSelected;
    bar.value = Math.min(filesProcessed, filesSelected);
  } else {
    bar.max = 1;
    bar.removeAttribute("value");
  }
  $("#index-progress-title").textContent =
    status === "cancelled"
      ? "Local analysis cancelled"
      : status === "cancelling"
        ? "Stopping at a safe checkpoint"
      : phase === "quick_result"
        ? "Headline results are ready"
      : status === "recent_7d_complete"
      ? "Recent local history indexed"
      : status === "recent_7d_partial"
        ? "Useful recent history indexed"
      : status === "prospective_only"
        ? "Collecting new activity prospectively"
        : status === "bounded_pause"
          ? "Recent history analysis paused"
          : filesComplete && status === "running"
            ? "Calculating usage and allowance"
          : "Analyzing recent local history";
  $("#index-progress-phase").textContent = humanize(
    status === "cancelled"
      ? "cancelled"
      : status === "cancelling"
        ? "cancelling"
      : phase === "quick_result"
        ? "deeper accounting"
      : status === "recent_7d_complete"
      ? "complete"
      : filesComplete && status === "running"
        ? "finalizing"
        : phase
  );
  $("#index-progress-summary").textContent = status === "cancelled"
    ? "The analysis stopped without replacing verified existing results. Run it again whenever convenient."
    : status === "cancelling"
      ? "TiboTattle is finishing its current atomic step and preserving a resumable checkpoint."
    : phase === "quick_result"
      ? "Your headline local result is available. Deeper replay-safe cost accounting and weekly calibration are still finishing."
    : status === "prospective_only"
    ? `${compact(recordsWritten)} safe records retained since local collection began. Older activity was not retroactively indexed for this existing checkpoint.`
    : status === "recent_7d_partial"
      ? `${compact(recordsWritten)} safe records retained from a bounded recent tail. The analysis completed safely, but cannot prove it reached the entire requested seven-day window.`
      : filesSelected === null
        ? `${compact(recordsWritten)} safe records retained; discovering bounded recent rollouts.`
        : filesComplete && status === "running"
          ? `${compact(filesProcessed)} bounded rollout files are indexed. Replaying safe token increments, quota transitions, and the seven-day calibration now.`
          : `${compact(filesProcessed)} of ${compact(filesSelected)} bounded rollout files processed · ${compact(recordsWritten)} safe records retained.`;
  $("#index-progress-coverage").textContent = startAt && endAt
    ? `Content-free evidence currently covers ${formatLocal(startAt)} through ${formatLocal(endAt)}. Raw content and source paths never enter this page.`
    : "Raw log contents and source paths never enter this page.";
  container.hidden = false;
}

function renderAutomaticContributionStatus(status) {
  const value = status ?? {
    state: "unavailable",
    enabled: false,
    consentCurrent: false,
    firstReviewComplete: false,
    firstReviewedAcceptedAt: "",
    requiredConsent: null,
    lastAttemptAt: "",
    lastSuccessAt: "",
    nextAttemptAt: "",
    lastOutcome: null
  };
  automaticContributionStatus = value;
  const awaitingReviewedSend = Boolean(
    pendingAutomaticContributionConsent && !value.enabled
  );
  const labels = {
    unavailable: "Unavailable",
    not_configured: "Not configured",
    disabled: "Off",
    first_review_required: "First review needed",
    consent_required: "Consent needed",
    scheduled: "On",
    running: "Running now",
    paused: "Paused",
    failed: "Needs attention"
  };
  const chip = $("#automatic-contribution-state");
  chip.textContent = awaitingReviewedSend
    ? "Review first send"
    : labels[value.state] ?? "Unavailable";
  chip.className = ["scheduled", "running"].includes(value.state)
    ? "evidence-chip"
    : value.state === "failed"
      ? "evidence-chip error"
      : "evidence-chip neutral";

  const next = value.nextAttemptAt
    ? ` Next check ${formatLocal(value.nextAttemptAt)}.`
    : "";
  const last = value.lastSuccessAt
    ? ` Last contribution ${formatLocal(value.lastSuccessAt)}.`
    : "";
  const outcome = value.lastOutcome?.status === "failed"
    ? ` The last attempt needs attention (${value.lastOutcome.code.replaceAll("_", " ")}).`
    : "";
  const pausedDescriptions = {
    queue_paused:
      `Automatic contribution is stopped because the local queue is paused. No automatic retry is scheduled; inspect and resume the queue before continuing.${last}`,
    run_timeout:
      `Automatic contribution stopped after its five-minute abort deadline. No retry is scheduled; turn it off, inspect local status, and explicitly enable it again.${last}`,
    identity_unavailable:
      `Automatic contribution stopped because its local pseudonymous identity is unavailable. Nothing more is scheduled until the local identity is repaired and you explicitly enable it again.${last}`,
    privacy_verification_failed:
      `Automatic contribution stopped because the privacy verification failed. Nothing was inferred or retried; inspect the local result before explicitly enabling it again.${last}`,
    delivery_rejected:
      `Automatic contribution stopped because the service rejected part of the exact prepared set. No retry is scheduled; inspect the contribution status before explicitly enabling it again.${last}`,
    preparation_failed:
      `Automatic contribution stopped because local preparation or maintenance failed. No retry is scheduled; inspect local status before explicitly enabling it again.${last}`,
    upload_failed:
      `Automatic contribution stopped because delivery failed without a safe retry signal. No retry is scheduled; inspect local status before explicitly enabling it again.${last}`
  };
  const pausedDescription = pausedDescriptions[value.lastOutcome?.code]
    ?? `Automatic contribution is stopped and no retry is scheduled. Inspect the bounded last outcome before explicitly enabling it again.${last}${outcome}`;
  const descriptions = {
    unavailable:
      "Automatic contribution is unavailable in this app build. You can still prepare and send a reviewed contribution.",
    not_configured:
      "The contribution service is not configured in this app build. Nothing will be sent.",
    disabled:
      "Off until you explicitly consent. No daemon or login item is installed; checks run only while TiboTattle is open.",
    first_review_required:
      "Automatic contribution is off. Consent, inspect, and send one exact reviewed contribution before a recurring schedule can be enabled.",
    consent_required:
      "The metadata contract or destination changed. Review the current disclosure and consent again before anything is scheduled.",
    scheduled:
      `On. TiboTattle checks for new content-free pseudonymous metadata every 6 hours while the app is open.${last}${next}${outcome}`,
    running:
      `A bounded foreground contribution check is running now.${last}${next}`,
    paused: pausedDescription,
    failed:
      `Automatic contribution has stopped because its local settings are unavailable. No retry is scheduled; repair the local app state, then review the current consent before turning it on again.${last}${outcome}`
  };
  $("#automatic-contribution-description").textContent = awaitingReviewedSend
    ? "Consent is held only in this open tab. Automatic contribution remains off until your exact reviewed first send is accepted."
    : descriptions[value.state] ?? descriptions.unavailable;

  const toggle = $("#automatic-contribution-toggle");
  toggle.hidden = !value.enabled;
  toggle.disabled = automaticContributionBusy;
  toggle.textContent = automaticContributionBusy
    ? "Turning off…"
    : "Turn off automatic contribution";
  $("#contribution-not-now").hidden = value.enabled;
  updateCommunityConnectButton();
}

async function refreshAutomaticContributionStatus() {
  const status = await localClient.automaticContributionStatus();
  renderAutomaticContributionStatus(status);
  return status;
}

function renderContributionSyncStatus(status) {
  const value = status ?? {
    state: "unavailable",
    paused: null,
    counts: {
      pending: 0,
      inFlight: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0
    },
    nextAttemptAt: "",
    lastAcceptedAt: ""
  };
  const labels = {
    unavailable: "Queue unavailable",
    paused: "Queue paused",
    attention: "Needs attention",
    active: "Delivery active",
    idle: "Up to date",
    empty: "Nothing queued"
  };
  const chip = $("#sync-state");
  chip.textContent = labels[value.state] ?? "Queue unavailable";
  chip.className = ["active", "idle"].includes(value.state)
    ? "evidence-chip"
    : "evidence-chip neutral";
  const counts = value.counts;
  $("#sync-waiting").textContent = compact(counts.pending + counts.retryable);
  $("#sync-in-flight").textContent = compact(counts.inFlight);
  $("#sync-accepted").textContent = compact(counts.accepted);
  $("#sync-attention").textContent = compact(counts.retryable + counts.rejected);
  $("#sync-next-attempt").textContent = value.nextAttemptAt
    ? formatLocal(value.nextAttemptAt)
    : "None scheduled";
  $("#sync-last-accepted").textContent = value.lastAcceptedAt
    ? formatLocal(value.lastAcceptedAt)
    : "No accepted batch yet";
  const descriptions = {
    unavailable: "No verified local queue state is available. Nothing about a file, path, identity, origin, or credential is inferred.",
    paused: "Delivery is paused locally. Prepared batches remain content-free and will not be sent until you explicitly resume.",
    attention: "At least one batch is waiting for a retry or was rejected. Use the local status command for bounded counts; it does not print paths or identifiers.",
    active: "Committed privacy-safe batches are waiting, retrying, or currently leased to the foreground sender.",
    idle: "Every discovered committed batch has been accepted or replayed, and no retry is due.",
    empty: "No committed privacy-safe prepared set has entered this queue yet."
  };
  $("#sync-description").textContent = descriptions[value.state]
    ?? descriptions.unavailable;
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
    `${item.accounting.estimatedApiCostUsd === null ? "Unpriced" : `$${item.accounting.estimatedApiCostUsd}`} · ${item.accounting.pricedEventCoveragePercent}% priced`;
  $("#sync-next-bytes").textContent =
    `${compact(item.reservedUploadBytes)} bytes reserved (${compact(item.preparedBytes)} prepared)`;
  updateContributionSyncButtons();
}

function updateContributionSyncButtons() {
  const available = contributionSyncPreview?.status === "available";
  const paused = contributionSyncStatus?.paused === true;
  $("#sync-inspect").disabled = contributionSyncBusy;
  $("#sync-run-once").disabled = contributionSyncBusy
    || !available
    || contributionSyncPreview?.deliveryConfigured !== true
    || contributionSyncPreview?.state !== "ready"
    || contributionSyncExactReview?.state !== "ready"
    || paused;
  $("#sync-pause").disabled = contributionSyncBusy
    || !available
    || contributionSyncStatus?.state === "unavailable"
    || paused;
  $("#sync-resume").disabled = contributionSyncBusy
    || !available
    || contributionSyncStatus?.state === "unavailable"
    || !paused;
}

function showContributionSyncAction(message, error = false) {
  const status = $("#sync-action-status");
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
  $("#sync-exact-review").hidden = true;
  $("#sync-exact-review-json").textContent = "";
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
  $("#sync-exact-review-json").textContent = JSON.stringify(value.payload, null, 2);
  $("#sync-exact-review-state").textContent =
    `Verified · ${compact(value.payloadBytes)} bytes`;
  $("#sync-exact-review").hidden = false;
}

async function refreshContributionSyncControls() {
  clearContributionSyncExactReview();
  // Preview discovery commits newly prepared sets to the queue. Read queue
  // status afterwards so the two cards describe the same durable state.
  const preview = await localClient.contributionSyncPreview();
  const [status, automatic] = await Promise.all([
    localClient.contributionSyncStatus(),
    localClient.automaticContributionStatus()
  ]);
  renderContributionSyncStatus(status);
  renderContributionSyncPreview(preview);
  renderAutomaticContributionStatus(automatic);
}

async function runContributionSyncAction(action) {
  if (contributionSyncBusy) return;
  contributionSyncBusy = true;
  let acceptedContribution = false;
  updateContributionSyncButtons();
  showContributionSyncAction(
    action === "run"
      ? "Running one bounded foreground pass…"
      : action === "pause" ? "Pausing local delivery…" : "Resuming local delivery…"
  );
  try {
    if (action === "run") {
      if (contributionSyncExactReview?.state !== "ready") {
        throw new Error("exact review required");
      }
      const gate = await runReviewedContributionGate({
        reviewToken: contributionSyncExactReview.reviewToken,
        hasPendingAutomaticConsent:
          Boolean(pendingAutomaticContributionConsent),
        runReviewedSend: (reviewToken) =>
          localClient.runContributionSyncOnce(reviewToken),
        enableAutomaticContribution:
          enableAutomaticContributionAfterReviewedSend
      });
      const { result } = gate;
      if (result.status === "unavailable") throw new Error("sync unavailable");
      const outcome = contributionSyncPassResult(result);
      acceptedContribution = gate.accepted;
      showContributionSyncAction(outcome.message, outcome.needsAttention);
      if (acceptedContribution && pendingAutomaticContributionConsent) {
        if (gate.automaticError === null) {
          showContributionSyncAction(
            `${outcome.message} Automatic contribution is now on every 6 hours while TiboTattle is open.`
          );
          renderAutomaticContributionStatus(gate.automatic);
        } else {
          const firstReviewNotConfirmed =
            gate.automaticError?.code
              === "automatic_contribution_first_review_required";
          showContributionSyncAction(
            firstReviewNotConfirmed
              ? `${outcome.message} Automatic contribution remains off because the local companion did not confirm the exact reviewed-send gate. Consent is retained only in this tab; inspect and send again to retry.`
              : `${outcome.message} The reviewed contribution was accepted, but automatic contribution could not be enabled. It remains off; consent is retained only in this tab so you can retry.`,
            true
          );
        }
      }
    } else {
      const status = await localClient.setContributionSyncPaused(action === "pause");
      if (status.state === "unavailable") throw new Error("control unavailable");
      showContributionSyncAction(
        action === "pause" ? "Local delivery is paused." : "Local delivery is resumed."
      );
    }
    await refreshContributionSyncControls();
    if (acceptedContribution) await loadCommunityResults();
  } catch (error) {
    // A leftover device credential stops delivery for a precisely known local
    // reason with its own repair, so it is answered where the user can act on
    // it rather than folded into the generic queue message.
    if (contributionDeviceRecoveryIsRequired(error)) {
      renderContributionDeviceRecovery($("#community-connect-status"), {
        error
      });
      showContributionSyncAction(
        "Delivery stopped because this Mac has a leftover device credential. Durable queue state was retained; the repair is offered above.",
        true
      );
    } else {
      showContributionSyncAction(describeFailure({
        surface: "contribution_send",
        error,
        fallback:
          "The local companion rejected or could not complete this action. Durable queue state was retained."
      }).text, true);
    }
  } finally {
    contributionSyncBusy = false;
    updateContributionSyncButtons();
  }
}

async function inspectNextContribution() {
  contributionSyncBusy = true;
  $(".sync-status-panel").open = true;
  updateContributionSyncButtons();
  showContributionSyncAction(
    "Inspecting content-free pseudonymous metadata through loopback; no service request or upload is performed."
  );
  try {
    await refreshContributionSyncControls();
    const review = await localClient.contributionSyncExactReview();
    renderContributionSyncExactReview(review);
    $("#sync-exact-review").open = false;
    showContributionSyncAction(
      "Review the concise coverage and record totals above. Expand the exact JSON if wanted, then confirm the first send."
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

async function loadLocalDashboard() {
  const previousBusy = localActionBusy;
  localActionBusy = true;
  const button = $("#refresh-button");
  button.textContent = "Connecting…";
  updateLocalActionButtons();
  try {
    const syncState = (async () => {
      const [preview, status, automatic] = await Promise.all([
        localClient.contributionSyncPreview(),
        localClient.contributionSyncStatus(),
        localClient.automaticContributionStatus()
      ]);
      return { preview, status, automatic };
    })();
    const [data, sync, localHealth, onboarding, speedPreference] = await Promise.all([
      localClient.load(),
      syncState,
      localClient.health().catch(() => null),
      localClient.onboarding(),
      localClient.fastModePreference()
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
    renderAutomaticContributionStatus(sync.automatic);
    renderLocalOnboarding(onboarding);
  } catch {
    const [localHealth, backendHealth, onboarding] = await Promise.all([
      localClient.health().catch(() => null),
      communityClient.health().catch(() => null),
      localClient.onboarding().catch(() => null),
    ]);
    localCompanionHealth = localHealth;
    renderHostedIdentity();
    const backendOnly = localHealth === null
      && backendHealth?.checks?.database === "ok";
    dashboard = null;
    renderContributionSyncStatus(null);
    renderContributionSyncPreview(null);
    renderAutomaticContributionStatus(null);
    renderPreparationIdentity(null);
    renderLocalOnboarding(onboarding);
    setGlobalState("offline");
    $("#latest-observation").textContent = backendOnly
      ? "Backend-only origin"
      : "Companion unavailable";
    $("#data-source").textContent = "No real usage is displayed";
    showConnectionNotice({
      title: backendOnly
        ? "This address is the backend-only service"
        : localHealth
          ? "The companion could not load the local dashboard"
          : "The local companion is not available",
      copy: backendOnly
        ? "This service accepts optional community requests but cannot read this Mac. Open TiboTattle from Applications and use the separate local dashboard tab it opens."
        : localHealth
          ? "The Mac app is running, but its local dashboard could not be loaded. Quit and reopen TiboTattle, press Open Dashboard, then check again."
          : "Open TiboTattle from Applications, wait for Ready, then press Open Dashboard. If no installer is published below, this build is not yet available for a new installation.",
      kind: "error",
      showDemo: true,
      showCheck: true,
    });
    renderDashboardSkeleton();
  } finally {
    localActionBusy = previousBusy;
    updateLocalActionButtons();
  }
}

function renderPreparationIdentity(health) {
  const chip = $("#preparation-identity");
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
  header.append(node("span", "metric-name", "No local evidence"), node("span", "evidence-chip", "Offline"));
  card.append(header, node("strong", "metric-value", "—"), node("p", "", "This empty state is intentional. Demo values are never substituted automatically."));
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
  button.textContent = "Starting local analysis…";
  updateLocalActionButtons();
  setGlobalState("updating");
  renderIndexProgress({
    phase: "starting",
    filesSelected: null,
    filesProcessed: 0,
    recordsWritten: 0,
    coveredAt: { startAt: "", endAt: "" }
  }, { status: "running" });
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
      if (progress) renderIndexProgress(progress, { status: outcome });
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
        title: "Deep analysis stopped at a safety limit",
        copy: "Your available headline and previously verified results remain usable. TiboTattle stopped before reading or retaining more local data than its fixed safety limits allow; no partial accounting result replaced them.",
        kind: "warning",
      });
      return;
    }
    if (outcome !== "succeeded") throw new Error("The local refresh did not complete successfully.");
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
    "The sign-in could not be verified by the contribution service. Sign in again, then retry. Nothing was uploaded.",
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

// One precisely known local fault: this Mac still holds a contribution-device
// secret in its Keychain, but the local record that pairs that secret with the
// service is gone — typically a leftover from an earlier install. It cannot be
// read or replaced in that state. Nothing about the invitation, the network,
// or the service is wrong, so the copy must not send the user to look at them.
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
  ATTEMPT_LIMIT_REACHED:
    "Too many attempts were made in a short window. Wait a few minutes before trying again. Nothing was uploaded.",
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
    "The contribution service did not accept this Mac's upload device. Reset this Mac's device credential below, then connect again. Nothing was uploaded.",
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
  contribution_device_recovery_required: CONTRIBUTION_DEVICE_CONFLICT_COPY,
  contribution_device_credential_conflict: CONTRIBUTION_DEVICE_CONFLICT_COPY,
  contribution_device_pairing_not_configured:
    "This build is not configured to connect to a contribution service, so there is nothing to pair with. Local reporting is unaffected.",
  contribution_device_pairing_failed:
    "The contribution service did not complete device pairing. Nothing was uploaded; try again shortly.",
  automatic_contribution_first_review_required:
    "One contribution must be reviewed and accepted before automatic contribution can be armed. Nothing repeats until then.",
  automatic_contribution_not_configured:
    "This build has no contribution service configured, so automatic contribution cannot be armed.",
  automatic_contribution_consent_binding_mismatch:
    "The stored consent no longer matches the contract this build would send. Reload the local dashboard and consent again; nothing repeats until then.",
  automatic_contribution_settings_unavailable:
    "The local companion could not read or write the automatic-contribution setting. No setting was inferred.",
  device_credential_reset_failed:
    "The leftover device credential could not be cleared. Nothing was deleted on this Mac or in the service.",
  device_credential_reset_not_authorized:
    "The local companion refused this request because it did not arrive from the local dashboard. Nothing was deleted.",
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
 * user typed or the service returned. It is filed in the local diagnostics log
 * alongside the fixed error code and, when the service supplied one, its own
 * request id — so a support conversation can join both sides. The sentence
 * itself always comes from a map written here or from the caller's fallback;
 * no server string is ever rendered.
 */
function describeFailure({ surface, error, messages = {}, fallback }) {
  const reference = createDiagnosticReference();
  const code = diagnosticErrorCode(error?.code);
  const requestId = serviceRequestId(error?.requestId);
  // Filed without blocking the message: the user must still be told what
  // happened even when the companion cannot write its log.
  void localClient.recordDiagnosticNote({
    reference,
    surface: diagnosticSurface(surface),
    code,
    requestId
  }).catch(() => {});
  const explanation = fixedCopy(messages, code)
    ?? fixedCopy(SERVICE_ERROR_COPY, code)
    ?? fixedCopy(LOCAL_COMPANION_ERROR_COPY, code)
    ?? fallback;
  const trailer = diagnosticReferenceSentence({ reference, requestId });
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
function showFailure(status, options) {
  const described = describeFailure(options);
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
function hostedSignInRequired() {
  return configuredGoogleClientId() !== null && hostedIdentity === null;
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
  const chip = $("#identity-signin-state");
  const googleUnavailable = $("#identity-google-unavailable");
  const appleUnavailable = $("#identity-apple-unavailable");
  // Both providers complete through the contribution service: Google needs it
  // to exchange its authorization code, Apple needs it to start and claim the
  // hosted flow. A build with no service configured therefore cannot sign in
  // at all, so the controls say so instead of failing after the click.
  const serviceConfigured =
    localCompanionHealth?.capabilities?.contributionDevicePairing === true;
  const googleConfigured = configuredGoogleClientId() !== null
    && serviceConfigured;
  const signedIn = hostedIdentity !== null;
  const provider = HOSTED_IDENTITY_PROVIDERS[hostedIdentity?.provider]
    ?? HOSTED_IDENTITY_PROVIDERS.google;
  googleButton.disabled = hostedIdentityBusy
    || signedIn
    || !googleConfigured;
  googleUnavailable.hidden = googleConfigured || signedIn;
  googleUnavailable.textContent = serviceConfigured
    ? "Hosted sign-in is not configured for this build."
    : "This build has no contribution service, so hosted sign-in is unavailable.";
  const appleUnavailableNow = appleSignInUnavailable || !serviceConfigured;
  appleUnavailable.hidden = !appleUnavailableNow || signedIn;
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
  $("#identity-account-provider").textContent = provider.label;
  $("#identity-account-mark").setAttribute("href", provider.mark);
  chip.textContent = signedIn
    ? "Signed in"
    : hostedIdentityBusy ? "Signing in…" : "Not signed in";
  chip.className = signedIn
    ? "evidence-chip"
    : "evidence-chip neutral";
  updateCommunityConnectButton();
}

// Signing out is entirely page-local. The sign-in token was never persisted,
// so forgetting it needs no network call and destroys no hosted data; the
// pseudonymous session is dropped alongside it so the next sign-in — with the
// same account or a different one — enrolls under the identity just presented
// rather than reusing the previous participant's session.
function signOutHostedIdentity() {
  if (hostedIdentityBusy || hostedIdentity === null) return;
  hostedIdentity = null;
  pendingGoogleSignIn = null;
  setCommunitySession(null);
  $("#participant-controls").hidden = true;
  const status = $("#identity-signin-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent =
    "Signed out on this page only. The in-memory sign-in was discarded and nothing was deleted: metadata you already contributed is unchanged, and Hosted privacy controls still export or delete it. Sign in again with any Google or Apple account.";
  renderHostedIdentity();
}

async function beginGoogleSignIn() {
  if (hostedIdentityBusy || hostedIdentity !== null) return;
  const clientId = configuredGoogleClientId();
  if (clientId === null) return;
  const status = $("#identity-signin-status");
  hostedIdentityBusy = true;
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  try {
    const request = await createGoogleSignInRequest({
      clientId,
      redirectUri: `${window.location.origin}/oauth/google/callback`
    });
    pendingGoogleSignIn = request;
    // `window.open` always resolves to null when "noopener" is requested, so
    // its result cannot report whether the tab opened. Keep the isolation and
    // tell the user what to do if no tab appears instead.
    window.open(request.url, "_blank", "noopener,noreferrer");
    status.textContent =
      "Finish signing in with Google in the new tab, then return here. If no tab opened, allow pop-ups for this local dashboard and try again. Only the openid scope is requested; no email or name is asked for.";
  } catch (error) {
    showFailure(status, {
      surface: "hosted_identity",
      error,
      fallback: error instanceof Error && error.status === undefined
        ? error.message
        : "Google sign-in could not be started."
    });
  } finally {
    hostedIdentityBusy = false;
    renderHostedIdentity();
  }
}

async function completeGoogleSignIn(serialized) {
  const pending = pendingGoogleSignIn;
  if (pending === null || hostedIdentityBusy || hostedIdentity !== null) return;
  const status = $("#identity-signin-status");
  hostedIdentityBusy = true;
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Completing Google sign-in…";
  try {
    const result = parseGoogleSignInResult(serialized, {
      expectedState: pending.state
    });
    hostedIdentity = await communityClient.identityGoogleExchange({
      code: result.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri
    });
    pendingGoogleSignIn = null;
    status.textContent =
      "Signed in with Google. The sign-in token stays in this tab's memory; the service keeps only an irreversible hash, never your email or name.";
  } catch (error) {
    showFailure(status, {
      surface: "hosted_identity",
      error,
      fallback: hostedIdentityErrorCopy(error)
        ?? (error instanceof Error && error.status === undefined
          ? error.message
          : "Google sign-in could not be completed. Sign in again.")
    });
  } finally {
    hostedIdentityBusy = false;
    renderHostedIdentity();
  }
}

const APPLE_SIGNIN_POLL_ATTEMPTS = 30;
const APPLE_SIGNIN_POLL_INTERVAL_MS = 2_000;

// Hosted Sign in with Apple. The native path is impossible: Apple provisions
// the Sign in with Apple entitlement only for Ad hoc, App Store Connect, and
// Development distribution, so a Developer ID build carrying it is terminated
// at launch. Apple also rejects loopback redirects and answers with
// response_mode=form_post, so the contribution service owns the redirect and
// the client secret; this page opens the authorize URL and then polls for the
// one-time result keyed by the unguessable state it was given.
async function beginAppleSignIn() {
  if (hostedIdentityBusy || hostedIdentity !== null) return;
  const status = $("#identity-signin-status");
  hostedIdentityBusy = true;
  renderHostedIdentity();
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Starting Apple sign-in…";
  try {
    const request = await communityClient.identityAppleStart();
    // Opened with noopener so the Apple tab gets no handle on this one. That
    // makes the return value null by specification, so it is not a usable
    // signal for a blocked pop-up; the waiting copy says so instead, and an
    // unopened tab simply runs out the bounded poll below.
    window.open(request.authorizeUrl, "_blank", "noopener,noreferrer");
    status.textContent =
      "Finish signing in with Apple in the new tab, then return here. No name or email is requested. If no tab opened, allow pop-ups for this dashboard and try again.";
    for (let attempt = 0; attempt < APPLE_SIGNIN_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolveWait) => {
        window.setTimeout(resolveWait, APPLE_SIGNIN_POLL_INTERVAL_MS);
      });
      let identity = null;
      try {
        identity = await communityClient.identityAppleResult(request.state);
      } catch (error) {
        if (error?.code !== "IDENTITY_RESULT_PENDING") throw error;
      }
      if (identity !== null) {
        hostedIdentity = identity;
        status.textContent =
          "Signed in with Apple. The sign-in token stays in this tab's memory; the service keeps only an irreversible hash, never your email or name.";
        return;
      }
    }
    // A bounded poll that ran out is still a failed action from the user's
    // side, so it is referenced and logged like any other.
    showFailure(status, {
      surface: "hosted_identity",
      error: null,
      fallback:
        "Apple sign-in did not finish in time. Nothing was stored. Press Sign in with Apple again to start a fresh sign-in."
    });
  } catch (error) {
    const unconfigured = error?.code === "IDENTITY_CONFIGURATION_INVALID";
    if (unconfigured) appleSignInUnavailable = true;
    showFailure(status, {
      surface: "hosted_identity",
      error,
      messages: unconfigured
        ? {
          IDENTITY_CONFIGURATION_INVALID:
            "Hosted Apple sign-in is not configured for this build."
        }
        : {},
      fallback: hostedIdentityErrorCopy(error)
        ?? (error instanceof Error && error.status === undefined
          ? error.message
          : "Apple sign-in could not be completed. Sign in again.")
    });
  } finally {
    hostedIdentityBusy = false;
    renderHostedIdentity();
  }
}

function updateCommunityConnectButton() {
  const button = $("#connect-community");
  const consent = $("#community-connect-consent");
  const awaitingReviewedSend = Boolean(pendingAutomaticContributionConsent);
  consent.disabled = automaticContributionStatus?.enabled
    || awaitingReviewedSend;
  button.disabled = communityConnectBusy
    || automaticContributionBusy
    || automaticContributionStatus?.enabled
    || awaitingReviewedSend
    || hostedSignInRequired()
    || !consent.checked;
  if (!communityConnectBusy) {
    button.textContent = awaitingReviewedSend
      ? "Review first contribution below"
      : automaticContributionStatus?.enabled
      ? "Automatic contribution is on"
      : hostedSignInRequired()
      ? "Sign in above to contribute"
      : "Contribute and keep it current";
  }
}

// The local capability layer raises contribution_device_credential_conflict;
// the companion projects it onto contribution_device_recovery_required at its
// HTTP boundary. Both name the same leftover credential, so both take the same
// honest explanation and the same in-page repair.
function contributionDeviceRecoveryIsRequired(error) {
  try {
    return error?.code === "contribution_device_recovery_required"
      || error?.code === "contribution_device_credential_conflict";
  } catch {
    return false;
  }
}

/**
 * Explain the leftover-credential fault and offer the one action that fixes it.
 *
 * This replaces a generic "check the service and Keychain" message with the
 * actual cause, and is the only place the reset control appears: it is shown
 * when, and only when, a credential conflict was actually detected.
 */
function renderContributionDeviceRecovery(status, { error } = {}) {
  const described = describeFailure({
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
  const action = node(
    "a",
    "button button-secondary",
    "Open TiboTattle"
  );
  if (SEMANTIC_OPEN_TARGET) {
    action.href = SEMANTIC_OPEN_TARGET;
  } else {
    action.hidden = true;
  }
  const actions = node("div", "contribution-cta-buttons");
  actions.append(reset, action);
  // Reachable from journeys that never revealed this element, so it un-hides
  // itself rather than relying on the caller having done so.
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
      "Resetting clears only that unusable local credential and its local record. Metadata you already contributed is untouched, no hosted device is revoked, and the TiboTattle app's Data & Diagnostics… menu offers the same repair natively."
    ),
    actions
  );
  return described;
}

const DEVICE_CREDENTIAL_RESET_CONFIRMATION =
  "Clear this Mac's unusable contribution-device credential?\n\nThis deletes only the leftover credential in this Mac's Keychain and the local record that went with it. Metadata you already contributed is not deleted, no hosted device is revoked, and your local reporting is unchanged.";

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
      ? "No leftover device credential was present on this Mac, so nothing was deleted. Choose Contribute and keep it current to connect."
      : "The leftover device credential was cleared. Metadata you already contributed is untouched. Choose Contribute and keep it current to connect this Mac again.";
  } catch (error) {
    showFailure(status, {
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
    throw new Error("The service did not return a one-use pairing capability.");
  }
  const paired = await localClient.pairContributionDevice(pairing.pairingCode);
  if (paired.status !== "paired") {
    throw new Error("The local app did not accept the upload-only pairing.");
  }
  status.textContent =
    `This Mac is connected through ${formatLocal(paired.expiresAt)}. Nothing was uploaded.`;
  return paired;
}

function openContributionReview() {
  const disclosure = $("#community-contribution-disclosure");
  disclosure.open = true;
  const queue = $(".sync-status-panel");
  queue.open = true;
}

function automaticContributionConsentBinding(status) {
  const required = status?.requiredConsent;
  return required?.destinationOrigin
    ? Object.freeze({
        telemetrySchemaVersion: required.telemetrySchemaVersion,
        fieldDictionaryVersion: required.fieldDictionaryVersion,
        privacyContractVersion: required.privacyContractVersion,
        destinationOrigin: required.destinationOrigin
      })
    : null;
}

async function armAutomaticContributionAfterReviewedSend() {
  let current = automaticContributionStatus;
  if (!current || current.state === "unavailable") {
    current = await refreshAutomaticContributionStatus();
  }
  if (current.enabled) {
    pendingAutomaticContributionConsent = null;
    return current;
  }
  const binding = automaticContributionConsentBinding(current);
  if (!binding) {
    throw new Error("Automatic contribution is not configured.");
  }
  pendingAutomaticContributionConsent = binding;
  renderAutomaticContributionStatus(current);
  return current;
}

async function enableAutomaticContributionAfterReviewedSend() {
  const binding = pendingAutomaticContributionConsent;
  if (!binding) {
    throw new Error("No live automatic-contribution consent is pending.");
  }
  automaticContributionBusy = true;
  renderAutomaticContributionStatus(automaticContributionStatus);
  try {
    const enabled = await localClient.enableAutomaticContribution(
      binding
    );
    if (!enabled.enabled) {
      throw new Error("Automatic contribution was not enabled.");
    }
    pendingAutomaticContributionConsent = null;
    renderAutomaticContributionStatus(enabled);
    return enabled;
  } finally {
    automaticContributionBusy = false;
    renderAutomaticContributionStatus(automaticContributionStatus);
  }
}

async function disableAutomaticContribution() {
  if (automaticContributionBusy) return;
  const status = $("#community-connect-status");
  automaticContributionBusy = true;
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Turning off automatic contribution…";
  renderAutomaticContributionStatus(automaticContributionStatus);
  try {
    const disabled = await localClient.disableAutomaticContribution();
    if (disabled.state === "unavailable" || disabled.enabled) {
      throw new Error("Automatic contribution did not turn off.");
    }
    pendingAutomaticContributionConsent = null;
    renderAutomaticContributionStatus(disabled);
    status.textContent =
      "Automatic contribution is off. Already accepted metadata is unchanged; use Hosted privacy controls if you want it deleted.";
  } catch (error) {
    showFailure(status, {
      surface: "automatic_contribution",
      error,
      fallback:
        "Automatic contribution could not be turned off. No setting was inferred; check the local companion and try again."
    });
  } finally {
    automaticContributionBusy = false;
    renderAutomaticContributionStatus(automaticContributionStatus);
  }
}

async function connectCommunityContribution() {
  if (communityConnectBusy) return;
  const status = $("#community-connect-status");
  if (hostedSignInRequired()) {
    status.hidden = false;
    status.className = "participant-action-status error";
    status.textContent =
      "Sign in first: hosted participation requires Google or Apple sign-in above. Local-only use needs no account, and nothing was uploaded.";
    return;
  }
  let pairing = null;
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
      // Production enrollment is open, so this page never collects or sends an
      // invitation code. The client keeps the parameter because the service
      // still supports an invite-only mode for private pilots.
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
      // The ordinary contribution product has no recovery journey. The server
      // still returns this legacy capability, but the browser intentionally
      // neither displays nor persists it.
      void enrollment.recoveryCode;
      pairing = enrollment.pairing;
      await finishCommunityDevicePairing(pairing, status);
    }
    let automatic = automaticContributionStatus;
    let automaticArmFailed = false;
    try {
      automatic = await armAutomaticContributionAfterReviewedSend();
    } catch {
      automaticArmFailed = true;
      await refreshAutomaticContributionStatus();
      automatic = automaticContributionStatus;
    }
    $("#community-connect-consent").checked = false;
    openContributionReview();
    await Promise.all([
      refreshContributionSyncControls(),
      loadCommunityResults(),
    ]);
    status.textContent = automatic?.enabled
      ? "Connected. Automatic contribution was already on."
      : automaticArmFailed
        ? "Connected for a reviewed contribution, but recurring consent could not be armed. Nothing will repeat unless you consent and try again."
        : "Connected. Review and send the first contribution below. Automatic contribution remains off until that exact reviewed send is accepted.";
    await prepareLocalContribution();
    if (contributionSyncPreview?.state === "ready") {
      await inspectNextContribution();
    }
  } catch (error) {
    if (contributionDeviceRecoveryIsRequired(error)) {
      renderContributionDeviceRecovery(status, { error });
    } else {
      // The fallback is reached only when the cause is genuinely unknown, so
      // it must not assert which of several unrelated things to go and check.
      showFailure(status, {
        surface: "contribution_connect",
        error,
        fallback:
          "This Mac could not be connected, and no evidence was uploaded. The cause was not reported in a form this page can explain; retrying is safe."
      });
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
    status.textContent = describeFailure({
      surface: "contribution_prepare",
      error,
      messages: preparationMessages,
      fallback:
        "A privacy-verified contribution could not be prepared. No upload occurred and incomplete staging is ignored by the queue."
    }).text;
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

function parseSafeExport(file) {
  if (!file || file.size > 1_310_720) throw new Error("Choose a JSON export no larger than 1.25 MB.");
  if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
    throw new Error("Choose the JSON export produced by TiboTattle.");
  }
  return file.text().then((content) => {
    let payload;
    try {
      payload = parseJsonWithUniqueObjectKeys(content);
    } catch (error) {
      if (error?.code === "duplicate_json_object_key") {
        throw new Error("The selected file contains duplicate JSON object keys.");
      }
      throw new Error("The selected file is not valid JSON.");
    }
    validateContributionForUpload(payload);
    return payload;
  });
}

function resetSelectedContributionInspection() {
  selectedContributionValidated = false;
  $("#selected-contribution-inspection").hidden = true;
  $("#selected-contribution-state").textContent = "Not validated";
  $("#selected-contribution-state").className = "evidence-chip neutral";
  $("#selected-contribution-message").textContent =
    "Choose a TiboTattle export to validate it locally.";
  $("#selected-contribution-schema").textContent = "—";
  $("#selected-contribution-bytes").textContent = "—";
  $("#selected-contribution-usage").textContent = "—";
  $("#selected-contribution-quota").textContent = "—";
  $("#selected-contribution-json").textContent = "";
}

function renderSelectedContributionInspection(file, payload) {
  const usageRows = Array.isArray(payload.usageEvents)
    ? payload.usageEvents.length
    : 0;
  const quotaRows = Array.isArray(payload.quotaSnapshots)
    ? payload.quotaSnapshots.length
    : 0;
  selectedContributionValidated = true;
  $("#selected-contribution-inspection").hidden = false;
  $("#selected-contribution-state").textContent = "Validated locally";
  $("#selected-contribution-state").className = "evidence-chip";
  $("#selected-contribution-message").textContent =
    "The closed-schema browser preflight passed. Expand the review below before consenting.";
  $("#selected-contribution-schema").textContent = payload.schemaVersion;
  $("#selected-contribution-bytes").textContent =
    `${new Intl.NumberFormat("en-US").format(file.size)} bytes`;
  $("#selected-contribution-usage").textContent = compact(usageRows);
  $("#selected-contribution-quota").textContent = compact(quotaRows);
  $("#selected-contribution-json").textContent = JSON.stringify(payload, null, 2);
}

function renderSelectedContributionError(error) {
  selectedContributionValidated = false;
  $("#selected-contribution-inspection").hidden = false;
  $("#selected-contribution-state").textContent = "Rejected locally";
  $("#selected-contribution-state").className = "evidence-chip error";
  $("#selected-contribution-message").textContent =
    error instanceof Error
      ? error.message
      : "The selected file did not pass the closed-schema browser preflight.";
  $("#selected-contribution-schema").textContent = "Not accepted";
  $("#selected-contribution-bytes").textContent = "—";
  $("#selected-contribution-usage").textContent = "—";
  $("#selected-contribution-quota").textContent = "—";
  $("#selected-contribution-json").textContent = "";
}

async function ensureCommunitySession(contributionSchemaVersion) {
  const requiredConsent = contributionSchemaVersion === "telemetry-contribution-v0.2"
    ? "privacy-safe-telemetry-v0.2"
    : "privacy-safe-telemetry-v0.1";
  if (communitySession?.csrfToken) {
    if (communitySession.consentVersion !== requiredConsent) {
      throw new Error(
        `This browser session accepted ${communitySession.consentVersion || "an older consent contract"}. Reload the local dashboard before using a different contribution contract.`
      );
    }
    return communitySession;
  }
  if (hostedSignInRequired()) {
    throw new Error(
      "Sign in first: hosted participation requires Google or Apple sign-in above. Local-only use needs no account."
    );
  }
  let enrollment;
  try {
    // No invitation code is collected: production enrollment is open, and the
    // service remains the authority on whether it accepts a new participant.
    enrollment = await communityClient.enroll(
      null,
      contributionSchemaVersion,
      { identity: hostedIdentity }
    );
  } catch (error) {
    const identityCopy = hostedIdentityErrorCopy(error);
    if (identityCopy !== null) throw new Error(identityCopy);
    throw error;
  }
  if (typeof enrollment?.csrfToken !== "string") {
    throw new Error("The contribution service did not establish a pseudonymous contribution session.");
  }
  setCommunitySession({
    csrfToken: enrollment.csrfToken,
    participantId: enrollment.participantId ?? null,
    consentVersion: requiredConsent
  });
  // Recovery is intentionally absent from the ordinary product. Do not display
  // or persist this legacy server capability.
  void enrollment.recoveryCode;
  return communitySession;
}

async function submitContribution(event) {
  event.preventDefault();
  const file = $("#contribution-file").files[0];
  const status = $("#upload-status");
  const button = $("#contribution-submit");
  status.hidden = false;
  status.className = "upload-status";
  status.textContent = "Validating the privacy-safe export in this browser…";
  button.disabled = true;
  try {
    const payload = await parseSafeExport(file);
    await ensureCommunitySession(payload.schemaVersion);
    status.textContent = "Encrypting the validated export in this browser…";
    const key = await communityClient.envelopeKey();
    if (key?.algorithm && key.algorithm !== "RSA-OAEP-256") throw new Error("The server offered an unsupported envelope algorithm.");
    const envelope = await createTelemetryEnvelope({
      payload,
      publicJwk: key.publicJwk,
      keyId: key.keyId
    });
    const serializedEnvelope = JSON.stringify(envelope);
    const contentLengthBytes = new TextEncoder().encode(serializedEnvelope).byteLength;
    const envelopeDigest = await sha256Hex(serializedEnvelope);
    status.textContent = "Registering a one-use authorization for this exact encrypted envelope…";
    const registration = await communityClient.registerUpload({
      envelopeDigest,
      contentLengthBytes,
      contentType: "application/json"
    });
    if (typeof registration?.uploadAuthorization !== "string") {
      throw new Error("The service did not return a one-use upload authorization.");
    }
    status.textContent = "Submitting encrypted telemetry for immediate server-side validation…";
    const receipt = await communityClient.contributeSerialized(
      serializedEnvelope,
      registration.uploadAuthorization
    );
    setCommunitySession({ ...communitySession, contributionId: receipt.contributionId });
    status.textContent = `Accepted as ${receipt.contributionId}. The server reported ${compact(receipt.recordCounts?.deduplicated ?? 0)} deduplicated records.`;
    await loadCommunityResults();
  } catch (error) {
    showFailure(status, {
      surface: "contribution_send",
      error,
      statusClass: "upload-status",
      // A rejection this page raised itself carries copy written here; a
      // transport rejection carries only a status line, which is not copy.
      fallback: error instanceof Error && error.status === undefined
        ? error.message
        : safeApiError(error, "The contribution was rejected.")
    });
  } finally {
    button.disabled = !(
      selectedContributionValidated
      && $("#contribution-consent").checked
      && $("#contribution-file").files.length
    );
  }
}

function renderPersonalStats(container, payload) {
  clear(container);
  const stats = normalizeParticipantStats(payload);
  if (stats.state === "service_unavailable") {
    container.append(node("p", "", "No personal result is available."));
    return;
  }
  if (stats.state === "unsupported_schema") {
    container.append(node(
      "p",
      "result-state result-state-warning",
      `The service returned ${stats.schemaVersion || "an unknown schema"}, not participant-stats-v0.2. No personal values were displayed.`
    ));
    return;
  }

  const source = stats.totals;
  const grid = node("div", "result-metrics");
  const metrics = [
    ["Safe usage events", source.usageEvents, compact],
    ["Server-repriced API equivalent", source.apiPriceEquivalentUsd, formatApiMoney],
    ["Quota snapshots", source.quotaSnapshots, compact]
  ];
  for (const [label, value, formatter] of metrics) {
    const card = node("div");
    card.append(
      node("span", "", label),
      node("strong", "", value === null ? "Not available" : formatter(value))
    );
    grid.append(card);
  }
  container.append(grid);

  const verification = node("p", "result-verification");
  verification.append(
    node("strong", "", "Server-repriced API equivalent. "),
    document.createTextNode(
      "This is a current public API price-card comparison calculated by the server, not a subscription charge or OpenAI’s internal quota unit."
    )
  );
  container.append(verification);

  const coverage = stats.pricingCoverage;
  const coveragePanel = node("section", "participant-detail");
  coveragePanel.append(node("h4", "", "Server pricing coverage"));
  const coverageState = node("span", `coverage-state coverage-${coverage.state}`, coverage.state.replaceAll("_", " "));
  const coverageHeading = node("div", "participant-detail-heading");
  coverageHeading.append(
    coverageState,
    node(
      "strong",
      "",
      coverage.percent === null ? "Coverage not testable" : `${formatPercent(coverage.percent, 1)} of events at least partly priced`
    )
  );
  coveragePanel.append(coverageHeading);
  const coverageGrid = node("div", "coverage-counts");
  for (const [label, value] of [
    ["Fully priced", coverage.fullyPricedEvents],
    ["Partly priced", coverage.partiallyPricedEvents],
    ["Unpriced", coverage.unpricedEvents],
    ["Unclassified", coverage.unclassifiedEvents]
  ]) {
    const item = node("div");
    item.append(node("span", "", label), node("strong", "", value === null ? "Unknown" : compact(value)));
    coverageGrid.append(item);
  }
  coveragePanel.append(coverageGrid);
  if (source.serverUnknownBillableUnits > 0) {
    coveragePanel.append(node(
      "p",
      "result-state result-state-warning",
      `${compact(source.serverUnknownBillableUnits)} observed billable units were not assigned a server price.`
    ));
  }
  container.append(coveragePanel);

  const pricingBasis = node("section", "participant-detail");
  pricingBasis.append(node("h4", "", "Keep subscription speed separate from API pricing"));
  const basisGrid = node("div", "pricing-basis-grid");
  const standard = node("article", "basis-card");
  standard.append(
    node("span", "basis-label", "Standard API counterfactual"),
    node(
      "strong",
      "",
      stats.standardApiCounterfactual.apiPriceEquivalentUsd === null
        ? "Not separately returned"
        : formatApiMoney(stats.standardApiCounterfactual.apiPriceEquivalentUsd)
    ),
    node(
      "p",
      "",
      stats.standardApiCounterfactual.apiPriceEquivalentUsd === null
        ? "This response does not isolate a Standard-only subtotal. The total above remains the verified server-repriced API equivalent."
        : `${stats.standardApiCounterfactual.events === null ? "Eligible subscription events" : compact(stats.standardApiCounterfactual.events) + " events"} repriced against the Standard API card.`
    )
  );
  const fast = node("article", "basis-card basis-fast");
  const fastValue = stats.codexFastObservations.eventShare === null
    ? stats.codexFastObservations.eventCount === null
      ? "Not testable"
      : `${compact(stats.codexFastObservations.eventCount)} events`
    : `${formatPercent(stats.codexFastObservations.eventShare * 100, 1)} of events`;
  fast.append(
    node("span", "basis-label", "Codex Fast observations"),
    node("strong", "", fastValue),
    node(
      "p",
      "",
      "Fast is a subscription speed observation. It is not API Priority tier, and no invented Fast price multiplier is applied here."
    )
  );
  basisGrid.append(standard, fast);
  pricingBasis.append(basisGrid);
  container.append(pricingBasis);

  const accountScoped = renderAccountScopedQuotaAnalysis(
    container,
    stats.accountScopedQuotaAnalysis
  );
  if (!accountScoped) {
    renderParticipantQuotaMovement(container, stats.rollingQuotaMovement);
  }
  renderPrivateCommunityComparison(container, stats.communityComparison);
}

const ACCOUNT_CALIBRATION_REASONS = Object.freeze({
  account_scoped_dataset_unavailable: "No complete account-scoped dataset has been contributed yet.",
  supported_quota_track_unavailable: "No five-hour or seven-day quota track is available in the contributed data.",
  source_evidence_refused: "The source dataset is partial or otherwise ineligible for calibration.",
  too_few_boundaries: "At least eight useful quota boundaries are required inside a reset window.",
  insufficient_displayed_span: "The visible quota movement covers less than five percentage points.",
  insufficient_training_boundaries: "There are too few earlier points to train this reset estimate.",
  insufficient_holdout_boundaries: "There are too few later points to test the estimate out of sample.",
  capacity_not_estimable: "Cost and quota movement do not yet form an estimable positive gradient.",
  sensitivity_too_wide: "The plausible capacity range is still too wide to report as a useful estimate.",
  prior_reset_forecast_unavailable: "At least two completed prior reset estimates are needed before a rolling comparison is honest.",
  endpoint_brackets_unavailable: "Quota observations do not bracket the exact rolling-hour endpoints closely enough."
});

function renderAccountScopedQuotaAnalysis(container, analysis) {
  if (analysis?.status !== "ready" || !analysis.tracks?.length) return false;
  const section = node("section", "participant-detail quota-movement");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Account-scoped quota calibration"),
    node(
      "p",
      "",
      "Usage and quota evidence are partitioned by a participant-scoped pseudonym. These results are private and are never copied into community output."
    )
  );
  heading.append(title, node("span", "private-chip", "Private result"));
  section.append(heading);

  const grid = node("div", "pricing-basis-grid");
  for (const track of analysis.tracks) {
    const card = node("article", "basis-card");
    const windowLabel = track.windowDurationMinutes === 10_080
      ? "Seven-day allowance"
      : "Five-hour allowance";
    const estimate = track.latestCapacityUsd === null
      ? "Collecting evidence"
      : formatApiMoney(track.latestCapacityUsd);
    card.append(
      node(
        "span",
        "basis-label",
        `${windowLabel} · ${track.planVariant || track.planType}`
      ),
      node("strong", "", estimate)
    );
    if (track.latestCapacityUsd !== null) {
      const range = track.sensitivityLowerUsd !== null
        && track.sensitivityUpperUsd !== null
        ? ` Plausible sensitivity range: ${formatApiMoney(track.sensitivityLowerUsd)}–${formatApiMoney(track.sensitivityUpperUsd)}.`
        : "";
      card.append(node(
        "p",
        "",
        `API-price-equivalent capacity from ${compact(track.estimatedResets)} qualified reset${track.estimatedResets === 1 ? "" : "s"}.${range}`
      ));
    } else {
      card.append(node(
        "p",
        "",
        `${compact(track.totalResets)} reset window${track.totalResets === 1 ? "" : "s"} observed; none yet passes every calibration gate.`
      ));
    }
    const rolling = track.rollingStatus === "conditional_comparison"
      ? `${compact(track.rollingComparisonCount)} honest 1–3 hour rolling comparisons available.`
      : "Rolling observed-versus-expected comparison is not testable yet.";
    card.append(node("p", "", rolling));
    const reasons = [...new Set([
      ...track.refusalCodes,
      ...track.rollingRefusalCodes
    ])].slice(0, 3);
    if (reasons.length) {
      const list = node("ul", "calibration-reasons");
      for (const reason of reasons) {
        list.append(node(
          "li",
          "",
          fixedCopy(ACCOUNT_CALIBRATION_REASONS, reason)
            // An unrecognized refusal code is still a fixed code, but it is
            // not copy: only identifier-shaped values are ever humanized.
            ?? (/^[a-z][a-z0-9_]{1,63}$/u.test(reason)
              ? reason.replaceAll("_", " ")
              : "A fixed refusal code was reported that this page cannot explain.")
        ));
      }
      card.append(list);
    }
    grid.append(card);
  }
  section.append(grid);
  container.append(section);
  return true;
}

const QUOTA_MOVEMENT_REASONS = Object.freeze({
  account_continuity_not_transmitted: "Account continuity is deliberately absent from this privacy-safe contribution, so the server will not calculate an account-specific quota conversion.",
  insufficient_quota_observations: "There are not yet two usable quota observations in one reset window.",
  analysis_record_limit_exceeded: "The private analysis exceeded its bounded record limit.",
  stale_quota_observation: "At least one provider quota observation arrived too late to support this comparison.",
  backward_quota_observation: "The quota percentage moved backwards inside one reset window, so this track was rejected as ambiguous.",
  incomplete_server_pricing_in_interval: "At least one overlapping usage event was not fully priced by the server.",
  no_observed_quota_movement: "The recorded quota percentage did not move in this window.",
  no_server_priced_usage_in_interval: "No server-priced usage overlaps this quota interval.",
  no_usage_in_interval: "No usage events overlap this quota interval.",
  no_valid_rolling_rows: "The response contained no valid 1-, 2-, or 3-hour comparison rows."
});

function renderParticipantQuotaMovement(container, movement) {
  const section = node("section", "participant-detail quota-movement");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Private rolling quota movement"),
    node("p", "", "Observed quota decrease versus movement implied by server-repriced API equivalent, bucketed in UTC.")
  );
  heading.append(title, node("span", "private-chip", "Private result"));
  section.append(heading);

  if (movement.accountContinuity === "not_transmitted") {
    section.append(node(
      "p",
      "result-state result-state-warning",
      "Account continuity was not transmitted. Participant-wide usage may span accounts, so this comparison must not be treated as an account-specific quota conversion."
    ));
  }

  if (movement.status !== "conditional_estimate") {
    const copy = fixedCopy(QUOTA_MOVEMENT_REASONS, movement.reason)
      ?? "The available private evidence cannot support this comparison yet.";
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "Not testable"),
      node("p", "", copy)
    );
    section.append(state);
  } else {
    const metadata = node("div", "movement-metadata");
    const resetLabel = movement.resetsAt ? `Reset ${formatLocal(movement.resetsAt)}` : "Reset time unavailable";
    const capacityLabel = movement.apiPriceEquivalentCapacityUsd === null
      ? "Capacity estimate unavailable"
      : `${formatApiMoney(movement.apiPriceEquivalentCapacityUsd)} per 100 percentage points`;
    metadata.append(
      node("span", "", [movement.planType, movement.planVariant, movement.limitId, movement.slot].filter(Boolean).join(" · ") || "Quota track"),
      node("span", "", resetLabel),
      node("span", "", capacityLabel)
    );
    section.append(metadata);
    section.append(node(
      "p",
      "snapshot-disclosure",
      "The capacity figure is a conditional API-price-equivalent gradient, not a provider-reported allowance. Tables show the latest 12 valid points for each smoothing window."
    ));

    for (const smoothingHours of [1, 2, 3]) {
      const rows = movement.rows
        .filter((row) => row.smoothingHours === smoothingHours)
        .sort((left, right) => Date.parse(left.windowEndUtc) - Date.parse(right.windowEndUtc))
        .slice(-12);
      const group = node("section", "movement-window");
      const groupHeading = node("div", "movement-window-heading");
      groupHeading.append(
        node("h5", "", `${smoothingHours}-hour rolling window`),
        node("span", "", rows.length ? `${rows.length} latest points` : "Not testable")
      );
      group.append(groupHeading);
      if (!rows.length) {
        group.append(node(
          "p",
          "empty-inline",
          `Not testable: the response does not yet contain a valid ${smoothingHours}-hour rolling point.`
        ));
        section.append(group);
        continue;
      }
      const wrap = node("div", "table-wrap movement-table");
      const table = document.createElement("table");
      const caption = node(
        "caption",
        "sr-only",
        `${smoothingHours}-hour private rolling quota movement in UTC`
      );
      const thead = document.createElement("thead");
      const header = document.createElement("tr");
      for (const label of ["Window ending (UTC)", "Observed", "Expected", "Difference", "API equivalent", "Events"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = label;
        header.append(th);
      }
      thead.append(header);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        const difference = row.observedQuotaChangePp - row.expectedQuotaChangePp;
        for (const value of [
          formatLocal(row.windowEndUtc),
          formatPp(row.observedQuotaChangePp, 2),
          formatPp(row.expectedQuotaChangePp, 2),
          formatPp(difference, 2),
          formatApiMoney(row.apiPriceEquivalentUsd),
          compact(row.usageEvents)
        ]) {
          tr.append(node("td", "", value));
        }
        tbody.append(tr);
      }
      table.append(caption, thead, tbody);
      wrap.append(table);
      group.append(wrap);
      section.append(group);
    }
  }
  container.append(section);
}

const COMMUNITY_METRIC_LABELS = Object.freeze({
  usageEvents: "Usage events",
  inputUncachedTokens: "Input uncached",
  inputCacheReadTokens: "Cache read",
  inputCacheWriteTokens: "Cache write",
  outputTextTokens: "Output text",
  outputReasoningTokens: "Reasoning output",
  outputCombinedTokens: "Combined output",
  toolUnits: "Tool units"
});

const COMMUNITY_COMPARISON_REASONS = Object.freeze({
  stable_snapshot_unavailable: "No stable released community week is available yet.",
  community_snapshot_not_released: "The latest community week is withdrawn or privacy-suppressed, so no personal comparison is shown.",
  community_snapshot_contract_invalid: "The released community week could not be compared safely.",
  participant_comparison_too_large: "The comparison exceeded its fixed safe size.",
  participant_comparison_contract_invalid: "The participant comparison could not be constructed safely.",
  comparison_contract_invalid: "The comparison response did not pass browser validation."
});

function renderPrivateCommunityComparison(container, comparison) {
  const section = node("section", "participant-detail community-comparison");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Your contribution in the released week"),
    node(
      "p",
      "",
      "Your value uses the publication clipping cap. The community value is the already-public total rounded down."
    )
  );
  heading.append(title, node("span", "private-chip", "Private comparison"));
  section.append(heading);

  if (comparison?.status !== "ready") {
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "Not testable"),
      node(
        "p",
        "",
        fixedCopy(COMMUNITY_COMPARISON_REASONS, comparison?.reason)
          ?? "A disclosure-safe released week is required before this comparison can be shown."
      )
    );
    section.append(state);
    container.append(section);
    return;
  }

  section.append(node(
    "p",
    "snapshot-disclosure",
    `${formatLocal(comparison.period.startAt, { dateOnly: true })}–${formatLocal(comparison.period.endAt, { dateOnly: true })} · revision ${compact(comparison.snapshotRevision)}. This is not an average, percentile, bill, or provider allowance. A rounded-down public total can be lower than your own clipped value.`
  ));
  const activeCells = comparison.cells.filter((cell) => cell.participantHasActivity);
  if (!activeCells.length) {
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "No matched released cell"),
      node(
        "p",
        "",
        "Your accepted activity did not contribute to a provider/model cell released for this fixed week."
      )
    );
    section.append(state);
    container.append(section);
    return;
  }

  const wrap = node("div", "table-wrap comparison-table");
  const table = document.createElement("table");
  const caption = node(
    "caption",
    "sr-only",
    "Private clipped contribution compared with public rounded community total"
  );
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of [
    "Provider / model",
    "Metric",
    "Your clipped contribution",
    "Public rounded total",
    "Interpretation"
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const cell of activeCells) {
    for (const [metricName, label] of Object.entries(COMMUNITY_METRIC_LABELS)) {
      const metric = cell.metrics[metricName];
      const row = document.createElement("tr");
      const identity = document.createElement("th");
      identity.scope = "row";
      identity.textContent = `${cell.provider} · ${cell.planType === "unknown" ? "plan unknown" : cell.planType + (cell.planVariant !== "unknown" ? " " + cell.planVariant : "")} · ${cell.modelId}`;
      row.append(identity, node("td", "", label));
      if (metric.status === "community_not_released") {
        row.append(
          node("td", "suppressed-value", "Not shown"),
          node("td", "suppressed-value", "Not released"),
          node("td", "", "Community support did not pass the fixed release rule.")
        );
      } else if (metric.status === "participant_component_unavailable") {
        row.append(
          node("td", "suppressed-value", "Not observed"),
          node("td", "", compact(metric.communityRoundedValue)),
          node("td", "", "Your source did not report this component.")
        );
      } else {
        row.append(
          node("td", "", compact(metric.participantClippedValue)),
          node("td", "", compact(metric.communityRoundedValue)),
          node(
            "td",
            "",
            metric.participantClippedValue > metric.communityRoundedValue
              ? "Public rounding makes a share calculation invalid."
              : "Same fixed week; no average or percentile is inferred."
          )
        );
      }
      tbody.append(row);
    }
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  section.append(wrap);
  container.append(section);
}

const CONTRIBUTION_STATUS_LABELS = Object.freeze({
  accepted: "Accepted",
  accepted_synthetic: "Accepted fixture",
  deleting: "Deletion in progress"
});

function renderContributionHistory(container, payload) {
  clear(container);
  const history = normalizeParticipantHistory(payload);
  if (!communitySession?.csrfToken) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Accepted contribution history"),
    node(
      "p",
      "",
      "Each row is private to this participant and comes from canonical backend state."
    )
  );
  heading.append(title, node("span", "private-chip", "Private history"));
  container.append(heading);

  if (history.state !== "ready") {
    const unavailable = node("div", "not-testable-state");
    unavailable.append(
      node("strong", "", "History unavailable"),
      node(
        "p",
        "",
        history.reason === "unsupported_schema"
          ? "The service returned an unsupported participant-history contract."
          : history.reason === "invalid_contract"
            ? "The service response did not pass the browser's closed history contract."
            : "The participant-history service could not be reached."
      )
    );
    container.append(unavailable);
    return;
  }

  const disclosure = node("p", "history-disclosure");
  disclosure.textContent = history.items.length === 0
    ? "No accepted contribution batches remain."
    : `${compact(history.contributionCount)} accepted or deleting batch${history.contributionCount === 1 ? "" : "es"}. The current transport does not carry a reviewed client software version.`;
  container.append(disclosure);
  if (history.items.length === 0) return;

  const list = node("div", "history-list");
  history.items.forEach((item, index) => {
    const card = node("article", "history-card");
    const cardHeading = node("div", "history-card-heading");
    const label = node("div");
    label.append(
      node("strong", "", `Contribution ${history.items.length - index}`),
      node("small", "", `Received ${formatLocal(item.createdAt)}`)
    );
    cardHeading.append(
      label,
      node(
        "span",
        item.status === "deleting"
          ? "history-state history-state-deleting"
          : "history-state",
        fixedCopy(CONTRIBUTION_STATUS_LABELS, item.status)
          ?? "Status unavailable"
      )
    );
    card.append(cardHeading);

    const details = node("dl", "history-facts");
    const recordSummary = item.recordCounts === null
      ? "Fixture contract"
      : `${compact(item.recordCounts.accepted)} accepted · ${compact(item.recordCounts.deduplicated)} duplicate`;
    const pricingSummary = item.serverAccounting.verification === "server_repriced"
      ? `${formatApiMoney(item.serverAccounting.apiPriceEquivalentUsd)} API-price equivalent`
      : "Server repricing unavailable";
    const quarantineSummary = item.quarantine.state === "deleted"
      ? `Encrypted object deleted ${formatLocal(item.quarantine.deletedAt)}`
      : `Encrypted object scheduled for deletion after ${formatLocal(item.quarantine.scheduledDeletionAt)}`;
    for (const [term, description] of [
      ["Covered period", `${formatLocal(item.coveredAt.startAt)}–${formatLocal(item.coveredAt.endAt)}`],
      ["Records", recordSummary],
      ["Contract", `${item.transportSchemaVersion} · ${item.clientPlatform}`],
      ["Pricing", pricingSummary],
      ["Quarantine", quarantineSummary]
    ]) {
      const fact = node("div");
      fact.append(node("dt", "", term), node("dd", "", description));
      details.append(fact);
    }
    card.append(details);
    card.append(node(
      "p",
      "history-retention-note",
      "Deleting the encrypted quarantine object does not delete the canonical metadata used for your private results. Use the button below to delete this contribution from canonical results."
    ));
    if (item.status !== "deleting") {
      const remove = node("button", "button button-danger history-delete", "Delete this contribution");
      remove.type = "button";
      remove.dataset.contributionId = item.contributionId;
      card.append(remove);
    }
    list.append(card);
  });
  container.append(list);
}

/**
 * Render one delayed weekly snapshot.
 *
 * The default view carries the result and the one caveat needed to read it
 * honestly. Everything that only describes how the service produces the number
 * — contract version, ingestion cutoff, release timing, per-cell support
 * mechanics, sealed-revision policy, and what the current contract cannot yet
 * publish — is relocated into the collapsed provenance disclosure beside it.
 */
function renderCommunitySnapshot(container, payload) {
  clear(container);
  const detail = $("#community-snapshot-service-detail");
  clear(detail);
  const snapshot = normalizeCommunitySnapshot(payload);
  if (snapshot.state === "service_unavailable") {
    container.append(node("p", "", "The central service is unavailable. This is separate from whether a weekly snapshot exists."));
    const quality = node("dl", "snapshot-quality-grid");
    for (const [term, value] of [
      ["Released snapshot", "Not loaded"],
      ["Cohort limit estimate", "Not in current contract"],
      ["Matched quota coverage", "Not in current contract"],
      ["Change confidence", "Not in current contract"]
    ]) {
      const item = node("div");
      item.append(node("dt", "", term), node("dd", "", value));
      quality.append(item);
    }
    detail.append(quality);
    detail.append(node(
      "p",
      "snapshot-disclosure",
      "No community capacity or change claim is inferred from aggregate activity alone. The next contract must publish replay exclusions, matched quota coverage, uncertainty, and cohort support together."
    ));
    return;
  }
  if (snapshot.state === "development_unsafe") {
    container.append(node("p", "", "Live cumulative community totals are development-only and are not displayed."));
    return;
  }
  if (snapshot.state === "unsupported_schema") {
    container.append(node("p", "", "The service returned an unsupported community-snapshot contract. No values were displayed."));
    return;
  }
  if (snapshot.state === "not_yet_published") {
    container.append(node("p", "", "No stable weekly snapshot is available yet."));
    return;
  }
  if (snapshot.state === "withdrawn") {
    container.append(node("p", "", "This weekly revision was withdrawn for privacy or quality reasons. A replacement revision may be pending."));
    return;
  }
  if (snapshot.state === "suppressed") {
    container.append(node("p", "", "This week did not pass the fixed privacy release policy. We do not disclose why or how close the cohort was."));
    return;
  }

  const heading = node("div", "snapshot-heading");
  heading.append(
    node("strong", "", `${formatLocal(snapshot.period.startAt, { dateOnly: true })} – ${formatLocal(snapshot.period.endAt, { dateOnly: true })}`)
  );
  container.append(heading);
  // The one sentence a reader needs to know what these numbers are and are
  // not. The mechanism that produces them lives in the disclosure below.
  container.append(node(
    "p",
    "snapshot-disclosure",
    `Activity totals for the week above, from people who chose to contribute. A figure appears only when at least ${compact(snapshot.minimumIndependentParticipants)} different participants used that provider and model, and every figure is rounded down — so this is not everyone's usage, not an average, and not a cost.`
  ));
  if (snapshot.state === "published_partial") {
    container.append(node("p", "snapshot-partial", "Some metrics were not released because their independent support was insufficient."));
  }

  const quality = node("dl", "snapshot-quality-grid");
  for (const [term, value] of [
    ["Contract", snapshot.schemaVersion],
    ["Released model cells", compact(snapshot.cells.length)],
    ["Minimum support", `≥${compact(snapshot.minimumIndependentParticipants)} participants per cell`],
    ["Ingestion cutoff", formatLocal(snapshot.ingestionCutoffAt)],
    ["Released", formatLocal(snapshot.releasedAt)],
    ["Snapshot age", formatAge(Math.max(0, (Date.now() - Date.parse(snapshot.releasedAt)) / 1_000))],
    ["Coverage state", snapshot.state === "published_partial" ? "Partially released" : "All contracted cells released"]
  ]) {
    const item = node("div");
    item.append(node("dt", "", term), node("dd", "", value));
    quality.append(item);
  }
  detail.append(quality);
  detail.append(node(
    "p",
    "snapshot-disclosure",
    `Each value is clipped per participant, independently support-gated at ${compact(snapshot.minimumIndependentParticipants)} or more participants, and rounded down. A sealed revision is never rewritten; deletion creates a replacement revision.`
  ));
  detail.append(node(
    "p",
    "snapshot-disclosure",
    "This release currently reports privacy-safe activity totals. Cohort weekly-limit estimates, matched quota coverage, replay exclusions, and change confidence require the next community contract before they can be shown honestly."
  ));

  const wrap = node("div", "table-wrap snapshot-table");
  const table = document.createElement("table");
  const caption = node("caption", "sr-only", "Privacy-safe delayed weekly community metrics");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of ["Provider / model", ...Object.values(COMMUNITY_METRIC_LABELS)]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const cell of snapshot.cells) {
    const row = document.createElement("tr");
    const identity = document.createElement("th");
    identity.scope = "row";
    identity.textContent = `${cell.provider} · ${cell.planType === "unknown" ? "plan unknown" : cell.planType + (cell.planVariant !== "unknown" ? " " + cell.planVariant : "")} · ${cell.modelId}`;
    row.append(identity);
    for (const metricName of Object.keys(COMMUNITY_METRIC_LABELS)) {
      const td = document.createElement("td");
      const metric = cell.metrics[metricName];
      td.textContent = metric.status === "released" ? compact(metric.value) : "Not released";
      if (metric.status !== "released") td.className = "suppressed-value";
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  container.append(wrap);
}

async function loadCommunityResults() {
  const service = $("#service-state");
  const personal = $("#personal-result");
  const community = $("#community-result");
  const participantControls = $("#participant-controls");
  const centralConfigured = localCompanionHealth === null
    || localCompanionHealth?.capabilities?.centralServiceProxy === true;
  if (!centralConfigured) {
    participantContributionAdmission = null;
    renderBackendHealth(null, null, { configured: false });
    service.textContent = "Local preparation available; community service not connected";
    service.className = "evidence-chip neutral";
    participantControls.hidden = true;
    renderPersonalStats(personal, null);
    renderContributionHistory($("#contribution-history"), null);
    renderCommunitySnapshot(community, null);
    renderContributionPreparationEstimate();
    return;
  }
  try {
    const [
      healthResult,
      readinessResult,
      personalResult,
      communityResult,
      profileResult
    ] = await Promise.allSettled([
      communityClient.health(),
      communityClient.readiness(),
      communitySession?.csrfToken ? communityClient.personalStats() : Promise.resolve(null),
      communityClient.communityStats(),
      communitySession?.csrfToken ? communityClient.participantProfile() : Promise.resolve(null)
    ]);
    const serviceReachable = healthResult.status === "fulfilled"
      || communityResult.status === "fulfilled"
      || (Boolean(communitySession?.csrfToken) && personalResult.status === "fulfilled");
    renderBackendHealth(
      healthResult.status === "fulfilled" ? healthResult.value : null,
      readinessResult.status === "fulfilled" ? readinessResult.value : null,
      { configured: true },
    );
    service.textContent = serviceReachable
      ? "Community service reachable"
      : "Community service unavailable";
    service.className = serviceReachable ? "evidence-chip" : "evidence-chip neutral";
    const normalizedProfile = normalizeParticipantHistory(
      profileResult.status === "fulfilled" ? profileResult.value : null,
    );
    participantContributionAdmission = normalizedProfile.state === "ready"
      ? normalizedProfile.contributionAdmission
      : null;
    renderPersonalStats(personal, personalResult.status === "fulfilled" ? personalResult.value : null);
    renderContributionHistory(
      $("#contribution-history"),
      profileResult.status === "fulfilled" ? profileResult.value : null
    );
    renderCommunitySnapshot(community, communityResult.status === "fulfilled" ? communityResult.value : null);
    renderContributionPreparationEstimate();
    participantControls.hidden = !(communitySession?.csrfToken && personalResult.status === "fulfilled");
    // The advertised enrollment mode is reported by the backend facts panel;
    // this page collects no invitation code for any of those modes.
  } catch {
    participantContributionAdmission = null;
    renderBackendHealth(null, null, { configured: true });
    service.textContent = "Community service unavailable";
    service.className = "evidence-chip neutral";
    participantControls.hidden = true;
    renderContributionHistory($("#contribution-history"), null);
    renderContributionPreparationEstimate();
  }
}

function renderBackendHealth(health, readiness, { configured = true } = {}) {
  if (!configured) {
    const state = $("#backend-state");
    state.textContent = "Not connected";
    state.className = "evidence-chip neutral";
    const centralState = $("#central-state");
    centralState.replaceChildren(
      node("span", "state-dot"),
      document.createTextNode("Local-only mode"),
    );
    centralState.className = "state-pill state-local";
    $("#backend-facts").hidden = true;
    $("#backend-description").textContent =
      "Your local usage, allowance estimates, and privacy review are working without a remote service. Community upload and aggregate comparisons appear only in a build with an explicit community-service origin.";
    $("#backend-readiness-note").textContent =
      "This build has no community-service origin sealed into it, so there is no readiness to report.";
    $("#backend-contract-note").textContent =
      "No community origin is sealed into this app. Nothing is failing and no upload is attempted.";
    return;
  }
  $("#backend-facts").hidden = false;
  $("#backend-description").textContent =
    "This optional service is separate from the local collector above. Your local reporting works whether or not it is reachable, and nothing leaves this Mac unless you choose to contribute.";
  // Engineering detail about how readiness is established lives inside the
  // collapsed service-detail disclosure, not in the panel's default view.
  $("#backend-readiness-note").textContent =
    "Live readiness verifies database and encrypted-object access, fresh retention and restore replay, object reconciliation, and aggregate rebuild state.";
  const reachable = health?.status === "ok";
  const servingReady = readiness?.state === "ready";
  const readinessKnown = servingReady || readiness?.state === "not_ready";
  const controls = health?.collectionControls;
  const collectionState = reachable
    && ["operational", "degraded", "contained"].includes(controls?.state)
    ? controls.state
    : null;
  const state = $("#backend-state");
  const stateLabels = {
    operational: "Community backend ready",
    degraded: "Collection partially paused",
    contained: "Collection contained"
  };
  const stateLabel = !reachable
    ? "Community service unavailable"
    : !readinessKnown
      ? "Readiness unavailable"
      : !servingReady
        ? "Community recovery pending"
        : stateLabels[collectionState] ?? "Community status incomplete";
  state.textContent = stateLabel;
  state.className = servingReady && collectionState === "operational"
    ? "evidence-chip"
    : "evidence-chip neutral";
  const centralState = $("#central-state");
  centralState.replaceChildren(
    node("span", "state-dot"),
    document.createTextNode(stateLabel)
  );
  centralState.className = servingReady && collectionState === "operational"
    ? "state-pill"
    : reachable
      ? "state-pill state-insufficient"
      : "state-pill state-offline";
  $("#backend-database").textContent = health?.checks?.database === "ok"
    ? "Connected"
    : "Unavailable";
  $("#backend-deletion-ledger").textContent = health?.checks?.deletionLedger === "ok"
    ? "Independent digest-only store reachable"
    : "Unavailable";
  $("#backend-storage").textContent = health?.checks?.encryptedObjectStore === "reachable"
    ? "Reachable"
    : "Unavailable";
  const lifecycleLabels = {
    never_run: "Awaiting first scheduled pass",
    running: "Lifecycle pass running",
    completed: health?.checks?.quarantineRetentionComplete === true
      && health?.checks?.restoreReplayComplete === true
      ? "Retention and restore replay current"
      : "Catching up; publication held",
    failed: "Lifecycle pass failed; operator review required",
    stale: "Lifecycle evidence stale; publication held",
    incomplete: "Catching up; publication held",
    ready: "Retention and restore replay current"
  };
  $("#backend-lifecycle").textContent = lifecycleLabels[
    readinessKnown ? readiness.lifecycle : health?.checks?.lifecycle
  ]
    ?? "Unavailable";
  const reconciliationLabels = {
    never_run: "Awaiting first reconciliation pass",
    running: "Reconciliation running",
    completed: readiness?.quarantineReconciliationComplete === true
      ? "Tracked objects and metadata reconciled"
      : "Reconciliation incomplete",
    failed: "Reconciliation failed; operator review required"
  };
  $("#backend-reconciliation").textContent = readinessKnown
    ? reconciliationLabels[readiness.quarantineReconciliation] ?? "Unavailable"
    : "Unavailable";
  $("#backend-aggregate-rebuild").textContent = readinessKnown
    ? readiness.aggregateRebuildComplete
      ? "Complete"
      : "Pending; publication held"
    : "Unavailable";
  $("#backend-collection-state").textContent = {
    operational: "Operational",
    degraded: "One or more intake stages paused",
    contained: "All collection and publication paused"
  }[collectionState] ?? "Unavailable";
  const enrollmentLabels = {
    local_open: "Open for local testing",
    invite_only: "Private invite pilot",
    disabled: "New enrollment paused"
  };
  $("#backend-enrollment").textContent = controls?.enrollment === false
    ? "Paused"
    : enrollmentLabels[health?.enrollmentMode] ?? "Unavailable";
  const controlLabel = (value) => value === true
    ? "Enabled"
    : value === false
      ? "Paused"
      : "Unavailable";
  $("#backend-upload-registration").textContent = controlLabel(
    controls?.uploadRegistration
  );
  $("#backend-processing").textContent = controlLabel(controls?.processing);
  $("#backend-publication").textContent = controlLabel(controls?.publication);
  $("#backend-participant-rights").textContent = reachable
    && health?.capabilities?.participantStats === true
    && health?.capabilities?.participantExport === true
    && health?.capabilities?.participantDeletion === true
    ? "View, export, and delete remain available"
    : "Unavailable";
  $("#backend-contract").textContent = health?.contracts?.acceptedContribution
    ?? "Unavailable";

  const accountContract = health?.contracts?.accountScopedContribution;
  $("#backend-contract-note").textContent =
    accountContract?.status === "local_preview_loopback_only"
      ? `${accountContract.schemaVersion} account-scoped ingest is active only on this loopback development server. It remains unauthorized for external participants.`
      : accountContract?.status === "implementation_disabled"
        ? `${accountContract.schemaVersion} account-scoped ingest is implemented and testable, but disabled on this HTTP route.`
        : "No account-scoped experimental contract was advertised by this backend.";
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
  }
}

async function deleteParticipantData() {
  if (!window.confirm("Permanently delete every hosted contribution and private statistic associated with this pseudonymous contribution session? This cannot be undone.")) return;
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Turning off automatic contribution, then deleting hosted metadata…";
  try {
    pendingAutomaticContributionConsent = null;
    if (automaticContributionStatus?.enabled) {
      const disabled = await localClient.disableAutomaticContribution();
      if (disabled.state === "unavailable" || disabled.enabled) {
        throw new Error("Automatic contribution could not be disabled.");
      }
      renderAutomaticContributionStatus(disabled);
    }
    const receipt = await communityClient.deleteParticipant();
    setCommunitySession(null);
    $("#contribution-file").value = "";
    $("#contribution-consent").checked = false;
    $("#contribution-submit").disabled = true;
    $(".file-drop").classList.remove("selected");
    $("#file-help").textContent = "Privacy-safe JSON export · 1.25 MB browser validation limit";
    const uploadStatus = $("#upload-status");
    uploadStatus.hidden = false;
    uploadStatus.className = "upload-status";
    uploadStatus.textContent = `Deleted ${compact(receipt?.contributionsDeleted ?? 0)} contribution batches and the pseudonymous hosted session.`;
    status.textContent = "Your hosted content-free pseudonymous metadata was deleted.";
    $("#participant-controls").hidden = true;
    renderPersonalStats($("#personal-result"), null);
    renderContributionHistory($("#contribution-history"), null);
    await loadCommunityResults();
  } catch (error) {
    showFailure(status, {
      surface: "hosted_privacy",
      error,
      fallback:
        "The contributed data could not be deleted. Nothing was removed; your deletion right is unchanged and you can try again."
    });
  }
}

async function deleteSingleContribution(contributionId) {
  if (!window.confirm(
    "Delete this contribution from canonical private results and any current project-controlled aggregate? Other accepted contributions remain."
  )) return;
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Deleting this contribution and refreshing derived results…";
  try {
    await communityClient.deleteContribution(contributionId);
    status.textContent = "Contribution deleted. Private and community results have been refreshed.";
    await loadCommunityResults();
  } catch (error) {
    showFailure(status, {
      surface: "hosted_privacy",
      error,
      fallback:
        "The contribution could not be deleted. Nothing was removed; you can try again."
    });
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
  void beginGoogleSignIn();
});
$("#identity-apple-signin").addEventListener("click", () => {
  void beginAppleSignIn();
});
$("#identity-signout").addEventListener("click", signOutHostedIdentity);
// The loopback callback page writes exactly one fixed key; a storage event
// from the same origin is the only completion signal this tab listens for.
window.addEventListener("storage", (event) => {
  if (event.key === GOOGLE_OAUTH_RESULT_STORAGE_KEY
      && typeof event.newValue === "string"
      && event.newValue.length > 0) {
    void completeGoogleSignIn(event.newValue);
  }
});
$("#community-connect-consent").addEventListener(
  "change",
  updateCommunityConnectButton
);
$("#connect-community").addEventListener(
  "click",
  connectCommunityContribution
);
$("#contribution-not-now").addEventListener("click", () => {
  pendingAutomaticContributionConsent = null;
  $("#community-connect-consent").checked = false;
  renderAutomaticContributionStatus(automaticContributionStatus);
  updateCommunityConnectButton();
  const status = $("#community-connect-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent =
    "Nothing will be contributed. Your local reporting continues unchanged.";
});
$("#automatic-contribution-toggle").addEventListener(
  "click",
  disableAutomaticContribution
);
$("#prepare-contribution").addEventListener("click", prepareLocalContribution);
$("#demo-button").addEventListener("click", () => renderDashboard(demoDashboard()));
$("#sync-inspect").addEventListener("click", inspectNextContribution);
$("#sync-run-once").addEventListener("click", () => runContributionSyncAction("run"));
$("#sync-pause").addEventListener("click", () => runContributionSyncAction("pause"));
$("#sync-resume").addEventListener("click", () => runContributionSyncAction("resume"));
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
  if (!button || !dashboard) return;
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
$("#weekly-span-threshold").addEventListener("input", (event) => {
  const threshold = Number(event.target.value);
  if (!Number.isFinite(threshold)) return;
  weeklySpanThresholdPp = Math.max(0, Math.min(100, threshold));
  if (dashboard) renderWeekly(dashboard);
  else renderWeeklySpanThresholdControls();
});
$("#weekly-evidence-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-evidence]");
  if (!button || !dashboard) return;
  showWeeklyPartialDiagnostics = button.dataset.evidence === "all";
  for (const control of $("#weekly-evidence-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  renderWeekly(dashboard);
});
$("#accounting-period-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-period]");
  if (!button || !dashboard) return;
  activeAccountingPeriod = button.dataset.period;
  for (const control of $("#accounting-period-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  renderAccounting(dashboard);
});
$("#fast-mode-preference-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-fast-mode]");
  if (!button) return;
  void selectFastModePreference(button.dataset.fastMode);
});

$("#contribution-file").addEventListener("change", async () => {
  contributionSelectionRevision += 1;
  const selectionRevision = contributionSelectionRevision;
  const file = $("#contribution-file").files[0];
  const drop = $(".file-drop");
  drop.classList.toggle("selected", Boolean(file));
  $("#file-help").textContent = file ? `${file.name} · ${compact(file.size)} bytes` : "Privacy-safe JSON export · 1.25 MB browser validation limit";
  resetSelectedContributionInspection();
  $("#contribution-consent").checked = false;
  $("#contribution-consent-title").textContent =
    "I reviewed this as a privacy-safe TiboTattle export.";
  $("#contribution-consent-detail").textContent =
    "Uploading is optional and can be tested against a local backend.";
  if (file) {
    try {
      const payload = await parseSafeExport(file);
      if (
        selectionRevision !== contributionSelectionRevision
        || $("#contribution-file").files[0] !== file
      ) return;
      renderSelectedContributionInspection(file, payload);
      if (payload?.schemaVersion === "telemetry-contribution-v0.2") {
        $("#contribution-consent-title").textContent =
          "I consent to upload participant-scoped pseudonymous account tracks.";
        $("#contribution-consent-detail").textContent =
          "They link usage and quota rows only within this pseudonymous contribution session for private calibration; they are never published in community output and are deleted with the hosted session.";
      }
    } catch (error) {
      if (
        selectionRevision !== contributionSelectionRevision
        || $("#contribution-file").files[0] !== file
      ) return;
      renderSelectedContributionError(error);
    }
  }
  $("#contribution-submit").disabled = true;
});
$("#contribution-consent").addEventListener("change", () => {
  $("#contribution-submit").disabled = !(
    selectedContributionValidated
    && $("#contribution-consent").checked
    && $("#contribution-file").files.length
  );
});
$("#contribution-form").addEventListener("submit", submitContribution);
$("#delete-participant").addEventListener("click", deleteParticipantData);
$("#contribution-history").addEventListener("click", (event) => {
  const button = event.target.closest("[data-contribution-id]");
  if (button?.dataset.contributionId) {
    deleteSingleContribution(button.dataset.contributionId);
  }
});

mountDashboardNavigation({
  documentRef: document,
  windowRef: window,
  IntersectionObserverRef: IntersectionObserver,
});

async function bootstrapDashboard() {
  renderInstallerJourney();
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
