---
title: Consumer Usage Monitor MVP Execution Plan
date: 2026-07-26
type: plan
status: in-progress
---

# Outcome

Deliver and verify a useful privacy-first consumer experience that reads Codex
logs locally, shows understandable personal quota and cost-equivalent analysis,
optionally contributes a closed-schema metadata export to the local central
service, and supports private results, privacy-safe community comparison,
export, and deletion.

The central website never reads the user's log directory. Raw logs stay on the
device. Claude is outside this milestone.

# Priority split

- 60% consumer UI and the real local journey.
- 25% Worker, D1, R2, and end-to-end integration.
- 15% calibration accuracy and targeted ordinary-user reliability.

# Consumer acceptance journey

The verified journey must let a user:

1. Start the local companion.
2. See available local sources, coverage dates, indexing progress, and whether
   the view is real or demonstration data.
3. Obtain useful recent results without waiting for a full-history scan.
4. Inspect the exact closed metadata schema and the fields in the next
   contribution.
5. Generate and machine-verify a privacy-safe contribution.
6. View current five-hour and seven-day allowance observations.
7. Explore hourly, daily, and weekly API-price-equivalent usage and quota
   movement with explicit UTC and local-time labels.
8. Understand the fitted cost-to-quota gradient, uncertainty, residuals,
   exclusions, resets, gaps, and low-confidence intervals in plain language.
9. Review week-by-week seven-day allowance estimates and their plausible range.
10. Inspect model, effort, speed, service tier, token-component, tool-class,
    subagent, lineage, and surface accounting where observed.
11. Review known monitoring gaps and unsupported shared-pool surfaces.
12. Optionally upload a reviewed contribution and see accepted, rejected, and
    deduplicated outcomes.
13. View private server-repriced statistics and an eligible privacy-safe
    community comparison.
14. Export server-held participant data.
15. Delete one contribution or the complete participant, then confirm private,
    aggregate, D1, and R2 state changed correctly.

# Implementation lanes

## A. Real local data and responsive indexing

- Audit the existing local companion contracts and remove any fixed-report-only
  dependency from the primary dashboard.
- Use a bounded recent Codex interval for the first useful view.
- Show source availability, current covered interval, records processed,
  progress, and the next older interval to index.
- Reuse the existing restart-safe workspace/checkpoint machinery.
- Cache only content-free derived records and do not reread unchanged prefixes.
- Keep the full 24 GB historical qualification out of the interactive path.

## B. Useful dashboard

- Provide primary navigation for overview, timeline, weekly allowance, cost
  accounting, community comparison, contribution history, monitoring gaps,
  data/privacy, export/deletion, and backend status.
- Add 15-minute, one-hour, and three-hour smoothing controls.
- Add hourly, daily, and weekly grouping, zoom/range controls, and both UTC and
  local-time labels.
- Make resets, missing samples, excluded intervals, and uncertainty visible.
- Expand weekly evidence to include observed cost, quota decrease, implied full
  allowance, central/lower/upper estimates, usable observations, quality, and
  caveats.
- Add an accounting breakdown for token components, models, effort, speed,
  API tier, tools, subagents, lineage, and surface.
- Replace unexplained statistical labels with plain-language explanations.

## C. Privacy-safe contribution

- Expose a human-readable pre-upload inspection with exact retained fields and
  explicit never-collected categories.
- Reverify the local bundle, privacy receipt, prepared-set manifest, member
  digest, size, schema, and record counts immediately before upload.
- Keep upload optional and one-use-authorized.
- Never place recovery, device, participant, account, or session capabilities
  into logs, reports, URLs, or the browser's persistent storage.

## D. Backend end-to-end proof

- Run the twenty-participant synthetic Worker/D1/R2 laboratory through
  enrollment, encryption, rejection, deduplication, repricing, ingestion,
  private stats, aggregate publication, restart, export, contribution deletion,
  participant deletion, aggregate rebuild/withdrawal, and final storage checks.
- Prepare one bounded contribution from real local Codex-derived metadata,
  inspect it, and run it through the same local backend contract.
- Retain no raw logs or unreviewed material in backend test state.

## E. Rendered QA and handoff

- Inspect every primary page in a real loopback browser at desktop and narrow
  widths.
- Verify real/demo, personal/community/inferred, unavailable, stale, and error
  states.
- Leave a one-command local start path and a one-command disposable backend lab.
- Record exact tests, rendered evidence, known gaps, and honest deployment
  status.

# Non-blocking hardening backlog

The following do not block this local MVP unless they expose a privacy,
data-integrity, or ordinary-user reliability defect:

- R7 dual-runtime receipt regeneration and runtime qualification.
- Repeated full 24 GB corpus-scale scans.
- Formal signing and release-evidence matrices.
- Literal 1,000-participant / 20-million-record load validation.
- Public staging or production deployment.

On July 26, 2026, both Node 24 and Node 26 real-history attempts exceeded the
fixed ten-minute filesystem-sampling deadline on at least one pass. No new
real-history receipt was published. A semantics-preserving native newline-search
optimization was added to the bounded JSONL reader and its focused parser and
checkpoint tests passed 21/21. Further corpus-scale qualification remains in
this backlog.

# Release boundary

This milestone may claim a disposable, locally verified consumer MVP with a
production-shaped local Worker/D1/R2 backend. It may not claim production
readiness, external participant authorization, remote R2 availability, or an
official dollar-denominated subscription allowance.

# Current verified state

As of July 26, 2026, the real local-data dashboard, the inspectable
twenty-participant backend laboratory, and an isolated real sanitized
contribution have passed their primary local journeys.

- The dashboard loads real content-free local evidence, reports stale/live
  state explicitly, exposes 15-minute, one-hour, and three-hour comparisons,
  and provides weekly, accounting, monitoring-gap, privacy, community, history,
  and backend views.
- The loopback companion can display real local evidence and relay only the
  fixed public central-service reads. Authenticated contribution and
  participant operations remain owned by the same-origin central portal.
- The inspectable backend laboratory shows a twenty-participant delayed
  community snapshot and a recovered participant's private server-repriced
  statistics and canonical contribution history.
- One hour of real local Codex metadata was privacy-verified, split into four
  bounded transport batches, and passed through a fresh invite-only
  Worker/D1/R2 lifecycle. The final run used one 200-record batch for each of
  twenty isolated participants, verified idempotent replay, canary rejection,
  personal statistics, exact private-versus-public community calculations,
  export, contribution deletion, aggregate withdrawal and rebuild, complete
  participant deletion, and zero live R2 objects.
- The first real-file run exposed a hard-coded generated-fixture assumption in
  the HTTP smoke. The harness now derives all eight metrics for every
  provider/model cell and exact-checks both the private comparison and public
  aggregate.

The detailed backend and real-data evidence is recorded in
[2026-07-26-consumer-backend-real-data-verification-receipt.md](./2026-07-26-consumer-backend-real-data-verification-receipt.md).
Full-history R7 qualification, narrow-width rendered QA, packaging, remote
staging, and external participant authorization remain open.
