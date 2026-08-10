import { createRequire } from "node:module";

import { PRODUCT_BRAND } from "./product-brand.js";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json");
const RELEASE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

if (packageManifest.name !== "app-usagemonitor"
    || packageManifest.type !== "module"
    || typeof packageManifest.version !== "string"
    || !RELEASE_VERSION_PATTERN.test(packageManifest.version)) {
  throw new Error("Invalid app-usagemonitor release metadata");
}

export const RELEASE_VERSION = packageManifest.version;
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const RELEASE_VERSION_PLACEHOLDER = "__USAGE_MONITOR_RELEASE_VERSION__";

export const RELEASE_MANIFEST = Object.freeze({
  productName: PRODUCT_BRAND.displayName,
  version: RELEASE_VERSION,
  tag: RELEASE_TAG,
  macOS: Object.freeze({
    arm64DmgFileName:
      `${PRODUCT_BRAND.displayName}-${RELEASE_VERSION}-macOS-arm64.dmg`,
  }),
});
