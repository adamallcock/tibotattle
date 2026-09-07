import AppKit
import Foundation

/// Presentation only. Never stores observations or changes collection cadence.
struct TrayPreferences: Codable, Equatable {
    var schemaVersion = 1
    var preset = "weekly"
    var iconMode = "meter"
    var meterWindow = "weekly"
    var barMetric = "remaining"
    var resetFormat = "countdown"
    var sections = ["allowances", "pace", "usage"]
    var historyRange = "7d"
    var showChart = true
    var metrics = ["tokens", "cost", "changes"]
    var density = "comfortable"
    var emphasizeLow = false
    static let defaults = TrayPreferences()
    static var upgrade: Self { var p = defaults; p.preset = "automatic"; return p }
    var valid: Bool {
        schemaVersion == 1
        && ["automatic", "five-hour", "weekly", "both", "icon-only"].contains(preset)
        && ["app", "meter", "dual-meter"].contains(iconMode)
        && ["five-hour", "weekly"].contains(meterWindow)
        && ["remaining", "reset", "remaining-reset"].contains(barMetric)
        && (preset != "both" || barMetric == "remaining")
        && ["countdown", "clock"].contains(resetFormat)
        && Set(sections).count == sections.count
        && Set(sections).isSubset(of: ["allowances", "pace", "usage", "cache"])
        && ["7d", "30d"].contains(historyRange)
        && Set(metrics).count == metrics.count
        && Set(metrics).isSubset(of: ["tokens", "cost", "changes"])
        && (!sections.contains("usage") || showChart || !metrics.isEmpty)
        && ["comfortable", "compact"].contains(density)
    }
    static func decode(_ data: Data) -> Self? {
        let keys: Set<String> = ["schemaVersion", "preset", "iconMode", "meterWindow", "barMetric", "resetFormat", "sections", "historyRange", "showChart", "metrics", "density", "emphasizeLow"]
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == keys,
              let value = try? JSONDecoder().decode(Self.self, from: data), value.valid else { return nil }
        return value
    }
    static func legacy(_ value: String) -> Self? {
        var p = upgrade
        switch value {
        case "primary", "automatic": p.preset = "automatic"
        case "fiveHour", "five-hour", "5h", "session": p.preset = "five-hour"; p.meterWindow = "five-hour"
        case "weekly", "sevenDay", "7d": p.preset = "weekly"
        case "both": p.preset = "both"
        case "off", "none": p.preset = "icon-only"; p.iconMode = "app"
        default: return nil
        }
        return p
    }
}

final class TrayPreferenceStore {
    static let shared = TrayPreferenceStore()
    static let changed = Notification.Name("TiboTattleTrayPreferencesChanged")
    private(set) var value = TrayPreferences.upgrade
    private(set) var previous: TrayPreferences?
    private(set) var error: String?
    private var file: URL?
    private var protectedFile = false
    func configure(directory: URL, existingInstall: Bool, legacy: String? = nil) {
        guard file == nil else { return }
        file = directory.appendingPathComponent("tray-preferences-v1.json")
        value = legacy.flatMap(TrayPreferences.legacy) ?? (existingInstall ? .upgrade : .defaults)
        guard let file else { return }
        if FileManager.default.fileExists(atPath: file.path) {
            guard let values = try? file.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey]),
                  values.isSymbolicLink != true, (values.fileSize ?? 100_001) <= 100_000,
                  let data = try? Data(contentsOf: file), let decoded = TrayPreferences.decode(data)
            else {
                protectedFile = true
                error = trayText("protected")
                return
            }
            value = decoded
        } else {
            _ = save(value)
            previous = nil
        }
    }
    @discardableResult func save(_ next: TrayPreferences) -> Bool {
        guard next.valid else { error = trayText("invalid"); return false }
        guard !protectedFile, let file else { error = trayText("protected"); return false }
        do {
            // Recheck on every write: an older running copy must not overwrite
            // a preference file produced by a newer application.
            if FileManager.default.fileExists(atPath: file.path) {
                let attrs = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey])
                guard attrs.isSymbolicLink != true, (attrs.fileSize ?? 100_001) <= 100_000,
                      TrayPreferences.decode(try Data(contentsOf: file)) != nil else {
                    protectedFile = true; error = trayText("protected"); return false
                }
            }
            try JSONEncoder().encode(next).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            previous = value; value = next; error = nil
            NotificationCenter.default.post(name: Self.changed, object: self)
            return true
        } catch { self.error = trayText("saveFailed"); return false }
    }
    func undo() { if let previous { _ = save(previous) } }
}

