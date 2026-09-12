---
title: Prospective reset-period classification
date: 2026-09-11
type: plan
status: implemented-and-source-validated
---

# Prospective reset-period classification

## Outcome and scope

Classify observed Codex allowance boundaries as scheduled resets, banked-reset
uses, or unknown, and annotate the existing local allowance-facing chart. Also
retain derived reset-credit grant and expiry markers when they can be proved.

The implementation remains read-only and uses only the documented local Codex
app-server `account/rateLimits/read` result. It does not call ChatGPT `wham`
routes, access browser credentials, consume a reset credit, or add a second
database.

The source contract is the upstream Codex
[app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt)
and [generated v2 response schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json),
not the private ChatGPT settings route.

## Data and privacy contract

- Treat `rateLimitResetCredits.availableCount` as authoritative. Detail rows
  may be absent or capped and are complete only when every row is valid, IDs
  are unique, and the row count equals the available count.
- Convert provider credit IDs to account-keyed HMAC fingerprints before they
  leave the sanitizer. Persist only a bounded current inventory checkpoint —
  count, fingerprints, grant/expiry timestamps, and the last three quota
  observations — in the existing owner-only collector state. Provider IDs
  must not enter collector state, diagnostics, exports, contributions, browser
  responses, or logs.
- Persist every closed derived event kind and bounded evidence label in the
  existing owner-only collector record store, and retain it in the all-history
  dashboard projection. An ordinary process restart restores the bounded
  checkpoint. Loss of account continuity, a failed read, malformed evidence,
  or a credit-observation gap longer than 36 hours clears banked-reset proof
  and cannot produce a retrospective banked-reset claim.
- Prospectively persist scheduled boundaries as they are observed. Reconstruct
  earlier scheduled boundaries from already-retained provider schedules;
  historical boundaries that cannot be classified remain explicitly unknown.

## Classification contract

For the same pseudonymous account, plan, quota family, and duration:

1. **Scheduled reset**: a previously reported `resetsAt` is bracketed by two
   observations and the next schedule advances. The event time is the prior
   provider-reported reset instant.
2. **Banked reset used**: outside an unambiguous scheduled boundary, the quota
   usage drops materially and the authoritative available credit count falls
   before the removed credit's expiry during the same continuous observation
   interval. The next schedule may advance or remain unchanged. The event time
   is the first post-boundary observation and remains interval evidence rather
   than an exact provider event time.
3. **Unknown reset**: the quota track proves an unscheduled boundary but credit
   continuity is absent, incomplete, or contradictory.
4. **Credit granted / expired**: a complete detail comparison proves a new
   credit or a disappearance at its recorded expiry. These are lifecycle
   markers and do not themselves start a quota period.

Scheduled evidence and banked-credit evidence that overlap or conflict do not
receive a causal label; they remain unknown with a bounded reason.

## Reuse and implementation

- Add deterministic classification primitives to
  `@app-usagemonitor/quota-analysis` and export them through the package root.
- Extend the existing Codex sanitizer with a symbol-keyed volatile inventory so
  ordinary serialization cannot retain it.
- Let the existing refresh runner and standalone collector commands own one
  classifier, restore and commit its bounded continuity snapshot with the
  existing collector checkpoint, and attach only derived events to the quota
  snapshot they already commit.
- Extend the existing collector projection with a `timeline.resetEvents` array;
  derive scheduled/unknown history from quota snapshots and merge prospective
  banked/lifecycle events without duplication.
- Add a generic annotation input to the existing SVG line-chart renderer and
  use it on the allowance-facing usage chart. Update the canonical i18n catalog
  and regenerate its browser mirror.

No unified-index schema or collector SQLite schema migration is required.

## Acceptance boundary

- Pure tests cover scheduled, banked, grant, expiry, unknown, account switch,
  malformed/capped details, failed continuity, duplicate observations, and
  conflicting evidence.
- Collector tests prove raw IDs/counts never serialize while derived events do,
  and projection tests prove historical schedule reconstruction and merging.
- Browser tests prove annotation labels, filtering, keyboard access, sparse
  behavior, and localization.
- Focused provider, collector, quota-analysis, companion, i18n, and web tests
  pass, followed by architecture and preflight checks.
- Rendered local dashboard inspection uses synthetic data. Source/browser proof
  does not qualify a packaged or installed native release.

## Implementation result

The local vertical slice is implemented on 2026-09-11. The 590-test affected
provider, classifier, collector, projection, export-boundary, local-review, and
browser suite passes, as do documentation, architecture, localization-mirror,
Codex contract, preflight, macOS source, and macOS signed-smoke gates. A
development app bundle was built and passed clean-install validation. The
synthetic dashboard was rendered and inspected with three distinct reset
annotations and no browser console errors. An isolated live local
`account/rateLimits/read` smoke recorded a direct quota snapshot and a valid
one-observation continuity checkpoint without touching the production store;
the account response contained no reset-credit inventory, so that part
correctly remained unavailable.

Restart continuity is implemented without a new database or schema migration:
provider credit IDs are replaced by keyed fingerprints and a bounded classifier
checkpoint is transactionally stored beside the existing collector cursor.

This is not an installed-app or release qualification. The unrestricted full
repository suite finishes with 4,089 passing tests, 21 platform skips, and 3
release-state failures: two retained R7 evidence checks require regenerated
immutable workload hashes after any source change, and the branch lacks
changelog/release-note entries for already-published stable tags v0.1.19
through v0.1.22. All executable R7 benchmarks and native process/sandbox tests
pass; this feature PR does not rewrite historical release receipts or add
unrelated release documentation.
