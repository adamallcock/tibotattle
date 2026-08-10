#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const skipDirs = new Set([
  ".git",
  ".release-build",
  ".release-deps",
  ".release-repro",
  ".wrangler",
  ".build",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const textExtensions = new Set([".md", ".js", ".mjs", ".ts", ".json", ".html"]);

function rejectSymlink(entry, path) {
  if (entry.isSymbolicLink()) {
    throw new Error(
      `Documentation link maintenance refuses symbolic link: ${
        relative(ROOT, path).replaceAll("\\", "/")
      }`,
    );
  }
}

const docIndex = new Map();
function walkDocs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    rejectSymlink(entry, full);
    if (entry.isDirectory()) walkDocs(full);
    else if (
      entry.isFile()
      && entry.name.startsWith("2026-07-")
      && entry.name.endsWith(".md")
    ) {
      docIndex.set(entry.name, full.slice(ROOT.length + 1));
    }
  }
}
walkDocs(join(ROOT, "docs"));

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    rejectSymlink(entry, full);
    if (entry.isDirectory()) walk(full, files);
    else if (
      entry.isFile()
      && textExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))
    ) {
      files.push(full);
    }
  }
  return files;
}

function relLink(fromFile, destPath) {
  let rel = relative(dirname(fromFile), join(ROOT, destPath)).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

const checkOnly = process.argv.includes("--check");

function collapseDuplicateMarkdownClosers(content) {
  return content.replace(
    /(\]\((?:\.\/|\.\.\/)*2026-07-[^)]+\.md\))\)+/gu,
    "$1",
  );
}

let fixedFiles = 0;
for (const file of walk(ROOT)) {
  let content = readFileSync(file, "utf8");
  const original = content;
  let changed = false;

  content = collapseDuplicateMarkdownClosers(content);

  const quotedPathPatterns = [
    /"((?:\.\/|\.\.\/)*)(2026-07-[^"]+\.md)"/gu,
    /'((?:\.\/|\.\.\/)*)(2026-07-[^']+\.md)'/gu,
    /`((?:\.\/|\.\.\/)*)(2026-07-[^`]+\.md)`/gu,
  ];
  const quoteCharacters = ['"', "'", "`"];
  for (const [index, pattern] of quotedPathPatterns.entries()) {
    content = content.replace(pattern, (match, _prefix, basename) => {
      const dest = docIndex.get(basename);
      if (!dest) return match;
      return `${quoteCharacters[index]}${dest}${quoteCharacters[index]}`;
    });
  }

  const mdLinkPattern = /\]\(((?:\.\/|\.\.\/)*)(2026-07-[^)]+\.md)\)/gu;
  content = content.replace(mdLinkPattern, (match, _prefix, basename) => {
    const dest = docIndex.get(basename);
    if (!dest) return match;
    const link = relLink(file, dest);
    return `](${link})`;
  });

  changed = content !== original;

  if (changed) {
    if (!checkOnly) writeFileSync(file, content);
    fixedFiles += 1;
  }
}

if (checkOnly) {
  if (fixedFiles > 0) {
    console.error(`Documentation links need repair in ${fixedFiles} files.`);
    process.exitCode = 1;
  } else {
    console.log("Documentation links are normalized.");
  }
} else {
  console.log(`Fixed links in ${fixedFiles} files.`);
}
