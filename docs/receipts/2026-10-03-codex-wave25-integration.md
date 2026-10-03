---
title: Wave25 local source integration
date: 2026-10-03
type: receipt
status: in-progress
---

This receipt tracks the isolated local Wave25 candidate based on qualified Wave24 `d87ee3a0b5235e53b0fb6feb0daf957ff83cdd69`. It is source integration evidence, with no deployment, release, cloud-performance or production-readiness claim. The owner decisions and optimization program in the GCP coordination home remain authority.

## Fold and decisions

The serial fold is REFRESH-OPT `ac997edb`, PRICER `d249b655`, W1A `b21d7902`, W1E `90e30e80`, EXCL `380b8e22`, SEMI `69308de6`, KPAR `ceb02449`, and the full MEAS-SYNTH range through `064066a4`. The eight merge checkpoint is `3db53f60`. All branch-local registry entries were dropped; baseline entries and pins 1–4 remain unchanged. One combined entry 5 is derived after the settled source closure.

Build reconciliation composes the exact fast-pricer binding and Node host hashing alias through `cloudRunBuildPlugins`, which the production build and closure/pricing verification passes share. W1E is promoted from staged 0961 to additive primary 0074, with generated runtime schema, migration assertions, public store facade and its separate global pricing inventory. Its three tables hold no owner-scoped data and do not enter the owner purge inventory.

The refresh runner retains the frozen row requirement on the first production run and the revision floor requirement on every production run. Operator exclusions continue to apply to departed members' historical saved contributions. Inline profiles use a 64 MiB semi-space with the corrected output budget. The production profile is `dense-workers`: 4 vCPU, 16 GiB, four Workers, 10,752 MiB owner budget, no process-wide V8 heap flags, and a 24-hour task timeout. Workers retain their own 192 MiB young-generation charge.

## Acceptance and scheduling

Focused pure tests and synthetic PostgreSQL gates are owned here on private port 55529. Fresh semantic Wave24 comparators are owned separately on port 55530. Heavy measurements require coordinator scheduling; none are started by this source integration.

The required semantic matrix is Q1, 1.2M and dense against the previous kernel. The after-wave performance matrix is a 1.2M CPU/GC/pgstat slice, full inline and four Workers, and the o01 probe. Repaired-source KPAR full-scale memory proof remains open until these runs. Main-isolate inspector profiles do not describe all Worker CPU, while process CPU and RSS include Workers. Loaded-host baseline timings do not qualify performance comparisons. Cloud measurement must choose `dense-workers` explicitly and bind source, seeders and image provenance.

## Digest comparison boundary

| Table scope | Semantic comparison | Provenance requirement |
|---|---|---|
| Seven existing derived families | Exact content equality after table-specific run/kernel/manifest/time stamps | Exact candidate kernel, manifest, run and source binding checked separately |
| Owner sets and saved contributions | Exact values and membership, except the declared EXCL unlinked/departed exclusion scenario | Exclusion digest and saved-member identity linkage checked; no global semantic exception |
| Price cards | Exact card ids, content hashes and references | `first_kernel_id` checked against the actual first registering kernel; never globally ignored |
| Kernel prices | Exact cards/projection | `compute_sha256` checked against each source-bound build class; never globally ignored |
| Pricing classes, kernel pricing classes, transition proofs | Candidate inline/four-Worker equality and class/proof assertions; absence from Wave24 explicitly declared | All new columns retained; no new table silently skipped |
| Runs and kernels | Separate execution/registry evidence | Successful run/cursor, immutable registry pins and bundle provenance verified |

Existing MEAS-SYNTH global field removal is insufficient by itself for this combined matrix. Final comparison tooling and receipts must name their exact table and column scope.

## Current checks

At the reconciliation stage, pool/read checks passed 21/21 and combined deploy/production-migration checks passed 60/60. The pricing-class suite passed all eight behavioral/negative cases; its ninth exact-input inventory required the expected new `fast-pricer.ts` input. The final settled-source validation and independent review remain open.

## Settled-source checkpoint

Kernel5 compute closure is `e022061bb1bccd6e3906fcbf5dc49edec1a06dbee63e70a74a8df22b1e1d9156`, vendor manifest `85e919a6f439ff351c37d5df373d2d7299dafa1d4cac2359de9b580f151d7241`, and entry pin `3e81ee257f82806f03ed6aa4bb545d8d416b22d4e144a1042e6a9acda22b8248`. Build check and full bundle build pass; registry8/8 and pricing-class9/9 pass. Pure measurement helpers12/12 pass with local process visibility. Scoped digest negatives6/6 pass.

