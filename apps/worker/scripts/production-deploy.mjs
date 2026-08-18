import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { parse } from "jsonc-parser";
import { checkDeploymentEndpointConsumers } from "./check-deployment-endpoints.mjs";
import { checkLocalWorkspacePackages } from "./check-local-workspace-packages.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";
import { runReleasePreflight } from "./release-preflight.mjs";

// Renamed from DEPLOY_CONTAINED_PRODUCTION on 2026-08-07: production deploys
// no longer assert a contained/paused intake posture, so the old token lied.
// See docs/governance/2026-08-07-production-deploy-migration-gate.md.
export const PRODUCTION_DEPLOY_CONFIRMATION =
  "DEPLOY_PRODUCTION";
const PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS = 10_000;
// Wrangler creates these runtime-state directories at the node_modules root
// while release preflight runs. They contain account/Miniflare cache data, not
// installed package code, and can legitimately appear after the dependency
// snapshot is taken. Skip only these root entries: identically named paths
// inside an installed package remain covered by the integrity digest.
const DEPENDENCY_RUNTIME_STATE_DIRECTORIES = new Set([".cache", ".mf"]);
const PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS = Object.freeze([
  "/app.js",
  "/data-client.js",
  "/navigation.js",
  "/admin",
  "/admin.html",
  "/admin.js",
  "/admin-client.js",
  "/admin.css",
]);
const PRODUCTION_PUBLIC_ROOT_FORBIDDEN_MARKERS = Object.freeze([
  'src="./app.js"',
  'id="share-panel"',
  'id="identity-google-signin"',
  'id="contribution-cta"',
  'id="blind-spot-list"',
]);

function localFailure(code) {
  return { ok: false, code };
}

