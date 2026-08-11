#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { extractEsmImports } from "./lib/esm-imports.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const CLIENT_EXPORT_SCHEMA = "tibotattle-client-export-v1";
export const CLIENT_REPOSITORY_NAME = "tibotattle-client";
export const CLIENT_PACKAGE_NAME = "app-usagemonitor";
export const CLIENT_PACKAGE_VERSION = RELEASE_VERSION;
export const CLIENT_MANIFEST_FILE = "client-export-manifest.json";

/**
 * These are reviewed, exact files.  This list intentionally contains no
 * directory globs, repository walks, git commands, or source-history inputs.
 * Update it only as part of a separately reviewed client-boundary change.
 */
export const CLIENT_RUNTIME_FILES = Object.freeze([
  "apps/local/server.js",
  "apps/local/static-assets.js",
  "apps/local/transport/participant-relay-routes.js",
  "config/deployment-endpoints.js",
  "config/product-brand.js",
  "config/release-channels.js",
  "config/release-manifest.js",
  "contracts/telemetry-v0.1/consent-status.json",
  "contracts/telemetry-v0.1/contract-status.json",
  "contracts/telemetry-v0.1/field-policy.json",
  "generated/telemetry-v0.1-compatibility.json",
  "generated/telemetry-v0.1-field-dictionary.json",
  "schemas/export-deletion-v0.1/commit-marker.schema.json",
  "schemas/export-deletion-v0.1/journal.schema.json",
  "schemas/export-deletion-v0.1/preflight-summary.schema.json",
  "schemas/export-deletion-v0.1/receipt.schema.json",
  "schemas/export-set-v0.1/manifest.schema.json",
  "schemas/export-set-v0.2/manifest.schema.json",
  "schemas/export-workspace-discard-v0.1/commit-marker.schema.json",
  "schemas/export-workspace-discard-v0.1/journal.schema.json",
  "schemas/export-workspace-discard-v0.1/preflight-summary.schema.json",
  "schemas/export-workspace-discard-v0.1/receipt.schema.json",
  "schemas/telemetry-contribution-v0.2/activity-marker.schema.json",
  "schemas/telemetry-contribution-v0.2/contribution.schema.json",
  "schemas/telemetry-contribution-v0.2/quota-snapshot.schema.json",
  "schemas/telemetry-contribution-v0.2/usage-event.schema.json",
  "schemas/telemetry-v0.1/activity-marker.schema.json",
  "schemas/telemetry-v0.1/bundle.schema.json",
  "schemas/telemetry-v0.1/compatibility.schema.json",
  "schemas/telemetry-v0.1/privacy-receipt.schema.json",
  "schemas/telemetry-v0.1/quota-snapshot.schema.json",
  "schemas/telemetry-v0.1/usage-event.schema.json",
  "src/account-observation-production.js",
  "src/account-observation-secret.js",
  "src/application/claude-callback-capability.js",
  "src/application/export-compatibility.js",
  "src/application/export-sources/claude-status-export.js",
  "src/application/export-sources/claude-status-workspace.js",
  "src/application/export-sources/claude-transcript-export.js",
  "src/application/export-sources/claude-transcript-workspace.js",
  "src/application/export-sources/codex-checkpoint.js",
  "src/application/export-sources/codex-collector-export.js",
  "src/application/export-sources/codex-collector-workspace.js",
  "src/application/export-sources/codex-source-plan.js",
  "src/application/export-sources/controller.js",
  "src/application/export-sources/index.js",
  "src/application/export-sources/source-plan-bundle.js",
  "src/application/export-sources/source-validation.js",
  "src/application/index.js",
  "src/application/local-automatic-contribution.js",
  "src/application/local-codex-log-scanner.js",
  "src/application/local-contribution-preparation.js",
  "src/application/local-contribution-sync-queue.js",
  "src/application/local-export-artifact-storage.js",
  "src/application/local-export-deletion.js",
  "src/application/local-export-resource-context.js",
  "src/application/local-export-set-materialization.js",
  "src/application/local-export-set-verification.js",
  "src/application/local-export-workspace-discard.js",
  "src/application/local-export-workspace.js",
  "src/application/local-incremental-contribution-sync.js",
  "src/application/local-metadata-bundle-verification.js",
  "src/application/local-metadata-export.js",
  "src/application/local-prepared-contribution.js",
  "src/application/production-participant-identity.js",
  "src/application/subscription-speed-sensitivity.js",
  "src/automatic-contribution.js",
  "src/bounded-jsonl.js",
  "src/bundle-verifier.js",
  "src/claude-statusline-storage.js",
  "src/claude-statusline.js",
  "src/codex-local-usage-analysis.js",
  "src/codex-log-scan.js",
  "src/codex-speed-baseline.js",
  "src/codex-transition-miner.js",
  "src/contribution-device-capability.js",
  "src/contribution-device-client.js",
  "src/contribution-device-sync.js",
  "src/contribution-incremental-sync.js",
  "src/contribution-sync-queue.js",
  "src/contribution/account-track.js",
  "src/contribution/index.js",
  "src/contribution/prepared-set-contract.js",
  "src/contribution/recurrence-policy.js",
  "src/contribution/telemetry-v01-projection.js",
  "src/contribution/telemetry-v02-projection.js",
  "src/contribution/telemetry-v1-chunks.js",
  "src/export-contract.js",
  "src/export-identity-keychain.js",
  "src/export-identity-production.js",
  "src/export-identity.js",
  "src/export-privacy.js",
  "src/export-resource-policy.js",
  "src/export-safe-records.js",
  "src/export-schema.js",
  "src/export/bundle-verification.js",
  "src/export/bundle-verifier.js",
  "src/export/canonical-json.js",
  "src/export/checkpoint-state.js",
  "src/export/compatibility.js",
  "src/export/compression.js",
  "src/export/deletion-contract.js",
  "src/export/deletion-schema.js",
  "src/export/index.js",
  "src/export/privacy.js",
  "src/export/registries.js",
  "src/export/resource-policy.js",
  "src/export/safe-records.js",
  "src/export/safe-validation-errors.js",
  "src/export/schema.js",
  "src/export/set-materialization-runtime.js",
  "src/export/set-materialization.js",
  "src/export/set-schema.js",
  "src/export/set-verification.js",
  "src/export/source-plan-summary.js",
  "src/export/supplemental-source-plan.js",
  "src/export/versions.js",
  "src/export/workspace-contract.js",
  "src/export/workspace-discard-contract.js",
  "src/export/workspace-discard-schema.js",
  "src/export/workspace-runtime.js",
  "src/fast-mode-preference.js",
  "src/has-exact-enumerable-keys.js",
  "src/incremental-contribution.js",
  "src/local-analysis-extract-worker.js",
  "src/local-analysis-index.js",
  "src/local-archive-accounting-index.js",
  "src/local-collector-state.js",
  "src/local-companion-central-proxy.js",
  "src/local-companion-data.js",
  "src/local-companion-refresh.js",
  "src/local-contribution-preparation.js",
  "src/local-installation-diagnostics.js",
  "src/local-companion-usage-model.js",
  "src/local-legacy-report-storage.js",
  "src/local-unified-companion-source.js",
  // Reviewed 2026-08-10: pure windowed repricing over the local index for
  // the divergence panel's per-period cost mix — no content, paths, or
  // identifiers beyond what the companion already exports.
  "src/local-unified-window-breakdown.js",
  "src/local-unified-index-build.js",
  "src/local-unified-index-extract.js",
  "src/local-unified-index-ingest.js",
  "src/local-unified-index-worker.js",
  "src/local-unified-index.js",
  "src/metadata-exporter.js",
  "src/passive-collector.js",
  "src/platform/bounded-directory-reader.js",
  "src/platform/bounded-jsonl-reader.js",
  "src/platform/claude-callback-lifecycle.js",
  "src/platform/codex-config-service-tier.js",
  "src/platform/export-compatibility-artifacts.js",
  "src/platform/export-identity-keychain.js",
  "src/platform/export-set-verification-storage.js",
  "src/platform/index.js",
  "src/platform/local-codex-log-ports.js",
  "src/platform/local-contribution-sync-queue-storage.js",
  "src/platform/local-export-source-ports.js",
  "src/platform/local-metadata-bundle-files.js",
  "src/platform/local-state-paths.js",
  "src/platform/owner-only-automatic-contribution-storage.js",
  "src/platform/owner-only-export-artifact-storage.js",
  "src/platform/owner-only-export-deletion-preflight.js",
  "src/platform/owner-only-export-deletion-storage.js",
  "src/platform/owner-only-export-workspace-discard-preflight.js",
  "src/platform/owner-only-export-workspace-discard-storage.js",
  "src/platform/owner-only-export-workspace-lease.js",
  "src/platform/owner-only-export-workspace-storage.js",
  "src/platform/owner-only-filesystem.js",
  "src/platform/owner-only-prepared-contribution-storage.js",
  "src/platform/participant-identity.js",
  "src/platform/telemetry-envelope.js",
  "src/platform/telemetry-v1-envelope.js",
  "src/prepared-contribution-compatibility-internal.js",
  "src/providers/claude/statusline.js",
  "src/providers/codex/account-scope.js",
  "src/providers/codex/account.js",
  "src/providers/codex/app-server.js",
  "src/providers/codex/log-ingestion.js",
  "src/providers/codex/log-normalization.js",
  "src/providers/codex/log-parser.js",
  "src/providers/codex/log-sources.js",
  "src/providers/codex/logs.js",
  "src/providers/codex/plan-normalization.js",
  "src/providers/codex/quota-normalization.js",
  "src/providers/codex/surface-classification.js",
  "src/providers/codex/tier-normalization.js",
  "src/replay-safe-accounting-cache.js",
  "src/reporting/index.js",
  "src/reporting/monitoring-quality.js",
  "src/reporting/weekly-calibration.js",
  "src/rollout-line-reader.js",
  "src/storage.js",
  "src/telemetry-contribution-builder.js",
  "src/telemetry-prepared-set.js",
  "src/valid-abort-signal.js",
  "src/weekly-pace-projection.js",
]);

