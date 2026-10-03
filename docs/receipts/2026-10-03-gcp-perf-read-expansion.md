---
title: GCP source expansion implementation and proof receipt
date: 2026-10-03
type: receipt
status: stage 1 implemented; performance unmeasured
---

Base48c26716a478bf92a830c27ea9c8ab7a90a0d929. Same-snapshot existence facts
skip only empty correction/v12 expansion families. Owned snapshots set jit off
and work_mem64MB; supplied-client generic scopes restore previous settings.
Synthetic PostgreSQL empty-family, positive-correction and success/failure
restoration tests pass. No index promotion, cloud, deployment or timing claim.
Grouped expansion and the staged owner probe follow as separate commits.
