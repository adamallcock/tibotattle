#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARCHITECTURE_APPLICATIONS,
  ARCHITECTURE_APPLICATION_ROOTS,
} from "./lib/application-layout-policy.mjs";
import { extractEsmImports } from "./lib/esm-imports.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const COMMONJS_SOURCE_EXTENSIONS = new Set([".cjs", ".cts"]);
// Electron's sandboxed renderer preload is a deliberate runtime exception:
// Electron provides its restricted renderer bridge through a polyfilled
// CommonJS `require("electron")` and ignores package `type: module` for `.js`
// preloads. Keep this allowlist exact and validate the only permitted require
// below so it cannot become a general CommonJS escape hatch.
const REVIEWED_SANDBOXED_PRELOADS = new Map([
  ["apps/electron/preload.cjs", "electron"],
  ["apps/electron/recovery-preload.cjs", "electron"],
  ["apps/electron/tray-popover-preload.cjs", "electron"],
]);
const REVIEWED_SANDBOXED_PRELOAD_DECLARATION_PATTERN =
  /^const\s*\{\s*contextBridge\s*,\s*ipcRenderer\s*\}\s*=\s*require\(\s*["']electron["']\s*\)\s*;\s*/u;
const IMPORT_META_PATTERN = /\bimport\s*\.\s*meta\b/u;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".release-build",
  ".release-deps",
  ".wrangler",
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "scripts",
  "test",
  "tests",
  "tools",
]);
const TOOLING_FILE_PATTERN =
  /\.(?:check|config|setup|spec|test)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const DECLARATION_FILE_PATTERN = /\.d\.(?:cts|mts|ts)$/u;
