import Foundation
import Darwin

enum ReviewedSyntheticRecoveryPathPolicy {
    static func isCanonical(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.utf8.contains(0),
              let canonical = path.withCString({ Darwin.realpath($0, nil) }) else { return false }
        defer { free(canonical) }
        // Foundation deliberately abbreviates /private/var to /var here. Use
        // the filesystem's exact canonical spelling, as used to review the
        // pins; accepting an alias would weaken the no-symlink boundary.
        return String(cString: canonical) == path
    }
}

#if PROBE_RECOVERY_PATH_TEST
// Pure metadata regression composition. Security is not imported or linked;
// no receipts are opened, no files are written, and no cleanup path is present.
@main
struct ReviewedSyntheticRecoveryPathTests {
    static func main() {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        let path = CommandLine.arguments[1]
        let root = URL(fileURLWithPath: path)
        let checks = [
            ReviewedSyntheticRecoveryPathPolicy.isCanonical(path),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical(path + "/."),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical(path + "/"),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical(path + "/../" + root.lastPathComponent),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical(path + "\0ignored"),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical("relative/fixture"),
            !ReviewedSyntheticRecoveryPathPolicy.isCanonical(path + "/absent-fixture-path-policy-test"),
        ]
        let alias = root.standardizedFileURL.path
        let aliasRejected = alias == path || !ReviewedSyntheticRecoveryPathPolicy.isCanonical(alias)
        guard checks.allSatisfy({ $0 }) && aliasRejected else {
            print("{\"ok\":false,\"code\":\"RECOVERY_PATH_POLICY_REGRESSION\"}")
            exit(1)
        }
        print("{\"ok\":true,\"pathPolicyPassed\":true,\"assertions\":8,\"foundationChangedCanonicalSpelling\":\(alias != path)}")
    }
}
#else
import Security

// Explicit, separately reviewed synthetic-fixture recovery only. Not built by
// the runner, not shipped, and no runtime path/pin override. The operator must
// compile a private ProbeRecoveryConfiguration from independently checked
// metadata; never generate new authority from whatever inode is present now.
@main
struct ReviewedSyntheticKeychainRecovery {
    struct Failure: Error { let code: String }
    static var root: URL { URL(fileURLWithPath: ProbeRecoveryConfiguration.root) }
    static var database: URL { root.appendingPathComponent("synthetic.keychain-db") }

    static func require(_ condition: @autoclosure () -> Bool, _ code: String) throws {
        guard condition() else { throw Failure(code: code) }
    }

