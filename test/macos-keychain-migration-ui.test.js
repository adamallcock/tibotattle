import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../apps/macos/UsageMonitorApp.swift", import.meta.url),
  "utf8",
);

function section(start, end) {
  const startIndex = appSource.indexOf(start);
  assert.notEqual(startIndex, -1, `missing native seam: ${start}`);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing native seam boundary: ${end}`);
  return appSource.slice(startIndex, endIndex);
}

test("Keychain status observations stay non-modal and outside web authority", () => {
  const observer = section(
    "func observe(_ next: KeychainMigrationStatus)",
    "func review(confirm:",
  );
  assert.match(observer, /let wasPending = status\.pendingCount > 0/u);
  assert.match(observer, /let completed = wasPending && next\.pendingCount == 0/u);
  assert.match(observer, /if completed \{ onMigrationCompleted\(\) \}/u);
  assert.doesNotMatch(observer, /NSAlert|approve\(|review\(|runModal|beginSheetModal/u);

  const presentation = section(
    "private func updateKeychainMigrationPresentation()",
    "private func refreshAfterKeychainMigration()",
  );
  assert.match(presentation, /settingsKeychainMigrationSection\?\.isHidden/u);
  assert.match(presentation, /keychainMigrationMenuItem\?\.isHidden/u);
  assert.doesNotMatch(
    presentation,
    /NSAlert|showSettings\(|approvePendingMigrations\(|nativeEvidenceState\s*=/u,
  );
  const webHost = section(
    "private final class DashboardWebHost",
    "private final class NativeDashboardChrome",
  );
  assert.doesNotMatch(webHost, /approvePendingMigrations|reviewKeychainMigration/u);

  assert.match(
    appSource,
    /broker\.setMigrationStatusObserver\(onMigrationStatus\)/u,
  );
  assert.match(
    appSource,
    /onMigrationStatus: \{ \[weak self\] status in[\s\S]*?selectedGeneration == self\.launchGeneration[\s\S]*?keychainMigrationApproval\.observe\(status\)/u,
  );
});

test("explicit native review is the only UI route to Keychain approval", () => {
  const review = section(
    "func review(confirm:",
    "static func makeExplanation()",
  );
  assert.match(review, /guard canReview else \{ return \}/u);
  assert.match(review, /guard let self, self\.isReviewing,/u);
  assert.match(review, /self\.reviewGeneration == selectedReviewGeneration/u);
  assert.match(review, /self\.isReviewing = false/u);
  assert.match(
    review,
    /guard approved, self\.status\.needsApproval,[\s\S]*?!self\.approvalInFlight/u,
  );
  assert.match(review, /self\.approve \{ \[weak self\] success in/u);
  assert.match(review, /self\.lastApprovalDeferred = !success/u);
  assert.doesNotMatch(review, /asyncAfter|DispatchSource|reset|deleteSecret|SecItem/u);

  const nativeAction = section(
    "@objc private func reviewKeychainMigration(_ sender: NSButton)",
    "private func automaticUpdatesSettingsSummary()",
  );
  assert.match(nativeAction, /guard sender === settingsKeychainMigrationButton/u);
  assert.match(nativeAction, /companion\?\.isRunning == true/u);
  assert.match(nativeAction, /keychainMigrationApproval\.review/u);
  assert.match(nativeAction, /NativeKeychainMigrationApproval\.makeExplanation\(\)/u);
  assert.match(nativeAction, /explanation\.beginSheetModal\(for: settingsWindow\)/u);
  assert.match(nativeAction, /complete\(response == \.alertSecondButtonReturn\)/u);

  const explanation = section(
    "static func makeExplanation() -> NSAlert",
    "private final class AppDelegate",
  );
  assert.match(explanation, /alert\.alertStyle = \.informational/u);
  assert.match(
    explanation,
    /let cancel = alert\.addButton\([\s\S]*?\.commonCancel[\s\S]*?cancel\.keyEquivalent = "\\r"/u,
  );
  assert.match(explanation, /approve\.keyEquivalent = ""/u);
  assert.doesNotMatch(explanation, /NSSecureTextField|NSTextField|passwordField/u);

  const companionApproval = section(
    "func approvePendingMigrations(completion:",
    "func launch(",
  );
  assert.match(companionApproval, /let canApprove = !stopped && process\?\.isRunning == true/u);
  assert.match(companionApproval, /guard canApprove, let broker else/u);
  assert.match(companionApproval, /broker\.approvePendingMigrations\(completion: completion\)/u);
});

test("silent retry presentation is quiet and fallback does not reset the retry budget", () => {
  const state = section(
    "private final class NativeKeychainMigrationApproval",
    "private final class AppDelegate",
  );
  const menu = state.match(/var showsMenuItem: Bool \{([\s\S]*?)\n    \}/u)?.[1];
  assert.ok(menu);
  assert.match(menu, /status\.needsApproval/u);
  assert.doesNotMatch(menu, /status\.isRetrying|status\.pendingCount/u);
  assert.match(state, /status\.needsApproval && !isReviewing && !approvalInFlight/u);
  assert.match(state, /if status\.isRetrying \{ return \.settingsKeychainMigrationRetrying \}/u);
  assert.doesNotMatch(state, /asyncAfter|MigrationPromptState|reset.*Budget|SecItem/u);

  const appMenu = section(
    "private func installApplicationMenu()",
    "private func reportDashboardDownloadFailure()",
  );
  assert.match(appMenu, /action: #selector\(showKeychainMigrationSettings\)/u);
  assert.doesNotMatch(appMenu, /approvePendingMigrations\(/u);
});

test("migration completion queues one existing local refresh without granting consent", () => {
  const refresh = section(
    "private func refreshAfterKeychainMigration()",
    "@objc private func showKeychainMigrationSettings()",
  );
  assert.match(refresh, /guard !quitting else \{ return \}/u);
  assert.match(refresh, /keychainMigrationRefreshPending = true/u);
  assert.match(refresh, /guard dashboardURL != nil, !nativeRefreshInFlight else \{ return \}/u);
  assert.match(refresh, /refreshLocalUsage\(automatic: false\)/u);
  assert.doesNotMatch(
    refresh,
    /approvePendingMigrations\(|grant\w*Consent\(|\.consent\(|\.pair\(|\.upload\(/u,
  );
  const start = section(
    "private func refreshLocalUsage(automatic: Bool)",
    "private func pollNativeRefresh(",
  );
  assert.match(start, /keychainMigrationRefreshPending = false/u);
  assert.match(start, /nativeEvidenceReader\.startAnalysis\(base: dashboardURL\)/u);
  const finish = section(
    "private func finishNativeRefresh(title:",
    "private func readNativeToolbarStatusFacts(",
  );
  assert.match(
    finish,
    /if keychainMigrationRefreshPending \{\s*refreshAfterKeychainMigration\(\)\s*return\s*\}/u,
  );
});

test("native migration smoke cannot launch a companion or access a real Keychain", () => {
  const smoke = section(
    "private enum NativeKeychainMigrationUIContractSmokeTest",
    "private enum NativeAppearanceSettingsContractSmokeTest",
  );
  assert.match(smoke, /NativeKeychainMigrationApproval\.makeExplanation\(\)/u);
  assert.match(smoke, /complete\(false\)[\s\S]*?complete\(true\)/u);
  assert.match(smoke, /finishApproval\?\(false\)/u);
  assert.match(smoke, /state\.observe\(\.idle\)/u);
  assert.match(smoke, /keychain_access=false/u);
  assert.doesNotMatch(
    smoke,
    /CompanionProcess\(|ContributionDeviceKeychainBroker\(|SecItem|runModal\(|beginSheetModal\(|ownerOnlyStateRoot\(/u,
  );
  assert.match(
    appSource,
    /arguments\.contains\(\s*"--native-keychain-migration-ui-contract-smoke-test"\s*\) \{\s*guard BundledProduct\.buildChannel == "development" else \{ exit\(2\) \}[\s\S]*?NativeKeychainMigrationUIContractSmokeTest\.run\(\)/u,
  );
});

test("migration explanation has complete native locale coverage and preservation copy", async () => {
  const migrationKeys = [
    "dialog.approveKeychainMigration",
    "dialog.keychainMigrationTitle",
    "dialog.keychainMigrationDescription",
    "settings.keychainMigrationTitle",
    "settings.keychainMigrationSummary",
    "settings.keychainMigrationRetrying",
    "settings.keychainMigrationApproving",
    "settings.keychainMigrationDeferred",
    "settings.keychainMigrationReview",
    "settings.keychainMigrationMenu",
  ];
  for (const locale of ["en", "es", "zh-Hans"]) {
    const source = await readFile(new URL(
      `../apps/macos/Resources/${locale}.lproj/Localizable.strings`,
      import.meta.url,
    ), "utf8");
    const entries = new Map([...source.matchAll(/^"([^"]+)" = "(.+)";$/gmu)]
      .map(([, key, value]) => [key, value]));
    for (const key of migrationKeys) {
      assert.ok(entries.get(key), `${locale} includes ${key}`);
    }
    const explanation = entries.get("dialog.keychainMigrationDescription");
    assert.match(explanation, /macOS/u);
    assert.match(explanation, /TiboTattle/u);
    if (locale === "en") {
      assert.match(explanation, /local account matching/u);
      assert.match(explanation, /without changing their values/u);
      assert.match(explanation, /TiboTattle does not receive the password/u);
      assert.match(explanation, /does not reset anything or upload data/u);
      assert.match(explanation, /Existing history is kept/u);
      assert.match(explanation, /Cancel leaves migration pending/u);
    }
  }
});