const PRODUCT_SOURCE_KINDS = new Set(["app", "package", "shared", "src"]);
const SOURCE_OWNER_AREAS = new Set([
  "application",
  "contribution",
  "export",
  "platform",
  "reporting",
]);
const OWNED_SOURCE_OWNER_KINDS = new Set([
  "feature",
  "platform",
  "provider",
]);
const REVIEWED_SOURCE_OWNER_PUBLIC_ENTRYPOINTS = new Set([
  "src/application/index.js",
  "src/application/claude-callback-capability.js",
  "src/application/local-review.js",
  "src/application/local-contribution-preparation.js",
  "src/application/local-incremental-contribution-sync.js",
  "src/application/local-prepared-contribution.js",
  "src/contribution/index.js",
  "src/contribution/telemetry-v1-chunks.js",
  "src/export/bundle-verification.js",
  "src/export/canonical-json.js",
  "src/export/index.js",
  "src/export/workspace-runtime.js",
  "src/export/set-materialization-runtime.js",
  "src/platform/index.js",
  "src/platform/windows-credential-manager-probe.js",
  "src/platform/claude-callback-lifecycle.js",
  "src/platform/export-identity-keychain.js",
  "src/platform/local-review.js",
  "src/platform/owner-only-prepared-contribution-storage.js",
  "src/platform/telemetry-envelope.js",
  "src/platform/telemetry-v1-envelope.js",
  "src/providers/claude/statusline.js",
  "src/providers/codex/account.js",
  "src/providers/codex/logs.js",
  "src/reporting/index.js",
]);
const REQUIRED_SOURCE_OWNER_PUBLIC_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    area: "contribution",
    category: "contribution_owner_public_entrypoint",
    entrypoint: "src/contribution/index.js",
  }),
  Object.freeze({
    area: "reporting",
    category: "reporting_owner_public_entrypoint",
    entrypoint: "src/reporting/index.js",
  }),
]);
const SOURCE_OWNER_ALLOWED_PACKAGES = new Map([
  ["application", new Set([
    "accounting",
    "quota-analysis",
    "telemetry-contract",
  ])],
  ["contribution", new Set([
    "accounting",
    "identity-core",
    "telemetry-contract",
  ])],
  ["export", new Set(["telemetry-contract"])],
  ["platform", new Set([
    "identity-core",
    "telemetry-contract",
  ])],
  ["provider", new Set(["quota-analysis", "telemetry-contract"])],
  ["reporting", new Set([
    "accounting",
    "quota-analysis",
  ])],
]);
const APP_ALLOWED_PACKAGES = new Map(
  ARCHITECTURE_APPLICATIONS.map(({ allowedPackages, name }) => [
    name,
    new Set(allowedPackages),
  ]),
);
const APPLICATIONS_BY_ROOT = Object.freeze(
  [...ARCHITECTURE_APPLICATIONS]
    .sort((left, right) => right.root.length - left.root.length),
);
const NON_BASELINABLE_ARCHITECTURE_CATEGORIES = new Set([
  "contribution_owner_public_entrypoint",
  "production_import_cycle",
  "retired_production_source_path",
  "reporting_owner_public_entrypoint",
  "source_owner_dependency_direction",
  "source_owner_public_api",
]);
const DIRECT_CREATE_REQUIRE_IMPORT_PATTERN =
  /\bimport\s*\{\s*createRequire\s*\}\s*from\s*["']node:module["']/u;
const DIRECT_CREATE_REQUIRE_BINDING_PATTERN =
  /\b(?:const|let|var)\s+require\s*=\s*createRequire\s*\(\s*import\.meta\.url\s*\)/gu;
const CREATE_REQUIRE_REFERENCE_PATTERN = /\bcreateRequire\b/gu;
const MODULE_CREATE_REQUIRE_PATTERN =
  /\b[A-Za-z_$][\w$]*\s*\.\s*createRequire\s*\(/gu;
const DIRECT_REQUIRE_CALL_PATTERN =
  /\brequire\s*(?:\?\.)?\s*\(\s*([^)]*?)\s*\)/gu;
const STATIC_JSON_REQUIRE_ARGUMENT_PATTERN =
  /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u;
const VERIFIED_NATIVE_BINDING_REQUIRE_EXPRESSION =
  "requireBinding = (path) => require(path)";

export const ARCHITECTURE_BOUNDARY_CATEGORIES = Object.freeze({
  contribution_owner_public_entrypoint: Object.freeze({
    description:
      "The contribution owner must expose its reviewed public entrypoint whenever contribution implementation source is present.",
    remediation:
      "Create src/contribution/index.js and route every external contribution caller through that facade before retaining contribution implementation modules.",
  }),
  reporting_owner_public_entrypoint: Object.freeze({
    description:
      "The reporting owner must expose its reviewed public entrypoint whenever reporting implementation source is present.",
    remediation:
      "Create src/reporting/index.js and migrate external callers through that facade before retaining reporting implementation modules.",
  }),
  production_import_cycle: Object.freeze({
    description:
      "Production modules must form an acyclic first-party dependency graph.",
    remediation:
      "Break the cycle at an ownership boundary by inverting control or extracting a dependency-neutral contract.",
  }),
  source_owner_dependency_direction: Object.freeze({
    description:
      "Production owners must follow the reviewed package, app, provider, platform, and feature dependency directions.",
    remediation:
      "Use reviewed domain or provider facades, and inject concrete platform adapters from an app or command composition root; never reach back into legacy flat source or a forbidden owner.",
  }),
  source_owner_public_api: Object.freeze({
    description:
      "Code outside a source owner must enter that owner through an exact reviewed public entrypoint.",
    remediation:
      "Import the owner's reviewed facade instead of a private implementation module.",
  }),
  retired_production_source_path: Object.freeze({
    description:
      "Retired production source paths must remain absent and no production module may import them.",
    remediation:
      "Use the reviewed replacement package or owner public facade; do not recreate a compatibility forwarder at the retired path.",
  }),
  local_review_legacy_source_dependency: Object.freeze({
    description:
      "The distributable local-review app must not add direct dependencies on flat legacy root source.",
    remediation:
      "Route the operation through the reviewed application or platform facade and remove the exact migration-baseline edge.",
  }),
  legacy_storage_direct_caller: Object.freeze({
    description:
      "The remaining direct callers of legacy storage must match the frozen migration ledger exactly.",
    remediation:
      "Migrate the caller through a reviewed owner facade, then update the ledger in the same focused migration; do not add new direct storage callers.",
  }),
  packages_dependency_direction: Object.freeze({
    description:
      "Reusable packages must not depend on applications, root product source, or tooling.",
    remediation:
      "Move the shared contract into packages/, or inject an adapter from the consuming application.",
  }),
  shared_dependency_direction: Object.freeze({
    description:
      "Transitional shared modules must not depend on applications, root product source, or tooling.",
    remediation:
      "Keep the shared module runtime-neutral, or inject a platform adapter from the consuming application.",
  }),
  src_application_independence: Object.freeze({
    description:
      "Root product source must not depend on an application implementation.",
    remediation:
      "Move the shared behavior into a package or root source module, then let the application depend on it.",
  }),
  worker_root_source_independence: Object.freeze({
    description:
      "Cloudflare Worker production code must not reach back into root src/.",
    remediation:
      "Extract the runtime-neutral behavior into a typed package and keep the Worker-specific adapter in apps/worker.",
  }),
  application_isolation: Object.freeze({
    description:
      "Production code in one application must not import another application's implementation.",
    remediation:
      "Move shared behavior into packages/, or serve a browser asset without importing its application implementation.",
  }),
  workspace_package_public_api: Object.freeze({
    description:
      "Production apps and owned root source must consume workspace packages through each package's reviewed public export.",
    remediation:
      "Import the bare workspace package name instead of a relative path or package subpath.",
  }),
  product_tooling_independence: Object.freeze({
    description:
      "Production applications, packages, and root source must not depend on tools or scripts.",
    remediation:
      "Move runtime behavior into product source and leave scripts/tools as one-way entrypoints.",
  }),
  nonliteral_dynamic_import: Object.freeze({
    description:
      "Production code must use statically reviewable module specifiers.",
    remediation:
      "Replace the computed dynamic import with a literal import or an explicit reviewed module map.",
  }),
  excluded_source_dependency: Object.freeze({
    description:
      "Production code must not load a module excluded from the architecture scan.",
    remediation:
      "Move runtime behavior into a production module, or rename and scan the module if it is not test or tooling code.",
  }),
  commonjs_production_source: Object.freeze({
    description:
      "Production source must use ESM so every dependency is visible to the architecture scanner.",
    remediation:
      "Convert the CommonJS module to ESM; keep CommonJS compatibility wrappers outside production source.",
  }),
  esm_commonjs_loading: Object.freeze({
    description:
      "ESM production code must not use CommonJS loading for executable module dependencies.",
    remediation:
      "Use a statically analyzable ESM import; only reviewed static JSON contracts and the verified native binding loader may use createRequire.",
  }),
});

/**
 * Exact, temporary allowances for dependency debt that predates this ratchet.
 * Globs are intentionally unsupported. Unused entries are diagnostic rather
 * than fatal so a concurrent cleanup can land before its allowance is removed.
 */
const LOCAL_REVIEW_LEGACY_MIGRATION_TARGETS = Object.freeze([]);

/**
 * Deliberately explicit compatibility ledger for the source callers which
 * still use the transitional flat storage facade. New callers are forbidden;
 * removals must update this list as each focused storage slice lands.
 */
export const LEGACY_STORAGE_DIRECT_IMPORTERS = Object.freeze([
  "src/build-weekly-calibration-audit.js",
  "src/cli.js",
  "src/local-collector-state.js",
  "src/passive-collector.js",
  "src/r7-materialized-boundary-benchmark.js",
  "src/r7-real-history-benchmark.js",
  "src/r7-release-evidence-schema.js",
  "src/r7-release-synthetic-evidence.js",
  "src/r7-release-workload-fixture.js",
  "src/r7-resource-benchmark-fixture.js",
  "src/r7-resource-benchmark-schema.js",
  "src/r7-resource-benchmark.js",
  "src/real-local-backend-acceptance.js",
  "src/replay-safe-accounting-cache.js",
  "src/verify-weekly-calibration.js",
]);

/**
 * Removed production modules and compatibility forwarders. This is an exact,
 * permanent absence ledger: unlike migration debt, neither the files nor
 * imports into them may be reintroduced or baselined.
 */
export const RETIRED_PRODUCTION_SOURCE_PATHS = Object.freeze([
  "shared/quota-calibration.js",
  "shared/quota-rolling.js",
  "shared/quota-tracks.js",
  "src/application/local-automatic-contribution.js",
  "src/automatic-contribution.js",
  "src/claude-desktop-quota-refresh.js",
  "src/claude-desktop-quota-state.js",
  "src/codex-log-scan.js",
  "src/contribution/recurrence-policy.js",
  "src/contribution-sync-queue.js",
  "src/cost-ledger.js",
  "src/export-checkpoint-state.js",
  "src/export-deletion-compatibility-internal.js",
  "src/export-deletion-schema.js",
  "src/export-registries.js",
  "src/export-safe-records.js",
  "src/export-set-materializer.js",
  "src/export-source-pipeline-compatibility-internal.js",
  "src/export-versions.js",
  "src/export-workspace-compatibility-internal.js",
  "src/export-workspace-discard-compatibility-internal.js",
  "src/export-workspace-lock-compatibility-internal.js",
  "src/export-workspace-lock.js",
  "src/export-workspace.js",
  "src/local-api-pricing.js",
  "src/metadata-exporter.js",
  "src/price-registry.js",
  "src/tier-semantics.js",
]);
const RETIRED_PRODUCTION_SOURCE_PATH_SET = new Set(
  RETIRED_PRODUCTION_SOURCE_PATHS,
);

/**
 * Entire retired product trees. Any descendant is forbidden, including a new
 * filename that never existed in the removed implementation. This keeps a
 * removed deployment architecture from returning under a fresh entrypoint.
 */
export const RETIRED_PRODUCTION_TREE_PATHS = Object.freeze([
  "apps/cloud-run",
]);
const RETIRED_PRODUCTION_TREE_PATH_SET = new Set(
  RETIRED_PRODUCTION_TREE_PATHS,
);

export const CURRENT_ARCHITECTURE_BOUNDARY_BASELINE = Object.freeze(
  LOCAL_REVIEW_LEGACY_MIGRATION_TARGETS.map((target) => Object.freeze({
    category: "local_review_legacy_source_dependency",
    importer: "local-review/cli.js",
    rationale:
      "This exact local-review CLI dependency predates the distributable-app architecture ratchet.",
    removeWhen:
      "Remove this exact edge when the CLI operation is migrated through a reviewed owned-source facade.",
    target,
  })),
);

function portablePath(value) {
  return value.split(sep).join("/");
}

function sourceLocation(relativePath) {
  const segments = relativePath.split("/");
  if (segments[0] === "src") {
    return {
      kind: "src",
      topLevel: "src",
    };
  }
  if (segments[0] === "packages" && segments.length >= 2) {
    return {
      kind: "package",
      packageName: segments[1],
      topLevel: "packages",
    };
  }
  if (segments[0] === "shared") {
    return {
      kind: "shared",
      topLevel: "shared",
    };
  }
  const application = APPLICATIONS_BY_ROOT.find(({ root }) =>
    relativePath === root || relativePath.startsWith(`${root}/`));
  if (application) {
    return {
      appName: application.name,
      kind: "app",
      topLevel: application.root.split("/")[0],
    };
  }
  if (segments[0] === "apps" && segments.length >= 2) {
    return {
      appName: segments[1],
      kind: "app",
      topLevel: "apps",
    };
  }
  if (segments[0] === "scripts" || segments[0] === "tools") {
    return {
      kind: "tooling",
      topLevel: segments[0],
    };
  }
  return {
    kind: "other",
    topLevel: segments[0] ?? "",
  };
}

function sourceOwner(relativePath) {
  const segments = relativePath.split("/");
  if (segments[0] !== "src") {
    return {
      key: `external:${sourceLocation(relativePath).kind}`,
      kind: "external",
    };
  }
  if (segments[1] === "providers" && segments.length >= 4) {
    return {
      area: "providers",
      key: `provider:${segments[2]}`,
      kind: "provider",
      provider: segments[2],
    };
  }
  if (SOURCE_OWNER_AREAS.has(segments[1]) && segments.length >= 3) {
    return {
      area: segments[1],
      key: `feature:${segments[1]}`,
      kind: segments[1] === "platform" ? "platform" : "feature",
    };
  }
  return {
    key: "legacy:src",
    kind: "legacy",
  };
}

function sourceOwnerPublicApiViolation(importer, target) {
  const destinationOwner = sourceOwner(target);
  if (!OWNED_SOURCE_OWNER_KINDS.has(destinationOwner.kind)) {
    return false;
  }
  const importerOwner = sourceOwner(importer);
  return (
    importerOwner.key !== destinationOwner.key
    && !REVIEWED_SOURCE_OWNER_PUBLIC_ENTRYPOINTS.has(target)
  );
}

function sourceOwnerDependencyDirectionViolation(importer, target) {
  const importerOwner = sourceOwner(importer);
  const destinationOwner = sourceOwner(target);
  const importerLocation = sourceLocation(importer);
  const destinationLocation = sourceLocation(target);
  if (importerLocation.kind === "app") {
    if (destinationLocation.kind === "package") {
      return !APP_ALLOWED_PACKAGES
        .get(importerLocation.appName)
        ?.has(destinationLocation.packageName);
    }
    if (importerLocation.appName === "web") {
      return destinationLocation.kind === "src";
    }
    if (importerLocation.appName === "macos"
        && OWNED_SOURCE_OWNER_KINDS.has(destinationOwner.kind)) {
      return true;
    }
    if (
      new Set(["local", "local-review"]).has(importerLocation.appName)
      && OWNED_SOURCE_OWNER_KINDS.has(destinationOwner.kind)
    ) {
      return !(
        destinationOwner.kind === "platform"
        || destinationOwner.area === "application"
      );
    }
    return false;
  }
  if (!OWNED_SOURCE_OWNER_KINDS.has(importerOwner.kind)) {
    return false;
  }
  if (destinationOwner.kind === "legacy") {
    return true;
  }
  if (destinationLocation.kind === "shared") {
    return true;
  }
  if (destinationLocation.kind === "package") {
    const allowedPackages = SOURCE_OWNER_ALLOWED_PACKAGES.get(
      importerOwner.kind === "provider"
        ? "provider"
        : importerOwner.area,
    );
    return !allowedPackages?.has(destinationLocation.packageName);
  }
  if (importerOwner.key === destinationOwner.key) {
    return false;
  }
  if (!OWNED_SOURCE_OWNER_KINDS.has(destinationOwner.kind)) {
    return false;
  }
  if (importerOwner.kind === "provider" || importerOwner.kind === "platform") {
    return true;
  }
  if (importerOwner.area === "export") {
    return destinationOwner.kind !== "provider";
  }
  if (importerOwner.area === "contribution") {
    return destinationOwner.area !== "export";
  }
  if (importerOwner.area === "application") {
    return !(
      destinationOwner.kind === "provider"
      || new Set(["contribution", "export", "reporting"]).has(
        destinationOwner.area,
      )
    );
  }
  if (importerOwner.area === "reporting") {
    return true;
  }
  return true;
}

function isProductionSource(relativePath) {
  if (!PRODUCT_SOURCE_KINDS.has(sourceLocation(relativePath).kind)) {
    return false;
  }
  const segments = relativePath.split("/");
  return (
    !DECLARATION_FILE_PATTERN.test(segments.at(-1) ?? "") &&
    !segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment)) &&
    !TOOLING_FILE_PATTERN.test(segments.at(-1) ?? "")
  );
}

