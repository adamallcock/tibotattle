#!/usr/bin/env node

/**
 * Build the audited Cloud Run host context. The host is a Node composition
 * root around the existing Worker handlers; it must never be built from the
 * dirty repository root. Only the host, Worker source, the vendored d43c8f92
 * analytics kernels and the analytics-refresh Job, the MP-2-lite maintenance
 * Job and the production configuration it reads, canonical migrations,
 * migration runner, the shared runtime-grant policy and the production
 * migration Job, the private daily publication Job and verifier, their
 * shared receipt contract, test-only activation and independent restore
 * commands, the read-only ledger diagnostic, the guarded test-only ledger
 * reconciler, and the reviewed workspace packages enter this context.
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
const DEFAULT_OUTPUT = "/private/tmp/tibotattle-cloud-run-host-context";
const SECRET_PATH_PARTS = new Set([
  ".dev.vars",
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
]);
const EXPECTED_PRIMARY_MIGRATION_COUNT = 63;
const EXPECTED_LEDGER_MIGRATION_COUNT = 7;
const EXPECTED_PRIMARY_MIGRATION_TAIL = "0063_enrollment_grants_erased_redeemer.sql";
const REQUIRED_LEDGER_DIAGNOSTIC_PATHS = new Set([
  "apps/worker/cloud-run/ledger-reconciliation-diagnostic.mjs",
  "apps/worker/cloud-run/ledger-reconciliation-diagnostic.check.mjs",
  "apps/worker/cloud-run/ledger-preflight-reconcile.mjs",
  "apps/worker/cloud-run/ledger-preflight-reconcile.check.mjs",
]);
const REQUIRED_DAILY_ACTIVATION_PATHS = new Set([
  "apps/worker/cloud-run/postgres-community-daily-activation.mjs",
  "apps/worker/cloud-run/postgres-community-daily-activation.check.mjs",
  "apps/worker/cloud-run/postgres-community-daily-prepare-test.mjs",
  "apps/worker/cloud-run/postgres-community-daily-restore-test.mjs",
]);
const REQUIRED_DAILY_CONTRACT_PATHS = new Set([
  "apps/worker/cloud-run/postgres-community-daily-contract.mjs",
]);
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  // Shared packages are copied for runtime imports only. Their unit tests and
  // fixtures are intentionally outside the audited Cloud Run image context.
  "test",
  "tests",
  "fixture",
  "fixtures",
]);

const BASE_ALLOWLIST = Object.freeze([
  Object.freeze({ source: "cloud-run/package.json", destination: "apps/worker/cloud-run/package.json" }),
  Object.freeze({ source: "cloud-run/package-lock.json", destination: "apps/worker/cloud-run/package-lock.json" }),
  Object.freeze({ source: "cloud-run/Dockerfile", destination: "apps/worker/cloud-run/Dockerfile" }),
  Object.freeze({ source: "cloud-run/cloudbuild.yaml", destination: "apps/worker/cloud-run/cloudbuild.yaml" }),
  Object.freeze({ source: "cloud-run/server.mjs", destination: "apps/worker/cloud-run/server.mjs" }),
  Object.freeze({ source: "cloud-run/oauth-gateway.mjs", destination: "apps/worker/cloud-run/oauth-gateway.mjs" }),
  Object.freeze({ source: "cloud-run/oauth-gateway.check.mjs", destination: "apps/worker/cloud-run/oauth-gateway.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-maintenance-gate.mjs", destination: "apps/worker/cloud-run/postgres-maintenance-gate.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-test-dispatch.mjs", destination: "apps/worker/cloud-run/postgres-test-dispatch.mjs" }),
  Object.freeze({ source: "cloud-run/origin-route-modules.mjs", destination: "apps/worker/cloud-run/origin-route-modules.mjs" }),
  Object.freeze({ source: "cloud-run/origin-fastpath-mode.mjs", destination: "apps/worker/cloud-run/origin-fastpath-mode.mjs" }),
  Object.freeze({ source: "cloud-run/contribution-envelope-registry.mjs", destination: "apps/worker/cloud-run/contribution-envelope-registry.mjs" }),
  // The legacy intake the origin composes (IN-2 v1.1, IN-3 v1.0/v0.1).
  Object.freeze({ source: "cloud-run/origin-intake-composition.mjs", destination: "apps/worker/cloud-run/origin-intake-composition.mjs" }),
  Object.freeze({ source: "cloud-run/upload-authorization-formats.mjs", destination: "apps/worker/cloud-run/upload-authorization-formats.mjs" }),
  Object.freeze({ source: "cloud-run/envelopes", destination: "apps/worker/cloud-run/envelopes" }),
  Object.freeze({ source: "cloud-run/routes", destination: "apps/worker/cloud-run/routes" }),
  // The edge-test origin (EORIGIN) and the EP-6 boundary and replay limiters
  // it composes in front of fastpath-test.
  Object.freeze({ source: "cloud-run/origin-edge-test-mode.mjs", destination: "apps/worker/cloud-run/origin-edge-test-mode.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-edge-origin-dispatch.mjs", destination: "apps/worker/cloud-run/postgres-edge-origin-dispatch.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-edge-admission-limiters.mjs", destination: "apps/worker/cloud-run/postgres-edge-admission-limiters.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-migrations.mjs", destination: "apps/worker/cloud-run/postgres-migrations.mjs" }),
  Object.freeze({ source: "cloud-run/cloud-sql.mjs", destination: "apps/worker/cloud-run/cloud-sql.mjs" }),
  Object.freeze({ source: "cloud-run/assets.mjs", destination: "apps/worker/cloud-run/assets.mjs" }),
  Object.freeze({ source: "cloud-run/build.mjs", destination: "apps/worker/cloud-run/build.mjs" }),
  Object.freeze({ source: "cloud-run/host.check.mjs", destination: "apps/worker/cloud-run/host.check.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-smoke.mjs", destination: "apps/worker/cloud-run/synthetic-v12-smoke.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-smoke.check.mjs", destination: "apps/worker/cloud-run/synthetic-v12-smoke.check.mjs" }),
  Object.freeze({ source: "cloud-run/test-migrations.mjs", destination: "apps/worker/cloud-run/test-migrations.mjs" }),
  Object.freeze({ source: "cloud-run/test-migrations.check.mjs", destination: "apps/worker/cloud-run/test-migrations.check.mjs" }),
  // The one runtime-grant policy the test and production migrators share, and
  // the OPS-10 production migration job (primary role only).
  Object.freeze({ source: "cloud-run/postgres-runtime-grants.mjs", destination: "apps/worker/cloud-run/postgres-runtime-grants.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-runtime-grants.check.mjs", destination: "apps/worker/cloud-run/postgres-runtime-grants.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-production-migrations.mjs", destination: "apps/worker/cloud-run/postgres-production-migrations.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-production-migrations.check.mjs", destination: "apps/worker/cloud-run/postgres-production-migrations.check.mjs" }),
  Object.freeze({ source: "cloud-run/test-activation.mjs", destination: "apps/worker/cloud-run/test-activation.mjs" }),
  Object.freeze({ source: "cloud-run/test-activation.check.mjs", destination: "apps/worker/cloud-run/test-activation.check.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-cleanup.mjs", destination: "apps/worker/cloud-run/synthetic-v12-cleanup.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-cleanup.check.mjs", destination: "apps/worker/cloud-run/synthetic-v12-cleanup.check.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-discovery.mjs", destination: "apps/worker/cloud-run/synthetic-v12-discovery.mjs" }),
  Object.freeze({ source: "cloud-run/synthetic-v12-discovery.check.mjs", destination: "apps/worker/cloud-run/synthetic-v12-discovery.check.mjs" }),
  Object.freeze({ source: "cloud-run/ledger-reconciliation-diagnostic.mjs", destination: "apps/worker/cloud-run/ledger-reconciliation-diagnostic.mjs" }),
  Object.freeze({ source: "cloud-run/ledger-reconciliation-diagnostic.check.mjs", destination: "apps/worker/cloud-run/ledger-reconciliation-diagnostic.check.mjs" }),
  Object.freeze({ source: "cloud-run/ledger-preflight-reconcile.mjs", destination: "apps/worker/cloud-run/ledger-preflight-reconcile.mjs" }),
  Object.freeze({ source: "cloud-run/ledger-preflight-reconcile.check.mjs", destination: "apps/worker/cloud-run/ledger-preflight-reconcile.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-benchmark.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-benchmark.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-benchmark.check.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-benchmark.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-readback-diagnostic.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-readback-diagnostic.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-graph-readback-diagnostic.check.mjs", destination: "apps/worker/cloud-run/postgres-community-graph-readback-diagnostic.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-publish-test.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-publish-test.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-publish-test.check.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-publish-test.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-contract.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-contract.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-live-smoke.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-live-smoke.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-live-smoke.check.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-live-smoke.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-activation.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-activation.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-activation.check.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-activation.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-prepare-test.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-prepare-test.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-community-daily-restore-test.mjs", destination: "apps/worker/cloud-run/postgres-community-daily-restore-test.mjs" }),
  Object.freeze({ source: "cloud-run/node-crypto-adapter.mjs", destination: "apps/worker/cloud-run/node-crypto-adapter.mjs" }),
  Object.freeze({ source: "cloud-run/owner-bootstrap.mjs", destination: "apps/worker/cloud-run/owner-bootstrap.mjs" }),
  Object.freeze({ source: "cloud-run/request-boundary.mjs", destination: "apps/worker/cloud-run/request-boundary.mjs" }),
  Object.freeze({ source: "cloud-run/analytics-refresh.mjs", destination: "apps/worker/cloud-run/analytics-refresh.mjs" }),
  // The MP-2-lite maintenance Job and the production configuration it reads.
  Object.freeze({ source: "cloud-run/postgres-maintenance-job.mjs", destination: "apps/worker/cloud-run/postgres-maintenance-job.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-maintenance-job.check.mjs", destination: "apps/worker/cloud-run/postgres-maintenance-job.check.mjs" }),
  Object.freeze({ source: "cloud-run/postgres-production-configuration.mjs", destination: "apps/worker/cloud-run/postgres-production-configuration.mjs" }),
  Object.freeze({ source: "src", destination: "apps/worker/src" }),
  // The d43c8f92 analytics kernels and their vendored packages; the
  // analytics-refresh entry and the community-daily route bundle them.
  Object.freeze({ source: "vendor", destination: "apps/worker/vendor" }),
  Object.freeze({ source: "postgres/migrations", destination: "apps/worker/postgres/migrations" }),
  Object.freeze({ source: "scripts/postgres-migrations.mjs", destination: "apps/worker/scripts/postgres-migrations.mjs" }),
  Object.freeze({ source: "scripts/cloud-run-build-context.mjs", destination: "apps/worker/scripts/cloud-run-build-context.mjs" }),
  Object.freeze({ source: "../../packages/accounting", destination: "packages/accounting" }),
  Object.freeze({ source: "../../packages/quota-analysis", destination: "packages/quota-analysis" }),
  Object.freeze({ source: "../../packages/telemetry-contract", destination: "packages/telemetry-contract" }),
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
    !arg.startsWith("--check") && !arg.startsWith("--output=")
      && !arg.startsWith("--assets="))) {
    fail("CLOUD_RUN_CONTEXT_ARGUMENT_INVALID");
  }
  const assetsArg = args.find((arg) => arg.startsWith("--assets="));
  const assets = assetsArg === undefined ? null : assetsArg.slice("--assets=".length);
  if (assets !== null && (!assets || !assets.startsWith("/"))) {
    fail("CLOUD_RUN_CONTEXT_ASSETS_ARGUMENT_INVALID");
  }
  return { check, output: resolve(output), assets: assets === null ? null : resolve(assets) };
}

function assertSafeRelativePath(relativePath) {
  if (relativePath.startsWith("../") || relativePath.includes(`${sep}..${sep}`)
      || relativePath.startsWith("/")) {
    fail("CLOUD_RUN_CONTEXT_PATH_INVALID");
  }
  const parts = relativePath.split(/[\\/]+/u);
  if (parts.some((part) => SECRET_PATH_PARTS.has(part)
      || part.endsWith(".key") || part.endsWith(".pem"))) {
    fail("CLOUD_RUN_CONTEXT_SECRET_PATH");
  }
}

async function assertRegularFile(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("CLOUD_RUN_CONTEXT_SOURCE_UNSAFE");
  }
  if (stat.size > 8 * 1024 * 1024) fail("CLOUD_RUN_CONTEXT_FILE_TOO_LARGE");
}

async function collectFiles(sourcePath, relativeBase = "") {
  const stat = await lstat(sourcePath).catch(() => null);
  if (stat === null || stat.isSymbolicLink()) fail("CLOUD_RUN_CONTEXT_SOURCE_UNSAFE");
  if (stat.isFile()) {
    await assertRegularFile(sourcePath);
    return [relativeBase];
  }
  if (!stat.isDirectory()) fail("CLOUD_RUN_CONTEXT_SOURCE_UNSAFE");
  const names = (await readdir(sourcePath)).sort();
  const paths = [];
  for (const name of names) {
    if (SKIPPED_DIRECTORY_NAMES.has(name)) continue;
    const child = join(sourcePath, name);
    const childRelative = relativeBase === "" ? name : join(relativeBase, name);
    paths.push(...await collectFiles(child, childRelative));
  }
  return paths;
}

async function sourceFiles(assets) {
  const allowlist = assets === null
    ? BASE_ALLOWLIST
    : Object.freeze([
      ...BASE_ALLOWLIST,
      Object.freeze({ source: assets, destination: "apps/worker/cloud-run/assets", absolute: true }),
    ]);
  const files = [];
  for (const entry of allowlist) {
    const source = entry.absolute ? resolve(entry.source) : resolve(WORKER_ROOT, entry.source);
    const relativeBase = entry.absolute ? entry.destination : entry.source;
    const relativeSourceFiles = await collectFiles(source, relativeBase);
    for (const relativeSource of relativeSourceFiles) {
      const destination = entry.absolute
        ? relativeSource
        : join(entry.destination, relative(entry.source, relativeSource));
      assertSafeRelativePath(destination);
      files.push({
        source: join(source, relative(relativeBase, relativeSource)),
        destination,
      });
    }
  }
  files.sort((left, right) => left.destination.localeCompare(right.destination));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].destination === files[index].destination) {
      fail("CLOUD_RUN_CONTEXT_DESTINATION_DUPLICATE");
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

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

/**
 * Every relative module an included host or tooling module imports
 * (statically or through a literal dynamic import) must itself be in the
 * context, or the image build would bundle a module the audited context
 * does not carry. Checked over the included apps/worker/cloud-run and
 * apps/worker/scripts JavaScript modules, including those in included
 * subdirectories (cloud-run/envelopes and cloud-run/routes), other than
 * *.check.mjs (repository checks that the image never builds or runs);
 * src/ and vendor/ enter whole.
 */
