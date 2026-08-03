import AppKit
import Foundation

// The menu-bar surface is deliberately additive. It never becomes the only
// place the app lives: the Dock icon, the regular activation policy, and the
// primary window are all left exactly as the launcher configures them. What
// this file adds is a glanceable, honest projection of the local companion's
// own evidence plus the two actions a background monitor needs at hand.
//
// Honesty rules encoded here:
//   * no number is ever synthesised, interpolated, or carried forward;
//   * a number is shown in the menu bar only while the companion itself
//     reports live evidence inside its own freshness window;
//   * stale or absent evidence collapses to a neutral placeholder and the
//     menu explains, in words, why there is no number.

/// One quota lane the local companion actually observed. The menu deliberately
/// knows only the safe display category, remaining percentage, and reset time;
/// it never exposes an account label, raw provider identifier, or inferred
/// allowance.
struct ObservedQuotaLane: Equatable {
    let label: String
    let remainingPercent: Double
    let resetAt: Date?
    let observedAt: Date?
    let isPrimary: Bool

    /// Whole-percent rendering matches the dashboard quota cards.
    var roundedRemainingPercent: Int {
        Int(min(100, max(0, remainingPercent)).rounded())
    }
}

/// The subset of `/api/local/overview` the menu bar reads. Everything else in
/// that payload stays where it belongs: in the dashboard.
struct LocalCompanionOverview: Equatable {
    let lanes: [ObservedQuotaLane]
    let observedAt: Date?
    /// The companion's own vocabulary: `live`, `stale`, or `unavailable`.
    let freshnessStatus: String
    let staleAfterSeconds: Double?
    let evidenceAvailable: Bool
}

/// Whether an explicit local analysis pass is running, from whichever surface
/// started it. The dashboard and the menu bar share one controller in the
/// companion, so the menu bar can never start a second concurrent pass.
enum LocalAnalysisActivity: Equatable {
    case idle
    case running
}

/// Result of asking the companion to start the existing refresh pass.
enum LocalAnalysisStart: Equatable {
    case started
    case alreadyRunning
    case rejected(String)
    case unreachable
}

/// The status item keeps the product's bird mark at a glance, while the small
/// meter carries only the state that the compact title is allowed to claim.
/// Evidence state remains separate from the visual treatment so stale or
/// unavailable data can never be made to look like a fresh percentage.
private enum StatusGlyphState: Equatable {
    case live(remainingPercent: Double)
    case stale
    case analyzing
    case unavailable
}

/// A deliberately small observable contract for the native menu smoke test.
/// It contains presentation facts only, never evidence values or an account
/// identifier, so the packaged launcher can prove this surface without
/// touching the local companion or a live quota response.
struct NativeMenuPresentationContract: Equatable {
    let informationRowsAreNative: Bool
    let informationRowsHaveTitles: Bool
    let unavailableRowHasTitle: Bool
    let analyzeShortcut: String
    let settingsShortcut: String
    let quitShortcut: String
    let usesNativeStatusItemMenu: Bool
    let escapeDismissalMonitorInstalled: Bool
    let sameAppClickAwayMonitorInstalled: Bool
    let appDeactivationDismissalObserverInstalled: Bool
}

/// Everything the menu-bar surface renders, derived only from observed state.
struct MenuBarStatusSnapshot: Equatable {
    enum Phase: Equatable {
        /// The companion has not reported a loopback dashboard yet.
        case starting
        /// The companion failed to start, or exited unexpectedly.
        case unavailable
        /// The companion is ready and an explicit analysis pass is running.
        case analyzing
        /// The companion is ready and idle.
        case ready
    }

    enum Evidence: Equatable {
        /// No allowance window has ever been observed.
        case none
        /// A window was observed, but outside the companion's freshness window.
        case stale
        /// A window was observed inside the companion's freshness window.
        case live
    }

    var phase: Phase = .starting
    var evidence: Evidence = .none
    var lanes: [ObservedQuotaLane] = []
    var observedAt: Date?
    var failureSummary: String?

    /// Mirrors the dashboard's primary selection across the normal Codex
    /// allowance track. Other provider products are rejected while decoding,
    /// so they cannot become a fallback for the compact title.
    var primaryLane: ObservedQuotaLane? {
        lanes.first(where: \.isPrimary) ?? lanes.first
    }

    /// True only when the companion has published a loopback dashboard.
    var companionReachable: Bool {
        phase == .ready || phase == .analyzing
    }

    /// The compact menu-bar title. A number appears only for live evidence.
    /// `…` means "an explicit pass is running", `–` means "no number can be
    /// shown honestly right now" and the menu says which case applies.
    var title: String {
        if phase == .analyzing { return analyzingPlaceholder }
        guard phase == .ready, evidence == .live, let lane = primaryLane else {
            return unknownPlaceholder
        }
        return "\(lane.roundedRemainingPercent)%"
    }

    /// Spoken by VoiceOver in place of the glyph and the terse title. The
    /// product name is passed in so this projection stays free of any bundle
    /// lookup and of any shared mutable state.
    func accessibilityLabel(productName: String) -> String {
        "\(productName): \(allowanceSummary). \(evidenceSummary)"
    }

    /// First disabled information row, and the tooltip's first line.
    var allowanceSummary: String {
        guard !lanes.isEmpty else {
            return "No verified Codex allowance observed yet"
        }
        guard companionReachable, evidence == .live else {
            return "Quota lanes were last observed, but are not current"
        }
        return "\(lanes.count) verified Codex allowance\(lanes.count == 1 ? "" : "s")"
    }

