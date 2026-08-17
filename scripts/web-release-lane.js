import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PUBLIC_RELEASE_MANIFEST_SCHEMA,
  PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN,
} from "./public-release-provenance.js";

export const WEB_RELEASE_RECEIPT_SCHEMA =
  "usage-monitor-web-release-receipt-v0.1";
export const WEB_RELEASE_OUTPUT_DIRECTORY =
  ".release-build/public-release-site";
export const WEB_RELEASE_MANIFEST_PATH =
  `${WEB_RELEASE_OUTPUT_DIRECTORY}/release-site-manifest.json`;

const PUBLIC_RELEASE_SOURCE_BASENAMES = new Set([
  "apple.svg",
  "community-data.js",
  "community-view.js",
  "community.html",
  "community.js",
  "docs.html",
  "github.svg",
  "i18n.generated.js",
  "install-cta.js",
  "localization.js",
  "privacy.html",
  "styles.css",
  "tibotattle-icon.png",
  "tibotattle-weekly-preview.jpg",
  "ui-format.js",
  "x.svg",
]);

const WEB_RELEASE_TOOLING_PATHS = new Set([
  "package.json",
  "scripts/build-public-release-site.js",
  "scripts/deploy-web-release.js",
  "scripts/prepare-web-release.js",
  "scripts/public-release-provenance.js",
  "scripts/web-release-lane.js",
  "apps/worker/scripts/production-deploy.check.mjs",
  "apps/worker/scripts/production-deploy.mjs",
  "apps/worker/scripts/stage-production-assets.check.mjs",
  "apps/worker/scripts/stage-production-assets.mjs",
  "apps/web/test/community-site.test.mjs",
  "docs/runbooks/2026-08-17-web-only-release.md",
  "docs/runbooks/macos-stable-release-runbook.md",
  "test/localization-system.test.js",
  "test/public-release-site-preview.test.js",
  "test/public-release-site.test.js",
  "test/web-release-lane.test.js",
]);
const WEB_RELEASE_PACKAGE_SCRIPTS = Object.freeze({
  "product:release-site:test":
    "node --test test/public-release-site.test.js test/web-release-lane.test.js",
  "product:web-release:prepare": "node ./scripts/prepare-web-release.js",
  "product:web-release:deploy": "node ./scripts/deploy-web-release.js",
  "product:web-release:test": "node --test test/web-release-lane.test.js",
});

