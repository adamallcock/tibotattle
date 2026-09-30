---
title: OpenAI September 29 release audit and implementation plan
date: 2026-09-29
type: plan
status: in-progress
---

# OpenAI September 29 release audit and implementation plan

## Scope and evidence boundary

The user approved local implementation on 2026-09-29. Work proceeds in bounded,
validated components. This document records the accepted decisions, progress and
remaining gates. On September 29 the user additionally authorized committing,
pushing, opening and merging the client PR, followed by work on the main Worker.
Deployment, publication, production migration and installed-release qualification
remain separate outcomes.

- **Audit baseline:** remote `main` at
  [`30c0feb083666cba827aaea11eb3c2cb2061d01c`](https://github.com/adamallcock/tibotattle/commit/30c0feb083666cba827aaea11eb3c2cb2061d01c),
  verified on 2026-09-29 and inspected through an immutable source archive.
- **Implementation base:** this writable checkout was advanced from the stale
  September 13 revision to the exact audited `30c0feb` revision, preserving the
  plan. The unused, pristine managed checkout was archived after the writable checkout was selected.
- **Related work:** [draft PR #223](https://github.com/adamallcock/tibotattle/pull/223),
  head `175094cd73e5356d23e57e5ae5d9747e3a936c4a`, remains open and unmerged.
  It implements provisional `promax` / Pro 50× support. Its compatibility work
  is reusable, but its 50× product assumption is not the requested 25× policy.
- Repository paths and line references below describe the audit baseline,
  unless explicitly marked as this worktree or the draft PR.

## Client PR boundary

The client PR contains local ingestion, valuation, plan labels/ratios, timing,
desktop/dashboard presentation, authorization recovery, shared package contracts
and generated mirrors. The shared contract expansion also requires the hosted
pricing adapter, exact new performance authorization/storage admission and their
forward migration source/tests. Including that compatibility source does not
apply the migration or deploy the Worker.

The main Worker follow-up retains the new public/admin normalization, four-plan
publication, derived-cache identities, public/admin UI and website examples.
The client PR preserves the existing hosted Pro 20x publication/read contract
until that follow-up changes producers and readers together. Raw `pro` identity
and history remain continuous. The completed-work and verification entries below
also record the combined development worktree before this split; they are not
claims that every Worker/publication change is in the client PR.

The new recovery helper is explicitly included in both closed public-API
allowlist tests. Isolated-candidate validation is recorded with the PR; earlier
combined-tree receipts below remain point-in-time evidence.

## Implementation progress on 2026-09-29

| Component | Current local result | Remaining boundary |
|---|---|---|
| Models and prices | GPT-6.1 Sol added across reviewed catalogs, local/export/server pricing, public and admin displays; Standard/Batch/Flex/Fast cards cover both context bands. Old card bytes and enum positions preserved. Astra Ultrafast has exact 6× API cards. | Sol Ultrafast remains unpriced until a published card exists; no generic 6× fallback. |
| Speed evidence and accounting | Standard/Fast/Ultrafast flows through actual tier observations, full/incremental/checkpoint scans, unified parser 19, replay cache 0.18, summaries, transitions, savings, performance and browser controls. Sparse setting omission preserves prior explicit tier; explicit null clears it. Unsupported Ultra valuation remains unavailable. | Installed provider contract and real release behavior are unqualified. |
| Plan expectations | Same `pro` identity and history; current labels Pro 10× and Pro Max 25×. Reused `promax` plumbing, v1.1/v1.2 attribution, four plan filters/cards and expected factors `pro=1`, `prolite=2`, `plus=10`, `promax=0.4`. | No fitted capacity was halved, no rename-only era was introduced, and no absent cohort was published as a value. |
| Public reference and caches | Versioned Pro 10× normalization, breakdown v1.2, admin preview v0.4 and derived publication/cache identity. Raw empirical fit identity/history retained. Legacy 20× payloads retain their units. | Deployment and public cache cutover remain separate. |
| Performance/storage | Sol and Ultra independent cohorts, bounded three-mode prewarm, timing parser 18 and atomic staged repair (primary SQLite 6, supplement 7). Forward migration `0013` preserves old reports and requires new authorization for new performance writes. Performance activation requires exact `0009`/`0013` pins, both cohort dictionary triggers and the observed policy revision. | Remote migration needs its own reviewed environment plan and rehearsal; no old operator pins were broadened. |
| Desktop windows | Existing observed-duration behavior handles weekly-only Pro/Pro Max. Saved five-hour preference remains unavailable when no such lane was observed. | Installed Electron QA remains separate; no synthetic five-hour quota was added. |
| Dots | Verified product distinction and content-free qualification cases recorded. | A stable local billing/source discriminator is still unavailable. No model-, ancestor-, automation- or name-based exclusion was introduced. |

The separate `includedAllowanceSpeedWeight` policy records dimensionless
Standard 1, supported Fast 2.5 and Astra Ultra 8 with an explicit pool and date
boundary. It has no product consumer yet: `chatgpt_subscription` cannot tell
included allowance from purchased credits. Unknown pools return unavailable;
API and purchased-credit pools are not applicable. Existing empirical
API-equivalent calibration retains its disclosed API price basis. This avoids
claiming that the documented multiplier identifies an observed pool or a
provider allowance formula. Connecting this policy requires actual pool evidence.

Late missing-context checks found and corrected preexisting zero coercion in
local pricing adapters and the memoized pricer's GPT6 context boundary. Local
pricing methodology advances to `provider-neutral-api-price-equivalent-v0.3`;
Cache 0.18 requires rebuilding prior materialization rather than relabeling it.
Current readers use `source_native` context; explicitly requested `legacy_zero`
remains a truthful compatibility mode. Unavailable input components remain
unavailable, known totals including observed zero remain authoritative, and
context-independent rates can still contribute a supported partial subtotal.
The old price-card bytes and evidence hashes are unchanged.

Focused verification passed pricing/speed, plan attribution and publication,
export privacy/materialization/deletion, performance, timing repair, consent,
browser adapters, monitoring and contribution repricing. Architecture and
generated telemetry/browser/upload/i18n checks passed. Worker scripts, types
and complete runtime tests passed; its aggregate gate refused the subsequent
release-build step because the candidate is not a clean, committed release tree.
Disposable browser QA verified four plan cards on desktop and a narrow viewport,
translated plan/model/speed controls, GPT-6.1 Sol recognition and the explicit
empty-Ultrafast measurement state. All displayed values in this preview were
synthetic and marked as such; it does not qualify installed or deployed UI.

Synthetic OS-boundary tests passed 4/4 outside the restricted sandbox, and the
four synthetic measured R7 benchmark files passed 21/21 once child-process RSS
inspection was permitted. Protected retained R7 receipts remain unchanged and
need requalification; the initial broad gate also found baseline-identical
tool-inventory omissions. The client follow-up corrected both omitted callers
in the canonical inventory; its complete checker now passes. The retained R7
condition was not bypassed or recorded as a pass.

### Local verification receipts

The client follow-up completed the two outstanding source fixes: performance
authorization recovery and Fast-only pricing help. Renewing a reviewed social
performance authorization drains the old writer, verifies the current independent
hosted grant, and clears only an authorization/response rejection while preserving
acknowledged progress. Concurrent approvals are refused. Accountless restart or
protected-preference renewal re-proves its grant before preparing or sending data;
ordinary polling cannot retry a terminal rejection. Opt-outs and invalid reports
remain protected. Approved but paused sharing now offers **Review performance
sharing again**, with translated status and explanation in all three locales.

Overview and Usage and costs now explain Standard/Fast/Ultrafast API pricing,
unavailable rates, and the distinction from included allowance. Native inspection
caught and fixed missing browser registration for these new canonical keys; a
regression checks every explicit dashboard translation key. Both generated
language mirrors and the maintained guide/runbook were updated.

An isolated Electron source preview was rebuilt and reopened for user inspection
on September 29 using the current dirty checkout and the reviewed staged runtime
(804 files; manifest SHA-256
`637d52c8b09674754ae995fb73ecc5f5c5f9d09155bf3bd74f76009146dc8ddf`).
The source directory is
`.release-build/electron-dev/darwin-arm64/client-improvements/app`; its durable
ignored profile contains only synthetic sample data and uses local-QA safeguards.
Native rendered inspection confirmed both new pricing explanations, GPT-6.1 Sol
in Model usage, selectable Standard/Fast/Ultrafast controls and an explicit empty
Ultrafast state. It is left open for inspection. The previous source/profile are
preserved. This is not packaged, signed or installed-release qualification;
social/accountless recovery was tested with synthetic services, not live grants.

| Gate | Result at this checkpoint |
|---|---|
| Complete browser UI | `pnpm run product:ui:test`: 1,073 passed, none failed/skipped after the final translation-registration fix. Includes paused-sharing review and explicit dashboard translation coverage. |
| Complete local companion | `pnpm run product:local:test`: 407 passed, none failed/skipped, including renewed authorization, rejection preservation and concurrent approval tests. The extended accountless restart journey subsequently passed in the final focused recovery suite. |
| Client authorization follow-up | 22 focused sync/social/accountless tests passed after the restart extension, including fresh-grant proof, old-dictionary refusal before preparation, persisted progress, restart and opt-out protection. No live grant or upload was used. |
| Client source tooling follow-up | Architecture boundaries, both generated language checks, preflight and complete tool-inventory check passed. The earlier inventory omission is repaired; protected retained R7 receipts remain unqualified. |
| Public release-site source | `pnpm run product:release-site:test`: 71 passed. This qualifies source/preview generation, not publication. |
| Runtime packaging | 38 targeted Electron, older-shell replacement, updater staging and standalone review tests passed after adding the public allowance-policy module to both reviewed runtime file lists. No app launch, install or signing. |
| Export lifecycle | 131 focused export/deletion/privacy/materialization/CLI regressions passed after correcting the four stale compatibility version pins. |
| Monitoring and window breakdown | 295 tests passed; Ultra is known evidence, unknown counts remain distinct, and the browser retains explicit Ultra amounts/zero versus absent values. |
| Legacy contribution pricing | 12 builder/materializer tests passed, including Astra Ultra short/long context and unsupported Sol Ultra remaining unpriced. |
| Performance and authorization | 152 focused performance tests, 21 consent/sync tests, 60 timing/storage tests and 23 Worker performance/restore tests passed. |
| Exact performance activation | 28 activation tests and 36 operator-reconciliation tests passed; combined activation/performance 49 passed. Missing/altered `0013`, either missing dictionary trigger, and obsolete revision 1 are refused. No remote migration or activation. |
| Canonical unknown-context pricing | 54 ledger/local-pricing/registry/boundary tests and 25 frozen accounting/speed tests passed. Covers supported Sol modes, Astra Standard/Fast/Ultra, explicit and legacy context, unavailable/raw-zero evidence, observed zero and independent tools. |
| Context repair through local projections | 135 cache/transition/calibration tests and 183 companion/refresh/window tests passed. Includes memoized/full parity at 272,000/272,001, nullable components, observed zero, legacy raw context and a synthetic rollout → SQLite → companion/window path. |
| Historical calibration and comparator follow-up | 108 cache/eligibility/component-parity tests, 5 streamed/resident/child rebuild tests, 9 current QA-fixture tests and 42 ledger/receipt tests passed. Nullable input columns preserve their pricing warnings through full-history calibration; the new missing-context diagnostic is optional in the comparator and leaves legacy aggregate/frame bytes unchanged. |
| Worker source and runtime | `npm --prefix apps/worker run check`: scripts, package/generated-type guards, TypeScript and all 160 runtime files / 2,019 tests passed. The aggregate command exited 1 at `production:stage-assets`, which requires a clean committed release tree. No guard was bypassed. Dry builds/staging artifact checks were not reached. |
| Staging configuration | The supported read-only config check passed all 22 structural checks; its sole blocker was `GENERATED_COMMUNITY_ASSETS_INVALID` because committed/provenance-verified staged assets are absent. This is not a staging build or deployment pass. |
| Earlier complete source gate | Before the client follow-up, `pnpm test`: 5,958 tests, 5,908 passed, 3 failed, 47 skipped. Failures were two protected retained R7 receipt/source mismatches and one baseline-identical static-tool inventory omission. The inventory is now repaired and its owning checker/test pass; the complete root gate has not been rerun after these client changes and is **not green**. No protected receipt or test was bypassed. |

The final complete source log is `/private/tmp/tibotattle-root-final-source-gate.log`
and the final local companion log is `/private/tmp/tibotattle-local-final-source-gate.log`.
Other local logs are `/private/tmp/tibotattle-integrated-root-final.log`,
`tibotattle-ui-final-gate.log`, `tibotattle-release-site-final.log`,
`tibotattle-local-final-gate.log`, `tibotattle-monitoring-breakdown-final.log`, and
`tibotattle-ultrafast-contribution-final.log` under the same temporary directory.
The final Worker receipt is `/private/tmp/tibotattle-worker-final-gate.log`.
The retained R7 workflow was not run and its checks were not weakened.
The client follow-up receipts are `/private/tmp/tibotattle-client-final-ui.log`,
`/private/tmp/tibotattle-client-final-local.log`,
`/private/tmp/tibotattle-client-recovery-tests.log` and
`/private/tmp/tibotattle-client-improvements-build.log`. The ignored
`.release-build/client-preview/current-preview.json` binds the reopened preview
to its staged manifest and isolated profile.

## Verified product facts and unresolved evidence

| Topic | Evidence on 2026-09-29 | Required interpretation |
|---|---|---|
| GPT-6.1 Sol | Official API pricing includes Standard, Batch, Flex, and Fast; Codex launch modes are Standard and Fast | Add an independent `gpt-6.1-sol` identity; preserve GPT-6 Sol and older historical identities |
| Ultrafast | Published API table lists GPT-6 Astra; Sol 6.1 support is explicitly coming later | Recognize the tier throughout the system, but do not fabricate a Sol 6.1 Ultrafast rate or availability |
| Speed cost versus allowance | Fast: 2× purchased credits versus 2.5× included usage; Astra Ultrafast: 6× versus 8× | Separate API-equivalent money from subscription allowance weighting |
| Dots | Conversations with a dot do not count toward ChatGPT usage; Work/Codex tasks it starts or manages count normally | Never blanket-exclude all dot descendants, background agents, or Astra activity |
| Pro / Pro Max | User specifies Pro 10× and Pro Max 25×; upstream source recognizes raw `pro` and `promax` | Product labels and ratios are accepted task inputs; rollout timing does not block the ratio change or split Pro history. Installed provider qualification remains separate. |
| Pro windows | Official pricing currently says Pro plans have no five-hour limit | Preserve optional/missing windows; never fabricate a zero-valued five-hour allowance |

Sources: [API pricing](https://developers.openai.com/api/docs/pricing),
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed),
[Codex pricing](https://learn.chatgpt.com/docs/pricing),
[Sol 6.1 availability](https://learn.chatgpt.com/docs/models#gpt-61-sol),
[dots billing boundary](https://learn.chatgpt.com/docs/dots#access),
[dots task delegation](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
The supplied screenshots agree with the fetched API price table; they do not
establish subscription quota multipliers or missing model/tier prices.

### Price matrix

USD per million tokens; columns are uncached input, cached input, cache writes,
and output. Short context is at most 272,000 input tokens; long context exceeds
that threshold. Retain the distinction between observed cache writes and
unobserved usage rather than inferring writes from ordinary input.

| Model / mode | Short context: input / read / write / output | Long context: input / read / write / output |
|---|---|---|
| GPT-6.1 Sol Standard | 2 / 0.10 / 2.50 / 10 | 4 / 0.20 / 5 / 15 |
| GPT-6.1 Sol Batch | 1 / 0.05 / 1.25 / 5 | 2 / 0.10 / 2.50 / 7.50 |
| GPT-6.1 Sol Flex | 1 / 0.05 / 1.25 / 5 | 2 / 0.10 / 2.50 / 7.50 |
| GPT-6.1 Sol Fast | 4 / 0.20 / 5 / 20 | 8 / 0.40 / 10 / 30 |
| GPT-6.1 Sol Ultrafast | Not published / not available at Codex launch | Not published / not available at Codex launch |
| GPT-6 Astra Ultrafast | 60 / 6 / 75 / 300 | 120 / 12 / 150 / 450 |

The lower cached-input price distinguishes Sol 6.1 from GPT-6 Sol. Do not alias
the new model to the old one. Batch and Flex are API pricing tiers, not additional
Codex subscription speed controls. Unknown tiers remain unknown.
The [API Ultrafast guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)
also mentions limited GPT-5.6 Sol preview access; this is not a public price card
or authority to apply Astra's rate to another model.

### Plan identity is separate from allowance policy

Current upstream
[`auth.rs`](https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/protocol/src/auth.rs#L73)
at `b1e72963c3b71a9265a551e54beff078384efed9` recognizes `pro`, `prolite`,
and `promax`. Its display strings are `Pro (More)`, `Pro`, and `Pro (Max)`
respectively. These source strings are not the product's requested friendly
labels and are not proof of a released binary or a numerical allowance.

The fetched Learn pricing page does not establish exact 10×/25× multipliers or
the account-specific changeover time. Record the requested target as Pro 10× /
Pro Max 25× under the user-approved ratio policy; timing does not split Pro history or block this implementation. Verify
whether Pro Lite's advertised multiplier or promotions change as well; do not
infer this from the change to Pro.

## Accepted implementation decisions

### 1. Preserve separate money and allowance quantities

The existing `subscription-speed` implementation intentionally uses API
Priority/Standard ratios for both API-equivalent valuation and quota weighting.
The newly explicit vendor distinction means a third speed label alone cannot
make allowance calculations correct.

- Keep Standard-equivalent valuation available as an explicit comparison basis.
- Price actual API-equivalent usage with the exact model, tier, context band,
  event time, and published token-component rates. Preserve exact arithmetic.
- Give allowance estimation its own versioned policy: Standard 1×, currently
  documented Fast 2.5×, and Astra Ultrafast 8×. Purchased-credit/API multipliers
  remain separate; older model-specific API rates remain date-aware. Gate actual
  use on observed pool attribution; subscription authentication alone cannot
  distinguish included allowance from purchased credits.
- Do not apply 8× to an amount already priced at 6×. Starting from an already
  Ultrafast-priced equivalent would require the documented relative conversion,
  not another full multiplier. Prefer deriving both metrics independently from
  the same Standard-valued components.
- Audit the meaning, DTO versions, and labels of
  `quotaWeightedApiPriceEquivalentUsd`, calibration inputs, forecasts, savings,
  premium/share figures, and coaching output together. Do not silently change
  the meaning of a published metric or treat the estimate as an actual bill.
- A model/tier with no published card stays unavailable for exact pricing.
  Existing disclosed Fast fallbacks are not authority to invent Ultrafast rates.
- Preserve dated API money history. Any correction to historical allowance
  interpretation needs its own effective policy evidence and reproducible
  recalculation, not a retrospective overwrite with today's multiplier.

### 2. Add Ultrafast as a complete third speed

Normalize the exact observed provider tier and retain whether it came from a
served response, an explicit task/turn setting, a lineage setting, a time-bounded
configuration observation, or an assumption. Preserve the existing precedence
and account/lineage boundaries. `priority`/`fast` aliases remain Fast;
`ultrafast` is distinct. Reasoning effort `ultra` is not a speed mode.

Extend every closed mode enum, public type, counter, aggregation key, query
parameter, route validator, performance snapshot/cache key, and UI control.
Unknown mode must remain visible and excluded where the existing performance
contract requires explicit evidence. A source with only pre-launch mode evidence
cannot acquire Ultrafast through a current global setting.

Use synthetic transitions Standard → Fast → Ultrafast → Standard, resume/fork
lineage, missing baselines, conflicting settings, and explicit response evidence
to qualify parsing. Recheck value bounds: several consumer contracts currently
assume a maximum premium of 2.5×.

### 3. Keep Pro identity and calibration history; change expected ratios

The user explicitly corrected the proposed historical separation on 2026-09-29:
keep `pro` as the same plan and change its expected ratios. Do not create a new
entitlement epoch, split calibration periods, exclude older Pro observations,
or make rollout timing a blocker solely for the 20× → 10× ratio change.
Existing account, plan, reset and explicitly observed continuity boundaries
remain intact. Retained observations and empirical fitted capacities are not
halved or rewritten.

Keep provider IDs `pro`, `prolite`, and `promax` exact. Update provider-name
source evidence separately from friendly labels **Pro 10×** and **Pro Max 25×**.
Reuse PR #223's Pro Max plumbing, replacing its provisional 50× assumption.
Plus remains 1× and Pro Lite remains 5× unless evidence or the user changes them.
These are product normalization expectations, not a provider capacity formula.

### 4. Version the public normalization basis and caches

Change the current reference to Pro 10×-equivalent. The expected conversion
factors are `pro: 1`, `prolite: 2`, `plus: 10`, and `promax: 0.4`. Preserve Pro's
single plan identity and existing history. Version the changed normalization,
public breakdown contract and caches so an old payload with 20× units cannot
be silently relabeled as a new 10× payload. Frozen legacy `pro-20x` and
`pro-10x-promo` variants retain their compatibility meanings; the new regular
Pro label must not be encoded as the old promotional variant.

PR #223's provisional Pro Max 50× factor was also 0.4 against its old 20×
reference. That coincidence does not preserve the old reference unit. No new
model/plan estimate is published until the existing evidence thresholds pass.
An absent fit remains **No published estimate yet**.

### 5. Implement dots exclusion only from billing evidence

The required distinction is billing treatment of the activity, not its model,
name, icon, directory, or who initiated it. The official docs distinguish the
dot conversation from ordinary Work/Codex tasks. They do not supply a stable
local log marker or prove what local usage records will be emitted.

Prepare a minimal, content-free allowance-eligibility classification with
explicit included, excluded, and unresolved states. Only introduce a wire or
stored field after verifying the source signal and approving its closed contract.
Unknown newly encountered activity types must not be claimed as excluded or
silently used as clean calibration evidence. Preserve locally observed usage
according to existing retention rules even when it is excluded from allowance
estimation; exclusion is not deletion and does not mean zero API-equivalent work.

Once dots are available, qualify these cases locally using metadata only:

1. A direct dot conversation and its own background work.
2. A new Work/Codex task the dot starts, including subagents.
3. An existing normal Codex task continued by a dot.
4. Cloud-only work, connected-computer work, resume/fork and cross-host cases.
5. Interleaved ordinary user work, unknown markers, and provider quota snapshots.

Capture exact app/CLI versions, field names, bounded enum values, and observed
billing attribution. Do not retain prompts, responses, titles, real paths, raw
IDs, or secrets in fixtures or reports. A short interval with no visible quota
movement is not proof of exemption because reporting can be delayed or rounded.
Replay redacted synthetic equivalents through local ingestion, contributions,
server fitting, and displays. Do not exclude every descendant of a dot.

## Source inventory

Paths in these tables are repository-relative at the pinned remote `main`.
Line references identify the inspected entrypoint, not every occurrence.

### Model identity, pricing, and local accounting

| Owner / entrypoints | Required change |
|---|---|
| `packages/accounting/src/price-registry.js:13,39,102,375,498,672,729` | Independent Sol 6.1 cards and provenance; Astra Ultrafast cards; accepted-tier validator; exact 272K boundary; registry/version/hash manifests; preserve older cards and effective periods |
| `packages/accounting/src/cost-ledger.js:138,455,492`; `local-api-pricing.js:66,169` in the same directory | Verify exact tier/context selection, component arithmetic and unavailable prices; retain separate tool-unit pricing rather than multiplying every charge |
| `packages/telemetry-contract/src/model-catalog.js:6,48,89`; `src/export/registries.js:6,77,86,127` | Append reviewed `gpt-6.1-sol` identity, display/provider/price metadata and registry version; preserve existing enum positions and older model identities |
| `packages/telemetry-contract/src/model-catalog.js:100,112` | Verify Sol 6.1 reasoning-effort mapping; the current reviewed-model rule automatically applies legacy Ultra→Max mapping |
| `src/providers/codex/tier-normalization.js:1,57`; `src/local-unified-index-build.js:282` | Update both independent tier normalizers, API aliases, subscription mode and unknown behavior |
| `src/providers/codex/log-parser.js:122,397`; `src/local-unified-index-extract.js:772,804`; `src/passive-collector.js:372`; `src/application/export-sources/codex-checkpoint.js:215,386` | Cover all ingestion/export paths, explicit mode changes and clearing, parent/resume inheritance and per-turn evidence |
| `src/codex-speed-baseline.js:51,79,99,153`; `src/platform/codex-config-service-tier.js` | Accept an observed Ultrafast declaration without extending its time coverage or overriding stronger evidence |
| `packages/accounting/src/subscription-speed.js:45,61,131,215,235,465,497,539,576,620`; `packages/accounting/index.d.ts:240,243,392` | Third mode, generalized crossings/counters/public types; separate allowance policy from API-card ratios; review assumed-mode/fallback behavior |
| `src/local-companion-usage-model.js:45,219,240,330,361,388,398` | Mode×model projections, declared-mode settings, coverage and cost totals |
| `src/replay-safe-accounting-cache.js:143,545,1426,1444,1461,2154,2167,2589,2777,6353,6505` | Persisted dimensions, mode scenarios, compact transition rows and cache validation; invalidate by semantic version, not only price hash |
| `src/codex-primary-allowance-basis.js:5,10,18` | Replace the current Priority-ratio/two-scenario basis with a versioned compatible numerator/capacity contract |
| `src/codex-transition-miner.js:105`; `src/prospective-collector-transitions.js:20`; `src/reporting/weekly-calibration.js:336,938`; `src/simple-quota-gradient.js:459,469,477` | Calibration/mining weights, cohort eligibility, coverage, expectations and residuals; preserve existing plan/account/reset boundaries |
| `src/application/subscription-speed-sensitivity.js:23,84`; `src/cache-switch-impact.js:336`; `src/side-chat-estimates.js:471,638,715,1562` | Third-mode sensitivity, cache impact and side-chat estimates; Fast can no longer be described as a universal upper-bound scenario |
| `src/local-unified-window-breakdown.js:116`; `src/capture.js:42`; `src/local-analysis-index.js:2302`; `src/local-companion-data.js:526,1754,1786,1822`; `src/codex-local-usage-analysis.js:89`; `src/build-multi-surface-report.js:124` | Propagate the same counts, denominators, modes, labels and uncertainty into every report/summary |

The catalog and tier-normalization consequences were reproduced with synthetic
in-memory calls: Sol 6.1 is unrecognized, Ultrafast becomes `other`, and the
effective resolver then chooses assumed Standard. Direct Ultrafast weighting
instead reports unknown mode. Thus different entrypoints currently disagree;
adding a card without the surrounding contract changes is insufficient.

One additional parser mismatch requires attention: accounting currently ignores
`turn_context.service_tier`, whereas the timing parser handles it. Verify current
upstream event shapes and unify the reviewed precedence contract. Do not carry
forward the old assertion that speed appears only in setting-change events
without revalidating it.

### Persistence, telemetry and performance

| Owner / entrypoints | Required change |
|---|---|
| `src/local-unified-index-build.js:271`; `src/export/safe-records.js:138` | Sol 6.1 already ingested as unknown cannot be recovered from a price update alone; reparse retained evidence through a bounded, versioned path |
| `src/local-unified-index.js:145`; `src/export/versions.js:3`; `src/export/checkpoint-state.js:58` | Parser/checkpoint compatibility, additive migrations, restart/replay behavior and explicit incomplete historical coverage |
| `packages/telemetry-contract/src/telemetry-v0.1.js:198`; `packages/telemetry-contract/index.d.ts:230`; canonical v0.x usage schemas | Closed mode enums and compatibility projection; preserve frozen contracts rather than silently widening them |
| `src/contribution/telemetry-v1-chunks.js:389`; canonical v1.1/v1.2 schemas and validators | These accept bounded model/mode strings, but that does not establish recognition/pricing. Add any needed policy/eligibility proof through a reviewed versioned contract |
| `src/providers/codex/inference-timing.js:9,19,30,139,308`; `src/reporting/model-performance.js:4,38,46` | Independent model/mode allowlists, observed timing attribution and three-mode projections |
| `src/contribution/performance-daily.js:156,168`; `packages/telemetry-contract/src/telemetry-performance-v1.js:33,40,120,136`; `telemetry-performance-v1-schemas.js:179,236`; `index.d.ts:741` | Performance contribution dimensions, closed validators, schemas and types; separate cohorts and conserve excluded/unknown counts |
| `scripts/generate-telemetry-contract.js`; `scripts/generate-telemetry-browser-mirror.js`; `packages/telemetry-contract/scripts/sync-json-schemas.mjs` | Regenerate owned dictionaries, compatibility declarations, public catalogs, browser mirrors and upload/performance schemas |

Do not reinterpret immutable prepared sets or relabel older schema/parser
versions. Keep receipt-backed correction, replacement-domain, deletion and
consent/write-floor rules intact. Some prior timing rows intentionally remain
unclassified after migration; a new enum does not prove a complete historical
backfill. Historical source reparsing and hosted recalculation are separate
bounded operations with conservation checks and their own authorization.

Accounting-source changes also make relevant retained R7 evidence stale.
Protected R7 regeneration is a later release gate, not routine validation here.

### Client, public website, admin and agent displays

| Surface / entrypoints | Required change |
|---|---|
| `apps/web/public/model-visuals.js:4`; `ui-format.js:661` | Deliberate model order/color/icon/filter support; the generic formatter already formats Sol 6.1 correctly and primarily needs regression coverage |
| `community-data.js:304,312`; `community-view.js:534,1647` | Add Sol 6.1 to the selected public roster as well as accepted historical IDs; retain absent-estimate behavior and historical tuples |
| `model-performance.js:19,29,30,80,490,508`; `apps/local/model-performance-snapshots.js:7,10,61` | Independent model/mode allowlists, controls, notes and full-payload validation. Review bounded cache/prewarm capacity: four periods × three modes is twelve combinations, versus the current eight |
| `apps/web/public/data-client.js:6665`; `apps/local/server.js:5241`; `apps/local/model-performance-worker.js:94,151` | Ultrafast query/worker acceptance, snapshots, cache partitioning, cancellation, refresh and empty states |
| `apps/web/public/data-client.js:2695,3555,3560,3589,3593,3653,3658` | Mode buckets, duplicated price ratios, scenario and methodology validators, and 2.5× maximum-value assumptions |
| `app.js:6389,6403,6658,10310`; `data-client.js:4684` in the web public directory | Trends ranking/labels, premium callouts and side-chat mode counts; update uncertainty/scenario meaning |
| `app.js:2704,2355,2997,8741,8822`; `data-client.js:303,6273` | Local plan labels, allowance headline, historical plan selection, share cards and plan populations; keep the same plan identity with updated expected-ratio labels |
| `community-data.js:285,317`; `community-view.js:531,558,1635` | Current three-plan exact keys, normalization/divisors, labels/order, own-plan cards, small multiples, browser cache and chart reference units |
| `admin-client.js:16,672`; `admin.js:2550,2937,3020,3066,3083,3152`; `admin.html` | Four-plan config and version validation, chart labels, accessible text, units, tooltips and methodology; preserve legacy reads |
| `feature-insights.js:22,28`; `docs.html:176,240`; `community.html:474`; `index.html:342,801` | Synthetic example contracts, model and speed explanations, public reference labels and static descriptions |
| `apps/web/public/localization.js:589,902,957,1462`; `packages/i18n/index.js:559` and matching locale entries | Update both legacy page copy and the package catalog in English, Simplified Chinese and Spanish; cover all third-mode/plan/empty-state text |
| `src/build-multi-surface-report.js:124,485,491` | Fixed Standard/Fast export columns, Pro20× summary and two-mode report explanations |
| `src/reporting/usage-explainer.js:520,931`; `apps/local/agent-cli.js:164` | Dynamic model/price grouping mostly inherits shared fixes; add regression coverage for the new model, mode, plan period and allowance semantics. The CLI's explanation `--plan` is unrelated to subscription plan identity |

Unless otherwise qualified, short web filenames in this table are under
`apps/web/public/`. Every surface needs the same mode/model/plan semantics;
display support alone cannot repair ingestion or pricing.

Current remote `main` has retired `apps/macos/`; desktop ownership is Electron.
Do not implement against the older native source still present in this worktree.
Regenerate browser telemetry/catalog mirrors, browser i18n, Electron copy and
Worker admin assets from their canonical sources. Do not hand-edit generated
files or update only the public bundle.

### Optional quota windows and desktop behavior

Weekly-only Pro is already partly supported:
`apps/web/public/electron-tray-popup.js:1217` renders observed windows, and
`apps/electron/desktop-notification-policy.js:550` accepts one or two. Automatic tray selection
can choose weekly at `apps/electron/desktop-tray-status.js:417`. Saved five-hour/both/dual-meter
preferences still need review (`:458`), along with historical window selection
in `apps/web/public/app.js:8650`.

Distinguish a window that does not apply to the current verified plan from a
window whose evidence is missing. Preserve old five-hour history, Spark's
separate limit, existing user preferences, and reset/notification correctness.
Do not remove five-hour handling across the product merely because current Pro
has no such limit.

### Dots source boundary

`src/providers/codex/surface-classification.js:13,118` keeps a fixed taxonomy
of source, surface, agent scope and lineage. `src/local-unified-index-build.js:313`
persists that reduced taxonomy. There is currently no verified dot exemption
marker. Synthetic classification of `source: "dot"` produces unclassified;
adding generic subagent or automation metadata produces those generic buckets.
This demonstrates current classifier capability, not actual dots log behavior.

Any future eligibility flag must survive source normalization, checkpoint/index
storage, local allowance attribution, contribution projection, hosted fitting,
cache publication and UI explanation. Token/API-equivalent totals must reconcile
with excluded allowance activity. Re-check partial intervals and mixed sources;
one exempt event must not exclude an entire ordinary task or reset.

### Observed live public surface

On 2026-09-29, bounded unauthenticated reads of the
[homepage](https://tibotattle.com/) and [public docs](https://tibotattle.com/docs)
returned HTTP 200 HTML. The homepage still contains **Pro 20x-equivalent
allowance** and 0.1.26 download links. The docs still describe the Pro20×
reference and Sol/Luna support introduced in 0.1.24. One public daily-feed request
returned 403; it was not bypassed.

These observations establish delivered static copy only. They do not establish
the rendered graph, its live data, installed client behavior, Worker revision,
or source-to-deployment parity. Implementation must qualify those separately.

### Hosted plans, estimates, storage and publication

| Owner / entrypoints | Required change |
|---|---|
| `packages/telemetry-contract/src/constants.js:16`; `config/codex-contract-ledger.json:3,53`; `scripts/check-codex-contract-drift.mjs` | Raw plan registry, provider display-name evidence and released-binary gate; separate product labels and numerical policy |
| `packages/telemetry-contract/src/telemetry-v0.1.js:309`; `apps/worker/src/community-snapshots.ts:38` | Preserve historical `pro-20x` and `pro-10x-promo`; the new regular 10× entitlement is not the old promotion |
| `apps/worker/src/telemetry-v1.ts:201`; `packages/telemetry-contract/src/telemetry-v1.2.js:136` and v1.1 counterpart | New usage model/mode strings already pass bounded-token validation, but Pro Max quota records fail the closed plan enum; update readers and writers coherently |
| `packages/telemetry-contract/src/admin-model-history.js:9,80` | Freeze the current `2026-09-23.1` roster for historical compact payloads before adding the next catalog version |
| `apps/worker/src/server-pricing.ts:40,103,221`; `quota-analysis-v1.ts:779` | Subscription Ultrafast currently falls through to Standard; API Ultrafast is unpriced. Update exact pricing, type casts and provenance without changing shared spend into an allowance estimate |
| `apps/worker/src/validation.ts:27,217`; `repository.ts:92` | Legacy/synthetic route mode and tier types; deliberately preserve frozen compatibility where required |
| `apps/worker/src/typed-telemetry-codec.ts:206`; `telemetry-v12-typed-codec.ts:194,267,306,338`; `apps/worker/typed-ingestion-migrations/0001_typed_telemetry.sql:60,79,142` | Dictionary-based values can carry new vocabulary without necessarily needing a table migration. Qualify legacy/v1.2/effective readers; add forward storage changes only if new policy proof needs them |
| `packages/quota-analysis/src/plan-attribution.js:228`; `model-composition.js:112` | Preserve existing account/plan/reset continuity rules; do not add an era solely for the requested Pro ratio change |
| `apps/worker/src/community-allowance.ts:196,261,348,644` | Reuse existing fit/cache DTO and continuity rules; update four-plan normalization without introducing a new Pro era |
| `apps/worker/src/community-allowance.ts:59,104,136,216`; `admin-community-allowance.ts:406,490` | Version Pro20× normalization, fit/composition/pricing/attribution identities and admin scalar/composition calculations together |
| `apps/worker/src/quota-analysis-v11.ts:568,787` | Separate allowance eligibility from shared valuation. Preserve the existing refusal to compose multiple same-plan eras until an explicitly era-scoped fit is qualified |
| `apps/worker/src/public-allowance-breakdowns.ts:22,39,97` | New four-plan result shape, explicit basis/version, old-reader/cache compatibility and source-qualified absent estimates |
| `apps/worker/src/community-daily-spend.ts:1`; daily projected/typed/effective readers | Keep all recorded spend valuation separate from allowance-only exclusions and weights |
| `apps/worker/src/storage-community-graph.ts:35`; `community-model-history.ts:21`; `storage-community-daily.ts:26` | Changed normalization must invalidate relevant graph/daily/history caches and resumable checkpoints; never resume accumulated work under a changed unit |
| `apps/worker/src/community-daily-aggregates.ts:39,186,302,497` | Price drift can enqueue a year's spend backfill, but allowance reconstruction is bounded to 70 days. Preserve older allowance blocks and their original basis during price-only backfills |

The current calibration qualification floor is **25 percentage points**, not
the stale worktree's 40-point floor. Preserve the reviewed fit quality,
participant/evidence counts, uncertainty bands, and publication fencing.
Do not relax thresholds to populate new model or plan cards immediately.

The shared server pricer feeds spend as well as scalar/model allowance analysis.
Its stored-record adapter currently omits `surface`. A dots eligibility fix
therefore cannot be a blanket change to shared pricing. Carry an evidence-backed
eligibility decision specifically into allowance visitors, while preserving
separately retained usage valuation.

### Separate GCP / PostgreSQL candidate

The audited remote `main` has no PostgreSQL implementation. Candidate checkpoint
`6bb1b5c31fd6f6d077ca9ef55819f410672d4532` was separately inspected as source;
it is not evidence of deployment, cutover or parity. If that lane will serve the
updated product, port and qualify these additional consumers:

- `apps/worker/src/postgres-community-daily-publisher.ts:17,439,512` uses the shared repricer.
- `apps/worker/src/postgres-community-allowance-fits.ts:41,243,439` persists a fit DTO and needs matching four-plan normalization.
- `apps/worker/src/postgres-community-graph.ts:536,649` consumes reviewed model configuration and shared composition normalization.
- `apps/worker/src/postgres-community-graph-stream-publisher.ts` needs matching publication/checkpoint identity.
- Its PostgreSQL daily-publisher, daily-roundtrip, graph-roundtrip, graph-cohort and allowance-fits tests must establish real database parity with the D1 path.

Keep this work separate from the current Cloudflare rollout. A mock publisher
test, persisted-fit adapter, or activity/spend publication does not qualify a
live allowance estimate or establish migration readiness.

## Implementation order and acceptance gates

| Phase | Deliverable | Gate to move on |
|---|---|---|
| 0. Reconcile the base | A clean implementation branch/worktree from the reviewed current main; adapt useful PR #223 changes | Recheck current remote revision and draft status; preserve unrelated work; inspect narrower instructions and current release architecture |
| 1. Shared vocabulary and prices | Independent Sol 6.1 catalog/cards, Astra Ultrafast cards, supported tiers, plan names and raw `promax` | Exact component/context/date tests; old identities/cards preserved; no invented Sol Ultrafast or plan multiplier evidence |
| 2. Semantic contracts | Three-speed interpretation; separate API valuation, allowance weighting, eligibility and dated plan policy | Chosen metric/DTO/basis versions, compatibility rules and transition evidence are reviewable before changing calculation semantics |
| 3. Local pipeline and storage | Normalizers, parsers, baseline, checkpoints/index, cache, calibration, performance and exports | Synthetic end-to-end conservation/replay tests; copied-state upgrade/restart/backfill rehearsal; honest unknown historical coverage |
| 4. Hosted pipeline and public contract | Server adapters, existing fits, typed readers, four-plan public/admin projection and versioned caches | Old/new-client compatibility, D1 parity, queue/rebuild fencing and bounded recalculation plan; PostgreSQL parity separately if in scope |
| 5. All display surfaces | Local/public/admin/performance/share-card/tray/help/locale updates | Real rendered inspection plus contract/UI tests, weekly-only windows, historical/current units and empty states |
| 6. Dots qualification | A verified runtime discriminator and narrow exclusion rule | Direct dot conversation versus counted delegated/existing Work/Codex tasks proven with content-free evidence; leave this detector gated until then |
| 7. Release preparation | Generated assets, package alignment, candidate artifacts and concrete migration/recompute/deploy runbook | Separate source, storage, installed Electron, signed artifact, server and website gates; approval for the exact external outcomes comes later |

Sol's published supported prices can ship independently if their complete
recognition/replay/display path is qualified. Do not let the unresolved dots
detector block every verified model change. Conversely, do not ship a cosmetic
Ultrafast label while its values still price as Standard. Prepare server readers
before new client writers, and compatible web readers before publishing a new
public schema. Define how old clients consume or explicitly decline newer data.

Before a server price or methodology bump, estimate the queued recomputation
scope, use bounded resumable jobs, and verify generation fencing. Plan additive
source repair for already-unknown Sol records and explicit policy correction for
misclassified tiers. Avoid a blanket destructive rebuild, an unbounded live
experiment, or relabeling old published history. Document operational rollback
that preserves newer data and freezes incompatible publication rather than
running an older writer against a newer schema.

## Validation matrix for implementation

| Contract | Minimum meaningful regression coverage |
|---|---|
| Prices | All four token components across every supported model/tier/context; 272,000 versus 272,001 input tokens; missing context; effective-date edges; exact rounding and old-card preservation |
| Unsupported combinations | Sol 6.1 Ultrafast remains unavailable; no generic 6× fallback; future/unknown tiers explicit; tool charges not multiplied as token costs |
| Speed evidence | Standard → Fast → Ultrafast → clear; omitted/conflicting fields; actual served tier versus requested tier when available; per-turn override; config-time boundary; resume/fork lineage; out-of-order/repeated records |
| Money versus allowance | Astra Standard-equivalent $1 maps to $6 API-equivalent and 8 units of the documented included-usage weighting; supported Fast maps to $2 and 2.5 separately; never 48× or a double premium |
| Conservation and history | Live/indexed/export/server parity; token/cost totals and unknown/excluded counts; reparse unchanged histories when needed; interrupted/resumed repair; no duplicate attribution or lost evidence |
| Plans | All four current personal-plan identities; unknown plan; account change; unchanged Pro identity/history with updated expected ratios; existing reset/account/plan boundaries; future-dated/stale evidence; frozen promotional variants retain their meanings |
| Fits/publication | Existing scalar and composition account/plan/reset isolation; sparse/new cohorts withheld; existing 25pp and uncertainty gates; preserved published history, legacy basis reads, new basis labels and no-fit state |
| Transport/storage | Old/new prepared sets, checkpoint/cache versions, frozen v0.2 projection, v1/v1.1/v1.2 round trips, consent/write floors, typed/effective readers, database migrations only where required |
| Dots | Exempt conversation versus counted delegated task; existing task continued by dot; ordinary subagents/automation remain counted; unresolved source not declared free; mixed intervals and no quota-observation rewrite |
| Performance | Sol 6.1 recognition; independent mode cohorts, route/worker/schema validation, counts/percentiles and unknown exclusions; three-mode prewarm/cache bounds; no cross-mode stale snapshots |
| Displays | Values above 2.5×; four plan cards/filters and model order; all locales; 320–390px/desktop layouts; keyboard/accessibility, tooltip units, share image/clipboard/download and old-cache reload |
| Desktop windows | Weekly-only Pro/Pro Max, retained historical five-hour data, Spark window, saved tray preferences, notification freshness/reset rules and offline behavior |
| Operations | Versioned server package alignment, bounded D1 backfills and interrupted publication; real PostgreSQL tests for its candidate lane; deployed cache-busted website/API consistency and installed Electron behavior as separate checks |

Start with direct owning test files: pricing/catalog/tier semantics, speed
precedence, checkpoint/index/cache, plan attribution, calibration, timing and
performance, public allowance/cache views, localization, share cards and tray
behavior. Then run the maintained owning gates from the implementation base:

```sh
pnpm run telemetry:check
pnpm run telemetry:browser:check
pnpm run telemetry:upload-schemas:check
pnpm run i18n:browser:check
pnpm run i18n:electron:check
pnpm run architecture:check
pnpm run codex:contract:check
pnpm run product:ui:test
pnpm run product:local:test
pnpm run product:release-site:test
pnpm run product:worker:check
pnpm run docs:check
pnpm run test:preflight
```

Run the broader root/shared gate when the integrated semantic changes are ready.
Use the current Electron release/candidate runbook for artifact and installed
checks; this stale worktree's old native build commands are not the implementation
target. Generated admin assets require their owning generator/check, and Worker
workspace packages need their existing synchronization guard.

## Audit verification and remaining evidence

Completed read-only source probes on the exact audited main:

- Sol 6.1 is absent from reviewed identities and price cards.
- Ultrafast normalizes to `other`; the effective-mode fallback assumes Standard;
  direct Ultrafast weighting reports unknown. Astra's current Fast ratio is 2.
- Ultrafast card validation and the performance filter reject the new mode.
- A v1.2 usage row with Sol 6.1 / Ultrafast passes bounded-token validation, but
  a v1.2 quota row with `promax` is rejected.
- Two unchanged `pro` observations across the proposed change date form one
  era; distinct explicit continuity signals produce two.
- The checked-in Codex ledger check passes by itself. Comparing it with pinned
  current upstream source fails on the changed `pro`/`prolite` display names
  and added `promax`, proving that internal consistency is not current parity.
- The installed-binary contract check in this environment finds no available
  binary channel and fails `codex_binary_required`. This is an environment gap,
  not a failed implementation or proof that the new plan is unsupported.
- Public static HTML observations are recorded separately above.

The baseline probes above describe the pre-change `30c0feb` implementation,
not the current diff. Current progress and local verification are recorded at
the start of this document. Still required for the corresponding release claims:
installed model/tier/plan contract; content-free dots and pool-attribution
runtime samples; environment-specific migration and historical-repair rehearsals;
protected retained R7 requalification; and installed Electron, server and website
deployment qualification.

This work used synthetic fixtures and public documentation/source/HTML. It did
not run paid model tasks, inspect private session content, mutate provider
settings, regenerate retained R7 receipts or write to production. Documentation
and preflight checks qualify repository hygiene, not a product release.
