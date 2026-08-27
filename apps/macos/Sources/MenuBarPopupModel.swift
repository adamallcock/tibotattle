import CoreFoundation
import Foundation

/// The two local-calendar horizons the menu-bar history chart can display.
/// The raw values intentionally match the companion's rolling-period IDs, but
/// a chart range is made of civil days and does not claim to be that rolling
/// accounting period.
enum MenuBarHistoryRange: String, CaseIterable, Hashable {
    case sevenDays = "7d"
    case thirtyDays = "30d"

    var dayCount: Int {
        switch self {
        case .sevenDays:
            return 7
        case .thirtyDays:
            return 30
        }
    }
}

/// How much of a usage total has a known Standard API-price equivalent.
/// Partially priced events are not counted as complete: their known subtotal
/// remains useful, but it cannot be presented as the event's complete amount.
struct MenuBarPricingCoverage: Equatable {
    let fullyPricedEvents: Int64
    let partiallyPricedEvents: Int64
    let unpricedEvents: Int64

    var pricedEvents: Int64 {
        let result = fullyPricedEvents.addingReportingOverflow(
            partiallyPricedEvents
        )
        return result.overflow ? Int64.max : result.partialValue
    }

    var isComplete: Bool {
        partiallyPricedEvents == 0 && unpricedEvents == 0
    }
}

/// One exact rolling accounting period from `/api/local/overview`.
/// `knownAPIPriceEquivalentUSD` is the known Standard-price subtotal. Callers
/// must consult `pricingCoverage` before describing it as a complete amount.
struct MenuBarRollingPeriod: Equatable {
    enum Window: String, CaseIterable, Hashable {
        case last24Hours = "24h"
        case lastSevenDays = "7d"
        case lastThirtyDays = "30d"
    }

    let window: Window
    let events: Int64
    let totalTokens: Int64
    let knownAPIPriceEquivalentUSD: Double
    let pricingCoverage: MenuBarPricingCoverage
}

/// One local civil-day position in the history chart. Numeric values are
/// optional by design: an unavailable or only partly covered empty interval is
/// a gap, never an authoritative zero.
struct MenuBarHistoryDay: Equatable {
    enum Evidence: Equatable {
        /// The complete civil day lies inside authoritative timeline coverage.
        case available
        /// Only part of the day/source is covered. Numerics, when present, are
        /// the known subtotal from observed buckets rather than a full-day sum.
        case partial
        /// The day does not intersect authoritative timeline coverage.
        case unavailable
    }

    let startAt: Date
    let endAt: Date
    let evidence: Evidence
    let usageEvents: Int64?
    let totalTokens: Int64?
    let knownAPIPriceEquivalentUSD: Double?
    let pricingCoverage: MenuBarPricingCoverage?
}

/// The complete history/accounting input to the native menu-bar popup. Quota
/// freshness remains a separate projection: a current quota observation never
/// upgrades unavailable accounting evidence, or vice versa.
struct MenuBarHistorySnapshot: Equatable {
    enum AccountingStatus: Equatable {
        case current
        case unavailable
    }

    let accountingStatus: AccountingStatus
    let last24Hours: MenuBarRollingPeriod?
    let lastSevenDays: MenuBarRollingPeriod?
    let lastThirtyDays: MenuBarRollingPeriod?
    let sevenDayHistory: [MenuBarHistoryDay]
    let thirtyDayHistory: [MenuBarHistoryDay]

    /// Empty startup/failure value for owners that have not decoded an overview
    /// yet. A decoded unavailable overview still carries dated gap cells so the
    /// chart can preserve its civil-day positions.
    static let unavailable = MenuBarHistorySnapshot(
        accountingStatus: .unavailable,
        last24Hours: nil,
        lastSevenDays: nil,
        lastThirtyDays: nil,
        sevenDayHistory: [],
        thirtyDayHistory: []
    )

    func period(for range: MenuBarHistoryRange) -> MenuBarRollingPeriod? {
        switch range {
        case .sevenDays:
            return lastSevenDays
        case .thirtyDays:
            return lastThirtyDays
        }
    }