export const CLIENT_WEB_FILES = Object.freeze([
  "apps/web/public/app.js",
  "apps/web/public/community-data.js",
  "apps/web/public/community-view.js",
  "apps/web/public/community.html",
  "apps/web/public/community.js",
  "apps/web/public/data-client.js",
  "apps/web/public/index.html",
  "apps/web/public/i18n.generated.js",
  "apps/web/public/install-cta.js",
  "apps/web/public/lib.js",
  "apps/web/public/localization.js",
  "apps/web/public/navigation.js",
  "apps/web/public/styles.css",
  "apps/web/public/telemetry-envelope.js",
  "apps/web/public/telemetry-shared.generated.js",
  "apps/web/public/ui-format.js",
]);

export const CLIENT_MACOS_FILES = Object.freeze([
  "apps/macos/Assets/AppIcon.icns",
  "apps/macos/Assets/AppIcon.provenance.txt",
  "apps/macos/Assets/README.md",
  "apps/macos/NodeRuntime.entitlements",
  "apps/macos/README.md",
  "apps/macos/Sources/MenuBarStatus.swift",
  "apps/macos/Sources/SemanticOpenTarget.swift",
  "apps/macos/UsageMonitorApp.swift",
  "apps/macos/reset-local-keychain.js",
]);

export const CLIENT_PACKAGE_FILES = Object.freeze([
  "packages/accounting/index.d.ts",
  "packages/accounting/index.js",
  "packages/accounting/package.json",
  "packages/accounting/src/cost-ledger.js",
  "packages/accounting/src/local-api-pricing.js",
  "packages/accounting/src/price-registry.js",
  "packages/accounting/src/subscription-speed.js",
  "packages/accounting/test/fixtures/accounting-parity-v0.1.json",
  "packages/i18n/index.d.ts",
  "packages/i18n/index.js",
  "packages/i18n/package.json",
  "packages/identity-core/index.d.ts",
  "packages/identity-core/index.js",
  "packages/identity-core/package.json",
  "packages/identity-core/src/pseudonym.js",
  "packages/quota-analysis/index.d.ts",
  "packages/quota-analysis/index.js",
  "packages/quota-analysis/package.json",
  "packages/quota-analysis/src/model-composition.js",
  "packages/quota-analysis/src/quota-calibration.js",
  "packages/quota-analysis/src/quota-pace-forecast.js",
  "packages/quota-analysis/src/quota-rolling.js",
  "packages/quota-analysis/src/quota-tracks.js",
  "packages/quota-analysis/src/quota-windows.js",
  "packages/telemetry-contract/index.d.ts",
  "packages/telemetry-contract/index.js",
  "packages/telemetry-contract/package.json",
  "packages/telemetry-contract/schemas/v0.2/activity-marker.schema.json",
  "packages/telemetry-contract/schemas/v0.2/contribution.schema.json",
  "packages/telemetry-contract/schemas/v0.2/quota-snapshot.schema.json",
  "packages/telemetry-contract/schemas/v0.2/usage-event.schema.json",
  "packages/telemetry-contract/scripts/sync-json-schemas.mjs",
  "packages/telemetry-contract/src/constants.js",
  "packages/telemetry-contract/src/envelope.js",
  "packages/telemetry-contract/src/errors.js",
  "packages/telemetry-contract/src/primitives.js",
  "packages/telemetry-contract/src/telemetry-v0.1.js",
  "packages/telemetry-contract/src/telemetry-v0.2.js",
  "packages/telemetry-contract/src/upload.js",
]);

