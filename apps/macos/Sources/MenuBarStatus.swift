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
    case idle(refreshID: String?)
    case running(refreshID: String?)
}

/// Result of asking the companion to start the existing refresh pass.
enum LocalAnalysisStart: Equatable {
    case started(refreshID: String?)
    case alreadyRunning(refreshID: String?)
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
        return TiboTattleLocalization.percentString(lane.roundedRemainingPercent)
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
            return TiboTattleLocalization.string(.menuBarNoVerifiedAllowance)
        }
        guard companionReachable, evidence == .live else {
            return TiboTattleLocalization.string(
                .menuBarLastObservationNotCurrent
            )
        }
        return lanes.count == 1
            ? TiboTattleLocalization.string(.menuBarVerifiedAllowanceOne)
            : TiboTattleLocalization.format(
                .menuBarVerifiedAllowanceMany,
                lanes.count
            )
    }

    /// Second disabled information row: why the title says what it says.
    var evidenceSummary: String {
        switch phase {
        case .starting:
            return TiboTattleLocalization.string(.menuBarCompanionStarting)
        case .unavailable:
            guard let failureSummary, !failureSummary.isEmpty else {
                return TiboTattleLocalization.string(.menuBarCompanionNotRunning)
            }
            return failureSummary
        case .analyzing:
            return TiboTattleLocalization.string(.menuBarAnalyzingLocalUsage)
        case .ready:
            break
        }
        switch evidence {
        case .live:
            guard let observedAt else {
                return TiboTattleLocalization.string(.menuBarCurrentEvidence)
            }
            return TiboTattleLocalization.format(
                .menuBarCurrentEvidenceWithAge,
                relativeAge(observedAt)
            )
        case .stale:
            guard let observedAt else {
                return TiboTattleLocalization.string(.menuBarLocalEvidenceStale)
            }
            return TiboTattleLocalization.format(
                .menuBarLocalEvidenceStaleWithAge,
                relativeAge(observedAt)
            )
        case .none:
            return TiboTattleLocalization.string(.menuBarNoVerifiedQuota)
        }
    }

    /// A lane is safe to render numerically only while its shared observation
    /// is both fresh and verified by the local companion. Reset countdowns
    /// follow the same rule, so the menu never turns a historic reset into a
    /// current claim.
    func laneSummary(_ lane: ObservedQuotaLane, now: Date = Date()) -> String {
        guard companionReachable, evidence == .live else {
            return TiboTattleLocalization.format(
                .menuBarQuotaLastObserved,
                lane.label
            )
        }
        guard let reset = resetCountdown(lane.resetAt, now: now) else {
            return TiboTattleLocalization.format(
                .menuBarQuotaResetUnavailable,
                lane.label,
                TiboTattleLocalization.percentString(lane.roundedRemainingPercent)
            )
        }
        return TiboTattleLocalization.format(
            .menuBarQuotaResets,
            lane.label,
            TiboTattleLocalization.percentString(lane.roundedRemainingPercent),
            reset
        )
    }

    /// The local analysis action names the state it will enter or is already
    /// in. First launch remains explicit; later stale evidence can be refreshed
    /// by the bounded while-open scheduler below.
    var analysisActionTitle: String {
        switch phase {
        case .analyzing:
            return TiboTattleLocalization.string(.menuBarAnalyzingLocalUsage)
        case .ready:
            return evidence == .none
                ? TiboTattleLocalization.string(.menuBarAnalyzeLocalUsage)
                : TiboTattleLocalization.string(.menuBarUpdateLocalUsage)
        case .starting:
            return TiboTattleLocalization.string(.menuBarWaitingToAnalyze)
        case .unavailable:
            return TiboTattleLocalization.string(.menuBarRetryLocalAnalysis)
        }
    }
}

private let analyzingPlaceholder = "…"
private let unknownPlaceholder = "–"
private let codexPrimaryLimitId = "codex"
private let fiveHourWindowDurationMinutes =
    CodexQuotaWindowDuration.fiveHourMinutes