async function assertImportClosure(files, includedPaths) {
  for (const file of files) {
    if (!/^apps\/worker\/(?:cloud-run|scripts)\/(?:[^/]+\/)*[^/]+\.mjs$/u.test(file.destination)
        || file.destination.endsWith(".check.mjs")) continue;
    const text = await readFile(file.source, "utf8");
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const imported = join(dirname(file.destination), match[1]);
      if (!includedPaths.has(imported) && ![...includedPaths].some((path) => path.startsWith(`${imported}/`))) {
        fail("CLOUD_RUN_CONTEXT_IMPORT_OUTSIDE_CONTEXT");
      }
    }
  }
}

async function validateSource(assets) {
  const files = await sourceFiles(assets);
  const includedPaths = new Set(files.map((file) => file.destination));
  await assertImportClosure(files, includedPaths);
  if ([...REQUIRED_LEDGER_DIAGNOSTIC_PATHS].some((path) => !includedPaths.has(path))) {
    fail("CLOUD_RUN_CONTEXT_LEDGER_DIAGNOSTIC_PATH_SET_UNEXPECTED");
  }
  if ([...REQUIRED_DAILY_ACTIVATION_PATHS].some((path) => !includedPaths.has(path))) {
    fail("CLOUD_RUN_CONTEXT_DAILY_ACTIVATION_PATH_SET_UNEXPECTED");
  }
  if ([...REQUIRED_DAILY_CONTRACT_PATHS].some((path) => !includedPaths.has(path))) {
    fail("CLOUD_RUN_CONTEXT_DAILY_CONTRACT_PATH_SET_UNEXPECTED");
  }
  const primary = await readPostgresMigrations({
    role: "primary",
    rootDirectory: join(WORKER_ROOT, "postgres", "migrations"),
  });
  const ledger = await readPostgresMigrations({
    role: "ledger",
    rootDirectory: join(WORKER_ROOT, "postgres", "migrations"),
  });
  if (primary.length === 0 || ledger.length === 0) fail("CLOUD_RUN_CONTEXT_MIGRATIONS_EMPTY");
  if (primary.length !== EXPECTED_PRIMARY_MIGRATION_COUNT
      || ledger.length !== EXPECTED_LEDGER_MIGRATION_COUNT
      || primary.at(-1)?.name !== EXPECTED_PRIMARY_MIGRATION_TAIL) {
    fail("CLOUD_RUN_CONTEXT_MIGRATION_SET_UNEXPECTED");
  }
  const primaryPaths = files.filter((file) =>
    file.destination.startsWith("apps/worker/postgres/migrations/primary/"),
  );
  const ledgerPaths = files.filter((file) =>
    file.destination.startsWith("apps/worker/postgres/migrations/ledger/"),
  );
  if (primaryPaths.length !== primary.length || ledgerPaths.length !== ledger.length) {
    fail("CLOUD_RUN_CONTEXT_MIGRATION_PATH_SET_UNEXPECTED");
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
    if (relativePath === "apps/worker/cloud-run/source-content-digest.txt") continue;
    const path = join(target, relativePath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("CLOUD_RUN_CONTEXT_OUTPUT_UNSAFE");
    if (stat.isDirectory()) paths.push(...await collectOutputFiles(target, relativePath));
    else if (stat.isFile()) paths.push(relativePath);
    else fail("CLOUD_RUN_CONTEXT_OUTPUT_UNSAFE");
  }
  return paths;
}

async function createContext(output, files, digest) {
  const target = resolve(output);
  if (target === REPOSITORY_ROOT || target.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
    fail("CLOUD_RUN_CONTEXT_OUTPUT_IN_REPOSITORY");
  }
  const existing = await lstat(target).catch(() => null);
  if (existing !== null) fail("CLOUD_RUN_CONTEXT_OUTPUT_EXISTS");
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = join(target, file.destination);
    await mkdir(dirname(destination), { recursive: true });
    await cp(file.source, destination, { errorOnExist: true, force: false });
  }
  const copiedDigest = await digestCopiedFiles(target, files);
  if (copiedDigest !== digest) {
    await rm(target, { recursive: true, force: true });
    fail("CLOUD_RUN_CONTEXT_SOURCE_CHANGED");
  }
  const expectedPaths = files.map((file) => file.destination).sort();
  const actualPaths = (await collectOutputFiles(target)).sort();
  if (expectedPaths.length !== actualPaths.length
      || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    await rm(target, { recursive: true, force: true });
    fail("CLOUD_RUN_CONTEXT_OUTPUT_SET_UNEXPECTED");
  }
  const digestPath = join(target, "apps/worker/cloud-run/source-content-digest.txt");
  await writeFile(digestPath, `${digest}\n`, { encoding: "utf8", flag: "wx" });
  return target;
}

const { check, output, assets } = parseArgs();
try {
  const source = await validateSource(assets);
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
    code: typeof error?.code === "string" ? error.code : "CLOUD_RUN_CONTEXT_FAILED",
  }));
  process.exitCode = 1;
}
