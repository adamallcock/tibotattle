import Foundation
import Security
import Darwin

/// A native-only view of the migration. It contains no capability names,
/// Keychain addresses, account identifiers, or stored values.
struct KeychainMigrationStatus: Equatable {
    let pendingCount: Int
    let isRetrying: Bool
    let isApproving: Bool

    var needsApproval: Bool {
        pendingCount > 0 && !isRetrying && !isApproving
    }

    static let idle = KeychainMigrationStatus(
        pendingCount: 0, isRetrying: false, isApproving: false
    )
}

enum KeychainMigrationIdentity: Equatable {
    case stable
    case preview

    init?(applicationIdentifier: String) {
        switch applicationIdentifier {
        case "com.usagemonitor.local": self = .stable
        case "com.usagemonitor.local.preview": self = .preview
        default: return nil
        }
    }

    var namespace: String {
        self == .stable ? "app-usagemonitor" : "app-usagemonitor.preview"
    }

    var account: String {
        self == .stable ? "installation" : "preview-installation"
    }
}

enum KeychainMigrationCapability: String, CaseIterable {
    case exportIdentity = "export_identity"
    case accountObservation = "account_observation"
    case claudeSessionPseudonym = "claude_session_pseudonym"
    case contributionDevice = "contribution_device"

    func legacyService(for identity: KeychainMigrationIdentity) -> String {
        let stem: String
        switch self {
        case .exportIdentity: stem = "export-identity"
        case .accountObservation: stem = "account-observation"
        case .claudeSessionPseudonym: stem = "claude-session-pseudonym"
        case .contributionDevice: stem = "contribution-device"
        }
        return "\(identity.namespace).\(stem).v1"
    }
}

enum KeychainMigrationRead {
    case value(String)
    case missing
    case unavailable
    case rejected
}

/// Shared by the production broker and the separately signed fixture. Adoption
/// never overwrites a different modern key or deletes the legacy recovery copy.
/// Only a newly created modern item may be rolled back after failed readback.
enum KeychainMigrationAdoption {
    enum CreateResult {
        case created
        case existingExact
        case failed
    }

    static func adopt(
        secret: String,
        create: () -> CreateResult,
        readBack: () -> String?,
        removeCreated: () -> Void
    ) -> Bool {
        guard secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { return false }
        let created: Bool
        switch create() {
        case .created: created = true
        case .existingExact: created = false
        case .failed: return false
        }
        guard readBack() == secret else {
            if created { removeCreated() }
            return false
        }
        return true
    }
}

/// Read-only compatibility bridge. The separate helper has the legacy Node
/// designated identity but no interpreter, arbitrary query, write, or prompt
/// operation. The app's main identity and modern item ACL never change.
enum LegacyKeychainMigration {
    static let helperRelativePath = "Contents/Helpers/TiboTattleKeychainMigration"
    static let maximumFrameBytes = 4_096
    static let attemptMilliseconds = 1_500
    private static let helperIdentifier = "node"
    private static let secretPattern = "^[A-Za-z0-9_-]{43}$"
    // CS_RUNTIME from <sys/codesign.h>. No get-task-allow or runtime bypass
    // entitlements are permitted on either endpoint of this secret channel.
    private static let hardenedRuntimeFlag: UInt32 = 0x00010000

    private struct Signature {
        let identifier: String
        let team: String
        let cdhash: Data
    }

    private struct Peer {
        let audit: Data
        let pid: pid_t
        let signature: Signature
    }

    private struct Failure: Error {}
    private struct Rejected: Error {}

    private static func requirement(identifier: String, team: String) throws
        -> SecRequirement {
        guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              identifier == helperIdentifier
                || KeychainMigrationIdentity(applicationIdentifier: identifier) != nil
        else { throw Rejected() }
        let expression = "identifier \"\(identifier)\" and anchor apple generic "
            + "and certificate 1[field.1.2.840.113635.100.6.2.6] exists "
            + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
            + "and certificate leaf[subject.OU] = \"\(team)\""
        var result: SecRequirement?
        guard SecRequirementCreateWithString(
            expression as CFString, [], &result
        ) == errSecSuccess, let result else { throw Rejected() }
        return result
    }

