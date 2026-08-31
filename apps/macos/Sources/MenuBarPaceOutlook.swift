import CoreFoundation
import Foundation

/// The native menu bar renders this closed, content-free projection of the
/// existing weekly pace engine. All standing math and track geometry are
/// computed by the local companion; Swift only validates, binds, and draws the
/// result. Nothing here can reveal an account identifier, local path, or raw
/// quota record.
struct MenuBarWeeklyPaceOutlook: Equatable {
    enum Status: String, Equatable {
        case collecting
        case available
    }

    enum Standing: String, Equatable {
        case under
        case on
        case over
    }

    struct Rates: Equatable {
        let activePercentagePointsPerHour: Double?
        let overallPercentagePointsPerHour: Double?
        let headlinePercentagePointsPerHour: Double?
        let sustainablePercentagePointsPerHour: Double?
        let ratio: Double?
    }

    struct Projection: Equatable {
        let hoursToReset: Double?
        let coveredHours: Double?
        let dryHours: Double?
        let sparePercent: Double?
        let projectedExhaustionAt: Date?
    }

    struct Track: Equatable {
        let coveredFraction: Double?
        let activeExhaustionFraction: Double?
    }

    let status: Status
    let standing: Standing?
    let critical: Bool
    let earlyEstimate: Bool
    let remainingPercent: Double
    let resetsAt: Date
    let observationCount: Int
    let elapsedHours: Double?
    let rates: Rates
    let projection: Projection
    let track: Track

    /// The forecast has a stricter binding than ordinary history: it must name
    /// the exact current seven-day reset and the same remaining percentage.
    /// A response for a prior account/reset can therefore never ride beside a
    /// newer allowance observation.
    func isBound(to lane: ObservedQuotaLane, now: Date) -> Bool {
        guard lane.durationMinutes == CodexQuotaWindowDuration.sevenDayMinutes,
              let laneReset = lane.resetAt,
              abs(laneReset.timeIntervalSince(resetsAt)) < 0.001,
              abs(lane.remainingPercent - remainingPercent) <= 0.001,
              let hoursToReset = projection.hoursToReset,
              hoursToReset > 0,
              abs(
                  resetsAt.timeIntervalSince(now)
                    - hoursToReset * 3_600
              ) <= 120,
              resetsAt > now
        else {
            return false
        }
        if standing == .over,
           let exhaustion = projection.projectedExhaustionAt,
           exhaustion <= now {
            return false
        }
        return true
    }

    /// At either of these instants the current visual claim expires even if a
    /// normal one-minute poll has not fired yet.
    var nextPresentationBoundary: Date {
        if standing == .over,
           let exhaustion = projection.projectedExhaustionAt {
            return min(resetsAt, exhaustion)
        }
        return resetsAt
    }
}

/// Exact decoder for `local-weekly-pace-outlook-v0.1`. An unavailable outlook
/// and an invalid outlook both become nil at this compact surface: neither can
/// support a prediction, while independently valid allowance/history remains.
enum MenuBarWeeklyPaceOutlookProjection {
    private static let schemaVersion = "local-weekly-pace-outlook-v0.1"
    private static let maximumObservationCount = 8_192
    private static let topLevelKeys: Set<String> = [
        "schemaVersion",
        "status",
        "standing",
        "critical",
        "earlyEstimate",
        "remainingPercent",
        "resetsAt",
        "observationCount",
        "elapsedHours",
        "rates",
        "projection",
        "track",
    ]
    private static let rateKeys: Set<String> = [
        "activePercentagePointsPerHour",
        "overallPercentagePointsPerHour",
        "headlinePercentagePointsPerHour",
        "sustainablePercentagePointsPerHour",
        "ratio",
    ]
    private static let projectionKeys: Set<String> = [
        "hoursToReset",
        "coveredHours",
        "dryHours",
        "sparePercent",
        "projectedExhaustionAt",
    ]
    private static let trackKeys: Set<String> = [
        "coveredFraction",
        "activeExhaustionFraction",
    ]

