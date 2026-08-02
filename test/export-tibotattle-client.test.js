import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLIENT_MANIFEST_FILE,
  CLIENT_REPOSITORY_NAME,
  CLIENT_SOURCE_FILES,
  createClientExport,
  forbiddenPathReason,
  REPOSITORY_ROOT,
  validateAllowlist,
  validateExportDirectory,
} from "../scripts/export-tibotattle-client.mjs";

test("client exporter creates a history-free, verified allow-list artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-client-export-test-"));
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
    assert.equal(verified.files.some((path) => path.startsWith("apps/cloud-run/")), false);
    assert.equal(verified.files.some((path) => path.startsWith("apps/web/public/admin")), false);
    assert.equal(verified.files.length, created.fileCount);

    const workspace = await readFile(join(output, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /^  fast-uri: 3\.1\.4$/m);

    const osvWorkflow = await readFile(
      join(output, ".github/workflows/osv-scanner.yml"),
      "utf8",
    );
    assert.match(
      osvWorkflow,
      /google\/osv-scanner-action\/\.github\/workflows\/osv-scanner-reusable\.yml@9a498708959aeaef5ef730655706c5a1df1edbc2/u,
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

  const root = await mkdtemp(join(tmpdir(), "tibotattle-client-export-no-clobber-"));
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
