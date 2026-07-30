#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  SPARKLE_FRAMEWORK_LINKS,
  SPARKLE_MACH_O_PATHS,
  SPARKLE_VERSION,
  normalizeMacOSUpdaterConfiguration,
} from "./macos-updater-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const PRODUCT_BRAND_CONFIG = join(
  REPOSITORY_ROOT,
  "config",
  "product-brand.js",
);
const ENTRYPOINT = join(REPOSITORY_ROOT, "apps", "local", "server.js");
const SWIFT_SOURCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "UsageMonitorApp.swift",
);
const PINNED_NODE_VERSION = "v26.2.0";
const PINNED_NODE_ARCHITECTURE = "arm64";
const MINIMUM_MACOS_VERSION = "13.0";
const BUNDLE_VERSION = "1";
const PACKAGE_NAME = "app-usagemonitor";
const SHORT_VERSION = "0.0.1";
const LOOPBACK_HOST = "127.0.0.1";
const CENTRAL_ORIGIN_MODE_NONE = "not_configured";
const CENTRAL_ORIGIN_MODE_HTTPS = "production_https";
const CENTRAL_ORIGIN_MODE_LOOPBACK = "development_loopback";
const FIXED_EPOCH_SECONDS = 946_684_800;
const MAXIMUM_BUNDLE_BYTES = 512 * 1024 * 1024;
const MANIFEST_SCHEMA = "usage-monitor-macos-app-build-v0.1";
const CODESIGN_PATH = "/usr/bin/codesign";
const SPARKLE_FRAMEWORK_PREFIX =
  "Contents/Frameworks/Sparkle.framework";
const SIGNED_EXECUTABLE_PATH =
  `Contents/MacOS/${PRODUCT_BRAND.executableName}`;
