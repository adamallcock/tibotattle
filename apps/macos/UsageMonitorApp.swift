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

    private static func requiredBool(_ key: String) -> Bool {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: key
        ) as? Bool else {
            fatalError("Missing or invalid bundled product setting: \(key)")
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
    static let bundleIdentifier = requiredString("CFBundleIdentifier")
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
    static let buildChannel = requiredString("UsageMonitorBuildChannel")
    static let releaseChannel = requiredString("UsageMonitorReleaseChannel")
    static let isPreviewDistribution =
        requiredBool("UsageMonitorPreviewDistribution")
    static let updaterEnabled = requiredBool("UsageMonitorUpdaterEnabled")
    private static let keychainIdentity: (namespace: String, account: String) = {
        let namespace = requiredString("UsageMonitorKeychainNamespace")
        let account = requiredString("UsageMonitorKeychainAccount")
        let expected: (namespace: String, account: String)
        switch bundleIdentifier {
        case "com.usagemonitor.local":
            expected = ("app-usagemonitor", "installation")
        case "com.usagemonitor.local.preview":
            expected = ("app-usagemonitor.preview", "preview-installation")
        default:
            fatalError("Invalid bundled product Keychain identity")
        }
        guard namespace == expected.namespace,
              account == expected.account
        else {
            fatalError("Invalid bundled product Keychain identity")
        }
        return expected
    }()
    static let keychainNamespace = keychainIdentity.namespace
    static let keychainAccount = keychainIdentity.account
    static let monitoredAppDisplayName =
        requiredString("UsageMonitorMonitoredAppDisplayName")
    static let monitoredAppBundleIdentifier =
        requiredString("UsageMonitorMonitoredAppBundleIdentifier")
    static let nodeRuntimeMode = requiredString("UsageMonitorNodeRuntimeMode")
    static let publicWebsiteOrigin =
        requiredHTTPSOrigin("UsageMonitorPublicWebsiteOrigin")

    /// Bundle signatures seal Info.plist, but launch still treats the plist as
    /// an input rather than allowing individually well-formed settings to be
    /// recombined into an unreviewed runtime. In particular, a Preview bundle
    /// must never select stable state, semantic-open registration, Keychain
    /// items, or updater behavior.
    private static let runtimeIdentityValidated: Void = {
        let expectedIdentity: (
            displayName: String,
            bundleName: String,
            appOpenScheme: String,
            appOpenHost: String,
            appOpenURL: String,
            stateDirectoryName: String,
            keychainNamespace: String,
            keychainAccount: String
        )
        switch bundleIdentifier {
        case "com.usagemonitor.local":
            expectedIdentity = (
                "TiboTattle",
                "TiboTattle.app",
                "usagemonitor",
                "open",
                "usagemonitor://open",
                "Usage Monitor",
                "app-usagemonitor",
                "installation"
            )
        case "com.usagemonitor.local.preview":
            expectedIdentity = (
                "TiboTattle Preview",
                "TiboTattle Preview.app",
                "usagemonitor-preview",
                "open",
                "usagemonitor-preview://open",
                "Usage Monitor Preview",
                "app-usagemonitor.preview",
                "preview-installation"
            )
        default:
            fatalError("Invalid bundled runtime identity")
        }

        guard displayName == expectedIdentity.displayName,
              bundleName == expectedIdentity.bundleName,
              appOpenScheme == expectedIdentity.appOpenScheme,
              appOpenHost == expectedIdentity.appOpenHost,
              appOpenURL == expectedIdentity.appOpenURL,
              stateDirectoryName == expectedIdentity.stateDirectoryName,
              keychainNamespace == expectedIdentity.keychainNamespace,
              keychainAccount == expectedIdentity.keychainAccount
        else {
            fatalError("Invalid bundled runtime identity")
        }
        validateSemanticOpenRegistration()

        switch (
            bundleIdentifier,
            buildChannel,
            releaseChannel,
            isPreviewDistribution
        ) {
        case (
            "com.usagemonitor.local",
            "development",
            "development",
            false
        ):
            validateDevelopmentUpdaterPolicy()
        case (
            "com.usagemonitor.local",
            "production",
            "stable",
            false
        ):
            validateDistributionUpdaterPolicy(
                expectedAppcastURL:
                    "https://updates.tibotattle.com/appcast.xml",
                requiredAppcastPath: "/appcast.xml",
                automaticUpdates: true
            )
        case (
            "com.usagemonitor.local",
            "internal-dogfood",
            "internal-dogfood",
            false
        ):
            validateDistributionUpdaterPolicy(
                expectedAppcastURL:
                    "https://dogfood-updates.tibotattle.com/"
                    + "internal-dogfood/appcast.xml",
                requiredAppcastPath: "/internal-dogfood/appcast.xml",
                automaticUpdates: true
            )
        case (
            "com.usagemonitor.local.preview",
            "preview_distribution",
            "preview_distribution",
            true
        ):
            // Preview may target another deliberately reviewed deployment,
            // so its host is not compiled in. Its canonical feed path and
            // manual-only behavior remain an invariant of the bundle ID.
            validateDistributionUpdaterPolicy(
                expectedAppcastURL: nil,
                requiredAppcastPath: "/preview/appcast.xml",
                automaticUpdates: false
            )
        default:
            fatalError("Invalid bundled runtime identity")
        }
    }()

    private static func validateSemanticOpenRegistration() {
        guard let urlTypes = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleURLTypes"
        ) as? [[String: Any]],
              urlTypes.count == 1,
              let urlType = urlTypes.first,
              Set(urlType.keys) == Set([
                  "CFBundleTypeRole",
                  "CFBundleURLName",
                  "CFBundleURLSchemes",
              ]),
              urlType["CFBundleTypeRole"] as? String == "Viewer",
              urlType["CFBundleURLName"] as? String
                == "\(bundleIdentifier).\(appOpenHost)",
              let registeredSchemes =
                urlType["CFBundleURLSchemes"] as? [String],
              registeredSchemes == [appOpenScheme]
        else {
            fatalError("Invalid bundled runtime identity")
        }
    }

    private static func validateDevelopmentUpdaterPolicy() {
        guard !updaterEnabled else {
            fatalError("Invalid bundled runtime identity")
        }
        for key in [
            "SUEnableAutomaticChecks",
            "SUAllowsAutomaticUpdates",
            "SUAutomaticallyUpdate",
            "SUFeedURL",
            "SUPublicEDKey",
            "SURequireSignedFeed",
            "SUVerifyUpdateBeforeExtraction",
            "UsageMonitorUpdaterFrameworkVersion",
        ] where Bundle.main.object(forInfoDictionaryKey: key) != nil {
            fatalError("Invalid bundled runtime identity")
        }
    }

    private static func validateDistributionUpdaterPolicy(
        expectedAppcastURL: String?,
        requiredAppcastPath: String,
        automaticUpdates: Bool
    ) {
        guard updaterEnabled,
              requiredBool("SUEnableAutomaticChecks") == automaticUpdates,
              requiredBool("SUAllowsAutomaticUpdates") == automaticUpdates,
              requiredBool("SUAutomaticallyUpdate") == automaticUpdates,
              requiredBool("SURequireSignedFeed"),
              requiredBool("SUVerifyUpdateBeforeExtraction"),
              requiredString("UsageMonitorUpdaterFrameworkVersion") == "2.9.3"
        else {
            fatalError("Invalid bundled runtime identity")
        }

        let appcast = requiredString("SUFeedURL")
        guard let components = URLComponents(string: appcast),
              components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(),
              !host.isEmpty,
              !["127.0.0.1", "localhost", "::1"].contains(host),
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath == requiredAppcastPath,
              components.query == nil,
              components.fragment == nil,
              components.url?.absoluteString == appcast,
              expectedAppcastURL == nil || appcast == expectedAppcastURL
        else {
            fatalError("Invalid bundled runtime identity")
        }

        let publicKey = requiredString("SUPublicEDKey")
        guard let publicKeyBytes = Data(base64Encoded: publicKey),
              publicKeyBytes.count == 32,
              publicKeyBytes.base64EncodedString() == publicKey
        else {
            fatalError("Invalid bundled runtime identity")
        }
    }

    static func validateRuntimeIdentity() {
        _ = runtimeIdentityValidated
    }
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
        // Deliberately carries NO --max-old-space-size. This builder feeds only
        // long-lived or trivial entrypoints — the resident companion
        // (apps/local/server.js) and the keychain-reset helper — and neither
        // performs an accounting rebuild: since the rebuild moved into a
        // short-lived child, the companion only ever spawns it, and that child
        // is launched by Node with its own explicit cap
        // (ACCOUNTING_REBUILD_CHILD_OLD_SPACE_MIB in
        // src/replay-safe-accounting-cache.js). A flag set here could not reach
        // it in any case: the child is spawned, not forked, so it does not
        // inherit execArgv, and its environment is stripped of NODE_OPTIONS by
        // construction. Raising the companion's heap would only enlarge the
        // resident menu-bar process, which is the opposite of what moving the
        // rebuild out of it was for.
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
    let skippedSourceCount: Int
    let skippedThreadCount: Int
    let partialTerminal: Bool

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
    let failureCode: String?

    var suppressesAutomaticRetry: Bool {
        guard let failureCode else { return false }
        return LocalCompanionEvidenceReader.rolloutIntegrityFailureCodes
            .contains(failureCode)
    }
}

private enum NativeRefreshTerminalObservation: Equatable {
    case failed(step: String?, code: String?)
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

