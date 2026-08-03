import AppKit
import Darwin
import Foundation
import WebKit
#if canImport(Sparkle)
import Sparkle
#endif

private enum BundledProduct {
    private static func requiredString(_ key: String) -> String {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: key
        ) as? String,
              !value.isEmpty,
              !value.contains("\0")
        else {
            fatalError("Missing or invalid bundled product setting: \(key)")
        }
        return value
    }

    private static func requiredDirectoryName(_ key: String) -> String {
        let value = requiredString(key)
        guard value != ".",
              value != "..",
              !value.contains("/"),
              !value.contains(":"),
              value.count <= 80
        else {
            fatalError("Invalid bundled product directory setting: \(key)")
        }
        return value
    }

    static let displayName = requiredString("CFBundleDisplayName")
    static let bundleName = requiredString("UsageMonitorBundleName")
    static let appOpenScheme =
        requiredString("UsageMonitorAppOpenScheme").lowercased()
    static let appOpenHost =
        requiredString("UsageMonitorAppOpenHost").lowercased()
    static let appOpenURL: String = {
        let value = requiredString("UsageMonitorAppOpenURL")
        guard value == "\(appOpenScheme)://\(appOpenHost)" else {
            fatalError("Invalid bundled product setting: UsageMonitorAppOpenURL")
        }
        return value
    }()
    static let stateDirectoryName =
        requiredDirectoryName("UsageMonitorStateDirectoryName")
    static let monitoredAppDisplayName =
        requiredString("UsageMonitorMonitoredAppDisplayName")
    static let monitoredAppBundleIdentifier =
        requiredString("UsageMonitorMonitoredAppBundleIdentifier")
}

private let loopbackHost = "127.0.0.1"
private let readyLinePattern =
    #"^USAGE_MONITOR_READY http://127\.0\.0\.1:([0-9]{1,5})/$"#
private let launcherSettingsSchema = "usage-monitor-launcher-settings-v1"
private let launcherSettingsFileName = "launcher-settings-v1.json"
private let firstRunReceiptSchema = "usage-monitor-first-run-v1"
private let firstRunReceiptFileName = "first-run-v1.json"
private let keychainResetHelperName = "reset-local-keychain.js"
private let companionStartupTimeoutSeconds = 20

private final class AppUpdater {
    private static var bundledUpdaterEnabled: Bool {
        Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorUpdaterEnabled"
        ) as? Bool == true
    }

#if canImport(Sparkle)
    private let controller: SPUStandardUpdaterController?

    init() {
        controller = Self.bundledUpdaterEnabled
            ? SPUStandardUpdaterController(
                startingUpdater: true,
                updaterDelegate: nil,
                userDriverDelegate: nil
            )
            : nil
    }

    var isAvailable: Bool {
        controller != nil
    }

    var allowsAutomaticUpdateOptIn: Bool {
        controller?.updater.allowsAutomaticUpdates == true
    }

    var automaticUpdatesEnabled: Bool {
        controller?.updater.automaticallyDownloadsUpdates == true
    }

    func checkForUpdates(_ sender: Any?) {
        controller?.checkForUpdates(sender)
    }

    func setAutomaticUpdatesEnabled(_ enabled: Bool) {
        guard let updater = controller?.updater,
              updater.allowsAutomaticUpdates
        else {
            return
        }
        updater.automaticallyDownloadsUpdates = enabled
    }

    static var runtimeDescription: String {
        bundledUpdaterEnabled
            ? "sparkle_2_9_3_enabled"
            : "sparkle_not_configured"
    }
#else
    init() {}

    var isAvailable: Bool {
        false
    }

    var allowsAutomaticUpdateOptIn: Bool {
        false
    }

    var automaticUpdatesEnabled: Bool {
        false
    }

    func checkForUpdates(_ sender: Any?) {}

    func setAutomaticUpdatesEnabled(_ enabled: Bool) {}

    static var runtimeDescription: String {
        bundledUpdaterEnabled
            ? "invalid_framework_missing"
            : "development_disabled"
    }
#endif
}

private enum CentralServiceMode: String {
    case developmentLoopback = "development_loopback"
    case productionHTTPS = "production_https"
}

private struct CentralServiceConfiguration {
    let mode: CentralServiceMode
    let origin: String

    static func bundled() throws -> CentralServiceConfiguration? {
        let originValue = Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorCentralOrigin"
        )
        let modeValue = Bundle.main.object(
            forInfoDictionaryKey: "UsageMonitorCentralOriginMode"
        )
        if originValue == nil && modeValue == nil {
            return nil
        }
        guard let origin = originValue as? String,
              let rawMode = modeValue as? String,
              !origin.isEmpty,
              !origin.contains("\0"),
              let mode = CentralServiceMode(rawValue: rawMode),
              let components = URLComponents(string: origin),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath.isEmpty,
              components.query == nil,
              components.fragment == nil
        else {
            throw LauncherError.invalidCentralService
        }

        switch mode {
        case .developmentLoopback:
            guard scheme == "http",
                  host == loopbackHost,
                  components.port != nil
            else {
                throw LauncherError.invalidCentralService
            }
        case .productionHTTPS:
            guard scheme == "https",
                  !["127.0.0.1", "localhost", "::1"].contains(host)
            else {
                throw LauncherError.invalidCentralService
            }
        }
        return CentralServiceConfiguration(mode: mode, origin: origin)
    }
}

private enum LauncherError: LocalizedError {
    case invalidCentralService
    case invalidCodexHome
    case invalidCodexHomeSettings
    case invalidFirstRunState
    case invalidHome
    case invalidResource(String)
    case invalidStateDirectory
    case companionAlreadyRunning
    case companionExited
    case companionLaunch(String)
    case companionTimeout
    case codexHomeSettingsWrite
    case dashboardDownloadFailed
    case dashboardWebViewUnavailable
    case dataErase
    case firstRunStateWrite
    case healthCheck
    case keychainDenied
    case keychainLocked
    case keychainReset
    case keychainResetPartial

    var errorDescription: String? {
        switch self {
        case .invalidCentralService:
            return "The bundled community-service connection is invalid."
        case .invalidCodexHome:
            return "The selected Codex folder is unavailable or unsafe."
        case .invalidCodexHomeSettings:
            return "The saved Codex folder setting is unavailable or unsafe."
        case .invalidFirstRunState:
            return "The saved first-run acknowledgement is unavailable or unsafe."
        case .invalidHome:
            return "The current home directory is unavailable."
        case .invalidResource:
            return "The bundled local companion is incomplete."
        case .invalidStateDirectory:
            return "The private \(BundledProduct.displayName) data directory is unavailable."
        case .companionAlreadyRunning:
            return "Another \(BundledProduct.displayName) window is already using this Mac's local data."
        case .companionExited:
            return "The local companion stopped before it became ready."
        case .companionLaunch:
            return "The local companion could not be started."
        case .companionTimeout:
            return "The local companion did not become ready in time."
        case .codexHomeSettingsWrite:
            return "The selected Codex folder could not be saved privately."
        case .dashboardDownloadFailed:
            return "The dashboard could not save that file to your Downloads folder."
        case .dashboardWebViewUnavailable:
            return "The in-app dashboard view could not be displayed."
        case .dataErase:
            return "The local \(BundledProduct.displayName) data could not be moved to Trash."
        case .firstRunStateWrite:
            return "The first-run acknowledgement could not be saved privately."
        case .healthCheck:
            return "The local companion health check failed."
        case .keychainDenied:
            return "macOS did not allow the requested Keychain reset."
        case .keychainLocked:
            return "The login Keychain is locked."
        case .keychainReset:
            return "The local identity and device reset did not finish."
        case .keychainResetPartial:
            return "The local identity and device reset finished only partially."
        }
    }

    var failureCode: String {
        switch self {
        case .invalidCentralService:
            return "UM_MACOS_CENTRAL_CONFIGURATION_INVALID"
        case .invalidCodexHome:
            return "UM_MACOS_CODEX_HOME_INVALID"
        case .invalidCodexHomeSettings:
            return "UM_MACOS_CODEX_HOME_SETTINGS_INVALID"
        case .invalidFirstRunState:
            return "UM_MACOS_FIRST_RUN_STATE_INVALID"
        case .invalidHome:
            return "UM_MACOS_HOME_UNAVAILABLE"
        case .invalidResource:
            return "UM_MACOS_BUNDLE_INCOMPLETE"
        case .invalidStateDirectory:
            return "UM_MACOS_APP_STATE_UNAVAILABLE"
        case .companionAlreadyRunning:
            return "UM_MACOS_COMPANION_ALREADY_RUNNING"
        case .companionExited:
            return "UM_MACOS_COMPANION_EXITED"
        case .companionLaunch:
            return "UM_MACOS_COMPANION_LAUNCH_FAILED"
        case .companionTimeout:
            return "UM_MACOS_COMPANION_START_TIMEOUT"
        case .codexHomeSettingsWrite:
            return "UM_MACOS_CODEX_HOME_SETTINGS_WRITE_FAILED"
        case .dashboardDownloadFailed:
            return "UM_MACOS_DASHBOARD_DOWNLOAD_FAILED"
        case .dashboardWebViewUnavailable:
            return "UM_MACOS_DASHBOARD_VIEW_UNAVAILABLE"
        case .dataErase:
            return "UM_MACOS_LOCAL_DATA_ERASE_FAILED"
        case .firstRunStateWrite:
            return "UM_MACOS_FIRST_RUN_STATE_WRITE_FAILED"
        case .healthCheck:
            return "UM_MACOS_LOCAL_HEALTH_FAILED"
        case .keychainDenied:
            return "UM_MACOS_KEYCHAIN_DENIED"
        case .keychainLocked:
            return "UM_MACOS_KEYCHAIN_LOCKED"
        case .keychainReset:
            return "UM_MACOS_KEYCHAIN_RESET_FAILED"
        case .keychainResetPartial:
            return "UM_MACOS_KEYCHAIN_RESET_PARTIAL"
        }
    }

    var recoverySuggestion: String {
        switch self {
        case .invalidCentralService, .invalidResource:
            return "Reinstall this signed \(BundledProduct.displayName) build."
        case .invalidCodexHome, .invalidCodexHomeSettings:
            return "Choose Codex Source and select a readable Codex home, or restore the default."
        case .invalidFirstRunState:
            return "Move the \(BundledProduct.displayName) app-state folder to Trash, then reopen the app."
        case .invalidHome, .invalidStateDirectory, .codexHomeSettingsWrite,
             .firstRunStateWrite:
            return "Check access to your home and Application Support folders, then retry."
        case .dashboardDownloadFailed:
            return "Check access to your Downloads folder, then save the file again."
        case .dashboardWebViewUnavailable:
            return "Choose Open Dashboard to try again, or Open in Browser to use the same local dashboard in your browser."
        case .companionAlreadyRunning:
            return "Open the existing TiboTattle window, or quit it before starting another copy."
        case .companionExited, .companionLaunch, .companionTimeout,
             .healthCheck:
            return "Choose Retry. If it repeats, copy Data & Diagnostics for support."
        case .dataErase:
            return "Quit other processes using \(BundledProduct.displayName) data, then try the erase again."
        case .keychainDenied:
            return "Retry the reset and approve the macOS Keychain prompt."
        case .keychainLocked:
            return "Unlock the login Keychain in Keychain Access, then retry."
        case .keychainReset, .keychainResetPartial:
            return "Copy Data & Diagnostics, then retry the same local reset."
        }
    }
}

private enum CodexHomeMode: String {
    case custom
    case defaultLocation = "default"
}

private struct CodexHomeConfiguration {
    let mode: CodexHomeMode
    let url: URL
}

private struct LauncherSettings: Codable {
    let schemaVersion: String
    let codexHome: String
}

private struct FirstRunReceipt: Codable {
    let schemaVersion: String
    let acknowledged: Bool
}

private struct LifecycleDiagnostics {
    static func render(
        version: String,
        build: String,
        lifecycle: String,
        failureCode: String?,
        recovery: String?,
        centralConfigured: Bool,
        codexHomeMode: CodexHomeMode,
        codexHomeValidated: Bool,
        appStateAvailable: Bool
    ) -> String {
        [
            "\(BundledProduct.displayName) diagnostics",
            "schema: usage-monitor-macos-diagnostics-v1",
            "app_version: \(version)",
            "app_build: \(build)",
            "lifecycle: \(lifecycle)",
            "failure_code: \(failureCode ?? "none")",
            "recovery: \(recovery ?? "none")",
            "community_service: \(centralConfigured ? "configured" : "not_configured")",
            "codex_source: \(codexHomeMode.rawValue)",
            "codex_source_validated: \(codexHomeValidated)",
            "app_state: \(appStateAvailable ? "owner_only_available" : "unavailable")",
            "process_lifecycle: foreground_only",
            "automatic_upload: off",
            "paths_included: false",
            "identifiers_included: false",
            "content_included: false",
        ].joined(separator: "\n")
    }
}

private func regularFile(_ url: URL) -> Bool {
    var metadata = stat()
    return url.path.withCString { path in
        guard lstat(path, &metadata) == 0 else { return false }
        return (metadata.st_mode & S_IFMT) == S_IFREG
            && (metadata.st_mode & S_IFMT) != S_IFLNK
    }
}

