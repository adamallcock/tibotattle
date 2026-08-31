import AppKit
import Foundation

/// Observable, content-free layout facts used by the packaged AppKit smoke.
/// The contract deliberately reports structure rather than copying any live
/// allowance or accounting value out of the view hierarchy.
struct MenuBarPopoverPresentationContract: Equatable {
    let contentWidth: CGFloat
    let contentHeight: CGFloat
    let containsScrollView: Bool
    let visibleAllowanceLaneCount: Int
    let weeklyPaceVisible: Bool
    let weeklyPaceState: MenuBarPopoverPaceState?
    let selectedHistoryRange: MenuBarHistoryRange
    let dailyBarCount: Int
    let historyVisible: Bool
    let retainedHistoryDisclosed: Bool
    let partialPricingDisclosed: Bool
    let pricingState: MenuBarPopoverPricingState
    let historyCoverageState: MenuBarPopoverHistoryCoverageState
    let historyCoverageNamed: Bool
    let openActionEnabled: Bool
    let refreshActionEnabled: Bool
}

enum MenuBarPopoverPricingState: Equatable {
    case unavailable
    case completeEquivalent
    case knownSubtotal
}

enum MenuBarPopoverHistoryCoverageState: Equatable {
    case unavailable
    case complete
    case mixed
}

private enum MenuBarPopoverMetrics {
    static let width: CGFloat = 400
    static let horizontalInset: CGFloat = 18
    static let verticalInset: CGFloat = 16
    static let sectionSpacing: CGFloat = 13
    static let separatorSpacing: CGFloat = 12
    static let chartHeight: CGFloat = 104
}

private enum MenuBarPopoverHistoryState {
    case unavailable
    case available
}

enum MenuBarPopoverPaceState: Equatable {
    case collecting
    case under
    case on
    case over
    case critical

    var color: NSColor {
        switch self {
        case .collecting:
            return .secondaryLabelColor
        case .under:
            return .systemGreen
        case .on:
            return NativeBrandPalette.accent
        case .over:
            return .systemOrange
        case .critical:
            return .systemRed
        }
    }
}

private final class MenuBarPopoverBackgroundView: NSView {
    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        NativeBrandPalette.reportPaper.setFill()
        dirtyRect.fill(using: .sourceOver)
    }
}

private final class MenuBarPopoverSeparator: NSView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 1)
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        super.updateLayer()
        layer?.backgroundColor = NSColor.separatorColor.cgColor
    }
}

/// A native allowance row whose track and numeric label are always configured
/// together. Hiding the row therefore removes the complete claim atomically.
private final class MenuBarAllowanceTrackView: NSView {
    private let titleLabel = NSTextField(labelWithString: "")
    private let valueLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private var remainingFraction: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true

        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        valueLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        valueLabel.textColor = NativeBrandPalette.accent
        valueLabel.alignment = .right
        valueLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        detailLabel.font = .systemFont(ofSize: 10.5, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail

        for child in [titleLabel, valueLabel, detailLabel] {
            child.translatesAutoresizingMaskIntoConstraints = false
            addSubview(child)
        }

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 51),
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            titleLabel.topAnchor.constraint(equalTo: topAnchor),
            valueLabel.leadingAnchor.constraint(greaterThanOrEqualTo: titleLabel.trailingAnchor, constant: 8),
            valueLabel.trailingAnchor.constraint(equalTo: trailingAnchor),
            valueLabel.firstBaselineAnchor.constraint(equalTo: titleLabel.firstBaselineAnchor),
            detailLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            detailLabel.trailingAnchor.constraint(equalTo: trailingAnchor),
            detailLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 3),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func configure(
        title: String,
        remainingPercent: Int,
        detail: String,
        accessibilityDescription: String
    ) {
        titleLabel.stringValue = title
        valueLabel.stringValue = TiboTattleLocalization.format(
            .menuBarPopupRemaining,
            TiboTattleLocalization.percentString(remainingPercent)
        )
        detailLabel.stringValue = detail
        remainingFraction = CGFloat(min(100, max(0, remainingPercent))) / 100
        toolTip = accessibilityDescription
        setAccessibilityLabel(title)
        setAccessibilityValue(valueLabel.stringValue)
        setAccessibilityHelp(accessibilityDescription)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let track = NSRect(x: 0, y: 1, width: bounds.width, height: 7)
        NSColor.quaternaryLabelColor.setFill()
        NSBezierPath(roundedRect: track, xRadius: 3.5, yRadius: 3.5).fill()

        let fillWidth = remainingFraction > 0
            ? max(2, track.width * remainingFraction)
            : 0
        guard fillWidth > 0 else { return }
        let fill = NSRect(x: track.minX, y: track.minY, width: fillWidth, height: track.height)
        NativeBrandPalette.accent.setFill()
        NSBezierPath(roundedRect: fill, xRadius: 3.5, yRadius: 3.5).fill()
    }
}

/// A time-to-reset track whose standing and geometry come entirely from the
/// companion's shared weekly projection. Native code adds wording and draws
/// the supplied fractions; it never reclassifies pace from raw observations.
private final class MenuBarWeeklyPaceView: NSView {
    private final class TrackView: NSView {
        var state: MenuBarPopoverPaceState = .collecting
        var coveredFraction: CGFloat?
        var activeFraction: CGFloat?

        override var intrinsicContentSize: NSSize {
            NSSize(width: NSView.noIntrinsicMetric, height: 10)
        }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            let track = NSRect(
                x: 0,
                y: max(0, (bounds.height - 8) / 2),
                width: bounds.width,
                height: 8
            )
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: track, xRadius: 4, yRadius: 4).fill()

            if let coveredFraction {
                let width = coveredFraction > 0
                    ? max(2, track.width * coveredFraction)
                    : 0
                if width > 0 {
                    state.color.setFill()
                    NSBezierPath(
                        roundedRect: NSRect(
                            x: track.minX,
                            y: track.minY,
                            width: width,
                            height: track.height
                        ),
                        xRadius: 4,
                        yRadius: 4
                    ).fill()
                }
            } else {
                state.color.withAlphaComponent(0.28).setFill()
                for index in 0..<8 {
                    let dot = NSRect(
                        x: track.minX + CGFloat(index) * track.width / 8,
                        y: track.midY - 1,
                        width: 2,
                        height: 2
                    )
                    NSBezierPath(ovalIn: dot).fill()
                }
            }

