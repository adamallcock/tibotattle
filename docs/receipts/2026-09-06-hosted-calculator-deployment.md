---
title: Hosted calculator deployment and initial progress
date: 2026-09-06
type: receipt
status: deployed-reconstruction-in-progress
---

# Boundary

This records the owner-approved hosted-only recovery at source
`91171029fb5a16255502b380677fac27df18a70a` on 2026-09-06. It does not certify
completed allowance reconstruction, a new desktop build or a new public release.

# Verified deployment

- The full Worker gate passed: 198 script tests, 746 Worker tests, package and
  generated-type guards, TypeScript and default/staging dry bundles. A separate
  production dry bundle, documentation and preflight checks passed.
- The broad root suite previously reported 3,873 passed, two stale R7 evidence
  failures and 21 platform-gated skips. R7 is not part of the maintained Worker
  deployment gate. Its tests and receipts remain unchanged and open for future
  desktop qualification; no private local-history run was performed.
- Both independent production migration ledgers matched their source prefix.
  Recovery bookmarks and storage headroom were verified before mutation; no
  restore was performed or authorized.
- Migrations `0046_v1_quota_fit_projection.sql` and
  `0047_community_analysis_work.sql` applied successfully. Read-back verified
  their ledger entries, lookup state and ten intended schema objects. The
  migration statements completed in 2.34 ms and 1.99 ms respectively; those
  timings do not describe subsequent backfill or full calculation duration.
- The normal production wrapper returned `PRODUCTION_DEPLOYED`, with no pending
  migrations, healthy immediate/post health and a public-only asset surface.
  No emergency exception, alternate deployment route or test bypass was used.
- Health returned HTTP 200 and the exact source above at 19:00:36 UTC. Natural
  schedule observations identify Worker version
  `31a803b4-cfde-49f9-ab9e-e2d43f5c4965`.

# Observed behavior

The initially empty lookup reached its fixed record high-water and marked the
backfill complete. Restartable calculation heads then advanced through their
acquisition phases. Observed scheduled runs had no exceptions and preserved
lifecycle, retention, deletion-safe restore, reconciliation and publication.
They honestly reported the overall rebuild incomplete.

Live Chrome rendering confirmed the all-token activity chart across 316
published days, the replacement API-equivalent-spend card, and a working
authenticated Operations view. The main allowance graph, admin allowance
preview and spend value remained unavailable pending reconstruction. Existing
published days are not relabeled as newly calculated results.

Canonical and social metadata were checked on the live page. The existing
social image remained crawler-accessible as `image/png`, 1200 by 630 pixels;
this is accessibility evidence, not a newly generated live-estimate image.

# Preserved boundaries and remaining checks

Telemetry, consent, retention and collection controls were not changed. v1.1
activation remains unused. Published desktop 0.1.18, its tag and generated
release evidence remain unchanged. No installers, cask or signed update feed
were republished.

Local memory measurements are bounded observations, not proof of the production
total-isolate limit under every concurrent workload. Continue to distinguish
fresh cache completion, current public/admin data and rendered allowance graphs
from merely healthy requests or advancing checkpoints. The maintained
[current status](../current-status.md) owns later observations.
