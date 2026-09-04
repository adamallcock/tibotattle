// Re-pinned on 2026-08-07 to the migration-gated production deploy contract:
// the owner-written containment receipt is gone, deploys happen against the
// live enrollment-open service, and the gate is now the set of unapplied D1
// migrations the deploy carries.
// See docs/governance/2026-08-07-production-deploy-migration-gate.md.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  PRODUCTION_MIGRATION_LEDGER_SQL,
  createImmutableSourceSnapshot,
  dependencyTreeDigest,
  determinePendingProductionMigrations,
  runProductionDeployment,
  recheckProductionHealth,
  recheckProductionPublicSurface,
} from "./production-deploy.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";
import { EXPECTED_STAGING_MIGRATIONS } from "./staging-readiness-lib.mjs";
import { workerDirectory as checkedInWorkerDirectory } from "./staging-test-fixtures.mjs";
import {
  createPublicReleaseSourceProvenance,
  PUBLIC_RELEASE_MANIFEST_SCHEMA,
} from "../../../scripts/public-release-provenance.js";

const HEALTH_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/api/health`;
const PUBLIC_ROOT_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/`;
const PUBLIC_ROBOTS_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/robots.txt`;
const PUBLIC_SITEMAP_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/sitemap.xml`;
const PUBLIC_WWW_ROOT_URL = `https://www.${new URL(
  DEPLOYMENT_ENDPOINTS.public.origin,
).hostname}/`;
const FIXTURE_PRIMARY_MIGRATION = "0001_fixture_schema.sql";
const FIXTURE_LEDGER_MIGRATION = "0001_fixture_ledger.sql";
// The fixed dependency-tree digest the mocked-snapshot options carry; the
// matching mocked dependencyDigestCheck returns the same value so the pre- and
// post-Wrangler reverification passes. Real-snapshot tests override the check
// with the real digest function instead.
const FIXTURE_DEPENDENCY_DIGEST = "f".repeat(64);

function git(root, arguments_) {
  return execFileSync("/usr/bin/git", ["-C", root, ...arguments_], {
    encoding: "utf8",
  });
}

