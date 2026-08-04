import Foundation
import UserNotifications
import Darwin

// MARK: - Fresh-provider notification boundary

/// The native shell accepts this tiny, closed contract only from the local
/// companion's just-finished foreground refresh. It is intentionally separate
/// from the dashboard overview, which may include cached, stale, mixed, or
/// log-derived evidence that must never drive a notification.
enum QuotaNotificationIneligibility: String, Equatable {
    case refreshFailed
    case providerUnavailable
    case stale
    case inferred
    case mixedSource
    case unobserved
    case unknown
    case logDerived
    case schemaChanged
    case resetProofMissing
}

enum ProviderQuotaResetProof: Equatable {
    /// Reserved for a future closed receipt that carries an opaque provider
    /// reset/window identity. The present app-server source does not expose
    /// this, so it cannot create reset notifications.
    case providerReportedIdentity(String)
    case unavailable

    var identity: String? {
        guard case let .providerReportedIdentity(value) = self else {
            return nil
        }
        return value
    }
}

struct FreshProviderQuotaWindow: Equatable {
    let lane: String
    let usedPercent: Double
    let durationMinutes: Int
    let resetAt: String
    let resetProof: ProviderQuotaResetProof
}

struct FreshProviderQuotaEvidence: Equatable {
    let observedAt: String
    /// A one-way local continuity partition. It is not a provider account
    /// subject and is never included in notification text or uploaded.
    let continuityKey: String
    let windows: [FreshProviderQuotaWindow]
}

enum ProviderQuotaNotificationEvidenceResult: Equatable {
    case fresh(FreshProviderQuotaEvidence)
    case ineligible(QuotaNotificationIneligibility)
}

protocol QuotaNotificationEvidenceProvider: AnyObject {
    func readFreshProviderQuotaEvidence(
        base: URL,
        expectedRefreshID: String,
        completion: @escaping (ProviderQuotaNotificationEvidenceResult) -> Void
    )
}

private let quotaNotificationEvidenceSchema =
    "tibotattle-notification-evidence-v2"
private let quotaNotificationAcceptedDurations = Set([300, 10_080])

private func hasExactKeys(
    _ dictionary: [String: Any],
    _ expected: Set<String>
) -> Bool {
    Set(dictionary.keys) == expected
}

private func canonicalNotificationDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: value), formatter.string(from: date) == value
    else {
        return nil
    }
    return date
}

private func validNotificationContinuityKey(_ value: String) -> Bool {
    guard value.utf8.count == 43 else { return false }
    return value.utf8.allSatisfy { byte in
        (65...90).contains(byte)
            || (97...122).contains(byte)
            || (48...57).contains(byte)
            || byte == 45
            || byte == 95
    }
}

private func validNotificationLaneKey(_ value: String) -> Bool {
    let pieces = value.split(separator: "|", omittingEmptySubsequences: false)
    guard pieces.count == 3,
          validNotificationContinuityKey(String(pieces[0])),
          ["primary", "secondary"].contains(String(pieces[1])),
          let duration = Int(pieces[2]),
          quotaNotificationAcceptedDurations.contains(duration)
    else {
        return false
    }
    return true
}

private func validProviderResetIdentity(_ value: String) -> Bool {
    guard (1...128).contains(value.utf8.count) else { return false }
    return value.utf8.allSatisfy { byte in
        (65...90).contains(byte)
            || (97...122).contains(byte)
            || (48...57).contains(byte)
            || byte == 45
            || byte == 46
            || byte == 95
    }
}

private func validLocalRefreshID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
}

private func validNotificationHandledKey(_ value: String) -> Bool {
    let pieces = value.split(separator: "|", omittingEmptySubsequences: false)
    guard let kind = pieces.first else { return false }
    switch kind {
    case "reset":
        guard (pieces.count == 5 || pieces.count == 6),
              validNotificationLaneKey(pieces[1...3].joined(separator: "|")),
              canonicalNotificationDate(String(pieces[4])) != nil,
              pieces.count == 5 || validProviderResetIdentity(String(pieces[5]))
        else {
            return false
        }
        return true
    case "threshold":
        guard pieces.count == 6,
              validNotificationLaneKey(pieces[1...3].joined(separator: "|")),
              canonicalNotificationDate(String(pieces[4])) != nil,
              let threshold = Int(pieces[5]),
              [80, 90].contains(threshold)
        else {
            return false
        }
        return true
    default:
        return false
    }
}

private func validNotificationRequestIdentifier(_ value: String) -> Bool {
    let prefix = "tibotattle-quota-"
    guard value.hasPrefix(prefix) else { return false }
    return validNotificationHandledKey(String(value.dropFirst(prefix.count)))
}

private func safeJSONNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, !(value is Bool) else { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
}

extension LocalCompanionEvidenceReader: QuotaNotificationEvidenceProvider {
    /// Reads the terminal refresh receipt, never the dashboard overview. A
    /// missing optional evidence projection is a deliberate ineligible state,
    /// not permission to fall back to the collector ledger.
    func readFreshProviderQuotaEvidence(
        base: URL,
        expectedRefreshID: String,
        completion: @escaping (ProviderQuotaNotificationEvidenceResult) -> Void
    ) {
        guard validLocalRefreshID(expectedRefreshID) else {
            completion(.ineligible(.unobserved))
            return
        }
        guard let url = loopbackEndpoint(base, path: "/api/local/refresh")
        else {
            completion(.ineligible(.providerUnavailable))
            return
        }
        let task = session.dataTask(with: request(url, method: "GET")) {
            data, response, _ in
            let result = Self.acceptedPayload(data, response).map {
                Self.decodeFreshProviderQuotaEvidence(
                    $0,
                    expectedRefreshID: expectedRefreshID
                )
            } ?? .ineligible(.providerUnavailable)
            DispatchQueue.main.async { completion(result) }
        }
        task.resume()
    }

    private static func decodeFreshProviderQuotaEvidence(
        _ data: Data,
        expectedRefreshID: String
    ) -> ProviderQuotaNotificationEvidenceResult {
        guard let root = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              let refresh = root["refresh"] as? [String: Any],
              let refreshStatus = refresh["status"] as? String
        else {
            return .ineligible(.schemaChanged)
        }
        guard refresh["refreshId"] as? String == expectedRefreshID,
              validLocalRefreshID(expectedRefreshID)
        else {
            // A terminal result without this exact opaque run token may be a
            // later refresh. Never let it borrow notification eligibility.
            return .ineligible(.unobserved)
        }
        guard refreshStatus == "succeeded" else {
            return refreshStatus == "failed"
                ? .ineligible(.refreshFailed)
                : .ineligible(.unobserved)
        }
        guard let result = refresh["result"] as? [String: Any]
        else {
            return .ineligible(.unobserved)
        }
        if let quotaRefresh = result["quotaRefresh"] as? [String: Any],
           quotaRefresh["errorCode"] != nil {
            return .ineligible(.providerUnavailable)
        }
        guard let rawEvidence = result["notificationEvidence"] as? [String: Any]
        else {
            return .ineligible(.unobserved)
        }
        return decodeFreshProviderQuotaEvidence(rawEvidence)
    }