export const CLIENT_SCRIPT_FILES = Object.freeze([
  "scripts/build-macos-app.js",
  "scripts/build-native-network-audit.js",
  "scripts/generate-i18n-browser-mirror.js",
  "scripts/generate-telemetry-browser-mirror.js",
  "scripts/generate-telemetry-contract.js",
  "scripts/lib/captured-utf8-source.mjs",
  "scripts/lib/esm-imports.mjs",
  "scripts/macos-release-core.js",
  "scripts/macos-updater-core.js",
  "scripts/native-network-audit-interpose.c",
  "scripts/package-macos-dmg.js",
  "scripts/prepare-sparkle-framework.js",
  "scripts/release-macos-app.js",
  "scripts/validate-macos-install.js",
  "scripts/validate-macos-replacement.js",
]);

export const CLIENT_TEST_FILES = Object.freeze([
  "apps/local/participant-relay-routes.test.mjs",
  "apps/local/server.test.mjs",
  "apps/web/test/community-site.test.mjs",
  "apps/web/test/lib.test.mjs",
  "apps/web/test/navigation.test.mjs",
  "apps/web/test/i18n-browser-parity.test.mjs",
  "apps/web/test/telemetry-shared-parity.test.mjs",
  "test/accounting-package-parity.test.js",
  "test/application-participant-identity.test.js",
  "test/browser-module-serving-parity.test.js",
  "test/export-contract.test.js",
  "test/export-privacy.test.js",
  "test/export-schema.test.js",
  "test/local-archive-accounting-index.test.js",
  "test/local-collector-state.test.js",
  "test/local-companion-data.test.js",
  "test/local-companion-refresh.test.js",
  "test/local-contribution-preparation.test.js",
  "test/local-unified-index.test.js",
  "test/local-installation-diagnostics.test.js",
  "test/macos-app-bundle.test.js",
  "test/macos-updater.test.js",
  "test/metadata-exporter.test.js",
  "test/native-network-audit.test.js",
  "test/telemetry-contract-package.test.js",
  "test/telemetry-contract.test.js",
  "test/telemetry-envelope-adapter.test.js",
  "test/telemetry-schema-mirror.test.js",
]);

