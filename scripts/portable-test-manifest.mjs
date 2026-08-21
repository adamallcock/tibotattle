export const PORTABLE_TEST_GROUPS = Object.freeze({
  contracts: Object.freeze([
    "test/accounting-package-boundary.test.js",
    "test/accounting-package-parity.test.js",
    "test/architecture-boundaries.test.js",
    "test/has-exact-enumerable-keys.test.js",
    "test/identity-core-package-boundary.test.js",
    "test/quota-analysis-package-boundary.test.js",
    "test/root-workspace-hygiene.test.js",
    "test/safe-validation-errors.test.js",
    "test/telemetry-contract-package.test.js",
    "test/telemetry-contract.test.js",
    "test/valid-abort-signal.test.js",
  ]),
  accountingAndAnalysis: Object.freeze([
    "test/activity-markers.test.js",
    "test/analyze.test.js",
    "test/capture.test.js",
    "test/correction-migration.test.js",
    "test/corrections.test.js",
    "test/cost-ledger.test.js",
    "test/fast-mode-accounting.test.js",
    "test/fast-mode-speed-precedence.test.js",
    "test/interval-inference.test.js",
    "test/normalization.test.js",
    "test/price-registry.test.js",
    "test/quota-track-identity.test.js",
    "test/quota-window-normalization.test.js",
    "test/shared-quota-pace-forecast.test.js",
    "test/shared-quota-rolling.test.js",
    "test/shared-quota-tracks.test.js",
    "test/shared-quota-windows.test.js",
    "test/simple-quota-gradient.test.js",
    "test/tier-semantics.test.js",
    "test/weekly-limit-history.test.js",
  ]),
  providersAndPrivacy: Object.freeze([
    "test/account-observation-secret.test.js",
    "test/account-scope.test.js",
    "test/codex-account-provider.test.js",
    "test/codex-config-service-tier-privacy.test.js",
    "test/codex-fingerprint-sidecar-privacy.test.js",
    "test/codex-interleaved-usage-streams.test.js",
    "test/codex-local-usage-analysis-boundary.test.js",
    "test/codex-log-scan-discovery.test.js",
    "test/codex-log-scan-privacy.test.js",
    "test/codex-log-scan-source-consistency.test.js",
    "test/codex-provider-log-boundary.test.js",
    "test/codex-provider-log-ports.test.js",
    "test/codex-stale-leading-quota.test.js",
    "test/export-privacy.test.js",
    "test/provider-accounting-snapshot.test.js",
    "test/provider-crosscheck.test.js",
    "test/rollout-line-reader.test.js",
    "test/telemetry-contribution-builder.test.js",
    "test/telemetry-contribution-v0.2.test.js",
    "test/telemetry-envelope-adapter.test.js",
    "test/telemetry-schema-mirror.test.js",
  ]),
  storageAndCompanion: Object.freeze([
    "test/contribution-device-cli.test.js",
    "test/contribution-device-sync.test.js",
    "test/contribution-sync-queue.test.js",
    "test/export-identity-production.test.js",
    "test/export-identity.test.js",
    "test/export-storage.test.js",
    "test/local-collector-state.test.js",
    "test/local-companion-data.test.js",
    "test/local-companion-refresh.test.js",
    "test/local-contribution-preparation.test.js",
    "test/local-installation-diagnostics.test.js",
    "test/local-metadata-bundle-files.test.js",
    "test/owner-only-filesystem.test.js",
    "test/portable-local-companion-process.test.js",
    "test/prospective-collector-cli.test.js",
    "test/real-local-backend-acceptance.test.js",
    "test/weekly-pace-local-companion.test.js",
    "test/weekly-pace-refresh-integration.test.js",
    "test/windows-credential-manager.test.js",
    "test/windows-credential-audit-file-guard.test.js",
    "test/windows-credential-mutex-native.test.js",
    "test/windows-credential-mutex.test.js",
    "test/windows-credential-operation-audit.test.js",
    "test/windows-credential-operation-lease.test.js",
    "test/windows-credential-manager-probe.test.js",
    "test/windows-production-readiness.test.js",
    "test/windows-portable-diagnostic.test.js",
    "test/windows-filesystem-loader.test.js",
    "test/windows-filesystem-manifest.test.js",
    "test/windows-filesystem-native-contract.test.js",
    "test/windows-filesystem-companion-instance-lease.test.js",
    "test/windows-filesystem-security.test.js",
    "test/windows-qualification-governance.test.js",
    "test/windows-sqlite-state-session-contract.test.js",
    "test/windows-path-contract.test.js",
    "test/windows-skip-ledger.test.js",
    "test/windows-test-manifest.test.js",
    "test/electron-development-artifact-verifier.test.js",
    "apps/local/participant-relay-routes.test.mjs",
    "apps/local/participant-session-cookie-bridge.test.mjs",
    "apps/local/server.test.mjs",
  ]),
  web: Object.freeze([
    "apps/web/test/admin-client.test.mjs",
    "apps/web/test/admin-site.test.mjs",
    "apps/web/test/community-site.test.mjs",
    "apps/web/test/i18n-browser-parity.test.mjs",
    "apps/web/test/lib.test.mjs",
    "apps/web/test/localization-copy.test.mjs",
    "apps/web/test/navigation.test.mjs",
    "apps/web/test/plan-type-data-client.test.mjs",
    "apps/web/test/telemetry-shared-parity.test.mjs",
    "apps/web/test/weekly-pace-data-client.test.mjs",
    "apps/web/test/weekly-pace-forecast.test.mjs",
  ]),
});

