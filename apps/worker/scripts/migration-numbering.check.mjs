/**
 * Migration numbering guard for every SQL migration directory under
 * apps/worker.
 *
 * D1 migrations are applied by file name and the PostgreSQL runners pin names
 * and digests, so two different files numbered 0012 in one directory would
 * otherwise pass every existing check. Within each directory the NNNN_
 * prefixes must be unique (MIGRATION_NUMBER_DUPLICATE) and form one
 * contiguous run (MIGRATION_NUMBER_GAP) starting at 0001, except
 * legacy-migrations, which starts at 0046. A staged PostgreSQL directory
 * (postgres/staged-migrations/<role>) continues postgres/migrations/<role>:
 * its run may start anywhere, but none of its numbers may already be promoted.
 *
 * Covered directories: migrations, every top-level *-migrations,
 * postgres/migrations/<role> and postgres/staged-migrations/<role>. Any other
 * directory holding .sql files fails MIGRATION_DIRECTORY_UNCOVERED, except
 * postgres/proposals, which holds unreferenced drafts (for example
 * 0007_named_gcp_test_erasure_transfer.sql; ledger 0007 is assigned to PT-1).
 *
 * Run: node --test ./scripts/migration-numbering.check.mjs
 */

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_FILE_PATTERN = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/u;
const RUN_START_EXCEPTIONS = Object.freeze({ "legacy-migrations": 46 });
const EXCLUDED_SQL_DIRECTORIES = Object.freeze(["postgres/proposals"]);
const SKIPPED_WALK_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function toPosix(path) {
  return path.split(sep).join("/");
}

async function subdirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** The directories whose numbering this guard owns, relative to apps/worker. */
export async function migrationDirectories(workerRoot) {
  const directories = [];
  for (const name of await subdirectories(workerRoot)) {
    if (name === "migrations" || name.endsWith("-migrations")) directories.push(name);
  }
  for (const role of await subdirectories(join(workerRoot, "postgres", "migrations"))) {
    directories.push(`postgres/migrations/${role}`);
  }
  for (const role of await subdirectories(join(workerRoot, "postgres", "staged-migrations"))) {
    directories.push(`postgres/staged-migrations/${role}`);
  }
  return Object.freeze(directories);
}

async function sqlDirectories(workerRoot) {
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".sql"))) {
      found.push(toPosix(relative(workerRoot, directory)));
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIPPED_WALK_DIRECTORIES.has(entry.name) || entry.name.startsWith(".wrangler")) continue;
      await visit(join(directory, entry.name));
    }
  }
  await visit(workerRoot);
  return found.sort();
}

async function sqlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name).sort();
}

function numbered(files) {
  const byNumber = new Map();
  const invalid = [];
  for (const file of files) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (match === null) {
      invalid.push(file);
      continue;
    }
    const number = Number(match[1]);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  return { byNumber, invalid };
}

const pad = (number) => String(number).padStart(4, "0");

