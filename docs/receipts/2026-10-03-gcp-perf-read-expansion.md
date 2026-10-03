---
title: GCP source expansion implementation and proof receipt
date: 2026-10-03
type: receipt
status: stages 1 and 2 implemented; performance unmeasured
---

Base48c26716a478bf92a830c27ea9c8ab7a90a0d929. Same-snapshot existence facts
skip only empty correction/v12 expansion families. Owned snapshots set jit off
and work_mem64MB; supplied-client generic scopes restore previous settings.
Synthetic PostgreSQL empty-family, positive-correction and success/failure
restoration tests pass. No index promotion, cloud, deployment or timing claim.
Grouped expansion and the staged owner probe follow as separate commits.

Grouped2,000-ID expansion preserves logical200-ID membership and caps40,001
per family/batch, with G40,001 and G+1 incomplete-tail reissue. Ordinal columns
are stripped before pure decode/verify/reconcile and fingerprint assembly.
The exact READ-PLAN58a271c1 pair helper composes with grouped physical v11
completeness counts. Missing correction archive dictionaries cannot hide later
batches; grouped statement aborts rollback a read-only savepoint and replay
original logical batches. Explicit57014 user cancellation is terminal.
Two control statements/group are a pending performance measurement cost.
Positive facts span420 occurrences, three facts each and three logical batches.
A family-first mutant loses the earlier LIMIT and is caught.
Final source passes96 realPG tests,254 analytics tests and owning typecheck.
Indexed owner probe follows separately; timings/peakRSS/corpus gates remain open.
