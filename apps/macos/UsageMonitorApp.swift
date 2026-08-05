import AppKit
import Darwin
import Foundation
import WebKit
#if canImport(Sparkle)
import Sparkle
#endif

private enum BundledProduct {
    private static func requiredString(_ key: String) -> String {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: key
        ) as? String,
              !value.isEmpty,
              !value.contains("\0")
        else {
            fatalError("Missing or invalid bundled product setting: \(key)")
        }
        return value
    }

    private static func requiredDirectoryName(_ key: String) -> String {
        let value = requiredString(key)
        guard value != ".",
              value != "..",
              !value.contains("/"),
              !value.contains(":"),
              value.count <= 80
        else {
            fatalError("Invalid bundled product directory setting: \(key)")
        }
        return value
    }

    private static func requiredHTTPSOrigin(_ key: String) -> String {
        let value = requiredString(key)
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath.isEmpty,
              components.query == nil,
              components.fragment == nil
        else {
            fatalError("Invalid bundled product HTTPS origin: \(key)")
        }
        return value
    }

    static let displayName = requiredString("CFBundleDisplayName")
    static let bundleName = requiredString("UsageMonitorBundleName")
    static let appOpenScheme =
        requiredString("UsageMonitorAppOpenScheme").lowercased()
    static let appOpenHost =
        requiredString("UsageMonitorAppOpenHost").lowercased()
    static let appOpenURL: String = {
        let value = requiredString("UsageMonitorAppOpenURL")
        guard value == "\(appOpenScheme)://\(appOpenHost)" else {
            fatalError("Invalid bundled product setting: UsageMonitorAppOpenURL")
        }
        return value
    }()
    static let stateDirectoryName =
        requiredDirectoryName("UsageMonitorStateDirectoryName")
    static let monitoredAppDisplayName =
        requiredString("UsageMonitorMonitoredAppDisplayName")
    static let monitoredAppBundleIdentifier =
        requiredString("UsageMonitorMonitoredAppBundleIdentifier")
    static let publicWebsiteOrigin =
        requiredHTTPSOrigin("UsageMonitorPublicWebsiteOrigin")
}

private let loopbackHost = "127.0.0.1"
private let readyLinePattern =
    #"^USAGE_MONITOR_READY http://127\.0\.0\.1:([0-9]{1,5})/$"#
private let launcherSettingsSchema = "usage-monitor-launcher-settings-v1"
private let launcherSettingsFileName = "launcher-settings-v1.json"
private let firstRunReceiptSchema = "usage-monitor-first-run-v1"
private let firstRunReceiptFileName = "first-run-v1.json"
private let keychainResetHelperName = "reset-local-keychain.js"
private let companionStartupTimeoutSeconds = 20

private enum AppUpdaterState: Equatable {
    case unavailable
    case unverified
    case ready
    case checking
    case updateAvailable
    case verifiedNoUpdate
    case failed
}

@MainActor
private final class AppUpdater: NSObject {
    private static var bundledUpdaterEnabled: Bool {
        Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorUpdaterEnabled"
        ) as? Bool == true
    }

    private(set) var state: AppUpdaterState
    var onStateChange: (() -> Void)?

    /// This is intentionally not an optimistic "up to date" default. A
    /// configured feed is only usable after this process has independently
    /// observed a non-empty feed response. Sparkle remains the authority for
    /// appcast parsing, signatures, and the verified update result.
    private(set) var feedIsReachable = false
    private var feedPreflightInFlight = false

    /// Channel metadata controls disclosure copy only. Updater availability
    /// still requires this bundle's enabled flag and fresh feed evidence; no
    /// channel name is treated as proof that an endpoint is safe to use.
    static var isPreviewDistribution: Bool {
        Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorPreviewDistribution"
        ) as? Bool == true
        || Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorBuildChannel"
        ) as? String == "preview_distribution"
    }

    private static var appcastURL: URL? {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: "SUFeedURL"
        ) as? String,
              let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.host != nil
        else {
            return nil
        }
        return url
    }

#if canImport(Sparkle)
    private var controller: SPUStandardUpdaterController?
    private var hasStarted = false

    override init() {
        state = Self.bundledUpdaterEnabled ? .unverified : .unavailable
        super.init()
        guard Self.bundledUpdaterEnabled else { return }
        controller = SPUStandardUpdaterController(
            // Do not let Sparkle begin update networking before the
            // first-run disclosure explains the default behavior.
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
    }

    var isAvailable: Bool {
        controller != nil
    }

    var allowsAutomaticUpdateOptIn: Bool {
        controller?.updater.allowsAutomaticUpdates == true
    }

    var automaticUpdatesEnabled: Bool {
        controller?.updater.automaticallyDownloadsUpdates == true
    }

    /// Automatic-update controls remain disabled until the endpoint and the
    /// latest check both have a truthful state. This prevents a configured
    /// but unavailable feed from looking ready merely because Sparkle exists.
    var canConfigureAutomaticUpdates: Bool {
        guard isAvailable, feedIsReachable else { return false }
        return ![.checking, .failed].contains(state)
    }

    var canCheckForUpdates: Bool {
        isAvailable && !feedPreflightInFlight && state != .checking
    }

    var menuItemTitle: String {
        state == .failed
            ? TiboTattleLocalization.string(.launcherRetry)
            : TiboTattleLocalization.string(.settingsCheckForUpdates) + "…"
    }

    var settingsSummary: String {
        switch state {
        case .unavailable:
            return TiboTattleLocalization.string(
                .settingsAutomaticUpdatesUnavailable
            )
        case .unverified:
            return TiboTattleLocalization.string(
                .settingsAutomaticUpdatesUnavailable
            )
        case .ready:
            if Self.isPreviewDistribution {
                return TiboTattleLocalization.string(
                    .settingsUpdateDisclosurePreview
                )
            }
            return TiboTattleLocalization.string(
                .settingsAutomaticUpdatesReachable
            )
        case .checking:
            return TiboTattleLocalization.string(.settingsCheckForUpdates)
                + "…"
        case .updateAvailable:
            // The native Sparkle sheet presents the version and install
            // choices. Keep this native summary truthful without inventing a
            // second version display in the settings window.
            return automaticUpdatesEnabled
                ? TiboTattleLocalization.string(.settingsAutomaticUpdatesOn)
                : TiboTattleLocalization.string(.settingsAutomaticUpdatesOff)
        case .verifiedNoUpdate:
            return TiboTattleLocalization.string(.launcherUpToDate)
        case .failed:
            return TiboTattleLocalization.string(
                .launcherUpdateUnavailable
            )
        }
    }

    private func setState(_ next: AppUpdaterState) {
        guard state != next else { return }
        state = next
        onStateChange?()
    }

    func startAfterFirstRunDisclosure() {
        guard isAvailable, !hasStarted, !Self.isPreviewDistribution else {
            return
        }
        preflightFeed(userInitiated: false) { [weak self] in
            guard let self else { return }
            self.startUpdaterIfNeeded()
            if self.state == .checking {
                self.setState(.ready)
            }
        }
    }

    func checkForUpdates(_ sender: Any?) {
        guard isAvailable, !feedPreflightInFlight else { return }
        preflightFeed(userInitiated: true) { [weak self] in
            guard let self, let controller = self.controller else { return }
            self.startUpdaterIfNeeded()
            self.setState(.checking)
            // Sparkle requires the updater to be started before a manual
            // check. Dispatching one main-queue turn keeps that contract
            // intact when the manual check also starts the updater.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.hasStarted else { return }
                controller.checkForUpdates(sender)
            }
        }
    }

    private func startUpdaterIfNeeded() {
        guard let controller, !hasStarted else { return }
        hasStarted = true
        controller.startUpdater()
        if state != .checking {
            setState(.ready)
        }
    }

    private func preflightFeed(
        userInitiated: Bool,
        onReachable: @escaping () -> Void
    ) {
        guard !feedPreflightInFlight else { return }
        guard let appcastURL = Self.appcastURL else {
            feedIsReachable = false
            setState(.failed)
            if userInitiated {
                showFeedFailureAlert()
            }
            return
        }

        feedPreflightInFlight = true
        feedIsReachable = false
        setState(.checking)
        var request = URLRequest(url: appcastURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 5
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.feedPreflightInFlight = false
                guard Self.feedResponseIsReachable(
                    statusCode: (response as? HTTPURLResponse)?.statusCode,
                    hasError: error != nil,
                    hasBody: data?.isEmpty == false
                ) else {
                    self.feedIsReachable = false
                    self.setState(.failed)
                    if userInitiated {
                        self.showFeedFailureAlert()
                    }
                    return
                }
                self.feedIsReachable = true
                onReachable()
            }
        }.resume()
    }

    private func showFeedFailureAlert() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = TiboTattleLocalization.string(
            .launcherUpdateUnavailable
        )
        alert.informativeText = TiboTattleLocalization.string(
            .settingsAutomaticUpdatesUnavailable
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.launcherRetry))
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        if alert.runModal() == .alertFirstButtonReturn {
            checkForUpdates(nil)
        }
    }

    func setAutomaticUpdatesEnabled(_ enabled: Bool) {
        guard let updater = controller?.updater,
              updater.allowsAutomaticUpdates,
              feedIsReachable
        else {
            return
        }
        updater.automaticallyDownloadsUpdates = enabled
    }

    static var runtimeDescription: String {
        bundledUpdaterEnabled
            ? "sparkle_2_9_3_enabled"
            : "sparkle_not_configured"
    }
#else
    override init() {
        state = .unavailable
        super.init()
    }

    var isAvailable: Bool {
        false
    }

    var allowsAutomaticUpdateOptIn: Bool {
        false
    }

    var automaticUpdatesEnabled: Bool {
        false
    }

    var canConfigureAutomaticUpdates: Bool {
        false
    }

    var canCheckForUpdates: Bool {
        false
    }

    var menuItemTitle: String {
        TiboTattleLocalization.string(.settingsCheckForUpdates) + "…"
    }

    var settingsSummary: String {
        TiboTattleLocalization.string(.settingsAutomaticUpdatesUnavailable)
    }

    func startAfterFirstRunDisclosure() {}

    func checkForUpdates(_ sender: Any?) {}

    func setAutomaticUpdatesEnabled(_ enabled: Bool) {}

    static var runtimeDescription: String {
        bundledUpdaterEnabled
            ? "invalid_framework_missing"
            : "development_disabled"
    }
#endif

    /// Keep this classification limited to reachability evidence. A successful
    /// response does not claim that the appcast is valid or signed.
    static func feedResponseIsReachable(
        statusCode: Int?,
        hasError: Bool,
        hasBody: Bool
    ) -> Bool {
        guard !hasError, hasBody, let statusCode else { return false }
        return (200..<300).contains(statusCode)
    }

    static var runtimeStateDescription: String {
#if canImport(Sparkle)
        bundledUpdaterEnabled ? "feed_unverified" : "unavailable_in_build"
#else
        "unavailable_in_build"
#endif
    }

#if canImport(Sparkle)
    // Sparkle's standard user driver remains the native presentation for a
    // verified update or a verified no-update result. These delegate hooks
    // keep the app's own status surface aligned with that result and make a
    // failed check retryable from About or the menu bar.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        setState(.updateAvailable)
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        // Sparkle has parsed and verified the appcast at this point. The
        // error carries the reason no newer compatible item was selected; it
        // is not a feed or signature failure.
        setState(.verifiedNoUpdate)
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        setState(.verifiedNoUpdate)
    }

    static func stateForUpdaterAbort(
        errorDomain: String,
        errorCode: Int
    ) -> AppUpdaterState {
        guard errorDomain == SUSparkleErrorDomain else { return .failed }
        switch errorCode {
        case Int(SUError.noUpdateError.rawValue):
            return .verifiedNoUpdate
        case Int(SUError.installationCanceledError.rawValue):
            // A cancelled authorization or install attempt is retryable and
            // does not make the already-verified feed unavailable.
            return .ready
        default:
            return .failed
        }
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let updaterError = error as NSError
        setState(Self.stateForUpdaterAbort(
            errorDomain: updaterError.domain,
            errorCode: updaterError.code
        ))
    }
#endif

    var firstRunUpdatesDisclosure: String {
        guard isAvailable else {
            return TiboTattleLocalization.string(
                .settingsUpdateDisclosureDevelopment
            )
        }
        if Self.isPreviewDistribution {
            return TiboTattleLocalization.string(
                .settingsUpdateDisclosurePreview
            )
        }
        if allowsAutomaticUpdateOptIn && automaticUpdatesEnabled {
            return TiboTattleLocalization.string(
                .settingsUpdateDisclosureAutomaticOn
            )
        }
        return TiboTattleLocalization.string(
            .settingsUpdateDisclosureAutomaticOff
        )
    }
}

#if canImport(Sparkle)
extension AppUpdater: SPUUpdaterDelegate {}
#endif

private enum CentralServiceMode: String {
    case developmentLoopback = "development_loopback"
    case productionHTTPS = "production_https"
    case internalDogfoodHTTPS = "internal_dogfood_https"
}

private struct CentralServiceConfiguration {
    let mode: CentralServiceMode
    let origin: String

    static func bundled() throws -> CentralServiceConfiguration? {
        let originValue = Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorCentralOrigin"
        )
        let modeValue = Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorCentralOriginMode"
        )
        if originValue == nil && modeValue == nil {
            return nil
        }
        guard let origin = originValue as? String,
              let rawMode = modeValue as? String,
              !origin.isEmpty,
              !origin.contains("\0"),
              let mode = CentralServiceMode(rawValue: rawMode),
              let components = URLComponents(string: origin),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath.isEmpty,
              components.query == nil,
              components.fragment == nil
        else {
            throw LauncherError.invalidCentralService
        }

        switch mode {
        case .developmentLoopback:
            guard scheme == "http",
                  host == loopbackHost,
                  components.port != nil
            else {
                throw LauncherError.invalidCentralService
            }
        case .productionHTTPS, .internalDogfoodHTTPS:
            guard scheme == "https",
                  !["127.0.0.1", "localhost", "::1"].contains(host)
            else {
                throw LauncherError.invalidCentralService
            }
        }
        return CentralServiceConfiguration(mode: mode, origin: origin)
    }
}

private enum LauncherError: LocalizedError {
    case invalidCentralService
    case invalidCodexHome
    case invalidCodexHomeSettings
    case invalidFirstRunState
    case invalidHome
    case invalidResource(String)
    case invalidStateDirectory
    case companionAlreadyRunning
    case companionExited
    case companionLaunch(String)
    case companionTimeout
    case codexHomeSettingsWrite
    case dashboardDownloadFailed
    case dashboardWebViewUnavailable
    case dataErase
    case firstRunStateWrite
    case healthCheck
    case keychainDenied
    case keychainLocked
    case keychainReset
    case keychainResetPartial

    var errorDescription: String? {
        switch self {
        case .invalidCentralService:
            return TiboTattleLocalization.string(.launcherErrorInvalidCentralService)
        case .invalidCodexHome:
            return TiboTattleLocalization.string(.launcherErrorInvalidCodexHome)
        case .invalidCodexHomeSettings:
            return TiboTattleLocalization.string(
                .launcherErrorInvalidCodexHomeSettings
            )
        case .invalidFirstRunState:
            return TiboTattleLocalization.string(
                .launcherErrorInvalidFirstRunState
            )
        case .invalidHome:
            return TiboTattleLocalization.string(.launcherErrorInvalidHome)
        case .invalidResource:
            return TiboTattleLocalization.string(.launcherErrorInvalidResource)
        case .invalidStateDirectory:
            return TiboTattleLocalization.format(
                .launcherErrorInvalidStateDirectory,
                BundledProduct.displayName
            )
        case .companionAlreadyRunning:
            return TiboTattleLocalization.format(
                .launcherErrorCompanionAlreadyRunning,
                BundledProduct.displayName
            )
        case .companionExited:
            return TiboTattleLocalization.string(.launcherErrorCompanionExited)
        case .companionLaunch:
            return TiboTattleLocalization.string(.launcherErrorCompanionLaunch)
        case .companionTimeout:
            return TiboTattleLocalization.string(.launcherErrorCompanionTimeout)
        case .codexHomeSettingsWrite:
            return TiboTattleLocalization.string(
                .launcherErrorCodexHomeSettingsWrite
            )
        case .dashboardDownloadFailed:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardDownloadFailed
            )
        case .dashboardWebViewUnavailable:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardWebViewUnavailable
            )
        case .dataErase:
            return TiboTattleLocalization.format(
                .launcherErrorDataErase,
                BundledProduct.displayName
            )
        case .firstRunStateWrite:
            return TiboTattleLocalization.string(
                .launcherErrorFirstRunStateWrite
            )
        case .healthCheck:
            return TiboTattleLocalization.string(.launcherErrorHealthCheck)
        case .keychainDenied:
            return TiboTattleLocalization.string(.launcherErrorKeychainDenied)
        case .keychainLocked:
            return TiboTattleLocalization.string(.launcherErrorKeychainLocked)
        case .keychainReset:
            return TiboTattleLocalization.string(.launcherErrorKeychainReset)
        case .keychainResetPartial:
            return TiboTattleLocalization.string(.launcherErrorKeychainResetPartial)
        }
    }

    var failureCode: String {
        switch self {
        case .invalidCentralService:
            return "UM_MACOS_CENTRAL_CONFIGURATION_INVALID"
        case .invalidCodexHome:
            return "UM_MACOS_CODEX_HOME_INVALID"
        case .invalidCodexHomeSettings:
            return "UM_MACOS_CODEX_HOME_SETTINGS_INVALID"
        case .invalidFirstRunState:
            return "UM_MACOS_FIRST_RUN_STATE_INVALID"
        case .invalidHome:
            return "UM_MACOS_HOME_UNAVAILABLE"
        case .invalidResource:
            return "UM_MACOS_BUNDLE_INCOMPLETE"
        case .invalidStateDirectory:
            return "UM_MACOS_APP_STATE_UNAVAILABLE"
        case .companionAlreadyRunning:
            return "UM_MACOS_COMPANION_ALREADY_RUNNING"
        case .companionExited:
            return "UM_MACOS_COMPANION_EXITED"
        case .companionLaunch:
            return "UM_MACOS_COMPANION_LAUNCH_FAILED"
        case .companionTimeout:
            return "UM_MACOS_COMPANION_START_TIMEOUT"
        case .codexHomeSettingsWrite:
            return "UM_MACOS_CODEX_HOME_SETTINGS_WRITE_FAILED"
        case .dashboardDownloadFailed:
            return "UM_MACOS_DASHBOARD_DOWNLOAD_FAILED"
        case .dashboardWebViewUnavailable:
            return "UM_MACOS_DASHBOARD_VIEW_UNAVAILABLE"
        case .dataErase:
            return "UM_MACOS_LOCAL_DATA_ERASE_FAILED"
        case .firstRunStateWrite:
            return "UM_MACOS_FIRST_RUN_STATE_WRITE_FAILED"
        case .healthCheck:
            return "UM_MACOS_LOCAL_HEALTH_FAILED"
        case .keychainDenied:
            return "UM_MACOS_KEYCHAIN_DENIED"
        case .keychainLocked:
            return "UM_MACOS_KEYCHAIN_LOCKED"
        case .keychainReset:
            return "UM_MACOS_KEYCHAIN_RESET_FAILED"
        case .keychainResetPartial:
            return "UM_MACOS_KEYCHAIN_RESET_PARTIAL"
        }
    }

    var recoverySuggestion: String {
        switch self {
        case .invalidCentralService, .invalidResource:
            return TiboTattleLocalization.format(
                .launcherRecoveryReinstall,
                BundledProduct.displayName
            )
        case .invalidCodexHome, .invalidCodexHomeSettings:
            return TiboTattleLocalization.string(
                .launcherRecoveryChooseCodexHome
            )
        case .invalidFirstRunState:
            return TiboTattleLocalization.format(
                .launcherRecoveryMoveAppState,
                BundledProduct.displayName
            )
        case .invalidHome, .invalidStateDirectory, .codexHomeSettingsWrite,
             .firstRunStateWrite:
            return TiboTattleLocalization.string(.launcherRecoveryCheckAccess)
        case .dashboardDownloadFailed:
            return TiboTattleLocalization.string(
                .launcherRecoveryDashboardDownload
            )
        case .dashboardWebViewUnavailable:
            return TiboTattleLocalization.string(
                .launcherRecoveryDashboardWebView
            )
        case .companionAlreadyRunning:
            return TiboTattleLocalization.format(
                .launcherRecoveryExistingWindow,
                BundledProduct.displayName
            )
        case .companionExited, .companionLaunch, .companionTimeout,
             .healthCheck:
            return TiboTattleLocalization.string(
                .launcherRecoveryRetryDiagnostics
            )
        case .dataErase:
            return TiboTattleLocalization.format(
                .launcherRecoveryDataErase,
                BundledProduct.displayName
            )
        case .keychainDenied:
            return TiboTattleLocalization.string(
                .launcherRecoveryKeychainDenied
            )
        case .keychainLocked:
            return TiboTattleLocalization.string(
                .launcherRecoveryKeychainLocked
            )
        case .keychainReset, .keychainResetPartial:
            return TiboTattleLocalization.string(.launcherRecoveryReset)
        }
    }
}

