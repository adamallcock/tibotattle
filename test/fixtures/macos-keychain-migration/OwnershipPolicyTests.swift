import Foundation

// Runs only the pure ownership reducer. It never links Security or opens files.
@main
struct SyntheticOwnershipPolicyTests {
    typealias Policy = MigrationProbeOwnership
    static var assertions = 0

    static func require(_ value: @autoclosure () throws -> Bool) throws {
        guard try value() else { throw Policy.Failure.invalid }
        assertions += 1
    }

    static func refuses(_ body: () throws -> Void) throws {
        do { try body() } catch { assertions += 1; return }
        throw Policy.Failure.invalid
    }

    static func main() {
        do {
            let first = Policy.Identity(device: 7, inode: 100)
            let seeded = Policy.Identity(device: 7, inode: 101)
            let adopted = Policy.Identity(device: 7, inode: 102)
            let baseline = Policy.Baseline(version: 2, nonce: "synthetic", device: 7, inode: 100)
            let seed = Policy.Intent(sequence: 1, nonce: "synthetic", operation: .legacySeed, before: first)
            let seedEntry = Policy.Entry(intent: seed,
                completion: Policy.Completion(intent: seed, after: seeded, outcome: .committed), failed: false)
            let add = Policy.Intent(sequence: 2, nonce: "synthetic", operation: .modernAdoption, before: seeded)
            let addEntry = Policy.Entry(intent: add,
                completion: Policy.Completion(intent: add, after: adopted, outcome: .committed), failed: false)
            let repeatIntent = Policy.Intent(sequence: 3, nonce: "synthetic", operation: .modernAdoption,
                                             before: adopted)
            let repeatEntry = Policy.Entry(intent: repeatIntent,
                completion: Policy.Completion(intent: repeatIntent, after: adopted, outcome: .unchanged), failed: false)
            let chain = [seedEntry, addEntry, repeatEntry]
            try require(Policy.current(baseline, entries: [], nonce: "synthetic") == first)
            try require(Policy.current(baseline, entries: [seedEntry], nonce: "synthetic") == seeded)
            try require(Policy.current(baseline, entries: chain, nonce: "synthetic") == adopted)
            try require(!Policy.matches(first, observed: seeded)) // Original stale-baseline regression.
            try require(!Policy.matches(adopted, observed: .init(device: 7, inode: 103)))
            try require(!Policy.matches(adopted, observed: .init(device: 8, inode: 102)))
            try require(Policy.matches(adopted, observed: adopted))
            for entries in [
                [Policy.Entry(intent: seed, completion: nil, failed: false)],
                [Policy.Entry(intent: seed, completion: nil, failed: true)],
                [Policy.Entry(intent: seed, completion: seedEntry.completion, failed: true)],
                [Policy.Entry(intent: nil, completion: seedEntry.completion, failed: false)],
                [addEntry], [seedEntry, repeatEntry],
            ] {
                try refuses { _ = try Policy.current(baseline, entries: entries, nonce: "synthetic") }
            }
            let pending = Policy.Entry(intent: seed, completion: nil, failed: false)
            try require(Policy.current(baseline, entries: [pending], nonce: "synthetic", pending: seed) == first)
            try refuses { _ = try Policy.current(baseline, entries: [pending], nonce: "synthetic", pending: add) }
            try refuses { _ = try Policy.current(baseline, entries: [], nonce: "synthetic", pending: seed) }
            try refuses { _ = try Policy.current(baseline, entries: [pending, addEntry], nonce: "synthetic", pending: seed) }
            try refuses { _ = try Policy.current(baseline, entries: chain, nonce: "wrong") }
            for after in [Policy.Identity(device: 8, inode: 101), .init(device: 7, inode: 0)] {
                let entry = Policy.Entry(intent: seed,
                    completion: Policy.Completion(intent: seed, after: after, outcome: .committed), failed: false)
                try refuses { _ = try Policy.current(baseline, entries: [entry], nonce: "synthetic") }
            }
            for outcome in [Policy.Outcome.unchanged, .rolledBack] {
                let entry = Policy.Entry(intent: seed,
                    completion: Policy.Completion(intent: seed, after: seeded, outcome: outcome), failed: false)
                try refuses { _ = try Policy.current(baseline, entries: [entry], nonce: "synthetic") }
            }
            let rolledBack = Policy.Entry(intent: add,
                completion: Policy.Completion(intent: add, after: adopted, outcome: .rolledBack), failed: false)
            try require(Policy.current(baseline, entries: [seedEntry, rolledBack], nonce: "synthetic") == adopted)
            let wrongIntent = Policy.Intent(sequence: 1, nonce: "wrong", operation: .legacySeed, before: first)
            let forged = Policy.Entry(intent: seed,
                completion: Policy.Completion(intent: wrongIntent, after: seeded, outcome: .committed), failed: false)
            try refuses { _ = try Policy.current(baseline, entries: [forged], nonce: "synthetic") }
            let tooMany = Array(repeating: seedEntry, count: Policy.maximumWrites + 1)
            try refuses { _ = try Policy.current(baseline, entries: tooMany, nonce: "synthetic") }
            try refuses {
                _ = try JSONDecoder().decode(Policy.Operation.self, from: Data("\"unreviewedWrite\"".utf8))
            }
            print("{\"ok\":true,\"ownershipPolicyPassed\":true,\"assertions\":\(assertions)}")
        } catch {
            print("{\"ok\":false,\"code\":\"OWNERSHIP_POLICY_REGRESSION\"}")
            exit(1)
        }
    }
}
