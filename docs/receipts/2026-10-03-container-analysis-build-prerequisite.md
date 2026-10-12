---
title: Container Analysis build prerequisite
date: 2026-10-03
type: review
status: source-tested
---

Based on frozen `445e393a4c2737016bee78bc9c6ca866f5a1033a`. Root reported that the production build compiled and pushed, then provenance verification failed because Container Analysis was not enabled. This follow-up does not change live services or IAM.

The shared OPS build prerequisite policy now names `containeranalysis.googleapis.com`. Typed build reads enabled services after checkout validation and before bucket proof, lock, archive, upload or submission. Missing, disabled, malformed or unreadable evidence fails closed. The maintained operator API command includes the explicit prerequisite; tooling never enables it implicitly.

Validation on Node 26.2.0 (`node --test apps/worker/scripts/gcp-production-rollout.check.mjs apps/worker/scripts/gcp-ops-infra-manifest.check.mjs`): rollout and OPS manifest owning tests 80/80, zero skips; preflight 21/21; syntax and whitespace checks pass. Negative tests prove refusal occurs with only checkout and service readback calls and no lock. Logs: `/private/tmp/container-analysis-owning.log` and `/private/tmp/container-analysis-preflight.log`.

The closure-only probe matches the existing kernel 7: 172 inputs, compute closure `98bd3be1fbcf141f38ccc7e9a5fdfaeefa7969df9b81779b646ae533cca5512c`, compute stamp `023332f1267c47a61abcef8dde786ff0140af225132aed1f3ba1f5ffd8f23090`. No runtime compute change or new registration is required. This is local source evidence, not live API, deployment or provenance qualification.