private enum CodexHomeMode: String {
    case custom
    case defaultLocation = "default"
}

private struct CodexHomeConfiguration {
    let mode: CodexHomeMode
    let url: URL
}

private struct LauncherSettings: Codable {
    let schemaVersion: String
    let codexHome: String
}

private struct FirstRunReceipt: Codable {
    let schemaVersion: String
    let acknowledged: Bool
}

private struct LifecycleDiagnostics {
    static func render(
        version: String,
        build: String,
        lifecycle: String,
        failureCode: String?,
        recovery: String?,
        centralConfigured: Bool,
        codexHomeMode: CodexHomeMode,
        codexHomeValidated: Bool,
        appStateAvailable: Bool,
        loginItemStatus: LoginItemStatus,
        loginItemLastOperation: LoginItemDiagnosticAction
    ) -> String {
        [
            "\(BundledProduct.displayName) diagnostics",
            "schema: usage-monitor-macos-diagnostics-v1",
            "app_version: \(version)",
            "app_build: \(build)",
            "lifecycle: \(lifecycle)",
            "failure_code: \(failureCode ?? "none")",
            "recovery: \(recovery ?? "none")",
            "community_service: \(centralConfigured ? "configured" : "not_configured")",
            "codex_source: \(codexHomeMode.rawValue)",
            "codex_source_validated: \(codexHomeValidated)",
            "app_state: \(appStateAvailable ? "owner_only_available" : "unavailable")",
            "login_item_status: \(loginItemStatus.diagnosticValue)",
            "login_item_last_operation: \(loginItemLastOperation.rawValue)",
            "login_item_service: main_app_only",
            "process_lifecycle: foreground_only",
            "automatic_upload: off",
            "paths_included: false",
            "identifiers_included: false",
            "content_included: false",
        ].joined(separator: "\n")
    }
}

private func regularFile(_ url: URL) -> Bool {
    var metadata = stat()
    return url.path.withCString { path in
        guard lstat(path, &metadata) == 0 else { return false }
        return (metadata.st_mode & S_IFMT) == S_IFREG
            && (metadata.st_mode & S_IFMT) != S_IFLNK
    }
}

private func currentUserHomeDirectory() throws -> URL {
    let environmentHome = ProcessInfo.processInfo.environment["HOME"]
    let candidate = environmentHome.flatMap { value -> URL? in
        guard value.hasPrefix("/"), !value.contains("\0") else { return nil }
        return URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
    } ?? FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
    guard candidate.path.hasPrefix("/"), candidate.path != "/" else {
        throw LauncherError.invalidHome
    }
    return candidate
}

private func defaultCodexHome() throws -> URL {
    try currentUserHomeDirectory()
        .appendingPathComponent(".codex", isDirectory: true)
}

private func validatedCustomCodexHome(_ candidate: URL) throws -> URL {
    let inputPath = candidate.path
    guard candidate.isFileURL,
          inputPath.hasPrefix("/"),
          inputPath != "/",
          !inputPath.contains("\0"),
          inputPath.utf8.count <= 4_096,
          let resolvedPointer = Darwin.realpath(inputPath, nil)
    else {
        throw LauncherError.invalidCodexHome
    }
    defer { free(resolvedPointer) }
    let canonicalPath = String(cString: resolvedPointer)
    guard canonicalPath == inputPath else {
        throw LauncherError.invalidCodexHome
    }
    let selected = URL(
        fileURLWithPath: canonicalPath,
        isDirectory: true
    )
    var metadata = stat()
    let valid = selected.path.withCString { path in
        guard lstat(path, &metadata) == 0 else { return false }
        return (metadata.st_mode & S_IFMT) == S_IFDIR
            && (metadata.st_mode & S_IFMT) != S_IFLNK
            && metadata.st_uid == getuid()
            && access(path, R_OK | X_OK) == 0
    }
    guard valid else {
        throw LauncherError.invalidCodexHome
    }
    return selected
}

private func launcherSettingsFile(in stateRoot: URL) -> URL {
    stateRoot.appendingPathComponent(
        launcherSettingsFileName,
        isDirectory: false
    )
}

private func validateSettingsFile(
    _ file: URL,
    requireValidContentSize: Bool = true
) throws -> Bool {
    var metadata = stat()
    let status = file.path.withCString { path in
        lstat(path, &metadata)
    }
    if status != 0 {
        if errno == ENOENT { return false }
        throw LauncherError.invalidCodexHomeSettings
    }
    guard (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & S_IFMT) != S_IFLNK,
          metadata.st_uid == getuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & 0o077) == 0,
          !requireValidContentSize
            || (metadata.st_size > 0 && metadata.st_size <= 8_192)
    else {
        throw LauncherError.invalidCodexHomeSettings
    }
    return true
}

private func loadCodexHomeConfiguration(
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let settingsFile = launcherSettingsFile(in: stateRoot)
    guard try validateSettingsFile(settingsFile) else {
        return CodexHomeConfiguration(
            mode: .defaultLocation,
            url: try defaultCodexHome()
        )
    }
    do {
        let settings = try JSONDecoder().decode(
            LauncherSettings.self,
            from: Data(contentsOf: settingsFile, options: [.mappedIfSafe])
        )
        guard settings.schemaVersion == launcherSettingsSchema else {
            throw LauncherError.invalidCodexHomeSettings
        }
        let selected = try validatedCustomCodexHome(
            URL(fileURLWithPath: settings.codexHome, isDirectory: true)
        )
        return CodexHomeConfiguration(mode: .custom, url: selected)
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.invalidCodexHomeSettings
    }
}

private func saveCodexHomeConfiguration(
    _ selected: URL,
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let validated = try validatedCustomCodexHome(selected)
    let settingsFile = launcherSettingsFile(in: stateRoot)
    _ = try validateSettingsFile(
        settingsFile,
        requireValidContentSize: false
    )
    let settings = LauncherSettings(
        schemaVersion: launcherSettingsSchema,
        codexHome: validated.path
    )
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes = try encoder.encode(settings)
        bytes.append(0x0a)
        try bytes.write(to: settingsFile, options: [.atomic])
        guard chmod(settingsFile.path, 0o600) == 0,
              try validateSettingsFile(settingsFile)
        else {
            throw LauncherError.codexHomeSettingsWrite
        }
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.codexHomeSettingsWrite
    }
    return CodexHomeConfiguration(mode: .custom, url: validated)
}

private func clearCodexHomeConfiguration(
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let settingsFile = launcherSettingsFile(in: stateRoot)
    guard try validateSettingsFile(
        settingsFile,
        requireValidContentSize: false
    ) else {
        return CodexHomeConfiguration(
            mode: .defaultLocation,
            url: try defaultCodexHome()
        )
    }
    do {
        try FileManager.default.removeItem(at: settingsFile)
    } catch {
        throw LauncherError.codexHomeSettingsWrite
    }
    return CodexHomeConfiguration(
        mode: .defaultLocation,
        url: try defaultCodexHome()
    )
}

private func firstRunReceiptFile(in stateRoot: URL) -> URL {
    stateRoot.appendingPathComponent(
        firstRunReceiptFileName,
        isDirectory: false
    )
}

private func validateFirstRunReceiptFile(_ file: URL) throws -> Bool {
    var metadata = stat()
    let status = file.path.withCString { path in
        lstat(path, &metadata)
    }
    if status != 0 {
        if errno == ENOENT { return false }
        throw LauncherError.invalidFirstRunState
    }
    guard (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & S_IFMT) != S_IFLNK,
          metadata.st_uid == getuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & 0o077) == 0,
          metadata.st_size > 0,
          metadata.st_size <= 512
    else {
        throw LauncherError.invalidFirstRunState
    }
    return true
}

private func hasCompletedFirstRun(stateRoot: URL) throws -> Bool {
    let receiptFile = firstRunReceiptFile(in: stateRoot)
    guard try validateFirstRunReceiptFile(receiptFile) else {
        return false
    }
    do {
        let receipt = try JSONDecoder().decode(
            FirstRunReceipt.self,
            from: Data(contentsOf: receiptFile, options: [.mappedIfSafe])
        )
        guard receipt.schemaVersion == firstRunReceiptSchema,
              receipt.acknowledged
        else {
            throw LauncherError.invalidFirstRunState
        }
        return true
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.invalidFirstRunState
    }
}

private func markFirstRunCompleted(stateRoot: URL) throws {
    let receiptFile = firstRunReceiptFile(in: stateRoot)
    guard !(try validateFirstRunReceiptFile(receiptFile)) else {
        guard try hasCompletedFirstRun(stateRoot: stateRoot) else {
            throw LauncherError.invalidFirstRunState
        }
        return
    }
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes = try encoder.encode(
            FirstRunReceipt(
                schemaVersion: firstRunReceiptSchema,
                acknowledged: true
            )
        )
        bytes.append(0x0a)
        try bytes.write(to: receiptFile, options: [.atomic])
        guard chmod(receiptFile.path, 0o600) == 0,
              try validateFirstRunReceiptFile(receiptFile),
              try hasCompletedFirstRun(stateRoot: stateRoot)
        else {
            throw LauncherError.firstRunStateWrite
        }
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.firstRunStateWrite
    }
}

private func ownerOnlyStateRoot() throws -> URL {
    let homeURL = try currentUserHomeDirectory()
    let stateRoot = homeURL
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent(
            BundledProduct.stateDirectoryName,
            isDirectory: true
        )
    do {
        try FileManager.default.createDirectory(
            at: stateRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
    } catch {
        throw LauncherError.invalidStateDirectory
    }

    let descriptor = stateRoot.path.withCString { path in
        open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    }
    guard descriptor >= 0 else {
        throw LauncherError.invalidStateDirectory
    }
    defer { close(descriptor) }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0,
          (metadata.st_mode & S_IFMT) == S_IFDIR,
          metadata.st_uid == getuid(),
          fchmod(descriptor, 0o700) == 0
    else {
        throw LauncherError.invalidStateDirectory
    }
    return stateRoot
}

private struct CompanionResources {
    let node: URL
    let resourceRoot: URL
    let entrypoint: URL
    let keychainResetEntrypoint: URL

    static func bundled() throws -> CompanionResources {
        guard let bundleResources = Bundle.main.resourceURL else {
            throw LauncherError.invalidResource("resources")
        }
        let resourceRoot = bundleResources.appendingPathComponent(
            "app",
            isDirectory: true
        )
        let node = bundleResources
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("node", isDirectory: false)
        let entrypoint = resourceRoot
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("local", isDirectory: true)
            .appendingPathComponent("server.js", isDirectory: false)
        let keychainResetEntrypoint = resourceRoot
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("macos", isDirectory: true)
            .appendingPathComponent(
                keychainResetHelperName,
                isDirectory: false
            )
        guard regularFile(node),
              regularFile(entrypoint),
              regularFile(keychainResetEntrypoint)
        else {
            throw LauncherError.invalidResource("runtime")
        }
        return CompanionResources(
            node: node,
            resourceRoot: resourceRoot,
            entrypoint: entrypoint,
            keychainResetEntrypoint: keychainResetEntrypoint
        )
    }
}

private final class CompanionProcess {
    private let centralService: CentralServiceConfiguration?
    private let codexHome: URL
    private let lock = NSLock()
    private var pendingOutput = ""
    private var pendingStandardError = ""
    private var activeInstanceDetected = false
    private var process: Process?
    private var stopCompletions: [() -> Void] = []
    private var stopped = false
    private let onExit: (Bool, Bool) -> Void
    private let onReady: (URL) -> Void

    init(
        centralService: CentralServiceConfiguration?,
        codexHome: URL,
        onReady: @escaping (URL) -> Void,
        onExit: @escaping (Bool, Bool) -> Void
    ) {
        self.centralService = centralService
        self.codexHome = codexHome
        self.onReady = onReady
        self.onExit = onExit
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process?.isRunning == true
    }

    var processIdentifier: pid_t? {
        lock.lock()
        defer { lock.unlock() }
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    func launch() throws {
        let resources = try CompanionResources.bundled()
        let stateRoot = try ownerOnlyStateRoot()
        let homeDirectory = try currentUserHomeDirectory()
        let child = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()

        child.executableURL = resources.node
        child.arguments = [resources.entrypoint.path]
        child.currentDirectoryURL = resources.resourceRoot
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = standardOutput
        child.standardError = standardError

        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [
            "HOME": homeDirectory.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "production",
            "USAGE_MONITOR_PARENT_PID": String(getpid()),
            "USAGE_MONITOR_PORT": "0",
            "USAGE_MONITOR_RESOURCE_ROOT": resources.resourceRoot.path,
            "USAGE_MONITOR_STATE_ROOT": stateRoot.path,
            "CODEX_HOME": codexHome.path,
        ]
        for name in ["LANG", "LC_ALL", "TMPDIR"] {
            if let value = inherited[name], !value.contains("\0") {
                environment[name] = value
            }
        }
        if let centralService {
            environment["USAGE_MONITOR_CENTRAL_ORIGIN"] =
                centralService.origin
        }
        child.environment = environment

        standardOutput.fileHandleForReading.readabilityHandler = {
            [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            self?.consumeStandardOutput(data)
        }
        standardError.fileHandleForReading.readabilityHandler = { [weak self] handle in
            // Drain bounded local diagnostic output without writing it to disk.
            // Only a fixed, non-content-bearing lock code can alter native
            // recovery guidance; all other companion output remains private.
            self?.consumeStandardError(handle.availableData)
        }
        child.terminationHandler = { [weak self] terminated in
            standardOutput.fileHandleForReading.readabilityHandler = nil
            standardError.fileHandleForReading.readabilityHandler = nil
            self?.didTerminate(success: terminated.terminationStatus == 0)
        }

        lock.lock()
        process = child
        stopped = false
        pendingOutput = ""
        pendingStandardError = ""
        activeInstanceDetected = false
        lock.unlock()
        do {
            try child.run()
        } catch {
            lock.lock()
            process = nil
            lock.unlock()
            throw LauncherError.companionLaunch("run")
        }
    }

    private func consumeStandardOutput(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        pendingOutput.append(text)
        if pendingOutput.utf8.count > 8_192 {
            pendingOutput = String(pendingOutput.suffix(4_096))
        }
        var lines: [String] = []
        while let newline = pendingOutput.firstIndex(of: "\n") {
            lines.append(String(pendingOutput[..<newline]))
            pendingOutput.removeSubrange(...newline)
        }
        lock.unlock()

        for line in lines {
            guard let expression = try? NSRegularExpression(
                pattern: readyLinePattern
            ) else { continue }
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let match = expression.firstMatch(in: line, range: range),
                  match.numberOfRanges == 2,
                  let portRange = Range(match.range(at: 1), in: line),
                  let port = Int(line[portRange]),
                  (1...65_535).contains(port),
                  let url = URL(string: "http://\(loopbackHost):\(port)/")
            else {
                continue
            }
            onReady(url)
        }
    }

    private func consumeStandardError(_ data: Data) {
        guard !data.isEmpty,
              let text = String(data: data, encoding: .utf8)
        else {
            return
        }
        lock.lock()
        pendingStandardError.append(text)
        if pendingStandardError.utf8.count > 8_192 {
            pendingStandardError = String(pendingStandardError.suffix(4_096))
        }
        if pendingStandardError.contains("automatic_contribution_instance_active") {
            activeInstanceDetected = true
        }
        lock.unlock()
    }

    private func didTerminate(success: Bool) {
        lock.lock()
        process = nil
        let completions = stopCompletions
        stopCompletions.removeAll()
        let wasStopped = stopped
        let anotherInstanceIsActive = activeInstanceDetected
        lock.unlock()
        for completion in completions {
            completion()
        }
        onExit(success && wasStopped, anotherInstanceIsActive)
    }

    func stop(completion: @escaping () -> Void) {
        lock.lock()
        stopped = true
        guard let child = process, child.isRunning else {
            lock.unlock()
            completion()
            return
        }
        stopCompletions.append(completion)
        child.terminate()
        lock.unlock()

        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + 2
        ) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let shouldKill = self.process === child && child.isRunning
            self.lock.unlock()
            if shouldKill {
                _ = kill(child.processIdentifier, SIGKILL)
            }
        }
    }
}

private struct LocalKeychainResetResult: Decodable {
    struct AppState: Decodable {
        let allAppStateErased: Bool
        let contributionDeviceBinding: String
        let exportIdentityFileResidue: String
        let otherAppStateRetained: Bool
    }

    struct Keychain: Decodable {
        let contributionDevice: String
        let exportIdentity: String
        let secureErasureClaimed: Bool
    }

    struct Hosted: Decodable {
        let dataDeleted: Bool
        let deviceRevoked: Bool
    }

    let schemaVersion: String
    let status: String
    let failureCode: String?
    let appState: AppState
    let keychain: Keychain
    let hosted: Hosted

    var isValid: Bool {
        let itemStates = ["missing", "removed", "retained", "unknown"]
        let keychainStates = ["missing", "removed", "retained", "unknown"]
        let shapeValid =
            schemaVersion == "usage-monitor-local-keychain-reset-v1"
            && ["partial", "reset"].contains(status)
            && itemStates.contains(appState.contributionDeviceBinding)
            && itemStates.contains(appState.exportIdentityFileResidue)
            && keychainStates.contains(keychain.contributionDevice)
            && keychainStates.contains(keychain.exportIdentity)
            && appState.allAppStateErased == false
            && appState.otherAppStateRetained
            && keychain.secureErasureClaimed == false
            && hosted.dataDeleted == false
            && hosted.deviceRevoked == false
        guard shapeValid else { return false }
        if status == "reset" {
            return failureCode == nil
                && ["missing", "removed"].contains(
                    appState.contributionDeviceBinding
                )
                && ["missing", "removed"].contains(
                    appState.exportIdentityFileResidue
                )
                && ["missing", "removed"].contains(
                    keychain.contributionDevice
                )
                && ["missing", "removed"].contains(
                    keychain.exportIdentity
                )
        }
        return failureCode?.hasPrefix("UM_MACOS_") == true
    }

    var isCompleteReset: Bool {
        isValid && status == "reset"
    }
}

/// The dashboard is hosted inside the app, so this web view is the product's
/// primary surface. It is deliberately the narrowest possible browser: it may
/// load exactly one origin — the loopback companion this launcher started —
/// and every other destination is cancelled and handed to the user's own
/// browser instead. The app therefore gains no network reach it did not
/// already have: the companion still binds to loopback only, and nothing here
/// can fetch a remote origin.
@MainActor
private final class DashboardWebHost: NSObject, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandler {
    private let onLoaded: () -> Void
    private let onFailure: (String) -> Void
    private let onDownloadFailure: () -> Void
    private let openExternally: (URL) -> Void
    private let onNavigation: (String) -> Void
    private let onLanguagePreferenceChange:
        (TiboTattleLocalization.LanguagePreference) -> Void
    private var allowedPort: Int?
    private var pendingDashboardURL: URL?
    private var viewportPreparationAttempts = 0
    /// False while the view holds no dashboard, so the blank page loaded on
    /// teardown can never be reported as a dashboard that opened.
    private var hasDashboardTarget = false
    let webView: WKWebView

    init(
        onLoaded: @escaping () -> Void,
        onFailure: @escaping (String) -> Void,
        onDownloadFailure: @escaping () -> Void,
        openExternally: @escaping (URL) -> Void,
        onNavigation: @escaping (String) -> Void,
        onLanguagePreferenceChange: @escaping (
            TiboTattleLocalization.LanguagePreference
        ) -> Void
    ) {
        self.onLoaded = onLoaded
        self.onFailure = onFailure
        self.onDownloadFailure = onDownloadFailure
        self.openExternally = openExternally
        self.onNavigation = onNavigation
        self.onLanguagePreferenceChange = onLanguagePreferenceChange
        let configuration = WKWebViewConfiguration()
        // Nothing this surface stores survives the app. The hosted sign-in
        // token is already memory-only by design; a non-persistent store keeps
        // loopback cookies and local storage off disk as well.
        configuration.websiteDataStore = .nonPersistent()
        // The language preference can change while this host remains alive.
        // Install the first document-start scripts now, then refresh them
        // before every later local navigation. That gives a reloaded document
        // the current native preference without reloading the live document
        // merely because a person changed its language.
        Self.addDocumentStartScripts(
            to: configuration.userContentController
        )
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.add(
            self,
            name: "tibotattleLocalization"
        )
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setAccessibilityLabel(
            TiboTattleLocalization.string(.accessibilityLocalDashboard)
        )
        webView.translatesAutoresizingMaskIntoConstraints = false
    }

    private static func localizationHandoffScript() -> String {
        let payload: [String: Any] = [
            "schemaVersion": TiboTattleLocalization.schemaVersion,
            "host": "native",
            "table": TiboTattleLocalization.tableName,
            "fallbackLocale": TiboTattleLocalization.fallbackLocale,
            "supportedLocales": TiboTattleLocalization.supportedWebLocales,
            "languagePreference": TiboTattleLocalization.languagePreference
                .rawValue,
            "resolvedLocale": TiboTattleLocalization.selectedWebLocale,
            "preferredLanguages": Locale.preferredLanguages,
            "formatLocale": Locale.current.identifier,
            "resourceRoot": "./localization"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return "window.__TIBOTATTLE_LOCALIZATION__ = null;"
        }
        return "window.__TIBOTATTLE_LOCALIZATION__ = \(json);"
    }

    /// The AppKit frame owns navigation and refresh in the installed app.
    /// Install this fixed marker before any dashboard script runs so the
    /// public-web header cannot flash, or remain visible if WebKit delays a
    /// didFinish callback behind local dashboard work.
    private static func nativeShellMarkerScript() -> String {
        """
        (function () {
          function markNativeDashboard() {
            if (document.documentElement) {
              document.documentElement.classList.add('native-dashboard');
            }
            if (document.body) {
              document.body.classList.add('native-dashboard');
            }
          }
          markNativeDashboard();
          document.addEventListener('DOMContentLoaded', markNativeDashboard, { once: true });
        })();
        """
    }

    private static func addDocumentStartScripts(
        to controller: WKUserContentController
    ) {
        controller.addUserScript(
            WKUserScript(
                source: localizationHandoffScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        controller.addUserScript(
            WKUserScript(
                source: nativeShellMarkerScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
    }

    /// User scripts are copied into each document when it starts loading.
    /// Rebuilding this very small, app-owned script set immediately before a
    /// subsequent load prevents a stale `languagePreference` from winning
    /// after Settings changed it in an already-open dashboard. Script message
    /// handlers are independent from user scripts and remain registered.
    private func refreshDocumentStartScripts() {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        Self.addDocumentStartScripts(to: controller)
    }

    func load(_ url: URL) {
        guard url.scheme?.lowercased() == "http",
              url.host == loopbackHost,
              let port = url.port
        else {
            onFailure(LauncherError.healthCheck.failureCode)
            return
        }
        allowedPort = port
        hasDashboardTarget = true
        pendingDashboardURL = url
        viewportPreparationAttempts = 0
        loadWhenViewportIsReady()
    }

    /// WKWebView can commit a document before AppKit has given its split pane a
    /// usable size. On a cold launch that produces a loaded, but white,
    /// dashboard until the user manually resizes the window. Defer the first
    /// request for a few main-loop passes until the embedded viewport exists.
    private func loadWhenViewportIsReady() {
        guard hasDashboardTarget, let url = pendingDashboardURL else { return }
        webView.superview?.layoutSubtreeIfNeeded()
        webView.layoutSubtreeIfNeeded()
        let viewport = webView.bounds.integral
        guard viewport.width >= 120, viewport.height >= 120 else {
            guard viewportPreparationAttempts < 20 else {
                pendingDashboardURL = nil
                hasDashboardTarget = false
                onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
                return
            }
            viewportPreparationAttempts += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
                [weak self] in
                self?.loadWhenViewportIsReady()
            }
            return
        }
        pendingDashboardURL = nil
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        refreshDocumentStartScripts()
        webView.load(request)
    }

    func stop() {
        allowedPort = nil
        hasDashboardTarget = false
        pendingDashboardURL = nil
        viewportPreparationAttempts = 0
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    /// The fixed app URL never carries provider data. It is only a wake-up
    /// signal from the browser callback, so the already-loaded local document
    /// can collect the opaque result without being reloaded and losing its
    /// in-memory sign-in state.
    func notifyHostedSignInReturn() {
        guard hasDashboardTarget else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new Event('tibotattle:hosted-sign-in-return'));"
        )
    }

    /// Change the copy in the existing loopback document without reloading it.
    /// In particular, this must not disturb the in-memory hosted-sign-in
    /// handoff that is signalled separately above.
    func notifyLanguagePreferenceChange(
        _ preference: TiboTattleLocalization.LanguagePreference
    ) {
        guard hasDashboardTarget else { return }
        let payload: [String: String] = ["preference": preference.rawValue]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("""
        window.dispatchEvent(new CustomEvent('tibotattle:locale-override', {
          detail: \(json)
        }));
        """)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "tibotattleLocalization",
              message.frameInfo.isMainFrame,
              let payload = message.body as? [String: Any],
              payload["type"] as? String == "set-language-preference",
              let rawPreference = payload["preference"] as? String,
              let preference = TiboTattleLocalization.LanguagePreference(
                  rawValue: rawPreference
              )
        else {
            return
        }
        onLanguagePreferenceChange(preference)
    }

    private func isCompanionURL(_ url: URL) -> Bool {
        guard let allowedPort else { return false }
        return url.scheme?.lowercased() == "http"
            && url.host == loopbackHost
            && url.port == allowedPort
            && url.user == nil
            && url.password == nil
    }

    // MARK: - Navigation policy

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if isCompanionURL(url) || scheme == "about" || scheme == "blob" {
            if isCompanionURL(url),
               let fragment = url.fragment,
               !fragment.isEmpty {
                onNavigation(fragment)
            }
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openExternally(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard hasDashboardTarget else { return }
        // The local page keeps its public-web navigation when opened in a
        // browser. In the app, AppKit owns navigation and status so the
        // document can concentrate on the current page.
        webView.evaluateJavaScript("""
        document.body && document.body.classList.add('native-dashboard');
        (document.querySelector('#main')?.innerText || '').trim().length;
        """) { [weak self] value, error in
            guard let self, self.hasDashboardTarget else { return }
            let textLength = (value as? NSNumber)?.intValue ?? 0
            guard error == nil, textLength >= 32 else {
                self.hasDashboardTarget = false
                self.onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
                return
            }
            self.onLoaded()
        }
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard hasDashboardTarget else { return }
        hasDashboardTarget = false
        onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
    }

    private func reportNavigationFailure(_ error: Error) {
        // A navigation this delegate cancelled on purpose is not a failure.
        let failure = error as NSError
        guard hasDashboardTarget,
              failure.domain != NSURLErrorDomain
                || failure.code != NSURLErrorCancelled
        else {
            return
        }
        hasDashboardTarget = false
        onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
    }

    // MARK: - Window, dialog, and file affordances

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // A provider may request a new browser window. The app never embeds
        // remote origins, so hand it straight to the user's default browser
        // without a second native confirmation dialog.
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = BundledProduct.displayName
        alert.informativeText = message
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonOK))
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        // The dashboard confirms destructive actions this way, so a web view
        // without this panel would silently answer "no" to a deletion the user
        // asked for. It must be a real question.
        let alert = NSAlert()
        alert.messageText = BundledProduct.displayName
        alert.informativeText = message
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonContinue))
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    // MARK: - Downloads

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        completionHandler(Self.downloadsDestination(for: suggestedFilename))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        // A file that could not be saved is not a dashboard that failed, so
        // the open page is left exactly as it is.
        onDownloadFailure()
    }

    /// A page-supplied filename is untrusted, so only a bounded, separator-free
    /// basename is ever used, and an existing file is never overwritten.
    static func downloadsDestination(for suggestedFilename: String) -> URL? {
        let allowed = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let cleaned = String(
            suggestedFilename.unicodeScalars.filter(allowed.contains)
        )
        let stripped = cleaned.drop(while: { $0 == "." })
        let candidate = stripped.isEmpty
            ? "tibotattle-download"
            : String(stripped.prefix(120))
        guard let downloads = try? FileManager.default.url(
            for: .downloadsDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        ) else {
            return nil
        }
        let base = URL(fileURLWithPath: candidate)
        let stem = base.deletingPathExtension().lastPathComponent
        let suffix = base.pathExtension
        for attempt in 0...50 {
            let name = attempt == 0
                ? candidate
                : suffix.isEmpty
                    ? "\(stem)-\(attempt)"
                    : "\(stem)-\(attempt).\(suffix)"
            let destination = downloads.appendingPathComponent(
                name,
                isDirectory: false
            )
            if !FileManager.default.fileExists(atPath: destination.path) {
                return destination
            }
        }
        return nil
    }
}