    static func historyPartial(skippedSourceCount: Int) -> String {
        let sourceNoun = skippedSourceCount == 1 ? "source" : "sources"
        return "History coverage · \(skippedSourceCount) \(sourceNoun) unavailable"
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
    static let rolloutIntegrityFailureCodes: Set<String> = [
        "codex_rollout_compression_unsupported",
        "codex_rollout_filename_identity_mismatch",
        "codex_rollout_generation_ambiguous",
        "codex_rollout_lineage_invalid",
        "codex_rollout_content_invalid",
        "codex_rollout_tail_incomplete",
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
        let skippedSources = (history["skippedSourceCount"] as? NSNumber)?
            .intValue ?? 0
        let skippedThreads = (history["skippedThreadCount"] as? NSNumber)?
            .intValue ?? 0
        return .indexing(NativeHistoryIndexingCoverage(
            indexedSourceCount: indexed,
            sourceCount: total,
            skippedSourceCount: max(0, skippedSources),
            skippedThreadCount: max(0, skippedThreads),
            partialTerminal: history["phase"] as? String
                == "partial_terminal"
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
        guard ["failed", "degraded"].contains(status) else {
            return .notFailed
        }
        let step = refresh["failedStep"] as? String
        let rawCode = refresh["failureCode"] as? String
        return .failed(
            step: step.flatMap {
                Self.refreshFailureSteps.contains($0) ? $0 : nil
            },
            code: rawCode.flatMap {
                Self.rolloutIntegrityFailureCodes.contains($0) ? $0 : nil
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

/// One persisted appearance choice owns both AppKit and the embedded report.
/// `system` stores an explicit preference, but leaves `NSApp.appearance` nil so
/// scheduled and user-driven macOS appearance changes continue to flow
/// through without the app guessing at the system setting.
private enum NativeAppearancePreference: String, CaseIterable {
    case system
    case light
    case dark

    static let defaultsKey = "tibotattle.appearance.v1"

    static var current: NativeAppearancePreference {
        current(in: .standard)
    }

    static func current(
        in defaults: UserDefaults
    ) -> NativeAppearancePreference {
        guard let rawValue = defaults.string(forKey: defaultsKey),
              let preference = NativeAppearancePreference(rawValue: rawValue)
        else {
            return .system
        }
        return preference
    }

    static func set(
        _ preference: NativeAppearancePreference,
        in defaults: UserDefaults = .standard
    ) {
        defaults.set(preference.rawValue, forKey: defaultsKey)
    }

    var applicationAppearance: NSAppearance? {
        switch self {
        case .system:
            nil
        case .light:
            NSAppearance(named: .aqua)
        case .dark:
            NSAppearance(named: .darkAqua)
        }
    }

    func resolvedTheme(for systemAppearance: NSAppearance) -> String {
        switch self {
        case .light:
            return "light"
        case .dark:
            return "dark"
        case .system:
            return systemAppearance.bestMatch(from: [.darkAqua, .aqua])
                == .darkAqua
                ? "dark"
                : "light"
        }
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

/// Detailed accounting is deliberately attempt-based and rate-limited across
/// launches. Recording before a request starts prevents a failed, cancelled,
/// or interrupted pass from becoming a tight automatic retry loop. A missing
/// or malformed value is seeded with `now`, making the first launch pass quick.
enum NativeDetailedRefreshCadence {
    static let defaultsKey = "tibotattle.detailed-refresh-last-attempt.v1"
    static let reservationKey = "tibotattle.detailed-refresh-reservation.v1"
    static let minimumInterval: TimeInterval = 60 * 60

    struct Reservation {
        let stampedAt: Double
        let token: String
        let previousAttempt: Double?
        let previousToken: String?
    }

    static func automaticMode(
        now: Date = Date(),
        defaults: UserDefaults = .standard
    ) -> LocalAnalysisMode {
        let nowInterval = now.timeIntervalSince1970
        guard nowInterval.isFinite, nowInterval >= 0 else { return .quick }
        guard let stored = defaults.object(forKey: defaultsKey) as? NSNumber,
              stored.doubleValue.isFinite,
              stored.doubleValue >= 0,
              stored.doubleValue <= nowInterval
        else {
            defaults.set(nowInterval, forKey: defaultsKey)
            return .quick
        }
        guard nowInterval - stored.doubleValue >= minimumInterval else {
            return .quick
        }
        return .detailed
    }

    static func seedIfMissing(
        now: Date = Date(),
        defaults: UserDefaults = .standard
    ) {
        guard defaults.object(forKey: defaultsKey) == nil else { return }
        recordDetailedAttempt(now: now, defaults: defaults)
    }

    @discardableResult
    static func recordDetailedAttempt(
        now: Date = Date(),
        defaults: UserDefaults = .standard
    ) -> Reservation? {
        let value = now.timeIntervalSince1970
        guard value.isFinite, value >= 0 else { return nil }
        let reservation = Reservation(
            stampedAt: value,
            token: UUID().uuidString,
            previousAttempt: (defaults.object(forKey: defaultsKey) as? NSNumber)
                .map(\.doubleValue),
            previousToken: defaults.string(forKey: reservationKey)
        )
        defaults.set(value, forKey: defaultsKey)
        defaults.set(reservation.token, forKey: reservationKey)
        return reservation
    }

    /// Only a confirmed conflict with a quick run proves that this detailed
    /// request did no work. Unknown/rejected/interrupted responses retain the
    /// optimistic stamp. Compare the token as well as time so a later attempt
    /// at the same timestamp cannot be rolled back by an old callback.
    static func restoreAfterQuickJoin(
        _ reservation: Reservation?,
        attempt: LocalAnalysisAttempt?,
        defaults: UserDefaults = .standard
    ) {
        guard attempt?.mode == .quick, let reservation,
              defaults.double(forKey: defaultsKey) == reservation.stampedAt,
              defaults.string(forKey: reservationKey) == reservation.token
        else { return }
        if let previous = reservation.previousAttempt {
            defaults.set(previous, forKey: defaultsKey)
        } else {
            defaults.removeObject(forKey: defaultsKey)
        }
        if let previousToken = reservation.previousToken {
            defaults.set(previousToken, forKey: reservationKey)
        } else {
            defaults.removeObject(forKey: reservationKey)
        }
    }

    /// Every native reader observes the same controller receipt, including
    /// browser-started runs and terminal failures. Record its actual start
    /// once, never `now` on every poll and never move a newer attempt backward.
    static func observe(
        _ attempt: LocalAnalysisAttempt?,
        now: Date = Date(),
        defaults: UserDefaults = .standard
    ) {
        guard let attempt, attempt.mode == .detailed else { return }
        let started = attempt.startedAt.timeIntervalSince1970
        let current = now.timeIntervalSince1970
        guard started.isFinite, started >= 0,
              current.isFinite, started <= current
        else { return }
        if let stored = defaults.object(forKey: defaultsKey) as? NSNumber,
           stored.doubleValue.isFinite, stored.doubleValue >= started {
            return
        }
        recordDetailedAttempt(now: attempt.startedAt, defaults: defaults)
    }
}

/// A GET issued before a POST reply may still describe the previous idle
/// controller. Its terminal result cannot settle the new request, even if
/// that GET callback arrives after the POST's 202 callback.
private struct NativeRefreshStartFence {
    struct Observation {
        let generation: UInt64
        let startResolved: Bool
    }

    private var generation: UInt64 = 0
    private var awaitingResponse = false

    mutating func begin() {
        generation &+= 1
        awaitingResponse = true
    }

    mutating func resolve() {
        generation &+= 1
        awaitingResponse = false
    }

    func observation() -> Observation {
        Observation(generation: generation, startResolved: !awaitingResponse)
    }

    func allowsTerminal(_ observation: Observation) -> Bool {
        !awaitingResponse && observation.startResolved
            && observation.generation == generation
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
        BundledProduct.updaterEnabled
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
        BundledProduct.isPreviewDistribution
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
        !Self.isPreviewDistribution
            && controller?.updater.allowsAutomaticUpdates == true
    }

    var automaticUpdatesEnabled: Bool {
        !Self.isPreviewDistribution
            && controller?.updater.automaticallyDownloadsUpdates == true
    }

    /// Automatic-update controls remain disabled until the endpoint and the
    /// latest check both have a truthful state, and until this build's sealed
    /// Sparkle policy actually permits the preference. This prevents preview
    /// builds from presenting a switch whose setter must refuse the change.
    var canConfigureAutomaticUpdates: Bool {
        guard isAvailable,
              feedIsReachable,
              allowsAutomaticUpdateOptIn
        else { return false }
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
        if isAvailable && !allowsAutomaticUpdateOptIn {
            return Self.isPreviewDistribution
                ? TiboTattleLocalization.string(
                    .settingsUpdateDisclosurePreview
                )
                : TiboTattleLocalization.string(
                    .settingsAutomaticUpdatesUnavailable
                )
        }
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
                showUpdateFailureAlert(
                    messageKey: .launcherUpdateUnavailable,
                    informativeTextKey: .settingsAutomaticUpdatesUnavailable
                )
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
                        self.showUpdateFailureAlert(
                            messageKey: .settingsUpdateCheckUnavailableTitle,
                            informativeTextKey: .settingsUpdateCheckUnavailableMessage
                        )
                    }
                    return
                }
                self.feedIsReachable = true
                onReachable()
            }
        }.resume()
    }

    private func showUpdateFailureAlert(
        messageKey: TiboTattleLocalization.Key,
        informativeTextKey: TiboTattleLocalization.Key
    ) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = TiboTattleLocalization.string(messageKey)
        alert.informativeText = TiboTattleLocalization.string(informativeTextKey)
        alert.addButton(withTitle: TiboTattleLocalization.string(.launcherRetry))
        alert.addButton(withTitle: TiboTattleLocalization.string(.commonCancel))
        if alert.runModal() == .alertFirstButtonReturn {
            checkForUpdates(nil)
        }
    }

    func setAutomaticUpdatesEnabled(_ enabled: Bool) {
        guard !Self.isPreviewDistribution,
              let updater = controller?.updater,
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
    case dashboardContentProcessTerminated
    case dashboardDownloadFailed
    case dashboardNavigationFailed
    case dashboardReadinessTimeout
    case dashboardViewportUnavailable
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
        case .dashboardContentProcessTerminated:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardContentProcessTerminated
            )
        case .dashboardDownloadFailed:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardDownloadFailed
            )
        case .dashboardNavigationFailed:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardNavigationFailed
            )
        case .dashboardReadinessTimeout:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardReadinessTimeout
            )
        case .dashboardViewportUnavailable:
            return TiboTattleLocalization.string(
                .launcherErrorDashboardViewportUnavailable
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
        case .dashboardContentProcessTerminated:
            return "UM_MACOS_DASHBOARD_WEB_PROCESS_TERMINATED"
        case .dashboardDownloadFailed:
            return "UM_MACOS_DASHBOARD_DOWNLOAD_FAILED"
        case .dashboardNavigationFailed:
            return "UM_MACOS_DASHBOARD_NAVIGATION_FAILED"
        case .dashboardReadinessTimeout:
            return "UM_MACOS_DASHBOARD_READY_TIMEOUT"
        case .dashboardViewportUnavailable:
            return "UM_MACOS_DASHBOARD_VIEWPORT_UNAVAILABLE"
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
        case .dashboardContentProcessTerminated, .dashboardNavigationFailed,
             .dashboardReadinessTimeout, .dashboardViewportUnavailable,
             .dashboardWebViewUnavailable:
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
    private static let activeInstanceErrorCodes: Set<String> = [
        "automatic_contribution_instance_active",
        "automatic_contribution_retirement_instance_active",
    ]
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
    private var terminationInProgress = false
    private var terminationComplete = false
    // A caller may detach the companion immediately after requesting stop.
    // Keep it alive through OS exit and the broker's asynchronous writer barrier.
    private var stopRetention: CompanionProcess?
    private let nodeRuntimeModeOverride: BundledNodeRuntimeMode?
    private let onMigrationStatus: (KeychainMigrationStatus) -> Void
    private let onExit: (Bool, Bool) -> Void
    private let onReady: (URL) -> Void

    init(
        centralService: CentralServiceConfiguration?,
        codexHome: URL,
        nodeRuntimeModeOverride: BundledNodeRuntimeMode? = nil,
        onMigrationStatus: @escaping (KeychainMigrationStatus) -> Void = { _ in },
        onReady: @escaping (URL) -> Void,
        onExit: @escaping (Bool, Bool) -> Void
    ) {
        self.centralService = centralService
        self.codexHome = codexHome
        self.nodeRuntimeModeOverride = nodeRuntimeModeOverride
        self.onMigrationStatus = onMigrationStatus
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

    /// Only the native confirmation action reaches this seam. There is no
    /// matching companion message, URL, or web-view operation for approval.
    func approvePendingMigrations(completion: @escaping (Bool) -> Void) {
        lock.lock()
        let broker = keychainBroker
        let canApprove = !stopped && process?.isRunning == true
        lock.unlock()
        guard canApprove, let broker else {
            DispatchQueue.main.async { completion(false) }
            return
        }
        broker.approvePendingMigrations(completion: completion)
    }

    func launch(
        makeBroker: () throws -> ContributionDeviceKeychainBroker = {
            try ContributionDeviceKeychainBroker(
                namespace: BundledProduct.keychainNamespace,
                account: BundledProduct.keychainAccount
            )
        }
    ) throws {
        // Require the private channel before resource access or child creation.
        // The factory seam lets the native contract probe reject setup failures
        // without exhausting descriptors or touching real credentials.
        let broker: ContributionDeviceKeychainBroker
        do {
            broker = try makeBroker()
        } catch {
            throw LauncherError.companionLaunch("keychain")
        }
        var brokerOwnedByCompanion = false
        defer {
            if !brokerOwnedByCompanion { broker.shutdown() }
        }
        guard let childEndpoint = broker.childEndpoint else {
            throw LauncherError.companionLaunch("keychain")
        }
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
        // Every native credential operation uses the app's private broker.
        // The environment names only the descriptor; the socketpair is the
        // authority, so no token or secret crosses argv or the environment.
        broker.setMigrationStatusObserver(onMigrationStatus)
        child.standardInput = childEndpoint
        child.standardOutput = standardOutput
        child.standardError = standardError

        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [
            "HOME": homeDirectory.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "production",
            "USAGE_MONITOR_PARENT_PID": String(getpid()),
            "USAGE_MONITOR_PORT": "0",
            "USAGE_MONITOR_APP_OPEN_URL": BundledProduct.appOpenURL,
            "USAGE_MONITOR_KEYCHAIN_NAMESPACE":
                BundledProduct.keychainNamespace,
            "USAGE_MONITOR_KEYCHAIN_ACCOUNT": BundledProduct.keychainAccount,
            "USAGE_MONITOR_RESOURCE_ROOT": resources.resourceRoot.path,
            "USAGE_MONITOR_STATE_ROOT": stateRoot.path,
            "CODEX_HOME": codexHome.path,
        ]
        environment[
            ContributionDeviceKeychainBroker.environmentVariable
        ] = "0"
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
        guard !stopped, process == nil, !terminationInProgress, !terminationComplete else {
            lock.unlock()
            throw LauncherError.companionLaunch("stopped")
        }
        process = child
        keychainBroker = broker
        brokerOwnedByCompanion = true
        pendingOutput = ""
        pendingStandardError = ""
        activeInstanceDetected = false
        do {
            // Keep stop from observing an assigned but not-yet-started child.
            // This is process creation only; no shutdown/Keychain wait is on main.
            try child.run()
            lock.unlock()
        } catch {
            lock.unlock()
            standardOutput.fileHandleForReading.readabilityHandler = nil
            standardError.fileHandleForReading.readabilityHandler = nil
            didTerminate(success: false, notifyExit: false)
            throw LauncherError.companionLaunch("run")
        }
        // The child holds its dup2'd copy; dropping ours is what turns a
        // companion exit into end-of-file on the broker channel.
        broker.closeChildEndpoint()
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
        let diagnosticTokens = pendingStandardError.split { character in
            !character.isLetter && !character.isNumber && character != "_"
        }
        if diagnosticTokens.contains(where: {
            Self.activeInstanceErrorCodes.contains(String($0))
        }) {
            activeInstanceDetected = true
        }
        lock.unlock()
    }

    private func didTerminate(success: Bool, notifyExit: Bool = true) {
        lock.lock()
        guard !terminationInProgress, !terminationComplete else {
            lock.unlock()
            return
        }
        terminationInProgress = true
        process = nil
        let broker = keychainBroker
        keychainBroker = nil
        let anotherInstanceIsActive = activeInstanceDetected
        lock.unlock()
        let finish = { [self] in
            finishTermination(
                success: success,
                notifyExit: notifyExit,
                anotherInstanceIsActive: anotherInstanceIsActive
            )
        }
        if let broker {
            broker.shutdown(completion: finish)
        } else {
            finish()
        }
    }

    private func finishTermination(
        success: Bool,
        notifyExit: Bool,
        anotherInstanceIsActive: Bool
    ) {
        lock.lock()
        guard terminationInProgress, !terminationComplete else {
            lock.unlock()
            return
        }
        terminationInProgress = false
        terminationComplete = true
        let completions = stopCompletions
        stopCompletions.removeAll()
        let wasStopped = stopped
        stopRetention = nil
        lock.unlock()
        for completion in completions {
            completion()
        }
        if notifyExit {
            onExit(success && wasStopped, anotherInstanceIsActive)
        }
    }

    func stop(completion: @escaping () -> Void) {
        lock.lock()
        let firstStop = !stopped
        stopped = true
        if terminationComplete {
            lock.unlock()
            completion()
            return
        }
        stopCompletions.append(completion)
        stopRetention = self
        guard !terminationInProgress else {
            lock.unlock()
            return
        }
        guard let child = process else {
            lock.unlock()
            didTerminate(success: true, notifyExit: false)
            return
        }
        let shouldTerminate = firstStop && child.isRunning
        lock.unlock()
        // A stopped child may still have its Foundation termination handler
        // pending. That handler and the broker barrier own the completions.
        guard shouldTerminate else { return }
        child.terminate()

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

    /// Deterministic pre-spawn failures through the real launch entrypoint.
    /// A newly created broker has an endpoint; closing that endpoint models
    /// the other setup failure without exhausting process-wide descriptors.
    static func verifyKeychainLaunchContract() -> Bool {
        enum Failure: CaseIterable { case construction, missingEndpoint }
        for failure in Failure.allCases {
            var factoryCalls = 0
            var healthyEndpointObserved = false
            var readyCalls = 0
            var exitCalls = 0
            let companion = CompanionProcess(
                centralService: nil,
                codexHome: URL(fileURLWithPath: "/synthetic-home-not-opened"),
                onReady: { _ in readyCalls += 1 },
                onExit: { _, _ in exitCalls += 1 }
            )
            do {
                try companion.launch(makeBroker: {
                    factoryCalls += 1
                    if failure == .construction {
                        throw ContributionDeviceKeychainBrokerUnavailable()
                    }
                    let broker = try ContributionDeviceKeychainBroker(
                        namespace: BundledProduct.keychainNamespace,
                        account: BundledProduct.keychainAccount
                    )
                    healthyEndpointObserved = broker.childEndpoint != nil
                    broker.closeChildEndpoint()
                    return broker
                })
                return false
            } catch LauncherError.companionLaunch(let reason) {
                guard reason == "keychain", factoryCalls == 1,
                      failure == .construction || healthyEndpointObserved,
                      companion.process == nil, companion.keychainBroker == nil,
                      !companion.isRunning, companion.processIdentifier == nil,
                      readyCalls == 0, exitCalls == 0
                else { return false }
            } catch {
                return false
            }
            var stoppedCalls = 0
            companion.stop { stoppedCalls += 1 }
            companion.stop { stoppedCalls += 1 }
            guard stoppedCalls == 2, readyCalls == 0, exitCalls == 0 else { return false }
        }
        return true
    }

    /// Memory-only composition probe: use the actual stop and termination
    /// methods with an injected broker, never launch a companion or reset helper.
    static func verifyKeychainShutdownContract() -> Bool {
        enum Phase: CaseIterable { case alreadyAbsent, handlerPending, brokerDraining }
        for phase in Phase.allCases {
            let resultLock = NSLock()
            var callbackCount = 0
            var exitCount = 0
            weak var retainedCompanion: CompanionProcess?
            let passed = ContributionDeviceKeychainBroker.verifyExternalResetOrder { broker, reset in
                let companion = CompanionProcess(
                    centralService: nil,
                    codexHome: URL(fileURLWithPath: "/synthetic-home-not-opened"),
                    onReady: { _ in },
                    onExit: { _, _ in
                        resultLock.lock(); exitCount += 1; resultLock.unlock()
                    }
                )
                retainedCompanion = companion
                companion.keychainBroker = broker
                if phase == .handlerPending {
                    // A non-running Process models the interval before the
                    // real Foundation termination handler has been delivered.
                    companion.process = Process()
                } else if phase == .brokerDraining {
                    companion.didTerminate(success: true)
                }
                companion.stop {
                    resultLock.lock(); callbackCount += 1; resultLock.unlock()
                    reset()
                }
                companion.stop {
                    resultLock.lock(); callbackCount += 1; resultLock.unlock()
                }
                if phase == .handlerPending { companion.didTerminate(success: true) }
                // Drop the caller's reference while the broker is paused.
                // Pending termination must retain it only through the barrier.
            }
            resultLock.lock()
            let completedOnce = callbackCount == 2
                && exitCount == (phase == .alreadyAbsent ? 0 : 1)
            resultLock.unlock()
            guard passed, completedOnce, retainedCompanion == nil else { return false }
        }
        let idle = CompanionProcess(
            centralService: nil,
            codexHome: URL(fileURLWithPath: "/synthetic-home-not-opened"),
            onReady: { _ in }, onExit: { _, _ in }
        )
        var completedCount = 0
        idle.stop { completedCount += 1 }
        idle.stop { completedCount += 1 }
        return completedCount == 2
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

/// A local dashboard click may open one Codex thread, never an arbitrary
/// custom-scheme operation. No identifier is logged or persisted by the shell.
private enum CodexThreadOpenTarget {
    static func accepts(_ url: URL) -> Bool {
        guard url.absoluteString.range(
            of: "^codex://threads/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: .regularExpression
        ) != nil,
              let parts = URLComponents(
            url: url, resolvingAgainstBaseURL: false
        ),
              parts.scheme == "codex",
              parts.host == "threads",
              parts.user == nil,
              parts.password == nil,
              parts.port == nil,
              parts.query == nil,
              parts.fragment == nil,
              parts.path.hasPrefix("/"),
              let identifier = UUID(uuidString: String(parts.path.dropFirst()))
        else {
            return false
        }
        // Also reject encodings, empty ports/query/fragment, extra path
        // components, and other URL normalizations at the original boundary.
        return url.absoluteString
            == "codex://threads/\(identifier.uuidString.lowercased())"
    }

    static func acceptsNavigation(
        to url: URL,
        userActivated: Bool,
        sourceIsMainFrame: Bool,
        sourceURL: URL?,
        sourceOrigin: (scheme: String, host: String, port: Int),
        companionPort: Int?
    ) -> Bool {
        guard accepts(url), userActivated, sourceIsMainFrame,
              let sourceURL, let companionPort
        else {
            return false
        }
        return sourceURL.scheme == "http"
            && sourceURL.host == loopbackHost
            && sourceURL.port == companionPort
            && sourceURL.user == nil
            && sourceURL.password == nil
            && sourceOrigin.scheme == "http"
            && sourceOrigin.host == loopbackHost
            && sourceOrigin.port == companionPort
    }
}

/// Removes browser commands that do not belong in TiboTattle's single-page
/// dashboard while preserving useful page commands such as Reload, Copy, and
/// Open Link. WKWebView does not expose a public context-menu delegate on
/// macOS, but it does identify the NSMenuItems it supplies. Filtering those
/// identifiers here avoids localized-title matching and leaves the rest of
/// WebKit's menu behavior intact.
@MainActor
private final class NativeDashboardWebView: WKWebView {
    private static let unsupportedContextMenuIdentifiers: Set<
        NSUserInterfaceItemIdentifier
    > = [
        NSUserInterfaceItemIdentifier("WKMenuItemIdentifierGoBack"),
        NSUserInterfaceItemIdentifier("WKMenuItemIdentifierGoForward"),
        NSUserInterfaceItemIdentifier(
            "WKMenuItemIdentifierDownloadLinkedFile"
        ),
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        Self.stripUnsupportedContextMenuItems(from: menu)
    }

    static func stripUnsupportedContextMenuItems(from menu: NSMenu) {
        for item in menu.items {
            guard let identifier = item.identifier,
                  unsupportedContextMenuIdentifiers.contains(identifier)
            else {
                continue
            }
            menu.removeItem(item)
        }
    }
}

/// One document's bounded readiness observation. The monotonic clock and
/// generation are supplied by the host, so delayed JavaScript completions can
/// never ready or fail a replacement document.
private struct NativeDashboardReadiness {
    enum Observation: Equatable {
        case waiting(TimeInterval)
        case takingLonger
        case ready
        case timedOut
        case ignored
    }

    static let slowThreshold: TimeInterval = 20
    static let hardDeadline: TimeInterval = 120
    private(set) var generation: UInt64 = 0
    private var beganAt: TimeInterval?
    private var delayReported = false
    private var finished = false

    @discardableResult
    mutating func invalidate() -> UInt64 {
        generation &+= 1
        beganAt = nil
        delayReported = false
        finished = false
        return generation
    }

    mutating func start(generation expected: UInt64, at now: TimeInterval) -> Bool {
        guard expected == generation, beganAt == nil, now.isFinite else {
            return false
        }
        beganAt = now
        return true
    }

    func isObserving(_ expected: UInt64) -> Bool {
        expected == generation && beganAt != nil && !finished
    }

    mutating func observe(
        generation expected: UInt64,
        at now: TimeInterval,
        ready: Bool
    ) -> Observation {
        guard isObserving(expected), let beganAt, now.isFinite else {
            return .ignored
        }
        let elapsed = max(0, now - beganAt)
        if elapsed >= Self.hardDeadline {
            finished = true
            return .timedOut
        }
        if ready {
            finished = true
            return .ready
        }
        if elapsed >= Self.slowThreshold, !delayReported {
            delayReported = true
            return .takingLonger
        }
        return .waiting(elapsed < Self.slowThreshold ? 0.25 : 1)
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
    private static let codexThreadLinkWorld = WKContentWorld.world(
        name: "TiboTattleTrustedThreadLinks"
    )
    private let onLoaded: () -> Void
    private let onFailure: (LauncherError) -> Void
    private let onReadinessDelay: () -> Void
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
    private var dashboardReadiness = NativeDashboardReadiness()
    private var dashboardContentPoll: DispatchWorkItem?
    private var dashboardContentEvaluationInFlight = false
    private var activeDashboardNavigation: WKNavigation?
    private let navigationGenerations = NSMapTable<WKNavigation, NSNumber>(
        keyOptions: .weakMemory,
        valueOptions: .strongMemory
    )
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
        onFailure: @escaping (LauncherError) -> Void,
        onDownloadFailure: @escaping () -> Void,
        openExternally: @escaping (URL) -> Void,
        onNavigation: @escaping (String) -> Void,
        onLanguagePreferenceChange: @escaping (
            TiboTattleLocalization.LanguagePreference
        ) -> Void,
        onReadinessDelay: @escaping () -> Void = {}
    ) {
        self.onLoaded = onLoaded
        self.onFailure = onFailure
        self.onReadinessDelay = onReadinessDelay
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
        webView = NativeDashboardWebView(
            frame: .zero,
            configuration: configuration
        )
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
        configuration.userContentController.add(
            self,
            contentWorld: Self.codexThreadLinkWorld,
            name: "tibotattleCodexThreadLink"
        )
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
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

    /// Paint the report in the native appearance before its stylesheet gets a
    /// first frame. The preference and its resolved light/dark value are both
    /// handed over: the former is useful context, while the latter is the only
    /// bounded value the page is permitted to render.
    private static func appearanceHandoffScript() -> String {
        let preference = NativeAppearancePreference.current
        let resolvedTheme = preference.resolvedTheme(
            for: NSApp.effectiveAppearance
        )
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "host": "native",
            "preference": preference.rawValue,
            "resolvedTheme": resolvedTheme,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return "window.__TIBOTATTLE_APPEARANCE__ = null;"
        }
        return """
        window.__TIBOTATTLE_APPEARANCE__ = \(json);
        (function () {
          function applyNativeAppearance() {
            const handoff = window.__TIBOTATTLE_APPEARANCE__;
            const theme = handoff?.resolvedTheme;
            if (theme !== 'light' && theme !== 'dark') return;
            if (document.documentElement) {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.colorScheme = theme;
            }
            const themeColor = document.querySelector?.('meta[name="theme-color"]');
            if (themeColor) {
              themeColor.content = theme === 'dark' ? '#141a17' : '#f5f1e8';
            }
          }
          applyNativeAppearance();
          document.addEventListener('DOMContentLoaded', applyNativeAppearance, { once: true });
        })();
        """
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
                source: appearanceHandoffScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
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
        controller.addUserScript(
            WKUserScript(
                source: trustedCodexThreadLinkScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true,
                in: codexThreadLinkWorld
            )
        )
    }

    /// A page cannot forge this handler: both the listener and its message
    /// endpoint live in a non-page content world. Keyboard activation emits a
    /// trusted click too; script-created clicks never open an external app.
    private static func trustedCodexThreadLinkScript() -> String {
        """
        (function () {
          document.addEventListener('click', function (event) {
            if (!event.isTrusted) return;
            const anchor = event.target instanceof Element
              ? event.target.closest('a[href]') : null;
            const href = anchor?.getAttribute('href');
            if (typeof href !== 'string' ||
                !/^codex:\\/\\/threads\\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(href)) return;
            event.preventDefault();
            window.webkit.messageHandlers.tibotattleCodexThreadLink
              .postMessage({ threadId: href.slice('codex://threads/'.length) });
          }, true);
        })();
        """
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
        let generation = invalidateDashboardContentObservation()
        activeDashboardNavigation = nil
        hasDashboardTarget = false
        pendingDashboardURL = nil
        guard url.scheme?.lowercased() == "http",
              url.host == loopbackHost,
              let port = url.port
        else {
            onFailure(.healthCheck)
            return
        }
        allowedPort = port
        hasDashboardTarget = true
        pendingDashboardURL = url
        viewportPreparationAttempts = 0
        loadWhenViewportIsReady(generation: generation)
    }

    /// WKWebView can commit a document before AppKit has given its split pane a
    /// usable size. On a cold launch that produces a loaded, but white,
    /// dashboard until the user manually resizes the window. Defer the first
    /// request for a few main-loop passes until the embedded viewport exists.
    private func loadWhenViewportIsReady(generation: UInt64) {
        guard hasDashboardTarget,
              generation == dashboardReadiness.generation,
              let url = pendingDashboardURL
        else { return }
        webView.superview?.layoutSubtreeIfNeeded()
        webView.layoutSubtreeIfNeeded()
        let viewport = webView.bounds.integral
        guard viewport.width >= 120, viewport.height >= 120 else {
            guard viewportPreparationAttempts < 20 else {
                pendingDashboardURL = nil
                hasDashboardTarget = false
                invalidateDashboardContentObservation()
                onFailure(.dashboardViewportUnavailable)
                return
            }
            viewportPreparationAttempts += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
                [weak self] in
                self?.loadWhenViewportIsReady(generation: generation)
            }
            return
        }
        pendingDashboardURL = nil
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        refreshDocumentStartScripts()
        activeDashboardNavigation = webView.load(request)
        if let navigation = activeDashboardNavigation {
            navigationGenerations.setObject(
                NSNumber(value: generation), forKey: navigation
            )
        }
    }

    func stop() {
        invalidateDashboardContentObservation()
        activeDashboardNavigation = nil
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

    /// Change the live document without reloading it. The native shell has
    /// already applied this appearance to AppKit; the resolved value makes the
    /// report follow the same effective appearance when the stored choice is
    /// `system`.
    func notifyAppearancePreferenceChange(
        _ preference: NativeAppearancePreference
    ) {
        guard hasDashboardTarget else { return }
        // The live event below updates the current document, but WebKit's
        // context-menu Reload creates a new document without passing through
        // loadWhenViewportIsReady(). Refresh the document-start snapshot now
        // so that later manual reload starts in the same resolved appearance
        // instead of replaying whichever theme was current when this host was
        // first constructed.
        refreshDocumentStartScripts()
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "host": "native",
            "preference": preference.rawValue,
            "resolvedTheme": preference.resolvedTheme(
                for: NSApp.effectiveAppearance
            ),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("""
        window.__TIBOTATTLE_APPEARANCE__ = \(json);
        window.dispatchEvent(new CustomEvent('tibotattle:appearance-override', {
          detail: window.__TIBOTATTLE_APPEARANCE__
        }));
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
        if message.name == "tibotattleCodexThreadLink" {
            let frame = message.frameInfo
            let origin = frame.securityOrigin
            guard message.world === Self.codexThreadLinkWorld,
                  payload.count == 1,
                  let threadId = payload["threadId"] as? String,
                  threadId.count == 36,
                  let url = URL(string: "codex://threads/\(threadId)"),
                  CodexThreadOpenTarget.acceptsNavigation(
                    to: url,
                    userActivated: true,
                    sourceIsMainFrame: frame.isMainFrame,
                    sourceURL: frame.request.url,
                    sourceOrigin: (origin.protocol, origin.host, origin.port),
                    companionPort: allowedPort
                  )
            else {
                return
            }
            openExternally(url)
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

    private func openExternalNavigation(
        _ navigationAction: WKNavigationAction,
        url: URL
    ) {
        if url.scheme?.lowercased() == "codex" {
            // WKNavigationType.linkActivated does not attest a trusted user
            // event. Only the isolated click handler may open Codex.
            return
        }
        openExternally(url)
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
        if url.scheme?.lowercased() == "codex" {
            // A Codex target never loads or downloads inside WebKit.
            decisionHandler(.cancel)
            openExternalNavigation(navigationAction, url: url)
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
        openExternalNavigation(navigationAction, url: url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    @discardableResult
    private func invalidateDashboardContentObservation() -> UInt64 {
        dashboardContentPoll?.cancel()
        dashboardContentPoll = nil
        dashboardContentEvaluationInFlight = false
        return dashboardReadiness.invalidate()
    }

    func webView(
        _ webView: WKWebView,
        didStartProvisionalNavigation navigation: WKNavigation!
    ) {
        guard hasDashboardTarget, let navigation else { return }
        if let generation = navigationGenerations.object(forKey: navigation) {
            guard generation.uint64Value == dashboardReadiness.generation else {
                return
            }
        } else {
            // WebKit's own Reload does not pass through load(_:). It still
            // owns a fresh generation and invalidates the prior page's work.
            let generation = invalidateDashboardContentObservation()
            navigationGenerations.setObject(
                NSNumber(value: generation), forKey: navigation
            )
        }
        activeDashboardNavigation = navigation
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard hasDashboardTarget, let navigation,
              navigation === activeDashboardNavigation
        else { return }
        let generation = dashboardReadiness.generation
        guard dashboardReadiness.start(
            generation: generation, at: ProcessInfo.processInfo.systemUptime
        ) else { return }
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
            generation: generation
        )
    }

    /// One bounded heartbeat continues independently of a JavaScript reply.
    /// A hung renderer therefore cannot evade the hard deadline, and at most
    /// one evaluation is in flight. The slow threshold keeps the visible page
    /// and its startup-refresh intent; it is not a terminal failure.
    private func awaitDashboardContent(in webView: WKWebView, generation: UInt64) {
        guard hasDashboardTarget, dashboardReadiness.isObserving(generation) else {
            return
        }
        let observation = dashboardReadiness.observe(
            generation: generation,
            at: ProcessInfo.processInfo.systemUptime,
            ready: false
        )
        let interval: TimeInterval
        switch observation {
        case .waiting(let nextInterval):
            interval = nextInterval
        case .takingLonger:
            onReadinessDelay()
            interval = 1
        case .timedOut:
            finishDashboardContentObservation(ready: false)
            return
        case .ready, .ignored:
            return
        }
        let poll = DispatchWorkItem { [weak self, weak webView] in
            guard let self, let webView,
                  self.dashboardReadiness.isObserving(generation)
            else { return }
            self.dashboardContentPoll = nil
            self.awaitDashboardContent(in: webView, generation: generation)
        }
        dashboardContentPoll = poll
        DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: poll)
        guard !dashboardContentEvaluationInFlight else { return }
        dashboardContentEvaluationInFlight = true
        webView.evaluateJavaScript(
            "document.documentElement?.dataset.localDashboardReady === 'true';"
        ) { [weak self] value, error in
            guard let self, self.hasDashboardTarget,
                  self.dashboardReadiness.isObserving(generation)
            else { return }
            self.dashboardContentEvaluationInFlight = false
            let localDashboardReady = (value as? NSNumber)?.boolValue ?? false
            if error == nil, localDashboardReady {
                let outcome = self.dashboardReadiness.observe(
                    generation: generation,
                    at: ProcessInfo.processInfo.systemUptime,
                    ready: true
                )
                if outcome == .ready {
                    self.finishDashboardContentObservation(ready: true)
                } else if outcome == .timedOut {
                    self.finishDashboardContentObservation(ready: false)
                }
            }
        }
    }

    private func finishDashboardContentObservation(ready: Bool) {
        dashboardContentPoll?.cancel()
        dashboardContentPoll = nil
        dashboardContentEvaluationInFlight = false
        if ready {
            onLoaded()
        } else {
            hasDashboardTarget = false
            onFailure(.dashboardReadinessTimeout)
        }
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error, navigation: navigation)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error, navigation: navigation)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard hasDashboardTarget else { return }
        invalidateDashboardContentObservation()
        activeDashboardNavigation = nil
        hasDashboardTarget = false
        onFailure(.dashboardContentProcessTerminated)
    }

    private func reportNavigationFailure(_ error: Error, navigation: WKNavigation?) {
        // A navigation this delegate cancelled on purpose is not a failure.
        let failure = error as NSError
        guard hasDashboardTarget,
              navigation == nil || navigation === activeDashboardNavigation,
              failure.domain != NSURLErrorDomain
                || failure.code != NSURLErrorCancelled
        else {
            return
        }
        invalidateDashboardContentObservation()
        activeDashboardNavigation = nil
        hasDashboardTarget = false
        onFailure(.dashboardNavigationFailed)
    }

    // MARK: - Window, dialog, and file affordances

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // A provider may request a new browser window. The app never embeds
        // remote origins. Codex links use the same source-frame and gesture
        // policy as same-window links; HTTPS/auth behavior remains unchanged.
        if let url = navigationAction.request.url {
            openExternalNavigation(navigationAction, url: url)
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
    private let webView: WKWebView
    var onAppearanceChange: (() -> Void)?

    override var wantsUpdateLayer: Bool { true }

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NativeBrandPalette.reportPaper.cgColor
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

    /// Match the report's `--paper` token during the gap before WebKit paints
    /// and in the titlebar safe-area strip. Dynamic colors must be re-resolved
    /// here because a CALayer does not track appearance changes on its own.
    override func updateLayer() {
        layer?.backgroundColor = NativeBrandPalette.reportPaper.cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        onAppearanceChange?()
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
    static let splitAutosaveName = "com.usagemonitor.local.dashboard-split.v1"
    /// One-time marker that the resting width has been seeded. After this,
    /// the autosaved divider position is the user's own and is never fought.
    private static let splitSeededDefaultsKey =
        "tibotattle.dashboard-split-seeded.v1"
    /// One-time marker that a sidebar stranded by an older build has been
    /// reopened. See `rescueStrandedSidebar(_:)`.
    static let sidebarRescuedDefaultsKey =
        "tibotattle.dashboard-sidebar-rescued.v1"

    private let sidebar = NSVisualEffectView()
    private let sidebarWash = NativeSidebarBrandWash()
    private let pageStack = NSStackView()
    private let reportPane: NativeDashboardReportPane
    private var pageButtons: [NativeDashboardDestination: NSButton] = [:]
    private var restingWidthSeeded = false

    var onNavigate: ((NativeDashboardDestination) -> Void)?
    var onAppearanceChange: (() -> Void)? {
        didSet {
            reportPane.onAppearanceChange = onAppearanceChange
        }
    }

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

    /// The sidebar pane's split item. The sidebar is added first, so it is the
    /// leading item; reading it back through `splitViewItems` keeps a single
    /// source of truth rather than a second stored reference that could drift.
    private var sidebarItem: NSSplitViewItem? { splitViewItems.first }

    /// Whether the sidebar is currently collapsed. The navigation rows live
    /// only here — the web report hides its own sidebar in native mode — so a
    /// collapsed sidebar is a window with no way to change page.
    var sidebarIsCollapsed: Bool { sidebarItem?.isCollapsed ?? false }

    /// Reopen the sidebar. Returns true when it actually reopened one, so a
    /// caller (and the smoke test) can tell a rescue from a no-op.
    @discardableResult
    func revealSidebar() -> Bool {
        guard let item = sidebarItem, item.isCollapsed else { return false }
        item.isCollapsed = false
        return true
    }

    /// Reopen a sidebar that an older build could strand shut.
    ///
    /// Dragging the divider to the leading edge collapses the sidebar, and the
    /// split view's autosave persists that across relaunches — but builds
    /// through 0.1.16 shipped no toolbar item, menu command, or key equivalent
    /// that could reopen it, and a collapsed pane has no divider left to drag.
    /// The result was a window with no navigation at all, permanently
    /// (owner-reported, 2026-08-22).
    ///
    /// This build adds those affordances, so a collapse is now the user's
    /// reversible choice and must be respected. The one exception is the
    /// stranded state itself: reopen it exactly once, on the first launch that
    /// can undo it, then record the marker and never reopen again.
    private func rescueStrandedSidebar(_ defaults: UserDefaults) {
        guard !defaults.bool(forKey: Self.sidebarRescuedDefaultsKey) else {
            return
        }
        defaults.set(true, forKey: Self.sidebarRescuedDefaultsKey)
        revealSidebar()
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
        // Before the seeding gate below: every already-installed user has the
        // seeded marker set, and a stranded sidebar is exactly the state those
        // users are in, so a rescue behind that early return would never run.
        rescueStrandedSidebar(defaults)
        guard !defaults.bool(forKey: Self.splitSeededDefaultsKey) else {
            return
        }
        defaults.set(true, forKey: Self.splitSeededDefaultsKey)
        view.layoutSubtreeIfNeeded()
        splitView.setPosition(Self.sidebarRestingThickness, ofDividerAt: 0)
    }

    /// Keep the sidebar command readable in the View menu: AppKit flips the
    /// toolbar item's own label, but a menu item keeps whatever title it was
    /// built with unless validation rewrites it.
    override func validateUserInterfaceItem(
        _ item: NSValidatedUserInterfaceItem
    ) -> Bool {
        if item.action == #selector(NSSplitViewController.toggleSidebar(_:)) {
            if let menuItem = item as? NSMenuItem {
                menuItem.title = TiboTattleLocalization.string(
                    sidebarIsCollapsed
                        ? .nativeDashboardShowSidebar
                        : .nativeDashboardHideSidebar
                )
            }
            return true
        }
        return super.validateUserInterfaceItem(item)
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

/// Stable, non-localized identifiers for the three Settings pages. A page is
/// reachable only through its toolbar tab, so all three are mandatory.
private enum NativeSettingsToolbarPolicy {
    static let generalIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.settings-general"
    )
    static let notificationsIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.settings-notifications"
    )
    static let aboutIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.settings-about"
    )
    static let mandatoryTabIdentifiers: Set<NSToolbarItem.Identifier> = [
        generalIdentifier,
        notificationsIdentifier,
        aboutIdentifier,
    ]
}

/// NSTabViewController supplies the Settings toolbar items, while this proxy
/// adds the removal policy AppKit's generated delegate does not expose. Every
/// item-building and selection query still forwards to the tab controller, so
/// tab behavior remains owned by AppKit.
@MainActor
private final class NativeSettingsToolbarDelegate: NSObject,
    NSToolbarDelegate {
    private weak var tabController: NSTabViewController?

    init(tabController: NSTabViewController) {
        self.tabController = tabController
        super.init()
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        tabController?.toolbar(
            toolbar,
            itemForItemIdentifier: itemIdentifier,
            willBeInsertedIntoToolbar: flag
        )
    }

    func toolbarDefaultItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        tabController?.toolbarDefaultItemIdentifiers(toolbar) ?? []
    }

    func toolbarAllowedItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        tabController?.toolbarAllowedItemIdentifiers(toolbar) ?? []
    }

    func toolbarSelectableItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> [NSToolbarItem.Identifier] {
        tabController?.toolbarSelectableItemIdentifiers(toolbar) ?? []
    }

    func toolbarImmovableItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> Set<NSToolbarItem.Identifier> {
        NativeSettingsToolbarPolicy.mandatoryTabIdentifiers
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemIdentifier: NSToolbarItem.Identifier,
        canBeInsertedAt index: Int
    ) -> Bool {
        index != NSNotFound
            || !NativeSettingsToolbarPolicy.mandatoryTabIdentifiers
                .contains(itemIdentifier)
    }
}

/// Native presentation only: the broker owns the app-process retry budget and
/// the saved keys. Observing status, opening Settings, and cancelling a review
/// cannot authorize Keychain interaction or restart the silent retry budget.
@MainActor
private final class NativeKeychainMigrationApproval {
    private(set) var status: KeychainMigrationStatus = .idle
    private(set) var isReviewing = false
    private(set) var approvalInFlight = false
    private(set) var lastApprovalDeferred = false
    private var reviewGeneration = 0
    var onPresentationChange: (() -> Void)?
    private let approve: (@escaping (Bool) -> Void) -> Void
    private let onMigrationCompleted: () -> Void

    init(
        approve: @escaping (@escaping (Bool) -> Void) -> Void,
        onMigrationCompleted: @escaping () -> Void
    ) {
        self.approve = approve
        self.onMigrationCompleted = onMigrationCompleted
    }

    var showsSettings: Bool {
        status.pendingCount > 0 || status.isRetrying || status.isApproving
            || approvalInFlight
    }

    var showsMenuItem: Bool {
        status.needsApproval || status.isApproving || approvalInFlight
    }

    var canReview: Bool {
        status.needsApproval && !isReviewing && !approvalInFlight
    }

    var summaryKey: TiboTattleLocalization.Key {
        if status.isApproving || approvalInFlight {
            return .settingsKeychainMigrationApproving
        }
        if status.isRetrying { return .settingsKeychainMigrationRetrying }
        if lastApprovalDeferred { return .settingsKeychainMigrationDeferred }
        return .settingsKeychainMigrationSummary
    }

    func observe(_ next: KeychainMigrationStatus) {
        let wasPending = status.pendingCount > 0
            || status.isRetrying || status.isApproving
        status = next
        let completed = wasPending && next.pendingCount == 0
            && !next.isRetrying && !next.isApproving
        if completed { lastApprovalDeferred = false }
        onPresentationChange?()
        // Initial/current idle observations are not completion receipts and
        // must never start an extra local refresh.
        if completed { onMigrationCompleted() }
    }

    /// The confirmation callback is supplied only by the native review action.
    /// Its one-shot guard also ignores duplicate sheet completions or a second
    /// click while either the explanation or system approval is still open.
    func review(confirm: (@escaping (Bool) -> Void) -> Void) {
        guard canReview else { return }
        reviewGeneration += 1
        let selectedReviewGeneration = reviewGeneration
        isReviewing = true
        onPresentationChange?()
        confirm { [weak self] approved in
            guard let self, self.isReviewing,
                  self.reviewGeneration == selectedReviewGeneration
            else { return }
            self.isReviewing = false
            guard approved, self.status.needsApproval,
                  !self.approvalInFlight
            else {
                self.onPresentationChange?()
                return
            }
            self.approvalInFlight = true
            self.lastApprovalDeferred = false
            self.onPresentationChange?()
            self.approve { [weak self] success in
                guard let self, self.approvalInFlight,
                      self.reviewGeneration == selectedReviewGeneration
                else { return }
                self.approvalInFlight = false
                self.lastApprovalDeferred = !success
                self.onPresentationChange?()
            }
        }
    }

    static func makeExplanation() -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = TiboTattleLocalization.string(
            .dialogKeychainMigrationTitle
        )
        alert.informativeText = TiboTattleLocalization.string(
            .dialogKeychainMigrationDescription
        )
        // Cancel is the safe default. A Return key that merely opened Settings
        // must not turn into permission for a system password dialog.
        let cancel = alert.addButton(
            withTitle: TiboTattleLocalization.string(.commonCancel)
        )
        cancel.keyEquivalent = "\r"
        let approve = alert.addButton(
            withTitle: TiboTattleLocalization.string(
                .dialogApproveKeychainMigration
            )
        )
        approve.keyEquivalent = ""
        return alert
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
    private var retiringCompanions = [ObjectIdentifier: CompanionProcess]()
    private var dashboardURL: URL?
    private var firstRunAcknowledged = false
    private var keychainResetProcess: Process?
    private var keychainResetGeneration: Int?
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
    private var settingsToolbarDelegate: NativeSettingsToolbarDelegate?
    private var settingsPages: [SettingsPage] = []
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
    private weak var settingsAppearancePicker: NSPopUpButton?
    private weak var settingsRefreshIntervalPicker: NSPopUpButton?
    private weak var settingsKeychainMigrationSection: NSView?
    private weak var settingsKeychainMigrationLabel: NSTextField?
    private weak var settingsKeychainMigrationButton: NSButton?
    private weak var keychainMigrationMenuItem: NSMenuItem?
    private var keychainMigrationRefreshPending = false
    private lazy var keychainMigrationApproval = NativeKeychainMigrationApproval(
        approve: { [weak self] completion in
            guard let self, !self.quitting, let companion = self.companion
            else {
                completion(false)
                return
            }
            companion.approvePendingMigrations(completion: completion)
        },
        onMigrationCompleted: { [weak self] in
            self?.refreshAfterKeychainMigration()
        }
    )
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
    private var nativeRefreshStartWatchdog: DispatchWorkItem?
    private var nativeRefreshReadWatchdog: DispatchWorkItem?
    private var nativeRefreshSchedule: DispatchWorkItem?
    private var nativeRefreshInFlight = false
    private var nativeRefreshStartFence = NativeRefreshStartFence()
    private var nativeRefreshProgress: LocalAnalysisProgress?
    private var nativeRefreshSequence: UInt64 = 0
    private var nativeRefreshReadEpoch: UInt64 = 0
    private var workspaceWakeObserver: NSObjectProtocol?
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
    /// Notification evaluation belongs only to a refresh this native surface
    /// explicitly started or joined. Reconciliation may adopt an external run
    /// for UI liveness without claiming notification ownership.
    private var nativeRefreshNotificationID: String?
    // A fresh unified index or an authoritatively selected full accounting
    // rebuild receives the companion's bounded four-hour cold-work window.
    // Keep native progress attached through that same window plus one minute
    // for cooperative worker shutdown and the terminal read;
    // the former 120 polls stopped after about 90 seconds and could label a
    // still-running first build as finished.
    private static let nativeRefreshPollIntervalMilliseconds = 750
    private static let nativeRefreshStartWatchdogMilliseconds = 12_000
    private static let nativeRefreshReadWatchdogMilliseconds = 12_000
    /// Once the companion's own maximum work window has elapsed, stay
    /// attached until its terminal receipt without keeping the ordinary
    /// sub-second progress cadence alive indefinitely.
    private static let nativeRefreshSettlementPollIntervalMilliseconds = 5_000
    private static let nativeRefreshMaximumPollSeconds = 4 * 60 * 60 + 60
    private static let nativeRefreshMaximumPollAttempts =
        nativeRefreshMaximumPollSeconds * 1_000
        / nativeRefreshPollIntervalMilliseconds
    static let toolbarStatusRefreshIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-status-refresh"
    )
    static let toolbarShareIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-share"
    )
    static let toolbarSettingsIdentifier = NSToolbarItem.Identifier(
        "com.usagemonitor.local.dashboard-settings"
    )
    static let mandatoryDashboardToolbarItemIdentifiers: Set<
        NSToolbarItem.Identifier
    > = [
        .toggleSidebar,
        toolbarStatusRefreshIdentifier,
        toolbarShareIdentifier,
        toolbarSettingsIdentifier,
    ]
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
        keychainMigrationApproval.onPresentationChange = { [weak self] in
            self?.updateKeychainMigrationPresentation()
        }
        updater.onStateChange = { [weak self] in
            self?.updateUpdaterPresentation()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = umask(0o077)
        workspaceWakeObserver = NSWorkspace.shared.notificationCenter
            .addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.reconcileNativeRefreshStatus()
            }
        applyAppearancePreference(notifyDashboard: false)
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
        // System appearance can change while TiboTattle is inactive. AppKit
        // already updates native dynamic colors; this keeps the live report's
        // explicit document theme synchronized when the window returns.
        synchronizeResolvedAppearance()
        reconcileNativeRefreshStatus()
    }

    private func showFirstRunDisclosure() -> Bool {
        let alert = NSAlert()
        alert.messageText = TiboTattleLocalization.format(
            .launcherWelcome,
            BundledProduct.displayName
        )
        alert.informativeText = TiboTattleLocalization.format(
            .launcherFirstRunDisclosure,
            BundledProduct.displayName,
            BundledProduct.monitoredAppDisplayName,
            BundledProduct.monitoredAppDisplayName,
            BundledProduct.displayName,
            updater.firstRunUpdatesDisclosure,
            TiboTattleLocalization.string(.firstRunLoginItemDisclosure)
        )
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

    /// Main-thread ownership includes detached generations until their broker
    /// writer barriers finish. A later destructive reset must await them too.
    private func retireCompanion(
        _ previous: CompanionProcess,
        completion: @escaping () -> Void = {}
    ) {
        let identifier = ObjectIdentifier(previous)
        retiringCompanions[identifier] = previous
        previous.stop { [weak self, weak previous] in
            DispatchQueue.main.async {
                if let self, let previous, self.retiringCompanions[identifier] === previous {
                    self.retiringCompanions.removeValue(forKey: identifier)
                }
                completion()
            }
        }
    }

    private func startCompanion() {
        guard !quitting, retryAllowed, firstRunAcknowledged,
              keychainResetGeneration == nil, keychainResetProcess == nil,
              companion == nil,
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
            onMigrationStatus: { [weak self] status in
                DispatchQueue.main.async {
                    guard let self, !self.quitting,
                          selectedGeneration == self.launchGeneration
                    else { return }
                    self.keychainMigrationApproval.observe(status)
                }
            },
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
                self.retireCompanion(process)
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
            retireCompanion(process)
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
            .toggleSidebar,
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
            // The system sidebar toggle, first and always present. The sidebar
            // can be collapsed by dragging its divider, and a collapsed pane
            // leaves no divider to drag back — so the only guaranteed way back
            // must live outside the sidebar. AppKit supplies this item, keeps
            // its icon and Hide/Show label in step with the pane, and routes
            // it to `toggleSidebar(_:)` down the responder chain.
            .toggleSidebar,
            Self.toolbarStatusRefreshIdentifier,
            .flexibleSpace,
            Self.toolbarShareIdentifier,
            Self.toolbarSettingsIdentifier,
        ]
    }

    /// These controls are the native shell's only routes to navigation,
    /// refresh, sharing, and Settings. AppKit's accessibility actions can
    /// otherwise offer "Remove from Toolbar" even though customization and
    /// configuration persistence are disabled. Declaring the product controls
    /// immovable prevents user-initiated dragging or removal while leaving the
    /// flexible spacer free to do its normal layout work.
    func toolbarImmovableItemIdentifiers(
        _ toolbar: NSToolbar
    ) -> Set<NSToolbarItem.Identifier> {
        Self.mandatoryDashboardToolbarItemIdentifiers
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
                title: nativeRefreshInFlight
                    ? nativeRefreshProgress?.nativeToolbarTitle()
                        ?? TiboTattleLocalization.string(
                            .nativeDashboardUpdating
                        )
                    : nativeToolbarEvidenceTitle(
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
            ? title
            : nativeToolbarEvidenceTitle(fallback: title)
        nativeStatusRefreshButton?.title = statusTitle
        nativeStatusRefreshButton?.toolTip = isRefreshing
            ? statusTitle
            : nativeRefreshToolbarTooltip()
        nativeStatusRefreshButton?.image = NSImage(
            systemSymbolName: isRefreshing
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: isRefreshing
                ? statusTitle
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
    /// precedence — a running refresh, an attested partial-coverage result,
    /// then a hard terminal failure, an incomplete history index, and only
    /// then the evidence state — so the color never claims a state the words
    /// do not.
    private func nativeToolbarStatusColor(
        isRefreshing: Bool
    ) -> NativeToolbarStatusColor {
        if isRefreshing {
            return .busy
        }
        if nativeRefreshFailure?.suppressesAutomaticRetry == true,
           let coverage = nativeHistoryIndexingCoverage,
           coverage.partialTerminal {
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
            ? nativeRefreshProgress?.nativeToolbarTitle()
                ?? TiboTattleLocalization.string(.nativeDashboardUpdating)
            : nativeToolbarEvidenceTitle(
                fallback: TiboTattleLocalization.string(
                    .nativeDashboardStatus
                )
            )
        nativeStatusRefreshButton?.title = statusTitle
        nativeStatusRefreshButton?.toolTip = nativeRefreshInFlight
            ? statusTitle
            : nativeRefreshToolbarTooltip()
        nativeStatusRefreshButton?.image = NSImage(
            systemSymbolName: nativeRefreshInFlight
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "arrow.clockwise",
            accessibilityDescription: nativeRefreshInFlight
                ? statusTitle
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
        refreshLocalUsage(automatic: false, mode: .detailed)
    }

    @objc private func showShareCardFromToolbar() {
        guard dashboardWebViewShowing,
              let webView = dashboardWebHost?.webView
        else {
            return
        }
        nativeDashboardChrome?.select(.weekly)
        // This is a closed local navigation: it exposes the report's already
        // rendered, privacy-reviewed share card and does not generate a new
        // process, read path, or native-to-JavaScript capability.
        webView.evaluateJavaScript("""
        (function () {
          function focusShareCard() {
            window.requestAnimationFrame(function () {
              document.getElementById('share-panel')?.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
              });
            });
          }
          if (window.location.hash !== '#weekly') {
            window.addEventListener('hashchange', focusShareCard, { once: true });
            window.location.hash = '#weekly';
          } else {
            window.dispatchEvent(new HashChangeEvent('hashchange'));
            focusShareCard();
          }
        }());
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
        chrome.onAppearanceChange = { [weak self] in
            self?.synchronizeResolvedAppearance()
        }
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
                onFailure: { [weak self] failure in
                    self?.dashboardWebViewFailed(failure)
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
                },
                onReadinessDelay: { [weak self] in
                    self?.dashboardWebViewTakingLonger()
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
                ? nativeRefreshProgress?.nativeToolbarTitle()
                    ?? TiboTattleLocalization.string(
                        .nativeDashboardUpdating
                    )
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

    private func dashboardWebViewTakingLonger() {
        // The document is still loading honest local evidence. Keep it visible
        // and keep the one pending startup refresh; no failure/reset is implied.
        lastLifecycleStatus = "Dashboard loading slowly"
        updateNativeToolbar(
            title: TiboTattleLocalization.string(.nativeDashboardStarting),
            isRefreshing: nativeRefreshInFlight,
            refreshEnabled: dashboardURL != nil
        )
    }

    private func dashboardWebViewLoaded() {
        if lastFailureCode == LauncherError.dashboardReadinessTimeout.failureCode {
            lastFailureCode = nil
            lastRecoverySuggestion = nil
        }
        dashboardWebViewShowing = true
        dashboardContainer.isHidden = false
        statusStack.isHidden = true
        actionRow.isHidden = true
        lastLifecycleStatus = "Dashboard open"
        openInBrowserButton.isEnabled = true
        updateNativeToolbar(
            title: nativeRefreshInFlight
                ? nativeRefreshProgress?.nativeToolbarTitle()
                    ?? TiboTattleLocalization.string(
                        .nativeDashboardUpdating
                    )
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
            refreshLocalUsage(automatic: true, mode: .quick)
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
    /// separate worker, daemon, or background URL session. Both explicit
    /// loopback refresh modes share one companion controller, so a manual
    /// click and the foreground cadence cannot start two scans at once.
    private func refreshLocalUsage(
        automatic: Bool,
        mode requestedMode: LocalAnalysisMode,
        allowAutomaticDetailed: Bool = false,
        cadenceStatusChecked: Bool = false
    ) {
        guard !quitting,
              !nativeRefreshInFlight,
              !(automatic
                && nativeRefreshFailure?.suppressesAutomaticRetry == true),
              let dashboardURL
        else {
            return
        }
        if automatic, allowAutomaticDetailed, !cadenceStatusChecked {
            // A browser-started detailed run can finish between native polls.
            // Reconcile its actual-start receipt before spending the hourly
            // allowance; unavailable or running state permits only a quick
            // request (which may join the one controller-owned active run).
            let observedSequence = nativeRefreshSequence
            var resolved = false
            let fallback = DispatchWorkItem { [weak self] in
                guard let self, !resolved, !self.quitting,
                      !self.nativeRefreshInFlight,
                      self.nativeRefreshSequence == observedSequence
                else { return }
                resolved = true
                self.refreshLocalUsage(automatic: true, mode: .quick)
            }
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(
                    Self.nativeRefreshStartWatchdogMilliseconds
                ),
                execute: fallback
            )
            nativeEvidenceReader.readAnalysisActivity(base: dashboardURL) {
                [weak self] activity in
                guard let self, !resolved, !self.quitting,
                      !self.nativeRefreshInFlight,
                      self.nativeRefreshSequence == observedSequence
                else { return }
                resolved = true
                fallback.cancel()
                let controllerIdle: Bool
                if case .idle = activity { controllerIdle = true }
                else { controllerIdle = false }
                self.refreshLocalUsage(
                    automatic: true,
                    mode: .quick,
                    allowAutomaticDetailed: controllerIdle,
                    cadenceStatusChecked: true
                )
            }
            return
        }
        let mode: LocalAnalysisMode
        if automatic, allowAutomaticDetailed {
            mode = NativeDetailedRefreshCadence.automaticMode()
        } else {
            if automatic {
                NativeDetailedRefreshCadence.seedIfMissing()
            }
            mode = requestedMode
        }
        let detailedReservation = mode == .detailed
            ? NativeDetailedRefreshCadence.recordDetailedAttempt()
            : nil
        keychainMigrationRefreshPending = false
        cancelNativeRefreshSchedule()
        cancelNativeIndexingCoveragePoll()
        nativeRefreshInFlight = true
        nativeRefreshStartFence.begin()
        nativeRefreshSequence &+= 1
        let refreshSequence = nativeRefreshSequence
        nativeRefreshNotificationID = nil
        nativeRefreshProgress = nil
        updateNativeToolbar(
            title: automatic
                ? TiboTattleLocalization.string(.launcherUpdatingAutomatically)
                : TiboTattleLocalization.string(.nativeDashboardUpdating),
            isRefreshing: true,
            refreshEnabled: false
        )
        let startWatchdog = DispatchWorkItem { [weak self] in
            guard let self, !self.quitting, self.nativeRefreshInFlight,
                  self.nativeRefreshSequence == refreshSequence
            else { return }
            self.nativeRefreshNotificationID = nil
            self.pollNativeRefresh(
                base: dashboardURL,
                remainingAttempts: Self.nativeRefreshMaximumPollAttempts,
                sequence: refreshSequence
            )
        }
        nativeRefreshStartWatchdog = startWatchdog
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(
                Self.nativeRefreshStartWatchdogMilliseconds
            ),
            execute: startWatchdog
        )
        nativeEvidenceReader.startAnalysis(
            base: dashboardURL,
            mode: mode
        ) { [weak self] result in
            guard let self, !self.quitting,
                  self.nativeRefreshSequence == refreshSequence
            else { return }
            self.nativeRefreshStartWatchdog?.cancel()
            self.nativeRefreshStartWatchdog = nil
            self.nativeRefreshStartFence.resolve()
            if case let .alreadyRunning(_, attempt) = result {
                NativeDetailedRefreshCadence.restoreAfterQuickJoin(
                    detailedReservation,
                    attempt: attempt
                )
            }
            switch result {
            case let .started(refreshID, _), let .alreadyRunning(refreshID, _):
                self.nativeRefreshID = refreshID
                self.nativeRefreshNotificationID = refreshID
                self.pollNativeRefresh(
                    base: dashboardURL,
                    remainingAttempts: Self.nativeRefreshMaximumPollAttempts,
                    sequence: refreshSequence
                )
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

    private func pollNativeRefresh(
        base: URL,
        remainingAttempts: Int,
        sequence: UInt64
    ) {
        cancelNativeRefreshPoll()
        let pollIntervalMilliseconds = remainingAttempts > 0
            ? Self.nativeRefreshPollIntervalMilliseconds
            : Self.nativeRefreshSettlementPollIntervalMilliseconds
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.quitting, self.nativeRefreshInFlight,
                  self.nativeRefreshSequence == sequence
            else {
                return
            }
            self.nativeRefreshReadEpoch &+= 1
            let readEpoch = self.nativeRefreshReadEpoch
            let startObservation = self.nativeRefreshStartFence.observation()
            let watchdog = DispatchWorkItem { [weak self] in
                guard let self, !self.quitting, self.nativeRefreshInFlight,
                      self.nativeRefreshSequence == sequence,
                      self.nativeRefreshReadEpoch == readEpoch
                else { return }
                self.pollNativeRefresh(
                    base: base,
                    remainingAttempts: max(0, remainingAttempts - 1),
                    sequence: sequence
                )
            }
            self.nativeRefreshReadWatchdog = watchdog
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(
                    Self.nativeRefreshReadWatchdogMilliseconds
                ),
                execute: watchdog
            )
            self.nativeEvidenceReader.readAnalysisActivity(base: base) { [weak self] activity in
                guard let self, !self.quitting, self.nativeRefreshInFlight,
                      self.nativeRefreshSequence == sequence,
                      self.nativeRefreshReadEpoch == readEpoch
                else {
                    return
                }
                self.nativeRefreshReadWatchdog?.cancel()
                self.nativeRefreshReadWatchdog = nil
                switch activity {
                case let .running(refreshID, progress, _):
                    if let refreshID {
                        if self.nativeRefreshNotificationID != refreshID {
                            self.nativeRefreshNotificationID = nil
                        }
                        self.nativeRefreshID = refreshID
                    }
                    self.nativeRefreshProgress = progress
                    self.updateNativeToolbar(
                        // The refresh receipt has not supplied a matched
                        // numeric overview snapshot. In particular,
                        // `quick_result` is only a collector checkpoint, so it
                        // must use neutral continuation copy here. The
                        // allowlisted unified-index receipt below supersedes it
                        // with bounded file counts as soon as deep work starts.
                        title: progress?.nativeToolbarTitle(
                            hasUsableHeadlineEvidence: false
                        )
                            ?? TiboTattleLocalization.string(
                                .nativeDashboardUpdating
                            ),
                        isRefreshing: true,
                        refreshEnabled: false
                    )
                    if remainingAttempts <= 0 {
                        // Exhausting this surface's progress budget is not a
                        // terminal companion receipt. Keep the refresh locked
                        // and visibly unsettled until the controller reports
                        // idle; otherwise a still-running cold build could be
                        // mislabeled "Up to date" and a second pass enabled.
                        self.updateNativeToolbar(
                            title: TiboTattleLocalization.string(
                                .launcherDashboardTakingLonger
                            ),
                            isRefreshing: true,
                            refreshEnabled: false
                        )
                        self.pollNativeRefresh(
                            base: base,
                            remainingAttempts: 0,
                            sequence: sequence
                        )
                        return
                    }
                    self.pollNativeRefresh(
                        base: base,
                        remainingAttempts: remainingAttempts - 1,
                        sequence: sequence
                    )
                    return
                case let .idle(refreshID, _, _):
                    guard self.nativeRefreshStartFence.allowsTerminal(
                        startObservation
                    ) else {
                        self.pollNativeRefresh(
                            base: base,
                            remainingAttempts: max(0, remainingAttempts - 1),
                            sequence: sequence
                        )
                        return
                    }
                    self.handleNativeRefreshTerminal(
                        base: base,
                        terminalRefreshID: refreshID,
                        sequence: sequence,
                        startObservation: startObservation
                    )
                    return
                case .none:
                    // A failed or future-schema activity read is not evidence
                    // that the accepted refresh stopped. Keep the control
                    // locked and retry; companion exit/teardown owns the
                    // separate unavailable lifecycle.
                    self.nativeEvidenceState = .readFailed
                    self.updateNativeToolbar(
                        title: TiboTattleLocalization.string(
                            .menuBarQuotaEvidenceUnavailable
                        ),
                        isRefreshing: true,
                        refreshEnabled: false
                    )
                    self.pollNativeRefresh(
                        base: base,
                        remainingAttempts: max(0, remainingAttempts - 1),
                        sequence: sequence
                    )
                    return
                }
            }
        }
        nativeRefreshPoll = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(
                pollIntervalMilliseconds
            ),
            execute: work
        )
    }

    /// The companion's terminal receipt is authoritative for whether work is
    /// still running. Clear the busy latch before any optional overview or
    /// coverage read: those reads may fail or lose a callback, but cannot turn
    /// an already-terminal refresh back into an endless spinner.
    private func handleNativeRefreshTerminal(
        base: URL,
        terminalRefreshID: String?,
        sequence: UInt64,
        startObservation: NativeRefreshStartFence.Observation
    ) {
        guard nativeRefreshInFlight, nativeRefreshSequence == sequence,
              nativeRefreshStartFence.allowsTerminal(startObservation)
        else {
            return
        }
        let expectedRefreshID = terminalRefreshID == nativeRefreshNotificationID
            ? nativeRefreshNotificationID
            : nil
        settleNativeRefresh(
            title: TiboTattleLocalization.string(.nativeDashboardStatus),
            refreshEnabled: true
        )
        let presentationSequence = nativeRefreshSequence
        evaluateQuotaNotificationsAfterRefresh(
            base: base,
            expectedRefreshID: expectedRefreshID
        )
        nativeEvidenceReader.readOverview(base: base) { [weak self] overview in
            guard let self, !self.quitting,
                  !self.nativeRefreshInFlight,
                  self.nativeRefreshSequence == presentationSequence
            else { return }
            if let overview {
                self.nativeEvidenceObservedAt = overview.observedAt
                switch LocalCompanionOverviewProjection.evidence(for: overview) {
                case .live:
                    self.nativeEvidenceState = .live
                case .stale:
                    self.nativeEvidenceState = .stale
                case .none:
                    self.nativeEvidenceState = .unknown
                }
            } else {
                self.nativeEvidenceState = .readFailed
            }
            let title: String
            if let overview,
               LocalCompanionOverviewProjection.evidence(for: overview) == .live {
                title = TiboTattleLocalization.string(.launcherUpToDate)
            } else if overview?.lanes.isEmpty == false {
                title = TiboTattleLocalization.string(.launcherNeedsAttention)
            } else {
                title = TiboTattleLocalization.string(
                    .launcherNoAllowanceObserved
                )
            }
            self.readNativeToolbarStatusFacts(base: base) { [weak self] in
                guard let self, !self.quitting,
                      !self.nativeRefreshInFlight,
                      self.nativeRefreshSequence == presentationSequence
                else { return }
                self.updateNativeToolbar(
                    title: title,
                    isRefreshing: false,
                    refreshEnabled: true
                )
            }
        }
    }

    /// Re-adopt a companion run after activation or wake, and clear only from
    /// an explicit terminal receipt. An unreadable or future-schema response
    /// is deliberately a no-op because it is not evidence that work stopped.
    private func reconcileNativeRefreshStatus() {
        guard !quitting, let base = dashboardURL else { return }
        let observedSequence = nativeRefreshSequence
        let startObservation = nativeRefreshStartFence.observation()
        nativeEvidenceReader.readAnalysisActivity(base: base) { [weak self] activity in
            guard let self, !self.quitting,
                  self.nativeRefreshSequence == observedSequence
            else { return }
            switch activity {
            case let .running(refreshID, progress, _):
                if !self.nativeRefreshInFlight {
                    self.cancelNativeRefreshSchedule()
                    self.cancelNativeIndexingCoveragePoll()
                    self.nativeRefreshInFlight = true
                    self.nativeRefreshSequence &+= 1
                    self.nativeRefreshNotificationID = nil
                }
                let sequence = self.nativeRefreshSequence
                if let refreshID {
                    if self.nativeRefreshNotificationID != refreshID {
                        self.nativeRefreshNotificationID = nil
                    }
                    self.nativeRefreshID = refreshID
                }
                self.nativeRefreshProgress = progress
                self.updateNativeToolbar(
                    title: progress?.nativeToolbarTitle()
                        ?? TiboTattleLocalization.string(
                            .nativeDashboardUpdating
                        ),
                    isRefreshing: true,
                    refreshEnabled: false
                )
                self.pollNativeRefresh(
                    base: base,
                    remainingAttempts: Self.nativeRefreshMaximumPollAttempts,
                    sequence: sequence
                )
            case let .idle(refreshID, _, _):
                guard self.nativeRefreshInFlight else { return }
                self.handleNativeRefreshTerminal(
                    base: base,
                    terminalRefreshID: refreshID,
                    sequence: observedSequence,
                    startObservation: startObservation
                )
            case .none:
                return
            }
        }
    }

    private func finishNativeRefresh(title: String, refreshEnabled: Bool) {
        settleNativeRefresh(title: title, refreshEnabled: refreshEnabled)
    }

    private func settleNativeRefresh(title: String, refreshEnabled: Bool) {
        nativeRefreshSequence &+= 1
        nativeRefreshInFlight = false
        nativeRefreshStartFence.resolve()
        nativeRefreshProgress = nil
        nativeRefreshID = nil
        nativeRefreshNotificationID = nil
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
        if keychainMigrationRefreshPending {
            refreshAfterKeychainMigration()
            return
        }
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
                case let .failed(step, code):
                    self.nativeRefreshFailure = NativeRefreshFailure(
                        failedStep: step,
                        failureCode: code
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
        nativeRefreshStartWatchdog?.cancel()
        nativeRefreshStartWatchdog = nil
        nativeRefreshPoll?.cancel()
        nativeRefreshPoll = nil
        nativeRefreshReadWatchdog?.cancel()
        nativeRefreshReadWatchdog = nil
        nativeRefreshReadEpoch &+= 1
    }

    /// The foreground app keeps its own local evidence current while a
    /// login-item launch (if enabled) remains only an explicit app start. The
    /// interval is a persisted, bounded preference; it never creates a
    /// background worker or keeps the app alive after quit.
    private func scheduleNativeRefresh() {
        cancelNativeRefreshSchedule()
        guard !quitting,
              dashboardURL != nil,
              nativeRefreshFailure?.suppressesAutomaticRetry != true
        else {
            return
        }
        let work = NativeForegroundRefreshScheduler.schedule { [weak self] in
            self?.refreshLocalUsage(
                automatic: true,
                mode: .quick,
                allowAutomaticDetailed: true
            )
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
              !coverage.isComplete,
              !coverage.partialTerminal
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
        let migration = NSMenuItem(
            title: TiboTattleLocalization.string(.settingsKeychainMigrationMenu),
            action: #selector(showKeychainMigrationSettings),
            keyEquivalent: ""
        )
        migration.target = self
        migration.isHidden = !keychainMigrationApproval.showsMenuItem
        keychainMigrationMenuItem = migration
        appMenu.addItem(migration)
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
        // The standard macOS sidebar command, on the standard key equivalent.
        // A collapsed sidebar has no divider left to drag, so this and the
        // toolbar item are the two ways back; the title is rewritten to
        // Hide/Show by the chrome's validation. Target stays nil so the
        // responder chain delivers it to whichever dashboard window is key,
        // and the item disables itself when none is.
        viewMenu.addItem(NSMenuItem.separator())
        let toggleSidebar = NSMenuItem(
            title: TiboTattleLocalization.string(.nativeDashboardHideSidebar),
            action: #selector(NSSplitViewController.toggleSidebar(_:)),
            keyEquivalent: "s"
        )
        toggleSidebar.keyEquivalentModifierMask = [.control, .command]
        toggleSidebar.target = nil
        viewMenu.addItem(toggleSidebar)
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

    private func dashboardWebViewFailed(_ failure: LauncherError) {
        cancelNativeRefreshSchedule()
        // A hard readiness deadline stops observation, not the still-unspent
        // initial refresh. An explicit Open Dashboard can load a new document
        // and consume it once. Genuine navigation/renderer failures cancel it.
        if case .dashboardReadinessTimeout = failure {
            // Preserved until a valid ready result or explicit teardown.
        } else {
            startupAutomaticRefreshPending = false
        }
        nativeEvidenceState = .readFailed
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        let headline: TiboTattleLocalization.Key
        switch failure {
        case .dashboardContentProcessTerminated:
            lastLifecycleStatus = "Dashboard web process terminated"
            headline = .launcherDashboardDidNotOpen
        case .dashboardNavigationFailed:
            lastLifecycleStatus = "Dashboard navigation failed"
            headline = .launcherDashboardDidNotOpen
        case .dashboardReadinessTimeout:
            lastLifecycleStatus = "Dashboard readiness timed out"
            headline = .launcherDashboardTakingLonger
        case .dashboardViewportUnavailable:
            lastLifecycleStatus = "Dashboard viewport unavailable"
            headline = .launcherDashboardDidNotOpen
        default:
            lastLifecycleStatus = "Dashboard unavailable"
            headline = .launcherDashboardDidNotOpen
        }
        lastFailureCode = failure.failureCode
        lastRecoverySuggestion = failure.recoverySuggestion
        statusLabel.stringValue = TiboTattleLocalization.string(headline)
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
        nativeRefreshStartFence.resolve()
        nativeRefreshProgress = nil
        nativeRefreshID = nil
        dashboardWebHost?.stop()
        updateNativeToolbar(
            title: "Starting locally…",
            isRefreshing: false,
            refreshEnabled: false
        )
    }

    /// A link the embedded dashboard cannot load itself. Only credential-free
    /// public HTTPS is handed to the user's browser. User-activated, canonical
    /// Codex thread links are handed to Codex after the WebHost's origin gate;
    /// nothing remote loads inside the app.
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
        if CodexThreadOpenTarget.accepts(url) {
            NSWorkspace.shared.open(url)
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
        updateKeychainMigrationPresentation()
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
        updateKeychainMigrationPresentation()
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
        guard !quitting, retryAllowed, firstRunAcknowledged,
              keychainResetGeneration == nil, keychainResetProcess == nil else { return }
        automaticCompanionRecoveryUsed = false
        launchGeneration += 1
        let retryGeneration = launchGeneration
        let previous = companion
        companion = nil
        if let previous {
            retryButton.isEnabled = false
            retireCompanion(previous) { [weak self] in
                guard let self, !self.quitting, self.launchGeneration == retryGeneration else { return }
                self.startCompanion()
            }
        } else {
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

    /// A button in a settings card is a button, not a banner. A card stretches
    /// every direct child to the card width so wrapping descriptions have a
    /// measure to wrap against, and a bare `NSButton` handed that width
    /// centres its title across the whole card. A row is the seam that keeps
    /// the width for the card and the intrinsic size for the control, on the
    /// same leading edge as every other row.
    private func settingsControlRow(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    /// The same seam for controls that stack instead of sitting side by side.
    /// A vertical stack aligned `.leading` sizes each arranged view to its own
    /// intrinsic width, which is exactly what a card's direct children lose.
    private func settingsControlColumn(_ views: [NSView]) -> NSStackView {
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 8
        return column
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
    ) -> SettingsPage {
        NativeSettingsLayout.page(
            title: title,
            summary: summary,
            views: views
        )
    }

    /// The window is only as tall as the page it is showing, and a card's
    /// height moves with its live text: a chosen folder path wraps to a second
    /// line, the pending-login-item row appears, a notification status grows.
    /// Every update seam that writes into a card re-asks the pages for their
    /// size, so the window follows its content instead of keeping the height
    /// it happened to open at.
    private func refitSettingsWindowToContent() {
        guard let settingsWindow, let settingsTabs, !settingsPages.isEmpty
        else { return }
        let sizes = settingsPages.map {
            NativeSettingsLayout.contentSize(for: $0.column)
        }
        for (page, size) in zip(settingsPages, sizes) {
            page.controller.preferredContentSize = size
        }
        let selected = min(
            max(settingsTabs.selectedTabViewItemIndex, 0),
            sizes.count - 1
        )
        settingsWindow.contentMinSize = NSSize(
            width: NativeSettingsLayout.contentWidth,
            height: sizes.map(\.height).min() ?? sizes[selected].height
        )
        guard let content = settingsWindow.contentView,
              abs(content.frame.height - sizes[selected].height) > 0.5
        else { return }
        settingsWindow.setContentSize(sizes[selected])
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
        refitSettingsWindowToContent()
    }

    private func updateKeychainMigrationPresentation() {
        let presentation = keychainMigrationApproval
        settingsKeychainMigrationSection?.isHidden =
            !presentation.showsSettings
        settingsKeychainMigrationLabel?.stringValue =
            TiboTattleLocalization.string(presentation.summaryKey)
        settingsKeychainMigrationButton?.isEnabled =
            presentation.canReview && !quitting && companion?.isRunning == true
        keychainMigrationMenuItem?.isHidden = !presentation.showsMenuItem
        // A status observation is deliberately non-modal and never opens
        // Settings. Local quota/accounting presentation keeps its own truth.
        refitSettingsWindowToContent()
    }

    private func refreshAfterKeychainMigration() {
        guard !quitting else { return }
        keychainMigrationRefreshPending = true
        guard dashboardURL != nil, !nativeRefreshInFlight else { return }
        // One repair refresh uses the existing local-only analysis route. It
        // neither grants contribution consent nor starts a second scan while
        // the current pass is still running.
        refreshLocalUsage(automatic: false, mode: .detailed)
    }

    @objc private func showKeychainMigrationSettings() {
        showSettings(selecting: 0)
    }

    @objc private func reviewKeychainMigration(_ sender: NSButton) {
        guard sender === settingsKeychainMigrationButton,
              !quitting, companion?.isRunning == true,
              let settingsWindow
        else { return }
        keychainMigrationApproval.review { complete in
            let explanation = NativeKeychainMigrationApproval.makeExplanation()
            explanation.beginSheetModal(for: settingsWindow) { response in
                complete(response == .alertSecondButtonReturn)
            }
        }
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
        refitSettingsWindowToContent()
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
        if nativeRefreshFailure?.suppressesAutomaticRetry == true,
           let coverage = nativeHistoryIndexingCoverage,
           coverage.partialTerminal {
            return NativeToolbarStatusText.historyPartial(
                skippedSourceCount: coverage.skippedSourceCount
            )
        }
        if let failure = nativeRefreshFailure {
            return NativeToolbarStatusText.refreshFailed(
                step: failure.failedStep
            )
        }
        if let coverage = nativeHistoryIndexingCoverage, !coverage.isComplete {
            return coverage.partialTerminal
                ? NativeToolbarStatusText.historyPartial(
                    skippedSourceCount: coverage.skippedSourceCount
                )
                : NativeToolbarStatusText.indexing(
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
        refitSettingsWindowToContent()
    }

    private func updateAppearanceSettingsControl() {
        guard let picker = settingsAppearancePicker else { return }
        let preference = NativeAppearancePreference.current
        if let index = picker.itemArray.firstIndex(where: {
            ($0.representedObject as? String) == preference.rawValue
        }) {
            picker.selectItem(at: index)
        }
    }

    private func applyAppearancePreference(
        notifyDashboard: Bool = true
    ) {
        let preference = NativeAppearancePreference.current
        NSApp.appearance = preference.applicationAppearance
        updateAppearanceSettingsControl()
        window?.contentView?.needsDisplay = true
        if notifyDashboard {
            dashboardWebHost?.notifyAppearancePreferenceChange(preference)
        }
    }

    private func synchronizeResolvedAppearance() {
        let preference = NativeAppearancePreference.current
        updateAppearanceSettingsControl()
        window?.contentView?.needsDisplay = true
        // Explicit Light and Dark are intentionally insulated from later
        // system changes. Only System follows the effective AppKit appearance;
        // selecting any preference already sends its own immediate update.
        guard preference == .system else { return }
        dashboardWebHost?.notifyAppearancePreferenceChange(preference)
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
        refitSettingsWindowToContent()
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

    @objc private func selectAppearancePreference(
        _ sender: NSPopUpButton
    ) {
        guard let rawPreference = sender.selectedItem?.representedObject
            as? String,
              let preference = NativeAppearancePreference(
                  rawValue: rawPreference
              )
        else {
            updateAppearanceSettingsControl()
            return
        }
        NativeAppearancePreference.set(preference)
        applyAppearancePreference()
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
        settingsToolbarDelegate = nil
        settingsPages = []
        settingsCodexHomeLabel = nil
        settingsAutomaticUpdatesSwitch = nil
        settingsAboutAutomaticUpdatesDetailLabel = nil
        settingsCheckForUpdatesButton = nil
        settingsAppearancePicker = nil
        settingsRefreshIntervalPicker = nil
        settingsKeychainMigrationSection = nil
        settingsKeychainMigrationLabel = nil
        settingsKeychainMigrationButton = nil
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
            updateAppearanceSettingsControl()
            updateRefreshIntervalSettingsControl()
            updateStartAtLoginSettingsControl()
            updateKeychainMigrationPresentation()
            quotaNotificationCoordinator?.refreshAuthorization()
            updateQuotaNotificationSettingsControls()
            refitSettingsWindowToContent()
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
        let sourceActions = settingsControlRow([chooseSource, useDefaultSource])
        let migrationStatus = settingsLabel(
            TiboTattleLocalization.string(keychainMigrationApproval.summaryKey),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        settingsKeychainMigrationLabel = migrationStatus
        let reviewMigration = NSButton(
            title: TiboTattleLocalization.string(.settingsKeychainMigrationReview),
            target: self,
            action: #selector(reviewKeychainMigration(_:))
        )
        reviewMigration.bezelStyle = .rounded
        reviewMigration.isEnabled = keychainMigrationApproval.canReview
            && !quitting && companion?.isRunning == true
        reviewMigration.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsKeychainMigrationReview)
        )
        settingsKeychainMigrationButton = reviewMigration
        let migrationSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsKeychainMigrationTitle),
            symbolName: "key",
            views: [migrationStatus, settingsControlRow([reviewMigration])]
        )
        migrationSection.isHidden = !keychainMigrationApproval.showsSettings
        settingsKeychainMigrationSection = migrationSection
        let appearancePicker = NSPopUpButton(
            frame: .zero,
            pullsDown: false
        )
        let appearanceChoices: [(
            NativeAppearancePreference,
            TiboTattleLocalization.Key
        )] = [
            (.system, .settingsAppearanceSystem),
            (.light, .settingsAppearanceLight),
            (.dark, .settingsAppearanceDark),
        ]
        for (preference, key) in appearanceChoices {
            appearancePicker.addItem(
                withTitle: TiboTattleLocalization.string(key)
            )
            appearancePicker.lastItem?.representedObject = preference.rawValue
        }
        appearancePicker.target = self
        appearancePicker.action = #selector(selectAppearancePreference(_:))
        appearancePicker.toolTip = TiboTattleLocalization.string(
            .settingsAppearancePickerHint
        )
        appearancePicker.setAccessibilityLabel(
            TiboTattleLocalization.string(.settingsAppearance)
        )
        settingsAppearancePicker = appearancePicker
        updateAppearanceSettingsControl()
        let appearanceRow = NSStackView(views: [appearancePicker])
        appearanceRow.orientation = .horizontal
        appearanceRow.alignment = .centerY
        let appearanceSection = settingsGroup(
            title: TiboTattleLocalization.string(.settingsAppearance),
            symbolName: "circle.lefthalf.filled",
            views: [
                appearanceRow,
                settingsLabel(
                    TiboTattleLocalization.string(.settingsAppearanceSummary),
                    font: .systemFont(ofSize: 12),
                    color: .secondaryLabelColor
                ),
            ]
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
                // Stacked, not paired: the Spanish titles of these three each
                // run wider than half the card, so a shared row would squeeze
                // their titles. The column is leading-aligned so hiding the
                // pending-removal button takes its own gap with it.
                settingsControlColumn([
                    openLoginItems,
                    refreshLoginItemStatus,
                    removePendingLoginItem,
                ]),
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
                settingsControlRow([openNotifications]),
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
                migrationSection,
                appearanceSection,
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
                settingsControlRow([checkForUpdates]),
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

        for page in [general, notifications, about] {
            page.controller.title = TiboTattleLocalization.string(
                .settingsWindowTitle
            )
        }

        let tabs = NSTabViewController()
        tabs.tabStyle = .toolbar
        for (identifier, label, symbol, controller) in [
            (
                NativeSettingsToolbarPolicy.generalIdentifier,
                TiboTattleLocalization.string(.settingsGeneral),
                "gearshape",
                general.controller
            ),
            (
                NativeSettingsToolbarPolicy.notificationsIdentifier,
                TiboTattleLocalization.string(.settingsNotifications),
                "bell",
                notifications.controller
            ),
            (
                NativeSettingsToolbarPolicy.aboutIdentifier,
                TiboTattleLocalization.string(.settingsAboutTab),
                "info.circle",
                about.controller
            ),
        ] {
            let item = NSTabViewItem(identifier: identifier)
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
        let toolbarDelegate = NativeSettingsToolbarDelegate(
            tabController: tabs
        )
        if let toolbar = newWindow.toolbar {
            toolbar.allowsUserCustomization = false
            toolbar.autosavesConfiguration = false
            toolbar.delegate = toolbarDelegate
        }
        newWindow.title = TiboTattleLocalization.string(.settingsWindowTitle)
        newWindow.styleMask = [.titled, .closable, .miniaturizable]
        // The window is as tall as the page it is showing. A hard-coded height
        // is what handed a four-group General page a scroller and clipped its
        // last group, and any replacement number would only move the clip to
        // whichever locale wraps one line further. Every page publishes its own
        // measured height as `preferredContentSize`, which the tab controller
        // resizes the window to on each switch; this opens the first tab at the
        // same size instead of one frame at a stale one. The floor is the
        // shortest page, so nothing can collapse the window below its content.
        let pages = [general, notifications, about]
        settingsPages = pages
        let openingSize = pages[min(max(index, 0), pages.count - 1)]
            .controller.preferredContentSize
        newWindow.setContentSize(openingSize)
        newWindow.contentMinSize = NSSize(
            width: NativeSettingsLayout.contentWidth,
            height: pages
                .map(\.controller.preferredContentSize.height)
                .min() ?? openingSize.height
        )
        newWindow.isReleasedWhenClosed = false
        newWindow.center()
        settingsWindow = newWindow
        settingsTabs = tabs
        settingsToolbarDelegate = toolbarDelegate
        updateKeychainMigrationPresentation()
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
        let restartGeneration = launchGeneration
        let previous = companion
        companion = nil
        if let previous {
            retireCompanion(previous) { [weak self] in
                guard let self, !self.quitting, self.launchGeneration == restartGeneration else { return }
                self.startCompanion()
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
        guard !quitting, keychainResetGeneration == nil, keychainResetProcess == nil else { return }
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
        let resetGeneration = launchGeneration
        // Claim the whole operation, including the asynchronous stop barrier.
        // A second Reset action must not bypass it after companion is detached.
        keychainResetGeneration = resetGeneration
        let previous = companion
        companion = nil
        var pendingCompanions = retiringCompanions
        if let previous { pendingCompanions[ObjectIdentifier(previous)] = previous }
        let runReset = { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.keychainResetGeneration == resetGeneration else { return }
                guard !self.quitting, self.launchGeneration == resetGeneration else {
                    self.keychainResetGeneration = nil
                    return
                }
                self.launchLocalKeychainResetHelper(generation: resetGeneration)
            }
        }
        let stopped = DispatchGroup()
        for previous in pendingCompanions.values {
            stopped.enter()
            retireCompanion(previous) { stopped.leave() }
        }
        stopped.notify(queue: .main, execute: runReset)
    }

    private func launchLocalKeychainResetHelper(generation: Int) {
        guard keychainResetGeneration == generation, launchGeneration == generation, !quitting else { return }
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
                "USAGE_MONITOR_KEYCHAIN_NAMESPACE":
                    BundledProduct.keychainNamespace,
                "USAGE_MONITOR_KEYCHAIN_ACCOUNT":
                    BundledProduct.keychainAccount,
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
                    guard let self, self.keychainResetProcess === terminated else { return }
                    self.keychainResetProcess = nil
                    guard self.keychainResetGeneration == generation else { return }
                    self.keychainResetGeneration = nil
                    guard !self.quitting, self.launchGeneration == generation else { return }
                    self.finishLocalKeychainReset(
                        status: terminated.terminationStatus,
                        output: output,
                        errorOutput: errorOutput,
                        generation: generation
                    )
                }
            }
            keychainResetProcess = child
            try child.run()
        } catch {
            keychainResetProcess = nil
            if keychainResetGeneration == generation { keychainResetGeneration = nil }
            showFailure(LauncherError.keychainReset)
        }
    }

    private func finishLocalKeychainReset(
        status: Int32,
        output: Data,
        errorOutput: Data,
        generation: Int
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
            guard !quitting, launchGeneration == generation else { return }
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
        let eraseGeneration = launchGeneration
        let previous = companion
        companion = nil
        let erase = { [weak self] in
            guard let self, !self.quitting, self.launchGeneration == eraseGeneration else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let stateRoot = try ownerOnlyStateRoot()
                    try FileManager.default.trashItem(
                        at: stateRoot,
                        resultingItemURL: nil
                    )
                    DispatchQueue.main.async {
                        DashboardWebHost.clearPersistentWebsiteData {
                            guard !self.quitting, self.launchGeneration == eraseGeneration else { return }
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
                        guard !self.quitting, self.launchGeneration == eraseGeneration else { return }
                        self.showFailure(LauncherError.dataErase)
                    }
                }
            }
        }
        if let previous {
            retireCompanion(previous, completion: erase)
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
        if let workspaceWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(
                workspaceWakeObserver
            )
            self.workspaceWakeObserver = nil
        }
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

private func endpointReportsHealthy(_ url: URL) -> Bool {
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
           object["status"] as? String == "ok" {
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

        let centralWasHealthy = !requireCentralService || endpointReportsHealthy(
            selectedURL.appendingPathComponent("api/health")
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
        guard centralWasHealthy else {
            FileHandle.standardError.write(
                Data("macOS smoke: central health check failed\n".utf8)
            )
            return 1
        }
        if requireCentralService {
            print(
                "USAGE_MONITOR_MACOS_CENTRAL_SMOKE_HEALTHY "
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
        guard CompanionProcess.verifyKeychainShutdownContract() else { return 1 }
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
                + "secure_erasure=false confirmations=2 writer_barrier=drained "
                + "callbacks=once reset_resurrection=false keychain_access=0"
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
        let cadenceStart = Date(timeIntervalSince1970: 10_000)
        guard NativeDetailedRefreshCadence.automaticMode(
            now: cadenceStart,
            defaults: reloaded
        ) == .quick,
              reloaded.double(
                forKey: NativeDetailedRefreshCadence.defaultsKey
              ) == cadenceStart.timeIntervalSince1970,
              NativeDetailedRefreshCadence.automaticMode(
                now: cadenceStart.addingTimeInterval(3_599),
                defaults: reloaded
              ) == .quick,
              NativeDetailedRefreshCadence.automaticMode(
                now: cadenceStart.addingTimeInterval(3_600),
                defaults: reloaded
              ) == .detailed,
              reloaded.double(
                forKey: NativeDetailedRefreshCadence.defaultsKey
              ) == cadenceStart.timeIntervalSince1970
        else {
            return 1
        }
        let attemptedAt = cadenceStart.addingTimeInterval(3_600)
        let reservation = NativeDetailedRefreshCadence.recordDetailedAttempt(
            now: attemptedAt, defaults: reloaded
        )
        NativeDetailedRefreshCadence.restoreAfterQuickJoin(
            reservation, attempt: nil, defaults: reloaded
        )
        guard NativeDetailedRefreshCadence.automaticMode(
            now: attemptedAt.addingTimeInterval(1), defaults: reloaded
        ) == .quick else { return 1 }
        let quickJoin = LocalAnalysisAttempt(mode: .quick, startedAt: attemptedAt)
        NativeDetailedRefreshCadence.restoreAfterQuickJoin(
            reservation, attempt: quickJoin, defaults: reloaded
        )
        guard reloaded.double(forKey: NativeDetailedRefreshCadence.defaultsKey)
                == cadenceStart.timeIntervalSince1970,
              NativeDetailedRefreshCadence.automaticMode(
                now: attemptedAt, defaults: reloaded
              ) == .detailed
        else { return 1 }
        let earlier = NativeDetailedRefreshCadence.recordDetailedAttempt(
            now: attemptedAt, defaults: reloaded
        )
        let later = NativeDetailedRefreshCadence.recordDetailedAttempt(
            now: attemptedAt, defaults: reloaded
        )
        NativeDetailedRefreshCadence.restoreAfterQuickJoin(
            earlier, attempt: quickJoin, defaults: reloaded
        )
        guard reloaded.string(forKey: NativeDetailedRefreshCadence.reservationKey)
                == later?.token,
              reloaded.double(forKey: NativeDetailedRefreshCadence.defaultsKey)
                == attemptedAt.timeIntervalSince1970
        else { return 1 }
        NativeDetailedRefreshCadence.seedIfMissing(
            now: cadenceStart.addingTimeInterval(9_000),
            defaults: reloaded
        )
        guard reloaded.double(
            forKey: NativeDetailedRefreshCadence.defaultsKey
        ) == cadenceStart.addingTimeInterval(3_600).timeIntervalSince1970
        else {
            return 1
        }
        let externalStart = cadenceStart.addingTimeInterval(10_000)
        let external = LocalAnalysisAttempt(mode: .detailed, startedAt: externalStart)
        NativeDetailedRefreshCadence.observe(
            external, now: externalStart.addingTimeInterval(5), defaults: reloaded
        )
        NativeDetailedRefreshCadence.observe(
            external, now: externalStart.addingTimeInterval(3_599), defaults: reloaded
        )
        guard reloaded.double(forKey: NativeDetailedRefreshCadence.defaultsKey)
                == externalStart.timeIntervalSince1970,
              NativeDetailedRefreshCadence.automaticMode(
                now: externalStart.addingTimeInterval(3_599), defaults: reloaded
              ) == .quick,
              NativeDetailedRefreshCadence.automaticMode(
                now: externalStart.addingTimeInterval(3_600), defaults: reloaded
              ) == .detailed
        else { return 1 }
        var startFence = NativeRefreshStartFence()
        startFence.begin()
        let oldIdleRead = startFence.observation()
        guard !startFence.allowsTerminal(oldIdleRead) else { return 1 }
        // The delayed POST now returns 202/running. The earlier idle GET is
        // still stale even if its callback arrives after this resolution.
        startFence.resolve()
        guard !startFence.allowsTerminal(oldIdleRead),
              startFence.allowsTerminal(startFence.observation())
        else { return 1 }
        let previousRunRead = startFence.observation()
        startFence.begin()
        guard !startFence.allowsTerminal(previousRunRead) else { return 1 }
        print(
            "USAGE_MONITOR_MACOS_REFRESH_SETTINGS_CONTRACT "
                + "default=300 persisted=900 reloaded=900 "
                + "picker_action=true picker_persisted=true "
                + "scheduler=300->900 "
                + "detailed_attempt_cadence=3600 startup=quick "
                + "quick_join=restored newer_attempt=preserved "
                + "external_attempt=actual-start stale_idle=ignored "
                + "invalid_ignored=true"
        )
        return 0
    }
}

/// Exercises the shipped native approval state machine and the real NSAlert
/// configuration with synthetic completion callbacks. It neither presents a
/// system permission dialog nor constructs a companion or Keychain broker.
@MainActor
private enum NativeKeychainMigrationUIContractSmokeTest {
    static func run() -> Int32 {
        _ = NSApplication.shared
        let explanation = NativeKeychainMigrationApproval.makeExplanation()
        guard explanation.alertStyle == .informational,
              explanation.buttons.count == 2,
              explanation.buttons[0].title ==
                TiboTattleLocalization.string(.commonCancel),
              explanation.buttons[0].keyEquivalent == "\r",
              explanation.buttons[1].title == TiboTattleLocalization.string(
                .dialogApproveKeychainMigration
              ),
              explanation.buttons[1].keyEquivalent.isEmpty,
              explanation.informativeText == TiboTattleLocalization.string(
                .dialogKeychainMigrationDescription
              )
        else { return 1 }

        var approvalCalls = 0
        var refreshCalls = 0
        var confirmationCalls = 0
        var finishApproval: ((Bool) -> Void)?
        let state = NativeKeychainMigrationApproval(
            approve: { completion in
                approvalCalls += 1
                finishApproval = completion
            },
            onMigrationCompleted: { refreshCalls += 1 }
        )
        state.observe(.idle)
        guard !state.showsSettings, !state.showsMenuItem,
              !state.canReview, refreshCalls == 0
        else { return 1 }
        state.observe(KeychainMigrationStatus(
            pendingCount: 1, isRetrying: true, isApproving: false
        ))
        state.review { complete in
            confirmationCalls += 1
            complete(true)
        }
        guard state.showsSettings, !state.showsMenuItem,
              !state.canReview, confirmationCalls == 0, approvalCalls == 0,
              state.summaryKey == .settingsKeychainMigrationRetrying
        else { return 1 }
        state.observe(KeychainMigrationStatus(
            pendingCount: 1, isRetrying: false, isApproving: false
        ))
        guard state.showsMenuItem, state.canReview else { return 1 }

        var cancelledReview: ((Bool) -> Void)?
        state.review { complete in
            confirmationCalls += 1
            cancelledReview = complete
            complete(false)
            // A late/duplicate callback may not turn cancellation into approval.
            complete(true)
        }
        guard approvalCalls == 0, refreshCalls == 0,
              state.canReview, !state.lastApprovalDeferred
        else { return 1 }

        var staleReviewIgnored = false
        state.review { complete in
            cancelledReview?(true)
            staleReviewIgnored = approvalCalls == 0 && state.isReviewing
            complete(true)
        }
        state.review { complete in
            confirmationCalls += 1
            complete(true)
        }
        guard approvalCalls == 1, confirmationCalls == 1, staleReviewIgnored,
              state.approvalInFlight, !state.canReview,
              state.summaryKey == .settingsKeychainMigrationApproving
        else { return 1 }
        finishApproval?(false)
        finishApproval?(true)
        guard state.canReview, state.lastApprovalDeferred,
              state.summaryKey == .settingsKeychainMigrationDeferred,
              refreshCalls == 0
        else { return 1 }

        let staleApprovalCompletion = finishApproval
        state.review { complete in complete(true) }
        staleApprovalCompletion?(true)
        guard state.approvalInFlight else { return 1 }
        state.observe(KeychainMigrationStatus(
            pendingCount: 1, isRetrying: false, isApproving: true
        ))
        state.observe(.idle)
        finishApproval?(true)
        state.observe(.idle)
        guard approvalCalls == 2, refreshCalls == 1,
              !state.showsSettings, !state.showsMenuItem,
              !state.canReview, !state.lastApprovalDeferred
        else { return 1 }

        state.observe(KeychainMigrationStatus(
            pendingCount: 1, isRetrying: true, isApproving: false
        ))
        state.observe(.idle)
        state.observe(.idle)
        guard refreshCalls == 2, approvalCalls == 2 else { return 1 }

        var finishReview: ((Bool) -> Void)?
        state.observe(KeychainMigrationStatus(
            pendingCount: 1, isRetrying: false, isApproving: false
        ))
        state.review { finishReview = $0 }
        state.observe(.idle)
        finishReview?(true)
        guard approvalCalls == 2, refreshCalls == 3,
              !state.isReviewing, !state.approvalInFlight
        else { return 1 }
        print(
            "USAGE_MONITOR_MACOS_KEYCHAIN_MIGRATION_UI_CONTRACT "
                + "automatic_prompt=false retrying=quiet "
                + "cancel=preserved denial=preserved "
                + "approval=explicit duplicate_ignored=true "
                + "refresh=transition_only keychain_access=false"
        )
        return 0
    }
}

/// Exercises the complete persisted appearance contract in an isolated
/// defaults suite. This proves that explicit choices never depend on AppKit
/// timing, while System follows both light and dark effective appearances.
/// It does not mutate the developer's normal TiboTattle preference.
private enum NativeAppearanceSettingsContractSmokeTest {
    private static let suiteName =
        "com.usagemonitor.local.native-appearance-settings-contract"

    static func run() -> Int32 {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let aqua = NSAppearance(named: .aqua),
              let darkAqua = NSAppearance(named: .darkAqua)
        else {
            return 1
        }
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        guard NativeAppearancePreference.current(in: defaults) == .system,
              NativeAppearancePreference.system.applicationAppearance == nil,
              NativeAppearancePreference.system.resolvedTheme(for: aqua)
                == "light",
              NativeAppearancePreference.system.resolvedTheme(for: darkAqua)
                == "dark"
        else {
            return 1
        }

        NativeAppearancePreference.set(.light, in: defaults)
        defaults.synchronize()
        guard let reloaded = UserDefaults(suiteName: suiteName),
              NativeAppearancePreference.current(in: reloaded) == .light,
              NativeAppearancePreference.light.applicationAppearance?.name
                == .aqua,
              NativeAppearancePreference.light.resolvedTheme(for: darkAqua)
                == "light"
        else {
            return 1
        }

        NativeAppearancePreference.set(.dark, in: reloaded)
        reloaded.synchronize()
        guard let darkReloaded = UserDefaults(suiteName: suiteName),
              NativeAppearancePreference.current(in: darkReloaded) == .dark,
              NativeAppearancePreference.dark.applicationAppearance?.name
                == .darkAqua,
              NativeAppearancePreference.dark.resolvedTheme(for: aqua)
                == "dark"
        else {
            return 1
        }

        NativeAppearancePreference.set(.system, in: darkReloaded)
        darkReloaded.synchronize()
        guard let systemReloaded = UserDefaults(suiteName: suiteName),
              NativeAppearancePreference.current(in: systemReloaded) == .system
        else {
            return 1
        }

        systemReloaded.set(
            "unsupported",
            forKey: NativeAppearancePreference.defaultsKey
        )
        guard NativeAppearancePreference.current(in: systemReloaded) == .system
        else {
            return 1
        }

        print(
            "USAGE_MONITOR_MACOS_APPEARANCE_SETTINGS_CONTRACT "
                + "default=system persisted=light,dark,system "
                + "invalid=system system_resolution=light,dark "
                + "explicit_resolution=light,dark "
                + "appkit=system,aqua,darkAqua"
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

/// Exercises the closed refresh-progress projection without contacting the
/// companion. This proves that only allowlisted phases and bounded counts can
/// reach native presentation, while the existing idle/running contract remains
/// intact for unknown or forged fields.
private enum NativeAnalysisProgressContractSmokeTest {
    private static let refreshID = "123e4567-e89b-42d3-a456-426614174000"

    private static func decode(
        progress: [String: Any],
        status: String = "running"
    ) -> LocalAnalysisActivity? {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "refresh": [
                "status": status,
                "refreshId": refreshID,
                "progress": progress,
            ],
        ]) else {
            return nil
        }
        return LocalCompanionEvidenceReader.decodeActivity(data)
    }

    static func run() -> Int32 {
        let phases: [(String, LocalAnalysisProgress.Phase)] = [
            ("discovering", .discovering),
            ("rollout_index", .rolloutIndex),
            ("quota_refresh", .quotaRefresh),
            ("quick_result", .quickResult),
            ("complete", .complete),
            ("paused", .paused),
            ("prospective", .prospective),
        ]
        for (rawPhase, expectedPhase) in phases {
            guard case let .running(decodedRefreshID, progress, _) = decode(
                progress: ["phase": rawPhase]
            ),
                decodedRefreshID == refreshID,
                progress?.phase == expectedPhase,
                progress?.nativeToolbarTitle().isEmpty == false
            else {
                return failure("phase \(rawPhase)")
            }
        }

        guard case let .running(_, quickProgress, _) = decode(
            progress: ["phase": "quick_result"]
        ),
              quickProgress?.nativeToolbarTitle(
                hasUsableHeadlineEvidence: false
              ) == TiboTattleLocalization.string(
                .nativeDashboardProgressAnalyzing
              ),
              quickProgress?.nativeToolbarTitle(
                hasUsableHeadlineEvidence: true
              ) == TiboTattleLocalization.string(
                .nativeDashboardProgressQuickResult
              )
        else {
            return failure("quick result evidence gate")
        }

        let counted = decode(progress: [
            "phase": "rollout_index",
            "filesSelected": 180,
            "filesProcessed": 42,
            "message": "/Users/private/repository",
        ])
        let expectedCountedTitle = TiboTattleLocalization.format(
            .nativeDashboardProgressAnalyzingFiles,
            TiboTattleLocalization.integerString(42),
            TiboTattleLocalization.integerString(180)
        )
        guard case let .running(_, countedProgress, _) = counted,
              countedProgress == LocalAnalysisProgress(
                phase: .rolloutIndex,
                filesSelected: 180,
                filesProcessed: 42
              ),
              countedProgress?.nativeToolbarTitle() == expectedCountedTitle
        else {
            return failure("bounded counts")
        }

        let unified = decode(progress: [
            "kind": "unified_index",
            "status": "scanning",
            "phase": "rollout_index",
            "filesDiscovered": 240,
            "filesSelected": 180,
            "filesProcessed": 42,
            "recordsWritten": 9_000,
        ])
        guard case let .running(_, unifiedProgress, _) = unified,
              unifiedProgress == LocalAnalysisProgress(
                phase: .rolloutIndex,
                filesSelected: 180,
                filesProcessed: 42
              ),
              unifiedProgress?.nativeToolbarTitle() == expectedCountedTitle
        else {
            return failure("unified index counts")
        }

        let accountingMarker: [String: Any] = [
            "kind": "accounting",
            "status": "calculating",
        ]
        guard case let .running(_, accountingProgress, _) = decode(
            progress: accountingMarker
        ),
              accountingProgress == LocalAnalysisProgress(
                phase: .accounting,
                filesSelected: nil,
                filesProcessed: nil
              ),
              accountingProgress?.nativeToolbarTitle()
                == TiboTattleLocalization.string(
                    .nativeDashboardProgressAccounting
                ),
              accountingProgress?.nativeToolbarTitle(
                hasUsableHeadlineEvidence: true
              ) == accountingProgress?.nativeToolbarTitle()
        else {
            return failure("accounting work stage")
        }
        let invalidAccounting: [[String: Any]] = [
            ["kind": "accounting"],
            ["kind": "accounting", "status": "complete"],
            ["kind": "accounting", "status": "calculating", "phase": "quick_result"],
            ["kind": "accounting", "status": "calculating", "filesProcessed": 7, "filesSelected": 7_215],
            ["kind": "accounting", "status": "calculating", "message": "unreviewed prose"],
            ["phase": "accounting"],
        ]
        for invalid in invalidAccounting {
            guard case let .running(_, progress, _) = decode(progress: invalid),
                  progress == nil
            else {
                return failure("accounting exact-key boundary")
            }
        }
        for outcome in ["succeeded", "degraded", "failed", "cancelled"] {
            guard let terminal = LocalAnalysisTerminalOutcome(rawValue: outcome),
                  decode(progress: accountingMarker, status: outcome)
                    == .idle(refreshID: refreshID, outcome: terminal)
            else {
                return failure("accounting terminal boundary")
            }
        }

        let unifiedZero = decode(progress: [
            "kind": "unified_index",
            "status": "scanning",
            "phase": "rollout_index",
            "filesDiscovered": 0,
            "filesSelected": 0,
            "filesProcessed": 0,
            "recordsWritten": 0,
        ])
        guard case let .running(_, unifiedZeroProgress, _) = unifiedZero,
              unifiedZeroProgress?.nativeToolbarTitle()
                == TiboTattleLocalization.string(
                    .nativeDashboardProgressAnalyzing
                )
        else {
            return failure("unified index initial state")
        }

        let invalidUnified = decode(progress: [
            "kind": "unified_index",
            "status": "scanning",
            "phase": "rollout_index",
            "filesDiscovered": 100,
            "filesSelected": 101,
            "filesProcessed": 42,
            "recordsWritten": 9_000,
        ])
        let forgedUnified = decode(progress: [
            "kind": "unified_index",
            "status": "scanning",
            "phase": "rollout_index",
            "filesDiscovered": 240,
            "filesSelected": 180,
            "filesProcessed": 42,
            "recordsWritten": 9_000,
            "path": "/Users/private/repository",
        ])
        guard case let .running(_, invalidUnifiedProgress, _) = invalidUnified,
              invalidUnifiedProgress == nil,
              case let .running(_, forgedUnifiedProgress, _) = forgedUnified,
              forgedUnifiedProgress == nil
        else {
            return failure("unified index closed contract")
        }

        let unsafe = decode(progress: [
            "phase": "rollout_index",
            "filesSelected": 1_000_000_001,
            "filesProcessed": -1,
        ])
        guard case let .running(_, unsafeProgress, _) = unsafe,
              unsafeProgress?.filesSelected == nil,
              unsafeProgress?.filesProcessed == nil
        else {
            return failure("unsafe counts")
        }

        let malformed = decode(progress: [
            "phase": "rollout_index",
            "filesSelected": true,
            "filesProcessed": 4.5,
        ])
        guard case let .running(_, malformedProgress, _) = malformed,
              malformedProgress?.filesSelected == nil,
              malformedProgress?.filesProcessed == nil
        else {
            return failure("malformed counts")
        }

        let contradictory = decode(progress: [
            "phase": "rollout_index",
            "filesSelected": 2,
            "filesProcessed": 3,
        ])
        guard case let .running(_, contradictoryProgress, _) = contradictory,
              contradictoryProgress?.nativeToolbarTitle()
                == TiboTattleLocalization.string(
                    .nativeDashboardProgressAnalyzing
                )
        else {
            return failure("contradictory counts")
        }

        let archive = decode(progress: [
            "kind": "archive_index",
            "status": "scanning",
        ])
        guard case let .running(_, archiveProgress, _) = archive,
              archiveProgress?.phase == .archiveIndex
        else {
            return failure("archive phase")
        }

        let unknown = decode(progress: [
            "phase": "server_supplied_unreviewed_phase",
            "message": "server supplied prose",
        ])
        guard case let .running(_, unknownProgress, _) = unknown,
              unknownProgress == nil
        else {
            return failure("unknown phase")
        }

        guard decode(
            progress: ["phase": "discovering"],
            status: "succeeded"
        ) == .idle(refreshID: refreshID, outcome: .succeeded),
              LocalAnalysisTerminalOutcome.idle
                .automaticRefreshSuppressed == nil,
              LocalAnalysisTerminalOutcome.succeeded
                .automaticRefreshSuppressed == false,
              LocalAnalysisTerminalOutcome.degraded
                .automaticRefreshSuppressed == true,
              LocalAnalysisTerminalOutcome.cancelled
                .automaticRefreshSuppressed == true,
              LocalAnalysisTerminalOutcome.failed
                .automaticRefreshSuppressed == true,
              decode(
                progress: ["phase": "discovering"],
                status: "unreviewed_terminal"
              ) == nil
        else {
            return failure("idle contract")
        }

        let startedAt = "2026-09-01T12:00:00.000Z"
        let receiptDate = Date(timeIntervalSince1970: 1_788_264_000)
        for mode in ["quick", "detailed"] {
            for status in ["running", "succeeded", "failed", "cancelled"] {
                let payload: [String: Any] = ["refresh": [
                    "status": status,
                    "refreshId": refreshID,
                    "mode": mode,
                    "startedAt": startedAt,
                ]]
                guard let data = try? JSONSerialization.data(withJSONObject: payload),
                      let activity = LocalCompanionEvidenceReader.decodeActivity(data),
                      activity.attempt == LocalAnalysisAttempt(
                        mode: LocalAnalysisMode(rawValue: mode)!,
                        startedAt: receiptDate
                      )
                else { return failure("mode/start receipt") }
            }
        }
        let invalidReceipts: [[String: Any]] = [
            ["mode": "automatic", "startedAt": startedAt],
            ["mode": true, "startedAt": startedAt],
            ["mode": "detailed", "startedAt": "2026-09-01T12:00:00Z"],
            ["mode": "detailed", "startedAt": "not a timestamp"],
            ["mode": "detailed", "startedAt": 1_788_264_000],
            ["mode": "detailed"],
            ["startedAt": startedAt],
        ]
        for invalid in invalidReceipts {
            var refresh: [String: Any] = ["status": "running", "refreshId": refreshID]
            refresh.merge(invalid) { _, replacement in replacement }
            guard let data = try? JSONSerialization.data(withJSONObject: ["refresh": refresh]),
                  let activity = LocalCompanionEvidenceReader.decodeActivity(data),
                  activity.attempt == nil
            else { return failure("invalid mode/start receipt") }
        }

        print(
            "USAGE_MONITOR_MACOS_ANALYSIS_PROGRESS_CONTRACT "
                + "phases=allowlisted archive=scanning unified=scanning "
                + "accounting=calculating "
                + "counts=bounded quick_result=evidence-gated "
                + "contradictory=generic unknown=generic free_text=ignored "
                + "idle=unchanged terminal=automatic-backoff "
                + "attempt=mode-and-actual-start "
                + "percent=false eta=false"
        )
        return 0
    }

    private static func failure(_ detail: String) -> Int32 {
        FileHandle.standardError.write(
            Data("macOS analysis progress contract failed: \(detail)\n".utf8)
        )
        return 1
    }
}

/// Feeds the production JavaScript weekly-pace DTO into the exact native
/// decoder. The argument is accepted only by a development-channel bundle;
/// release and Preview bundles cannot turn an arbitrary file into app input.
private enum NativeWeeklyPaceProjectionContractSmokeTest {
    private static let maximumFixtureBytes = 64 * 1_024

    static func run(fixturePath: String) -> Int32 {
        guard BundledProduct.buildChannel == "development" else {
            return failure("development channel required")
        }
        guard !fixturePath.isEmpty,
              fixturePath.utf8.count <= 4_096,
              let handle = try? FileHandle(
                  forReadingFrom: URL(fileURLWithPath: fixturePath)
              )
        else {
            return failure("fixture unavailable")
        }
        defer { try? handle.close() }
        guard let data = try? handle.read(
                  upToCount: maximumFixtureBytes + 1
              ),
              !data.isEmpty,
              data.count <= maximumFixtureBytes,
              let outlook = MenuBarWeeklyPaceOutlookProjection.decode(data),
              outlook.status == .available,
              outlook.standing == .over,
              !outlook.critical,
              outlook.observationCount == 3,
              let hoursToReset = outlook.projection.hoursToReset,
              abs(hoursToReset - 100) <= 0.000_001,
              let ratio = outlook.rates.ratio,
              abs(ratio - 1.5) <= 0.000_001
        else {
            return failure("projection rejected")
        }

        let now = outlook.resetsAt.addingTimeInterval(
            -hoursToReset * 3_600
        )
        let exactLane = ObservedQuotaLane(
            label: "Seven-day allowance",
            remainingPercent: outlook.remainingPercent,
            durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
            resetAt: outlook.resetsAt,
            observedAt: now,
            isPrimary: false
        )
        let mismatchedRemainingLane = ObservedQuotaLane(
            label: exactLane.label,
            remainingPercent: exactLane.remainingPercent - 1,
            durationMinutes: exactLane.durationMinutes,
            resetAt: exactLane.resetAt,
            observedAt: exactLane.observedAt,
            isPrimary: exactLane.isPrimary
        )
        let mismatchedDurationLane = ObservedQuotaLane(
            label: exactLane.label,
            remainingPercent: exactLane.remainingPercent,
            durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
            resetAt: exactLane.resetAt,
            observedAt: exactLane.observedAt,
            isPrimary: exactLane.isPrimary
        )
        guard outlook.isBound(to: exactLane, now: now),
              !outlook.isBound(to: mismatchedRemainingLane, now: now),
              !outlook.isBound(to: mismatchedDurationLane, now: now),
              rejectsSchemaMutation(data)
        else {
            return failure("binding contract rejected")
        }

        print(
            "USAGE_MONITOR_MACOS_WEEKLY_PACE_PROJECTION_CONTRACT "
                + "schema=exact-v0.1 status=available standing=over "
                + "binding=exact mismatch=rejected "
                + "schema_mismatch=rejected"
        )
        return 0
    }

    private static func rejectsSchemaMutation(_ data: Data) -> Bool {
        guard var root = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              var weekly = root["weekly"] as? [String: Any],
              var outlook = weekly["paceOutlook"] as? [String: Any]
        else {
            return false
        }
        outlook["schemaVersion"] = "local-weekly-pace-outlook-v999"
        weekly["paceOutlook"] = outlook
        root["weekly"] = weekly
        guard let mutated = try? JSONSerialization.data(withJSONObject: root)
        else {
            return false
        }
        return MenuBarWeeklyPaceOutlookProjection.decode(mutated) == nil
    }

    private static func failure(_ detail: String) -> Int32 {
        FileHandle.standardError.write(Data(
            "macOS weekly pace projection contract failed: \(detail)\n".utf8
        ))
        return 1
    }
}

/// Exercises the real AppKit status item, popover, and native action menu
/// without starting the local companion or reading any private evidence.
@MainActor
private enum MenuBarContractSmokeTest {
    private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        return formatter.string(from: date)
    }

    private static func nullableNumber(_ value: Double?) -> Any {
        if let value { return NSNumber(value: value) }
        return NSNull()
    }

    private static func nullableString(_ value: String?) -> Any {
        if let value { return value }
        return NSNull()
    }

    private static func pricingCoverage(
        fully: Int = 0,
        partially: Int = 0,
        unpriced: Int = 0
    ) -> [String: Any] {
        [
            "fullyPricedEvents": fully,
            "partiallyPricedEvents": partially,
            "unpricedEvents": unpriced,
        ]
    }

    private static func periodRow(_ identifier: String) -> [String: Any] {
        [
            "periodId": identifier,
            "events": 0,
            "totalTokens": 0,
            "apiPriceEquivalentUsd": 0,
            "pricingCoverage": pricingCoverage(),
        ]
    }

    private static func quotaWindow(
        durationMinutes: Int,
        slot: String,
        usedPercent: Double,
        observedAt: Date,
        resetAt: Date
    ) -> [String: Any] {
        [
            "limitId": "codex",
            "slot": slot,
            "usedPercent": usedPercent,
            "remainingPercent": 100 - usedPercent,
            "durationMinutes": durationMinutes,
            "observedAt": iso8601(observedAt),
            "resetAt": iso8601(resetAt),
        ]
    }

    private static func availablePaceOutlook(
        now: Date,
        remainingPercent: Double,
        resetsAt: Date,
        headlineRate: Double,
        activeRate: Double? = nil,
        observationCount: Int = 8,
        earlyEstimate: Bool = false
    ) -> [String: Any] {
        let hoursToReset = resetsAt.timeIntervalSince(now) / 3_600
        let sustainableRate = remainingPercent / hoursToReset
        let ratio = headlineRate / sustainableRate
        let standing = ratio > 1.15 ? "over" : ratio < 0.85 ? "under" : "on"
        let coveredHours = min(
            hoursToReset,
            remainingPercent / headlineRate
        )
        let dryHours = max(0, hoursToReset - coveredHours)
        let sparePercent = max(
            0,
            remainingPercent - headlineRate * hoursToReset
        )
        let activeHours = activeRate.map { remainingPercent / $0 }
        let activeFraction = activeHours.flatMap { hours -> Double? in
            hours < coveredHours * 0.95
                ? max(0, min(1, hours / hoursToReset))
                : nil
        }
        return [
            "schemaVersion": "local-weekly-pace-outlook-v0.1",
            "status": "available",
            "standing": standing,
            "critical": standing == "over" && ratio >= 2,
            "earlyEstimate": earlyEstimate,
            "remainingPercent": remainingPercent,
            "resetsAt": iso8601(resetsAt),
            "observationCount": observationCount,
            "elapsedHours": 24.0,
            "rates": [
                "activePercentagePointsPerHour": nullableNumber(activeRate),
                "overallPercentagePointsPerHour": headlineRate,
                "headlinePercentagePointsPerHour": headlineRate,
                "sustainablePercentagePointsPerHour": sustainableRate,
                "ratio": ratio,
            ],
            "projection": [
                "hoursToReset": hoursToReset,
                "coveredHours": coveredHours,
                "dryHours": dryHours,
                "sparePercent": sparePercent,
                "projectedExhaustionAt": nullableString(
                    standing == "over"
                        ? iso8601(
                            now.addingTimeInterval(coveredHours * 3_600)
                        )
                        : nil
                ),
            ],
            "track": [
                "coveredFraction": coveredHours / hoursToReset,
                "activeExhaustionFraction": nullableNumber(activeFraction),
            ],
        ]
    }

    private static func collectingPaceOutlook(
        now: Date,
        remainingPercent: Double,
        resetsAt: Date
    ) -> [String: Any] {
        let hoursToReset = resetsAt.timeIntervalSince(now) / 3_600
        return [
            "schemaVersion": "local-weekly-pace-outlook-v0.1",
            "status": "collecting",
            "standing": NSNull(),
            "critical": false,
            "earlyEstimate": false,
            "remainingPercent": remainingPercent,
            "resetsAt": iso8601(resetsAt),
            "observationCount": 1,
            "elapsedHours": 0.0,
            "rates": [
                "activePercentagePointsPerHour": NSNull(),
                "overallPercentagePointsPerHour": NSNull(),
                "headlinePercentagePointsPerHour": NSNull(),
                "sustainablePercentagePointsPerHour": NSNull(),
                "ratio": NSNull(),
            ],
            "projection": [
                "hoursToReset": hoursToReset,
                "coveredHours": NSNull(),
                "dryHours": NSNull(),
                "sparePercent": NSNull(),
                "projectedExhaustionAt": NSNull(),
            ],
            "track": [
                "coveredFraction": NSNull(),
                "activeExhaustionFraction": NSNull(),
            ],
        ]
    }

    private static func decodePaceOutlook(
        _ value: [String: Any]
    ) -> MenuBarWeeklyPaceOutlook? {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "weekly": ["paceOutlook": value],
        ]) else {
            return nil
        }
        return MenuBarWeeklyPaceOutlookProjection.decode(data)
    }

    private static func paceOutlookProjectionContract(
        now: Date,
        weeklyLane: ObservedQuotaLane
    ) -> Bool {
        guard let resetsAt = weeklyLane.resetAt else { return false }
        let remaining = weeklyLane.remainingPercent
        let hoursToReset = resetsAt.timeIntervalSince(now) / 3_600
        let sustainable = remaining / hoursToReset
        let collecting = decodePaceOutlook(collectingPaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt
        ))
        let under = decodePaceOutlook(availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable * 0.7
        ))
        let on = decodePaceOutlook(availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable
        ))
        let over = decodePaceOutlook(availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable * 1.5,
            activeRate: sustainable * 2
        ))
        let critical = decodePaceOutlook(availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable * 2.2
        ))
        var malformed = availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable
        )
        malformed["account"] = "must-never-cross-this-projection"
        var zeroActive = availablePaceOutlook(
            now: now,
            remainingPercent: remaining,
            resetsAt: resetsAt,
            headlineRate: sustainable,
            activeRate: 0
        )
        if var rates = zeroActive["rates"] as? [String: Any] {
            rates["activePercentagePointsPerHour"] = 0.0
            zeroActive["rates"] = rates
        }
        var mismatchedLane = weeklyLane
        mismatchedLane = ObservedQuotaLane(
            label: mismatchedLane.label,
            remainingPercent: mismatchedLane.remainingPercent - 1,
            durationMinutes: mismatchedLane.durationMinutes,
            resetAt: mismatchedLane.resetAt,
            observedAt: mismatchedLane.observedAt,
            isPrimary: mismatchedLane.isPrimary
        )
        return collecting?.status == .collecting
            && collecting?.elapsedHours == 0
            && collecting?.isBound(to: weeklyLane, now: now) == true
            && under?.standing == .under
            && on?.standing == .on
            && over?.standing == .over
            && over?.critical == false
            && over?.track.activeExhaustionFraction != nil
            && critical?.standing == .over
            && critical?.critical == true
            && critical?.isBound(to: mismatchedLane, now: now) == false
            && decodePaceOutlook(malformed) == nil
            && decodePaceOutlook(zeroActive) == nil
    }

    private static func timelineBucket(
        startAt: Date,
        endAt: Date
    ) -> [String: Any] {
        [
            "startAt": iso8601(startAt),
            "endAt": iso8601(endAt),
            "usageEvents": 0,
            "totalTokens": 0,
            "apiPriceEquivalentUsd": 0,
            "pricingCoverage": pricingCoverage(),
        ]
    }

    private static func overviewFixture(
        now: Date,
        calendar: Calendar,
        quotaWindows: [[String: Any]]? = nil,
        accountingSource: String = "legacy",
        generationMatched: Bool = true,
        timelineUsage: [[String: Any]] = []
    ) -> [String: Any] {
        let observedAt = now.addingTimeInterval(-60)
        let today = calendar.startOfDay(for: now)
        let coverageStart = calendar.date(
            byAdding: .day,
            value: -29,
            to: today
        )!
        var accounting: [String: Any] = [
            "sourceMode": accountingSource,
            "periods": [
                periodRow("24h"),
                periodRow("7d"),
                periodRow("30d"),
            ],
        ]
        if accountingSource == "unified" {
            accounting["generationMatched"] = generationMatched
        }
        return [
            "status": "live",
            "evidenceStatus": "available",
            "freshness": [
                "status": "live",
                "staleAfterSeconds": 30 * 60,
                "accountingStatus": "available",
            ],
            "quotaWindows": quotaWindows ?? [
                quotaWindow(
                    durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                    slot: "secondary",
                    usedPercent: 29,
                    observedAt: observedAt,
                    resetAt: observedAt.addingTimeInterval(5 * 24 * 60 * 60)
                ),
                quotaWindow(
                    durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
                    slot: "primary",
                    usedPercent: 37,
                    observedAt: observedAt,
                    resetAt: observedAt.addingTimeInterval(2 * 60 * 60)
                ),
                quotaWindow(
                    durationMinutes: 30 * 24 * 60,
                    slot: "primary",
                    usedPercent: 12,
                    observedAt: observedAt,
                    resetAt: observedAt.addingTimeInterval(10 * 24 * 60 * 60)
                ),
                quotaWindow(
                    durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
                    slot: "secondary",
                    usedPercent: 38,
                    observedAt: observedAt.addingTimeInterval(-60),
                    resetAt: observedAt.addingTimeInterval(90 * 60)
                ),
            ],
            "accounting": accounting,
            "timeline": [
                "source": "replay_safe_cache",
                "bucketMinutes": 15,
                "coveredAt": [
                    "startAt": iso8601(coverageStart),
                    "endAt": iso8601(now),
                ],
                "usage": timelineUsage,
                "history": ["status": "complete"],
            ],
        ]
    }

    private static func decodeOverview(
        _ root: [String: Any],
        now: Date,
        calendar: Calendar
    ) -> LocalCompanionOverview? {
        guard let data = try? JSONSerialization.data(withJSONObject: root) else {
            return nil
        }
        return LocalCompanionOverviewProjection.decode(
            data,
            now: now,
            calendar: calendar
        )
    }

    private static func retainedHistoryProjectionContract() -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        guard let timeZone = TimeZone(identifier: "America/Los_Angeles") else {
            return false
        }
        calendar.timeZone = timeZone
        let parser = ISO8601DateFormatter()
        // Re-read two days later, across both midnight and the spring DST
        // transition. Retained rolling periods must keep their original bars.
        guard let retainedAt = parser.date(from: "2026-03-08T08:10:00Z"),
              let now = parser.date(from: "2026-03-10T19:00:00Z")
        else { return false }
        var bucket = timelineBucket(
            startAt: retainedAt.addingTimeInterval(-70 * 60),
            endAt: retainedAt.addingTimeInterval(-55 * 60)
        )
        let coverage = pricingCoverage(fully: 1, partially: 1, unpriced: 1)
        bucket["usageEvents"] = 3
        bucket["totalTokens"] = 3_000
        bucket["apiPriceEquivalentUsd"] = 0.50
        bucket["pricingCoverage"] = coverage
        var previous = overviewFixture(
            now: retainedAt,
            calendar: calendar,
            accountingSource: "unified",
            timelineUsage: [bucket]
        )
        guard var accounting = previous["accounting"] as? [String: Any],
              let timeline = previous["timeline"] as? [String: Any]
        else { return false }
        accounting["periods"] = ["24h", "7d", "30d"].map { identifier in
            var row = periodRow(identifier)
            row["events"] = 3
            row["totalTokens"] = 3_000
            row["apiPriceEquivalentUsd"] = 0.50
            row["pricingCoverage"] = coverage
            return row
        }
        previous["accounting"] = accounting
        guard let verified = decodeOverview(
            previous, now: retainedAt, calendar: calendar
        ), verified.history.accountingStatus == .current else { return false }

        var retained = previous
        retained["freshness"] = ["accountingStatus": "unavailable"]
        accounting["generationMatched"] = false
        let projection: [String: Any] = [
            "status": "retained",
            "reason": "local_unified_index_deferred",
            "terminal": false,
            "retainedAt": iso8601(retainedAt),
            "coveredAt": timeline["coveredAt"]!,
        ]
        accounting["projection"] = projection
        retained["accounting"] = accounting
        let expected = verified.history.retainingLastVerified()
        guard let held = decodeOverview(retained, now: now, calendar: calendar),
              held.history == expected,
              held.history.lastSevenDays?.totalTokens == 3_000,
              held.history.lastThirtyDays?.knownAPIPriceEquivalentUSD == 0.50,
              held.history.lastSevenDays?.pricingCoverage.isComplete == false,
              held.history.sevenDayHistory.contains(where: {
                $0.totalTokens == 3_000
              })
        else { return false }

        func withProjection(_ value: Any) -> [String: Any] {
            var root = retained
            var valueAccounting = accounting
            valueAccounting["projection"] = value
            root["accounting"] = valueAccounting
            return root
        }
        var terminal = projection
        terminal["terminal"] = true
        guard decodeOverview(
            withProjection(terminal), now: now, calendar: calendar
        )?.history == expected else { return false }

        // A marker never overrides malformed provenance, chronology, periods,
        // or timeline coverage. No generation mismatch alone admits history.
        var invalidRoots = [withProjection(NSNull())]
        let invalidFields: [(String, Any)] = [
            ("status", "unavailable"),
            ("terminal", "false"),
            ("terminal", 1),
            ("retainedAt", NSNull()),
            ("retainedAt", "not-a-date"),
            ("retainedAt", iso8601(now.addingTimeInterval(60))),
            ("coveredAt", ["startAt": NSNull(), "endAt": NSNull()]),
            ("coveredAt", [
                "startAt": iso8601(retainedAt),
                "endAt": iso8601(retainedAt.addingTimeInterval(60)),
            ]),
            ("coveredAt", [
                "startAt": iso8601(retainedAt),
                "endAt": iso8601(retainedAt.addingTimeInterval(-60)),
            ]),
        ]
        for (key, value) in invalidFields {
            var invalid = projection
            invalid[key] = value
            invalidRoots.append(withProjection(invalid))
        }
        for (key, value) in [
            ("generationMatched", true as Any),
            ("generationMatched", "false" as Any),
            ("sourceMode", "legacy" as Any),
            ("periods", [periodRow("24h")] as Any),
        ] {
            var invalid = retained
            var invalidAccounting = accounting
            invalidAccounting[key] = value
            invalid["accounting"] = invalidAccounting
            invalidRoots.append(invalid)
        }
        var missingTimelineCoverage = retained
        var invalidTimeline = timeline
        invalidTimeline["coveredAt"] = ["startAt": NSNull(), "endAt": NSNull()]
        missingTimelineCoverage["timeline"] = invalidTimeline
        invalidRoots.append(missingTimelineCoverage)
        return invalidRoots.allSatisfy { root in
            guard let decoded = decodeOverview(root, now: now, calendar: calendar)
            else { return false }
            return decoded.history.accountingStatus == .unavailable
                && decoded.history.lastSevenDays == nil
                && decoded.history.lastThirtyDays == nil
        }
    }

    private static func mouseDismissalContract() -> Bool {
        let targets: [MenuBarMouseTarget] = [
            .popover, .statusItem, .applicationWindow, .outside,
        ]
        let cases: [(menu: Bool, popover: Bool, expected: [Bool])] = [
            (false, false, [false, false, false, false]),
            (true, false, [false, false, true, false]),
            (false, true, [false, false, true, true]),
            (true, true, [false, false, true, true]),
        ]
        return cases.allSatisfy { state in
            zip(targets, state.expected).allSatisfy { target, expected in
                menuBarShouldDismissForMouse(
                    target: target,
                    isMenuTracking: state.menu,
                    isPopoverShown: state.popover
                ) == expected
            }
        }
    }

    private static func semanticProjectionContract() -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        guard let timeZone = TimeZone(identifier: "America/Los_Angeles") else {
            return false
        }
        calendar.timeZone = timeZone
        let parser = ISO8601DateFormatter()
        guard let now = parser.date(from: "2026-03-10T19:00:00Z"),
              let overview = decodeOverview(
                overviewFixture(now: now, calendar: calendar),
                now: now,
                calendar: calendar
              )
        else {
            return false
        }
        let laneDurations = overview.lanes.map(\.durationMinutes)
        let currentDay = overview.history.thirtyDayHistory.last
        let hasSpringForwardDay = overview.history.thirtyDayHistory.contains {
            abs($0.endAt.timeIntervalSince($0.startAt) - 23 * 60 * 60) < 0.1
        }
        guard laneDurations == [
                CodexQuotaWindowDuration.sevenDayMinutes,
                CodexQuotaWindowDuration.fiveHourMinutes,
              ],
              overview.lanes.count == 2,
              LocalCompanionOverviewProjection.evidence(
                for: overview,
                now: now
              ) == .live,
              overview.history.accountingStatus == .current,
              overview.history.sevenDayHistory.count == 7,
              overview.history.thirtyDayHistory.count == 30,
              currentDay?.evidence == .partial,
              currentDay?.totalTokens == nil,
              overview.history.thirtyDayHistory.dropLast().allSatisfy({
                $0.evidence == .available && $0.totalTokens == 0
              }),
              hasSpringForwardDay
        else {
            return false
        }

        let observedAt = now.addingTimeInterval(-60)
        let staleFiveHourObservation = now.addingTimeInterval(-60 * 60)
        let mixedAgeWindows = [
            quotaWindow(
                durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                slot: "secondary",
                usedPercent: 29,
                observedAt: observedAt,
                resetAt: observedAt.addingTimeInterval(5 * 24 * 60 * 60)
            ),
            quotaWindow(
                durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
                slot: "primary",
                usedPercent: 37,
                observedAt: staleFiveHourObservation,
                resetAt: staleFiveHourObservation.addingTimeInterval(2 * 60 * 60)
            ),
        ]
        guard let mixedAgeOverview = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                quotaWindows: mixedAgeWindows
            ),
            now: now,
            calendar: calendar
        ) else { return false }
        var mixedAgeSnapshot = MenuBarStatusSnapshot()
        mixedAgeSnapshot.phase = .ready
        mixedAgeSnapshot.evidence = LocalCompanionOverviewProjection.evidence(
            for: mixedAgeOverview,
            now: now
        )
        mixedAgeSnapshot.lanes = mixedAgeOverview.lanes
        mixedAgeSnapshot.observedAt = mixedAgeOverview.observedAt
        mixedAgeSnapshot.staleAfterSeconds = mixedAgeOverview.staleAfterSeconds
        guard mixedAgeSnapshot.currentLanes(now: now).map(\.durationMinutes) == [
            CodexQuotaWindowDuration.sevenDayMinutes,
        ] else { return false }

        // During the historical secondary -> primary slot transition the
        // companion can briefly expose both representations. The canonical
        // JS pace forecast chooses primary, so the overview lane must make the
        // same choice or exact reset/remaining binding would hide the card.
        let primaryWeeklyReset = now.addingTimeInterval(4 * 24 * 60 * 60)
        let dualWeeklyWindows = [
            quotaWindow(
                durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                slot: "secondary",
                usedPercent: 29,
                observedAt: observedAt.addingTimeInterval(30),
                resetAt: now.addingTimeInterval(5 * 24 * 60 * 60)
            ),
            quotaWindow(
                durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                slot: "primary",
                usedPercent: 31,
                observedAt: observedAt,
                resetAt: primaryWeeklyReset
            ),
        ]
        guard let dualWeeklyOverview = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                quotaWindows: dualWeeklyWindows
            ),
            now: now,
            calendar: calendar
        ),
        dualWeeklyOverview.lanes.count == 1,
        let dualWeeklyLane = dualWeeklyOverview.lanes.first,
        dualWeeklyLane.remainingPercent == 69,
        dualWeeklyLane.resetAt == primaryWeeklyReset
        else { return false }
        var dualWeeklySnapshot = MenuBarStatusSnapshot()
        dualWeeklySnapshot.phase = .ready
        dualWeeklySnapshot.evidence = .live
        dualWeeklySnapshot.lanes = dualWeeklyOverview.lanes
        dualWeeklySnapshot.staleAfterSeconds = 30 * 60
        dualWeeklySnapshot.weeklyPaceOutlook = decodePaceOutlook(
            availablePaceOutlook(
                now: now,
                remainingPercent: 69,
                resetsAt: primaryWeeklyReset,
                headlineRate: 1
            )
        )
        guard dualWeeklySnapshot.currentWeeklyPaceOutlook(now: now) != nil
        else { return false }

        var futureWindows = mixedAgeWindows
        let futureObservedAt = now.addingTimeInterval(60)
        futureWindows[0] = quotaWindow(
            durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
            slot: "secondary",
            usedPercent: 29,
            observedAt: futureObservedAt,
            resetAt: futureObservedAt.addingTimeInterval(24 * 60 * 60)
        )
        futureWindows[1] = quotaWindow(
            durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
            slot: "primary",
            usedPercent: 37,
            observedAt: futureObservedAt,
            resetAt: futureObservedAt.addingTimeInterval(2 * 60 * 60)
        )
        guard let futureOverview = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                quotaWindows: futureWindows
            ),
            now: now,
            calendar: calendar
        ),
        LocalCompanionOverviewProjection.evidence(
            for: futureOverview,
            now: now
        ) != .live else { return false }

        var invalidComplement = mixedAgeWindows[0]
        invalidComplement["remainingPercent"] = 72
        guard let complementOverview = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                quotaWindows: [invalidComplement, mixedAgeWindows[1]]
            ),
            now: now,
            calendar: calendar
        ),
        complementOverview.lanes.map(\.durationMinutes) == [
            CodexQuotaWindowDuration.fiveHourMinutes,
        ] else { return false }

