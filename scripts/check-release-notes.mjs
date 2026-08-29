#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const REPOSITORY_WEB_URL = "https://github.com/adamallcock/tibotattle";
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RELEASE_NOTE_FILENAME_PATTERN = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.md$/u;
const CHANGELOG_ENTRY_PATTERN = /^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\](?:\(([^)]+)\))?(?: - (\S+))?\s*$/gmu;
const CHANGELOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const PINNED_LEGACY_STABLE_TAG = Object.freeze({
  annotatedObjectName: "b0aa8f8a307f10c84e37f905012523a1696401cc",
  publishedObjectName: "3b3a852abad643095c296550a827ed448b3720fa",
  publishedObjectType: "commit",
  sourceCommit: "151adec996c9a0f621819f89777ac5a05f1df8b6",
  version: "0.1.10",
});

function issue(code, path, detail) {
  return { code, detail, path };
}

function normalizeStableVersion(value) {
  if (typeof value !== "string") return null;
  const candidate = value.startsWith("v") ? value.slice(1) : value;
  return STABLE_VERSION_PATTERN.test(candidate) ? candidate : null;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function validChangelogDate(value) {
  if (!CHANGELOG_DATE_PATTERN.test(value ?? "")) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function discoverStableTags(rootDirectory) {
  const result = await execFile(
    "git",
    [
      "-C",
      rootDirectory,
      "for-each-ref",
      "--format=%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ],
    { encoding: "utf8" },
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tag, objectType, objectName, peeledObjectName = ""] = line.split("\t");
      return {
        objectName,
        objectType,
        peeledObjectName,
        version: normalizeStableVersion(tag),
      };
    })
    .filter((record) => record.version !== null);
}

export function classifyStableTagRecord(record) {
  const version = normalizeStableVersion(record?.version);
  if (version === null) return "invalid";
  if (version === PINNED_LEGACY_STABLE_TAG.version) {
    if (record.objectType === "tag") {
      return record.objectName === PINNED_LEGACY_STABLE_TAG.annotatedObjectName
        && record.peeledObjectName === PINNED_LEGACY_STABLE_TAG.sourceCommit
        ? "annotated"
        : "invalid";
    }
    return record.objectType === PINNED_LEGACY_STABLE_TAG.publishedObjectType
      && record.objectName === PINNED_LEGACY_STABLE_TAG.publishedObjectName
      ? "pinned_legacy"
      : "invalid";
  }
  return record.objectType === "tag" ? "annotated" : "invalid";
}

function sourceRevision(version) {
  return version === PINNED_LEGACY_STABLE_TAG.version
    ? PINNED_LEGACY_STABLE_TAG.sourceCommit
    : "v" + version;
}

function sourceUrl(version) {
  return version !== PINNED_LEGACY_STABLE_TAG.version
    ? REPOSITORY_WEB_URL + "/tree/v" + version
    : REPOSITORY_WEB_URL + "/commit/"
      + PINNED_LEGACY_STABLE_TAG.sourceCommit;
}

function parseChangelog(source) {
  const entries = [];
  for (const match of source.matchAll(CHANGELOG_ENTRY_PATTERN)) {
    entries.push({
      date: match[3] ?? null,
      index: match.index,
      link: match[2] ?? null,
      version: match[1],
    });
  }
  for (let index = 0; index < entries.length; index += 1) {
    entries[index].section = source.slice(
      entries[index].index,
      entries[index + 1]?.index ?? source.length,
    );
  }
  return {
    entries,
    hasProvenanceAndAcknowledgements:
      /^## Provenance and acknowledgements\s*$/mu.test(source),
    hasUnreleased: /^## \[Unreleased\]\s*$/mu.test(source),
  };
}

async function discoverReleaseNotes(rootDirectory) {
  const notesDirectory = join(rootDirectory, "release-notes");
  let entries;
  try {
    entries = await readdir(notesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const notes = new Map();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const match = RELEASE_NOTE_FILENAME_PATTERN.exec(entry.name);
    if (match === null) return;
    notes.set(
      match[1],
      await readFile(join(notesDirectory, entry.name), "utf8"),
    );
  }));
  return notes;
}

function addIssue(issues, seenIssues, code, path, detail) {
  const key = [code, path, detail].join("\0");
  if (seenIssues.has(key)) return;
  seenIssues.add(key);
  issues.push(issue(code, path, detail));
}

