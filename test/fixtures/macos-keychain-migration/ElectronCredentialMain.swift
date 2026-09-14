import Foundation
import Security
import CryptoKit
import Darwin

// Signed test composition only. Every query uses one journal-owned fixture
// keychain. It never queries the runner's login items or accepts a service/path.
@main
struct ElectronCredentialFixture {
    typealias F = MigrationProbeFixture
    static let capabilities = ["account-observation", "contribution-device", "accountless-installation"]
    static var password = [UInt8](repeating: 0, count: 32)
    static var oldSearch: CFArray?
    static var oldDefault: SecKeychain?
    static var selected = false
    static var defaultSelected = false
    static var locked = false

    static func host() throws {
        guard geteuid() == 501, let account = getpwuid(geteuid()),
              String(cString: account.pointee.pw_name) == "runner",
              String(cString: account.pointee.pw_dir) == "/Users/runner",
              ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
              ProcessInfo.processInfo.environment["RUNNER_ENVIRONMENT"] == "github-hosted",
              ProcessInfo.processInfo.environment["RUNNER_OS"] == "macOS",
              ProcessInfo.processInfo.environment["RUNNER_ARCH"] == "ARM64",
              CommandLine.arguments.count == 2,
              ProbeConfiguration.cases.contains(CommandLine.arguments[1]) else { throw F.Failure("DISPOSABLE_HOST_REQUIRED") }
        #if !arch(arm64)
        throw F.Failure("DISPOSABLE_HOST_REQUIRED")
        #endif
        var code: SecCode?, requirement: SecRequirement?
        try F.require(SecCodeCopySelf([], &code) == errSecSuccess
            && SecRequirementCreateWithString(ProbeConfiguration.requirement as CFString, [], &requirement) == errSecSuccess,
            "FIXTURE_IDENTITY_UNAVAILABLE")
        guard let code, let requirement else { throw F.Failure("FIXTURE_IDENTITY_UNAVAILABLE") }
        try F.require(SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
                      "FIXTURE_IDENTITY_INVALID")
    }

    static func service(_ capability: String) -> String {
        "app-usagemonitor.\(capability).app.v1"
    }