        guard let unmatchedUnified = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                accountingSource: "unified",
                generationMatched: false
            ),
            now: now,
            calendar: calendar
        ),
        unmatchedUnified.history.accountingStatus == .unavailable,
        unmatchedUnified.history.lastSevenDays == nil else { return false }

        let bucketStart = calendar.startOfDay(for: now)
        let bucketEnd = bucketStart.addingTimeInterval(15 * 60)
        let duplicateBucket = timelineBucket(
            startAt: bucketStart,
            endAt: bucketEnd
        )
        guard let overlappingTimeline = decodeOverview(
            overviewFixture(
                now: now,
                calendar: calendar,
                timelineUsage: [duplicateBucket, duplicateBucket]
            ),
            now: now,
            calendar: calendar
        ),
        overlappingTimeline.history.accountingStatus == .unavailable,
        overlappingTimeline.history.lastSevenDays == nil else { return false }

        func historyFailsClosed(_ root: [String: Any]) -> Bool {
            guard let decoded = decodeOverview(
                root,
                now: now,
                calendar: calendar
            ) else { return false }
            return decoded.history.accountingStatus == .unavailable
                && decoded.history.lastSevenDays == nil
                && decoded.history.lastThirtyDays == nil
        }
        var missingPeriodRoot = overviewFixture(now: now, calendar: calendar)
        guard var missingPeriodAccounting = missingPeriodRoot["accounting"]
            as? [String: Any]
        else { return false }
        missingPeriodAccounting["periods"] = [
            periodRow("24h"),
            periodRow("7d"),
        ]
        missingPeriodRoot["accounting"] = missingPeriodAccounting

        var invalidCoverageRoot = overviewFixture(now: now, calendar: calendar)
        guard var invalidCoverageAccounting = invalidCoverageRoot["accounting"]
            as? [String: Any]
        else { return false }
        var invalidCoveragePeriod = periodRow("7d")
        invalidCoveragePeriod["events"] = 1
        invalidCoveragePeriod["totalTokens"] = 1_000
        invalidCoveragePeriod["apiPriceEquivalentUsd"] = 0.01
        // The coverage sum deliberately disagrees with the one event.
        invalidCoveragePeriod["pricingCoverage"] = pricingCoverage()
        invalidCoverageAccounting["periods"] = [
            periodRow("24h"),
            invalidCoveragePeriod,
            periodRow("30d"),
        ]
        invalidCoverageRoot["accounting"] = invalidCoverageAccounting

        func timelineRoot(
            source: String = "replay_safe_cache",
            bucketMinutes: Int
        ) -> [String: Any]? {
            var root = overviewFixture(now: now, calendar: calendar)
            guard var timeline = root["timeline"] as? [String: Any] else {
                return nil
            }
            timeline["source"] = source
            timeline["bucketMinutes"] = bucketMinutes
            root["timeline"] = timeline
            return root
        }
        guard let zeroBucketRoot = timelineRoot(bucketMinutes: 0),
              let oversizedBucketRoot = timelineRoot(
                bucketMinutes: 24 * 60 + 1
              ),
              let insufficientEvidenceRoot = timelineRoot(
                source: "insufficient_evidence",
                bucketMinutes: 15
              ),
              historyFailsClosed(missingPeriodRoot),
              historyFailsClosed(invalidCoverageRoot),
              historyFailsClosed(zeroBucketRoot),
              historyFailsClosed(oversizedBucketRoot),
              historyFailsClosed(insufficientEvidenceRoot)
        else { return false }

        let weeklyReset = now.addingTimeInterval(5 * 24 * 60 * 60)
        let fiveHourReset = now.addingTimeInterval(2 * 60 * 60)
        let boundaryLanes = [
            ObservedQuotaLane(
                label: "weekly",
                remainingPercent: 70,
                durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                resetAt: weeklyReset,
                observedAt: now,
                isPrimary: true
            ),
            ObservedQuotaLane(
                label: "five-hour",
                remainingPercent: 70,
                durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
                resetAt: fiveHourReset,
                observedAt: now,
                isPrimary: false
            ),
        ]
        guard let expiringOutlook = decodePaceOutlook(
            availablePaceOutlook(
                now: now,
                remainingPercent: 70,
                resetsAt: weeklyReset,
                headlineRate: 70
            )
        ),
        let projectedExhaustion = expiringOutlook.projection
            .projectedExhaustionAt,
        let collectingOutlook = decodePaceOutlook(
            collectingPaceOutlook(
                now: now,
                remainingPercent: 70,
                resetsAt: weeklyReset
            )
        )
        else { return false }
        return nextEvidencePresentationBoundary(
            lanes: boundaryLanes,
            staleAfterSeconds: 10 * 24 * 60 * 60,
            now: now
        ) == fiveHourReset
            && nextEvidencePresentationBoundary(
                lanes: boundaryLanes,
                staleAfterSeconds: 10 * 24 * 60 * 60,
                weeklyPaceOutlook: expiringOutlook,
                now: now
            ) == projectedExhaustion
            && nextEvidencePresentationBoundary(
                lanes: [boundaryLanes[0]],
                staleAfterSeconds: 10 * 24 * 60 * 60,
                weeklyPaceOutlook: collectingOutlook,
                now: now
            ) == weeklyReset
            && menuBarStatusActivationIntent(
                eventType: .leftMouseUp,
                modifierFlags: []
            ) == .popover
            && menuBarStatusActivationIntent(
                eventType: .rightMouseUp,
                modifierFlags: []
            ) == .actionMenu
            && menuBarStatusActivationIntent(
                eventType: .leftMouseUp,
                modifierFlags: [.control]
            ) == .actionMenu
            && menuBarShouldDismissForEscape(
                keyCode: 53,
                isMenuTracking: false,
                isPopoverShown: true
            )
    }

    static func run() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let durationSeconds = TimeInterval(
            CodexQuotaWindowDuration.sevenDayMinutes * 60
        )
        // The compact title intentionally checks freshness against the real
        // presentation clock. Anchor this compiled smoke to one captured now
        // instead of a fixed epoch, while retaining the exact 24%-elapsed
        // weekly position used by the assertions below.
        let observedAt = Date()
        let resetAt = observedAt.addingTimeInterval(
            durationSeconds * 0.76
        )
        let weeklyLane = ObservedQuotaLane(
            label: TiboTattleLocalization.string(.menuBarSevenDayAllowance),
            remainingPercent: 71,
            durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
            resetAt: resetAt,
            observedAt: observedAt,
            isPrimary: true
        )
        let fiveHourLane = ObservedQuotaLane(
            label: TiboTattleLocalization.string(.menuBarFiveHourAllowance),
            remainingPercent: 63,
            durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
            resetAt: observedAt.addingTimeInterval(2 * 60 * 60),
            observedAt: observedAt,
            isPrimary: false
        )
        let weeklyPosition = weeklyWindowPosition(weeklyLane)
        var liveSnapshot = MenuBarStatusSnapshot()
        liveSnapshot.phase = .ready
        liveSnapshot.evidence = .live
        liveSnapshot.lanes = [weeklyLane, fiveHourLane]
        liveSnapshot.observedAt = observedAt
        liveSnapshot.staleAfterSeconds = 30 * 60
        liveSnapshot.analysisAvailable = true
        liveSnapshot.weeklyPaceOutlook = decodePaceOutlook(
            availablePaceOutlook(
                now: observedAt,
                remainingPercent: weeklyLane.remainingPercent,
                resetsAt: resetAt,
                headlineRate: 0.9,
                activeRate: 1.2
            )
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = calendar.startOfDay(for: observedAt)
        let historyDays = (0..<30).compactMap { index -> MenuBarHistoryDay? in
            guard let startAt = calendar.date(
                byAdding: .day,
                value: index - 29,
                to: today
            ), let endAt = calendar.date(
                byAdding: .day,
                value: 1,
                to: startAt
            ) else { return nil }
            let events = Int64(index + 1)
            return MenuBarHistoryDay(
                startAt: startAt,
                endAt: endAt,
                evidence: index == 29 ? .partial : .available,
                usageEvents: events,
                totalTokens: events * 1_000_000,
                knownAPIPriceEquivalentUSD: Double(events) * 0.25,
                pricingCoverage: MenuBarPricingCoverage(
                    fullyPricedEvents: events,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 0
                )
            )
        }
        let sevenDayPeriod = MenuBarRollingPeriod(
            window: .lastSevenDays,
            events: 189,
            totalTokens: 189_000_000,
            knownAPIPriceEquivalentUSD: 47.25,
            pricingCoverage: MenuBarPricingCoverage(
                fullyPricedEvents: 189,
                partiallyPricedEvents: 0,
                unpricedEvents: 0
            )
        )
        liveSnapshot.history = MenuBarHistorySnapshot(
            accountingStatus: .current,
            last24Hours: MenuBarRollingPeriod(
                window: .last24Hours,
                events: 30,
                totalTokens: 30_000_000,
                knownAPIPriceEquivalentUSD: 7.50,
                pricingCoverage: MenuBarPricingCoverage(
                    fullyPricedEvents: 30,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 0
                )
            ),
            lastSevenDays: sevenDayPeriod,
            lastThirtyDays: MenuBarRollingPeriod(
                window: .lastThirtyDays,
                events: 465,
                totalTokens: 465_000_000,
                knownAPIPriceEquivalentUSD: 116.25,
                pricingCoverage: MenuBarPricingCoverage(
                    fullyPricedEvents: 465,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 0
                )
            ),
            sevenDayHistory: Array(historyDays.suffix(7)),
            thirtyDayHistory: historyDays
        )
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
        var analyzingLiveSnapshot = liveSnapshot
        analyzingLiveSnapshot.phase = .analyzing
        var analyzingWithoutLiveEvidence = MenuBarStatusSnapshot()
        analyzingWithoutLiveEvidence.phase = .analyzing
        var unavailableLiveSnapshot = liveSnapshot
        unavailableLiveSnapshot.phase = .unavailable
        let reset = resetCountdown(resetAt, now: observedAt)
        let expectedLiveTitle = TiboTattleLocalization.percentString(71)
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
        // The normal app runs its event loop before any status-button click.
        // This synchronous smoke must let AppKit attach the real status item
        // first; a missing or unshowable item still fails the bounded check.
        application.finishLaunching()
        let openDeadline = Date().addingTimeInterval(2)
        var didShowPopover = controller.showPopoverForSmokeTest()
        while !didShowPopover && Date() < openDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            didShowPopover = controller.showPopoverForSmokeTest()
        }
        let shown = controller.nativePresentationContract()
        controller.shutDown()
        let stopped = controller.nativePresentationContract()
        let reopenedAfterShutdown = controller.showPopoverForSmokeTest()
        let dismissalLifecycleChecks = [
            ("initial-monitor-absent", !starting.outsideClickAwayMonitorInstalled),
            ("popover-opened", didShowPopover && shown.popoverIsShown),
            ("open-monitor-installed", shown.outsideClickAwayMonitorInstalled),
            ("shutdown-outside-monitor-removed", !stopped.outsideClickAwayMonitorInstalled),
            ("shutdown-local-monitor-removed", !stopped.sameAppClickAwayMonitorInstalled),
            ("shutdown-escape-monitor-removed", !stopped.escapeDismissalMonitorInstalled),
            ("shutdown-observer-removed", !stopped.appDeactivationDismissalObserverInstalled),
            ("shutdown-cannot-reopen", !reopenedAfterShutdown),
        ]
        if let failed = dismissalLifecycleChecks.first(where: { !$0.1 }) {
            FileHandle.standardError.write(Data(
                "macOS menu bar dismissal smoke failed: \(failed.0)\n".utf8
            ))
            return 1
        }
        let popup = MenuBarPopoverViewController(
            productName: BundledProduct.displayName,
            brandImage: NSApp.applicationIconImage,
            actions: MenuBarPopoverViewController.Actions(
                openTiboTattle: {},
                refresh: {},
                showMore: { _ in }
            )
        )
        popup.update(snapshot: liveSnapshot, now: observedAt)
        let sevenDayPopup = popup.nativePresentationContract()
        let overflowPopup = MenuBarPopoverViewController(
            productName: BundledProduct.displayName,
            brandImage: NSApp.applicationIconImage,
            actions: MenuBarPopoverViewController.Actions(
                openTiboTattle: {},
                refresh: {},
                showMore: { _ in }
            )
        )
        var oneLaneSnapshot = liveSnapshot
        oneLaneSnapshot.lanes = [weeklyLane]
        let syntheticVisibleFrame = NSRect(
            x: 0,
            y: 40,
            width: 1_440,
            height: 800
        )
        let syntheticAnchorMinY: CGFloat = 428
        overflowPopup.update(snapshot: oneLaneSnapshot, now: observedAt)
        let oneLaneViewportCap = overflowPopup.prepareForPresentationForSmokeTest(
            anchorMinY: syntheticAnchorMinY,
            visibleFrame: syntheticVisibleFrame
        )
        let oneLaneOverflowAtTop = overflowPopup.nativePresentationContract()
        overflowPopup.scrollToVerticalOffsetForSmokeTest(72)
        let oneLaneOverflowScrolled = overflowPopup.nativePresentationContract()
        overflowPopup.update(snapshot: liveSnapshot, now: observedAt)
        let twoLaneOverflowPreserved = overflowPopup.nativePresentationContract()
        overflowPopup.scrollToBottomForSmokeTest()
        let twoLaneOverflowAtBottom = overflowPopup.nativePresentationContract()
        let twoLaneViewportCap = overflowPopup.prepareForPresentationForSmokeTest(
            anchorMinY: syntheticAnchorMinY,
            visibleFrame: syntheticVisibleFrame
        )
        let twoLaneOverflowAtTop = overflowPopup.nativePresentationContract()
        popup.selectHistoryRangeForSmokeTest(.thirtyDays)
        let thirtyDayPopup = popup.nativePresentationContract()
        popup.update(snapshot: analyzingLiveSnapshot, now: observedAt)
        let updatingThirtyDayPopup = popup.nativePresentationContract()
        popup.selectHistoryRangeForSmokeTest(.sevenDays)
        let updatingSevenDayPopup = popup.nativePresentationContract()
        popup.selectHistoryRangeForSmokeTest(.thirtyDays)
        var readFailureSnapshot = liveSnapshot
        readFailureSnapshot.invalidateObservedEvidence(keepingHistory: true)
        readFailureSnapshot.phase = .unavailable
        popup.update(snapshot: readFailureSnapshot, now: observedAt)
        let readFailurePopup = popup.nativePresentationContract()
        let retainedHistory = readFailureSnapshot.history
        readFailureSnapshot.invalidateObservedEvidence(keepingHistory: true)
        let repeatedFailurePreservesHistory = readFailureSnapshot.history == retainedHistory
        popup.update(snapshot: liveSnapshot, now: observedAt)
        let recoveredPopup = popup.nativePresentationContract()
        var restartedSnapshot = liveSnapshot
        restartedSnapshot.invalidateObservedEvidence()
        popup.update(snapshot: restartedSnapshot, now: observedAt)
        let restartedPopup = popup.nativePresentationContract()
        var failedFirstRunSnapshot = MenuBarStatusSnapshot()
        failedFirstRunSnapshot.invalidateObservedEvidence(keepingHistory: true)
        func historyWithSevenDayCoverage(
            _ coverage: MenuBarPricingCoverage,
            knownCost: Double
        ) -> MenuBarHistorySnapshot {
            MenuBarHistorySnapshot(
                accountingStatus: .current,
                last24Hours: liveSnapshot.history.last24Hours,
                lastSevenDays: MenuBarRollingPeriod(
                    window: .lastSevenDays,
                    events: coverage.fullyPricedEvents
                        + coverage.partiallyPricedEvents
                        + coverage.unpricedEvents,
                    totalTokens: 12_000_000,
                    knownAPIPriceEquivalentUSD: knownCost,
                    pricingCoverage: coverage
                ),
                lastThirtyDays: liveSnapshot.history.lastThirtyDays,
                sevenDayHistory: liveSnapshot.history.sevenDayHistory,
                thirtyDayHistory: liveSnapshot.history.thirtyDayHistory
            )
        }
        popup.selectHistoryRangeForSmokeTest(.sevenDays)
        var partialPricingSnapshot = liveSnapshot
        partialPricingSnapshot.history = historyWithSevenDayCoverage(
            MenuBarPricingCoverage(
                fullyPricedEvents: 4,
                partiallyPricedEvents: 1,
                unpricedEvents: 1
            ),
            knownCost: 2.50
        )
        popup.update(snapshot: partialPricingSnapshot, now: observedAt)
        let partialPricingPopup = popup.nativePresentationContract()
        var unpricedSnapshot = liveSnapshot
        unpricedSnapshot.history = historyWithSevenDayCoverage(
            MenuBarPricingCoverage(
                fullyPricedEvents: 0,
                partiallyPricedEvents: 0,
                unpricedEvents: 6
            ),
            knownCost: 0
        )
        popup.update(snapshot: unpricedSnapshot, now: observedAt)
        let unpricedPopup = popup.nativePresentationContract()
        var noCompanionSnapshot = MenuBarStatusSnapshot()
        noCompanionSnapshot.phase = .unavailable
        popup.update(snapshot: noCompanionSnapshot, now: observedAt)
        let noCompanionPopup = popup.nativePresentationContract()
        let overflowGeometryChecks: [(String, Bool)] = [
            ("natural-two-lane-fits-without-cap", !sevenDayPopup.verticalScrollingRequired),
            ("natural-two-lane-starts-at-top", sevenDayPopup.contentStartsAtTop),
            ("one-lane-count", oneLaneOverflowAtTop.visibleAllowanceLaneCount == 1),
            ("one-lane-overflows", oneLaneOverflowAtTop.verticalScrollingRequired),
            ("one-lane-vertical-only", !oneLaneOverflowAtTop.horizontalScrollingEnabled),
            ("one-lane-starts-at-top", oneLaneOverflowAtTop.contentStartsAtTop),
            ("one-lane-header-visible", oneLaneOverflowAtTop.headerVisible),
            ("synthetic-cap-exact", oneLaneViewportCap == 360),
            (
                "forced-viewport-height",
                oneLaneOverflowAtTop.viewportHeight == oneLaneViewportCap
            ),
            (
                "one-lane-document-exceeds-viewport",
                oneLaneOverflowAtTop.documentHeight > oneLaneOverflowAtTop.viewportHeight
            ),
            ("smoke-scroll-moves", !oneLaneOverflowScrolled.contentStartsAtTop),
            ("smoke-scroll-positive", oneLaneOverflowScrolled.verticalScrollOffset > 0),
            ("two-lane-count", twoLaneOverflowPreserved.visibleAllowanceLaneCount == 2),
            ("two-lane-overflows", twoLaneOverflowPreserved.verticalScrollingRequired),
            ("two-lane-vertical-only", !twoLaneOverflowPreserved.horizontalScrollingEnabled),
            (
                "poll-preserves-scroll",
                abs(
                    twoLaneOverflowPreserved.verticalScrollOffset
                        - oneLaneOverflowScrolled.verticalScrollOffset
                ) <= 0.5
            ),
            (
                "two-lanes-grow-document",
                twoLaneOverflowPreserved.documentHeight
                    > oneLaneOverflowAtTop.documentHeight
            ),
            (
                "bottom-offset-reached",
                abs(
                    twoLaneOverflowAtBottom.verticalScrollOffset
                        - twoLaneOverflowAtBottom.maximumVerticalScrollOffset
                ) <= 0.5
            ),
            ("bottom-offset-positive", twoLaneOverflowAtBottom.maximumVerticalScrollOffset > 0),
            ("bottom-footer-actions-visible", twoLaneOverflowAtBottom.footerActionsVisible),
            ("bottom-header-hidden", !twoLaneOverflowAtBottom.headerVisible),
            ("reopen-synthetic-cap-exact", twoLaneViewportCap == 360),
            ("reopen-two-lane-count", twoLaneOverflowAtTop.visibleAllowanceLaneCount == 2),
            ("reopen-two-lane-overflows", twoLaneOverflowAtTop.verticalScrollingRequired),
            ("reopen-two-lane-vertical-only", !twoLaneOverflowAtTop.horizontalScrollingEnabled),
            ("reopen-starts-at-top", twoLaneOverflowAtTop.contentStartsAtTop),
            ("reopen-zero-offset", twoLaneOverflowAtTop.verticalScrollOffset == 0),
            ("reopen-header-visible", twoLaneOverflowAtTop.headerVisible),
            ("reopen-footer-actions-below-fold", !twoLaneOverflowAtTop.footerActionsVisible),
        ]
        if let failed = overflowGeometryChecks.first(where: { !$0.1 }) {
            FileHandle.standardError.write(Data(
                ("macOS menu bar overflow smoke failed: \(failed.0) "
                    + "one_document=\(oneLaneOverflowAtTop.documentHeight) "
                    + "two_document=\(twoLaneOverflowAtTop.documentHeight) "
                    + "viewport=\(twoLaneOverflowAtTop.viewportHeight) "
                    + "one_offset=\(oneLaneOverflowScrolled.verticalScrollOffset) "
                    + "two_offset=\(twoLaneOverflowPreserved.verticalScrollOffset) "
                    + "bottom_offset=\(twoLaneOverflowAtBottom.verticalScrollOffset) "
                    + "maximum_offset=\(twoLaneOverflowAtBottom.maximumVerticalScrollOffset)\n").utf8
            ))
            return 1
        }
        guard starting.informationRowsAreNative,
              starting.informationRowsHaveTitles,
              unavailable.informationRowsAreNative,
              unavailable.unavailableRowHasTitle,
              starting.analyzeShortcut == "r",
              starting.settingsShortcut == ",",
              starting.quitShortcut == "q",
              !starting.usesNativeStatusItemMenu,
              starting.statusItemButtonRoutesClicks,
              starting.popoverIsTransient,
              starting.popoverContentWidth == 400,
              starting.popoverContainsScrollView,
              starting.escapeDismissalMonitorInstalled,
              starting.sameAppClickAwayMonitorInstalled,
              starting.appDeactivationDismissalObserverInstalled,
              weeklyPosition == WeeklyWindowPosition(
                  elapsedPercent: 24,
                  usedPercent: 29
              ),
              liveSnapshot.title == expectedLiveTitle,
              analyzingLiveSnapshot.title == expectedLiveTitle,
              analyzingWithoutLiveEvidence.title == "…",
              staleSnapshot.title == "–",
              unavailableLiveSnapshot.title == "–",
              liveSummary == expectedLiveSummary,
              staleSummary == expectedStaleSummary,
              sevenDayPopup.contentWidth == 400,
              sevenDayPopup.containsScrollView,
              !sevenDayPopup.horizontalScrollingEnabled,
              sevenDayPopup.visibleAllowanceLaneCount == 2,
              sevenDayPopup.weeklyPaceVisible,
              sevenDayPopup.weeklyPaceState == .over,
              sevenDayPopup.selectedHistoryRange == .sevenDays,
              sevenDayPopup.dailyBarCount == 7,
              sevenDayPopup.historyVisible,
              thirtyDayPopup.selectedHistoryRange == .thirtyDays,
              thirtyDayPopup.dailyBarCount == 30,
              thirtyDayPopup.historyVisible,
              !sevenDayPopup.retainedHistoryDisclosed,
              updatingThirtyDayPopup.selectedHistoryRange == .thirtyDays,
              updatingThirtyDayPopup.dailyBarCount == 30,
              updatingThirtyDayPopup.historyVisible,
              updatingThirtyDayPopup.retainedHistoryDisclosed,
              !updatingThirtyDayPopup.refreshActionEnabled,
              updatingSevenDayPopup.dailyBarCount == 7,
              updatingSevenDayPopup.historyVisible,
              updatingSevenDayPopup.retainedHistoryDisclosed,
              readFailurePopup.selectedHistoryRange == .thirtyDays,
              readFailurePopup.dailyBarCount == 30,
              readFailurePopup.historyVisible,
              readFailurePopup.retainedHistoryDisclosed,
              readFailurePopup.visibleAllowanceLaneCount == 0,
              !readFailurePopup.weeklyPaceVisible,
              readFailurePopup.refreshActionEnabled,
              retainedHistory == liveSnapshot.history.retainingLastVerified(),
              readFailureSnapshot.lanes.isEmpty,
              readFailureSnapshot.observedAt == nil,
              readFailureSnapshot.evidence == .none,
              readFailureSnapshot.weeklyPaceOutlook == nil,
              readFailureSnapshot.staleAfterSeconds == nil,
              repeatedFailurePreservesHistory,
              recoveredPopup.selectedHistoryRange == .thirtyDays,
              recoveredPopup.historyVisible,
              !recoveredPopup.retainedHistoryDisclosed,
              restartedSnapshot.history == .unavailable,
              !restartedPopup.historyVisible,
              !restartedPopup.retainedHistoryDisclosed,
              failedFirstRunSnapshot.history == .unavailable,
              sevenDayPopup.pricingState == .completeEquivalent,
              sevenDayPopup.historyCoverageState == .mixed,
              sevenDayPopup.historyCoverageNamed,
              sevenDayPopup.refreshActionEnabled,
              partialPricingPopup.pricingState == .knownSubtotal,
              partialPricingPopup.partialPricingDisclosed,
              unpricedPopup.pricingState == .unavailable,
              unpricedPopup.partialPricingDisclosed,
              !noCompanionPopup.historyVisible,
              !noCompanionPopup.weeklyPaceVisible,
              !noCompanionPopup.refreshActionEnabled,
              paceOutlookProjectionContract(
                  now: observedAt,
                  weeklyLane: weeklyLane
              ),
              semanticProjectionContract(),
              retainedHistoryProjectionContract(),
              mouseDismissalContract()
        else {
            FileHandle.standardError.write(
                Data("macOS menu bar contract smoke failed\\n".utf8)
            )
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_MENU_BAR_CONTRACT "
                + "popover=true width=400 bars=7,30 pace=canonical-outlook "
                + "native_actions=true states=live,starting,unavailable "
                + "shortcuts=cmd-r,cmd-comma,cmd-q "
                + "routing=left-popover,right-menu,control-menu "
                + "dismissal=escape,transient,same-app,outside,deactivation "
                + "weekly_position=factual-menu-only "
                + "pace_outlook=collecting,under,on,over,critical,fail-closed "
                + "history=authoritative,coverage-named,fail-closed "
                + "pricing=complete,partial,unavailable model=dst,overlap,future,per-lane "
                + "reset_credits=absent analysis_title=live-fallback "
                + "history_retention=refresh,failure,source-reset"
                + " overflow=screen-capped,vertical-only,top-reset,poll-preserved"
        )
        return 0
    }

    @MainActor
    private final class InteractionHarnessActions: NSObject {
        let controller: MenuBarStatusController

        init(controller: MenuBarStatusController) { self.controller = controller }

        @objc func showPopover(_ sender: Any?) {
            _ = controller.showPopoverForSmokeTest()
        }
    }

    /// Data-free, development-only interactive QA. No app delegate, companion,
    /// user defaults, source files, credentials, or refresh are initialized.
    static func runInteractionHarness() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = MenuBarStatusController(
            productName: "Menu-bar dismissal test",
            actions: .init(
                openTiboTattle: {}, showSettings: {}, showAbout: {},
                quit: { application.terminate(nil) }
            )
        )
        let target = InteractionHarnessActions(controller: controller)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 180),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.title = "Menu-bar dismissal test — no live data"
        let showButton = NSButton(
            title: "Open test popover", target: target,
            action: #selector(InteractionHarnessActions.showPopover(_:))
        )
        let exitButton = NSButton(
            title: "Finish test", target: application,
            action: #selector(NSApplication.terminate(_:))
        )
        let content = NSStackView(views: [
            NSTextField(labelWithString: "Temporary native test. No companion or usage data."),
            showButton, exitButton,
        ])
        content.orientation = .vertical
        content.spacing = 18
        content.translatesAutoresizingMaskIntoConstraints = false
        if let root = window.contentView {
            root.addSubview(content)
            NSLayoutConstraint.activate([
                content.centerXAnchor.constraint(equalTo: root.centerXAnchor),
                content.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            ])
        }
        window.center()
        window.orderFrontRegardless()
        var previous: String?
        let deadline = Date().addingTimeInterval(180)
        let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated {
                let state = controller.nativePresentationContract()
                let line = "MENU_BAR_INTERACTION shown=\(state.popoverIsShown) outside_monitor=\(state.outsideClickAwayMonitorInstalled) active=\(application.isActive)"
                if line != previous {
                    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
                    previous = line
                }
                if Date() >= deadline {
                    controller.shutDown()
                    window.orderOut(nil)
                    application.terminate(nil)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            _ = controller.showPopoverForSmokeTest()
        }
        application.run()
        timer.invalidate()
        controller.shutDown()
        window.orderOut(nil)
        withExtendedLifetime(target) {}
        return 0
    }

    /// Development-only, read-only handoff from the companion projection to
    /// the actual native view. The input is a derived overview, never raw logs;
    /// stdout reports layout/state facts rather than any private usage values.
    static func renderOverview(inputPath: String, outputDirectory: String) -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        do {
            let input = try FileHandle(forReadingFrom: URL(fileURLWithPath: inputPath))
            defer { try? input.close() }
            let maximumBytes = 8 * 1_024 * 1_024
            let now = Date()
            guard let data = try input.read(upToCount: maximumBytes + 1),
                  data.count <= maximumBytes,
                  let overview = LocalCompanionOverviewProjection.decode(data, now: now),
                  overview.history.accountingStatus != .unavailable
            else { return 1 }
            let output = URL(fileURLWithPath: outputDirectory, isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            var snapshot = MenuBarStatusSnapshot()
            snapshot.evidence = LocalCompanionOverviewProjection.evidence(for: overview, now: now)
            snapshot.lanes = overview.lanes
            snapshot.observedAt = overview.observedAt
            snapshot.staleAfterSeconds = overview.staleAfterSeconds
            snapshot.history = overview.history
            snapshot.analysisAvailable = true
            let popup = MenuBarPopoverViewController(
                productName: BundledProduct.displayName,
                brandImage: NSApp.applicationIconImage,
                actions: MenuBarPopoverViewController.Actions(
                    openTiboTattle: {}, refresh: {}, showMore: { _ in }
                )
            )
            for (phase, name) in [
                (MenuBarStatusSnapshot.Phase.ready, "ready"),
                (.analyzing, "updating"),
                (.unavailable, "read-failure"),
            ] {
                snapshot.phase = phase
                if phase == .unavailable {
                    snapshot.invalidateObservedEvidence(keepingHistory: true)
                }
                popup.update(snapshot: snapshot, now: now)
                for range in MenuBarHistoryRange.allCases {
                    popup.selectHistoryRangeForSmokeTest(range)
                    let presentation = popup.nativePresentationContract()
                    guard presentation.historyVisible,
                          presentation.dailyBarCount == range.dayCount,
                          presentation.retainedHistoryDisclosed
                            == (phase != .ready || snapshot.history.accountingStatus == .retained),
                          phase != .unavailable || presentation.visibleAllowanceLaneCount == 0,
                          snapshot.history.period(for: range) == overview.history.period(for: range),
                          snapshot.history.history(for: range) == overview.history.history(for: range)
                    else { return 1 }
                    try popup.renderPNG(
                        to: output.appendingPathComponent("\(name)-\(range.rawValue).png"),
                        appearance: .aqua
                    )
                }
            }
            print("USAGE_MONITOR_MACOS_MENU_BAR_OVERVIEW_RENDER ranges=7d,30d states=ready,updating,read-failure history=preserved freshness=labelled current_quota=cleared-on-failure")
            return 0
        } catch {
            FileHandle.standardError.write(Data("macOS menu bar overview render failed\n".utf8))
            return 1
        }
    }

    static func render(outputDirectory: String) -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let output = URL(fileURLWithPath: outputDirectory, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: output,
                withIntermediateDirectories: true
            )
        } catch {
            return 1
        }

        let observedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let weeklyReset = observedAt.addingTimeInterval(5.25 * 24 * 60 * 60)
        var snapshot = MenuBarStatusSnapshot()
        snapshot.phase = .ready
        snapshot.evidence = .live
        snapshot.observedAt = observedAt
        snapshot.staleAfterSeconds = 30 * 60
        snapshot.analysisAvailable = true
        snapshot.lanes = [
            ObservedQuotaLane(
                label: TiboTattleLocalization.string(.menuBarSevenDayAllowance),
                remainingPercent: 62,
                durationMinutes: CodexQuotaWindowDuration.sevenDayMinutes,
                resetAt: weeklyReset,
                observedAt: observedAt,
                isPrimary: true
            ),
            ObservedQuotaLane(
                label: TiboTattleLocalization.string(.menuBarFiveHourAllowance),
                remainingPercent: 84,
                durationMinutes: CodexQuotaWindowDuration.fiveHourMinutes,
                resetAt: observedAt.addingTimeInterval(2.2 * 60 * 60),
                observedAt: observedAt,
                isPrimary: false
            ),
        ]
        snapshot.weeklyPaceOutlook = decodePaceOutlook(
            availablePaceOutlook(
                now: observedAt,
                remainingPercent: 62,
                resetsAt: weeklyReset,
                headlineRate: 0.82,
                activeRate: 1.05
            )
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = calendar.startOfDay(for: observedAt)
        let days = (0..<30).compactMap { index -> MenuBarHistoryDay? in
            guard let startAt = calendar.date(
                byAdding: .day,
                value: index - 29,
                to: today
            ), let endAt = calendar.date(
                byAdding: .day,
                value: 1,
                to: startAt
            ) else { return nil }
            let events = Int64([3, 8, 6, 12, 17, 9, 22][index % 7])
            let tokens = events * Int64(6_500_000 + index * 125_000)
            return MenuBarHistoryDay(
                startAt: startAt,
                endAt: endAt,
                evidence: index == 29 ? .partial : .available,
                usageEvents: events,
                totalTokens: tokens,
                knownAPIPriceEquivalentUSD: Double(events) * 0.43,
                pricingCoverage: MenuBarPricingCoverage(
                    fullyPricedEvents: events,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 0
                )
            )
        }
        func period(
            _ window: MenuBarRollingPeriod.Window,
            events: Int64,
            tokens: Int64,
            cost: Double
        ) -> MenuBarRollingPeriod {
            MenuBarRollingPeriod(
                window: window,
                events: events,
                totalTokens: tokens,
                knownAPIPriceEquivalentUSD: cost,
                pricingCoverage: MenuBarPricingCoverage(
                    fullyPricedEvents: events,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 0
                )
            )
        }
        snapshot.history = MenuBarHistorySnapshot(
            accountingStatus: .current,
            last24Hours: period(
                .last24Hours,
                events: 22,
                tokens: 181_000_000,
                cost: 9.46
            ),
            lastSevenDays: period(
                .lastSevenDays,
                events: 96,
                tokens: 748_000_000,
                cost: 41.28
            ),
            lastThirtyDays: period(
                .lastThirtyDays,
                events: 388,
                tokens: 2_870_000_000,
                cost: 166.84
            ),
            sevenDayHistory: Array(days.suffix(7)),
            thirtyDayHistory: days
        )

        let originalLanguage = TiboTattleLocalization.languagePreference
        defer { TiboTattleLocalization.setLanguagePreference(originalLanguage) }
        let languages: [(TiboTattleLocalization.LanguagePreference, String)] = [
            (.english, "en"),
            (.spanish, "es"),
            (.simplifiedChinese, "zh-Hans"),
        ]
        let appearances: [(NSAppearance.Name, String)] = [
            (.aqua, "light"),
            (.darkAqua, "dark"),
        ]
        do {
            for (language, languageName) in languages {
                TiboTattleLocalization.setLanguagePreference(language)
                let popup = MenuBarPopoverViewController(
                    productName: BundledProduct.displayName,
                    brandImage: NSApp.applicationIconImage,
                    actions: MenuBarPopoverViewController.Actions(
                        openTiboTattle: {},
                        refresh: {},
                        showMore: { _ in }
                    )
                )
                popup.update(snapshot: snapshot, now: observedAt)
                popup.refreshLocalization()
                for (appearance, appearanceName) in appearances {
                    let destination = output.appendingPathComponent(
                        "menu-bar-popover-\(languageName)-\(appearanceName).png"
                    )
                    try popup.renderPNG(to: destination, appearance: appearance)
                }
                if language == .english {
                    popup.selectHistoryRangeForSmokeTest(.thirtyDays)
                    for (appearance, appearanceName) in appearances {
                        let destination = output.appendingPathComponent(
                            "menu-bar-popover-en-30d-\(appearanceName).png"
                        )
                        try popup.renderPNG(
                            to: destination,
                            appearance: appearance
                        )
                    }
                    var updatingSnapshot = snapshot
                    updatingSnapshot.phase = .analyzing
                    updatingSnapshot.history = snapshot.history.retainingLastVerified()
                    popup.update(snapshot: updatingSnapshot, now: observedAt)
                    for range in [MenuBarHistoryRange.sevenDays, .thirtyDays] {
                        popup.selectHistoryRangeForSmokeTest(range)
                        try popup.renderPNG(
                            to: output.appendingPathComponent(
                                "menu-bar-popover-en-updating-\(range.rawValue)-light.png"
                            ),
                            appearance: .aqua
                        )
                    }
                    updatingSnapshot.invalidateObservedEvidence(keepingHistory: true)
                    updatingSnapshot.phase = .unavailable
                    popup.update(snapshot: updatingSnapshot, now: observedAt)
                    try popup.renderPNG(
                        to: output.appendingPathComponent(
                            "menu-bar-popover-en-read-failure-30d-light.png"
                        ),
                        appearance: .aqua
                    )
                }
            }

            let sustainableRate = 62.0 / (
                weeklyReset.timeIntervalSince(observedAt) / 3_600
            )
            let paceStateFixtures: [([String: Any], String)] = [
                (
                    collectingPaceOutlook(
                        now: observedAt,
                        remainingPercent: 62,
                        resetsAt: weeklyReset
                    ),
                    "collecting"
                ),
                (
                    availablePaceOutlook(
                        now: observedAt,
                        remainingPercent: 62,
                        resetsAt: weeklyReset,
                        headlineRate: sustainableRate * 0.7
                    ),
                    "under"
                ),
                (
                    availablePaceOutlook(
                        now: observedAt,
                        remainingPercent: 62,
                        resetsAt: weeklyReset,
                        headlineRate: sustainableRate
                    ),
                    "on"
                ),
                (
                    availablePaceOutlook(
                        now: observedAt,
                        remainingPercent: 62,
                        resetsAt: weeklyReset,
                        headlineRate: sustainableRate * 2.2
                    ),
                    "critical"
                ),
            ]
            TiboTattleLocalization.setLanguagePreference(.english)
            for (paceValue, paceName) in paceStateFixtures {
                guard let paceOutlook = decodePaceOutlook(paceValue) else {
                    return 1
                }
                var paceSnapshot = snapshot
                paceSnapshot.weeklyPaceOutlook = paceOutlook
                let popup = MenuBarPopoverViewController(
                    productName: BundledProduct.displayName,
                    brandImage: NSApp.applicationIconImage,
                    actions: MenuBarPopoverViewController.Actions(
                        openTiboTattle: {},
                        refresh: {},
                        showMore: { _ in }
                    )
                )
                popup.update(snapshot: paceSnapshot, now: observedAt)
                popup.refreshLocalization()
                try popup.renderPNG(
                    to: output.appendingPathComponent(
                        "menu-bar-popover-en-pace-\(paceName)-light.png"
                    ),
                    appearance: .aqua
                )
            }

            func historyWithPricingCoverage(
                _ coverage: MenuBarPricingCoverage,
                knownCost: Double
            ) -> MenuBarHistorySnapshot {
                MenuBarHistorySnapshot(
                    accountingStatus: .current,
                    last24Hours: snapshot.history.last24Hours,
                    lastSevenDays: MenuBarRollingPeriod(
                        window: .lastSevenDays,
                        events: coverage.fullyPricedEvents
                            + coverage.partiallyPricedEvents
                            + coverage.unpricedEvents,
                        totalTokens: 748_000_000,
                        knownAPIPriceEquivalentUSD: knownCost,
                        pricingCoverage: coverage
                    ),
                    lastThirtyDays: snapshot.history.lastThirtyDays,
                    sevenDayHistory: snapshot.history.sevenDayHistory,
                    thirtyDayHistory: snapshot.history.thirtyDayHistory
                )
            }
            func renderSpanishState(
                _ stateSnapshot: MenuBarStatusSnapshot,
                name: String
            ) throws {
                TiboTattleLocalization.setLanguagePreference(.spanish)
                let popup = MenuBarPopoverViewController(
                    productName: BundledProduct.displayName,
                    brandImage: NSApp.applicationIconImage,
                    actions: MenuBarPopoverViewController.Actions(
                        openTiboTattle: {},
                        refresh: {},
                        showMore: { _ in }
                    )
                )
                popup.update(snapshot: stateSnapshot, now: observedAt)
                popup.refreshLocalization()
                try popup.renderPNG(
                    to: output.appendingPathComponent(
                        "menu-bar-popover-es-\(name)-light.png"
                    ),
                    appearance: .aqua
                )
            }
            var partialPricingSnapshot = snapshot
            partialPricingSnapshot.history = historyWithPricingCoverage(
                MenuBarPricingCoverage(
                    fullyPricedEvents: 82,
                    partiallyPricedEvents: 8,
                    unpricedEvents: 6
                ),
                knownCost: 34.10
            )
            try renderSpanishState(
                partialPricingSnapshot,
                name: "partial-pricing"
            )
            var unpricedSnapshot = snapshot
            unpricedSnapshot.history = historyWithPricingCoverage(
                MenuBarPricingCoverage(
                    fullyPricedEvents: 0,
                    partiallyPricedEvents: 0,
                    unpricedEvents: 96
                ),
                knownCost: 0
            )
            try renderSpanishState(unpricedSnapshot, name: "unpriced")
            var unavailableSnapshot = MenuBarStatusSnapshot()
            unavailableSnapshot.phase = .unavailable
            try renderSpanishState(unavailableSnapshot, name: "unavailable")
        } catch {
            FileHandle.standardError.write(
                Data("macOS menu bar popover render smoke failed\n".utf8)
            )
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_MENU_BAR_POPOVER_RENDER "
                + "locales=en,es,zh-Hans appearances=light,dark "
                + "ranges=7d,30d "
                + "states=live,pace-collecting,pace-under,pace-on,"
                + "pace-over,pace-critical,partial-pricing,unpriced,unavailable,"
                + "updating-7d,updating-30d,read-failure-30d "
                + "width=400 source=synthetic-content-free"
        )
        return 0
    }
}