@MainActor
private enum NativeDashboardDestination: String, CaseIterable {
    case overview
    case weekly
    case trends
    case method
    case community
    case data

    var title: String {
        switch self {
        case .overview:
            return TiboTattleLocalization.string(.nativeDashboardOverview)
        case .weekly:
            return TiboTattleLocalization.string(.nativeDashboardAllowance)
        case .trends:
            return TiboTattleLocalization.string(.nativeDashboardTrends)
        case .method:
            return TiboTattleLocalization.string(.nativeDashboardHowItWorks)
        case .community:
            return TiboTattleLocalization.string(.nativeDashboardCommunity)
        case .data:
            return TiboTattleLocalization.string(.nativeDashboardDataPrivacy)
        }
    }

    var symbolName: String {
        switch self {
        case .overview: return "rectangle.grid.1x2"
        case .weekly: return "chart.bar.xaxis"
        case .trends: return "chart.xyaxis.line"
        case .method: return "function"
        case .community: return "person.3"
        case .data: return "lock.shield"
        }
    }
}

/// `NSSplitView` owns the frame of each arranged pane.  A WKWebView is not a
/// reliable arranged child itself: on a live first launch, Auto Layout can
/// retain the zero frame it had before the split view received a window.  This
/// pane makes the ownership explicit and gives WebKit its final frame during
/// every AppKit layout pass.
@MainActor
private final class NativeDashboardReportPane: NSView {
    private let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = true
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.autoresizingMask = [.width, .height]
        fitWebViewToBounds()
        addSubview(webView)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layout() {
        super.layout()
        fitWebViewToBounds()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        fitWebViewToBounds()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        fitWebViewToBounds()
    }

    @discardableResult
    func fitWebViewToBounds() -> Bool {
        let frame = bounds.integral
        guard frame.width > 0, frame.height > 0 else { return false }
        webView.frame = frame
        webView.setNeedsDisplay(frame)
        return true
    }
}

/// The native frame for the loopback dashboard. WebKit remains responsible for
/// the rich charts and accessible, selectable report content. AppKit owns the
/// sidebar here, while the window's unified toolbar owns status, refresh,
/// sharing, and settings. Keeping that chrome outside WebKit preserves normal
/// Mac behavior without replacing the report itself.
@MainActor
private final class NativeDashboardChrome: NSView {
    private let sidebar = NSVisualEffectView()
    private let reportPane: NativeDashboardReportPane
    private var pageButtons: [NativeDashboardDestination: NSButton] = [:]

    var onNavigate: ((NativeDashboardDestination) -> Void)?

    init(webView: WKWebView) {
        reportPane = NativeDashboardReportPane(webView: webView)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        sidebar.material = .sidebar
        sidebar.blendingMode = .withinWindow
        sidebar.state = .active
        sidebar.translatesAutoresizingMaskIntoConstraints = false

        let pageStack = NSStackView()
        pageStack.orientation = .vertical
        pageStack.alignment = .leading
        pageStack.spacing = 3
        pageStack.edgeInsets = NSEdgeInsets(top: 18, left: 12, bottom: 18, right: 12)
        pageStack.translatesAutoresizingMaskIntoConstraints = false
        for destination in NativeDashboardDestination.allCases {
            let button = NSButton(
                title: destination.title,
                target: self,
                action: #selector(selectDestination(_:))
            )
            button.identifier = NSUserInterfaceItemIdentifier(destination.rawValue)
            button.image = NSImage(
                systemSymbolName: destination.symbolName,
                accessibilityDescription: destination.title
            )
            button.imagePosition = .imageLeading
            button.alignment = .left
            button.isBordered = false
            button.bezelStyle = .recessed
            button.contentTintColor = .secondaryLabelColor
            button.font = .systemFont(ofSize: 13, weight: .medium)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.heightAnchor.constraint(equalToConstant: 34).isActive = true
            button.widthAnchor.constraint(equalToConstant: 192).isActive = true
            pageStack.addArrangedSubview(button)
            pageButtons[destination] = button
        }
        sidebar.addSubview(pageStack)

        // Keep WebKit inside a pane that follows NSSplitView's frame directly.
        // This is intentionally not an Auto Layout relationship: AppKit
        // resizes split panes by changing their frames, and this pane mirrors
        // that frame to WebKit synchronously in `layout()`.
        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        split.addArrangedSubview(sidebar)
        split.addArrangedSubview(reportPane)
        split.setHoldingPriority(.defaultHigh, forSubviewAt: 0)
        split.setPosition(216, ofDividerAt: 0)

        addSubview(split)
        NSLayoutConstraint.activate([
            pageStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            pageStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            pageStack.topAnchor.constraint(equalTo: sidebar.topAnchor),
            split.leadingAnchor.constraint(equalTo: leadingAnchor),
            split.trailingAnchor.constraint(equalTo: trailingAnchor),
            split.topAnchor.constraint(equalTo: topAnchor),
            split.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebar.widthAnchor.constraint(greaterThanOrEqualToConstant: 190),
            sidebar.widthAnchor.constraint(lessThanOrEqualToConstant: 250),
        ])
        select(.overview)
    }

    required init?(coder: NSCoder) {
        nil
    }

    func select(_ destination: NativeDashboardDestination) {
        for (candidate, button) in pageButtons {
            let selected = candidate == destination
            button.state = selected ? .on : .off
            button.contentTintColor = selected
                ? .controlAccentColor
                : .secondaryLabelColor
            button.font = .systemFont(
                ofSize: 13,
                weight: selected ? .semibold : .medium
            )
        }
    }