    func history(for range: MenuBarHistoryRange) -> [MenuBarHistoryDay] {
        switch range {
        case .sevenDays:
            return sevenDayHistory
        case .thirtyDays:
            return thirtyDayHistory
        }
    }
}

/// Pure, fail-closed projection of the accounting and timeline fields already
/// exposed by `/api/local/overview`. It keeps no state and performs no I/O, so
/// deterministic native smoke fixtures can provide `root`, `now`, and a fixed
/// calendar directly.
enum MenuBarHistoryProjection {
    static func decode(
        root: [String: Any],
        now: Date,
        calendar: Calendar
    ) -> MenuBarHistorySnapshot {
        let dayWindows = civilDayWindows(now: now, calendar: calendar)
        let unavailableHistory = unavailableHistories(dayWindows)

        guard accountingIsAuthoritative(root),
              let periods = decodePeriods(root)
        else {
            return MenuBarHistorySnapshot(
                accountingStatus: .unavailable,
                last24Hours: nil,
                lastSevenDays: nil,
                lastThirtyDays: nil,
                sevenDayHistory: unavailableHistory.sevenDays,
                thirtyDayHistory: unavailableHistory.thirtyDays
            )
        }

        guard let history = decodeHistory(
            root: root,
            now: now,
            dayWindows: dayWindows
        ) else {
            // Current rolling totals do not make a malformed or unavailable
            // timeline safe to chart. Collapse the complete compact section
            // to its named unavailable state instead of pairing a numeric
            // headline with an unexplained blank chart.
            return MenuBarHistorySnapshot(
                accountingStatus: .unavailable,
                last24Hours: nil,
                lastSevenDays: nil,
                lastThirtyDays: nil,
                sevenDayHistory: unavailableHistory.sevenDays,
                thirtyDayHistory: unavailableHistory.thirtyDays
            )
        }
        return MenuBarHistorySnapshot(
            accountingStatus: .current,
            last24Hours: periods[.last24Hours],
            lastSevenDays: periods[.lastSevenDays],
            lastThirtyDays: periods[.lastThirtyDays],
            sevenDayHistory: history.sevenDays,
            thirtyDayHistory: history.thirtyDays
        )
    }

    private struct DayWindow {
        let startAt: Date
        let endAt: Date
    }

    private struct DayHistories {
        let sevenDays: [MenuBarHistoryDay]
        let thirtyDays: [MenuBarHistoryDay]
    }

    private struct TimelineBucket {
        let startAt: Date
        let endAt: Date
        let usageEvents: Int64
        let totalTokens: Int64
        let knownAPIPriceEquivalentUSD: Double
        let pricingCoverage: MenuBarPricingCoverage
    }

    private struct TimelineProjection {
        enum Authority: Equatable {
            case complete
            case partial
        }

        let coverageStartAt: Date
        let coverageEndAt: Date
        let authority: Authority
        let buckets: [TimelineBucket]
    }

    private struct TimestampParser {
        private let fractional: ISO8601DateFormatter
        private let plain: ISO8601DateFormatter

        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [
                .withInternetDateTime,
                .withFractionalSeconds,
            ]
            plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
        }

