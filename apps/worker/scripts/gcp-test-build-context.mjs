#!/usr/bin/env node

/**
 * Create the only source context accepted by the GCP database qualification
 * build. The allowlist is deliberately small: no checkout-wide Docker build,
 * credentials, fixtures, receipts, node_modules, or generated deployment
 * assets can enter the Cloud Build upload.
 */

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readPostgresMigrations } from "./postgres-migrations.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const DEFAULT_OUTPUT = "/private/tmp/tibotattle-gcp-test-database-context";
const SECRET_PATH_PARTS = new Set([
  ".dev.vars",
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
]);
const EXPECTED_PRIMARY_MIGRATION_COUNT = 46;
const EXPECTED_LEDGER_MIGRATION_COUNT = 6;
const EXPECTED_PRIMARY_MIGRATION_TAIL = "0046_owner_journal_authority.sql";

const ALLOWLIST = Object.freeze([
  Object.freeze({ source: "gcp-test/package.json", destination: "apps/worker/gcp-test/package.json" }),
  Object.freeze({ source: "gcp-test/package-lock.json", destination: "apps/worker/gcp-test/package-lock.json" }),
  Object.freeze({ source: "gcp-test/Dockerfile", destination: "apps/worker/gcp-test/Dockerfile" }),
  Object.freeze({ source: "gcp-test/cloudbuild.yaml", destination: "apps/worker/gcp-test/cloudbuild.yaml" }),
  Object.freeze({ source: "scripts/gcp-test-database.mjs", destination: "apps/worker/scripts/gcp-test-database.mjs" }),
  Object.freeze({ source: "scripts/postgres-migrations.mjs", destination: "apps/worker/scripts/postgres-migrations.mjs" }),
  Object.freeze({ source: "postgres/migrations", destination: "apps/worker/postgres/migrations" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-benchmark.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-benchmark.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-benchmark.check.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-benchmark.check.mjs" }),
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const output = outputArg === undefined
    ? DEFAULT_OUTPUT
    : outputArg.slice("--output=".length);
  if (!output || output.startsWith("--") || args.some((arg) =>
    !arg.startsWith("--check") && !arg.startsWith("--output="))) {
    fail("GCP_TEST_CONTEXT_ARGUMENT_INVALID");
  }
  return { check, output: resolve(output) };
}

function assertSafeRelativePath(relativePath) {
  if (relativePath.startsWith("../") || relativePath.includes(`${sep}..${sep}`)
      || relativePath.startsWith("/")) {
    fail("GCP_TEST_CONTEXT_PATH_INVALID");
  }
  const parts = relativePath.split(/[\\/]+/u);
  if (parts.some((part) => SECRET_PATH_PARTS.has(part)
      || part.endsWith(".key") || part.endsWith(".pem"))) {
    fail("GCP_TEST_CONTEXT_SECRET_PATH");
  }
}

async function assertRegularFile(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("GCP_TEST_CONTEXT_SOURCE_UNSAFE");
  }
  if (stat.size > 8 * 1024 * 1024) fail("GCP_TEST_CONTEXT_FILE_TOO_LARGE");
}

async function collectFiles(sourcePath, relativeBase = "") {
  const stat = await lstat(sourcePath).catch(() => null);
  if (stat === null || stat.isSymbolicLink()) fail("GCP_TEST_CONTEXT_SOURCE_UNSAFE");
  if (stat.isFile()) {
    await assertRegularFile(sourcePath);
    return [relativeBase];
  }
  if (!stat.isDirectory()) fail("GCP_TEST_CONTEXT_SOURCE_UNSAFE");
  const names = (await readdir(sourcePath)).sort();
  const paths = [];
  for (const name of names) {
    if (name === "node_modules" || name === ".git" || name === ".wrangler") continue;
    const child = join(sourcePath, name);
    const childRelative = relativeBase === "" ? name : join(relativeBase, name);
    paths.push(...await collectFiles(child, childRelative));
  }
  return paths;
}

async function sourceFiles() {
  const files = [];
  for (const entry of ALLOWLIST) {
    const source = join(WORKER_ROOT, entry.source);
    const relativeSourceFiles = await collectFiles(source, entry.source);
    for (const relativeSource of relativeSourceFiles) {
      assertSafeRelativePath(relativeSource);
      files.push({
        source: join(WORKER_ROOT, relativeSource),
        destination: join(entry.destination, relative(entry.source, relativeSource)),
      });
    }
  }
  files.sort((left, right) => left.destination.localeCompare(right.destination));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].destination === files[index].destination) {
      fail("GCP_TEST_CONTEXT_DESTINATION_DUPLICATE");
    }
  }
  return files;
}

