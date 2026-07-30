---
title: Ongoing Sync Controls Plan
date: 2026-07-26
type: plan
status: completed-development
---

# Ongoing sync controls

## Outcome

Close two practical Stage 10 gaps in the existing foreground-only contribution
queue:

1. let a participant inspect the next privacy-safe contribution before any
   network request; and
2. expose enforceable per-pass upload-count and conservative upload-body
   reservations for both one-shot and foreground-watch delivery.

This slice must not install a scheduler, create a daemon, contact a service
during inspection, weaken prepared-set verification, or expose a path,
filename, digest, occurrence identifier, participant/account scope, service
origin, or credential.

## Existing pathway

The current implementation already provides:

- separately consented, upload-only device credentials;
- a foreground one-shot command and foreground watch;
- a crash-safe owner-only SQLite queue;
- prepared-set re-verification before delivery;
- bounded retry and expired-lease recovery;
- pause/resume;
- server-side device revocation; and
- aggregate-only queue status in the CLI and local dashboard.

Before this slice, the queue internally limited jobs per pass and bounded watch
intervals from 30 to 3,600 seconds, but those internal limits were not
configurable from the CLI and the user could not inspect the next payload
projection without beginning a sync pass.

## Inspect-next contract

`sync-contributions-inspect-next` will:

- require an explicit prepared-set or prepared-spool directory;
- discover and verify committed sets using the same closed verifier as sync;
- enqueue newly discovered safe entries locally, with no network access;
- choose the oldest queued pending/retryable job and distinguish ready,
  retry-waiting, and paused states;
- reopen and verify that prepared contribution;
- return only schema/platform/policy classes, covered interval, counts by safe
  record class, client-declared pricing coverage summary, prepared byte count,
  conservative reserved upload bytes, attempt count, queue pause state, and next
  attempt time; and
- print an explicit statement that no network request occurred.

Unknown or changed entries fail closed. The projection never includes record
arrays or stable identifiers.

## Count and bandwidth cap contract

- `--max-uploads-per-pass` is bounded from 1 to 100.
- `--max-upload-bytes-per-pass` is bounded from 16 KiB to 256 MiB.
- Every candidate reserves `2 × prepared JSON bytes + 8 KiB` before its first
  network request. This intentionally overestimates the RSA/AES JSON envelope,
  including base64 expansion and fixed metadata.
- A pass stops before claiming a job whose reservation would exceed the
  remaining budget.
- The result reports processed jobs, conservative reserved bytes, and whether
  the bandwidth cap stopped the pass.
- Watch applies the same caps independently to each explicitly visible pass.
  Combined with the existing minimum watch interval, this yields a declared
  upper bound instead of a best-effort throttle.
- A single prepared contribution larger than the selected cap remains pending
  and visible as bandwidth-limited; it is never silently rejected or retried.

These are upload-attempt bounds, not a claim about total TCP/TLS/DNS/key-fetch
traffic. The UI and docs must use that precise language.

## Verification

- Inspect-next performs zero network operations and rejects non-allowlisted
  projected classification fields.
- Changed/symlinked/invalid prepared sets fail before a projection.
- Count and byte limits stop before the next `syncEntry` invocation.
- A too-large first job remains pending and unattempted.
- Watch preserves caps across repeated passes and remains foreground-only.
- CLI output contains no path, basename, digest, ID, origin, or credential.
- Existing pause, retry, revoke, and accepted-replay behavior remains green.

## Release boundary

This is foreground ongoing-collection control evidence. Scheduler installation,
signed auto-update, notifications beyond CLI/local status, a 30-day soak,
cross-platform resource budgets, and named-human G10 approval remain separate
gates.