        func date(_ value: Any?) -> Date? {
            guard let text = value as? String, !text.isEmpty else { return nil }
            return fractional.date(from: text) ?? plain.date(from: text)
        }
    }

    private static let maximumJSONSafeInteger = 9_007_199_254_740_991.0

    private static func accountingIsAuthoritative(
        _ root: [String: Any]
    ) -> Bool {
        guard let freshness = root["freshness"] as? [String: Any],
              freshness["accountingStatus"] as? String == "available",
              let accounting = root["accounting"] as? [String: Any],
              let sourceMode = accounting["sourceMode"] as? String,
              ["legacy", "unified"].contains(sourceMode)
        else {
            return false
        }

        // The data store can retain the previous complete figures while a new
        // unified generation is being built. Its period rows remain populated,
        // but `generationMatched` deliberately stays false. That state is not a
        // current numeric accounting claim for this compact surface.
        return sourceMode != "unified"
            || exactBoolean(accounting["generationMatched"]) == true
    }

    private static func decodePeriods(
        _ root: [String: Any]
    ) -> [MenuBarRollingPeriod.Window: MenuBarRollingPeriod]? {
        guard let accounting = root["accounting"] as? [String: Any],
              let rows = accounting["periods"] as? [[String: Any]]
        else {
            return nil
        }

        var decoded: [MenuBarRollingPeriod.Window: MenuBarRollingPeriod] = [:]
        for row in rows {
            guard let identifier = row["periodId"] as? String,
                  let window = MenuBarRollingPeriod.Window(rawValue: identifier)
            else {
                continue
            }
            guard decoded[window] == nil,
                  let period = decodePeriod(row, window: window)
            else {
                return nil
            }
            decoded[window] = period
        }

        guard decoded.count == MenuBarRollingPeriod.Window.allCases.count else {
            return nil
        }
        return decoded
    }

    private static func decodePeriod(
        _ row: [String: Any],
        window: MenuBarRollingPeriod.Window
    ) -> MenuBarRollingPeriod? {
        guard let events = nonnegativeInteger(row["events"]),
              let totalTokens = nonnegativeInteger(row["totalTokens"]),
              let cost = nonnegativeFinite(row["apiPriceEquivalentUsd"]),
              let coverage = decodeCoverage(
                  row["pricingCoverage"],
                  expectedEvents: events
              )
        else {
            return nil
        }
        guard events != 0 || (totalTokens == 0 && cost == 0) else { return nil }
        return MenuBarRollingPeriod(
            window: window,
            events: events,
            totalTokens: totalTokens,
            knownAPIPriceEquivalentUSD: cost,
            pricingCoverage: coverage
        )
    }

    private static func decodeHistory(
        root: [String: Any],
        now: Date,
        dayWindows: [DayWindow]
    ) -> DayHistories? {
        guard let timeline = decodeTimeline(root: root, now: now) else {
            return nil
        }
        var days: [MenuBarHistoryDay] = []
        days.reserveCapacity(dayWindows.count)
        for window in dayWindows {
            guard let day = projectDay(window, timeline: timeline, now: now) else {
                return nil
            }
            days.append(day)
        }
        guard days.count == MenuBarHistoryRange.thirtyDays.dayCount else {
            return nil
        }
        return DayHistories(
            sevenDays: Array(days.suffix(MenuBarHistoryRange.sevenDays.dayCount)),
            thirtyDays: days
        )
    }

    private static func decodeTimeline(
        root: [String: Any],
        now: Date
    ) -> TimelineProjection? {
        guard let timeline = root["timeline"] as? [String: Any],
              let source = timeline["source"] as? String,
              source != "insufficient_evidence",
              let bucketMinutes = nonnegativeInteger(timeline["bucketMinutes"]),
              bucketMinutes > 0,
              bucketMinutes <= 24 * 60,
              let coveredAt = timeline["coveredAt"] as? [String: Any],
              let rows = timeline["usage"] as? [[String: Any]]
        else {
            return nil
        }
        let parser = TimestampParser()
        guard let coverageStart = parser.date(coveredAt["startAt"]),
              let reportedCoverageEnd = parser.date(coveredAt["endAt"]),
              coverageStart < reportedCoverageEnd,
              coverageStart <= now
        else {
            return nil
        }

        let expectedDuration = TimeInterval(bucketMinutes * 60)
        var buckets: [TimelineBucket] = []
        buckets.reserveCapacity(rows.count)
        for row in rows {
            guard let bucket = decodeBucket(
                row,
                parser: parser,
                expectedDuration: expectedDuration
            ),
            bucket.startAt >= coverageStart,
            bucket.endAt <= reportedCoverageEnd,
            bucket.startAt <= now
            else {
                return nil
            }
            buckets.append(bucket)
        }
        buckets.sort { left, right in
            if left.startAt != right.startAt {
                return left.startAt < right.startAt
            }
            return left.endAt < right.endAt
        }
        for index in buckets.indices.dropFirst() {
            guard buckets[index].startAt >= buckets[index - 1].endAt else {
                return nil
            }
        }

        let history = timeline["history"] as? [String: Any]
        let historyStatus = history?["status"] as? String
        let authority: TimelineProjection.Authority
        switch source {
        case "unified_local_index":
            authority = historyStatus == "complete" ? .complete : .partial
        case "replay_safe_cache", "recent_collector_window":
            // These are bounded sources, but within coveredAt they represent
            // the complete locally observed source rather than a partial
            // unified-index generation.
            authority = .complete
        default:
            return nil
        }
        return TimelineProjection(
            coverageStartAt: coverageStart,
            // The current 15-minute bucket can end after `now`. It may carry a
            // real event, but cannot make the unseen remainder of today fully
            // covered, so civil-day completeness stops at the supplied clock.
            coverageEndAt: min(reportedCoverageEnd, now),
            authority: authority,
            buckets: buckets
        )
    }

    private static func decodeBucket(
        _ row: [String: Any],
        parser: TimestampParser,
        expectedDuration: TimeInterval
    ) -> TimelineBucket? {
        guard let startAt = parser.date(row["startAt"]),
              let endAt = parser.date(row["endAt"]),
              startAt < endAt,
              abs(endAt.timeIntervalSince(startAt) - expectedDuration) < 0.001,
              let usageEvents = nonnegativeInteger(row["usageEvents"]),
              let totalTokens = nonnegativeInteger(row["totalTokens"]),
              let cost = nonnegativeFinite(row["apiPriceEquivalentUsd"]),
              let coverage = decodeCoverage(
                  row["pricingCoverage"],
                  expectedEvents: usageEvents
              )
        else {
            return nil
        }
        guard usageEvents != 0 || (totalTokens == 0 && cost == 0) else {
            return nil
        }
        return TimelineBucket(
            startAt: startAt,
            endAt: endAt,
            usageEvents: usageEvents,
            totalTokens: totalTokens,
            knownAPIPriceEquivalentUSD: cost,
            pricingCoverage: coverage
        )
    }

    private static func projectDay(
        _ day: DayWindow,
        timeline: TimelineProjection,
        now: Date
    ) -> MenuBarHistoryDay? {
        let intersectsCoverage = day.startAt < timeline.coverageEndAt
            && day.endAt > timeline.coverageStartAt
        guard intersectsCoverage else {
            return unavailableDay(day)
        }

        let matching = timeline.buckets.filter {
            $0.startAt >= day.startAt && $0.startAt < day.endAt
        }
        let fullCivilDayCovered = day.startAt >= timeline.coverageStartAt
            && day.endAt <= timeline.coverageEndAt
            && day.endAt <= now
            && timeline.authority == .complete
        if fullCivilDayCovered {
            return summarizedDay(day, buckets: matching, evidence: .available)
        }
        guard !matching.isEmpty else {
            return MenuBarHistoryDay(
                startAt: day.startAt,
                endAt: day.endAt,
                evidence: .partial,
                usageEvents: nil,
                totalTokens: nil,
                knownAPIPriceEquivalentUSD: nil,
                pricingCoverage: nil
            )
        }
        return summarizedDay(day, buckets: matching, evidence: .partial)
    }

    private static func summarizedDay(
        _ day: DayWindow,
        buckets: [TimelineBucket],
        evidence: MenuBarHistoryDay.Evidence
    ) -> MenuBarHistoryDay? {
        var usageEvents: Int64 = 0
        var totalTokens: Int64 = 0
        var cost = 0.0
        var fullyPricedEvents: Int64 = 0
        var partiallyPricedEvents: Int64 = 0
        var unpricedEvents: Int64 = 0
        for bucket in buckets {
            guard let nextUsageEvents = safeAdd(
                usageEvents,
                bucket.usageEvents
            ),
            let nextTotalTokens = safeAdd(totalTokens, bucket.totalTokens),
            let nextCost = safeFiniteAdd(
                cost,
                bucket.knownAPIPriceEquivalentUSD
            ),
            let nextFullyPriced = safeAdd(
                fullyPricedEvents,
                bucket.pricingCoverage.fullyPricedEvents
            ),
            let nextPartiallyPriced = safeAdd(
                partiallyPricedEvents,
                bucket.pricingCoverage.partiallyPricedEvents
            ),
            let nextUnpriced = safeAdd(
                unpricedEvents,
                bucket.pricingCoverage.unpricedEvents
            )
            else {
                return nil
            }
            usageEvents = nextUsageEvents
            totalTokens = nextTotalTokens
            cost = nextCost
            fullyPricedEvents = nextFullyPriced
            partiallyPricedEvents = nextPartiallyPriced
            unpricedEvents = nextUnpriced
        }
        return MenuBarHistoryDay(
            startAt: day.startAt,
            endAt: day.endAt,
            evidence: evidence,
            usageEvents: usageEvents,
            totalTokens: totalTokens,
            knownAPIPriceEquivalentUSD: cost,
            pricingCoverage: MenuBarPricingCoverage(
                fullyPricedEvents: fullyPricedEvents,
                partiallyPricedEvents: partiallyPricedEvents,
                unpricedEvents: unpricedEvents
            )
        )
    }

    private static func civilDayWindows(
        now: Date,
        calendar: Calendar
    ) -> [DayWindow] {
        let today = calendar.startOfDay(for: now)
        return (0..<MenuBarHistoryRange.thirtyDays.dayCount).compactMap { index in
            let offset = index - (MenuBarHistoryRange.thirtyDays.dayCount - 1)
            guard let startAt = calendar.date(
                byAdding: .day,
                value: offset,
                to: today
            ),
            let endAt = calendar.date(byAdding: .day, value: 1, to: startAt),
            startAt < endAt
            else {
                return nil
            }
            return DayWindow(startAt: startAt, endAt: endAt)
        }
    }

    private static func unavailableHistories(
        _ dayWindows: [DayWindow]
    ) -> DayHistories {
        let days = dayWindows.map(unavailableDay)
        return DayHistories(
            sevenDays: Array(days.suffix(MenuBarHistoryRange.sevenDays.dayCount)),
            thirtyDays: days
        )
    }

    private static func unavailableDay(
        _ day: DayWindow
    ) -> MenuBarHistoryDay {
        MenuBarHistoryDay(
            startAt: day.startAt,
            endAt: day.endAt,
            evidence: .unavailable,
            usageEvents: nil,
            totalTokens: nil,
            knownAPIPriceEquivalentUSD: nil,
            pricingCoverage: nil
        )
    }

    private static func decodeCoverage(
        _ value: Any?,
        expectedEvents: Int64
    ) -> MenuBarPricingCoverage? {
        guard let row = value as? [String: Any],
              let fullyPriced = nonnegativeInteger(row["fullyPricedEvents"]),
              let partiallyPriced = nonnegativeInteger(
                  row["partiallyPricedEvents"]
              ),
              let unpriced = nonnegativeInteger(row["unpricedEvents"]),
              let priced = safeAdd(fullyPriced, partiallyPriced),
              let total = safeAdd(priced, unpriced),
              total == expectedEvents
        else {
            return nil
        }
        return MenuBarPricingCoverage(
            fullyPricedEvents: fullyPriced,
            partiallyPricedEvents: partiallyPriced,
            unpricedEvents: unpriced
        )
    }

    private static func exactBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else {
            return nil
        }
        return number.boolValue
    }

    private static func nonnegativeInteger(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            return nil
        }
        let raw = number.doubleValue
        guard raw.isFinite,
              raw >= 0,
              raw <= maximumJSONSafeInteger,
              raw.rounded(.towardZero) == raw
        else {
            return nil
        }
        return Int64(raw)
    }

    private static func nonnegativeFinite(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            return nil
        }
        let raw = number.doubleValue
        return raw.isFinite && raw >= 0 ? raw : nil
    }

    private static func safeAdd(_ left: Int64, _ right: Int64) -> Int64? {
        guard left <= Int64.max - right else { return nil }
        return left + right
    }

    private static func safeFiniteAdd(_ left: Double, _ right: Double) -> Double? {
        let sum = left + right
        return sum.isFinite && sum >= 0 ? sum : nil
    }
}
