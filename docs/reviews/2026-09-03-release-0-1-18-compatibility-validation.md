---
title: Release 0.1.18 Codex and Astra compatibility validation
date: 2026-09-03
type: review
status: release-gated
---

# Release 0.1.18 Codex and Astra compatibility validation

## Verdict and scope

The accepted compatibility scope is implemented on `codex/release-0.1.18`,
based exactly on `origin/main` at
`9e1c33338297c4ffdd224a22b2a2cfbf589ce62a`. Its baseline tree matches released
`v0.1.17`. Changes remain uncommitted; the package version remains `0.1.17`.
Local `main` and the website deployment branch were not changed.

**Source validation is substantially passing, but release qualification is not
complete.** The full root run retains two R7 receipt-freshness failures. Worker
tests pass, but its production dry build stops at the clean, committed-tree gate.
Neither gate was bypassed. This receipt records the September 3 local-time
implementation run (September 4 UTC), on macOS with Node.js 26.2.0.

The [research assessment](../research/2026-09-03-codex-astra-compatibility.md)
preserves primary-source citations and the accepted scope. It is not evidence
of deployed behavior or account availability.

## Implemented contracts

- **Reviewed model catalog and pricing:** one shared catalog supplies 39 OpenAI
  identities to local normalization, telemetry, browser validation and admin
  configuration. Legacy ordinals are preserved. Eight Astra cards cover every
  supplied tier/context combination, with separate cache writes and event-time
  provenance. Astra long pricing begins strictly above 272,000 input tokens;
  older model boundaries are unchanged. API Fast is 2x Standard, independent of
  subscription-credit multipliers. No speculative `gpt-6t` alias was added.
- **Cache interpretation:** model-aware semantics replace universal Max/Ultra
  equivalence in the analyzer, browser and exact thread-link resolver. Astra
  Ultra maps to API xhigh but remains a distinct cache-analysis mode because it
  enables delegation. A settings change alone is never measured cache loss;
  observed drops still require complete usage evidence and existing compaction,
  contraction and attribution gates. Raw/request labels stay separate from
  unverified effective effort. Explanatory copy is updated in all three locales.
- **Missingness and replay:** omitted/null components remain unavailable through
  extraction, worker messages, SQLite and incremental cursor restoration;
  explicit zero remains observed zero. Parser/scanner versions force safe
  reprocessing where sources remain present. Retained rotated sources keep
  their original provenance; lineage keys remain compatible without changing
  missing evidence into zero.
- **Compressed history:** native, capability-gated Zstd decoding is bounded and
  read-only. Logical decoded offsets/hashes are separate from physical identity.
  Plain/compressed twins deduplicate; divergent histories quarantine. Complete
  frame validation, byte/window/time limits, cancellation and checkpoint line
  boundaries fail closed. No shell decoder, new dependency, decoded transcript
  file or source rewrite is introduced.
- **Admin history and display:** preview v0.3 uses a shared, versioned compact
  daily projection. Old four-model history remains readable; newly added models
  in old days are not recorded, not zero. All 39 reviewed identities are
  selectable, with identified-fit, all-model and individual-model filters.
  Spark remains separate/unpriced and excluded from primary fits. Existing fit
  gates and scheduled computation remain; admin requests read the bounded cache.
  The total preview cap is explicitly 256 KiB; the daily cap remains 16 KiB.
  Maximum 70-day catalog payloads are tested against the bound.
- **Distribution contracts:** browser/schema mirrors and public package types
  are regenerated from their owners. Export, review-artifact and macOS package
  closures include the new shared modules and bounded byte reader. Pricing
  versions invalidate affected caches; protected benchmark receipts are not
  reused as current evidence.

See the detailed [pricing decision](../decisions/2026-09-03-astra-pricing-and-model-identity.md),
[ingestion review](./2026-09-03-codex-ingestion-compatibility.md), and
[compression review](./2026-09-03-codex-compressed-history-support.md).

## Deliberate compatibility limits

1. Upstream response records and compaction checkpoint copies remain ignored
   alongside legacy `token_count` accounting, as explicitly permitted by the
   accepted scope. Tests prevent double counting. **Response-only usage is not
   yet supported**; adopting it requires response-identity reconciliation.
