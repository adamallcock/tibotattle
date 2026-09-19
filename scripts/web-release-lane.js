import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { checkI18nBrowserMirror } from "./generate-i18n-browser-mirror.js";
import {
  buildPublicModelCatalogMirror,
  buildTelemetryBrowserMirror,
  readVerifiedTelemetryBrowserMirror,
} from "./generate-telemetry-browser-mirror.js";
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

/**
 * The public site renders its copy through the canonical catalogue, so a copy
 * change lands there and the browser catalogue is regenerated from it. These
 * are the only two catalogue paths the lane admits; no other `packages/` file
 * becomes permissible.
 */
export const I18N_CANONICAL_PATH = "packages/i18n/index.js";
export const I18N_BROWSER_MIRROR_PATH = "apps/web/public/i18n.generated.js";

/** A literal top-level catalogue entry: `  "some.key": "some value",`. */
const I18N_CATALOG_ENTRY_PATTERN =
  /^ {2}"[A-Za-z][A-Za-z0-9._-]*": "(?:[^"\\]|\\.)*",$/u;

/**
 * The public site renders model names through the reviewed identity vocabulary,
 * so a vocabulary change lands in the canonical module and both browser mirrors
 * are regenerated from it by `scripts/generate-telemetry-browser-mirror.js`.
 * `model-catalog.generated.js` is the public site asset. `telemetry-shared.generated.js`
 * is app-only and is never published - the release-site build and the production
 * staging guard both refuse it by name - but it embeds the same canonical module,
 * so a candidate that leaves it behind is stale rather than correct. It is
 * admitted here only so a proven regeneration can move with its source; no other
 * `packages/` file becomes permissible.
 */
export const MODEL_CATALOG_CANONICAL_PATH =
  "packages/telemetry-contract/src/model-catalog.js";
export const MODEL_CATALOG_BROWSER_MIRROR_PATH =
  "apps/web/public/model-catalog.generated.js";
export const TELEMETRY_SHARED_MIRROR_PATH =
  "apps/web/public/telemetry-shared.generated.js";
const MODEL_CATALOG_MIRROR_PATHS = Object.freeze([
  MODEL_CATALOG_BROWSER_MIRROR_PATH,
  TELEMETRY_SHARED_MIRROR_PATH,
]);
const TELEMETRY_CANONICAL_SOURCE_PREFIX = "packages/telemetry-contract/src/";
const MODEL_CATALOG_BASENAME = "model-catalog.js";
const MODEL_CATALOG_CONTRACT_BASENAME = "model-catalog-contract.js";
/** The reviewed source directory is a small flat module set; refuse a tree that grew. */
const MAXIMUM_TELEMETRY_CANONICAL_MODULES = 64;

/**
 * A literal reviewed identity row, with the optional reviewed pricing columns:
 * `  ["gpt-5.5", "GPT-5.5"],` or `  ["x", "X", "unpriced", null],`. The label is
 * literal text with no escape or quote, so presentation cannot carry expressions.
 */
const MODEL_CATALOG_ROW_PATTERN =
  /^ {2}\["[a-z0-9][a-z0-9.-]*", "[^"\\]*"(?:, "[a-z][a-z_]*", (?:"[a-z0-9][a-z0-9.-]*"|null))?\],$/u;