private let weeklyWindowDurationMinutes =
    CodexQuotaWindowDuration.sevenDayMinutes
private let supportedCodexAllowanceWindowDurations =
    1...CodexQuotaWindowDuration.maximumMinutes
private let defaultStaleAfterSeconds: Double = 30 * 60

/// Deterministic, locale-independent age wording. Deliberately coarse: the
/// menu should say "about how old", never imply precision the evidence
/// does not have.
func relativeAge(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 90 {
        return TiboTattleLocalization.string(.menuBarJustNow)
    }
    let minutes = Int((seconds / 60).rounded())
    if minutes < 60 {
        return TiboTattleLocalization.format(.menuBarMinutesAgo, minutes)
    }
    let hours = Int((seconds / 3_600).rounded())
    if hours < 48 {
        return TiboTattleLocalization.format(.menuBarHoursAgo, hours)
    }
    let days = Int((seconds / 86_400).rounded())
    return TiboTattleLocalization.format(.menuBarDaysAgo, days)
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
    if days > 0 {
        return TiboTattleLocalization.format(
            .menuBarResetDaysHours,
            days,
            hours
        )
    }
    if hours > 0 {
        return TiboTattleLocalization.format(
            .menuBarResetHoursMinutes,
            hours,
            minutes
        )
    }
    return TiboTattleLocalization.format(.menuBarResetMinutes, minutes)
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
        struct Candidate {
            let lane: ObservedQuotaLane
            let durationMinutes: Int
            let isExplicitPrimary: Bool
            let stableKey: String
        }
        let candidates = rows.compactMap { row -> Candidate? in
            guard let number = row["remainingPercent"] as? NSNumber else {
                return nil
            }
            let remaining = number.doubleValue
            guard remaining.isFinite, remaining >= 0, remaining <= 100 else {
                return nil
            }
            let limitId = row["limitId"] as? String ?? "unknown"
            let duration = CodexQuotaWindowDuration.integer(
                from: row["durationMinutes"]
            )
            guard Self.isSupportedCodexAllowance(
                limitId: limitId,
                durationMinutes: duration
            ), let duration else {
                return nil
            }
            let resetAtText = row["resetAt"] as? String ?? ""
            let observedAtText = row["observedAt"] as? String ?? ""
            let lane = ObservedQuotaLane(
                label: laneLabel(durationMinutes: duration),
                remainingPercent: remaining,
                resetAt: timestamp(resetAtText),
                observedAt: timestamp(row["observedAt"]),
                // This marker is replaced after the bounded selection below;
                // it denotes the selected status lane, not an inferred plan.
                isPrimary: false
            )
            let slot = row["slot"] as? String ?? ""
            return Candidate(
                lane: lane,
                durationMinutes: duration,
                // Preserve the current seven-day preference, while honoring a
                // provider's explicit primary slot when equal durations tie.
                isExplicitPrimary: duration == weeklyWindowDurationMinutes
                    || slot == "primary"
                    || (row["isPrimary"] as? Bool) == true,
                stableKey: [
                    slot,
                    resetAtText,
                    observedAtText,
                    String(remaining),
                ].joined(separator: "\u{0}")
            )
        }
        let lanes = candidates.sorted { left, right in
            if left.durationMinutes != right.durationMinutes {
                return left.durationMinutes > right.durationMinutes
            }
            if left.isExplicitPrimary != right.isExplicitPrimary {
                return left.isExplicitPrimary
            }
            return left.stableKey < right.stableKey
        }.enumerated().map { index, candidate in
            ObservedQuotaLane(
                label: candidate.lane.label,
                remainingPercent: candidate.lane.remainingPercent,
                resetAt: candidate.lane.resetAt,
                observedAt: candidate.lane.observedAt,
                // The first valid, longest normal Codex lane is the compact
                // status primary. Generic long windows remain visible here.
                isPrimary: index == 0
            )
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
            return TiboTattleLocalization.string(.menuBarFiveHourAllowance)
        }
        if durationMinutes == weeklyWindowDurationMinutes {
            return TiboTattleLocalization.string(.menuBarSevenDayAllowance)
        }
        return TiboTattleLocalization.quotaWindowLabel(
            durationMinutes: durationMinutes
        )
    }
}

