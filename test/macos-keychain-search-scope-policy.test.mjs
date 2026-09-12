import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER = join(ROOT, "native/macos-keychain/search-scope-policy.h");
const ADAPTER = join(ROOT, "native/macos-keychain/macos-keychain.mm");

test("search-scope absence policy accepts only the readable standard System Keychain exception", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "macos-keychain-search-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "policy-test.cc");
  const executable = join(directory, "policy-test");
  await writeFile(source, `#include <cassert>\n#include \"native/macos-keychain/search-scope-policy.h\"\n\nusing namespace tibotattle::macos_keychain;\n\nint main() {\n  const char system[] = \"/Library/Keychains/System.keychain\";\n  const char spoof[] = \"/Library/Keychains/System.keychain.backup\";\n  const char user[] = \"/Users/synthetic/Library/Keychains/login.keychain-db\";\n  assert(ClassifySearchScopeMemberPath(system, sizeof(system) - 1) == SearchScopeMemberPath::kStandardSystem);\n  assert(ClassifySearchScopeMemberPath(spoof, sizeof(spoof) - 1) == SearchScopeMemberPath::kOther);\n  assert(ClassifySearchScopeMemberPath(user, sizeof(user) - 1) == SearchScopeMemberPath::kOther);\n  assert(ClassifySearchScopeMemberPath(nullptr, 0) == SearchScopeMemberPath::kUnknown);\n  assert(ClassifySearchScopeMemberForAbsence(true, true, SearchScopeMemberPath::kOther) == SearchScopeMemberStatus::kPresent);\n  assert(ClassifySearchScopeMemberForAbsence(false, true, SearchScopeMemberPath::kStandardSystem) == SearchScopeMemberStatus::kPresent);\n  assert(ClassifySearchScopeMemberForAbsence(false, true, SearchScopeMemberPath::kOther) == SearchScopeMemberStatus::kLocked);\n  assert(ClassifySearchScopeMemberForAbsence(false, true, SearchScopeMemberPath::kUnknown) == SearchScopeMemberStatus::kUnknown);\n  assert(ClassifySearchScopeMemberForAbsence(false, false, SearchScopeMemberPath::kStandardSystem) == SearchScopeMemberStatus::kDenied);\n}\n`);
  const result = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "clang++", "-std=c++17", "-I", ROOT,
    source, "-o", executable], { encoding: "utf8", maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(executable, [], { encoding: "utf8", maxBuffer: 64 * 1024 });
  assert.equal(run.status, 0, run.stderr);
});

test("adapter binds the exception to the post-not-found absence path", async () => {
  const [header, adapter] = await Promise.all([readFile(HEADER, "utf8"), readFile(ADAPTER, "utf8")]);
  assert.match(header, /kStandardSystemKeychainPath\[\] = "\/Library\/Keychains\/System\.keychain"/u);
  assert.match(header, /length == expected/u);
  assert.match(header, /std::memcmp\(path, kStandardSystemKeychainPath, expected\)/u);
  assert.match(header, /if \(!readable\) return SearchScopeMemberStatus::kDenied/u);
  assert.match(header, /if \(path == SearchScopeMemberPath::kUnknown\)/u);
  const absence = adapter.slice(
    adapter.indexOf("ItemStatus KeychainStatusForAbsenceNoInteraction"),
    adapter.indexOf("ItemStatus SearchScopeStatusForAbsenceNoInteraction"),
  );
  assert.match(absence, /SecKeychainGetPath\(/u);
  assert.match(absence, /ClassifySearchScopeMemberPath/u);
  assert.match(absence, /ClassifySearchScopeMemberForAbsence/u);
  const defaultCreation = adapter.slice(
    adapter.indexOf("ItemStatus DefaultKeychainStatusForNewItemNoInteraction"),
    adapter.indexOf("ItemStatus SearchScopeStatusForAbsenceNoInteraction"),
  );
  assert.match(defaultCreation, /kSecUnlockStateStatus\) == 0\) return ItemStatus::kLocked/u);
  assert.match(defaultCreation, /kSecReadPermStatus\) == 0\) return ItemStatus::kDenied/u);
  assert.doesNotMatch(defaultCreation, /ClassifySearchScopeMemberForAbsence/u);
  const creation = adapter.slice(
    adapter.indexOf("ItemStatus CaptureDefaultKeychainForNewItemNoInteraction"),
    adapter.indexOf("ItemStatus ItemPresenceNoInteraction"),
  );
  assert.match(creation, /DefaultKeychainStatusForNewItemNoInteraction\(default_keychain\)/u);
  assert.doesNotMatch(creation, /KeychainStatusForAbsenceNoInteraction\(default_keychain\)/u);
  const read = adapter.slice(
    adapter.indexOf("ReadResult ReadModernSecret"),
    adapter.indexOf("ItemStatus InspectModernSecret"),
  );
  assert.ok(read.indexOf("if (status == errSecItemNotFound)")
    < read.indexOf("SearchScopeStatusForAbsenceNoInteraction"));
});
