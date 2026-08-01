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

/// The exact seven-day allowance window the dashboard treats as primary: the
/// weekly (10 080 minute) `codex` limit, preferring the primary slot. Mirrors
/// `mainWeeklyQuotaTrack` in the web dashboard so both surfaces can never
/// disagree about which window "the" allowance means.
struct SevenDayAllowanceWindow: Equatable {
    let remainingPercent: Double
    let planType: String?
    let resetAt: Date?

    /// Whole-percent rendering, matching the dashboard's quota card, which
    /// also renders this window with zero decimal places.
    var roundedRemainingPercent: Int {
        Int(min(100, max(0, remainingPercent)).rounded())
    }
}

/// The subset of `/api/local/overview` the menu bar reads. Everything else in
/// that payload stays where it belongs: in the dashboard.
struct LocalCompanionOverview: Equatable {
    let window: SevenDayAllowanceWindow?
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
    var window: SevenDayAllowanceWindow?
    var observedAt: Date?
    var failureSummary: String?

    /// True only when the companion has published a loopback dashboard.
    var companionReachable: Bool {
        phase == .ready || phase == .analyzing
    }

    /// The compact menu-bar title. A number appears only for live evidence.
    /// `…` means "an explicit pass is running", `–` means "no number can be
    /// shown honestly right now" and the menu says which case applies.
    var title: String {
        if phase == .analyzing { return analyzingPlaceholder }
        guard phase == .ready, evidence == .live, let window else {
            return unknownPlaceholder
        }
        return "\(window.roundedRemainingPercent)%"
    }

    /// Spoken by VoiceOver in place of the glyph and the terse title. The
    /// product name is passed in so this projection stays free of any bundle
    /// lookup and of any shared mutable state.
    func accessibilityLabel(productName: String) -> String {
        "\(productName): \(allowanceSummary). \(evidenceSummary)"
    }

    /// First disabled information row, and the tooltip's first line.
    var allowanceSummary: String {
        guard let window else {
            return "Seven-day allowance: not observed yet"
        }
        let remaining = "\(window.roundedRemainingPercent)% remaining"
        // A number is presented as current only while the companion is
        // actually reachable and reporting live evidence. Once it stops, the
        // last reading is history and is labelled as such.
        guard companionReachable, evidence == .live else {
            return "Seven-day allowance: \(remaining) when last observed"
        }
        return "Seven-day allowance: \(remaining)"
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
                return "Observed locally · live evidence"
            }
            return "Observed \(relativeAge(observedAt)) · live evidence"
        case .stale:
            guard let observedAt else {
                return "Evidence is stale, so no number is shown."
            }
            return "Observed \(relativeAge(observedAt)) · stale, "
                + "so no number is shown."
        case .none:
            return "No allowance observed yet · run Analyze Local Usage."
        }
    }
}

