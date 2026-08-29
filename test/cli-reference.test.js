import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIRECTORY, "..");

async function repositoryFile(path) {
  return readFile(join(ROOT, path), "utf8");
}

function usageLines(source) {
  const match = /function usage\(\) \{\s*console\.log\(`Usage:\n([\s\S]*?)\n`\);\s*\}/u.exec(source);
  assert.ok(match, "CLI usage template is missing");
  return match[1].split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("usage-monitor "));
}

function documentedUsageLines(markdown) {
  const section = /## Exact invocation synopsis\s+```text\n([\s\S]*?)\n```/u.exec(markdown);
  assert.ok(section, "CLI reference synopsis is missing");
  return section[1].split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("usage-monitor "));
}

test("maintained CLI reference exactly mirrors every CLI invocation", async () => {
  const [source, markdown, packageSource] = await Promise.all([
    repositoryFile("src/cli.js"),
    repositoryFile("docs/reference/cli-reference.md"),
    repositoryFile("package.json"),
  ]);
  const sourceUsage = usageLines(source);
  assert.equal(sourceUsage.length, 44, "review unexpected CLI surface change");
  assert.deepEqual(documentedUsageLines(markdown), sourceUsage);
  assert.equal(
    Object.hasOwn(JSON.parse(packageSource).scripts, "register-account"),
    false,
    "dead register-account package entrypoint must not return",
  );
});