    static func seed() throws {
        try F.require(SecKeychainCopySearchList(&oldSearch) == errSecSuccess
            && SecKeychainCopyDefault(&oldDefault) == errSecSuccess && oldSearch != nil && oldDefault != nil,
            "FIXTURE_SCOPE_UNAVAILABLE")
        var metadata = stat()
        try F.require(lstat(F.keychainURL.path, &metadata) == -1 && errno == ENOENT, "FIXTURE_EXISTS")
        try F.writePrivate("creation-intent.json", ["nonce": ProbeConfiguration.nonce])
        try F.require(SecRandomCopyBytes(kSecRandomDefault, password.count, &password) == errSecSuccess, "RANDOM_UNAVAILABLE")
        var reference: SecKeychain?
        let status = password.withUnsafeBytes { SecKeychainCreate(F.keychainURL.path, UInt32($0.count), $0.baseAddress, false, nil, &reference) }
        try F.require(status == errSecSuccess, "FIXTURE_CREATE_FAILED")
        guard let keychain = reference else { throw F.Failure("FIXTURE_CREATE_FAILED") }
        try F.validateReference(keychain)
        metadata = try F.keychainMetadata()
        try F.writeReceipt("keychain-owner.json", MigrationProbeOwnership.Baseline(version: 2,
            nonce: ProbeConfiguration.nonce, device: metadata.st_dev, inode: UInt64(metadata.st_ino)))
        try F.ownedMutation(.credentialFixtureSeed, in: keychain) {
            for capability in capabilities {
                var trusted: SecTrustedApplication?, access: SecAccess?
                let trustStatus = SecTrustedApplicationCreateFromPath(nil, &trusted)
                guard trustStatus == errSecSuccess, let trusted,
                      SecAccessCreate("Synthetic credential fixture" as CFString, [trusted] as CFArray, &access) == errSecSuccess,
                      let access else { throw F.Failure("FIXTURE_ACCESS_FAILED") }
                var value = ProbeConfiguration.scenario == "invalid" && capability == capabilities[0]
                    ? Data([0xff, 0x00, 0x7f]) : Data(try F.randomValue().utf8)
                defer { value.resetBytes(in: 0..<value.count) }
                let attributes: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                    kSecUseKeychain as String: keychain, kSecAttrService as String: service(capability),
                    kSecAttrAccount as String: F.account, kSecValueData as String: value, kSecAttrAccess as String: access]
                try F.require(SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess, "FIXTURE_SEED_FAILED")
            }
            return ((), .committed)
        }
    }

    static func snapshot() throws -> [[String: Any]] {
        let keychain = try F.openKeychain()
        return try capabilities.map { capability in
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecMatchSearchList as String: [keychain], kSecAttrService as String: service(capability),
                kSecAttrAccount as String: F.account, kSecMatchLimit as String: kSecMatchLimitOne, kSecReturnRef as String: true]
            var found: CFTypeRef?
            try F.require(SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, "FIXTURE_ITEM_MISSING")
            guard let found, CFGetTypeID(found) == SecKeychainItemGetTypeID() else { throw F.Failure("FIXTURE_ITEM_INVALID") }
            let item = found as! SecKeychainItem
            var persistent: CFData?, access: SecAccess?, acls: CFArray?
            try F.require(SecKeychainItemCreatePersistentReference(item, &persistent) == errSecSuccess
                && SecKeychainItemCopyAccess(item, &access) == errSecSuccess, "FIXTURE_METADATA_UNAVAILABLE")
            guard let persistent, let access else { throw F.Failure("FIXTURE_METADATA_UNAVAILABLE") }
            try F.require(SecAccessCopyACLList(access, &acls) == errSecSuccess, "FIXTURE_ACL_UNAVAILABLE")
            var aclBytes = Data()
            for acl in (acls as? [SecACL] ?? []) {
                var apps: CFArray?, description: CFString?, selector = SecKeychainPromptSelector()
                try F.require(SecACLCopyContents(acl, &apps, &description, &selector) == errSecSuccess, "FIXTURE_ACL_UNAVAILABLE")
                guard let authorizations = SecACLCopyAuthorizations(acl) as? [String] else { throw F.Failure("FIXTURE_ACL_UNAVAILABLE") }
                aclBytes.append(Data(authorizations.sorted().joined(separator: "\0").utf8))
                withUnsafeBytes(of: &selector) { aclBytes.append(contentsOf: $0) }
                for app in (apps as? [SecTrustedApplication] ?? []) {
                    var bytes: CFData?
                    try F.require(SecTrustedApplicationCopyData(app, &bytes) == errSecSuccess, "FIXTURE_ACL_UNAVAILABLE")
                    guard let bytes else { throw F.Failure("FIXTURE_ACL_UNAVAILABLE") }
                    aclBytes.append(bytes as Data)
                }
            }
            var dataQuery = query; dataQuery.removeValue(forKey: kSecReturnRef as String)
            dataQuery[kSecReturnData as String] = true
            var data: CFTypeRef?
            let readStatus = SecItemCopyMatching(dataQuery as CFDictionary, &data)
            let readable = readStatus == errSecSuccess
            var bytes = data as? Data
            defer { if bytes != nil { bytes!.resetBytes(in: 0..<bytes!.count) } }
            try F.require(readable && bytes != nil, "FIXTURE_READBACK_FAILED")
            return ["capability": capability, "readable": readable,
                    "valueDigest": bytes.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } as Any? ?? NSNull(),
                    "itemDigest": SHA256.hash(data: persistent as Data).map { String(format: "%02x", $0) }.joined(),
                    "aclDigest": SHA256.hash(data: aclBytes).map { String(format: "%02x", $0) }.joined()]
        }
    }

    static func select() throws {
        try F.require(!selected, "FIXTURE_SCOPE_ALREADY_SELECTED")
        let keychain = try F.openKeychain()
        var current: CFArray?, currentDefault: SecKeychain?
        try F.require(SecKeychainCopySearchList(&current) == errSecSuccess
            && SecKeychainCopyDefault(&currentDefault) == errSecSuccess, "FIXTURE_SCOPE_UNAVAILABLE")
        guard let current, let currentDefault, let oldSearch, let oldDefault else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        try F.require(CFEqual(current, oldSearch) && CFEqual(currentDefault, oldDefault), "FIXTURE_SCOPE_CHANGED_DURING_SEED")
        try F.writePrivate("scope-intent.json", ["nonce": ProbeConfiguration.nonce])
        // No production namespace query is issued against the previous list.
        try F.require(SecKeychainSetSearchList([keychain] as CFArray) == errSecSuccess, "FIXTURE_SCOPE_SELECT_FAILED")
        selected = true // Even a later default-selection failure requires restore.
        try F.require(SecKeychainSetDefault(keychain) == errSecSuccess, "FIXTURE_DEFAULT_SELECT_FAILED")
        defaultSelected = true
        try assertSelected(keychain)
        try F.writePrivate("scope-selected.json", ["nonce": ProbeConfiguration.nonce, "selected": true])
    }

    static func assertSelected(_ keychain: SecKeychain) throws {
        var current: CFArray?, currentDefault: SecKeychain?
        try F.require(SecKeychainCopySearchList(&current) == errSecSuccess
            && SecKeychainCopyDefault(&currentDefault) == errSecSuccess,
            "FIXTURE_SCOPE_UNAVAILABLE")
        guard let current, let currentDefault else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        try F.require(CFEqual(current, [keychain] as CFArray) && CFEqual(currentDefault, keychain), "FIXTURE_SCOPE_CHANGED")
    }

    static func restore() throws {
        guard selected else { return }
        guard let oldSearch, let oldDefault else { throw F.Failure("FIXTURE_SCOPE_RESTORE_UNAVAILABLE") }
        let keychain = try F.openKeychain()
        var current: CFArray?, currentDefault: SecKeychain?
        try F.require(SecKeychainCopySearchList(&current) == errSecSuccess
            && SecKeychainCopyDefault(&currentDefault) == errSecSuccess, "FIXTURE_SCOPE_UNAVAILABLE")
        guard let selectedSearch = current, let selectedDefault = currentDefault else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        // A successfully selected list followed by a failed default selection
        // still has an exact recoverable state. Never overwrite foreign drift.
        try F.require(CFEqual(selectedSearch, [keychain] as CFArray)
            && CFEqual(selectedDefault, defaultSelected ? keychain : oldDefault), "FIXTURE_SCOPE_CHANGED")
        if defaultSelected {
            try F.require(SecKeychainSetDefault(oldDefault) == errSecSuccess, "FIXTURE_DEFAULT_RESTORE_FAILED")
            defaultSelected = false
        }
        try F.require(SecKeychainSetSearchList(oldSearch) == errSecSuccess, "FIXTURE_SEARCH_RESTORE_FAILED")
        try F.require(SecKeychainCopySearchList(&current) == errSecSuccess
            && SecKeychainCopyDefault(&currentDefault) == errSecSuccess, "FIXTURE_SCOPE_RESTORE_FAILED")
        guard let current, let currentDefault else { throw F.Failure("FIXTURE_SCOPE_RESTORE_FAILED") }
        try F.require(CFEqual(current, oldSearch) && CFEqual(currentDefault, oldDefault), "FIXTURE_SCOPE_RESTORE_FAILED")
        selected = false
        try F.writePrivate("scope-restored.json", ["nonce": ProbeConfiguration.nonce, "restored": true])
    }

    static func setLocked(_ value: Bool) throws {
        try F.require(ProbeConfiguration.scenario == "locked" && selected && locked != value,
                      "FIXTURE_LOCK_STATE_INVALID")
        let keychain = try F.openKeychain()
        try assertSelected(keychain)
        try F.ownedMutation(value ? .credentialFixtureLock : .credentialFixtureUnlock, in: keychain) {
            let status = value ? SecKeychainLock(keychain) : password.withUnsafeBytes {
                SecKeychainUnlock(keychain, UInt32($0.count), $0.baseAddress, true)
            }
            try F.require(status == errSecSuccess, "FIXTURE_LOCK_OPERATION_FAILED")
            var observed: SecKeychainStatus = 0
            try F.require(SecKeychainGetStatus(keychain, &observed) == errSecSuccess
                && ((observed & kSecUnlockStateStatus) != 0) == !value, "FIXTURE_LOCK_NOT_APPLIED")
            return ((), .committed)
        }
        locked = value
    }

    static func main() {
        do {
            try host() // Refuse a local operator before any Security interaction setting or item access.
            try F.configure()
            defer { password.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
            F.report(["ok": true, "ready": true])
            var commands = 0, seeded = false, cleaned = false
            while let line = try nextCommand() {
                commands += 1
                try F.require(line.utf8.count < 64 && commands <= 16, "FIXTURE_PROTOCOL_LIMIT")
                switch line {
                case "seed": try F.require(!seeded, "FIXTURE_ALREADY_SEEDED"); try seed(); seeded = true
                case "snapshot": try F.require(seeded && !locked, "FIXTURE_NOT_READABLE")
                    F.report(["ok": true, "items": try snapshot()]); continue
                case "select": try F.require(seeded, "FIXTURE_NOT_SEEDED"); try select()
                case "lock": try setLocked(true)
                case "unlock": try setLocked(false)
                case "restore": try restore()
                case "cleanup": try F.require(seeded && !selected && !locked, "FIXTURE_CLEANUP_NOT_READY")
                    try F.require(try F.cleanup(), "FIXTURE_CLEANUP_FAILED"); cleaned = true
                default: throw F.Failure("FIXTURE_COMMAND_INVALID")
                }
                F.report(["ok": true, "operation": line])
                if cleaned { return }
            }
            try restore()
            throw F.Failure("FIXTURE_PROTOCOL_ENDED")
        } catch {
            // A failed journal is never repaired or adopted. Restore only if the
            // exact current owned keychain and selected scope still validate.
            try? restore()
            F.fail(error)
        }
    }

    static func nextCommand() throws -> String? {
        var bytes = [UInt8]()
        while bytes.count < 64 {
            var byte: UInt8 = 0
            let count = Darwin.read(STDIN_FILENO, &byte, 1)
            if count == -1 && errno == EINTR { continue }
            try F.require(count >= 0, "FIXTURE_PROTOCOL_READ_FAILED")
            if count == 0 { try F.require(bytes.isEmpty, "FIXTURE_PROTOCOL_TRUNCATED"); return nil }
            if byte == 10 { guard let command = String(bytes: bytes, encoding: .utf8) else { throw F.Failure("FIXTURE_PROTOCOL_INVALID") }; return command }
            bytes.append(byte)
        }
        throw F.Failure("FIXTURE_PROTOCOL_LIMIT")
    }
}
