import Foundation
import ServiceManagement

/// The small status vocabulary exposed to the native UI.  The launcher only
/// claims that a login item is active when ServiceManagement reports
/// `.enabled`; a pending approval is kept distinct so the user gets an
/// actionable System Settings route instead of a misleading switch state.
enum LoginItemStatus: Equatable {
    case enabled
    case notRegistered
    case requiresApproval
    case unknown

    /// A fixed, path-free value for Data & Diagnostics. This deliberately
    /// describes only the state that ServiceManagement exposes; it never
    /// copies an OS error or a System Settings path into the receipt.
    var diagnosticValue: String {
        switch self {
        case .enabled:
            return "enabled"
        case .notRegistered:
            return "not_registered"
        case .requiresApproval:
            return "requires_approval"
        case .unknown:
            return "unavailable"
        }
    }
}

enum LoginItemOperation: String {
    case register
    case unregister
}

/// The operation result is intentionally based on a fresh service status
/// rather than assuming that a non-throwing call proves the requested state.
/// ServiceManagement can require a person to intervene in System Settings, so
/// each post-operation state gets a distinct, truthful UI path.
enum LoginItemOperationResult: Equatable {
    case confirmed
    case requiresApproval
    case notConfirmed
    case unavailable
    case failed

    var diagnosticValue: String {
        switch self {
        case .confirmed:
            return "confirmed"
        case .requiresApproval:
            return "requires_approval"
        case .notConfirmed:
            return "not_confirmed"
        case .unavailable:
            return "unavailable"
        case .failed:
            return "failed"
        }
    }
}

/// A small pure UI policy. Keeping it independent of AppKit lets the contract
/// smoke cover the four ServiceManagement states without touching the real
/// Login Items database.
struct LoginItemSettingsPresentation: Equatable {
    let isEnabled: Bool
    let isOn: Bool
    let showsPendingRemoval: Bool
}

func loginItemSettingsPresentation(
    for status: LoginItemStatus
) -> LoginItemSettingsPresentation {
    switch status {
    case .enabled:
        return LoginItemSettingsPresentation(
            isEnabled: true,
            isOn: true,
            showsPendingRemoval: false
        )
    case .notRegistered:
        return LoginItemSettingsPresentation(
            isEnabled: true,
            isOn: false,
            showsPendingRemoval: false
        )
    case .requiresApproval:
        // A disabled off switch would otherwise invite a misleading second
        // register request. The explicit removal action below is the only
        // truthful way to withdraw a pending service request.
        return LoginItemSettingsPresentation(
            isEnabled: false,
            isOn: false,
            showsPendingRemoval: true
        )
    case .unknown:
        return LoginItemSettingsPresentation(
            isEnabled: false,
            isOn: false,
            showsPendingRemoval: false
        )
    }
}

func loginItemOperationResult(
    operation: LoginItemOperation,
    status: LoginItemStatus
) -> LoginItemOperationResult {
    switch (operation, status) {
    case (.register, .enabled), (.unregister, .notRegistered):
        return .confirmed
    case (.register, .requiresApproval):
        return .requiresApproval
    case (_, .unknown):
        return .unavailable
    case (.unregister, .requiresApproval),
            (.register, .notRegistered),
            (.unregister, .enabled):
        return .notConfirmed
    }
}

/// Some ServiceManagement calls can report an idempotency error after the
/// requested state became true (for example, another settings surface changed
/// it first). Reconcile only the states that can be established safely from a
/// follow-up status read; all other errors remain errors rather than being
/// guessed away.
func reconciledLoginItemOperationResultAfterError(
    operation: LoginItemOperation,
    status: LoginItemStatus
) -> LoginItemOperationResult? {
    let result = loginItemOperationResult(
        operation: operation,
        status: status
    )
    switch result {
    case .confirmed, .requiresApproval, .unavailable:
        return result
    case .notConfirmed, .failed:
        return nil
    }
}

enum LoginItemDiagnosticAction: String {
    case none
    case registerConfirmed = "register_confirmed"
    case registerRequiresApproval = "register_requires_approval"
    case registerNotConfirmed = "register_not_confirmed"
    case registerUnavailable = "register_unavailable"
    case registerFailed = "register_failed"
    case unregisterConfirmed = "unregister_confirmed"
    case unregisterNotConfirmed = "unregister_not_confirmed"
    case unregisterUnavailable = "unregister_unavailable"
    case unregisterFailed = "unregister_failed"

    static func make(
        operation: LoginItemOperation,
        result: LoginItemOperationResult
    ) -> LoginItemDiagnosticAction {
        switch (operation, result) {
        case (.register, .confirmed):
            return .registerConfirmed
        case (.register, .requiresApproval):
            return .registerRequiresApproval
        case (.register, .notConfirmed):
            return .registerNotConfirmed
        case (.register, .unavailable):
            return .registerUnavailable
        case (.register, .failed):
            return .registerFailed
        case (.unregister, .confirmed):
            return .unregisterConfirmed
        case (.unregister, .requiresApproval), (.unregister, .notConfirmed):
            return .unregisterNotConfirmed
        case (.unregister, .unavailable):
            return .unregisterUnavailable
        case (.unregister, .failed):
            return .unregisterFailed
        }
    }
}

/// The system API's underlying errors are intentionally not copied into the
/// UI or diagnostics.  They can contain OS-version-specific details; stable
/// operation values keep recovery copy deterministic and privacy-safe.
enum LoginItemOperationError: Error, Equatable {
    case registerFailed
    case unregisterFailed
}

/// Injectable boundary for ServiceManagement.  Production uses
/// `SystemLoginItemManager`; contract smokes and future unit tests inject a
/// fake and therefore never touch the user's real Login Items database.
protocol LoginItemManaging: AnyObject {
    var status: LoginItemStatus { get }

    func register() throws
    func unregister() throws
    func openSystemSettings()
}

/// First-run is the only path that may register by default.  Keeping this
/// helper free of status reads makes the no-silent-registration boundary
/// obvious: a launch or settings refresh can inspect status, but registration
/// happens only after the affirmative first-run action (or an explicit
/// settings toggle).
@discardableResult
func registerLoginItemForFirstRun(
    startAtLogin: Bool,
    manager: LoginItemManaging
) throws -> Bool {
    guard startAtLogin else { return false }
    try manager.register()
    return true
}

/// Direct adapter for Apple's modern login-item API.  The app's deployment
/// target is macOS 13.0, where `SMAppService.mainApp` is available.  No
/// LaunchAgent, daemon, helper, or second executable is involved.
final class SystemLoginItemManager: LoginItemManaging {
    private let service: SMAppService

    init(service: SMAppService = SMAppService.mainApp) {
        self.service = service
    }

    var status: LoginItemStatus {
        switch service.status {
        case .enabled:
            return .enabled
        case .notRegistered:
            return .notRegistered
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    func register() throws {
        do {
            try service.register()
        } catch {
            throw LoginItemOperationError.registerFailed
        }
    }

    func unregister() throws {
        do {
            try service.unregister()
        } catch {
            throw LoginItemOperationError.unregisterFailed
        }
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