private func currentUserHomeDirectory() throws -> URL {
    let environmentHome = ProcessInfo.processInfo.environment["HOME"]
    let candidate = environmentHome.flatMap { value -> URL? in
        guard value.hasPrefix("/"), !value.contains("\0") else { return nil }
        return URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
    } ?? FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
    guard candidate.path.hasPrefix("/"), candidate.path != "/" else {
        throw LauncherError.invalidHome
    }
    return candidate
}

private func defaultCodexHome() throws -> URL {
    try currentUserHomeDirectory()
        .appendingPathComponent(".codex", isDirectory: true)
}

private func validatedCustomCodexHome(_ candidate: URL) throws -> URL {
    let inputPath = candidate.path
    guard candidate.isFileURL,
          inputPath.hasPrefix("/"),
          inputPath != "/",
          !inputPath.contains("\0"),
          inputPath.utf8.count <= 4_096,
          let resolvedPointer = Darwin.realpath(inputPath, nil)
    else {
        throw LauncherError.invalidCodexHome
    }
    defer { free(resolvedPointer) }
    let canonicalPath = String(cString: resolvedPointer)
    guard canonicalPath == inputPath else {
        throw LauncherError.invalidCodexHome
    }
    let selected = URL(
        fileURLWithPath: canonicalPath,
        isDirectory: true
    )
    var metadata = stat()
    let valid = selected.path.withCString { path in
        guard lstat(path, &metadata) == 0 else { return false }
        return (metadata.st_mode & S_IFMT) == S_IFDIR
            && (metadata.st_mode & S_IFMT) != S_IFLNK
            && metadata.st_uid == getuid()
            && access(path, R_OK | X_OK) == 0
    }
    guard valid else {
        throw LauncherError.invalidCodexHome
    }
    return selected
}

private func launcherSettingsFile(in stateRoot: URL) -> URL {
    stateRoot.appendingPathComponent(
        launcherSettingsFileName,
        isDirectory: false
    )
}

private func validateSettingsFile(
    _ file: URL,
    requireValidContentSize: Bool = true
) throws -> Bool {
    var metadata = stat()
    let status = file.path.withCString { path in
        lstat(path, &metadata)
    }
    if status != 0 {
        if errno == ENOENT { return false }
        throw LauncherError.invalidCodexHomeSettings
    }
    guard (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & S_IFMT) != S_IFLNK,
          metadata.st_uid == getuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & 0o077) == 0,
          !requireValidContentSize
            || (metadata.st_size > 0 && metadata.st_size <= 8_192)
    else {
        throw LauncherError.invalidCodexHomeSettings
    }
    return true
}

private func loadCodexHomeConfiguration(
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let settingsFile = launcherSettingsFile(in: stateRoot)
    guard try validateSettingsFile(settingsFile) else {
        return CodexHomeConfiguration(
            mode: .defaultLocation,
            url: try defaultCodexHome()
        )
    }
    do {
        let settings = try JSONDecoder().decode(
            LauncherSettings.self,
            from: Data(contentsOf: settingsFile, options: [.mappedIfSafe])
        )
        guard settings.schemaVersion == launcherSettingsSchema else {
            throw LauncherError.invalidCodexHomeSettings
        }
        let selected = try validatedCustomCodexHome(
            URL(fileURLWithPath: settings.codexHome, isDirectory: true)
        )
        return CodexHomeConfiguration(mode: .custom, url: selected)
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.invalidCodexHomeSettings
    }
}

private func saveCodexHomeConfiguration(
    _ selected: URL,
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let validated = try validatedCustomCodexHome(selected)
    let settingsFile = launcherSettingsFile(in: stateRoot)
    _ = try validateSettingsFile(
        settingsFile,
        requireValidContentSize: false
    )
    let settings = LauncherSettings(
        schemaVersion: launcherSettingsSchema,
        codexHome: validated.path
    )
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes = try encoder.encode(settings)
        bytes.append(0x0a)
        try bytes.write(to: settingsFile, options: [.atomic])
        guard chmod(settingsFile.path, 0o600) == 0,
              try validateSettingsFile(settingsFile)
        else {
            throw LauncherError.codexHomeSettingsWrite
        }
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.codexHomeSettingsWrite
    }
    return CodexHomeConfiguration(mode: .custom, url: validated)
}

private func clearCodexHomeConfiguration(
    stateRoot: URL
) throws -> CodexHomeConfiguration {
    let settingsFile = launcherSettingsFile(in: stateRoot)
    guard try validateSettingsFile(
        settingsFile,
        requireValidContentSize: false
    ) else {
        return CodexHomeConfiguration(
            mode: .defaultLocation,
            url: try defaultCodexHome()
        )
    }
    do {
        try FileManager.default.removeItem(at: settingsFile)
    } catch {
        throw LauncherError.codexHomeSettingsWrite
    }
    return CodexHomeConfiguration(
        mode: .defaultLocation,
        url: try defaultCodexHome()
    )
}

private func firstRunReceiptFile(in stateRoot: URL) -> URL {
    stateRoot.appendingPathComponent(
        firstRunReceiptFileName,
        isDirectory: false
    )
}

private func validateFirstRunReceiptFile(_ file: URL) throws -> Bool {
    var metadata = stat()
    let status = file.path.withCString { path in
        lstat(path, &metadata)
    }
    if status != 0 {
        if errno == ENOENT { return false }
        throw LauncherError.invalidFirstRunState
    }
    guard (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & S_IFMT) != S_IFLNK,
          metadata.st_uid == getuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & 0o077) == 0,
          metadata.st_size > 0,
          metadata.st_size <= 512
    else {
        throw LauncherError.invalidFirstRunState
    }
    return true
}

private func hasCompletedFirstRun(stateRoot: URL) throws -> Bool {
    let receiptFile = firstRunReceiptFile(in: stateRoot)
    guard try validateFirstRunReceiptFile(receiptFile) else {
        return false
    }
    do {
        let receipt = try JSONDecoder().decode(
            FirstRunReceipt.self,
            from: Data(contentsOf: receiptFile, options: [.mappedIfSafe])
        )
        guard receipt.schemaVersion == firstRunReceiptSchema,
              receipt.acknowledged
        else {
            throw LauncherError.invalidFirstRunState
        }
        return true
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.invalidFirstRunState
    }
}

private func markFirstRunCompleted(stateRoot: URL) throws {
    let receiptFile = firstRunReceiptFile(in: stateRoot)
    guard !(try validateFirstRunReceiptFile(receiptFile)) else {
        guard try hasCompletedFirstRun(stateRoot: stateRoot) else {
            throw LauncherError.invalidFirstRunState
        }
        return
    }
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes = try encoder.encode(
            FirstRunReceipt(
                schemaVersion: firstRunReceiptSchema,
                acknowledged: true
            )
        )
        bytes.append(0x0a)
        try bytes.write(to: receiptFile, options: [.atomic])
        guard chmod(receiptFile.path, 0o600) == 0,
              try validateFirstRunReceiptFile(receiptFile),
              try hasCompletedFirstRun(stateRoot: stateRoot)
        else {
            throw LauncherError.firstRunStateWrite
        }
    } catch let error as LauncherError {
        throw error
    } catch {
        throw LauncherError.firstRunStateWrite
    }
}