/// A settings page is its controller plus the column its cards live in. The
/// column is kept because the window is sized from it, and a card's height
/// changes with its live text long after the page was built.
private typealias SettingsPage = (
    controller: NSViewController,
    column: NSStackView
)

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
    /// A card is capped at a readable measure rather than the window width, so
    /// a translated description wraps to a line length the eye can track.
    static let columnWidth: CGFloat = 680
    static let columnInset = (horizontal: CGFloat(28), vertical: CGFloat(24))
    /// The window is the column plus its gutters. This is also the width a
    /// non-resizable window settles on by itself once the column has hit its
    /// cap, so naming it keeps the measured height honest: the column really
    /// is laid out at `columnWidth`.
    static let contentWidth: CGFloat = columnWidth + columnInset.horizontal * 2
    /// A settings window may grow to its content but never past the display it
    /// opens on. Beyond this the page scrolls, which is the one case where a
    /// scroller is the honest answer.
    static var maximumContentHeight: CGFloat {
        // Pages are measured before the settings window exists, so there is no
        // key window to name a screen; `screens.first` is the fallback that
        // still describes a real display instead of a guess.
        let screen = NSScreen.main ?? NSScreen.screens.first
        return max(420, (screen?.visibleFrame.height ?? 900) - 160)
    }

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
            constant: -columnInset.horizontal * 2
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
                constant: columnInset.horizontal
            ),
            stack.trailingAnchor.constraint(
                lessThanOrEqualTo: document.trailingAnchor,
                constant: -columnInset.horizontal
            ),
            stack.topAnchor.constraint(
                equalTo: document.topAnchor,
                constant: columnInset.vertical
            ),
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
                constant: -columnInset.vertical
            ),
            stack.widthAnchor.constraint(
                lessThanOrEqualToConstant: columnWidth
            ),
        ])
        preferredWidth.isActive = true
        let controller = NSViewController()
        controller.view = root
        // The window is sized to the page, not the page to a fixed window.
        // A four-card General page measures taller than any number worth
        // hard-coding, and a longer translation measures taller again, so the
        // height that keeps every locale unclipped is the one the cards
        // themselves report at the width they will actually be laid out in.
        controller.preferredContentSize = contentSize(for: stack)
        return (controller, stack)
    }

    /// The window content size a page column needs: its height-for-width plus
    /// the column's own gutters, capped at the display. A card's height moves
    /// with its live text - a chosen folder path, a login-item row that comes
    /// and goes - so this is re-asked, not cached at construction.
    static func contentSize(for column: NSStackView) -> NSSize {
        NSSize(
            width: contentWidth,
            height: min(
                naturalHeight(of: column, at: columnWidth)
                    + columnInset.vertical * 2,
                maximumContentHeight
            )
        )
    }

    /// Height-for-width of a page column. A wrapping label only knows its own
    /// height once it knows its width, so the column is pinned to the width it
    /// will really receive and laid out before it is measured; the second pass
    /// is what lets the labels report their wrapped height rather than their
    /// single-line one.
    static func naturalHeight(
        of column: NSStackView,
        at width: CGFloat
    ) -> CGFloat {
        let pin = column.widthAnchor.constraint(equalToConstant: width)
        pin.isActive = true
        column.layoutSubtreeIfNeeded()
        _ = column.fittingSize
        column.layoutSubtreeIfNeeded()
        let height = column.fittingSize.height
        pin.isActive = false
        return height
    }
}