    private static func decodeFreshProviderQuotaEvidence(
        _ raw: [String: Any]
    ) -> ProviderQuotaNotificationEvidenceResult {
        let evidenceKeys: Set<String> = [
            "continuityKey",
            "freshness",
            "observedAt",
            "provider",
            "schemaVersion",
            "source",
            "status",
            "windows",
        ]
        guard hasExactKeys(raw, evidenceKeys) else {
            return .ineligible(.schemaChanged)
        }
        guard raw["schemaVersion"] as? String == quotaNotificationEvidenceSchema
        else {
            return .ineligible(.schemaChanged)
        }
        guard raw["status"] as? String == "fresh_provider_observation"
        else {
            return .ineligible(.unknown)
        }
        guard raw["provider"] as? String == "openai_codex"
        else {
            return .ineligible(.mixedSource)
        }
        guard raw["source"] as? String == "app_server_read"
        else {
            return .ineligible(.mixedSource)
        }
        guard raw["freshness"] as? String == "fresh" else {
            return .ineligible(.stale)
        }
        guard let observedAt = raw["observedAt"] as? String,
              canonicalNotificationDate(observedAt) != nil,
              let continuityKey = raw["continuityKey"] as? String,
              validNotificationContinuityKey(continuityKey),
              let rawWindows = raw["windows"] as? [[String: Any]],
              !rawWindows.isEmpty,
              rawWindows.count <= 2
        else {
            return .ineligible(.schemaChanged)
        }
        let observedDate = canonicalNotificationDate(observedAt)
        var seenLanes = Set<String>()
        var windows: [FreshProviderQuotaWindow] = []
        for rawWindow in rawWindows {
            let windowKeys: Set<String> = [
                "durationMinutes",
                "lane",
                "resetAt",
                "resetProofKind",
                "usedPercent",
            ]
            guard hasExactKeys(rawWindow, windowKeys),
                  let lane = rawWindow["lane"] as? String,
                  ["primary", "secondary"].contains(lane),
                  !seenLanes.contains(lane),
                  let usedPercent = safeJSONNumber(rawWindow["usedPercent"]),
                  (0...100).contains(usedPercent),
                  let duration = rawWindow["durationMinutes"] as? Int,
                  quotaNotificationAcceptedDurations.contains(duration),
                  let resetAt = rawWindow["resetAt"] as? String,
                  let resetDate = canonicalNotificationDate(resetAt),
                  let observedDate,
                  resetDate > observedDate
            else {
                return .ineligible(.schemaChanged)
            }
            let resetProof: ProviderQuotaResetProof
            switch rawWindow["resetProofKind"] as? String {
            case "provider_reported_schedule_only":
                resetProof = .unavailable
            default:
                return .ineligible(.schemaChanged)
            }
            seenLanes.insert(lane)
            windows.append(FreshProviderQuotaWindow(
                lane: lane,
                usedPercent: usedPercent,
                durationMinutes: duration,
                resetAt: resetAt,
                resetProof: resetProof
            ))
        }
        return .fresh(FreshProviderQuotaEvidence(
            observedAt: observedAt,
            continuityKey: continuityKey,
            windows: windows.sorted { $0.lane < $1.lane }
        ))
    }
}

// MARK: - Notification-center seam

enum QuotaNotificationAuthorization: String, Codable, Equatable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
    case unknown

    var permitsDelivery: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral:
            true
        case .notDetermined, .denied, .unknown:
            false
        }
    }
}

struct LocalQuotaNotificationRequest: Equatable {
    let identifier: String
    let title: String
    let body: String
}

protocol LocalNotificationCenterAdapter: AnyObject {
    func authorizationStatus(
        completion: @escaping (QuotaNotificationAuthorization) -> Void
    )
    func requestAuthorization(
        completion: @escaping (QuotaNotificationAuthorization) -> Void
    )
    func submit(
        _ request: LocalQuotaNotificationRequest,
        completion: @escaping (Bool) -> Void
    )
    func removePendingRequests(withIdentifiers identifiers: [String])
}

final class UNUserNotificationCenterAdapter: LocalNotificationCenterAdapter {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus(
        completion: @escaping (QuotaNotificationAuthorization) -> Void
    ) {
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                completion(Self.map(settings.authorizationStatus))
            }
        }
    }

    func requestAuthorization(
        completion: @escaping (QuotaNotificationAuthorization) -> Void
    ) {
        // This call is reached only from an explicit Settings opt-in. There is
        // no launch-time prompt, retry loop, or background request.
        center.requestAuthorization(options: [.alert]) { _, _ in
            self.authorizationStatus(completion: completion)
        }
    }

    func submit(
        _ request: LocalQuotaNotificationRequest,
        completion: @escaping (Bool) -> Void
    ) {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.threadIdentifier = "tibotattle.quota"
        // `trigger: nil` requests immediate local delivery. No future date,
        // timer, schedule, network fetch, or background execution is added.
        center.add(UNNotificationRequest(
            identifier: request.identifier,
            content: content,
            trigger: nil
        )) { error in
            DispatchQueue.main.async { completion(error == nil) }
        }
    }

    func removePendingRequests(withIdentifiers identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    private static func map(
        _ status: UNAuthorizationStatus
    ) -> QuotaNotificationAuthorization {
        switch status {
        case .notDetermined:
            .notDetermined
        case .denied:
            .denied
        case .authorized:
            .authorized
        case .provisional:
            .provisional
        case .ephemeral:
            .ephemeral
        @unknown default:
            .unknown
        }
    }
}

// MARK: - Owner-only local state

enum QuotaNotificationThresholdMode: String, Codable, Equatable {
    case off
    case ninety
    case eightyAndNinety

    var thresholds: [Int] {
        switch self {
        case .off:
            []
        case .ninety:
            [90]
        case .eightyAndNinety:
            [80, 90]
        }
    }
}

struct QuotaNotificationPreferences: Codable, Equatable {
    var enabled = false
    var thresholdMode: QuotaNotificationThresholdMode = .off
    var resetEnabled = false
    var defaultsApplied = false
    var permissionPromptAttempted = false
}

struct QuotaNotificationBaseline: Codable, Equatable {
    let observedAt: String
    let usedPercent: Double
    let resetAt: String
    /// An optional, opaque reset/window identity. Current receipts never set
    /// it because they expose only a schedule. Keeping this separate prevents
    /// a schedule change from being treated as reset proof.
    let resetIdentity: String?

    init(
        observedAt: String,
        usedPercent: Double,
        resetAt: String,
        resetIdentity: String? = nil
    ) {
        self.observedAt = observedAt
        self.usedPercent = usedPercent
        self.resetAt = resetAt
        self.resetIdentity = resetIdentity
    }

    private enum CodingKeys: String, CodingKey {
        case observedAt
        case usedPercent
        case resetAt
        case resetIdentity
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        observedAt = try container.decode(String.self, forKey: .observedAt)
        usedPercent = try container.decode(Double.self, forKey: .usedPercent)
        resetAt = try container.decode(String.self, forKey: .resetAt)
        // v1 local state has no identity. It remains a baseline only; it can
        // never prove the first explicit reset transition after an upgrade.
        resetIdentity = try container.decodeIfPresent(
            String.self,
            forKey: .resetIdentity
        )
    }
}

struct QuotaNotificationPersistentState: Codable, Equatable {
    static let schemaVersion = "tibotattle-quota-notification-state-v1"

    let schemaVersion: String
    var preferences: QuotaNotificationPreferences
    var baselines: [String: QuotaNotificationBaseline]
    var handledKeys: [String]
    var pendingRequestIdentifiers: [String]