    func refreshLocalization() {
        for (destination, button) in pageButtons {
            button.title = destination.title
            button.image = NSImage(
                systemSymbolName: destination.symbolName,
                accessibilityDescription: destination.title
            )
        }
    }
    @discardableResult
    func prepareReportViewport() -> Bool {
        window?.contentView?.layoutSubtreeIfNeeded()
        layoutSubtreeIfNeeded()
        reportPane.layoutSubtreeIfNeeded()
        return reportPane.fitWebViewToBounds()
    }
    @objc private func selectDestination(_ sender: NSButton) {
        guard let rawValue = sender.identifier?.rawValue,
              let destination = NativeDashboardDestination(rawValue: rawValue)
        else {
            return
        }
        select(destination)
        onNavigate?(destination)
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate,
    NSWindowDelegate, NSToolbarDelegate {
    private let semanticOpenTarget: SemanticOpenTarget
    private let updater = AppUpdater()
    private var centralService: CentralServiceConfiguration?
    private var centralServiceMode: CentralServiceMode?
    private var codexHomeConfiguration: CodexHomeConfiguration?
    private var companion: CompanionProcess?
    private var dashboardURL: URL?
    private var firstRunAcknowledged = false
    private var keychainResetProcess: Process?
    private var launchGeneration = 0
    private var pendingDashboardOpen = false
    private var quitting = false
    private var retryAllowed = true
    private var startupTimeout: DispatchWorkItem?
    private var window: NSWindow?
    private var lastLifecycleStatus = "Starting"
    private var lastFailureCode: String?
    private var lastRecoverySuggestion: String?
    private var menuBarStatus: MenuBarStatusController?
    private var settingsWindow: NSWindow?
    private var settingsTabs: NSTabViewController?
    private weak var settingsCodexHomeLabel: NSTextField?
    private weak var settingsAutomaticUpdatesSwitch: NSSwitch?
    private weak var settingsAutomaticUpdatesDetailLabel: NSTextField?
    private weak var settingsAboutAutomaticUpdatesDetailLabel: NSTextField?
    private weak var settingsCheckForUpdatesButton: NSButton?
    private weak var settingsStartAtLoginSwitch: NSSwitch?
    private weak var settingsStartAtLoginDetailLabel: NSTextField?
    private weak var settingsStartAtLoginPendingRemovalButton: NSButton?
    private weak var settingsStartAtLoginRefreshButton: NSButton?
    private var lastLoginItemDiagnosticAction: LoginItemDiagnosticAction = .none
    private var loginItemOperationInFlight = false
    private weak var settingsQuotaNotificationsSwitch: NSSwitch?
    private weak var settingsQuotaNotificationThresholds: NSSegmentedControl?
    private weak var settingsQuotaNotificationResetSwitch: NSSwitch?
    private weak var settingsQuotaNotificationStatusLabel: NSTextField?
    private let nativeEvidenceReader = LocalCompanionEvidenceReader()
    private var quotaNotificationCoordinator: QuotaNotificationCoordinator?
    private var nativeDashboardChrome: NativeDashboardChrome?
    private weak var nativeToolbarStatusLabel: NSTextField?
    private weak var nativeRefreshToolbarItem: NSToolbarItem?
    private weak var nativeShareToolbarItem: NSToolbarItem?
    private var nativeRefreshPoll: DispatchWorkItem?
    private var nativeRefreshSchedule: DispatchWorkItem?
    private var nativeRefreshInFlight = false
    /// Opaque companion token for the particular refresh this surface started
    /// or joined. It is never persisted or exposed in UI/notification text.
    private var nativeRefreshID: String?
    private static let nativeRefreshIntervalSeconds = 300
    private static let toolbarStatusIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-status"
    )
    private static let toolbarRefreshIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-refresh"
    )
    private static let toolbarShareIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-share"
    )
    private static let toolbarSettingsIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-settings"
    )
    private let statusLabel = NSTextField(labelWithString:
        TiboTattleLocalization.string(.launcherStartingLocally))
    private let detailLabel = NSTextField(
        wrappingLabelWithString:
            TiboTattleLocalization.string(
                .launcherDetailPreparingLocalDashboard
            )
    )
    private let privacyLabel = NSTextField(
        labelWithString:
            TiboTattleLocalization.string(
                .launcherPrivacyForegroundOnly
            )
    )
    private lazy var openButton = NSButton(
        title: TiboTattleLocalization.string(.settingsOpenDashboard),
        target: self,
        action: #selector(openDashboard)
    )
    private lazy var retryButton = NSButton(
        title: TiboTattleLocalization.string(.launcherRetry),
        target: self,
        action: #selector(retryCompanion)
    )
    private lazy var settingsButton = NSButton(
        title: TiboTattleLocalization.string(.menuSettings),
        target: self,
        action: #selector(showSettingsWindow)
    )
    private lazy var diagnosticsButton = NSButton(
        title: TiboTattleLocalization.string(.launcherDataDiagnostics),
        target: self,
        action: #selector(showDiagnostics)
    )
    private lazy var codexHomeButton = NSButton(
        title: TiboTattleLocalization.string(.settingsChooseCodexFolder),
        target: self,
        action: #selector(showCodexHomeOptions)
    )
    private lazy var openInBrowserButton = NSButton(
        title: TiboTattleLocalization.string(.launcherOpenInBrowser),
        target: self,
        action: #selector(openDashboardInBrowser)
    )
    private lazy var quitButton = NSButton(
        title: TiboTattleLocalization.format(
            .menuQuitProduct,
            BundledProduct.displayName
        ),
        target: self,
        action: #selector(quitApplication)
    )
    private let statusStack = NSStackView()
    private let dashboardContainer = NSView()
    private let actionRow = NSStackView()
    private var dashboardWebHost: DashboardWebHost?
    private var dashboardWebViewShowing = false

    private let loginItemManager: LoginItemManaging

    init(
        semanticOpenTarget: SemanticOpenTarget,
        loginItemManager: LoginItemManaging = SystemLoginItemManager()
    ) {
        self.semanticOpenTarget = semanticOpenTarget
        self.loginItemManager = loginItemManager
        super.init()
        updater.onStateChange = { [weak self] in
            self?.updateUpdaterPresentation()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = umask(0o077)
        installApplicationMenu()
        createWindow()
        // Installed before any early return below so a launch that fails still
        // leaves a visible, quittable presence in the menu bar.
        installMenuBarStatus()
        do {
            centralService = try CentralServiceConfiguration.bundled()
            codexHomeConfiguration = try loadCodexHomeConfiguration(
                stateRoot: ownerOnlyStateRoot()
            )
        } catch {
            retryAllowed = ![
                LauncherError.invalidCentralService.failureCode,
                LauncherError.invalidCodexHomeSettings.failureCode,
            ].contains((error as? LauncherError)?.failureCode)
            showFailure(error)
            return
        }
        do {
            let stateRoot = try ownerOnlyStateRoot()
            if try !hasCompletedFirstRun(stateRoot: stateRoot) {
                guard showFirstRunDisclosure() else {
                    NSApp.terminate(nil)
                    return
                }
                try markFirstRunCompleted(stateRoot: stateRoot)
            }
            let notificationCoordinator = QuotaNotificationCoordinator(
                stateStore: OwnerOnlyQuotaNotificationStateStore(
                    stateRoot: stateRoot
                ),
                notificationCenter: UNUserNotificationCenterAdapter()
            )
            notificationCoordinator.onPresentationChange = { [weak self] in
                self?.updateQuotaNotificationSettingsControls()
            }
            quotaNotificationCoordinator = notificationCoordinator
            // This reads the current system setting only. The permission
            // dialog is requested later, and only after a Settings opt-in.
            notificationCoordinator.refreshAuthorization()
            firstRunAcknowledged = true
            // Sparkle is intentionally started only after the first-run
            // disclosure has been accepted, including for releases that
            // default to automatic download/install-on-quit.
            updater.startAfterFirstRunDisclosure()
        } catch {
            let launcherError = error as? LauncherError
            retryAllowed = ![
                LauncherError.invalidFirstRunState.failureCode,
                LauncherError.firstRunStateWrite.failureCode,
            ].contains(launcherError?.failureCode)
            showFailure(error)
            return
        }
        centralServiceMode = centralService?.mode
        startCompanion()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // System Settings is the recovery surface for approval and external
        // changes. Refresh when the person returns so the Settings switch is
        // not a stale cached preference.
        updateStartAtLoginSettingsControl()
        // Read-only resynchronization after a user changes notification
        // permission in System Settings. This path cannot prompt by itself.
        quotaNotificationCoordinator?.refreshAuthorization()
    }

    private func showFirstRunDisclosure() -> Bool {
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.format(
            .launcherWelcome,
            BundledProduct.displayName
        )
        alert.informativeText = """
        \(BundledProduct.displayName) updates local \(BundledProduct.monitoredAppDisplayName) metadata while the app is open. The first pass starts after setup; later checks reuse the same bounded local companion.

        Reads: timestamps, model and speed labels, token counters, tool categories, and quota snapshots from the selected \(BundledProduct.monitoredAppDisplayName) sessions folders.

        Stores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only \(BundledProduct.displayName) app-data folder.

        Community contribution is optional. It stays off until you review the content-free fields and explicitly send a contribution.

        Local allowance notifications are also off by default. If you later enable them in Settings, threshold alerts stay on this Mac and evaluate only fresh provider-reported quota observations from the existing foreground refresh. Reset alerts remain unavailable until the provider supplies an explicit reset identity; reset schedules alone never alert. They do not add a timer, daemon, login item, or background network polling.

        \(updater.firstRunUpdatesDisclosure)

        Never contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.

        Keep the app open while analysis runs. You may close and reopen the TiboTattle window; quitting the app stops the current pass and preserves completed checkpoints.

        \(TiboTattleLocalization.string(.firstRunLoginItemDisclosure))
        """
        let startAtLogin = NSButton(
            checkboxWithTitle: TiboTattleLocalization.string(
                .settingsStartAtLogin
            ),
            target: nil,
            action: nil
        )
        startAtLogin.state = .on
        startAtLogin.frame = NSRect(x: 0, y: 0, width: 400, height: 24)
        startAtLogin.toolTip = TiboTattleLocalization.string(
            .settingsStartAtLoginSummary
        )
        startAtLogin.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsStartAtLogin)
        )
        alert.accessoryView = startAtLogin
        alert.addButton(
            withTitle: TiboTattleLocalization.string(.launcherGetStarted)
        )
        alert.addButton(withTitle: TiboTattleLocalization.format(
            .menuQuitProduct,
            BundledProduct.displayName
        ))
        guard alert.runModal() == .alertFirstButtonReturn else {
            return false
        }

        // Registration is deliberately downstream of the affirmative Get
        // Started action.  Existing first-run receipts take the path above
        // only to acknowledge state and never register silently on upgrade.
        if startAtLogin.state == .on {
            do {
                try registerLoginItemForFirstRun(
                    startAtLogin: true,
                    manager: loginItemManager
                )
                let result = loginItemOperationResult(
                    operation: .register,
                    status: observeLoginItemStatus()
                )
                lastLoginItemDiagnosticAction = LoginItemDiagnosticAction.make(
                    operation: .register,
                    result: result
                )
                showLoginItemOperationResult(
                    result,
                    operation: .register,
                    allowContinue: true
                )
            } catch {
                if let reconciled = reconciledLoginItemOperationResultAfterError(
                    operation: .register,
                    status: observeLoginItemStatus()
                ) {
                    lastLoginItemDiagnosticAction =
                        LoginItemDiagnosticAction.make(
                            operation: .register,
                            result: reconciled
                        )
                    showLoginItemOperationResult(
                        reconciled,
                        operation: .register,
                        allowContinue: true
                    )
                    return true
                }
                lastLoginItemDiagnosticAction = .registerFailed
                showLoginItemOperationFailure(
                    operation: .register,
                    allowContinue: true
                )
            }
        }
        return true
    }

    private func startCompanion() {
        guard !quitting, retryAllowed, firstRunAcknowledged,
              let codexHomeConfiguration
        else { return }
        startupTimeout?.cancel()
        launchGeneration += 1
        let selectedGeneration = launchGeneration
        dashboardURL = nil
        lastLifecycleStatus = "Starting"
        lastFailureCode = nil
        lastRecoverySuggestion = nil
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherStartingLocally
        )
        detailLabel.stringValue =
            TiboTattleLocalization.string(
                .launcherDetailPreparingLocalDashboard
            )
        openButton.isEnabled = false
        openInBrowserButton.isEnabled = false
        retryButton.isEnabled = false
        hideDashboardWebView()
        menuBarStatus?.companionStarting()
        let process = CompanionProcess(
            centralService: centralService,
            codexHome: codexHomeConfiguration.url,
            onReady: { [weak self] url in
                DispatchQueue.main.async {
                    self?.companionReady(
                        url,
                        generation: selectedGeneration
                    )
                }
            },
            onExit: { [weak self] requested, anotherInstanceIsActive in
                DispatchQueue.main.async {
                    self?.companionExited(
                        requested: requested,
                        anotherInstanceIsActive: anotherInstanceIsActive,
                        generation: selectedGeneration
                    )
                }
            }
        )
        companion = process
        do {
            try process.launch()
            let timeout = DispatchWorkItem { [weak self, weak process] in
                guard let self,
                      let process,
                      selectedGeneration == self.launchGeneration,
                      self.dashboardURL == nil,
                      self.companion === process,
                      !self.quitting
                else {
                    return
                }
                self.launchGeneration += 1
                self.companion = nil
                process.stop {}
                self.showFailure(LauncherError.companionTimeout)
            }
            startupTimeout = timeout
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .seconds(
                    companionStartupTimeoutSeconds
                ),
                execute: timeout
            )
        } catch {
            companion = nil
            showFailure(error)
        }
    }

    private func createWindow() {
        statusLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        statusLabel.textColor = .labelColor

        detailLabel.font = .systemFont(ofSize: 13)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 4

        privacyLabel.font = .systemFont(ofSize: 11, weight: .medium)
        privacyLabel.textColor = .tertiaryLabelColor

        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.isEnabled = false

        retryButton.bezelStyle = .rounded
        retryButton.isEnabled = false

        openInBrowserButton.bezelStyle = .rounded
        openInBrowserButton.isEnabled = false
        openInBrowserButton.toolTip =
            TiboTattleLocalization.string(.launcherOpenBrowserTooltip)

        for button in [
            settingsButton,
            diagnosticsButton,
            codexHomeButton,
            quitButton,
        ] {
            button.bezelStyle = NSButton.BezelStyle.rounded
        }

        // The status stack collapses while the dashboard is on screen and
        // returns whenever the dashboard cannot be shown, so the lifecycle
        // message is never replaced by a blank web view.
        statusStack.orientation = .vertical
        statusStack.alignment = .leading
        statusStack.spacing = 12
        statusStack.setHuggingPriority(.defaultHigh, for: .vertical)
        for label in [statusLabel, detailLabel, privacyLabel] {
            statusStack.addArrangedSubview(label)
            label.setContentCompressionResistancePriority(
                .defaultLow,
                for: .horizontal
            )
        }

        dashboardContainer.translatesAutoresizingMaskIntoConstraints = false
        dashboardContainer.isHidden = true
        dashboardContainer.setContentHuggingPriority(.defaultLow, for: .vertical)

        // The recovery controls are visible while starting or recovering. A
        // ready dashboard owns the whole content area; Quit and Settings
        // remain in the normal macOS menu and the status item rather than
        // being repeated in a browser-style footer.
        actionRow.orientation = .horizontal
        actionRow.spacing = 10
        actionRow.setHuggingPriority(.defaultHigh, for: .vertical)
        for button in [
            quitButton,
            settingsButton,
        ] {
            actionRow.addView(button, in: .leading)
        }
        for button in [
            retryButton,
            openButton,
        ] {
            actionRow.addView(button, in: .trailing)
        }

        let layout = NSStackView()
        layout.orientation = .vertical
        layout.alignment = .leading
        layout.spacing = 16
        layout.edgeInsets = NSEdgeInsets(
            top: 24,
            left: 28,
            bottom: 24,
            right: 28
        )
        layout.translatesAutoresizingMaskIntoConstraints = false
        layout.addArrangedSubview(statusStack)
        layout.addArrangedSubview(dashboardContainer)
        layout.addArrangedSubview(actionRow)

        let content = NSView()
        content.addSubview(layout)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            layout.topAnchor.constraint(equalTo: content.topAnchor),
            layout.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusStack.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            dashboardContainer.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            actionRow.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
        ])

        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        newWindow.title = BundledProduct.displayName
        newWindow.toolbar = makeDashboardToolbar()
        newWindow.toolbarStyle = .unified
        newWindow.contentView = content
        newWindow.contentMinSize = NSSize(width: 900, height: 420)
        newWindow.isReleasedWhenClosed = false
        newWindow.delegate = self
        newWindow.center()
        newWindow.makeKeyAndOrderFront(nil)
        window = newWindow
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeDashboardToolbar() -> NSToolbar {
        let toolbar = NSToolbar(
            identifier: "com.usagemonitor.local.dashboard-toolbar"
        )
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false
        return toolbar
    }

    func toolbarAllowedItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        [
            .flexibleSpace,
            Self.toolbarStatusIdentifier,
            Self.toolbarRefreshIdentifier,
            Self.toolbarShareIdentifier,
            Self.toolbarSettingsIdentifier,
        ]
    }

    func toolbarDefaultItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        [
            Self.toolbarStatusIdentifier,
            .flexibleSpace,
            Self.toolbarRefreshIdentifier,
            Self.toolbarShareIdentifier,
            Self.toolbarSettingsIdentifier,
        ]
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case Self.toolbarStatusIdentifier:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = TiboTattleLocalization.string(.nativeDashboardStatus)
            item.toolTip = TiboTattleLocalization.string(
                .nativeDashboardCurrentEvidenceTooltip
            )
            let label = NSTextField(labelWithString: TiboTattleLocalization.string(
                .launcherStartingLocally
            ))
            label.font = .systemFont(ofSize: 12, weight: .medium)
            label.textColor = .secondaryLabelColor
            label.lineBreakMode = .byTruncatingTail
            label.maximumNumberOfLines = 1
            label.toolTip = TiboTattleLocalization.string(
                .nativeDashboardCurrentEvidenceTooltip
            )
            label.setAccessibilityLabel(TiboTattleLocalization.string(
                .nativeDashboardCurrentEvidenceTooltip
            ))
            label.setContentCompressionResistancePriority(
                .defaultLow,
                for: .horizontal
            )
            label.widthAnchor.constraint(
                greaterThanOrEqualToConstant: 160
            ).isActive = true
            label.widthAnchor.constraint(
                lessThanOrEqualToConstant: 280
            ).isActive = true
            label.heightAnchor.constraint(equalToConstant: 24).isActive = true
            item.view = label
            nativeToolbarStatusLabel = label
            return item
        case Self.toolbarRefreshIdentifier:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = TiboTattleLocalization.string(
                .nativeDashboardRefreshUsage
            )
            item.toolTip = TiboTattleLocalization.string(
                .nativeDashboardRefreshUsageTooltip
            )
            item.image = NSImage(
                systemSymbolName: "arrow.clockwise",
                accessibilityDescription: TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
            )
            item.target = self
            item.action = #selector(refreshDashboardFromToolbar)
            item.isEnabled = false
            nativeRefreshToolbarItem = item
            return item
        case Self.toolbarShareIdentifier:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = TiboTattleLocalization.string(.nativeDashboardShare)
            item.toolTip = TiboTattleLocalization.string(
                .nativeDashboardShareTooltip
            )
            item.image = NSImage(
                systemSymbolName: "square.and.arrow.up",
                accessibilityDescription: TiboTattleLocalization.string(
                    .nativeDashboardShareTooltip
                )
            )
            item.target = self
            item.action = #selector(showShareCardFromToolbar)
            item.isEnabled = false
            nativeShareToolbarItem = item
            return item
        case Self.toolbarSettingsIdentifier:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = TiboTattleLocalization.string(.menuSettings)
            item.image = NSImage(
                systemSymbolName: "gearshape",
                accessibilityDescription: TiboTattleLocalization.string(
                    .menuSettings
                )
            )
            item.target = self
            item.action = #selector(showSettingsWindow)
            return item
        default:
            return nil
        }
    }

    private func updateNativeToolbar(
        title: String,
        isRefreshing: Bool,
        refreshEnabled: Bool
    ) {
        nativeToolbarStatusLabel?.stringValue = title
        nativeRefreshToolbarItem?.label = isRefreshing
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : TiboTattleLocalization.string(.nativeDashboardRefreshUsage)
        nativeRefreshToolbarItem?.toolTip = isRefreshing
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : TiboTattleLocalization.string(
                .nativeDashboardRefreshUsageTooltip
            )
        nativeRefreshToolbarItem?.image = NSImage(
            systemSymbolName: isRefreshing
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: isRefreshing
                ? TiboTattleLocalization.string(.nativeDashboardUpdating)
                : TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
        )
        nativeRefreshToolbarItem?.isEnabled = refreshEnabled && !isRefreshing
        nativeShareToolbarItem?.isEnabled = dashboardWebViewShowing
    }

    private func refreshNativeToolbarLocalization() {
        nativeToolbarStatusLabel?.toolTip = TiboTattleLocalization.string(
            .nativeDashboardCurrentEvidenceTooltip
        )
        nativeToolbarStatusLabel?.setAccessibilityLabel(
            TiboTattleLocalization.string(
                .nativeDashboardCurrentEvidenceTooltip
            )
        )
        nativeRefreshToolbarItem?.label = nativeRefreshInFlight
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : TiboTattleLocalization.string(.nativeDashboardRefreshUsage)
        nativeRefreshToolbarItem?.toolTip = nativeRefreshInFlight
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : TiboTattleLocalization.string(
                .nativeDashboardRefreshUsageTooltip
            )
        nativeRefreshToolbarItem?.image = NSImage(
            systemSymbolName: nativeRefreshInFlight
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: nativeRefreshInFlight
                ? TiboTattleLocalization.string(.nativeDashboardUpdating)
                : TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
        )
        nativeShareToolbarItem?.label = TiboTattleLocalization.string(
            .nativeDashboardShare
        )
        nativeShareToolbarItem?.toolTip = TiboTattleLocalization.string(
            .nativeDashboardShareTooltip
        )
    }

    @objc private func refreshDashboardFromToolbar() {
        // This reuses the existing foreground-only Node companion path. The
        // toolbar never starts a helper, daemon, or separate background task.
        refreshLocalUsage(automatic: false)
    }

    @objc private func showShareCardFromToolbar() {
        guard dashboardWebViewShowing,
              let webView = dashboardWebHost?.webView
        else {
            return
        }
        nativeDashboardChrome?.select(.overview)
        // This is a closed local navigation: it exposes the report's already
        // rendered, privacy-reviewed share card and does not generate a new
        // process, read path, or native-to-JavaScript capability.
        webView.evaluateJavaScript("""
        if (window.location.hash !== '#overview') {
          window.location.hash = '#overview';
        } else {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        window.setTimeout(function () {
          document.getElementById('share-panel')?.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
        }, 0);
        """)
    }

    /// The dashboard runs inside a native AppKit shell.  The HTML stays a
    /// local report surface, while page selection and refresh are normal Mac
    /// controls rather than more web chrome inside a launcher.
    private func showDashboardWebView(_ url: URL) {
        let host = dashboardWebHost ?? {
            let created = DashboardWebHost(
                onLoaded: { [weak self] in self?.dashboardWebViewLoaded() },
                onFailure: { [weak self] code in
                    self?.dashboardWebViewFailed(code: code)
                },
                onDownloadFailure: { [weak self] in
                    self?.reportDashboardDownloadFailure()
                },
                openExternally: { [weak self] link in
                    self?.openExternalDashboardLink(link)
                },
                onNavigation: { [weak self] rawDestination in
                    self?.selectNativeDashboardDestination(rawDestination)
                },
                onLanguagePreferenceChange: { [weak self] preference in
                    self?.changeLanguagePreference(preference)
                }
            )
            let chrome = NativeDashboardChrome(webView: created.webView)
            chrome.onNavigate = { [weak self] destination in
                self?.navigateNativeDashboard(to: destination)
            }
            dashboardContainer.addSubview(chrome)
            NSLayoutConstraint.activate([
                chrome.leadingAnchor.constraint(
                    equalTo: dashboardContainer.leadingAnchor
                ),
                chrome.trailingAnchor.constraint(
                    equalTo: dashboardContainer.trailingAnchor
                ),
                chrome.topAnchor.constraint(
                    equalTo: dashboardContainer.topAnchor
                ),
                chrome.bottomAnchor.constraint(
                    equalTo: dashboardContainer.bottomAnchor
                ),
                chrome.heightAnchor.constraint(
                    greaterThanOrEqualToConstant: 320
                ),
            ])
            dashboardWebHost = created
            nativeDashboardChrome = chrome
            return created
        }()
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherOpeningDashboard
        )
        detailLabel.stringValue =
            TiboTattleLocalization.string(.launcherLoadingPrivateDashboard)
        updateNativeToolbar(
            title: nativeRefreshInFlight
                ? TiboTattleLocalization.string(.nativeDashboardUpdating)
                : TiboTattleLocalization.string(.nativeDashboardStarting),
            isRefreshing: nativeRefreshInFlight,
            refreshEnabled: dashboardURL != nil
        )
        // Show the native frame before WebKit completes the report document.
        // If the loopback page fails, dashboardWebViewFailed restores the
        // status surface; otherwise didFinish makes the report first responder.
        dashboardContainer.isHidden = false
        statusStack.isHidden = true
        actionRow.isHidden = true
        // Force the split pane through an AppKit layout pass before the first
        // local request. Without this, WebKit can load at a zero-sized viewport
        // and remain blank until the user resizes the window.
        window?.contentView?.layoutSubtreeIfNeeded()
        dashboardContainer.layoutSubtreeIfNeeded()
        _ = nativeDashboardChrome?.prepareReportViewport()
        host.load(url)
    }

    private func dashboardWebViewLoaded() {
        dashboardWebViewShowing = true
        dashboardContainer.isHidden = false
        statusStack.isHidden = true
        actionRow.isHidden = true
        lastLifecycleStatus = "Dashboard open"
        openInBrowserButton.isEnabled = true
        updateNativeToolbar(
            title: nativeRefreshInFlight
                ? "Updating local usage…"
                : "Local report ready",
            isRefreshing: nativeRefreshInFlight,
            refreshEnabled: dashboardURL != nil
        )
        // WKWebView follows the normal responder chain only once it owns focus.
        // This makes Cmd-C / Cmd-A act on selected dashboard text, just as they
        // do in a browser, instead of silently targeting the launcher window.
        if let webView = dashboardWebHost?.webView {
            window?.makeFirstResponder(webView)
        }
    }

    private func navigateNativeDashboard(to destination: NativeDashboardDestination) {
        nativeDashboardChrome?.select(destination)
        guard let webView = dashboardWebHost?.webView else { return }
        // Destinations are a closed enum, so interpolation cannot introduce
        // page-provided script content into this privileged bridge.
        let hash = destination.rawValue
        webView.evaluateJavaScript("""
        if (window.location.hash !== '#\(hash)') {
          window.location.hash = '#\(hash)';
        } else {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        """)
    }

    private func selectNativeDashboardDestination(_ rawDestination: String) {
        guard let destination = NativeDashboardDestination(
            rawValue: rawDestination
        ) else {
            return
        }
        nativeDashboardChrome?.select(destination)
    }

    /// Updates are automatic only while the ordinary app is open. A login
    /// item (if enabled) launches that same foreground app; it never starts a
    /// separate worker, daemon, or background URL session. The same bounded
    /// loopback refresh route remains the only reader, so a manual click and
    /// the foreground cadence cannot start two scans at once.
    private func refreshLocalUsage(automatic: Bool) {
        guard !quitting,
              !nativeRefreshInFlight,
              let dashboardURL
        else {
            return
        }
        cancelNativeRefreshSchedule()
        nativeRefreshInFlight = true
        updateNativeToolbar(
            title: automatic
                ? TiboTattleLocalization.string(.launcherUpdatingAutomatically)
                : TiboTattleLocalization.string(.nativeDashboardUpdating),
            isRefreshing: true,
            refreshEnabled: false
        )
        nativeEvidenceReader.startAnalysis(base: dashboardURL) { [weak self] result in
            guard let self, !self.quitting else { return }
            switch result {
            case let .started(refreshID), let .alreadyRunning(refreshID):
                self.nativeRefreshID = refreshID
                self.pollNativeRefresh(base: dashboardURL, remainingAttempts: 120)
            case .rejected:
                self.quotaNotificationCoordinator?.recordIneligible(
                    .refreshFailed
                )
                self.finishNativeRefresh(
                    title: TiboTattleLocalization.string(
                        .launcherUpdateUnavailable
                    ),
                    refreshEnabled: true
                )
            case .unreachable:
                self.quotaNotificationCoordinator?.recordIneligible(
                    .providerUnavailable
                )
                self.finishNativeRefresh(
                    title: TiboTattleLocalization.string(
                        .launcherCompanionUnavailable
                    ),
                    refreshEnabled: false
                )
            }
        }
    }

    private func pollNativeRefresh(base: URL, remainingAttempts: Int) {
        cancelNativeRefreshPoll()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.quitting, self.nativeRefreshInFlight else {
                return
            }
            self.nativeEvidenceReader.readAnalysisActivity(base: base) { [weak self] activity in
                guard let self, !self.quitting, self.nativeRefreshInFlight else {
                    return
                }
                let terminalRefreshID: String?
                switch activity {
                case .running:
                    terminalRefreshID = nil
                    if remainingAttempts > 0 {
                        self.pollNativeRefresh(
                            base: base,
                            remainingAttempts: remainingAttempts - 1
                        )
                        return
                    }
                case let .idle(refreshID):
                    terminalRefreshID = refreshID
                case .none:
                    terminalRefreshID = nil
                }
                self.nativeEvidenceReader.readOverview(base: base) { [weak self] overview in
                    guard let self, !self.quitting else { return }
                    let title: String
                    if let overview,
                       LocalCompanionOverviewProjection.evidence(
                        for: overview
                       ) == .live {
                        title = TiboTattleLocalization.string(.launcherUpToDate)
                    } else if overview?.lanes.isEmpty == false {
                        title = TiboTattleLocalization.string(
                            .launcherNeedsAttention
                        )
                    } else {
                        title = TiboTattleLocalization.string(
                            .launcherNoAllowanceObserved
                        )
                    }
                    let expectedRefreshID = terminalRefreshID == self.nativeRefreshID
                        ? self.nativeRefreshID
                        : nil
                    self.evaluateQuotaNotificationsAfterRefresh(
                        base: base,
                        expectedRefreshID: expectedRefreshID
                    )
                    self.finishNativeRefresh(title: title, refreshEnabled: true)
                }
            }
        }
        nativeRefreshPoll = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(750),
            execute: work
        )
    }

    private func finishNativeRefresh(title: String, refreshEnabled: Bool) {
        nativeRefreshInFlight = false
        nativeRefreshID = nil
        cancelNativeRefreshPoll()
        updateNativeToolbar(
            title: title,
            isRefreshing: false,
            refreshEnabled: refreshEnabled
        )
        scheduleNativeRefresh()
    }

    /// The notification coordinator only observes the terminal receipt from
    /// this pre-existing foreground refresh. It never starts a refresh,
    /// schedules a wake-up, or reads dashboard/ledger state as a substitute.
    private func evaluateQuotaNotificationsAfterRefresh(
        base: URL? = nil,
        expectedRefreshID: String? = nil
    ) {
        guard !quitting,
              let quotaNotificationCoordinator,
              let refreshBase = base ?? dashboardURL
        else {
            return
        }
        guard let expectedRefreshID else {
            quotaNotificationCoordinator.recordIneligible(.unobserved)
            return
        }
        quotaNotificationCoordinator.evaluate(
            using: nativeEvidenceReader,
            base: refreshBase,
            expectedRefreshID: expectedRefreshID
        )
    }

    private func cancelNativeRefreshPoll() {
        nativeRefreshPoll?.cancel()
        nativeRefreshPoll = nil
    }

    /// The foreground app keeps its own local evidence current while a
    /// login-item launch (if enabled) remains only an explicit app start. A
    /// five-minute cadence is intentionally modest: it observes new Codex
    /// rollouts while avoiding a permanent parser loop or hidden worker.
    private func scheduleNativeRefresh() {
        cancelNativeRefreshSchedule()
        guard !quitting, dashboardURL != nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.refreshLocalUsage(automatic: true)
        }
        nativeRefreshSchedule = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .seconds(Self.nativeRefreshIntervalSeconds),
            execute: work
        )
    }

    private func cancelNativeRefreshSchedule() {
        nativeRefreshSchedule?.cancel()
        nativeRefreshSchedule = nil
    }

    /// The launcher has a native window as well as a web dashboard. Supplying
    /// a standard Edit menu gives WebKit's responder chain its expected Copy
    /// and Select All commands, including their familiar keyboard shortcuts.
    private func installApplicationMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: BundledProduct.displayName)
        let about = NSMenuItem(
            title: TiboTattleLocalization.format(
                .menuAboutProduct,
                BundledProduct.displayName
            ),
            action: #selector(showAbout),
            keyEquivalent: ""
        )
        about.target = self
        appMenu.addItem(about)
        let settings = NSMenuItem(
            title: TiboTattleLocalization.string(.menuSettings),
            action: #selector(showSettingsWindow),
            keyEquivalent: ","
        )
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(
            title: TiboTattleLocalization.format(
                .menuQuitProduct,
                BundledProduct.displayName
            ),
            action: #selector(quitApplication),
            keyEquivalent: "q"
        )
        quit.target = self
        appMenu.addItem(quit)
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: TiboTattleLocalization.string(.menuEdit))
        let selectAll = NSMenuItem(
            title: TiboTattleLocalization.string(.menuSelectAll),
            action: Selector(("selectAll:")),
            keyEquivalent: "a"
        )
        selectAll.target = nil
        let copy = NSMenuItem(
            title: TiboTattleLocalization.string(.menuCopy),
            action: Selector(("copy:")),
            keyEquivalent: "c"
        )
        copy.target = nil
        editMenu.addItem(selectAll)
        editMenu.addItem(copy)
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    /// A save that failed keeps the dashboard on screen and says so in a
    /// dialog, because the page below it is still perfectly usable.
    private func reportDashboardDownloadFailure() {
        let failure = LauncherError.dashboardDownloadFailed
        lastFailureCode = failure.failureCode
        lastRecoverySuggestion = failure.recoverySuggestion
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.string(.launcherNothingSaved)
        alert.informativeText = TiboTattleLocalization.format(
            .launcherFailureDetails,
            failure.errorDescription ?? "",
            failure.failureCode,
            failure.recoverySuggestion
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonOK))
        alert.runModal()
    }

    private func dashboardWebViewFailed(code: String) {
        cancelNativeRefreshSchedule()
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        let failure = LauncherError.dashboardWebViewUnavailable
        lastLifecycleStatus = "Dashboard unavailable"
        lastFailureCode = failure.failureCode
        lastRecoverySuggestion = failure.recoverySuggestion
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherDashboardDidNotOpen
        )
        detailLabel.stringValue = TiboTattleLocalization.format(
            .launcherFailureDetails,
            failure.errorDescription ?? "",
            failure.failureCode,
            failure.recoverySuggestion
        )
        openButton.isEnabled = dashboardURL != nil
        openInBrowserButton.isEnabled = dashboardURL != nil
        retryButton.isEnabled = retryAllowed && firstRunAcknowledged
        updateNativeToolbar(
            title: "Dashboard unavailable",
            isRefreshing: false,
            refreshEnabled: dashboardURL != nil
        )
    }

    private func hideDashboardWebView() {
        cancelNativeRefreshSchedule()
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        openInBrowserButton.isEnabled = false
        cancelNativeRefreshPoll()
        nativeRefreshInFlight = false
        nativeRefreshID = nil
        dashboardWebHost?.stop()
        updateNativeToolbar(
            title: "Starting locally…",
            isRefreshing: false,
            refreshEnabled: false
        )
    }

    /// A link the embedded dashboard cannot load itself. Only credential-free
    /// public HTTPS is handed to the user's browser; the app opens nothing
    /// else, and loads nothing remote itself.
    private func openExternalDashboardLink(_ url: URL) {
        // The completed hosted-sign-in callback can use only this fixed custom
        // URL to bring the already-running dashboard back to the foreground.
        // It carries no OAuth data, so the browser never hands an account,
        // token, or callback value to the app.
        if semanticOpenTarget.accepts(url) {
            dashboardWebHost?.notifyHostedSignInReturn()
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty,
              url.user == nil,
              url.password == nil
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    // The status item is an additional affordance, never a replacement: the
    // activation policy stays `.regular`, the Dock icon stays, and the window
    // remains the primary surface. Every action below routes into the exact
    // path the window's own controls already use, so there is only ever one
    // dashboard-open path and one shutdown path.
    private func installMenuBarStatus() {
        guard menuBarStatus == nil else { return }
        menuBarStatus = MenuBarStatusController(
            productName: BundledProduct.displayName,
            actions: MenuBarStatusController.Actions(
                openTiboTattle: { [weak self] in self?.openTiboTattle() },
                showSettings: { [weak self] in self?.showSettingsWindow() },
                showAbout: { [weak self] in self?.showAbout() },
                quit: { [weak self] in self?.quitApplication() },
                // The menu bar is the only surface always on screen, so it is
                // where an update check has to be reachable. A build with no
                // updater passes nothing and the row is left out.
                checkForUpdates: updater.isAvailable
                    ? { [weak self] in self?.updater.checkForUpdates(nil) }
                    : nil,
                refreshFinished: { [weak self] refreshID in
                    self?.evaluateQuotaNotificationsAfterRefresh(
                        expectedRefreshID: refreshID
                    )
                }
            )
        )
        updateUpdaterPresentation()
    }

    @objc private func showMainWindow() {
        if window == nil {
            createWindow()
        } else {
            window?.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The menu bar's one primary destination. It always foregrounds the
    /// regular TiboTattle window and, when the local companion is ready,
    /// presents the embedded dashboard there rather than opening a browser.
    private func openTiboTattle() {
        showMainWindow()
        if dashboardURL != nil {
            openDashboard()
        }
    }

    private func companionReady(_ url: URL, generation: Int) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        guard url.host == loopbackHost, url.scheme == "http" else {
            showFailure(LauncherError.healthCheck)
            return
        }
        dashboardURL = url
        lastLifecycleStatus = "Ready"
        lastFailureCode = nil
        lastRecoverySuggestion = nil
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherPreparingLocalView
        )
        if centralServiceMode == nil {
            detailLabel.stringValue = TiboTattleLocalization.string(
                .launcherUpdatingLocalUsage
            )
        } else {
            detailLabel.stringValue = TiboTattleLocalization.string(
                .launcherUpdatingLocalUsageContribution
            )
        }
        openButton.isEnabled = true
        openInBrowserButton.isEnabled = true
        retryButton.isEnabled = false
        // The same validated loopback URL the window's Open Dashboard uses.
        menuBarStatus?.companionReady(dashboardURL: url)
        // A companion restart moves to a new ephemeral port, so the native
        // dashboard is always reloaded rather than leaving a stale launcher
        // on screen. This also starts the bounded foreground refresh without
        // making someone hunt for a dashboard button.
        pendingDashboardOpen = false
        openDashboard()
        refreshLocalUsage(automatic: true)
    }

    private func companionExited(
        requested: Bool,
        anotherInstanceIsActive: Bool,
        generation: Int
    ) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        if quitting || requested { return }
        dashboardURL = nil
        companion = nil
        showFailure(
            anotherInstanceIsActive
                ? LauncherError.companionAlreadyRunning
                : LauncherError.companionExited
        )
    }

    private func showFailure(_ error: Error) {
        startupTimeout?.cancel()
        startupTimeout = nil
        dashboardURL = nil
        // The companion origin is gone, so the embedded dashboard goes with
        // it and the always-available status controls come back.
        hideDashboardWebView()
        lastLifecycleStatus = "Could not start"
        let launcherError = error as? LauncherError
            ?? LauncherError.companionLaunch("unexpected")
        lastFailureCode = launcherError.failureCode
        lastRecoverySuggestion = launcherError.recoverySuggestion
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherCouldNotStart
        )
        detailLabel.stringValue = TiboTattleLocalization.format(
            .launcherFailureDetails,
            launcherError.errorDescription
                ?? TiboTattleLocalization.string(.launcherLocalDashboardCouldNotStart),
            launcherError.failureCode,
            launcherError.recoverySuggestion
        )
        openButton.isEnabled = false
        openInBrowserButton.isEnabled = false
        retryButton.isEnabled = retryAllowed && firstRunAcknowledged
        updateNativeToolbar(
            title: "Local companion unavailable",
            isRefreshing: false,
            refreshEnabled: false
        )
        menuBarStatus?.companionUnavailable(
            summary: TiboTattleLocalization.format(
                .menuBarFailureRecovery,
                launcherError.failureCode
            )
        )
    }

    // The app is the interface: Open Dashboard shows the loopback dashboard in
    // this window. The browser remains an explicit, separate choice the user
    // may make for their own reasons; hosted sign-in no longer requires it,
    // because the dashboard collects its own result from the contribution
    // service wherever it is running.
    @objc private func openDashboard() {
        guard let dashboardURL,
              dashboardURL.scheme == "http",
              dashboardURL.host == loopbackHost
        else {
            return
        }
        showDashboardWebView(dashboardURL)
    }

    @objc private func openDashboardInBrowser() {
        guard let dashboardURL,
              dashboardURL.scheme == "http",
              dashboardURL.host == loopbackHost
        else {
            return
        }
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func retryCompanion() {
        guard !quitting, retryAllowed, firstRunAcknowledged else { return }
        if let previous = companion, previous.isRunning {
            retryButton.isEnabled = false
            previous.stop { [weak self] in
                DispatchQueue.main.async {
                    self?.companion = nil
                    self?.startCompanion()
                }
            }
        } else {
            companion = nil
            startCompanion()
        }
    }

    private func settingsLabel(
        _ text: String,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = font
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func externalLinkButton(title: String, address: String) -> NSButton {
        let button = NSButton(
            title: title,
            target: self,
            action: #selector(openExternalLink(_:))
        )
        button.bezelStyle = .rounded
        button.image = NSImage(
            systemSymbolName: "arrow.up.forward.app",
            accessibilityDescription: title
        )
        button.imagePosition = .imageLeading
        button.identifier = NSUserInterfaceItemIdentifier(address)
        return button
    }

    @objc private func openExternalLink(_ sender: NSButton) {
        guard let address = sender.identifier?.rawValue,
              let url = URL(string: address),
              url.scheme == "https",
              url.user == nil,
              url.password == nil
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func settingsPage(
        title: String,
        summary: String,
        views: [NSView]
    ) -> NSViewController {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(settingsLabel(
            title,
            font: .systemFont(ofSize: 22, weight: .semibold),
            color: .labelColor
        ))
        stack.addArrangedSubview(settingsLabel(
            summary,
            font: .systemFont(ofSize: 13),
            color: .secondaryLabelColor
        ))
        for view in views {
            stack.addArrangedSubview(view)
        }
        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: root.widthAnchor),
        ])
        let controller = NSViewController()
        controller.view = root
        return controller
    }

    private func codexHomeSettingsSummary() -> String {
        codexHomeConfiguration?.mode == .custom
            ? TiboTattleLocalization.string(.settingsCodexFolderCustomSelected)
            : TiboTattleLocalization.string(.settingsCodexFolderDefaultLocation)
    }

    private func updateSettingsCodexHomeSummary() {
        settingsCodexHomeLabel?.stringValue = codexHomeSettingsSummary()
    }

    private func automaticUpdatesSettingsSummary() -> String {
        updater.settingsSummary
    }

    private func updateAutomaticUpdatesSettingsControl() {
        settingsAutomaticUpdatesSwitch?.isEnabled =
            updater.canConfigureAutomaticUpdates
        settingsAutomaticUpdatesSwitch?.state = updater.automaticUpdatesEnabled
            ? .on
            : .off
        settingsAutomaticUpdatesDetailLabel?.stringValue =
            automaticUpdatesSettingsSummary()
        settingsAboutAutomaticUpdatesDetailLabel?.stringValue =
            automaticUpdatesSettingsSummary()
    }

    private func updateUpdaterPresentation() {
        updateAutomaticUpdatesSettingsControl()
        settingsCheckForUpdatesButton?.title = updater.menuItemTitle
        settingsCheckForUpdatesButton?.isEnabled = updater.canCheckForUpdates
        menuBarStatus?.updateUpdaterPresentation(
            title: updater.menuItemTitle,
            isEnabled: updater.canCheckForUpdates
        )
    }

    @discardableResult
    private func observeLoginItemStatus() -> LoginItemStatus {
        loginItemManager.status
    }

    private func startAtLoginSettingsSummary(
        for status: LoginItemStatus
    ) -> String {
        switch status {
        case .enabled:
            return TiboTattleLocalization.string(
                .settingsStartAtLoginEnabled
            )
        case .notRegistered:
            return TiboTattleLocalization.string(
                .settingsStartAtLoginDisabled
            )
        case .requiresApproval:
            return TiboTattleLocalization.string(
                .settingsStartAtLoginNeedsApproval
            )
        case .unknown:
            return TiboTattleLocalization.string(
                .settingsStartAtLoginUnavailable
            )
        }
    }

    private func updateStartAtLoginSettingsControl() {
        let status = observeLoginItemStatus()
        let presentation = loginItemSettingsPresentation(for: status)
        settingsStartAtLoginSwitch?.state = presentation.isOn ? .on : .off
        settingsStartAtLoginSwitch?.isEnabled = presentation.isEnabled
            && !loginItemOperationInFlight
        settingsStartAtLoginDetailLabel?.stringValue =
            startAtLoginSettingsSummary(for: status)
        settingsStartAtLoginPendingRemovalButton?.isHidden =
            !presentation.showsPendingRemoval
        settingsStartAtLoginPendingRemovalButton?.isEnabled =
            presentation.showsPendingRemoval && !loginItemOperationInFlight
        settingsStartAtLoginRefreshButton?.isEnabled =
            !loginItemOperationInFlight
    }

    @objc private func toggleStartAtLogin(_ sender: NSSwitch) {
        performLoginItemOperation(
            sender.state == .on ? .register : .unregister,
            allowContinue: false
        )
    }

    @objc private func removePendingLoginItem() {
        performLoginItemOperation(.unregister, allowContinue: false)
    }

    @objc private func refreshLoginItemStatus() {
        updateStartAtLoginSettingsControl()
    }

    private func performLoginItemOperation(
        _ operation: LoginItemOperation,
        allowContinue: Bool
    ) {
        // The ServiceManagement calls are synchronous, but the guard prevents
        // repeated accessibility/keyboard activations from queuing conflicting
        // register and unregister requests while a confirmation alert is up.
        guard !loginItemOperationInFlight else { return }
        loginItemOperationInFlight = true
        updateStartAtLoginSettingsControl()
        defer {
            loginItemOperationInFlight = false
            updateStartAtLoginSettingsControl()
        }
        do {
            switch operation {
            case .register:
                try loginItemManager.register()
            case .unregister:
                try loginItemManager.unregister()
            }
            let result = loginItemOperationResult(
                operation: operation,
                status: observeLoginItemStatus()
            )
            lastLoginItemDiagnosticAction = LoginItemDiagnosticAction.make(
                operation: operation,
                result: result
            )
            showLoginItemOperationResult(
                result,
                operation: operation,
                allowContinue: allowContinue
            )
        } catch {
            if let reconciled = reconciledLoginItemOperationResultAfterError(
                operation: operation,
                status: observeLoginItemStatus()
            ) {
                lastLoginItemDiagnosticAction =
                    LoginItemDiagnosticAction.make(
                        operation: operation,
                        result: reconciled
                    )
                showLoginItemOperationResult(
                    reconciled,
                    operation: operation,
                    allowContinue: allowContinue
                )
                return
            }
            lastLoginItemDiagnosticAction = LoginItemDiagnosticAction.make(
                operation: operation,
                result: .failed
            )
            showLoginItemOperationFailure(
                operation: operation,
                allowContinue: allowContinue
            )
        }
    }

    @objc private func openLoginItemsSettings() {
        loginItemManager.openSystemSettings()
    }

    private func showLoginItemOperationResult(
        _ result: LoginItemOperationResult,
        operation: LoginItemOperation,
        allowContinue: Bool
    ) {
        switch result {
        case .confirmed:
            return
        case .requiresApproval:
            showLoginItemApprovalNotice(allowContinue: allowContinue)
        case .notConfirmed:
            showLoginItemUnconfirmed(
                operation: operation,
                allowContinue: allowContinue
            )
        case .unavailable:
            showLoginItemStatusUnavailable(allowContinue: allowContinue)
        case .failed:
            showLoginItemOperationFailure(
                operation: operation,
                allowContinue: allowContinue
            )
        }
    }

    private func showLoginItemUnconfirmed(
        operation: LoginItemOperation,
        allowContinue: Bool
    ) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch operation {
        case .register:
            alert.messageText = TiboTattleLocalization.string(
                .settingsStartAtLoginRegistrationNotConfirmedTitle
            )
            alert.informativeText = TiboTattleLocalization.string(
                .settingsStartAtLoginRegistrationNotConfirmedMessage
            )
        case .unregister:
            alert.messageText = TiboTattleLocalization.string(
                .settingsStartAtLoginUnregistrationNotConfirmedTitle
            )
            alert.informativeText = TiboTattleLocalization.string(
                .settingsStartAtLoginUnregistrationNotConfirmedMessage
            )
        }
        alert.addButton(withTitle: TiboTattleLocalization.string(
            .settingsOpenLoginItems
        ))
        alert.addButton(withTitle: TiboTattleLocalization.string(
            allowContinue
                ? .settingsContinueWithoutLogin
                : .settingsDismiss
        ))
        if alert.runModal() == .alertFirstButtonReturn {
            loginItemManager.openSystemSettings()
        }
    }

    private func showLoginItemStatusUnavailable(allowContinue: Bool) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = TiboTattleLocalization.string(
            .settingsStartAtLoginUnavailableTitle
        )
        alert.informativeText = TiboTattleLocalization.string(
            .settingsStartAtLoginUnavailableMessage
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(
            .settingsOpenLoginItems
        ))
        alert.addButton(withTitle: TiboTattleLocalization.string(
            allowContinue
                ? .settingsContinueWithoutLogin
                : .settingsDismiss
        ))
        if alert.runModal() == .alertFirstButtonReturn {
            loginItemManager.openSystemSettings()
        }
    }

    private func showLoginItemOperationFailure(
        operation: LoginItemOperation,
        allowContinue: Bool
    ) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch operation {
        case .register:
            alert.messageText = TiboTattleLocalization.string(
                .settingsStartAtLoginRegistrationErrorTitle
            )
            alert.informativeText = TiboTattleLocalization.string(
                .settingsStartAtLoginRegistrationErrorMessage
            )
        case .unregister:
            alert.messageText = TiboTattleLocalization.string(
                .settingsStartAtLoginUnregistrationErrorTitle
            )
            alert.informativeText = TiboTattleLocalization.string(
                .settingsStartAtLoginUnregistrationErrorMessage
            )
        }
        alert.addButton(withTitle: TiboTattleLocalization.string(
            .settingsOpenLoginItems
        ))
        alert.addButton(withTitle: TiboTattleLocalization.string(
            allowContinue
                ? .settingsContinueWithoutLogin
                : .settingsDismiss
        ))
        if alert.runModal() == .alertFirstButtonReturn {
            loginItemManager.openSystemSettings()
        }
    }

    private func showLoginItemApprovalNotice(allowContinue: Bool) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = TiboTattleLocalization.string(
            .settingsStartAtLoginApprovalTitle
        )
        alert.informativeText = TiboTattleLocalization.string(
            .settingsStartAtLoginApprovalMessage
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(
            .settingsOpenLoginItems
        ))
        alert.addButton(withTitle: TiboTattleLocalization.string(
            allowContinue
                ? .settingsContinue
                : .settingsDismiss
        ))
        if alert.runModal() == .alertFirstButtonReturn {
            loginItemManager.openSystemSettings()
        }
    }

    private func quotaNotificationSettingsSummary() -> String {
        guard let coordinator = quotaNotificationCoordinator else {
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusStateUnavailable
            )
        }
        switch coordinator.presentation.status {
        case .disabled:
            return TiboTattleLocalization.string(.settingsNotificationsOff)
        case .stateUnavailable:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusStateUnavailable
            )
        case .awaitingPermission:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusWaitingPermission
            )
        case .permissionDenied:
            return TiboTattleLocalization.string(
                .settingsNotificationsPermissionDenied
            )
        case .permissionUnknown:
            return TiboTattleLocalization.string(
                .settingsNotificationsPermissionUnknown
            )
        case .waitingForFreshProviderEvidence:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusFreshOnly
            )
        case let .ineligible(reason):
            return TiboTattleLocalization.format(
                .settingsNotificationsStatusIneligible,
                quotaNotificationIneligibilitySummary(reason)
            )
        case .firstObservationStored:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusFirstObservation
            )
        case .noNewCrossing:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusNoCrossing
            )
        case .delivered:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusDelivered
            )
        case .deliveryUnavailable:
            return TiboTattleLocalization.string(
                .settingsNotificationsStatusDeliveryUnavailable
            )
        }
    }

    private func quotaNotificationIneligibilitySummary(
        _ reason: QuotaNotificationIneligibility
    ) -> String {
        let key: TiboTattleLocalization.Key
        switch reason {
        case .refreshFailed:
            key = .settingsNotificationsReasonRefreshFailed
        case .providerUnavailable:
            key = .settingsNotificationsReasonProviderUnavailable
        case .stale:
            key = .settingsNotificationsReasonStale
        case .inferred:
            key = .settingsNotificationsReasonInferred
        case .mixedSource:
            key = .settingsNotificationsReasonMixedSource
        case .unobserved:
            key = .settingsNotificationsReasonUnobserved
        case .unknown:
            key = .settingsNotificationsReasonUnknown
        case .logDerived:
            key = .settingsNotificationsReasonLogDerived
        case .schemaChanged:
            key = .settingsNotificationsReasonSchemaChanged
        case .resetProofMissing:
            key = .settingsNotificationsReasonResetProofMissing
        }
        return TiboTattleLocalization.string(key)
    }

    private func updateQuotaNotificationSettingsControls() {
        guard let coordinator = quotaNotificationCoordinator else {
            settingsQuotaNotificationsSwitch?.isEnabled = false
            settingsQuotaNotificationThresholds?.isEnabled = false
            settingsQuotaNotificationResetSwitch?.isEnabled = false
            settingsQuotaNotificationStatusLabel?.stringValue =
                quotaNotificationSettingsSummary()
            return
        }
        let presentation = coordinator.presentation
        settingsQuotaNotificationsSwitch?.isEnabled =
            presentation.status != .stateUnavailable
        settingsQuotaNotificationsSwitch?.state = presentation.enabled
            ? .on
            : .off
        let selectedSegment: Int
        switch presentation.thresholdMode {
        case .off:
            selectedSegment = 0
        case .ninety:
            selectedSegment = 1
        case .eightyAndNinety:
            selectedSegment = 2
        }
        settingsQuotaNotificationThresholds?.selectedSegment = selectedSegment
        settingsQuotaNotificationThresholds?.isEnabled = presentation.enabled
        settingsQuotaNotificationResetSwitch?.state = presentation.resetEnabled
            ? .on
            : .off
        settingsQuotaNotificationResetSwitch?.isEnabled =
            presentation.enabled && presentation.resetAvailable
        settingsQuotaNotificationStatusLabel?.stringValue =
            quotaNotificationSettingsSummary()
    }

    @objc private func toggleQuotaNotifications(_ sender: NSSwitch) {
        quotaNotificationCoordinator?.setEnabled(sender.state == .on)
        updateQuotaNotificationSettingsControls()
    }

    @objc private func selectQuotaNotificationThresholds(
        _ sender: NSSegmentedControl
    ) {
        let mode: QuotaNotificationThresholdMode
        switch sender.selectedSegment {
        case 1:
            mode = .ninety
        case 2:
            mode = .eightyAndNinety
        default:
            mode = .off
        }
        quotaNotificationCoordinator?.setThresholdMode(mode)
        updateQuotaNotificationSettingsControls()
    }

    @objc private func toggleQuotaNotificationReset(_ sender: NSSwitch) {
        quotaNotificationCoordinator?.setResetEnabled(sender.state == .on)
        updateQuotaNotificationSettingsControls()
    }

    @objc private func showSettingsWindow() {
        showSettings(selecting: 0)
    }

    @objc private func showAbout() {
        showSettings(selecting: 1)
    }

    @objc private func selectLanguagePreference(_ sender: NSPopUpButton) {
        guard let rawPreference = sender.selectedItem?.representedObject
            as? String,
              let preference = TiboTattleLocalization.LanguagePreference(
                  rawValue: rawPreference
              )
        else {
            return
        }
        changeLanguagePreference(preference)
    }

    /// Product language controls TiboTattle-owned copy only. Formatting keeps
    /// using `Locale.current`, and this bridge never changes provider data,
    /// accounting, timestamps, refresh ownership, or notification policy.
    private func changeLanguagePreference(
        _ preference: TiboTattleLocalization.LanguagePreference
    ) {
        guard preference != TiboTattleLocalization.languagePreference else {
            return
        }
        let selectedSettingsTab = settingsTabs?.selectedTabViewItemIndex ?? 0
        let shouldRestoreSettings = settingsWindow?.isVisible == true
        TiboTattleLocalization.setLanguagePreference(preference)
        installApplicationMenu()
        refreshLauncherStaticLocalization()
        menuBarStatus?.refreshLocalization()
        updateUpdaterPresentation()
        nativeDashboardChrome?.refreshLocalization()
        refreshNativeToolbarLocalization()
        dashboardWebHost?.notifyLanguagePreferenceChange(preference)

        // Settings is built from native controls rather than a constrained
        // fixed-width form. Recreate it to let translated labels naturally
        // remeasure and to update every accessibility label in one place.
        settingsWindow?.close()
        settingsWindow = nil
        settingsTabs = nil
        settingsCodexHomeLabel = nil
        settingsAutomaticUpdatesSwitch = nil
        settingsAutomaticUpdatesDetailLabel = nil
        settingsAboutAutomaticUpdatesDetailLabel = nil
        settingsCheckForUpdatesButton = nil
        if shouldRestoreSettings {
            showSettings(selecting: selectedSettingsTab)
        }
    }

    private func refreshLauncherStaticLocalization() {
        openButton.title = TiboTattleLocalization.string(.settingsOpenDashboard)
        retryButton.title = TiboTattleLocalization.string(.launcherRetry)
        settingsButton.title = TiboTattleLocalization.string(.menuSettings)
        diagnosticsButton.title = TiboTattleLocalization.string(
            .launcherDataDiagnostics
        )
        codexHomeButton.title = TiboTattleLocalization.string(
            .settingsChooseCodexFolder
        )
        openInBrowserButton.title = TiboTattleLocalization.string(
            .launcherOpenInBrowser
        )
        openInBrowserButton.toolTip = TiboTattleLocalization.string(
            .launcherOpenBrowserTooltip
        )
        quitButton.title = TiboTattleLocalization.format(
            .menuQuitProduct,
            BundledProduct.displayName
        )
        privacyLabel.stringValue = TiboTattleLocalization.string(
            .launcherPrivacyForegroundOnly
        )
    }

    private func showSettings(selecting index: Int) {
        if let settingsWindow, let settingsTabs {
            settingsTabs.selectedTabViewItemIndex = index
            updateSettingsCodexHomeSummary()
            updateAutomaticUpdatesSettingsControl()
            updateStartAtLoginSettingsControl()
            quotaNotificationCoordinator?.refreshAuthorization()
            updateQuotaNotificationSettingsControls()
            settingsWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let sourceStatus = settingsLabel(
            codexHomeSettingsSummary(),
            font: .systemFont(ofSize: 13, weight: .medium),
            color: .labelColor
        )
        settingsCodexHomeLabel = sourceStatus
        let chooseSource = NSButton(
            title: TiboTattleLocalization.string(.settingsChooseCodexFolder),
            target: self,
            action: #selector(showCodexHomeOptions)
        )
        let useDefaultSource = NSButton(
            title: TiboTattleLocalization.string(.settingsUseDefault),
            target: self,
            action: #selector(useDefaultCodexHome)
        )
        let sourceActions = NSStackView(views: [chooseSource, useDefaultSource])
        sourceActions.orientation = .horizontal
        sourceActions.spacing = 8
        let languageLabel = settingsLabel(
            TiboTattleLocalization.string(.settingsLanguage),
            font: .systemFont(ofSize: 14, weight: .semibold),
            color: .labelColor
        )
        let languagePicker = NSPopUpButton(
            frame: .zero,
            pullsDown: false
        )
        let languageChoices: [(
            TiboTattleLocalization.LanguagePreference,
            String
        )] = [
            (.system, TiboTattleLocalization.string(.settingsLanguageSystem)),
            (.english, TiboTattleLocalization.string(.settingsLanguageEnglish)),
            (.simplifiedChinese, "简体中文"),
            (.spanish, "Español"),
        ]
        for (preference, title) in languageChoices {
            languagePicker.addItem(withTitle: title)
            languagePicker.lastItem?.representedObject = preference.rawValue
        }
        if let selectedIndex = languageChoices.firstIndex(where: {
            $0.0 == TiboTattleLocalization.languagePreference
        }) {
            languagePicker.selectItem(at: selectedIndex)
        }
        languagePicker.target = self
        languagePicker.action = #selector(selectLanguagePreference(_:))
        languagePicker.toolTip = TiboTattleLocalization.string(
            .settingsLanguagePickerHint
        )
        languagePicker.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsLanguage)
        )
        let languageRow = NSStackView(views: [languageLabel, languagePicker])
        languageRow.orientation = .horizontal
        languageRow.alignment = .centerY
        languageRow.spacing = 12
        let languageSection = NSStackView(views: [
            languageRow,
            settingsLabel(
                TiboTattleLocalization.string(.settingsLanguagePickerHint),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            settingsLabel(
                TiboTattleLocalization.string(.settingsLanguageSummary),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
        ])
        languageSection.orientation = .vertical
        languageSection.alignment = .leading
        languageSection.spacing = 6
        let sourceSection = NSStackView(views: [
            settingsLabel(
                TiboTattleLocalization.string(.settingsCodexFolder),
                font: .systemFont(ofSize: 14, weight: .semibold),
                color: .labelColor
            ),
            sourceStatus,
            settingsLabel(
                TiboTattleLocalization.string(.settingsCodexFolderSummary),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            sourceActions,
        ])
        sourceSection.orientation = .vertical
        sourceSection.alignment = .leading
        sourceSection.spacing = 7
        let openDashboardFromSettings = NSButton(
            title: TiboTattleLocalization.string(.settingsOpenDashboard),
            target: self,
            action: #selector(openDashboard)
        )
        let automaticUpdatesSwitch = NSSwitch()
        automaticUpdatesSwitch.state = updater.automaticUpdatesEnabled
            ? .on
            : .off
        automaticUpdatesSwitch.isEnabled = updater.canConfigureAutomaticUpdates
        automaticUpdatesSwitch.target = self
        automaticUpdatesSwitch.action = #selector(toggleAutomaticUpdates(_:))
        automaticUpdatesSwitch.toolTip =
            TiboTattleLocalization.string(.settingsAutomaticUpdatesTooltip)
        settingsAutomaticUpdatesSwitch = automaticUpdatesSwitch
        let automaticUpdatesDetail = settingsLabel(
            automaticUpdatesSettingsSummary(),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        settingsAutomaticUpdatesDetailLabel = automaticUpdatesDetail
        let automaticUpdatesHeading = settingsLabel(
            TiboTattleLocalization.string(.settingsAutomaticUpdates),
            font: .systemFont(ofSize: 14, weight: .semibold),
            color: .labelColor
        )
        let automaticUpdatesHeader = NSStackView(
            views: [automaticUpdatesHeading, automaticUpdatesSwitch]
        )
        automaticUpdatesHeader.orientation = .horizontal
        automaticUpdatesHeader.alignment = .centerY
        automaticUpdatesHeader.spacing = 12
        let automaticUpdatesSection = NSStackView(views: [
            automaticUpdatesHeader,
            automaticUpdatesDetail,
        ])
        automaticUpdatesSection.orientation = .vertical
        automaticUpdatesSection.alignment = .leading
        automaticUpdatesSection.spacing = 6
        let startAtLoginStatus = observeLoginItemStatus()
        let startAtLoginPresentation = loginItemSettingsPresentation(
            for: startAtLoginStatus
        )
        let startAtLoginSwitch = NSSwitch()
        startAtLoginSwitch.state = startAtLoginPresentation.isOn
            ? .on
            : .off
        startAtLoginSwitch.isEnabled = startAtLoginPresentation.isEnabled
        startAtLoginSwitch.target = self
        startAtLoginSwitch.action = #selector(toggleStartAtLogin(_:))
        startAtLoginSwitch.toolTip = TiboTattleLocalization.string(
            .settingsStartAtLoginSummary
        )
        startAtLoginSwitch.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsStartAtLogin)
        )
        settingsStartAtLoginSwitch = startAtLoginSwitch
        let startAtLoginDetail = settingsLabel(
            startAtLoginSettingsSummary(for: startAtLoginStatus),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        settingsStartAtLoginDetailLabel = startAtLoginDetail
        let startAtLoginHeading = settingsLabel(
            TiboTattleLocalization.string(.settingsStartAtLogin),
            font: .systemFont(ofSize: 14, weight: .semibold),
            color: .labelColor
        )
        let startAtLoginHeader = NSStackView(
            views: [startAtLoginHeading, startAtLoginSwitch]
        )
        startAtLoginHeader.orientation = .horizontal
        startAtLoginHeader.alignment = .centerY
        startAtLoginHeader.spacing = 12
        let openLoginItems = NSButton(
            title: TiboTattleLocalization.string(.settingsOpenLoginItems),
            target: self,
            action: #selector(openLoginItemsSettings)
        )
        openLoginItems.bezelStyle = .rounded
        let refreshLoginItemStatus = NSButton(
            title: TiboTattleLocalization.string(
                .settingsRefreshLoginItemStatus
            ),
            target: self,
            action: #selector(refreshLoginItemStatus)
        )
        refreshLoginItemStatus.bezelStyle = .rounded
        refreshLoginItemStatus.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsRefreshLoginItemStatus)
        )
        settingsStartAtLoginRefreshButton = refreshLoginItemStatus
        let removePendingLoginItem = NSButton(
            title: TiboTattleLocalization.string(
                .settingsRemovePendingLoginItem
            ),
            target: self,
            action: #selector(removePendingLoginItem)
        )
        removePendingLoginItem.bezelStyle = .rounded
        removePendingLoginItem.isHidden =
            !startAtLoginPresentation.showsPendingRemoval
        removePendingLoginItem.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsRemovePendingLoginItem)
        )
        settingsStartAtLoginPendingRemovalButton = removePendingLoginItem
        let startAtLoginSection = NSStackView(views: [
            startAtLoginHeader,
            startAtLoginDetail,
            openLoginItems,
            refreshLoginItemStatus,
            removePendingLoginItem,
        ])
        startAtLoginSection.orientation = .vertical
        startAtLoginSection.alignment = .leading
        startAtLoginSection.spacing = 6
        let quotaNotificationsSwitch = NSSwitch()
        quotaNotificationsSwitch.target = self
        quotaNotificationsSwitch.action = #selector(toggleQuotaNotifications(_:))
        quotaNotificationsSwitch.toolTip = TiboTattleLocalization.string(
            .settingsNotificationsToggleTooltip
        )
        settingsQuotaNotificationsSwitch = quotaNotificationsSwitch
        let quotaNotificationsHeading = settingsLabel(
            TiboTattleLocalization.string(.settingsNotifications),
            font: .systemFont(ofSize: 14, weight: .semibold),
            color: .labelColor
        )
        let quotaNotificationsHeader = NSStackView(views: [
            quotaNotificationsHeading,
            quotaNotificationsSwitch,
        ])
        quotaNotificationsHeader.orientation = .horizontal
        quotaNotificationsHeader.alignment = .centerY
        quotaNotificationsHeader.spacing = 12
        let quotaNotificationThresholds = NSSegmentedControl(
            labels: [
                TiboTattleLocalization.string(
                    .settingsNotificationsThresholdsOff
                ),
                TiboTattleLocalization.string(
                    .settingsNotificationsThresholdsNinety
                ),
                TiboTattleLocalization.string(
                    .settingsNotificationsThresholdsEightyAndNinety
                ),
            ],
            trackingMode: .selectOne,
            target: self,
            action: #selector(selectQuotaNotificationThresholds(_:))
        )
        quotaNotificationThresholds.segmentStyle = .rounded
        quotaNotificationThresholds.toolTip = TiboTattleLocalization.string(
            .settingsNotificationsThresholds
        )
        settingsQuotaNotificationThresholds = quotaNotificationThresholds
        let quotaNotificationThresholdRow = NSStackView(views: [
            settingsLabel(
                TiboTattleLocalization.string(.settingsNotificationsThresholds),
                font: .systemFont(ofSize: 13, weight: .medium),
                color: .labelColor
            ),
            quotaNotificationThresholds,
        ])
        quotaNotificationThresholdRow.orientation = .horizontal
        quotaNotificationThresholdRow.alignment = .centerY
        quotaNotificationThresholdRow.spacing = 12
        let quotaNotificationResetSwitch = NSSwitch()
        quotaNotificationResetSwitch.target = self
        quotaNotificationResetSwitch.action = #selector(
            toggleQuotaNotificationReset(_:)
        )
        quotaNotificationResetSwitch.toolTip = TiboTattleLocalization.string(
            .settingsNotificationsResetDetail
        )
        settingsQuotaNotificationResetSwitch = quotaNotificationResetSwitch
        let quotaNotificationResetRow = NSStackView(views: [
            settingsLabel(
                TiboTattleLocalization.string(.settingsNotificationsReset),
                font: .systemFont(ofSize: 13, weight: .medium),
                color: .labelColor
            ),
            quotaNotificationResetSwitch,
        ])
        quotaNotificationResetRow.orientation = .horizontal
        quotaNotificationResetRow.alignment = .centerY
        quotaNotificationResetRow.spacing = 12
        let quotaNotificationStatus = settingsLabel(
            quotaNotificationSettingsSummary(),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        quotaNotificationStatus.maximumNumberOfLines = 3
        settingsQuotaNotificationStatusLabel = quotaNotificationStatus
        let quotaNotificationsSection = NSStackView(views: [
            quotaNotificationsHeader,
            settingsLabel(
                TiboTattleLocalization.string(.settingsNotificationsDetail),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            quotaNotificationThresholdRow,
            quotaNotificationResetRow,
            settingsLabel(
                TiboTattleLocalization.string(
                    .settingsNotificationsResetDetail
                ),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            quotaNotificationStatus,
        ])
        quotaNotificationsSection.orientation = .vertical
        quotaNotificationsSection.alignment = .leading
        quotaNotificationsSection.spacing = 6
        let general = settingsPage(
            title: TiboTattleLocalization.string(.settingsGeneral),
            summary: TiboTattleLocalization.string(.settingsGeneralSummary),
            views: [
                languageSection,
                sourceSection,
                automaticUpdatesSection,
                startAtLoginSection,
                quotaNotificationsSection,
                openDashboardFromSettings,
            ]
        )

        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "unknown"
        let build = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "unknown"
        let appIcon = NSImageView(image: NSApp.applicationIconImage)
        appIcon.imageScaling = .scaleProportionallyUpOrDown
        appIcon.setContentHuggingPriority(.required, for: .horizontal)
        appIcon.setContentHuggingPriority(.required, for: .vertical)
        NSLayoutConstraint.activate([
            appIcon.widthAnchor.constraint(equalToConstant: 64),
            appIcon.heightAnchor.constraint(equalToConstant: 64),
        ])
        let aboutBrandCopy = NSStackView(views: [
            settingsLabel(
                BundledProduct.displayName,
                font: .systemFont(ofSize: 18, weight: .semibold),
                color: .labelColor
            ),
            settingsLabel(
                TiboTattleLocalization.format(.settingsVersion, version, build),
                font: .systemFont(ofSize: 13),
                color: .secondaryLabelColor
            ),
        ])
        aboutBrandCopy.orientation = .vertical
        aboutBrandCopy.alignment = .leading
        aboutBrandCopy.spacing = 4
        let aboutBranding = NSStackView(views: [appIcon, aboutBrandCopy])
        aboutBranding.orientation = .horizontal
        aboutBranding.alignment = .centerY
        aboutBranding.spacing = 12
        let projectLinks = NSStackView(views: [
            externalLinkButton(
                title: TiboTattleLocalization.string(.settingsWebsite),
                address: BundledProduct.publicWebsiteOrigin
            ),
            externalLinkButton(
                title: TiboTattleLocalization.string(.settingsGitHub),
                address: "https://github.com/adamallcock"
            ),
            externalLinkButton(
                title: TiboTattleLocalization.string(.settingsX),
                address: "https://x.com/adamallcock"
            ),
        ])
        projectLinks.orientation = .horizontal
        projectLinks.spacing = 8
        let checkForUpdates = NSButton(
            title: updater.menuItemTitle,
            target: self,
            action: #selector(checkForUpdates)
        )
        checkForUpdates.isEnabled = updater.canCheckForUpdates
        settingsCheckForUpdatesButton = checkForUpdates
        let aboutAutomaticUpdatesDetail = settingsLabel(
            automaticUpdatesSettingsSummary(),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        settingsAboutAutomaticUpdatesDetailLabel = aboutAutomaticUpdatesDetail
        let about = settingsPage(
            title: TiboTattleLocalization.format(
                .settingsAboutProduct,
                BundledProduct.displayName
            ),
            summary: TiboTattleLocalization.string(.settingsAboutSummary),
            views: [
                aboutBranding,
                aboutAutomaticUpdatesDetail,
                checkForUpdates,
                projectLinks,
            ]
        )

        for controller in [general, about] {
            controller.title = TiboTattleLocalization.string(.settingsWindowTitle)
        }

        let tabs = NSTabViewController()
        tabs.tabStyle = .toolbar
        for (label, symbol, controller) in [
            (TiboTattleLocalization.string(.settingsGeneral), "gearshape", general),
            (TiboTattleLocalization.string(.settingsAboutTab), "info.circle", about),
        ] {
            let item = NSTabViewItem(identifier: label)
            item.label = label
            item.image = NSImage(
                systemSymbolName: symbol,
                accessibilityDescription: label
            )
            item.viewController = controller
            tabs.addTabViewItem(item)
        }
        tabs.selectedTabViewItemIndex = index
        let newWindow = NSWindow(contentViewController: tabs)
        newWindow.title = TiboTattleLocalization.string(.settingsWindowTitle)
        newWindow.styleMask = [.titled, .closable, .miniaturizable]
        newWindow.setContentSize(NSSize(width: 660, height: 680))
        newWindow.contentMinSize = NSSize(width: 600, height: 580)
        newWindow.isReleasedWhenClosed = false
        newWindow.center()
        settingsWindow = newWindow
        settingsTabs = tabs
        updateQuotaNotificationSettingsControls()
        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateStartAtLoginSettingsControl()
    }

    private func diagnosticText() -> String {
        let version =
            Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String
            ?? "unknown"
        let build =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
                as? String
            ?? "unknown"
        let mode = codexHomeConfiguration?.mode ?? .defaultLocation
        let codexValidated: Bool
        if let selected = codexHomeConfiguration {
            codexValidated = selected.mode == .defaultLocation
                || (try? validatedCustomCodexHome(selected.url)) != nil
        } else {
            codexValidated = false
        }
        let appStateAvailable = (try? ownerOnlyStateRoot()) != nil
        return LifecycleDiagnostics.render(
            version: version,
            build: build,
            lifecycle: lastLifecycleStatus,
            failureCode: lastFailureCode,
            recovery: lastRecoverySuggestion,
            centralConfigured: centralServiceMode != nil,
            codexHomeMode: mode,
            codexHomeValidated: codexValidated,
            appStateAvailable: appStateAvailable,
            loginItemStatus: observeLoginItemStatus(),
            loginItemLastOperation: lastLoginItemDiagnosticAction
        )
    }

    @objc private func showDiagnostics() {
        let diagnostics = diagnosticText()
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.format(
            .dialogDataAndDiagnostics,
            BundledProduct.displayName
        )
        alert.informativeText = diagnostics
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogDone))
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogCopyDiagnostics))
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogManageData))
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(diagnostics, forType: .string)
            statusLabel.stringValue = TiboTattleLocalization.string(
                .dialogDiagnosticsCopied
            )
            detailLabel.stringValue = TiboTattleLocalization.string(
                .dialogDiagnosticsCopiedDetail
            )
        case .alertThirdButtonReturn:
            showDataManagement()
        default:
            break
        }
    }

    @objc private func checkForUpdates(_ sender: Any?) {
        updater.checkForUpdates(sender)
    }

    @objc private func toggleAutomaticUpdates(_ sender: NSSwitch) {
        guard updater.canConfigureAutomaticUpdates
        else {
            updateAutomaticUpdatesSettingsControl()
            return
        }
        updater.setAutomaticUpdatesEnabled(sender.state == .on)
        updateAutomaticUpdatesSettingsControl()
    }

    private func showDataManagement() {
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.format(
            .dialogManageLocalData,
            BundledProduct.displayName
        )
        alert.informativeText = TiboTattleLocalization.string(
            .dialogManageLocalDataDescription
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogLocalAppData))
        alert.addButton(
            withTitle: TiboTattleLocalization.string(.dialogIdentityDeviceReset)
        )
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            showLocalAppDataManagement()
        case .alertThirdButtonReturn:
            confirmLocalKeychainResetStepOne()
        default:
            break
        }
    }

    private func showLocalAppDataManagement() {
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.string(.dialogLocalAppData)
        alert.informativeText = TiboTattleLocalization.string(
            .dialogLocalAppDataDescription
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogShowLocalData))
        alert.addButton(withTitle: TiboTattleLocalization.string(.dialogEraseLocalData))
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            do {
                NSWorkspace.shared.activateFileViewerSelecting([
                    try ownerOnlyStateRoot()
                ])
            } catch {
                showFailure(error)
            }
        case .alertThirdButtonReturn:
            confirmEraseLocalData()
        default:
            break
        }
    }

    @objc private func showCodexHomeOptions() {
        let current =
            codexHomeConfiguration?.mode == .custom
            ? TiboTattleLocalization.string(.dialogCustomCodexFolder)
            : TiboTattleLocalization.string(.dialogDefaultCodexFolder)
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.string(.settingsCodexFolder)
        alert.informativeText = TiboTattleLocalization.format(
            .dialogCodexFolderDescription,
            current,
            BundledProduct.displayName
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        alert.addButton(
            withTitle: TiboTattleLocalization.string(.settingsChooseCodexFolder)
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.settingsUseDefault))
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            chooseCustomCodexHome()
        case .alertThirdButtonReturn:
            useDefaultCodexHome()
        default:
            break
        }
    }

    private func chooseCustomCodexHome() {
        let panel = NSOpenPanel()
        panel.title = TiboTattleLocalization.string(.dialogChooseCodexHomeFolder)
        panel.message = TiboTattleLocalization.string(
            .dialogChooseCodexHomeFolderMessage
        )
        panel.prompt = TiboTattleLocalization.string(.dialogUseThisFolder)
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        if let current = codexHomeConfiguration?.url {
            panel.directoryURL = current
        }
        guard panel.runModal() == .OK, let selected = panel.url else {
            return
        }
        do {
            codexHomeConfiguration = try saveCodexHomeConfiguration(
                selected,
                stateRoot: ownerOnlyStateRoot()
            )
            updateSettingsCodexHomeSummary()
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    @objc private func useDefaultCodexHome() {
        do {
            codexHomeConfiguration = try clearCodexHomeConfiguration(
                stateRoot: ownerOnlyStateRoot()
            )
            updateSettingsCodexHomeSummary()
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    private func restartCompanionAfterCodexHomeChange() {
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherCodexFolderUpdated
        )
        detailLabel.stringValue = TiboTattleLocalization.string(
            .launcherRestartingLocalCompanion
        )
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        startupTimeout?.cancel()
        launchGeneration += 1
        let previous = companion
        companion = nil
        if let previous, previous.isRunning {
            previous.stop { [weak self] in
                DispatchQueue.main.async {
                    self?.startCompanion()
                }
            }
        } else {
            startCompanion()
        }
    }

    private func confirmEraseLocalData() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .critical
        confirmation.messageText = TiboTattleLocalization.format(
            .dialogMoveLocalDataToTrash,
            BundledProduct.displayName
        )
        confirmation.informativeText = TiboTattleLocalization.string(
            .dialogMoveLocalDataToTrashDescription
        )
        confirmation.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        confirmation.addButton(
            withTitle: TiboTattleLocalization.string(.dialogMoveDataToTrash)
        )
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        eraseLocalData()
    }

    private func confirmLocalKeychainResetStepOne() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .warning
        confirmation.messageText = TiboTattleLocalization.string(
            .dialogResetIdentityDevice
        )
        confirmation.informativeText = TiboTattleLocalization.format(
            .dialogIdentityDeviceResetDescription,
            BundledProduct.displayName
        )
        confirmation.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        confirmation.addButton(withTitle: TiboTattleLocalization.string(.commonContinue) + "…")
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        confirmLocalKeychainResetStepTwo()
    }

    private func confirmLocalKeychainResetStepTwo() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .critical
        confirmation.messageText = TiboTattleLocalization.string(
            .dialogResetCapabilities
        )
        confirmation.informativeText = TiboTattleLocalization.format(
            .dialogResetCapabilitiesDescription,
            BundledProduct.displayName
        )
        confirmation.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        confirmation.addButton(
            withTitle: TiboTattleLocalization.string(.dialogResetLocalIdentity)
        )
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        performLocalKeychainReset()
    }

    private func performLocalKeychainReset() {
        guard keychainResetProcess == nil else { return }
        lastLifecycleStatus = "Resetting local identity"
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherResettingLocalIdentity
        )
        detailLabel.stringValue = TiboTattleLocalization.string(
            .launcherResettingLocalIdentityDetail
        )
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        startupTimeout?.cancel()
        launchGeneration += 1
        let previous = companion
        companion = nil
        let runReset = { [weak self] in
            DispatchQueue.main.async {
                self?.launchLocalKeychainResetHelper()
            }
        }
        if let previous, previous.isRunning {
            previous.stop(completion: runReset)
        } else {
            runReset()
        }
    }

    private func launchLocalKeychainResetHelper() {
        do {
            let resources = try CompanionResources.bundled()
            let stateRoot = try ownerOnlyStateRoot()
            let homeDirectory = try currentUserHomeDirectory()
            let child = Process()
            let standardOutput = Pipe()
            let standardError = Pipe()
            child.executableURL = resources.node
            child.arguments = [
                resources.keychainResetEntrypoint.path,
                "--confirm-local-keychain-reset",
            ]
            child.currentDirectoryURL = resources.resourceRoot
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = standardOutput
            child.standardError = standardError
            let inherited = ProcessInfo.processInfo.environment
            var environment: [String: String] = [
                "HOME": homeDirectory.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "NODE_ENV": "production",
                "USAGE_MONITOR_STATE_ROOT": stateRoot.path,
            ]
            for name in ["LANG", "LC_ALL", "TMPDIR"] {
                if let value = inherited[name], !value.contains("\0") {
                    environment[name] = value
                }
            }
            child.environment = environment
            child.terminationHandler = { [weak self] terminated in
                let output = standardOutput.fileHandleForReading
                    .readDataToEndOfFile()
                let errorOutput = standardError.fileHandleForReading
                    .readDataToEndOfFile()
                DispatchQueue.main.async {
                    self?.keychainResetProcess = nil
                    self?.finishLocalKeychainReset(
                        status: terminated.terminationStatus,
                        output: output,
                        errorOutput: errorOutput
                    )
                }
            }
            keychainResetProcess = child
            try child.run()
        } catch {
            keychainResetProcess = nil
            showFailure(LauncherError.keychainReset)
        }
    }

    private func finishLocalKeychainReset(
        status: Int32,
        output: Data,
        errorOutput: Data
    ) {
        let decoded = try? JSONDecoder().decode(
            LocalKeychainResetResult.self,
            from: output
        )
        if status == 0, let decoded, decoded.isCompleteReset {
            let result = NSAlert()
            result.messageText = TiboTattleLocalization.string(
                .dialogIdentityDeviceResetComplete
            )
            result.informativeText = TiboTattleLocalization.format(
                .dialogIdentityDeviceResetCompleteDescription,
                BundledProduct.displayName
            )
            result.addButton(withTitle: TiboTattleLocalization.string(.dialogDone))
            result.runModal()
            retryAllowed = true
            startCompanion()
            return
        }

        let fixedCode = String(data: errorOutput, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resultCode = decoded?.failureCode ?? fixedCode
        switch resultCode {
        case LauncherError.keychainLocked.failureCode:
            showFailure(LauncherError.keychainLocked)
        case LauncherError.keychainDenied.failureCode:
            showFailure(LauncherError.keychainDenied)
        case LauncherError.keychainResetPartial.failureCode:
            showFailure(LauncherError.keychainResetPartial)
        default:
            if status == 2 || decoded?.status == "partial" {
                showFailure(LauncherError.keychainResetPartial)
            } else {
                showFailure(LauncherError.keychainReset)
            }
        }
    }

    private func eraseLocalData() {
        lastLifecycleStatus = "Erasing local data"
        statusLabel.stringValue = TiboTattleLocalization.string(
            .launcherMovingLocalDataToTrash
        )
        detailLabel.stringValue = TiboTattleLocalization.string(
            .launcherMovingLocalDataToTrashDetail
        )
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        launchGeneration += 1
        let previous = companion
        companion = nil
        let erase = { [weak self] in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let stateRoot = try ownerOnlyStateRoot()
                    try FileManager.default.trashItem(
                        at: stateRoot,
                        resultingItemURL: nil
                    )
                    DispatchQueue.main.async {
                        guard let self, !self.quitting else { return }
                        do {
                            self.codexHomeConfiguration =
                                CodexHomeConfiguration(
                                    mode: .defaultLocation,
                                    url: try defaultCodexHome()
                                )
                        } catch {
                            self.showFailure(error)
                            return
                        }
                        self.lastLifecycleStatus = "Local data erased"
                        self.statusLabel.stringValue =
                            TiboTattleLocalization.string(
                                .launcherLocalDataMovedToTrash
                            )
                        self.detailLabel.stringValue =
                            TiboTattleLocalization.string(
                                .launcherLocalDataMovedToTrashDetail
                            )
                        self.startCompanion()
                    }
                } catch {
                    DispatchQueue.main.async {
                        self?.showFailure(LauncherError.dataErase)
                    }
                }
            }
        }
        if let previous, previous.isRunning {
            previous.stop(completion: erase)
        } else {
            erase()
        }
    }

    @objc private func quitApplication() {
        NSApp.terminate(nil)
    }

    func application(
        _ application: NSApplication,
        open urls: [URL]
    ) {
        guard !urls.isEmpty,
              urls.allSatisfy(semanticOpenTarget.accepts)
        else {
            lastLifecycleStatus = "Rejected unsupported app link"
            lastFailureCode = "UM_MACOS_APP_LINK_REJECTED"
            lastRecoverySuggestion =
                "Use only the exact \(semanticOpenTarget.canonicalURL) link."
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // A hosted sign-in callback lands here after the browser has already
        // finished. Reloading the loopback document at this point would erase
        // its unpersisted state/proof and make a completed sign-in appear to
        // do nothing. Keep the existing dashboard alive and ask it to poll
        // immediately instead.
        if dashboardWebViewShowing {
            dashboardWebHost?.notifyHostedSignInReturn()
            return
        }
        pendingDashboardOpen = true
        if dashboardURL != nil {
            pendingDashboardOpen = false
            openDashboard()
        } else if companion?.isRunning != true {
            retryCompanion()
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window, !quitting else { return true }
        // The native window is a surface, not the application lifecycle. Keep
        // the companion and menu-bar item alive when the user closes it; the
        // explicit Quit action remains the only normal termination path.
        sender.orderOut(nil)
        return false
    }

    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        startupTimeout?.cancel()
        startupTimeout = nil
        if keychainResetProcess?.isRunning == true {
            let alert = NSAlert()
            alert.messageText = TiboTattleLocalization.string(.dialogResetFinishing)
            alert.informativeText = TiboTattleLocalization.string(
                .dialogResetFinishingDescription
            )
            alert.addButton(withTitle: TiboTattleLocalization.string(.commonOK))
            alert.runModal()
            return .terminateCancel
        }
        guard !quitting, companion?.isRunning == true else {
            // When the companion is already stopped there is no asynchronous
            // cleanup to wait for. Mark termination as intentional so the
            // window-close delegate cannot turn an explicit Quit into a
            // hide-only action.
            quitting = true
            return .terminateNow
        }
        quitting = true
        companion?.stop {
            DispatchQueue.main.async {
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        startupTimeout?.cancel()
        cancelNativeRefreshPoll()
        cancelNativeRefreshSchedule()
        nativeEvidenceReader.invalidate()
        // Released here so the status item can never outlive the companion it
        // reports on. The companion itself is stopped by the graceful
        // `applicationShouldTerminate` path above, which every Quit control
        // — window button and menu-bar item alike — routes through.
        menuBarStatus?.shutDown()
        menuBarStatus = nil
        if companion?.isRunning == true {
            companion?.stop {}
        }
    }
}

// Sign in with Apple is deliberately absent from this app. Apple provisions
// the entitlement only for Ad hoc, App Store Connect, and Development
// distribution, never Developer ID, and a Developer ID build carrying it is
// terminated by the kernel at launch. Both hosted providers instead
// authenticate in the user's own browser against the contribution service,
// which owns the redirect; the dashboard in this window polls that service for
// the one-time result, so no provider host is ever asked of this web view and
// no browser tab has to be kept open to finish.

private func endpointReportsReady(_ url: URL) -> Bool {
    let completed = DispatchSemaphore(value: 0)
    let stateLock = NSLock()
    var passed = false
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 5
    let session = URLSession(configuration: configuration)
    let task = session.dataTask(with: url) { data, response, _ in
        let status = (response as? HTTPURLResponse)?.statusCode
        stateLock.lock()
        if status == 200,
           let data,
           let object = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
           object["status"] as? String == "ready" {
            passed = true
        }
        stateLock.unlock()
        completed.signal()
    }
    task.resume()
    _ = completed.wait(timeout: .now() + .seconds(7))
    session.invalidateAndCancel()
    stateLock.lock()
    let result = passed
    stateLock.unlock()
    return result
}

private enum SmokeTest {
    static func run(requireCentralService: Bool = false) -> Int32 {
        _ = umask(0o077)
        let centralService: CentralServiceConfiguration?
        do {
            centralService = try CentralServiceConfiguration.bundled()
        } catch {
            FileHandle.standardError.write(
                Data("macOS smoke: central configuration invalid\n".utf8)
            )
            return 1
        }
        if requireCentralService && centralService == nil {
            FileHandle.standardError.write(
                Data("macOS smoke: central service not configured\n".utf8)
            )
            return 1
        }
        guard let codexHome = try? defaultCodexHome() else {
            FileHandle.standardError.write(
                Data("macOS smoke: Codex home unavailable\n".utf8)
            )
            return 1
        }
        let ready = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var dashboardURL: URL?
        var exitedEarly = false
        let companion = CompanionProcess(
            centralService: centralService,
            codexHome: codexHome,
            onReady: { url in
                stateLock.lock()
                dashboardURL = url
                stateLock.unlock()
                ready.signal()
            },
            onExit: { requested, _ in
                if !requested {
                    stateLock.lock()
                    exitedEarly = true
                    stateLock.unlock()
                    ready.signal()
                }
            }
        )
        do {
            try companion.launch()
        } catch {
            FileHandle.standardError.write(
                Data("macOS smoke: launch failed\n".utf8)
            )
            return 1
        }

        let timeout = DispatchTime.now() + .seconds(20)
        guard ready.wait(timeout: timeout) == .success else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS smoke: readiness timeout\n".utf8)
            )
            return 1
        }
        stateLock.lock()
        let selectedURL = dashboardURL
        let didExitEarly = exitedEarly
        stateLock.unlock()
        guard !didExitEarly, let selectedURL else {
            FileHandle.standardError.write(
                Data("macOS smoke: companion exited\n".utf8)
            )
            return 1
        }

        let health = DispatchSemaphore(value: 0)
        var healthPassed = false
        let healthURL = selectedURL.appendingPathComponent("api/local/health")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: healthURL) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            stateLock.lock()
            if status == 200,
               let data,
               let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any],
               object["status"] as? String == "ready" {
                healthPassed = true
            }
            stateLock.unlock()
            health.signal()
        }
        task.resume()
        _ = health.wait(timeout: .now() + .seconds(7))
        session.invalidateAndCancel()

        let centralWasReady = !requireCentralService || endpointReportsReady(
            selectedURL.appendingPathComponent("api/ready")
        )
        companion.stop { stopped.signal() }
        let stoppedCleanly =
            stopped.wait(timeout: .now() + .seconds(4)) == .success
        stateLock.lock()
        let healthWasReady = healthPassed
        stateLock.unlock()
        guard healthWasReady, stoppedCleanly else {
            FileHandle.standardError.write(
                Data("macOS smoke: local health check failed\n".utf8)
            )
            return 1
        }
        guard centralWasReady else {
            FileHandle.standardError.write(
                Data("macOS smoke: central readiness check failed\n".utf8)
            )
            return 1
        }
        if requireCentralService {
            print(
                "USAGE_MONITOR_MACOS_CENTRAL_SMOKE_READY "
                    + "host=\(loopbackHost) "
                    + "port=\(selectedURL.port ?? 0) "
                    + "central=\(centralService?.mode.rawValue ?? "invalid")"
            )
            return 0
        }
        print(
            "USAGE_MONITOR_MACOS_SMOKE_READY host=\(loopbackHost) "
                + "port=\(selectedURL.port ?? 0) state=owner-only"
        )
        return 0
    }
}

