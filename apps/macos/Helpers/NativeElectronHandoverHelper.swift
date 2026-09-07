import AppKit
import Foundation
import ServiceManagement
import Darwin

/// A deliberately narrow bridge carried by a future signed Electron candidate.
///
/// The released native 0.1.17 and 0.1.18 applications do not contain this
/// executable. It is therefore not a general command channel or a direct
/// Sparkle replacement: the Electron coordinator invokes it only during a
/// reviewed guided signed-install handover, before it opens the copied state.
@main
enum NativeElectronHandoverHelper {
    private static let schemaVersion =
        "tibotattle-native-electron-handover-bridge-v1"
    private static let productIdentifier = "com.usagemonitor.local"
    private static let supportedNativeVersions: Set<String> = ["0.1.17", "0.1.18"]
    private static let nativeStopTimeout: TimeInterval = 10
    private static let nativeRefreshKey = "tibotattle.refresh-interval.v1"
    private static let nativeAppearanceKey = "tibotattle.appearance.v1"
    private static let nativeLanguageKey = "tibotattle.language-preference.v1"

    private enum BridgeFailure: Error {
        case invalidRequest
        case identity
        case nativeApplication
        case nativeVersion
        case loginItem
        case nativeWriter
    }

    static func main() {
        let result: (Int32, [String: Any])
        do {
            result = (0, try run())
        } catch {
            // No underlying OS error, path, bundle value, process ID, or
            // credential status is emitted. Electron maps this fixed result to
            // a user-safe recovery state.
            result = (1, failureResponse())
        }
        write(result.1)
        exit(result.0)
    }

    private static func run() throws -> [String: Any] {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else { throw BridgeFailure.invalidRequest }
        switch arguments[1] {
        case "--contract-smoke-test":
            guard arguments.count == 2 else { throw BridgeFailure.invalidRequest }
            // This route deliberately performs no ServiceManagement,
            // NSWorkspace, UserDefaults, or Keychain operation. It lets source
            // qualification compile and exercise the closed JSON contract.
            return [
                "schemaVersion": schemaVersion,
                "status": "contract_ok",
            ]
        case "--bundle-context-smoke-test":
            guard arguments.count == 2,
                  Bundle.main.bundleIdentifier == productIdentifier,
                  enclosingApplicationBundleIdentifier() == productIdentifier else {
                throw BridgeFailure.identity
            }
            // Read-only validation of the installed executable location. It
            // never reads preferences or invokes ServiceManagement/Keychain.
            return [
                "schemaVersion": schemaVersion,
                "status": "bundle_context_ok",
            ]
        case "--prepare":
            guard arguments.count == 4, arguments[2] == "--native-app" else {
                throw BridgeFailure.invalidRequest
            }
            return try prepare(nativeApplicationPath: arguments[3])
        default:
            throw BridgeFailure.invalidRequest
        }
    }

    private static func prepare(nativeApplicationPath: String) throws -> [String: Any] {
        // This helper must live in Contents/MacOS: Foundation does not resolve
        // Bundle.main to the app when an executable lives under Resources.
        // ServiceManagement and preferences must bind to the production app.
        guard Bundle.main.bundleIdentifier == productIdentifier,
              enclosingApplicationBundleIdentifier() == productIdentifier else {
            throw BridgeFailure.identity
        }
        try validateNativeApplication(nativeApplicationPath)

        let service = SMAppService.mainApp
        let startAtLogin = service.status == .enabled
        try stopNativeApplications(nativeApplicationPath)
        // Withdraw the same-identity native main-app request after the old UI
        // has exited, so it cannot relaunch after the copied state is staged. A pending
        // approval/removal is not equivalent to a confirmed release of owner
        // responsibility and remains a fail-closed result. The old writer has
        // already exited, so an unsuccessful unregister never races copying.
        if service.status != .notRegistered {
            do {
                try service.unregister()
            } catch {
                throw BridgeFailure.loginItem
            }
        }
        guard service.status == .notRegistered else {
            throw BridgeFailure.loginItem
        }

        let preferences = try readPreferences(startAtLogin: startAtLogin)
        return [
            "schemaVersion": schemaVersion,
            "status": "prepared",
            "nativeWriterStopped": true,
            "loginItemDisabled": true,
            "preferences": preferences,
            // The helper never queries, copies, resets, or prompts for a
            // Keychain item. Same-identity credential access is separately
            // qualified using signed installed artifacts.
            "credentialState": "unchanged",
        ]
    }

