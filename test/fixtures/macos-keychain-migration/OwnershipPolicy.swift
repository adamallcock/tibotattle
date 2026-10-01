// Pure fixture bookkeeping. No filesystem, Security, signing, or process APIs.
// Only a completed, verified fixture write or observed signed-app transition
// can advance an inode pin. An incomplete observation is never authority.
enum MigrationProbeOwnership {
    static let maximumWrites = 8

    enum Failure: Error { case invalid, incomplete }
    enum Operation: String, Codable { case legacySeed, modernAdoption, credentialFixtureSeed, credentialFixtureLock, credentialFixtureUnlock, credentialAppStableRewrite }
    enum Outcome: String, Codable { case committed, unchanged, rolledBack, observedStable }

    struct Identity: Codable, Equatable {
        let device: Int32
        let inode: UInt64
    }

    struct Baseline: Codable {
        let version: Int
        let nonce: String
        let device: Int32
        let inode: UInt64
        var identity: Identity { Identity(device: device, inode: inode) }
    }

    struct Intent: Codable, Equatable {
        let sequence: Int
        let nonce: String
        let operation: Operation
        let before: Identity
    }

    struct Completion: Codable {
        let intent: Intent
        let after: Identity
        let outcome: Outcome
    }

    struct Entry {
        let intent: Intent?
        let completion: Completion?
        let failed: Bool
    }

    static func current(_ baseline: Baseline, entries: [Entry], nonce: String,
                        pending: Intent? = nil) throws -> Identity {
        guard baseline.version == 2, baseline.nonce == nonce, !nonce.isEmpty,
              baseline.inode > 0, entries.count <= maximumWrites else {
            throw Failure.invalid
        }
        var current = baseline.identity
        var matchedPending = false
        for (offset, entry) in entries.enumerated() {
            guard let intent = entry.intent, intent.sequence == offset + 1,
                  intent.nonce == nonce, intent.before == current else {
                throw Failure.invalid
            }
            guard !entry.failed else { throw Failure.incomplete }
            guard let completion = entry.completion else {
                // A live writer may check its own final pending intent. Reads
                // and cleanup never pass pending and therefore fail closed.
                guard pending == intent, offset == entries.count - 1 else {
                    throw Failure.incomplete
                }
                matchedPending = true
                continue
            }
            guard completion.intent == intent, completion.after.inode > 0,
                  completion.after.device == current.device else { throw Failure.invalid }
            switch completion.outcome {
            case .committed:
                guard intent.operation != .credentialAppStableRewrite else { throw Failure.invalid }
            case .unchanged:
                guard completion.after == current
                    && intent.operation != .credentialAppStableRewrite else { throw Failure.invalid }
            case .rolledBack:
                guard intent.operation == .modernAdoption else { throw Failure.invalid }
            case .observedStable:
                guard intent.operation == .credentialAppStableRewrite else { throw Failure.invalid }
            }
            current = completion.after
        }
        guard pending == nil || matchedPending else { throw Failure.invalid }
        return current
    }

    static func matches(_ current: Identity, observed: Identity) -> Bool {
        current == observed
    }
}
