---
title: Production operations integration
date: 2026-10-03
type: review
status: source-tested
---

This isolated source integration starts from frozen `445e393a4c2737016bee78bc9c6ca866f5a1033a`. It grants no remote build, infrastructure apply, migration or rollout authority. Staging integration is separate.

Accepted initial source folds are the Container Analysis preflight `898f72f9` with truthful Node 26.2 validation receipt correction `342d2004`, and bounded barrier capture `14571d1f`. The barrier owning check is included in the production tooling gate and the cutover runbook uses the reviewed capture entrypoint.

Initial composed owning checks passed 91/91, zero skips, on Node 26.2.0. Log: `/private/tmp/production-ops-initial-gates.log`. No remote requests were made by these injected synthetic tests.

The privately observed namespace (observation 2026-10-04 00:49:08.330 UTC) was applied only to `service.telemetryStorageNamespace` in the canonical production desired state. A whole-config comparison proved all other fields unchanged; no value is reproduced here. Production and manifest checks pass.

The closure-only probe preserves all 172 inputs, closure `98bd3be1fbcf141f38ccc7e9a5fdfaeefa7969df9b81779b646ae533cca5512c` and compute stamp `023332f1267c47a61abcef8dde786ff0140af225132aed1f3ba1f5ffd8f23090`; no closure input path changed. Initial preflight passed 21/21.

The independently accepted timestamp protocol `92ef3502` and monitoring chain `3a351e0a` → `5cbac731` are composed. Final OPS infrastructure checks pass 374/374; composed cutover checks pass 166/166; preflight passes 21/21; architecture passes (976 files, 4191 imports, zero debt). Node 22.16 actual generated-context validation passes 1/1 and builds all 12 entries. A root-directory build with materialized local dependency copies proves all 12 runtime bundles byte-exact to the frozen 445 artifacts; source-path labels differed under the initial symlink/cwd setup, which was corrected without source changes. The separate affected monitoring checks pass 44/44. All these checks have zero skips. The final closure identity and all 172 compute input paths remain byte-identical to the frozen base, with no registry or pin changes.

The migration command passed 34 pure tests and skipped five real PostgreSQL integration cases because no test cluster was configured. This is an explicit unqualified gate; no new database was started. The earlier base qualification remains separate.

Monitoring uses the new v2 plan schema: prepare a fresh plan digest; old prepared plans are invalid. Installation, live readback, ingestion, thresholds and delivery remain separate qualifications; cadence/probe deferrals and the documented final no-CAS race are retained.

The fresh website deployment from the `94a9b9d7` predecessor changes the Cloudflare operational predecessor. Re-observe the current deployed version and rebuild fence/rollback plans from that predecessor before any edge operation; do not reuse an earlier deployment-version binding. This is an operator note, not a runtime patch.

Freeze the final committed HEAD after this receipt. The new production build packet must use that exact clean HEAD; all local dry-run outputs are approval material only. Container Analysis enablement remains separately pending owner approval.

The final committed HEAD determines the next production build, migration and rollout approval. Do not reuse the earlier built image as proof for the new HEAD, bypass committed-config enforcement or infer live API/provenance qualification from local tests. Root schedules and authorizes each remote operation separately.
