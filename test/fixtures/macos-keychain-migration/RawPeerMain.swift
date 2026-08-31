import Foundation
import Darwin

// A deliberately minimal hostile/invalid parent. It never reads a Keychain and
// never renders a received frame. The helper must close without releasing data.
@main
struct SyntheticRawPeer {
    struct Failure: Error {}

    final class Child {
        private(set) var pid: pid_t = 0
        private var reaped = false

        init(executable: String, endpoint: Int32) throws {
            var actions: posix_spawn_file_actions_t?
            var attributes: posix_spawnattr_t?
            guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure() }
            defer { posix_spawn_file_actions_destroy(&actions) }
            guard posix_spawnattr_init(&attributes) == 0 else { throw Failure() }
            defer { posix_spawnattr_destroy(&attributes) }
            var mask = sigset_t()
            sigemptyset(&mask)
            guard posix_spawnattr_setsigmask(&attributes, &mask) == 0,
                  posix_spawnattr_setflags(&attributes,
                    Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK)) == 0,
                  posix_spawn_file_actions_adddup2(&actions, endpoint, STDIN_FILENO) == 0,
                  posix_spawn_file_actions_addopen(
                    &actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0,
                  posix_spawn_file_actions_addopen(
                    &actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 else {
                throw Failure()
            }
            let argument = strdup(executable)
            let environment = strdup("PATH=/usr/bin:/bin:/usr/sbin:/sbin")
            defer { free(argument); free(environment) }
            guard argument != nil, environment != nil else { throw Failure() }
            var argv = [argument, nil]
            var envp = [environment, nil]
            guard posix_spawn(&pid, executable, &actions, &attributes, &argv, &envp) == 0,
                  pid > 1 else { throw Failure() }
        }

        func finish(allowAlarm: Bool = false) -> Bool {
            guard !reaped, pid > 1 else { return reaped }
            let deadline = DispatchTime.now().uptimeNanoseconds + 2_500_000_000
            var status: Int32 = 0
            while DispatchTime.now().uptimeNanoseconds < deadline {
                let result = waitpid(pid, &status, WNOHANG)
                if result == pid {
                    reaped = true
                    // Darwin wait-status macros are not imported into Swift.
                    // A crash or signal is not an authentication-rejection pass.
                    return (status & 0x7f == 0 && (status >> 8) & 0xff == 1)
                        || (allowAlarm && status & 0x7f == SIGALRM)
                }
                if result < 0 && errno != EINTR { break }
                usleep(10_000)
            }
            _ = kill(pid, SIGKILL)
            var result: pid_t
            repeat { result = waitpid(pid, &status, 0) } while result < 0 && errno == EINTR
            reaped = result == pid
            return false
        }

        deinit { _ = finish() }
    }