private enum WatchdogSmokeTest {
    static func run() -> Int32 {
        _ = umask(0o077)
        let centralService: CentralServiceConfiguration?
        do {
            centralService = try CentralServiceConfiguration.bundled()
        } catch {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: central configuration invalid\n".utf8)
            )
            return 1
        }
        guard let codexHome = try? defaultCodexHome() else {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: Codex home unavailable\n".utf8)
            )
            return 1
        }
        let ready = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var dashboardURL: URL?
        var exitedEarly = false
        let companion = CompanionProcess(
            centralService: centralService,
            codexHome: codexHome,
            onReady: { url in
                stateLock.lock()
                dashboardURL = url
                stateLock.unlock()
                ready.signal()
            },
            onExit: { requested, _ in
                if !requested {
                    stateLock.lock()
                    exitedEarly = true
                    stateLock.unlock()
                    ready.signal()
                }
            }
        )
        do {
            try companion.launch()
        } catch {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: launch failed\n".utf8)
            )
            return 1
        }

        guard ready.wait(timeout: .now() + .seconds(20)) == .success else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: readiness timeout\n".utf8)
            )
            return 1
        }
        stateLock.lock()
        let selectedURL = dashboardURL
        let didExitEarly = exitedEarly
        stateLock.unlock()
        guard !didExitEarly,
              let selectedURL,
              let childProcessIdentifier = companion.processIdentifier
        else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: companion exited\n".utf8)
            )
            return 1
        }

        print(
            "USAGE_MONITOR_MACOS_WATCHDOG_READY "
                + "launcher=\(getpid()) "
                + "child=\(childProcessIdentifier) "
                + "host=\(loopbackHost) "
                + "port=\(selectedURL.port ?? 0)"
        )
        fflush(stdout)

        // The executable test harness sends SIGKILL after reading the line
        // above. Bound this mode so an interrupted harness still stops cleanly.
        _ = DispatchSemaphore(value: 0).wait(
            timeout: .now() + .seconds(30)
        )
        companion.stop { stopped.signal() }
        _ = stopped.wait(timeout: .now() + .seconds(4))
        return 1
    }
}