export const CLIENT_TEST_FIXTURE_FILES = Object.freeze([
  "test/fixtures/product-synthetic-contribution-v0.1.json",
  "test/fixtures/telemetry-contract-vectors.mjs",
]);

export const CLIENT_CONTRACT_FILES = Object.freeze([
  "LICENSE",
  "third_party_licenses/runcost-0.2.0.txt",
  "third_party_licenses/sparkle-2.9.3.txt",
]);

export const CLIENT_SOURCE_FILES = Object.freeze([
  ...CLIENT_RUNTIME_FILES,
  ...CLIENT_WEB_FILES,
  ...CLIENT_MACOS_FILES,
  ...CLIENT_PACKAGE_FILES,
  ...CLIENT_SCRIPT_FILES,
  ...CLIENT_TEST_FILES,
  ...CLIENT_TEST_FIXTURE_FILES,
  ...CLIENT_CONTRACT_FILES,
]);

/**
 * Path prefixes that must never enter a client export.  These are checked on
 * both the source allow-list and the final output inventory.  The list is
 * intentionally path-based: an ordinary word such as "service" in source
 * prose is not a security decision.
 */
export const FORBIDDEN_SERVICE_PATHS = Object.freeze([
  ".git",
  ".dev.vars",
  ".env",
  ".release-build",
  ".release-deps",
  ".release-repro",
  ".usage-monitor",
  "apps/cloud-run",
  "apps/web/public/admin-client.js",
  "apps/web/public/admin.css",
  "apps/web/public/admin.html",
  "apps/web/public/admin.js",
  "apps/web/test/admin-client.test.mjs",
  "apps/web/test/admin-site.test.mjs",
  "apps/worker",
  "docs/decisions",
  "docs/governance",
  "docs/plans",
  "docs/qa",
  "docs/receipts",
  "docs/reports",
  "local-review",
  "migrations",
  "scripts/publish-sparkle-update.js",
  "wrangler.jsonc",
  "worker-configuration.d.ts",
]);

const FORBIDDEN_EXTERNAL_SPECIFIERS = Object.freeze([
  "@app-usagemonitor/synthetic-worker",
  "@cloudflare",
  "google-auth-library",
  "oauth4webapi",
  "wrangler",
]);

const SECRET_FILE_EXTENSIONS = new Set([
  ".cer",
  ".key",
  ".mobileprovision",
  ".p12",
  ".p8",
  ".pem",
]);

const SECRET_PATTERNS = Object.freeze([
  Object.freeze({
    code: "private_key_material",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  }),
  Object.freeze({
    code: "cloud_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
  }),
  Object.freeze({
    code: "github_token",
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  }),
  Object.freeze({
    code: "provider_secret_token",
    pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/u,
  }),
  Object.freeze({
    code: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/u,
  }),
  Object.freeze({
    code: "credential_assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*(?:=|:)\s*["'][^"'\n]{20,}["']/iu,
  }),
  Object.freeze({
    code: "credential_environment_assignment",
    pattern: /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*=\s*[A-Za-z0-9_./+=-]{20,}\b/u,
  }),
]);

const IMPORT_PATTERNS = Object.freeze([
  /require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu,
]);

const GENERATED_FILE_NAMES = Object.freeze([
  ".gitignore",
  ".github/workflows/osv-scanner.yml",
  "README.md",
  "SECURITY.md",
  "docs/verify-release.md",
  "package.json",
  "pnpm-workspace.yaml",
]);

function fail(message, code = "CLIENT_EXPORT_INVALID") {
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativePath(value, label = "path") {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || value.includes("\\")
      || isAbsolute(value)) {
    fail(`${label} must be a non-empty relative POSIX path`, "CLIENT_EXPORT_PATH_INVALID");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${label} contains an unsafe path component`, "CLIENT_EXPORT_PATH_INVALID");
  }
  return parts.join("/");
}

function matchesPathPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function forbiddenPathReason(value) {
  let path;
  try {
    path = normalizeRelativePath(value);
  } catch {
    return "invalid_path";
  }
  if (FORBIDDEN_SERVICE_PATHS.some((prefix) => matchesPathPrefix(path, prefix))) {
    return "private_service_path";
  }
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name.startsWith(".env")
      || name.includes("credential")
      || (name.includes("secret") && !/[.](?:c|m)?js$/u.test(name))
      || SECRET_FILE_EXTENSIONS.has(extname(name))) {
    return "credential_or_secret_path";
  }
  return null;
}

export function assertSafeRelativePath(value, label = "path") {
  const path = normalizeRelativePath(value, label);
  const reason = forbiddenPathReason(path);
  if (reason !== null) {
    fail(`${label} is forbidden by the client export boundary`, "CLIENT_EXPORT_FORBIDDEN_PATH");
  }
  if (path.includes("*") || path.includes("?") || path.includes("[")) {
    fail(`${label} must be an exact file path, not a pattern`, "CLIENT_EXPORT_GLOB_FORBIDDEN");
  }
  return path;
}

export function validateAllowlist(paths = CLIENT_SOURCE_FILES) {
  if (!Array.isArray(paths) || paths.length === 0) {
    fail("Client export allow-list must be a non-empty array", "CLIENT_EXPORT_ALLOWLIST_INVALID");
  }
  const normalized = paths.map((path, index) =>
    assertSafeRelativePath(path, `allow-list entry ${index}`));
  if (new Set(normalized).size !== normalized.length) {
    fail("Client export allow-list contains duplicate paths", "CLIENT_EXPORT_ALLOWLIST_DUPLICATE");
  }
  return Object.freeze([...normalized].sort());
}

function outputPathSet() {
  const source = validateAllowlist();
  const generated = [...GENERATED_FILE_NAMES];
  const all = [...source, ...generated, CLIENT_MANIFEST_FILE];
  if (new Set(all).size !== all.length) {
    fail("Client export output paths collide", "CLIENT_EXPORT_OUTPUT_COLLISION");
  }
  for (const path of all) assertSafeRelativePath(path, "output path");
  return Object.freeze(all.sort());
}

function pathWithin(root, candidate, label) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const selected = relative(rootPath, candidatePath);
  if (selected === ""
      || selected === ".."
      || selected.startsWith(`..${sep}`)
      || isAbsolute(selected)) {
    fail(`${label} escaped its reviewed root`, "CLIENT_EXPORT_PATH_ESCAPE");
  }
  return candidatePath;
}

function pathIsWithin(root, candidate) {
  const selected = relative(resolve(root), resolve(candidate));
  return selected === ""
    || (!selected.startsWith(`..${sep}`)
      && selected !== ".."
      && !isAbsolute(selected));
}

async function assertRealDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`${label} must already exist as an empty directory`, "CLIENT_EXPORT_OUTPUT_REQUIRED");
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a real directory`, "CLIENT_EXPORT_DIRECTORY_INVALID");
  }
  return realpath(path);
}

