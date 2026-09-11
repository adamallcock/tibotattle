---
title: Release 0.1.18 integrated Astra and Intel validation
date: 2026-09-04
type: review
status: release-gated
---

# Release 0.1.18 integrated Astra and Intel validation

## Verdict and source

The Astra/Codex work and full Intel implementation are integrated on
`codex/release-0.1.18`, starting from the requested `origin/main` revision
`9e1c33338297c4ffdd224a22b2a2cfbf589ce62a`. The tested implementation is
`de386d3136a4cb0f5c70a848919567aac3887f53`:

- `a3319093` preserves the compatibility implementation and its earlier review.
- `33b79d94` merges Intel tip `2b6b6be9`, including its source, release tooling,
  version allocation and historical evidence. Only two generated telemetry
  manifests conflicted; their owning generators rebuilt the combined contract.
- `de386d31` fixes the compaction-header gap discovered in the current live log
  and adds combined release notes. The package version is `0.1.18`.

The Intel worktree was rechecked after integration: it remains clean at
`2b6b6be9`, with no additional commits to import. Local `main`, the isolated
website deployment branch and the Intel tester artifact were not changed.

**Source preparation is complete; release qualification is not.** The final
root suite has only the two retained R7 freshness failures described below.
This record supersedes the earlier
[compatibility validation](./2026-09-03-release-0-1-18-compatibility-validation.md)
for combined-source test status, not for historical evidence.

## Live Astra findings

The owner-authorized current conversation was inspected read-only, using a
bounded snapshot and a fixed observation cutoff of **2026-09-04 19:06 UTC**.
Only structural counts and accounting facts are retained here; raw content,
source paths, response identifiers and private usage totals remain outside Git.

- The sample contains **20 completed Astra response records**, **22 legacy
  token-count updates**, and **20 extracted usage events**. Every response usage
  vector matches its legacy counterpart; repeated legacy updates are deduped.
  The response-level record stream is not independently added to billing.
- All sampled response components are explicit and valid, including zero cache
  writes. Canonical app pricing and an independent per-response calculation
  agree exactly, with every sampled event fully priced.
- The observed settings identify `gpt-6-astra`, raw/request effort `ultra`, and
  service tier `default`. Request inputs are below the long-context threshold.
  Nominal context capacity and cumulative thread usage are not pricing inputs.
- Cache reuse is observed. No effort transition or `configuration_update`
  occurs in the bounded sample, so it does **not** qualify applied-update or
  cache-preserving effort-switch support. Separate child-agent logs were not
  included; this is not a total-task cost or a subscription charge.
- Two actual compactions used the header order `timestamp, ordinal, type`.
  The old bounded header reader missed both. It now recognizes that form,
  validates a bounded unsigned ordinal, and still refuses nested/payload
  markers without decoding replacement history. Both boundaries are recovered
  on reinspection, with unchanged usage-event count and price.

Parser `unified-rollout-typed-v13` forces safe reprocessing of present sources
to recover missed boundaries; physical SQLite schema 11 is unchanged. Synthetic
tests cover zero/max-u64 ordinals, malformed and overflowing values, nested
spoofs, and oversized content-bearing compactions. No real log became a fixture.

## Official compatibility refresh

