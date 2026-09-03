---
title: Separate macOS Intel build and release
date: 2026-09-03
type: plan
status: in-progress
---

# Separate macOS Intel build and release

Start Intel work independently of the Apple Silicon 0.1.17 publication. Keep
one codebase, two thin installers, and explicit platform availability on the
website. This plan records intended work and local implementation evidence;
it does not declare Intel supported or a candidate publicly released.

Baseline: `394c8a03a986e0daadbe662679fd002202682e44`, reviewed 2026-09-03,
package version 0.1.17. The task branch is `codex/macos-intel-foundation`.
The existing [feasibility report](../research/2026-08-31-macos-intel-universal2-feasibility.md)
records earlier probes against a different source revision; it does not qualify
this baseline's newly added native Keychain migration helper.

Current operational authorities remain the
[macOS release runbook](../runbooks/macos-stable-release-runbook.md) and
[platform support matrix](../reference/platform-support.md).

## Version and publication boundary

The user requested an Intel 0.1.17 alongside the Apple Silicon release already
being prepared. macOS permits the same marketing version on two architectures,
but the current release contract binds every artifact to the same version, tag,
and source commit. The reviewed baseline needs source changes to build Intel.

- Before the stable source is frozen, a deliberate hold could allow Intel
  changes into one common commit, followed by fresh qualification of both
  architectures and both installers in the draft release.
- Once the source is frozen, a later Intel source commit cannot honestly use
  that tag. Once the release is immutable, its assets cannot be appended or
  replaced. See [GitHub's immutable-release contract](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
- A separate later release still displaying 0.1.17 would require a deliberately
  designed architecture-specific source/provenance contract. It is not an
  existing release option and is not introduced by this foundation.
- The recommended path is to let 0.1.17 proceed unchanged, qualify Intel, then
  use the next available numeric version. Version/build allocation remains
  pending; this branch does not move a tag, bump a version, or alter a feed.

The live GitHub release-by-tag read returned 404 during this investigation.
That observation does not authorize interrupting the owner's release work or
imply that a release could not have been created subsequently.

## Initial implementation boundary

- [x] Explicit Intel development/test target on the existing pinned arm64
  builder, using the verified official Node 26.2.0 x64 runtime.
- [x] Compile both the native launcher and Keychain migration helper for
  x86_64; record truthful runtime architecture in bundle metadata.
- [x] Retain Apple Silicon defaults and reject Intel Preview/external-release
  construction until those contracts are implemented and qualified.
- [x] Admit the capability-scoped native broker in the participant and account
  observation selectors on x64. Preserve legacy binding restrictions, secret
  separation, error redaction, and failure behaviour.
- [x] Add distinct macOS Apple silicon and macOS Intel website tabs. Intel is
  unavailable until a verified release exists: no invented download, checksum,
  Homebrew command, release version, or signing claim.
- [x] Validate focused source tests, actual Intel compilation/synthetic smoke,
  Apple Silicon regressions, and rendered desktop/mobile website behaviour.

Development output is not a distributable installer. Routine probes must use
synthetic data and isolated state, without real Keychain access, application
replacement, login-item changes, Developer ID signing, notarization, or
publication. The local builder retains its existing ad-hoc signing step.

## Local verification on 2026-09-03

These are working-branch results, not release receipts or physical Intel
qualification. No source tag, release allocation, published artifact or feed
was changed.

| Check | Result and limitation |
|---|---|
| Native Intel builds | Both test and optimized compiler profiles built ad-hoc development apps; launcher, migration helper and Node each contain exactly `x86_64` |
| Optimized build identity | Source digest `371029bf3212beae5f2d7e890eefdddad80a6e49823e68dabc8cc0c53cce1b35`; normalized payload digest `4fdc6cdb9c2a247863b8b51a6ccacdd40354f360d31f4fbbb5ac4720282797ac`; 156,861,094 payload bytes, not an installer size |
| Intel native probes | Four contract probes passed on both profiles under Rosetta: fake login items, memory-only Keychain broker, migration UI and disabled updater; no real Keychain access or service changes |
| Intel companion lifecycle | The optimized launcher started its bundled Intel Node companion, received ready health over loopback, and stopped it cleanly in fresh empty test homes, with both normal and JIT-less runtime modes; this is not real-user ingestion or physical Intel qualification |
| Credential tests | 60 selector/broker tests passed, including x64 capability separation and failures; synthetic adapters only |
| Native source lane | 109 tests passed across its subprocesses; three artifact cases intentionally excluded from this source lane |
| Native artifact lane | 113 tests passed across preflight, native bundle and updater subprocesses, with no skips; retains Apple Silicon reproducibility, lifecycle and release-refusal checks |
| Website | 489 UI tests and 33 release-site tests passed; real public metadata/aggregate used only in the local generated preview |
| Browser | Distinct tabs, Intel unavailable state, restored ARM download, arrow-key navigation and explicit selection persistence checked; English, Spanish and Simplified Chinese inspected; no horizontal page overflow at approximately 320/375 and 1440 CSS pixels |
| Repository checks | Architecture, documentation and preflight checks passed; independent source review found no actionable selector or runtime-staging issue |

The initial socket-dependent test attempt was blocked by the sandbox's loopback
restriction; the authorized local-socket rerun passed. Worker dependencies were
installed from their lockfile before the complete release-site gate was run.
Neither environment issue was resolved by skipping assertions or loosening a
release rule.

## Gates before an Intel release

1. Define architecture-aware release metadata, source provenance, filename and
   evidence contracts, and allocate monotonic tester/stable build numbers.
2. Create reviewed Intel test/stable feed policy and matching publisher/Worker
   checks. Preserve the existing Apple Silicon endpoints and trust chain. The
   development build remains updater-disabled; it is not a test feed.
3. Qualify all nested Intel binaries, including the five Sparkle binaries, and
   the final signed/notarized/stapled artifact's source and payload integrity.
4. Test on physical Intel hardware at the declared macOS floor: offline usage,
   provider discovery, attribution, native lifecycle, login items, clean install,
   and prompt-free Keychain operation. Rosetta is supplementary evidence only.
5. Prove Intel candidate A updates to B, cross-architecture delivery is refused,
   invalid feed/signature/version data is rejected, and first-feed bootstrap
   does not borrow an Apple Silicon installation's update history.
6. Preserve an Intel-compatible recovery artifact and state backup when needed;
   an ARM-only 0.1.17 app cannot recover an Intel installation.
7. Make website/Homebrew selection agree with actual published artifacts before
   advertising Intel as available. Verify public bytes and real installation
   after the normal immutable-release/publication sequence.

Signed probes, physical-hardware checks and publication remain separate gates.
Source tests and a development app must not be presented as those receipts.