const CODE_RESOURCES_PATH = "Contents/_CodeSignature/CodeResources";
const NORMALIZED_MACH_O_PATHS = new Set([
  SIGNED_EXECUTABLE_PATH,
  "Contents/Resources/runtime/bin/node",
  "Contents/Resources/app/node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  ...SPARKLE_MACH_O_PATHS.map(
    (path) => `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
  ),
]);
const ICON_ASSET = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Assets",
  "AppIcon.icns",
);
const ICON_PROVENANCE = join(
  REPOSITORY_ROOT,
  "apps",
  "macos",
  "Assets",
  "AppIcon.provenance.txt",
);

export const MACOS_RUNTIME_ASSETS = Object.freeze([
  "apps/macos/reset-local-keychain.js",
  "apps/web/public/app.js",
  "apps/web/public/data-client.js",
  "apps/web/public/index.html",
  "apps/web/public/lib.js",
  "apps/web/public/styles.css",
]);

const ALLOWED_GENERATED_RUNTIME_FILES = new Set([
  "generated/telemetry-v0.1-compatibility.json",
  "generated/telemetry-v0.1-field-dictionary.json",
]);

const EXPECTED_EXTERNAL_SPECIFIERS = Object.freeze([
  "@github/keytar",
  "ajv",
  "runcost/browser",
]);

const DYNAMIC_EXTERNAL_BY_FILE = Object.freeze({
  "src/export-identity-keychain.js": "@github/keytar",
});

const PINNED_PACKAGES = Object.freeze({
  "@github/keytar": "7.10.6",
  ajv: "8.20.0",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.4",
  "json-schema-traverse": "1.0.0",
  "require-from-string": "2.0.2",
  runcost: "0.2.0",
});

const SOURCE_PATTERNS = Object.freeze([
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
  /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu,
]);

function fail(message, code = "MACOS_APP_BUILD_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMacOSCentralOrigin(
  value,
  { allowLoopbackCentralOrigin = false } = {},
) {
  if (typeof allowLoopbackCentralOrigin !== "boolean") {
    fail("allowLoopbackCentralOrigin must be a boolean");
  }
  if (value === null || value === undefined || value === "") {
    if (allowLoopbackCentralOrigin) {
      fail("--allow-loopback-central-origin requires --central-origin");
    }
    return Object.freeze({
      configured: false,
      mode: CENTRAL_ORIGIN_MODE_NONE,
      origin: null,
    });
  }
  if (typeof value !== "string" || value.includes("\0")) {
    fail("Central origin must be an absolute HTTPS origin");
  }
  let selected;
  try {
    selected = new URL(value);
  } catch {
    fail("Central origin must be an absolute HTTPS origin");
  }
  if (selected.username || selected.password
      || selected.pathname !== "/" || selected.search || selected.hash) {
    fail("Central origin must not include credentials, a path, query, or fragment");
  }
  const loopback = selected.hostname === LOOPBACK_HOST;
  if (selected.protocol === "http:"
      && loopback
      && selected.port !== ""
      && allowLoopbackCentralOrigin) {
    return Object.freeze({
      configured: true,
      mode: CENTRAL_ORIGIN_MODE_LOOPBACK,
      origin: selected.origin,
    });
  }
  if (selected.protocol === "https:"
      && !["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname)
      && !allowLoopbackCentralOrigin) {
    return Object.freeze({
      configured: true,
      mode: CENTRAL_ORIGIN_MODE_HTTPS,
      origin: selected.origin,
    });
  }
  if (selected.protocol === "http:" && loopback) {
    fail(
      "Plain-HTTP loopback requires --allow-loopback-central-origin and an explicit port",
    );
  }
  fail("Central origin must be HTTPS and non-loopback");
}

export function normalizeMacOSBundleVersion(value = BUNDLE_VERSION) {
  if (typeof value !== "string"
      || !/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u
        .test(value)) {
    fail(
      "Bundle version must contain one to three non-negative decimal components",
    );
  }
  return value;
}

export function validateMacOSDistributionConfiguration({
  centralService,
  externalDistribution = false,
}) {
  if (typeof externalDistribution !== "boolean") {
    fail("externalDistribution must be a boolean");
  }
  if (externalDistribution
      && (!centralService?.configured
        || centralService.mode !== CENTRAL_ORIGIN_MODE_HTTPS)) {
    fail(
      "External distribution requires a fixed non-loopback HTTPS central origin",
      "MACOS_PRODUCTION_ORIGIN_REQUIRED",
    );
  }
  return Object.freeze({
    externalDistribution,
    productionOriginValidated:
      externalDistribution
      && centralService.mode === CENTRAL_ORIGIN_MODE_HTTPS,
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function repositoryRelative(path) {
  const selected = relative(REPOSITORY_ROOT, path);
  if (selected === ""
      || selected === ".."
      || selected.startsWith(`..${sep}`)) {
    fail("A runtime dependency escaped the repository");
  }
  return selected.split(sep).join("/");
}

function packageSpecifier(specifier) {
  if (specifier === "runcost/browser"
      || specifier.startsWith("runcost/")) return "runcost/browser";
  if (specifier === "@github/keytar"
      || specifier.startsWith("@github/keytar/")) return "@github/keytar";
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

async function resolveRelativeSpecifier(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = extname(candidate)
    ? [candidate]
    : [candidate, `${candidate}.js`, join(candidate, "index.js")];
  for (const selected of candidates) {
    let metadata;
    try {
      metadata = await lstat(selected);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      fail(`Runtime source dependency is a symbolic link: ${repositoryRelative(selected)}`);
    }
    if (metadata.isFile()) return selected;
  }
  fail(
    `Static runtime dependency is missing: ${repositoryRelative(fromFile)} -> ${specifier}`,
  );
}

function assertAllowedFirstPartyPath(path) {
  const selected = repositoryRelative(path);
  const forbiddenPrefixes = [
    ".git/",
    ".release-build/",
    ".release-repro/",
    ".usage-monitor/",
    "docs/",
    "exports/",
    "local-review/",
    "test/",
  ];
  if (forbiddenPrefixes.some((prefix) => selected.startsWith(prefix))) {
    fail(`Forbidden repository tree is reachable from the macOS app: ${selected}`);
  }
  if (selected.startsWith("generated/")
      && !ALLOWED_GENERATED_RUNTIME_FILES.has(selected)) {
    fail(`Generated output is not an approved runtime contract: ${selected}`);
  }
  if (/(?:^|\/)(?:credentials?|secrets?|quarantine|reports?|uploads?)(?:\/|$)/iu
      .test(selected)) {
    fail(`Private or generated data path is reachable from the macOS app: ${selected}`);
  }
}

export async function collectMacOSRuntimeGraph(entrypoint = ENTRYPOINT) {
  const pending = [resolve(entrypoint)];
  const files = new Set();
  const builtins = new Set();
  const external = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    assertAllowedFirstPartyPath(file);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`Runtime source is not a regular file: ${repositoryRelative(file)}`);
    }
    files.add(file);
    if (![".js", ".mjs"].includes(extname(file))) continue;
    const source = await readFile(file, "utf8");
    const dynamicExternal = DYNAMIC_EXTERNAL_BY_FILE[repositoryRelative(file)];
    if (dynamicExternal) external.add(dynamicExternal);
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const specifier = match[1];
        if (specifier.startsWith(".")) {
          const dependency = await resolveRelativeSpecifier(file, specifier);
          if (!files.has(dependency)) pending.push(dependency);
        } else if (specifier.startsWith("node:")) {
          builtins.add(specifier);
        } else {
          external.add(packageSpecifier(specifier));
        }
      }
    }
  }
  const externalSpecifiers = [...external].sort();
  if (JSON.stringify(externalSpecifiers)
      !== JSON.stringify(EXPECTED_EXTERNAL_SPECIFIERS)) {
    fail(
      `Unexpected runtime dependency closure: ${externalSpecifiers.join(", ")}`,
    );
  }
  return Object.freeze({
    files: Object.freeze([...files].sort((left, right) =>
      repositoryRelative(left).localeCompare(repositoryRelative(right)))),
    relativeFiles: Object.freeze([...files].map(repositoryRelative).sort()),
    builtins: Object.freeze([...builtins].sort()),
    externalSpecifiers: Object.freeze(externalSpecifiers),
  });
}

async function copyRegularFile(source, destination, mode = 0o444) {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    fail(`Build input is not a regular file: ${basename(source)}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, 0);
  await chmod(destination, mode);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

async function writeGeneratedFile(destination, value, mode = 0o444) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, value, { flag: "wx", mode });
  await chmod(destination, mode);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

function expectedBundleLink(path) {
  const normalized = path.split(sep).join("/");
  const prefix = `${SPARKLE_FRAMEWORK_PREFIX}/`;
  if (!normalized.startsWith(prefix)) return null;
  return SPARKLE_FRAMEWORK_LINKS[normalized.slice(prefix.length)] ?? null;
}

async function walkFiles(root, current = root, {
  allowPinnedSparkleLinks = false,
  links = [],
} = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const selected = relative(root, path);
      const target = await readlink(path);
      const expected = allowPinnedSparkleLinks
        ? expectedBundleLink(selected)
        : null;
      if (target !== expected) {
        fail(`The app bundle contains an unexpected symbolic link: ${selected}`);
      }
      const resolvedTarget = resolve(dirname(path), target);
      const fromRoot = relative(root, resolvedTarget);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        fail(`The app bundle contains an escaping symbolic link: ${selected}`);
      }
      links.push(Object.freeze({
        path: selected.split(sep).join("/"),
        target,
      }));
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, path, {
        allowPinnedSparkleLinks,
        links,
      }));
    }
    else if (entry.isFile()) files.push(path);
    else fail(`The app bundle contains an unsupported file: ${relative(root, path)}`);
  }
  return files;
}

function packageRuntimeFile(relativePath) {
  const first = relativePath.split("/")[0];
  if ([
    ".github",
    "benchmark",
    "benchmarks",
    "example",
    "examples",
    "spec",
    "test",
    "tests",
  ].includes(first)) return false;
  if (relativePath.endsWith(".map")
      || relativePath.endsWith(".d.ts")
      || /^readme/i.test(basename(relativePath))) return false;
  return true;
}

