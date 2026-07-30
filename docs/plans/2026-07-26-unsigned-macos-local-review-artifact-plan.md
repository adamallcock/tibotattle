---
title: Unsigned macOS Local Review Artifact Plan
date: 2026-07-26
type: plan
status: active
---

# Unsigned macOS Local Review Artifact Plan

## Outcome

Produce a reproducible, inspectable, transport-free macOS arm64 artifact that a
participant can use to inspect and export privacy-minimized Codex and Claude
Code metadata locally. The artifact is an engineering release candidate, not a
volunteer release: Developer ID signing, Apple notarization, a genuinely clean
Mac, approved consent wording, and two independent local reviews remain hard
external gates.

## Frozen scope

The artifact:

- bundles the exact Node.js 26.2.0 arm64 runtime and the audited arm64 Keychain
  binding;
- contains a dedicated local-review CLI whose reachable source graph excludes
  enrollment, pairing, upload, queues, remote configuration, HTTP servers, and
  contribution transport;
- can inspect, export, verify, rotate local pseudonym identities, manage the
  local Claude status-line callback, delete complete export sets, discard
  incomplete workspaces, install to an explicit target, and uninstall from an
  exact install receipt;
- preserves the participant identity on ordinary uninstall and makes no secure
  erasure claim;
- includes deterministic checksums, a CycloneDX SBOM, license inventory,
  provenance, a closed file inventory, and a privacy scan receipt; and
- is tested under an operating-system deny-network profile.

The artifact does not:

- upload or accept data;
- include the backend, participant portal, device pairing, sync queue, or
  contribution preparation code;
- install a daemon, launch agent, browser extension, or automatic updater;
- remove Keychain identities during ordinary uninstall;
- claim code signing, notarization, clean-machine compatibility, or volunteer
  authorization.

## Release contract

`local-review/release-contract.json` is the separate frozen
distribution contract. It does not mutate or promote the existing draft
telemetry-v0.1 contract and does not authorize external collection.

The permitted command families are:

1. artifact and environment inspection;
2. local metadata preview, export, and verification;
3. exact-inventory export deletion and failed-workspace discard;
4. participant pseudonym rotation;
5. Claude callback inspection, install, recovery, rotation, uninstall, and
   separately confirmed callback-capability removal; and
6. explicit-target install and exact-receipt uninstall.

## Build design

The builder starts at `local-review/cli.js`, resolves the complete static
relative import graph, and copies only reachable source and referenced
contracts/schemas. It fails closed on:

- any reachable contribution, device, sync, backend, web-server, or transport
  module;
- `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns`, or
  `node:dgram`;
- global `fetch`, WebSocket, EventSource, or source maps;
- undeclared third-party packages;
- private local paths, obvious credentials, email addresses, or fixture
  residue in the built tree; or
- a Node runtime or native binding digest different from the pinned contract.

The archive ordering, modes, uid/gid, and timestamps are fixed. Two builds from
the same source tree and `SOURCE_DATE_EPOCH` must have identical SHA-256
digests.

## Verification matrix

| Gate | Local evidence | Release implication |
|---|---|---|
| Static import closure | Closed graph and forbidden-capability scan | Transport code absent from artifact |
| Two-build reproducibility | Identical archive SHA-256 | Unsigned build reproducible |
| Runtime pin | Node and Keychain binding digests match contract | Exact native/runtime inputs |
| Artifact integrity | Every shipped file verified against manifest | Tamper detection before use/install |
| Isolated install | Explicit absent target, exact receipt, no overwrite | Bounded installation |
| Local workflows | Doctor, inspect, export, verify, rotation preflight, deletion/discard preflights | Command surface works from artifact |
| Network isolation | Every process emits positive-control-tested JavaScript and macOS libc attempt receipts; the complete workflow succeeds both under `sandbox-exec` network denial and without that denial | Covered Node APIs and native libc IP-socket/resolver entrypoints record zero attempts in both runs; direct syscall instructions, QUIC frameworks, and non-Node child attempts remain unmeasured |
| Uninstall | Exact receipt, modified-file refusal, identity preserved | Bounded removal without overclaiming identity erasure |
| Private-data scan | No prohibited path, credential, email, source-map, or fixture hit | Built tree is distribution-minimized |

## Explicit open gates

- Freeze a successor telemetry/receipt compatibility contract only after the
  local-review artifact is proven; the current export contract remains draft
  and transport-disabled.
- The external JavaScript preload and macOS libc interposer bind zero covered
  attempts across 12 processes to the exact current archive and manifest
  digests in both denied and permitted network environments. Direct
  machine-code syscall instructions, QUIC frameworks, and non-Node child
  attempts remain explicitly unmeasured; do not shorten this to an absolute
  "zero network attempts" claim.
- Implement separately confirmed participant Keychain identity removal if the
  owner decides that is required for G1. Ordinary uninstall intentionally
  preserves it.
- Sign and notarize the exact reproducible artifact.
- Repeat the complete matrix on a genuinely clean macOS arm64 account/machine.
- Obtain owner approval of exact privacy and consent wording, then complete two
  independent local-only reviews.
