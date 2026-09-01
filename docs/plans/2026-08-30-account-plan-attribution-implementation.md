---
title: Account and plan attribution implementation after red-team review
date: 2026-08-30
type: plan
status: implemented-merged-pending-qualification
---

# Account and plan attribution implementation

## Boundary and verified baseline

The owner requested local end-to-end implementation after review of the
2026-08-30 account-plan-attribution red-team report. The implementation baseline
is the verified `origin/main` revision at investigation time,
`c111fded0da1fd58d90b1f87be5d57afeebf133b`.
The earlier plan investigated `b7112217`; its source inventory is historical,
not the current implementation baseline. Five unrelated web edits remain
untouched in the original checkout. Implementation is committed on the isolated
`codex/account-plan-attribution` branch: `f57dab81` contains the product changes;
`be8e8f5d` adds the test-only cancellation-observer correction described below.
The implementation-checkpoint documentation records those results without
changing product code. PR #94 later merged into `main` as
`20f449ff5c222989029fe343f219f02b497ae1d4`; source merge does not close the
empirical, protected-R7, installed-artifact, migration, consent, deployment, or
release gates recorded below.

This document owns the implementation decisions and progress. It is not a
deployment, installed-artifact, privacy-erasure, or release receipt. Local tests
may use synthetic content-free inputs only. Deployment, remote migrations,
real uploads, changing existing consent, production signing, R7 regeneration, installation
and publication require separate authorization.

Keep the intentional Pro-equivalent normalization unchanged: Pro × 1, ProLite × 4,
Plus × 20. Missing account identity alone is not a reason to discard useful
history. Preserve the original accounting ledger and schema-11 retained evidence.
The expected first benefit is plan-era separation and honest conditional
estimates, not provider-authoritative account billing.

Current authority remains [the documentation index](../README.md).
The submitted review and original plan remain review inputs; decisions below
resolve their implementation ambiguities.

## Frozen decisions

1. Recover usage plan only from admitted exact same-record quota occurrences:
   source, offset, ordinal and observation time, within the published membership.
   Never borrow a canonical quota winner or require per-row generation equality.
   Conflicting known plans remain conflicting, not last-write-wins.
2. Build the chronological conflict/continuity index from **all admitted quota
   evidence**, including zero-token records, before any fitability, requested
   duration, plan or display filter. Then classify quantity intervals; then
   select the population; finally choose one qualifying fragment per reset parent.
3. Represent Pro → Plus → Pro as distinct plan eras even when a reset repeats.
   Equal-time conflicting plans are unordered. Missing plan alone does not
   establish a switch. Account context partitions must not merge positively
   distinct accounts.
4. An interval's historical lower bound is the previous retained same-session
   counter record, otherwise the previous same-source record, otherwise unknown.
   Do not infer causal order from file-discovery order. Clock reversals and
   ambiguous cross-source order remain unavailable. A switch invalidates only
   quantities whose supported interval crosses it, not all later quantities.
5. Partition candidate quantities into compatible, positively incompatible and
   unresolved. Positively excluded other-account usage does not poison account A.
   A scoped primary requires zero incompatible **included** quantity and zero
   potentially contributing unresolved quantity. A linked subtotal is not a full
   quota numerator. Coherent legacy history remains primary-conditional.
6. Preserve existing fit gates, pricing, percent movement, cohort weighting and
   one-vote semantics. Plan-selected headline, history, comparison range, forecast
   and share card must use the same selected eligible reset population.
   Preserve diagnostic fragments. Choose one fragment per parent after population
   filtering, by greatest observed span, then point count, latest end and stable key.
7. Hosted allowance and the new model-composition lane share pre-fit attribution
   evidence and compatible source selection. The existing single-plan composition
   contract may refuse positive mixed-plan bins without inventing additional
   participants. Multi-cohort composition presentation is a separate enhancement,
   not permission to count one participant repeatedly.
8. Pin an analytical winning-device vector once per comparison domain and use it
   for quota and usage. Prefer analytical evidence, with explicit session-only
   fallback. Never put device identity in a legacy reset parent. Revalidate input
   fingerprints before publication; do not add one query per usage row or era.