function isExcludedProductSource(relativePath) {
  return (
    PRODUCT_SOURCE_KINDS.has(sourceLocation(relativePath).kind) &&
    SOURCE_EXTENSIONS.has(extname(relativePath)) &&
    !DECLARATION_FILE_PATTERN.test(relativePath) &&
    !isProductionSource(relativePath)
  );
}

function sourceLineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function staticJsonRequireArgument(argument) {
  const value = argument.trim().replace(/,$/u, "").trim();
  if (!STATIC_JSON_REQUIRE_ARGUMENT_PATTERN.test(value)) return false;
  const unquoted = value.slice(1, -1);
  return unquoted.endsWith(".json");
}

async function isReviewedSandboxedPreload(relativePath, source) {
  const requiredSpecifier = REVIEWED_SANDBOXED_PRELOADS.get(relativePath);
  const declaration = source.match(
    REVIEWED_SANDBOXED_PRELOAD_DECLARATION_PATTERN,
  );
  if (requiredSpecifier === undefined
      || DIRECT_CREATE_REQUIRE_IMPORT_PATTERN.test(source)
      || CREATE_REQUIRE_REFERENCE_PATTERN.test(source)
      || MODULE_CREATE_REQUIRE_PATTERN.test(source)
      || requiredSpecifier !== "electron"
      || declaration === null
      || IMPORT_META_PATTERN.test(source)) {
    CREATE_REQUIRE_REFERENCE_PATTERN.lastIndex = 0;
    MODULE_CREATE_REQUIRE_PATTERN.lastIndex = 0;
    return false;
  }
  CREATE_REQUIRE_REFERENCE_PATTERN.lastIndex = 0;
  MODULE_CREATE_REQUIRE_PATTERN.lastIndex = 0;
  if (/\brequire\b/u.test(source.slice(declaration[0].length))) {
    return false;
  }
  DIRECT_REQUIRE_CALL_PATTERN.lastIndex = 0;
  const calls = [...source.matchAll(DIRECT_REQUIRE_CALL_PATTERN)];
  DIRECT_REQUIRE_CALL_PATTERN.lastIndex = 0;
  if (
    calls.length !== 1
    || calls[0][1].trim() !== JSON.stringify(requiredSpecifier)
  ) {
    return false;
  }
  // The exception is intentionally a CommonJS bridge with one fixed require,
  // so even a valid-looking preload must not gain static or dynamic ESM
  // imports that bypass this allowlist. The normal import graph still runs
  // below for the accepted file; this check only rejects the exception shape.
  try {
    const imports = await extractEsmImports(source, {
      sourceName: relativePath,
    });
    return imports.length === 0;
  } catch {
    return false;
  }
}

