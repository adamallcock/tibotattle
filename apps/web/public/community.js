// Entry point for the public website.
//
// The website introduces the Mac app, offers its verified installer, and
// renders the live community allowance and daily activity series. All three work with no local
// companion. Everything that needs the companion — the personal dashboard,
// contribution preparation and upload, hosted sign-in, participant deletion —
// is deliberately absent here and lives in the Mac app's own window, so this
// page can never show a control that cannot work.
//
// Every rendering routine below is imported, not copied: the install card and
// the community view are the same modules the in-app dashboard entry uses.

import { PublicCommunityClient } from "./community-data.js";
import {
  renderCommunityAllowanceSection,
  renderCommunityDailySeries,
} from "./community-view.js";
import {
  renderInstallerAssurance,
  renderInstallerJourney,
} from "./install-cta.js";
import { createBrowserLocalization, translate } from "./localization.js";
import {
  getFormattingLocale,
  setFormattingLocale,
  setMessageLocale,
} from "./ui-format.js";

const localization = createBrowserLocalization();
setFormattingLocale(localization.formatLocale());
setMessageLocale(localization.locale());
export const HOMEBREW_INSTALL_COMMAND =
  "brew install --cask adamallcock/tap/tibotattle";
export const PUBLIC_PLATFORMS = Object.freeze(["macos", "windows", "linux"]);
const PUBLIC_PLATFORM_STORAGE_KEY = "tibotattle.download-platform.v1";
// Resolve generated copy from the document language at render time. The
// browser localizer updates that attribute before emitting its locale-change
// event, which keeps a rerender from observing a stale closure during a live
// picker change.
const t = (key, values = {}) => translate(
  key,
  values,
  typeof document === "undefined"
    ? localization.locale()
    : document.documentElement?.lang ?? localization.locale(),
);

const $ = (selector) => document.querySelector(selector);
const publicErrorCodePattern =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const publicRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let lastCommunityDailyPayload = null;
let lastCommunityDailyFailure = null;
let communityDailySettled = false;
// The allowance range selection: 30 calendar days or null for the whole
// published series. Re-rendering is purely client-side — the year window is
// already fetched — so a range change never issues a request.
let allowanceRangeDays = 30;
let allowanceDialogReturnFocus = null;
const communityClient = new PublicCommunityClient();

function normalizePublicPlatform(candidate) {
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim().toLowerCase();
  return PUBLIC_PLATFORMS.includes(normalized) ? normalized : null;
}

/**
 * Coarse browser-reported platform detection is used only to choose the first
 * visible tab. It never redirects, hides alternatives, starts a download, or
 * claims that the app is installed. Unknown and mobile platforms return null.
 */
export function detectPublicPlatform({
  userAgentDataPlatform = "",
  userAgent = "",
  maxTouchPoints = 0,
} = {}) {
  const platformHint = String(userAgentDataPlatform).toLowerCase();
  const userAgentHint = String(userAgent);
  const isAndroid = /android/iu.test(userAgentHint);
  const isChromeOS = /cros/iu.test(userAgentHint);
  const isIPadMasqueradingAsMac = maxTouchPoints > 1
    && /macintosh|mac os x/iu.test(userAgentHint);

  if (/windows|win32/iu.test(platformHint)) return "windows";
  if (/macos|macintosh|macintel|darwin/iu.test(platformHint)) {
    return isIPadMasqueradingAsMac ? null : "macos";
  }
  if (/linux|x11/iu.test(platformHint)) {
    return isAndroid || isChromeOS ? null : "linux";
  }

  if (/windows nt|windows/iu.test(userAgentHint)) return "windows";
  if (isAndroid || isChromeOS) return null;
  if (/macintosh|mac os x/iu.test(userAgentHint)) {
    return isIPadMasqueradingAsMac ? null : "macos";
  }
  if (/linux|x11/iu.test(userAgentHint)) return "linux";
  return null;
}

