import { execFileSync, spawnSync } from "node:child_process";
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
      return localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
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
    } catch {
      return localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
    }
    if (query?.error || query?.status !== 0) {
      return localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
    }
    const rows = parseD1ExecuteRows(
      typeof query?.stdout === "string" ? query.stdout : "",
    );
    if (!Array.isArray(rows)
        || !rows.every((row, index) => Number(row?.id) === index + 1
          && typeof row?.name === "string")) {
      return localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
    }
    const applied = rows.map((row) => row.name);
    if (applied.length > local.length
        || !applied.every((name, index) => name === local[index])) {
      return localFailure("PRODUCTION_MIGRATION_LEDGER_DRIFT");
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

    return {
      repositoryRoot: snapshotRoot,
      workerDirectory: snapshotWorker,
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
  sourceCheckDirectory,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
}) {
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
      : localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
  }
  if (!Array.isArray(pendingCheck.pending)) {
    return localFailure("PRODUCTION_MIGRATION_STATE_UNKNOWN");
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

  let deployment;
  try {
    deployment = spawn(
      wrangler,
      ["deploy", "--env", "production", "--strict"],
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
