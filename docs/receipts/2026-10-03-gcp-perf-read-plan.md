---
title: GCP READ-PLAN selection and evidence pass receipt
date: 2026-10-03
type: receipt
status: in-progress
---

This is local synthetic implementation evidence on coordinator-approved base
`48c26716a478bf92a830c27ea9c8ab7a90a0d929`, branch
`codex/perf-read-plan-20261003`. It does not qualify a production-shaped
speedup, combined kernel, Cloud SQL timeout margin, deployment or cutover.
The coordinator owns final registration and all large-corpus scheduling.

## Implementation and review boundary

Selection has new pair-level v1.1 builders. Legacy v1 stays per-record and
expansion builders are unchanged. `legacySelectionPairCtesSql(s, fence,
completenessCte?)` takes a fenced id CTE and, optionally, another lane's
reviewed completeness CTE with columns chunk_id/proof_count. The default is
the exact d3 count chain. READ-EXPANSION owns an independently proved grouped
completeness variant; no grouped-count performance claim is made here.

`readOwnerEvidencePlan` reads scope once, then one unnamed existing
`occurrences.counts` statement per stream. The counts deduplicate
(day, occurrence) with GROUP BY and bool_or, preserving the old set UNION
while allowing hash aggregation. It expands and decodes no source. A caller-readonly frozen
stream map contains ascending count maps and each stream's first evidence day.
Object.freeze seals own properties, while native Map mutators remain available
at runtime; trusted callers must not mutate these maps. Chunk validation reads
private snapshot aggregates rather than the exposed maps.
Private content-free metadata permits `countOwnerEvidencePlanRange` to
reapply the exact 400-day partition checks after the job's range validation.
A plan is bound to its owner, pool, schema, clock and supplied client; the
caller must keep the same exported snapshot alive while consuming it.

The caller switch is a separate commit: one plan per effective owner,
unchanged non-effective reads, owner-order combination, stream order
usage/quota/session, ascending days per stream. The concurrent helper's opt-in
item failure order picks the lowest started owner index and waits for all
started work. Existing callers retain completion-order semantics. Every plan
has the existing read time checkpoint immediately before it, with ownerIndex.
Older injected public reader modules that supply neither new plan API retain
the original first/count path; supplying only one plan API refuses.

## Pair and multiplicity proof

Migration 0033 gives `typed_v11_record_proofs.typed_record_id` a primary key
and non-null chunk_key/manifest_key foreign keys. It gives
`typed_v11_manifest_memberships.typed_manifest_id` NOT NULL UNIQUE.
No later primary migration changes those key constraints. Its allocation
insert guard requires `state.id = 1 AND state.namespace_id = NEW.namespace_id`;
its proof guard requires `record.id = NEW.typed_record_id`,
`record.chunk_id = NEW.chunk_key AND record.manifest_id = NEW.manifest_key`,
`chunk.namespace_id = record.namespace_id` and
`allocation.namespace_id = record.namespace_id`. These support the named
namespace redundancy under admitted source state. The conservative SQL still
retains every conjunct, including all proven redundancies.

All clauses below the proof are quoted in the mutation table. Each references
only pair keys, joined authorities or binds 1/2/4. Per-record joins remain:
`record.id=owned.id AND record.format=11 AND record.stream=$3`;
`membership.namespace_id=record.namespace_id AND membership.owner_id=record.owner_id
AND membership.participant_id=$2 AND membership.source_format=11`;
`v11.id=1 AND v11.runtime_contract_version=1 AND
v11.source_namespace=membership.source_namespace AND v11.namespace_id=membership.namespace_id`;
`typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id`;
`proof.typed_record_id=record.id`; day filter is unchanged.
The join back is `selection_pairs_ok.chunk_key=proof.chunk_key AND
selection_pairs_ok.manifest_key=proof.manifest_key`.

The d3 completeness chain is unchanged: count allocation joins physical chunk
on `physical_chunk.namespace_id=count_allocation.namespace_id AND
physical_chunk.format=11 AND physical_chunk.original_id=count_allocation.chunk_original`;
proof joins `count_proof.chunk_key=physical_chunk.id`; membership joins
`count_membership.typed_manifest_id=count_proof.manifest_key`. Reachability
uses `reach_chunk.id=pairs.chunk_key` and allocation namespace/original keys.

