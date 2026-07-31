import AppKit
import Darwin
import Foundation
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
private let codexHelpURL = URL(string: "https://learn.chatgpt.com/docs/app")!
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
    case companionExited
    case companionLaunch(String)
    case companionTimeout
    case codexHomeSettingsWrite
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
        case .companionExited:
            return "The local companion stopped before it became ready."
        case .companionLaunch:
            return "The local companion could not be started."
        case .companionTimeout:
            return "The local companion did not become ready in time."
        case .codexHomeSettingsWrite:
            return "The selected Codex folder could not be saved privately."
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
        case .companionExited:
            return "UM_MACOS_COMPANION_EXITED"
        case .companionLaunch:
            return "UM_MACOS_COMPANION_LAUNCH_FAILED"
        case .companionTimeout:
            return "UM_MACOS_COMPANION_START_TIMEOUT"
        case .codexHomeSettingsWrite:
            return "UM_MACOS_CODEX_HOME_SETTINGS_WRITE_FAILED"
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

private func defaultCodexHome() throws -> URL {
    guard let home = ProcessInfo.processInfo.environment["HOME"],
          home.hasPrefix("/"),
          !home.contains("\0")
    else {
        throw LauncherError.invalidHome
    }
    return URL(fileURLWithPath: home, isDirectory: true)
        .standardizedFileURL
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
    guard let home = ProcessInfo.processInfo.environment["HOME"],
          home.hasPrefix("/"),
          !home.contains("\0")
    else {
        throw LauncherError.invalidHome
    }

    let homeURL = URL(fileURLWithPath: home, isDirectory: true).standardizedFileURL
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
    private var process: Process?
    private var stopCompletions: [() -> Void] = []
    private var stopped = false
    private let onExit: (Bool) -> Void
    private let onReady: (URL) -> Void

    init(
        centralService: CentralServiceConfiguration?,
        codexHome: URL,
        onReady: @escaping (URL) -> Void,
        onExit: @escaping (Bool) -> Void
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
            "HOME": inherited["HOME"] ?? stateRoot.path,
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
        standardError.fileHandleForReading.readabilityHandler = { handle in
            // Drain bounded local diagnostic output without writing it to disk.
            _ = handle.availableData
        }
        child.terminationHandler = { [weak self] terminated in
            standardOutput.fileHandleForReading.readabilityHandler = nil
            standardError.fileHandleForReading.readabilityHandler = nil
            self?.didTerminate(success: terminated.terminationStatus == 0)
        }

        lock.lock()
        process = child
        stopped = false
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

    private func didTerminate(success: Bool) {
        lock.lock()
        process = nil
        let completions = stopCompletions
        stopCompletions.removeAll()
        let wasStopped = stopped
        lock.unlock()
        for completion in completions {
            completion()
        }
        onExit(success && wasStopped)
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
    private let statusLabel = NSTextField(labelWithString: "Starting locally…")
    private let detailLabel = NSTextField(
        wrappingLabelWithString:
            "No Codex metadata is scanned until you open the dashboard and ask."
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
    private lazy var diagnosticsButton = NSButton(
        title: "Data & Diagnostics…",
        target: self,
        action: #selector(showDiagnostics)
    )
    private lazy var codexHomeButton = NSButton(
        title: "Codex Source…",
        target: self,
        action: #selector(showCodexHomeOptions)
    )
    private lazy var lifecycleHelpButton = NSButton(
        title: "Version & Updates…",
        target: self,
        action: #selector(showLifecycleHelp)
    )
    private lazy var openCodexButton = NSButton(
        title: "Open \(BundledProduct.monitoredAppDisplayName)",
        target: self,
        action: #selector(openCodex)
    )
    private lazy var quitButton = NSButton(
        title: "Quit",
        target: self,
        action: #selector(quitApplication)
    )

    init(semanticOpenTarget: SemanticOpenTarget) {
        self.semanticOpenTarget = semanticOpenTarget
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = umask(0o077)
        createWindow()
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
        \(BundledProduct.displayName) works locally with \(BundledProduct.monitoredAppDisplayName) metadata after you explicitly choose Analyze in the dashboard.

        Reads: timestamps, model and speed labels, token counters, tool categories, and quota snapshots from the selected \(BundledProduct.monitoredAppDisplayName) sessions folders.

        Stores: content-free indexes, cached calculations, settings, and any prepared contribution in your owner-only \(BundledProduct.displayName) app-data folder.

        Community contribution is optional. It stays off until you review the content-free fields and explicitly send the first contribution. You may then enable a six-hour while-open contribution schedule; it can be disabled at any time.

        Never contributed: prompts, responses, file paths, repositories, commands, credentials, emails, or account names.

        Keep the app open while analysis runs. You may close and reopen the dashboard tab; quitting the app stops the current pass and preserves completed checkpoints.
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
            "Preparing the private local dashboard. No Codex metadata is scanned until you ask."
        openButton.isEnabled = false
        retryButton.isEnabled = false
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
            onExit: { [weak self] requested in
                DispatchQueue.main.async {
                    self?.companionExited(
                        requested: requested,
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
        let content = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        statusLabel.textColor = .labelColor
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        detailLabel.font = .systemFont(ofSize: 13)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 3
        detailLabel.translatesAutoresizingMaskIntoConstraints = false

        privacyLabel.font = .systemFont(ofSize: 11, weight: .medium)
        privacyLabel.textColor = .tertiaryLabelColor
        privacyLabel.translatesAutoresizingMaskIntoConstraints = false

        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.isEnabled = false
        openButton.translatesAutoresizingMaskIntoConstraints = false

        retryButton.bezelStyle = .rounded
        retryButton.isEnabled = false
        retryButton.translatesAutoresizingMaskIntoConstraints = false

        diagnosticsButton.bezelStyle = .rounded
        diagnosticsButton.translatesAutoresizingMaskIntoConstraints = false

        codexHomeButton.bezelStyle = .rounded
        codexHomeButton.translatesAutoresizingMaskIntoConstraints = false

        lifecycleHelpButton.bezelStyle = .rounded
        lifecycleHelpButton.translatesAutoresizingMaskIntoConstraints = false

        openCodexButton.bezelStyle = .rounded
        openCodexButton.translatesAutoresizingMaskIntoConstraints = false

        quitButton.bezelStyle = .rounded
        quitButton.translatesAutoresizingMaskIntoConstraints = false

        content.addSubview(statusLabel)
        content.addSubview(detailLabel)
        content.addSubview(privacyLabel)
        content.addSubview(openButton)
        content.addSubview(retryButton)
        content.addSubview(diagnosticsButton)
        content.addSubview(codexHomeButton)
        content.addSubview(lifecycleHelpButton)
        content.addSubview(openCodexButton)
        content.addSubview(quitButton)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            statusLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            statusLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 30),
            detailLabel.leadingAnchor.constraint(equalTo: statusLabel.leadingAnchor),
            detailLabel.trailingAnchor.constraint(equalTo: statusLabel.trailingAnchor),
            detailLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 12),
            privacyLabel.leadingAnchor.constraint(equalTo: statusLabel.leadingAnchor),
            privacyLabel.trailingAnchor.constraint(equalTo: statusLabel.trailingAnchor),
            privacyLabel.topAnchor.constraint(equalTo: detailLabel.bottomAnchor, constant: 12),
            quitButton.leadingAnchor.constraint(equalTo: statusLabel.leadingAnchor),
            quitButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -26),
            diagnosticsButton.leadingAnchor.constraint(
                equalTo: quitButton.trailingAnchor,
                constant: 10
            ),
            diagnosticsButton.bottomAnchor.constraint(
                equalTo: quitButton.bottomAnchor
            ),
            codexHomeButton.leadingAnchor.constraint(
                equalTo: diagnosticsButton.trailingAnchor,
                constant: 10
            ),
            codexHomeButton.bottomAnchor.constraint(
                equalTo: quitButton.bottomAnchor
            ),
            lifecycleHelpButton.leadingAnchor.constraint(
                equalTo: codexHomeButton.trailingAnchor,
                constant: 10
            ),
            lifecycleHelpButton.bottomAnchor.constraint(
                equalTo: quitButton.bottomAnchor
            ),
            lifecycleHelpButton.trailingAnchor.constraint(
                lessThanOrEqualTo: openCodexButton.leadingAnchor,
                constant: -10
            ),
            openCodexButton.trailingAnchor.constraint(
                equalTo: retryButton.leadingAnchor,
                constant: -10
            ),
            openCodexButton.bottomAnchor.constraint(
                equalTo: quitButton.bottomAnchor
            ),
            retryButton.trailingAnchor.constraint(
                equalTo: openButton.leadingAnchor,
                constant: -10
            ),
            retryButton.bottomAnchor.constraint(equalTo: quitButton.bottomAnchor),
            openButton.trailingAnchor.constraint(equalTo: statusLabel.trailingAnchor),
            openButton.bottomAnchor.constraint(equalTo: quitButton.bottomAnchor),
        ])

        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 300),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        newWindow.title = BundledProduct.displayName
        newWindow.contentView = content
        newWindow.isReleasedWhenClosed = false
        newWindow.delegate = self
        newWindow.center()
        newWindow.makeKeyAndOrderFront(nil)
        window = newWindow
        NSApp.activate(ignoringOtherApps: true)
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
        statusLabel.stringValue = "Ready"
        if centralServiceMode == nil {
            detailLabel.stringValue =
                "Open the dashboard and start an explicit bounded scan. Large histories may need several passes. Nothing leaves this Mac."
        } else {
            detailLabel.stringValue =
                "Open the dashboard and start a bounded scan. Contribution stays off until explicit consent and a reviewed first send; a six-hour while-open schedule can then be enabled."
        }
        openButton.isEnabled = true
        retryButton.isEnabled = false
        if pendingDashboardOpen {
            pendingDashboardOpen = false
            openDashboard()
        }
    }

    private func companionExited(requested: Bool, generation: Int) {
        guard generation == launchGeneration else { return }
        startupTimeout?.cancel()
        startupTimeout = nil
        if quitting || requested { return }
        dashboardURL = nil
        companion = nil
        showFailure(LauncherError.companionExited)
    }

    private func showFailure(_ error: Error) {
        startupTimeout?.cancel()
        startupTimeout = nil
        dashboardURL = nil
        lastLifecycleStatus = "Could not start"
        let launcherError = error as? LauncherError
            ?? LauncherError.companionLaunch("unexpected")
        lastFailureCode = launcherError.failureCode
        lastRecoverySuggestion = launcherError.recoverySuggestion
        statusLabel.stringValue = "Couldn’t start"
        detailLabel.stringValue =
            "\(launcherError.errorDescription ?? "The local dashboard could not be started.") Code: \(launcherError.failureCode). \(launcherError.recoverySuggestion)"
        openButton.isEnabled = false
        retryButton.isEnabled = retryAllowed && firstRunAcknowledged
    }

    @objc private func openDashboard() {
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
            ? "Custom Codex source"
            : "Default ~/.codex source"
        let alert = NSAlert()
        alert.messageText = "Codex source"
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
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    private func useDefaultCodexHome() {
        do {
            codexHomeConfiguration = try clearCodexHomeConfiguration(
                stateRoot: ownerOnlyStateRoot()
            )
            retryAllowed = true
            restartCompanionAfterCodexHomeChange()
        } catch {
            showFailure(error)
        }
    }

    private func restartCompanionAfterCodexHomeChange() {
        statusLabel.stringValue = "Codex source updated"
        detailLabel.stringValue =
            "Restarting the foreground-only local companion with the validated source."
        openButton.isEnabled = false
        retryButton.isEnabled = false
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

    @objc private func openCodex() {
        guard let appURL = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: BundledProduct.monitoredAppBundleIdentifier
        ) else {
            showCodexHelp()
            return
        }
        NSWorkspace.shared.openApplication(
            at: appURL,
            configuration: NSWorkspace.OpenConfiguration()
        ) { [weak self] _, error in
            if error != nil {
                DispatchQueue.main.async {
                    self?.showCodexHelp()
                }
            }
        }
    }

    private func showCodexHelp() {
        let alert = NSAlert()
        alert.messageText =
            "\(BundledProduct.monitoredAppDisplayName) is not available on this Mac"
        alert.informativeText = """
        \(BundledProduct.monitoredAppDisplayName) now lives in the ChatGPT desktop app. Install or open it, sign in, create or resume one task, then return to \(BundledProduct.displayName).
        """
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Open Official Help")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.open(codexHelpURL)
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
                "HOME": inherited["HOME"] ?? stateRoot.path,
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
        pendingDashboardOpen = true
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
        if companion?.isRunning == true {
            companion?.stop {}
        }
    }
}

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
            onExit: { requested in
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
            onExit: { requested in
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
            version: "0.0.1",
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