/**
 * Validate the repository-local release history without requiring network
 * access. Annotated stable Git tags and exact pinned historical anomalies
 * supply the published-version set; the package version is included separately
 * so release preparation is checked before the next tag exists. tagVersions is
 * injectable for deterministic fixture tests that do not create a Git
 * repository. tagRecords injects exact Git-ref records for tag-classification
 * fixtures.
 */
export async function checkReleaseNotes({
  rootDirectory = DEFAULT_REPOSITORY_ROOT,
  tagRecords = null,
  tagVersions = null,
} = {}) {
  const absoluteRoot = resolve(rootDirectory);
  const issues = [];
  const seenIssues = new Set();

  let packageVersion = null;
  const packagePath = join(absoluteRoot, "package.json");
  const packageSource = await readOptionalText(packagePath);
  if (packageSource === null) {
    addIssue(
      issues,
      seenIssues,
      "missing_package_manifest",
      "package.json",
      "The release documentation check requires the root package version.",
    );
  } else {
    try {
      const manifest = JSON.parse(packageSource);
      packageVersion = normalizeStableVersion(manifest.version);
      if (packageVersion === null) {
        addIssue(
          issues,
          seenIssues,
          "invalid_package_version",
          "package.json",
          "The root package version must be a stable X.Y.Z version.",
        );
      }
    } catch (error) {
      addIssue(
        issues,
        seenIssues,
        "invalid_package_manifest",
        "package.json",
        "The root package manifest is not valid JSON: " + error.message,
      );
    }
  }

  let annotatedStableTagCount = null;
  let acceptedLegacyTagExceptions = [];
  let pinnedLegacyTagRecordCount = null;
  let stableTagVersions = [];
  if (tagVersions === null) {
    try {
      const stableTags = tagRecords === null
        ? await discoverStableTags(absoluteRoot)
        : tagRecords
          .map((record) => ({
            ...record,
            version: normalizeStableVersion(record?.version),
          }))
          .filter((record) => record.version !== null);
      pinnedLegacyTagRecordCount = stableTags.filter(
        (record) => record.version === PINNED_LEGACY_STABLE_TAG.version,
      ).length;
      stableTagVersions = stableTags.map((record) => record.version);
      const classifiedTags = stableTags.map((record) => ({
        classification: classifyStableTagRecord(record),
        record,
      }));
      annotatedStableTagCount = classifiedTags
        .filter(({ classification }) => classification === "annotated")
        .length;
      for (const { classification, record } of classifiedTags) {
        if (classification === "annotated") continue;
        if (classification === "pinned_legacy") {
          acceptedLegacyTagExceptions.push({
            objectName: record.objectName,
            sourceCommit: PINNED_LEGACY_STABLE_TAG.sourceCommit,
            version: record.version,
          });
          continue;
        }
        addIssue(
          issues,
          seenIssues,
          "stable_tag_not_annotated",
          "refs/tags/v" + record.version,
          "Published stable tags must be annotated provenance records or match an exact pinned historical anomaly.",
        );
      }
    } catch (error) {
      addIssue(
        issues,
        seenIssues,
        "tag_discovery_failed",
        ".git",
        "Stable Git tags could not be read: " + error.message,
      );
    }
  } else {
    stableTagVersions = tagVersions
      .map(normalizeStableVersion)
      .filter((version) => version !== null);
  }
  stableTagVersions = [...new Set(stableTagVersions)].sort(compareVersions);
  acceptedLegacyTagExceptions = acceptedLegacyTagExceptions
    .sort((left, right) => compareVersions(left.version, right.version));

  const changelogPath = join(absoluteRoot, "CHANGELOG.md");
  const changelogSource = await readOptionalText(changelogPath);
  const parsedChangelog = changelogSource === null
    ? {
        entries: [],
        hasProvenanceAndAcknowledgements: false,
        hasUnreleased: false,
      }
    : parseChangelog(changelogSource);
  if (changelogSource === null) {
    addIssue(
      issues,
      seenIssues,
      "missing_changelog",
      "CHANGELOG.md",
      "Add the release index and its Unreleased section.",
    );
  } else if (!parsedChangelog.hasUnreleased) {
    addIssue(
      issues,
      seenIssues,
      "missing_unreleased_section",
      "CHANGELOG.md",
      "The changelog must contain an exact '## [Unreleased]' heading.",
    );
  }
  if (
    changelogSource !== null
    && !parsedChangelog.hasProvenanceAndAcknowledgements
  ) {
    addIssue(
      issues,
      seenIssues,
      "missing_provenance_and_acknowledgements",
      "CHANGELOG.md",
      "The changelog must explain its provenance and public-credit policy.",
    );
  }

  const changelogEntries = new Map();
  for (let index = 0; index < parsedChangelog.entries.length; index += 1) {
    const entry = parsedChangelog.entries[index];
    const expectedLink = "./release-notes/" + entry.version + ".md";
    if (entry.link !== expectedLink) {
      addIssue(
        issues,
        seenIssues,
        "invalid_changelog_link",
        "CHANGELOG.md",
        "Version " + entry.version + " must link to " + expectedLink + ".",
      );
    }
    if (!validChangelogDate(entry.date)) {
      addIssue(
        issues,
        seenIssues,
        "invalid_changelog_date",
        "CHANGELOG.md",
        "Version " + entry.version + " must have a YYYY-MM-DD release date.",
      );
    }
    const releaseUrl = REPOSITORY_WEB_URL + "/releases/tag/v" + entry.version;
    const expectedSourceUrl = sourceUrl(entry.version);
    if (!entry.section.includes("**Provenance:**")) {
      addIssue(
        issues,
        seenIssues,
        "missing_release_provenance",
        "CHANGELOG.md",
        "Version " + entry.version + " must include a visible Provenance line.",
      );
    }
    if (!entry.section.includes(releaseUrl)) {
      addIssue(
        issues,
        seenIssues,
        "invalid_github_release_provenance",
        "CHANGELOG.md",
        "Version " + entry.version + " must link to " + releaseUrl + ".",
      );
    }
    if (!entry.section.includes(expectedSourceUrl)) {
      addIssue(
        issues,
        seenIssues,
        "invalid_source_tag_provenance",
        "CHANGELOG.md",
        "Version " + entry.version + " must link to " + expectedSourceUrl + ".",
      );
    }
    if (
      entry.version === PINNED_LEGACY_STABLE_TAG.version
      && !entry.section.includes(PINNED_LEGACY_STABLE_TAG.publishedObjectName)
    ) {
      addIssue(
        issues,
        seenIssues,
        "missing_tag_anomaly_provenance",
        "CHANGELOG.md",
        "Version " + entry.version + " must disclose pinned published object "
          + PINNED_LEGACY_STABLE_TAG.publishedObjectName + ".",
      );
    }
    const olderEntry = parsedChangelog.entries[index + 1] ?? null;
    const historyUrl = olderEntry === null
      ? REPOSITORY_WEB_URL + "/commits/" + sourceRevision(entry.version)
      : REPOSITORY_WEB_URL + "/compare/" + sourceRevision(olderEntry.version)
        + "..." + sourceRevision(entry.version);
    if (!entry.section.includes(historyUrl)) {
      addIssue(
        issues,
        seenIssues,
        "invalid_source_history_provenance",
        "CHANGELOG.md",
        "Version " + entry.version + " must link to " + historyUrl + ".",
      );
    }
    if (changelogEntries.has(entry.version)) {
      addIssue(
        issues,
        seenIssues,
        "duplicate_changelog_entry",
        "CHANGELOG.md",
        "Version " + entry.version + " appears more than once.",
      );
    } else {
      changelogEntries.set(entry.version, entry);
    }
  }
  for (let index = 1; index < parsedChangelog.entries.length; index += 1) {
    const previous = parsedChangelog.entries[index - 1].version;
    const current = parsedChangelog.entries[index].version;
    if (compareVersions(previous, current) < 0) {
      addIssue(
        issues,
        seenIssues,
        "changelog_version_order",
        "CHANGELOG.md",
        "Released entries must be newest first; " + current
          + " cannot follow " + previous + ".",
      );
    }
  }

  const releaseNotes = await discoverReleaseNotes(absoluteRoot);
  if (releaseNotes === null) {
    addIssue(
      issues,
      seenIssues,
      "missing_release_notes_directory",
      "release-notes",
      "Create release-notes/ and add one X.Y.Z.md file per stable version.",
    );
  }
  const noteVersions = releaseNotes === null
    ? []
    : [...releaseNotes.keys()].sort(compareVersions);

  if (
    tagVersions === null
    && (
      releaseNotes?.has(PINNED_LEGACY_STABLE_TAG.version)
      || changelogEntries.has(PINNED_LEGACY_STABLE_TAG.version)
    )
    && pinnedLegacyTagRecordCount !== 1
  ) {
    addIssue(
      issues,
      seenIssues,
      "pinned_legacy_tag_record_count",
      "refs/tags/v" + PINNED_LEGACY_STABLE_TAG.version,
      "The pinned historical anomaly requires exactly one discovered tag record; found "
        + pinnedLegacyTagRecordCount + ".",
    );
  }

  for (const [version, source] of releaseNotes ?? []) {
    if (source.trim().length === 0) {
      addIssue(
        issues,
        seenIssues,
        "empty_release_note",
        "release-notes/" + version + ".md",
        "Release notes must contain reviewed user-facing text.",
      );
    }
  }

  const requiredVersions = new Set([
    ...stableTagVersions,
    ...noteVersions,
  ]);
  if (packageVersion !== null) requiredVersions.add(packageVersion);

  for (const version of [...requiredVersions].sort(compareVersions)) {
    if (!releaseNotes?.has(version)) {
      addIssue(
        issues,
        seenIssues,
        "missing_release_note",
        "release-notes/" + version + ".md",
        "Stable version " + version + " requires a checked-in notes file.",
      );
    }
    if (!changelogEntries.has(version)) {
      addIssue(
        issues,
        seenIssues,
        "missing_changelog_entry",
        "CHANGELOG.md",
        "Stable version " + version + " requires a dated linked entry.",
      );
    }
  }

  for (const version of changelogEntries.keys()) {
    if (!releaseNotes?.has(version)) {
      addIssue(
        issues,
        seenIssues,
        "orphan_changelog_entry",
        "CHANGELOG.md",
        "Version " + version + " links to a release note that does not exist.",
      );
    }
  }

  if (
    packageVersion !== null
    && parsedChangelog.entries.length > 0
    && parsedChangelog.entries[0].version !== packageVersion
  ) {
    addIssue(
      issues,
      seenIssues,
      "latest_changelog_version",
      "CHANGELOG.md",
      "The first released entry must match package version " + packageVersion + ".",
    );
  }

  issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code)
      || left.path.localeCompare(right.path)
      || left.detail.localeCompare(right.detail),
  );
  return {
    annotatedStableTagCount,
    acceptedLegacyTagExceptions,
    changelogVersions: [...changelogEntries.keys()],
    issues,
    noteVersions,
    ok: issues.length === 0,
    packageVersion,
    stableTagVersions,
  };
}

