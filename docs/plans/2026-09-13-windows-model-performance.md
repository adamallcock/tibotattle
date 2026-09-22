---
title: Windows model-performance storage and ingestion
date: 2026-09-13
type: plan
status: source-qualified
---

The shared filesystem and SQLite implementation is present on main. Source
`f2e12fd0ffd717a2e4e22ac5e2774bb0a232b3df` enables the narrow Windows
source-read capability and passed its clean/warm native and unsigned packaged
Electron qualification before
[PR #199](https://github.com/adamallcock/tibotattle/pull/199) merged on
2026-09-22. The released 0.1.22 Windows model-performance page remains
unavailable. Accounting and timing schemas are unchanged by this capability
switch.

## Implemented boundaries

- `source-file-access.js` provides the common positional file-handle interface.
  POSIX uses Node FileHandles; Windows uses the existing native handle-relative
  path walker and a generic `windows-source-read-v1` extension. The timing store
  consumes that interface through the existing rollout reader and parser.
  The generic handles also work with the existing bounded JSONL and compressed
  readers. This does not switch the accounting scanner to an unqualified adapter.
- Native source opens authenticate the current owner of a regular, single-link
  file, reject reparse paths, and hold the file and its ancestors without delete
  sharing until close. Normal inherited source ACLs are accepted without changes.
  `closeSourceFile` rejects database guards and foreign or closed leases.
- The shared reader retains its 256 KiB buffer; the Windows adapter splits each
  request into native reads of at most 64 KiB. There is no 64 KiB file-size limit.
  Batch checkpoints, cancellation, replay protection and worker budgets remain.
- `windows-protected-sqlite.js` shares database/journal creation, guard validation,
  partial cleanup, release and recovery setup between timing and credential audit.
  Callers retain their database names, schema rules and branded error contracts.
  Both files remain guarded through SQLite close. WAL/SHM residue and incompatible
  timing headers remain refused without deletion or repair.
- SQLite startup enters exclusive locking before setting persistent journaling
  and forcing recovery, then returns to normal locking and releases the temporary
  exclusive lock with a read. This happens before schema queries. Temporary
  storage remains in memory. Both consumers use the same sequence.
- The existing manifest accepts an optional, closed `sourceRead` capability,
  tied to the exact native contract and all four methods. Older manifests remain
  compatible for their existing consumers. The source-read loader requires narrow
  approval and existing audit-guard approval, without enabling unrelated native
  write/path-walk policy. `WINDOWS_SOURCE_READ_APPROVED` is true in the source
  candidate; an edited or mismatched sidecar is rejected. Qualification builds
  the binary-bound manifest from this exact reviewed source.
- Electron runtime, qualification authority and artifact verification include the
  shared SQLite helper. Worker capability failure occurs before source discovery
  and remains bounded, retryable and explicitly unavailable.

## Recovery and completeness evidence

The earlier candidate (`c94e0c1f`, reviewed in `96ce84c2`) queried schema before
journal setup and duplicated guard lifecycle. A local child-process crash left
a hot journal that SQLite deleted on its first schema query. Setting PERSIST
alone also deleted it during recovery, conflicting with Windows delete denial.
The corrected shared sequence preserves the journal inode through every startup
statement and database close in a real SQLite test, rolls back uncommitted data,
and lets a second connection read and write afterward. The later native Windows
qualification exercised the protected filesystem and timing paths. See SQLite's
[locking mode documentation](https://www.sqlite.org/pragma.html#pragma_locking_mode)
and [hot-journal recovery](https://www.sqlite.org/lockingv3.html#dealing_with_hot_journals).

A synthetic file containing an 8 MiB record reaches exact EOF across multiple
4 MiB ingestion batches and retains measurements before and after that record.
Every native read stays at or below 64 KiB. The existing 64 KiB record-prefix
limit is different: oversized individual records remain explicitly partial.
Existing discovery and projection capacity ceilings remain separate concerns;
this change does not remove resource limits or reinterpret them as retention.

## Validation and release boundary

The earlier source-preparation run on macOS with Node 26.2.0 passed the focused
shared SQLite, audit, loader, manifest,
source/rollout/compressed-reader and timing suite passed 92 tests. Synthetic
bindings test orchestration and real SQLite behavior, not Windows ACLs.
The full local companion suite passed 356 tests. Electron staging/package tests
passed 36 tests; artifact, loader and qualification checks passed 42 with 13
platform-specific skips. Four API/facade contract tests passed. Architecture,
documentation and preflight checks passed. These are local source and portable
packaging checks, not an installed Windows artifact or native build receipt.

The exact source head passed both clean and warm native Windows x64 security
qualification in [run 35694491358](https://github.com/adamallcock/tibotattle/actions/runs/35694491358).
That gate built the binary-bound sidecar and exercised the reviewed native test
set, including the real model-performance worker and protected filesystem paths.
The unsigned packaged Electron normal journey passed in
[run 35694491314](https://github.com/adamallcock/tibotattle/actions/runs/35694491314).
Its bounded receipt records packaged Electron execution, a rendered dashboard,
synthetic fixture ingestion and retained totals across restart. Repository
release-policy, documentation and committed-lock dependency checks also passed
on the PR head.

These results close the source merge gates. They do not qualify a final signed
installer, an installed upgrade, updater delivery or public publication. The
visible claim in the released app changes only after a successor artifact passes
those release gates and is published; no signing, install or release was part of
this source qualification.
