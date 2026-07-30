---
title: G1 Claude Local Verification Receipt
date: 2026-07-25
type: verification-receipt
status: partial
---

# G1 Claude Local Verification Receipt

## Outcome

The local-only Claude usage path is implemented and verified on a real owner-local history. The Claude quota callback lifecycle is installed and its pre-response behavior is verified, but the required real non-null five-hour/seven-day callback remains open because the provider rejected the test request with a revoked-OAuth 401 before a response could expose quota windows.

This receipt authorizes no volunteer distribution, upload, transport, or public aggregate. It contains no prompt/response content, paths, account identifier, raw session/message/tool identifier, credential, or row-level pseudonym.

## Real transcript export

The fresh smoke used an empty Codex home, explicitly selected the default owner-local Claude projects inventory, and bounded the interval from 2026-07-01 through 2026-07-25 UTC. The exporter scanned 1,139 frozen transcript sources, canonicalized repeated partial/cross-file copies by logical provider message, expanded provider iteration ledgers without top-level double counting, and produced one deterministic local gzip chunk.

| Measure | Result |
|---|---:|
| Usage events | 21,326 |
| Quota snapshots | 0 |
| Activity markers | 0 |
| Encoded artifact bytes | 1,691,518 |
| Decoded bundle bytes | 32,492,049 |
| Manifest bytes | 6,794 |
| Export wall time | 17.96 seconds |
| Export maximum RSS | 714,031,104 bytes |
| Verification wall time | 1.13 seconds |
| Verification maximum RSS | 560,857,088 bytes |
| Upload/transport | Disabled |

The prior unoptimized real run took approximately 140 seconds before materialization. The optimized run retains full SHA-256 frozen-prefix verification while using a digest-bound planned line count, selected-source-first scheduling, and validate-once plan slicing. The final smoke also includes fail-closed duplicate cache-TTL validation and closed-pipe callback handling added after independent audit.

## Safe aggregate reconciliation

| Component | Export total |
|---|---:|
| Uncached input tokens | 12,937,270 |
| Cache-read input tokens | 5,117,211,487 |
| Cache-write input tokens | 195,432,989 |
| Five-minute cache-write tokens | 57,530,699 |
| One-hour cache-write tokens | 137,902,290 |
| Provider-reported combined output tokens | 28,230,695 |
| Tool calls across reviewed coarse classes | 26,493 |

The five-minute plus one-hour cache-write totals equal the combined cache-write total exactly. The token and tool totals match the independent structural raw-metadata aggregation from the immediately preceding real run. The current export contains one additional zero-token, unrecognized synthetic event created during the provider-authentication test; all nonzero aggregate totals remain unchanged.

An offline `ccusage` 20.0.18 run over the same UTC date bounds provided a second independent local cross-check. Its aggregate differs from this exporter by exactly 2,997 uncached-input, 2,850,194 cache-read, 2,579,864 cache-write, and 813 output tokens. This is fully explained by the two tools' declared iteration semantics: the 19,520 selected messages carrying iteration metadata contain 17 additional provider attempts, and summing those attempts instead of the top-level message totals produces exactly those four deltas. The current [`ccusage` Claude adapter](https://github.com/ccusage/ccusage/blob/739e88fa67b9e584dfa9722c8207fa8b09b62802/rust/crates/ccusage/src/adapter/claude/daily.rs) retains the top-level row and separately extracts advisor iterations; this exporter emits every explicit message/fallback iteration and does not emit the top-level total again. The cache-write reconciliation also accounts for `ccusage` preferring its cache-duration subfields when present. The disagreement is therefore an understood semantics difference, not unexplained parser loss.

Model recognition retained 21,123 reviewed model events and 203 unrecognized events. Unrecognized upstream model strings are represented only by secret-keyed fingerprints; no unknown raw model name is exported. Speed classification retained 19,542 Standard events and 1,784 unknown events. Claude's combined output remains combined and is not relabeled as visible text or reasoning.

The independent set verifier authenticated the manifest, receipt, compressed artifact, decoded canonical bytes, contract tuple, ordering, occurrence uniqueness, and record totals. Verification passed with transport disabled.

After the final audit fixes, the complete integrated repository suite passes 610 of 610 tests under Node 26.2.0 and 610 of 610 under the qualified Node 24.14.0 runtime. Independent code re-audit closed both reported findings with no new issue, and independent plan re-audit found the previously stale live-control statements corrected.

## Callback and quota path

The managed callback is installed in the owner's real Claude settings. It composes with the existing status-line command, stores the separate session-pseudonym capability in macOS Keychain, uses owner-only lifecycle state, and contains no secret-bearing settings, environment value, or command argument. Install/coexistence/restore/removal/failure tests pass 61 of 61 on Node 26 and Node 24, and an independent focused audit found no residual issue in the declared same-user trust boundary.

The live test produced eight structurally valid pre-response status snapshots. All eight correctly omitted quota windows, matching Anthropic's documented behavior that rate-limit fields become available only after the first response. The provider then returned a revoked-OAuth 401, so no response and therefore no non-null five-hour or seven-day snapshot was available. The callback showed a fixed, content-free unavailable state and did not turn the provider failure into a false quota observation.

To close the remaining real-quota gate, the owner must refresh Claude authentication with `/login`, complete one ordinary response, and rerun the content-free ledger inspection. No code change or endpoint polling is required for that retry.

## Remaining claims intentionally withheld

- Claude quota parity is not complete until one real eligible subscriber response yields a validated non-null window.
- `server_tool_use` remains unresolved and is neither exported nor priced until provider-billable semantics are defined.
- The 1.5 GiB candidate RSS ceiling is respected here, but this single-machine result is not a population p95.
- The telemetry contract remains draft, local-only, and unfrozen.
- Packaging, signed/notarized artifacts, deny-all-egress artifact tests, clean-machine proof, and two independent volunteer reviews remain open G1 gates.