    /// Second disabled information row: why the title says what it says.
    var evidenceSummary: String {
        switch phase {
        case .starting:
            return "Starting the local companion…"
        case .unavailable:
            guard let failureSummary, !failureSummary.isEmpty else {
                return "The local companion is not running."
            }
            return failureSummary
        case .analyzing:
            return "Analyzing local usage…"
        case .ready:
            break
        }
        switch evidence {
        case .live:
            guard let observedAt else {
                return "Observed locally · verified current evidence"
            }
            return "Observed \(relativeAge(observedAt)) · verified current evidence"
        case .stale:
            guard let observedAt else {
                return "Local evidence is stale. Allowance values and reset countdowns are hidden."
            }
            return "Last observed \(relativeAge(observedAt)) · stale. "
                + "Allowance values and reset countdowns are hidden."
        case .none:
            return "No verified quota observation yet · choose Analyze Local Usage."
        }
    }

    /// A lane is safe to render numerically only while its shared observation
    /// is both fresh and verified by the local companion. Reset countdowns
    /// follow the same rule, so the menu never turns a historic reset into a
    /// current claim.
    func laneSummary(_ lane: ObservedQuotaLane, now: Date = Date()) -> String {
        guard companionReachable, evidence == .live else {
            return "\(lane.label): last observation is not current"
        }
        let remaining = "\(lane.roundedRemainingPercent)% remaining"
        guard let reset = resetCountdown(lane.resetAt, now: now) else {
            return "\(lane.label): \(remaining) · reset time unavailable"
        }
        return "\(lane.label): \(remaining) · resets \(reset)"
    }

    /// The local analysis action names the state it will enter or is already
    /// in. First launch remains explicit; later stale evidence can be refreshed
    /// by the bounded while-open scheduler below.
    var analysisActionTitle: String {
        switch phase {
        case .analyzing:
            return "Analyzing Local Usage…"
        case .ready:
            return evidence == .none
                ? "Analyze Local Usage"
                : "Update Local Usage"
        case .starting:
            return "Waiting to Analyze Local Usage"
        case .unavailable:
            return "Retry Local Analysis"
        }
    }
}

private let analyzingPlaceholder = "…"
private let unknownPlaceholder = "–"
private let codexPrimaryLimitId = "codex"
private let fiveHourWindowDurationMinutes = 300
private let weeklyWindowDurationMinutes = 10_080
private let supportedCodexAllowanceWindowDurations: Set<Int> = [
    fiveHourWindowDurationMinutes,
    weeklyWindowDurationMinutes
]
private let defaultStaleAfterSeconds: Double = 30 * 60

/// Deterministic, locale-independent age wording. Deliberately coarse: the
/// menu should say "about how old", never imply precision the evidence
/// does not have.
func relativeAge(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 90 { return "just now" }
    let minutes = Int((seconds / 60).rounded())
    if minutes < 60 {
        return "\(minutes) minute\(minutes == 1 ? "" : "s") ago"
    }
    let hours = Int((seconds / 3_600).rounded())
    if hours < 48 {
        return "\(hours) hour\(hours == 1 ? "" : "s") ago"
    }
    let days = Int((seconds / 86_400).rounded())
    return "\(days) day\(days == 1 ? "" : "s") ago"
}

/// Countdown wording is deliberately available only to a caller that has
/// already established fresh local evidence. It returns nil for a passed or
/// absent reset rather than implying a new reset period.
func resetCountdown(_ date: Date?, now: Date = Date()) -> String? {
    guard let date else { return nil }
    let seconds = date.timeIntervalSince(now)
    guard seconds > 0 else { return nil }
    let totalMinutes = max(1, Int((seconds / 60).rounded(.down)))
    let days = totalMinutes / (24 * 60)
    let hours = (totalMinutes % (24 * 60)) / 60
    let minutes = totalMinutes % 60
    if days > 0 { return "in \(days)d \(hours)h" }
    if hours > 0 { return "in \(hours)h \(minutes)m" }
    return "in \(minutes)m"
}

