---
title: Separate macOS Intel build and release
date: 2026-09-03
type: plan
status: in-progress
---

# Separate macOS Intel build and release

Implement separate Apple silicon and Intel installers from one source, with
architecture-specific updates and manifest-driven website availability. This
plan records implementation and local checks; it does not declare Intel
supported or publish a release.

On 2026-09-03 the user requested complete implementation after 0.1.17 launched.
The branch `codex/macos-intel-foundation` now includes main `9e1c3333` through
local merge `8c8a149f`. Published `v0.1.17` points to
`aa660b24a66196155ba59267ab832cc4ef6e1c7d` and is immutable. GitHub's release API
confirmed its ARM DMG, appcast, manifest, checksums and verification guide.
The working candidate is **0.1.18**. A local annotated dogfood source tag now
identifies its signed tester build; no stable source tag or public release exists.
The [feasibility report](../research/2026-08-31-macos-intel-universal2-feasibility.md)
retains its earlier snapshot and is not current qualification evidence.

Current operational authorities remain the
[macOS release runbook](../runbooks/macos-stable-release-runbook.md) and
[platform support matrix](../reference/platform-support.md).

### 2026-09-05 release-specific qualification decision

The owner separately authorized release under the [0.1.18-only manual
qualification waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md),
because a disposable macOS profile and physical Intel Mac are unavailable.
The clean-profile/manual Login Item matrix and physical Intel qualification
remain unperformed, not passed. Other testers running the app is an owner report,
not independently verified architecture- or artifact-bound evidence. Do not
manufacture a v2 manual receipt or reinterpret Rosetta as physical Intel proof.
Native signatures, final-byte and source binding, data preservation, updater
integrity and unexpected-Keychain-prompt stop conditions remain unchanged.
The earlier implementation checkpoints and signed receipts below retain their
original scope; this exception does not qualify later releases.

## Version and publication boundary

