---
title: Analytics oracle findings against the maintained candidate
date: 2026-10-02
type: review
status: in-progress
---

# Analytics oracle follow-up

## Scope and evidence boundary

This is local verification and repair under P0–P11, prioritized by the owner's
additional ten-finding request. The tenfold target remains deferred. Production
is unchanged; migration, activation, deployment, live experiments and publication
are separate protected gates.

The supplied [dense oracle receipt](https://github.com/adamallcock/tibotattle/blob/2df12565512d22682bdca29037b77f2b4de7c287/docs/receipts/2026-10-01-gcp-fastpath-dense-oracle.md)
uses synthetic content-free data, Node and SQLite. It is not a production or D1
observation. Local Git confirms its reported production-version source
`d43c8f92a059d9c577776f7eca8a331eb305b8a6`; the live deployment has not been
reverified. The isolated maintained candidate is `f056940f` plus the preserved
combined uncommitted changes. Individual results below pin their exact inputs;
HEAD alone does not identify that candidate.

## Maintenance pause — October 2

The owner requested a pause. [The checkpoint](../receipts/2026-10-02-analytics-maintenance-pause.md) supersedes the working readout below: terminal v4 retains4 PASS/3 FAIL; the two fixture repairs and B1 pure integration are verified, while v5/shared-proof/B2 remain off-tree. All agents stopped and the last native group was reaped. No production mutation occurred.

## Current readout — October 2, 12:02 UTC

The second inventory query was rejected after the unchanged full101-day D1
comparison. It preserves exact outputs but raises bounded scalar reads to
142,921,409 (native13,214,413), and bounded model reads to18,517,998
(native11,967,550). The previous bounded baseline was87,189,461 scalar and
11,168,731 model reads. The182 repeated inventory statements alone read
119,195,167 rows. All3,256 inputs remained equal, with valid physical metadata,
no timeout/truncation and the owned group reaped. Receipt
`/private/tmp/2026-10-02-dense-inventory-header-days-qualification/dense-native-3.receipt.json`,
SHA-256 `76beffe61a401731add307becfa51146fd4dc72d8e62f5a86522c0cc07350acf`.
Only that unqualified source query was reverted to exact originala1535f2a;
all additive controls and failed evidence remain. The next reviewed direction
captures exact native inventory/digests once inside a genuinely attached,
covered, short-lived maintained context and freshly checks its full capability,
mutation, expiry and target fences at every existing boundary. No performance
qualification is claimed for this design yet.

Two inventory fixture repairs are integrated: native typed v1.1 requires the
actual complete UTC predecessor vector, and the corrupt-header control now
checks exact sibling rows rather than a trigger-inclusive change count. Their
focused qualification is pending. The strict original inventory read bounds
remain unchanged and unqualified on the restored query.

The attempted owner-scoped ledger repair reports2 PASS /3 FAIL under3,284 equal
inputs. The original unrelated-survivor assertion still fails only on
seal.sourceStamp; its facts, revision references and other seven seal fields
remain exact. Native terminal delivery synchronously advances public authority;
a second selective source-state trigger globally invalidates that transition.
Both selective trigger paths need a reviewed repair while preserving native
public authority and conservative unknown-owner/retention refusals. A synthetic
erased-state setup also correctly hit the native storage_owner_erased guard;
the replacement fixture must use real physical erasure. Receipt
`/private/tmp/tibotattle-terminal-scoped-ledger-five-1790941679122-46935.receipt.json`,
SHA-256 `f50aa465430f03137c9cde2a4d34b4167e8816387511b4cd6f967f639f695f67`.

The shared466-source/T orchestration and B1 phase-evidence integration are now
local code. The actual owning launcher checks pass53/53 and the Node-only phase
and existing strict-v2 controls pass26/26. B1 preserves all original full-output
validators, the separate approved native-clock validator, exact bind evidence,
closed independent-policy transport and default append-ACK refusal. No real SQL
policy or native whole-workload certificate has yet been produced. Dense
scheduled fairness, genuine canonical full101 acquisition, all mutation families,
1/30/365 complete outputs, capacity/restore and the final owning Worker gate
remain open. Production is unchanged; live state has not been refreshed.

## Previous readout — October 2, 11:37 UTC

The header-derived replacement inventory is adopted locally. Its ten native
controls report **8 PASS / 2 FAIL**, with 3,263 identical inputs, valid metadata,
no timeout or truncation, and the owned process group reaped. Both fixed read
bounds pass: 9-day inventory reads 18,214 versus 41,432; sparse101 reads 2,653
versus 7,811. The failed v1.1 fixture reaches TELEMETRY_MANIFEST_CONFLICT; the
corrupt-header fixture incorrectly expects one change while native trigger
accounting reports five. Both failures remain retained and require reviewed
repairs. The unchanged full101 scalar/model cost comparison remains a separate
required gate; these small results do not qualify its performance. Receipt
`/private/tmp/2026-10-02-native-inventory-materialized-header-days/inventory-header-days-1.receipt.json`,
SHA-256 `aaceb5ec61491914ba782eaf61bb170fa9a792224998713f19a18da6ff57cfe1`.

The corrected mixed-leaf prerequisite now passes 1/1 under 3,269 equal inputs,
using actual typed native v1.1 persistence. Receipt
`/private/tmp/tibotattle-cache-prerequisite-typed-mixed-one-1790938972736-94562.receipt.json`,
SHA-256 `914cf0874fc030effd180c278cd9c4d0cb30eeb8f333209d7e40a629c53c8510`.
The12 controls have passing evidence under separate pins, not one frozen12-pass
suite. The unchanged original fairness/terminal pair then reports 1 PASS /
1 FAIL under 3,283 equal inputs. Terminal work progresses within its bound;
its unchanged exact-survivor assertion fails because only seal.sourceStamp
changes. Facts, revision references and every other seal field remain equal.
Receipt `/private/tmp/tibotattle-skew-original-two-1790938672689-79208.receipt.json`,
SHA-256 `078f67117e3de36975e3a689132597fedfb9f5571365d04acb11568c418eb913`.
The source0015 ledger-update trigger bumps global policy on a native mapped
revocation. A narrow owner-scoped replacement with conservative unknown,
retention and erasure fallbacks remains off-tree; final publication fences stay
unchanged. No production observation or fix is claimed.

The root's additive C06 shared-boundary adapter is adopted: readiness probes
receive explicit test-only operation scopes and a closed block-completion
callback fires after native completion and CAS. Nine pure checks pass; original
controls remain byte-identical. Native whole-output C06 qualification, shared
466-source1/30/365 orchestration, all mutation families, dense scheduler/capacity,
restore and the final owning Worker gate remain open. Earlier results below
retain their original dates and are superseded where this readout says so.

## Finding inventory

| Finding | Current candidate assessment | Local repair or remaining proof |
| --- | --- | --- |
| 1. Conflict blocks unrelated cache preparation | **Reproduced on actual local D1.** A blocked first daily owner prevents a healthy owner's complete carry rows. Sixteen scheduled passes built no healthy marks despite an exact successful private reference. | Bounded daily continuation now passes its cap/error/replay controls and restores the healthy requested result exactly. Actual page charging now passes13 native controls and both original16-pass carry cases separately. Healthy requested/later private results exactly match native; the full conflicted cohort remains withheld. A new genuine same-owner later-date regression fails as intended: valid offset9 is absent after16 full-lane passes. Date rotation and lifecycle/high-water controls are qualified locally under their separate pins. Both original16-pass carry cases, same-owner offset9 within16 passes and the unavailable prefix beyond maxDays12 within32 passes now pass all exact native/public/authority assertions. The original combined sparse/old/history cases now pass (roles1/5/24); terminal-survivor exact seal preservation remains open after bounded progress succeeds. |
| 2. Crossed-day conflict stays queued | **Native refusal is still intentional.** Retained timestamp variants conflict even after a later generation appears corrected. No source has been elected by version rank. | Prove genuine admission/requeue and retained refusal. Do not manufacture empty evidence, discard retained variants, exclude an owner or treat an incomplete producer as complete. Availability of later unaffected work must be measured separately. |
| 3. Dense cache work exhausts its pass | **The current genuine6,402-record builder case completes.** Native computation finished in13 calls; the shared day-size refusal fell back and produced the same result by call21. | The largest invocation used430/950 statements. This disproves permanent starvation at this component density; full scheduler and450,000-record qualification remain open. |
| 4. Shared window exceeds 8 MiB | **Confirmed on genuine accepted101-day frames.** Full bundles total18,142,563 bytes; compact consumed features total2,197,450 bytes. Bulk refuses and native scalar/model fallback is exact. The strict corrected fixture passed with exact native capacities and null `other`. | The bounded default consumer passes the same genuine101-day corpus: nineteen complete acquisitions, zero fallback, exact native outputs, max854/950 and2,615,898 retained logical bytes. Model4→1calls improves; scalar11→18calls regresses because repeated compact acquisition remains. Scalar checkpoint reuse now passes the unchanged101-day positive: 9calls/6991statements versus native11/7941. Reads87.18M and wall22.251s still regress versus native12.60M/14.905s. Genuine committed-format6 loss and accepted-source-change controls now pass; the separately pinned outer-write/fresh-readback case also passes; dense attribution identifies repeated inventory as84.15% of extra reads; read-cost reduction remains open. |
| 5. Each page repeats owner-wide expansion/proof | **Reproduced and repaired in v1/v1.1 and v1.2 on actual local D1.** Unrelated owner history increased page acquisition/proof work. | Reached-chunk/indexed expansion preserves exact records, order, cross-day conflicts, retained variants and foreign exclusion. v1.2 scaling passed with 6,118/6,345/6,584 reads; its existing reader file passed 6/6 separately. This is component evidence, not whole-runtime speed. |
| 6. Planner chooses manifest/stream without statistics | **Confirmed on actual local D1.** At512 outside chunks, no-statistics singleton/batched reads are52,537,219/53,431,167; analyzed reads311,848/1,103,597. Exact source dependencies and data/schema fingerprints remain equal. Production statistics remain unknown. | The original additive bound failed as intended. The repaired component passes with210,109 singleton/731,686 batched16 reads at512 chunks and exact unchanged digests/exclusions/plans. It uses existing indexes; five selected owning dependency controls now pass under both direct modes; the complete owning gate remains. No production `ANALYZE` or new index is proposed. |
| 7. Daily pages/attempts hold up later days | The 50-row native fold remains. Current runtime yields deferred days within a pass and has old/recent selection; maintained activity uses separate partition work. | Reproduce progress/fairness at the actual fallback density. Increasing a page or attempt count alone does not qualify the full budget. |
| 8. Query exhaustion becomes collection-control failure | **Already fixed in the candidate; two actual-D1 regressions passed.** The reported production-version catch converted the budget exception to a 503. | Preserve budget exhaustion as a resumable deferral; a genuinely missing controls table still refuses with 503. Ten additional real-meter reader boundaries now propagate the recognized budget exception, while two original unavailable/redaction controls remain exact. |
| 9. Unfinished feature claims wait 60 seconds | **Reproduced and repaired on actual local D1.** Failed save with 40 real statements remaining left the lease live. | Guarded same-head release and branded final-statement reservation passed 17 controls, followed by four schema-race controls after a test-only trigger-restoration fix. The original failed run remains retained. Original migration and source/erasure/frame guards are unchanged. |
| 10. More than 1,000 queries are refused | **Required platform boundary.** The configured scheduled allowance is 950; batching does not remove statement costs. | Reduce repeated acquisition and checkpoint work. Keep the safety cap and resumable deferral. Cloudflare currently documents 1,000 D1 queries per paid Worker invocation. |

The platform fact in item 10 was checked against [Cloudflare's D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Retained actual local results

### October 2 inventory experiment rejected at the original101-day scale

The exact unchanged101-day scalar/model positive passes under3,256 identical
inputs, with no timeout/truncation and the owned group reaped. The global-range
calendar/EXISTS query preserves outputs but regresses: scalar native14,235,155
reads versus bounded235,809,838; model native12,988,299 versus bounded30,767,022.
Calls/statements remain scalar11/7,941 versus9/6,991 and model4/3,038 versus1/808.
This supersedes the smaller9-day saving as a performance decision. Receipt
`/private/tmp/2026-10-02-dense-inventory-semijoin-qualification/dense-native-2.receipt.json`,
SHA-256 `c4e232373b4e1920ec04236e73d93a0bf724ab51bb4f3ec3431487df06789b33`.
Only the isolated unqualified query was reverted to exact sourcea1535f2a;
all additive regression controls and failed receipts remain. A cheaper indexed
or shared fresh proof is being implemented off-tree; no safety fence is waived.

The initial8 inventory controls produced4 PASS/4 setup FAIL under3,264 identical
inputs. Their9-day read gate passed20,019 versus41,432; malformed restored-store
membership and final-owner/correction races passed. Four fixture-only repairs
now use a genuine same-owner second device, a concrete legacy quota reset, and
accepted empty calendar manifests. Their rerun awaits the replacement query.

The cache prerequisite corrected-two run produced1 PASS/1 setup FAIL, with3,269
identical inputs and group reaped. Late correction now proves the native trigger's
stale private-cache deletion. The mixed-leaf successor still used a legacy JSON
writer refused by active typed admission. Its fixture now uses actual native
manifest registration, device authentication/upload authorization and typed
v1.1 persistence; the complete actual-UTC predecessor vector and every assertion
remain. Receipt
`/private/tmp/tibotattle-cache-prerequisite-corrected-two-1790937708942-56517.receipt.json`,
SHA-256 `ea4266eb424f4e84d490ea5fcf1a8163c9c0edf7520f2b02682b2d2315cce584`.
The unchanged original fairness/terminal controls are next. The6,402-record
direct builder result does not cover dense scheduled claims; that new actual-role
case is being implemented separately.

Whole-workload shared466-source1/30/365 orchestration and strict C06 attachment
are off-tree. One real seed/time/proof, exact eight output families, source/bundle
identity and all independent imports/setup/phase/cleanup costs remain required.
Pure checks do not qualify the matrix or C06. Native full-scale and all mutation
families, capacity, restore and the final owning Worker gate remain open.

### October 2 bounded cache prerequisite baseline and partial qualification

The new unchanged-source regression reaches the intended missing-child assertion:
35 metered statements/7,824 reads/zero writes, stale sealed input unchanged,
no prerequisite child. The controller initially misclassified Vitest's exact
failure-message wording; a separate read-only reconciliation preserves and
verifies the original receipts without another native run.

The adopted repair performs bounded native preparation only after the full
proof refuses the seal. Its positive uses125 child statements within300 and
164 matching physical/work statements,20,402 reads/44 writes; sealed version4→9
and source stamp change. Cache completion still defers for a later ordinary
claim and complete proof. All12 controls report10 PASS/2 FAIL,3,269 equal pins,
no timeout/truncation and the owned group reaped. Receipt
`/private/tmp/tibotattle-cache-prerequisite-repair-1790936462886-91995.receipt.json`,
SHA-256 `bc3329d0142c7cc8d852f594ba6fce6036f212bd1e52c9146e8ccb27f19bdd22`.
This component uses a synthetic target authority mirror, with source evidence
accepted through native writers; it is not ordered-delivery qualification.

Both failures are new setup/expected-transition mistakes. Migration0040's
non-noop effect trigger deletes the stale private cache marker; the test assumed
retention. Native v1.1 predecessor always includes today; the mixed-device
fixture offered only a historical day and correctly failed domain closure.
The exact native transitions and complete predecessor vector will be asserted;
no product trigger, clock, source election or public safety check is relaxed.
Original terminal-survivor16-role and combined fairness remain pending.

### October 2 whole-run provenance and retained trace refusal

The hardened launcher's40 Node controls pass. Actual cold-plus-append run1
retains3,523 identical inputs, including150 SQL files and85 installed packages
(`0d5db30e…ed71`). Candidate publication closure is reached within304 preparation
calls and133 population attempts, then PREVIEW_COUNTER_INCOMPLETE_TRACE refuses
completion. Reference, formal public timestamp validation and append are not
reached. The trace has469 native attempts,5 upserts/464 unchanged, no failed or
unknown preview writes; final row/schema equality precedes the trace refusal.
Its506,692 statements/71,887,381 reads/86,648 writes,2,380 invocations/max921
are an incomplete cold candidate slice, not whole parity or a production result.
Receipt `/private/tmp/p11-functional-append-current-1-receipt.json`, SHA-256
`30abe43ea3c276dce33fee8344da3afbcb56dde03c4ded896e8ba5188435b2f7`.

Native cleanup's three literal, unbound batch table-info reads provide a strong
static explanation: the old counter flags every PRAGMA. The failed receipt lacks
an offending-query fingerprint, so exclusive runtime causality is not claimed.
The reviewed exact-three-query classification repair is adopted with additive
controls. Both actual native cases pass under3,257 equal pins
(`9c7ab94c…5928`). Positive77 physical/profile statements,51 native cleanup
statements and max51 reconcile; the exact full preview row is unchanged.
The unrelated metadata read still refuses with INCOMPLETE_TRACE. Setup costs
and the negative case's separate numeric costs are excluded/unknown. Receipt
`/private/tmp/p11-preview-native-cleanup-metadata-1-receipt.json`, SHA-256
`ab8b6a19cf3529f7eea6da60b9b5fb18fb56df3d3dc43a2adb1e589778c1bf4a`.
Unknown metadata/text/method/bind variants stay sticky refusals. Successful proof shape, full row/schema/trigger
checks and native CAS transitions remain unchanged. Adoption receipt
`/private/tmp/2026-10-02-p11-preview-metadata-adoption.json`, SHA-256
`49a24652b61ebb35863e0221c6d115f0d3f5f1162154f4f0d7c568aad1b031df`.

### October2 actual dense query attribution

The unchanged101-day positive passes1/1 under3,241 equal actual inputs
(`11f4a320…d3b4e`). Observer and independent physical capture reconcile96,389
statements with0 observer failures. Bounded scalar reads87,189,461 versus
native12,601,979. Inventory SQL at `telemetry-usage-effective-reader.ts:1250`
costs182 calls/63,463,218 reads versus2/697,398, explaining84.15% of the extra
74,587,482 reads. Batched dependency links cost22,707,009 bounded reads; actual
scalar-page work costs1,071,423. This is query-level physical attribution.
Twenty-four post-measurement EXPLAIN statements cost24 queries/zero rows and
show the inventory's scans/materialization/correlated subqueries. They do not
attribute physical reads to individual plan nodes. Comment-prefixed/BLOB-bound
link queries lack retained exemplars and therefore lack actual EXPLAIN proof;
their measured statement charges remain complete. All source proofs, fixture,
original assertions,950 caps and900-second timeout are preserved. Receipt
`/private/tmp/2026-10-02-dense-shared-window-read-cost-draft/dense-native-1.receipt.json`,
SHA-256 `c93add4f14eeaec61ed4099c05bf7dc914b967c42b31a3a366a47e9e6cbc7812`.
Instrumented timings include collector overhead; original timings retain their
own receipt. The owned process is reaped and the lane is released. A cheaper
guard-equivalent fresh inventory proof is being investigated off-tree.

### October2 corrected terminal cause, lifetime completion and C06 mechanics

The corrected terminal-only test still fails at16, with625 equal inputs
(`810eb9b3…`). All8 mirrors reconstruct the exact native token. Other-owner
withdrawal changes only global policyStamp; old seal becomes stale, its pending
ranges remain behind the first8, and no exact canonical job appears. Original
withdrawal/erasure assertions pass. Each diagnostic costs9 statements/zero
writes under a separate meter. Receipt
`/private/tmp/tibotattle-terminal-progress-corrected-2.receipt.json`, SHA-256
`e3dc959dbb492ee01b7a0a84914bbb0cd0bad187b0de02ad8b955d632568448b`.
This confirms a fixture's source-range/canonical prerequisite bottleneck; the
bounded cache prerequisite repair remains off-tree. Original corrected-1
sandbox startup refusal has tests:null and remains an environment result.

The third genuine native lifetime case now passes1/1 under3,240 equal pins
(`4127dabd…0695`). Exact own-row count1 and returnedChanges2 precede actual
native source revision1→2; old scope rejects, fresh scope reads null and every
plan closes. Its work413/max393 statements, separate mutation55/max27 and
setup2,013/max445 are not dense/whole performance evidence. Receipt
`/private/tmp/2026-10-02-native-window-lifetime-native-4.receipt.json`, SHA-256
`fcd5e36200625ec0ba09bbb40e1d1dd83ea76a3cf6314452879fae18d32fead6`.
The prior2 native positives retain their own pins; no coherent3-pass run is
invented. Native-3's genuine race failure used the old private pin where the
native contract throws; the final audit now asserts that exact refusal and
independently captures the fresh scope. Source/publication guards are unchanged.

C06's original positive passes1/1, with3,241 equal pins (`e85e8415…`),3roles/
681 statements/39,949 reads/470 writes/max614 and zero measured failures.
411 source calls reconcile; their consumer labels remain unclassified, so no
C06 no-rescan or public output certificate is asserted. Receipt
`/private/tmp/p11-c06-counter-runtime-positive-1/receipt.json`, SHA-256
`9f870728c4ebd49bbb37cbb901805120fcdc24b4c946535982693b5909ee5a00`.
The neutral type-cycle repair preserves byte-exact type definitions and storage
facade exports, changes no runtime SQL, and passes architecture716/3,207/zero
debt plus actual Worker TypeScript. Complete owning gates remain open.


### October 2 combined fairness, diagnostic correction and lifetime controls

The original combined sparse and retained/history cases now pass at roles1/5/24;
the original terminal case still fails at16. Its 625 actual inputs stayed equal
(`74559dc7…`); receipt `/private/tmp/tibotattle-terminal-diagnostic-1.receipt.json`,
SHA-256 `bac847ae8d4d011d210bb393f2254354aaabaf43ff9311e4e0c01c1c724cc622`.
Withdrawal and physical erasure complete, and the native input seal is unavailable.
The receipt's older stamp comparison used the wrong usage/session token scope;
that field cannot establish a source-stamp mismatch. Corrected read-only probes
verify the producer's exact token before classifying components. Source-trigger
review suggests global policy invalidation, but the runtime cause and range/job
continuation remain unconfirmed pending those probes.

The genuine native lifetime suite reports2 PASS /1 FAIL with3,240 equal inputs
(`81653f06…ca248`). Exact nonempty native fits resume after committed format6
checkpoint loss; accepted source arrival refuses stale promotion and closes the
plan. The third case reaches graph INSERT, then its own observer assumes changes
exclude trigger writes. Mutation/readback assertions are not reached; the actual
returned count was not serialized and is not invented. Receipt
`/private/tmp/2026-10-02-native-window-lifetime-native-2.receipt.json`, SHA-256
`cc943d9d5085bb8132d30602280742aa6ef42f8e95b6d2454a91f11fd8119012`.
Prior1 PASS /2 FAIL is retained. No product lifetime fix is inferred from a
measurement failure, and no scalar performance claim is made.

C06 native mechanics remain3 PASS /1 FAIL: a successful installed optional
observer did not initialize its zero-failure field. The reviewed tooling change
retains the exact zero assertion, real throw/incompleteness controls, sticky
failures and unknown absence without an observer. Its owning Node13/13 and actual
Worker typecheck pass, with3,043 equal inputs (`70d438ff…04a5e`). Actual C06
positive and complete certificate remain open. Direct documentation/hygiene and
20 preflight controls pass. No production or remote state changed.


### October 2 completed cache component and owning fairness checks

The reviewed prefix repair passes all 28 cache component cases, with 549 equal
actual inputs (`74eccd59…`). The original hinted retry reads 1,212 rows in
16 statements versus 1,789/23 for the ordinary retry. Genuine split-leaf receipt,
both date-index seeks without temporary sorting, index loss, source change,
erasure, lease and global public-series refusal all pass. The two intended
baseline failures and first 25/28 repair failure remain retained. Receipt
`/private/tmp/tibotattle-cache-prefix-draft/source-qualification-2-receipt.json`,
SHA-256 `a49588ddfbf2ff9561d30c1738b605d213ecc639b994873b7c0a786ea9a5dcdc`.

All four owning carry/date cases pass with 726 equal inputs (`3c4cb840…41ed5`).
Both unchanged original 16-pass shared cases, the new same-owner 16-pass case,
and the new 32-pass prefix beyond maxDays12 reach every native/private/public/
authority assertion. Receipt `/private/tmp/p11-cache-date-owning-qualification-1.receipt.json`,
SHA-256 `c6fda719fb99d651de345f510b5191a941a3677484b5e8c80b2f7d6530fdd0c9`.
The four corrected cursor cases pass separately with 736 equal inputs; receipt
`/private/tmp/p11-cache-date-cursor-controls-fixture-v4-1.receipt.json`, SHA-256
`9df4a62d9cb38beb819a3fdd3bd969d319dee5820565f1e73df768812f35f86d`.
Prior eleven cursor controls and three physical controls keep their original
receipt boundaries. Combined scheduler/terminal progress and final owning gate
remain open. Production is unchanged.

### October 2 scalar checkpoint and date-cursor integration

The unchanged genuine 101-day scalar checkpoint positive passed with 3,237
equal actual inputs (`f22d4128…b2268`). Scalar default/native costs are 9/11
calls, 6,991/7,941 statements, 87,183,715/12,601,061 reads and 22.251/14.905
seconds. Model default/native costs are 1/4 calls, 808/3,038 statements and
2.408/11.123 seconds. Outputs are exact; the scalar read and wall regression
prevents an overall speedup claim. Receipt
`/private/tmp/2026-10-02-bounded-shared-window-scalar-positive-native-1.qualification.json`,
SHA-256 `051e15d6c7bca4b21a286c3739bd75d7c91aa8945576932a8a741439751f475c`.
The 22 off-tree checkpoint-classifier controls are test doubles. Genuine native
checkpoint/source-change/lifetime controls remain unrun.

The applied date-cursor native suite reports 11 PASS / 4 FAIL with 736 equal
actual inputs (`45052455…d03e3`). The failures are fixture setup refusals before
scheduling assertions: missing deletion-ledger initialization and incorrect
coverage of the native activation predecessor. All 15 bodies, budgets and
deadlines are retained; a fixture-only correction is prepared. Receipt
`/private/tmp/p11-cache-date-cursor-controls-1.receipt.json`, SHA-256
`7775bb48a39fac5e8851d6323e8a093c6b9385e7830a47e183e06c708ccefe82`.
The positive native cases include empty-table logical high-water preservation,
missing/lowered proof refusal, fence UPDATE replay and owner DELETE protection.

The separate physical restore suite passes 3/3 with 507 equal actual inputs.
Receipt `/private/tmp/p11-cache-date-physical-controls-1.receipt.json`, SHA-256
`292ec3a0d35ae79bc7eba4f68b09da4571464181a387bb13fe2cd88f4ae10012`.
The typed expected-schema check passes separately. Current schema inventories
contain 86 new tables, including the numeric date cursor. These component proofs
do not close the original same-owner fairness failure or populated restore gate.

The latest bounded role observations show the retained and hot dates belong to
the same owner. Its generation-3 old leaf has an exact prepared receipt, while
later missing slots keep global repair pending. Generation 4 correctly makes
that old leaf stale at role 16, and replacement features finish only at role 32.
A day-prefix repair is prepared off-tree; its additive failing controls remain
unrun. The terminal survivor lacks current input sealing; its exact source cause
remains unknown. No source guard is weakened to turn either failure green.

### October2 same-owner baseline and dependency owning controls

The genuine later-date baseline fails at the original16-pass boundary: offset9
is absent, despite accepted2..8 native carry and an exact successful private
reference before execution. All725 inputs stay equal (`ababe643…ab7a`), no SQL
or profile gaps; total6,749 statements/658,210 reads/3,233 writes, max333/950.
After the first eight aggregate builds, each remaining pass repeats a refusal
in59 statements. Receipt `/private/tmp/p11-cache-date-fairness-baseline-1.receipt.json`,
SHA-256 `d9acf244cbbe112b94b5325f5f0429f55ed944cea85ea22948636f25f8a03f8a`.
Later output/public/authority assertions were not reached; this is a failing
baseline, not a completed repair.

The three selected original dependency titles cover5 controls: v1.2 accepted/
revoked social generations and mixed version/session/correction exact digests
in both direct modes, plus staged/late cross-day links. All5 pass; all600 actual
inputs stay equal (`87f7e12a…79825`);99 unselected controls remain for the owning
gate. Receipt `/private/tmp/2026-10-02-dependency-owning-repaired-1.receipt.json`,
SHA-256 `2e7ebcf637b2d33ede51b459cb0a8a122fe7bfe329434af1bdc8b6f1070aca77`.

### October2 bounded default window and rolling/scheduler follow-up

Bounded-window default positive passed1/1 with3,237 unchanged actual inputs,
SHA-256 `738b36a0705cde3e3fc4e93af687438ecba781fcc79f6af977e111bd492b6bd2`.
Receipt `/private/tmp/2026-10-02-bounded-shared-window-default-positive-native-2.receipt.json`,
SHA-256 `29801640bfcedc2d9a319125746a119a92a99390235de757be21dbc2ed3e443f`.
All nineteen acquisitions complete/close; bulkCalls0; direct401 scalar pages
200/200/1; exact native capacities2500/900/othernull. Retained logical bytes are
2,283,716 compact plus332,182 full day (2,615,898 total); heap/CPU remain unknown.
Model native4calls/3038statements versus bounded1/808; scalar native11/7941
versus bounded18/15008. The scalar regression remains open. The first attempted
launch never reached a test because the local sandbox blocked a generated config;
its unchanged-pin startup receipt is not a product failure or positive evidence.

The owning scheduler store passed31/31 with598 equal actual inputs,
`87eb8fb3d711262a9d3ea5cd11511aaa1d4216a3f949e3f80357170b7fa670ed`.
Rolling producer controls passed3/3 under624 equal actual inputs. Its original
three-role companion remained1PASS/2FAIL: sparseAt1 and history18members/role24
now progress, but retained old-day and terminal-survivor bounds still fail.
`/private/tmp/tibotattle-rolling-policy-original-roles-1.receipt.json` retains that
failure. Stale generations cannot become current by loosening source checks;
bounded exact successor/receipt/admission diagnostics are the next step.


### October2 actual cache charging and unchanged carry controls

The actual-meter component passed13/13 with710 unchanged source/config/migration/
installed-runtime/Node inputs (`46466ea4807eed8cc2e44d11413296a2dabba19d6d6ab9aab88549fd4ada04a4`).
Nine source pages completed in194 physical statements; ordinary build/target/total
charges are165/50/194. Exact native aggregate, failure, reservation and concurrent
reuse assertions passed. Receipt `/private/tmp/p11-cache-actual-meter-controls-1.receipt.json`,
SHA-256 `69613e72f5c323cffc15dc23f9478c575874b97aa62b932a01e5748495d5ca20`.
Schema initialization, CPU and peak heap were not measured. Enclosing rejection
may charge an inner undispatched credit; the receipt preserves that distinction.

Both unchanged original16-pass carry controls passed separately. Their exact
original file SHA-256 remains `c933dd4f3350ad4f5caef701e33a713e8d8bd5938c5087678fae988c652a835c`.
Shared=false uses6,940 statements/694,154 reads/3,245 writes across setup/reference/
lane/probes; max333/950. Shared=true uses8,304 statements/933,992 reads/3,345 writes;
max256/950. These totals are not lane-only costs. Both held724 equal actual inputs,
assert requested/later healthy readiness and exact native private aggregates,
retain genuine crossed-day conflict refusal, and leave public cohorts withheld.
Receipts `/private/tmp/p11-native-carry-slice-a-owning-1.receipt.json` and
`/private/tmp/p11-native-carry-slice-a-shared-1.receipt.json` are separate. They do
not qualify same-owner later-date fairness or the complete composed scheduler.

Actual reader budget propagation passed3/3: ten real32-statement exhaustion
boundaries plus the original missing-index and private-cause/redaction controls.
All445 inputs stayed equal (`9806b3ace4f29d1cec164161c4702b73ffa5ef56c683a02cc144b4220d61edec`).
Successful log `/private/tmp/tibotattle-effective-reader-budget-rethrow-1.log`,
SHA-256 `4684a2fbc9c4de40d3dcecf3b7396b86cc3bc3348395b8e1056d9b4af7b01ba1`.
The intended failing pre-repair baseline and complete owning gate remain retained.


### October2 strict window, planner and rolling-quantum results

The corrected public model-policy assertion passed on the same genuine101-day
fixture. Native capacities are exactly `{gpt-5.6-sol:2500,gpt-5.6-terra:900,other:null}`;
bulk and all sixteen actual graph acquisition attempts still refuse8 MiB, while
scalar/model fallback exactly matches native. All3,237 inputs stayed equal
(`2351964e5cc4e5d8fad8037f113efc6ea74c8e888cc62acbcaf82bedfdb1fcbf`).
Compact receipt `/private/tmp/2026-10-02-bounded-shared-window-baseline-native-4.resources.json`,
SHA-256 `92501e637c0a5168d571848101d5759bbfcd53c7289edac9eefaa1756f514eac`.
The earlier fixture failure remains retained; no bounded-plan adoption is claimed.

The minimal v1.2 dependency repair passes its density component. No-statistics
singleton reads at1/32/128/512 chunks are1,110/13,787/52,923/210,109; batched16
reads2,999/47,203/183,972/731,686. Existing chunk/occurrence and manifest/stream/
occurrence indexes replace repeated chunk×selected-record comparisons. The final
join still proves the actual reached chunk is retained and complete. All sixteen
digests, links, staged/foreign exclusions and unchanged data/schema fingerprints
pass. All457 inputs stayed equal (`88bab93ad2aef0ad2851b63597fdb8df1d48373a354645c9097eb17e9451beb9`).
Successful log `/private/tmp/tibotattle-finding6-v12-repaired-2.log`, SHA-256
`a615042ce15f1e4c3b41bdcd817504f8cd2fc93d5d0403671fd74b77ae489f44`.
The failed first indexed repair is retained; complete owning controls remain.

The original genuine rolling request progresses with300–500 statement caps and
completes at600/900 in3/2 calls, with exact member/reader equality. The measured
calls and separate copy/probe costs are in
`/private/tmp/tibotattle-v1-rolling-budget-measurement-2.result.json`.
All548 inputs stayed equal (`ca8df41ece4e0f5631d596c0dbc9c5cc5212f2abe6b0826fda4e3c5e862509e9`).
This is a continuation measurement, not full scheduler fairness or a universal
admission-floor proof.

### October2 native cursor and dependency/window checkpoint

The cursor controls passed7/7 and the three owning daily prefix/publication cases
passed3/3 separately, each with778 unchanged actual source/runtime/Node inputs
(`0a3e66507dd85ff5525631fa5194863b59e4ffe788b0e250493e1b77f68412fd`).
The owning receipt is `/private/tmp/p11-daily-cursor-owning-1-receipt.json`,
SHA-256 `fc5143c22dafaa40d9ed16029be446412063175e631b45369b2ce4f2648467c6`.
This repairs the daily owner prefix; it does not close the original16-pass cache
carry or actual three-role fairness failures recorded below.

The genuine101-day window witness and exact native fallback are recorded in
`/private/tmp/2026-10-02-bounded-shared-window-baseline-native-3.resources.json`,
SHA-256 `9f438239795fe684b2936141c67b99385f435af59e3c3a9ff0cd8da91a16f98e`.
The complete test failed its capacity-key expectation: reviewed native model
fitting always adds the policy's `other` column. Its null-capacity contract still
needs an exact passing assertion. CPU and true peak memory were not measured.
Every operation used a real950 meter; all3,237 before/after inputs stayed equal.

The intended failing no-statistics dependency bound retained457 unchanged
actual inputs (`2a4d758cc5f8786d1dfa72cae181f7eafbc07baaeb1f432bcbb8bcc5af381957`).
Its log `/private/tmp/tibotattle-finding6-v12-failing-bound-1.log` has SHA-256
`8b48403c3a5c8de288bffbbffa23005ae4adc2108db9440b4097362cc5e50430`.
No production statistic, live performance or successful repair is inferred from
that baseline. Existing failed receipts and original assertions remain intact.


### October2 rotation, dense and real-role checkpoint

A genuine6,001-quota/401-usage input now completes the native cache builder in13
calls. Shared preparation refuses its day-row bound at call8, then resumes native
processing and finishes by21 with exact result parity. The 723 loaded input/runtime/
Node pins stayed equal (`8cdeff8f23f5aa838aeb57f9125affb204203cc2325f07d202ec523935fc7cbb`).
The receipt is `/private/tmp/p11-native-dense-baseline-1-receipt.json`, SHA-256
`544e2b923ca4891684928194d3790fb4dd0e3eb481caf0c7e76f082791cf62c5`.
Its20,139 statements include labelled setup/proof and both builders; per-phase SQL
costs were not serialized. This is a component result, not full scheduler progress.

Daily source/day rotation is now implemented, including exact per-attempt CAS,
closed installed capability, explicit native0033 predecessor, bounded cleanup,
and the same capability inside both final publication writes. Physical copy tests
passed2/2 with empty-table high-water and stale-incarnation protection. Native
cursor/prefix/final-batch controls still await the serialized execution lane.

The stage/lane store controls passed28/28, but the actual three-role rerun still
failed: sparse progress at16>12, no retained-old or native-history completion in32
roles. The sixteenth sparse role and all original bounds are retained. The 623
actual input/runtime/Node pins stayed equal (`8cfecd890c7e117040f7ab0cfe8467378f6bbc6340854006818ab8bab38a6fba`).
This prevents a full fairness claim. Consumers receive too few heavy steps, and
old anonymous logical-head recency competes with numerous fresh heads; the repair
must preserve actual source, lease, publication and950-statement proofs.

The tiny window admission retry passed1/1 after changing only invalid synthetic
49-character chunk IDs to the native42-character contract. It proves admission
and the original complete predecessor activation. The failed original receipts
remain. No window/fallback result follows from this tiny case; the unchanged101-day
baseline must run next. All3,238 loaded inputs stayed equal (`fd9e0c5d38e8bb5f22095adcce25ba00f0fa4e99b80936fa12c4fd11d579e894`).


### Reached v1/v1.1 chunks

The same requested records and exact DTOs were compared at 0, 128 and 1,024
unrelated complete chunks of the same owner. Admission/setup costs are separate.

| Measured SQL | Original reads at 0 / 128 / 1,024 | Reached-chunk reads at 0 / 128 / 1,024 |
| --- | --- | --- |
| Candidate | 7,208 / 7,978 / 13,354 | 8,016 / 8,022 / 8,022 |
| Sparse expansion | 450 / 1,474 / 8,642 | 466 / 468 / 468 |
| 200-ID expansion | 9,624 / 12,696 / 34,200 | 11,642 / 11,648 / 11,648 |

Base cost increased; the history-dependent growth fell to 6, 2 and 6 reads at
1,024 unrelated chunks. This is neither a constant complete-reader claim nor a
whole-workload/production speedup. The successful four controls comprise three
checks on pins `310e272c5e82e72ddd15011de62f173de270f3b924e5edfca4e1fbc40579112e`
and the corrected genuine two-device guard on pins
`decec4335e851268b513e2bf7f24d05abb4889ba0742f105b3902e7fd3ab1598`.
The original failing growth result is retained on pins
`3d650ce94ca7ba92ff1824ee570d5dea71274ca4415e5efeccd0252556f3e6cc`.

### Indexed v1.2 occurrence expansion

The genuine accepted two-device source compared the same 200 requested IDs at
0, 128 and 1,024 unrelated complete owner chunks. Original expansion reads were
5,453 / 22,741 / 850,397. The final repair reads 6,118 / 6,345 / 6,584 across
three batches of at most 80 IDs (84 bound values), plus one availability query.
The unchanged growth bound remains 512 reads; observed maximum growth is 466.
All 201 selected source JSONs, exact record order, public rows, retained cross-day
conflict and foreign exclusion are equal. Every retained literal plan searches
the existing occurrence/chunk indexes and the chunk primary key, with no physical
chunk scan. The base cost increased about 12%; aggregate CPU/heap and whole
reader/scheduler speed are not inferred from these numbers.

The scaling run passed 1/1 on equal 425-input/runtime/Node hashes
`ae8032c1ea2e1dadcf8297a4b78c5b8e725c1b989ad40ee5d662b4566d67fdc5`.
The unchanged existing reader file passed 6/6 separately on equal 443-input hashes
`9377df2070c0b4db1a070fc8bebb97ae2bd2869e16b1832f0c8c054e14ecc45e`.
The final reader hash is
`0b2166c538677ea7f9e0fd884c05d8aa54c7ed1cbbfa896261c145bab5c0200c`.
Earlier unsuccessful admission fixtures and the expensive intermediate repairs
remain retained. These two successful runs are not a complete Worker gate.

### Cache claim predicates, collection controls and feature claim baseline

Five checks passed and the new feature claim regression failed on identical
408-input before/after pins
`10a3ffdfeeaed194037061494734efce6f8d900e673d42171185d9f671654d9d`.
The pass covers both repaired native SQL-depth failures, exact partial/malformed
index fallback and both collection-control cases. The feature claim baseline
failed at the intended unchanged-head/null-claim assertion. These are separate
component outcomes; the combined suite is not reported green.

### Authentic conflict carry baseline

The shared-disabled case failed at the intended healthy mark assertion on
identical 386-input pins
`827ccdfda41f62eb58718850b08525abc666c9ade951a47435e0a7a7569c7db6`.
Sixteen scheduled passes each built/staged/refused zero and skipped two. Actual
invocations stayed within 950 total and 300 source statements; the largest used
111 statements. Admission/delivery/reference/diagnostics and scheduled costs
are retained separately in the private result, while ordinary migration setup
is explicitly unmeasured. The shared-enabled case has not run. The bad carry
correctly refused `usage_row_refused`; no conflicted daily publication appeared.

### Bounded daily continuation repair

The two-case repair run retained identical 386-input before/after pins
`d03f1f9835951351ffc0c29eec3f51df0153e9d23f7b30fc46b7b0e3b9b56494`.
The cap, invalid-input, unexpected-error, real-budget and replay controls passed.
The healthy requested-day result now matches the independent native reference
exactly, hash `c8e801829260d194e4c7001c6c052076f7337f27687c5de3409ea416add53e7b`.
The conflicted native carry still refuses, public conflict days remain absent,
and the exact authority and two-owner vector remain unchanged.

The complete carry case **still failed** at the subsequent later-day readiness
assertion after its original 16 passes. One result built at pass nine; every
pass used the original 300-source allocation. A nonempty native day requires
initial discovery, seven carry pages and its own page. The failed later bound
alone does not prove permanent starvation. The separately labeled, same-store
progress probe passed: the healthy day completes at pass nine and its later day
has lookback index six/progress revision seven at pass sixteen. In a separately
bounded last-day-only control, healthy and bad owners produce the unaffected
last day at passes18 and17 with exact independent native equality. This does
not turn the original16-pass assertion into a pass. The386-source-input pin did
not separately attest all loaded native binaries beforehand; only an after-run
runtime inventory exists. Shared-enabled coverage has not executed. These results qualify the requested
private computation and daily continuation controls, not the full scheduler.

The exact migration inventory check passed after its release-trigger assertion
was added. Documentation preflight passed its 20 tests and governance checks.
The root package manager reported an installed-module synchronization warning;
no package installation or dependency replacement was performed. That warning
is not a successful workspace-copy or complete owning-package gate.

### Guarded feature claim release

The unsuccessful-save baseline now passes with its original assertion intact.
The release consumes one reserved real statement, matches the exact original
claim and head, and changes no prepared frame or public result. Captured handles
and nested invocation/phase meters each stay within 950 actual statements.
Producer errors, committed writes with lost responses, competing replacement
claims, source changes, lease/deadline expiration and erasure controls passed.
New claims require the current exact release guards; completed legacy reads
retain their original behavior.

The first focused run passed 17 controls and failed four during test cleanup:
raw D1 `exec` split the captured multiline trigger DDL. All failures remain
retained on identical 575-input pins
`7a0a2203ffffa5ad089de2e983d9c11526db610402e05ff7c1fe139ba29e2df0`.
Only the two trigger-restoration calls changed to prepared execution; the four
schema-presence/removal-race controls then passed on identical 575-input pins
`2cd40872e93229d149f87db65a23ff72cfe96f4860a74650e73b510675ca49eb`.
These are separate component runs, not one coherent 21-test or complete Worker
gate. Exact original0032 migration bytes and its original update branches remain
unchanged. The affected forward migration atomic rollback test also passed;
aggregate CPU, SQL work and peak heap have not been measured for this slice.

### Remaining prefix obstruction and stage/lane repair

The stronger genuine five-owner baseline retains all four crossed-day refusals
and the full five-owner public cohort, while the fifth healthy owner never runs.
Three maxOwners4 calls each attempt the same blocked prefix and advance zero
owners. Exact723-input/runtime/Node pins remain unchanged; the reviewed repair
adds a source/day cursor advanced before each actual attempt. Native value and
publication checks remain authoritative; this repair is not yet implemented.

A separate store-selector regression reproduces history turns being consumed
by intervening cache-only claims. The repaired selector gives each stage its
own subsequent lane cycle, retains the original natural first funded turn,
and keeps stage/class/head recency and advisory preview consistent. Its complete
owning file passed28/28 on equal597-input/runtime/Node pins
`02e0876b4433c15e953c19a5311d00e3a2608f779841c749d00048a09e10686d`.
The new regression claims withdrawal/new/recovery/withdrawal/new/history with
47 real queries; full actual-role progress remains a separate gate. The original
baseline and two failed ordering refinements are retained, without assertion
changes.

The101-day window experiment has not reached its consumer: first-day native
admission failed with BACKEND_STORAGE_UNAVAILABLE. The exact3236-input pinned
failure remains an admission-fixture diagnostic, not a window-limit reproduction.
An isolated native admission check must pass before retrying the full vector.

## Completion gates

- [x] Reconcile reported source and preserved isolated candidate.
- [x] Reproduce unrelated-owner carry obstruction, repeated v1/v1.1 proof work
  and unsuccessful-save claim retention without production access.
- [x] Qualify reached-chunk repair and existing collection-control correction.
- [x] Qualify daily continuation cap/error/replay and requested-day equality.
- [x] Qualify guarded feature-claim release, exact schema races and reserved cleanup.
- [ ] Qualify full later-day scheduler progress.
- [ ] Complete v1.2/dense/planner/window and later-date availability coverage.
- [ ] Re-run affected real-role progress and persistent all-output scenarios.
- [ ] Complete P1–P11 capacity, C06, erasure/restore and frozen owning gates.
- [ ] Prepare exact online/prod migration, activation and fallback package;
  execute protected operations only under their explicit authorization.