/** Explicit URL and saved choices outrank the low-confidence browser hint. */
export function resolveInitialPublicPlatform({
  urlPlatform = null,
  savedPlatform = null,
  detectedPlatform = null,
} = {}) {
  return normalizePublicPlatform(urlPlatform)
    ?? normalizePublicPlatform(savedPlatform)
    ?? normalizePublicPlatform(detectedPlatform)
    ?? "macos";
}

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readSavedPublicPlatform(storage = browserSessionStorage()) {
  try {
    return normalizePublicPlatform(storage?.getItem(PUBLIC_PLATFORM_STORAGE_KEY));
  } catch {
    return null;
  }
}

function savePublicPlatform(platform, storage = browserSessionStorage()) {
  try {
    storage?.setItem(PUBLIC_PLATFORM_STORAGE_KEY, platform);
  } catch {
    // Storage can be blocked by the browser. Selection still works in-memory.
  }
}

function publicPlatformFromUrl(search = globalThis.location?.search ?? "") {
  try {
    return normalizePublicPlatform(new URLSearchParams(search).get("platform"));
  } catch {
    return null;
  }
}

export function wirePublicPlatformSelector(documentRef = document, {
  navigatorRef = globalThis.navigator,
  locationRef = globalThis.location,
  storage = browserSessionStorage(),
} = {}) {
  const selector = documentRef.querySelector("#platform-selector");
  if (!selector || selector.dataset.platformBound === "true") return null;
  const tabs = [...selector.querySelectorAll('[role="tab"][data-platform]')];
  const panels = new Map(
    [...documentRef.querySelectorAll("[data-platform-panel]")]
      .map((panel) => [panel.dataset.platformPanel, panel]),
  );
  if (
    tabs.length !== PUBLIC_PLATFORMS.length
    || PUBLIC_PLATFORMS.some((platform) => !panels.has(platform))
  ) return null;

  const selectPlatform = (candidate, { focus = false, persist = false } = {}) => {
    const platform = normalizePublicPlatform(candidate);
    if (!platform) return false;
    for (const tab of tabs) {
      const active = tab.dataset.platform === platform;
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
      if (active && focus) tab.focus();
    }
    for (const [panelPlatform, panel] of panels) {
      panel.hidden = panelPlatform !== platform;
    }
    documentRef.documentElement.dataset.downloadPlatform = platform;
    if (persist) savePublicPlatform(platform, storage);
    return true;
  };

  selector.dataset.platformBound = "true";
  selector.addEventListener("click", (event) => {
    const tab = event.target?.closest?.('[role="tab"][data-platform]');
    if (!tab || !selector.contains(tab)) return;
    selectPlatform(tab.dataset.platform, { persist: true });
  });
  selector.addEventListener("keydown", (event) => {
    const tab = event.target?.closest?.('[role="tab"][data-platform]');
    if (!tab || !selector.contains(tab)) return;
    const currentIndex = tabs.indexOf(tab);
    const targetIndex = {
      "ArrowLeft": (currentIndex - 1 + tabs.length) % tabs.length,
      "ArrowRight": (currentIndex + 1) % tabs.length,
      "Home": 0,
      "End": tabs.length - 1,
    }[event.key];
    if (targetIndex === undefined) return;
    event.preventDefault();
    selectPlatform(tabs[targetIndex].dataset.platform, {
      focus: true,
      persist: true,
    });
  });

  const detectedPlatform = detectPublicPlatform({
    userAgentDataPlatform: navigatorRef?.userAgentData?.platform ?? "",
    userAgent: navigatorRef?.userAgent ?? "",
    maxTouchPoints: navigatorRef?.maxTouchPoints ?? 0,
  });
  const initialPlatform = resolveInitialPublicPlatform({
    urlPlatform: publicPlatformFromUrl(locationRef?.search ?? ""),
    savedPlatform: readSavedPublicPlatform(storage),
    detectedPlatform,
  });
  selectPlatform(initialPlatform);
  selector.hidden = false;
  return initialPlatform;
}

function publicErrorCode(candidate) {
  return typeof candidate === "string" && publicErrorCodePattern.test(candidate)
    ? candidate
    : "";
}

