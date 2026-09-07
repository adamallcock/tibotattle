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
  classifyStableTagRecord,
  formatReleaseNotesReport,
} from "../scripts/check-release-notes.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPOSITORY_WEB_URL = "https://github.com/adamallcock/tibotattle";
const LEGACY_TAG_OBJECT = "3b3a852abad643095c296550a827ed448b3720fa";
const LEGACY_TAG_SOURCE = "151adec996c9a0f621819f89777ac5a05f1df8b6";
const LOCAL_ANNOTATED_TAG_OBJECT = "b0aa8f8a307f10c84e37f905012523a1696401cc";
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
        "**Candidate notes:** [1.2.0](./release-notes/1.2.0.md)",
        "",
        "- Candidate work remains unreleased.",
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

async function populateLegacyTagFixture(rootDirectory) {
  await mkdir(join(rootDirectory, "release-notes"), { recursive: true });
  await Promise.all([
    writeFile(
      join(rootDirectory, "package.json"),
      JSON.stringify({ version: "0.1.10" }) + "\n",
      "utf8",
    ),
    writeFile(
      join(rootDirectory, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## Provenance and acknowledgements",
        "",
        "The sole historical tag anomaly is exact and pinned.",
        "",
        "## [Unreleased]",
        "",
        "## [0.1.10](./release-notes/0.1.10.md) - 2026-08-12",
        "",
        `**Provenance:** [GitHub release](${REPOSITORY_WEB_URL}/releases/tag/v0.1.10) ·`,
        `[source commit](${REPOSITORY_WEB_URL}/commit/${LEGACY_TAG_SOURCE}) ·`,
        `[source history](${REPOSITORY_WEB_URL}/commits/${LEGACY_TAG_SOURCE})`,
        "",
        `Historical published object: ${LEGACY_TAG_OBJECT}.`,
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(rootDirectory, "release-notes", "0.1.10.md"),
      "# Product 0.1.10\n",
      "utf8",
    ),
  ]);
}

function assertReleaseLifecycleInventory(result, packageVersionIsTagged) {
  assert.equal(
    result.stableTagVersions.includes(result.packageVersion),
    packageVersionIsTagged,
  );
  assert.equal(
    result.changelogVersions.includes(result.packageVersion),
    packageVersionIsTagged,
  );
  assert.equal(
    result.noteVersions.length,
    result.changelogVersions.length + (packageVersionIsTagged ? 0 : 1),
  );

  const expectedVersions = new Set(result.stableTagVersions);
  assert.deepEqual(new Set(result.changelogVersions), expectedVersions);
  expectedVersions.add(result.packageVersion);
  assert.deepEqual(new Set(result.noteVersions), expectedVersions);
}

test("the current repository covers every stable tag and package version", async () => {
  const result = await checkReleaseNotes({ rootDirectory: REPOSITORY_ROOT });
  assert.equal(result.ok, true, formatReleaseNotesReport(result));
  assert.match(result.packageVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(result.stableTagVersions.includes("0.1.0"), true);
  assert.equal(result.stableTagVersions.includes("0.1.10"), true);
  assert.equal(result.stableTagVersions.includes("0.1.16"), true);
  assert.equal(
    result.annotatedStableTagCount + result.acceptedLegacyTagExceptions.length,
    result.stableTagVersions.length,
  );
  assert.equal(
    result.acceptedLegacyTagExceptions.every(
      (exception) => exception.version === "0.1.10"
        && exception.objectName === LEGACY_TAG_OBJECT
        && exception.sourceCommit === LEGACY_TAG_SOURCE,
    ),
    true,
  );
  assert.equal(result.noteVersions.length >= 17, true);
  assertReleaseLifecycleInventory(
    result,
    result.stableTagVersions.includes(result.packageVersion),
  );
});

test("only the exact protected v0.1.10 anomaly is pinned", () => {
  assert.equal(
    classifyStableTagRecord({
      objectName: LEGACY_TAG_OBJECT,
      objectType: "commit",
      version: "v0.1.10",
    }),
    "pinned_legacy",
  );
  assert.equal(
    classifyStableTagRecord({
      objectName: LEGACY_TAG_OBJECT.replace(/^3/u, "4"),
      objectType: "commit",
      version: "v0.1.10",
    }),
    "invalid",
  );
  assert.equal(
    classifyStableTagRecord({
      objectName: LEGACY_TAG_OBJECT,
      objectType: "commit",
      version: "v0.1.11",
    }),
    "invalid",
  );
  assert.equal(
    classifyStableTagRecord({
      objectName: LOCAL_ANNOTATED_TAG_OBJECT,
      objectType: "tag",
      peeledObjectName: LEGACY_TAG_SOURCE,
      version: "v0.1.10",
    }),
    "annotated",
  );
  assert.equal(
    classifyStableTagRecord({
      objectName: LOCAL_ANNOTATED_TAG_OBJECT,
      objectType: "tag",
      peeledObjectName: LEGACY_TAG_SOURCE.replace(/^1/u, "2"),
      version: "v0.1.10",
    }),
    "invalid",
  );
});

test("the exact published anomaly passes visibly and drift fails closed", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateLegacyTagFixture(rootDirectory);
    const exactRecord = {
      objectName: LEGACY_TAG_OBJECT,
      objectType: "commit",
      peeledObjectName: "",
      version: "v0.1.10",
    };
    const accepted = await checkReleaseNotes({
      rootDirectory,
      tagRecords: [exactRecord],
    });
    assert.equal(accepted.ok, true, formatReleaseNotesReport(accepted));
    assert.equal(accepted.annotatedStableTagCount, 0);
    assert.deepEqual(accepted.acceptedLegacyTagExceptions, [{
      objectName: LEGACY_TAG_OBJECT,
      sourceCommit: LEGACY_TAG_SOURCE,
      version: "0.1.10",
    }]);
    assert.match(
      formatReleaseNotesReport(accepted),
      new RegExp(
        `Pinned legacy tag exception: v0\\.1\\.10 ${LEGACY_TAG_OBJECT} -> source ${LEGACY_TAG_SOURCE}`,
        "u",
      ),
    );

    const drifted = await checkReleaseNotes({
      rootDirectory,
      tagRecords: [{
        ...exactRecord,
        objectName: LEGACY_TAG_OBJECT.replace(/^3/u, "4"),
      }],
    });
    assert.equal(drifted.ok, false);
    assert.equal(
      drifted.issues.some((entry) => entry.code === "stable_tag_not_annotated"),
      true,
    );

    const missing = await checkReleaseNotes({
      rootDirectory,
      tagRecords: [],
    });
    assert.equal(missing.ok, false);
    assert.equal(
      missing.issues.some(
        (entry) => entry.code === "pinned_legacy_tag_record_count",
      ),
      true,
    );
  });
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
    assert.deepEqual(result.changelogVersions, ["1.1.0"]);
    assertReleaseLifecycleInventory(result, false);
  });
});

