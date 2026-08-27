import AppKit
import CoreFoundation
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
    let durationMinutes: Int
    let resetAt: Date?
    let observedAt: Date?
    let isPrimary: Bool

    /// Whole-percent rendering matches the dashboard quota cards.
    var roundedRemainingPercent: Int {
        Int(min(100, max(0, remainingPercent)).rounded())
    }

    /// Keep the displayed used and remaining values exact complements after
    /// whole-percent rendering.
    var roundedUsedPercent: Int {
        100 - roundedRemainingPercent
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
    /// Accounting and timeline evidence keep their own authority gate. A
    /// fresh quota observation must never make missing history look current.
    let history: MenuBarHistorySnapshot
}

struct LocalContributionDiagnosticReference: Equatable {
    let reference: String
    let recordedAt: String
}

/// The content-free contribution support projection exposed by the loopback
/// companion. Decoding is deliberately fail-closed: a new field cannot make
/// an unsafe payload acceptable, and every exclusion flag must remain false.
struct LocalContributionDiagnostics: Equatable {
    let journeyPhase: String
    let previewState: String
    let queueState: String
    let consentApproved: Bool
    let consentCurrent: Bool
    let signedInObserved: Bool
    let signedIn: Bool
    let pairingObserved: Bool
    let paired: Bool
    let recentDiagnosticReferences: [LocalContributionDiagnosticReference]

    private static let phases: Set<String> = [
        "not_configured", "unavailable", "sign_in_required",
        "preparing_review", "review_ready", "connecting",
        "approved_connection_needed", "approved_paused",
        "approved_syncing", "approved_idle",
    ]
    private static let queueStates: Set<String> = [
        "unavailable", "empty", "ready", "retry_wait", "paused",
    ]
    private static let previewStates: Set<String> = queueStates.union([
        "not_observed",
    ])
    private static let referencePattern = try! NSRegularExpression(
        pattern: #"^TT-[0-9A-HJKMNP-TV-Z]{6}$"#
    )
    private static let instantPattern = try! NSRegularExpression(
        pattern: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"#
    )

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

    private static func matches(
        _ expression: NSRegularExpression,
        _ value: String
    ) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression.firstMatch(in: value, range: range)?.range == range
    }

    static func decode(_ data: Data) -> LocalContributionDiagnostics? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              hasExactKeys(root, [
                "schemaVersion", "journeyPhase", "previewState",
                "queueState", "consent", "signedIn", "pairing",
                "recentDiagnosticReferences", "includesTokens",
                "includesOauthState", "includesVerifiers",
                "includesDeviceIdentifiers", "includesAccountIdentifiers",
                "includesContent", "includesPaths",
              ]),
              root["schemaVersion"] as? String
                == "local-contribution-diagnostics-v0.1",
              let journeyPhase = root["journeyPhase"] as? String,
              phases.contains(journeyPhase),
              let previewState = root["previewState"] as? String,
              previewStates.contains(previewState),
              let queueState = root["queueState"] as? String,
              queueStates.contains(queueState),
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
              let paired = exactBoolean(pairing["paired"]),
              let rawReferences = root["recentDiagnosticReferences"]
                as? [[String: Any]],
              rawReferences.count <= 5,
              exactBoolean(root["includesTokens"]) == false,
              exactBoolean(root["includesOauthState"]) == false,
              exactBoolean(root["includesVerifiers"]) == false,
              exactBoolean(root["includesDeviceIdentifiers"]) == false,
              exactBoolean(root["includesAccountIdentifiers"]) == false,
              exactBoolean(root["includesContent"]) == false,
              exactBoolean(root["includesPaths"]) == false
        else {
            return nil
        }
        var references: [LocalContributionDiagnosticReference] = []
        for raw in rawReferences {
            guard hasExactKeys(raw, ["reference", "recordedAt"]),
                  let reference = raw["reference"] as? String,
                  matches(referencePattern, reference),
                  let recordedAt = raw["recordedAt"] as? String,
                  matches(instantPattern, recordedAt)
            else {
                return nil
            }
            references.append(
                LocalContributionDiagnosticReference(
                    reference: reference,
                    recordedAt: recordedAt
                )
            )
        }
        return LocalContributionDiagnostics(
            journeyPhase: journeyPhase,
            previewState: previewState,
            queueState: queueState,
            consentApproved: consentApproved,
            consentCurrent: consentCurrent,
            signedInObserved: signedInObserved,
            signedIn: signedIn,
            pairingObserved: pairingObserved,
            paired: paired,
            recentDiagnosticReferences: references
        )
    }
}