function publicRequestId(candidate) {
  return typeof candidate === "string" && publicRequestIdPattern.test(candidate)
    ? candidate
    : "";
}

/**
 * The compact hero link describes the reader-facing daily-series state, not
 * transport health. The detailed safe state copy stays in the disclosure.
 */
export function setPublicDailyPresentation(documentRef, state, {
  failed = false,
} = {}) {
  const hero = documentRef.querySelector("#community-daily-hero");
  const presentation = failed || state === "service_unavailable"
    ? [t("community.daily.seriesUnavailable"), false]
    : {
      published: [t("community.daily.seriesAvailable"), true],
      none_published: [t("community.daily.noneYet"), false],
    }[state] ?? [t("community.daily.seriesUnavailable"), false];
  if (hero) hero.textContent = presentation[0];
  // The hero dot's green heartbeat means "live evidence loaded", so it keys
  // off the same presentation truthiness as the detailed disclosure.
  const heroLink = hero?.closest?.(".community-inline") ?? null;
  if (heroLink) {
    heroLink.setAttribute("data-live", presentation[1] ? "true" : "false");
  }
}

function renderPublicInstallerJourney() {
  const release = renderInstallerJourney(document, {
    compactDetails: true,
    showUnavailableAction: true,
    showReleaseLinks: false,
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  const headerDownloadLabel = $("#header-download-label");
  if (headerDownloadLabel) {
    headerDownloadLabel.dataset.i18n = "installer.headerDownload";
    headerDownloadLabel.textContent = t("installer.headerDownload");
  }
  const homebrewInstall = $("#homebrew-install");
  if (homebrewInstall) homebrewInstall.hidden = release === null;
  const checksumCopy = $("#installer-sha256-copy");
  if (checksumCopy) {
    if (release) checksumCopy.dataset.checksum = release.sha256;
    else delete checksumCopy.dataset.checksum;
  }
  const checksumFallback = $("#installer-sha256");
  if (checksumFallback) {
    checksumFallback.textContent = release?.sha256 ?? "";
    checksumFallback.hidden = true;
  }
  renderInstallerAssurance(document, release);
  return release;
}

export async function copyHomebrewInstallCommand(clipboard) {
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(HOMEBREW_INSTALL_COMMAND);
    return true;
  } catch {
    return false;
  }
}

const installerChecksumPattern = /^[a-f0-9]{64}$/u;

export async function copyInstallerChecksum(checksum, clipboard) {
  if (
    typeof checksum !== "string"
    || !installerChecksumPattern.test(checksum)
    || typeof clipboard?.writeText !== "function"
  ) return false;
  try {
    await clipboard.writeText(checksum);
    return true;
  } catch {
    return false;
  }
}

function selectHomebrewInstallCommand() {
  const command = $("#homebrew-install-command");
  const selection = window.getSelection?.();
  const range = document.createRange?.();
  if (!command || !selection || !range) return;
  range.selectNodeContents(command);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderHomebrewCopyState(state = "idle") {
  const button = $("#homebrew-copy-button");
  const label = $("#homebrew-copy-label");
  const status = $("#homebrew-copy-status");
  if (!button || !label || !status) return;
  const presentation = {
    copied: ["installer.homebrew.copied", "installer.homebrew.copySuccess"],
    failed: ["installer.homebrew.copyManually", "installer.homebrew.copyFailure"],
    idle: ["installer.homebrew.copy", null],
  }[state] ?? ["installer.homebrew.copy", null];
  button.dataset.copyState = state;
  label.dataset.i18n = presentation[0];
  label.textContent = t(presentation[0]);
  status.textContent = presentation[1] ? t(presentation[1]) : "";
}

function wireHomebrewInstallCommand() {
  const button = $("#homebrew-copy-button");
  if (!button || button.dataset.copyBound === "true") return;
  button.dataset.copyBound = "true";
  renderHomebrewCopyState();
  button.addEventListener("click", async () => {
    button.disabled = true;
    const copied = await copyHomebrewInstallCommand(navigator.clipboard);
    button.disabled = false;
    if (!copied) selectHomebrewInstallCommand();
    renderHomebrewCopyState(copied ? "copied" : "failed");
  });
}

function selectInstallerChecksum() {
  const checksum = $("#installer-sha256");
  const selection = window.getSelection?.();
  const range = document.createRange?.();
  if (!checksum || !selection || !range) return;
  checksum.hidden = false;
  range.selectNodeContents(checksum);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderInstallerChecksumCopyState(state = "idle") {
  const button = $("#installer-sha256-copy");
  const label = $("#installer-sha256-copy-label");
  const status = $("#installer-sha256-copy-status");
  const fallback = $("#installer-sha256");
  if (!button || !label || !status || !fallback) return;
  const presentation = {
    copied: ["installer.sha256.copied", "installer.sha256.copySuccess"],
    failed: ["installer.sha256.copy", "installer.sha256.copyFailure"],
    idle: ["installer.sha256.copy", null],
  }[state] ?? ["installer.sha256.copy", null];
  button.dataset.copyState = state;
  label.dataset.i18n = presentation[0];
  label.textContent = t(presentation[0]);
  status.textContent = presentation[1] ? t(presentation[1]) : "";
  fallback.hidden = state !== "failed"
    || !installerChecksumPattern.test(fallback.textContent);
}

function wireInstallerChecksumCopy() {
  const button = $("#installer-sha256-copy");
  if (!button || button.dataset.copyBound === "true") return;
  button.dataset.copyBound = "true";
  renderInstallerChecksumCopyState();
  button.addEventListener("click", async () => {
    button.disabled = true;
    const copied = await copyInstallerChecksum(
      button.dataset.checksum ?? "",
      navigator.clipboard,
    );
    button.disabled = false;
    if (!copied) selectInstallerChecksum();
    renderInstallerChecksumCopyState(copied ? "copied" : "failed");
  });
}

function renderCommunityAllowanceResult(payload) {
  const container = $("#community-allowance-result");
  if (!container) return "service_unavailable";
  const state = renderCommunityAllowanceSection({
    documentRef: document,
    container,
    stateNode: $("#community-allowance-state"),
    payload,
    rangeDays: allowanceRangeDays,
  });
  updateAllowanceDialogAvailability(state);
  if ($("#community-allowance-dialog")?.open) {
    renderCommunityAllowanceDialogResult(payload);
  }
  return state;
}

function renderCommunityAllowanceDialogResult(payload) {
  const container = $("#community-allowance-dialog-result");
  if (!container) return "service_unavailable";
  return renderCommunityAllowanceSection({
    documentRef: document,
    container,
    payload,
    rangeDays: allowanceRangeDays,
  });
}

function allowanceDialogSupported() {
  const dialog = $("#community-allowance-dialog");
  return typeof dialog?.showModal === "function"
    && typeof dialog?.close === "function";
}

function updateAllowanceDialogAvailability(state) {
  const launcher = $("#community-allowance-expand");
  const dialog = $("#community-allowance-dialog");
  const available = state === "published" && allowanceDialogSupported();
  if (launcher) launcher.hidden = !available;
  if (!available && dialog?.open) dialog.close();
}

function syncAllowanceRangeControls() {
  for (const controls of document.querySelectorAll("[data-allowance-range-controls]")) {
    for (const candidate of controls.querySelectorAll("button[data-range-days]")) {
      const candidateRange = candidate.dataset.rangeDays === ""
        ? null
        : Number(candidate.dataset.rangeDays);
      const active = candidateRange === allowanceRangeDays;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
  }
}

function selectAllowanceRange(value) {
  const rangeDays = value === "" ? null : Number(value);
  if (rangeDays !== null && rangeDays !== 30) return;
  allowanceRangeDays = rangeDays;
  syncAllowanceRangeControls();
  if (communityDailySettled) {
    renderCommunityAllowanceResult(lastCommunityDailyPayload);
  }
}

function wireAllowanceRangeControls() {
  for (const controls of document.querySelectorAll("[data-allowance-range-controls]")) {
    if (controls.dataset.allowanceRangeBound === "true") continue;
    controls.dataset.allowanceRangeBound = "true";
    controls.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-range-days]");
      if (!button || !controls.contains(button)) return;
      selectAllowanceRange(button.dataset.rangeDays);
    });
  }
  syncAllowanceRangeControls();
}

function wireAllowanceDialog() {
  const launcher = $("#community-allowance-expand");
  const dialog = $("#community-allowance-dialog");
  const closeButton = $("#community-allowance-dialog-close");
  if (!launcher || !dialog || !closeButton || !allowanceDialogSupported()) {
    if (launcher) launcher.hidden = true;
    return;
  }
  launcher.addEventListener("click", () => {
    if (!communityDailySettled || dialog.open) return;
    renderCommunityAllowanceDialogResult(lastCommunityDailyPayload);
    syncAllowanceRangeControls();
    allowanceDialogReturnFocus = launcher;
    dialog.showModal();
    document.documentElement.classList.add("community-chart-modal-open");
    closeButton.focus();
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("community-chart-modal-open");
    if (!allowanceDialogReturnFocus?.hidden) {
      allowanceDialogReturnFocus?.focus?.();
    }
    allowanceDialogReturnFocus = null;
  });
}

function renderCommunityDailyResult({ payload, failure = null }) {
  renderCommunityAllowanceResult(payload);
  const container = $("#community-daily-result");
  const state = renderCommunityDailySeries({
    documentRef: document,
    container,
    stateNode: $("#community-daily-state"),
    payload,
  });
  $("#community").dataset.communityState = state;
  setPublicDailyPresentation(document, state, { failed: failure !== null });
  if (failure === null) return state;
  // Only the fixed, content-free identifiers the service itself returned are
  // repeated back. This page files no diagnostic note: there is no local
  // companion here to file one with.
  const code = publicErrorCode(failure?.code);
  const requestId = publicRequestId(failure?.requestId);
  const sentences = [
    t("community.daily.failedLoad"),
  ];
  if (code !== "") sentences.push(t("community.reportedCause", { code: code.replace(/_/gu, " ") }));
  if (requestId !== "") sentences.push(t("community.serviceReference", { reference: requestId }));
  const note = document.createElement("p");
  note.className = "annotation";
  note.textContent = sentences.join(" ");
  container.append(note);
  return state;
}

async function loadCommunityDailySeries() {
  let payload = null;
  let failure = null;
  try {
    payload = await communityClient.communityDaily();
  } catch (error) {
    failure = error;
  }
  // A null payload renders the fixed "service unavailable" state, which is
  // separate from a service that answered and has published nothing yet. Keep
  // the settled failure too so a language switch rerenders its safe copy.
  lastCommunityDailyPayload = payload;
  lastCommunityDailyFailure = failure;
  communityDailySettled = true;
  renderCommunityDailyResult({ payload, failure });
}

if (typeof document !== "undefined") {
  renderPublicInstallerJourney();
  wirePublicPlatformSelector();
  wireHomebrewInstallCommand();
  wireInstallerChecksumCopy();
  wireAllowanceRangeControls();
  wireAllowanceDialog();
  void loadCommunityDailySeries();
  window.addEventListener("tibotattle:locale-change", (event) => {
    setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
    setMessageLocale(event.detail?.locale ?? localization.locale());
    renderPublicInstallerJourney();
    renderHomebrewCopyState(
      $("#homebrew-copy-button")?.dataset.copyState ?? "idle",
    );
    renderInstallerChecksumCopyState(
      $("#installer-sha256-copy")?.dataset.copyState ?? "idle",
    );
    if (communityDailySettled) {
      renderCommunityDailyResult({
        payload: lastCommunityDailyPayload,
        failure: lastCommunityDailyFailure,
      });
    }
    localization.localizeTree();
  });
}
