/** Actual local build-context regression; no Docker, service, database or network. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, cp, readFile, access, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKER = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const invoke = (args, cwd) => spawnSync(NODE, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });

test("generated context carries profiler runtime closure, excludes its fixtures and builds all actual entries", { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-profiler-context-check-")));
  const output = join(root, "context"), cloud = join(output, "apps/worker/cloud-run");
  try {
    const generated = invoke([join(WORKER, "scripts/cloud-run-build-context.mjs"), `--output=${output}`], WORKER);
    assert.equal(generated.status, 0, generated.stderr);
    const receipt = JSON.parse(generated.stdout);
    assert.equal(receipt.mode, "create");
    assert.equal(receipt.primaryMigrations, 75);
    const runtime = ["analytics-refresh-profile.mjs", "analytics-refresh-worker-profile.mjs", "analytics-refresh-allocation-profile.mjs", "analytics-refresh-memory-profile.mjs"];
    for (const name of runtime) assert.deepEqual(await readFile(join(cloud, name)), await readFile(join(WORKER, "cloud-run", name)), name);
    const fixtures = ["analytics-refresh-profile.check.mjs", "analytics-refresh-worker-profile.check.mjs", "analytics-refresh-allocation-profile.check.mjs",
      "analytics-refresh-allocation-conformance.mjs", "analytics-refresh-memory-profile.check.mjs", "analytics-refresh-allocation-integration.check.mjs"];
    for (const name of fixtures) await assert.rejects(access(join(cloud, name)), { code: "ENOENT" });
    const { readWorkerProfileSettings } = await import(pathToFileURL(join(cloud, "analytics-refresh-worker-profile.mjs")));
    for (const mode of [null, "ALLOCATION", "MEMORY"]) {
      const env = { ANALYTICS_V2_LOCAL_WORKER_PROFILE_DIR: join(root, "never-created"), ANALYTICS_V2_LOCAL_WORKER_PROFILE_SOURCE: "a".repeat(40),
        ...(mode === null ? {} : { [`ANALYTICS_V2_LOCAL_WORKER_PROFILE_${mode}`]: "1" }) };
      for (const target of ["production", "staging"]) assert.throws(() => readWorkerProfileSettings(env, { target }), { code: "WORKER_PROFILE_FORBIDDEN" });
      assert.throws(() => readWorkerProfileSettings({ ...env, CLOUD_RUN_JOB: "synthetic-job" }), { code: "WORKER_PROFILE_FORBIDDEN" });
    }
    // Dependencies are existing local installed copies, never downloaded or added to the audited source inventory.
    await cp(join(WORKER, "cloud-run/node_modules"), join(cloud, "node_modules"), { recursive: true, verbatimSymlinks: true });
    // Match Dockerfile build-stage resolution from /app/node_modules.
    await symlink(join(cloud, "node_modules"), join(output, "node_modules"), "dir");
    const built = invoke(["build.mjs"], cloud);
    assert.equal(built.status, 0, built.stderr);
    const entries = ["server", "oauth-gateway", "test-migrations", "test-activation", "postgres-community-graph-benchmark",
      "postgres-community-graph-readback-diagnostic", "analytics-refresh", "analytics-refresh-worker", "production-migrations",
      "postgres-maintenance-job", "ops-runtime-probe-job", "ops-backup-audit-job"];
    for (const name of entries) assert.ok((await readFile(join(cloud, "dist", `${name}.mjs`))).length > 0, name);
    const help = invoke(["dist/analytics-refresh.mjs", "--help"], cloud);
    assert.equal(help.status, 0, help.stderr);
    // The Docker CLI's --check-source intentionally uses /app. Exercise its
    // exported reader against the actual copied migrations through the existing adapter.
    const benchmark = await import(pathToFileURL(join(cloud, "dist/postgres-community-graph-benchmark.mjs")));
    const { readPostgresMigrations } = await import(pathToFileURL(join(output, "apps/worker/scripts/postgres-migrations.mjs")));
    const migrations = await benchmark.readPostgresCommunityGraphBenchmarkMigrations({
      readMigrations: ({ role }) => readPostgresMigrations({ role, rootDirectory: join(output, "apps/worker/postgres/migrations") }),
    });
    assert.equal(migrations.length, 75);
    assert.equal(migrations.at(-1).name, "0075_github_distribution_manifest_visibility.sql");
    console.log(JSON.stringify({ contextFiles: receipt.fileCount, sourceContentDigest: receipt.sourceContentDigest,
      runtimeProfilerFiles: runtime.length, excludedProfilerFixtures: fixtures.length, builtEntries: entries.length,
      diagnosticCloudRefusal: true, actualContextBuild: true }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
