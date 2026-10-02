---
title: Shared window fresh maintained proof
date: 2026-10-02
type: design
status: accepted-direction-implemented-off-tree
---

## Boundary

All work is off tree. Root owns candidate integration. No D1 run is authorized. The restored native inventory query a1535f2a remains unchanged. The rejected header-days result is retained: exact graph parity, but bounded scalar 142,921,409 reads versus native 13,214,413; 119,195,167 reads were the 182 inventory statements. This design addresses repeated validation through the existing maintained context, not SQL membership semantics.

## Existing authority

- `storage-analytics-runtime.ts:424` and `storage-analytics-worker.ts:125` attach the real source/target/sourceId/namespace through `withMaintainedEffectiveDependencies` only for the canonical pipeline. The attachment survives nested D1 meters.
- `storage-community-graph.ts:809` supplies the real canonical producer. Native and canonical feature methods remain distinct.
- `storage-analytics-canonical-day.ts:101-110` creates the canonical input context and advances real bounded selective coverage when absent. No coverage rows or ACKs may be manufactured in a fixture.
- `storage-effective-selective-dependencies.ts:562` captures an opaque request context: full source capabilities before and after exact owner/scope tokens; tokens require seeded owner coverage, no pending forward/reverse work, native source identity, active ownership, scoped day/range/broad/policy stamps and the next retained authorization expiry. Its fresh check compares the source sequence plus method and actual capability inventory, and rejects expired contexts. The context is bounded to at most 120 seconds.
- `storage-effective-dependency-summaries.ts` owns the attachment. It already fences target owner revision/epoch, source namespace/contract and erasure. `createEffectiveHistoryDayDependencyReader` already uses maintained summaries when actually attached and covered, with exact native misses.

## Small code surface

1. Add one facade in the maintained dependency module. It admits a private, closable invocation handle only for the actual matching attachment (source, target, sourceId, namespace), supported summary target, and full native source/context proof. It calls the existing context creator/checker, without a new schema, token format or source clock. Its `current` operation always requests full source capabilities and current target authority; it also checks expiry after awaited work. It cannot renew a context. A mismatch, missing capability or missing coverage at acquisition is optional-unavailable, so the window retains the native path.
2. In the shared-window plan only, and only when the real canonical producer is present, try that facade before existing inventory and vector acquisition. Scope list contains the full requested `[fromDay, throughDay]` with sessions plus every selected singleton day, including an empty selected set via the whole-range scope. This is at most 102 entries, within the existing 132 limit. Whole-range coverage is mandatory: singleton populated days cannot detect arrivals on an empty calendar day.
3. Perform the existing positive native quota/usage inventory and exact per-day dependency acquisition once, inside the captured context's before/after source proof. Store the same immutable inventory and exact digest vector already owned by the plan. No maintained day-presence table or negative head is treated as positive inventory.
4. Subsequent full seals validate that bounded context freshly before reuse and after target head/identity checks. Only then can the previously proven inventory and exact singleton digests stand for a fresh reconstruction. Method, source owner/input, target owner/epoch/namespace/erasure, and every selected head/part identity remain freshly checked at all existing boundaries. Every page, including a cached full day, keeps fresh full context proofs before and after serving.
5. Any post-acquisition schema, generation, clock, owner, target, method or head failure closes the plan and defers/refuses. It does not silently fall back to a stale handle. Native reconstruction remains the path when canonical producer, matching binding, capability or coverage is absent initially. Closing clears the handle with the existing projections/cache; a new invocation must acquire a new proof.
6. Preserve 8 MiB compact + one 4 MiB full day, evict-before-decode, 200-row pages, existing admission/headroom/950 limits and all existing externally visible sealing positions. The context lifetime is `min(real remaining invocation time, 120000ms)`; it cannot extend the caller's deadline. A long invocation must defer on context expiry, not renew the snapshot.

## Equivalence argument

Let I be the exact native whole-range inventory and D the exact ordered singleton dependency vector captured while the full source generation/capability and covered owner/time proof are stable. The existing selective source generation changes on admitted source mutations (including source family, proof deletion, correction, authority and runtime changes); the time bound covers authorization transitions without writes. Thus a fresh full context check preserves precisely I and D for this one invocation. The proof is conservative: even an unrelated source mutation invalidates the handle. Actual target heads and source/target authority are independent and are still read fresh. No argument depends only on owner revision, timestamps agreeing with stored days, or admitted-day validity. Native corrupt/restored-store membership controls remain unmodified.

This relies on the same actual schema capability contract as existing canonical read contexts. It does not claim protection against arbitrary simultaneous destruction and recreation of every mutation guard with hidden writes between observations. Tests must cover realistic guard loss, native proof loss, and restoration after a detected failure; the closed window must stay closed after restoration.

## Additive validation required

- Genuine populated canonical bundle through the existing producer and real coverage work; independently compare quota/model/scalar output with native effective readers.
- Repeated unchanged `seal`, quota/model access and multiple scalar pages: actual physical metadata, query shapes and output parity. After the initial positive native acquisition, zero repeated native inventory and dependency-link reconstruction in the measured window operations. Bound all calls by 950 and report whole acquisition plus operation costs, including added schema/clock checks.
- No attachment; canonical flag absent; wrong attachment target/id/namespace; unseeded coverage; pending work; missing source or target capability at acquisition: exact native path or existing refusal, never incomplete positive reuse. Measure fallback queries explicitly.
- Genuine newly populated formerly empty day; correction; source proof deletion while owner revision is unchanged; method change; source/target owner or erasure; head/part replacement; source capability disappearance; target summary capability disappearance; context expiry; input mutation after capture; budget exhaustion; explicit close. Inject at page and final seal/write/readback positions as appropriate. A detected failure is sticky even after restoring a lost capability.
- Retain unchanged original native lifetime suite and original 101-day corpus/test body. Their default source has no maintained binding/canonical flag and cannot qualify this new path.

## Measurement boundary and sequence

1. Run additive controls on current source first so the expected no-rescan assertion fails visibly. No source flag, coverage or budget overrides.
2. After root source review/adoption, run the same controls once with the exact actual source/config/SQL/installed-runtime pin controller.
3. Separately qualify a genuine canonical full101 graph path: same admitted usage/quota corpus and native reference, canonical producer for the candidate, actual maintained attachment before the shared meter, real bounded coverage/preparation charged separately, `canonicalPipeline:true` in graph computation. Record cold coverage, canonical feature preparation, graph acquisition, scalar/model invocations, final publication/readback, physical rows, statements, writes and wall separately. The test must assert the handle is actually eligible through observed behavior (no repeated raw validation) rather than rename a fallback result.
4. Preserve the existing original101 unchanged run as a default/fallback regression gate. Compare existing native/default measurements separately from canonical measurements. Canonical setup/preparation costs are not excluded from an end-to-end success claim. No performance claim until the full101 canonical and owning lifetime gates pass; the narrow SQL 2x gates did not predict dense behavior.

## Ownership and pending review

Owned source changes: only the window-plan portion of `storage-analytics-shared-features.ts` and a minimal facade in `storage-effective-dependency-summaries.ts`. Dedicated additive tests. P0 retains composition; explain retains the 0015 ledger trigger body. No source-schema, trigger inventory or token API changes are proposed. The separate dated review and handoff JSON now identify the source patch, baseline controls, canonical dense test and three once-only controllers. Virtual baseline and proposed-source TypeScript checks pass. No candidate write or D1 run has occurred.