/// Pure projection of the companion's overview payload. Kept free of AppKit so
/// it stays trivially reviewable, and free of any fallback that would invent a
/// value when a field is missing or malformed.
enum LocalCompanionOverviewProjection {
    static func decode(_ data: Data) -> LocalCompanionOverview? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any]
        else {
            return nil
        }
        // Formatters are created per decode: this runs off the main thread at
        // most once every few minutes, and per-call instances remove any
        // shared mutable state between the network queue and the main queue.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        func timestamp(_ value: Any?) -> Date? {
            guard let text = value as? String, !text.isEmpty else { return nil }
            return fractional.date(from: text) ?? plain.date(from: text)
        }

        let freshness = root["freshness"] as? [String: Any]
        let quota = root["quota"] as? [String: Any]
        let rows = root["quotaWindows"] as? [[String: Any]]
            ?? quota?["windows"] as? [[String: Any]]
            ?? []
        let lanes = rows.compactMap { row -> ObservedQuotaLane? in
            guard let number = row["remainingPercent"] as? NSNumber else {
                return nil
            }
            let remaining = number.doubleValue
            guard remaining.isFinite, remaining >= 0, remaining <= 100 else {
                return nil
            }
            let limitId = row["limitId"] as? String ?? "unknown"
            let duration = (row["durationMinutes"] as? NSNumber)?.intValue
            guard Self.isSupportedCodexAllowance(
                limitId: limitId,
                durationMinutes: duration
            ), let duration else {
                return nil
            }
            return ObservedQuotaLane(
                label: laneLabel(durationMinutes: duration),
                remainingPercent: remaining,
                resetAt: timestamp(row["resetAt"]),
                observedAt: timestamp(row["observedAt"]),
                // The seven-day base Codex limit is the primary status item
                // regardless of the provider's transient slot label.
                isPrimary: duration == weeklyWindowDurationMinutes
            )
        }.sorted { left, right in
            if left.isPrimary != right.isPrimary { return left.isPrimary }
            return left.label.localizedStandardCompare(right.label) == .orderedAscending
        }
        // Never borrow the aggregate timestamp from a separate quota product:
        // freshness must be evidence from the normal Codex allowance itself.
        let observedAt = lanes.compactMap(\.observedAt).max()
        let staleAfter = freshness?["staleAfterSeconds"] as? Double
        return LocalCompanionOverview(
            lanes: lanes,
            observedAt: observedAt,
            freshnessStatus: freshness?["status"] as? String
                ?? root["status"] as? String
                ?? "unavailable",
            staleAfterSeconds: staleAfter.map { max(0, $0) },
            evidenceAvailable: root["evidenceStatus"] as? String == "available"
        )
    }

    /// Classify an overview into what the menu bar is allowed to display.
    static func evidence(
        for overview: LocalCompanionOverview,
        now: Date = Date()
    ) -> MenuBarStatusSnapshot.Evidence {
        guard !overview.lanes.isEmpty else { return .none }
        guard overview.freshnessStatus == "live" else { return .stale }
        guard let observedAt = overview.observedAt else { return .stale }
        let limit = overview.staleAfterSeconds ?? defaultStaleAfterSeconds
        return now.timeIntervalSince(observedAt) <= limit ? .live : .stale
    }

    /// The overview intentionally carries no free-form labels. This fixed
    /// vocabulary gives the normal Codex allowance a readable, privacy-safe
    /// name without surfacing provider/account identifiers from raw records.
    private static func isSupportedCodexAllowance(
        limitId: String,
        durationMinutes: Int?
    ) -> Bool {
        guard limitId == codexPrimaryLimitId,
              let durationMinutes else {
            return false
        }
        return supportedCodexAllowanceWindowDurations.contains(durationMinutes)
    }

    private static func laneLabel(
        durationMinutes: Int
    ) -> String {
        if durationMinutes == fiveHourWindowDurationMinutes {
            return "Five-hour allowance"
        }
        return "Seven-day allowance"
    }
}

/// Bounded loopback reads of the local companion. Every request is ephemeral,
/// short, size-capped, and never cached or written to disk. Results are
/// delivered on the main queue so callers stay on one thread.
final class LocalCompanionEvidenceReader {
    private static let maximumResponseBytes = 32 * 1_024 * 1_024
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 10
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    func invalidate() {
        session.invalidateAndCancel()
    }

    func readOverview(
        base: URL,
        completion: @escaping (LocalCompanionOverview?) -> Void
    ) {
        guard let url = loopbackEndpoint(base, path: "/api/local/overview")
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let payload = Self.acceptedPayload(data, response)
            let overview = payload.flatMap(
                LocalCompanionOverviewProjection.decode
            )
            DispatchQueue.main.async { completion(overview) }
        }
        task.resume()
    }

    func readAnalysisActivity(
        base: URL,
        completion: @escaping (LocalAnalysisActivity?) -> Void
    ) {
        guard let url = loopbackEndpoint(base, path: "/api/local/refresh")
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let activity = Self.acceptedPayload(data, response)
                .flatMap { Self.decodeActivity($0) }
            DispatchQueue.main.async { completion(activity) }
        }
        task.resume()
    }

    /// Starts the companion's own refresh pass: the exact route the dashboard
    /// button uses, with the same same-origin proof and the same fixed
    /// `user_request` body the companion accepts.
    func startAnalysis(
        base: URL,
        completion: @escaping (LocalAnalysisStart) -> Void
    ) {
        guard let url = loopbackEndpoint(base, path: "/api/local/refresh"),
              let origin = loopbackOrigin(base)
        else {
            completion(.unreachable)
            return
        }
        var mutation = request(url, method: "POST")
        mutation.setValue("application/json", forHTTPHeaderField: "Content-Type")
        mutation.setValue(origin, forHTTPHeaderField: "Origin")
        mutation.httpBody = Data(#"{"reason":"user_request"}"#.utf8)
        let task = session.dataTask(with: mutation) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let result: LocalAnalysisStart
            switch status {
            case 202:
                result = .started
            case 409:
                result = .alreadyRunning
            case .some(let code):
                let payload = data.flatMap {
                    try? JSONSerialization.jsonObject(with: $0)
                        as? [String: Any]
                }
                result = .rejected(
                    (payload?["error"] as? String)
                        ?? (payload?["code"] as? String)
                        ?? "http_\(code)"
                )
            case .none:
                result = .unreachable
            }
            DispatchQueue.main.async { completion(result) }
        }
        task.resume()
    }

    private func request(_ url: URL, method: String) -> URLRequest {
        var value = URLRequest(url: url)
        value.httpMethod = method
        value.setValue("application/json", forHTTPHeaderField: "Accept")
        // The companion requires this header on every local mutation, and
        // accepts it on reads, as proof the caller is a first-party surface.
        value.setValue("1", forHTTPHeaderField: "X-Usage-Monitor-Local")
        return value
    }

    /// Only ever addresses the loopback dashboard the companion published.
    private func loopbackEndpoint(_ base: URL, path: String) -> URL? {
        guard var components = URLComponents(
            url: base,
            resolvingAgainstBaseURL: false
        ),
            components.scheme == "http",
            let host = components.host,
            host == "127.0.0.1" || host == "localhost",
            components.port != nil
        else {
            return nil
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private func loopbackOrigin(_ base: URL) -> String? {
        guard let host = base.host, let port = base.port else { return nil }
        return "http://\(host):\(port)"
    }

    private static func acceptedPayload(
        _ data: Data?,
        _ response: URLResponse?
    ) -> Data? {
        guard let data,
              (response as? HTTPURLResponse)?.statusCode == 200,
              data.count <= maximumResponseBytes
        else {
            return nil
        }
        return data
    }

    private static func decodeActivity(_ data: Data) -> LocalAnalysisActivity? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any],
            let refresh = root["refresh"] as? [String: Any],
            let status = refresh["status"] as? String
        else {
            return nil
        }
        return ["running", "cancelling"].contains(status) ? .running : .idle
    }
}