2. A harness-authored `configuration_update` is input provenance, not backend
   acknowledgement. No effective-effort field is inferred from it. Actual Astra
   availability, applied updates and eligible cache-preserving transitions need
   installed-client and real-log qualification.
3. Compressed history needs native Zstd capability. The unsupported-runtime seam
   is tested; an actual Node 22.13 process was not run. Passive collection stays
   the live/plain lane; historical compression is handled by scanners/indexing.
   Existing paginated-checkpoint refusal remains explicit. Large real-history
   throughput and repeated prefix-decompression costs remain unmeasured.
4. The catalog is closed and reviewed, not unrestricted model passthrough.
   Unknown/future models are not assigned invented pricing or capacities.
   Catalog visibility does not prove model availability or quota comparability.

## Validation results

Counts below are individual overlapping commands, not additive coverage totals.

| Gate | Result and boundary |
| --- | --- |
| Full root `npm test`, with required local process/socket permissions | 3,761 tests: **3,738 passed, 2 failed, 21 skipped**, no cancellation; 412.5 seconds. Only retained R7 generated-evidence freshness/exact-decision checks fail. |
| Final full browser `npm run product:ui:test` | **492/492 passed** after all final UI, palette and responsive-grid changes. |
| Worker `npm run product:worker:check` | Package guards, generated assets, type checks and script checks passed; **43 Vitest files, 527 tests passed**. Then production dry build refused the uncommitted tree. |
| Final Worker admin follow-up | **14/14 passed** and type checking passed, including retained legacy-day read coverage added after the full Worker run. |
| Worker pricing parity | **19/19 passed**, including Astra short/long card identity and canonical local numerical parity. |
| Final cache analyzer, thread links and browser cache cohort | **77/77 passed**. |
| Final admin history/client/chart cohort | **31/31 passed**, including extreme bounded serialization and responsive-grid regression. |
| Ingestion/index/replay focused cohort | **291/291 passed**; see its detailed receipt. |
| Final compressed/checkpoint/resource cohort | **52/52 passed**; see its detailed receipt. |
| Native package smoke cases in full root run | Ad-hoc watchdog bundle and signed-fixture health relay both passed after runtime-closure repairs. Not an installed or production-signed release. |
| Documentation, architecture, preflight, generated mirrors | Passed; final checks run after the research-record move and receipt addition. No whitespace errors. |

The full root run preceded the last narrow admin tests and responsive-grid
correction; the final browser/admin cohorts cover those later changes. The
21 root skips are 17 Windows-only cases and four unprepared Sparkle/appcast
input cases, not newly disabled tests. Initial sandbox-limited failures are
recorded in the ingestion review; successful permission-correct reruns replaced
those results. No test was removed or weakened to make a gate pass.

### Rendered evidence

An isolated loopback server rendered the canonical admin HTML/JS/CSS using only
synthetic fixture API responses. Desktop width 1,200 and mobile width 390 were
inspected in Chrome with screenshot review. Verified the responsive three-column
to single-column card layout, 41 selector options (39 models plus two filters),
visible matching chart/legend colors for Astra and older models, Astra-only
history gaps, and Spark's separate/unpriced unavailable-value state. Mobile
document width equalled viewport width, with no horizontal overflow.

This is synthetic browser QA, not authenticated Worker deployment, private
account data, native WKWebView, exhaustive accessibility or installed-app QA.
Captures were kept outside tracked source. The isolated browser and local server
were stopped after inspection.

## Remaining release gates

- Review and commit the intended source set before the production dry-build
  command can proceed. No automatic staging or commit was used to bypass it.
- Obtain separate authority for protected dual-runtime R7 regeneration under
  the [R7 runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md),
  then rerun the exact receipt gates. Current failures reflect changed workload
  source hashes/counts, not a newly measured benchmark regression.
- Qualify representative real Astra/new-CLI evidence and compressed histories
  before claiming applied-update support or real-history performance.
- Complete the normal release versioning, CI, signed/notarized artifact, native
  install/upgrade, Login Item, updater/download and public release checks under
  the [release runbook](../runbooks/macos-stable-release-runbook.md).

No push, hosted deployment, production migration, model request, public release,
installed-app replacement, protected R7 regeneration or production signing was
performed. Source readiness and each of those external gates remain distinct.