    static var empty: QuotaNotificationPersistentState {
        QuotaNotificationPersistentState(
            schemaVersion: schemaVersion,
            preferences: QuotaNotificationPreferences(),
            baselines: [:],
            handledKeys: [],
            pendingRequestIdentifiers: []
        )
    }

    mutating func clearEvaluationState() {
        baselines = [:]
        handledKeys = []
        pendingRequestIdentifiers = []
    }

    func isSafe() -> Bool {
        guard schemaVersion == Self.schemaVersion,
              baselines.count <= 256,
              handledKeys.count <= 512,
              pendingRequestIdentifiers.count <= 512
        else {
            return false
        }
        for (key, baseline) in baselines {
            guard validNotificationLaneKey(key),
                  canonicalNotificationDate(baseline.observedAt) != nil,
                  let resetAt = canonicalNotificationDate(baseline.resetAt),
                  let observedAt = canonicalNotificationDate(baseline.observedAt),
                  resetAt > observedAt,
                  baseline.usedPercent.isFinite,
                  (0...100).contains(baseline.usedPercent),
                  baseline.resetIdentity.map(validProviderResetIdentity) ?? true
            else {
                return false
            }
        }
        return handledKeys.allSatisfy(validNotificationHandledKey)
            && pendingRequestIdentifiers.allSatisfy(
                validNotificationRequestIdentifier
            )
    }
}

private enum QuotaNotificationStateStoreError: Error {
    case invalidState
    case writeFailed
    case lockFailed
}

protocol QuotaNotificationStateStore: AnyObject {
    func load() throws -> QuotaNotificationPersistentState
    func save(_ state: QuotaNotificationPersistentState) throws
}

final class OwnerOnlyQuotaNotificationStateStore: QuotaNotificationStateStore {
    private let file: URL
    private let lockFile: URL
    private static let processLock = NSLock()

    init(stateRoot: URL) {
        file = stateRoot.appendingPathComponent(
            "quota-notification-state-v1.json",
            isDirectory: false
        )
        lockFile = stateRoot.appendingPathComponent(
            "quota-notification-state-v1.lock",
            isDirectory: false
        )
    }

    func load() throws -> QuotaNotificationPersistentState {
        try withExclusiveLock {
            guard let bytes = try readExistingFile() else {
                return .empty
            }
            guard let state = try? JSONDecoder().decode(
                QuotaNotificationPersistentState.self,
                from: bytes
            ), state.isSafe()
            else {
                throw QuotaNotificationStateStoreError.invalidState
            }
            return state
        }
    }

    func save(_ state: QuotaNotificationPersistentState) throws {
        guard state.isSafe() else {
            throw QuotaNotificationStateStoreError.invalidState
        }
        try withExclusiveLock {
            // Refuse a bad existing target rather than replacing a symlink or
            // a foreign-owned file. `readExistingFile` opens with O_NOFOLLOW
            // and validates the descriptor it actually read.
            _ = try readExistingFile(requireContent: false)
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                var bytes = try encoder.encode(state)
                bytes.append(0x0a)
                try writeAtomically(bytes)
                guard let verified = try readExistingFile(), verified == bytes
                else {
                    throw QuotaNotificationStateStoreError.writeFailed
                }
            } catch let error as QuotaNotificationStateStoreError {
                throw error
            } catch {
                throw QuotaNotificationStateStoreError.writeFailed
            }
        }
    }

    private func withExclusiveLock<T>(
        _ body: () throws -> T
    ) throws -> T {
        Self.processLock.lock()
        defer { Self.processLock.unlock() }
        let descriptor = lockFile.path.withCString { path in
            open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        }
        guard descriptor >= 0 else {
            throw QuotaNotificationStateStoreError.lockFailed
        }
        defer { close(descriptor) }
        guard fchmod(descriptor, 0o600) == 0,
              try validateDescriptor(descriptor, requireContent: false),
              flock(descriptor, LOCK_EX) == 0
        else {
            throw QuotaNotificationStateStoreError.lockFailed
        }
        defer { _ = flock(descriptor, LOCK_UN) }
        return try body()
    }

    private func readExistingFile(
        requireContent: Bool = true
    ) throws -> Data? {
        let descriptor = file.path.withCString { path in
            open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        }
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw QuotaNotificationStateStoreError.invalidState
        }
        defer { close(descriptor) }
        guard try validateDescriptor(descriptor, requireContent: requireContent)
        else {
            throw QuotaNotificationStateStoreError.invalidState
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        do {
            let bytes = try handle.readToEnd() ?? Data()
            guard !requireContent || !bytes.isEmpty,
                  bytes.count <= 128 * 1_024
            else {
                throw QuotaNotificationStateStoreError.invalidState
            }
            return bytes
        } catch let error as QuotaNotificationStateStoreError {
            throw error
        } catch {
            throw QuotaNotificationStateStoreError.invalidState
        }
    }

    private func writeAtomically(_ bytes: Data) throws {
        let temporary = file.deletingLastPathComponent().appendingPathComponent(
            ".quota-notification-state-\(UUID().uuidString.lowercased())",
            isDirectory: false
        )
        let descriptor = temporary.path.withCString { path in
            open(
                path,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                0o600
            )
        }
        guard descriptor >= 0 else {
            throw QuotaNotificationStateStoreError.writeFailed
        }
        var committed = false
        defer {
            close(descriptor)
            if !committed { _ = unlink(temporary.path) }
        }
        guard fchmod(descriptor, 0o600) == 0,
              try validateDescriptor(descriptor, requireContent: false)
        else {
            throw QuotaNotificationStateStoreError.writeFailed
        }
        do {
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            try handle.write(contentsOf: bytes)
            guard fsync(descriptor) == 0,
                  rename(temporary.path, file.path) == 0
            else {
                throw QuotaNotificationStateStoreError.writeFailed
            }
            committed = true
        } catch let error as QuotaNotificationStateStoreError {
            throw error
        } catch {
            throw QuotaNotificationStateStoreError.writeFailed
        }
    }

    private func validateDescriptor(
        _ descriptor: Int32,
        requireContent: Bool
    ) throws -> Bool {
        var metadata = stat()
        if fstat(descriptor, &metadata) != 0 {
            throw QuotaNotificationStateStoreError.invalidState
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              metadata.st_nlink == 1,
              (metadata.st_mode & 0o077) == 0,
              !requireContent
                || (metadata.st_size > 0 && metadata.st_size <= 128 * 1_024)
        else {
            throw QuotaNotificationStateStoreError.invalidState
        }
        return true
    }
}

final class InMemoryQuotaNotificationStateStore: QuotaNotificationStateStore {
    var value: QuotaNotificationPersistentState
    var failWrites = false

    init(value: QuotaNotificationPersistentState = .empty) {
        self.value = value
    }

    func load() throws -> QuotaNotificationPersistentState { value }

    func save(_ state: QuotaNotificationPersistentState) throws {
        if failWrites { throw QuotaNotificationStateStoreError.writeFailed }
        value = state
    }
}

// MARK: - Eligibility, comparison, and delivery

enum QuotaNotificationStatus: Equatable {
    case disabled
    case stateUnavailable
    case awaitingPermission
    case permissionDenied
    case permissionUnknown
    case waitingForFreshProviderEvidence
    case ineligible(QuotaNotificationIneligibility)
    case firstObservationStored
    case noNewCrossing
    case delivered
    case deliveryUnavailable
}

