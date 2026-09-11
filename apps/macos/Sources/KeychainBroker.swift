import Foundation
import Security

/// An invalid storage identity or unavailable socketpair prevents creation.
/// The native launcher must fail before spawning a companion without its
/// private broker channel; legacy credential access is never a fallback.
struct ContributionDeviceKeychainBrokerUnavailable: Error {}

/// The only Keychain capabilities the companion can address. Service and
/// account strings never cross the wire; this signed app owns the mapping.
private enum BrokerKeychainCapability: String, CaseIterable {
    case exportIdentity = "export_identity"
    case accountObservation = "account_observation"
    case claudeSessionPseudonym = "claude_session_pseudonym"
    case contributionDevice = "contribution_device"

    private var serviceStem: String {
        switch self {
        case .exportIdentity: return "export-identity"
        case .accountObservation: return "account-observation"
        case .claudeSessionPseudonym: return "claude-session-pseudonym"
        case .contributionDevice: return "contribution-device"
        }
    }

    func modernService(for identity: BrokerKeychainIdentity) -> String {
        "\(identity.namespace).\(serviceStem).app.v1"
    }

    func legacyService(for identity: BrokerKeychainIdentity) -> String {
        "\(identity.namespace).\(serviceStem).v1"
    }
}

/// The bundle may select only one of these reviewed storage identities. An
/// arbitrary plist or environment value can never become a Keychain address.
private enum BrokerKeychainIdentity: Hashable {
    case stable
    case preview

    init?(namespace: String, account: String) {
        switch (namespace, account) {
        case ("app-usagemonitor", "installation"):
            self = .stable
        case ("app-usagemonitor.preview", "preview-installation"):
            self = .preview
        default:
            return nil
        }
    }

    var namespace: String {
        switch self {
        case .stable: return "app-usagemonitor"
        case .preview: return "app-usagemonitor.preview"
        }
    }

    var account: String {
        switch self {
        case .stable: return "installation"
        case .preview: return "preview-installation"
        }
    }
}

/// App-side broker for the closed set of Keychain capabilities the packaged
/// companion is permitted to address. The protocol maps four capabilities;
/// the current packaged-companion runtime graph consumes export identity,
/// account observation, and contribution device. Claude callback uses the
/// same fixed mapping from the standalone CLI/local-review composition.
///
/// The channel is a kernel-held socketpair: only the spawned companion owns
/// the peer descriptor, no secret enters argv or the environment, and each
/// request names one closed logical capability rather than arbitrary Keychain
/// attributes. Wire handling, admission and teardown use the broker queue.
/// Security calls share an app-process lock; explicitly approved interactive
/// reads run off-main without blocking the wire queue for a user's response.
///
/// New items are stored under `.app.v1` services with an ACL that trusts this
/// signed app and nothing else. On first use of an older keytar-backed item,
/// the broker reads the modern generation first. Only when it is absent and a
/// fixed legacy item is present does the app try its authenticated compatibility
/// helper. Three silent attempts share an app-process budget. Exhaustion returns
/// `migration_required` and exposes a quiet native approval action. No companion
/// request, refresh, or restart can authorize an interactive read. Only explicit
/// approval through the native UI may do so. Adoption preserves exact bytes and
/// the legacy recovery copy; it never broadens the modern app-only ACL.
///
/// Protocol v2 requires a fixed capability. Protocol v1 remains accepted only
/// for the historical contribution-device-only client and maps to that one
/// capability; it cannot widen authority.
final class ContributionDeviceKeychainBroker {
    static let environmentVariable = "USAGE_MONITOR_KEYCHAIN_BROKER_FD"
    private static let protocolVersion = 2
    private static let legacyProtocolVersion = 1
    private static let maximumFrameBytes = 4_096
    private static let storedSecretPattern = "^[A-Za-z0-9_-]{43}$"
    private static let nativeSmokeArguments = Set([
        "--app-link-smoke-test",
        "--central-smoke-test",
        "--codex-home-settings-smoke-test",
        "--diagnostics-smoke-test",
        "--first-run-contract-smoke-test",
        "--jitless-smoke-test",
        "--keychain-broker-contract-smoke-test",
        "--keychain-reset-contract-smoke-test",
        "--login-item-contract-smoke-test",
        "--menu-bar-contract-smoke-test",
        "--native-dashboard-chrome-smoke-test",
        "--native-dashboard-layout-smoke-test",
        "--native-dashboard-sidebar-recovery-smoke-test",
        "--native-keychain-migration-ui-contract-smoke-test",
        "--native-refresh-settings-contract-smoke-test",
        "--native-settings-layout-smoke-test",
        "--native-weekly-pace-projection-contract-smoke-test",
        "--quota-notification-contract-smoke-test",
        "--smoke-test",
        "--updater-contract-smoke-test",
        "--updater-feed-contract-smoke-test",
        "--watchdog-smoke-test",
    ])

    /// One app-process budget, also covering overlapping companion replacements.
    /// A wire request can consume silent attempts, never authorize a prompt.
    private final class MigrationState {
        struct Claim {
            let capability: BrokerKeychainCapability
            let identifier: UUID
        }
        private struct Address: Hashable {
            let identity: BrokerKeychainIdentity
            let capability: BrokerKeychainCapability
        }
        private struct Entry {
            var identifier = UUID()
            var attempts = 0
            var retrying = true
            var approving = false
        }
        private struct Observer {
            let identity: BrokerKeychainIdentity
            let callback: (KeychainMigrationStatus) -> Void
            var last: KeychainMigrationStatus
        }
        private let lock = NSLock()
        private var entries = [Address: Entry]()
        private var observers = [UUID: Observer]()

        private func snapshot(_ identity: BrokerKeychainIdentity) -> KeychainMigrationStatus {
            let selected = entries.filter { $0.key.identity == identity }.map(\.value)
            return KeychainMigrationStatus(
                pendingCount: selected.count,
                isRetrying: selected.contains { $0.retrying },
                isApproving: selected.contains { $0.approving }
            )
        }

        private func changed() {
            // Called with the state lock held. Callbacks always run later on
            // main, and identical snapshots cannot cause refresh loops.
            for (identifier, var observer) in observers {
                let next = snapshot(observer.identity)
                guard next != observer.last else { continue }
                observer.last = next
                observers[identifier] = observer
                let callback = observer.callback
                DispatchQueue.main.async { callback(next) }
            }
        }

        func observe(_ identifier: UUID, identity: BrokerKeychainIdentity,
                     callback: @escaping (KeychainMigrationStatus) -> Void) {
            lock.lock()
            let current = snapshot(identity)
            observers[identifier] = Observer(identity: identity, callback: callback, last: current)
            DispatchQueue.main.async { callback(current) }
            lock.unlock()
        }

        func removeObserver(_ identifier: UUID) {
            lock.lock(); defer { lock.unlock() }
            observers.removeValue(forKey: identifier)
        }

        func beginAutomatic(_ capability: BrokerKeychainCapability,
                            identity: BrokerKeychainIdentity) -> Claim? {
            lock.lock(); defer { lock.unlock() }
            let address = Address(identity: identity, capability: capability)
            guard entries[address] == nil, !snapshot(identity).isApproving else { return nil }
            let entry = Entry()
            entries[address] = entry
            changed()
            return Claim(capability: capability, identifier: entry.identifier)
        }

        func claimAttempt(_ claim: Claim,
                          identity: BrokerKeychainIdentity) -> Int? {
            lock.lock(); defer { lock.unlock() }
            let address = Address(identity: identity, capability: claim.capability)
            guard var entry = entries[address], entry.identifier == claim.identifier,
                  entry.retrying, entry.attempts < 3
            else { return nil }
            entry.attempts += 1
            entries[address] = entry
            return entry.attempts
        }

        @discardableResult
        func finish(_ capability: BrokerKeychainCapability,
                    identity: BrokerKeychainIdentity, success: Bool,
                    claim: Claim? = nil) -> Bool {
            lock.lock(); defer { lock.unlock() }
            let address = Address(identity: identity, capability: capability)
            if let claim {
                guard claim.capability == capability,
                      entries[address]?.identifier == claim.identifier else { return false }
            } else if let entry = entries[address], entry.retrying || entry.approving {
                // A concurrent ordinary read cannot finish another broker's
                // live migration or consume a newer reset-generation claim.
                return false
            }
            if success { entries.removeValue(forKey: address) }
            else if var entry = entries[address] {
                entry.retrying = false
                entry.approving = false
                entries[address] = entry
            }
            changed()
            return true
        }

        func allowsAdoption(_ claim: Claim, identity: BrokerKeychainIdentity) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard let entry = entries[Address(identity: identity, capability: claim.capability)]
            else { return false }
            return entry.identifier == claim.identifier && (entry.retrying || entry.approving)
        }

        /// Called under the process-wide Security lock, like adoption. Even a
        /// failed reset cancels the old read without discarding its retry budget.
        func invalidateForReset(_ capability: BrokerKeychainCapability,
                                identity: BrokerKeychainIdentity) {
            lock.lock(); defer { lock.unlock() }
            let address = Address(identity: identity, capability: capability)
            if var entry = entries[address] {
                entry.identifier = UUID()
                entry.retrying = false
                entry.approving = false
                entries[address] = entry
                changed()
            }
        }

        func completeReset(_ capability: BrokerKeychainCapability,
                           identity: BrokerKeychainIdentity) {
            lock.lock(); defer { lock.unlock() }
            entries.removeValue(forKey: Address(identity: identity, capability: capability))
            changed()
        }