EXISTS removes below-proof multiplicity, not eligibility: candidates group by
observed_day/occurrence_id and take min(observed_at_ms); counts use a set of
those coordinates; first evidence takes minima. The v1 arm retains its
LATERAL/OFFSET 0 fence. Expansion's produced SQL at quoted schema
read_plan_fixed has identical base/head SHA256
`12495b65def619474f98982d3f79e9aa6c597c8884494c91da94299e737af5d0`.

## Complete pair conjunct table

The committed mutation harness deletes one conjunct at a time from the
pair-eligibility block only. There are 19 killed conjuncts and 4 explicit
redundancies. Synthetic corruption uses replica-role transactions to challenge
refusals without changing source constraints. Every changed fixture row is
restored, and schemas are dropped. The event fixture changes every event of
the selected generation: the head hook and explicit seed can provide two
qualifying events, so changing just one could hide a broken predicate.

| Conjunct | Outcome | Fixture or proof |
|---|---|---|
| `allocation.namespace_id=proof_chunk.namespace_id` | redundant | 0033 allocation guard binds its namespace to singleton v11 admission state; proof guard binds physical proof chunk to the same admitted record namespace. |
| `allocation.chunk_original=proof_chunk.original_id` | killed | chunk |
| `admitted_manifest.typed_manifest_id=pairs.manifest_key` | killed | manifest |
| `chunk.id=allocation.chunk_id` | killed | chunk |
| `chunk.stream=$4` | killed | stream |
| `domain_day.manifest_id=admitted_manifest.manifest_id` | killed | manifest |
| `manifest.id=domain_day.manifest_id` | killed | manifest |
| `manifest.state='ready'` | killed | manifest |
| `event.generation_id=domain_day.generation_id` | redundant | generation.id=event.generation_id and generation.id=domain_day.generation_id imply this equality. |
| `event.owner_digest=$1` | killed | event_owner |
| `event.participant_id=$2` | killed | event_participant |
| `generation.id=event.generation_id` | redundant | event.generation_id=domain_day.generation_id and generation.id=domain_day.generation_id imply this equality. |
| `generation.id=domain_day.generation_id` | redundant | generation.id=event.generation_id and event.generation_id=domain_day.generation_id imply this equality. |
| `generation.participant_id=chunk.participant_id` | killed | chunk_participant |
| `generation.device_id=chunk.device_id` | killed | chunk_device |
| `event.manifest_digest=generation.manifest_digest` | killed | event_digest |
| `event.from_day=generation.from_day` | killed | event_from |
| `event.through_day=generation.through_day` | killed | event_through |
| `event.input_revision=generation.input_revision` | killed | event_revision |
| `generation_device.id=generation.device_id` | killed | generation_device |
| `generation_device.participant_id=generation.participant_id` | killed | device_participant |
| `proof_chunk.id=pairs.chunk_key` | killed | chunk |
| `(chunk.id,chunk.record_count::bigint) IN (  SELECT complete.chunk_id,complete.proof_count FROM selection_chunk_proofs complete)` | killed | chunk |

Pair-specific fixtures also share one physical chunk across two manifest keys
(one staged), and one manifest key across two physical chunks (one incomplete).
The old oracle and candidate reader remain equal in each case. Existing
legacyScope fixtures cover superseded v1, incomplete admission, and foreign
participants/devices; v12Scope includes headed, staged, incomplete and foreign
compact evidence. Both correction runtime states are exercised.

## Correction domain and refusal proof

PostgreSQL div truncates negative event times toward zero. The plan retains
min and max correction event time per coordinate. A negative non-midnight
minimum records an upper-bound conflict at the old chunk's throughDay+1.
A separate bool_or regular-coordinate count excludes corrections from before
the old chunk's fromDay unless the same coordinate also has a valid legacy,
v1.2 or correction-at-midnight source. This also handles duplicate correction
facts without changing set semantics. Source-specific first minima are
validated in the old stream/source order even if another source already
provided an earlier valid minimum. Count-derived validation stays after range.

Fixtures cover negative non-midnight corrections crossing 400-day boundaries,
lower-bound exclusion, FLOOR (-100000), FLOOR-1, today and queued future days.
First selection stays in FLOOR..today; below-FLOOR or outside-plan count chunks
use the old bounded count reader. No unreachable-path assumption is needed.
A forced RANGE_EXCEEDED with count failure keeps RANGE_EXCEEDED; simultaneous
first errors keep the lowest owner index. Checkpoint cancellation starts no
later owner and settles started work before returning.

## Local validation and remaining measurements