private func ownerOnlyStateRoot() throws -> URL {
    let homeURL = try currentUserHomeDirectory()
    let stateRoot = homeURL
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent(
            BundledProduct.stateDirectoryName,
            isDirectory: true
        )
    do {
        try FileManager.default.createDirectory(
            at: stateRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
    } catch {
        throw LauncherError.invalidStateDirectory
    }

    let descriptor = stateRoot.path.withCString { path in
        open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    }
    guard descriptor >= 0 else {
        throw LauncherError.invalidStateDirectory
    }
    defer { close(descriptor) }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0,
          (metadata.st_mode & S_IFMT) == S_IFDIR,
          metadata.st_uid == getuid(),
          fchmod(descriptor, 0o700) == 0
    else {
        throw LauncherError.invalidStateDirectory
    }
    return stateRoot
}

private struct CompanionResources {
    let node: URL
    let resourceRoot: URL
    let entrypoint: URL
    let keychainResetEntrypoint: URL

    static func bundled() throws -> CompanionResources {
        guard let bundleResources = Bundle.main.resourceURL else {
            throw LauncherError.invalidResource("resources")
        }
        let resourceRoot = bundleResources.appendingPathComponent(
            "app",
            isDirectory: true
        )
        let node = bundleResources
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
            .appendingPathComponent("node", isDirectory: false)
        let entrypoint = resourceRoot
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("local", isDirectory: true)
            .appendingPathComponent("server.js", isDirectory: false)
        let keychainResetEntrypoint = resourceRoot
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("macos", isDirectory: true)
            .appendingPathComponent(
                keychainResetHelperName,
                isDirectory: false
            )
        guard regularFile(node),
              regularFile(entrypoint),
              regularFile(keychainResetEntrypoint)
        else {
            throw LauncherError.invalidResource("runtime")
        }
        return CompanionResources(
            node: node,
            resourceRoot: resourceRoot,
            entrypoint: entrypoint,
            keychainResetEntrypoint: keychainResetEntrypoint
        )
    }
}

private final class CompanionProcess {
    private let centralService: CentralServiceConfiguration?
    private let codexHome: URL
    private let lock = NSLock()
    private var pendingOutput = ""
    private var pendingStandardError = ""
    private var activeInstanceDetected = false
    private var process: Process?
    private var stopCompletions: [() -> Void] = []
    private var stopped = false
    private let onExit: (Bool, Bool) -> Void
    private let onReady: (URL) -> Void

    init(
        centralService: CentralServiceConfiguration?,
        codexHome: URL,
        onReady: @escaping (URL) -> Void,
        onExit: @escaping (Bool, Bool) -> Void
    ) {
        self.centralService = centralService
        self.codexHome = codexHome
        self.onReady = onReady
        self.onExit = onExit
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process?.isRunning == true
    }

    var processIdentifier: pid_t? {
        lock.lock()
        defer { lock.unlock() }
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    func launch() throws {
        let resources = try CompanionResources.bundled()
        let stateRoot = try ownerOnlyStateRoot()
        let homeDirectory = try currentUserHomeDirectory()
        let child = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()

        child.executableURL = resources.node
        child.arguments = [resources.entrypoint.path]
        child.currentDirectoryURL = resources.resourceRoot
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = standardOutput
        child.standardError = standardError

        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [
            "HOME": homeDirectory.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "production",
            "USAGE_MONITOR_PARENT_PID": String(getpid()),
            "USAGE_MONITOR_PORT": "0",
            "USAGE_MONITOR_RESOURCE_ROOT": resources.resourceRoot.path,
            "USAGE_MONITOR_STATE_ROOT": stateRoot.path,
            "CODEX_HOME": codexHome.path,
        ]
        for name in ["LANG", "LC_ALL", "TMPDIR"] {
            if let value = inherited[name], !value.contains("\0") {
                environment[name] = value
            }
        }
        if let centralService {
            environment["USAGE_MONITOR_CENTRAL_ORIGIN"] =
                centralService.origin
        }
        child.environment = environment

        standardOutput.fileHandleForReading.readabilityHandler = {
            [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            self?.consumeStandardOutput(data)
        }
        standardError.fileHandleForReading.readabilityHandler = { [weak self] handle in
            // Drain bounded local diagnostic output without writing it to disk.
            // Only a fixed, non-content-bearing lock code can alter native
            // recovery guidance; all other companion output remains private.
            self?.consumeStandardError(handle.availableData)
        }
        child.terminationHandler = { [weak self] terminated in
            standardOutput.fileHandleForReading.readabilityHandler = nil
            standardError.fileHandleForReading.readabilityHandler = nil
            self?.didTerminate(success: terminated.terminationStatus == 0)
        }

        lock.lock()
        process = child
        stopped = false
        pendingOutput = ""
        pendingStandardError = ""
        activeInstanceDetected = false
        lock.unlock()
        do {
            try child.run()
        } catch {
            lock.lock()
            process = nil
            lock.unlock()
            throw LauncherError.companionLaunch("run")
        }
    }

    private func consumeStandardOutput(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        pendingOutput.append(text)
        if pendingOutput.utf8.count > 8_192 {
            pendingOutput = String(pendingOutput.suffix(4_096))
        }
        var lines: [String] = []
        while let newline = pendingOutput.firstIndex(of: "\n") {
            lines.append(String(pendingOutput[..<newline]))
            pendingOutput.removeSubrange(...newline)
        }
        lock.unlock()

        for line in lines {
            guard let expression = try? NSRegularExpression(
                pattern: readyLinePattern
            ) else { continue }
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let match = expression.firstMatch(in: line, range: range),
                  match.numberOfRanges == 2,
                  let portRange = Range(match.range(at: 1), in: line),
                  let port = Int(line[portRange]),
                  (1...65_535).contains(port),
                  let url = URL(string: "http://\(loopbackHost):\(port)/")
            else {
                continue
            }
            onReady(url)
        }
    }

    private func consumeStandardError(_ data: Data) {
        guard !data.isEmpty,
              let text = String(data: data, encoding: .utf8)
        else {
            return
        }
        lock.lock()
        pendingStandardError.append(text)
        if pendingStandardError.utf8.count > 8_192 {
            pendingStandardError = String(pendingStandardError.suffix(4_096))
        }
        if pendingStandardError.contains("automatic_contribution_instance_active") {
            activeInstanceDetected = true
        }
        lock.unlock()
    }

    private func didTerminate(success: Bool) {
        lock.lock()
        process = nil
        let completions = stopCompletions
        stopCompletions.removeAll()
        let wasStopped = stopped
        let anotherInstanceIsActive = activeInstanceDetected
        lock.unlock()
        for completion in completions {
            completion()
        }
        onExit(success && wasStopped, anotherInstanceIsActive)
    }

    func stop(completion: @escaping () -> Void) {
        lock.lock()
        stopped = true
        guard let child = process, child.isRunning else {
            lock.unlock()
            completion()
            return
        }
        stopCompletions.append(completion)
        child.terminate()
        lock.unlock()

        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + 2
        ) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let shouldKill = self.process === child && child.isRunning
            self.lock.unlock()
            if shouldKill {
                _ = kill(child.processIdentifier, SIGKILL)
            }
        }
    }
}

private struct LocalKeychainResetResult: Decodable {
    struct AppState: Decodable {
        let allAppStateErased: Bool
        let contributionDeviceBinding: String
        let exportIdentityFileResidue: String
        let otherAppStateRetained: Bool
    }

    struct Keychain: Decodable {
        let contributionDevice: String
        let exportIdentity: String
        let secureErasureClaimed: Bool
    }

    struct Hosted: Decodable {
        let dataDeleted: Bool
        let deviceRevoked: Bool
    }

    let schemaVersion: String
    let status: String
    let failureCode: String?
    let appState: AppState
    let keychain: Keychain
    let hosted: Hosted

    var isValid: Bool {
        let itemStates = ["missing", "removed", "retained", "unknown"]
        let keychainStates = ["missing", "removed", "retained", "unknown"]
        let shapeValid =
            schemaVersion == "usage-monitor-local-keychain-reset-v1"
            && ["partial", "reset"].contains(status)
            && itemStates.contains(appState.contributionDeviceBinding)
            && itemStates.contains(appState.exportIdentityFileResidue)
            && keychainStates.contains(keychain.contributionDevice)
            && keychainStates.contains(keychain.exportIdentity)
            && appState.allAppStateErased == false
            && appState.otherAppStateRetained
            && keychain.secureErasureClaimed == false
            && hosted.dataDeleted == false
            && hosted.deviceRevoked == false
        guard shapeValid else { return false }
        if status == "reset" {
            return failureCode == nil
                && ["missing", "removed"].contains(
                    appState.contributionDeviceBinding
                )
                && ["missing", "removed"].contains(
                    appState.exportIdentityFileResidue
                )
                && ["missing", "removed"].contains(
                    keychain.contributionDevice
                )
                && ["missing", "removed"].contains(
                    keychain.exportIdentity
                )
        }
        return failureCode?.hasPrefix("UM_MACOS_") == true
    }

    var isCompleteReset: Bool {
        isValid && status == "reset"
    }
}

/// The dashboard is hosted inside the app, so this web view is the product's
/// primary surface. It is deliberately the narrowest possible browser: it may
/// load exactly one origin — the loopback companion this launcher started —
/// and every other destination is cancelled and handed to the user's own
/// browser instead. The app therefore gains no network reach it did not
/// already have: the companion still binds to loopback only, and nothing here
/// can fetch a remote origin.
@MainActor
private final class DashboardWebHost: NSObject, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate {
    private let onLoaded: () -> Void
    private let onFailure: (String) -> Void
    private let onDownloadFailure: () -> Void
    private let openExternally: (URL) -> Void
    private let onNavigation: (String) -> Void
    private var allowedPort: Int?
    /// False while the view holds no dashboard, so the blank page loaded on
    /// teardown can never be reported as a dashboard that opened.
    private var hasDashboardTarget = false
    let webView: WKWebView

    init(
        onLoaded: @escaping () -> Void,
        onFailure: @escaping (String) -> Void,
        onDownloadFailure: @escaping () -> Void,
        openExternally: @escaping (URL) -> Void,
        onNavigation: @escaping (String) -> Void
    ) {
        self.onLoaded = onLoaded
        self.onFailure = onFailure
        self.onDownloadFailure = onDownloadFailure
        self.openExternally = openExternally
        self.onNavigation = onNavigation
        let configuration = WKWebViewConfiguration()
        // Nothing this surface stores survives the app. The hosted sign-in
        // token is already memory-only by design; a non-persistent store keeps
        // loopback cookies and local storage off disk as well.
        configuration.websiteDataStore = .nonPersistent()
        // The AppKit frame owns navigation and refresh in the installed app.
        // Install this fixed marker before any dashboard script runs so the
        // public-web header cannot flash, or remain visible if WebKit delays a
        // didFinish callback behind local dashboard work.
        let nativeShellMarker = """
        document.documentElement.classList.add('native-dashboard');
        document.addEventListener('DOMContentLoaded', function () {
          if (document.body) document.body.classList.add('native-dashboard');
        }, { once: true });
        """
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: nativeShellMarker,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setAccessibilityLabel("Local dashboard")
        webView.translatesAutoresizingMaskIntoConstraints = false
    }

    func load(_ url: URL) {
        guard url.scheme?.lowercased() == "http",
              url.host == loopbackHost,
              let port = url.port
        else {
            onFailure(LauncherError.healthCheck.failureCode)
            return
        }
        allowedPort = port
        hasDashboardTarget = true
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(request)
    }

    func stop() {
        allowedPort = nil
        hasDashboardTarget = false
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    /// The fixed app URL never carries provider data. It is only a wake-up
    /// signal from the browser callback, so the already-loaded local document
    /// can collect the opaque result without being reloaded and losing its
    /// in-memory sign-in state.
    func notifyHostedSignInReturn() {
        guard hasDashboardTarget else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new Event('tibotattle:hosted-sign-in-return'));"
        )
    }

    private func isCompanionURL(_ url: URL) -> Bool {
        guard let allowedPort else { return false }
        return url.scheme?.lowercased() == "http"
            && url.host == loopbackHost
            && url.port == allowedPort
            && url.user == nil
            && url.password == nil
    }

    // MARK: - Navigation policy

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if isCompanionURL(url) || scheme == "about" || scheme == "blob" {
            if isCompanionURL(url),
               let fragment = url.fragment,
               !fragment.isEmpty {
                onNavigation(fragment)
            }
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openExternally(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard hasDashboardTarget else { return }
        // The local page keeps its public-web navigation when opened in a
        // browser. In the app, AppKit owns navigation and status so the
        // document can concentrate on the current page.
        webView.evaluateJavaScript("document.body.classList.add('native-dashboard')")
        onLoaded()
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        reportNavigationFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard hasDashboardTarget else { return }
        hasDashboardTarget = false
        onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
    }

    private func reportNavigationFailure(_ error: Error) {
        // A navigation this delegate cancelled on purpose is not a failure.
        let failure = error as NSError
        guard hasDashboardTarget,
              failure.domain != NSURLErrorDomain
                || failure.code != NSURLErrorCancelled
        else {
            return
        }
        hasDashboardTarget = false
        onFailure(LauncherError.dashboardWebViewUnavailable.failureCode)
    }

    // MARK: - Window, dialog, and file affordances

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // A provider may request a new browser window. The app never embeds
        // remote origins, so hand it straight to the user's default browser
        // without a second native confirmation dialog.
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = BundledProduct.displayName
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        // The dashboard confirms destructive actions this way, so a web view
        // without this panel would silently answer "no" to a deletion the user
        // asked for. It must be a real question.
        let alert = NSAlert()
        alert.messageText = BundledProduct.displayName
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    // MARK: - Downloads

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        completionHandler(Self.downloadsDestination(for: suggestedFilename))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        // A file that could not be saved is not a dashboard that failed, so
        // the open page is left exactly as it is.
        onDownloadFailure()
    }

    /// A page-supplied filename is untrusted, so only a bounded, separator-free
    /// basename is ever used, and an existing file is never overwritten.
    static func downloadsDestination(for suggestedFilename: String) -> URL? {
        let allowed = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let cleaned = String(
            suggestedFilename.unicodeScalars.filter(allowed.contains)
        )
        let stripped = cleaned.drop(while: { $0 == "." })
        let candidate = stripped.isEmpty
            ? "tibotattle-download"
            : String(stripped.prefix(120))
        guard let downloads = try? FileManager.default.url(
            for: .downloadsDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        ) else {
            return nil
        }
        let base = URL(fileURLWithPath: candidate)
        let stem = base.deletingPathExtension().lastPathComponent
        let suffix = base.pathExtension
        for attempt in 0...50 {
            let name = attempt == 0
                ? candidate
                : suffix.isEmpty
                    ? "\(stem)-\(attempt)"
                    : "\(stem)-\(attempt).\(suffix)"
            let destination = downloads.appendingPathComponent(
                name,
                isDirectory: false
            )
            if !FileManager.default.fileExists(atPath: destination.path) {
                return destination
            }
        }
        return nil
    }
}

@MainActor
private enum NativeDashboardDestination: String, CaseIterable {
    case overview
    case weekly
    case trends
    case method
    case community
    case data

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .weekly: return "Allowance"
        case .trends: return "Trends"
        case .method: return "How it works"
        case .community: return "Community"
        case .data: return "Data & Privacy"
        }
    }

    var symbolName: String {
        switch self {
        case .overview: return "rectangle.grid.1x2"
        case .weekly: return "chart.bar.xaxis"
        case .trends: return "chart.xyaxis.line"
        case .method: return "function"
        case .community: return "person.3"
        case .data: return "lock.shield"
        }
    }
}

/// The native frame for the loopback dashboard.  WebKit remains responsible
/// for the rich charts and accessible, selectable report content; AppKit owns
/// the navigation, lifecycle status, and refresh control that should feel like
/// part of a Mac app rather than a webpage inside one.
@MainActor
private final class NativeDashboardChrome: NSView {
    private let header = NSVisualEffectView()
    private let sidebar = NSVisualEffectView()
    private let titleLabel = NSTextField(labelWithString: BundledProduct.displayName)
    private let modeButton = NSButton(title: "Local only", target: nil, action: nil)
    private let freshnessButton = NSButton(title: "Starting…", target: nil, action: nil)
    private let refreshButton = NSButton(
        title: "Refresh usage",
        target: nil,
        action: nil
    )
    private var pageButtons: [NativeDashboardDestination: NSButton] = [:]

    var onNavigate: ((NativeDashboardDestination) -> Void)?
    var onRefresh: (() -> Void)?

    init(webView: WKWebView) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        header.material = .headerView
        header.blendingMode = .withinWindow
        header.state = .active
        header.translatesAutoresizingMaskIntoConstraints = false

        sidebar.material = .sidebar
        sidebar.blendingMode = .withinWindow
        sidebar.state = .active
        sidebar.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.textColor = .labelColor

        configureBadge(modeButton, symbol: "lock.fill")
        modeButton.toolTip = "Analysis and cached results stay on this Mac. Community contribution is optional."
        configureBadge(freshnessButton, symbol: "checkmark.circle.fill")
        freshnessButton.toolTip = "The current local evidence state."

        refreshButton.bezelStyle = .rounded
        refreshButton.image = NSImage(
            systemSymbolName: "arrow.clockwise",
            accessibilityDescription: "Refresh local usage"
        )
        refreshButton.imagePosition = .imageLeading
        refreshButton.target = self
        refreshButton.action = #selector(requestRefresh)
        refreshButton.toolTip = "Update local usage now. This reads only the selected Codex folders on this Mac."

        let headerContent = NSStackView(views: [
            titleLabel,
            NSView(),
            modeButton,
            freshnessButton,
            refreshButton,
        ])
        headerContent.orientation = .horizontal
        headerContent.alignment = .centerY
        headerContent.spacing = 10
        headerContent.translatesAutoresizingMaskIntoConstraints = false
        headerContent.setCustomSpacing(18, after: titleLabel)
        header.addSubview(headerContent)

        let pageStack = NSStackView()
        pageStack.orientation = .vertical
        pageStack.alignment = .leading
        pageStack.spacing = 3
        pageStack.edgeInsets = NSEdgeInsets(top: 18, left: 12, bottom: 18, right: 12)
        pageStack.translatesAutoresizingMaskIntoConstraints = false
        for destination in NativeDashboardDestination.allCases {
            let button = NSButton(
                title: destination.title,
                target: self,
                action: #selector(selectDestination(_:))
            )
            button.identifier = NSUserInterfaceItemIdentifier(destination.rawValue)
            button.image = NSImage(
                systemSymbolName: destination.symbolName,
                accessibilityDescription: destination.title
            )
            button.imagePosition = .imageLeading
            button.alignment = .left
            button.isBordered = false
            button.bezelStyle = .recessed
            button.contentTintColor = .secondaryLabelColor
            button.font = .systemFont(ofSize: 13, weight: .medium)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.heightAnchor.constraint(equalToConstant: 34).isActive = true
            button.widthAnchor.constraint(equalToConstant: 192).isActive = true
            pageStack.addArrangedSubview(button)
            pageButtons[destination] = button
        }
        sidebar.addSubview(pageStack)

        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        split.addArrangedSubview(sidebar)
        split.addArrangedSubview(webView)
        split.setHoldingPriority(.defaultHigh, forSubviewAt: 0)
        split.setPosition(216, ofDividerAt: 0)

