---
title: Admin telemetry version coverage
date: 2026-09-25
type: plan
status: ready-for-review
---

# Admin telemetry version coverage

## Boundary

Qualify every admin page value and action that depends on accepted contribution
data across legacy whole uploads, v1.0, v1.1, and v1.2. Counts must state their
unit and time basis; retained receipts, selected analytical records, fit sources,
and published community days must remain distinct. Unavailable v1.2 schema or
source state must fail closed, never appear as zero. This source change does not
deploy, migrate, activate telemetry, or change production data.

## Work

1. Inventory the typed and legacy admin routes, metrics, gauges, allowance and
   graph views, object safety, controls, readiness, and audit. Record which
   sections are transport independent and which read versioned sources.
2. Make typed overview/history aggregate v1.0, v1.1, and v1.2 receipts with
   exact distinct identity counts, bounded resource use, and source authority.
   Preserve historical snapshot semantics; do not rewrite old observations.
3. Check v1.2 object registration/reconciliation and ensure the admin safety
   counts describe the same reference policy used by maintenance.
4. Qualify allowance and graph selection against effective v1/v1.1/v1.2
   analytical evidence, including staged and superseded negative cases. Update
   any labels that imply receipt totals are current daily activity.
5. Add synthetic mixed-version and refusal tests, run focused Worker and web
   checks, then inspect the rendered admin page with local data.

## Findings and disposition

- Typed overview, retained upload history, and hourly gauges now count accepted
  v1.0, v1.1, and v1.2 chunk headers. Identity counts use a distinct union;
  records are receipt sums, so overlapping observations can appear more than
  once. The selected-chunk gauge adds v1.2 chunks under active domain heads.
  Staged v1.2 uploads count as accepted but not selected.
- Admin upload-safety cards and quarantine reconciliation now recognize v1.2
  R2 references. The reconciliation path repeats its reference check just
  before object deletion. A partial v1.2 schema refuses the admin aggregate
  rather than returning an incomplete zero.
- The typed community graph and model paths already use the effective owner
  and history readers, which include v1.2 under domain and authorization
  evidence. Their fit owners, retained upload owners, and published daily
  contributors remain different units and windows. Existing effective-reader
  integration tests cover cross-format overlap once; the added admin test
  couples those same v1/v1.1/v1.2 receipts to owner-page totals.
- Controls, ingress, database health, readiness, failures, and audit operate on
  policy, processing, and storage state rather than a version-specific chunk
  table. The admin history payload advances to v0.3 so old v0.2 cached totals
  are rejected and refreshed at the next scheduled pass.

## Local validation

- Full Worker test phase: 153 files and 1,966 tests passed. The earlier run
  exposed two scheduled statement-budget regressions; the v1.2 schema check
  now shares existing source and reconciliation queries. The five affected
  suites then passed all 128 tests, including exact query-budget assertions.
- Web UI suite: 1,045 tests passed. Documentation preflight and architecture
  checks passed. The generated Worker admin asset matches its canonical web
  sources.
- The admin contributor cards rendered in a local browser at 1280px and 390px
  with the synthetic overview fixture. The v1/v1.1/v1.2 explanation opened;
  independent unavailable sources remained visibly unavailable.
- The public-release-site boundary suite passed all 68 tests, including
  exclusion of admin dashboard assets from the public site. The Worker
  `deploy:dry` step could not complete because this checkout lacks its generated
  public release manifest. The hosted social image observed on 2026-09-25 is 1024×1024,
  whereas this local release-site builder requires a reviewed 1200×630 card;
  no substitute release asset was created for this admin-only change.

## Remaining gate

Source and local test evidence do not establish that the changed Worker or
browser asset is deployed. No remote migration, deployment, publication, or
production write is part of this change.