export const PORTABLE_TEST_FILES = Object.freeze([
  ...new Set(Object.values(PORTABLE_TEST_GROUPS).flat()),
]);

// These files still prove useful POSIX contracts in the macOS/Linux portable
// lane, but running them on Windows would pretend Unix mode bits are an ACL
// substitute. Keep every deferral explicit and reviewable until issue #3 owns
// the corresponding Windows security implementation.
export const WINDOWS_DEFERRED_TESTS = Object.freeze([
  Object.freeze({
    file: "test/quota-track-identity.test.js",
    reason: "Windows unified-index rebuild requires qualified protected staging and SQLite sessions; pure quota contracts remain covered portably",
  }),
  Object.freeze({
    file: "test/fast-mode-accounting.test.js",
    reason: "owner-only state fixtures require branded Windows protected storage; dedicated Windows state tests cover that path",
  }),
  Object.freeze({
    file: "test/codex-interleaved-usage-streams.test.js",
    reason: "Windows full-index rebuild requires qualified protected staging and SQLite sessions; parser contracts remain covered portably",
  }),
  Object.freeze({
    file: "test/telemetry-contribution-builder.test.js",
    reason: "Windows storage-backed builder fixtures require the qualified review-pair storage writer",
  }),
  Object.freeze({
    file: "test/contribution-sync-queue.test.js",
    reason: "Windows queue integration requires qualified prepared-artifact storage and protected SQLite queue sessions",
  }),
  Object.freeze({
    file: "test/export-identity.test.js",
    reason: "production file identity requires Windows owner ACL, reparse-point, and hard-link enforcement",
  }),
  Object.freeze({
    file: "test/local-collector-state.test.js",
    reason: "Windows collector state integration requires the qualified native SQLite session boundary",
  }),
  Object.freeze({
    file: "test/local-companion-data.test.js",
    reason: "Windows companion data integration requires qualified collector state and unified-index staging",
  }),
  Object.freeze({
    file: "test/local-companion-refresh.test.js",
    reason: "Windows refresh integration requires qualified filesystem, collector state, and SQLite session composition",
  }),
  Object.freeze({
    file: "test/local-contribution-preparation.test.js",
    reason: "Windows contribution preparation requires qualified prepared-artifact and review-pair storage",
  }),
  Object.freeze({
    file: "test/portable-local-companion-process.test.js",
    reason: "Windows companion process startup requires qualified native state and prepared-artifact composition",
  }),
  Object.freeze({
    file: "test/prospective-collector-cli.test.js",
    reason: "Windows prospective collector SQLite coverage requires the qualified native collector-state session",
  }),
  Object.freeze({
    file: "test/real-local-backend-acceptance.test.js",
    reason: "Windows backend acceptance preparation requires qualified prepared-artifact and review-pair storage",
  }),
  Object.freeze({
    file: "test/weekly-pace-local-companion.test.js",
    reason: "Windows weekly-pace companion integration requires the qualified native collector-state session",
  }),
  Object.freeze({
    file: "test/weekly-pace-refresh-integration.test.js",
    reason: "Windows weekly-pace refresh integration requires the qualified native collector-state session",
  }),
  Object.freeze({
    file: "test/windows-credential-operation-audit.test.js",
    reason: "Windows native audit guard coverage runs in the exact native security qualification lane",
  }),
  Object.freeze({
    file: "test/windows-filesystem-companion-instance-lease.test.js",
    reason: "Windows native companion mutex coverage runs in the exact native security qualification lane",
  }),
  Object.freeze({
    file: "test/windows-sqlite-state-session-contract.test.js",
    reason: "Windows factory-injection contract simulation is non-native; native SQLite coverage uses the dedicated qualification suite",
  }),
  Object.freeze({
    file: "apps/local/server.test.mjs",
    reason: "Windows companion server integration requires qualified native state and prepared-artifact composition",
  }),
]);

const WINDOWS_DEFERRED_TEST_FILES = new Set(
  WINDOWS_DEFERRED_TESTS.map(({ file }) => file),
);

export const WINDOWS_PORTABLE_TEST_FILES = Object.freeze(
  PORTABLE_TEST_FILES.filter((file) => !WINDOWS_DEFERRED_TEST_FILES.has(file)),
);
