import Foundation
import Security
import CryptoKit
import Darwin

// Signed test composition only. Values are read only from the journal-owned
// fixture. The fixed System exception checks namespace absence without results.
// No login items are queried and no service/path is accepted from input.
@main
struct ElectronCredentialFixture {
    typealias F = MigrationProbeFixture
    static let capabilities = ["account-observation", "contribution-device", "accountless-installation"]
    static var password = [UInt8](repeating: 0, count: 32)
    // Keep all five native capabilities here, including the two not seeded by
    // this journey. A source contract test refuses native namespace drift.
    static let systemServices = [
        "app-usagemonitor.export-identity.app.v1", "app-usagemonitor.export-identity.v1",
        "app-usagemonitor.account-observation.app.v1", "app-usagemonitor.account-observation.v1",
        "app-usagemonitor.claude-session-pseudonym.app.v1", "app-usagemonitor.claude-session-pseudonym.v1",
        "app-usagemonitor.contribution-device.app.v1", "app-usagemonitor.contribution-device.v1",
        "app-usagemonitor.accountless-installation.app.v1", "app-usagemonitor.accountless-installation.v1",
    ]
    static let systemPath = "/Library/Keychains/System.keychain"
    struct Scope {
        let user: [SecKeychain]
        let common: [SecKeychain]
        let dynamic: [SecKeychain]
        let aggregate: [SecKeychain]
        let userDefault: SecKeychain
    }
    struct SystemIdentity: Equatable {
        let device: Int32, inode: UInt64, owner: UInt32, group: UInt32, mode: UInt16, links: UInt16
        let size: Int64, modifiedSeconds: Int, modifiedNanoseconds: Int, changedSeconds: Int, changedNanoseconds: Int
    }
    static var originalScope: Scope?
    static var systemIdentity: SystemIdentity?
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
        let scope = try readScope()
        try F.require(scope.dynamic.isEmpty, "FIXTURE_DYNAMIC_DOMAIN_REFUSED")
        try F.require(scope.common.count <= 1, "FIXTURE_COMMON_DOMAIN_REFUSED")
        if let system = scope.common.first { systemIdentity = try systemMetadata(system) }
        originalScope = scope
        try assertCommon(scope)
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
        if selected { try assertSelected(keychain) }
        let result = try capabilities.map { capability in
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
        if selected { try assertSelected(keychain) }
        return result
    }

    static func domainList(_ domain: SecPreferencesDomain) throws -> [SecKeychain] {
        var value: CFArray?
        try F.require(SecKeychainCopyDomainSearchList(domain, &value) == errSecSuccess,
                      "FIXTURE_SCOPE_UNAVAILABLE")
        guard let value, CFArrayGetCount(value) <= 16, let list = value as? [SecKeychain] else {
            throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE")
        }
        return list
    }

    static func readScope() throws -> Scope {
        var preference = SecPreferencesDomain.user
        var ordinaryDefault: SecKeychain?, userDefault: SecKeychain?, aggregate: CFArray?
        try F.require(SecKeychainGetPreferenceDomain(&preference) == errSecSuccess && preference == .user,
                      "FIXTURE_PREFERENCE_DOMAIN_REFUSED")
        try F.require(SecKeychainCopyDefault(&ordinaryDefault) == errSecSuccess
            && SecKeychainCopyDomainDefault(.user, &userDefault) == errSecSuccess
            && SecKeychainCopySearchList(&aggregate) == errSecSuccess, "FIXTURE_SCOPE_UNAVAILABLE")
        guard let ordinaryDefault, let userDefault, let aggregate, CFArrayGetCount(aggregate) <= 48,
              let aggregateList = aggregate as? [SecKeychain] else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        try F.require(CFEqual(ordinaryDefault, userDefault), "FIXTURE_DEFAULT_DOMAIN_MISMATCH")
        let user = try domainList(.user), common = try domainList(.common), dynamic = try domainList(.dynamic)
        // Apple's aggregate preserves this exact order and multiplicity.
        try F.require(CFEqual(aggregate, (dynamic + user + common) as CFArray), "FIXTURE_AGGREGATE_DOMAIN_MISMATCH")
        return Scope(user: user, common: common, dynamic: dynamic, aggregate: aggregateList, userDefault: userDefault)
    }

