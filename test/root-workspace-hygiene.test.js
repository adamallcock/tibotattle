import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkRootWorkspaceHygiene,
  formatRootWorkspaceHygieneReport,
  ROOT_WORKSPACE_POLICY,
} from "../scripts/check-root-workspace-hygiene.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function policyEntries() {
  return [
    ...ROOT_WORKSPACE_POLICY.files,
    ...ROOT_WORKSPACE_POLICY.directories,
  ];
}

async function withRootFixture(run) {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-root-workspace-hygiene-"),
  );
  try {
    return await run(rootDirectory);
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
}

async function populateAcceptedRoot(rootDirectory) {
  await Promise.all([
    ...ROOT_WORKSPACE_POLICY.files.map(
      (path) => writeFile(join(rootDirectory, path), "fixture\n", "utf8"),
    ),
    ...ROOT_WORKSPACE_POLICY.directories.map(
      (path) => mkdir(join(rootDirectory, path), { recursive: true }),
    ),
  ]);
}

test("the current repository root conforms to the reviewed policy", async () => {
  const result = await checkRootWorkspaceHygiene({
    rootDirectory: REPOSITORY_ROOT,
  });
  assert.equal(result.ok, true, formatRootWorkspaceHygieneReport(result));
  assert.deepEqual(result.issues, []);
});

test("accepted root configuration allows common project files and directories", async () => {
  await withRootFixture(async (rootDirectory) => {
    await populateAcceptedRoot(rootDirectory);
    const result = await checkRootWorkspaceHygiene({
      rootDirectory,
      trackedRootEntries: policyEntries(),
    });
    assert.equal(result.ok, true, formatRootWorkspaceHygieneReport(result));
    assert.deepEqual(result.issues, []);
  });
});

test("tracked root allowlist rejects an unreviewed top-level entry", async () => {
  await withRootFixture(async (rootDirectory) => {
    await writeFile(join(rootDirectory, "README.md"), "fixture\n", "utf8");
    await writeFile(
      join(rootDirectory, "unreviewed-output.js"),
      "fixture\n",
      "utf8",
    );
    const result = await checkRootWorkspaceHygiene({
      rootDirectory,
      trackedRootEntries: ["README.md", "unreviewed-output.js"],
    });
    assert.equal(result.ok, false, formatRootWorkspaceHygieneReport(result));
    assert.equal(
      result.issues.some((entry) => entry.code === "unexpected_tracked_root_entry"),
      true,
    );
    assert.match(
      formatRootWorkspaceHygieneReport(result),
      /ROOT_WORKSPACE_POLICY.*generated reports\/artifacts/isu,
    );
  });
});

test("dated reports and temporary artifacts at root are rejected with destinations", async () => {
  await withRootFixture(async (rootDirectory) => {
    const datedReport = "2026-08-05-usage-report.html";
    const temporaryArtifact = ".artifact.json.123.tmp";
    await Promise.all([
      writeFile(join(rootDirectory, datedReport), "fixture\n", "utf8"),
      writeFile(join(rootDirectory, temporaryArtifact), "fixture\n", "utf8"),
    ]);
    const result = await checkRootWorkspaceHygiene({
      rootDirectory,
      trackedRootEntries: [],
    });
    assert.equal(result.ok, false, formatRootWorkspaceHygieneReport(result));
    assert.equal(
      result.issues.filter((entry) => entry.code === "generated_root_artifact").length,
      2,
    );
    const report = formatRootWorkspaceHygieneReport(result);
    assert.match(report, /2026-08-05-usage-report\.html/u);
    assert.match(report, /\.artifact\.json\.123\.tmp/u);
    assert.match(report, /\.usage-monitor\/legacy-reports\//u);
    assert.match(report, /purpose-specific ignored directory/u);
  });
});
