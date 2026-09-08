---
title: Agent release tooling validation
date: 2026-09-08
type: review
status: complete-with-baseline-failures
---

# Scope and result boundary

Validates recommendations 1–3 of the
[release investigation](../research/2026-09-08-agent-release-process-improvements.md),
implemented in `a624d521dd6ce49d8466927d91652124af09234b` on
`codex/release-agent-tooling`, based on
`77b564cd1d226aef4e32e0405c25cf20ec1c7d3f`. Recommendations 4–5 remain
[planned](../plans/2026-09-08-agent-release-tooling.md). The maintained entrypoint
is [agent release operations](../runbooks/agent-release-operations.md).

Environment: macOS arm64, Node.js 26.2.0. All mutation tests used synthetic
fixtures, disposable local Git remotes, local databases or development bundles.
No production/staging deployment, live coordination-ref write, Apple submission,
Developer ID signing, system-app installation or public release was performed.

## Test run report

| Suite | Result | Boundary |
|---|---|---|
| Deployment coordinator and doctor | 39 passed, 0 failed | Exact predecessor/source, mutation intent, uncertain outcomes, ownership and read-only status |
| Shared journal and Git coordination | 10 passed, 0 failed | Actual local Git conditional updates, competing owners, lost acknowledgments, process-death mutex recovery |
| Native journal and channel policy | 32 passed, 0 failed | Every phase interruption, unknown/known Apple ID, tampering, interrupted final copies and no-clobber installation |
| Test-lane and web-release integration | 12 passed, 0 failed | Reviewed base forwarding and owning test inventories |
| `product:macos:test` | 110 passed, 0 failed, 0 skipped | Development bundle, native helper and updater checks; 360 seconds, not a signed qualification |
| `macos-source` | Passed | 35 release-tool tests, locale/source checks; three artifact-only exclusions exercised by the separate full native gate |
| Worker checks | 958 Vitest tests passed; 235 operation tests passed | Workspace guards, types, TypeScript and local migration streams also passed |
| Worker dry builds | Development, production and staging passed | Staging configuration checks passed; no upload/deployment |
| Documentation and preflight | Passed | 20 governance tests; whitespace and root-layout checks |
| Tool inventory and architecture | Passed after inventory corrections | Six inventory tests; 97 tool records; 407 production files, 1660 imports, no approved architecture debt |
| Broad root `npm test` | Completed with failures | Retained R7 mismatch and two inventory failures; inventory failures corrected and all six owning tests rerun successfully |
| Final integrated focused rerun | 99 passed, 0 failed, 0 skipped | All new release/journal/deployment tests plus channel, lane, web integration and inventory tests after corrections |

Counts overlap; they must not be summed as distinct tests. The long suites ran
with other local validation, so elapsed times are not performance benchmarks.

## Failures analyzed and corrections

- **Environment:** the sandbox initially denied local loopback/log access for
  Worker checks. The approved rerun passed without changing tests or retrieving
  production secrets.
- **Expected admission refusal:** Worker dry builds initially rejected the dirty
  source tree. After the local implementation commit, all three dry builds passed.
- **Stale test expectations:** the web-lane fixture needed the now-required exact
  base commit; lane inventories needed the added executable tests. Updated those
  expectations without weakening their assertions.
- **Inventory regression:** the broad run exposed missing static caller
  registrations and the exact pre-change tool-count assertion. Registered all
  callers, advanced the reviewed count to 97 records / 99 paths and reran all six
  inventory tests successfully. The complete root suite was not rerun after this
  metadata/test-only correction; no all-green broad-suite claim is made.
- **Review corrections:** persisted deployment intent now follows the final
  locked source/dependency checks; status distinguishes safe pre-mutation retry
  from uncertain ownership. Native recovery validates journal structure and
  canonical output ownership, synchronizes retained artifacts, refuses path/link
  substitution, and preserves interrupted final copies before retrying.
- **Pre-existing release-evidence failure:** both retained-R7 tests fail on
  `contractProvenance.workloadCodeSha256`. The exact 362-file workload hashes to
  `b91df4fcacffc39f5ec60d4e318bb98d55f35eecb3207beecdaf931d49911f06`
  in both the base revision and implementation. Retained receipts instead name
  `7b441df76b2f045c4bf22506dd990e9aa182414f00dba518c99cfe17f257cc54`.
  This tooling did not alter the workload. Receipts were not relabeled,
  regenerated or waived; protected R7 qualification remains a separate gate.

No flaky retry was used to obtain a pass. Independent native and deployment
reviews informed the regression cases; final deployment review reported no
remaining blocker in the coordinator/shared-journal changes.

## Remaining qualification

Synthetic tests do not establish real Apple availability, GitHub coordination-ref
permissions, physical Intel behavior or installed signed-app qualification.
The shared Git lock is cooperative, not a provider-side fence against raw
Wrangler or older deployments. An Apple submission without a durably recorded
ID requires explicit investigation; it is intentionally not blindly retried.
Cross-surface publication automation and narrower reusable qualification remain
recommendations 4–5, not implemented claims.

**Verdict:** requested tooling implemented and owning validation passed after
the corrections above. The repository-wide release gate still needs attention
for its pre-existing R7 evidence mismatch. Resolving that requires the separate
protected qualification workflow, not changes to the test or receipt hashes.