        func isApproving(_ identity: BrokerKeychainIdentity) -> Bool {
            lock.lock(); defer { lock.unlock() }
            return snapshot(identity).isApproving
        }

        func isApproving(_ claim: Claim, identity: BrokerKeychainIdentity) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard let entry = entries[Address(identity: identity, capability: claim.capability)]
            else { return false }
            return entry.identifier == claim.identifier && entry.approving
        }

        func beginApproval(_ identity: BrokerKeychainIdentity) -> [Claim] {
            lock.lock(); defer { lock.unlock() }
            let current = snapshot(identity)
            guard current.needsApproval else { return [] }
            let pending = BrokerKeychainCapability.allCases.compactMap { capability -> Claim? in
                guard let entry = entries[Address(identity: identity, capability: capability)]
                else { return nil }
                return Claim(capability: capability, identifier: entry.identifier)
            }
            for claim in pending {
                let address = Address(identity: identity, capability: claim.capability)
                entries[address]?.approving = true
            }
            changed()
            return pending
        }

        func endApproval(_ identity: BrokerKeychainIdentity, claims: [Claim]) {
            lock.lock()
            defer { lock.unlock() }
            for claim in claims {
                let address = Address(identity: identity, capability: claim.capability)
                guard entries[address]?.identifier == claim.identifier else { continue }
                entries[address]?.approving = false
            }
            changed()
        }
    }

    private static let processMigrationState = MigrationState()
    // SecKeychainSetUserInteractionAllowed is process-wide. Serialize its scope
    // across broker instances and restore the previous setting, not always true.
    private static let keychainOperationLock = NSRecursiveLock()

    private let queue = DispatchQueue(
        label: "usage-monitor.keychain-broker"
    )
    private let keychainIdentity: BrokerKeychainIdentity
    private let parentDescriptor: Int32
    private var readSource: DispatchSourceRead?
    private var childHandle: FileHandle?
    private var pendingInput = Data()
    private var closed = false
    private let migrationState: MigrationState
    private let migrationObserverID = UUID()
    /// Process-memory implementation used only by terminal native contract
    /// probes. It models both generations and records the exact operation
    /// order, so the compiled broker can exercise migration and rollback
    /// without touching the developer's login Keychain. It is injected by the
    /// dedicated contract probe; other native smoke modes also receive an
    /// empty instance because an isolated HOME does not isolate Keychain.
    private final class EphemeralSmokeStorage {
        var modern = [BrokerKeychainCapability: String]()
        var legacy = [BrokerKeychainCapability: String]()
        var deniedLegacyReads = Set<BrokerKeychainCapability>()
        var silentFailuresRemaining = [BrokerKeychainCapability: Int]()
        var rejectedSilentReads = Set<BrokerKeychainCapability>()
        var conflictingMigrationWrites = Set<BrokerKeychainCapability>()
        var failedMigrationReadbacks = Set<BrokerKeychainCapability>()
        var migratedWrites = Set<BrokerKeychainCapability>()
        var failedLegacyDeletes = [BrokerKeychainCapability: String]()
        var failedModernDeletes = [BrokerKeychainCapability: String]()
        var silentReadStarted: DispatchSemaphore?
        var silentReadResume: DispatchSemaphore?
        var interactiveReadStarted: DispatchSemaphore?
        var interactiveReadResume: DispatchSemaphore?
        var beforeApprovalAdmission: DispatchSemaphore?
        var resumeApprovalAdmission: DispatchSemaphore?
        var trace = [String]()
    }

    private let ephemeralSmokeStorage: EphemeralSmokeStorage?

    convenience init(namespace: String, account: String) throws {
        guard let identity = BrokerKeychainIdentity(
            namespace: namespace,
            account: account
        ) else {
            throw ContributionDeviceKeychainBrokerUnavailable()
        }
        try self.init(
            smokeStorage: nil,
            migrationState: nil,
            keychainIdentity: identity
        )
    }

    private init(
        smokeStorage: EphemeralSmokeStorage?,
        migrationState injectedMigrationState: MigrationState? = nil,
        keychainIdentity: BrokerKeychainIdentity = .stable
    ) throws {
        self.keychainIdentity = keychainIdentity
        let isNativeSmoke = !Self.nativeSmokeArguments.isDisjoint(
            with: CommandLine.arguments.dropFirst()
        )
        let selectedSmokeStorage = smokeStorage
            ?? (isNativeSmoke ? EphemeralSmokeStorage() : nil)
        ephemeralSmokeStorage = selectedSmokeStorage
        migrationState = injectedMigrationState
            ?? (selectedSmokeStorage == nil
                ? Self.processMigrationState
                : MigrationState())
        var endpoints: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0 else {
            throw ContributionDeviceKeychainBrokerUnavailable()
        }
        for descriptor in endpoints {
            _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
            var noSignal: Int32 = 1
            _ = setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                &noSignal,
                socklen_t(MemoryLayout<Int32>.size)
            )
        }
        parentDescriptor = endpoints[0]
        _ = fcntl(parentDescriptor, F_SETFL, O_NONBLOCK)
        childHandle = FileHandle(
            fileDescriptor: endpoints[1],
            closeOnDealloc: true
        )
        let descriptor = parentDescriptor
        let source = DispatchSource.makeReadSource(
            fileDescriptor: descriptor,
            queue: queue
        )
        source.setEventHandler { [weak self] in
            self?.readAvailable()
        }
        source.setCancelHandler {
            close(descriptor)
        }
        readSource = source
        source.resume()
    }

    var childEndpoint: FileHandle? {
        queue.sync { childHandle }
    }

    func setMigrationStatusObserver(
        _ observer: @escaping (KeychainMigrationStatus) -> Void
    ) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.migrationState.observe(
                self.migrationObserverID, identity: self.keychainIdentity,
                callback: observer
            )
        }
    }

    /// This method is deliberately absent from both companion protocols. The
    /// composition root calls it only after an explained native confirmation.
    /// Interactive Security calls run off the broker queue: requests during
    /// approval receive a bounded deferral rather than timing out the channel.
    func approvePendingMigrations(completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self, !self.closed else {
                DispatchQueue.main.async { completion(false) }
                return
            }
            let pending = self.migrationState.beginApproval(self.keychainIdentity)
            guard !pending.isEmpty else {
                DispatchQueue.main.async { completion(false) }
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                var successful = true
                for claim in pending {
                    guard self.queue.sync(execute: { !self.closed }) else {
                        successful = false
                        break
                    }
                    let result = self.readApprovedMigration(claim)
                    let complete: Bool
                    if case .value(let stored) = result { complete = stored != nil }
                    else { complete = false }
                    let current = self.migrationState.finish(
                        claim.capability, identity: self.keychainIdentity,
                        success: complete, claim: claim
                    )
                    // Denial/cancellation never cascades into more prompts.
                    if !complete || !current { successful = false; break }
                }
                self.migrationState.endApproval(self.keychainIdentity, claims: pending)
                let finished = successful
                DispatchQueue.main.async { completion(finished) }
            }
        }
    }

    func closeChildEndpoint() {
        queue.async { [weak self] in
            guard let self, let handle = self.childHandle else { return }
            self.childHandle = nil
            try? handle.close()
        }
    }

    /// Completion is a writer barrier: queued automatic migrations have
    /// finished and off-queue approvals can no longer be admitted or adopted.
    /// Retain this broker until the barrier even if its owner has detached it.
    func shutdown(completion: @escaping () -> Void = {}) {
        queue.async {
            self.teardown()
            completion()
        }
    }

    private func teardown() {
        guard !closed else { return }
        closed = true
        migrationState.removeObserver(migrationObserverID)
        pendingInput.removeAll()
        if let source = readSource {
            readSource = nil
            source.cancel()
        }
        if let child = childHandle {
            childHandle = nil
            try? child.close()
        }
    }

    private func readAvailable() {
        guard !closed else { return }
        var buffer = [UInt8](repeating: 0, count: Self.maximumFrameBytes)
        let received = read(parentDescriptor, &buffer, buffer.count)
        if received == 0 {
            teardown()
            return
        }
        if received < 0 {
            if errno == EINTR || errno == EAGAIN { return }
            teardown()
            return
        }
        consume(Data(bytes: buffer, count: received))
    }

    private func consume(_ data: Data) {
        pendingInput.append(data)
        guard pendingInput.count <= Self.maximumFrameBytes else {
            teardown()
            return
        }
        while let newline = pendingInput.firstIndex(of: 0x0A) {
            let frame = pendingInput.prefix(upTo: newline)
            pendingInput.removeSubrange(...newline)
            handleFrame(Data(frame))
            if closed { return }
        }
    }

    private func requestCapability(
        _ request: [String: Any],
        version: Int
    ) -> BrokerKeychainCapability? {
        if version == Self.legacyProtocolVersion {
            guard request["capability"] == nil else { return nil }
            return .contributionDevice
        }
        guard version == Self.protocolVersion,
              let raw = request["capability"] as? String
        else { return nil }
        return BrokerKeychainCapability(rawValue: raw)
    }

    private func requestShapeIsValid(
        _ request: [String: Any],
        version: Int,
        operation: String
    ) -> Bool {
        guard ["get", "set", "delete"].contains(operation) else {
            return false
        }
        var expected = Set(["v", "id", "op"])
        if version == Self.protocolVersion { expected.insert("capability") }
        if operation == "set" { expected.insert("secret") }
        return Set(request.keys) == expected
    }

    private func handleFrame(_ frame: Data) {
        guard let parsed = try? JSONSerialization.jsonObject(with: frame),
              let request = parsed as? [String: Any],
              let version = request["v"] as? Int,
              let identifier = request["id"] as? Int,
              identifier > 0,
              let operation = request["op"] as? String,
              requestShapeIsValid(
                  request,
                  version: version,
                  operation: operation
              ),
              let capability = requestCapability(request, version: version)
        else {
            if let parsed = try? JSONSerialization.jsonObject(with: frame),
               let request = parsed as? [String: Any],
               let identifier = request["id"] as? Int,
               identifier > 0 {
                respond([
                    "id": identifier,
                    "ok": false,
                    "code": "invalid_request",
                ])
            } else {
                teardown()
            }
            return
        }

        // Explicit deletion may cancel a pending approval. It never waits on
        // an admitted interactive read, and no other wire operation can do so.
        if operation != "delete" && migrationState.isApproving(keychainIdentity) {
            respond(["id": identifier, "ok": false, "code": "migration_required"])
            return
        }
        switch operation {
        case "get":
            switch readOrMigrateSecret(capability) {
            case .value(let stored):
                respond([
                    "id": identifier,
                    "ok": true,
                    "secret": stored ?? NSNull(),
                ])
            case .failure(let code):
                respond(["id": identifier, "ok": false, "code": code])
            }
        case "set":
            guard let secret = request["secret"] as? String,
                  isValidStoredSecret(secret)
            else {
                respond([
                    "id": identifier,
                    "ok": false,
                    "code": "invalid_request",
                ])
                return
            }
            if let code = storeSecret(secret, capability: capability) {
                respond(["id": identifier, "ok": false, "code": code])
            } else {
                respond(["id": identifier, "ok": true])
            }
        case "delete":
            if let code = deleteSecret(capability: capability) {
                respond(["id": identifier, "ok": false, "code": code])
            } else {
                respond(["id": identifier, "ok": true])
            }
        default:
            respond(["id": identifier, "ok": false, "code": "invalid_request"])
        }
    }

    private func respond(_ payload: [String: Any]) {
        guard !closed,
              var data = try? JSONSerialization.data(withJSONObject: payload)
        else {
            teardown()
            return
        }
        data.append(0x0A)
        let descriptor = parentDescriptor
        let delivered = data.withUnsafeBytes {
            (buffer: UnsafeRawBufferPointer) -> Bool in
            guard let base = buffer.baseAddress else { return false }
            var offset = 0
            while offset < buffer.count {
                let written = write(
                    descriptor,
                    base.advanced(by: offset),
                    buffer.count - offset
                )
                if written <= 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += written
            }
            return true
        }
        if !delivered { teardown() }
    }

    // MARK: - Keychain operations (login keychain, app-created items)

    private enum Generation {
        case modern
        case legacy
    }

    private func baseQuery(
        _ capability: BrokerKeychainCapability,
        generation: Generation
    ) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: generation == .modern
                ? capability.modernService(for: keychainIdentity)
                : capability.legacyService(for: keychainIdentity),
            kSecAttrAccount as String: keychainIdentity.account,
        ]
    }

    private func isValidStoredSecret(_ stored: String) -> Bool {
        stored.range(
            of: Self.storedSecretPattern,
            options: .regularExpression
        ) != nil
    }

    /// Only explicit native approval calls this with true. A failed attempt to
    /// set the policy never proceeds to the Keychain operation.
    private func withUserInteraction<T>(
        _ allowed: Bool,
        _ body: () -> T,
        failure: T
    ) -> T {
        Self.keychainOperationLock.lock()
        defer { Self.keychainOperationLock.unlock() }
        var previous: DarwinBoolean = false
        guard SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess,
              SecKeychainSetUserInteractionAllowed(allowed) == errSecSuccess
        else { return failure }
        defer { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
        return body()
    }

    private static func failureCode(_ status: OSStatus) -> String {
        switch status {
        case errSecInteractionNotAllowed:
            return "locked"
        case errSecAuthFailed, errSecUserCanceled:
            return "denied"
        default:
            return "operation_failed"
        }
    }

    private enum ReadOutcome {
        case value(String?)
        case failure(String)
    }

    private func readSecret(
        _ capability: BrokerKeychainCapability,
        generation: Generation,
        allowInteraction: Bool = false,
        migrationClaim: MigrationState.Claim? = nil
    ) -> ReadOutcome {
        Self.keychainOperationLock.lock()
        defer { Self.keychainOperationLock.unlock() }
        if allowInteraction {
            // Queue-ordered admission is the start of an approved read. Check
            // after acquiring the process-wide Security lock, not before a
            // potentially slow preflight or another in-flight Keychain call.
            // Reset can end deferral while this thread waits for the lock.
            // Reject its canceled claim before waiting on a wire queue that
            // may now be handling a normal (non-deferred) Keychain request.
            guard let migrationClaim, migrationClaim.capability == capability,
                  migrationState.isApproving(migrationClaim, identity: keychainIdentity),
                  queue.sync(execute: {
                !closed && migrationState.isApproving(migrationClaim, identity: keychainIdentity)
            }) else { return .failure("migration_required") }
        }
        if let smoke = ephemeralSmokeStorage {
            let generationName = generation == .modern ? "modern" : "legacy"
            smoke.trace.append(
                "read:\(generationName):\(capability.rawValue):"
                    + "interactive=\(allowInteraction)"
            )
            if generation == .legacy, allowInteraction {
                smoke.interactiveReadStarted?.signal()
                if let resume = smoke.interactiveReadResume,
                   resume.wait(timeout: .now() + 2) != .success {
                    return .failure("denied")
                }
            }
            if generation == .legacy,
               allowInteraction,
               smoke.deniedLegacyReads.contains(capability) {
                return .failure("denied")
            }
            if generation == .modern,
               smoke.migratedWrites.contains(capability),
               smoke.failedMigrationReadbacks.contains(capability) {
                return .failure("operation_failed")
            }
            return .value(
                generation == .modern
                    ? smoke.modern[capability]
                    : smoke.legacy[capability]
            )
        }
        var query = baseQuery(capability, generation: generation)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = withUserInteraction(allowInteraction, {
            SecItemCopyMatching(query as CFDictionary, &item)
        }, failure: errSecInteractionNotAllowed)
        if status == errSecItemNotFound { return .value(nil) }
        guard status == errSecSuccess else {
            return .failure(Self.failureCode(status))
        }
        guard let data = item as? Data,
              let stored = String(data: data, encoding: .utf8),
              isValidStoredSecret(stored)
        else {
            return .failure("operation_failed")
        }
        return .value(stored)
    }

    private enum PresenceOutcome {
        case present
        case missing
        case failure(String)
    }

    private func legacyPresence(
        _ capability: BrokerKeychainCapability
    ) -> PresenceOutcome {
        if let smoke = ephemeralSmokeStorage {
            smoke.trace.append("presence:legacy:\(capability.rawValue)")
            return smoke.legacy[capability] == nil ? .missing : .present
        }
        var query = baseQuery(capability, generation: .legacy)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnAttributes as String] = true
        var item: CFTypeRef?
        let status = withUserInteraction(false, {
            SecItemCopyMatching(query as CFDictionary, &item)
        }, failure: errSecInteractionNotAllowed)
        if status == errSecItemNotFound { return .missing }
        if status == errSecSuccess { return .present }
        return .failure(Self.failureCode(status))
    }

    private func readOrMigrateSecret(
        _ capability: BrokerKeychainCapability
    ) -> ReadOutcome {
        switch readSecret(capability, generation: .modern) {
        case .value(let stored) where stored != nil:
            migrationState.finish(capability, identity: keychainIdentity, success: true)
            return .value(stored)
        case .failure(let code):
            return .failure(code)
        case .value:
            break
        }
        switch legacyPresence(capability) {
        case .missing:
            migrationState.finish(capability, identity: keychainIdentity, success: true)
            return .value(nil)
        case .failure(let code):
            return .failure(code)
        case .present:
            break
        }
        guard let claim = migrationState.beginAutomatic(capability, identity: keychainIdentity) else {
            return .failure("migration_required")
        }
        // Backoff is off-main and totals one second. Each helper exchange has
        // a 1.5-second deadline; the companion deadline remains ten seconds.
        let delays: [TimeInterval] = [0, 0.25, 0.75]
        while let attempt = migrationState.claimAttempt(
            claim, identity: keychainIdentity
        ) {
            if ephemeralSmokeStorage == nil, delays[attempt - 1] > 0 {
                Thread.sleep(forTimeInterval: delays[attempt - 1])
            }
            switch readSilentMigration(capability) {
            case .value(let stored):
                if adoptMigratedSecret(stored, claim: claim),
                   migrationState.finish(capability, identity: keychainIdentity,
                                         success: true, claim: claim) {
                    return .value(stored)
                }
            case .missing, .unavailable:
                // Presence followed by an unreadable/missing value is not
                // authority to mint a replacement identity.
                break
            case .rejected:
                // Authentication/protocol rejection is not transient. Never
                // keep launching an untrusted helper.
                migrationState.finish(capability, identity: keychainIdentity,
                                      success: false, claim: claim)
                return .failure("migration_required")
            }
        }
        migrationState.finish(capability, identity: keychainIdentity, success: false, claim: claim)
        return .failure("migration_required")
    }

    private func readSilentMigration(
        _ capability: BrokerKeychainCapability
    ) -> KeychainMigrationRead {
        if let smoke = ephemeralSmokeStorage {
            let result: KeychainMigrationRead = {
                Self.keychainOperationLock.lock()
                defer { Self.keychainOperationLock.unlock() }
                smoke.trace.append("silent:legacy:\(capability.rawValue)")
                if smoke.rejectedSilentReads.contains(capability) { return .rejected }
                if let remaining = smoke.silentFailuresRemaining[capability], remaining > 0 {
                    smoke.silentFailuresRemaining[capability] = remaining - 1
                    return .unavailable
                }
                guard let stored = smoke.legacy[capability] else { return .missing }
                return .value(stored)
            }()
            // Model a separate helper that already read its value. It does not
            // hold the app's Security lock while a concurrent reset finishes.
            if case .value = result {
                smoke.silentReadStarted?.signal()
                if let resume = smoke.silentReadResume,
                   resume.wait(timeout: .now() + 2) != .success {
                    return .unavailable
                }
            }
            return result
        }
        guard let selected = KeychainMigrationCapability(rawValue: capability.rawValue)
        else { return .rejected }
        return LegacyKeychainMigration.read(
            selected,
            expectedIdentity: keychainIdentity == .stable ? .stable : .preview
        )
    }

    /// Reached only after native confirmation, never by a companion operation.
    /// Cancellation leaves both generations unchanged.
    private func readApprovedMigration(
        _ claim: MigrationState.Claim
    ) -> ReadOutcome {
        let capability = claim.capability
        guard migrationState.isApproving(claim, identity: keychainIdentity)
        else { return .failure("migration_required") }
        switch readSecret(capability, generation: .modern) {
        case .value(let stored) where stored != nil: return .value(stored)
        case .failure: return .failure("migration_required")
        case .value: break
        }
        guard case .present = legacyPresence(capability)
        else { return .failure("migration_required") }
        if let smoke = ephemeralSmokeStorage {
            smoke.beforeApprovalAdmission?.signal()
            if let resume = smoke.resumeApprovalAdmission,
               resume.wait(timeout: .now() + 2) != .success {
                return .failure("migration_required")
            }
        }
        guard case .value(let legacy?) = readSecret(
                capability, generation: .legacy, allowInteraction: true, migrationClaim: claim
              ) else { return .failure("migration_required") }
        // Teardown and adoption are ordered. An approval that outlives its
        // companion cannot commit into a retired broker generation.
        return queue.sync {
            guard !closed, adoptMigratedSecret(legacy, claim: claim)
            else { return .failure("migration_required") }
            return .value(legacy)
        }
    }

    private func adoptMigratedSecret(
        _ stored: String, claim: MigrationState.Claim
    ) -> Bool {
        Self.keychainOperationLock.lock()
        defer { Self.keychainOperationLock.unlock() }
        guard migrationState.allowsAdoption(claim, identity: keychainIdentity)
        else { return false }
        let capability = claim.capability
        var createdReference: Data?
        return KeychainMigrationAdoption.adopt(
            secret: stored,
            create: {
                switch self.addMigratedSecret(stored, capability: capability) {
                case .created(let reference):
                    createdReference = reference
                    return .created
                case .existingExact: return .existingExact
                case .failure: return .failed
                }
            },
            readBack: {
                if case .value(let value) = self.readSecret(capability, generation: .modern) {
                    return value
                }
                return nil
            },
            removeCreated: {
                self.rollbackMigratedSecret(capability, reference: createdReference)
            }
        )
    }

    private func designatedReaderAccess(
        _ label: String
    ) -> SecAccess? {
        var trustedSelf: SecTrustedApplication?
        guard SecTrustedApplicationCreateFromPath(nil, &trustedSelf)
            == errSecSuccess,
            let appTrust = trustedSelf
        else {
            return nil
        }
        var access: SecAccess?
        guard SecAccessCreate(
            label as CFString,
            [appTrust] as CFArray,
            &access
        ) == errSecSuccess else {
            return nil
        }
        return access
    }

    private func attributes(
        _ stored: String,
        capability: BrokerKeychainCapability
    ) -> [String: Any]? {
        let service = capability.modernService(for: keychainIdentity)
        guard let access = designatedReaderAccess(service)
        else { return nil }
        var selected = baseQuery(capability, generation: .modern)
        selected[kSecAttrLabel as String] = service
        selected[kSecValueData as String] = Data(stored.utf8)
        selected[kSecAttrAccess as String] = access
        return selected
    }

    private enum MigrationWriteOutcome {
        case created(Data?)
        case existingExact
        case failure(String)
    }

    private func addMigratedSecret(
        _ stored: String,
        capability: BrokerKeychainCapability
    ) -> MigrationWriteOutcome {
        if let smoke = ephemeralSmokeStorage {
            smoke.trace.append("add-migrated:modern:\(capability.rawValue)")
            if smoke.conflictingMigrationWrites.contains(capability) {
                smoke.modern[capability] = String(repeating: "C", count: 43)
            }
            if let existing = smoke.modern[capability] {
                return existing == stored
                    ? .existingExact
                    : .failure("operation_failed")
            }
            smoke.modern[capability] = stored
            smoke.migratedWrites.insert(capability)
            return .created(nil)
        }
        guard var selected = attributes(stored, capability: capability) else {
            return .failure("operation_failed")
        }
        selected[kSecReturnPersistentRef as String] = true
        var reference: CFTypeRef?
        let status = withUserInteraction(false, {
            SecItemAdd(selected as CFDictionary, &reference)
        }, failure: errSecInteractionNotAllowed)
        if status == errSecSuccess {
            guard let reference = reference as? Data, !reference.isEmpty
            else { return .failure("operation_failed") }
            return .created(reference)
        }
        guard status == errSecDuplicateItem else {
            return .failure(Self.failureCode(status))
        }
        switch readSecret(capability, generation: .modern) {
        case .value(let existing) where existing == stored:
            return .existingExact
        case .failure(let code):
            return .failure(code)
        default:
            return .failure("operation_failed")
        }
    }

    private func rollbackMigratedSecret(
        _ capability: BrokerKeychainCapability, reference: Data?
    ) {
        if ephemeralSmokeStorage != nil {
            _ = deleteItem(capability, generation: .modern)
            return
        }
        // The pre-existing readback rollback is narrowed to the just-created
        // modern item. It cannot remove a replacement at the same address.
        guard let reference else { return }
        _ = withUserInteraction(false, {
            SecItemDelete([kSecValuePersistentRef as String: reference] as CFDictionary)
        }, failure: errSecInteractionNotAllowed)
    }

    private func storeSecret(
        _ stored: String,
        capability: BrokerKeychainCapability
    ) -> String? {
        if let smoke = ephemeralSmokeStorage {
            smoke.trace.append("store:modern:\(capability.rawValue)")
            smoke.modern[capability] = stored
            smoke.migratedWrites.remove(capability)
            return nil
        }
        guard let selected = attributes(stored, capability: capability) else {
            return "operation_failed"
        }
        return withUserInteraction(false, {
            let status = SecItemAdd(selected as CFDictionary, nil)
            if status == errSecSuccess { return nil }
            guard status == errSecDuplicateItem else {
                return Self.failureCode(status)
            }
            // Never SecItemUpdate: a verify failure can make it silently
            // recreate the item with a default (wider) ACL.
            let removal = SecItemDelete(
                baseQuery(capability, generation: .modern) as CFDictionary
            )
            guard removal == errSecSuccess || removal == errSecItemNotFound
            else { return Self.failureCode(removal) }
            let replacement = SecItemAdd(selected as CFDictionary, nil)
            return replacement == errSecSuccess
                ? nil
                : Self.failureCode(replacement)
        }, failure: "locked")
    }

    private func deleteItem(
        _ capability: BrokerKeychainCapability,
        generation: Generation
    ) -> String? {
        if let smoke = ephemeralSmokeStorage {
            let generationName = generation == .modern ? "modern" : "legacy"
            smoke.trace.append(
                "delete:\(generationName):\(capability.rawValue)"
            )
            if let failure = generation == .modern
                ? smoke.failedModernDeletes[capability]
                : smoke.failedLegacyDeletes[capability] {
                return failure
            }
            if generation == .modern {
                smoke.modern.removeValue(forKey: capability)
                smoke.migratedWrites.remove(capability)
            } else {
                smoke.legacy.removeValue(forKey: capability)
            }
            return nil
        }
        let status = withUserInteraction(false, {
            SecItemDelete(
                baseQuery(capability, generation: generation) as CFDictionary
            )
        }, failure: errSecInteractionNotAllowed)
        if status == errSecSuccess || status == errSecItemNotFound {
            return nil
        }
        return Self.failureCode(status)
    }

    private func deleteSecret(
        capability: BrokerKeychainCapability
    ) -> String? {
        // An interactive read owns this lock while it asks the broker queue
        // for admission. Never block that same queue here: fail without
        // mutation if a read has already begun, allowing a deliberate retry.
        guard Self.keychainOperationLock.try() else { return "operation_failed" }
        defer { Self.keychainOperationLock.unlock() }
        migrationState.invalidateForReset(capability, identity: keychainIdentity)
        // This is a deliberate credential reset, never migration recovery.
        // Delete the retained recovery copy first. If it cannot be removed
        // silently, preserve the current modern credential and report failure.
        if let failure = deleteItem(capability, generation: .legacy) { return failure }
        if let failure = deleteItem(capability, generation: .modern) { return failure }
        migrationState.completeReset(capability, identity: keychainIdentity)
        return nil
    }

    // MARK: - Compiled native contract probe

    private struct SmokeFailure: Error {
        let message: String
    }

    private final class SmokePendingResponse {
        private let lock = NSLock()
        private let ready = DispatchSemaphore(value: 0)
        private var result: Result<[String: Any], Error>?

        func complete(_ result: Result<[String: Any], Error>) {
            lock.lock()
            self.result = result
            lock.unlock()
            ready.signal()
        }

        func wait() throws -> [String: Any] {
            guard ready.wait(timeout: .now() + 2) == .success else {
                throw SmokeFailure(message: "concurrent broker request did not finish")
            }
            lock.lock()
            defer { lock.unlock() }
            guard let result else {
                throw SmokeFailure(message: "concurrent broker result was missing")
            }
            return try result.get()
        }
    }

    private static func requireSmoke(
        _ condition: @autoclosure () throws -> Bool,
        _ message: String
    ) throws {
        guard try condition() else { throw SmokeFailure(message: message) }
    }

    private static func smokeResponse(
        _ broker: ContributionDeviceKeychainBroker,
        _ request: [String: Any]
    ) throws -> [String: Any] {
        guard let endpoint = broker.childEndpoint else {
            throw SmokeFailure(message: "missing child endpoint")
        }
        var frame = try JSONSerialization.data(withJSONObject: request)
        frame.append(0x0A)
        try endpoint.write(contentsOf: frame)

        var response = Data()
        while response.count <= Self.maximumFrameBytes {
            var descriptor = pollfd(
                fd: endpoint.fileDescriptor,
                events: Int16(POLLIN | POLLHUP | POLLERR),
                revents: 0
            )
            let ready = poll(&descriptor, 1, 2_000)
            guard ready > 0, descriptor.revents & Int16(POLLIN) != 0 else {
                throw SmokeFailure(message: "broker response timed out")
            }
            var byte: UInt8 = 0
            let count = withUnsafeMutableBytes(of: &byte) { buffer in
                read(endpoint.fileDescriptor, buffer.baseAddress, 1)
            }
            guard count == 1 else {
                throw SmokeFailure(message: "broker response closed early")
            }
            if byte == 0x0A {
                guard let parsed = try JSONSerialization.jsonObject(
                    with: response
                ) as? [String: Any] else {
                    throw SmokeFailure(message: "broker response was not an object")
                }
                return parsed
            }
            response.append(byte)
        }
        throw SmokeFailure(message: "broker response exceeded frame limit")
    }

    private static func requireSuccess(
        _ response: [String: Any],
        id: Int,
        secret: String? = nil
    ) throws {
        try requireSmoke(response["id"] as? Int == id, "response id drifted")
        try requireSmoke(response["ok"] as? Bool == true, "request failed")
        if let secret {
            try requireSmoke(
                response["secret"] as? String == secret,
                "response secret drifted"
            )
        }
    }

    private static func requireFailure(
        _ response: [String: Any],
        id: Int,
        code: String
    ) throws {
        try requireSmoke(response["id"] as? Int == id, "response id drifted")
        try requireSmoke(response["ok"] as? Bool == false, "failure became success")
        try requireSmoke(
            response["code"] as? String == code,
            "failure code drifted"
        )
    }

    private static func requireMalformedFrameClosure(
        _ broker: ContributionDeviceKeychainBroker
    ) throws {
        guard let endpoint = broker.childEndpoint else {
            throw SmokeFailure(message: "missing malformed-frame endpoint")
        }
        let duplicateDescriptor = dup(endpoint.fileDescriptor)
        guard duplicateDescriptor >= 0 else {
            throw SmokeFailure(message: "could not duplicate smoke endpoint")
        }
        let observer = FileHandle(
            fileDescriptor: duplicateDescriptor,
            closeOnDealloc: true
        )
        try endpoint.write(contentsOf: Data("{not-json}\n".utf8))
        var descriptor = pollfd(
            fd: observer.fileDescriptor,
            events: Int16(POLLIN | POLLHUP | POLLERR),
            revents: 0
        )
        let ready = poll(&descriptor, 1, 2_000)
        guard ready > 0 else {
            throw SmokeFailure(message: "malformed frame did not close broker")
        }
        if descriptor.revents & Int16(POLLHUP | POLLERR) != 0 { return }
        var byte: UInt8 = 0
        let count = withUnsafeMutableBytes(of: &byte) { buffer in
            read(observer.fileDescriptor, buffer.baseAddress, 1)
        }
        try requireSmoke(count == 0, "malformed frame produced a response")
    }

    /// Runs the compiled Swift implementation over its real socketpair while
    /// substituting only the Keychain store. No production Keychain API is
    /// reached. This is deliberately terminal and cannot turn into an app
    /// runtime mode.
    static func runContractSmokeTest() -> Int32 {
        do {
            var identifier = 1
            let capabilityStorage = EphemeralSmokeStorage()
            let capabilityBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: capabilityStorage
            )
            defer { capabilityBroker.shutdown() }
            for (offset, capability) in BrokerKeychainCapability.allCases
                .enumerated() {
                let scalar = UnicodeScalar(65 + offset)!
                let secret = String(repeating: Character(scalar), count: 43)
                let setResponse = try smokeResponse(capabilityBroker, [
                    "v": 2,
                    "id": identifier,
                    "op": "set",
                    "capability": capability.rawValue,
                    "secret": secret,
                ])
                try requireSuccess(setResponse, id: identifier)
                identifier += 1
                let getResponse = try smokeResponse(capabilityBroker, [
                    "v": 2,
                    "id": identifier,
                    "op": "get",
                    "capability": capability.rawValue,
                ])
                try requireSuccess(getResponse, id: identifier, secret: secret)
                identifier += 1
                let deleteResponse = try smokeResponse(capabilityBroker, [
                    "v": 2,
                    "id": identifier,
                    "op": "delete",
                    "capability": capability.rawValue,
                ])
                try requireSuccess(deleteResponse, id: identifier)
                identifier += 1
            }

            let v1Secret = String(repeating: "V", count: 43)
            try requireSuccess(
                try smokeResponse(capabilityBroker, [
                    "v": 1,
                    "id": identifier,
                    "op": "set",
                    "secret": v1Secret,
                ]),
                id: identifier
            )
            identifier += 1
            try requireSuccess(
                try smokeResponse(capabilityBroker, [
                    "v": 1,
                    "id": identifier,
                    "op": "get",
                ]),
                id: identifier,
                secret: v1Secret
            )
            identifier += 1
            try requireSuccess(
                try smokeResponse(capabilityBroker, [
                    "v": 1,
                    "id": identifier,
                    "op": "delete",
                ]),
                id: identifier
            )

            let migratedSecret = String(repeating: "M", count: 43)
            let migrationStorage = EphemeralSmokeStorage()
            migrationStorage.legacy[.exportIdentity] = migratedSecret
            let migrationBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: migrationStorage
            )
            defer { migrationBroker.shutdown() }
            try requireSuccess(
                try smokeResponse(migrationBroker, [
                    "v": 2,
                    "id": 101,
                    "op": "get",
                    "capability": BrokerKeychainCapability.exportIdentity.rawValue,
                ]),
                id: 101,
                secret: migratedSecret
            )
            try requireSmoke(
                migrationStorage.modern[.exportIdentity] == migratedSecret,
                "migration did not commit modern item"
            )
            try requireSmoke(
                migrationStorage.legacy[.exportIdentity] == migratedSecret,
                "migration changed the legacy recovery copy"
            )
            try requireSmoke(
                migrationStorage.trace == [
                    "read:modern:export_identity:interactive=false",
                    "presence:legacy:export_identity",
                    "silent:legacy:export_identity",
                    "add-migrated:modern:export_identity",
                    "read:modern:export_identity:interactive=false",
                ],
                "migration operation order drifted"
            )

            let delayedStorage = EphemeralSmokeStorage()
            delayedStorage.legacy[.contributionDevice] = migratedSecret
            delayedStorage.silentFailuresRemaining[.contributionDevice] = 2
            let delayedBroker = try ContributionDeviceKeychainBroker(smokeStorage: delayedStorage)
            defer { delayedBroker.shutdown() }
            try requireSuccess(try smokeResponse(delayedBroker, [
                "v": 2, "id": 102, "op": "get", "capability": "contribution_device",
            ]), id: 102, secret: migratedSecret)
            try requireSmoke(
                delayedStorage.trace.filter { $0 == "silent:legacy:contribution_device" }.count == 3
                    && !delayedStorage.trace.contains { $0.contains("interactive=true") }
                    && delayedStorage.legacy[.contributionDevice] == migratedSecret,
                "third silent attempt did not recover without interaction"
            )

            let deniedSecret = String(repeating: "D", count: 43)
            let deniedStorage = EphemeralSmokeStorage()
            deniedStorage.legacy[.accountObservation] = deniedSecret
            deniedStorage.deniedLegacyReads.insert(.accountObservation)
            deniedStorage.silentFailuresRemaining[.accountObservation] = 100
            let deniedMigrationState = MigrationState()
            let deniedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: deniedStorage,
                migrationState: deniedMigrationState
            )
            defer { deniedBroker.shutdown() }
            try requireFailure(
                try smokeResponse(deniedBroker, [
                    "v": 2,
                    "id": 201,
                    "op": "get",
                    "capability": BrokerKeychainCapability
                        .accountObservation.rawValue,
                ]),
                id: 201,
                code: "migration_required"
            )
            // A companion restart constructs a second broker while the signed
            // app process stays alive. A replacement cannot reset the silent
            // attempt budget or authorize a password prompt.
            let relaunchedDeniedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: deniedStorage,
                migrationState: deniedMigrationState
            )
            defer { relaunchedDeniedBroker.shutdown() }
            try requireFailure(
                try smokeResponse(relaunchedDeniedBroker, [
                    "v": 2,
                    "id": 202,
                    "op": "get",
                    "capability": BrokerKeychainCapability
                        .accountObservation.rawValue,
                ]),
                id: 202,
                code: "migration_required"
            )
            try requireSmoke(
                deniedStorage.legacy[.accountObservation] == deniedSecret
                    && deniedStorage.modern[.accountObservation] == nil,
                "denied migration changed stored state"
            )
            try requireSmoke(
                deniedStorage.trace.filter {
                    $0 == "silent:legacy:account_observation"
                }.count == 3
                    && !deniedStorage.trace.contains { $0.contains("interactive=true") },
                "refresh or companion restart escaped the silent-only budget"
            )
            for (offset, operation) in ["approve", "migrate", "reset_retry"].enumerated() {
                try requireFailure(try smokeResponse(relaunchedDeniedBroker, [
                    "v": 2, "id": 210 + offset, "op": operation,
                    "capability": "account_observation",
                ]), id: 210 + offset, code: "invalid_request")
            }
            try requireSmoke(
                !deniedStorage.trace.contains { $0.contains("interactive=true") },
                "a wire operation authorized interaction"
            )

            try requireSmoke(
                try waitForSmokeApproval(relaunchedDeniedBroker) == false,
                "denied explicit approval became success"
            )
            try requireSmoke(
                deniedStorage.legacy[.accountObservation] == deniedSecret
                    && deniedStorage.modern[.accountObservation] == nil
                    && deniedStorage.trace.filter {
                        $0 == "read:legacy:account_observation:interactive=true"
                    }.count == 1,
                "denial changed the key or raised extra approval attempts"
            )
            deniedStorage.deniedLegacyReads.remove(.accountObservation)
            try requireSmoke(
                try waitForSmokeApproval(relaunchedDeniedBroker),
                "deliberate retry did not adopt the existing key"
            )
            try requireSmoke(
                deniedStorage.modern[.accountObservation] == deniedSecret
                    && deniedStorage.legacy[.accountObservation] == deniedSecret,
                "explicit approval did not preserve the exact identity"
            )

            let conflictStorage = EphemeralSmokeStorage()
            conflictStorage.legacy[.exportIdentity] = migratedSecret
            conflictStorage.conflictingMigrationWrites.insert(.exportIdentity)
            let conflictBroker = try ContributionDeviceKeychainBroker(smokeStorage: conflictStorage)
            defer { conflictBroker.shutdown() }
            try requireFailure(try smokeResponse(conflictBroker, [
                "v": 2, "id": 250, "op": "get", "capability": "export_identity",
            ]), id: 250, code: "migration_required")
            try requireSmoke(
                conflictStorage.modern[.exportIdentity] == String(repeating: "C", count: 43)
                    && conflictStorage.legacy[.exportIdentity] == migratedSecret
                    && !conflictStorage.trace.contains { $0.hasPrefix("delete:") },
                "migration overwrote or removed a conflicting key"
            )

            let rejectedStorage = EphemeralSmokeStorage()
            rejectedStorage.legacy[.exportIdentity] = migratedSecret
            rejectedStorage.rejectedSilentReads.insert(.exportIdentity)
            let rejectedBroker = try ContributionDeviceKeychainBroker(smokeStorage: rejectedStorage)
            defer { rejectedBroker.shutdown() }
            try requireFailure(try smokeResponse(rejectedBroker, [
                "v": 2, "id": 260, "op": "get", "capability": "export_identity",
            ]), id: 260, code: "migration_required")
            try requireSmoke(
                rejectedStorage.trace.filter { $0 == "silent:legacy:export_identity" }.count == 1
                    && rejectedStorage.modern.isEmpty,
                "authentication rejection was retried or changed identity"
            )

            let rollbackSecret = String(repeating: "R", count: 43)
            let rollbackStorage = EphemeralSmokeStorage()
            rollbackStorage.legacy[.claudeSessionPseudonym] = rollbackSecret
            rollbackStorage.failedMigrationReadbacks.insert(
                .claudeSessionPseudonym
            )
            let rollbackBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: rollbackStorage
            )
            defer { rollbackBroker.shutdown() }
            try requireFailure(
                try smokeResponse(rollbackBroker, [
                    "v": 2,
                    "id": 301,
                    "op": "get",
                    "capability": BrokerKeychainCapability
                        .claudeSessionPseudonym.rawValue,
                ]),
                id: 301,
                code: "migration_required"
            )
            try requireSmoke(
                rollbackStorage.legacy[.claudeSessionPseudonym]
                    == rollbackSecret
                    && rollbackStorage.modern[.claudeSessionPseudonym] == nil,
                "failed readback did not roll back modern state"
            )

            let stoppedStorage = EphemeralSmokeStorage()
            stoppedStorage.legacy[.exportIdentity] = migratedSecret
            stoppedStorage.silentFailuresRemaining[.exportIdentity] = 3
            stoppedStorage.interactiveReadStarted = DispatchSemaphore(value: 0)
            stoppedStorage.interactiveReadResume = DispatchSemaphore(value: 0)
            let stoppedBroker = try ContributionDeviceKeychainBroker(smokeStorage: stoppedStorage)
            defer {
                stoppedStorage.interactiveReadResume?.signal()
                stoppedBroker.shutdown()
            }
            try requireFailure(try smokeResponse(stoppedBroker, [
                "v": 2, "id": 350, "op": "get", "capability": "export_identity",
            ]), id: 350, code: "migration_required")
            var stoppedResult: Bool?
            stoppedBroker.approvePendingMigrations { stoppedResult = $0 }
            try requireSmoke(
                stoppedStorage.interactiveReadStarted?.wait(timeout: .now() + 2) == .success,
                "native approval did not start its interactive read"
            )
            try requireFailure(try smokeResponse(stoppedBroker, [
                "v": 2, "id": 351, "op": "get", "capability": "export_identity",
            ]), id: 351, code: "migration_required")
            stoppedBroker.shutdown()
            // Drain the serial queue so shutdown precedes the resumed read.
            _ = stoppedBroker.childEndpoint
            stoppedStorage.interactiveReadResume?.signal()
            try runSmokeMainLoop(until: { stoppedResult != nil })
            try requireSmoke(
                stoppedResult == false && stoppedStorage.modern.isEmpty
                    && stoppedStorage.legacy[.exportIdentity] == migratedSecret,
                "a retired broker committed an in-flight approval"
            )

            let preflightStorage = EphemeralSmokeStorage()
            preflightStorage.legacy[.exportIdentity] = migratedSecret
            preflightStorage.silentFailuresRemaining[.exportIdentity] = 3
            preflightStorage.beforeApprovalAdmission = DispatchSemaphore(value: 0)
            preflightStorage.resumeApprovalAdmission = DispatchSemaphore(value: 0)
            let preflightBroker = try ContributionDeviceKeychainBroker(smokeStorage: preflightStorage)
            defer {
                preflightStorage.resumeApprovalAdmission?.signal()
                preflightBroker.shutdown()
            }
            try requireFailure(try smokeResponse(preflightBroker, [
                "v": 2, "id": 360, "op": "get", "capability": "export_identity",
            ]), id: 360, code: "migration_required")
            var preflightResult: Bool?
            preflightBroker.approvePendingMigrations { preflightResult = $0 }
            try requireSmoke(
                preflightStorage.beforeApprovalAdmission?.wait(timeout: .now() + 2) == .success,
                "approval preflight did not reach its admission boundary"
            )
            preflightBroker.shutdown()
            _ = preflightBroker.childEndpoint
            preflightStorage.resumeApprovalAdmission?.signal()
            try runSmokeMainLoop(until: { preflightResult != nil })
            try requireSmoke(
                preflightResult == false && preflightStorage.modern.isEmpty
                    && preflightStorage.legacy[.exportIdentity] == migratedSecret
                    && !preflightStorage.trace.contains { $0.contains("interactive=true") },
                "a retired broker admitted a new interactive read"
            )

            try runResetContractSmokeTests()
            try runShutdownRetentionSmokeTest()

            let malformedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: EphemeralSmokeStorage()
            )
            try requireMalformedFrameClosure(malformedBroker)

            print(
                "USAGE_MONITOR_MACOS_KEYCHAIN_BROKER_CONTRACT "
                    + "protocols=v1,v2 capabilities=4 "
                    + "migration=silent,third-attempt,bounded-restart,explicit-only,"
                    + "denied-preserved,conflict-preserved,readback-rollback,retired-cancelled "
                    + "malformed=closed keychain_access=0"
            )
            return 0
        } catch let failure as SmokeFailure {
            FileHandle.standardError.write(
                Data("Keychain broker contract failed: \(failure.message)\n".utf8)
            )
            return 1
        } catch {
            FileHandle.standardError.write(
                Data("Keychain broker contract failed\n".utf8)
            )
            return 1
        }
    }

    /// Deliberate credential reset exercises the real wire and migration state,
    /// with both Keychain generations replaced by process-memory fixtures.
    private static func runResetContractSmokeTests() throws {
        func response(_ broker: ContributionDeviceKeychainBroker,
                      _ operation: String, id: Int,
                      capability: BrokerKeychainCapability = .accountObservation) throws
            -> [String: Any] {
            try smokeResponse(broker, [
                "v": 2, "id": id, "op": operation, "capability": capability.rawValue,
            ])
        }
        func requireMissing(_ broker: ContributionDeviceKeychainBroker, id: Int,
                            capability: BrokerKeychainCapability = .accountObservation) throws {
            let value = try response(broker, "get", id: id, capability: capability)
            try requireSuccess(value, id: id)
            try requireSmoke(value["secret"] is NSNull, "reset credential was resurrected")
        }

        let original = String(repeating: "L", count: 43)
        let current = String(repeating: "N", count: 43)
        let stableStorage = EphemeralSmokeStorage()
        let previewStorage = EphemeralSmokeStorage()
        let sharedState = MigrationState()
        for capability in BrokerKeychainCapability.allCases {
            stableStorage.legacy[capability] = original
            stableStorage.modern[capability] = current
            previewStorage.legacy[capability] = String(repeating: "P", count: 43)
            previewStorage.modern[capability] = String(repeating: "Q", count: 43)
        }
        let stableBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: stableStorage, migrationState: sharedState
        )
        let previewBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: previewStorage, migrationState: sharedState, keychainIdentity: .preview
        )
        defer { stableBroker.shutdown(); previewBroker.shutdown() }

        let serviceStems: [BrokerKeychainCapability: String] = [
            .exportIdentity: "export-identity", .accountObservation: "account-observation",
            .claudeSessionPseudonym: "claude-session-pseudonym",
            .contributionDevice: "contribution-device",
        ]
        for capability in BrokerKeychainCapability.allCases {
            for (broker, namespace, account) in [
                (stableBroker, "app-usagemonitor", "installation"),
                (previewBroker, "app-usagemonitor.preview", "preview-installation"),
            ] {
                for (generation, suffix) in [(Generation.legacy, ".v1"), (.modern, ".app.v1")] {
                    let query = broker.baseQuery(capability, generation: generation)
                    try requireSmoke(
                        Set(query.keys) == Set([
                            kSecClass as String, kSecAttrService as String, kSecAttrAccount as String,
                        ])
                            && query[kSecClass as String] as? String == kSecClassGenericPassword as String
                            && query[kSecAttrService as String] as? String
                                == namespace + "." + serviceStems[capability]! + suffix
                            && query[kSecAttrAccount as String] as? String == account,
                        "reset address escaped its exact capability or namespace"
                    )
                }
            }

            for (broker, storage, otherStorage) in [
                (stableBroker, stableStorage, previewStorage),
                (previewBroker, previewStorage, stableStorage),
            ] {
                let otherModern = otherStorage.modern
                let otherLegacy = otherStorage.legacy
                let untouchedModern = storage.modern.filter { $0.key != capability }
                let untouchedLegacy = storage.legacy.filter { $0.key != capability }
                let traceStart = storage.trace.count
                try requireSuccess(try response(broker, "delete", id: 501, capability: capability), id: 501)
                try requireSmoke(
                    storage.modern == untouchedModern && storage.legacy == untouchedLegacy
                        && otherStorage.modern == otherModern && otherStorage.legacy == otherLegacy
                        && Array(storage.trace.dropFirst(traceStart)) == [
                            "delete:legacy:\(capability.rawValue)", "delete:modern:\(capability.rawValue)",
                        ],
                    "reset read a key, prompted, or changed another capability or namespace"
                )
                try requireSuccess(try response(broker, "delete", id: 502, capability: capability), id: 502)
                try requireMissing(broker, id: 503, capability: capability)
            }
        }
        // Historical protocol v1 still grants only the contribution capability.
        stableStorage.legacy[.contributionDevice] = original
        stableStorage.modern[.contributionDevice] = current
        stableStorage.legacy[.exportIdentity] = original
        stableStorage.modern[.exportIdentity] = current
        try requireSuccess(try smokeResponse(stableBroker, ["v": 1, "id": 504, "op": "delete"]), id: 504)
        try requireSmoke(
            stableStorage.legacy[.contributionDevice] == nil
                && stableStorage.modern[.contributionDevice] == nil
                && stableStorage.legacy[.exportIdentity] == original
                && stableStorage.modern[.exportIdentity] == current,
            "legacy protocol reset escaped the contribution capability"
        )

        for code in ["locked", "denied", "operation_failed"] {
            let storage = EphemeralSmokeStorage()
            storage.legacy[.accountObservation] = original
            storage.modern[.accountObservation] = current
            storage.failedLegacyDeletes[.accountObservation] = code
            let state = MigrationState()
            let broker = try ContributionDeviceKeychainBroker(smokeStorage: storage, migrationState: state)
            defer { broker.shutdown() }
            guard let oldClaim = state.beginAutomatic(.accountObservation, identity: .stable)
            else { throw SmokeFailure(message: "reset fixture could not claim migration") }
            _ = state.claimAttempt(oldClaim, identity: .stable)
            try requireFailure(try response(broker, "delete", id: 510), id: 510, code: code)
            try requireSmoke(
                storage.legacy[.accountObservation] == original
                    && storage.modern[.accountObservation] == current
                    && storage.trace == ["delete:legacy:account_observation"]
                    && !state.allowsAdoption(oldClaim, identity: .stable)
                    && state.claimAttempt(oldClaim, identity: .stable) == nil
                    && state.beginAutomatic(.accountObservation, identity: .stable) == nil,
                "failed legacy cleanup changed the key or reset a migration budget"
            )
            storage.failedLegacyDeletes.removeValue(forKey: .accountObservation)
            try requireSuccess(try response(broker, "delete", id: 511), id: 511)
            try requireMissing(broker, id: 512)
            try requireSmoke(
                storage.modern.isEmpty && storage.legacy.isEmpty
                    && !storage.trace.contains { $0.hasPrefix("silent:") || $0.contains("interactive=true") },
                "retry after failed legacy cleanup resurrected the key"
            )
        }

        let partialStorage = EphemeralSmokeStorage()
        partialStorage.legacy[.accountObservation] = original
        partialStorage.modern[.accountObservation] = current
        partialStorage.failedModernDeletes[.accountObservation] = "denied"
        let partialState = MigrationState()
        let partialBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: partialStorage, migrationState: partialState
        )
        defer { partialBroker.shutdown() }
        try requireFailure(try response(partialBroker, "delete", id: 520), id: 520, code: "denied")
        try requireSmoke(
            partialStorage.legacy.isEmpty && partialStorage.modern[.accountObservation] == current
                && partialStorage.trace == [
                    "delete:legacy:account_observation", "delete:modern:account_observation",
                ],
            "partial reset changed the current key or recreated a recovery copy"
        )
        partialStorage.failedModernDeletes.removeValue(forKey: .accountObservation)
        try requireSuccess(try response(partialBroker, "delete", id: 521), id: 521)
        let restartedPartialBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: partialStorage, migrationState: partialState
        )
        defer { restartedPartialBroker.shutdown() }
        try requireMissing(restartedPartialBroker, id: 522)

        // A helper may already hold a value when another companion generation
        // resets it. Its old claim must not add that value back afterward.
        let racingStorage = EphemeralSmokeStorage()
        racingStorage.legacy[.accountObservation] = original
        racingStorage.silentReadStarted = DispatchSemaphore(value: 0)
        racingStorage.silentReadResume = DispatchSemaphore(value: 0)
        let racingState = MigrationState()
        let readingBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: racingStorage, migrationState: racingState
        )
        let resettingBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: racingStorage, migrationState: racingState
        )
        defer {
            racingStorage.silentReadResume?.signal()
            readingBroker.shutdown(); resettingBroker.shutdown()
        }
        let pendingResponse = SmokePendingResponse()
        DispatchQueue.global(qos: .userInitiated).async {
            pendingResponse.complete(Result {
                try smokeResponse(readingBroker, [
                    "v": 2, "id": 530, "op": "get", "capability": "account_observation",
                ])
            })
        }
        try requireSmoke(
            racingStorage.silentReadStarted?.wait(timeout: .now() + 2) == .success,
            "silent reset fixture did not reach its post-read boundary"
        )
        try requireSuccess(try response(resettingBroker, "delete", id: 531), id: 531)
        racingStorage.silentReadResume?.signal()
        try requireFailure(try pendingResponse.wait(), id: 530, code: "migration_required")
        try requireMissing(resettingBroker, id: 532)
        try requireSmoke(
            racingStorage.modern.isEmpty && racingStorage.legacy.isEmpty
                && !racingStorage.trace.contains { $0.hasPrefix("add-migrated:") }
                && racingStorage.trace.filter { $0.hasPrefix("silent:") }.count == 1
                && racingState.beginApproval(.stable).isEmpty,
            "late helper adoption resurrected a reset credential"
        )

        // An approved read that has not yet been admitted can be canceled by
        // a wire reset, without enabling an OS dialog or adopting its old key.
        let admissionStorage = EphemeralSmokeStorage()
        admissionStorage.legacy[.accountObservation] = original
        admissionStorage.silentFailuresRemaining[.accountObservation] = 3
        admissionStorage.beforeApprovalAdmission = DispatchSemaphore(value: 0)
        admissionStorage.resumeApprovalAdmission = DispatchSemaphore(value: 0)
        let admissionState = MigrationState()
        let approvalBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: admissionStorage, migrationState: admissionState
        )
        let approvalResetBroker = try ContributionDeviceKeychainBroker(
            smokeStorage: admissionStorage, migrationState: admissionState
        )
        defer {
            admissionStorage.resumeApprovalAdmission?.signal()
            approvalBroker.shutdown(); approvalResetBroker.shutdown()
        }
        try requireFailure(try response(approvalBroker, "get", id: 540), id: 540, code: "migration_required")
        var admissionResult: Bool?
        approvalBroker.approvePendingMigrations { admissionResult = $0 }
        try requireSmoke(
            admissionStorage.beforeApprovalAdmission?.wait(timeout: .now() + 2) == .success,
            "approval reset fixture did not reach admission"
        )
        try requireSuccess(try response(approvalResetBroker, "delete", id: 541), id: 541)
        let admissionQueueBlocked = DispatchSemaphore(value: 0)
        let resumeAdmissionQueue = DispatchSemaphore(value: 0)
        let admissionQueueFinished = DispatchSemaphore(value: 0)
        defer { resumeAdmissionQueue.signal() }
        approvalBroker.queue.async {
            admissionQueueBlocked.signal()
            _ = resumeAdmissionQueue.wait(timeout: .now() + 2)
            admissionQueueFinished.signal()
        }
        try requireSmoke(
            admissionQueueBlocked.wait(timeout: .now() + 2) == .success,
            "canceled-approval queue fixture did not begin"
        )
        admissionStorage.resumeApprovalAdmission?.signal()
        try runSmokeMainLoop(until: { admissionResult != nil })
        // After reset, the wire queue is free to process ordinary operations.
        // A canceled approval must reject its claim without asking that queue
        // for admission while it owns the Security lock.
        try requireSmoke(
            admissionQueueFinished.wait(timeout: .now()) == .timedOut,
            "canceled approval waited on the wire queue while holding the Security lock"
        )
        resumeAdmissionQueue.signal()
        try requireMissing(approvalResetBroker, id: 542)
        try requireSmoke(
            admissionResult == false && admissionStorage.modern.isEmpty && admissionStorage.legacy.isEmpty
                && !admissionStorage.trace.contains { $0.contains("interactive=true") }
                && admissionState.beginApproval(.stable).isEmpty,
            "reset failed to fence an unadmitted interactive read"
        )

        // Once an approved Security read owns the process-wide lock, reset
        // fails promptly without mutation. It remains a safe explicit retry.
        let busyStorage = EphemeralSmokeStorage()
        busyStorage.legacy[.accountObservation] = original
        busyStorage.silentFailuresRemaining[.accountObservation] = 3
        busyStorage.deniedLegacyReads.insert(.accountObservation)
        busyStorage.interactiveReadStarted = DispatchSemaphore(value: 0)
        busyStorage.interactiveReadResume = DispatchSemaphore(value: 0)
        let busyState = MigrationState()
        let busyBroker = try ContributionDeviceKeychainBroker(smokeStorage: busyStorage, migrationState: busyState)
        let busyResetBroker = try ContributionDeviceKeychainBroker(smokeStorage: busyStorage, migrationState: busyState)
        defer {
            busyStorage.interactiveReadResume?.signal()
            busyBroker.shutdown(); busyResetBroker.shutdown()
        }
        try requireFailure(try response(busyBroker, "get", id: 550), id: 550, code: "migration_required")
        var busyResult: Bool?
        busyBroker.approvePendingMigrations { busyResult = $0 }
        try requireSmoke(
            busyStorage.interactiveReadStarted?.wait(timeout: .now() + 2) == .success,
            "busy reset fixture did not begin its approved read"
        )
        try requireFailure(try response(busyResetBroker, "delete", id: 551), id: 551, code: "operation_failed")
        try requireSmoke(
            busyStorage.legacy[.accountObservation] == original && busyStorage.modern.isEmpty
                && !busyStorage.trace.contains { $0.hasPrefix("delete:") }
                && busyState.isApproving(.stable),
            "busy reset changed a credential or canceled an admitted read"
        )
        busyStorage.interactiveReadResume?.signal()
        try runSmokeMainLoop(until: { busyResult != nil })
        try requireSmoke(busyResult == false, "denied busy approval became success")
        try requireSuccess(try response(busyResetBroker, "delete", id: 552), id: 552)
        try requireMissing(busyResetBroker, id: 553)

        // Reset invalidation is capability/namespace scoped. Completion of a
        // canceled read cannot clear a newer migration or its native approval.
        let claimState = MigrationState()
        guard let oldClaim = claimState.beginAutomatic(.accountObservation, identity: .stable),
              let otherClaim = claimState.beginAutomatic(.exportIdentity, identity: .stable),
              let previewClaim = claimState.beginAutomatic(.accountObservation, identity: .preview)
        else { throw SmokeFailure(message: "claim isolation fixture did not initialize") }
        claimState.invalidateForReset(.accountObservation, identity: .stable)
        claimState.completeReset(.accountObservation, identity: .stable)
        guard let newClaim = claimState.beginAutomatic(.accountObservation, identity: .stable)
        else { throw SmokeFailure(message: "successful reset did not release its old budget") }
        try requireSmoke(
            !claimState.finish(.accountObservation, identity: .stable, success: true, claim: oldClaim)
                && !claimState.allowsAdoption(oldClaim, identity: .stable)
                && claimState.allowsAdoption(newClaim, identity: .stable)
                && claimState.allowsAdoption(otherClaim, identity: .stable)
                && claimState.allowsAdoption(previewClaim, identity: .preview),
            "stale reset claim altered a newer or unrelated migration"
        )
        claimState.finish(.accountObservation, identity: .stable, success: false, claim: newClaim)
        claimState.finish(.exportIdentity, identity: .stable, success: false, claim: otherClaim)
        let approvedClaims = claimState.beginApproval(.stable)
        claimState.endApproval(.stable, claims: [oldClaim])
        try requireSmoke(
            !approvedClaims.isEmpty && claimState.isApproving(newClaim, identity: .stable),
            "canceled approval cleared a newer approval claim"
        )
        claimState.endApproval(.stable, claims: approvedClaims)
    }

    private static func runSmokeMainLoop(until complete: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(3)
        while !complete(), Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        try requireSmoke(complete(), "native approval callback did not finish on main")
    }

    private static func runShutdownRetentionSmokeTest() throws {
        var broker: ContributionDeviceKeychainBroker? = try ContributionDeviceKeychainBroker(
            smokeStorage: EphemeralSmokeStorage()
        )
        weak var observed = broker
        let queue = broker!.queue
        let entered = DispatchSemaphore(value: 0)
        let resume = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        defer { resume.signal(); broker?.shutdown() }
        queue.async {
            entered.signal()
            _ = resume.wait(timeout: .now() + 2)
        }
        try requireSmoke(entered.wait(timeout: .now() + 2) == .success, "shutdown fixture did not pause")
        broker!.shutdown { finished.signal() }
        broker = nil
        try requireSmoke(observed != nil, "shutdown lost its broker before the writer barrier")
        resume.signal()
        try requireSmoke(finished.wait(timeout: .now() + 2) == .success, "shutdown completion was lost")
        queue.sync {}
        try requireSmoke(observed == nil, "shutdown retained a retired broker")
    }

    /// Used by the compiled native companion-lifecycle probe. The deletion
    /// deliberately bypasses broker.delete, just like the separate full-reset
    /// helper, so only the real stop/teardown ordering prevents resurrection.
    static func verifyExternalResetOrder(
        stoppingWith stop: (ContributionDeviceKeychainBroker, @escaping () -> Void) -> Void
    ) -> Bool {
        do {
            let storage = EphemeralSmokeStorage()
            storage.legacy[.exportIdentity] = String(repeating: "L", count: 43)
            storage.silentReadStarted = DispatchSemaphore(value: 0)
            storage.silentReadResume = DispatchSemaphore(value: 0)
            let broker = try ContributionDeviceKeychainBroker(smokeStorage: storage)
            defer { storage.silentReadResume?.signal(); broker.shutdown() }
            guard let endpoint = broker.childEndpoint else {
                throw SmokeFailure(message: "external reset fixture has no endpoint")
            }
            var request = try JSONSerialization.data(withJSONObject: [
                "v": 2, "id": 901, "op": "get", "capability": "export_identity",
            ])
            request.append(0x0A)
            try endpoint.write(contentsOf: request)
            try requireSmoke(
                storage.silentReadStarted?.wait(timeout: .now() + 2) == .success,
                "external reset fixture did not reach its helper boundary"
            )
            let resetFinished = DispatchSemaphore(value: 0)
            let resultLock = NSLock()
            var resetCount = 0
            var resetWhileOpen = false
            stop(broker) {
                resultLock.lock()
                resetCount += 1
                resetWhileOpen = resetWhileOpen || !broker.closed
                Self.keychainOperationLock.lock()
                storage.legacy.removeValue(forKey: .exportIdentity)
                storage.modern.removeValue(forKey: .exportIdentity)
                Self.keychainOperationLock.unlock()
                resultLock.unlock()
                resetFinished.signal()
            }
            try requireSmoke(
                resetFinished.wait(timeout: .now()) == .timedOut,
                "external reset ran before the broker writer barrier"
            )
            storage.silentReadResume?.signal()
            try requireSmoke(
                resetFinished.wait(timeout: .now() + 2) == .success,
                "external reset did not finish after shutdown"
            )
            // Drain the completion itself, including any other stop callbacks.
            _ = broker.childEndpoint
            resultLock.lock()
            let correctCompletion = resetCount == 1 && !resetWhileOpen
            resultLock.unlock()
            try requireSmoke(
                correctCompletion && broker.closed && storage.modern.isEmpty && storage.legacy.isEmpty,
                "external reset completion was duplicated or its key was resurrected"
            )
            return true
        } catch let failure as SmokeFailure {
            FileHandle.standardError.write(
                Data("Keychain shutdown contract failed: \(failure.message)\n".utf8)
            )
            return false
        } catch {
            FileHandle.standardError.write(Data("Keychain shutdown contract failed\n".utf8))
            return false
        }
    }

    private static func waitForSmokeApproval(
        _ broker: ContributionDeviceKeychainBroker
    ) throws -> Bool {
        var approved: Bool?
        broker.approvePendingMigrations { approved = $0 }
        try runSmokeMainLoop(until: { approved != nil })
        return approved == true
    }
}
