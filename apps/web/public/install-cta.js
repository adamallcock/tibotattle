// The install call-to-action. Release metadata arrives as document meta tags
// that the release-site build materializes, so every value shown here is
// checked against a fixed shape before it is displayed: an unverifiable or
// partially injected release renders as "unavailable" rather than as a
// half-filled download card.
//
// Shared by the public site entry (community.js), where it is the primary
// call to action, and by the in-app dashboard entry (app.js), which uses the
// same card when the local companion is not yet reachable.

import { formatNumber } from "./ui-format.js";

export function configuredSemanticOpenTarget(documentRef) {
  const target = documentRef
    .querySelector('meta[name="usage-monitor-semantic-open-target"]')
    ?.getAttribute("content")
    ?.trim();
  return target && /^[a-z][a-z0-9+.-]*:\/\/open$/iu.test(target)
    ? target
    : null;
}

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

export function configuredInstallerRelease(documentRef) {
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

export function formatInstallerSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB download`;
  }
  const mebibytes = bytes / (1024 * 1024);
  return `${formatNumber(mebibytes, {
    maximumFractionDigits: mebibytes >= 10 ? 0 : 1,
  })} MiB download`;
}

export function renderInstallerJourney(documentRef) {
  const select = (selector) => documentRef.querySelector(selector);
  const release = configuredInstallerRelease(documentRef);
  const link = select("#installer-link");
  const details = select("#installer-details");
  const releaseLinks = select("#installer-links");
  const unavailable = select("#installer-unavailable");
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
  return null;
}