private let analyzingPlaceholder = "…"
private let unknownPlaceholder = "–"
private let weeklyWindowDurationMinutes = 10_080
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
        let weekly = rows.filter { row in
            row["limitId"] as? String == "codex"
                && (row["durationMinutes"] as? Int) == weeklyWindowDurationMinutes
        }
        let selected = weekly.first { $0["slot"] as? String == "primary" }
            ?? weekly.first
        var window: SevenDayAllowanceWindow?
        if let selected,
           let remaining = selected["remainingPercent"] as? Double,
           remaining.isFinite, remaining >= 0, remaining <= 100 {
            let planType = selected["planType"] as? String
            window = SevenDayAllowanceWindow(
                remainingPercent: remaining,
                planType: planType == "unknown" ? nil : planType,
                resetAt: timestamp(selected["resetAt"])
            )
        }
        let observedAt = timestamp(quota?["observedAt"])
            ?? timestamp(selected?["observedAt"])
        let staleAfter = freshness?["staleAfterSeconds"] as? Double
        return LocalCompanionOverview(
            window: window,
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
        guard overview.window != nil else { return .none }
        guard overview.freshnessStatus == "live" else { return .stale }
        guard let observedAt = overview.observedAt else { return .stale }
        let limit = overview.staleAfterSeconds ?? defaultStaleAfterSeconds
        return now.timeIntervalSince(observedAt) <= limit ? .live : .stale
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
        let openDashboard: () -> Void
        let showWindow: () -> Void
        let quit: () -> Void
    }

    /// Background cadence while the companion is idle. The companion treats
    /// its own evidence as live for thirty minutes, so a five-minute tick is
    /// far finer than the underlying resolution while staying negligible on
    /// loopback. Opening the menu always reads on demand as well.
    private static let idlePollSeconds = 300
    /// Cadence while an explicit pass is running, so the menu bar returns to a
    /// real number promptly once the pass finishes.
    private static let activePollSeconds = 5

    private let statusItem: NSStatusItem
    private let actions: Actions
    private let productName: String
    private let reader = LocalCompanionEvidenceReader()
    private let allowanceItem = NSMenuItem()
    private let evidenceItem = NSMenuItem()
    private let openDashboardItem = NSMenuItem()
    private let analyzeItem = NSMenuItem()
    private let showWindowItem = NSMenuItem()
    private let quitItem = NSMenuItem()
    private var snapshot = MenuBarStatusSnapshot()
    private var dashboardURL: URL?
    private var pendingPoll: DispatchWorkItem?
    private var stopped = false

    init(productName: String, actions: Actions) {
        self.productName = productName
        self.actions = actions
        // Constructing the item touches only in-memory AppKit state: no
        // network, no disk, and no waiting. Every evidence read below is
        // asynchronous with a main-queue completion.
        statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength
        )
        super.init()

        let menu = NSMenu()
        // Explicit enablement: information rows must stay unclickable, and
        // actions must reflect the companion's real state, not AppKit's guess.
        menu.autoenablesItems = false
        menu.delegate = self

        allowanceItem.isEnabled = false
        evidenceItem.isEnabled = false
        menu.addItem(allowanceItem)
        menu.addItem(evidenceItem)
        menu.addItem(.separator())

        configure(openDashboardItem, "Open Dashboard", #selector(openDashboard))
        configure(
            analyzeItem,
            "Analyze Local Usage",
            #selector(analyzeLocalUsage)
        )
        configure(
            showWindowItem,
            "Show \(productName) Window",
            #selector(showWindow)
        )
        menu.addItem(openDashboardItem)
        menu.addItem(analyzeItem)
        menu.addItem(showWindowItem)
        menu.addItem(.separator())

        configure(quitItem, "Quit \(productName)", #selector(quit))
        quitItem.keyEquivalent = "q"
        menu.addItem(quitItem)

        statusItem.menu = menu
        if let button = statusItem.button {
            button.image = Self.templateGlyph(productName: productName)
            button.imagePosition = .imageLeading
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
        self.dashboardURL = dashboardURL
        snapshot.phase = .ready
        snapshot.failureSummary = nil
        render()
        pollNow()
    }

    /// The companion is starting, or restarting after an explicit retry.
    func companionStarting() {
        guard !stopped else { return }
        dashboardURL = nil
        cancelPoll()
        snapshot.phase = .starting
        snapshot.failureSummary = nil
        render()
    }

    /// The companion failed to start or exited unexpectedly. The last observed
    /// window is kept only so the menu can say when it was observed; the
    /// compact title drops back to the neutral placeholder.
    func companionUnavailable(summary: String?) {
        guard !stopped else { return }
        dashboardURL = nil
        cancelPoll()
        snapshot.phase = .unavailable
        snapshot.failureSummary = summary
        render()
    }

    /// Released on termination so the item never outlives the app.
    func shutDown() {
        guard !stopped else { return }
        stopped = true
        cancelPoll()
        reader.invalidate()
        statusItem.menu = nil
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        // On-demand read: the menu is always as fresh as the companion, which
        // is why the background cadence can stay slow.
        pollNow()
    }

    // MARK: - Actions

    @objc private func openDashboard() {
        actions.openDashboard()
    }

    @objc private func analyzeLocalUsage() {
        guard !stopped, let dashboardURL, snapshot.phase == .ready else {
            return
        }
        // Optimistic only in the direction that disables the control; the real
        // state is confirmed by the response and the poll that follows.
        snapshot.phase = .analyzing
        render()
        reader.startAnalysis(base: dashboardURL) { [weak self] result in
            guard let self, !self.stopped else { return }
            switch result {
            case .started, .alreadyRunning:
                self.snapshot.phase = .analyzing
            case .rejected, .unreachable:
                self.snapshot.phase = self.dashboardURL == nil
                    ? .unavailable
                    : .ready
            }
            self.render()
            self.pollNow()
        }
    }

    @objc private func showWindow() {
        actions.showWindow()
    }

    @objc private func quit() {
        actions.quit()
    }

    // MARK: - Polling

    private func pollNow() {
        guard !stopped, let dashboardURL else { return }
        cancelPoll()
        reader.readAnalysisActivity(base: dashboardURL) { [weak self] activity in
            guard let self, !self.stopped, self.dashboardURL != nil else {
                return
            }
            switch activity {
            case .running:
                self.snapshot.phase = .analyzing
            case .idle:
                self.snapshot.phase = .ready
            case .none:
                break
            }
            self.render()
            self.schedulePoll()
        }
        reader.readOverview(base: dashboardURL) { [weak self] overview in
            guard let self, !self.stopped, self.dashboardURL != nil else {
                return
            }
            guard let overview else {
                // A single unreadable response is not evidence of anything:
                // keep the last honest projection and try again on the next
                // tick rather than inventing a state change.
                return
            }
            self.snapshot.window = overview.window
            self.snapshot.observedAt = overview.observedAt
            self.snapshot.evidence = LocalCompanionOverviewProjection
                .evidence(for: overview)
            self.render()
        }
    }

    private func schedulePoll() {
        guard !stopped, dashboardURL != nil else { return }
        cancelPoll()
        let seconds = snapshot.phase == .analyzing
            ? Self.activePollSeconds
            : Self.idlePollSeconds
        let work = DispatchWorkItem { [weak self] in
            self?.pollNow()
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
        allowanceItem.title = snapshot.allowanceSummary
        evidenceItem.title = snapshot.evidenceSummary
        openDashboardItem.isEnabled = snapshot.companionReachable
        analyzeItem.isEnabled = snapshot.phase == .ready
        showWindowItem.isEnabled = true
        quitItem.isEnabled = true
        guard let button = statusItem.button else { return }
        button.title = snapshot.title
        button.toolTip =
            "\(snapshot.allowanceSummary)\n\(snapshot.evidenceSummary)"
        button.setAccessibilityLabel(
            snapshot.accessibilityLabel(productName: productName)
        )
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

    /// Template rendering is what makes the glyph correct on light menu bars,
    /// dark menu bars, and under increased contrast without shipping any
    /// additional asset for the build to hash.
    private static func templateGlyph(productName: String) -> NSImage? {
        let description = "\(productName) seven-day allowance"
        if let symbol = NSImage(
            systemSymbolName: "gauge",
            accessibilityDescription: description
        ) {
            symbol.isTemplate = true
            return symbol
        }
        let image = NSImage(
            size: NSSize(width: 15, height: 15),
            flipped: false
        ) { rect in
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2))
            ring.lineWidth = 1.5
            NSColor.black.setStroke()
            ring.stroke()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = description
        return image
    }
}
