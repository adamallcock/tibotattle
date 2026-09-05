---
title: macOS combined 0.1.18 RC3 signed candidates
date: 2026-09-04
type: receipt
status: verified
---

# macOS combined 0.1.18 RC3 signed candidates

Both corrected Astra/Intel RC3 installers are signed, notarized and independently
verified against their exact final bytes. The ARM app has been copied from its
final DMG into Applications and passes production installed-artifact validation.
Normal launch and installed migration are **not yet qualified**: the computer
locked before observable launch, and the UI tool refused to proceed. A subsequent
process-name check found no running TiboTattle process. No unlock or security
prompt was bypassed. Public stable publication remains held.

## Frozen source and artifacts

Both finalizers exited zero from clean source
`7701debf44e046ac9f25bb74f7214532e32c5c5d`, using local annotated tag
`tibotattle-internal-dogfood-0.1.18-rc3-source-20260904`. The tag is not pushed.
Both artifacts have version `0.1.18`, build `1025.2`, bundle identity
`com.usagemonitor.local`, channel `internal-dogfood`, and minimum macOS `14.0`.
Stable build `1026` remains unbuilt; RC3 must not be relabeled stable.

| Property | Apple silicon | Intel |
| --- | --- | --- |
| Filename | `TiboTattle-0.1.18-macOS-arm64.dmg` | `TiboTattle-0.1.18-macOS-x64.dmg` |
| Bytes | 49,908,785 | 52,130,529 |
| Final DMG SHA-256 | `8bfcf693443d53668e66026b995436633b620996c90cc164fde54485c56e2539` | `71cc8e1f3976a16bdac63895219027826085ca849bcf380cd2bcb79dcc88f424` |
| Adjacent release receipt SHA-256 | `b538d95af322b49ec26fa490c2824a399e39e59d1052f405b3675e7dd43cc284` | `f95b066e0119097d2125d0bd09e0618c9934759a407cd63b856cf9069c597604` |
| Normalized signed-app payload SHA-256 | `f790d439735e86a36ddfd61c690aee80c19aec17e1f3123dc69f1797062f1e02` | `d12006e418c781319c0d4e9d9a0446552aa70aaac7d360a4ea32706d47f0b9fb` |
| Source-input SHA-256 | `21b8a07278a5054dd0460e75d257495fc4271e944964436abe3e238980662931` | `dd3684df4bb7a8e3996694f88e211c9819d4d0802de9f8354a83343ed20b96fb` |

Private final artifacts, adjacent sanitized release receipts and validation
logs are retained under ignored `.release-build/combined-signed-rc3-20260904/`.
Only selected installer/checksum/tester-guide files are suitable for tester
handoff; do not transfer the complete worktree, credentials, or retained state.
The artifact directory is owner-only; final DMGs and tester files are read-only
`0444`, with adjacent release receipts restricted to `0400`.

The new RC3 `SHA256SUMS.txt` has SHA-256
`3d282086328ee899a8a8d52a847a897fe962f9080c271dad6bad63cd05b92a86`;
the new `TESTER-README.md` has SHA-256
`fb91c145f9ef1d5883e4f5da93ecdba43b8e2b37b10a95994abd51cbffea30ee`.
Both DMGs pass the checksum file. Manual and physical Intel fields remain
unfilled; the guide does not assert an unobserved installed update or upload.

## Completed verification

- Both finalizers reproduced the reviewed candidate from the frozen clean
  source, applied Developer ID hardened signing, obtained Apple acceptance,
  stapled app and DMG tickets, and passed Gatekeeper and isolated-profile smoke.
  All eight recorded assurance fields are true.
- Independent final-artifact validation checks architecture, identity, version,
  build, channel, source/tag, payload/source-input digests and exact DMG
  size/SHA. Read-only mounts confirm both Finder app directory dates equal
  source timestamp `2026-09-05T02:45:51.000Z`. Final bytes remain unchanged.
- Same-architecture signed RC2-to-RC3 replacement validation passes for both
  ARM and Intel (`1025.1` to `1025.2`). The updater and manual prior-signed-DMG
  rollback contract are present. This is artifact compatibility, not a physical
  installed A-to-B test.