        addSubview(header)
        addSubview(split)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            header.topAnchor.constraint(equalTo: topAnchor),
            header.heightAnchor.constraint(equalToConstant: 58),
            headerContent.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 18),
            headerContent.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -18),
            headerContent.topAnchor.constraint(equalTo: header.topAnchor),
            headerContent.bottomAnchor.constraint(equalTo: header.bottomAnchor),
            pageStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            pageStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            pageStack.topAnchor.constraint(equalTo: sidebar.topAnchor),
            split.leadingAnchor.constraint(equalTo: leadingAnchor),
            split.trailingAnchor.constraint(equalTo: trailingAnchor),
            split.topAnchor.constraint(equalTo: header.bottomAnchor),
            split.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebar.widthAnchor.constraint(greaterThanOrEqualToConstant: 190),
            sidebar.widthAnchor.constraint(lessThanOrEqualToConstant: 250),
        ])
        select(.overview)
    }

    required init?(coder: NSCoder) {
        nil
    }

    func select(_ destination: NativeDashboardDestination) {
        for (candidate, button) in pageButtons {
            let selected = candidate == destination
            button.state = selected ? .on : .off
            button.contentTintColor = selected
                ? .controlAccentColor
                : .secondaryLabelColor
            button.font = .systemFont(
                ofSize: 13,
                weight: selected ? .semibold : .medium
            )
        }
    }

    func updateSyncStatus(
        title: String,
        isRefreshing: Bool,
        refreshEnabled: Bool
    ) {
        freshnessButton.title = title
        freshnessButton.image = NSImage(
            systemSymbolName: isRefreshing
                ? "arrow.triangle.2.circlepath.circle.fill"
                : "checkmark.circle.fill",
            accessibilityDescription: title
        )
        freshnessButton.contentTintColor = isRefreshing
            ? .controlAccentColor
            : .systemGreen
        refreshButton.title = isRefreshing ? "Updating…" : "Refresh usage"
        refreshButton.isEnabled = refreshEnabled && !isRefreshing
    }

    private func configureBadge(_ button: NSButton, symbol: String) {
        button.isBordered = false
        button.bezelStyle = .recessed
        button.font = .systemFont(ofSize: 12, weight: .semibold)
        button.image = NSImage(
            systemSymbolName: symbol,
            accessibilityDescription: button.title
        )
        button.imagePosition = .imageLeading
        button.contentTintColor = .secondaryLabelColor
        button.isEnabled = true
    }

    @objc private func requestRefresh() {
        onRefresh?()
    }

    @objc private func selectDestination(_ sender: NSButton) {
        guard let rawValue = sender.identifier?.rawValue,
              let destination = NativeDashboardDestination(rawValue: rawValue)
        else {
            return
        }
        select(destination)
        onNavigate?(destination)
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let semanticOpenTarget: SemanticOpenTarget
    private let updater = AppUpdater()
    private var centralService: CentralServiceConfiguration?
    private var centralServiceMode: CentralServiceMode?
    private var codexHomeConfiguration: CodexHomeConfiguration?
    private var companion: CompanionProcess?
    private var dashboardURL: URL?
    private var firstRunAcknowledged = false
    private var keychainResetProcess: Process?
    private var launchGeneration = 0
    private var pendingDashboardOpen = false
    private var quitting = false
    private var retryAllowed = true
    private var startupTimeout: DispatchWorkItem?
    private var window: NSWindow?
    private var lastLifecycleStatus = "Starting"
    private var lastFailureCode: String?
    private var lastRecoverySuggestion: String?
    private var menuBarStatus: MenuBarStatusController?
    private var settingsWindow: NSWindow?
    private var settingsTabs: NSTabViewController?
    private weak var settingsCodexHomeLabel: NSTextField?
    private let nativeEvidenceReader = LocalCompanionEvidenceReader()
    private var nativeDashboardChrome: NativeDashboardChrome?
    private var nativeRefreshPoll: DispatchWorkItem?
    private var nativeRefreshSchedule: DispatchWorkItem?
    private var nativeRefreshInFlight = false
    private static let nativeRefreshIntervalSeconds = 300
    private let statusLabel = NSTextField(labelWithString: "Starting locally…")
    private let detailLabel = NSTextField(
        wrappingLabelWithString:
            "Preparing the private local dashboard and its bounded foreground update."
    )
    private let privacyLabel = NSTextField(
        labelWithString:
            "Foreground only • local metadata • contribution is opt-in"
    )
    private lazy var openButton = NSButton(
        title: "Open Dashboard",
        target: self,
        action: #selector(openDashboard)
    )
    private lazy var retryButton = NSButton(
        title: "Retry",
        target: self,
        action: #selector(retryCompanion)
    )
    private lazy var settingsButton = NSButton(
        title: "Settings…",
        target: self,
        action: #selector(showSettingsWindow)
    )
    private lazy var diagnosticsButton = NSButton(
        title: "Data & Diagnostics…",
        target: self,
        action: #selector(showDiagnostics)
    )
    private lazy var codexHomeButton = NSButton(
        title: "Codex Folder…",
        target: self,
        action: #selector(showCodexHomeOptions)
    )
    private lazy var lifecycleHelpButton = NSButton(
        title: "Version & Updates…",
        target: self,
        action: #selector(showLifecycleHelp)
    )
    private lazy var openInBrowserButton = NSButton(
        title: "Open in Browser",
        target: self,
        action: #selector(openDashboardInBrowser)
    )
    private lazy var quitButton = NSButton(
        title: "Quit",
        target: self,
        action: #selector(quitApplication)
    )
    private let statusStack = NSStackView()
    private let dashboardContainer = NSView()
    private let actionRow = NSStackView()
    private var dashboardWebHost: DashboardWebHost?
    private var dashboardWebViewShowing = false

    init(semanticOpenTarget: SemanticOpenTarget) {
        self.semanticOpenTarget = semanticOpenTarget
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = umask(0o077)
        installApplicationMenu()
        createWindow()
        // Installed before any early return below so a launch that fails still
        // leaves a visible, quittable presence in the menu bar.
        installMenuBarStatus()
        do {
            centralService = try CentralServiceConfiguration.bundled()
            codexHomeConfiguration = try loadCodexHomeConfiguration(
                stateRoot: ownerOnlyStateRoot()
            )
        } catch {
            retryAllowed = ![
                LauncherError.invalidCentralService.failureCode,
                LauncherError.invalidCodexHomeSettings.failureCode,
            ].contains((error as? LauncherError)?.failureCode)
            showFailure(error)
            return
        }
        do {
            let stateRoot = try ownerOnlyStateRoot()
            if try !hasCompletedFirstRun(stateRoot: stateRoot) {
                guard showFirstRunDisclosure() else {
                    NSApp.terminate(nil)
                    return
                }
                try markFirstRunCompleted(stateRoot: stateRoot)
            }
            firstRunAcknowledged = true
        } catch {
            let launcherError = error as? LauncherError
            retryAllowed = ![
                LauncherError.invalidFirstRunState.failureCode,
                LauncherError.firstRunStateWrite.failureCode,
            ].contains(launcherError?.failureCode)
            showFailure(error)
            return
        }
        centralServiceMode = centralService?.mode
        startCompanion()
    }

    private func showFirstRunDisclosure() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Welcome to \(BundledProduct.displayName)"
        alert.informativeText = """
        \(BundledProduct.displayName) updates local \(BundledProduct.monitoredAppDisplayName) metadata while the app is open. The first pass starts after setup; later checks reuse the same bounded local companion.

        Reads: timestamps, model and speed labels, token counters, tool categories, and quota snapshots from the selected \(BundledProduct.monitoredAppDisplayName) sessions folders.

        Stores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only \(BundledProduct.displayName) app-data folder.

        Community contribution is optional. It stays off until you review the content-free fields and explicitly send a contribution.

        Never contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.

        Keep the app open while analysis runs. You may close and reopen the TiboTattle window; quitting the app stops the current pass and preserves completed checkpoints. TiboTattle installs no login item, LaunchAgent, or daemon.
        """
        alert.addButton(withTitle: "Get Started")
        alert.addButton(withTitle: "Quit")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func startCompanion() {
        guard !quitting, retryAllowed, firstRunAcknowledged,
              let codexHomeConfiguration
        else { return }
        startupTimeout?.cancel()
        launchGeneration += 1
        let selectedGeneration = launchGeneration
        dashboardURL = nil
        lastLifecycleStatus = "Starting"
        lastFailureCode = nil
        lastRecoverySuggestion = nil
        statusLabel.stringValue = "Starting locally…"
        detailLabel.stringValue =
            "Preparing the private local dashboard and its bounded foreground update."
        openButton.isEnabled = false
        openInBrowserButton.isEnabled = false
        retryButton.isEnabled = false
        hideDashboardWebView()
        menuBarStatus?.companionStarting()
        let process = CompanionProcess(
            centralService: centralService,
            codexHome: codexHomeConfiguration.url,
            onReady: { [weak self] url in
                DispatchQueue.main.async {
                    self?.companionReady(
                        url,
                        generation: selectedGeneration
                    )
                }
            },
            onExit: { [weak self] requested, anotherInstanceIsActive in
                DispatchQueue.main.async {
                    self?.companionExited(
                        requested: requested,
                        anotherInstanceIsActive: anotherInstanceIsActive,
                        generation: selectedGeneration
                    )
                }
            }
        )
        companion = process
        do {
            try process.launch()
            let timeout = DispatchWorkItem { [weak self, weak process] in
                guard let self,
                      let process,
                      selectedGeneration == self.launchGeneration,
                      self.dashboardURL == nil,
                      self.companion === process,
                      !self.quitting
                else {
                    return
                }
                self.launchGeneration += 1
                self.companion = nil
                process.stop {}
                self.showFailure(LauncherError.companionTimeout)
            }
            startupTimeout = timeout
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .seconds(
                    companionStartupTimeoutSeconds
                ),
                execute: timeout
            )
        } catch {
            companion = nil
            showFailure(error)
        }
    }

    private func createWindow() {
        statusLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        statusLabel.textColor = .labelColor

        detailLabel.font = .systemFont(ofSize: 13)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 4

        privacyLabel.font = .systemFont(ofSize: 11, weight: .medium)
        privacyLabel.textColor = .tertiaryLabelColor

        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.isEnabled = false

        retryButton.bezelStyle = .rounded
        retryButton.isEnabled = false

        openInBrowserButton.bezelStyle = .rounded
        openInBrowserButton.isEnabled = false
        openInBrowserButton.toolTip =
            "Open the same local dashboard in your default browser."

        for button in [
            settingsButton,
            diagnosticsButton,
            codexHomeButton,
            lifecycleHelpButton,
            quitButton,
        ] {
            button.bezelStyle = NSButton.BezelStyle.rounded
        }

        // The status stack collapses while the dashboard is on screen and
        // returns whenever the dashboard cannot be shown, so the lifecycle
        // message is never replaced by a blank web view.
        statusStack.orientation = .vertical
        statusStack.alignment = .leading
        statusStack.spacing = 12
        statusStack.setHuggingPriority(.defaultHigh, for: .vertical)
        for label in [statusLabel, detailLabel, privacyLabel] {
            statusStack.addArrangedSubview(label)
            label.setContentCompressionResistancePriority(
                .defaultLow,
                for: .horizontal
            )
        }

        dashboardContainer.translatesAutoresizingMaskIntoConstraints = false
        dashboardContainer.isHidden = true
        dashboardContainer.setContentHuggingPriority(.defaultLow, for: .vertical)

        // The recovery controls are visible while starting or recovering. A
        // ready dashboard owns the whole content area; Quit and Settings
        // remain in the normal macOS menu and the status item rather than
        // being repeated in a browser-style footer.
        actionRow.orientation = .horizontal
        actionRow.spacing = 10
        actionRow.setHuggingPriority(.defaultHigh, for: .vertical)
        for button in [
            quitButton,
            settingsButton,
        ] {
            actionRow.addView(button, in: .leading)
        }
        for button in [
            retryButton,
            openButton,
        ] {
            actionRow.addView(button, in: .trailing)
        }

        let layout = NSStackView()
        layout.orientation = .vertical
        layout.alignment = .leading
        layout.spacing = 16
        layout.edgeInsets = NSEdgeInsets(
            top: 24,
            left: 28,
            bottom: 24,
            right: 28
        )
        layout.translatesAutoresizingMaskIntoConstraints = false
        layout.addArrangedSubview(statusStack)
        layout.addArrangedSubview(dashboardContainer)
        layout.addArrangedSubview(actionRow)

        let content = NSView()
        content.addSubview(layout)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            layout.topAnchor.constraint(equalTo: content.topAnchor),
            layout.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusStack.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            dashboardContainer.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
            actionRow.widthAnchor.constraint(
                equalTo: layout.widthAnchor,
                constant: -56
            ),
        ])

        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        newWindow.title = BundledProduct.displayName
        newWindow.contentView = content
        newWindow.contentMinSize = NSSize(width: 900, height: 420)
        newWindow.isReleasedWhenClosed = false
        newWindow.delegate = self
        newWindow.center()
        newWindow.makeKeyAndOrderFront(nil)
        window = newWindow
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The dashboard runs inside a native AppKit shell.  The HTML stays a
    /// local report surface, while page selection and refresh are normal Mac
    /// controls rather than more web chrome inside a launcher.
    private func showDashboardWebView(_ url: URL) {
        let host = dashboardWebHost ?? {
            let created = DashboardWebHost(
                onLoaded: { [weak self] in self?.dashboardWebViewLoaded() },
                onFailure: { [weak self] code in
                    self?.dashboardWebViewFailed(code: code)
                },
                onDownloadFailure: { [weak self] in
                    self?.reportDashboardDownloadFailure()
                },
                openExternally: { [weak self] link in
                    self?.openExternalDashboardLink(link)
                },
                onNavigation: { [weak self] rawDestination in
                    self?.selectNativeDashboardDestination(rawDestination)
                }
            )
            let chrome = NativeDashboardChrome(webView: created.webView)
            chrome.onNavigate = { [weak self] destination in
                self?.navigateNativeDashboard(to: destination)
            }
            chrome.onRefresh = { [weak self] in
                self?.refreshLocalUsage(automatic: false)
            }
            dashboardContainer.addSubview(chrome)
            NSLayoutConstraint.activate([
                chrome.leadingAnchor.constraint(
                    equalTo: dashboardContainer.leadingAnchor
                ),
                chrome.trailingAnchor.constraint(
                    equalTo: dashboardContainer.trailingAnchor
                ),
                chrome.topAnchor.constraint(
                    equalTo: dashboardContainer.topAnchor
                ),
                chrome.bottomAnchor.constraint(
                    equalTo: dashboardContainer.bottomAnchor
                ),
                chrome.heightAnchor.constraint(
                    greaterThanOrEqualToConstant: 320
                ),
            ])
            dashboardWebHost = created
            nativeDashboardChrome = chrome
            return created
        }()
        statusLabel.stringValue = "Opening the dashboard…"
        detailLabel.stringValue =
            "Loading the private local dashboard from this Mac only."
        nativeDashboardChrome?.updateSyncStatus(
            title: nativeRefreshInFlight ? "Updating…" : "Starting…",
            isRefreshing: nativeRefreshInFlight,
            refreshEnabled: true
        )
        // Show the native frame before WebKit completes the report document.
        // If the loopback page fails, dashboardWebViewFailed restores the
        // status surface; otherwise didFinish makes the report first responder.
        dashboardContainer.isHidden = false
        statusStack.isHidden = true
        actionRow.isHidden = true
        host.load(url)
    }

    private func dashboardWebViewLoaded() {
        dashboardWebViewShowing = true
        dashboardContainer.isHidden = false
        statusStack.isHidden = true
        actionRow.isHidden = true
        lastLifecycleStatus = "Dashboard open"
        openInBrowserButton.isEnabled = true
        // WKWebView follows the normal responder chain only once it owns focus.
        // This makes Cmd-C / Cmd-A act on selected dashboard text, just as they
        // do in a browser, instead of silently targeting the launcher window.
        if let webView = dashboardWebHost?.webView {
            window?.makeFirstResponder(webView)
        }
    }

    private func navigateNativeDashboard(to destination: NativeDashboardDestination) {
        nativeDashboardChrome?.select(destination)
        guard let webView = dashboardWebHost?.webView else { return }
        // Destinations are a closed enum, so interpolation cannot introduce
        // page-provided script content into this privileged bridge.
        let hash = destination.rawValue
        webView.evaluateJavaScript("""
        if (window.location.hash !== '#\(hash)') {
          window.location.hash = '#\(hash)';
        } else {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        """)
    }

    private func selectNativeDashboardDestination(_ rawDestination: String) {
        guard let destination = NativeDashboardDestination(
            rawValue: rawDestination
        ) else {
            return
        }
        nativeDashboardChrome?.select(destination)
    }

    /// Updates are automatic while the app is open, never through a login
    /// item, daemon, or background URL session.  The same bounded loopback
    /// refresh route remains the only reader, so a manual click and the
    /// foreground cadence cannot start two scans at once.
    private func refreshLocalUsage(automatic: Bool) {
        guard !quitting,
              !nativeRefreshInFlight,
              let dashboardURL
        else {
            return
        }
        cancelNativeRefreshSchedule()
        nativeRefreshInFlight = true
        nativeDashboardChrome?.updateSyncStatus(
            title: automatic ? "Updating automatically…" : "Updating…",
            isRefreshing: true,
            refreshEnabled: false
        )
        nativeEvidenceReader.startAnalysis(base: dashboardURL) { [weak self] result in
            guard let self, !self.quitting else { return }
            switch result {
            case .started, .alreadyRunning:
                self.pollNativeRefresh(base: dashboardURL, remainingAttempts: 120)
            case .rejected:
                self.finishNativeRefresh(
                    title: "Update unavailable",
                    refreshEnabled: true
                )
            case .unreachable:
                self.finishNativeRefresh(
                    title: "Local companion unavailable",
                    refreshEnabled: false
                )
            }
        }
    }

    private func pollNativeRefresh(base: URL, remainingAttempts: Int) {
        cancelNativeRefreshPoll()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.quitting, self.nativeRefreshInFlight else {
                return
            }
            self.nativeEvidenceReader.readAnalysisActivity(base: base) { [weak self] activity in
                guard let self, !self.quitting, self.nativeRefreshInFlight else {
                    return
                }
                if activity == .running, remainingAttempts > 0 {
                    self.pollNativeRefresh(
                        base: base,
                        remainingAttempts: remainingAttempts - 1
                    )
                    return
                }
                self.nativeEvidenceReader.readOverview(base: base) { [weak self] overview in
                    guard let self, !self.quitting else { return }
                    let title: String
                    if let overview,
                       LocalCompanionOverviewProjection.evidence(
                        for: overview
                       ) == .live {
                        title = "Up to date"
                    } else if overview?.lanes.isEmpty == false {
                        title = "Needs attention"
                    } else {
                        title = "No allowance observed yet"
                    }
                    self.finishNativeRefresh(title: title, refreshEnabled: true)
                }
            }
        }
        nativeRefreshPoll = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(750),
            execute: work
        )
    }

    private func finishNativeRefresh(title: String, refreshEnabled: Bool) {
        nativeRefreshInFlight = false
        cancelNativeRefreshPoll()
        nativeDashboardChrome?.updateSyncStatus(
            title: title,
            isRefreshing: false,
            refreshEnabled: refreshEnabled
        )
        scheduleNativeRefresh()
    }

    private func cancelNativeRefreshPoll() {
        nativeRefreshPoll?.cancel()
        nativeRefreshPoll = nil
    }

    /// The foreground app keeps its own local evidence current without a
    /// login item or worker. A five-minute cadence is intentionally modest:
    /// it observes new Codex rollouts while avoiding a permanent parser loop.
    private func scheduleNativeRefresh() {
        cancelNativeRefreshSchedule()
        guard !quitting, dashboardURL != nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.refreshLocalUsage(automatic: true)
        }
        nativeRefreshSchedule = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .seconds(Self.nativeRefreshIntervalSeconds),
            execute: work
        )
    }

    private func cancelNativeRefreshSchedule() {
        nativeRefreshSchedule?.cancel()
        nativeRefreshSchedule = nil
    }

    /// The launcher has a native window as well as a web dashboard. Supplying
    /// a standard Edit menu gives WebKit's responder chain its expected Copy
    /// and Select All commands, including their familiar keyboard shortcuts.
    private func installApplicationMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: BundledProduct.displayName)
        let about = NSMenuItem(
            title: "About \(BundledProduct.displayName)",
            action: #selector(showAbout),
            keyEquivalent: ""
        )
        about.target = self
        appMenu.addItem(about)
        let settings = NSMenuItem(
            title: "Settings…",
            action: #selector(showSettingsWindow),
            keyEquivalent: ","
        )
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(
            title: "Quit \(BundledProduct.displayName)",
            action: #selector(quitApplication),
            keyEquivalent: "q"
        )
        quit.target = self
        appMenu.addItem(quit)
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        let selectAll = NSMenuItem(
            title: "Select All",
            action: Selector(("selectAll:")),
            keyEquivalent: "a"
        )
        selectAll.target = nil
        let copy = NSMenuItem(
            title: "Copy",
            action: Selector(("copy:")),
            keyEquivalent: "c"
        )
        copy.target = nil
        editMenu.addItem(selectAll)
        editMenu.addItem(copy)
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    /// A save that failed keeps the dashboard on screen and says so in a
    /// dialog, because the page below it is still perfectly usable.
    private func reportDashboardDownloadFailure() {
        let failure = LauncherError.dashboardDownloadFailed
        lastFailureCode = failure.failureCode
        lastRecoverySuggestion = failure.recoverySuggestion
        let alert = NSAlert()
        alert.messageText = "Nothing was saved"
        alert.informativeText =
            "\(failure.errorDescription ?? "") Code: \(failure.failureCode). \(failure.recoverySuggestion)"
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func dashboardWebViewFailed(code: String) {
        cancelNativeRefreshSchedule()
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        let failure = LauncherError.dashboardWebViewUnavailable
        lastLifecycleStatus = "Dashboard unavailable"
        lastFailureCode = failure.failureCode
        lastRecoverySuggestion = failure.recoverySuggestion
        statusLabel.stringValue = "Dashboard didn’t open"
        detailLabel.stringValue =
            "\(failure.errorDescription ?? "") Code: \(failure.failureCode). \(failure.recoverySuggestion)"
        openButton.isEnabled = dashboardURL != nil
        openInBrowserButton.isEnabled = dashboardURL != nil
        retryButton.isEnabled = retryAllowed && firstRunAcknowledged
    }

    private func hideDashboardWebView() {
        cancelNativeRefreshSchedule()
        dashboardWebViewShowing = false
        dashboardContainer.isHidden = true
        statusStack.isHidden = false
        actionRow.isHidden = false
        openInBrowserButton.isEnabled = false
        cancelNativeRefreshPoll()
        nativeRefreshInFlight = false
        dashboardWebHost?.stop()
    }

    /// A link the embedded dashboard cannot load itself. Only credential-free
    /// public HTTPS is handed to the user's browser; the app opens nothing
    /// else, and loads nothing remote itself.
    private func openExternalDashboardLink(_ url: URL) {
        // The completed hosted-sign-in callback can use only this fixed custom
        // URL to bring the already-running dashboard back to the foreground.
        // It carries no OAuth data, so the browser never hands an account,
        // token, or callback value to the app.
        if semanticOpenTarget.accepts(url) {
            dashboardWebHost?.notifyHostedSignInReturn()
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty,
              url.user == nil,
              url.password == nil
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    // The status item is an additional affordance, never a replacement: the
    // activation policy stays `.regular`, the Dock icon stays, and the window
    // remains the primary surface. Every action below routes into the exact
    // path the window's own controls already use, so there is only ever one
    // dashboard-open path and one shutdown path.
    private func installMenuBarStatus() {
        guard menuBarStatus == nil else { return }
        menuBarStatus = MenuBarStatusController(
            productName: BundledProduct.displayName,
            actions: MenuBarStatusController.Actions(
                openTiboTattle: { [weak self] in self?.openTiboTattle() },
                showSettings: { [weak self] in self?.showSettingsWindow() },
                showAbout: { [weak self] in self?.showAbout() },
                quit: { [weak self] in self?.quitApplication() },
                // The menu bar is the only surface always on screen, so it is
                // where an update check has to be reachable. A build with no
                // updater passes nothing and the row is left out.
                checkForUpdates: updater.isAvailable
                    ? { [weak self] in self?.updater.checkForUpdates(nil) }
                    : nil
            )
        )
    }

    @objc private func showMainWindow() {
        if window == nil {
            createWindow()
        } else {
            window?.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The menu bar's one primary destination. It always foregrounds the
    /// regular TiboTattle window and, when the local companion is ready,
    /// presents the embedded dashboard there rather than opening a browser.
    private func openTiboTattle() {
        showMainWindow()
        if dashboardURL != nil {
            openDashboard()
        }
    }

    private func companionReady(_ url: URL, generation: Int) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        guard url.host == loopbackHost, url.scheme == "http" else {
            showFailure(LauncherError.healthCheck)
            return
        }
        dashboardURL = url
        lastLifecycleStatus = "Ready"
        lastFailureCode = nil
        lastRecoverySuggestion = nil
        statusLabel.stringValue = "Preparing your local view…"
        if centralServiceMode == nil {
            detailLabel.stringValue =
                "Updating local usage while the app is open. Large histories may need several passes. Nothing leaves this Mac."
        } else {
            detailLabel.stringValue =
                "Updating local usage while the app is open. A reviewed contribution remains an explicit manual choice."
        }
        openButton.isEnabled = true
        openInBrowserButton.isEnabled = true
        retryButton.isEnabled = false
        // The same validated loopback URL the window's Open Dashboard uses.
        menuBarStatus?.companionReady(dashboardURL: url)
        // A companion restart moves to a new ephemeral port, so the native
        // dashboard is always reloaded rather than leaving a stale launcher
        // on screen. This also starts the bounded foreground refresh without
        // making someone hunt for a dashboard button.
        pendingDashboardOpen = false
        openDashboard()
        refreshLocalUsage(automatic: true)
    }

    private func companionExited(
        requested: Bool,
        anotherInstanceIsActive: Bool,
        generation: Int
    ) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        if quitting || requested { return }
        dashboardURL = nil
        companion = nil
        showFailure(
            anotherInstanceIsActive
                ? LauncherError.companionAlreadyRunning
                : LauncherError.companionExited
        )
    }

    private func showFailure(_ error: Error) {
        startupTimeout?.cancel()
        startupTimeout = nil
        dashboardURL = nil
        // The companion origin is gone, so the embedded dashboard goes with
        // it and the always-available status controls come back.
        hideDashboardWebView()
        lastLifecycleStatus = "Could not start"
        let launcherError = error as? LauncherError
            ?? LauncherError.companionLaunch("unexpected")
        lastFailureCode = launcherError.failureCode
        lastRecoverySuggestion = launcherError.recoverySuggestion
        statusLabel.stringValue = "Couldn’t start"
        detailLabel.stringValue =
            "\(launcherError.errorDescription ?? "The local dashboard could not be started.") Code: \(launcherError.failureCode). \(launcherError.recoverySuggestion)"
        openButton.isEnabled = false
        openInBrowserButton.isEnabled = false
        retryButton.isEnabled = retryAllowed && firstRunAcknowledged
        menuBarStatus?.companionUnavailable(
            summary:
                "Not running: \(launcherError.failureCode). Open the window for the recovery step."
        )
    }

    // The app is the interface: Open Dashboard shows the loopback dashboard in
    // this window. The browser remains an explicit, separate choice the user
    // may make for their own reasons; hosted sign-in no longer requires it,
    // because the dashboard collects its own result from the contribution
    // service wherever it is running.
    @objc private func openDashboard() {
        guard let dashboardURL,
              dashboardURL.scheme == "http",
              dashboardURL.host == loopbackHost
        else {
            return
        }
        showDashboardWebView(dashboardURL)
    }

    @objc private func openDashboardInBrowser() {
        guard let dashboardURL,
              dashboardURL.scheme == "http",
              dashboardURL.host == loopbackHost
        else {
            return
        }
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func retryCompanion() {
        guard !quitting, retryAllowed, firstRunAcknowledged else { return }
        if let previous = companion, previous.isRunning {
            retryButton.isEnabled = false
            previous.stop { [weak self] in
                DispatchQueue.main.async {
                    self?.companion = nil
                    self?.startCompanion()
                }
            }
        } else {
            companion = nil
            startCompanion()
        }
    }

    private func settingsLabel(
        _ text: String,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = font
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func externalLinkButton(title: String, address: String) -> NSButton {
        let button = NSButton(
            title: title,
            target: self,
            action: #selector(openExternalLink(_:))
        )
        button.bezelStyle = .rounded
        button.image = NSImage(
            systemSymbolName: "arrow.up.forward.app",
            accessibilityDescription: title
        )
        button.imagePosition = .imageLeading
        button.identifier = NSUserInterfaceItemIdentifier(address)
        return button
    }

    @objc private func openExternalLink(_ sender: NSButton) {
        guard let address = sender.identifier?.rawValue,
              let url = URL(string: address),
              url.scheme == "https",
              url.user == nil,
              url.password == nil
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func settingsPage(
        title: String,
        summary: String,
        views: [NSView]
    ) -> NSViewController {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(settingsLabel(
            title,
            font: .systemFont(ofSize: 22, weight: .semibold),
            color: .labelColor
        ))
        stack.addArrangedSubview(settingsLabel(
            summary,
            font: .systemFont(ofSize: 13),
            color: .secondaryLabelColor
        ))
        for view in views {
            stack.addArrangedSubview(view)
        }
        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: root.widthAnchor),
        ])
        let controller = NSViewController()
        controller.view = root
        return controller
    }

    private func codexHomeSettingsSummary() -> String {
        codexHomeConfiguration?.mode == .custom
            ? "Custom folder selected"
            : "Default location (~/.codex)"
    }

    private func updateSettingsCodexHomeSummary() {
        settingsCodexHomeLabel?.stringValue = codexHomeSettingsSummary()
    }

    @objc private func showSettingsWindow() {
        showSettings(selecting: 0)
    }

    @objc private func showAbout() {
        showSettings(selecting: 1)
    }

    private func showSettings(selecting index: Int) {
        if let settingsWindow, let settingsTabs {
            settingsTabs.selectedTabViewItemIndex = index
            updateSettingsCodexHomeSummary()
            settingsWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let sourceStatus = settingsLabel(
            codexHomeSettingsSummary(),
            font: .systemFont(ofSize: 13, weight: .medium),
            color: .labelColor
        )
        settingsCodexHomeLabel = sourceStatus
        let chooseSource = NSButton(
            title: "Choose Codex Folder…",
            target: self,
            action: #selector(showCodexHomeOptions)
        )
        let useDefaultSource = NSButton(
            title: "Use Default",
            target: self,
            action: #selector(useDefaultCodexHome)
        )
        let sourceActions = NSStackView(views: [chooseSource, useDefaultSource])
        sourceActions.orientation = .horizontal
        sourceActions.spacing = 8
        let sourceSection = NSStackView(views: [
            settingsLabel(
                "Codex folder",
                font: .systemFont(ofSize: 14, weight: .semibold),
                color: .labelColor
            ),
            sourceStatus,
            settingsLabel(
                "TiboTattle reads only the sessions and archived_sessions folders below this location. Use the default unless your Codex data lives somewhere else.",
                font: .systemFont(ofSize: 12),
                color: .secondaryLabelColor
            ),
            sourceActions,
        ])
        sourceSection.orientation = .vertical
        sourceSection.alignment = .leading
        sourceSection.spacing = 7
        let openDashboardFromSettings = NSButton(
            title: "Open Dashboard",
            target: self,
            action: #selector(openDashboard)
        )
        let general = settingsPage(
            title: "General",
            summary: "TiboTattle refreshes local usage while it is open. It does not install a login item, LaunchAgent, or daemon; raw logs never leave this Mac.",
            views: [sourceSection, openDashboardFromSettings]
        )

        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "unknown"
        let build = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "unknown"
        let updateMessage = updater.isAvailable
            ? "Signed updates are available for this release."
            : "This development copy does not check for updates. A signed release installs in Applications."
        let projectLinks = NSStackView(views: [
            externalLinkButton(
                title: "TiboTattle website",
                address: "https://tibotattle.com"
            ),
            externalLinkButton(
                title: "GitHub",
                address: "https://github.com/adamallcock"
            ),
            externalLinkButton(
                title: "X / Twitter",
                address: "https://x.com/adamallcock"
            ),
        ])
        projectLinks.orientation = .horizontal
        projectLinks.spacing = 8
        let about = settingsPage(
            title: "About TiboTattle",
            summary: "TiboTattle \(version) (\(build))\n\n\(updateMessage)",
            views: [
                projectLinks,
                NSButton(
                    title: "Version & Updates…",
                    target: self,
                    action: #selector(showLifecycleHelp)
                ),
            ]
        )

        for controller in [general, about] {
            controller.title = "TiboTattle Settings"
        }

        let tabs = NSTabViewController()
        tabs.tabStyle = .toolbar
        for (label, symbol, controller) in [
            ("General", "gearshape", general),
            ("About", "info.circle", about),
        ] {
            let item = NSTabViewItem(identifier: label)
            item.label = label
            item.image = NSImage(
                systemSymbolName: symbol,
                accessibilityDescription: label
            )
            item.viewController = controller
            tabs.addTabViewItem(item)
        }
        tabs.selectedTabViewItemIndex = index
        let newWindow = NSWindow(contentViewController: tabs)
        newWindow.title = "TiboTattle Settings"
        newWindow.styleMask = [.titled, .closable, .miniaturizable]
        newWindow.setContentSize(NSSize(width: 620, height: 390))
        newWindow.contentMinSize = NSSize(width: 560, height: 350)
        newWindow.isReleasedWhenClosed = false
        newWindow.center()
        settingsWindow = newWindow
        settingsTabs = tabs
        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func diagnosticText() -> String {
        let version =
            Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String
            ?? "unknown"
        let build =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
                as? String
            ?? "unknown"
        let mode = codexHomeConfiguration?.mode ?? .defaultLocation
        let codexValidated: Bool
        if let selected = codexHomeConfiguration {
            codexValidated = selected.mode == .defaultLocation
                || (try? validatedCustomCodexHome(selected.url)) != nil
        } else {
            codexValidated = false
        }
        let appStateAvailable = (try? ownerOnlyStateRoot()) != nil
        return LifecycleDiagnostics.render(
            version: version,
            build: build,
            lifecycle: lastLifecycleStatus,
            failureCode: lastFailureCode,
            recovery: lastRecoverySuggestion,
            centralConfigured: centralServiceMode != nil,
            codexHomeMode: mode,
            codexHomeValidated: codexValidated,
            appStateAvailable: appStateAvailable
        )
    }

    @objc private func showDiagnostics() {
        let diagnostics = diagnosticText()
        let alert = NSAlert()
        alert.messageText =
            "\(BundledProduct.displayName) data and diagnostics"
        alert.informativeText = diagnostics
        alert.addButton(withTitle: "Done")
        alert.addButton(withTitle: "Copy Diagnostics")
        alert.addButton(withTitle: "Manage Data…")
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(diagnostics, forType: .string)
            statusLabel.stringValue = "Diagnostics copied"
            detailLabel.stringValue =
                "Copied fixed lifecycle fields only—no paths, identifiers, or Codex content."
        case .alertThirdButtonReturn:
            showDataManagement()
        default:
            break
        }
    }

    @objc private func showLifecycleHelp() {
        let version =
            Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String
            ?? "unknown"
        let build =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
                as? String
            ?? "unknown"
        let updateSummary: String
        if updater.isAvailable {
            let automaticStatus = updater.automaticUpdatesEnabled
                ? "Automatic signed update download and install-on-quit are enabled because you opted in."
                : "Automatic download and install-on-quit are off. You can opt in from Automatic Updates."
            updateSummary =
                "Signed automatic checks are enabled. \(automaticStatus) Check for Updates is always available here."
        } else {
            updateSummary =
                "This development build contains no updater framework and performs no update networking."
        }
        let instructions = """
        \(BundledProduct.displayName) \(version) (\(build))

        Release notes: local personal analysis with optional pseudonymous community contribution.

        Update: \(updateSummary)

        Uninstall:
        Quit \(BundledProduct.displayName) and move \(BundledProduct.bundleName) to Trash. Local app-data cleanup remains available under Data & Diagnostics for troubleshooting.

        \(BundledProduct.monitoredAppDisplayName) logs are never removed by these steps.
        """
        let alert = NSAlert()
        alert.messageText = "Version, updates, and uninstall"
        alert.informativeText = instructions
        var actions = ["done"]
        alert.addButton(withTitle: "Done")
        if updater.isAvailable {
            alert.addButton(withTitle: "Check for Updates")
            actions.append("check")
            if updater.allowsAutomaticUpdateOptIn {
                alert.addButton(withTitle: "Automatic Updates…")
                actions.append("automatic")
            }
        }
        alert.addButton(withTitle: "Copy Details")
        actions.append("copy")
        let response = alert.runModal()
        let actionIndex =
            response.rawValue
            - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        guard actions.indices.contains(actionIndex) else {
            return
        }
        switch actions[actionIndex] {
        case "check":
            updater.checkForUpdates(lifecycleHelpButton)
        case "automatic":
            showAutomaticUpdateOptions()
        case "copy":
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(instructions, forType: .string)
            statusLabel.stringValue = "Version details copied"
            detailLabel.stringValue =
                "The copy contains product lifecycle details only—no local paths, identifiers, or Codex content."
        default:
            break
        }
    }

    private func showAutomaticUpdateOptions() {
        guard updater.isAvailable,
              updater.allowsAutomaticUpdateOptIn
        else {
            return
        }
        let currentlyEnabled = updater.automaticUpdatesEnabled
        let alert = NSAlert()
        alert.messageText = "Automatic updates"
        alert.informativeText = currentlyEnabled
            ? "Automatic signed update download and install-on-quit are on. Turn them off to return to visible update prompts and Check for Updates."
            : "Automatic updates are off. If you turn them on, Sparkle may download signed updates in the background and install them when you quit the app. You can turn this off here later."
        alert.addButton(
            withTitle: currentlyEnabled
                ? "Turn Off Automatic Updates"
                : "Turn On Automatic Updates"
        )
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else {
            return
        }
        updater.setAutomaticUpdatesEnabled(!currentlyEnabled)
        let enabled = updater.automaticUpdatesEnabled
        statusLabel.stringValue =
            enabled ? "Automatic updates enabled" : "Automatic updates disabled"
        detailLabel.stringValue = enabled
            ? "Sparkle may now download signed updates in the background and install them when you quit."
            : "Updates remain available through visible prompts and Check for Updates."
    }

    private func showDataManagement() {
        let alert = NSAlert()
        alert.messageText =
            "Manage local \(BundledProduct.displayName) data"
        alert.informativeText = """
        Local app state, local Keychain capabilities, and hosted data are separate. Choose the exact layer you intend to manage.
        """
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Local App Data…")
        alert.addButton(withTitle: "Identity & Device Reset…")
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            showLocalAppDataManagement()
        case .alertThirdButtonReturn:
            confirmLocalKeychainResetStepOne()
        default:
            break
        }
    }

    private func showLocalAppDataManagement() {
        let alert = NSAlert()
        alert.messageText = "Local app data"
        alert.informativeText = """
        This owner-only Application Support folder contains settings, indexes, cached analysis, prepared contributions, and local device-binding state. It is separate from Codex logs, Keychain, and hosted data.
        """
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Show Local Data")
        alert.addButton(withTitle: "Erase Local Data…")
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            do {
                NSWorkspace.shared.activateFileViewerSelecting([
                    try ownerOnlyStateRoot()
                ])
            } catch {
                showFailure(error)
            }
        case .alertThirdButtonReturn:
            confirmEraseLocalData()
        default:
            break
        }
    }

    @objc private func showCodexHomeOptions() {
        let current =
            codexHomeConfiguration?.mode == .custom
            ? "Custom Codex folder"
            : "Default Codex folder (~/.codex)"
        let alert = NSAlert()
        alert.messageText = "Codex folder"
        alert.informativeText = """
        Current: \(current)

        \(BundledProduct.displayName) stores a custom folder only in owner-only app settings. Diagnostics never copy its path. The local companion reads only the sessions and archived_sessions folders beneath the selected Codex home.
        """
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Choose Folder…")
        alert.addButton(withTitle: "Use Default")
        switch alert.runModal() {
        case .alertSecondButtonReturn:
            chooseCustomCodexHome()
        case .alertThirdButtonReturn:
            useDefaultCodexHome()
        default:
            break
        }
    }

    private func chooseCustomCodexHome() {
        let panel = NSOpenPanel()
        panel.title = "Choose your Codex home folder"
        panel.message =
            "Choose the folder that contains Codex sessions or archived_sessions."
        panel.prompt = "Use This Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        if let current = codexHomeConfiguration?.url {
            panel.directoryURL = current
        }
        guard panel.runModal() == .OK, let selected = panel.url else {
            return
        }
        do {
            codexHomeConfiguration = try saveCodexHomeConfiguration(
                selected,
                stateRoot: ownerOnlyStateRoot()
            )
            updateSettingsCodexHomeSummary()
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    @objc private func useDefaultCodexHome() {
        do {
            codexHomeConfiguration = try clearCodexHomeConfiguration(
                stateRoot: ownerOnlyStateRoot()
            )
            updateSettingsCodexHomeSummary()
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    private func restartCompanionAfterCodexHomeChange() {
        statusLabel.stringValue = "Codex folder updated"
        detailLabel.stringValue =
            "Restarting the foreground-only local companion with the validated source."
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        startupTimeout?.cancel()
        launchGeneration += 1
        let previous = companion
        companion = nil
        if let previous, previous.isRunning {
            previous.stop { [weak self] in
                DispatchQueue.main.async {
                    self?.startCompanion()
                }
            }
        } else {
            startCompanion()
        }
    }

    private func confirmEraseLocalData() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .critical
        confirmation.messageText =
            "Move all local \(BundledProduct.displayName) data to Trash?"
        confirmation.informativeText = """
        App state: local indexes, cached analysis, prepared contributions, custom Codex settings, and local device-binding state move to Trash.

        Keychain: pseudonymous identity and device credentials remain.

        Hosted service: sent community data and registered devices remain. Codex logs are never changed.
        """
        confirmation.addButton(withTitle: "Cancel")
        confirmation.addButton(withTitle: "Move Data to Trash")
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        eraseLocalData()
    }

    private func confirmLocalKeychainResetStepOne() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .warning
        confirmation.messageText = "Reset local identity and device?"
        confirmation.informativeText = """
        This is a targeted local security-recovery action, not uninstall or hosted deletion.

        App state: indexes, cached analysis, prepared contributions, settings, and Codex logs remain. Only the local device-binding marker and any retired file identity residue are removed.

        Keychain: the \(BundledProduct.displayName) export identity and paired-device credential are removed. Account-observation and Claude-session pseudonym keys are not targeted.

        Hosted service: no registered device is revoked and no hosted contribution or result is deleted. Use the hosted privacy workflow separately. Secure erasure is not claimed.
        """
        confirmation.addButton(withTitle: "Cancel")
        confirmation.addButton(withTitle: "Continue…")
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        confirmLocalKeychainResetStepTwo()
    }

    private func confirmLocalKeychainResetStepTwo() {
        let confirmation = NSAlert()
        confirmation.alertStyle = .critical
        confirmation.messageText =
            "Reset exactly two local Keychain capabilities now?"
        confirmation.informativeText = """
        \(BundledProduct.displayName) will stop its foreground companion, remove its export identity and paired-device credential from Keychain, remove only their two local residue files, and then restart.

        Existing prepared or hosted data will not be rewritten or deleted. Future contribution activity will use a new identity and require device pairing again.
        """
        confirmation.addButton(withTitle: "Cancel")
        confirmation.addButton(withTitle: "Reset Local Identity")
        guard confirmation.runModal() == .alertSecondButtonReturn else {
            return
        }
        performLocalKeychainReset()
    }

    private func performLocalKeychainReset() {
        guard keychainResetProcess == nil else { return }
        lastLifecycleStatus = "Resetting local identity"
        statusLabel.stringValue = "Resetting local identity…"
        detailLabel.stringValue =
            "Stopping the foreground companion before the exact local Keychain transaction."
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        startupTimeout?.cancel()
        launchGeneration += 1
        let previous = companion
        companion = nil
        let runReset = { [weak self] in
            DispatchQueue.main.async {
                self?.launchLocalKeychainResetHelper()
            }
        }
        if let previous, previous.isRunning {
            previous.stop(completion: runReset)
        } else {
            runReset()
        }
    }

    private func launchLocalKeychainResetHelper() {
        do {
            let resources = try CompanionResources.bundled()
            let stateRoot = try ownerOnlyStateRoot()
            let homeDirectory = try currentUserHomeDirectory()
            let child = Process()
            let standardOutput = Pipe()
            let standardError = Pipe()
            child.executableURL = resources.node
            child.arguments = [
                resources.keychainResetEntrypoint.path,
                "--confirm-local-keychain-reset",
            ]
            child.currentDirectoryURL = resources.resourceRoot
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = standardOutput
            child.standardError = standardError
            let inherited = ProcessInfo.processInfo.environment
            var environment: [String: String] = [
                "HOME": homeDirectory.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "NODE_ENV": "production",
                "USAGE_MONITOR_STATE_ROOT": stateRoot.path,
            ]
            for name in ["LANG", "LC_ALL", "TMPDIR"] {
                if let value = inherited[name], !value.contains("\0") {
                    environment[name] = value
                }
            }
            child.environment = environment
            child.terminationHandler = { [weak self] terminated in
                let output = standardOutput.fileHandleForReading
                    .readDataToEndOfFile()
                let errorOutput = standardError.fileHandleForReading
                    .readDataToEndOfFile()
                DispatchQueue.main.async {
                    self?.keychainResetProcess = nil
                    self?.finishLocalKeychainReset(
                        status: terminated.terminationStatus,
                        output: output,
                        errorOutput: errorOutput
                    )
                }
            }
            keychainResetProcess = child
            try child.run()
        } catch {
            keychainResetProcess = nil
            showFailure(LauncherError.keychainReset)
        }
    }

    private func finishLocalKeychainReset(
        status: Int32,
        output: Data,
        errorOutput: Data
    ) {
        let decoded = try? JSONDecoder().decode(
            LocalKeychainResetResult.self,
            from: output
        )
        if status == 0, let decoded, decoded.isCompleteReset {
            let result = NSAlert()
            result.messageText = "Local identity and device reset"
            result.informativeText = """
            App state: retained, except the targeted local device-binding marker and retired identity residue.

            Keychain: the \(BundledProduct.displayName) export identity and paired-device credential are now absent. Secure erasure is not claimed.

            Hosted service: no device was revoked and no data was deleted. Pair this app again before a future contribution and use the hosted privacy workflow separately for hosted deletion.
            """
            result.addButton(withTitle: "Done")
            result.runModal()
            retryAllowed = true
            startCompanion()
            return
        }

        let fixedCode = String(data: errorOutput, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resultCode = decoded?.failureCode ?? fixedCode
        switch resultCode {
        case LauncherError.keychainLocked.failureCode:
            showFailure(LauncherError.keychainLocked)
        case LauncherError.keychainDenied.failureCode:
            showFailure(LauncherError.keychainDenied)
        case LauncherError.keychainResetPartial.failureCode:
            showFailure(LauncherError.keychainResetPartial)
        default:
            if status == 2 || decoded?.status == "partial" {
                showFailure(LauncherError.keychainResetPartial)
            } else {
                showFailure(LauncherError.keychainReset)
            }
        }
    }

    private func eraseLocalData() {
        lastLifecycleStatus = "Erasing local data"
        statusLabel.stringValue = "Moving local data to Trash…"
        detailLabel.stringValue =
            "The local companion is stopping before its exact owner-only state directory is moved."
        openButton.isEnabled = false
        retryButton.isEnabled = false
        // This status has to be readable, so the embedded dashboard yields.
        hideDashboardWebView()
        launchGeneration += 1
        let previous = companion
        companion = nil
        let erase = { [weak self] in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let stateRoot = try ownerOnlyStateRoot()
                    try FileManager.default.trashItem(
                        at: stateRoot,
                        resultingItemURL: nil
                    )
                    DispatchQueue.main.async {
                        guard let self, !self.quitting else { return }
                        do {
                            self.codexHomeConfiguration =
                                CodexHomeConfiguration(
                                    mode: .defaultLocation,
                                    url: try defaultCodexHome()
                                )
                        } catch {
                            self.showFailure(error)
                            return
                        }
                        self.lastLifecycleStatus = "Local data erased"
                        self.statusLabel.stringValue =
                            "Local data moved to Trash"
                        self.detailLabel.stringValue =
                            "A fresh owner-only local store will be created now. Codex logs were not changed."
                        self.startCompanion()
                    }
                } catch {
                    DispatchQueue.main.async {
                        self?.showFailure(LauncherError.dataErase)
                    }
                }
            }
        }
        if let previous, previous.isRunning {
            previous.stop(completion: erase)
        } else {
            erase()
        }
    }

    @objc private func quitApplication() {
        NSApp.terminate(nil)
    }

    func application(
        _ application: NSApplication,
        open urls: [URL]
    ) {
        guard !urls.isEmpty,
              urls.allSatisfy(semanticOpenTarget.accepts)
        else {
            lastLifecycleStatus = "Rejected unsupported app link"
            lastFailureCode = "UM_MACOS_APP_LINK_REJECTED"
            lastRecoverySuggestion =
                "Use only the exact \(semanticOpenTarget.canonicalURL) link."
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // A hosted sign-in callback lands here after the browser has already
        // finished. Reloading the loopback document at this point would erase
        // its unpersisted state/proof and make a completed sign-in appear to
        // do nothing. Keep the existing dashboard alive and ask it to poll
        // immediately instead.
        if dashboardWebViewShowing {
            dashboardWebHost?.notifyHostedSignInReturn()
            return
        }
        pendingDashboardOpen = true
        if dashboardURL != nil {
            pendingDashboardOpen = false
            openDashboard()
        } else if companion?.isRunning != true {
            retryCompanion()
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        startupTimeout?.cancel()
        startupTimeout = nil
        if keychainResetProcess?.isRunning == true {
            let alert = NSAlert()
            alert.messageText = "Local identity reset is finishing"
            alert.informativeText =
                "Wait for this short Keychain transaction to finish, then quit."
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return .terminateCancel
        }
        guard !quitting, companion?.isRunning == true else {
            return .terminateNow
        }
        quitting = true
        companion?.stop {
            DispatchQueue.main.async {
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        startupTimeout?.cancel()
        cancelNativeRefreshPoll()
        cancelNativeRefreshSchedule()
        nativeEvidenceReader.invalidate()
        // Released here so the status item can never outlive the companion it
        // reports on. The companion itself is stopped by the graceful
        // `applicationShouldTerminate` path above, which every Quit control
        // — window button and menu-bar item alike — routes through.
        menuBarStatus?.shutDown()
        menuBarStatus = nil
        if companion?.isRunning == true {
            companion?.stop {}
        }
    }
}

// Sign in with Apple is deliberately absent from this app. Apple provisions
// the entitlement only for Ad hoc, App Store Connect, and Development
// distribution, never Developer ID, and a Developer ID build carrying it is
// terminated by the kernel at launch. Both hosted providers instead
// authenticate in the user's own browser against the contribution service,
// which owns the redirect; the dashboard in this window polls that service for
// the one-time result, so no provider host is ever asked of this web view and
// no browser tab has to be kept open to finish.

private func endpointReportsReady(_ url: URL) -> Bool {
    let completed = DispatchSemaphore(value: 0)
    let stateLock = NSLock()
    var passed = false
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 5
    let session = URLSession(configuration: configuration)
    let task = session.dataTask(with: url) { data, response, _ in
        let status = (response as? HTTPURLResponse)?.statusCode
        stateLock.lock()
        if status == 200,
           let data,
           let object = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
           object["status"] as? String == "ready" {
            passed = true
        }
        stateLock.unlock()
        completed.signal()
    }
    task.resume()
    _ = completed.wait(timeout: .now() + .seconds(7))
    session.invalidateAndCancel()
    stateLock.lock()
    let result = passed
    stateLock.unlock()
    return result
}

private enum SmokeTest {
    static func run(requireCentralService: Bool = false) -> Int32 {
        _ = umask(0o077)
        let centralService: CentralServiceConfiguration?
        do {
            centralService = try CentralServiceConfiguration.bundled()
        } catch {
            FileHandle.standardError.write(
                Data("macOS smoke: central configuration invalid\n".utf8)
            )
            return 1
        }
        if requireCentralService && centralService == nil {
            FileHandle.standardError.write(
                Data("macOS smoke: central service not configured\n".utf8)
            )
            return 1
        }
        guard let codexHome = try? defaultCodexHome() else {
            FileHandle.standardError.write(
                Data("macOS smoke: Codex home unavailable\n".utf8)
            )
            return 1
        }
        let ready = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var dashboardURL: URL?
        var exitedEarly = false
        let companion = CompanionProcess(
            centralService: centralService,
            codexHome: codexHome,
            onReady: { url in
                stateLock.lock()
                dashboardURL = url
                stateLock.unlock()
                ready.signal()
            },
            onExit: { requested, _ in
                if !requested {
                    stateLock.lock()
                    exitedEarly = true
                    stateLock.unlock()
                    ready.signal()
                }
            }
        )
        do {
            try companion.launch()
        } catch {
            FileHandle.standardError.write(
                Data("macOS smoke: launch failed\n".utf8)
            )
            return 1
        }

        let timeout = DispatchTime.now() + .seconds(20)
        guard ready.wait(timeout: timeout) == .success else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS smoke: readiness timeout\n".utf8)
            )
            return 1
        }
        stateLock.lock()
        let selectedURL = dashboardURL
        let didExitEarly = exitedEarly
        stateLock.unlock()
        guard !didExitEarly, let selectedURL else {
            FileHandle.standardError.write(
                Data("macOS smoke: companion exited\n".utf8)
            )
            return 1
        }

        let health = DispatchSemaphore(value: 0)
        var healthPassed = false
        let healthURL = selectedURL.appendingPathComponent("api/local/health")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: healthURL) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            stateLock.lock()
            if status == 200,
               let data,
               let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any],
               object["status"] as? String == "ready" {
                healthPassed = true
            }
            stateLock.unlock()
            health.signal()
        }
        task.resume()
        _ = health.wait(timeout: .now() + .seconds(7))
        session.invalidateAndCancel()

        let centralWasReady = !requireCentralService || endpointReportsReady(
            selectedURL.appendingPathComponent("api/ready")
        )
        companion.stop { stopped.signal() }
        let stoppedCleanly =
            stopped.wait(timeout: .now() + .seconds(4)) == .success
        stateLock.lock()
        let healthWasReady = healthPassed
        stateLock.unlock()
        guard healthWasReady, stoppedCleanly else {
            FileHandle.standardError.write(
                Data("macOS smoke: local health check failed\n".utf8)
            )
            return 1
        }
        guard centralWasReady else {
            FileHandle.standardError.write(
                Data("macOS smoke: central readiness check failed\n".utf8)
            )
            return 1
        }
        if requireCentralService {
            print(
                "USAGE_MONITOR_MACOS_CENTRAL_SMOKE_READY "
                    + "host=\(loopbackHost) "
                    + "port=\(selectedURL.port ?? 0) "
                    + "central=\(centralService?.mode.rawValue ?? "invalid")"
            )
            return 0
        }
        print(
            "USAGE_MONITOR_MACOS_SMOKE_READY host=\(loopbackHost) "
                + "port=\(selectedURL.port ?? 0) state=owner-only"
        )
        return 0
    }
}

