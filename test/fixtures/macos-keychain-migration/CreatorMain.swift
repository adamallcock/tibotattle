import Foundation
import Darwin

@main
struct SyntheticLegacyCreator {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2 else { exit(2) }
            let operation = CommandLine.arguments[1]
            guard ["--create-synthetic-keychain", "--cleanup-synthetic-keychain"]
                .contains(operation) else { exit(2) }
            try MigrationProbeFixture.configure()
            if operation == "--create-synthetic-keychain" {
                try MigrationProbeFixture.createLegacy()
                MigrationProbeFixture.report(["ok": true, "legacySeedCreated": true])
            } else {
                let deleted = try MigrationProbeFixture.cleanup()
                try MigrationProbeFixture.require(deleted, "CLEANUP_INCOMPLETE")
                MigrationProbeFixture.report(["ok": true, "disposableKeychainRemoved": true])
            }
        } catch { MigrationProbeFixture.fail(error) }
    }
}