9. Reuse the existing owner-only account-observation root for purpose-separated
   prospective export identity. Derivation accepts a leased buffer, canonical
   destination and authenticated enrollment namespace; it cannot create a secret.
   No cross-device equivalence is asserted. Unknown root/history continuity
   preserves local totals and cannot double an export.
10. Bracket quota capture with compatible account observations. Clear provisional
    rollout markers on logout, read failure or disagreement. A future marker never
    labels an earlier event. Brackets/markers remain provisional, not exact-source
    proof. Existing v1 identity vectors remain unchanged.
11. A stronger contribution format requires a closed successor contract, explicit
    reconsent and a persisted admission floor on every enabled ingestion path,
    including dormant v0.2 if re-enabled. Auth credential renewal (including the
    180-day pairing cycle) is not identity rotation. Reconciliation must be automatic.
12. Extend existing day/history reconciliation and the existing publication
    singleton rather than creating competing protocols. A first manifest uses a
    null predecessor plus an observed legacy-corpus fingerprint. Pre-manifest
    input stays legacy until a complete replacement closure is verified.
    Cross-format joins require an explicit semantic compatibility proof.
13. Preserve owner-managed erasure and synchronous analytical withdrawal.
    Disconnect/revoke does not erase previous uploads. New consent copy must say
    that truthfully. New identity, candidate and generation state must participate
    in owner erasure, tombstones and deletion-safe restore. No self-service erasure
    route is to be restored incidentally.
14. Persisted-format rollback needs a tested, audited owner operation with explicit
    confirmation. Lowering an upload floor must not silently strip attribution,
    reactivate deleted inputs or change comparison-domain compatibility.
15. Do not introduce finer public account/era cells or identifiers, or a new blanket
    minimum-cohort exclusion. Preserve existing public plan/model policy. Review
    stronger linkage through explicit consent without publicly exposing account counts.

## Red-team disposition and implementation traceability

“Accepted” below means a design decision, not a passing implementation receipt.

| Finding | Accepted response | Work package |
| --- | --- | --- |
| RT01 | Re-pin baseline and owners to c111fded; isolate original WIP. | P0 |
| RT02 | Preserve owner erasure; disconnect is not withdrawal; disclose in consent. | P5 |
| RT03 | Include current per-model composition and cache invalidation. | P3 |
| RT04 | Park five pre-existing web files untouched. | P0 |
| RT05 | Native prerequisite authority is root guidance/README, not invented runbook text. | P6 |
| RT06 | Scan only affected attribution partitions; preserve bounded operation. | P1, P4 |
| RT07 | Explicit quantity gate; legacy-conditional remains useful. | P1, P3 |
| RT08 | Bound historical cumulative intervals locally; never global poisoning. | P1 |
| RT09 | Shared pinned device selection, domain continuity, query-cost tests. | P3 |
| RT10 | Null bootstrap predecessor and complete legacy replacement proof. | P5 |
| RT11 | Reuse root; loss creates unknown continuity, not a fresh duplicate export. | P4, P5 |
| RT12 | Automatic re-pair reconciliation; distinguish credentials and identity. | P5 |
| RT13 | Audited, authorized compatibility-floor rollback code and tests. | P5 |
| RT14 | Join only with an explicit compatibility proof, not wire equality alone. | P5 |
| RT15 | Conflict analysis precedes fit filters and fragment selection. | P1, P3 |
| RT16 | Extend existing fit keys, publication singleton and reconciliation. | P2, P3, P5 |
| RT17 | Same-baseline before/after fixtures; isolate attribution from fork/pricing changes. | P6 |
| RT18 | Existing public cohort policy preserved; no finer public identity cells. | P3, P5 |
| RT19 | Include transition miner and duplicated daily device selector. | P1, P3 |
| RT20 | Local and hosted legacy correction first; full protocol rollout remains distinct. | All |
| RT21 | Shared admission floor protects every enabled ingestion endpoint. | P5 |

### Regression entrypoints for review