struct QuotaNotificationSettingsPresentation: Equatable {
    let enabled: Bool
    let thresholdMode: QuotaNotificationThresholdMode
    let resetEnabled: Bool
    let resetAvailable: Bool
    let authorization: QuotaNotificationAuthorization
    let status: QuotaNotificationStatus
}

private enum QuotaNotificationCandidateKind {
    case threshold(Int)
    case reset
}

private struct QuotaNotificationCandidate {
    let kind: QuotaNotificationCandidateKind
    let eventKey: String
    let requestIdentifier: String
}

/// This coordinator owns no timer, daemon, network transport, or scheduler.
/// Its caller invokes `evaluate` only after TiboTattle's existing foreground
/// companion refresh reaches a terminal state.
@MainActor
final class QuotaNotificationCoordinator {
    private let stateStore: QuotaNotificationStateStore
    private let notificationCenter: LocalNotificationCenterAdapter
    private var state: QuotaNotificationPersistentState
    private var stateAvailable: Bool
    private var authorization: QuotaNotificationAuthorization = .unknown
    private var resetProofAvailable = false
    /// Invalidates asynchronous evidence and delivery callbacks whenever the
    /// user's preference boundary changes. A result from a former opt-in can
    /// never mutate a new session's baseline or Settings status.
    private var evaluationEpoch: UInt64 = 0
    private(set) var status: QuotaNotificationStatus
    var onPresentationChange: (() -> Void)?

    init(
        stateStore: QuotaNotificationStateStore,
        notificationCenter: LocalNotificationCenterAdapter
    ) {
        self.stateStore = stateStore
        self.notificationCenter = notificationCenter
        do {
            state = try stateStore.load()
            stateAvailable = true
            status = state.preferences.enabled
                ? .waitingForFreshProviderEvidence
                : .disabled
        } catch {
            state = .empty
            stateAvailable = false
            status = .stateUnavailable
        }
    }

    var presentation: QuotaNotificationSettingsPresentation {
        QuotaNotificationSettingsPresentation(
            enabled: stateAvailable && state.preferences.enabled,
            thresholdMode: state.preferences.thresholdMode,
            resetEnabled: state.preferences.resetEnabled && resetProofAvailable,
            resetAvailable: resetProofAvailable,
            authorization: authorization,
            status: status
        )
    }

    func refreshAuthorization() {
        guard stateAvailable else {
            setStatus(.stateUnavailable)
            return
        }
        let epoch = evaluationEpoch
        notificationCenter.authorizationStatus { [weak self] authorization in
            guard let self, self.evaluationEpoch == epoch else { return }
            self.applyAuthorization(authorization, mayPrompt: false)
        }
    }

    func setEnabled(_ enabled: Bool) {
        guard stateAvailable else {
            setStatus(.stateUnavailable)
            return
        }
        if !enabled {
            evaluationEpoch &+= 1
            let identifiers = state.pendingRequestIdentifiers
            // Disable delivery before writing any new state. Removing only
            // TiboTattle-owned pending IDs leaves unrelated notifications and
            // all accounting evidence untouched.
            notificationCenter.removePendingRequests(withIdentifiers: identifiers)
            state.preferences.enabled = false
            state.clearEvaluationState()
            guard persist() else { return }
            setStatus(.disabled)
            return
        }

        evaluationEpoch &+= 1
        state.preferences.enabled = true
        if !state.preferences.defaultsApplied {
            // Defaults exist only after this explicit opt-in. The current
            // provider receipt can prove threshold crossings but supplies a
            // reset schedule, not an observed reset identity, so reset alerts
            // deliberately remain off and unavailable.
            state.preferences.thresholdMode = .eightyAndNinety
            state.preferences.resetEnabled = false
            state.preferences.defaultsApplied = true
        }
        if !resetProofAvailable {
            state.preferences.resetEnabled = false
        }
        // Do not compare a post-opt-in observation with a hidden pre-opt-in
        // baseline. The first eligible observation always establishes state.
        state.clearEvaluationState()
        guard persist() else { return }
        setStatus(.waitingForFreshProviderEvidence)
        let epoch = evaluationEpoch
        notificationCenter.authorizationStatus { [weak self] authorization in
            guard let self, self.evaluationEpoch == epoch else { return }
            self.applyAuthorization(authorization, mayPrompt: true)
        }
    }

    func setThresholdMode(_ mode: QuotaNotificationThresholdMode) {
        guard stateAvailable, state.preferences.enabled else { return }
        evaluationEpoch &+= 1
        state.preferences.thresholdMode = mode
        state.clearEvaluationState()
        guard persist() else { return }
        setStatus(.waitingForFreshProviderEvidence)
    }

    func setResetEnabled(_ enabled: Bool) {
        guard stateAvailable, state.preferences.enabled else { return }
        evaluationEpoch &+= 1
        state.preferences.resetEnabled = enabled && resetProofAvailable
        state.clearEvaluationState()
        guard persist() else { return }
        setStatus(.waitingForFreshProviderEvidence)
    }

    func recordIneligible(_ reason: QuotaNotificationIneligibility) {
        guard stateAvailable, state.preferences.enabled else { return }
        // Do not bridge an ineligible interval with an older baseline. The
        // next fresh receipt must establish a new local comparison point,
        // rather than claim that a threshold transition was observed across
        // stale, mixed, inferred, unknown, or unobserved evidence. Keep
        // handled keys: they still prevent a prior, already-consumed event
        // from replaying after that conservative re-baselining.
        guard invalidateBaselines() else { return }
        guard authorization.permitsDelivery else {
            setStatus(statusForAuthorization())
            return
        }
        setStatus(.ineligible(reason))
    }

    func evaluate(
        using provider: QuotaNotificationEvidenceProvider,
        base: URL,
        expectedRefreshID: String
    ) {
        guard stateAvailable, state.preferences.enabled else { return }
        guard validLocalRefreshID(expectedRefreshID) else {
            recordIneligible(.unobserved)
            return
        }
        let epoch = evaluationEpoch
        provider.readFreshProviderQuotaEvidence(
            base: base,
            expectedRefreshID: expectedRefreshID
        ) { [weak self] result in
            guard let self, self.evaluationEpoch == epoch else { return }
            self.evaluate(result)
        }
    }

    func evaluate(_ result: ProviderQuotaNotificationEvidenceResult) {
        guard stateAvailable, state.preferences.enabled else { return }
        guard authorization.permitsDelivery else {
            guard invalidateBaselines() else { return }
            setStatus(statusForAuthorization())
            return
        }
        guard case let .fresh(evidence) = result else {
            if case let .ineligible(reason) = result {
                recordIneligible(reason)
            }
            return
        }
        evaluateFreshEvidence(evidence)
    }

    private func applyAuthorization(
        _ nextAuthorization: QuotaNotificationAuthorization,
        mayPrompt: Bool
    ) {
        authorization = nextAuthorization
        guard stateAvailable, state.preferences.enabled else {
            if stateAvailable { setStatus(.disabled) }
            return
        }
        if !nextAuthorization.permitsDelivery {
            // A system-permission interruption is also a break in observed
            // notification continuity. It cannot later become a crossing
            // from an old baseline when permission returns.
            guard invalidateBaselines() else { return }
        }
        guard mayPrompt,
              nextAuthorization == .notDetermined,
              !state.preferences.permissionPromptAttempted
        else {
            setStatus(statusForAuthorization())
            return
        }
        // Persist the one prompt attempt before presenting the system dialog;
        // relaunches and transient failures must not create a prompt loop.
        state.preferences.permissionPromptAttempted = true
        guard persist() else { return }
        setStatus(.awaitingPermission)
        let epoch = evaluationEpoch
        notificationCenter.requestAuthorization { [weak self] authorization in
            guard let self, self.evaluationEpoch == epoch else { return }
            self.applyAuthorization(authorization, mayPrompt: false)
        }
    }

