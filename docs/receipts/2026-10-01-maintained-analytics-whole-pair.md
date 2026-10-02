---
title: Maintained analytics optimized small workload comparison
date: 2026-10-01
type: review
status: partial
---

# Result

The approved 10-source-day, one-requested-date cold/warm/no-op pair completed. Seed, candidate and pinned native Workers each exited 0, and the input hashes remained unchanged. Each phase compares complete DTOs exactly, including analytical publication timestamps, stored published bodies and hashes. All six outputs have SHA-256 `de87d867a41b40c230e77857b3595f67c18e10bec9ac959f3b465cab3270459e`.

Both lanes used the optimized profile: B02 shared analytics/publication/cache, D02 model blocks with real adoption, preparedFold and the native preparedEffectiveUsage default. Actual analytics/cache/publication roles have separate real 950-statement meters. The common clock changes only reviewed analytical leaves; real leases and expiry remain real.

Every phase matches 17 complete daily/carry dates (2026-09-15 through 2026-10-01), 142 retained graph results (140 model results across 70 dates and two current fits), 70 public model dates, 20 cache owner-days, preview and public cache series. One explicitly requested daily date remains distinct from those prerequisite and retained populations. All role/application and measured SQL failure counts are zero.

This is a small local diagnostic, not the 466-day/1-30-365 H04 gate, a production result or a tenfold improvement. The tenfold resource target is not met here.

# Measured phase totals

| Phase | Lane | Statements | Rows read | Rows written | Wall ms | Max statements/invocation |
|---|---|---:|---:|---:|---:|---:|
| Cold | Native | 38,004 | 3,952,126 | 2,962 | 29,523 | 884 |
| Cold | Candidate | 787,975 | 140,545,706 | 80,711 | 213,486 | 912 |
| Warm | Native | 12,648 | 1,394,321 | 774 | 11,387 | 356 |
| Warm | Candidate | 18,815 | 5,371,236 | 734 | 5,865 | 245 |
| No-op | Native | 12,579 | 1,371,627 | 768 | 12,103 | 356 |
| No-op | Candidate | 18,872 | 5,384,420 | 734 | 5,892 | 304 |

Candidate/native read ratios: cold 35.562, warm 3.852, no-op 3.926. Warm wall time is lower, but statements and reads are higher. Wall time is not CPU or total resource cost.

At the fixed gross paid Standard D1 row basis, the measured D1-only subtotals are native/candidate $0.006914126/$0.221256706 cold, $0.002168321/$0.006105236 warm, and $0.002139627/$0.006118420 no-op. Total monetary cost remains null: request billing mapping, billed CPU, physical storage duration, export resources and allowances are not established.

# Dominant measured work

Candidate cold capability queries consumed 111,966 statements and 112,536,716 reads (80.1% of cold reads). The largest individual queries were:

- Fresh source selective-fence plus full sqlite_schema proof: 30,574 calls / 43,201,062 reads.
- Target schema inventory: 43,410 calls / 25,631,718 reads.
- Source schema presence counts: 15,116 calls / 19,182,204 reads; another exact presence count: 12,866 calls / 16,352,686 reads.
- Target closure proof: 37,895 calls / 10,116,997 reads.

Warm capability checks still consumed 3,593 statements / 4,658,848 reads (86.7% of warm reads). Raw-history access statement counts were native/candidate 3,741/29,217 cold, 1,530/148 warm and 1,523/148 no-op. Warm/no-op performed zero analytical decodes and zero pricing entry calls in both lanes. This physical-table counter includes metadata/absence probes and does not prove payload rescans. Saved attribution bounds all candidate warm/no-op raw-containing buckets by 9,399/9,471 reads (under 0.18% of all reads); 143 owner census/eligibility calls and two readiness hints are source-mapped, while three analytics calls remain unresolved. Complete fingerprint/result accounting and the unchanged raw-history gate remain open.

Cold actual-role statements were candidate analytics 259,339, cache 151,013, publication 350,163; native 936, 205 and 847 respectively. The remaining totals contain scoped requests, capture, publication, final guards, inventories and cleanup. Candidate cleanup used 24 statements/977 reads/0 writes each phase; native cleanup used 108/6,465/109 cold, 21/1,562/0 warm and 21/1,664/0 no-op. The machine summary retains every phase bucket.

