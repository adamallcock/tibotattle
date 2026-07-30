---
title: Unsigned Local Review Artifact Verification Receipt
date: 2026-07-26
type: verification
status: passed-with-external-gates
---

# Unsigned Local Review Artifact Verification Receipt

## Verdict

The macOS arm64 local-review artifact is a reproducible, transport-free,
unsigned engineering candidate. It is suitable for continued local engineering
review. It is **not** authorized for external participants because Developer ID
signing, Apple notarization, a genuinely clean-machine run, direct
network-attempt telemetry, approved privacy/consent wording, and two independent
local-only reviews remain open.

## Exact candidate

| Property | Value |
|---|---|
| Source commit | `fd19f2f062ddff1380fb62dbed42dd0012f796ca` |
| Source tree at build | clean |
| Artifact | `usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64.tar` |
| Archive bytes | `146447872` |
| Archive SHA-256 | `f380ffd75eef1382003b2b412d47ca1e5c87b47f9e55014e6abc23731e4df430` |
| Manifest SHA-256 | `ee33c77f18545fb97031f2b05546e0eb537ab1b6951fee1f24a74b6a9cbe9ea0` |
| Source-input SHA-256 | `15725fa5b071b74cf62b9e84e687380da88392d969522886e46d8f38dd30ad3e` |
| Archive file entries | `245` |
| First-party static graph files | `72` |
| Bundled runtime | Node.js `26.2.0`, darwin arm64 |
| Signing | unsigned |
| Notarization | not notarized |
| External participants authorized | false |

The second independent build produced the same archive SHA-256 and was
byte-for-byte identical under `cmp`.

## Artifact contents and exclusions

The artifact contains:

- the dedicated `local-review/cli.js` entrypoint;
- the exact reachable local export, verification, deletion/discard, identity,
  and Claude callback modules;
- the pinned Node runtime and audited macOS arm64 Keychain binding;
- the offline RunCost pricing kernel;
- required JSON schemas and frozen local-review release contract;
- a closed manifest and checksum projection;
- CycloneDX 1.5 SBOM, license inventory and license texts;
- deterministic provenance; and
- a first-party private-data/source-map scan receipt.

The static graph has no reachable Node HTTP, HTTPS, HTTP/2, TCP, TLS, DNS, or
datagram builtin. The built tree contains no contribution-device, upload queue,
backend, local web server, app-server quota probe, automatic updater, or source
map. The privacy scan inspected 22 first-party/contract files and found zero
private-path, temporary-path, owner-name, email, credential, private-key, or
source-map hits.

## Runtime smoke

The isolated-home smoke ran every command through:

```text
sandbox-exec -p "(version 1) (allow default) (deny network*)"
```

The following 12 stages passed:

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

The synthetic source embedded session, prompt, and path canaries. Zero canaries
appeared in the bundle or privacy receipt. Ordinary uninstall removed the exact
installed tree and preserved the separate participant identity.

Network denial proves that these workflows require no outbound connectivity.
It does not distinguish zero attempted sockets from blocked attempts; the smoke
receipt deliberately records `networkAttemptTelemetry: not_measured`.

## Test evidence

| Check | Result |
|---|---|
| Local-review parser/install lifecycle | 9 of 9 passed |
| Focused export/verify/delete/discard/contract regression set | 67 of 67 passed |
| Telemetry contract generation and validation | 11 of 11 passed; 178 fields current |
| Worker checks | TypeScript and script checks passed |
| Worker tests | 65 of 65 passed |
| Worker deployment dry-run | passed |
| Staging containment configuration | passed as safely unprovisioned |
| Reproducibility | two archives byte-identical |
| Archive extraction | 245 entries, extracted artifact reverified |
| Deny-network isolated-home artifact smoke | 12 stages passed |

The broad repository suite still has two pre-existing failures in
`test/r7-generated-release-evidence.test.js`: retained R7 receipts declare 122
workload-source files while the current committed baseline enumerates 147. This
change deliberately touched none of the R7-hashed inputs (`src`, `contracts`,
`schemas`, `generated`, `package.json`, `pnpm-lock.yaml`, or the two R7 worker
scripts), so regenerating or changing those historical receipts was kept out of
this artifact slice.

## Destructive-boundary audit

The installer:

- accepts only an absolute target whose parent already resolves;
- refuses an existing target;
- verifies the entire bounded manifest before creating the target;
- streams file hashing so the 137 MB runtime is not buffered as one install
  object;
- uses no overwrite copy;
- rolls back only paths it created if installation fails; and
- writes the exact owner-only install receipt last.

The uninstaller:

- requires the canonical target and owner-only receipt;
- verifies the exact file and directory tree, refusing unexpected user files;
- verifies every installed digest before mutation;
- requires a receipt-bound confirmation token;
- removes only the receipt inventory and its known empty directories; and
- preserves participant identity and makes no secure-erasure claim.

The builder refuses output outside the repository's reserved `.release-build`
or `.release-repro` trees, requires a private build-root marker before replacing
an existing output, rejects symlinked output parents, and writes the
deterministic archive with complete-write loops.

## Open gates

1. Add direct DNS/socket-attempt recording and bind a zero-attempt receipt to
   the exact artifact digest.
2. Decide whether separately confirmed participant Keychain identity removal
   is required; ordinary uninstall intentionally preserves it.
3. Sign and notarize the exact reproducible artifact.
4. Run the full lifecycle on a genuinely clean macOS arm64 account or machine.
5. Approve exact privacy and local-review consent wording.
6. Complete two independent local-only reviews after all preceding gates close.
