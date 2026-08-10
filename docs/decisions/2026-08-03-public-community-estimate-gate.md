---
title: Public Community Seven-Day Estimate Gate
date: 2026-08-03
type: decision-record
status: gated
---

# Public community seven-day estimate gate

## Decision

The public TiboTattle site must clearly describe the product, show the
privacy-safe community snapshot that is actually supported, and provide the
Mac-app download path. It must not serve the local personal dashboard or call
aggregate activity a community seven-day allowance estimate.

The current public aggregate contains clipped and rounded activity totals. It
does not contain the matched quota-to-usage calibration evidence required for a
numeric community estimate. Until that contract exists and meets the gates
below, the public site uses the name **community snapshot** or **community
activity**, never “best guess”, “allowance”, “capacity”, or an implied dollar
limit.

## Why the numeric claim is gated

The private/local analysis can retain the primitives needed to calibrate a
conditional API-price-equivalent rate: observed quota percentage, reset time,
window duration, source/surface, and server-priced usage. The currently
published community snapshot deliberately omits that fit and publishes only
activity metrics. Inferring an allowance from those totals would create a
plausible but unsupported claim.

Provider surface must also be an explicit cohort key. It exists in raw quota
evidence today but is not yet normalized into the public-estimation continuity
key, so a mixed/unknown surface must be refused rather than pooled.

## Minimum successor contract

A future successor after the current activity-only
`community-weekly-snapshot-v0.3` may publish a conditional estimate
only when all of the following are true:

1. collection is explicitly consented and externally enabled through a new,
   reviewed successor contribution contract; prompts, response text, file
   paths, account names, and credentials remain excluded;
2. inputs are complete matched quota and server-priced usage evidence from one
   provider, plan, limit, surface, and policy cohort, with a true 10,080-minute
   window and eligible reset fits;
3. each published cohort has at least 20 eligible provider-account-backed
   participants; this is a descriptive open cohort, not an independence claim;
4. per-participant inputs are clipped, outputs are coarsely rounded and
   delayed/sealed, and deletion triggers withdrawal/rebuild; and
5. output is a conditional API-price-equivalent median plus empirical
   sensitivity range and coverage/exclusion status, with explicit
   `not_testable` and suppressed states.

It must never be labeled as a provider-published subscription allowance or a
billing total.

## Public/local boundary

The public deployment must use the generated community/download release tree.
The loopback app continues to serve the full local dashboard from its separate
asset entrypoint. Public root, fallback, and static asset staging must exclude
the local dashboard, administrative files, local-only controls, and all
personal-data routes.

A download is not a generic file link. Until an approved signed macOS release
manifest proves the exact DMG's size, SHA-256, Developer ID, notarization,
stapling, Gatekeeper, and clean-profile assurances, the public build must
render a clear unavailable-download state. A no-installer community release is
valid; a file paired only with caller-supplied metadata is not.

## Acceptance criteria

- A first-time visitor immediately understands that TiboTattle is a Mac app,
  what the public snapshot does and does not show, and how to download it.
- No public URL resolves to the local dashboard or claims to read a visitor’s
  Mac.
- The generated public release tree is manifest-verified by every deployable
  Worker environment, not merely by the production staging command.
- Unavailable/suppressed community and installer states are fail-closed and
  clear; an enabled download has exact signed-release evidence.
- A numeric seven-day community estimate remains absent until the successor
  contract and all cohort gates above have been independently validated.
