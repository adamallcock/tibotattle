---
title: Windows model-performance storage and ingestion
date: 2026-09-13
type: plan
status: implemented-awaiting-native-qualification
---

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