            if let activeFraction {
                let x = track.minX + track.width * activeFraction
                let marker = NSBezierPath()
                marker.move(to: NSPoint(x: x, y: track.minY - 1))
                marker.line(to: NSPoint(x: x, y: track.maxY + 1))
                NSColor.labelColor.setStroke()
                marker.lineWidth = 1.5
                marker.stroke()
            }

            NSColor.secondaryLabelColor.setStroke()
            let resetMarker = NSBezierPath()
            resetMarker.move(to: NSPoint(x: track.maxX, y: track.minY - 1))
            resetMarker.line(to: NSPoint(x: track.maxX, y: track.maxY + 1))
            resetMarker.lineWidth = 1
            resetMarker.stroke()
        }
    }

    private let stateLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let trackView = TrackView()
    private let nowLabel = NSTextField(labelWithString: "")
    private let resetLabel = NSTextField(labelWithString: "")
    private let evidenceLabel = NSTextField(wrappingLabelWithString: "")
    private(set) var presentationState: MenuBarPopoverPaceState?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true

        stateLabel.font = .systemFont(ofSize: 11.5, weight: .semibold)
        detailLabel.font = .systemFont(ofSize: 10.5, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 2
        nowLabel.font = .systemFont(ofSize: 9.5, weight: .medium)
        nowLabel.textColor = .secondaryLabelColor
        resetLabel.font = .systemFont(ofSize: 9.5, weight: .medium)
        resetLabel.textColor = .secondaryLabelColor
        resetLabel.alignment = .right
        evidenceLabel.font = .systemFont(ofSize: 9.5, weight: .regular)
        evidenceLabel.textColor = .tertiaryLabelColor
        evidenceLabel.maximumNumberOfLines = 2

        let endpointLabels = NSStackView(views: [nowLabel, resetLabel])
        endpointLabels.translatesAutoresizingMaskIntoConstraints = false
        endpointLabels.orientation = .horizontal
        endpointLabels.alignment = .firstBaseline
        endpointLabels.distribution = .fillEqually
        let content = NSStackView(
            views: [
                stateLabel,
                detailLabel,
                trackView,
                endpointLabels,
                evidenceLabel,
            ]
        )
        content.translatesAutoresizingMaskIntoConstraints = false
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 3
        addSubview(content)
        for child in [
            stateLabel,
            detailLabel,
            trackView,
            endpointLabels,
            evidenceLabel,
        ] {
            child.widthAnchor.constraint(equalTo: content.widthAnchor)
                .isActive = true
        }
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func configure(
        outlook: MenuBarWeeklyPaceOutlook,
        now: Date
    ) {
        let state: MenuBarPopoverPaceState
        if outlook.status == .collecting {
            state = .collecting
        } else {
            switch outlook.standing {
            case .under:
                state = .under
            case .on:
                state = .on
            case .over:
                state = outlook.critical ? .critical : .over
            case .none:
                state = .collecting
            }
        }
        presentationState = state
        stateLabel.stringValue = stateTitle(state)
        stateLabel.textColor = state.color
        detailLabel.stringValue = detail(outlook, state: state)
        nowLabel.stringValue = TiboTattleLocalization.string(
            .menuBarPopupPaceNow
        )
        let reset = resetCountdown(outlook.resetsAt, now: now)
            ?? TiboTattleLocalization.string(.menuBarPopupResetUnavailable)
        resetLabel.stringValue = TiboTattleLocalization.format(
            .menuBarPopupPaceResetIn,
            reset
        )
        evidenceLabel.stringValue = evidence(outlook)
        trackView.state = state
        trackView.coveredFraction = outlook.track.coveredFraction.map {
            CGFloat(min(1, max(0, $0)))
        }
        trackView.activeFraction = outlook.track.activeExhaustionFraction.map {
            CGFloat(min(1, max(0, $0)))
        }
        trackView.needsDisplay = true

        let summary = "\(stateLabel.stringValue). \(detailLabel.stringValue)"
        toolTip = "\(summary) \(evidenceLabel.stringValue)"
        setAccessibilityLabel(
            TiboTattleLocalization.string(.menuBarPopupWeeklyPace)
        )
        setAccessibilityValue(summary)
        setAccessibilityHelp(evidenceLabel.stringValue)
    }

    private func stateTitle(_ state: MenuBarPopoverPaceState) -> String {
        switch state {
        case .collecting:
            TiboTattleLocalization.string(.menuBarPopupPaceCollecting)
        case .under:
            TiboTattleLocalization.string(.menuBarPopupPaceUnder)
        case .on:
            TiboTattleLocalization.string(.menuBarPopupPaceOn)
        case .over:
            TiboTattleLocalization.string(.menuBarPopupPaceOver)
        case .critical:
            TiboTattleLocalization.string(.menuBarPopupPaceCritical)
        }
    }

    private func detail(
        _ outlook: MenuBarWeeklyPaceOutlook,
        state: MenuBarPopoverPaceState
    ) -> String {
        guard state != .collecting,
              let ratio = outlook.rates.ratio
        else {
            return TiboTattleLocalization.string(
                .menuBarPopupPaceCollectingDetail
            )
        }
        let ratioText = TiboTattleLocalization.decimalNumberFormatter(
            maximumFractionDigits: 2
        ).string(from: NSNumber(value: ratio)) ?? String(format: "%.2f", ratio)
        let outcome: String
        if let dryHours = outlook.projection.dryHours, dryHours > 0.01 {
            outcome = TiboTattleLocalization.format(
                .menuBarPopupPaceDryBeforeReset,
                duration(hours: dryHours)
            )
        } else if let spare = outlook.projection.sparePercent, spare > 0.05 {
            outcome = TiboTattleLocalization.format(
                .menuBarPopupPaceSpareAtReset,
                TiboTattleLocalization.percentString(Int(spare.rounded()))
            )
        } else {
            outcome = TiboTattleLocalization.string(
                .menuBarPopupPaceReachesReset
            )
        }
        return TiboTattleLocalization.format(
            .menuBarPopupPaceRatioOutcome,
            ratioText,
            outcome
        )
    }

    private func evidence(_ outlook: MenuBarWeeklyPaceOutlook) -> String {
        if outlook.status == .collecting {
            return TiboTattleLocalization.string(
                .menuBarPopupPaceEvidenceOne
            )
        }
        let observations = TiboTattleLocalization.format(
            .menuBarPopupPaceEvidenceMany,
            TiboTattleLocalization.integerString(outlook.observationCount)
        )
        let withEstimate = outlook.earlyEstimate
            ? TiboTattleLocalization.format(
                .menuBarPopupPaceEarlyEstimate,
                observations
            )
            : observations
        return outlook.track.activeExhaustionFraction == nil
            ? withEstimate
            : TiboTattleLocalization.format(
                .menuBarPopupPaceActiveMarker,
                withEstimate
            )
    }

    private func duration(hours: Double) -> String {
        let totalMinutes = max(1, Int((hours * 60).rounded()))
        let days = totalMinutes / (24 * 60)
        let remainingHours = (totalMinutes % (24 * 60)) / 60
        let minutes = totalMinutes % 60
        if days > 0 {
            return TiboTattleLocalization.format(
                .menuBarResetDaysHours,
                days,
                remainingHours
            )
        }
        if remainingHours > 0 {
            return TiboTattleLocalization.format(
                .menuBarResetHoursMinutes,
                remainingHours,
                minutes
            )
        }
        return TiboTattleLocalization.format(.menuBarResetMinutes, minutes)
    }
}