private enum LifecycleContractSmokeTest {
    static func diagnostics() -> Int32 {
        let rendered = LifecycleDiagnostics.render(
            version: Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "unknown",
            build: "1",
            lifecycle: "Could not start",
            failureCode: LauncherError.companionTimeout.failureCode,
            recovery: LauncherError.companionTimeout.recoverySuggestion,
            centralConfigured: false,
            codexHomeMode: .custom,
            codexHomeValidated: true,
            appStateAvailable: true,
            loginItemStatus: .requiresApproval,
            loginItemLastOperation: .registerRequiresApproval
        )
        print(rendered)
        return rendered.contains("/") ? 1 : 0
    }

    static func codexHomeSettings(codexHomePath: String) -> Int32 {
        _ = umask(0o077)
        do {
            let stateRoot = try ownerOnlyStateRoot()
            let selected = try saveCodexHomeConfiguration(
                URL(
                    fileURLWithPath: codexHomePath,
                    isDirectory: true
                ),
                stateRoot: stateRoot
            )
            let loaded = try loadCodexHomeConfiguration(
                stateRoot: stateRoot
            )
            guard selected.mode == .custom,
                  loaded.mode == .custom,
                  selected.url == loaded.url
            else {
                return 1
            }
            print(
                "USAGE_MONITOR_MACOS_CODEX_HOME_READY "
                    + "mode=custom persisted=true path_exposed=false"
            )
            return 0
        } catch {
            FileHandle.standardError.write(
                Data("macOS Codex home settings smoke failed\n".utf8)
            )
            return 1
        }
    }

