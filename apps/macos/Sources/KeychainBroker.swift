import Foundation
import Security

/// Creation can fail only on descriptor exhaustion; the launcher treats it
/// as "spawn without a broker" and the companion reports a bounded native
/// credential-unavailable state rather than refusing to start the product.
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
private enum BrokerKeychainIdentity {
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
/// attributes. All reads, Keychain operations, writes, and teardown are
/// serialized on one queue.
///
/// New items are stored under `.app.v1` services with an ACL that trusts this
/// signed app and nothing else. On first use of an older keytar-backed item,
/// the broker reads the modern generation first. Only when it is absent and a
/// fixed legacy item is present does the app permit one interactive legacy
/// read for that capability in this process. It writes the exact secret to the
/// modern item, reads it back, and only then deletes the legacy item. A denied
/// migration leaves the legacy item untouched and returns
/// `migration_required`; no value, service, account, or native error text is
/// logged or returned. That capability is not prompted again in the same app
/// process. Quitting and reopening the signed app creates the only authorized
/// retry boundary; the wire deliberately exposes no prompt-reset operation.
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
        "--native-refresh-settings-contract-smoke-test",
        "--native-settings-layout-smoke-test",
        "--native-weekly-pace-projection-contract-smoke-test",
        "--quota-notification-contract-smoke-test",
        "--smoke-test",
        "--updater-contract-smoke-test",
        "--updater-feed-contract-smoke-test",
        "--watchdog-smoke-test",
    ])

    /// One app-process owner for interactive legacy reads. A companion retry
    /// creates a fresh broker instance while this signed app is still alive,
    /// so instance-local state would permit another prompt without the
    /// explicit quit-and-reopen boundary. The lock also closes the brief
    /// overlap in which an old companion and its replacement both exist.
    private final class MigrationPromptState {
        private let lock = NSLock()
        private var attempted = Set<BrokerKeychainCapability>()

        func claimInteractiveRead(
            _ capability: BrokerKeychainCapability
        ) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return attempted.insert(capability).inserted
        }
    }

    private static let processMigrationPromptState = MigrationPromptState()

    private let queue = DispatchQueue(
        label: "usage-monitor.keychain-broker"
    )
    private let keychainIdentity: BrokerKeychainIdentity
    private let parentDescriptor: Int32
    private var readSource: DispatchSourceRead?
    private var childHandle: FileHandle?
    private var pendingInput = Data()
    private var closed = false
    private let migrationPromptState: MigrationPromptState
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
        var failedMigrationReadbacks = Set<BrokerKeychainCapability>()
        var migratedWrites = Set<BrokerKeychainCapability>()
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
            migrationPromptState: nil,
            keychainIdentity: identity
        )
    }

    private init(
        smokeStorage: EphemeralSmokeStorage?,
        migrationPromptState injectedMigrationPromptState:
            MigrationPromptState? = nil,
        keychainIdentity: BrokerKeychainIdentity = .stable
    ) throws {
        self.keychainIdentity = keychainIdentity
        let isNativeSmoke = !Self.nativeSmokeArguments.isDisjoint(
            with: CommandLine.arguments.dropFirst()
        )
        let selectedSmokeStorage = smokeStorage
            ?? (isNativeSmoke ? EphemeralSmokeStorage() : nil)
        ephemeralSmokeStorage = selectedSmokeStorage
        migrationPromptState = injectedMigrationPromptState
            ?? (selectedSmokeStorage == nil
                ? Self.processMigrationPromptState
                : MigrationPromptState())
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

    func closeChildEndpoint() {
        queue.async { [weak self] in
            guard let self, let handle = self.childHandle else { return }
            self.childHandle = nil
            try? handle.close()
        }
    }

    func shutdown() {
        queue.async { [weak self] in
            self?.teardown()
        }
    }

    private func teardown() {
        guard !closed else { return }
        closed = true
        pendingInput.removeAll()
        ephemeralSmokeStorage?.modern.removeAll()
        ephemeralSmokeStorage?.legacy.removeAll()
        ephemeralSmokeStorage?.deniedLegacyReads.removeAll()
        ephemeralSmokeStorage?.failedMigrationReadbacks.removeAll()
        ephemeralSmokeStorage?.migratedWrites.removeAll()
        ephemeralSmokeStorage?.trace.removeAll()
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

    /// Suppression is the default. Only the one fixed legacy migration read
    /// calls this with `true`; no modern operation can display a prompt.
    private func withUserInteraction<T>(
        _ allowed: Bool,
        _ body: () -> T
    ) -> T {
        SecKeychainSetUserInteractionAllowed(allowed)
        defer { SecKeychainSetUserInteractionAllowed(true) }
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
        allowInteraction: Bool = false
    ) -> ReadOutcome {
        if let smoke = ephemeralSmokeStorage {
            let generationName = generation == .modern ? "modern" : "legacy"
            smoke.trace.append(
                "read:\(generationName):\(capability.rawValue):"
                    + "interactive=\(allowInteraction)"
            )
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
        let status = withUserInteraction(allowInteraction) {
            SecItemCopyMatching(query as CFDictionary, &item)
        }
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
        let status = withUserInteraction(false) {
            SecItemCopyMatching(query as CFDictionary, &item)
        }
        if status == errSecItemNotFound { return .missing }
        if status == errSecSuccess { return .present }
        return .failure(Self.failureCode(status))
    }

    private func readOrMigrateSecret(
        _ capability: BrokerKeychainCapability
    ) -> ReadOutcome {
        switch readSecret(capability, generation: .modern) {
        case .value(let stored) where stored != nil:
            return .value(stored)
        case .failure(let code):
            return .failure(code)
        case .value:
            break
        }
        // A caller cannot manufacture another interactive prompt in this app
        // process. Restarting the signed app is the explicit retry boundary.
        switch legacyPresence(capability) {
        case .missing:
            return .value(nil)
        case .failure(let code):
            return .failure(code)
        case .present:
            break
        }
        guard migrationPromptState.claimInteractiveRead(capability) else {
            return .failure("migration_required")
        }

        let legacy: String
        switch readSecret(
            capability,
            generation: .legacy,
            allowInteraction: true
        ) {
        case .value(let stored):
            guard let stored else { return .value(nil) }
            legacy = stored
        case .failure(let code):
            if code == "denied" {
                return .failure("migration_required")
            }
            return .failure(code)
        }

        let created: Bool
        switch addMigratedSecret(legacy, capability: capability) {
        case .created:
            created = true
        case .existingExact:
            created = false
        case .failure(let code):
            return .failure(code)
        }

        switch readSecret(capability, generation: .modern) {
        case .value(let readback) where readback == legacy:
            break
        default:
            if created { _ = deleteSecret(capability: capability) }
            return .failure("operation_failed")
        }

        let legacyDelete = deleteItem(
            capability,
            generation: .legacy
        )
        guard legacyDelete == nil else {
            if created { _ = deleteSecret(capability: capability) }
            return .failure("operation_failed")
        }
        return .value(legacy)
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
        case created
        case existingExact
        case failure(String)
    }

    private func addMigratedSecret(
        _ stored: String,
        capability: BrokerKeychainCapability
    ) -> MigrationWriteOutcome {
        if let smoke = ephemeralSmokeStorage {
            smoke.trace.append("add-migrated:modern:\(capability.rawValue)")
            if let existing = smoke.modern[capability] {
                return existing == stored
                    ? .existingExact
                    : .failure("operation_failed")
            }
            smoke.modern[capability] = stored
            smoke.migratedWrites.insert(capability)
            return .created
        }
        guard let selected = attributes(stored, capability: capability) else {
            return .failure("operation_failed")
        }
        let status = withUserInteraction(false) {
            SecItemAdd(selected as CFDictionary, nil)
        }
        if status == errSecSuccess { return .created }
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
        return withUserInteraction(false) {
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
        }
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
            if generation == .modern {
                smoke.modern.removeValue(forKey: capability)
                smoke.migratedWrites.remove(capability)
            } else {
                smoke.legacy.removeValue(forKey: capability)
            }
            return nil
        }
        let status = withUserInteraction(false) {
            SecItemDelete(
                baseQuery(capability, generation: generation) as CFDictionary
            )
        }
        if status == errSecSuccess || status == errSecItemNotFound {
            return nil
        }
        return Self.failureCode(status)
    }

    private func deleteSecret(
        capability: BrokerKeychainCapability
    ) -> String? {
        return deleteItem(capability, generation: .modern)
    }

    // MARK: - Compiled native contract probe

    private struct SmokeFailure: Error {
        let message: String
    }

    private static func requireSmoke(
        _ condition: @autoclosure () -> Bool,
        _ message: String
    ) throws {
        guard condition() else { throw SmokeFailure(message: message) }
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
                migrationStorage.legacy[.exportIdentity] == nil,
                "migration did not retire legacy item"
            )
            try requireSmoke(
                migrationStorage.trace == [
                    "read:modern:export_identity:interactive=false",
                    "presence:legacy:export_identity",
                    "read:legacy:export_identity:interactive=true",
                    "add-migrated:modern:export_identity",
                    "read:modern:export_identity:interactive=false",
                    "delete:legacy:export_identity",
                ],
                "migration operation order drifted"
            )

            let deniedSecret = String(repeating: "D", count: 43)
            let deniedStorage = EphemeralSmokeStorage()
            deniedStorage.legacy[.accountObservation] = deniedSecret
            deniedStorage.deniedLegacyReads.insert(.accountObservation)
            let deniedPromptState = MigrationPromptState()
            let deniedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: deniedStorage,
                migrationPromptState: deniedPromptState
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
            // app process stays alive. Inject the same app-lifetime prompt
            // owner to prove that replacement cannot raise another dialog.
            let relaunchedDeniedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: deniedStorage,
                migrationPromptState: deniedPromptState
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
                    $0 == "read:legacy:account_observation:interactive=true"
                }.count == 1,
                "denied migration prompted more than once"
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
                code: "operation_failed"
            )
            try requireSmoke(
                rollbackStorage.legacy[.claudeSessionPseudonym]
                    == rollbackSecret
                    && rollbackStorage.modern[.claudeSessionPseudonym] == nil,
                "failed readback did not roll back modern state"
            )

            let malformedBroker = try ContributionDeviceKeychainBroker(
                smokeStorage: EphemeralSmokeStorage()
            )
            try requireMalformedFrameClosure(malformedBroker)

            print(
                "USAGE_MONITOR_MACOS_KEYCHAIN_BROKER_CONTRACT "
                    + "protocols=v1,v2 capabilities=4 "
                    + "migration=success,denied-preserved,readback-rollback "
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
}
