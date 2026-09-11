import { createRequire } from "node:module";

import { PRODUCT_BRAND } from "./product-brand.js";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json");
const RELEASE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const HANDOVER_DISTRIBUTION_KEYS = Object.freeze([
  "appId",
  "buildNumber",
  "channel",
  "contributionPolicy",
  "rehearsalCurrentVersion",
  "rehearsalNextVersion",
  "schemaVersion",
  "semanticVersion",
  "sourceRevision",
  "target",
  "updateFeed",
]);

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validHandoverPackageMetadata({ sourceReleaseVersion, manifest }) {
  const metadata = manifest.tibotattleDistribution;
  if (!hasExactKeys(metadata, HANDOVER_DISTRIBUTION_KEYS)
      || typeof sourceReleaseVersion !== "string"
      || !RELEASE_VERSION_PATTERN.test(sourceReleaseVersion)
      || typeof manifest.version !== "string"
      || typeof metadata.buildNumber !== "string"
      || typeof metadata.semanticVersion !== "string"
      || typeof metadata.rehearsalCurrentVersion !== "string"
      || typeof metadata.rehearsalNextVersion !== "string") {
    return false;
  }
  // Keep the stable/native import closure unchanged. The Electron-only policy
  // is needed only after an explicit handover marker selects this private
  // distribution contract.
  const productionDistribution = require("./electron-production-distribution.cjs");
  const candidate = metadata.semanticVersion === metadata.rehearsalCurrentVersion
    ? "current"
    : metadata.semanticVersion === metadata.rehearsalNextVersion
      ? "next"
      : null;
  const selected = candidate === null ? null
    : productionDistribution.productionElectronDistributionForTarget({
      target: metadata.target,
      rehearsal: candidate,
      rehearsalCurrentVersion: metadata.rehearsalCurrentVersion,
      rehearsalNextVersion: metadata.rehearsalNextVersion,
      minimumRehearsalVersion: sourceReleaseVersion,
    });
  if (selected === null || manifest.version !== selected.semanticVersion
      || metadata.appId !== productionDistribution.PRODUCTION_ELECTRON_APP_ID
      || !productionDistribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(metadata.buildNumber)
      || typeof metadata.sourceRevision !== "string"
      || !/^[0-9a-f]{40}$/u.test(metadata.sourceRevision)) {
    return false;
  }
  return metadata.channel === selected.channel
    && metadata.contributionPolicy === selected.contributionPolicy
    && metadata.schemaVersion === selected.schemaVersion
    && metadata.target === selected.target
    && metadata.updateFeed === selected.feedURL
    && metadata.semanticVersion === selected.semanticVersion
    && metadata.rehearsalCurrentVersion === selected.rehearsalCurrentVersion
    && metadata.rehearsalNextVersion === selected.rehearsalNextVersion;
}

const sourceReleaseVersion = Object.hasOwn(packageManifest, "tibotattleSourceReleaseVersion")
  ? packageManifest.tibotattleSourceReleaseVersion
  : packageManifest.version;
const packagedHandover = Object.hasOwn(packageManifest, "tibotattleSourceReleaseVersion");

if (packageManifest.name !== "app-usagemonitor"
    || packageManifest.type !== "module"
    || typeof packageManifest.version !== "string"
    || (packagedHandover
      ? !validHandoverPackageMetadata({ sourceReleaseVersion, manifest: packageManifest })
      : !RELEASE_VERSION_PATTERN.test(packageManifest.version))) {
  throw new Error("Invalid app-usagemonitor release metadata");
}

// A handover package has a prerelease app version so the updater can order the
// private current/next pair. Runtime clients still identify the reviewed source
// release, never a synthetic public tag for that private package.
export const RELEASE_VERSION = sourceReleaseVersion;
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const RELEASE_VERSION_PLACEHOLDER = "__USAGE_MONITOR_RELEASE_VERSION__";

export const RELEASE_MANIFEST = Object.freeze({
  productName: PRODUCT_BRAND.displayName,
  version: RELEASE_VERSION,
  tag: RELEASE_TAG,
  macOS: Object.freeze({
    arm64DmgFileName:
      `${PRODUCT_BRAND.displayName}-${RELEASE_VERSION}-macOS-arm64.dmg`,
    x64DmgFileName:
      `${PRODUCT_BRAND.displayName}-${RELEASE_VERSION}-macOS-x64.dmg`,
  }),
});