const PUBLIC_RELEASE_SOURCE_BASENAMES = new Set([
  "apple.svg",
  "community-data.js",
  "community-refresh.js",
  "last-known-good.js",
  "community-view.js",
  "model-visuals.js",
  "community.html",
  "community.js",
  "docs.html",
  "github.svg",
  "i18n.generated.js",
  "install-cta.js",
  "localization.js",
  "model-catalog.generated.js",
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
  "scripts/lib/electron-public-site.mjs",
  "test/electron-public-site.test.js",
  "packages/i18n/index.js",
  MODEL_CATALOG_CANONICAL_PATH,
  "tools/tool-inventory.json",
  "config/release-evidence.js",
  "schemas/release-evidence-v1/manifest.schema.json",
  "scripts/release-evidence-descriptor.js",
  "scripts/release-evidence-policy.js",
  "scripts/release-evidence-output.js",
  "test/release-evidence.test.js",
  "scripts/deploy-web-release.js",
  "scripts/prepare-web-release.js",
  "scripts/preview-public-release-site.js",
  "scripts/public-release-provenance.js",
  "scripts/web-release-lane.js",
  "apps/worker/scripts/production-deploy.check.mjs",
  "apps/worker/scripts/production-deploy.mjs",
  "apps/worker/scripts/production-deployment-lock.mjs",
  "apps/worker/scripts/production-deployment-lock.check.mjs",
  "scripts/lib/release-operation.mjs",
  "test/release-operation.test.js",
  "apps/worker/scripts/stage-production-assets.check.mjs",
  "apps/worker/scripts/stage-production-assets.mjs",
  "apps/web/test/community-site.test.mjs",
  "apps/web/test/community-refresh.test.mjs",
  "apps/web/test/public-allowance-views.test.mjs",
  "docs/runbooks/2026-08-17-web-only-release.md",
  "docs/runbooks/2026-08-17-public-site-local-preview.md",
  "docs/runbooks/macos-stable-release-runbook.md",
  "test/localization-system.test.js",
  "test/public-release-site-preview.test.js",
  "test/public-release-site.test.js",
  "test/web-release-lane.test.js",
]);
const WEB_RELEASE_PACKAGE_SCRIPTS = Object.freeze({
  "product:release-site:test":
    "node --test test/public-release-site.test.js test/public-release-site-preview.test.js test/web-release-lane.test.js test/electron-public-site.test.js",
  "product:release-site:preview": "node ./scripts/preview-public-release-site.js",
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
  // App-only and never published; admitted only as the paired regeneration of
  // the reviewed model vocabulary, which the catalogue proof below enforces.
  if (path === TELEMETRY_SHARED_MIRROR_PATH) return true;
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
 * Only literal catalogue entries may change in the shared canonical i18n file:
 * runtime code, negotiation, formatting and the exported completeness contract
 * must stay byte-identical to the reviewed deployed base.
 */
export function assertI18nCatalogScope({ repositoryRoot, baseCommit, sourceCommit, git }) {
  const strip = (value) => value.split("\n")
    .filter((line) => !I18N_CATALOG_ENTRY_PATTERN.test(line))
    .join("\n");
  const before = git(repositoryRoot, ["show", `${baseCommit}:${I18N_CANONICAL_PATH}`]);
  const after = git(repositoryRoot, ["show", `${sourceCommit}:${I18N_CANONICAL_PATH}`]);
  if (strip(before) !== strip(after)) {
    throw new Error("Web-only release changed i18n runtime code, not only catalogue copy.");
  }
}

/**
 * Only literal reviewed identity rows may change in the canonical model
 * catalogue: the catalogue version, the derived exports, the allowance-track
 * and pricing projections, and the reasoning-effort runtime must stay
 * byte-identical to the reviewed deployed base, so contract code cannot ride
 * along with a site-visible model name.
 */
export function assertModelCatalogScope({ repositoryRoot, baseCommit, sourceCommit, git }) {
  const strip = (value) => value.split("\n")
    .filter((line) => !MODEL_CATALOG_ROW_PATTERN.test(line))
    .join("\n");
  const before = git(repositoryRoot, ["show", `${baseCommit}:${MODEL_CATALOG_CANONICAL_PATH}`]);
  const after = git(repositoryRoot, ["show", `${sourceCommit}:${MODEL_CATALOG_CANONICAL_PATH}`]);
  if (strip(before) !== strip(after)) {
    throw new Error(
      "Web-only release changed model catalogue contract code, not only reviewed identity rows.",
    );
  }
}

/** A canonical source and every mirror generated from it only ever move together. */
function assertCanonicalMirrorPairing(changedPaths, canonicalPath, mirrorPaths) {
  const canonical = changedPaths.has(canonicalPath);
  for (const mirrorPath of mirrorPaths) {
    const mirror = changedPaths.has(mirrorPath);
    if (canonical && !mirror) {
      throw new Error(
        `Web-only release changed ${canonicalPath} without its regenerated ${mirrorPath}.`,
      );
    }
    if (mirror && !canonical) {
      throw new Error(
        `Web-only release changed ${mirrorPath} without a matching ${canonicalPath} change.`,
      );
    }
  }
}

function blobAtCommit(repositoryRoot, commit, path, git) {
  try {
    return git(repositoryRoot, ["show", `${commit}:${path}`]);
  } catch {
    throw new Error(`Web-only release candidate does not carry ${path}.`);
  }
}

/**
 * Prove the candidate's browser catalogue was actually regenerated from its
 * canonical source, and that every shipped locale is still complete. The mirror
 * comparison is the generator's own `--check`, not a restatement of it, and the
 * completeness contract is the i18n package's own exported validator taken from
 * the candidate itself - whose runtime `assertI18nCatalogScope` has already
 * proven identical to the reviewed base.
 */
export async function verifyWebReleaseI18nProof({
  repositoryRoot,
  scope,
  git = runGit,
}) {
  const changedPaths = new Set((scope?.changes ?? []).map((change) => change.path));
  if (!changedPaths.has(I18N_CANONICAL_PATH) && !changedPaths.has(I18N_BROWSER_MIRROR_PATH)) {
    return null;
  }
  const root = resolve(repositoryRoot);
  const canonical = blobAtCommit(root, scope.sourceCommit, I18N_CANONICAL_PATH, git);
  const mirror = blobAtCommit(root, scope.sourceCommit, I18N_BROWSER_MIRROR_PATH, git);
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-web-release-i18n-"));
  try {
    const sourceFile = join(directory, "canonical.mjs");
    const outputFile = join(directory, "mirror.mjs");
    await writeFile(sourceFile, canonical, { encoding: "utf8", mode: 0o600 });
    await writeFile(outputFile, mirror, { encoding: "utf8", mode: 0o600 });
    try {
      await checkI18nBrowserMirror({ outputFile, sourceFile });
    } catch {
      throw new Error(
        `Web-only release candidate ${I18N_BROWSER_MIRROR_PATH} was not regenerated from ${I18N_CANONICAL_PATH}.`,
      );
    }
    const catalogue = await import(pathToFileURL(sourceFile).href);
    if (typeof catalogue.assertCatalogCompleteness !== "function") {
      throw new Error(
        `Web-only release candidate ${I18N_CANONICAL_PATH} does not export the catalogue completeness contract.`,
      );
    }
    let completeness;
    try {
      completeness = catalogue.assertCatalogCompleteness();
    } catch (error) {
      throw new Error(
        `Web-only release candidate i18n locales are incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return Object.freeze({
      canonicalSha256: sha256(canonical),
      mirrorSha256: sha256(mirror),
      locales: completeness.locales,
      keyCount: completeness.keyCount,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Materialise the candidate's canonical telemetry source tree so the generator
 * runs against it exactly as it runs against a checkout. The generator owns
 * which modules it reads, so the whole reviewed source directory is written
 * rather than a lane-local list of basenames.
 */
async function writeTelemetryCanonicalSource({
  repositoryRoot,
  commit,
  sourceDirectory,
  git,
}) {
  const listed = git(repositoryRoot, [
    "ls-tree", "-r", "-z", "--name-only", commit, "--", TELEMETRY_CANONICAL_SOURCE_PREFIX,
  ]).split("\0").filter((value) => value !== "");
  if (listed.length === 0 || listed.length > MAXIMUM_TELEMETRY_CANONICAL_MODULES) {
    throw new Error("Web-only release candidate telemetry source has an unsupported module count.");
  }
  const written = new Map();
  for (const path of listed) {
    if (!safeRelativePath(path) || !path.startsWith(TELEMETRY_CANONICAL_SOURCE_PREFIX)) {
      throw new Error("Web-only release candidate telemetry source contains an unsafe path.");
    }
    const basename = path.slice(TELEMETRY_CANONICAL_SOURCE_PREFIX.length);
    if (basename === "" || basename.includes("/")) {
      throw new Error("Web-only release candidate telemetry source is not a flat module directory.");
    }
    const source = blobAtCommit(repositoryRoot, commit, path, git);
    await writeFile(join(sourceDirectory, basename), source, {
      encoding: "utf8",
      mode: 0o600,
    });
    written.set(basename, source);
  }
  if (!written.has(MODEL_CATALOG_BASENAME)) {
    throw new Error(`Web-only release candidate does not carry ${MODEL_CATALOG_CANONICAL_PATH}.`);
  }
  return written;
}

/**
 * Run the telemetry-contract package's own exported vocabulary contract against
 * one materialised canonical source tree. This is the package's validator, not
 * a lane-local restatement, and it is taken from the tree being judged.
 */
async function reviewedModelVocabulary(sourceDirectory, label) {
  const module = `${TELEMETRY_CANONICAL_SOURCE_PREFIX}${MODEL_CATALOG_CONTRACT_BASENAME}`;
  let contract;
  try {
    contract = await import(
      pathToFileURL(join(sourceDirectory, MODEL_CATALOG_CONTRACT_BASENAME)).href
    );
  } catch {
    throw new Error(`Web-only release ${label} does not carry ${module}.`);
  }
  if (typeof contract.assertReviewedModelCatalogCompleteness !== "function") {
    throw new Error(
      `Web-only release ${label} ${module} does not export the model vocabulary completeness contract.`,
    );
  }
  try {
    return contract.assertReviewedModelCatalogCompleteness();
  } catch (error) {
    throw new Error(
      `Web-only release ${label} model vocabulary is incomplete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function assertRegeneratedMirror({
  mirrorPath,
  outputFile,
  sourceDirectory,
  buildMirror,
}) {
  try {
    return await readVerifiedTelemetryBrowserMirror({
      outputFile,
      sourceDirectory,
      buildMirror,
    });
  } catch {
    throw new Error(
      `Web-only release candidate ${mirrorPath} was not regenerated from ${MODEL_CATALOG_CANONICAL_PATH}.`,
    );
  }
}

/**
 * Prove the candidate's model-catalogue mirrors were actually regenerated from
 * its canonical source. Each comparison is the generator's own `--check`
 * against the candidate's canonical source tree, not a restatement of it, with
 * `buildPublicModelCatalogMirror` selecting the public model mirror and the
 * default build covering the app-only shared mirror that embeds the same
 * module.
 *
 * Both the candidate and the deployed base are then validated by the
 * telemetry-contract package's own exported
 * `assertReviewedModelCatalogCompleteness`, and their identity projections must
 * match. A web-only release may move a site-visible label; it may not move the
 * vocabulary itself, which is reviewed against the accounting price cards, the
 * export registries and the closed v0.2 `modelId` enum - none of which are in
 * this lane's scope. That contract module is not an admissible candidate path,
 * so a candidate cannot weaken the validator it is judged by.
 */
export async function verifyWebReleaseModelCatalogProof({
  repositoryRoot,
  scope,
  git = runGit,
}) {
  const changedPaths = new Set((scope?.changes ?? []).map((change) => change.path));
  if (!changedPaths.has(MODEL_CATALOG_CANONICAL_PATH)
      && !MODEL_CATALOG_MIRROR_PATHS.some((path) => changedPaths.has(path))) {
    return null;
  }
  const root = resolve(repositoryRoot);
  const browserMirror = blobAtCommit(
    root, scope.sourceCommit, MODEL_CATALOG_BROWSER_MIRROR_PATH, git,
  );
  const sharedMirror = blobAtCommit(
    root, scope.sourceCommit, TELEMETRY_SHARED_MIRROR_PATH, git,
  );
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-web-release-model-catalog-"));
  try {
    const sourceDirectory = join(directory, "candidate");
    const baseDirectory = join(directory, "base");
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
    await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    const canonical = await writeTelemetryCanonicalSource({
      repositoryRoot: root,
      commit: scope.sourceCommit,
      sourceDirectory,
      git,
    });
    await writeTelemetryCanonicalSource({
      repositoryRoot: root,
      commit: scope.baseCommit,
      sourceDirectory: baseDirectory,
      git,
    });
    const browserMirrorFile = join(directory, "model-catalog.generated.js");
    const sharedMirrorFile = join(directory, "telemetry-shared.generated.js");
    await writeFile(browserMirrorFile, browserMirror, { encoding: "utf8", mode: 0o600 });
    await writeFile(sharedMirrorFile, sharedMirror, { encoding: "utf8", mode: 0o600 });
    const browser = await assertRegeneratedMirror({
      mirrorPath: MODEL_CATALOG_BROWSER_MIRROR_PATH,
      outputFile: browserMirrorFile,
      sourceDirectory,
      buildMirror: buildPublicModelCatalogMirror,
    });
    const shared = await assertRegeneratedMirror({
      mirrorPath: TELEMETRY_SHARED_MIRROR_PATH,
      outputFile: sharedMirrorFile,
      sourceDirectory,
      buildMirror: buildTelemetryBrowserMirror,
    });
    const vocabulary = await reviewedModelVocabulary(sourceDirectory, "candidate");
    const deployed = await reviewedModelVocabulary(baseDirectory, "deployed base");
    // The catalog version is already a non-row line that `assertModelCatalogScope`
    // pins, but the proof is reachable with a caller-supplied scope, so it stands
    // on its own evidence here.
    if (deployed.version !== vocabulary.version
        || JSON.stringify(deployed.identities) !== JSON.stringify(vocabulary.identities)) {
      throw new Error(
        "Web-only release candidate changed the reviewed model identity vocabulary, not only its site-visible labels.",
      );
    }
    return Object.freeze({
      catalogVersion: vocabulary.version,
      identityCount: vocabulary.identityCount,
      canonicalSha256: sha256(canonical.get(MODEL_CATALOG_BASENAME)),
      browserMirrorSha256: browser.sha256,
      browserMirrorBytes: browser.byteLength,
      sharedMirrorSha256: shared.sha256,
      sharedMirrorBytes: shared.byteLength,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
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
  // A rename away from any paired path is still a change to it, so the pairing
  // checks read both sides of every change.
  const touchedPaths = new Set(changes.flatMap((change) =>
    change.from === undefined ? [change.path] : [change.path, change.from],
  ));
  assertCanonicalMirrorPairing(touchedPaths, I18N_CANONICAL_PATH, [I18N_BROWSER_MIRROR_PATH]);
  assertCanonicalMirrorPairing(
    touchedPaths, MODEL_CATALOG_CANONICAL_PATH, MODEL_CATALOG_MIRROR_PATHS,
  );
  if (changes.some((change) => change.path === I18N_CANONICAL_PATH)) {
    assertI18nCatalogScope({ repositoryRoot: root, baseCommit, sourceCommit, git });
  }
  if (changes.some((change) => change.path === MODEL_CATALOG_CANONICAL_PATH)) {
    assertModelCatalogScope({ repositoryRoot: root, baseCommit, sourceCommit, git });
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
      || !validSourceProvenance(manifest.source)
      || (manifest.electronRelease && manifest.electronRelease.publishedInstallersVerified !== true)) {
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
  git = runGit,
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
  await verifyWebReleaseI18nProof({ repositoryRoot: repository, scope, git });
  await verifyWebReleaseModelCatalogProof({ repositoryRoot: repository, scope, git });
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
  await verifyWebReleaseI18nProof({ repositoryRoot: repository, scope, git });
  await verifyWebReleaseModelCatalogProof({ repositoryRoot: repository, scope, git });
  const site = await releaseManifestForCandidate({
    repositoryRoot: repository,
  });
  if (site.manifestSha256 !== receipt.site.manifestSha256
      || JSON.stringify(site.manifest.source) !== JSON.stringify(receipt.site.source)) {
    throw new Error("Web-only release receipt no longer matches the generated site.");
  }
  return Object.freeze({ receipt, scope, site });
}
