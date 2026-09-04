---
title: Codex ingestion compatibility implementation review
date: 2026-09-03
type: review
status: source-verified
---

# Codex ingestion compatibility implementation review

Implemented and synthetically verified on `codex/release-0.1.18`, based on
`9e1c3333`. This is source/test evidence, not installed-client, private-log,
production-index migration, release, or deployment qualification. Compression,
model/pricing and cache-lens changes have separate owners and receipts.

## Preserved evidence and compatibility

- Unified extraction now retains omitted/null counters as nullable values;
  explicit zero remains observed zero. Canonical components require their
  prerequisite counters and consistent totals. Worker messages and the existing
  nullable SQLite columns preserve these distinctions.
- Incremental cursor restoration no longer converts SQL NULL with
  `Number(null)`. A newly observed complete per-response vector can corroborate
  the known part of an incomplete cumulative delta without inventing the
  missing part.
- Provider and checkpoint availability treat a literal null as unavailable,
  not as field presence. Passive v0.3 records retain their existing
  complete-vector-or-null contract: any unavailable component withholds the
  vector while preserving quota observations and record continuity.
- Unified parser is `unified-rollout-typed-v12`; provider scanner is
  `codex-log-scan-v8`; export checkpoint scan is
  `codex-export-checkpoint-scan-v0.4`. Closed compatibility schema constants and
  generated manifests match. SQLite physical schema remains **11**, checkpoint
  state remains `codex-checkpoint-state-v0.2`, and source identity remains
  `codex-immutable-rollout-v1`.
- Existing staged parser-version repair reparses present sources without
  deleting the live database. Removed sources retain original parser provenance;
  their unavailable historical evidence cannot be reconstructed. Passive
  historical records are not destructively rewritten.
- Cumulative lineage keys deliberately retain their legacy normalized
  representation. Only the replay key, never the stored usage evidence, uses
  zero placeholders. This keeps v12 children compatible with retained v11
  parent snapshots after the parent source rotates away.

## Deliberately deferred sources