/// Daily local-calendar token bars. Missing days are visual gaps, while a
/// fully observed zero is a short baseline mark. Partial days use an outline
/// and hatch so coverage is never communicated by color alone.
private final class MenuBarDailyTokenBarsView: NSView {
    private(set) var days: [MenuBarHistoryDay] = []
    private(set) var coverageState: MenuBarPopoverHistoryCoverageState = .unavailable
    private(set) var coverageSummary = ""
    private var rangeLabel = ""
    private var accessibilitySummary = ""
    private var dateFormatter: DateFormatter {
        let formatter = TiboTattleLocalization.dateFormatter(
            dateStyle: .medium,
            timeStyle: .none
        )
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        heightAnchor.constraint(equalToConstant: MenuBarPopoverMetrics.chartHeight)
            .isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func configure(days: [MenuBarHistoryDay], rangeLabel: String) {
        self.days = days
        self.rangeLabel = rangeLabel
        let completeCount = days.filter { $0.evidence == .available }.count
        let partialCount = days.filter { $0.evidence == .partial }.count
        let unavailableCount = days.filter { $0.evidence == .unavailable }.count
        let knownTokens = days.compactMap(\.totalTokens).reduce(Int64(0), +)
        if days.isEmpty {
            coverageState = .unavailable
            coverageSummary = ""
            accessibilitySummary = ""
        } else {
            coverageState = partialCount == 0 && unavailableCount == 0
                ? .complete
                : .mixed
            coverageSummary = TiboTattleLocalization.format(
                .menuBarPopupCoverageMixed,
                MenuBarPopoverFormatting.integer(Int64(completeCount)),
                MenuBarPopoverFormatting.integer(Int64(partialCount)),
                MenuBarPopoverFormatting.integer(Int64(unavailableCount))
            )
            accessibilitySummary = TiboTattleLocalization.format(
                .menuBarPopupCoverageAccessible,
                rangeLabel,
                MenuBarPopoverFormatting.integer(Int64(completeCount)),
                MenuBarPopoverFormatting.integer(Int64(partialCount)),
                MenuBarPopoverFormatting.integer(Int64(unavailableCount)),
                MenuBarPopoverFormatting.integer(knownTokens)
            )
        }
        toolTip = accessibilitySummary
        setAccessibilityLabel(TiboTattleLocalization.string(.menuBarPopupLocalUsage))
        setAccessibilityValue(accessibilitySummary)
        setAccessibilityHelp(accessibilitySummary)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !days.isEmpty else { return }

        let axisHeight: CGFloat = 19
        let plot = NSRect(
            x: 0,
            y: axisHeight,
            width: bounds.width,
            height: max(1, bounds.height - axisHeight - 3)
        )
        NSColor.separatorColor.withAlphaComponent(0.72).setStroke()
        let baseline = NSBezierPath()
        baseline.move(to: NSPoint(x: plot.minX, y: plot.minY))
        baseline.line(to: NSPoint(x: plot.maxX, y: plot.minY))
        baseline.lineWidth = 1
        baseline.stroke()

        let maximum = days.compactMap { day -> Int64? in
            guard day.evidence != .unavailable else { return nil }
            return day.totalTokens
        }.max() ?? 0
        let slot = plot.width / CGFloat(days.count)
        let gap = days.count > 7 ? min(3, slot * 0.34) : min(7, slot * 0.28)
        let barWidth = max(2, slot - gap)

        for (index, day) in days.enumerated() {
            let centerX = plot.minX + slot * (CGFloat(index) + 0.5)
            let x = centerX - barWidth / 2
            guard day.evidence != .unavailable, let tokens = day.totalTokens else {
                continue
            }
            let fraction = maximum > 0
                ? CGFloat(max(0, tokens)) / CGFloat(maximum)
                : 0
            let height = tokens == 0
                ? 2
                : max(3, floor((plot.height - 5) * fraction))
            let bar = NSRect(x: x, y: plot.minY + 1, width: barWidth, height: height)
            if day.evidence == .partial {
                drawPartialBar(bar)
            } else {
                NativeBrandPalette.accent.withAlphaComponent(0.82).setFill()
                NSBezierPath(roundedRect: bar, xRadius: 2, yRadius: 2).fill()
            }
        }

        drawAxisLabels(in: NSRect(x: 0, y: 0, width: bounds.width, height: axisHeight))
    }

    private func drawPartialBar(_ rect: NSRect) {
        NativeBrandPalette.accent.withAlphaComponent(0.22).setFill()
        let shape = NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2)
        shape.fill()
        NativeBrandPalette.accent.withAlphaComponent(0.8).setStroke()
        shape.lineWidth = 1
        shape.stroke()

        NSGraphicsContext.saveGraphicsState()
        shape.addClip()
        let hatch = NSBezierPath()
        var x = rect.minX - rect.height
        while x < rect.maxX + rect.height {
            hatch.move(to: NSPoint(x: x, y: rect.minY))
            hatch.line(to: NSPoint(x: x + rect.height, y: rect.maxY))
            x += 5
        }
        hatch.lineWidth = 0.75
        NativeBrandPalette.accent.withAlphaComponent(0.55).setStroke()
        hatch.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawAxisLabels(in rect: NSRect) {
        guard let first = days.first, let last = days.last else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: NSColor.tertiaryLabelColor,
        ]
        let start = dateFormatter.string(from: first.startAt)
        let end = dateFormatter.string(from: last.startAt)
        start.draw(at: NSPoint(x: rect.minX, y: rect.minY), withAttributes: attributes)
        let endSize = end.size(withAttributes: attributes)
        end.draw(
            at: NSPoint(x: rect.maxX - endSize.width, y: rect.minY),
            withAttributes: attributes
        )
    }
}