/// All selected lanes remain pinned, including unavailable slots.
enum TrayPresentation {
    static func lane(_ window: String, snapshot: MenuBarStatusSnapshot, now: Date) -> ObservedQuotaLane? {
        let minutes = window == "five-hour" ? 300 : 10_080
        let matches = snapshot.lanes.filter { $0.durationMinutes == minutes }
        guard let first = matches.first, matches.allSatisfy({ $0 == first }), snapshot.laneIsCurrent(first, now: now) else { return nil }
        return first
    }
    static func windows(_ p: TrayPreferences, snapshot: MenuBarStatusSnapshot, now: Date) -> [String] {
        switch p.preset {
        case "both": return ["five-hour", "weekly"]
        case "five-hour", "weekly": return [p.preset]
        case "icon-only": return []
        default: return [snapshot.currentPrimaryLane(now: now)?.durationMinutes == 300 ? "five-hour" : "weekly"]
        }
    }
    static func meterWindow(_ p: TrayPreferences, snapshot: MenuBarStatusSnapshot, now: Date) -> String {
        if ["five-hour", "weekly", "automatic"].contains(p.preset) { return windows(p, snapshot: snapshot, now: now).first ?? p.meterWindow }
        return p.meterWindow
    }
    static func reset(_ date: Date?, format: String, now: Date) -> String? {
        guard let date, date > now else { return nil }
        if format == "clock" {
            let formatter = DateFormatter()
            formatter.locale = .current
            formatter.dateStyle = Calendar.current.isDate(date, inSameDayAs: now) ? .none : .short
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
        let minutes = max(1, Int(ceil(date.timeIntervalSince(now) / 60)))
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 1440 { return "\(minutes / 60)h \(minutes % 60)m" }
        return "\(minutes / 1440)d \((minutes % 1440) / 60)h"
    }
    static func title(_ p: TrayPreferences, snapshot: MenuBarStatusSnapshot, now: Date = Date()) -> String {
        windows(p, snapshot: snapshot, now: now).map { window in
            let label = window == "five-hour" ? "5h" : "7d"
            let current = lane(window, snapshot: snapshot, now: now)
            let remaining = current.map { TiboTattleLocalization.percentString($0.roundedRemainingPercent) } ?? "—"
            let reset = reset(current?.resetAt, format: p.resetFormat, now: now) ?? "—"
            if p.barMetric == "reset" { return "\(label) \(trayText(p.resetFormat == "clock" ? "at" : "in")) \(reset)" }
            if p.barMetric == "remaining-reset" { return "\(label) \(remaining) · \(trayText(p.resetFormat == "clock" ? "at" : "in")) \(reset)" }
            return "\(label) \(remaining)"
        }.joined(separator: " · ")
    }
}

struct TrayLowAllowanceState {
    private var active: Set<String> = []
    private var resetDates: [String: Date] = [:]
    private var observationDates: [String: Date] = [:]
    mutating func update(_ p: TrayPreferences, snapshot: MenuBarStatusSnapshot, now: Date) -> Set<String> {
        let windows = p.preset == "icon-only" ? [p.meterWindow] : TrayPresentation.windows(p, snapshot: snapshot, now: now)
        guard p.emphasizeLow else { active = []; resetDates = [:]; observationDates = [:]; return [] }
        active = active.intersection(windows)
        for window in windows {
            guard let lane = TrayPresentation.lane(window, snapshot: snapshot, now: now), let reset = lane.resetAt else {
                active.remove(window); resetDates.removeValue(forKey: window); observationDates.removeValue(forKey: window); continue
            }
            // The compact DTO carries no account identity. Preserve hysteresis
            // only within the same observation/reset, never across an opaque
            // source replacement that happens to share its reset timestamp.
            if resetDates[window] != reset || observationDates[window] != lane.observedAt { active.remove(window) }
            resetDates[window] = reset
            observationDates[window] = lane.observedAt
            if lane.remainingPercent <= 10 { active.insert(window) }
            if lane.remainingPercent >= 12 { active.remove(window) }
        }
        return active
    }
}

/// Dedicated Settings page shared by the General and popup Customize entries.
private final class TrayCustomizationDocumentView: NSView { override var isFlipped: Bool { true } }

final class TrayCustomizationController: NSWindowController {
    static let shared = TrayCustomizationController()
    private let stack = NSStackView()
    private let preview = NSTextField(wrappingLabelWithString: "")
    private let previewIcon = NSImageView()
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private var pickers: [String: NSPopUpButton] = [:]
    private var checks: [String: NSButton] = [:]
    private var sectionRows: [String: NSView] = [:]
    private let sectionStack = NSStackView()
    private var sectionOrder = ["allowances", "pace", "usage", "cache"]
    private var previewState = "current"
    private var exampleSnapshot = MenuBarStatusSnapshot()
    private var exampleWindow: NSWindow?
    private var exampleController: MenuBarPopoverViewController?
    private var observer: NSObjectProtocol?
    init() {
        let root = NSViewController()
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 600, height: 720))
        scroll.hasVerticalScroller = true
        let document = TrayCustomizationDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        root.view = scroll
        let window = NSWindow(contentViewController: root)
        window.title = trayText("menuBar")
        window.styleMask = [.titled, .closable, .resizable]
        window.isReleasedWhenClosed = false
        super.init(window: window)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -20),
        ])
        heading("beside")
        picker("preset", ["automatic", "five-hour", "weekly", "both", "icon-only"])
        picker("iconMode", ["app", "meter", "dual-meter"])
        picker("meterWindow", ["five-hour", "weekly"])
        picker("barMetric", ["remaining", "reset", "remaining-reset"])
        picker("resetFormat", ["countdown", "clock"])
        check("emphasizeLow")
        picker("example", ["current", "refreshing", "partial", "stale", "offline", "exhausted"])
        preview.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        previewIcon.imageScaling = .scaleNone
        previewIcon.widthAnchor.constraint(equalToConstant: 24).isActive = true
        previewIcon.heightAnchor.constraint(equalToConstant: 24).isActive = true
        stack.addArrangedSubview(NSStackView(views: [previewIcon, preview]))
        stack.addArrangedSubview(NSButton(title: trayText("example"), target: self, action: #selector(showExamplePopup)))
        heading("opened")
        sectionStack.orientation = .vertical; sectionStack.alignment = .leading; sectionStack.spacing = 5
        stack.addArrangedSubview(sectionStack)
        for section in sectionOrder {
            let toggle = NSButton(checkboxWithTitle: trayText(section), target: self, action: #selector(changed(_:)))
            toggle.identifier = NSUserInterfaceItemIdentifier("section-" + section)
            checks["section-" + section] = toggle
            let up = NSButton(title: "↑", target: self, action: #selector(moveSection(_:)))
            let down = NSButton(title: "↓", target: self, action: #selector(moveSection(_:)))
            up.identifier = NSUserInterfaceItemIdentifier(section + ":-1")
            down.identifier = NSUserInterfaceItemIdentifier(section + ":1")
            up.setAccessibilityLabel(trayText("moveUp") + " " + trayText(section))
            down.setAccessibilityLabel(trayText("moveDown") + " " + trayText(section))
            let row = NSStackView(views: [toggle, up, down]); row.spacing = 10
            sectionRows[section] = row; sectionStack.addArrangedSubview(row)
        }
        picker("historyRange", ["7d", "30d"])
        check("showChart")
        for metric in ["tokens", "cost", "changes"] { check("metric-" + metric) }
        picker("density", ["comfortable", "compact"])
        let undo = NSButton(title: trayText("undo"), target: self, action: #selector(undoChange))
        let reset = NSButton(title: trayText("restore"), target: self, action: #selector(restore))
        stack.addArrangedSubview(NSStackView(views: [undo, reset]))
        errorLabel.textColor = .systemRed; stack.addArrangedSubview(errorLabel)
        observer = NotificationCenter.default.addObserver(forName: TrayPreferenceStore.changed, object: nil, queue: .main) { [weak self] _ in self?.reload() }
        reload()
    }
    required init?(coder: NSCoder) { nil }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    func open() { reload(); showWindow(nil); window?.center(); NSApp.activate(ignoringOtherApps: true) }
    private func heading(_ key: String) { let label = NSTextField(labelWithString: trayText(key)); label.font = .boldSystemFont(ofSize: 14); stack.addArrangedSubview(label) }
    private func picker(_ key: String, _ options: [String]) {
        let p = NSPopUpButton(); p.target = self; p.action = #selector(changed(_:)); p.identifier = NSUserInterfaceItemIdentifier(key)
        for option in options { p.addItem(withTitle: trayText(option)); p.lastItem?.representedObject = option }
        p.setAccessibilityLabel(trayText(key)); pickers[key] = p
        stack.addArrangedSubview(NSStackView(views: [NSTextField(labelWithString: trayText(key)), p]))
    }
    private func check(_ key: String) {
        let button = NSButton(checkboxWithTitle: trayText(key), target: self, action: #selector(changed(_:)))
        button.identifier = NSUserInterfaceItemIdentifier(key); checks[key] = button; stack.addArrangedSubview(button)
    }
    private func selected(_ key: String) -> String { pickers[key]?.selectedItem?.representedObject as? String ?? "" }
    private func reload() {
        let p = TrayPreferenceStore.shared.value
        let values = ["preset":p.preset, "iconMode":p.iconMode, "meterWindow":p.meterWindow, "barMetric":p.barMetric, "resetFormat":p.resetFormat, "historyRange":p.historyRange, "density":p.density, "example":previewState]
        for (key, value) in values { if let picker = pickers[key], let index = picker.itemArray.firstIndex(where: { $0.representedObject as? String == value }) { picker.selectItem(at: index) } }
        checks["emphasizeLow"]?.state = p.emphasizeLow ? .on : .off
        checks["showChart"]?.state = p.showChart ? .on : .off
        for section in sectionOrder { checks["section-" + section]?.state = p.sections.contains(section) ? .on : .off }
        for metric in ["tokens", "cost", "changes"] { checks["metric-" + metric]?.state = p.metrics.contains(metric) ? .on : .off }
        let desired = p.sections + sectionOrder.filter { !p.sections.contains($0) }
        if desired != sectionOrder {
            sectionOrder = desired
            for row in sectionStack.arrangedSubviews { sectionStack.removeArrangedSubview(row); row.removeFromSuperview() }
            for key in sectionOrder { sectionStack.addArrangedSubview(sectionRows[key]!) }
        }
        // Both percentages already consume the two permitted compact fields.
        pickers["barMetric"]?.isEnabled = p.preset != "both" && p.preset != "icon-only"
        updatePreview(); errorLabel.stringValue = TrayPreferenceStore.shared.error ?? ""
    }
    @objc private func changed(_ sender: NSControl) {
        if sender.identifier?.rawValue == "example" { previewState = selected("example"); updatePreview(); return }
        var p = TrayPreferenceStore.shared.value
        p.preset = selected("preset"); p.iconMode = selected("iconMode"); p.meterWindow = selected("meterWindow")
        p.barMetric = p.preset == "both" ? "remaining" : selected("barMetric")
        p.resetFormat = selected("resetFormat"); p.historyRange = selected("historyRange"); p.density = selected("density")
        p.showChart = checks["showChart"]?.state == .on; p.emphasizeLow = checks["emphasizeLow"]?.state == .on
        p.sections = sectionOrder.filter { checks["section-" + $0]?.state == .on }
        p.metrics = ["tokens", "cost", "changes"].filter { checks["metric-" + $0]?.state == .on }
        _ = TrayPreferenceStore.shared.save(p); reload()
    }
    @objc private func moveSection(_ sender: NSButton) {
        guard let pieces = sender.identifier?.rawValue.split(separator: ":"), let key = pieces.first.map(String.init), let delta = pieces.last.flatMap({ Int($0) }), let index = sectionOrder.firstIndex(of: key), sectionOrder.indices.contains(index + delta) else { return }
        sectionOrder.swapAt(index, index + delta)
        for row in sectionStack.arrangedSubviews { sectionStack.removeArrangedSubview(row); row.removeFromSuperview() }
        for key in sectionOrder { sectionStack.addArrangedSubview(sectionRows[key]!) }
        changed(sender); window?.makeFirstResponder(sender)
    }
    @objc private func undoChange() { TrayPreferenceStore.shared.undo(); reload() }
    @objc private func restore() { _ = TrayPreferenceStore.shared.save(.defaults); reload() }
    @objc private func showExamplePopup() {
        if exampleController == nil {
            let controller = MenuBarPopoverViewController(productName: trayText("example"), brandImage: nil,
                actions: .init(openTiboTattle: {}, refresh: {}, showMore: { _ in }))
            exampleController = controller
            controller.update(snapshot: exampleSnapshot)
            let window = NSWindow(contentViewController: controller)
            window.styleMask = [.titled, .closable]; window.isReleasedWhenClosed = false
            window.title = trayText("example"); exampleWindow = window
        }
        exampleController?.update(snapshot: exampleSnapshot)
        exampleWindow?.center(); exampleWindow?.makeKeyAndOrderFront(nil)
    }

    func renderExample(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua, .accessibilityHighContrastAqua] {
            window?.contentView?.appearance = NSAppearance(named: appearance)
            window?.contentView?.layoutSubtreeIfNeeded()
            guard let scroll = window?.contentViewController?.view as? NSScrollView,
                  let document = scroll.documentView, let view = window?.contentView else { continue }
            document.layoutSubtreeIfNeeded()
            let maximum = max(0, document.bounds.height - scroll.contentView.bounds.height)
            for (suffix, offset) in [("", CGFloat(0)), ("-bottom", maximum)] {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: offset))
                scroll.reflectScrolledClipView(scroll.contentView)
                view.needsDisplay = true; view.displayIfNeeded()
                guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) { try data.write(to: directory.appendingPathComponent("settings-" + appearance.rawValue + suffix + ".png")) }
            }
        }
        try renderMeterContactSheets(to: directory)
        for state in ["current", "refreshing", "partial", "stale", "offline", "exhausted"] {
            previewState = state; reload()
            let controller = MenuBarPopoverViewController(productName: trayText("example"), brandImage: nil, actions: .init(openTiboTattle: {}, refresh: {}, showMore: { _ in }))
            controller.update(snapshot: exampleSnapshot)
            try controller.renderPNG(to: directory.appendingPathComponent("popup-" + state + ".png"), appearance: .aqua)
        }
        previewState = "current"; reload()
        let customized = MenuBarPopoverViewController(productName: trayText("example"), brandImage: nil, actions: .init(openTiboTattle: {}, refresh: {}, showMore: { _ in }))
        var custom = TrayPreferences.defaults; custom.sections = ["cache", "usage", "allowances", "pace"]
        customized.update(snapshot: exampleSnapshot)
        customized.applyPreferencesForSmokeTest(custom)
        try customized.renderPNG(to: directory.appendingPathComponent("popup-custom-all-sections.png"), appearance: .aqua)
        custom.density = "compact"; custom.showChart = false; custom.metrics = ["cost"]; custom.historyRange = "30d"
        customized.applyPreferencesForSmokeTest(custom)
        try customized.renderPNG(to: directory.appendingPathComponent("popup-custom-compact-cost-only.png"), appearance: .darkAqua)
        custom.sections = ["cache"]
        customized.applyPreferencesForSmokeTest(custom)
        try customized.renderPNG(to: directory.appendingPathComponent("popup-custom-cache-only-30d.png"), appearance: .aqua)
    }

    private func renderMeterContactSheets(to directory: URL) throws {
        let now = Date()
        for appearanceName in [NSAppearance.Name.aqua, .darkAqua, .accessibilityHighContrastAqua] {
            guard let appearance = NSAppearance(named: appearanceName) else { continue }
            let sheet = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 210))
            sheet.appearance = appearance; sheet.wantsLayer = true
            appearance.performAsCurrentDrawingAppearance { sheet.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
            for (index, sample) in ["0%", "50%", "100%", "5h unavailable", "Both unavailable"].enumerated() {
                let y = CGFloat(170 - index * 34)
                let label = NSTextField(labelWithString: sample)
                label.frame = NSRect(x: 12, y: y, width: 160, height: 20)
                sheet.addSubview(label)
                var snapshot = MenuBarStatusSnapshot(); snapshot.phase = .ready; snapshot.evidence = .live
                let percent = Double(index == 0 ? 0 : index == 2 ? 100 : 50)
                snapshot.lanes = [300, 10_080].compactMap { minutes in
                    if index == 4 || (index == 3 && minutes == 300) { return nil }
                    return ObservedQuotaLane(label: minutes == 300 ? "5h" : "7d", remainingPercent: percent, durationMinutes: minutes, resetAt: now.addingTimeInterval(3600), observedAt: now, isPrimary: minutes == 300)
                }
                var preferences = TrayPreferences.defaults; preferences.iconMode = "dual-meter"
                let icon = NSImageView(frame: NSRect(x: 190, y: y, width: 16, height: 16))
                icon.imageScaling = .scaleNone; icon.contentTintColor = .labelColor
                icon.image = MenuBarStatusController.trayImage(preferences, snapshot: snapshot, now: now)
                sheet.addSubview(icon)
            }
            for scale in [1, 2] {
                guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 260 * scale, pixelsHigh: 210 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
                rep.size = sheet.bounds.size
                sheet.cacheDisplay(in: sheet.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) { try data.write(to: directory.appendingPathComponent("dual-meter-" + appearanceName.rawValue + "-" + String(scale) + "x.png")) }
            }
        }
    }

    private func updatePreview() {
        let now = Date(); var snapshot = MenuBarStatusSnapshot()
        snapshot.observedAt = now
        snapshot.phase = previewState == "offline" ? .unavailable : previewState == "refreshing" ? .analyzing : .ready
        snapshot.evidence = previewState == "stale" ? .stale : .live
        snapshot.lanes = [(300, previewState == "exhausted" ? 0.0 : 63.0), (10_080, 94.0)].compactMap { minutes, percent in
            if previewState == "partial" && minutes == 300 { return nil }
            return ObservedQuotaLane(label: minutes == 300 ? "5h" : "7d", remainingPercent: percent, durationMinutes: minutes, resetAt: now.addingTimeInterval(minutes == 300 ? 2520 : 172800), observedAt: now, isPrimary: minutes == 300)
        }
        let coverage = MenuBarPricingCoverage(fullyPricedEvents: 8, partiallyPricedEvents: 1, unpricedEvents: 1)
        let days = (0..<30).map { day in
            MenuBarHistoryDay(startAt: now.addingTimeInterval(Double(day - 30) * 86400), endAt: now.addingTimeInterval(Double(day - 29) * 86400), evidence: .partial, usageEvents: 10, totalTokens: 4000, knownAPIPriceEquivalentUSD: 0.02, pricingCoverage: coverage)
        }
        snapshot.history = MenuBarHistorySnapshot(accountingStatus: previewState == "offline" ? .unavailable : previewState == "refreshing" ? .retained : .current, last24Hours: nil,
            lastSevenDays: MenuBarRollingPeriod(window: .lastSevenDays, events: 70, totalTokens: 28000, knownAPIPriceEquivalentUSD: 0.14, pricingCoverage: coverage),
            lastThirtyDays: MenuBarRollingPeriod(window: .lastThirtyDays, events: 300, totalTokens: 120000, knownAPIPriceEquivalentUSD: 0.60, pricingCoverage: coverage),
            sevenDayHistory: Array(days.suffix(7)), thirtyDayHistory: days,
            trayCachePeriods: [TrayCachePeriod(periodID: "7d", reusePercent: 60, comparableReturns: 10, coverage: "incomplete"), TrayCachePeriod(periodID: "30d", reusePercent: 60, comparableReturns: 20, coverage: "incomplete")])
        exampleSnapshot = snapshot
        exampleController?.update(snapshot: snapshot, now: now)
        let p = TrayPreferenceStore.shared.value
        previewIcon.image = MenuBarStatusController.trayImage(p, snapshot: snapshot, now: now)
        let title = TrayPresentation.title(p, snapshot: snapshot, now: now)
        let ordered = p.sections.map(trayText).joined(separator: " → ")
        preview.stringValue = "\(trayText("example")): \(title.isEmpty ? trayText("icon-only") : title)\n\(trayText(previewState)) · \(trayText(p.iconMode))\n\(ordered.isEmpty ? trayText("empty") : ordered)\n\(trayText(p.historyRange)) · \(trayText(p.density)) · \(p.metrics.map { trayText("metric-" + $0) }.joined(separator: ", "))"
    }
}

func trayText(_ key: String) -> String {
    let keys: [String: TiboTattleLocalization.Key] = [
        "menuBar": .trayMenuBar,
        "beside": .trayBeside,
        "opened": .trayOpened,
        "preset": .trayPreset,
        "automatic": .trayAutomatic,
        "five-hour": .trayFiveHour,
        "weekly": .trayWeekly,
        "both": .trayBoth,
        "icon-only": .trayIconOnly,
        "iconMode": .trayIconMode,
        "app": .trayApp,
        "meter": .trayMeter,
        "dual-meter": .trayDualMeter,
        "meterWindow": .trayMeterWindow,
        "barMetric": .trayBarMetric,
        "remaining": .trayRemaining,
        "reset": .trayReset,
        "remaining-reset": .trayRemainingReset,
        "resetFormat": .trayResetFormat,
        "countdown": .trayCountdown,
        "clock": .trayClock,
        "emphasizeLow": .trayEmphasizeLow,
        "example": .trayExample,
        "current": .trayCurrent,
        "refreshing": .trayRefreshing,
        "partial": .trayPartial,
        "stale": .trayStale,
        "offline": .trayOffline,
        "exhausted": .trayExhausted,
        "allowances": .trayAllowances,
        "pace": .trayPace,
        "usage": .trayUsage,
        "cache": .trayCache,
        "historyRange": .trayHistoryRange,
        "7d": .tray7d,
        "30d": .tray30d,
        "showChart": .trayShowChart,
        "metric-tokens": .trayMetricTokens,
        "metric-cost": .trayMetricCost,
        "metric-changes": .trayMetricChanges,
        "density": .trayDensity,
        "comfortable": .trayComfortable,
        "compact": .trayCompact,
        "undo": .trayUndo,
        "restore": .trayRestore,
        "moveUp": .trayMoveUp,
        "moveDown": .trayMoveDown,
        "empty": .trayEmpty,
        "at": .trayAt,
        "in": .trayIn,
        "protected": .trayProtected,
        "invalid": .trayInvalid,
        "saveFailed": .traySaveFailed,
        "customize": .trayCustomize,
        "low": .trayLow,
        "cacheUnavailable": .trayCacheUnavailable,
        "cacheEmpty": .trayCacheEmpty,
        "cacheCaption": .trayCacheCaption,
        "cacheIncomplete": .trayCacheIncomplete,
    ]
    return keys[key].map(TiboTattleLocalization.string) ?? key
}

/// Compiled regression cases use only synthetic values and a temporary store.
@MainActor
enum TrayCustomizationSmoke {
    static func run() -> Int32 {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tray-contract-" + UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = TrayPreferenceStore()
            store.configure(directory: root, existingInstall: false)
            guard store.value == .defaults else { return 1 }
            var p = store.value; p.preset = "both"; p.sections = ["usage", "allowances"]
            guard store.save(p), store.value == p else { return 2 }
            let reopened = TrayPreferenceStore(); reopened.configure(directory: root, existingInstall: true)
            guard reopened.value == p else { return 3 }
            store.undo(); guard store.value == .defaults else { return 4 }
            p.sections = ["usage"]; p.showChart = false; p.metrics = []
            guard !store.save(p), store.value == .defaults else { return 5 }
            var invalid = TrayPreferences.defaults; invalid.sections = ["pace", "pace"]
            guard !invalid.valid, TrayPreferences.legacy("off")?.iconMode == "app" else { return 6 }
            let encoded = try JSONEncoder().encode(TrayPreferences.defaults)
            var object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
            object.removeValue(forKey: "showChart")
            guard TrayPreferences.decode(try JSONSerialization.data(withJSONObject: object)) == nil else { return 20 }
            object["showChart"] = 1
            guard TrayPreferences.decode(try JSONSerialization.data(withJSONObject: object)) == nil else { return 21 }
            object["showChart"] = true; object["unexpected"] = true
            guard TrayPreferences.decode(try JSONSerialization.data(withJSONObject: object)) == nil else { return 22 }
            let failing = TrayPreferenceStore()
            failing.configure(directory: root.appendingPathComponent("missing/child"), existingInstall: true)
            guard !failing.save(.defaults), failing.value == .upgrade, failing.error != nil else { return 23 }
            for legacy in ["five-hour", "weekly", "both", "off"] {
                guard TrayPreferences.legacy(legacy) != nil else { return 24 }
            }
            let file = root.appendingPathComponent("tray-preferences-v1.json")
            let future = Data("{\"schemaVersion\":2}".utf8)
            try future.write(to: file)
            guard !store.save(.defaults), try Data(contentsOf: file) == future else { return 7 }
            let now = Date(timeIntervalSince1970: 1_700_000_000)
            func lane(_ minutes: Int, _ remaining: Double, _ resetOffset: Double = 3600) -> ObservedQuotaLane {
                ObservedQuotaLane(label: minutes == 300 ? "5h" : "7d", remainingPercent: remaining, durationMinutes: minutes, resetAt: now.addingTimeInterval(resetOffset), observedAt: now, isPrimary: minutes == 300)
            }
            var snapshot = MenuBarStatusSnapshot(); snapshot.phase = .ready; snapshot.evidence = .live
            snapshot.lanes = [lane(300, 63), lane(10_080, 94)]
            p = .defaults; p.preset = "both"
            let current = TrayPresentation.title(p, snapshot: snapshot, now: now)
            guard current.contains("5h"), current.contains("63"), current.contains("7d"), current.contains("94") else { return 8 }
            snapshot.phase = .analyzing
            guard TrayPresentation.title(p, snapshot: snapshot, now: now) == current else { return 9 }
            snapshot.lanes = [lane(10_080, 94)]
            guard TrayPresentation.title(p, snapshot: snapshot, now: now).hasPrefix("5h —") else { return 10 }
            snapshot.lanes = [lane(300, 0), lane(10_080, 100)]
            guard TrayPresentation.lane("five-hour", snapshot: snapshot, now: now)?.remainingPercent == 0 else { return 11 }
            snapshot.lanes.append(lane(300, 1))
            guard TrayPresentation.lane("five-hour", snapshot: snapshot, now: now) == nil else { return 12 }
            snapshot.lanes = [lane(300, 10)]; p.emphasizeLow = true
            var low = TrayLowAllowanceState()
            guard low.update(p, snapshot: snapshot, now: now).contains("five-hour") else { return 13 }
            snapshot.lanes = [lane(300, 11)]
            guard low.update(p, snapshot: snapshot, now: now).contains("five-hour") else { return 14 }
            snapshot.lanes = [lane(300, 12)]
            guard low.update(p, snapshot: snapshot, now: now).isEmpty else { return 15 }
            snapshot.lanes = [lane(300, 9)]; _ = low.update(p, snapshot: snapshot, now: now)
            snapshot.lanes = [ObservedQuotaLane(label: "5h", remainingPercent: 11, durationMinutes: 300,
                resetAt: now.addingTimeInterval(3600), observedAt: now.addingTimeInterval(-1), isPrimary: true)]
            guard low.update(p, snapshot: snapshot, now: now).isEmpty else { return 30 }
            snapshot.lanes = [lane(300, 9)]; _ = low.update(p, snapshot: snapshot, now: now)
            snapshot.evidence = .stale
            guard low.update(p, snapshot: snapshot, now: now).isEmpty else { return 16 }
            guard TrayPresentation.reset(now, format: "countdown", now: now) == nil,
                  TrayPresentation.reset(now.addingTimeInterval(61), format: "countdown", now: now) == "2m" else { return 17 }
            p.preset = "icon-only"
            guard TrayPresentation.title(p, snapshot: snapshot, now: now).isEmpty else { return 18 }
            _ = NSApplication.shared
            let popup = MenuBarPopoverViewController(productName: "Example", brandImage: nil,
                actions: .init(openTiboTattle: {}, refresh: {}, showMore: { _ in }))
            popup.applyPreferencesForSmokeTest(.defaults)
            guard popup.arrangedSectionIDsForSmokeTest() == ["allowances", "pace", "usage"] else { return 25 }
            var layout = TrayPreferences.defaults; layout.sections = []
            popup.applyPreferencesForSmokeTest(layout)
            guard popup.arrangedSectionIDsForSmokeTest().isEmpty else { return 26 }
            layout.sections = ["cache", "usage", "allowances", "pace"]
            popup.applyPreferencesForSmokeTest(layout)
            guard popup.arrangedSectionIDsForSmokeTest() == layout.sections else { return 27 }
            popup.applyPreferencesForSmokeTest(layout)
            guard popup.arrangedSectionIDsForSmokeTest() == layout.sections else { return 28 }
            layout.sections = ["cache"]; layout.historyRange = "30d"
            popup.applyPreferencesForSmokeTest(layout)
            guard popup.cachePeriodLabelForSmokeTest() == TiboTattleLocalization.string(.menuBarPopupPeriodLastThirtyDays) else { return 33 }
            layout.historyRange = "7d"
            popup.applyPreferencesForSmokeTest(layout)
            guard popup.cachePeriodLabelForSmokeTest() == TiboTattleLocalization.string(.menuBarPopupPeriodLastSevenDays) else { return 34 }
            var partlyAvailable = snapshot
            partlyAvailable.phase = .ready; partlyAvailable.evidence = .live
            partlyAvailable.lanes = [lane(10_080, 94)]
            popup.update(snapshot: partlyAvailable, now: now)
            guard popup.unavailableAllowanceDurationsForSmokeTest() == [300] else { return 31 }
            partlyAvailable.lanes = []
            popup.update(snapshot: partlyAvailable, now: now)
            guard popup.unavailableAllowanceDurationsForSmokeTest() == [300, 10_080] else { return 32 }
            let initiallyEmpty = MenuBarPopoverViewController(productName: "Example", brandImage: nil,
                actions: .init(openTiboTattle: {}, refresh: {}, showMore: { _ in }))
            layout.sections = []
            initiallyEmpty.applyPreferencesForSmokeTest(layout)
            guard initiallyEmpty.arrangedSectionIDsForSmokeTest().isEmpty else { return 29 }
            print("TIBOTATTLE_TRAY_CUSTOMIZATION preferences=closed,migrated,future-protected,atomic,undo presets=pinned,dual,unknown,zero refresh=retained low=hysteresis,stale-cleared reset=bounded")
            return 0
        } catch { return 19 }
    }
}
