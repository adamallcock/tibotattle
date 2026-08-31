import Foundation

/// Provider-reported Codex windows are useful evidence only when their
/// duration is a safe, bounded whole number. The bound is deliberately a
/// duration bound, not a plan or calendar interpretation.
enum CodexQuotaWindowDuration {
    static let fiveHourMinutes = 300
    static let sevenDayMinutes = 10_080
    static let maximumMinutes = 525_600

    static func isValid(_ value: Int) -> Bool {
        (1...maximumMinutes).contains(value)
    }

    /// JSONSerialization bridges numbers through NSNumber. Do not use
    /// `intValue` directly: it truncates fractional values before validation.
    static func integer(from value: Any?) -> Int? {
        guard let number = value as? NSNumber, !(value is Bool) else {
            return nil
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue.rounded(.towardZero) == doubleValue,
              doubleValue >= Double(Int.min),
              doubleValue <= Double(Int.max)
        else {
            return nil
        }
        let integerValue = number.intValue
        guard Double(integerValue) == doubleValue else { return nil }
        return integerValue
    }
}

/// The native localization boundary for TiboTattle.
///
/// Translation choice and regional formatting are deliberately separate:
/// changing the app language never changes a displayed event's time zone,
/// decimal separator policy, currency, accounting arithmetic, or source
/// provenance. `Locale.current` remains the formatting authority while the
/// selected `.lproj` controls only product copy.
enum TiboTattleLocalization {
    static let schemaVersion = "tibotattle-localization-v2"
    static let fallbackLocalization = "en"
    static let fallbackLocale = "en-US"
    static let tableName = "Localizable"
    static let supportedWebLocales = ["en-US", "zh-Hans", "es"]
    static let languagePreferenceDefaultsKey =
        "tibotattle.language-preference.v1"

    enum LanguagePreference: String, CaseIterable {
        case system
        case english = "en-US"
        case simplifiedChinese = "zh-Hans"
        case spanish = "es"

        var nativeLocalization: String? {
            switch self {
            case .system:
                nil
            case .english:
                "en"
            case .simplifiedChinese:
                "zh-Hans"
            case .spanish:
                "es"
            }
        }
    }

