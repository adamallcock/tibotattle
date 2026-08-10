// Entry point for the public website.
//
// The website introduces the Mac app, offers its verified installer, and
// renders the community aggregate view. All three work with no local companion.
// Everything that
// needs the companion — the personal dashboard, contribution preparation and
// upload, hosted sign-in, participant deletion — is deliberately absent here
// and lives in the Mac app's own window, so this page can never show a control
// that cannot work.
//
// Every rendering routine below is imported, not copied: the install card and
// the community table are the same modules the in-app dashboard entry uses.

import { PublicCommunityClient } from "./community-data.js";
import {
  renderCommunityDailySeries,
  renderCommunitySnapshot,
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
let lastCommunitySnapshotPayload = null;
let lastCommunitySnapshotFailure = null;
let communitySnapshotSettled = false;
let lastCommunityDailyPayload = null;
let communityDailySettled = false;
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
 * The badge describes the reader-facing snapshot state, not transport health.
 * The renderer below retains the precise safe state copy in the panel body.
 */
export function setPublicSnapshotPresentation(documentRef, state, {
  failed = false,
} = {}) {
  const chip = documentRef.querySelector("#community-service-state");
  const title = documentRef.querySelector("#community-title");
  const hero = documentRef.querySelector("#community-snapshot-hero");
  const panelState = documentRef.querySelector("#community-snapshot-panel-state");
  const panelStatus = documentRef.querySelector("#community-snapshot-status");
  if (title) title.textContent = t("community.snapshotTitle");
  if (failed || state === "service_unavailable") {
    chip.textContent = t("community.snapshotUnavailable");
    chip.className = "evidence-chip neutral";
    for (const element of [hero, panelState, panelStatus]) {
      if (element) element.textContent = t("community.snapshotUnavailable");
    }
    return;
  }
  const presentation = {
    published: [t("community.snapshotAvailable"), true],
    published_partial: [t("community.snapshotPartlyAvailable"), true],
    not_yet_published: [t("community.noSnapshotPublished"), false],
    withdrawn: [t("community.snapshotWithdrawn"), false],
    suppressed: [t("community.noSnapshotReleased"), false],
    unsupported_schema: [t("community.snapshotUnavailableShort"), false],
    development_unsafe: [t("community.snapshotUnavailableShort"), false],
  }[state] ?? [t("community.snapshotUnavailableShort"), false];
  chip.textContent = presentation[0];
  chip.className = presentation[1] ? "evidence-chip" : "evidence-chip neutral";
  for (const element of [hero, panelState, panelStatus]) {
    if (element) element.textContent = presentation[0];
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

function renderCommunityResult({ payload, failure = null }) {
  const container = $("#community-result");
  const detail = $("#community-snapshot-service-detail");
  const state = renderCommunitySnapshot({
    documentRef: document,
    container,
    detail,
    payload,
  });
  $("#community").dataset.communityState = state;
  if (failure === null) {
    setPublicSnapshotPresentation(document, state);
    return state;
  }
  setPublicSnapshotPresentation(document, state, { failed: true });
  // Only the fixed, content-free identifiers the service itself returned are
  // repeated back. This page files no diagnostic note: there is no local
  // companion here to file one with.
  const code = publicErrorCode(failure?.code);
  const requestId = publicRequestId(failure?.requestId);
  const sentences = [
    t("community.failedLoad"),
  ];
  if (code !== "") sentences.push(t("community.reportedCause", { code: code.replace(/_/gu, " ") }));
  if (requestId !== "") sentences.push(t("community.serviceReference", { reference: requestId }));
  const note = document.createElement("p");
  note.className = "annotation";
  note.textContent = sentences.join(" ");
  container.append(note);
  return state;
}

function renderCommunityDailyResult(payload) {
  return renderCommunityDailySeries({
    documentRef: document,
    container: $("#community-daily-result"),
    stateNode: $("#community-daily-state"),
    payload,
  });
}

async function loadCommunitySnapshot() {
  let payload = null;
  let failure = null;
  try {
    payload = await communityClient.communityStats();
  } catch (error) {
    failure = error;
  }
  // A null payload renders the fixed "service unavailable" state, which is
  // separate from a service that answered and has published nothing yet. Keep
  // the settled failure too so a language switch rerenders its safe copy.
  lastCommunitySnapshotPayload = payload;
  lastCommunitySnapshotFailure = failure;
  communitySnapshotSettled = true;
  renderCommunityResult({ payload, failure });
}

async function loadCommunityDailySeries() {
  let payload = null;
  try {
    payload = await communityClient.communityDaily();
  } catch {
    // A failed request renders the fixed unavailable state; the daily series
    // repeats no failure identifiers because the weekly panel already does.
    payload = null;
  }
  lastCommunityDailyPayload = payload;
  communityDailySettled = true;
  renderCommunityDailyResult(payload);
}

if (typeof document !== "undefined") {
  renderPublicInstallerJourney();
  void loadCommunitySnapshot();
  void loadCommunityDailySeries();
  window.addEventListener("tibotattle:locale-change", (event) => {
    setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
    setMessageLocale(event.detail?.locale ?? localization.locale());
    renderPublicInstallerJourney();
    if (communitySnapshotSettled) {
      renderCommunityResult({
        payload: lastCommunitySnapshotPayload,
        failure: lastCommunitySnapshotFailure,
      });
    }
    if (communityDailySettled) {
      renderCommunityDailyResult(lastCommunityDailyPayload);
    }
    localization.localizeTree();
  });
}
