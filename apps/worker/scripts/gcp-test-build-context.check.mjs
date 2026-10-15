/** Pure regression for the exact primary migration admission set. */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const WORKER = resolve(import.meta.dirname, "..");
const BUILDER = join(WORKER, "scripts/gcp-test-build-context.mjs");
const MIGRATION_FACADE = join(WORKER, "scripts/postgres-migrations.mjs");
const MIGRATION_IMPLEMENTATION = join(WORKER, "cloud-run/postgres-migrations.mjs");
const EXPECTED_TAIL = "0078_classification_link_lookup_indexes.sql";
const STATIC_ALLOWLIST_FILES = [
  "gcp-test/package.json",
  "gcp-test/package-lock.json",
  "gcp-test/Dockerfile",
  "gcp-test/cloudbuild.yaml",
  "scripts/gcp-test-database.mjs",
  "scripts/postgres-migrations.mjs",
  "cloud-run/postgres-migrations.mjs",
  "cloud-run/postgres-runtime-grants.mjs",
  "cloud-run/postgres-community-graph-benchmark.mjs",
  "cloud-run/postgres-community-graph-benchmark.check.mjs",
];

function runCheck(workerRoot) {
  return spawnSync(process.execPath, [join(workerRoot, "scripts/gcp-test-build-context.mjs"), "--check"], {
    cwd: workerRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: workerRoot,
      TMPDIR: workerRoot,
      LANG: "C",
      LC_ALL: "C",
    },
  });
}

async function createFixture(workerRoot) {
  for (const path of STATIC_ALLOWLIST_FILES) {
    const target = join(workerRoot, path);
    await mkdir(dirname(target), { recursive: true });
    if (path === "scripts/postgres-migrations.mjs") {
      await copyFile(MIGRATION_FACADE, target);
    } else if (path === "cloud-run/postgres-migrations.mjs") {
      await copyFile(MIGRATION_IMPLEMENTATION, target);
    } else {
      await writeFile(target, "synthetic allowlisted file\n", { flag: "wx" });
    }
  }

  const primary = join(workerRoot, "postgres/migrations/primary");
  await mkdir(primary, { recursive: true });
  for (let version = 1; version <= 78; version += 1) {
    const name = version === 78
      ? EXPECTED_TAIL
      : `${String(version).padStart(4, "0")}_synthetic_migration.sql`;
    await writeFile(join(primary, name), `SELECT ${version};\n`, { flag: "wx" });
  }
  return primary;
}

function assertRefused(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "error",
    code: "GCP_TEST_CONTEXT_MIGRATION_SET_UNEXPECTED",
  });
}

test("GCP test context accepts only the pinned 0001-0078 primary migration set", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-gcp-context-admission-"));
  const workerRoot = join(root, "apps/worker");
  try {
    await mkdir(join(workerRoot, "scripts"), { recursive: true });
    await copyFile(BUILDER, join(workerRoot, "scripts/gcp-test-build-context.mjs"));
    const primary = await createFixture(workerRoot);

    const accepted = runCheck(workerRoot);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stderr, "");
    const receipt = JSON.parse(accepted.stdout);
    assert.equal(receipt.status, "ok");
    assert.equal(receipt.mode, "check");
    assert.equal(receipt.fileCount, 88);
    assert.equal(receipt.primaryMigrations, 78);
    assert.match(receipt.sourceContentDigest, /^[0-9a-f]{64}$/u);

    const unexpectedTail = join(primary, "0079_unreviewed.sql");
    await writeFile(unexpectedTail, "SELECT 79;\n", { flag: "wx" });
    assertRefused(runCheck(workerRoot));
    await rm(unexpectedTail);

    const expectedTail = join(primary, EXPECTED_TAIL);
    await rename(expectedTail, join(primary, "0078_unreviewed.sql"));
    assertRefused(runCheck(workerRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