/// Privacy-reviewed progress from the companion's existing refresh receipt.
/// The phase is a closed vocabulary and the only counts retained are bounded
/// file totals used by the native toolbar. No server-provided prose crosses
/// this projection.
struct LocalAnalysisProgress: Equatable {
    enum Phase: String, Equatable {
        case discovering
        case rolloutIndex = "rollout_index"
        case quotaRefresh = "quota_refresh"
        case quickResult = "quick_result"
        case complete
        case paused
        case prospective
        case archiveIndex = "archive_index"
    }

    let phase: Phase
    let filesSelected: Int?
    let filesProcessed: Int?

    var nativeToolbarTitle: String {
        switch phase {
        case .discovering:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressDiscovering
            )
        case .rolloutIndex:
            guard let filesSelected,
                  let filesProcessed,
                  filesSelected > 0,
                  filesProcessed <= filesSelected
            else {
                return TiboTattleLocalization.string(
                    .nativeDashboardProgressAnalyzing
                )
            }
            return TiboTattleLocalization.format(
                .nativeDashboardProgressAnalyzingFiles,
                TiboTattleLocalization.integerString(filesProcessed),
                TiboTattleLocalization.integerString(filesSelected)
            )
        case .quotaRefresh:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressQuotaRefresh
            )
        case .quickResult:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressQuickResult
            )
        case .complete:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressFinishing
            )
        case .paused:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressSaving
            )
        case .prospective:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressProspective
            )
        case .archiveIndex:
            return TiboTattleLocalization.string(
                .nativeDashboardProgressArchiveIndex
            )
        }
    }
}

/// Whether an explicit local analysis pass is running, from whichever surface
/// started it. The dashboard and the menu bar share one controller in the
/// companion, so the menu bar can never start a second concurrent pass.
enum LocalAnalysisActivity: Equatable {
    case idle(refreshID: String?)
    case running(refreshID: String?, progress: LocalAnalysisProgress?)
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
    let statusItemButtonRoutesClicks: Bool
    let popoverIsTransient: Bool
    let popoverContentWidth: CGFloat
    let popoverContainsScrollView: Bool
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
    var history: MenuBarHistorySnapshot = .unavailable
    /// Shared companion-side weekly forecast presentation. This remains
    /// ephemeral and is rendered only while it binds to the exact current
    /// seven-day allowance observation.
    var weeklyPaceOutlook: MenuBarWeeklyPaceOutlook?
    /// The companion's declared freshness window is retained only in memory
    /// so each lane can be checked against its own observation timestamp.
    var staleAfterSeconds: Double?
    /// True only while the current companion URL can accept the existing
    /// local-analysis action. An unavailable surface with no companion must
    /// not present a button that silently does nothing.
    var analysisAvailable = false

    /// Mirrors the dashboard's primary selection across the normal Codex
    /// allowance track. Other provider products are rejected while decoding,
    /// so they cannot become a fallback for the compact title.
    var primaryLane: ObservedQuotaLane? {
        lanes.first(where: \.isPrimary) ?? lanes.first
    }

    /// A lane can make a numeric claim only while its own observation is
    /// inside the companion's freshness window and its exact provider window
    /// has not reset. A newer sibling lane can never keep an older one live.
    func laneIsCurrent(_ lane: ObservedQuotaLane, now: Date = Date()) -> Bool {
        let freshnessLimit = staleAfterSeconds ?? defaultStaleAfterSeconds
        guard companionReachable,
              evidence == .live,
              lane.remainingPercent.isFinite,
              lane.remainingPercent >= 0,
              lane.remainingPercent <= 100,
              let observedAt = lane.observedAt,
              now.timeIntervalSince(observedAt) >= 0,
              now.timeIntervalSince(observedAt) <= freshnessLimit,
              let resetAt = lane.resetAt,
              resetAt > now
        else { return false }
        return true
    }

    func currentLanes(now: Date = Date()) -> [ObservedQuotaLane] {
        lanes.filter { laneIsCurrent($0, now: now) }
    }

