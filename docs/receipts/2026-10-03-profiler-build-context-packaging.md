---
title: Profiler runtime build-context packaging
date: 2026-10-03
type: receipt
status: implemented-awaiting-independent-review
---

Based on frozen Wave26 `06222bf3aafda3d0ddd09ee1d4e793b2622eacf7`, this tooling-only change adds the three missing runtime profiler modules to the canonical Cloud Run context allowlist: isolate CPU coordinator, sampled allocation helper and numeric-memory helper. Their remaining relative dependency is the already included main CPU helper; other imports are Node builtins. No runtime profiler source, admission budget, kernel registration or pin changes.

The prior context checker refused `CLOUD_RUN_CONTEXT_IMPORT_OUTSIDE_CONTEXT` for refresh and Worker imports of the missing coordinator. The unchanged import-closure guard now validates all transitive runtime imports. Profiler checks, allocation conformance and integration fixtures remain excluded; packaging these runtime modules does not enable diagnostics in CloudRun or production/staging.

Node22.16 `npm --prefix apps/worker run gcp:context:check` passes its actual-context regression. The generator copied 643 audited source files and 74 migrations with source-content SHA256 `f7e81d6cfd1595565d5a1ac9a6bfb1aedb4cd26488cc100ea74eef225360d745`. It verifies byte equality for all four runtime profiler modules, exclusion of six profiler fixtures, production/staging/CloudRun diagnostic refusal for CPU/allocation/memory modes, and successful builds of all twelve actual production entries from that generated context. The bundled refresh help entry runs, and the bundled benchmark migration reader checks the copied migration74 tail through its existing reader adapter.

The test reuses installed local dependencies without downloading or adding any. It mirrors the Docker build-stage root node_modules link and preserves relative workspace dependency links. The Docker benchmark CLI deliberately reads `/app`; its exact container-path command is not claimed locally exercised. No Docker build, cloud service, database, corpus or deployment ran. The generated context and dependency copies are owned temporary test outputs and cleaned after the check. Independent exact-source review and serial integration remain open.
