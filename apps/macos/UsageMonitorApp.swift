import AppKit
import CoreFoundation
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
    static let nodeRuntimeMode = requiredString("UsageMonitorNodeRuntimeMode")
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

private enum BundledNodeRuntimeMode: String {
    case standard
    case jitless

    func arguments(
        entrypoint: URL,
        trailing: [String] = []
    ) -> [String] {
        let runtimeArguments = self == .jitless ? ["--jitless"] : []
        return runtimeArguments + [entrypoint.path] + trailing
    }
}

private enum AppUpdaterState: Equatable {
    case unavailable
    case unverified
    case ready
    case checking
    case updateAvailable
    case verifiedNoUpdate
    case failed
}

private enum NativeDashboardEvidenceState: Equatable {
    case unknown
    case live
    case stale
    case readFailed
    case lifecycleUnavailable
}

/// Unified-history indexing coverage from the companion's own overview
/// payload. While the local index is still advancing, the toolbar pill shows
/// these two counts verbatim; nothing here is estimated or carried forward.
private struct NativeHistoryIndexingCoverage: Equatable {
    let indexedSourceCount: Int
    let sourceCount: Int

    var isComplete: Bool {
        indexedSourceCount >= sourceCount
    }
}

/// One bounded read of the companion's overview coverage. `notIndexing`
/// means the payload was readable but carries no real indexing progress to
/// narrate (demo data, or no coverage block at all); a `nil` observation from
/// the reader means the endpoint was unreadable and the previous observation
/// is kept rather than invented.
private enum NativeHistoryIndexingObservation: Equatable {
    case indexing(NativeHistoryIndexingCoverage)
    case notIndexing
}

/// Terminal identity of the companion's last explicit refresh, from its own
/// `/api/local/refresh` receipt. The step name is admitted only from the
/// companion's closed refresh-step vocabulary, so the pill can never carry
/// free-form failure text.
private struct NativeRefreshFailure: Equatable {
    let failedStep: String?
}

private enum NativeRefreshTerminalObservation: Equatable {
    case failed(step: String?)
    case notFailed
}

/// Fixed pill vocabulary for the two states the shared localization table
/// does not carry. Deliberately content-free: fixed words plus locale-
/// formatted counts, or a step name from the closed vocabulary above.
private enum NativeToolbarStatusText {
    static func indexing(
        indexedSourceCount: Int,
        sourceCount: Int
    ) -> String {
        let formatter = TiboTattleLocalization.decimalNumberFormatter(
            maximumFractionDigits: 0
        )
        let indexed = formatter.string(
            from: NSNumber(value: indexedSourceCount)
        ) ?? String(indexedSourceCount)
        let total = formatter.string(
            from: NSNumber(value: sourceCount)
        ) ?? String(sourceCount)
        return "Indexing \(indexed) of \(total)"
    }

    static func refreshFailed(step: String?) -> String {
        guard let step else { return "Refresh failed" }
        return "Refresh failed: \(step)"
    }
}

/// Toolbar-pill facts the shared menu-bar projection intentionally leaves
/// behind: unified-history indexing coverage from the overview payload, and
/// the terminal failure identity of the companion's last explicit refresh.
/// Both reads reuse the already-audited loopback reader — same session, same
/// headers, same size cap — so no second network route is introduced.
private extension LocalCompanionEvidenceReader {
    /// The companion's fixed refresh-step vocabulary. An unrecognized step is
    /// dropped rather than shown, keeping the pill content-free.
    static let refreshFailureSteps: Set<String> = [
        "collector",
        "accounting",
        "archive_index",
        "unified_index",
        "assemble",
    ]

    func readHistoryIndexingCoverage(
        base: URL,
        completion: @escaping (NativeHistoryIndexingObservation?) -> Void
    ) {
        guard let url = loopbackEndpoint(base, path: "/api/local/overview")
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let observation = Self.acceptedPayload(data, response)
                .flatMap(Self.decodeHistoryIndexingObservation)
            DispatchQueue.main.async { completion(observation) }
        }
        task.resume()
    }

    func readRefreshTerminalObservation(
        base: URL,
        completion: @escaping (NativeRefreshTerminalObservation?) -> Void
    ) {
        guard let url = loopbackEndpoint(base, path: "/api/local/refresh")
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let observation = Self.acceptedPayload(data, response)
                .flatMap(Self.decodeRefreshTerminalObservation)
            DispatchQueue.main.async { completion(observation) }
        }
        task.resume()
    }

    static func decodeHistoryIndexingObservation(
        _ data: Data
    ) -> NativeHistoryIndexingObservation? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any]
        else {
            return nil
        }
        // A demo payload may advertise synthetic coverage; the pill only
        // narrates the real local index.
        if let mode = root["mode"] as? String,
           ["demo", "synthetic"].contains(mode) {
            return .notIndexing
        }
        let history = (root["coverage"] as? [String: Any])?["history"]
            as? [String: Any]
            ?? (root["pricing"] as? [String: Any])?["historyCoverage"]
            as? [String: Any]
        guard let history,
              let indexed = (history["indexedSourceCount"] as? NSNumber)?
                .intValue,
              let total = (history["sourceCount"] as? NSNumber)?.intValue,
              indexed >= 0,
              total >= 0
        else {
            return .notIndexing
        }
        return .indexing(NativeHistoryIndexingCoverage(
            indexedSourceCount: indexed,
            sourceCount: total
        ))
    }

    static func decodeRefreshTerminalObservation(
        _ data: Data
    ) -> NativeRefreshTerminalObservation? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any],
            let refresh = root["refresh"] as? [String: Any],
            let status = refresh["status"] as? String
        else {
            return nil
        }
        guard status == "failed" else { return .notFailed }
        let step = refresh["failedStep"] as? String
        return .failed(
            step: step.flatMap {
                Self.refreshFailureSteps.contains($0) ? $0 : nil
            }
        )
    }
}

private enum NativeRefreshIntervalPreference {
    static let defaultsKey = "tibotattle.refresh-interval.v1"
    static let defaultSeconds = 5 * 60
    static let allowedSeconds = [60, 5 * 60, 15 * 60, 30 * 60]

    static var seconds: Int {
        seconds(in: UserDefaults.standard)
    }

    static func seconds(in defaults: UserDefaults) -> Int {
        let stored = defaults.integer(forKey: defaultsKey)
        return allowedSeconds.contains(stored) ? stored : defaultSeconds
    }

    static func setSeconds(_ value: Int) {
        setSeconds(value, in: UserDefaults.standard)
    }

    static func setSeconds(_ value: Int, in defaults: UserDefaults) {
        guard allowedSeconds.contains(value) else { return }
        defaults.set(value, forKey: defaultsKey)
    }
}

private enum NativeRefreshIntervalSelection {
    @discardableResult
    static func apply(
        seconds: Int,
        defaults: UserDefaults,
        dashboardAvailable: Bool,
        refreshInFlight: Bool,
        reschedule: () -> Void
    ) -> Bool {
        guard NativeRefreshIntervalPreference.allowedSeconds.contains(seconds)
        else {
            return false
        }
        NativeRefreshIntervalPreference.setSeconds(seconds, in: defaults)
        guard dashboardAvailable, !refreshInFlight else { return true }
        reschedule()
        return true
    }
}

/// The only cadence used by the native foreground refresh loop. Keeping the
/// persisted read beside the dispatch operation makes it impossible for the
/// Settings picker to update one value while the scheduler keeps using a
/// separate hard-coded delay.
private struct NativeForegroundRefreshSchedule: Equatable {
    let intervalSeconds: Int

    static func current(
        in defaults: UserDefaults = .standard
    ) -> NativeForegroundRefreshSchedule {
        NativeForegroundRefreshSchedule(
            intervalSeconds: NativeRefreshIntervalPreference.seconds(
                in: defaults
            )
        )
    }
}

private enum NativeForegroundRefreshScheduler {
    /// This scheduler is deliberately an in-process main-queue work item. It
    /// is cancelled when the app quits or when a refresh starts, and it never
    /// creates a timer, helper, daemon, or background polling path.
    static func schedule(
        defaults: UserDefaults = .standard,
        now: DispatchTime = .now(),
        action: @escaping () -> Void,
        enqueue: @escaping (DispatchTime, DispatchWorkItem) -> Void = {
            deadline,
            work in
            DispatchQueue.main.asyncAfter(deadline: deadline, execute: work)
        }
    ) -> DispatchWorkItem {
        let schedule = NativeForegroundRefreshSchedule.current(in: defaults)
        let work = DispatchWorkItem(block: action)
        enqueue(now + .seconds(schedule.intervalSeconds), work)
        return work
    }
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
            return TiboTattleLocalization.string(.settingsCheckForUpdates)
                + "…"
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

private struct DashboardContributionDiagnostics {
    let journeyPhase: String
    let previewState: String
    let consentApproved: Bool
    let consentCurrent: Bool
    let signedInObserved: Bool
    let signedIn: Bool
    let pairingObserved: Bool
    let paired: Bool

    private static let phases: Set<String> = [
        "not_configured", "unavailable", "sign_in_required",
        "preparing_review", "review_ready", "connecting",
        "approved_connection_needed", "approved_paused",
        "approved_syncing", "approved_idle",
    ]
    private static let previewStates: Set<String> = [
        "not_observed", "unavailable", "empty", "ready", "retry_wait",
        "paused",
    ]

    private static func exactBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else {
            return nil
        }
        return number.boolValue
    }

    private static func hasExactKeys(
        _ value: [String: Any],
        _ keys: Set<String>
    ) -> Bool {
        Set(value.keys) == keys
    }

    static func decode(_ value: Any?) -> DashboardContributionDiagnostics? {
        guard let root = value as? [String: Any],
              hasExactKeys(root, [
                "journeyPhase", "previewState", "consent", "signedIn",
                "pairing",
              ]),
              let journeyPhase = root["journeyPhase"] as? String,
              phases.contains(journeyPhase),
              let previewState = root["previewState"] as? String,
              previewStates.contains(previewState),
              let consent = root["consent"] as? [String: Any],
              hasExactKeys(consent, ["approved", "current"]),
              let consentApproved = exactBoolean(consent["approved"]),
              let consentCurrent = exactBoolean(consent["current"]),
              let signedInValue = root["signedIn"] as? [String: Any],
              hasExactKeys(signedInValue, ["observed", "value"]),
              let signedInObserved = exactBoolean(signedInValue["observed"]),
              let signedIn = exactBoolean(signedInValue["value"]),
              let pairing = root["pairing"] as? [String: Any],
              hasExactKeys(pairing, ["observed", "paired"]),
              let pairingObserved = exactBoolean(pairing["observed"]),
              let paired = exactBoolean(pairing["paired"])
        else {
            return nil
        }
        return DashboardContributionDiagnostics(
            journeyPhase: journeyPhase,
            previewState: previewState,
            consentApproved: consentApproved,
            consentCurrent: consentCurrent,
            signedInObserved: signedInObserved,
            signedIn: signedIn,
            pairingObserved: pairingObserved,
            paired: paired
        )
    }
}

private struct ContributionDiagnosticsSnapshot {
    let journeyPhase: String
    let previewState: String
    let queueState: String
    let consentApproved: Bool
    let consentCurrent: Bool
    let signedInObserved: Bool
    let signedIn: Bool
    let pairingObserved: Bool
    let paired: Bool
    let references: [LocalContributionDiagnosticReference]

    static func merge(
        local: LocalContributionDiagnostics?,
        dashboard: DashboardContributionDiagnostics?
    ) -> ContributionDiagnosticsSnapshot {
        ContributionDiagnosticsSnapshot(
            journeyPhase: dashboard?.journeyPhase
                ?? local?.journeyPhase
                ?? "unavailable",
            previewState: dashboard?.previewState
                ?? local?.previewState
                ?? "not_observed",
            queueState: local?.queueState ?? "unavailable",
            consentApproved: local?.consentApproved
                ?? dashboard?.consentApproved
                ?? false,
            consentCurrent: local?.consentCurrent
                ?? dashboard?.consentCurrent
                ?? false,
            signedInObserved: dashboard?.signedInObserved
                ?? local?.signedInObserved
                ?? false,
            signedIn: dashboard?.signedIn
                ?? local?.signedIn
                ?? false,
            pairingObserved: local?.pairingObserved
                ?? dashboard?.pairingObserved
                ?? false,
            paired: local?.pairingObserved == true
                ? local?.paired == true
                : dashboard?.paired ?? local?.paired ?? false,
            references: local?.recentDiagnosticReferences ?? []
        )
    }