    func currentPrimaryLane(now: Date = Date()) -> ObservedQuotaLane? {
        let current = currentLanes(now: now)
        return current.first(where: \.isPrimary) ?? current.first
    }

    func currentWeeklyPaceOutlook(
        now: Date = Date()
    ) -> MenuBarWeeklyPaceOutlook? {
        guard let outlook = weeklyPaceOutlook,
              let weeklyLane = currentLanes(now: now).first(where: {
                  $0.durationMinutes
                    == CodexQuotaWindowDuration.sevenDayMinutes
              }),
              outlook.isBound(to: weeklyLane, now: now)
        else {
            return nil
        }
        return outlook
    }

    /// True only when the companion has published a loopback dashboard.
    var companionReachable: Bool {
        phase == .ready || phase == .analyzing
    }

    /// The compact menu-bar title. A fresh verified number remains useful while
    /// an explicit pass checks for newer evidence, so analysis state does not
    /// replace it. `…` means "a pass is running without a live number"; `–`
    /// means "no number can be shown honestly right now" and the menu explains
    /// which case applies.
    var title: String {
        if companionReachable,
           let lane = currentPrimaryLane() {
            return TiboTattleLocalization.percentString(
                lane.roundedRemainingPercent
            )
        }
        return phase == .analyzing
            ? analyzingPlaceholder
            : unknownPlaceholder
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
        let current = currentLanes()
        guard !current.isEmpty else {
            return TiboTattleLocalization.string(
                .menuBarLastObservationNotCurrent
            )
        }
        return current.count == 1
            ? TiboTattleLocalization.string(.menuBarVerifiedAllowanceOne)
            : TiboTattleLocalization.format(
                .menuBarVerifiedAllowanceMany,
                current.count
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
        guard laneIsCurrent(lane, now: now) else {
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
        if let position = weeklyWindowPosition(lane) {
            return TiboTattleLocalization.format(
                .menuBarQuotaWeeklyPositionResets,
                lane.label,
                TiboTattleLocalization.percentString(position.elapsedPercent),
                TiboTattleLocalization.percentString(position.usedPercent),
                reset
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
private let supportedCodexAllowanceWindowDurations: Set<Int> = [
    fiveHourWindowDurationMinutes,
    weeklyWindowDurationMinutes,
]
private let defaultStaleAfterSeconds: Double = 30 * 60

/// A one-observation, non-predictive comparison for the seven-day allowance.
/// Both values are aligned to the provider observation time: using wall-clock
/// time with an older quota observation would quietly compare different
/// instants. This is a menu-bar presentation fact, not an exhaustion forecast
/// or the cost-implied expected line used by the dashboard.
struct WeeklyWindowPosition: Equatable {
    let elapsedPercent: Int
    let usedPercent: Int
}

func weeklyWindowPosition(_ lane: ObservedQuotaLane) -> WeeklyWindowPosition? {
    guard lane.durationMinutes == weeklyWindowDurationMinutes,
          let resetAt = lane.resetAt,
          let observedAt = lane.observedAt
    else {
        return nil
    }
    let durationSeconds = TimeInterval(lane.durationMinutes * 60)
    let startedAt = resetAt.addingTimeInterval(-durationSeconds)
    let elapsedSeconds = observedAt.timeIntervalSince(startedAt)
    guard durationSeconds > 0,
          elapsedSeconds >= 0,
          elapsedSeconds < durationSeconds
    else {
        return nil
    }
    let elapsedPercent = min(
        100,
        max(0, elapsedSeconds / durationSeconds * 100)
    )
    return WeeklyWindowPosition(
        elapsedPercent: Int(elapsedPercent.rounded()),
        usedPercent: lane.roundedUsedPercent
    )
}

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

/// The next instant at which an on-screen numeric claim can change validity.
/// This is pure so the packaged semantic smoke can prove the five-hour lane
/// expires independently of a still-current weekly lane.
func nextEvidencePresentationBoundary(
    lanes: [ObservedQuotaLane],
    staleAfterSeconds: Double?,
    weeklyPaceOutlook: MenuBarWeeklyPaceOutlook? = nil,
    now: Date
) -> Date? {
    let freshnessLimit = staleAfterSeconds ?? defaultStaleAfterSeconds
    let freshnessBoundaries = lanes.compactMap { lane -> Date? in
        guard let observedAt = lane.observedAt else { return nil }
        return observedAt.addingTimeInterval(freshnessLimit)
    }
    let resetBoundaries = lanes.compactMap(\.resetAt)
    let outlookBoundaries = weeklyPaceOutlook.map {
        [$0.nextPresentationBoundary]
    } ?? []
    return (freshnessBoundaries + resetBoundaries + outlookBoundaries)
        .filter { $0 > now }
        .min()
}

enum MenuBarStatusActivationIntent: Equatable {
    case popover
    case actionMenu
}

/// AppKit event routing expressed as a pure decision before it is wired to the
/// real status button. Control-click follows the native context-menu path.
func menuBarStatusActivationIntent(
    eventType: NSEvent.EventType?,
    modifierFlags: NSEvent.ModifierFlags
) -> MenuBarStatusActivationIntent {
    eventType == .rightMouseUp || modifierFlags.contains(.control)
        ? .actionMenu
        : .popover
}

func menuBarShouldDismissForEscape(
    keyCode: UInt16,
    isMenuTracking: Bool,
    isPopoverShown: Bool
) -> Bool {
    keyCode == 53 && (isMenuTracking || isPopoverShown)
}

/// Pure projection of the companion's overview payload. Kept free of AppKit so
/// it stays trivially reviewable, and free of any fallback that would invent a
/// value when a field is missing or malformed.
enum LocalCompanionOverviewProjection {
    static func decode(
        _ data: Data,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> LocalCompanionOverview? {
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
        let staleAfter = (freshness?["staleAfterSeconds"] as? NSNumber)
            .flatMap { number -> Double? in
                guard CFGetTypeID(number) != CFBooleanGetTypeID() else {
                    return nil
                }
                let value = number.doubleValue
                return value.isFinite && value >= 0 ? value : nil
            }
        let quota = root["quota"] as? [String: Any]
        let rows = root["quotaWindows"] as? [[String: Any]]
            ?? quota?["windows"] as? [[String: Any]]
            ?? []
        struct Candidate {
            let lane: ObservedQuotaLane
            let durationMinutes: Int
            let preferredSlot: Bool
            let observedAt: Date
            let stableKey: String
        }
        let candidates = rows.compactMap { row -> Candidate? in
            guard let remainingNumber = row["remainingPercent"] as? NSNumber,
                  CFGetTypeID(remainingNumber) != CFBooleanGetTypeID(),
                  let usedNumber = row["usedPercent"] as? NSNumber,
                  CFGetTypeID(usedNumber) != CFBooleanGetTypeID()
            else {
                return nil
            }
            let remaining = remainingNumber.doubleValue
            let used = usedNumber.doubleValue
            guard remaining.isFinite,
                  used.isFinite,
                  remaining >= 0,
                  remaining <= 100,
                  used >= 0,
                  used <= 100,
                  abs((remaining + used) - 100) <= 0.001
            else {
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
            guard let resetAt = timestamp(resetAtText),
                  let observedAt = timestamp(observedAtText),
                  observedAt <= now,
                  resetAt > observedAt,
                  resetAt.timeIntervalSince(observedAt)
                    <= TimeInterval(duration * 60)
            else {
                return nil
            }
            let lane = ObservedQuotaLane(
                label: laneLabel(durationMinutes: duration),
                remainingPercent: remaining,
                durationMinutes: duration,
                resetAt: resetAt,
                observedAt: observedAt,
                // This marker is replaced after the bounded selection below;
                // it denotes the selected status lane, not an inferred plan.
                isPrimary: false
            )
            let slot = row["slot"] as? String ?? ""
            // Match the canonical JS forecast exactly: primary wins whenever
            // both transitional slot representations are present. Secondary
            // remains the deterministic fallback when primary is absent.
            let preferredSlot = slot == "primary"
            return Candidate(
                lane: lane,
                durationMinutes: duration,
                preferredSlot: preferredSlot,
                observedAt: observedAt,
                stableKey: [
                    slot,
                    resetAtText,
                    observedAtText,
                    String(remaining),
                ].joined(separator: "\u{0}")
            )
        }
        let selected = supportedCodexAllowanceWindowDurations.compactMap {
            duration -> Candidate? in
            candidates.filter { $0.durationMinutes == duration }.sorted {
                left, right in
                if left.preferredSlot != right.preferredSlot {
                    return left.preferredSlot
                }
                if left.observedAt != right.observedAt {
                    return left.observedAt > right.observedAt
                }
                return left.stableKey < right.stableKey
            }.first
        }
        let lanes = selected.sorted {
            $0.durationMinutes > $1.durationMinutes
        }.map { candidate in
            ObservedQuotaLane(
                label: candidate.lane.label,
                remainingPercent: candidate.lane.remainingPercent,
                durationMinutes: candidate.lane.durationMinutes,
                resetAt: candidate.lane.resetAt,
                observedAt: candidate.lane.observedAt,
                // Weekly is the compact status lane when it exists; the
                // five-hour lane remains independently visible below it.
                isPrimary: candidate.durationMinutes
                    == weeklyWindowDurationMinutes
            )
        }
        // Never borrow the aggregate timestamp from a separate quota product:
        // freshness must be evidence from the normal Codex allowance itself.
        let observedAt = lanes.compactMap(\.observedAt).max()
        return LocalCompanionOverview(
            lanes: lanes,
            observedAt: observedAt,
            freshnessStatus: freshness?["status"] as? String
                ?? root["status"] as? String
                ?? "unavailable",
            staleAfterSeconds: staleAfter.map { max(0, $0) },
            evidenceAvailable: root["evidenceStatus"] as? String == "available",
            history: MenuBarHistoryProjection.decode(
                root: root,
                now: now,
                calendar: calendar
            )
        )
    }

    /// Classify an overview into what the menu bar is allowed to display.
    static func evidence(
        for overview: LocalCompanionOverview,
        now: Date = Date()
    ) -> MenuBarStatusSnapshot.Evidence {
        guard !overview.lanes.isEmpty else { return .none }
        guard overview.evidenceAvailable,
              overview.freshnessStatus == "live"
        else { return .stale }
        guard let observedAt = overview.observedAt else { return .stale }
        let limit = overview.staleAfterSeconds ?? defaultStaleAfterSeconds
        let age = now.timeIntervalSince(observedAt)
        return age >= 0 && age <= limit ? .live : .stale
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
        // The caller has already admitted only the exact two-duration set.
        return TiboTattleLocalization.string(.menuBarSevenDayAllowance)
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
    static let maximumPaceOutlookResponseBytes = 64 * 1_024
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
            let overview = payload.flatMap {
                LocalCompanionOverviewProjection.decode($0)
            }
            DispatchQueue.main.async { completion(overview) }
        }
        task.resume()
    }

    func readWeeklyPaceOutlook(
        base: URL,
        completion: @escaping (MenuBarWeeklyPaceOutlook?) -> Void
    ) {
        guard let url = loopbackEndpoint(
            base,
            path: "/api/local/weekly-pace-outlook"
        )
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let outlook = Self.acceptedPayload(
                data,
                response,
                maximumBytes: Self.maximumPaceOutlookResponseBytes
            ).flatMap { MenuBarWeeklyPaceOutlookProjection.decode($0) }
            DispatchQueue.main.async { completion(outlook) }
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

    func readContributionDiagnostics(
        base: URL,
        completion: @escaping (LocalContributionDiagnostics?) -> Void
    ) {
        guard let url = loopbackEndpoint(
            base,
            path: "/api/local/diagnostics/contribution"
        )
        else {
            completion(nil)
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let diagnostics = Self.acceptedPayload(data, response).flatMap(
                LocalContributionDiagnostics.decode
            )
            DispatchQueue.main.async { completion(diagnostics) }
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
        _ response: URLResponse?,
        maximumBytes: Int = maximumResponseBytes
    ) -> Data? {
        guard let data,
              (response as? HTTPURLResponse)?.statusCode == 200,
              maximumBytes > 0,
              data.count <= maximumBytes
        else {
            return nil
        }
        return data
    }

    static func decodeActivity(_ data: Data) -> LocalAnalysisActivity? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any],
            let refresh = root["refresh"] as? [String: Any],
            let status = refresh["status"] as? String
        else {
            return nil
        }
        let refreshID = decodeRefreshID(refresh)
        return ["running", "cancelling"].contains(status)
            ? .running(
                refreshID: refreshID,
                progress: decodeProgress(refresh["progress"])
            )
            : .idle(refreshID: refreshID)
    }

    private static func decodeProgress(_ value: Any?) -> LocalAnalysisProgress? {
        guard let progress = value as? [String: Any] else { return nil }
        if progress["kind"] as? String == "archive_index" {
            guard progress["status"] as? String == "scanning" else {
                return nil
            }
            return LocalAnalysisProgress(
                phase: .archiveIndex,
                filesSelected: nil,
                filesProcessed: nil
            )
        }
        guard let rawPhase = progress["phase"] as? String,
              let phase = LocalAnalysisProgress.Phase(rawValue: rawPhase),
              phase != .archiveIndex
        else {
            return nil
        }
        return LocalAnalysisProgress(
            phase: phase,
            filesSelected: decodeProgressCount(progress["filesSelected"]),
            filesProcessed: decodeProgressCount(progress["filesProcessed"])
        )
    }

    private static let maximumProgressCount = 1_000_000_000

    private static func decodeProgressCount(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, !(value is Bool) else {
            return nil
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue.rounded(.towardZero) == doubleValue,
              doubleValue >= 0,
              doubleValue <= Double(maximumProgressCount)
        else {
            return nil
        }
        return Int(doubleValue)
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
final class MenuBarStatusController: NSObject, NSMenuDelegate, NSPopoverDelegate {
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
    private let popover = NSPopover()
    private var popoverController: MenuBarPopoverViewController!
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
    /// Separates overlapping polls within one companion generation. Opening
    /// the popup can request an immediate refresh while an earlier loopback
    /// read is still in flight; only the newest response may update the UI.
    private var pollSequence: UInt64 = 0
    private var pollActivityFinished = false
    private var pollEvidenceFinished = false
    private var overviewResponseHealthy = false
    private var observedEvidenceExpiresAt: Date?
    private var evidenceExpiryWorkItem: DispatchWorkItem?
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

        popover.behavior = .transient
        popover.delegate = self
        popoverController = MenuBarPopoverViewController(
            productName: productName,
            brandImage: NSApp.applicationIconImage,
            actions: MenuBarPopoverViewController.Actions(
                openTiboTattle: { [weak self] in self?.openTiboTattle() },
                refresh: { [weak self] in self?.analyzeLocalUsage() },
                showMore: { [weak self] anchor in
                    self?.showActionMenu(from: anchor)
                }
            )
        )
        popover.contentViewController = popoverController
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
            button.target = self
            button.action = #selector(statusItemActivated)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
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
        snapshot.analysisAvailable = true
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
        snapshot.analysisAvailable = false
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
        snapshot.analysisAvailable = false
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
        dismissSurfaces()
        stopped = true
        companionGeneration &+= 1
        cancelPoll()
        reader.invalidate()
        removeInteractionMonitoring()
        popover.delegate = nil
        popover.contentViewController = nil
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
        popoverController.refreshLocalization()
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
        let popup = popoverController.nativePresentationContract()
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
            statusItemButtonRoutesClicks:
                statusItem.button?.target === self
                    && statusItem.button?.action == #selector(statusItemActivated),
            popoverIsTransient: popover.behavior == .transient,
            popoverContentWidth: popup.contentWidth,
            popoverContainsScrollView: popup.containsScrollView,
            escapeDismissalMonitorInstalled: escapeMonitor != nil,
            sameAppClickAwayMonitorInstalled: localMouseMonitor != nil,
            appDeactivationDismissalObserverInstalled:
                appDeactivationObserver != nil
        )
    }

    /// Left-click is the glanceable instrument; right-click and Control-click
    /// retain the complete native action menu. Keeping `statusItem.menu`
    /// detached is what lets both interactions coexist on one ordinary
    /// NSStatusItem.
    @objc private func statusItemActivated(_ sender: NSStatusBarButton) {
        guard !stopped else { return }
        let event = NSApp.currentEvent
        let intent = menuBarStatusActivationIntent(
            eventType: event?.type,
            modifierFlags: event?.modifierFlags ?? []
        )
        if intent == .actionMenu {
            showActionMenu(from: sender)
            return
        }

        if popover.isShown {
            dismissSurfaces()
            return
        }
        menu.cancelTracking()
        isMenuTracking = false
        popoverController.update(snapshot: snapshot)
        popover.show(
            relativeTo: sender.bounds,
            of: sender,
            preferredEdge: .minY
        )
        sender.highlight(true)
        pollNow()
    }

    /// Opens the one existing NSMenu from either the status button or the
    /// popover's more button. The screen-space anchor survives closing the
    /// popover, so the menu never depends on a view that AppKit just removed.
    private func showActionMenu(from anchor: NSView) {
        guard !stopped else { return }
        let windowPoint = anchor.convert(
            NSPoint(x: anchor.bounds.midX, y: anchor.bounds.minY - 4),
            to: nil
        )
        let screenPoint = anchor.window?.convertPoint(toScreen: windowPoint)
        popover.performClose(nil)
        statusItem.button?.highlight(true)
        render()
        if let screenPoint {
            menu.popUp(positioning: nil, at: screenPoint, in: nil)
        } else {
            menu.popUp(
                positioning: nil,
                at: NSPoint(x: anchor.bounds.midX, y: anchor.bounds.minY - 4),
                in: anchor
            )
        }
    }

    func popoverDidClose(_ notification: Notification) {
        statusItem.button?.highlight(false)
        refreshStaleEvidenceIfNeeded()
    }

    /// AppKit normally dismisses an `NSStatusItem` menu for both Escape and an
    /// application switch. Keep those baseline interactions explicit as well:
    /// the menu remains a native status-item menu, while the monitor and
    /// notification only call AppKit's own tracking cancellation API.
    private func installInteractionMonitoring() {
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
            [weak self] event in
            guard let self,
                  menuBarShouldDismissForEscape(
                    keyCode: event.keyCode,
                    isMenuTracking: self.isMenuTracking,
                    isPopoverShown: self.popover.isShown
                  )
            else {
                return event
            }
            self.dismissSurfaces()
            return nil
        }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            guard let self,
                  self.isMenuTracking || self.popover.isShown,
                  let eventWindow = event.window,
                  NSApp.windows.contains(where: { $0 === eventWindow })
            else {
                return event
            }
            if self.popover.isShown,
               eventWindow === self.popover.contentViewController?.view.window {
                return event
            }
            // The menu's own window is not an application window, so native
            // menu-item clicks continue through AppKit. A click in any of the
            // app's windows is an unambiguous same-app click-away.
            self.dismissSurfaces()
            return event
        }
        appDeactivationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.dismissSurfaces()
            }
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

    /// Ends whichever transient menu-bar surface is open before focus or app
    /// ownership changes. Calling it while both are closed is harmless and
    /// keeps popover buttons and native menu items on one action path.
    private func dismissSurfaces() {
        menu.cancelTracking()
        isMenuTracking = false
        popover.performClose(nil)
        statusItem.button?.highlight(false)
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
        statusItem.button?.highlight(false)
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
        dismissSurfaces()
        actions.openTiboTattle()
    }

    @objc private func analyzeLocalUsage() {
        guard !stopped,
              let dashboardURL,
              snapshot.phase == .ready || snapshot.phase == .unavailable
        else {
            return
        }
        dismissSurfaces()
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
        dismissSurfaces()
        actions.quit()
    }

    @objc private func showSettings() {
        dismissSurfaces()
        actions.showSettings()
    }

    @objc private func showAbout() {
        dismissSurfaces()
        actions.showAbout()
    }

    @objc private func checkForUpdates() {
        dismissSurfaces()
        actions.checkForUpdates?()
    }

    // MARK: - Polling

    private func pollNow() {
        guard !stopped, let dashboardURL else { return }
        let generation = companionGeneration
        pollSequence &+= 1
        let sequence = pollSequence
        pollActivityFinished = false
        pollEvidenceFinished = false
        cancelPoll()
        reader.readAnalysisActivity(base: dashboardURL) { [weak self] activity in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.pollSequence == sequence,
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
            self.finishPollLeg(.activity, sequence: sequence)
        }
        reader.readOverview(base: dashboardURL) { [weak self] overview in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation,
                  self.pollSequence == sequence,
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
                self.finishPollLeg(.evidence, sequence: sequence)
                return
            }
            self.overviewResponseHealthy = true
            self.snapshot.lanes = overview.lanes
            self.snapshot.observedAt = overview.observedAt
            self.snapshot.history = overview.history
            self.snapshot.staleAfterSeconds = overview.staleAfterSeconds
            let freshnessExpiry = overview.observedAt.map {
                $0.addingTimeInterval(
                    overview.staleAfterSeconds ?? defaultStaleAfterSeconds
                )
            }
            self.observedEvidenceExpiresAt = freshnessExpiry
            self.snapshot.evidence = LocalCompanionOverviewProjection
                .evidence(for: overview)
            let now = Date()
            if self.snapshot.currentWeeklyPaceOutlook(now: now) == nil {
                self.snapshot.weeklyPaceOutlook = nil
            }
            self.scheduleEvidenceExpiry()
            if self.snapshot.phase == .unavailable {
                self.snapshot.phase = .ready
                self.snapshot.failureSummary = nil
            }
            self.render()
            self.refreshStaleEvidenceIfNeeded()
            self.reader.readWeeklyPaceOutlook(base: dashboardURL) {
                [weak self] outlook in
                guard let self,
                      !self.stopped,
                      self.companionGeneration == generation,
                      self.pollSequence == sequence,
                      self.dashboardURL == dashboardURL
                else {
                    return
                }
                let now = Date()
                if let outlook,
                   let weeklyLane = self.snapshot.currentLanes(now: now)
                    .first(where: {
                        $0.durationMinutes
                            == CodexQuotaWindowDuration.sevenDayMinutes
                    }),
                   outlook.isBound(to: weeklyLane, now: now) {
                    self.snapshot.weeklyPaceOutlook = outlook
                } else {
                    self.snapshot.weeklyPaceOutlook = nil
                }
                self.scheduleEvidenceExpiry()
                self.render()
                self.finishPollLeg(.evidence, sequence: sequence)
            }
        }
    }

    private enum PollLeg {
        case activity
        case evidence
    }

    /// The active cadence starts only after both the refresh-status read and
    /// the overview-plus-outlook read have settled. Otherwise a five-second
    /// analysis poll can invalidate every slower (but still bounded) weekly
    /// response before it is allowed to render.
    private func finishPollLeg(_ leg: PollLeg, sequence: UInt64) {
        guard !stopped, pollSequence == sequence else { return }
        switch leg {
        case .activity:
            pollActivityFinished = true
        case .evidence:
            pollEvidenceFinished = true
        }
        if pollActivityFinished && pollEvidenceFinished {
            schedulePoll()
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
        analyzeItem.isEnabled = snapshot.analysisAvailable
            && (snapshot.phase == .ready || snapshot.phase == .unavailable)
        quitItem.isEnabled = true
        popoverController.update(snapshot: snapshot)
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
        evidenceExpiryWorkItem?.cancel()
        evidenceExpiryWorkItem = nil
        snapshot.lanes = []
        snapshot.observedAt = nil
        snapshot.evidence = .none
        snapshot.history = .unavailable
        snapshot.weeklyPaceOutlook = nil
        snapshot.staleAfterSeconds = nil
        observedEvidenceExpiresAt = nil
    }

    private func expireCachedEvidenceIfNeeded() {
        let now = Date()
        if snapshot.evidence == .live,
           let observedEvidenceExpiresAt,
           now >= observedEvidenceExpiresAt {
            snapshot.evidence = .stale
        }
        if snapshot.currentWeeklyPaceOutlook(now: now) == nil {
            snapshot.weeklyPaceOutlook = nil
        }
    }

    /// Freshness and every observed lane reset are exact presentation
    /// boundaries. Re-render at the boundary even if the ordinary one-minute
    /// poll has not fired, so an open popover never carries a percentage into
    /// a new provider window.
    private func scheduleEvidenceExpiry() {
        evidenceExpiryWorkItem?.cancel()
        evidenceExpiryWorkItem = nil
        guard snapshot.evidence == .live else { return }
        let now = Date()
        guard let nextBoundary = nextEvidencePresentationBoundary(
            lanes: snapshot.lanes,
            staleAfterSeconds: snapshot.staleAfterSeconds,
            weeklyPaceOutlook: snapshot.weeklyPaceOutlook,
            now: now
        )
        else { return }
        let delay = nextBoundary.timeIntervalSince(now)
        guard delay > 0 else {
            expireCachedEvidenceIfNeeded()
            render()
            return
        }
        let generation = companionGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  !self.stopped,
                  self.companionGeneration == generation
            else { return }
            self.evidenceExpiryWorkItem = nil
            self.expireCachedEvidenceIfNeeded()
            self.render()
            self.scheduleEvidenceExpiry()
            self.refreshStaleEvidenceIfNeeded()
        }
        evidenceExpiryWorkItem = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + delay,
            execute: work
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
        guard let lane = snapshot.currentPrimaryLane()
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
