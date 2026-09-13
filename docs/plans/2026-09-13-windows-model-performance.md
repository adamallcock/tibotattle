---
title: Windows model-performance storage and ingestion
date: 2026-09-13
type: plan
status: needs-revision
---

The c94e0c1f candidate needs architectural and recovery corrections before
native qualification. It is not an approved Windows implementation.

Implement Windows timing behind the existing native filesystem qualification
boundary. This branch starts at 9385bad2 and preserves the main checkout's
uncommitted changes. No accounting schema or timing schema migration is needed.

- Extract platform file operations from the timing store. Preserve the POSIX
  owner checks, incremental checkpoints, parser, bounded reads and projections.
- On Windows, use the verified native adapter to create owner-private state,
  guard the database and persistent journal throughout SQLite's lifetime, and
  open source logs through validated handles. Source logs may inherit normal
  user ACLs; never rewrite their permissions. Reject other-owner files, links,
  reparse paths and replacement races.
- Bound source reads to 64 KiB per call. Keep filesystem work in the existing
  worker and retain its memory, batch, retry and shutdown limits.
- Replace the unconditional Windows controller refusal with capability-based
  failure. Missing, mismatched or unqualified binaries stay unavailable; do not
  change approved native policy or claim Windows release support.
- Validate portable integration, cleanup, compatibility and refusal behavior;
  add native Windows tests for the exact new handle operations. Native build,
  security qualification and packaged Windows smoke remain required before
  enabling the capability or changing the visible support claim.


## Local result

Implemented on `codex/windows-model-performance`. The platform adapter uses the
existing native SQLite guards and a new bounded source-handle contract. The
worker now checks capability during store creation before source discovery.
The published Windows availability copy remains accurate and unchanged.

Validation on macOS with Node 26.2.0: 74 focused timing, reader, loader and
manifest tests passed; 11 Windows-only cases were not run. The full local
companion suite passed 356 tests. Architecture, documentation and preflight
checks passed. Portable Windows orchestration tests use synthetic bindings and
real SQLite; they do not validate Windows ACLs or kernel handles.

Remaining release gates: rebuild native Windows x64 binary and manifest; run
`test/windows-filesystem-security.test.js` including the new held-source,
junction/hard-link, guarded-journal and hot-journal crash recovery cases;
complete native policy review; then run the actual packaged timing worker
against synthetic logs and verify TPS/TTFT, restart and graceful refusal.
Existing manifest validation intentionally rejects production/path-walk approval;
a reviewed loader/generator policy update is required after qualification.
No native approval boolean, signed artifact or release was changed here.


## Correctness and reuse review, 2026-09-13

The initial implementation claim was too strong. Keep the candidate disabled.

1. **Crash recovery is a blocker.** The timing store queries schema metadata
   before setting PERSIST. A local Node 26.2.0 / SQLite reproduction created an
   uncommitted transaction in a child process and exited without closing it.
   Its 9,728-byte hot journal was deleted on the first `PRAGMA user_version`.
   Running `PRAGMA journal_mode=PERSIST` first also deleted that journal during
   recovery. The Windows guard denies deletion for the journal's lifetime, so
   this lifecycle conflicts with crash recovery. The deletion is reproduced on
   macOS; the resulting Windows error still needs native verification. Merely
   reordering pragmas is not a proven fix. SQLite documents the
   [hot-journal recovery lifecycle](https://www.sqlite.org/lockingv3.html#dealing_with_hot_journals).
2. **Share the database-guard lifecycle.** Directory/file creation, acquisition,
   partial cleanup and release duplicate `windows-credential-audit-file-guard.js`.
   Extract an internal shared primitive with narrow, fixed-purpose wrappers.
   Resolve recovery once in that shared layer and test both consumers; do not
   blindly copy the existing credential implementation or weaken its contract.
3. **Make source handles generic.** Existing native whole-file reads enforce
   protected-state ACLs and a 1 MiB allocation bound, so they are unsuitable for
   ordinary large Codex logs. A native streaming primitive is justified, but it
   should implement a common source-handle port rather than expose timing-named
   methods. Integrate through platform source ports and the shared line reader;
   avoid importing the legacy root source-snapshot owner into platform code.
4. **The capability gate is currently unsatisfiable.** The manifest validator
   accepts overall production/path-walk approval only as false, while the timing
   loader requires true. Thus this is an implementation candidate, not a feature
   that only needs a passing test run. Define and qualify the narrow capability
   without accidentally enabling unrelated Windows filesystem consumers.

Bounded streaming itself is correct: a new synthetic regression ingests a file
containing an 8 MiB record across multiple 4 MiB batches, reaches its exact EOF,
and retains both measured turns before and after that record. Every native read
stays at or below 64 KiB. All six Windows-orchestration tests pass on macOS using
an injected filesystem binding. This proves iteration, not Windows kernel safety.
The 64 KiB read buffer is separate from the existing 64 KiB record-prefix limit;
large individual records are flagged partial. Existing ceilings of 50,000
entries per discovery and 100,000 projected turns are actual capacity limits,
not read-buffer limits, and remain a separate capacity-review concern.