- The verified ARM app was copied from its final read-only-mounted DMG using
  Finder's explicit newer-app replacement. Its installed source, build and
  payload match the final ARM artifact. Production installed validation passes
  without development-mode allowances. Its fake-manager smoke remains isolated,
  not a real Login Item or normal working-profile launch.

The builder is Apple silicon with pinned Node `26.2.0` and Sparkle `2.9.3`;
the verified Intel Node runtime is preserved. Intel execution on this host uses
Rosetta, which does not supply physical Intel qualification. No signing-key
prompt was approved, credential protection broadened, or Keychain item reset.
Apple notarization was authorized; no public release, feed, source push or
hosted deployment occurred.

## Preservation and source qualification

Immediately before Finder replacement, the stopped app's full state, preferences
and exact stable `0.1.17` / `1024` bundle matched the rollback copy: 607 files,
167 directories, nine preserved symlinks and 27,227,038,463 regular-file bytes.
No state handles remained, native preferences matched canonical plist XML, and
contribution pause was true. The original plist-to-JSON diagnostic refusal is
retained; XML comparison supports valid plist-only types without relaxing the
comparison. The old app is recoverable from the retained verified rollback copy.

RC1's four retained files and both RC2 DMGs/receipts still match their historical
hashes. RC2 tester files match their fresh before/after RC3 baseline. No RC1/RC2
artifact was overwritten. The [installed-upgrade review](../reviews/2026-09-04-installed-upgrade-readiness.md)
records the completed copy-only v14 semantic/accounting proof. It is not evidence
that the working state has undergone that migration. After migration, rollback
requires the matching pre-upgrade state and old app together; never reopen
upgraded state with an older reader.

The full source run records 3,859 passing tests, zero failures and seventeen
existing native-Windows skips. Both pinned-runtime R7 freshness/reconstruction
checks pass after all ten fresh receipts were installed. Their unchanged open
resource decisions, measurement limits and original aborted diagnostic remain
explicit in the [preparation plan](../plans/2026-09-04-release-0-1-18-publication-preparation.md).

Handoff documentation governance passes across 144 Markdown and 658 source/config
files; preflight passes 20/20. Node 26.2.0 R7 freshness, release-note and release
evidence tests pass 35/35, and Node 24.14.0 R7 freshness/reconstruction passes
2/2. No new skips, source-policy changes or receipt regeneration were introduced
by this documentation handoff. Later documentation commits do not move the
frozen RC3 source tag or relabel its artifacts.

A fresh history-free client source export from clean documentation commit
`473dd67b7116f26000023a6b1b487bc77a710813` passes its independent manifest,
exact allowlist, source-byte, import-boundary and forbidden-path checks: 384
files, including 376 source files and the Login Item release-validation CLI.
Manifest SHA-256 is
`7e3bbb13b2c3a01ad5acc261427e3904a817117594290e5d6250a99af59aee18`.
Three entrypoint syntax checks and browser telemetry-mirror verification pass.
The separate telemetry check cannot resolve its uninstalled workspace package;
the full client gate requires dependency installation and native builds and
was not run. The export remains unchanged and contains no Git history,
node_modules or private lockfile. No dependencies, network, signing or user-state
access were added by this check; this is a source-boundary result, not a new
packaged-runtime or publication claim.

## Uncompleted gates

Resume the authorized installed ARM launch, detailed refresh, generation-bound
accounting and restart observation once the owner unlocks the Mac. Unexpected
Keychain prompts remain release-blocking; do not approve them automatically.
Real clean-profile/manual-v2 Login Item evidence and physical Intel evidence
are still absent. A disposable profile is required for ARM manual qualification.
A physical Intel tester or an explicit owner decision to exclude public Intel
is separately required to resolve the Intel scope; ARM-only scope does not
waive the ARM lifecycle gate.
The 0.1.17-only manual deferral does not carry forward.

Stable `1026` requires its own clean annotated source, final signing, native
and installed proof, ARM previous-stable continuity and explicit Intel bootstrap
if Intel is included. Source/CI, stable assets/appcasts, hosted migrations and
deployment, and public download checks remain separate gates. Follow the
[macOS release runbook](../runbooks/macos-stable-release-runbook.md); this receipt
does not declare publication readiness.