    static func keychainResetContract() -> Int32 {
        let completePayload = Data(
            """
            {
              "schemaVersion": "usage-monitor-local-keychain-reset-v1",
              "status": "reset",
              "failureCode": null,
              "appState": {
                "allAppStateErased": false,
                "contributionDeviceBinding": "removed",
                "exportIdentityFileResidue": "missing",
                "otherAppStateRetained": true
              },
              "keychain": {
                "contributionDevice": "removed",
                "exportIdentity": "missing",
                "secureErasureClaimed": false
              },
              "hosted": {
                "dataDeleted": false,
                "deviceRevoked": false
              }
            }
            """.utf8
        )
        let falseSuccessPayload = Data(
            """
            {
              "schemaVersion": "usage-monitor-local-keychain-reset-v1",
              "status": "reset",
              "failureCode": null,
              "appState": {
                "allAppStateErased": false,
                "contributionDeviceBinding": "removed",
                "exportIdentityFileResidue": "retained",
                "otherAppStateRetained": true
              },
              "keychain": {
                "contributionDevice": "removed",
                "exportIdentity": "retained",
                "secureErasureClaimed": false
              },
              "hosted": {
                "dataDeleted": false,
                "deviceRevoked": false
              }
            }
            """.utf8
        )
        let decoder = JSONDecoder()
        guard let complete = try? decoder.decode(
                  LocalKeychainResetResult.self,
                  from: completePayload
              ),
              complete.isCompleteReset,
              let falseSuccess = try? decoder.decode(
                  LocalKeychainResetResult.self,
                  from: falseSuccessPayload
              ),
              !falseSuccess.isValid,
              !falseSuccess.isCompleteReset
        else {
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_KEYCHAIN_RESET_CONTRACT "
                + "targets=2 app_state=targeted hosted_mutation=false "
                + "secure_erasure=false confirmations=2"
        )
        return 0
    }

