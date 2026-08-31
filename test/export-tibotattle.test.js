import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLIENT_MANIFEST_FILE,
  CLIENT_MACOS_FILES,
  CLIENT_REPOSITORY_NAME,
  CLIENT_SOURCE_FILES,
  createClientExport,
  forbiddenPathReason,
  GENERATED_OSV_WORKFLOW_PATH,
  REPOSITORY_ROOT,
  validateAllowlist,
  validateExportDirectory,
} from "../scripts/export-tibotattle.mjs";

test("client export includes the native menu-bar source closure", () => {
  for (const path of [
    "apps/macos/Sources/MenuBarPaceOutlook.swift",
    "apps/macos/Sources/MenuBarPopover.swift",
    "apps/macos/Sources/MenuBarPopupModel.swift",
    "apps/macos/Sources/NativeBrandPalette.swift",
  ]) {
    assert.equal(CLIENT_MACOS_FILES.includes(path), true, path);
  }
});

test("client exporter creates a history-free, verified allow-list artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-export-test-"));
  const output = join(root, "client");
  await mkdir(output, { mode: 0o700 });
  try {
    const created = await createClientExport({ outputDir: output });
    assert.equal(created.manifest.repository, CLIENT_REPOSITORY_NAME);
    assert.equal(created.manifest.history.privateGitHistoryIncluded, false);
    assert.equal(created.manifest.source.explicitAllowListOnly, true);
    assert.equal(created.manifest.source.sourceRootIncluded, false);
    assert.equal(created.manifest.securityChecks.forbiddenPaths, "passed");
    assert.equal(created.manifest.securityChecks.importBoundary, "passed");
    assert.equal(created.manifest.securityChecks.secretScan, "passed");

    const verified = await validateExportDirectory(output);
    assert.equal(verified.files.includes(CLIENT_MANIFEST_FILE), true);
    assert.equal(verified.files.some((path) => path === ".git" || path.startsWith(".git/")), false);
    assert.equal(verified.files.some((path) => path.startsWith("apps/worker/")), false);
    assert.equal(verified.files.some((path) => path.startsWith("apps/web/public/admin")), false);
    assert.equal(verified.files.length, created.fileCount);

    // The unified reader is part of the shipped local client. Keep the old
    // index/archive modules in the reviewed runtime inventory while rollback
    // remains supported; this test makes both halves of that boundary explicit.
    for (const path of [
      "src/local-cache-drop-thread-links.js",
      "src/platform/local-codex-thread-store.js",
      "test/local-cache-drop-thread-links.test.js",
      "test/local-codex-thread-metadata.test.js",
      "apps/web/test/cache-drop-thread-links-client.test.mjs",
      "apps/web/test/cache-drop-thread-links-ui.test.mjs",
      "src/local-unified-accounting-source.js",
      "src/local-analysis-index.js",
      "src/local-archive-accounting-index.js",
      "src/replay-safe-accounting-cache.js",
      "src/local-unified-contribution-attribution.js",
      "src/contribution/telemetry-v11-chunks.js",
      "src/contribution/telemetry-v11-sync.js",
      "src/platform/telemetry-v11-envelope.js",
      "packages/quota-analysis/src/plan-attribution.js",
      "packages/telemetry-contract/src/telemetry-v1.1.js",
      "packages/telemetry-contract/src/telemetry-v1.1-domain.js",
      "schemas/telemetry-contribution-v1.1/domain-manifest.schema.json",
    ]) {
      assert.equal(verified.files.includes(path), true, `export must include ${path}`);
    }

    const workspace = await readFile(join(output, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /^  fast-uri: 3\.1\.5$/m);

    const osvWorkflow = await readFile(
      join(output, GENERATED_OSV_WORKFLOW_PATH),
      "utf8",
    );
    assert.match(
      osvWorkflow,
      /google\/osv-scanner-action\/\.github\/workflows\/osv-scanner-reusable\.yml@8deb546fdb875b9996d27d4950be7312dac076a1/u,
    );

    // The pinned reusable workflow declares actions:read + contents:read +
    // security-events:write at its top level; GitHub aborts a caller at
    // startup when it grants less. All three grants must survive a fresh,
    // history-free export at BOTH the caller (top-level) and job level, even
    // though upload-sarif is false and nothing is ever written to
    // security-events. A regex on the pinned SHA alone would let a
    // permission-starved template pass CI, so assert the grants explicitly.
    assert.match(
      osvWorkflow,
      /\npermissions:\n  actions: read\n  contents: read\n  security-events: write\n/u,
      "caller-level permissions must grant all three OSV scopes",
    );
    assert.match(
      osvWorkflow,
      /\n    permissions:\n      actions: read\n      contents: read\n      security-events: write\n/u,
      "job-level permissions must grant all three OSV scopes",
    );

    // Expected event triggers.
    assert.match(osvWorkflow, /^on:$/mu);
    assert.match(osvWorkflow, /^  pull_request:$/mu);
    assert.match(osvWorkflow, /^  push:$/mu);
    assert.match(osvWorkflow, /^    branches: \[main\]$/mu);
    assert.match(osvWorkflow, /^  schedule:$/mu);
    assert.match(osvWorkflow, /^    - cron: "23 4 \* \* 1"$/mu);
    assert.match(osvWorkflow, /^  workflow_dispatch:$/mu);

    // Reporting stays in the job log with SARIF upload disabled, and the scan
    // fails the build on any vulnerability.
    assert.match(osvWorkflow, /^      upload-sarif: false$/mu);
    assert.match(osvWorkflow, /^      fail-on-vuln: true$/mu);

    // Parity: the exporter emits the checked-in workflow verbatim, so a fresh
    // export must be byte-identical to the single source of truth. This is
    // what prevents the hardcoded-template drift from ever recurring.
    const referenceWorkflow = await readFile(
      join(REPOSITORY_ROOT, GENERATED_OSV_WORKFLOW_PATH),
      "utf8",
    );
    assert.equal(
      osvWorkflow,
      referenceWorkflow,
      "generated OSV workflow must match the checked-in single source of truth",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client exporter rejects private paths and refuses an output it could overwrite", async () => {
  assert.equal(forbiddenPathReason("apps/worker/wrangler.jsonc"), "private_service_path");
  assert.equal(forbiddenPathReason("apps/web/public/admin.js"), "private_service_path");
  assert.equal(forbiddenPathReason("apps/web/public/admin-client.js"), "private_service_path");
  assert.equal(forbiddenPathReason("operator-private-key.pem"), "credential_or_secret_path");
  assert.throws(
    () => validateAllowlist([...CLIENT_SOURCE_FILES, "apps/worker/wrangler.jsonc"]),
    { code: "CLIENT_EXPORT_FORBIDDEN_PATH" },
  );

  const root = await mkdtemp(join(tmpdir(), "tibotattle-export-no-clobber-"));
  const output = join(root, "non-empty-client");
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "existing.txt"), "caller-owned\n", { mode: 0o600 });
  try {
    await assert.rejects(
      createClientExport({ outputDir: output, sourceRoot: REPOSITORY_ROOT }),
      { code: "CLIENT_EXPORT_OUTPUT_NOT_EMPTY" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