private enum WatchdogSmokeTest {
    static func run() -> Int32 {
        _ = umask(0o077)
        let centralService: CentralServiceConfiguration?
        do {
            centralService = try CentralServiceConfiguration.bundled()
        } catch {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: central configuration invalid\n".utf8)
            )
            return 1
        }
        guard let codexHome = try? defaultCodexHome() else {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: Codex home unavailable\n".utf8)
            )
            return 1
        }
        let ready = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var dashboardURL: URL?
        var exitedEarly = false
        let companion = CompanionProcess(
            centralService: centralService,
            codexHome: codexHome,
            onReady: { url in
                stateLock.lock()
                dashboardURL = url
                stateLock.unlock()
                ready.signal()
            },
            onExit: { requested, _ in
                if !requested {
                    stateLock.lock()
                    exitedEarly = true
                    stateLock.unlock()
                    ready.signal()
                }
            }
        )
        do {
            try companion.launch()
        } catch {
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: launch failed\n".utf8)
            )
            return 1
        }

        guard ready.wait(timeout: .now() + .seconds(20)) == .success else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: readiness timeout\n".utf8)
            )
            return 1
        }
        stateLock.lock()
        let selectedURL = dashboardURL
        let didExitEarly = exitedEarly
        stateLock.unlock()
        guard !didExitEarly,
              let selectedURL,
              let childProcessIdentifier = companion.processIdentifier
        else {
            companion.stop { stopped.signal() }
            _ = stopped.wait(timeout: .now() + .seconds(4))
            FileHandle.standardError.write(
                Data("macOS watchdog smoke: companion exited\n".utf8)
            )
            return 1
        }

        print(
            "USAGE_MONITOR_MACOS_WATCHDOG_READY "
                + "launcher=\(getpid()) "
                + "child=\(childProcessIdentifier) "
                + "host=\(loopbackHost) "
                + "port=\(selectedURL.port ?? 0)"
        )
        fflush(stdout)

        // The executable test harness sends SIGKILL after reading the line
        // above. Bound this mode so an interrupted harness still stops cleanly.
        _ = DispatchSemaphore(value: 0).wait(
            timeout: .now() + .seconds(30)
        )
        companion.stop { stopped.signal() }
        _ = stopped.wait(timeout: .now() + .seconds(4))
        return 1
    }
}

