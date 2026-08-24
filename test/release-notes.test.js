import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  checkReleaseNotes,
  formatReleaseNotesReport,
} from "../scripts/check-release-notes.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPOSITORY_WEB_URL = "https://github.com/adamallcock/tibotattle";
const execFile = promisify(execFileCallback);

function provenanceLines(version, olderVersion = null) {
  const history = olderVersion === null
    ? `[source history](${REPOSITORY_WEB_URL}/commits/v${version})`
    : `[changes](${REPOSITORY_WEB_URL}/compare/v${olderVersion}...v${version})`;
  return [
    `**Provenance:** [GitHub release](${REPOSITORY_WEB_URL}/releases/tag/v${version}) ·`,
    `[annotated source tag](${REPOSITORY_WEB_URL}/tree/v${version}) ·`,
    history,
    "",
  ];
}

async function withReleaseFixture(run) {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-release-notes-"),
  );
  try {
    return await run(rootDirectory);
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
}

async function populateCompleteFixture(rootDirectory) {
  await mkdir(join(rootDirectory, "release-notes"), { recursive: true });
  await Promise.all([
    writeFile(
      join(rootDirectory, "package.json"),
      JSON.stringify({ version: "1.2.0" }) + "\n",
      "utf8",
    ),
    writeFile(
      join(rootDirectory, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## Provenance and acknowledgements",
        "",
        "Release sources and public credits are recorded here.",
        "",
        "## [Unreleased]",
        "",
        "## [1.2.0](./release-notes/1.2.0.md) - 2026-08-23",
        "",
        ...provenanceLines("1.2.0", "1.1.0"),
        "- Current release.",
        "",
        "## [1.1.0](./release-notes/1.1.0.md) - 2026-08-22",
        "",
        ...provenanceLines("1.1.0"),
        "- Prior release.",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(rootDirectory, "release-notes", "1.2.0.md"),
      "# Product 1.2.0\n",
      "utf8",
    ),
    writeFile(
      join(rootDirectory, "release-notes", "1.1.0.md"),
      "# Product 1.1.0\n",
      "utf8",
    ),
  ]);
}

test("the current repository covers every stable tag and package version", async () => {
  const result = await checkReleaseNotes({ rootDirectory: REPOSITORY_ROOT });
  assert.equal(result.ok, true, formatReleaseNotesReport(result));
  assert.match(result.packageVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(result.stableTagVersions.includes("0.1.0"), true);
  assert.equal(result.stableTagVersions.includes("0.1.16"), true);
  assert.equal(
    result.annotatedStableTagCount,
    result.stableTagVersions.length,
  );
  assert.equal(result.noteVersions.length >= 17, true);
  assert.equal(result.noteVersions.length, result.changelogVersions.length);
  assert.equal(result.noteVersions.includes(result.packageVersion), true);
});

test("release trust CI gates every release-documentation change", async () => {
  const workflow = await readFile(
    join(REPOSITORY_ROOT, ".github/workflows/release-trust-policy.yml"),
    "utf8",
  );
  for (const path of [
    "CHANGELOG.md",
    "release-notes/**",
    "scripts/check-release-notes.mjs",
  ]) {
    assert.equal(
      workflow.split(`- \"${path}\"`).length - 1,
      2,
      `${path} must trigger both pull-request and main-branch release checks`,
    );
  }
  assert.match(
    workflow,
    /- name: Check release documentation\n\s+run: node \.\/scripts\/check-release-notes\.mjs/u,
  );
});

test("release preparation covers the package version before its tag exists", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0", "internal-dogfood-1.2.0"],
    });
    assert.equal(result.ok, true, formatReleaseNotesReport(result));
    assert.deepEqual(result.stableTagVersions, ["1.1.0"]);
  });
});

test("missing or drifted release provenance fails closed", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    const changelogPath = join(rootDirectory, "CHANGELOG.md");
    const changelog = await readFile(changelogPath, "utf8");
    await writeFile(
      changelogPath,
      changelog
        .replace("## Provenance and acknowledgements", "## About releases")
        .replace("/releases/tag/v1.2.0", "/releases/tag/v9.9.9")
        .replace("/compare/v1.1.0...v1.2.0", "/compare/v1.0.0...v1.2.0"),
      "utf8",
    );
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0"],
    });
    assert.equal(result.ok, false);
    const codes = new Set(result.issues.map((entry) => entry.code));
    assert.equal(codes.has("missing_provenance_and_acknowledgements"), true);
    assert.equal(codes.has("invalid_github_release_provenance"), true);
    assert.equal(codes.has("invalid_source_history_provenance"), true);
  });
});

test("a lightweight stable tag fails the provenance gate", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    await execFile("git", ["init", "--quiet"], { cwd: rootDirectory });
    await execFile(
      "git",
      ["config", "user.email", "release-test@example.invalid"],
      { cwd: rootDirectory },
    );
    await execFile(
      "git",
      ["config", "user.name", "Release Test"],
      { cwd: rootDirectory },
    );
    await execFile("git", ["add", "package.json", "CHANGELOG.md", "release-notes"], {
      cwd: rootDirectory,
    });
    await execFile("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: rootDirectory,
    });
    await execFile("git", ["tag", "v1.1.0"], { cwd: rootDirectory });
    const result = await checkReleaseNotes({ rootDirectory });
    assert.equal(result.ok, false);
    assert.equal(
      result.issues.some((entry) => entry.code === "stable_tag_not_annotated"),
      true,
    );
  });
});

test("missing historical notes and changelog entries fail closed", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    await rm(join(rootDirectory, "release-notes", "1.1.0.md"));
    await writeFile(
      join(rootDirectory, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.2.0](./release-notes/1.2.0.md) - 2026-08-23",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0"],
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.issues.some((entry) => entry.code === "missing_release_note"),
      true,
    );
    assert.equal(
      result.issues.some((entry) => entry.code === "missing_changelog_entry"),
      true,
    );
  });
});

test("malformed, duplicate, empty, and orphaned release records are rejected", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    await writeFile(
      join(rootDirectory, "release-notes", "1.2.0.md"),
      "   \n",
      "utf8",
    );
    await writeFile(
      join(rootDirectory, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [1.2.0](./wrong.md) - today",
        "",
        "## [1.2.0](./release-notes/1.2.0.md) - 2026-08-23",
        "",
        "## [1.0.0](./release-notes/1.0.0.md) - 2026-08-21",
        "",
        "## [1.1.0](./release-notes/1.1.0.md) - 2026-08-22",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0"],
    });
    assert.equal(result.ok, false);
    const codes = new Set(result.issues.map((entry) => entry.code));
    assert.equal(codes.has("missing_unreleased_section"), true);
    assert.equal(codes.has("invalid_changelog_link"), true);
    assert.equal(codes.has("invalid_changelog_date"), true);
    assert.equal(codes.has("duplicate_changelog_entry"), true);
    assert.equal(codes.has("changelog_version_order"), true);
    assert.equal(codes.has("empty_release_note"), true);
    assert.equal(codes.has("orphan_changelog_entry"), true);
  });
});