async function copyRuntimePackage({
  name,
  source,
  appRoot,
  include,
  stripSourceMapComments = false,
}) {
  const sourceRoot = await realpath(source);
  for (const file of await walkFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, file).split(sep).join("/");
    if (!include(relativePath)) continue;
    const destination = join(
      appRoot,
      "node_modules",
      ...name.split("/"),
      ...relativePath.split("/"),
    );
    if (stripSourceMapComments && relativePath.endsWith(".js")) {
      const transformed = (await readFile(file, "utf8")).replace(
        /^\s*\/\/# sourceMappingURL=.*$/gmu,
        "",
      );
      await writeGeneratedFile(destination, transformed);
    } else {
      await copyRegularFile(
        file,
        destination,
        /\.(?:node|so|dylib)$/u.test(relativePath) ? 0o555 : 0o444,
      );
    }
  }
}

function readPackage(path) {
  return readFile(path, "utf8").then((text) => JSON.parse(text));
}

async function pinnedPackage(name, packagePath) {
  const manifest = await readPackage(packagePath);
  if (manifest.name !== name || manifest.version !== PINNED_PACKAGES[name]) {
    fail(`Pinned package mismatch for ${name}`);
  }
  return {
    name,
    version: manifest.version,
    license: manifest.license ?? null,
  };
}