function esmCommonJsLoadingIssue(source) {
  const memberMatch = MODULE_CREATE_REQUIRE_PATTERN.exec(source);
  MODULE_CREATE_REQUIRE_PATTERN.lastIndex = 0;
  if (memberMatch) {
    return {
      line: sourceLineNumber(source, memberMatch.index),
      specifier: "<module.createRequire>",
    };
  }

  const createRequireReferences = [
    ...source.matchAll(CREATE_REQUIRE_REFERENCE_PATTERN),
  ];
  DIRECT_CREATE_REQUIRE_BINDING_PATTERN.lastIndex = 0;
  const bindings = [...source.matchAll(DIRECT_CREATE_REQUIRE_BINDING_PATTERN)];
  if (createRequireReferences.length > 0) {
    if (
      !DIRECT_CREATE_REQUIRE_IMPORT_PATTERN.test(source)
      || bindings.length !== 1
      || createRequireReferences.length !== 2
    ) {
      return {
        line: sourceLineNumber(source, createRequireReferences[0].index),
        specifier: "<createRequire>",
      };
    }
  }

  const inspectableSource = source.replace(
    VERIFIED_NATIVE_BINDING_REQUIRE_EXPRESSION,
    "requireBinding = verifiedNativeBinding(path)",
  );
  DIRECT_REQUIRE_CALL_PATTERN.lastIndex = 0;
  for (const match of inspectableSource.matchAll(DIRECT_REQUIRE_CALL_PATTERN)) {
    if (!staticJsonRequireArgument(match[1])) {
      return {
        line: sourceLineNumber(source, match.index),
        specifier: "<require>",
      };
    }
  }
  return null;
}

