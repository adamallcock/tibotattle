---
title: Maintained analytics bounded concurrency component
date: 2026-10-01
type: receipt
status: partial
---

# Boundary and decision

This synthetic local D1 component runs actual canonical and feature consumers at configured degrees 1/2/4/8 against independently imported exact source/target snapshots. It uses the production 950-statement shared invocation meter, 32 MiB residency and existing canonical/feature/release reserves. Full semantic facts, manifests, input dependencies and cache invalidation clock match; publication rows and their CAS markers remain unchanged. No product concurrency setting was changed.

Keep the single-executor default for this candidate. Degree 2's small canonical wall difference is insufficient evidence for increasing the pool; degrees 4/8 add deferrals and work. Heavy feature jobs admit only one job under the real reserve. This is a component decision, not whole-role scalability, primary SQL parallelism, skewed withdrawal fairness or production throughput proof. Revisit after grouped work and the complete workload.

# Measured execution

| Stage | Configured degree | Actual max admitted | Completed | Deferred | Statements | Reads | Writes | Wall ms | Max statements/invocation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| canonical | 1 | 1 | 8 | 0 | 986 | 173656 | 521 | 421 | 125 |
| canonical | 2 | 2 | 8 | 0 | 974 | 171304 | 517 | 398 | 245 |
| canonical | 4 | 4 | 8 | 8 | 1182 | 236572 | 629 | 466 | 409 |
| canonical | 8 | 5 | 8 | 19 | 1266 | 253009 | 756 | 497 | 368 |
| features | 1 | 1 | 12 | 0 | 1800 | 308746 | 520 | 540 | 150 |
| features | 2 | 1 | 12 | 11 | 1834 | 309294 | 641 | 556 | 153 |
| features | 4 | 1 | 12 | 30 | 1896 | 310218 | 850 | 551 | 159 |
| features | 8 | 1 | 12 | 56 | 1996 | 311628 | 1136 | 556 | 171 |

All measured SQL and consumer failure counts are zero. Setup costs are 963 ms and 7,822 laboratory statements; snapshot imports took 2,275 ms separately. Diagnostic, preparation, exact import/schema/rowid proof and capture costs remain separate. CPU and true peak heap are unavailable.

The live-head replay control leaves one ready replay unclaimed under its live head lease. Renewed-lease controls reject stale completion and release. Withdrawal fairness is explicitly unqualified: this ready-source fixture has no actual withdrawn input. Source effects remain pending; the fixture acknowledged none and disables the bridge solely to isolate this component.

# Exact evidence

The focused test passed 1/1 (9.75 seconds test / 11.34 seconds command). Runtime code/test/config/lock fingerprint `79980c26390d3f61eca3076de0483eb0999a6235f0701f3227143f056b6e2fd3` is unchanged across the run. The broader preflight manifest is not identical: package.json's script-only change preceded the final run; its ordinary Vitest invocation is unchanged. Do not label the broader preflight pin stable.

- Aggregate receipt: `/private/tmp/p0-g04-concurrency-profile.json`.
- Full log: `/private/tmp/p0-g04-concurrency-profile.log`.
- Pin manifest: `/private/tmp/p0-g04-concurrency-source-pin.json`.
- [Actual component test](../../apps/worker/test/storage-analytics-concurrency-profile.spec.ts).

# Fresh capability query experiment

A separate fresh full-schema D1 experiment passed 2/2 plus TypeScript. Existing source selective/source fence/target canonical/target feature checks cost 1,269/1,412/564/549 mean rows per statement over three repeats. The best of three typed JSON-join/materialized alternatives cost 147,303/274,947/14,553/6,468. Exact returned inventories match; missing table/index/trigger, wrong name/type and restored objects retain refusal/reacceptance. No product query was changed. These are local D1 row counts, not production CPU or billed cost.

[Profile test](../../apps/worker/test/analytics-capability-query-profile.spec.ts); aggregate log `/private/tmp/analytics-capability-query-profile.run.log`.