# CPU, heap and bytes

All 82 observer recordings completed (candidate 40+9+9; native 8+8+8), with no observer or profile-validation failures and no segment gaps. Unrepresented sample-window time remains explicit. Sampled non-idle frame weights (native/candidate) were 25,613.477/175,379.827 ms cold, 9,489.653/4,300.338 ms warm, and 10,448.490/4,444.691 ms no-op. These measure the observed Worker isolate and include observer overhead; D1 service-isolate CPU and exact/billed Worker CPU remain unknown.

Cold maximum observed JS used heap was native 348,096,760 B and candidate 293,836,004 B. Other heap fields remain separate in the machine summary. These are barrier observations, not true peaks or a qualified memory-efficiency comparison. Both lanes had fresh Workers, and the host retained the complete peer DTOs for exact comparison. Warm/no-op retain each lane's own state.

Candidate/native bound-value representations were 1,102,232,030/8,007,528 B cold, 60,251,836/2,295,152 B warm, and 60,385,632/2,268,142 B no-op. Returned result representations were 328,508,760/15,802,548 B cold. Submitted checkpoint/payload logical bytes were 5,103,334/1,164,824 B cold, 105,920/105,939 B warm and 105,921/105,368 B no-op. These are defined UTF-8/typed representations, not physical wire bytes.

After cold cleanup the closed maintained-store logical row inventory was native 1,360,156 B versus candidate 6,165,816 B. Native target rows grew 784→808→832 over phases; candidate target rows remained 9,798. These are logical rows in the declared maintained stores, not SQLite file sizes, all source telemetry storage, cloud billing size or physical checkpoint bytes. The full inventory, submitted store classifications and side/phase counts are retained.

# Setup, pins and limits

One accepted pinned-native admission: 1,071 statements / 32,809 reads / 2,221 writes, separately counted. Candidate-only source upgrade: 260 statements / 513 reads / 468 writes. Both imports are exact schema/data/rowid proofs from that accepted logical snapshot. Setup/import/proof SQL is separately retained; exporter read/CPU/physical-copy resources remain unknown, and setup wall time was not instrumented.

The original native input digest remains `eaa10f90aee477d10008d47da8f528e7d8e5cc6e441688bff227b889dedcf8da`; candidate `a661130717e12f7c37acc1b05c0f729cdde6b0ac2e3a1dac2659375f48ebab5f`; harness `ea40e0a3c48a8791b2b0f0c61529fce5abdf16e1b4922be7b32af63a0d6b840a`. Full bundle and original/transformed-clock manifests are in the receipt.

One observer description still says “public DTO normalization”; this is stale descriptive text. The frozen executed code calls strict validation and host deep exact equality, and no output normalization ran. It should be corrected before a subsequent run.

No further workload or mutation run was launched. Mutation capture/replay, all required refusal/erasure/restore experiments, exact/billed CPU, true peak heap, physical bytes, large-corpus whole-resource improvement and final owning gate remain open.

# Artifacts

- `/private/tmp/p11-integration-debug-10-cold-warm-noop-11.json`: immutable paired receipt.
- `/private/tmp/p11-integration-debug-10-cold-warm-noop-11.log`: complete local run, SQL attribution, observer diagnostics and process exits.
- `/private/tmp/p11-integration-debug-10-cold-warm-noop-11.summary.json`: extracted phase resources, costs, logical inventory, query fingerprints and observer summary.

# Component qualification supporting this pair

Actual D1 analytical-clock goldens passed 23/23 alongside 37/37 Node/script cases and TypeScript. They compare full first, unchanged, correction and replay results at one analytical clock while keeping real publication leases, maintained-cohort expiry and future-cache refusal operational. Empty and nonempty stored rows, hashes and full DTOs match without normalization. These goldens do not qualify the large repeated-history or mutation workload.

The pure incremental mutation validator now includes cutoff checks across the whole sequential cross-lane admission span, including a cutoff between the two calls. Twenty synthetic assertion cases passed; authentic capture/replay/preimage integration remains open.