async function collectProductionSourceFiles(rootDirectory) {
  const files = [];

  async function visit(absoluteDirectory) {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = portablePath(relative(rootDirectory, absolutePath));
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }
      if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        isProductionSource(relativePath)
      ) {
        files.push(relativePath);
      }
    }
  }

  const productionRoots = new Set([
    "apps",
    "packages",
    "shared",
    "src",
    ...ARCHITECTURE_APPLICATION_ROOTS.filter((root) =>
      root !== "apps" && !root.startsWith("apps/")),
  ]);
  for (const rootName of productionRoots) {
    await visit(join(rootDirectory, rootName));
  }
  return files.sort();
}

async function discoverWorkspacePackages(rootDirectory) {
  const packages = new Map();

  for (const container of ["apps", "packages", "tools"]) {
    const containerDirectory = join(rootDirectory, container);
    let entries;
    try {
      entries = await readdir(containerDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const packageFile = join(containerDirectory, entry.name, "package.json");
      try {
        const manifest = JSON.parse(await readFile(packageFile, "utf8"));
        if (typeof manifest.name === "string" && manifest.name.length > 0) {
          if (packages.has(manifest.name)) {
            throw new Error(
              `Duplicate workspace package name ${manifest.name} in ${packageFile}.`,
            );
          }
          packages.set(manifest.name, {
            directory: `${container}/${entry.name}`,
            publicRoot: workspacePackagePublicRoot({
              directory: `${container}/${entry.name}`,
              manifest,
            }),
          });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new Error(`Unable to read ${packageFile}: ${error.message}`, {
            cause: error,
          });
        }
      }
    }
  }

  return [...packages.entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
}

function conditionalExportTarget(value) {
  if (typeof value === "string") {
    return value.startsWith("./") ? value.slice(2) : null;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = conditionalExportTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const condition of ["import", "node", "browser", "default"]) {
    if (Object.hasOwn(value, condition)) {
      const target = conditionalExportTarget(value[condition]);
      if (target) return target;
    }
  }
  for (const condition of Object.keys(value).sort()) {
    const target = conditionalExportTarget(value[condition]);
    if (target) return target;
  }
  return null;
}

function workspacePackagePublicRoot({ directory, manifest }) {
  let rootExport = manifest.exports;
  if (
    rootExport
    && typeof rootExport === "object"
    && !Array.isArray(rootExport)
  ) {
    if (Object.hasOwn(rootExport, ".")) {
      rootExport = rootExport["."];
    } else if (Object.keys(rootExport).some((key) => key.startsWith("."))) {
      rootExport = null;
    }
  }
  const exported = conditionalExportTarget(rootExport);
  const fallback = [manifest.module, manifest.main, "index.js"].find(
    (value) => typeof value === "string" && value.length > 0,
  );
  const target = exported ?? fallback;
  return target
    ? portablePath(join(directory, target.replace(/^\.\//u, "")))
    : directory;
}

function resolveFirstPartyTarget({
  importer,
  packageLocations,
  rootDirectory,
  specifier,
}) {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
  let absoluteTarget;

  if (
    cleanSpecifier.startsWith("./") ||
    cleanSpecifier.startsWith("../")
  ) {
    absoluteTarget = resolve(
      rootDirectory,
      dirname(importer),
      cleanSpecifier,
    );
  } else if (cleanSpecifier.startsWith("file:")) {
    try {
      absoluteTarget = fileURLToPath(cleanSpecifier);
    } catch {
      return null;
    }
  } else if (isAbsolute(cleanSpecifier)) {
    absoluteTarget = resolve(cleanSpecifier);
  } else {
    const workspacePackage = packageLocations.find(
      ([name]) =>
        cleanSpecifier === name || cleanSpecifier.startsWith(`${name}/`),
    );
    if (!workspacePackage) {
      return null;
    }
    const [name, packageMetadata] = workspacePackage;
    const { directory: packageDirectory, publicRoot } = packageMetadata;
    const subpath =
      cleanSpecifier === name ? "" : cleanSpecifier.slice(name.length + 1);
    absoluteTarget = resolve(
      rootDirectory,
      subpath === "" ? publicRoot : join(packageDirectory, subpath),
    );
  }

  const relativeTarget = portablePath(relative(rootDirectory, absoluteTarget));
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith("../") ||
    relativeTarget === ""
  ) {
    return null;
  }
  return relativeTarget;
}

function violationCategory(importer, target) {
  const source = sourceLocation(importer);
  const destination = sourceLocation(target);

  if (
    source.kind === "app"
    && source.appName === "local-review"
    && destination.kind === "src"
    && sourceOwner(target).kind === "legacy"
  ) {
    return "local_review_legacy_source_dependency";
  }
  if (
    PRODUCT_SOURCE_KINDS.has(source.kind)
    && destination.kind === "tooling"
  ) {
    return "product_tooling_independence";
  }
  if (
    source.kind === "package" &&
    (
      new Set(["apps", "scripts", "src", "tools"]).has(destination.topLevel)
      || (
        destination.kind === "package"
        && source.packageName !== destination.packageName
      )
    )
  ) {
    return "packages_dependency_direction";
  }
  if (
    source.kind === "shared" &&
    new Set(["apps", "scripts", "src", "tools"]).has(destination.topLevel)
  ) {
    return "shared_dependency_direction";
  }
  if (source.kind === "src" && destination.kind === "app") {
    return "src_application_independence";
  }
  if (
    source.kind === "app" &&
    source.appName === "worker" &&
    destination.kind === "src"
  ) {
    return "worker_root_source_independence";
  }
  if (
    source.kind === "app" &&
    destination.kind === "app" &&
    source.appName !== destination.appName
  ) {
    return "application_isolation";
  }
  return null;
}

function workspacePackagePublicApiViolation({
  importer,
  packageLocations,
  specifier,
  target,
}) {
  const importerLocation = sourceLocation(importer);
  const importerOwner = sourceOwner(importer);
  if (
    importerLocation.kind !== "app"
    && importerLocation.kind !== "src"
    && !OWNED_SOURCE_OWNER_KINDS.has(importerOwner.kind)
  ) {
    return false;
  }
  if (sourceLocation(target).kind !== "package") {
    return false;
  }
  const targetPackage = packageLocations.find(([, { directory }]) => (
    target === directory || target.startsWith(`${directory}/`)
  ));
  return Boolean(targetPackage && specifier !== targetPackage[0]);
}

function sourceTargetCandidates(target) {
  const candidates = [target];
  if (!SOURCE_EXTENSIONS.has(extname(target))) {
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(`${target}${extension}`);
      candidates.push(`${target}/index${extension}`);
    }
  }
  return candidates;
}

function retiredProductionSourceTarget(target) {
  const exactTarget = sourceTargetCandidates(target).find((candidate) =>
    RETIRED_PRODUCTION_SOURCE_PATH_SET.has(candidate));
  if (exactTarget) return exactTarget;
  return [...RETIRED_PRODUCTION_TREE_PATH_SET].find((retiredTree) => (
    target === retiredTree || target.startsWith(`${retiredTree}/`)
  )) ?? null;
}

async function pathContainsSymbolicLink(rootDirectory, relativePath) {
  let current = rootDirectory;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return false;
      }
      throw error;
    }
  }
  return false;
}

