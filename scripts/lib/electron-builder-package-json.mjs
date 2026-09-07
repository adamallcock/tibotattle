/**
 * Reproduce the package.json byte transformation applied by the pinned
 * electron-builder 26.15.7 configuration.
 *
 * The staged runtime is authenticated before electron-builder runs.  Keeping
 * this small, deterministic transform shared by staging and artifact
 * verification means the manifest authenticates the bytes that the builder
 * will actually place in app.asar, without removing package.json from the
 * inventory.
 */

import distribution from "../../config/electron-production-distribution.cjs";

export const ELECTRON_BUILDER_PACKAGE_PROFILES = Object.freeze({
  development: Object.freeze({
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle Dev",
    desktopName: "com.adamallcock.tibotattle.electron.dev.desktop",
  }),
  "windows-production": Object.freeze({
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle",
  }),
  production: Object.freeze({
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle",
  }),
});

export const ELECTRON_BUILDER_IGNORED_PACKAGE_PROPERTIES = Object.freeze([
  "dist",
  "gitHead",
  "build",
  "jspm",
  "ava",
  "xo",
  "nyc",
  "eslintConfig",
  "contributors",
  "bundleDependencies",
  "tags",
]);

const RELEASE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PRODUCTION_DISTRIBUTION_KEYS = Object.freeze([
  "appId",
  "buildNumber",
  "channel",
  "contributionPolicy",
  "schemaVersion",
  "sourceRevision",
  "target",
  "updateFeed",
]);

const IGNORED_PACKAGE_PROPERTIES = new Set(
  ELECTRON_BUILDER_IGNORED_PACKAGE_PROPERTIES,
);

function isPackageJsonPath(relativePath) {
  return typeof relativePath === "string"
    && (relativePath === "package.json"
      || (relativePath.startsWith("node_modules/")
        && relativePath.endsWith("/package.json")));
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate the exact app-owned policy copied into a production package. */
export function validateProductionDistributionMetadata(value) {
  if (!hasExactKeys(value, PRODUCTION_DISTRIBUTION_KEYS)) {
    throw new TypeError("production distribution metadata is invalid");
  }
  const target = typeof value.target === "string"
    ? distribution.PRODUCTION_ELECTRON_TARGETS[value.target]
    : null;
  if (!target
      || value.appId !== distribution.PRODUCTION_ELECTRON_APP_ID
      || typeof value.buildNumber !== "string"
      || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(value.buildNumber)
      || value.channel !== distribution.PRODUCTION_ELECTRON_CHANNEL
      || value.contributionPolicy !== distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY
      || value.schemaVersion !== distribution.PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION
      || typeof value.sourceRevision !== "string"
      || !SOURCE_REVISION_PATTERN.test(value.sourceRevision)
      || value.updateFeed !== target.feedURL) {
    throw new TypeError("production distribution metadata is invalid");
  }
  return Object.freeze({
    appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    buildNumber: value.buildNumber,
    channel: distribution.PRODUCTION_ELECTRON_CHANNEL,
    contributionPolicy: distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
    schemaVersion: distribution.PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
    sourceRevision: value.sourceRevision,
    target: value.target,
    updateFeed: target.feedURL,
  });
}

export function createProductionDistributionMetadata({ buildNumber, target, sourceRevision } = {}) {
  const targetSpec = typeof target === "string"
    ? distribution.PRODUCTION_ELECTRON_TARGETS[target]
    : null;
  return validateProductionDistributionMetadata({
    appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    buildNumber,
    channel: distribution.PRODUCTION_ELECTRON_CHANNEL,
    contributionPolicy: distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
    schemaVersion: distribution.PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
    sourceRevision,
    target,
    updateFeed: targetSpec?.feedURL,
  });
}

/**
 * Return the exact transformed bytes when electron-builder changes this
 * package.json, or null when it leaves the source bytes unchanged.
 */
export function transformElectronBuilderPackageJsonBytes(
  relativePath,
  sourceBytes,
  { profile = "development", packageVersion, distributionMetadata } = {},
) {
  if (!isPackageJsonPath(relativePath)
      || !(Buffer.isBuffer(sourceBytes) || sourceBytes instanceof Uint8Array)) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(sourceBytes).toString("utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;

  const isMain = relativePath === "package.json";
  const isDependency = !isMain;
  const selectedProfile = typeof profile === "string"
    && Object.hasOwn(ELECTRON_BUILDER_PACKAGE_PROFILES, profile)
    ? ELECTRON_BUILDER_PACKAGE_PROFILES[profile]
    : null;
  if (!selectedProfile
      || (isMain
        && (typeof packageVersion !== "string" || !RELEASE_VERSION_PATTERN.test(packageVersion)))) {
    return null;
  }
  const productionMetadata = profile === "production"
    ? validateProductionDistributionMetadata(distributionMetadata)
    : null;
  if (profile !== "production" && distributionMetadata !== undefined) {
    throw new TypeError("production distribution metadata is not allowed for this profile");
  }
  let changed = false;
  if (isMain) {
    // Keep this tuple in the same order as the release config's extraMetadata.
    // Object assignment preserves the source order for existing properties and
    // appends any missing metadata in this order, matching deepAssign.
    for (const [property, value] of Object.entries({
      main: selectedProfile.main,
      name: selectedProfile.name,
      productName: selectedProfile.productName,
      ...(selectedProfile.desktopName ? { desktopName: selectedProfile.desktopName } : {}),
      version: packageVersion,
      ...(productionMetadata ? { tibotattleDistribution: productionMetadata } : {}),
    })) {
      data[property] = value;
    }
    changed = true;
  }
  const dependencies = data.dependencies;
  const removeBabel = dependencies !== null
    && typeof dependencies === "object"
    && !Object.getOwnPropertyNames(dependencies)
      .some((name) => name.startsWith("babel"));
  for (const property of Object.getOwnPropertyNames(data)) {
    if (property[0] === "_"
        || IGNORED_PACKAGE_PROPERTIES.has(property)
        || property === "scripts"
        || property === "keywords"
        || (isMain && property === "devDependencies")
        || (isDependency && property === "bugs")
        || (removeBabel && property === "babel")) {
      delete data[property];
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(data, null, 2)) : null;
}

/** Return the bytes that should be authenticated in the staged runtime. */
export function canonicalElectronBuilderPackageJsonBytes(
  relativePath,
  sourceBytes,
  options,
) {
  if (options === undefined || options === null) return Buffer.from(sourceBytes);
  const transformed = transformElectronBuilderPackageJsonBytes(
    relativePath,
    sourceBytes,
    options,
  );
  return transformed ?? Buffer.from(sourceBytes);
}