/// Lays out representative Settings pages in real windows and measures the
/// resulting frames. Source-text assertions cannot catch any of what this
/// pins; measured frames can. It guards four reported defects at once:
///
/// 1. cards floating right at unequal widths, because a vertical stack aligned
///    `.width` sizes each subview to its own intrinsic width;
/// 2. a page taller than its window, which put a scroller on a four-group
///    General page and clipped its last group - so a page opened at its own
///    reported height must need no more room than the viewport gives it, and a
///    window deliberately shorter than its page must still scroll;
/// 3. a control stretched to the full card width, which read as a banner
///    rather than a button;
/// 4. a short page's cards spread through surplus window height.
@MainActor
private enum NativeSettingsLayoutSmokeTest {
    private static let settingsContentWidth = NativeSettingsLayout.contentWidth

    /// The scroller a page shows is the only honest report of whether the
    /// window fits it, so it is read from the page's own scroll view.
    private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

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

        func stackedColumn(_ views: [NSView]) -> NSStackView {
            let stack = NSStackView(views: views)
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 8
            return stack
        }

        // Controls carried through the layout so their real frames can be
        // measured. A bare `NSButton` handed to a card is stretched to the card
        // width - the banner defect - so the shipped pages wrap theirs in a row
        // or a leading column, and these are the ones that must stay intrinsic.
        let chooseFolder = button("Choose Folder…")
        let useDefault = button("Use Default")
        let openLoginItems = button("Open Login Items Settings")
        let refreshLoginItem = button("Refresh Login Item Status")

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
                    row([chooseFolder, useDefault]),
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
                    stackedColumn([openLoginItems, refreshLoginItem]),
                ]
            )),
        ]

        let page = NativeSettingsLayout.page(
            title: "General",
            summary: "Language, evidence folder, refresh cadence, login.",
            views: cards.map(\.1)
        )
        // The window is opened at the size the page asked for, which is the
        // whole point of the contract below: a page that reports its own
        // height must then fit in it.
        let generalSize = page.controller.preferredContentSize
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: generalSize),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = page.controller
        window.setContentSize(generalSize)
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

        // The reported defect: a General page with four groups showed a
        // scroller and clipped its last group, because the window height was a
        // literal and the content was taller than it. The window above is
        // opened at the height the page itself reported, so the contract is
        // that the document then needs no more room than the viewport gives
        // it. `overflow` is the clip, measured.
        guard let generalScroll = scrollView(in: page.controller.view) else {
            FileHandle.standardError.write(
                Data("macOS settings layout smoke found no scroll view\n".utf8)
            )
            return 1
        }
        let generalViewport = generalScroll.contentView.bounds.height
        let generalDocument = generalScroll.documentView?.frame.height ?? 0
        let generalOverflow = generalDocument - generalViewport
        guard generalViewport >= 400, generalOverflow <= 0.5 else {
            FileHandle.standardError.write(Data(
                ("macOS settings vertical fit smoke failed "
                    + "viewport=\(generalViewport) "
                    + "document=\(generalDocument) "
                    + "overflow=\(generalOverflow)\n").utf8
            ))
            return 1
        }

        // The same page in a window a third shorter must still scroll. Without
        // this the fit contract above would also pass on a page that had
        // simply lost its scroller, which is a different defect wearing the
        // same result.
        let clippedPage = NativeSettingsLayout.page(
            title: "General",
            summary: "Language, evidence folder, refresh cadence, login.",
            views: [
                NativeSettingsLayout.group(
                    title: "Language",
                    symbolName: "globe",
                    views: [
                        row([picker(["System language", "English"])]),
                        detail("Changing the language reopens the dashboard."),
                    ]
                ),
                NativeSettingsLayout.group(
                    title: "Start at login",
                    symbolName: "power",
                    views: [
                        row([NSSwitch()]),
                        detail("Start at login is off."),
                        stackedColumn([button("Open Login Items Settings")]),
                    ]
                ),
            ]
        )
        // `preferredContentSize` is what a window sizes its content view
        // controller to, so shortening the window means shortening that. This
        // is the hard-coded-height case, reproduced deliberately.
        let clippedHeight = (clippedPage.controller
            .preferredContentSize.height * (2.0 / 3.0)).rounded()
        clippedPage.controller.preferredContentSize = NSSize(
            width: settingsContentWidth,
            height: clippedHeight
        )
        let clippedWindow = NSWindow(
            contentRect: NSRect(
                x: 0,
                y: 0,
                width: settingsContentWidth,
                height: clippedHeight
            ),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        clippedWindow.contentViewController = clippedPage.controller
        clippedWindow.setContentSize(
            NSSize(width: settingsContentWidth, height: clippedHeight)
        )
        clippedWindow.layoutIfNeeded()
        clippedPage.controller.view.layoutSubtreeIfNeeded()
        clippedWindow.displayIfNeeded()
        clippedPage.controller.view.layoutSubtreeIfNeeded()
        let clippedScroll = scrollView(in: clippedPage.controller.view)
        let clippedOverflow = (clippedScroll?.documentView?.frame.height ?? 0)
            - (clippedScroll?.contentView.bounds.height ?? 0)
        guard clippedOverflow > 0.5 else {
            FileHandle.standardError.write(Data(
                ("macOS settings scroller control smoke failed "
                    + "overflow=\(clippedOverflow)\n").utf8
            ))
            return 1
        }

        // The second reported defect: "Open Login Items Settings" ran the whole
        // group width and read as a banner. A card stretches its direct
        // children to the card width, so a control only keeps its own size when
        // a row or a leading column stands between it and the card. Every
        // button below is placed the way the shipped pages place theirs, and
        // must measure its intrinsic width on the card's leading edge.
        let controls = [
            chooseFolder,
            useDefault,
            openLoginItems,
            refreshLoginItem,
        ]
        var widestControlStretch: CGFloat = 0
        for control in controls {
            widestControlStretch = max(
                widestControlStretch,
                control.frame.width - control.intrinsicContentSize.width
            )
        }
        // Only the control that opens a row or column starts on the card's
        // leading edge; `useDefault` sits after `chooseFolder` by design.
        let controlLeadingEdges = [
            chooseFolder,
            openLoginItems,
            refreshLoginItem,
        ].map { column.convert($0.bounds, from: $0).minX }
        let controlLeadingSpread = (controlLeadingEdges.max() ?? 0)
            - (controlLeadingEdges.min() ?? 0)
        let widestControl = controls.map(\.frame.width).max() ?? 0
        guard widestControlStretch <= 0.5,
              controlLeadingSpread <= 0.5,
              widestControl <= columnWidth - 40
        else {
            FileHandle.standardError.write(Data(
                ("macOS settings control width smoke failed "
                    + "widest_stretch=\(widestControlStretch) "
                    + "leading_spread=\(controlLeadingSpread) "
                    + "widest_control=\(widestControl) "
                    + "column=\(columnWidth)\n").utf8
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
        let shortSize = shortPage.controller.preferredContentSize
        let shortWindow = NSWindow(
            contentRect: NSRect(origin: .zero, size: shortSize),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        shortWindow.contentViewController = shortPage.controller
        shortWindow.setContentSize(shortSize)
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
        let shortScroll = scrollView(in: shortPage.controller.view)
        let shortOverflow = (shortScroll?.documentView?.frame.height ?? 0)
            - (shortScroll?.contentView.bounds.height ?? 0)
        guard widestGap <= shortColumn.spacing + 0.5,
              worstStretch <= 1,
              shortOverflow <= 0.5,
              !cardFrames.isEmpty
        else {
            FileHandle.standardError.write(Data(
                ("macOS settings vertical layout smoke failed "
                    + "column_height=\(shortColumn.frame.height) "
                    + "window_height=\(shortSize.height) "
                    + "widest_gap=\(widestGap) "
                    + "worst_card_stretch=\(worstStretch) "
                    + "short_overflow=\(shortOverflow) "
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
                + "page_height=\(Int(generalSize.height.rounded())) "
                + "page_overflow=\(Int(generalOverflow.rounded())) "
                + "short_page_overflow=\(Int(shortOverflow.rounded())) "
                + "scroller_when_short=true "
                + "control_stretch=\(Int(widestControlStretch.rounded())) "
                + "control_leading_spread="
                + "\(Int(controlLeadingSpread.rounded())) "
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
    /// Executes the same clock/generation policy used by the real WebKit host.
    /// No sleeps, page loads, companion, credentials or user data are involved.
    private static func readinessContract() -> Bool {
        var state = NativeDashboardReadiness()
        let initial = state.invalidate()
        guard state.observe(generation: initial, at: 0, ready: true) == .ignored,
              state.start(generation: initial, at: 0),
              !state.start(generation: initial, at: 1),
              state.observe(generation: initial, at: 0, ready: false) == .waiting(0.25),
              state.observe(generation: initial, at: 19.9, ready: false) == .waiting(0.25),
              state.observe(generation: initial, at: 20, ready: false) == .takingLonger,
              state.observe(generation: initial, at: 21, ready: false) == .waiting(1),
              state.observe(generation: initial, at: 35, ready: true) == .ready,
              state.observe(generation: initial, at: 36, ready: true) == .ignored,
              !state.isObserving(initial)
        else { return false }

        let replacement = state.invalidate()
        guard replacement != initial,
              state.start(generation: replacement, at: 40),
              // Both a late success and the old deadline are inert.
              state.observe(generation: initial, at: 45, ready: true) == .ignored,
              state.observe(generation: initial, at: 125, ready: false) == .ignored,
              state.observe(generation: replacement, at: 45, ready: false) == .waiting(0.25),
              state.observe(generation: replacement, at: 60, ready: false) == .takingLonger,
              // The watchdog still expires if JavaScript never answers.
              state.observe(generation: replacement, at: 159.9, ready: false) == .waiting(1),
              state.observe(generation: replacement, at: 160, ready: false) == .timedOut,
              state.observe(generation: replacement, at: 161, ready: true) == .ignored,
              !state.isObserving(replacement)
        else { return false }

        let stopped = state.invalidate()
        guard state.start(generation: stopped, at: 200) else { return false }
        let next = state.invalidate()
        guard state.observe(generation: stopped, at: 201, ready: true) == .ignored,
              !state.isObserving(next),
              state.start(generation: next, at: 201),
              state.observe(generation: next, at: 202, ready: true) == .ready,
              state.observe(generation: next, at: 203, ready: true) == .ignored
        else { return false }

        let tooLate = state.invalidate()
        guard state.start(generation: tooLate, at: 300),
              state.observe(generation: tooLate, at: 420, ready: true) == .timedOut
        else { return false }
        return true
    }

    static func run() -> Int32 {
        guard readinessContract() else {
            FileHandle.standardError.write(Data(
                "macOS dashboard readiness lifecycle smoke failed\n".utf8
            ))
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_DASHBOARD_READINESS "
                + "early=true late=true once=true stale_callbacks=ignored "
                + "cancelled=true hung_renderer=bounded hard_deadline=120"
        )
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

/// Proves a collapsed sidebar can always be reopened.
///
/// Source text can show that a toolbar item and a menu command exist; it cannot
/// show that either one reaches a live target, nor that the pane actually comes
/// back with usable width. This drives the real chrome: collapse it the way a
/// divider drag leaves it, then reopen it through the same action the toolbar
/// and menu send, and check the one-time rescue for sidebars that older builds
/// stranded shut.
@MainActor
private enum NativeDashboardSidebarRecoverySmokeTest {
    static func run() -> Int32 {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let defaults = UserDefaults.standard
        // This runs inside the shipped bundle's own defaults domain, so the
        // markers it must forge are saved and put back before returning.
        let rescueKey = NativeDashboardChrome.sidebarRescuedDefaultsKey
        let priorRescue = defaults.object(forKey: rescueKey)
        defer {
            if let priorRescue {
                defaults.set(priorRescue, forKey: rescueKey)
            } else {
                defaults.removeObject(forKey: rescueKey)
            }
            // Defaults writes are asynchronous and this process exits
            // immediately after returning; without the flush the restore is
            // lost and the smoke would silently consume the real one-time
            // rescue belonging to whoever ran it.
            defaults.synchronize()
        }

        func makeChrome() -> (NativeDashboardChrome, NSWindow) {
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
            return (chrome, window)
        }

        // A collapsed item keeps its own pane's width — AppKit hides the pane
        // rather than zeroing it — so the width alone cannot tell the states
        // apart. What the user actually sees is where the report begins: flush
        // against the window's leading edge with the sidebar gone, or pushed
        // right by the sidebar's full width when it is back.
        func panes(
            _ chrome: NativeDashboardChrome,
            _ window: NSWindow
        ) -> (sidebar: CGFloat, report: CGFloat, reportLeading: CGFloat) {
            chrome.view.layoutSubtreeIfNeeded()
            guard let reference = window.contentView else { return (0, 0, 0) }
            let metrics = chrome.measure(in: reference)
            return (
                metrics.sidebarPane.width,
                metrics.reportPane.width,
                metrics.reportPane.minX
            )
        }

        let (chrome, window) = makeChrome()

        // 1. Collapse the way a divider dragged to the leading edge leaves it.
        chrome.splitViewItems.first?.isCollapsed = true
        let collapsed = chrome.sidebarIsCollapsed
        let collapsedPanes = panes(chrome, window)
        let collapsedWidth = collapsedPanes.sidebar

        // 2. The action both affordances send must reach a live target.
        let selector = #selector(NSSplitViewController.toggleSidebar(_:))
        let responds = chrome.responds(to: selector)

        // 3. Validation enables the command and names the state it will move
        //    to, in both directions.
        let probe = NSMenuItem(
            title: "",
            action: selector,
            keyEquivalent: ""
        )
        let enabledWhileCollapsed = chrome.validateUserInterfaceItem(probe)
        let showTitle = probe.title

        // 4. Reopening restores a pane at or above the enforced minimum, and
        //    the report gives back the width the sidebar now occupies.
        let revealed = chrome.revealSidebar()
        let revealedPanes = panes(chrome, window)
        let revealedWidth = revealedPanes.sidebar
        let reportYielded = collapsedPanes.report - revealedPanes.report
        _ = chrome.validateUserInterfaceItem(probe)
        let hideTitle = probe.title

        // 5. A sidebar stranded by an older build reopens once on upgrade.
        defaults.removeObject(forKey: rescueKey)
        let (stranded, strandedWindow) = makeChrome()
        _ = strandedWindow
        stranded.splitViewItems.first?.isCollapsed = true
        stranded.viewDidAppear()
        let rescued = !stranded.sidebarIsCollapsed

        // 6. After that one rescue a deliberate collapse is left alone: the
        //    marker is set, and the user can reopen it themselves now.
        let (afterRescue, afterWindow) = makeChrome()
        _ = afterWindow
        afterRescue.splitViewItems.first?.isCollapsed = true
        afterRescue.viewDidAppear()
        let respectsChoice = afterRescue.sidebarIsCollapsed

        let minimum = NativeDashboardChrome.sidebarMinimumThickness
        guard collapsed,
              // Nothing between the window edge and the report.
              collapsedPanes.reportLeading < 1,
              // The sidebar is back in front of it, at its enforced width.
              revealedPanes.reportLeading >= minimum,
              responds,
              enabledWhileCollapsed,
              showTitle == TiboTattleLocalization.string(
                  .nativeDashboardShowSidebar
              ),
              revealed,
              revealedWidth >= minimum,
              reportYielded >= minimum,
              hideTitle == TiboTattleLocalization.string(
                  .nativeDashboardHideSidebar
              ),
              rescued,
              respectsChoice
        else {
            FileHandle.standardError.write(
                Data(
                    ("macOS sidebar recovery smoke failed "
                        + "collapsed=\(collapsed) "
                        + "collapsed_width=\(Int(collapsedWidth)) "
                        + "collapsed_report_leading="
                        + "\(Int(collapsedPanes.reportLeading)) "
                        + "revealed_report_leading="
                        + "\(Int(revealedPanes.reportLeading)) "
                        + "responds=\(responds) "
                        + "enabled=\(enabledWhileCollapsed) "
                        + "show_title=\(showTitle) "
                        + "revealed=\(revealed) "
                        + "revealed_width=\(Int(revealedWidth)) "
                        + "report_yielded=\(Int(reportYielded)) "
                        + "hide_title=\(hideTitle) "
                        + "rescued=\(rescued) "
                        + "respects_choice=\(respectsChoice)\n").utf8
                )
            )
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_SIDEBAR_RECOVERY "
                + "collapse=true "
                + "responds=true "
                + "menu_enabled=true "
                + "reveal=true "
                + "width=\(Int(revealedWidth)) "
                + "rescue_once=true "
                + "respects_choice=true"
        )
        return 0
    }
}

/// Exercises the product-policy layer on top of WebKit and AppKit. The real
/// framework objects matter here: source assertions alone cannot show that the
/// context-menu filter operates on NSMenu identifiers or that link previews
/// are disabled on the web view the dashboard actually constructs.
@MainActor
private enum NativeDashboardInteractionSafetySmokeTest {
    private static let backIdentifier = NSUserInterfaceItemIdentifier(
        "WKMenuItemIdentifierGoBack"
    )
    private static let forwardIdentifier = NSUserInterfaceItemIdentifier(
        "WKMenuItemIdentifierGoForward"
    )
    private static let reloadIdentifier = NSUserInterfaceItemIdentifier(
        "WKMenuItemIdentifierReload"
    )
    private static let downloadIdentifier = NSUserInterfaceItemIdentifier(
        "WKMenuItemIdentifierDownloadLinkedFile"
    )
    private static let openLinkIdentifier = NSUserInterfaceItemIdentifier(
        "WKMenuItemIdentifierOpenLink"
    )

    private static func codexThreadPolicyIsSafe() -> Bool {
        let identifier = "11111111-1111-4111-8111-111111111111"
        let canonical = "codex://threads/\(identifier)"
        guard let target = URL(string: canonical),
              CodexThreadOpenTarget.accepts(target)
        else { return false }
        let rejected = [
            "https://threads/\(identifier)",
            "codex://other/\(identifier)",
            "codex://threads/not-a-thread",
            "codex://threads/11111111-1111-0111-8111-111111111111",
            "codex://threads/11111111-1111-4111-1111-111111111111",
            "codex://user@threads/\(identifier)",
            "codex://user:password@threads/\(identifier)",
            "codex://threads:1234/\(identifier)",
            "codex://threads:/\(identifier)",
            canonical + "?next=other", canonical + "?",
            canonical + "#other", canonical + "#",
            canonical + "/", canonical + "/other",
            "codex://threads//\(identifier)",
            "codex://threads/./\(identifier)",
            "codex://%74hreads/\(identifier)",
            "codex://threads/%31" + String(identifier.dropFirst()),
            "codex://threads\\\(identifier)",
        ]
        guard rejected.allSatisfy({ candidate in
            guard let url = URL(string: candidate) else { return true }
            return !CodexThreadOpenTarget.accepts(url)
        }) else { return false }

        func allowed(
            source: String? = "http://127.0.0.1:41234/#accounting",
            activated: Bool = true,
            mainFrame: Bool = true,
            origin: (String, String, Int) = ("http", "127.0.0.1", 41234),
            port: Int? = 41234
        ) -> Bool {
            CodexThreadOpenTarget.acceptsNavigation(
                to: target,
                userActivated: activated,
                sourceIsMainFrame: mainFrame,
                sourceURL: source.flatMap { URL(string: $0) },
                sourceOrigin: origin,
                companionPort: port
            )
        }
        return allowed()
            && !allowed(activated: false)
            && !allowed(mainFrame: false)
            && !allowed(source: nil)
            && !allowed(source: "about:blank")
            && !allowed(source: "blob:http://127.0.0.1:41234/opaque")
            && !allowed(source: "https://example.invalid/")
            && !allowed(source: "http://127.0.0.1:41235/")
            && !allowed(source: "http://user@127.0.0.1:41234/")
            && !allowed(origin: ("https", "127.0.0.1", 41234))
            && !allowed(origin: ("http", "example.invalid", 41234))
            && !allowed(origin: ("http", "127.0.0.1", 41235))
            && !allowed(port: nil)
    }

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
        let menu = NSMenu(title: "dashboard-context-menu")
        addItem(backIdentifier, to: menu)
        addItem(forwardIdentifier, to: menu)
        addItem(reloadIdentifier, to: menu)
        addItem(downloadIdentifier, to: menu)
        addItem(openLinkIdentifier, to: menu)

        NativeDashboardWebView.stripUnsupportedContextMenuItems(from: menu)
        let remaining = Set(menu.items.compactMap(\.identifier))
        let mandatoryToolbarItems =
            AppDelegate.mandatoryDashboardToolbarItemIdentifiers
        let expectedToolbarItems: Set<NSToolbarItem.Identifier> = [
            .toggleSidebar,
            AppDelegate.toolbarStatusRefreshIdentifier,
            AppDelegate.toolbarShareIdentifier,
            AppDelegate.toolbarSettingsIdentifier,
        ]

        let backRemoved = !remaining.contains(backIdentifier)
        let forwardRemoved = !remaining.contains(forwardIdentifier)
        let reloadPreserved = remaining.contains(reloadIdentifier)
        let downloadRemoved = !remaining.contains(downloadIdentifier)
        let openLinkPreserved = remaining.contains(openLinkIdentifier)
        let usesSubclass = host.webView is NativeDashboardWebView
        let linkPreviewDisabled = !host.webView.allowsLinkPreview
        let toolbarItemsImmovable = mandatoryToolbarItems
            == expectedToolbarItems
        let settingsTabs = NSTabViewController()
        settingsTabs.tabStyle = .toolbar
        for identifier in NativeSettingsToolbarPolicy
            .mandatoryTabIdentifiers {
            let item = NSTabViewItem(identifier: identifier)
            item.label = identifier.rawValue
            item.viewController = NSViewController()
            settingsTabs.addTabViewItem(item)
        }
        let settingsWindow = NSWindow(
            contentViewController: settingsTabs
        )
        guard let settingsToolbar = settingsWindow.toolbar else { return 1 }
        let settingsDelegate = NativeSettingsToolbarDelegate(
            tabController: settingsTabs
        )
        settingsToolbar.delegate = settingsDelegate
        let expectedSettingsItems =
            NativeSettingsToolbarPolicy.mandatoryTabIdentifiers
        let settingsDelegateInstalled = settingsToolbar.delegate
            === settingsDelegate
        let settingsTabsImmovable = expectedSettingsItems.count == 3
            && settingsDelegate.toolbarImmovableItemIdentifiers(settingsToolbar)
                .isSuperset(of: expectedSettingsItems)
            && Set(settingsDelegate.toolbarDefaultItemIdentifiers(
                settingsToolbar
            )) == expectedSettingsItems
        let codexThreadLinksSafe = codexThreadPolicyIsSafe()

        guard backRemoved,
              forwardRemoved,
              reloadPreserved,
              downloadRemoved,
              openLinkPreserved,
              usesSubclass,
              linkPreviewDisabled,
              toolbarItemsImmovable,
              settingsTabsImmovable,
              settingsDelegateInstalled,
              codexThreadLinksSafe
        else {
            FileHandle.standardError.write(Data(
                ("macOS native interaction safety smoke failed "
                    + "back_removed=\(backRemoved) "
                    + "forward_removed=\(forwardRemoved) "
                    + "reload_preserved=\(reloadPreserved) "
                    + "download_removed=\(downloadRemoved) "
                    + "open_link_preserved=\(openLinkPreserved) "
                    + "subclass=\(usesSubclass) "
                    + "link_preview_disabled=\(linkPreviewDisabled) "
                    + "toolbar_immovable=\(toolbarItemsImmovable) "
                    + "settings_tabs_immovable="
                    + "\(settingsTabsImmovable) "
                    + "settings_delegate="
                    + "\(settingsDelegateInstalled) "
                    + "codex_thread_links_safe=\(codexThreadLinksSafe)\n").utf8
            ))
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_NATIVE_INTERACTION_SAFETY "
                + "back=false forward=false reload=true "
                + "download_link=false open_link=true "
                + "link_preview=false toolbar_immovable=true "
                + "settings_tabs_immovable=true settings_delegate=true "
                + "codex_thread_links_safe=true"
        )
        return 0
    }

    private static func addItem(
        _ identifier: NSUserInterfaceItemIdentifier,
        to menu: NSMenu
    ) {
        let item = NSMenuItem(
            title: identifier.rawValue,
            action: nil,
            keyEquivalent: ""
        )
        item.identifier = identifier
        menu.addItem(item)
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
        // TiboTattle has no document-style multi-window workflow. Opt out
        // before AppKit creates the application or any windows so it does not
        // expose a browser-style tab bar with no product meaning.
        NSWindow.allowsAutomaticWindowTabbing = false
        let arguments = Array(CommandLine.arguments.dropFirst())
        // This isolated seam smoke intentionally runs before bundle branding
        // is resolved, so it can execute as a plain launcher binary without
        // constructing the production login-item adapter.
        if arguments.contains("--login-item-contract-smoke-test") {
            exit(LoginItemContractSmokeTest.run())
        }
        BundledProduct.validateRuntimeIdentity()
        if arguments.contains("--keychain-broker-contract-smoke-test") {
            guard CompanionProcess.verifyKeychainLaunchContract() else { exit(1) }
            print(
                "USAGE_MONITOR_MACOS_KEYCHAIN_LAUNCH_CONTRACT "
                    + "required=true failures=construction,endpoint "
                    + "child_started=false stop_callbacks=once keychain_access=0"
            )
            exit(ContributionDeviceKeychainBroker.runContractSmokeTest())
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
        if arguments.contains(
            "--native-keychain-migration-ui-contract-smoke-test"
        ) {
            guard BundledProduct.buildChannel == "development" else { exit(2) }
            exit(MainActor.assumeIsolated {
                NativeKeychainMigrationUIContractSmokeTest.run()
            })
        }
        if arguments.contains(
            "--native-appearance-settings-contract-smoke-test"
        ) {
            exit(NativeAppearanceSettingsContractSmokeTest.run())
        }
        if arguments.contains("--native-analysis-progress-contract-smoke-test") {
            exit(NativeAnalysisProgressContractSmokeTest.run())
        }
        if let paceIndex = arguments.firstIndex(
            of: "--native-weekly-pace-projection-contract-smoke-test"
        ) {
            guard paceIndex + 1 < arguments.count,
                  BundledProduct.buildChannel == "development"
            else {
                exit(2)
            }
            exit(NativeWeeklyPaceProjectionContractSmokeTest.run(
                fixturePath: arguments[paceIndex + 1]
            ))
        }
        if arguments.contains("--menu-bar-contract-smoke-test") {
            exit(MainActor.assumeIsolated {
                MenuBarContractSmokeTest.run()
            })
        }
        if arguments.contains("--menu-bar-interaction-smoke-test") {
            guard BundledProduct.buildChannel == "development" else { exit(2) }
            exit(MainActor.assumeIsolated {
                MenuBarContractSmokeTest.runInteractionHarness()
            })
        }
        if let overviewRenderIndex = arguments.firstIndex(
            of: "--menu-bar-overview-render-smoke-test"
        ) {
            guard overviewRenderIndex + 2 < arguments.count,
                  BundledProduct.buildChannel == "development"
            else { exit(2) }
            exit(MainActor.assumeIsolated {
                MenuBarContractSmokeTest.renderOverview(
                    inputPath: arguments[overviewRenderIndex + 1],
                    outputDirectory: arguments[overviewRenderIndex + 2]
                )
            })
        }
        if let renderIndex = arguments.firstIndex(
            of: "--menu-bar-popover-render-smoke-test"
        ) {
            guard renderIndex + 1 < arguments.count else { exit(2) }
            exit(MainActor.assumeIsolated {
                MenuBarContractSmokeTest.render(
                    outputDirectory: arguments[renderIndex + 1]
                )
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
        if arguments.contains("--native-dashboard-sidebar-recovery-smoke-test") {
            exit(MainActor.assumeIsolated {
                NativeDashboardSidebarRecoverySmokeTest.run()
            })
        }
        if arguments.contains("--native-dashboard-interaction-safety-smoke-test") {
            exit(MainActor.assumeIsolated {
                NativeDashboardInteractionSafetySmokeTest.run()
            })
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate(semanticOpenTarget: semanticOpenTarget)
        application.delegate = delegate
        application.run()
    }
}