| Boundary | Retained tests |
| --- | --- |
| Plan eras, quantity coverage, single-plan numerical preservation | [Pure attribution](../../test/plan-attribution.test.js), [transition miner](../../test/transition-plan-attribution.test.js), [weekly selection and diagnostic distributions](../../test/weekly-calibration.test.js) |
| Published occurrence membership and unchanged/restarted source reads | [Unified reader](../../test/local-unified-accounting-source.test.js), [attribution projection](../../test/local-unified-contribution-attribution.test.js), [bounded full-corpus stream](../../test/replay-safe-accounting-corpus-stream.test.js) |
| Plan-selected local UI and reviewed opt-in | [Plan selection](../../apps/web/test/allowance-plan-selection.test.mjs), [browser consent](../../apps/web/test/attribution-contribution.test.mjs), [local HTTP composition](../../apps/local/attribution-contribution.test.mjs) |
| Closed contracts, root continuity, replay and interrupted transfer | [Successor contracts](../../test/contribution-v11-contract.test.js), [real local dispatcher](../../test/contribution-v11-local-sync.test.js), [resumable transport](../../test/contribution-v11-sync.test.js), [pairing client recovery](../../test/contribution-device-repair.test.js) |
| Pairing/renewal races, crash recovery and manual/background bypass | [Real local HTTP repair lifecycle](../../apps/local/device-repair.test.mjs), [controller and companion routes](../../test/contribution-v1-companion-routes.test.js) |
| Hosted consent/floor, erasure, private export and repair | [Successor lifecycle](../../apps/worker/test/telemetry-v11.spec.ts), [device authentication](../../apps/worker/test/device-auth.spec.ts), [dormant v0.2 HTTP admission](../../apps/worker/test/account-scoped-http.spec.ts) |
| Atomic domain replacement and all analytical consumers | [Domain activation](../../apps/worker/test/telemetry-v11-domain.spec.ts), [source selection](../../apps/worker/test/telemetry-v1-source-selection.spec.ts), [publication fencing](../../apps/worker/test/analytical-publication-fencing.spec.ts), [community allowance](../../apps/worker/test/community-allowance.spec.ts) |
| Bounded deletion and schema readiness | [Every-table deletion query plans](../../apps/worker/test/deletion-cascade-indexes.spec.ts), [release rehearsal](../../apps/worker/scripts/release-preflight.check.mjs), [staging probe](../../apps/worker/scripts/staging-readiness.check.mjs) |
| Shipped module closure | [Native bundle](../../test/macos-app-bundle.test.js), [standalone export](../../test/export-tibotattle.test.js) |

## Work packages and acceptance gates

- [x] **P0 — Baseline/design.** Verify remote revision and review source changes,
  preserve unrelated edits, resolve numerical and lifecycle defaults.
- [x] **P1 — Local evidence and numerator.** Occurrence hydration plus interval
  bounds; shared pure era classification; both miner entrypoints and every compact
  codec/corpus path; all quota-only conflicts retained; ledger conservation.
- [x] **P2 — Local product population.** Preserve plan/era/provenance through
  bounded DTOs and cache validation; selected-plan medians/history/share/forecast;
  quiet coverage states; no fabricated account-specific certainty.
- [x] **P3 — Hosted legacy correction.** Shared device selector; quota and usage
  use one pinned domain; plan-era numerators; composition safeguards; source
  arbitration and existing publication invalidation; normalization unchanged.
- [x] **P4 — Prospective evidence.** Bracketed collection and marker invalidation;
  typed purpose-separated identity; root/home/loss and enrollment semantics;
  synthetic failure, clock, replay and compatibility tests.
- [x] **P5 — Consented transport/lifecycle.** Closed successor schemas and mirrors;
  server capability/reconsent/floor; complete candidate activation/bootstrap;
  credential renewal/re-pair reconciliation; owner erasure and audited rollback.
  Implement and rehearse locally; do not enable or deploy without authorization.
- [x] **P6 — Local integration and evidence.** Public-path regression matrix, privacy,
  boundedness/query costs, same-baseline preservation comparison, owning suites,
  architecture/docs gates, rendered browser checks and isolated native test bundles.
  The separate empirical, protected-R7 and installed-release gates below remain
  open; executing the local gates is not a release-readiness claim.

### Mandatory numerical and preservation cases

Single-plan legacy output must remain equivalent within existing arithmetic
tolerances. Disjoint Pro/Plus and Pro/Plus/Pro must keep useful clean eras. Tied
cross-plan quotas and short/zero-token conflicts must be visible before fit
filtering. An account-A numerator excludes positively known B, but cannot present
20 linked + 80 potentially A as a complete 20. Multiple quota slots cannot duplicate
usage. Cumulative boundary ambiguity stays narrow. Canonical collisions and
copy-forward generations use the correct occurrences. Synchronous/cooperative
miner and compact/full-history paths must agree. Fragmenting a reset must not
multiply its vote. All-data diagnostics must not silently become a pooled primary.

