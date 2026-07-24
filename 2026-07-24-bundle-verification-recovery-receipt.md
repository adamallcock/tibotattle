---
title: Bundle Verification and Recovery Milestone Receipt
date: 2026-07-24
type: validation
status: passed-bounded-milestone
---

# Bundle Verification and Recovery Milestone Receipt

## Verdict

The local metadata exporter now produces a version-traceable bundle/receipt pair that can be independently verified against the current checkout and recovered after an interrupted receipt-first commit. The implementation passed its focused adversarial tests, the complete repository suite, the deterministic telemetry-contract gate, and a fresh bounded replay of real local Codex logs.

This is a bounded G1 milestone, not G1 completion. It does not authorize volunteer collection, upload, server ingestion, or public reporting. Telemetry v0.1 remains `draft_local_only_unfrozen`, `externalParticipantsAuthorized: false`, and `transportReady: false`.

## Implemented controls

### Closed compatibility tuple

`generated/telemetry-v0.1-compatibility.json` is regenerated and checked with the field dictionary. It binds:

- the raw SHA-256 and `$id` of all six telemetry schemas plus one set hash;
- the generated 148-field contract version and raw SHA-256;
- package name/version and exporter implementation version;
- the executed Codex rollout parser and metadata-adapter versions;
- the reviewed provider/model/limit/diagnostic registry snapshot and hash;
- the local consent status and raw artifact hash;
- the local-only contract status and raw artifact hash; and
- explicit provider adapter status: OpenAI Codex `implemented`, Anthropic Claude Code `not_implemented`.

The exporter asserts that the scanner version returned by the executed scan matches the tuple. The privacy gate requires exact equality with the generated live tuple and rejects any declared or observed provider whose bound adapter is not implemented.

### Standalone verification

`usage-monitor verify-bundle --input PATH [--receipt PATH]` reads the receipt first, then the bounded bundle. It fails closed unless:

- both artifacts are adjacent, owner-controlled, single-link regular files with no group/world permissions;
- JSON bytes are the exact canonical serialization;
- the receipt and bundle validate against the current strict schemas;
- coverage bounds are chronological; usage event time, quota observed/received time, and marker observed time are within them; and quota receipt cannot precede observation;
- usage, quota, and marker occurrence IDs are unique and records are deterministically ordered;
- every observed provider is declared and its compatibility-bound adapter is implemented;
- privacy checks regenerate exactly from the bundle and receipt timestamp; and
- raw bundle bytes match the receipt byte count and SHA-256.

Success output contains only the contract/exporter versions, record counts, byte count, and disabled-transport state. Fixed verifier errors do not include paths, bundle values, participant IDs, or private source content.

### Crash-recoverable paired output

`export-local` now writes a private transaction directory beneath the canonical destination. An atomic destination lock and reclaimable claim serialize writers and recovery. It exclusively creates and syncs the bundle and receipt stages, fully writes and syncs a prepared canonical manifest containing only destination basenames plus exact stage byte counts and SHA-256 values, and publishes that manifest by exclusive hard-link before it:

1. hard-links and syncs the receipt;
2. hard-links and syncs the bundle as the commit point; and
3. removes the manifest/stages/transaction root so each final artifact returns to link count 1.

After the manifest is durable, failures deliberately leave recoverable evidence. `usage-monitor recover-exports --directory PATH` validates manifest shape, owner/permission controls, staged bytes, hashes, and inode identity before completing the receipt-first sequence. It never treats an equal-content foreign inode as its own file and never replaces a conflicting destination. Recovery is idempotent after cleanup.

## Executable evidence

Commands run from the repository root:

```text
npm test
npm run telemetry:check
git diff --check
node ./src/cli.js export-local --since 2026-07-24T18:10:45.000Z --until 2026-07-24T19:10:45.000Z --output exports/g1-verification-recovery-audited-2026-07-24.umx.json --secret-file .usage-monitor/export-participant-secret
node ./src/cli.js verify-bundle --input exports/g1-verification-recovery-audited-2026-07-24.umx.json
```

Validated results:

- full repository suite: 239/239 tests passed;
- telemetry/schema focused gate: 9/9 tests passed;
- generated contract: 148/148 fields across six schemas, compatibility manifest current;
- diff whitespace check: passed after removing one generated-policy trailing blank line;
- crash simulations: passed after transaction preparation, manifest preparation/link/sync, receipt publication, bundle publication, manifest cleanup, and interrupted recovery itself;
- recovery edge cases: empty/partial pre-commit cleanup, idempotent replay, deliberate bundle-only repair, foreign-file conflict refusal, second-link I/O failure, stage-symlink refusal, concurrent-writer serialization, stale-lock recovery, dual-reaper election, claim handoff, canonical-parent alias swap, and CLI recovery;
- verifier adversarial cases: tampered bundle, tampered receipt, non-canonical JSON, reversed bounds, duplicate IDs, integer/fractional timestamp misordering, invalid quota receipt timing, undeclared provider, hardlink, symlink, unsafe parent mode, and content-free CLI output.

## Fresh local dry run

The bounded replay from `2026-07-24T18:10:45.000Z` through `2026-07-24T19:10:45.000Z` produced ignored local artifacts only:

- source files scanned: 20;
- usage events: 463;
- quota snapshots: 471;
- activity markers: 0;
- bundle bytes: 1,046,544;
- privacy checks: 7/7 passed;
- bundle and receipt modes: `0600`;
- bundle and receipt final link counts: 1;
- receipt SHA-256 and byte count: exact;
- leftover transaction directory: none; and
- `transportReady`: `false`.

The new standalone verifier accepted that exact pair and reported `telemetry-v0.1`, `draft_local_only_unfrozen`, exporter `0.2.0-draft.1`, and upload disabled.

## Evidence boundary and residual gaps

- Verification establishes consistency with the current local checkout and generated contract; it is not release signing, binary provenance, or external attestation.
- The verifier cannot reconstruct discarded private source values. Source-value canaries are export-time evidence only when explicitly supplied and fixture evidence in tests.
- Recovery is explicit; startup auto-recovery and coordinated multi-process writers targeting the same final names are not yet a finished operator experience.
- Transaction metadata is owner-only local state, not an encrypted transport envelope.
- Native Windows confidentiality, platform secret stores, identity rotation/deletion UX, streaming/chunked resource budgets, compression limits, clean-machine packaging, and signed releases remain open.
- Claude usage/quota export, prospective account-scoped app-server quota export, provider parity, and minimization ablation remain open.
- No enrollment, upload credential, network client, server, bucket, ingestion, aggregation, personal portal, or public website exists in this slice.

The comprehensive end-to-end goal therefore remains active. The next safe G1 work should address resource-bounded streaming/chunking and local identity lifecycle before any transport design is implemented.
