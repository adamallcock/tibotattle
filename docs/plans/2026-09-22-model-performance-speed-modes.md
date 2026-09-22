---
title: Separate Standard and Fast model performance
date: 2026-09-22
type: plan
status: implemented
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
was ported onto `1d61581b` as `a950be37`, then integrated with the corrected
v1.2 parser at `fc6a414c`. The release owner included both in the 0.1.24 candidate.

Source and browser validation do not qualify an installed native application or
release. The release owner is coordinating possible inclusion in 0.1.24.

Validation:

- Before integration: web suite 1,011 passed; local suite 378 passed; public-site
  gate 68 passed. After integration: web suite 1,016 passed; focused timing,
  parser, store, route and telemetry-worker checks 72 passed.
- Focused mode UI: 51 passed; i18n/Electron copy: 6 passed.
- Architecture, documentation governance, preflight, and both i18n mirrors pass.
- In-app browser: default Standard, sparse Fast, explicit empty Fast, and Spanish
  at a 390 px viewport inspected. A read-only real-source sample rendered
  Standard measurements and an empty Fast population without borrowing data.
- The shared parser correction was committed in `fc6a414c`; explicit task-boundary
  overrides and contradictory/malformed evidence have regression coverage. The
  real-source browser sample was regenerated using that exact committed parser.
- The prior full root run was interrupted before changing the integration base;
  it is not a passing receipt. A fresh complete root run is in progress.
- Installed/native, signed-release and updater gates belong to the release
  owner's final candidate; this record does not claim those gates passed.

Historical limitation: the shared v1.2 migration does not force a full reparse of
unchanged sources. Previously saved rows without mode evidence remain excluded;
no current setting is used to infer their historical mode. Their source history
is preserved for a separately qualified future backfill.