/// Owns the `NSStatusItem`, its menu, and the bounded polling that keeps the
/// compact title honest. Actions are injected so the launcher keeps sole
/// ownership of the companion lifecycle and the shutdown path.
@MainActor
final class MenuBarStatusController: NSObject, NSMenuDelegate {
    struct Actions {
        /// Brings the actual TiboTattle window forward and opens its embedded
        /// dashboard when the loopback companion is ready.
        let openTiboTattle: () -> Void
        let showSettings: () -> Void
        let showAbout: () -> Void
        let quit: () -> Void
        /// Absent in a build with no updater, which omits the row rather than
        /// offering a check that can never find anything.
        var checkForUpdates: (() -> Void)?
    }

    /// Background cadence while the companion is idle. A minute is cheap on
    /// loopback and means a cached observation cannot sit visibly stale for
    /// several minutes before the automatic updater notices it.
    private static let idlePollSeconds = 60
    /// Cadence while an explicit pass is running, so the menu bar returns to a
    /// real number promptly once the pass finishes.
    private static let activePollSeconds = 5
    private static let menuMinimumWidth: CGFloat = 338
    private static let deferredLaneTitle =
        "Quota values are unavailable until a fresh local observation."

    private let statusItem: NSStatusItem
    private let actions: Actions
    private let productName: String
    private let brandBirdTemplate: NSImage?
    private let reader = LocalCompanionEvidenceReader()
    private let allowanceItem = NSMenuItem()
    private let evidenceItem = NSMenuItem()
    private let menu = NSMenu()
    private let quotaSeparator = NSMenuItem.separator()
    private let actionSeparator = NSMenuItem.separator()
    private var quotaLaneItems: [NSMenuItem] = []
    private let openTiboTattleItem = NSMenuItem()
    private let analyzeItem = NSMenuItem()
    private let settingsItem = NSMenuItem()
    private let aboutItem = NSMenuItem()
    private let checkForUpdatesItem = NSMenuItem()
    private let quitItem = NSMenuItem()
    private var snapshot = MenuBarStatusSnapshot()
    private var dashboardURL: URL?
    private var companionGeneration: UInt64 = 0
    private var overviewResponseHealthy = false
    private var observedEvidenceExpiresAt: Date?
    private var pendingPoll: DispatchWorkItem?
    private var lastAutomaticRefreshAt: Date?
    private var automaticRefreshInFlight = false
    private var isMenuTracking = false
    private var refreshAfterMenuCloses = false
    private var structuralRebuildPending = false
    private var renderedLaneLabels: [String] = []
    private var escapeMonitor: Any?
    private var localMouseMonitor: Any?
    private var appDeactivationObserver: NSObjectProtocol?
    private var stopped = false

    init(productName: String, actions: Actions) {
        self.productName = productName
        self.actions = actions
        self.brandBirdTemplate = Self.makeBrandBirdTemplate()
        // Constructing the item touches only in-memory AppKit state: no
        // network, no disk, and no waiting. Every evidence read below is
        // asynchronous with a main-queue completion.
        statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength
        )
        super.init()
        installInteractionMonitoring()

        // Explicit enablement: information rows must stay unclickable, and
        // actions must reflect the companion's real state, not AppKit's guess.
        menu.autoenablesItems = false
        menu.delegate = self
        menu.minimumWidth = Self.menuMinimumWidth

        allowanceItem.isEnabled = false
        evidenceItem.isEnabled = false
        // Keep both information rows as ordinary native menu items. AppKit
        // sizes their titles itself, so a state transition can never leave a
        // zero-frame custom view or an invisible fallback behind.
        menu.addItem(allowanceItem)
        menu.addItem(evidenceItem)
        menu.addItem(quotaSeparator)
        menu.addItem(actionSeparator)