Private PostgreSQL 17.10 uses locale C, UTF8, port 55541, loopback 127.0.0.1 and a
private Unix socket. Fixture disk use was 120 MiB, within the 2 GiB reservation.
No full/o01/s015 corpus import or benchmark has run. Root/package dependencies
were cloned locally from the approved fold and no lockfile changed.
Coordinator-approved test-only prerequisite commits 28c2c1cb, c63ebd48 and
87b6dac6 were replayed; they reconcile prepared-pricer memo proof, composed
build plugins and strict 0074 migration inventories. No vendor source, final
registry, pins, cutover checklist or other lane worktree was modified.

Focused evidence: reader A/B, negative correction, options/snapshot checks,
mutation and pair-specific tests;11 refresh-read scripted checks cover
concurrency 1–4, Map order, ordered refusal precedence and cancellation.
The corpus A/B and benchmark entrypoints are committed and script-list wired.
They use public readers against one exported snapshot and emit aggregate
counts, timings and SHA256 only. Benchmark mode adds EXPLAIN ANALYZE BUFFERS
and then separately runs concurrency 1–4 without EXPLAIN overhead.

Remaining scheduled acceptance: Q-1 and Dense imported corpus A/B, s015/full
and o01 A/B, same-import seven-table base/Stage1/Stage2 output digests,
REFRESH-OPT d3 base family ledgers, default/grouped completeness comparison,
full UNION largest-statement plans/buffers, 4-way timeout margin, full refresh
family/read wall and plan checkpoint times. Large corpus resources are owned
by the coordinator; this lane has not claimed those targets passed.

The brief's Cloud SQL ratios 2.5–5.35 and 8.9, projected savings and timeout
margin remain unverified here. No new local statement performance estimate,
Cloud SQL JIT benefit or cloud wall-time claim is made. A combined serving
image must wait for coordinator registration and complete gates.


## Stage 2 validation update

The actual PostgreSQL pipeline read inputs are deep-equal to the old pre-owner
pass at requested concurrency 1–4, including every Map's iteration order,
non-effective occurrences, planned owners, devices and range. The test holds
one exported snapshot. Its pool has four connections including the exporter,
so requested concurrency 4 includes one waiting reader and proves ordering,
not a four-physical-connection performance or timeout margin.
The source-family ledger proves zero first_evidence calls and exactly three
counts statements per effective owner in each planned pass.
The content-free corpus A/B entrypoint also ran against the same small direct-
seed schema and approved base checkout, including its sequential EXPLAIN
mode and concurrency 1–4 mode; no production-shaped corpus was used.

Validated: TypeScript; analytics-v2 254/254 plus the 10,000-event differential
(91,122 comparisons); unchanged vendor 59/59; architecture; preflight 21/21;
existing occurrence/new read-plan PG 24/24 before the two additional pipeline/
script tests; focused additional pipeline/script tests 2/2; refresh-read 11/11.
Full existing refresh spec: 63/64 pass, with the one bundled K-PAR test refusing
because cloud-run/dist has not been built for this unregistered closure.
Cloud-run check reaches the build and refuses CLOUD_RUN_BUILD_KERNEL_UNREGISTERED.
Fastpath script checks have the expected registry/closure refusals. Q-1 bundled
rehearsal and the missing bundled K-PAR test wait for coordinator registration;
no gate or registry assertion was weakened to hide the fold gap.

Internal raw candidate Map insertion order on large corpora remains a specific
measurement gate: the old SQL groups without ORDER BY. Public occurrence,
count and fingerprint order is equal in the synthetic tests. This receipt does
not claim that every unordered intermediate SQL row order is stable across
full-corpus query plans.

## Final lane closure for integrator

- computeClosureSha256: `082c5df84a25705e71bde3e33db921f384ef571e973085b604e4a25c5cb00f41`
- computeSha256: `085f70e61c91a6e0e90be6d72d5e610143b1e88b8d6d576bd45e3fbe2610e7e5`
- vendorManifestSha256: `85e919a6f439ff351c37d5df373d2d7299dafa1d4cac2359de9b580f151d7241`

The coordinator assigns the combined append-only kernel entry. These hashes
name this isolated lane only; they are not the final combined kernel identity.
The final new read-plan spec is 9/9 passing with zero skips when supplied the
private cluster and explicit approved A/B base root. The final scripted read
checks are 11/11, and staged documentation preflight is 21/21.

The private PG 17.10 cluster used only port 55541, C locale, loopback and
content-free synthetic fixtures. Its final disk size was 618 MiB; it was
stopped and its owned temporary data/socket/log directory removed after the
focused gates. No shared cluster or large-corpus import was used.
