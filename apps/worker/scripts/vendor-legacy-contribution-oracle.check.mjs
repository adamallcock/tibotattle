// Offline tests for scripts/vendor-legacy-contribution-oracle.mjs. Each test
// builds a synthetic repository with git, so nothing here needs the real
// d43c8f92 objects; the real tree is checked by
// `node scripts/vendor-legacy-contribution-oracle.mjs --check` (which does)
// and by postgres-test/postgres-legacy-contribution-admission.spec.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  ORACLE_ENTRY_POINTS,
  ORACLE_LIVE_SEAMS,
  compareOracleVendor,
  deriveOracleVendor,
  gitBlobId,
  writeOracleVendor,
} from "./vendor-legacy-contribution-oracle.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A synthetic repository holding the oracle's layout; returns { root, workerRoot, commit }. */
function syntheticRepository(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "tibotattle-legacy-oracle-check-"));
  const files = {
    ...Object.fromEntries(ORACLE_ENTRY_POINTS.map((entry) => [entry, "export const value = 1;\n"])),
    "apps/worker/src/typed-v1-admission.ts": [
      'import { helper } from "./helper";',
      'import { contract } from "@app-usagemonitor/telemetry-contract";',
      'import type { OnlyType } from "./types-only";',
      "export const admitted: OnlyType = helper + contract;",
      "",
    ].join("\n"),
    "apps/worker/src/telemetry-repository.ts": 'import { price } from "./server-pricing";\nexport const priced = price;\n',
    "apps/worker/src/crypto.ts": 'import { quota } from "@app-usagemonitor/quota-analysis";\nexport const keyed = quota;\n',
    "apps/worker/src/errors.ts": 'import { parse } from "jsonc-parser";\nexport const parsed = parse;\n',
    "apps/worker/src/helper.ts": "export const helper = 2;\n",
    "apps/worker/src/types-only.ts": "export type OnlyType = number;\n",
    "apps/worker/src/unused.ts": "export const unused = 3;\n",
    "apps/worker/src/server-pricing.ts": 'import { card } from "@app-usagemonitor/accounting";\nexport const price = card;\n',
    "apps/worker/migrations/0001_first.sql": "CREATE TABLE first (id INTEGER);\n",
    "apps/worker/migrations/README.md": "not a migration\n",
    "apps/worker/ingestion-isolation-migrations/0002_second.sql": "CREATE TABLE second (id INTEGER);\n",
    "apps/worker/other-migrations/0003_ignored.sql": "CREATE TABLE ignored (id INTEGER);\n",
    "apps/worker/package-lock.json": `${JSON.stringify({ packages: { "node_modules/jsonc-parser": { version: "9.9.9" } } })}\n`,
    "packages/telemetry-contract/index.js": 'export { contract } from "./src/contract.js";\n',
    "packages/telemetry-contract/src/contract.js": "export const contract = 4;\n",
    "packages/telemetry-contract/src/unreached.js": "export const unreached = 5;\n",
    "packages/telemetry-contract/package.json": "{}\n",
    "packages/quota-analysis/index.js": "export const quota = 6;\n",
    "packages/accounting/index.js": "export const card = 7;\n",
    ...overrides,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "synthetic oracle tree");
  return { root, workerRoot: join(root, "apps", "worker"), commit: git(root, "rev-parse", "HEAD") };
}