async function inspectFirstPartyTarget({
  productionFiles,
  rootDirectory,
  target,
}) {
  for (const candidate of sourceTargetCandidates(target)) {
    let stats;
    try {
      stats = await lstat(join(rootDirectory, candidate));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    const symbolicLink = await pathContainsSymbolicLink(
      rootDirectory,
      candidate,
    );
    if (symbolicLink || stats.isFile()) {
      return {
        excluded: symbolicLink || isExcludedProductSource(candidate),
        graphTarget: productionFiles.has(candidate) ? candidate : null,
        target: candidate,
      };
    }
  }
  return {
    excluded: isExcludedProductSource(target),
    graphTarget: null,
    target,
  };
}

function canonicalGraphEdges(edges) {
  return [...edges].sort(
    (left, right) =>
      left.target.localeCompare(right.target)
      || left.line - right.line
      || left.kind.localeCompare(right.kind)
      || left.specifier.localeCompare(right.specifier),
  );
}

function stronglyConnectedComponents(nodes, edgesByImporter) {
  let nextIndex = 0;
  const nodeIndex = new Map();
  const lowLink = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    nodeIndex.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const { target } of canonicalGraphEdges(
      edgesByImporter.get(node) ?? [],
    )) {
      if (!nodeIndex.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(target)));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node), nodeIndex.get(target)));
      }
    }

    if (lowLink.get(node) !== nodeIndex.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  }

  for (const node of [...nodes].sort()) {
    if (!nodeIndex.has(node)) visit(node);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function deterministicCycle(component, edgesByImporter) {
  const members = new Set(component);
  const start = component[0];
  const path = [start];
  const visited = new Set([start]);

  function search(node) {
    for (const edge of canonicalGraphEdges(
      edgesByImporter.get(node) ?? [],
    ).filter(({ target }) => members.has(target))) {
      if (edge.target === start) {
        return {
          edges: [...path.slice(0, -1).map((_, index) => {
            const source = path[index];
            const destination = path[index + 1];
            return canonicalGraphEdges(edgesByImporter.get(source) ?? [])
              .find(({ target }) => target === destination);
          }), edge],
          nodes: [...path, start],
        };
      }
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      path.push(edge.target);
      const cycle = search(edge.target);
      if (cycle) return cycle;
      path.pop();
      visited.delete(edge.target);
    }
    return null;
  }

  return search(start);
}

function productionCycleViolations(files, graphEdges) {
  const edgesByImporter = new Map(files.map((file) => [file, []]));
  for (const edge of graphEdges) {
    edgesByImporter.get(edge.importer)?.push(edge);
  }
  const violations = [];
  for (const component of stronglyConnectedComponents(files, edgesByImporter)) {
    const selfCycle = component.length === 1
      && (edgesByImporter.get(component[0]) ?? [])
        .some(({ target }) => target === component[0]);
    if (component.length === 1 && !selfCycle) continue;
    const cycle = deterministicCycle(component, edgesByImporter);
    if (!cycle) {
      throw new Error(
        `Unable to materialize detected production cycle: ${component.join(", ")}`,
      );
    }
    const firstEdge = cycle.edges[0];
    violations.push({
      category: "production_import_cycle",
      cycle: cycle.nodes,
      importer: cycle.nodes[0],
      kind: firstEdge.kind,
      line: firstEdge.line,
      specifier: firstEdge.specifier,
      target: cycle.nodes[1],
    });
  }
  return violations;
}

function baselineKey({ category, importer, target }) {
  return `${category}\u0000${importer}\u0000${target}`;
}

function validateBaseline(baseline) {
  const issues = [];
  const entries = new Map();

  if (!Array.isArray(baseline)) {
    return {
      entries,
      issues: ["The architecture boundary baseline must be an array."],
    };
  }

  for (const [index, entry] of baseline.entries()) {
    const label = `Baseline entry ${index + 1}`;
    if (!entry || typeof entry !== "object") {
      issues.push(`${label} must be an object.`);
      continue;
    }
    if (!Object.hasOwn(ARCHITECTURE_BOUNDARY_CATEGORIES, entry.category)) {
      issues.push(`${label} has an unknown category: ${entry.category}.`);
      continue;
    }
    if (NON_BASELINABLE_ARCHITECTURE_CATEGORIES.has(entry.category)) {
      issues.push(
        `${label} cannot allow the non-baselinable structural category: ${entry.category}.`,
      );
      continue;
    }
    if (
      typeof entry.importer !== "string" ||
      typeof entry.target !== "string" ||
      entry.importer.startsWith("/") ||
      entry.target.startsWith("/") ||
      entry.importer.includes("..") ||
      entry.target.includes("..")
    ) {
      issues.push(`${label} must use normalized repository-relative paths.`);
      continue;
    }
    if (
      typeof entry.rationale !== "string" ||
      entry.rationale.trim().length < 20 ||
      typeof entry.removeWhen !== "string" ||
      entry.removeWhen.trim().length < 20
    ) {
      issues.push(
        `${label} must document both a rationale and a concrete removal condition.`,
      );
      continue;
    }

    const normalized = {
      ...entry,
      importer: portablePath(entry.importer),
      target: portablePath(entry.target),
    };
    const key = baselineKey(normalized);
    if (entries.has(key)) {
      issues.push(`${label} duplicates an earlier exact allowance.`);
      continue;
    }
    entries.set(key, normalized);
  }

  return {
    entries,
    issues,
  };
}

export async function checkArchitectureBoundaries({
  baseline = CURRENT_ARCHITECTURE_BOUNDARY_BASELINE,
  rootDirectory = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  const absoluteRoot = resolve(rootDirectory);
  const files = await collectProductionSourceFiles(absoluteRoot);
  const packageLocations = await discoverWorkspacePackages(absoluteRoot);
  const baselineValidation = validateBaseline(baseline);
  const detectedViolations = [];
  const graphEdges = [];
  const productionFiles = new Set(files);
  let importCount = 0;

  for (const retiredPath of [
    ...RETIRED_PRODUCTION_SOURCE_PATHS,
    ...RETIRED_PRODUCTION_TREE_PATHS,
  ]) {
    try {
      await lstat(join(absoluteRoot, retiredPath));
      detectedViolations.push({
        category: "retired_production_source_path",
        importer: retiredPath,
        kind: "retired-path-exists",
        line: 1,
        specifier: "<retired-source-ledger>",
        target: retiredPath,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  for (const {
    area,
    category,
    entrypoint,
  } of REQUIRED_SOURCE_OWNER_PUBLIC_ENTRYPOINTS) {
    const implementationExists = files.some((file) => (
      file.startsWith(`src/${area}/`)
      && file !== entrypoint
    ));
    if (!implementationExists || productionFiles.has(entrypoint)) continue;
    detectedViolations.push({
      category,
      importer: entrypoint,
      kind: "required-owner-index",
      line: 1,
      specifier: "<required-owner-index>",
      target: entrypoint,
    });
  }

  for (const importer of files) {
    const source = await readFile(join(absoluteRoot, importer), "utf8");
    const reviewedSandboxedPreload = COMMONJS_SOURCE_EXTENSIONS.has(extname(importer))
      && await isReviewedSandboxedPreload(importer, source);
    if (COMMONJS_SOURCE_EXTENSIONS.has(extname(importer))) {
      if (!reviewedSandboxedPreload) {
        detectedViolations.push({
          category: "commonjs_production_source",
          importer,
          kind: "commonjs",
          line: 1,
          specifier: "<commonjs-source>",
          target: importer,
        });
        continue;
      }
    }
    if (!reviewedSandboxedPreload) {
      const commonJsLoadingIssue = esmCommonJsLoadingIssue(source);
      if (commonJsLoadingIssue) {
        detectedViolations.push({
          category: "esm_commonjs_loading",
          importer,
          kind: "commonjs-loading",
          line: commonJsLoadingIssue.line,
          specifier: commonJsLoadingIssue.specifier,
          target: "<runtime-commonjs-loader>",
        });
      }
    }
    const imports = await extractEsmImports(source, {
      sourceName: importer,
    });
    importCount += imports.length;

    for (const imported of imports) {
      if (typeof imported.specifier !== "string") {
        if (imported.kind === "dynamic-import") {
          detectedViolations.push({
            category: "nonliteral_dynamic_import",
            importer,
            kind: imported.kind,
            line: imported.line,
            specifier: "<nonliteral>",
            target: "<runtime-computed>",
          });
        }
        continue;
      }
      const unresolvedTarget = resolveFirstPartyTarget({
        importer,
        packageLocations,
        rootDirectory: absoluteRoot,
        specifier: imported.specifier,
      });
      if (!unresolvedTarget) {
        continue;
      }
      const retiredTarget = retiredProductionSourceTarget(unresolvedTarget);
      if (retiredTarget) {
        detectedViolations.push({
          category: "retired_production_source_path",
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target: retiredTarget,
        });
        continue;
      }
      const inspectedTarget = await inspectFirstPartyTarget({
        productionFiles,
        rootDirectory: absoluteRoot,
        target: unresolvedTarget,
      });
      const target = inspectedTarget.target;
      if (inspectedTarget.excluded) {
        detectedViolations.push({
          category: "excluded_source_dependency",
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target,
        });
        continue;
      }
      const graphTarget = inspectedTarget.graphTarget;
      if (graphTarget) {
        graphEdges.push({
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target: graphTarget,
        });
      }
      if (workspacePackagePublicApiViolation({
        importer,
        packageLocations,
        specifier: imported.specifier,
        target,
      })) {
        detectedViolations.push({
          category: "workspace_package_public_api",
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target,
        });
        continue;
      }
      if (sourceOwnerDependencyDirectionViolation(importer, target)) {
        detectedViolations.push({
          category: "source_owner_dependency_direction",
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target,
        });
        continue;
      }
      if (sourceOwnerPublicApiViolation(importer, target)) {
        detectedViolations.push({
          category: "source_owner_public_api",
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target,
        });
        continue;
      }
      const category = violationCategory(importer, target);
      if (category) {
        detectedViolations.push({
          category,
          importer,
          kind: imported.kind,
          line: imported.line,
          specifier: imported.specifier,
          target,
        });
      }
    }
  }

  const directStorageCallers = new Set(
    graphEdges
      .filter(({ importer, target }) =>
        target === "src/storage.js" && importer.startsWith("src/"))
      .map(({ importer }) => importer),
  );
  const expectedStorageCallers = new Set(
    productionFiles.has("src/storage.js")
      ? LEGACY_STORAGE_DIRECT_IMPORTERS
      : [],
  );
  for (const importer of [...directStorageCallers]
    .filter((value) => !expectedStorageCallers.has(value)).sort()) {
    detectedViolations.push({
      category: "legacy_storage_direct_caller",
      importer,
      kind: "import",
      line: 1,
      specifier: "./storage.js",
      target: "src/storage.js",
    });
  }
  for (const importer of [...expectedStorageCallers]
    .filter((value) => !directStorageCallers.has(value)).sort()) {
    detectedViolations.push({
      category: "legacy_storage_direct_caller",
      importer,
      kind: "ledger",
      line: 1,
      specifier: "<ledger>",
      target: "src/storage.js",
    });
  }

  detectedViolations.push(...productionCycleViolations(files, graphEdges));
  detectedViolations.sort(
    (left, right) =>
      left.importer.localeCompare(right.importer) ||
      left.line - right.line ||
      left.target.localeCompare(right.target) ||
      left.category.localeCompare(right.category),
  );

  const matchedBaselineKeys = new Set();
  const approvedViolations = [];
  const violations = [];
  for (const violation of detectedViolations) {
    const key = baselineKey(violation);
    if (baselineValidation.entries.has(key)) {
      matchedBaselineKeys.add(key);
      approvedViolations.push({
        ...violation,
        baseline: baselineValidation.entries.get(key),
      });
    } else {
      violations.push(violation);
    }
  }

  const unusedBaseline = [...baselineValidation.entries.entries()]
    .filter(([key]) => !matchedBaselineKeys.has(key))
    .map(([, entry]) => entry);

  return {
    approvedViolations,
    baselineIssues: baselineValidation.issues,
    importCount,
    directStorageCallers: [...directStorageCallers].sort(),
    ok: violations.length === 0 && baselineValidation.issues.length === 0,
    rootDirectory: absoluteRoot,
    scannedFileCount: files.length,
    unusedBaseline,
    violations,
  };
}

export function formatArchitectureBoundaryReport(result) {
  const lines = [
    result.ok
      ? `Architecture boundaries passed (${result.scannedFileCount} production files, ${result.importCount} imports, ${result.approvedViolations.length} approved debt edge(s)).`
      : "Architecture boundary check failed.",
  ];

  for (const issue of result.baselineIssues) {
    lines.push("", `[baseline_configuration] ${issue}`);
  }
  for (const violation of result.violations) {
    const category =
      ARCHITECTURE_BOUNDARY_CATEGORIES[violation.category];
    const importDescription = violation.cycle
      ? [
          `  Cycle: ${violation.cycle.join(" -> ")}`,
          `  First edge: ${violation.specifier}`,
        ]
      : [`  Import: ${violation.specifier}`];
    lines.push(
      "",
      `[${violation.category}] ${violation.importer}:${violation.line} -> ${violation.target}`,
      ...importDescription,
      `  Rule: ${category.description}`,
      `  Fix: ${category.remediation}`,
    );
  }
  if (result.unusedBaseline.length > 0) {
    lines.push(
      "",
      `${result.unusedBaseline.length} exact baseline allowance(s) are currently unused; remove them after any concurrent migration has settled.`,
    );
  }
  return lines.join("\n");
}

function parseArguments(arguments_) {
  let rootDirectory = DEFAULT_REPOSITORY_ROOT;
  let json = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value) {
        throw new TypeError("--root requires a directory");
      }
      rootDirectory = resolve(value);
      index += 1;
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }

  return {
    json,
    rootDirectory,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await checkArchitectureBoundaries({
    rootDirectory: options.rootDirectory,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatArchitectureBoundaryReport(result)}\n`,
  );
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
