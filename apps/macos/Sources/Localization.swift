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
        case firstRunLoginItemDisclosure = "firstRun.loginItemDisclosure"
        case settingsContinue = "settings.continue"
        case settingsContinueWithoutLogin = "settings.continueWithoutLogin"
        case settingsDismiss = "settings.dismiss"
        case settingsOpenLoginItems = "settings.openLoginItems"
        case settingsRefreshLoginItemStatus = "settings.refreshLoginItemStatus"
        case settingsRemovePendingLoginItem = "settings.removePendingLoginItem"
        case settingsStartAtLogin = "settings.startAtLogin"
        case settingsStartAtLoginApprovalMessage = "settings.startAtLoginApprovalMessage"
        case settingsStartAtLoginApprovalTitle = "settings.startAtLoginApprovalTitle"
        case settingsStartAtLoginDisabled = "settings.startAtLoginDisabled"
        case settingsStartAtLoginEnabled = "settings.startAtLoginEnabled"
        case settingsStartAtLoginNeedsApproval = "settings.startAtLoginNeedsApproval"
        case settingsStartAtLoginRegistrationErrorMessage = "settings.startAtLoginRegistrationErrorMessage"
        case settingsStartAtLoginRegistrationErrorTitle = "settings.startAtLoginRegistrationErrorTitle"
        case settingsStartAtLoginRegistrationNotConfirmedMessage = "settings.startAtLoginRegistrationNotConfirmedMessage"
        case settingsStartAtLoginRegistrationNotConfirmedTitle = "settings.startAtLoginRegistrationNotConfirmedTitle"
        case settingsStartAtLoginSummary = "settings.startAtLoginSummary"
        case settingsStartAtLoginUnavailable = "settings.startAtLoginUnavailable"
        case settingsStartAtLoginUnavailableMessage = "settings.startAtLoginUnavailableMessage"
        case settingsStartAtLoginUnavailableTitle = "settings.startAtLoginUnavailableTitle"
        case settingsStartAtLoginUnregistrationErrorMessage = "settings.startAtLoginUnregistrationErrorMessage"
        case settingsStartAtLoginUnregistrationErrorTitle = "settings.startAtLoginUnregistrationErrorTitle"
        case settingsStartAtLoginUnregistrationNotConfirmedMessage = "settings.startAtLoginUnregistrationNotConfirmedMessage"
        case settingsStartAtLoginUnregistrationNotConfirmedTitle = "settings.startAtLoginUnregistrationNotConfirmedTitle"
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
                "TiboTattle refreshes local usage while it is open. Start at login is an explicit macOS login-item choice; no LaunchAgent, daemon, privileged helper, or hidden persistent process is used. Raw logs never leave this Mac."
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
            case .firstRunLoginItemDisclosure:
                "By default, first-run setup preselects Start TiboTattle at login. TiboTattle adds a macOS login item only after you click Get Started; it uses no LaunchAgent, daemon, privileged helper, or hidden persistent process."
            case .settingsContinue:
                "Continue"
            case .settingsContinueWithoutLogin:
                "Continue Without Login"
            case .settingsDismiss:
                "OK"
            case .settingsOpenLoginItems:
                "Open Login Items Settings"
            case .settingsRefreshLoginItemStatus:
                "Refresh Login Item Status"
            case .settingsRemovePendingLoginItem:
                "Remove Pending Login Item"
            case .settingsStartAtLogin:
                "Start TiboTattle at login"
            case .settingsStartAtLoginApprovalMessage:
                "macOS has registered TiboTattle, but it still needs your approval. Open System Settings → Login Items and allow TiboTattle."
            case .settingsStartAtLoginApprovalTitle:
                "Approve start at login"
            case .settingsStartAtLoginDisabled:
                "TiboTattle will not start automatically."
            case .settingsStartAtLoginEnabled:
                "TiboTattle starts when you sign in."
            case .settingsStartAtLoginNeedsApproval:
                "macOS needs your approval in System Settings → Login Items."
            case .settingsStartAtLoginRegistrationErrorMessage:
                "macOS did not allow TiboTattle to enable its login item. Open System Settings → Login Items to review the permission."
            case .settingsStartAtLoginRegistrationErrorTitle:
                "Couldn't enable start at login"
            case .settingsStartAtLoginRegistrationNotConfirmedMessage:
                "macOS did not confirm that TiboTattle will start at login. Review System Settings → Login Items before relying on it."
            case .settingsStartAtLoginRegistrationNotConfirmedTitle:
                "Start at login was not confirmed"
            case .settingsStartAtLoginSummary:
                "Start TiboTattle automatically when you sign in. You can change this later in Settings → General."
            case .settingsStartAtLoginUnavailable:
                "Login item status is unavailable. Open System Settings → Login Items."
            case .settingsStartAtLoginUnavailableMessage:
                "macOS did not provide the current Login Item status. Open System Settings → Login Items to review it."
            case .settingsStartAtLoginUnavailableTitle:
                "Login Item status is unavailable"
            case .settingsStartAtLoginUnregistrationErrorMessage:
                "macOS did not allow TiboTattle to disable its login item. Open System Settings → Login Items to review the permission."
            case .settingsStartAtLoginUnregistrationErrorTitle:
                "Couldn't disable start at login"
            case .settingsStartAtLoginUnregistrationNotConfirmedMessage:
                "macOS did not confirm that TiboTattle was removed from Login Items. Review System Settings → Login Items before relying on it."
            case .settingsStartAtLoginUnregistrationNotConfirmedTitle:
                "Removal from login was not confirmed"
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
