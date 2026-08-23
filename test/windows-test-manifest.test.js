import test from "node:test";
import assert from "node:assert/strict";

import {
  PORTABLE_TEST_FILES,
  WINDOWS_DEFERRED_TESTS,
  WINDOWS_PORTABLE_TEST_FILES,
} from "../scripts/portable-test-manifest.mjs";

test("Windows portable test deferrals are explicit, unique, and bounded", () => {
  assert.equal(WINDOWS_DEFERRED_TESTS.length, 30);
  const deferred = new Set();
  for (const entry of WINDOWS_DEFERRED_TESTS) {
    assert.deepEqual(Object.keys(entry).sort(), ["file", "reason"]);
    assert.equal(PORTABLE_TEST_FILES.includes(entry.file), true, entry.file);
    assert.equal(WINDOWS_PORTABLE_TEST_FILES.includes(entry.file), false, entry.file);
    assert.equal(deferred.has(entry.file), false, entry.file);
    assert.match(entry.reason, /Windows/u);
    assert.equal(entry.reason.length <= 160, true, entry.file);
    deferred.add(entry.file);
  }
  assert.deepEqual(
    WINDOWS_PORTABLE_TEST_FILES,
    PORTABLE_TEST_FILES.filter((file) => !deferred.has(file)),
  );
  assert.deepEqual([...deferred].sort(), [
    "apps/local/desktop-status-route.test.mjs",
    "apps/local/server.test.mjs",
    "test/claude-callback-lifecycle-owner-boundary.test.js",
    "test/claude-callback-lifecycle.test.js",
    "test/claude-callback-runtime.test.js",
    "test/claude-desktop-quota-refresh.test.js",
    "test/codex-interleaved-usage-streams.test.js",
    "test/contribution-device-capability.test.js",
    "test/contribution-device-renewal.test.js",
    "test/contribution-sync-queue.test.js",
    "test/electron-package-layout.test.js",
    "test/export-identity.test.js",
    "test/fast-mode-accounting.test.js",
    "test/local-collector-state-session.test.js",
    "test/local-collector-state.test.js",
    "test/local-companion-data.test.js",
    "test/local-companion-refresh.test.js",
    "test/local-contribution-preparation.test.js",
    "test/portable-local-companion-process.test.js",
    "test/prospective-collector-cli.test.js",
    "test/quota-track-identity.test.js",
    "test/real-local-backend-acceptance.test.js",
    "test/telemetry-contribution-builder.test.js",
    "test/tool-inventory.test.js",
    "test/weekly-pace-local-companion.test.js",
    "test/weekly-pace-refresh-integration.test.js",
    "test/windows-credential-operation-audit.test.js",
    "test/windows-filesystem-companion-instance-lease.test.js",
    "test/windows-native-presign.test.js",
    "test/windows-sqlite-state-session-contract.test.js",
  ]);
});