async function assertEmptyOutputDirectory(path) {
  const actual = await assertRealDirectory(path, "Export output");
  const entries = await readdir(actual);
  if (entries.length !== 0) {
    fail("Export output must be empty; refusing to overwrite existing files", "CLIENT_EXPORT_OUTPUT_NOT_EMPTY");
  }
  return actual;
}

async function readSourceRecords(sourceRoot, paths) {
  const actualRoot = await assertRealDirectory(sourceRoot, "Source root");
  const records = new Map();
  for (const relativePath of paths) {
    const sourceFile = pathWithin(
      actualRoot,
      resolve(actualRoot, ...relativePath.split("/")),
      `source file ${relativePath}`,
    );
    let metadata;
    try {
      metadata = await lstat(sourceFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        fail(`Allow-listed source file is missing: ${relativePath}`, "CLIENT_EXPORT_SOURCE_MISSING");
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`Allow-listed source file is not a regular file: ${relativePath}`, "CLIENT_EXPORT_SOURCE_NOT_REGULAR");
    }
    const actualFile = await realpath(sourceFile);
    pathWithin(actualRoot, actualFile, `source file ${relativePath}`);
    const bytes = await readFile(actualFile);
    scanTextForSecrets(bytes, relativePath);
    records.set(relativePath, Object.freeze({
      bytes,
      sha256: sha256(bytes),
    }));
  }
  return Object.freeze({ root: actualRoot, records });
}

export function scanTextForSecrets(bytes, relativePath = "<memory>") {
  if (!Buffer.isBuffer(bytes)) {
    fail("Secret scan input must be a Buffer", "CLIENT_EXPORT_SECRET_SCAN_INVALID");
  }
  if (bytes.includes(0)) return true;
  const text = bytes.toString("utf8");
  for (const { code, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      fail(`Likely credential material found in ${relativePath}`, "CLIENT_EXPORT_SECRET_FOUND");
    }
  }
  return true;
}