private enum LifecycleContractSmokeTest {
    static func diagnostics() -> Int32 {
        let rendered = LifecycleDiagnostics.render(
            version: "0.1.0",
            build: "1",
            lifecycle: "Could not start",
            failureCode: LauncherError.companionTimeout.failureCode,
            recovery: LauncherError.companionTimeout.recoverySuggestion,
            centralConfigured: false,
            codexHomeMode: .custom,
            codexHomeValidated: true,
            appStateAvailable: true
        )
        print(rendered)
        return rendered.contains("/") ? 1 : 0
    }

    static func codexHomeSettings(codexHomePath: String) -> Int32 {
        _ = umask(0o077)
        do {
            let stateRoot = try ownerOnlyStateRoot()
            let selected = try saveCodexHomeConfiguration(
                URL(
                    fileURLWithPath: codexHomePath,
                    isDirectory: true
                ),
                stateRoot: stateRoot
            )
            let loaded = try loadCodexHomeConfiguration(
                stateRoot: stateRoot
            )
            guard selected.mode == .custom,
                  loaded.mode == .custom,
                  selected.url == loaded.url
            else {
                return 1
            }
            print(
                "USAGE_MONITOR_MACOS_CODEX_HOME_READY "
                    + "mode=custom persisted=true path_exposed=false"
            )
            return 0
        } catch {
            FileHandle.standardError.write(
                Data("macOS Codex home settings smoke failed\n".utf8)
            )
            return 1
        }
    }