        configure(
            openTiboTattleItem,
            "Open \(productName)",
            #selector(openTiboTattle)
        )
        configure(
            analyzeItem,
            "Analyze Local Usage",
            #selector(analyzeLocalUsage)
        )
        analyzeItem.keyEquivalent = "r"
        analyzeItem.keyEquivalentModifierMask = [.command]
        menu.addItem(openTiboTattleItem)
        menu.addItem(analyzeItem)
        if actions.checkForUpdates != nil {
            configure(
                checkForUpdatesItem,
                "Check for Updates…",
                #selector(checkForUpdates)
            )
            checkForUpdatesItem.isEnabled = true
            menu.addItem(checkForUpdatesItem)
        }
        configure(settingsItem, "Settings…", #selector(showSettings))
        settingsItem.keyEquivalent = ","
        settingsItem.keyEquivalentModifierMask = [.command]
        configure(aboutItem, "About \(productName)", #selector(showAbout))
        menu.addItem(settingsItem)
        menu.addItem(aboutItem)
        menu.addItem(.separator())

        configure(quitItem, "Quit \(productName)", #selector(quit))
        quitItem.keyEquivalent = "q"
        quitItem.keyEquivalentModifierMask = [.command]
        menu.addItem(quitItem)

        statusItem.menu = menu
        if let button = statusItem.button {
            button.image = Self.statusGlyph(
                productName: productName,
                state: Self.glyphState(for: snapshot),
                brandBirdTemplate: brandBirdTemplate
            )
            button.imagePosition = .imageLeading
            button.imageScaling = .scaleProportionallyDown
            // Monospaced digits keep the item from jittering as the percentage
            // changes width.
            button.font = NSFont.monospacedDigitSystemFont(
                ofSize: NSFont.systemFontSize,
                weight: .regular
            )
        }
        render()
    }

    /// The companion published a loopback dashboard: start reading evidence.
    func companionReady(dashboardURL: URL) {
        guard !stopped else { return }
        companionGeneration &+= 1
        self.dashboardURL = dashboardURL
        overviewResponseHealthy = false
        invalidateObservedEvidence()
        automaticRefreshInFlight = false
        lastAutomaticRefreshAt = nil
        snapshot.phase = .ready
        snapshot.failureSummary = nil
        render()
        pollNow()
    }

    /// The companion is starting, or restarting after an explicit retry.
    func companionStarting() {
        guard !stopped else { return }
        companionGeneration &+= 1
        dashboardURL = nil
        cancelPoll()
        overviewResponseHealthy = false
        automaticRefreshInFlight = false
        lastAutomaticRefreshAt = nil
        invalidateObservedEvidence()
        snapshot.phase = .starting
        snapshot.failureSummary = nil
        render()
    }

    /// The companion failed to start or exited unexpectedly. Numeric evidence
    /// belongs to the old companion and is invalidated before the menu renders
    /// the failure state.
    func companionUnavailable(summary: String?) {
        guard !stopped else { return }
        companionGeneration &+= 1
        dashboardURL = nil
        cancelPoll()
        overviewResponseHealthy = false
        automaticRefreshInFlight = false
        lastAutomaticRefreshAt = nil
        invalidateObservedEvidence()
        snapshot.phase = .unavailable
        snapshot.failureSummary = summary
        render()
    }

    /// Released on termination so the item never outlives the app.
    func shutDown() {
        guard !stopped else { return }
        refreshAfterMenuCloses = false
        structuralRebuildPending = false
        dismissMenu()
        stopped = true
        companionGeneration &+= 1
        cancelPoll()
        reader.invalidate()
        removeInteractionMonitoring()
        statusItem.menu = nil
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    /// Used only by the packaged AppKit smoke mode. The test instantiates the
    /// actual status item and menu, then verifies the rows AppKit will render
    /// are ordinary titled menu items rather than zero-frame custom views.
    func nativePresentationContract() -> NativeMenuPresentationContract {
        let informationItems = [allowanceItem, evidenceItem]
        return NativeMenuPresentationContract(
            informationRowsAreNative: informationItems.allSatisfy {
                $0.view == nil && !$0.isEnabled
            },
            informationRowsHaveTitles: informationItems.allSatisfy {
                !$0.title.trimmingCharacters(in: .whitespacesAndNewlines)
                    .isEmpty
            },
            unavailableRowHasTitle: !evidenceItem.title
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty,
            analyzeShortcut: analyzeItem.keyEquivalent,
            settingsShortcut: settingsItem.keyEquivalent,
            quitShortcut: quitItem.keyEquivalent,
            usesNativeStatusItemMenu: statusItem.menu === menu,
            escapeDismissalMonitorInstalled: escapeMonitor != nil,
            sameAppClickAwayMonitorInstalled: localMouseMonitor != nil,
            appDeactivationDismissalObserverInstalled:
                appDeactivationObserver != nil
        )
    }

    /// AppKit normally dismisses an `NSStatusItem` menu for both Escape and an
    /// application switch. Keep those baseline interactions explicit as well:
    /// the menu remains a native status-item menu, while the monitor and
    /// notification only call AppKit's own tracking cancellation API.
    private func installInteractionMonitoring() {
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
            [weak self] event in
            guard event.keyCode == 53,
                  let self,
                  self.isMenuTracking
            else {
                return event
            }
            self.dismissMenu()
            return nil
        }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            guard let self,
                  self.isMenuTracking,
                  let eventWindow = event.window,
                  NSApp.windows.contains(where: { $0 === eventWindow })
            else {
                return event
            }
            // The menu's own window is not an application window, so native
            // menu-item clicks continue through AppKit. A click in any of the
            // app's windows is an unambiguous same-app click-away.
            self.dismissMenu()
            return event
        }
        appDeactivationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            self?.dismissMenu()
        }
    }

    private func removeInteractionMonitoring() {
        if let localMouseMonitor {
            NSEvent.removeMonitor(localMouseMonitor)
            self.localMouseMonitor = nil
        }
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
        if let appDeactivationObserver {
            NotificationCenter.default.removeObserver(appDeactivationObserver)
            self.appDeactivationObserver = nil
        }
    }

    /// Ends the current native menu tracking session before focus or app
    /// ownership changes. Calling this while the menu is already closed is
    /// harmless and keeps every menu action on the same path.
    private func dismissMenu() {
        menu.cancelTracking()
        isMenuTracking = false
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        // Reconcile cached titles and any pending lane structure before AppKit
        // begins tracking. Reads below are asynchronous; their completions may
        // update existing titles but cannot mutate the open menu's structure.
        isMenuTracking = false
        structuralRebuildPending = false
        render()
        isMenuTracking = true
        pollNow()
    }