function candidateImportPaths(sourceRoot, sourceFile, specifier) {
  const raw = resolve(dirname(sourceFile), specifier);
  const candidates = [raw];
  if (!extname(raw)) {
    candidates.push(`${raw}.js`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.json`);
    candidates.push(join(raw, "index.js"), join(raw, "index.mjs"));
  }
  return candidates.map((candidate) => {
    const selected = relative(sourceRoot, candidate);
    if (selected === ""
        || selected === ".."
        || selected.startsWith(`..${sep}`)
        || isAbsolute(selected)) {
      return null;
    }
    return selected.split(sep).join("/");
  }).filter(Boolean);
}

function validateExternalSpecifier(specifier, sourceFile) {
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (FORBIDDEN_EXTERNAL_SPECIFIERS.some((forbidden) =>
    packageName === forbidden || packageName.startsWith(`${forbidden}/`))) {
    fail(
      `Forbidden service dependency in ${sourceFile}`,
      "CLIENT_EXPORT_FORBIDDEN_IMPORT",
    );
  }
}

export async function validateImportBoundary({
  sourceRoot,
  paths = CLIENT_SOURCE_FILES,
  records,
  additionalAllowedPaths = GENERATED_FILE_NAMES,
} = {}) {
  if (!(records instanceof Map)) {
    fail("Import-boundary records must be a Map", "CLIENT_EXPORT_IMPORT_SCAN_INVALID");
  }
  const selectedRoot = resolve(sourceRoot);
  const allowed = new Set([
    ...validateAllowlist(paths),
    ...additionalAllowedPaths.map((path) => assertSafeRelativePath(path, "generated path")),
  ]);
  for (const relativePath of validateAllowlist(paths)) {
    const extension = extname(relativePath).toLowerCase();
    if (!/[.](?:cjs|js|mjs)$/u.test(extension)) continue;
    const record = records.get(relativePath);
    if (!record) fail(`Missing import-scan record: ${relativePath}`, "CLIENT_EXPORT_IMPORT_SCAN_INVALID");
    let imports;
    try {
      imports = await extractEsmImports(record.bytes.toString("utf8"), {
        sourceName: relativePath,
      });
    } catch (error) {
      fail(`Unable to inspect imports in ${relativePath}: ${error.message}`, "CLIENT_EXPORT_IMPORT_SCAN_INVALID");
    }
    const specifiers = imports.map(({ specifier, kind }) => {
      if (specifier === null) {
        fail(`Non-literal dynamic import in ${relativePath}`, "CLIENT_EXPORT_DYNAMIC_IMPORT");
      }
      if (kind === "dynamic-import" && typeof specifier !== "string") {
        fail(`Unreviewed dynamic import in ${relativePath}`, "CLIENT_EXPORT_DYNAMIC_IMPORT");
      }
      return specifier;
    });
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of record.bytes.toString("utf8").matchAll(pattern)) {
        specifiers.push(match[1]);
      }
    }
    for (const specifier of new Set(specifiers)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        validateExternalSpecifier(specifier, relativePath);
        continue;
      }
      const candidates = candidateImportPaths(
        selectedRoot,
        resolve(selectedRoot, ...relativePath.split("/")),
        specifier,
      );
      const forbidden = candidates.find((candidate) => forbiddenPathReason(candidate) !== null);
      if (forbidden) {
        fail(
          `Forbidden relative import from ${relativePath}: ${specifier}`,
          "CLIENT_EXPORT_FORBIDDEN_IMPORT",
        );
      }
      if (!candidates.some((candidate) => allowed.has(candidate))) {
        fail(
          `Relative import is outside the reviewed allow-list: ${relativePath} -> ${specifier}`,
          "CLIENT_EXPORT_IMPORT_NOT_ALLOWLISTED",
        );
      }
    }
  }
  return true;
}

function clientPackageManifest() {
  return {
    name: CLIENT_PACKAGE_NAME,
    version: CLIENT_PACKAGE_VERSION,
    private: true,
    type: "module",
    description: "TiboTattle local macOS client.",
    scripts: {
      "client:check": "npm test && npm run product:macos:test",
      "client:syntax": "node --check ./apps/local/server.js && node --check ./scripts/build-macos-app.js && node --check ./scripts/macos-release-core.js",
      "product:local": "node ./apps/local/server.js",
      "product:macos:build": "node ./scripts/build-macos-app.js --output .release-build/macos/TiboTattle.app",
      "product:macos:dmg": "node ./scripts/package-macos-dmg.js --app .release-build/macos/TiboTattle.app --output .release-build/macos/TiboTattle-development.dmg --development --replace",
      "product:macos:release": "node ./scripts/release-macos-app.js",
      "product:macos:test": "node --test --test-concurrency=1 test/macos-app-bundle.test.js test/macos-updater.test.js",
      "product:macos:updater:prepare": "node ./scripts/prepare-sparkle-framework.js --output .release-deps/Sparkle.framework",
      "product:macos:validate:development": "node ./scripts/validate-macos-install.js --app .release-build/macos/TiboTattle.app --channel stable --development",
      "product:macos:validate:replacement": "node ./scripts/validate-macos-replacement.js",
      "product:native-network-audit:build": "node ./scripts/build-native-network-audit.js --output .release-build/native-network-audit/libusage_monitor_network_audit.dylib",
      "telemetry:browser:check": "node ./scripts/generate-telemetry-browser-mirror.js --check",
      "telemetry:check": "node ./scripts/generate-telemetry-contract.js --check",
      test: "node --test --test-concurrency=1 test/*.test.js apps/local/*.test.mjs apps/web/test/*.test.mjs",
    },
    dependencies: {
      "@app-usagemonitor/accounting": "workspace:*",
      "@app-usagemonitor/i18n": "workspace:*",
      "@app-usagemonitor/identity-core": "workspace:*",
      "@app-usagemonitor/quota-analysis": "workspace:*",
      "@app-usagemonitor/telemetry-contract": "workspace:*",
      "@github/keytar": "7.10.6",
      ajv: "8.20.0",
      runcost: "0.2.1",
    },
    devDependencies: {
      "es-module-lexer": "2.3.1",
      "fast-check": "^4.9.0",
    },
    engines: { node: ">=22.13.0" },
    packageManager: "pnpm@11.9.0",
  };
}

function generatedFiles() {
  const packageText = stableJson(clientPackageManifest());
  return new Map([
    [".gitignore", [
      "node_modules/",
      ".pnpm-store/",
      ".release-build/",
      ".release-deps/",
      ".usage-monitor/",
      ".env",
      ".env.*",
      ".dev.vars",
      "*.key",
      "*.p8",
      "*.p12",
      "*.pem",
      "client-export-manifest.json.tmp",
    ].join("\n") + "\n"],
    [".github/workflows/osv-scanner.yml", [
      "name: OSV dependency scan",
      "",
      "on:",
      "  pull_request:",
      "  push:",
      "    branches: [main]",
      "  schedule:",
      "    - cron: \"23 4 * * 1\"",
      "  workflow_dispatch:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  osv:",
      "    name: Scan committed dependency locks",
      "    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@9a498708959aeaef5ef730655706c5a1df1edbc2 # v2.3.8",
      "    permissions:",
      "      contents: read",
      "    with:",
      "      upload-sarif: false",
      "      fail-on-vuln: true",
      "      scan-args: |-",
      "        --recursive",
      "        ./",
      "",
    ].join("\n")],
    ["README.md", [
      "# TiboTattle client export candidate",
      "",
      "This directory is a reviewed, history-free seed for the future private",
      "`tibotattle-client` repository. It is an export artifact, not a GitHub",
      "repository-creation receipt, public-release receipt, or service source.",
      "",
      "The exporter copied only the exact paths recorded in",
      "`client-export-manifest.json`. Hosted service implementation, operator",
      "assets, deployment configuration, credentials, local observations, and",
      "private Git history are intentionally absent.",
      "",
      "## Next build/test boundary",
      "",
      "The private monorepo lockfile is intentionally not copied because it",
      "contains service importers. In the newly seeded private client checkout,",
      "generate and review the client-only lockfile before using frozen installs:",
      "",
      "```bash",
      "pnpm install",
      "pnpm install --frozen-lockfile",
      "npm run client:check",
      "npm run product:macos:build",
      "```",
      "",
      "Those commands are the next boundary; this exporter does not claim that",
      "a client repository, lockfile, macOS bundle, signature, or release exists.",
      "",
    ].join("\n")],
    ["SECURITY.md", [
      "# Security boundary",
      "",
      "This candidate contains local client source and public-safe contracts",
      "only. Do not add credentials, private keys, local history, raw usage",
      "records, service implementation, or deployment configuration to this",
      "repository.",
      "",
      "Before any visibility change, rerun the client export checks, review the",
      "source manifest, generate the client-only lockfile, and complete the",
      "documented build, test, signing, and provenance gates.",
      "",
    ].join("\n")],
    ["docs/verify-release.md", [
      "# Client release verification boundary",
      "",
      "No release is created by the export tool. After the future private",
      "`tibotattle-client` repository is seeded, a release must be built from an",
      "immutable client tag and independently checked for source-manifest",
      "integrity, payload integrity, Developer ID signing, notarization, and",
      "Sparkle feed signatures.",
      "",
      "The first local boundary is `npm run client:check` followed by",
      "`npm run product:macos:build` on supported macOS arm64 hardware.",
      "Passing this candidate boundary is not a public-release claim.",
      "",
    ].join("\n")],
    ["package.json", packageText],
    // pnpm 11 reads workspace-wide overrides from pnpm-workspace.yaml. The
    // native builder captures this exact AJV closure, so a history-free seed
    // must constrain the fresh client lockfile to the reviewed versions.
    ["pnpm-workspace.yaml", [
      "packages:",
      "  - packages/*",
      "overrides:",
      "  fast-deep-equal: 3.1.3",
      "  fast-uri: 3.1.4",
      "  json-schema-traverse: 1.0.0",
      "  require-from-string: 2.0.2",
      "",
    ].join("\n")],
  ]);
}