The first request proposed Intel 0.1.17 alongside Apple silicon. That release
is now immutable, so later source changes cannot be represented by its tag or
added as release assets. See [GitHub's immutable-release contract](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Both 0.1.18 installers must identify one common annotated source tag and commit.
Each has independent final bytes, digest, native trust and artifact evidence.

The initial Intel RC1 dogfood allocation was **1025**, followed by signed
combined Astra/Intel RC2 **1025.1**. Corrected RC3 reserves **1025.2** for the
parser-upgrade deadline fix; stable remains **1026**, above 0.1.17 stable
**1024**. Both architectures use the current RC3 allocation. This reserves
ordering in code; it is not proof of signing, installation or release. Signed
RC1/RC2 artifacts and evidence remain immutable, including the build-1025
evidence below; do not reuse either prior build number for corrected source.
Do not reuse the ARM 0.1.17 artifact as Intel recovery/update history.

## Complete implementation acceptance

- [x] Native builder, inspector, DMG packaging and release CLI accept explicit
  `x64`, enforce exact `x86_64` slices for every bundled executable, and retain
  the Node 26.2.0 ARM build-host requirement and verified Intel runtime inputs.
- [x] Stable, dogfood and Preview updater contracts select the matching feed.
  ARM paths stay unchanged. Intel uses `/intel/appcast.xml`,
  `/internal-dogfood/intel/appcast.xml`, and `/preview/intel/appcast.xml`.
  Publication uses separate immutable prefixes and authenticated atomic guard
  targets in the existing channel buckets; no new external resources are created.
- [x] Native runtime and publication reject cross-architecture destinations,
  manifests, prior-release pairs and appcasts; key continuity remains required.
- [x] A single public evidence manifest can contain both independently verified
  DMGs with the same version/tag/commit. Website Intel download, version, minimum
  macOS and checksum appear only for validated Intel evidence. Intel Homebrew
  remains unadvertised until the separate tap supports it.
- [x] Native artifact gates, actual Intel development build/DMG, isolated
  synthetic Rosetta smoke and full Worker checks pass; full-root results and
  the protected R7 regeneration are recorded below.
- [x] Regenerate all ten retained R7 receipts through the owner-authorized
  real-history workflow and verify freshness under both pinned runtimes.
- [x] Browser checks cover available and unavailable Intel states, ARM regression,
  keyboard selection and mobile layout, distinguishing synthetic UI fixtures
  from published evidence.
- [x] Maintained developer, release and support documents match the implementation
  without promoting source compatibility to public platform support.

The implementation and R7 work above did not sign or publish an installer. The
owner subsequently authorized the signed Intel tester candidate recorded below.
System installation, public publication and physical Intel qualification remain
separate steps.

## Earlier foundation checkpoint

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

## Earlier foundation verification on 2026-09-03

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

## Implementation review and qualification limits

An independent read-only code-quality review against merge base `8c8a149f`
found no actionable P1/P2 architecture, release-trust or publication-boundary
regressions. This is source review, not a hardware or signing receipt.

The website passes 490 UI tests and 36 release-site tests, including Worker
release staging contracts. Available Intel UI was inspected with an explicitly
labelled synthetic fixture; public metadata inspected separately still
advertised ARM 0.1.16 and kept Intel unavailable. Desktop, mobile, Spanish,
Chinese, keyboard navigation and checksum copying were checked. Preview
servers were stopped after inspection.

Updater tests cover first Intel bootstrap while an ARM feed already exists,
unchanged ARM bytes, signature/CAS/nonce checks, wrong-architecture history,
wrong namespaces and mismatched signed version/filename. The complete Worker check passed, including 529 runtime tests, type/script
checks, production asset staging and both dry bundles. It used validated,
publicly released ARM 0.1.17 bytes and the real published social image; generated
Intel metadata remains null. Nothing was deployed.

The initial full root run found three stale native test expectations for the
extracted feed policy/new validation fields and a missing tool-inventory caller
entry. Those were corrected without weakening runtime assertions. The
pre-regeneration root run on implementation commit `a53319e5` completed with
**3,736 passed, 2 failed and 17 existing conditional skips** (3,755 total).
Both failures were the R7 freshness/decision checks:
0.1.18 changes six version/compatibility files in the hashed R7 workload closure.
Those stale receipts were not hand-edited, skipped or relabelled. After the
owner explicitly authorized the protected local run, the
[R7 workflow](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
regenerated and validated all ten receipts in 39.3 minutes, with exit code 0.
Both exact runtimes, Node 24.14.0 and 26.2.0, then passed both retained-evidence
tests, including reconstruction of their respective decision receipts.
The final full root rerun then passed **3,738 tests, with zero failures and
17 existing conditional skips** (3,755 total), in 486.6 seconds. The refreshed
receipts are committed locally as `1cbe357e`; no product code or test assertion
changed during regeneration. Documentation governance and preflight also pass.

Receipt review confirmed unchanged runtime identities, privacy/preservation
flags, operation outcomes and comparison states. Each repeated-run projection
pair matches. Aggregate Claude input bytes and encoded artifact bytes changed
from the earlier run; record counts and decoded bytes did not. This is fresh
evidence, not proof of byte-identical historical inputs or improved performance.
Both decisions remain `release_open` with their existing unresolved resource
ceilings. These ARM64 R7 runs do not qualify physical Intel hardware.

## Earlier local Intel artifacts

These are ad-hoc local outputs, not Developer ID/notarized installers. All eight
Preview binaries and all three Development binaries were independently checked
with `lipo` and contain exactly `x86_64`. The final Preview DMG was mounted and
validated without installing it. Its size is **52,054,408 bytes** and SHA-256 is
`9ed1fb80a150137441da87d94c2b54056bae52c63ce2d494d74bc319da59a3ec`.

The final Development build passed normal and JIT-less loopback lifecycle
smokes in fresh synthetic homes. Both profiles passed compiled architecture
routing, updater, fake Login Item and in-memory Keychain broker contracts.
Migration UI smoke passed in Development and was correctly refused in Preview.
An additional 31 credential, accounting and telemetry tests passed using the
pinned Intel Node binary under Rosetta. This does not qualify physical Intel
provider discovery, user state, Keychain prompts or installed update behavior.

Local evidence is retained under `.release-build/intel-complete/`; the final
root log is `.release-build/intel-full-root-after-r7.log`, regeneration progress
is `.release-build/intel-r7-regeneration.log`, and the Worker log is
`.release-build/intel-worker-complete-check.log`. Browser captures are
`.release-build/intel-website-*.png`. These ignored local outputs are not public
release evidence and must not be uploaded as a substitute for qualification.

## Signed Intel tester candidate

The [signed candidate receipt](../receipts/2026-09-03-macos-intel-signed-candidate.md)
records the owner-authorized 0.1.18 / build 1025 Intel dogfood DMG from source
`18c7065b`. Developer ID signing, app and DMG notarization/stapling, Gatekeeper,
isolated clean-profile checks and independent final-artifact inspection passed.
The normal opt-in production upload flow is included; no live account upload
was performed. Tester instructions explain consent and shared stable state.
The candidate is ready for the owner to hand to the physical Intel tester;
no public release, feed or website was published.

## Gates before a public Intel release

The list below states the normal qualification policy. For 0.1.18 only, the
linked 2026-09-05 decision waives unavailable manual/physical Intel execution,
including the physical installed A-to-B rehearsal; signature/version/architecture
refusals, final artifact checks and recovery preservation remain required. A
waived step is not a successful test or a verified tester receipt.

1. Keep the retained R7 receipts fresh against the final integrated workload.
   The owner-authorized branch regeneration passed; any later workload-source
   change requires another complete regeneration before relying on its evidence.
2. Finalize a common clean annotated 0.1.18 source tag only after review. Keep
   dogfood/stable build allocation and source identity identical across the two
   architectures. Do not change the immutable 0.1.17 release or tag.
3. Independently sign, notarize, staple and verify the final ARM and Intel
   artifacts, including all eight nested Intel executable components.
4. Test on physical Intel hardware at macOS 14: offline usage, provider discovery,
   attribution, lifecycle, login items, clean install and prompt-free Keychain
   operation. Rosetta remains supplementary evidence.
5. Prove installed Intel candidate A updates to B; reject invalid signatures,
   versions and cross-architecture delivery. Preserve an Intel-compatible
   recovery artifact and data backup; ARM 0.1.17 is not Intel recovery history.
6. Deploy the reviewed guard, assemble both artifacts plus one canonical evidence
   manifest before immutable GitHub publication, then publish each feed through
   its authenticated architecture target. These are separately authorized writes.
7. Enable the website Intel metadata only from verified published Intel bytes.
   Intel Homebrew requires a separate reviewed tap change and remains absent
   from the Intel card until then. Recheck public bytes and installation after
   publication; local browser checks are not deployment proof.

The implementation remains **in progress toward release qualification**, not a
supported Intel release. A local annotated dogfood source tag and signed,
notarized tester candidate now exist. No system install, public feed update,
website deployment, push or public stable tag occurred in this work.