    static func writeAll(_ bytes: Data, _ descriptor: Int32) throws {
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let result = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset),
                                          buffer.count - offset)
                if result < 0 && errno == EINTR { continue }
                guard result > 0 else { throw Failure() }
                offset += result
            }
        }
    }

    static func readBounded(_ descriptor: Int32, frameOnly: Bool = false)
        -> (bytes: Data, timedOut: Bool) {
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        var received = Data()
        while received.count <= LegacyKeychainMigration.maximumFrameBytes {
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline { return (received, true) }
            var item = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let remaining = Int32(min((deadline - now) / 1_000_000 + 1, 200))
            let ready = poll(&item, 1, remaining)
            if ready < 0 && errno == EINTR { continue }
            if ready <= 0 { continue }
            if item.revents & Int16(POLLIN) != 0 {
                var byte: UInt8 = 0
                let count = Darwin.read(descriptor, &byte, 1)
                if count == 1 {
                    received.append(byte)
                    if frameOnly && byte == 0x0A { return (received, false) }
                    continue
                }
                if count == 0 { return (received, false) }
                if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            }
            if item.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 {
                return (received, false)
            }
        }
        return (received, false)
    }

    static func main() {
        do {
            guard CommandLine.arguments.count == 3 else { exit(2) }
            let mode = CommandLine.arguments[1]
            let helper = CommandLine.arguments[2]
            guard ["invalid-capability", "malformed-frame", "oversized-frame",
                   "wrong-continue", "no-frame", "valid-request", "parent-exits-during-reader"]
                .contains(mode),
                  helper.hasSuffix("/" + LegacyKeychainMigration.helperRelativePath)
            else { exit(2) }
            try MigrationProbeFixture.configure()
            var sockets: [Int32] = [-1, -1]
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw Failure() }
            defer { close(sockets[0]); if sockets[1] >= 0 { close(sockets[1]) } }
            for socket in sockets {
                var enabled: Int32 = 1
                guard fcntl(socket, F_SETFD, FD_CLOEXEC) == 0,
                      setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &enabled,
                                 socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw Failure() }
            }
            let child = try Child(executable: helper, endpoint: sockets[1])
            close(sockets[1]); sockets[1] = -1
            switch mode {
            case "invalid-capability":
                try writeAll(Data("{\"v\":1,\"capability\":\"not_allowed\"}\n".utf8), sockets[0])
            case "malformed-frame":
                try writeAll(Data("{not-json}\n".utf8), sockets[0])
            case "oversized-frame":
                try writeAll(Data(repeating: 0x61,
                    count: LegacyKeychainMigration.maximumFrameBytes + 1), sockets[0])
            case "wrong-continue", "valid-request", "parent-exits-during-reader":
                try writeAll(Data("{\"v\":1,\"capability\":\"account_observation\"}\n".utf8),
                             sockets[0])
                let hello = readBounded(sockets[0], frameOnly: true)
                if mode == "wrong-continue" || mode == "parent-exits-during-reader" {
                    guard !hello.timedOut,
                          let frame = try JSONSerialization.jsonObject(with: hello.bytes)
                            as? [String: Any],
                          Set(frame.keys) == Set(["v", "ready"]),
                          frame["ready"] as? Bool == true else { throw Failure() }
                    if mode == "parent-exits-during-reader" {
                        try writeAll(Data("{\"v\":1,\"continue\":true}\n".utf8), sockets[0])
                        let limit = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
                        while DispatchTime.now().uptimeNanoseconds < limit {
                            if let witness = try? MigrationProbeFixture.readPrivate("reader-orphan.json"),
                               witness["nonce"] as? String == ProbeConfiguration.nonce,
                               (witness["pid"] as? NSNumber)?.int32Value == child.pid {
                                MigrationProbeFixture.report([
                                    "ok": true, "parentExitedDuringReader": true, "helperPID": child.pid,
                                ])
                                // Deliberately bypass Child.deinit/finish. This
                                // is the test, not a production lifecycle path.
                                _exit(0)
                            }
                            usleep(5_000)
                        }
                        throw Failure()
                    }
                    try writeAll(Data("{\"v\":1,\"continue\":\"true\"}\n".utf8), sockets[0])
                } else if hello.bytes.isEmpty {
                    // The untrusted parent must be rejected before a read.
                } else {
                    throw Failure()
                }
            case "no-frame": break
            default: throw Failure()
            }
            let response = readBounded(sockets[0])
            let rendered = String(data: response.bytes, encoding: .utf8) ?? ""
            let noSecret = !rendered.contains("\"secret\"")
            shutdown(sockets[0], SHUT_RDWR)
            let rejected = child.finish(allowAlarm: mode == "no-frame")
            guard noSecret && rejected else { throw Failure() }
            MigrationProbeFixture.report([
                "ok": true, "peerRejected": true, "noSecretFrame": true,
                "childReaped": true,
            ])
        } catch {
            MigrationProbeFixture.report(["ok": false, "code": "RAW_PEER_PROBE_FAILED"])
            exit(1)
        }
    }
}