    enum Key: String, CaseIterable {
        case accessibilityLocalDashboard = "accessibility.localDashboard"
        case accessibilityMenuBarStatus = "accessibility.menuBarStatus"
        case commonCancel = "common.cancel"
        case commonContinue = "common.continue"
        case commonOK = "common.ok"
        case dialogChooseCodexHomeFolder = "dialog.chooseCodexHomeFolder"
        case dialogChooseCodexHomeFolderMessage = "dialog.chooseCodexHomeFolderMessage"
        case dialogCodexFolderDescription = "dialog.codexFolderDescription"
        case dialogCopyDiagnostics = "dialog.copyDiagnostics"
        case dialogCustomCodexFolder = "dialog.customCodexFolder"
        case dialogDataAndDiagnostics = "dialog.dataAndDiagnostics"
        case dialogDefaultCodexFolder = "dialog.defaultCodexFolder"
        case dialogDiagnosticsCopied = "dialog.diagnosticsCopied"
        case dialogDiagnosticsCopiedDetail = "dialog.diagnosticsCopiedDetail"
        case dialogDone = "dialog.done"
        case dialogEraseLocalData = "dialog.eraseLocalData"
        case dialogIdentityDeviceReset = "dialog.identityDeviceReset"
        case dialogIdentityDeviceResetComplete = "dialog.identityDeviceResetComplete"
        case dialogIdentityDeviceResetCompleteDescription = "dialog.identityDeviceResetCompleteDescription"
        case dialogIdentityDeviceResetDescription = "dialog.identityDeviceResetDescription"
        case dialogLocalAppData = "dialog.localAppData"
        case dialogLocalAppDataDescription = "dialog.localAppDataDescription"
        case dialogManageData = "dialog.manageData"
        case dialogManageLocalData = "dialog.manageLocalData"
        case dialogManageLocalDataDescription = "dialog.manageLocalDataDescription"
        case dialogMoveDataToTrash = "dialog.moveDataToTrash"
        case dialogMoveLocalDataToTrash = "dialog.moveLocalDataToTrash"
        case dialogMoveLocalDataToTrashDescription = "dialog.moveLocalDataToTrashDescription"
        case dialogResetCapabilities = "dialog.resetCapabilities"
        case dialogResetCapabilitiesDescription = "dialog.resetCapabilitiesDescription"
        case dialogResetFinishing = "dialog.resetFinishing"
        case dialogResetFinishingDescription = "dialog.resetFinishingDescription"
        case dialogResetIdentityDevice = "dialog.resetIdentityDevice"
        case dialogResetLocalIdentity = "dialog.resetLocalIdentity"
        case dialogShowLocalData = "dialog.showLocalData"
        case dialogUseThisFolder = "dialog.useThisFolder"
        case launcherCompanionUnavailable = "launcher.companionUnavailable"
        case launcherCouldNotStart = "launcher.couldNotStart"
        case launcherCodexFolderUpdated = "launcher.codexFolderUpdated"
        case launcherDataDiagnostics = "launcher.dataDiagnostics"
        case launcherDashboardDidNotOpen = "launcher.dashboardDidNotOpen"
        case launcherDashboardTakingLonger = "launcher.dashboardTakingLonger"
        case launcherDetailPreparingLocalDashboard = "launcher.detailPreparingLocalDashboard"
        case launcherErrorCompanionAlreadyRunning = "launcher.errorCompanionAlreadyRunning"
        case launcherErrorCompanionExited = "launcher.errorCompanionExited"
        case launcherErrorCompanionLaunch = "launcher.errorCompanionLaunch"
        case launcherErrorCompanionTimeout = "launcher.errorCompanionTimeout"
        case launcherErrorCodexHomeSettingsWrite = "launcher.errorCodexHomeSettingsWrite"
        case launcherErrorDashboardContentProcessTerminated = "launcher.errorDashboardContentProcessTerminated"
        case launcherErrorDashboardDownloadFailed = "launcher.errorDashboardDownloadFailed"
        case launcherErrorDashboardNavigationFailed = "launcher.errorDashboardNavigationFailed"
        case launcherErrorDashboardReadinessTimeout = "launcher.errorDashboardReadinessTimeout"
        case launcherErrorDashboardViewportUnavailable = "launcher.errorDashboardViewportUnavailable"
        case launcherErrorDashboardWebViewUnavailable = "launcher.errorDashboardWebViewUnavailable"
        case launcherErrorDataErase = "launcher.errorDataErase"
        case launcherErrorFirstRunStateWrite = "launcher.errorFirstRunStateWrite"
        case launcherErrorHealthCheck = "launcher.errorHealthCheck"
        case launcherErrorInvalidCentralService = "launcher.errorInvalidCentralService"
        case launcherErrorInvalidCodexHome = "launcher.errorInvalidCodexHome"
        case launcherErrorInvalidCodexHomeSettings = "launcher.errorInvalidCodexHomeSettings"
        case launcherErrorInvalidFirstRunState = "launcher.errorInvalidFirstRunState"
        case launcherErrorInvalidHome = "launcher.errorInvalidHome"
        case launcherErrorInvalidResource = "launcher.errorInvalidResource"
        case launcherErrorInvalidStateDirectory = "launcher.errorInvalidStateDirectory"
        case launcherErrorKeychainDenied = "launcher.errorKeychainDenied"
        case launcherErrorKeychainLocked = "launcher.errorKeychainLocked"
        case launcherErrorKeychainReset = "launcher.errorKeychainReset"
        case launcherErrorKeychainResetPartial = "launcher.errorKeychainResetPartial"
        case launcherFailureDetails = "launcher.failureDetails"
        case launcherFirstRunDisclosure = "launcher.firstRunDisclosure"
        case launcherGetStarted = "launcher.getStarted"
        case launcherLoadingPrivateDashboard = "launcher.loadingPrivateDashboard"
        case launcherLocalDashboardCouldNotStart = "launcher.localDashboardCouldNotStart"
        case launcherLocalDataMovedToTrash = "launcher.localDataMovedToTrash"
        case launcherLocalDataMovedToTrashDetail = "launcher.localDataMovedToTrashDetail"
        case launcherMovingLocalDataToTrash = "launcher.movingLocalDataToTrash"
        case launcherMovingLocalDataToTrashDetail = "launcher.movingLocalDataToTrashDetail"
        case launcherNeedsAttention = "launcher.needsAttention"
        case launcherNoAllowanceObserved = "launcher.noAllowanceObserved"
        case launcherNothingSaved = "launcher.nothingSaved"
        case launcherOpenBrowserTooltip = "launcher.openBrowserTooltip"
        case launcherOpenInBrowser = "launcher.openInBrowser"
        case launcherOpeningDashboard = "launcher.openingDashboard"
        case launcherPreparingLocalView = "launcher.preparingLocalView"
        case launcherPrivacyForegroundOnly = "launcher.privacyForegroundOnly"
        case launcherRetry = "launcher.retry"
        case launcherRecoveryCheckAccess = "launcher.recoveryCheckAccess"
        case launcherRecoveryChooseCodexHome = "launcher.recoveryChooseCodexHome"
        case launcherRecoveryDashboardDownload = "launcher.recoveryDashboardDownload"
        case launcherRecoveryDashboardWebView = "launcher.recoveryDashboardWebView"
        case launcherRecoveryDataErase = "launcher.recoveryDataErase"
        case launcherRecoveryExistingWindow = "launcher.recoveryExistingWindow"
        case launcherRecoveryKeychainDenied = "launcher.recoveryKeychainDenied"
        case launcherRecoveryKeychainLocked = "launcher.recoveryKeychainLocked"
        case launcherRecoveryMoveAppState = "launcher.recoveryMoveAppState"
        case launcherRecoveryReinstall = "launcher.recoveryReinstall"
        case launcherRecoveryReset = "launcher.recoveryReset"
        case launcherRecoveryRetryDiagnostics = "launcher.recoveryRetryDiagnostics"
        case launcherRestartingLocalCompanion = "launcher.restartingLocalCompanion"
        case launcherResettingLocalIdentity = "launcher.resettingLocalIdentity"
        case launcherResettingLocalIdentityDetail = "launcher.resettingLocalIdentityDetail"
        case launcherStartingLocally = "launcher.startingLocally"
        case launcherUpdateUnavailable = "launcher.updateUnavailable"
        case launcherUpdatingAutomatically = "launcher.updatingAutomatically"
        case launcherUpdatingLocalUsage = "launcher.updatingLocalUsage"
        case launcherUpdatingLocalUsageContribution = "launcher.updatingLocalUsageContribution"
        case launcherUpToDate = "launcher.upToDate"
        case launcherWelcome = "launcher.welcome"
        case nativeDashboardAllowance = "nativeDashboard.allowance"
        case nativeDashboardCommunity = "nativeDashboard.community"
        case nativeDashboardCurrentEvidenceTooltip = "nativeDashboard.currentEvidenceTooltip"
        case nativeDashboardDataPrivacy = "nativeDashboard.dataPrivacy"
        case nativeDashboardFresh = "nativeDashboard.fresh"
        case nativeDashboardHowItWorks = "nativeDashboard.howItWorks"
        case nativeDashboardNeedsRefresh = "nativeDashboard.needsRefresh"
        case nativeDashboardLocalOnly = "nativeDashboard.localOnly"
        case nativeDashboardLocalOnlyTooltip = "nativeDashboard.localOnlyTooltip"
        case nativeDashboardOverview = "nativeDashboard.overview"
        case nativeDashboardProgressAccounting = "nativeDashboard.progressAccounting"
        case nativeDashboardProgressAnalyzing = "nativeDashboard.progressAnalyzing"
        case nativeDashboardProgressAnalyzingFiles = "nativeDashboard.progressAnalyzingFiles"
        case nativeDashboardProgressArchiveIndex = "nativeDashboard.progressArchiveIndex"
        case nativeDashboardProgressDiscovering = "nativeDashboard.progressDiscovering"
        case nativeDashboardProgressFinishing = "nativeDashboard.progressFinishing"
        case nativeDashboardProgressProspective = "nativeDashboard.progressProspective"
        case nativeDashboardProgressQuickResult = "nativeDashboard.progressQuickResult"
        case nativeDashboardProgressQuotaRefresh = "nativeDashboard.progressQuotaRefresh"
        case nativeDashboardProgressSaving = "nativeDashboard.progressSaving"
        case nativeDashboardRefreshUsage = "nativeDashboard.refreshUsage"
        case nativeDashboardRefreshUsageTooltip = "nativeDashboard.refreshUsageTooltip"
        case nativeDashboardShare = "nativeDashboard.share"
        case nativeDashboardShareTooltip = "nativeDashboard.shareTooltip"
        case nativeDashboardStarting = "nativeDashboard.starting"
        case nativeDashboardStatus = "nativeDashboard.status"
        case nativeDashboardTrends = "nativeDashboard.trends"
        case nativeDashboardUpdating = "nativeDashboard.updating"
        case nativeDashboardHideSidebar = "nativeDashboard.hideSidebar"
        case nativeDashboardShowSidebar = "nativeDashboard.showSidebar"
        case menuAboutProduct = "menu.aboutProduct"
        case menuCopy = "menu.copy"
        case menuEdit = "menu.edit"
        case menuView = "menu.view"
        case menuBarAnalyzeLocalUsage = "menuBar.analyzeLocalUsage"
        case menuBarAnalysisRequestRejected = "menuBar.analysisRequestRejected"
        case menuBarAnalyzingLocalUsage = "menuBar.analyzingLocalUsage"
        case menuBarAllowanceTitle = "menuBar.allowanceTitle"
        case menuBarCompanionNotRunning = "menuBar.companionNotRunning"
        case menuBarCompanionStarting = "menuBar.companionStarting"
        case menuBarCurrentEvidence = "menuBar.currentEvidence"
        case menuBarCurrentEvidenceWithAge = "menuBar.currentEvidenceWithAge"
        case menuBarDaysAgo = "menuBar.daysAgo"
        case menuBarFiveHourAllowance = "menuBar.fiveHourAllowance"
        case menuBarFailureRecovery = "menuBar.failureRecovery"
        case menuBarHoursAgo = "menuBar.hoursAgo"
        case menuBarJustNow = "menuBar.justNow"
        case menuBarLastObservationNotCurrent = "menuBar.lastObservationNotCurrent"
        case menuBarLocalEvidenceStale = "menuBar.localEvidenceStale"
        case menuBarLocalEvidenceStaleWithAge = "menuBar.localEvidenceStaleWithAge"
        case menuBarMinutesAgo = "menuBar.minutesAgo"
        case menuBarNoVerifiedAllowance = "menuBar.noVerifiedAllowance"
        case menuBarNoVerifiedQuota = "menuBar.noVerifiedQuota"
        case menuBarOpenProduct = "menuBar.openProduct"
        case menuBarQuotaEvidenceUnavailable = "menuBar.quotaEvidenceUnavailable"
        case menuBarQuotaLastObserved = "menuBar.quotaLastObserved"
        case menuBarQuotaRemaining = "menuBar.quotaRemaining"
        case menuBarQuotaResetUnavailable = "menuBar.quotaResetUnavailable"
        case menuBarQuotaResets = "menuBar.quotaResets"
        case menuBarQuotaWeeklyPositionResets = "menuBar.quotaWeeklyPositionResets"
        case menuBarQuotaValuesUnavailable = "menuBar.quotaValuesUnavailable"
        case menuBarResetDaysHours = "menuBar.resetDaysHours"
        case menuBarResetHoursMinutes = "menuBar.resetHoursMinutes"
        case menuBarResetMinutes = "menuBar.resetMinutes"
        case menuBarRetryLocalAnalysis = "menuBar.retryLocalAnalysis"
        case menuBarSevenDayAllowance = "menuBar.sevenDayAllowance"
        case menuBarStaleEvidenceHidden = "menuBar.staleEvidenceHidden"
        case menuBarUpdateLocalUsage = "menuBar.updateLocalUsage"
        case menuBarVerifiedAllowanceMany = "menuBar.verifiedAllowanceMany"
        case menuBarVerifiedAllowanceOne = "menuBar.verifiedAllowanceOne"
        case menuBarWaitingToAnalyze = "menuBar.waitingToAnalyze"
        case menuBarPopupHeaderLive = "menuBarPopup.headerLive"
        case menuBarPopupHeaderLiveUpdated = "menuBarPopup.headerLiveUpdated"
        case menuBarPopupHeaderUpdating = "menuBarPopup.headerUpdating"
        case menuBarPopupRemaining = "menuBarPopup.remaining"
        case menuBarPopupResets = "menuBarPopup.resets"
        case menuBarPopupResetUnavailable = "menuBarPopup.resetUnavailable"
        case menuBarPopupWeeklyPosition = "menuBarPopup.weeklyPosition"
        case menuBarPopupPositionElapsed = "menuBarPopup.positionElapsed"
        case menuBarPopupPositionUsed = "menuBarPopup.positionUsed"
        case menuBarPopupPositionBelow = "menuBarPopup.positionBelow"
        case menuBarPopupPositionOn = "menuBarPopup.positionOn"
        case menuBarPopupPositionAbove = "menuBarPopup.positionAbove"
        case menuBarPopupPositionSummary = "menuBarPopup.positionSummary"
        case menuBarPopupPositionDisclaimer = "menuBarPopup.positionDisclaimer"
        case menuBarPopupWeeklyPace = "menuBarPopup.weeklyPace"
        case menuBarPopupPaceCollecting = "menuBarPopup.paceCollecting"
        case menuBarPopupPaceUnder = "menuBarPopup.paceUnder"
        case menuBarPopupPaceOn = "menuBarPopup.paceOn"
        case menuBarPopupPaceOver = "menuBarPopup.paceOver"
        case menuBarPopupPaceCritical = "menuBarPopup.paceCritical"
        case menuBarPopupPaceCollectingDetail = "menuBarPopup.paceCollectingDetail"
        case menuBarPopupPaceRatioOutcome = "menuBarPopup.paceRatioOutcome"
        case menuBarPopupPaceDryBeforeReset = "menuBarPopup.paceDryBeforeReset"
        case menuBarPopupPaceSpareAtReset = "menuBarPopup.paceSpareAtReset"
        case menuBarPopupPaceReachesReset = "menuBarPopup.paceReachesReset"
        case menuBarPopupPaceNow = "menuBarPopup.paceNow"
        case menuBarPopupPaceResetIn = "menuBarPopup.paceResetIn"
        case menuBarPopupPaceEvidenceOne = "menuBarPopup.paceEvidenceOne"
        case menuBarPopupPaceEvidenceMany = "menuBarPopup.paceEvidenceMany"
        case menuBarPopupPaceEarlyEstimate = "menuBarPopup.paceEarlyEstimate"
        case menuBarPopupPaceActiveMarker = "menuBarPopup.paceActiveMarker"
        case menuBarPopupLocalUsage = "menuBarPopup.localUsage"
        case menuBarPopupPeriodLastSevenDays = "menuBarPopup.periodLastSevenDays"
        case menuBarPopupPeriodLastThirtyDays = "menuBarPopup.periodLastThirtyDays"
        case menuBarPopupTokenCount = "menuBarPopup.tokenCount"
        case menuBarPopupUsageChangeOne = "menuBarPopup.usageChangeOne"
        case menuBarPopupUsageChangesMany = "menuBarPopup.usageChangesMany"
        case menuBarPopupUsageSummary = "menuBarPopup.usageSummary"
        case menuBarPopupAPIPriceEquivalent = "menuBarPopup.apiPriceEquivalent"
        case menuBarPopupAPIPriceEquivalentPartial = "menuBarPopup.apiPriceEquivalentPartial"
        case menuBarPopupPartialPricing = "menuBarPopup.partialPricing"
        case menuBarPopupAPIPriceEquivalentUnavailable = "menuBarPopup.apiPriceEquivalentUnavailable"
        case menuBarPopupAPIPriceEquivalentRecalculating = "menuBarPopup.apiPriceEquivalentRecalculating"
        case menuBarPopupPartialPricingDetail = "menuBarPopup.partialPricingDetail"
        case menuBarPopupPartialPricingCaption = "menuBarPopup.partialPricingCaption"
        case menuBarPopupCoverageMixed = "menuBarPopup.coverageMixed"
        case menuBarPopupCoverageAccessible = "menuBarPopup.coverageAccessible"
        case menuBarPopupNotSubscriptionBill = "menuBarPopup.notSubscriptionBill"
        case menuBarPopupAccountingUnavailableTitle = "menuBarPopup.accountingUnavailableTitle"
        case menuBarPopupAccountingUnavailableBody = "menuBarPopup.accountingUnavailableBody"
        case menuBarPopupRetainedHistory = "menuBarPopup.retainedHistory"
        case menuBarPopupNoUsageObserved = "menuBarPopup.noUsageObserved"
        case menuBarPopupStartingTitle = "menuBarPopup.startingTitle"
        case menuBarPopupStartingBody = "menuBarPopup.startingBody"
        case menuBarPopupUpdatingTitle = "menuBarPopup.updatingTitle"
        case menuBarPopupUpdatingBody = "menuBarPopup.updatingBody"
        case menuBarPopupStaleTitle = "menuBarPopup.staleTitle"
        case menuBarPopupStaleBody = "menuBarPopup.staleBody"
        case menuBarPopupErrorTitle = "menuBarPopup.errorTitle"
        case menuBarPopupErrorBody = "menuBarPopup.errorBody"
        case menuBarPopupOpenProduct = "menuBarPopup.openProduct"
        case menuBarPopupRefresh = "menuBarPopup.refresh"
        case menuBarPopupMore = "menuBarPopup.more"
        case menuBarPopupAccessibilityOpenProduct = "menuBarPopup.accessibilityOpenProduct"
        case menuBarPopupAccessibilityRefresh = "menuBarPopup.accessibilityRefresh"
        case menuBarPopupAccessibilityMore = "menuBarPopup.accessibilityMore"
        case menuQuitProduct = "menu.quitProduct"
        case menuSelectAll = "menu.selectAll"
        case menuSettings = "menu.settings"
        case notificationAllowanceThresholdBody = "notification.allowanceThresholdBody"
        case notificationAllowanceTitle = "notification.allowanceTitle"
        case notificationResetBody = "notification.resetBody"
        case notificationResetTitle = "notification.resetTitle"
        case settingsAboutProduct = "settings.aboutProduct"
        case settingsAboutTab = "settings.aboutTab"
        case settingsAboutSummary = "settings.aboutSummary"
        case settingsAppearance = "settings.appearance"
        case settingsAppearanceDark = "settings.appearanceDark"
        case settingsAppearanceLight = "settings.appearanceLight"
        case settingsAppearancePickerHint = "settings.appearancePickerHint"
        case settingsAppearanceSummary = "settings.appearanceSummary"
        case settingsAppearanceSystem = "settings.appearanceSystem"
        case settingsAutomaticUpdates = "settings.automaticUpdates"
        case settingsAutomaticUpdatesOff = "settings.automaticUpdatesOff"
        case settingsAutomaticUpdatesOn = "settings.automaticUpdatesOn"
        case settingsAutomaticUpdatesReachable = "settings.automaticUpdatesReachable"
        case settingsAutomaticUpdatesUnavailable = "settings.automaticUpdatesUnavailable"
        case settingsAutomaticUpdatesTooltip = "settings.automaticUpdatesTooltip"
        case settingsCheckForUpdates = "settings.checkForUpdates"
        case settingsChooseCodexFolder = "settings.chooseCodexFolder"
        case settingsCodexFolder = "settings.codexFolder"
        case settingsCodexFolderCustomSelectedPath = "settings.codexFolderCustomSelectedPath"
        case settingsCodexFolderDefaultLocation = "settings.codexFolderDefaultLocation"
        case settingsCodexFolderSummary = "settings.codexFolderSummary"
        case settingsGeneral = "settings.general"
        case settingsGeneralSummary = "settings.generalSummary"
        case settingsGitHub = "settings.github"
        case settingsLanguage = "settings.language"
        case settingsLanguageEnglish = "settings.languageEnglish"
        case settingsLanguagePickerHint = "settings.languagePickerHint"
        case settingsLanguageSimplifiedChinese = "settings.languageSimplifiedChinese"
        case settingsLanguageSpanish = "settings.languageSpanish"
        case settingsLanguageSummary = "settings.languageSummary"
        case settingsLanguageSystem = "settings.languageSystem"
        case settingsNotifications = "settings.notifications"
        case settingsNotificationsAllowanceTitle = "settings.notificationsAllowanceTitle"
        case settingsNotificationsDetail = "settings.notificationsDetail"
        case settingsNotificationsOff = "settings.notificationsOff"
        case settingsNotificationsPermissionDenied = "settings.notificationsPermissionDenied"
        case settingsNotificationsPermissionUnknown = "settings.notificationsPermissionUnknown"
        case settingsNotificationsReasonInferred = "settings.notificationsReasonInferred"
        case settingsNotificationsReasonLogDerived = "settings.notificationsReasonLogDerived"
        case settingsNotificationsReasonMixedSource = "settings.notificationsReasonMixedSource"
        case settingsNotificationsReasonProviderUnavailable = "settings.notificationsReasonProviderUnavailable"
        case settingsNotificationsReasonRefreshFailed = "settings.notificationsReasonRefreshFailed"
        case settingsNotificationsReasonResetProofMissing = "settings.notificationsReasonResetProofMissing"
        case settingsNotificationsReasonSchemaChanged = "settings.notificationsReasonSchemaChanged"
        case settingsNotificationsReasonStale = "settings.notificationsReasonStale"
        case settingsNotificationsReasonUnknown = "settings.notificationsReasonUnknown"
        case settingsNotificationsReasonUnobserved = "settings.notificationsReasonUnobserved"
        case settingsNotificationsStatusDeliveryUnavailable = "settings.notificationsStatusDeliveryUnavailable"
        case settingsNotificationsStatusDelivered = "settings.notificationsStatusDelivered"
        case settingsNotificationsStatusFirstObservation = "settings.notificationsStatusFirstObservation"
        case settingsNotificationsStatusFreshOnly = "settings.notificationsStatusFreshOnly"
        case settingsNotificationsStatusIneligible = "settings.notificationsStatusIneligible"
        case settingsNotificationsStatusNoCrossing = "settings.notificationsStatusNoCrossing"
        case settingsNotificationsStatusStateUnavailable = "settings.notificationsStatusStateUnavailable"
        case settingsNotificationsStatusWaitingPermission = "settings.notificationsStatusWaitingPermission"
        case settingsNotificationsThresholds = "settings.notificationsThresholds"
        case settingsNotificationsThresholdsEightyAndNinety = "settings.notificationsThresholdsEightyAndNinety"
        case settingsNotificationsThresholdsNinety = "settings.notificationsThresholdsNinety"
        case settingsNotificationsThresholdsOff = "settings.notificationsThresholdsOff"
        case settingsNotificationsToggleTooltip = "settings.notificationsToggleTooltip"
        case settingsNotificationsResetDetail = "settings.notificationsResetDetail"
        case settingsOpenDashboard = "settings.openDashboard"
        case settingsOpenNotifications = "settings.openNotifications"
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
        case settingsRefreshInterval = "settings.refreshInterval"
        case settingsRefreshIntervalDetail = "settings.refreshIntervalDetail"
        case settingsRefreshIntervalOneMinute = "settings.refreshIntervalOneMinute"
        case settingsRefreshIntervalFiveMinutes = "settings.refreshIntervalFiveMinutes"
        case settingsRefreshIntervalFifteenMinutes = "settings.refreshIntervalFifteenMinutes"
        case settingsRefreshIntervalThirtyMinutes = "settings.refreshIntervalThirtyMinutes"
        case settingsUseDefault = "settings.useDefault"
        case settingsUpdateCheckUnavailableMessage = "settings.updateCheckUnavailableMessage"
        case settingsUpdateCheckUnavailableTitle = "settings.updateCheckUnavailableTitle"
        case settingsUpdateDisclosureAutomaticOff = "settings.updateDisclosureAutomaticOff"
        case settingsUpdateDisclosureAutomaticOn = "settings.updateDisclosureAutomaticOn"
        case settingsUpdateDisclosureDevelopment = "settings.updateDisclosureDevelopment"
        case settingsUpdateDisclosurePreview = "settings.updateDisclosurePreview"
        case settingsVersion = "settings.version"
        case settingsWebsite = "settings.website"
        case settingsWindowTitle = "settings.windowTitle"
        case settingsX = "settings.x"