function boundedExcerpt(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

// A bare PRODUCTION_MIGRATION_STATE_UNKNOWN told the operator nothing about
// which of the gate's reads failed or why; every undeterminable outcome now
// names the database, the stage that failed, and what that stage produced.
function migrationStateUnknown(detail) {
  return { ok: false, code: "PRODUCTION_MIGRATION_STATE_UNKNOWN", detail };
}

// Production D1 migration gate
// (docs/governance/2026-08-07-production-deploy-migration-gate.md): the
// dangerous part of a routine deploy is a schema migration riding along
// unnoticed, not intake. A deploy that carries no unapplied migrations
// proceeds with no receipt; a deploy that does carry them must name every
// one explicitly through --confirm-migrations. An undeterminable pending
// set fails closed.
const PRODUCTION_D1_DATABASES = Object.freeze([
  Object.freeze({ binding: "USAGE_MONITOR_DB", migrationsDir: "migrations" }),
  Object.freeze({
    binding: "DELETION_LEDGER",
    migrationsDir: "deletion-ledger-migrations",
  }),
]);
const PRODUCTION_MIGRATION_FILENAME_PATTERN =
  /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/u;
export const PRODUCTION_MIGRATION_LEDGER_SQL =
  "SELECT id, name FROM d1_migrations ORDER BY id";

function parseD1ExecuteRows(stdout) {
  try {
    const value = JSON.parse(stdout);
    const entries = Array.isArray(value) ? value : [];
    const result = entries.findLast((entry) => Array.isArray(entry?.results));
    return result?.results ?? null;
  } catch {
    return null;
  }
}

async function listLocalMigrationNames(workerDirectory, migrationsDir) {
  const entries = await readdir(join(workerDirectory, migrationsDir), {
    withFileTypes: true,
  });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  return names.length > 0
      && names.every((name) => PRODUCTION_MIGRATION_FILENAME_PATTERN.test(name))
    ? names
    : null;
}

/**
 * Determine which checked-out D1 migrations are not yet recorded in the
 * remote production migration ledgers. The only remote operation is a
 * read-only SELECT against d1_migrations; nothing is applied or mutated.
 * Any unreadable directory, failed or unparseable query, non-sequential
 * ledger, or ledger entry unknown to the checkout fails closed.
 */
export async function determinePendingProductionMigrations({
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const pending = [];
  for (const database of PRODUCTION_D1_DATABASES) {
    let local;
    try {
      local = await listLocalMigrationNames(
        workerDirectory,
        database.migrationsDir,
      );
    } catch {
      local = null;
    }
    if (!Array.isArray(local)) {
      return migrationStateUnknown({
        stage: "local-migration-inventory",
        binding: database.binding,
        migrationsDir: database.migrationsDir,
      });
    }
    let query;
    try {
      query = spawn(
        wrangler,
        [
          "d1",
          "execute",
          database.binding,
          "--remote",
          "--env",
          "production",
          "--command",
          PRODUCTION_MIGRATION_LEDGER_SQL,
          "--json",
        ],
        {
          cwd: workerDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      return migrationStateUnknown({
        stage: "wrangler-spawn",
        binding: database.binding,
        error: boundedExcerpt(error?.message ?? String(error)),
      });
    }
    if (query?.error || query?.status !== 0) {
      return migrationStateUnknown({
        stage: "wrangler-exit",
        binding: database.binding,
        status: query?.status ?? null,
        stderr: boundedExcerpt(query?.stderr),
        ...(query?.error
          ? { error: boundedExcerpt(query.error?.message ?? String(query.error)) }
          : {}),
      });
    }
    const stdout = typeof query?.stdout === "string" ? query.stdout : "";
    const rows = parseD1ExecuteRows(stdout);
    if (!Array.isArray(rows)) {
      return migrationStateUnknown({
        stage: "ledger-parse",
        binding: database.binding,
        stdout: boundedExcerpt(stdout),
        stderr: boundedExcerpt(query?.stderr),
      });
    }
    if (!rows.every((row, index) => Number(row?.id) === index + 1
      && typeof row?.name === "string")) {
      return migrationStateUnknown({
        stage: "ledger-sequence",
        binding: database.binding,
        rowCount: rows.length,
      });
    }
    const applied = rows.map((row) => row.name);
    if (applied.length > local.length
        || !applied.every((name, index) => name === local[index])) {
      const index = applied.findIndex((name, at) => name !== local[at]);
      return {
        ok: false,
        code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
        detail: {
          binding: database.binding,
          appliedCount: applied.length,
          localCount: local.length,
          firstMismatch: {
            index,
            applied: applied[index],
            local: local[index] ?? null,
          },
        },
      };
    }
    for (const name of local.slice(applied.length)) {
      pending.push(`${database.binding}:${name}`);
    }
  }
  return { ok: true, code: null, pending };
}

function confirmedMigrationTokens(confirmedMigrations) {
  if (confirmedMigrations === null || confirmedMigrations === undefined) {
    return null;
  }
  return String(confirmedMigrations)
    .split(",")
    .map((token) => token.trim());
}

function assessMigrationGate({ pending, confirmedMigrations }) {
  const confirmed = confirmedMigrationTokens(confirmedMigrations);
  if (pending.length === 0) {
    // A migration confirmation with nothing pending means the operator's
    // model of production state is wrong; fail closed rather than ignore it.
    return confirmed === null
      ? { ok: true, code: null, pendingMigrations: [] }
      : {
        ok: false,
        code: "PRODUCTION_MIGRATIONS_CONFIRMATION_UNEXPECTED",
        pendingMigrations: [],
      };
  }
  if (confirmed === null) {
    return {
      ok: false,
      code: "PRODUCTION_MIGRATIONS_UNCONFIRMED",
      pendingMigrations: pending,
    };
  }
  if (confirmed.length !== pending.length
      || !confirmed.every((token, index) => token === pending[index])) {
    return {
      ok: false,
      code: "PRODUCTION_MIGRATIONS_CONFIRMATION_MISMATCH",
      pendingMigrations: pending,
    };
  }
  return { ok: true, code: null, pendingMigrations: pending };
}

function checkedOutSourceCommit(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      ["-C", workerDirectory, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    return /^[a-f0-9]{7,64}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function checkedOutSourceTreeClean(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      [
        "-C",
        workerDirectory,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { encoding: "utf8" },
    );
    return value.trim() === "";
  } catch {
    return null;
  }
}

function verifySourceSnapshot({
  workerDirectory,
  expectedSourceCommit,
  sourceCommitCheck,
  sourceTreeCleanCheck,
}) {
  const sourceCommit = sourceCommitCheck(workerDirectory);
  if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
    return localFailure("PRODUCTION_SOURCE_REVISION_UNAVAILABLE");
  }
  if (expectedSourceCommit !== null
      && sourceCommit !== expectedSourceCommit) {
    return localFailure("PRODUCTION_SOURCE_REVISION_CHANGED");
  }
  let clean;
  try {
    clean = sourceTreeCleanCheck(workerDirectory);
  } catch {
    clean = null;
  }
  if (clean !== true) {
    return localFailure("PRODUCTION_SOURCE_TREE_CHANGED");
  }
  return { ok: true, sourceCommit };
}

function pathWithin(parent, child) {
  const path = relative(parent, child);
  return path === ""
    || (path !== ".."
      && !path.startsWith(`..${sep}`)
      && !isAbsolute(path));
}

function sourceRepositoryRoot(workerDirectory) {
  try {
    const canonicalWorkerDirectory = realpathSync(workerDirectory);
    const reportedRoot = execFileSync(
      "/usr/bin/git",
      ["-C", canonicalWorkerDirectory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    if (!reportedRoot) throw new Error("Git did not report a repository root.");
    const canonicalRoot = realpathSync(
      isAbsolute(reportedRoot)
        ? reportedRoot
        : resolve(canonicalWorkerDirectory, reportedRoot),
    );
    const verifiedRoot = execFileSync(
      "/usr/bin/git",
      ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    const canonicalVerifiedRoot = realpathSync(
      isAbsolute(verifiedRoot)
        ? verifiedRoot
        : resolve(canonicalRoot, verifiedRoot),
    );
    if (canonicalVerifiedRoot !== canonicalRoot
        || !pathWithin(canonicalRoot, canonicalWorkerDirectory)) {
      throw new Error("Git repository root does not contain the Worker directory.");
    }
    return canonicalRoot;
  } catch {
    const error = new Error("Unable to resolve the checked-out Git repository root.");
    error.code = "PRODUCTION_SOURCE_REPOSITORY_UNAVAILABLE";
    throw error;
  }
}

async function requireSafeDirectory(path, label) {
  const metadata = await lstat(path).catch((error) => {
    throw new Error(`${label} is missing or cannot be inspected.`, {
      cause: error,
    });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must not already exist.`);
}

/**
 * A deterministic content-and-structure digest of a dependency tree. The root
 * is realpath-resolved, so a symlinked node_modules digests the bytes of its
 * target. Entries are visited in a fixed sorted order and file content, symlink
 * targets, sizes, and directory structure all contribute, so any post-snapshot
 * mutation of installed dependency content produces a different digest. Known
 * Wrangler runtime-state directories at the root are excluded because preflight
 * legitimately creates them after the snapshot. Symlinks are recorded by target
 * string rather than followed, so internal `.bin` links and cycles neither
 * escape the tree nor double-count content.
 *
 * This is the mitigation for the ignored-node_modules gap: the snapshot records
 * this digest, and the deploy path reverifies it immediately before and after
 * Wrangler runs, binding the exact dependency bytes across the race window that
 * the source revalidation alone does not cover.
 */
export async function dependencyTreeDigest(rootPath) {
  const resolvedRoot = realpathSync(rootPath);
  const hash = createHash("sha256");
  async function walk(absolute, relativePath) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      if (relativePath === ""
          && DEPENDENCY_RUNTIME_STATE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relativePath === ""
        ? entry.name
        : `${relativePath}/${entry.name}`;
      const info = await lstat(childAbsolute);
      if (info.isSymbolicLink()) {
        hash.update(`L\0${childRelative}\0${await readlink(childAbsolute)}\0`);
      } else if (info.isDirectory()) {
        hash.update(`D\0${childRelative}\0`);
        await walk(childAbsolute, childRelative);
      } else if (info.isFile()) {
        const fileHash = createHash("sha256")
          .update(await readFile(childAbsolute))
          .digest("hex");
        hash.update(`F\0${childRelative}\0${info.size}\0${fileHash}\0`);
      } else {
        // A device, socket, or fifo has no reviewable content; its presence in a
        // dependency tree is itself part of the structure being pinned.
        hash.update(`O\0${childRelative}\0`);
      }
    }
  }
  await walk(resolvedRoot, "");
  return hash.digest("hex");
}

async function verifySnapshotDependencyLink({
  dependencyPath,
  expectedTarget,
}) {
  const metadata = await lstat(dependencyPath);
  if (!metadata.isSymbolicLink()) {
    throw new Error("Snapshot dependency link changed unexpectedly.");
  }
  const target = await readlink(dependencyPath);
  const resolvedTarget = resolve(dirname(dependencyPath), target);
  if (resolvedTarget !== resolve(expectedTarget)) {
    throw new Error("Snapshot dependency link changed unexpectedly.");
  }
}

function runSnapshotGit(excludeFile, repositoryRoot, arguments_) {
  return execFileSync(
    "/usr/bin/git",
    ["-c", `core.excludesFile=${excludeFile}`, "-C", repositoryRoot, ...arguments_],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}

export async function createImmutableSourceSnapshot({
  workerDirectory,
  sourceCommit,
}) {
  const repositoryRoot = sourceRepositoryRoot(workerDirectory);
  const snapshotParent = await mkdtemp(
    join(tmpdir(), "usage-monitor-production-source-"),
  );
  const snapshotRoot = join(snapshotParent, "repository");
  let worktreeAdded = false;
  try {
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        "--quiet",
        snapshotRoot,
        sourceCommit,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    worktreeAdded = true;
    const snapshotGitExclude = join(snapshotParent, "git-exclude");
    await writeFile(
      snapshotGitExclude,
      "apps/worker/node_modules\n",
      { mode: 0o600 },
    );

    const generatedSource = join(
      repositoryRoot,
      ".release-build",
      "public-release-site",
    );
    const snapshotGeneratedSource = join(
      snapshotRoot,
      ".release-build",
      "public-release-site",
    );
    const generatedMetadata = await lstat(generatedSource);
    if (!generatedMetadata.isDirectory()
        || generatedMetadata.isSymbolicLink()) {
      throw new Error("Generated public release output must be a real directory.");
    }
    const snapshotReleaseBuild = dirname(snapshotGeneratedSource);
    try {
      await requireSafeDirectory(snapshotReleaseBuild, "Snapshot release-build directory");
    } catch (error) {
      if (error?.cause?.code !== "ENOENT") throw error;
      await mkdir(snapshotReleaseBuild, { mode: 0o755 });
    }
    await requireAbsent(snapshotGeneratedSource, "Snapshot generated asset directory");
    await cp(generatedSource, snapshotGeneratedSource, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await requireSafeDirectory(
      snapshotGeneratedSource,
      "Snapshot generated asset directory",
    );

    // Wrangler is launched from the snapshot, but its installed dependency
    // tree is not source input and remains the locally checked dependency set.
    const snapshotApps = join(snapshotRoot, "apps");
    const snapshotWorker = join(snapshotApps, "worker");
    await requireSafeDirectory(snapshotApps, "Snapshot apps directory");
    await requireSafeDirectory(snapshotWorker, "Snapshot Worker directory");
    const dependencySource = resolve(workerDirectory, "node_modules");
    await requireSafeDirectory(dependencySource, "Checked-out Worker dependencies");
    const dependencyDestination = join(snapshotWorker, "node_modules");
    await requireAbsent(dependencyDestination, "Snapshot Worker dependencies");
    await symlink(
      dependencySource,
      dependencyDestination,
      "dir",
    );
    // Record an immutable digest of the linked dependency tree. The deploy path
    // reverifies this before and after Wrangler runs, so a compromise of the
    // mutable node_modules after this point is detected and fails the deploy
    // closed rather than crossing into release execution or the bundle.
    const dependencyDigest = await dependencyTreeDigest(dependencyDestination);

    return {
      repositoryRoot: snapshotRoot,
      workerDirectory: snapshotWorker,
      dependencyDigest,
      dependencyPath: dependencyDestination,
      git: (root, arguments_) => runSnapshotGit(
        snapshotGitExclude,
        root,
        arguments_,
      ),
      async cleanup() {
        try {
          await verifySnapshotDependencyLink({
            dependencyPath: dependencyDestination,
            expectedTarget: dependencySource,
          });
          execFileSync(
            "/usr/bin/git",
            [
              "-C",
              repositoryRoot,
              "worktree",
              "remove",
              "--force",
              snapshotRoot,
            ],
            { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
          );
          await rm(snapshotParent, { recursive: true, force: false });
        } catch (error) {
          const cleanupError = new Error(
            "Production source snapshot cleanup failed.",
            { cause: error },
          );
          cleanupError.code = "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED";
          throw cleanupError;
        }
      },
    };
  } catch (error) {
    try {
      if (worktreeAdded) {
        execFileSync(
          "/usr/bin/git",
          [
            "-C",
            repositoryRoot,
            "worktree",
            "remove",
            "--force",
            snapshotRoot,
          ],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        );
      }
      await rm(snapshotParent, { recursive: true, force: false });
    } catch (cleanupError) {
      cleanupError.code = "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED";
      throw cleanupError;
    }
    throw error;
  }
}

async function productionReleasePreflight({ workerDirectory, wrangler, spawn }) {
  const configPath = join(workerDirectory, "wrangler.jsonc");
  const config = parse(await readFile(configPath, "utf8"));
  return runReleasePreflight({
    config,
    configPath,
    workerDirectory,
    wrangler,
    spawn,
  });
}

function secureJsonHeaders(response) {
  return response.headers?.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

function healthyProductionHealth(value) {
  // The pre-2026-08-07 gate additionally asserted enrollmentMode: "disabled"
  // and fully contained collection controls here. Production deploys now
  // happen against a live, enrollment-open service, so the recheck asserts
  // reachability, canonical origin, transport, security headers, and reported
  // health only (docs/governance/2026-08-07-production-deploy-migration-gate.md).
  return value?.status === "ok";
}

export async function recheckProductionHealth({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const healthURL = new URL(
    "/api/health",
    DEPLOYMENT_ENDPOINTS.public.origin,
  ).href;
  let response;
  try {
    response = await fetchImpl(healthURL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (response?.url !== healthURL
      || response.status !== 200
      || !secureJsonHeaders(response)
      || typeof response.text !== "function") {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  let body;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
    }
    body = JSON.parse(text);
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  if (!healthyProductionHealth(body)) {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNHEALTHY");
  }
  return { ok: true, code: null };
}

export async function recheckProductionPublicSurface({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const publicOrigin = DEPLOYMENT_ENDPOINTS.public.origin;
  const rootURL = new URL("/", publicOrigin).href;
  let rootResponse;
  try {
    rootResponse = await fetchImpl(rootURL, {
      method: "GET",
      headers: { accept: "text/html" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (rootResponse?.url !== rootURL
      || rootResponse.status !== 200
      || rootResponse.headers?.get("content-type")?.split(";", 1)[0]
        !== "text/html"
      || typeof rootResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  let rootBody;
  try {
    rootBody = await rootResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  if (Buffer.byteLength(rootBody, "utf8") > 1024 * 1024) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  if (PRODUCTION_PUBLIC_ROOT_FORBIDDEN_MARKERS.some((marker) =>
    rootBody.includes(marker))) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED");
  }

  const expectedCanonicalLink =
    `<link rel="canonical" href="${rootURL}">`;
  const expectedOpenGraphUrl =
    `<meta property="og:url" content="${rootURL}">`;
  if (!rootBody.includes(expectedCanonicalLink)
      || !rootBody.includes(expectedOpenGraphUrl)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_CANONICAL_ROOT_INVALID");
  }

  const robotsURL = new URL("/robots.txt", publicOrigin).href;
  let robotsResponse;
  try {
    robotsResponse = await fetchImpl(robotsURL, {
      method: "GET",
      headers: { accept: "text/plain" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (robotsResponse?.url !== robotsURL
      || robotsResponse.status !== 200
      || robotsResponse.headers?.get("content-type")?.split(";", 1)[0]
        !== "text/plain"
      || typeof robotsResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  let robotsBody;
  try {
    robotsBody = await robotsResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  if (Buffer.byteLength(robotsBody, "utf8") > 64 * 1024) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }

  const sitemapURL = new URL("/sitemap.xml", publicOrigin).href;
  if (!robotsBody.includes(`Sitemap: ${sitemapURL}`)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  let sitemapResponse;
  try {
    sitemapResponse = await fetchImpl(sitemapURL, {
      method: "GET",
      headers: { accept: "application/xml, text/xml;q=0.9" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  const sitemapContentType = sitemapResponse?.headers?.get("content-type")
    ?.split(";", 1)[0];
  if (sitemapResponse?.url !== sitemapURL
      || sitemapResponse.status !== 200
      || !["application/xml", "text/xml"].includes(sitemapContentType)
      || typeof sitemapResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }
  let sitemapBody;
  try {
    sitemapBody = await sitemapResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }
  if (Buffer.byteLength(sitemapBody, "utf8") > 1024 * 1024
      || !sitemapBody.includes(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      )
      || !sitemapBody.includes(`<loc>${rootURL}</loc>`)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }

  const wwwURL = new URL(publicOrigin);
  wwwURL.hostname = `www.${wwwURL.hostname}`;
  const wwwRootURL = new URL("/", wwwURL).href;
  let wwwResponse;
  try {
    wwwResponse = await fetchImpl(wwwRootURL, {
      method: "GET",
      headers: { accept: "text/html" },
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (wwwResponse?.url !== wwwRootURL
      || wwwResponse.status !== 308
      || wwwResponse.headers?.get("location") !== rootURL) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_WWW_REDIRECT_INVALID");
  }

  for (const path of PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS) {
    const url = new URL(path, publicOrigin).href;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
    }
    if (response?.url !== url || response.status !== 404) {
      return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED");
    }
  }
  return { ok: true, code: null };
}

async function runProductionDeploymentFromSnapshot({
  confirmedMigrations = null,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  migrationGateCheck = null,
  determinePendingMigrations = determinePendingProductionMigrations,
  log = (line) => process.stderr.write(line),
  sourceCommit,
  snapshotRepositoryRoot,
  snapshotGit,
  snapshotDependencyDigest,
  snapshotDependencyPath,
  dependencyDigestCheck = dependencyTreeDigest,
  sourceCheckDirectory,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
}) {
  // The dependency tree the deploy executes from is not under Git provenance, so
  // it is bound by digest instead: reverify it against the snapshot digest
  // immediately before and after Wrangler, so a mutation of the mutable tree
  // between snapshot and execution fails closed rather than crossing into the
  // release. Any read failure is also fail-closed.
  const verifyDependencyDigest = async () => {
    let current;
    try {
      current = await dependencyDigestCheck(snapshotDependencyPath);
    } catch {
      return localFailure("PRODUCTION_DEPENDENCY_TREE_VERIFICATION_FAILED");
    }
    if (current !== snapshotDependencyDigest) {
      return localFailure("PRODUCTION_DEPENDENCY_TREE_DIGEST_MISMATCH");
    }
    return null;
  };
  // Migration gate: the deploy source is the snapshot, so pending migrations
  // are computed from the snapshot's migration directories against the remote
  // production ledgers before any other gate runs.
  const pendingCheck = migrationGateCheck ?? await determinePendingMigrations({
    wrangler,
    workerDirectory,
    spawn,
  });
  if (!pendingCheck?.ok) {
    return pendingCheck?.code
      ? pendingCheck
      : migrationStateUnknown({ stage: "gate-result" });
  }
  if (!Array.isArray(pendingCheck.pending)) {
    return migrationStateUnknown({ stage: "gate-pending-list" });
  }
  const migrationGate = assessMigrationGate({
    pending: pendingCheck.pending,
    confirmedMigrations,
  });
  if (!migrationGate.ok) return migrationGate;
  const pendingMigrations = migrationGate.pendingMigrations;
  if (pendingMigrations.length > 0) {
    log(
      "Production deploy carries unapplied D1 migrations "
        + "(explicitly confirmed):\n"
        + pendingMigrations.map((id) => `  ${id}\n`).join("")
        + "This deploy does NOT apply them; run the reviewed migration "
        + "procedure for the exact set above.\n",
    );
  }

  let preflight;
  try {
    preflight = await releasePreflight({ workerDirectory, wrangler, spawn });
  } catch {
    return localFailure("RELEASE_PREFLIGHT_BLOCKED");
  }
  if (preflight?.state !== "ready") {
    return {
      ok: false,
      code: "RELEASE_PREFLIGHT_BLOCKED",
      blockers: Array.isArray(preflight?.blockers)
        ? preflight.blockers
        : ["LOCAL_RELEASE_PREFLIGHT_FAILED"],
    };
  }

  try {
    await checkWorkspacePackages();
  } catch (error) {
    const code = [
      "ACCOUNTING_PACKAGE_STALE",
      "TELEMETRY_CONTRACT_PACKAGE_STALE",
      "QUOTA_ANALYSIS_PACKAGE_STALE",
    ].includes(error?.code)
      ? error.code
      : "WORKSPACE_PACKAGES_CHECK_FAILED";
    return localFailure(code);
  }
  try {
    await checkEndpoints();
  } catch {
    return localFailure("DEPLOYMENT_ENDPOINTS_INVALID");
  }
  try {
    await stageAssets({
      repositoryRoot: snapshotRepositoryRoot,
      sourceDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "public-release-site",
      ),
      destinationDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "worker-assets",
      ),
      expectedSourceCommit: sourceCommit,
      git: snapshotGit,
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_ASSETS_INVALID");
  }
  let health;
  try {
    health = await healthRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (!health?.ok) {
    return health?.code
      ? health
      : localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }

  // This is deliberately immediately before Wrangler: health probing can
  // yield to another checkout, so the earlier post-staging check is not the
  // deployment boundary.
  const deploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!deploySource.ok) return deploySource;

  // Same deployment boundary as the source recheck: bind the dependency bytes
  // immediately before Wrangler executes them.
  const preDeployDependency = await verifyDependencyDigest();
  if (preDeployDependency) return preDeployDependency;

  let deployment;
  try {
    deployment = spawn(
      wrangler,
      [
        "deploy",
        "--env",
        "production",
        "--strict",
        // This is deliberately non-secret provenance. It lets the canonical
        // health endpoint identify the exact immutable snapshot that is live,
        // which is required to form the base for the next web-only release.
        "--var",
        `DEPLOYMENT_SOURCE_COMMIT:${sourceCommit}`,
      ],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  const postDeploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!postDeploySource.ok) return postDeploySource;
  // Reverify the dependency tree after bundling, so a mutation concurrent with
  // the Wrangler run is caught before the deploy is reported successful.
  const postDeployDependency = await verifyDependencyDigest();
  if (postDeployDependency) return postDeployDependency;
  if (deployment?.error || deployment?.status !== 0) {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  let postDeployHealth;
  try {
    postDeployHealth = await healthRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
  } catch {
    return localFailure("PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_UNREACHABLE");
  }
  if (postDeployHealth?.ok !== true) {
    const reason = typeof postDeployHealth?.code === "string"
      && postDeployHealth.code.startsWith("PRODUCTION_HEALTH_RECHECK_")
      ? postDeployHealth.code.slice("PRODUCTION_HEALTH_RECHECK_".length)
      : "AMBIGUOUS";
    return localFailure(`PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_${reason}`);
  }
  let postDeployPublicSurface;
  try {
    postDeployPublicSurface = await publicSurfaceRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
  } catch {
    return localFailure(
      "PRODUCTION_POST_DEPLOY_PUBLIC_SURFACE_RECHECK_UNREACHABLE",
    );
  }
  if (postDeployPublicSurface?.ok !== true) {
    const reason = typeof postDeployPublicSurface?.code === "string"
      && postDeployPublicSurface.code.startsWith(
        "PRODUCTION_PUBLIC_SURFACE_",
      )
      ? postDeployPublicSurface.code.slice(
        "PRODUCTION_PUBLIC_SURFACE_".length,
      )
      : "AMBIGUOUS";
    return localFailure(
      `PRODUCTION_POST_DEPLOY_PUBLIC_SURFACE_${reason}`,
    );
  }
  return {
    ok: true,
    code: "PRODUCTION_DEPLOYED",
    channel: "stable",
    collectionAuthorized: false,
    migrationGate: pendingMigrations.length === 0
      ? "no_unapplied_migrations"
      : "unapplied_migrations_explicitly_confirmed",
    pendingMigrations,
    immediateHealthRecheck: "healthy",
    postDeployHealthRecheck: "healthy",
    postDeployPublicSurfaceRecheck: "public-only",
  };
}

export async function runProductionDeployment({
  confirmation,
  confirmedMigrations = null,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  migrationGateCheck = null,
  determinePendingMigrations = determinePendingProductionMigrations,
  log = (line) => process.stderr.write(line),
  expectedSourceCommit = null,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  createSourceSnapshot = createImmutableSourceSnapshot,
  dependencyDigestCheck = dependencyTreeDigest,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
}) {
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) {
    return localFailure("CONFIRMATION_REQUIRED");
  }
  const initialSource = verifySourceSnapshot({
    workerDirectory,
    expectedSourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!initialSource.ok) return initialSource;
  const sourceCommit = initialSource.sourceCommit;

  let snapshot;
  try {
    snapshot = await createSourceSnapshot({ workerDirectory, sourceCommit });
  } catch (error) {
    return localFailure(
      [
        "PRODUCTION_SOURCE_REPOSITORY_UNAVAILABLE",
        "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
      ].includes(error?.code)
        ? error.code
        : "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
    );
  }
  if (!snapshot
      || typeof snapshot.repositoryRoot !== "string"
      || typeof snapshot.workerDirectory !== "string"
      || typeof snapshot.dependencyDigest !== "string"
      || typeof snapshot.dependencyPath !== "string"
      || typeof snapshot.cleanup !== "function") {
    if (typeof snapshot?.cleanup === "function") {
      try {
        await snapshot.cleanup();
      } catch {
        return localFailure("PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED");
      }
    }
    return localFailure("PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE");
  }

  let result;
  try {
    result = await runProductionDeploymentFromSnapshot({
      confirmedMigrations,
      wrangler,
      workerDirectory: snapshot.workerDirectory,
      snapshotRepositoryRoot: snapshot.repositoryRoot,
      snapshotGit: snapshot.git,
      snapshotDependencyDigest: snapshot.dependencyDigest,
      snapshotDependencyPath: snapshot.dependencyPath,
      dependencyDigestCheck,
      sourceCheckDirectory: workerDirectory,
      sourceCommit,
      spawn,
      checkWorkspacePackages,
      checkEndpoints,
      stageAssets,
      migrationGateCheck,
      determinePendingMigrations,
      log,
      sourceCommitCheck,
      sourceTreeCleanCheck,
      releasePreflight,
      fetchImpl,
      healthRecheck,
      publicSurfaceRecheck,
    });
  } catch {
    result = localFailure("PRODUCTION_DEPLOYMENT_FAILED");
  }

  try {
    await snapshot.cleanup();
  } catch {
    return localFailure("PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED");
  }
  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  return !value || value.startsWith("--") ? null : value;
}

async function main() {
  const plainShape = process.argv.length === 4
    && process.argv[2] === "--confirm";
  const migrationShape = process.argv.length === 6
    && process.argv[2] === "--confirm"
    && process.argv[4] === "--confirm-migrations";
  if (!plainShape && !migrationShape) {
    process.stderr.write(
      "Usage: production-deploy.mjs "
        + `--confirm ${PRODUCTION_DEPLOY_CONFIRMATION} `
        + "[--confirm-migrations BINDING:0000_name.sql,...]\n",
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  let result;
  try {
    const wrangler = join(
      workerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    );
    result = await runProductionDeployment({
      confirmation: option("--confirm"),
      confirmedMigrations: option("--confirm-migrations"),
      wrangler,
      workerDirectory,
    });
  } catch {
    result = { ok: false, code: "PRODUCTION_DEPLOYMENT_FAILED" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