function pathWithin(parent, child) {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`)
    && !isAbsolute(value));
}

function safeRelativePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((part) =>
      part === "" || part === "." || part === "..",
    );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function runGit(repositoryRoot, arguments_) {
  const result = spawnSync("/usr/bin/git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect the web-release candidate Git state.");
  }
  return result.stdout;
}

function resolveGitCommit(repositoryRoot, value, label, git) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
    throw new TypeError(`${label} must name a Git commit`);
  }
  let commit;
  try {
    commit = git(repositoryRoot, ["rev-parse", "--verify", `${value}^{commit}`])
      .trim();
  } catch {
    throw new TypeError(`${label} does not resolve to a Git commit`);
  }
  if (!PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(commit)) {
    throw new TypeError(`${label} did not resolve to a full Git object id`);
  }
  return commit;
}

function ensureCleanCandidate(repositoryRoot, git) {
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    .trim() !== "") {
    throw new Error(
      "Web-only release preparation requires a clean, committed candidate tree.",
    );
  }
}

function assertBaseIsAncestor(repositoryRoot, baseCommit, sourceCommit) {
  const result = spawnSync(
    "/usr/bin/git",
    ["-C", repositoryRoot, "merge-base", "--is-ancestor", baseCommit, sourceCommit],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Web-only release base must be an ancestor of the candidate commit.",
    );
  }
}

function parseNameStatus(raw) {
  const tokens = raw.split("\0");
  const changes = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) break;
    if (/^[RC]/u.test(status)) {
      const from = tokens[index++];
      const path = tokens[index++];
      if (!safeRelativePath(from) || !safeRelativePath(path)) {
        throw new Error("Web-only release diff contains an unsafe path.");
      }
      changes.push({ status, from, path });
      continue;
    }
    const path = tokens[index++];
    if (!safeRelativePath(path)) {
      throw new Error("Web-only release diff contains an unsafe path.");
    }
    changes.push({ status, path });
  }
  return changes.sort((left, right) =>
    `${left.path}\0${left.status}\0${left.from ?? ""}`.localeCompare(
      `${right.path}\0${right.status}\0${right.from ?? ""}`,
    ));
}

export function isAllowedWebReleasePath(path) {
  if (!safeRelativePath(path)) return false;
  if (WEB_RELEASE_TOOLING_PATHS.has(path)) return true;
  const prefix = "apps/web/public/";
  if (!path.startsWith(prefix)) return false;
  const basename = path.slice(prefix.length);
  return !basename.includes("/") && PUBLIC_RELEASE_SOURCE_BASENAMES.has(basename);
}

function packageJsonAtCommit(repositoryRoot, commit, git) {
  let value;
  try {
    value = JSON.parse(git(repositoryRoot, ["show", `${commit}:package.json`]));
  } catch {
    throw new Error("Web-only release package metadata is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.scripts === null || typeof value.scripts !== "object"
      || Array.isArray(value.scripts)) {
    throw new Error("Web-only release package metadata has an unsupported shape.");
  }
  return value;
}

function assertPackageJsonScope({ repositoryRoot, baseCommit, sourceCommit, git }) {
  const before = packageJsonAtCommit(repositoryRoot, baseCommit, git);
  const after = packageJsonAtCommit(repositoryRoot, sourceCommit, git);
  const beforeWithoutScripts = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== "scripts"),
  );
  const afterWithoutScripts = Object.fromEntries(
    Object.entries(after).filter(([name]) => name !== "scripts"),
  );
  if (JSON.stringify(beforeWithoutScripts) !== JSON.stringify(afterWithoutScripts)) {
    throw new Error("Web-only release candidate changed unsupported package metadata.");
  }
  const names = new Set([
    ...Object.keys(before.scripts),
    ...Object.keys(after.scripts),
  ]);
  for (const name of names) {
    const beforeValue = before.scripts[name];
    const afterValue = after.scripts[name];
    if (Object.hasOwn(WEB_RELEASE_PACKAGE_SCRIPTS, name)) {
      if (afterValue !== WEB_RELEASE_PACKAGE_SCRIPTS[name]) {
        throw new Error(`Web-only release candidate changed unsupported package script: ${name}`);
      }
      continue;
    }
    if (beforeValue !== afterValue) {
      throw new Error(`Web-only release candidate changed unsupported package script: ${name}`);
    }
  }
}

/**
 * Proves the committed candidate differs from its declared deployed base only
 * in the public-site closure or the release controls that protect that closure.
 */
export function inspectWebReleaseScope({
  repositoryRoot,
  baseCommit: baseRef,
  sourceCommit: sourceRef = "HEAD",
  git = runGit,
}) {
  const root = resolve(repositoryRoot);
  ensureCleanCandidate(root, git);
  const baseCommit = resolveGitCommit(root, baseRef, "Web-only release base", git);
  const sourceCommit = resolveGitCommit(
    root,
    sourceRef,
    "Web-only release candidate",
    git,
  );
  assertBaseIsAncestor(root, baseCommit, sourceCommit);
  try {
    git(root, ["diff", "--check", `${baseCommit}..${sourceCommit}`]);
  } catch {
    throw new Error("Web-only release candidate has whitespace errors.");
  }
  const changes = parseNameStatus(git(
    root,
    ["diff", "--name-status", "-z", `${baseCommit}..${sourceCommit}`],
  ));
  if (changes.length === 0) {
    throw new Error("Web-only release candidate has no committed changes.");
  }
  const unsupported = changes.find((change) =>
    !isAllowedWebReleasePath(change.path)
      || (change.from !== undefined && !isAllowedWebReleasePath(change.from)),
  );
  if (unsupported) {
    throw new Error(
      `Web-only release candidate changed an unsupported path: ${unsupported.path}`,
    );
  }
  if (changes.some((change) => change.path === "package.json")) {
    assertPackageJsonScope({
      repositoryRoot: root,
      baseCommit,
      sourceCommit,
      git,
    });
  }
  return Object.freeze({
    baseCommit,
    sourceCommit,
    changes,
    sha256: sha256(JSON.stringify(changes)),
  });
}

async function regularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing or cannot be inspected.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return metadata;
}

function expectedOutputDirectory(repositoryRoot) {
  return resolve(repositoryRoot, WEB_RELEASE_OUTPUT_DIRECTORY);
}

function expectedManifestPath(repositoryRoot) {
  return join(expectedOutputDirectory(repositoryRoot), "release-site-manifest.json");
}

function expectedReceiptPath(repositoryRoot) {
  return resolve(repositoryRoot, ".release-build", "web-release-receipt.json");
}

function assertReceiptPath(repositoryRoot, receiptPath) {
  if (!isAbsolute(receiptPath)) {
    throw new TypeError("Web-only release receipt path must be absolute.");
  }
  const releaseBuild = resolve(repositoryRoot, ".release-build");
  const receipt = resolve(receiptPath);
  const output = expectedOutputDirectory(repositoryRoot);
  if (!pathWithin(releaseBuild, receipt) || pathWithin(output, receipt)) {
    throw new TypeError(
      "Web-only release receipt must live under .release-build but outside the deployable asset directory.",
    );
  }
  return receipt;
}

function validSourceProvenance(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && value.repositoryCommit === null
    && value.root === "apps/web/public"
    && Array.isArray(value.files)
    && value.files.length > 0
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

async function releaseManifestForCandidate({ repositoryRoot }) {
  const manifestPath = expectedManifestPath(repositoryRoot);
  await regularFile(manifestPath, "Generated web-release manifest");
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Generated web-release manifest is not valid JSON.");
  }
  if (manifest?.schemaVersion !== PUBLIC_RELEASE_MANIFEST_SCHEMA
      || !validSourceProvenance(manifest.source)) {
    throw new Error(
      "Generated web-release manifest is not bound to the selected public source closure.",
    );
  }
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
  };
}

export async function writeWebReleaseReceipt({
  repositoryRoot,
  scope,
  receiptPath = expectedReceiptPath(repositoryRoot),
  replace = false,
  preparedAt = new Date().toISOString(),
}) {
  if (scope === null || typeof scope !== "object"
      || !PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(scope.baseCommit ?? "")
      || !PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(scope.sourceCommit ?? "")
      || !Array.isArray(scope.changes)
      || !/^[a-f0-9]{64}$/u.test(scope.sha256 ?? "")) {
    throw new TypeError("Web-only release receipt requires a verified candidate scope.");
  }
  const repository = resolve(repositoryRoot);
  const target = assertReceiptPath(repository, receiptPath);
  let existing = null;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("Web-only release receipt path is not a safe regular file.");
  }
  if (existing && !replace) {
    throw new Error("Web-only release receipt already exists; pass --replace-receipt to replace it.");
  }
  const site = await releaseManifestForCandidate({
    repositoryRoot: repository,
  });
  const receipt = {
    schemaVersion: WEB_RELEASE_RECEIPT_SCHEMA,
    kind: "web-only",
    preparedAt,
    baseCommit: scope.baseCommit,
    sourceCommit: scope.sourceCommit,
    sourceDiff: {
      sha256: scope.sha256,
      changes: scope.changes,
    },
    site: {
      manifestPath: WEB_RELEASE_MANIFEST_PATH,
      manifestSha256: site.manifestSha256,
      source: site.manifest.source,
      ...(site.manifest.installer
        ? {
          installer: {
            url: site.manifest.installer.url,
            version: site.manifest.installer.version,
            sha256: site.manifest.installer.sha256,
          },
        }
        : {}),
    },
  };
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return Object.freeze({ path: target, receipt });
}

async function readReceipt(receiptPath) {
  await regularFile(receiptPath, "Web-only release receipt");
  try {
    return JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    throw new Error("Web-only release receipt is not valid JSON.");
  }
}

/**
 * Re-check the receipt at deployment time. This intentionally repeats the
 * Git-scope check: a receipt is evidence, not permission to deploy a later
 * branch tip that happens to reuse its generated files.
 */
export async function verifyWebReleaseReceipt({
  repositoryRoot,
  receiptPath = expectedReceiptPath(repositoryRoot),
  git = runGit,
}) {
  const repository = resolve(repositoryRoot);
  const target = assertReceiptPath(repository, receiptPath);
  const receipt = await readReceipt(target);
  if (receipt?.schemaVersion !== WEB_RELEASE_RECEIPT_SCHEMA
      || receipt.kind !== "web-only"
      || !PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(receipt.baseCommit ?? "")
      || !PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(receipt.sourceCommit ?? "")
      || !Array.isArray(receipt?.sourceDiff?.changes)
      || !/^[a-f0-9]{64}$/u.test(receipt?.sourceDiff?.sha256 ?? "")
      || receipt?.site?.manifestPath !== WEB_RELEASE_MANIFEST_PATH
      || !/^[a-f0-9]{64}$/u.test(receipt?.site?.manifestSha256 ?? "")
      || !validSourceProvenance(receipt?.site?.source)) {
    throw new Error("Web-only release receipt has an unsupported shape.");
  }
  const scope = inspectWebReleaseScope({
    repositoryRoot: repository,
    baseCommit: receipt.baseCommit,
    sourceCommit: receipt.sourceCommit,
    git,
  });
  if (scope.sha256 !== receipt.sourceDiff.sha256
      || JSON.stringify(scope.changes) !== JSON.stringify(receipt.sourceDiff.changes)) {
    throw new Error("Web-only release receipt no longer matches the candidate diff.");
  }
  const site = await releaseManifestForCandidate({
    repositoryRoot: repository,
  });
  if (site.manifestSha256 !== receipt.site.manifestSha256
      || JSON.stringify(site.manifest.source) !== JSON.stringify(receipt.site.source)) {
    throw new Error("Web-only release receipt no longer matches the generated site.");
  }
  return Object.freeze({ receipt, scope, site });
}