    static func systemMetadata(_ keychain: SecKeychain) throws -> SystemIdentity {
        var length: UInt32 = 1024, bytes = [CChar](repeating: 0, count: 1024)
        try F.require(SecKeychainGetPath(keychain, &length, &bytes) == errSecSuccess
            && length == systemPath.utf8.count
            && bytes.prefix(Int(length)).map({ UInt8(bitPattern: $0) }) == Array(systemPath.utf8),
            "FIXTURE_SYSTEM_PATH_REFUSED")
        // Metadata only: never open/read System bytes. Every ancestor is fixed,
        // root-owned and non-writable by group/other; aliases and links refuse.
        for path in ["/", "/Library", "/Library/Keychains"] {
            var info = stat()
            try F.require(lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
                && info.st_uid == 0 && (info.st_mode & 0o022) == 0, "FIXTURE_SYSTEM_PATH_REFUSED")
        }
        var info = stat()
        try F.require(lstat(systemPath, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
            && info.st_uid == 0 && info.st_nlink == 1 && (info.st_mode & 0o022) == 0
            && info.st_size > 0, "FIXTURE_SYSTEM_METADATA_REFUSED")
        return SystemIdentity(device: info.st_dev, inode: UInt64(info.st_ino), owner: info.st_uid,
            group: info.st_gid, mode: info.st_mode, links: info.st_nlink, size: info.st_size,
            modifiedSeconds: info.st_mtimespec.tv_sec, modifiedNanoseconds: info.st_mtimespec.tv_nsec,
            changedSeconds: info.st_ctimespec.tv_sec, changedNanoseconds: info.st_ctimespec.tv_nsec)
    }

    static func assertCommon(_ scope: Scope) throws {
        guard let originalScope else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        try F.require(scope.dynamic.isEmpty && originalScope.dynamic.isEmpty, "FIXTURE_DYNAMIC_DOMAIN_REFUSED")
        try F.require(scope.common.count <= 1 && CFEqual(scope.common as CFArray, originalScope.common as CFArray),
                      "FIXTURE_COMMON_DOMAIN_CHANGED")
        guard let system = scope.common.first else {
            try F.require(systemIdentity == nil, "FIXTURE_SYSTEM_METADATA_CHANGED")
            return
        }
        try F.require(try systemMetadata(system) == systemIdentity, "FIXTURE_SYSTEM_METADATA_CHANGED")
        for service in systemServices {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecMatchSearchList as String: [system], kSecAttrService as String: service,
                kSecAttrAccount as String: F.account, kSecMatchLimit as String: kSecMatchLimitOne]
            // Existence/status only. No return-data/ref/attributes flag, no
            // output pointer, no login/user query, and no System unlock/write.
            try F.require(SecItemCopyMatching(query as CFDictionary, nil) == errSecItemNotFound,
                          "FIXTURE_SYSTEM_NAMESPACE_NOT_ABSENT")
            var status: SecKeychainStatus = 0
            try F.require(SecKeychainGetStatus(system, &status) == errSecSuccess
                && (status & kSecReadPermStatus) != 0, "FIXTURE_SYSTEM_NOT_READABLE")
        }
        try F.require(try systemMetadata(system) == systemIdentity, "FIXTURE_SYSTEM_METADATA_CHANGED")
    }

    static func assertScope(user: [SecKeychain], userDefault: SecKeychain) throws {
        let scope = try readScope()
        try assertCommon(scope)
        try F.require(CFEqual(scope.user as CFArray, user as CFArray), "FIXTURE_USER_DOMAIN_CHANGED")
        try F.require(CFEqual(scope.userDefault, userDefault), "FIXTURE_USER_DEFAULT_CHANGED")
        let after = try readScope()
        try F.require(CFEqual(after.user as CFArray, scope.user as CFArray), "FIXTURE_USER_DOMAIN_CHANGED")
        try F.require(CFEqual(after.common as CFArray, scope.common as CFArray), "FIXTURE_COMMON_DOMAIN_CHANGED")
        try F.require(after.dynamic.isEmpty, "FIXTURE_DYNAMIC_DOMAIN_REFUSED")
        try F.require(CFEqual(after.userDefault, scope.userDefault), "FIXTURE_USER_DEFAULT_CHANGED")
    }

    static func select() throws {
        try F.require(!selected, "FIXTURE_SCOPE_ALREADY_SELECTED")
        guard let originalScope else { throw F.Failure("FIXTURE_SCOPE_UNAVAILABLE") }
        let keychain = try F.openKeychain()
        try assertScope(user: originalScope.user, userDefault: originalScope.userDefault)
        try F.writePrivate("scope-intent.json", ["nonce": ProbeConfiguration.nonce])
        // Only the explicit user domain is changed; common/dynamic are preserved.
        try F.require(SecKeychainSetDomainSearchList(.user, [keychain] as CFArray) == errSecSuccess,
                      "FIXTURE_SCOPE_SELECT_FAILED")
        selected = true // Even a later default-selection failure requires restore.
        try F.require(SecKeychainSetDomainDefault(.user, keychain) == errSecSuccess, "FIXTURE_DEFAULT_SELECT_FAILED")
        defaultSelected = true
        try assertSelected(keychain)
        try F.writePrivate("scope-selected.json", ["nonce": ProbeConfiguration.nonce, "selected": true])
    }

    static func assertSelected(_ keychain: SecKeychain) throws {
        try F.require(selected && defaultSelected, "FIXTURE_SCOPE_NOT_SELECTED")
        try assertScope(user: [keychain], userDefault: keychain)
    }

    static func scopeProof() throws -> [String: Any] {
        try assertSelected(F.openKeychain())
        return ["schemaVersion": "mac-credential-isolated-scope-v1", "userDomainFixtureOnly": true,
            "defaultFixture": true, "dynamicDomainEmpty": true, "aggregateMatchesDomains": true,
            "commonDomain": systemIdentity == nil ? "empty" : "verified_system",
            "systemNamespacesAbsent": systemIdentity == nil ? 0 : systemServices.count]
    }

    static func restore() throws {
        guard selected else { return }
        guard let originalScope else { throw F.Failure("FIXTURE_SCOPE_RESTORE_UNAVAILABLE") }
        let keychain = try F.openKeychain()
        // A selected user list followed by a failed default selection is an
        // exact recoverable state. Never overwrite foreign domain/default drift.
        try assertScope(user: [keychain], userDefault: defaultSelected ? keychain : originalScope.userDefault)
        if defaultSelected {
            try F.require(SecKeychainSetDomainDefault(.user, originalScope.userDefault) == errSecSuccess,
                          "FIXTURE_DEFAULT_RESTORE_FAILED")
            defaultSelected = false
        }
        try F.require(SecKeychainSetDomainSearchList(.user, originalScope.user as CFArray) == errSecSuccess,
                      "FIXTURE_SEARCH_RESTORE_FAILED")
        try assertScope(user: originalScope.user, userDefault: originalScope.userDefault)
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
                    F.report(["ok": true, "operation": line, "scope": try scopeProof()]); continue
                case "scope": F.report(["ok": true, "operation": line, "scope": try scopeProof()]); continue
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