    private static func signature(_ code: SecStaticCode) throws -> Signature {
        var raw: CFDictionary?
        guard SecCodeCopySigningInformation(
            code, SecCSFlags(rawValue: kSecCSSigningInformation), &raw
        ) == errSecSuccess,
              let info = raw as? [String: Any],
              let identifier = info[kSecCodeInfoIdentifier as String] as? String,
              let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
              let cdhash = info[kSecCodeInfoUnique as String] as? Data,
              !cdhash.isEmpty,
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
              flags.uint32Value & hardenedRuntimeFlag != 0
        else { throw Rejected() }
        let entitlements = info[kSecCodeInfoEntitlementsDict as String]
            as? [String: Any] ?? [:]
        guard entitlements.isEmpty else { throw Rejected() }
        let expected = try requirement(identifier: identifier, team: team)
        guard SecStaticCodeCheckValidity(
            code, SecCSFlags(rawValue: kSecCSStrictValidate), expected
        ) == errSecSuccess else { throw Rejected() }
        return Signature(identifier: identifier, team: team, cdhash: cdhash)
    }

    private static func ownSignature() throws -> Signature {
        var code: SecCode?
        var executable: SecStaticCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &executable) == errSecSuccess,
              let executable else { throw Rejected() }
        return try signature(executable)
    }

    private static func peer(
        descriptor: Int32, expectedPID: pid_t, expectedTeam: String,
        expectedIdentifier: String? = nil, expectedCDHash: Data? = nil
    ) throws -> Peer {
        guard expectedPID > 1 else { throw Rejected() }
        var uid: uid_t = 0
        var gid: gid_t = 0
        var pid: pid_t = 0
        var pidLength = socklen_t(MemoryLayout<pid_t>.size)
        var token = audit_token_t()
        var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getpeereid(descriptor, &uid, &gid) == 0, uid == geteuid(),
              getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidLength) == 0,
              pidLength == MemoryLayout<pid_t>.size, pid == expectedPID,
              getsockopt(
                descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenLength
              ) == 0,
              tokenLength == MemoryLayout<audit_token_t>.size,
              audit_token_to_pid(token) == expectedPID,
              audit_token_to_euid(token) == geteuid()
        else { throw Rejected() }
        let audit = withUnsafeBytes(of: token) { Data($0) }
        var guest: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: audit]
        guard SecCodeCopyGuestWithAttributes(
            nil, attributes as CFDictionary, [], &guest
        ) == errSecSuccess, let guest,
              SecCodeCheckValidity(guest, [], nil) == errSecSuccess
        else { throw Rejected() }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, [], &staticCode) == errSecSuccess,
              let staticCode else { throw Rejected() }
        let found = try signature(staticCode)
        guard found.team == expectedTeam,
              expectedIdentifier == nil || found.identifier == expectedIdentifier,
              expectedCDHash == nil || found.cdhash == expectedCDHash,
              SecCodeCheckValidity(
                guest, [], try requirement(identifier: found.identifier, team: expectedTeam)
              ) == errSecSuccess
        else { throw Rejected() }
        return Peer(audit: audit, pid: pid, signature: found)
    }

    private static func deadline() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
            + UInt64(attemptMilliseconds) * 1_000_000
    }

    private static func waitFor(
        _ descriptor: Int32, events: Int16, until deadline: UInt64
    ) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw Failure() }
            let remaining = Int32(min((deadline - now) / 1_000_000 + 1, 1_500))
            var item = pollfd(fd: descriptor, events: events, revents: 0)
            let result = poll(&item, 1, remaining)
            if result < 0 && errno == EINTR { continue }
            guard result > 0, item.revents & events != 0,
                  item.revents & Int16(POLLERR | POLLNVAL) == 0
            else { throw Failure() }
            return
        }
    }

    private static func receive(_ descriptor: Int32, until deadline: UInt64)
        throws -> [String: Any] {
        var frame = Data()
        while frame.count < maximumFrameBytes {
            try waitFor(descriptor, events: Int16(POLLIN), until: deadline)
            var byte: UInt8 = 0
            let count = Darwin.read(descriptor, &byte, 1)
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            guard count == 1 else { throw Failure() }
            if byte == 0x0A {
                guard let object = try? JSONSerialization.jsonObject(with: frame),
                      let payload = object as? [String: Any],
                      let version = payload["v"] as? NSNumber,
                      CFGetTypeID(version) != CFBooleanGetTypeID(),
                      version == 1 else { throw Rejected() }
                return payload
            }
            frame.append(byte)
        }
        throw Rejected()
    }

    private static func send(
        _ payload: [String: Any], descriptor: Int32, until deadline: UInt64
    ) throws {
        var bytes = try JSONSerialization.data(withJSONObject: payload)
        bytes.append(0x0A)
        guard bytes.count <= maximumFrameBytes else { throw Failure() }
        try bytes.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { throw Failure() }
            var offset = 0
            while offset < buffer.count {
                try waitFor(descriptor, events: Int16(POLLOUT), until: deadline)
                let count = write(descriptor, base.advanced(by: offset), buffer.count - offset)
                if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
                guard count > 0 else { throw Failure() }
                offset += count
            }
        }
    }

    private static func validSecret(_ value: String) -> Bool {
        value.range(of: secretPattern, options: .regularExpression) != nil
    }

    private static func trueFlag(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue
    }

    /// posix_spawn + waitpid have one lifecycle owner. A child that exits early
    /// remains our unreaped child, so a timeout can never signal a reused PID.
    private final class Child {
        private(set) var pid: pid_t = 0
        private var reaped = false

        init(executable: URL, endpoint: Int32) throws {
            var actions: posix_spawn_file_actions_t?
            var attributes: posix_spawnattr_t?
            guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure() }
            defer { posix_spawn_file_actions_destroy(&actions) }
            guard posix_spawnattr_init(&attributes) == 0 else { throw Failure() }
            defer { posix_spawnattr_destroy(&attributes) }
            var mask = sigset_t()
            sigemptyset(&mask)
            guard posix_spawnattr_setsigmask(&attributes, &mask) == 0,
                  posix_spawnattr_setflags(
                    &attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK)
                  ) == 0,
                  posix_spawn_file_actions_adddup2(&actions, endpoint, STDIN_FILENO) == 0,
                  posix_spawn_file_actions_addopen(
                    &actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0
                  ) == 0,
                  posix_spawn_file_actions_addopen(
                    &actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0
                  ) == 0 else { throw Failure() }
            let argument = strdup(executable.path)
            let environment = strdup("PATH=/usr/bin:/bin:/usr/sbin:/sbin")
            defer { free(argument); free(environment) }
            guard argument != nil, environment != nil else { throw Failure() }
            var argv = [argument, nil]
            var envp = [environment, nil]
            let status = posix_spawn(
                &pid, executable.path, &actions, &attributes, &argv, &envp
            )
            guard status == 0, pid > 1 else { throw Failure() }
        }

        func finish() {
            guard !reaped, pid > 1 else { return }
            var status: Int32 = 0
            var result: pid_t
            repeat { result = waitpid(pid, &status, WNOHANG) } while result < 0 && errno == EINTR
            if result == 0 {
                _ = kill(pid, SIGKILL)
                repeat { result = waitpid(pid, &status, 0) } while result < 0 && errno == EINTR
            }
            reaped = true
        }

        deinit { finish() }
    }

    static func read(
        _ capability: KeychainMigrationCapability,
        expectedIdentity: KeychainMigrationIdentity,
        bundle: Bundle = .main
    ) -> KeychainMigrationRead {
        let executable = bundle.bundleURL.appendingPathComponent(helperRelativePath)
        return read(capability, expectedIdentity: expectedIdentity, executable: executable)
    }

    // Internal URL injection is for separately compiled synthetic fixtures only;
    // neither the packaged entry point nor its wire accepts an executable path.
    static func read(
        _ capability: KeychainMigrationCapability,
        expectedIdentity: KeychainMigrationIdentity,
        executable: URL
    ) -> KeychainMigrationRead {
        do {
            let own = try ownSignature()
            guard KeychainMigrationIdentity(applicationIdentifier: own.identifier)
                    == expectedIdentity,
                  executable.isFileURL,
                  executable.resolvingSymlinksInPath().standardizedFileURL
                    == executable.standardizedFileURL,
                  executable.path.hasSuffix("/" + helperRelativePath)
            else { return .rejected }
            var staticHelper: SecStaticCode?
            guard SecStaticCodeCreateWithPath(
                executable as CFURL, [], &staticHelper
            ) == errSecSuccess, let staticHelper else { return .rejected }
            let expected = try signature(staticHelper)
            guard expected.identifier == helperIdentifier, expected.team == own.team
            else { return .rejected }
            var sockets: [Int32] = [-1, -1]
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else {
                return .unavailable
            }
            defer { close(sockets[0]); if sockets[1] >= 0 { close(sockets[1]) } }
            for descriptor in sockets {
                var enabled: Int32 = 1
                guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0,
                      fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0,
                      setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled,
                                 socklen_t(MemoryLayout<Int32>.size)) == 0
                else { throw Failure() }
            }
            let child = try Child(executable: executable, endpoint: sockets[1])
            defer { child.finish() }
            close(sockets[1]); sockets[1] = -1
            let limit = deadline()
            try send(["v": 1, "capability": capability.rawValue],
                     descriptor: sockets[0], until: limit)
            let hello = try receive(sockets[0], until: limit)
            guard Set(hello.keys) == Set(["v", "ready"]), trueFlag(hello["ready"])
            else { return .rejected }
            let authenticated = try peer(
                descriptor: sockets[0], expectedPID: child.pid, expectedTeam: own.team,
                expectedIdentifier: helperIdentifier, expectedCDHash: expected.cdhash
            )
            try send(["v": 1, "continue": true], descriptor: sockets[0], until: limit)
            let reply = try receive(sockets[0], until: limit)
            let finalPeer = try peer(
                descriptor: sockets[0], expectedPID: child.pid, expectedTeam: own.team,
                expectedIdentifier: helperIdentifier, expectedCDHash: expected.cdhash
            )
            guard finalPeer.audit == authenticated.audit else { return .rejected }
            let outcome: KeychainMigrationRead
            if Set(reply.keys) == Set(["v", "secret"]),
               let stored = reply["secret"] as? String, validSecret(stored) {
                outcome = .value(stored)
            } else if Set(reply.keys) == Set(["v", "code"]),
                      let code = reply["code"] as? String,
                      ["missing", "unavailable"].contains(code) {
                outcome = code == "missing" ? .missing : .unavailable
            } else { return .rejected }
            try send(["v": 1, "ack": true], descriptor: sockets[0], until: limit)
            return outcome
        } catch is Rejected { return .rejected }
        catch { return .unavailable }
    }

    /// Default production reader: fixed legacy query, no writes and no UI. The
    /// separate fixture entry point may inject an explicit disposable-Keychain
    /// reader; the shipped entry point exposes no test mode or path override.
    static func readLegacy(
        _ capability: KeychainMigrationCapability, identity: KeychainMigrationIdentity
    ) -> KeychainMigrationRead {
        guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else {
            return .unavailable
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: capability.legacyService(for: identity),
            kSecAttrAccount as String: identity.account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let bytes = result as? Data,
              let value = String(data: bytes, encoding: .utf8), validSecret(value)
        else { return .unavailable }
        return .value(value)
    }

    static func runHelper(
        reader: (KeychainMigrationCapability, KeychainMigrationIdentity)
            -> KeychainMigrationRead = { readLegacy($0, identity: $1) }
    ) -> Int32 {
        do {
            guard CommandLine.arguments.count == 1,
                  armLifetimeDeadline(),
                  SecKeychainSetUserInteractionAllowed(false) == errSecSuccess
            else { return 1 }
            var core = rlimit(rlim_cur: 0, rlim_max: 0)
            guard setrlimit(RLIMIT_CORE, &core) == 0 else { return 1 }
            let own = try ownSignature()
            guard own.identifier == helperIdentifier else { return 1 }
            let limit = deadline()
            let request = try receive(STDIN_FILENO, until: limit)
            guard Set(request.keys) == Set(["v", "capability"]),
                  let raw = request["capability"] as? String,
                  let capability = KeychainMigrationCapability(rawValue: raw)
            else { return 1 }
            // The parent has written first: LOCAL_PEERTOKEN now represents the
            // sender. Never fall back to PID-only trust if audit lookup fails.
            let parentPID = getppid()
            let parent = try peer(
                descriptor: STDIN_FILENO, expectedPID: parentPID, expectedTeam: own.team
            )
            guard let identity = KeychainMigrationIdentity(
                applicationIdentifier: parent.signature.identifier
            ) else { return 1 }
            try send(["v": 1, "ready": true], descriptor: STDIN_FILENO, until: limit)
            let proceed = try receive(STDIN_FILENO, until: limit)
            guard Set(proceed.keys) == Set(["v", "continue"]),
                  trueFlag(proceed["continue"]),
                  getppid() == parentPID else { return 1 }
            let beforeRead = try peer(
                descriptor: STDIN_FILENO, expectedPID: parentPID, expectedTeam: own.team,
                expectedIdentifier: parent.signature.identifier,
                expectedCDHash: parent.signature.cdhash
            )
            guard beforeRead.audit == parent.audit else { return 1 }
            let outcome = reader(capability, identity)
            guard getppid() == parentPID else { return 1 }
            let beforeReply = try peer(
                descriptor: STDIN_FILENO, expectedPID: parentPID, expectedTeam: own.team,
                expectedIdentifier: parent.signature.identifier,
                expectedCDHash: parent.signature.cdhash
            )
            guard beforeReply.audit == parent.audit else { return 1 }
            let reply: [String: Any]
            switch outcome {
            case .value(let stored):
                guard validSecret(stored) else { return 1 }
                reply = ["v": 1, "secret": stored]
            case .missing: reply = ["v": 1, "code": "missing"]
            case .unavailable, .rejected: reply = ["v": 1, "code": "unavailable"]
            }
            try send(reply, descriptor: STDIN_FILENO, until: limit)
            // Stay alive until the app authenticates this sender and consumes
            // the single response. No second capability request is accepted.
            let acknowledgement = try receive(STDIN_FILENO, until: limit)
            guard Set(acknowledgement.keys) == Set(["v", "ack"]),
                  trueFlag(acknowledgement["ack"]) else { return 1 }
            return 0
        } catch { return 1 }
    }

    /// The kernel terminates this one-shot process even if its parent exits or
    /// a synchronous Security call stalls. Socket deadlines and parent waitpid
    /// ownership alone cannot enforce those cases. Never reset this timer.
    private static func armLifetimeDeadline() -> Bool {
        var action = sigaction()
        action.__sigaction_u.__sa_handler = SIG_DFL
        sigemptyset(&action.sa_mask)
        guard sigaction(SIGALRM, &action, nil) == 0 else { return false }
        var mask = sigset_t()
        sigemptyset(&mask)
        sigaddset(&mask, SIGALRM)
        guard sigprocmask(SIG_UNBLOCK, &mask, nil) == 0 else { return false }
        var timer = itimerval(
            it_interval: timeval(tv_sec: 0, tv_usec: 0),
            it_value: timeval(
                tv_sec: attemptMilliseconds / 1_000,
                tv_usec: Int32((attemptMilliseconds % 1_000) * 1_000)
            )
        )
        return setitimer(ITIMER_REAL, &timer, nil) == 0
    }
}
