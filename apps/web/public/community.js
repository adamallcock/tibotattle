// Entry point for the public website.
//
// The website is only two things: the community snapshot, and an install
// call-to-action. Both work with no local companion present. Everything that
// needs the companion — the personal dashboard, contribution preparation and
// upload, hosted sign-in, participant deletion, and app-open deep links — is
// deliberately absent here, so this page can never expose or route to a local
// control that cannot work.
//
import { renderCommunitySnapshot } from "./community-view.js";

const $ = (selector) => document.querySelector(selector);

function configuredInstallerUrl(documentRef) {
  const raw = documentRef
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

function configuredInstallerMetadata(documentRef, name, pattern) {
  const value = documentRef
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  return value && pattern.test(value) ? value : null;
}

function configuredReleaseUrl(documentRef, name) {
  const raw = documentRef
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

function configuredInstallerRelease(documentRef) {
  const installerUrl = configuredInstallerUrl(documentRef);
  const version = configuredInstallerMetadata(
    documentRef,
    "usage-monitor-installer-version",
    /^[0-9]+(?:\.[0-9]+){2,3}$/u,
  );
  const sha256 = configuredInstallerMetadata(
    documentRef,
    "usage-monitor-installer-sha256",
    /^[a-f0-9]{64}$/u,
  );
  const byteText = configuredInstallerMetadata(
    documentRef,
    "usage-monitor-installer-bytes",
    /^[1-9][0-9]{0,15}$/u,
  );
  const minimumMacos = configuredInstallerMetadata(
    documentRef,
    "usage-monitor-minimum-macos",
    /^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u,
  );
  const architectureText = configuredInstallerMetadata(
    documentRef,
    "usage-monitor-architectures",
    /^(?:arm64|x86_64)(?:,(?:arm64|x86_64))?$/u,
  );
  const architectures = architectureText?.split(",") ?? [];
  const links = {
    releaseNotes: configuredReleaseUrl(
      documentRef,
      "usage-monitor-release-notes-url",
    ),
    privacy: configuredReleaseUrl(documentRef, "usage-monitor-privacy-url"),
    security: configuredReleaseUrl(documentRef, "usage-monitor-security-url"),
    support: configuredReleaseUrl(documentRef, "usage-monitor-support-url"),
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

/**
 * Public install presentation is intentionally separate from the local app's
 * deep-link installer card. Until all signed-release metadata validates, the
 * page says the Mac app is unavailable rather than leaving download-shaped
 * controls that cannot work.
 */
export function renderPublicInstallerJourney(documentRef) {
  const select = (selector) => documentRef.querySelector(selector);
  const release = configuredInstallerRelease(documentRef);
  const link = select("#installer-link");
  const details = select("#installer-details");
  const releaseLinks = select("#installer-links");
  const unavailable = select("#installer-unavailable");
  const steps = select("#installer-steps");
  if (release) {
    const architectureLabel = release.architectures.length === 2
      ? "Apple silicon and Intel"
      : release.architectures[0] === "arm64"
        ? "Apple silicon"
        : "Intel";
    link.href = release.installerUrl;
    link.hidden = false;
    select("#installer-version").textContent = `Version ${release.version}`;
    select("#installer-compatibility").textContent =
      `Requires macOS ${release.minimumMacos} or later · ${architectureLabel}`;
    select("#installer-size").textContent = formatInstallerSize(release.bytes);
    select("#installer-sha256").textContent = `SHA-256 ${release.sha256}`;
    details.hidden = false;
    for (
      const [id, url] of [
        ["release-notes-link", release.links.releaseNotes],
        ["privacy-link", release.links.privacy],
        ["security-link", release.links.security],
        ["support-link", release.links.support],
      ]
    ) {
      const item = select(`#${id}`);
      item.href = url;
      item.hidden = false;
    }
    releaseLinks.hidden = false;
    unavailable.hidden = true;
    steps.hidden = false;
    return release;
  }
  link.removeAttribute("href");
  link.hidden = true;
  details.hidden = true;
  for (
    const id of [
      "installer-version",
      "installer-compatibility",
      "installer-size",
      "installer-sha256",
    ]
  ) {
    select(`#${id}`).textContent = "";
  }
  for (
    const id of [
      "release-notes-link",
      "privacy-link",
      "security-link",
      "support-link",
    ]
  ) {
    const item = select(`#${id}`);
    item.removeAttribute("href");
    item.hidden = true;
  }
  releaseLinks.hidden = true;
  unavailable.hidden = false;
  steps.hidden = true;
  return null;
}

class PublicCommunityClient {
  async communityStats() {
    const response = await fetch("/api/v1/stats/aggregate", {
      headers: { Accept: "application/json" },
    });
    if (response.ok) return response.json();
    const payload = await response.json().catch(() => null);
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    if (typeof payload?.error?.code === "string"
        && DIAGNOSTIC_CODE_PATTERN.test(payload.error.code)) {
      error.code = payload.error.code;
    }
    if (typeof payload?.error?.requestId === "string"
        && SERVICE_REQUEST_ID_PATTERN.test(payload.error.requestId)) {
      error.requestId = payload.error.requestId;
    }
    throw error;
  }
}

const communityClient = new PublicCommunityClient();

const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIAGNOSTIC_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;

function safeDiagnosticCode(candidate) {
  return typeof candidate === "string" && DIAGNOSTIC_CODE_PATTERN.test(candidate)
    ? candidate
    : "";
}

function safeServiceRequestId(candidate) {
  return typeof candidate === "string" && SERVICE_REQUEST_ID_PATTERN.test(candidate)
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
  const title = documentRef.querySelector("#community-snapshot-title");
  title.textContent = "Seven-day community snapshot";
  if (failed || state === "service_unavailable") {
    chip.textContent = "Snapshot temporarily unavailable";
    chip.className = "evidence-chip neutral";
    return;
  }
  const presentation = {
    published: ["Snapshot available", true],
    published_partial: ["Snapshot partly available", true],
    not_yet_published: ["No snapshot published yet", false],
    withdrawn: ["Snapshot withdrawn", false],
    suppressed: ["No snapshot released this week", false],
    unsupported_schema: ["Snapshot unavailable", false],
    development_unsafe: ["Snapshot unavailable", false],
  }[state] ?? ["Snapshot unavailable", false];
  chip.textContent = presentation[0];
  chip.className = presentation[1] ? "evidence-chip" : "evidence-chip neutral";
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
    setPublicSnapshotPresentation(document, state);
    return;
  }
  setPublicSnapshotPresentation(document, state, { failed: true });
  // Only the fixed, content-free identifiers the service itself returned are
  // repeated back. This page files no diagnostic note: there is no local
  // companion here to file one with.
  const code = safeDiagnosticCode(failure?.code);
  const requestId = safeServiceRequestId(failure?.requestId);
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

if (typeof document !== "undefined") {
  renderPublicInstallerJourney(document);
  void loadCommunitySnapshot();
}