The supplied rates and all eight implemented Astra price cards match the current
[official model card](https://developers.openai.com/api/docs/models/gpt-6-astra):
Standard input/cache-read/cache-write/output rates are 10/1/12.5/50 USD per million;
Batch and Flex are half, Fast is double. Strictly more than 272,000 request input
tokens selects full-request long pricing: 2x input/cache and 1.5x output.
No price correction was needed after live-log inspection.

The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
limits cache-preserving configuration updates to Astra standard single-agent
mode while leaving request-level effort unchanged. A raw UI effort label alone
does not establish that mechanism. The implementation keeps measured cache
behavior, requested effort and model/mode semantics distinct; it does not
assume every Astra switch is a hit or automatically erase observed misses.

The [upstream assessment](../research/2026-09-03-codex-astra-compatibility.md)
records the four requested PRs and additional changes. The integrated scope
includes missing-component preservation, bounded native Zstd history reading,
and the shared 39-identity catalog/admin projection. Response-only accounting,
applied reasoning-update evidence, and real compressed-history throughput remain
explicit limitations, not inferred support.

## Test run report

Environment: macOS Apple silicon host, Node 26.2.0; Intel checks additionally use
the pinned official Node 26.2.0 x64 runtime under Rosetta. Counts are overlapping
commands, not additive coverage totals.

| Suite or gate | Final result |
| --- | --- |
| Full root `npm test`, after the final parser fix and pinned Sparkle preparation | **3,790 tests: 3,771 passed, 2 failed, 17 skipped**, no cancellations; 496.7 seconds |
| Worker `npm run product:worker:check` | **Exit 0**: package guards, generated/type/script checks, **43 Vitest files / 533 tests**, production asset staging, production and staging dry bundles |
| Full browser `npm run product:ui:test` | **494/494 passed** |
| Release-site `npm run product:release-site:test` | **36/36 passed** |
| Compaction/index/compatibility/cache focused follow-up | **153/153 passed** |
| Intel Node ingestion, broker and telemetry follow-up | **35/35 passed** |
| Final combined Intel development artifact | Build and payload inspection passed; all six isolated native/lifecycle checks passed |
| Documentation, preflight, architecture, whitespace | Passed; architecture reports 385 production files and 1,560 imports, no approved debt edges |

### Failures and setup corrections

Both root failures are in `test/r7-generated-release-evidence.test.js`:
retained receipt freshness and exact decision reconstruction reject changed
workload source provenance. All ten imported receipts certify the earlier Intel
tree, not this combined tree. **Regeneration is deferred pending owner authority
for the protected dual-runtime private-corpus run.** No receipt, test, guard or
resource ceiling was weakened or relabelled.

The first combined root run had four additional skips because this worktree
lacked pinned Sparkle/appcast dependencies. Preparing the hash-verified inputs
enabled all four in the final run; the remaining 17 are Windows-only checks.
An initial Worker dry build correctly refused untracked browser screenshots.
Those task-owned outputs were moved intact into the ignored build directory,
then both dry builds and the complete Worker command passed on the clean tree.
These are setup corrections, not flaky tests; no flaky failure was observed.

Public-site assets used the validated already-published **ARM 0.1.17** DMG and
manifest. Its bytes/native trust and the 1200x630 PNG were checked; Intel
installer metadata remained null. This qualifies local staging, not a 0.1.18
download, new public metadata, deployment, or crawler availability.

## Native and rendered verification

The final Intel artifact is an **ad-hoc development/test-profile app**, built
from `de386d31`, with disabled updater and no configured central service:

- Source digest: `5a8566a280ab129f4fed7e23844e7ea36ea083e91137953e5f4bff92e0eeacc2`.
- Normalized payload digest: `41a0f3d70746477f3ec491de2858624e04991e28bf4160af0e65a95ad10d0956`.
- Payload size: 158,833,233 bytes; target `x64`, exact Intel executable slices
  enforced by the builder and inspector.
- Compiled disabled-updater, fake Login Item, in-memory Keychain broker and
  migration-UI checks passed. Normal and JIT-less companion startup passed in
  separate empty temporary profiles with loopback readiness and clean shutdown.
  No real Keychain access, Login Item registration or system installation occurred.

The earlier [signed Intel tester candidate](../receipts/2026-09-03-macos-intel-signed-candidate.md)
is build 1025 from `18c7065b`, not from the combined source. It stays intact and
must not be represented as including Astra. Final ARM/Intel release artifacts
need a common newly frozen source and fresh artifact-specific verification.
Its local `SHA256SUMS.txt` check was rerun successfully. The originating task's
completed handoff was read directly, and a read-only coordination request was
sent; no new reply had arrived at this snapshot. The checked-in dogfood
allocation remains 1025 and stable remains 1026. A new combined dogfood build
needs a reviewed monotonic allocation (for example, 1025.1), not reuse of the
earlier tester's build/tag; finalize that choice before regenerating R7 evidence.

Rendered checks used the generated offline public preview and a separate
synthetic admin fixture server. Desktop 1200px and mobile 390px were inspected:
Intel unavailable state, keyboard return to ARM, 39 model choices plus the two
aggregate filters, all-model selection and the Astra-only view. Both inspected mobile pages have no
horizontal overflow. No hosted admin data was read. Offline community HTTP 503
is deliberate; the admin fixture's missing favicon is not a runtime JS failure.
Both task-owned preview servers and the isolated browser were closed afterward.

Ignored local evidence is under `.release-build/`: `release-0.1.18-final-root.log`,
`release-0.1.18-final-worker.log`, `release-0.1.18-final-intel-build.log`,
`release-0.1.18-final-intel-smokes.log`, `release-0.1.18-intel-js-followup.log`,
and `output/playwright/release-0.1.18/`. These are not public release artifacts.

## Remaining release gates

1. Run the owner-authorized [R7 regeneration workflow](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
   on the combined tree, validate all ten receipts under both pinned runtimes,
   and review the resulting decision/resource states. Existing `release_open`
   export-ceiling decisions are expected by their tests, not a generic macOS
   release blocker; do not expand this release into resource-limit redesign.
2. Qualify physical Intel/macOS 14 behavior, provider discovery, silent Keychain
   handling, consented uploads and installed update/replacement behavior. The
   [Intel plan](../plans/2026-09-03-macos-intel-release.md) retains the hardware
   and tester checklist; Rosetta is supplementary evidence only.
3. Freeze a common final source and reviewed build allocation, obtain explicit
   signing/notarization authority, and produce new combined ARM/Intel artifacts.
   Follow the [macOS release runbook](../runbooks/macos-stable-release-runbook.md)
   for CI, installation, updater, release, website and Homebrew gates. Do not
   silently reuse the earlier tester's artifact identity or advertise Intel
   Homebrew support.

No push, tag creation, production signing/notarization, hosted mutation, system
installation, protected whole-corpus run, feed publication or public release
was performed in this integration follow-up.
