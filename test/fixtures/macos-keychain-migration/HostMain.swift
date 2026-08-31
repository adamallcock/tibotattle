import Foundation
import Security
import Darwin

@main
struct SyntheticMigrationHost {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2 else { exit(2) }
            try MigrationProbeFixture.configure()
            #if PROBE_REPLACEMENT
            guard CommandLine.arguments[1] == "--verify-upgrade" else { exit(2) }
            let keychain = try MigrationProbeFixture.openKeychain()
            let stored = MigrationProbeFixture.read(MigrationProbeFixture.modernService,
                                                    from: keychain)
            guard stored.status == errSecSuccess, let value = stored.value else {
                throw MigrationProbeFixture.Failure("UPGRADE_MODERN_READ_FAILED")
            }
            try MigrationProbeFixture.require(try MigrationProbeFixture.matchesSeed(value),
                                               "UPGRADE_IDENTITY_CHANGED")
            MigrationProbeFixture.report([
                "ok": true, "modernReadWithoutHelper": true, "syntheticKeyUnchanged": true,
            ])
            #else
            switch CommandLine.arguments[1] {
            case "--migrate": try migrate()
            case "--verify-modern-denial": try verifyModernDenial()
            case "--verify-timeout": try verifyTimeout()
            case "--verify-invalid-value": try verifyInvalidValue()
            default: exit(2)
            }
            #endif
        } catch { MigrationProbeFixture.fail(error) }
    }

    static func helper(_ kind: String) -> URL {
        MigrationProbeFixture.root.appendingPathComponent("\(kind).app")
            .appendingPathComponent(LegacyKeychainMigration.helperRelativePath)
    }

    static func migrate() throws {
        let keychain = try MigrationProbeFixture.openKeychain()
        let initialModern = MigrationProbeFixture.read(MigrationProbeFixture.modernService,
                                                       from: keychain)
        try MigrationProbeFixture.require(initialModern.status == errSecItemNotFound,
                                           "UNEXPECTED_EXISTING_MODERN_ITEM")
        let directLegacy = MigrationProbeFixture.read(MigrationProbeFixture.legacyService,
                                                      from: keychain)
        try MigrationProbeFixture.require(directLegacy.denied && directLegacy.value == nil,
                                           "APP_WAS_ALREADY_TRUSTED_BY_LEGACY_ACL")
        let result = LegacyKeychainMigration.read(.accountObservation, expectedIdentity: .stable,
                                                   executable: helper("Host"))
        guard case .value(let value) = result else {
            throw MigrationProbeFixture.Failure("TRUSTED_HELPER_READ_FAILED")
        }
        try MigrationProbeFixture.require(try MigrationProbeFixture.matchesSeed(value),
                                           "HELPER_VALUE_CHANGED")
        try MigrationProbeFixture.require(try MigrationProbeFixture.adopt(value, into: keychain),
                                           "SHARED_ADOPTION_FAILED")
        let stored = MigrationProbeFixture.read(MigrationProbeFixture.modernService, from: keychain)
        try MigrationProbeFixture.require(stored.status == errSecSuccess && stored.value == value,
                                           "MODERN_READBACK_FAILED")
        try MigrationProbeFixture.require(try MigrationProbeFixture.adopt(value, into: keychain),
                                           "EXACT_REPEAT_ADOPTION_FAILED")
        let other = try MigrationProbeFixture.randomValue()
        try MigrationProbeFixture.require(try other != value
            && !MigrationProbeFixture.adopt(other, into: keychain)
            && MigrationProbeFixture.read(MigrationProbeFixture.modernService,
                                           from: keychain).value == value,
                                           "EXISTING_MODERN_ITEM_CLOBBERED")
        try MigrationProbeFixture.require(MigrationProbeFixture.legacyPresent(in: keychain),
                                           "LEGACY_ITEM_NOT_PRESERVED")
        MigrationProbeFixture.report([
            "ok": true, "appLegacyReadDenied": true, "helperReadExactSeed": true,
            "sharedAdoptionPassed": true, "modernReadBackExact": true,
            "repeatAdoptionPassed": true, "legacyItemRetained": true,
            "differentExistingValueNotClobbered": true,
        ])
    }

    static func verifyModernDenial() throws {
        let result = LegacyKeychainMigration.read(.accountObservation, expectedIdentity: .stable,
                                                   executable: helper("Modern"))
        guard case .unavailable = result else {
            throw MigrationProbeFixture.Failure("HELPER_MODERN_READ_NOT_DENIED")
        }
        let witness = try MigrationProbeFixture.readPrivate("reader-modern-denied.json")
        try MigrationProbeFixture.require(witness["nonce"] as? String == ProbeConfiguration.nonce,
                                           "HELPER_MODERN_DENIAL_NOT_WITNESSED")
        MigrationProbeFixture.report(["ok": true, "helperModernReadDenied": true])
    }

    static func verifyTimeout() throws {
        let start = DispatchTime.now().uptimeNanoseconds
        let result = LegacyKeychainMigration.read(.accountObservation, expectedIdentity: .stable,
                                                   executable: helper("Timeout"))
        let elapsed = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        switch result {
        case .unavailable, .rejected: break
        default: throw MigrationProbeFixture.Failure("TIMEOUT_NOT_REPORTED")
        }
        let witness = try MigrationProbeFixture.readPrivate("reader-timeout.json")
        guard witness["nonce"] as? String == ProbeConfiguration.nonce,
              let number = witness["pid"] as? NSNumber, number.int32Value > 1 else {
            throw MigrationProbeFixture.Failure("TIMEOUT_READER_NOT_STARTED")
        }
        let pid = number.int32Value
        var status: Int32 = 0
        let waited = waitpid(pid, &status, WNOHANG)
        try MigrationProbeFixture.require(waited == -1 && errno == ECHILD,
                                           "TIMEOUT_CHILD_NOT_REAPED")
        try MigrationProbeFixture.require(elapsed >= 1_000 && elapsed < 4_000,
                                           "TIMEOUT_BOUND_EXCEEDED")
        MigrationProbeFixture.report([
            "ok": true, "timeoutBounded": true, "childReaped": true,
            "elapsedMilliseconds": elapsed,
        ])
    }

    static func verifyInvalidValue() throws {
        let result = LegacyKeychainMigration.read(.accountObservation, expectedIdentity: .stable,
                                                   executable: helper("InvalidValue"))
        switch result {
        case .unavailable, .rejected: break
        default: throw MigrationProbeFixture.Failure("INVALID_VALUE_NOT_REJECTED")
        }
        let witness = try MigrationProbeFixture.readPrivate("reader-invalid-value.json")
        try MigrationProbeFixture.require(witness["nonce"] as? String == ProbeConfiguration.nonce,
                                           "INVALID_VALUE_READER_NOT_STARTED")
        MigrationProbeFixture.report(["ok": true, "invalidValueRejected": true])
    }
}