/// Bounded loopback reads of the local companion. Every request is ephemeral,
/// short, size-capped, and never cached or written to disk. Results are
/// delivered on the main queue so callers stay on one thread.
final class LocalCompanionEvidenceReader {
    // Internal to the native source module so the fresh-only notification
    // adapter can reuse this already-audited, loopback-only transport without
    // opening a second session or adding any network route.
    static let maximumResponseBytes = 32 * 1_024 * 1_024
    let session: URLSession

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
            let refreshID = data.flatMap(Self.decodeRefreshID)
            let result: LocalAnalysisStart
            switch status {
            case 202:
                result = .started(refreshID: refreshID)
            case 409:
                result = .alreadyRunning(refreshID: refreshID)
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

    func request(_ url: URL, method: String) -> URLRequest {
        var value = URLRequest(url: url)
        value.httpMethod = method
        value.setValue("application/json", forHTTPHeaderField: "Accept")
        // The companion requires this header on every local mutation, and
        // accepts it on reads, as proof the caller is a first-party surface.
        value.setValue("1", forHTTPHeaderField: "X-Usage-Monitor-Local")
        return value
    }

    /// Only ever addresses the loopback dashboard the companion published.
    func loopbackEndpoint(_ base: URL, path: String) -> URL? {
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

    static func acceptedPayload(
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
        let refreshID = decodeRefreshID(refresh)
        return ["running", "cancelling"].contains(status)
            ? .running(refreshID: refreshID)
            : .idle(refreshID: refreshID)
    }

    private static func decodeRefreshID(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              let refresh = root["refresh"] as? [String: Any]
        else {
            return nil
        }
        return decodeRefreshID(refresh)
    }

    private static func decodeRefreshID(_ refresh: [String: Any]) -> String? {
        guard let value = refresh["refreshId"] as? String,
              let uuid = UUID(uuidString: value),
              uuid.uuidString.lowercased() == value
        else {
            return nil
        }
        return value
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
        /// Called exactly once when an existing companion refresh observed by
        /// the menu reaches a terminal idle state. The app uses it only to
        /// evaluate the just-finished receipt; it creates no new refresh.
        var refreshFinished: ((String?) -> Void)? = nil
    }

    /// Background cadence while the companion is idle. A minute is cheap on
    /// loopback and means a cached observation cannot sit visibly stale for
    /// several minutes before the automatic updater notices it.
    private static let idlePollSeconds = 60
    /// Cadence while an explicit pass is running, so the menu bar returns to a
    /// real number promptly once the pass finishes.
    private static let activePollSeconds = 5
    private static let menuMinimumWidth: CGFloat = 338
    private static var deferredLaneTitle: String {
        TiboTattleLocalization.string(.menuBarQuotaValuesUnavailable)
    }

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
    private var updaterMenuTitle: String?
    private var updaterMenuEnabled = true
    private var snapshot = MenuBarStatusSnapshot()
    private var dashboardURL: URL?
    private var companionGeneration: UInt64 = 0
    private var overviewResponseHealthy = false
    private var observedEvidenceExpiresAt: Date?
    private var pendingPoll: DispatchWorkItem?
    private var lastAutomaticRefreshAt: Date?
    private var automaticRefreshInFlight = false
    private var notificationEvaluationAwaitingRefresh = false
    /// The opaque companion run token links a terminal receipt to the exact
    /// existing refresh that this menu action observed. A missing or changed
    /// token is deliberately passed on as `nil`, which suppresses alerts.
    private var notificationEvaluationRefreshID: String?
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
            TiboTattleLocalization.format(.menuBarOpenProduct, productName),
            #selector(openTiboTattle)
        )
        configure(
            analyzeItem,
            TiboTattleLocalization.string(.menuBarAnalyzeLocalUsage),
            #selector(analyzeLocalUsage)
        )
        analyzeItem.keyEquivalent = "r"
        analyzeItem.keyEquivalentModifierMask = [.command]
        menu.addItem(openTiboTattleItem)
        menu.addItem(analyzeItem)
        if actions.checkForUpdates != nil {
            configure(
                checkForUpdatesItem,
                TiboTattleLocalization.string(.settingsCheckForUpdates) + "…",
                #selector(checkForUpdates)
            )
            checkForUpdatesItem.isEnabled = updaterMenuEnabled
            menu.addItem(checkForUpdatesItem)
        }
        configure(
            settingsItem,
            TiboTattleLocalization.string(.menuSettings),
            #selector(showSettings)
        )
        settingsItem.keyEquivalent = ","
        settingsItem.keyEquivalentModifierMask = [.command]
        configure(
            aboutItem,
            TiboTattleLocalization.format(.menuAboutProduct, productName),
            #selector(showAbout)
        )
        menu.addItem(settingsItem)
        menu.addItem(aboutItem)
        menu.addItem(.separator())

        configure(
            quitItem,
            TiboTattleLocalization.format(.menuQuitProduct, productName),
            #selector(quit)
        )
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
        notificationEvaluationAwaitingRefresh = false
        notificationEvaluationRefreshID = nil
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
        notificationEvaluationAwaitingRefresh = false
        notificationEvaluationRefreshID = nil
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
        notificationEvaluationAwaitingRefresh = false
        notificationEvaluationRefreshID = nil
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
        notificationEvaluationAwaitingRefresh = false
        notificationEvaluationRefreshID = nil
        dismissMenu()
        stopped = true
        companionGeneration &+= 1
        cancelPoll()
        reader.invalidate()
        removeInteractionMonitoring()
        statusItem.menu = nil
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    /// Reuse the existing native controls so a language change does not reset
    /// observation state, refresh scheduling, or menu keyboard shortcuts.
    func refreshLocalization() {
        guard !stopped else { return }
        openTiboTattleItem.title = TiboTattleLocalization.format(
            .menuBarOpenProduct,
            productName
        )
        if actions.checkForUpdates != nil {
            checkForUpdatesItem.title = updaterMenuTitle
                ?? TiboTattleLocalization.string(.settingsCheckForUpdates) + "…"
            checkForUpdatesItem.isEnabled = updaterMenuEnabled
        }
        settingsItem.title = TiboTattleLocalization.string(.menuSettings)
        aboutItem.title = TiboTattleLocalization.format(
            .menuAboutProduct,
            productName
        )
        quitItem.title = TiboTattleLocalization.format(
            .menuQuitProduct,
            productName
        )
        render()
    }

    /// The updater state is owned by the launcher, but the menu keeps the
    /// always-visible retry/check affordance honest without starting any
    /// updater work itself.
    func updateUpdaterPresentation(title: String, isEnabled: Bool) {
        guard !stopped, actions.checkForUpdates != nil else { return }
        updaterMenuTitle = title
        updaterMenuEnabled = isEnabled
        checkForUpdatesItem.title = title
        checkForUpdatesItem.isEnabled = isEnabled
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
            case let .started(refreshID), let .alreadyRunning(refreshID):
                self.snapshot.phase = .analyzing
                self.notificationEvaluationAwaitingRefresh = true
                self.notificationEvaluationRefreshID = refreshID
            case .rejected:
                self.snapshot.phase = self.dashboardURL == nil
                    ? .unavailable
                    : .ready
            case .unreachable:
                self.overviewResponseHealthy = false
                self.invalidateObservedEvidence()
                self.snapshot.phase = .unavailable
                self.snapshot.failureSummary =
                    TiboTattleLocalization.string(
                        .menuBarAnalysisRequestRejected
                    )
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
            case let .idle(refreshID):
                if self.overviewResponseHealthy {
                    self.snapshot.phase = .ready
                }
                if self.notificationEvaluationAwaitingRefresh {
                    self.notificationEvaluationAwaitingRefresh = false
                    let expectedRefreshID = self.notificationEvaluationRefreshID
                    self.notificationEvaluationRefreshID = nil
                    self.actions.refreshFinished?(
                        refreshID == expectedRefreshID ? expectedRefreshID : nil
                    )
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
                    TiboTattleLocalization.string(
                        .menuBarQuotaEvidenceUnavailable
                    )
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
        allowanceItem.title = TiboTattleLocalization.format(
            .menuBarAllowanceTitle,
            productName,
            snapshot.title
        )
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

    /// The status item carries the TiboTattle bird, so the mark derived from
    /// the approved app icon comes first. The SF Symbols bird is a generic
    /// system bird, not the product's mark; it exists only as the emergency
    /// fallback for a launch context that cannot read the bundled icon.
    private static func makeBrandBirdTemplate() -> NSImage? {
        if let asset = makeAssetBirdTemplate() { return asset }
        return nativeBirdTemplate()
    }

    /// Extract only the bright bird from the approved app icon. The source
    /// artwork uses a deep-green plate behind a cream/amber mark; turning
    /// that plate into transparency avoids ever shrinking the full
    /// application icon into the status item. Returns nil when no usable
    /// icon is available so the caller can fall back honestly.
    private static func makeAssetBirdTemplate() -> NSImage? {
        guard let application = NSApp,
              let source = application.applicationIconImage,
              let sourceCGImage = source.cgImage(
                  forProposedRect: nil,
                  context: nil,
                  hints: nil
              )
        else {
            return nil
        }

        let sourceRep = NSBitmapImageRep(cgImage: sourceCGImage)
        let sourceWidth = sourceRep.pixelsWide
        let sourceHeight = sourceRep.pixelsHigh
        guard sourceWidth > 0, sourceHeight > 0 else {
            return nil
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
            return nil
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
                // Transparent squircle corners can report a bright colour,
                // and the plate's drop shadow is translucent; gate on the
                // source pixel's own alpha so only the bird itself survives.
                let sourceAlpha = color?.alphaComponent ?? 0
                // Measured from the approved icns: the plate's red channel
                // stays below 0.25 and the cream/amber bird above 0.90, so a
                // ramp across the gap keeps a soft anti-aliased edge without
                // letting plate grain mist the mark.
                let alpha = min(1, max(0, (red - 0.35) / 0.40)) * sourceAlpha
                if alpha > 0.05 { retainedPixels += 1 }
                var pixel = [255, 255, 255, Int((alpha * 255).rounded())]
                pixel.withUnsafeMutableBufferPointer {
                    targetRep.setPixel($0.baseAddress!, atX: x, y: y)
                }
            }
        }
        guard retainedPixels > 0 else { return nil }

        let template = NSImage(size: NSSize(width: pixelSize, height: pixelSize))
        template.addRepresentation(targetRep)
        template.isTemplate = true
        return template
    }

    /// Emergency fallback only: a system-owned generic bird for the launch
    /// contexts where the approved app icon cannot be read at all. The brand
    /// mark from `makeAssetBirdTemplate()` is always preferred.
    private static func nativeBirdTemplate() -> NSImage? {
        let symbol = NSImage(
            systemSymbolName: "bird.fill",
            accessibilityDescription: TiboTattleLocalization.string(
                .accessibilityMenuBarStatus
            )
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
            case let .started(refreshID), let .alreadyRunning(refreshID):
                self.snapshot.phase = .analyzing
                self.notificationEvaluationAwaitingRefresh = true
                self.notificationEvaluationRefreshID = refreshID
            case .rejected:
                self.snapshot.phase = self.dashboardURL == nil
                    ? .unavailable
                    : .ready
            case .unreachable:
                self.overviewResponseHealthy = false
                self.invalidateObservedEvidence()
                self.snapshot.phase = .unavailable
                self.snapshot.failureSummary =
                    TiboTattleLocalization.string(
                        .menuBarAnalysisRequestRejected
                    )
            }
            self.render()
            self.pollNow()
        }
    }
}
