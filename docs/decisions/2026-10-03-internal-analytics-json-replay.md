---
title: Native JSON parsing for internal GCP analytics replay
date: 2026-10-03
type: decision-record
status: accepted-source-candidate
---

The user explicitly accepted dropping duplicate-key rejection for internally reconstructed analytics JSON on 2026-10-03. This decision permits native JSON.parse last-value-wins only in the Node/GCP replay composition. Source implementation is isolated from Wave26 profiling and remains subject to independent review/integration. No deployment or production performance is claimed.

Raw intake, envelope decryption, live correction assertion preparation and default reconciliation/accumulator callers keep the original strict parser. Its source remains byte-identical SHA256 `137866597bebc2239e34a24aa2dc1b97069e4b2bd3b4203ce24df21570a2137b`. The previous separately accepted visitor optimization is preserved independently; this decision does not integrate or replace that candidate.

Two GCP callsites opt in: `parseCorrectionFact` calls the specifically named `prepareAnalyticsReplayUsageCorrectionAssertion`; `assembleOccurrences` calls vendored `reconcileGroups` with `jsonParsing: "internal_analytics_replay"`. The mode is captured when an accumulator is constructed and selects a private native parser. Existing public assertion signature stays unchanged, including callback compatibility with Array.map. Unknown replay modes refuse. Native syntax errors map to content-free ApiError(400, customCode); correction callers retain their existing content-free correction error mapping.

Typed legacy and v12 sources are reconstructed from typed columns and verified against canonical digests before assembly. GCP correction facts are reconstructed from scalar history/fact fields, canonicalized and checked against record/base digests. The reusable vendored reconciliation seam also accepts recordJson strings, including archive correction text. An explicitly selected replay mode accepts duplicate keys in those strings; typed-column provenance must not be inferred merely from a replay flag. Unchanged default callers handling raw stored/correction text still reject duplicates. Earlier duplicate values can be hidden by the accepted last-value-wins behavior in this internal scope; surviving values still undergo all existing byte/page/source limits, privacy/bounds/schema validation, canonicalization, hashing, ownership and occurrence checks. No global guard is dropped.

The canonical generator applies named reversible SOURCE_PATCHES to reconciliation and its effective-reader composition, regenerating vendor sources/manifest. Generated files were not hand edited. The original reconciliation source is retained in the test fixture `usage-reconciliation-strict-oracle.ts.txt`, SHA256 `35458510a2f2c69710bf7cf78e701cdd0e504cbbe903ba3a0ecc1ace6271d15c`; it supplies independent canonical assertion and full accumulator parity. Existing strict tests are retained. New tests explicitly accept last-value-wins only for replay, preserve strict defaults, compare complete canonical outputs, retain malformed/customcode/private-error/non-string behavior and negative bounds/privacy/scope/lifecycle gates. Both actual private GCP functions are exercised in a test-only bundle whose strict parser always throws, proving that the replay callsites select the native composition. No new production bypass function is exported for arbitrary parsing.

A bounded Node 22.16 / macOS arm64 benchmark uses the maintained content-free v11UsageRecord fixture exactly (815 bytes). CPU timing and Inspector allocation sampling are separate phases; sampling at 4096 bytes includes collected objects and is an estimate, not exact allocation or peakRSS. The complete correction and replay phases retain validation, canonicalization, hashing and folding.

| Phase | Strict ms | Native ms | Strict sampled bytes/iteration | Native sampled bytes/iteration |
| --- | ---: | ---: | ---: | ---: |
| One 815 B parse |0.008255|0.000931|23,844|750|
| One correction assertion |0.093936|0.070483|138,009|107,077|
| 20-record accumulator replay |1.454605|1.270221|2,635,216|2,186,262|

The measured complete-path CPU reductions are approximately 25% for one assertion and 13% for 20-record replay, with sampled allocation reductions 22% and 17%. Parser-only gains are 89% CPU / 97% sampled allocation; they must not be presented as whole-analytics gains. The large-array parser microbench is diagnostic and can exceed ingress caps. Serialization remains unchanged. Benchmark source is `apps/worker/scripts/internal-analytics-json-benchmark.mjs`; it reads only maintained synthetic fixtures/source, prints numeric aggregates and does not connect to a database/cloud or inspect private sessions.

Exact source acceptance, original/narrow suites, generator integrity, TypeScript, architecture and preflight results are recorded below after final verification. Full corpus/frozen kernel measurement, RSS, integration, registration, production and cloud qualification remain separate gates.

Final focused verification: 29 tests pass across the unchanged strict parser, original correction assertion/accumulator suites and seven new composition/decision tests. Worker TypeScript passes. Generator integrity passes 59/59, including exact source-patch reversal, standalone bundle/load/typecheck and manifest closure. Architecture passes with 972 production files and 4,176 imports; preflight passes 21/21; whitespace checks pass. The new test harness initially used esbuild's synchronous API with a plugin, which is unsupported; it was corrected to the asynchronous API. No existing test or assertion was removed or weakened. Independent exact-source review remains pending; these local Node gates do not qualify a deployed Worker or cloud runtime.
