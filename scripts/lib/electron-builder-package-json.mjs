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

export const ELECTRON_BUILDER_PACKAGE_PROFILES = Object.freeze({
  development: Object.freeze({
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle Dev",
  }),
  "windows-production": Object.freeze({
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

const IGNORED_PACKAGE_PROPERTIES = new Set(
  ELECTRON_BUILDER_IGNORED_PACKAGE_PROPERTIES,
);

function isPackageJsonPath(relativePath) {
  return typeof relativePath === "string"
    && (relativePath === "package.json"
      || (relativePath.startsWith("node_modules/")
        && relativePath.endsWith("/package.json")));
}

/**
 * Return the exact transformed bytes when electron-builder changes this
 * package.json, or null when it leaves the source bytes unchanged.
 */
export function transformElectronBuilderPackageJsonBytes(
  relativePath,
  sourceBytes,
  { profile = "development", packageVersion } = {},
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
  let changed = false;
  if (isMain) {
    // Keep this tuple in the same order as the release config's extraMetadata.
    // Object assignment preserves the source order for existing properties and
    // appends any missing metadata in this order, matching deepAssign.
    for (const [property, value] of Object.entries({
      main: selectedProfile.main,
      name: selectedProfile.name,
      productName: selectedProfile.productName,
      version: packageVersion,
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