Codex [#41912](https://github.com/openai/codex/pull/41912) persists top-level
`token_usage_record` with response, turn and thread totals while continuing
legacy `event_msg.token_count`. The frozen
[history envelope](https://github.com/openai/codex/blob/5f79a92e3936274318d2122ae3244e5edd80dd1f/codex-rs/history/src/lib.rs#L111)
also defines `compacted.latest_token_usage_record` as a checkpoint copy.
All four readers retain the legacy-only accounting contract: response records,
cumulative totals and checkpoint copies are not added again. Response-only
sources emit no supported measured usage, not zero-token usage records. Safe
response-identity reconciliation and record-only coverage remain unimplemented.

The exact [#42328 provenance test](https://github.com/openai/codex/blob/0d502a423031396a8d11c096e5b9f1cb0d30b3d0/codex-rs/history/src/tests.rs)
stores `metadata.harness_authored_configuration` beside a durable
`configuration_update` input control. This proves authorship, not backend
application or eligible single-agent mode. The index continues reporting the
observed turn/request effort; it does not infer effective effort or overwrite
that setting from trusted, untrusted or custom update controls. No inferred
effective state survives compaction, fork or resume. Installed-client/applied
update qualification remains separate.

## Validation

The serial focused command below passed **291 tests, zero failures/skips**, in
26.7 seconds on Node.js 26.2.0. All fixtures are synthetic and content-free.

```sh
node --test --test-concurrency=1 \
  test/local-unified-index.test.js \
  test/local-unified-index-recovery.test.js \
  test/local-unified-index-off-main.test.js \
  test/codex-interleaved-usage-streams.test.js \
  test/codex-usage-compatibility.test.js \
  test/codex-rollout-hardening.test.js \
  test/codex-log-scan-privacy.test.js \
  test/export-checkpoint-equivalence.test.js \
  test/export-contract.test.js \
  test/export-schema.test.js \
  test/passive-collector.test.js
```

New cases verify omitted versus explicit-zero components in full, worker-mode
(`workerCount: 2`) and incremental paths; nullable cursor persistence; parser reparse of
synthetic poisoned rows; retained-parent replay keys; inconsistent/null counters;
response duplicates and compaction copies; fork/checkpoint interruption parity;
response-only absence; update-control non-attribution; and private-ID canaries.
Existing cases retain source mutation, cancellation, atomic publication,
interleaved streams, lineage, schema migration and recovery coverage.

`pnpm architecture:check`, `pnpm docs:check` and `pnpm test:preflight` (20 tests)
also passed. An initial export
test failure was the expected stale generated compatibility manifest after
version changes; canonical constants and the normal telemetry generator resolved
it. No tests were removed, skipped or weakened. No R7 regeneration, authenticated
traffic, real-source ingestion, index deletion, commit, push, or publication was
performed by this workstream.

## Initial full-suite follow-up

An initial `npm test` over the concurrent release worktree reported 3,759 tests:
3,682 passed, 55 failed, one cancelled and 21 skipped. This is **not** a passing
full-release gate. Sandbox-denied socket/process operations dominated runtime;
the execution took 2,534.9 seconds. This snapshot predates follow-up fixes owned
by the model/catalog and compression workstreams.

- All existing ingestion/index cases passed. A subsequently added compressed
  checkpoint-resume case found a real durable-boundary verification gap; the
  compression owner fixed the logical-byte check. That entire checkpoint
  equivalence file then passed eight tests.
- An escalated rerun of broker, companion contribution routes, native network
  audit and portable companion-process suites passed all 59 tests. Their
  original `listen EPERM`, nested sandbox and process-readiness failures were
  environment restrictions; no assertions or product code were weakened.
- An additional escalated rerun of detailed-accounting benchmark and public
  release-site/preview suites passed all 44 tests. Their earlier process/socket
  failures were likewise environmental.
- Model/catalog follow-ups were assigned for the browser Fast-ratio mirror,
  Astra long-context Priority boundary fixture, client-export/local-review
  runtime module allowlists and R7's exact reviewed source-list assertion.
  Compression owns the platform API enumeration follow-up.
- Two escalated native artifact smokes exposed a genuine package-closure gap:
  the bundled telemetry entrypoint imported `src/admin-model-history.js` but
  that file was absent from the app's runtime. Both native smokes remained
  failing pending the model/catalog owner's macOS packaging fix; they are not
  counted as environment-only failures.
- Retained R7 receipts correctly reject changed workload digests/file counts.
  Their protected regeneration remains separate. Additional R7 test failures
  involved unavailable external RSS samples, denied process-owner liveness and
  a cleanup timeout; none authorize weakening those gates.

The broader suite must be rerun after these separate follow-ups. Installed-app,
R7 and publication qualification are still not established by the passing
focused ingestion tests.

## Final full-suite follow-up after runtime closure fixes

The subsequent full `npm test`, run outside the sandbox to permit its synthetic
loopback and native-process checks, completed in **412.5 seconds**:

| Tests | Passed | Failed | Cancelled | Skipped |
| ---: | ---: | ---: | ---: | ---: |
| 3,761 | 3,738 | 2 | 0 | 21 |

The only failures are the two checks in
`test/r7-generated-release-evidence.test.js` at lines 37 and 65. Both reject
retained receipts whose `contractProvenance.workloadCodeSha256` and
`workloadCodeFileCount` do not describe the modified source. The gate remains
intact; no protected receipt was regenerated. The 21 skips cover unprepared
Sparkle/appcast inputs (four) and native Windows-only checks (17).

All executed ingestion, compressed checkpoint/resume, cache, browser/admin,
pricing, source-package closure and ordinary runtime tests passed. In
particular, both previously failing native tests now pass within the full run:
the reproducible ad-hoc-signed app/watchdog smoke and the signed app's explicit
loopback central-health relay. This verifies the corrected synthetic native
runtime packaging, not a signed public release or installed user app.

No source was changed during this final execution. No tests were removed,
skipped by new configuration, or weakened. `git diff --check` passed afterward.
The full root gate remains non-green solely because current protected R7
receipts have not been regenerated.
