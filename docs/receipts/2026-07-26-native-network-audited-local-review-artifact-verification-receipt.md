---
title: Native-Network-Audited Local Review Artifact Verification Receipt
date: 2026-07-26
type: verification-receipt
status: complete
---

# Native-Network-Audited Local Review Artifact Verification Receipt

## Verdict

A current-source macOS arm64 local-review artifact was built twice from clean
commit `11fc5400855fcd13bd5c68f046e2acaa8e107f24` with one fixed
`SOURCE_DATE_EPOCH`. The two 146,447,872-byte archives and their manifests were
byte-identical.

The artifact passed its complete 12-command isolated-home lifecycle twice:
once with macOS network denial and once without denial. Across both runs, every
artifact process recorded zero covered JavaScript network API attempts and zero
covered native libc IP-socket or resolver attempts. Private canary hits were
zero, the export set independently verified, complete-set deletion passed, and
ordinary uninstall preserved the participant identity.

This supersedes the exact-artifact claims in the earlier
[JavaScript-network-audited receipt](./2026-07-26-network-audited-local-review-artifact-verification-receipt.md).
That receipt remains immutable historical evidence for its older archive.

## Exact artifact

| Field | Value |
|---|---|
| Artifact | `usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64.tar` |
| Source commit | `11fc5400855fcd13bd5c68f046e2acaa8e107f24` |
| Archive bytes | `146447872` |
| Archive SHA-256 | `f84246d753c165a2e6145fba0ac6065c5e8b76ca40098d5256d7965b077355a8` |
| Manifest SHA-256 | `4203ff82eb20586ff0d5a19e6e1582a6a3ed87736ed757c8053ed07e776d864b` |
| Native audit library SHA-256 | `f5812e097ddc577169df67451aaa63ad0926b0587456cb04b5e0223bb4b15dfa` |
| Platform/runtime | macOS arm64 / Node 26.2.0 |
| Signing/notarization | Unsigned / not notarized |
| External participants authorized | No |

The retained engineering candidate is under `.release-repro/d/`. The second
build under `.release-repro/e/` exists only as reproducibility evidence and is
not a distinct release candidate.

## Workflow exercised

The exact sequence was:

1. inspect artifact;
2. install to an explicit target;
3. doctor;
4. inspect export;
5. export local bundle;
6. independently verify bundle;
7. materialize export set;
8. independently verify export set;
9. deletion preflight;
10. confirmed complete-set deletion;
11. uninstall preflight; and
12. confirmed uninstall.

Both the sandboxed and unsandboxed executions passed all 12 commands.

## Attempt-telemetry boundary

The JavaScript preload covers Node TCP client/server, TLS, DNS callback and
promise APIs, HTTP/1, HTTP/2, UDP, fetch, WebSocket, and EventSource. The native
macOS interposer covers libc IPv4/IPv6 socket and resolver entrypoints,
including connect, bind, listen, accept, send/receive variants,
`getaddrinfo`, `getnameinfo`, and legacy hostname lookup functions.

Positive controls prove that each layer records loopback socket and DNS
attempts. The unsandboxed workflow is therefore important evidence that zero
observed attempts are not merely suppressed by the sandbox.

The following remain explicitly unmeasured:

- direct machine-code syscall instructions that bypass libc;
- QUIC/network frameworks outside the covered interfaces; and
- networking in non-Node child processes.

The artifact currently launches no such child process in the tested workflow,
but this receipt does not generalize beyond the exact shipped graph and command
sequence.

## Verification

- Native and JavaScript focused audit tests passed.
- Exact R7 generated evidence passed 2 of 2 on Node 24.14.0 and 2 of 2 on Node
  26.2.0.
- The supported serial repository suite passed 895 of 895.
- Two deterministic builds produced archive SHA-256
  `f84246d753c165a2e6145fba0ac6065c5e8b76ca40098d5256d7965b077355a8`.
- Network-denied smoke: 12 processes, 0 JavaScript attempts, 0 native libc
  attempts.
- Network-allowed smoke: 12 processes, 0 JavaScript attempts, 0 native libc
  attempts.
- `git diff --check` passed before the source-bound commit.

## Remaining boundary

This is a private engineering candidate, not a volunteer release. Developer ID
signing, notarization, a genuinely clean macOS arm64 machine, exact
privacy/consent approval, and two independent reviews remain hard gates.