private enum MenuBarPopoverFormatting {
    static func integer(_ value: Int64) -> String {
        TiboTattleLocalization.decimalNumberFormatter(maximumFractionDigits: 0)
            .string(from: NSNumber(value: value)) ?? String(value)
    }

    static func compactInteger(_ value: Int64) -> String {
        let absolute = abs(Double(value))
        let divisor: Double
        let suffix: String
        switch absolute {
        case 1_000_000_000...:
            divisor = 1_000_000_000
            suffix = "B"
        case 1_000_000...:
            divisor = 1_000_000
            suffix = "M"
        case 1_000...:
            divisor = 1_000
            suffix = "K"
        default:
            return integer(value)
        }
        let formatter = TiboTattleLocalization.decimalNumberFormatter(
            maximumFractionDigits: 1
        )
        let number = formatter.string(from: NSNumber(value: Double(value) / divisor))
            ?? String(format: "%.1f", Double(value) / divisor)
        return number + suffix
    }

    static func usd(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = TiboTattleLocalization.locale
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = value < 0.01 && value > 0 ? 4 : 2
        formatter.maximumFractionDigits = value < 0.01 && value > 0 ? 4 : 2
        return formatter.string(from: NSNumber(value: value))
            ?? String(format: "$%.2f", value)
    }
}

@MainActor
final class MenuBarPopoverViewController: NSViewController {
    struct Actions {
        let openTiboTattle: () -> Void
        let refresh: () -> Void
        let showMore: (NSView) -> Void
    }

    private let productName: String
    private let brandImage: NSImage?
    private let actions: Actions

    private let productLabel = NSTextField(labelWithString: "")
    private let freshnessLabel = NSTextField(labelWithString: "")
    private let moreButton = NSButton()
    private let allowanceTitleLabel = NSTextField(labelWithString: "")
    private let allowanceRows = NSStackView()
    private let allowanceStateStack = NSStackView()
    private let allowanceStateTitle = NSTextField(labelWithString: "")
    private let allowanceStateBody = NSTextField(wrappingLabelWithString: "")
    private let weeklySection = NSStackView()
    private let weeklySeparator = MenuBarPopoverSeparator()
    private let weeklyTitleLabel = NSTextField(labelWithString: "")
    private let weeklyPaceView = MenuBarWeeklyPaceView()
    private let historyTitleLabel = NSTextField(labelWithString: "")
    private let rangeControl = NSSegmentedControl()
    private let historyHeadlineLabel = NSTextField(labelWithString: "")
    private let historyTokenLabel = NSTextField(labelWithString: "")
    private let historyEventsLabel = NSTextField(labelWithString: "")
    private let historyPriceLabel = NSTextField(wrappingLabelWithString: "")
    private let historyFreshnessLabel = NSTextField(wrappingLabelWithString: "")
    private let historyChart = MenuBarDailyTokenBarsView()
    private let historyCoverageLabel = NSTextField(wrappingLabelWithString: "")
    private let historyAvailableStack = NSStackView()
    private let historyUnavailableStack = NSStackView()
    private let historyUnavailableTitle = NSTextField(labelWithString: "")
    private let historyUnavailableBody = NSTextField(wrappingLabelWithString: "")
    private let disclaimerLabel = NSTextField(wrappingLabelWithString: "")
    private let openButton = NSButton()
    private let refreshButton = NSButton()

    private var currentSnapshot = MenuBarStatusSnapshot()
    private var currentNow = Date()
    private var selectedRange: MenuBarHistoryRange = .sevenDays
    private var visibleAllowanceLaneCount = 0
    private var historyState: MenuBarPopoverHistoryState = .unavailable
    private var partialPricingDisclosed = false
    private var pricingState: MenuBarPopoverPricingState = .unavailable
    private var didLoadInterface = false

