---
title: Real Local Backend Acceptance Plan
date: 2026-07-27
type: plan
status: verified-local
---

# Goal

Make the existing real-local Codex export and disposable Worker/D1/R2 backend
proof reproducible without turning ordinary product startup into a log scan or
upload path.

# Safety boundary

- The ordinary backend laboratory continues to use a generated, content-free
  fixture.
- Real local logs are read only after an exact command-line confirmation,
  explicit UTC bounds of at most one hour, an explicit Codex home, and an
  explicit owner-only participant identity file.
- The real path makes no external network request. Its only HTTP traffic is to
  the loopback Worker started for the disposable acceptance run.
- Review bundles, prepared contributions, invitations, participant state, D1,
  and R2 emulation live under one new owner-only workspace.
- A successful run moves that workspace to the local Trash only when the
  operator explicitly selects recoverable cleanup.
- The only durable output outside Trash is a no-clobber, owner-only,
  content-free receipt. It contains digests, counts, UTC coverage, lifecycle
  assertions, and final storage counts, but no paths, credentials, account or
  participant identifiers, source content, or backend capabilities.
- A failed run retains the operator-selected workspace for inspection and
  prints no private path or identifier.

# Implementation

1. Extend the disposable backend laboratory with mutually exclusive generated
   fixture and explicit owner-only prepared-contribution modes. Preserve the
   generated fixture as the default.
2. In real-file mode, emit a path-free laboratory receipt and path-free stdout
   while retaining the same twenty-participant ingest, rejection, repricing,
   aggregation, restart, export, deletion, and final D1/R2 checks.
3. Add an opt-in root orchestrator that:
   - validates confirmation, UTC bounds, cleanup selection, and local paths
     before reading logs or starting a Worker;
   - runs the existing local preparation path with the explicit identity file;
   - independently reopens the source privacy pair and prepared set;
   - selects and verifies one prepared member;
   - runs the real-file backend laboratory in a fresh workspace;
   - binds source receipt, bundle, prepared manifest, and selected-member
     digests to the backend result; and
   - moves the workspace to Trash before publishing the final receipt.
4. Add synthetic local-log tests that exercise preparation and receipt
   projection while injecting the backend result and Trash operation. Tests
   must perform no Keychain access, external network request, or real-log scan.

# Verification

- Pure argument tests prove missing confirmation and conflicting source modes
  fail before any source or network dependency is called.
- Synthetic local fixtures prove exporter, privacy verification,
  materialization, prepared-set verification, receipt binding, no-clobber
  output, and recoverable-cleanup sequencing.
- Receipt tests recursively reject path-, authority-, and identifier-bearing
  keys and scan serialized output for fixture secrets and paths.
- Worker operator checks cover the new laboratory argument contract.
- A real local run remains an explicit owner action because it reads private
  local logs and exercises disposable local infrastructure.

# Verified completion boundary

The first fresh real-local receipt completed at
`2026-07-27T06:49:25.450Z`. The selected one-hour interval contained 394
sanitized usage events and 402 quota snapshots. All source privacy checks
passed, the builder committed four bounded batches, and the selected
200-record member completed the twenty-participant backend lifecycle.

# Implemented command

Create one owner-only output directory. The identity file may be absent; the
existing identity lease will create it there as a mode-0600 development
identity. The work directory and receipt file must not already exist.

```bash
mkdir -m 700 /private/tmp/app-usagemonitor-real-proof

npm run product:backend:acceptance:real-local -- \
  --confirm ACCEPT_REAL_LOCAL_CODEX_EXPORT \
  --start-at 2026-07-27T05:00:00.000Z \
  --end-at 2026-07-27T06:00:00.000Z \
  --codex-home /Users/adamallcock/.codex \
  --identity-file /private/tmp/app-usagemonitor-real-proof/work/identity.secret \
  --work-directory /private/tmp/app-usagemonitor-real-proof/work \
  --receipt-file /private/tmp/app-usagemonitor-real-proof/acceptance-receipt.json \
  --cleanup recoverable-trash \
  --port 8793
```

The exact UTC interval should be replaced with a bounded recent hour known to
contain Codex usage. A successful run moves `work`, including the fresh
development identity, to the local Trash and leaves only the owner-only
content-free receipt outside Trash. A failed run retains `work` at the
already-known operator-selected location and does not publish a success receipt.

# Implementation verification

- Synthetic exporter-to-prepared-set-to-receipt tests passed without Keychain
  or network access, including confirmation, one-hour, no-clobber, receipt
  privacy, cleanup-failure, and retained-workspace gates.
- Worker operator checks passed with the new mutually exclusive source mode.
- The full generated-fixture twenty-participant Worker/D1/R2 acceptance
  lifecycle passed on July 27, 2026 with the new receipt schema, after which its
  disposable workspace was moved to Trash.
- A separately authorized real local-log run passed after implementation. It
  verified rejection, deduplication, canonical server repricing, private
  statistics, delayed community publication, authenticated comparison,
  participant export, both deletion scopes, and persisted restart. Final live
  participant, contribution, canonical-record, quarantine-reference, and R2
  object counts were zero.
- The secret-bearing workspace and temporary development identity were moved
  to Trash. The only retained proof is the owner-only, content-free
  `.usage-monitor/private/real-local-backend-acceptance-2026-07-27-v0.1.json`
  receipt. It contains no paths, credentials, account or participant
  identifiers, or source content.
