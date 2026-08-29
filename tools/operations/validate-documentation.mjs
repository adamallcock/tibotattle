#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..", "..");

const DATED_DOCUMENT = /^(\d{4}-\d{2}-\d{2})-.+\.md$/u;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const CURRENT_AUTHORITY_STATUSES = new Set([
  "canonical",
  "current",
  "maintained",
  "operational",
]);
const OBSOLETE_AUTHORITY_STATUS = /(?:^|[-_;\s])(archived|deleted|historical|obsolete|retired|superseded)(?:$|[-_;\s])/iu;
const REQUIRED_SNAPSHOT_FIELDS = Object.freeze(["title", "date", "type", "status"]);
const CURRENT_SECTION_HEADING = /^## Current authoritative\b/imu;
const CURRENT_STATUS_PATH = "docs/current-status.md";
const FULL_COMMIT_IDENTITY = /^[0-9a-f]{40}$/u;
const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DOCUMENTATION_REFERENCE = /(?<![A-Za-z0-9_./-])((?:(?:\.\.?\/)+)?docs\/[A-Za-z0-9._~%+@/-]+\.(?:md|png|jpe?g))(?![A-Za-z0-9])/giu;
const SOURCE_REFERENCE_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".mjs",
  ".mts",
  ".plist",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const SOURCE_REFERENCE_ROOTS = Object.freeze([
  ".github/",
  "apps/",
  "config/",
  "generated/",
  "local-review/",
  "native/",
  "packages/",
  "schemas/",
  "scripts/",
  "src/",
  "tools/",
]);
const ROOT_SOURCE_CONFIGURATION = new Set([
  "package.json",
  "pnpm-workspace.yaml",
]);

function repositoryPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function trimLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  } else {
    const title = /^(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))\s*$/u.exec(target);
    if (title) target = title[1];
  }
  return target.replaceAll("\\(", "(").replaceAll("\\)", ")");
}

function stripInlineCode(line) {
  let output = "";
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      output += line[index];
      index += 1;
      continue;
    }
    let markerLength = 1;
    while (line[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closing = line.indexOf(marker, index + markerLength);
    if (closing === -1) {
      output += line.slice(index);
      break;
    }
    output += " ".repeat(closing + markerLength - index);
    index = closing + markerLength;
  }
  return output;
}

function markdownContentLines(contents) {
  const lines = contents.split("\n");
  const visible = [];
  let fence = null;
  let inComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0]
          && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      visible.push("");
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      visible.push("");
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      visible.push("");
      continue;
    }

    let cleaned = "";
    for (let cursor = 0; cursor < line.length;) {
      if (inComment) {
        const close = line.indexOf("-->", cursor);
        if (close === -1) {
          cursor = line.length;
          continue;
        }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = line.indexOf("<!--", cursor);
      if (open === -1) {
        cleaned += line.slice(cursor);
        break;
      }
      cleaned += line.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }
    line = stripInlineCode(cleaned);
    visible.push(line);
  }
  return visible;
}

function matchingClosingParenthesis(line, start) {
  let depth = 0;
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function markdownLinks(contents) {
  const links = [];
  for (const [lineIndex, line] of markdownContentLines(contents).entries()) {
    const inlineStart = /!?\[[^\]]*\]\(/gu;
    for (const match of line.matchAll(inlineStart)) {
      const opening = match.index + match[0].length - 1;
      const closing = matchingClosingParenthesis(line, opening);
      if (closing === -1) continue;
      links.push(Object.freeze({
        line: lineIndex + 1,
        target: trimLinkTarget(line.slice(opening + 1, closing)),
      }));
    }

    const reference = /^\s*\[(?!\^)[^\]]+\]:\s*(.+?)\s*$/u.exec(line);
    if (reference) {
      links.push(Object.freeze({
        line: lineIndex + 1,
        target: trimLinkTarget(reference[1]),
      }));
    }
  }
  return Object.freeze(links);
}

function decodeEntity(value) {
  return value
    .replaceAll(/&amp;/giu, "&")
    .replaceAll(/&lt;/giu, "<")
    .replaceAll(/&gt;/giu, ">");
}