async function copyThirdPartyDependencies(appRoot) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const ajvPackage = rootRequire.resolve("ajv/package.json");
  const ajv = await pinnedPackage("ajv", ajvPackage);
  await copyRuntimePackage({
    name: "ajv",
    source: dirname(ajvPackage),
    appRoot,
    include: (path) =>
      path === "package.json"
      || path === "LICENSE"
      || (path.startsWith("dist/")
        && (path.endsWith(".js") || path.endsWith(".json"))),
    stripSourceMapComments: true,
  });

  const ajvRequire = createRequire(ajvPackage);
  const transitiveNames = [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  const transitive = [];
  for (const name of transitiveNames) {
    const packagePath = ajvRequire.resolve(`${name}/package.json`);
    transitive.push(await pinnedPackage(name, packagePath));
    await copyRuntimePackage({
      name,
      source: dirname(packagePath),
      appRoot,
      include: packageRuntimeFile,
      stripSourceMapComments: true,
    });
  }

  const runcostRoot = dirname(rootRequire.resolve("runcost/browser"));
  const runcostPackage = join(runcostRoot, "package.json");
  const runcost = await pinnedPackage("runcost", runcostPackage);
  for (const relativePath of ["browser.js", "package.json"]) {
    await copyRegularFile(
      join(runcostRoot, relativePath),
      join(appRoot, "node_modules", "runcost", relativePath),
    );
  }

  const keytarPackage = rootRequire.resolve("@github/keytar/package.json");
  const keytar = await pinnedPackage("@github/keytar", keytarPackage);
  const keytarRoot = dirname(keytarPackage);
  for (const relativePath of [
    "package.json",
    "LICENSE.md",
    "prebuilds/darwin-arm64/keytar.node",
  ]) {
    await copyRegularFile(
      join(keytarRoot, ...relativePath.split("/")),
      join(
        appRoot,
        "node_modules",
        "@github",
        "keytar",
        ...relativePath.split("/"),
      ),
      relativePath.endsWith(".node") ? 0o555 : 0o444,
    );
  }

  return [keytar, ajv, ...transitive, runcost]
    .map((component) => Object.freeze(component))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function xmlString(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function infoPlist(centralService, {
  bundleVersion,
  iconIncluded,
  updater,
}) {
  const centralServiceConfiguration = centralService.configured
    ? `  <key>UsageMonitorCentralOrigin</key>
  <string>${xmlString(centralService.origin)}</string>
  <key>UsageMonitorCentralOriginMode</key>
  <string>${xmlString(centralService.mode)}</string>
`
    : "";
  const iconConfiguration = iconIncluded
    ? `  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
`
    : "";
  const updaterConfiguration = updater.enabled
    ? `  <key>SUEnableAutomaticChecks</key>
  <true/>
  <key>SUAllowsAutomaticUpdates</key>
  <true/>
  <key>SUAutomaticallyUpdate</key>
  <false/>
  <key>SUFeedURL</key>
  <string>${xmlString(updater.appcastURL)}</string>
  <key>SUPublicEDKey</key>
  <string>${xmlString(updater.publicEdKey)}</string>
  <key>SURequireSignedFeed</key>
  <true/>
  <key>SUVerifyUpdateBeforeExtraction</key>
  <true/>
  <key>UsageMonitorUpdaterEnabled</key>
  <true/>
  <key>UsageMonitorUpdaterFrameworkVersion</key>
  <string>${SPARKLE_VERSION}</string>
`
    : `  <key>UsageMonitorUpdaterEnabled</key>
  <false/>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlString(PRODUCT_BRAND.displayName)}</string>
  <key>CFBundleExecutable</key>
  <string>${xmlString(PRODUCT_BRAND.executableName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlString(PRODUCT_BRAND.bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlString(PRODUCT_BRAND.displayName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${SHORT_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${xmlString(bundleVersion)}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
      <key>CFBundleURLName</key>
      <string>${xmlString(
        `${PRODUCT_BRAND.bundleIdentifier}.${PRODUCT_BRAND.appOpenHost}`,
      )}</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${xmlString(PRODUCT_BRAND.appOpenScheme)}</string>
      </array>
    </dict>
  </array>
  <key>UsageMonitorAppOpenHost</key>
  <string>${xmlString(PRODUCT_BRAND.appOpenHost)}</string>
  <key>UsageMonitorAppOpenScheme</key>
  <string>${xmlString(PRODUCT_BRAND.appOpenScheme)}</string>
  <key>UsageMonitorAppOpenURL</key>
  <string>${xmlString(PRODUCT_BRAND.appOpenURL)}</string>
  <key>UsageMonitorBundleName</key>
  <string>${xmlString(PRODUCT_BRAND.bundleName)}</string>
  <key>UsageMonitorMonitoredAppBundleIdentifier</key>
  <string>${xmlString(PRODUCT_BRAND.monitoredAppBundleIdentifier)}</string>
  <key>UsageMonitorMonitoredAppDisplayName</key>
  <string>${xmlString(PRODUCT_BRAND.monitoredAppDisplayName)}</string>
  <key>UsageMonitorStateDirectoryName</key>
  <string>${xmlString(PRODUCT_BRAND.stateDirectoryName)}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>${MINIMUM_MACOS_VERSION}</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
${iconConfiguration}
${centralServiceConfiguration}
${updaterConfiguration}
</dict>
</plist>
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail(`${basename(command)} is unavailable at ${command}`);
    }
    fail(`${basename(command)} could not be executed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${basename(command)} failed: ${
        (result.stderr || result.stdout || "unknown failure").trim()
      }`,
    );
  }
  return result.stdout.trim();
}

function assertBuildPlatform() {
  if (process.platform !== "darwin"
      || process.arch !== PINNED_NODE_ARCHITECTURE) {
    fail("The macOS app currently builds only on macOS arm64");
  }
  if (process.version !== PINNED_NODE_VERSION) {
    fail(
      `Build requires pinned Node ${PINNED_NODE_VERSION}; found ${process.version}`,
    );
  }
}

function signApplicationBundle(appBundle) {
  run(CODESIGN_PATH, [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    appBundle,
  ]);
  run(CODESIGN_PATH, [
    "--verify",
    "--deep",
    "--strict",
    appBundle,
  ]);
}

function preSignLauncherForInventory(appBundle) {
  run(CODESIGN_PATH, [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    join(appBundle, ...SIGNED_EXECUTABLE_PATH.split("/")),
  ]);
}

async function compileLauncher(destination, updater) {
  const sdk = run("/usr/bin/xcrun", [
    "--sdk",
    "macosx",
    "--show-sdk-path",
  ], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const compileEnvironment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SDKROOT: sdk,
    SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
    ZERO_AR_DATE: "1",
  };
  if (process.env.TMPDIR) compileEnvironment.TMPDIR = process.env.TMPDIR;
  const arguments_ = [
    "--sdk",
    "macosx",
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    "-O",
    "-whole-module-optimization",
    "-target",
    `arm64-apple-macos${MINIMUM_MACOS_VERSION}`,
    "-sdk",
    sdk,
    "-module-name",
    `${PRODUCT_BRAND.executableName}Launcher`,
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
  ];
  if (updater.enabled) {
    arguments_.push(
      "-F",
      dirname(updater.framework.path),
      "-framework",
      "Sparkle",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      "@executable_path/../Frameworks",
    );
  }
  arguments_.push(
    "-o",
    destination,
    SWIFT_SOURCE,
  );
  run("/usr/bin/xcrun", arguments_, { env: compileEnvironment });
  await chmod(destination, 0o555);
  await utimes(destination, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
  const fileDescription = run("/usr/bin/file", ["-b", destination]);
  if (!fileDescription.includes("Mach-O 64-bit executable arm64")) {
    fail("Native launcher is not a macOS arm64 executable");
  }
}

async function copyPinnedSparkleFramework(contents, updater) {
  if (!updater.enabled) return null;
  const destination = join(contents, "Frameworks", "Sparkle.framework");
  for (const entry of updater.framework.entries) {
    const output = join(destination, ...entry.path.split("/"));
    await mkdir(dirname(output), { recursive: true, mode: 0o755 });
    if (entry.type === "link") {
      await symlink(entry.data, output);
      continue;
    }
    await copyRegularFile(
      join(updater.framework.path, ...entry.path.split("/")),
      output,
      Number.parseInt(entry.mode, 8),
    );
  }
  for (const relativePath of SPARKLE_MACH_O_PATHS) {
    const executable = join(destination, ...relativePath.split("/"));
    const replacement = `${executable}.arm64`;
    run("/usr/bin/lipo", [
      executable,
      "-thin",
      PINNED_NODE_ARCHITECTURE,
      "-output",
      replacement,
    ], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    const metadata = await lstat(executable);
    await chmod(replacement, metadata.mode & 0o777);
    await utimes(replacement, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
    await rm(executable);
    await rename(replacement, executable);
  }
  return destination;
}

async function copyPinnedNode(resourcesRoot) {
  const selectedNode = await realpath(process.execPath);
  const nodeVersion = run(selectedNode, ["--version"], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (nodeVersion !== PINNED_NODE_VERSION) {
    fail("The selected Node executable does not match the pinned version");
  }
  const destination = join(resourcesRoot, "runtime", "bin", "node");
  await copyRegularFile(selectedNode, destination, 0o555);
  const nodeLicense = resolve(dirname(selectedNode), "..", "LICENSE");
  await copyRegularFile(
    nodeLicense,
    join(resourcesRoot, "licenses", "node-26.2.0.txt"),
    0o444,
  );
  return Object.freeze({
    architecture: PINNED_NODE_ARCHITECTURE,
    executable: "Contents/Resources/runtime/bin/node",
    sha256: await sha256File(destination),
    version: PINNED_NODE_VERSION.slice(1),
  });
}

async function copyFirstPartyRuntime(appRoot, graph) {
  const repositoryPackage = await readPackage(
    join(REPOSITORY_ROOT, "package.json"),
  );
  if (
    repositoryPackage.name !== PACKAGE_NAME
    || repositoryPackage.version !== SHORT_VERSION
    || repositoryPackage.type !== "module"
  ) {
    fail("Repository package identity does not match the macOS runtime contract");
  }
  for (const source of graph.files) {
    const selected = repositoryRelative(source);
    if (selected === "package.json") continue;
    await copyRegularFile(
      source,
      join(appRoot, ...selected.split("/")),
      0o444,
    );
  }
  for (const selected of MACOS_RUNTIME_ASSETS) {
    if (graph.relativeFiles.includes(selected)) continue;
    assertAllowedFirstPartyPath(join(REPOSITORY_ROOT, selected));
    await copyRegularFile(
      join(REPOSITORY_ROOT, ...selected.split("/")),
      join(appRoot, ...selected.split("/")),
      0o444,
    );
  }
  await writeGeneratedFile(
    join(appRoot, "package.json"),
    stableJson({
      name: repositoryPackage.name,
      version: repositoryPackage.version,
      private: true,
      type: repositoryPackage.type,
      engines: { node: PINNED_NODE_VERSION },
    }),
  );
}

async function copyLicenses(resourcesRoot, updater) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const packageLicenses = [
    ["ajv", rootRequire.resolve("ajv/package.json")],
    ["@github-keytar", rootRequire.resolve("@github/keytar/package.json")],
  ];
  const ajvRequire = createRequire(packageLicenses[0][1]);
  for (const name of [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ]) {
    packageLicenses.push([name, ajvRequire.resolve(`${name}/package.json`)]);
  }
  for (const [outputName, packagePath] of packageLicenses) {
    const root = dirname(packagePath);
    const candidates = (await readdir(root))
      .filter((name) => /^licen[sc]e(?:\.|$)/iu.test(name))
      .sort();
    if (candidates.length !== 1) {
      fail(`Expected one license file for ${outputName}`);
    }
    const version = (await readPackage(packagePath)).version;
    await copyRegularFile(
      join(root, candidates[0]),
      join(resourcesRoot, "licenses", `${outputName}-${version}.txt`),
    );
  }
  await copyRegularFile(
    join(REPOSITORY_ROOT, "third_party_licenses", "runcost-0.2.0.txt"),
    join(resourcesRoot, "licenses", "runcost-0.2.0.txt"),
  );
  if (updater.enabled) {
    await copyRegularFile(
      join(
        REPOSITORY_ROOT,
        "third_party_licenses",
        `sparkle-${SPARKLE_VERSION}.txt`,
      ),
      join(
        resourcesRoot,
        "licenses",
        `sparkle-${SPARKLE_VERSION}.txt`,
      ),
    );
  }
  await writeGeneratedFile(
    join(resourcesRoot, "licenses", "app-usagemonitor-private-poc.txt"),
    `${PRODUCT_BRAND.displayName} is a private proof of concept. No public source-code license is granted by this bundle.\n`,
  );
}

async function readOptionalRegularFile(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`Release asset must be a regular file: ${repositoryRelative(path)}`);
  }
  return Object.freeze({
    bytes: await readFile(path),
    path,
  });
}

async function loadIconAssets({ required }) {
  const icon = await readOptionalRegularFile(ICON_ASSET);
  const provenance = await readOptionalRegularFile(ICON_PROVENANCE);
  if (!icon && !provenance) {
    if (required) {
      fail(
        "External distribution requires approved AppIcon.icns and AppIcon.provenance.txt assets",
        "MACOS_ICON_ASSET_REQUIRED",
      );
    }
    return null;
  }
  if (!icon || !provenance) {
    fail(
      "AppIcon.icns and AppIcon.provenance.txt must be supplied together",
      "MACOS_ICON_PROVENANCE_REQUIRED",
    );
  }
  if (icon.bytes.length < 1_024 || icon.bytes.length > 10 * 1024 * 1024) {
    fail("AppIcon.icns has an implausible size");
  }
  const description = run("/usr/bin/file", ["-b", icon.path]);
  if (!/Apple Icon Image format|Mac OS X icon/iu.test(description)) {
    fail("AppIcon.icns is not a valid Apple icon container");
  }
  if (provenance.bytes.length > 64 * 1024) {
    fail("App icon provenance is too large");
  }
  const provenanceText = provenance.bytes.toString("utf8").trim();
  if (provenanceText.length < 40
      || /\b(?:todo|tbd|unknown|replace me|placeholder)\b/iu
        .test(provenanceText)
      || !/^Source:/mu.test(provenanceText)
      || !/^Rights:/mu.test(provenanceText)
      || !/^License:/mu.test(provenanceText)) {
    fail(
      "App icon provenance must record non-placeholder Source, Rights, and License fields",
      "MACOS_ICON_PROVENANCE_INVALID",
    );
  }
  return Object.freeze({
    icon,
    provenance,
    provenanceText: `${provenanceText}\n`,
  });
}

async function sourceInputDigest(graph, iconAssets = null, updater = null) {
  const inputs = new Set([
    ...graph.files,
    ...MACOS_RUNTIME_ASSETS.map((path) =>
      join(REPOSITORY_ROOT, ...path.split("/"))),
    PRODUCT_BRAND_CONFIG,
    SCRIPT_FILE,
    SWIFT_SOURCE,
    ...(iconAssets
      ? [iconAssets.icon.path, iconAssets.provenance.path]
      : []),
  ]);
  const hash = createHash("sha256");
  for (const file of [...inputs].sort((left, right) =>
    repositoryRelative(left).localeCompare(repositoryRelative(right)))) {
    hash.update(repositoryRelative(file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  if (updater?.enabled) {
    hash.update("sparkle-updater\0");
    hash.update(updater.version);
    hash.update("\0");
    hash.update(updater.framework.sha256);
    hash.update("\0");
    hash.update(updater.appcastURL);
    hash.update("\0");
    hash.update(updater.publicEdKey);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function canonicalizeUnsignedArm64MachO(bytes, label) {
  if (bytes.length < 32
      || bytes.subarray(0, 4).toString("hex") !== "cffaedfe") {
    fail(`Expected a thin 64-bit Mach-O release payload: ${label}`);
  }
  const canonical = Buffer.from(bytes);
  const commandCount = canonical.readUInt32LE(16);
  const commandBytes = canonical.readUInt32LE(20);
  if (commandCount > 1_024
      || 32 + commandBytes > canonical.length) {
    fail(`Mach-O load commands are invalid: ${label}`);
  }
  let offset = 32;
  let linkEditFound = false;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > 32 + commandBytes) {
      fail(`Mach-O load commands are truncated: ${label}`);
    }
    const command = canonical.readUInt32LE(offset);
    const size = canonical.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > 32 + commandBytes) {
      fail(`Mach-O load command size is invalid: ${label}`);
    }
    if (command === 0x19 && size >= 72) {
      const segment = canonical.subarray(offset + 8, offset + 24)
        .toString("ascii")
        .replace(/\0.*$/u, "");
      if (segment === "__LINKEDIT") {
        if (linkEditFound) {
          fail(`Mach-O contains duplicate __LINKEDIT segments: ${label}`);
        }
        linkEditFound = true;
        // Code-signature replacement changes only the rounded virtual size
        // (and may change the stored file size) of __LINKEDIT after the
        // signature blob is removed. The remaining bytes and file offset stay
        // inventoried, so zero only those two envelope-dependent fields.
        canonical.writeBigUInt64LE(0n, offset + 32);
        canonical.writeBigUInt64LE(0n, offset + 48);
      }
    }
    offset += size;
  }
  if (!linkEditFound) {
    fail(`Mach-O has no __LINKEDIT segment: ${label}`);
  }
  return canonical;
}

async function normalizedMachOBytes(file) {
  const inspection = spawnSync(CODESIGN_PATH, ["-d", file], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (inspection.error) {
    fail(`codesign could not inspect ${basename(file)}: ${
      inspection.error.message
    }`);
  }
  if (inspection.status !== 0) {
    fail(`Expected a signed Mach-O release payload: ${basename(file)}`);
  }

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macho-normalize-"),
  );
  const copy = join(temporaryRoot, basename(file));
  try {
    await copyFile(file, copy);
    await chmod(copy, 0o700);
    run(CODESIGN_PATH, ["--remove-signature", copy], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return canonicalizeUnsignedArm64MachO(
      await readFile(copy),
      basename(file),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function bundleInventory(appBundle, manifestPath, updater) {
  const links = [];
  const files = (await walkFiles(appBundle, appBundle, {
    allowPinnedSparkleLinks: updater.enabled,
    links,
  }))
    .filter((path) => {
      if (path === manifestPath) return false;
      return relative(appBundle, path).split(sep).join("/")
        !== CODE_RESOURCES_PATH;
    })
    .sort((left, right) => relative(appBundle, left).localeCompare(
      relative(appBundle, right),
    ));
  const inventory = [];
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  let portableBytes = 0;
  for (const file of files) {
    const path = relative(appBundle, file).split(sep).join("/");
    const metadata = await lstat(file);
    const normalization = NORMALIZED_MACH_O_PATHS.has(path)
      ? "mach_o_without_code_signature"
      : "raw";
    const bytes = normalization === "mach_o_without_code_signature"
      ? await normalizedMachOBytes(file)
      : await readFile(file);
    totalBytes += bytes.length;
    portableBytes += metadata.size;
    aggregate.update(path);
    aggregate.update("\0");
    aggregate.update(bytes);
    aggregate.update("\0");
    inventory.push({
      path,
      bytes: bytes.length,
      mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
      normalization,
      sha256: sha256(bytes),
    });
  }
  const expectedLinks = updater.enabled
    ? Object.entries(SPARKLE_FRAMEWORK_LINKS).map(([path, target]) => ({
      path: `${SPARKLE_FRAMEWORK_PREFIX}/${path}`,
      target,
    })).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  links.sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks)) {
    fail("The app bundle does not contain the exact pinned Sparkle link set");
  }
  for (const link of links) {
    aggregate.update(link.path);
    aggregate.update("\0link\0");
    aggregate.update(link.target);
    aggregate.update("\0");
  }
  if (portableBytes > MAXIMUM_BUNDLE_BYTES) {
    fail("The macOS app exceeds its maximum portable bundle size");
  }
  return Object.freeze({
    files: Object.freeze(inventory),
    links: Object.freeze(links),
    payloadSha256: aggregate.digest("hex"),
    totalBytes,
  });
}

async function privacyCheck(appBundle, updater) {
  const files = await walkFiles(appBundle, appBundle, {
    allowPinnedSparkleLinks: updater.enabled,
  });
  const forbiddenFilePatterns = [
    /(?:^|\/)\.git(?:\/|$)/u,
    /(?:^|\/)\.usage-monitor(?:\/|$)/u,
    /(?:^|\/)local-review(?:\/|$)/u,
    /(?:^|\/)(?:credentials?|quarantine|reports?|secrets?|uploads?)(?:\/|$)/iu,
    /\.(?:db|jsonl|log|pem|pfx|sqlite3?|umx)$/iu,
    /\.(?:d\.ts|map)$/iu,
  ];
  for (const file of files) {
    const selected = relative(appBundle, file).split(sep).join("/");
    if (forbiddenFilePatterns.some((pattern) => pattern.test(selected))) {
      fail(`Forbidden private or generated path in app bundle: ${selected}`);
    }
    const generatedMarker = "/app/generated/";
    if (selected.includes(generatedMarker)) {
      const runtimePath = selected.slice(
        selected.indexOf(generatedMarker) + "/app/".length,
      );
      if (!ALLOWED_GENERATED_RUNTIME_FILES.has(runtimePath)) {
        fail(`Unapproved generated file in app bundle: ${runtimePath}`);
      }
    }
    if (!selected.startsWith("Contents/Resources/app/")
        || !/\.(?:html|js|json|css)$/u.test(selected)) continue;
    const text = await readFile(file, "utf8");
    const prohibited = [
      /\/Users\/[^/\s"']+/u,
      /\/(?:private\/)?var\/folders\//u,
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    ];
    if (prohibited.some((pattern) => pattern.test(text))) {
      fail(`Private value pattern found in bundled first-party file: ${selected}`);
    }
  }
}

async function verifyExistingBuildTarget(output) {
  let metadata;
  try {
    metadata = await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("Refusing to replace a non-directory macOS app target");
  }
  const manifestPath = join(
    output,
    "Contents",
    "Resources",
    "build-manifest.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail(
      `Refusing to replace an app without a valid ${PRODUCT_BRAND.displayName} build marker`,
    );
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA
      || manifest.application?.bundleIdentifier
        !== PRODUCT_BRAND.bundleIdentifier) {
    fail("Refusing to replace an app with an unexpected build marker");
  }
  return true;
}

async function prepareOutput(output) {
  if (basename(output) !== PRODUCT_BRAND.bundleName) {
    fail(
      `Output must end with the exact bundle name ${PRODUCT_BRAND.bundleName}`,
    );
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  if (await realpath(parent) !== parent) {
    fail("Output parent must not traverse a symbolic link");
  }
  return parent;
}

function parseArguments(argv) {
  let output = null;
  let centralOrigin = null;
  let centralOriginSeen = false;
  let allowLoopbackCentralOrigin = false;
  let externalDistribution = false;
  let bundleVersion = BUNDLE_VERSION;
  let bundleVersionSeen = false;
  let sparkleFramework = null;
  let sparkleAppcastURL = null;
  let sparklePublicEdKey = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      if (output !== null || index + 1 >= argv.length) {
        fail("--output must be provided exactly once with a value");
      }
      output = resolve(argv[++index] ?? "");
    } else if (argument === "--central-origin") {
      if (centralOriginSeen || index + 1 >= argv.length) {
        fail("--central-origin must be provided at most once with a value");
      }
      centralOriginSeen = true;
      centralOrigin = argv[++index];
    } else if (argument === "--allow-loopback-central-origin") {
      if (allowLoopbackCentralOrigin) {
        fail("--allow-loopback-central-origin must be provided at most once");
      }
      allowLoopbackCentralOrigin = true;
    } else if (argument === "--external-distribution") {
      if (externalDistribution) {
        fail("--external-distribution must be provided at most once");
      }
      externalDistribution = true;
    } else if (argument === "--bundle-version") {
      if (bundleVersionSeen || index + 1 >= argv.length) {
        fail("--bundle-version must be provided at most once with a value");
      }
      bundleVersionSeen = true;
      bundleVersion = normalizeMacOSBundleVersion(argv[++index]);
    } else if (argument === "--sparkle-framework") {
      if (sparkleFramework !== null || index + 1 >= argv.length) {
        fail("--sparkle-framework must be provided at most once with a value");
      }
      sparkleFramework = resolve(argv[++index] ?? "");
    } else if (argument === "--sparkle-appcast-url") {
      if (sparkleAppcastURL !== null || index + 1 >= argv.length) {
        fail("--sparkle-appcast-url must be provided at most once with a value");
      }
      sparkleAppcastURL = argv[++index];
    } else if (argument === "--sparkle-public-ed-key") {
      if (sparklePublicEdKey !== null || index + 1 >= argv.length) {
        fail("--sparkle-public-ed-key must be provided at most once with a value");
      }
      sparklePublicEdKey = argv[++index];
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!output) fail("--output is required");
  return {
    output,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    bundleVersion,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
  };
}

async function buildApplication(stageApp, centralService, {
  bundleVersion,
  distribution,
  iconAssets,
  updater,
}) {
  const contents = join(stageApp, "Contents");
  const executables = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const appRoot = join(resources, "app");
  await mkdir(executables, { recursive: true, mode: 0o755 });
  await mkdir(appRoot, { recursive: true, mode: 0o755 });

  const graph = await collectMacOSRuntimeGraph();
  await writeGeneratedFile(
    join(contents, "Info.plist"),
    infoPlist(centralService, {
      bundleVersion,
      iconIncluded: iconAssets !== null,
      updater,
    }),
  );
  await writeGeneratedFile(join(contents, "PkgInfo"), "APPL????");
  await compileLauncher(
    join(executables, PRODUCT_BRAND.executableName),
    updater,
  );
  await copyPinnedSparkleFramework(contents, updater);
  const node = await copyPinnedNode(resources);
  await copyFirstPartyRuntime(appRoot, graph);
  const dependencies = await copyThirdPartyDependencies(appRoot);
  await copyLicenses(resources, updater);
  if (iconAssets) {
    await copyRegularFile(
      iconAssets.icon.path,
      join(resources, "AppIcon.icns"),
    );
    await writeGeneratedFile(
      join(resources, "licenses", "app-icon-provenance.txt"),
      iconAssets.provenanceText,
    );
  }
  // Record a signature-independent digest for the launcher. Pre-signing makes
  // `codesign --remove-signature` canonical both here and after the outer app
  // signature is regenerated for Developer ID distribution.
  if (updater.enabled) {
    signApplicationBundle(stageApp);
  } else {
    preSignLauncherForInventory(stageApp);
  }
  await privacyCheck(stageApp, updater);

  const manifestPath = join(resources, "build-manifest.json");
  const inventory = await bundleInventory(stageApp, manifestPath, updater);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    application: {
      bundleIdentifier: PRODUCT_BRAND.bundleIdentifier,
      bundleVersion,
      executable: {
        integrity: "strict_codesign",
        path: SIGNED_EXECUTABLE_PATH,
      },
      minimumMacOSVersion: MINIMUM_MACOS_VERSION,
      name: PRODUCT_BRAND.displayName,
      shortVersion: SHORT_VERSION,
      signing: "ad_hoc_developer_bundle",
    },
    release: {
      appOpenHost: PRODUCT_BRAND.appOpenHost,
      appOpenScheme: PRODUCT_BRAND.appOpenScheme,
      appOpenURL: PRODUCT_BRAND.appOpenURL,
      externalDistributionRequested: distribution.externalDistribution,
      iconIncluded: iconAssets !== null,
      iconSha256: iconAssets ? sha256(iconAssets.icon.bytes) : null,
      provenanceSha256: iconAssets
        ? sha256(Buffer.from(iconAssets.provenanceText, "utf8"))
        : null,
      productionOriginValidated: distribution.productionOriginValidated,
      requiresDeveloperIDAndNotarization:
        distribution.externalDistribution,
      updater: {
        appcastURL: updater.appcastURL,
        automaticChecks: updater.enabled,
        automaticUpdateOptInAvailable: updater.enabled,
        automaticUpdatesEnabledByDefault: false,
        afterUserOptIn: {
          automaticDownload: updater.enabled,
          installOnQuit: updater.enabled,
        },
        enabled: updater.enabled,
        frameworkSha256: updater.framework?.sha256 ?? null,
        frameworkVersion: updater.version,
        publicEdKeySha256: updater.enabled
          ? sha256(Buffer.from(updater.publicEdKey, "base64"))
          : null,
        requiresSignedFeed: updater.enabled,
        verifyBeforeExtraction: updater.enabled,
      },
    },
    runtime: {
      centralService: {
        configured: centralService.configured,
        mode: centralService.mode,
      },
      entrypoint: "Contents/Resources/app/apps/local/server.js",
      node,
      stateRoot:
        `~/Library/Application Support/${PRODUCT_BRAND.stateDirectoryName}`,
      resourceRoot: "Contents/Resources/app",
    },
    privacyBoundary: {
      backgroundUploadAdded: false,
      credentialsIncluded: false,
      generatedTreeIncluded: false,
      loginItemAdded: false,
      localReportsIncluded: false,
      localStateIncluded: false,
      loopbackHost: LOOPBACK_HOST,
      requestedPort: 0,
    },
    inputs: {
      sourceSha256: await sourceInputDigest(graph, iconAssets, updater),
      firstPartyFiles: graph.relativeFiles,
      staticAssets: MACOS_RUNTIME_ASSETS,
      generatedRuntimeContracts: [...ALLOWED_GENERATED_RUNTIME_FILES].sort(),
      builtins: graph.builtins,
      externalSpecifiers: graph.externalSpecifiers,
    },
    dependencies,
    payload: inventory,
  };
  const serialized = stableJson(manifest);
  if (serialized.includes(REPOSITORY_ROOT)
      || serialized.includes("/Users/")
      || serialized.includes("adamallcock")) {
    fail("Build manifest exposed a local source path or owner identifier");
  }
  await writeGeneratedFile(manifestPath, serialized);
  await privacyCheck(stageApp, updater);
  return manifest;
}

export async function buildMacOSApp({
  output,
  centralOrigin = null,
  allowLoopbackCentralOrigin = false,
  externalDistribution = false,
  bundleVersion = BUNDLE_VERSION,
  sparkleFramework = null,
  sparkleAppcastURL = null,
  sparklePublicEdKey = null,
}) {
  const centralService = normalizeMacOSCentralOrigin(centralOrigin, {
    allowLoopbackCentralOrigin,
  });
  const selectedBundleVersion = normalizeMacOSBundleVersion(bundleVersion);
  const distribution = validateMacOSDistributionConfiguration({
    centralService,
    externalDistribution,
  });
  const updater = await normalizeMacOSUpdaterConfiguration({
    appcastURL: sparkleAppcastURL,
    externalDistribution: distribution.externalDistribution,
    frameworkPath: sparkleFramework,
    publicEdKey: sparklePublicEdKey,
  });
  assertBuildPlatform();
  const iconAssets = await loadIconAssets({
    required: distribution.externalDistribution,
  });
  const selectedOutput = resolve(output);
  const outputParent = await prepareOutput(selectedOutput);
  const temporaryRoot = await mkdtemp(
    join(outputParent, ".usage-monitor-macos-build-"),
  );
  const stagedApp = join(temporaryRoot, PRODUCT_BRAND.bundleName);
  try {
    const manifest = await buildApplication(stagedApp, centralService, {
      bundleVersion: selectedBundleVersion,
      distribution,
      iconAssets,
      updater,
    });
    signApplicationBundle(stagedApp);
    if (await verifyExistingBuildTarget(selectedOutput)) {
      await rm(selectedOutput, { recursive: true, force: false });
    }
    await rename(stagedApp, selectedOutput);
    return Object.freeze({
      output: selectedOutput,
      payloadSha256: manifest.payload.payloadSha256,
      totalBytes: manifest.payload.totalBytes,
      sourceSha256: manifest.inputs.sourceSha256,
      centralServiceMode: manifest.runtime.centralService.mode,
      externalDistributionRequested:
        manifest.release.externalDistributionRequested,
      updaterEnabled: manifest.release.updater.enabled,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  const {
    output,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    bundleVersion,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
  } = parseArguments(argv);
  const result = await buildMacOSApp({
    output,
    centralOrigin,
    allowLoopbackCentralOrigin,
    externalDistribution,
    bundleVersion,
    sparkleFramework,
    sparkleAppcastURL,
    sparklePublicEdKey,
  });
  console.log(`${PRODUCT_BRAND.bundleName}: built`);
  console.log(`Output: ${result.output}`);
  console.log(`Payload SHA-256: ${result.payloadSha256}`);
  console.log(`Source SHA-256: ${result.sourceSha256}`);
  console.log(`Payload bytes: ${result.totalBytes}`);
  console.log(`Central service: ${result.centralServiceMode}`);
  console.log(
    `External distribution requested: ${result.externalDistributionRequested}`,
  );
  console.log(`Updater: ${result.updaterEnabled ? "Sparkle 2.9.3" : "disabled"}`);
  console.log("Signing: ad hoc only (not Developer ID; not notarized)");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`build-macos-app: ${error.message}`);
    process.exitCode = 1;
  });
}
