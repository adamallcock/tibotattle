---
title: Public graph card and history polish
date: 2026-09-07
type: plan
status: qualified-awaiting-deployment
---

# Public graph card and history polish

Base: verified public graph source `a4f4da50`, receipt commit `3878cf08`.
Keep all API, pricing, publication, consent and installer contracts unchanged.

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

## Verification

Focused geometry/render/i18n/interaction tests, full web and release-site suites;
desktop and mobile rendered checks on the real public-data preview, plus sparse
synthetic states when needed. Guarded website deployment and live checks remain
separate from local validation. No desktop rebuild or migrations.

## Qualification and remaining gate

- 534 web tests, 36 release/preview tests and 20 preflight tests passed. The
  preview tests needed loopback permission; the initial sandbox refusal was
  environmental, not a passing test. Full Worker qualification is running for
  the normal guarded source-snapshot deployment.
- Chrome preview used real public data. Five themed cards fit across the
  expanded desktop view; plan All spans June 30 to September 6 instead of the
  unrelated activity year. Legend focus, keyboard model/plan inspection,
  synchronized ranges, mobile controls/cards and Spanish switching passed;
  no warning/error console entries were observed.
- Read-only production metadata confirms September 1 model reconstruction
  completed at 13:21:16 UTC; the 13:05:41 public snapshot still starts at
  September 2. Earlier reliable points await ordinary refresh/backfill, not a
  UI extrapolation. No scheduler state was changed.
- Keep the full guarded deployment route for this integrated branch: it also
  includes the retained earlier deployment receipt and focused graph tests,
  outside the narrower web-only receipt allowlist. Do not expand or bypass that
  allowlist, omit tests, or rebuild the existing desktop installers. The normal
  production gate must pass without exceptions before any live claim.