    private func evaluateFreshEvidence(_ evidence: FreshProviderQuotaEvidence) {
        guard canonicalNotificationDate(evidence.observedAt) != nil,
              validNotificationContinuityKey(evidence.continuityKey),
              !evidence.windows.isEmpty
        else {
            setStatus(.ineligible(.schemaChanged))
            return
        }
        let supportsResetProof = evidence.windows.contains {
            $0.resetProof.identity != nil
        }
        resetProofAvailable = supportsResetProof
        var nextState = state
        // An older local state must not keep reset delivery enabled after a
        // current provider receipt shows that this source has only a schedule.
        if !supportsResetProof {
            nextState.preferences.resetEnabled = false
        }
        var sawFirstObservation = false
        var sawNewObservation = false
        var candidates: [QuotaNotificationCandidate] = []
        for window in evidence.windows.sorted(by: { $0.lane < $1.lane }) {
            guard ["primary", "secondary"].contains(window.lane),
                  (0...100).contains(window.usedPercent),
                  quotaNotificationAcceptedDurations.contains(window.durationMinutes),
                  let observedAt = canonicalNotificationDate(evidence.observedAt),
                  let resetAt = canonicalNotificationDate(window.resetAt),
                  resetAt > observedAt
            else {
                setStatus(.ineligible(.schemaChanged))
                return
            }
            let laneKey = [
                evidence.continuityKey,
                window.lane,
                String(window.durationMinutes),
            ].joined(separator: "|")
            guard let previous = nextState.baselines[laneKey] else {
                nextState.baselines[laneKey] = QuotaNotificationBaseline(
                    observedAt: evidence.observedAt,
                    usedPercent: window.usedPercent,
                    resetAt: window.resetAt,
                    resetIdentity: window.resetProof.identity
                )
                sawFirstObservation = true
                continue
            }
            guard let previousObservedAt = canonicalNotificationDate(previous.observedAt),
                  canonicalNotificationDate(previous.resetAt) != nil
            else {
                setStatus(.ineligible(.schemaChanged))
                return
            }
            // A relaunch, duplicate completion receipt, sleep/wake callback,
            // or reordered payload never produces a new comparison.
            guard observedAt > previousObservedAt else { continue }
            sawNewObservation = true
            let resetIdentityChanged: Bool
            if let previousIdentity = previous.resetIdentity,
               let currentIdentity = window.resetProof.identity {
                resetIdentityChanged = previousIdentity != currentIdentity
            } else {
                // A first identity, a missing identity, and a schedule-only
                // receipt do not prove a transition. The first eligible
                // identity is stored only as a later comparison baseline.
                resetIdentityChanged = false
            }
            let scheduleChanged = window.resetAt != previous.resetAt
            if scheduleChanged || resetIdentityChanged {
                nextState.baselines[laneKey] = QuotaNotificationBaseline(
                    observedAt: evidence.observedAt,
                    usedPercent: window.usedPercent,
                    resetAt: window.resetAt,
                    resetIdentity: window.resetProof.identity
                )
                if scheduleChanged {
                    // The provider's schedule partitions threshold dedupe for
                    // the next allowance window, but does not itself prove a
                    // reset notification. Thresholds are never compared
                    // across that boundary.
                    nextState.handledKeys.removeAll {
                        $0.hasPrefix("threshold|\(laneKey)|")
                            || $0.hasPrefix("reset|\(laneKey)|")
                    }
                }
                if nextState.preferences.resetEnabled,
                   resetIdentityChanged,
                   let identity = window.resetProof.identity {
                    let eventKey = "reset|\(laneKey)|\(window.resetAt)|\(identity)"
                    if !nextState.handledKeys.contains(eventKey) {
                        candidates.append(QuotaNotificationCandidate(
                            kind: .reset,
                            eventKey: eventKey,
                            requestIdentifier: "tibotattle-quota-\(eventKey)"
                        ))
                    }
                }
                // Thresholds are intentionally never compared across a
                // provider-reported schedule boundary: the new allowance
                // begins with its own baseline. Current receipts therefore
                // update state but never create reset alerts.
                continue
            }

            nextState.baselines[laneKey] = QuotaNotificationBaseline(
                observedAt: evidence.observedAt,
                usedPercent: window.usedPercent,
                resetAt: window.resetAt,
                resetIdentity: window.resetProof.identity
            )
            for threshold in nextState.preferences.thresholdMode.thresholds {
                let eventKey = "threshold|\(laneKey)|\(window.resetAt)|\(threshold)"
                if previous.usedPercent < Double(threshold),
                   window.usedPercent >= Double(threshold),
                   !nextState.handledKeys.contains(eventKey) {
                    candidates.append(QuotaNotificationCandidate(
                        kind: .threshold(threshold),
                        eventKey: eventKey,
                        requestIdentifier: "tibotattle-quota-\(eventKey)"
                    ))
                }
            }
        }

        guard !candidates.isEmpty else {
            state = nextState
            guard persist() else { return }
            setStatus(sawFirstObservation
                ? .firstObservationStored
                : sawNewObservation ? .noNewCrossing : .noNewCrossing)
            return
        }

        // One quiet notification maximum per foreground refresh. A reset is
        // preferred over thresholds; otherwise use the highest crossed
        // threshold. All simultaneous crossings are consumed before delivery
        // so a later callback cannot turn one refresh into an alert burst.
        let chosen = candidates.sorted(by: Self.candidatePrecedes).first!
        for candidate in candidates where !nextState.handledKeys.contains(candidate.eventKey) {
            nextState.handledKeys.append(candidate.eventKey)
        }
        if !nextState.pendingRequestIdentifiers.contains(chosen.requestIdentifier) {
            nextState.pendingRequestIdentifiers.append(chosen.requestIdentifier)
        }
        nextState.handledKeys = Array(nextState.handledKeys.suffix(512))
        nextState.pendingRequestIdentifiers = Array(
            nextState.pendingRequestIdentifiers.suffix(512)
        )
        nextState.baselines = Dictionary(
            nextState.baselines.sorted { $0.key < $1.key }.suffix(256),
            uniquingKeysWith: { _, newest in newest }
        )
        state = nextState
        guard persist() else { return }
        let deliveryEpoch = evaluationEpoch
        let requestIdentifier = chosen.requestIdentifier
        notificationCenter.submit(
            notificationRequest(for: chosen)
        ) { [weak self] delivered in
            guard let self,
                  self.evaluationEpoch == deliveryEpoch,
                  self.state.preferences.enabled,
                  self.state.pendingRequestIdentifiers.contains(requestIdentifier)
            else {
                return
            }
            self.setStatus(delivered ? .delivered : .deliveryUnavailable)
        }
    }

