---
title: Public graph presentation and backfill verification
date: 2026-09-07
type: receipt
status: deployed-and-live-verified
---

# Public graph presentation and backfill verification

Published and independently verified source
`3f82d9aca1c5de73b63f929b61a3f0b5fa842cad` on 2026-09-07. Base: public graph
source `a4f4da50`, receipt commit `3878cf08`. All API, pricing, publication,
consent, scheduler and installer contracts are unchanged. This receipt replaces
the completed presentation plan, not the earlier release evidence.

## Requested changes and chart contract

- Order model cards, legend and same-day keyboard inspection Astra, Sol, Terra,
  Luna, GPT-5.5; retain other reviewed models after those without hiding them.
- Use compact cards with a shared API-equivalent USD / Pro 20x week caption,
  visible dates and account counts. Shorten explanations without dropping the
  normalization, small-sample or capacity-inference disclosures.
- The existing website-owned SVG chart remains the rendering surface. Use
  restrained celestial teal, solar ochre, earth olive, lunar slate and neutral
  accents within the cream/green design. Names and small line icons supplement
  colour; legend and chart colours must agree.
- All-history date axes fit actual estimates for the selected view, preserving
  elapsed dates and interior gaps. Keep shared zero-based dollar scales. Thin
  dense markers without discarding underlying points or keyboard/touch access.
  Clickable legends focus one series without rescaling or altering the data.
- Investigate September 2 model-history cutoff with bounded read-only source
  and live metadata checks. Distinguish pending work from identification limits;
  do not initiate reconstruction, modify leases or promise unavailable history.

## Qualification

- 534 web tests, 36 release/preview tests and 20 preflight tests passed. The
  preview tests needed loopback permission; the initial sandbox refusal was
  environmental, not a passing test. All 802 Worker runtime tests and 202
  deployment/operations script tests passed, alongside workspace, endpoint,
  generated-type and TypeScript checks. Default/staging/production dry bundles
  passed. The first default dry bundle correctly rejected the old generated
  manifest while the replacement site build was still running; after that build
  completed, provenance validation and all remaining dry gates passed unchanged.
- Chrome preview used real public data. Five themed cards fit across the
  expanded desktop view; plan All spans June 30 to September 6 instead of the
  unrelated activity year. Legend focus, keyboard model/plan inspection,
  synchronized ranges, mobile controls/cards and Spanish switching passed;
  no warning/error console entries were observed. The chart-design skill guided
  fixed dollar baselines and gap preservation; the browser-testing skill guided
  real-data inspection, focus checks and responsive verification.
- Used the full guarded deployment route for this integrated branch: it also
  includes the retained earlier deployment receipt and focused graph tests,
  outside the narrower web-only receipt allowlist. Do not expand or bypass that
  allowlist, omit tests, or rebuild the existing desktop installers.

## Live publication

- The guarded wrapper returned `PRODUCTION_DEPLOYED`, no unapplied migrations,
  healthy pre/post checks and a public-only surface. Independent health matched
  the exact source above; no exception flag or guard alteration was used.
- Six public assets matched the newly qualified local bytes. Source-closure
  SHA-256: `d92884b50431fdbb270e947871b18a4b78e6b37051da36ab687272d459474cd3`.
  Five private/admin routes returned 404 on the public host. The existing ARM
  and Intel 0.1.18 installers were reverified for bytes/native trust by the
  builder, and both versions and architecture-specific URLs remain published.
- Chrome rendered the requested order, matching accents/icons and 115px-high
  desktop model cards. All spans June 30–September 6 for plans and September
  2–6 for models in the inspected snapshot. Legend focus and exact-value
  keyboard inspection passed live. At 390px, page width was 390px and dialog
  width 374px, without horizontal overflow; cards and controls remained
  accessible. No console warnings/errors were observed. Temporary emulation
  was restored and the normal desktop model graph was left open.
- Public Open Graph/Twitter references, crawler allowance and the retained
  1200×630 PNG MIME/dimensions passed. The dated social image was not regenerated.
  No new desktop qualification or complete historical repricing is claimed.

## Backfill answer at inspection

Read-only production metadata (113 compact rows, zero writes) showed September
1 completed at **13:21:16 UTC**, with four identified model estimates and all
15 required account results resolved. The public snapshot was generated earlier,
at **13:05:41 UTC**, and still had September 2–6 for GPT-5.5/the GPT-5.6 models,
and September 5–6 for Astra. September 2 is a cache cutoff, not a fixed history
limit. August 31 is the next missing date.

Reconstruction works newest-first, one date and at most two accounts per
invocation, publishing only when the cohort is resolved. Current calculations
and publication take priority within the shared maintenance budget. Preview
refreshes have a 55-minute minimum interval; public responses can cache for
another five minutes. These are not a guaranteed completion ETA.

The rolling target is 70 calendar days including today: **June 30–September 6**
is the closed historical range on September 7. Each estimate uses its own
date-bounded 100-day evidence lookback. Reliable earlier points can fill in;
missing or unstable models remain gaps. This does not promise all-year history.
Sources: `apps/worker/src/community-model-history.ts`,
`apps/worker/src/model-history-window.ts`, and the maintained scheduler in
`apps/worker/src/index.ts`. No reconstruction or scheduler write was initiated.

Ignored local qualification, build, deployment and live-check logs use the
`.release-build/public-graph-polish-` prefix. The production release remains
immutable at 0.1.18; this was a hosted presentation follow-up only.