The first focused PostgreSQL pass had69passes,3failures and1skip. All three were stale integration test wiring: missing production plugins in the W1E build fixture, the old73-migration count, and SEMI using the new Worker production profile for inline assertions. Individual repairs retain existing budget assertions and add Worker semi-space refusal coverage. The focused repair pass4/4 passes, including built kernels5/6,31stored owner-days,601events, and exact19-table full-versus-identity price proof. Full settled PostgreSQL repetition remains open. An automatic-review rejection of a broader proposed test-block rewrite occurred before execution; the accepted repair preserved the assertions.

The comparison collector explicitly supports one fresh completed run, or two same-kernel completed Q1 reruns when `expectedRunCount: 2` is supplied. It reports raw full-row hashes and per-table semantic hashes, exact policy hash and validated stamp evidence. Unknown tables and columns have no implicit masking. The baseline full run is retained by its owner for same-database reviewed policy capture; the old slice seven-family comparison requires an independently reviewed actual-schema equivalence proof.

## Focused qualification follow-up

Settled PostgreSQL repetition passed72/73 with0failures and1existing skip. Architecture passed969productionfiles/4154imports/0debt; root preflight passed. The owning analytics gate exposed a stale PRICER assertion requiring scalar repricing after preparation. REFRESH memo intentionally eliminates that repricing: the corrected test proves preparation executes the instrumented fast binding, scalar/model reductions do not reprice, and both results remain byte-identical to the oracle. The isolated PRICER suite passes11/11.

## Reviewed collector and operations fold

Policy follow-up94a72b16 checks every projected run_id/proof_run against a completed expected-kernel/manifest run; independent review accepted it and7/7 pure tests pass. Policy hash is `0f691bf83391573ac6d8e11854a72dc91f7d36aa615fb27724e18ea6414864bd`. Real tiny Q1 rehearsal passed on private55529 under Node22.16.0 refresh, retaining two schemas. The collector passed46 provenance checks, exactkernel5/compute `fd6b1a64872c47e1e3f1972a9e631e9b9ea91a0a93c62724738f9949929788e2`/manifest1, explicit2completedruns,3class tables, and raw plus semantic evidence for24tables. Local evidence: `/private/tmp/wave25-q1-report.json` and `/private/tmp/wave25-q1-digest-evidence.json`. Baseline owner collected reviewed Q1 kernel4 evidence from its retained database and refreshed the slice seven-family actual-schema equivalence proof; missing full raw slice evidence after its prior default cleanup remains explicit.

Qualified operations commits115a398d andbb974d6b folded as07fe999c andcf92f5fe. Their focused tests pass34/34; post-fold build check passes with the identical kernel5 closure/vendor/compute stamps. Owning analytics completed253/254 with one stale exact plugin-list assertion expecting only the Node plugin. Updated expectation requires both fast-pricer and Node plugins; all alias-boundary assertions remain. Targeted host primitive suite passes11/11. PRICER fuzz passed91,122 comparisons. A complete owning analytics rerun remains pending; no expensive corpus or performance qualification has been launched.

## Source qualification and diagnostic admission

The full owning analytics run passed 254 tests across 24 files. The separate 3,000,000-event differential passed 3,081,122 comparisons; it is distinct from the earlier 91,122 focused comparisons. TypeScript, architecture and preflight passed. Fastpath scripts passed 131 tests with four existing skips, followed by 19/19 production-shape/policy tests. Cloud Run's complete source gate passed 486 tests with four existing skips (490 total). Migration74 inventories in build context, test activation/migration targets and graph receipt verification are fixed by87b6dac6; strict drift/refusal assertions remain. Worker Node tests passed2/2 and vendor checks passed. The root-admitted backup target fix119eeb8d folded as c952850d; affected backup/rollout checks passed66/66 and the build again reports identical kernel5 stamps.

The broad root suite is **not green**: 6,055 passed,13 failed and49 skipped out of6,117. A same-runtime Wave24 control reproduces five selected failures exactly: native migration UI contract smoke exits with null status against expected0 at `test/macos-app-bundle.test.js:8558`, both retained R7 workload provenance receipt failures, and both reviewed catalog exact-list expectations. Node26.2.0/darwin-arm64 meets the native test's stated prerequisite; native/test/catalog/telemetry scoped source comparison against d87 is empty. The native UI failure is a baseline-reproduced local limitation, not a demonstrated Wave25 regression. The native audit explicitly fails `sandbox_apply: Operation not permitted`; seven further R7 failures concern measured external RSS or live PID identity with sandbox `ps` unavailable. No native/catalog assertions changed and no R7 receipts regenerated. Logs are preserved at `/private/tmp/wave25-root-tests.log` and `/private/tmp/wave25-base-control.log`. Root admits only the GCP diagnostic with these distinct limitations; native/R7/catalog release qualification remains open.

The supported no-golden E12 run passed14 tests with one golden-fixture skip and is not the mandatory no-skip qualification. Golden local and external-edge modes remain required. The external edge tree is clean at f03f4f5c; its runtime and E12 harness source diff is empty against the admitted Wave24 edge953350ef, with only the qualified operations commits added.

