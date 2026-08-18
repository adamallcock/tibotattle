import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PORTABLE_TEST_FILES } from "../scripts/portable-test-manifest.mjs";

const ledger = JSON.parse(await readFile(
  new URL("../config/windows-compatibility-ledger.json", import.meta.url),
  "utf8",
));

async function discoveredWin32Branches() {
  const discovered = new Map();
  for (const file of PORTABLE_TEST_FILES) {
    if (file === "test/windows-skip-ledger.test.js") continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const count = source.split(/\r?\n/u).filter(
      (line) => line.includes("process.platform") && line.includes("win32"),
    ).length;
    if (count > 0) discovered.set(file, count);
  }
  return discovered;
}

test("portable Windows platform branches exactly match the reviewed ledger", async () => {
  assert.equal(ledger.schemaVersion, "windows-compatibility-ledger-v0.1");
  assert.equal(ledger.scope, "portable-test-manifest");
  const declared = new Map();
  for (const entry of ledger.entries) {
    assert.equal(PORTABLE_TEST_FILES.includes(entry.file), true, entry.file);
    assert.equal(Number.isSafeInteger(entry.win32BranchCount), true, entry.file);
    assert.equal(entry.win32BranchCount > 0, true, entry.file);
    assert.match(entry.classification, /^(?:posix-only-assertion|windows-equivalent-needed|native-windows-qualification)$/u);
    assert.equal(typeof entry.followUp, "string");
    assert.equal(entry.followUp.length > 0, true);
    assert.equal(declared.has(entry.file), false, entry.file);
    declared.set(entry.file, entry.win32BranchCount);
  }
  assert.deepEqual(await discoveredWin32Branches(), declared);
});