    private static func enclosingApplicationBundleIdentifier() -> String? {
        var current = URL(fileURLWithPath: CommandLine.arguments[0])
            .standardizedFileURL
            .deletingLastPathComponent()
        while current.path != "/" {
            if current.pathExtension == "app" {
                return Bundle(url: current)?.bundleIdentifier
            }
            current.deleteLastPathComponent()
        }
        return nil
    }

    private static func validateNativeApplication(_ path: String) throws {
        guard !path.isEmpty, !path.contains("\0") else {
            throw BridgeFailure.nativeApplication
        }
        var metadata = stat()
        let status = path.withCString { lstat($0, &metadata) }
        guard status == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              (metadata.st_mode & S_IFMT) != S_IFLNK,
              let bundle = Bundle(url: URL(fileURLWithPath: path)),
              bundle.bundleIdentifier == productIdentifier,
              let shortVersion = bundle.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
              ) as? String,
              supportedNativeVersions.contains(shortVersion),
              let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              isNumericBuild(build)
        else {
            throw BridgeFailure.nativeApplication
        }
    }

    private static func isNumericBuild(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 80 else { return false }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 8 else { return false }
        return parts.allSatisfy { part in
            guard !part.isEmpty, part.count <= 10,
                  part.allSatisfy({ $0 >= "0" && $0 <= "9" })
            else { return false }
            return part == "0" || part.first != "0"
        }
    }

    private static func stopNativeApplications(_ nativeApplicationPath: String) throws {
        let targetPath = URL(fileURLWithPath: nativeApplicationPath)
            .standardizedFileURL.path
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let parentPID = getppid()
        let nativeProcesses = NSWorkspace.shared.runningApplications.filter { application in
            guard application.bundleIdentifier == productIdentifier,
                  application.processIdentifier != ownPID,
                  application.processIdentifier != parentPID,
                  let bundleURL = application.bundleURL
            else { return false }
            return bundleURL.standardizedFileURL.path == targetPath
        }
        for application in nativeProcesses {
            guard application.terminate() else { throw BridgeFailure.nativeWriter }
        }

        let deadline = Date().addingTimeInterval(nativeStopTimeout)
        while Date() < deadline {
            let remaining = NSWorkspace.shared.runningApplications.contains { application in
                application.bundleIdentifier == productIdentifier
                    && application.processIdentifier != ownPID
                    && application.processIdentifier != parentPID
                    && application.bundleURL?.standardizedFileURL.path == targetPath
            }
            if !remaining { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        throw BridgeFailure.nativeWriter
    }

    private static func readPreferences(startAtLogin: Bool) throws -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: productIdentifier) else {
            throw BridgeFailure.identity
        }
        let rawLanguage = defaults.string(forKey: nativeLanguageKey) ?? "system"
        let language: String
        switch rawLanguage {
        case "system": language = "system"
        case "en", "en-US": language = "en"
        case "zh-Hans": language = "zh-Hans"
        case "es": language = "es"
        default: throw BridgeFailure.identity
        }
        let appearance = defaults.string(forKey: nativeAppearanceKey) ?? "system"
        guard ["system", "light", "dark"].contains(appearance) else {
            throw BridgeFailure.identity
        }
        let storedInterval = defaults.integer(forKey: nativeRefreshKey)
        let refreshInterval = [60, 300, 900, 1800].contains(storedInterval)
            ? storedInterval
            : 300
        return [
            "language": language,
            "appearance": appearance,
            "refreshIntervalSeconds": refreshInterval,
            "startAtLogin": startAtLogin,
        ]
    }

    private static func failureResponse() -> [String: Any] {
        [
            "schemaVersion": schemaVersion,
            "status": "failed",
        ]
    }

    private static func write(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.sortedKeys]
        ) else {
            // A fixed, valid JSON fallback is safer than a native error string.
            FileHandle.standardOutput.write(Data("{\"status\":\"failed\"}\n".utf8))
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