    static func keychainResetContract() -> Int32 {
        let completePayload = Data(
            """
            {
              "schemaVersion": "usage-monitor-local-keychain-reset-v1",
              "status": "reset",
              "failureCode": null,
              "appState": {
                "allAppStateErased": false,
                "contributionDeviceBinding": "removed",
                "exportIdentityFileResidue": "missing",
                "otherAppStateRetained": true
              },
              "keychain": {
                "contributionDevice": "removed",
                "exportIdentity": "missing",
                "secureErasureClaimed": false
              },
              "hosted": {
                "dataDeleted": false,
                "deviceRevoked": false
              }
            }
            """.utf8
        )
        let falseSuccessPayload = Data(
            """
            {
              "schemaVersion": "usage-monitor-local-keychain-reset-v1",
              "status": "reset",
              "failureCode": null,
              "appState": {
                "allAppStateErased": false,
                "contributionDeviceBinding": "removed",
                "exportIdentityFileResidue": "retained",
                "otherAppStateRetained": true
              },
              "keychain": {
                "contributionDevice": "removed",
                "exportIdentity": "retained",
                "secureErasureClaimed": false
              },
              "hosted": {
                "dataDeleted": false,
                "deviceRevoked": false
              }
            }
            """.utf8
        )
        let decoder = JSONDecoder()
        guard let complete = try? decoder.decode(
                  LocalKeychainResetResult.self,
                  from: completePayload
              ),
              complete.isCompleteReset,
              let falseSuccess = try? decoder.decode(
                  LocalKeychainResetResult.self,
                  from: falseSuccessPayload
              ),
              !falseSuccess.isValid,
              !falseSuccess.isCompleteReset
        else {
            return 1
        }
        print(
            "USAGE_MONITOR_MACOS_KEYCHAIN_RESET_CONTRACT "
                + "targets=2 app_state=targeted hosted_mutation=false "
                + "secure_erasure=false confirmations=2"
        )
        return 0
    }

