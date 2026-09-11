import Foundation

@main
enum TiboTattleKeychainMigrationHelper {
    static func main() {
        exit(LegacyKeychainMigration.runHelper())
    }
}
