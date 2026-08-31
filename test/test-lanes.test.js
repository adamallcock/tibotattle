import assert from "node:assert/strict";
import test from "node:test";
import {
  MACOS_ARTIFACT_TEST_FILES,
  MACOS_SMOKE_TEST_FILES,
  MACOS_SOURCE_TEST_FILES,
  mergeChangedPaths,
  parseTestLaneArguments,
  selectTestLanes,
} from "../scripts/test-lanes.mjs";
import {
  PORTABLE_TEST_FILES,
  PORTABLE_TEST_GROUPS,
} from "../scripts/portable-test-manifest.mjs";

test("lane manifests include every executable macOS test target", () => {
  assert.deepEqual(MACOS_SOURCE_TEST_FILES, [
    "test/i18n-foundation.test.js",
    "test/macos-localization.test.js",
    "test/macos-app-bundle.test.js",
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-keychain-migration-runner.test.js",
    "test/macos-keychain-migration-ui.test.js",
  ]);
  assert.deepEqual(MACOS_ARTIFACT_TEST_FILES, [
    "test/macos-app-bundle.test.js",
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-keychain-migration-runner.test.js",
    "test/macos-keychain-migration-ui.test.js",
    "test/macos-updater.test.js",
    "test/macos-updater-release.test.mjs",
  ]);
  assert.deepEqual(MACOS_SMOKE_TEST_FILES, [
    "test/macos-test-build.test.mjs",
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
      "apps/macos/UsageMonitorApp.swift",
      "--path",
      "apps/web/public/app.js",
    ]),
    {
      command: "changed",
      base: "origin/main",
      full: true,
      paths: [
        "apps/macos/UsageMonitorApp.swift",
        "apps/web/public/app.js",
      ],
    },
  );
  assert.deepEqual(
    parseTestLaneArguments(["--help"]),
    { command: "help", base: null, full: false, paths: [] },
  );
  for (const argv of [
    ["changed", "--unexpected"],
    ["unknown"],
    ["changed", "--path", "--full"],
    ["changed", "--path", ""],
    ["changed", "--path", "../outside.md"],
    ["changed", "--path", "/outside.md"],
    ["changed", "--base", ""],
    ["macos-source", "--path", "apps/macos/UsageMonitorApp.swift"],
    ["portable", "--path", "apps/local/server.js"],
  ]) {
    assert.throws(() => parseTestLaneArguments(argv));
  }
});

test("changed-path merger retains branch, active-worktree, and untracked entries", () => {
  assert.deepEqual(
    mergeChangedPaths([
      "apps/macos/UsageMonitorApp.swift\0README.md\0",
      "README.md\0scripts/test-lanes.mjs\0",
      "test/new-untracked.test.js\0",
    ]),
    [
      "README.md",
      "apps/macos/UsageMonitorApp.swift",
      "scripts/test-lanes.mjs",
      "test/new-untracked.test.js",
    ],
  );
});

test("test-lane selection narrows only paths with complete executable coverage", () => {
  assert.deepEqual(
    selectTestLanes(["apps/macos/UsageMonitorApp.swift"]),
    {
      lanes: ["macos-source", "macos-smoke"],
      paths: ["apps/macos/UsageMonitorApp.swift"],
      unknownPaths: [],
    },
  );
  assert.deepEqual(
    selectTestLanes(["apps/macos/UsageMonitorApp.swift"], { full: true }).lanes,
    ["macos-source", "macos-smoke", "macos-artifact"],
  );
  assert.deepEqual(
    selectTestLanes(["apps/macos/Assets/AppIcon.icns"]).lanes,
    ["macos-source", "macos-smoke", "macos-artifact"],
  );
  assert.deepEqual(
    selectTestLanes(["scripts/build-macos-app.js"]).lanes,
    ["macos-source", "macos-smoke", "macos-artifact"],
  );
  assert.deepEqual(
    selectTestLanes(["scripts/prepare-sparkle-framework.js"]).lanes,
    ["macos-artifact"],
  );
  assert.deepEqual(
    selectTestLanes(["test/macos-app-bundle.test.js"]).lanes,
    ["macos-source", "macos-artifact"],
  );
  for (const path of [
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-keychain-migration-runner.test.js",
    "test/macos-keychain-migration-ui.test.js",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes,
      ["macos-source", "macos-artifact"], path);
  }
  assert.deepEqual(
    selectTestLanes(["test/macos-updater.test.js"]).lanes,
    ["macos-artifact"],
  );
  assert.deepEqual(
    selectTestLanes(["test/macos-test-build.test.mjs"]).lanes,
    ["macos-smoke"],
  );
  assert.deepEqual(
    selectTestLanes(["packages/i18n/index.js"]).lanes,
    ["i18n"],
  );
  for (const path of [
    "apps/web/public/app.js",
    "apps/local/server.js",
    "config/product-brand.js",
    "scripts/macos-release-core.js",
    "scripts/test-lanes.mjs",
    "scripts/benchmark-test-lanes.mjs",
    "test/macos-preview-install.test.js",
    "src/unmapped-product-path.js",
    "../critical.md",
  ]) {
    assert.deepEqual(
      selectTestLanes([path]).lanes,
      ["full"],
      path,
    );
  }
  assert.deepEqual(
    selectTestLanes(["docs/decisions/example.md"]).lanes,
    [],
  );
});