export async function inspectMigrationNumbering(workerRoot = WORKER_ROOT) {
  const failures = [];
  const directories = await migrationDirectories(workerRoot);
  const covered = new Set([...directories, ...EXCLUDED_SQL_DIRECTORIES]);
  for (const directory of await sqlDirectories(workerRoot)) {
    if (!covered.has(directory)) {
      failures.push({ code: "MIGRATION_DIRECTORY_UNCOVERED", directory });
    }
  }
  const promotedNumbers = new Map();
  const summaries = [];
  for (const directory of directories) {
    const staged = directory.startsWith("postgres/staged-migrations/");
    const { byNumber, invalid } = numbered(await sqlFiles(join(workerRoot, directory)));
    for (const file of invalid) {
      failures.push({ code: "MIGRATION_NAME_INVALID", directory, file });
    }
    for (const [number, files] of byNumber) {
      if (files.length > 1) {
        failures.push({ code: "MIGRATION_NUMBER_DUPLICATE", directory, number: pad(number), files });
      }
    }
    const numbers = [...byNumber.keys()].sort((left, right) => left - right);
    if (!staged) promotedNumbers.set(directory, new Set(numbers));
    if (numbers.length === 0) {
      summaries.push({ directory, count: 0 });
      continue;
    }
    const expectedStart = staged ? numbers[0] : (RUN_START_EXCEPTIONS[directory] ?? 1);
    if (numbers[0] !== expectedStart) {
      failures.push({ code: "MIGRATION_NUMBER_GAP", directory, expected: pad(expectedStart), found: pad(numbers[0]) });
    }
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] !== numbers[index - 1] + 1) {
        failures.push({
          code: "MIGRATION_NUMBER_GAP",
          directory,
          expected: pad(numbers[index - 1] + 1),
          found: pad(numbers[index]),
        });
      }
    }
    summaries.push({ directory, count: numbers.length, first: pad(numbers[0]), last: pad(numbers.at(-1)) });
  }
  for (const directory of directories.filter((path) => path.startsWith("postgres/staged-migrations/"))) {
    const role = directory.slice("postgres/staged-migrations/".length);
    const promoted = promotedNumbers.get(`postgres/migrations/${role}`) ?? new Set();
    const { byNumber } = numbered(await sqlFiles(join(workerRoot, directory)));
    for (const [number, files] of byNumber) {
      if (promoted.has(number)) {
        failures.push({
          code: "MIGRATION_NUMBER_DUPLICATE",
          directory,
          number: pad(number),
          files,
          promoted: `postgres/migrations/${role}`,
        });
      }
    }
    if (!promotedNumbers.has(`postgres/migrations/${role}`) && byNumber.size > 0
        && Math.min(...byNumber.keys()) !== 1) {
      failures.push({ code: "MIGRATION_NUMBER_GAP", directory, expected: "0001", found: pad(Math.min(...byNumber.keys())) });
    }
  }
  return Object.freeze({ directories: Object.freeze(summaries), failures: Object.freeze(failures) });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function withWorkerCopy(directories, callback) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-migration-numbering-"));
  try {
    for (const directory of directories) {
      await cp(join(WORKER_ROOT, directory), join(root, directory), { recursive: true });
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const codes = (result) => result.failures.map(({ code }) => code);

test("every migration directory in this checkout is uniquely and contiguously numbered", async () => {
  const result = await inspectMigrationNumbering(WORKER_ROOT);
  assert.deepEqual(result.failures, []);
  const covered = result.directories.map(({ directory }) => directory);
  for (const directory of [
    "migrations",
    "analytics-migrations",
    "deletion-ledger-migrations",
    "ingestion-isolation-migrations",
    "legacy-migrations",
    "postgres/migrations/ledger",
    "postgres/migrations/primary",
  ]) {
    assert.ok(covered.includes(directory), `${directory} is covered`);
  }
  assert.ok(!covered.includes("postgres/proposals"));
  assert.equal(result.directories.find(({ directory }) => directory === "legacy-migrations").first, "0046");
});

test("two files numbered 0012 in a copy of ingestion-isolation-migrations fail MIGRATION_NUMBER_DUPLICATE", async () => {
  await withWorkerCopy(["ingestion-isolation-migrations"], async (root) => {
    assert.deepEqual((await inspectMigrationNumbering(root)).failures, []);
    await writeFile(
      join(root, "ingestion-isolation-migrations", "0012_v12_quarantine_admission.sql"),
      "-- synthetic duplicate number\n",
    );
    const result = await inspectMigrationNumbering(root);
    assert.deepEqual(codes(result), ["MIGRATION_NUMBER_DUPLICATE"]);
    assert.equal(result.failures[0].directory, "ingestion-isolation-migrations");
    assert.equal(result.failures[0].number, "0012");
    assert.equal(result.failures[0].files.length, 2);
  });
});

test("a missing number or a late run start fails MIGRATION_NUMBER_GAP", async () => {
  await withWorkerCopy(["ingestion-isolation-migrations", "legacy-migrations"], async (root) => {
    const isolation = join(root, "ingestion-isolation-migrations");
    const [victim] = (await readdir(isolation)).filter((name) => name.startsWith("0005_"));
    await rm(join(isolation, victim));
    let result = await inspectMigrationNumbering(root);
    assert.deepEqual(codes(result), ["MIGRATION_NUMBER_GAP"]);
    assert.deepEqual([result.failures[0].expected, result.failures[0].found], ["0005", "0006"]);

    await withWorkerCopy(["routing-migrations"], async (other) => {
      await writeFile(join(other, "routing-migrations", "0003_skipped_ahead.sql"), "-- synthetic\n");
      result = await inspectMigrationNumbering(other);
      assert.deepEqual(codes(result), ["MIGRATION_NUMBER_GAP"]);
    });
  });
  await withWorkerCopy(["legacy-migrations"], async (root) => {
    assert.deepEqual((await inspectMigrationNumbering(root)).failures, [],
      "legacy-migrations may start its run at 0046");
    await writeFile(join(root, "legacy-migrations", "0050_after_a_gap.sql"), "-- synthetic\n");
    assert.deepEqual(codes(await inspectMigrationNumbering(root)), ["MIGRATION_NUMBER_GAP"]);
  });
});

test("staged migrations continue the promoted role without reusing its numbers", async () => {
  await withWorkerCopy(["postgres/migrations/primary", "postgres/migrations/ledger"], async (root) => {
    const staged = join(root, "postgres", "staged-migrations", "primary");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "0047_synthetic_staged.sql"), "-- synthetic\n");
    await writeFile(join(staged, "0048_synthetic_staged.sql"), "-- synthetic\n");
    assert.deepEqual((await inspectMigrationNumbering(root)).failures, [],
      "a staged run may start after numbers promoted in other worktrees");

    await writeFile(join(staged, "0050_synthetic_staged.sql"), "-- synthetic\n");
    assert.deepEqual(codes(await inspectMigrationNumbering(root)), ["MIGRATION_NUMBER_GAP"]);
    await rm(join(staged, "0050_synthetic_staged.sql"));

    await writeFile(join(staged, "0045_synthetic_reuse.sql"), "-- synthetic\n");
    const result = await inspectMigrationNumbering(root);
    assert.ok(codes(result).includes("MIGRATION_NUMBER_DUPLICATE"));
    assert.equal(result.failures.find(({ code }) => code === "MIGRATION_NUMBER_DUPLICATE").promoted,
      "postgres/migrations/primary");
  });
});

test("unreferenced proposals are excluded, but any other SQL directory must be covered", async () => {
  await withWorkerCopy(["postgres/migrations/ledger", "postgres/proposals"], async (root) => {
    assert.deepEqual((await inspectMigrationNumbering(root)).failures, [],
      "proposal 0007 does not collide with the ledger role");
    await mkdir(join(root, "postgres", "drafts"), { recursive: true });
    await writeFile(join(root, "postgres", "drafts", "0001_unowned.sql"), "-- synthetic\n");
    assert.deepEqual(codes(await inspectMigrationNumbering(root)), ["MIGRATION_DIRECTORY_UNCOVERED"]);
  });
});

test("a SQL file without an NNNN_ prefix fails MIGRATION_NAME_INVALID", async () => {
  await withWorkerCopy(["deletion-ledger-migrations"], async (root) => {
    await writeFile(join(root, "deletion-ledger-migrations", "hotfix.sql"), "-- synthetic\n");
    assert.deepEqual(codes(await inspectMigrationNumbering(root)), ["MIGRATION_NAME_INVALID"]);
  });
});