test("derives the import closure, reached packages, D1 migrations and the locked external from a commit", async () => {
  const repository = syntheticRepository();
  try {
    const derived = await deriveOracleVendor({ workerRoot: repository.workerRoot, commit: repository.commit });
    assert.deepEqual(derived.files.map(({ path }) => path), [
      ...ORACLE_ENTRY_POINTS,
      "apps/worker/src/helper.ts",
      "apps/worker/ingestion-isolation-migrations/0002_second.sql",
      "apps/worker/migrations/0001_first.sql",
      "packages/quota-analysis/index.js",
      "packages/telemetry-contract/index.js",
      "packages/telemetry-contract/src/contract.js",
      "packages/telemetry-contract/src/unreached.js",
    ].sort());
    for (const { path, blob, bytes } of derived.files) {
      assert.equal(blob, git(repository.root, "rev-parse", `${repository.commit}:${path}`), path);
      assert.equal(gitBlobId(bytes), blob, path);
    }
    assert.deepEqual(derived.externals, { "jsonc-parser": "9.9.9" });
    const manifest = JSON.parse(derived.manifest);
    assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA);
    assert.equal(manifest.sourceCommit, repository.commit);
    assert.deepEqual(manifest.liveSeams, ORACLE_LIVE_SEAMS);
    assert.deepEqual(manifest.files, derived.files.map(({ path, blob }) => ({ path, blob })));
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("writes only a byte-identical tree and reports every drift", async () => {
  const repository = syntheticRepository();
  try {
    const derived = await deriveOracleVendor({ workerRoot: repository.workerRoot, commit: repository.commit });
    const vendor = join(repository.root, "vendor-out");
    mkdirSync(vendor);
    writeFileSync(join(vendor, "stale.txt"), "replaced\n");
    writeOracleVendor(derived, vendor);
    assert.deepEqual(compareOracleVendor(derived, vendor), []);
    assert.equal(readFileSync(join(vendor, MANIFEST_FILE), "utf8"), derived.manifest);
    writeFileSync(join(vendor, "apps/worker/src/helper.ts"), "export const helper = 99;\n");
    writeFileSync(join(vendor, "extra.ts"), "export {};\n");
    unlinkSync(join(vendor, "apps/worker/migrations/0001_first.sql"));
    assert.deepEqual(compareOracleVendor(derived, vendor), [
      "differs apps/worker/src/helper.ts",
      "missing apps/worker/migrations/0001_first.sql",
      "unexpected extra.ts",
    ]);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("the pricer seam is never vendored, with or without an extension", async () => {
  const repository = syntheticRepository({
    "apps/worker/src/telemetry-v1.ts": 'import { price } from "./server-pricing.ts";\nexport const v1 = price;\n',
  });
  try {
    const derived = await deriveOracleVendor({ workerRoot: repository.workerRoot, commit: repository.commit });
    const paths = derived.files.map(({ path }) => path);
    for (const seam of ORACLE_LIVE_SEAMS) assert.equal(paths.includes(seam), false);
    assert.equal(paths.some((path) => path.startsWith("packages/accounting/")), false,
      "a package only the seam imports stays live");
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test("refuses a closure that leaves the vendored layout or does not resolve, a missing alias target and an unlocked external", async () => {
  const cases = [
    [{ "apps/worker/src/device-auth.ts": 'import lock from "../package-lock.json";\nexport const d = lock;\n' },
      "LEGACY_ORACLE_CLOSURE_UNEXPECTED"],
    [{ "apps/worker/src/device-auth.ts": 'import { t } from "../test/helper";\nexport const d = t;\n',
      "apps/worker/test/helper.ts": "export const t = 1;\n" }, "LEGACY_ORACLE_CLOSURE_UNRESOLVED"],
    [{ "apps/worker/src/device-auth.ts": 'import { r } from "runcost";\nexport const d = r;\n' },
      "LEGACY_ORACLE_CLOSURE_UNRESOLVED"],
    [{ "apps/worker/src/crypto.ts": "export const keyed = 1;\n" }, "LEGACY_ORACLE_CLOSURE_UNEXPECTED"],
    [{ "apps/worker/package-lock.json": "{\"packages\":{}}\n" }, "LEGACY_ORACLE_EXTERNAL_UNLOCKED"],
  ];
  for (const [overrides, code] of cases) {
    const repository = syntheticRepository(overrides);
    try {
      await assert.rejects(deriveOracleVendor({ workerRoot: repository.workerRoot, commit: repository.commit }),
        { code }, Object.keys(overrides).join(", "));
    } finally {
      rmSync(repository.root, { recursive: true, force: true });
    }
  }
});

test("refuses a commit the repository does not hold", async () => {
  const repository = syntheticRepository();
  try {
    await assert.rejects(deriveOracleVendor({ workerRoot: repository.workerRoot, commit: "0".repeat(40) }),
      { code: "LEGACY_ORACLE_COMMIT_UNAVAILABLE" });
    const tree = git(repository.root, "rev-parse", "HEAD^{tree}");
    await assert.rejects(deriveOracleVendor({ workerRoot: repository.workerRoot, commit: tree }),
      { code: "LEGACY_ORACLE_COMMIT_UNAVAILABLE" });
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});
