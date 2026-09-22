---
title: Windows project grouping and task names
date: 2026-09-22
type: plan
status: awaiting-native-qualification
---

Fix issue [#208](https://github.com/adamallcock/tibotattle/issues/208) against the
0.1.24 release candidate. The acceptance boundary is real saved task names and
Git project grouping through the local reporting API and packaged Windows UI,
including refresh and restart. Model-performance qualification alone is not
proof of these paths.

## Implementation and validation

- Replace POSIX-only metadata admission on Windows with the reviewed native
  source-handle boundary; retain bounded local-only names, read-only SQLite,
  owner/link/reparse refusal and handle lifetime protection.
- Diagnose and repair project attribution, including exact source identity and
  platform-specific path/Git handling. Preserve accounting totals and replay.
- Add focused regression tests and native Windows qualification coverage.
- Extend the packaged synthetic Windows journey to assert names and grouping
  before and after restart, with content-free receipts.
- Run focused tests, affected companion/UI gates, architecture, documentation
  and preflight. Native Windows and signed release evidence remain separate.

No publication, signing, installation, hosted migration, or remote issue/comment
mutation is part of this local implementation. Record exact validation and any
remaining native qualification gate here before handoff.

## Implemented result

- Windows names, ancestry and repository hints use native held source leases.
  POSIX checks remain unchanged. Live WAL main/sidecars stay leased through
  SQLite close; all-sidecars-absent databases use immutable reads and state
  revalidation. Failed closes retain bounded strong references until retry.
- Missing Git can use a saved unambiguous origin. Current Git rejection remains
  non-project; CRLF output and Windows repository basenames are handled.
- Native qualification includes four metadata cases. The packaged normal journey
  now checks real Git grouping, saved task name and the rendered task link on both
  launches. The signed-installed validator requires that content-free receipt.
- Database/WAL content and journal mode are preserved. Normal read-only WAL
  connections may update existing SHM coordination bytes; no source permissions
  are changed and absent sidecars are not created.

## Validation on macOS, Node 26.2.0

- Metadata/privacy/discovery: 90 passed, including 12 Windows orchestration cases.
- Project/source accounting: 51 passed, including actual Git repositories.
- Local companion: 398 passed. Affected UI/privacy: 106 passed.
- Normal/signed Windows packaging contracts: 64 passed, including real local
  ingestion, API lookup and restart. These are not native Windows receipts.
- Export/release/qualification contracts: 27 passed; four native Windows tests
  correctly require Windows x64 and were not executed on this host.
- Architecture, documentation and preflight passed.
- The broad root suite is being checked separately; two initial missing Worker
  dependency failures passed all seven owning tests after the locked dependency
  install. Its native macOS watchdog smoke failed, matching an unresolved gate
  already disclosed in release PR #204; final root results remain to be recorded.

## Remaining release gate

Run the manual native Windows security workflow and unsigned Windows runtime
packaging workflow on the exact fix commit. Their dispatch and a remote branch
push require explicit owner authorization under repository guidance. No native
Windows result, signed installer, updater delivery or public release is claimed.