    private static func candidatePrecedes(
        _ left: QuotaNotificationCandidate,
        _ right: QuotaNotificationCandidate
    ) -> Bool {
        switch (left.kind, right.kind) {
        case (.reset, .threshold):
            true
        case (.threshold, .reset):
            false
        case let (.threshold(leftThreshold), .threshold(rightThreshold)):
            leftThreshold > rightThreshold
        case (.reset, .reset):
            left.eventKey < right.eventKey
        }
    }

    private func notificationRequest(
        for candidate: QuotaNotificationCandidate
    ) -> LocalQuotaNotificationRequest {
        switch candidate.kind {
        case let .threshold(threshold):
            return LocalQuotaNotificationRequest(
                identifier: candidate.requestIdentifier,
                title: TiboTattleLocalization.string(.notificationAllowanceTitle),
                body: TiboTattleLocalization.format(
                    .notificationAllowanceThresholdBody,
                    threshold
                )
            )
        case .reset:
            return LocalQuotaNotificationRequest(
                identifier: candidate.requestIdentifier,
                title: TiboTattleLocalization.string(.notificationResetTitle),
                body: TiboTattleLocalization.string(.notificationResetBody)
            )
        }
    }

    private func statusForAuthorization() -> QuotaNotificationStatus {
        switch authorization {
        case .authorized, .provisional, .ephemeral:
            .waitingForFreshProviderEvidence
        case .notDetermined:
            .awaitingPermission
        case .denied:
            .permissionDenied
        case .unknown:
            .permissionUnknown
        }
    }

    @discardableResult
    private func persist() -> Bool {
        do {
            try stateStore.save(state)
            return true
        } catch {
            stateAvailable = false
            setStatus(.stateUnavailable)
            return false
        }
    }

    /// Retain idempotency keys but discard comparison state whenever the app
    /// cannot prove continuous, eligible fresh-provider observations.
    @discardableResult
    private func invalidateBaselines() -> Bool {
        guard !state.baselines.isEmpty else { return true }
        state.baselines = [:]
        return persist()
    }

    private func setStatus(_ nextStatus: QuotaNotificationStatus) {
        status = nextStatus
        onPresentationChange?()
    }
}

// MARK: - Deterministic contract smoke test

@MainActor
enum QuotaNotificationContractSmokeTest {
    private final class FakeNotificationCenter: LocalNotificationCenterAdapter {
        var authorization: QuotaNotificationAuthorization
        var authorizationRequests = 0
        var requests: [LocalQuotaNotificationRequest] = []
        var removedIdentifiers: [String] = []
        var submitSucceeds = true
        var deferAuthorizationStatus = false
        var deferAuthorizationRequest = false
        var deferSubmitCompletion = false
        private var pendingAuthorizationStatus: ((QuotaNotificationAuthorization) -> Void)?
        private var pendingAuthorizationRequest: ((QuotaNotificationAuthorization) -> Void)?
        private var pendingSubmitCompletion: ((Bool) -> Void)?

        init(authorization: QuotaNotificationAuthorization) {
            self.authorization = authorization
        }

        func authorizationStatus(
            completion: @escaping (QuotaNotificationAuthorization) -> Void
        ) {
            if deferAuthorizationStatus {
                pendingAuthorizationStatus = completion
            } else {
                completion(authorization)
            }
        }

        func requestAuthorization(
            completion: @escaping (QuotaNotificationAuthorization) -> Void
        ) {
            authorizationRequests += 1
            if deferAuthorizationRequest {
                pendingAuthorizationRequest = completion
            } else {
                completion(authorization)
            }
        }

        func completePendingAuthorizationStatus() {
            let completion = pendingAuthorizationStatus
            pendingAuthorizationStatus = nil
            completion?(authorization)
        }

        func completePendingAuthorizationRequest() {
            let completion = pendingAuthorizationRequest
            pendingAuthorizationRequest = nil
            completion?(authorization)
        }

        func submit(
            _ request: LocalQuotaNotificationRequest,
            completion: @escaping (Bool) -> Void
        ) {
            requests.append(request)
            if deferSubmitCompletion {
                pendingSubmitCompletion = completion
            } else {
                completion(submitSucceeds)
            }
        }

        func completePendingSubmit(_ delivered: Bool? = nil) {
            let completion = pendingSubmitCompletion
            pendingSubmitCompletion = nil
            completion?(delivered ?? submitSucceeds)
        }

        func removePendingRequests(withIdentifiers identifiers: [String]) {
            removedIdentifiers.append(contentsOf: identifiers)
        }
    }

    private final class FakeEvidenceProvider: QuotaNotificationEvidenceProvider {
        var value: ProviderQuotaNotificationEvidenceResult
        var refreshIDs: [String] = []
        var deferCompletion = false
        private var pendingCompletion: ((ProviderQuotaNotificationEvidenceResult) -> Void)?

        init(_ value: ProviderQuotaNotificationEvidenceResult) {
            self.value = value
        }

        func readFreshProviderQuotaEvidence(
            base: URL,
            expectedRefreshID: String,
            completion: @escaping (ProviderQuotaNotificationEvidenceResult) -> Void
        ) {
            refreshIDs.append(expectedRefreshID)
            if deferCompletion {
                pendingCompletion = completion
            } else {
                completion(value)
            }
        }

        func completePendingRead() {
            let completion = pendingCompletion
            pendingCompletion = nil
            completion?(value)
        }
    }

    private static let continuityKey = String(repeating: "a", count: 43)
    private static let refreshID = "00000000-0000-4000-8000-000000000000"

    private static func evidence(
        observedAt: String,
        usedPercent: Double,
        resetAt: String,
        resetProof: ProviderQuotaResetProof = .unavailable
    ) -> ProviderQuotaNotificationEvidenceResult {
        .fresh(FreshProviderQuotaEvidence(
            observedAt: observedAt,
            continuityKey: continuityKey,
            windows: [FreshProviderQuotaWindow(
                lane: "primary",
                usedPercent: usedPercent,
                durationMinutes: 10_080,
                resetAt: resetAt,
                resetProof: resetProof
            )]
        ))
    }

    private static func require(_ condition: Bool, _ message: String) -> Bool {
        guard !condition else { return true }
        FileHandle.standardError.write(
            Data("macOS quota notification contract smoke failed: \(message)\\n".utf8)
        )
        return false
    }

