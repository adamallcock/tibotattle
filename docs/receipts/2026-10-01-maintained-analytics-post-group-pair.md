---
title: Maintained analytics comparison after fair grouping
date: 2026-10-01
type: review
status: local-diagnostic-target-failed
---

# Result and boundary

The fifteenth paired diagnostic completed with exact public-output parity for
cold, warm and unchanged processing. The required tenfold whole-work/cost target
**failed**. This is a ten-source-day, one-requested-date diagnostic, not the
466-day corpus, 1/30/365-date qualification, incremental mutation proof or an
online/production result.

Both lanes independently import the same native accepted snapshot. The reference
uses the pinned optimized native profile, including existing day features,
model-date blocks and prepared/effective readers. Both execute the actual three
scheduled roles, complete publication/visibility and cleanup, and retain the
950-statement invocation meter. Analytical/publication clocks are paired; real
lease, deadline and cohort clocks remain live. No output subset was substituted.

## Equal complete outcomes

Every phase and lane shares output SHA-256
`93c4feacda4dad5a3e4825109a9b9251ee8ac342efffaa4bb2ad92572967445c`.
The complete population contains 17 daily/carry outcomes, two current scalar
owners, 140 owner-model results across 70 retained dates, 70 published model
dates, 20 cache owner-days, one preview and one cache series. The single requested
daily date and two requested owner-model results are distinguished from retained
population work. Each lane/phase passes 54 publication-timestamp checks. Bodies,
stored publication hashes and timestamps match exactly.

## Measured phase work

| Phase | Lane | Statements | Rows read | Rows written | Elapsed ms | Maximum statements per invocation | Modeled gross D1 row subtotal USD |
|---|---|---:|---:|---:|---:|---:|---:|
| Cold | Native | 38,004 | 3,948,846 | 2,962 | 52,115 | 884 | 0.006910846 |
| Cold | Candidate | 681,497 | 63,501,910 | 74,321 | 272,309 | 915 | 0.137822910 |
| Warm | Native | 12,648 | 1,394,322 | 774 | 20,008 | 356 | 0.002168322 |
| Warm | Candidate | 16,719 | 3,303,955 | 19 | 10,396 | 289 | 0.003322955 |
| Unchanged | Native | 12,557 | 1,370,928 | 767 | 20,427 | 356 | 0.002137928 |
| Unchanged | Candidate | 16,656 | 3,297,025 | 19 | 11,437 | 227 | 0.003316025 |

Cold candidate reads are 16.08 times native and elapsed time is 5.23 times
native. Warm elapsed time is 1.92 times faster, but reads are 2.37 times native;
unchanged elapsed time is 1.79 times faster, but reads are 2.40 times native.
Gross D1 row subtotals are 19.94, 1.53 and 1.55 times native respectively, using
the same fixed per-row basis. These are neither account billing nor full or
marginal cost. `wholeWorkloadQualification` remains false.

The cold candidate needed 405 passes per scheduled role and 270 source-closure
opportunities, within the original unchanged 400 preparation bound. Warm and
unchanged required two passes per role and one source closure. All SQL,
measurement and scheduled-role failure counts are zero. Setup, admission,
export/import/proof and source-upgrade records remain separate; three local
exports expose no resource metadata and are explicitly unqualified.

## Profiling and next acceptance work

Cold schema/capability queries account for 40,391,915 reads (63.6 percent),
including 35,116 fresh atomic source-fence calls. Removing all of those reads
would still leave about 23.1 million candidate reads versus 3.95 million native;
this is not a sufficient next optimization. The target inventory/input class
contains 327,035 statements. P0 is tracing source/day/leaf job fanout and repeated
rediscovery before the next A04/B03/C06/G06 change. No capability/authority boolean
may be cached and no source, lease, erasure, output or terminal gate is relaxed.

All six observers, 79 segments and 316 heap observations are complete, with no
profile rejection, transport abort or dropped heap sample. Exact/billed CPU,
true peak heap, physical wire bytes and total cost remain unknown. Sample
weights and barrier heap observations must not be substituted for them.

Direct typed cold payload acquisition is positively detected (candidate 189
recognized payload rows; native 191). Warm and unchanged candidate paths each
retain three directly recognized metadata shapes, 148 statements and 3,699
query-wide reads. Their internal filtering, indirect views/aliases and all
source execution methods are not yet a complete no-rescan proof. The cold type
classifier has explicit unknown/type gaps; it does not establish malformed
product evidence. All consumers' complete C06 and mutation qualification remains
open. Main statement totals already reconcile with source/target/ledger meters;
lineage gaps do not imply uncounted aggregate cost.

## Immutable provenance

- Raw receipt: `/private/tmp/p11-integration-debug-10-cold-warm-noop-15.json`;
  SHA-256 `b37336ebd0660db2fae3fdb4b324d32e3719b50826fef0e27817e0349c095a4d`.
- Log: `/private/tmp/p11-integration-debug-10-cold-warm-noop-15.log`.
- Independent P11 audit:
  `/private/tmp/2026-10-01-p11-whole15-resource-projection-audit.md` and
  `/private/tmp/p11-15-resource-observer-projection-audit.json`.
- All 17 maintained migration hashes:
  `/private/tmp/p11-15-harness-migration-pins.json`.
- Native commit: `f056940fefabed0c7f0e88353cf54845b077f0c8`; Node `v26.2.0`.
- Harness: 161 files,
  `3a08f56a360b20fcb6c555704de1ff5bfbc6d665281bce47b82237e91bc7a1a9`.
- Native inputs:
  `eaa10f90aee477d10008d47da8f528e7d8e5cc6e441688bff227b889dedcf8da`;
  bundle `83f8133e9a4655dbfceaa4b3860db7fdd1b339ec116da73baf03a99e967d9c2e`.
- Candidate inputs:
  `745fc24a6276cbe1894b1283358a6cd6a413b8e6958dd903f6f3261fd079e1b1`;
  bundle `878d7fba3fba2c90bf0a41e6be6780401df6d246b6680d746de7f238547a0508`.
- Accepted source snapshot SQL:
  `90cf9d9accc5015cef013db66ed079bda9e8e5dbaa803bd8f5683a6ac6ef5144`;
  schema `987ae4b3f987381452f2f182b0ab02fc534ac582cb82b66ce3e52f88896a2d1f`;
  rowid inventory `99fb19b8d09944752d49aab5ee2b586f6b41ec2a8e71fa1e9db85c23cbddcd13`.
- Fixture: `03aaf96658aa92536101ae7a475cdb7341d4d9f53a4bb73434197f88d147b763`.

Final source/harness hashes remained unchanged throughout the paired run. This
receipt does not blend earlier runs' data or treat their different synthetic
seeds as a controlled causal comparison. The preceding grouped component receipt
is retained as its own earlier checkpoint. No combined-candidate deployment,
remote write, migration or load test occurred.
