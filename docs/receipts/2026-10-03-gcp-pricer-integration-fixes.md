---
title: GCP pricer integration fixes
date: 2026-10-03
type: review
status: local-validation-complete-integration-pending
---

Scope: branch `codex/gcp-pricer-fixes-20261003`, based on `fadc7797`.
This records focused source validation, not deployment, combined performance,
or a valid newly registered compute closure. The maintained validation contract
is in `apps/worker/README.md`.

Registry lookup construction publishes only after successful construction and
can retry after a partial construction exception. Pricer instances expose
content-free fast-result, fallback-call and retained-plan counters, capped at
16,384 plans. Internal oracle plan compilation is excluded from fallback counts;
oracle exceptions are included. Registry construction exceptions precede both
result counters. Counters and their snapshots contain no event data.

The regular `analytics-v2:pricer:check` now gates the independent-oracle
exhaustive catalog/time/context set, the 6,561 component masks for both providers,
malformed shapes, and 10,000 seeded events. Node 26.2.0 validation:

- 11 focused tests pass, including injected partial registry failure/retry,
  counter isolation and snapshot independence, and injected small-cap saturation.
- 91,122 differential comparisons pass with zero mismatches, including 1,556
  matching exception outcomes. Differential wall time: 2.08 seconds; focused
  tests: 0.31 seconds (bundle and command startup add overhead).
- Differential counters: 34,978 fast results, 56,144 oracle fallback calls,
  1,675 retained plans, configured limit 16,384.
- Worker TypeScript check, root preflight (21 tests), architecture (963 files,
  zero debt edges), documentation governance and diff whitespace checks pass.

No vendor/accounting implementation or kernel registration was changed. Any
vendor/accounting change still requires the full 3M fuzz plus complete synthetic
corpus rerun. The integrator must drop branch-local kernel registrations and
pins, preserve existing integrated entries, and derive Wave 25's single combined
kernel 5 on the merged tree before running kernel/analytics/full parity gates.
The attribution tripwire shares the fast binding; independent differential
comparison is its mitigation. Existing source receipt performance claims have
not been remeasured here.

The earlier PRICER-PERF review recorded four pre-existing root failures:
reviewed-model-catalog (two) and retained R7 receipts (two). Those broad tests
were not rerun here, and no assertion, receipt, skip or exclusion was weakened.