export function formatReleaseNotesReport(result) {
  if (result.ok) {
    return [
      "Release documentation is complete.",
      "Package version: " + result.packageVersion,
      "Stable tags covered: " + result.stableTagVersions.length,
      ...(result.annotatedStableTagCount === null
        ? []
        : ["Annotated stable tags: " + result.annotatedStableTagCount]),
      ...(result.acceptedLegacyTagExceptions.length === 0
        ? []
        : result.acceptedLegacyTagExceptions.map((exception) =>
            "Pinned legacy tag exception: v" + exception.version + " "
              + exception.objectName + " -> source " + exception.sourceCommit
          )),
      "Release notes covered: " + result.noteVersions.length,
      "Changelog entries covered: " + result.changelogVersions.length,
    ].join("\n");
  }
  return [
    "Release documentation check failed with " + result.issues.length + " issue(s).",
    ...result.issues.map(
      ({ code, detail, path }) => "- [" + code + "] " + path + ": " + detail,
    ),
  ].join("\n");
}

function parseArguments(arguments_) {
  let rootDirectory = process.cwd();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a directory.");
      }
      rootDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true, rootDirectory };
    }
    throw new Error("Unknown argument: " + argument);
  }
  return { help: false, rootDirectory };
}

function usage() {
  return [
    "Usage: node ./scripts/check-release-notes.mjs [--root <directory>]",
    "",
    "Require provenance and Unreleased sections, one dated changelog entry",
    "with release/tag/history links per stable version, and one non-empty",
    "release-notes/X.Y.Z.md file per version.",
  ].join("\n");
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
      return;
    }
    const result = await checkReleaseNotes(options);
    const output = formatReleaseNotesReport(result);
    if (result.ok) {
      process.stdout.write(output + "\n");
    } else {
      process.stderr.write(output + "\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(error.message + "\n" + usage() + "\n");
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  await runCli();
}