function headingText(value) {
  return decodeEntity(value)
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll(/[`*_~]/gu, "")
    .trim();
}

function githubHeadingSlug(value) {
  return headingText(value)
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replaceAll(" ", "-");
}

export function markdownAnchors(contents) {
  const anchors = new Set();
  const slugCounts = new Map();
  const lines = markdownContentLines(contents);

  function addHeading(value) {
    const base = githubHeadingSlug(value);
    if (base.length === 0) return;
    const count = slugCounts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    slugCounts.set(base, count + 1);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const atx = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/u.exec(line);
    if (atx) addHeading(atx[1]);
    if (index > 0 && /^\s{0,3}(?:=+|-+)\s*$/u.test(line)) {
      addHeading(lines[index - 1]);
    }
    for (const match of line.matchAll(/<(?:a\s+(?:[^>]*?\s)?(?:id|name)|[A-Za-z][\w:-]*\s+(?:[^>]*?\s)?id)\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

export function parseFrontmatter(contents) {
  if (!contents.startsWith("---\n")) return null;
  const closing = contents.indexOf("\n---\n", 4);
  if (closing === -1) return null;
  const fields = new Map();
  for (const line of contents.slice(4, closing).split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(line);
    if (field) fields.set(field[1], field[2].replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2"));
  }
  return fields;
}

function currentAuthorityTargets(contents) {
  const section = CURRENT_SECTION_HEADING.exec(contents);
  if (!section) return [];
  const afterHeading = contents.indexOf("\n", section.index);
  const nextHeading = contents.slice(afterHeading + 1).search(/^##\s+/mu);
  const end = nextHeading === -1
    ? contents.length
    : afterHeading + 1 + nextHeading;
  const targets = [];
  for (const link of markdownLinks(contents.slice(afterHeading + 1, end))) {
    if (link.target === "" || EXTERNAL_TARGET.test(link.target)) continue;
    try {
      const decodedPath = decodeURIComponent(targetParts(link.target).path);
      if (decodedPath.endsWith(".md")) targets.push(link.target);
    } catch {
      // The ordinary link-validation pass reports malformed URL encoding with
      // the source line. Do not turn that malformed target into an authority.
    }
  }
  return [...new Set(targets)];
}

function targetParts(target) {
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  const boundary = [hash, query].filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), target.length);
  return Object.freeze({
    path: target.slice(0, boundary),
    anchor: hash >= 0 ? target.slice(hash + 1) : "",
  });
}

function resolveLocalTarget(root, sourceFile, target) {
  const decoded = decodeURIComponent(target);
  if (decoded === "") return sourceFile;
  if (decoded.startsWith("/")) return resolve(root, `.${decoded}`);
  return resolve(dirname(sourceFile), decoded);
}

function validCalendarDate(value) {
  const match = ISO_CALENDAR_DATE.exec(value ?? "");
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateCurrentStatusSource(root, contents, failures) {
  const frontmatter = parseFrontmatter(contents);
  const sourceCommit = frontmatter?.get("source_commit")?.trim() ?? "";
  const observationDate = frontmatter?.get("observation_date")?.trim() ?? "";
  const documentDate = frontmatter?.get("date")?.trim() ?? "";

  if (!documentDate) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      "current status requires non-empty date frontmatter",
    );
  } else if (!validCalendarDate(documentDate)) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      `current status date is not a valid calendar date: ${documentDate}`,
    );
  }

  if (!observationDate) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      "current status requires non-empty observation_date frontmatter",
    );
  } else {
    if (!validCalendarDate(observationDate)) {
      addFailure(
        failures,
        CURRENT_STATUS_PATH,
        1,
        `observation_date is not a valid calendar date: ${observationDate}`,
      );
    }
    if (documentDate && observationDate !== documentDate) {
      addFailure(
        failures,
        CURRENT_STATUS_PATH,
        1,
        `observation_date ${observationDate} does not match frontmatter date ${documentDate}`,
      );
    }
  }

  if (!sourceCommit) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      "current status requires non-empty source_commit frontmatter",
    );
    return;
  }
  if (!FULL_COMMIT_IDENTITY.test(sourceCommit)) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      `source_commit must be an exact lowercase 40-character commit identity: ${sourceCommit}`,
    );
    return;
  }

  let resolvedCommit;
  try {
    const { stdout } = await execFile("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      `${sourceCommit}^{commit}`,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    resolvedCommit = stdout.trim();
  } catch {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      `source_commit does not resolve to a local commit: ${sourceCommit}`,
    );
    return;
  }
  if (resolvedCommit !== sourceCommit) {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      `source_commit did not resolve exactly: ${sourceCommit}`,
    );
    return;
  }

  try {
    await execFile("git", [
      "-C",
      root,
      "merge-base",
      "--is-ancestor",
      sourceCommit,
      "HEAD",
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch {
    addFailure(
      failures,
      CURRENT_STATUS_PATH,
      1,
      `source_commit is not an ancestor of HEAD: ${sourceCommit}`,
    );
  }
}

async function trackedMarkdownFiles(root) {
  const { stdout } = await execFile("git", [
    "-C",
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.md",
    ":(glob)**/*.md",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).sort();
}

function isTestOrFixturePath(path) {
  const segments = path.split("/");
  return segments.some((segment) =>
    segment === "test"
    || segment === "tests"
    || segment === "fixture"
    || segment === "fixtures"
    || segment === "__fixtures__")
    || /(?:^|\.)\b(?:spec|test)\.[^.]+$/u.test(basename(path));
}

function isSourceReferencePath(path) {
  if (isTestOrFixturePath(path) || path.endsWith(".md")) return false;
  if (!ROOT_SOURCE_CONFIGURATION.has(path)
      && !SOURCE_REFERENCE_ROOTS.some((root) => path.startsWith(root))) {
    return false;
  }
  const extension = posix.extname(path).toLowerCase();
  return SOURCE_REFERENCE_EXTENSIONS.has(extension)
    || basename(path) === "CODEOWNERS"
    || basename(path) === "Dockerfile";
}

async function trackedSourceReferenceFiles(root) {
  const { stdout } = await execFile("git", [
    "-C",
    root,
    "ls-files",
    "--cached",
    "-z",
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.split("\0").filter(isSourceReferencePath).sort();
}

function documentationReferences(contents) {
  const references = [];
  for (const [lineIndex, line] of contents.split("\n").entries()) {
    for (const match of line.matchAll(DOCUMENTATION_REFERENCE)) {
      references.push(Object.freeze({ line: lineIndex + 1, target: match[1] }));
    }
  }
  return references;
}

async function validateSourceReferences({
  root,
  paths,
  failures,
}) {
  let checkedFiles = 0;
  for (const path of paths.filter(isSourceReferencePath)) {
    const sourceFile = resolve(root, path);
    const sourceRelative = repositoryPath(root, sourceFile);
    if (sourceRelative === ".." || sourceRelative.startsWith("../")) {
      addFailure(failures, path, null, "source reference path escapes the repository");
      continue;
    }
    const sourceMetadata = await lstatIfPresent(sourceFile);
    if (sourceMetadata === null) continue;
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      addFailure(failures, path, null, "tracked source/config is not a regular file");
      continue;
    }
    checkedFiles += 1;
    const contents = await readFile(sourceFile, "utf8");
    for (const reference of documentationReferences(contents)) {
      let decoded;
      try {
        decoded = decodeURIComponent(reference.target);
      } catch {
        addFailure(
          failures,
          path,
          reference.line,
          `hardcoded documentation target is not valid URL encoding: ${reference.target}`,
        );
        continue;
      }
      const selected = decoded.startsWith("docs/")
        ? resolve(root, decoded)
        : resolve(dirname(sourceFile), decoded);
      const selectedRelative = repositoryPath(root, selected);
      if (selectedRelative === ".." || selectedRelative.startsWith("../")) {
        addFailure(
          failures,
          path,
          reference.line,
          `hardcoded documentation target escapes the repository: ${reference.target}`,
        );
        continue;
      }
      const metadata = await lstatIfPresent(selected);
      if (metadata === null) {
        addFailure(
          failures,
          path,
          reference.line,
          `hardcoded documentation target does not exist: ${reference.target}`,
        );
      } else if (!metadata.isFile() || metadata.isSymbolicLink()) {
        addFailure(
          failures,
          path,
          reference.line,
          `hardcoded documentation target is not a regular file: ${reference.target}`,
        );
      }
    }
  }
  return checkedFiles;
}

function addFailure(failures, path, line, message) {
  failures.push(`${path}${line === null ? "" : `:${line}`}: ${message}`);
}

export async function validateDocumentation({
  root = REPOSITORY_ROOT,
  files,
  sourceFiles,
  linksOnly = false,
} = {}) {
  const selectedRoot = resolve(root);
  const markdownPaths = files ?? await trackedMarkdownFiles(selectedRoot);
  const sourceReferencePaths = sourceFiles
    ?? (files === undefined ? await trackedSourceReferenceFiles(selectedRoot) : []);
  const failures = [];
  const contentsByPath = new Map();
  const anchorsByPath = new Map();

  for (const path of markdownPaths) {
    const selected = resolve(selectedRoot, path);
    if (repositoryPath(selectedRoot, selected).startsWith("../")) {
      addFailure(failures, path, null, "documentation path escapes the repository");
      continue;
    }
    const metadata = await lstatIfPresent(selected);
    // `git ls-files --cached` still reports an unstaged deletion. Treat the
    // absent source as removed; any surviving inbound link will fail when its
    // target is checked below. This keeps `git rm` and an unstaged deletion
    // equivalent for the read-only gate without hiding dangling references.
    if (metadata === null) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      addFailure(failures, path, null, "tracked documentation is not a regular file");
      continue;
    }
    const contents = await readFile(selected, "utf8");
    contentsByPath.set(repositoryPath(selectedRoot, selected), contents);
  }

  for (const [path, contents] of contentsByPath) {
    const sourceFile = resolve(selectedRoot, path);
    for (const link of markdownLinks(contents)) {
      if (link.target === "" || EXTERNAL_TARGET.test(link.target)) continue;
      let parts;
      let selected;
      try {
        parts = targetParts(link.target);
        selected = resolveLocalTarget(selectedRoot, sourceFile, parts.path);
      } catch {
        addFailure(failures, path, link.line, `link target is not valid URL encoding: ${link.target}`);
        continue;
      }
      const selectedRelative = repositoryPath(selectedRoot, selected);
      if (selectedRelative === ".." || selectedRelative.startsWith("../")
          || isAbsolute(parts.path) && !parts.path.startsWith("/")) {
        addFailure(failures, path, link.line, `local link escapes the repository: ${link.target}`);
        continue;
      }
      const metadata = await lstatIfPresent(selected);
      if (metadata === null) {
        addFailure(failures, path, link.line, `local link target does not exist: ${link.target}`);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        addFailure(failures, path, link.line, `local link target must not be a symbolic link: ${link.target}`);
        continue;
      }
      if (parts.anchor === "" || !metadata.isFile()) continue;
      if (!selectedRelative.endsWith(".md")) {
        if (!/^L\d+(?:-L\d+)?$/u.test(parts.anchor)) {
          addFailure(failures, path, link.line, `cannot verify anchor on a non-Markdown target: ${link.target}`);
        }
        continue;
      }
      let anchors = anchorsByPath.get(selectedRelative);
      if (!anchors) {
        const selectedContents = contentsByPath.get(selectedRelative)
          ?? await readFile(selected, "utf8");
        anchors = markdownAnchors(selectedContents);
        anchorsByPath.set(selectedRelative, anchors);
      }
      let decodedAnchor;
      try {
        decodedAnchor = decodeURIComponent(parts.anchor);
      } catch {
        addFailure(failures, path, link.line, `anchor is not valid URL encoding: ${link.target}`);
        continue;
      }
      if (!anchors.has(decodedAnchor)) {
        addFailure(failures, path, link.line, `Markdown anchor does not exist: ${link.target}`);
      }
    }
  }

  const checkedSourceFiles = await validateSourceReferences({
    root: selectedRoot,
    paths: sourceReferencePaths,
    failures,
  });

  if (!linksOnly) {
    for (const [path, contents] of contentsByPath) {
      if (!path.startsWith("docs/")) continue;
      const dated = DATED_DOCUMENT.exec(basename(path));
      if (!dated) continue;
      if (!validCalendarDate(dated[1])) {
        addFailure(failures, path, 1, `filename date is not a valid calendar date: ${dated[1]}`);
      }
      const frontmatter = parseFrontmatter(contents);
      if (frontmatter === null) {
        addFailure(failures, path, 1, "dated retained documentation requires YAML frontmatter");
        continue;
      }
      for (const field of REQUIRED_SNAPSHOT_FIELDS) {
        if (!(frontmatter.get(field)?.trim())) {
          addFailure(failures, path, 1, `dated retained documentation requires non-empty ${field} frontmatter`);
        }
      }
      const frontmatterDate = frontmatter.get("date")?.trim() ?? "";
      if (frontmatterDate && !validCalendarDate(frontmatterDate)) {
        addFailure(
          failures,
          path,
          1,
          `frontmatter date is not a valid calendar date: ${frontmatterDate}`,
        );
      }
      if (frontmatterDate && frontmatterDate !== dated[1]) {
        addFailure(
          failures,
          path,
          1,
          `frontmatter date ${frontmatterDate} does not match filename date ${dated[1]}`,
        );
      }
    }

    const currentStatusContents = contentsByPath.get(CURRENT_STATUS_PATH);
    if (currentStatusContents) {
      await validateCurrentStatusSource(selectedRoot, currentStatusContents, failures);
    }

    const indexPath = "docs/README.md";
    const indexContents = contentsByPath.get(indexPath);
    if (!indexContents) {
      addFailure(failures, indexPath, null, "current documentation authority index is missing");
    } else {
      const rawTargets = currentAuthorityTargets(indexContents);
      if (rawTargets.length === 0) {
        addFailure(failures, indexPath, null, "current authoritative section has no Markdown targets");
      }
      const authorities = new Set();
      for (const rawTarget of rawTargets) {
        let absolute;
        try {
          absolute = resolveLocalTarget(
            selectedRoot,
            resolve(selectedRoot, indexPath),
            targetParts(rawTarget).path,
          );
        } catch {
          // The link pass already reports malformed URL encoding with its line.
          continue;
        }
        const target = repositoryPath(selectedRoot, absolute);
        if (target === ".." || target.startsWith("../")) continue;
        authorities.add(target);
        const targetContents = contentsByPath.get(target);
        if (!targetContents) {
          addFailure(failures, indexPath, null, `current authority is missing: ${rawTarget}`);
          continue;
        }
        const frontmatter = parseFrontmatter(targetContents);
        const status = frontmatter?.get("status")?.trim() ?? "";
        if (!status) {
          addFailure(failures, target, 1, "current authority requires non-empty status frontmatter");
        } else if (OBSOLETE_AUTHORITY_STATUS.test(status)) {
          addFailure(failures, target, 1, `obsolete status cannot be current authority: ${status}`);
        }
      }
      for (const [path, contents] of contentsByPath) {
        if (!path.startsWith("docs/") || path === indexPath) continue;
        const status = parseFrontmatter(contents)?.get("status")?.trim().toLowerCase();
        if (status && CURRENT_AUTHORITY_STATUSES.has(status) && !authorities.has(path)) {
          addFailure(failures, path, 1, `status ${status} requires listing in docs/README.md current authorities`);
        }
      }
    }
  }

  return Object.freeze({
    checkedFiles: contentsByPath.size,
    checkedSourceFiles,
    failures: Object.freeze(failures.sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }))),
  });
}

function usage() {
  console.log(`Usage: node tools/operations/validate-documentation.mjs [--links-only]

Checks every tracked or unignored Markdown file. Local link targets and Markdown
anchors must exist. The full check also validates dated-record frontmatter and
the current-authority section in docs/README.md.`);
}

export async function main(argv = process.argv.slice(2)) {
  let linksOnly = false;
  for (const argument of argv) {
    if (argument === "--links-only") linksOnly = true;
    else if (argument === "--help" || argument === "-h") {
      usage();
      return;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  const result = await validateDocumentation({ linksOnly });
  if (result.failures.length > 0) {
    throw new Error(
      `documentation validation failed with ${result.failures.length} issue(s):\n`
      + result.failures.map((failure) => `- ${failure}`).join("\n"),
    );
  }
  console.log(
    `Documentation ${linksOnly ? "links" : "governance"} valid across `
      + `${result.checkedFiles} Markdown files and ${result.checkedSourceFiles} source/config files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(`validate-documentation: ${error.message}`);
    process.exitCode = 1;
  });
}
