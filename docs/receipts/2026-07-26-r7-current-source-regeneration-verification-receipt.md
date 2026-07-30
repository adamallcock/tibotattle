---
title: R7 Current-Source Regeneration Verification Receipt
date: 2026-07-26
type: verification-receipt
status: complete
---

# R7 Current-Source Regeneration Verification Receipt

## Verdict

The complete ten-file R7 matrix was regenerated against the current 147-file
workload graph on both supported macOS arm64 runtimes: Node 24.14.0 and Node
26.2.0. Every retained receipt is content-free, owner-only, schema-valid,
self-hashed, and bound to workload-code SHA-256
`dcdf2f7872e5a2e29586785349f208c51e41c06202fbfa046359564a454ff16f`.

This receipt supersedes the source-binding claims in the
[July 25 verification receipt](./2026-07-25-g1-r7-measured-release-verification-receipt.md).
That file remains immutable historical evidence for its 122-file workload
graph. It must not be used to claim that the current source is verified.

The regenerated decision remains `release_open`; no resource ceiling was
silently promoted.

## Retained matrix

| Profile | Node 24 receipt SHA-256 | Node 26 receipt SHA-256 | Result |
|---|---|---|---|
| Synthetic semantics | `0020fa87226573dda964f050deabdc9bf69fb313a6a564952d757ce69f5539f4` | `f65eb23cbc18763dcdba8383170c85d65f9fcab532fcd0ab5fd3f910511c49cd` | Partial profile; determinism passed |
| Synthetic pressure | `410d4760c668c749e06599462e97c3cbb7a3f464b20a4f9b39f03803cdd4ab5f` | `a6d18dee6951d5bf8cce3775dd3189bbb9471b925c0ca1fd468520b43d4b2105` | Partial profile; determinism passed |
| Materialized boundaries | `4ccf8eaca620e766732495984470c38c854a042540fa16a2d52862d38a925cc8` | `fef886a509cf4708296748be6ed49cd93f8d7770636aa557c9e649d92c114471` | Partial profile; candidate boundaries remain unidentified |
| Real local history | `6afda7ccc8f1a08d5967600411429c81bee1ce3206c58d00562d15a7492f6404` | `5e325ea1dbc11714074657590e854aa51e14a2b5405cc1974beff92642e17073` | Partial profile; determinism passed |
| Decision | `a6cb13c2c752e9b066c57361a6e71a316ab7822266f90c85ea94f1c461400cdd` | `206827b99f978ad3307c9077ba33c54893d147167c5571edddc13c1491220018` | `release_open` |

`test/r7-generated-release-evidence.test.js` revalidated all ten files and
rebuilt each runtime's decision exactly from the other eight inputs. It passed
2 of 2 under Node 24.14.0 and 2 of 2 under Node 26.2.0.

The supported serial repository command, `npm test`, subsequently passed 895
of 895 tests. `git diff --check` also passed.

## Current real-history observation

The frozen interval remains `2026-06-24T09:00:00.000Z` through
`2026-07-25T09:00:00.000Z`. Each runtime performed two fresh deterministic
passes.

| Observation | Current value |
|---|---:|
| Source files | 2,699 |
| Frozen source-prefix bytes | 24,010,521,824 |
| Exported metadata records | 441,290 |
| Node 24 source-scan elapsed | 504,261 ms |
| Node 26 source-scan elapsed | 490,845 ms |
| Worst observed durable RSS | 809,025,536 bytes |
| Source paths retained | No |
| Raw content or row-level data retained | No |
| Identifiers or timestamps retained | No |
| Private RSS samples retained | No |
| Prohibited-data scan | Passed |

The logical metadata record count remains exactly 441,290 even though the
frozen physical source inventory grew. This is consistent with deterministic
deduplication of replay-bearing local logs rather than treating every copied
rollout as new usage.

## Release boundary

This closes the stale-current-source evidence defect. It does not close the
resource-ceiling decision: both runtime decisions correctly remain
`release_open`. It also does not replace clean-machine, signing, notarization,
or volunteer approvals.
