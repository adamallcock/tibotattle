---
title: G1 Resource and Identity Protection Receipt
date: 2026-07-24
type: verification-receipt
status: verified-slice
---

# G1 Resource and Identity Protection Receipt

## Verdict

The immediate single-bundle resource protections and local export-identity lifecycle are implemented and verified for the local-only proof of concept. This is a passed implementation slice, not completion of G1-R3 or authorization to collect volunteer data.

## What is now enforced

- One compatibility-bound resource policy covers the requested time span, streamed directory traversal, selected source files and bytes, JSONL line allocation, optional activity-marker input, normalized output records and bytes, canonical bundle bytes, elapsed time, and RSS.
- Oversized source lines are discarded only when a bounded fixed-marker classifier proves they cannot contain a relevant record. Relevant or ambiguous oversized lines fail closed with a fixed content-free code.
- Direct callers cannot bypass the activity-marker record ceiling by supplying an already-materialized array.
- The standalone verifier applies the same 32 MiB canonical-bundle and 100,000-record ceilings before semantic verification.
- Canonical and legacy participant secrets must agree or export fails closed. Successful migration retires the legacy location with an owner-only tombstone.
- Identity rotation requires explicit confirmation, refuses environment-supplied identity, atomically installs one complete secret, changes every derived namespace, and is serialized against export publication by an identity lease.
- Rotation does not rewrite existing bundles and does not claim secure erasure of filesystem history or backups.
- No upload, server, enrollment, or external transport exists; exported bundles remain `transportReady: false`.

## Measured local history evidence

A 31-day discovery/scan baseline selected 1,384 source files totaling 21,656,801,910 bytes and observed 163,612 usage records, 246,954 quota records, and 243,217 tool records. It completed in 103,365 ms with an 820,723,712-byte RSS increase and 1,267,200 KiB maximum RSS. This demonstrated why the existing whole-history in-memory builder cannot be the volunteer-facing design.

A constant-memory line survey covered 2,396 active/archive JSONL files and 3,323,306 physical lines. It found 217 lines above 16 MiB, 111 above 32 MiB, four above 64 MiB, and a maximum line size of 84,070,547 bytes. Those observations informed the bounded fixed-marker classifier and fail-closed ambiguity rule.

## Verification evidence

- Focused resource, exporter, identity, contract, and collector suite: 59/59 passed.
- Full test suite: 254/254 passed.
- Telemetry generation and contract check: 149 fields current; 9/9 contract tests passed.
- `git diff --check`: passed.
- Independent code/identity re-audit: no actionable findings.
- Independent test/documentation re-audit: prior findings fixed; the final identity-lifecycle wording was aligned with implementation.

The fresh live local export used exporter `0.3.0-draft.2`, scanner `codex-log-scan-v3`, adapter `codex-metadata-export-v4`, and resource policy `g1-r3-candidate-0.2`. For the UTC interval 2026-07-24T19:30:00Z through 2026-07-24T22:35:00Z it produced 1,614 usage records and 1,653 quota records from 26 source files. The 3,646,802-byte canonical bundle passed all seven privacy checks and standalone verification. Bundle and receipt were regular single-link files with mode `0600`, and both are ignored by Git.

## Remaining G1-R3 work

The current exporter still materializes one complete sanitized bundle. The next gate is the planned owner-only SQLite workspace with a frozen source-prefix plan, transactional safe-record index and checkpoints, deterministic bounded chunk pairs, complete-set manifest, interrupted-run recovery, `verify-export-set`, cross-restart resource accounting, and stable golden hashes.

Also still open are crash-recoverable local export deletion, native platform secret stores and clean-machine packaging, Claude export parity, prospective account-scoped quota evidence, compression/encryption decisions, the minimization ablation, and volunteer-local review. No external participant should run or share this build yet.