    var lines: [String] {
        var output = [
            "contribution_diagnostics_schema: tibotattle-contribution-diagnostics-v1",
            "contribution_journey_phase: \(journeyPhase)",
            "contribution_preview_state: \(previewState)",
            "contribution_queue_state: \(queueState)",
            "contribution_consent_approved: \(consentApproved)",
            "contribution_consent_current: \(consentCurrent)",
            "contribution_signed_in_observed: \(signedInObserved)",
            "contribution_signed_in: \(signedIn)",
            "contribution_pairing_observed: \(pairingObserved)",
            "contribution_paired: \(paired)",
        ]
        for (index, reference) in references.prefix(5).enumerated() {
            output.append(
                "contribution_diagnostic_reference_\(index + 1): "
                    + "\(reference.reference) @ \(reference.recordedAt)"
            )
        }
        output.append(contentsOf: [
            "contribution_tokens_included: false",
            "contribution_oauth_state_included: false",
            "contribution_verifiers_included: false",
            "contribution_device_identifiers_included: false",
            "contribution_account_identifiers_included: false",
            "contribution_paths_included: false",
            "contribution_content_included: false",
        ])
        return output
    }
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
        loginItemLastOperation: LoginItemDiagnosticAction,
        contribution: ContributionDiagnosticsSnapshot
    ) -> String {
        ([
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
        ] + contribution.lines + [
            "paths_included: false",
            "identifiers_included: false",
            "content_included: false",
        ]).joined(separator: "\n")
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
    let nodeRuntimeMode: BundledNodeRuntimeMode
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
        guard let nodeRuntimeMode = BundledNodeRuntimeMode(
                  rawValue: BundledProduct.nodeRuntimeMode
              ),
              regularFile(node),
              regularFile(entrypoint),
              regularFile(keychainResetEntrypoint)
        else {
            throw LauncherError.invalidResource("runtime")
        }
        return CompanionResources(
            node: node,
            nodeRuntimeMode: nodeRuntimeMode,
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
    private var keychainBroker: ContributionDeviceKeychainBroker?
    private var stopCompletions: [() -> Void] = []
    private var stopped = false
    private let nodeRuntimeModeOverride: BundledNodeRuntimeMode?
    private let onExit: (Bool, Bool) -> Void
    private let onReady: (URL) -> Void

    init(
        centralService: CentralServiceConfiguration?,
        codexHome: URL,
        nodeRuntimeModeOverride: BundledNodeRuntimeMode? = nil,
        onReady: @escaping (URL) -> Void,
        onExit: @escaping (Bool, Bool) -> Void
    ) {
        self.centralService = centralService
        self.codexHome = codexHome
        self.nodeRuntimeModeOverride = nodeRuntimeModeOverride
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
        child.arguments = (
            nodeRuntimeModeOverride ?? resources.nodeRuntimeMode
        ).arguments(entrypoint: resources.entrypoint)
        child.currentDirectoryURL = resources.resourceRoot
        // The companion's standard input is the app's Keychain broker
        // channel: fresh contribution-device credentials are minted and read
        // by this signed app, never by the companion's own Keychain access,
        // which is what raised the first-pairing dialog. The environment
        // names only the descriptor — the socketpair itself is the
        // authority, so no token or secret crosses argv or the environment.
        // If the broker cannot be created (descriptor exhaustion), the
        // companion runs without one and its own explained pairing path
        // remains the net.
        let broker = try? ContributionDeviceKeychainBroker(
            nodeRuntimePath: resources.node.path
        )
        child.standardInput = broker?.childEndpoint ?? FileHandle.nullDevice
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
        if broker?.childEndpoint != nil {
            environment[
                ContributionDeviceKeychainBroker.environmentVariable
            ] = "0"
        }
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
        keychainBroker = broker
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
            keychainBroker = nil
            lock.unlock()
            broker?.shutdown()
            throw LauncherError.companionLaunch("run")
        }
        // The child holds its dup2'd copy; dropping ours is what turns a
        // companion exit into end-of-file on the broker channel.
        broker?.closeChildEndpoint()
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
        let broker = keychainBroker
        keychainBroker = nil
        let completions = stopCompletions
        stopCompletions.removeAll()
        let wasStopped = stopped
        let anotherInstanceIsActive = activeInstanceDetected
        lock.unlock()
        broker?.shutdown()
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
    /// The in-flight download's chosen destination, promoted to
    /// `latestCompletedDownload` only when WebKit reports it finished.
    private var pendingDownloadDestination: URL?
    private var latestCompletedDownload: URL?
    private var viewportPreparationAttempts = 0
    /// False while the view holds no dashboard, so the blank page loaded on
    /// teardown can never be reported as a dashboard that opened.
    private var hasDashboardTarget = false
    /// True while the embedded page reports a hosted sign-in is in flight
    /// (the browser is open and a completed proof may still be collected). The
    /// shell refuses to tear the web view down in this window, because doing so
    /// wipes the live page AND the pending handoff mid-flight — the sign-in the
    /// service may still hold would be silently discarded (owner-reported,
    /// 2026-08-10). The page sets it true the moment it opens the browser and
    /// false as soon as the sign-in settles, cancels, or times out.
    private(set) var hostedSignInInFlight = false
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
        // Persistent by owner decision (sign-in-once durability, part 3): a
        // still-valid 30-minute web session and an in-flight sign-in handoff
        // now survive an app relaunch, so quitting mid-flow resumes instead of
        // restarting from zero. The earlier non-persistent store kept loopback
        // cookies and local storage off disk for privacy; the owner accepted
        // that trade-off because the durable upload authority is the 30-day
        // Keychain device credential regardless — the web session it persists
        // is short-lived and only ever mints that credential, never uploads.
        configuration.websiteDataStore = .default()
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
        configuration.userContentController.add(
            self,
            name: "tibotattleDownloads"
        )
        configuration.userContentController.add(
            self,
            name: "tibotattleHostedSignIn"
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
        // The page this flag described is being discarded, so the flag it set
        // no longer applies. (hideDashboardWebView refuses to reach stop() while
        // a sign-in is in flight; this clears any residue on the paths that do.)
        hostedSignInInFlight = false
        pendingDashboardURL = nil
        viewportPreparationAttempts = 0
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    /// Completes the native "all local data" reset by removing this app's
    /// persistent WebKit state. The embedded view only admits the loopback
    /// companion; provider pages always open in the system browser, so this
    /// store contains only TiboTattle cookies and caches rather than
    /// browser-wide data. The bounded OAuth recovery handle lives under the
    /// owner-only app state root and is removed when that root is trashed.
    static func clearPersistentWebsiteData(
        completion: @escaping () -> Void
    ) {
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) {
            DispatchQueue.main.async(execute: completion)
        }
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

    /// A finished refresh has replaced the companion's snapshot, so the numbers
    /// this document is showing are the ones from before it ran.
    ///
    /// The page's own return-visit refresh stands down inside this window
    /// because the shell owns the foreground cadence. Owning that cadence has
    /// to include saying when it produced something new: without this the
    /// toolbar reports the refresh finished while the dashboard underneath
    /// still renders the pre-refresh snapshot. Signalled rather than reloaded,
    /// for the same reason as the hosted sign-in return above - a reload would
    /// discard the document's in-memory state.
    func notifyLocalEvidenceUpdated() {
        guard hasDashboardTarget else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new Event('tibotattle:local-evidence-updated'));"
        )
    }

    /// Reads only the dashboard's fixed-vocabulary contribution support
    /// snapshot. The JavaScript function itself is allowlisted in app.js and
    /// this decoder independently rejects every non-boolean or open-text
    /// value, so no OAuth material, identifier, path, or content can enter the
    /// native diagnostics receipt through this bridge.
    func readContributionDiagnostics(
        completion: @escaping (DashboardContributionDiagnostics?) -> Void
    ) {
        guard hasDashboardTarget else {
            completion(nil)
            return
        }
        webView.evaluateJavaScript("""
        (() => {
          const read = window.__tibotattleContributionDiagnostics;
          return typeof read === 'function' ? read() : null;
        })();
        """) { value, error in
            let diagnostics = error == nil
                ? DashboardContributionDiagnostics.decode(value)
                : nil
            DispatchQueue.main.async { completion(diagnostics) }
        }
    }

    /// Change the copy in the existing loopback document without reloading it.
    /// In particular, this must not disturb an active hosted-sign-in attempt;
    /// its restart recovery handle is stored separately by the companion.
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
        // The embedded report redraws its generated controls from the same
        // locale-change event. A deferred resize lets charts, popovers, and
        // other width-sensitive controls measure their translated labels
        // after that redraw has committed, without reloading the document or
        // interrupting the active hosted-sign-in attempt.
        window.requestAnimationFrame?.(() => {
          window.dispatchEvent(new Event('resize'));
        });
        """)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.frameInfo.isMainFrame,
              let payload = message.body as? [String: Any]
        else {
            return
        }
        if message.name == "tibotattleDownloads" {
            // The page asks; the shell acts. The path never crosses the
            // bridge in either direction.
            if payload["type"] as? String == "reveal-latest-download" {
                revealLatestDownload()
            }
            return
        }
        if message.name == "tibotattleHostedSignIn" {
            // A single boolean, nothing else: whether a hosted sign-in is in
            // flight. It carries no proof, provider, or account value — only
            // the fact that tearing the web view down now would discard a
            // sign-in still being collected.
            if let inFlight = payload["inFlight"] as? Bool {
                hostedSignInInFlight = inFlight
            }
            return
        }
        guard message.name == "tibotattleLocalization",
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

    /// How long the document is given to render something before the view is
    /// declared unavailable, and how often it is asked.
    ///
    /// `didFinish` only reports that the *document* finished loading. This
    /// dashboard then fetches its evidence from the loopback companion and
    /// renders afterwards, so `#main` is legitimately near-empty at that
    /// instant. Sampling it once there judged an asynchronous condition at a
    /// single moment and reported a perfectly working view as broken - which
    /// is why a right-click Reload failed with
    /// `UM_MACOS_DASHBOARD_VIEW_UNAVAILABLE` while retrying moments later
    /// succeeded. The deadline still fails closed: a document that never
    /// renders is still reported, just not one that is merely slower than a
    /// single turn of the run loop.
    private static let dashboardContentDeadline: TimeInterval = 20
    private static let dashboardContentPollInterval: TimeInterval = 0.25

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard hasDashboardTarget else { return }
        // A freshly loaded document has no sign-in in flight until it says so,
        // so a stale flag from a prior page never blocks teardown after a
        // reload.
        hostedSignInInFlight = false
        // The local page keeps its public-web navigation when opened in a
        // browser. In the app, AppKit owns navigation and status so the
        // document can concentrate on the current page. This is presentation
        // only, so it is applied immediately rather than being gated on the
        // content check below.
        webView.evaluateJavaScript(
            "document.body && document.body.classList.add('native-dashboard');"
        )
        awaitDashboardContent(
            in: webView,
            deadline: Date().addingTimeInterval(Self.dashboardContentDeadline)
        )
    }

    private func awaitDashboardContent(in webView: WKWebView, deadline: Date) {
        guard hasDashboardTarget else { return }
        webView.evaluateJavaScript(
            "document.documentElement?.dataset.localDashboardReady === 'true';"
        ) { [weak self] value, error in
            guard let self, self.hasDashboardTarget else { return }
            let localDashboardReady = (value as? NSNumber)?.boolValue ?? false
            if error == nil, localDashboardReady {
                self.onLoaded()
                return
            }
            guard Date() < deadline else {
                self.hasDashboardTarget = false
                self.onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
                return
            }
            DispatchQueue.main.asyncAfter(
                deadline: .now() + Self.dashboardContentPollInterval
            ) { [weak self] in
                self?.awaitDashboardContent(in: webView, deadline: deadline)
            }
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
        let destination = Self.downloadsDestination(for: suggestedFilename)
        pendingDownloadDestination = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        // Only a completed download may ever be revealed. The destination is
        // promoted here, not at decide time, so the page's "Show in Finder"
        // can never point at a partial file.
        latestCompletedDownload = pendingDownloadDestination
        pendingDownloadDestination = nil
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloadDestination = nil
        // A file that could not be saved is not a dashboard that failed, so
        // the open page is left exactly as it is.
        onDownloadFailure()
    }

    /// Reveal the last finished download, or fall back to opening the
    /// Downloads folder when none finished yet - the honest nearest thing,
    /// never an error for a file that is still being written.
    func revealLatestDownload() {
        if let url = latestCompletedDownload,
           FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            return
        }
        if let downloads = try? FileManager.default.url(
            for: .downloadsDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        ) {
            NSWorkspace.shared.open(downloads)
        }
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
        }
    }

    var symbolName: String {
        switch self {
        case .overview: return "rectangle.grid.1x2"
        case .weekly: return "chart.bar.xaxis"
        case .trends: return "chart.xyaxis.line"
        case .method: return "function"
        case .community: return "person.3"
        }
    }
}

/// `NSSplitView` owns the frame of each pane — now by way of the
/// `NSSplitViewController` that vends it.  A WKWebView is not a reliable pane
/// root itself: on a live first launch, Auto Layout can retain the zero frame
/// it had before the split view received a window.  This pane makes the
/// ownership explicit and gives WebKit its final frame during every AppKit
/// layout pass.
///
/// `NSSplitViewController` positions the pane, and the pane positions WebKit.
/// That is the same one-way relationship the hand-rolled `NSSplitView` had, and
/// it is still the reason WebKit is not laid out by Auto Layout: the frame is
/// assigned synchronously in `layout()` rather than left to a constraint pass
/// that has, twice, resolved to zero before the window existed.
@MainActor
private final class NativeDashboardReportPane: NSView {
    /// `--paper` from the dashboard stylesheet. The report document has no
    /// dark variant, so a fixed value is the honest match. Painting it here
    /// means no system grey is ever visible in the strip the title bar
    /// reserves, or in the instant before WebKit has drawn.
    private static let paper = NSColor(
        srgbRed: 0xF5 / 255,
        green: 0xF1 / 255,
        blue: 0xE8 / 255,
        alpha: 1
    )

    private let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Self.paper.cgColor
        webView.translatesAutoresizingMaskIntoConstraints = true
        // Deliberately no autoresizing mask.  The pane now insets WebKit by
        // its own safe area, and a mask would spring the view back to the full
        // bounds on every resize until the next layout pass caught up.
        webView.autoresizingMask = []
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

    /// The frame WebKit is currently displaying at, expressed in `reference`'s
    /// coordinates. The chrome smoke mode reads the real frame here rather
    /// than trusting the pane to describe itself.
    func webViewFrame(in reference: NSView) -> NSRect {
        reference.convert(webView.bounds, from: webView)
    }

    @discardableResult
    func fitWebViewToBounds() -> Bool {
        // This pane runs the full height of the window so the sidebar beside
        // it can carry its vibrancy up behind the title bar. The report is a
        // fixed document rather than a scroll view that tucks under a toolbar,
        // so WebKit is inset by the safe area the system reserves instead of
        // having its first screenful hidden by it.
        let inset = safeAreaInsets
        var frame = bounds
        frame.origin.x += inset.left
        frame.origin.y += inset.bottom
        frame.size.width -= inset.left + inset.right
        frame.size.height -= inset.top + inset.bottom
        frame = frame.integral
        guard frame.width > 0, frame.height > 0 else { return false }
        webView.frame = frame
        webView.setNeedsDisplay(frame)
        return true
    }
}

/// The window the app really opens, held open for measurement. `owner` keeps
/// the delegate that built the window alive for as long as the probe is.
@MainActor
private struct NativeDashboardChromeProbe {
    let owner: AnyObject
    let window: NSWindow
    let container: NSView
    let launcherColumn: NSView
    let chrome: NativeDashboardChrome
}

/// Real frames read back from a laid-out dashboard window. Every field is a
/// measurement, not a value the chrome reports about itself, so the smoke mode
/// that consumes them cannot pass by asserting on its own intentions.
private struct NativeDashboardChromeMetrics {
    let chrome: NSRect
    let sidebarPane: NSRect
    /// Where the sidebar's own rows sit. The pane runs behind the title bar;
    /// the rows inside it must not.
    let sidebarRows: NSRect
    let reportPane: NSRect
    let reportSafeArea: NSEdgeInsets
    let webView: NSRect
    let dividerThickness: CGFloat
    let sidebarMaterial: NSVisualEffectView.Material
    let sidebarBlending: NSVisualEffectView.BlendingMode
    let sidebarState: NSVisualEffectView.State

    /// Horizontal distance between the sidebar's trailing edge and the
    /// report's leading edge. A native sidebar app has no gap here beyond the
    /// divider itself.
    var paneGap: CGFloat {
        abs(reportPane.minX - sidebarPane.maxX)
    }
}

/// The product's brand palette as native dynamic colors. Values mirror the
/// web report's tokens (`--paper: #f5f1e8` and `--green: #174f45` in
/// apps/web/public/styles.css) so the native chrome and the embedded report
/// read as one surface. The dark appearance keeps the same family: the
/// accent is lifted for contrast and the paper wash becomes a deep-green
/// cast rather than a glaring cream sheet.
private enum NativeBrandPalette {
    /// Web accent #174f45, lifted for dark backgrounds.
    static let accent = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(
                srgbRed: 122 / 255,
                green: 184 / 255,
                blue: 170 / 255,
                alpha: 1
            )
            : NSColor(
                srgbRed: 23 / 255,
                green: 79 / 255,
                blue: 69 / 255,
                alpha: 1
            )
    }

    /// Web background #f5f1e8, washed over the system sidebar material so
    /// vibrancy still reads through it.
    static let sidebarWash = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(
                srgbRed: 23 / 255,
                green: 79 / 255,
                blue: 69 / 255,
                alpha: 0.22
            )
            : NSColor(
                srgbRed: 245 / 255,
                green: 241 / 255,
                blue: 232 / 255,
                alpha: 0.55
            )
    }
}

/// Lays the brand's paper wash over the system sidebar material. A layer's
/// background color does not track appearance changes on its own, so the
/// wash re-resolves its dynamic color in `updateLayer`, which AppKit calls
/// with this view's effective appearance current.
private final class NativeSidebarBrandWash: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NativeBrandPalette.sidebarWash.cgColor
    }
}

/// Hosts the titlebar brand row and keeps it on the titlebar controls' own
/// axis. AppKit stretches a `.left` accessory to the full titlebar container
/// — measured 66pt tall on macOS 26 under the unified toolbar — while the
/// traffic lights and the toolbar's own controls centre on the 52pt toolbar
/// row at the top of that container, so centring the brand in the accessory's
/// own bounds sat it a visible 7pt low. The close button is public API
/// (`standardWindowButton(_:)`) and is the row every other titlebar control
/// aligns with, so layout measures its centre and matches it, falling back to
/// this view's own centre when the button is absent.
private final class NativeTitlebarBrandRow: NSView {
    private let content: NSView

    init(content: NSView) {
        self.content = content
        super.init(frame: NSRect(origin: .zero, size: content.fittingSize))
        addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let size = content.fittingSize
        var centerY = bounds.midY
        if let anchor = window?.standardWindowButton(.closeButton),
           let anchorSuperview = anchor.superview {
            let anchorInWindow = anchorSuperview.convert(
                anchor.frame,
                to: nil
            )
            centerY = convert(anchorInWindow, from: nil).midY
        }
        content.frame = NSRect(
            x: 0,
            y: (centerY - size.height / 2).rounded(),
            width: size.width,
            height: size.height
        )
    }
}

/// One toolbar status-pill colorway: the title-and-glyph tint plus the pill
/// fill. Values mirror the web report's state-pill tokens in
/// apps/web/public/styles.css — `.state-live` (--green #174f45 on
/// --green-soft #dfece6), `.state-updating` (--amber #815718 on --amber-soft
/// #f4ead7), and `.state-offline` (--rust #97402a on --rust-soft #f4e4de) —
/// so the native pill and the web pill read as the same control. The dark
/// appearance lifts each text tone the way NativeBrandPalette lifts the
/// accent, and thins the fill to a wash so the pill stays legible on the
/// dark unified toolbar.
private struct NativeToolbarStatusColor {
    let text: NSColor
    let background: NSColor

    /// Fresh, live evidence. Web `.state-live`.
    static let fresh = NativeToolbarStatusColor(
        text: stateColor(
            light: (red: 23, green: 79, blue: 69, alpha: 1),
            dark: (red: 122, green: 184, blue: 170, alpha: 1)
        ),
        background: stateColor(
            light: (red: 223, green: 236, blue: 230, alpha: 1),
            dark: (red: 122, green: 184, blue: 170, alpha: 0.16)
        )
    )

    /// A running refresh or a history index still building. Web
    /// `.state-updating`.
    static let busy = NativeToolbarStatusColor(
        text: stateColor(
            light: (red: 129, green: 87, blue: 24, alpha: 1),
            dark: (red: 214, green: 166, blue: 92, alpha: 1)
        ),
        background: stateColor(
            light: (red: 244, green: 234, blue: 215, alpha: 1),
            dark: (red: 214, green: 166, blue: 92, alpha: 0.16)
        )
    )

    /// The companion reported the last refresh failed. Web `.state-offline`.
    static let failed = NativeToolbarStatusColor(
        text: stateColor(
            light: (red: 151, green: 64, blue: 42, alpha: 1),
            dark: (red: 224, green: 138, blue: 109, alpha: 1)
        ),
        background: stateColor(
            light: (red: 244, green: 228, blue: 222, alpha: 1),
            dark: (red: 224, green: 138, blue: 109, alpha: 0.18)
        )
    )

    /// Evidence that is stale, unread, or not yet known: the system's own
    /// secondary tone on a bare fill, claiming nothing.
    static let idle = NativeToolbarStatusColor(
        text: .secondaryLabelColor,
        background: stateColor(
            light: (red: 0, green: 0, blue: 0, alpha: 0.05),
            dark: (red: 255, green: 255, blue: 255, alpha: 0.08)
        )
    )

    private static func stateColor(
        light: (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat),
        dark: (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat)
    ) -> NSColor {
        NSColor(name: nil) { appearance in
            let tone = appearance.bestMatch(
                from: [.darkAqua, .aqua]
            ) == .darkAqua ? dark : light
            return NSColor(
                srgbRed: tone.red / 255,
                green: tone.green / 255,
                blue: tone.blue / 255,
                alpha: tone.alpha
            )
        }
    }
}

/// The toolbar status control's pill dressing. An `NSButton` bezel refuses
/// `contentTintColor` for its title — measured, the textured bezel rendered
/// the state words in plain label black — so the title button rides
/// borderless inside this view, which owns the rounded state-colored fill
/// and hairline. The fill re-resolves its dynamic colors in `updateLayer`,
/// which AppKit calls with this view's effective appearance current — the
/// same appearance seam NativeSidebarBrandWash uses.
///
/// The pill is itself an inert borderless `NSButton`, not a plain `NSView`,
/// and that choice is load-bearing on macOS 26: the toolbar wraps a
/// custom-view item in its own Liquid Glass capsule — measured, an
/// `NSToolbarPlatterView` hosting an `NSGlassEffectView`, a frosted platter
/// 11pt taller than the pill that reads as the white halo the owner
/// reported. The item viewer only asks AppKit's own buttons whether they
/// want glass — a plain `NSView` is misted over regardless, even when it
/// implements the private preference selector — and a borderless button is
/// the one shape that declines the platter through public API alone. The
/// button is pure dressing: empty title, no action, refusing key focus,
/// invisible to accessibility. The inner title button stays the real
/// control.
private final class NativeToolbarStatusPill: NSButton {
    var colorway: NativeToolbarStatusColor = .idle {
        didSet { needsDisplay = true }
    }

    init() {
        super.init(frame: .zero)
        title = ""
        isBordered = false
        refusesFirstResponder = true
        setAccessibilityElement(false)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        guard let layer else { return }
        layer.backgroundColor = colorway.background.cgColor
        layer.borderColor = colorway.text.cgColor.copy(alpha: 0.22)
        layer.borderWidth = 1
        layer.cornerRadius = bounds.height / 2
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }
}

/// The native frame for the loopback dashboard. WebKit remains responsible for
/// the rich charts and accessible, selectable report content. AppKit owns the
/// sidebar here, while the window's unified toolbar owns status, refresh,
/// sharing, and settings. Keeping that chrome outside WebKit preserves normal
/// Mac behavior without replacing the report itself.
///
/// This is an `NSSplitViewController` with a real
/// `NSSplitViewItem(sidebarWithViewController:)` rather than a hand-arranged
/// `NSSplitView`. The sidebar item is what gives the window full-height sidebar
/// vibrancy behind the title bar, the system's inset and rounded sidebar
/// content, enforced minimum and maximum sidebar widths, and the standard
/// collapse behaviour. The previous code re-implemented the first of those,
/// approximated the third, and had neither of the other two: measured in a real
/// 1180x892 window, its sidebar spanned only 844pt and stopped 24pt below the
/// title bar, which is the hard horizontal seam across the top of the window
/// the owner reported.
@MainActor
private final class NativeDashboardChrome: NSSplitViewController {
    /// How the sidebar blends. `.behindWindow` samples the desktop, which is
    /// the native sidebar look; `.withinWindow` renders an opaque strip that
    /// blends with this window's own content. Owner-selected treatment lives
    /// here alone so it can be reversed without touching layout.
    private static let sidebarBlendingMode: NSVisualEffectView.BlendingMode = .behindWindow
    /// The divider is a real control, not an affordance: the split enforces
    /// these bounds while the user drags it, and the chosen width survives
    /// relaunch through the split view's own autosave. A first launch, with
    /// nothing to restore, opens at the resting width the sidebar was always
    /// meant to open at. Internal, not private, so the layout smoke asserts
    /// against the same numbers the chrome enforces.
    static let sidebarMinimumThickness: CGFloat = 180
    static let sidebarMaximumThickness: CGFloat = 320
    static let sidebarRestingThickness: CGFloat = 216
    private static let reportMinimumThickness: CGFloat = 420
    /// AppKit applies a divider drag at `dragThatCannotResizeWindow` (490).
    /// The previous `.defaultHigh` (750) holding priority outranked the drag
    /// itself, which is why the seam showed a resize cursor but refused to
    /// move — a divider that lies. 260 sits below the drag so the user wins,
    /// and above the report item's default 250 so a window resize stretches
    /// the report rather than the sidebar.
    private static let sidebarHoldingPriority = NSLayoutConstraint.Priority(260)
    private static let splitAutosaveName = "com.usagemonitor.local.dashboard-split.v1"
    /// One-time marker that the resting width has been seeded. After this,
    /// the autosaved divider position is the user's own and is never fought.
    private static let splitSeededDefaultsKey =
        "tibotattle.dashboard-split-seeded.v1"

    private let sidebar = NSVisualEffectView()
    private let sidebarWash = NativeSidebarBrandWash()
    private let pageStack = NSStackView()
    private let reportPane: NativeDashboardReportPane
    private var pageButtons: [NativeDashboardDestination: NSButton] = [:]
    private var restingWidthSeeded = false

    var onNavigate: ((NativeDashboardDestination) -> Void)?

    init(webView: WKWebView) {
        reportPane = NativeDashboardReportPane(webView: webView)
        super.init(nibName: nil, bundle: nil)

        sidebar.material = .sidebar
        // `.sidebar` material has nothing to sample when it blends with the
        // window, because the report pane beside it is an opaque cream web
        // view; the result reads as flat grey against a warm canvas. Sampling
        // the desktop is what Finder and Mail do, and it is the whole reason
        // the material exists. Flip this one constant to `.withinWindow` for an
        // opaque sidebar instead — nothing else depends on the choice.
        sidebar.blendingMode = Self.sidebarBlendingMode
        // A sidebar that stays fully vibrant while its window is in the
        // background is a tell that the surface is not really native; the
        // system desaturates it with the rest of the window.
        sidebar.state = .followsWindowActiveState

        // The brand wash sits between the material and the rows: the report
        // beside this pane renders on the web palette's warm paper, and an
        // untinted grey strip against it looks like someone else's app.
        sidebarWash.wantsLayer = true
        sidebarWash.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(sidebarWash)

        pageStack.orientation = .vertical
        // Rows fill the sidebar's width the way every native sidebar's do. The
        // previous fixed 192pt row width was wider than the 190pt sidebar it
        // sat in, so the two constraints fought on every layout pass.
        pageStack.alignment = .width
        pageStack.spacing = 3
        pageStack.edgeInsets = NSEdgeInsets(top: 10, left: 8, bottom: 18, right: 8)
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
            button.heightAnchor.constraint(equalToConstant: 30).isActive = true
            pageStack.addArrangedSubview(button)
            pageButtons[destination] = button
        }
        sidebar.addSubview(pageStack)

        let sidebarController = NSViewController()
        sidebarController.view = sidebar
        NSLayoutConstraint.activate([
            // The wash covers the whole material, title-bar run included.
            sidebarWash.leadingAnchor.constraint(
                equalTo: sidebar.leadingAnchor
            ),
            sidebarWash.trailingAnchor.constraint(
                equalTo: sidebar.trailingAnchor
            ),
            sidebarWash.topAnchor.constraint(equalTo: sidebar.topAnchor),
            sidebarWash.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            pageStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            pageStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            // The sidebar itself runs behind the title bar; its rows must not.
            // The system publishes exactly how much room the title bar wants
            // as this view's safe area, so the rows follow that rather than a
            // guessed constant that would break in full screen.
            pageStack.topAnchor.constraint(
                equalTo: sidebar.safeAreaLayoutGuide.topAnchor
            ),
        ])

        let sidebarItem = NSSplitViewItem(
            sidebarWithViewController: sidebarController
        )
        sidebarItem.minimumThickness = Self.sidebarMinimumThickness
        sidebarItem.maximumThickness = Self.sidebarMaximumThickness
        sidebarItem.canCollapse = true
        // Low enough that the user's own divider drag wins; see the note on
        // `sidebarHoldingPriority`.
        sidebarItem.holdingPriority = Self.sidebarHoldingPriority
        addSplitViewItem(sidebarItem)

        // Keep WebKit inside a pane whose frame the split view controller owns.
        // This is intentionally not an Auto Layout relationship for the web
        // view: the pane mirrors its own resolved frame to WebKit
        // synchronously in `layout()`.
        let reportController = NSViewController()
        reportController.view = reportPane
        let reportItem = NSSplitViewItem(viewController: reportController)
        reportItem.minimumThickness = Self.reportMinimumThickness
        reportItem.canCollapse = false
        addSplitViewItem(reportItem)

        splitView.isVertical = true
        splitView.dividerStyle = .thin
        // The split view's own autosave carries the dragged width across
        // launches; nothing else records or replays divider geometry.
        splitView.autosaveName = Self.splitAutosaveName
        select(.overview)
    }

    required init?(coder: NSCoder) {
        nil
    }

    /// The very first launch has no autosaved divider to restore, and plain
    /// constraint solving would rest the sidebar at its 180pt minimum. Seed
    /// the designed 216pt opening width exactly once; every later launch
    /// restores whatever width the user actually chose.
    override func viewDidAppear() {
        super.viewDidAppear()
        guard !restingWidthSeeded else { return }
        restingWidthSeeded = true
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.splitSeededDefaultsKey) else {
            return
        }
        defaults.set(true, forKey: Self.splitSeededDefaultsKey)
        view.layoutSubtreeIfNeeded()
        splitView.setPosition(Self.sidebarRestingThickness, ofDividerAt: 0)
    }

    func select(_ destination: NativeDashboardDestination) {
        for (candidate, button) in pageButtons {
            let selected = candidate == destination
            button.state = selected ? .on : .off
            // The selected row carries the product's deep-green accent, the
            // same accent the web report uses, instead of the user's system
            // accent color.
            button.contentTintColor = selected
                ? NativeBrandPalette.accent
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
        view.window?.contentView?.layoutSubtreeIfNeeded()
        view.layoutSubtreeIfNeeded()
        reportPane.layoutSubtreeIfNeeded()
        return reportPane.fitWebViewToBounds()
    }

    /// Walks up from `view` to the subview the split view itself positions.
    /// A pane's own root can be inset inside that subview by the system, so a
    /// measurement of "where the split put this pane" has to be taken here and
    /// not on whichever child happens to be convenient.
    private static func arrangedPane(
        for view: NSView,
        in splitView: NSSplitView
    ) -> NSView {
        var candidate = view
        while let parent = candidate.superview, parent !== splitView {
            candidate = parent
        }
        return candidate
    }

    /// Reads the laid-out chrome back in `reference`'s coordinates.
    func measure(in reference: NSView) -> NativeDashboardChromeMetrics {
        let sidebarPane = Self.arrangedPane(for: sidebar, in: splitView)
        let reportArranged = Self.arrangedPane(for: reportPane, in: splitView)
        return NativeDashboardChromeMetrics(
            chrome: reference.convert(splitView.bounds, from: splitView),
            sidebarPane: reference.convert(
                sidebarPane.bounds,
                from: sidebarPane
            ),
            sidebarRows: reference.convert(pageStack.bounds, from: pageStack),
            reportPane: reference.convert(
                reportArranged.bounds,
                from: reportArranged
            ),
            reportSafeArea: reportPane.safeAreaInsets,
            webView: reportPane.webViewFrame(in: reference),
            dividerThickness: splitView.dividerThickness,
            sidebarMaterial: sidebar.material,
            sidebarBlending: sidebar.blendingMode,
            sidebarState: sidebar.state
        )
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
    /// One supervised recovery is allowed per app session. This catches a
    /// transient child-process exit without turning the foreground companion
    /// into an unbounded restart loop. A deliberate Retry starts a new budget.
    private var automaticCompanionRecoveryUsed = false
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
    private weak var settingsQuotaNotificationStatusLabel: NSTextField?
    private weak var settingsRefreshIntervalPicker: NSPopUpButton?
    private let nativeEvidenceReader = LocalCompanionEvidenceReader()
    private var quotaNotificationCoordinator: QuotaNotificationCoordinator?
    private var nativeDashboardChrome: NativeDashboardChrome?
    private var dashboardContentController: NSViewController?
    private weak var launcherColumn: NSStackView?
    private weak var nativeStatusRefreshButton: NSButton?
    private weak var nativeStatusPill: NativeToolbarStatusPill?
    private weak var nativeStatusToolbarItem: NSToolbarItem?
    private weak var nativeShareToolbarItem: NSToolbarItem?
    private weak var nativeSettingsToolbarItem: NSToolbarItem?
    private var nativeRefreshPoll: DispatchWorkItem?
    private var nativeRefreshSchedule: DispatchWorkItem?
    private var nativeRefreshInFlight = false
    /// One launch-only refresh waits until the page has rendered its first
    /// local result. This prevents the heavy collector from winning the
    /// loopback race against the dashboard's own initial reads.
    private var startupAutomaticRefreshPending = false
    private var nativeEvidenceState: NativeDashboardEvidenceState = .unknown
    private var nativeEvidenceObservedAt: Date?
    /// The companion's own history-index coverage and terminal refresh
    /// receipt. Both are observations, never inferences: each is replaced
    /// only by a successful loopback re-read of the companion's payloads.
    private var nativeHistoryIndexingCoverage: NativeHistoryIndexingCoverage?
    private var nativeRefreshFailure: NativeRefreshFailure?
    private var nativeIndexingCoveragePoll: DispatchWorkItem?
    /// Opaque companion token for the particular refresh this surface started
    /// or joined. It is never persisted or exposed in UI/notification text.
    private var nativeRefreshID: String?
    static let toolbarStatusRefreshIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-status-refresh"
    )
    static let toolbarShareIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-share"
    )
    static let toolbarSettingsIdentifier = NSToolbarItem.Identifier(
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

        Local allowance notifications are also off by default. If you later enable them in Settings, threshold and reset alerts stay on this Mac and evaluate only fresh provider-reported quota observations from the existing foreground refresh. A reset alert uses the provider-reported reset time and fires once when the next refresh arrives at or after it; an observed reset identity strengthens dedupe when available. They do not add a timer, daemon, login item, or background network polling.

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
        nativeEvidenceState = .unknown
        nativeEvidenceObservedAt = nil
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

        // The launcher surface is an ordinary padded column. It is the only
        // part of this window that still wants a margin: the dashboard below
        // is a sidebar app and owns the window edge to edge.
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
        // The dashboard used to be this column's middle row, and it was that
        // row's low vertical hugging that pushed the recovery controls to the
        // bottom of the window. The dashboard is no longer inside the column,
        // so the spacer takes over that one job.
        let launcherSpacer = NSView()
        launcherSpacer.translatesAutoresizingMaskIntoConstraints = false
        launcherSpacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        launcherSpacer.setContentCompressionResistancePriority(
            .defaultLow,
            for: .vertical
        )
        layout.addArrangedSubview(launcherSpacer)
        layout.addArrangedSubview(actionRow)

        launcherColumn = layout
        let content = NSView()
        content.addSubview(layout)
        content.addSubview(dashboardContainer)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            // The window carries `.fullSizeContentView`, so the launcher
            // column starts below whatever the title bar reserves rather than
            // sliding underneath the toolbar.
            layout.topAnchor.constraint(
                equalTo: content.safeAreaLayoutGuide.topAnchor
            ),
            layout.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusStack.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            actionRow.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            launcherSpacer.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            // The dashboard is the window. Anything less and the sidebar
            // cannot reach the title bar or the window's rounded corners, and
            // the report floats in a margin.
            dashboardContainer.leadingAnchor.constraint(
                equalTo: content.leadingAnchor
            ),
            dashboardContainer.trailingAnchor.constraint(
                equalTo: content.trailingAnchor
            ),
            dashboardContainer.topAnchor.constraint(
                equalTo: content.topAnchor
            ),
            dashboardContainer.bottomAnchor.constraint(
                equalTo: content.bottomAnchor
            ),
        ])

        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 860),
            styleMask: Self.dashboardWindowStyleMask,
            backing: .buffered,
            defer: false
        )
        newWindow.title = BundledProduct.displayName
        // The plain text title yields to a small native brand row — the
        // bundle's own app icon beside the wordmark in the brand's deep
        // green — mirroring the web report's brand row. The window keeps its
        // title for Mission Control, the window menu, and accessibility;
        // only the titlebar's text drawing is replaced.
        newWindow.titleVisibility = .hidden
        newWindow.addTitlebarAccessoryViewController(
            Self.makeTitlebarBrandAccessory()
        )
        newWindow.toolbar = makeDashboardToolbar()
        newWindow.toolbarStyle = .unified
        // A content *view controller* so the split view controller has a
        // parent to be a child of. `NSSplitViewController` only gets the
        // system's sidebar treatment when it is inside a view-controller
        // hierarchy; measured, an embedded child controller is treated exactly
        // like a window's own content controller.
        let contentController = NSViewController()
        contentController.view = content
        newWindow.contentViewController = contentController
        dashboardContentController = contentController
        newWindow.setContentSize(NSSize(width: 1_180, height: 860))
        newWindow.contentMinSize = NSSize(width: 900, height: 420)
        newWindow.isReleasedWhenClosed = false
        newWindow.delegate = self
        newWindow.center()
        newWindow.makeKeyAndOrderFront(nil)
        window = newWindow
        NSApp.activate(ignoringOtherApps: true)
    }

    /// `.fullSizeContentView` is the setting that lets the sidebar split item
    /// carry its material up behind the title bar. Measured on macOS 26:
    /// without it the split view stops at `contentLayoutRect`, the system
    /// draws no per-pane title bar background, and the panes report a zero
    /// safe-area inset — that is, the sidebar is cut off at the top exactly as
    /// reported. With it the sidebar's pane spans the full window height and
    /// the report pane is handed a 66pt title bar inset to respect.
    private static let dashboardWindowStyleMask: NSWindow.StyleMask = [
        .titled,
        .closable,
        .miniaturizable,
        .resizable,
        .fullSizeContentView,
    ]

    /// The titlebar's brand row: the bundle's own app icon at title-bar
    /// scale beside the product wordmark in the brand's deep green — the
    /// native sibling of the web report's brand row. A titlebar accessory
    /// keeps this modest: no web view, no new image asset, no custom window
    /// drawing, and the icon is the exact icon macOS already shows for this
    /// app.
    private static func makeTitlebarBrandAccessory()
        -> NSTitlebarAccessoryViewController {
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 18),
            icon.heightAnchor.constraint(equalToConstant: 18),
        ])
        let wordmark = NSTextField(
            labelWithString: BundledProduct.displayName
        )
        wordmark.font = .systemFont(ofSize: 13, weight: .semibold)
        wordmark.textColor = NativeBrandPalette.accent
        let row = NSStackView(views: [icon, wordmark])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 6)
        // Titlebar accessories are sized from the view's frame, not from a
        // constraint relationship with the titlebar. AppKit then stretches a
        // left accessory to the full titlebar container height — taller than
        // the toolbar row the traffic lights centre on — so the stack rides
        // inside NativeTitlebarBrandRow, which re-centres it on the
        // traffic-light axis instead of the container's own midline.
        row.layoutSubtreeIfNeeded()
        row.frame = NSRect(origin: .zero, size: row.fittingSize)
        let accessory = NSTitlebarAccessoryViewController()
        accessory.view = NativeTitlebarBrandRow(content: row)
        accessory.layoutAttribute = .left
        return accessory
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
            Self.toolbarStatusRefreshIdentifier,
            Self.toolbarShareIdentifier,
            Self.toolbarSettingsIdentifier,
        ]
    }

    func toolbarDefaultItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        [
            Self.toolbarStatusRefreshIdentifier,
            .flexibleSpace,
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
        case Self.toolbarStatusRefreshIdentifier:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = TiboTattleLocalization.string(
                .nativeDashboardRefreshUsage
            )
            item.toolTip = TiboTattleLocalization.string(
                .nativeDashboardCurrentEvidenceTooltip
            )
            let button = NSButton(
                title: nativeToolbarEvidenceTitle(
                    fallback: TiboTattleLocalization.string(
                        .launcherStartingLocally
                    )
                ),
                target: self,
                action: #selector(refreshDashboardFromToolbar)
            )
            // Borderless: a bezel draws its own background and refuses
            // contentTintColor for the title, which is exactly the
            // plain-black pill the owner reported. The state-colored fill
            // belongs to the NativeToolbarStatusPill the button rides in.
            button.isBordered = false
            button.imagePosition = .imageLeading
            button.alignment = .left
            button.font = .systemFont(ofSize: 12, weight: .medium)
            button.toolTip = nativeRefreshToolbarTooltip()
            button.setAccessibilityLabel(
                TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
            )
            button.setContentCompressionResistancePriority(
                .defaultLow,
                for: .horizontal
            )
            button.widthAnchor.constraint(
                greaterThanOrEqualToConstant: 190
            ).isActive = true
            button.widthAnchor.constraint(
                lessThanOrEqualToConstant: 320
            ).isActive = true
            let pill = NativeToolbarStatusPill()
            pill.translatesAutoresizingMaskIntoConstraints = false
            button.translatesAutoresizingMaskIntoConstraints = false
            pill.addSubview(button)
            NSLayoutConstraint.activate([
                button.leadingAnchor.constraint(
                    equalTo: pill.leadingAnchor,
                    constant: 12
                ),
                button.trailingAnchor.constraint(
                    equalTo: pill.trailingAnchor,
                    constant: -12
                ),
                button.topAnchor.constraint(
                    equalTo: pill.topAnchor,
                    constant: 5
                ),
                button.bottomAnchor.constraint(
                    equalTo: pill.bottomAnchor,
                    constant: -5
                ),
            ])
            item.view = pill
            nativeStatusRefreshButton = button
            nativeStatusPill = pill
            nativeStatusToolbarItem = item
            updateNativeToolbar(
                title: nativeToolbarEvidenceTitle(
                    fallback: TiboTattleLocalization.string(
                        .launcherStartingLocally
                    )
                ),
                isRefreshing: nativeRefreshInFlight,
                refreshEnabled: dashboardURL != nil
            )
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
            nativeSettingsToolbarItem = item
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
        let statusTitle = isRefreshing
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : nativeToolbarEvidenceTitle(fallback: title)
        nativeStatusRefreshButton?.title = statusTitle
        nativeStatusRefreshButton?.toolTip = isRefreshing
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : nativeRefreshToolbarTooltip()
        nativeStatusRefreshButton?.image = NSImage(
            systemSymbolName: isRefreshing
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: isRefreshing
                ? TiboTattleLocalization.string(.nativeDashboardUpdating)
                : TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
        )
        nativeStatusRefreshButton?.isEnabled = refreshEnabled && !isRefreshing
        nativeStatusRefreshButton?.setAccessibilityLabel(statusTitle)
        let colorway = nativeToolbarStatusColor(isRefreshing: isRefreshing)
        nativeStatusRefreshButton?.contentTintColor = colorway.text
        nativeStatusPill?.colorway = colorway
        nativeShareToolbarItem?.isEnabled = dashboardWebViewShowing
    }

    /// The pill's colorway follows nativeToolbarEvidenceTitle's own
    /// precedence — a running refresh, then a terminal failure, then an
    /// incomplete history index, and only then the evidence state — so the
    /// color never claims a state the words do not.
    private func nativeToolbarStatusColor(
        isRefreshing: Bool
    ) -> NativeToolbarStatusColor {
        if isRefreshing {
            return .busy
        }
        if nativeRefreshFailure != nil {
            return .failed
        }
        if let coverage = nativeHistoryIndexingCoverage,
           !coverage.isComplete {
            return .busy
        }
        switch nativeEvidenceState {
        case .live:
            return .fresh
        case .stale, .unknown, .readFailed, .lifecycleUnavailable:
            return .idle
        }
    }

    private func refreshNativeToolbarLocalization() {
        let statusTitle = nativeRefreshInFlight
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : nativeToolbarEvidenceTitle(
                fallback: TiboTattleLocalization.string(
                    .nativeDashboardStatus
                )
            )
        nativeStatusRefreshButton?.title = statusTitle
        nativeStatusRefreshButton?.toolTip = nativeRefreshInFlight
            ? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : nativeRefreshToolbarTooltip()
        nativeStatusRefreshButton?.image = NSImage(
            systemSymbolName: nativeRefreshInFlight
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: nativeRefreshInFlight
                ? TiboTattleLocalization.string(.nativeDashboardUpdating)
                : TiboTattleLocalization.string(
                    .nativeDashboardRefreshUsage
                )
        )
        nativeStatusRefreshButton?.setAccessibilityLabel(statusTitle)
        let colorway = nativeToolbarStatusColor(
            isRefreshing: nativeRefreshInFlight
        )
        nativeStatusRefreshButton?.contentTintColor = colorway.text
        nativeStatusPill?.colorway = colorway
        nativeStatusToolbarItem?.label = TiboTattleLocalization.string(
            .nativeDashboardRefreshUsage
        )
        nativeStatusToolbarItem?.toolTip = TiboTattleLocalization.string(
            .nativeDashboardCurrentEvidenceTooltip
        )
        nativeShareToolbarItem?.label = TiboTattleLocalization.string(
            .nativeDashboardShare
        )
        nativeShareToolbarItem?.toolTip = TiboTattleLocalization.string(
            .nativeDashboardShareTooltip
        )
        nativeSettingsToolbarItem?.label = TiboTattleLocalization.string(
            .menuSettings
        )
        nativeSettingsToolbarItem?.toolTip = TiboTattleLocalization.string(
            .menuSettings
        )
    }

    private func nativeRefreshToolbarTooltip() -> String {
        TiboTattleLocalization.string(.nativeDashboardRefreshUsageTooltip)
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

    /// Puts the native chrome into the dashboard area of the window. Both the
    /// live dashboard and the chrome smoke mode go through here, so the guard
    /// measures the frame the app really installs.
    @discardableResult
    private func installDashboardChrome(
        webView: WKWebView
    ) -> NativeDashboardChrome {
        let chrome = NativeDashboardChrome(webView: webView)
        dashboardContentController?.addChild(chrome)
        let chromeView = chrome.view
        chromeView.translatesAutoresizingMaskIntoConstraints = false
        dashboardContainer.addSubview(chromeView)
        NSLayoutConstraint.activate([
            chromeView.leadingAnchor.constraint(
                equalTo: dashboardContainer.leadingAnchor
            ),
            chromeView.trailingAnchor.constraint(
                equalTo: dashboardContainer.trailingAnchor
            ),
            chromeView.topAnchor.constraint(
                equalTo: dashboardContainer.topAnchor
            ),
            chromeView.bottomAnchor.constraint(
                equalTo: dashboardContainer.bottomAnchor
            ),
            chromeView.heightAnchor.constraint(
                greaterThanOrEqualToConstant: 320
            ),
        ])
        nativeDashboardChrome = chrome
        return chrome
    }

    /// Builds the shipped dashboard window and installs the native chrome
    /// without starting a companion or loading a page. This is the seam the
    /// chrome smoke mode drives: it exercises `createWindow()` and
    /// `installDashboardChrome(webView:)` themselves rather than a replica of
    /// them, so a layout regression cannot hide behind a test-only assembly.
    static func makeDashboardChromeProbe(
        webView: WKWebView
    ) -> NativeDashboardChromeProbe? {
        let delegate = AppDelegate(
            semanticOpenTarget: SemanticOpenTarget(
                scheme: BundledProduct.appOpenScheme,
                host: BundledProduct.appOpenHost,
                canonicalURL: BundledProduct.appOpenURL
            )
        )
        delegate.createWindow()
        guard let window = delegate.window else { return nil }
        let chrome = delegate.installDashboardChrome(webView: webView)
        delegate.dashboardContainer.isHidden = false
        delegate.statusStack.isHidden = true
        delegate.actionRow.isHidden = true
        guard let launcherColumn = delegate.launcherColumn else { return nil }
        return NativeDashboardChromeProbe(
            owner: delegate,
            window: window,
            container: delegate.dashboardContainer,
            launcherColumn: launcherColumn,
            chrome: chrome
        )
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
            let chrome = installDashboardChrome(webView: created.webView)
            chrome.onNavigate = { [weak self] destination in
                self?.navigateNativeDashboard(to: destination)
            }
            dashboardWebHost = created
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
        if startupAutomaticRefreshPending {
            startupAutomaticRefreshPending = false
            refreshLocalUsage(automatic: true)
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
        cancelNativeIndexingCoveragePoll()
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
                self.nativeEvidenceState = .readFailed
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
                // A failed loopback request is evidence-read trouble, not
                // proof that the companion process exited. Keep the retry
                // control enabled and leave lifecycle recovery to onExit.
                self.nativeEvidenceState = .readFailed
                self.quotaNotificationCoordinator?.recordIneligible(
                    .providerUnavailable
                )
                self.finishNativeRefresh(
                    title: TiboTattleLocalization.string(
                        .menuBarQuotaEvidenceUnavailable
                    ),
                    refreshEnabled: true
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
                    if let overview {
                        self.nativeEvidenceObservedAt = overview.observedAt
                        switch LocalCompanionOverviewProjection.evidence(
                            for: overview
                        ) {
                        case .live:
                            self.nativeEvidenceState = .live
                        case .stale:
                            self.nativeEvidenceState = .stale
                        case .none:
                            self.nativeEvidenceState = .unknown
                        }
                    } else {
                        // Keep any last observed timestamp for honest age
                        // context, but distinguish a transient read failure
                        // from a dead companion process.
                        self.nativeEvidenceState = .readFailed
                    }
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
                    // The pill's terminal state is decided only after the
                    // companion's own coverage counts and refresh receipt
                    // have been re-read; a failed pass or a still-building
                    // index then takes the title over the evidence prose.
                    self.readNativeToolbarStatusFacts(base: base) { [weak self] in
                        self?.finishNativeRefresh(
                            title: title,
                            refreshEnabled: true
                        )
                    }
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
        // Before the toolbar is allowed to claim a state, the document that is
        // showing the numbers is told to re-read them. Every terminal outcome
        // signals, not just the successful one: a rejected or unreachable
        // refresh still leaves the page asserting a freshness this window can
        // no longer vouch for.
        dashboardWebHost?.notifyLocalEvidenceUpdated()
        scheduleNativeRefresh()
        scheduleNativeIndexingCoveragePoll()
    }

    /// One bounded loopback read of the two pill-only companion facts. A
    /// readable payload replaces the stored observation entirely; an
    /// unreadable endpoint keeps the previous observation rather than
    /// inventing a state.
    private func readNativeToolbarStatusFacts(
        base: URL,
        completion: @escaping () -> Void
    ) {
        nativeEvidenceReader.readHistoryIndexingCoverage(base: base) { [weak self] observation in
            guard let self, !self.quitting else { return }
            switch observation {
            case let .indexing(coverage):
                self.nativeHistoryIndexingCoverage = coverage
            case .notIndexing:
                self.nativeHistoryIndexingCoverage = nil
            case nil:
                break
            }
            self.nativeEvidenceReader.readRefreshTerminalObservation(base: base) { [weak self] terminal in
                guard let self, !self.quitting else { return }
                switch terminal {
                case let .failed(step):
                    self.nativeRefreshFailure = NativeRefreshFailure(
                        failedStep: step
                    )
                case .notFailed:
                    self.nativeRefreshFailure = nil
                case nil:
                    break
                }
                completion()
            }
        }
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
    /// login-item launch (if enabled) remains only an explicit app start. The
    /// interval is a persisted, bounded preference; it never creates a
    /// background worker or keeps the app alive after quit.
    private func scheduleNativeRefresh() {
        cancelNativeRefreshSchedule()
        guard !quitting, dashboardURL != nil else { return }
        let work = NativeForegroundRefreshScheduler.schedule { [weak self] in
            self?.refreshLocalUsage(automatic: true)
        }
        nativeRefreshSchedule = work
    }

    private func cancelNativeRefreshSchedule() {
        nativeRefreshSchedule?.cancel()
        nativeRefreshSchedule = nil
    }

    /// While the history index is still advancing, the idle pill re-reads
    /// the companion's coverage counts on a short foreground cadence so
    /// "Indexing n of m" tracks reality between refreshes. The poll exists
    /// only between an incomplete coverage observation and the first
    /// complete one: it is cancelled when a refresh starts, when the
    /// companion goes away, and on quit, and it never creates a timer,
    /// helper, daemon, or background polling path.
    private static let indexingCoveragePollSeconds = 30

    private func scheduleNativeIndexingCoveragePoll() {
        cancelNativeIndexingCoveragePoll()
        guard !quitting,
              dashboardURL != nil,
              let coverage = nativeHistoryIndexingCoverage,
              !coverage.isComplete
        else {
            return
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.quitting, !self.nativeRefreshInFlight,
                  let dashboardURL = self.dashboardURL
            else {
                return
            }
            self.readNativeToolbarStatusFacts(base: dashboardURL) { [weak self] in
                guard let self, !self.quitting, !self.nativeRefreshInFlight
                else {
                    return
                }
                self.updateNativeToolbar(
                    title: TiboTattleLocalization.string(
                        .nativeDashboardStatus
                    ),
                    isRefreshing: false,
                    refreshEnabled: self.dashboardURL != nil
                )
                self.scheduleNativeIndexingCoveragePoll()
            }
        }
        nativeIndexingCoveragePoll = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .seconds(Self.indexingCoveragePollSeconds),
            execute: work
        )
    }

    private func cancelNativeIndexingCoveragePoll() {
        nativeIndexingCoveragePoll?.cancel()
        nativeIndexingCoveragePoll = nil
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

        // Every Mac app that shows data a user waits on answers Command-R, and
        // this one had no View menu and no keyboard shortcut at all: the only
        // refresh was a toolbar button. WebKit's own context-menu "Reload"
        // looked like the missing command but reloads the document rather than
        // re-reading local usage, which is why it appeared to do nothing. This
        // is the same foreground-only companion path the toolbar button uses.
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: TiboTattleLocalization.string(.menuView))
        let refresh = NSMenuItem(
            title: TiboTattleLocalization.string(.nativeDashboardRefreshUsage),
            action: #selector(refreshDashboardFromToolbar),
            keyEquivalent: "r"
        )
        refresh.target = self
        viewMenu.addItem(refresh)
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)
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
        startupAutomaticRefreshPending = false
        nativeEvidenceState = .readFailed
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
            title: TiboTattleLocalization.string(
                .menuBarQuotaEvidenceUnavailable
            ),
            isRefreshing: false,
            refreshEnabled: dashboardURL != nil
        )
    }

    private func hideDashboardWebView() {
        // Refuse to tear the web view down while a hosted sign-in is in flight
        // (owner-reported, 2026-08-10). stop() below wipes the live page; the
        // owner-only companion state preserves the pending handoff across a
        // relaunch, and persistent WebKit state preserves a valid session.
        // Tearing the live page down mid-flow would still discard the active
        // in-memory continuation the page is driving. The page clears this
        // flag the moment the sign-in settles, cancels, or times out, and a
        // fresh navigation clears it too, so this can only defer teardown for
        // the brief window it protects.
        if dashboardWebHost?.hostedSignInInFlight == true {
            return
        }
        cancelNativeRefreshSchedule()
        startupAutomaticRefreshPending = false
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        openInBrowserButton.isEnabled = false
        cancelNativeRefreshPoll()
        cancelNativeIndexingCoveragePoll()
        // Every teardown that hides the dashboard also loses the companion
        // that reported these two facts, so the pill may not keep narrating
        // an index build or a failed refresh it can no longer observe.
        nativeHistoryIndexingCoverage = nil
        nativeRefreshFailure = nil
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
        nativeEvidenceState = .unknown
        nativeEvidenceObservedAt = nil
        // A restarted companion invalidates any earlier coverage counts and
        // refresh receipt; the refresh below re-reads both from the new
        // process before the pill claims either again.
        nativeHistoryIndexingCoverage = nil
        nativeRefreshFailure = nil
        cancelNativeIndexingCoveragePoll()
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
        // on screen. The first automatic refresh is armed here but starts only
        // after the page confirms that its initial local result has rendered.
        // That keeps collection from blocking the reads needed for first paint
        // while still requiring no manual dashboard action.
        pendingDashboardOpen = false
        startupAutomaticRefreshPending = true
        openDashboard()
    }

    private func companionExited(
        requested: Bool,
        anotherInstanceIsActive: Bool,
        generation: Int
    ) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        startupAutomaticRefreshPending = false
        if quitting || requested { return }
        dashboardURL = nil
        companion = nil
        if !anotherInstanceIsActive,
           retryAllowed,
           firstRunAcknowledged,
           !automaticCompanionRecoveryUsed {
            automaticCompanionRecoveryUsed = true
            startCompanion()
            return
        }
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
        nativeEvidenceState = .lifecycleUnavailable
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
        automaticCompanionRecoveryUsed = false
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
        NativeSettingsLayout.label(text, font: font, color: color)
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

    private func settingsGroup(
        title: String,
        symbolName: String,
        views: [NSView]
    ) -> NSView {
        NativeSettingsLayout.group(
            title: title,
            symbolName: symbolName,
            views: views
        )
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
        NativeSettingsLayout.page(
            title: title,
            summary: summary,
            views: views
        ).controller
    }

    private func codexHomeSettingsSummary() -> String {
        guard let configuration = codexHomeConfiguration,
              configuration.mode == .custom
        else {
            return TiboTattleLocalization.string(
                .settingsCodexFolderDefaultLocation
            )
        }
        // The Settings label may name the folder; Data & Diagnostics keeps
        // its paths_included: false promise and never carries this value.
        return TiboTattleLocalization.format(
            .settingsCodexFolderCustomSelectedPath,
            (configuration.url.path as NSString).abbreviatingWithTildeInPath
        )
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

    private func nativeToolbarEvidenceTitle(fallback: String) -> String {
        // The companion's own refresh receipt and index coverage outrank the
        // evidence prose: a failed pass must say it failed, and a history
        // index that is still building must narrate its real progress rather
        // than hiding behind a bare "Status". Once coverage is complete and
        // the last refresh succeeded, the existing vocabulary returns.
        if let failure = nativeRefreshFailure {
            return NativeToolbarStatusText.refreshFailed(
                step: failure.failedStep
            )
        }
        if let coverage = nativeHistoryIndexingCoverage, !coverage.isComplete {
            return NativeToolbarStatusText.indexing(
                indexedSourceCount: coverage.indexedSourceCount,
                sourceCount: coverage.sourceCount
            )
        }
        switch nativeEvidenceState {
        case .live:
            return TiboTattleLocalization.string(.nativeDashboardFresh)
        case .stale:
            return TiboTattleLocalization.string(.nativeDashboardNeedsRefresh)
        case .readFailed:
            return TiboTattleLocalization.string(.nativeDashboardStatus)
        case .lifecycleUnavailable:
            return TiboTattleLocalization.string(.nativeDashboardStatus)
        case .unknown:
            return fallback
        }
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

    private func updateRefreshIntervalSettingsControl() {
        guard let picker = settingsRefreshIntervalPicker else { return }
        let value = NativeRefreshIntervalPreference.seconds
        if let index = picker.itemArray.firstIndex(where: {
            ($0.representedObject as? Int) == value
        }) {
            picker.selectItem(at: index)
        }
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

    @objc private func showSettingsWindow() {
        showSettings(selecting: 0)
    }

    @objc private func showAbout() {
        showSettings(selecting: 2)
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

    @objc private func selectRefreshInterval(_ sender: NSPopUpButton) {
        guard let seconds = sender.selectedItem?.representedObject as? Int else {
            updateRefreshIntervalSettingsControl()
            return
        }
        let applied = NativeRefreshIntervalSelection.apply(
            seconds: seconds,
            defaults: .standard,
            dashboardAvailable: dashboardURL != nil,
            refreshInFlight: nativeRefreshInFlight,
            reschedule: { [weak self] in
                self?.scheduleNativeRefresh()
            }
        )
        updateRefreshIntervalSettingsControl()
        guard applied else { return }
    }

    @objc private func openNotificationSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        ) else {
            return
        }
        NSWorkspace.shared.open(url)
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
        settingsAboutAutomaticUpdatesDetailLabel = nil
        settingsCheckForUpdatesButton = nil
        settingsRefreshIntervalPicker = nil
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
            updateRefreshIntervalSettingsControl()
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
        let languageRow = NSStackView(views: [languagePicker])
        languageRow.orientation = .horizontal
        languageRow.alignment = .centerY
        let languageSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsLanguage),
            symbolName: "globe",
            views: [
            languageRow,
            settingsLabel(
                TiboTattleLocalization.string(.settingsLanguageSummary),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
        ])
        let sourceSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsCodexFolder),
            symbolName: "folder",
            views: [
            sourceStatus,
            settingsLabel(
                TiboTattleLocalization.string(.settingsCodexFolderSummary),
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            sourceActions,
        ])
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
        let automaticUpdatesHeader = NSStackView(views: [automaticUpdatesSwitch])
        automaticUpdatesHeader.orientation = .horizontal
        automaticUpdatesHeader.alignment = .centerY

        let refreshIntervalPicker = NSPopUpButton(
            frame: .zero,
            pullsDown: false
        )
        let refreshIntervalChoices: [(Int, TiboTattleLocalization.Key)] = [
            (60, .settingsRefreshIntervalOneMinute),
            (5 * 60, .settingsRefreshIntervalFiveMinutes),
            (15 * 60, .settingsRefreshIntervalFifteenMinutes),
            (30 * 60, .settingsRefreshIntervalThirtyMinutes),
        ]
        for (seconds, key) in refreshIntervalChoices {
            refreshIntervalPicker.addItem(
                withTitle: TiboTattleLocalization.string(key)
            )
            refreshIntervalPicker.lastItem?.representedObject = seconds
        }
        refreshIntervalPicker.target = self
        refreshIntervalPicker.action = #selector(selectRefreshInterval(_:))
        refreshIntervalPicker.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsRefreshInterval)
        )
        settingsRefreshIntervalPicker = refreshIntervalPicker
        updateRefreshIntervalSettingsControl()
        let refreshIntervalRow = NSStackView(views: [refreshIntervalPicker])
        refreshIntervalRow.orientation = .horizontal
        refreshIntervalRow.alignment = .centerY
        let refreshIntervalSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsRefreshInterval),
            symbolName: "clock",
            views: [
                refreshIntervalRow,
                settingsLabel(
                    TiboTattleLocalization.string(.settingsRefreshIntervalDetail),
                    font: .systemFont(ofSize: 12),
                    color: .secondaryLabelColor
                ),
            ]
        )
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
        let startAtLoginHeader = NSStackView(views: [startAtLoginSwitch])
        startAtLoginHeader.orientation = .horizontal
        startAtLoginHeader.alignment = .centerY
        let openLoginItems = NSButton(
            title: TiboTattleLocalization.string(.settingsOpenLoginItems),
            target: self,
            action: #selector(openLoginItemsSettings)
        )
        openLoginItems.bezelStyle = .rounded
        openLoginItems.image = NSImage(
            systemSymbolName: "gearshape",
            accessibilityDescription: TiboTattleLocalization.string(
                .settingsOpenLoginItems
            )
        )
        openLoginItems.imagePosition = .imageLeading
        let refreshLoginItemStatus = NSButton(
            title: TiboTattleLocalization.string(
                .settingsRefreshLoginItemStatus
            ),
            target: self,
            action: #selector(refreshLoginItemStatus)
        )
        refreshLoginItemStatus.bezelStyle = .rounded
        refreshLoginItemStatus.image = NSImage(
            systemSymbolName: "arrow.clockwise",
            accessibilityDescription: TiboTattleLocalization.string(
                .settingsRefreshLoginItemStatus
            )
        )
        refreshLoginItemStatus.imagePosition = .imageLeading
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
        removePendingLoginItem.image = NSImage(
            systemSymbolName: "minus.circle",
            accessibilityDescription: TiboTattleLocalization.string(
                .settingsRemovePendingLoginItem
            )
        )
        removePendingLoginItem.imagePosition = .imageLeading
        removePendingLoginItem.isHidden =
            !startAtLoginPresentation.showsPendingRemoval
        removePendingLoginItem.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsRemovePendingLoginItem)
        )
        settingsStartAtLoginPendingRemovalButton = removePendingLoginItem
        let startAtLoginSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsStartAtLogin),
            symbolName: "person.crop.circle.badge.checkmark",
            views: [
                startAtLoginHeader,
                startAtLoginDetail,
                openLoginItems,
                refreshLoginItemStatus,
                removePendingLoginItem,
            ]
        )
        let quotaNotificationsSwitch = NSSwitch()
        quotaNotificationsSwitch.target = self
        quotaNotificationsSwitch.action = #selector(toggleQuotaNotifications(_:))
        quotaNotificationsSwitch.toolTip = TiboTattleLocalization.string(
            .settingsNotificationsToggleTooltip
        )
        settingsQuotaNotificationsSwitch = quotaNotificationsSwitch
        let quotaNotificationsHeader = NSStackView(views: [
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
        let openNotifications = NSButton(
            title: TiboTattleLocalization.string(.settingsOpenNotifications),
            target: self,
            action: #selector(openNotificationSettings)
        )
        openNotifications.bezelStyle = .rounded
        openNotifications.image = NSImage(
            systemSymbolName: "bell.badge",
            accessibilityDescription: TiboTattleLocalization.string(
                .settingsOpenNotifications
            )
        )
        openNotifications.imagePosition = .imageLeading
        let quotaNotificationStatus = settingsLabel(
            quotaNotificationSettingsSummary(),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        quotaNotificationStatus.maximumNumberOfLines = 3
        settingsQuotaNotificationStatusLabel = quotaNotificationStatus
        let quotaNotificationsSection = settingsGroup(
            title: TiboTattleLocalization.string(
                .settingsNotificationsAllowanceTitle
            ),
            symbolName: "bell",
            views: [
                quotaNotificationsHeader,
                openNotifications,
                quotaNotificationThresholdRow,
                settingsLabel(
                    TiboTattleLocalization.string(
                        .settingsNotificationsResetDetail
                    ),
                    font: .systemFont(ofSize: 12),
                    color: .secondaryLabelColor
                ),
                quotaNotificationStatus,
            ]
        )
        let general = settingsPage(
            title: TiboTattleLocalization.string(.settingsGeneral),
            summary: TiboTattleLocalization.string(.settingsGeneralSummary),
            views: [
                languageSection,
                sourceSection,
                refreshIntervalSection,
                startAtLoginSection,
            ]
        )
        let notifications = settingsPage(
            title: TiboTattleLocalization.string(.settingsNotifications),
            summary: TiboTattleLocalization.string(
                .settingsNotificationsDetail
            ),
            views: [quotaNotificationsSection]
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
                address: "https://github.com/adamallcock/tibotattle"
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
        let aboutUpdatesSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsAutomaticUpdates),
            symbolName: "arrow.down.circle",
            views: [
                automaticUpdatesHeader,
                aboutAutomaticUpdatesDetail,
                checkForUpdates,
            ]
        )
        let aboutProductSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsAboutTab),
            symbolName: "info.circle",
            views: [aboutBranding]
        )
        let about = settingsPage(
            title: TiboTattleLocalization.format(
                .settingsAboutProduct,
                BundledProduct.displayName
            ),
            summary: TiboTattleLocalization.string(.settingsAboutSummary),
            views: [
                aboutProductSection,
                aboutUpdatesSection,
                projectLinks,
            ]
        )

        for controller in [general, notifications, about] {
            controller.title = TiboTattleLocalization.string(.settingsWindowTitle)
        }

        let tabs = NSTabViewController()
        tabs.tabStyle = .toolbar
        for (label, symbol, controller) in [
            (TiboTattleLocalization.string(.settingsGeneral), "gearshape", general),
            (
                TiboTattleLocalization.string(.settingsNotifications),
                "bell",
                notifications
            ),
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
        // A normal, centered settings form needs enough width for translated
        // descriptions while keeping short pages compact. Each page scrolls
        // vertically when General outgrows this frame.
        newWindow.setContentSize(NSSize(width: 760, height: 620))
        newWindow.contentMinSize = NSSize(width: 680, height: 520)
        newWindow.isReleasedWhenClosed = false
        newWindow.center()
        settingsWindow = newWindow
        settingsTabs = tabs
        updateQuotaNotificationSettingsControls()
        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateStartAtLoginSettingsControl()
    }

    private func diagnosticText(
        contribution: ContributionDiagnosticsSnapshot
    ) -> String {
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
            loginItemLastOperation: lastLoginItemDiagnosticAction,
            contribution: contribution
        )
    }

    @objc private func showDiagnostics() {
        var localDiagnostics: LocalContributionDiagnostics?
        var dashboardDiagnostics: DashboardContributionDiagnostics?
        let reads = DispatchGroup()
        if let dashboardURL {
            reads.enter()
            nativeEvidenceReader.readContributionDiagnostics(
                base: dashboardURL
            ) { value in
                localDiagnostics = value
                reads.leave()
            }
        }
        if let dashboardWebHost {
            reads.enter()
            dashboardWebHost.readContributionDiagnostics { value in
                dashboardDiagnostics = value
                reads.leave()
            }
        }
        reads.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.presentDiagnostics(
                self.diagnosticText(
                    contribution: .merge(
                        local: localDiagnostics,
                        dashboard: dashboardDiagnostics
                    )
                )
            )
        }
    }

    private func presentDiagnostics(_ diagnostics: String) {
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

    // A rejected folder change alters nothing: the companion keeps running
    // with the previous configuration, so the main window's failure surface
    // would be both invisible behind the frontmost Settings window and
    // dishonest about the lifecycle. The rejection answers as an alert where
    // the user is looking instead.
    private func presentCodexHomeSelectionRejection(_ error: Error) {
        let launcherError = error as? LauncherError
            ?? LauncherError.invalidCodexHome
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = TiboTattleLocalization.string(.settingsCodexFolder)
        alert.informativeText = TiboTattleLocalization.format(
            .launcherFailureDetails,
            launcherError.errorDescription
                ?? TiboTattleLocalization.string(.launcherErrorInvalidCodexHome),
            launcherError.failureCode,
            launcherError.recoverySuggestion
        )
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonOK))
        if let settingsWindow, settingsWindow.isVisible {
            alert.beginSheetModal(for: settingsWindow)
        } else {
            alert.runModal()
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
            presentCodexHomeSelectionRejection(error)
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
            presentCodexHomeSelectionRejection(error)
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
            child.arguments = resources.nodeRuntimeMode.arguments(
                entrypoint: resources.keychainResetEntrypoint,
                trailing: ["--confirm-local-keychain-reset"]
            )
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
        // This explicit destructive reset is also the cancellation boundary
        // for any in-flight hosted sign-in. Stop first so the normal teardown
        // protection cannot preserve a page whose owner-only recovery file
        // and web data are about to be cleared, then reveal the native
        // progress state.
        dashboardWebHost?.stop()
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
                        DashboardWebHost.clearPersistentWebsiteData {
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
        cancelNativeIndexingCoveragePoll()
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
    static func run(
        requireCentralService: Bool = false,
        nodeRuntimeModeOverride: BundledNodeRuntimeMode? = nil
    ) -> Int32 {
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
            nodeRuntimeModeOverride: nodeRuntimeModeOverride,
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
        if nodeRuntimeModeOverride == .jitless {
            print(
                "USAGE_MONITOR_MACOS_JITLESS_SMOKE_READY "
                    + "host=\(loopbackHost) "
                    + "port=\(selectedURL.port ?? 0) state=owner-only"
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
        let contributionPayload = Data(#"""
        {
          "schemaVersion": "local-contribution-diagnostics-v0.1",
          "journeyPhase": "approved_connection_needed",
          "previewState": "not_observed",
          "queueState": "retry_wait",
          "consent": {"approved": true, "current": true},
          "signedIn": {"observed": false, "value": false},
          "pairing": {"observed": true, "paired": false},
          "recentDiagnosticReferences": [
            {"reference": "TT-7QF3K2", "recordedAt": "2026-08-19T13:01:00.000Z"}
          ],
          "includesTokens": false,
          "includesOauthState": false,
          "includesVerifiers": false,
          "includesDeviceIdentifiers": false,
          "includesAccountIdentifiers": false,
          "includesContent": false,
          "includesPaths": false
        }
        """#.utf8)
        guard let localContribution = LocalContributionDiagnostics.decode(
            contributionPayload
        ) else {
            return 1
        }
        guard var unsafeObject = try? JSONSerialization.jsonObject(
            with: contributionPayload
        ) as? [String: Any] else {
            return 1
        }
        unsafeObject["token"] = "MUST_NOT_APPEAR"
        guard let unsafePayload = try? JSONSerialization.data(
            withJSONObject: unsafeObject
        ), LocalContributionDiagnostics.decode(unsafePayload) == nil else {
            return 1
        }
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
            loginItemLastOperation: .registerRequiresApproval,
            contribution: .merge(
                local: localContribution,
                dashboard: nil
            )
        )
        guard rendered.contains("TT-7QF3K2"),
              !rendered.contains("MUST_NOT_APPEAR")
        else {
            return 1
        }
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

/// Exercises the refresh cadence preference against a separate persistent
/// defaults suite. This keeps the bundle contract deterministic without
/// mutating the developer's normal TiboTattle settings.
private enum NativeRefreshSettingsContractSmokeTest {
    private static let suiteName =
        "com.usagemonitor.local.native-refresh-settings-contract"

    static func run() -> Int32 {
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            return 1
        }
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        guard NativeRefreshIntervalPreference.seconds(in: defaults)
                == NativeRefreshIntervalPreference.defaultSeconds
        else {
            return 1
        }
        let testNow = DispatchTime(uptimeNanoseconds: 1_000_000_000)
        var initialDeadline: DispatchTime?
        let initialWork = NativeForegroundRefreshScheduler.schedule(
            defaults: defaults,
            now: testNow,
            action: {},
            enqueue: { deadline, _ in
                initialDeadline = deadline
            }
        )
        initialWork.cancel()
        guard initialDeadline?.uptimeNanoseconds
                == testNow.uptimeNanoseconds + 300_000_000_000
        else {
            return 1
        }

        var pickerRescheduleCount = 0
        var pickerRescheduledDeadline: DispatchTime?
        let pickerApplied = NativeRefreshIntervalSelection.apply(
            seconds: 15 * 60,
            defaults: defaults,
            dashboardAvailable: true,
            refreshInFlight: false,
            reschedule: {
                pickerRescheduleCount += 1
                let work = NativeForegroundRefreshScheduler.schedule(
                    defaults: defaults,
                    now: testNow,
                    action: {},
                    enqueue: { deadline, _ in
                        pickerRescheduledDeadline = deadline
                    }
                )
                work.cancel()
            }
        )
        guard pickerApplied,
              pickerRescheduleCount == 1,
              pickerRescheduledDeadline?.uptimeNanoseconds
                == testNow.uptimeNanoseconds + 900_000_000_000
        else {
            return 1
        }
        defaults.synchronize()
        guard let reloaded = UserDefaults(suiteName: suiteName),
              NativeRefreshIntervalPreference.seconds(in: reloaded)
                == 15 * 60
        else {
            return 1
        }
        guard NativeForegroundRefreshSchedule.current(in: reloaded)
                .intervalSeconds == 15 * 60
        else {
            return 1
        }

        let invalidPickerSelection = NativeRefreshIntervalSelection.apply(
            seconds: 17,
            defaults: reloaded,
            dashboardAvailable: true,
            refreshInFlight: false,
            reschedule: {
                pickerRescheduleCount += 1
            }
        )
        guard !invalidPickerSelection, pickerRescheduleCount == 1 else {
            return 1
        }
        NativeRefreshIntervalPreference.setSeconds(17, in: reloaded)
        guard NativeRefreshIntervalPreference.seconds(in: reloaded)
                == 15 * 60
        else {
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_REFRESH_SETTINGS_CONTRACT "
                + "default=300 persisted=900 reloaded=900 "
                + "picker_action=true picker_persisted=true "
                + "scheduler=300->900 "
                + "invalid_ignored=true"
        )
        return 0
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
        let durationSeconds = TimeInterval(
            CodexQuotaWindowDuration.sevenDayMinutes * 60
        )
        let resetAt = Date(timeIntervalSince1970: 1_800_000_000)
        let observedAt = resetAt.addingTimeInterval(
            -durationSeconds * 0.76
        )
        let weeklyLane = ObservedQuotaLane(
            label: TiboTattleLocalization.string(.menuBarSevenDayAllowance),
            remainingPercent: 71,
            durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
            resetAt: resetAt,
            observedAt: observedAt,
            isPrimary: true
        )
        let weeklyPosition = weeklyWindowPosition(weeklyLane)
        var liveSnapshot = MenuBarStatusSnapshot()
        liveSnapshot.phase = .ready
        liveSnapshot.evidence = .live
        liveSnapshot.lanes = [weeklyLane]
        liveSnapshot.observedAt = observedAt
        let liveSummary = liveSnapshot.laneSummary(
            weeklyLane,
            now: observedAt
        )
        var staleSnapshot = liveSnapshot
        staleSnapshot.evidence = .stale
        let staleSummary = staleSnapshot.laneSummary(
            weeklyLane,
            now: observedAt
        )
        let reset = resetCountdown(resetAt, now: observedAt)
        let expectedLiveSummary = reset.map {
            TiboTattleLocalization.format(
                .menuBarQuotaWeeklyPositionResets,
                weeklyLane.label,
                TiboTattleLocalization.percentString(24),
                TiboTattleLocalization.percentString(29),
                $0
            )
        }
        let expectedStaleSummary = TiboTattleLocalization.format(
            .menuBarQuotaLastObserved,
            weeklyLane.label
        )
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
              starting.appDeactivationDismissalObserverInstalled,
              weeklyPosition == WeeklyWindowPosition(
                  elapsedPercent: 24,
                  usedPercent: 29
              ),
              liveSummary == expectedLiveSummary,
              staleSummary == expectedStaleSummary
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
                + "dismissal=native,escape,same-app,deactivation "
                + "weekly_position=fresh-only"
        )
        return 0
    }
}

/// The Settings window's card layout, kept out of `AppDelegate` so the
/// rendered result can be measured by a contract smoke test instead of being
/// asserted against source text. A vertical `NSStackView` aligned `.width`
/// does NOT stretch its arranged subviews to the stack width — it sizes each
/// one to its own intrinsic width and pins the trailing edges, which is what
/// produced the ragged, right-floated cards with a blank column on the left.
/// Leading alignment plus an explicit `width == stack.width` on each arranged
/// subview is what actually produces one full-width column.
@MainActor
private enum NativeSettingsLayout {
    static func label(
        _ text: String,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = font
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setContentCompressionResistancePriority(
            .defaultLow,
            for: .horizontal
        )
        return label
    }

    static func group(
        title: String,
        symbolName: String,
        views: [NSView]
    ) -> NSView {
        let header = NSStackView()
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        let icon = NSImageView(
            image: NSImage(
                systemSymbolName: symbolName,
                accessibilityDescription: title
            ) ?? NSImage()
        )
        icon.contentTintColor = .controlAccentColor
        icon.imageScaling = .scaleProportionallyDown
        icon.setContentHuggingPriority(.required, for: .horizontal)
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 18).isActive = true
        header.addArrangedSubview(icon)
        header.addArrangedSubview(label(
            title,
            font: .systemFont(ofSize: 14, weight: .semibold),
            color: .labelColor
        ))

        let contentViews: [NSView] = [header] + views
        let contentStack = NSStackView(views: contentViews)
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 8
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        // Keep every row on the same leading column while giving wrapping
        // labels the full card width to measure against. The page owns the
        // card width; this constraint only keeps the card's internal rows
        // coherent instead of producing an independent staircase per row.
        for view in contentViews {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: contentStack.widthAnchor)
                .isActive = true
        }
        let contentView = NSView()
        contentView.addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(
                equalTo: contentView.leadingAnchor
            ),
            contentStack.trailingAnchor.constraint(
                equalTo: contentView.trailingAnchor
            ),
            contentStack.topAnchor.constraint(equalTo: contentView.topAnchor),
            contentStack.bottomAnchor.constraint(
                equalTo: contentView.bottomAnchor
            ),
        ])

        let group = NSBox()
        group.boxType = .custom
        group.borderType = .lineBorder
        group.cornerRadius = 8
        group.contentViewMargins = NSSize(width: 20, height: 18)
        group.contentView = contentView
        group.translatesAutoresizingMaskIntoConstraints = false
        group.setContentCompressionResistancePriority(
            .defaultLow,
            for: .horizontal
        )
        return group
    }

    /// Returns the page controller together with the column stack the cards
    /// are arranged in, so a layout contract can measure the real card frames.
    static func page(
        title: String,
        summary: String,
        views: [NSView]
    ) -> (controller: NSViewController, column: NSStackView) {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let pageViews: [NSView] = [label(
            title,
            font: .systemFont(ofSize: 22, weight: .semibold),
            color: .labelColor
        ), label(
            summary,
            font: .systemFont(ofSize: 13),
            color: .secondaryLabelColor
        )] + views
        for view in pageViews {
            stack.addArrangedSubview(view)
            view.translatesAutoresizingMaskIntoConstraints = false
            // All cards share the page column width. Leading alignment keeps
            // the column stable when a translated label has a different
            // intrinsic width, while this explicit width keeps cards equal.
            view.widthAnchor.constraint(equalTo: stack.widthAnchor)
                .isActive = true
        }
        let scroll = NSScrollView()
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(scroll)
        let document = NSView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scroll.documentView = document
        let preferredWidth = stack.widthAnchor.constraint(
            equalTo: document.widthAnchor,
            constant: -56
        )
        preferredWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            document.leadingAnchor.constraint(
                equalTo: scroll.contentView.leadingAnchor
            ),
            document.topAnchor.constraint(
                equalTo: scroll.contentView.topAnchor
            ),
            document.widthAnchor.constraint(
                equalTo: scroll.contentView.widthAnchor
            ),
            document.heightAnchor.constraint(
                greaterThanOrEqualTo: scroll.contentView.heightAnchor
            ),
            stack.centerXAnchor.constraint(equalTo: document.centerXAnchor),
            stack.leadingAnchor.constraint(
                greaterThanOrEqualTo: document.leadingAnchor,
                constant: 28
            ),
            stack.trailingAnchor.constraint(
                lessThanOrEqualTo: document.trailingAnchor,
                constant: -28
            ),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
            // `lessThanOrEqualTo`, not `equalTo`. The document is already held
            // to at least the viewport height, so pinning the column to both
            // edges stretched it to the full window whenever a page's cards
            // were shorter than that - and a vertical NSStackView handed
            // surplus height spreads its arranged subviews through it. That is
            // what left Notifications and About with a switch floating in the
            // middle of an empty card and a button stranded at the bottom.
            // This still grows the document when the column is taller than the
            // viewport, because the column's bottom edge pushes it, so
            // scrolling a long page is unaffected.
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: document.bottomAnchor,
                constant: -24
            ),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 680),
        ])
        preferredWidth.isActive = true
        let controller = NSViewController()
        controller.view = root
        return (controller, stack)
    }
}

/// Lays out a representative Settings page in a real window at the shipped
/// settings size and measures the resulting card frames. This is the guard for
/// the reported "Settings menu is still broken" defect: with a vertical stack
/// aligned `.width` the cards float right at unequal widths, so this contract
/// fails unless every card starts on the same leading edge and fills the
/// column. Source-text assertions cannot catch that; measured frames can.
@MainActor
private enum NativeSettingsLayoutSmokeTest {
    private static let settingsContentWidth: CGFloat = 760
    private static let settingsContentHeight: CGFloat = 620

    static func run() -> Int32 {
        // AppKit needs an application object before views are laid out, but
        // this mode deliberately does not touch the activation policy: the
        // shipped app must stay a normal foreground app, and the accessory
        // policy is reserved for the two smoke modes that already claim it.
        _ = NSApplication.shared

        func detail(_ text: String) -> NSTextField {
            NativeSettingsLayout.label(
                text,
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            )
        }
        func row(_ views: [NSView]) -> NSStackView {
            let stack = NSStackView(views: views)
            stack.orientation = .horizontal
            stack.alignment = .centerY
            return stack
        }
        func button(_ title: String) -> NSButton {
            let button = NSButton(title: title, target: nil, action: nil)
            button.bezelStyle = .rounded
            return button
        }
        func picker(_ titles: [String]) -> NSPopUpButton {
            let popUp = NSPopUpButton(frame: .zero, pullsDown: false)
            for title in titles { popUp.addItem(withTitle: title) }
            return popUp
        }

        // Deliberately mixed intrinsic widths. Under `.width` alignment these
        // four cards land on four different leading edges.
        let cards: [(String, NSView)] = [
            ("language", NativeSettingsLayout.group(
                title: "Language",
                symbolName: "globe",
                views: [
                    row([picker(["System language", "English"])]),
                    detail("Changing the language reopens the dashboard."),
                ]
            )),
            ("codex-folder", NativeSettingsLayout.group(
                title: "Codex folder",
                symbolName: "folder",
                views: [
                    detail(
                        "Using the default location for session and usage "
                            + "evidence."
                    ),
                    row([button("Choose Folder…"), button("Use Default")]),
                ]
            )),
            ("refresh-interval", NativeSettingsLayout.group(
                title: "Refresh interval",
                symbolName: "clock",
                views: [
                    row([picker(["Every minute", "Every 5 minutes"])]),
                    detail("How often the open app refreshes local evidence."),
                ]
            )),
            ("start-at-login", NativeSettingsLayout.group(
                title: "Start at login",
                symbolName: "power",
                views: [
                    row([NSSwitch()]),
                    detail("Start at login is off."),
                    row([button("Check Again")]),
                ]
            )),
        ]

        let page = NativeSettingsLayout.page(
            title: "General",
            summary: "Language, evidence folder, refresh cadence, login.",
            views: cards.map(\.1)
        )
        let window = NSWindow(
            contentRect: NSRect(
                x: 0,
                y: 0,
                width: settingsContentWidth,
                height: settingsContentHeight
            ),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = page.controller
        window.setContentSize(
            NSSize(
                width: settingsContentWidth,
                height: settingsContentHeight
            )
        )
        window.layoutIfNeeded()
        page.controller.view.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        page.controller.view.layoutSubtreeIfNeeded()

        let column = page.column
        let columnWidth = column.frame.width
        var leadingEdges: [CGFloat] = []
        var widths: [CGFloat] = []
        for (_, card) in cards {
            let frame = column.convert(card.bounds, from: card)
            leadingEdges.append(frame.minX)
            widths.append(frame.width)
        }
        let leadingSpread =
            (leadingEdges.max() ?? 0) - (leadingEdges.min() ?? 0)
        let widthSpread = (widths.max() ?? 0) - (widths.min() ?? 0)
        let narrowest = widths.min() ?? 0
        // A degenerate zero-width column would otherwise report zero spread.
        guard columnWidth >= 400,
              leadingSpread <= 0.5,
              widthSpread <= 0.5,
              abs(narrowest - columnWidth) <= 0.5
        else {
            FileHandle.standardError.write(Data(
                ("macOS settings layout smoke failed "
                    + "column=\(columnWidth) "
                    + "leading_spread=\(leadingSpread) "
                    + "width_spread=\(widthSpread) "
                    + "narrowest=\(narrowest)\n").utf8
            ))
            return 1
        }
        // A page whose cards do not fill the window is the case that broke:
        // the column was pinned to both the document top and bottom while the
        // document was held to at least the viewport height, so a short page
        // stretched the column to the full window and the stack spread its
        // cards through the surplus - a switch adrift in the middle of an
        // empty card. The four cards above are tall enough to fill the window
        // and would never show it, so the vertical contract is measured on a
        // deliberately short page.
        let shortCards: [NSView] = [
            NativeSettingsLayout.group(
                title: "Allowance alerts",
                symbolName: "bell",
                views: [row([NSSwitch()]), detail("Alerts are on.")]
            ),
            NativeSettingsLayout.group(
                title: "Automatic updates",
                symbolName: "arrow.down.circle",
                views: [row([button("Check for Updates…")])]
            ),
        ]
        let shortPage = NativeSettingsLayout.page(
            title: "Notifications",
            summary: "Optional local alerts.",
            views: shortCards
        )
        let shortWindow = NSWindow(
            contentRect: NSRect(
                x: 0,
                y: 0,
                width: settingsContentWidth,
                height: settingsContentHeight
            ),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        shortWindow.contentViewController = shortPage.controller
        shortWindow.setContentSize(
            NSSize(width: settingsContentWidth, height: settingsContentHeight)
        )
        shortWindow.layoutIfNeeded()
        shortPage.controller.view.layoutSubtreeIfNeeded()
        shortWindow.displayIfNeeded()
        shortPage.controller.view.layoutSubtreeIfNeeded()

        let shortColumn = shortPage.column
        let cardFrames = shortCards
            .map { shortColumn.convert($0.bounds, from: $0) }
            .sorted { $0.minY < $1.minY }
        var gaps: [CGFloat] = []
        for index in 1..<cardFrames.count {
            gaps.append(cardFrames[index].minY - cardFrames[index - 1].maxY)
        }
        let widestGap = gaps.max() ?? 0
        // The symptom is inside a card, not between cards: a switch adrift in
        // the middle of an empty box with its button stranded at the bottom.
        // So the contract that matters is that a card is exactly as tall as
        // its own content wants to be. `fittingSize` is that natural height,
        // and any excess over it is stretch.
        var worstStretch: CGFloat = 0
        for card in shortCards {
            let natural = card.fittingSize.height
            let actual = card.frame.height
            worstStretch = max(worstStretch, actual - natural)
        }
        guard widestGap <= shortColumn.spacing + 0.5,
              worstStretch <= 1,
              !cardFrames.isEmpty
        else {
            FileHandle.standardError.write(Data(
                ("macOS settings vertical layout smoke failed "
                    + "column_height=\(shortColumn.frame.height) "
                    + "window_height=\(settingsContentHeight) "
                    + "widest_gap=\(widestGap) "
                    + "worst_card_stretch=\(worstStretch) "
                    + "spacing=\(shortColumn.spacing)\n").utf8
            ))
            return 1
        }

        print(
            "USAGE_MONITOR_MACOS_SETTINGS_LAYOUT "
                + "cards=\(cards.count) "
                + "column_width=\(Int(columnWidth)) "
                + "leading_spread=\(Int(leadingSpread.rounded())) "
                + "width_spread=\(Int(widthSpread.rounded())) "
                + "full_width=true "
                + "short_column_height=\(Int(shortColumn.frame.height)) "
                + "widest_card_gap=\(Int(widestGap.rounded())) "
                + "worst_card_stretch=\(Int(worstStretch.rounded())) "
                + "packed_to_top=true"
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
        window.contentViewController = chrome
        window.setContentSize(NSSize(width: 1_180, height: 860))
        window.displayIfNeeded()
        chrome.view.layoutSubtreeIfNeeded()
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

/// Opens the shipped dashboard window and measures the chrome in it. This is
/// the guard for the reported "the menu is not seamless, not rounded, and not
/// even the right size" defect, and the three things it pins are the three
/// things that were wrong:
///
/// 1. the chrome filled only an inset region of the window, so the dashboard
///    floated inside a margin instead of being the window;
/// 2. the sidebar began below the title bar, so its vibrancy was cut by a hard
///    horizontal seam across the top of the window;
/// 3. the window did not carry `.fullSizeContentView`, which is the setting
///    that lets a sidebar split item run its material up behind the title bar
///    at all.
///
/// None of that is visible in source text - the old code reads as a perfectly
/// ordinary split view pinned to its container's edges. It is only visible in
/// the frames a real window assigns, so this measures them.
@MainActor
private enum NativeDashboardChromeLayoutSmokeTest {
    private static let resizedContentSize = NSSize(width: 1_040, height: 700)

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
        guard let probe = AppDelegate.makeDashboardChromeProbe(
            webView: host.webView
        ) else {
            FileHandle.standardError.write(Data(
                "macOS dashboard chrome smoke failed: no window\n".utf8
            ))
            return 1
        }
        let window = probe.window
        guard let content = window.contentView else {
            FileHandle.standardError.write(Data(
                "macOS dashboard chrome smoke failed: no content view\n".utf8
            ))
            return 1
        }

        func settle() {
            window.layoutIfNeeded()
            window.displayIfNeeded()
            content.layoutSubtreeIfNeeded()
        }
        settle()

        var failures: [String] = []
        let initial = evaluate(
            window: window,
            content: content,
            container: probe.container,
            launcherColumn: probe.launcherColumn,
            metrics: probe.chrome.measure(in: content),
            label: "initial",
            failures: &failures
        )
        // Read while the window is still at its opening size: the title bar
        // rect moves with the window, so this cannot be sampled after resizing.
        let behindTitleBar = initial.sidebarPane.maxY
            - window.contentLayoutRect.maxY

        // A pane that only happens to be right at the size the window opened
        // at is not a pane that tracks the split. WebKit here is deliberately
        // not laid out by Auto Layout, so the resize is the case that matters.
        window.setContentSize(resizedContentSize)
        settle()
        let resized = evaluate(
            window: window,
            content: content,
            container: probe.container,
            launcherColumn: probe.launcherColumn,
            metrics: probe.chrome.measure(in: content),
            label: "resized",
            failures: &failures
        )
        if abs(resized.webView.width - initial.webView.width) < 1 {
            failures.append(
                "web pane did not follow the resize "
                    + "(width stayed \(Int(resized.webView.width)))"
            )
        }

        guard failures.isEmpty else {
            FileHandle.standardError.write(Data(
                ("macOS dashboard chrome smoke failed\n"
                    + failures.map { "  - \($0)\n" }.joined()).utf8
            ))
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_DASHBOARD_CHROME "
                + "full_size_content=true "
                + "chrome_fills_window=true "
                + "sidebar_full_height=true "
                + "sidebar_behind_titlebar=\(Int(behindTitleBar.rounded())) "
                + "pane_gap=\(Int(initial.paneGap.rounded())) "
                + "sidebar_width=\(Int(initial.sidebarPane.width.rounded())) "
                + "web_width=\(Int(initial.webView.width.rounded())) "
                + "web_height=\(Int(initial.webView.height.rounded())) "
                + "resized_web_width="
                + "\(Int(resized.webView.width.rounded())) "
                + "resized_web_height="
                + "\(Int(resized.webView.height.rounded())) "
                + "vibrancy=sidebar,behind-window,follows-window-active-state"
        )
        return 0
    }

    private static func evaluate(
        window: NSWindow,
        content: NSView,
        container: NSView,
        launcherColumn: NSView,
        metrics: NativeDashboardChromeMetrics,
        label: String,
        failures: inout [String]
    ) -> NativeDashboardChromeMetrics {
        let tolerance: CGFloat = 0.5
        let bounds = content.bounds
        let titleBar = window.contentLayoutRect

        func require(_ condition: Bool, _ message: @autoclosure () -> String) {
            if !condition { failures.append("[\(label)] \(message())") }
        }

        // The window itself. Without `.fullSizeContentView` no arrangement of
        // subviews can put anything behind the title bar.
        require(
            window.styleMask.contains(.fullSizeContentView),
            "window lacks .fullSizeContentView, so nothing can sit behind the "
                + "title bar"
        )
        require(
            window.toolbarStyle == .unified,
            "toolbar style is \(window.toolbarStyle.rawValue), not unified"
        )

        // 1. The dashboard is the window, not a panel floating inside it.
        let containerFrame = content.convert(container.bounds, from: container)
        require(
            abs(containerFrame.minX - bounds.minX) <= tolerance
                && abs(containerFrame.maxX - bounds.maxX) <= tolerance
                && abs(containerFrame.minY - bounds.minY) <= tolerance
                && abs(containerFrame.maxY - bounds.maxY) <= tolerance,
            "dashboard area \(rect(containerFrame)) does not fill the window "
                + "content \(rect(bounds))"
        )
        require(
            abs(metrics.chrome.width - bounds.width) <= tolerance
                && abs(metrics.chrome.height - bounds.height) <= tolerance,
            "chrome \(rect(metrics.chrome)) does not fill the window content "
                + "\(rect(bounds))"
        )

        // 2. The sidebar runs the full height of the window content and keeps
        // going above the title bar's own layout rect. That second half is the
        // seam: a sidebar that stops at `contentLayoutRect.maxY` is exactly the
        // hard horizontal line the owner reported.
        require(
            abs(metrics.sidebarPane.minY - bounds.minY) <= tolerance
                && abs(metrics.sidebarPane.maxY - bounds.maxY) <= tolerance,
            "sidebar \(rect(metrics.sidebarPane)) does not span the full "
                + "window content height \(Int(bounds.height))"
        )
        require(
            metrics.sidebarPane.maxY >= titleBar.maxY + 1,
            "sidebar stops at \(Int(metrics.sidebarPane.maxY)) but the title "
                + "bar starts at \(Int(titleBar.maxY)), so it does not run "
                + "behind the title bar"
        )
        // The band is the chrome's own drag range: whatever width the split
        // rests at or restores must fall inside what the divider enforces.
        require(
            metrics.sidebarPane.width
                >= NativeDashboardChrome.sidebarMinimumThickness - 1
                && metrics.sidebarPane.width
                <= NativeDashboardChrome.sidebarMaximumThickness + 8,
            "sidebar width \(Int(metrics.sidebarPane.width)) is outside the "
                + "\(Int(NativeDashboardChrome.sidebarMinimumThickness))-"
                + "\(Int(NativeDashboardChrome.sidebarMaximumThickness)) band"
        )
        // The material runs behind the title bar; the rows in it must not, or
        // the first destination is hidden under the toolbar.
        require(
            metrics.sidebarRows.maxY <= titleBar.maxY + tolerance,
            "sidebar rows top \(Int(metrics.sidebarRows.maxY)) is above the "
                + "title bar's content rect \(Int(titleBar.maxY))"
        )
        require(
            metrics.sidebarRows.maxY >= titleBar.maxY - 24,
            "sidebar rows start \(Int(titleBar.maxY - metrics.sidebarRows.maxY))"
                + "pt below the title bar, which is a gap, not an inset"
        )

        // 3. Sidebar and report meet: same span, no gap beyond the divider.
        require(
            metrics.paneGap <= max(metrics.dividerThickness, 1) + tolerance,
            "gap of \(metrics.paneGap) between the sidebar and the report "
                + "exceeds the \(metrics.dividerThickness)pt divider"
        )
        require(
            abs(metrics.reportPane.minY - metrics.sidebarPane.minY)
                <= tolerance
                && abs(metrics.reportPane.maxY - metrics.sidebarPane.maxY)
                <= tolerance,
            "sidebar \(rect(metrics.sidebarPane)) and report "
                + "\(rect(metrics.reportPane)) do not share a vertical span"
        )

        // 4. WebKit tracks the split pane it was given, inset by whatever the
        // system reserves for the title bar so the report is never underneath
        // the toolbar. A blank or mis-sized dashboard is what this catches.
        require(
            abs(metrics.webView.minX - metrics.reportPane.minX) <= tolerance
                && abs(metrics.webView.width - metrics.reportPane.width)
                <= tolerance
                && abs(metrics.webView.minY - metrics.reportPane.minY)
                <= tolerance,
            "web pane \(rect(metrics.webView)) does not track the report pane "
                + "\(rect(metrics.reportPane))"
        )
        require(
            abs(
                metrics.webView.maxY
                    - (metrics.reportPane.maxY - metrics.reportSafeArea.top)
            ) <= tolerance,
            "web pane top \(Int(metrics.webView.maxY)) does not honour the "
                + "\(Int(metrics.reportSafeArea.top))pt title bar inset of the "
                + "report pane \(rect(metrics.reportPane))"
        )
        require(
            metrics.webView.maxY <= titleBar.maxY + tolerance,
            "web pane top \(Int(metrics.webView.maxY)) is above the title "
                + "bar's content rect \(Int(titleBar.maxY)), so the report is "
                + "hidden under the toolbar"
        )
        require(
            metrics.webView.width >= 400 && metrics.webView.height >= 300,
            "web pane \(rect(metrics.webView)) is too small to render a report"
        )

        // 5. Making the content full size moves the launcher surface too. Its
        // status text must still start below the toolbar rather than sliding
        // underneath it.
        let launcher = content.convert(
            launcherColumn.bounds,
            from: launcherColumn
        )
        require(
            launcher.maxY <= titleBar.maxY + tolerance,
            "launcher column top \(Int(launcher.maxY)) is above the title "
                + "bar's content rect \(Int(titleBar.maxY))"
        )

        // 6. The unified toolbar and the three items it carries.
        let toolbarItems = window.toolbar?.items.map(\.itemIdentifier) ?? []
        for expected in [
            AppDelegate.toolbarStatusRefreshIdentifier,
            AppDelegate.toolbarShareIdentifier,
            AppDelegate.toolbarSettingsIdentifier,
        ] where !toolbarItems.contains(expected) {
            failures.append(
                "[\(label)] toolbar is missing \(expected.rawValue)"
            )
        }

        // 7. The vibrancy treatment the owner picked.
        require(
            metrics.sidebarMaterial == .sidebar,
            "sidebar material is \(metrics.sidebarMaterial.rawValue)"
        )
        require(
            metrics.sidebarBlending == .behindWindow,
            "sidebar blending is \(metrics.sidebarBlending.rawValue)"
        )
        require(
            metrics.sidebarState == .followsWindowActiveState,
            "sidebar vibrancy state is \(metrics.sidebarState.rawValue), not "
                + "followsWindowActiveState"
        )
        return metrics
    }

    private static func rect(_ value: NSRect) -> String {
        "(\(Int(value.minX)),\(Int(value.minY)) "
            + "\(Int(value.width))x\(Int(value.height)))"
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
        if arguments.contains("--jitless-smoke-test") {
            exit(SmokeTest.run(nodeRuntimeModeOverride: .jitless))
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
        if arguments.contains("--native-refresh-settings-contract-smoke-test") {
            exit(NativeRefreshSettingsContractSmokeTest.run())
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
        if arguments.contains("--native-settings-layout-smoke-test") {
            exit(NativeSettingsLayoutSmokeTest.run())
        }
        if arguments.contains("--native-dashboard-chrome-smoke-test") {
            exit(NativeDashboardChromeLayoutSmokeTest.run())
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