    func menuDidClose(_ menu: NSMenu) {
        isMenuTracking = false
        if structuralRebuildPending {
            structuralRebuildPending = false
            render()
        }
        guard refreshAfterMenuCloses else { return }
        refreshAfterMenuCloses = false
        refreshStaleEvidenceIfNeeded()
    }

    // MARK: - Actions

    @objc private func openTiboTattle() {
        dismissMenu()
        actions.openTiboTattle()
    }

    @objc private func analyzeLocalUsage() {
        guard !stopped,
              let dashboardURL,
              snapshot.phase == .ready || snapshot.phase == .unavailable
        else {
            return
        }
        dismissMenu()
        let generation = companionGeneration
        // Optimistic only in the direction that disables the control; the real
        // state is confirmed by the response and the poll that follows.
        snapshot.phase = .analyzing
        render()
        reader.startAnalysis(base: dashboardURL) { [weak self] result in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.dashboardURL == dashboardURL
            else { return }
            switch result {
            case .started, .alreadyRunning:
                self.snapshot.phase = .analyzing
            case .rejected:
                self.snapshot.phase = self.dashboardURL == nil
                    ? .unavailable
                    : .ready
            case .unreachable:
                self.overviewResponseHealthy = false
                self.invalidateObservedEvidence()
                self.snapshot.phase = .unavailable
                self.snapshot.failureSummary =
                    "The local companion could not accept an analysis request."
            }
            self.render()
            self.pollNow()
        }
    }

    @objc private func quit() {
        dismissMenu()
        actions.quit()
    }

    @objc private func showSettings() {
        dismissMenu()
        actions.showSettings()
    }

    @objc private func showAbout() {
        dismissMenu()
        actions.showAbout()
    }

    @objc private func checkForUpdates() {
        dismissMenu()
        actions.checkForUpdates?()
    }

    // MARK: - Polling

    private func pollNow() {
        guard !stopped, let dashboardURL else { return }
        let generation = companionGeneration
        cancelPoll()
        reader.readAnalysisActivity(base: dashboardURL) { [weak self] activity in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.dashboardURL == dashboardURL
            else {
                return
            }
            switch activity {
            case .running:
                self.snapshot.phase = .analyzing
            case .idle:
                if self.overviewResponseHealthy {
                    self.snapshot.phase = .ready
                }
            case .none:
                break
            }
            self.render()
            self.schedulePoll()
        }
        reader.readOverview(base: dashboardURL) { [weak self] overview in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.dashboardURL == dashboardURL
            else {
                return
            }
            guard let overview else {
                // An unreadable response cannot support the previous number.
                // Clear it immediately and leave a retryable unavailable state
                // rather than silently retaining live-looking evidence.
                self.overviewResponseHealthy = false
                self.invalidateObservedEvidence()
                self.snapshot.phase = .unavailable
                self.snapshot.failureSummary =
                    "Quota evidence is unavailable right now. Retry Local Analysis."
                self.render()
                return
            }
            self.overviewResponseHealthy = true
            self.snapshot.lanes = overview.lanes
            self.snapshot.observedAt = overview.observedAt
            self.observedEvidenceExpiresAt = overview.observedAt.map {
                $0.addingTimeInterval(
                    overview.staleAfterSeconds ?? defaultStaleAfterSeconds
                )
            }
            self.snapshot.evidence = LocalCompanionOverviewProjection
                .evidence(for: overview)
            if self.snapshot.phase == .unavailable {
                self.snapshot.phase = .ready
                self.snapshot.failureSummary = nil
            }
            self.render()
            self.refreshStaleEvidenceIfNeeded()
        }
    }

