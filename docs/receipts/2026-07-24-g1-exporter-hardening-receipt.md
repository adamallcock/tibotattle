---
title: G1 Exporter Hardening Milestone Receipt
date: 2026-07-24
type: validation
status: passed-bounded-milestone
---

# G1 Exporter Hardening Milestone Receipt

## Verdict

The source-identity, reviewed-vocabulary, missing-value, field-dictionary, POSIX secret-file, and paired local-output slice is implemented and passes its bounded acceptance checks. This is not G1 completion and does not authorize volunteer collection, upload, or public reporting.

Telemetry v0.1 remains an explicitly unfrozen local-only draft with no backward-compatibility promise. Earlier ignored review bundles must be regenerated. The first volunteer or upload-capable contract will use a new frozen version; frozen predecessors may not be edited in place.

## Implemented contract

- Codex usage events use `event:v2` IDs derived only from provider, source format, privacy-safe session scope, physical JSONL record ordinal, and record kind.
- Quota observations use equivalent `snapshot:v2` source-occurrence IDs plus their slot. A separate `quota-state:v1` ID describes comparable provider state; unattributed state includes session scope and cannot collapse across unknown accounts.
- Activity markers use `marker:v2` IDs derived only from a required persisted UUID.
- Scanner replay keys include source scope, preventing equal records in independent sessions from being discarded.
- Recognized model, limit, and diagnostic values are closed reviewed vocabularies. Unknown model strings become keyed fingerprints; arbitrary safe-looking strings fail schema validation.
- Missing source token components remain `null`. Numeric zero is emitted only where the corresponding source component was present.
- All twelve tool-class count fields are required. Their bounded-interval attribution is documented as a limitation and is outside occurrence identity.
- The deterministic field dictionary covers all 109 properties across all five telemetry schemas, resolves the three bundle references, records schema SHA-256 hashes, and joins every property to reviewed purpose, privacy, retention, publication, Codex provenance, Claude provenance, and limitation policy.
- POSIX identity-file reads reject symlinks, hardlinks, wrong length, loose permissions, non-regular files, and ownership changes. The default path is OS-stable and a validated legacy secret can be copied forward without removing its source.
- Local bundle/receipt output requires distinct paths in one canonical owner-controlled directory, refuses existing targets, stages with random exclusive files, publishes the receipt first and bundle last, and rolls back an ordinary bundle-link failure.

## Executable evidence

Commands run from the repository root:

```text
node scripts/generate-telemetry-contract.js
pnpm --ignore-workspace run telemetry:check
pnpm --ignore-workspace test
git diff --check
```

Results:

- telemetry contract current: 109/109 fields;
- telemetry/schema focused gate: 9/9 tests passed;
- full repository suite: 202/202 tests passed;
- diff whitespace check: passed.

The regression suite includes changed export bounds, independent identical sessions, reversed file assignment, marker metadata changes, missing token fields, unreviewed model/limit/diagnostic strings, schema/registry equality, secret symlink/hardlink/permission attacks, distinct/output-existing paths, and injected second-link failure.

## Live local dry run

A bounded replay from `2026-07-24T18:10:45.000Z` through `2026-07-24T19:10:45.000Z` used the existing explicit owner-only exporter secret and produced ignored local artifacts only:

- source files scanned: 13;
- usage events: 463;
- quota snapshots: 471;
- activity markers: 0;
- bundle bytes: 1,043,449;
- unique occurrence IDs: 934/934;
- all usage IDs: `event:v2`;
- all quota observation IDs: `snapshot:v2`;
- every quota snapshot has a provider-state ID;
- bundle and receipt mode: `0600`;
- receipt hash and byte count: exact match;
- privacy checks: 5/5 passed;
- `transportReady`: `false`.

A second write to the same target exited with code 1 and `Refusing to overwrite an existing local export artifact`.

## Explicit residual gaps

This slice does not yet provide:

- crash recovery after process termination between receipt and bundle publication, or a standalone `verify-bundle` command;
- streaming/chunked bounded export for very large histories;
- macOS Keychain, Windows Credential Manager, or Linux Secret Service integration;
- a complete native Windows confidentiality claim;
- explicit operator-confirmed legacy identity-conflict migration UX;
- a full bundle version tuple covering schema hashes, parser, adapter, registry, and consent compatibility;
- Claude usage/quota adapter parity;
- prospective account-scoped app-server quota export;
- signed packages, clean-machine testing, or volunteer review; or
- any network transport, enrollment, server, or aggregation path.

The end-to-end goal therefore remains active. The next implementation slice should add bundle verification/recovery and version traceability before provider parity and bounded streaming.
