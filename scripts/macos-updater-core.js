import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { isIP } from "node:net";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const SPARKLE_VERSION = "2.9.3";
export const SPARKLE_ARCHIVE_URL =
  "https://github.com/sparkle-project/Sparkle/releases/download/2.9.3/Sparkle-2.9.3.tar.xz";
export const SPARKLE_ARCHIVE_SHA256 =
  "74a07da821f92b79310009954c0e15f350173374a3abe39095b4fc5096916be6";
export const SPARKLE_FRAMEWORK_SHA256 =
  "2a43f8c41a29b195982354d7580036c178ed89e3b3e5dc0d8ab295290d91a0ac";
export const SPARKLE_LICENSE_SHA256 =
  "816be66341dd11b22806862dffd8392b240babaced1cdf24da2ff413ef00c3fd";
export const SPARKLE_UPSTREAM_LICENSE_SHA256 =
  "389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe";

export const SPARKLE_FRAMEWORK_LINKS = Object.freeze({
  Autoupdate: "Versions/Current/Autoupdate",
  Headers: "Versions/Current/Headers",
  Modules: "Versions/Current/Modules",
  PrivateHeaders: "Versions/Current/PrivateHeaders",
  Resources: "Versions/Current/Resources",
  Sparkle: "Versions/Current/Sparkle",
  "Updater.app": "Versions/Current/Updater.app",
  "Versions/Current": "B",
  XPCServices: "Versions/Current/XPCServices",
});

export const SPARKLE_MACH_O_PATHS = Object.freeze([
  "Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer",
  "Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
  "Versions/B/Autoupdate",
  "Versions/B/Updater.app/Contents/MacOS/Updater",
  "Versions/B/Sparkle",
]);

function fail(message, code = "MACOS_UPDATER_CONFIGURATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function pathWithin(root, path) {
  const selected = relative(root, path);
  return selected === "" || (
    selected !== ".." && !selected.startsWith(`..${sep}`)
  );
}

async function frameworkEntries(root, current = root) {
  const entries = [];
  for (const entry of (await readdir(current, {
    withFileTypes: true,
  })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    const selected = relative(root, path).split(sep).join("/");
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      entries.push(...await frameworkEntries(root, path));
    } else if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      const expectedTarget = SPARKLE_FRAMEWORK_LINKS[selected];
      if (target !== expectedTarget) {
        fail(`Sparkle.framework has an unexpected link: ${selected}`);
      }
      const resolvedTarget = resolve(dirname(path), target);
      if (!pathWithin(root, resolvedTarget)) {
        fail(`Sparkle.framework link escapes the framework: ${selected}`);
      }
      entries.push(Object.freeze({
        data: target,
        mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
        path: selected,
        type: "link",
      }));
    } else if (metadata.isFile()) {
      entries.push(Object.freeze({
        data: await readFile(path),
        mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
        path: selected,
        type: "file",
      }));
    } else {
      fail(`Sparkle.framework has an unsupported entry: ${selected}`);
    }
  }
  return entries;
}

export async function inspectPinnedSparkleFramework(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("A reviewed Sparkle.framework path is required");
  }
  const selected = resolve(path);
  if (basename(selected) !== "Sparkle.framework") {
    fail("Updater dependency must be named Sparkle.framework");
  }
  const metadata = await lstat(selected).catch(() => {
    fail("The reviewed Sparkle.framework input is unavailable");
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("The reviewed Sparkle.framework input must be a real directory");
  }
  if (await realpath(selected) !== selected) {
    fail("The reviewed Sparkle.framework path must not traverse a link");
  }
  const entries = await frameworkEntries(selected);
  const observedLinks = entries
    .filter((entry) => entry.type === "link")
    .map((entry) => entry.path)
    .sort();
  const expectedLinks = Object.keys(SPARKLE_FRAMEWORK_LINKS).sort();
  if (JSON.stringify(observedLinks) !== JSON.stringify(expectedLinks)) {
    fail("Sparkle.framework does not contain the exact reviewed link set");
  }
  const observedFiles = new Set(
    entries.filter((entry) => entry.type === "file")
      .map((entry) => entry.path),
  );
  for (const required of [
    "Versions/B/Resources/Info.plist",
    "Versions/B/Modules/module.modulemap",
    ...SPARKLE_MACH_O_PATHS,
  ]) {
    if (!observedFiles.has(required)) {
      fail(`Sparkle.framework is missing ${required}`);
    }
  }
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.mode);
    hash.update("\0");
    hash.update(entry.data);
    hash.update("\0");
  }
  const digest = hash.digest("hex");
  if (digest !== SPARKLE_FRAMEWORK_SHA256) {
    fail(
      "Sparkle.framework does not match the pinned official 2.9.3 release",
      "MACOS_UPDATER_FRAMEWORK_INTEGRITY_FAILED",
    );
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    path: selected,
    sha256: digest,
    version: SPARKLE_VERSION,
  });
}