    private func schedulePoll() {
        guard !stopped, dashboardURL != nil else { return }
        cancelPoll()
        let seconds = snapshot.phase == .analyzing
            ? Self.activePollSeconds
            : Self.idlePollSeconds
        let generation = companionGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.companionGeneration == generation else {
                return
            }
            self.pollNow()
        }
        pendingPoll = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .seconds(seconds),
            execute: work
        )
    }

    private func cancelPoll() {
        pendingPoll?.cancel()
        pendingPoll = nil
    }

    // MARK: - Rendering

    private func render() {
        expireCachedEvidenceIfNeeded()
        allowanceItem.title = "\(productName) · \(snapshot.title) allowance"
        evidenceItem.title = snapshot.evidenceSummary
        renderQuotaLanes()
        openTiboTattleItem.isEnabled = true
        analyzeItem.title = snapshot.analysisActionTitle
        analyzeItem.isEnabled = snapshot.phase == .ready
            || (snapshot.phase == .unavailable && dashboardURL != nil)
        quitItem.isEnabled = true
        guard let button = statusItem.button else { return }
        button.image = Self.statusGlyph(
            productName: productName,
            state: Self.glyphState(for: snapshot),
            brandBirdTemplate: brandBirdTemplate
        )
        button.title = snapshot.title
        button.toolTip =
            "\(snapshot.allowanceSummary)\n\(snapshot.evidenceSummary)"
        button.setAccessibilityLabel(
            snapshot.accessibilityLabel(productName: productName)
        )
    }

    private func invalidateObservedEvidence() {
        snapshot.lanes = []
        snapshot.observedAt = nil
        snapshot.evidence = .none
        observedEvidenceExpiresAt = nil
    }

    private func expireCachedEvidenceIfNeeded() {
        guard snapshot.evidence == .live,
              let observedEvidenceExpiresAt,
              Date() > observedEvidenceExpiresAt
        else { return }
        snapshot.evidence = .stale
    }

    private func configure(
        _ item: NSMenuItem,
        _ title: String,
        _ action: Selector
    ) {
        item.title = title
        item.target = self
        item.action = action
        item.isEnabled = true
    }

    /// Adds one disabled, VoiceOver-readable line for every valid quota lane
    /// in the local overview. Stale lanes retain only their safe category and
    /// state wording; their historic percentage and reset remain hidden.
    private func renderQuotaLanes() {
        let laneLabels = snapshot.lanes.map(\.label)
        let structureChanged = laneLabels != renderedLaneLabels

        if isMenuTracking && structureChanged {
            // Structural menu edits while tracking can make AppKit lose its
            // current item or paint an inconsistent menu. Neutralise any old
            // rows in place, then rebuild them after menuDidClose.
            structuralRebuildPending = true
            for item in quotaLaneItems {
                item.title = Self.deferredLaneTitle
                item.isEnabled = false
            }
            return
        }

        if !structureChanged {
            quotaSeparator.isHidden = snapshot.lanes.isEmpty
            for (item, lane) in zip(quotaLaneItems, snapshot.lanes) {
                item.title = snapshot.laneSummary(lane)
                item.isEnabled = false
            }
            return
        }

        for item in quotaLaneItems {
            menu.removeItem(item)
        }
        quotaLaneItems = []
        quotaSeparator.isHidden = snapshot.lanes.isEmpty
        guard !snapshot.lanes.isEmpty else {
            renderedLaneLabels = laneLabels
            return
        }
        let insertionIndex = menu.index(of: actionSeparator)
        let items = snapshot.lanes.map { lane in
            let item = NSMenuItem(
                title: snapshot.laneSummary(lane),
                action: nil,
                keyEquivalent: ""
            )
            item.isEnabled = false
            return item
        }
        for (offset, item) in items.enumerated() {
            menu.insertItem(item, at: insertionIndex + offset)
        }
        quotaLaneItems = items
        renderedLaneLabels = laneLabels
        structuralRebuildPending = false
    }

    /// Keep the bird mark and quota meter in the same monochrome language as
    /// native menu-bar symbols. A real percentage gets a filled track; every
    /// other state gets an intentionally non-numeric treatment.
    private static func statusGlyph(
        productName: String,
        state: StatusGlyphState,
        brandBirdTemplate: NSImage?
    ) -> NSImage? {
        let base = brandBirdTemplate ?? nativeBirdTemplate()
        guard let base else { return nil }

        let glyphSize = NSSize(width: 16, height: 16)
        let glyph = NSImage(size: glyphSize)
        glyph.lockFocus()
        let birdRect = NSRect(x: 0.5, y: 2.5, width: 15, height: 12.5)
        let birdFraction: CGFloat = switch state {
        case .live, .analyzing:
            1
        case .stale:
            0.58
        case .unavailable:
            0.42
        }
        base.draw(
            in: birdRect,
            from: NSRect(origin: .zero, size: base.size),
            operation: .sourceOver,
            fraction: birdFraction
        )
        drawMeter(for: state, in: NSRect(x: 1.5, y: 0.25, width: 13, height: 1.75))
        glyph.unlockFocus()
        glyph.size = glyphSize
        glyph.isTemplate = true
        glyph.accessibilityDescription = "\(productName) status"
        return glyph
    }

    private static func glyphState(
        for snapshot: MenuBarStatusSnapshot
    ) -> StatusGlyphState {
        if snapshot.phase == .analyzing { return .analyzing }
        guard snapshot.phase == .ready else { return .unavailable }
        guard snapshot.evidence == .live,
              let lane = snapshot.primaryLane
        else {
            return snapshot.evidence == .stale ? .stale : .unavailable
        }
        return .live(remainingPercent: lane.remainingPercent)
    }

    /// Use a bold system bird first: SF Symbols supplies the crisp 16pt
    /// geometry that a menu bar needs. If a restricted launch context cannot
    /// resolve that symbol, derive the same mark from the approved app icon.
    private static func makeBrandBirdTemplate() -> NSImage? {
        if let native = nativeBirdTemplate() { return native }
        return makeAssetBirdTemplate()
    }

    /// Extract only the bright bird from the approved app icon as a fallback.
    /// The source artwork uses a deep-green plate behind a cream/amber mark;
    /// turning that plate into transparency avoids ever shrinking the full
    /// application icon into the status item.
    private static func makeAssetBirdTemplate() -> NSImage? {
        guard let source = NSApp.applicationIconImage,
              let sourceCGImage = source.cgImage(
                  forProposedRect: nil,
                  context: nil,
                  hints: nil
              )
        else {
            return nativeBirdTemplate()
        }

        let sourceRep = NSBitmapImageRep(cgImage: sourceCGImage)
        let sourceWidth = sourceRep.pixelsWide
        let sourceHeight = sourceRep.pixelsHigh
        guard sourceWidth > 0, sourceHeight > 0 else {
            return nativeBirdTemplate()
        }

        // NSApp's icon is a square. This crop follows the bird's visible
        // bounds, leaving the plate outside the compact status mark.
        let crop = CGRect(
            x: CGFloat(sourceWidth) * 0.14,
            y: CGFloat(sourceHeight) * 0.14,
            width: CGFloat(sourceWidth) * 0.72,
            height: CGFloat(sourceHeight) * 0.72
        )
        let pixelSize = 64
        guard let targetRep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelSize,
            pixelsHigh: pixelSize,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: [],
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return nativeBirdTemplate()
        }
        targetRep.size = NSSize(width: pixelSize, height: pixelSize)

        var retainedPixels = 0
        for y in 0..<pixelSize {
            for x in 0..<pixelSize {
                let sourceX = min(
                    sourceWidth - 1,
                    max(
                        0,
                        Int(
                            crop.minX
                                + CGFloat(x) * crop.width / CGFloat(pixelSize)
                        )
                    )
                )
                let sourceY = min(
                    sourceHeight - 1,
                    max(
                        0,
                        Int(
                            crop.minY
                                + CGFloat(y) * crop.height / CGFloat(pixelSize)
                        )
                    )
                )
                let color = sourceRep.colorAt(x: sourceX, y: sourceY)?
                    .usingColorSpace(.deviceRGB)
                let red = color?.redComponent ?? 0
                // The approved plate is substantially darker in red than
                // the bird. Keep a soft edge instead of a binary cutout.
                let alpha = min(1, max(0, (red - 0.16) / 0.26))
                if alpha > 0.05 { retainedPixels += 1 }
                var pixel = [255, 255, 255, Int((alpha * 255).rounded())]
                pixel.withUnsafeMutableBufferPointer {
                    targetRep.setPixel($0.baseAddress!, atX: x, y: y)
                }
            }
        }
        guard retainedPixels > 0 else { return nativeBirdTemplate() }

        let template = NSImage(size: NSSize(width: pixelSize, height: pixelSize))
        template.addRepresentation(targetRep)
        template.isTemplate = true
        return template
    }

    /// SF Symbols is a system-owned mark that matches TiboTattle's bird
    /// branding without introducing another bundled artwork file.
    private static func nativeBirdTemplate() -> NSImage? {
        let symbol = NSImage(
            systemSymbolName: "bird.fill",
            accessibilityDescription: "TiboTattle status"
        )
        symbol?.isTemplate = true
        return symbol
    }

    private static func drawMeter(
        for state: StatusGlyphState,
        in rect: NSRect
    ) {
        let radius = rect.height / 2
        let track = NSBezierPath(
            roundedRect: rect,
            xRadius: radius,
            yRadius: radius
        )
        switch state {
        case let .live(remainingPercent):
            NSColor.black.withAlphaComponent(0.24).setFill()
            track.fill()
            let percent = CGFloat(min(100, max(0, remainingPercent))) / 100
            guard percent > 0 else { return }
            let fillRect = NSRect(
                x: rect.minX,
                y: rect.minY,
                width: max(0.8, rect.width * percent),
                height: rect.height
            )
            NSColor.black.setFill()
            NSBezierPath(
                roundedRect: fillRect,
                xRadius: radius,
                yRadius: radius
            ).fill()
        case .analyzing:
            NSColor.black.withAlphaComponent(0.3).setFill()
            track.fill()
            NSColor.black.setFill()
            for position in [0.25, 0.5, 0.75] {
                let dotSize: CGFloat = 1.2
                let dot = NSRect(
                    x: rect.minX + rect.width * position - dotSize / 2,
                    y: rect.midY - dotSize / 2,
                    width: dotSize,
                    height: dotSize
                )
                NSBezierPath(ovalIn: dot).fill()
            }
        case .stale:
            NSColor.black.withAlphaComponent(0.55).setStroke()
            track.lineWidth = 0.8
            track.stroke()
        case .unavailable:
            NSColor.black.withAlphaComponent(0.42).setStroke()
            track.lineWidth = 0.8
            track.stroke()
        }
    }

    /// First launch still requires an explicit Analyze action. Once a real
    /// local observation exists, however, keeping the app open should not
    /// make the menu quietly become stale and force a manual repair. One
    /// shared companion controller prevents a competing pass; the cooldown
    /// limits retries if a source is temporarily unavailable.
    private func refreshStaleEvidenceIfNeeded() {
        guard !stopped,
              !automaticRefreshInFlight,
              snapshot.phase == .ready,
              snapshot.evidence == .stale,
              !snapshot.lanes.isEmpty,
              let dashboardURL
        else { return }
        // AppKit does not like a menu changing beneath the pointer. Match the
        // ordinary macOS pattern: reveal cached state while tracking, then
        // start the one bounded catch-up pass immediately after it closes.
        guard !isMenuTracking else {
            refreshAfterMenuCloses = true
            return
        }
        let now = Date()
        if let lastAutomaticRefreshAt,
           now.timeIntervalSince(lastAutomaticRefreshAt)
            < Double(Self.idlePollSeconds) {
            return
        }
        lastAutomaticRefreshAt = now
        automaticRefreshInFlight = true
        let generation = companionGeneration
        snapshot.phase = .analyzing
        render()
        reader.startAnalysis(base: dashboardURL) { [weak self] result in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.dashboardURL == dashboardURL
            else { return }
            self.automaticRefreshInFlight = false
            switch result {
            case .started, .alreadyRunning:
                self.snapshot.phase = .analyzing
            case .rejected:
                self.snapshot.phase = self.dashboardURL == nil
                    ? .unavailable
                    : .ready
            case .unreachable:
                self.overviewResponseHealthy = false
                self.invalidateObservedEvidence()
                self.snapshot.phase = .unavailable
                self.snapshot.failureSummary =
                    "The local companion could not accept an analysis request."
            }
            self.render()
            self.pollNow()
        }
    }
}