    init(productName: String, brandImage: NSImage?, actions: Actions) {
        self.productName = productName
        self.brandImage = brandImage
        self.actions = actions
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let root = MenuBarPopoverBackgroundView(
            frame: NSRect(
                x: 0,
                y: 0,
                width: MenuBarPopoverMetrics.width,
                height: 1
            )
        )
        root.translatesAutoresizingMaskIntoConstraints = true
        view = root

        configureTypography()

        let content = NSStackView()
        content.translatesAutoresizingMaskIntoConstraints = false
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = MenuBarPopoverMetrics.sectionSpacing
        root.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(
                equalTo: root.leadingAnchor,
                constant: MenuBarPopoverMetrics.horizontalInset
            ),
            content.trailingAnchor.constraint(
                equalTo: root.trailingAnchor,
                constant: -MenuBarPopoverMetrics.horizontalInset
            ),
            content.topAnchor.constraint(
                equalTo: root.topAnchor,
                constant: MenuBarPopoverMetrics.verticalInset
            ),
        ])

        let header = makeHeader()
        let allowanceSection = makeAllowanceSection()
        let historySection = makeHistorySection()
        let footer = makeFooter()

        for arranged in [
            header,
            MenuBarPopoverSeparator(),
            allowanceSection,
            weeklySeparator,
            weeklySection,
            MenuBarPopoverSeparator(),
            historySection,
            MenuBarPopoverSeparator(),
            footer,
        ] {
            content.addArrangedSubview(arranged)
            arranged.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }

        content.setCustomSpacing(
            MenuBarPopoverMetrics.separatorSpacing,
            after: header
        )
        configureFocusOrder()
        didLoadInterface = true
        refreshLocalization()
    }

    func update(snapshot: MenuBarStatusSnapshot, now: Date = Date()) {
        currentSnapshot = snapshot
        currentNow = now
        loadViewIfNeeded()
        renderHeader(snapshot: snapshot, now: now)
        renderAllowance(snapshot: snapshot, now: now)
        renderHistory(snapshot.history)
        updateActionState(snapshot)
        updatePreferredContentSize()
    }

    func refreshLocalization() {
        guard didLoadInterface else { return }
        allowanceTitleLabel.stringValue = TiboTattleLocalization.string(
            .nativeDashboardAllowance
        )
        weeklyTitleLabel.stringValue = TiboTattleLocalization.string(
            .menuBarPopupWeeklyPace
        )
        historyTitleLabel.stringValue = TiboTattleLocalization.string(
            .menuBarPopupLocalUsage
        )
        rangeControl.setLabel(MenuBarHistoryRange.sevenDays.rawValue, forSegment: 0)
        rangeControl.setLabel(MenuBarHistoryRange.thirtyDays.rawValue, forSegment: 1)
        moreButton.toolTip = TiboTattleLocalization.string(.menuBarPopupMore)
        moreButton.setAccessibilityLabel(
            TiboTattleLocalization.format(
                .menuBarPopupAccessibilityMore,
                productName
            )
        )
        openButton.title = TiboTattleLocalization.format(
            .menuBarPopupOpenProduct,
            productName
        )
        openButton.toolTip = TiboTattleLocalization.format(
            .menuBarPopupAccessibilityOpenProduct,
            productName
        )
        openButton.setAccessibilityLabel(openButton.toolTip)
        refreshButton.title = TiboTattleLocalization.string(.menuBarPopupRefresh)
        refreshButton.toolTip = TiboTattleLocalization.string(
            .menuBarPopupAccessibilityRefresh
        )
        refreshButton.setAccessibilityLabel(refreshButton.toolTip)
        disclaimerLabel.stringValue = TiboTattleLocalization.string(
            .menuBarPopupNotSubscriptionBill
        )
        disclaimerLabel.toolTip = disclaimerLabel.stringValue
        disclaimerLabel.setAccessibilityLabel(disclaimerLabel.stringValue)
        renderHeader(snapshot: currentSnapshot, now: currentNow)
        renderAllowance(snapshot: currentSnapshot, now: currentNow)
        renderHistory(currentSnapshot.history)
        updatePreferredContentSize()
    }

    func nativePresentationContract() -> MenuBarPopoverPresentationContract {
        loadViewIfNeeded()
        view.layoutSubtreeIfNeeded()
        return MenuBarPopoverPresentationContract(
            contentWidth: view.bounds.width,
            contentHeight: view.bounds.height,
            containsScrollView: containsScrollView(view),
            visibleAllowanceLaneCount: visibleAllowanceLaneCount,
            weeklyPaceVisible: !weeklySection.isHidden,
            weeklyPaceState: weeklySection.isHidden
                ? nil
                : weeklyPaceView.presentationState,
            selectedHistoryRange: selectedRange,
            dailyBarCount: historyChart.days.count,
            historyVisible: historyState == .available,
            retainedHistoryDisclosed: !historyFreshnessLabel.isHidden
                && !historyFreshnessLabel.stringValue.isEmpty,
            partialPricingDisclosed: partialPricingDisclosed,
            pricingState: pricingState,
            historyCoverageState: historyChart.coverageState,
            historyCoverageNamed: !historyChart.coverageSummary.isEmpty,
            openActionEnabled: openButton.isEnabled,
            refreshActionEnabled: refreshButton.isEnabled
        )
    }

    /// Deterministic packaged-smoke seam. The production segmented control and
    /// this method share the same rendering path; no synthetic mouse event or
    /// private AppKit API is needed to verify both chart horizons.
    func selectHistoryRangeForSmokeTest(_ range: MenuBarHistoryRange) {
        loadViewIfNeeded()
        selectedRange = range
        rangeControl.selectedSegment = range == .sevenDays ? 0 : 1
        renderHistory(currentSnapshot.history)
        updatePreferredContentSize()
    }

    /// Offscreen AppKit rendering used by deterministic light/dark layout smoke
    /// modes. It needs no screen capture or accessibility permission.
    func renderPNG(to url: URL, appearance: NSAppearance.Name) throws {
        loadViewIfNeeded()
        let previousAppearance = view.appearance
        view.appearance = NSAppearance(named: appearance)
        defer { view.appearance = previousAppearance }
        markAppearanceDirty(view)
        updatePreferredContentSize()
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        guard let representation = view.bitmapImageRepForCachingDisplay(
            in: view.bounds
        ) else {
            throw MenuBarPopoverRenderError.bitmapUnavailable
        }
        view.cacheDisplay(in: view.bounds, to: representation)
        guard let data = representation.representation(
            using: .png,
            properties: [:]
        ) else {
            throw MenuBarPopoverRenderError.pngEncodingFailed
        }
        try data.write(to: url, options: .atomic)
    }

    /// Offscreen AppKit does not always invalidate every descendant when an
    /// appearance or language changes without a window. Mark the real view
    /// tree dirty so the render smoke sees the same complete hierarchy a
    /// presented NSPopover would draw.
    private func markAppearanceDirty(_ candidate: NSView) {
        candidate.needsLayout = true
        candidate.needsDisplay = true
        for child in candidate.subviews {
            markAppearanceDirty(child)
        }
    }

    private func configureTypography() {
        productLabel.font = .systemFont(ofSize: 14.5, weight: .semibold)
        productLabel.textColor = .labelColor
        productLabel.lineBreakMode = .byTruncatingTail
        freshnessLabel.font = .systemFont(ofSize: 10.5, weight: .regular)
        freshnessLabel.textColor = .secondaryLabelColor
        freshnessLabel.lineBreakMode = .byTruncatingTail

        for title in [allowanceTitleLabel, weeklyTitleLabel, historyTitleLabel] {
            title.font = .systemFont(ofSize: 11, weight: .semibold)
            title.textColor = NativeBrandPalette.accent
        }

        allowanceStateTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        allowanceStateBody.font = .systemFont(ofSize: 10.5)
        allowanceStateBody.textColor = .secondaryLabelColor
        allowanceStateBody.maximumNumberOfLines = 3

        historyHeadlineLabel.font = .systemFont(ofSize: 11, weight: .medium)
        historyHeadlineLabel.textColor = .secondaryLabelColor
        historyTokenLabel.font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        historyTokenLabel.textColor = .labelColor
        historyEventsLabel.font = .systemFont(ofSize: 10.5)
        historyEventsLabel.textColor = .secondaryLabelColor
        historyPriceLabel.font = .systemFont(ofSize: 10.5)
        historyPriceLabel.textColor = .secondaryLabelColor
        historyPriceLabel.maximumNumberOfLines = 2
        historyFreshnessLabel.font = .systemFont(ofSize: 10.5)
        historyFreshnessLabel.textColor = .secondaryLabelColor
        historyFreshnessLabel.maximumNumberOfLines = 2
        historyCoverageLabel.font = .systemFont(ofSize: 9.5)
        historyCoverageLabel.textColor = .secondaryLabelColor
        historyCoverageLabel.maximumNumberOfLines = 2

        historyUnavailableTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        historyUnavailableBody.font = .systemFont(ofSize: 10.5)
        historyUnavailableBody.textColor = .secondaryLabelColor
        historyUnavailableBody.maximumNumberOfLines = 3

        disclaimerLabel.font = .systemFont(ofSize: 9.5)
        disclaimerLabel.textColor = .tertiaryLabelColor
        disclaimerLabel.alignment = .center
        disclaimerLabel.maximumNumberOfLines = 2
    }

    private func makeHeader() -> NSView {
        let imageView = NSImageView()
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.image = brandImage
            ?? NSImage(
                systemSymbolName: "chart.bar.xaxis",
                accessibilityDescription: productName
            )
        imageView.imageScaling = .scaleProportionallyDown
        imageView.contentTintColor = NativeBrandPalette.accent
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 29),
            imageView.heightAnchor.constraint(equalToConstant: 29),
        ])

        productLabel.stringValue = productName
        let labels = verticalStack([productLabel, freshnessLabel], spacing: 1)
        labels.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        moreButton.translatesAutoresizingMaskIntoConstraints = false
        moreButton.image = NSImage(
            systemSymbolName: "ellipsis",
            accessibilityDescription: nil
        )
        moreButton.imagePosition = .imageOnly
        moreButton.bezelStyle = .circular
        moreButton.target = self
        moreButton.action = #selector(showMore)
        NSLayoutConstraint.activate([
            moreButton.widthAnchor.constraint(equalToConstant: 28),
            moreButton.heightAnchor.constraint(equalToConstant: 28),
        ])

        let header = NSStackView(views: [imageView, labels, spacer, moreButton])
        header.translatesAutoresizingMaskIntoConstraints = false
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 9
        return header
    }

    private func makeAllowanceSection() -> NSView {
        allowanceRows.translatesAutoresizingMaskIntoConstraints = false
        allowanceRows.orientation = .vertical
        allowanceRows.alignment = .leading
        allowanceRows.spacing = 8

        allowanceStateStack.translatesAutoresizingMaskIntoConstraints = false
        allowanceStateStack.orientation = .vertical
        allowanceStateStack.alignment = .leading
        allowanceStateStack.spacing = 3
        allowanceStateStack.addArrangedSubview(allowanceStateTitle)
        allowanceStateStack.addArrangedSubview(allowanceStateBody)
        allowanceStateBody.widthAnchor.constraint(
            equalTo: allowanceStateStack.widthAnchor
        ).isActive = true

        let section = verticalStack(
            [allowanceTitleLabel, allowanceRows, allowanceStateStack],
            spacing: 8
        )
        allowanceRows.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
        allowanceStateStack.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true

        weeklySection.translatesAutoresizingMaskIntoConstraints = false
        weeklySection.orientation = .vertical
        weeklySection.alignment = .leading
        weeklySection.spacing = 7
        weeklySection.addArrangedSubview(weeklyTitleLabel)
        weeklySection.addArrangedSubview(weeklyPaceView)
        weeklyPaceView.widthAnchor.constraint(equalTo: weeklySection.widthAnchor)
            .isActive = true
        return section
    }

    private func makeHistorySection() -> NSView {
        rangeControl.translatesAutoresizingMaskIntoConstraints = false
        rangeControl.segmentCount = 2
        rangeControl.trackingMode = .selectOne
        rangeControl.selectedSegment = 0
        rangeControl.target = self
        rangeControl.action = #selector(historyRangeChanged)
        rangeControl.controlSize = .small
        rangeControl.setWidth(52, forSegment: 0)
        rangeControl.setWidth(52, forSegment: 1)
        rangeControl.setAccessibilityLabel(
            TiboTattleLocalization.string(.menuBarPopupLocalUsage)
        )

        let historyHeaderSpacer = NSView()
        historyHeaderSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let historyHeader = NSStackView(
            views: [historyTitleLabel, historyHeaderSpacer, rangeControl]
        )
        historyHeader.translatesAutoresizingMaskIntoConstraints = false
        historyHeader.orientation = .horizontal
        historyHeader.alignment = .centerY
        historyHeader.spacing = 8

        let metricSpacer = NSView()
        metricSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let metrics = NSStackView(
            views: [historyTokenLabel, metricSpacer, historyEventsLabel]
        )
        metrics.translatesAutoresizingMaskIntoConstraints = false
        metrics.orientation = .horizontal
        metrics.alignment = .lastBaseline
        metrics.spacing = 8

        historyAvailableStack.translatesAutoresizingMaskIntoConstraints = false
        historyAvailableStack.orientation = .vertical
        historyAvailableStack.alignment = .leading
        historyAvailableStack.spacing = 4
        for child in [
            historyFreshnessLabel,
            historyHeadlineLabel,
            metrics,
            historyPriceLabel,
            historyChart,
            historyCoverageLabel,
        ] {
            historyAvailableStack.addArrangedSubview(child)
        }
        for child in [
            historyFreshnessLabel,
            historyHeadlineLabel,
            metrics,
            historyPriceLabel,
            historyChart,
            historyCoverageLabel,
        ] {
            child.widthAnchor.constraint(equalTo: historyAvailableStack.widthAnchor)
                .isActive = true
        }

        historyUnavailableStack.translatesAutoresizingMaskIntoConstraints = false
        historyUnavailableStack.orientation = .vertical
        historyUnavailableStack.alignment = .leading
        historyUnavailableStack.spacing = 3
        historyUnavailableStack.addArrangedSubview(historyUnavailableTitle)
        historyUnavailableStack.addArrangedSubview(historyUnavailableBody)
        historyUnavailableBody.widthAnchor.constraint(
            equalTo: historyUnavailableStack.widthAnchor
        ).isActive = true

        let section = verticalStack(
            [historyHeader, historyAvailableStack, historyUnavailableStack],
            spacing: 8
        )
        for child in [historyHeader, historyAvailableStack, historyUnavailableStack] {
            child.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
        }
        return section
    }

    private func makeFooter() -> NSView {
        openButton.translatesAutoresizingMaskIntoConstraints = false
        openButton.bezelStyle = .rounded
        openButton.bezelColor = NativeBrandPalette.accent
        openButton.target = self
        openButton.action = #selector(openTiboTattle)
        openButton.keyEquivalent = "\r"

        refreshButton.translatesAutoresizingMaskIntoConstraints = false
        refreshButton.bezelStyle = .rounded
        refreshButton.image = NSImage(
            systemSymbolName: "arrow.clockwise",
            accessibilityDescription: nil
        )
        refreshButton.imagePosition = .imageLeading
        refreshButton.target = self
        refreshButton.action = #selector(refresh)
        refreshButton.keyEquivalent = "r"
        refreshButton.keyEquivalentModifierMask = [.command]

        let buttonSpacer = NSView()
        buttonSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [openButton, buttonSpacer, refreshButton])
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.orientation = .horizontal
        buttons.alignment = .centerY
        buttons.spacing = 8

        let footer = verticalStack([buttons, disclaimerLabel], spacing: 8)
        buttons.widthAnchor.constraint(equalTo: footer.widthAnchor).isActive = true
        disclaimerLabel.widthAnchor.constraint(equalTo: footer.widthAnchor).isActive = true
        return footer
    }

    private func renderHeader(snapshot: MenuBarStatusSnapshot, now: Date) {
        let value: String
        if snapshot.phase == .analyzing {
            value = TiboTattleLocalization.string(.menuBarPopupHeaderUpdating)
        } else if snapshot.phase == .starting {
            value = TiboTattleLocalization.string(.menuBarPopupStartingTitle)
        } else if snapshot.phase == .unavailable {
            value = TiboTattleLocalization.string(.menuBarPopupErrorTitle)
        } else if snapshot.evidence == .live, let observedAt = snapshot.observedAt {
            let age = max(0, now.timeIntervalSince(observedAt))
            value = age < 90
                ? TiboTattleLocalization.string(.menuBarPopupHeaderLive)
                : TiboTattleLocalization.format(
                    .menuBarPopupHeaderLiveUpdated,
                    relativeAge(observedAt, now: now)
                )
        } else {
            value = TiboTattleLocalization.string(.menuBarPopupStaleTitle)
        }
        freshnessLabel.stringValue = value
        freshnessLabel.toolTip = value
        freshnessLabel.setAccessibilityLabel(value)
    }

    private func renderAllowance(snapshot: MenuBarStatusSnapshot, now: Date) {
        for arranged in allowanceRows.arrangedSubviews {
            allowanceRows.removeArrangedSubview(arranged)
            arranged.removeFromSuperview()
        }

        let lanes = renderableLanes(snapshot: snapshot, now: now)
        visibleAllowanceLaneCount = lanes.count
        allowanceRows.isHidden = lanes.isEmpty
        allowanceStateStack.isHidden = !lanes.isEmpty

        for lane in lanes.sorted(by: { $0.durationMinutes < $1.durationMinutes }) {
            let row = MenuBarAllowanceTrackView()
            let laneTitle = TiboTattleLocalization.quotaWindowLabel(
                durationMinutes: lane.durationMinutes
            )
            let resetText: String
            if let reset = resetCountdown(lane.resetAt, now: now) {
                resetText = TiboTattleLocalization.format(
                    .menuBarPopupResets,
                    reset
                )
            } else {
                resetText = TiboTattleLocalization.string(
                    .menuBarPopupResetUnavailable
                )
            }
            let accessibilityDescription = "\(laneTitle), "
                + TiboTattleLocalization.format(
                    .menuBarPopupRemaining,
                    TiboTattleLocalization.percentString(
                        lane.roundedRemainingPercent
                    )
                )
                + ", \(resetText)"
            row.configure(
                title: laneTitle,
                remainingPercent: lane.roundedRemainingPercent,
                detail: resetText,
                accessibilityDescription: accessibilityDescription
            )
            allowanceRows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: allowanceRows.widthAnchor).isActive = true
        }

        if lanes.isEmpty {
            let stateCopy = allowanceUnavailableCopy(snapshot: snapshot, now: now)
            allowanceStateTitle.stringValue = stateCopy.title
            allowanceStateBody.stringValue = stateCopy.body
            allowanceStateStack.setAccessibilityElement(true)
            allowanceStateStack.setAccessibilityRole(.group)
            allowanceStateStack.setAccessibilityLabel(stateCopy.title)
            allowanceStateStack.setAccessibilityHelp(stateCopy.body)
        }

        if let outlook = snapshot.currentWeeklyPaceOutlook(now: now) {
            weeklyPaceView.configure(outlook: outlook, now: now)
            weeklySection.isHidden = false
            weeklySeparator.isHidden = false
        } else {
            weeklySection.isHidden = true
            weeklySeparator.isHidden = true
        }
    }

    private func renderHistory(_ history: MenuBarHistorySnapshot) {
        rangeControl.selectedSegment = selectedRange == .sevenDays ? 0 : 1
        historyFreshnessLabel.stringValue = ""
        historyFreshnessLabel.isHidden = true
        guard history.accountingStatus != .unavailable,
              let period = history.period(for: selectedRange)
        else {
            historyState = .unavailable
            partialPricingDisclosed = false
            pricingState = .unavailable
            historyAvailableStack.isHidden = true
            historyUnavailableStack.isHidden = false
            historyUnavailableTitle.stringValue = TiboTattleLocalization.string(
                .menuBarPopupAccountingUnavailableTitle
            )
            historyUnavailableBody.stringValue = TiboTattleLocalization.string(
                .menuBarPopupAccountingUnavailableBody
            )
            historyUnavailableStack.setAccessibilityElement(true)
            historyUnavailableStack.setAccessibilityRole(.group)
            historyUnavailableStack.setAccessibilityLabel(
                historyUnavailableTitle.stringValue
            )
            historyUnavailableStack.setAccessibilityHelp(
                historyUnavailableBody.stringValue
            )
            historyChart.configure(days: [], rangeLabel: "")
            historyCoverageLabel.stringValue = ""
            historyCoverageLabel.isHidden = true
            return
        }

        historyState = .available
        historyAvailableStack.isHidden = false
        historyUnavailableStack.isHidden = true
        if history.accountingStatus == .retained
            || currentSnapshot.phase == .analyzing {
            historyFreshnessLabel.stringValue = TiboTattleLocalization.string(
                .menuBarPopupRetainedHistory
            )
            historyFreshnessLabel.isHidden = false
            historyFreshnessLabel.setAccessibilityLabel(
                historyFreshnessLabel.stringValue
            )
        }
        let periodLabel = selectedRange == .sevenDays
            ? TiboTattleLocalization.string(.menuBarPopupPeriodLastSevenDays)
            : TiboTattleLocalization.string(.menuBarPopupPeriodLastThirtyDays)
        historyHeadlineLabel.stringValue = periodLabel
        historyTokenLabel.stringValue = TiboTattleLocalization.format(
            .menuBarPopupTokenCount,
            MenuBarPopoverFormatting.compactInteger(period.totalTokens)
        )
        historyTokenLabel.toolTip = TiboTattleLocalization.format(
            .menuBarPopupTokenCount,
            MenuBarPopoverFormatting.integer(period.totalTokens)
        )
        historyEventsLabel.stringValue = period.events == 0
            ? TiboTattleLocalization.format(
                .menuBarPopupNoUsageObserved,
                periodLabel
            )
            : period.events == 1
                ? TiboTattleLocalization.string(.menuBarPopupUsageChangeOne)
                : TiboTattleLocalization.format(
                .menuBarPopupUsageChangesMany,
                MenuBarPopoverFormatting.integer(period.events)
            )

        let coverage = period.pricingCoverage
        partialPricingDisclosed = !coverage.isComplete
        if coverage.isComplete {
            pricingState = .completeEquivalent
            historyPriceLabel.stringValue = TiboTattleLocalization.format(
                .menuBarPopupUsageSummary,
                MenuBarPopoverFormatting.usd(period.knownAPIPriceEquivalentUSD),
                TiboTattleLocalization.string(.menuBarPopupAPIPriceEquivalent)
            )
        } else if coverage.pricedEvents > 0 {
            pricingState = .knownSubtotal
            historyPriceLabel.stringValue = TiboTattleLocalization.format(
                .menuBarPopupUsageSummary,
                MenuBarPopoverFormatting.usd(period.knownAPIPriceEquivalentUSD),
                TiboTattleLocalization.string(
                    .menuBarPopupAPIPriceEquivalentPartial
                )
            ) + " · " + TiboTattleLocalization.string(.menuBarPopupPartialPricing)
        } else {
            pricingState = .unavailable
            historyPriceLabel.stringValue = TiboTattleLocalization.string(
                .menuBarPopupAPIPriceEquivalentUnavailable
            ) + " " + TiboTattleLocalization.string(.menuBarPopupPartialPricing)
        }
        let coverageDetail = TiboTattleLocalization.format(
            .menuBarPopupPartialPricingDetail,
            MenuBarPopoverFormatting.integer(coverage.fullyPricedEvents),
            MenuBarPopoverFormatting.integer(coverage.partiallyPricedEvents),
            MenuBarPopoverFormatting.integer(coverage.unpricedEvents)
        )
        let priceHelp = coverage.isComplete
            ? TiboTattleLocalization.string(.menuBarPopupNotSubscriptionBill)
            : coverageDetail + ". "
                + TiboTattleLocalization.string(.menuBarPopupNotSubscriptionBill)
        historyPriceLabel.toolTip = priceHelp
        historyPriceLabel.setAccessibilityLabel(historyPriceLabel.stringValue)
        historyPriceLabel.setAccessibilityHelp(priceHelp)

        let days = history.history(for: selectedRange)
        historyChart.configure(days: days, rangeLabel: periodLabel)
        historyCoverageLabel.stringValue = historyChart.coverageSummary
        historyCoverageLabel.toolTip = historyChart.coverageSummary
        historyCoverageLabel.setAccessibilityLabel(historyChart.coverageSummary)
        historyCoverageLabel.isHidden = historyChart.coverageState == .complete
    }

    private func updateActionState(_ snapshot: MenuBarStatusSnapshot) {
        openButton.isEnabled = true
        refreshButton.isEnabled = snapshot.analysisAvailable
            && (snapshot.phase == .ready || snapshot.phase == .unavailable)
        refreshButton.state = snapshot.phase == .analyzing ? .on : .off
    }

    private func updatePreferredContentSize() {
        guard didLoadInterface, let content = view.subviews.first else { return }
        view.frame.size.width = MenuBarPopoverMetrics.width
        view.layoutSubtreeIfNeeded()
        let fittingHeight = ceil(
            content.fittingSize.height + MenuBarPopoverMetrics.verticalInset * 2
        )
        let size = NSSize(
            width: MenuBarPopoverMetrics.width,
            height: max(1, fittingHeight)
        )
        view.frame.size = size
        preferredContentSize = size
        view.layoutSubtreeIfNeeded()
    }

    private func renderableLanes(
        snapshot: MenuBarStatusSnapshot,
        now: Date
    ) -> [ObservedQuotaLane] {
        snapshot.currentLanes(now: now)
    }

    private func allowanceUnavailableCopy(
        snapshot: MenuBarStatusSnapshot,
        now: Date
    ) -> (title: String, body: String) {
        switch snapshot.phase {
        case .starting:
            return (
                TiboTattleLocalization.string(.menuBarPopupStartingTitle),
                TiboTattleLocalization.string(.menuBarPopupStartingBody)
            )
        case .analyzing:
            return (
                TiboTattleLocalization.string(.menuBarPopupUpdatingTitle),
                TiboTattleLocalization.string(.menuBarPopupUpdatingBody)
            )
        case .unavailable:
            return (
                TiboTattleLocalization.string(.menuBarPopupErrorTitle),
                TiboTattleLocalization.string(.menuBarPopupErrorBody)
            )
        case .ready:
            if snapshot.evidence == .stale {
                let age = snapshot.observedAt.map {
                    relativeAge($0, now: now)
                } ?? TiboTattleLocalization.string(.menuBarLocalEvidenceStale)
                return (
                    TiboTattleLocalization.string(.menuBarPopupStaleTitle),
                    TiboTattleLocalization.format(
                        .menuBarPopupStaleBody,
                        age
                    )
                )
            }
            return (
                TiboTattleLocalization.string(.menuBarNoVerifiedAllowance),
                TiboTattleLocalization.string(.menuBarNoVerifiedQuota)
            )
        }
    }

    private func configureFocusOrder() {
        moreButton.nextKeyView = rangeControl
        rangeControl.nextKeyView = openButton
        openButton.nextKeyView = refreshButton
        refreshButton.nextKeyView = moreButton
    }

    private func containsScrollView(_ candidate: NSView) -> Bool {
        if candidate is NSScrollView { return true }
        return candidate.subviews.contains(where: containsScrollView)
    }

    @objc private func historyRangeChanged() {
        selectedRange = rangeControl.selectedSegment == 1
            ? .thirtyDays
            : .sevenDays
        renderHistory(currentSnapshot.history)
        updatePreferredContentSize()
    }

    @objc private func openTiboTattle() {
        actions.openTiboTattle()
    }

    @objc private func refresh() {
        actions.refresh()
    }

    @objc private func showMore(_ sender: NSView) {
        actions.showMore(sender)
    }
}

private enum MenuBarPopoverRenderError: Error {
    case bitmapUnavailable
    case pngEncodingFailed
}

private func verticalStack(_ views: [NSView], spacing: CGFloat) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = spacing
    return stack
}