### Mandatory lifecycle cases

Old client/retry/alternate-route/re-pair cannot bypass grant/floor. Complete
replacement is atomic across the comparison domain, including first manifest,
partial arrival, out-of-order retry and source corrections. Credential renewal
does not change an established comparison namespace. Root loss preserves local
ledger and avoids a second independent hosted vote. Concurrent ingest/delete
invalidates candidates before publication; owner erasure is immediately respected
by old caches and rollback. Public payloads contain no local account keys.

## Validation and delivery record

Run focused public-entrypoint tests first and the Worker separately using its own
lockfile. Broaden to root/shared suites for shared contracts, architecture checks
for facade changes, and docs/preflight for maintained references. Use synthetic
fixtures, never private raw sessions. Do not regenerate R7 during iteration.

Record exact commands and outcomes here as work completes. A source/test result
does not establish a deployed service or installed dogfood. Do not check a package
complete when only its proposal, helper or happy path exists.

### Additional implementation-review findings

The independent plan-completeness pass exercised public entrypoints rather than
treating isolated helpers as end-to-end proof. It found and drove these changes:

- **Legacy v0.2 preservation:** an active successor selects a participant-wide
  analytical source, so even disjoint v0.2 dates could otherwise disappear.
  Effective capabilities and consent/floor guards now refuse that upgrade;
  activation independently refuses it until a semantic replacement adapter is
  proven. Existing v0.2 fits remain selected and unchanged.
- **Real re-pair path:** the ordinary pairing client now handles the server's
  explicit continuity-required response. A leased old credential derives a
  purpose-separated retry-stable replacement; the local secret changes only
  after an exact server receipt. The server preserves device, enrollment,
  consent and staged history. Lost acknowledgements and a subsequently lost
  pairing code are recoverable with fresh same-owner social proof and only the
  current or immediate journaled predecessor. Older, revoked, cross-owner and
  deleted identities cannot recover through that path.
- **Credential-use coordination:** pairing, reset, upload and credential-bearing
  capability/review reads share local exclusion. A closed `device_repair_required`
  pause is persisted before remote rotation, survives ambiguous receipt/CAS
  failures and restarts, and cannot be cleared by ordinary approval or manual
  resume. Only validated repair completion re-arms delivery. Monthly renewal
  uses the same pause and requires its renewal-hint write before scheduling a
  fresh pass, avoiding both old-bearer retries and rotation-only retry loops.
  This pause affects contribution, not local indexing or retained history.
  The visible repair flow also separates repairing credentials from approving
  a contract: exact-current successor consent resumes without racing a redundant
  review; stale successor consent repairs first but still needs a new review,
  checkbox, hosted grant and local approval. Legacy users repair their existing
  connection before choosing the successor upgrade. Actual HTTP tests retain
  the review refusal during repair and the upload refusal before fresh consent.
- **Transfer liveness:** the 60-second foreground budget no longer replays the
  first days indefinitely. An owner-only, closed, at-most-1-MiB journal retains
  a completed immutable day-manifest prefix. A fresh invocation still checks
  consent and predecessor state. Changed publications revalidate day hashes
  locally; a mismatch rebuilds the affected suffix. New calendar days can extend
  the vector. Staging never counts as acknowledged analytical history.
  Marker presence is part of the content-free projection fingerprint, so both
  marker loss and marker arrival revalidate an interrupted prefix even when the
  index itself is unchanged. Root bytes, account identifiers and markers never
  enter the journal.
- **Production occurrence membership:** offsets are JSONL record-end offsets,
  so the final complete record may equal `scanned_bytes`. No-change and resumed
  source states with complete diagnostics remain valid published membership;
  unfinished/failed source states do not. Actual cold/no-change/append/relaunch
  regressions cover this boundary in hydration and full-history calibration.
- **Artifact closure:** the new package modules are carried through standalone
  exports, local-review artifacts and native macOS bundle inventories. Native
  tests import the packaged attribution contracts and plan-analysis entrypoint;
  matching source tests alone cannot qualify a bundle missing those files.