        /// English remains a process-local fallback if a bundle is unpacked
        /// without resources or a future translation misses one key.
        var fallbackValue: String {
            switch self {
            case .accessibilityLocalDashboard:
                "Local dashboard"
            case .accessibilityMenuBarStatus:
                "TiboTattle status"
            case .commonCancel:
                "Cancel"
            case .commonContinue:
                "Continue"
            case .commonOK:
                "OK"
            case .dialogChooseCodexHomeFolder:
                "Choose your Codex home folder"
            case .dialogChooseCodexHomeFolderMessage:
                "Choose the folder that contains Codex sessions or archived_sessions."
            case .dialogCodexFolderDescription:
                "Current: %@\n\n%@ stores a custom folder only in owner-only app settings. Diagnostics never copy its path. This choice controls the sessions and archived_sessions source only; other local refresh sources are disclosed at first run and in the privacy guide."
            case .dialogCopyDiagnostics:
                "Copy Diagnostics"
            case .dialogCustomCodexFolder:
                "Custom Codex folder"
            case .dialogDataAndDiagnostics:
                "%@ data and diagnostics"
            case .dialogDefaultCodexFolder:
                "Default Codex folder (~/.codex)"
            case .dialogDiagnosticsCopied:
                "Diagnostics copied"
            case .dialogDiagnosticsCopiedDetail:
                "Copied fixed lifecycle fields only—no paths, identifiers, or Codex content."
            case .dialogDone:
                "Done"
            case .dialogEraseLocalData:
                "Erase Local Data…"
            case .dialogIdentityDeviceReset:
                "Identity & Device Reset…"
            case .dialogIdentityDeviceResetComplete:
                "Local identity and device reset"
            case .dialogIdentityDeviceResetCompleteDescription:
                "App state: retained, except the targeted local device-binding marker and retired identity residue.\n\nKeychain: the %@ export identity and paired-device credential are now absent. Secure erasure is not claimed.\n\nHosted service: no device was revoked and no data was deleted. Pair this app again before a future contribution and use the hosted privacy workflow separately for hosted deletion."
            case .dialogIdentityDeviceResetDescription:
                "This is a targeted local security-recovery action, not uninstall or hosted deletion.\n\nApp state: indexes, cached analysis, prepared contributions, settings, and Codex logs remain. Only the local device-binding marker and any retired file identity residue are removed.\n\nKeychain: the %@ export identity and paired-device credential are removed. Account-observation and Claude-session pseudonym keys are not targeted.\n\nHosted service: no registered device is revoked and no hosted contribution or result is deleted. Use the hosted privacy workflow separately. Secure erasure is not claimed."
            case .dialogLocalAppData:
                "Local app data"
            case .dialogLocalAppDataDescription:
                "This owner-only Application Support folder contains settings, indexes, cached analysis, prepared contributions, and local device-binding state. It is separate from Codex logs, Keychain, and hosted data."
            case .dialogManageData:
                "Manage Data…"
            case .dialogManageLocalData:
                "Manage local %@ data"
            case .dialogManageLocalDataDescription:
                "Local app state, local Keychain capabilities, and hosted data are separate. Choose the exact layer you intend to manage."
            case .dialogMoveDataToTrash:
                "Move Data to Trash"
            case .dialogMoveLocalDataToTrash:
                "Move all local %@ data to Trash?"
            case .dialogMoveLocalDataToTrashDescription:
                "App state: local indexes, cached analysis, prepared contributions, custom Codex settings, local device-binding state, and TiboTattle sign-in/session state are cleared. Files move to Trash.\n\nKeychain: pseudonymous identity and device credentials remain.\n\nHosted service: sent community data and registered devices remain. Codex logs are never changed."
            case .dialogResetCapabilities:
                "Reset exactly two local Keychain capabilities now?"
            case .dialogResetCapabilitiesDescription:
                "%@ will stop its foreground companion, remove its export identity and paired-device credential from Keychain, remove only their two local residue files, and then restart.\n\nExisting prepared or hosted data will not be rewritten or deleted. Future contribution activity will use a new identity and require device pairing again."
            case .dialogResetFinishing:
                "Local identity reset is finishing"
            case .dialogResetFinishingDescription:
                "Wait for this short Keychain transaction to finish, then quit."
            case .dialogResetIdentityDevice:
                "Reset local identity and device?"
            case .dialogResetLocalIdentity:
                "Reset Local Identity"
            case .dialogShowLocalData:
                "Show Local Data"
            case .dialogUseThisFolder:
                "Use This Folder"
            case .launcherCompanionUnavailable:
                "Local companion unavailable"
            case .launcherCouldNotStart:
                "Couldn’t start"
            case .launcherCodexFolderUpdated:
                "Codex folder updated"
            case .launcherDataDiagnostics:
                "Data & Diagnostics…"
            case .launcherDashboardDidNotOpen:
                "Dashboard didn’t open"
            case .launcherDashboardTakingLonger:
                "Dashboard is taking longer than expected"
            case .launcherDetailPreparingLocalDashboard:
                "Preparing the private local dashboard and its bounded foreground update."
            case .launcherErrorCompanionAlreadyRunning:
                "Another %@ window is already using this Mac's local data."
            case .launcherErrorCompanionExited:
                "The local companion stopped before it became ready."
            case .launcherErrorCompanionLaunch:
                "The local companion could not be started."
            case .launcherErrorCompanionTimeout:
                "The local companion did not become ready in time."
            case .launcherErrorCodexHomeSettingsWrite:
                "The selected Codex folder could not be saved privately."
            case .launcherErrorDashboardContentProcessTerminated:
                "The macOS web content process stopped while opening the local dashboard."
            case .launcherErrorDashboardDownloadFailed:
                "The dashboard could not save that file to your Downloads folder."
            case .launcherErrorDashboardNavigationFailed:
                "The in-app dashboard could not load its local page."
            case .launcherErrorDashboardReadinessTimeout:
                "The local dashboard page loaded, but it did not become ready during the initial wait."
            case .launcherErrorDashboardViewportUnavailable:
                "The in-app dashboard did not receive a usable window size."
            case .launcherErrorDashboardWebViewUnavailable:
                "The in-app dashboard view could not be displayed."
            case .launcherErrorDataErase:
                "The local %@ data could not be moved to Trash."
            case .launcherErrorFirstRunStateWrite:
                "The first-run acknowledgement could not be saved privately."
            case .launcherErrorHealthCheck:
                "The local companion health check failed."
            case .launcherErrorInvalidCentralService:
                "The bundled community-service connection is invalid."
            case .launcherErrorInvalidCodexHome:
                "The selected Codex folder is unavailable or unsafe."
            case .launcherErrorInvalidCodexHomeSettings:
                "The saved Codex folder setting is unavailable or unsafe."
            case .launcherErrorInvalidFirstRunState:
                "The saved first-run acknowledgement is unavailable or unsafe."
            case .launcherErrorInvalidHome:
                "The current home directory is unavailable."
            case .launcherErrorInvalidResource:
                "The bundled local companion is incomplete."
            case .launcherErrorInvalidStateDirectory:
                "The private %@ data directory is unavailable."
            case .launcherErrorKeychainDenied:
                "macOS did not allow the requested Keychain reset."
            case .launcherErrorKeychainLocked:
                "The login Keychain is locked."
            case .launcherErrorKeychainReset:
                "The local identity and device reset did not finish."
            case .launcherErrorKeychainResetPartial:
                "The local identity and device reset finished only partially."
            case .launcherFailureDetails:
                "%@ Code: %@. %@"
            case .launcherFirstRunDisclosure:
                "%@ updates local %@ usage and quota evidence while the app is open. The first pass starts after setup; later checks reuse the same bounded local companion.\n\nReads locally: usage metadata from the selected %@ sessions and archived_sessions folders; state_5.sqlite for rollout lineage; config.toml for service-tier settings; and the installed Codex app-server account/read, account/rateLimits/read, and account/usage/read methods. Source records are processed locally; prompt and response text is never retained in TiboTattle's derived state.\n\nStores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only %@ app-data folder. Existing pseudonymous identities and device credentials remain in the macOS Keychain.\n\nCommunity contribution is optional. It stays off until you review the content-free fields and explicitly send a contribution.\n\nLocal allowance notifications are also off by default. If enabled in Settings → Notifications, they use only fresh provider-reported quota evidence from foreground refreshes; they add no background polling.\n\n%@\n\nNever contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.\n\nKeep the app open while analysis runs. You may close and reopen the TiboTattle window; quitting the app stops the current pass and preserves completed checkpoints.\n\n%@"
            case .launcherGetStarted:
                "Get Started"
            case .launcherLoadingPrivateDashboard:
                "Loading the private local dashboard from this Mac only."
            case .launcherLocalDashboardCouldNotStart:
                "The local dashboard could not be started."
            case .launcherLocalDataMovedToTrash:
                "Local data moved to Trash"
            case .launcherLocalDataMovedToTrashDetail:
                "A fresh owner-only local store will be created now. Codex logs were not changed."
            case .launcherMovingLocalDataToTrash:
                "Moving local data to Trash…"
            case .launcherMovingLocalDataToTrashDetail:
                "The local companion is stopping before its exact owner-only state directory is moved."
            case .launcherNeedsAttention:
                "Needs attention"
            case .launcherNoAllowanceObserved:
                "No allowance observed yet"
            case .launcherNothingSaved:
                "Nothing was saved"
            case .launcherOpenBrowserTooltip:
                "Open the same local dashboard in your default browser."
            case .launcherOpenInBrowser:
                "Open in Browser"
            case .launcherOpeningDashboard:
                "Opening the dashboard…"
            case .launcherPreparingLocalView:
                "Preparing your local view…"
            case .launcherPrivacyForegroundOnly:
                "Foreground only • local metadata • contribution is opt-in"
            case .launcherRetry:
                "Retry"
            case .launcherRecoveryCheckAccess:
                "Check access to your home and Application Support folders, then retry."
            case .launcherRecoveryChooseCodexHome:
                "Choose Codex Source and select a readable Codex home owned by your macOS user account, or restore the default."
            case .launcherRecoveryDashboardDownload:
                "Check access to your Downloads folder, then save the file again."
            case .launcherRecoveryDashboardWebView:
                "Choose Open Dashboard to try the local view again. If it still does not open, choose Retry."
            case .launcherRecoveryDataErase:
                "Quit other processes using %@ data, then try the erase again."
            case .launcherRecoveryExistingWindow:
                "Open the existing %@ window, or quit it before starting another copy."
            case .launcherRecoveryKeychainDenied:
                "Retry the reset and approve the macOS Keychain prompt."
            case .launcherRecoveryKeychainLocked:
                "Unlock the login Keychain in Keychain Access, then retry."
            case .launcherRecoveryMoveAppState:
                "Move the %@ app-state folder to Trash, then reopen the app."
            case .launcherRecoveryReinstall:
                "Reinstall this signed %@ build."
            case .launcherRecoveryReset:
                "Copy Data & Diagnostics, then retry the same local reset."
            case .launcherRecoveryRetryDiagnostics:
                "Choose Retry. If it repeats, copy Data & Diagnostics for support."
            case .launcherRestartingLocalCompanion:
                "Restarting the foreground-only local companion with the validated source."
            case .launcherResettingLocalIdentity:
                "Resetting local identity…"
            case .launcherResettingLocalIdentityDetail:
                "Stopping the foreground companion before the exact local Keychain transaction."
            case .launcherStartingLocally:
                "Starting locally…"
            case .launcherUpdateUnavailable:
                "Update unavailable"
            case .launcherUpdatingAutomatically:
                "Updating automatically…"
            case .launcherUpdatingLocalUsage:
                "Updating local usage while the app is open. Large histories may need several passes. Nothing leaves this Mac."
            case .launcherUpdatingLocalUsageContribution:
                "Updating local usage while the app is open. A reviewed contribution remains an explicit manual choice."
            case .launcherUpToDate:
                "Up to date"
            case .launcherWelcome:
                "Welcome to %@"
            case .nativeDashboardAllowance:
                "Allowance"
            case .nativeDashboardCommunity:
                "Community"
            case .nativeDashboardCurrentEvidenceTooltip:
                "The current local evidence state."
            case .nativeDashboardDataPrivacy:
                "Data & Privacy"
            case .nativeDashboardFresh:
                "Fresh"
            case .nativeDashboardHowItWorks:
                "Usage and costs"
            case .nativeDashboardNeedsRefresh:
                "Stale"
            case .nativeDashboardLocalOnly:
                "Local only"
            case .nativeDashboardLocalOnlyTooltip:
                "Analysis and cached results stay on this Mac. Community contribution is optional."
            case .nativeDashboardOverview:
                "Overview"
            case .nativeDashboardProgressAccounting:
                "Calculating accounting…"
            case .nativeDashboardProgressAnalyzing:
                "Analyzing local history…"
            case .nativeDashboardProgressAnalyzingFiles:
                "Analyzing %@ of %@ files…"
            case .nativeDashboardProgressArchiveIndex:
                "Updating older history…"
            case .nativeDashboardProgressDiscovering:
                "Finding local history…"
            case .nativeDashboardProgressFinishing:
                "Finishing analysis…"
            case .nativeDashboardProgressProspective:
                "Preparing ongoing tracking…"
            case .nativeDashboardProgressQuickResult:
                "Local summary updated · checking full history…"
            case .nativeDashboardProgressQuotaRefresh:
                "Refreshing allowance…"
            case .nativeDashboardProgressSaving:
                "Saving analysis progress…"
            case .nativeDashboardRefreshUsage:
                "Refresh"
            case .nativeDashboardRefreshUsageTooltip:
                "Update from selected Codex session folders and local Codex account, quota, configuration, and rollout-lineage sources. Processing stays on this Mac."
            case .nativeDashboardShare:
                "Share"
            case .nativeDashboardShareTooltip:
                "Open the local share card."
            case .nativeDashboardStarting:
                "Starting…"
            case .nativeDashboardStatus:
                "Status"
            case .nativeDashboardTrends:
                "Trends"
            case .nativeDashboardUpdating:
                "Running…"
            case .nativeDashboardHideSidebar:
                "Hide Sidebar"
            case .nativeDashboardShowSidebar:
                "Show Sidebar"
            case .menuAboutProduct:
                "About %@"
            case .menuCopy:
                "Copy"
            case .menuEdit:
                "Edit"
            case .menuView:
                "View"
            case .menuBarAnalyzeLocalUsage:
                "Analyze Local Usage"
            case .menuBarAnalysisRequestRejected:
                "The local companion could not accept an analysis request."
            case .menuBarAnalyzingLocalUsage:
                "Analyzing Local Usage…"
            case .menuBarAllowanceTitle:
                "%@ · %@ allowance"
            case .menuBarCompanionNotRunning:
                "The local companion is not running."
            case .menuBarCompanionStarting:
                "Starting the local companion…"
            case .menuBarCurrentEvidence:
                "Observed locally · verified current evidence"
            case .menuBarCurrentEvidenceWithAge:
                "Observed %@ · verified current evidence"
            case .menuBarDaysAgo:
                "%d days ago"
            case .menuBarFiveHourAllowance:
                "Five-hour allowance"
            case .menuBarFailureRecovery:
                "Not running: %@. Open the window for the recovery step."
            case .menuBarHoursAgo:
                "%d hours ago"
            case .menuBarJustNow:
                "just now"
            case .menuBarLastObservationNotCurrent:
                "Quota lanes were last observed, but are not current"
            case .menuBarLocalEvidenceStale:
                "Local evidence is stale. Allowance values and reset countdowns are hidden."
            case .menuBarLocalEvidenceStaleWithAge:
                "Last observed %@ · stale. Allowance values and reset countdowns are hidden."
            case .menuBarMinutesAgo:
                "%d minutes ago"
            case .menuBarNoVerifiedAllowance:
                "No verified Codex allowance observed yet"
            case .menuBarNoVerifiedQuota:
                "No verified quota observation yet · choose Analyze Local Usage."
            case .menuBarOpenProduct:
                "Open %@"
            case .menuBarQuotaEvidenceUnavailable:
                "Quota evidence is unavailable right now. Retry Local Analysis."
            case .menuBarQuotaLastObserved:
                "%@: last observation is not current"
            case .menuBarQuotaRemaining:
                "%@: %@ remaining"
            case .menuBarQuotaResetUnavailable:
                "%@: %@ · reset time unavailable"
            case .menuBarQuotaResets:
                "%@: %@ · resets %@"
            case .menuBarQuotaWeeklyPositionResets:
                "%@: %@ elapsed · %@ used · resets %@"
            case .menuBarQuotaValuesUnavailable:
                "Quota values are unavailable until a fresh local observation."
            case .menuBarResetDaysHours:
                "in %dd %dh"
            case .menuBarResetHoursMinutes:
                "in %dh %dm"
            case .menuBarResetMinutes:
                "in %dm"
            case .menuBarRetryLocalAnalysis:
                "Retry Local Analysis"
            case .menuBarSevenDayAllowance:
                "Seven-day allowance"
            case .menuBarStaleEvidenceHidden:
                "Allowance values and reset countdowns are hidden."
            case .menuBarUpdateLocalUsage:
                "Update Local Usage"
            case .menuBarVerifiedAllowanceMany:
                "%d verified Codex allowances"
            case .menuBarVerifiedAllowanceOne:
                "1 verified Codex allowance"
            case .menuBarWaitingToAnalyze:
                "Waiting to Analyze Local Usage"
            case .menuBarPopupHeaderLive:
                "Live"
            case .menuBarPopupHeaderLiveUpdated:
                "Live · updated %@"
            case .menuBarPopupHeaderUpdating:
                "Updating…"
            case .menuBarPopupRemaining:
                "%@ remaining"
            case .menuBarPopupResets:
                "Resets %@"
            case .menuBarPopupResetUnavailable:
                "Reset time unavailable"
            case .menuBarPopupWeeklyPosition:
                "Weekly position"
            case .menuBarPopupPositionElapsed:
                "Elapsed"
            case .menuBarPopupPositionUsed:
                "Used"
            case .menuBarPopupPositionBelow:
                "Below even pace"
            case .menuBarPopupPositionOn:
                "On even pace"
            case .menuBarPopupPositionAbove:
                "Above even pace"
            case .menuBarPopupPositionSummary:
                "%@ used · %@ of the window elapsed"
            case .menuBarPopupPositionDisclaimer:
                "Compares use with time elapsed · not a forecast"
            case .menuBarPopupWeeklyPace:
                "Weekly pace"
            case .menuBarPopupPaceCollecting:
                "Collecting pace"
            case .menuBarPopupPaceUnder:
                "Under sustainable pace"
            case .menuBarPopupPaceOn:
                "Near sustainable pace"
            case .menuBarPopupPaceOver:
                "Over sustainable pace"
            case .menuBarPopupPaceCritical:
                "Well over sustainable pace"
            case .menuBarPopupPaceCollectingDetail:
                "One compatible local observation; a trend needs another."
            case .menuBarPopupPaceRatioOutcome:
                "%@× sustainable · %@"
            case .menuBarPopupPaceDryBeforeReset:
                "about %@ before reset with none left"
            case .menuBarPopupPaceSpareAtReset:
                "about %@ left at reset"
            case .menuBarPopupPaceReachesReset:
                "projected to reach reset"
            case .menuBarPopupPaceNow:
                "Now"
            case .menuBarPopupPaceResetIn:
                "Reset in %@"
            case .menuBarPopupPaceEvidenceOne:
                "1 compatible local observation · waiting for another"
            case .menuBarPopupPaceEvidenceMany:
                "%@ compatible local observations · estimate can change"
            case .menuBarPopupPaceEarlyEstimate:
                "Early estimate · %@"
            case .menuBarPopupPaceActiveMarker:
                "%@ · marker shows recent active-use pace"
            case .menuBarPopupLocalUsage:
                "Local usage"
            case .menuBarPopupPeriodLastSevenDays:
                "Last 7 days"
            case .menuBarPopupPeriodLastThirtyDays:
                "Last 30 days"
            case .menuBarPopupTokenCount:
                "%@ tokens"
            case .menuBarPopupUsageChangeOne:
                "1 local usage change"
            case .menuBarPopupUsageChangesMany:
                "%@ local usage changes"
            case .menuBarPopupUsageSummary:
                "%@ · %@"
            case .menuBarPopupAPIPriceEquivalent:
                "API-price equivalent"
            case .menuBarPopupAPIPriceEquivalentPartial:
                "Known API-price equivalent"
            case .menuBarPopupPartialPricing:
                "Partial pricing"
            case .menuBarPopupAPIPriceEquivalentUnavailable:
                "API-price equivalent is unavailable for this period."
            case .menuBarPopupAPIPriceEquivalentRecalculating:
                "Recalculating API-price equivalent…"
            case .menuBarPopupPartialPricingDetail:
                "%@ fully priced · %@ partially priced · %@ unpriced"
            case .menuBarPopupPartialPricingCaption:
                "Chart heights show known priced portions only."
            case .menuBarPopupCoverageMixed:
                "Coverage: %@ complete · %@ partial · %@ unavailable"
            case .menuBarPopupCoverageAccessible:
                "%@. %@ complete days, %@ partial days, %@ unavailable days. %@ known tokens."
            case .menuBarPopupNotSubscriptionBill:
                "Not a subscription bill"
            case .menuBarPopupAccountingUnavailableTitle:
                "Local usage history is not available yet"
            case .menuBarPopupAccountingUnavailableBody:
                "Run a local analysis to build 7-day and 30-day API-price-equivalent history from this Mac."
            case .menuBarPopupRetainedHistory:
                "Showing the last completed analysis."
            case .menuBarPopupNoUsageObserved:
                "No local usage observed in %@."
            case .menuBarPopupStartingTitle:
                "Preparing local usage"
            case .menuBarPopupStartingBody:
                "TiboTattle will show values only after a fresh local observation."
            case .menuBarPopupUpdatingTitle:
                "Reading current local usage…"
            case .menuBarPopupUpdatingBody:
                "TiboTattle will show values only after a fresh local observation."
            case .menuBarPopupStaleTitle:
                "Current usage needs an update"
            case .menuBarPopupStaleBody:
                "Last observed %@. Allowance values are hidden until a fresh local observation."
            case .menuBarPopupErrorTitle:
                "Couldn’t read current usage"
            case .menuBarPopupErrorBody:
                "TiboTattle could not reach its local companion. No earlier values are shown as current."
            case .menuBarPopupOpenProduct:
                "Open %@"
            case .menuBarPopupRefresh:
                "Refresh"
            case .menuBarPopupMore:
                "More"
            case .menuBarPopupAccessibilityOpenProduct:
                "Open the full %@ window"
            case .menuBarPopupAccessibilityRefresh:
                "Refresh local usage"
            case .menuBarPopupAccessibilityMore:
                "More %@ actions"
            case .menuQuitProduct:
                "Quit %@"
            case .menuSelectAll:
                "Select All"
            case .menuSettings:
                "Settings…"
            case .notificationAllowanceThresholdBody:
                "A fresh provider-reported allowance observation crossed your %d%% usage alert. Open TiboTattle for details."
            case .notificationAllowanceTitle:
                "Allowance alert"
            case .notificationResetBody:
                "A provider-reported allowance window reset. Open TiboTattle for details."
            case .notificationResetTitle:
                "New allowance window observed"
            case .settingsAboutProduct:
                "About %@"
            case .settingsAboutTab:
                "About"
            case .settingsAboutSummary:
                "Local Codex allowance, measured on your Mac."
            case .settingsAppearance:
                "Appearance"
            case .settingsAppearanceDark:
                "Dark"
            case .settingsAppearanceLight:
                "Light"
            case .settingsAppearancePickerHint:
                "Choose how TiboTattle looks."
            case .settingsAppearanceSummary:
                "Uses your Mac appearance by default."
            case .settingsAppearanceSystem:
                "System"
            case .settingsAutomaticUpdates:
                "Automatic updates"
            case .settingsAutomaticUpdatesOff:
                "Automatic downloads are off."
            case .settingsAutomaticUpdatesOn:
                "Automatic downloads are on."
            case .settingsAutomaticUpdatesReachable:
                "Update feed reachable. Sparkle verification is still pending."
            case .settingsAutomaticUpdatesUnavailable:
                "Automatic updates are unavailable in this build."
            case .settingsAutomaticUpdatesTooltip:
                "Download signed TiboTattle updates automatically."
            case .settingsCheckForUpdates:
                "Check for Updates"
            case .settingsChooseCodexFolder:
                "Choose Codex Folder…"
            case .settingsCodexFolder:
                "Codex folder"
            case .settingsCodexFolderCustomSelectedPath:
                "Custom folder: %@"
            case .settingsCodexFolderDefaultLocation:
                "Default location (~/.codex)"
            case .settingsCodexFolderSummary:
                "This setting controls the sessions and archived_sessions source only. Refresh also uses the local Codex account, quota, configuration, and rollout-lineage sources disclosed at first run."
            case .settingsGeneral:
                "General"
            case .settingsGeneralSummary:
                "Local usage refreshes while TiboTattle is open. Raw logs stay on this Mac."
            case .settingsGitHub:
                "GitHub"
            case .settingsLanguage:
                "Language"
            case .settingsLanguageEnglish:
                "English"
            case .settingsLanguagePickerHint:
                "Choose the language used for TiboTattle controls and explanations."
            case .settingsLanguageSimplifiedChinese:
                "Simplified Chinese"
            case .settingsLanguageSpanish:
                "Spanish"
            case .settingsLanguageSummary:
                "Uses your Mac language by default."
            case .settingsLanguageSystem:
                "System"
            case .settingsNotifications:
                "Notifications"
            case .settingsNotificationsAllowanceTitle:
                "Allowance alerts"
            case .settingsNotificationsDetail:
                "Optional local alerts use fresh quota observations from the normal refresh. TiboTattle never polls in the background."
            case .settingsNotificationsOff:
                "Notifications are off. Turn this switch off at any time to stop future local alerts and clear their local pending state."
            case .settingsNotificationsPermissionDenied:
                "Enabled, but macOS notification permission is denied. No alerts will be sent. Change it in System Settings if you want alerts."
            case .settingsNotificationsPermissionUnknown:
                "Enabled, but macOS notification permission is unavailable or unknown. No alerts will be sent."
            case .settingsNotificationsReasonInferred:
                "the value was inferred rather than provider-reported"
            case .settingsNotificationsReasonLogDerived:
                "the value came from logs rather than the direct provider read"
            case .settingsNotificationsReasonMixedSource:
                "the evidence mixed sources"
            case .settingsNotificationsReasonProviderUnavailable:
                "the provider was unavailable"
            case .settingsNotificationsReasonRefreshFailed:
                "the foreground refresh did not finish"
            case .settingsNotificationsReasonResetProofMissing:
                "the provider did not prove a new reset identity"
            case .settingsNotificationsReasonSchemaChanged:
                "the provider receipt did not match the supported evidence schema"
            case .settingsNotificationsReasonStale:
                "the observation was stale"
            case .settingsNotificationsReasonUnknown:
                "the evidence was unknown"
            case .settingsNotificationsReasonUnobserved:
                "no fresh direct provider observation was available"
            case .settingsNotificationsStatusDeliveryUnavailable:
                "Enabled. The latest eligible alert could not be delivered, so TiboTattle will not retry it automatically."
            case .settingsNotificationsStatusDelivered:
                "Enabled. One local alert was delivered from the latest fresh provider observation."
            case .settingsNotificationsStatusFirstObservation:
                "Enabled. A fresh provider observation established the local baseline; first observations never notify."
            case .settingsNotificationsStatusFreshOnly:
                "Enabled. Waiting for a fresh direct provider observation from the next foreground refresh."
            case .settingsNotificationsStatusIneligible:
                "Enabled. No notification was sent because %@."
            case .settingsNotificationsStatusNoCrossing:
                "Enabled. The latest fresh provider observation did not newly cross an enabled threshold or reach a scheduled reset."
            case .settingsNotificationsStatusStateUnavailable:
                "Notifications are unavailable because their owner-only local state could not be read or written."
            case .settingsNotificationsStatusWaitingPermission:
                "Enabled. macOS notification permission has not been granted, so no alerts will be sent."
            case .settingsNotificationsThresholds:
                "Usage alerts"
            case .settingsNotificationsThresholdsEightyAndNinety:
                "80% and 90%"
            case .settingsNotificationsThresholdsNinety:
                "90% only"
            case .settingsNotificationsThresholdsOff:
                "Off"
            case .settingsNotificationsToggleTooltip:
                "Enable optional local notifications from fresh provider-reported quota evidence."
            case .settingsNotificationsResetDetail:
                "Reset alerts use the provider-reported reset time and notify once on the next refresh at or after it. No background polling is added."
            case .settingsOpenDashboard:
                "Open Dashboard"
            case .settingsOpenNotifications:
                "Open Notification Settings"
            case .firstRunLoginItemDisclosure:
                "By default, first-run setup preselects Start TiboTattle at login. TiboTattle adds a macOS login item only after you click Get Started; it uses no LaunchAgent or daemon and no privileged helper or hidden persistent process."
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
                "Start TiboTattle when you sign in. Manage this in System Settings → Login Items."
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
            case .settingsRefreshInterval:
                "Refresh interval"
            case .settingsRefreshIntervalDetail:
                "Saved on this Mac and used while TiboTattle is open."
            case .settingsRefreshIntervalOneMinute:
                "Every minute"
            case .settingsRefreshIntervalFiveMinutes:
                "Every 5 minutes"
            case .settingsRefreshIntervalFifteenMinutes:
                "Every 15 minutes"
            case .settingsRefreshIntervalThirtyMinutes:
                "Every 30 minutes"
            case .settingsUseDefault:
                "Use Default"
            case .settingsUpdateCheckUnavailableMessage:
                "TiboTattle couldn't complete the update check. Check your internet connection and try again."
            case .settingsUpdateCheckUnavailableTitle:
                "Couldn't check for updates"
            case .settingsUpdateDisclosureAutomaticOff:
                "Signed app updates are available from About → Check for Updates. Automatic downloads are currently off; you can turn them on in Settings → About when available."
            case .settingsUpdateDisclosureAutomaticOn:
                "Signed app updates are checked automatically. By default, a verified update downloads in the background and installs when you quit; you can turn that off in Settings → About."
            case .settingsUpdateDisclosureDevelopment:
                "This development build does not include update checks. Signed releases installed in Applications can check for updates from About."
            case .settingsUpdateDisclosurePreview:
                "This preview uses manual signed-update checks. It does not check, download, or install updates automatically."
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

    /// Formatting is deliberately independent from translation fallback. A
    /// French system with English UI text still receives French date, number,
    /// decimal, grouping, and currency conventions.
    static var locale: Locale {
        .current
    }

    static var languagePreference: LanguagePreference {
        guard let raw = UserDefaults.standard.string(
            forKey: languagePreferenceDefaultsKey
        ), let value = LanguagePreference(rawValue: raw) else {
            return .system
        }
        return value
    }

    static func setLanguagePreference(_ value: LanguagePreference) {
        UserDefaults.standard.set(
            value.rawValue,
            forKey: languagePreferenceDefaultsKey
        )
    }

    static var selectedWebLocale: String {
        switch selectedNativeLocalization {
        case "zh-Hans":
            "zh-Hans"
        case "es":
            "es"
        default:
            fallbackLocale
        }
    }

    static var selectedNativeLocalization: String {
        if let selected = languagePreference.nativeLocalization {
            return selected
        }
        for preferred in Locale.preferredLanguages {
            if let localization = nativeLocalization(for: preferred) {
                return localization
            }
        }
        return fallbackLocalization
    }

    static func languagePreferenceDisplayName() -> String {
        switch languagePreference {
        case .system:
            string(.settingsLanguageSystem)
        case .english:
            string(.settingsLanguageEnglish)
        case .simplifiedChinese:
            // Keep a self-identifying script name in every UI language so a
            // person can recover the picker even if they selected it by error.
            "简体中文"
        case .spanish:
            "Español"
        }
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

    /// Keep the familiar named windows, while describing every other valid
    /// duration as provider-reported evidence. A duration never establishes a
    /// billing cycle, subscription meaning, or calendar-month meaning.
    static func quotaWindowLabel(durationMinutes: Int) -> String {
        switch durationMinutes {
        case CodexQuotaWindowDuration.fiveHourMinutes:
            return string(.menuBarFiveHourAllowance)
        case CodexQuotaWindowDuration.sevenDayMinutes:
            return string(.menuBarSevenDayAllowance)
        default:
            break
        }

        guard CodexQuotaWindowDuration.isValid(durationMinutes) else {
            return providerReportedWindowFallback
        }

        let (count, englishUnit, spanishUnit, chineseUnit):
            (Int, String, String, String)
        if durationMinutes % (24 * 60) == 0 {
            let days = durationMinutes / (24 * 60)
            count = days
            englishUnit = days == 1 ? "day" : "days"
            spanishUnit = days == 1 ? "día" : "días"
            chineseUnit = "天"
        } else if durationMinutes % 60 == 0 {
            let hours = durationMinutes / 60
            count = hours
            englishUnit = hours == 1 ? "hour" : "hours"
            spanishUnit = hours == 1 ? "hora" : "horas"
            chineseUnit = "小时"
        } else {
            count = durationMinutes
            englishUnit = durationMinutes == 1 ? "minute" : "minutes"
            spanishUnit = durationMinutes == 1 ? "minuto" : "minutos"
            chineseUnit = "分钟"
        }
        let number = decimalNumberFormatter(maximumFractionDigits: 0)
            .string(from: NSNumber(value: count)) ?? String(count)
        switch selectedNativeLocalization {
        case "zh-Hans":
            return "提供商报告的 \(number) \(chineseUnit) 窗口"
        case "es":
            return "Ventana de \(number) \(spanishUnit) indicada por el proveedor"
        default:
            return "Provider-reported \(number)-\(englishUnit) window"
        }
    }

    private static let providerReportedWindowFallback =
        "Provider-reported window"

    static func decimalNumberFormatter(
        maximumFractionDigits: Int = 2
    ) -> NumberFormatter {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = max(0, maximumFractionDigits)
        return formatter
    }

    static func percentString(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .percent
        formatter.maximumFractionDigits = 0
        return formatter.string(
            from: NSNumber(value: Double(value) / 100)
        ) ?? "\(value)%"
    }

    static func integerString(_ value: Int) -> String {
        decimalNumberFormatter(maximumFractionDigits: 0)
            .string(from: NSNumber(value: value)) ?? String(value)
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

    private static func nativeLocalization(for preferredLanguage: String)
        -> String? {
        let normalized = preferredLanguage
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()
        if normalized == "zh-hans"
            || normalized.hasPrefix("zh-hans-")
            || normalized == "zh-cn"
            || normalized.hasPrefix("zh-cn-")
            || normalized == "zh-sg"
            || normalized.hasPrefix("zh-sg-") {
            return "zh-Hans"
        }
        // Chinese without a script is ambiguous, and Traditional Chinese is
        // not a Simplified Chinese fallback. Both therefore use English until
        // a corresponding catalog is shipped.
        if normalized == "zh" || normalized.hasPrefix("zh-") {
            return nil
        }
        if normalized == "es" || normalized.hasPrefix("es-") {
            return "es"
        }
        if normalized == "en" || normalized.hasPrefix("en-") {
            return "en"
        }
        return nil
    }

    private static func localizedBundle() -> Bundle {
        bundle(for: selectedNativeLocalization) ?? englishBundle() ?? Bundle.main
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