    private enum Nullable<Value> {
        case null
        case value(Value)

        var value: Value? {
            switch self {
            case .null: nil
            case let .value(value): value
            }
        }
    }

    static func decode(_ data: Data) -> MenuBarWeeklyPaceOutlook? {
        guard let root = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any],
              let weekly = root["weekly"] as? [String: Any],
              let outlook = weekly["paceOutlook"] as? [String: Any]
        else {
            return nil
        }
        return decode(outlook)
    }

    static func decode(
        _ outlook: [String: Any]
    ) -> MenuBarWeeklyPaceOutlook? {
        guard Set(outlook.keys) == topLevelKeys,
              outlook["schemaVersion"] as? String == schemaVersion,
              let rawStatus = outlook["status"] as? String,
              let critical = exactBoolean(outlook["critical"]),
              let earlyEstimate = exactBoolean(outlook["earlyEstimate"]),
              let remaining = nullableNumber(
                  outlook["remainingPercent"],
                  minimum: 0,
                  maximum: 100
              ),
              let reset = nullableInstant(outlook["resetsAt"]),
              let observationCount = exactInteger(
                  outlook["observationCount"],
                  minimum: 0,
                  maximum: maximumObservationCount
              ),
              let elapsed = nullableNumber(
                  outlook["elapsedHours"],
                  minimum: 0
              ),
              let rawRates = outlook["rates"] as? [String: Any],
              Set(rawRates.keys) == rateKeys,
              let rates = decodeRates(rawRates),
              let rawProjection = outlook["projection"] as? [String: Any],
              Set(rawProjection.keys) == projectionKeys,
              let projection = decodeProjection(rawProjection),
              let rawTrack = outlook["track"] as? [String: Any],
              Set(rawTrack.keys) == trackKeys,
              let track = decodeTrack(rawTrack)
        else {
            return nil
        }

        if rawStatus == "unavailable" {
            guard nullStanding(outlook["standing"]),
                  !critical,
                  !earlyEstimate,
                  observationCount == 0,
                  allNil(
                      remaining.value,
                      reset.value,
                      elapsed.value,
                      rates.activePercentagePointsPerHour,
                      rates.overallPercentagePointsPerHour,
                      rates.headlinePercentagePointsPerHour,
                      rates.sustainablePercentagePointsPerHour,
                      rates.ratio,
                      projection.hoursToReset,
                      projection.coveredHours,
                      projection.dryHours,
                      projection.sparePercent,
                      projection.projectedExhaustionAt,
                      track.coveredFraction,
                      track.activeExhaustionFraction
                  )
            else {
                return nil
            }
            return nil
        }

        guard let remainingPercent = remaining.value,
              let resetsAt = reset.value
        else {
            return nil
        }

        if rawStatus == MenuBarWeeklyPaceOutlook.Status.collecting.rawValue {
            guard nullStanding(outlook["standing"]),
                  !critical,
                  !earlyEstimate,
                  observationCount == 1,
                  let elapsedHours = elapsed.value,
                  rates.activePercentagePointsPerHour == nil,
                  rates.overallPercentagePointsPerHour == nil,
                  rates.headlinePercentagePointsPerHour == nil,
                  rates.sustainablePercentagePointsPerHour == nil,
                  rates.ratio == nil,
                  projection.hoursToReset != nil,
                  projection.coveredHours == nil,
                  projection.dryHours == nil,
                  projection.sparePercent == nil,
                  projection.projectedExhaustionAt == nil,
                  track.coveredFraction == nil,
                  track.activeExhaustionFraction == nil
            else {
                return nil
            }
            return MenuBarWeeklyPaceOutlook(
                status: .collecting,
                standing: nil,
                critical: false,
                earlyEstimate: false,
                remainingPercent: remainingPercent,
                resetsAt: resetsAt,
                observationCount: observationCount,
                elapsedHours: elapsedHours,
                rates: rates,
                projection: projection,
                track: track
            )
        }

        guard rawStatus == MenuBarWeeklyPaceOutlook.Status.available.rawValue,
              let rawStanding = outlook["standing"] as? String,
              let standing = MenuBarWeeklyPaceOutlook.Standing(
                  rawValue: rawStanding
              ),
              observationCount >= 2,
              let elapsedHours = elapsed.value,
              elapsedHours > 0,
              let headline = rates.headlinePercentagePointsPerHour,
              headline > 0,
              let sustainable = rates.sustainablePercentagePointsPerHour,
              sustainable > 0,
              let ratio = rates.ratio,
              ratio > 0,
              let hoursToReset = projection.hoursToReset,
              hoursToReset > 0,
              let coveredHours = projection.coveredHours,
              let dryHours = projection.dryHours,
              let sparePercent = projection.sparePercent,
              let coveredFraction = track.coveredFraction,
              remainingPercent > 0,
              rates.activePercentagePointsPerHour.map { $0 > 0 } ?? true,
              rates.overallPercentagePointsPerHour.map { $0 > 0 } ?? true,
              let expectedHeadline = rates.overallPercentagePointsPerHour
                ?? rates.activePercentagePointsPerHour,
              approximatelyEqual(headline, expectedHeadline),
              approximatelyEqual(
                  sustainable,
                  remainingPercent / hoursToReset
              ),
              approximatelyEqual(ratio, headline / sustainable),
              approximatelyEqual(
                  coveredHours + dryHours,
                  hoursToReset
              ),
              approximatelyEqual(
                  coveredHours,
                  min(hoursToReset, remainingPercent / headline)
              ),
              approximatelyEqual(
                  sparePercent,
                  max(0, remainingPercent - headline * hoursToReset)
              ),
              approximatelyEqual(
                  coveredFraction,
                  coveredHours / hoursToReset
              ),
              standingMatchesRatio(standing, ratio: ratio),
              critical == (standing == .over && ratio >= 2),
              !earlyEstimate
                || observationCount <= 2
                || elapsedHours < 1,
              sparePercent >= 0,
              sparePercent <= 100
        else {
            return nil
        }

        let expectedActiveFraction = rates.activePercentagePointsPerHour
            .flatMap { active -> Double? in
                guard active > 0 else { return nil }
                let activeHours = remainingPercent / active
                guard activeHours < coveredHours * 0.95 else { return nil }
                return max(0, min(1, activeHours / hoursToReset))
            }
        if let expectedActiveFraction {
            guard let activeFraction = track.activeExhaustionFraction,
                  approximatelyEqual(
                      activeFraction,
                      expectedActiveFraction
                  )
            else {
                return nil
            }
        } else if track.activeExhaustionFraction != nil {
            return nil
        }

        if standing == .over {
            guard let exhaustion = projection.projectedExhaustionAt,
                  exhaustion < resetsAt,
                  abs(exhaustion.timeIntervalSince(
                      resetsAt.addingTimeInterval(-dryHours * 3_600)
                  )) <= 0.01
            else {
                return nil
            }
        } else if projection.projectedExhaustionAt != nil {
            return nil
        }

        return MenuBarWeeklyPaceOutlook(
            status: .available,
            standing: standing,
            critical: critical,
            earlyEstimate: earlyEstimate,
            remainingPercent: remainingPercent,
            resetsAt: resetsAt,
            observationCount: observationCount,
            elapsedHours: elapsedHours,
            rates: rates,
            projection: projection,
            track: track
        )
    }

    private static func decodeRates(
        _ value: [String: Any]
    ) -> MenuBarWeeklyPaceOutlook.Rates? {
        guard let active = nullableNumber(
                  value["activePercentagePointsPerHour"],
                  minimum: 0,
                  maximum: 100
              ),
              let overall = nullableNumber(
                  value["overallPercentagePointsPerHour"],
                  minimum: 0,
                  maximum: 100
              ),
              let headline = nullableNumber(
                  value["headlinePercentagePointsPerHour"],
                  minimum: 0,
                  maximum: 100
              ),
              let sustainable = nullableNumber(
                  value["sustainablePercentagePointsPerHour"],
                  minimum: 0
              ),
              let ratio = nullableNumber(value["ratio"], minimum: 0)
        else {
            return nil
        }
        return MenuBarWeeklyPaceOutlook.Rates(
            activePercentagePointsPerHour: active.value,
            overallPercentagePointsPerHour: overall.value,
            headlinePercentagePointsPerHour: headline.value,
            sustainablePercentagePointsPerHour: sustainable.value,
            ratio: ratio.value
        )
    }

    private static func decodeProjection(
        _ value: [String: Any]
    ) -> MenuBarWeeklyPaceOutlook.Projection? {
        guard let hoursToReset = nullableNumber(
                  value["hoursToReset"],
                  minimum: 0
              ),
              let coveredHours = nullableNumber(
                  value["coveredHours"],
                  minimum: 0
              ),
              let dryHours = nullableNumber(value["dryHours"], minimum: 0),
              let sparePercent = nullableNumber(
                  value["sparePercent"],
                  minimum: 0,
                  maximum: 100
              ),
              let projectedExhaustionAt = nullableInstant(
                  value["projectedExhaustionAt"]
              )
        else {
            return nil
        }
        return MenuBarWeeklyPaceOutlook.Projection(
            hoursToReset: hoursToReset.value,
            coveredHours: coveredHours.value,
            dryHours: dryHours.value,
            sparePercent: sparePercent.value,
            projectedExhaustionAt: projectedExhaustionAt.value
        )
    }

    private static func decodeTrack(
        _ value: [String: Any]
    ) -> MenuBarWeeklyPaceOutlook.Track? {
        guard let covered = nullableNumber(
                  value["coveredFraction"],
                  minimum: 0,
                  maximum: 1
              ),
              let active = nullableNumber(
                  value["activeExhaustionFraction"],
                  minimum: 0,
                  maximum: 1
              )
        else {
            return nil
        }
        return MenuBarWeeklyPaceOutlook.Track(
            coveredFraction: covered.value,
            activeExhaustionFraction: active.value
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

    private static func exactInteger(
        _ value: Any?,
        minimum: Int,
        maximum: Int
    ) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            return nil
        }
        let raw = number.doubleValue
        guard raw.isFinite,
              raw.rounded(.towardZero) == raw,
              raw >= Double(minimum),
              raw <= Double(maximum)
        else {
            return nil
        }
        return Int(raw)
    }

    private static func nullableNumber(
        _ value: Any?,
        minimum: Double = -.infinity,
        maximum: Double = .infinity
    ) -> Nullable<Double>? {
        if value is NSNull { return .null }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            return nil
        }
        let raw = number.doubleValue
        guard raw.isFinite, raw >= minimum, raw <= maximum else { return nil }
        return .value(raw)
    }

    private static func nullableInstant(
        _ value: Any?
    ) -> Nullable<Date>? {
        if value is NSNull { return .null }
        guard let text = value as? String,
              !text.isEmpty,
              text.count <= 32
        else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        guard let date = formatter.date(from: text),
              formatter.string(from: date) == text
        else {
            return nil
        }
        return .value(date)
    }

    private static func nullStanding(_ value: Any?) -> Bool {
        value is NSNull
    }

    private static func allNil(_ values: Any?...) -> Bool {
        values.allSatisfy { $0 == nil }
    }

    private static func standingMatchesRatio(
        _ standing: MenuBarWeeklyPaceOutlook.Standing,
        ratio: Double
    ) -> Bool {
        switch standing {
        case .under:
            ratio < 0.85
        case .on:
            ratio >= 0.85 && ratio <= 1.15
        case .over:
            ratio > 1.15
        }
    }

    private static func approximatelyEqual(
        _ left: Double,
        _ right: Double
    ) -> Bool {
        abs(left - right) <= 0.000_001 * max(1, abs(left), abs(right))
    }
}