async function writeFileSafely(root, relativePath, bytes) {
  const destination = pathWithin(
    root,
    resolve(root, ...relativePath.split("/")),
    `output file ${relativePath}`,
  );
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { mode: 0o644, flag: "wx" });
}

async function listRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail("Export output contains a symbolic link", "CLIENT_EXPORT_SYMLINK_FOUND");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        fail("Export output contains a non-regular filesystem entry", "CLIENT_EXPORT_OUTPUT_INVALID");
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function buildManifest(outputRoot, sourceFiles, generatedFileNames) {
  const rows = [];
  for (const relativePath of [...sourceFiles, ...generatedFileNames].sort()) {
    const bytes = await readFile(resolve(outputRoot, ...relativePath.split("/")));
    rows.push({
      bytes: bytes.length,
      path: relativePath,
      sha256: sha256(bytes),
    });
  }
  return {
    schemaVersion: CLIENT_EXPORT_SCHEMA,
    repository: CLIENT_REPOSITORY_NAME,
    transition: "private_history_free_seed",
    source: {
      explicitAllowListOnly: true,
      sourceCommitIncluded: false,
      sourceRootIncluded: false,
    },
    history: {
      gitDirectoryIncluded: false,
      privateGitHistoryIncluded: false,
    },
    excluded: {
      credentialsAndSecrets: true,
      privateHistory: true,
      servicePaths: [...FORBIDDEN_SERVICE_PATHS],
    },
    lockfile: {
      included: false,
      reason: "The source lockfile contains private service importers; generate a client-only lockfile after seeding.",
    },
    securityChecks: {
      forbiddenPaths: "passed",
      importBoundary: "passed",
      secretScan: "passed",
    },
    nextBuildTestBoundary: {
      install: "pnpm install",
      frozenInstall: "pnpm install --frozen-lockfile",
      test: "npm run client:check",
      macosBuild: "npm run product:macos:build",
      status: "not_run_by_exporter",
    },
    generatedFiles: [...generatedFileNames].sort(),
    files: rows,
  };
}

