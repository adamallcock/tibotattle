import Foundation
import Security

/// Creation can fail only on descriptor exhaustion; the launcher treats it
/// as "spawn without a broker", where the shipped first-pairing guidance
/// remains the net, rather than refusing to start the product.
struct ContributionDeviceKeychainBrokerUnavailable: Error {}

/// The app-side Keychain broker for the spawned companion.
///
/// The first-pairing macOS dialog exists because the companion's Node
/// runtime read back a credential the `security` CLI minted, so macOS
/// treated the reader as a stranger to the item (design note
/// docs/design/2026-08-19-first-pairing-keychain-prompt.md, trigger chain).
/// This broker is the structural fix's app half: fresh contribution-device
/// credentials are minted, read, replaced, and deleted by this signed app
/// via SecItem — an app-created login-keychain item never prompts its own
/// creator — and the companion obtains the secret over a private socketpair
/// it received as standard input at spawn, holding it in memory only.
///
/// The channel is kernel-held: only the spawned child owns the peer end,
/// nothing about the broker crosses argv, and the environment carries only
/// the descriptor number. The wire protocol carries no service or account, so
/// the companion cannot name any other Keychain item through it. One
/// newline-terminated JSON frame per request or response, answered strictly
/// in order; any deviation — an oversized or unparsable frame, an
/// uncorrelatable identifier — fails the channel closed, and the companion
/// surfaces the same coded, recoverable pairing errors it uses today.
///
/// What this is NOT: a confidentiality boundary against a deliberate
/// same-user attacker. Items are minted with `runtime/bin/node` in their
/// trusted-application list (see `designatedReaderAccess()`), and that node is
/// a world-executable general-purpose interpreter inside the bundle, so any
/// process running as this user can satisfy the ACL's designated requirement
/// and read the secret directly. This is not a regression — the `-T node`
/// `security` mint it replaces had the identical property — and the socketpair
/// still earns its place: it removes the dialog and narrows accidental
/// exposure to one single-purpose channel. The true end state is moving upload
/// signing into this app so node never needs the secret at all, after which
/// the node ACL entry can be dropped.
final class ContributionDeviceKeychainBroker {
    /// The app-managed storage generation. The legacy
    /// app-usagemonitor.contribution-device.v1 item (minted companion-side
    /// through the security CLI) is deliberately unreachable from this
    /// broker: decrypting it from the app would raise exactly the
    /// partition-list prompt the broker exists to eliminate. Migration
    /// happens companion-side at the next credential rotation, never by the
    /// app touching the legacy item.
    static let service = "app-usagemonitor.contribution-device.app.v1"
    static let account = "installation"
    static let environmentVariable = "USAGE_MONITOR_KEYCHAIN_BROKER_FD"
    private static let protocolVersion = 1
    // A legitimate frame is under 128 bytes (the credential is 43 base64url
    // characters); the cap exists to fail the channel closed on anything
    // that is not this protocol.
    private static let maximumFrameBytes = 4_096
    // Stored secrets are exactly keytar's stored string form: 43 base64url
    // characters (32 bytes). Anything else is refused before Keychain I/O.
    private static let storedSecretPattern = "^[A-Za-z0-9_-]{43}$"

    private let nodeRuntimePath: String
    private let queue = DispatchQueue(
        label: "usage-monitor.contribution-device-keychain-broker"
    )
    private let parentDescriptor: Int32
    private var readSource: DispatchSourceRead?
    private var childHandle: FileHandle?
    private var pendingInput = Data()
    private var closed = false

