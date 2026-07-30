---
title: G1 Multi-Source Local Export Verification Receipt
date: 2026-07-24
type: verification
status: verified
---

# G1 Multi-Source Local Export Verification Receipt

## Scope

This receipt records the local-only G1 checkpoint that joins bounded Codex rollout history, an explicitly selected prospective Codex collector ledger, and an explicitly selected Claude status-line quota inventory into one deterministic export-set workflow. It also records the production macOS arm64 separation of participant identity and account-observation capabilities.

This is not a G1 release receipt. It does not authorize volunteers, transmission, enrollment, upload, or external data collection. The telemetry contract remains the unfrozen `telemetry-v0.1` local-review draft with `transportReady: false` and `externalParticipantsAllowed: false`.

## Implemented claims

- The CLI requires explicit supplemental source selection. It does not auto-detect Claude state, install a callback, or contact a service.
- Codex collector input is a frozen-prefix, resource-bounded, source-checkpointed local source with sessionless quota semantics.
- Claude quota input is an interval-bounded frozen inventory whose private paths, filenames, and source capability remain inside the owner-only workspace.
- Codex rollout, collector, and Claude source commitments are bound into export-set identity, materialization, verification, and deletion preflight.
- Resume preserves exact occurrence identity and deterministic output without duplicating already committed safe records.
- Source mutation, truncation, replacement, unexpected links, or inventory substitution fails closed and poisons the affected workspace rather than silently changing evidence.
- The privacy gate accepts Claude quota-only bundles but rejects Claude usage-event claims because that adapter is not implemented.
- Supported macOS arm64 production flows use separate exact-pinned Keychain capabilities for export identity and account observation. Explicit environment/file identities remain development overrides.
- Account switching is prospective: foreground observations re-read the current account and capability, while unavailable or locked credentials produce unattributed observations and bounded diagnostics rather than fallback identity.

## Evidence

### Automated matrix

| Check | Result |
|---|---:|
| Node 26.2.0 serial repository suite | 558 passed; 0 failed |
| Node 24.14.0 serial repository suite | 558 passed; 0 failed |
| Generated telemetry contract/schema check | 10 passed; 0 failed; 170 reviewed fields |
| `git diff --check` | Passed |

### Real local collector smoke

An isolated two-hour export used the existing ignored `.usage-monitor/collector-events.jsonl` as an explicitly selected supplemental source and a temporary explicit participant-secret file. The production/default identity was not read, migrated, rotated, or removed.

| Observation | Result |
|---|---:|
| Export status | `scan_complete` |
| Usage records | 237 |
| Quota records | 237 |
| Activity markers | 0 |
| Chunks | 1 |
| Encoded artifact bytes | 30,931 |
| Decoded canonical bundle bytes | 534,840 |
| Independent export-set verification | Passed |
| Providers declared | `openai_codex` |
| Upload | Disabled |

The temporary workspace, bundle, and temporary participant secret were removed after verification. This smoke did not include Claude because no real local status-line state directory was available, and it does not establish same-account continuity across an account switch.

## Independent audit disposition

Three independent passes reviewed security/integrity, runtime/resource behavior, and plan/claim/test completeness. The findings and closures were:

- Collector workspace batches no longer recount and re-hash the whole frozen prefix for every checkpoint. Intermediate batches use descriptor/boundary validation, terminal completion performs one full proof, the trusted line count is committed in the cursor, and a completed resume does not reopen the ledger.
- Foreground rate-limit bursts are bounded to one active and one latest pending snapshot. Every processed snapshot still re-reads the account and Keychain capability; tests preserve account-switch and locked/unavailable behavior. The startup refresh is serialized with notification mutation.
- Valid Claude pre-response records with neither quota window now emit no export records. Window-bearing unscoped records continue to fail closed.
- Production participant identity selection accepts only the exact export-identity Keychain capability; the account-observation and arbitrary capabilities are rejected before backend construction.
- README capability, restricted-field, runtime, and rotation claims now match the implementation and its remaining lifecycle gaps.
- Real parent-driven `SIGKILL` tests cover collector and Claude supplemental checkpoint commits and exact-once resume.
- Combined Codex, collector, and Claude inputs survive interrupted export-set deletion recovery and failed-workspace discard byte-for-byte.

All audit remediations are included in the 558-test matrix on both qualified runtimes.

## Explicit non-claims and open gates

- Claude transcript usage events are not implemented.
- A real Claude subscriber callback with non-null five-hour/seven-day values has not been installed or validated.
- The Claude callback does not yet retrieve its pseudonym capability from Keychain, and install/coexistence/rotation/uninstall behavior remains open.
- Keychain production code has not yet passed a fresh-user packaged install, rotation, preservation/removal, and uninstall smoke.
- The prospective same-account and deliberate account-switch collection smoke remains open.
- The preregistered telemetry minimization study and dated retention decision remain open.
- Candidate resource ceilings are not a measured volunteer-population p95.
- No frozen successor contract, packaged runtime, SBOM, signature, notarization, no-egress artifact proof, clean-machine receipt, or independent volunteer review exists.
- No upload client, enrollment service, cloud bucket, validator, canonical multi-user store, personal web result, aggregate website, notification system, continuous network uploader, or country collection is authorized or implemented.

## Gate result

This bounded local-only checkpoint is verified. It closes the source-integration and production capability-wiring slice, not G1 as a release and not the end-to-end program. The broader [G1 local-only release route](../governance/2026-07-24-g1-local-release-route.md) and [complete end-to-end goal](../goals/2026-07-24-end-to-end-multi-user-usage-monitor-goal.md) remain active.
