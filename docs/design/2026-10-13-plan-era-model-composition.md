---
title: Plan-era model composition on GCP
date: 2026-10-13
type: spec
status: source-candidate
---

## Scope and evidence

This contract extends GCP analytics-v2 model composition. The approved,
aggregate-only production diagnostic on 2026-10-13 showed that quota-bearing
contributors for GPT-6.1 Sol, GPT-6 Sol and GPT-6 Luna were rejected by
`multi_plan_window_unsupported` before fitting. That reason covers either
multiple plan types or explicit conflicts anywhere in the 101-day owner
window. It does not establish that every contributor actually changed plans.

This is a source candidate, not a deployment or a claim that any particular
model has sufficient evidence for a public estimate. Scalar allowance fits,
legacy Cloudflare analysis and existing successful single-era model results
retain their existing behavior.

## Partition and attribution

The existing complete quota acquisition and plan index remain authoritative.
The new adapter runs only after the legacy model result refuses multiple
plans, accounts or eras. A candidate is one provider, account scope and plan
era with supported quota rows. Multiple slots and reset pools within that
era do not become extra candidates. Repeated visits to the same plan remain
separate eras, including changes of variant or continuity identity.

Every selected day's raw usage rows pass through the existing usage resolver
in canonical order with one full-window session carry. Prepared two-hour
cells cannot recover transition-spanning quantity intervals and are therefore
not used on this path. Quota topology restarts from each candidate's own rows;
no pre-era reading can anchor its quota movement.

Resolved quantities enter their exact candidate only. Known incompatible
accounts are excluded; unknown scope may affect every same-provider account.
An account-change interval is conservatively possible for every same-provider
candidate. A known quantity remains uncertain for an unknown-scope quota
candidate, even when its own era has no supported quota seed.

## Ambiguity and observation exclusion

For an ambiguous quantity interval `(start, end]`, exclude every full two-hour
bin touched by `[start, end + maxCrossingElapsedMs]`, including equality at the
upper endpoint. This uses the existing composition policy's three-hour bound.
A retained quota crossing whose bracketing interval intersects the ambiguity
ends within that expanded range; a longer crossing is already voided by the
kernel. Removing all costs in the bin removes its whole observation from the
positive-cost corpus join. Removing only the ambiguous event would bias the
fit and is prohibited.

Also exclude every partial two-hour bin at either observed era boundary.
Unpriced usage retains the existing whole-bin poisoning behavior. Attribution
and boundary exclusions have their own counts and do not become pricing
coverage counts. Minimum observations, model cost-share floor, NNLS,
identification, split-half stability and freshness rules are unchanged.

## Result and public sampling

The internal result is `analytics-v2-plan-era-composition-v1` with status
`partitioned` and bounded candidates. Each candidate carries an opaque HMAC
identifier, its ordinary composition result, attribution-excluded bin count
and boundary-excluded bin count. The private window fingerprint keys the
identifier; account/era/session identifiers do not enter result JSON. All
private input fingerprints are removed before storage, including nested ones.

Normalize every candidate with its own plan multiplier and quota timestamp.
For each owner/model, choose the newest fresh, fitted, positive candidate
value; equal timestamps choose the lexicographically smaller candidate ID.
Never average different eras or fill an absent model from another model.
Public medians count each owner once per model. Owner coverage is mutually
exclusive: fitted if any candidate normalizes as fitted, otherwise unstable,
otherwise stale, otherwise refused. Duplicate owners or candidate IDs are
contract errors, never extra votes. The public wire schema stays unchanged.

## Bounds, identity and validation

The existing quota acquisition bounds, 256-track cap, million-row window
cap and 100,000-session cap remain. Partitioned state also has one global
120,000-cell/poisoned-bin cap, 240,000 merged hazard-interval cap and 8 MiB
reduction-state budget; they do not multiply by the number of candidates.
Result JSON has a separate 8 MiB bound. Overflow refuses the owner/date.

This pure GCP stage resumes no legacy checkpoint. Its new compute closure and
vendor manifest require an append-only kernel registration, which separates
cached results from earlier kernels. Only generator-added export tokens expose
the existing quota context and per-event resolver; their arithmetic is not
edited. Existing single-era corpus and public projection must remain byte
equivalent, and source-pin historical closure must exclude future evidence.

The additional facade exports also change the conservatively hashed pricing
class, although price cards and pricing arithmetic are unchanged. A rollout
must allow the existing refresh/repricing machinery to derive the new class;
old cached prices must not be relabelled or given an equivalence exemption.

Regression coverage must exercise plan/account/continuity partitions, delayed
quota crossings, unknown scope, conflicting anchors, global bounds, whole-window
raw fallback, privacy, fresh/stale selection and unique-owner public counts.
Production acceptance additionally requires the authorized kernel rollout,
completed analytics publication and aggregate plus rendered public readback.