    static func firstRunContract() -> Int32 {
        _ = umask(0o077)
        do {
            let stateRoot = try ownerOnlyStateRoot()
            guard try !hasCompletedFirstRun(stateRoot: stateRoot) else {
                return 1
            }
            try markFirstRunCompleted(stateRoot: stateRoot)
            guard try hasCompletedFirstRun(stateRoot: stateRoot) else {
                return 1
            }
            print(
                "USAGE_MONITOR_MACOS_FIRST_RUN_CONTRACT "
                    + "persisted=true owner_only=true upload=false"
            )
            return 0
        } catch {
            FileHandle.standardError.write(
                Data("macOS first-run contract smoke failed\n".utf8)
            )
            return 1
        }
    }
}

/// Exercises the login-item seam with a fake manager.  This mode deliberately
/// never constructs the production login-item adapter or opens System Settings;
/// it proves the registration boundary in an isolated
/// launcher process instead of mutating the developer's Login Items state.
private enum LoginItemContractSmokeTest {
    private final class FakeManager: LoginItemManaging {
        var status: LoginItemStatus = .notRegistered
        var registerCalls = 0
        var unregisterCalls = 0
        var settingsCalls = 0
        var registerError: Error?
        var unregisterError: Error?
        var registerStatusAfterCall: LoginItemStatus?
        var unregisterStatusAfterCall: LoginItemStatus?

        func register() throws {
            registerCalls += 1
            if let registerError {
                throw registerError
            }
            status = registerStatusAfterCall ?? .enabled
        }

        func unregister() throws {
            unregisterCalls += 1
            if let unregisterError {
                throw unregisterError
            }
            status = unregisterStatusAfterCall ?? .notRegistered
        }

        func openSystemSettings() {
            settingsCalls += 1
        }
    }

    private struct FakeError: Error {}

    static func run() -> Int32 {
        let manager = FakeManager()
        do {
            // An unchecked first-run option must not register or even need a
            // status mutation.  This is the upgrade/no-silent-registration
            // boundary for existing first-run receipts.
            guard try !registerLoginItemForFirstRun(
                startAtLogin: false,
                manager: manager
            ), manager.registerCalls == 0,
                  manager.status == .notRegistered
            else {
                return 1
            }

            // All four status states have an explicit settings presentation.
            // Pending approval never masquerades as a usable off switch; it
            // exposes an explicit removal route instead.
            guard loginItemSettingsPresentation(for: .enabled)
                    == LoginItemSettingsPresentation(
                        isEnabled: true,
                        isOn: true,
                        showsPendingRemoval: false
                    ),
                  loginItemSettingsPresentation(for: .notRegistered)
                    == LoginItemSettingsPresentation(
                        isEnabled: true,
                        isOn: false,
                        showsPendingRemoval: false
                    ),
                  loginItemSettingsPresentation(for: .requiresApproval)
                    == LoginItemSettingsPresentation(
                        isEnabled: false,
                        isOn: false,
                        showsPendingRemoval: true
                    ),
                  loginItemSettingsPresentation(for: .unknown)
                    == LoginItemSettingsPresentation(
                        isEnabled: false,
                        isOn: false,
                        showsPendingRemoval: false
                    )
            else {
                return 1
            }

            // A concurrent System Settings change may make a request
            // idempotently true while its original call reports an error. Only
            // independently confirmed, approval-required, or unavailable
            // states are reconciled; a plain unconfirmed request stays an
            // error.
            guard reconciledLoginItemOperationResultAfterError(
                operation: .register,
                status: .enabled
            ) == .confirmed,
                  reconciledLoginItemOperationResultAfterError(
                    operation: .register,
                    status: .requiresApproval
                  ) == .requiresApproval,
                  reconciledLoginItemOperationResultAfterError(
                    operation: .unregister,
                    status: .unknown
                  ) == .unavailable,
                  reconciledLoginItemOperationResultAfterError(
                    operation: .register,
                    status: .notRegistered
                  ) == nil
            else {
                return 1
            }

            guard try registerLoginItemForFirstRun(
                startAtLogin: true,
                manager: manager
            ), manager.registerCalls == 1,
                  manager.status == .enabled,
                  loginItemOperationResult(
                    operation: .register,
                    status: manager.status
                  ) == .confirmed
            else {
                return 1
            }

            try manager.unregister()
            guard manager.unregisterCalls == 1,
                  manager.status == .notRegistered,
                  loginItemOperationResult(
                    operation: .unregister,
                    status: manager.status
                  ) == .confirmed
            else {
                return 1
            }

            manager.registerStatusAfterCall = .requiresApproval
            try manager.register()
            guard manager.registerCalls == 2,
                  manager.status == .requiresApproval,
                  loginItemOperationResult(
                    operation: .register,
                    status: manager.status
                  ) == .requiresApproval
            else {
                return 1
            }

            // Removal stays available if an approval-pending request needs to
            // be withdrawn. A non-throwing unregister is still checked before
            // the UI claims it worked.
            manager.unregisterStatusAfterCall = .enabled
            try manager.unregister()
            guard manager.unregisterCalls == 2,
                  loginItemOperationResult(
                    operation: .unregister,
                    status: manager.status
                  ) == .notConfirmed
            else {
                return 1
            }

            manager.registerStatusAfterCall = .notRegistered
            try manager.register()
            guard manager.registerCalls == 3,
                  loginItemOperationResult(
                    operation: .register,
                    status: manager.status
                  ) == .notConfirmed
            else {
                return 1
            }

            manager.registerStatusAfterCall = .unknown
            try manager.register()
            guard manager.registerCalls == 4,
                  loginItemOperationResult(
                    operation: .register,
                    status: manager.status
                  ) == .unavailable
            else {
                return 1
            }

            manager.unregisterStatusAfterCall = .unknown
            try manager.unregister()
            guard manager.unregisterCalls == 3,
                  loginItemOperationResult(
                    operation: .unregister,
                    status: manager.status
                  ) == .unavailable
            else {
                return 1
            }

            manager.registerError = FakeError()
            do {
                try manager.register()
                return 1
            } catch {
                // Denied/error paths remain injectable and do not fall back to
                // a hidden process or an unreviewed legacy API.
            }
            guard manager.registerCalls == 5,
                  LoginItemDiagnosticAction.make(
                    operation: .register,
                    result: .failed
                  ) == .registerFailed
            else {
                return 1
            }

            manager.unregisterError = FakeError()
            do {
                try manager.unregister()
                return 1
            } catch {
                // Expected error path.
            }
            guard manager.unregisterCalls == 4,
                  LoginItemDiagnosticAction.make(
                    operation: .unregister,
                    result: .failed
                  ) == .unregisterFailed,
                  manager.settingsCalls == 0
            else {
                return 1
            }
        } catch {
            return 1
        }

        print(
            "USAGE_MONITOR_MACOS_LOGIN_ITEM_CONTRACT "
                + "fake=true register=affirmative-only unregister=explicit "
                + "status=enabled,not-registered,requires-approval,unavailable "
                + "outcomes=confirmed,requires-approval,not-confirmed,unavailable,failed "
                + "pending_removal=true real_service_calls=0 daemon=false"
        )
        return 0
    }
}

/// Exercises the real AppKit status item without starting the local companion
/// or reading any local evidence. This catches the class of regression where a
/// custom menu view has no measured frame and leaves an apparently empty menu
/// header in an installed build.
@MainActor
private enum MenuBarContractSmokeTest {
    static func run() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = MenuBarStatusController(
            productName: BundledProduct.displayName,
            actions: MenuBarStatusController.Actions(
                openTiboTattle: {},
                showSettings: {},
                showAbout: {},
                quit: {}
            )
        )
        let starting = controller.nativePresentationContract()
        controller.companionUnavailable(
            summary: "The local companion is unavailable for this smoke test."
        )
        let unavailable = controller.nativePresentationContract()
        controller.shutDown()
        guard starting.informationRowsAreNative,
              starting.informationRowsHaveTitles,
              unavailable.informationRowsAreNative,
              unavailable.unavailableRowHasTitle,
              starting.analyzeShortcut == "r",
              starting.settingsShortcut == ",",
              starting.quitShortcut == "q",
              starting.usesNativeStatusItemMenu,
              starting.escapeDismissalMonitorInstalled,
              starting.sameAppClickAwayMonitorInstalled,
              starting.appDeactivationDismissalObserverInstalled
        else {
            FileHandle.standardError.write(
                Data("macOS menu bar contract smoke failed\\n".utf8)
            )
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_MENU_BAR_CONTRACT "
                + "native_rows=true titles=true states=starting,unavailable "
                + "shortcuts=cmd-r,cmd-comma,cmd-q "
                + "dismissal=native,escape,same-app,deactivation"
        )
        return 0
    }
}

/// Lays out the installed AppKit dashboard frame without starting a companion
/// or loading a page. This catches a native split-view regression where the
/// loopback server is healthy but WebKit receives no usable display frame.
@MainActor
private enum NativeDashboardLayoutSmokeTest {
    static func run() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let host = DashboardWebHost(
            onLoaded: {},
            onFailure: { _ in },
            onDownloadFailure: {},
            openExternally: { _ in },
            onNavigation: { _ in },
            onLanguagePreferenceChange: { _ in }
        )
        let chrome = NativeDashboardChrome(webView: host.webView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = chrome
        window.displayIfNeeded()
        chrome.layoutSubtreeIfNeeded()
        let webFrame = host.webView.frame
        guard webFrame.width >= 600, webFrame.height >= 600 else {
            FileHandle.standardError.write(
                Data("macOS native dashboard layout smoke failed\\n".utf8)
            )
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_NATIVE_DASHBOARD_LAYOUT "
                + "web_width=\(Int(webFrame.width)) "
                + "web_height=\(Int(webFrame.height))"
        )
        return 0
    }
}

@main
private struct UsageMonitorMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        // This isolated seam smoke intentionally runs before bundle branding
        // is resolved, so it can execute as a plain launcher binary without
        // constructing the production login-item adapter.
        if arguments.contains("--login-item-contract-smoke-test") {
            exit(LoginItemContractSmokeTest.run())
        }
        let semanticOpenTarget = SemanticOpenTarget(
            scheme: BundledProduct.appOpenScheme,
            host: BundledProduct.appOpenHost,
            canonicalURL: BundledProduct.appOpenURL
        )
        if let linkIndex = arguments.firstIndex(of: "--app-link-smoke-test") {
            guard linkIndex + 1 < arguments.count,
                  let link = URL(string: arguments[linkIndex + 1])
            else {
                exit(2)
            }
            exit(semanticOpenTarget.accepts(link) ? 0 : 1)
        }
        if arguments.contains("--central-smoke-test") {
            exit(SmokeTest.run(requireCentralService: true))
        }
        if arguments.contains("--smoke-test") {
            exit(SmokeTest.run())
        }
        if arguments.contains("--updater-contract-smoke-test") {
            let description = AppUpdater.runtimeDescription
            print(
                "USAGE_MONITOR_MACOS_UPDATER_CONTRACT "
                    + "runtime=\(description)"
                    + " state=\(AppUpdater.runtimeStateDescription)"
            )
            exit(description == "invalid_framework_missing" ? 1 : 0)
        }
        if let feedIndex = arguments.firstIndex(
            of: "--updater-feed-contract-smoke-test"
        ) {
            guard feedIndex + 1 < arguments.count,
                  let statusCode = Int(arguments[feedIndex + 1])
            else {
                exit(2)
            }
            let hasBody = (200..<300).contains(statusCode)
            let reachable = AppUpdater.feedResponseIsReachable(
                statusCode: statusCode,
                hasError: false,
                hasBody: hasBody
            )
            print(
                "USAGE_MONITOR_MACOS_UPDATER_FEED_CONTRACT "
                    + "status=\(statusCode) "
                    + "result=\(reachable ? "reachable" : "failed") "
                    + "sparkle_check=\(reachable)"
            )
            exit(0)
        }
        if arguments.contains("--watchdog-smoke-test") {
            exit(WatchdogSmokeTest.run())
        }
        if arguments.contains("--diagnostics-smoke-test") {
            exit(LifecycleContractSmokeTest.diagnostics())
        }
        if let settingsIndex = arguments.firstIndex(
            of: "--codex-home-settings-smoke-test"
        ) {
            guard settingsIndex + 1 < arguments.count else {
                exit(2)
            }
            exit(
                LifecycleContractSmokeTest.codexHomeSettings(
                    codexHomePath: arguments[settingsIndex + 1]
                )
            )
        }
        if arguments.contains("--keychain-reset-contract-smoke-test") {
            exit(LifecycleContractSmokeTest.keychainResetContract())
        }
        if arguments.contains("--first-run-contract-smoke-test") {
            exit(LifecycleContractSmokeTest.firstRunContract())
        }
        if arguments.contains("--menu-bar-contract-smoke-test") {
            exit(MainActor.assumeIsolated {
                MenuBarContractSmokeTest.run()
            })
        }
        if arguments.contains("--quota-notification-contract-smoke-test") {
            exit(MainActor.assumeIsolated {
                QuotaNotificationContractSmokeTest.run()
            })
        }
        if arguments.contains("--native-dashboard-layout-smoke-test") {
            exit(MainActor.assumeIsolated {
                NativeDashboardLayoutSmokeTest.run()
            })
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate(semanticOpenTarget: semanticOpenTarget)
        application.delegate = delegate
        application.run()
    }
}
