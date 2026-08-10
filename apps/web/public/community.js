// Entry point for the public website.
//
// The website introduces the Mac app, offers its verified installer, and
// renders the community daily activity series. All three work with no local
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
// The allowance range selection: 30/90 calendar days or null for the whole
// published series. Re-rendering is purely client-side — the year window is
// already fetched — so a range change never issues a request.
let allowanceRangeDays = null;
const communityClient = new PublicCommunityClient();

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
 * The badge describes the reader-facing daily-series state, not transport
 * health. The renderer retains the precise safe state copy in the panel body.
 */
export function setPublicDailyPresentation(documentRef, state, {
  failed = false,
} = {}) {
  const title = documentRef.querySelector("#community-title");
  const hero = documentRef.querySelector("#community-daily-hero");
  const panelState = documentRef.querySelector("#community-daily-panel-state");
  const panelStatus = documentRef.querySelector("#community-daily-status");
  if (title) title.textContent = t("community.title");
  const presentation = failed || state === "service_unavailable"
    ? [t("community.daily.seriesUnavailable"), false]
    : {
      published: [t("community.daily.seriesAvailable"), true],
      none_published: [t("community.daily.noneYet"), false],
    }[state] ?? [t("community.daily.seriesUnavailable"), false];
  for (const element of [hero, panelStatus]) {
    if (element) element.textContent = presentation[0];
  }
  if (panelState) {
    panelState.textContent = presentation[0];
    panelState.className = presentation[1]
      ? "evidence-chip"
      : "evidence-chip neutral";
  }
}

function renderPublicInstallerJourney() {
  const release = renderInstallerJourney(document, {
    showUnavailableAction: true,
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  localization.setLegacyText(
    $("#header-download-label"),
    release ? "Download" : "Get the Mac app",
  );
  return release;
}

function renderCommunityAllowanceResult(payload) {
  const container = $("#community-allowance-result");
  if (!container) return;
  renderCommunityAllowanceSection({
    documentRef: document,
    container,
    stateNode: $("#community-allowance-state"),
    payload,
    rangeDays: allowanceRangeDays,
  });
}

function wireAllowanceRangeControls() {
  const controls = $("#community-allowance-range-controls");
  if (!controls) return;
  controls.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-range-days]");
    if (!button) return;
    allowanceRangeDays = button.dataset.rangeDays === ""
      ? null
      : Number(button.dataset.rangeDays);
    for (const candidate of controls.querySelectorAll("button[data-range-days]")) {
      candidate.classList.toggle("active", candidate === button);
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    if (communityDailySettled) {
      renderCommunityAllowanceResult(lastCommunityDailyPayload);
    }
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
  wireAllowanceRangeControls();
  void loadCommunityDailySeries();
  window.addEventListener("tibotattle:locale-change", (event) => {
    setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
    setMessageLocale(event.detail?.locale ?? localization.locale());
    renderPublicInstallerJourney();
    if (communityDailySettled) {
      renderCommunityDailyResult({
        payload: lastCommunityDailyPayload,
        failure: lastCommunityDailyFailure,
      });
    }
    localization.localizeTree();
  });
}
