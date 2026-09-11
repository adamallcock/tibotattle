import Foundation
import Security
import CryptoKit
import Darwin

// Test composition only. ProbeConfiguration is generated inside a new owner-only
// temporary directory. No shipped source reads it or accepts a Keychain path.
enum MigrationProbeFixture {
    struct Failure: Error {
        let code: String
        init(_ code: String) { self.code = code }
    }

    struct StoredRead {
        let status: OSStatus
        let value: String?
        var denied: Bool {
            status == errSecInteractionNotAllowed || status == errSecAuthFailed
        }
    }

    static let legacyService = "app-usagemonitor.account-observation.v1"
    static let modernService = "app-usagemonitor.account-observation.app.v1"
    static let account = "installation"
    static var root: URL { URL(fileURLWithPath: ProbeConfiguration.root) }
    static var keychainURL: URL { root.appendingPathComponent("synthetic.keychain-db") }

    static func require(_ condition: @autoclosure () throws -> Bool, _ code: String) throws {
        guard try condition() else { throw Failure(code) }
    }

    static func configure() throws {
        umask(0o077)
        var limit = rlimit(rlim_cur: 0, rlim_max: 0)
        try require(setrlimit(RLIMIT_CORE, &limit) == 0, "CORE_DUMPS_NOT_DISABLED")
        try require(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess,
                    "INTERACTION_NOT_DISABLED")
        try validateRoot()
    }

    static func validateRoot() throws {
        let path = root.standardizedFileURL
        try require(path.resolvingSymlinksInPath() == path, "ROOT_LINK_REFUSED")
        var metadata = stat()
        try require(lstat(path.path, &metadata) == 0
            && metadata.st_mode & S_IFMT == S_IFDIR
            && metadata.st_uid == geteuid()
            && metadata.st_mode & 0o777 == 0o700, "ROOT_OWNERSHIP_INVALID")
        let marker = try readPrivate("owner.json")
        try require(marker["nonce"] as? String == ProbeConfiguration.nonce
            && (marker["uid"] as? NSNumber)?.uint32Value == geteuid()
            && (marker["inode"] as? NSNumber)?.uint64Value == UInt64(metadata.st_ino),
                    "OWNER_MARKER_INVALID")
    }