| Gate | Exact scope/status | Remaining action |
| --- | --- | --- |
| Q1 | All eight rehearsal gates passed; kernel5 collector passes46 provenance checks and retains24 tables | Reviewed previous-kernel comparison retained by baseline owner |
| E12 | Supported14/14 non-golden plus one explicit skip | Complete golden local and external-edge modes with no skips |
| Candidate slice | Single retained1,230,835-record diagnostic/semantic run, dense-workers, Node22 refresh,24h compute timeout | Launch only after E12 outcome and exact clean source pin |
| Slice comparison | Seven derived families exact versus reviewed Wave24 projection; declared EXCL exception narrowly scoped | Compare actual results; no global masks or retroactive digest relabeling |
| W1E tables | Affirmative exact schema/content and class-link checks; raw evidence retained | Exact candidate INLINE/W4 equality after both profiles exist |
| Full parity/memory | Corrected combined-source full INLINE and W4 not measured | Centrally serialized on quiet host after source choices settle |
| o01 | Required program probe remains open | Root scheduling |
| Performance | CPU/GC main isolate; process CPU/RSS include Workers | Diagnostic slice timings contended; no speed comparison claim |
| Cloud production | Explicit dense-workers, source/seeder/image binding and deliberate execution timeout | No cloud run authorized here; runner default48h and optional comparator4h remain distinct from24h production |

The immutable slice corpus is `/Users/adamallcock/Library/Caches/tibotattle-profile-slice-20261003/corpus-s015`; sealed SHA `fd961b9254be6780778f375b506ebe60b78623ff99ad0d80a5b29fd6b5e2a53b`, journal SHA `621e5a735dfc42943319877755468a38a62954c63ba2093d45d1d64728b34ffd`, manifest SHA `6272cf078412c00eda85d348dc22c9a4237a3fdaa34955f49eaf30b7e165d316`. Combined-source seeder/corpus/importer SHA256 values match the baseline binding; no corpus copied. Root reserves at most20GiB RAM and4GiB incremental disk for one candidate slice. Actual baseline slice import was1.354GiB, outputs137.8MiB and cluster approximately2.53GiB including1GiB WAL, with unqualified RSS1940MiB; candidate W4 peak remains unmeasured. The new empty owned PostgreSQL17.10 cluster on55531 is localeC, loopback-only, with statement statistics/IO timing enabled. No slice import started as of this checkpoint.

## No-skip E12 and optional PGstat checkpoint

Golden E12 local passed15/15 with zero skips; external clean edge f03f4f5c passed15/15 with zero skips. Both use Node22.16.0 with explicit strip-types on private55529. Source admission remains GCP-only with the recorded broad-root limitations. Runtime-schema generator fixture count was corrected to74 in eb64e338; owning generator tests pass.

The optional measurement-only `--pgstat-interval` accepts10..1800seconds and leaves omitted-hook callers unchanged. Import snapshots/delta are separately labeled `corpus-import-only`. Refresh before snapshot completes before spawn; serial bounded periodic snapshots drain before the after-exit snapshot and compute-only delta. Child timestamps, sample cap and saturation/error status are explicit. Stored snapshots/deltas contain fingerprints and counters without SQL text. Dedicated pool clients always release, and child failure identity survives secondary snapshot failure. Spawn error handling drains PID discovery and stops process sampling. Helper tests pass6/6; a real empty private-PG smoke produces comparable statements and two periodic snapshots with no errors or SQL text. Combined production-shape/policy/lifecycle gate passes25/25. An unchanged production-shell signal test first reported an orphaned sampler on one combined run; its focused retry and the complete25-test retry passed without modifying the shell or its assertions. Logs `/private/tmp/wave25-pgstat-lifecycle2.log`, `/private/tmp/wave25-pgstat-real-smoke.json`, `/private/tmp/wave25-prodshape-pgstat-final.log` preserve this evidence. Independent optional-hook review remains required.

Owned allocation report: checkout707.35MiB; private55529 cluster902MiB; prepared empty55531 cluster38.74MiB; log/evidence files3.65MiB. No retention cleanup performed. Root has paused new imports pending host disk trend/capacity reconciliation. No candidate slice import or compute launched.

Optional-hook review accepted the source lifecycle with explicit interpretation limits: its scope is the refresh-child **temporal window**, not isolated compute SQL. Diagnostic queries are included; IO/WAL counters are cluster-wide. Ranked statement retention may omit a prior row and independent statement-reset continuity is absent, so `statementsComparable` alone does not establish a complete exact SQL delta. These limitations are stored alongside the hook evidence. The optional hook records its own synthetic import temporary directory for the launcher to account for disk usage; disabled callers remain unchanged. Parent signal/process-group cleanup and storage/RSS limits belong to the owned slice launcher.
