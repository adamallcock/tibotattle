import Foundation

/// The native localization boundary for TiboTattle.
///
/// The app intentionally has no language override yet. `Bundle` follows the
/// macOS preferred-language list, while `Locale.current` keeps dates and
/// numbers in the user's regional format even when the selected translation
/// falls back to English. The same key namespace and `.lproj` resources are
/// staged under the embedded dashboard's web root by the macOS build.
enum TiboTattleLocalization {
    enum Key: String, CaseIterable {
        case menuAboutProduct = "menu.aboutProduct"
        case menuCopy = "menu.copy"
        case menuEdit = "menu.edit"
        case menuQuitProduct = "menu.quitProduct"
        case menuSelectAll = "menu.selectAll"
        case menuSettings = "menu.settings"
        case settingsAboutProduct = "settings.aboutProduct"
        case settingsAboutTab = "settings.aboutTab"
        case settingsAboutSummary = "settings.aboutSummary"
        case settingsAutomaticUpdates = "settings.automaticUpdates"
        case settingsAutomaticUpdatesOff = "settings.automaticUpdatesOff"
        case settingsAutomaticUpdatesOn = "settings.automaticUpdatesOn"
        case settingsAutomaticUpdatesUnavailable = "settings.automaticUpdatesUnavailable"
        case settingsAutomaticUpdatesTooltip = "settings.automaticUpdatesTooltip"
        case settingsCheckForUpdates = "settings.checkForUpdates"
        case settingsChooseCodexFolder = "settings.chooseCodexFolder"
        case settingsCodexFolder = "settings.codexFolder"
        case settingsCodexFolderSummary = "settings.codexFolderSummary"
        case settingsGeneral = "settings.general"
        case settingsGeneralSummary = "settings.generalSummary"
        case settingsGitHub = "settings.github"
        case settingsLanguage = "settings.language"
        case settingsLanguageSummary = "settings.languageSummary"
        case settingsLanguageSystem = "settings.languageSystem"
        case settingsOpenDashboard = "settings.openDashboard"
        case settingsPreviewUpdatesPending = "settings.previewUpdatesPending"
        case settingsPreviewUpdatesPendingMessage = "settings.previewUpdatesPendingMessage"
        case settingsPreviewUpdatesPendingTitle = "settings.previewUpdatesPendingTitle"
        case settingsUseDefault = "settings.useDefault"
        case settingsVersion = "settings.version"
        case settingsWebsite = "settings.website"
        case settingsWindowTitle = "settings.windowTitle"
        case settingsX = "settings.x"

        /// English remains a process-local fallback if a bundle is unpacked
        /// without its resources or a future translation misses one key.
        var fallbackValue: String {
            switch self {
            case .menuAboutProduct:
                "About %@"
            case .menuCopy:
                "Copy"
            case .menuEdit:
                "Edit"
            case .menuQuitProduct:
                "Quit %@"
            case .menuSelectAll:
                "Select All"
            case .menuSettings:
                "Settings…"
            case .settingsAboutProduct:
                "About %@"
            case .settingsAboutTab:
                "About"
            case .settingsAboutSummary:
                "Local Codex allowance, measured on your Mac."
            case .settingsAutomaticUpdates:
                "Automatic updates"
            case .settingsAutomaticUpdatesOff:
                "Automatic updates are off. You can still check for updates manually."
            case .settingsAutomaticUpdatesOn:
                "Verified updates download automatically and install when you quit."
            case .settingsAutomaticUpdatesUnavailable:
                "Updates are available in signed releases installed in Applications."
            case .settingsAutomaticUpdatesTooltip:
                "Download signed TiboTattle updates automatically."
            case .settingsCheckForUpdates:
                "Check for Updates"
            case .settingsChooseCodexFolder:
                "Choose Codex Folder…"
            case .settingsCodexFolder:
                "Codex folder"
            case .settingsCodexFolderSummary:
                "TiboTattle reads only the sessions and archived_sessions folders below this location. Use the default unless your Codex data lives somewhere else."
            case .settingsGeneral:
                "General"
            case .settingsGeneralSummary:
                "TiboTattle refreshes local usage while it is open. It does not install a login item, LaunchAgent, or daemon; raw logs never leave this Mac."
            case .settingsGitHub:
                "GitHub"
            case .settingsLanguage:
                "Language"
            case .settingsLanguageSummary:
                "Uses the Mac language when available; regional formats follow this Mac."
            case .settingsLanguageSystem:
                "System"
            case .settingsOpenDashboard:
                "Open Dashboard"
            case .settingsPreviewUpdatesPending:
                "This preview uses the live TiboTattle update feed. The first signed release has not been published yet, so updates cannot be discovered."
            case .settingsPreviewUpdatesPendingMessage:
                "This preview is connected to the live TiboTattle service, but the signed update feed has not been published yet. Local analysis is unaffected. Check again after a signed release is available."
            case .settingsPreviewUpdatesPendingTitle:
                "Updates aren't published yet"
            case .settingsUseDefault:
                "Use Default"
            case .settingsVersion:
                "Version %@ (%@)"
            case .settingsWebsite:
                "TiboTattle website"
            case .settingsWindowTitle:
                "TiboTattle Settings"
            case .settingsX:
                "X / Twitter"
            }
        }
    }

    static let fallbackLocalization = "en"
    static let tableName = "Localizable"

    /// Formatting is deliberately independent from translation fallback. A
    /// French system with only English resources still receives French date,
    /// number, decimal, and grouping conventions.
    static var locale: Locale {
        .current
    }

    static func string(_ key: Key) -> String {
        let selected = localizedBundle()
        let localized = selected.localizedString(
            forKey: key.rawValue,
            value: nil,
            table: tableName
        )
        if usable(localized, for: key) {
            return localized
        }

        if let english = englishBundle() {
            let fallback = english.localizedString(
                forKey: key.rawValue,
                value: nil,
                table: tableName
            )
            if usable(fallback, for: key) {
                return fallback
            }
        }
        return key.fallbackValue
    }

    static func format(_ key: Key, _ arguments: CVarArg...) -> String {
        String(format: string(key), locale: locale, arguments: arguments)
    }

    static func decimalNumberFormatter(
        maximumFractionDigits: Int = 2
    ) -> NumberFormatter {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = max(0, maximumFractionDigits)
        return formatter
    }

    static func dateFormatter(
        dateStyle: DateFormatter.Style = .medium,
        timeStyle: DateFormatter.Style = .short
    ) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateStyle = dateStyle
        formatter.timeStyle = timeStyle
        return formatter
    }

    private static func localizedBundle() -> Bundle {
        let available = Bundle.main.localizations.filter { $0 != "Base" }
        let preferred = Bundle.preferredLocalizations(
            from: available,
            forPreferences: Locale.preferredLanguages
        ).first ?? fallbackLocalization
        return bundle(for: preferred) ?? englishBundle() ?? Bundle.main
    }

    private static func englishBundle() -> Bundle? {
        bundle(for: fallbackLocalization)
    }

    private static func bundle(for localization: String) -> Bundle? {
        guard let path = Bundle.main.path(
            forResource: localization,
            ofType: "lproj"
        ) else {
            return nil
        }
        return Bundle(path: path)
    }

    private static func usable(_ value: String, for key: Key) -> Bool {
        !value.isEmpty && value != key.rawValue
    }
}