test("release preparation covers the package version after its tag exists", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    const changelogPath = join(rootDirectory, "CHANGELOG.md");
    const changelog = await readFile(changelogPath, "utf8");
    await writeFile(
      changelogPath,
      changelog.replace(
        [
          "## [Unreleased]",
          "",
          "**Candidate notes:** [1.2.0](./release-notes/1.2.0.md)",
          "",
          "- Candidate work remains unreleased.",
        ].join("\n"),
        [
          "## [Unreleased]",
          "",
          "## [1.2.0](./release-notes/1.2.0.md) - 2026-08-23",
          "",
          ...provenanceLines("1.2.0", "1.1.0"),
          "- Finalized release.",
        ].join("\n"),
      ),
      "utf8",
    );
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0", "v1.2.0"],
    });
    assert.equal(result.ok, true, formatReleaseNotesReport(result));
    assert.deepEqual(result.stableTagVersions, ["1.1.0", "1.2.0"]);
    assert.deepEqual(result.changelogVersions, ["1.2.0", "1.1.0"]);
    assertReleaseLifecycleInventory(result, true);
  });
});

test("an untagged package candidate cannot claim a dated public release", async () => {
  await withReleaseFixture(async (rootDirectory) => {
    await populateCompleteFixture(rootDirectory);
    const changelogPath = join(rootDirectory, "CHANGELOG.md");
    const changelog = await readFile(changelogPath, "utf8");
    await writeFile(
      changelogPath,
      changelog.replace(
        "**Candidate notes:** [1.2.0](./release-notes/1.2.0.md)\n\n- Candidate work remains unreleased.",
        [
          "## [1.2.0](./release-notes/1.2.0.md) - 2026-08-23",
          "",
          ...provenanceLines("1.2.0", "1.1.0"),
          "- Premature public claim.",
        ].join("\n"),
      ),
      "utf8",
    );
    const result = await checkReleaseNotes({
      rootDirectory,
      tagVersions: ["v1.1.0"],
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.issues.some((entry) =>
        entry.code === "unpublished_changelog_entry"),
      true,
    );
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
        .replace("/releases/tag/v1.1.0", "/releases/tag/v9.9.9")
        .replace("/commits/v1.1.0", "/commits/v1.0.0"),
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
        "**Candidate notes:** [1.2.0](./release-notes/1.2.0.md)",
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
