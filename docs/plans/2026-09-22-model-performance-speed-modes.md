---
title: Separate Standard and Fast model performance
date: 2026-09-22
type: plan
status: in-progress
---

The model performance page must default to Standard and offer a simple Fast
switch. Each view must aggregate only its explicit mode, including turn counts,
output speed, latency, percentile bands, and date domains. Unknown mode stays
excluded and visibly counted; no missing mode is assumed Standard.

Acceptance and implementation:

- Reuse the v1.2 timing parser and store mode evidence; preserve its schema 4/5
  migration, METHOD=2 HMAC identities and unknown classification for old rows.
  Do not implement a second parser or migration.
- Partition worker/controller snapshots by period and mode. Version the closed
  display DTO, validate route parameters, and reject old mixed snapshots.
- Default each newly mounted page to Standard, retaining the chosen mode across
  model/period navigation and refresh within that mount. Keep caches isolated.
- Preserve sparse points and missing dates; require five measurements for bands.
  Provide explicit mode-specific empty and unknown-coverage messages in all locales.
- Validate parser, migration/restart, projection, route and browser interactions,
  then render populated/sparse/empty views at desktop and narrow widths.

The initial patch on the older worktree was preserved at `7879471c`; final work
is being ported onto `c93a5a51` plus the v1.2 integration candidate.

Source and browser validation do not qualify an installed native application or
release. The release owner is coordinating possible inclusion in 0.1.24.

Validation so far (before final v1.2 integration):

- Web suite: 1,011 tests passed; local suite: 378 passed; public-site gate: 68 passed.
- Focused mode UI: 51 passed; i18n/Electron copy: 6 passed.
- Architecture, documentation governance, preflight, and both i18n mirrors pass.
- In-app browser: default Standard, sparse Fast, explicit empty Fast, and Spanish
  at a 390 px viewport inspected. A read-only real-source sample rendered
  Standard measurements and an empty Fast population without borrowing data.
- Parser override classification defect reported to the v1.2 owner. Final
  integrated-worker and parser checks remain pending that owner's commit.

Historical limitation: the shared v1.2 migration does not force a full reparse of
unchanged sources. Previously saved rows without mode evidence remain excluded;
no current setting is used to infer their historical mode. Their source history
is preserved for a separately qualified future backfill.
