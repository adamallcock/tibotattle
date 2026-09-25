---
title: Pro 50x plan integration
date: 2026-09-24
type: plan
status: provisional-implemented
---

# Scope and evidence boundary

Implement the proposed personal Codex tier whose expected wire identifier is
`promax` and whose TiboTattle-facing label is **Pro 50×**. This is an
implementation plan and source progress record, not evidence that the tier is
available or that any installed client, hosted service, or release supports it. The source audit used clean
checkout `9385bad260698814cc2a4a6c685575a3fd63811a` on 2026-09-24.

[Official OpenAI documentation](https://learn.chatgpt.com/docs/pricing)
currently describes Pro 5x and Pro 20x, with no Pro 50x limit table. On
2026-09-24 (Eastern), [OpenAI's Codex source at
`b725da3b6d5237e8eb0cf8bb0bc47b8efa575fc2`](https://github.com/openai/codex/blob/b725da3b6d5237e8eb0cf8bb0bc47b8efa575fc2/codex-rs/protocol/src/auth.rs)
added raw `promax` with the exact `KnownPlan::display_name()` value
**“Pro (Max)”**. It also changed `pro` to “Pro (More)” and `prolite` to
“Pro.” The ledger and source fixture now pin those exact pairs. The locally
bundled `codex-cli 0.155.0-alpha.16.4` still exposes the earlier 17-value
`PlanType` schema, including `unknown` and excluding `promax`; the branch's
release contract check fails. Confirm a released binary contract, observed
quota windows, and the meaning of “50x” before release qualification. The
dedicated branch `codex/pro-50x-integration` keeps the 50x factor provisional.

The accepted [plan-name decision](../design/2026-08-26-codex-plan-display-names.md)
requires an exact upstream raw identifier and an exhaustive official-name
registry. The official “Pro (Max)” name belongs in that registry; “Pro 50×”
is the separate provisional product label. Never derive a
plan from the window duration or from a nominal multiplier.

# Current plan-dependent surface inventory

| Boundary | Current behavior and source | Pro 50x work |
| --- | --- | --- |
| Provider vocabulary and drift | `config/codex-contract-ledger.json`, `scripts/check-codex-contract-drift.mjs`, and the two `test/fixtures/codex-*plan*` fixtures pin the raw/display pairs and installed binary contract. | The new source revision and exact raw/display pair are pinned. Verify a released binary schema before lifting the provisional release block; do not title-case `promax`. |
| Detection and capture | `src/providers/codex/plan-normalization.js` maps unrecognized provider plans to `unknown`; `app-server.js` reads `account/read` and rate limits, while `log-normalization.js` reads rollout `plan_type`. `account-scope.js`, `src/passive-collector.js`, and `src/capture.js` carry the resulting evidence. | Admit the verified value through the canonical vocabulary. Test account/rate-limit agreement, missing fields, malformed labels, and a plan switch; preserve unknown/conflicted evidence. Pre-support observations normalized to `unknown` cannot simply be relabelled after the fact. |
| Local persistence, accounting, and allowance | `src/local-unified-index.js` persists plan-labelled observations; `src/local-companion-usage-model.js`, `src/replay-safe-accounting-cache.js`, `src/reporting/weekly-calibration.js`, and `packages/quota-analysis/` partition reset fits, history, composition, and pace by plan era. `src/local-companion-data.js` projects the selected population. The reporting contract currently caps a history at 16 plan populations. | Keep Pro 50x a separate era, never pool its numerator with Pro or Pro Lite, and review the 16-population bound. Existing observed-window and API-price-equivalent algorithms should remain plan-neutral; test a Pro → Pro 50x → Pro transition and both five-hour/seven-day observations if the provider emits them. Do not invent a seven-day fit when it does not. |
| Export and contribution contract | `packages/telemetry-contract/src/constants.js` owns the closed plan list and display registry. Package validators, TypeScript declarations, v0.2/v1.1 schemas, `src/export/safe-records.js`, `src/application/export-sources/codex-collector-export.js`, and `src/contribution/telemetry-v1*-chunks.js` use it. The Worker validates via its installed package in `apps/worker/src/telemetry-validation.ts`, `telemetry-v1.ts`, and `quota-analysis-v1-reader.ts`. | Extend the canonical allowlist and declarations, regenerate only owned schema/browser/upload mirrors, and review consent and old-client/new-Worker compatibility. Preserve historical bytes, unknown values, privacy limits, and distinct account/plan attribution. Deploying a producer before a compatible receiver would reject the new value. |
| Local display and native shells | `apps/web/public/data-client.js` validates the mirrored plan enum; `apps/web/public/app.js` explicitly labels Pro as 20× and Pro Lite as 5× on share cards, the weekly selector, and allowance views. Electron and macOS compose this browser/local-companion surface; no separate native tier formula was found. | Add the reviewed Pro 50× presentation label, including history/selector/share-card contexts, and inspect browser, Electron, and native rendering. Unknown plans must still have no invented chip. |
| Hosted fit and private diagnostics | `apps/worker/src/community-allowance.ts` fits observed seven-day resets and admits only `pro`, `prolite`, `plus` into the combined public cohort. `admin-community-allowance.ts` reuses that roster for owner preview and per-model normalization. `admin-metrics-history.ts` computes per-plan cohort/count/capacity gauges dynamically. | Add Pro 50x to the reviewed personal roster only after contract and window evidence. Extend private counts and actual-versus-normalized capacity diagnostics first; preserve unsupported counts, bounded caches, one vote per reset, and plan-era separation. |
| Public allowance contracts and cutover | `community-daily-aggregates.ts` and `index.ts` gate revisioned daily allowances on an exact basis/readiness state. `public-allowance-breakdowns.ts` projects a closed three-plan object from the validated private preview. Migration `0040` seeded the readiness singleton; the current D1 plan columns are text rather than a three-value SQL enum. | Keep the existing Pro 20× reference for comparability, but version the basis/normalization, admin preview, and public breakdown contract when the roster changes. Rebuild the complete reconstructable 70-day horizon before declaring the new basis ready; retain immutable old revisions and hide mismatched blocks. Do not assume a D1 migration is needed solely for the new text value; rehearse against a local database. |
| Public and admin browser views | `apps/web/public/community-data.js` accepts only the exact current basis, normalization, and three keys; `admin-client.js` validates the three-plan preview. `community-view.js` and `admin.js` define plan series and labels; the separate admin cohort card currently prints raw plan tokens. `styles.css`/`admin.css` supply the chart/card layout. `localization.js`, `community.html`, `admin.html`, and `docs.html` state the current basis. | Add a fourth plan to closed validators and charts, choose a distinct existing series color, map the new admin cohort token to the reviewed label, and update localized explanation and accessible labels. A dual-version reader should understand the old published shape while it is live, but must never present it as a four-plan estimate. Check four-card layouts at narrow widths. |
| Documentation and tests | `docs/user-guide.md`, `docs/reference/api-surface.md`, and the maintained schema/plan-name references describe current semantics. Contract, provider, local, Worker, browser, and generated-asset tests pin the present roster. | Update maintained authorities and exact fixtures with the implementation. Preserve older dated receipts and historical investigations as point-in-time records. Run focused tests and source/package/runtime checks separately. |

`packages/accounting/` prices observed tokens by model, speed, and billing
surface; it has no subscription-plan price table to extend. A Pro 50× label
must not be treated as an API price, a subscription price, or a provider-published
dollar allowance. General `planType` grouping in quota analysis and Worker
storage should stay generic rather than growing tier-specific branches.

Other generic plan-aware paths to regression-test are
`src/prospective-collector-transitions.js`, `src/local-usage-explainer.js`,
`src/local-unified-contribution-attribution.js`, `src/analyze.js`,
`src/weekly-limit-history.js`, `src/weekly-pace-projection.js`,
`src/simple-quota-gradient.js`, `src/reporting/monitoring-quality.js`,
`src/reporting/usage-explainer.js`, `apps/worker/src/quota-analysis-v1.ts`,
`quota-analysis-v11.ts`, and `community-snapshots.ts`. Their current plan
keys and equality checks should admit a reviewed new token without changing
the estimator. The explanatory copy in `src/build-multi-surface-report.js`
also names the existing Pro tiers and needs an accuracy pass.

# Proposed normalization and product decision

Retain the single public **Pro 20×-equivalent** weekly basis. If “50x” is
confirmed to mean 50 times the same Plus baseline as the existing 5x/20x
tiers, a Pro 50× observed fit converts to that basis with **20/50 = 0.4**;
the card's plan-own value is the unrounded reference estimate divided by
`0.4` before formatting. Existing factors remain Pro ×1, Pro Lite ×4, Plus
×20. These are declared comparison conventions, not measurements of the
provider's private allowance formula. Measured per-plan medians should be
checked for sustained divergence before adding the tier to the merged line.

This new factor changes the cohort definition even though the reference plan
is unchanged. Give the combined daily basis and normalization distinct new
identities, and version the three-plan public breakdown DTO and admin preview.
Version derived preview and per-model day caches independently of raw-fit cache
keys so a display/cohort change does not needlessly refit unchanged sources.
The new reader may accept both old and new DTOs during rollout, selecting the
correct plan roster for each version. It must reject extra keys and mismatched
basis/factor combinations. Old immutable daily revisions remain old-basis
evidence; the scheduled reconciliation publishes new revisions before the
readiness singleton can mark the reconstructable horizon ready.

Adding a fourth publicly visible cohort is a publication decision. The
recommended order is private detection and admin-only diagnostics, then a
separately reviewed public projection after verified wire/window evidence and
enough fit evidence to evaluate the nominal factor. Keep the existing one-line
aggregate rather than create a parallel “Pro 50x allowance” estimator.

# Implementation and verification sequence

1. **Verify contract and semantics.** The exact `openai/codex` source revision,
   `KnownPlan` name, and source digest are recorded. Capture the released binary
   `PlanType` schema, official multiplier baseline, and observed quota windows;
   use synthetic, content-free fixtures. If any element is absent, keep that
   claim provisional rather than infer it from the source name.
2. **Make local and receiver vocabularies compatible.** Update canonical
   telemetry types, display names, source/fixture parity, export and contribution
   schemas, and generated mirrors. Check legacy v0.1/v0.2 and v1.1
   compatibility/consent status without broadening record fields. Qualify the
   installed Worker package copy and its ingestion refusal/acceptance paths
   before an updated desktop producer can share the new value.
3. **Qualify local behavior.** Test account/read and rollout normalization,
   unknown and conflicting plans, account switches, replay/restart, plan-era
   calibration, historical selection, pace, five-hour history, and share-card
   labels. Confirm all-plan token accounting is unchanged. Render the loopback
   dashboard and the packaged target surfaces with synthetic and approved local
   evidence; browser success alone is not native qualification.
4. **Build private hosted evidence.** Extend the personal roster and private
   preview with the verified factor. Update preview/cache versions, cohort
   gauges, bounds, and tests for mixed plans, sparse data, absent seven-day
   windows, and per-model no-look-ahead. Read back a local D1 preview and
   compare unscaled plan capacity with the normalized value.
5. **Prepare and gate public cutover.** Add a new closed public DTO, browser
   dual-read compatibility, chart/card/localized copy, and the daily publication
   basis. Reconcile all visible days inside the 70-day reconstructable horizon
   with bounded, resumable scheduled work. Preserve the prior ready publication
   or show `updating` until the new version is complete; never mix bases in one
   line, show a three-plan cache as four-plan data, or treat a missing plan as
   zero. Verify the exact public response and rendered chart after deployment.
6. **Complete gates and docs.** Run `npm run codex:contract:check`,
   `npm run codex:contract:release:check`, `npm run telemetry:check`,
   `npm run telemetry:browser:check`,
   `npm run telemetry:upload-schemas:check`, the focused provider/local/quota
   tests, `npm run product:local:test`, `npm run product:ui:test`,
   `npm run product:worker:check`, `npm run architecture:check`,
   `npm run docs:check`, and `npm run test:preflight`. Use the owning macOS,
   Electron, release-site, and installed-artifact gates when those deliverables
   actually change. Source, installed client, hosted deployment, historical
   rebuild, and public rendering each need their own receipt.

# Decisions required before release or publication

- When will a released Codex binary expose the source-verified `promax`
  `PlanType`? Its official source display name is “Pro (Max),” while the
  user-facing “Pro 50×” label remains separate.
- Is 50x relative to the same Plus baseline as the documented Pro 5x/20x
  options, and does the tier expose a comparable seven-day Codex allowance?
- Should the new tier join the combined public estimate and visible By plan
  series as soon as the contract is verified, or only after the private
  factor/fit review recommended above?

## Provisional implementation snapshot

The dedicated worktree carries the provisional `promax` vocabulary, provider
normalization, local plan-era attribution, v0.1 local export and v1.1 upload
schemas, a legacy v0.2 `unknown` projection, Pro 50× browser labels, the
four-plan Worker fit roster and owner preview, a versioned v1.2 public
breakdown, and a projection-specific cache version. Existing fit and raw
composition caches retain their method identities. Source tests use synthetic
data. The Codex source fixture now reflects 17 named plans including `promax`;
the installed-binary fixture retains its older 17 values including `unknown`.
The release contract check deliberately refuses the provisional value until
the binary and allowance evidence is reviewed.

The nominal factor `0.4` and Pro 50× label are assumptions in this branch.
No installed application, hosted database, public site, deployment, migration,
or historical rebuild has been changed.