    private static func ownerOnlyStateStoreRejectsSymlink() -> Bool {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(
            "tibotattle-quota-state-smoke-\(UUID().uuidString.lowercased())",
            isDirectory: true
        )
        let fileManager = FileManager.default
        defer { try? fileManager.removeItem(at: root) }
        do {
            try fileManager.createDirectory(
                at: root,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            let ownerOnly = OwnerOnlyQuotaNotificationStateStore(stateRoot: root)
            try ownerOnly.save(.empty)
            guard try ownerOnly.load() == .empty else { return false }
            let stateFile = root.appendingPathComponent(
                "quota-notification-state-v1.json",
                isDirectory: false
            )
            let target = root.appendingPathComponent("target", isDirectory: false)
            try Data("not notification state".utf8).write(to: target)
            try fileManager.removeItem(at: stateFile)
            try fileManager.createSymbolicLink(
                at: stateFile,
                withDestinationURL: target
            )
            do {
                _ = try ownerOnly.load()
                return false
            } catch {
                return true
            }
        } catch {
            return false
        }
    }

    static func run() -> Int32 {
        guard require(ownerOnlyStateStoreRejectsSymlink(),
                      "owner-only state store accepted a symlink")
        else { return 1 }
        let store = InMemoryQuotaNotificationStateStore()
        let center = FakeNotificationCenter(authorization: .authorized)
        let coordinator = QuotaNotificationCoordinator(
            stateStore: store,
            notificationCenter: center
        )
        coordinator.refreshAuthorization()
        guard require(center.authorizationRequests == 0, "prompt before opt-in")
        else { return 1 }
        coordinator.setEnabled(true)
        guard require(coordinator.presentation.enabled, "opt-in did not enable"),
              require(coordinator.presentation.thresholdMode == .eightyAndNinety,
                      "opt-in defaults missing"),
              require(!coordinator.presentation.resetEnabled,
                      "schedule-only reset default was enabled"),
              require(!coordinator.presentation.resetAvailable,
                      "schedule-only source claimed reset proof"),
              require(center.authorizationRequests == 0, "authorized state prompted")
        else { return 1 }

        let first = evidence(
            observedAt: "2026-08-03T10:00:00.000Z",
            usedPercent: 50,
            resetAt: "2026-08-10T10:00:00.000Z"
        )
        coordinator.evaluate(first)
        guard require(center.requests.isEmpty, "first observation notified")
        else { return 1 }

        let crossed = evidence(
            observedAt: "2026-08-03T10:05:00.000Z",
            usedPercent: 95,
            resetAt: "2026-08-10T10:00:00.000Z"
        )
        let provider = FakeEvidenceProvider(crossed)
        coordinator.evaluate(
            using: provider,
            base: URL(string: "http://127.0.0.1:1")!,
            expectedRefreshID: refreshID
        )
        guard require(center.requests.count == 1, "threshold crossing did not notify"),
              require(provider.refreshIDs == [refreshID], "refresh receipt was not bound"),
              require(center.requests[0].body.contains("90%"), "highest threshold not chosen"),
              require(!center.requests[0].body.contains("workspace")
                        && !center.requests[0].body.contains("account")
                        && !center.requests[0].body.contains("/")
                        && !center.requests[0].body.contains("2026"),
                      "notification content was not safe")
        else { return 1 }
        coordinator.evaluate(crossed)
        coordinator.evaluate(crossed)
        guard require(center.requests.count == 1, "duplicate observation notified")
        else { return 1 }

        for reason in [
            QuotaNotificationIneligibility.stale,
            .inferred,
            .mixedSource,
            .unobserved,
            .unknown,
            .logDerived,
            .schemaChanged,
            .refreshFailed,
            .providerUnavailable,
        ] {
            coordinator.evaluate(.ineligible(reason))
        }
        guard require(center.requests.count == 1, "ineligible evidence notified")
        else { return 1 }

        let interruptedStore = InMemoryQuotaNotificationStateStore()
        let interruptedCenter = FakeNotificationCenter(authorization: .authorized)
        let interrupted = QuotaNotificationCoordinator(
            stateStore: interruptedStore,
            notificationCenter: interruptedCenter
        )
        interrupted.refreshAuthorization()
        interrupted.setEnabled(true)
        interrupted.evaluate(first)
        interrupted.recordIneligible(.stale)
        interrupted.evaluate(crossed)
        guard require(interruptedCenter.requests.isEmpty,
                      "stale-to-fresh gap notified across an old baseline"),
              require(interrupted.presentation.status == .firstObservationStored,
                      "fresh receipt after an ineligible gap did not re-baseline")
        else { return 1 }

        let resetStore = InMemoryQuotaNotificationStateStore()
        let resetCenter = FakeNotificationCenter(authorization: .authorized)
        let resetCoordinator = QuotaNotificationCoordinator(
            stateStore: resetStore,
            notificationCenter: resetCenter
        )
        resetCoordinator.refreshAuthorization()
        resetCoordinator.setEnabled(true)
        // The production schema's `resetsAt` schedule changes here, but it
        // is intentionally insufficient to fire a reset alert.
        resetCoordinator.evaluate(evidence(
            observedAt: "2026-08-03T10:00:00.000Z",
            usedPercent: 70,
            resetAt: "2026-08-10T10:00:00.000Z"
        ))
        resetCoordinator.evaluate(evidence(
            observedAt: "2026-08-10T10:01:00.000Z",
            usedPercent: 4,
            resetAt: "2026-08-17T10:00:00.000Z"
        ))
        guard require(resetCenter.requests.isEmpty,
                      "reset schedule alone notified"),
              require(!resetCoordinator.presentation.resetEnabled,
                      "schedule-only receipt enabled reset delivery")
        else { return 1 }

        // This injected future-only adapter shape proves the gate itself:
        // two *explicit* opaque provider identities are required. It is not
        // emitted by the current app-server receipt.
        let explicitResetFirst = evidence(
            observedAt: "2026-08-17T10:02:00.000Z",
            usedPercent: 6,
            resetAt: "2026-08-24T10:00:00.000Z",
            resetProof: .providerReportedIdentity("window-2026-08-24")
        )
        resetCoordinator.evaluate(explicitResetFirst)
        guard require(resetCoordinator.presentation.resetAvailable,
                      "explicit reset identity did not expose availability")
        else { return 1 }
        resetCoordinator.setResetEnabled(true)
        resetCoordinator.evaluate(explicitResetFirst)
        resetCoordinator.evaluate(evidence(
            observedAt: "2026-08-24T10:01:00.000Z",
            usedPercent: 3,
            resetAt: "2026-08-31T10:00:00.000Z",
            resetProof: .providerReportedIdentity("window-2026-08-31")
        ))
        guard require(resetCenter.requests.count == 1,
                      "explicit provider reset identity did not notify"),
              require(resetCenter.requests[0].title ==
                        TiboTattleLocalization.string(.notificationResetTitle),
                      "reset content mismatch")
        else { return 1 }
        resetCoordinator.evaluate(evidence(
            observedAt: "2026-08-10T10:02:00.000Z",
            usedPercent: 6,
            resetAt: "2026-08-17T10:00:00.000Z"
        ))
        resetCoordinator.evaluate(evidence(
            observedAt: "2026-08-31T10:01:00.000Z",
            usedPercent: 3,
            resetAt: "2026-09-07T10:00:00.000Z",
            resetProof: .unavailable
        ))
        guard require(resetCenter.requests.count == 1,
                      "unproven reset notified")
        else { return 1 }

        let relaunchedCenter = FakeNotificationCenter(authorization: .authorized)
        let relaunched = QuotaNotificationCoordinator(
            stateStore: resetStore,
            notificationCenter: relaunchedCenter
        )
        relaunched.refreshAuthorization()
        relaunched.evaluate(evidence(
            observedAt: "2026-08-10T10:02:00.000Z",
            usedPercent: 6,
            resetAt: "2026-08-17T10:00:00.000Z"
        ))
        guard require(relaunchedCenter.requests.isEmpty,
                      "relaunch or sleep-wake duplicate notified")
        else { return 1 }

        let deniedStore = InMemoryQuotaNotificationStateStore()
        let deniedCenter = FakeNotificationCenter(authorization: .denied)
        let denied = QuotaNotificationCoordinator(
            stateStore: deniedStore,
            notificationCenter: deniedCenter
        )
        denied.setEnabled(true)
        denied.evaluate(first)
        guard require(deniedCenter.requests.isEmpty,
                      "denied authorization notified"),
              require(denied.presentation.status == .permissionDenied,
                      "denied authorization status missing")
        else { return 1 }

        let promptStore = InMemoryQuotaNotificationStateStore()
        let promptCenter = FakeNotificationCenter(authorization: .notDetermined)
        let prompted = QuotaNotificationCoordinator(
            stateStore: promptStore,
            notificationCenter: promptCenter
        )
        prompted.setEnabled(true)
        prompted.setEnabled(true)
        guard require(promptCenter.authorizationRequests == 1,
                      "permission prompt repeated or was not opt-in-only")
        else { return 1 }

        let authorizationRaceStore = InMemoryQuotaNotificationStateStore()
        let authorizationRaceCenter = FakeNotificationCenter(
            authorization: .notDetermined
        )
        authorizationRaceCenter.deferAuthorizationRequest = true
        let authorizationRace = QuotaNotificationCoordinator(
            stateStore: authorizationRaceStore,
            notificationCenter: authorizationRaceCenter
        )
        authorizationRace.setEnabled(true)
        authorizationRace.setEnabled(false)
        authorizationRaceCenter.completePendingAuthorizationRequest()
        guard require(authorizationRace.presentation.status == .disabled,
                      "old permission callback overwrote opt-out status"),
              require(authorizationRaceCenter.authorizationRequests == 1,
                      "authorization race created another prompt")
        else { return 1 }

        let provisionalStore = InMemoryQuotaNotificationStateStore()
        let provisionalCenter = FakeNotificationCenter(authorization: .provisional)
        let provisional = QuotaNotificationCoordinator(
            stateStore: provisionalStore,
            notificationCenter: provisionalCenter
        )
        provisional.setEnabled(true)
        provisional.evaluate(first)
        provisional.evaluate(crossed)
        guard require(provisionalCenter.requests.count == 1,
                      "provisional authorization was not handled")
        else { return 1 }

        let deliveryStore = InMemoryQuotaNotificationStateStore()
        let deliveryCenter = FakeNotificationCenter(authorization: .authorized)
        deliveryCenter.submitSucceeds = false
        let delivery = QuotaNotificationCoordinator(
            stateStore: deliveryStore,
            notificationCenter: deliveryCenter
        )
        delivery.refreshAuthorization()
        delivery.setEnabled(true)
        delivery.evaluate(first)
        delivery.evaluate(crossed)
        guard require(delivery.presentation.status == .deliveryUnavailable,
                      "delivery failure status missing")
        else { return 1 }
        delivery.evaluate(crossed)
        guard require(deliveryCenter.requests.count == 1,
                      "delivery failure retried an already handled event")
        else { return 1 }

        let delayedEvidenceStore = InMemoryQuotaNotificationStateStore()
        let delayedEvidenceCenter = FakeNotificationCenter(authorization: .authorized)
        let delayedEvidence = QuotaNotificationCoordinator(
            stateStore: delayedEvidenceStore,
            notificationCenter: delayedEvidenceCenter
        )
        delayedEvidence.refreshAuthorization()
        delayedEvidence.setEnabled(true)
        delayedEvidence.evaluate(first)
        let delayedProvider = FakeEvidenceProvider(crossed)
        delayedProvider.deferCompletion = true
        delayedEvidence.evaluate(
            using: delayedProvider,
            base: URL(string: "http://127.0.0.1:1")!,
            expectedRefreshID: refreshID
        )
        delayedEvidence.setEnabled(false)
        delayedEvidence.setEnabled(true)
        delayedProvider.completePendingRead()
        guard require(delayedEvidenceCenter.requests.isEmpty,
                      "old asynchronous evidence crossed a new opt-in epoch")
        else { return 1 }

        let delayedDeliveryStore = InMemoryQuotaNotificationStateStore()
        let delayedDeliveryCenter = FakeNotificationCenter(authorization: .authorized)
        delayedDeliveryCenter.deferSubmitCompletion = true
        let delayedDelivery = QuotaNotificationCoordinator(
            stateStore: delayedDeliveryStore,
            notificationCenter: delayedDeliveryCenter
        )
        delayedDelivery.refreshAuthorization()
        delayedDelivery.setEnabled(true)
        delayedDelivery.evaluate(first)
        delayedDelivery.evaluate(crossed)
        delayedDelivery.setEnabled(false)
        delayedDelivery.setEnabled(true)
        delayedDeliveryCenter.completePendingSubmit(true)
        guard require(delayedDelivery.presentation.status != .delivered,
                      "old delivery callback overwrote a new opt-in epoch"),
              require(!delayedDeliveryCenter.removedIdentifiers.isEmpty,
                      "opt-out did not clear delayed pending request")
        else { return 1 }

        let unknownStore = InMemoryQuotaNotificationStateStore()
        let unknownCenter = FakeNotificationCenter(authorization: .unknown)
        let unknown = QuotaNotificationCoordinator(
            stateStore: unknownStore,
            notificationCenter: unknownCenter
        )
        unknown.setEnabled(true)
        unknown.evaluate(first)
        guard require(unknownCenter.requests.isEmpty,
                      "unknown authorization notified"),
              require(unknown.presentation.status == .permissionUnknown,
                      "unknown authorization status missing")
        else { return 1 }

        let failedStateStore = InMemoryQuotaNotificationStateStore()
        failedStateStore.failWrites = true
        let failedStateCenter = FakeNotificationCenter(authorization: .authorized)
        let failedState = QuotaNotificationCoordinator(
            stateStore: failedStateStore,
            notificationCenter: failedStateCenter
        )
        failedState.setEnabled(true)
        failedState.evaluate(crossed)
        guard require(failedStateCenter.requests.isEmpty,
                      "unpersisted notification state delivered an alert"),
              require(failedState.presentation.status == .stateUnavailable,
                      "state-write failure status missing")
        else { return 1 }

        let disabledTriggersStore = InMemoryQuotaNotificationStateStore()
        let disabledTriggersCenter = FakeNotificationCenter(
            authorization: .authorized
        )
        let disabledTriggers = QuotaNotificationCoordinator(
            stateStore: disabledTriggersStore,
            notificationCenter: disabledTriggersCenter
        )
        disabledTriggers.refreshAuthorization()
        disabledTriggers.setEnabled(true)
        disabledTriggers.setThresholdMode(.off)
        disabledTriggers.setResetEnabled(false)
        disabledTriggers.evaluate(first)
        disabledTriggers.evaluate(crossed)
        disabledTriggers.evaluate(evidence(
            observedAt: "2026-08-10T10:01:00.000Z",
            usedPercent: 4,
            resetAt: "2026-08-17T10:00:00.000Z"
        ))
        guard require(disabledTriggersCenter.requests.isEmpty,
                      "disabled threshold or reset trigger notified")
        else { return 1 }

        coordinator.setEnabled(false)
        coordinator.evaluate(evidence(
            observedAt: "2026-08-03T10:10:00.000Z",
            usedPercent: 99,
            resetAt: "2026-08-10T10:00:00.000Z"
        ))
        guard require(!center.removedIdentifiers.isEmpty,
                      "opt-out did not clear pending IDs"),
              require(center.requests.count == 1, "opt-out allowed notification")
        else { return 1 }
        print(
            "USAGE_MONITOR_MACOS_QUOTA_NOTIFICATION_CONTRACT "
                + "opt_in=true fresh_only=true first_sample=false "
                + "threshold=true reset_schedule_suppressed=true "
                + "reset_identity_gate=true dedupe=true opt_out=true"
        )
        return 0
    }
}