- **Operational migration inventory:** local release rehearsal and read-only
  staging probes require the exact migrations through 0044 plus the new tables,
  columns, indexes, integrity triggers and source-selection views. A migration
  ledger alone is not treated as proof that those guards exist. Synthetic
  missing-object/column tests and disposable local migration replay retain the
  pending-migration and unknown-migration refusal gates.
  The full every-table deletion-plan invariant also found three missing
  device-leading foreign-key indexes. The indexes and exact SEARCH regressions
  were added; the generic no-child-SCAN assertion remains unchanged.
- **Fragment-selection review:** diagnostic fragments retain their fitted
  capacity, span and boundary count after losing the primary vote. The local
  full report exposes per-candidate primary-versus-diagnostic counts, medians
  and central-80-percent ranges; its Markdown renders the medians. This enables
  the requested greatest-span bias inspection. Diagnostics remain outside the
  bounded headline/forecast population; an empty distribution stays unavailable.

### Isolated preservation comparison (RT17)

The actual miner and weekly reporter at `c111fded` were evaluated beside the
changed implementation with the same synthetic single-plan fixture: 31 quota
observations, 30 priced increments, one weekly reset. All numerical transition
fields matched exactly: 30 transitions, $360 cumulative ledger, $600 allowance,
one qualifying reset, the same $600–$600 diagnostic range and unchanged validation
errors. This vector is retained in `test/transition-plan-attribution.test.js`.
Synchronous/cooperative outputs also match.

The comparison leaves `packages/accounting/`, the extraction/build owners,
and the shared calibration, rolling and composition kernels byte-unchanged from
the baseline. Mixed-plan tests independently demonstrate Pro/Plus/Pro separation,
one parent vote after eligibility filtering, narrow boundary withholding, and
unchanged all-plan ledger totals. This is synthetic preservation evidence, not
an empirical claim about every real account or the largest retained corpus.

### Verification checkpoint: 2026-08-31

Validation used Node 26.2.0 on native macOS arm64. The final complete root run
was against `be8e8f5d`; the local/browser/Worker owning runs used the same product
bytes at `f57dab81`. The intervening commit changes one test file only.

| Gate | Observed result and boundary |
| --- | --- |
| `pnpm test` | 3,382 tests: **3,363 passed, 2 failed, 17 skipped**; exit 1; 462.5 seconds. Both failures are the retained R7 provenance receipts. All skips are native-Windows qualification on macOS. |
| `pnpm run product:local:test` | 294/294 passed; exit 0. Includes the final pairing, renewal, restart and stale-consent HTTP paths. |
| `pnpm run product:ui:test` | 438/438 passed; exit 0, on the frozen final product bytes. |
| Worker `npm run check` | Exit 0: 524/524 functional tests, 179/179 operational-script tests and 27/27 workspace-package checks, plus types, endpoint checks, local migrations and dry packaging/configuration. |
| Worker `deploy:dry`, `staging:check`, `production:deploy:dry` | Each exited 0 after canonical public-asset generation. These are non-deploying checks. Staging explicitly remains `safe_unprovisioned`, `liveProof: false`, `collectionAuthorized: false`. |
| Native owning checkpoint | `pnpm run product:macos:test`: 65/65 passed. The final broad run also passed the native bundle, packaged-module, watchdog and isolated-Preview tests; no system installation. |
| Final index-observer follow-up | Entire index file 104/104; 20 repeated pairs 40/40; the final broad run also passed both observer/cancellation regressions. |
| Shared reporting preservation | Weekly reporting, pinned-baseline attribution and reporting-boundary group: 32/32 passed. |
| Architecture and mirrors | 380 production files, 1,534 imports, zero approved debt edges; browser mirror and all 20 upload-schema mirrors current. |
| Documentation/preflight | 18/18 governance tests; maintained documentation and source/configuration links valid; whitespace checks passed. |

The R7 freshness assertions and generated receipts remain untouched; only the
source-inventory assertion adds the new contract modules and schemas. The two
failures identify `workloadCodeSha256` and `workloadCodeFileCount` as stale. They
are not waived, and this is **not a green root/release gate**.

#### Cancellation-test correction, not a production locking change

