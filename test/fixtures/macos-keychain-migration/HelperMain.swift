import Foundation
import Security
import Darwin

@main
struct SyntheticMigrationHelper {
    static func main() {
        // The production helper is separately compiled and never imports this
        // reader, configuration, path, witness, or compile-time fixture variant.
        let result = LegacyKeychainMigration.runHelper(reader: { capability, identity in
            do {
                try MigrationProbeFixture.configure()
                guard capability == .accountObservation && identity == .stable else {
                    return .rejected
                }
                #if PROBE_PARENT_EXIT
                try MigrationProbeFixture.recordReader("orphan")
                Thread.sleep(forTimeInterval: 5)
                return .unavailable
                #elseif PROBE_TIMEOUT
                try MigrationProbeFixture.recordReader("timeout")
                Thread.sleep(forTimeInterval: 5)
                return .unavailable
                #elseif PROBE_INVALID_VALUE
                try MigrationProbeFixture.recordReader("invalid-value")
                return .value("not-a-valid-secret")
                #elseif PROBE_MODERN_READ
                let keychain = try MigrationProbeFixture.openKeychain()
                let result = MigrationProbeFixture.read(MigrationProbeFixture.modernService,
                                                        from: keychain)
                guard result.denied && result.value == nil else { return .rejected }
                try MigrationProbeFixture.recordReader("modern-denied")
                return .unavailable
                #else
                try MigrationProbeFixture.recordReader("legacy")
                let keychain = try MigrationProbeFixture.openKeychain()
                let result = MigrationProbeFixture.read(MigrationProbeFixture.legacyService,
                                                        from: keychain)
                guard result.status == errSecSuccess, let value = result.value,
                      try MigrationProbeFixture.matchesSeed(value) else { return .unavailable }
                return .value(value)
                #endif
            } catch { return .unavailable }
        })
        exit(result)
    }
}