    static func readPrivate(_ name: String) throws -> [String: Any] {
        let file = root.appendingPathComponent(name)
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw Failure("FIXTURE_RECEIPT_UNAVAILABLE") }
        defer { close(descriptor) }
        var metadata = stat()
        try require(fstat(descriptor, &metadata) == 0
            && metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_uid == geteuid()
            && metadata.st_nlink == 1
            && metadata.st_mode & 0o777 == 0o600
            && metadata.st_size > 0 && metadata.st_size <= 4096, "FIXTURE_RECEIPT_INVALID")
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
        let size = bytes.count
        var offset = 0
        while offset < size {
            let count = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: offset), size - offset)
            }
            if count < 0 && errno == EINTR { continue }
            try require(count > 0, "FIXTURE_RECEIPT_TRUNCATED")
            offset += count
        }
        guard let object = try JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any]
        else { throw Failure("FIXTURE_RECEIPT_INVALID") }
        return object
    }

    static func writePrivate(_ name: String, _ object: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let descriptor = open(root.appendingPathComponent(name).path,
                              O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Failure("FIXTURE_RECEIPT_CREATE_FAILED") }
        defer { close(descriptor) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset),
                                         buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                try require(count > 0, "FIXTURE_RECEIPT_WRITE_FAILED")
                offset += count
            }
        }
        try require(fsync(descriptor) == 0, "FIXTURE_RECEIPT_SYNC_FAILED")
    }

    static func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        try require(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess,
                    "SYNTHETIC_RANDOM_FAILED")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func fingerprint(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func matchesSeed(_ value: String) throws -> Bool {
        let seed = try readPrivate("seed-proof.json")
        return seed["nonce"] as? String == ProbeConfiguration.nonce
            && value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
            && seed["syntheticSHA256"] as? String == fingerprint(value)
    }

    static func keychainMetadata() throws -> stat {
        var metadata = stat()
        try require(lstat(keychainURL.path, &metadata) == 0
            && metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_uid == geteuid()
            && metadata.st_nlink == 1
            && metadata.st_mode & 0o777 == 0o600, "KEYCHAIN_OWNERSHIP_INVALID")
        return metadata
    }

    static func identity(_ metadata: stat) -> MigrationProbeOwnership.Identity {
        .init(device: metadata.st_dev, inode: UInt64(metadata.st_ino))
    }

    static func readReceipt<T: Decodable>(_ name: String, as: T.Type) throws -> T {
        let bytes = try JSONSerialization.data(withJSONObject: readPrivate(name))
        return try JSONDecoder().decode(T.self, from: bytes)
    }

    static func writeReceipt<T: Encodable>(_ name: String, _ value: T) throws {
        guard let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
                as? [String: Any] else { throw Failure("FIXTURE_RECEIPT_INVALID") }
        try writePrivate(name, object)
    }

    static func writeName(_ sequence: Int, _ kind: String) -> String {
        String(format: "keychain-write-%02d-%@.json", sequence, kind)
    }

    static func ownershipEntries() throws -> [MigrationProbeOwnership.Entry] {
        let names = Set(try FileManager.default.contentsOfDirectory(atPath: root.path)
            .filter { $0.hasPrefix("keychain-write-") })
        let allowed = Set((1...MigrationProbeOwnership.maximumWrites).flatMap { sequence in
            ["intent", "complete", "failure"].map { writeName(sequence, $0) }
        })
        try require(names.isSubset(of: allowed), "KEYCHAIN_JOURNAL_INVALID")
        let last = (1...MigrationProbeOwnership.maximumWrites).last { sequence in
            ["intent", "complete", "failure"].contains { names.contains(writeName(sequence, $0)) }
        } ?? 0
        guard last > 0 else { return [] }
        return try (1...last).map { sequence in
            let intent: MigrationProbeOwnership.Intent? = names.contains(writeName(sequence, "intent"))
                ? try readReceipt(writeName(sequence, "intent"), as: MigrationProbeOwnership.Intent.self) : nil
            let complete: MigrationProbeOwnership.Completion? = names.contains(writeName(sequence, "complete"))
                ? try readReceipt(writeName(sequence, "complete"), as: MigrationProbeOwnership.Completion.self) : nil
            return .init(intent: intent, completion: complete, failed: names.contains(writeName(sequence, "failure")))
        }
    }

    static func pinnedIdentity(pending: MigrationProbeOwnership.Intent? = nil)
        throws -> MigrationProbeOwnership.Identity {
        let baseline = try readReceipt("keychain-owner.json", as: MigrationProbeOwnership.Baseline.self)
        do {
            return try MigrationProbeOwnership.current(baseline, entries: ownershipEntries(),
                                                        nonce: ProbeConfiguration.nonce, pending: pending)
        } catch { throw Failure("KEYCHAIN_JOURNAL_INCOMPLETE_OR_INVALID") }
    }

    static func ownedMutation<T>(_ operation: MigrationProbeOwnership.Operation, in keychain: SecKeychain,
                                 _ body: () throws -> (T, MigrationProbeOwnership.Outcome)) throws -> T {
        try validateRoot()
        try validateReference(keychain)
        let before = try pinnedIdentity()
        try require(MigrationProbeOwnership.matches(before, observed: identity(keychainMetadata())),
                    "KEYCHAIN_RECEIPT_MISMATCH")
        let sequence = try ownershipEntries().count + 1
        try require(sequence <= MigrationProbeOwnership.maximumWrites, "KEYCHAIN_WRITE_LIMIT")
        let intent = MigrationProbeOwnership.Intent(sequence: sequence, nonce: ProbeConfiguration.nonce,
                                                    operation: operation, before: before)
        // O_EXCL serializes fixture writers. The original baseline and every
        // intent/completion remain immutable; a pending/failed write is never
        // accepted by openKeychain or cleanup as authority for a changed inode.
        try writeReceipt(writeName(sequence, "intent"), intent)
        do {
            try require(try pinnedIdentity(pending: intent) == before
                && identity(keychainMetadata()) == before, "KEYCHAIN_WRITE_TARGET_CHANGED")
            let (result, outcome) = try body()
            try validateRoot()
            try validateReference(keychain)
            try require(try pinnedIdentity(pending: intent) == before, "KEYCHAIN_WRITE_INTENT_CHANGED")
            let after = try identity(keychainMetadata())
            let completion = MigrationProbeOwnership.Completion(intent: intent, after: after, outcome: outcome)
            let baseline = try readReceipt("keychain-owner.json", as: MigrationProbeOwnership.Baseline.self)
            let entries = try ownershipEntries().dropLast()
                + [.init(intent: intent, completion: completion, failed: false)]
            try require(try MigrationProbeOwnership.current(baseline, entries: Array(entries),
                        nonce: ProbeConfiguration.nonce) == after, "KEYCHAIN_WRITE_PROOF_INVALID")
            try writeReceipt(writeName(sequence, "complete"), completion)
            try require(try pinnedIdentity() == identity(keychainMetadata()), "KEYCHAIN_WRITE_TARGET_CHANGED")
            return result
        } catch {
            // Diagnostic metadata only: this does not adopt the observed inode
            // and is not a cleanup authorization. Interrupted writes stay closed.
            if (try? validateRoot()) != nil {
                var failure: [String: Any] = ["nonce": ProbeConfiguration.nonce, "sequence": sequence,
                    "operation": operation.rawValue, "verified": false]
                if let observed = try? keychainMetadata() {
                    failure["observedDevice"] = observed.st_dev
                    failure["observedInode"] = UInt64(observed.st_ino)
                }
                try? writePrivate(writeName(sequence, "failure"), failure)
            }
            throw error
        }
    }

    static func openKeychain() throws -> SecKeychain {
        try validateRoot()
        let expected = try pinnedIdentity()
        try require(MigrationProbeOwnership.matches(expected, observed: identity(keychainMetadata())),
                    "KEYCHAIN_RECEIPT_MISMATCH")
        var keychain: SecKeychain?
        try require(SecKeychainOpen(keychainURL.path, &keychain) == errSecSuccess,
                    "KEYCHAIN_OPEN_FAILED")
        guard let keychain else { throw Failure("KEYCHAIN_OPEN_FAILED") }
        try validateReference(keychain)
        try require(try pinnedIdentity() == expected && identity(keychainMetadata()) == expected,
                    "KEYCHAIN_OPEN_TARGET_CHANGED")
        return keychain
    }

    static func validateReference(_ keychain: SecKeychain) throws {
        var length: UInt32 = 4096
        var path = [CChar](repeating: 0, count: Int(length))
        try require(SecKeychainGetPath(keychain, &length, &path) == errSecSuccess
            && String(cString: path) == keychainURL.path, "KEYCHAIN_REFERENCE_MISMATCH")
    }

    static func createLegacy() throws {
        try validateRoot()
        var metadata = stat()
        try require(lstat(keychainURL.path, &metadata) == -1 && errno == ENOENT,
                    "EXISTING_KEYCHAIN_REFUSED")
        // This records creation in the fresh fixture root. If creation stops
        // before the inode receipt, it is recovery evidence, not authorization
        // to delete an otherwise unpinned file.
        try writePrivate("creation-intent.json", ["nonce": ProbeConfiguration.nonce])
        let password = try randomValue()
        let value = try randomValue()
        var keychain: SecKeychain?
        let passwordBytes = Data(password.utf8)
        let status = passwordBytes.withUnsafeBytes {
            SecKeychainCreate(keychainURL.path, UInt32($0.count), $0.baseAddress,
                              false, nil, &keychain)
        }
        try require(status == errSecSuccess, "SYNTHETIC_KEYCHAIN_CREATE_FAILED")
        guard let keychain else { throw Failure("SYNTHETIC_KEYCHAIN_CREATE_FAILED") }
        try validateReference(keychain)
        metadata = try keychainMetadata()
        try writeReceipt("keychain-owner.json", MigrationProbeOwnership.Baseline(version: 2,
            nonce: ProbeConfiguration.nonce, device: metadata.st_dev, inode: UInt64(metadata.st_ino)))
        try ownedMutation(.legacySeed, in: keychain) {
            let valueBytes = Data(value.utf8)
            let inserted = valueBytes.withUnsafeBytes {
                // Intentionally the historical API and its default creator ACL.
                // Do not pre-authorize the helper or grant all applications access.
                SecKeychainAddGenericPassword(keychain, UInt32(legacyService.utf8.count),
                    legacyService, UInt32(account.utf8.count), account,
                    UInt32($0.count), $0.baseAddress!, nil)
            }
            try require(inserted == errSecSuccess, "SYNTHETIC_LEGACY_CREATE_FAILED")
            let readBack = read(legacyService, from: keychain)
            try require(readBack.status == errSecSuccess && readBack.value == value,
                        "CREATOR_READBACK_FAILED")
            // A random synthetic-key digest establishes cross-process equality.
            // The value and password are never written outside this Keychain.
            try writePrivate("seed-proof.json", [
                "nonce": ProbeConfiguration.nonce, "syntheticSHA256": fingerprint(value),
            ])
            return ((), .committed)
        }
    }

    static func read(_ service: String, from keychain: SecKeychain) -> StoredRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecMatchSearchList as String: [keychain],
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var raw: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &raw)
        let value = (raw as? Data).flatMap { String(data: $0, encoding: .utf8) }
        return StoredRead(status: status, value: value)
    }

    static func legacyPresent(in keychain: SecKeychain) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecMatchSearchList as String: [keychain],
            kSecAttrService as String: legacyService,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnAttributes as String: true,
        ]
        var raw: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &raw) == errSecSuccess
    }

    static func adopt(_ value: String, into keychain: SecKeychain) throws -> Bool {
        try ownedMutation(.modernAdoption, in: keychain) {
            var created: SecKeychainItem?
            var duplicate = false
            var rolledBack = false
            let adopted = KeychainMigrationAdoption.adopt(secret: value, create: {
                var trusted: SecTrustedApplication?
                var access: SecAccess?
                guard SecTrustedApplicationCreateFromPath(nil, &trusted) == errSecSuccess,
                      let trusted,
                      SecAccessCreate("Synthetic migration probe" as CFString,
                                      [trusted] as CFArray, &access) == errSecSuccess,
                      let access else { return .failed }
                let attributes: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecUseKeychain as String: keychain,
                    kSecAttrService as String: modernService,
                    kSecAttrAccount as String: account,
                    kSecValueData as String: Data(value.utf8),
                    kSecAttrAccess as String: access,
                    kSecReturnRef as String: true,
                ]
                var reference: CFTypeRef?
                let status = SecItemAdd(attributes as CFDictionary, &reference)
                if status == errSecDuplicateItem {
                    duplicate = true
                    let existing = read(modernService, from: keychain)
                    return existing.status == errSecSuccess && existing.value == value
                        ? .existingExact : .failed
                }
                guard status == errSecSuccess, let reference,
                      CFGetTypeID(reference) == SecKeychainItemGetTypeID() else { return .failed }
                created = (reference as! SecKeychainItem)
                return .created
            }, readBack: {
                let stored = read(modernService, from: keychain)
                return stored.status == errSecSuccess ? stored.value : nil
            }, removeCreated: {
                // Roll back the actual new item, not a service/account lookup.
                if let created { rolledBack = SecKeychainItemDelete(created) == errSecSuccess }
            })
            if adopted {
                let stored = read(modernService, from: keychain)
                try require(stored.status == errSecSuccess && stored.value == value,
                            "ADOPTION_WRITE_READBACK_FAILED")
                return (true, duplicate ? .unchanged : .committed)
            }
            if rolledBack {
                try require(read(modernService, from: keychain).status == errSecItemNotFound,
                            "ADOPTION_ROLLBACK_UNVERIFIED")
                return (false, .rolledBack)
            }
            // A refusal may complete only if the DB identity did not change.
            // An unverified mutation leaves intent/failure evidence for review.
            return (false, .unchanged)
        }
    }

    static func recordReader(_ variant: String) throws {
        try writePrivate("reader-\(variant).json", [
            "nonce": ProbeConfiguration.nonce, "pid": getpid(),
        ])
    }

    static func cleanup() throws -> Bool {
        try validateRoot()
        var metadata = stat()
        if lstat(keychainURL.path, &metadata) == -1 && errno == ENOENT { return true }
        let intent = try readPrivate("creation-intent.json")
        try require(intent["nonce"] as? String == ProbeConfiguration.nonce,
                    "CLEANUP_INTENT_MISMATCH")
        let original = try keychainMetadata()
        // Neither an absent baseline nor an incomplete mutation authorizes a
        // replacement inode. Those require separate metadata-pinned review.
        let keychain = try openKeychain()
        try validateReference(keychain)
        let current = try keychainMetadata()
        try require(current.st_ino == original.st_ino && current.st_dev == original.st_dev,
                    "CLEANUP_TARGET_CHANGED")
        try require(SecKeychainDelete(keychain) == errSecSuccess, "CLEANUP_DELETE_FAILED")
        return lstat(keychainURL.path, &metadata) == -1 && errno == ENOENT
    }

    static func report(_ values: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
        else { exit(1) }
        FileHandle.standardOutput.write(bytes)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    static func fail(_ error: Error) -> Never {
        // Never interpolate Security errors, stored data, paths, or identities.
        report(["ok": false, "code": (error as? Failure)?.code ?? "FIXTURE_FAILED"])
        exit(1)
    }
}
