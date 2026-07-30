---
title: Network-Audited Local Review Artifact Verification Receipt
date: 2026-07-26
type: verification
status: passed-with-native-and-external-gates
---

# Network-audited local review artifact verification

## Verdict

The unsigned macOS arm64 local-review artifact now has cryptographically bound,
positive-control-tested JavaScript network-attempt telemetry. Every process in
the 12-stage install, inspect, export, verify, deletion, and uninstall journey
recorded zero attempts through the covered Node networking APIs.

The same journey also passed inside macOS `sandbox-exec` with `deny network*`.
This proves that the artifact requires no network access and that the covered
JavaScript APIs were not attempted. It does **not** prove zero native syscalls,
QUIC attempts, or networking by a non-Node child process. Those remain explicit
gaps, and external participants remain unauthorized.

## Exact candidate

| Property | Value |
|---|---|
| Source commit | `af38bc19dd3c459fda9e92d889abbc5369b7c80a` |
| Source tree at build | clean |
| Artifact | `usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64.tar` |
| Archive bytes | `146447872` |
| Archive SHA-256 | `22e0b6db6a0725eff48fa0d2179fd0f7b7f066f4a1aa9c299f9f329df5ebdc27` |
| Manifest SHA-256 | `2cdbb5f2ca6047fefaca2242b60fc634ee572cb7dda9a16ca159a73dff094022` |
| Functional source-input SHA-256 | `15725fa5b071b74cf62b9e84e687380da88392d969522886e46d8f38dd30ad3e` |
| Archive entries | `245` |
| First-party static graph files | `72` |
| Bundled runtime | Node.js `26.2.0`, darwin arm64 |
| Signing | unsigned |
| Notarization | not notarized |
| External participants authorized | false |

Two clean-source builds used the same committed revision and source-date epoch.
Their archives were byte-identical under `cmp` and returned the same SHA-256.
The functional source-input digest is unchanged from the prior unsigned
candidate because the audit preload and smoke runner are external verification
tools and are not shipped in the participant artifact. The archive digest
changed because provenance now binds the newer committed revision.

## Attempt instrumentation

The external CommonJS preload runs before the artifact entrypoint and replaces
the standard Node network entrypoints with fixed blocking counters. It covers:

- TCP client creation and server listening;
- TLS client creation;
- callback, promise, and resolver DNS methods;
- HTTP/1 and HTTP/2 clients;
- UDP bind, connect, and send;
- global `fetch`;
- global `WebSocket`; and
- global `EventSource`.

Each process writes one exclusive, owner-only, size-bounded receipt containing
only fixed category names and integer counts. The release smoke rejects a
missing, malformed, truncated, group-readable, oversized, category-inconsistent,
or non-zero receipt.

The aggregate smoke receipt binds the result to:

- archive SHA-256 and byte size;
- artifact manifest SHA-256;
- exact artifact name;
- command list and process count;
- instrumentation version and coverage booleans; and
- separate native enforcement and native-attempt-measurement states.

The preload itself is outside the artifact graph. It cannot introduce
networking or upload machinery into the participant bytes.

## Positive controls

Four focused tests passed:

1. an inert Node process wrote a zero-attempt owner-only receipt;
2. a deliberate `fetch` was counted and blocked before transport;
3. deliberate TCP and DNS calls were independently counted and blocked; and
4. a relative receipt path was rejected and an existing receipt was never
   overwritten.

The deliberate URL, hostname, path, PID, working directory, arguments, and
receipt path did not appear in the receipts.

## Exact artifact lifecycle

The following 12 processes each produced a valid zero-attempt receipt:

1. artifact integrity inspection;
2. explicit-target install;
3. installed runtime doctor;
4. local export preview;
5. local bundle export;
6. independent bundle verification;
7. disk-backed export-set creation;
8. independent export-set verification;
9. complete-set deletion preflight;
10. confirmed exact-inventory deletion;
11. exact-receipt uninstall preflight; and
12. confirmed uninstall.

The sandboxed run recorded:

| Field | Result |
|---|---|
| Audited processes | `12` |
| JavaScript networking API attempts | `0` |
| Instrumentation | `node_api_interposition_v0.1` |
| Native network enforcement | `sandbox-exec_deny_network` |
| Native syscall attempt telemetry | `not_measured` |
| Private canary hits | `0` |
| Participant identity preserved after uninstall | `true` |
| Overall result | `passed` |

A second run without the OS sandbox also recorded zero covered JavaScript API
attempts across all 12 processes. That second run is a control for the
interposition layer; it is not evidence about native syscalls.

## Verification evidence

| Check | Result |
|---|---|
| Network audit positive controls | 4 of 4 passed |
| Local-review parser/install lifecycle | 9 of 9 passed |
| Two-build reproducibility | byte-identical |
| Archive extraction | 245 entries |
| Extracted artifact self-verification | passed |
| Deny-network 12-stage smoke | passed; 0 covered API attempts |
| Non-sandboxed 12-stage smoke | passed; 0 covered API attempts |
| Private source canaries | 0 hits |
| Ordinary uninstall | exact tree removed; participant identity preserved |

## Remaining gates and non-claims

1. Add native syscall-level attempt telemetry if G1 requires a literal
   zero-attempt claim rather than the current JavaScript-zero plus OS-denial
   evidence.
2. QUIC and non-Node child-process attempt telemetry remain unmeasured.
3. Decide whether separately confirmed participant Keychain identity removal
   is required; ordinary uninstall intentionally preserves it.
4. Sign and notarize the exact reproducible artifact.
5. Repeat the lifecycle on a genuinely clean macOS arm64 account or machine.
6. Approve the exact privacy and consent wording.
7. Complete two independent local-only reviews after all preceding gates close.

This receipt closes the direct JavaScript DNS/socket-attempt measurement gap.
It does not close signing, notarization, clean-machine, native-attempt,
owner-approval, or volunteer gates.