The first broad run on `f57dab81` exposed an additional intermittent test failure.
Its synthetic stage observer opened the production reader with a five-second
SQLite busy wait while the exclusive writer needed that same event loop to
finish. This blocked the observer's existing two-second deadline. The unchanged
test reproduced after 12 successful repeats; a deterministic contention fixture
reproduced the old failure in 5.44 seconds.

`be8e8f5d` makes only that synthetic observer's read nonblocking and retries after
yielding. Production locks, production busy timeout, the two-second deadline,
abort timing, generation assertions, byte-identical live-database preservation
and stage cleanup remain unchanged. The new regression and the original abort
case both passed inside the final broad run, not just in isolation.

#### Dry public-asset provenance

The isolated checkout initially lacked its generated public release manifest.
The canonical `product:release-site` builder produced a manifest-verified,
21-file closure; clean-tree staging checked its source provenance against the
actual checked-out commit. All installer arguments were deliberately omitted:
`installer: null` is not an installer/signing/release receipt.

This local dry build reused the credential-free public
[social-preview PNG](https://tibotattle.com/social-preview.png), verified as
1200 by 630 pixels, 375,392 bytes, SHA-256
`4618571ce400c435aa3ab3b53d85e966848276f29e4585df4868c619ce106074`.
It does not qualify regenerated social artwork. The social-preview generator's
ordinary Chrome-profile launch was not used under the no-real-credentials test
boundary. No hosted assets or Workers were published, no remote schema was
applied, and no installed app was changed.

#### Rendered browser verification

The Browser-guided checks served the committed dashboard modules with explicitly
labeled synthetic API fixtures on loopback, not real-account data. The final
plan-selector checks used `http://127.0.0.1:8934/` and its `scenario=empty` and
`scenario=single` fixtures. Desktop was 962 by 541 CSS pixels; the narrow Spanish
check measured 391 by 846 CSS pixels after the browser's viewport/zoom mapping.

| Browser check | Observed evidence |
| --- | --- |
| Page identity / nonblank / overlays | Correct synthetic-QA title and loopback URL, meaningful dashboard DOM, no framework error overlay. |
| Console health | No warnings or errors in the checked flows. |
| Plan switching | Plus shows $85 and its own history; selecting Pro shows $2,400 and its own history/range. Historical Pro does not borrow the current Plus pace. |
| Sparse current plan | Empty Plus shows insufficient evidence, not Pro's estimate or zero. Pro history remains selectable. |
| Single-plan behavior | One selected Pro choice, disabled rather than offering a nonexistent second plan; the existing estimate remains visible. |
| Narrow layout / localization | New plan controls and attribution copy render in Spanish with no horizontal document overflow. Existing untranslated demo/forecast copy is not newly qualified. |
| Screenshot evidence | Viewport captures retain the selected Plus, selected Pro and narrow insufficient-Plus states. The Pro share card was also visually checked; no save/copy/upload action was needed. |
| Explicit repair | A separate final synthetic component check in English and Spanish verified Repair connection to validated pairing to success, without redundant review/grant/approval. Real HTTP tests separately cover stale-consent repair through a fresh grant. |

Temporary tabs and loopback servers were closed and the viewport override reset.
These checks do not qualify installed-native rendering, real provider-account
switching or an actual hosted contribution. The independent code-quality review
closed every concrete recovery finding it raised; the plan-completeness pass
also drove the preserved-history, actual-client and artifact-closure fixes above.

### Separate rollout and empirical gates

- **Identity granularity (D01):** no empirical same-login profile/workspace
  validation has been performed. Login-subject evidence is not a universal
  billing/workspace identity. No account-exact or cross-device equivalence claim
  may be enabled on the strength of these tests.
- **Coverage review (D04/RT17):** synthetic same-baseline preservation and
  adversarial mixed-plan vectors pass. A fixed real-corpus before/after coverage,
  selected-versus-diagnostic distribution and resource review remains required
  before hosted methodology activation or dogfood sign-off. No acceptable-loss
  percentage is invented to bypass it.
- **R7:** the current RC5 R7 workload-source closure completed the protected
  dual-runtime regeneration after its source freeze. All ten receipts validate
  against 359 files / workload SHA-256
  `4c3058b3453bda2696e946952d18e81310f26eb0187074d410c730e44162f1d6`;
  the reconstructed decision remains `release_open` and is not promoted by hand.
  Native UI and allocation files are outside that closure and use separate gates.
- **Hosted cutover:** 0042–0044 are source migrations, not remote receipts.
  Stronger-format writes remain staged and require explicit new consent; existing
  v0.2 history is deliberately preserved behind an upgrade refusal until a
  compatible replacement adapter is reviewed.
- **Delivery:** source validation, passing PR workflows, and the later PR #94
  merge do not establish deployment, a signed/notarized integrated release,
  updater availability, or an installed and manually verified integrated
  dogfood. Those protected outcomes remain separate from this implementation.
- **Large/continuously changing histories:** the immutable domain limits are
  4,096 days, 30,000 chunks and 6,000,000 records. A prefix that changes faster
  than it can be revalidated within repeated foreground budgets can remain
  pending. It is not truncated or declared uploaded; stable-prefix restart and
  new-day extension have explicit liveness regressions.

### Source-PR preparation: 2026-08-31

The owner subsequently authorized commit, push, PR creation and merge, with a
separate task coordinating the 0.1.17 dogfood. The isolated attribution branch
cleanly merged verified `origin/main`
`3d9055fc8e58c84f8ba71feb5deb58b52c532138` in `67223e2d`, preserving the current
native replacement validation and its regression tests. No shared checkout,
installed application, remote service or user database changed.

The dogfood coordinator then explicitly requested that this PR be prepared and
source-checked but **not merged into main or the next dogfood** until the current
installed generation is handed off. R7 must not be regenerated in this task.
The coordinator's separate Keychain-candidate receipts qualify that candidate,
not this changed attribution workload. This branch's stale R7 failures therefore
remain explicit; passing the available GitHub PR workflows cannot substitute for
the full root gate or final frozen-source R7 qualification.

The before/after real-corpus coverage review, native installed-artifact checks,
and hosted migration/activation boundaries above remain unchanged. Source-PR
readiness is not permission to upload real data or activate the new transport.

### Merge receipt and current boundary: 2026-08-31

After the held installed-generation handoff, PR #94 merged into `main` as
`20f449ff5c222989029fe343f219f02b497ae1d4`. The current release-preparation
base `3b0f2d23775c0ca1f092fe3eb48f0c3166c8461a` includes that merge together
with the prompt-free Keychain and startup-recovery follow-ups. The earlier hold
and validation record above remain historical evidence for the reviewed PR
head; they are no longer a statement that PR #94 is unmerged.

The current RC5 R7 workload-source closure subsequently regenerated all ten
protected receipts on 2026-08-31. Its closure is 359 files with workload
SHA-256 `4c3058b3453bda2696e946952d18e81310f26eb0187074d410c730e44162f1d6`;
the retained receipt test passes, and the reconstructed decision remains
honestly `release_open` rather than release-ready. Native UI/allocation changes
are outside this closure and retain separate source, smoke, and artifact gates.
The fixed real-corpus
before/after coverage, selected-versus-diagnostic distribution, and resource
review remain open before PR #94 methodology sign-off or hosted activation.
Current APIs cannot emit a complete named fit-rejection reconciliation, so no
green empirical receipt or same-login workspace-identity proof is claimed.

An owner-only diagnostic attempt on 2026-08-31 pinned the PR first parent
`a3c850360bc83c0e27bef2171aeb4a302b72f472`, merge result
`20f449ff5c222989029fe343f219f02b497ae1d4`, and fixed window
`2025-08-31T00:00:00.000Z` through `2026-08-31T00:00:00.000Z`. It failed closed
before comparison when the strict baseline scan reported
`codex_rollout_content_invalid`. The supported resource benchmark separately
stopped at `benchmark_cold_rebuild_incomplete` on both revisions. No aggregate
comparison receipt was produced, no invalid source was silently excluded, and
the empirical gate remains open.

The live Worker observed read-only on 2026-08-31 reported deployment source
`304f3d736b6f9451d32a616bf3046ea628e828a3`, which predates PR #94's
device-continuity protocol. Migrations 0042-0044, telemetry v1.1 activation, and
new consent remain undeployed and separately authorized. The signed, notarized,
installed RC4 at source `735a59ce2ec01df0e381fb1aa878c5c7a39edcd8`, build
`1023.2`, also predates PR #94. It cannot qualify this integrated source or the
planned RC5 build `1023.3`.
