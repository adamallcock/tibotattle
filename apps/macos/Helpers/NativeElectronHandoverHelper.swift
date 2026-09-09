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
        case loginItemUnregister
        case loginItemStatus
        case loginItemRequiresApproval
        case loginItemNotFound
        case loginItemStatusUnknown
        case nativeWriter
        case otherSameIdentityRunning
        case preferences
    }

    private struct RunningApplicationDescriptor {
        let bundleIdentifier: String?
        let processIdentifier: pid_t
        let bundlePath: String?
    }

    private enum RunningApplicationClassification: Equatable {
        case ignored
        case selectedNative
        case otherSameIdentity
    }

    static func main() {
        let result: (Int32, [String: Any])
        do {
            result = (0, try run())
        } catch {
            // No underlying OS error, path, bundle value, process ID, or
            // credential status is emitted. Electron maps this fixed result to
            // a user-safe recovery state.
            result = (1, failureResponse(for: error, command: CommandLine.arguments.dropFirst().first))
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
        case "--process-classifier-smoke-test":
            guard arguments.count == 2 else { throw BridgeFailure.invalidRequest }
            return try processClassifierSmokeTest()
        case "--prepare":
            guard arguments.count == 4, arguments[2] == "--native-app" else {
                throw BridgeFailure.invalidRequest
            }
            return try prepare(nativeApplicationPath: arguments[3])
        case "--prepare-preflight":
            guard arguments.count == 4, arguments[2] == "--native-app" else {
                throw BridgeFailure.invalidRequest
            }
            return try preparePreflight(nativeApplicationPath: arguments[3])
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
        try validatePreparationLoginItemStatus(service)
        // Preferences are validated before the helper terminates the old writer
        // or withdraws its login item. The standard reader binds to the same
        // app-defaults domain used by the released native predecessor.
        let preferences = try readPreferences(startAtLogin: startAtLogin)
        try assertNoOtherSameIdentityApplications(nativeApplicationPath)
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
                throw BridgeFailure.loginItemUnregister
            }
        }
        guard service.status == .notRegistered else {
            throw BridgeFailure.loginItemStatus
        }

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

    private static func preparePreflight(nativeApplicationPath: String) throws -> [String: Any] {
        // This mirrors every non-mutating prerequisite of --prepare. It does
        // not terminate an app, alter ServiceManagement, write defaults, or
        // access Keychain material.
        guard Bundle.main.bundleIdentifier == productIdentifier,
              enclosingApplicationBundleIdentifier() == productIdentifier else {
            throw BridgeFailure.identity
        }
        try validateNativeApplication(nativeApplicationPath)
        let service = SMAppService.mainApp
        let startAtLogin = service.status == .enabled
        try validatePreparationLoginItemStatus(service)
        _ = try readPreferences(startAtLogin: startAtLogin)
        try assertNativeApplicationsStopped(nativeApplicationPath)
        try assertNoOtherSameIdentityApplications(nativeApplicationPath)
        return [
            "schemaVersion": schemaVersion,
            "status": "preflight_ready",
        ]
    }

    private static func validatePreparationLoginItemStatus(_ service: SMAppService) throws {
        switch service.status {
        case .enabled, .notRegistered:
            return
        case .requiresApproval:
            throw BridgeFailure.loginItemRequiresApproval
        case .notFound:
            throw BridgeFailure.loginItemNotFound
        @unknown default:
            throw BridgeFailure.loginItemStatusUnknown
        }
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

    private static func nativeApplications(_ nativeApplicationPath: String) -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { application in
            classifyRunningApplication(
                RunningApplicationDescriptor(
                    bundleIdentifier: application.bundleIdentifier,
                    processIdentifier: application.processIdentifier,
                    bundlePath: application.bundleURL?.standardizedFileURL.path
                ),
                nativeApplicationPath: nativeApplicationPath,
                ownPID: ProcessInfo.processInfo.processIdentifier,
                parentPID: getppid()
            ) == .selectedNative
        }
    }

    private static func classifyRunningApplication(
        _ application: RunningApplicationDescriptor,
        nativeApplicationPath: String,
        ownPID: pid_t,
        parentPID: pid_t
    ) -> RunningApplicationClassification {
        let targetPath = URL(fileURLWithPath: nativeApplicationPath)
            .standardizedFileURL.path
        guard application.bundleIdentifier == productIdentifier,
              application.processIdentifier != ownPID,
              application.processIdentifier != parentPID
        else { return .ignored }
        guard application.bundlePath == targetPath else {
            return .otherSameIdentity
        }
        return .selectedNative
    }

    private static func assertNativeApplicationsStopped(_ nativeApplicationPath: String) throws {
        guard nativeApplications(nativeApplicationPath).isEmpty else {
            throw BridgeFailure.nativeWriter
        }
    }

    private static func assertNoOtherSameIdentityApplications(_ nativeApplicationPath: String) throws {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let parentPID = getppid()
        let hasOther = NSWorkspace.shared.runningApplications.contains { application in
            classifyRunningApplication(
                RunningApplicationDescriptor(
                    bundleIdentifier: application.bundleIdentifier,
                    processIdentifier: application.processIdentifier,
                    bundlePath: application.bundleURL?.standardizedFileURL.path
                ),
                nativeApplicationPath: nativeApplicationPath,
                ownPID: ownPID,
                parentPID: parentPID
            ) == .otherSameIdentity
        }
        guard !hasOther else { throw BridgeFailure.otherSameIdentityRunning }
    }

    private static func processClassifierSmokeTest() throws -> [String: Any] {
        let nativePath = "/synthetic/native/TiboTattle.app"
        let ownPID: pid_t = 41
        let parentPID: pid_t = 42
        let selected = RunningApplicationDescriptor(
            bundleIdentifier: productIdentifier, processIdentifier: 51, bundlePath: nativePath
        )
        let unrelated = RunningApplicationDescriptor(
            bundleIdentifier: "com.example.unrelated", processIdentifier: 52, bundlePath: "/Other.app"
        )
        let otherSameIdentity = RunningApplicationDescriptor(
            bundleIdentifier: productIdentifier, processIdentifier: 53, bundlePath: "/other/TiboTattle.app"
        )
        let ownProcess = RunningApplicationDescriptor(
            bundleIdentifier: productIdentifier, processIdentifier: ownPID, bundlePath: "/other/TiboTattle.app"
        )
        let parentProcess = RunningApplicationDescriptor(
            bundleIdentifier: productIdentifier, processIdentifier: parentPID, bundlePath: "/other/TiboTattle.app"
        )
        guard classifyRunningApplication(selected, nativeApplicationPath: nativePath, ownPID: ownPID, parentPID: parentPID) == .selectedNative,
              classifyRunningApplication(unrelated, nativeApplicationPath: nativePath, ownPID: ownPID, parentPID: parentPID) == .ignored,
              classifyRunningApplication(otherSameIdentity, nativeApplicationPath: nativePath, ownPID: ownPID, parentPID: parentPID) == .otherSameIdentity,
              classifyRunningApplication(ownProcess, nativeApplicationPath: nativePath, ownPID: ownPID, parentPID: parentPID) == .ignored,
              classifyRunningApplication(parentProcess, nativeApplicationPath: nativePath, ownPID: ownPID, parentPID: parentPID) == .ignored
        else { throw BridgeFailure.invalidRequest }
        return [
            "schemaVersion": schemaVersion,
            "status": "process_classifier_ok",
        ]
    }

    private static func stopNativeApplications(_ nativeApplicationPath: String) throws {
        let nativeProcesses = nativeApplications(nativeApplicationPath)
        for application in nativeProcesses {
            guard application.terminate() else { throw BridgeFailure.nativeWriter }
        }

        let deadline = Date().addingTimeInterval(nativeStopTimeout)
        while Date() < deadline {
            if nativeApplications(nativeApplicationPath).isEmpty { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        throw BridgeFailure.nativeWriter
    }

    /// Read the same app-defaults domain as the released native predecessor.
    /// A same-identity `suiteName` is deliberately invalid on macOS; using it
    /// makes a signed helper reject every setting before handover begins.
    private static func readPreferences(startAtLogin: Bool) throws -> [String: Any] {
        let defaults = UserDefaults.standard
        let rawLanguage = defaults.string(forKey: nativeLanguageKey) ?? "system"
        let language: String
        switch rawLanguage {
        case "system": language = "system"
        case "en", "en-US": language = "en"
        case "zh-Hans": language = "zh-Hans"
        case "es": language = "es"
        default: throw BridgeFailure.preferences
        }
        let appearance = defaults.string(forKey: nativeAppearanceKey) ?? "system"
        guard ["system", "light", "dark"].contains(appearance) else {
            throw BridgeFailure.preferences
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

    private static func failureResponse(for error: Error, command: String?) -> [String: Any] {
        // Existing callers that only understand the legacy two-key failed
        // response retain it. Preparation alone gets a fixed private stage
        // code; no OS error, path, preference value, PID, or credential data
        // crosses this boundary.
        guard command == "--prepare" || command == "--prepare-preflight" else {
            return [
                "schemaVersion": schemaVersion,
                "status": "failed",
            ]
        }
        let failureStage: String
        switch error {
        case BridgeFailure.identity:
            failureStage = "identity"
        case BridgeFailure.nativeApplication, BridgeFailure.nativeVersion:
            failureStage = "native_application"
        case BridgeFailure.loginItemUnregister:
            failureStage = "login_item_unregister"
        case BridgeFailure.loginItemStatus:
            failureStage = "login_item_status"
        case BridgeFailure.loginItemRequiresApproval:
            failureStage = "login_item_requires_approval"
        case BridgeFailure.loginItemNotFound:
            failureStage = "login_item_not_found"
        case BridgeFailure.loginItemStatusUnknown:
            failureStage = "login_item_status_unknown"
        case BridgeFailure.nativeWriter:
            failureStage = "native_writer"
        case BridgeFailure.otherSameIdentityRunning:
            failureStage = "other_same_identity_running"
        case BridgeFailure.preferences:
            failureStage = "preferences"
        case BridgeFailure.invalidRequest:
            failureStage = "invalid_request"
        default:
            failureStage = "unknown"
        }
        return [
            "schemaVersion": schemaVersion,
            "status": "failed",
            "failureStage": failureStage,
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
