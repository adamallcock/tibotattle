---
title: Analytics query budget production deployment
date: 2026-09-27
type: receipt
status: production-active
---

# Analytics query budget production deployment

This is point-in-time evidence for the separately scheduled production analytics
Worker. It does not establish a five-percent throughput improvement, a finished
graph backlog, or a website/publication Worker deployment.

The owner authorized deploying the checkpoint query saving and requested a 950
statement cap. The candidate source commit is
`31a32281c1224b63de45b55b14e44b66357ce321` on
`codex/analytics-pipeline-repair`, based on the previously active repair source
`ba7f00b28a32cc839f420db32dec7009b31e884b`. The candidate changes only the
analytics schedule's shared invocation meter from 900 to 950 and skips one
stage reread when D1 confirms that the same writer freshly inserted the
immutable checkpoint stage. Staged replays still reread and verify it; owner,
part, and final-head fences remain. Cloudflare documents a 1,000-query limit
per paid Worker invocation in its
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), leaving
50 queries between this meter and that platform limit.

Validation in the production-based checkout:

- TypeScript and 27 focused schedule/checkpoint tests passed.
- The complete Worker source and script checks reached Vitest; 160 test files
  and 1,997 tests passed. The combined `npm run check` then stopped at the
  generic website dry run because this checkout lacks the generated public
  release manifest. That is an asset prerequisite, not a Worker test failure.
- A separate, asset-free Wrangler `versions upload --dry-run` passed for the
  analytics Worker. The emitted JavaScript differs from the previously active
  bundle only in the two intended source changes. Its SHA-256 is
  `d4087161e634aca6c6609825d3d39de1b2f3453281af78525fa96e86d63eb19e`.

The analytics-only version `dbdd0a32-2d28-4de4-9faf-85e38203ccf2` was
uploaded, checked against the prior binding and runtime descriptors, and
activated at 100% on `tibotattle-analytics-recovery-20260914` at about
23:08 UTC. The previous version was still active immediately before upload;
the minute schedule and resource bindings were unchanged afterward. The source
commit binding now names the candidate; other runtime settings were preserved.
The website and publication Worker were not deployed. No migration, data reset,
or manual database write was performed; scheduled processing continued.

At 22:59 UTC before activation, read-only aggregates showed 317 daily days
queued and 2,015 completed graph results, four in the preceding hour. The
active September 26 effective model checkpoint was in the `fitability`
acquisition phase at source day August 10, occurrence ordinal 13,550. A later
cursor must be interpreted within its acquisition phase; a day/ordinal reset
between phases does not by itself mean lost work.

Natural scheduled analytics runs on the new version at 23:09 and 23:11 UTC
completed with no exceptions. They used 211 and 228 metered statements,
respectively, and did graph sweep work. Another ordinary run at 23:12 UTC
completed one graph calculation with no exception, using 379 statements.
Cloudflare reported one canceled invocation at 23:16 UTC with no exception or
application log, followed by a successful invocation for the same scheduled
minute. Its cause is unknown; later ordinary runs continued.

At 23:21 UTC, read-only aggregates showed 312 daily days queued and 2,018
completed graph results. The active September 26 effective model checkpoint
had advanced within the same `fitability` phase to source day August 29,
ordinal 25,142. September 25 remained the latest published model day. The
separate publication Worker was not changed, and these short observations do
not measure a throughput gain from the 950 statement cap. The long graph
invocation's result was not captured by this tail connection, which attached
after that invocation started.
