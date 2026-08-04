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

import { CommunityClient } from "./data-client.js";
import { renderCommunitySnapshot } from "./community-view.js";
import {
  configuredSemanticOpenTarget,
  renderInstallerJourney,
} from "./install-cta.js";
import { diagnosticErrorCode, serviceRequestId } from "./lib.js";

const $ = (selector) => document.querySelector(selector);
const communityClient = new CommunityClient();

function bindInstalledAppLink() {
  const link = $("#open-installed-app");
  const target = configuredSemanticOpenTarget(document);
  if (target) {
    link.href = target;
  } else {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }
  link.addEventListener("click", () => {
    if (!target) return;
    const status = $("#open-installed-app-status");
    status.hidden = false;
    status.textContent =
      "Opening TiboTattle… If no app appears, install the signed Mac download above, then try again.";
  });
}

function setServiceState(text, { reachable }) {
  const state = $("#community-service-state");
  state.textContent = text;
  state.className = reachable ? "evidence-chip" : "evidence-chip neutral";
}

async function loadCommunitySnapshot() {
  const container = $("#community-result");
  const detail = $("#community-snapshot-service-detail");
  let payload = null;
  let failure = null;
  try {
    payload = await communityClient.communityStats();
  } catch (error) {
    failure = error;
  }
  // A null payload renders the fixed "service unavailable" state, which is
  // separate from a service that answered and has published nothing yet.
  const state = renderCommunitySnapshot({
    documentRef: document,
    container,
    detail,
    estimateContainer: $("#community-estimate-result"),
    estimateHero: $("#community-estimate-hero"),
    estimateState: $("#community-estimate-state"),
    estimateStates: [$("#community-estimate-panel-state")],
    payload,
  });
  if (failure === null) {
    setServiceState(
      state === "not_yet_published"
        ? "Community service reachable; nothing published yet"
        : "Community service reachable",
      { reachable: true },
    );
    return;
  }
  setServiceState("Community service unavailable", { reachable: false });
  // Only the fixed, content-free identifiers the service itself returned are
  // repeated back. This page files no diagnostic note: there is no local
  // companion here to file one with.
  const code = diagnosticErrorCode(failure?.code);
  const requestId = serviceRequestId(failure?.requestId);
  const sentences = [
    "The published snapshot could not be loaded. Nothing is inferred from a failed request.",
  ];
  if (code !== "") sentences.push(`Reported cause: ${code.replace(/_/gu, " ")}.`);
  if (requestId !== "") sentences.push(`Service reference ${requestId}.`);
  const note = document.createElement("p");
  note.className = "annotation";
  note.textContent = sentences.join(" ");
  container.append(note);
}

bindInstalledAppLink();
renderInstallerJourney(document);
void loadCommunitySnapshot();