    init(nodeRuntimePath: String) throws {
        self.nodeRuntimePath = nodeRuntimePath
        var endpoints: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0 else {
            throw ContributionDeviceKeychainBrokerUnavailable()
        }
        // Neither raw descriptor may leak into any other spawned child: the
        // companion receives its endpoint only as the dup2'd standard input
        // (dup2 clears the close-on-exec flag on the new descriptor), and a
        // dead peer must surface as a write error, never a fatal SIGPIPE.
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
        // A dispatch read source serialized on the broker queue: every read,
        // Keychain operation, response write, and the teardown share one
        // queue, and the cancellation handler is the only closer of the
        // parent descriptor — after cancellation no event handler can still
        // be in flight, so a read can never race the close.
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

    /// The endpoint the spawn hands to the companion as standard input.
    var childEndpoint: FileHandle? {
        queue.sync { childHandle }
    }

    /// The parent must drop its copy of the child's endpoint right after a
    /// successful spawn so the channel reaches end-of-file when the
    /// companion exits.
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
        if let source = readSource {
            readSource = nil
            // The cancellation handler closes the parent descriptor.
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
            // End-of-file: the companion exited.
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

    private func handleFrame(_ frame: Data) {
        guard let parsed = try? JSONSerialization.jsonObject(with: frame),
              let request = parsed as? [String: Any],
              let version = request["v"] as? Int,
              let identifier = request["id"] as? Int,
              identifier > 0
        else {
            // Without a trustworthy identifier no response can be
            // correlated; the only honest answer is a closed channel.
            teardown()
            return
        }
        guard version == Self.protocolVersion,
              let operation = request["op"] as? String
        else {
            respond(["id": identifier, "ok": false, "code": "invalid_request"])
            return
        }
        switch operation {
        case "get":
            switch readSecret() {
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
                  secret.range(
                      of: Self.storedSecretPattern,
                      options: .regularExpression
                  ) != nil
            else {
                respond([
                    "id": identifier,
                    "ok": false,
                    "code": "invalid_request",
                ])
                return
            }
            if let code = storeSecret(secret) {
                respond(["id": identifier, "ok": false, "code": code])
            } else {
                respond(["id": identifier, "ok": true])
            }
        case "delete":
            if let code = deleteSecret() {
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
                    // EAGAIN on a response this small means the companion
                    // stopped draining entirely; failing the channel closed
                    // is the honest outcome for that state too.
                    return false
                }
                offset += written
            }
            return true
        }
        if !delivered { teardown() }
    }

    // MARK: - Keychain operations (login keychain, app-created items)

    // The data-protection keychain would remove ACL semantics entirely, but
    // its entitlement requires provisioning-profile-backed signing this
    // Developer ID app does not carry; the login keychain needs none, and an
    // item this app creates is readable by this app without any prompt.

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    /// Every SecItem call runs with securityd's user interaction suppressed.
    ///
    /// This queue serializes socket reads, Keychain calls, responses, and
    /// teardown, so a SecItem call that blocks blocks the whole broker. A
    /// locked login keychain or an ACL/partition mismatch would otherwise put
    /// up a modal dialog and block exactly there: the companion's per-request
    /// timeout then poisons its transport permanently, and the user who
    /// answers that dialog correctly still finds the channel dead. Suppressed,
    /// those states return errSecInteractionNotAllowed at once, which maps to
    /// "locked" → the companion's existing recoverable
    /// contribution_device_credential_locked surface. This is what makes "zero
    /// dialogs" a structural property rather than an expectation.
    private func withoutUserInteraction<T>(_ body: () -> T) -> T {
        // Deprecated since 10.10 with no replacement for the login keychain;
        // the data-protection keychain, which needs entitlements this
        // Developer ID app cannot carry, is the only API that supersedes it.
        SecKeychainSetUserInteractionAllowed(false)
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

    private func readSecret() -> ReadOutcome {
        var query = baseQuery()
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = withoutUserInteraction {
            SecItemCopyMatching(query as CFDictionary, &item)
        }
        if status == errSecItemNotFound { return .value(nil) }
        guard status == errSecSuccess else {
            return .failure(Self.failureCode(status))
        }
        guard let data = item as? Data,
              let stored = String(data: data, encoding: .utf8),
              stored.range(
                  of: Self.storedSecretPattern,
                  options: .regularExpression
              ) != nil
        else {
            return .failure("operation_failed")
        }
        return .value(stored)
    }

    /// The access object minted onto every fresh item: this app and the
    /// bundled Node runtime, both matched by designated requirement (the
    /// same stable team + identifier match the `-T` mint relied on), so a
    /// re-signed same-team update keeps access. The Node entry exists for
    /// the one-shot Identity & Device Reset helper — a separate node
    /// process with no broker channel — whose read and exact-delete of this
    /// item must stay silent; the live companion never reads this item
    /// directly, it asks this broker.
    ///
    /// The node entry is also the limit of what the broker can promise: node
    /// is a general-purpose interpreter any same-user process can execute, so
    /// its designated requirement is satisfiable at will and the ACL keeps no
    /// secret from a deliberate same-user attacker. Dropping the entry
    /// requires moving upload signing into this app first.
    private func designatedReaderAccess() -> SecAccess? {
        var trustedSelf: SecTrustedApplication?
        var trustedReader: SecTrustedApplication?
        guard SecTrustedApplicationCreateFromPath(nil, &trustedSelf)
            == errSecSuccess,
            let appTrust = trustedSelf,
            SecTrustedApplicationCreateFromPath(
                nodeRuntimePath,
                &trustedReader
            ) == errSecSuccess,
            let readerTrust = trustedReader
        else {
            return nil
        }
        var access: SecAccess?
        guard SecAccessCreate(
            Self.service as CFString,
            [appTrust, readerTrust] as CFArray,
            &access
        ) == errSecSuccess else {
            return nil
        }
        return access
    }

    private func storeSecret(_ stored: String) -> String? {
        let data = Data(stored.utf8)
        // Never mint an item the reset helper could not later read: a
        // missing access object fails the mint closed rather than shipping
        // an item with narrower trust than the contract promises.
        guard let access = designatedReaderAccess() else {
            return "operation_failed"
        }
        var attributes = baseQuery()
        attributes[kSecAttrLabel as String] = Self.service
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccess as String] = access
        return withoutUserInteraction {
            let status = SecItemAdd(attributes as CFDictionary, nil)
            if status == errSecSuccess { return nil }
            guard status == errSecDuplicateItem else {
                return Self.failureCode(status)
            }
            // Not SecItemUpdate: Apple's implementation answers an update that
            // hits errSecVerifyFailed by silently recreating the item through
            // _ReplaceKeychainItem → SecKeychainItemCreateFromContent with
            // initialAccess = NULL (OSX/libsecurity_keychain/lib/SecItem.cpp),
            // which swaps the ACL for the default one and drops the node
            // trusted-app entry the reset helper reads through. Adding
            // kSecAttrAccess to the update dictionary does not reliably
            // prevent it. Delete-then-add re-establishes the ACL on every
            // write, and the silent ~25-day rotation takes this path every
            // single time.
            //
            // Safe because this branch is only reachable behind a completed
            // compare-and-swap read: the companion decrypted this item
            // microseconds ago on this same serialized queue, so the keychain
            // is demonstrably unlocked, and the rotation that drove the write
            // already has the service's commit for the replacement — the
            // stored value is worthless either way. A delete that lands before
            // a failing add therefore reaches the same recoverable state as a
            // failing update: no readable credential, credential_missing, and
            // the existing re-pair ceremony.
            let removal = SecItemDelete(baseQuery() as CFDictionary)
            guard removal == errSecSuccess || removal == errSecItemNotFound
            else {
                return Self.failureCode(removal)
            }
            let replacement = SecItemAdd(attributes as CFDictionary, nil)
            return replacement == errSecSuccess
                ? nil
                : Self.failureCode(replacement)
        }
    }

    private func deleteSecret() -> String? {
        let status = withoutUserInteraction {
            SecItemDelete(baseQuery() as CFDictionary)
        }
        if status == errSecSuccess || status == errSecItemNotFound {
            return nil
        }
        return Self.failureCode(status)
    }
}