export async function validateExportDirectory(outputDir) {
  const outputRoot = await assertRealDirectory(outputDir, "Export output");
  const files = await listRegularFiles(outputRoot);
  if (files.includes(".git") || files.some((path) => path.startsWith(".git/"))) {
    fail("Export output contains private Git history", "CLIENT_EXPORT_HISTORY_FOUND");
  }
  for (const path of files) {
    if (forbiddenPathReason(path) !== null) {
      fail(`Export output contains a forbidden path: ${path}`, "CLIENT_EXPORT_FORBIDDEN_PATH");
    }
    scanTextForSecrets(await readFile(resolve(outputRoot, ...path.split("/"))), path);
  }
  if (!files.includes(CLIENT_MANIFEST_FILE)) {
    fail("Export output is missing its source manifest", "CLIENT_EXPORT_MANIFEST_MISSING");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(
      resolve(outputRoot, CLIENT_MANIFEST_FILE),
      "utf8",
    ));
  } catch {
    fail("Export source manifest is not valid JSON", "CLIENT_EXPORT_MANIFEST_INVALID");
  }
  if (manifest?.schemaVersion !== CLIENT_EXPORT_SCHEMA
      || manifest?.source?.explicitAllowListOnly !== true
      || manifest?.source?.sourceCommitIncluded !== false
      || manifest?.history?.privateGitHistoryIncluded !== false) {
    fail("Export source manifest does not prove the required boundary", "CLIENT_EXPORT_MANIFEST_INVALID");
  }
  if (Object.hasOwn(manifest.source, "sourceRoot")
      || Object.hasOwn(manifest.source, "sourcePath")) {
    fail("Export source manifest exposed a private source path", "CLIENT_EXPORT_MANIFEST_INVALID");
  }
  const rows = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestPaths = rows.map((row) => row?.path);
  const expectedFiles = [...manifestPaths, CLIENT_MANIFEST_FILE].sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(files)) {
    fail("Export inventory differs from its source manifest", "CLIENT_EXPORT_INVENTORY_MISMATCH");
  }
  for (const row of rows) {
    const path = assertSafeRelativePath(row?.path, "manifest file path");
    const bytes = await readFile(resolve(outputRoot, ...path.split("/")));
    if (row.bytes !== bytes.length || row.sha256 !== sha256(bytes)) {
      fail(`Export file digest mismatch: ${path}`, "CLIENT_EXPORT_DIGEST_MISMATCH");
    }
  }
  return Object.freeze({
    files: Object.freeze(files),
    manifest: Object.freeze(manifest),
  });
}

export async function createClientExport({
  outputDir,
  sourceRoot = REPOSITORY_ROOT,
} = {}) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    fail("--output must name an existing empty directory", "CLIENT_EXPORT_OUTPUT_REQUIRED");
  }
  const paths = validateAllowlist();
  const source = resolve(sourceRoot);
  const output = resolve(outputDir);
  if (pathIsWithin(source, output) || pathIsWithin(output, source)) {
    fail("Source and export output directories must be disjoint", "CLIENT_EXPORT_DIRECTORY_OVERLAP");
  }
  const outputRoot = await assertEmptyOutputDirectory(output);
  const { root: sourceRootReal, records } = await readSourceRecords(source, paths);
  await validateImportBoundary({
    sourceRoot: sourceRootReal,
    paths,
    records,
  });
  const generated = generatedFiles();
  for (const [relativePath, value] of generated) {
    assertSafeRelativePath(relativePath, "generated file");
    scanTextForSecrets(Buffer.from(value, "utf8"), relativePath);
  }
  const generatedNames = [...generated.keys()].sort();
  const expected = new Set([...paths, ...generatedNames, CLIENT_MANIFEST_FILE]);
  if (expected.size !== paths.length + generatedNames.length + 1) {
    fail("Client export source and generated paths collide", "CLIENT_EXPORT_OUTPUT_COLLISION");
  }
  for (const relativePath of paths) {
    await writeFileSafely(outputRoot, relativePath, records.get(relativePath).bytes);
  }
  for (const [relativePath, value] of generated) {
    await writeFileSafely(outputRoot, relativePath, Buffer.from(value, "utf8"));
  }
  const manifest = await buildManifest(outputRoot, paths, generatedNames);
  await writeFileSafely(
    outputRoot,
    CLIENT_MANIFEST_FILE,
    Buffer.from(stableJson(manifest), "utf8"),
  );
  const verified = await validateExportDirectory(outputRoot);
  return Object.freeze({
    outputDir: outputRoot,
    fileCount: verified.files.length,
    manifest: verified.manifest,
  });
}

function parseArguments(argv) {
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      if (outputDir !== null) fail("--output may be supplied only once", "CLIENT_EXPORT_ARGUMENTS_INVALID");
      outputDir = argv[++index] ?? null;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node scripts/export-tibotattle-client.mjs --output /path/to/empty-dir\n");
      return null;
    } else {
      fail(`Unknown argument: ${argument}`, "CLIENT_EXPORT_ARGUMENTS_INVALID");
    }
  }
  if (outputDir === null) fail("--output is required", "CLIENT_EXPORT_OUTPUT_REQUIRED");
  return { outputDir };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_ !== null) {
      const result = await createClientExport(arguments_);
      process.stdout.write(
        `Created history-free ${CLIENT_REPOSITORY_NAME} export at ${result.outputDir}\n`
        + `Files: ${result.fileCount}\n`
        + "Next boundary: pnpm install, npm run client:check, npm run product:macos:build\n",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.code ?? "CLIENT_EXPORT_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
