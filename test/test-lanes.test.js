import assert from "node:assert/strict";
import test from "node:test";
import {
  MACOS_TRANSITION_TEST_FILES,
  mergeChangedPaths,
  parseTestLaneArguments,
  selectTestLanes,
  hostedLaneCommands,
} from "../scripts/test-lanes.mjs";
import {
  PORTABLE_TEST_FILES,
  PORTABLE_TEST_GROUPS,
} from "../scripts/portable-test-manifest.mjs";

test("transition lane retains every incoming Sparkle contract target", () => {
  assert.deepEqual(MACOS_TRANSITION_TEST_FILES, [
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-updater.test.js",
    "test/electron-sparkle-transition.test.js",
    "test/generate-sparkle-appcast-stable-feed.test.js",
    "test/sparkle-signed-feed-validation.test.js",
    "test/sparkle-remote-inspection.test.js",
    "test/publish-sparkle-update.test.js",
  ]);
});

test("portable manifest is explicit, unique, and excludes native release gates", () => {
  assert.equal(PORTABLE_TEST_FILES.length, new Set(PORTABLE_TEST_FILES).size);
  assert.deepEqual(
    PORTABLE_TEST_FILES,
    Object.values(PORTABLE_TEST_GROUPS).flat(),
  );
  assert.equal(PORTABLE_TEST_FILES.includes("apps/local/server.test.mjs"), true);
  assert.equal(PORTABLE_TEST_FILES.includes("apps/web/test/lib.test.mjs"), true);
  assert.equal(PORTABLE_TEST_FILES.includes("test/accounting-package-parity.test.js"), true);
  for (const path of PORTABLE_TEST_FILES) {
    assert.doesNotMatch(path, /(?:^|\/)macos-|sparkle|release-site/u);
  }
});

test("test-lane arguments retain explicit paths and reject ambiguous input", () => {
  assert.deepEqual(
    parseTestLaneArguments([
      "changed",
      "--base",
      "origin/main",
      "--full",
      "--path",
      "scripts/electron-sparkle-transition.js",
      "--path",
      "apps/web/public/app.js",
    ]),
    {
      command: "changed",
      base: "origin/main",
      full: true,
      paths: [
        "scripts/electron-sparkle-transition.js",
        "apps/web/public/app.js",
      ],
    },
  );
  assert.deepEqual(
    parseTestLaneArguments(["--help"]),
    { command: "help", base: null, full: false, paths: [] },
  );
  assert.deepEqual(
    parseTestLaneArguments(["i18n"]),
    { command: "i18n", base: null, full: false, paths: [] },
  );
  for (const argv of [
    ["changed", "--unexpected"],
    ["unknown"],
    ["changed", "--path", "--full"],
    ["changed", "--path", ""],
    ["changed", "--path", "../outside.md"],
    ["changed", "--path", "/outside.md"],
    ["changed", "--base", ""],
    ["macos-transition", "--path", "scripts/electron-sparkle-transition.js"],
    ["portable", "--path", "apps/local/server.js"],
  ]) {
    assert.throws(() => parseTestLaneArguments(argv));
  }
});

test("changed-path merger retains branch, active-worktree, and untracked entries", () => {
  assert.deepEqual(
    mergeChangedPaths([
      "scripts/electron-sparkle-transition.js\0README.md\0",
      "README.md\0scripts/test-lanes.mjs\0",
      "test/new-untracked.test.js\0",
    ]),
    [
      "README.md",
      "scripts/electron-sparkle-transition.js",
      "scripts/test-lanes.mjs",
      "test/new-untracked.test.js",
    ],
  );
});

test("test-lane selection narrows only paths with complete executable coverage", () => {
  for (const path of [
    "scripts/electron-sparkle-transition.js",
    "scripts/prepare-sparkle-framework.js",
    "scripts/macos-release-core.js",
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-updater.test.js",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["macos-transition"], path);
  }
  assert.deepEqual(
    selectTestLanes(["scripts/electron-sparkle-transition.js"], { full: true }).lanes,
    ["full"],
  );
  assert.deepEqual(selectTestLanes(["packages/i18n/index.js"]).lanes, ["i18n"]);
  for (const path of [
    "scripts/generate-i18n-browser-mirror.js",
    "scripts/generate-i18n-electron-copy.js",
    "apps/electron/desktop-copy-source.js",
    "apps/electron/desktop-copy.js",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["i18n"], path);
  }
  for (const path of [
    "apps/web/public/app.js",
    "apps/local/server.js",
    "config/product-brand.js",
    "scripts/lib/sparkle-remote-inspection.mjs",
    "scripts/test-lanes.mjs",
    "scripts/unknown-new-tool.mjs",
    "src/unmapped-product-path.js",
    "../critical.md",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["full"], path);
  }
  assert.deepEqual(selectTestLanes(["docs/decisions/example.md"]).lanes, []);
});

test("hosted lanes execute complete owning gates and unfamiliar or shared inputs stay broad", () => {
  for (const path of ["apps/worker/src/index.ts", "apps/worker/test/health.test.ts", "apps/worker/migrations/0057_synthetic.sql", "apps/worker/wrangler.jsonc"])
    assert.deepEqual(selectTestLanes([path]).lanes, ["worker"]);
  assert.deepEqual(selectTestLanes(["scripts/build-public-release-site.js"]).lanes, ["public-site"]);
  assert.deepEqual(selectTestLanes(["scripts/build-public-release-site.js", "apps/worker/src/index.ts"]).lanes, ["public-site"]);
  for (const path of ["apps/worker/scripts/new-tool.mjs", "apps/worker/new-fixtures/source.json", "apps/web/public/community.js", "config/release-manifest.js"])
    assert.deepEqual(selectTestLanes([path]).lanes, ["full"]);
  assert.deepEqual(selectTestLanes(["apps/worker/src/index.ts"], { full: true }).lanes, ["full"]);
  assert.deepEqual(selectTestLanes(["docs/example.md"], { full: true }).lanes, ["full"]);
  assert.deepEqual(hostedLaneCommands("worker"), [["--prefix", "apps/worker", "run", "check"]]);
  assert.deepEqual(hostedLaneCommands("public-site"), [["run", "product:ui:test"], ["run", "product:release-site:test"], ["--prefix", "apps/worker", "run", "check"]]);
  assert.equal(hostedLaneCommands("not-a-lane"), null);
});
