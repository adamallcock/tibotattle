import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { digestRegularFile } from "./release-evidence.js";

export const PUBLIC_RELEASE_MANIFEST_SCHEMA =
  "usage-monitor-release-site-manifest-v0.3";
export const PUBLIC_RELEASE_SOURCE_PROVENANCE_SCHEMA =
  "usage-monitor-release-site-source-v0.1";
export const PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;

function pathWithin(parent, child) {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`)
    && !isAbsolute(value));
}

function safeRelativePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((part) =>
      part === "" || part === "." || part === "..",
    );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEntriesDigest(entries) {
  return sha256(JSON.stringify(entries));
}

function sourceRootRelativeToRepository(repositoryRoot, sourceRoot) {
  const repository = resolve(repositoryRoot);
  const source = resolve(sourceRoot);
  if (!pathWithin(repository, source)) return null;
  const value = relative(repository, source).split(sep).join("/");
  return safeRelativePath(value) ? value : null;
}

/**
 * Binds a generated public release to the exact source closure the generator
 * selected. The manifest deliberately records only repository-relative names
 * and digests: it never leaks an operator's absolute checkout path.
 */
export async function createPublicReleaseSourceProvenance({
  repositoryRoot,
  sourceRoot,
  sourceFiles,
}) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    throw new TypeError("Public release source provenance requires source files");
  }
  const root = resolve(sourceRoot);
  const entries = [];
  const seen = new Set();
  for (const sourceFile of sourceFiles) {
    const path = resolve(sourceFile);
    if (!pathWithin(root, path)) {
      throw new TypeError("Public release source provenance escaped its source root");
    }
    const name = relative(root, path).split(sep).join("/");
    if (!safeRelativePath(name) || seen.has(name)) {
      throw new TypeError("Public release source provenance has an unsafe file name");
    }
    seen.add(name);
    const digest = await digestRegularFile(
      path,
      `Public release source ${name}`,
      null,
      root,
    );
    entries.push({
      path: name,
      bytes: digest.bytes,
      sha256: digest.sha256,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    schemaVersion: PUBLIC_RELEASE_SOURCE_PROVENANCE_SCHEMA,
    // This manifest is deployed as a public asset. The local web-release
    // receipt records the private Git source SHA; the served manifest proves
    // the selected public source closure without exposing that SHA.
    repositoryCommit: null,
    root: sourceRootRelativeToRepository(repositoryRoot, root),
    files: entries,
    sha256: canonicalEntriesDigest(entries),
  });
}

/**
 * The production staging path re-hashes the exact selected closure from its
 * detached source snapshot. A generated asset tree from another revision or
 * from a different public root therefore cannot be staged as a web release.
 */
export async function verifyPublicReleaseSourceProvenance({
  repositoryRoot,
  expectedSourceCommit,
  provenance,
  requiredRoot = "apps/web/public",
}) {
  if (typeof expectedSourceCommit !== "string"
      || !PUBLIC_RELEASE_SOURCE_COMMIT_PATTERN.test(expectedSourceCommit)) {
    throw new TypeError("Expected public release source commit is invalid");
  }
  if (provenance === null || typeof provenance !== "object"
      || Array.isArray(provenance)
      || provenance.schemaVersion !== PUBLIC_RELEASE_SOURCE_PROVENANCE_SCHEMA
      || provenance.repositoryCommit !== null
      || provenance.root !== requiredRoot
      || !Array.isArray(provenance.files)
      || provenance.files.length === 0
      || !/^[a-f0-9]{64}$/u.test(provenance.sha256)) {
    throw new TypeError(
      "Generated public release provenance does not match the source snapshot",
    );
  }
  const sourceRoot = resolve(repositoryRoot, requiredRoot);
  if (!pathWithin(resolve(repositoryRoot), sourceRoot)) {
    throw new TypeError("Configured public release source root is unsafe");
  }
  const entries = [];
  const seen = new Set();
  let previous = "";
  for (const row of provenance.files) {
    if (!safeRelativePath(row?.path)
        || seen.has(row.path)
        || row.path.localeCompare(previous) < 0
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 1
        || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
      throw new TypeError("Generated public release provenance is malformed");
    }
    previous = row.path;
    seen.add(row.path);
    const sourcePath = resolve(sourceRoot, row.path);
    if (!pathWithin(sourceRoot, sourcePath)) {
      throw new TypeError("Generated public release provenance escaped its source root");
    }
    const digest = await digestRegularFile(
      sourcePath,
      `Public release provenance source ${row.path}`,
      null,
      sourceRoot,
    );
    if (digest.bytes !== row.bytes || digest.sha256 !== row.sha256) {
      throw new TypeError(
        `Generated public release provenance does not match the source snapshot: ${row.path}`,
      );
    }
    entries.push({ path: row.path, bytes: row.bytes, sha256: row.sha256 });
  }
  if (!seen.has("community.html") || !seen.has("community.js")
      || canonicalEntriesDigest(entries) !== provenance.sha256) {
    throw new TypeError("Generated public release provenance is incomplete");
  }
  return Object.freeze({
    sourceRoot,
    sourceFiles: entries.length,
    sourceCommit: expectedSourceCommit,
  });
}