function normalizeAppcastURL(value) {
  if (typeof value !== "string" || value.length === 0
      || value.includes("\0")) {
    fail("Updater appcast URL is required");
  }
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Updater appcast URL must be an absolute HTTPS URL");
  }
  const hostname = selected.hostname.startsWith("[")
    ? selected.hostname.slice(1, -1)
    : selected.hostname;
  if (selected.protocol !== "https:"
      || selected.username || selected.password
      || selected.search || selected.hash
      || ["localhost", "127.0.0.1", "[::1]"].includes(selected.hostname)
      || isIP(hostname) !== 0
      || selected.pathname === "/"
      || selected.href !== value) {
    fail("Updater appcast URL must be an exact HTTPS DNS URL");
  }
  return selected.href;
}

function normalizePublicEdKey(value) {
  if (typeof value !== "string"
      || !/^[A-Za-z0-9+/]{43}=$/u.test(value)
      || Buffer.from(value, "base64").length !== 32
      || Buffer.from(value, "base64").toString("base64") !== value) {
    fail("Updater public Ed25519 key must be canonical base64 for 32 bytes");
  }
  return value;
}

export function normalizeMacOSUpdaterMetadata({
  appcastURL = null,
  publicEdKey = null,
} = {}) {
  if (appcastURL === null || appcastURL === undefined || appcastURL === ""
      || publicEdKey === null || publicEdKey === undefined
      || publicEdKey === "") {
    fail(
      "Updater appcast URL and public Ed25519 key are required",
      "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION",
    );
  }
  return Object.freeze({
    appcastURL: normalizeAppcastURL(appcastURL),
    publicEdKey: normalizePublicEdKey(publicEdKey),
  });
}

export async function normalizeMacOSUpdaterConfiguration({
  appcastURL = null,
  externalDistribution = false,
  previewDistribution = false,
  frameworkPath = null,
  publicEdKey = null,
} = {}) {
  if (typeof externalDistribution !== "boolean") {
    fail("externalDistribution must be a boolean");
  }
  if (typeof previewDistribution !== "boolean") {
    fail("previewDistribution must be a boolean");
  }
  if (externalDistribution && previewDistribution) {
    fail(
      "Production and preview updater channels are mutually exclusive",
      "MACOS_UPDATER_CHANNEL_CONFLICT",
    );
  }
  const distributionEnabled = externalDistribution || previewDistribution;
  const provided = [appcastURL, frameworkPath, publicEdKey]
    .some((value) => value !== null && value !== undefined && value !== "");
  if (!distributionEnabled) {
    if (provided) {
      fail(
        "Updater inputs are forbidden in development and ad-hoc builds",
        "MACOS_UPDATER_FORBIDDEN_IN_DEVELOPMENT",
      );
    }
    return Object.freeze({
      appcastURL: null,
      automaticChecks: false,
      automaticUpdatesEnabledByDefault: false,
      allowsAutomaticUpdateOptIn: false,
      enabled: false,
      framework: null,
      publicEdKey: null,
      version: null,
    });
  }
  if ([appcastURL, frameworkPath, publicEdKey].some(
    (value) => value === null || value === undefined || value === "",
  )) {
    fail(
      "External distribution requires the reviewed Sparkle framework, appcast URL, and public Ed25519 key",
      "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION",
    );
  }
  const framework = await inspectPinnedSparkleFramework(frameworkPath);
  const metadata = normalizeMacOSUpdaterMetadata({
    appcastURL,
    publicEdKey,
  });
  return Object.freeze({
    appcastURL: metadata.appcastURL,
    // A preview client shares the normal bundle identifier so it can exercise
    // the same OAuth callback registration. It must never silently consume a
    // production-signed update merely because it was opened for testing.
    automaticChecks: externalDistribution,
    automaticUpdatesEnabledByDefault: externalDistribution,
    allowsAutomaticUpdateOptIn: externalDistribution,
    enabled: true,
    framework,
    publicEdKey: metadata.publicEdKey,
    version: SPARKLE_VERSION,
  });
}