    static func validateRoot() throws {
        var metadata = stat()
        try require(ReviewedSyntheticRecoveryPathPolicy.isCanonical(ProbeRecoveryConfiguration.root)
            && root.path == ProbeRecoveryConfiguration.root
            && root.lastPathComponent.hasPrefix("tibotattle-keychain-probe.")
            && lstat(root.path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFDIR
            && metadata.st_mode & 0o777 == 0o700 && metadata.st_uid == ProbeRecoveryConfiguration.uid
            && geteuid() == ProbeRecoveryConfiguration.uid
            && metadata.st_dev == ProbeRecoveryConfiguration.device
            && UInt64(metadata.st_ino) == ProbeRecoveryConfiguration.rootInode,
                    "REVIEWED_ROOT_CHANGED")
    }

    static func receipt(_ name: String) throws -> [String: Any] {
        let fd = open(root.appendingPathComponent(name).path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure(code: "REVIEWED_RECEIPT_UNAVAILABLE") }
        defer { close(fd) }
        var metadata = stat()
        try require(fstat(fd, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_mode & 0o777 == 0o600 && metadata.st_uid == ProbeRecoveryConfiguration.uid
            && metadata.st_nlink == 1 && metadata.st_size > 0 && metadata.st_size <= 4096,
                    "REVIEWED_RECEIPT_CHANGED")
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
        var offset = 0
        while offset < bytes.count {
            let remaining = bytes.count - offset
            let count = bytes.withUnsafeMutableBytes {
                Darwin.read(fd, $0.baseAddress!.advanced(by: offset), remaining)
            }
            if count < 0 && errno == EINTR { continue }
            try require(count > 0, "REVIEWED_RECEIPT_TRUNCATED")
            offset += count
        }
        guard let result = try JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any]
        else { throw Failure(code: "REVIEWED_RECEIPT_INVALID") }
        return result
    }

    static func validateOriginalEvidence() throws {
        try validateRoot()
        let owner = try receipt("owner.json")
        let original = try receipt("keychain-owner.json")
        let intent = try receipt("creation-intent.json")
        try require([owner, original, intent].allSatisfy {
            $0["nonce"] as? String == ProbeRecoveryConfiguration.nonce
        } && (owner["uid"] as? NSNumber)?.uint32Value == ProbeRecoveryConfiguration.uid
            && (owner["inode"] as? NSNumber)?.uint64Value == ProbeRecoveryConfiguration.rootInode
            && (original["inode"] as? NSNumber)?.uint64Value == ProbeRecoveryConfiguration.originalInode
            && (original["device"] as? NSNumber)?.int32Value == ProbeRecoveryConfiguration.device,
                    "REVIEWED_ORIGINAL_EVIDENCE_CHANGED")
    }

    static func validateDatabase() throws {
        try validateRoot()
        var metadata = stat()
        try require(lstat(database.path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_uid == ProbeRecoveryConfiguration.uid && metadata.st_mode & 0o777 == 0o600
            && metadata.st_nlink == 1 && metadata.st_dev == ProbeRecoveryConfiguration.device
            && UInt64(metadata.st_ino) == ProbeRecoveryConfiguration.reviewedInode
            && metadata.st_size == ProbeRecoveryConfiguration.size
            && metadata.st_mtimespec.tv_sec == ProbeRecoveryConfiguration.mtimeSeconds
            && metadata.st_mtimespec.tv_nsec == ProbeRecoveryConfiguration.mtimeNanoseconds
            && metadata.st_ctimespec.tv_sec == ProbeRecoveryConfiguration.ctimeSeconds
            && metadata.st_ctimespec.tv_nsec == ProbeRecoveryConfiguration.ctimeNanoseconds
            && metadata.st_birthtimespec.tv_sec == ProbeRecoveryConfiguration.birthSeconds
            && metadata.st_birthtimespec.tv_nsec == ProbeRecoveryConfiguration.birthNanoseconds,
                    "REVIEWED_DATABASE_CHANGED")
    }

    static func keychainPath(_ keychain: SecKeychain) throws -> String {
        var count: UInt32 = 4096
        var bytes = [CChar](repeating: 0, count: Int(count))
        try require(SecKeychainGetPath(keychain, &count, &bytes) == errSecSuccess,
                    "KEYCHAIN_PATH_UNAVAILABLE")
        return String(cString: bytes)
    }

    static func preferences() throws -> [[String]] {
        var current: CFArray?
        var user: CFArray?
        var defaultKeychain: SecKeychain?
        try require(SecKeychainCopySearchList(&current) == errSecSuccess
            && SecKeychainCopyDomainSearchList(.user, &user) == errSecSuccess
            && SecKeychainCopyDomainDefault(.user, &defaultKeychain) == errSecSuccess,
                    "KEYCHAIN_PREFERENCES_UNAVAILABLE")
        guard let current = current as? [SecKeychain], let user = user as? [SecKeychain],
              let defaultKeychain else { throw Failure(code: "KEYCHAIN_PREFERENCES_UNAVAILABLE") }
        // Metadata stays only in RAM. No preferences are changed or printed.
        return try [current.map(keychainPath), user.map(keychainPath), [keychainPath(defaultKeychain)]]
    }

    static func writeEvidence(_ name: String, _ object: [String: Any]) throws {
        try validateRoot()
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let fd = open(root.appendingPathComponent(name).path,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure(code: "RECOVERY_EVIDENCE_EXISTS_OR_UNAVAILABLE") }
        defer { close(fd) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                try require(count > 0, "RECOVERY_EVIDENCE_WRITE_FAILED")
                offset += count
            }
        }
        try require(fsync(fd) == 0, "RECOVERY_EVIDENCE_SYNC_FAILED")
    }

    static func run() throws {
        umask(0o077)
        var limit = rlimit(rlim_cur: 0, rlim_max: 0)
        try require(setrlimit(RLIMIT_CORE, &limit) == 0, "CORE_DUMPS_NOT_DISABLED")
        try require(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess,
                    "INTERACTION_NOT_DISABLED")
        try validateOriginalEvidence()
        try validateDatabase()
        let before = try preferences()
        try require(!before.flatMap { $0 }.contains(database.path), "SEARCHED_OR_DEFAULT_KEYCHAIN_REFUSED")
        var keychain: SecKeychain?
        try require(SecKeychainOpen(database.path, &keychain) == errSecSuccess, "REVIEWED_KEYCHAIN_OPEN_FAILED")
        guard let keychain else { throw Failure(code: "REVIEWED_KEYCHAIN_OPEN_FAILED") }
        let actualPath = try keychainPath(keychain)
        try require(actualPath == database.path, "REVIEWED_KEYCHAIN_REFERENCE_CHANGED")
        try validateOriginalEvidence()
        try validateDatabase()
        try writeEvidence("reviewed-cleanup-intent.json", [
            "nonce": ProbeRecoveryConfiguration.nonce, "originalInode": ProbeRecoveryConfiguration.originalInode,
            "reviewedInode": ProbeRecoveryConfiguration.reviewedInode, "device": ProbeRecoveryConfiguration.device,
            "rootInode": ProbeRecoveryConfiguration.rootInode, "contentRead": false,
        ])
        try validateDatabase()
        let deleted = SecKeychainDelete(keychain)
        let after = try preferences()
        var metadata = stat()
        let absent = lstat(database.path, &metadata) == -1 && errno == ENOENT
        let result: [String: Any] = [
            "ok": deleted == errSecSuccess && absent && before == after,
            "disposableKeychainRemoved": deleted == errSecSuccess && absent,
            "defaultAndSearchListsUnchanged": before == after, "contentRead": false,
            "originalEvidencePreserved": true,
        ]
        try validateOriginalEvidence()
        try writeEvidence("reviewed-cleanup-result.json", result)
        try require(deleted == errSecSuccess && absent && before == after, "REVIEWED_CLEANUP_UNVERIFIED")
        print("{\"ok\":true,\"disposableKeychainRemoved\":true,\"defaultAndSearchListsUnchanged\":true,\"originalEvidencePreserved\":true}")
    }

    static func main() {
        guard CommandLine.arguments == [CommandLine.arguments[0], "--delete-reviewed-synthetic-keychain"]
        else { exit(2) }
        do { try run() } catch {
            let code = (error as? Failure)?.code ?? "REVIEWED_RECOVERY_FAILED"
            print("{\"ok\":false,\"code\":\"\(code)\"}")
            exit(1)
        }
    }
}
#endif