async function immutableSnapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-production-snapshot-"));
  const workerDirectory = join(root, "apps", "worker");
  const sourceDirectory = join(
    root,
    ".release-build",
    "public-release-site",
  );
  const publicSourceDirectory = join(root, "apps", "web", "public");
  await mkdir(join(workerDirectory, "node_modules"), { recursive: true });
  await mkdir(join(workerDirectory, "migrations"), { recursive: true });
  await mkdir(join(workerDirectory, "deletion-ledger-migrations"), {
    recursive: true,
  });
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(publicSourceDirectory, { recursive: true });
  await writeFile(
    join(root, ".gitignore"),
    ".release-build/\nnode_modules/\n",
  );
  await writeFile(join(workerDirectory, "wrangler.jsonc"), "{}\n");
  await writeFile(
    join(workerDirectory, "migrations", FIXTURE_PRIMARY_MIGRATION),
    "CREATE TABLE fixture_schema (id INTEGER PRIMARY KEY);\n",
  );
  await writeFile(
    join(
      workerDirectory,
      "deletion-ledger-migrations",
      FIXTURE_LEDGER_MIGRATION,
    ),
    "CREATE TABLE fixture_ledger (id INTEGER PRIMARY KEY);\n",
  );
  const publicSourceFiles = {
    "community.html": '<!doctype html><script type="module" src="./community.js"></script>\n',
    "community.js": "console.log('snapshot public source');\n",
  };
  for (const [path, contents] of Object.entries(publicSourceFiles)) {
    await writeFile(join(publicSourceDirectory, path), contents);
  }

  const generatedFiles = {
    "community.js": "console.log('snapshot community');\n",
    "index.html": '<script type="module" src="./community.js"></script>\n',
    "robots.txt": "User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n",
    "sitemap.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url><loc>https://example.test/</loc></url>",
      "</urlset>",
      "",
    ].join("\n"),
  };
  const manifest = {
    schemaVersion: PUBLIC_RELEASE_MANIFEST_SCHEMA,
    files: [],
  };
  for (const [path, contents] of Object.entries(generatedFiles)) {
    await writeFile(join(sourceDirectory, path), contents);
    const bytes = Buffer.from(contents);
    manifest.files.push({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Production snapshot test"]);
  git(root, [
    "add",
    ".gitignore",
    "apps/worker/wrangler.jsonc",
    "apps/worker/migrations",
    "apps/worker/deletion-ledger-migrations",
    "apps/web/public",
  ]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  manifest.source = await createPublicReleaseSourceProvenance({
    repositoryRoot: root,
    sourceRoot: publicSourceDirectory,
    sourceFiles: Object.keys(publicSourceFiles).map((path) =>
      join(publicSourceDirectory, path)),
  });
  await writeFile(
    join(sourceDirectory, "release-site-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    root,
    workerDirectory,
    sourceDirectory,
    generatedFiles,
    sourceCommit,
  };
}

// Re-pin: the health body is a live, enrollment-open service. The old spec
// required a contained/disabled body; that assertion was removed with the
// containment receipt.
function liveOpenHealth() {
  return {
    status: "ok",
    enrollmentMode: "open",
    collectionControls: { state: "operational" },
  };
}

function jsonHealthResponse(value = liveOpenHealth(), status = 200) {
  return {
    url: HEALTH_URL,
    status,
    headers: {
      get(name) {
        return {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        }[name];
      },
    },
    text: async () => JSON.stringify(value),
  };
}

function textResponse(url, body, {
  status = 200,
  contentType = "text/html; charset=utf-8",
  location = null,
} = {}) {
  return {
    url,
    status,
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        if (name === "location") return location;
        return undefined;
      },
    },
    text: async () => body,
  };
}

function publicRootHtml(extra = "") {
  return [
    "<!doctype html>",
    `<link rel="canonical" href="${PUBLIC_ROOT_URL}">`,
    `<meta property="og:url" content="${PUBLIC_ROOT_URL}">`,
    extra,
  ].join("\n");
}

function publicRobots() {
  return `User-agent: *\nAllow: /\nSitemap: ${PUBLIC_SITEMAP_URL}\n`;
}

function publicSitemap() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${PUBLIC_ROOT_URL}</loc></url>`,
    "</urlset>",
    "",
  ].join("\n");
}

function options(overrides = {}) {
  return {
    confirmation: PRODUCTION_DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory: "/worker",
    expectedSourceCommit: "c26823c",
    sourceCommitCheck: () => "c26823c",
    sourceTreeCleanCheck: () => true,
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      dependencyDigest: FIXTURE_DEPENDENCY_DIGEST,
      dependencyPath: "/immutable/repository/apps/worker/node_modules",
      cleanup: async () => {},
    }),
    dependencyDigestCheck: async () => FIXTURE_DEPENDENCY_DIGEST,
    releasePreflight: async () => ({
      state: "ready",
      blockers: [],
    }),
    migrationGateCheck: { ok: true, code: null, pending: [] },
    log: () => {},
    fetchImpl: async (url) => {
      assert.equal(String(url), HEALTH_URL);
      return jsonHealthResponse();
    },
    publicSurfaceRecheck: async () => ({ ok: true, code: null }),
    ...overrides,
  };
}

test("dependency digest ignores only root Wrangler runtime state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-dependency-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installedPackage = join(root, "installed-package");
  await mkdir(installedPackage, { recursive: true });
  await writeFile(join(installedPackage, "index.js"), "export const value = 1;\n");

  const installedDigest = await dependencyTreeDigest(root);
  await mkdir(join(root, ".cache", "wrangler"), { recursive: true });
  await writeFile(
    join(root, ".cache", "wrangler", "wrangler-account.json"),
    '{"account":"first-run-cache"}\n',
  );
  await mkdir(join(root, ".mf"), { recursive: true });
  await writeFile(join(root, ".mf", "cf.json"), '{"runtime":"local"}\n');
  assert.equal(await dependencyTreeDigest(root), installedDigest);

  await writeFile(
    join(root, ".cache", "wrangler", "wrangler-account.json"),
    '{"account":"refreshed-cache"}\n',
  );
  assert.equal(await dependencyTreeDigest(root), installedDigest);

  // The exception is root-scoped. Package content, including a nested path
  // with the same name as a runtime cache, remains integrity-bound.
  await mkdir(join(installedPackage, ".cache"), { recursive: true });
  await writeFile(join(installedPackage, ".cache", "package-state"), "bound\n");
  const nestedCacheDigest = await dependencyTreeDigest(root);
  assert.notEqual(nestedCacheDigest, installedDigest);

  await writeFile(join(installedPackage, "index.js"), "export const value = 2;\n");
  assert.notEqual(await dependencyTreeDigest(root), nestedCacheDigest);
});

// Re-pin: this end-to-end path previously required an injected containment
// proof; it now exercises the real migration gate against the snapshot's
// committed migration directories with a fully applied remote ledger.
test("production deployment creates a real top-level Git snapshot and passes the migration gate with no unapplied migrations", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const stageCalls = [];
  const stagedIndex = [];
  const healthTimeouts = [];
  const d1Queries = [];
  const deployArgs = [];
  let healthChecks = 0;
  const result = await runProductionDeployment(options({
    workerDirectory: fixture.workerDirectory,
    expectedSourceCommit: fixture.sourceCommit,
    sourceCommitCheck: (directory) => git(directory, ["rev-parse", "HEAD"]).trim(),
    sourceTreeCleanCheck: (directory) => git(
      directory,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ).trim() === "",
    migrationGateCheck: null,
    createSourceSnapshot: undefined,
    dependencyDigestCheck: undefined,
    stageAssets: async (value) => {
      stageCalls.push(value);
      const staged = await stageProductionAssets(value);
      stagedIndex.push(await readFile(
        join(value.destinationDirectory, "index.html"),
        "utf8",
      ));
      assert.equal(
        realpathSync(git(
          value.repositoryRoot,
          ["rev-parse", "--show-toplevel"],
        ).trim()),
        realpathSync(value.repositoryRoot),
      );
      return staged;
    },
    healthRecheck: async ({ timeoutMs }) => {
      healthChecks += 1;
      healthTimeouts.push(timeoutMs);
      return { ok: true, code: null };
    },
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    spawn: (_command, args, spawnOptions) => {
      assert.match(spawnOptions.cwd, /\/repository\/apps\/worker$/u);
      if (args[0] === "d1") {
        d1Queries.push(args);
        const applied = args[2] === "USAGE_MONITOR_DB"
          ? FIXTURE_PRIMARY_MIGRATION
          : FIXTURE_LEDGER_MIGRATION;
        return {
          status: 0,
          stdout: JSON.stringify([{ results: [{ id: 1, name: applied }] }]),
          stderr: "",
        };
      }
      deployArgs.push(args);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.code, "PRODUCTION_DEPLOYED");
  assert.equal(result.migrationGate, "no_unapplied_migrations");
  assert.deepEqual(result.pendingMigrations, []);
  assert.equal(healthChecks, 2);
  assert.deepEqual(healthTimeouts, [10_000, 10_000]);
  assert.deepEqual(deployArgs, [[
    "deploy",
    "--env",
    "production",
    "--strict",
    "--var",
    `DEPLOYMENT_SOURCE_COMMIT:${fixture.sourceCommit}`,
  ]]);
  assert.equal(d1Queries.length, 2);
  assert.deepEqual(d1Queries.map((args) => args[2]), [
    "USAGE_MONITOR_DB",
    "DELETION_LEDGER",
  ]);
  for (const args of d1Queries) {
    assert.deepEqual(args.slice(3, 7), ["--remote", "--env", "production", "--command"]);
    assert.equal(args[7], PRODUCTION_MIGRATION_LEDGER_SQL);
    assert.equal(args[8], "--json");
  }
  assert.deepEqual(stageCalls[0].sourceDirectory, join(
    stageCalls[0].repositoryRoot,
    ".release-build",
    "public-release-site",
  ));
  assert.equal(stageCalls[0].expectedSourceCommit, fixture.sourceCommit);
  assert.notEqual(stageCalls[0].repositoryRoot, join(fixture.root, "apps"));
  assert.equal(stagedIndex[0], fixture.generatedFiles["index.html"]);
  await assert.rejects(
    readFile(join(stageCalls[0].sourceDirectory, "index.html")),
    { code: "ENOENT" },
  );
});

test("production deployment fails closed when the snapshot dependency link is repointed before cleanup", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });
  const dependencyMarker = join(
    fixture.workerDirectory,
    "node_modules",
    "must-survive-cleanup.txt",
  );
  await writeFile(dependencyMarker, "external dependency remains\n");

  let snapshot;
  let dependencyLink;
  let expectedTarget;
  let healthChecks = 0;
  let spawned = false;
  let cleaned = false;
  try {
    const result = await runProductionDeployment(options({
      workerDirectory: fixture.workerDirectory,
      expectedSourceCommit: fixture.sourceCommit,
      sourceCommitCheck: (directory) => git(
        directory,
        ["rev-parse", "HEAD"],
      ).trim(),
      sourceTreeCleanCheck: (directory) => git(
        directory,
        ["status", "--porcelain=v1", "--untracked-files=all"],
      ).trim() === "",
      createSourceSnapshot: async (arguments_) => {
        snapshot = await createImmutableSourceSnapshot(arguments_);
        dependencyLink = join(snapshot.workerDirectory, "node_modules");
        expectedTarget = await readlink(dependencyLink);
        return snapshot;
      },
      // Use the real dependency digest so the pre-/post-Wrangler reverification
      // matches the real snapshot; the link is repointed only later, at cleanup.
      dependencyDigestCheck: undefined,
      releasePreflight: async () => ({ state: "ready", blockers: [] }),
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      healthRecheck: async () => {
        healthChecks += 1;
        if (healthChecks === 2) {
          await rm(dependencyLink);
          await symlink(fixture.workerDirectory, dependencyLink, "dir");
        }
        return { ok: true, code: null };
      },
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: "deployed", stderr: "" };
      },
    }));

    assert.deepEqual(result, {
      ok: false,
      code: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
    });
    assert.equal(spawned, true);
    assert.equal(healthChecks, 2);
    assert.equal(
      await readFile(dependencyMarker, "utf8"),
      "external dependency remains\n",
    );
    assert.equal((await lstat(dependencyLink)).isSymbolicLink(), true);
    assert.equal(await readlink(dependencyLink), fixture.workerDirectory);
    assert.equal((await lstat(snapshot.repositoryRoot)).isDirectory(), true);
  } finally {
    if (snapshot && !cleaned) {
      try {
        await rm(dependencyLink);
        await symlink(expectedTarget, dependencyLink, "dir");
        await snapshot.cleanup();
        cleaned = true;
      } catch {
        // The test fixture cleanup below is the final bounded local cleanup.
      }
    }
  }
});

test("production deployment fails closed when the dependency tree digest changes before Wrangler", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    // The snapshot recorded FIXTURE_DEPENDENCY_DIGEST; the tree now digests to a
    // different value, modelling a post-snapshot compromise of the mutable
    // node_modules the deploy would otherwise execute from.
    dependencyDigestCheck: async () => "a".repeat(64),
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    healthRecheck: async () => ({ ok: true, code: null }),
    spawn: () => {
      spawned = true;
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_DEPENDENCY_TREE_DIGEST_MISMATCH",
  });
  // The mismatch is caught before Wrangler runs: no deploy is executed.
  assert.equal(spawned, false);
});

test("production deployment fails closed when the dependency tree cannot be reverified", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    dependencyDigestCheck: async () => {
      throw new Error("dependency tree unreadable");
    },
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    healthRecheck: async () => ({ ok: true, code: null }),
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_DEPENDENCY_TREE_VERIFICATION_FAILED",
  });
  assert.equal(spawned, false);
});

test("production deployment fails closed when generated release output is a symlink", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const realSourceDirectory = join(fixture.root, "generated-source");
  await rename(fixture.sourceDirectory, realSourceDirectory);
  await symlink(realSourceDirectory, fixture.sourceDirectory, "dir");
  let spawned = false;
  const result = await runProductionDeployment(options({
    workerDirectory: fixture.workerDirectory,
    expectedSourceCommit: fixture.sourceCommit,
    sourceCommitCheck: (directory) => git(directory, ["rev-parse", "HEAD"]).trim(),
    sourceTreeCleanCheck: () => true,
    createSourceSnapshot: undefined,
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
  });
  assert.equal(spawned, false);
});

// Re-pin: the second gate is no longer a receipt file; it is an explicit
// migration confirmation whenever the deploy carries unapplied migrations.
test("production deployment requires scoped confirmation and a migration confirmation before local gates or Wrangler", async () => {
  const calls = [];
  const gated = {
    releasePreflight: async () => {
      calls.push("preflight");
      return { state: "ready", blockers: [] };
    },
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  };
  const result = await runProductionDeployment(options({
    confirmation: "DEPLOY_SOMETHING",
    ...gated,
  }));
  assert.deepEqual(result, { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);

  const unconfirmed = await runProductionDeployment(options({
    migrationGateCheck: {
      ok: true,
      code: null,
      pending: ["USAGE_MONITOR_DB:0030_next.sql"],
    },
    ...gated,
  }));
  assert.deepEqual(unconfirmed, {
    ok: false,
    code: "PRODUCTION_MIGRATIONS_UNCONFIRMED",
    pendingMigrations: ["USAGE_MONITOR_DB:0030_next.sql"],
  });
  assert.deepEqual(calls, []);
});

test("production deployment fails closed when immutable source snapshot setup or cleanup fails", async () => {
  let spawned = false;
  const creationFailure = await runProductionDeployment(options({
    createSourceSnapshot: async () => {
      throw new Error("snapshot creation failed");
    },
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(creationFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
  });
  assert.equal(spawned, false);

  const cleanupFailure = await runProductionDeployment(options({
    migrationGateCheck: {
      ok: false,
      code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    },
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      dependencyDigest: FIXTURE_DEPENDENCY_DIGEST,
      dependencyPath: "/immutable/repository/apps/worker/node_modules",
      cleanup: async () => {
        throw new Error("snapshot cleanup failed");
      },
    }),
  }));
  assert.deepEqual(cleanupFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
  });
});

// Re-pin: replaces the invalid/stale-receipt refusal tests. An undeterminable
// or drifted migration ledger, a mismatched confirmation, and a confirmation
// with nothing pending all fail closed before any local gate or Wrangler.
test("production deployment refuses an unknown, drifted, mismatched, or unexpected migration state before Wrangler", async () => {
  const calls = [];
  const gated = {
    releasePreflight: async () => {
      calls.push("preflight");
      return { state: "ready", blockers: [] };
    },
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  };
  for (const code of [
    "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    "PRODUCTION_MIGRATION_LEDGER_DRIFT",
  ]) {
    const result = await runProductionDeployment(options({
      migrationGateCheck: { ok: false, code },
      ...gated,
    }));
    assert.deepEqual(result, { ok: false, code });
  }

  const failedDiscovery = await runProductionDeployment(options({
    migrationGateCheck: null,
    determinePendingMigrations: async () => ({
      ok: false,
      code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    }),
    ...gated,
  }));
  assert.deepEqual(failedDiscovery, {
    ok: false,
    code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
  });

  const pending = [
    "USAGE_MONITOR_DB:0030_next.sql",
    "DELETION_LEDGER:0003_next.sql",
  ];
  const mismatch = await runProductionDeployment(options({
    migrationGateCheck: { ok: true, code: null, pending },
    confirmedMigrations: "USAGE_MONITOR_DB:0031_other.sql",
    ...gated,
  }));
  assert.deepEqual(mismatch, {
    ok: false,
    code: "PRODUCTION_MIGRATIONS_CONFIRMATION_MISMATCH",
    pendingMigrations: pending,
  });

  const reordered = await runProductionDeployment(options({
    migrationGateCheck: { ok: true, code: null, pending },
    confirmedMigrations: [...pending].reverse().join(","),
    ...gated,
  }));
  assert.deepEqual(reordered, {
    ok: false,
    code: "PRODUCTION_MIGRATIONS_CONFIRMATION_MISMATCH",
    pendingMigrations: pending,
  });

  const unexpected = await runProductionDeployment(options({
    migrationGateCheck: { ok: true, code: null, pending: [] },
    confirmedMigrations: "USAGE_MONITOR_DB:0030_next.sql",
    ...gated,
  }));
  assert.deepEqual(unexpected, {
    ok: false,
    code: "PRODUCTION_MIGRATIONS_CONFIRMATION_UNEXPECTED",
    pendingMigrations: [],
  });
  assert.deepEqual(calls, []);
});

// Re-pin: replaces "valid production proof routes through local checks". A
// deploy with no unapplied migrations needs no receipt and no intake pause,
// and the live enrollment-open health body is accepted.
test("a no-unapplied-migration deployment routes through local checks and then the exact production Wrangler deploy", async () => {
  const calls = [];
  const healthCalls = [];
  const result = await runProductionDeployment(options({
    releasePreflight: async () => {
      calls.push("preflight");
      return { state: "ready", blockers: [] };
    },
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    fetchImpl: async (url, request) => {
      healthCalls.push({ url: String(url), request });
      return jsonHealthResponse();
    },
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.code, "PRODUCTION_DEPLOYED");
  assert.deepEqual(calls, [
    "preflight",
    "workspace",
    "endpoints",
    "assets",
    [
      "deploy",
      "--env",
      "production",
      "--strict",
      "--var",
      "DEPLOYMENT_SOURCE_COMMIT:c26823c",
    ],
  ]);
  assert.equal(healthCalls.length, 2);
  assert.equal(healthCalls[0].url, HEALTH_URL);
  assert.equal(healthCalls[1].url, HEALTH_URL);
  assert.equal(healthCalls[0].request.method, "GET");
  assert.equal(healthCalls[0].request.credentials, "omit");
  assert.equal(healthCalls[0].request.redirect, "error");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.migrationGate, "no_unapplied_migrations");
  assert.deepEqual(result.pendingMigrations, []);
  assert.equal(result.immediateHealthRecheck, "healthy");
  assert.equal(result.postDeployHealthRecheck, "healthy");
  assert.equal(result.postDeployPublicSurfaceRecheck, "public-only");
});

test("an explicitly confirmed migration deployment prints the exact pending set before Wrangler is spawned", async () => {
  const pending = [
    "USAGE_MONITOR_DB:0030_next.sql",
    "DELETION_LEDGER:0003_next.sql",
  ];
  const events = [];
  const result = await runProductionDeployment(options({
    migrationGateCheck: { ok: true, code: null, pending },
    confirmedMigrations: pending.join(","),
    log: (line) => events.push({ kind: "log", line }),
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: (_command, args) => {
      events.push({ kind: "deploy", args });
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.migrationGate, "unapplied_migrations_explicitly_confirmed");
  assert.deepEqual(result.pendingMigrations, pending);
  const logIndex = events.findIndex((event) => event.kind === "log");
  const deployIndex = events.findIndex((event) => event.kind === "deploy");
  assert.notEqual(logIndex, -1);
  assert.notEqual(deployIndex, -1);
  assert.equal(logIndex < deployIndex, true);
  for (const id of pending) {
    assert.equal(events[logIndex].line.includes(id), true);
  }
});

// Re-pin: "not-contained" became "unhealthy" — a post-deploy body that does
// not report status "ok" is still a failed deploy, but an enrollment-open
// body no longer is.
test("production deployment does not report success when the post-deploy health observation is ambiguous or unhealthy", async () => {
  for (const [name, postDeployFetch, expectedCode] of [
    [
      "unreachable",
      async () => {
        throw new Error("post-deploy network failure");
      },
      "PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_UNREACHABLE",
    ],
    [
      "unhealthy",
      async () => jsonHealthResponse({
        ...liveOpenHealth(),
        status: "degraded",
      }),
      "PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_UNHEALTHY",
    ],
  ]) {
    let fetchCount = 0;
    let spawned = false;
    const result = await runProductionDeployment(options({
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      fetchImpl: async (url, request) => {
        fetchCount += 1;
        assert.equal(String(url), HEALTH_URL, name);
        assert.equal(request.method, "GET", name);
        return fetchCount === 1
          ? jsonHealthResponse()
          : postDeployFetch();
      },
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: "deployed", stderr: "" };
      },
    }));
    assert.equal(spawned, true, name);
    assert.equal(fetchCount, 2, name);
    assert.deepEqual(result, { ok: false, code: expectedCode }, name);
  }
});

test("production deployment treats release preflight as a hard gate", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    releasePreflight: async () => ({
      state: "blocked",
      blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
    }),
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "RELEASE_PREFLIGHT_BLOCKED",
    blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
  });
  assert.deepEqual(calls, []);
});

// Re-pin: the enrollment-open body case was removed from this list — it is
// now a valid pre-deploy observation. The transport, redirect, header, and
// unhealthy-body refusals remain.
test("production deployment does not spawn Wrangler when immediate health recheck fails", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("network");
    },
    async () => jsonHealthResponse({
      ...liveOpenHealth(),
      status: "degraded",
    }),
    async () => ({
      ...jsonHealthResponse(),
      url: "https://redirected.example.test/api/health",
    }),
    async () => ({
      ...jsonHealthResponse(),
      headers: {
        get(name) {
          return name === "cache-control" ? "public" : "nosniff";
        },
      },
    }),
  ]) {
    let spawned = false;
    const result = await runProductionDeployment(options({
      fetchImpl,
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    }));
    assert.equal(spawned, false);
    assert.equal(result.ok, false);
    assert.match(result.code, /^PRODUCTION_HEALTH_RECHECK_/u);
  }
});

test("production deployment stops if the checked-out source revision changes before Wrangler", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    sourceCommitCheck: () => "deadbee",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, false);
});

test("production deployment rejects source revision movement across the Wrangler boundary", async () => {
  let spawned = false;
  let sourceMoved = false;
  const spawnCwds = [];
  const result = await runProductionDeployment(options({
    sourceCommitCheck: () => sourceMoved ? "deadbee" : "c26823c",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: (_command, _args, spawnOptions) => {
      spawned = true;
      sourceMoved = true;
      spawnCwds.push(spawnOptions.cwd);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, true);
  assert.deepEqual(spawnCwds, ["/immutable/repository/apps/worker"]);
});

// Re-pin: renamed from recheckProductionContainment. The transport gate is
// unchanged; the body gate now accepts a live enrollment-open service.
test("production health recheck requires the canonical URL and security headers and accepts an open live service", async () => {
  const calls = [];
  const result = await recheckProductionHealth({
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return jsonHealthResponse();
    },
  });
  assert.deepEqual(result, { ok: true, code: null });
  assert.deepEqual(calls.map((call) => call.url), [HEALTH_URL]);
  assert.equal(calls[0].request.headers.accept, "application/json");

  const unhealthy = await recheckProductionHealth({
    fetchImpl: async () => jsonHealthResponse({ status: "degraded" }),
  });
  assert.deepEqual(unhealthy, {
    ok: false,
    code: "PRODUCTION_HEALTH_RECHECK_UNHEALTHY",
  });
});

async function migrationGateFixture() {
  const workerDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-migration-gate-"),
  );
  await mkdir(join(workerDirectory, "migrations"), { recursive: true });
  await mkdir(join(workerDirectory, "deletion-ledger-migrations"), {
    recursive: true,
  });
  await writeFile(
    join(workerDirectory, "migrations", "0001_first.sql"),
    "CREATE TABLE first (id INTEGER PRIMARY KEY);\n",
  );
  await writeFile(
    join(workerDirectory, "migrations", "0002_second.sql"),
    "CREATE TABLE second (id INTEGER PRIMARY KEY);\n",
  );
  await writeFile(
    join(workerDirectory, "deletion-ledger-migrations", "0001_ledger.sql"),
    "CREATE TABLE ledger (id INTEGER PRIMARY KEY);\n",
  );
  return workerDirectory;
}

function ledgerSpawn(rowsByBinding, spawnedArgs = []) {
  return (command, args, spawnOptions) => {
    assert.equal(command, "/fake/wrangler");
    assert.equal(spawnOptions.stdio[0], "ignore");
    spawnedArgs.push(args);
    return {
      status: 0,
      stdout: JSON.stringify([{ results: rowsByBinding[args[2]] }]),
      stderr: "",
    };
  };
}

test("pending-migration discovery reads only the remote ledger and reports the exact unapplied set", async (t) => {
  const workerDirectory = await migrationGateFixture();
  t.after(() => rm(workerDirectory, { recursive: true, force: true }));

  const spawnedArgs = [];
  const upToDate = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [
        { id: 1, name: "0001_first.sql" },
        { id: 2, name: "0002_second.sql" },
      ],
      DELETION_LEDGER: [{ id: 1, name: "0001_ledger.sql" }],
    }, spawnedArgs),
  });
  assert.deepEqual(upToDate, { ok: true, code: null, pending: [] });
  assert.deepEqual(spawnedArgs, [
    [
      "d1",
      "execute",
      "USAGE_MONITOR_DB",
      "--remote",
      "--env",
      "production",
      "--command",
      PRODUCTION_MIGRATION_LEDGER_SQL,
      "--json",
    ],
    [
      "d1",
      "execute",
      "DELETION_LEDGER",
      "--remote",
      "--env",
      "production",
      "--command",
      PRODUCTION_MIGRATION_LEDGER_SQL,
      "--json",
    ],
  ]);

  const behind = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [{ id: 1, name: "0001_first.sql" }],
      DELETION_LEDGER: [{ id: 1, name: "0001_ledger.sql" }],
    }),
  });
  assert.deepEqual(behind, {
    ok: true,
    code: null,
    pending: ["USAGE_MONITOR_DB:0002_second.sql"],
  });
});

test("reconciled production ledger preserves the historical prefix and refuses alternate applied histories", async () => {
  const expected = EXPECTED_STAGING_MIGRATIONS;
  const ledgerRows = (names) => names.map((name, index) => ({ id: index + 1, name }));
  const historicalPrefix = expected.USAGE_MONITOR_DB.slice(0, 41);
  assert.equal(historicalPrefix.at(-1), "0041_community_model_composition_cache.sql");
  const calls = [];
  const inspect = (primary, spawnedArgs = []) => determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory: checkedInWorkerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: ledgerRows(primary),
      DELETION_LEDGER: ledgerRows(expected.DELETION_LEDGER),
    }, spawnedArgs),
  });
  assert.deepEqual(await inspect(historicalPrefix, calls), {
    ok: true,
    code: null,
    pending: [
      "USAGE_MONITOR_DB:0042_community_model_composition.sql",
      "USAGE_MONITOR_DB:0043_analytical_input_fencing.sql",
      "USAGE_MONITOR_DB:0044_attribution_transport_staging.sql",
      "USAGE_MONITOR_DB:0045_attribution_domain_activation.sql",
      "USAGE_MONITOR_DB:0046_accountless_enrollment_ledger.sql",
    ],
  });
  assert.deepEqual(await inspect(expected.USAGE_MONITOR_DB), { ok: true, code: null, pending: [] });
  for (const applied of [
    [...historicalPrefix.slice(0, 40), "0041_community_model_composition.sql"],
    [...historicalPrefix.slice(0, 40), "0041_community_model_composition.sql",
      "0042_analytical_input_fencing.sql", "0043_attribution_transport_staging.sql",
      "0044_attribution_domain_activation.sql"],
    [...historicalPrefix, "0041_community_model_composition.sql"],
  ]) {
    const result = await inspect(applied);
    const index = applied[40] === historicalPrefix[40] ? 41 : 40;
    assert.deepEqual(result, {
      ok: false,
      code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
      detail: {
        binding: "USAGE_MONITOR_DB",
        appliedCount: applied.length,
        localCount: 46,
        firstMismatch: { index, applied: applied[index], local: expected.USAGE_MONITOR_DB[index] },
      },
    });
  }
  assert.equal(calls.length, 2);
  assert.equal(calls.every((args) => args[0] === "d1" && args[1] === "execute"
    && args.includes(PRODUCTION_MIGRATION_LEDGER_SQL) && !args.includes("apply")), true);
});

test("pending-migration discovery fails closed on unreadable, drifted, or undeterminable state", async (t) => {
  const workerDirectory = await migrationGateFixture();
  t.after(() => rm(workerDirectory, { recursive: true, force: true }));

  const unknownRemote = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [{ id: 1, name: "9999_not_in_checkout.sql" }],
      DELETION_LEDGER: [{ id: 1, name: "0001_ledger.sql" }],
    }),
  });
  assert.deepEqual(unknownRemote, {
    ok: false,
    code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
    detail: {
      binding: "USAGE_MONITOR_DB",
      appliedCount: 1,
      localCount: 2,
      firstMismatch: {
        index: 0,
        applied: "9999_not_in_checkout.sql",
        local: "0001_first.sql",
      },
    },
  });

  const remoteAhead = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [
        { id: 1, name: "0001_first.sql" },
        { id: 2, name: "0002_second.sql" },
        { id: 3, name: "0003_unknown.sql" },
      ],
      DELETION_LEDGER: [{ id: 1, name: "0001_ledger.sql" }],
    }),
  });
  assert.deepEqual(remoteAhead, {
    ok: false,
    code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
    detail: {
      binding: "USAGE_MONITOR_DB",
      appliedCount: 3,
      localCount: 2,
      firstMismatch: {
        index: 2,
        applied: "0003_unknown.sql",
        local: null,
      },
    },
  });

  const queryFailure = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: () => ({ status: 1, stdout: "", stderr: "unauthorized" }),
  });
  assert.deepEqual(queryFailure, {
    ok: false,
    code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    detail: {
      stage: "wrangler-exit",
      binding: "USAGE_MONITOR_DB",
      status: 1,
      stderr: "unauthorized",
    },
  });

  const malformedOutput = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: () => ({ status: 0, stdout: "not-json", stderr: "" }),
  });
  assert.deepEqual(malformedOutput, {
    ok: false,
    code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    detail: {
      stage: "ledger-parse",
      binding: "USAGE_MONITOR_DB",
      stdout: "not-json",
      stderr: "",
    },
  });

  const nonSequentialLedger = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [{ id: 2, name: "0001_first.sql" }],
      DELETION_LEDGER: [{ id: 1, name: "0001_ledger.sql" }],
    }),
  });
  assert.deepEqual(nonSequentialLedger, {
    ok: false,
    code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    detail: {
      stage: "ledger-sequence",
      binding: "USAGE_MONITOR_DB",
      rowCount: 1,
    },
  });

  await rm(join(workerDirectory, "deletion-ledger-migrations"), {
    recursive: true,
    force: true,
  });
  const missingDirectory = await determinePendingProductionMigrations({
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: ledgerSpawn({
      USAGE_MONITOR_DB: [
        { id: 1, name: "0001_first.sql" },
        { id: 2, name: "0002_second.sql" },
      ],
    }),
  });
  assert.deepEqual(missingDirectory, {
    ok: false,
    code: "PRODUCTION_MIGRATION_STATE_UNKNOWN",
    detail: {
      stage: "local-migration-inventory",
      binding: "DELETION_LEDGER",
      migrationsDir: "deletion-ledger-migrations",
    },
  });
});

test("production public-surface recheck requires a public root and real 404s for private assets", async () => {
  const calls = [];
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), request });
      if (String(url) === PUBLIC_ROOT_URL) {
        return textResponse(String(url), publicRootHtml());
      }
      if (String(url) === PUBLIC_ROBOTS_URL) {
        return textResponse(String(url), publicRobots(), {
          contentType: "text/plain; charset=utf-8",
        });
      }
      if (String(url) === PUBLIC_SITEMAP_URL) {
        return textResponse(String(url), publicSitemap(), {
          contentType: "application/xml; charset=utf-8",
        });
      }
      if (String(url) === PUBLIC_WWW_ROOT_URL) {
        return textResponse(String(url), "", {
          location: PUBLIC_ROOT_URL,
          status: 308,
        });
      }
      return textResponse(String(url), "not found", {
        status: 404,
        contentType: "text/plain; charset=utf-8",
      });
    },
  });
  assert.deepEqual(result, { ok: true, code: null });
  assert.equal(calls[0].url, PUBLIC_ROOT_URL);
  assert.equal(calls[0].request.headers.accept, "text/html");
  assert.equal(calls[1].url, PUBLIC_ROBOTS_URL);
  assert.equal(calls[2].url, PUBLIC_SITEMAP_URL);
  assert.equal(calls[3].url, PUBLIC_WWW_ROOT_URL);
  assert.equal(calls[3].request.redirect, "manual");
  assert.equal(calls.length, 13);
  assert.equal(calls.some(({ url }) => url === new URL(
    "/api/v1/admin/community/allowance-preview",
    PUBLIC_ROOT_URL,
  ).href), true);
});

test("production public-surface recheck rejects dashboard markers at the root", async () => {
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url) => textResponse(
      String(url),
      publicRootHtml(
        '<main id="share-panel"><script src="./app.js"></script></main>',
      ),
    ),
  });
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED",
  });
});

test("production public-surface recheck rejects any publicly served private asset", async () => {
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url) => {
      if (String(url) === PUBLIC_ROOT_URL) {
        return textResponse(String(url), publicRootHtml());
      }
      if (String(url) === PUBLIC_ROBOTS_URL) {
        return textResponse(String(url), publicRobots(), {
          contentType: "text/plain; charset=utf-8",
        });
      }
      if (String(url) === PUBLIC_SITEMAP_URL) {
        return textResponse(String(url), publicSitemap(), {
          contentType: "application/xml; charset=utf-8",
        });
      }
      if (String(url) === PUBLIC_WWW_ROOT_URL) {
        return textResponse(String(url), "", {
          location: PUBLIC_ROOT_URL,
          status: 308,
        });
      }
      return textResponse(String(url), "private source", {
        status: 200,
        contentType: "text/javascript; charset=utf-8",
      });
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED",
  });
});
