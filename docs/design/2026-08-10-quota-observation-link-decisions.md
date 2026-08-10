# Owner decisions: carrying the event→quota-observation link (telemetry v1.1)

Date: 2026-08-10. Status: decided, pending implementation.
Companion to the wire-contract brief circulated the same day. The owner has
answered the brief's blocking questions; this note records those answers so
implementation can proceed in one pass without re-litigating them.

## Direction

Carry the link. The locally resolved `usage_event.quota_observation_id`
association is the single highest-value fact the transport currently drops:
the server re-derives it by time-bucketing, which blends across pool
boundaries — exactly the blended-rate weakness the divergence panel already
has to disclose. The owner explicitly prefers uploading the locally resolved
link over server-side re-derivation ("minimal fixes we need in order to get
the system working"), and is not willing to accept the bucketing limitation
as permanent.

## Decisions on the brief's blocking questions

1. **Forced re-consent: accepted now.** The fleet is the owner plus first
   testers; the 0.1.1 update chain is live and the upload chain is healthy.
   Re-approval is a short in-app flow. Ship the consent-version bump with the
   contract change rather than staging it.
2. **Full-history re-upload: one go, no staging.** At revision + 1 the
   owner's ~86-day corpus re-uploads well inside the 20k-chunks/day launch
   budget (500 chunks per pass client-side). Verify the budget arithmetic in
   review, but do not build a staging mechanism for this.
3. **Pre-v1.1 records: keep the time-bucketed fallback.** v1.0 records
   without the link keep today's bucketed attribution so the system keeps
   working end to end during rollout; v1.1 records use the explicit link.
   The divergence/method caveat surface must say which basis produced any
   given figure. Revisit refusal-mode ("explicitly unattributed") only once
   the fleet is fully on v1.1 — honesty labels now, data blackouts never.
4. **Anchor: `quotaObservationId` string, nullable.** Adopt the existing
   deterministic client id (`q:${observed_at_ms}:${limitId}:${slot}`)
   provided the stability verification passes (see below). `null` means "no
   quota context was in force/known" and the server must treat it as
   *unknown*, never as attributable to any track.
5. **Rollout seam: per-record schemaVersion.** New `usage-event-v1.1` shape
   carrying the field; the worker accepts v1.0 and v1.1 concurrently; worker
   deploys first, client second. No optional keys inside the closed v1.0
   shape.
6. **Spark stays separate.** `codex-spark` limitId usage must never pool
   with the primary Codex track nor be compared in money terms
   (`codexModelApiPriceEquivalentApplicable()` is false for it). With the
   transport allowlist removed, `limitId` separation is load-bearing —
   preserve and test it explicitly in quota-analysis.

## Privacy review position

State honestly: both streams already ship, but the link raises the server's
resolution on which event consumed which quota slice — a small, real
increase in inferable activity shape. The owner accepts this for the
community-estimate accuracy it buys. Record that trade in the privacy
contract review; do not describe the delta as null.

## Verification gate before coding — PASSED (2026-08-10, read-only audit)

Verdict: **STABLE — adopt the anchor.** All three id components are pure
functions of per-record source bytes (observed_at_ms from the rollout line's
own ISO timestamp, extract.js:376/507/131; limitId from the record,
extract.js:119; slot a loop constant, extract.js:122). The upsert key
columns are structurally excluded from the conflict-update SET list and the
arrival-order hazard was already fixed with a total ordering. Empirically:
705,098 rows, zero key collisions; a second independently built index
(local-analysis-index-v2) agrees on 705,053 of 705,053 shared keys.

Caveats to honor in implementation:
- **Presence, not value**: fork-replay suppression can make a rebuild add or
  drop rows (never rename one). A dropped row is a visible absence — the
  server must tolerate anchors it stops seeing re-derived, never re-point.
- **Use the string, never the sqlite rowid** (insertion-ordered, not
  rebuild-stable).
- **Spark limitId reality check**: the live corpus contains limit_ids
  `codex` and `codex_bengalfox` — no `codex-spark` row exists on the
  reference machine. Confirm which token the Spark track actually emits
  before writing the separation test, or it passes vacuously
  (src/local-companion-usage-model.js:58 hedges with all three).
- Latent: a missing limit_id maps to "unknown" — zero such rows today; add a
  diagnostic counter, not a fix.

## Sequencing note

The implementation files overlap the in-flight model/provider allowlist
widening (telemetry-v1-chunks.js, telemetry-v1.ts and specs). Land that work
first, then implement this on top in one branch: projection + consent
version bump + worker dual-shape validator + migration + quota-analysis
link-first attribution + consent-UI field rendering + tests, per the brief's
file list.