async function digestFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.source);
    hash.update(file.destination);
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function validateSource() {
  const files = await sourceFiles();
  const primary = await readPostgresMigrations({
    role: "primary",
    rootDirectory: join(WORKER_ROOT, "postgres", "migrations"),
  });
  const ledger = await readPostgresMigrations({
    role: "ledger",
    rootDirectory: join(WORKER_ROOT, "postgres", "migrations"),
  });
  if (primary.length === 0 || ledger.length === 0) fail("GCP_TEST_CONTEXT_MIGRATIONS_EMPTY");
  if (primary.length !== EXPECTED_PRIMARY_MIGRATION_COUNT
      || ledger.length !== EXPECTED_LEDGER_MIGRATION_COUNT
      || primary.at(-1)?.name !== EXPECTED_PRIMARY_MIGRATION_TAIL) {
    fail("GCP_TEST_CONTEXT_MIGRATION_SET_UNEXPECTED");
  }
  const primaryPaths = files.filter((file) =>
    file.destination.startsWith("apps/worker/postgres/migrations/primary/"),
  );
  const ledgerPaths = files.filter((file) =>
    file.destination.startsWith("apps/worker/postgres/migrations/ledger/"),
  );
  if (primaryPaths.length !== primary.length || ledgerPaths.length !== ledger.length) {
    fail("GCP_TEST_CONTEXT_MIGRATION_PATH_SET_UNEXPECTED");
  }
  const digest = await digestFiles(files);
  return Object.freeze({ files, digest, primary, ledger });
}

async function digestCopiedFiles(target, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const destination = join(target, file.destination);
    const bytes = await readFile(destination);
    hash.update(file.destination);
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function collectOutputFiles(target, relativeBase = "") {
  const directory = join(target, relativeBase);
  const names = (await readdir(directory)).sort();
  const paths = [];
  for (const name of names) {
    const relativePath = relativeBase === "" ? name : join(relativeBase, name);
    if (relativePath === "apps/worker/gcp-test/source-content-digest.txt") continue;
    const path = join(target, relativePath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("GCP_TEST_CONTEXT_OUTPUT_UNSAFE");
    if (stat.isDirectory()) paths.push(...await collectOutputFiles(target, relativePath));
    else if (stat.isFile()) paths.push(relativePath);
    else fail("GCP_TEST_CONTEXT_OUTPUT_UNSAFE");
  }
  return paths;
}

async function createContext(output, files, digest) {
  const target = resolve(output);
  if (target === REPOSITORY_ROOT || target.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
    fail("GCP_TEST_CONTEXT_OUTPUT_IN_REPOSITORY");
  }
  const existing = await lstat(target).catch(() => null);
  if (existing !== null) fail("GCP_TEST_CONTEXT_OUTPUT_EXISTS");
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = join(target, file.destination);
    await mkdir(dirname(destination), { recursive: true });
    await cp(file.source, destination, { errorOnExist: true, force: false });
  }
  const copiedDigest = await digestCopiedFiles(target, files);
  if (copiedDigest !== digest) {
    await rm(target, { recursive: true, force: true });
    fail("GCP_TEST_CONTEXT_SOURCE_CHANGED");
  }
  const expectedPaths = files.map((file) => file.destination).sort();
  const actualPaths = (await collectOutputFiles(target)).sort();
  if (expectedPaths.length !== actualPaths.length
      || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    await rm(target, { recursive: true, force: true });
    fail("GCP_TEST_CONTEXT_OUTPUT_SET_UNEXPECTED");
  }
  const digestPath = join(target, "apps/worker/gcp-test/source-content-digest.txt");
  await writeFile(digestPath, `${digest}\n`, { encoding: "utf8", flag: "wx" });
  return target;
}

const { check, output } = parseArgs();
try {
  const source = await validateSource();
  if (check) {
    console.log(JSON.stringify({
      status: "ok",
      mode: "check",
      fileCount: source.files.length,
      primaryMigrations: source.primary.length,
      ledgerMigrations: source.ledger.length,
      sourceContentDigest: source.digest,
    }, null, 2));
  } else {
    const target = await createContext(output, source.files, source.digest);
    console.log(JSON.stringify({
      status: "ok",
      mode: "create",
      output: target,
      fileCount: source.files.length,
      primaryMigrations: source.primary.length,
      ledgerMigrations: source.ledger.length,
      sourceContentDigest: source.digest,
    }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    code: typeof error?.code === "string" ? error.code : "GCP_TEST_CONTEXT_FAILED",
  }));
  process.exitCode = 1;
}