    static func firstRunContract() -> Int32 {
        _ = umask(0o077)
        do {
            let stateRoot = try ownerOnlyStateRoot()
            guard try !hasCompletedFirstRun(stateRoot: stateRoot) else {
                return 1
            }
            try markFirstRunCompleted(stateRoot: stateRoot)
            guard try hasCompletedFirstRun(stateRoot: stateRoot) else {
                return 1
            }
            print(
                "USAGE_MONITOR_MACOS_FIRST_RUN_CONTRACT "
                    + "persisted=true owner_only=true upload=false"
            )
            return 0
        } catch {
            FileHandle.standardError.write(
                Data("macOS first-run contract smoke failed\n".utf8)
            )
            return 1
        }
    }
}

@main
private struct UsageMonitorMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let semanticOpenTarget = SemanticOpenTarget(
            scheme: BundledProduct.appOpenScheme,
            host: BundledProduct.appOpenHost,
            canonicalURL: BundledProduct.appOpenURL
        )
        if let linkIndex = arguments.firstIndex(of: "--app-link-smoke-test") {
            guard linkIndex + 1 < arguments.count,
                  let link = URL(string: arguments[linkIndex + 1])
            else {
                exit(2)
            }
            exit(semanticOpenTarget.accepts(link) ? 0 : 1)
        }
        if arguments.contains("--central-smoke-test") {
            exit(SmokeTest.run(requireCentralService: true))
        }
        if arguments.contains("--smoke-test") {
            exit(SmokeTest.run())
        }
        if arguments.contains("--updater-contract-smoke-test") {
            let description = AppUpdater.runtimeDescription
            print(
                "USAGE_MONITOR_MACOS_UPDATER_CONTRACT "
                    + "runtime=\(description)"
            )
            exit(description == "invalid_framework_missing" ? 1 : 0)
        }
        if arguments.contains("--watchdog-smoke-test") {
            exit(WatchdogSmokeTest.run())
        }
        if arguments.contains("--diagnostics-smoke-test") {
            exit(LifecycleContractSmokeTest.diagnostics())
        }
        if let settingsIndex = arguments.firstIndex(
            of: "--codex-home-settings-smoke-test"
        ) {
            guard settingsIndex + 1 < arguments.count else {
                exit(2)
            }
            exit(
                LifecycleContractSmokeTest.codexHomeSettings(
                    codexHomePath: arguments[settingsIndex + 1]
                )
            )
        }
        if arguments.contains("--keychain-reset-contract-smoke-test") {
            exit(LifecycleContractSmokeTest.keychainResetContract())
        }
        if arguments.contains("--first-run-contract-smoke-test") {
            exit(LifecycleContractSmokeTest.firstRunContract())
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate(semanticOpenTarget: semanticOpenTarget)
        application.delegate = delegate
        application.run()
    }
}
